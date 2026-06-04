#!/usr/bin/env python3
"""Fake ESP32 dispenser. Polls Supabase, claims commands atomically, 'actuates'.

Run:  python3 tools/mock_device.py
Reads SUPABASE_PROJECT_URL + SUPABASE_ANON_KEY from ../.env
Lets you test the phone app end-to-end before the real firmware is flashed.
"""
import json, os, time, urllib.request, urllib.error, pathlib

ENV = pathlib.Path(__file__).resolve().parent.parent / ".env"
cfg = {}
for line in ENV.read_text().splitlines():
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1); cfg[k] = v

URL = cfg["SUPABASE_PROJECT_URL"].rstrip("/")
KEY = cfg["SUPABASE_ANON_KEY"]
DEVICE = os.environ.get("DEVICE_ID", "dispenser-01")
H = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(URL + path, data=data, headers=H, method=method)
    try:
        with urllib.request.urlopen(req) as r:
            txt = r.read().decode()
            return r.status, (json.loads(txt) if txt else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def heartbeat():
    call("POST", "/rest/v1/devices",
         [{"device_id": DEVICE, "last_seen": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}])


def actuate(cmd):
    t = cmd.get("type")
    p = cmd.get("payload") or {}
    if t == "dispense":
        slot, units = p.get("slot"), p.get("dose_units", 1)
        print(f"  🔄 rotate revolver -> slot {slot}")
        for i in range(int(units)):
            print(f"  🥄 dispense sweep {i+1}/{units}")
            time.sleep(0.4)
    elif t == "home":
        print("  🏠 home revolver -> slot 0")
    elif t == "ping":
        print("  📍 ping")
    else:
        raise ValueError(f"unknown command type {t!r}")


def finish(cmd_id, status, error=None):
    body = {"status": status, "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    if error:
        body["error"] = error
    call("PATCH", f"/rest/v1/commands?id=eq.{cmd_id}", body)


def main():
    print(f"mock dispenser '{DEVICE}' polling {URL} … (Ctrl-C to stop)")
    last_hb = 0
    while True:
        now = time.time()
        if now - last_hb > 10:
            heartbeat(); last_hb = now
        st, cmd = call("POST", "/rest/v1/rpc/claim_command", {"p_device_id": DEVICE})
        if st == 200 and isinstance(cmd, dict) and cmd.get("id"):
            print(f"▶ claimed {cmd['type']} {cmd.get('payload')}  ({cmd['id'][:8]})")
            try:
                actuate(cmd); finish(cmd["id"], "done")
                print("  ✓ done")
            except Exception as e:
                finish(cmd["id"], "error", str(e))
                print("  ✗ error:", e)
        else:
            time.sleep(1.0)  # nothing pending


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nbye")
