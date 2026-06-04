// SpiceDispenser ESP32 firmware.
// WiFi -> Supabase (HTTPS). Atomically claims pending commands via the
// claim_command RPC, drives two servos (revolver select + dispense sweep),
// reports status, heartbeats. Mirrors tools/mock_device.py exactly.
//
// TLS note (hackathon): we use client.setInsecure() to skip cert-chain
// validation. This avoids shipping/refreshing a CA bundle on the MCU. Fine for
// a demo; for production pin the Supabase root CA instead.

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <ESP32Servo.h>
#include "secrets.h"

static Servo revolver;
static Servo dispenser;
static unsigned long lastHeartbeat = 0;

static String base() { return String("https://") + SUPABASE_HOST; }

static void addAuth(HTTPClient &http) {
  http.addHeader("apikey", SUPABASE_ANON);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);
  http.addHeader("Content-Type", "application/json");
}

// returns HTTP status; fills `out` with the response body
static int httpPost(const String &path, const String &body, String &out) {
  WiFiClientSecure client; client.setInsecure();
  HTTPClient http; http.begin(client, base() + path); addAuth(http);
  int code = http.POST(body); out = http.getString(); http.end();
  return code;
}
static int httpPatch(const String &path, const String &body) {
  WiFiClientSecure client; client.setInsecure();
  HTTPClient http; http.begin(client, base() + path); addAuth(http);
  int code = http.PATCH(body); http.end();
  return code;
}

static void connectWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.printf("WiFi: connecting to %s\n", WIFI_SSID);
  WiFi.mode(WIFI_STA); WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) { delay(400); Serial.print("."); }
  Serial.printf("\nWiFi: %s\n", WiFi.localIP().toString().c_str());
}

static void heartbeat() {
  String out;
  String body = String("[{\"device_id\":\"") + DEVICE_ID +
                "\",\"last_seen\":\"now()\"}]";
  // PostgREST upsert via merge-duplicates header would need extra header;
  // simplest: PATCH last_seen for our row.
  httpPatch(String("/rest/v1/devices?device_id=eq.") + DEVICE_ID,
            "{\"last_seen\":\"now()\"}");
  (void)out; (void)body;
}

static void moveRevolver(int slot) {
  int angle = SLOT0_ANGLE + slot * SLOT_STEP_DEG;
  angle = constrain(angle, 0, 180);
  Serial.printf("  revolver -> slot %d (%d deg)\n", slot, angle);
  revolver.write(angle);
  delay(600);
}

static void dispenseSweeps(int units) {
  for (int i = 0; i < units; i++) {
    Serial.printf("  sweep %d/%d\n", i + 1, units);
    dispenser.write(DISP_PUSH_ANGLE); delay(DISP_DWELL_MS);
    dispenser.write(DISP_REST_ANGLE); delay(DISP_DWELL_MS);
  }
}

static void finish(const char *id, const char *status, const char *err = nullptr) {
  String body = String("{\"status\":\"") + status + "\",\"updated_at\":\"now()\"";
  if (err) body += String(",\"error\":\"") + err + "\"";
  body += "}";
  httpPatch(String("/rest/v1/commands?id=eq.") + id, body);
}

// claim one pending command; returns true if one was handled
static bool pollOnce() {
  String out;
  int code = httpPost("/rest/v1/rpc/claim_command",
                      String("{\"p_device_id\":\"") + DEVICE_ID + "\"}", out);
  if (code != 200) { Serial.printf("claim http %d: %s\n", code, out.c_str()); return false; }

  JsonDocument doc;
  if (deserializeJson(doc, out)) return false;
  if (doc["id"].isNull()) return false;  // nothing pending

  const char *id = doc["id"];
  const char *type = doc["type"] | "dispense";
  Serial.printf("claimed %s (%s)\n", type, id);

  bool ok = true; const char *err = nullptr;
  if (strcmp(type, "dispense") == 0) {
    int slot = doc["payload"]["slot"] | 0;
    int units = doc["payload"]["dose_units"] | 1;
    moveRevolver(slot);
    dispenseSweeps(units);
  } else if (strcmp(type, "home") == 0) {
    moveRevolver(0);
  } else if (strcmp(type, "ping") == 0) {
    Serial.println("  ping");
  } else {
    ok = false; err = "unknown type";
  }
  finish(id, ok ? "done" : "error", err);
  Serial.println(ok ? "  done" : "  error");
  return true;
}

void setup() {
  Serial.begin(115200); delay(300);
  ESP32PWM::allocateTimer(0); ESP32PWM::allocateTimer(1);
  revolver.setPeriodHertz(50); dispenser.setPeriodHertz(50);
  revolver.attach(REVOLVER_PIN, 500, 2400);
  dispenser.attach(DISPENSE_PIN, 500, 2400);
  dispenser.write(DISP_REST_ANGLE); revolver.write(SLOT0_ANGLE);
  connectWifi();
  Serial.println("SpiceDispenser ready");
}

void loop() {
  connectWifi();
  if (millis() - lastHeartbeat > 10000) { heartbeat(); lastHeartbeat = millis(); }
  if (!pollOnce()) delay(1000);  // idle poll interval
}
