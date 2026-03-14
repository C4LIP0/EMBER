/**
 * pressure.js — Node.js wrapper for pressure_reader.py
 * Sensor: AUTEX 150 PSI, 0.5V–4.5V ratiometric on 5V
 * ADS1115 channel: A0
 */

import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

let proc      = null;
let last      = null;
let buf       = "";
let onUpdateCb = null;

function pickPython() {
  if (process.env.PRESSURE_PYTHON) return process.env.PRESSURE_PYTHON;
  const venvPy = path.join(__dirname, ".venv", "bin", "python");
  if (fs.existsSync(venvPy)) return venvPy;
  return "python3";
}

export function init({ onUpdate } = {}) {
  if (proc) return;
  onUpdateCb = typeof onUpdate === "function" ? onUpdate : null;

  const script = path.join(__dirname, "pressure_reader.py");
  const py     = pickPython();

  proc = spawn(py, [script], {
    env: {
      ...process.env,
      // AUTEX 150 PSI sensor — 0.5V @ 0 PSI, 4.5V @ 150 PSI
      PRESSURE_ADS_ADDR:      process.env.PRESSURE_ADS_ADDR      || "0x48",
      PRESSURE_DIVIDER_RATIO: process.env.PRESSURE_DIVIDER_RATIO || "0.6667",
      PRESSURE_V_MIN:         process.env.PRESSURE_V_MIN         || "0.5",
      PRESSURE_V_MAX:         process.env.PRESSURE_V_MAX         || "4.5",
      PRESSURE_P_MIN:         process.env.PRESSURE_P_MIN         || "0.0",
      PRESSURE_P_MAX:         process.env.PRESSURE_P_MAX         || "150.0",
      PRESSURE_SAMPLE_PERIOD: process.env.PRESSURE_SAMPLE_PERIOD || "0.5",
      PRESSURE_AVERAGE_N:     process.env.PRESSURE_AVERAGE_N     || "8",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  proc.on("error", (err) => {
    console.error("[pressure] spawn error:", err);
    proc = null;
    setTimeout(() => init({ onUpdate: onUpdateCb }), 3000);
  });

  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        // Only update last if it's a real reading (not error/no_reading)
        if (obj.status === "ok" || obj.psi != null) {
          last = obj;
          onUpdateCb?.(obj);
        }
        // Log errors but don't crash
        if (obj.status === "error") {
          console.error("[pressure_reader.py] error:", obj.error);
        }
      } catch {
        // ignore non-json lines
      }
    }
  });

  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk) => {
    console.error("[pressure_reader.py]", chunk.trimEnd());
  });

  proc.on("exit", (code, signal) => {
    console.error("[pressure] python exited", { code, signal });
    proc = null;
    // Auto-restart after 3s
    setTimeout(() => init({ onUpdate: onUpdateCb }), 3000);
  });

  console.log("[pressure] started:", { py, script });
}

export function latest() {
  return last;
}

export function stop() {
  if (!proc) return;
  proc.kill("SIGTERM");
  proc = null;
}
