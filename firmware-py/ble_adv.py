# BLE advertising payload builder — pure functions, no MicroPython-only imports, so
# it runs under CPython for off-device tests (test_ble_adv.py) and on the ESP32.
#
# Layout rationale (why this exists instead of letting aioble pack the payload):
# the phone app discovers the dispenser by NAME — it scans unfiltered and matches
# `device.name` client-side. Android resolves `device.name` from the PRIMARY
# advertisement far more reliably than from the scan response. A 128-bit service
# UUID (18B) + the name (12B) + flags (3B) = 33B overflows the 31-byte advert, so
# they can't share the primary packet. Therefore:
#   primary advert  -> Flags + Complete Local Name   (so name-based discovery works)
#   scan response   -> 128-bit service UUID           (only needed for GATT, not scan)

_FLAGS = b"\x02\x01\x06"  # LE General Discoverable, BR/EDR not supported


def _name_ad(name):
    raw = name.encode()
    return bytes([1 + len(raw), 0x09]) + raw            # 0x09 = Complete Local Name


def _services128_ad(uuid_hex):
    raw = bytes.fromhex(uuid_hex.replace("-", ""))      # 16 bytes, big-endian
    le = bytes(reversed(raw))                           # advertising wants little-endian
    return bytes([1 + 16, 0x07]) + le                   # 0x07 = Complete list of 128-bit UUIDs


def build_payloads(name, uuid_hex):
    """Return (adv_data, resp_data) for aioble.advertise()."""
    adv = _FLAGS + _name_ad(name)
    resp = _services128_ad(uuid_hex)
    if len(adv) > 31:
        raise ValueError("primary adv payload too large: %d" % len(adv))
    if len(resp) > 31:
        raise ValueError("scan response payload too large: %d" % len(resp))
    return adv, resp
