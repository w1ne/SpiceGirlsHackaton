# Pure-CPython test for the BLE advertising payload layout — no hardware / no
# MicroPython needed. It parses the AD structures and asserts the device NAME is in
# the PRIMARY advertisement (where the phone resolves device.name for its name-based
# discovery) and the 128-bit service UUID is in the scan response.
#
# Run:  python3 firmware-py/test_ble_adv.py
from ble_adv import build_payloads

NAME = "SpiceGirls"
UUID_HEX = "a1c20000d8e44f9b9b1a2f3c4d5e6f70"


def parse_ads(payload):
    """Return {ad_type: value_bytes} parsed from a BLE AD-structure payload."""
    out, i = {}, 0
    while i < len(payload):
        ln = payload[i]
        if ln == 0:
            break
        ad_type = payload[i + 1]
        value = payload[i + 2 : i + 1 + ln]
        assert len(value) == ln - 1, "AD length mismatch at %d" % i
        out[ad_type] = value
        i += 1 + ln
    return out


def test():
    adv, resp = build_payloads(NAME, UUID_HEX)

    assert len(adv) <= 31, "primary adv over 31 bytes: %d" % len(adv)
    assert len(resp) <= 31, "scan response over 31 bytes: %d" % len(resp)

    adv_ads = parse_ads(adv)
    resp_ads = parse_ads(resp)

    # Flags (0x01) belong only in the primary advertisement.
    assert 0x01 in adv_ads, "flags missing from primary adv"
    assert 0x01 not in resp_ads, "flags must NOT be in the scan response"

    # Complete Local Name (0x09) MUST be in the PRIMARY adv — this is the fix.
    assert 0x09 in adv_ads, "Complete Local Name not in PRIMARY adv (the root-cause bug)"
    assert adv_ads[0x09].decode() == NAME, "wrong name in adv: %r" % adv_ads[0x09]

    # 128-bit service UUID (0x07) lives in the scan response, little-endian.
    assert 0x07 in resp_ads, "128-bit service UUID not in scan response"
    expected = bytes(reversed(bytes.fromhex(UUID_HEX)))
    assert resp_ads[0x07] == expected, "service UUID bytes wrong"

    print("OK — name in primary adv (%dB), service UUID in scan response (%dB)" % (len(adv), len(resp)))


if __name__ == "__main__":
    test()
