#!/usr/bin/env python3
"""Drive the real gifsonic window and check what it does.

  python3 tests/app_test.py

Builds gifsonic with the `autotest` feature (a hook that runs a test script in
the window), makes some test videos with ffmpeg, then:

  export   open a video, add a text layer, make a GIF, save it, cancel an export
  convert  open an AVI (needs ffmpeg conversion) and make a GIF from it
  quit     close the window with unsaved work: it must ask first

Needs ffmpeg, a desktop session, and (for the quit test) Hyprland's hyprctl.
"""

import json
import os
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(ROOT, "src-tauri", "target", "release", "gifsonic")
failures = 0

COMMON = r"""
const errors = [];
window.addEventListener('error', (e) => errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 20000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout'); await sleep(50); } };
const inv = (c, a) => window.__TAURI__.core.invoke(c, a);
const report = (o) => inv('autotest_report', { text: 'RESULT ' + JSON.stringify(o) });
const done = async (o) => { o.errors = errors; await report(o); await inv('autotest_exit', { code: 0 }); };
const fail = (e) => done({ fatal: String(e && e.stack || e) });
"""

SCRIPTS = {
    "export": r"""
(async () => {
  const g = window.gifsonic;
  await until(() => g.S.loaded);
  const r = { file: g.S.fileName, dur: g.S.dur, ffmpeg: g.S.ffmpeg };
  g.setStart(1); g.setEnd(2.5); g.S.width = 320; g.S.fps = 10; g.refreshAll();
  g.addText(); document.activeElement.blur();
  const L = g.S.layers[0]; L.text = 'hello'; L._dirty = true;
  const t0 = performance.now();
  await g.exportGif();
  r.exportMs = Math.round(performance.now() - t0);
  r.meta = document.querySelector('#exp-meta').textContent;
  r.resultShown = !document.querySelector('#exp-result').classList.contains('hidden');
  document.querySelector('#exp-download').click();
  await until(() => document.querySelector('#exp-meta').dataset.path);
  r.path = document.querySelector('#exp-meta').dataset.path;
  r.savedAfter = g.S.saved;
  document.querySelector('[data-action=export-close]').click();
  // cancel part-way through (deselect the text first, so the timeline edits the gif)
  g.select(null);
  g.setEnd(4); g.refreshAll();
  const p = g.exportGif();
  await sleep(300);
  document.querySelector('[data-action=export-close]').click();
  await p;
  r.cancelStatus = document.querySelector('#status').textContent;
  // a second export still works after cancelling
  g.setEnd(1.5); g.refreshAll();
  await g.exportGif();
  r.secondMeta = document.querySelector('#exp-meta').textContent;
  await done(r);
})().catch(fail);
""",
    "convert": r"""
(async () => {
  const g = window.gifsonic;
  await until(() => g.S.loaded, 60000);
  const r = { file: g.S.fileName, vw: g.S.vw, vh: g.S.vh, dur: g.S.dur };
  g.setStart(0); g.setEnd(1); g.S.width = 160; g.refreshAll();
  await g.exportGif();
  r.meta = document.querySelector('#exp-meta').textContent;
  await done(r);
})().catch(fail);
""",
    "quit": r"""
(async () => {
  const g = window.gifsonic;
  await until(() => g.S.loaded);
  await sleep(500);
  await report({ ready: true });
  // the test closes the window now; the quit prompt must appear instead
  await until(() => !document.querySelector('#modal-quit').classList.contains('hidden'), 15000);
  await report({ prompt: true, errors });
  await sleep(4000); // the test checks the app is still running meanwhile
  document.querySelector('[data-action=quit-yes]').click();
})().catch(fail);
""",
}


def check(ok, what):
    global failures
    print(("  ok    " if ok else "  FAIL  ") + what, flush=True)
    failures += not ok


def make_videos(tmp):
    def ff(*args):
        subprocess.run(["ffmpeg", "-v", "error", "-y", *args], check=True)
    mp4 = os.path.join(tmp, "test.mp4")
    ff("-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", mp4)
    avi = os.path.join(tmp, "test.avi")
    ff("-f", "lavfi", "-i", "testsrc=s=320x240:r=25:d=3", "-c:v", "mpeg4", avi)
    return mp4, avi


def run(mode, video, tmp, during=None):
    script = os.path.join(tmp, f"{mode}.js")
    with open(script, "w") as f:
        f.write(COMMON + SCRIPTS[mode])
    env = dict(os.environ, GIFSONIC_AUTOTEST=script, GIFSONIC_SAVE_DIR=os.path.join(tmp, "saved"))
    proc = subprocess.Popen([BIN, video], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    results = []
    try:
        for line in proc.stdout:
            if line.startswith("RESULT "):
                results.append(json.loads(line[7:]))
                if during:
                    during(proc, results[-1])
        proc.wait(30)
    except subprocess.TimeoutExpired:
        proc.kill()
    if any("fatal" in r for r in results):
        print(proc.stderr.read()[-2000:])
    return proc, results


def ffprobe_frames(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0",
                          "-show_entries", "stream=nb_read_frames,width,height", "-of", "json", path],
                         capture_output=True, text=True).stdout
    return json.loads(out)["streams"][0]


def close_window(pid):
    subprocess.run(["hyprctl", "dispatch", f'hl.dsp.focus({{ window = "pid:{pid}" }})'], capture_output=True)
    time.sleep(0.5)
    subprocess.run(["hyprctl", "dispatch", "hl.dsp.window.close()"], capture_output=True)


def main():
    print("building (cargo build --release --features autotest)", flush=True)
    subprocess.run(["cargo", "build", "--release", "--quiet", "--features", "autotest"],
                   cwd=os.path.join(ROOT, "src-tauri"), check=True)
    with tempfile.TemporaryDirectory(prefix="gifsonic-test-") as tmp:
        mp4, avi = make_videos(tmp)

        print("export")
        proc, res = run("export", mp4, tmp)
        r = res[-1] if res else {}
        check(not r.get("fatal"), "script ran" + (f": {r.get('fatal')}" if r.get("fatal") else ""))
        check(r.get("file") == "test.mp4" and abs(r.get("dur", 0) - 6) < 0.1, f"video from the command line opened ({r.get('file')}, {r.get('dur')} s)")
        check(r.get("resultShown") and "15 frames" in r.get("meta", ""), f"gif made: {r.get('meta')} in {r.get('exportMs')} ms")
        path = r.get("path", "")
        check(path.startswith(os.path.join(tmp, "saved")) and os.path.isfile(path), f"gif saved to {path}")
        if os.path.isfile(path):
            info = ffprobe_frames(path)
            check(info.get("nb_read_frames") == "15" and info.get("width") == 320, f"saved gif is valid ({info})")
        check(r.get("savedAfter") is True, "saving clears the unsaved-work flag")
        check(r.get("cancelStatus") == "cancelled", f"cancelling stops the export ({r.get('cancelStatus')!r})")
        check("5 frames" in r.get("secondMeta", ""), f"exporting again after a cancel works ({r.get('secondMeta')})")
        check(not r.get("errors"), f"no JavaScript errors {r.get('errors') or ''}")

        print("convert")
        proc, res = run("convert", avi, tmp)
        r = res[-1] if res else {}
        check(not r.get("fatal"), "script ran" + (f": {r.get('fatal')}" if r.get("fatal") else ""))
        check(r.get("vw") == 320 and r.get("vh") == 240, f"AVI opened via ffmpeg ({r.get('vw')}x{r.get('vh')}, {r.get('dur')} s)")
        check("frames" in r.get("meta", ""), f"gif made from it: {r.get('meta')}")
        check(not r.get("errors"), f"no JavaScript errors {r.get('errors') or ''}")

        print("quit")
        state = {}
        def during(proc, result):
            if result.get("ready"):
                close_window(proc.pid)
                time.sleep(2)
                state["alive_after_close"] = proc.poll() is None
        proc, res = run("quit", mp4, tmp, during)
        check(state.get("alive_after_close") is True, "closing with unsaved work doesn't quit straight away")
        check(any(r.get("prompt") for r in res), "the quit prompt appears")
        check(proc.returncode == 0, f"choosing quit closes the app (exit {proc.returncode})")
    print("\nall passed" if not failures else f"\n{failures} FAILED")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
