import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let proc = null;
let last = null;
let buf = "";
let onUpdateCb = null;

function pickPython() {
  // Prefer explicit env var
  if (process.env.PRESSURE_PYTHON) return process.env.PRESSURE_PYTHON;

  // Prefer backend venv if present
  const venvPy = path.join(__dirname, ".venv", "bin", "python");
  if (fs.existsSync(venvPy)) return venvPy;

  // Fallback
  return "python3";
}

export function init({ onUpdate } = {}) {
  if (proc) return;
  onUpdateCb = typeof onUpdate === "function" ? onUpdate : null;

  const script = path.join(__dirname, "pressure_reader.py");
  const py = pickPython();

  proc = spawn(py, [script], {
    env: {
      ...process.env,
      PRESSURE_ADS_ADDR: process.env.PRESSURE_ADS_ADDR || "0x48",
      PRESSURE_DIVIDER_RATIO: process.env.PRESSURE_DIVIDER_RATIO || "0.6667",
      PRESSURE_P_MAX: process.env.PRESSURE_P_MAX || "100.0",
      PRESSURE_SAMPLE_PERIOD: process.env.PRESSURE_SAMPLE_PERIOD || "0.2",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  proc.on("error", (err) => {
    console.error("[pressure] spawn error:", err);
    proc = null;
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
        last = obj;
        if (onUpdateCb) onUpdateCb(obj);
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
