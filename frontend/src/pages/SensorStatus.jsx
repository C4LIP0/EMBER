import React, { useEffect, useMemo, useState } from 'react'
import axios from 'axios'
import { Card, Btn, Section, Badge } from '../components/UI'

const API = import.meta.env.VITE_API_URL || 'http://localhost:8080'
const FRESH_MS = 30 * 1000

export default function SensorStatus() {
  const [health, setHealth] = useState(null)
  const [sensors, setSensors] = useState([])
  const [onlyIssues, setOnlyIssues] = useState(false)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState(null)

  async function load() {
    setLoading(true); setErr(null)
    try {
      const [h, s] = await Promise.all([
        axios.get(`${API}/api/health`),
        axios.get(`${API}/api/sensors`)
      ])
      setHealth(h.data)
      setSensors(s.data.sensors || [])
    } catch (e) {
      setErr(e.message)
    } finally { setLoading(false) }
  }
  useEffect(()=>{ load(); const id=setInterval(load, 5000); return ()=>clearInterval(id) },[])

  const rows = useMemo(() => {
    const now = Date.now()
    return sensors.map(s => {
      const t = new Date(s.updatedAt).getTime()
      const fresh = Number.isFinite(t) && (now - t) <= FRESH_MS
      const requiredFieldsOk = {
        BME280: ['temperatureC','humidity','pressureHpa'].every(k => k in s),
        Anemometer: ['windSpeedMs','windDirDeg'].every(k => k in s),
        GPS: ['lat','lon','altM'].every(k => k in s)
      }[s.id] ?? true
      const ok = fresh && requiredFieldsOk
      return { ...s, ok, fresh, requiredFieldsOk }
    })
  }, [sensors])

  const filtered = onlyIssues ? rows.filter(r => !r.ok) : rows
  const okCount = rows.filter(r=>r.ok).length

  return (
    <div className="container vstack">
      <Section title="Sensor Status" sub="Working = fresh data + required fields present." />
      <div className="hstack" style={{justifyContent:'space-between'}}>
        <div className="hstack" style={{gap:8}}>
          <Btn onClick={load}>{loading ? 'Refreshing…' : 'Refresh'}</Btn>
          <Btn ghost onClick={()=>setOnlyIssues(x=>!x)}>{onlyIssues?'Show All':'Show Only Issues'}</Btn>
        </div>
        <div className="hstack" style={{gap:8}}>
          <Badge state={okCount===rows.length?'ok':rows.length? 'warn':'issue'}>
            {okCount}/{rows.length} OK
          </Badge>
          <small className="muted">API time: {health?.time ? new Date(health.time).toLocaleString() : '—'}</small>
        </div>
      </div>

      {err && <p style={{color:'var(--danger)'}}>Error: {err}</p>}

      <Card>
        <table className="table mono">
          <thead>
            <tr><th>ID</th><th>Status</th><th>Fresh?</th><th>Fields?</th><th>Updated</th><th>Payload</th></tr>
          </thead>
          <tbody>
            {filtered.map((s,i)=>(
              <tr key={i}>
                <td>{s.id}</td>
                <td>{s.ok ? <Badge state="ok">WORKING</Badge> : <Badge state="issue">ISSUE</Badge>}</td>
                <td>{s.fresh ? 'Yes' : 'No'}</td>
                <td>{s.requiredFieldsOk ? 'Yes' : 'No'}</td>
                <td>{new Date(s.updatedAt).toLocaleString()}</td>
                <td>{JSON.stringify(s)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!filtered.length && <p className="mono">No sensors returned by API (or all filtered).</p>}
      </Card>
    </div>
  )
}
