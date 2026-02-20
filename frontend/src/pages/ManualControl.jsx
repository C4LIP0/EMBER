import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * MOCK transport (no hardware needed).
 * Later you'll replace these methods with real calls to your Node backend.
 *
 * NOTE: "triggerSim" is a SAFE UI stub: it only logs an event.
 */
function createMockTransport(onEvent) {
  const emit = (type, payload) => {
    const evt = { ts: Date.now(), type, payload };
    console.log("[ManualControl]", evt);
    onEvent?.(evt);
  };

  return {
    enableAxis: async (axis) => emit("enableAxis", { axis }),
    disableAxis: async (axis) => emit("disableAxis", { axis }),

    jog: async ({ axis, dir, speed01, ttlMs }) =>
      emit("jog", { axis, dir, speed01, ttlMs }),

    stop: async (axis) => emit("stop", { axis }),
    stopAll: async () => emit("stopAll", {}),

    // SAFE STUB ONLY (simulation/log)
    triggerSim: async () => emit("triggerSim", { simulated: true }),
  };
}

function JoystickRing({ onDown, onUp, onStop }) {
  // Mapping:
  // Motor #1 (yaw): left = CLOCK, right = COUNTER  => yaw -1 / +1
  // Motor #2 (pitch): up = CLOCK, down = COUNTER   => pitch +1 / -1
  // Diagonals move BOTH motors at once.

  const [activeKey, setActiveKey] = useState(null);

  const zones = [
    { key: "N", angle: 0, yaw: 0, pitch: +1 },
    { key: "NE", angle: 45, yaw: +1, pitch: +1 },
    { key: "E", angle: 90, yaw: +1, pitch: 0 },
    { key: "SE", angle: 135, yaw: +1, pitch: -1 },
    { key: "S", angle: 180, yaw: 0, pitch: -1 },
    { key: "SW", angle: 225, yaw: -1, pitch: -1 },
    { key: "W", angle: 270, yaw: -1, pitch: 0 },
    { key: "NW", angle: 315, yaw: -1, pitch: +1 },
  ];

  const yawText = (v) => (v === 0 ? null : v < 0 ? "clock" : "counter"); // #1
  const pitchText = (v) => (v === 0 ? null : v > 0 ? "clock" : "counter"); // #2

  const ZoneBtn = ({ z }) => {
    const lines = [];
    if (z.pitch !== 0)
      lines.push({ cls: "m2", text: `#2 ${pitchText(z.pitch)}` });
    if (z.yaw !== 0) lines.push({ cls: "m1", text: `#1 ${yawText(z.yaw)}` });

    return (
      <button
        className={`joy-zone ${activeKey === z.key ? "is-active" : ""}`}
        style={{ "--ang": `${z.angle}deg` }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          setActiveKey(z.key);
          onDown?.({ yaw: z.yaw, pitch: z.pitch });
        }}
        onPointerUp={() => {
          setActiveKey(null);
          onUp?.({ yaw: z.yaw, pitch: z.pitch });
        }}
        onPointerCancel={() => {
          setActiveKey(null);
          onUp?.({ yaw: z.yaw, pitch: z.pitch });
        }}
        onPointerLeave={() => {
          setActiveKey(null);
          onUp?.({ yaw: z.yaw, pitch: z.pitch });
        }}
      >
        <div className="joy-tri" />
        <div className="joy-text" style={{ transform: `rotate(${-z.angle}deg)` }}>
          {lines.map((l) => (
            <span key={l.text} className={`joy-pill ${l.cls}`}>
              {l.text}
            </span>
          ))}
        </div>
      </button>
    );
  };

  return (
    <div className="joy-wrap">
      <div className="joy-ring">
        {zones.map((z) => (
          <ZoneBtn key={z.key} z={z} />
        ))}

        <button
          className="joy-stop"
          onClick={() => {
            setActiveKey(null);
            onStop?.();
          }}
        >
          STOP
        </button>
      </div>
    </div>
  );
}

export default function ManualControl() {
  // Backend base URL (your backend is on 8080)
  const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8080";

  const [speed01, setSpeed01] = useState(0.35);
  const [ttlMs, setTtlMs] = useState(500);
  const [enabled, setEnabled] = useState({ yaw: false, pitch: false });
  const [log, setLog] = useState([]);

  // Solenoids UI state
  const [armed, setArmed] = useState(false);
  const [holdingTrigger, setHoldingTrigger] = useState(false);
  const triggerHoldTimer = useRef(null);
  const TRIGGER_HOLD_MS = 1200;

  const [solBusy, setSolBusy] = useState(false);
  const [solError, setSolError] = useState("");
  const [solReady, setSolReady] = useState(false);
  const [lastFireTs, setLastFireTs] = useState(null);
  const [lastEjectTs, setLastEjectTs] = useState(null);

  // Pressure (PSI) realtime
  const [pressure, setPressure] = useState({ psi: null, v_adc: null, ts: null });
  const [pressureConn, setPressureConn] = useState("DISCONNECTED");

  // IMU realtime
  const [imuState, setImuState] = useState({
  heading: null, roll: null, pitch: null, aligned: null, calib: null, ts: null
});
const [imuConn, setImuConn] = useState("DISCONNECTED");




  const transport = useMemo(
    () =>
      createMockTransport((evt) => {
        setLog((l) => [evt, ...l].slice(0, 20));
      }),
    []
  );

  // helper: log backend responses into the Command log
  const pushBackendLog = (type, payload) => {
    setLog((l) => [{ ts: Date.now(), type, payload }, ...l].slice(0, 20));
  };

  // generic POST helper to backend
  const solPost = async (path, body) => {
    setSolError("");
    setSolBusy(true);
    try {
      const r = await fetch(`${API_BASE}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      const j = await r.json();
      pushBackendLog(`SOL ${path}`, j);
      return j;
    } catch (e) {
      const msg = String(e?.message || e);
      setSolError(msg);
      pushBackendLog(`SOL ERROR ${path}`, { error: msg });
      throw e;
    } finally {
      setSolBusy(false);
    }
  };

  // status/detect
  const detectSolenoids = async () => {
    setSolError("");
    try {
      const r = await fetch(`${API_BASE}/api/solenoids/status`);
      const j = await r.json();
      pushBackendLog("SOL /api/solenoids/status", j);
      const s = j?.status ?? j;
      setSolReady(Boolean(s?.ready || s?.available));
      return s;
    } catch (e) {
      const msg = String(e?.message || e);
      setSolError(msg);
      setSolReady(false);
      pushBackendLog("SOL ERROR /api/solenoids/status", { error: msg });
    }
  };

  // actions
  const fireLaunch = async () => {
    await solPost("/api/solenoids/shoot", { pulseMs: 200 });
    setLastFireTs(Date.now());
  };

  const ejectAir = async () => {
    await solPost("/api/solenoids/release", { pulseMs: 500 });
    setLastEjectTs(Date.now());
  };

  const allOff = async () => {
    await solPost("/api/solenoids/allOff", {});
  };

  // REALTIME IMU (SSE -> fallback polling)
  useEffect(() => {
  let es = null;
  let pollId = null;
  let stopped = false;

  const setFromPayload = (d) => {
    setImuState({
      heading: typeof d?.heading === "number" ? d.heading : null,
      roll: typeof d?.roll === "number" ? d.roll : null,
      pitch: typeof d?.pitch === "number" ? d.pitch : null,
      aligned: typeof d?.aligned === "boolean" ? d.aligned : null,
      calib: d?.calib || null,
      ts: typeof d?.ts === "number" ? d.ts : Date.now(),
    });
  };

  const startPolling = () => {
    setImuConn("POLLING");
    pollId = window.setInterval(async () => {
      try {
        const r = await fetch(`${API_BASE}/api/imu/latest`);
        if (!r.ok) return;
        const d = await r.json();
        setFromPayload(d?.ok ? d : d);
      } catch {}
    }, 250);
  };

  const startSSE = () => {
    try {
      es = new EventSource(`${API_BASE}/api/imu/stream`);
      es.onopen = () => { if (!stopped) setImuConn("CONNECTED"); };
      es.onmessage = (e) => {
        if (stopped) return;
        try { setFromPayload(JSON.parse(e.data)); } catch {}
      };
      es.onerror = () => {
        if (stopped) return;
        try { es?.close(); } catch {}
        es = null;
        if (!pollId) startPolling();
      };
    } catch {
      startPolling();
    }
  };

  startSSE();

  return () => {
    stopped = true;
    try { es?.close(); } catch {}
    if (pollId) window.clearInterval(pollId);
  };
}, [API_BASE]);

  // REALTIME PRESSURE (SSE -> fallback polling)
  useEffect(() => {
    let es = null;
    let pollId = null;
    let stopped = false;

    const setFromPayload = (d) => {
      const psi = typeof d?.psi === "number" ? d.psi : null;
      const v_adc = typeof d?.v_adc === "number" ? d.v_adc : null;
      const ts = typeof d?.ts === "number" ? d.ts : Date.now();
      setPressure({ psi, v_adc, ts });
    };

    const startPolling = () => {
      setPressureConn("POLLING");
      pollId = window.setInterval(async () => {
        try {
          const r = await fetch(`${API_BASE}/api/pressure/latest`);
          if (!r.ok) return;
          const d = await r.json();
          // supports {ok:true, psi:...} or raw {psi:...}
          setFromPayload(d?.ok ? d : d);
        } catch {
          // keep polling silently
        }
      }, 250);
    };

    const startSSE = () => {
      try {
        es = new EventSource(`${API_BASE}/api/pressure/stream`);
        es.onopen = () => {
          if (stopped) return;
          setPressureConn("CONNECTED");
        };
        es.onmessage = (e) => {
          if (stopped) return;
          try {
            const d = JSON.parse(e.data);
            setFromPayload(d);
          } catch {
            // ignore
          }
        };
        es.onerror = () => {
          if (stopped) return;
          try {
            es?.close();
          } catch { }
          es = null;
          if (!pollId) startPolling();
        };
      } catch {
        startPolling();
      }
    };

    startSSE();

    return () => {
      stopped = true;
      try {
        es?.close();
      } catch { }
      es = null;
      if (pollId) window.clearInterval(pollId);
      pollId = null;
    };
  }, [API_BASE]);

  // hold-to-move intervals
  const timers = useRef(new Map()); // key -> intervalId

  const startJog = (axis, dir) => {
    const key = `${axis}:${dir}`;
    if (timers.current.has(key)) return;

    const send = () => {
      transport.jog({ axis, dir, speed01, ttlMs });
    };

    send();
    const id = window.setInterval(send, 200);
    timers.current.set(key, id);
  };

  const stopAxis = (axis) => {
    for (const [key, id] of timers.current.entries()) {
      if (key.startsWith(axis + ":")) {
        window.clearInterval(id);
        timers.current.delete(key);
      }
    }
    transport.stop(axis);
  };

  const stopAll = () => {
    for (const id of timers.current.values()) window.clearInterval(id);
    timers.current.clear();
    transport.stopAll();
  };

  const enableAxis = async (axis) => {
    await transport.enableAxis(axis);
    setEnabled((e) => ({ ...e, [axis]: true }));
  };

  const disableAxis = async (axis) => {
    stopAxis(axis);
    await transport.disableAxis(axis);
    setEnabled((e) => ({ ...e, [axis]: false }));
  };

  const cancelTriggerHold = () => {
    setHoldingTrigger(false);
    if (triggerHoldTimer.current) {
      clearTimeout(triggerHoldTimer.current);
      triggerHoldTimer.current = null;
    }
  };

  const startTriggerHold = () => {
    if (!armed) return;
    if (!solReady) {
      setSolError("Solenoids not ready. Click DETECT first.");
      return;
    }
    if (triggerHoldTimer.current) return;

    setHoldingTrigger(true);
    triggerHoldTimer.current = setTimeout(() => {
      fireLaunch().catch(() => { });
      setHoldingTrigger(false);
      triggerHoldTimer.current = null;
    }, TRIGGER_HOLD_MS);
  };

  // Safety: stop if tab loses focus / user changes tab
  useEffect(() => {
    const onBlur = () => {
      cancelTriggerHold();
      stopAll();
      allOff().catch(() => { });
    };
    const onVis = () => {
      if (document.visibilityState !== "visible") {
        cancelTriggerHold();
        stopAll();
        allOff().catch(() => { });
      }
    };
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keyboard: WASD + arrows. Space = STOP ALL
  useEffect(() => {
    const down = (e) => {
      if (e.repeat) return;
      if (e.key === "ArrowLeft" || e.key === "a") startJog("yaw", -1);
      if (e.key === "ArrowRight" || e.key === "d") startJog("yaw", +1);
      if (e.key === "ArrowUp" || e.key === "w") startJog("pitch", +1);
      if (e.key === "ArrowDown" || e.key === "s") startJog("pitch", -1);
      if (e.key === " ") {
        cancelTriggerHold();
        stopAll();
        allOff().catch(() => { });
      }
    };
    const up = (e) => {
      if (e.key === "ArrowLeft" || e.key === "a") stopAxis("yaw");
      if (e.key === "ArrowRight" || e.key === "d") stopAxis("yaw");
      if (e.key === "ArrowUp" || e.key === "w") stopAxis("pitch");
      if (e.key === "ArrowDown" || e.key === "s") stopAxis("pitch");
    };

    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      cancelTriggerHold();
      stopAll();
      allOff().catch(() => { });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speed01, ttlMs, armed, solReady]);

  // detect on load
  useEffect(() => {
    detectSolenoids();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Minimal inline styles so it looks OK even without new CSS
  const pill = {
    display: "inline-flex",
    alignItems: "center",
    gap: 10,
    padding: "8px 12px",
    borderRadius: 999,
    border: "1px solid var(--border)",
    cursor: "pointer",
    userSelect: "none",
  };

  const triggerBtn = (disabled) => ({
    width: "100%",
    marginTop: 12,
    borderRadius: 14,
    padding: "14px 14px",
    fontWeight: 900,
    letterSpacing: ".4px",
    border: "1px solid var(--border)",
    background: holdingTrigger ? "rgba(176,0,32,.22)" : "rgba(176,0,32,.10)",
    color: "#b00020",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
  });

  const ejectBtn = (disabled) => ({
    width: "100%",
    marginTop: 10,
    borderRadius: 14,
    padding: "14px 14px",
    fontWeight: 900,
    letterSpacing: ".4px",
    border: "1px solid var(--border)",
    background: "rgba(0,120,255,.10)",
    color: "#0b57d0",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
  });

  const pressureBig = {
    fontSize: 34,
    fontWeight: 900,
    lineHeight: 1.0,
    marginTop: 8,
  };

  return (
    <div className="mc-wrap">
      <div className="mc-header">
        <h2>Manual Control</h2>
        <button
          className="mc-stop"
          onClick={() => {
            cancelTriggerHold();
            stopAll();
            allOff().catch(() => { });
          }}
        >
          STOP ALL
        </button>
      </div>

      <div className="mc-grid">
        <div className="mc-card">
          <div className="mc-card-title">Speed</div>
          <div className="mc-row">
            <input
              type="range"
              min="0.05"
              max="1"
              step="0.01"
              value={speed01}
              onChange={(e) => setSpeed01(parseFloat(e.target.value))}
            />
            <span className="mc-muted">{Math.round(speed01 * 100)}%</span>
          </div>

          <div className="mc-card-title" style={{ marginTop: 12 }}>
            Deadman TTL
          </div>
          <div className="mc-row">
            <input
              type="range"
              min="150"
              max="900"
              step="50"
              value={ttlMs}
              onChange={(e) => setTtlMs(parseInt(e.target.value, 10))}
            />
            <span className="mc-muted">{ttlMs}ms</span>
          </div>

          <div className="mc-hint">
            Hold joystick zones or use WASD/arrows. Space = STOP.
          </div>
        </div>

        <div className="mc-card">
          <div className="mc-card-title">Motors</div>

          <div className="mc-motor-row">
            <div>
              <div className="mc-motor-name">Yaw (#1)</div>
              <div className="mc-muted">Enabled: {enabled.yaw ? "YES" : "NO"}</div>
            </div>
            <div className="mc-actions">
              <button onClick={() => enableAxis("yaw")}>Enable</button>
              <button onClick={() => disableAxis("yaw")}>Disable</button>
            </div>
          </div>

          <div className="mc-motor-row">
            <div>
              <div className="mc-motor-name">Pitch (#2)</div>
              <div className="mc-muted">Enabled: {enabled.pitch ? "YES" : "NO"}</div>
            </div>
            <div className="mc-actions">
              <button onClick={() => enableAxis("pitch")}>Enable</button>
              <button onClick={() => disableAxis("pitch")}>Disable</button>
            </div>
          </div>

          <div className="mc-hint">
            Mock now. Later: send to Node backend {"->"} ticcmd.
          </div>
        </div>

        {/* PRESSURE CARD */}
        <div className="mc-card">
          <div className="mc-card-title">Pressure</div>

          <div style={pressureBig}>
            {pressure.psi == null ? "--" : `${pressure.psi.toFixed(1)} PSI`}
          </div>

          <div className="mc-muted" style={{ marginTop: 6 }}>
            A0: {pressure.v_adc == null ? "--" : `${pressure.v_adc.toFixed(3)} V`}
          </div>

          <div className="mc-muted">
            Updated: {pressure.ts ? new Date(pressure.ts).toLocaleTimeString() : "--"}
          </div>

          <div className="mc-hint" style={{ marginTop: 8 }}>
            Stream: <span className="mc-muted">{pressureConn}</span>
          </div>

          <div className="mc-hint" style={{ marginTop: 6 }}>
            Backend: <span className="mc-muted">{API_BASE}</span>
          </div>
        </div>
        {/* REAL IMU PANEL */}
        <div className="mc-card">
          <div className="mc-card-title">IMU (BNO055)</div>

          <div className="mc-muted">Stream: <span className="mc-muted">{imuConn}</span></div>

          <div style={{ fontSize: 18, fontWeight: 800, marginTop: 8 }}>
            {imuState.aligned == null ? "ALIGN: --" : imuState.aligned ? "ALIGN: OK ?" : "ALIGN: OFF ?"}
          </div>

          <div className="mc-muted" style={{ marginTop: 6 }}>
            Heading: {imuState.heading == null ? "--" : imuState.heading.toFixed(1)}�
            <br />
            Roll: {imuState.roll == null ? "--" : imuState.roll.toFixed(1)}�
            <br />
            Pitch: {imuState.pitch == null ? "--" : imuState.pitch.toFixed(1)}�
          </div>

          <div className="mc-muted" style={{ marginTop: 6 }}>
            Calib SYS/G/A/M:{" "}
            {imuState.calib
              ? `${imuState.calib.sys}/${imuState.calib.g}/${imuState.calib.a}/${imuState.calib.m}`
              : "--"}
          </div>

          <div className="mc-muted" style={{ marginTop: 6 }}>
            Updated: {imuState.ts ? new Date(imuState.ts).toLocaleTimeString() : "--"}
          </div>
        </div>

        {/* REAL solenoid controls */}
        <div className="mc-card">
          <div className="mc-card-title">Actions</div>

          <div className="mc-motor-row">
            <div>
              <div className="mc-motor-name">Arm</div>
              <div className="mc-muted">
                Required before FIRE / EJECT - Status: {solReady ? "READY" : "NOT READY"}
              </div>
            </div>

            <label style={pill}>
              <input
                type="checkbox"
                checked={armed}
                onChange={(e) => {
                  cancelTriggerHold();
                  setArmed(e.target.checked);
                }}
              />
              <span style={{ fontWeight: 800 }}>{armed ? "ARMED" : "SAFE"}</span>
            </label>
          </div>

          <div className="mc-row" style={{ gap: 10, marginTop: 8 }}>
            <button onClick={detectSolenoids} disabled={solBusy} style={{ width: "auto" }}>
              DETECT
            </button>
            <button
              onClick={() => allOff().catch(() => { })}
              disabled={solBusy}
              style={{ width: "auto" }}
            >
              ALL OFF
            </button>
          </div>

          <button
            style={triggerBtn(!armed || !solReady || solBusy)}
            disabled={!armed || !solReady || solBusy}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              startTriggerHold();
            }}
            onPointerUp={cancelTriggerHold}
            onPointerCancel={cancelTriggerHold}
            onPointerLeave={cancelTriggerHold}
          >
            {holdingTrigger
              ? `HOLDING... (${TRIGGER_HOLD_MS}ms)`
              : "HOLD TO FIRE / LAUNCH (GPIO23)"}
          </button>

          <button
            style={ejectBtn(!armed || !solReady || solBusy)}
            disabled={!armed || !solReady || solBusy}
            onClick={() => ejectAir().catch(() => { })}
          >
            EJECT AIR (EMERGENCY) (GPIO24)
          </button>

          {solError ? (
            <div className="mc-hint" style={{ color: "#b00020", marginTop: 10 }}>
              {solError}
            </div>
          ) : null}

          <div className="mc-hint" style={{ marginTop: 10 }}>
            {lastFireTs ? `Last FIRE: ${new Date(lastFireTs).toLocaleTimeString()}` : "Last FIRE: --"}{" "}
            <br />
            {lastEjectTs
              ? `Last EJECT: ${new Date(lastEjectTs).toLocaleTimeString()}`
              : "Last EJECT: --"}
          </div>
        </div>

        <div className="mc-card">
          <div className="mc-card-title">Joystick</div>
          <JoystickRing
            onDown={({ yaw, pitch }) => {
              if (yaw !== 0) startJog("yaw", yaw);
              if (pitch !== 0) startJog("pitch", pitch);
            }}
            onUp={({ yaw, pitch }) => {
              if (yaw !== 0) stopAxis("yaw");
              if (pitch !== 0) stopAxis("pitch");
            }}
            onStop={() => {
              cancelTriggerHold();
              stopAll();
              allOff().catch(() => { });
            }}
          />
        </div>
      </div>

      <div className="mc-card">
        <div className="mc-card-title">Command log</div>
        <div className="mc-log">
          {log.length === 0 ? (
            <div className="mc-muted">No commands yet.</div>
          ) : (
            log.map((x) => (
              <div key={x.ts} className="mc-log-line">
                <span className="mc-muted">{new Date(x.ts).toLocaleTimeString()}</span>
                <span className="mc-log-type">{x.type}</span>
                <span className="mc-muted">{JSON.stringify(x.payload)}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}