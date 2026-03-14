import React, { useEffect, useMemo, useRef, useState } from "react";

function createApiTransport(API_BASE, onEvent) {
  const emit = (type, payload) => {
    const evt = { ts: Date.now(), type, payload };
    console.log("[ManualControl]", evt);
    onEvent?.(evt);
  };

  const post = async (path, body) => {
    const r = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const j = await r.json();
    emit(`API ${path}`, j);
    if (!r.ok || j?.ok === false) throw new Error(j?.error || `HTTP ${r.status}`);
    return j;
  };

  return {
    enableAxis:  async (axis)                   => post("/api/steppers/enable",  { axis }),
    disableAxis: async (axis)                   => post("/api/steppers/disable", { axis }),
    jog:         async ({ axis, dir, speed01 }) => post("/api/steppers/jog",     { axis, dir, speed01 }),
    stop:        async (axis)                   => post("/api/steppers/stop",    { axis }),
    stopAll:     async ()                       => post("/api/steppers/stopAll", {}),
  };
}

function JoystickRing({ onDown, onUp, onStop }) {
  const [activeKey, setActiveKey] = useState(null);

  const zones = [
    { key: "N",  angle: 0,   yaw:  0, pitch: -1 },
    { key: "NE", angle: 45,  yaw: +1, pitch: -1 },
    { key: "E",  angle: 90,  yaw: +1, pitch:  0 },
    { key: "SE", angle: 135, yaw: +1, pitch: +1 },
    { key: "S",  angle: 180, yaw:  0, pitch: +1 },
    { key: "SW", angle: 225, yaw: -1, pitch: +1 },
    { key: "W",  angle: 270, yaw: -1, pitch:  0 },
    { key: "NW", angle: 315, yaw: -1, pitch: -1 },
  ];

  const yawText   = (v) => (v === 0 ? null : v < 0 ? "clock" : "counter");
  const pitchText = (v) => (v === 0 ? null : v > 0 ? "clock" : "counter");

  const ZoneBtn = ({ z }) => {
    const lines = [];
    if (z.pitch !== 0) lines.push({ cls: "m2", text: `#2 ${pitchText(z.pitch)}` });
    if (z.yaw   !== 0) lines.push({ cls: "m1", text: `#1 ${yawText(z.yaw)}` });

    return (
      <button
        className={`joy-zone ${activeKey === z.key ? "is-active" : ""}`}
        style={{ "--ang": `${z.angle}deg` }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          setActiveKey(z.key);
          onDown?.({ yaw: z.yaw, pitch: z.pitch });
        }}
        onPointerUp={()     => { setActiveKey(null); onUp?.({ yaw: z.yaw, pitch: z.pitch }); }}
        onPointerCancel={()  => { setActiveKey(null); onUp?.({ yaw: z.yaw, pitch: z.pitch }); }}
        onPointerLeave={()   => { setActiveKey(null); onUp?.({ yaw: z.yaw, pitch: z.pitch }); }}
      >
        <div className="joy-tri" />
        <div className="joy-text" style={{ transform: `rotate(${-z.angle}deg)` }}>
          {lines.map((l) => (
            <span key={l.text} className={`joy-pill ${l.cls}`}>{l.text}</span>
          ))}
        </div>
      </button>
    );
  };

  return (
    <div className="joy-wrap">
      <div className="joy-ring">
        {zones.map((z) => <ZoneBtn key={z.key} z={z} />)}
        <button className="joy-stop" onClick={() => { setActiveKey(null); onStop?.(); }}>
          STOP
        </button>
      </div>
    </div>
  );
}

export default function ManualControl() {
  const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8080";

  // ── Per-axis speed sliders ──────────────────────────────────────────────
  const [yawSpeed01,   setYawSpeed01]   = useState(0.35);
  const [pitchSpeed01, setPitchSpeed01] = useState(0.80);

  const [ttlMs,      setTtlMs]      = useState(500);
  const [enabled,    setEnabled]    = useState({ yaw: false, pitch: false });
  const [motorError, setMotorError] = useState("");
  const [log,        setLog]        = useState([]);

  // Solenoids
  const [armed,          setArmed]          = useState(false);
  const [holdingTrigger, setHoldingTrigger] = useState(false);
  const triggerHoldTimer = useRef(null);
  const TRIGGER_HOLD_MS  = 3000;
  const [solBusy,     setSolBusy]     = useState(false);
  const [solError,    setSolError]    = useState("");
  const [solReady,    setSolReady]    = useState(false);
  const [lastFireTs,  setLastFireTs]  = useState(null);
  const [lastEjectTs, setLastEjectTs] = useState(null);

  // Pressure
  const [pressure,     setPressure]     = useState({ psi: null, v_adc: null, ts: null });
  const [pressureConn, setPressureConn] = useState("DISCONNECTED");

  // IMU
  const [imuState, setImuState] = useState({
    heading: null, roll: null, pitch: null, aligned: null, calib: null, ts: null,
  });
  const [imuConn, setImuConn] = useState("DISCONNECTED");

  // Wind
  const [wind,     setWind]     = useState({ ms: null, kmh: null, v: null, ts: null });
  const [windConn, setWindConn] = useState("DISCONNECTED");

  // ── Transport ───────────────────────────────────────────────────────────
  const transport = useMemo(
    () => createApiTransport(API_BASE, (evt) => setLog((l) => [evt, ...l].slice(0, 20))),
    [API_BASE]
  );

  const pushBackendLog = (type, payload) =>
    setLog((l) => [{ ts: Date.now(), type, payload }, ...l].slice(0, 20));

  // ── Solenoid helpers ────────────────────────────────────────────────────
  const solPost = async (path, body) => {
    setSolError(""); setSolBusy(true);
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
      setSolError(msg); setSolReady(false);
      pushBackendLog("SOL ERROR /api/solenoids/status", { error: msg });
    }
  };

  const fireLaunch = async () => { await solPost("/api/solenoids/shoot",   { pulseMs: 3000 }); setLastFireTs(Date.now()); };
  const ejectAir   = async () => { await solPost("/api/solenoids/release", { pulseMs: 500  }); setLastEjectTs(Date.now()); };
  const allOff     = async () => { await solPost("/api/solenoids/allOff",  {}); };

  // ── IMU SSE ─────────────────────────────────────────────────────────────
  useEffect(() => {
    let es = null, pollId = null, stopped = false;
    const set = (d) => setImuState({
      heading: typeof d?.heading === "number" ? d.heading : null,
      roll:    typeof d?.roll    === "number" ? d.roll    : null,
      pitch:   typeof d?.pitch   === "number" ? d.pitch   : null,
      aligned: typeof d?.aligned === "boolean" ? d.aligned : null,
      calib:   d?.calib || null,
      ts:      typeof d?.ts === "number" ? d.ts : Date.now(),
    });
    const poll = () => {
      setImuConn("POLLING");
      pollId = window.setInterval(async () => {
        try { const r = await fetch(`${API_BASE}/api/imu/latest`); if (!r.ok) return; set(await r.json()); } catch {}
      }, 250);
    };
    try {
      es = new EventSource(`${API_BASE}/api/imu/stream`);
      es.onopen    = () => { if (!stopped) setImuConn("CONNECTED"); };
      es.onmessage = (e) => { if (stopped) return; try { set(JSON.parse(e.data)); } catch {} };
      es.onerror   = () => { if (stopped) return; es?.close(); es = null; if (!pollId) poll(); };
    } catch { poll(); }
    return () => { stopped = true; try { es?.close(); } catch {} if (pollId) window.clearInterval(pollId); };
  }, [API_BASE]);

  // ── Pressure SSE ────────────────────────────────────────────────────────
  useEffect(() => {
    let es = null, pollId = null, stopped = false;
    const set = (d) => setPressure({
      psi:   typeof d?.psi   === "number" ? d.psi   : null,
      v_adc: typeof d?.v_adc === "number" ? d.v_adc : null,
      ts:    typeof d?.ts    === "number" ? d.ts    : Date.now(),
    });
    const poll = () => {
      setPressureConn("POLLING");
      pollId = window.setInterval(async () => {
        try { const r = await fetch(`${API_BASE}/api/pressure/latest`); if (!r.ok) return; set(await r.json()); } catch {}
      }, 250);
    };
    try {
      es = new EventSource(`${API_BASE}/api/pressure/stream`);
      es.onopen    = () => { if (!stopped) setPressureConn("CONNECTED"); };
      es.onmessage = (e) => { if (stopped) return; try { set(JSON.parse(e.data)); } catch {} };
      es.onerror   = () => { if (stopped) return; es?.close(); es = null; if (!pollId) poll(); };
    } catch { poll(); }
    return () => { stopped = true; try { es?.close(); } catch {} if (pollId) window.clearInterval(pollId); };
  }, [API_BASE]);

  // ── Wind SSE ─────────────────────────────────────────────────────────────
  useEffect(() => {
    let es = null, pollId = null, stopped = false;
    const set = (d) => setWind({
      ms:  typeof d?.ms  === "number" ? d.ms  : null,
      kmh: typeof d?.kmh === "number" ? d.kmh : null,
      v:   typeof d?.v   === "number" ? d.v   : null,
      ts:  typeof d?.ts  === "number" ? d.ts  : Date.now(),
    });
    const poll = () => {
      setWindConn("POLLING");
      pollId = window.setInterval(async () => {
        try { const r = await fetch(`${API_BASE}/api/anemometer/latest`); if (!r.ok) return; set(await r.json()); } catch {}
      }, 300);
    };
    try {
      es = new EventSource(`${API_BASE}/api/anemometer/stream`);
      es.onopen    = () => { if (!stopped) setWindConn("CONNECTED"); };
      es.onmessage = (e) => { if (stopped) return; try { set(JSON.parse(e.data)); } catch {} };
      es.onerror   = () => { if (stopped) return; es?.close(); es = null; if (!pollId) poll(); };
    } catch { poll(); }
    return () => { stopped = true; try { es?.close(); } catch {} if (pollId) window.clearInterval(pollId); };
  }, [API_BASE]);

  // ── Jog helpers ─────────────────────────────────────────────────────────
  const timers = useRef(new Map());

  const getSpeed = (axis) => axis === "pitch" ? pitchSpeed01 : yawSpeed01;

  const startJog = (axis, dir) => {
    const key = `${axis}:${dir}`;
    if (timers.current.has(key)) return;
    const send = () => transport.jog({ axis, dir, speed01: getSpeed(axis), ttlMs });
    send();
    timers.current.set(key, window.setInterval(send, 200));
  };

  const stopAxis = (axis) => {
    for (const [key, id] of timers.current.entries()) {
      if (key.startsWith(axis + ":")) { window.clearInterval(id); timers.current.delete(key); }
    }
    transport.stop(axis);
  };

  const stopAll = () => {
    for (const id of timers.current.values()) window.clearInterval(id);
    timers.current.clear();
    transport.stopAll();
  };

  const enableAxis = async (axis) => {
    try {
      await transport.enableAxis(axis);
      setEnabled((e) => ({ ...e, [axis]: true }));
      setMotorError("");
    } catch (e) { setMotorError(`Enable ${axis} failed: ${e.message}`); }
  };

  const disableAxis = async (axis) => {
    try {
      stopAxis(axis);
      await transport.disableAxis(axis);
      setEnabled((e) => ({ ...e, [axis]: false }));
      setMotorError("");
    } catch (e) { setMotorError(`Disable ${axis} failed: ${e.message}`); }
  };

  // ── Trigger hold ────────────────────────────────────────────────────────
  const cancelTriggerHold = () => {
    setHoldingTrigger(false);
    if (triggerHoldTimer.current) { clearTimeout(triggerHoldTimer.current); triggerHoldTimer.current = null; }
  };

  const startTriggerHold = () => {
    if (!armed) return;
    if (!solReady) { setSolError("Solenoids not ready. Click DETECT first."); return; }
    if (triggerHoldTimer.current) return;
    setHoldingTrigger(true);
    triggerHoldTimer.current = setTimeout(() => {
      fireLaunch().catch(() => {});
      setHoldingTrigger(false);
      triggerHoldTimer.current = null;
    }, TRIGGER_HOLD_MS);
  };

  // ── Safety: blur / visibility ───────────────────────────────────────────
  useEffect(() => {
    const onBlur = () => { cancelTriggerHold(); stopAll(); allOff().catch(() => {}); };
    const onVis  = () => { if (document.visibilityState !== "visible") { cancelTriggerHold(); stopAll(); allOff().catch(() => {}); } };
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVis);
    return () => { window.removeEventListener("blur", onBlur); document.removeEventListener("visibilitychange", onVis); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Keyboard WASD + arrows ──────────────────────────────────────────────
  useEffect(() => {
    const down = (e) => {
      if (e.repeat) return;
      if (e.key === "ArrowLeft"  || e.key === "a") startJog("yaw",   -1);
      if (e.key === "ArrowRight" || e.key === "d") startJog("yaw",   +1);
      if (e.key === "ArrowUp"    || e.key === "w") startJog("pitch", -1);
      if (e.key === "ArrowDown"  || e.key === "s") startJog("pitch", +1);
      if (e.key === " ") { cancelTriggerHold(); stopAll(); allOff().catch(() => {}); }
    };
    const up = (e) => {
      if (e.key === "ArrowLeft"  || e.key === "a") stopAxis("yaw");
      if (e.key === "ArrowRight" || e.key === "d") stopAxis("yaw");
      if (e.key === "ArrowUp"    || e.key === "w") stopAxis("pitch");
      if (e.key === "ArrowDown"  || e.key === "s") stopAxis("pitch");
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup",   up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup",   up);
      cancelTriggerHold(); stopAll(); allOff().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [yawSpeed01, pitchSpeed01, ttlMs, armed, solReady]);

  useEffect(() => { detectSolenoids(); }, []); // eslint-disable-line

  // ── Wind label helper ───────────────────────────────────────────────────
  const windLabel = (ms) => {
    if (ms == null) return "--";
    if (ms < 0.5)  return "Calm";
    if (ms < 3.3)  return "Light breeze";
    if (ms < 7.9)  return "Gentle breeze";
    if (ms < 13.8) return "Moderate breeze";
    if (ms < 20.7) return "Fresh breeze";
    if (ms < 28.4) return "Strong breeze";
    return "Storm";
  };

  // ── Styles ──────────────────────────────────────────────────────────────
  const pill = {
    display: "inline-flex", alignItems: "center", gap: 10,
    padding: "8px 12px", borderRadius: 999,
    border: "1px solid var(--border)", cursor: "pointer", userSelect: "none",
  };

  const triggerBtn = (disabled) => ({
    width: "100%", marginTop: 12, borderRadius: 14, padding: "14px 14px",
    fontWeight: 900, letterSpacing: ".4px", border: "1px solid var(--border)",
    background: holdingTrigger ? "rgba(176,0,32,.22)" : "rgba(176,0,32,.10)",
    color: "#b00020", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1,
  });

  const ejectBtn = (disabled) => ({
    width: "100%", marginTop: 10, borderRadius: 14, padding: "14px 14px",
    fontWeight: 900, letterSpacing: ".4px", border: "1px solid var(--border)",
    background: "rgba(0,120,255,.10)", color: "#0b57d0",
    cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1,
  });

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="mc-wrap">
      <div className="mc-header">
        <h2>Manual Control</h2>
        <button className="mc-stop" onClick={() => { cancelTriggerHold(); stopAll(); allOff().catch(() => {}); }}>
          STOP ALL
        </button>
      </div>

      <div className="mc-grid">

        {/* ── Speed card ── */}
        <div className="mc-card">
          <div className="mc-card-title">Speed</div>

          <div className="mc-card-title" style={{ marginTop: 4, fontSize: 12, color: "var(--muted)" }}>
            Yaw (#1)
          </div>
          <div className="mc-row">
            <input
              type="range" min="0.05" max="1" step="0.01"
              value={yawSpeed01}
              onChange={(e) => setYawSpeed01(parseFloat(e.target.value))}
            />
            <span className="mc-muted">{Math.round(yawSpeed01 * 100)}%</span>
          </div>

          <div className="mc-card-title" style={{ marginTop: 10, fontSize: 12, color: "var(--muted)" }}>
            Pitch / Gearbox (#2)
          </div>
          <div className="mc-row">
            <input
              type="range" min="0.05" max="1" step="0.01"
              value={pitchSpeed01}
              onChange={(e) => setPitchSpeed01(parseFloat(e.target.value))}
            />
            <span className="mc-muted">{Math.round(pitchSpeed01 * 100)}%</span>
          </div>

          <div className="mc-card-title" style={{ marginTop: 12 }}>Deadman TTL</div>
          <div className="mc-row">
            <input
              type="range" min="150" max="900" step="50"
              value={ttlMs}
              onChange={(e) => setTtlMs(parseInt(e.target.value, 10))}
            />
            <span className="mc-muted">{ttlMs}ms</span>
          </div>

          <div className="mc-hint">Hold joystick zones or use WASD/arrows. Space = STOP.</div>
        </div>

        {/* ── Motors card ── */}
        <div className="mc-card">
          <div className="mc-card-title">Motors</div>

          <div className="mc-motor-row">
            <div>
              <div className="mc-motor-name">Yaw (#1)</div>
              <div className="mc-muted">
                Enabled: {enabled.yaw ? "YES" : "NO"} | Speed: {Math.round(yawSpeed01 * 100)}%
              </div>
            </div>
            <div className="mc-actions">
              <button onClick={() => enableAxis("yaw")}>Enable</button>
              <button onClick={() => disableAxis("yaw")}>Disable</button>
            </div>
          </div>

          <div className="mc-motor-row">
            <div>
              <div className="mc-motor-name">Pitch / Gearbox (#2)</div>
              <div className="mc-muted">
                Enabled: {enabled.pitch ? "YES" : "NO"} | Speed: {Math.round(pitchSpeed01 * 100)}%
              </div>
            </div>
            <div className="mc-actions">
              <button onClick={() => enableAxis("pitch")}>Enable</button>
              <button onClick={() => disableAxis("pitch")}>Disable</button>
            </div>
          </div>

          {motorError && (
            <div className="mc-hint" style={{ color: "#b00020", marginTop: 8 }}>
              {motorError}
            </div>
          )}
        </div>

        {/* ── Pressure card ── */}
        <div className="mc-card">
          <div className="mc-card-title">Pressure</div>
          <div style={{ fontSize: 34, fontWeight: 900, lineHeight: 1.0, marginTop: 8 }}>
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
          <div className="mc-hint">
            Backend: <span className="mc-muted">{API_BASE}</span>
          </div>
        </div>

        {/* ── Wind card ── */}
        <div className="mc-card">
          <div className="mc-card-title">Wind Speed</div>
          <div style={{ fontSize: 34, fontWeight: 900, lineHeight: 1.0, marginTop: 8 }}>
            {wind.ms == null ? "--" : `${wind.ms.toFixed(1)} m/s`}
          </div>
          <div className="mc-muted" style={{ marginTop: 6 }}>
            {wind.kmh == null ? "--" : `${wind.kmh.toFixed(1)} km/h`}
          </div>
          <div className="mc-muted" style={{ marginTop: 4 }}>
            {windLabel(wind.ms)}
          </div>
          <div className="mc-muted" style={{ marginTop: 4 }}>
            A1: {wind.v == null ? "--" : `${wind.v.toFixed(3)} V`}
          </div>
          <div className="mc-muted">
            Updated: {wind.ts ? new Date(wind.ts).toLocaleTimeString() : "--"}
          </div>
          <div className="mc-hint" style={{ marginTop: 8 }}>
            Stream: <span className="mc-muted">{windConn}</span>
          </div>
        </div>

        {/* ── IMU card ── */}
        <div className="mc-card">
          <div className="mc-card-title">IMU (BNO055)</div>

          {/* Heading */}
          <div className="mc-muted" style={{ marginTop: 8, fontSize: 12 }}>Heading</div>
          <div style={{ fontSize: 34, fontWeight: 900, lineHeight: 1.0 }}>
            {imuState.heading == null ? "--" : `${imuState.heading.toFixed(1)}°`}
          </div>

          {/* Pitch */}
          <div className="mc-muted" style={{ marginTop: 12, fontSize: 12 }}>Pitch</div>
          <div style={{ fontSize: 34, fontWeight: 900, lineHeight: 1.0 }}>
            {imuState.pitch == null ? "--" : `${imuState.pitch.toFixed(1)}°`}
          </div>

          <div className="mc-muted" style={{ marginTop: 10 }}>
            Updated: {imuState.ts ? new Date(imuState.ts).toLocaleTimeString() : "--"}
          </div>
          <div className="mc-hint" style={{ marginTop: 4 }}>
            Stream: <span className="mc-muted">{imuConn}</span>
          </div>
        </div>

        {/* ── Actions / Solenoids card ── */}
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
                type="checkbox" checked={armed}
                onChange={(e) => { cancelTriggerHold(); setArmed(e.target.checked); }}
              />
              <span style={{ fontWeight: 800 }}>{armed ? "ARMED" : "SAFE"}</span>
            </label>
          </div>

          <div className="mc-row" style={{ gap: 10, marginTop: 8 }}>
            <button onClick={detectSolenoids} disabled={solBusy} style={{ width: "auto" }}>DETECT</button>
            <button onClick={() => allOff().catch(() => {})} disabled={solBusy} style={{ width: "auto" }}>ALL OFF</button>
          </div>

          <button
            style={triggerBtn(!armed || !solReady || solBusy)}
            disabled={!armed || !solReady || solBusy}
            onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); startTriggerHold(); }}
            onPointerUp={cancelTriggerHold}
            onPointerCancel={cancelTriggerHold}
            onPointerLeave={cancelTriggerHold}
          >
            {holdingTrigger ? `HOLDING... (${TRIGGER_HOLD_MS}ms)` : "HOLD TO FIRE / LAUNCH — 3s (GPIO23)"}
          </button>

          <button
            style={ejectBtn(!armed || !solReady || solBusy)}
            disabled={!armed || !solReady || solBusy}
            onClick={() => ejectAir().catch(() => {})}
          >
            EJECT AIR (EMERGENCY) (GPIO24)
          </button>

          {solError && (
            <div className="mc-hint" style={{ color: "#b00020", marginTop: 10 }}>{solError}</div>
          )}

          <div className="mc-hint" style={{ marginTop: 10 }}>
            {lastFireTs  ? `Last FIRE: ${new Date(lastFireTs).toLocaleTimeString()}`   : "Last FIRE: --"}<br />
            {lastEjectTs ? `Last EJECT: ${new Date(lastEjectTs).toLocaleTimeString()}` : "Last EJECT: --"}
          </div>
        </div>

        {/* ── Joystick card ── */}
        <div className="mc-card">
          <div className="mc-card-title">Joystick</div>
          <JoystickRing
            onDown={({ yaw, pitch }) => {
              if (yaw   !== 0) startJog("yaw",   yaw);
              if (pitch !== 0) startJog("pitch", pitch);
            }}
            onUp={({ yaw, pitch }) => {
              if (yaw   !== 0) stopAxis("yaw");
              if (pitch !== 0) stopAxis("pitch");
            }}
            onStop={() => { cancelTriggerHold(); stopAll(); allOff().catch(() => {}); }}
          />
        </div>

      </div>

      {/* ── Command log ── */}
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