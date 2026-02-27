#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Manual Cannon Aiming Simulator (NO HARDWARE ACTIONS)
- You enter cannon GPS/elev, target GPS/elev, wind, projectile params, current yaw/pitch.
- It recommends yaw/pitch and simulates impact.
- IMU (BNO055) code is INCLUDED but DISABLED by default.
  It only reads IMU if you run with:  --imu
  (No motors/solenoids/GPIO/ticcmd anywhere in this file.)

Coordinate system: local ENU (x=East, y=North, z=Up)
Yaw convention: 0 deg = North, 90 deg = East (bearing style)
Pitch: 0 deg = horizontal, 90 deg = straight up
Wind direction is "TOWARDS" in degrees (0=northward, 90=eastward)
"""

import argparse
import math
from dataclasses import dataclass, field


# -----------------------------
# Math helpers
# -----------------------------
def clamp(x, lo, hi):
    return lo if x < lo else hi if x > hi else x

def to_rad(d): return d * math.pi / 180.0
def to_deg(r): return r * 180.0 / math.pi

def bearing_deg(lat1, lon1, lat2, lon2):
    """Initial bearing from (lat1,lon1) to (lat2,lon2) in degrees [0..360)."""
    phi1, phi2 = to_rad(lat1), to_rad(lat2)
    dlmb = to_rad(lon2 - lon1)
    y = math.sin(dlmb) * math.cos(phi2)
    x = math.cos(phi1)*math.sin(phi2) - math.sin(phi1)*math.cos(phi2)*math.cos(dlmb)
    return (to_deg(math.atan2(y, x)) + 360.0) % 360.0

def latlon_to_enu(lat0, lon0, lat, lon):
    """Flat-earth ENU approx around (lat0,lon0). Good for <= few km."""
    R = 6371000.0
    dlat = to_rad(lat - lat0)
    dlon = to_rad(lon - lon0)
    latm = to_rad((lat + lat0) / 2.0)
    x_east = R * dlon * math.cos(latm)
    y_north = R * dlat
    return x_east, y_north

def enu_to_latlon(lat0, lon0, x_east, y_north):
    R = 6371000.0
    dlat = y_north / R
    dlon = x_east / (R * math.cos(to_rad(lat0)))
    lat = lat0 + to_deg(dlat)
    lon = lon0 + to_deg(dlon)
    return lat, lon


# -----------------------------
# Optional IMU reader (OFF by default)
# -----------------------------
@dataclass
class IMUConfig:
    enabled: bool = False
    bus: int = 3
    addr: int = 0x29
    yaw_offset_deg: float = 0.0     # if IMU mounting needs an offset
    pitch_offset_deg: float = 0.0
    roll_ok_deg: float = 3.0        # "aligned" rule
    pitch_ok_deg: float = 3.0

class BNO055Reader:
    """
    This class ONLY reads IMU if you enable it.
    No writes, no GPIO, no motors.
    """
    def __init__(self, cfg: IMUConfig):
        self.cfg = cfg
        self.sensor = None
        self._err = None

    def start(self):
        if not self.cfg.enabled:
            return
        try:
            from adafruit_extended_bus import ExtendedI2C as I2C
            import adafruit_bno055
            i2c = I2C(self.cfg.bus)
            self.sensor = adafruit_bno055.BNO055_I2C(i2c, address=self.cfg.addr)
        except Exception as e:
            self.sensor = None
            self._err = str(e)

    def read(self):
        if not self.cfg.enabled:
            return {"ok": False, "disabled": True, "error": "IMU disabled (run with --imu to enable reading)."}
        if self.sensor is None:
            return {"ok": False, "error": self._err or "IMU not started / not available."}

        try:
            euler = self.sensor.euler  # (heading, roll, pitch) or None
            calib = self.sensor.calibration_status  # (sys, gyro, accel, mag)

            heading = euler[0] if euler and euler[0] is not None else None
            roll = euler[1] if euler and euler[1] is not None else None
            pitch = euler[2] if euler and euler[2] is not None else None

            # Apply offsets (mounting)
            if heading is not None:
                heading = (heading + self.cfg.yaw_offset_deg) % 360.0
            if pitch is not None:
                pitch = pitch + self.cfg.pitch_offset_deg

            aligned = None
            if roll is not None and pitch is not None:
                aligned = (abs(roll) <= self.cfg.roll_ok_deg) and (abs(pitch) <= self.cfg.pitch_ok_deg)

            return {
                "ok": True,
                "bus": self.cfg.bus,
                "addr": f"0x{self.cfg.addr:02X}",
                "heading": heading,
                "roll": roll,
                "pitch": pitch,
                "aligned": aligned,
                "calib": {"sys": calib[0], "g": calib[1], "a": calib[2], "m": calib[3]},
            }
        except Exception as e:
            return {"ok": False, "error": str(e)}


# -----------------------------
# Physics model (simple)
# -----------------------------
@dataclass
class Projectile:
    mass_kg: float = 1.0
    diameter_m: float = 0.08   # 80mm default
    Cd: float = 0.35

    @property
    def area(self):
        r = self.diameter_m / 2.0
        return math.pi * r * r

@dataclass
class Env:
    g: float = 9.80665
    rho: float = 1.225          # air density kg/m^3 (manual)
    wind_speed_mps: float = 0.0
    wind_dir_towards_deg: float = 0.0  # 0=N, 90=E, TOWARDS

    def wind_enu(self):
        th = to_rad(self.wind_dir_towards_deg)
        wx = self.wind_speed_mps * math.sin(th)  # east
        wy = self.wind_speed_mps * math.cos(th)  # north
        return (wx, wy, 0.0)

@dataclass
class Scenario:
    # positions
    cannon_lat: float = 45.5017
    cannon_lon: float = -73.5673
    cannon_elev_m: float = 0.0

    target_lat: float = 45.5018
    target_lon: float = -73.5672
    target_elev_m: float = 0.0

    # current aim (manual)
    yaw_deg: float = 0.0
    pitch_deg: float = 45.0

    # muzzle
    v0_mps: float = 60.0

    env: Env = field(default_factory=Env)
    proj: Projectile = field(default_factory=Projectile)
    imu: IMUConfig = field(default_factory=IMUConfig)


def simulate_shot(sc: Scenario, yaw_deg: float, pitch_deg: float, dt=0.01, tmax=30.0):
    """
    Returns:
      impact (x,y,z), impact_time, miss_m, target_xy (dx,dy)
    """
    dx, dy = latlon_to_enu(sc.cannon_lat, sc.cannon_lon, sc.target_lat, sc.target_lon)
    dz = sc.target_elev_m - sc.cannon_elev_m

    yaw = to_rad(yaw_deg)
    pitch = to_rad(pitch_deg)

    vx = sc.v0_mps * math.cos(pitch) * math.sin(yaw)
    vy = sc.v0_mps * math.cos(pitch) * math.cos(yaw)
    vz = sc.v0_mps * math.sin(pitch)

    x, y, z = 0.0, 0.0, 0.0

    vwx, vwy, vwz = sc.env.wind_enu()
    g = sc.env.g
    rho = sc.env.rho
    Cd = sc.proj.Cd
    A = sc.proj.area
    m = sc.proj.mass_kg

    t = 0.0
    prev = (x, y, z)
    prev_t = 0.0

    while t < tmax:
        rvx = vx - vwx
        rvy = vy - vwy
        rvz = vz - vwz
        vmag = math.sqrt(rvx*rvx + rvy*rvy + rvz*rvz) + 1e-12

        k = 0.5 * rho * Cd * A / m
        ax = -k * vmag * rvx
        ay = -k * vmag * rvy
        az = -g - k * vmag * rvz

        vx += ax * dt
        vy += ay * dt
        vz += az * dt

        x += vx * dt
        y += vy * dt
        z += vz * dt
        t += dt

        if z <= dz:
            x0, y0, z0 = prev
            x1, y1, z1 = x, y, z
            if abs(z1 - z0) > 1e-9:
                alpha = (dz - z0) / (z1 - z0)
                alpha = clamp(alpha, 0.0, 1.0)
            else:
                alpha = 0.0
            ix = x0 + alpha * (x1 - x0)
            iy = y0 + alpha * (y1 - y0)
            it = prev_t + alpha * (t - prev_t)
            miss = math.sqrt((ix - dx)**2 + (iy - dy)**2)
            return (ix, iy, dz), it, miss, (dx, dy)

        prev = (x, y, z)
        prev_t = t

    miss = math.sqrt((x - dx)**2 + (y - dy)**2)
    return (x, y, z), t, miss, (dx, dy)


def initial_pitch_guess(sc: Scenario):
    dx, dy = latlon_to_enu(sc.cannon_lat, sc.cannon_lon, sc.target_lat, sc.target_lon)
    r = math.sqrt(dx*dx + dy*dy)
    dz = sc.target_elev_m - sc.cannon_elev_m
    v = max(0.1, sc.v0_mps)
    g = sc.env.g

    a = (g * r * r) / (2.0 * v * v)
    A = a
    B = -r
    C = a + dz

    disc = B*B - 4*A*C
    if disc < 0 or abs(A) < 1e-12:
        return 45.0

    sqrt_disc = math.sqrt(disc)
    u1 = (-B + sqrt_disc) / (2*A)
    u2 = (-B - sqrt_disc) / (2*A)

    candidates = []
    for u in (u1, u2):
        theta = to_deg(math.atan(u))
        if 1.0 <= theta <= 89.0:
            candidates.append(theta)
    if not candidates:
        return 45.0
    return min(candidates)


def recommend_angles(sc: Scenario, coarse_dt=0.02):
    base_yaw = bearing_deg(sc.cannon_lat, sc.cannon_lon, sc.target_lat, sc.target_lon)
    base_pitch = clamp(initial_pitch_guess(sc), 5.0, 85.0)

    best_yaw = base_yaw
    best_pitch = base_pitch

    def score(yaw, pitch):
        _, _, miss, _ = simulate_shot(sc, yaw, pitch, dt=coarse_dt, tmax=30.0)
        return miss

    best_miss = score(best_yaw, best_pitch)

    yaw_step = 6.0
    pitch_step = 4.0
    for _ in range(10):
        improved = False

        for dyaw in (-yaw_step, 0.0, yaw_step):
            y2 = (best_yaw + dyaw) % 360.0
            m2 = score(y2, best_pitch)
            if m2 < best_miss:
                best_miss, best_yaw = m2, y2
                improved = True

        for dp in (-pitch_step, 0.0, pitch_step):
            p2 = clamp(best_pitch + dp, 5.0, 85.0)
            m2 = score(best_yaw, p2)
            if m2 < best_miss:
                best_miss, best_pitch = m2, p2
                improved = True

        if not improved:
            yaw_step *= 0.5
            pitch_step *= 0.5
            if yaw_step < 0.2 and pitch_step < 0.2:
                break

    return best_yaw, best_pitch, best_miss, base_yaw, base_pitch


def print_status(sc: Scenario, imu_reader: BNO055Reader):
    dx, dy = latlon_to_enu(sc.cannon_lat, sc.cannon_lon, sc.target_lat, sc.target_lon)
    dist = math.sqrt(dx*dx + dy*dy)
    brg = bearing_deg(sc.cannon_lat, sc.cannon_lon, sc.target_lat, sc.target_lon)

    print("\n--- STATUS ---")
    print(f"CANNON: lat={sc.cannon_lat:.6f} lon={sc.cannon_lon:.6f} elev={sc.cannon_elev_m:.1f} m")
    print(f"TARGET: lat={sc.target_lat:.6f} lon={sc.target_lon:.6f} elev={sc.target_elev_m:.1f} m")
    print(f"DIST: {dist:.1f} m   BEARING(to target): {brg:.1f} deg")
    print(f"AIM (manual): yaw={sc.yaw_deg:.2f} deg  pitch={sc.pitch_deg:.2f} deg  (pitch = 'height angle')")
    print(f"MUZZLE: v0={sc.v0_mps:.2f} m/s")
    print(f"ENV: rho={sc.env.rho:.3f} kg/m^3  wind={sc.env.wind_speed_mps:.2f} m/s towards={sc.env.wind_dir_towards_deg:.1f} deg")
    print(f"PROJ: mass={sc.proj.mass_kg:.3f} kg  diam={sc.proj.diameter_m*1000:.1f} mm  Cd={sc.proj.Cd:.3f}")

    imu = imu_reader.read()
    if imu.get("ok"):
        print(f"IMU: heading={imu['heading']:.2f} roll={imu['roll']:.2f} pitch={imu['pitch']:.2f} aligned={imu['aligned']}")
        c = imu.get("calib") or {}
        print(f"IMU calib SYS/G/A/M: {c.get('sys')}/{c.get('g')}/{c.get('a')}/{c.get('m')}")
    else:
        print(f"IMU: {imu.get('error') or 'disabled'}")

    print("-------------\n")


def help_text():
    return """
Commands:
  status
  set cannon <lat> <lon> [elev_m]
  set target <lat> <lon> [elev_m]
  set yaw <deg>
  set pitch <deg>
  jog yaw <delta_deg>
  jog pitch <delta_deg>

  set v0 <mps>
  set wind <speed_mps> <dir_towards_deg>
  set rho <kg_per_m3>
  set proj <mass_kg> <diam_mm> <Cd>

  recommend   -> prints recommended yaw/pitch to hit target (simulation)
  simulate    -> simulate with current yaw/pitch; prints predicted impact + miss
  where       -> same as simulate

  quit / exit
""".strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--imu", action="store_true", help="Enable IMU reading (BNO055). Default OFF.")
    ap.add_argument("--imu-bus", type=int, default=3)
    ap.add_argument("--imu-addr", type=lambda s: int(s, 16), default=0x29)
    ap.add_argument("--imu-yaw-offset", type=float, default=0.0)
    ap.add_argument("--imu-pitch-offset", type=float, default=0.0)
    args = ap.parse_args()

    sc = Scenario()
    sc.imu.enabled = bool(args.imu)
    sc.imu.bus = args.imu_bus
    sc.imu.addr = args.imu_addr
    sc.imu.yaw_offset_deg = args.imu_yaw_offset
    sc.imu.pitch_offset_deg = args.imu_pitch_offset

    imu_reader = BNO055Reader(sc.imu)
    # IMPORTANT: Only attempts to open IMU if --imu was passed
    imu_reader.start()

    print("Manual Cannon Aiming Simulator (SIMULATION ONLY)")
    print("IMU code included. IMU reading is OFF unless you run with --imu.")
    print("Type 'help' for commands.\n")

    while True:
        try:
            line = input("sim> ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nBye.")
            return

        if not line:
            continue

        parts = line.split()
        cmd = parts[0].lower()

        if cmd in ("quit", "exit"):
            print("Bye.")
            return

        if cmd == "help":
            print(help_text())
            continue

        if cmd == "status":
            print_status(sc, imu_reader)
            continue

        if cmd == "set" and len(parts) >= 2:
            what = parts[1].lower()
            try:
                if what == "cannon":
                    sc.cannon_lat, sc.cannon_lon = float(parts[2]), float(parts[3])
                    if len(parts) >= 5:
                        sc.cannon_elev_m = float(parts[4])
                    print("OK set cannon.")
                elif what == "target":
                    sc.target_lat, sc.target_lon = float(parts[2]), float(parts[3])
                    if len(parts) >= 5:
                        sc.target_elev_m = float(parts[4])
                    print("OK set target.")
                elif what == "yaw":
                    sc.yaw_deg = float(parts[2]) % 360.0
                    print("OK set yaw.")
                elif what == "pitch":
                    sc.pitch_deg = clamp(float(parts[2]), 0.0, 89.9)
                    print("OK set pitch.")
                elif what == "v0":
                    sc.v0_mps = max(0.1, float(parts[2]))
                    print("OK set v0.")
                elif what == "wind":
                    sc.env.wind_speed_mps = max(0.0, float(parts[2]))
                    sc.env.wind_dir_towards_deg = float(parts[3]) % 360.0
                    print("OK set wind.")
                elif what == "rho":
                    sc.env.rho = max(0.2, float(parts[2]))
                    print("OK set rho.")
                elif what == "proj":
                    sc.proj.mass_kg = max(0.01, float(parts[2]))
                    sc.proj.diameter_m = max(1.0, float(parts[3])) / 1000.0
                    sc.proj.Cd = max(0.01, float(parts[4]))
                    print("OK set projectile.")
                else:
                    print("Unknown set command. Type 'help'.")
            except Exception as e:
                print("Set error:", e)
            continue

        if cmd == "jog" and len(parts) >= 3:
            axis = parts[1].lower()
            try:
                delta = float(parts[2])
                if axis == "yaw":
                    sc.yaw_deg = (sc.yaw_deg + delta) % 360.0
                    print(f"OK yaw -> {sc.yaw_deg:.2f} deg")
                elif axis == "pitch":
                    sc.pitch_deg = clamp(sc.pitch_deg + delta, 0.0, 89.9)
                    print(f"OK pitch -> {sc.pitch_deg:.2f} deg")
                else:
                    print("Unknown axis. Use yaw/pitch.")
            except Exception as e:
                print("Jog error:", e)
            continue

        if cmd == "recommend":
            yaw, pitch, miss, base_yaw, base_pitch = recommend_angles(sc)

            dyaw = ((yaw - sc.yaw_deg + 540.0) % 360.0) - 180.0
            dpitch = pitch - sc.pitch_deg

            print("\n--- RECOMMEND (SIM) ---")
            print(f"Initial guess (bearing/vacuum): yaw={base_yaw:.2f}  pitch={base_pitch:.2f}")
            print(f"Recommended: yaw={yaw:.2f} deg   pitch={pitch:.2f} deg  (pitch = 'height angle')")
            print(f"Predicted miss: {miss:.2f} m")
            print(f"From current manual aim: yaw delta={dyaw:+.2f} deg  pitch delta={dpitch:+.2f} deg")

            imu = imu_reader.read()
            if imu.get("ok") and imu.get("heading") is not None and imu.get("pitch") is not None:
                imu_dyaw = ((yaw - imu["heading"] + 540.0) % 360.0) - 180.0
                imu_dpitch = pitch - imu["pitch"]
                print(f"From IMU aim (if mounted correctly): yaw delta={imu_dyaw:+.2f} deg  pitch delta={imu_dpitch:+.2f} deg")
                print(f"IMU aligned flag: {imu.get('aligned')}")
            else:
                print("IMU comparison: (disabled or unavailable)")

            print("----------------------\n")
            continue

        if cmd in ("simulate", "where"):
            impact, t, miss, (dx, dy) = simulate_shot(sc, sc.yaw_deg, sc.pitch_deg, dt=0.01, tmax=30.0)
            ix, iy, iz = impact
            ilat, ilon = enu_to_latlon(sc.cannon_lat, sc.cannon_lon, ix, iy)
            dist = math.sqrt(dx*dx + dy*dy)

            print("\n--- SIM RESULT ---")
            print(f"Target horizontal dist: {dist:.1f} m")
            print(f"Impact ENU: x={ix:.1f}m east, y={iy:.1f}m north, z={iz:.1f}m")
            print(f"Impact lat/lon: {ilat:.6f}, {ilon:.6f}")
            print(f"Time of flight: {t:.2f} s")
            print(f"Miss distance:  {miss:.2f} m")
            print("-----------------\n")
            continue

        print("Unknown command. Type 'help'.")


if __name__ == "__main__":
    main()