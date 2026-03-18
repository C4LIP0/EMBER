/**
 * autoAim.js — Backend auto-aim control loop
 * ENV:
 *   AUTOAIM_YAW_MIN      default -180
 *   AUTOAIM_YAW_MAX      default  180
 *   AUTOAIM_PITCH_MIN    default    0
 *   AUTOAIM_PITCH_MAX    default   60
 *   AUTOAIM_TOLERANCE    default    2
 *   AUTOAIM_SPEED_YAW    default  0.4
 *   AUTOAIM_SPEED_PITCH  default  0.6
 *   AUTOAIM_INTERVAL_MS  default  120
 */

import { jog, stop } from "./steppers.js";
import { latest as imuLatest } from "./imu.js";

const cfg = () => ({
  yawMin:     parseFloat(process.env.AUTOAIM_YAW_MIN     ?? "-180"),
  yawMax:     parseFloat(process.env.AUTOAIM_YAW_MAX     ??  "180"),
  pitchMin:   parseFloat(process.env.AUTOAIM_PITCH_MIN   ??    "0"),
  pitchMax:   parseFloat(process.env.AUTOAIM_PITCH_MAX   ??   "60"),
  tolerance:  parseFloat(process.env.AUTOAIM_TOLERANCE   ??    "2"),
  speedYaw:   parseFloat(process.env.AUTOAIM_SPEED_YAW   ??  "0.4"),
  speedPitch: parseFloat(process.env.AUTOAIM_SPEED_PITCH ??  "0.6"),
  intervalMs: parseInt  (process.env.AUTOAIM_INTERVAL_MS ??  "120"),
});

let _target    = null;
let _status    = "IDLE";
let _error     = { yaw: null, pitch: null };
let _loopId    = null;
let _listeners = new Set();

function angleDiff(target, current) {
  let d = target - current;
  while (d >  180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const cb of _listeners) cb(msg);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

async function tick() {
  if (!_target) return;
  const imu = imuLatest();
  if (!imu || imu.heading == null || imu.pitch == null) {
    _status = "ERROR";
    broadcast({ status: _status, error: "IMU not available", target: _target });
    return;
  }

  const c        = cfg();
  const yawErr   = angleDiff(_target.heading, imu.heading);
  const pitchErr = _target.pitch - imu.pitch;
  _error = { yaw: yawErr, pitch: pitchErr };

  const yawDone   = Math.abs(yawErr)   <= c.tolerance;
  const pitchDone = Math.abs(pitchErr) <= c.tolerance;

  if (yawDone && pitchDone) {
    _status = "ON_TARGET";
    try { stop("yaw");   } catch {}
    try { stop("pitch"); } catch {}
    broadcast({ status: _status, target: _target, current: { heading: imu.heading, pitch: imu.pitch }, error: _error });
    return;
  }

  _status = "SEEKING";

  if (!yawDone) {
    const dir   = yawErr > 0 ? 1 : -1;
    const speed = Math.abs(yawErr) < 10 ? c.speedYaw * 0.4 : c.speedYaw;
    try { await jog({ axis: "yaw", dir, speed01: speed }); } catch {}
  } else {
    try { stop("yaw"); } catch {}
  }

  if (!pitchDone) {
    const dir   = pitchErr > 0 ? 1 : -1;
    const speed = Math.abs(pitchErr) < 10 ? c.speedPitch * 0.4 : c.speedPitch;
    try { await jog({ axis: "pitch", dir, speed01: speed }); } catch {}
  } else {
    try { stop("pitch"); } catch {}
  }

  broadcast({ status: _status, target: _target, current: { heading: imu.heading, pitch: imu.pitch }, error: _error });
}

export function start({ heading, pitch }) {
  const c = cfg();
  _target = {
    heading: clamp(heading, c.yawMin,   c.yawMax),
    pitch:   clamp(pitch,   c.pitchMin, c.pitchMax),
  };
  _status = "SEEKING";
  if (_loopId) clearInterval(_loopId);
  _loopId = setInterval(tick, c.intervalMs);
  console.log("[autoAim] started →", _target);
  broadcast({ status: _status, target: _target });
}

export function stopAim() {
  if (_loopId) { clearInterval(_loopId); _loopId = null; }
  _target = null;
  _status = "IDLE";
  _error  = { yaw: null, pitch: null };
  try { stop("yaw");   } catch {}
  try { stop("pitch"); } catch {}
  console.log("[autoAim] stopped");
  broadcast({ status: _status });
}

export function status() {
  const imu = imuLatest();
  return {
    status:  _status,
    target:  _target,
    current: imu ? { heading: imu.heading, pitch: imu.pitch } : null,
    error:   _error,
    limits:  cfg(),
  };
}

export function subscribe(cb) {
  _listeners.add(cb);
  return () => _listeners.delete(cb);
}
