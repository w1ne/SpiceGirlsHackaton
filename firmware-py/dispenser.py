import time
from pca9685 import PCA9685


REVOLVER_CH = 8
SHUTTER_CH = 12

SHUTTER_CLOSED = 20
SHUTTER_OPEN = 120
SHUTTER_DWELL_MS = 300
ROTATE_SETTLE_MS = 600


SLOT_ANGLES = {
    1: 15,
    2: 45,
    3: 75,
    4: 105,
    5: 135,
    6: 165,
}


class Dispenser:
    def __init__(self, i2c):
        self.pca = PCA9685(i2c)
        self.current_slot = None
        self.init()

    def init(self):
        self.pca.set_angle(REVOLVER_CH, SLOT_ANGLES[1])
        self.pca.set_angle(SHUTTER_CH, SHUTTER_CLOSED)
        self.current_slot = 1
        time.sleep_ms(ROTATE_SETTLE_MS)

    def dispense(self, slot, units=1):
        if slot not in SLOT_ANGLES:
            raise ValueError("unknown slot {}".format(slot))
        self._rotate_to(slot)
        for _ in range(max(1, int(units))):
            self._open_shutter()
            self._close_shutter()

    def _rotate_to(self, slot):
        if slot == self.current_slot:
            return
        self.pca.set_angle(REVOLVER_CH, SLOT_ANGLES[slot])
        self.current_slot = slot
        time.sleep_ms(ROTATE_SETTLE_MS)

    def _open_shutter(self):
        self.pca.set_angle(SHUTTER_CH, SHUTTER_OPEN)
        time.sleep_ms(SHUTTER_DWELL_MS)

    def _close_shutter(self):
        self.pca.set_angle(SHUTTER_CH, SHUTTER_CLOSED)
        time.sleep_ms(SHUTTER_DWELL_MS)
