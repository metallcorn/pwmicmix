#!/usr/bin/env python3
"""Functional tests for AudioMixer.

Run:  .venv/bin/python test_app.py     (best with the server stopped)

Two suites, both against the real implementation:
  • controls — drives the HTTP endpoints (Flask test client, in-process, no port)
    and verifies they change the ACTUAL PipeWire node volume.
  • gate     — drives the real noise-gate loop with a scripted input level and
    checks threshold / attack / hold / release / hysteresis behaviour over time.

Persistence is redirected to temp files so your real state.json / presets.json
are never touched. The controls suite creates one throwaway virtual mic and
removes it again; nothing else is left behind. It does NOT call cleanup_orphans /
kill_stray_meters, so a running server's channels are not disturbed (still,
running with the server stopped is cleanest).
"""

import os
import subprocess
import sys
import tempfile
import time

import app
import pipewire as pw

# Redirect persistence to temp files BEFORE anything saves.
app.STATE_FILE = os.path.join(tempfile.gettempdir(), "am_test_state.json")
app.PRESETS_FILE = os.path.join(tempfile.gettempdir(), "am_test_presets.json")
for _f in (app.STATE_FILE, app.PRESETS_FILE):
    try:
        os.remove(_f)
    except OSError:
        pass

results = []


def check(name, cond):
    results.append((name, bool(cond)))
    print(("  PASS  " if cond else "  FAIL  ") + name)


def node_vol(mic):
    """Read the actual Props.volume of a virtual-mic node (or None)."""
    nid = pw.node_id(mic)
    if nid is None:
        return None
    out = subprocess.run(["pw-cli", "enum-params", str(nid), "Props"],
                         capture_output=True, text=True).stdout
    for ln in out.splitlines():
        s = ln.strip()
        if s.startswith("Float"):
            try:
                return round(float(s.split()[1].replace(",", ".")), 3)
            except ValueError:
                pass
    return None


cl = app.app.test_client()


def test_controls():
    print("\n[controls] endpoints -> real PipeWire node volume")
    srcs = [d for d in pw.list_devices() if d["kind"] == "source" and d["ports"]]
    if not srcs:
        print("  SKIP — no capture source available")
        return
    dev, port = srcs[0]["id"], srcs[0]["ports"][0]["id"]
    created = cl.post("/api/start", json={
        "device": dev, "device_name": "TEST",
        "channels": [{"port": port, "name": "TST", "gain": 1.0}],
    }).get_json()["created"]
    mic = created[0]["mic_id"]
    try:
        time.sleep(1.5)
        check("node created", pw.node_id(mic) is not None)

        cl.post("/api/volume", json={"mic_id": mic, "gain": 0.5}); time.sleep(.3)
        check("volume 0.5", node_vol(mic) == 0.5)

        cl.post("/api/mute", json={"mic_id": mic, "muted": True}); time.sleep(.3)
        v = node_vol(mic); check("mute -> 0", v is not None and v == 0.0)
        cl.post("/api/mute", json={"mic_id": mic, "muted": False}); time.sleep(.3)
        check("unmute -> 0.5", node_vol(mic) == 0.5)

        cl.post("/api/master", json={"gain": 0.5}); time.sleep(.3)
        check("master*gain -> 0.25", node_vol(mic) == 0.25)
        cl.post("/api/master_mute", json={"muted": True}); time.sleep(.3)
        v = node_vol(mic); check("master mute -> 0", v is not None and v == 0.0)
        cl.post("/api/master_mute", json={"muted": False})
        cl.post("/api/master", json={"gain": 1.0}); time.sleep(.3)
        check("master restore -> 0.5", node_vol(mic) == 0.5)

        cl.post("/api/gate", json={"mic_id": mic, "threshold": 0.02, "attack": 0.02,
                                   "hold": 0.4, "release": 0.2, "hyst": 8})
        ch = next(c for c in cl.get("/api/channels").get_json()["channels"] if c["mic_id"] == mic)
        check("gate params saved", abs(ch["gate"] - 0.02) < 1e-6
              and abs(ch["gate_hold"] - 0.4) < 1e-6 and abs(ch["gate_hyst"] - 8) < 1e-6)

        c = app.mixer._by_mic(mic)
        c.gate_open = False; c.gate_level = 0.0; c._apply_gain(app.mixer.eff_master()); time.sleep(.2)
        v = node_vol(mic); check("gate closed -> 0", v is not None and v == 0.0)
        c.gate_open = True; c.gate_level = 1.0; c._apply_gain(app.mixer.eff_master()); time.sleep(.2)
        check("gate open -> 0.5", node_vol(mic) == 0.5)

        d2 = pw.Channel.from_dict(c.to_dict())
        check("persist round-trip", abs(d2.gate - c.gate) < 1e-9
              and abs(d2.gate_release - c.gate_release) < 1e-9 and d2.muted == c.muted)

        cl.post("/api/presets", json=[{"id": "x", "name": "P",
            "scene": {"v": 1, "master": 1, "links": [], "ch": {mic: {"gain": 0.3, "gate": 0.05}}}}])
        got = cl.get("/api/presets").get_json()
        check("presets round-trip", bool(got) and got[0]["scene"]["ch"][mic]["gate"] == 0.05)
    finally:
        cl.post("/api/remove", json={"mic_id": mic}); time.sleep(.5)
    check("channel removed", pw.node_id(mic) is None)


def test_gate_dynamics():
    print("\n[gate] noise-gate dynamics via the real _gate_loop")
    ch = pw.Channel(99300, "GateTest", "dev", "port", "", "")
    ch.active = True; ch.gain = 1.0
    ch.gate = 0.05; ch.gate_attack = 0.05; ch.gate_hold = 0.30
    ch.gate_release = 0.20; ch.gate_hyst = 6.0
    ch.gate_level = 0.0; ch.gate_open = False
    app.mixer.channels[99300] = ch
    app.mixer.master = 1.0
    scripted = {"rms": 0.0}
    app.mixer.gate_mon.sync = lambda *a, **k: None          # don't spawn a real detector
    app.mixer.gate_mon.level = lambda mic: scripted["rms"]   # feed a scripted level
    app.mixer.start_gate()
    try:
        # thr = gate/(gain*master) = 0.05 ; close_thr = 0.05*10^(-6/20) ≈ 0.025
        scripted["rms"] = 0.0; time.sleep(0.5)
        check("silence -> closed", ch.gate_open is False and ch.gate_level < 0.05)
        scripted["rms"] = 0.1; time.sleep(0.3)
        check("loud -> open (attack)", ch.gate_open is True and ch.gate_level > 0.95)
        scripted["rms"] = 0.0; time.sleep(0.15)
        check("hold keeps it open", ch.gate_open is True and ch.gate_level > 0.9)
        time.sleep(0.45)
        check("after hold -> closed (release)", ch.gate_open is False and ch.gate_level < 0.05)
        scripted["rms"] = 0.035; time.sleep(0.3)
        check("hysteresis: below thr stays closed", ch.gate_open is False)
        scripted["rms"] = 0.1; time.sleep(0.25)
        check("reopen above thr", ch.gate_open is True)
        scripted["rms"] = 0.035; time.sleep(0.6)
        check("hysteresis: no chatter (stays open)", ch.gate_open is True)
        scripted["rms"] = 0.0; time.sleep(0.5)
        check("below close-thr -> closed", ch.gate_open is False)
    finally:
        app.mixer._relink_stop.set()
        app.mixer.channels.pop(99300, None)


if __name__ == "__main__":
    test_controls()
    test_gate_dynamics()
    passed = sum(1 for _, v in results if v)
    failed = [n for n, v in results if not v]
    print(f"\n{passed}/{len(results)} passed" + (" — all green" if not failed else " — FAILED: " + ", ".join(failed)))
    sys.exit(0 if not failed else 1)
