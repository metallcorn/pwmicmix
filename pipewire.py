"""PipeWire interaction layer for the AudioMixer tool.

Responsibilities:
  * discover real capture devices (hardware sources + sink monitors) and their ports
  * create / remove / reassign virtual microphones (pw-loopback + pw-link)
  * apply software gain (pw-cli set-param Props)

On this system ``pw-record`` is the reliable capture tool (``parec`` returns no
data), so the level monitor uses pw-record; node creation/routing here uses the
native pw-* utilities exclusively.
"""

from __future__ import annotations

import json
import subprocess
import time

# Naming conventions for the nodes we own, so we can recognise and skip them
# during device discovery.
VIRT_PREFIX = "am_mic_"   # node.name of the virtual Audio/Source apps select
CAP_PREFIX = "am_cap_"    # node.name of the loopback capture side we link into

# Software gain allows boost above unity (PipeWire amplifies at volume > 1).
GAIN_MAX = 4.0            # per-channel cap (~+12 dB)
VOL_MAX = 8.0             # final (channel × master) cap (~+18 dB), safety limit


def _run(cmd, timeout=8):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


# --------------------------------------------------------------------------- #
# Device discovery
# --------------------------------------------------------------------------- #

def _port_label(port_name: str, channel: str | None, kind: str) -> str:
    """Human-readable Russian label for a port."""
    ch = (channel or "").upper()
    side = {"FL": "левый", "FR": "правый", "MONO": "моно"}.get(ch)
    if kind == "monitor":
        side = {"FL": "лево", "FR": "право", "MONO": "моно"}.get(ch, ch)
    if side and ch != "MONO":
        return f"{side} ({ch})"
    if side:
        return side
    return port_name


def list_devices() -> list[dict]:
    """Enumerate selectable capture devices.

    Returns a list of dicts: {id, name, kind, sub, ports:[{id,label,channel}]}.
    ``id`` is the PipeWire node.name (used as a pw-record/pw-link target).
    Hardware Audio/Source nodes are exposed directly; Audio/Sink nodes are
    exposed via their monitor ports.
    """
    data = json.loads(_run(["pw-dump"]).stdout)

    ports: dict[int, list[dict]] = {}
    for o in data:
        if not o.get("type", "").endswith("Port"):
            continue
        pr = o.get("info", {}).get("props", {})
        ports.setdefault(pr.get("node.id"), []).append({
            "name": pr.get("port.name"),
            "channel": pr.get("audio.channel"),
            "direction": pr.get("port.direction"),
        })

    devices = []
    for o in data:
        if not o.get("type", "").endswith("Node"):
            continue
        pr = o.get("info", {}).get("props", {})
        name = pr.get("node.name", "")
        mc = pr.get("media.class", "")
        if name.startswith(VIRT_PREFIX) or name.startswith(CAP_PREFIX):
            continue  # one of ours
        if mc == "Audio/Source":
            kind = "source"
        elif mc == "Audio/Sink":
            kind = "monitor"
        else:
            continue
        outs = [p for p in ports.get(o["id"], []) if p["direction"] == "out"]
        if not outs:
            continue
        desc = pr.get("node.description") or pr.get("node.nick") or name
        sub = "монитор колонок" if kind == "monitor" else _device_sub(pr, len(outs))
        devices.append({
            "id": name,
            "name": desc,
            "kind": kind,
            "sub": sub,
            "ports": [{
                "id": p["name"],
                "label": _port_label(p["name"], p["channel"], kind),
                "channel": p["channel"],
            } for p in outs],
        })
    # Hardware sources first, monitors last; stable by name otherwise.
    devices.sort(key=lambda d: (d["kind"] != "source", d["name"]))
    return devices


def _device_sub(pr: dict, nports: int) -> str:
    bus = (pr.get("device.api") or pr.get("api.alsa.path") or "").upper()
    bus = "USB" if "usb" in (pr.get("node.name", "")) else bus.split(":")[0] or "ALSA"
    word = "канал" if nports == 1 else ("канала" if 2 <= nports <= 4 else "каналов")
    return f"{bus} · {nports} {word}"


# --------------------------------------------------------------------------- #
# Node id resolution & links
# --------------------------------------------------------------------------- #

def node_id(node_name: str) -> int | None:
    """Resolve a PipeWire global id for a node.name (or None)."""
    data = json.loads(_run(["pw-dump", "Node"]).stdout)
    for o in data:
        if o.get("info", {}).get("props", {}).get("node.name") == node_name:
            return o["id"]
    return None


def _capture_ready(cap_node: str, timeout=4.0) -> list[str]:
    """Wait until the loopback capture-side input ports exist; return them."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        out = _run(["pw-link", "-i"]).stdout
        inputs = [ln.strip() for ln in out.splitlines()
                  if ln.strip().startswith(cap_node + ":")]
        if inputs:
            return inputs
        time.sleep(0.1)
    return []


def _link(src_port: str, dst_port: str) -> bool:
    r = _run(["pw-link", src_port, dst_port])
    return r.returncode == 0


def _unlink(src_port: str, dst_port: str) -> None:
    _run(["pw-link", "-d", src_port, dst_port])


def graph_state():
    """Snapshot the current PipeWire link graph.

    Returns (output_ports, links) where output_ports is a set of "node:port"
    strings that currently exist as outputs, and links is a set of
    (src_port, dst_port) tuples. Used by the relinker to restore routing after
    a device is unplugged and plugged back in.
    """
    outs: set[str] = set()
    links: set[tuple[str, str]] = set()
    cur = None
    for raw in _run(["pw-link", "-l"]).stdout.splitlines():
        if not raw[:1].isspace():
            cur = raw.strip()
        else:
            t = raw.strip()
            if t.startswith("|->") and cur:
                links.add((cur, t[3:].strip()))
            elif t.startswith("|<-") and cur:
                links.add((t[3:].strip(), cur))
    for raw in _run(["pw-link", "-o"]).stdout.splitlines():
        s = raw.strip()
        if s:
            outs.add(s)
    return outs, links


# --------------------------------------------------------------------------- #
# Channel = one virtual microphone
# --------------------------------------------------------------------------- #

class Channel:
    """One virtual microphone: a pw-loopback whose capture side is linked to a
    chosen hardware port, exposing a mono Audio/Source apps can record from."""

    def __init__(self, cid: int, name: str, device: str, port: str,
                 src_label: str, port_label: str, gain: float = 0.75):
        self.id = cid
        self.mic_id = f"{VIRT_PREFIX}{cid}"
        self.cap_node = f"{CAP_PREFIX}{cid}"
        self.name = name
        self.device = device          # source node.name we record/route from
        self.port = port              # port.name on that device (e.g. capture_FL)
        self.src_label = src_label
        self.port_label = port_label
        self.gain = gain
        self.active = True
        self.proc: subprocess.Popen | None = None
        self.node_id: int | None = None
        # noise gate: send audio only when the input RMS is >= gate (0 = off).
        self.gate = 0.0          # threshold (RMS 0..1); 0 disables gating
        self.gate_attack = 0.010   # s — fade-in when opening
        self.gate_hold = 0.350     # s — stay open after dropping below threshold
        self.gate_release = 0.150  # s — fade-out when closing
        self.gate_hyst = 6.0       # dB — close threshold is this far below open
        self.gate_open = True    # decision state (driven by GateController)
        self.gate_level = 1.0    # smoothed envelope 0..1 (what's actually applied)
        self.gate_last_above = 0.0
        self.muted = False       # mute = volume 0 but node stays alive
        self.solo = False        # solo = keep audible; silences non-soloed channels
        self.muted_by_solo = False  # transient: another channel is soloed, this one isn't
        self.route_ok = True     # is the source device port currently present?

    # -- lifecycle -------------------------------------------------------- #
    def start(self) -> None:
        """Spawn the loopback, route the hardware port in, apply gain."""
        self.proc = subprocess.Popen([
            "pw-loopback",
            # node.autoconnect=false is essential: without it WirePlumber
            # auto-links this capture stream to the default source (the mic),
            # so every channel — especially monitor channels — would carry the
            # microphone mixed in on top of the port we explicitly link.
            f"--capture-props=node.name={self.cap_node} node.autoconnect=false",
            "--playback-props="
            f"media.class=Audio/Source node.name={self.mic_id} "
            f"node.description={_quote(self.name)} "
            "audio.channels=1 audio.position=[MONO]",
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
           start_new_session=True)   # detach so the node survives a server restart

        inputs = _capture_ready(self.cap_node)
        # Feed the chosen hardware port into every capture input (FL+FR) so the
        # mono downmix keeps full level.
        for dst in inputs:
            _link(f"{self.device}:{self.port}", dst)
        self.active = True
        self._resolve_and_apply_gain()

    def is_alive(self) -> bool:
        if self.proc is not None:
            return self.proc.poll() is None
        return node_id(self.mic_id) is not None   # adopted node (no owned process)

    def adopt(self, master: float = 1.0) -> None:
        """Take over an already-running loopback node that survived a server
        restart (so apps keep their selection and don't get noise)."""
        self.proc = None
        self.active = True
        self.node_id = node_id(self.mic_id)
        self._apply_gain(master)

    def ensure_links(self, outs, links) -> None:
        """Re-establish the device→capture links if they're missing (e.g. after
        the source device was unplugged and replugged). Idempotent and cheap:
        only acts when the device port exists but the link is gone."""
        if not self.active:
            return
        src = f"{self.device}:{self.port}"
        if src not in outs:
            return  # device not present right now — nothing to do
        for dst in (f"{self.cap_node}:input_FL", f"{self.cap_node}:input_FR"):
            if (src, dst) not in links:
                _link(src, dst)

    def stop(self) -> None:
        """Tear down the loopback (its links die with it)."""
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        else:
            _kill_loopback(self.cap_node)   # adopted/orphaned node — kill by name
        self.proc = None
        self.active = False

    # -- routing ---------------------------------------------------------- #
    def reassign(self, new_device: str, new_port: str,
                 src_label: str, port_label: str) -> None:
        """Re-route the live virtual mic to a new hardware port without
        recreating the node, so apps keep their selection."""
        inputs = [ln.strip() for ln in _run(["pw-link", "-i"]).stdout.splitlines()
                  if ln.strip().startswith(self.cap_node + ":")]
        for dst in inputs:
            _unlink(f"{self.device}:{self.port}", dst)
        self.device, self.port = new_device, new_port
        self.src_label, self.port_label = src_label, port_label
        for dst in inputs:
            _link(f"{self.device}:{self.port}", dst)

    # -- gain ------------------------------------------------------------- #
    def set_gain(self, gain: float, master: float = 1.0) -> None:
        self.gain = max(0.0, min(GAIN_MAX, gain))
        self._apply_gain(master)

    def _resolve_and_apply_gain(self, master: float = 1.0) -> None:
        for _ in range(20):
            self.node_id = node_id(self.mic_id)
            if self.node_id is not None:
                break
            time.sleep(0.1)
        self._apply_gain(master)

    def _apply_gain(self, master: float = 1.0) -> None:
        if self.node_id is None:
            self.node_id = node_id(self.mic_id)
        if self.node_id is None:
            return
        env = self.gate_level if self.gate > 0 else 1.0
        silent = self.muted or self.muted_by_solo
        vol = 0.0 if silent else round(max(0.0, min(VOL_MAX, self.gain * master * env)), 4)
        _run(["pw-cli", "set-param", str(self.node_id), "Props",
              f"{{ volume: {vol} }}"])

    # -- serialisation ---------------------------------------------------- #
    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "mic_id": self.mic_id,
            "name": self.name,
            "device": self.device,
            "port": self.port,
            "src_label": self.src_label,
            "port_label": self.port_label,
            "gain": round(self.gain, 4),
            "active": self.active,
            "gate": round(self.gate, 5),
            "gate_attack": round(self.gate_attack, 4),
            "gate_hold": round(self.gate_hold, 4),
            "gate_release": round(self.gate_release, 4),
            "gate_hyst": round(self.gate_hyst, 2),
            "muted": self.muted,
            "solo": self.solo,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Channel":
        ch = cls(d["id"], d["name"], d["device"], d["port"],
                 d.get("src_label", ""), d.get("port_label", ""),
                 d.get("gain", 0.75))
        ch.active = d.get("active", True)
        ch.gate = float(d.get("gate", 0.0) or 0.0)
        ch.gate_attack = float(d.get("gate_attack", ch.gate_attack))
        ch.gate_hold = float(d.get("gate_hold", ch.gate_hold))
        ch.gate_release = float(d.get("gate_release", ch.gate_release))
        ch.gate_hyst = float(d.get("gate_hyst", ch.gate_hyst))
        ch.muted = bool(d.get("muted", False))
        ch.solo = bool(d.get("solo", False))
        return ch


def _quote(text: str) -> str:
    """Wrap a node.description value in double quotes for the SPA props parser.

    The parser rejects non-ASCII characters in *bare* values ("Character not
    allowed"), but accepts them — and spaces — inside a quoted string. Internal
    double quotes are stripped to keep the token well-formed.
    """
    cleaned = (text or "Mic").replace('"', "").strip() or "Mic"
    return f'"{cleaned}"'


def existing_mic_nodes() -> set[str]:
    """Set of our virtual-mic node names (am_mic_*) currently present in PipeWire."""
    data = json.loads(_run(["pw-dump", "Node"]).stdout)
    out = set()
    for o in data:
        nm = o.get("info", {}).get("props", {}).get("node.name", "")
        if nm.startswith(VIRT_PREFIX):
            out.add(nm)
    return out


def _kill_loopback(name: str) -> None:
    """Kill pw-loopback process(es) whose command references ``name``."""
    import os
    import signal
    out = _run(["pgrep", "-a", "pw-loopback"]).stdout
    for line in out.splitlines():
        parts = line.split(None, 1)
        if len(parts) == 2 and name in parts[1]:
            try:
                os.kill(int(parts[0]), signal.SIGTERM)
            except (ProcessLookupError, ValueError, PermissionError):
                pass


def cleanup_orphans(keep: set[str] | None = None) -> None:
    """Kill stray pw-loopback processes from a previous run, EXCEPT those whose
    nodes we intend to adopt (their cap/mic names are in ``keep``).

    This is what lets virtual mics survive a server restart: matching nodes are
    left running and adopted, so apps (Chrome) never lose them.
    """
    import os
    import signal
    keep = keep or set()
    out = _run(["pgrep", "-a", "pw-loopback"]).stdout
    for line in out.splitlines():
        parts = line.split(None, 1)
        if len(parts) != 2:
            continue
        pid_str, cmd = parts
        if CAP_PREFIX not in cmd and VIRT_PREFIX not in cmd:
            continue
        if any(name in cmd for name in keep):
            continue   # one we want to adopt — leave it alive
        try:
            os.kill(int(pid_str), signal.SIGTERM)
        except (ProcessLookupError, ValueError, PermissionError):
            pass


def kill_stray_meters() -> None:
    """Kill leftover pw-record meter processes from a previous server run."""
    import os
    import signal
    out = _run(["pgrep", "-x", "pw-record"]).stdout
    for pid in out.split():
        try:
            os.kill(int(pid), signal.SIGTERM)
        except (ProcessLookupError, ValueError, PermissionError):
            pass
