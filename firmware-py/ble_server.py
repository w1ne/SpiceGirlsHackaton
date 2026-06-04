import uasyncio as asyncio
import aioble
import bluetooth


_SERVICE_UUID = bluetooth.UUID("a1c20000-d8e4-4f9b-9b1a-2f3c4d5e6f70")
_SLOT_UUID    = bluetooth.UUID("a1c20001-d8e4-4f9b-9b1a-2f3c4d5e6f70")
_DOSE_UUID    = bluetooth.UUID("a1c20002-d8e4-4f9b-9b1a-2f3c4d5e6f70")
_STATE_UUID   = bluetooth.UUID("a1c20003-d8e4-4f9b-9b1a-2f3c4d5e6f70")

_DEVICE_NAME = "SpiceGirls"
_ADV_INTERVAL_US = 250_000

STATE_READY    = b"ready"
STATE_RUNNING  = b"running"
STATE_COMPLETE = b"complete"

_service = aioble.Service(_SERVICE_UUID)
_slot_char  = aioble.Characteristic(_service, _SLOT_UUID,  write=True, capture=True)
_dose_char  = aioble.Characteristic(_service, _DOSE_UUID,  write=True, capture=True)
_state_char = aioble.Characteristic(_service, _STATE_UUID, read=True,  notify=True)
aioble.register_services(_service)


_current_slot = 1  # обнулённая координата после init()


def _publish_state(payload):
    _state_char.write(payload, send_update=True)
    print("state:", payload.decode())


async def _advertise_forever():
    while True:
        try:
            async with await aioble.advertise(
                _ADV_INTERVAL_US,
                name=_DEVICE_NAME,
                services=[_SERVICE_UUID],
            ) as conn:
                print("BLE: connected", conn.device)

                _publish_state(STATE_READY)
                await conn.disconnected()
                print("BLE: disconnected, re-advertising")
        except Exception as e:
            print("advertise error:", e)
            await asyncio.sleep_ms(500)


async def _slot_loop():
    global _current_slot
    while True:
        _, data = await _slot_char.written()
        if not data:
            continue
        _current_slot = data[0]
        print("slot set:", _current_slot)


async def _dose_loop(dispenser):
    while True:
        _, data = await _dose_char.written()
        if not data:
            continue
        units = data[0]
        slot = _current_slot
        _publish_state(STATE_RUNNING)
        try:
            dispenser.dispense(slot, units)
        except Exception as e:
            print("dispense error:", e)
        else:
            _publish_state(STATE_COMPLETE)
        finally:
            await asyncio.sleep_ms(200)
            _publish_state(STATE_READY)


async def run(dispenser):
    _state_char.write(STATE_READY)
    await asyncio.gather(
        _advertise_forever(),
        _slot_loop(),
        _dose_loop(dispenser),
    )
