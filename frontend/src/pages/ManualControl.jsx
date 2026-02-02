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

    // ✅ SAFE STUB ONLY (simulation/log)
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
  const [speed01, setSpeed01] = useState(0.35);
  const [ttlMs, setTtlMs] = useState(500);
  const [enabled, setEnabled] = useState({ yaw: false, pitch: false });
  const [log, setLog] = useState([]);

  // ✅ SAFE SIM trigger UI
  const [armed, setArmed] = useState(false);
  const [holdingTrigger, setHoldingTrigger] = useState(false);
  const triggerHoldTimer = useRef(null);
  const TRIGGER_HOLD_MS = 1200;

  const transport = useMemo(
    () =>
      createMockTransport((evt) => {
        setLog((l) => [evt, ...l].slice(0, 20));
      }),
    []
  );

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
    if (triggerHoldTimer.current) return;

    setHoldingTrigger(true);
    triggerHoldTimer.current = setTimeout(() => {
      transport.triggerSim(); // ✅ simulation/log only
      setHoldingTrigger(false);
      triggerHoldTimer.current = null;
    }, TRIGGER_HOLD_MS);
  };

  // Safety: stop if tab loses focus / user changes tab
  useEffect(() => {
    const onBlur = () => {
      cancelTriggerHold();
      stopAll();
    };
    const onVis = () => {
      if (document.visibilityState !== "visible") {
        cancelTriggerHold();
        stopAll();
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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speed01, ttlMs, armed]);

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

  return (
    <div className="mc-wrap">
      <div className="mc-header">
        <h2>Manual Control</h2>
        <button
          className="mc-stop"
          onClick={() => {
            cancelTriggerHold();
            stopAll();
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
              <div className="mc-muted">
                Enabled: {enabled.pitch ? "YES" : "NO"}
              </div>
            </div>
            <div className="mc-actions">
              <button onClick={() => enableAxis("pitch")}>Enable</button>
              <button onClick={() => disableAxis("pitch")}>Disable</button>
            </div>
          </div>

          <div className="mc-hint">
            Mock now. Later: send to Node backend → ticcmd.
          </div>
        </div>

        {/* ✅ SAFE SIM trigger UI */}
        <div className="mc-card">
          <div className="mc-card-title">Actions</div>

          <div className="mc-motor-row">
            <div>
              <div className="mc-motor-name">Arm</div>
              <div className="mc-muted">Required before Trigger (SIM)</div>
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
              <span style={{ fontWeight: 800 }}>
                {armed ? "ARMED" : "SAFE"}
              </span>
            </label>
          </div>

          <button
            style={triggerBtn(!armed)}
            disabled={!armed}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              startTriggerHold();
            }}
            onPointerUp={cancelTriggerHold}
            onPointerCancel={cancelTriggerHold}
            onPointerLeave={cancelTriggerHold}
          >
            {holdingTrigger ? `HOLDING... (${TRIGGER_HOLD_MS}ms)` : "HOLD TO TRIGGER (SIM)"}
          </button>

          <div className="mc-hint">
            This is simulation only (logs a “triggerSim” event). No hardware action.
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
                <span className="mc-muted">
                  {new Date(x.ts).toLocaleTimeString()}
                </span>
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
