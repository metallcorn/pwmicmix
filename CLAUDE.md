# CLAUDE.md — guidance for working on AudioMixer

This file is for an AI assistant (or any new developer) picking up this project.
It captures the architecture, conventions, and the **hard-won gotchas** so you
don't re-learn them painfully.

## What this is

A web-based mixing console for **PipeWire** on Linux. It takes channels of real
audio devices (e.g. individual USB sends of a Behringer WING, or a webcam mic)
and exposes each as its own **virtual microphone** (`Audio/Source`) that apps
(Chrome, OBS, Zoom…) can select. It shows live VU meters, faders (with boost),
routing, and a wizard to add channels. Dark, adaptive UI (English), reachable
from a phone on the LAN with a PIN.

## Run / stop

```bash
./run.sh                 # creates .venv (system-site-packages for numpy), installs Flask, runs
```
Server listens on **0.0.0.0:8723**. Startup prints a banner with the LAN URL and
a 4-digit **PIN** (localhost is trusted, no PIN; remote needs the PIN).

The **QR** topbar button opens a modal: `/api/netinfo` lists non-loopback IPv4
interfaces (parsed from `ip -o -4 addr show`) so you can pick the right network
(hotspot / Wi-Fi / cable), and `/api/qr?ip=…` returns an SVG QR encoding
`http://<ip>:8723/?pin=<PIN>`. The page's `boot()` reads `?pin=` from the URL,
POSTs `/api/auth`, then strips it via `history.replaceState` → scan-and-connect.
Needs the `qrcode` lib (in `requirements.txt`; `run.sh` installs it). Heads-up:
the SVG is pure black-on-white, but headless Chrome with `--disable-gpu` dims it
because the modal's `backdrop-filter:blur` mis-composites in software — a render
artifact only, real GPU browsers show full contrast.

- **⏹ Stop** (UI) = turn all mics off (nodes removed, channel defs kept → ▶ Start).
- **🗑 Clear** (UI) = remove all channels + mics entirely (`/api/stop`).
- **⏻ Power** (UI) / Ctrl-C / SIGTERM = stop the server **but leave the mic nodes
  running** (detached) so a restart adopts them and apps don't drop / get noise.

## Files

| File | Role |
|------|------|
| `app.py` | Flask API, `Mixer` state, persistence (`state.json`/`presets.json`), restore+adopt, PIN auth, relinker thread, **gate loop**, signal handling |
| `pipewire.py` | All PipeWire interaction: device discovery, `Channel` (create/adopt/remove/reassign, gain, **mute, gate params + envelope**), link graph, orphan cleanup |
| `levels.py` | `LevelMonitor` (per-mic RMS), `ProbeMonitor` (wizard equaliser), `GateMonitor` (per-mic PRE-gain detectors for the gate) — all via explicit-link `pw-record` |
| `static/index.html` `style.css` `app.js` | Frontend (adaptive console, login, wizard, meters, faders, mute, noise-gate + settings popup, link, align, presets, hotkeys, help) |
| `static/test.html` | Standalone page to test a mic in Chrome with audio-processing toggles |
| `test_app.py` | Functional tests: controls→node volume + noise-gate dynamics (`/.venv/bin/python test_app.py`) |
| `run.sh` `requirements.txt` | venv bootstrap + deps |
| `desktop.py` | Windowed entrypoint for the packaged build: runs Flask in a thread, shows the UI in a native **pywebview + Qt WebEngine** window; single-instance attach; close = quit |
| `packaging/` | AppImage build: `build-appimage.sh`, `trim-qt.sh`, `AppRun`, `AudioMixer.desktop`, `icon.svg`/`icon.png` |
| `state.json` / `presets.json` | Persisted channels+master / scene presets (runtime) |
| `mock.html` `tz.txt` | Original design mock + spec (Russian) |

## Architecture

```
Hardware device (e.g. WING USB send)  --pw-link-->  am_cap_<id> (loopback capture, autoconnect=false)
                                                        |  (loopback copies)
                                                        v
                                              am_mic_<id> (Audio/Source)  <-- apps record this
                                                        ^
                                              pw-record (LevelMonitor)  --> RMS --> /api/levels
```

- Each **channel** = one `pw-loopback`: capture side `am_cap_<id>` (we link the
  chosen device port into it), playback side `am_mic_<id>` (mono `Audio/Source`).
- **Applied volume** = `gain × master × gate_level` (or **0** if `muted` or
  `master_muted`), set as `Props { volume }` on `am_mic` via `pw-cli set-param`.
  volume > 1 amplifies (boost), capped at `GAIN_MAX` (+12 dB) / `VOL_MAX`.
  `Mixer.eff_master()` returns 0 when master-muted; **all apply paths use it**.
- **Levels** = a `pw-record` per active mic reading raw PCM; RMS computed in a
  thread; `/api/levels` polled every 80 ms. The frontend maps RMS→% on a dB scale
  with makeup gain (`rmsToPct`), fast-attack/slow-release ballistics.
- **Noise gate** (per channel): a separate PRE-gain `pw-record` detector
  (`GateMonitor`, explicit-link, like the probe) feeds `Mixer._gate_loop` (50 ms),
  which decides open/close (threshold + hysteresis + hold) and ramps the
  `gate_level` envelope (attack/release). Threshold is compared in pre-gain terms
  (`gate / (gain×master)`) because the meter the user sets it against is post-gain.
  Per-channel params: `gate`, `gate_attack`, `gate_hold`, `gate_release`,
  `gate_hyst` — persisted and in presets.
- **Relinker thread** (1.5 s) restores device→capture links after replug, recreates
  a dead loopback, and sets `ch.route_ok` (→ "no_route" vs "no_signal/silent").
- **Persistence/adoption**: loopbacks are started detached (`start_new_session`),
  NOT killed on server shutdown; on startup `restore()` adopts surviving
  `am_mic_*` nodes (same PipeWire object) instead of recreating them.
- **Presets** (scenes): full mix snapshot (gain/mute/gate+params/master/links),
  versioned (`v`) for forward/backward compat; stored in localStorage AND
  `presets.json` (`/api/presets`). Apply glides faders + NG smoothly.

## ⚠️ GOTCHAS (learned the hard way — do not regress)

1. **Use `pw-record`, NOT `parec`.** On the dev system `parec`/`parecord`
   returned no/garbage capture data; native `pw-record` works. All metering uses
   `pw-record`.

2. **`pw-record --target=<name>` is unreliable / does NOT pin.** It silently
   falls back to the default source, and for some targets WirePlumber connects
   the capture stream to *every* source+monitor (so e.g. a mic clap shows up on a
   speaker-monitor probe). For the wizard probe we therefore start the recorder
   with `node.autoconnect=false` + a fixed `node.name` and **explicitly `pw-link`**
   only the wanted device ports. (See `levels._ProbeMeter`.) Targeting the
   real `am_mic_*` source nodes by name DOES work (they're unique real nodes).

3. **`node.autoconnect=false` on the loopback capture side is essential.**
   Without it WirePlumber auto-links the capture to the **default mic**, so every
   channel — especially monitor channels — carries the microphone mixed in.

4. **Cyrillic / spaces in `node.description`** break the SPA props parser
   ("Character not allowed") unless **quoted**: `node.description="..."`. See
   `pipewire._quote`.

5. **VU meter scale is dB, with makeup gain.** Raw RMS is low (speech ≈ −20…−40
   dBFS); a linear meter looks dead. Frontend `rmsToPct` maps dB with
   `METER_GAIN_DB` makeup + fast-attack/slow-release ballistics. The fader is also
   **dB-linear** (`FADER_MIN_DB..FADER_MAX_DB`, up to +12 dB boost).

6. **`applyLevels` must not clobber `className`.** It runs every 80 ms; use
   `setChannelState()` (toggles only `active/muted/clipping/nosignal`) so it
   doesn't wipe `kbsel`/`selected`/`linked` (that caused highlight flicker).

7. **Chrome captures via the PipeWire-Pulse layer** and its WebRTC audio
   processing (noise suppression / AGC / echo cancel) can gate non-voice/system
   audio to silence ~1 s in. That's app-side, not our bug — `static/test.html`
   lets you verify with processing off. Also: if a mic node is destroyed and
   recreated, Chrome keeps the stale handle and gets noise until re-selected —
   which is why we persist/adopt nodes across restarts (#persistence).

8. **Shell footgun:** `pkill -f <pattern>` / `pgrep -f <pattern>` will match the
   wrapping shell command itself if the pattern appears in your command line →
   it kills its own shell (seen as exit code 144). Kill by exact name
   (`pgrep -x pw-record`) or by PID instead.

9. **`setGateVisual` must run AFTER the node is in the DOM.** It uses
   `document.getElementById`, so calling it inside `makeChannel` (before the
   element is appended) does nothing. `renderAll` calls it for every channel
   *after* appending. (Same trap for any post-render visual init.)

10. **Live sends use `throttle`, not `debounce`.** `debounce` waits for movement
    to STOP, so a dragged fader only applied on release. `throttle` (≈45 ms) fires
    immediately and during the drag. Used for volume/master/gate.

11. **Gate threshold is pre-gain-compensated.** The meter shows post-gain level;
    the gate detector measures pre-gain. So the loop compares
    `detector_rms >= gate / (gain × master)`. Don't compare against `gate` directly.

12. **Test pitfall:** `0.0` is falsy in Python — `(node_vol(mic) or 9) == 0.0`
    wrongly yields `9` when volume is correctly 0. Use `v = node_vol(mic); v is not
    None and v == 0.0`.

## Tests

```bash
.venv/bin/python test_app.py     # best with the server stopped
```
Two suites against the real implementation: **controls** (HTTP endpoints via Flask
test client → verify actual PipeWire node volume for volume/mute/master/master-mute/
gate-envelope/persist/presets/remove) and **gate** (real `_gate_loop` driven by a
scripted level → threshold/attack/hold/release/hysteresis). It redirects
`app.STATE_FILE`/`app.PRESETS_FILE` to temp files (your real ones are untouched) and
creates+removes one throwaway channel. It deliberately does NOT call
`cleanup_orphans`/`kill_stray_meters` (those would kill a running server's nodes).

## Testing the UI visually (no browser in the agent)

`chromium-browser` is a snap stub (not installed); Google **Chrome via flatpak**
works for headless screenshots, but it's sandboxed and **can't reach `localhost`**.
Render a self-contained preview (inline the real `static/style.css` + representative
DOM) to a file and screenshot it:

```bash
flatpak run --filesystem=home com.google.Chrome --headless=new --no-sandbox \
  --hide-scrollbars --force-device-scale-factor=1 --window-size=1180,560 \
  --virtual-time-budget=3000 --run-all-compositor-stages-before-draw \
  --screenshot="$HOME/shot.png" "file:///home/<user>/preview.html"
```
Then read the PNG. Use a larger `--virtual-time-budget` so entrance animations
settle. Mobile layout triggers below 640 px CSS width (device-scale-factor affects
effective width).

## Testing PipeWire logic safely

The user's live server runs on 8723 with real channels — don't disrupt it. Test
`pipewire.Channel` logic directly with a throwaway high id (e.g. 9100) via the
`.venv` python, and clean up (`ch.stop()`); verify with `pw-dump Node` /
`pw-link -l`. Don't fight the port.

## Packaging (AppImage)

`bash packaging/build-appimage.sh` → `AudioMixer-x86_64.AppImage` (~202 MB):
bundled portable Python + Flask/numpy/qrcode + **pywebview/Qt WebEngine** native
window; host `pw-*` used (not bundled). Full build details, trim rationale and the
per-gotcha notes live in **`packaging/NOTES.md`** (kept out of here so it isn't
loaded into context every turn). Quick UI check without a browser:
`packaging/qt-smoke.py` (offscreen QtWebEngine render of `static/`).

## Frontend vs backend changes — what needs what

- **`static/*` (HTML/CSS/JS)** are served fresh from disk → a **hard browser
  refresh** (Ctrl+Shift+R) is enough.
- **`*.py`** are loaded at process start → require a **server restart** to apply.

## Conventions

- Node names: `am_mic_<id>` (the source apps see), `am_cap_<id>` (loopback capture).
- Comments: concise, explain the *why* (especially the gotchas above).
- Keep the UI English; the spec/mock and user comms are Russian.
- See `BACKLOG.md` for deferred ideas (master→meter coupling, long peak-hold,
  Flatpak packaging).
