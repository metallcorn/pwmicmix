"""AudioMixer — real-time monitoring & control of PipeWire virtual microphones.

Flask HTTP API + static console UI. Run via ./run.sh (sets up the venv) or:

    .venv/bin/python app.py
"""

from __future__ import annotations

import json
import os
import secrets
import signal
import socket
import subprocess
import threading
import time

from flask import Flask, jsonify, request, send_from_directory, session

import pipewire as pw
from levels import LevelMonitor, ProbeMonitor, GateMonitor

HERE = os.path.dirname(os.path.abspath(__file__))
# Persisted state lives next to the source by default (dev), but a packaged build
# (AppImage) is mounted read-only, so AUDIOMIXER_DATA redirects it to a writable
# dir (e.g. ~/.config/AudioMixer). Unset → identical to the original behaviour.
DATA_DIR = os.environ.get("AUDIOMIXER_DATA", HERE)
os.makedirs(DATA_DIR, exist_ok=True)
STATE_FILE = os.path.join(DATA_DIR, "state.json")
PRESETS_FILE = os.path.join(DATA_DIR, "presets.json")
STATIC_DIR = os.path.join(HERE, "static")
PORT = 8723
# AppRun sets this for the packaged (AppImage) build: it changes how the UI
# offers to stop/restart (no terminal) and the wording of the "stopped" screen.
PACKAGED = bool(os.environ.get("AUDIOMIXER_PACKAGED"))


def _find_free_port(start: int, span: int = 20) -> int:
    """First free TCP port at/above `start` — so a busy 8723 (another app, or a
    stale instance) falls through to a neighbour instead of crashing on launch."""
    for p in range(start, start + span):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("0.0.0.0", p))
                return p
            except OSError:
                continue
    return start

app = Flask(__name__, static_folder=None)
app.secret_key = secrets.token_hex(32)

# A 4-digit PIN guards access from other machines on the network. Connections
# from localhost are trusted and never prompted.
ACCESS_PIN = f"{secrets.randbelow(10000):04d}"
LOCAL_ADDRS = {"127.0.0.1", "::1", "localhost"}


def _lan_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def _ipv4_interfaces():
    """All non-loopback IPv4 interfaces: [{name, ip}] (for the phone QR picker)."""
    try:
        out = subprocess.run(["ip", "-o", "-4", "addr", "show"],
                             capture_output=True, text=True, timeout=3).stdout
    except Exception:
        return []
    res = []
    for ln in out.splitlines():
        p = ln.split()
        if len(p) >= 4 and p[2] == "inet":
            ip = p[3].split("/")[0]
            if not ip.startswith("127."):
                res.append({"name": p[1], "ip": ip})
    return res


def _is_authed() -> bool:
    if request.remote_addr in LOCAL_ADDRS:
        return True
    return session.get("ok") is True


@app.get("/api/netinfo")
def api_netinfo():
    """Network interfaces + PIN + port, so the UI can build a phone QR/link."""
    return jsonify({"pin": ACCESS_PIN, "port": PORT, "packaged": PACKAGED,
                    "default": _lan_ip(), "interfaces": _ipv4_interfaces()})


@app.get("/api/qr")
def api_qr():
    """SVG QR code for http://<ip>:<port>/?pin=<PIN> (scanning auto-connects)."""
    ip = (request.args.get("ip") or _lan_ip()).strip()
    url = f"http://{ip}:{PORT}/?pin={ACCESS_PIN}"
    try:
        import qrcode
    except Exception:
        return jsonify({"error": "qrcode_not_installed", "url": url}), 503
    qr = qrcode.QRCode(border=3, box_size=1)
    qr.add_data(url); qr.make(fit=True)
    m = qr.get_matrix(); n = len(m); box = 8; size = n * box
    rects = "".join(f'<rect x="{x * box}" y="{y * box}" width="{box}" height="{box}"/>'
                    for y, row in enumerate(m) for x, v in enumerate(row) if v)
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" '
           f'viewBox="0 0 {size} {size}" shape-rendering="crispEdges">'
           f'<rect width="{size}" height="{size}" fill="#fff"/>'
           f'<g fill="#000">{rects}</g></svg>')
    return app.response_class(svg, mimetype="image/svg+xml")


@app.before_request
def _gate():
    path = request.path
    if path.startswith("/api/") and path != "/api/auth" and path != "/api/ping":
        if not _is_authed():
            return jsonify({"error": "auth_required"}), 401


@app.post("/api/auth")
def api_auth():
    body = request.get_json(force=True, silent=True) or {}
    if str(body.get("pin", "")) == ACCESS_PIN:
        session["ok"] = True
        session.permanent = True
        return jsonify({"ok": True})
    return jsonify({"ok": False, "error": "bad_pin"}), 401


@app.get("/api/ping")
def api_ping():
    """Lightweight auth probe used by the client on load."""
    return jsonify({"authed": _is_authed()})


class Mixer:
    """Owns all channels, the master gain, the level monitor and persistence."""

    def __init__(self):
        self.channels: dict[int, pw.Channel] = {}
        self.master = 1.0
        self.master_muted = False
        self.next_id = 1
        self.lock = threading.RLock()
        self.monitor = LevelMonitor()
        self.gate_mon = GateMonitor()
        self._relink_stop = threading.Event()
        self._relink_thread: threading.Thread | None = None
        self._gate_thread: threading.Thread | None = None

    def eff_master(self) -> float:
        """Master gain actually applied — 0 when the master is muted."""
        return 0.0 if self.master_muted else self.master

    def _refresh_solo_locked(self) -> None:
        """If any active channel is soloed, silence the rest; then re-apply every
        channel's gain. Caller must hold self.lock."""
        any_solo = any(c.solo for c in self.channels.values() if c.active)
        for c in self.channels.values():
            c.muted_by_solo = any_solo and not c.solo
            c._apply_gain(self.eff_master())

    # -- noise gate: open/close each gated channel from its PRE-gain input ---- #
    def start_gate(self) -> None:
        if self._gate_thread:
            return
        self._gate_thread = threading.Thread(target=self._gate_loop, daemon=True)
        self._gate_thread.start()

    def _gate_loop(self) -> None:
        DT = 0.05    # loop period (s)
        while not self._relink_stop.wait(DT):
            with self.lock:
                gated = [c for c in self.channels.values() if c.active and c.gate > 0]
            self.gate_mon.sync({c.mic_id: (c.device, [c.port]) for c in gated})
            now = time.monotonic()
            for c in gated:
                rms = self.gate_mon.level(c.mic_id)          # PRE-gain input level
                # threshold is set on the (post-gain) display meter, so compare in
                # pre-gain terms: divide out the channel's gain × master
                denom = max(1e-4, c.gain * self.master)
                thr = c.gate / denom
                close_thr = thr * (10 ** (-c.gate_hyst / 20))   # hysteresis
                if rms >= thr:
                    c.gate_last_above = now
                    c.gate_open = True
                elif rms < close_thr and now - c.gate_last_above > c.gate_hold:
                    c.gate_open = False
                # smooth envelope toward the open/closed target (attack / release)
                target = 1.0 if c.gate_open else 0.0
                if c.gate_level != target:
                    rate = DT / max(0.005, c.gate_attack if target > c.gate_level else c.gate_release)
                    c.gate_level = (min(1.0, c.gate_level + rate) if target > c.gate_level
                                    else max(0.0, c.gate_level - rate))
                    try:
                        c._apply_gain(self.eff_master())
                    except Exception:
                        pass

    # -- resilience: restore routing after a device is unplugged/replugged --- #
    def start_relinker(self) -> None:
        if self._relink_thread:
            return
        self._relink_thread = threading.Thread(target=self._relink_loop, daemon=True)
        self._relink_thread.start()

    def _relink_loop(self) -> None:
        while not self._relink_stop.wait(1.5):
            with self.lock:
                active = [c for c in self.channels.values() if c.active]
            if not active:
                continue
            # recreate any loopback that died (owned process gone, or adopted
            # node disappeared)
            try:
                alive = pw.existing_mic_nodes()
            except Exception:
                alive = None
            for ch in active:
                dead = (ch.proc.poll() is not None) if ch.proc else (
                    alive is not None and ch.mic_id not in alive)
                if dead:
                    try:
                        ch.start()
                        ch.set_gain(ch.gain, self.eff_master())
                        self.monitor.add(ch.mic_id, ch.mic_id)
                    except Exception:
                        pass
            try:
                outs, links = pw.graph_state()
            except Exception:
                continue
            for ch in active:
                try:
                    ch.route_ok = f"{ch.device}:{ch.port}" in outs
                    ch.ensure_links(outs, links)
                except Exception:
                    pass

    # -- persistence ------------------------------------------------------ #
    def save(self) -> None:
        with self.lock:
            data = {
                "master": self.master,
                "master_muted": self.master_muted,
                "next_id": self.next_id,
                "channels": [c.to_dict() for c in self.channels.values()],
            }
        try:
            with open(STATE_FILE, "w") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
        except OSError:
            pass

    def restore(self) -> None:
        # Always clear leftover meter processes from a previous run.
        pw.kill_stray_meters()
        if not os.path.exists(STATE_FILE):
            pw.cleanup_orphans(set())
            return
        try:
            with open(STATE_FILE) as f:
                data = json.load(f)
        except (OSError, ValueError):
            pw.cleanup_orphans(set())
            return
        self.master = data.get("master", 1.0)
        self.master_muted = data.get("master_muted", False)
        self.next_id = data.get("next_id", 1)
        chans = data.get("channels", [])
        # Keep the nodes of active channels alive across restart so we can adopt
        # them (apps keep their selection); kill everything else stray.
        keep = set()
        for d in chans:
            if d.get("active", True):
                keep.add(f"{pw.VIRT_PREFIX}{d['id']}")
                keep.add(f"{pw.CAP_PREFIX}{d['id']}")
        pw.cleanup_orphans(keep)
        existing = pw.existing_mic_nodes()
        for d in chans:
            ch = pw.Channel.from_dict(d)
            self.channels[ch.id] = ch
            if ch.active:
                if ch.mic_id in existing:
                    ch.adopt(self.eff_master())        # node survived restart — reuse it
                else:
                    ch.start()
                    ch.set_gain(ch.gain, self.eff_master())
                self.monitor.add(ch.mic_id, ch.mic_id)
        self._refresh_solo_locked()   # honour any persisted solo state

    # -- helpers ---------------------------------------------------------- #
    def _by_mic(self, mic_id: str) -> pw.Channel | None:
        return next((c for c in self.channels.values() if c.mic_id == mic_id), None)

    def channels_payload(self) -> list[dict]:
        with self.lock:
            return [c.to_dict() for c in sorted(self.channels.values(),
                                                key=lambda c: c.id)]


mixer = Mixer()

# Separate monitor used only by the add/reassign wizard to show a live
# "is there sound on this device" equaliser behind each device in the list.
prober = ProbeMonitor()


# --------------------------------------------------------------------------- #
# Static UI
# --------------------------------------------------------------------------- #

@app.get("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.get("/<path:path>")
def static_files(path):
    return send_from_directory(STATIC_DIR, path)


# --------------------------------------------------------------------------- #
# API
# --------------------------------------------------------------------------- #

@app.get("/api/devices")
def api_devices():
    return jsonify(pw.list_devices())


@app.post("/api/probe")
def api_probe_start():
    """Begin (or update) live level probing of the given device node names.

    Body: { devices: [node_name, ...] }. Meters not in the list are stopped.
    Each device is metered by explicitly linking its output ports, so the
    reading reflects that device alone (no cross-device bleed).
    """
    body = request.get_json(force=True)
    ids = set(d for d in body.get("devices", []) if isinstance(d, str))
    devmap = {d["id"]: d for d in pw.list_devices()}
    targets = {i: [p["id"] for p in devmap[i]["ports"]] for i in ids if i in devmap}
    prober.sync(targets)
    return jsonify({"ok": True})


@app.get("/api/probe")
def api_probe_levels():
    """Current level (0..1) per probed device; silence -> 0.0."""
    out = {}
    for dev, val in prober.levels().items():
        out[dev] = val if isinstance(val, (int, float)) else 0.0
    return jsonify(out)


@app.post("/api/probe/stop")
def api_probe_stop():
    prober.stop_all()
    return jsonify({"ok": True})


@app.get("/api/presets")
def api_presets_get():
    """Scene presets, stored in presets.json (the client also caches them in
    localStorage). Returns whatever the client last saved."""
    try:
        with open(PRESETS_FILE) as f:
            return jsonify(json.load(f))
    except (OSError, ValueError):
        return jsonify([])


@app.post("/api/presets")
def api_presets_set():
    data = request.get_json(force=True)
    try:
        with open(PRESETS_FILE, "w") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
    except OSError:
        pass
    return jsonify({"ok": True})


@app.get("/api/channels")
def api_channels():
    return jsonify({"channels": mixer.channels_payload(),
                    "master": round(mixer.master, 4),
                    "master_muted": mixer.master_muted,
                    "packaged": PACKAGED,
                    "running": any(c.active for c in mixer.channels.values())})


@app.post("/api/start")
def api_start():
    """Create one or more channels from a device.

    Body: { device, device_name, channels: [{port, port_label, name}] }
    """
    body = request.get_json(force=True)
    device = body["device"]
    device_name = body.get("device_name", device)
    created = []
    with mixer.lock:
        for spec in body.get("channels", []):
            cid = mixer.next_id
            mixer.next_id += 1
            ch = pw.Channel(
                cid,
                spec.get("name") or f"Mic {cid}",
                device, spec["port"],
                device_name, spec.get("port_label", spec["port"]),
                gain=spec.get("gain", 0.75),
            )
            mixer.channels[cid] = ch
            ch.start()
            ch.set_gain(ch.gain, mixer.eff_master())
            mixer.monitor.add(ch.mic_id, ch.mic_id)
            created.append(ch.to_dict())
    mixer.save()
    return jsonify({"created": created})


@app.get("/api/levels")
def api_levels():
    levels = mixer.monitor.levels()
    # overlay channel state: muted / off / no_route take priority over the raw
    # meter value ("no_signal" from the monitor means routed-but-silent).
    with mixer.lock:
        for c in mixer.channels.values():
            if not c.active:
                levels[c.mic_id] = "off"
            elif c.muted or c.muted_by_solo:
                levels[c.mic_id] = "muted"
            elif not c.route_ok:
                levels[c.mic_id] = "no_route"
        active_vals = [v for v in levels.values() if isinstance(v, (int, float))]
    master_level = max(active_vals) if active_vals else 0.0
    return jsonify({"levels": levels, "master": round(master_level, 4)})


@app.post("/api/volume")
def api_volume():
    body = request.get_json(force=True)
    mic_id = body["mic_id"]
    gain = float(body["gain"])
    with mixer.lock:
        ch = mixer._by_mic(mic_id)
        if not ch:
            return jsonify({"error": "unknown mic"}), 404
        ch.set_gain(gain, mixer.eff_master())
    mixer.save()
    return jsonify({"ok": True, "gain": round(ch.gain, 4)})


@app.post("/api/mute")
def api_mute():
    body = request.get_json(force=True)
    with mixer.lock:
        ch = mixer._by_mic(body["mic_id"])
        if not ch:
            return jsonify({"error": "unknown mic"}), 404
        ch.muted = bool(body.get("muted", not ch.muted))
        ch._apply_gain(mixer.eff_master())
    mixer.save()
    return jsonify({"ok": True, "muted": ch.muted})


@app.post("/api/solo")
def api_solo():
    """Solo one or more channels. Soloing a channel clears its mute (and never
    restores it). Body: `ids` (or single `mic_id`) + optional `solo` bool; if
    `solo` is omitted the group is toggled as one."""
    body = request.get_json(force=True)
    ids = body.get("ids") or ([body["mic_id"]] if "mic_id" in body else [])
    with mixer.lock:
        targets = [c for c in (mixer._by_mic(i) for i in ids) if c]
        if not targets:
            return jsonify({"error": "unknown mic"}), 404
        solo = body.get("solo")
        if solo is None:
            solo = not all(c.solo for c in targets)   # toggle group as one
        solo = bool(solo)
        for c in targets:
            c.solo = solo
            if solo:
                c.muted = False        # solo clears mute (not restored on un-solo)
        mixer._refresh_solo_locked()
    mixer.save()
    return jsonify({"ok": True, "solo": {c.mic_id: c.solo for c in targets}})


@app.post("/api/gate")
def api_gate():
    """Set noise-gate params for a channel. Any of: threshold (RMS 0..1; 0 off),
    attack, hold, release (seconds), hyst (dB). Optional `apply_to`: list of other
    mic_ids to copy the same gate settings onto (all / linked group)."""
    body = request.get_json(force=True)
    with mixer.lock:
        ch = mixer._by_mic(body["mic_id"])
        if not ch:
            return jsonify({"error": "unknown mic"}), 404

        def set_cfg(c, with_threshold):
            if with_threshold and "threshold" in body:
                c.gate = max(0.0, min(1.0, float(body["threshold"])))
            if "attack" in body: c.gate_attack = max(0.0, min(1.0, float(body["attack"])))
            if "hold" in body: c.gate_hold = max(0.0, min(5.0, float(body["hold"])))
            if "release" in body: c.gate_release = max(0.0, min(3.0, float(body["release"])))
            if "hyst" in body: c.gate_hyst = max(0.0, min(36.0, float(body["hyst"])))
            if c.gate == 0:
                c.gate_open = True; c.gate_level = 1.0; c._apply_gain(mixer.eff_master())

        set_cfg(ch, True)
        # copy gate SHAPE (attack/hold/release/hyst) to others; each channel keeps
        # its own threshold (it depends on that mic's level)
        for oid in body.get("apply_to", []):
            oc = mixer._by_mic(oid)
            if oc and oc is not ch:
                set_cfg(oc, False)
    mixer.save()
    return jsonify({"ok": True, "gate": round(ch.gate, 5), "attack": ch.gate_attack,
                    "hold": ch.gate_hold, "release": ch.gate_release, "hyst": ch.gate_hyst})


@app.post("/api/master")
def api_master():
    body = request.get_json(force=True)
    mixer.master = max(0.0, min(pw.GAIN_MAX, float(body["gain"])))
    with mixer.lock:
        for ch in mixer.channels.values():
            ch._apply_gain(mixer.eff_master())
    mixer.save()
    return jsonify({"ok": True, "master": round(mixer.master, 4)})


@app.post("/api/master_mute")
def api_master_mute():
    """Global mute — forces every channel's output to 0 without touching their
    individual gains/mutes."""
    body = request.get_json(force=True)
    mixer.master_muted = bool(body.get("muted", not mixer.master_muted))
    with mixer.lock:
        for ch in mixer.channels.values():
            ch._apply_gain(mixer.eff_master())
    mixer.save()
    return jsonify({"ok": True, "master_muted": mixer.master_muted})


@app.post("/api/toggle")
def api_toggle():
    body = request.get_json(force=True)
    mic_id = body["mic_id"]
    with mixer.lock:
        ch = mixer._by_mic(mic_id)
        if not ch:
            return jsonify({"error": "unknown mic"}), 404
        want = bool(body.get("active", not ch.active))
        if want and not ch.active:
            ch.start()
            ch.set_gain(ch.gain, mixer.eff_master())
            mixer.monitor.add(ch.mic_id, ch.mic_id)
        elif not want and ch.active:
            mixer.monitor.remove(ch.mic_id)
            ch.stop()
    mixer.save()
    return jsonify({"ok": True, "active": ch.active})


@app.post("/api/rename")
def api_rename():
    body = request.get_json(force=True)
    with mixer.lock:
        ch = mixer._by_mic(body["mic_id"])
        if not ch:
            return jsonify({"error": "unknown mic"}), 404
        ch.name = (body.get("name") or ch.name).strip() or ch.name
    mixer.save()
    return jsonify({"ok": True, "name": ch.name})


@app.post("/api/reassign")
def api_reassign():
    body = request.get_json(force=True)
    with mixer.lock:
        ch = mixer._by_mic(body["mic_id"])
        if not ch:
            return jsonify({"error": "unknown mic"}), 404
        ch.reassign(body["new_device"], body["new_port"],
                    body.get("new_device_name", body["new_device"]),
                    body.get("new_port_label", body["new_port"]))
    mixer.save()
    return jsonify({"ok": True, "channel": ch.to_dict()})


@app.post("/api/remove")
def api_remove():
    body = request.get_json(force=True)
    mic_id = body["mic_id"]
    with mixer.lock:
        ch = mixer._by_mic(mic_id)
        if not ch:
            return jsonify({"error": "unknown mic"}), 404
        mixer.monitor.remove(ch.mic_id)
        ch.stop()
        del mixer.channels[ch.id]
    mixer.save()
    return jsonify({"ok": True})


@app.post("/api/engine")
def api_engine():
    """Start or stop the whole engine without touching channel definitions.

    Body: { active: bool }. When stopping, every virtual mic node is removed
    from the system but its config is kept (active=false), so /api/engine
    {active:true} can recreate them later. The HTTP server keeps running either
    way — it is the control surface.
    """
    body = request.get_json(force=True)
    want = bool(body.get("active"))
    with mixer.lock:
        for ch in mixer.channels.values():
            if want and not ch.active:
                ch.start()
                ch.set_gain(ch.gain, mixer.eff_master())
                mixer.monitor.add(ch.mic_id, ch.mic_id)
            elif not want and ch.active:
                mixer.monitor.remove(ch.mic_id)
                ch.stop()
        running = any(c.active for c in mixer.channels.values())
    mixer.save()
    return jsonify({"ok": True, "running": running,
                    "channels": mixer.channels_payload()})


@app.post("/api/stop")
def api_stop():
    """Remove ALL virtual microphones and their definitions (full clear)."""
    with mixer.lock:
        mixer.monitor.stop_all()
        for ch in list(mixer.channels.values()):
            ch.stop()
        mixer.channels.clear()
    mixer.save()
    return jsonify({"ok": True})


@app.post("/api/shutdown")
def api_shutdown():
    """Gracefully stop the whole server.

    Channels are persisted (so the next launch restores them); the SIGTERM
    handler tears down the live PipeWire nodes before the process exits. The
    signal is raised from a short-lived thread so this HTTP response reaches
    the browser first.
    """
    def _later():
        time.sleep(0.3)
        os.kill(os.getpid(), signal.SIGTERM)

    threading.Thread(target=_later, daemon=True).start()
    return jsonify({"ok": True, "shutdown": True})


@app.post("/api/restart")
def api_restart():
    """Re-exec the server in place (no terminal needed for the packaged build).

    Like ⏻ shutdown, the virtual-mic loopbacks stay running (detached) and the
    fresh process adopts them — so apps don't drop. The browser tab reconnects
    on its own via the connection watchdog (localhost needs no re-auth).
    """
    import sys

    def _later():
        time.sleep(0.3)
        _teardown()
        env = dict(os.environ)
        env.pop("AUDIOMIXER_OPEN_BROWSER", None)   # don't spawn a second browser tab
        os.execve(sys.executable, [sys.executable, *sys.argv], env)

    threading.Thread(target=_later, daemon=True).start()
    return jsonify({"ok": True, "restart": True})


def _teardown():
    # Stop our own helper processes/threads, but LEAVE the virtual-mic loopbacks
    # running (detached) so a restart can adopt them and apps don't lose the
    # device / get noise. Mics are removed only via ⏹ Stop or ✕.
    mixer._relink_stop.set()
    prober.stop_all()
    mixer.gate_mon.stop_all()
    mixer.monitor.stop_all()


def boot_server():
    """Pick a free port, adopt surviving mic nodes, start the helper threads.
    Shared by the CLI (__main__) and the windowed desktop entrypoint (desktop.py)
    so both bring the server up identically."""
    global PORT
    PORT = _find_free_port(PORT)   # fall through to a neighbour if 8723 is busy
    mixer.restore()                # adopts surviving mic nodes; clears true orphans
    mixer.start_relinker()         # auto-restore routing across device replug
    mixer.start_gate()             # noise-gate controller


if __name__ == "__main__":
    import sys

    boot_server()

    def _on_signal(*_):
        _teardown()
        sys.exit(0)

    signal.signal(signal.SIGTERM, _on_signal)   # SIGINT is handled via the finally below

    ip = _lan_ip()
    rows = [
        ("On this computer", f"http://localhost:{PORT}"),
        ("From your phone", f"http://{ip}:{PORT}"),
        ("", ""),
        ("PIN for remote access", ACCESS_PIN),
    ]
    lines = ["AudioMixer is running", ""]
    for k, v in rows:
        lines.append("" if not k else f"{k}:  {v}")
    width = max(len(s) for s in lines) + 2
    bar = "─" * (width + 2)
    print(f"\n┌{bar}┐")
    for s in lines:
        print(f"│  {s.ljust(width)}│")
    print(f"└{bar}┘\n")

    # A packaged build (AppImage) launched from a desktop icon has no terminal,
    # so open the UI in the browser once the server is up. Gated by an env flag
    # set by AppRun — running from source prints the banner as before.
    if os.environ.get("AUDIOMIXER_OPEN_BROWSER"):
        import threading, webbrowser
        threading.Timer(1.2, lambda: webbrowser.open(f"http://localhost:{PORT}")).start()

    try:
        app.run(host="0.0.0.0", port=PORT, threaded=True, debug=False)
    finally:
        _teardown()
