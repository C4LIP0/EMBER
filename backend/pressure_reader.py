#!/usr/bin/env python3
"""
pressure_reader.py — AUTEX 150 PSI sensor on ADS1115 A0
Sensor specs: 0.5V @ 0 PSI, 4.5V @ 150 PSI (ratiometric, 5V supply)
Wiring:
  Red   → 5V
  White → GND
  Black → signal → [10kΩ R1] → A0 → [10kΩ R2a] → [10kΩ R2b] → GND
  Divider ratio: 20k/(10k+20k) = 0.6667
  Max V_adc: 4.5 × 0.6667 = 3.0V  (safe for ADS1115 gain=1)
"""

import os, json, time, sys
import board, busio
import adafruit_ads1x15.ads1115 as ADS1115
from adafruit_ads1x15.analog_in import AnalogIn

# ── Config from env ───────────────────────────────────────────────────────
ADS_ADDR      = int  (os.getenv("PRESSURE_ADS_ADDR",      "0x48"), 16)
DIVIDER_RATIO = float(os.getenv("PRESSURE_DIVIDER_RATIO", "0.6667"))  # 20k/(10k+20k)
V_MIN         = float(os.getenv("PRESSURE_V_MIN",         "0.5"))     # sensor volts @ 0 PSI
V_MAX         = float(os.getenv("PRESSURE_V_MAX",         "4.5"))     # sensor volts @ 150 PSI
P_MIN         = float(os.getenv("PRESSURE_P_MIN",         "0.0"))
P_MAX         = float(os.getenv("PRESSURE_P_MAX",         "150.0"))
SAMPLE_PERIOD = float(os.getenv("PRESSURE_SAMPLE_PERIOD", "0.5"))     # seconds between readings
AVERAGE_N     = int  (os.getenv("PRESSURE_AVERAGE_N",     "8"))       # samples to average

# V_adc limits (after divider): anything outside this is noise/error
V_ADC_MIN = V_MIN * DIVIDER_RATIO * 0.85   # ~0.28V — slightly below 0 PSI
V_ADC_MAX = V_MAX * DIVIDER_RATIO * 1.05   # ~3.15V — slightly above 150 PSI

def clamp(x, lo, hi):
    return lo if x < lo else hi if x > hi else x

def volts_to_psi(v_sensor):
    psi = (v_sensor - V_MIN) * (P_MAX - P_MIN) / (V_MAX - V_MIN) + P_MIN
    return clamp(psi, P_MIN, P_MAX)

def read_average(chan, n):
    """Take n rapid samples, reject outliers, return average voltage."""
    readings = []
    for _ in range(n):
        try:
            v = float(chan.voltage)
            if V_ADC_MIN <= v <= V_ADC_MAX:
                readings.append(v)
        except Exception:
            pass
        time.sleep(0.02)  # 20ms between samples

    if not readings:
        return None

    # Trim 1 outlier each side if we have enough samples
    if len(readings) >= 5:
        readings = sorted(readings)[1:-1]

    return sum(readings) / len(readings)

def main():
    try:
        i2c = busio.I2C(board.SCL, board.SDA)
        ads = ADS1115.ADS1115(i2c, address=ADS_ADDR)
        ads.gain = 1  # ±4.096V range — max V_adc=3.0V so we're safe
        chan = AnalogIn(ads, 0)  # A0 = pressure sensor
    except Exception as e:
        print(json.dumps({"ts": 0, "status": "error", "error": f"ADS1115 init failed: {e}"}), flush=True)
        sys.exit(1)

    last_good_psi = 0.0

    while True:
        try:
            v_adc = read_average(chan, AVERAGE_N)

            if v_adc is None:
                msg = {
                    "ts":       int(time.time() * 1000),
                    "v_adc":    None,
                    "v_sensor": None,
                    "psi":      last_good_psi,
                    "status":   "no_reading",
                }
            else:
                v_sensor      = v_adc / DIVIDER_RATIO
                psi           = volts_to_psi(v_sensor)
                last_good_psi = psi
                msg = {
                    "ts":       int(time.time() * 1000),
                    "v_adc":    round(v_adc,    4),
                    "v_sensor": round(v_sensor, 4),
                    "psi":      round(psi,      2),
                    "status":   "ok",
                }

            print(json.dumps(msg), flush=True)

        except Exception as e:
            print(json.dumps({
                "ts":     int(time.time() * 1000),
                "psi":    last_good_psi,
                "status": "error",
                "error":  str(e),
            }), flush=True)

        time.sleep(SAMPLE_PERIOD)

if __name__ == "__main__":
    main()
