import React, { useEffect, useMemo, useRef, useState } from 'react'
import axios from 'axios'
import { MapContainer, TileLayer, Marker, Polyline, Polygon, useMapEvents, useMap } from 'react-leaflet'
import L from 'leaflet'

const API = import.meta.env.VITE_API_BASE_URL || import.meta.env.VITE_API_URL || 'http://localhost:8080'

// ── Constants ─────────────────────────────────────────────────────────────
const G        = 9.80665
const BARREL_D = 0.075
const BARREL_A = Math.PI * (BARREL_D / 2) ** 2
const BARREL_L = 1.0

// ── Math helpers ──────────────────────────────────────────────────────────
function haversineMeters(a, b) {
  const R = 6371000
  const toR = x => x * Math.PI / 180
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

function destinationLatLon(lat, lon, brg, dist) {
  const R=6371000, δ=dist/R, θ=brg*Math.PI/180
  const φ1=lat*Math.PI/180, λ1=lon*Math.PI/180
  const φ2=Math.asin(Math.sin(φ1)*Math.cos(δ)+Math.cos(φ1)*Math.sin(δ)*Math.cos(θ))
  const λ2=λ1+Math.atan2(Math.sin(θ)*Math.sin(δ)*Math.cos(φ1),Math.cos(δ)-Math.sin(φ1)*Math.sin(φ2))
  return { lat:φ2*180/Math.PI, lon:((λ2*180/Math.PI+540)%360)-180 }
}

function sectorPolygon(center, hdg, halfAngle, range, steps=24) {
  if (!center) return null
  const { lat, lon } = center
  const coords = [[lat,lon]]
  for (let i=0; i<=steps; i++) {
    const p = destinationLatLon(lat, lon, hdg - halfAngle + i*(2*halfAngle/steps), range)
    coords.push([p.lat, p.lon])
  }
  coords.push([lat,lon])
  return coords
}

function parseNum(s) {
  const n = Number(String(s).trim())
  return Number.isFinite(n) ? n : null
}

/**
 * muzzleVelocity — based on real test shots:
 *   1kg @ 50 PSI → 80m (v0=28 m/s)
 *   1kg @ 125 PSI → 230m (v0=47.5 m/s)
 *   efficiency = 0.26
 */
function muzzleVelocity(psi, massKg, eff) {
  const pa   = psi * 6894.76
  const work = pa * BARREL_A * BARREL_L * eff
  return Math.min(Math.sqrt((2 * work) / massKg), 80)
}

/**
 * calcPitch — HIGH ARC solution (45-80 degrees)
 * Cannon minimum pitch is 45 degrees
 * High arc = more hang time = better wind compensation
 */
function calcPitch(dx, v0, windMs = 0) {
  // Apply wind compensation to effective velocity
  const vEff  = Math.max(1, v0 - windMs * 0.3)
  const v0sq  = vEff * vEff
  const under = v0sq * v0sq - G * (G * dx * dx)
  if (under < 0) return null

  // HIGH arc solution (+)
  const tanH  = (v0sq + Math.sqrt(under)) / (G * dx)
  const pitch = (Math.atan(tanH) * 180) / Math.PI

  if (pitch < 45 || pitch > 80) return null

  // Time of flight
  const θ  = pitch * Math.PI / 180
  const vy = vEff * Math.sin(θ)
  const disc = vy * vy + 2 * G * 0  // flat terrain
  const tof  = (vy + Math.sqrt(disc)) / G

  return { pitch, tof }
}

/**
 * findRequiredPsi — finds minimum PSI to achieve given distance
 * at 45-80 degree high arc
 */
function findRequiredPsi(dist, massKg, eff, windMs = 0) {
  for (let psi = 1; psi <= 200; psi++) {
    const v0  = muzzleVelocity(psi, massKg, eff)
    const bal = calcPitch(dist, v0, windMs)
    if (bal) return { psi, ...bal }
  }
  return null
}

// ── Compass widget ────────────────────────────────────────────────────────
function CompassWidget({ currentHeading, targetBearing }) {
  const S=130, C=S/2, R=C-10
  const pt = (d, r) => ({
    x: C + r * Math.cos((d-90)*Math.PI/180),
    y: C + r * Math.sin((d-90)*Math.PI/180),
  })
  const diff = targetBearing!=null && currentHeading!=null
    ? Math.abs(((targetBearing-currentHeading)+180)%360-180) : null
  const aligned = diff!=null && diff<=3

  return (
    <div style={{textAlign:'center'}}>
      <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`}>
        <circle cx={C} cy={C} r={R} fill="none" stroke="var(--color-border-secondary)" strokeWidth="1.5"/>
        {Array.from({length:36},(_,i)=>{
          const a=i*10, inner=pt(a,R-(i%9===0?14:i%3===0?9:6)), outer=pt(a,R)
          return <line key={i} x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y}
            stroke="var(--color-border-secondary)" strokeWidth={i%9===0?2:1}/>
        })}
        {[['N',0],['E',90],['S',180],['W',270]].map(([l,d])=>{
          const p=pt(d,R-20)
          return <text key={l} x={p.x} y={p.y} textAnchor="middle" dominantBaseline="central"
            fontSize="10" fontWeight="600" fill={l==='N'?'#e53935':'var(--color-text-secondary)'}>{l}</text>
        })}
        {targetBearing!=null && (()=>{
          const tip=pt(targetBearing,R-16)
          return <><line x1={C} y1={C} x2={tip.x} y2={tip.y}
            stroke="#ff9800" strokeWidth="2" strokeDasharray="4 3"/>
            <circle cx={tip.x} cy={tip.y} r={4} fill="#ff9800"/></>
        })()}
        {currentHeading!=null && (()=>{
          const tip=pt(currentHeading,R-16), tail=pt(currentHeading+180,14)
          return <line x1={tail.x} y1={tail.y} x2={tip.x} y2={tip.y}
            stroke="#4caf50" strokeWidth="3" strokeLinecap="round"/>
        })()}
        <circle cx={C} cy={C} r={3} fill="var(--color-text-tertiary)"/>
      </svg>
      <div style={{fontSize:11,marginTop:2}}>
        <span style={{color:'#4caf50'}}>● IMU</span>{'  '}
        <span style={{color:'#ff9800'}}>● Target</span>
      </div>
      {diff!=null && (
        <div style={{marginTop:2,fontWeight:600,fontSize:12,
          color:aligned?'#4caf50':diff<10?'#ff9800':'#e53935'}}>
          {aligned?'✓ ALIGNED':`${diff.toFixed(1)}° off`}
        </div>
      )}
    </div>
  )
}

// ── Leaflet icons ─────────────────────────────────────────────────────────
const mortarIcon = new L.DivIcon({
  className:'',
  html:'<div style="background:#4CAF50;width:24px;height:24px;border-radius:50%;border:3px solid white;box-shadow:0 2px 6px rgba(0,0,0,.4)"></div>',
  iconSize:[24,24], iconAnchor:[12,12]
})
const targetIcon = new L.DivIcon({
  className:'',
  html:'<div style="background:#F44336;width:24px;height:24px;border-radius:50%;border:3px solid white;box-shadow:0 2px 6px rgba(0,0,0,.4)"></div>',
  iconSize:[24,24], iconAnchor:[12,12]
})

function MapClickHandler({ clickMode, onCannonSet, onTargetSet }) {
  useMapEvents({
    click(e) {
      const { lat, lng } = e.latlng
      if (clickMode==='cannon') onCannonSet({ lat, lon:lng })
      else if (clickMode==='target') onTargetSet({ lat, lon:lng })
    }
  })
  return null
}

function Recenter({ center }) {
  const map = useMap()
  useEffect(() => { if (center) map.setView(center, map.getZoom()) }, [center, map])
  return null
}

// ── Main page ─────────────────────────────────────────────────────────────
export default function MapPage() {
  // Positions
  const [mortar,     setMortar]     = useState(null)
  const [target,     setTarget]     = useState(null)
  const [clickMode,  setClickMode]  = useState('target')
  const [autoCenter, setAutoCenter] = useState(true)

  // Manual inputs
  const [mLat, setMLat] = useState('')
  const [mLon, setMLon] = useState('')
  const [tLat, setTLat] = useState('')
  const [tLon, setTLon] = useState('')
  const [manualErr, setManualErr] = useState('')

  // Ballistics settings
  const [massKg,      setMassKg]      = useState(1.0)
  const [efficiency,  setEfficiency]  = useState(0.26)  // calibrated from real shots
  const [maxPsi,      setMaxPsi]      = useState(150)
  const [planningPsi, setPlanningPsi] = useState('')
  const [imuOffset,   setImuOffset]   = useState(178.5)
  const [headingOffset, setHeadingOffset] = useState(0.0)

  // Results
  const [balResult, setBalResult] = useState(null)
  const [balError,  setBalError]  = useState('')

  // Phone calibration
  const [phoneHeading, setPhoneHeading] = useState('')
  const [phonePitch,   setPhonePitch]   = useState('')
  const [calMsg,       setCalMsg]       = useState('')

  // Live sensors
  const [pressure,  setPressure]  = useState(null)
  const [windLive,  setWindLive]  = useState({ ms:null, kmh:null })
  const [imuState,  setImuState]  = useState(null)

  // Auto-aim
  const [aimStatus, setAimStatus] = useState('IDLE')
  const [aimBusy,   setAimBusy]   = useState(false)

  // Auto-fire
  const [fireStatus, setFireStatus] = useState('IDLE')
  const [firePsi,    setFirePsi]    = useState(null)
  const [fireArmed,  setFireArmed]  = useState(false)

  // ── Poll sensors ────────────────────────────────────────────────────────
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

  // ── AutoAim SSE ──────────────────────────────────────────────────────────
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

  // ── AutoFire SSE ─────────────────────────────────────────────────────────
  useEffect(() => {
    let es=null, stopped=false
    const connect = () => {
      es = new EventSource(`${API}/api/autofire/stream`)
      es.onmessage = e => { if (!stopped) try {
        const d=JSON.parse(e.data)
        if (d.status)     setFireStatus(d.status)
        if (d.currentPsi!=null) setFirePsi(d.currentPsi)
      } catch {} }
      es.onerror = () => { if (!stopped) { es?.close(); setTimeout(connect,2000) } }
    }
    connect()
    return () => { stopped=true; es?.close() }
  }, [])

  // ── Derived values ───────────────────────────────────────────────────────
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

  const path      = useMemo(() => (mortar&&target) ? [[mortar.lat,mortar.lon],[target.lat,target.lon]] : null, [mortar,target])
  const mapCenter = mortar ? [mortar.lat,mortar.lon] : [45.009142,-74.068943]

  // Corrected IMU values
  const currentElev = imuState?.pitch!=null    ? (imuState.pitch - imuOffset).toFixed(1)                : '--'
  const currentHdg  = imuState?.heading!=null  ? (imuState.heading + headingOffset + 360) % 360         : null

  const aimDiff    = heading!=null && currentHdg!=null ? Math.abs(((heading-currentHdg)+180)%360-180) : null
  const aimAligned = aimDiff!=null && aimDiff<=3

  const statusColor = { IDLE:'#888', SEEKING:'#ff9800', ON_TARGET:'#4caf50', ERROR:'#e53935' }[aimStatus]||'#888'

  // ── Actions ──────────────────────────────────────────────────────────────
  function setMortarFromClick(pos) {
    setMortar(pos); setMLat(pos.lat.toFixed(6)); setMLon(pos.lon.toFixed(6))
    setClickMode('target')
  }
  function setTargetFromClick(pos) {
    setTarget(pos); setTLat(pos.lat.toFixed(6)); setTLon(pos.lon.toFixed(6))
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

  function calculate() {
    setBalError(''); setBalResult(null)
    if (!mortar||!target) return setBalError('Set both cannon and target on the map first.')

    const wind = windLive?.ms ?? 0
    const d    = haversineMeters([mortar.lat,mortar.lon],[target.lat,target.lon])
    const bear = bearingDeg([mortar.lat,mortar.lon],[target.lat,target.lon])

    // Determine PSI to use
    const livePsi     = pressure?.psi ?? 0
    const usingPlanning = planningPsi !== '' && parseFloat(planningPsi) > 0
    const psi         = usingPlanning ? parseFloat(planningPsi) : livePsi

    if (psi <= 0) return setBalError('Enter a Planning PSI (tank is empty) or pressurize the tank first.')

    const v0  = muzzleVelocity(psi, massKg, efficiency)
    const bal = calcPitch(d, v0, wind)

    if (!bal) {
      // Find what PSI IS needed
      const needed = findRequiredPsi(d, massKg, efficiency, wind)
      if (needed) {
        return setBalError(`Need more pressure! At ${d.toFixed(0)}m you need at least ${needed.psi} PSI (currently ${psi.toFixed(0)} PSI).`)
      }
      return setBalError(`Target out of range even at max pressure. Distance: ${d.toFixed(0)}m`)
    }

    if (bal.psi > maxPsi) return setBalError(`Required PSI (${bal.psi}) exceeds your max PSI (${maxPsi}).`)

    setBalResult({
      dist:         d.toFixed(1),
      bearing:      bear.toFixed(1),
      v0:           v0.toFixed(1),
      pitch:        bal.pitch.toFixed(1),
      tof:          bal.tof.toFixed(2),
      psi:          psi.toFixed(0),
      wind:         wind.toFixed(1),
      usingPlanning,
    })
  }

  function calibrateHeading() {
    const phone = parseFloat(phoneHeading)
    if (isNaN(phone)) return setCalMsg('Enter a valid phone compass reading.')
    if (!imuState?.heading) return setCalMsg('No IMU reading — check connection.')
    const offset = ((phone - imuState.heading) + 360) % 360
    const norm   = offset > 180 ? offset - 360 : offset
    setHeadingOffset(parseFloat(norm.toFixed(1)))
    setCalMsg(`✓ Heading offset set to ${norm.toFixed(1)}° (phone: ${phone}°, IMU: ${imuState.heading.toFixed(1)}°)`)
  }

  function calibratePitch() {
    const phone = parseFloat(phonePitch)
    if (isNaN(phone)) return setCalMsg('Enter a valid phone level reading.')
    if (!imuState?.pitch) return setCalMsg('No IMU reading — check connection.')
    setImuOffset(parseFloat((imuState.pitch - phone).toFixed(1)))
    setCalMsg(`✓ Pitch offset set to ${(imuState.pitch - phone).toFixed(1)}°`)
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

  async function handleStopAim() {
    setAimBusy(true)
    try { await fetch(`${API}/api/autoaim/stop`,{method:'POST'}) } catch {}
    finally { setAimBusy(false) }
  }

  async function handleArm() {
    if (!balResult) return setBalError('Calculate first!')
    try {
      const r = await fetch(`${API}/api/autofire/arm`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ targetPsi: parseFloat(balResult.psi) }),
      })
      const j = await r.json()
      if (j.ok) setFireArmed(true)
      else setBalError(j.error||'Arm failed')
    } catch(e) { setBalError(String(e.message)) }
  }

  async function handleDisarm() {
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

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="card">

      {/* ── Live sensor bar ── */}
      <div style={{display:'flex',gap:24,flexWrap:'wrap',padding:'10px 16px',
        background:'var(--color-background-secondary)',borderRadius:10,marginBottom:10,
        border:'1px solid var(--color-border-tertiary)'}}>
        <div>
          <div style={{fontSize:10,color:'var(--color-text-tertiary)'}}>PRESSURE</div>
          <div style={{fontSize:20,fontWeight:600}}>{pressure?.psi!=null?`${pressure.psi.toFixed(1)} PSI`:'--'}</div>
        </div>
        <div>
          <div style={{fontSize:10,color:'var(--color-text-tertiary)'}}>WIND</div>
          <div style={{fontSize:20,fontWeight:600}}>{windLive?.ms!=null?`${windLive.ms.toFixed(1)} m/s`:'--'}</div>
        </div>
        <div>
          <div style={{fontSize:10,color:'var(--color-text-tertiary)'}}>IMU HEADING</div>
          <div style={{fontSize:20,fontWeight:600}}>{currentHdg!=null?`${currentHdg.toFixed(1)}°`:'--'}</div>
        </div>
        <div>
          <div style={{fontSize:10,color:'var(--color-text-tertiary)'}}>ELEVATION</div>
          <div style={{fontSize:20,fontWeight:600}}>{currentElev}°</div>
        </div>
        <div style={{marginLeft:'auto',display:'flex',alignItems:'center',gap:8}}>
          <div style={{width:10,height:10,borderRadius:'50%',background:statusColor,
            boxShadow:aimStatus==='SEEKING'?`0 0 8px ${statusColor}`:'none'}}/>
          <span style={{fontWeight:600,color:statusColor,fontSize:14}}>{aimStatus}</span>
        </div>
      </div>

      {/* ── Map mode buttons ── */}
      <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:8}}>
        <button className="btn"
          onClick={()=>setClickMode('cannon')}
          style={{background:clickMode==='cannon'?'rgba(76,175,80,.2)':undefined,
            border:clickMode==='cannon'?'1px solid #4caf50':undefined}}>
          📍 Set Cannon
        </button>
        <button className="btn"
          onClick={()=>setClickMode('target')}
          style={{background:clickMode==='target'?'rgba(244,67,54,.2)':undefined,
            border:clickMode==='target'?'1px solid #f44336':undefined}}>
          🎯 Set Target
        </button>
        <button className="btn ghost" onClick={()=>setClickMode('none')}>Pan</button>
        <button className="btn ghost" onClick={()=>setAutoCenter(v=>!v)}>
          {autoCenter?'Auto-center ON':'Auto-center OFF'}
        </button>
        <button className="btn ghost" onClick={()=>{
          setMortar(null);setTarget(null);setBalResult(null)
          setMLat('');setMLon('');setTLat('');setTLon('')
        }}>Clear All</button>
      </div>

      {clickMode!=='none' && (
        <div style={{padding:'8px 12px',borderRadius:8,marginBottom:8,fontSize:13,
          background:clickMode==='cannon'?'rgba(76,175,80,.1)':'rgba(244,67,54,.1)',
          border:clickMode==='cannon'?'1px solid rgba(76,175,80,.3)':'1px solid rgba(244,67,54,.3)',
          color:clickMode==='cannon'?'#4caf50':'#f44336'}}>
          {clickMode==='cannon'?'📍 Click map to place cannon':'🎯 Click map to place target'}
        </div>
      )}

      {/* ── Map ── */}
      <div style={{height:'55vh',borderRadius:10,overflow:'hidden',marginBottom:10}}>
        <MapContainer center={mapCenter} zoom={16} style={{height:'100%',width:'100%'}} minZoom={2} maxZoom={19}>
          <TileLayer
            url="/tiles/{z}/{x}/{y}.png"
            attribution="© OpenStreetMap"
            maxZoom={18} maxNativeZoom={18}
            errorTileUrl="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
          />
          {autoCenter && <Recenter center={mapCenter}/>}
          <MapClickHandler clickMode={clickMode} onCannonSet={setMortarFromClick} onTargetSet={setTargetFromClick}/>
          {mortar && (
            <Marker position={[mortar.lat,mortar.lon]} draggable icon={mortarIcon}
              eventHandlers={{dragend:e=>{const p=e.target.getLatLng();setMortar({lat:p.lat,lon:p.lng});setMLat(p.lat.toFixed(6));setMLon(p.lng.toFixed(6))}}}/>
          )}
          {target && (
            <Marker position={[target.lat,target.lon]} draggable icon={targetIcon}
              eventHandlers={{dragend:e=>{const p=e.target.getLatLng();setTarget({lat:p.lat,lon:p.lng});setTLat(p.lat.toFixed(6));setTLon(p.lng.toFixed(6))}}}/>
          )}
          {path   && <Polyline positions={path} color="#ffcc00" weight={3} dashArray="6 6"/>}
          {sector && <Polygon positions={sector} pathOptions={{color:'#ff6666',weight:1,fillColor:'#ff6666',fillOpacity:0.15}}/>}
        </MapContainer>
      </div>

      {/* ── Bearing + distance display ── */}
      {mortar && target && (
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:10}}>
          <div style={{padding:16,borderRadius:10,background:'var(--color-background-secondary)',
            border:'1px solid var(--color-border-tertiary)',textAlign:'center'}}>
            <div style={{fontSize:11,color:'var(--color-text-tertiary)',marginBottom:4}}>BEARING TO TARGET</div>
            <div style={{fontSize:52,fontWeight:700,color:'#ff9800',lineHeight:1}}>
              {heading!=null?heading.toFixed(1):'--'}°
            </div>
            <div style={{fontSize:12,color:'var(--color-text-secondary)',marginTop:4}}>
              Point physical compass to this bearing
            </div>
            <div style={{marginTop:8,fontSize:20,fontWeight:600}}>📏 {dist!=null?dist.toFixed(1)+' m':'--'}</div>
          </div>
          <div style={{padding:16,borderRadius:10,background:'var(--color-background-secondary)',
            border:'1px solid var(--color-border-tertiary)',display:'flex',
            flexDirection:'column',alignItems:'center',justifyContent:'center'}}>
            <CompassWidget currentHeading={currentHdg} targetBearing={heading}/>
          </div>
        </div>
      )}

      {/* ── Manual GPS inputs ── */}
      <div style={{padding:12,borderRadius:10,background:'var(--color-background-secondary)',
        border:'1px solid var(--color-border-tertiary)',marginBottom:10}}>
        <div style={{fontWeight:500,marginBottom:10,fontSize:13}}>Manual GPS Coordinates</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr auto auto',gap:8,alignItems:'end',marginBottom:8}}>
          <div><div style={{fontSize:11,color:'var(--color-text-tertiary)'}}>Cannon Lat</div>
            <input className="input" value={mLat} onChange={e=>setMLat(e.target.value)} placeholder="45.009142"/></div>
          <div><div style={{fontSize:11,color:'var(--color-text-tertiary)'}}>Cannon Lon</div>
            <input className="input" value={mLon} onChange={e=>setMLon(e.target.value)} placeholder="-74.068943"/></div>
          <button className="btn" onClick={applyManualMortar}>Set Cannon</button>
          <button className="btn ghost" onClick={()=>{setMLat('');setMLon('');setMortar(null)}}>✕</button>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr auto auto',gap:8,alignItems:'end'}}>
          <div><div style={{fontSize:11,color:'var(--color-text-tertiary)'}}>Target Lat</div>
            <input className="input" value={tLat} onChange={e=>setTLat(e.target.value)} placeholder="45.012000"/></div>
          <div><div style={{fontSize:11,color:'var(--color-text-tertiary)'}}>Target Lon</div>
            <input className="input" value={tLon} onChange={e=>setTLon(e.target.value)} placeholder="-74.065000"/></div>
          <button className="btn" onClick={applyManualTarget}>Set Target</button>
          <button className="btn ghost" onClick={()=>{setTLat('');setTLon('');setTarget(null)}}>✕</button>
        </div>
        {manualErr && <div style={{marginTop:8,fontSize:12,color:'#e53935'}}>{manualErr}</div>}
      </div>

      {/* ── Ballistics ── */}
      <div style={{padding:14,borderRadius:10,background:'var(--color-background-secondary)',
        border:'1px solid var(--color-border-tertiary)',marginBottom:10}}>
        <div style={{fontWeight:500,marginBottom:4}}>Ballistics</div>
        <div style={{fontSize:12,color:'var(--color-text-tertiary)',marginBottom:12}}>
          Set cannon + target on map → fill inputs → click Calculate & Aim
        </div>

        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:10,marginBottom:10}}>
          <div>
            <div style={{fontSize:11,color:'var(--color-text-tertiary)'}}>Balloon weight (kg)</div>
            <input className="input" type="number" min="0.1" max="5" step="0.1"
              value={massKg} onChange={e=>setMassKg(parseFloat(e.target.value))}/>
          </div>
          <div>
            <div style={{fontSize:11,color:'var(--color-text-tertiary)'}}>
              Planning PSI <span style={{fontStyle:'italic'}}>— enter if tank is empty</span>
            </div>
            <input className="input" type="number" min="0" max="150" step="5"
              placeholder="e.g. 55" value={planningPsi} onChange={e=>setPlanningPsi(e.target.value)}/>
          </div>
          <div>
            <div style={{fontSize:11,color:'var(--color-text-tertiary)'}}>Max PSI (safety limit)</div>
            <input className="input" type="number" min="10" max="200" step="5"
              value={maxPsi} onChange={e=>setMaxPsi(parseFloat(e.target.value))}/>
          </div>
          <div>
            <div style={{fontSize:11,color:'var(--color-text-tertiary)'}}>IMU pitch offset (°)</div>
            <input className="input" type="number" step="0.1"
              value={imuOffset} onChange={e=>setImuOffset(parseFloat(e.target.value))}/>
          </div>
          <div>
            <div style={{fontSize:11,color:'var(--color-text-tertiary)'}}>Heading offset (°)</div>
            <input className="input" type="number" step="0.1"
              value={headingOffset} onChange={e=>setHeadingOffset(parseFloat(e.target.value))}/>
          </div>
          <div>
            <div style={{fontSize:11,color:'var(--color-text-tertiary)'}}>
              Efficiency <span style={{fontStyle:'italic'}}>— calibrated 0.26</span>
            </div>
            <input className="input" type="number" min="0.05" max="1.0" step="0.01"
              value={efficiency} onChange={e=>setEfficiency(parseFloat(e.target.value))}/>
          </div>
        </div>

        {/* PSI reference table */}
        <div style={{padding:'8px 12px',borderRadius:8,marginBottom:10,
          background:'var(--color-background-primary)',border:'1px solid var(--color-border-tertiary)',
          fontSize:12,color:'var(--color-text-secondary)'}}>
          📊 Reference (1kg balloon, eff=0.26): 50m→31PSI | 80m→50PSI | 100m→62PSI | 125m→78PSI | 150m→93PSI | 200m→124PSI
        </div>

        <button className="btn" style={{width:'100%',padding:'12px 0',fontWeight:700,fontSize:15,marginBottom:10}}
          onClick={calculate}>
          🎯 Calculate & Aim
        </button>

        {balError && (
          <div style={{padding:'10px 14px',borderRadius:8,marginBottom:10,
            background:'rgba(229,57,53,.1)',border:'1px solid rgba(229,57,53,.3)',
            color:'#e53935',fontSize:13}}>{balError}</div>
        )}

        {balResult && (
          <>
            {balResult.usingPlanning && (
              <div style={{padding:'10px 14px',borderRadius:8,marginBottom:10,
                background:'rgba(255,152,0,.1)',border:'1px solid rgba(255,152,0,.3)',
                fontSize:13,color:'#ff9800'}}>
                📋 Planning mode — pressurize tank to exactly <strong>{balResult.psi} PSI</strong> before firing
              </div>
            )}
            <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8,marginBottom:12}}>
              {[
                {label:'Distance',   value:`${balResult.dist} m`},
                {label:'Bearing',    value:`${balResult.bearing}°`},
                {label:'Muzzle v0',  value:`${balResult.v0} m/s`},
                {label:'Pitch',      value:`${balResult.pitch}°`,  hi:true},
                {label:'Flight',     value:`${balResult.tof} s`},
                {label:'Wind',       value:`${balResult.wind} m/s`},
                {label:'PSI used',   value:`${balResult.psi} PSI`, hi:true},
              ].map(({label,value,hi})=>(
                <div key={label} style={{background:'var(--color-background-primary)',borderRadius:8,
                  padding:'8px 10px',border:hi?'1px solid #ff9800':'1px solid var(--color-border-tertiary)'}}>
                  <div style={{fontSize:10,color:'var(--color-text-tertiary)'}}>{label}</div>
                  <div style={{fontSize:16,fontWeight:600,color:hi?'#ff9800':undefined}}>{value}</div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* Phone calibration */}
        <div style={{padding:'12px 14px',borderRadius:8,
          background:'var(--color-background-primary)',border:'1px solid var(--color-border-tertiary)'}}>
          <div style={{fontWeight:500,fontSize:12,marginBottom:10,color:'var(--color-text-secondary)'}}>
            📱 Phone Calibration — tape phone to barrel
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:8}}>
            <div>
              <div style={{fontSize:11,color:'var(--color-text-tertiary)',marginBottom:4}}>Phone compass (°)</div>
              <div style={{display:'flex',gap:6}}>
                <input className="input" type="number" step="0.1" placeholder="e.g. 245.0"
                  value={phoneHeading} onChange={e=>setPhoneHeading(e.target.value)} style={{flex:1}}/>
                <button className="btn" onClick={calibrateHeading}>Set North</button>
              </div>
              <div style={{fontSize:10,color:'var(--color-text-tertiary)',marginTop:4}}>
                IMU raw: {imuState?.heading!=null?imuState.heading.toFixed(1)+'°':'--'} → corrected: {currentHdg!=null?currentHdg.toFixed(1)+'°':'--'}
              </div>
            </div>
            <div>
              <div style={{fontSize:11,color:'var(--color-text-tertiary)',marginBottom:4}}>Phone level (°)</div>
              <div style={{display:'flex',gap:6}}>
                <input className="input" type="number" step="0.1" placeholder="e.g. 0.0"
                  value={phonePitch} onChange={e=>setPhonePitch(e.target.value)} style={{flex:1}}/>
                <button className="btn" onClick={calibratePitch}>Set Level</button>
              </div>
              <div style={{fontSize:10,color:'var(--color-text-tertiary)',marginTop:4}}>
                IMU raw: {imuState?.pitch!=null?imuState.pitch.toFixed(1)+'°':'--'} → corrected: {currentElev}°
              </div>
            </div>
          </div>
          {calMsg && (
            <div style={{fontSize:12,padding:'6px 10px',borderRadius:6,
              background:calMsg.startsWith('✓')?'rgba(76,175,80,.1)':'rgba(229,57,53,.1)',
              color:calMsg.startsWith('✓')?'#4caf50':'#e53935',
              border:calMsg.startsWith('✓')?'1px solid rgba(76,175,80,.3)':'1px solid rgba(229,57,53,.3)'}}>
              {calMsg}
            </div>
          )}
        </div>
      </div>

      {/* ── Phase 1: Aim ── */}
      {balResult && (
        <div style={{padding:14,borderRadius:10,marginBottom:10,
          background:'var(--color-background-secondary)',
          border:aimStatus==='ON_TARGET'?'1px solid #4caf50':'1px solid var(--color-border-tertiary)'}}>
          <div style={{fontWeight:500,marginBottom:10}}>Phase 1 — Aim Cannon</div>

          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:12,marginBottom:12,
            padding:'12px 14px',borderRadius:8,background:'var(--color-background-primary)'}}>
            <div style={{textAlign:'center'}}>
              <div style={{fontSize:11,color:'var(--color-text-tertiary)'}}>TARGET BEARING</div>
              <div style={{fontSize:38,fontWeight:700,color:'#ff9800'}}>{balResult.bearing}°</div>
              <div style={{fontSize:11,color:'var(--color-text-secondary)'}}>point compass here</div>
            </div>
            <div style={{textAlign:'center'}}>
              <div style={{fontSize:11,color:'var(--color-text-tertiary)'}}>TARGET PITCH</div>
              <div style={{fontSize:38,fontWeight:700,color:'#ff9800'}}>{balResult.pitch}°</div>
              <div style={{fontSize:11,color:'var(--color-text-secondary)'}}>tilt cannon up</div>
            </div>
            <div style={{textAlign:'center'}}>
              <div style={{fontSize:11,color:'var(--color-text-tertiary)'}}>IMU STATUS</div>
              <div style={{fontSize:16,fontWeight:700,marginTop:8,
                color:aimAligned?'#4caf50':aimDiff!=null&&aimDiff<10?'#ff9800':'#e53935'}}>
                {aimAligned?'✅ ALIGNED':aimDiff!=null?`${aimDiff.toFixed(1)}° off`:'--'}
              </div>
              <div style={{fontSize:11,color:'var(--color-text-secondary)'}}>
                {currentHdg!=null?currentHdg.toFixed(1)+'°':'--'} / {currentElev}°
              </div>
            </div>
          </div>

          <div style={{display:'flex',gap:10}}>
            <button className="btn"
              onClick={handleAutoAim}
              disabled={aimBusy||aimStatus==='SEEKING'}
              style={{flex:1,padding:'12px 0',fontWeight:700,
                background:aimStatus==='ON_TARGET'?'rgba(76,175,80,.2)':'rgba(255,152,0,.15)',
                color:aimStatus==='ON_TARGET'?'#4caf50':'#ff9800',
                border:aimStatus==='ON_TARGET'?'1px solid #4caf50':'1px solid #ff9800'}}>
              {aimStatus==='ON_TARGET'?'✅ ON TARGET':aimStatus==='SEEKING'?'⟳ Moving...':'🎯 AUTO-AIM MOTORS'}
            </button>
            {(aimStatus==='SEEKING'||aimStatus==='ON_TARGET') && (
              <button className="btn ghost" onClick={handleStopAim}>STOP</button>
            )}
          </div>

          {aimStatus==='SEEKING' && (
            <div style={{marginTop:10,padding:'8px 12px',borderRadius:8,fontSize:13,
              background:'rgba(255,152,0,.08)',border:'1px solid rgba(255,152,0,.3)',color:'#ff9800'}}>
              ⟳ Motors moving to {balResult.bearing}° bearing / {balResult.pitch}° pitch...
            </div>
          )}
          {aimStatus==='ON_TARGET' && (
            <div style={{marginTop:10,padding:'12px 16px',borderRadius:8,fontSize:14,
              fontWeight:700,color:'#4caf50',textAlign:'center',
              background:'rgba(76,175,80,.1)',border:'1px solid rgba(76,175,80,.4)'}}>
              ✅ CANNON ON TARGET — You can now pressurize the system
            </div>
          )}
        </div>
      )}

      {/* ── Phase 2: Pressurize & Fire ── */}
      {balResult && aimStatus==='ON_TARGET' && (
        <div style={{padding:14,borderRadius:10,marginBottom:10,
          background:'var(--color-background-secondary)',
          border:fireStatus==='FIRED'?'1px solid #4caf50':fireStatus==='ARMED'?'1px solid #ff9800':'1px solid var(--color-border-tertiary)'}}>
          <div style={{fontWeight:500,marginBottom:10}}>Phase 2 — Pressurize & Auto-Fire</div>

          {/* PSI gauge */}
          <div style={{marginBottom:12}}>
            <div style={{display:'flex',justifyContent:'space-between',marginBottom:6}}>
              <span style={{fontSize:14}}>Current: <strong>{(firePsi??pressure?.psi??0).toFixed(1)} PSI</strong></span>
              <span style={{fontSize:14}}>Target: <strong style={{color:'#ff9800'}}>{balResult.psi} PSI</strong></span>
            </div>
            <div style={{height:20,borderRadius:10,background:'#2b2b2b',overflow:'hidden'}}>
              <div style={{
                width:`${Math.min(100,((firePsi??pressure?.psi??0)/parseFloat(balResult.psi))*100)}%`,
                height:'100%',
                background:fireStatus==='FIRED'?'#4caf50':'linear-gradient(90deg,#4caf50,#ff9900,#ff3d00)',
                borderRadius:10,transition:'width .3s'
              }}/>
            </div>
            <div style={{display:'flex',justifyContent:'space-between',marginTop:4}}>
              <span style={{fontSize:11,color:'var(--color-text-tertiary)'}}>0 PSI</span>
              <span style={{fontSize:13,fontWeight:600,
                color:fireStatus==='FIRED'?'#4caf50':fireStatus==='ARMED'?'#ff9800':'#888'}}>
                {fireStatus}
              </span>
              <span style={{fontSize:11,color:'var(--color-text-tertiary)'}}>{balResult.psi} PSI</span>
            </div>
          </div>

          {/* PSI warning */}
          {(firePsi??pressure?.psi??0) > maxPsi * 0.9 && fireStatus!=='FIRED' && (
            <div style={{padding:'10px 14px',borderRadius:8,marginBottom:10,
              background:'rgba(229,57,53,.15)',border:'1px solid rgba(229,57,53,.5)',
              fontSize:13,fontWeight:700,color:'#e53935'}}>
              ⚠️ APPROACHING MAX PSI ({maxPsi} PSI) — VENT IF NO SHOT!
            </div>
          )}

          {fireStatus==='FIRED' ? (
            <div style={{textAlign:'center',padding:'12px 0'}}>
              <div style={{fontSize:24,fontWeight:700,color:'#4caf50',marginBottom:10}}>🎯 FIRED!</div>
              <div style={{display:'flex',gap:10,justifyContent:'center'}}>
                <button className="btn ghost" onClick={handleDisarm}>Reset</button>
                <button className="btn" onClick={handleVent}
                  style={{background:'rgba(0,120,255,.12)',color:'#0b57d0',border:'1px solid rgba(0,120,255,.4)'}}>
                  VENT AIR
                </button>
              </div>
            </div>
          ) : (
            <>
              <div style={{display:'flex',gap:10,flexWrap:'wrap',marginBottom:8}}>
                <button className="btn"
                  onClick={handleArm} disabled={fireArmed}
                  style={{flex:1,padding:'12px 0',fontWeight:700,
                    background:'rgba(176,0,32,.15)',color:'#b00020',border:'1px solid rgba(176,0,32,.4)'}}>
                  {fireArmed?'🔴 ARMED — Watching PSI...':'ARM AUTO-FIRE'}
                </button>
                {fireArmed && (
                  <button className="btn ghost" onClick={handleDisarm}>DISARM</button>
                )}
              </div>
              {fireArmed && (
                <div style={{padding:'10px 14px',borderRadius:8,marginBottom:8,
                  background:'rgba(255,152,0,.1)',border:'1px solid rgba(255,152,0,.3)',
                  fontSize:13,color:'#ff9800'}}>
                  🔴 Turn on compressor — will fire automatically at {balResult.psi} PSI
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── Vent Air ── */}
      <div style={{padding:14,borderRadius:10,background:'var(--color-background-secondary)',
        border:'1px solid var(--color-border-tertiary)'}}>
        <div style={{fontWeight:500,marginBottom:10}}>Air Release</div>
        <div style={{display:'flex',gap:12,alignItems:'center'}}>
          <button className="btn"
            onClick={handleVent}
            style={{padding:'12px 28px',fontWeight:700,fontSize:15,
              background:'rgba(0,120,255,.12)',color:'#0b57d0',
              border:'1px solid rgba(0,120,255,.4)'}}>
            VENT AIR (GPIO24)
          </button>
          <div style={{fontSize:13,color:'var(--color-text-secondary)'}}>
            Press anytime to safely release pressure
          </div>
        </div>
      </div>

    </div>
  )
}
