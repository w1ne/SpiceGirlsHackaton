// SpiceDispenser ESP32 firmware — BLE GATT server (no WiFi).
// The phone connects over BLE and writes spice commands; we drive two servos
// (revolver select + dispense sweep) and notify status back.
//
// GATT profile (the interface contract):
//   Service          a1c20000-d8e4-4f9b-9b1a-2f3c4d5e6f70
//   Command  (write) a1c20001-...  JSON: {"slot":2,"dose_units":3}
//                                  or an array for a recipe: [{...},{...}]
//   Status (notify)  a1c20002-...  JSON: {"status":"running","slot":2} | {"status":"done"} | {"status":"error"}

#include <Arduino.h>
#include <NimBLEDevice.h>
#include <Wire.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include "driver/gpio.h"
#include "esp_rom_gpio.h"
#include "soc/uart_periph.h"

#define DEVICE_NAME   "SpiceGirls"
#define SERVICE_UUID  "a1c20000-d8e4-4f9b-9b1a-2f3c4d5e6f70"
#define CMD_UUID      "a1c20001-d8e4-4f9b-9b1a-2f3c4d5e6f70"
#define STATUS_UUID   "a1c20002-d8e4-4f9b-9b1a-2f3c4d5e6f70"

// --- I2C / PCA9685 servo driver (mirrors firmware-py/dispenser.py + pca9685.py) ---
// The board carries a PCA9685 PWM driver on I2C (live at 0x40); the revolver and
// shutter servos hang off its channels, NOT off raw GPIO. Same bus/pins/channels
// /angles/timings as the proven MicroPython firmware.
#define I2C_SDA          5
#define I2C_SCL          6
#define I2C_FREQ         400000
#define PCA9685_ADDR     0x40
#define PCA9685_MODE1    0x00
#define PCA9685_PRESCALE 0xFE
#define PCA9685_LED0_ON_L 0x06

#define SHUTTER_CH       12
#define SHUTTER_CLOSED   20
#define SHUTTER_OPEN     120
#define SHUTTER_DWELL_MS 300

// --- revolver drive (runtime auto-select) -------------------------------------
// BOTH revolver drivers are compiled in. At boot the firmware probes the STS
// bus: if an STS3215 answers, the revolver runs closed-loop off its absolute
// encoder; otherwise it falls back to the MG90S-360 open-loop timed stepping
// on PCA ch8. One firmware serves both prototypes — the STS simply isn't
// connected on the PWM version. Set REVOLVER_USE_STS3215 to 0 to skip the STS
// probe entirely (pure PWM build, frees Serial1/GP7).
#define REVOLVER_USE_STS3215 1

#define NUM_SLOTS         6

// --- revolver option A: Feetech STS3215 smart bus servo (absolute encoder) ---
// One-wire half-duplex TTL bus on Serial1 (via Bus Servo Adapter: ESP TX17 ->
// adapter RX, ESP RX18 <- adapter TX, common GND; servo power from the adapter
// DC input). Position mode: 4096 ticks/turn, slot i = SLOT1_OFFSET + (i-1)*4096/6.
// The encoder is absolute, so no power-on alignment ritual, and every move is
// verified by reading the position back — a failed/jammed move reaches the app.
// 1 = true one-wire: servo DATA on a single GPIO (UART TX+RX muxed onto the same
//     pad via the GPIO matrix, open-drain + pull-up; no external parts. If comms
//     are flaky at 1 Mbaud, add a 1-2.2k pull-up from DATA to 3.3V).
// 0 = two ESP pins (via Bus Servo Adapter, or TX through ~1k resistor to DATA).
#define STS_ONE_WIRE      1
#define STS_PIN           7      // one-wire mode: the single DATA pin (S3-Zero right row)
#define STS_TX            7      // two-pin mode (S3-Zero: 17/18 are bottom pads only)
#define STS_RX            8
#define STS_ID            1      // factory default servo ID
// Servo EEPROM was migrated from the factory 1 Mbaud to 115200 (2026-06-05):
// at 1M the one-wire bus off the internal pull-up dropped frames; at 115200 the
// bit time is ~9x the pull-up rise time and the bus is solid with no extra parts.
#define STS_BAUD          115200
#define STS_TICKS         4096
#define STS_SLOT1_OFFSET  0      // encoder ticks with slot 1 under the chute (calibrate once)
#define STS_SPEED         1000   // goal speed (servo units)
#define STS_ACC           50     // acceleration ramp (0=instant, 1-254)
#define STS_TOL           40     // arrival tolerance, ticks (~3.5 deg)
#define STS_TIMEOUT_MS    4000   // give up waiting for arrival after this

// --- revolver option B: MG90S 360 (continuous rotation) — open-loop fallback ---
// Pulse width sets SPEED (1500us = stop). One compartment = spin at a fixed
// slow speed for a calibrated time, then active-brake. The firmware tracks
// currentSlot; align the carousel to slot 1 at power-on.
#define REVOLVER_CH          8
#define REVOLVER_STOP_US     1500   // MG90S 360 neutral (deadband ~±40us)
#define REVOLVER_SPIN_US     1600   // slow forward; raise for faster/further per ms
#define REVOLVER_MS_PER_SLOT 500    // CALIBRATE: time for one compartment (60 deg)
#define REVOLVER_BRAKE_MS    150    // hold the stop pulse to brake before release

static int currentSlot = 0;   // tracks the revolver position to skip no-op rotations
static NimBLECharacteristic *statusChar = nullptr;
static bool bleConnected = false;

// --- onboard WS2812 status LED on GPIO21 (mirrors firmware-py/led.py) ---
//   advertising -> blue, connected -> green, busy -> white, error -> red.
// neopixelWrite is in the ESP32 core, so no extra dependency; best-effort.
#define LED_PIN 21
// This board's WS2812 expects Green-Red-Blue order, so swap R/G here — otherwise
// "green" shows up red (same fix as firmware-py/led.py). Callers use logical (r, g, b).
static inline void ledSet(uint8_t r, uint8_t g, uint8_t b) { neopixelWrite(LED_PIN, g, r, b); }
static inline void ledOff()         { ledSet(0, 0, 0); }
static inline void ledAdvertising() { ledSet(0, 0, 40); }    // blue
static inline void ledConnected()   { ledSet(0, 40, 0); }    // green
static inline void ledBusy()        { ledSet(60, 60, 60); }  // white
static inline void ledError()       { ledSet(60, 0, 0); }    // red

// --- runtime calibration ------------------------------------------------------
// Per-build mechanical values. They default to the #defines above and are set
// ONCE through the serial console ({"cmd":"cal",...}) — never by voice/BLE — then
// persisted to NVS so they survive a reboot. The actuation code reads these vars
// (not the #defines), so a calibrated value takes effect immediately on save.
static Preferences calPrefs;
static int calSlot1Offset  = STS_SLOT1_OFFSET;     // STS: encoder ticks, slot 1 under the chute
static int calMsPerSlot    = REVOLVER_MS_PER_SLOT; // PWM-360: ms to advance one compartment
static int calShutterOpen  = SHUTTER_OPEN;         // shutter open angle (deg)
static int calShutterClose = SHUTTER_CLOSED;       // shutter closed angle (deg)
static void calLoad() {
  calPrefs.begin("spicecal", true);                // read-only
  calSlot1Offset  = calPrefs.getInt("s1off",  STS_SLOT1_OFFSET);
  calMsPerSlot    = calPrefs.getInt("msps",   REVOLVER_MS_PER_SLOT);
  calShutterOpen  = calPrefs.getInt("shopen", SHUTTER_OPEN);
  calShutterClose = calPrefs.getInt("shcls",  SHUTTER_CLOSED);
  calPrefs.end();
  Serial.printf("cal loaded: s1off=%d msps=%d shopen=%d shcls=%d\n",
                calSlot1Offset, calMsPerSlot, calShutterOpen, calShutterClose);
}
static void calSave() {
  calPrefs.begin("spicecal", false);               // read-write
  calPrefs.putInt("s1off",  calSlot1Offset);
  calPrefs.putInt("msps",   calMsPerSlot);
  calPrefs.putInt("shopen", calShutterOpen);
  calPrefs.putInt("shcls",  calShutterClose);
  calPrefs.end();
}

// command handed from the BLE callback (host task) to loop() for actuation
static volatile bool hasCmd = false;
static String cmdBuf;
static portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;

static void notifyStatus(const char *json) {
  if (statusChar) { statusChar->setValue((uint8_t *)json, strlen(json)); statusChar->notify(); }
  Serial.printf("status: %s\n", json);
}

// --- PCA9685 minimal driver (ported register-for-register from pca9685.py) ---
// Every write checks the I2C ack. If the servo rail (DC input) is unpowered the
// PCA9685 NACKs everything — without this check the firmware "dispenses" happily
// while nothing moves, and the app shows a fake done.
static uint32_t i2cErrs = 0;   // failed transfers since boot
static uint8_t  lastI2cRc = 0; // last non-zero Wire.endTransmission() code (2 = addr NACK)
static void pcaWrite8(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(PCA9685_ADDR);
  Wire.write(reg); Wire.write(val);
  uint8_t rc = Wire.endTransmission();
  if (rc) { i2cErrs++; lastI2cRc = rc; }
}
static uint8_t pcaRead8(uint8_t reg) {
  Wire.beginTransmission(PCA9685_ADDR);
  Wire.write(reg);
  Wire.endTransmission();
  Wire.requestFrom((uint8_t)PCA9685_ADDR, (uint8_t)1);
  return Wire.available() ? Wire.read() : 0;
}
static void pcaSetFreq(int hz) {
  int prescale = (int)lround(25000000.0 / (4096.0 * hz)) - 1;
  uint8_t old = pcaRead8(PCA9685_MODE1);
  pcaWrite8(PCA9685_MODE1, (old & 0x7F) | 0x10);  // SLEEP before writing prescale
  pcaWrite8(PCA9685_PRESCALE, (uint8_t)prescale);
  pcaWrite8(PCA9685_MODE1, old);
  delay(5);
  pcaWrite8(PCA9685_MODE1, old | 0xA1);           // RESTART | AI
}
static void pcaSetPwm(int ch, int on, int off) {
  uint8_t base = PCA9685_LED0_ON_L + 4 * ch;
  Wire.beginTransmission(PCA9685_ADDR);
  Wire.write(base);
  Wire.write(on & 0xFF); Wire.write((on >> 8) & 0x0F);
  Wire.write(off & 0xFF); Wire.write((off >> 8) & 0x0F);
  uint8_t rc = Wire.endTransmission();
  if (rc) { i2cErrs++; lastI2cRc = rc; }
}
// Stop driving a channel entirely (PCA9685 full-off bit). With pulses gone a
// continuous-rotation servo stops and a positional servo just drops holding
// torque — so a 360 servo on the revolver can't spin forever after a move.
static void pcaChannelOff(int ch) {
  uint8_t base = PCA9685_LED0_ON_L + 4 * ch;
  Wire.beginTransmission(PCA9685_ADDR);
  Wire.write(base);
  Wire.write(0); Wire.write(0);
  Wire.write(0); Wire.write(0x10);   // LEDn_OFF_H bit4 = full off
  uint8_t rc = Wire.endTransmission();
  if (rc) { i2cErrs++; lastI2cRc = rc; }
}
static void pcaSetAngle(int ch, int deg) {
  // 50 Hz -> 20 ms period (4096 ticks). Servo pulse 0.5..2.4 ms.
  deg = constrain(deg, 0, 180);
  double us = 500 + (deg / 180.0) * 1900;
  int ticks = (int)(us / 20000.0 * 4096);
  pcaSetPwm(ch, 0, ticks);
}
static void pcaSetUs(int ch, int us) {          // raw pulse width — speed control on a 360 servo
  pcaSetPwm(ch, 0, (int)(us / 20000.0 * 4096));
}

// --- Feetech STS3215 minimal driver (instruction packets on Serial1) ---
// Frame: 0xFF 0xFF ID LEN INSTR PARAM... CHK, CHK = ~(ID+LEN+INSTR+sum(params)).
// PING=1 READ=2 WRITE=3; 16-bit values little-endian (STS series); 1 Mbaud.
// One-wire half-duplex: our own TX frame can echo back on RX, so stsReply()
// compares incoming frames against the one just sent and skips the echo.
static bool    stsOk = false;
static uint8_t stsTxBuf[16];
static int     stsTxLen = 0;

static void stsSend(uint8_t instr, const uint8_t *params, uint8_t plen) {
  int n = 0;
  stsTxBuf[n++] = 0xFF; stsTxBuf[n++] = 0xFF; stsTxBuf[n++] = STS_ID;
  stsTxBuf[n++] = plen + 2; stsTxBuf[n++] = instr;
  for (int i = 0; i < plen; i++) stsTxBuf[n++] = params[i];
  uint32_t sum = 0; for (int i = 2; i < n; i++) sum += stsTxBuf[i];
  stsTxBuf[n++] = ~sum & 0xFF;
  stsTxLen = n;
  while (Serial1.available()) Serial1.read();   // drop stale bytes
  Serial1.write(stsTxBuf, stsTxLen); Serial1.flush();
}
static int stsByte(uint32_t deadline) {
  while ((int32_t)(deadline - millis()) > 0)
    if (Serial1.available()) return Serial1.read();
  return -1;
}
static int stsFrame(uint8_t *out, int maxn, uint32_t deadline) {  // full frame incl header, or -1
  int ff = 0;
  for (;;) {
    int b = stsByte(deadline); if (b < 0) return -1;
    ff = (b == 0xFF) ? ff + 1 : 0;
    if (ff >= 2) break;
  }
  int id = stsByte(deadline), len = stsByte(deadline);
  if (id < 0 || len < 2 || 4 + len > maxn) return -1;
  out[0] = 0xFF; out[1] = 0xFF; out[2] = (uint8_t)id; out[3] = (uint8_t)len;
  for (int i = 0; i < len; i++) {
    int b = stsByte(deadline); if (b < 0) return -1;
    out[4 + i] = (uint8_t)b;
  }
  return 4 + len;
}
static bool stsReply(uint8_t *params, int want) {   // status frame: [FF FF ID LEN ERR p... CHK]
  uint8_t f[20];
  uint32_t dl = millis() + 60;
  for (int tries = 0; tries < 3; tries++) {
    int n = stsFrame(f, sizeof(f), dl);
    if (n < 0) return false;
    if (n == stsTxLen && memcmp(f, stsTxBuf, n) == 0) continue;  // our own echo
    // A corrupted self-echo slips past the exact-match filter above and used to
    // count as a servo reply — with NOTHING on the bus the boot ping "succeeded",
    // the firmware ran the STS revolver path and the real PWM servo on PCA ch8
    // never moved. Only a frame with our servo's ID and a valid checksum is real;
    // anything else is line noise — skip it and keep listening.
    uint32_t sum = 0; for (int i = 2; i < n - 1; i++) sum += f[i];
    if (f[2] != STS_ID || ((~sum) & 0xFF) != f[n - 1]) continue;  // mangled echo / noise
    for (int i = 0; i < want && 5 + i < n; i++) params[i] = f[5 + i];
    return true;
  }
  return false;
}
// The one-wire bus at 1 Mbaud off the internal pull-up is electrically marginal
// (slow rising edges) — individual frames can get corrupted, so every operation
// retries a few times. A 1-2.2k external pull-up from DATA to 3.3V makes the
// bus solid if retries still aren't enough.
#define STS_RETRIES 5
static bool stsPing() {
  for (int t = 0; t < STS_RETRIES; t++) { stsSend(1, nullptr, 0); if (stsReply(nullptr, 0)) return true; delay(2); }
  return false;
}
static bool stsWriteReg(uint8_t addr, const uint8_t *d, uint8_t n) {
  uint8_t p[12]; p[0] = addr; memcpy(p + 1, d, n);
  for (int t = 0; t < STS_RETRIES; t++) { stsSend(3, p, n + 1); if (stsReply(nullptr, 0)) return true; delay(2); }
  return false;
}
static int stsPresentPos() {
  uint8_t p[2] = { 56, 2 }, r[2] = { 0, 0 };
  for (int t = 0; t < STS_RETRIES; t++) {
    stsSend(2, p, 2);
    if (stsReply(r, 2)) return (r[0] | (r[1] << 8)) % STS_TICKS;
    delay(2);
  }
  return -1;
}

// Ping the bus and, if a servo answers, configure torque/acceleration/speed.
// Used at boot and by the serial {"cmd":"probe"} command (hot-plugged servo).
static bool stsProbe() {
  stsOk = stsPing() || stsPing() || stsPing();  // a couple of retries on a fresh bus
  if (stsOk) {
    uint8_t one = 1; stsWriteReg(40, &one, 1);  // torque on
    uint8_t acc = STS_ACC; stsWriteReg(41, &acc, 1);
    uint8_t spd[2] = { (uint8_t)(STS_SPEED & 0xFF), (uint8_t)(STS_SPEED >> 8) };
    stsWriteReg(46, spd, 2);                    // speed limit set once; moves are position-only
  }
  return stsOk;
}
// Raw absolute move with arrival verification against the encoder. Returns the
// final position, or -1 if the servo doesn't answer / never arrives.
static int stsGoto(int target) {
  target = ((target % STS_TICKS) + STS_TICKS) % STS_TICKS;
  // position-only write: the marginal one-wire bus drops long frames, so speed
  // and acceleration are configured once at boot and each move is 2 bytes.
  uint8_t d[2] = { (uint8_t)(target & 0xFF), (uint8_t)(target >> 8) };
  if (!stsWriteReg(42, d, 2)) return -1;
  uint32_t t0 = millis();
  while (millis() - t0 < STS_TIMEOUT_MS) {
    delay(50);
    int cur = stsPresentPos();
    if (cur < 0) continue;
    int dd = abs(cur - target); if (dd > STS_TICKS / 2) dd = STS_TICKS - dd;
    if (dd <= STS_TOL) return cur;
  }
  return -1;
}
// Slot move on the STS revolver. Returns false if the servo doesn't answer or
// never reaches the target (jam / power loss) — caller reports it.
static bool moveRevolverSts(int slot) {
  if (slot == currentSlot) return true;
  int target = (calSlot1Offset + (slot - 1) * STS_TICKS / NUM_SLOTS) % STS_TICKS;
  Serial.printf("  revolver -> compartment %d (STS pos %d)\n", slot, target);
  if (!stsOk) { Serial.println("  REVOLVER FAIL: STS3215 was not found at boot"); return false; }
  if (stsGoto(target) < 0) { Serial.println("  REVOLVER FAIL: target not reached (jammed? servo power?)"); return false; }
  currentSlot = slot;
  return true;
}
static bool moveRevolverPwm(int slot) {
  if (slot == currentSlot) return true;         // already there
  // always step forward, wrapping (open-loop: backlash-free single direction)
  int steps = (slot - currentSlot + NUM_SLOTS) % NUM_SLOTS;
  Serial.printf("  revolver -> compartment %d (%d step%s @ %d ms)\n",
                slot, steps, steps == 1 ? "" : "s", calMsPerSlot);
  pcaSetUs(REVOLVER_CH, REVOLVER_SPIN_US);
  delay((uint32_t)steps * calMsPerSlot);
  pcaSetUs(REVOLVER_CH, REVOLVER_STOP_US);      // active brake at neutral
  delay(REVOLVER_BRAKE_MS);
  pcaChannelOff(REVOLVER_CH);                   // then release the channel entirely
  currentSlot = slot;
  return true;
}

// runtime dispatch: STS revolver if one answered at boot, PWM-360 otherwise
static bool moveRevolver(int slot) {
  return stsOk ? moveRevolverSts(slot) : moveRevolverPwm(slot);
}
static void sweeps(int n) {
  for (int i = 0; i < n; i++) {
    Serial.printf("  sweep %d/%d\n", i + 1, n);
    pcaSetAngle(SHUTTER_CH, calShutterOpen);  delay(SHUTTER_DWELL_MS);
    pcaSetAngle(SHUTTER_CH, calShutterClose); delay(SHUTTER_DWELL_MS);
  }
  pcaChannelOff(SHUTTER_CH);                    // release after the final close
}
// One command step: notify running, then actuate. Returns false on a bad slot
// (mirrors dispenser.dispense() raising on an unknown slot). No per-step "done"
// — the batch emits a single "done" at the end, like ble_server.py _command_loop.
static bool stepCmd(int slot, int units) {
  char buf[48]; snprintf(buf, sizeof(buf), "{\"status\":\"running\",\"slot\":%d}", slot);
  notifyStatus(buf); ledBusy();
  if (slot < 1 || slot > 6) { notifyStatus("{\"status\":\"error\",\"msg\":\"unknown slot\"}"); ledError(); return false; }
  uint32_t errsBefore = i2cErrs;
  if (!moveRevolver(slot)) {
    notifyStatus("{\"status\":\"error\",\"msg\":\"revolver not responding - check servo power\"}");
    ledError(); return false;
  }
  sweeps(max(1, units));
  // Servo writes NACKed → nothing physically moved. Say so instead of "done".
  if (i2cErrs > errsBefore) {
    Serial.printf("  I2C FAIL: %lu errors this step (last rc=%u) — servo rail powered?\n",
                  (unsigned long)(i2cErrs - errsBefore), lastI2cRc);
    notifyStatus("{\"status\":\"error\",\"msg\":\"servos not responding - check dispenser power\"}");
    ledError(); return false;
  }
  return true;
}

static void handle(const String &json) {
  Serial.printf("cmd: %s\n", json.c_str());
  JsonDocument doc;
  if (deserializeJson(doc, json)) { notifyStatus("{\"status\":\"error\",\"msg\":\"bad json\"}"); ledError(); return; }
  // Accept short keys (s/d, sent one step per write to fit the 20-byte BLE
  // payload) and the long form (slot/dose_units) for compatibility — the chained
  // `|` falls back variant->variant->literal (mirrors ble_server.py _command_loop).
  // A single object is treated as a one-element batch; a recipe array runs every
  // step, then ONE "done" — stopping early if a step fails (the for/else in Python).
  bool ok = true;
  if (doc.is<JsonArray>()) {
    for (JsonObject o : doc.as<JsonArray>())
      if (!stepCmd(o["s"] | o["slot"] | 0, o["d"] | o["dose_units"] | 1)) { ok = false; break; }
  } else {
    ok = stepCmd(doc["s"] | doc["slot"] | 0, doc["d"] | doc["dose_units"] | 1);
  }
  if (ok) { notifyStatus("{\"status\":\"done\"}"); ledConnected(); }
}

// --- USB-serial control console -----------------------------------------------
// JSON lines on Serial, same dialect as the BLE command characteristic, so any
// terminal / script / Web-Serial page can drive the hardware without a phone:
//   {"slot":3,"dose_units":1}        dispense (objects and arrays, like BLE)
//   {"cmd":"status"}                 one-line JSON state report
//   {"cmd":"probe"}                  re-scan STS bus + PCA (hot-plugged servo)
//   {"cmd":"sts"} / {"cmd":"sts","pos":2048}   read / move the bus servo raw
//   {"cmd":"pca","ch":8,"us":1600|"deg":90|"off":true}   raw PWM channel
//   {"cmd":"led","r":0,"g":40,"b":0}            LED override
//   {"cmd":"cal"}                               read persisted calibration
//   {"cmd":"cal","slot1_offset":N,"ms_per_slot":N,"shutter_open":N,"shutter_closed":N}
//                                               set any subset + persist to NVS
//   {"cmd":"cal","home":true}                   slot1_offset = current encoder
//   {"cmd":"cal","reset":true}                  restore #define defaults
// Replies are single-line JSON with an "ok" field; tools/serial-console.html is
// the browser front-end.
static void serialReply(bool ok, const char *fmt = nullptr, ...) {
  char extra[256] = "";   // status report is ~165 chars; 160 truncated it (broken JSON)
  if (fmt) { va_list ap; va_start(ap, fmt); vsnprintf(extra, sizeof(extra), fmt, ap); va_end(ap); }
  Serial.printf("{\"ok\":%s%s%s}\n", ok ? "true" : "false", fmt ? "," : "", extra);
}
static void serialStatus() {
  // live reads, not cached: encoder position and a fresh PCA ack probe
  int pos = stsOk ? stsPresentPos() : -1;
  Wire.beginTransmission(PCA9685_ADDR);
  bool pcaAck = Wire.endTransmission() == 0;
  serialReply(true,
      "\"cmd\":\"status\",\"mode\":\"%s\",\"stsOk\":%s,\"stsPos\":%d,\"slot\":%d,"
      "\"pcaAck\":%s,\"i2cErrs\":%lu,\"lastI2cRc\":%u,\"ble\":%s,\"uptimeMs\":%lu,"
      "\"build\":\"" __DATE__ " " __TIME__ "\"",
      stsOk ? "sts" : "pwm", stsOk ? "true" : "false", pos, currentSlot,
      pcaAck ? "true" : "false", (unsigned long)i2cErrs, lastI2cRc,
      bleConnected ? "true" : "false", (unsigned long)millis());
}
static void handleSerialLine(const String &line) {
  JsonDocument doc;
  if (deserializeJson(doc, line)) { serialReply(false, "\"msg\":\"bad json\""); return; }
  if (!doc["cmd"].is<const char *>()) { handle(line); return; }  // dispense — exact BLE path
  String cmd = doc["cmd"].as<const char *>();
  if (cmd == "status") { serialStatus(); return; }
  if (cmd == "probe") {
    Wire.beginTransmission(PCA9685_ADDR);
    bool pcaAck = Wire.endTransmission() == 0;
    bool found = stsProbe();
    serialReply(true, "\"cmd\":\"probe\",\"stsOk\":%s,\"pcaAck\":%s",
                found ? "true" : "false", pcaAck ? "true" : "false");
    return;
  }
  if (cmd == "sts") {
    if (!stsOk) { serialReply(false, "\"msg\":\"no STS servo - try probe\""); return; }
    if (doc["pos"].is<int>()) {
      int got = stsGoto(doc["pos"].as<int>());
      currentSlot = 0;                          // raw move desyncs the slot tracker
      if (got < 0) serialReply(false, "\"msg\":\"target not reached (jam? power?)\"");
      else serialReply(true, "\"cmd\":\"sts\",\"pos\":%d", got);
    } else {
      int pos = stsPresentPos();
      if (pos < 0) serialReply(false, "\"msg\":\"no reply from STS3215\"");
      else serialReply(true, "\"cmd\":\"sts\",\"pos\":%d", pos);
    }
    return;
  }
  if (cmd == "pca") {
    int ch = doc["ch"] | -1;
    if (ch < 0 || ch > 15) { serialReply(false, "\"msg\":\"ch must be 0-15\""); return; }
    uint32_t errsBefore = i2cErrs;
    if (doc["off"] | false)            pcaChannelOff(ch);
    else if (doc["us"].is<int>())      pcaSetUs(ch, constrain(doc["us"].as<int>(), 500, 2500));
    else if (doc["deg"].is<int>())     pcaSetAngle(ch, doc["deg"].as<int>());
    else { serialReply(false, "\"msg\":\"need us, deg or off\""); return; }
    if (ch == REVOLVER_CH) currentSlot = 0;     // raw spin desyncs the slot tracker
    if (i2cErrs > errsBefore) serialReply(false, "\"msg\":\"PCA9685 NACK - servo rail powered?\"");
    else serialReply(true, "\"cmd\":\"pca\",\"ch\":%d", ch);
    return;
  }
  if (cmd == "led") {
    ledSet(doc["r"] | 0, doc["g"] | 0, doc["b"] | 0);
    serialReply(true, "\"cmd\":\"led\"");
    return;
  }
  if (cmd == "cal") {
    // Apply any provided fields; missing fields are left untouched. "home" snaps
    // slot1_offset to wherever the carousel sits NOW (jog there first with
    // {"cmd":"sts","pos":N}), "reset" restores the build defaults.
    bool changed = false;
    if (doc["home"] | false) {
      if (!stsOk) { serialReply(false, "\"msg\":\"no STS servo - home needs the bus servo\""); return; }
      int pos = stsPresentPos();
      if (pos < 0) { serialReply(false, "\"msg\":\"no reply from STS3215\""); return; }
      calSlot1Offset = pos; changed = true;
    }
    if (doc["reset"] | false) {
      calSlot1Offset = STS_SLOT1_OFFSET; calMsPerSlot = REVOLVER_MS_PER_SLOT;
      calShutterOpen = SHUTTER_OPEN; calShutterClose = SHUTTER_CLOSED; changed = true;
    }
    if (doc["slot1_offset"].is<int>())   { calSlot1Offset  = ((doc["slot1_offset"].as<int>() % STS_TICKS) + STS_TICKS) % STS_TICKS; changed = true; }
    if (doc["ms_per_slot"].is<int>())    { calMsPerSlot    = constrain(doc["ms_per_slot"].as<int>(), 50, 5000); changed = true; }
    if (doc["shutter_open"].is<int>())   { calShutterOpen  = constrain(doc["shutter_open"].as<int>(), 0, 180); changed = true; }
    if (doc["shutter_closed"].is<int>()) { calShutterClose = constrain(doc["shutter_closed"].as<int>(), 0, 180); changed = true; }
    if (changed) calSave();
    serialReply(true, "\"cmd\":\"cal\",\"slot1_offset\":%d,\"ms_per_slot\":%d,"
                "\"shutter_open\":%d,\"shutter_closed\":%d,\"saved\":%s",
                calSlot1Offset, calMsPerSlot, calShutterOpen, calShutterClose,
                changed ? "true" : "false");
    return;
  }
  serialReply(false, "\"msg\":\"unknown cmd\"");
}
static void pollSerial() {
  static String buf;
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (buf.length()) { handleSerialLine(buf); buf = ""; }
    } else if (buf.length() < 512) buf += c;
  }
}

class CmdCB : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic *c, NimBLEConnInfo &) override {
    std::string v = c->getValue();
    portENTER_CRITICAL(&mux); cmdBuf = String(v.c_str()); hasCmd = true; portEXIT_CRITICAL(&mux);
  }
};
class SrvCB : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer *, NimBLEConnInfo &) override { bleConnected = true; Serial.println("BLE: connected"); ledConnected(); }
  void onDisconnect(NimBLEServer *, NimBLEConnInfo &, int) override {
    bleConnected = false;
    Serial.println("BLE: disconnected, re-advertising"); ledAdvertising(); NimBLEDevice::startAdvertising();
  }
};

void setup() {
  Serial.begin(115200); delay(300);
  calLoad();   // pull persisted calibration from NVS before homing uses it
  // Bring up the PCA9685 on I2C(0) and home the servos (mirrors Dispenser.init):
  // revolver to compartment 1, shutter closed, then let it settle.
  Wire.begin(I2C_SDA, I2C_SCL, I2C_FREQ);
  // Probe the PCA9685 before homing — tells us at boot whether the servo driver
  // is even alive (NO ACK here = servo rail / DC input has no power).
  Wire.beginTransmission(PCA9685_ADDR);
  uint8_t probe = Wire.endTransmission();
  Serial.printf("PCA9685 probe @0x40: %s (rc=%u)\n",
                probe == 0 ? "ACK" : "NO ACK - check servo/DC power", probe);
  pcaWrite8(PCA9685_MODE1, 0x00); delay(5);
  pcaSetFreq(50);
  pcaSetAngle(SHUTTER_CH, calShutterClose);
  delay(SHUTTER_DWELL_MS);
  pcaChannelOff(SHUTTER_CH);                    // don't leave pulses running after homing

#if REVOLVER_USE_STS3215
  // STS3215 has an absolute encoder: ping the bus, enable torque, home for real.
#if STS_ONE_WIRE
  // Single-wire half-duplex: route both U1 TX and RX onto the same pad. The pad
  // runs open-drain with pull-up, so the ESP only ever pulls low and the servo
  // can drive the line when replying. We hear our own TX (handled in stsReply).
  Serial1.begin(STS_BAUD, SERIAL_8N1, STS_PIN, STS_PIN);
  gpio_set_pull_mode((gpio_num_t)STS_PIN, GPIO_PULLUP_ONLY);
  gpio_set_direction((gpio_num_t)STS_PIN, GPIO_MODE_INPUT_OUTPUT_OD);
  esp_rom_gpio_connect_out_signal(STS_PIN, UART_PERIPH_SIGNAL(1, SOC_UART_TX_PIN_IDX), false, false);
  esp_rom_gpio_connect_in_signal(STS_PIN, UART_PERIPH_SIGNAL(1, SOC_UART_RX_PIN_IDX), false);
#else
  Serial1.begin(STS_BAUD, SERIAL_8N1, STS_RX, STS_TX);
#endif
  if (stsProbe()) {
    Serial.printf("revolver mode: STS3215 closed-loop (present pos %d)\n", stsPresentPos());
    currentSlot = 0;                            // force the homing move
    if (!moveRevolver(1)) Serial.println("STS3215: homing move FAILED");
  }
#endif
  if (!stsOk) {
    // No STS detected: PWM-360 fallback on PCA ch8. Open-loop — no homing
    // possible, boot position IS slot 1; align the carousel at power-on.
    Serial.println("revolver mode: PWM-360 open-loop on PCA ch8 (align carousel to slot 1)");
  }
  currentSlot = 1;
  Serial.printf("SpiceDispenser: servos homed (i2c errors so far: %lu)\n", (unsigned long)i2cErrs);

  NimBLEDevice::init(DEVICE_NAME);
  NimBLEServer *server = NimBLEDevice::createServer();
  server->setCallbacks(new SrvCB());
  NimBLEService *svc = server->createService(SERVICE_UUID);
  NimBLECharacteristic *cmd = svc->createCharacteristic(
      CMD_UUID, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
  cmd->setCallbacks(new CmdCB());
  statusChar = svc->createCharacteristic(
      STATUS_UUID, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  statusChar->setValue("{\"status\":\"idle\"}");
  svc->start();

  // The phone discovers us by NAME (unfiltered scan, matched client-side), and
  // Android resolves device.name from the PRIMARY advertisement far more reliably
  // than from the scan response. So Flags + Complete Local Name go in the primary
  // packet, and the 128-bit service UUID (only needed for GATT) in the scan
  // response. Mirrors firmware-py/ble_adv.py build_payloads.
  NimBLEAdvertisementData advData;
  advData.setFlags(0x06);
  advData.setName(DEVICE_NAME);
  NimBLEAdvertisementData scanResp;
  scanResp.addServiceUUID(NimBLEUUID(SERVICE_UUID));
  NimBLEAdvertising *adv = NimBLEDevice::getAdvertising();
  adv->setAdvertisementData(advData);
  adv->setScanResponseData(scanResp);
  adv->enableScanResponse(true);
  adv->setMinInterval(400); adv->setMaxInterval(400);  // 400 * 0.625ms = 250ms (matches _ADV_INTERVAL_US)
  NimBLEDevice::startAdvertising();
  ledAdvertising();  // blue: waiting for a phone
  Serial.printf("BLE: advertising as \"%s\"\n", DEVICE_NAME);
}

void loop() {
  if (hasCmd) {
    String j;
    portENTER_CRITICAL(&mux); j = cmdBuf; hasCmd = false; portEXIT_CRITICAL(&mux);
    handle(j);
  }
  pollSerial();   // USB-serial control console (same JSON dialect as BLE)
  delay(20);
}
