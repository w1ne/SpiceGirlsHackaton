import json
import uasyncio as asyncio
import aioble
import bluetooth

import led
from ble_adv import build_payloads


_SERVICE_UUID = bluetooth.UUID("a1c20000-d8e4-4f9b-9b1a-2f3c4d5e6f70")
_CMD_UUID     = bluetooth.UUID("a1c20001-d8e4-4f9b-9b1a-2f3c4d5e6f70")
_STATUS_UUID  = bluetooth.UUID("a1c20002-d8e4-4f9b-9b1a-2f3c4d5e6f70")
_DEVICE_NAME  = "SpiceGirls"
_ADV_INTERVAL_US = 250_000

# The phone app discovers the dispenser by NAME (it scans unfiltered and matches
# device.name client-side), so the name goes in the PRIMARY advertisement and the
# 128-bit service UUID — only needed for GATT — goes in the scan response. Full
# rationale in ble_adv.py; payload layout is covered by test_ble_adv.py.
_ADV_DATA, _RESP_DATA = build_payloads(_DEVICE_NAME, "a1c20000d8e44f9b9b1a2f3c4d5e6f70")

_service = aioble.Service(_SERVICE_UUID)
_cmd_char = aioble.Characteristic(_service, _CMD_UUID, write=True, capture=True)
_status_char = aioble.Characteristic(_service, _STATUS_UUID, read=True, notify=True)
aioble.register_services(_service)


def _notify(payload):
    s = json.dumps(payload)
    try:
        _status_char.write(s.encode(), send_update=True)
    except Exception as e:
        print("notify failed:", e)
    print("status:", s)


async def _advertise_forever():
    while True:
        try:
            led.advertising()  # blue: waiting for a phone
            async with await aioble.advertise(
                _ADV_INTERVAL_US,
                adv_data=_ADV_DATA,
                resp_data=_RESP_DATA,
                connectable=True,
            ) as conn:
                led.connected()  # green: phone connected, ready
                print("BLE: connected", conn.device)
                await conn.disconnected()
                print("BLE: disconnected, re-advertising")
        except Exception as e:
            led.error()  # red: advertising failed
            print("advertise error:", e)
            await asyncio.sleep_ms(500)


async def _command_loop(dispenser):
    while True:
        _, data = await _cmd_char.written()
        try:
            doc = json.loads(data)
        except Exception:
            _notify({"status": "error", "msg": "bad json"})
            continue

        cmds = doc if isinstance(doc, list) else [doc]
        for c in cmds:
            # Accept short keys (s/d, sent one step per write to fit the 20-byte
            # BLE payload) and the long form (slot/dose_units) for compatibility.
            slot = c.get("s", c.get("slot", 0))
            units = c.get("d", c.get("dose_units", 1))
            _notify({"status": "running", "slot": slot})
            led.busy()  # white: a command is running the motors
            try:
                dispenser.dispense(slot, units)
            except Exception as e:
                led.error()  # red: command failed
                _notify({"status": "error", "msg": str(e)})
                break
        else:
            led.connected()  # back to green: done, still connected
            _notify({"status": "done"})


async def run(dispenser):
    await asyncio.gather(
        _advertise_forever(),
        _command_loop(dispenser),
    )
