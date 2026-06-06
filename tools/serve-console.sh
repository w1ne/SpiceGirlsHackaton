#!/usr/bin/env bash
# Serve the SpiceDispenser calibration / control console in the browser, reliably.
#
#   ./tools/serve-console.sh            # auto-detect board, serve on :8000
#   ./tools/serve-console.sh 8080       # custom port
#
# Then open http://localhost:8000/ — the Calibration card lets you set the
# revolver mode (continuous / 180° positional), per-compartment angles, offsets,
# timing and shutter, all persisted to the board.
#
# Why this script exists: two bridges must NEVER hold the serial port at once
# (that's what caused "board silent / device busy"). This kills any previous
# bridge first, then starts exactly one — unbuffered so its log is live.
set -uo pipefail
cd "$(dirname "$0")/.."
PORT="${1:-8000}"

# 1) kill any bridge already running (the #1 cause of port collisions)
pkill -f 'serial-bridge\.py' 2>/dev/null || true
sleep 1

# 2) find the board (native USB CDC shows as ttyACM; a UART bridge as ttyUSB)
DEV="$(ls /dev/ttyACM* /dev/ttyUSB* 2>/dev/null | head -1 || true)"
if [ -z "$DEV" ]; then
  echo "No board on USB (/dev/ttyACM* or /dev/ttyUSB*)."
  echo "Plug it into the port labelled 'USB' (native), not 'UART', and rerun."
  exit 1
fi

echo "▶ Calibration console: http://localhost:${PORT}/    (board: ${DEV})"
echo "  Open that URL in your browser. Ctrl-C to stop."
# 3) exactly one bridge, unbuffered; it auto-reopens if the board re-enumerates
exec python3 -u tools/serial-bridge.py "$DEV" --port "$PORT"
