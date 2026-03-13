import React, { useEffect, useState } from 'react'
import axios from 'axios'
import { Card, Btn, Field, Section } from '../components/UI'

const API = import.meta.env.VITE_API_URL || 'http://localhost:8080'

export default function Dashboard() {
  const [health, setHealth]   = useState(null)
  const [sensors, setSensors] = useState([])
  const [loading, setLoading] = useState(false)

  const [v0, setV0]       = useState(120)
  const [dx, setDx]       = useState(300)
  const [dy, setDy]       = useState(0)
  const [windX, setWindX] = useState(0)
  const [windY, setWindY] = useState(0)

  const [result, setResult] = useState(null)
  const [error, setError]   = useState(null)

  // Realtime anemometer via SSE (falls back to polling)
  const [windLive, setWindLive] = useState({ ms: null, kmh: null, v: null, ts: null })
  const [windConn, setWindConn] = useState('DISCONNECTED')

  // 5-second sensor poll
  async function load() {
    setLoading(true)
    try {
      const [h, s] = await Promise.all([
        axios.get(`${API}/api/health`),
        axios.get(`${API}/api/sensors`)
      ])
      setHealth(h.data)
      setSensors(s.data.sensors || [])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    const id = setInterval(load, 5000)
    return () => clearInterval(id)
  }, [])

  // Realtime anemometer SSE
  useEffect(() => {
    let es      = null
    let pollId  = null
    let stopped = false

    const set = (d) => setWindLive({
      ms:  typeof d?.ms  === 'number' ? d.ms  : null,
      kmh: typeof d?.kmh === 'number' ? d.kmh : null,
      v:   typeof d?.v   === 'number' ? d.v   : null,
      ts:  d?.ts || Date.now(),
    })

    const poll = () => {
      setWindConn('POLLING')
      pollId = setInterval(async () => {
        try {
          const r = await fetch(`${API}/api/anemometer/latest`)
          if (!r.ok) return
          set(await r.json())
        } catch {}
      }, 300)
    }

    try {
      es = new EventSource(`${API}/api/anemometer/stream`)
      es.onopen    = () => { if (!stopped) setWindConn('CONNECTED') }
      es.onmessage = (e) => { if (!stopped) try { set(JSON.parse(e.data)) } catch {} }
      es.onerror   = () => { if (!stopped) { es?.close(); if (!pollId) poll() } }
    } catch { poll() }

    return () => {
      stopped = true
      es?.close()
      if (pollId) clearInterval(pollId)
    }
  }, [])

  async function compute() {
    setError(null); setResult(null)
    try {
      const r = await axios.post(`${API}/api/ballistics`, {
        v0: Number(v0), dx: Number(dx), dy: Number(dy),
        windX: Number(windX), windY: Number(windY)
      })
      setResult(r.data)
    } catch (e) {
      setError(e.response?.data?.error || e.message)
    }
  }

  const gps = sensors.find(s => s.id === 'GPS')
  const env = sensors.find(s => s.id === 'BME280')

  return (
    <div className="container vstack">
      <Section title="Dashboard" sub={`API: ${API}`} />

      <div className="grid grid-3">

        {/* System */}
        <Card title="System">
          <div className="kpi">{health ? 'Online' : '--'}</div>
          <div className="kpi-sub">
            {health?.time ? new Date(health.time).toLocaleString() : 'Waiting...'}
          </div>
          <hr className="sep"/>
          <Btn onClick={load}>{loading ? 'Refreshing...' : 'Refresh'}</Btn>
        </Card>

        {/* Environment */}
        <Card title="Environment">
          <div className="grid grid-3">
            <div style={{minWidth:0}}>
              <div className="kpi">{env?.temperatureC ?? '--'}</div>
              <div className="kpi-sub">temp C</div>
            </div>
            <div style={{minWidth:0}}>
              <div className="kpi">{env?.humidity ?? '--'}</div>
              <div className="kpi-sub">humidity %</div>
            </div>
            <div style={{minWidth:0}}>
              <div className="kpi">{env?.pressureHpa ?? '--'}</div>
              <div className="kpi-sub">hPa</div>
            </div>
          </div>
        </Card>

        {/* Position / Wind — now uses realtime windLive */}
        <Card title="Position / Wind">
          <div className="grid grid-2">
            <div style={{minWidth:0}}>
              <div className="kpi">{gps?.lat?.toFixed?.(4) ?? '--'}</div>
              <div className="kpi-sub">lat</div>
            </div>
            <div style={{minWidth:0}}>
              <div className="kpi">{gps?.lon?.toFixed?.(4) ?? '--'}</div>
              <div className="kpi-sub">lon</div>
            </div>
          </div>

          <div className="grid grid-2" style={{marginTop: 12}}>
            <div>
              <div className="kpi">
                {windLive.ms != null ? windLive.ms.toFixed(1) : '--'}
              </div>
              <div className="kpi-sub">wind m/s</div>
            </div>
            <div>
              <div className="kpi">
                {windLive.kmh != null ? windLive.kmh.toFixed(1) : '--'}
              </div>
              <div className="kpi-sub">wind km/h</div>
            </div>
          </div>

          <div className="kpi-sub" style={{marginTop: 8, fontSize: 11}}>
            {windConn} | {windLive.ts ? new Date(windLive.ts).toLocaleTimeString() : '--'}
          </div>
        </Card>

      </div>

      {/* Ballistics */}
      <Card title="Ballistic Calculator (idealized)"
            right={<small className="muted">vacuum | flat-earth | g=9.80665</small>}>
        <div className="grid grid-4">
          <Field label="Muzzle v0 (m/s)"      type="number" step="0.1" value={v0}    onChange={e => setV0(e.target.value)}/>
          <Field label="Horizontal dx (m)"     type="number" step="0.1" value={dx}    onChange={e => setDx(e.target.value)}/>
          <Field label="Height delta dy (m)"   type="number" step="0.1" value={dy}    onChange={e => setDy(e.target.value)}/>
          <Field label="Tail/Head windX (m/s)" type="number" step="0.1" value={windX} onChange={e => setWindX(e.target.value)}/>
          <Field label="Cross windY (m/s)"     type="number" step="0.1" value={windY} onChange={e => setWindY(e.target.value)}/>
          <div style={{display:'flex', alignItems:'flex-end', gap:8}}>
            <Btn onClick={compute}>Compute</Btn>
            <Btn ghost onClick={() => {
              setV0(120); setDx(300); setDy(0)
              setWindX(0); setWindY(0)
              setResult(null); setError(null)
            }}>Reset</Btn>
          </div>
        </div>

        {error && <p style={{color:'var(--danger)'}}>{error}</p>}

        {result && (
          <div className="grid grid-3" style={{marginTop:12}}>
            <div>
              <div className="kpi">{result.thetaDeg.toFixed(2)} deg</div>
              <div className="kpi-sub">angle (low arc)</div>
            </div>
            <div>
              <div className="kpi">{result.timeOfFlightSec.toFixed(2)}s</div>
              <div className="kpi-sub">time of flight</div>
            </div>
            <div>
              <div className="kpi">{Number(dx).toFixed(1)} m</div>
              <div className="kpi-sub">range (input)</div>
            </div>
          </div>
        )}

        <details style={{marginTop:10}}>
          <summary>Raw JSON</summary>
          <pre className="mono">{JSON.stringify(result, null, 2)}</pre>
        </details>
      </Card>

      {/* Raw sensors table */}
      <Card title="Sensors (raw)">
        <table className="table mono">
          <thead>
            <tr><th>ID</th><th>Type</th><th>Updated</th><th>Payload</th></tr>
          </thead>
          <tbody>
            {sensors.map((s, i) => (
              <tr key={i}>
                <td>{s.id}</td>
                <td>{s.type}</td>
                <td>{s.updatedAt ? new Date(s.updatedAt).toLocaleString() : '--'}</td>
                <td>{JSON.stringify(s)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

    </div>
  )
}
