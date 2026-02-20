import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let proc = null;
let last = null;
let buf = "";
let onUpdateCb = null;

export function init({ onUpdate } = {}) {
  if (proc) return;
  onUpdateCb = onUpdate || null;

  const script = path.join(__dirname, "imu_reader.py");

  // use your backend venv python if available
  const py =
    process.env.IMU_PYTHON ||
    process.env.PRESSURE_PYTHON ||
    path.join(__dirname, ".venv", "bin", "python");

  proc = spawn(py, [script], {
    env: {
      ...process.env,
      IMU_BUS: process.env.IMU_BUS || "3",
      IMU_ADDR: process.env.IMU_ADDR || "0x29",
      IMU_SAMPLE_PERIOD: process.env.IMU_SAMPLE_PERIOD || "0.2",
      IMU_ROLL_OK_DEG: process.env.IMU_ROLL_OK_DEG || "3.0",
      IMU_PITCH_OK_DEG: process.env.IMU_PITCH_OK_DEG || "3.0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  proc.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        last = obj;
        onUpdateCb && onUpdateCb(obj);
      } catch {
        // ignore parse errors
      }
    }
  });

  proc.stderr.on("data", (chunk) => {
    console.error("[imu.py]", chunk.toString("utf8"));
  });

  proc.on("exit", (code) => {
    console.error("[imu] python exited", code);
    proc = null;
  });
}

export function latest() {
  return last;
}

export function stop() {
  if (!proc) return;
  proc.kill("SIGTERM");
  proc = null;
}
