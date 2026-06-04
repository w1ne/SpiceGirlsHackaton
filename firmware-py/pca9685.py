import time


_MODE1 = 0x00
_PRESCALE = 0xFE
_LED0_ON_L = 0x06


class PCA9685:
    def __init__(self, i2c, addr=0x40, freq=50):
        self.i2c = i2c
        self.addr = addr
        self._w8(_MODE1, 0x00)
        time.sleep_ms(5)
        self.set_freq(freq)

    def _w8(self, reg, val):
        self.i2c.writeto_mem(self.addr, reg, bytes([val & 0xFF]))

    def _r8(self, reg):
        return self.i2c.readfrom_mem(self.addr, reg, 1)[0]

    def set_freq(self, hz):
        prescale = round(25_000_000 / (4096 * hz)) - 1
        old = self._r8(_MODE1)
        self._w8(_MODE1, (old & 0x7F) | 0x10)  # SLEEP before writing prescale
        self._w8(_PRESCALE, prescale)
        self._w8(_MODE1, old)
        time.sleep_ms(5)
        self._w8(_MODE1, old | 0xA1)  # RESTART | AI

    def set_pwm(self, ch, on, off):
        base = _LED0_ON_L + 4 * ch
        self.i2c.writeto_mem(
            self.addr, base,
            bytes([on & 0xFF, (on >> 8) & 0x0F, off & 0xFF, (off >> 8) & 0x0F]),
        )

    def set_angle(self, ch, deg):
        # 50 Hz → 20 ms period (4096 ticks). Servo pulse 0.5..2.4 ms.
        deg = max(0, min(180, deg))
        us = 500 + (deg / 180.0) * 1900
        ticks = int(us / 20000.0 * 4096)
        self.set_pwm(ch, 0, ticks)
