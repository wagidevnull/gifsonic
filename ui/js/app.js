/* gifsonic — video to gif, in a TUI-flavoured UI. */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const DEG = Math.PI / 180;

  const video = $('#video');
  const canvas = $('#preview');
  const ctx = canvas.getContext('2d');

  const TEXT_PX = 128;   // text layers are rendered at this font size, then scaled
  const HANDLE = 10;     // handle hit radius (css px)
  const PREFS_KEY = 'gifsonic.prefs.v1';

  // The Rust side of the app (src-tauri/) does the heavy lifting: encoding,
  // ffmpeg conversion and saving.
  const TAURI = window.__TAURI__;
  const invoke = (cmd, args, opts) => TAURI.core.invoke(cmd, args, opts);

  const S = {
    loaded: false, fileName: '', dur: 0, vw: 0, vh: 0,
    pos: 0, start: 0, end: 0,
    fps: 15, width: 360, colors: 256, dither: true, loop: 0,
    crop: { x: 0, y: 0, w: 16, h: 9 }, cropMode: false /* false | 'gif' | 'item' */, cropAspect: null,
    target: 'gif', // what the timeline & crop edit: 'gif' or the selected 'item'
    layers: [], sel: null, playing: false,
    objUrl: null, job: null, ffmpeg: false, nextId: 1,
  };
  const view = { w: 0, h: 0, dpr: 1 };

  // ------------------------------------------------------------ prefs
  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
      for (const k of ['fps', 'width', 'colors', 'dither', 'loop']) if (k in p) S[k] = p[k];
    } catch (_) { /* ignore */ }
  }
  function savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ fps: S.fps, width: S.width, colors: S.colors, dither: S.dither, loop: S.loop }));
    } catch (_) { /* ignore */ }
  }

  // ------------------------------------------------------------ time helpers
  function fmtTime(t) {
    if (!isFinite(t)) t = 0;
    const neg = t < 0; t = Math.abs(t);
    const cs = Math.round(t * 100);
    const m = Math.floor(cs / 6000), s = Math.floor((cs % 6000) / 100), c = cs % 100;
    return (neg ? '-' : '') + m + ':' + String(s).padStart(2, '0') + '.' + String(c).padStart(2, '0');
  }
  function parseTime(str) {
    str = String(str).trim().replace(',', '.').replace(/s$/i, '');
    if (!str) return NaN;
    const parts = str.split(':');
    if (parts.length > 3 || parts.some((p) => p === '' || isNaN(+p))) return NaN;
    return parts.reduce((acc, p) => acc * 60 + parseFloat(p), 0);
  }
  const minDur = () => 1 / S.fps;
  const frameCount = () => Math.max(1, Math.round((S.end - S.start) * S.fps));
  const outSize = () => {
    const w = Math.round(S.width);
    return { w, h: Math.max(1, Math.round((w * S.crop.h) / S.crop.w)) };
  };

  // ------------------------------------------------------------ status
  let statusTimer = 0;
  function status(msg, sticky) {
    const el = $('#status');
    el.textContent = msg || '';
    clearTimeout(statusTimer);
    if (msg && !sticky) statusTimer = setTimeout(() => { el.textContent = ''; }, 4000);
  }

  const errText = (e) => String((e && e.message) || e);

  // ------------------------------------------------------------ video loading
  function openVideoUrl(url) {
    return new Promise((resolve, reject) => {
      const done = (ok) => () => {
        video.removeEventListener('loadeddata', onOk);
        video.removeEventListener('error', onErr);
        if (ok && video.videoWidth > 0) resolve();
        else reject(new Error(ok ? 'no video track' : 'cannot decode'));
      };
      const onOk = done(true), onErr = done(false);
      video.addEventListener('loadeddata', onOk);
      video.addEventListener('error', onErr);
      video.src = url;
      video.load();
    });
  }

  async function fixDuration() {
    // Some webm/mkv files report Infinity until you seek to the end.
    if (isFinite(video.duration) && video.duration > 0) return video.duration;
    await new Promise((res) => {
      const h = () => { if (isFinite(video.duration)) { video.removeEventListener('durationchange', h); res(); } };
      video.addEventListener('durationchange', h);
      video.currentTime = 1e9;
      setTimeout(res, 3000);
    });
    const d = isFinite(video.duration) ? video.duration : video.currentTime;
    video.currentTime = 0;
    return d;
  }

  async function loadVideo(file) {
    stopPlay();
    status('loading ' + file.name + ' …', true);
    let url = URL.createObjectURL(file);
    try {
      await openVideoUrl(url);
    } catch (err) {
      URL.revokeObjectURL(url);
      url = null;
      if (S.ffmpeg) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        for (const fmt of ['mp4', 'webm']) {
          try {
            status('converting ' + file.name + ' with ffmpeg (' + fmt + ') …', true);
            const out = await invoke('convert_video', bytes, { headers: { 'x-fmt': fmt } });
            url = URL.createObjectURL(new Blob([out], { type: 'video/' + fmt }));
            await openVideoUrl(url);
            break;
          } catch (e2) {
            if (url) URL.revokeObjectURL(url);
            url = null;
          }
        }
      }
      if (!url) {
        status("can't open " + file.name + (S.ffmpeg ? '' : ': install ffmpeg to open this kind of video'), true);
        return;
      }
    }
    if (S.objUrl) URL.revokeObjectURL(S.objUrl);
    S.objUrl = url;
    S.fileName = file.name;
    S.vw = video.videoWidth;
    S.vh = video.videoHeight;
    S.dur = await fixDuration();
    S.start = 0;
    S.end = Math.min(S.dur, 3);
    S.pos = 0;
    S.crop = { x: 0, y: 0, w: S.vw, h: S.vh };
    S.cropMode = false;
    S.loaded = true;
    S.saved = false;
    syncDirty();
    $('#empty').classList.add('hidden');
    canvas.classList.remove('hidden');
    $('#file-label').textContent = `${file.name}  ${S.vw}×${S.vh}  ${fmtTime(S.dur)}`;
    $('#file-label').classList.remove('dim');
    status('loaded ' + file.name);
    layout();
    seek(0);
    refreshAll();
  }

  // ------------------------------------------------------------ seeking & playback
  let seekPending = null, seekBusy = false;
  function seek(t) {
    if (!S.loaded) return;
    S.pos = clamp(t, 0, S.dur);
    seekPending = S.pos;
    pumpSeek();
    refreshTime();
  }
  function pumpSeek() {
    if (seekBusy || seekPending == null) return;
    const t = seekPending;
    seekPending = null;
    if (Math.abs(video.currentTime - t) < 1e-4) { draw(); return; }
    seekBusy = true;
    video.currentTime = t;
  }
  video.addEventListener('seeked', () => {
    seekBusy = false;
    if (!S.playing) draw();
    pumpSeek();
  });

  /** Seek precisely and wait until the frame is ready to be drawn. */
  function seekExact(t) {
    return new Promise((resolve) => {
      const go = () => {
        if (Math.abs(video.currentTime - t) < 1e-4 && !video.seeking) return frameReady().then(resolve);
        const timer = setTimeout(finish, 4000);
        function finish() {
          clearTimeout(timer);
          video.removeEventListener('seeked', finish);
          frameReady().then(resolve);
        }
        video.addEventListener('seeked', finish);
        video.currentTime = t;
      };
      if (seekBusy) {
        const h = () => { video.removeEventListener('seeked', h); go(); };
        video.addEventListener('seeked', h);
      } else go();
    });
  }
  function frameReady() {
    if (!('requestVideoFrameCallback' in video)) return Promise.resolve();
    return new Promise((res) => {
      let done = false;
      const fin = () => { if (!done) { done = true; res(); } };
      video.requestVideoFrameCallback(fin);
      setTimeout(fin, 60);
    });
  }

  function play() {
    if (!S.loaded || S.playing) return;
    if (S.pos < S.start || S.pos >= S.end - 0.02) video.currentTime = S.start;
    S.playing = true;
    video.play().catch(() => { S.playing = false; refreshPlay(); });
    refreshPlay();
    requestAnimationFrame(tick);
  }
  function stopPlay() {
    if (!S.playing) return;
    S.playing = false;
    video.pause();
    S.pos = video.currentTime;
    refreshPlay();
    refreshTime();
    draw();
  }
  function togglePlay() { S.playing ? stopPlay() : play(); }
  function tick() {
    if (!S.playing) return;
    if (video.currentTime >= S.end || video.ended) {
      video.currentTime = S.start;
      if (video.paused) video.play().catch(() => {});
    }
    S.pos = video.currentTime;
    draw();
    refreshTime();
    requestAnimationFrame(tick);
  }
  function step(frames) {
    stopPlay();
    seek(S.pos + frames / S.fps);
  }

  // ------------------------------------------------------------ layers
  function fontCss(name) {
    const generic = ['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui'];
    name = (name || 'sans-serif').trim();
    return generic.includes(name) ? name : `"${name.replace(/"/g, '')}", sans-serif`;
  }

  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  function renderText(L) {
    const c = L._canvas || (L._canvas = document.createElement('canvas'));
    const x = c.getContext('2d');
    const font = `${L.italic ? 'italic ' : ''}${L.bold ? 'bold ' : ''}${TEXT_PX}px ${fontCss(L.font)}`;
    const lines = (L.text || ' ').split('\n');
    x.font = font;
    const widths = lines.map((s) => x.measureText(s || ' ').width);
    const lh = TEXT_PX * 1.15;
    const stroke = L.strokeW * TEXT_PX / 64;
    const box = L.bgA > 0;
    const padX = Math.ceil(stroke / 2 + (box ? TEXT_PX * 0.3 : 0) + 2);
    const padY = Math.ceil(stroke / 2 + (box ? TEXT_PX * 0.12 : 0) + 2);
    c.width = Math.max(1, Math.ceil(Math.max(...widths) + padX * 2));
    c.height = Math.max(1, Math.ceil(lines.length * lh + padY * 2));
    x.font = font; // resizing resets the context
    if (box) {
      x.fillStyle = hexA(L.bg, L.bgA);
      const r = TEXT_PX * 0.15;
      if (x.roundRect) { x.beginPath(); x.roundRect(0, 0, c.width, c.height, r); x.fill(); }
      else x.fillRect(0, 0, c.width, c.height);
    }
    x.textBaseline = 'middle';
    x.textAlign = L.align;
    const ax = L.align === 'left' ? padX : L.align === 'right' ? c.width - padX : c.width / 2;
    x.lineJoin = 'round';
    x.miterLimit = 2;
    lines.forEach((s, i) => {
      const y = padY + lh * (i + 0.5);
      if (stroke > 0) { x.strokeStyle = L.stroke; x.lineWidth = stroke; x.strokeText(s, ax, y); }
      x.fillStyle = L.color;
      x.fillText(s, ax, y);
    });
    L._dirty = false;
    return c;
  }

  function layerSource(L) {
    if (L.type === 'image') return L.img;
    return L._dirty || !L._canvas ? renderText(L) : L._canvas;
  }

  /** Geometry of a layer in an output of size OW×OH. */
  function geom(L, OW, OH) {
    const src = layerSource(L);
    if (!src) return null;
    const sw = src.naturalWidth || src.width, sh = src.naturalHeight || src.height;
    if (!sw || !sh) return null;
    const s = L.type === 'text' ? (L.size * OH) / TEXT_PX : (L.size * OW) / sw;
    const c = L.crop;
    const cw = sw * (1 - c.l - c.r), ch = sh * (1 - c.t - c.b);
    if (cw < 1 || ch < 1) return null;
    return {
      src, sx: sw * c.l, sy: sh * c.t, sw: cw, sh: ch, s,
      cx: L.x * OW, cy: L.y * OH,
      // keep the visible part in place when trimming a side
      ox: ((c.l - c.r) * sw * s) / 2, oy: ((c.t - c.b) * sh * s) / 2,
      dw: cw * s, dh: ch * s, rot: L.rot * DEG,
      srcW: sw, srcH: sh, fullW: sw * s, fullH: sh * s,
    };
  }

  /** Opacity of a layer at time t: its own opacity x show-from/to x fades. */
  function layerAlpha(L, t) {
    if (L.hidden) return 0;
    if (L.from != null && t < L.from - 1e-6) return 0;
    if (L.to != null && t >= L.to - 1e-6) return 0;
    const a = L.from != null ? L.from : S.start, b = L.to != null ? L.to : S.end;
    let f = 1;
    if (L.fadeIn > 0) f = Math.min(f, (t - a) / L.fadeIn);
    if (L.fadeOut > 0) f = Math.min(f, (b - t) / L.fadeOut);
    return L.opacity * clamp(f, 0, 1);
  }
  const isTimed = (L) => L.from != null || L.to != null || L.fadeIn > 0 || L.fadeOut > 0;

  function drawLayer(c2d, L, OW, OH, t, minAlpha = 0) {
    if (L.hidden) return;
    const alpha = Math.max(layerAlpha(L, t), minAlpha);
    if (alpha <= 0) return;
    const g = geom(L, OW, OH);
    if (!g) return;
    c2d.save();
    c2d.globalAlpha = alpha;
    c2d.translate(g.cx, g.cy);
    c2d.rotate(g.rot);
    c2d.drawImage(g.src, g.sx, g.sy, g.sw, g.sh, g.ox - g.dw / 2, g.oy - g.dh / 2, g.dw, g.dh);
    c2d.restore();
  }

  // screen <-> layer-local (origin at the visible centre, unrotated)
  function toLocal(g, px, py) {
    const dx = px - g.cx, dy = py - g.cy, co = Math.cos(g.rot), si = Math.sin(g.rot);
    return { x: dx * co + dy * si - g.ox, y: -dx * si + dy * co - g.oy };
  }
  function toScreen(g, lx, ly) {
    const x = lx + g.ox, y = ly + g.oy, co = Math.cos(g.rot), si = Math.sin(g.rot);
    return { x: g.cx + x * co - y * si, y: g.cy + x * si + y * co };
  }
  const rotHandleY = (g) => -g.dh / 2 - 24;

  function newLayerBase(type) {
    return {
      id: S.nextId++, type, x: 0.5, y: 0.5, size: 0.35, rot: 0, opacity: 1, hidden: false,
      crop: { l: 0, t: 0, r: 0, b: 0 },
      from: null, to: null, fadeIn: 0, fadeOut: 0, // null = clip start / end
    };
  }
  function addText() {
    const L = Object.assign(newLayerBase('text'), {
      text: 'your text', font: 'Impact', bold: true, italic: false, align: 'center',
      color: '#ffffff', stroke: '#000000', strokeW: 6, bg: '#000000', bgA: 0,
      y: 0.82, size: 0.14, _dirty: true,
    });
    S.layers.push(L);
    select(L.id);
    setTimeout(() => { const t = $('#lp-text-value'); t.focus(); t.select(); }, 0);
  }
  function loadImage(file) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('cannot read image'));
      img.src = URL.createObjectURL(file);
    });
  }
  async function addImage(file, replaceLayer) {
    try {
      const img = await loadImage(file);
      if (replaceLayer) {
        replaceLayer.img = img;
        replaceLayer.name = file.name;
        refreshAll();
        return;
      }
      const L = Object.assign(newLayerBase('image'), { img, name: file.name });
      S.layers.push(L);
      select(L.id);
      status('added image ' + file.name);
    } catch (e) {
      status("can't read " + file.name);
    }
  }
  const selLayer = () => S.layers.find((l) => l.id === S.sel) || null;
  function select(id) {
    if (S.cropMode === 'item' && id !== S.sel) { S.cropMode = false; $('#crop-bar').classList.add('hidden'); }
    S.sel = id;
    S.target = id ? 'item' : 'gif'; // picking an item edits the item; clicking empty space edits the gif
    refreshAll();
  }
  const itemTarget = () => (S.target === 'item' ? selLayer() : null);
  function setTarget(t) {
    if (t === 'item' && !selLayer()) { status('select a text or image in the preview first'); return; }
    if (S.cropMode === 'item' && t === 'gif') setCropMode(false);
    S.target = t;
    status(t === 'item' ? 'timeline & crop now edit the selected item' : 'timeline & crop now edit the gif');
    refreshAll();
  }
  function deleteLayer(L) {
    if (!L) return;
    S.layers = S.layers.filter((l) => l !== L);
    if (S.sel === L.id) { S.sel = null; S.target = 'gif'; if (S.cropMode === 'item') setCropMode(false); }
    refreshAll();
  }
  function duplicateLayer(L) {
    if (!L) return;
    const copy = Object.assign({}, L, { id: S.nextId++, crop: Object.assign({}, L.crop), x: L.x + 0.03, y: L.y + 0.03, _canvas: null, _dirty: true });
    S.layers.push(copy);
    select(copy.id);
  }
  function moveLayerZ(L, dir) {
    const i = S.layers.indexOf(L), j = i + dir;
    if (i < 0 || j < 0 || j >= S.layers.length) return;
    S.layers.splice(i, 1);
    S.layers.splice(j, 0, L);
    refreshAll();
  }
  function cycleLayer(dir) {
    if (!S.layers.length) return;
    const i = S.layers.findIndex((l) => l.id === S.sel);
    const j = i < 0 ? (dir > 0 ? 0 : S.layers.length - 1) : (i + dir + S.layers.length) % S.layers.length;
    select(S.layers[j].id);
  }

  // ------------------------------------------------------------ drawing
  function layout() {
    const stage = $('#stage');
    const sw = Math.max(50, stage.clientWidth - 24), sh = Math.max(50, stage.clientHeight - 24);
    let aw = 16, ah = 9;
    if (S.loaded) {
      if (S.cropMode === 'gif') { aw = S.vw; ah = S.vh; } else { aw = S.crop.w; ah = S.crop.h; }
    }
    const k = Math.min(sw / aw, sh / ah);
    view.w = Math.max(1, Math.floor(aw * k));
    view.h = Math.max(1, Math.floor(ah * k));
    view.dpr = window.devicePixelRatio || 1;
    canvas.style.width = view.w + 'px';
    canvas.style.height = view.h + 'px';
    canvas.width = Math.round(view.w * view.dpr);
    canvas.height = Math.round(view.h * view.dpr);
    buildRuler();
    draw();
  }

  function draw() {
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.clearRect(0, 0, view.w, view.h);
    if (!S.loaded) return;
    ctx.imageSmoothingQuality = 'high';
    if (S.cropMode === 'gif') return drawCropMode();
    const c = S.crop;
    ctx.drawImage(video, c.x, c.y, c.w, c.h, 0, 0, view.w, view.h);
    for (const L of S.layers) drawLayer(ctx, L, view.w, view.h, S.pos, L.id === S.sel ? 0.25 : 0);
    const L = selLayer();
    if (L && S.cropMode === 'item') drawItemCrop(L);
    else if (L && !L.hidden) drawSelection(L);
  }

  // ---- visual crop of the selected item
  function itemCropFrame(L) {
    const g = geom(L, view.w, view.h);
    if (!g) return null;
    const W = g.fullW, H = g.fullH, c = L.crop;
    return { g, W, H, x0: -W / 2 + c.l * W, x1: W / 2 - c.r * W, y0: -H / 2 + c.t * H, y1: H / 2 - c.b * H };
  }
  // screen -> unrotated coords around the item's pivot (its uncropped centre)
  function toPivot(g, px, py) {
    const dx = px - g.cx, dy = py - g.cy, co = Math.cos(g.rot), si = Math.sin(g.rot);
    return { x: dx * co + dy * si, y: -dx * si + dy * co };
  }
  function drawItemCrop(L) {
    const f = itemCropFrame(L);
    if (!f) return;
    const { g, W, H, x0, x1, y0, y1 } = f;
    ctx.save();
    ctx.translate(g.cx, g.cy);
    ctx.rotate(g.rot);
    // the trimmed-away parts, ghosted
    ctx.save();
    ctx.beginPath();
    ctx.rect(-W / 2, -H / 2, W, H);
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.clip('evenodd');
    ctx.globalAlpha = 0.3;
    ctx.drawImage(g.src, 0, 0, g.srcW, g.srcH, -W / 2, -H / 2, W, H);
    ctx.restore();
    ctx.strokeStyle = 'rgba(205,214,244,0.45)';
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(-W / 2, -H / 2, W, H);
    ctx.setLineDash([]);
    ctx.strokeStyle = '#89b4fa';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    ctx.fillStyle = '#89b4fa';
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    for (const [hx, hy] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1], [mx, y0], [mx, y1], [x0, my], [x1, my]]) ctx.fillRect(hx - 4, hy - 4, 8, 8);
    ctx.restore();
  }
  function itemCropHit(L, p) {
    const f = itemCropFrame(L);
    if (!f) return null;
    const q = toPivot(f.g, p.x, p.y);
    const near = (a, b) => Math.abs(a - b) <= HANDLE;
    const inX = q.x >= f.x0 - HANDLE && q.x <= f.x1 + HANDLE, inY = q.y >= f.y0 - HANDLE && q.y <= f.y1 + HANDLE;
    let part = '';
    if (inX && near(q.y, f.y0)) part += 'n'; else if (inX && near(q.y, f.y1)) part += 's';
    if (inY && near(q.x, f.x0)) part += 'w'; else if (inY && near(q.x, f.x1)) part += 'e';
    if (!part && q.x > f.x0 && q.x < f.x1 && q.y > f.y0 && q.y < f.y1) part = 'move';
    return part ? { f, part, q } : null;
  }

  function drawSelection(L) {
    const g = geom(L, view.w, view.h);
    if (!g) return;
    ctx.save();
    ctx.translate(g.cx, g.cy);
    ctx.rotate(g.rot);
    ctx.translate(g.ox, g.oy);
    ctx.strokeStyle = '#f5c2e7';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(-g.dw / 2, -g.dh / 2, g.dw, g.dh);
    ctx.setLineDash([]);
    // rotate handle
    ctx.beginPath();
    ctx.moveTo(0, -g.dh / 2);
    ctx.lineTo(0, rotHandleY(g));
    ctx.stroke();
    ctx.fillStyle = '#11111b';
    ctx.beginPath();
    ctx.arc(0, rotHandleY(g), 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // resize handle
    ctx.fillStyle = '#f5c2e7';
    ctx.fillRect(g.dw / 2 - 5, g.dh / 2 - 5, 10, 10);
    ctx.restore();
  }

  function drawCropMode() {
    const k = view.w / S.vw, c = S.crop;
    ctx.drawImage(video, 0, 0, view.w, view.h);
    const x = c.x * k, y = c.y * k, w = c.w * k, h = c.h * k;
    ctx.fillStyle = 'rgba(17,17,27,0.65)';
    ctx.fillRect(0, 0, view.w, y);
    ctx.fillRect(0, y + h, view.w, view.h - y - h);
    ctx.fillRect(0, y, x, h);
    ctx.fillRect(x + w, y, view.w - x - w, h);
    ctx.strokeStyle = '#f5c2e7';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.strokeStyle = 'rgba(245,194,231,0.35)';
    ctx.beginPath();
    for (let i = 1; i < 3; i++) {
      ctx.moveTo(x + (w * i) / 3, y); ctx.lineTo(x + (w * i) / 3, y + h);
      ctx.moveTo(x, y + (h * i) / 3); ctx.lineTo(x + w, y + (h * i) / 3);
    }
    ctx.stroke();
    ctx.fillStyle = '#f5c2e7';
    for (const [hx, hy] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) ctx.fillRect(hx - 5, hy - 5, 10, 10);
  }

  // ------------------------------------------------------------ preview mouse
  let drag = null;

  function canvasPoint(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function hitLayer(L, p) {
    if (L.hidden || (S.sel !== L.id && layerAlpha(L, S.pos) <= 0)) return null;
    const g = geom(L, view.w, view.h);
    if (!g) return null;
    const l = toLocal(g, p.x, p.y);
    if (S.sel === L.id) {
      if (Math.hypot(l.x, l.y - rotHandleY(g)) <= HANDLE) return { g, part: 'rotate' };
      if (Math.hypot(l.x - g.dw / 2, l.y - g.dh / 2) <= HANDLE) return { g, part: 'resize' };
    }
    if (Math.abs(l.x) <= g.dw / 2 && Math.abs(l.y) <= g.dh / 2) return { g, part: 'move' };
    return null;
  }

  function cropHit(p) {
    const k = view.w / S.vw, c = S.crop;
    const corners = { nw: [c.x, c.y], ne: [c.x + c.w, c.y], sw: [c.x, c.y + c.h], se: [c.x + c.w, c.y + c.h] };
    for (const [name, [cx, cy]] of Object.entries(corners)) {
      if (Math.hypot(cx * k - p.x, cy * k - p.y) <= HANDLE) return name;
    }
    const sx = p.x / k, sy = p.y / k;
    if (sx >= c.x && sx <= c.x + c.w && sy >= c.y && sy <= c.y + c.h) return 'move';
    return 'new';
  }

  function cropFromAnchor(ax, ay, px, py) {
    const a = S.cropAspect;
    let w = Math.abs(px - ax), h = Math.abs(py - ay);
    if (a) { if (w / Math.max(h, 1e-6) > a) w = h * a; else h = w / a; }
    const sx = px < ax ? -1 : 1, sy = py < ay ? -1 : 1;
    const maxW = sx > 0 ? S.vw - ax : ax, maxH = sy > 0 ? S.vh - ay : ay;
    if (w > maxW) { w = maxW; if (a) h = w / a; }
    if (h > maxH) { h = maxH; if (a) w = h * a; }
    w = Math.max(16, Math.round(w));
    h = Math.max(16, Math.round(h));
    return clampCrop({ x: sx > 0 ? ax : ax - w, y: sy > 0 ? ay : ay - h, w, h });
  }
  function clampCrop(c) {
    const w = clamp(Math.round(c.w), 16, S.vw), h = clamp(Math.round(c.h), 16, S.vh);
    return { x: clamp(Math.round(c.x), 0, S.vw - w), y: clamp(Math.round(c.y), 0, S.vh - h), w, h };
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!S.loaded || e.button !== 0) return;
    const p = canvasPoint(e);
    canvas.setPointerCapture(e.pointerId);
    if (S.cropMode === 'item') {
      const L = selLayer(), hit = L && itemCropHit(L, p);
      if (hit) drag = { kind: 'icrop', L, part: hit.part, q0: hit.q, g0: hit.f.g, W: hit.f.W, H: hit.f.H, c0: Object.assign({}, L.crop) };
      return;
    }
    if (S.cropMode === 'gif') {
      const k = view.w / S.vw, part = cropHit(p), c = S.crop;
      const anchors = { nw: [c.x + c.w, c.y + c.h], ne: [c.x, c.y + c.h], sw: [c.x + c.w, c.y], se: [c.x, c.y] };
      if (part === 'move') drag = { kind: 'crop-move', p0: p, c0: Object.assign({}, c) };
      else if (part === 'new') drag = { kind: 'crop-new', anchor: [p.x / k, p.y / k] };
      else drag = { kind: 'crop-resize', anchor: anchors[part] };
      return;
    }
    // selected layer handles first, then topmost layer under the pointer
    const sel = selLayer();
    let hit = sel && hitLayer(sel, p), L = sel;
    if (!hit) {
      L = null;
      for (let i = S.layers.length - 1; i >= 0; i--) {
        const h = hitLayer(S.layers[i], p);
        if (h) { L = S.layers[i]; hit = h; break; }
      }
    }
    if (!hit) { select(null); return; }
    if (S.sel !== L.id) select(L.id);
    const vc = toScreen(hit.g, 0, 0);
    drag = { kind: hit.part, L, p0: p, x0: L.x, y0: L.y, size0: L.size, vc, d0: Math.hypot(p.x - vc.x, p.y - vc.y) };
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!S.loaded) return;
    const p = canvasPoint(e);
    if (!drag) { hoverCursor(p); return; }
    if (drag.kind === 'icrop') {
      const { L, part, c0, W, H } = drag, MIN = 0.05;
      const q = toPivot(drag.g0, p.x, p.y);
      const fx = (q.x + W / 2) / W, fy = (q.y + H / 2) / H;
      const c = Object.assign({}, c0);
      if (part === 'move') {
        const dx = (q.x - drag.q0.x) / W, dy = (q.y - drag.q0.y) / H;
        c.l = clamp(c0.l + dx, 0, c0.l + c0.r); c.r = c0.r - (c.l - c0.l);
        c.t = clamp(c0.t + dy, 0, c0.t + c0.b); c.b = c0.b - (c.t - c0.t);
      } else {
        if (part.includes('w')) c.l = clamp(fx, 0, 1 - c.r - MIN);
        if (part.includes('e')) c.r = clamp(1 - fx, 0, 1 - c.l - MIN);
        if (part.includes('n')) c.t = clamp(fy, 0, 1 - c.b - MIN);
        if (part.includes('s')) c.b = clamp(1 - fy, 0, 1 - c.t - MIN);
      }
      L.crop = c;
      refreshProps();
      draw();
      return;
    }
    if (drag.kind.startsWith('crop')) {
      const k = view.w / S.vw;
      if (drag.kind === 'crop-move') {
        const c0 = drag.c0;
        S.crop = clampCrop({ x: c0.x + (p.x - drag.p0.x) / k, y: c0.y + (p.y - drag.p0.y) / k, w: c0.w, h: c0.h });
      } else {
        S.crop = cropFromAnchor(drag.anchor[0], drag.anchor[1], clamp(p.x / k, 0, S.vw), clamp(p.y / k, 0, S.vh));
      }
      refreshCrop();
      draw();
      return;
    }
    const L = drag.L;
    if (drag.kind === 'move') {
      L.x = drag.x0 + (p.x - drag.p0.x) / view.w;
      L.y = drag.y0 + (p.y - drag.p0.y) / view.h;
    } else if (drag.kind === 'resize') {
      const d = Math.hypot(p.x - drag.vc.x, p.y - drag.vc.y);
      L.size = clamp(drag.size0 * (d / Math.max(drag.d0, 1)), 0.01, 4);
    } else if (drag.kind === 'rotate') {
      const g = geom(L, view.w, view.h), vc = toScreen(g, 0, 0);
      let a = Math.atan2(p.y - vc.y, p.x - vc.x) / DEG + 90;
      if (e.shiftKey) a = Math.round(a / 15) * 15;
      L.rot = ((Math.round(a) + 540) % 360) - 180;
    }
    refreshProps();
    draw();
  });

  const endDrag = () => { drag = null; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  function hoverCursor(p) {
    let cur = 'default';
    if (S.cropMode === 'item') {
      const L = selLayer(), h = L && itemCropHit(L, p);
      const cursors = { n: 'ns-resize', s: 'ns-resize', w: 'ew-resize', e: 'ew-resize', nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', move: 'move' };
      cur = h ? cursors[h.part] : 'default';
    } else if (S.cropMode === 'gif') {
      const h = cropHit(p);
      cur = h === 'move' ? 'move' : h === 'new' ? 'crosshair' : (h === 'nw' || h === 'se') ? 'nwse-resize' : 'nesw-resize';
    } else {
      const sel = selLayer();
      let hit = sel && hitLayer(sel, p);
      if (!hit) for (let i = S.layers.length - 1; i >= 0 && !hit; i--) hit = hitLayer(S.layers[i], p);
      if (hit) cur = hit.part === 'move' ? 'move' : hit.part === 'resize' ? 'nwse-resize' : 'grab';
    }
    canvas.style.cursor = cur;
  }

  // ------------------------------------------------------------ crop mode
  /** mode: false | 'gif' (crop the video) | 'item' (trim the selected text/image) */
  function setCropMode(mode) {
    if (!S.loaded) return;
    if (mode === true) mode = itemTarget() ? 'item' : 'gif';
    if (mode === 'item' && !selLayer()) mode = 'gif';
    stopPlay();
    if (mode === 'gif') { S.sel = null; S.target = 'gif'; }
    if (mode === 'item') S.target = 'item';
    S.cropMode = mode;
    $('#crop-bar').classList.toggle('hidden', !mode);
    $('#crop-gif-controls').classList.toggle('hidden', mode !== 'gif');
    $('#crop-bar-title').textContent = mode === 'item' ? 'CROP ITEM' : 'CROP GIF';
    $('#crop-bar-hint').textContent = mode === 'item' ? 'drag the blue edges or corners · drag inside to slide' : 'drag on the video · aspect';
    layout();
    refreshAll();
  }
  function setCropAspect(a) {
    S.cropAspect = a;
    if (a) {
      const c = S.crop, cx = c.x + c.w / 2, cy = c.y + c.h / 2;
      let w = c.w, h = c.w / a;
      if (h > c.h) { h = c.h; w = h * a; }
      S.crop = clampCrop({ x: cx - w / 2, y: cy - h / 2, w, h });
    }
    refreshCrop();
    draw();
  }

  // ------------------------------------------------------------ timeline
  const track = $('.tl-track');
  const timeToPct = (t) => (S.dur ? (t / S.dur) * 100 : 0);

  function buildRuler() {
    const ruler = $('#tl-ruler'), ticks = $('#tl-ticks');
    ruler.innerHTML = '';
    ticks.innerHTML = '';
    const width = track.clientWidth || 600;
    const tick = (x, major) => {
      const i = document.createElement('i');
      i.style.left = Math.round(x) + 'px';
      if (major) i.className = 'major';
      ticks.appendChild(i);
    };
    if (!S.loaded) {
      for (let x = 8; x < width; x += 10) tick(x, false);
      return;
    }
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];
    const step = steps.find((s) => (s / S.dur) * width >= 70) || 3600;
    // minor ticks: the finest of 1/5, 1/4, 1/2 of a label step that stays >= 6px apart
    const minor = [step / 5, step / 4, step / 2, step].find((m) => (m / S.dur) * width >= 6);
    const n = Math.round(S.dur / minor);
    for (let k = 0; k <= n; k++) {
      const t = k * minor;
      const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      tick((t / S.dur) * (width - 1), major);
    }
    for (let t = 0; t <= S.dur + 1e-6; t += step) {
      const span = document.createElement('span');
      span.style.left = timeToPct(t) + '%';
      span.textContent = '│' + fmtTime(t).replace(/\.00$/, '');
      ruler.appendChild(span);
    }
  }

  /** The time span the timeline is editing: the gif clip, or the selected item's show-from/to. */
  function span() {
    const L = itemTarget();
    if (L) return [L.from != null ? L.from : S.start, L.to != null ? L.to : S.end];
    return [S.start, S.end];
  }
  function setSpan(a, b) {
    const L = itemTarget();
    if (L) { L.from = a; L.to = b; } else { S.start = a; S.end = b; }
  }
  function nudgeSpan(frames) {
    const [a, b] = span(), len = b - a;
    const na = clamp(a + frames / S.fps, 0, S.dur - len);
    setSpan(na, na + len);
    refreshAll();
  }

  let tlDrag = null;
  const GRIP = 9; // px: top band of the highlighted span that moves it
  function timeAt(e) {
    const r = track.getBoundingClientRect();
    return clamp(((e.clientX - r.left) / r.width) * S.dur, 0, S.dur);
  }
  track.addEventListener('pointerdown', (e) => {
    if (!S.loaded) return;
    stopPlay();
    track.setPointerCapture(e.pointerId);
    const r = track.getBoundingClientRect();
    const px = (t) => r.left + (t / S.dur) * r.width;
    const [a, b] = span();
    if (Math.abs(e.clientX - px(a)) <= 8) tlDrag = 'start';
    else if (Math.abs(e.clientX - px(b)) <= 8) tlDrag = 'end';
    else if (e.clientY - r.top <= GRIP && e.clientX > px(a) && e.clientX < px(b)) {
      tlDrag = { kind: 'move', t0: timeAt(e), a0: a, b0: b };
      track.style.cursor = 'grabbing';
      return;
    } else tlDrag = 'pos';
    tlMove(e);
  });
  track.addEventListener('pointermove', (e) => {
    if (tlDrag) tlMove(e);
    else if (S.loaded) {
      const r = track.getBoundingClientRect();
      const px = (t) => r.left + (t / S.dur) * r.width;
      const [a, b] = span();
      const near = Math.abs(e.clientX - px(a)) <= 8 || Math.abs(e.clientX - px(b)) <= 8;
      const grip = e.clientY - r.top <= GRIP && e.clientX > px(a) && e.clientX < px(b);
      track.style.cursor = near ? 'ew-resize' : grip ? 'grab' : 'pointer';
    }
  });
  track.addEventListener('pointerup', () => { tlDrag = null; });
  track.addEventListener('pointercancel', () => { tlDrag = null; });
  function tlMove(e) {
    const t = timeAt(e);
    const [a, b] = span();
    if (tlDrag && tlDrag.kind === 'move') {
      const len = tlDrag.b0 - tlDrag.a0;
      const na = clamp(tlDrag.a0 + (t - tlDrag.t0), 0, S.dur - len);
      setSpan(na, na + len);
    } else if (tlDrag === 'start') { setSpan(clamp(t, 0, b - minDur()), b); seek(span()[0]); }
    else if (tlDrag === 'end') { setSpan(a, clamp(t, a + minDur(), S.dur)); seek(span()[1]); }
    else seek(t);
    refreshAll();
  }
  track.addEventListener('pointerup', () => { if (tlDrag && tlDrag.kind === 'move') track.style.cursor = 'grab'; });

  // start/end setters follow the edit target (gif clip or selected item)
  function setStart(t) {
    const [a, b] = span(), len = b - a;
    t = clamp(t, 0, S.dur);
    if (b - t < minDur()) setSpan(t, Math.min(S.dur, t + Math.max(len, minDur())));
    else setSpan(t, b);
    refreshAll();
  }
  function setEnd(t) {
    const [a, b] = span(), len = b - a;
    t = clamp(t, 0, S.dur);
    if (t - a < minDur()) setSpan(Math.max(0, t - Math.max(len, minDur())), t);
    else setSpan(a, t);
    refreshAll();
  }

  // ------------------------------------------------------------ export
  function drawScaled(c2d, src, sx, sy, sw, sh, dw, dh) {
    // Halve repeatedly for big downscales: much better quality than one jump.
    let cur = src, cx = sx, cy = sy, cw = sw, ch = sh;
    const tmp = [];
    while (cw / dw > 2 && ch / dh > 2) {
      const nw = Math.max(dw, Math.round(cw / 2)), nh = Math.max(dh, Math.round(ch / 2));
      const t = document.createElement('canvas');
      t.width = nw; t.height = nh;
      const tc = t.getContext('2d');
      tc.imageSmoothingQuality = 'high';
      tc.drawImage(cur, cx, cy, cw, ch, 0, 0, nw, nh);
      tmp.push(t);
      cur = t; cx = 0; cy = 0; cw = nw; ch = nh;
    }
    c2d.imageSmoothingQuality = 'high';
    c2d.drawImage(cur, cx, cy, cw, ch, 0, 0, dw, dh);
  }

  function progress(frac, label) {
    const width = 40, n = Math.round(frac * width);
    $('#exp-bar').textContent = '[' + '█'.repeat(n) + '░'.repeat(width - n) + '] ' + String(Math.round(frac * 100)).padStart(3) + '%';
    $('#exp-stage').textContent = label || '';
  }

  async function exportGif() {
    if (!S.loaded || S.job) return;
    stopPlay();
    if (S.cropMode) setCropMode(false);
    const { w: OW, h: OH } = outSize();
    const n = frameCount();
    const job = (S.job = { cancelled: false });
    const posBefore = S.pos;
    $('#modal-export').classList.remove('hidden');
    $('#exp-progress').classList.remove('hidden');
    $('#exp-result').classList.add('hidden');
    $('#exp-title').textContent = 'making gif';
    progress(0, 'grabbing frames');

    try {
      const off = document.createElement('canvas');
      off.width = OW; off.height = OH;
      const octx = off.getContext('2d', { willReadFrequently: true });
      await invoke('encoder_start', { opts: { width: OW, height: OH, colors: S.colors, dither: S.dither, loop: S.loop, fps: S.fps, count: n } });
      for (let i = 0; i < n; i++) {
        if (job.cancelled) throw new Error('cancelled');
        await seekExact(Math.min(S.start + i / S.fps, S.dur - 0.001));
        octx.clearRect(0, 0, OW, OH);
        drawScaled(octx, video, S.crop.x, S.crop.y, S.crop.w, S.crop.h, OW, OH);
        const t = S.start + i / S.fps;
        for (const L of S.layers) drawLayer(octx, L, OW, OH, t);
        const px = octx.getImageData(0, 0, OW, OH).data;
        await invoke('encoder_frame', new Uint8Array(px.buffer, px.byteOffset, px.byteLength));
        progress(((i + 1) / n) * 0.5, `grabbing frame ${i + 1} / ${n}`);
      }
      if (job.cancelled) throw new Error('cancelled');
      const onProgress = new TAURI.core.Channel();
      onProgress.onmessage = (p) => { if (!job.cancelled) progress(0.5 + p * 0.5, 'encoding'); };
      const gif = new Uint8Array(await invoke('encoder_finish', { onProgress }));
      if (job.cancelled) throw new Error('cancelled');
      showResult(gif, OW, OH, n);
    } catch (err) {
      // after a cancel, frames still in flight fail too: that's still just a cancel
      const cancelled = job.cancelled || errText(err) === 'cancelled';
      invoke('encoder_cancel').catch(() => {});
      $('#modal-export').classList.add('hidden');
      status(cancelled ? 'cancelled' : 'export failed: ' + errText(err));
      if (!cancelled) console.error(err);
    } finally {
      S.job = null;
      seek(posBefore);
    }
  }

  let resultUrl = null, resultBlob = null;
  function showResult(gif, OW, OH, n) {
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultBlob = new Blob([gif], { type: 'image/gif' });
    resultUrl = URL.createObjectURL(resultBlob);
    const base = (S.fileName.replace(/\.[^.]+$/, '') || 'gifsonic').replace(/[^\w.-]+/g, '_');
    const name = `${base}-${OW}w-${S.fps}fps.gif`;
    $('#exp-img').src = resultUrl;
    const kb = resultBlob.size / 1024;
    const size = kb > 1024 ? (kb / 1024).toFixed(2) + ' MB' : Math.round(kb) + ' KB';
    $('#exp-meta').innerHTML = `<span class="accent">${size}</span> &middot; ${OW}&times;${OH} &middot; ${n} frames &middot; ${S.fps} fps &middot; ${(S.end - S.start).toFixed(2)} s`;
    const dl = $('#exp-download');
    dl.href = resultUrl;
    dl.download = name;
    dl.dataset.name = name;
    dl.innerHTML = '[ &#x23CE; save to Pictures ]';
    $('#exp-title').textContent = 'done';
    $('#exp-progress').classList.add('hidden');
    $('#exp-result').classList.remove('hidden');
  }

  async function saveResult(e) {
    e && e.preventDefault();
    if (!resultBlob) return;
    try {
      const name = $('#exp-download').dataset.name;
      const bytes = new Uint8Array(await resultBlob.arrayBuffer());
      const path = await invoke('save_gif', bytes, { headers: { 'x-name': encodeURIComponent(name) } });
      $('#exp-meta').insertAdjacentHTML('beforeend', `<br><span class="ok">saved</span> ${path.replace(/&/g, '&amp;').replace(/</g, '&lt;')} <button class="btn small" data-action="reveal">[ open folder ]</button>`);
      $('#exp-meta').dataset.path = path;
      $('#exp-download').innerHTML = '[ &#x2713; saved ]';
      markSaved();
    } catch (err) {
      status('save failed: ' + errText(err));
    }
  }

  function closeExport() {
    if (S.job) {
      S.job.cancelled = true;
      invoke('encoder_cancel').catch(() => {});
    }
    $('#modal-export').classList.add('hidden');
  }

  // ------------------------------------------------------------ UI refresh
  function setSeg(sel, attr, value) {
    $$(sel + ' button').forEach((b) => b.classList.toggle('on', String(b.dataset[attr]) === String(value)));
  }
  function setVal(id, v) {
    const el = document.getElementById(id);
    if (el && document.activeElement !== el) el.value = v;
  }

  function refreshTime() {
    setVal('t-pos', fmtTime(S.pos));
    $('#tl-playhead').style.left = timeToPct(S.pos) + '%';
  }
  function refreshPlay() {
    $('#play-btn').innerHTML = S.playing ? '[ &#x275A;&#x275A; pause ]' : '[ &#x25B6; play ]';
  }
  function refreshTimeline() {
    const [a, b] = span(), item = !!itemTarget();
    setVal('t-start', fmtTime(a));
    setVal('t-end', fmtTime(b));
    setVal('t-dur', (b - a).toFixed(2) + 's');
    $('#lbl-start').textContent = item ? 'from' : 'start';
    $('#lbl-end').textContent = item ? 'to' : 'end';
    track.classList.toggle('item-mode', item);
    setSeg('#target-seg', 'target', item ? 'item' : 'gif');
    $('#target-seg [data-target=item]').disabled = !selLayer();
    $('#tl-range').style.left = timeToPct(S.start) + '%';
    $('#tl-range').style.width = timeToPct(S.end - S.start) + '%';
    $('#tl-h-start').style.left = timeToPct(a) + '%';
    $('#tl-h-end').style.left = timeToPct(b) + '%';
    $('#tl-info').textContent = S.loaded
      ? (item ? 'editing: item \u00b7 ' : 'editing: gif \u00b7 ') + `${frameCount()} frames @ ${S.fps} fps` : '';
    const L = selLayer(), bar = $('#tl-layer');
    bar.classList.toggle('hidden', !L || !S.loaded);
    if (L && S.loaded) {
      const a = L.from != null ? L.from : S.start, b = L.to != null ? L.to : S.end;
      bar.style.left = timeToPct(a) + '%';
      bar.style.width = timeToPct(Math.max(0, b - a)) + '%';
    }
    refreshTime();
  }
  function refreshOutput() {
    setSeg('#size-seg', 'size', S.width);
    setSeg('#fps-seg', 'fps', S.fps);
    setVal('size-custom', S.width);
    $('#colors').value = String(S.colors);
    $('#dither').checked = S.dither;
    $('#loop').value = String(S.loop);
    if (S.loaded) {
      const { w, h } = outSize();
      $('#out-info').textContent = `${w}×${h}`;
    }
  }
  function refreshCrop() {
    const c = S.crop;
    setVal('crop-x', c.x); setVal('crop-y', c.y); setVal('crop-w', c.w); setVal('crop-h', c.h);
    setSeg('#crop-aspect', 'aspect', S.cropAspect || 'free');
    refreshOutput();
  }
  function refreshPreviewTitle() {
    $('#preview-title').textContent = S.cropMode === 'item' ? 'crop item' : S.cropMode ? 'crop gif' : 'preview';
    if (!S.loaded) { $('#preview-info').textContent = ''; return; }
    const { w, h } = outSize();
    $('#preview-info').textContent = S.cropMode === 'gif'
      ? `${S.crop.w}×${S.crop.h} of ${S.vw}×${S.vh}`
      : `gif will be ${w}×${h}`;
  }

  function refreshLayers() {
    const ul = $('#layer-list');
    ul.innerHTML = '';
    if (!S.layers.length) {
      ul.innerHTML = '<li class="dim empty-layers">no layers yet</li>';
    }
    // top of the list = top of the stack
    [...S.layers].reverse().forEach((L) => {
      const li = document.createElement('li');
      li.className = (L.id === S.sel ? 'sel ' : '') + (L.hidden ? 'hidden-layer' : '');
      li.dataset.id = L.id;
      const label = L.type === 'text' ? (L.text || '').split('\n')[0].slice(0, 24) || '(empty)' : L.name;
      li.innerHTML =
        `<span class="ltype">${L.type === 'text' ? 'T' : '▣'}</span>` +
        `<span class="lname"></span>` +
        (isTimed(L) ? `<span class="dim" title="only shows for part of the gif">\u25F7</span>` : '') +
        `<button data-lact="vis" title="show/hide">${L.hidden ? '○' : '●'}</button>` +
        `<button data-lact="up" title="bring forward">▲</button>` +
        `<button data-lact="down" title="send backward">▼</button>` +
        `<button data-lact="del" title="delete">✕</button>`;
      li.querySelector('.lname').textContent = label;
      ul.appendChild(li);
    });
  }

  function refreshProps() {
    const L = selLayer();
    $('#lp-body').classList.toggle('hidden', !L);
    $('#lp-hint').textContent = L ? (L.type === 'text' ? 'text layer' : 'image layer') : 'select a layer';
    if (!L) return;
    $('#lp-text').classList.toggle('hidden', L.type !== 'text');
    $('#lp-image').classList.toggle('hidden', L.type !== 'image');
    if (L.type === 'text') {
      setVal('lp-text-value', L.text);
      setVal('lp-font', L.font);
      $('#lp-bold').checked = L.bold;
      $('#lp-italic').checked = L.italic;
      setSeg('#lp-align', 'align', L.align);
      setVal('lp-color', L.color);
      setVal('lp-stroke', L.stroke);
      setVal('lp-stroke-w', L.strokeW);
      setVal('lp-bg', L.bg);
      setVal('lp-bg-a', L.bgA);
    } else {
      $('#lp-image-name').textContent = L.name;
    }
    for (const p of PAIRS) {
      setVal(p.range, p.get(L));
      setVal(p.num, Math.round(p.get(L) * p.mult));
    }
    for (const [id, side] of [['lp-cl', 'l'], ['lp-cr', 'r'], ['lp-ct', 't'], ['lp-cb', 'b']]) setVal(id, L.crop[side]);
    setVal('lp-from', L.from != null ? fmtTime(L.from) : '');
    setVal('lp-to', L.to != null ? fmtTime(L.to) : '');
    setVal('lp-fadein', L.fadeIn || 0);
    setVal('lp-fadeout', L.fadeOut || 0);
  }

  function refreshAll() {
    refreshTimeline();
    refreshOutput();
    refreshCrop();
    refreshPreviewTitle();
    refreshLayers();
    refreshProps();
    refreshPlay();
    draw();
  }

  // ------------------------------------------------------------ controls wiring
  const PAIRS = [
    { range: 'lp-x', num: 'lp-x-n', mult: 100, get: (L) => L.x, set: (L, v) => { L.x = v; } },
    { range: 'lp-y', num: 'lp-y-n', mult: 100, get: (L) => L.y, set: (L, v) => { L.y = v; } },
    { range: 'lp-size', num: 'lp-size-n', mult: 100, get: (L) => L.size, set: (L, v) => { L.size = clamp(v, 0.01, 4); } },
    { range: 'lp-rot', num: 'lp-rot-n', mult: 1, get: (L) => L.rot, set: (L, v) => { L.rot = clamp(v, -180, 180); } },
    { range: 'lp-op', num: 'lp-op-n', mult: 100, get: (L) => L.opacity, set: (L, v) => { L.opacity = clamp(v, 0, 1); } },
  ];
  for (const p of PAIRS) {
    document.getElementById(p.range).addEventListener('input', (e) => {
      const L = selLayer(); if (!L) return;
      p.set(L, parseFloat(e.target.value));
      setVal(p.num, Math.round(p.get(L) * p.mult));
      draw();
    });
    document.getElementById(p.num).addEventListener('change', (e) => {
      const L = selLayer(); if (!L) return;
      const v = parseFloat(e.target.value);
      if (!isNaN(v)) p.set(L, v / p.mult);
      refreshProps(); draw();
    });
  }
  for (const [id, side, other] of [['lp-cl', 'l', 'r'], ['lp-cr', 'r', 'l'], ['lp-ct', 't', 'b'], ['lp-cb', 'b', 't']]) {
    document.getElementById(id).addEventListener('input', (e) => {
      const L = selLayer(); if (!L) return;
      L.crop[side] = clamp(parseFloat(e.target.value), 0, 0.95 - L.crop[other]);
      e.target.value = L.crop[side];
      draw();
    });
  }

  const textProp = (id, key, evt = 'input', conv = (v) => v) => {
    document.getElementById(id).addEventListener(evt, (e) => {
      const L = selLayer(); if (!L || L.type !== 'text') return;
      L[key] = conv(e.target.type === 'checkbox' ? e.target.checked : e.target.value);
      L._dirty = true;
      if (key === 'text') refreshLayers();
      draw();
    });
  };
  textProp('lp-text-value', 'text');
  textProp('lp-font', 'font');
  textProp('lp-bold', 'bold', 'change');
  textProp('lp-italic', 'italic', 'change');
  textProp('lp-color', 'color');
  textProp('lp-stroke', 'stroke');
  textProp('lp-stroke-w', 'strokeW', 'input', parseFloat);
  textProp('lp-bg', 'bg');
  textProp('lp-bg-a', 'bgA', 'input', parseFloat);
  $('#lp-align').addEventListener('click', (e) => {
    const b = e.target.closest('button'); const L = selLayer();
    if (!b || !L) return;
    L.align = b.dataset.align; L._dirty = true;
    refreshProps(); draw();
  });

  $('#layer-list').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    const L = S.layers.find((l) => l.id === +li.dataset.id);
    const act = e.target.dataset.lact;
    if (act === 'vis') { L.hidden = !L.hidden; refreshAll(); }
    else if (act === 'up') moveLayerZ(L, 1);
    else if (act === 'down') moveLayerZ(L, -1);
    else if (act === 'del') deleteLayer(L);
    else select(L.id);
  });

  $('#size-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    S.width = +b.dataset.size; savePrefs(); refreshAll();
  });
  $('#size-custom').addEventListener('change', (e) => {
    const v = parseInt(e.target.value, 10);
    if (v >= 16 && v <= 1920) { S.width = v; savePrefs(); }
    refreshAll();
  });
  $('#fps-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    S.fps = +b.dataset.fps; savePrefs(); refreshAll();
  });
  $('#colors').addEventListener('change', (e) => { S.colors = +e.target.value; savePrefs(); });
  $('#dither').addEventListener('change', (e) => { S.dither = e.target.checked; savePrefs(); });
  $('#loop').addEventListener('change', (e) => { S.loop = +e.target.value; savePrefs(); });

  $('#target-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    setTarget(b.dataset.target);
  });
  $('#crop-aspect').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    setCropAspect(b.dataset.aspect === 'free' ? null : parseFloat(b.dataset.aspect));
  });
  for (const k of ['x', 'y', 'w', 'h']) {
    document.getElementById('crop-' + k).addEventListener('change', (e) => {
      const v = parseInt(e.target.value, 10);
      if (!isNaN(v)) {
        const c = Object.assign({}, S.crop, { [k]: v });
        if (S.cropAspect && (k === 'w' || k === 'h')) {
          if (k === 'w') c.h = c.w / S.cropAspect; else c.w = c.h * S.cropAspect;
        }
        S.crop = clampCrop(c);
      }
      refreshCrop(); draw();
    });
  }

  // time inputs
  const timeInput = (id, apply) => {
    const el = document.getElementById(id);
    el.addEventListener('change', () => {
      const v = parseTime(el.value);
      if (!isNaN(v) && S.loaded) apply(v);
      el.blur();
      refreshAll();
    });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.blur(); });
    el.addEventListener('blur', () => setTimeout(refreshAll, 0));
  };
  timeInput('t-pos', (v) => { stopPlay(); seek(v); });
  timeInput('t-start', (v) => { setStart(v); seek(S.start); });
  timeInput('t-end', (v) => { setEnd(v); seek(S.end); });
  timeInput('t-dur', (v) => setEnd(span()[0] + v));

  // layer show-from / show-to / fades
  for (const [id, key] of [['lp-from', 'from'], ['lp-to', 'to']]) {
    const el = document.getElementById(id);
    el.addEventListener('change', () => {
      const L = selLayer(); if (!L) return;
      const v = el.value.trim() === '' ? null : parseTime(el.value);
      if (v === null || !isNaN(v)) L[key] = v === null ? null : clamp(v, 0, S.dur);
      el.blur();
      refreshAll();
    });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.blur(); });
  }
  for (const [id, key] of [['lp-fadein', 'fadeIn'], ['lp-fadeout', 'fadeOut']]) {
    document.getElementById(id).addEventListener('change', (e) => {
      const L = selLayer(); if (!L) return;
      const v = parseFloat(e.target.value);
      L[key] = isNaN(v) ? 0 : clamp(v, 0, 60);
      refreshAll();
    });
  }

  // ------------------------------------------------------------ quit protection
  // "Unsaved" = a video is loaded but no gif has been saved/downloaded since.
  const isDirty = () => S.loaded && !S.saved;
  function syncDirty() {
    invoke('set_dirty', { dirty: isDirty() }).catch(() => {});
  }
  function markSaved() { S.saved = true; syncDirty(); }
  function askQuit() {
    // called when the window's close button is pressed with unsaved work
    closeExport();
    $('#modal-help').classList.add('hidden');
    $('#modal-quit').classList.remove('hidden');
  }
  TAURI.event.listen('ask-quit', () => askQuit());

  // buttons with data-action
  const ACTIONS = {
    'open-video': () => $('#video-file').click(),
    help: () => $('#modal-help').classList.toggle('hidden'),
    play: togglePlay,
    'frame-back': () => step(-1),
    'frame-fwd': () => step(1),
    'set-start': () => setStart(S.pos),
    'set-end': () => setEnd(S.pos),
    crop: () => setCropMode(S.cropMode === 'gif' ? false : 'gif'),
    'layer-crop': () => setCropMode(S.cropMode === 'item' ? false : 'item'),
    'crop-done': () => setCropMode(false),
    'crop-reset': () => {
      if (S.cropMode === 'item') { const L = selLayer(); if (L) L.crop = { l: 0, t: 0, r: 0, b: 0 }; refreshProps(); draw(); return; }
      S.crop = { x: 0, y: 0, w: S.vw, h: S.vh }; S.cropAspect = null; refreshCrop(); draw();
    },
    export: exportGif,
    'export-cancel': closeExport,
    'export-close': closeExport,
    'add-text': () => { if (S.cropMode) setCropMode(false); addText(); },
    'add-image': () => { imagePickMode = null; $('#image-file').click(); },
    'replace-image': () => { imagePickMode = selLayer(); $('#image-file').click(); },
    'layer-center': () => { const L = selLayer(); if (L) { L.x = 0.5; L.y = 0.5; refreshAll(); } },
    'layer-reset': () => { const L = selLayer(); if (L) { L.rot = 0; L.opacity = 1; L.crop = { l: 0, t: 0, r: 0, b: 0 }; L.size = L.type === 'text' ? 0.14 : 0.35; refreshAll(); } },
    'layer-dup': () => duplicateLayer(selLayer()),
    'layer-del': () => deleteLayer(selLayer()),
    'layer-from': () => { const L = selLayer(); if (L) { L.from = S.pos; if (L.to != null && L.to <= L.from) L.to = null; refreshAll(); } },
    'layer-to': () => { const L = selLayer(); if (L) { L.to = S.pos; if (L.from != null && L.from >= L.to) L.from = null; refreshAll(); } },
    'layer-whole': () => { const L = selLayer(); if (L) { L.from = null; L.to = null; L.fadeIn = 0; L.fadeOut = 0; refreshAll(); } },
    'quit-yes': () => { $('#modal-quit').classList.add('hidden'); invoke('quit').catch(() => {}); },
    'quit-no': () => $('#modal-quit').classList.add('hidden'),
    reveal: () => { const p = $('#exp-meta').dataset.path; if (p) invoke('reveal', { path: p }).catch(() => {}); },
  };
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]');
    if (b && ACTIONS[b.dataset.action]) { ACTIONS[b.dataset.action](); b.blur(); }
  });
  $('#exp-download').addEventListener('click', (e) => saveResult(e));
  $('#empty').addEventListener('click', () => $('#video-file').click());

  let imagePickMode = null;
  $('#video-file').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) loadVideo(f); e.target.value = ''; });
  $('#image-file').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) addImage(f, imagePickMode); e.target.value = ''; imagePickMode = null; });

  // drag & drop / paste
  window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dropping'); });
  window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    document.body.classList.remove('dropping');
    for (const f of e.dataTransfer.files) {
      if (f.type.startsWith('image/') && f.type !== 'image/gif') addImage(f);
      else if (f.type.startsWith('image/gif') && S.loaded) addImage(f);
      else loadVideo(f);
    }
  });
  window.addEventListener('paste', (e) => {
    if (e.target.matches('input, textarea')) return;
    for (const item of e.clipboardData.items) {
      if (item.type.startsWith('image/')) { addImage(new File([item.getAsFile()], 'pasted image.png', { type: item.type })); break; }
    }
  });

  // ------------------------------------------------------------ keyboard
  document.addEventListener('keydown', (e) => {
    const typing = e.target.matches('input:not([type=checkbox]):not([type=range]):not([type=color]), textarea, select');
    if (e.key === 'Escape') {
      if (typing) { e.target.blur(); return; }
      if (!$('#modal-quit').classList.contains('hidden')) return $('#modal-quit').classList.add('hidden');
      if (!$('#modal-export').classList.contains('hidden')) return closeExport();
      if (!$('#modal-help').classList.contains('hidden')) return $('#modal-help').classList.add('hidden');
      if (S.cropMode) return setCropMode(false);
      if (S.sel) return select(null);
      return;
    }
    if (typing) return;
    if (!$('#modal-quit').classList.contains('hidden')) {
      if (e.key === 'q' || e.key === 'y' || e.key === 'Enter') ACTIONS['quit-yes']();
      else if (e.key === 'n') ACTIONS['quit-no']();
      e.preventDefault();
      return;
    }
    if (!$('#modal-export').classList.contains('hidden')) {
      if (e.key === 'Enter' && !$('#exp-result').classList.contains('hidden')) $('#exp-download').click();
      return;
    }
    const L = selLayer();
    const k = e.key;
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'd') { e.preventDefault(); duplicateLayer(L); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const handled = (() => {
      switch (k) {
        case ' ': togglePlay(); return true;
        case '<': case ',': step(-1); return true;
        case '>': case '.': step(1); return true;
        case 'j': stopPlay(); seek(S.pos - 1); return true;
        case 'l': stopPlay(); seek(S.pos + 1); return true;
        case 'i': case '[': setStart(S.pos); return true;
        case 'o': case ']': setEnd(S.pos); return true;
        case 'Home': stopPlay(); seek(S.start); return true;
        case 'End': stopPlay(); seek(S.end); return true;
        case 'c': setCropMode(S.cropMode ? false : true); return true;
        case 'g': setTarget(itemTarget() ? 'gif' : 'item'); return true;
        case '{': nudgeSpan(-1); return true;
        case '}': nudgeSpan(1); return true;
        case 'Enter': if (S.cropMode) { setCropMode(false); return true; } return false;
        case 't': ACTIONS['add-text'](); return true;
        case 'p': ACTIONS['add-image'](); return true;
        case 'v': ACTIONS['open-video'](); return true;
        case 'e': exportGif(); return true;
        case '?': ACTIONS.help(); return true;
        case 'Tab': cycleLayer(e.shiftKey ? -1 : 1); return true;
        case 'Delete': case 'Backspace': if (L) { deleteLayer(L); return true; } return false;
        case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': {
          const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[k];
          if (L) {
            const { w, h } = outSize(), m = e.shiftKey ? 10 : 1;
            L.x += (dir[0] * m) / w;
            L.y += (dir[1] * m) / h;
            refreshProps(); draw();
          } else if (dir[0]) {
            if (e.shiftKey) { stopPlay(); seek(S.pos + dir[0]); } else step(dir[0]);
          } else return false;
          return true;
        }
        case '+': case '=': if (L) { L.size = clamp(L.size * 1.05, 0.01, 4); refreshProps(); draw(); return true; } return false;
        case '-': case '_': if (L) { L.size = clamp(L.size / 1.05, 0.01, 4); refreshProps(); draw(); return true; } return false;
        case 'r': if (L) { L.rot = ((L.rot + 15 + 540) % 360) - 180; refreshProps(); draw(); return true; } return false;
        case 'R': if (L) { L.rot = ((L.rot - 15 + 540) % 360) - 180; refreshProps(); draw(); return true; } return false;
        default: return false;
      }
    })();
    if (handled) e.preventDefault();
  });

  // ------------------------------------------------------------ boot
  window.addEventListener('resize', () => { layout(); refreshAll(); });
  video.addEventListener('ended', () => { if (S.playing) { video.currentTime = S.start; video.play().catch(() => {}); } });

  loadPrefs();
  canvas.classList.add('hidden');
  layout();
  refreshAll();
  (async () => {
    S.ffmpeg = (await invoke('app_info')).ffmpeg;
    // video passed on the command line / "Open with gifsonic"
    const initial = await invoke('initial_video');
    if (initial) {
      status('loading ' + initial.name + ' …', true);
      const bytes = await invoke('initial_video_bytes');
      loadVideo(new File([bytes], initial.name));
    }
  })().catch((e) => status('startup failed: ' + errText(e)));

  // test/automation hook
  window.gifsonic = { S, askQuit, loadVideo, addImage, addText, exportGif, seek, setStart, setEnd, select, refreshAll, layout, setCropMode };
})();
