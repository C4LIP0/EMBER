import { execFile } from "child_process";

const TICCMD = process.env.TICCMD_PATH || "ticcmd";

const AXES = {
  yaw: {
    serial: process.env.TIC_YAW_SERIAL,
    stepsPerTick: parseInt(process.env.TIC_YAW_STEPS_PER_TICK || "250", 10),
  },
  pitch: {
    serial: process.env.TIC_PITCH_SERIAL,
    stepsPerTick: parseInt(process.env.TIC_PITCH_STEPS_PER_TICK || "450", 10),
  },
};

const ALLOW_ENERGIZE = String(process.env.TIC_ALLOW_ENERGIZE || "0") === "1";

// Per-axis runtime state
const state = {
  yaw: { targetPos: null, enabled: false, lastError: null, lastStatus: null },
  pitch: { targetPos: null, enabled: false, lastError: null, lastStatus: null },
};

// Simple per-axis mutex so we don’t interleave ticcmd calls
const locks = { yaw: Promise.resolve(), pitch: Promise.resolve() };
function withLock(axis, fn) {
  locks[axis] = locks[axis].then(fn, fn);
  return locks[axis];
}

function needSerial(axis) {
  const s = AXES[axis]?.serial;
  if (!s) throw new Error(`Missing ${axis} serial. Set TIC_${axis.toUpperCase()}_SERIAL in backend/.env`);
  return s;
}

function runTic(serial, args, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    execFile(TICCMD, ["-d", serial, ...args], { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || stdout || err.message || String(err)).trim();
        reject(new Error(msg));
        return;
      }
      resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

// Parse useful fields from ticcmd --status --full (text)
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
  // exit safe start is harmless even if already exited
  await runTic(serial, ["--exit-safe-start", "--position", String(position)]);
  state[axis].targetPos = position;
  return position;
}

async function halt(axis) {
  const serial = needSerial(axis);

  // Prefer halt-and-hold (fast stop). If your ticcmd build doesn't support it, fallback to position hold.
  try {
    await runTic(serial, ["--halt-and-hold"]);
  } catch (e) {
    // fallback: set target position = current position
    const st = await readStatus(axis);
    const cur = typeof st.currentPosition === "number" ? st.currentPosition : 0;
    await runTic(serial, ["--exit-safe-start", "--position", String(cur)]);
    state[axis].targetPos = cur;
  }
}

export async function statusAll() {
  const out = {};
  for (const axis of Object.keys(AXES)) {
    try {
      out[axis] = await withLock(axis, () => readStatus(axis));
    } catch (e) {
      out[axis] = {
        axis,
        serial: AXES[axis]?.serial || null,
        ok: false,
        ts: Date.now(),
        error: String(e.message || e),
      };
      state[axis].lastError = out[axis].error;
    }
  }
  return out;
}

export async function statusAxis(axis) {
  return withLock(axis, () => readStatus(axis));
}

export async function enable(axis) {
  if (!ALLOW_ENERGIZE) {
    throw new Error("Energize disabled. Set TIC_ALLOW_ENERGIZE=1 in backend/.env when ready.");
  }
  const serial = needSerial(axis);
  return withLock(axis, async () => {
    // These are safe to call even before motors are connected; driver might report errors if no VMOT.
    await runTic(serial, ["--energize"]);
    await runTic(serial, ["--exit-safe-start"]);
    state[axis].enabled = true;
    // prime target position
    await ensureTargetPos(axis);
    return readStatus(axis);
  });
}

export async function disable(axis) {
  const serial = needSerial(axis);
  return withLock(axis, async () => {
    try {
      await halt(axis);
    } catch {}
    await runTic(serial, ["--deenergize"]);
    state[axis].enabled = false;
    return readStatus(axis);
  });
}

// Jog = relative position stepping (no velocity-unit confusion)
export async function jog({ axis, dir, speed01 }) {
  if (!AXES[axis]) throw new Error(`Unknown axis: ${axis}`);
  const d = Math.sign(Number(dir || 0));
  const sp = Math.max(0, Math.min(1, Number(speed01 ?? 0.3)));

  return withLock(axis, async () => {
    // If not enabled, refuse (frontend should call enable)
    if (!state[axis].enabled) {
      throw new Error(`${axis} not enabled. Click Enable first.`);
    }

    const curTarget = await ensureTargetPos(axis);
    const step = Math.max(1, Math.round(AXES[axis].stepsPerTick * sp));
    const next = curTarget + d * step;

    await setTargetPosition(axis, next);
    return { ok: true, axis, targetPos: next, step, ts: Date.now() };
  });
}

export async function stop(axis) {
  return withLock(axis, async () => {
    await halt(axis);
    return { ok: true, axis, ts: Date.now() };
  });
}

export async function stopAll() {
  const results = {};
  for (const axis of Object.keys(AXES)) {
    try {
      results[axis] = await stop(axis);
    } catch (e) {
      results[axis] = { ok: false, axis, error: String(e.message || e) };
    }
  }
  return results;
}

// Optional utility: zero the position (for “home” after you align mechanically)
export async function setZero(axis) {
  const serial = needSerial(axis);
  return withLock(axis, async () => {
    await runTic(serial, ["--halt-and-set-position", "0"]);
    state[axis].targetPos = 0;
    return readStatus(axis);
  });
}