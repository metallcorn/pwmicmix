#!/usr/bin/env python3
"""Reusable offscreen QtWebEngine smoke test for the UI (saves re-pasting harnesses).

Serves ./static with a tiny stub API, renders it in an offscreen pywebview+Qt
window, runs a JS snippet, prints the result, and exits. Use the AppImage's
bundled interpreter so it tests the shipped Qt:

  PYBIN=$(echo build/AudioMixer.AppDir/opt/python*/bin/python*.* | tr ' ' '\n' \
          | grep -E 'python[0-9]+\\.[0-9]+$' | head -1)
  env -i HOME="$HOME" PATH="build/AudioMixer.AppDir/usr/bin:$PATH" \
      XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/1000}" \
      "$PYBIN" packaging/qt-smoke.py "document.querySelectorAll('.btn').length"

Args:
  argv[1]  JS expression to evaluate after load (default: count .btn).
  --channels N   stub N channels (so gear/fader UI exists).
  --wait S       seconds to wait before evaluating (default 2.8).
"""
import os, sys, json, threading, time, http.server, socketserver

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QTWEBENGINE_DISABLE_SANDBOX", "1")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC = os.path.join(ROOT, "static")

args = sys.argv[1:]
def _opt(name, default):
    if name in args:
        i = args.index(name); v = args[i + 1]; del args[i:i + 2]; return v
    return default
nch = int(_opt("--channels", "0"))
wait = float(_opt("--wait", "2.8"))
expr = args[0] if args else "document.querySelectorAll('.btn').length"

PORT = 8790
chans = [{"mic_id": f"m{i}", "name": f"Ch {i}", "src_label": "dev", "port_label": "FL",
          "gain": 1.0, "active": True, "muted": False, "route_ok": True, "gate": 0.0,
          "gate_attack": 0.01, "gate_hold": 0.35, "gate_release": 0.15, "gate_hyst": 6.0,
          "gate_open": False, "gate_level": 1.0} for i in range(1, nch + 1)]
API = {"/api/ping": {"authed": True},
       "/api/channels": {"channels": chans, "master": 1.0, "master_muted": False, "packaged": True, "running": bool(nch)},
       "/api/presets": [], "/api/devices": [], "/api/levels": {"levels": {}, "master": 0},
       "/api/netinfo": {"pin": "0", "port": PORT, "packaged": True, "default": "127.0.0.1", "interfaces": []}}

class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=STATIC, **k)
    def log_message(self, *a): pass
    def _j(self, o):
        b = json.dumps(o).encode(); self.send_response(200)
        self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b)))
        self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        p = self.path.split("?")[0]
        if p in API: return self._j(API[p])
        if self.path == "/" or self.path.startswith("/?"): self.path = "/index.html"
        return super().do_GET()
    def do_POST(self): self.rfile.read(int(self.headers.get("Content-Length", 0))); self._j({"ok": True})

srv = socketserver.ThreadingTCPServer(("127.0.0.1", PORT), H); srv.daemon_threads = True
threading.Thread(target=srv.serve_forever, daemon=True).start(); time.sleep(0.3)

from qtpy.QtWidgets import QApplication  # noqa: E402
import webview  # noqa: E402
w = webview.create_window("smoke", f"http://127.0.0.1:{PORT}/", width=1180, height=740)
out = {}
def probe():
    time.sleep(wait)
    try: out["result"] = w.evaluate_js(expr)
    except Exception as e: out["error"] = repr(e)
    w.destroy()
webview.start(probe, gui="qt")
print("SMOKE:", json.dumps(out))
