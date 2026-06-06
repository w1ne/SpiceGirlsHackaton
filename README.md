# SpiceDispenser 🌶️ (SpiceGirls Hackathon)

Voice-driven smart spice dispenser. Talk to it like a friend, it sets up your
compartments, asks clarifying questions, and dispenses the right spices.

## 📲 Get the app

**[⬇️ Download SpiceGirls.apk](https://github.com/w1ne/SpiceGirlsHackaton/releases/latest/download/SpiceGirls.apk)** → open it on Android → allow "install from this source".

No setup, no keys to enter — it talks to the hosted backend out of the box. Just
power the ESP32 dispenser and keep it in Bluetooth range. Sharing notes
(safety, building your own APK, standing up your own backend): see
**[SHARING.md](SHARING.md)**.

- **Phone app** (`app/`) — native Android (Capacitor). On-device speech-to-text +
  text-to-speech, clarifying-question LLM on DeepInfra. Talks to the dispenser
  over **BLE**; recipes/compartment config in **Supabase**.
- **ESP32-S3** (`firmware-py/`) — MicroPython BLE GATT actuator driving two servos
  through a **PCA9685** I²C PWM board (revolver select + shutter dispense).

## Wiring

The ESP32 talks to a **PCA9685** servo driver over I²C; the servos plug into the
PCA9685, not the ESP32 directly. Servo lead: 🟠 signal · 🔴 +5V · ⚫ GND.

| Connection | To |
|---|---|
| ESP32 **GPIO5** (SDA) | PCA9685 **SDA** |
| ESP32 **GPIO6** (SCL) | PCA9685 **SCL** |
| ESP32 **3V3** | PCA9685 **VCC** (logic) |
| ESP32 **GND** | PCA9685 **GND** + supply − (common ground — required) |
| Revolver servo | PCA9685 **channel 8** |
| Shutter servo | PCA9685 **channel 12** |
| PCA9685 **V+** | **5V supply +** (external 5V) |
| Servo power rail (V+) | shared with PCA9685 V+ |

PCA9685 I²C address `0x40`, bus at 400 kHz, PWM at 50 Hz.

⚠️ Power the servos from a **separate 5V supply** into PCA9685 `V+`, not the board's
3V3/5V — current spikes brown out the ESP32 and drop BLE. Always share ground
between the ESP32, the PCA9685, and the servo supply.

Revolver: compartment 1→15°, +30° each, up to 6→165°. Shutter: closed 20° → open
120°, repeated `dose_units` times. Channels/angles are atop `firmware-py/dispenser.py`.

> An alternative direct-GPIO build (no PCA9685, servo signals on ESP32 GPIO4/5)
> lives in `firmware/` (C++). It speaks the **same BLE protocol**; pick one.

## BLE interface (firmware ↔ app)

- Service `a1c20000-d8e4-4f9b-9b1a-2f3c4d5e6f70`, advertises the name **"SpiceGirls"**
  in the primary advertisement (the app discovers by name); the service UUID rides in
  the scan response. The app scans unfiltered and matches the name client-side.
- **Command** char `…0001` (write): `{"slot":2,"dose_units":3}` or an array of those
- **Status** char `…0002` (notify): `{"status":"running"|"done"|"error"}`
- **Status LED** (onboard RGB, GPIO21): blue = advertising, green = connected,
  white = running a command, red = error

## Setup

```bash
# Flash the dispenser — MicroPython (ESP32-S3 + PCA9685) on USB
cd firmware-py
mpremote connect $PORT cp boot.py pca9685.py dispenser.py ble_adv.py led.py ble_server.py main.py :
mpremote connect $PORT reset            # boots straight into the BLE server

# Build + install the app
cd ../app
cp .env.local.example .env.local        # paste your OpenAI / DeepInfra key
npm install --legacy-peer-deps
npm run build && npx cap sync android
cd android && ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Quick BLE test without the phone (Linux): `python tools/ble_test.py '{"slot":1,"dose_units":1}'`.

## Flashing the C++ firmware (Linux / macOS)

The current firmware is `firmware/` (C++; same BLE protocol, plus the control
console, persisted calibration, and the STS3215 bus-servo drive).

```bash
# build + flash (Linux: pipx install platformio · macOS: brew install platformio)
cd firmware && pio run -e esp32-s3 -t upload
```

No toolchain? Flash the prebuilt combined image with esptool instead:

```bash
esptool.py --chip esp32s3 --port $PORT write_flash 0x0 firmware.factory.bin
# image: firmware/.pio/build/esp32-s3/firmware.factory.bin
# PORT — Linux: /dev/ttyACM0 · macOS: /dev/cu.usbmodem* (USB) or /dev/cu.wchusbserial* (UART)
```

If the upload won't start, hold **BOOT** while plugging in, then rerun. Logs +
the JSON console are on the **native USB** port; `./tools/serve-console.sh`
serves the calibration console at http://localhost:8000/.
