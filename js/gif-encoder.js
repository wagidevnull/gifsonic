/*
 * gifsonic GIF encoder — dependency-free GIF89a writer.
 *
 * - median-cut palette (global across all frames, or per frame)
 * - optional Floyd–Steinberg dithering
 * - inter-frame optimisation: unchanged pixels become transparent and each
 *   frame is cropped to the region that changed (much smaller files)
 * - LZW compression
 *
 * encodeGif() is a generator that yields progress (0..1) and returns the
 * finished GIF as a Uint8Array, so it can run in a Web Worker or be driven
 * in small steps on the main thread.
 *
 * gifsonicEncoderModule's source is also injected into a Blob worker by the app
 * (works even when index.html is opened straight from disk), so it must not
 * depend on anything outside itself.
 */
function gifsonicEncoderModule(root) {
  'use strict';

  // ------------------------------------------------------------ byte writer
  function ByteWriter(size) {
    this.buf = new Uint8Array(size || 1 << 20);
    this.len = 0;
  }
  ByteWriter.prototype.ensure = function (n) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
  };
  ByteWriter.prototype.byte = function (b) {
    this.ensure(1);
    this.buf[this.len++] = b;
  };
  ByteWriter.prototype.u16 = function (v) {
    this.ensure(2);
    this.buf[this.len++] = v & 255;
    this.buf[this.len++] = (v >> 8) & 255;
  };
  ByteWriter.prototype.bytes = function (arr) {
    this.ensure(arr.length);
    this.buf.set(arr, this.len);
    this.len += arr.length;
  };
  ByteWriter.prototype.str = function (s) {
    for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i));
  };
  ByteWriter.prototype.result = function () {
    return this.buf.slice(0, this.len);
  };

  // ------------------------------------------------------------ palette
  const key15 = (r, g, b) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

  /**
   * Median-cut over a 15-bit colour histogram. `sums` holds the exact RGB
   * totals per bin, so solid colours get an exact palette entry (no dither
   * speckles on flat areas). Returns Uint8Array [r,g,b,...].
   */
  function buildPalette(hist, sums, maxColors) {
    const bins = [];
    for (let k = 0; k < 32768; k++) if (hist[k]) bins.push(k);
    const R = (k) => (k >> 10) & 31, G = (k) => (k >> 5) & 31, B = (k) => k & 31;

    if (bins.length === 0) return new Uint8Array([0, 0, 0]);

    const arr = Uint32Array.from(bins);
    const boxes = [];
    const makeBox = (start, end) => {
      let rmin = 31, rmax = 0, gmin = 31, gmax = 0, bmin = 31, bmax = 0, count = 0;
      for (let i = start; i < end; i++) {
        const k = arr[i], r = R(k), g = G(k), b = B(k);
        if (r < rmin) rmin = r; if (r > rmax) rmax = r;
        if (g < gmin) gmin = g; if (g > gmax) gmax = g;
        if (b < bmin) bmin = b; if (b > bmax) bmax = b;
        count += hist[k];
      }
      const rr = rmax - rmin, gr = gmax - gmin, br = bmax - bmin;
      // Perceptual-ish weighting: the eye is most sensitive to green.
      const wr = rr * 1.0, wg = gr * 1.2, wb = br * 0.8;
      const axis = wg >= wr && wg >= wb ? 1 : wr >= wb ? 0 : 2;
      const range = Math.max(wr, wg, wb);
      return { start, end, count, axis, score: end - start > 1 ? range * Math.sqrt(count) : -1 };
    };
    boxes.push(makeBox(0, arr.length));

    while (boxes.length < maxColors) {
      let bi = -1, best = 0;
      for (let i = 0; i < boxes.length; i++) {
        if (boxes[i].score > best) { best = boxes[i].score; bi = i; }
      }
      if (bi < 0) break;
      const box = boxes[bi];
      const ch = box.axis === 0 ? R : box.axis === 1 ? G : B;
      const sub = arr.subarray(box.start, box.end);
      sub.sort((a, b) => ch(a) - ch(b));
      // split at the weighted median
      const half = box.count / 2;
      let acc = 0, split = box.start + 1;
      for (let i = box.start; i < box.end - 1; i++) {
        acc += hist[arr[i]];
        if (acc >= half) { split = i + 1; break; }
      }
      boxes.splice(bi, 1, makeBox(box.start, split), makeBox(split, box.end));
    }

    const pal = new Uint8Array(boxes.length * 3);
    boxes.forEach((box, i) => {
      let r = 0, g = 0, b = 0, n = 0;
      for (let j = box.start; j < box.end; j++) {
        const k = arr[j];
        r += sums[k * 3];
        g += sums[k * 3 + 1];
        b += sums[k * 3 + 2];
        n += hist[k];
      }
      pal[i * 3] = Math.round(r / n);
      pal[i * 3 + 1] = Math.round(g / n);
      pal[i * 3 + 2] = Math.round(b / n);
    });
    return pal;
  }

  function newHistogram() {
    return { hist: new Uint32Array(32768), sums: new Float64Array(32768 * 3) };
  }
  function addToHistogram(h, rgba, step) {
    const { hist, sums } = h;
    for (let i = 0; i < rgba.length; i += 4 * step) {
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2], k = key15(r, g, b);
      hist[k]++;
      sums[k * 3] += r;
      sums[k * 3 + 1] += g;
      sums[k * 3 + 2] += b;
    }
  }

  /** Nearest-colour lookup with a 15-bit cache. */
  function makeMatcher(pal) {
    const n = pal.length / 3;
    const cache = new Int16Array(32768).fill(-1);
    return function (r, g, b) {
      const k = key15(r, g, b);
      let idx = cache[k];
      if (idx >= 0) return idx;
      let best = Infinity;
      for (let i = 0; i < n; i++) {
        const dr = pal[i * 3] - r, dg = pal[i * 3 + 1] - g, db = pal[i * 3 + 2] - b;
        const d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
        if (d < best) { best = d; idx = i; }
      }
      cache[k] = idx;
      return idx;
    };
  }

  /** Map an RGBA frame to palette indices (optionally dithered). */
  function mapFrame(rgba, w, h, pal, match, dither, out) {
    if (!dither) {
      for (let p = 0, i = 0; p < w * h; p++, i += 4) out[p] = match(rgba[i], rgba[i + 1], rgba[i + 2]);
      return;
    }
    // Floyd–Steinberg with two rolling error rows
    let cur = new Float32Array((w + 2) * 3), nxt = new Float32Array((w + 2) * 3);
    for (let y = 0; y < h; y++) {
      nxt.fill(0);
      for (let x = 0; x < w; x++) {
        const p = y * w + x, i = p * 4, e = (x + 1) * 3;
        const r = clamp(rgba[i] + cur[e]), g = clamp(rgba[i + 1] + cur[e + 1]), b = clamp(rgba[i + 2] + cur[e + 2]);
        const idx = match(r, g, b);
        out[p] = idx;
        const er = r - pal[idx * 3], eg = g - pal[idx * 3 + 1], eb = b - pal[idx * 3 + 2];
        cur[e + 3] += er * 7 / 16; cur[e + 4] += eg * 7 / 16; cur[e + 5] += eb * 7 / 16;
        nxt[e - 3] += er * 3 / 16; nxt[e - 2] += eg * 3 / 16; nxt[e - 1] += eb * 3 / 16;
        nxt[e] += er * 5 / 16; nxt[e + 1] += eg * 5 / 16; nxt[e + 2] += eb * 5 / 16;
        nxt[e + 3] += er / 16; nxt[e + 4] += eg / 16; nxt[e + 5] += eb / 16;
      }
      const t = cur; cur = nxt; nxt = t;
    }
  }
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

  // ------------------------------------------------------------ LZW
  const lzwTable = new Int16Array(4096 * 256);

  function lzwEncode(indices, minCodeSize, out) {
    out.byte(minCodeSize);
    const clearCode = 1 << minCodeSize, eoiCode = clearCode + 1;
    let codeSize = minCodeSize + 1, nextCode = eoiCode + 1;
    let cur = 0, shift = 0;
    const block = new Uint8Array(255);
    let blen = 0;
    const flushByte = (b) => {
      block[blen++] = b;
      if (blen === 255) { out.byte(255); out.bytes(block); blen = 0; }
    };
    const emit = (code) => {
      cur |= code << shift;
      shift += codeSize;
      while (shift >= 8) { flushByte(cur & 255); cur >>>= 8; shift -= 8; }
    };

    lzwTable.fill(0);
    emit(clearCode);
    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i];
      const key = (prefix << 8) | k;
      const c = lzwTable[key];
      if (c) { prefix = c - 1; continue; }
      emit(prefix);
      if (nextCode === 4096) {
        emit(clearCode);
        lzwTable.fill(0);
        nextCode = eoiCode + 1;
        codeSize = minCodeSize + 1;
      } else {
        if (nextCode >= (1 << codeSize)) codeSize++;
        lzwTable[key] = nextCode + 1;
        nextCode++;
      }
      prefix = k;
    }
    emit(prefix);
    emit(eoiCode);
    if (shift > 0) flushByte(cur & 255);
    if (blen) { out.byte(blen); out.bytes(block.subarray(0, blen)); }
    out.byte(0); // block terminator
  }

  // ------------------------------------------------------------ GIF writer
  function tableBits(nColors) {
    let bits = 1;
    while ((1 << bits) < nColors) bits++;
    return bits;
  }

  function writePalette(out, pal, bits) {
    const size = 1 << bits;
    for (let i = 0; i < size; i++) {
      if (i * 3 < pal.length) {
        out.byte(pal[i * 3]); out.byte(pal[i * 3 + 1]); out.byte(pal[i * 3 + 2]);
      } else {
        out.byte(0); out.byte(0); out.byte(0);
      }
    }
  }

  /**
   * frames: [{ data: Uint8ClampedArray|Uint8Array (RGBA), delay: centiseconds }]
   * opts: { width, height, colors=256, dither=true, globalPalette=true,
   *         optimize=true, loop=0 (0 = forever, -1 = play once, n = repeat n times) }
   */
  function* encodeGif(frames, opts) {
    const w = opts.width, h = opts.height, npx = w * h;
    const maxColors = Math.max(2, Math.min(256, opts.colors || 256));
    const dither = opts.dither !== false;
    const optimize = opts.optimize !== false;
    const useGlobal = opts.globalPalette !== false;
    const palColors = optimize ? maxColors - 1 : maxColors; // reserve one slot for transparency

    const out = new ByteWriter(Math.max(1 << 16, npx * frames.length / 4));
    out.str('GIF89a');

    let globalPal = null, globalBits = 0;
    if (useGlobal) {
      const h = newHistogram();
      const target = 600000; // total pixels to sample
      const step = Math.max(1, Math.floor((npx * frames.length) / target));
      for (const f of frames) addToHistogram(h, f.data, step);
      globalPal = buildPalette(h.hist, h.sums, palColors);
      globalBits = tableBits(globalPal.length / 3 + (optimize ? 1 : 0));
    }

    // Logical screen descriptor
    out.u16(w); out.u16(h);
    out.byte(useGlobal ? 0x80 | (7 << 4) | (globalBits - 1) : 0x70);
    out.byte(0); // background colour index
    out.byte(0); // pixel aspect ratio
    if (useGlobal) writePalette(out, globalPal, globalBits);

    // Looping (NETSCAPE2.0). Omitted entirely = play once.
    const loop = opts.loop == null ? 0 : opts.loop;
    if (loop >= 0) {
      out.byte(0x21); out.byte(0xff); out.byte(11); out.str('NETSCAPE2.0');
      out.byte(3); out.byte(1); out.u16(loop); out.byte(0);
    }

    const indices = new Uint8Array(npx);
    const shown = new Int32Array(npx).fill(-1); // RGB currently displayed per pixel
    const globalMatch = useGlobal ? makeMatcher(globalPal) : null;

    for (let f = 0; f < frames.length; f++) {
      const rgba = frames[f].data;
      let pal, match, bits;
      if (useGlobal) {
        pal = globalPal; match = globalMatch; bits = globalBits;
      } else {
        const h = newHistogram();
        addToHistogram(h, rgba, Math.max(1, Math.floor(npx / 150000)));
        pal = buildPalette(h.hist, h.sums, palColors);
        match = makeMatcher(pal);
        bits = tableBits(pal.length / 3 + (optimize ? 1 : 0));
      }
      const transIndex = optimize ? pal.length / 3 : -1;

      mapFrame(rgba, w, h, pal, match, dither, indices);

      // Inter-frame optimisation
      let x0 = 0, y0 = 0, x1 = w - 1, y1 = h - 1;
      let useTrans = false;
      if (optimize && f > 0) {
        x0 = w; y0 = h; x1 = -1; y1 = -1;
        for (let y = 0, p = 0; y < h; y++) {
          for (let x = 0; x < w; x++, p++) {
            const ci = indices[p] * 3;
            const rgb = (pal[ci] << 16) | (pal[ci + 1] << 8) | pal[ci + 2];
            if (rgb === shown[p]) {
              indices[p] = transIndex;
            } else {
              shown[p] = rgb;
              if (x < x0) x0 = x; if (x > x1) x1 = x;
              if (y < y0) y0 = y; if (y > y1) y1 = y;
            }
          }
        }
        useTrans = true;
        if (x1 < 0) { x0 = 0; y0 = 0; x1 = 0; y1 = 0; } // nothing changed: 1x1 transparent pixel
      } else if (optimize) {
        for (let p = 0; p < npx; p++) {
          const ci = indices[p] * 3;
          shown[p] = (pal[ci] << 16) | (pal[ci + 1] << 8) | pal[ci + 2];
        }
      }

      const fw = x1 - x0 + 1, fh = y1 - y0 + 1;
      let sub = indices;
      if (fw !== w || fh !== h) {
        sub = new Uint8Array(fw * fh);
        for (let y = 0; y < fh; y++) sub.set(indices.subarray((y0 + y) * w + x0, (y0 + y) * w + x0 + fw), y * fw);
      }

      // Graphic control extension
      out.byte(0x21); out.byte(0xf9); out.byte(4);
      out.byte((1 << 2) | (useTrans ? 1 : 0)); // disposal 1 = leave in place
      out.u16(frames[f].delay);
      out.byte(useTrans ? transIndex : 0);
      out.byte(0);

      // Image descriptor
      out.byte(0x2c);
      out.u16(x0); out.u16(y0); out.u16(fw); out.u16(fh);
      if (useGlobal) {
        out.byte(0);
      } else {
        out.byte(0x80 | (bits - 1));
        writePalette(out, pal, bits);
      }
      lzwEncode(sub, Math.max(2, bits), out);

      yield (f + 1) / frames.length;
    }

    out.byte(0x3b);
    return out.result();
  }

  /** Per-frame delays (centiseconds) whose running total tracks real time. */
  function frameDelays(count, fps) {
    const d = [];
    for (let i = 0; i < count; i++) d.push(Math.round(((i + 1) * 100) / fps) - Math.round((i * 100) / fps));
    return d;
  }

  const api = { encodeGif, frameDelays, buildPalette };

  // Running inside the worker: wire up messages.
  if (typeof WorkerGlobalScope !== 'undefined' && root instanceof WorkerGlobalScope) {
    root.onmessage = (ev) => {
      const { frames, opts } = ev.data;
      try {
        const gen = encodeGif(frames, opts);
        let r;
        while (!(r = gen.next()).done) root.postMessage({ type: 'progress', value: r.value });
        root.postMessage({ type: 'done', gif: r.value }, [r.value.buffer]);
      } catch (err) {
        root.postMessage({ type: 'error', message: String(err && err.stack || err) });
      }
    };
  }
  root.GifSonicEncoder = api;
}
gifsonicEncoderModule(typeof self !== 'undefined' ? self : this);
