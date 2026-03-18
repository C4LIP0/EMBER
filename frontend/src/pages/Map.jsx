import React, { useEffect, useMemo, useRef, useState } from 'react'
import axios from 'axios'
import { MapContainer, TileLayer, Marker, Polyline, Polygon, useMapEvents, useMap } from 'react-leaflet'
import L from 'leaflet'

const API = import.meta.env.VITE_API_BASE_URL || import.meta.env.VITE_API_URL || 'http://localhost:8080'
const G   = 9.80665
const BARREL_D = 0.075
const BARREL_A = Math.PI * (BARREL_D / 2) ** 2

// ── Math helpers ──────────────────────────────────────────────────────────
const rad = d => d * Math.PI / 180
const deg = r => r * 180 / Math.PI

function haversineMeters(a, b) {
  const R = 6371000, toR = x => x * Math.PI / 180
  const dLat = toR(b[0]-a[0]), dLon = toR(b[1]-a[1])
  const lat1 = toR(a[0]), lat2 = toR(b[0])
  const h = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2
  return 2 * R * Math.asin(Math.sqrt(h))
}

function bearingDeg(a, b) {
  const toR = x => x * Math.PI / 180, toD = x => x * 180 / Math.PI
  const lat1=toR(a[0]), lat2=toR(b[0]), dLon=toR(b[1]-a[1])
  const y = Math.sin(dLon)*Math.cos(lat2)
  const x = Math.cos(lat1)*Math.sin(lat2) - Math.sin(lat1)*Math.cos(lat2)*Math.cos(dLon)
  return (toD(Math.atan2(y, x)) + 360) % 360
}

function destinationLatLon(lat, lon, bearingDeg, distanceMeters) {
  const R=6371000, δ=distanceMeters/R, θ=bearingDeg*Math.PI/180
  const φ1=lat*Math.PI/180, λ1=lon*Math.PI/180
  const φ2=Math.asin(Math.sin(φ1)*Math.cos(δ)+Math.cos(φ1)*Math.sin(δ)*Math.cos(θ))
  const λ2=λ1+Math.atan2(Math.sin(θ)*Math.sin(δ)*Math.cos(φ1),Math.cos(δ)-Math.sin(φ1)*Math.sin(φ2))
  return { lat:φ2*180/Math.PI, lon:((λ2*180/Math.PI+540)%360)-180 }
}

function sectorPolygon(center, headingDeg, halfAngleDeg, rangeMeters, steps=24) {
  if (!center) return null
  const { lat, lon } = center
  const coords = [[lat,lon]]
  const start=headingDeg-halfAngleDeg, end=headingDeg+halfAngleDeg
  for (let i=0; i<=steps; i++) {
    const p = destinationLatLon(lat, lon, start+i*(end-start)/steps, rangeMeters)
    coords.push([p.lat, p.lon])
  }
  coords.push([lat,lon])
  return coords
}

function parseNum(s) {
  const n = Number(String(s).trim())
  return Number.isFinite(n) ? n : null
}

function muzzleVelocity(psi, massKg, eff=0.35) {
  const pa=psi*6894.76, work=pa*BARREL_A*1.0*eff
  return Math.min(Math.sqrt((2*work)/massKg), 80)
}

function calcPitch(dx, dy, v0, windMs=0) {
  const vEff=Math.max(1, v0-windMs*0.3), v0sq=vEff*vEff
  const under=v0sq**2 - G*(G*dx**2+2*dy*v0sq)
  if (under<0) return null
  const pitch=deg(Math.atan((v0sq-Math.sqrt(under))/(G*dx)))
  if (pitch<0||pitch>45) return null
  const θ=rad(pitch), vy=vEff*Math.sin(θ)
  const a=-0.5*G, b=vy, c=-dy, disc=b*b-4*a*c
  return { pitch, tof: disc>=0 ? (-b+Math.sqrt(disc))/(2*a) : dx/vEff }
}

// ── Compass rose widget ───────────────────────────────────────────────────
function CompassWidget({ currentHeading, targetBearing }) {
  const S=140, C=S/2, R=C-10
  const pt = (d, r) => ({
    x: C + r*Math.cos(rad(d-90)),
    y: C + r*Math.sin(rad(d-90)),
  })
  const diff = targetBearing!=null && currentHeading!=null
    ? Math.abs(((targetBearing-currentHeading)+180)%360-180)
    : null
  const aligned = diff!=null && diff<=3

  return (
    <div style={{ textAlign:'center' }}>
      <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`}>
        <circle cx={C} cy={C} r={R} fill="none" stroke="var(--color-border-secondary)" strokeWidth="1.5"/>
        {/* Tick marks */}
        {Array.from({length:36},(_,i)=>{
          const a=i*10, inner=pt(a, R-(i%9===0?14:i%3===0?10:7)), outer=pt(a,R)
          return <line key={i} x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y}
            stroke="var(--color-border-secondary)" strokeWidth={i%9===0?2:1}/>
        })}
        {/* Cardinal labels */}
        {[['N',0],['E',90],['S',180],['W',270]].map(([l,d])=>{
          const p=pt(d, R-20)
          return <text key={l} x={p.x} y={p.y} textAnchor="middle" dominantBaseline="central"
            fontSize="11" fontWeight="600" fill={l==='N'?'#e53935':'var(--color-text-secondary)'}>{l}</text>
        })}
        {/* Target bearing — orange dashed */}
        {targetBearing!=null && (()=>{
          const tip=pt(targetBearing, R-18)
          return <>
            <line x1={C} y1={C} x2={tip.x} y2={tip.y}
              stroke="#ff9800" strokeWidth="2" strokeDasharray="4 3"/>
            <circle cx={tip.x} cy={tip.y} r={5} fill="#ff9800"/>
          </>
        })()}
        {/* Current IMU heading — green */}
        {currentHeading!=null && (()=>{
          const tip=pt(currentHeading, R-18)
          const tail=pt(currentHeading+180, 16)
          return <line x1={tail.x} y1={tail.y} x2={tip.x} y2={tip.y}
            stroke="#4caf50" strokeWidth="3" strokeLinecap="round"/>
        })()}
        <circle cx={C} cy={C} r={4} fill="var(--color-text-secondary)"/>
      </svg>
      <div style={{ fontSize:12, marginTop:4 }}>
        <span style={{ color:'#4caf50' }}>● IMU</span>
        {'  '}
        <span style={{ color:'#ff9800' }}>● Target</span>
      </div>
      {diff!=null && (
        <div style={{ marginTop:4, fontWeight:600, fontSize:13,
          color: aligned ? '#4caf50' : diff<10 ? '#ff9800' : '#e53935' }}>
          {aligned ? '✓ ALIGNED' : `${diff.toFixed(1)}° off`}
        </div>
      )}
    </div>
  )
}

// ── Leaflet icons ─────────────────────────────────────────────────────────
const mortarIcon = new L.DivIcon({
  className:'', html:'<div style="background:#4CAF50;width:24px;height:24px;border-radius:50%;border:3px solid white;box-shadow:0 2px 6px rgba(0,0,0,.4)"></div>',
  iconSize:[24,24], iconAnchor:[12,12]
})
const targetIcon = new L.DivIcon({
  className:'', html:'<div style="background:#F44336;width:24px;height:24px;border-radius:50%;border:3px solid white;box-shadow:0 2px 6px rgba(0,0,0,.4)"></div>',
  iconSize:[24,24], iconAnchor:[12,12]
})

// ── Map click handler ─────────────────────────────────────────────────────
function MapClickHandler({ clickMode, onCannonSet, onTargetSet }) {
  useMapEvents({
    click(e) {
      const { lat, lng } = e.latlng
      if (clickMode === 'cannon') onCannonSet({ lat, lon: lng })
      else if (clickMode === 'target') onTargetSet({ lat, lon: lng })
    }
  })
  return null
}

function Recenter({ center }) {
  const map = useMap()
  useEffect(() => { if (center) map.setView(center, map.getZoom()) }, [center, map])
  return null
}

// ── Main ──────────────────────────────────────────────────────────────────
export default function MapPage() {
  const [mortar,      setMortar]      = useState(null)
  const [target,      setTarget]      = useState(null)
  const [clickMode,   setClickMode]   = useState('target') // 'cannon' | 'target' | 'none'
  const [dms,         setDms]         = useState(false)
  const [autoCenter,  setAutoCenter]  = useState(true)

  // Manual inputs
  const [mLat, setMLat] = useState('')
  const [mLon, setMLon] = useState('')
  const [tLat, setTLat] = useState('')
  const [tLon, setTLon] = useState('')
  const [manualErr, setManualErr] = useState('')

  // Ballistics
  const [massKg,    setMassKg]    = useState(1.0)
  const [imuOffset,      setImuOffset]      = useState(178.5)
  const [headingOffset,  setHeadingOffset]  = useState(0.0)    // degrees — IMU vs true North
  const [phoneHeading,   setPhoneHeading]   = useState('')    // what phone compass reads
  const [phonePitch,     setPhonePitch]     = useState('')    // what phone level reads
  const [calMsg,         setCalMsg]         = useState('')    // calibration feedback
  const [efficiency,     setEfficiency]     = useState(0.35)   // 0.1-1.0 ballistic efficiency
  const [maxPsi,         setMaxPsi]         = useState(150)     // max safe PSI
  const [balResult, setBalResult] = useState(null)
  const [balError,  setBalError]  = useState('')

  // Live sensors
  const [pressure,  setPressure]  = useState(null)
  const [windLive,  setWindLive]  = useState({ ms:null })
  const [imuState,  setImuState]  = useState(null)

  // Auto-aim
  const [aimStatus, setAimStatus] = useState('IDLE')
  const [aimBusy,   setAimBusy]   = useState(false)

  // Auto-fire
  const [fireStatus, setFireStatus] = useState('IDLE')
  const [firePsi,    setFirePsi]    = useState(null)
  const [fireArmed,  setFireArmed]  = useState(false)

  // Manual fire hold
  const [holdProgress, setHoldProgress] = useState(0)
  const holdTimer = useRef(null)
  const holdStart = useRef(null)

  // ── Poll sensors ──────────────────────────────────────────────────────
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const [pr,wr,ir] = await Promise.all([
          fetch(`${API}/api/pressure/latest`).then(r=>r.ok?r.json():null),
          fetch(`${API}/api/anemometer/latest`).then(r=>r.ok?r.json():null),
          fetch(`${API}/api/imu/latest`).then(r=>r.ok?r.json():null),
        ])
        if (pr) setPressure(pr)
        if (wr) setWindLive(wr)
        if (ir) setImuState(ir)
      } catch {}
    }, 500)
    return () => clearInterval(id)
  }, [])

  // ── AutoAim SSE ───────────────────────────────────────────────────────
  useEffect(() => {
    let es=null, stopped=false
    const connect = () => {
      es = new EventSource(`${API}/api/autoaim/stream`)
      es.onmessage = e => { if (!stopped) try { const d=JSON.parse(e.data); if(d.status) setAimStatus(d.status) } catch {} }
      es.onerror   = () => { if (!stopped) { es?.close(); setTimeout(connect,2000) } }
    }
    connect()
    return () => { stopped=true; es?.close() }
  }, [])

  // ── AutoFire SSE ──────────────────────────────────────────────────────
  useEffect(() => {
    let es=null, stopped=false
    const connect = () => {
      es = new EventSource(`${API}/api/autofire/stream`)
      es.onmessage = e => { if (!stopped) try {
        const d=JSON.parse(e.data)
        if (d.status) setFireStatus(d.status)
        if (d.currentPsi!=null) setFirePsi(d.currentPsi)
      } catch {} }
      es.onerror = () => { if (!stopped) { es?.close(); setTimeout(connect,2000) } }
    }
    connect()
    return () => { stopped=true; es?.close() }
  }, [])

  // ── Derived ───────────────────────────────────────────────────────────
  const heading = useMemo(() => {
    if (mortar && target) return bearingDeg([mortar.lat,mortar.lon],[target.lat,target.lon])
    return null
  }, [mortar, target])

  const dist = useMemo(() => {
    if (mortar && target) return haversineMeters([mortar.lat,mortar.lon],[target.lat,target.lon])
    return null
  }, [mortar, target])

  const sector = useMemo(() => {
    if (!mortar || heading==null) return null
    return sectorPolygon(mortar, heading, 12.5, 500)
  }, [mortar, heading])

  const path        = useMemo(() => (mortar&&target) ? [[mortar.lat,mortar.lon],[target.lat,target.lon]] : null, [mortar,target])
  const mapCenter   = mortar ? [mortar.lat,mortar.lon] : [45.12,-74.10]
  const currentElev = imuState?.pitch!=null ? (imuState.pitch-imuOffset).toFixed(1) : '--'
  // Apply heading offset so IMU 0° = true North
  const currentHdg  = imuState?.heading!=null ? (imuState.heading + headingOffset + 360) % 360 : null

  const aimDiff = heading!=null && currentHdg!=null
    ? Math.abs(((heading-currentHdg)+180)%360-180)
    : null
  const aimAligned = aimDiff!=null && aimDiff<=3

  const statusColor = { IDLE:'#888', SEEKING:'#ff9800', ON_TARGET:'#4caf50', ERROR:'#e53935' }[aimStatus]||'#888'

  // ── Actions ───────────────────────────────────────────────────────────
  function setMortarFromClick(pos) {
    setMortar(pos)
    setMLat(pos.lat.toFixed(6))
    setMLon(pos.lon.toFixed(6))
    setClickMode('target') // auto-switch to target mode after setting cannon
  }

  function setTargetFromClick(pos) {
    setTarget(pos)
    setTLat(pos.lat.toFixed(6))
    setTLon(pos.lon.toFixed(6))
  }

  function applyManualMortar() {
    const lat=parseNum(mLat), lon=parseNum(mLon)
    if (lat==null||lon==null) return setManualErr('Invalid cannon coordinates.')
    setMortar({lat,lon}); setManualErr('')
  }

  function applyManualTarget() {
    const lat=parseNum(tLat), lon=parseNum(tLon)
    if (lat==null||lon==null) return setManualErr('Invalid target coordinates.')
    setTarget({lat,lon}); setManualErr('')
  }

  function calibrateHeading() {
    const phone = parseFloat(phoneHeading)
    if (isNaN(phone)) return setCalMsg('Enter a valid phone compass reading first.')
    if (imuState?.heading == null) return setCalMsg('No IMU reading — check IMU is connected.')
    const offset = ((phone - imuState.heading) + 360) % 360
    // Normalize to -180..180
    const normalized = offset > 180 ? offset - 360 : offset
    setHeadingOffset(parseFloat(normalized.toFixed(1)))
    setCalMsg(`✓ Heading offset set to ${normalized.toFixed(1)}° (phone: ${phone}°, IMU raw: ${imuState.heading.toFixed(1)}°)`)
  }

  function calibratePitch() {
    const phone = parseFloat(phonePitch)
    if (isNaN(phone)) return setCalMsg('Enter a valid phone level reading first.')
    if (imuState?.pitch == null) return setCalMsg('No IMU reading — check IMU is connected.')
    const offset = imuState.pitch - phone
    setImuOffset(parseFloat(offset.toFixed(1)))
    setCalMsg(`✓ Pitch offset set to ${offset.toFixed(1)}° (phone: ${phone}°, IMU raw: ${imuState.pitch.toFixed(1)}°)`)
  }

  function calculate() {
    setBalError(''); setBalResult(null)
    if (!mortar||!target) return setBalError('Set both cannon and target positions first.')
    const psi=pressure?.psi??0, wind=windLive?.ms??0
    if (psi<=0) return setBalError('No pressure reading — check sensor.')
    const d=haversineMeters([mortar.lat,mortar.lon],[target.lat,target.lon])
    const bear=bearingDeg([mortar.lat,mortar.lon],[target.lat,target.lon])
    const v0=muzzleVelocity(psi, massKg, efficiency)
    const bal=calcPitch(d, 0, v0, wind)
    if (!bal) return setBalError(`Out of range! ${d.toFixed(1)}m at ${v0.toFixed(1)}m/s. Increase pressure.`)
    const reqPsi = Math.ceil((massKg*(v0*v0)/(2*BARREL_A*1.0*efficiency))/6894.76)
    if (reqPsi > maxPsi) return setBalError(`Required PSI (${reqPsi}) exceeds max safe PSI (${maxPsi}). Reduce distance or increase max PSI.`)
    const requiredPsi=Math.ceil((massKg*(v0*v0)/(2*BARREL_A*1.0*efficiency))/6894.76)
    setBalResult({ dist:d.toFixed(1), bearing:bear.toFixed(1), v0:v0.toFixed(1),
      pitch:bal.pitch.toFixed(1), tof:bal.tof.toFixed(2), psi, wind:wind.toFixed(1), requiredPsi })
  }

  async function handleAutoAim() {
    if (!balResult) return setBalError('Calculate first!')
    setAimBusy(true); setBalError('')
    try {
      const r = await fetch(`${API}/api/autoaim/start`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ heading:parseFloat(balResult.bearing), pitch:parseFloat(balResult.pitch) }),
      })
      const j = await r.json()
      if (!j.ok) setBalError(j.error||'Auto-aim failed')
    } catch(e) { setBalError(String(e.message)) }
    finally { setAimBusy(false) }
  }

  async function handleStop() {
    setAimBusy(true)
    try { await fetch(`${API}/api/autoaim/stop`,{method:'POST'}) } catch {}
    finally { setAimBusy(false) }
  }

  async function handleArm() {
    if (!balResult) return setBalError('Calculate ballistics first!')
    try {
      const r = await fetch(`${API}/api/autofire/arm`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ targetPsi: parseFloat(balResult.requiredPsi) }),
      })
      const j = await r.json()
      if (j.ok) setFireArmed(true)
      else setBalError(j.error||'Arm failed')
    } catch(e) { setBalError(String(e.message)) }
  }

  async function handleFireStop() {
    try {
      await fetch(`${API}/api/autofire/stop`,{method:'POST'})
      await fetch(`${API}/api/autofire/reset`,{method:'POST'})
      setFireArmed(false)
    } catch {}
  }

  async function handleVent() {
    try {
      await fetch(`${API}/api/solenoids/release`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ pulseMs:1000 }),
      })
    } catch(e) { setBalError('Vent failed: '+e.message) }
  }

  function startHold() {
    if (!mortar||!target) { alert('Set both cannon and target first.'); return }
    setHoldProgress(0)
    holdStart.current = Date.now()
    holdTimer.current = setInterval(async () => {
      const elapsed = Date.now()-holdStart.current
      const progress = Math.min(1, elapsed/2000)
      setHoldProgress(progress)
      if (progress>=1) {
        clearInterval(holdTimer.current); setHoldProgress(0)
        const ok = window.confirm('FINAL CONFIRM: Fire?')
        if (!ok) return
        try { await axios.post(`${API}/api/solenoids/shoot`,{pulseMs:200}); alert('Fired!') }
        catch(e) { alert('Fire failed: '+e.message) }
      }
    }, 80)
  }

  function cancelHold() { clearInterval(holdTimer.current); setHoldProgress(0) }

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="card">

      {/* ── Live sensors bar ── */}
      <div style={{ display:'flex', gap:20, flexWrap:'wrap', padding:'10px 14px',
        background:'var(--color-background-secondary)', borderRadius:10, marginBottom:10,
        border:'1px solid var(--color-border-tertiary)' }}>
        <div><div style={{fontSize:10,color:'var(--color-text-tertiary)'}}>PRESSURE</div>
          <div style={{fontSize:18,fontWeight:600}}>{pressure?.psi!=null?`${pressure.psi.toFixed(1)} PSI`:'--'}</div></div>
        <div><div style={{fontSize:10,color:'var(--color-text-tertiary)'}}>WIND</div>
          <div style={{fontSize:18,fontWeight:600}}>{windLive?.ms!=null?`${windLive.ms.toFixed(1)} m/s`:'--'}</div></div>
        <div><div style={{fontSize:10,color:'var(--color-text-tertiary)'}}>IMU HEADING</div>
          <div style={{fontSize:18,fontWeight:600}}>{currentHdg!=null?`${currentHdg.toFixed(1)}°`:'--'}</div></div>
        <div><div style={{fontSize:10,color:'var(--color-text-tertiary)'}}>ELEVATION</div>
          <div style={{fontSize:18,fontWeight:600}}>{currentElev}°</div></div>
        <div style={{marginLeft:'auto',display:'flex',alignItems:'center',gap:8}}>
          <div style={{width:10,height:10,borderRadius:'50%',background:statusColor,
            boxShadow:aimStatus==='SEEKING'?`0 0 8px ${statusColor}`:'none'}}/>
          <span style={{fontWeight:600,color:statusColor}}>{aimStatus}</span>
        </div>
      </div>

      {/* ── Map mode buttons ── */}
      <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginBottom:8 }}>
        <button className="btn"
          onClick={() => setClickMode('cannon')}
          style={{ background: clickMode==='cannon' ? 'rgba(76,175,80,.2)' : undefined,
            border: clickMode==='cannon' ? '1px solid #4caf50' : undefined }}>
          📍 Click to set Cannon
        </button>
        <button className="btn"
          onClick={() => setClickMode('target')}
          style={{ background: clickMode==='target' ? 'rgba(244,67,54,.2)' : undefined,
            border: clickMode==='target' ? '1px solid #f44336' : undefined }}>
          🎯 Click to set Target
        </button>
        <button className="btn ghost" onClick={() => setClickMode('none')}>Pan only</button>
        <button className="btn ghost" onClick={() => setAutoCenter(v=>!v)}>
          {autoCenter ? 'Auto-center ON' : 'Auto-center OFF'}
        </button>
        <button className="btn ghost" onClick={() => {
          setMortar(null); setTarget(null); setBalResult(null)
          setMLat(''); setMLon(''); setTLat(''); setTLon('')
        }}>Clear All</button>
      </div>

      {/* ── Click mode hint ── */}
      {clickMode !== 'none' && (
        <div style={{ padding:'8px 12px', borderRadius:8, marginBottom:8, fontSize:13,
          background: clickMode==='cannon' ? 'rgba(76,175,80,.1)' : 'rgba(244,67,54,.1)',
          border: clickMode==='cannon' ? '1px solid rgba(76,175,80,.3)' : '1px solid rgba(244,67,54,.3)',
          color: clickMode==='cannon' ? '#4caf50' : '#f44336' }}>
          {clickMode==='cannon' ? '📍 Click anywhere on the map to place the cannon' : '🎯 Click anywhere on the map to place the target'}
        </div>
      )}

      {/* ── Map ── */}
      <div style={{ height:'55vh', borderRadius:10, overflow:'hidden', marginBottom:10 }}>
        <MapContainer center={mapCenter} zoom={14} style={{ height:'100%', width:'100%' }} minZoom={2} maxZoom={19}>
          <TileLayer
            url="/tiles/{z}/{x}/{y}.png"
            attribution="© OpenStreetMap"
            maxZoom={18}
            maxNativeZoom={18}
            errorTileUrl="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
          />
          {autoCenter && <Recenter center={mapCenter}/>}
          <MapClickHandler
            clickMode={clickMode}
            onCannonSet={setMortarFromClick}
            onTargetSet={setTargetFromClick}
          />
          {mortar && (
            <Marker position={[mortar.lat,mortar.lon]} draggable icon={mortarIcon}
              eventHandlers={{ dragend: e => {
                const p=e.target.getLatLng()
                setMortar({lat:p.lat,lon:p.lng})
                setMLat(p.lat.toFixed(6)); setMLon(p.lng.toFixed(6))
              }}}/>
          )}
          {target && (
            <Marker position={[target.lat,target.lon]} draggable icon={targetIcon}
              eventHandlers={{ dragend: e => {
                const p=e.target.getLatLng()
                setTarget({lat:p.lat,lon:p.lng})
                setTLat(p.lat.toFixed(6)); setTLon(p.lng.toFixed(6))
              }}}/>
          )}
          {path   && <Polyline positions={path} color="#ffcc00" weight={3} dashArray="6 6"/>}
          {sector && <Polygon positions={sector} pathOptions={{color:'#ff6666',weight:1,fillColor:'#ff6666',fillOpacity:0.15}}/>}
        </MapContainer>
      </div>

      {/* ── Bearing + Distance display ── */}
      {mortar && target && (
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:10 }}>

          {/* Big bearing display */}
          <div style={{ padding:16, borderRadius:10, background:'var(--color-background-secondary)',
            border:'1px solid var(--color-border-tertiary)', textAlign:'center' }}>
            <div style={{ fontSize:12, color:'var(--color-text-tertiary)', marginBottom:4 }}>
              BEARING TO TARGET
            </div>
            <div style={{ fontSize:52, fontWeight:700, color:'#ff9800', lineHeight:1 }}>
              {heading!=null ? heading.toFixed(1) : '--'}°
            </div>
            <div style={{ fontSize:13, color:'var(--color-text-secondary)', marginTop:4 }}>
              Point your physical compass to this bearing
            </div>
            <div style={{ marginTop:8, fontSize:18, fontWeight:600 }}>
              📏 {dist!=null ? dist.toFixed(1)+' m' : '--'}
            </div>
          </div>

          {/* Compass widget */}
          <div style={{ padding:16, borderRadius:10, background:'var(--color-background-secondary)',
            border:'1px solid var(--color-border-tertiary)', display:'flex',
            flexDirection:'column', alignItems:'center', justifyContent:'center' }}>
            <CompassWidget currentHeading={currentHdg} targetBearing={heading}/>
          </div>
        </div>
      )}

      {/* ── Manual GPS inputs ── */}
      <div style={{ padding:12, borderRadius:10, background:'var(--color-background-secondary)',
        border:'1px solid var(--color-border-tertiary)', marginBottom:10 }}>
        <div style={{ fontWeight:500, marginBottom:10, fontSize:13 }}>Manual GPS Coordinates</div>

        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr auto auto', gap:8, alignItems:'end', marginBottom:8 }}>
          <div><div style={{fontSize:11,color:'var(--color-text-tertiary)'}}>Cannon Lat</div>
            <input className="input" value={mLat} onChange={e=>setMLat(e.target.value)} placeholder="45.120000"/></div>
          <div><div style={{fontSize:11,color:'var(--color-text-tertiary)'}}>Cannon Lon</div>
            <input className="input" value={mLon} onChange={e=>setMLon(e.target.value)} placeholder="-74.100000"/></div>
          <button className="btn" onClick={applyManualMortar}>Set Cannon</button>
          <button className="btn ghost" onClick={()=>{setMLat('');setMLon('');setMortar(null)}}>✕</button>
        </div>

        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr auto auto', gap:8, alignItems:'end' }}>
          <div><div style={{fontSize:11,color:'var(--color-text-tertiary)'}}>Target Lat</div>
            <input className="input" value={tLat} onChange={e=>setTLat(e.target.value)} placeholder="45.125000"/></div>
          <div><div style={{fontSize:11,color:'var(--color-text-tertiary)'}}>Target Lon</div>
            <input className="input" value={tLon} onChange={e=>setTLon(e.target.value)} placeholder="-74.095000"/></div>
          <button className="btn" onClick={applyManualTarget}>Set Target</button>
          <button className="btn ghost" onClick={()=>{setTLat('');setTLon('');setTarget(null)}}>✕</button>
        </div>

        {manualErr && <div style={{marginTop:8,fontSize:12,color:'#e53935'}}>{manualErr}</div>}
      </div>

      {/* ── Ballistics ── */}
      <div style={{ padding:14, borderRadius:10, background:'var(--color-background-secondary)',
        border:'1px solid var(--color-border-tertiary)', marginBottom:10 }}>
        <div style={{ fontWeight:500, marginBottom:6 }}>Ballistics</div>
        <div style={{fontSize:12,color:'var(--color-text-tertiary)',marginBottom:10}}>
          Step 1 — Set cannon + target on map, fill inputs below, then click Calculate & Aim
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:10, marginBottom:10 }}>
          <div><div style={{fontSize:11,color:'var(--color-text-tertiary)'}}>Balloon (kg)</div>
            <input className="input" type="number" min="0.1" max="5" step="0.1"
              value={massKg} onChange={e=>setMassKg(parseFloat(e.target.value))}/></div>
          <div><div style={{fontSize:11,color:'var(--color-text-tertiary)'}}>IMU pitch offset (°)</div>
            <input className="input" type="number" step="0.1"
              value={imuOffset} onChange={e=>setImuOffset(parseFloat(e.target.value))}/></div>
          <div style={{display:'flex',alignItems:'flex-end'}}>
            <button className="btn" style={{width:'100%'}} onClick={calculate}>Calculate</button>
          </div>
          <div>
            <div style={{fontSize:11,color:'var(--color-text-tertiary)'}}>Max PSI (safety limit)</div>
            <input className="input" type="number" min="10" max="200" step="5"
              value={maxPsi} onChange={e=>setMaxPsi(parseFloat(e.target.value))}/>
          </div>
          <div>
            <div style={{fontSize:11,color:'var(--color-text-tertiary)'}}>
              Heading offset (°)
              <span style={{marginLeft:6,color:'var(--color-text-tertiary)',fontStyle:'italic'}}>
                — point cannon North, read IMU, enter that value
              </span>
            </div>
            <input className="input" type="number" step="0.1"
              value={headingOffset} onChange={e=>setHeadingOffset(parseFloat(e.target.value))}/>
          </div>
          <div>
            <div style={{fontSize:11,color:'var(--color-text-tertiary)'}}>
              Efficiency (0.1-1.0)
              <span style={{marginLeft:6,color:'var(--color-text-tertiary)',fontStyle:'italic'}}>
                — increase if shoots short, decrease if overshoots
              </span>
            </div>
            <input className="input" type="number" min="0.05" max="1.0" step="0.01"
              value={efficiency} onChange={e=>setEfficiency(parseFloat(e.target.value))}/>
          </div>
        </div>

        {/* ── Phone calibration ── */}
        <div style={{ padding:'12px 14px', borderRadius:8, marginBottom:10,
          background:'var(--color-background-primary)',
          border:'1px solid var(--color-border-tertiary)' }}>
          <div style={{fontWeight:500, fontSize:12, marginBottom:10, color:'var(--color-text-secondary)'}}>
            📱 Phone Calibration — tape phone to barrel, read compass + level app
          </div>
          <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:10}}>
            <div>
              <div style={{fontSize:11, color:'var(--color-text-tertiary)', marginBottom:4}}>
                Phone compass reading (°)
              </div>
              <div style={{display:'flex', gap:6}}>
                <input className="input" type="number" step="0.1" placeholder="e.g. 245.0"
                  value={phoneHeading} onChange={e=>setPhoneHeading(e.target.value)}
                  style={{flex:1}}/>
                <button className="btn" onClick={calibrateHeading}
                  style={{whiteSpace:'nowrap'}}>Set North</button>
              </div>
              <div style={{fontSize:10, color:'var(--color-text-tertiary)', marginTop:4}}>
                IMU raw: {imuState?.heading!=null ? imuState.heading.toFixed(1)+'°' : '--'} →
                corrected: {currentHdg!=null ? currentHdg.toFixed(1)+'°' : '--'}
              </div>
            </div>
            <div>
              <div style={{fontSize:11, color:'var(--color-text-tertiary)', marginBottom:4}}>
                Phone level reading (°)
              </div>
              <div style={{display:'flex', gap:6}}>
                <input className="input" type="number" step="0.1" placeholder="e.g. 0.0"
                  value={phonePitch} onChange={e=>setPhonePitch(e.target.value)}
                  style={{flex:1}}/>
                <button className="btn" onClick={calibratePitch}
                  style={{whiteSpace:'nowrap'}}>Set Level</button>
              </div>
              <div style={{fontSize:10, color:'var(--color-text-tertiary)', marginTop:4}}>
                IMU raw: {imuState?.pitch!=null ? imuState.pitch.toFixed(1)+'°' : '--'} →
                corrected: {currentElev}°
              </div>
            </div>
          </div>
          {calMsg && (
            <div style={{fontSize:12, padding:'6px 10px', borderRadius:6,
              background: calMsg.startsWith('✓') ? 'rgba(76,175,80,.1)' : 'rgba(229,57,53,.1)',
              color: calMsg.startsWith('✓') ? '#4caf50' : '#e53935',
              border: calMsg.startsWith('✓') ? '1px solid rgba(76,175,80,.3)' : '1px solid rgba(229,57,53,.3)'}}>
              {calMsg}
            </div>
          )}
        </div>

        {balError && (
          <div style={{padding:'8px 12px',borderRadius:8,marginBottom:10,
            background:'rgba(229,57,53,.1)',color:'#e53935',fontSize:13}}>{balError}</div>
        )}

        {balResult && (
          <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8,marginBottom:12}}>
            {[
              {label:'Distance',   value:`${balResult.dist} m`},
              {label:'Bearing',    value:`${balResult.bearing}°`},
              {label:'Muzzle v0',  value:`${balResult.v0} m/s`},
              {label:'Pitch',      value:`${balResult.pitch}°`, hi:true},
              {label:'Flight',     value:`${balResult.tof} s`},
              {label:'Wind',       value:`${balResult.wind} m/s`},
              {label:'Req. PSI',   value:`${balResult.requiredPsi} PSI`, hi:true},
            ].map(({label,value,hi})=>(
              <div key={label} style={{background:'var(--color-background-primary)',borderRadius:8,
                padding:'8px 10px',border:hi?'1px solid #ff9800':'1px solid var(--color-border-tertiary)'}}>
                <div style={{fontSize:10,color:'var(--color-text-tertiary)'}}>{label}</div>
                <div style={{fontSize:16,fontWeight:600,color:hi?'#ff9800':undefined}}>{value}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Phase 1: Aim ── */}
      {balResult && (
        <div style={{ padding:14, borderRadius:10, marginBottom:10,
          background:'var(--color-background-secondary)',
          border: aimStatus==='ON_TARGET' ? '1px solid #4caf50' : '1px solid var(--color-border-tertiary)' }}>
          <div style={{fontWeight:500,marginBottom:10}}>Phase 1 — Aim Cannon</div>

          <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:12,
            padding:'10px 14px',borderRadius:8,background:'var(--color-background-primary)'}}>
            <div style={{flex:1}}>
              <div style={{fontSize:12,color:'var(--color-text-tertiary)'}}>Point physical compass to:</div>
              <div style={{fontSize:32,fontWeight:700,color:'#ff9800'}}>{balResult.bearing}°</div>
            </div>
            <div style={{flex:1}}>
              <div style={{fontSize:12,color:'var(--color-text-tertiary)'}}>Then tilt cannon up to:</div>
              <div style={{fontSize:32,fontWeight:700,color:'#ff9800'}}>{balResult.pitch}°</div>
            </div>
            <div style={{flex:1,textAlign:'center'}}>
              <div style={{fontSize:12,color:'var(--color-text-tertiary)',marginBottom:4}}>IMU alignment</div>
              <div style={{fontWeight:700,fontSize:16,
                color:aimAligned?'#4caf50':aimDiff!=null&&aimDiff<10?'#ff9800':'#e53935'}}>
                {aimAligned ? '✓ ALIGNED' : aimDiff!=null ? `${aimDiff.toFixed(1)}° off` : '--'}
              </div>
              <div style={{fontSize:12,color:'var(--color-text-tertiary)'}}>
                IMU: {currentHdg!=null?currentHdg.toFixed(1)+'°':'--'}
              </div>
            </div>
          </div>

          <div style={{display:'flex',gap:10,flexWrap:'wrap'}}>
            <button className="btn"
              onClick={handleAutoAim}
              disabled={aimBusy||aimStatus==='SEEKING'}
              style={{
                padding:'12px 24px', fontWeight:700, fontSize:15,
                background: aimStatus==='ON_TARGET' ? 'rgba(76,175,80,.2)' : 'rgba(255,152,0,.15)',
                color: aimStatus==='ON_TARGET' ? '#4caf50' : '#ff9800',
                border: aimStatus==='ON_TARGET' ? '1px solid #4caf50' : '1px solid #ff9800',
              }}>
              {aimStatus==='ON_TARGET' ? '✅ ON TARGET' : aimStatus==='SEEKING' ? '⟳ Seeking...' : '🎯 CALCULATE & AIM CANNON'}
            </button>
            {(aimStatus==='SEEKING'||aimStatus==='ON_TARGET') && (
              <button className="btn ghost" onClick={handleStop}>STOP</button>
            )}
          </div>
          {aimStatus==='SEEKING' && (
            <div style={{marginTop:10,padding:'10px 14px',borderRadius:8,
              background:'rgba(255,152,0,.08)',border:'1px solid rgba(255,152,0,.3)',
              fontSize:13,color:'#ff9800'}}>
              ⟳ Motors moving... Canon rotating to {balResult.bearing}° and tilting to {balResult.pitch}°
            </div>
          )}
          {aimStatus==='ON_TARGET' && (
            <div style={{marginTop:10,padding:'12px 16px',borderRadius:8,
              background:'rgba(76,175,80,.1)',border:'1px solid rgba(76,175,80,.4)',
              fontSize:14,fontWeight:700,color:'#4caf50',textAlign:'center'}}>
              ✅ CANNON ON TARGET — You can now pressurize the system
            </div>
          )}
        </div>
      )}

      {/* ── Phase 2: Pressurize & Fire ── */}
      {balResult && aimStatus === 'ON_TARGET' && (
        <div style={{ padding:14, borderRadius:10, marginBottom:10,
          background:'var(--color-background-secondary)',
          border: fireStatus==='FIRED'?'1px solid #4caf50':fireStatus==='ARMED'?'1px solid #ff9800':'1px solid var(--color-border-tertiary)' }}>
          <div style={{fontWeight:500,marginBottom:10}}>Phase 2 — Pressurize & Auto-Fire</div>



          {/* PSI gauge */}
          <div style={{marginBottom:12}}>
            <div style={{display:'flex',justifyContent:'space-between',marginBottom:6}}>
              <span style={{fontSize:13}}>Current: <strong>{(firePsi??pressure?.psi??0).toFixed(1)} PSI</strong></span>
              <span style={{fontSize:13}}>Target: <strong style={{color:'#ff9800'}}>{balResult.requiredPsi} PSI</strong></span>
            </div>
            <div style={{height:20,borderRadius:10,background:'#2b2b2b',overflow:'hidden'}}>
              <div style={{
                width:`${Math.min(100,((firePsi??pressure?.psi??0)/balResult.requiredPsi)*100)}%`,
                height:'100%',
                background: fireStatus==='FIRED'?'#4caf50':'linear-gradient(90deg,#ff9900,#ff3d00)',
                borderRadius:10, transition:'width .3s'
              }}/>
            </div>
            <div style={{display:'flex',justifyContent:'space-between',marginTop:4}}>
              <span style={{fontSize:11,color:'var(--color-text-tertiary)'}}>0 PSI</span>
              <span style={{fontSize:13,fontWeight:600,
                color:fireStatus==='FIRED'?'#4caf50':fireStatus==='ARMED'?'#ff9800':'#888'}}>
                {fireStatus}
              </span>
              <span style={{fontSize:11,color:'var(--color-text-tertiary)'}}>{balResult.requiredPsi} PSI</span>
            </div>
          </div>

          {fireStatus==='FIRED' ? (
            <div style={{textAlign:'center',padding:'12px 0'}}>
              <div style={{fontSize:24,fontWeight:700,color:'#4caf50',marginBottom:10}}>🎯 FIRED!</div>
              <div style={{display:'flex',gap:10,justifyContent:'center'}}>
                <button className="btn ghost" onClick={handleFireStop}>Reset</button>
                <button className="btn" onClick={handleVent}
                  style={{background:'rgba(0,120,255,.12)',color:'#0b57d0',border:'1px solid rgba(0,120,255,.4)'}}>
                  VENT AIR
                </button>
              </div>
            </div>
          ) : (
            <div style={{display:'flex',gap:10,flexWrap:'wrap'}}>
              <button className="btn"
                onClick={handleArm}
                disabled={fireArmed}
                style={{background:'rgba(176,0,32,.15)',color:'#b00020',border:'1px solid rgba(176,0,32,.4)'}}>
                {fireArmed ? '🔴 ARMED — Watching PSI...' : 'ARM AUTO-FIRE'}
              </button>
              {fireArmed && (
                <button className="btn ghost" onClick={handleFireStop}>DISARM</button>
              )}
              <button className="btn"
                onClick={handleVent}
                style={{background:'rgba(0,120,255,.12)',color:'#0b57d0',border:'1px solid rgba(0,120,255,.4)'}}>
                VENT AIR
              </button>
            </div>
          )}

          {fireArmed && fireStatus!=='FIRED' && (
            <div style={{marginTop:10}}>
              <div style={{padding:'10px 14px',borderRadius:8,marginBottom:8,
                background:'rgba(255,152,0,.1)',border:'1px solid rgba(255,152,0,.3)',
                fontSize:13,color:'#ff9800'}}>
                🔴 ARMED — Turn on compressor. Will fire automatically at {balResult.requiredPsi} PSI
              </div>
              {(firePsi??pressure?.psi??0) > maxPsi * 0.9 && (
                <div style={{padding:'10px 14px',borderRadius:8,
                  background:'rgba(229,57,53,.15)',border:'1px solid rgba(229,57,53,.5)',
                  fontSize:13,fontWeight:700,color:'#e53935'}}>
                  ⚠️ APPROACHING MAX PSI ({maxPsi} PSI) — VENT IF NO SHOT!
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Vent Air ── */}
      <div style={{ padding:14, borderRadius:10, background:'var(--color-background-secondary)',
        border:'1px solid var(--color-border-tertiary)' }}>
        <div style={{fontWeight:500,marginBottom:10}}>Air Release</div>
        <div style={{display:'flex',gap:12,alignItems:'center',flexWrap:'wrap'}}>
          <button className="btn"
            onClick={handleVent}
            style={{padding:'12px 24px',fontWeight:700,
              background:'rgba(0,120,255,.12)',color:'#0b57d0',
              border:'1px solid rgba(0,120,255,.4)',fontSize:15}}>
            VENT AIR (GPIO24)
          </button>
          <div style={{fontSize:13,color:'var(--color-text-secondary)'}}>
            Press anytime to release pressure safely
          </div>
        </div>
      </div>

    </div>
  )
}
