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

  // When started by the `gifsonic` launcher, a local helper is available for
  // converting unusual video formats and saving files. The token stops other
  // web pages from talking to it.
  const params = new URLSearchParams(location.search);
  const API_TOKEN = params.get('token');

  const S = {
    loaded: false, fileName: '', dur: 0, vw: 0, vh: 0,
    pos: 0, start: 0, end: 0,
    fps: 15, width: 360, colors: 256, dither: true, loop: 0,
    crop: { x: 0, y: 0, w: 16, h: 9 }, cropMode: false, cropAspect: null,
    layers: [], sel: null, playing: false,
    objUrl: null, job: null, local: false, nextId: 1,
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

  // ------------------------------------------------------------ local helper API
  async function api(path, opts = {}) {
    const headers = Object.assign({ 'X-Gifsonic-Token': API_TOKEN }, opts.headers || {});
    const res = await fetch(path, Object.assign({}, opts, { headers }));
    if (!res.ok) throw new Error((await res.text()) || res.statusText);
    return res;
  }
  async function detectLocal() {
    if (!API_TOKEN) return;
    try {
      await api('/api/ping');
      S.local = true;
    } catch (_) { S.local = false; }
  }

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
      if (S.local) {
        for (const fmt of ['mp4', 'webm']) {
          try {
            status('converting ' + file.name + ' with ffmpeg (' + fmt + ') …', true);
            const res = await api('/api/proxy?fmt=' + fmt, { method: 'POST', body: file, headers: { 'X-Filename': encodeURIComponent(file.name) } });
            url = URL.createObjectURL(await res.blob());
            await openVideoUrl(url);
            break;
          } catch (e2) {
            if (url) URL.revokeObjectURL(url);
            url = null;
          }
        }
      }
      if (!url) {
        status("can't play " + file.name + (S.local ? '' : ' in this browser — try an mp4 or webm, or use the gifsonic app'), true);
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
    };
  }

  function drawLayer(c2d, L, OW, OH) {
    if (L.hidden) return;
    const g = geom(L, OW, OH);
    if (!g) return;
    c2d.save();
    c2d.globalAlpha = L.opacity;
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
    return { id: S.nextId++, type, x: 0.5, y: 0.5, size: 0.35, rot: 0, opacity: 1, hidden: false, crop: { l: 0, t: 0, r: 0, b: 0 } };
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
    S.sel = id;
    refreshAll();
  }
  function deleteLayer(L) {
    if (!L) return;
    S.layers = S.layers.filter((l) => l !== L);
    if (S.sel === L.id) S.sel = null;
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
      if (S.cropMode) { aw = S.vw; ah = S.vh; } else { aw = S.crop.w; ah = S.crop.h; }
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
    if (S.cropMode) return drawCropMode();
    const c = S.crop;
    ctx.drawImage(video, c.x, c.y, c.w, c.h, 0, 0, view.w, view.h);
    for (const L of S.layers) drawLayer(ctx, L, view.w, view.h);
    const L = selLayer();
    if (L && !L.hidden) drawSelection(L);
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
    const g = geom(L, view.w, view.h);
    if (!g || L.hidden) return null;
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
    if (S.cropMode) {
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
    if (S.cropMode) {
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
  function setCropMode(on) {
    if (!S.loaded) return;
    stopPlay();
    S.cropMode = on;
    $('#crop-bar').classList.toggle('hidden', !on);
    if (on) select(null);
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
    const ruler = $('#tl-ruler');
    ruler.innerHTML = '';
    if (!S.loaded) return;
    const width = track.clientWidth || 600;
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];
    const step = steps.find((s) => (s / S.dur) * width >= 70) || 3600;
    for (let t = 0; t <= S.dur + 1e-6; t += step) {
      const span = document.createElement('span');
      span.style.left = timeToPct(t) + '%';
      span.textContent = '│' + fmtTime(t).replace(/\.00$/, '');
      ruler.appendChild(span);
    }
  }

  let tlDrag = null;
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
    if (Math.abs(e.clientX - px(S.start)) <= 8) tlDrag = 'start';
    else if (Math.abs(e.clientX - px(S.end)) <= 8) tlDrag = 'end';
    else tlDrag = 'pos';
    tlMove(e);
  });
  track.addEventListener('pointermove', (e) => {
    if (tlDrag) tlMove(e);
    else if (S.loaded) {
      const r = track.getBoundingClientRect();
      const px = (t) => r.left + (t / S.dur) * r.width;
      const near = Math.abs(e.clientX - px(S.start)) <= 8 || Math.abs(e.clientX - px(S.end)) <= 8;
      track.style.cursor = near ? 'ew-resize' : 'pointer';
    }
  });
  track.addEventListener('pointerup', () => { tlDrag = null; });
  track.addEventListener('pointercancel', () => { tlDrag = null; });
  function tlMove(e) {
    const t = timeAt(e);
    if (tlDrag === 'start') { S.start = clamp(t, 0, S.end - minDur()); seek(S.start); }
    else if (tlDrag === 'end') { S.end = clamp(t, S.start + minDur(), S.dur); seek(S.end); }
    else seek(t);
    refreshAll();
  }

  function setStart(t) { S.start = clamp(t, 0, Math.max(0, S.end - minDur())); if (S.end - S.start < minDur()) S.end = Math.min(S.dur, S.start + minDur()); refreshAll(); }
  function setEnd(t) { S.end = clamp(t, Math.min(S.dur, S.start + minDur()), S.dur); refreshAll(); }

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

  function makeWorker() {
    try {
      const src = '(' + gifsonicEncoderModule.toString() + ')(self);';
      return new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    } catch (_) {
      return null;
    }
  }

  function encode(frames, opts, onProgress, job) {
    const worker = makeWorker();
    const mainThread = async () => {
      const gen = GifSonicEncoder.encodeGif(frames, opts);
      let r;
      while (!(r = gen.next()).done) {
        if (job.cancelled) throw new Error('cancelled');
        onProgress(r.value);
        await new Promise((res) => setTimeout(res, 0));
      }
      return r.value;
    };
    if (!worker) return mainThread();
    return new Promise((resolve, reject) => {
      job.worker = worker;
      worker.onmessage = (ev) => {
        const m = ev.data;
        if (m.type === 'progress') onProgress(m.value);
        else if (m.type === 'done') { worker.terminate(); resolve(m.gif); }
        else { worker.terminate(); reject(new Error(m.message)); }
      };
      worker.onerror = (err) => {
        // e.g. workers blocked: fall back to the main thread (frames not transferred yet)
        err.preventDefault && err.preventDefault();
        worker.terminate();
        job.worker = null;
        mainThread().then(resolve, reject);
      };
      worker.postMessage({ frames, opts });
    });
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
    const job = (S.job = { cancelled: false, worker: null });
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
      const delays = GifSonicEncoder.frameDelays(n, S.fps);
      const frames = [];
      for (let i = 0; i < n; i++) {
        if (job.cancelled) throw new Error('cancelled');
        await seekExact(Math.min(S.start + i / S.fps, S.dur - 0.001));
        octx.clearRect(0, 0, OW, OH);
        drawScaled(octx, video, S.crop.x, S.crop.y, S.crop.w, S.crop.h, OW, OH);
        for (const L of S.layers) drawLayer(octx, L, OW, OH);
        frames.push({ data: octx.getImageData(0, 0, OW, OH).data, delay: delays[i] });
        progress(((i + 1) / n) * 0.5, `grabbing frame ${i + 1} / ${n}`);
      }
      const opts = { width: OW, height: OH, colors: S.colors, dither: S.dither, loop: S.loop, globalPalette: true, optimize: true };
      const gif = await encode(frames, opts, (p) => progress(0.5 + p * 0.5, 'encoding'), job);
      if (job.cancelled) throw new Error('cancelled');
      showResult(gif, OW, OH, n);
    } catch (err) {
      $('#modal-export').classList.add('hidden');
      status(err.message === 'cancelled' ? 'cancelled' : 'export failed: ' + err.message);
      if (err.message !== 'cancelled') console.error(err);
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
    dl.innerHTML = S.local ? '[ &#x23CE; save to Pictures ]' : '[ &#x23CE; download ]';
    $('#exp-title').textContent = 'done';
    $('#exp-progress').classList.add('hidden');
    $('#exp-result').classList.remove('hidden');
  }

  async function saveResult(e) {
    if (!S.local || !resultBlob) return; // browser: normal download link
    e && e.preventDefault();
    try {
      const name = $('#exp-download').dataset.name;
      const res = await api('/api/save?name=' + encodeURIComponent(name), { method: 'POST', body: resultBlob });
      const { path } = await res.json();
      $('#exp-meta').insertAdjacentHTML('beforeend', `<br><span class="ok">saved</span> ${path.replace(/&/g, '&amp;').replace(/</g, '&lt;')} <button class="btn small" data-action="reveal">[ open folder ]</button>`);
      $('#exp-meta').dataset.path = path;
      $('#exp-download').innerHTML = '[ &#x2713; saved ]';
    } catch (err) {
      status('save failed: ' + err.message);
    }
  }

  function closeExport() {
    if (S.job) {
      S.job.cancelled = true;
      if (S.job.worker) S.job.worker.terminate();
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
    setVal('t-start', fmtTime(S.start));
    setVal('t-end', fmtTime(S.end));
    setVal('t-dur', (S.end - S.start).toFixed(2) + 's');
    $('#tl-range').style.left = timeToPct(S.start) + '%';
    $('#tl-range').style.width = timeToPct(S.end - S.start) + '%';
    $('#tl-h-start').style.left = timeToPct(S.start) + '%';
    $('#tl-h-end').style.left = timeToPct(S.end) + '%';
    $('#tl-info').textContent = S.loaded ? `${frameCount()} frames @ ${S.fps} fps` : '';
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
    $('#preview-title').textContent = S.cropMode ? 'crop' : 'preview';
    if (!S.loaded) { $('#preview-info').textContent = ''; return; }
    const { w, h } = outSize();
    $('#preview-info').textContent = S.cropMode
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
  timeInput('t-dur', (v) => setEnd(S.start + v));

  // buttons with data-action
  const ACTIONS = {
    'open-video': () => $('#video-file').click(),
    help: () => $('#modal-help').classList.toggle('hidden'),
    play: togglePlay,
    'frame-back': () => step(-1),
    'frame-fwd': () => step(1),
    'set-start': () => setStart(S.pos),
    'set-end': () => setEnd(S.pos),
    crop: () => setCropMode(!S.cropMode),
    'crop-done': () => setCropMode(false),
    'crop-reset': () => { S.crop = { x: 0, y: 0, w: S.vw, h: S.vh }; S.cropAspect = null; refreshCrop(); draw(); },
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
    reveal: () => { const p = $('#exp-meta').dataset.path; if (p) api('/api/reveal?path=' + encodeURIComponent(p)).catch(() => {}); },
  };
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]');
    if (b && ACTIONS[b.dataset.action]) { ACTIONS[b.dataset.action](); b.blur(); }
  });
  $('#exp-download').addEventListener('click', saveResult);
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
      if (!$('#modal-export').classList.contains('hidden')) return closeExport();
      if (!$('#modal-help').classList.contains('hidden')) return $('#modal-help').classList.add('hidden');
      if (S.cropMode) return setCropMode(false);
      if (S.sel) return select(null);
      return;
    }
    if (typing) return;
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
        case 'c': setCropMode(!S.cropMode); return true;
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
  detectLocal().then(async () => {
    if (!S.local) return;
    // keep the launcher's helper alive while this window is open
    setInterval(() => api('/api/ping').catch(() => {}), 5000);
    // video passed on the command line / "Open with gifsonic"
    try {
      const res = await api('/api/initial');
      if (res.status === 200) {
        const name = decodeURIComponent(res.headers.get('X-Filename') || 'video');
        const blob = await res.blob();
        loadVideo(new File([blob], name, { type: blob.type }));
      }
    } catch (_) { /* no initial file */ }
  });

  // test/automation hook
  window.gifsonic = { S, loadVideo, addImage, addText, exportGif, seek, setStart, setEnd, select, refreshAll, layout, setCropMode };
})();
