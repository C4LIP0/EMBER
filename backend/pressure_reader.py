import os, json, time
import board, busio
import adafruit_ads1x15.ads1115 as ADS1115
from adafruit_ads1x15.analog_in import AnalogIn

ADS_ADDR = int(os.getenv("PRESSURE_ADS_ADDR", "0x48"), 16)

# Divider ratio: V_adc / V_sensor_out
DIVIDER_RATIO = float(os.getenv("PRESSURE_DIVIDER_RATIO", "0.6667"))  # 1k/2k divider => 0.6667

# Typical ratiometric sensor on 5V: 0.5V..4.5V
V_SUPPLY = float(os.getenv("PRESSURE_V_SUPPLY", "5.0"))
V_MIN = float(os.getenv("PRESSURE_V_MIN", str(0.10 * V_SUPPLY)))
V_MAX = float(os.getenv("PRESSURE_V_MAX", str(0.90 * V_SUPPLY)))

P_MIN = float(os.getenv("PRESSURE_P_MIN", "0.0"))
P_MAX = float(os.getenv("PRESSURE_P_MAX", "300.0"))

SAMPLE_PERIOD = float(os.getenv("PRESSURE_SAMPLE_PERIOD", "0.2"))

def clamp(x, lo, hi):
    return lo if x < lo else hi if x > hi else x

def volts_to_psi(v_sensor):
    psi = (v_sensor - V_MIN) * (P_MAX - P_MIN) / (V_MAX - V_MIN) + P_MIN
    return clamp(psi, P_MIN, P_MAX)

def main():
    i2c = busio.I2C(board.SCL, board.SDA)
    ads = ADS1115.ADS1115(i2c, address=ADS_ADDR)
    ads.gain = 1  # +/-4.096V at ADC pin (good for 0..3.3V at A0)

    a0 = AnalogIn(ads, 0)  # channel A0

    while True:
        v_adc = float(a0.voltage)
        v_sensor = v_adc / DIVIDER_RATIO
        psi = volts_to_psi(v_sensor)

        msg = {
            "ts": int(time.time() * 1000),
            "v_adc": v_adc,
            "v_sensor": v_sensor,
            "psi": psi,
        }
        print(json.dumps(msg), flush=True)
        time.sleep(SAMPLE_PERIOD)

if __name__ == "__main__":
    main()
