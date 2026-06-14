"""Windowed desktop entrypoint (packaged build).

Runs the Flask server in a background thread and shows the UI in a native
window via pywebview + Qt WebEngine (the same Chromium engine the UI targets).

Design choices that match the rest of the project:
  • Closing the window QUITS the app — our process exits, nothing lingers in the
    background draining the battery. But the lightweight pw-loopback mics stay
    detached + alive, so other apps don't lose their input and the next launch
    adopts them instantly. (Fully removing mics is still ⏹ Stop / 🗑 Clear in UI.)
  • Single instance: if one of our servers is already running, just open a window
    pointing at it instead of starting a second server that would fight for the
    same PipeWire nodes.
  • If pywebview/Qt can't start for any reason, fall back to the default browser
    so the app still works.
"""

import os
import sys
import threading
import time
import urllib.request

import app as A

WIN_W, WIN_H = 1180, 740


def _server_is_ours(port: int) -> bool:
    """True if an AudioMixer server answers on this localhost port."""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/ping", timeout=0.4) as r:
            return r.status == 200 and b"authed" in r.read()
    except Exception:
        return False


def _wait_until_up(port: int, timeout: float = 12.0) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        if _server_is_ours(port):
            return True
        time.sleep(0.1)
    return False


def _start_browser_fallback(port: int, started: bool):
    import webbrowser
    webbrowser.open(f"http://localhost:{port}")
    if started:                       # keep the server we started alive
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            pass
        A._teardown()


def main():
    # ── single instance: attach to an already-running AudioMixer if present ──
    attached = next((p for p in range(A.PORT, A.PORT + 20) if _server_is_ours(p)), None)

    if attached is None:
        A.boot_server()               # picks A.PORT, adopts nodes, starts helpers
        threading.Thread(
            target=lambda: A.app.run(host="0.0.0.0", port=A.PORT,
                                     threaded=True, debug=False, use_reloader=False),
            daemon=True).start()
        if not _wait_until_up(A.PORT):
            print("AudioMixer: server failed to start", file=sys.stderr)
            sys.exit(1)
        port, started = A.PORT, True
    else:
        port, started = attached, False

    url = f"http://localhost:{port}"

    try:
        import webview
    except Exception as e:
        print(f"AudioMixer: webview unavailable ({e}); opening in browser", file=sys.stderr)
        _start_browser_fallback(port, started)
        return

    icon = os.environ.get("AUDIOMIXER_ICON")

    # Establish the app identity BEFORE pywebview builds its window so the desktop
    # associates it with AudioMixer.desktop — that's what gives GNOME (Wayland) and
    # KDE our panel icon + correct window grouping. pywebview reuses this instance.
    try:
        from qtpy.QtWidgets import QApplication
        from qtpy.QtGui import QIcon
        qapp = QApplication.instance() or QApplication(sys.argv)
        qapp.setApplicationName("AudioMixer")
        qapp.setApplicationDisplayName("AudioMixer")
        qapp.setDesktopFileName("AudioMixer")          # ↔ usr/share/applications/AudioMixer.desktop
        if icon and os.path.exists(icon):
            qapp.setWindowIcon(QIcon(icon))
    except Exception as e:
        print(f"AudioMixer: could not set app identity ({e})", file=sys.stderr)

    # JS bridge: the in-page Quit button (and the close-confirm modal) call
    # window.pywebview.api.quit() to actually close the window.
    class _Api:
        def __init__(self):
            self.window = None
            self.quitting = False
        def quit(self):
            self.quitting = True
            if self.window:
                self.window.destroy()

    qapi = _Api()
    win = webview.create_window("AudioMixer", url, js_api=qapi,
                                width=WIN_W, height=WIN_H, min_size=(900, 560))
    qapi.window = win

    # Intercept the native window close (X / titlebar): cancel it and show OUR
    # confirmation modal instead. The modal's Quit calls qapi.quit() above.
    def _on_closing():
        if qapi.quitting:
            return True                # confirmed → allow the close
        # evaluate_js from a worker thread (calling it on the GUI thread can deadlock)
        threading.Thread(
            target=lambda: win.evaluate_js("window.confirmQuit && window.confirmQuit()"),
            daemon=True).start()
        return False                   # veto the close; the modal drives the real quit
    try:
        win.events.closing += _on_closing
    except Exception as e:
        print(f"AudioMixer: close-intercept unavailable ({e})", file=sys.stderr)

    kwargs = {"gui": "qt"}            # force the Qt/WebEngine backend (no GTK bundled)
    if icon and os.path.exists(icon):
        kwargs["icon"] = icon
    try:
        webview.start(**kwargs)
    except TypeError:                 # older pywebview: start() has no icon kwarg
        kwargs.pop("icon", None)
        webview.start(**kwargs)
    except Exception as e:
        print(f"AudioMixer: webview failed ({e}); opening in browser", file=sys.stderr)
        _start_browser_fallback(port, started)
        return

    # Window closed → quit. Only stop the server if WE started it (don't kill an
    # instance we merely attached to). Detached mics stay alive by design.
    if started:
        A._teardown()
    os._exit(0)


if __name__ == "__main__":
    main()
