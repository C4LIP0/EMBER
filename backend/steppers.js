import { execFile } from "child_process";

// ─────────────────────────────────────────────
// Config helpers — read lazily so dotenv has
// time to populate process.env before first use
// ─────────────────────────────────────────────
const TICCMD = process.env.TICCMD_PATH || "ticcmd";

function getAxes() {
  return {
    yaw: {
      serial: process.env.TIC_YAW_SERIAL,
      stepsPerTick: parseInt(process.env.TIC_YAW_STEPS_PER_TICK || "250", 10),
    },
    pitch: {
      serial: process.env.TIC_PITCH_SERIAL,
      stepsPerTick: parseInt(process.env.TIC_PITCH_STEPS_PER_TICK || "450", 10),
    },
  };
}

function getAllowEnergize() {
  return String(process.env.TIC_ALLOW_ENERGIZE || "0") === "1";
}

// ─────────────────────────────────────────────
// Per-axis runtime state
// ─────────────────────────────────────────────
const state = {
  yaw:   { targetPos: null, enabled: false, lastError: null, lastStatus: null },
  pitch: { targetPos: null, enabled: false, lastError: null, lastStatus: null },
};

// ─────────────────────────────────────────────
// Simple per-axis mutex — prevents interleaved ticcmd calls
// ─────────────────────────────────────────────
const locks = { yaw: Promise.resolve(), pitch: Promise.resolve() };

function withLock(axis, fn) {
  locks[axis] = locks[axis].then(fn, fn);
  return locks[axis];
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function needSerial(axis) {
  const s = getAxes()[axis]?.serial;
  if (!s) {
    throw new Error(
      `Missing ${axis} serial. Set TIC_${axis.toUpperCase()}_SERIAL in backend/.env`
    );
  }
  return s;
}

function runTic(serial, args, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    execFile(
      TICCMD,
      ["-d", serial, ...args],
      { timeout: timeoutMs },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || stdout || err.message || String(err)).trim();
          reject(new Error(msg));
          return;
        }
        resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
      }
    );
  });
}

// Parse useful fields from `ticcmd --status --full` text output
function parseStatusText(text) {
  const out = {};

  const mPos = text.match(/Current position:\s*(-?\d+)/i);
  if (mPos) out.currentPosition = parseInt(mPos[1], 10);

  const mE = text.match(/Energized:\s*(Yes|No)/i);
  if (mE) out.energized = mE[1].toLowerCase() === "yes";

  const mSS = text.match(/Safe start:\s*(Yes|No)/i);
  if (mSS) out.safeStart = mSS[1].toLowerCase() === "yes";

  const mErr = text.match(/Errors currently stopping the motor:\s*(Yes|No)/i);
  if (mErr) out.errorsStopping = mErr[1].toLowerCase() === "yes";

  return out;
}

// ─────────────────────────────────────────────
// Internal axis operations
// ─────────────────────────────────────────────
async function readStatus(axis) {
  const serial = needSerial(axis);
  const { stdout } = await runTic(serial, ["--status", "--full"], 5000);
  const parsed = parseStatusText(stdout);
  const payload = {
    axis,
    serial,
    ok: true,
    ts: Date.now(),
    ...parsed,
    raw: stdout,
  };
  state[axis].lastStatus = payload;
  return payload;
}

async function ensureTargetPos(axis) {
  if (state[axis].targetPos != null) return state[axis].targetPos;
  const st = await readStatus(axis);
  const cur = typeof st.currentPosition === "number" ? st.currentPosition : 0;
  state[axis].targetPos = cur;
  return cur;
}

async function setTargetPosition(axis, position) {
  const serial = needSerial(axis);
  await runTic(serial, ["--exit-safe-start", "--position", String(position)]);
  state[axis].targetPos = position;
  return position;
}

async function halt(axis) {
  const serial = needSerial(axis);
  try {
    await runTic(serial, ["--halt-and-hold"]);
  } catch {
    // Fallback: freeze at current position
    const st = await readStatus(axis);
    const cur = typeof st.currentPosition === "number" ? st.currentPosition : 0;
    await runTic(serial, ["--exit-safe-start", "--position", String(cur)]);
    state[axis].targetPos = cur;
  }
}

// ─────────────────────────────────────────────
// Exported API
// ─────────────────────────────────────────────

/**
 * Get status for both axes at once.
 */
export async function statusAll() {
  const axes = getAxes();
  const out = {};
  for (const axis of Object.keys(axes)) {
    try {
      out[axis] = await withLock(axis, () => readStatus(axis));
    } catch (e) {
      out[axis] = {
        axis,
        serial: axes[axis]?.serial || null,
        ok: false,
        ts: Date.now(),
        error: String(e.message || e),
      };
      state[axis].lastError = out[axis].error;
    }
  }
  return out;
}

/**
 * Get status for a single axis.
 */
export async function statusAxis(axis) {
  return withLock(axis, () => readStatus(axis));
}

/**
 * Energize a motor and exit safe-start so it can receive position commands.
 * Requires TIC_ALLOW_ENERGIZE=1 in .env as a safety gate.
 */
export async function enable(axis) {
  if (!getAllowEnergize()) {
    throw new Error(
      "Energize disabled. Set TIC_ALLOW_ENERGIZE=1 in backend/.env when ready."
    );
  }
  const serial = needSerial(axis);
  return withLock(axis, async () => {
    await runTic(serial, ["--energize"]);
    await runTic(serial, ["--exit-safe-start"]);
    state[axis].enabled = true;
    await ensureTargetPos(axis); // prime so first jog doesn't re-read status
    return readStatus(axis);
  });
}

/**
 * Halt and de-energize a motor.
 */
export async function disable(axis) {
  const serial = needSerial(axis);
  return withLock(axis, async () => {
    try {
      await halt(axis);
    } catch { /* best-effort */ }
    await runTic(serial, ["--deenergize"]);
    state[axis].enabled = false;
    return readStatus(axis);
  });
}

/**
 * Jog an axis by a relative number of steps.
 * dir: +1 (forward) or -1 (backward)
 * speed01: 0.0–1.0, scales the steps-per-tick
 *
 * The motor must be enabled first (call enable(axis)).
 */
export async function jog({ axis, dir, speed01 }) {
  const axes = getAxes();
  if (!axes[axis]) throw new Error(`Unknown axis: ${axis}`);

  const d  = Math.sign(Number(dir || 0));
  const sp = Math.max(0, Math.min(1, Number(speed01 ?? 0.3)));

  return withLock(axis, async () => {
    if (!state[axis].enabled) {
      throw new Error(`${axis} not enabled — click Enable first.`);
    }

    const curTarget = await ensureTargetPos(axis);
    const step = Math.max(1, Math.round(axes[axis].stepsPerTick * sp));
    //const next = curTarget + d * step;
// Invert pitch direction to match physical orientation
const dirCorrected = axis === "pitch" ? -d : d;
const next = curTarget + dirCorrected * step;
    await setTargetPosition(axis, next);
    return { ok: true, axis, targetPos: next, step, ts: Date.now() };
  });
}

/**
 * Immediately halt one axis (hold position).
 */
export async function stop(axis) {
  return withLock(axis, async () => {
    await halt(axis);
    return { ok: true, axis, ts: Date.now() };
  });
}

/**
 * Immediately halt both axes.
 */
export async function stopAll() {
  const results = {};
  for (const axis of Object.keys(getAxes())) {
    try {
      results[axis] = await stop(axis);
    } catch (e) {
      results[axis] = { ok: false, axis, error: String(e.message || e) };
    }
  }
  return results;
}

/**
 * Zero the encoder position for an axis (use after mechanical homing).
 */
export async function setZero(axis) {
  const serial = needSerial(axis);
  return withLock(axis, async () => {
    await runTic(serial, ["--halt-and-set-position", "0"]);
    state[axis].targetPos = 0;
    return readStatus(axis);
  });
}