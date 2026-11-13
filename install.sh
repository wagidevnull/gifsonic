#!/bin/sh
# gifsonic installer (per-user, no root needed except for optional packages)
#   ./install.sh              install or update
#   ./install.sh --uninstall  remove gifsonic
set -e

SHARE="${XDG_DATA_HOME:-$HOME/.local/share}"
DEST="$SHARE/gifsonic/app"
BIN="$HOME/.local/bin"
APPS="$SHARE/applications"
ICONS="$SHARE/icons/hicolor"

cd "$(dirname "$0")"
say()  { printf '\n\033[1;35m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

refresh_desktop() {
    command -v update-desktop-database >/dev/null && update-desktop-database -q "$APPS" 2>/dev/null || true
    command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t "$ICONS" 2>/dev/null || true
}

if [ "$1" = "--uninstall" ]; then
    say "Removing gifsonic"
    rm -rf "$SHARE/gifsonic"
    rm -f "$BIN/gifsonic" "$APPS/gifsonic.desktop" \
          "$ICONS/scalable/apps/gifsonic.svg" "$ICONS/256x256/apps/gifsonic.png"
    refresh_desktop
    echo "Done. (Saved GIFs in ~/Pictures/gifsonic were left alone.)"
    exit 0
fi
[ -z "$1" ] || die "unknown option: $1"
[ "$(id -u)" -ne 0 ] || die "run this as your normal user, not root"

command -v python3 >/dev/null || die "python3 is required"

# ------------------------------------------------------------------ optional extras
native_ok() { python3 -c 'import webview' 2>/dev/null; }

if ! command -v ffmpeg >/dev/null; then
    warn "ffmpeg not found: gifsonic works, but can't convert unusual video formats (mkv/mov/hevc...)."
fi

if ! native_ok; then
    say "Native window"
    echo "gifsonic can open in its own window (needs pywebview + WebKitGTK),"
    echo "or in a browser window if you skip this."
    pm=""
    if command -v pacman >/dev/null; then
        pm="sudo pacman -S --needed python-pywebview webkit2gtk-4.1 python-gobject gst-libav gst-plugins-good"
    elif command -v apt-get >/dev/null; then
        pm="sudo apt-get install -y python3-webview gir1.2-webkit2-4.1 python3-gi gstreamer1.0-libav gstreamer1.0-plugins-good"
    elif command -v dnf >/dev/null; then
        pm="sudo dnf install -y python3-pywebview webkit2gtk4.1 python3-gobject gstreamer1-libav gstreamer1-plugins-good"
    elif command -v zypper >/dev/null; then
        pm="sudo zypper install -y python3-pywebview webkit2gtk3 python3-gobject gstreamer-plugins-libav gstreamer-plugins-good"
    fi
    if [ -n "$pm" ] && [ -t 0 ]; then
        printf 'Install it now with:\n  %s\n[Y/n] ' "$pm"
        read -r ans
        case "$ans" in
            [nN]*) echo "Skipped - gifsonic will use a browser window." ;;
            *) $pm || warn "package install failed - gifsonic will use a browser window." ;;
        esac
    elif [ -n "$pm" ]; then
        echo "To get the native window later, run:  $pm"
    fi
fi

# ------------------------------------------------------------------ install files
say "Installing gifsonic"
rm -rf "$DEST"
mkdir -p "$DEST" "$BIN" "$APPS" "$ICONS/scalable/apps" "$ICONS/256x256/apps"
cp -r index.html css js gifsonic "$DEST/"
chmod +x "$DEST/gifsonic"
ln -sf "$DEST/gifsonic" "$BIN/gifsonic"
cp icons/gifsonic.svg "$ICONS/scalable/apps/gifsonic.svg"
cp icons/gifsonic-256.png "$ICONS/256x256/apps/gifsonic.png"
# Use the full path: app launchers (e.g. ones that start apps via systemd)
# often don't have ~/.local/bin on their PATH.
sed "s|^Exec=gifsonic|Exec=$BIN/gifsonic|" gifsonic.desktop > "$APPS/gifsonic.desktop"
refresh_desktop

if native_ok; then mode="native window"; else mode="browser window"; fi
echo "Installed to $DEST ($mode)"

case ":$PATH:" in
    *":$BIN:"*) ;;
    *) warn "$BIN is not in your PATH - add it, or launch gifsonic from your app menu." ;;
esac

cat <<EOF

Done! Launch gifsonic from your app menu, or run:
  gifsonic               open the app
  gifsonic video.mp4     open a video straight away

GIFs are saved to ~/Pictures/gifsonic.  Uninstall: ./install.sh --uninstall
EOF
