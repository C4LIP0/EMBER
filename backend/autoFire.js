/**
 * autoFire.js — Watches pressure sensor and fires when target PSI is reached
 *
 * ENV:
 *   AUTOFIRE_TOLERANCE_PSI   default 2.0  (±PSI tolerance)
 *   AUTOFIRE_CONFIRM_READS   default 3    (consecutive reads needed before firing)
 */

import { latest as pressureLatest } from "./pressure.js";
import { solenoids } from "./solenoids.js";

const cfg = () => ({
  tolerancePsi:  parseFloat(process.env.AUTOFIRE_TOLERANCE_PSI  ?? "2.0"),
  confirmReads:  parseInt  (process.env.AUTOFIRE_CONFIRM_READS  ?? "3"),
  intervalMs:    parseInt  (process.env.AUTOFIRE_INTERVAL_MS    ?? "200"),
});

let _targetPsi   = null;
let _status      = "IDLE";   // IDLE | ARMED | FIRING | FIRED | ERROR
let _loopId      = null;
let _confirmCnt  = 0;
let _listeners   = new Set();
let _currentPsi  = null;

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const cb of _listeners) cb(msg);
}

async function tick() {
  const pr = pressureLatest();
  if (!pr || pr.psi == null) {
    _status = "ERROR";
    broadcast({ status: _status, error: "No pressure reading", targetPsi: _targetPsi, currentPsi: null });
    return;
  }

  _currentPsi = pr.psi;
  const c = cfg();

  broadcast({
    status:    _status,
    targetPsi: _targetPsi,
    currentPsi: _currentPsi,
    diff:      (_targetPsi - _currentPsi).toFixed(1),
  });

  // Check if PSI is within tolerance
  if (Math.abs(_currentPsi - _targetPsi) <= c.tolerancePsi) {
    _confirmCnt++
    if (_confirmCnt >= c.confirmReads) {
      // Fire!
      _status = "FIRING";
      broadcast({ status: _status, targetPsi: _targetPsi, currentPsi: _currentPsi });
      stopWatch();
      try {
        await solenoids.shoot({ pulseMs: 3000 });
        _status = "FIRED";
        broadcast({ status: _status, targetPsi: _targetPsi, currentPsi: _currentPsi, firedAt: Date.now() });
        console.log(`[autoFire] FIRED at ${_currentPsi.toFixed(1)} PSI (target: ${_targetPsi} PSI)`);
      } catch (e) {
        _status = "ERROR";
        broadcast({ status: _status, error: e.message });
        console.error("[autoFire] Fire error:", e.message);
      }
    }
  } else {
    _confirmCnt = 0;
  }
}

export function arm(targetPsi) {
  if (_loopId) stopWatch();

  _targetPsi  = targetPsi;
  _status     = "ARMED";
  _confirmCnt = 0;

  const c = cfg();
  _loopId = setInterval(tick, c.intervalMs);

  console.log(`[autoFire] armed — target: ${targetPsi} PSI`);
  broadcast({ status: _status, targetPsi: _targetPsi, currentPsi: _currentPsi });
}

export function stopWatch() {
  if (_loopId) { clearInterval(_loopId); _loopId = null; }
  if (_status !== "FIRED") _status = "IDLE";
  _confirmCnt = 0;
  broadcast({ status: _status, targetPsi: _targetPsi, currentPsi: _currentPsi });
  console.log("[autoFire] stopped");
}

export function reset() {
  stopWatch();
  _targetPsi  = null;
  _status     = "IDLE";
  _currentPsi = null;
  _confirmCnt = 0;
  broadcast({ status: _status });
}

export function status() {
  return {
    status:    _status,
    targetPsi: _targetPsi,
    currentPsi: _currentPsi,
    confirmCnt: _confirmCnt,
    confirmNeeded: cfg().confirmReads,
  };
}

export function subscribe(cb) {
  _listeners.add(cb);
  return () => _listeners.delete(cb);
}
