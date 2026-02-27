#!/usr/bin/env python3
# env_sim_dashboard.py
# Read-only environment dashboard:
# - pulls latest sensor readings from your Node backend
# - computes alignment/wind risk + optional air density
# - optionally writes a GeoJSON "risk sector" wedge for Map overlay
#
# No solenoids. No steppers. No aiming solutions.

import argparse
import json
import math
import time
from typing import Any, Dict, Optional

import requests


def clamp(x: float, lo: float, hi: float) -> float:
    return lo if x < lo else hi if x > hi else x


def air_density_kg_m3(pressure_hpa: float, temp_c: float) -> float:
    # Dry-air approximation: rho = p / (R*T)
    # p in Pa, T in K, R = 287.05 J/(kg*K)
    p_pa = pressure_hpa * 100.0
    t_k = temp_c + 273.15
    return p_pa / (287.05 * t_k)


def wind_to_enu(speed_ms: float, dir_deg_toward: float) -> Dict[str, float]:
    """
    Convert wind speed/dir to East/North components.
    Assumes dir_deg_toward = direction wind is blowing TOWARD (meteorology often uses FROM).
    If your sensor outputs FROM, just add 180 before calling this.
    """
    ang = math.radians(dir_deg_toward)
    # 0° = North, 90° = East
    north = speed_ms * math.cos(ang)
    east = speed_ms * math.sin(ang)
    return {"east": east, "north": north}


def relative_wind_to_heading(wind_e: float, wind_n: float, heading_deg: float) -> Dict[str, float]:
    """
    Compute wind components relative to launcher heading.
    heading_deg: 0°=North, 90°=East
    Returns:
      headwind (+ = tailwind? we define + forward),
      crosswind (+ = wind pushing to the right of heading)
    """
    h = math.radians(heading_deg)
    fwd_e = math.sin(h)
    fwd_n = math.cos(h)
    right_e = math.sin(h + math.pi / 2)
    right_n = math.cos(h + math.pi / 2)

    head = wind_e * fwd_e + wind_n * fwd_n
    cross = wind_e * right_e + wind_n * right_n
    return {"headwind_ms": head, "crosswind_ms": cross}


def destination_latlon(lat: float, lon: float, bearing_deg: float, distance_m: float) -> Dict[str, float]:
    R = 6371000.0
    d = distance_m / R
    br = math.radians(bearing_deg)
    lat1 = math.radians(lat)
    lon1 = math.radians(lon)

    lat2 = math.asin(math.sin(lat1) * math.cos(d) + math.cos(lat1) * math.sin(d) * math.cos(br))
    lon2 = lon1 + math.atan2(math.sin(br) * math.sin(d) * math.cos(lat1),
                             math.cos(d) - math.sin(lat1) * math.sin(lat2))
    lat2d = math.degrees(lat2)
    lon2d = (math.degrees(lon2) + 540) % 360 - 180
    return {"lat": lat2d, "lon": lon2d}


def sector_geojson(lat: float, lon: float, heading_deg: float, half_angle_deg: float, range_m: float, steps: int = 24) -> Dict[str, Any]:
    coords = [[lon, lat]]  # GeoJSON uses [lon, lat]
    start = heading_deg - half_angle_deg
    end = heading_deg + half_angle_deg
    step = (end - start) / steps

    for i in range(steps + 1):
        brg = start + i * step
        p = destination_latlon(lat, lon, brg, range_m)
        coords.append([p["lon"], p["lat"]])

    coords.append([lon, lat])

    return {
        "type": "FeatureCollection",
        "features": [{
            "type": "Feature",
            "properties": {
                "kind": "risk_sector",
                "heading_deg": heading_deg,
                "half_angle_deg": half_angle_deg,
                "range_m": range_m,
            },
            "geometry": {
                "type": "Polygon",
                "coordinates": [coords],
            }
        }]
    }


def try_get_json(url: str, timeout_s: float = 1.5) -> Optional[Dict[str, Any]]:
    try:
        r = requests.get(url, timeout=timeout_s)
        if not r.ok:
            return None
        return r.json()
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://localhost:8080", help="Backend base URL")
    ap.add_argument("--period", type=float, default=0.5, help="Polling period (sec)")
    ap.add_argument("--roll-ok", type=float, default=3.0, help="Roll threshold deg for aligned OK")
    ap.add_argument("--pitch-ok", type=float, default=3.0, help="Pitch threshold deg for aligned OK")
    ap.add_argument("--wind-warn", type=float, default=6.0, help="Crosswind warning threshold m/s")
    ap.add_argument("--tempC", type=float, default=15.0, help="Fallback temperature if none available")
    ap.add_argument("--pressure-hpa", type=float, default=1013.25, help="Fallback pressure if none available")

    # Sector overlay parameters (same idea as your Map.jsx wedge)
    ap.add_argument("--sector-total-deg", type=float, default=25.0)
    ap.add_argument("--sector-range-m", type=float, default=500.0)
    ap.add_argument("--sector-out", default="", help="Write GeoJSON wedge to this file (optional)")

    args = ap.parse_args()

    API = args.api.rstrip("/")
    half_spread = args.sector_total_deg / 2.0

    print("ENV dashboard (read-only). Ctrl+C to stop.")
    print(f"API={API}  period={args.period}s")
    print("-" * 80)

    while True:
        # Prefer a unified env endpoint if you have it; fallback to individual endpoints.
        env = try_get_json(f"{API}/api/env/latest")
        pressure = None
        imu = None
        wind = None
        ecompass = None
        gps = None

        if env and env.get("ok"):
            gps = env.get("gps") or None
            pressure = env.get("pressureSensor") or env.get("pressure") or None
            imu = env.get("imu") or None
            wind = env.get("wind") or None
            ecompass = env.get("ecompass") or None
        else:
            pressure = try_get_json(f"{API}/api/pressure/latest")
            imu = try_get_json(f"{API}/api/imu/latest")
            wind = try_get_json(f"{API}/api/wind/latest")
            ecompass = try_get_json(f"{API}/api/ecompass/latest")
            gps = try_get_json(f"{API}/api/gps/latest")  # optional if you implement

        # Extract heading/roll/pitch (IMU first, else e-compass)
        heading = None
        roll = None
        pitch = None
        calib = None
        if imu:
            # accept either raw or {ok:true,...}
            d = imu.get("ok") and imu or imu
            heading = d.get("heading")
            roll = d.get("roll")
            pitch = d.get("pitch")
            calib = d.get("calib")
        elif ecompass:
            d = ecompass.get("ok") and ecompass or ecompass
            heading = d.get("heading")

        # Alignment
        aligned = None
        if roll is not None and pitch is not None:
            aligned = (abs(roll) <= args.roll_ok) and (abs(pitch) <= args.pitch_ok)

        # Wind vector + relative wind
        wind_speed = None
        wind_dir = None
        rel = None
        if wind and isinstance(wind, dict) and not wind.get("missing"):
            d = wind.get("ok") and wind or wind
            wind_speed = d.get("speedMs") or d.get("windSpeedMs")
            wind_dir = d.get("dirDeg") or d.get("windDirDeg")
        if wind_speed is not None and wind_dir is not None and heading is not None:
            enu = wind_to_enu(float(wind_speed), float(wind_dir))
            rel = relative_wind_to_heading(enu["east"], enu["north"], float(heading))

        # Air density (optional: if you later provide temp/pressure in env)
        tempC = args.tempC
        pressure_hpa = args.pressure_hpa
        # If your env endpoint later includes air.tempC/air.pressureHpa, you can plug it here.
        rho = air_density_kg_m3(pressure_hpa, tempC)

        # GPS for wedge output (manual GPS from Map recommended)
        lat = lon = None
        if gps and isinstance(gps, dict):
            lat = gps.get("lat")
            lon = gps.get("lon")

        # Risk flags (non-actionable warnings)
        warnings = []
        if aligned is False:
            warnings.append("ALIGNMENT OFF (roll/pitch)")
        if rel is not None:
            if abs(rel["crosswind_ms"]) >= args.wind_warn:
                warnings.append(f"CROSSWIND HIGH ({rel['crosswind_ms']:+.1f} m/s)")
        if heading is None:
            warnings.append("NO HEADING (IMU/e-compass missing)")
        if lat is None or lon is None:
            warnings.append("NO GPS (manual GPS not set)")

        # Print one line summary
        now = time.strftime("%H:%M:%S")
        htxt = "--" if heading is None else f"{float(heading):.1f}°"
        rtxt = "--" if roll is None else f"{float(roll):+.1f}°"
        ptxt = "--" if pitch is None else f"{float(pitch):+.1f}°"
        atxt = "--" if aligned is None else ("OK" if aligned else "OFF")

        wtxt = "--"
        if wind_speed is not None and wind_dir is not None:
            wtxt = f"{float(wind_speed):.1f} m/s @ {float(wind_dir):.0f}°"
        reltxt = ""
        if rel is not None:
            reltxt = f" | head {rel['headwind_ms']:+.1f}  cross {rel['crosswind_ms']:+.1f} (m/s)"

        gps_txt = "--"
        if lat is not None and lon is not None:
            gps_txt = f"{float(lat):.6f},{float(lon):.6f}"

        warn_txt = " | WARN: " + "; ".join(warnings) if warnings else ""
        print(f"{now}  heading={htxt}  roll={rtxt}  pitch={ptxt}  align={atxt}  wind={wtxt}{reltxt}  rho~{rho:.3f}  gps={gps_txt}{warn_txt}")

        # Optional: write wedge GeoJSON
        if args.sector_out and (lat is not None) and (lon is not None) and (heading is not None):
            gj = sector_geojson(float(lat), float(lon), float(heading), half_spread, args.sector_range_m)
            with open(args.sector_out, "w", encoding="utf-8") as f:
                json.dump(gj, f)
            # keep file always fresh without spamming console

        time.sleep(args.period)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nStopped.")