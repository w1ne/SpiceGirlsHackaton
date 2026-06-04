#!/usr/bin/env python3
"""Test the SpiceDispenser BLE firmware from a laptop (BlueZ via bleak).
Scans for "SpiceGirls", connects, subscribes to status notifications, writes a
dispense command, and prints the status the device notifies back.

Run:  /tmp/blevenv/bin/python tools/ble_test.py
      /tmp/blevenv/bin/python tools/ble_test.py '[{"slot":0,"dose_units":2},{"slot":2,"dose_units":1}]'
"""
import asyncio, sys
from bleak import BleakScanner, BleakClient

NAME = "SpiceGirls"
SERVICE = "a1c20000-d8e4-4f9b-9b1a-2f3c4d5e6f70"
CMD = "a1c20001-d8e4-4f9b-9b1a-2f3c4d5e6f70"
STATUS = "a1c20002-d8e4-4f9b-9b1a-2f3c4d5e6f70"

cmd = sys.argv[1] if len(sys.argv) > 1 else '{"slot":1,"dose_units":2}'


async def main():
    print(f"scanning for '{NAME}' ...")
    dev = await BleakScanner.find_device_by_name(NAME, timeout=12.0)
    if not dev:
        print("NOT FOUND — is the S3 powered and advertising?"); return
    print(f"found {dev.name} [{dev.address}], connecting...")
    async with BleakClient(dev) as client:
        print("connected:", client.is_connected)

        def on_status(_, data: bytearray):
            print("   📩 status:", data.decode(errors="replace"))

        await client.start_notify(STATUS, on_status)
        print(f"writing command: {cmd}")
        await client.write_gatt_char(CMD, cmd.encode(), response=True)
        # wait for the device to actuate + notify running/done
        await asyncio.sleep(6.0)
        await client.stop_notify(STATUS)
        print("done.")


asyncio.run(main())
