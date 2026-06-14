"""Real-time level metering.

For each active virtual microphone a daemon thread runs

    pw-record --target=<mic_node> --channels=1 --rate=8000 --format=s16 -

reads the raw PCM stream and computes a rolling RMS (0.0-1.0). The most recent
level, a decaying peak, and a "no signal" flag are kept in a shared, lock-guarded
dict that the HTTP layer reads on every /api/levels poll.
"""

from __future__ import annotations

import subprocess
import threading
import time

import numpy as np

RATE = 8000
FORMAT_BYTES = 2          # s16 little-endian
CHUNK_MS = 50             # RMS window
CHUNK_BYTES = int(RATE * FORMAT_BYTES * CHUNK_MS / 1000)
NO_SIGNAL_AFTER = 2.0     # seconds of silence -> "no_signal"
SILENCE_RMS = 0.00004     # below this counts as silence (low, so very quiet
                          # sources aren't falsely flagged "no signal")


class _Meter(threading.Thread):
    def __init__(self, mic_id: str, target_node: str):
        super().__init__(daemon=True)
        self.mic_id = mic_id
        self.target = target_node
        self._stop = threading.Event()
        self.level = 0.0
        self.last_signal = time.time()
        self.proc: subprocess.Popen | None = None

    def run(self) -> None:
        while not self._stop.is_set():
            try:
                self.proc = subprocess.Popen(
                    ["pw-record", f"--target={self.target}",
                     "--channels=1", f"--rate={RATE}", "--format=s16", "-"],
                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            except Exception:
                time.sleep(0.5)
                continue

            while not self._stop.is_set():
                chunk = self.proc.stdout.read(CHUNK_BYTES)
                if not chunk:
                    break  # stream ended (node gone); relink loop will retry
                usable = len(chunk) - (len(chunk) % 2)
                samples = np.frombuffer(chunk[:usable], dtype=np.int16)
                if samples.size == 0:
                    continue
                rms = float(np.sqrt(np.mean(samples.astype(np.float32) ** 2))) / 32768.0
                self.level = rms
                if rms > SILENCE_RMS:
                    self.last_signal = time.time()

            self._kill_proc()
            if not self._stop.is_set():
                time.sleep(0.3)  # node may be momentarily absent during reassign

    def _kill_proc(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=1)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        self.proc = None

    def snapshot(self) -> float | str:
        if time.time() - self.last_signal > NO_SIGNAL_AFTER:
            return "no_signal"
        return round(self.level, 4)

    def stop(self) -> None:
        self._stop.set()
        self._kill_proc()


class LevelMonitor:
    """Owns one _Meter per active mic."""

    def __init__(self):
        self._meters: dict[str, _Meter] = {}
        self._lock = threading.Lock()

    def add(self, mic_id: str, target_node: str) -> None:
        with self._lock:
            if mic_id in self._meters:
                return
            m = _Meter(mic_id, target_node)
            self._meters[mic_id] = m
            m.start()

    def remove(self, mic_id: str) -> None:
        with self._lock:
            m = self._meters.pop(mic_id, None)
        if m:
            m.stop()

    def sync(self, targets: dict[str, str]) -> None:
        """Reconcile the running meters to exactly ``targets`` (key -> node).

        Used by the device probe in the add/reassign wizard: meters that are no
        longer wanted are stopped, missing ones are started.
        """
        with self._lock:
            have = set(self._meters)
            want = set(targets)
            to_stop = [self._meters.pop(k) for k in have - want]
            for k in want - have:
                m = _Meter(k, targets[k])
                self._meters[k] = m
                m.start()
        for m in to_stop:
            m.stop()

    def levels(self) -> dict[str, float | str]:
        with self._lock:
            meters = list(self._meters.items())
        return {mic_id: m.snapshot() for mic_id, m in meters}

    def stop_all(self) -> None:
        with self._lock:
            meters = list(self._meters.values())
            self._meters.clear()
        for m in meters:
            m.stop()


# --------------------------------------------------------------------------- #
# Device probe (wizard equaliser)
# --------------------------------------------------------------------------- #

def _pwlink(*args) -> None:
    subprocess.run(["pw-link", *args],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


class _ProbeMeter(threading.Thread):
    """Meter an arbitrary device by EXPLICIT linking.

    A plain ``pw-record --target=<x>`` does NOT pin to one node: WirePlumder
    greedily links the capture stream to *every* source and monitor, so the
    reading is a sum of all devices (clapping shows up on the speaker monitor).
    Instead we start the recorder with node.autoconnect=false and link only the
    requested device's output ports into it.
    """

    def __init__(self, idx: int, device_node: str, ports: list[str]):
        super().__init__(daemon=True)
        self.node = f"am_probe_{idx}"
        self.device = device_node
        self.ports = ports or ["capture_FL"]
        self._stop = threading.Event()
        self.level = 0.0
        self.proc: subprocess.Popen | None = None

    def run(self) -> None:
        while not self._stop.is_set():
            self.proc = subprocess.Popen(
                ["pw-record", "-P", f"node.autoconnect=false node.name={self.node}",
                 "--channels=2", f"--rate={RATE}", "--format=s16", "-"],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

            # wait for the recorder's input ports, then link only this device
            linked = False
            for _ in range(40):
                if self._stop.is_set():
                    break
                ins = subprocess.run(["pw-link", "-i"], capture_output=True,
                                     text=True).stdout
                if f"{self.node}:input_FL" in ins:
                    for p in self.ports:
                        _pwlink(f"{self.device}:{p}", f"{self.node}:input_FL")
                        _pwlink(f"{self.device}:{p}", f"{self.node}:input_FR")
                    linked = True
                    break
                time.sleep(0.05)

            if linked:
                while not self._stop.is_set():
                    chunk = self.proc.stdout.read(CHUNK_BYTES * 2)   # stereo
                    if not chunk:
                        break
                    usable = len(chunk) - (len(chunk) % 2)
                    s = np.frombuffer(chunk[:usable], dtype=np.int16)
                    if s.size:
                        self.level = float(np.sqrt(np.mean(s.astype(np.float32) ** 2))) / 32768.0

            self._kill_proc()
            if not self._stop.is_set():
                time.sleep(0.3)

    def _kill_proc(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=1)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        self.proc = None

    def snapshot(self) -> float:
        return round(self.level, 4)

    def stop(self) -> None:
        self._stop.set()
        self._kill_proc()


class GateMonitor:
    """Detects the PRE-gain input level of gated channels, so the noise gate can
    open/close without measuring its own (gated) output. Keyed by mic_id; each
    meter records the channel's source device port via explicit link."""

    def __init__(self):
        self._meters: dict[str, _ProbeMeter] = {}
        self._lock = threading.Lock()
        self._counter = 0

    def sync(self, targets: dict[str, tuple[str, list[str]]]) -> None:
        """targets: {mic_id: (device_node, [port names])}."""
        with self._lock:
            have = set(self._meters)
            want = set(targets)
            to_stop = [self._meters.pop(k) for k in have - want]
            for k in want - have:
                self._counter += 1
                dev, ports = targets[k]
                m = _ProbeMeter(20000 + self._counter, dev, ports)
                self._meters[k] = m
                m.start()
        for m in to_stop:
            m.stop()

    def level(self, mic_id: str) -> float:
        with self._lock:
            m = self._meters.get(mic_id)
        return m.snapshot() if m else 0.0

    def stop_all(self) -> None:
        with self._lock:
            meters = list(self._meters.values())
            self._meters.clear()
        for m in meters:
            m.stop()


class ProbeMonitor:
    """Owns one _ProbeMeter per probed device (keyed by device node.name)."""

    def __init__(self):
        self._meters: dict[str, _ProbeMeter] = {}
        self._lock = threading.Lock()
        self._counter = 0

    def sync(self, targets: dict[str, list[str]]) -> None:
        """Reconcile to exactly ``targets`` (device node.name -> [port names])."""
        with self._lock:
            have = set(self._meters)
            want = set(targets)
            to_stop = [self._meters.pop(k) for k in have - want]
            for k in want - have:
                self._counter += 1
                m = _ProbeMeter(self._counter, k, targets[k])
                self._meters[k] = m
                m.start()
        for m in to_stop:
            m.stop()

    def levels(self) -> dict[str, float]:
        with self._lock:
            items = list(self._meters.items())
        return {k: m.snapshot() for k, m in items}

    def stop_all(self) -> None:
        with self._lock:
            meters = list(self._meters.values())
            self._meters.clear()
        for m in meters:
            m.stop()
