//! gifsonic's GIF89a encoder.
//!
//! - one median-cut palette shared by all frames, built from a 15-bit colour
//!   histogram that keeps exact RGB sums per bin (flat colours get an exact
//!   palette entry, so no dither speckles on solid areas)
//! - optional Floyd–Steinberg dithering
//! - inter-frame optimisation: pixels that don't change become transparent and
//!   each frame is cropped to the area that changed
//! - LZW compression
//!
//! Frames are added one at a time while the app captures them (the histogram
//! is built as they arrive), then [`Encoder::finish`] maps and compresses them
//! on all CPU cores.

use rayon::prelude::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

#[derive(Debug, Clone, Copy)]
pub struct Options {
    pub width: u16,
    pub height: u16,
    /// 2..=256, including the slot reserved for transparency.
    pub colors: u16,
    pub dither: bool,
    /// 0 = loop forever, -1 = play once, n = repeat n more times.
    pub loop_count: i32,
}

/// Per-frame delays (centiseconds) whose running total tracks real time.
pub fn frame_delays(count: usize, fps: f64) -> Vec<u16> {
    (0..count)
        .map(|i| {
            let at = |n: usize| (n as f64 * 100.0 / fps).round() as i64;
            (at(i + 1) - at(i)).clamp(1, u16::MAX as i64) as u16
        })
        .collect()
}

// ------------------------------------------------------------------ palette

const fn key15(r: u8, g: u8, b: u8) -> usize {
    ((r as usize >> 3) << 10) | ((g as usize >> 3) << 5) | (b as usize >> 3)
}

pub struct Histogram {
    count: Vec<u32>,
    sums: Vec<[f64; 3]>,
}

impl Default for Histogram {
    fn default() -> Self {
        Histogram {
            count: vec![0; 32768],
            sums: vec![[0.0; 3]; 32768],
        }
    }
}

impl Histogram {
    /// Add every `step`-th pixel of an RGBA buffer.
    pub fn add(&mut self, rgba: &[u8], step: usize) {
        for px in rgba.as_chunks::<4>().0.iter().step_by(step.max(1)) {
            let k = key15(px[0], px[1], px[2]);
            self.count[k] += 1;
            let s = &mut self.sums[k];
            s[0] += px[0] as f64;
            s[1] += px[1] as f64;
            s[2] += px[2] as f64;
        }
    }
}

struct Box {
    start: usize,
    end: usize,
    count: u64,
    axis: u8,
    score: f64,
}

/// Median cut over the histogram. Returns up to `max_colors` RGB entries.
pub fn build_palette(h: &Histogram, max_colors: usize) -> Vec<[u8; 3]> {
    let mut bins: Vec<u16> = (0..32768u16).filter(|&k| h.count[k as usize] > 0).collect();
    if bins.is_empty() {
        return vec![[0, 0, 0]];
    }
    let ch = |k: u16, axis: u8| match axis {
        0 => (k >> 10) & 31,
        1 => (k >> 5) & 31,
        _ => k & 31,
    };
    let make_box = |bins: &[u16], start: usize, end: usize| {
        let (mut lo, mut hi) = ([31u16; 3], [0u16; 3]);
        let mut count = 0u64;
        for &k in &bins[start..end] {
            for a in 0..3 {
                let v = ch(k, a);
                lo[a as usize] = lo[a as usize].min(v);
                hi[a as usize] = hi[a as usize].max(v);
            }
            count += h.count[k as usize] as u64;
        }
        // Perceptual-ish weighting: the eye is most sensitive to green.
        let wr = (hi[0] - lo[0]) as f64 * 1.0;
        let wg = (hi[1] - lo[1]) as f64 * 1.2;
        let wb = (hi[2] - lo[2]) as f64 * 0.8;
        let axis = if wg >= wr && wg >= wb {
            1
        } else if wr >= wb {
            0
        } else {
            2
        };
        let range = wr.max(wg).max(wb);
        let score = if end - start > 1 {
            range * (count as f64).sqrt()
        } else {
            -1.0
        };
        Box {
            start,
            end,
            count,
            axis,
            score,
        }
    };

    let mut boxes = vec![make_box(&bins, 0, bins.len())];
    while boxes.len() < max_colors {
        let Some((bi, _)) = boxes
            .iter()
            .enumerate()
            .filter(|(_, b)| b.score > 0.0)
            .fold(None, |best: Option<(usize, f64)>, (i, b)| match best {
                Some((_, s)) if s >= b.score => best,
                _ => Some((i, b.score)),
            })
        else {
            break;
        };
        let (start, end, axis, count) = (
            boxes[bi].start,
            boxes[bi].end,
            boxes[bi].axis,
            boxes[bi].count,
        );
        bins[start..end].sort_by_key(|&k| ch(k, axis)); // stable, like the JS version
        // split at the weighted median
        let half = count as f64 / 2.0;
        let (mut acc, mut split) = (0u64, start + 1);
        for (i, &k) in bins.iter().enumerate().take(end - 1).skip(start) {
            acc += h.count[k as usize] as u64;
            if acc as f64 >= half {
                split = i + 1;
                break;
            }
        }
        let (a, b) = (make_box(&bins, start, split), make_box(&bins, split, end));
        boxes.splice(bi..=bi, [a, b]);
    }

    boxes
        .iter()
        .map(|b| {
            let (mut s, mut n) = ([0.0f64; 3], 0.0f64);
            for &k in &bins[b.start..b.end] {
                let v = h.sums[k as usize];
                s[0] += v[0];
                s[1] += v[1];
                s[2] += v[2];
                n += h.count[k as usize] as f64;
            }
            [
                (s[0] / n).round() as u8,
                (s[1] / n).round() as u8,
                (s[2] / n).round() as u8,
            ]
        })
        .collect()
}

/// Nearest palette colour, cached per 15-bit colour.
struct Matcher<'a> {
    pal: &'a [[u8; 3]],
    cache: Vec<i16>,
}

impl<'a> Matcher<'a> {
    fn new(pal: &'a [[u8; 3]]) -> Self {
        Matcher {
            pal,
            cache: vec![-1; 32768],
        }
    }

    fn get(&mut self, r: u8, g: u8, b: u8) -> u8 {
        let k = key15(r, g, b);
        if self.cache[k] >= 0 {
            return self.cache[k] as u8;
        }
        let mut best = (u32::MAX, 0usize);
        for (i, p) in self.pal.iter().enumerate() {
            let dr = p[0] as i32 - r as i32;
            let dg = p[1] as i32 - g as i32;
            let db = p[2] as i32 - b as i32;
            let d = (dr * dr * 2 + dg * dg * 4 + db * db * 3) as u32;
            if d < best.0 {
                best = (d, i);
            }
        }
        self.cache[k] = best.1 as i16;
        best.1 as u8
    }
}

/// Map an RGBA frame to palette indices, optionally with Floyd–Steinberg dithering.
fn map_frame(rgba: &[u8], w: usize, h: usize, pal: &[[u8; 3]], dither: bool) -> Vec<u8> {
    let mut m = Matcher::new(pal);
    let mut out = vec![0u8; w * h];
    if !dither {
        for (o, px) in out.iter_mut().zip(rgba.as_chunks::<4>().0) {
            *o = m.get(px[0], px[1], px[2]);
        }
        return out;
    }
    // Two rolling error rows with one pixel of padding on each side.
    let mut cur = vec![0f32; (w + 2) * 3];
    let mut nxt = vec![0f32; (w + 2) * 3];
    for y in 0..h {
        nxt.fill(0.0);
        for x in 0..w {
            let p = y * w + x;
            let e = (x + 1) * 3;
            let c = |i: usize| (rgba[p * 4 + i] as f32 + cur[e + i]).clamp(0.0, 255.0);
            let (r, g, b) = (c(0), c(1), c(2));
            let idx = m.get(r as u8, g as u8, b as u8);
            out[p] = idx;
            let q = pal[idx as usize];
            let err = [r - q[0] as f32, g - q[1] as f32, b - q[2] as f32];
            for i in 0..3 {
                cur[e + 3 + i] += err[i] * 7.0 / 16.0;
                nxt[e - 3 + i] += err[i] * 3.0 / 16.0;
                nxt[e + i] += err[i] * 5.0 / 16.0;
                nxt[e + 3 + i] += err[i] / 16.0;
            }
        }
        std::mem::swap(&mut cur, &mut nxt);
    }
    out
}

// ------------------------------------------------------------------ LZW

/// Packs variable-width codes into GIF sub-blocks of up to 255 bytes.
struct Bits<'a> {
    out: &'a mut Vec<u8>,
    block: Vec<u8>,
    acc: u32,
    n: u32,
}

impl Bits<'_> {
    fn byte(&mut self, b: u8) {
        self.block.push(b);
        if self.block.len() == 255 {
            self.out.push(255);
            self.out.extend_from_slice(&self.block);
            self.block.clear();
        }
    }

    fn code(&mut self, code: u32, size: u32) {
        self.acc |= code << self.n;
        self.n += size;
        while self.n >= 8 {
            self.byte(self.acc as u8);
            self.acc >>= 8;
            self.n -= 8;
        }
    }

    fn finish(mut self) {
        if self.n > 0 {
            self.byte(self.acc as u8);
        }
        if !self.block.is_empty() {
            self.out.push(self.block.len() as u8);
            self.out.extend_from_slice(&self.block);
        }
        self.out.push(0); // block terminator
    }
}

/// LZW-compress `indices` as GIF image data (min code size byte + sub-blocks).
fn lzw_encode(indices: &[u8], min_code_size: u8, out: &mut Vec<u8>) {
    out.push(min_code_size);
    let clear = 1u32 << min_code_size;
    let eoi = clear + 1;
    let mut size = min_code_size as u32 + 1;
    let mut next = eoi + 1;
    let mut w = Bits {
        out,
        block: Vec::with_capacity(255),
        acc: 0,
        n: 0,
    };
    w.code(clear, size);
    let Some((&first, rest)) = indices.split_first() else {
        w.code(eoi, size);
        return w.finish();
    };
    // table[prefix * 256 + byte] = code + 1 (0 = empty)
    let mut table = vec![0u16; 4096 * 256];
    let mut prefix = first as u32;
    for &k in rest {
        let key = (prefix as usize) << 8 | k as usize;
        let c = table[key];
        if c != 0 {
            prefix = c as u32 - 1;
            continue;
        }
        w.code(prefix, size);
        if next == 4096 {
            w.code(clear, size);
            table.fill(0);
            next = eoi + 1;
            size = min_code_size as u32 + 1;
        } else {
            if next >= 1 << size {
                size += 1;
            }
            table[key] = (next + 1) as u16;
            next += 1;
        }
        prefix = k as u32;
    }
    w.code(prefix, size);
    w.code(eoi, size);
    w.finish();
}

// ------------------------------------------------------------------ encoder

fn table_bits(n: usize) -> u8 {
    let mut bits = 1;
    while (1usize << bits) < n {
        bits += 1;
    }
    bits
}

pub struct Encoder {
    opts: Options,
    delays: Vec<u16>,
    frames: Vec<Vec<u8>>,
    hist: Histogram,
    step: usize,
}

/// Encoded image data for one frame, ready to be written out.
struct Chunk {
    x: u16,
    y: u16,
    w: u16,
    h: u16,
    transparent: bool,
    data: Vec<u8>,
}

impl Encoder {
    /// `count` frames will follow, played at `fps`.
    pub fn new(opts: Options, count: usize, fps: f64) -> Result<Self, String> {
        if opts.width == 0 || opts.height == 0 {
            return Err("gif size must be at least 1x1".into());
        }
        if count == 0 {
            return Err("no frames".into());
        }
        if !fps.is_finite() || fps <= 0.0 {
            return Err("fps must be positive".into());
        }
        let npx = opts.width as usize * opts.height as usize;
        // Sample about 600k pixels in total for the palette.
        let step = ((npx * count) / 600_000).max(1);
        Ok(Encoder {
            opts,
            delays: frame_delays(count, fps),
            frames: Vec::with_capacity(count),
            hist: Histogram::default(),
            step,
        })
    }

    fn npx(&self) -> usize {
        self.opts.width as usize * self.opts.height as usize
    }

    pub fn push_frame(&mut self, rgba: Vec<u8>) -> Result<(), String> {
        if rgba.len() != self.npx() * 4 {
            return Err(format!(
                "frame is {} bytes, expected {}",
                rgba.len(),
                self.npx() * 4
            ));
        }
        if self.frames.len() == self.delays.len() {
            return Err("more frames than announced".into());
        }
        self.hist.add(&rgba, self.step);
        self.frames.push(rgba);
        Ok(())
    }

    /// Encode everything. `progress` gets 0..1; set `cancel` to stop early.
    pub fn finish(
        self,
        progress: impl Fn(f64) + Sync,
        cancel: &AtomicBool,
    ) -> Result<Vec<u8>, String> {
        let Encoder {
            opts,
            delays,
            frames,
            hist,
            ..
        } = self;
        if frames.len() != delays.len() {
            return Err(format!("got {} of {} frames", frames.len(), delays.len()));
        }
        let (w, h) = (opts.width as usize, opts.height as usize);
        let n = frames.len();
        let max_colors = opts.colors.clamp(2, 256) as usize;
        let pal = build_palette(&hist, max_colors - 1); // one slot is reserved for transparency
        let trans = pal.len() as u8;
        let bits = table_bits(pal.len() + 1);
        let check = || {
            if cancel.load(Ordering::Relaxed) {
                Err("cancelled".to_string())
            } else {
                Ok(())
            }
        };

        // 1. map every frame to palette indices (parallel)
        let done = AtomicUsize::new(0);
        let tick = |weight: f64, offset: f64| {
            let d = done.fetch_add(1, Ordering::Relaxed) + 1;
            progress(offset + weight * d as f64 / n as f64);
        };
        let mapped: Vec<Vec<u8>> = frames
            .into_par_iter()
            .map(|rgba| {
                check()?;
                let m = map_frame(&rgba, w, h, &pal, opts.dither);
                tick(0.6, 0.0);
                Ok(m)
            })
            .collect::<Result<_, String>>()?;

        // 2. inter-frame optimisation (sequential: each frame depends on what's shown)
        let mut shown: Vec<i32> = vec![-1; w * h];
        let rgb = |i: u8| {
            let p = pal[i as usize];
            (p[0] as i32) << 16 | (p[1] as i32) << 8 | p[2] as i32
        };
        let mut regions = Vec::with_capacity(n);
        for (f, mut idx) in mapped.into_iter().enumerate() {
            check()?;
            if f == 0 {
                for (s, &i) in shown.iter_mut().zip(&idx) {
                    *s = rgb(i);
                }
                regions.push((0, 0, w, h, false, idx));
                continue;
            }
            let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0usize, 0usize);
            let mut changed = false;
            for y in 0..h {
                for x in 0..w {
                    let p = y * w + x;
                    let c = rgb(idx[p]);
                    if c == shown[p] {
                        idx[p] = trans;
                    } else {
                        shown[p] = c;
                        changed = true;
                        x0 = x0.min(x);
                        x1 = x1.max(x);
                        y0 = y0.min(y);
                        y1 = y1.max(y);
                    }
                }
            }
            if !changed {
                (x0, y0, x1, y1) = (0, 0, 0, 0); // nothing changed: a 1x1 transparent pixel
            }
            let (fw, fh) = (x1 - x0 + 1, y1 - y0 + 1);
            let sub = if fw == w && fh == h {
                idx
            } else {
                let mut s = Vec::with_capacity(fw * fh);
                for y in y0..=y1 {
                    s.extend_from_slice(&idx[y * w + x0..y * w + x0 + fw]);
                }
                s
            };
            regions.push((x0, y0, fw, fh, true, sub));
        }

        // 3. LZW-compress each frame (parallel)
        done.store(0, Ordering::Relaxed);
        let min_code = bits.max(2);
        let chunks: Vec<Chunk> = regions
            .into_par_iter()
            .map(|(x, y, fw, fh, transparent, sub)| {
                check()?;
                let mut data = Vec::with_capacity(sub.len() / 2);
                lzw_encode(&sub, min_code, &mut data);
                tick(0.4, 0.6);
                Ok(Chunk {
                    x: x as u16,
                    y: y as u16,
                    w: fw as u16,
                    h: fh as u16,
                    transparent,
                    data,
                })
            })
            .collect::<Result<_, String>>()?;

        // 4. write the file
        let mut out =
            Vec::with_capacity(chunks.iter().map(|c| c.data.len() + 20).sum::<usize>() + 1024);
        let u16le = |out: &mut Vec<u8>, v: u16| out.extend_from_slice(&v.to_le_bytes());
        out.extend_from_slice(b"GIF89a");
        u16le(&mut out, opts.width);
        u16le(&mut out, opts.height);
        out.push(0x80 | (7 << 4) | (bits - 1)); // global colour table
        out.push(0); // background colour index
        out.push(0); // pixel aspect ratio
        for i in 0..1usize << bits {
            out.extend_from_slice(&pal.get(i).copied().unwrap_or([0, 0, 0]));
        }
        // Looping (NETSCAPE2.0). Omitted entirely = play once.
        if opts.loop_count >= 0 {
            out.extend_from_slice(&[0x21, 0xff, 11]);
            out.extend_from_slice(b"NETSCAPE2.0");
            out.extend_from_slice(&[3, 1]);
            u16le(&mut out, opts.loop_count.min(u16::MAX as i32) as u16);
            out.push(0);
        }
        for (c, delay) in chunks.iter().zip(&delays) {
            // graphic control extension; disposal 1 = leave in place
            out.extend_from_slice(&[0x21, 0xf9, 4, (1 << 2) | c.transparent as u8]);
            u16le(&mut out, *delay);
            out.push(if c.transparent { trans } else { 0 });
            out.push(0);
            // image descriptor (no local colour table)
            out.push(0x2c);
            for v in [c.x, c.y, c.w, c.h] {
                u16le(&mut out, v);
            }
            out.push(0);
            out.extend_from_slice(&c.data);
        }
        out.push(0x3b);
        progress(1.0);
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(w: u16, h: u16, colors: u16, dither: bool) -> Options {
        Options {
            width: w,
            height: h,
            colors,
            dither,
            loop_count: 0,
        }
    }

    fn encode(o: Options, fps: f64, frames: Vec<Vec<u8>>) -> Vec<u8> {
        let mut e = Encoder::new(o, frames.len(), fps).unwrap();
        for f in frames {
            e.push_frame(f).unwrap();
        }
        e.finish(|_| {}, &AtomicBool::new(false)).unwrap()
    }

    /// Decode with the `gif` crate, compositing frames like a viewer does.
    fn decode(data: &[u8]) -> (u16, u16, Vec<(u16, Vec<u8>)>) {
        let mut opts = ::gif::DecodeOptions::new();
        opts.set_color_output(::gif::ColorOutput::Indexed);
        let mut dec = opts.read_info(data).unwrap();
        let (w, h) = (dec.width(), dec.height());
        let pal = dec.global_palette().unwrap().to_vec();
        let mut canvas = vec![0u8; w as usize * h as usize * 3];
        let mut out = Vec::new();
        while let Some(f) = dec.read_next_frame().unwrap() {
            for y in 0..f.height as usize {
                for x in 0..f.width as usize {
                    let i = f.buffer[y * f.width as usize + x];
                    if Some(i) == f.transparent {
                        continue;
                    }
                    let p = ((f.top as usize + y) * w as usize + f.left as usize + x) * 3;
                    canvas[p..p + 3].copy_from_slice(&pal[i as usize * 3..i as usize * 3 + 3]);
                }
            }
            out.push((f.delay, canvas.clone()));
        }
        (w, h, out)
    }

    fn solid(w: usize, h: usize, rgb: [u8; 3]) -> Vec<u8> {
        (0..w * h)
            .flat_map(|_| [rgb[0], rgb[1], rgb[2], 255])
            .collect()
    }

    fn rgb_of(rgba: &[u8]) -> Vec<u8> {
        rgba.as_chunks::<4>()
            .0
            .iter()
            .flat_map(|p| [p[0], p[1], p[2]])
            .collect()
    }

    #[test]
    fn delays_track_real_time() {
        assert_eq!(frame_delays(3, 15.0), vec![7, 6, 7]);
        assert_eq!(
            frame_delays(30, 15.0)
                .iter()
                .map(|&d| d as u32)
                .sum::<u32>(),
            200
        );
        assert_eq!(frame_delays(4, 50.0), vec![2, 2, 2, 2]);
    }

    #[test]
    fn few_colours_survive_exactly() {
        // 4 flat colour quadrants, two frames with the quadrants swapped.
        let (w, h) = (40usize, 30usize);
        let colours = [[255, 0, 0], [0, 200, 0], [10, 20, 250], [250, 250, 250]];
        let frame = |shift: usize| -> Vec<u8> {
            (0..w * h)
                .flat_map(|p| {
                    let q = (p % w >= w / 2) as usize + 2 * (p / w >= h / 2) as usize;
                    let c = colours[(q + shift) % 4];
                    [c[0], c[1], c[2], 255]
                })
                .collect()
        };
        let frames = vec![frame(0), frame(1), frame(1)];
        let gif = encode(opts(w as u16, h as u16, 256, true), 10.0, frames.clone());
        let (gw, gh, decoded) = decode(&gif);
        assert_eq!((gw, gh), (40, 30));
        assert_eq!(decoded.len(), 3);
        for (i, (delay, px)) in decoded.iter().enumerate() {
            assert_eq!(*delay, 10);
            assert_eq!(px, &rgb_of(&frames[i]), "frame {i} differs");
        }
    }

    #[test]
    fn unchanged_frames_shrink_to_one_transparent_pixel() {
        let f = solid(64, 64, [30, 60, 90]);
        let gif = encode(
            opts(64, 64, 256, false),
            10.0,
            vec![f.clone(), f.clone(), f],
        );
        let mut dec = ::gif::DecodeOptions::new().read_info(&gif[..]).unwrap();
        let first = dec.read_next_frame().unwrap().unwrap();
        assert_eq!((first.width, first.height), (64, 64));
        for _ in 0..2 {
            let f = dec.read_next_frame().unwrap().unwrap();
            assert_eq!((f.width, f.height), (1, 1));
            assert!(f.transparent.is_some());
        }
    }

    #[test]
    fn only_the_changed_area_is_stored() {
        let (w, h) = (50usize, 40usize);
        let a = solid(w, h, [0, 0, 0]);
        let mut b = a.clone();
        for y in 10..15 {
            for x in 20..30 {
                b[(y * w + x) * 4] = 255;
            }
        }
        let gif = encode(
            opts(w as u16, h as u16, 256, false),
            10.0,
            vec![a, b.clone()],
        );
        let mut dec = ::gif::DecodeOptions::new().read_info(&gif[..]).unwrap();
        dec.read_next_frame().unwrap();
        let f = dec.read_next_frame().unwrap().unwrap();
        assert_eq!((f.left, f.top, f.width, f.height), (20, 10, 10, 5));
        assert_eq!(decode(&gif).2[1].1, rgb_of(&b));
    }

    #[test]
    fn noisy_frames_round_trip_through_lzw() {
        // Pseudo-random pixels force many LZW table resets.
        let (w, h) = (200usize, 150usize);
        let mut seed = 12345u32;
        let mut rnd = || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            seed
        };
        let frames: Vec<Vec<u8>> = (0..3)
            .map(|_| {
                (0..w * h)
                    .flat_map(|_| [(rnd() % 4) as u8 * 80, (rnd() % 4) as u8 * 80, 0, 255])
                    .collect()
            })
            .collect();
        let gif = encode(opts(w as u16, h as u16, 256, false), 20.0, frames.clone());
        for (i, (_, px)) in decode(&gif).2.iter().enumerate() {
            assert_eq!(px, &rgb_of(&frames[i]), "frame {i}");
        }
    }

    #[test]
    fn palette_respects_the_colour_limit() {
        let (w, h) = (64usize, 64usize);
        let grad: Vec<u8> = (0..w * h)
            .flat_map(|p| [(p % w * 4) as u8, (p / w * 4) as u8, 128, 255])
            .collect();
        for colors in [2u16, 16, 64, 256] {
            let gif = encode(
                opts(w as u16, h as u16, colors, true),
                10.0,
                vec![grad.clone()],
            );
            let dec = ::gif::DecodeOptions::new().read_info(&gif[..]).unwrap();
            let used = dec.global_palette().unwrap().len() / 3;
            assert!(
                used <= (colors as usize).next_power_of_two().max(2),
                "{colors}: table {used}"
            );
            assert!(gif.len() > 100);
        }
    }

    #[test]
    fn dithering_tracks_the_average_colour() {
        // A flat colour between two palette entries: dithered average stays close.
        let (w, h) = (64usize, 64usize);
        let mut frame = Vec::new();
        for p in 0..w * h {
            let v = if p % w < w / 2 { 0 } else { 255 };
            frame.extend_from_slice(&[v, v, v, 255]);
        }
        // middle stripe of grey 128 with only black/white available (2 colours + transparency = 3)
        for y in 0..h {
            for x in 24..40 {
                frame[(y * w + x) * 4..(y * w + x) * 4 + 3].copy_from_slice(&[128, 128, 128]);
            }
        }
        let gif = encode(opts(w as u16, h as u16, 3, true), 10.0, vec![frame]);
        let px = &decode(&gif).2[0].1;
        let mut sum = 0u64;
        for y in 0..h {
            for x in 26..38 {
                sum += px[(y * w + x) * 3] as u64;
            }
        }
        let avg = sum as f64 / (h * 12) as f64;
        assert!((avg - 128.0).abs() < 20.0, "average {avg}");
    }

    #[test]
    fn loop_settings() {
        let f = solid(4, 4, [1, 2, 3]);
        let forever = encode(opts(4, 4, 256, false), 10.0, vec![f.clone()]);
        assert!(forever.windows(11).any(|w| w == b"NETSCAPE2.0"));
        let once = encode(
            Options {
                loop_count: -1,
                ..opts(4, 4, 256, false)
            },
            10.0,
            vec![f],
        );
        assert!(!once.windows(11).any(|w| w == b"NETSCAPE2.0"));
        let dec = ::gif::DecodeOptions::new().read_info(&forever[..]).unwrap();
        assert_eq!(dec.repeat(), ::gif::Repeat::Infinite);
    }

    #[test]
    fn rejects_bad_input() {
        let mut e = Encoder::new(opts(4, 4, 256, false), 1, 10.0).unwrap();
        assert!(e.push_frame(vec![0; 10]).is_err());
        e.push_frame(vec![0; 64]).unwrap();
        assert!(e.push_frame(vec![0; 64]).is_err());
        let e = Encoder::new(opts(4, 4, 256, false), 2, 10.0).unwrap();
        assert!(e.finish(|_| {}, &AtomicBool::new(false)).is_err());
    }

    #[test]
    fn cancelling_stops_encoding() {
        let mut e = Encoder::new(opts(8, 8, 256, false), 1, 10.0).unwrap();
        e.push_frame(solid(8, 8, [9, 9, 9])).unwrap();
        assert_eq!(
            e.finish(|_| {}, &AtomicBool::new(true)).unwrap_err(),
            "cancelled"
        );
    }
}
