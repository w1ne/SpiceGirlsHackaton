#!/usr/bin/env bash
# Firmware simulation gate: rom-boot the built firmware on the faithful
# labwired ESP32-S3 model and assert the boot + I2C dispense path.
#
# Usage:  tools/sim_gate.sh <labwired-core-dir> [build-dir]
#   <labwired-core-dir>  checkout of w1ne/labwired-core with a release build
#                        (target/release/labwired) or cargo available
#   [build-dir]          PlatformIO build dir (default firmware/.pio/build/esp32-s3)
#
# Requires: firmware.elf + firmware.factory.bin in the build dir (see
# .github/workflows/firmware-sim-gate.yml for the factory-bin merge recipe),
# and the ESP32-S3 ROM ELF discoverable (~/.platformio/tools/tool-esp-rom-elfs/
# or LABWIRED_ESP32S3_ROM_ELF).
set -euo pipefail

LABWIRED_DIR="${1:?usage: sim_gate.sh <labwired-core-dir> [build-dir]}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="${2:-$REPO_ROOT/firmware/.pio/build/esp32-s3}"
LOG="${SIM_GATE_LOG:-/tmp/spice-sim-gate.log}"

ELF="$BUILD_DIR/firmware.elf"
FACTORY="$BUILD_DIR/firmware.factory.bin"
[ -f "$ELF" ] || { echo "sim-gate: missing $ELF (build first)"; exit 2; }
[ -f "$FACTORY" ] || { echo "sim-gate: missing $FACTORY (merge factory bin first)"; exit 2; }

BIN="$LABWIRED_DIR/target/release/labwired"
if [ ! -x "$BIN" ]; then
  echo "sim-gate: building labwired-cli (release)..."
  (cd "$LABWIRED_DIR" && cargo build --release -p labwired-cli)
fi

echo "sim-gate: rom-booting $(basename "$FACTORY") on the faithful ESP32-S3 model..."
set +e
LABWIRED_ESP32S3_FLASH="$FACTORY" LABWIRED_ESP32S3_PCA9685=1 \
  "$BIN" run \
    --chip "$LABWIRED_DIR/configs/chips/esp32s3-zero.yaml" \
    --firmware "$ELF" \
    --rom-boot --max-steps "${SIM_GATE_MAX_STEPS:-40000000}" >"$LOG" 2>&1
RC=$?
set -e

fail() { echo "sim-gate: FAIL — $1"; echo "--- last 30 log lines ---"; tail -30 "$LOG"; exit 1; }

# The gate requires POSITIVE evidence, not just a clean exit. Never weaken
# these to make a failing build pass — fix the firmware or the model.
[ $RC -eq 0 ] || fail "simulator exited rc=$RC"
grep -q "faithful ROM loaded" "$LOG" \
  || fail "not running the faithful ROM (degraded harness mode?) — ROM ELF discovery broken"
grep -q "APP_CPU released from reset" "$LOG" \
  || fail "APP_CPU never released — SMP boot regression"
grep -q "PCA9685: channel 0 servo ->" "$LOG" \
  || fail "no PCA9685 servo command observed — I2C dispense path regression"
grep -qiE "panicked at|REVOLVER FAIL" "$LOG" \
  && fail "failure marker in sim output"

echo "sim-gate: PASS (faithful rom-boot + APP_CPU release + I2C dispense path)"
grep -E "faithful ROM loaded|APP_CPU released|PCA9685: channel 0" "$LOG" | head -5
