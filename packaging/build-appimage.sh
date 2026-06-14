#!/usr/bin/env bash
# Build AudioMixer-x86_64.AppImage: a bundled portable Python + Flask/numpy/qrcode
# + our app, using the HOST's pw-* PipeWire tools at runtime (not bundled).
set -euo pipefail

ARCH="x86_64"
PYMINOR="3.12"                 # which portable CPython to bundle
WHEELTAG="cp312-cp312"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$ROOT/packaging"
BUILD="$ROOT/build"
APPDIR="$BUILD/AudioMixer.AppDir"
mkdir -p "$BUILD"

# ── 1. fetch a portable CPython AppImage (niess/python-appimage) ────────────
PYAI="$BUILD/python-${PYMINOR}.AppImage"
if [ ! -f "$PYAI" ]; then
  echo "→ resolving latest python${PYMINOR} (${WHEELTAG}) build…"
  URL="$(curl -fsSL "https://api.github.com/repos/niess/python-appimage/releases/tags/python${PYMINOR}" \
        | grep -oE '"browser_download_url": *"[^"]+"' | cut -d'"' -f4 \
        | grep "${WHEELTAG}-manylinux2014_${ARCH}.AppImage" | head -1)"
  [ -n "$URL" ] || { echo "could not find a python${PYMINOR} ${ARCH} asset"; exit 1; }
  echo "→ downloading $URL"
  wget -q --show-progress -O "$PYAI" "$URL"
fi
chmod +x "$PYAI"

# ── 2. extract it into a fresh AppDir ───────────────────────────────────────
echo "→ extracting portable python…"
rm -rf "$APPDIR" "$BUILD/squashfs-root"
( cd "$BUILD" && "$PYAI" --appimage-extract >/dev/null )
mv "$BUILD/squashfs-root" "$APPDIR"

PYBIN="$(echo "$APPDIR"/opt/python*/bin/python*.* | tr ' ' '\n' | grep -E 'python[0-9]+\.[0-9]+$' | head -1)"
echo "→ bundled interpreter: ${PYBIN#$APPDIR/}"

# ── 3. install our runtime deps into the bundled interpreter ────────────────
echo "→ installing flask numpy qrcode…"
"$PYBIN" -m pip install --no-warn-script-location -q --upgrade pip
"$PYBIN" -m pip install --no-warn-script-location -q -r "$ROOT/requirements.txt"

echo "→ installing desktop window deps (pywebview + Qt WebEngine)…"
"$PYBIN" -m pip install --no-warn-script-location -q pywebview qtpy PySide6-Essentials PySide6-Addons

# Trim the Qt bundle: PySide6-Addons ships every Qt add-on, but the native window
# only needs QtWebEngine (+ its Quick/Qml/Network/etc. deps). Drop the big unrelated
# module families to keep the AppImage closer to ~150 MB. Set NO_QT_TRIM=1 to skip.
if [ -z "${NO_QT_TRIM:-}" ]; then
  echo "→ trimming unused Qt modules…"
  bash "$PKG/trim-qt.sh" "$APPDIR" || echo "  (trim skipped/failed — continuing)"
fi

# ── 4. drop our application in ──────────────────────────────────────────────
echo "→ copying app…"
APP="$APPDIR/opt/audiomixer"
rm -rf "$APP"; mkdir -p "$APP"
cp "$ROOT/app.py" "$ROOT/pipewire.py" "$ROOT/levels.py" "$ROOT/desktop.py" "$APP/"
cp -r "$ROOT/static" "$APP/"

# ── 5. our AppRun / .desktop / icon (replace python-appimage's defaults) ────
echo "→ desktop integration…"
rm -f "$APPDIR"/*.desktop "$APPDIR"/*.png "$APPDIR"/.DirIcon
rm -f "$APPDIR"/usr/share/applications/*.desktop 2>/dev/null || true
rm -rf "$APPDIR"/usr/share/icons 2>/dev/null || true

install -m755 "$PKG/AppRun" "$APPDIR/AppRun"
cp "$PKG/AudioMixer.desktop" "$APPDIR/AudioMixer.desktop"
mkdir -p "$APPDIR/usr/share/applications" "$APPDIR/usr/share/icons/hicolor/256x256/apps"
cp "$PKG/AudioMixer.desktop" "$APPDIR/usr/share/applications/AudioMixer.desktop"
cp "$PKG/icon.png" "$APPDIR/AudioMixer.png"
cp "$PKG/icon.png" "$APPDIR/usr/share/icons/hicolor/256x256/apps/AudioMixer.png"
ln -sf AudioMixer.png "$APPDIR/.DirIcon"

# ── 6. package with appimagetool ────────────────────────────────────────────
AIT="$BUILD/appimagetool-${ARCH}.AppImage"
if [ ! -f "$AIT" ]; then
  echo "→ downloading appimagetool…"
  wget -q --show-progress -O "$AIT" \
    "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-${ARCH}.AppImage"
fi
chmod +x "$AIT"

OUT="$ROOT/AudioMixer-${ARCH}.AppImage"
echo "→ building $OUT"
ARCH="$ARCH" "$AIT" "$APPDIR" "$OUT"
echo
echo "✓ Done: $OUT"
ls -lh "$OUT"
