// frontend/src/pages/Map.jsx
import React, { useEffect, useMemo, useRef, useState } from 'react'
import axios from 'axios'
import { MapContainer, TileLayer, Marker, Polyline, Polygon, useMapEvents, useMap } from 'react-leaflet'
import L from 'leaflet'
import CameraAim from '../components/CameraAim'

// ---- ENV ----
const API = import.meta.env.VITE_API_URL || 'http://localhost:8080'
const LAUNCH_KEY = import.meta.env.VITE_LAUNCH_KEY || ''

// ---- Helpers ----
function fmtLatLon(lat, lon) {
  if (lat == null || lon == null) return '—'
  return `${lat.toFixed(6)}, ${lon.toFixed(6)}`
}
function toDMS(lat, lon) {
  if (lat == null || lon == null) return '—'
  const conv = (v, isLat) => {
    const abs = Math.abs(v)
    const deg = Math.floor(abs)
    const min = Math.floor((abs - deg) * 60)
    const sec = ((abs - deg) * 60 - min) * 60
    const compass = isLat ? (v >= 0 ? 'N' : 'S') : (v >= 0 ? 'E' : 'W')
    return `${deg}°${min}'${sec.toFixed(1)}" ${compass}`
  }
  return `${conv(lat, true)}  ${conv(lon, false)}`
}
function haversineMeters(a, b) {
  const R = 6371000, toR = x => x * Math.PI / 180
  const dLat = toR(b[0] - a[0]), dLon = toR(b[1] - a[1])
  const lat1 = toR(a[0]), lat2 = toR(b[0])
  const h = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2
  return 2*R*Math.asin(Math.sqrt(h))
}
function bearingDeg(a,b){
  const toR=x=>x*Math.PI/180, toD=x=>x*180/Math.PI
  const lat1=toR(a[0]), lat2=toR(b[0]), dLon=toR(b[1]-a[1])
  const y=Math.sin(dLon)*Math.cos(lat2)
  const x=Math.cos(lat1)*Math.sin(lat2)-Math.sin(lat1)*Math.cos(lat2)*Math.cos(dLon)
  return (toD(Math.atan2(y,x))+360)%360
}
function toRad(d){return d*Math.PI/180}
function toDeg(r){return r*180/Math.PI}
function destinationLatLon(lat, lon, bearingDeg, distanceMeters) {
  const R = 6371000
  const δ = distanceMeters / R
  const θ = toRad(bearingDeg)
  const φ1 = toRad(lat)
  const λ1 = toRad(lon)
  const φ2 = Math.asin(Math.sin(φ1)*Math.cos(δ) + Math.cos(φ1)*Math.sin(δ)*Math.cos(θ))
  const λ2 = λ1 + Math.atan2(Math.sin(θ)*Math.sin(δ)*Math.cos(φ1),
                              Math.cos(δ) - Math.sin(φ1)*Math.sin(φ2))
  return { lat: toDeg(φ2), lon: ((toDeg(λ2)+540)%360)-180 }
}

// Build a sector polygon for a given center, heading, half-angle and range (meters)
function sectorPolygon(center, headingDeg, halfAngleDeg, rangeMeters, steps=24) {
  if (!center) return null
  const { lat, lon } = center
  const coords = [[lat, lon]] // start at center
  const start = headingDeg - halfAngleDeg
  const end = headingDeg + halfAngleDeg
  const step = (end - start) / steps
  for (let i = 0; i <= steps; i++) {
    const brg = start + i * step
    const p = destinationLatLon(lat, lon, brg, rangeMeters)
    coords.push([p.lat, p.lon])
  }
  coords.push([lat, lon]) // close back to center
  return coords
}

// ---- Leaflet icons (using DivIcon for colored markers without image files) ----
const mortarIcon = new L.DivIcon({
  className: 'custom-marker',
  html: '<div style="background-color:#4CAF50;width:24px;height:24px;border-radius:50%;border:3px solid white;box-shadow:0 2px 4px rgba(0,0,0,0.3);"></div>',
  iconSize: [24, 24],
  iconAnchor: [12, 12]
})
const targetIcon = new L.DivIcon({
  className: 'custom-marker',
  html: '<div style="background-color:#F44336;width:24px;height:24px;border-radius:50%;border:3px solid white;box-shadow:0 2px 4px rgba(0,0,0,0.3);"></div>',
  iconSize: [24, 24],
  iconAnchor: [12, 12]
})

// ---- Small subcomponents ----
function ClickToSetTarget({ setTarget }) {
  useMapEvents({ click(e) { setTarget({ lat: e.latlng.lat, lon: e.latlng.lng }) } })
  return null
}
function Recenter({ center }) {
  const map = useMap()
  useEffect(()=>{ if(center) map.setView(center) }, [center, map])
  return null
}

// =================== Main Page ===================
export default function MapPage() {
  const [mortar, setMortar] = useState(null)   // launcher position
  const [target, setTarget] = useState(null)   // impact position
  const [dms, setDms] = useState(false)
  const [autoCenter, setAutoCenter] = useState(true)
  const [cameraMode, setCameraMode] = useState(false)
  const [holdProgress, setHoldProgress] = useState(0)
  const holdTimer = useRef(null)
  const holdStart = useRef(null)

  // ---- Facing / Sector config ----
  const TOTAL_SPREAD_DEG = 25         // 25° total (±12.5°)
  const HALF_SPREAD_DEG = TOTAL_SPREAD_DEG / 2
  const SECTOR_RANGE_M = 500          // visible range of sector on map (tweak as you like)

  // TODO(compass): Replace this derived heading with live compass heading when available.
  // For now:
  // - If a target exists, use bearing(mortar -> target)
  // - Else default to 0° (north)
  const headingDeg = useMemo(()=>{
    if (mortar && target) return bearingDeg([mortar.lat, mortar.lon],[target.lat, target.lon])
    return 0
  }, [mortar, target])

  // Build sector polygon points (light red wedge)
  const sector = useMemo(()=>{
    if (!mortar) return null
    return sectorPolygon(mortar, headingDeg, HALF_SPREAD_DEG, SECTOR_RANGE_M)
  }, [mortar, headingDeg])

  // ---- Derived values ----
  const center = mortar ? [mortar.lat, mortar.lon] : [45.5017, -73.5673] // Montréal default
  const path = useMemo(()=> (mortar && target) ? [[mortar.lat, mortar.lon], [target.lat, target.lon]] : null, [mortar, target])
  const dist = useMemo(()=> (mortar && target) ? haversineMeters([mortar.lat,mortar.lon],[target.lat,target.lon]) : null, [mortar,target])

  // ---- Actions ----
  function setMortarByDeviceGeolocation(){
    if (!navigator.geolocation) { alert('Geolocation not supported'); return }
    navigator.geolocation.getCurrentPosition(pos=>{
      const { latitude: lat, longitude: lon } = pos.coords
      setMortar({ lat, lon })
    }, err=> alert('Unable to get device position: ' + err.message), { enableHighAccuracy:true, timeout:10000 })
  }

  function copyCoords(obj){
    if (!obj) return
    const text = `${obj.lat.toFixed(6)}, ${obj.lon.toFixed(6)}`
    navigator.clipboard?.writeText(text).then(()=>alert('Copied: '+text)).catch(()=>alert('Copy failed'))
  }

  // ---- Arm & Launch flow ----
  async function armLauncher() {
    if (!LAUNCH_KEY) { alert('Missing VITE_LAUNCH_KEY'); return false }
    try {
      await axios.post(`${API}/api/arm`, {}, { headers: { 'x-api-key': LAUNCH_KEY } })
      return true
    } catch (e) {
      alert('Arm failed: ' + (e.response?.data?.error || e.message))
      return false
    }
  }
  async function startHold() {
    if (!mortar || !target) { alert('Set both mortar and target coordinates first.'); return }
    const armed = await armLauncher()
    if (!armed) return

    setHoldProgress(0)
    holdStart.current = Date.now()
    holdTimer.current = setInterval(async ()=>{
      const elapsed = Date.now() - holdStart.current
      const progress = Math.min(1, elapsed / 2000)
      setHoldProgress(progress)
      if (progress >= 1) {
        clearInterval(holdTimer.current)
        setHoldProgress(0)
        const ok = window.confirm('FINAL CONFIRM: Fire projectile?')
        if (!ok) return
        try {
          const r = await axios.post(`${API}/api/launch`,
            { mortar, target, meta: { client: 'web', at: new Date().toISOString() } },
            { headers: { 'x-api-key': LAUNCH_KEY } }
          )
          alert('Launch accepted at ' + r.data.acceptedAt)
        } catch (e) {
          alert('Launch failed: ' + (e.response?.data?.error || e.message))
        }
      }
    }, 80)
  }
  function cancelHold() {
    clearInterval(holdTimer.current)
    setHoldProgress(0)
  }

  return (
    <div className="card">
      {/* Top controls */}
      <div style={{display:'flex', gap:8, flexWrap:'wrap', marginBottom:8}}>
        <button className="btn" onClick={()=>setDms(v=>!v)}>{dms? 'DMS' : 'Decimal'}</button>
        <button className="btn" onClick={()=>setAutoCenter(v=>!v)}>{autoCenter? 'Auto-center ON' : 'Auto-center OFF'}</button>
        <button className="btn ghost" onClick={()=>{ setMortar(null); setTarget(null) }}>Clear All</button>
        <div style={{marginLeft:'auto', display:'flex', gap:8}}>
          <button className="btn" onClick={()=>setCameraMode(true)}>Use Camera to Aim</button>
          <button className="btn" onClick={setMortarByDeviceGeolocation}>Use device for Mortar</button>
        </div>
      </div>

      {/* Map */}
      <div style={{height:'70vh'}}>
        <MapContainer center={center} zoom={16} style={{height:'100%', width:'100%'}} minZoom={2} maxZoom={19}>
          <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OpenStreetMap contributors" maxZoom={19} />
          {autoCenter && <Recenter center={center}/>}
          <ClickToSetTarget setTarget={setTarget} />

          {/* Mortar marker (draggable) */}
          {mortar && (
            <Marker
              position={[mortar.lat, mortar.lon]}
              draggable
              eventHandlers={{ dragend: (e) => {
                const p = e.target.getLatLng()
                setMortar({ lat: p.lat, lon: p.lng })
              }}}
              icon={mortarIcon}
            />
          )}

          {/* Target marker (draggable) */}
          {target && (
            <Marker
              position={[target.lat, target.lon]}
              draggable
              eventHandlers={{ dragend: (e) => {
                const p = e.target.getLatLng()
                setTarget({ lat: p.lat, lon: p.lng })
              }}}
              icon={targetIcon}
            />
          )}

          {/* Line */}
          {path && <Polyline positions={path} color="#ffcc00" weight={3} dashArray="6 6" />}

          {/* Facing sector (light red) */}
          {sector && (
            <Polygon
              positions={sector}
              pathOptions={{ color: '#ff6666', weight: 1, fillColor: '#ff6666', fillOpacity: 0.2 }}
            />
          )}
        </MapContainer>
      </div>

      {/* Readouts */}
      <div style={{display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12, marginTop:12}}>
        <div className="card" style={{padding:12}}>
          <div className="label">Mortar (launcher)</div>
          <div style={{fontWeight:700}}>{mortar ? (dms ? toDMS(mortar.lat, mortar.lon) : fmtLatLon(mortar.lat, mortar.lon)) : '—'}</div>
          <div style={{marginTop:8, display:'flex', gap:8}}>
            <button className="btn ghost" onClick={()=>copyCoords(mortar)}>Copy</button>
            <button className="btn ghost" onClick={()=>setMortar(null)}>Clear</button>
          </div>
        </div>

        <div className="card" style={{padding:12}}>
          <div className="label">Target</div>
          <div style={{fontWeight:700}}>{target ? (dms ? toDMS(target.lat, target.lon) : fmtLatLon(target.lat, target.lon)) : '—'}</div>
          <div style={{marginTop:8, display:'flex', gap:8}}>
            <button className="btn ghost" onClick={()=>copyCoords(target)}>Copy</button>
            <button className="btn ghost" onClick={()=>setTarget(null)}>Clear</button>
          </div>
          <hr style={{border:'none', borderTop:'1px solid var(--border)', margin:'12px 0'}}/>
          <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:8}}>
            <div><div className="kpi">{dist ? dist.toFixed(1)+' m' : '—'}</div><div className="kpi-sub">Distance</div></div>
            <div><div className="kpi">{(mortar&&target)? bearingDeg([mortar.lat,mortar.lon],[target.lat,target.lon]).toFixed(1)+'°' : '—'}</div><div className="kpi-sub">Bearing</div></div>
          </div>
        </div>

        <div className="card" style={{padding:12}}>
          <div className="label">Arm & Fire</div>
          <div style={{display:'flex', gap:12, alignItems:'center', marginTop:8}}>
            <div style={{flex:1}}>
              <div style={{height:14, borderRadius:8, background:'#2b2b2b'}}>
                <div style={{width: `${holdProgress*100}%`, height:'100%', background:'linear-gradient(90deg,#ff9900,#ff3d00)', borderRadius:8}} />
              </div>
              <div className="kpi-sub" style={{marginTop:6}}>Hold 2 seconds to arm, then confirm to fire.</div>
            </div>
            <button
              onMouseDown={startHold}
              onTouchStart={startHold}
              onMouseUp={cancelHold}
              onMouseLeave={cancelHold}
              onTouchEnd={cancelHold}
              className="btn"
              style={{padding:'12px 16px'}}
              title="Hold 2s to fire"
            >
              HOLD & FIRE
            </button>
          </div>
        </div>
      </div>

      {/* Camera overlay */}
      {cameraMode && (
        <div style={{
          position:'fixed', inset:12, zIndex:9999,
          background:'rgba(0,0,0,.6)', backdropFilter:'blur(2px)',
          display:'grid', placeItems:'center'
        }}>
          <div style={{maxWidth:1000, width:'100%'}}>
            <CameraAim
              mortarPos={mortar /* if null, falls back to device GPS */}
              defaultDistanceMeters={150}
              onCancel={()=>setCameraMode(false)}
              onConfirm={(coords)=>{ setTarget(coords); setCameraMode(false)}}
            />
          </div>
        </div>
      )}
    </div>
  )
}
