import os, json, time
import board, busio
import adafruit_ads1x15.ads1115 as ADS1115
from adafruit_ads1x15.analog_in import AnalogIn

ADS_ADDR      = int(os.getenv("ANEMO_ADS_ADDR",      "0x48"), 16)
V_MIN         = float(os.getenv("ANEMO_V_MIN",        "0.0"))
V_MAX         = float(os.getenv("ANEMO_V_MAX",        "3.33"))  # 5V * 0.6667 divider
WIND_MAX_MS   = float(os.getenv("ANEMO_WIND_MAX_MS",  "32.4"))
SAMPLE_PERIOD = float(os.getenv("ANEMO_SAMPLE_PERIOD","0.2"))

def clamp(x, lo, hi):
    return lo if x < lo else hi if x > hi else x

def volts_to_ms(v):
    ms = (v - V_MIN) * WIND_MAX_MS / (V_MAX - V_MIN)
    return clamp(ms, 0.0, WIND_MAX_MS)

def main():
    i2c = busio.I2C(board.SCL, board.SDA)
    ads = ADS1115.ADS1115(i2c, address=ADS_ADDR)
    ads.gain = 1
    a1 = AnalogIn(ads, 1)

    while True:
        try:
            v   = float(a1.voltage)
            ms  = volts_to_ms(v)
            kmh = ms * 3.6
            msg = {
                "ts":  int(time.time() * 1000),
                "v":   round(v,   4),
                "ms":  round(ms,  2),
                "kmh": round(kmh, 2),
            }
            print(json.dumps(msg), flush=True)
        except Exception as e:
            print(json.dumps({"ts": int(time.time()*1000), "error": str(e)}), flush=True)
        time.sleep(SAMPLE_PERIOD)

if __name__ == "__main__":
    main()