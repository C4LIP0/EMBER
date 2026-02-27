#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Manual Cannon Aiming Simulator (NO HARDWARE)
- You enter cannon GPS/elev, target GPS/elev, wind, projectile params, current yaw/pitch.
- It recommends yaw/pitch and simulates impact.
- You can "jog" yaw/pitch like a controller (but it does NOT connect to anything).

Coordinate system: local ENU (x=East, y=North, z=Up)
Yaw convention: 0 deg = North, 90 deg = East (bearing style)
Pitch: 0 deg = horizontal, 90 deg = straight up
Wind direction is "TOWARDS" in degrees (0=northward, 90=eastward)
"""

import math
import sys
from dataclasses import dataclass, field


# -----------------------------
# Math helpers
# -----------------------------
def clamp(x, lo, hi):
    return lo if x < lo else hi if x > hi else x

def to_rad(d): return d * math.pi / 180.0
def to_deg(r): return r * 180.0 / math.pi

def haversine_m(lat1, lon1, lat2, lon2):
    R = 6371000.0
    p1, p2 = to_rad(lat1), to_rad(lat2)
    dphi = to_rad(lat2 - lat1)
    dlmb = to_rad(lon2 - lon1)
    a = math.sin(dphi/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dlmb/2)**2
    return 2*R*math.asin(math.sqrt(a))

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

    # current aim
    yaw_deg: float = 0.0
    pitch_deg: float = 45.0

    # muzzle
    v0_mps: float = 60.0

    # optional: show motor steps (simulation only)
    yaw_steps_per_deg: float = 0.0
    pitch_steps_per_deg: float = 0.0

    env: Env = field(default_factory=Env)
    proj: Projectile = field(default_factory=Projectile)


def simulate_shot(sc: Scenario, yaw_deg: float, pitch_deg: float, dt=0.01, tmax=30.0):
    """
    Returns:
      impact (x,y,z), impact_time, miss_m, target_xy (dx,dy), path_last (last pos)
    """
    # target in local ENU
    dx, dy = latlon_to_enu(sc.cannon_lat, sc.cannon_lon, sc.target_lat, sc.target_lon)
    dz = sc.target_elev_m - sc.cannon_elev_m

    # initial velocity in ENU
    yaw = to_rad(yaw_deg)
    pitch = to_rad(pitch_deg)

    # yaw: 0=N => +y, 90=E => +x
    vx = sc.v0_mps * math.cos(pitch) * math.sin(yaw)
    vy = sc.v0_mps * math.cos(pitch) * math.cos(yaw)
    vz = sc.v0_mps * math.sin(pitch)

    # initial state at cannon origin, with z = cannon elev relative baseline (we treat ground at cannon as z=0)
    x, y, z = 0.0, 0.0, 0.0
    vwx, vwy, vwz = sc.env.wind_enu()
    g = sc.env.g
    rho = sc.env.rho
    Cd = sc.proj.Cd
    A = sc.proj.area
    m = sc.proj.mass_kg

    # integrate until z crosses target "ground plane" at z = dz (relative), but realistically we stop when z <= dz
    # If target elev differs, "ground" is shifted by dz.
    t = 0.0
    prev = (x, y, z)
    prev_t = 0.0

    while t < tmax:
        # relative velocity (to air)
        rvx = vx - vwx
        rvy = vy - vwy
        rvz = vz - vwz
        vmag = math.sqrt(rvx*rvx + rvy*rvy + rvz*rvz) + 1e-12

        # drag accel
        k = 0.5 * rho * Cd * A / m
        ax = -k * vmag * rvx
        ay = -k * vmag * rvy
        az = -g - k * vmag * rvz

        # update velocity
        vx += ax * dt
        vy += ay * dt
        vz += az * dt

        # update position
        x += vx * dt
        y += vy * dt
        z += vz * dt
        t += dt

        # stop when we hit target elevation plane (z <= dz)
        if z <= dz:
            # linear interpolate impact between prev and current for a cleaner impact estimate
            x0, y0, z0 = prev
            x1, y1, z1 = x, y, z
            if abs(z1 - z0) > 1e-9:
                alpha = (dz - z0) / (z1 - z0)
                alpha = clamp(alpha, 0.0, 1.0)
            else:
                alpha = 0.0
            ix = x0 + alpha * (x1 - x0)
            iy = y0 + alpha * (y1 - y0)
            iz = dz
            it = prev_t + alpha * (t - prev_t)

            miss = math.sqrt((ix - dx)**2 + (iy - dy)**2)
            return (ix, iy, iz), it, miss, (dx, dy), (x, y, z)

        prev = (x, y, z)
        prev_t = t

    # no impact
    miss = math.sqrt((x - dx)**2 + (y - dy)**2)
    return (x, y, z), t, miss, (dx, dy), (x, y, z)


def initial_pitch_guess(sc: Scenario):
    """Vacuum-ish pitch guess (no drag/wind)."""
    dx, dy = latlon_to_enu(sc.cannon_lat, sc.cannon_lon, sc.target_lat, sc.target_lon)
    r = math.sqrt(dx*dx + dy*dy)
    dz = sc.target_elev_m - sc.cannon_elev_m
    v = max(0.1, sc.v0_mps)
    g = sc.env.g

    # Solve for theta using projectile equation with height difference:
    # dz = r*tan(theta) - g*r^2/(2*v^2*cos^2(theta))
    # Let u = tan(theta). cos^2 = 1/(1+u^2)
    # dz = r*u - g*r^2/(2*v^2) * (1+u^2)
    # => (g*r^2/(2*v^2)) u^2 - r*u + (g*r^2/(2*v^2) + dz) = 0
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

    # prefer lower angle solution if positive
    candidates = []
    for u in (u1, u2):
        theta = to_deg(math.atan(u))
        if 1.0 <= theta <= 89.0:
            candidates.append(theta)
    if not candidates:
        return 45.0
    return min(candidates)


def recommend_angles(sc: Scenario, coarse_dt=0.02):
    """
    Simple search:
    - start yaw at bearing to target
    - start pitch at vacuum guess
    - refine by local coordinate descent
    """
    base_yaw = bearing_deg(sc.cannon_lat, sc.cannon_lon, sc.target_lat, sc.target_lon)
    base_pitch = initial_pitch_guess(sc)

    # clamp pitch
    base_pitch = clamp(base_pitch, 5.0, 85.0)

    best_yaw = base_yaw
    best_pitch = base_pitch
    best_miss = None

    def score(yaw, pitch):
        _, _, miss, _, _ = simulate_shot(sc, yaw, pitch, dt=coarse_dt, tmax=30.0)
        return miss

    best_miss = score(best_yaw, best_pitch)

    # coordinate descent
    yaw_step = 6.0
    pitch_step = 4.0
    for _ in range(10):
        improved = False

        # try yaw adjustments
        for dyaw in (-yaw_step, 0.0, yaw_step):
            y2 = (best_yaw + dyaw) % 360.0
            m2 = score(y2, best_pitch)
            if m2 < best_miss:
                best_miss = m2
                best_yaw = y2
                improved = True

        # try pitch adjustments
        for dp in (-pitch_step, 0.0, pitch_step):
            p2 = clamp(best_pitch + dp, 5.0, 85.0)
            m2 = score(best_yaw, p2)
            if m2 < best_miss:
                best_miss = m2
                best_pitch = p2
                improved = True

        if not improved:
            yaw_step *= 0.5
            pitch_step *= 0.5
            if yaw_step < 0.2 and pitch_step < 0.2:
                break

    return best_yaw, best_pitch, best_miss, base_yaw, base_pitch


# -----------------------------
# CLI
# -----------------------------
def print_status(sc: Scenario):
    dx, dy = latlon_to_enu(sc.cannon_lat, sc.cannon_lon, sc.target_lat, sc.target_lon)
    dist = math.sqrt(dx*dx + dy*dy)
    brg = bearing_deg(sc.cannon_lat, sc.cannon_lon, sc.target_lat, sc.target_lon)

    print("\n--- STATUS ---")
    print(f"CANNON: lat={sc.cannon_lat:.6f} lon={sc.cannon_lon:.6f} elev={sc.cannon_elev_m:.1f} m")
    print(f"TARGET: lat={sc.target_lat:.6f} lon={sc.target_lon:.6f} elev={sc.target_elev_m:.1f} m")
    print(f"DIST: {dist:.1f} m   BEARING(to target): {brg:.1f} deg")
    print(f"AIM: yaw={sc.yaw_deg:.2f} deg  pitch={sc.pitch_deg:.2f} deg")
    print(f"MUZZLE: v0={sc.v0_mps:.2f} m/s")
    print(f"ENV: rho={sc.env.rho:.3f} kg/m^3  wind={sc.env.wind_speed_mps:.2f} m/s towards={sc.env.wind_dir_towards_deg:.1f} deg")
    print(f"PROJ: mass={sc.proj.mass_kg:.3f} kg  diam={sc.proj.diameter_m*1000:.1f} mm  Cd={sc.proj.Cd:.3f}")
    if sc.yaw_steps_per_deg > 0 or sc.pitch_steps_per_deg > 0:
        print(f"STEPS (sim): yaw_steps/deg={sc.yaw_steps_per_deg}  pitch_steps/deg={sc.pitch_steps_per_deg}")
    print("-------------\n")

def cmd_help():
    print("""
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
  set steps yaw <steps_per_deg>
  set steps pitch <steps_per_deg>

  recommend           -> suggests yaw/pitch to minimize miss (simple search)
  simulate            -> simulates using current yaw/pitch
  where               -> predicted impact lat/lon + miss

  quit / exit
""".strip())

def parse_floats(parts):
    return [float(x) for x in parts]

def main():
    sc = Scenario()
    print("Manual Cannon Aiming Simulator (NO HARDWARE)")
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
            cmd_help()
            continue

        if cmd == "status":
            print_status(sc)
            continue

        if cmd == "set" and len(parts) >= 2:
            what = parts[1].lower()

            try:
                if what == "cannon":
                    lat, lon = float(parts[2]), float(parts[3])
                    elev = float(parts[4]) if len(parts) >= 5 else sc.cannon_elev_m
                    sc.cannon_lat, sc.cannon_lon, sc.cannon_elev_m = lat, lon, elev
                    print("OK set cannon.")
                elif what == "target":
                    lat, lon = float(parts[2]), float(parts[3])
                    elev = float(parts[4]) if len(parts) >= 5 else sc.target_elev_m
                    sc.target_lat, sc.target_lon, sc.target_elev_m = lat, lon, elev
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
                    mass = max(0.01, float(parts[2]))
                    diam_mm = max(1.0, float(parts[3]))
                    cd = max(0.01, float(parts[4]))
                    sc.proj.mass_kg = mass
                    sc.proj.diameter_m = diam_mm / 1000.0
                    sc.proj.Cd = cd
                    print("OK set projectile.")
                elif what == "steps":
                    axis = parts[2].lower()
                    val = float(parts[3])
                    if axis == "yaw":
                        sc.yaw_steps_per_deg = val
                        print("OK set yaw steps/deg.")
                    elif axis == "pitch":
                        sc.pitch_steps_per_deg = val
                        print("OK set pitch steps/deg.")
                    else:
                        print("Unknown steps axis. Use yaw/pitch.")
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
                    step_info = ""
                    if sc.yaw_steps_per_deg > 0:
                        step_info = f"  (sim steps: {delta*sc.yaw_steps_per_deg:.1f})"
                    print(f"OK yaw -> {sc.yaw_deg:.2f} deg{step_info}")
                elif axis == "pitch":
                    sc.pitch_deg = clamp(sc.pitch_deg + delta, 0.0, 89.9)
                    step_info = ""
                    if sc.pitch_steps_per_deg > 0:
                        step_info = f"  (sim steps: {delta*sc.pitch_steps_per_deg:.1f})"
                    print(f"OK pitch -> {sc.pitch_deg:.2f} deg{step_info}")
                else:
                    print("Unknown axis. Use yaw/pitch.")
            except Exception as e:
                print("Jog error:", e)
            continue

        if cmd == "recommend":
            yaw, pitch, miss, base_yaw, base_pitch = recommend_angles(sc)
            dyaw = ((yaw - sc.yaw_deg + 540.0) % 360.0) - 180.0  # shortest signed
            dpitch = pitch - sc.pitch_deg

            print("\n--- RECOMMEND ---")
            print(f"Initial guess (bearing/vacuum): yaw={base_yaw:.2f}  pitch={base_pitch:.2f}")
            print(f"Recommended: yaw={yaw:.2f} deg  pitch={pitch:.2f} deg")
            print(f"Predicted miss: {miss:.2f} m")
            print(f"From current:  yaw delta={dyaw:+.2f} deg  pitch delta={dpitch:+.2f} deg")

            if sc.yaw_steps_per_deg > 0:
                print(f"Sim steps yaw:   {dyaw*sc.yaw_steps_per_deg:+.1f}")
            if sc.pitch_steps_per_deg > 0:
                print(f"Sim steps pitch: {dpitch*sc.pitch_steps_per_deg:+.1f}")

            print("---------------\n")
            continue

        if cmd in ("simulate", "where"):
            impact, t, miss, (dx, dy), _ = simulate_shot(sc, sc.yaw_deg, sc.pitch_deg, dt=0.01, tmax=30.0)
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