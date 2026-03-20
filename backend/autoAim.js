/**
 * autoAim.js — precision auto-aim for small corrections
 *
 * The cannon is always roughly pointing at the target zone.
 * Corrections are small — typically <15° yaw, small pitch adjustment.
 *
 * ENV:
 *   AUTOAIM_YAW_MIN        default from calibration
 *   AUTOAIM_YAW_MAX        default from calibration
 *   AUTOAIM_PITCH_MIN      default 45
 *   AUTOAIM_PITCH_MAX      default 80
 *   AUTOAIM_TOLERANCE      default 1.5  (degrees — tight!)
 *   AUTOAIM_SPEED_YAW      default 0.2  (slow for precision)
 *   AUTOAIM_SPEED_PITCH    default 0.3
 *   AUTOAIM_SLOW_ZONE      default 5    (degrees — start slowing down)
 *   AUTOAIM_CRAWL_SPEED    default 0.08 (very slow near target)
 *   AUTOAIM_INTERVAL_MS    default 100
 */

import { jog, stop } from "./steppers.js";
import { latest as imuLatest } from "./imu.js";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAL_LATEST = path.join(__dirname, "../calibrations/latest.json");

function loadCalibration() {
  try {
    return JSON.parse(readFileSync(CAL_LATEST, "utf8"));
  } catch { return null; }
}

const cfg = () => {
  const cal = loadCalibration();
  return {
    yawMin:     parseFloat(process.env.AUTOAIM_YAW_MIN    ?? cal?.yawMin    ?? "-180"),
    yawMax:     parseFloat(process.env.AUTOAIM_YAW_MAX    ?? cal?.yawMax    ??  "180"),
    pitchMin:   parseFloat(process.env.AUTOAIM_PITCH_MIN  ?? cal?.pitchMin  ??   "45"),
    pitchMax:   parseFloat(process.env.AUTOAIM_PITCH_MAX  ?? cal?.pitchMax  ??   "80"),
    tolerance:  parseFloat(process.env.AUTOAIM_TOLERANCE  ??  "1.5"),
    speedYaw:   parseFloat(process.env.AUTOAIM_SPEED_YAW  ??  "0.20"),
    speedPitch: parseFloat(process.env.AUTOAIM_SPEED_PITCH??  "0.30"),
    slowZone:   parseFloat(process.env.AUTOAIM_SLOW_ZONE  ??  "5.0"),
    crawlSpeed: parseFloat(process.env.AUTOAIM_CRAWL_SPEED??  "0.08"),
    intervalMs: parseInt  (process.env.AUTOAIM_INTERVAL_MS??  "100"),
  };
};

let _target    = null;
let _status    = "IDLE";
let _error     = { yaw: null, pitch: null };
let _loopId    = null;
let _listeners = new Set();

// Shortest angular difference
function angleDiff(target, current) {
  let d = target - current;
  while (d >  180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// Calculate speed based on how far we are from target
// Far away → normal speed, close → crawl speed
function calcSpeed(errorDeg, normalSpeed, crawlSpeed, slowZone) {
  const abs = Math.abs(errorDeg);
  if (abs <= slowZone) {
    // Linear ramp from crawlSpeed to normalSpeed
    const t = abs / slowZone;
    return crawlSpeed + t * (normalSpeed - crawlSpeed);
  }
  return normalSpeed;
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const cb of _listeners) cb(msg);
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
  _error = { yaw: yawErr.toFixed(1), pitch: pitchErr.toFixed(1) };

  const yawDone   = Math.abs(yawErr)   <= c.tolerance;
  const pitchDone = Math.abs(pitchErr) <= c.tolerance;

  if (yawDone && pitchDone) {
    _status = "ON_TARGET";
    try { stop("yaw");   } catch {}
    try { stop("pitch"); } catch {}
    broadcast({ status: _status, target: _target,
      current: { heading: imu.heading, pitch: imu.pitch }, error: _error });
    // Stop the loop — we're done
    if (_loopId) { clearInterval(_loopId); _loopId = null; }
    return;
  }

  _status = "SEEKING";

  // Yaw correction
  if (!yawDone) {
    // Check limits before moving
    const newHdg = imu.heading + (yawErr > 0 ? 0.5 : -0.5);
    const withinLimits = newHdg >= c.yawMin && newHdg <= c.yawMax;

    if (withinLimits || Math.abs(yawErr) > 1) {
      const dir   = yawErr > 0 ? 1 : -1;
      const speed = calcSpeed(yawErr, c.speedYaw, c.crawlSpeed, c.slowZone);
      try { await jog({ axis: "yaw", dir, speed01: speed }); } catch {}
    } else {
      // At limit — stop yaw
      try { stop("yaw"); } catch {}
      console.log(`[autoAim] yaw at limit (${imu.heading.toFixed(1)}°), stopping`);
    }
  } else {
    try { stop("yaw"); } catch {}
  }

  // Pitch correction
  if (!pitchDone) {
    const withinLimits = imu.pitch >= c.pitchMin && imu.pitch <= c.pitchMax;

    if (withinLimits || Math.abs(pitchErr) > 1) {
      const dir   = pitchErr > 0 ? 1 : -1;
      const speed = calcSpeed(pitchErr, c.speedPitch, c.crawlSpeed, c.slowZone);
      try { await jog({ axis: "pitch", dir, speed01: speed }); } catch {}
    } else {
      try { stop("pitch"); } catch {}
      console.log(`[autoAim] pitch at limit (${imu.pitch.toFixed(1)}°), stopping`);
    }
  } else {
    try { stop("pitch"); } catch {}
  }

  broadcast({ status: _status, target: _target,
    current: { heading: imu.heading, pitch: imu.pitch }, error: _error });
}

export function start({ heading, pitch }) {
  const c = cfg();

  // Clamp to calibrated limits
  const clampedHeading = clamp(heading, c.yawMin,   c.yawMax);
  const clampedPitch   = clamp(pitch,   c.pitchMin, c.pitchMax);

  if (clampedHeading !== heading)
    console.log(`[autoAim] heading ${heading} clamped to ${clampedHeading} (limits: ${c.yawMin}-${c.yawMax})`);
  if (clampedPitch !== pitch)
    console.log(`[autoAim] pitch ${pitch} clamped to ${clampedPitch} (limits: ${c.pitchMin}-${c.pitchMax})`);

  _target = { heading: clampedHeading, pitch: clampedPitch };
  _status = "SEEKING";

  if (_loopId) clearInterval(_loopId);
  _loopId = setInterval(tick, c.intervalMs);

  console.log(`[autoAim] started → heading:${_target.heading}° pitch:${_target.pitch}°`);
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
