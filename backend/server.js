import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createRequire } from "module";
import { solenoids } from "./solenoids.js";
import * as pressure from "./pressure.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 8080;

// ----------------------------
// Your existing mock sensors
// ----------------------------
let sensors = [
  {
    id: "BME280",
    type: "Env",
    temperatureC: 21.3,
    humidity: 41,
    pressureHpa: 1009.2,
    updatedAt: new Date().toISOString(),
  },
  {
    id: "Anemometer",
    type: "Wind",
    windSpeedMs: 4.2,
    windDirDeg: 30,
    updatedAt: new Date().toISOString(),
  },
  {
    id: "GPS",
    type: "Position",
    lat: 45.5017,
    lon: -73.5673,
    altM: 35,
    updatedAt: new Date().toISOString(),
  },
];

// ----------------------------
// Door sensor config
// ----------------------------
const DOOR_PIN = Number(process.env.DOOR_PIN || 17);        // BCM GPIO (default 17)
const DOOR_GLITCH_US = Number(process.env.DOOR_GLITCH_US || 5000); // debounce in µs

// Add a door sensor entry to your sensors array
function upsertDoorSensor(payload) {
  const now = new Date().toISOString();
  const idx = sensors.findIndex((s) => s.id === "DoorContact");
  const base = {
    id: "DoorContact",
    type: "Contact",
    updatedAt: now,
    ...payload,
  };

  if (idx === -1) sensors.push(base);
  else sensors[idx] = { ...sensors[idx], ...base, updatedAt: now };
}

// Initialize with unknown until pigpio starts
upsertDoorSensor({ level: null, isOpen: null, state: "UNKNOWN", pin: DOOR_PIN });

// ----------------------------
// pigpio setup (safe for ESM)
// ----------------------------
let doorGpio = null;

async function initDoorSensor() {
  try {
    const require = createRequire(import.meta.url);
    const pigpio = require("pigpio"); // CommonJS module
    const { Gpio } = pigpio;

    doorGpio = new Gpio(DOOR_PIN, {
      mode: Gpio.INPUT,
      pullUpDown: Gpio.PUD_UP, // internal pull-up (NC switch to GND)
      alert: true,
    });

    // debounce/glitch filter
    doorGpio.glitchFilter(DOOR_GLITCH_US);

    // Initial read
    let lastLevel = doorGpio.digitalRead();
    const initialIsOpen = lastLevel === 1; // with pull-up + switch to GND: 0=closed, 1=open
    upsertDoorSensor({
      pin: DOOR_PIN,
      level: lastLevel,
      isOpen: initialIsOpen,
      state: initialIsOpen ? "OPEN" : "CLOSED",
      reason: "init",
    });

    console.log(
      `[door] init GPIO${DOOR_PIN} level=${lastLevel} state=${initialIsOpen ? "OPEN" : "CLOSED"}`
    );

    doorGpio.on("alert", (level /* 0|1 */, tick) => {
      if (level === lastLevel) return;
      lastLevel = level;

      const isOpen = level === 1;
      upsertDoorSensor({
        pin: DOOR_PIN,
        level,
        isOpen,
        state: isOpen ? "OPEN" : "CLOSED",
        reason: "change",
        tick,
      });

      console.log(`[door] ${isOpen ? "OPEN" : "CLOSED"} (GPIO=${level})`);
    });
  } catch (err) {
    console.warn(
      "[door] pigpio not available (or not running on Pi). Door sensor will stay in mock/UNKNOWN mode."
    );
    console.warn("[door] Error:", err?.message || err);
  }
}
initDoorSensor();
// kick it off
// ----------------------------
// Solenoids setup 
// ----------------------------
solenoids.init();

app.get("/api/solenoids/status", (req, res) => {
  res.json(solenoids.status());
});

app.post("/api/solenoids/allOff", async (req, res) => {
  try {
    const status = await solenoids.allOff();
    res.json({ ok: true, status });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e), status: solenoids.status() });
  }
});

app.post("/api/solenoids/shoot", async (req, res) => {
  try {
    const { on, pulseMs } = req.body || {};
    const status = await solenoids.shoot({ on, pulseMs });
    res.json({ ok: true, status });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e), status: solenoids.status() });
  }
});

app.post("/api/solenoids/release", async (req, res) => {
  try {
    const { on, pulseMs } = req.body || {};
    const status = await solenoids.release({ on, pulseMs });
    res.json({ ok: true, status });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e), status: solenoids.status() });
  }
});

// ----------------------------
// Pressure sensor setup
// ----------------------------


const pressureClients = new Set();

pressure.init({
  onUpdate: (reading) => {
    const payload = `data: ${JSON.stringify(reading)}\n\n`;
    for (const res of pressureClients) {
      try { res.write(payload); } catch {}
    }
  },
});

app.get("/api/pressure/latest", (req, res) => {
  const r = pressure.latest();
  if (!r) return res.status(503).json({ ok: false, error: "No reading yet" });
  res.json({ ok: true, ...r });
});

app.get("/api/pressure/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");

  res.write("retry: 1000\n\n");

  pressureClients.add(res);

  const r = pressure.latest();
  if (r) res.write(`data: ${JSON.stringify(r)}\n\n`);

  req.on("close", () => {
    pressureClients.delete(res);
  });
});


// ----------------------------
// Existing endpoints
// ----------------------------
app.get("/api/health", (_req, res) =>
  res.json({ status: "ok", time: new Date().toISOString() })
);

app.get("/api/sensors", (_req, res) => res.json({ sensors }));

// New: quick door endpoint
app.get("/api/door", (_req, res) => {
  const door = sensors.find((s) => s.id === "DoorContact");
  res.json({ ok: true, door });
});

app.post("/api/ballistics", (req, res) => {
  const { v0, dx, dy = 0, g = 9.80665, windX = 0, windY = 0 } = req.body || {};
  if (!v0 || !dx) return res.status(400).json({ error: "v0 and dx are required (numbers)" });

  const v0sq = v0 * v0;
  const termUnder = v0sq * v0sq - g * (g * dx * dx + 2 * dy * v0sq);
  if (termUnder < 0)
    return res
      .status(422)
      .json({ error: "No real solution for given inputs (target out of range for v0)." });

  const root = Math.sqrt(termUnder);
  const tan1 = (v0sq + root) / (g * dx);
  const tan2 = (v0sq - root) / (g * dx);
  const th1 = Math.atan(tan1);
  const th2 = Math.atan(tan2);

  const theta = th2;
  const vx = v0 * Math.cos(theta);
  const vy = v0 * Math.sin(theta);

  const a = -0.5 * g,
    b = vy,
    c = -dy;
  const disc = b * b - 4 * a * c;
  const t = disc >= 0 ? (-b + Math.sqrt(disc)) / (2 * a) : dx / Math.max(0.001, v0 + windX);

  res.json({
    input: { v0, dx, dy, g, windX, windY },
    thetaDeg: (theta * 180) / Math.PI,
    thetaHighArcDeg: (th1 * 180) / Math.PI,
    thetaLowArcDeg: (th2 * 180) / Math.PI,
    timeOfFlightSec: t,
    impactVx: vx,
    impactVy: vy - g * t,
    notes: "Idealized vacuum model",
  });
});

// ----------------------------
// Start server
// ----------------------------
const server = app.listen(PORT, () =>
  console.log(`API listening on http://localhost:${PORT}`)
);

// Cleanup
process.on("SIGINT", () => {
  try {
    if (doorGpio) doorGpio.disableAlert?.();
  } catch {}
  server.close(() => process.exit(0));
});
