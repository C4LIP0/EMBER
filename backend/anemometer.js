import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PYTHON  = process.env.ANEMO_PYTHON || "python3";
const SCRIPT  = process.env.ANEMO_SCRIPT || path.join(__dirname, "anemometer_reader.py");
const ENABLE  = String(process.env.ENABLE_ANEMOMETER || "1") === "1";

let _latest   = null;
let _onUpdate = null;
let _buf      = "";  // line buffer fix

export function latest() {
  return _latest;
}

export function init({ onUpdate } = {}) {
  _onUpdate = onUpdate;

  if (!ENABLE) {
    console.log("[anemometer] disabled (ENABLE_ANEMOMETER=0)");
    return;
  }

  const start = () => {
    _buf = "";
    const proc = spawn(PYTHON, [SCRIPT], { env: { ...process.env } });

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      _buf += chunk;
      let idx;
      while ((idx = _buf.indexOf("\n")) >= 0) {
        const line = _buf.slice(0, idx).trim();
        _buf = _buf.slice(idx + 1);
        if (!line) continue;
        try {
          const d = JSON.parse(line);
          _latest = d;
          _onUpdate?.(d);
        } catch {}
      }
    });

    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (d) =>
      console.error("[anemometer] stderr:", d.trim())
    );

    proc.on("close", (code) => {
      console.warn(`[anemometer] exited (${code}), restarting in 2s...`);
      setTimeout(start, 2000);
    });

    console.log("[anemometer] reader started");
  };

  start();
}