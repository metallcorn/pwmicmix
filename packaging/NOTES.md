# AudioMixer packaging notes

_Deep-dive kept out of CLAUDE.md so it isn't loaded into context every turn._

## Packaging (AppImage)

`bash packaging/build-appimage.sh` → `AudioMixer-x86_64.AppImage` (~202 MB). It
downloads a portable CPython (niess/python-appimage), pip-installs our deps +
`pywebview`+`PySide6` into it, copies `app.py`/`pipewire.py`/`levels.py`/`desktop.py`/
`static/`, trims Qt (`trim-qt.sh`), and packs with `appimagetool`. `NO_QT_TRIM=1`
skips the trim; `APPIMAGE_EXTRACT_AND_RUN=1` avoids appimagetool's own FUSE mount.

Packaging gotchas (do not regress):
1. **Host `pw-*`, bundled everything else.** The PipeWire CLIs must match the
   running daemon, so they are NOT bundled — `AppRun` keeps the host `PATH`. And
   it must NOT export `LD_LIBRARY_PATH`: the bundled Python uses RPATH, and
   leaking the AppImage's libs into spawned `pw-*` would crash them.
2. **Read-only mount → `AUDIOMIXER_DATA`.** `app.py` honours this env (set by
   `AppRun` to `~/.config/AudioMixer`) for `state.json`/`presets.json`. Unset →
   writes next to `app.py` (dev behaviour, unchanged).
3. **`desktop.py` = windowed entry.** Qt WebEngine *is* Chromium, so the UI we
   already target renders identically (GPU compositing → no headless backdrop-blur
   artifact). **Close = quit** (process exits; detached mics stay alive). Boots its
   own server only if none is already ours (single-instance attach via `/api/ping`
   scan over the port range) — otherwise it just opens a window at the running one.
4. **App identity for the panel icon.** `desktop.py` sets `QApplication`
   `setDesktopFileName("AudioMixer")` + window icon BEFORE pywebview builds the
   window; `.desktop` has `StartupWMClass=AudioMixer`. That's what gives GNOME
   (Wayland) and KDE our icon + window grouping.
5. **Qt trim caveats** (`trim-qt.sh`): the shared lib drops the `Qt` prefix
   (module `QtCharts` → `libQt6Charts.so`); ffmpeg (`libav*`) is dlopen'd not
   DT_NEEDED so it's safe to drop (no HTML5 media in our UI); keep only the
   `en-US` WebEngine locale. `libQt6WebEngineCore` (~195 MB Chromium) is the
   irreducible floor. Re-run the offscreen render self-test after any trim change.
6. **Port auto-select.** `_find_free_port(8723)` falls through to a neighbour if
   8723 is busy; QR/netinfo/banner read the chosen `PORT` at request time.
7. **No display in the agent for real Qt windows** — verify the bundle by driving
   QtWebEngine `QT_QPA_PLATFORM=offscreen` (load a page, `evaluate_js` the DOM).
   The on-screen look is the user's to confirm.

