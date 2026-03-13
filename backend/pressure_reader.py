import os, json, time
import board, busio
import adafruit_ads1x15.ads1115 as ADS1115
from adafruit_ads1x15.analog_in import AnalogIn

ADS_ADDR      = int(os.getenv("PRESSURE_ADS_ADDR",       "0x48"), 16)
DIVIDER_RATIO = float(os.getenv("PRESSURE_DIVIDER_RATIO", "0.6667"))

# Calibrated from your real sensor:
# 0 PSI   → v_adc = 0.900V → v_sensor = 1.350V
# 300 PSI → v_sensor scales up by same ratio as datasheet span
# Datasheet span: 4.5 - 0.5 = 4.0V over 300 PSI
# Your sensor V_MIN = 1.35V, so V_MAX = 1.35 + 4.0 = 5.35V
# BUT after divider: V_MAX_adc = 5.35 * 0.6667 = 3.567V — safe for ADS1115 ✅
V_MIN         = float(os.getenv("PRESSURE_V_MIN",         "1.35"))
V_MAX         = float(os.getenv("PRESSURE_V_MAX",         "5.35"))
P_MIN         = float(os.getenv("PRESSURE_P_MIN",         "0.0"))
P_MAX         = float(os.getenv("PRESSURE_P_MAX",         "300.0"))
SAMPLE_PERIOD = float(os.getenv("PRESSURE_SAMPLE_PERIOD", "2.0"))
AVERAGE_N     = int(os.getenv("PRESSURE_AVERAGE_N",       "10"))

def clamp(x, lo, hi):
    return lo if x < lo else hi if x > hi else x

def volts_to_psi(v_sensor):
    psi = (v_sensor - V_MIN) * (P_MAX - P_MIN) / (V_MAX - V_MIN) + P_MIN
    return clamp(psi, P_MIN, P_MAX)

def read_average(a0, n=10):
    readings = []
    for _ in range(n):
        try:
            v = float(a0.voltage)
            if 0.0 <= v <= 4.0:
                readings.append(v)
        except Exception:
            pass
        time.sleep(0.05)
    if not readings:
        return None
    if len(readings) >= 5:
        readings = sorted(readings)[1:-1]
    return sum(readings) / len(readings)

def main():
    i2c = busio.I2C(board.SCL, board.SDA)
    ads = ADS1115.ADS1115(i2c, address=ADS_ADDR)
    ads.gain = 1

    a0 = AnalogIn(ads, 0)  # A0 = pressure (A1 = anemometer)

    last_good_psi = 0.0

    while True:
        try:
            v_adc = read_average(a0, AVERAGE_N)

            if v_adc is None:
                msg = {
                    "ts":       int(time.time() * 1000),
                    "v_adc":    None,
                    "v_sensor": None,
                    "psi":      last_good_psi,
                    "status":   "no_reading",
                }
            else:
                v_sensor = v_adc / DIVIDER_RATIO
                psi      = volts_to_psi(v_sensor)
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