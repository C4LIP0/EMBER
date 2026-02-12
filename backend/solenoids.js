// backend/solenoids.js
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function makeId() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

class Solenoids {
  constructor() {
    this.proc = null;
    this.buf = "";
    this.pending = new Map();
    this.ready = false;
    this.lastStatus = { ready: false, lastError: null };
  }

  init() {
    if (this.proc) return;

    const script = path.join(__dirname, "solenoid_daemon.py");
    this.proc = spawn("python3", [script], { stdio: ["pipe", "pipe", "pipe"] });

    this.proc.stdout.on("data", (d) => this.#onStdout(d));
    this.proc.stderr.on("data", (d) => {
      // stderr is useful for debugging but doesn't break us
      // console.error("[solenoid_daemon stderr]", d.toString());
    });

    this.proc.on("exit", (code) => {
      this.ready = false;
      this.lastStatus = { ready: false, lastError: `daemon exited (${code})` };
      this.proc = null;
    });

    // If node dies, daemon will get stdin closed and will allOff in finally
    process.on("SIGINT", () => this.shutdown());
    process.on("SIGTERM", () => this.shutdown());
  }

  shutdown() {
    try { this.proc?.stdin?.end(); } catch {}
    try { this.proc?.kill("SIGTERM"); } catch {}
    this.proc = null;
    this.ready = false;
  }

  #onStdout(chunk) {
    this.buf += chunk.toString();
    let idx;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;

      let msg;
      try { msg = JSON.parse(line); } catch { continue; }

      if (msg.type === "ready") {
        this.ready = true;
        this.lastStatus = {
          ready: true,
          activeLow: msg.activeLow,
          pins: msg.pins,
          levels: msg.levels,
          lastError: null,
        };
        continue;
      }

      if (msg.type === "fatal") {
        this.ready = false;
        this.lastStatus = { ready: false, lastError: msg.error };
        continue;
      }

      if (msg.type === "resp") {
        const resolver = this.pending.get(msg.id);
        if (resolver) {
          this.pending.delete(msg.id);
          resolver(msg);
        }
        // also keep lastStatus updated
        if (msg.levels) {
          this.lastStatus = {
            ready: this.ready,
            activeLow: msg.activeLow,
            pins: msg.pins,
            levels: msg.levels,
            lastError: msg.ok ? null : msg.error,
          };
        }
      }
    }
  }

  status() {
    return this.lastStatus;
  }
   async #send(cmdObj, timeoutMs = 2000) {
    if (!this.proc) this.init();
    if (!this.proc) throw new Error("Solenoids daemon not running.");

    const id = makeId();
    const payload = JSON.stringify({ id, ...cmdObj }) + "\n";

    const p = new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Solenoids timeout"));
      }, timeoutMs);

      this.pending.set(id, (msg) => {
        clearTimeout(t);
        if (msg.ok === false) reject(new Error(msg.error || "Solenoids error"));
        else resolve(msg);
      });
    });

    this.proc.stdin.write(payload);
    return p;
  }

  async allOff() {
    await this.#send({ cmd: "alloff" });
    return this.status();
  }

  async shoot({ on, pulseMs } = {}) {
    if (typeof pulseMs === "number") await this.#send({ cmd: "shoot", action: "pulse", ms: pulseMs }, pulseMs + 1500);
    else if (typeof on === "boolean") await this.#send({ cmd: "shoot", action: "set", on });
    else await this.#send({ cmd: "shoot", action: "pulse", ms: 200 }, 2000);
    return this.status();
  }

  async release({ on, pulseMs } = {}) {
    if (typeof pulseMs === "number") await this.#send({ cmd: "release", action: "pulse", ms: pulseMs }, pulseMs + 1500);
    else if (typeof on === "boolean") await this.#send({ cmd: "release", action: "set", on });
    else await this.#send({ cmd: "release", action: "pulse", ms: 500 }, 2500);
    return this.status();
  }
}

export const solenoids = new Solenoids();