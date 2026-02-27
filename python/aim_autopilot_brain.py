#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
AIM AUTOPILOT BRAIN (SIMULATION ONLY — NO MOTOR CONTROL)
- Computes yaw/pitch correction signals from desired angles and IMU angles.
- Declares ALIGNED when within tolerances.
- Outputs guidance as JSON lines (stdout) or to a file.
- DOES NOT call ticcmd, GPIO, solenoids, backend, or any actuator.

Yaw convention: 0°=North, 90°=East
Pitch: 0° horizontal, + up

Run without IMU:
  python3 aim_autopilot_brain.py

Run with IMU reading (optional):
  python3 aim_autopilot_brain.py --imu --bus 3 --addr 0x29
"""

import argparse
import json
import math
import time
from dataclasses import dataclass


def clamp(x, lo, hi):
    return lo if x < lo else hi if x > hi else x


def ang_diff_deg(target, current):
    """Shortest signed difference target-current in degrees [-180, +180]."""
    return (target - current + 540.0) % 360.0 - 180.0


@dataclass
class ControlParams:
    # tolerances for "aligned"
    tol_yaw_deg: float = 2.0
    tol_pitch_deg: float = 2.0

    # simple proportional controller gains (output is "recommended speed01")
    # Larger = more aggressive. Keep conservative.
    k_yaw: float = 0.02     # speed01 per degree of error
    k_pitch: float = 0.02

    # min speed to overcome stiction suggestion (still only suggestion)
    min_speed01: float = 0.08
    max_speed01: float = 0.40


class BNO055Reader:
    def __init__(self, bus: int, addr: int, yaw_offset=0.0, pitch_offset=0.0):
        self.bus = bus
        self.addr = addr
        self.yaw_offset = yaw_offset
        self.pitch_offset = pitch_offset
        self.sensor = None
        self.err = None

    def start(self):
        try:
            from adafruit_extended_bus import ExtendedI2C as I2C
            import adafruit_bno055
            i2c = I2C(self.bus)
            self.sensor = adafruit_bno055.BNO055_I2C(i2c, address=self.addr)
        except Exception as e:
            self.sensor = None
            self.err = str(e)

    def read(self):
        if self.sensor is None:
            return {"ok": False, "error": self.err or "IMU not started"}
        try:
            euler = self.sensor.euler  # (heading, roll, pitch)
            calib = self.sensor.calibration_status  # (sys, gyro, accel, mag)

            heading = euler[0] if euler and euler[0] is not None else None
            roll    = euler[1] if euler and euler[1] is not None else None
            pitch   = euler[2] if euler and euler[2] is not None else None

            if heading is not None:
                heading = (heading + self.yaw_offset) % 360.0
            if pitch is not None:
                pitch = pitch + self.pitch_offset

            return {
                "ok": True,
                "heading": heading,
                "pitch": pitch,
                "roll": roll,
                "calib": {"sys": calib[0], "g": calib[1], "a": calib[2], "m": calib[3]},
            }
        except Exception as e:
            return {"ok": False, "error": str(e)}


def compute_control(desired_yaw, desired_pitch, cur_yaw, cur_pitch, params: ControlParams):
    """
    Returns recommended "commands" (still not executed):
      yaw_dir: -1 left / +1 right / 0 stop
      yaw_speed01: 0..1
      pitch_dir: -1 down / +1 up / 0 stop
      pitch_speed01: 0..1
      aligned: bool
    """
    dyaw = ang_diff_deg(desired_yaw, cur_yaw)
    dpitch = desired_pitch - cur_pitch

    aligned_yaw = abs(dyaw) <= params.tol_yaw_deg
    aligned_pitch = abs(dpitch) <= params.tol_pitch_deg
    aligned = aligned_yaw and aligned_pitch

    # directions
    yaw_dir = 0 if aligned_yaw else (1 if dyaw > 0 else -1)
    pitch_dir = 0 if aligned_pitch else (1 if dpitch > 0 else -1)

    # proportional suggested speeds
    yaw_speed = clamp(abs(dyaw) * params.k_yaw, 0.0, params.max_speed01)
    pitch_speed = clamp(abs(dpitch) * params.k_pitch, 0.0, params.max_speed01)

    # apply min speed if we are moving (suggestion only)
    if yaw_dir != 0:
        yaw_speed = max(params.min_speed01, yaw_speed)
    if pitch_dir != 0:
        pitch_speed = max(params.min_speed01, pitch_speed)

    return {
        "dyaw": dyaw,
        "dpitch": dpitch,
        "yaw_dir": yaw_dir,
        "yaw_speed01": yaw_speed if yaw_dir != 0 else 0.0,
        "pitch_dir": pitch_dir,
        "pitch_speed01": pitch_speed if pitch_dir != 0 else 0.0,
        "aligned": aligned,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--imu", action="store_true", help="Enable BNO055 reading (still no actuation).")
    ap.add_argument("--bus", type=int, default=3)
    ap.add_argument("--addr", type=lambda s: int(s, 16), default=0x29)
    ap.add_argument("--yaw-offset", type=float, default=0.0)
    ap.add_argument("--pitch-offset", type=float, default=0.0)

    ap.add_argument("--desired-yaw", type=float, default=None)
    ap.add_argument("--desired-pitch", type=float, default=None)

    ap.add_argument("--period", type=float, default=0.25)
    ap.add_argument("--out", type=str, default="", help="Optional output file for JSONL (e.g., /tmp/aim.jsonl)")

    ap.add_argument("--tol-yaw", type=float, default=2.0)
    ap.add_argument("--tol-pitch", type=float, default=2.0)
    ap.add_argument("--k-yaw", type=float, default=0.02)
    ap.add_argument("--k-pitch", type=float, default=0.02)
    args = ap.parse_args()

    params = ControlParams(
        tol_yaw_deg=args.tol_yaw,
        tol_pitch_deg=args.tol_pitch,
        k_yaw=args.k_yaw,
        k_pitch=args.k_pitch,
    )

    # Desired angles (from your ballistic simulation output)
    desired_yaw = args.desired_yaw
    desired_pitch = args.desired_pitch
    if desired_yaw is None:
        desired_yaw = float(input("Desired yaw deg (0=N,90=E): ").strip()) % 360.0
    if desired_pitch is None:
        desired_pitch = float(input("Desired pitch deg (0=horizontal): ").strip())

    # Optional IMU
    reader = None
    if args.imu:
        reader = BNO055Reader(args.bus, args.addr, args.yaw_offset, args.pitch_offset)
        reader.start()
        print(f"IMU ON: bus=/dev/i2c-{args.bus} addr=0x{args.addr:02X} (still no actuation)")
    else:
        print("IMU OFF: manual entry mode (still no actuation)")

    fout = open(args.out, "a", encoding="utf-8") if args.out else None

    print(f"Desired: yaw={desired_yaw:.2f} pitch={desired_pitch:.2f}")
    print("Streaming control suggestions as JSON...\n(CTRL+C to stop)\n")

    try:
        while True:
            ts = int(time.time() * 1000)

            # Get current angles
            if reader is None:
                cur_yaw = float(input("Current yaw: ").strip()) % 360.0
                cur_pitch = float(input("Current pitch: ").strip())
                imu = {"ok": False, "manual": True}
            else:
                imu = reader.read()
                if not imu.get("ok"):
                    out = {"ts": ts, "ok": False, "error": imu.get("error"), "aligned": False}
                    s = json.dumps(out)
                    print(s, flush=True)
                    if fout:
                        fout.write(s + "\n"); fout.flush()
                    time.sleep(args.period)
                    continue

                cur_yaw = imu["heading"]
                cur_pitch = imu["pitch"]

                if cur_yaw is None or cur_pitch is None:
                    out = {"ts": ts, "ok": False, "error": "IMU returned None for heading/pitch", "aligned": False, "imu": imu}
                    s = json.dumps(out)
                    print(s, flush=True)
                    if fout:
                        fout.write(s + "\n"); fout.flush()
                    time.sleep(args.period)
                    continue

            ctrl = compute_control(desired_yaw, desired_pitch, cur_yaw, cur_pitch, params)

            out = {
                "ts": ts,
                "ok": True,
                "desired": {"yaw": desired_yaw, "pitch": desired_pitch},
                "current": {"yaw": cur_yaw, "pitch": cur_pitch},
                "error": {"dyaw": ctrl["dyaw"], "dpitch": ctrl["dpitch"]},
                # Suggested "commands" (NOT executed):
                "suggested": {
                    "yaw": {"dir": ctrl["yaw_dir"], "speed01": round(ctrl["yaw_speed01"], 3)},
                    "pitch": {"dir": ctrl["pitch_dir"], "speed01": round(ctrl["pitch_speed01"], 3)},
                    "stop": ctrl["aligned"],
                },
                "aligned": ctrl["aligned"],
                "imu": imu,
                "note": "SIMULATION ONLY — suggestions only, no motor/solenoid control in this script.",
            }

            s = json.dumps(out)
            print(s, flush=True)
            if fout:
                fout.write(s + "\n"); fout.flush()

            time.sleep(args.period)

    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        if fout:
            fout.close()


if __name__ == "__main__":
    main()