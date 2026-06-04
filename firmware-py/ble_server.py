import json
import uasyncio as asyncio
import aioble
import bluetooth


_SERVICE_UUID = bluetooth.UUID("a1c20000-d8e4-4f9b-9b1a-2f3c4d5e6f70")
_CMD_UUID     = bluetooth.UUID("a1c20001-d8e4-4f9b-9b1a-2f3c4d5e6f70")
_STATUS_UUID  = bluetooth.UUID("a1c20002-d8e4-4f9b-9b1a-2f3c4d5e6f70")
_DEVICE_NAME  = "SpiceGirls"
_ADV_INTERVAL_US = 250_000

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
            async with await aioble.advertise(
                _ADV_INTERVAL_US,
                name=_DEVICE_NAME,
                services=[_SERVICE_UUID],
            ) as conn:
                print("BLE: connected", conn.device)
                await conn.disconnected()
                print("BLE: disconnected, re-advertising")
        except Exception as e:
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
            slot = c.get("slot", 0)
            units = c.get("dose_units", 1)
            _notify({"status": "running", "slot": slot})
            try:
                dispenser.dispense(slot, units)
            except Exception as e:
                _notify({"status": "error", "msg": str(e)})
                break
        else:
            _notify({"status": "done"})


async def run(dispenser):
    await asyncio.gather(
        _advertise_forever(),
        _command_loop(dispenser),
    )
