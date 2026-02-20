#!/usr/bin/env python3
import os, json, time
from adafruit_extended_bus import ExtendedI2C as I2C
import adafruit_bno055

BUS  = int(os.getenv("IMU_BUS", "3"))
ADDR = int(os.getenv("IMU_ADDR", "0x29"), 16)
PERIOD = float(os.getenv("IMU_SAMPLE_PERIOD", "0.2"))

ROLL_OK  = float(os.getenv("IMU_ROLL_OK_DEG", "3.0"))
PITCH_OK = float(os.getenv("IMU_PITCH_OK_DEG", "3.0"))

def is_num(x):
    return isinstance(x, (int, float))

def read_loop(sensor):
    while True:
        ts = int(time.time() * 1000)

        euler = sensor.euler  # may raise OSError
        if euler and len(euler) == 3:
            heading, roll, pitch = euler
        else:
            heading = roll = pitch = None

        calib = None
        try:
            sysc, gy, ac, mg = sensor.calibration_status
            calib = {"sys": sysc, "g": gy, "a": ac, "m": mg}
        except Exception:
            pass

        aligned = None
        if is_num(roll) and is_num(pitch):
            aligned = (abs(roll) <= ROLL_OK) and (abs(pitch) <= PITCH_OK)

        msg = {
            "ts": ts,
            "bus": BUS,
            "addr": f"0x{ADDR:02X}",
            "heading": heading,
            "roll": roll,
            "pitch": pitch,
            "aligned": aligned,
            "calib": calib,
        }
        print(json.dumps(msg), flush=True)
        time.sleep(PERIOD)

def main():
    print(f"[imu] Using /dev/i2c-{BUS} addr=0x{ADDR:02X}", flush=True)
    while True:
        try:
            i2c = I2C(BUS)
            sensor = adafruit_bno055.BNO055_I2C(i2c, address=ADDR)

            # Give the chip a moment after init
            time.sleep(0.25)

            # Enter continuous read loop
            read_loop(sensor)

        except OSError as e:
            # Device not ACKing (wrong bus/addr, loose wire, ADR floating, etc.)
            print(f"[imu] I2C error: {e}. Retrying in 0.5s...", flush=True)
            time.sleep(0.5)
        except Exception as e:
            print(f"[imu] Error: {e}. Retrying in 1s...", flush=True)
            time.sleep(1.0)

if __name__ == "__main__":
    main()
