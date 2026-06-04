# SpiceDispenser — MicroPython firmware (ESP32-S3-Zero + PCA9685).
#
# Flash MicroPython, then copy files:
#   esptool.py --chip esp32s3 --port /dev/tty.usbmodem* erase_flash
#   esptool.py --chip esp32s3 --port /dev/tty.usbmodem* write_flash -z 0 \
#       ESP32_GENERIC_S3-*.bin
#   mpremote mip install aioble
#   mpremote cp pca9685.py dispenser.py ble_server.py main.py :
#   mpremote reset
#
# Wiring: PCA9685 SDA→GPIO8, SCL→GPIO9, VCC→3V3, GND→GND.
# Servos on PCA9685 channel 0 (revolver) and 1 (shutter); V+ → external 5V.
from time import sleep

import uasyncio as asyncio
from machine import Pin, I2C
from dispenser import Dispenser
import ble_server


I2C_SDA = 5
I2C_SCL = 6
I2C_FREQ = 400_000

def main():
    i2c = I2C(0, sda=Pin(I2C_SDA), scl=Pin(I2C_SCL), freq=I2C_FREQ)
    print("I2C scan:", [hex(a) for a in i2c.scan()])
    dispenser = Dispenser(i2c)
    print("dispenser ready, BLE advertising as SpiceGirls")
    # asyncio.run(ble_server.run(dispenser))

    dispenser.dispense(1)
    sleep(0.2)
    dispenser.dispense(2)
    sleep(0.2)
    dispenser.dispense(3)
    sleep(0.2)

main()
