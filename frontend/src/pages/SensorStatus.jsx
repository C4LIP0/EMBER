import React, { useEffect, useMemo, useState } from "react";
import axios from "axios";
import { Card, Btn, Section, Badge } from "../components/UI";

const API = import.meta.env.VITE_API_URL || "http://localhost:8080";
const FRESH_MS = 30 * 1000;

function safeIso(tsMs) {
  if (!tsMs) return null;
  const d = new Date(tsMs);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function upsertById(list, obj) {
  const idx = list.findIndex((x) => x.id === obj.id);
  if (idx === -1) return [...list, obj];
  const next = list.slice();
  next[idx] = { ...next[idx], ...obj };
  return next;
}

export default function SensorStatus() {
  const [health, setHealth] = useState(null);

  // Working/real
  const [pressureLatest, setPressureLatest] = useState(null);
  const [solStatus, setSolStatus] = useState(null);
  const [imuLatest, setImuLatest] = useState({ missing: true, error: "Not implemented" });

  // Placeholders (until endpoints exist / mounted)
  const [windLatest, setWindLatest] = useState({ missing: true, error: "Not mounted yet" });
  const [ecompassStatus, setEcompassStatus] = useState({ missing: true, error: "Not implemented" });

  // Stepper motors (individual)
  const [stepperYaw, setStepperYaw] = useState({ missing: true, error: "Not implemented" });
  const [stepperPitch, setStepperPitch] = useState({ missing: true, error: "Not implemented" });

  const [onlyIssues, setOnlyIssues] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  async function load() {
    setLoading(true);
    setErr(null);

    const reqs = await Promise.allSettled([
      axios.get(`${API}/api/health`),
      axios.get(`${API}/api/pressure/latest`),
      axios.get(`${API}/api/solenoids/status`),

      // IMU (ManualControl expects these)
      axios.get(`${API}/api/imu/latest`),

      // FUTURE / placeholders
      axios.get(`${API}/api/wind/latest`),
      axios.get(`${API}/api/ecompass/latest`),

      // Steppers (individual endpoints you'd add later)
      axios.get(`${API}/api/steppers/yaw/status`),
      axios.get(`${API}/api/steppers/pitch/status`),
    ]);

    // 0) health
    if (reqs[0].status === "fulfilled") setHealth(reqs[0].value.data);

    // 1) pressure
    if (reqs[1].status === "fulfilled") {
      const d = reqs[1].value.data;
      setPressureLatest(d?.ok ? d : d);
    } else {
      const r = reqs[1].reason?.response;
      if (r?.status === 503) setPressureLatest({ ok: false, error: "No reading yet" });
      else setPressureLatest({ ok: false, error: String(reqs[1].reason?.message || reqs[1].reason) });
    }

    // 2) solenoids
    if (reqs[2].status === "fulfilled") setSolStatus(reqs[2].value.data || {});
    else setSolStatus({ ok: false, error: String(reqs[2].reason?.message || reqs[2].reason) });

    // 3) imu
    if (reqs[3].status === "fulfilled") {
      const d = reqs[3].value.data;
      setImuLatest(d?.ok ? d : d);
    } else {
      const code = reqs[3].reason?.response?.status;
      setImuLatest({
        missing: true,
        error: code === 404 ? "Endpoint missing" : String(reqs[3].reason?.message || reqs[3].reason),
      });
    }

    // 4) wind
    if (reqs[4].status === "fulfilled") setWindLatest(reqs[4].value.data || {});
    else {
      const code = reqs[4].reason?.response?.status;
      setWindLatest({
        missing: true,
        error: code === 404 ? "Not mounted / endpoint missing" : String(reqs[4].reason?.message || reqs[4].reason),
      });
    }

    // 5) ecompass
    if (reqs[5].status === "fulfilled") setEcompassStatus(reqs[5].value.data || {});
    else {
      const code = reqs[5].reason?.response?.status;
      setEcompassStatus({
        missing: true,
        error: code === 404 ? "Endpoint missing" : String(reqs[5].reason?.message || reqs[5].reason),
      });
    }

    // 6) stepper yaw
    if (reqs[6].status === "fulfilled") setStepperYaw(reqs[6].value.data || {});
    else {
      const code = reqs[6].reason?.response?.status;
      setStepperYaw({
        missing: true,
        error: code === 404 ? "Endpoint missing" : String(reqs[6].reason?.message || reqs[6].reason),
      });
    }

    // 7) stepper pitch
    if (reqs[7].status === "fulfilled") setStepperPitch(reqs[7].value.data || {});
    else {
      const code = reqs[7].reason?.response?.status;
      setStepperPitch({
        missing: true,
        error: code === 404 ? "Endpoint missing" : String(reqs[7].reason?.message || reqs[7].reason),
      });
    }

    // global error if backend totally unreachable
    if (reqs[0].status === "rejected" && reqs[1].status === "rejected") {
      setErr(String(reqs[0].reason?.message || reqs[0].reason));
    }

    setLoading(false);
  }

  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);

  const sensors = useMemo(() => {
    let list = [];

    // Pressure
    if (pressureLatest) {
      const ts = pressureLatest.ts || Date.now();
      list = upsertById(list, {
        id: "Pressure",
        type: "Pressure",
        updatedAt: safeIso(ts),
        ...pressureLatest,
      });
    } else {
      list = upsertById(list, {
        id: "Pressure",
        type: "Pressure",
        updatedAt: null,
        ok: false,
        missing: true,
        error: "No data yet",
      });
    }

    // Solenoids -> two rows: Launch + Eject
    if (solStatus) {
      const nowIso = new Date().toISOString();
      const ready = Boolean(solStatus?.ready || solStatus?.available || solStatus?.ok);

      list = upsertById(list, {
        id: "SolenoidLaunch",
        type: "Actuator",
        updatedAt: nowIso,
        ready,
        pin: solStatus?.pins?.shoot ?? null,
        state: solStatus?.state?.shoot ?? solStatus?.states?.shoot ?? null,
        lastError: solStatus?.lastError ?? null,
      });

      list = upsertById(list, {
        id: "SolenoidEject",
        type: "Actuator",
        updatedAt: nowIso,
        ready,
        pin: solStatus?.pins?.release ?? null,
        state: solStatus?.state?.release ?? solStatus?.states?.release ?? null,
        lastError: solStatus?.lastError ?? null,
      });
    } else {
      const nowIso = new Date().toISOString();
      list = upsertById(list, {
        id: "SolenoidLaunch",
        type: "Actuator",
        updatedAt: nowIso,
        ok: false,
        missing: true,
        error: "Solenoids status missing",
      });
      list = upsertById(list, {
        id: "SolenoidEject",
        type: "Actuator",
        updatedAt: nowIso,
        ok: false,
        missing: true,
        error: "Solenoids status missing",
      });
    }

    // Stepper motors (individual placeholders until you implement)
    list = upsertById(list, {
      id: "StepperYaw",
      type: "Actuator",
      updatedAt: stepperYaw?.ts ? safeIso(stepperYaw.ts) : null,
      ...stepperYaw,
    });
    list = upsertById(list, {
      id: "StepperPitch",
      type: "Actuator",
      updatedAt: stepperPitch?.ts ? safeIso(stepperPitch.ts) : null,
      ...stepperPitch,
    });

    // IMU
    list = upsertById(list, {
      id: "IMU",
      type: "IMU",
      updatedAt: imuLatest?.ts ? safeIso(imuLatest.ts) : null,
      ...imuLatest,
    });

    // Wind
    list = upsertById(list, {
      id: "WindSensor",
      type: "Wind",
      updatedAt: windLatest?.ts ? safeIso(windLatest.ts) : null,
      ...windLatest,
    });

    // E-Compass
    list = upsertById(list, {
      id: "ECompass",
      type: "Compass",
      updatedAt: ecompassStatus?.ts ? safeIso(ecompassStatus.ts) : null,
      ...ecompassStatus,
    });

    return list;
  }, [pressureLatest, solStatus, stepperYaw, stepperPitch, imuLatest, windLatest, ecompassStatus]);

  const rows = useMemo(() => {
    const now = Date.now();

    return sensors.map((s) => {
      const t = s.updatedAt ? new Date(s.updatedAt).getTime() : NaN;
      const fresh = Number.isFinite(t) && now - t <= FRESH_MS;

      const requiredFieldsOk =
        {
          Pressure: ["psi", "v_adc"].every((k) => k in s),

          SolenoidLaunch: true,
          SolenoidEject: true,

          StepperYaw: false,   // until endpoint returns fields you expect
          StepperPitch: false, // until endpoint returns fields you expect

          IMU: ["heading", "roll", "pitch"].some((k) => k in s) || "aligned" in s,

          WindSensor: false, // placeholder
          ECompass: false,   // placeholder
        }[s.id] ?? true;

      let ok = fresh && requiredFieldsOk;

      if (s.id === "Pressure") {
        ok = s?.ok === false ? false : fresh && typeof s.psi === "number";
      }

      if (s.id === "SolenoidLaunch" || s.id === "SolenoidEject") {
        const ready = Boolean(s?.ready || s?.available || s?.ok);
        ok = ready && !s?.missing;
      }

      if (s.id === "IMU") {
        ok = !s?.missing && fresh && requiredFieldsOk;
      }

      if (s.id === "StepperYaw" || s.id === "StepperPitch") {
        ok = false; // placeholders until you implement endpoints
      }

      if (s.id === "WindSensor" || s.id === "ECompass") {
        ok = false;
      }

      let reason = "";
      if (ok) reason = "OK";
      else if (s?.missing) reason = `MISSING: ${s.error || "not available"}`;
      else if (!requiredFieldsOk) reason = "Missing required fields";
      else if (
        !fresh &&
        s.id !== "SolenoidLaunch" &&
        s.id !== "SolenoidEject"
      )
        reason = "Stale (not updating)";
      else if (s?.ok === false && s?.error) reason = s.error;
      else reason = "Issue";

      let summary = "";
      if (s.id === "Pressure") {
        summary = `psi=${typeof s.psi === "number" ? s.psi.toFixed(2) : "--"} v_adc=${
          typeof s.v_adc === "number" ? s.v_adc.toFixed(3) : "--"
        }`;
      } else if (s.id === "SolenoidLaunch") {
        summary = `Launch pin=${s?.pin ?? "--"} ready=${String(Boolean(s?.ready))}`;
      } else if (s.id === "SolenoidEject") {
        summary = `Eject pin=${s?.pin ?? "--"} ready=${String(Boolean(s?.ready))}`;
      } else if (s.id === "StepperYaw") {
        summary = s?.missing ? `Missing: ${s.error || "Not implemented"}` : "—";
      } else if (s.id === "StepperPitch") {
        summary = s?.missing ? `Missing: ${s.error || "Not implemented"}` : "—";
      } else if (s.id === "IMU") {
        summary = `aligned=${s?.aligned == null ? "--" : String(s.aligned)} roll=${
          typeof s.roll === "number" ? s.roll.toFixed(1) : "--"
        } pitch=${typeof s.pitch === "number" ? s.pitch.toFixed(1) : "--"}`;
      } else if (s.id === "WindSensor") {
        summary = s?.missing ? `Missing: ${s.error || "Not mounted yet"}` : "—";
      } else if (s.id === "ECompass") {
        summary = s?.missing ? `Missing: ${s.error || "Not implemented"}` : "—";
      }

      return { ...s, ok, fresh, requiredFieldsOk, reason, summary };
    });
  }, [sensors]);

  const filtered = onlyIssues ? rows.filter((r) => !r.ok) : rows;
  const okCount = rows.filter((r) => r.ok).length;

  return (
    <div className="container vstack">
      <Section
        title="Sensor Status"
        sub="WORKING = correct endpoint + valid data (fresh if applicable)."
      />

      <div className="hstack" style={{ justifyContent: "space-between" }}>
        <div className="hstack" style={{ gap: 8 }}>
          <Btn onClick={load}>{loading ? "Refreshing..." : "Refresh"}</Btn>
          <Btn ghost onClick={() => setOnlyIssues((x) => !x)}>
            {onlyIssues ? "Show All" : "Show Only Issues"}
          </Btn>
        </div>

        <div className="hstack" style={{ gap: 8 }}>
          <Badge state={okCount === rows.length ? "ok" : rows.length ? "warn" : "issue"}>
            {okCount}/{rows.length} OK
          </Badge>
          <small className="muted">
            API time: {health?.time ? new Date(health.time).toLocaleString() : "—"}
          </small>
        </div>
      </div>

      {err && <p style={{ color: "var(--danger)" }}>Error: {err}</p>}

      <Card>
        <table className="table mono">
          <thead>
            <tr>
              <th>ID</th>
              <th>Status</th>
              <th>Reason</th>
              <th>Fresh?</th>
              <th>Fields?</th>
              <th>Updated</th>
              <th>Summary</th>
              <th>Payload</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((s, i) => (
              <tr key={i}>
                <td>{s.id}</td>
                <td>
                  {s.ok ? <Badge state="ok">WORKING</Badge> : <Badge state="issue">ISSUE</Badge>}
                </td>
                <td>{s.reason}</td>
                <td>
                  {(s.id === "SolenoidLaunch" || s.id === "SolenoidEject")
                    ? "—"
                    : s.fresh
                      ? "Yes"
                      : "No"}
                </td>
                <td>{s.requiredFieldsOk ? "Yes" : "No"}</td>
                <td>{s.updatedAt ? new Date(s.updatedAt).toLocaleString() : "—"}</td>
                <td>{s.summary || "—"}</td>
                <td style={{ maxWidth: 520, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                  {JSON.stringify(s)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {!filtered.length && <p className="mono">No sensors returned by API (or all filtered).</p>}
      </Card>
    </div>
  );
}