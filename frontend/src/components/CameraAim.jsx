// frontend/src/components/CameraAim.jsx
import React, { useEffect, useRef, useState } from 'react'

function toRad(d){ return d*Math.PI/180 }
function toDeg(r){ return r*180/Math.PI }

// Great-circle destination: origin (lat,lon deg), bearing deg (0=N), distance meters
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

export default function CameraAim({
  onCancel,
  onConfirm,              // receives {lat, lon}
  mortarPos,              // {lat, lon} origin; if absent, we use geolocation
  defaultDistanceMeters=150
}) {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const [err, setErr] = useState(null)

  const [geo, setGeo] = useState(null)        // {lat, lon, accuracy}
  const [heading, setHeading] = useState(null) // deg (0=N). Compass-based.
  const [pitch, setPitch] = useState(null)     // deg (for info)
  const [fov, setFov] = useState(60)          // camera horizontal FOV (deg)
  const [distance, setDistance] = useState(defaultDistanceMeters)

  const [aimPixel, setAimPixel] = useState(null) // {x,y} clicked in video
  const [vSize, setVSize] = useState({ w:0, h:0 })
  const [busy, setBusy] = useState(false)

  // Start camera
  useEffect(()=>{
    (async ()=>{
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:'environment' }, audio:false })
        streamRef.current = s
        if (videoRef.current) {
          videoRef.current.srcObject = s
          await videoRef.current.play().catch(()=>{})
        }
      } catch(e) {
        setErr('Camera blocked or unavailable: ' + e.message)
      }
    })()
    return ()=>{ streamRef.current?.getTracks().forEach(t=>t.stop()) }
  }, [])

  // Get origin (geolocation) unless provided
  useEffect(()=>{
    if (mortarPos?.lat && mortarPos?.lon) { setGeo({ ...mortarPos, accuracy: 0 }); return }
    if (!('geolocation' in navigator)) { setErr('Geolocation not supported'); return }
    const id = navigator.geolocation.watchPosition(pos=>{
      setGeo({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy })
    }, e=> setErr('Geolocation error: ' + e.message), { enableHighAccuracy:true, maximumAge:2000, timeout:7000 })
    return ()=> navigator.geolocation.clearWatch(id)
  }, [mortarPos])

  // Device orientation (compass). iOS needs a permission request.
  useEffect(()=>{
    const handler = e => {
      const a = e.alpha, b = e.beta
      if (a!=null) {
        // alpha is often 0..360; we invert to approx compass north=0 clockwise
        const comp = (360 - a + 360) % 360
        setHeading(comp)
      }
      if (b!=null) setPitch(b)
    }
    (async ()=>{
      try {
        if (typeof DeviceOrientationEvent !== 'undefined' &&
            typeof DeviceOrientationEvent.requestPermission === 'function') {
          const r = await DeviceOrientationEvent.requestPermission().catch(()=> 'denied')
          if (r !== 'granted') return
        }
      } catch {}
      window.addEventListener('deviceorientation', handler, true)
    })()
    return ()=> window.removeEventListener('deviceorientation', handler, true)
  }, [])

  // Track video size for pixel→angle mapping
  useEffect(()=>{
    const el = videoRef.current; if (!el) return
    const measure = ()=> setVSize({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure); ro.observe(el)
    return ()=> ro.disconnect()
  }, [videoRef.current])

  function onVideoClick(e){
    const rect = videoRef.current.getBoundingClientRect()
    setAimPixel({ x: e.clientX - rect.left, y: e.clientY - rect.top })
  }

  // Bearing = heading + horizontal pixel offset mapped by FOV
  function computeBearing() {
    if (heading==null) return null
    const cx = vSize.w/2
    const aim = aimPixel || { x: cx, y: vSize.h/2 }
    const dx = aim.x - cx
    const focalPx = (vSize.w/2) / Math.tan((fov*Math.PI/180)/2)
    const offsetRad = Math.atan2(dx, focalPx)
    const offsetDeg = offsetRad * 180/Math.PI
    return (heading + offsetDeg + 360) % 360
  }

  function candidate() {
    const origin = geo || mortarPos
    if (!origin) return null
    const brg = computeBearing()
    if (brg==null) return null
    return destinationLatLon(origin.lat, origin.lon, brg, Number(distance||defaultDistanceMeters))
  }

  async function confirm() {
    const cand = candidate()
    if (!cand) { alert('Missing heading/position. Allow permissions and try again.'); return }
    setBusy(true)
    const brg = computeBearing()
    const ok = window.confirm(
`Confirm target?
Lat: ${cand.lat.toFixed(6)}
Lon: ${cand.lon.toFixed(6)}
Bearing: ${brg?.toFixed(1)}°
Distance: ${distance} m`)
    setBusy(false)
    if (ok) onConfirm?.(cand)
  }

  return (
    <div className="card" style={{background:'var(--card)', height:'80vh', display:'flex', flexDirection:'column'}}>
      <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8}}>
        <h2 style={{margin:0}}>Camera Aim</h2>
        <button className="btn ghost" onClick={onCancel}>Close</button>
      </div>

      <div style={{position:'relative', flex:1, background:'#000', borderRadius:12, overflow:'hidden'}}>
        <video
          ref={videoRef}
          playsInline muted
          style={{width:'100%', height:'100%', objectFit:'cover'}}
          onClick={onVideoClick}
        />
        {/* crosshair */}
        <div style={{
          position:'absolute', left:'50%', top:'50%', transform:'translate(-50%,-50%)',
          width:48, height:48, border:'2px solid rgba(255,255,255,.9)', borderRadius:6, pointerEvents:'none'
        }}/>
        {/* chosen aim dot */}
        {aimPixel && (
          <div style={{
            position:'absolute', left:aimPixel.x, top:aimPixel.y, transform:'translate(-50%,-50%)',
            width:12, height:12, background:'#ff0', borderRadius:999, boxShadow:'0 0 6px #000', pointerEvents:'none'
          }}/>
        )}
      </div>

      {err && <p style={{color:'var(--danger)', marginTop:8}}>{err}</p>}

      <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginTop:12}}>
        <div>
          <label className="label">Distance (meters)</label>
          <input className="input" type="number" value={distance} onChange={e=>setDistance(e.target.value)} />
          <small className="muted">Use a laser rangefinder for accuracy.</small>
        </div>
        <div>
          <label className="label">Camera Horizontal FOV (deg)</label>
          <input className="input" type="number" value={fov} onChange={e=>setFov(Number(e.target.value))} />
          <small className="muted">Typical phone rear cam ~60–75°</small>
        </div>
      </div>

      <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginTop:12}}>
        <div>
          <div className="label">Origin (mortar)</div>
          <div style={{fontWeight:700}}>
            {geo ? `${geo.lat?.toFixed(6)}, ${geo.lon?.toFixed(6)} (±${Math.round(geo.accuracy||0)}m)` : '—'}
          </div>
        </div>
        <div>
          <div className="label">Device</div>
          <div className="kpi-sub">Heading: {heading!=null? `${heading.toFixed(1)}°`:'—'} · Pitch: {pitch!=null? `${pitch.toFixed(1)}°`:'—'}</div>
        </div>
      </div>

      <div style={{display:'flex', gap:8, marginTop:12}}>
        <button className="btn" disabled={busy} onClick={confirm}>Confirm Target</button>
        <button className="btn ghost" onClick={()=>{ setAimPixel(null); setDistance(defaultDistanceMeters) }}>Reset</button>
      </div>
    </div>
  )
}
