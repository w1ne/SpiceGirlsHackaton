# Onboard status LED — the WS2812 RGB pixel on the ESP32-S3-Zero (GPIO21). Lets you
# read the dispenser's state without the phone:
#   advertising (waiting for a phone) -> blue
#   connected   (idle, ready)         -> green
#   busy        (running a command)   -> white
#   error                             -> red
#
# Best-effort: on a board with no NeoPixel / a different pin, the import or write
# fails and every call becomes a no-op so it can NEVER take down the BLE server.
_LED_PIN = 21

try:
    from machine import Pin
    import neopixel
    _np = neopixel.NeoPixel(Pin(_LED_PIN), 1)
except Exception as e:  # no neopixel, wrong pin, etc.
    _np = None
    print("led: disabled (%s)" % e)


def _set(r, g, b):
    if _np is None:
        return
    try:
        _np[0] = (r, g, b)
        _np.write()
    except Exception:
        pass


# Brightness kept low — a WS2812 at full scale is blinding up close.
def off():         _set(0, 0, 0)
def advertising(): _set(0, 0, 40)    # blue
def connected():   _set(0, 40, 0)    # green
def busy():        _set(60, 60, 60)  # white
def error():       _set(60, 0, 0)    # red
def green_level(b): _set(0, b, 0)    # green at brightness b — used for the connected pulse
