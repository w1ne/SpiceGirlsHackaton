# SpiceDispenser 🌶️ (SpiceGirls Hackathon)

Voice-driven smart spice dispenser. Talk to it like a friend, it sets up your
compartments, asks clarifying questions, and dispenses the right spices.

- **Phone app** (`app/`) — native Android (Capacitor). On-device speech-to-text +
  text-to-speech, clarifying-question LLM on DeepInfra. Talks to the dispenser
  over **BLE**; recipes/compartment config in **Supabase**.
- **ESP32-S3/C3** (`firmware/`) — BLE GATT actuator, two servos (revolver select
  + dispense sweep).

## Wiring

Servos: 🟠 signal · 🔴 +5V · ⚫ GND.

| Connection | To |
|---|---|
| Revolver servo 🟠 signal | ESP32 **GPIO4** |
| Dispense servo 🟠 signal | ESP32 **GPIO5** |
| Both servos 🔴 +5V | **5V supply +** (external 5V recommended) |
| Both servos ⚫ GND | **supply −** |
| ESP32 **GND** pin | **supply −** (common ground — required) |

⚠️ Power two servos from a **separate 5V supply**, not the board's 3V3/5V — current
spikes brown out the ESP32 and drop BLE. Always share ground with the ESP32.
A single small servo can run off the board's `5V` pin for a quick test only.

Revolver: compartment 1→15°, +30° each, up to 6→165°. Dispense: rest 20° → push
120°, repeated `dose_units` times. Angles are `#define`s atop `firmware/src/main.cpp`.

## BLE interface (firmware ↔ app)

- Service `a1c20000-d8e4-4f9b-9b1a-2f3c4d5e6f70`, advertises as **"SpiceGirls"**
- **Command** char `…0001` (write): `{"slot":2,"dose_units":3}` or an array of those
- **Status** char `…0002` (notify): `{"status":"running"|"done"|"error"}`

## Setup

```bash
# Flash the dispenser (ESP32-S3 on USB)
cd firmware && pio run -e esp32-s3 -t upload

# Build + install the app
cd ../app
cp .env.local.example .env.local        # paste your DeepInfra key
npm install --legacy-peer-deps
npm run build && npx cap sync android
cd android && ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Quick BLE test without the phone (Linux): `python tools/ble_test.py '{"slot":1,"dose_units":1}'`. 

Move py-firmware files to the ESP:

```shell
cd ./firmware-py
mpremote connect $PORT cp boot.py pca9685.py dispenser.py ble_server.py main.py :
```