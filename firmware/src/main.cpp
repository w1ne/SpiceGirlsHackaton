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

#define REVOLVER_CH      8
#define SHUTTER_CH       12
#define SHUTTER_CLOSED   20
#define SHUTTER_OPEN     120
#define SHUTTER_DWELL_MS 300
#define ROTATE_SETTLE_MS 600

// compartment select angles, 1-indexed (1..6) — matches SLOT_ANGLES
static const int SLOT_ANGLES[7] = { 0, 15, 45, 75, 105, 135, 165 };

static int currentSlot = 0;   // tracks the revolver position to skip no-op rotations
static NimBLECharacteristic *statusChar = nullptr;

// --- onboard WS2812 status LED on GPIO21 (mirrors firmware-py/led.py) ---
//   advertising -> blue, connected -> green, busy -> white, error -> red.
// neopixelWrite is in the ESP32 core, so no extra dependency; best-effort.
#define LED_PIN 21
static inline void ledSet(uint8_t r, uint8_t g, uint8_t b) { neopixelWrite(LED_PIN, r, g, b); }
static inline void ledOff()         { ledSet(0, 0, 0); }
static inline void ledAdvertising() { ledSet(0, 0, 40); }    // blue
static inline void ledConnected()   { ledSet(0, 40, 0); }    // green
static inline void ledBusy()        { ledSet(60, 60, 60); }  // white
static inline void ledError()       { ledSet(60, 0, 0); }    // red

// command handed from the BLE callback (host task) to loop() for actuation
static volatile bool hasCmd = false;
static String cmdBuf;
static portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;

static void notifyStatus(const char *json) {
  if (statusChar) { statusChar->setValue((uint8_t *)json, strlen(json)); statusChar->notify(); }
  Serial.printf("status: %s\n", json);
}

// --- PCA9685 minimal driver (ported register-for-register from pca9685.py) ---
static void pcaWrite8(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(PCA9685_ADDR);
  Wire.write(reg); Wire.write(val);
  Wire.endTransmission();
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
  Wire.endTransmission();
}
static void pcaSetAngle(int ch, int deg) {
  // 50 Hz -> 20 ms period (4096 ticks). Servo pulse 0.5..2.4 ms.
  deg = constrain(deg, 0, 180);
  double us = 500 + (deg / 180.0) * 1900;
  int ticks = (int)(us / 20000.0 * 4096);
  pcaSetPwm(ch, 0, ticks);
}

static void moveRevolver(int slot) {
  if (slot == currentSlot) return;              // already there; skip the settle wait
  int angle = SLOT_ANGLES[slot];
  Serial.printf("  revolver -> compartment %d (%d deg)\n", slot, angle);
  pcaSetAngle(REVOLVER_CH, angle); currentSlot = slot; delay(ROTATE_SETTLE_MS);
}
static void sweeps(int n) {
  for (int i = 0; i < n; i++) {
    Serial.printf("  sweep %d/%d\n", i + 1, n);
    pcaSetAngle(SHUTTER_CH, SHUTTER_OPEN);   delay(SHUTTER_DWELL_MS);
    pcaSetAngle(SHUTTER_CH, SHUTTER_CLOSED); delay(SHUTTER_DWELL_MS);
  }
}
// One command step: notify running, then actuate. Returns false on a bad slot
// (mirrors dispenser.dispense() raising on an unknown slot). No per-step "done"
// — the batch emits a single "done" at the end, like ble_server.py _command_loop.
static bool stepCmd(int slot, int units) {
  char buf[48]; snprintf(buf, sizeof(buf), "{\"status\":\"running\",\"slot\":%d}", slot);
  notifyStatus(buf); ledBusy();
  if (slot < 1 || slot > 6) { notifyStatus("{\"status\":\"error\",\"msg\":\"unknown slot\"}"); ledError(); return false; }
  moveRevolver(slot); sweeps(max(1, units));
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

class CmdCB : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic *c, NimBLEConnInfo &) override {
    std::string v = c->getValue();
    portENTER_CRITICAL(&mux); cmdBuf = String(v.c_str()); hasCmd = true; portEXIT_CRITICAL(&mux);
  }
};
class SrvCB : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer *, NimBLEConnInfo &) override { Serial.println("BLE: connected"); ledConnected(); }
  void onDisconnect(NimBLEServer *, NimBLEConnInfo &, int) override {
    Serial.println("BLE: disconnected, re-advertising"); ledAdvertising(); NimBLEDevice::startAdvertising();
  }
};

void setup() {
  Serial.begin(115200); delay(300);
  // Bring up the PCA9685 on I2C(0) and home the servos (mirrors Dispenser.init):
  // revolver to compartment 1, shutter closed, then let it settle.
  Wire.begin(I2C_SDA, I2C_SCL, I2C_FREQ);
  pcaWrite8(PCA9685_MODE1, 0x00); delay(5);
  pcaSetFreq(50);
  pcaSetAngle(REVOLVER_CH, SLOT_ANGLES[1]);
  pcaSetAngle(SHUTTER_CH, SHUTTER_CLOSED);
  currentSlot = 1; delay(ROTATE_SETTLE_MS);
  Serial.println("SpiceDispenser: servos homed");

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
  delay(20);
}
