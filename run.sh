#!/usr/bin/env bash
# Set up the venv (reusing system numpy) and launch the AudioMixer server.
set -euo pipefail
cd "$(dirname "$0")"

VENV=".venv"
if [ ! -d "$VENV" ]; then
  echo "Creating venv (with access to system packages for numpy)…"
  python3 -m venv --system-site-packages "$VENV"
  "$VENV/bin/pip" install --quiet --upgrade pip
  "$VENV/bin/pip" install --quiet flask qrcode
fi

echo "AudioMixer → http://127.0.0.1:8723"
exec "$VENV/bin/python" app.py
