import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import fs, { readFileSync, writeFileSync } from "fs";
import dotenv from "dotenv";
dotenv.config({ path: new URL("./.env", import.meta.url).pathname });

console.log("ENV check:", {
  TIC_YAW_SERIAL:   process.env.TIC_YAW_SERIAL,
  TIC_PITCH_SERIAL: process.env.TIC_PITCH_SERIAL,
});

import { createRequire } from "module";
import { solenoids }   from "./solenoids.js";
import * as pressure   from "./pressure.js";
import * as imu        from "./imu.js";
import * as steppers   from "./steppers.js";
import * as anemometer from "./anemometer.js";
import * as autoAim    from "./autoAim.js";
import * as autoFire   from "./autoFire.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app  = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

// ── Serve built frontend ──────────────────────────────────────────────────
const DIST = path.join(__dirname, "../frontend/dist");
app.use(express.static(DIST));

// ── Serve offline map tiles ───────────────────────────────────────────────
app.use("/tiles", express.static(path.join(__dirname, "../tiles")));

// ── Mock sensors ──────────────────────────────────────────────────────────
let sensors = [
  { id: "BME280", type: "Env", temperatureC: 21.3, humidity: 41, pressureHpa: 1009.2, updatedAt: new Date().toISOString() },
  { id: "GPS",    type: "Position", lat: 45.5017, lon: -73.5673, altM: 35, updatedAt: new Date().toISOString() },
];

// ── Door sensor ───────────────────────────────────────────────────────────
const DOOR_PIN       = Number(process.env.DOOR_PIN       || 17);
const DOOR_GLITCH_US = Number(process.env.DOOR_GLITCH_US || 5000);

function upsertDoorSensor(payload) {
  const now = new Date().toISOString();
  const idx = sensors.findIndex(s => s.id === "DoorContact");
  const base = { id: "DoorContact", type: "Contact", updatedAt: now, ...payload };
  if (idx === -1) sensors.push(base);
  else sensors[idx] = { ...sensors[idx], ...base, updatedAt: now };
}

upsertDoorSensor({ level: null, isOpen: null, state: "UNKNOWN", pin: DOOR_PIN });

let doorGpio = null;

async function initDoorSensor() {
  try {
    const require = createRequire(import.meta.url);
    const { Gpio } = require("pigpio");
    doorGpio = new Gpio(DOOR_PIN, { mode: Gpio.INPUT, pullUpDown: Gpio.PUD_UP, alert: true });
    doorGpio.glitchFilter(DOOR_GLITCH_US);
    let lastLevel = doorGpio.digitalRead();
    const initialIsOpen = lastLevel === 1;
    upsertDoorSensor({ pin: DOOR_PIN, level: lastLevel, isOpen: initialIsOpen, state: initialIsOpen ? "OPEN" : "CLOSED", reason: "init" });
    console.log(`[door] init GPIO${DOOR_PIN} level=${lastLevel} state=${initialIsOpen ? "OPEN" : "CLOSED"}`);
    doorGpio.on("alert", (level, tick) => {
      if (level === lastLevel) return;
      lastLevel = level;
      const isOpen = level === 1;
      upsertDoorSensor({ pin: DOOR_PIN, level, isOpen, state: isOpen ? "OPEN" : "CLOSED", reason: "change", tick });
      console.log(`[door] ${isOpen ? "OPEN" : "CLOSED"}`);
    });
  } catch (err) {
    console.warn("[door] pigpio not available. Door sensor in UNKNOWN mode.");
    console.warn("[door] Error:", err?.message || err);
  }
}
initDoorSensor();

// ── Solenoids ─────────────────────────────────────────────────────────────
solenoids.init();

app.get("/api/solenoids/status", (req, res) => res.json(solenoids.status()));

app.post("/api/solenoids/allOff", async (req, res) => {
  try { res.json({ ok: true, status: await solenoids.allOff() }); }
  catch (e) { res.status(500).json({ ok: false, error: String(e.message || e), status: solenoids.status() }); }
});

app.post("/api/solenoids/shoot", async (req, res) => {
  try { res.json({ ok: true, status: await solenoids.shoot(req.body || {}) }); }
  catch (e) { res.status(500).json({ ok: false, error: String(e.message || e), status: solenoids.status() }); }
});

app.post("/api/solenoids/release", async (req, res) => {
  try { res.json({ ok: true, status: await solenoids.release(req.body || {}) }); }
  catch (e) { res.status(500).json({ ok: false, error: String(e.message || e), status: solenoids.status() }); }
});

// ── Steppers ──────────────────────────────────────────────────────────────
app.get("/api/steppers/status", async (_req, res) => {
  try { res.json({ ok: true, ...await steppers.statusAll() }); }
  catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

app.get("/api/steppers/yaw/status", async (_req, res) => {
  try { res.json(await steppers.statusAxis("yaw")); }
  catch (e) { res.status(500).json({ ok: false, axis: "yaw", error: String(e.message || e) }); }
});

app.get("/api/steppers/pitch/status", async (_req, res) => {
  try { res.json(await steppers.statusAxis("pitch")); }
  catch (e) { res.status(500).json({ ok: false, axis: "pitch", error: String(e.message || e) }); }
});

app.post("/api/steppers/enable",  async (req, res) => {
  try { res.json({ ok: true, status: await steppers.enable(req.body?.axis) }); }
  catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

app.post("/api/steppers/disable", async (req, res) => {
  try { res.json({ ok: true, status: await steppers.disable(req.body?.axis) }); }
  catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

app.post("/api/steppers/jog", async (req, res) => {
  try { const { axis, dir, speed01 } = req.body || {}; res.json(await steppers.jog({ axis, dir, speed01 })); }
  catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

app.post("/api/steppers/stop", async (req, res) => {
  try { res.json(await steppers.stop(req.body?.axis)); }
  catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

app.post("/api/steppers/stopAll", async (_req, res) => {
  try { res.json({ ok: true, ...await steppers.stopAll() }); }
  catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

app.post("/api/steppers/zero", async (req, res) => {
  try { res.json({ ok: true, status: await steppers.setZero(req.body?.axis) }); }
  catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// ── Pressure ──────────────────────────────────────────────────────────────
const pressureClients = new Set();

pressure.init({
  onUpdate: (reading) => {
    const payload = `data: ${JSON.stringify(reading)}\n\n`;
    for (const res of pressureClients) { try { res.write(payload); } catch {} }
  },
});

app.get("/api/pressure/latest", (req, res) => {
  const r = pressure.latest();
  if (!r) return res.status(503).json({ ok: false, error: "No reading yet" });
  res.json({ ok: true, ...r });
});

app.get("/api/pressure/stream", (req, res) => {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.write("retry: 1000\n\n");
  pressureClients.add(res);
  const r = pressure.latest();
  if (r) res.write(`data: ${JSON.stringify(r)}\n\n`);
  req.on("close", () => pressureClients.delete(res));
});

// ── IMU ───────────────────────────────────────────────────────────────────
const imuClients = new Set();

imu.init({
  onUpdate: (reading) => {
    const payload = `data: ${JSON.stringify(reading)}\n\n`;
    for (const res of imuClients) { try { res.write(payload); } catch {} }
  },
});

app.get("/api/imu/latest", (req, res) => {
  const r = imu.latest();
  if (!r) return res.status(503).json({ ok: false, error: "No IMU reading yet" });
  res.json({ ok: true, ...r });
});

app.get("/api/imu/stream", (req, res) => {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.write("retry: 1000\n\n");
  imuClients.add(res);
  const r = imu.latest();
  if (r) res.write(`data: ${JSON.stringify(r)}\n\n`);
  req.on("close", () => imuClients.delete(res));
});

// ── Anemometer ────────────────────────────────────────────────────────────
const anemometerClients = new Set();

anemometer.init({
  onUpdate: (reading) => {
    const payload = `data: ${JSON.stringify(reading)}\n\n`;
    for (const res of anemometerClients) { try { res.write(payload); } catch {} }
  },
});

app.get("/api/anemometer/latest", (req, res) => {
  const r = anemometer.latest();
  if (!r) return res.status(503).json({ ok: false, error: "No reading yet" });
  res.json({ ok: true, ...r });
});

app.get("/api/anemometer/stream", (req, res) => {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.write("retry: 1000\n\n");
  anemometerClients.add(res);
  const r = anemometer.latest();
  if (r) res.write(`data: ${JSON.stringify(r)}\n\n`);
  req.on("close", () => anemometerClients.delete(res));
});

// ── Auto-Aim ──────────────────────────────────────────────────────────────
app.post("/api/autoaim/start", async (req, res) => {
  try {
    const { heading, pitch } = req.body || {};
    if (typeof heading !== "number" || typeof pitch !== "number")
      return res.status(400).json({ ok: false, error: "heading and pitch required (numbers)" });
    autoAim.start({ heading, pitch });
    res.json({ ok: true, ...autoAim.status() });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post("/api/autoaim/stop", (req, res) => {
  autoAim.stopAim();
  res.json({ ok: true, ...autoAim.status() });
});

app.get("/api/autoaim/status", (req, res) => {
  res.json(autoAim.status());
});

app.get("/api/autoaim/stream", (req, res) => {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();
  res.write(`data: ${JSON.stringify(autoAim.status())}\n\n`);
  const unsub = autoAim.subscribe(msg => res.write(`data: ${msg}\n\n`));
  req.on("close", unsub);
});

// ── General ───────────────────────────────────────────────────────────────
app.get("/api/health", (_req, res) =>
  res.json({ status: "ok", time: new Date().toISOString() })
);

app.get("/api/sensors", (_req, res) => {
  const nowIso = new Date().toISOString();
  const out = sensors.map(s => ({ ...s }));

  const pr = pressure.latest?.() || null;
  out.push({ id: "Pressure", type: "Pressure", updatedAt: pr?.ts ? new Date(pr.ts).toISOString() : null, ...pr });

  const im = imu.latest?.() || null;
  out.push({ id: "IMU", type: "IMU", updatedAt: im?.ts ? new Date(im.ts).toISOString() : null, ...im });

  const sol = solenoids.status?.() || null;
  out.push({ id: "Solenoids", type: "Actuator", updatedAt: nowIso, ...sol });

  const anemo = anemometer.latest?.() || null;
  out.push({
    id: "Anemometer", type: "Wind",
    updatedAt:    anemo?.ts  ? new Date(anemo.ts).toISOString() : null,
    windSpeedMs:  anemo?.ms  ?? null,
    windSpeedKmh: anemo?.kmh ?? null,
    windVoltage:  anemo?.v   ?? null,
  });

  res.json({ sensors: out });
});

app.get("/api/door", (_req, res) => {
  const door = sensors.find(s => s.id === "DoorContact");
  res.json({ ok: true, door });
});

app.post("/api/ballistics", (req, res) => {
  const { v0, dx, dy = 0, g = 9.80665, windX = 0, windY = 0 } = req.body || {};
  if (!v0 || !dx) return res.status(400).json({ error: "v0 and dx are required" });
  const v0sq = v0 * v0;
  const termUnder = v0sq * v0sq - g * (g * dx * dx + 2 * dy * v0sq);
  if (termUnder < 0) return res.status(422).json({ error: "Target out of range for v0." });
  const root = Math.sqrt(termUnder);
  const th1  = Math.atan((v0sq + root) / (g * dx));
  const th2  = Math.atan((v0sq - root) / (g * dx));
  const theta = th2, vx = v0 * Math.cos(theta), vy = v0 * Math.sin(theta);
  const a = -0.5 * g, b = vy, c = -dy;
  const disc = b * b - 4 * a * c;
  const t = disc >= 0 ? (-b + Math.sqrt(disc)) / (2 * a) : dx / Math.max(0.001, v0 + windX);
  res.json({
    input: { v0, dx, dy, g, windX, windY },
    thetaDeg:        (theta * 180) / Math.PI,
    thetaHighArcDeg: (th1   * 180) / Math.PI,
    thetaLowArcDeg:  (th2   * 180) / Math.PI,
    timeOfFlightSec: t,
    impactVx: vx, impactVy: vy - g * t,
    notes: "Idealized vacuum model",
  });
});


// ── Auto-Fire ─────────────────────────────────────────────────────────────
app.post("/api/autofire/arm", (req, res) => {
  try {
    const { targetPsi } = req.body || {};
    if (typeof targetPsi !== "number")
      return res.status(400).json({ ok: false, error: "targetPsi required (number)" });
    autoFire.arm(targetPsi);
    res.json({ ok: true, ...autoFire.status() });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post("/api/autofire/stop", (req, res) => {
  autoFire.stopWatch();
  res.json({ ok: true, ...autoFire.status() });
});

app.post("/api/autofire/reset", (req, res) => {
  autoFire.reset();
  res.json({ ok: true, ...autoFire.status() });
});

app.get("/api/autofire/status", (req, res) => {
  res.json(autoFire.status());
});

app.get("/api/autofire/stream", (req, res) => {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();
  res.write(`data: ${JSON.stringify(autoFire.status())}\n\n`);
  const unsub = autoFire.subscribe(msg => res.write(`data: ${msg}\n\n`));
  req.on("close", unsub);
});



// ── Calibration — JSON file based ────────────────────────────────────────
import { mkdirSync } from "fs";

const CAL_DIR     = path.join(__dirname, "../calibrations");
const CAL_LATEST  = path.join(CAL_DIR, "latest.json");
const ENV_PATH    = new URL("./.env", import.meta.url).pathname;

// Ensure calibrations directory exists
try { mkdirSync(CAL_DIR, { recursive: true }); } catch {}

function readEnv() {
  try {
    const lines = readFileSync(ENV_PATH, "utf8").split("\n");
    const env = {};
    for (const line of lines) {
      const [k, ...v] = line.split("=");
      if (k && k.trim()) env[k.trim()] = v.join("=").trim();
    }
    return env;
  } catch { return {}; }
}

function writeEnvValues(updates) {
  const env = readEnv();
  Object.assign(env, updates);
  const content = Object.entries(env).map(([k,v]) => `${k}=${v}`).join("\n");
  writeFileSync(ENV_PATH, content + "\n", "utf8");
}

// GET /api/calibration — load latest.json if exists, fallback to .env
app.get("/api/calibration", (req, res) => {
  try {
    if (fs.existsSync(CAL_LATEST)) {
      const cal = JSON.parse(readFileSync(CAL_LATEST, "utf8"));
      return res.json({ ok: true, ...cal });
    }
    // Fallback to .env
    const env = readEnv();
    res.json({
      ok: true,
      yawMin:        parseFloat(env.AUTOAIM_YAW_MIN      ?? "-180"),
      yawMax:        parseFloat(env.AUTOAIM_YAW_MAX      ??  "180"),
      yawCenter:     parseFloat(env.AUTOAIM_YAW_CENTER   ??    "0"),
      pitchMin:      parseFloat(env.AUTOAIM_PITCH_MIN    ??   "45"),
      pitchMax:      parseFloat(env.AUTOAIM_PITCH_MAX    ??   "80"),
      pitchCenter:   parseFloat(env.AUTOAIM_PITCH_CENTER ??   "62"),
      headingOffset: parseFloat(env.HEADING_OFFSET       ??    "0"),
      pitchOffset:   parseFloat(env.PITCH_OFFSET         ??  "178.5"),
      efficiency:    parseFloat(env.BALLISTIC_EFF        ??   "0.26"),
    });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/calibration/history — list all saved calibrations
app.get("/api/calibration/history", (req, res) => {
  try {
    const files = fs.readdirSync(CAL_DIR)
      .filter(f => f.endsWith(".json") && f !== "latest.json")
      .map(f => {
        try {
          const cal = JSON.parse(readFileSync(path.join(CAL_DIR, f), "utf8"));
          return { file: f, ...cal };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a,b) => new Date(b.savedAt) - new Date(a.savedAt));
    res.json({ ok: true, history: files });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/calibration/save — save fresh calibration
app.post("/api/calibration/save", (req, res) => {
  try {
    const cal = {
      savedAt:       new Date().toISOString(),
      yawMin:        req.body.yawMin,
      yawMax:        req.body.yawMax,
      yawCenter:     req.body.yawCenter,
      pitchMin:      req.body.pitchMin,
      pitchMax:      req.body.pitchMax,
      pitchCenter:   req.body.pitchCenter,
      headingOffset: req.body.headingOffset,
      pitchOffset:   req.body.pitchOffset,
      efficiency:    req.body.efficiency,
    };

    // Save as latest
    writeFileSync(CAL_LATEST, JSON.stringify(cal, null, 2), "utf8");

    // Save timestamped backup
    const ts  = new Date().toISOString().replace(/[:.]/g, "-").slice(0,19);
    const bak = path.join(CAL_DIR, `calibration_${ts}.json`);
    writeFileSync(bak, JSON.stringify(cal, null, 2), "utf8");

    // Also update .env for motor limits
    writeEnvValues({
      AUTOAIM_YAW_MIN:      cal.yawMin,
      AUTOAIM_YAW_MAX:      cal.yawMax,
      AUTOAIM_YAW_CENTER:   cal.yawCenter,
      AUTOAIM_PITCH_MIN:    cal.pitchMin,
      AUTOAIM_PITCH_MAX:    cal.pitchMax,
      AUTOAIM_PITCH_CENTER: cal.pitchCenter,
      HEADING_OFFSET:       cal.headingOffset,
      PITCH_OFFSET:         cal.pitchOffset,
      BALLISTIC_EFF:        cal.efficiency,
    });

    console.log(`[cal] saved → ${bak}`);
    res.json({ ok: true, savedAt: cal.savedAt, file: `calibration_${ts}.json` });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Catch-all: serve React ────────────────────────────────────────────────
app.get("*", (req, res) => {
  res.sendFile(path.join(DIST, "index.html"));
});

// ── Start ─────────────────────────────────────────────────────────────────
const server = app.listen(PORT, "0.0.0.0", () =>
  console.log(`API + frontend listening on http://0.0.0.0:${PORT}`)
);

process.on("SIGINT", () => {
  try { if (doorGpio) doorGpio.disableAlert?.(); } catch {}
  server.close(() => process.exit(0));
});
