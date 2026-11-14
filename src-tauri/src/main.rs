//! gifsonic: turn videos into GIFs.
//!
//! The interface (ui/) runs in a native window. Rust does the work the page
//! can't: encoding GIFs, converting unusual video formats with ffmpeg, saving
//! to ~/Pictures/gifsonic, and asking before quitting with unsaved work.

mod gif;

use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use serde::{Deserialize, Serialize};
use tauri::{
    Emitter, Manager, State, WindowEvent,
    ipc::{Channel, InvokeBody, Request, Response},
};

const USAGE: &str = "\
gifsonic: turn videos into GIFs

usage: gifsonic [VIDEO]

  VIDEO        open this video straight away
  --version    print the version
  -h, --help   show this help

GIFs are saved to ~/Pictures/gifsonic (or $GIFSONIC_SAVE_DIR).";

#[derive(Default)]
struct AppState {
    initial: Option<PathBuf>,
    /// A video is loaded and no GIF has been saved since.
    dirty: AtomicBool,
    quitting: AtomicBool,
    job: Mutex<Option<gif::Encoder>>,
    cancel: Mutex<Arc<AtomicBool>>,
}

type Res<T> = Result<T, String>;

fn raw_body(request: &Request) -> Res<Vec<u8>> {
    match request.body() {
        InvokeBody::Raw(b) => Ok(b.clone()),
        _ => Err("expected binary data".into()),
    }
}

fn header(request: &Request, name: &str) -> Option<String> {
    request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
}

// ------------------------------------------------------------------ app info

#[derive(Serialize)]
struct Info {
    version: &'static str,
    ffmpeg: bool,
}

fn have(cmd: &str) -> bool {
    std::env::var_os("PATH")
        .is_some_and(|paths| std::env::split_paths(&paths).any(|d| d.join(cmd).is_file()))
}

#[tauri::command]
fn app_info() -> Info {
    Info {
        version: env!("CARGO_PKG_VERSION"),
        ffmpeg: have("ffmpeg"),
    }
}

#[derive(Serialize)]
struct Initial {
    name: String,
}

/// The video given on the command line ("Open with gifsonic"), if any.
#[tauri::command]
fn initial_video(state: State<AppState>) -> Option<Initial> {
    let p = state.initial.as_ref()?;
    Some(Initial {
        name: p.file_name()?.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
async fn initial_video_bytes(state: State<'_, AppState>) -> Res<Response> {
    let p = state.initial.clone().ok_or("no initial video")?;
    let bytes = tauri::async_runtime::spawn_blocking(move || fs::read(&p))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    Ok(Response::new(bytes))
}

// ------------------------------------------------------------------ ffmpeg

/// Convert a video the window can't play into mp4 (H.264) or webm (VP8).
#[tauri::command]
async fn convert_video(request: Request<'_>) -> Res<Response> {
    if !have("ffmpeg") {
        return Err("ffmpeg is not installed".into());
    }
    let webm = header(&request, "x-fmt").as_deref() == Some("webm");
    let input = raw_body(&request)?;
    tauri::async_runtime::spawn_blocking(move || -> Res<Response> {
        let tmp = tempfile::Builder::new()
            .prefix("gifsonic-")
            .tempdir()
            .map_err(|e| e.to_string())?;
        let src = tmp.path().join("input");
        fs::write(&src, input).map_err(|e| e.to_string())?;
        let out = tmp.path().join(if webm { "out.webm" } else { "out.mp4" });
        let codec: &[&str] = if webm {
            &[
                "-c:v",
                "libvpx",
                "-deadline",
                "realtime",
                "-cpu-used",
                "8",
                "-crf",
                "6",
                "-b:v",
                "25M",
            ]
        } else {
            &[
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "16",
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
            ]
        };
        let r = Command::new("ffmpeg")
            .args(["-v", "error", "-y", "-i"])
            .arg(&src)
            .args(["-map", "0:v:0", "-an", "-vf", "scale='min(1920,iw)':-2"])
            .args(codec)
            .arg(&out)
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("couldn't run ffmpeg: {e}"))?;
        if !r.status.success() || !out.exists() {
            let err = String::from_utf8_lossy(&r.stderr);
            let tail: String = err
                .chars()
                .rev()
                .take(500)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            return Err(format!("ffmpeg failed: {tail}"));
        }
        Ok(Response::new(fs::read(&out).map_err(|e| e.to_string())?))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ------------------------------------------------------------------ saving

fn pictures_dir() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| "/tmp".into());
    if let Ok(out) = Command::new("xdg-user-dir").arg("PICTURES").output() {
        let d = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !d.is_empty() && Path::new(&d) != home {
            return d.into();
        }
    }
    home.join("Pictures")
}

fn save_dir() -> PathBuf {
    match std::env::var("GIFSONIC_SAVE_DIR") {
        Ok(d) if !d.is_empty() => match d.strip_prefix("~/") {
            Some(rest) => std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_default()
                .join(rest),
            None => d.into(),
        },
        _ => pictures_dir().join("gifsonic"),
    }
}

/// A file name that's safe to use and ends in .gif.
fn clean_name(name: &str) -> String {
    let base = Path::new(name)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .trim();
    let base = if base.is_empty() || base.starts_with('.') {
        "gifsonic.gif"
    } else {
        base
    };
    if base.to_lowercase().ends_with(".gif") {
        base.to_string()
    } else {
        format!("{base}.gif")
    }
}

fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let stem = name
        .strip_suffix(".gif")
        .or_else(|| name.strip_suffix(".GIF"))
        .unwrap_or(name);
    let ext = &name[stem.len()..];
    let mut p = dir.join(name);
    let mut n = 1;
    while p.exists() {
        p = dir.join(format!("{stem}-{n}{ext}"));
        n += 1;
    }
    p
}

/// Save the finished GIF; returns where it went.
#[tauri::command]
async fn save_gif(request: Request<'_>) -> Res<String> {
    let name = clean_name(
        &header(&request, "x-name")
            .map(|n| decode_uri(&n))
            .unwrap_or_default(),
    );
    let data = raw_body(&request)?;
    let dir = save_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("can't create {}: {e}", dir.display()))?;
    // create_new: never overwrite, even if another save raced us to the name
    for _ in 0..100 {
        let path = unique_path(&dir, &name);
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut f) => {
                use std::io::Write;
                f.write_all(&data).map_err(|e| e.to_string())?;
                return Ok(path.to_string_lossy().into_owned());
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("couldn't find a free file name".into())
}

fn decode_uri(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len()
            && let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16)
        {
            out.push(v);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Open the folder a saved GIF is in.
#[tauri::command]
fn reveal(path: String) {
    let p = Path::new(&path);
    let dir = if p.is_dir() {
        p
    } else {
        p.parent().unwrap_or(p)
    };
    if dir.is_dir() {
        let _ = Command::new("xdg-open")
            .arg(dir)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    }
}

// ------------------------------------------------------------------ quitting

#[tauri::command]
fn set_dirty(state: State<AppState>, dirty: bool) {
    state.dirty.store(dirty, Ordering::Relaxed);
}

#[tauri::command]
fn quit(app: tauri::AppHandle, state: State<AppState>) {
    state.quitting.store(true, Ordering::Relaxed);
    app.exit(0);
}

// ------------------------------------------------------------------ encoding

#[derive(Deserialize)]
struct StartOpts {
    width: u16,
    height: u16,
    colors: u16,
    dither: bool,
    #[serde(rename = "loop")]
    loop_count: i32,
    fps: f64,
    count: usize,
}

#[tauri::command]
fn encoder_start(state: State<AppState>, opts: StartOpts) -> Res<()> {
    let o = gif::Options {
        width: opts.width,
        height: opts.height,
        colors: opts.colors,
        dither: opts.dither,
        loop_count: opts.loop_count,
    };
    let enc = gif::Encoder::new(o, opts.count, opts.fps)?;
    *state.cancel.lock().unwrap() = Arc::new(AtomicBool::new(false));
    *state.job.lock().unwrap() = Some(enc);
    Ok(())
}

/// One captured frame (raw RGBA bytes).
#[tauri::command]
async fn encoder_frame(state: State<'_, AppState>, request: Request<'_>) -> Res<()> {
    let data = raw_body(&request)?;
    state
        .job
        .lock()
        .unwrap()
        .as_mut()
        .ok_or("no gif is being made")?
        .push_frame(data)
}

#[tauri::command]
async fn encoder_finish(state: State<'_, AppState>, on_progress: Channel<f64>) -> Res<Response> {
    let enc = state
        .job
        .lock()
        .unwrap()
        .take()
        .ok_or("no gif is being made")?;
    let cancel = state.cancel.lock().unwrap().clone();
    let gif = tauri::async_runtime::spawn_blocking(move || {
        let last = Mutex::new(-1.0f64);
        enc.finish(
            |p| {
                // ~100 updates are plenty for a progress bar
                let mut l = last.lock().unwrap();
                if p >= 1.0 || p - *l >= 0.01 {
                    *l = p;
                    let _ = on_progress.send(p);
                }
            },
            &cancel,
        )
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(Response::new(gif))
}

#[tauri::command]
fn encoder_cancel(state: State<AppState>) {
    state.cancel.lock().unwrap().store(true, Ordering::Relaxed);
    state.job.lock().unwrap().take();
}

// ------------------------------------------------------------------ test hooks

#[cfg(feature = "autotest")]
#[tauri::command]
fn autotest_report(text: String) {
    println!("{text}");
}

#[cfg(feature = "autotest")]
#[tauri::command]
fn autotest_exit(code: i32) {
    std::process::exit(code);
}

// ------------------------------------------------------------------ main

fn main() {
    let mut initial = None;
    for arg in std::env::args().skip(1) {
        match arg.as_str() {
            "--version" | "-V" => {
                println!("gifsonic {}", env!("CARGO_PKG_VERSION"));
                return;
            }
            "-h" | "--help" => {
                println!("{USAGE}");
                return;
            }
            a if a.starts_with('-') => {
                eprintln!("gifsonic: unknown option {a}\n\n{USAGE}");
                std::process::exit(2);
            }
            a => {
                let mut p = PathBuf::from(a.strip_prefix("file://").unwrap_or(a));
                // An AppImage starts in its own folder; OWD is where it was run from.
                if p.is_relative()
                    && let Some(owd) = std::env::var_os("OWD")
                {
                    p = PathBuf::from(owd).join(p);
                }
                match p.canonicalize() {
                    Ok(p) if p.is_file() => initial = Some(p),
                    _ => {
                        eprintln!("gifsonic: no such file: {a}");
                        std::process::exit(2);
                    }
                }
            }
        }
    }

    let builder = tauri::Builder::default()
        .manage(AppState {
            initial,
            ..Default::default()
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                if state.dirty.load(Ordering::Relaxed) && !state.quitting.load(Ordering::Relaxed) {
                    api.prevent_close();
                    let _ = window.emit("ask-quit", ());
                }
            }
        });

    #[cfg(feature = "autotest")]
    let builder = builder
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                if let Ok(path) = std::env::var("GIFSONIC_AUTOTEST") {
                    let js = fs::read_to_string(&path).expect("autotest script");
                    webview.eval(&js).expect("eval autotest script");
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            initial_video,
            initial_video_bytes,
            convert_video,
            save_gif,
            reveal,
            set_dirty,
            quit,
            encoder_start,
            encoder_frame,
            encoder_finish,
            encoder_cancel,
            autotest_report,
            autotest_exit
        ]);

    #[cfg(not(feature = "autotest"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        app_info,
        initial_video,
        initial_video_bytes,
        convert_video,
        save_gif,
        reveal,
        set_dirty,
        quit,
        encoder_start,
        encoder_frame,
        encoder_finish,
        encoder_cancel
    ]);

    if let Err(e) = builder.run(tauri::generate_context!()) {
        eprintln!("gifsonic: couldn't start: {e}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_are_cleaned() {
        assert_eq!(clean_name("clip-480w-15fps.gif"), "clip-480w-15fps.gif");
        assert_eq!(clean_name("clip"), "clip.gif");
        assert_eq!(clean_name("../../etc/passwd"), "passwd.gif");
        assert_eq!(clean_name(""), "gifsonic.gif");
        assert_eq!(clean_name(".hidden"), "gifsonic.gif");
        assert_eq!(clean_name("SHOUT.GIF"), "SHOUT.GIF");
    }

    #[test]
    fn names_never_collide() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.gif"), b"x").unwrap();
        fs::write(dir.path().join("a-1.gif"), b"x").unwrap();
        assert_eq!(unique_path(dir.path(), "a.gif"), dir.path().join("a-2.gif"));
        assert_eq!(unique_path(dir.path(), "b.gif"), dir.path().join("b.gif"));
    }

    #[test]
    fn uri_decoding() {
        assert_eq!(decode_uri("my%20clip%E2%99%A1.gif"), "my clip♡.gif");
        assert_eq!(decode_uri("100%"), "100%");
        assert_eq!(decode_uri("a%zzb"), "a%zzb");
    }
}
