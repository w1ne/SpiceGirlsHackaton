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
#include <ESP32Servo.h>
#include <ArduinoJson.h>

#define DEVICE_NAME   "SpiceGirls"
#define SERVICE_UUID  "a1c20000-d8e4-4f9b-9b1a-2f3c4d5e6f70"
#define CMD_UUID      "a1c20001-d8e4-4f9b-9b1a-2f3c4d5e6f70"
#define STATUS_UUID   "a1c20002-d8e4-4f9b-9b1a-2f3c4d5e6f70"

// --- servo wiring / geometry ---
#define REVOLVER_PIN     4
#define DISPENSE_PIN     5
#define SLOT0_ANGLE      15
#define SLOT_STEP_DEG    30   // 6 compartments * 30deg = 150deg span, fits 0..180
#define DISP_REST_ANGLE  20
#define DISP_PUSH_ANGLE  120
#define DISP_DWELL_MS    300

static Servo revolver, dispenser;
static NimBLECharacteristic *statusChar = nullptr;

// command handed from the BLE callback (host task) to loop() for actuation
static volatile bool hasCmd = false;
static String cmdBuf;
static portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;

static void notifyStatus(const char *json) {
  if (statusChar) { statusChar->setValue((uint8_t *)json, strlen(json)); statusChar->notify(); }
  Serial.printf("status: %s\n", json);
}

static void moveRevolver(int slot) {
  int idx = slot >= 1 ? slot - 1 : slot;   // compartments are 1-indexed (1..6)
  int angle = constrain(SLOT0_ANGLE + idx * SLOT_STEP_DEG, 0, 180);
  Serial.printf("  revolver -> compartment %d (%d deg)\n", slot, angle);
  revolver.write(angle); delay(600);
}
static void sweeps(int n) {
  for (int i = 0; i < n; i++) {
    Serial.printf("  sweep %d/%d\n", i + 1, n);
    dispenser.write(DISP_PUSH_ANGLE); delay(DISP_DWELL_MS);
    dispenser.write(DISP_REST_ANGLE); delay(DISP_DWELL_MS);
  }
}
static void doDispense(int slot, int units) {
  char buf[48]; snprintf(buf, sizeof(buf), "{\"status\":\"running\",\"slot\":%d}", slot);
  notifyStatus(buf);
  moveRevolver(slot); sweeps(units);
  notifyStatus("{\"status\":\"done\"}");
}

static void handle(const String &json) {
  Serial.printf("cmd: %s\n", json.c_str());
  JsonDocument doc;
  if (deserializeJson(doc, json)) { notifyStatus("{\"status\":\"error\",\"msg\":\"bad json\"}"); return; }
  if (doc.is<JsonArray>()) {
    for (JsonObject o : doc.as<JsonArray>()) doDispense(o["slot"] | 0, o["dose_units"] | 1);
  } else {
    doDispense(doc["slot"] | 0, doc["dose_units"] | 1);
  }
}

class CmdCB : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic *c, NimBLEConnInfo &) override {
    std::string v = c->getValue();
    portENTER_CRITICAL(&mux); cmdBuf = String(v.c_str()); hasCmd = true; portEXIT_CRITICAL(&mux);
  }
};
class SrvCB : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer *, NimBLEConnInfo &) override { Serial.println("BLE: connected"); }
  void onDisconnect(NimBLEServer *, NimBLEConnInfo &, int) override {
    Serial.println("BLE: disconnected, re-advertising"); NimBLEDevice::startAdvertising();
  }
};

void setup() {
  Serial.begin(115200); delay(300);
  ESP32PWM::allocateTimer(0); ESP32PWM::allocateTimer(1);
  revolver.setPeriodHertz(50); dispenser.setPeriodHertz(50);
  revolver.attach(REVOLVER_PIN, 500, 2400);
  dispenser.attach(DISPENSE_PIN, 500, 2400);
  dispenser.write(DISP_REST_ANGLE); revolver.write(SLOT0_ANGLE);
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

  // Service UUID (128-bit) fills the main adv packet, so put the name in the
  // scan response — that way the device shows as "SpiceGirls" in choosers.
  NimBLEAdvertisementData advData;
  advData.setFlags(0x06);
  advData.addServiceUUID(NimBLEUUID(SERVICE_UUID));
  NimBLEAdvertisementData scanResp;
  scanResp.setName(DEVICE_NAME);
  NimBLEAdvertising *adv = NimBLEDevice::getAdvertising();
  adv->setAdvertisementData(advData);
  adv->setScanResponseData(scanResp);
  adv->enableScanResponse(true);
  NimBLEDevice::startAdvertising();
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
