import React, { useEffect, useRef, useState } from 'react'

const API = import.meta.env.VITE_API_BASE_URL || import.meta.env.VITE_API_URL || 'http://localhost:8080'

function angleDiff(a, b) {
  let d = a - b
  while (d >  180) d -= 360
  while (d < -180) d += 360
  return d
}

function JogBtn({ label, axis, dir, speed, disabled, onJog, onStop, color='#ff9800' }) {
  const interval = useRef(null)
  const start = async (e) => {
    e.preventDefault()
    if (disabled) return
    await onJog(axis, dir, speed)
    interval.current = setInterval(() => onJog(axis, dir, speed), 200)
  }
  const stop = async () => { clearInterval(interval.current); await onStop(axis) }
  return (
    <button onMouseDown={start} onTouchStart={start}
      onMouseUp={stop} onMouseLeave={stop} onTouchEnd={stop}
      disabled={disabled}
      style={{ padding:'14px 24px', borderRadius:10, fontWeight:700, fontSize:16,
        background:`rgba(${color==='#ff9800'?'255,152,0':'33,150,243'},.15)`,
        color, border:`1px solid ${color}`,
        cursor:disabled?'not-allowed':'pointer', opacity:disabled?0.4:1,
        userSelect:'none', WebkitUserSelect:'none' }}>
      {label}
    </button>
  )
}

export default function CalibrationPage() {
  const [imu,           setImu]           = useState(null)
  const [enabled,       setEnabled]       = useState({ yaw:false, pitch:false })
  const [yawSpeed,      setYawSpeed]      = useState(0.15)
  const [pitchSpeed,    setPitchSpeed]    = useState(0.15)
  const [step,          setStep]          = useState(1)
  const [msg,           setMsg]           = useState('')
  const [error,         setError]         = useState('')
  const [saving,        setSaving]        = useState(false)
  const [history,       setHistory]       = useState([])

  // Calibration values — always start fresh on boot
  const [yawLeft,       setYawLeft]       = useState(null)
  const [yawRight,      setYawRight]      = useState(null)
  const [yawCenter,     setYawCenter]     = useState(null)
  const [pitchMin,      setPitchMin]      = useState(null)
  const [pitchMax,      setPitchMax]      = useState(null)
  const [pitchCenter,   setPitchCenter]   = useState(null)
  const [centerHeading, setCenterHeading] = useState(null)  // IMU heading at center
  const [centerPitch,   setCenterPitch]   = useState(null)  // IMU pitch at center

  // IMU offsets — loaded from saved .env but recalibrated each boot
  const [headingOffset, setHeadingOffset] = useState(0)
  const [pitchOffset,   setPitchOffset]   = useState(0)
  const [efficiency,    setEfficiency]    = useState(0.26)

  // Phone calibration
  const [phoneHeading,  setPhoneHeading]  = useState('')
  const [phonePitch,    setPhonePitch]    = useState('')
  const [calMsg,        setCalMsg]        = useState('')

  // Checklist — resets every boot
  const [checks, setChecks] = useState({
    centered:  false,
    northSet:  false,
    levelSet:  false,
    yawDone:   false,
    pitchDone: false,
  })
  function check(key) { setChecks(c => ({...c, [key]:true})) }
  const allDone = Object.values(checks).every(Boolean)

  // Load saved offsets from .env on mount (NOT limits — those need recalibration)
  useEffect(() => {
    fetch(`${API}/api/calibration/history`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.ok) setHistory(d.history) })
      .catch(() => {})

    fetch(`${API}/api/calibration`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d?.ok) return
        if (d.headingOffset != null) setHeadingOffset(d.headingOffset)
        if (d.pitchOffset   != null) setPitchOffset(d.pitchOffset)
        if (d.efficiency    != null) setEfficiency(d.efficiency)
        setMsg('Previous offsets loaded — but yaw/pitch limits must be re-recorded every boot.')
      }).catch(() => {})
  }, [])

  // Poll IMU
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const r = await fetch(`${API}/api/imu/latest`)
        if (r.ok) {
          const d = await r.json()
          setImu(d)
          // Auto-check IMU calibration
          if (d?.calib?.sys >= 3) check('imuCalib')
        }
      } catch {}
    }, 300)
    return () => clearInterval(id)
  }, [])

  const heading = imu?.heading != null ? (imu.heading + headingOffset + 360) % 360 : null
  const pitch   = imu?.pitch   != null ?  imu.pitch - pitchOffset               : null

  // Motor helpers
  async function enableAxis(axis) {
    try {
      await fetch(`${API}/api/steppers/enable`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({axis}) })
      setEnabled(e => ({...e, [axis]:true})); setError('')
    } catch(e) { setError(`Enable ${axis} failed`) }
  }
  async function disableAxis(axis) {
    try {
      await fetch(`${API}/api/steppers/disable`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({axis}) })
      setEnabled(e => ({...e, [axis]:false}))
    } catch {}
  }
  async function jog(axis, dir, spd) {
    try { await fetch(`${API}/api/steppers/jog`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({axis, dir, speed01:spd}) }) } catch {}
  }
  async function stopAxis(axis) {
    try { await fetch(`${API}/api/steppers/stop`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({axis}) }) } catch {}
  }
  async function stopAll() {
    try { await fetch(`${API}/api/steppers/stopAll`, { method:'POST' }) } catch {}
  }

  // Set center — clear old limits and record fresh home position
  function setCenter() {
    if (heading == null || pitch == null) return setError('No IMU reading')
    // Clear all old location-specific limits
    setYawLeft(null); setYawRight(null)
    setPitchMin(null); setPitchMax(null)
    // Reset steps
    setStep(1)
    // Record new center
    setCenterHeading(parseFloat(heading.toFixed(1)))
    setCenterPitch(parseFloat(pitch.toFixed(1)))
    check('centered')
    setMsg(`✓ Center set at ${heading.toFixed(1)}° / ${pitch.toFixed(1)}° — old limits cleared, record new limits below`)
  }

  // Record yaw limits
  function recordYawLeft() {
    if (heading == null) return setError('No IMU reading')
    setYawLeft(parseFloat(heading.toFixed(1)))
    setMsg(`✓ Yaw LEFT limit: ${heading.toFixed(1)}°`)
  }
  function recordYawRight() {
    if (heading == null) return setError('No IMU reading')
    setYawRight(parseFloat(heading.toFixed(1)))
    setMsg(`✓ Yaw RIGHT limit: ${heading.toFixed(1)}°`)
    check('yawDone')
  }

  // Record pitch limits
  function recordPitchMin() {
    if (pitch == null) return setError('No IMU reading')
    setPitchMin(parseFloat(pitch.toFixed(1)))
    setMsg(`✓ Pitch MIN: ${pitch.toFixed(1)}°`)
  }
  function recordPitchMax() {
    if (pitch == null) return setError('No IMU reading')
    setPitchMax(parseFloat(pitch.toFixed(1)))
    setMsg(`✓ Pitch MAX: ${pitch.toFixed(1)}°`)
    check('pitchDone')
  }

  // Phone calibration
  function calibrateHeading() {
    const phone = parseFloat(phoneHeading)
    if (isNaN(phone)) return setCalMsg('Enter a valid compass reading.')
    if (imu?.heading == null) return setCalMsg('No IMU reading.')
    const offset = ((phone - imu.heading) + 360) % 360
    const norm   = offset > 180 ? offset - 360 : offset
    setHeadingOffset(parseFloat(norm.toFixed(1)))
    setCalMsg(`✓ Heading offset: ${norm.toFixed(1)}° (phone: ${phone}°, IMU raw: ${imu.heading.toFixed(1)}°)`)
    check('northSet')
  }
  function calibratePitch() {
    const phone = parseFloat(phonePitch)
    if (isNaN(phone)) return setCalMsg('Enter a valid level reading.')
    if (imu?.pitch == null) return setCalMsg('No IMU reading.')
    setPitchOffset(parseFloat((imu.pitch - phone).toFixed(1)))
    setCalMsg(`✓ Pitch offset: ${(imu.pitch - phone).toFixed(1)}°`)
    check('levelSet')
  }

  // Save everything to .env
  async function saveCalibration() {
    setSaving(true); setError('')
    // Location-specific limits (yaw/pitch) are overwritten each time
    // Permanent settings (offsets, efficiency) are preserved
    try {
      const r = await fetch(`${API}/api/calibration/save`, {  // also try POST /api/calibration as fallback
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          yawMin: yawLeft, yawMax: yawRight,
          yawCenter: centerHeading,
          pitchMin, pitchMax,
          pitchCenter: centerPitch ?? ((pitchMin+pitchMax)/2),
          headingOffset, pitchOffset, efficiency,
        }),
      })
      const j = await r.json()
      if (j.ok) {
        setMsg('✅ Calibration saved! Go to Map page to shoot.')
        // Refresh history
        fetch(`${API}/api/calibration/history`)
          .then(r=>r.ok?r.json():null)
          .then(d=>{if(d?.ok)setHistory(d.history)})
          .catch(()=>{})
      }
      else setError(j.error || 'Save failed')
    } catch(e) { setError('Save failed: '+e.message) }
    finally { setSaving(false) }
  }

  // Derived
  const yawRange   = yawLeft!=null && yawRight!=null ? Math.abs(angleDiff(yawRight,yawLeft)).toFixed(1) : null
  const pitchRange = pitchMin!=null && pitchMax!=null ? Math.abs(pitchMax-pitchMin).toFixed(1) : null

  return (
    <div className="container vstack">

      {/* Header */}
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
        <div>
          <div style={{fontSize:20,fontWeight:600}}>Cannon Calibration</div>
          <div style={{fontSize:13,color:'var(--color-text-secondary)',marginTop:2}}>
            Do this every boot — point cannon at target zone, then follow steps
          </div>
        </div>
        <button className="btn ghost" onClick={stopAll}
          style={{background:'rgba(229,57,53,.1)',color:'#e53935',border:'1px solid rgba(229,57,53,.4)',padding:'10px 20px',fontWeight:700}}>
          ⛔ STOP ALL
        </button>
      </div>

      {/* Checklist */}
      <div style={{padding:14,borderRadius:10,marginBottom:12,
        background:'var(--color-background-secondary)',border:'1px solid var(--color-border-tertiary)'}}>
        <div style={{fontWeight:500,marginBottom:10}}>Startup Checklist</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
          {[
            {key:'centered',  label:'1. Cannon centered & facing zone', hint:'Point at target area, click SET CENTER'},
            {key:'northSet',  label:'2. North calibrated',              hint:'Phone compass → Set North'},
            {key:'levelSet',  label:'3. Level calibrated',              hint:'Phone level → Set Level'},
            {key:'yawDone',   label:'4. Yaw limits recorded',           hint:'Jog left/right → record both ends'},
            {key:'pitchDone', label:'5. Pitch limits recorded',         hint:'Jog up/down → record both ends'},
          ].map(({key,label,hint}) => (
            <div key={key} onClick={()=>check(key)}
              style={{display:'flex',alignItems:'center',gap:8,padding:'8px 10px',
                borderRadius:8,cursor:'pointer',userSelect:'none',
                background:checks[key]?'rgba(76,175,80,.1)':'var(--color-background-primary)',
                border:checks[key]?'1px solid #4caf50':'1px solid var(--color-border-tertiary)'}}>
              <div style={{width:22,height:22,borderRadius:'50%',flexShrink:0,
                background:checks[key]?'#4caf50':'transparent',
                border:`2px solid ${checks[key]?'#4caf50':'var(--color-border-secondary)'}`,
                display:'flex',alignItems:'center',justifyContent:'center',color:'#fff',fontSize:12,fontWeight:700}}>
                {checks[key]?'✓':''}
              </div>
              <div>
                <div style={{fontSize:12,fontWeight:500,color:checks[key]?'#4caf50':undefined}}>{label}</div>
                <div style={{fontSize:10,color:'var(--color-text-tertiary)'}}>{hint}</div>
              </div>
            </div>
          ))}
        </div>
        {allDone && (
          <div style={{marginTop:10,padding:'10px 14px',borderRadius:8,textAlign:'center',
            background:'rgba(76,175,80,.15)',border:'1px solid #4caf50',fontWeight:700,color:'#4caf50',fontSize:14}}>
            ✅ ALL DONE — Save calibration then go to Map!
          </div>
        )}
      </div>

      {/* Live IMU */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginBottom:12,
        padding:'12px 16px',borderRadius:10,background:'var(--color-background-secondary)',
        border:'1px solid var(--color-border-tertiary)'}}>
        <div>
          <div style={{fontSize:10,color:'var(--color-text-tertiary)'}}>HEADING</div>
          <div style={{fontSize:24,fontWeight:700,color:'#4caf50'}}>{heading!=null?`${heading.toFixed(1)}°`:'--'}</div>
          <div style={{fontSize:10,color:'var(--color-text-tertiary)'}}>raw: {imu?.heading?.toFixed(1)??'--'}°</div>
        </div>
        <div>
          <div style={{fontSize:10,color:'var(--color-text-tertiary)'}}>PITCH</div>
          <div style={{fontSize:24,fontWeight:700,color:'#4caf50'}}>{pitch!=null?`${pitch.toFixed(1)}°`:'--'}</div>
          <div style={{fontSize:10,color:'var(--color-text-tertiary)'}}>raw: {imu?.pitch?.toFixed(1)??'--'}°</div>
        </div>
        <div>
          <div style={{fontSize:10,color:'var(--color-text-tertiary)'}}>ROLL</div>
          <div style={{fontSize:24,fontWeight:700}}>{imu?.roll?.toFixed(1)??'--'}°</div>
        </div>
        <div>
          <div style={{fontSize:10,color:'var(--color-text-tertiary)'}}>CALIB sys/g/a/m</div>
          <div style={{fontSize:18,fontWeight:700,color:imu?.calib?.sys===3?'#4caf50':'#ff9800'}}>
            {imu?.calib?`${imu.calib.sys}/${imu.calib.g}/${imu.calib.a}/${imu.calib.m}`:'--'}
          </div>
          {imu?.calib?.sys<3&&<div style={{fontSize:10,color:'#ff9800'}}>move in figure-8</div>}
        </div>
      </div>

      {/* Step 0: Set Center */}
      <div style={{padding:14,borderRadius:10,marginBottom:12,
        background:'var(--color-background-secondary)',
        border:checks.centered?'2px solid #4caf50':'2px solid #ff9800'}}>
        <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:12}}>
          <div style={{width:28,height:28,borderRadius:'50%',background:checks.centered?'#4caf50':'#ff9800',
            display:'flex',alignItems:'center',justifyContent:'center',fontWeight:700,color:'#fff',fontSize:14}}>
            {checks.centered?'✓':'0'}
          </div>
          <div>
            <div style={{fontWeight:600}}>Set Center Position</div>
            <div style={{fontSize:12,color:'var(--color-text-secondary)'}}>
              Point cannon straight at the target zone first, then click SET CENTER
            </div>
          </div>
        </div>

        {centerHeading!=null && (
          <div style={{padding:'8px 12px',borderRadius:8,marginBottom:10,
            background:'rgba(76,175,80,.1)',border:'1px solid rgba(76,175,80,.3)',fontSize:13,color:'#4caf50'}}>
            Center: {centerHeading}° heading / {centerPitch}° pitch
            <span style={{marginLeft:12,fontSize:11,color:'var(--color-text-tertiary)'}}>
              (this = yellow line on map)
            </span>
          </div>
        )}

        <button className="btn"
          onClick={setCenter}
          style={{width:'100%',padding:'14px 0',fontWeight:700,fontSize:15,
            background:checks.centered?'rgba(76,175,80,.2)':'rgba(255,152,0,.15)',
            color:checks.centered?'#4caf50':'#ff9800',
            border:checks.centered?'1px solid #4caf50':'1px solid #ff9800'}}>
          {checks.centered?`✓ CENTER SET (${centerHeading}°)`:'📍 SET CENTER (point cannon at zone first)'}
        </button>
      </div>

      {/* Phone Calibration */}
      <div style={{padding:14,borderRadius:10,marginBottom:12,
        background:'var(--color-background-secondary)',border:'1px solid var(--color-border-tertiary)'}}>
        <div style={{fontWeight:500,marginBottom:10}}>📱 Phone Calibration — tape phone flat on barrel</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:8}}>
          <div>
            <div style={{fontSize:11,color:'var(--color-text-tertiary)',marginBottom:4}}>Phone compass (°)</div>
            <div style={{display:'flex',gap:6}}>
              <input className="input" type="number" step="0.1" placeholder="e.g. 245.0"
                value={phoneHeading} onChange={e=>setPhoneHeading(e.target.value)} style={{flex:1}}/>
              <button className="btn" onClick={calibrateHeading}
                style={{background:checks.northSet?'rgba(76,175,80,.2)':undefined,
                  border:checks.northSet?'1px solid #4caf50':undefined}}>
                {checks.northSet?'✓ Set':'Set North'}
              </button>
            </div>
            <div style={{fontSize:10,color:'var(--color-text-tertiary)',marginTop:4}}>
              IMU raw: {imu?.heading?.toFixed(1)??'--'}° → corrected: {heading?.toFixed(1)??'--'}°
              {' '}offset: {headingOffset}°
            </div>
          </div>
          <div>
            <div style={{fontSize:11,color:'var(--color-text-tertiary)',marginBottom:4}}>Phone level (°)</div>
            <div style={{display:'flex',gap:6}}>
              <input className="input" type="number" step="0.1" placeholder="e.g. 0.0"
                value={phonePitch} onChange={e=>setPhonePitch(e.target.value)} style={{flex:1}}/>
              <button className="btn" onClick={calibratePitch}
                style={{background:checks.levelSet?'rgba(76,175,80,.2)':undefined,
                  border:checks.levelSet?'1px solid #4caf50':undefined}}>
                {checks.levelSet?'✓ Set':'Set Level'}
              </button>
            </div>
            <div style={{fontSize:10,color:'var(--color-text-tertiary)',marginTop:4}}>
              IMU raw: {imu?.pitch?.toFixed(1)??'--'}° → corrected: {pitch?.toFixed(1)??'--'}°
              {' '}offset: {pitchOffset}°
            </div>
          </div>
        </div>
        {calMsg&&(
          <div style={{fontSize:12,padding:'6px 10px',borderRadius:6,
            background:calMsg.startsWith('✓')?'rgba(76,175,80,.1)':'rgba(229,57,53,.1)',
            color:calMsg.startsWith('✓')?'#4caf50':'#e53935',
            border:calMsg.startsWith('✓')?'1px solid rgba(76,175,80,.3)':'1px solid rgba(229,57,53,.3)'}}>
            {calMsg}
          </div>
        )}
      </div>

      {/* Motor Control */}
      <div style={{padding:14,borderRadius:10,marginBottom:12,
        background:'var(--color-background-secondary)',border:'1px solid var(--color-border-tertiary)'}}>
        <div style={{fontWeight:500,marginBottom:10}}>Motor Control</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:10}}>
          <div>
            <div style={{display:'flex',justifyContent:'space-between',marginBottom:4}}>
              <span style={{fontSize:11,color:'var(--color-text-tertiary)'}}>Yaw speed</span>
              <span style={{fontSize:11,fontWeight:600}}>{Math.round(yawSpeed*100)}%</span>
            </div>
            <input type="range" min="0.05" max="1.0" step="0.05" value={yawSpeed}
              onChange={e=>setYawSpeed(parseFloat(e.target.value))} style={{width:'100%'}}/>
            <div style={{display:'flex',gap:8,marginTop:8}}>
              <button className="btn"
                onClick={()=>enableAxis('yaw')}
                style={{flex:1,fontSize:12,background:enabled.yaw?'rgba(76,175,80,.2)':undefined,
                  border:enabled.yaw?'1px solid #4caf50':undefined}}>
                {enabled.yaw?'✓ Yaw ON':'Enable Yaw'}
              </button>
              <button className="btn ghost" style={{fontSize:12}} onClick={()=>disableAxis('yaw')}>Off</button>
            </div>
          </div>
          <div>
            <div style={{display:'flex',justifyContent:'space-between',marginBottom:4}}>
              <span style={{fontSize:11,color:'var(--color-text-tertiary)'}}>Pitch speed</span>
              <span style={{fontSize:11,fontWeight:600}}>{Math.round(pitchSpeed*100)}%</span>
            </div>
            <input type="range" min="0.05" max="1.0" step="0.05" value={pitchSpeed}
              onChange={e=>setPitchSpeed(parseFloat(e.target.value))} style={{width:'100%'}}/>
            <div style={{display:'flex',gap:8,marginTop:8}}>
              <button className="btn"
                onClick={()=>enableAxis('pitch')}
                style={{flex:1,fontSize:12,background:enabled.pitch?'rgba(76,175,80,.2)':undefined,
                  border:enabled.pitch?'1px solid #4caf50':undefined}}>
                {enabled.pitch?'✓ Pitch ON':'Enable Pitch'}
              </button>
              <button className="btn ghost" style={{fontSize:12}} onClick={()=>disableAxis('pitch')}>Off</button>
            </div>
          </div>
        </div>
        <div style={{display:'flex',gap:8,justifyContent:'center',flexWrap:'wrap'}}>
          <button className="btn ghost" onClick={()=>{setYawSpeed(1.0);setPitchSpeed(1.0)}}
            style={{background:'rgba(229,57,53,.1)',color:'#e53935',border:'1px solid rgba(229,57,53,.4)'}}>
            ⚡ MAX SPEED
          </button>
          <button className="btn ghost" onClick={()=>{setYawSpeed(0.5);setPitchSpeed(0.5)}}>50%</button>
          <button className="btn ghost" onClick={()=>{setYawSpeed(0.15);setPitchSpeed(0.15)}}>15%</button>
        </div>
      </div>

      {/* Step 1: Yaw */}
      <div style={{padding:14,borderRadius:10,marginBottom:12,
        background:'var(--color-background-secondary)',
        border:step===1?'2px solid #ff9800':checks.yawDone?'2px solid #4caf50':'1px solid var(--color-border-tertiary)'}}>
        <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:12}}>
          <div style={{width:28,height:28,borderRadius:'50%',
            background:checks.yawDone?'#4caf50':step>=1?'#ff9800':'#888',
            display:'flex',alignItems:'center',justifyContent:'center',fontWeight:700,color:'#fff',fontSize:14}}>
            {checks.yawDone?'✓':'1'}
          </div>
          <div>
            <div style={{fontWeight:500}}>Yaw Calibration — side to side</div>
            <div style={{fontSize:12,color:'var(--color-text-secondary)'}}>
              Jog to each extreme, record the heading at each end
            </div>
          </div>
        </div>

        <div style={{display:'flex',gap:10,marginBottom:12,justifyContent:'center'}}>
          <JogBtn label="◀◀ LEFT" axis="yaw" dir={-1} speed={yawSpeed} disabled={!enabled.yaw} onJog={jog} onStop={stopAxis}/>
          <JogBtn label="RIGHT ▶▶" axis="yaw" dir={1} speed={yawSpeed} disabled={!enabled.yaw} onJog={jog} onStop={stopAxis}/>
        </div>

        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:10,marginBottom:10}}>
          {[
            {label:'LEFT LIMIT', val:yawLeft,  record:recordYawLeft,  btn:'Record Left',  color:'#ff9800'},
            {label:'CENTER',     val:centerHeading, record:null,      btn:null,            color:'#ffeb3b'},
            {label:'RIGHT LIMIT',val:yawRight, record:recordYawRight, btn:'Record Right',  color:'#ff9800'},
          ].map(({label,val,record,btn,color})=>(
            <div key={label} style={{textAlign:'center',padding:10,borderRadius:8,
              background:'var(--color-background-primary)',
              border:`1px solid ${val!=null?color:'var(--color-border-tertiary)'}`}}>
              <div style={{fontSize:11,color:'var(--color-text-tertiary)'}}>{label}</div>
              <div style={{fontSize:22,fontWeight:700,color:val!=null?color:'#888'}}>
                {val!=null?`${val}°`:'--'}
              </div>
              <div style={{fontSize:10,color:'var(--color-text-tertiary)',marginTop:2}}>
                now: {heading?.toFixed(1)??'--'}°
              </div>
              {btn&&<button className="btn" style={{marginTop:6,width:'100%',fontSize:12}} onClick={record}>{btn}</button>}
            </div>
          ))}
        </div>

        {yawRange&&(
          <div style={{textAlign:'center',padding:'8px',borderRadius:8,
            background:'rgba(255,152,0,.08)',border:'1px solid rgba(255,152,0,.2)',fontSize:13,color:'#ff9800'}}>
            Total yaw range: <strong>{yawRange}°</strong>
            {centerHeading!=null&&yawLeft!=null&&yawRight!=null&&(
              <span style={{marginLeft:12}}>
                Left: {Math.abs(angleDiff(yawLeft,centerHeading)).toFixed(1)}° |
                Right: {Math.abs(angleDiff(yawRight,centerHeading)).toFixed(1)}°
              </span>
            )}
          </div>
        )}

        {yawLeft!=null&&yawRight!=null&&(
          <button className="btn" style={{width:'100%',marginTop:10,
            background:'rgba(76,175,80,.15)',color:'#4caf50',border:'1px solid #4caf50'}}
            onClick={()=>setStep(2)}>
            ✓ Yaw done — Go to Step 2
          </button>
        )}
      </div>

      {/* Step 2: Pitch */}
      <div style={{padding:14,borderRadius:10,marginBottom:12,
        background:'var(--color-background-secondary)',
        border:step===2?'2px solid #2196f3':checks.pitchDone?'2px solid #4caf50':'1px solid var(--color-border-tertiary)',
        opacity:step<2?0.6:1}}>
        <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:12}}>
          <div style={{width:28,height:28,borderRadius:'50%',
            background:checks.pitchDone?'#4caf50':step>=2?'#2196f3':'#888',
            display:'flex',alignItems:'center',justifyContent:'center',fontWeight:700,color:'#fff',fontSize:14}}>
            {checks.pitchDone?'✓':'2'}
          </div>
          <div>
            <div style={{fontWeight:500}}>Pitch Calibration — up / down</div>
            <div style={{fontSize:12,color:'var(--color-text-secondary)'}}>
              Jog to each extreme, record the pitch at each end
            </div>
          </div>
        </div>

        <div style={{display:'flex',gap:10,marginBottom:12,justifyContent:'center'}}>
          <JogBtn label="▲ UP" axis="pitch" dir={-1} speed={pitchSpeed} disabled={!enabled.pitch||step<2} onJog={jog} onStop={stopAxis} color="#2196f3"/>
          <JogBtn label="▼ DOWN" axis="pitch" dir={1} speed={pitchSpeed} disabled={!enabled.pitch||step<2} onJog={jog} onStop={stopAxis} color="#2196f3"/>
        </div>

        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:10,marginBottom:10}}>
          {[
            {label:'MIN PITCH', val:pitchMin, record:recordPitchMin, btn:'Record Min', color:'#2196f3'},
            {label:'CENTER',    val:centerPitch, record:null,        btn:null,         color:'#ffeb3b'},
            {label:'MAX PITCH', val:pitchMax, record:recordPitchMax, btn:'Record Max', color:'#2196f3'},
          ].map(({label,val,record,btn,color})=>(
            <div key={label} style={{textAlign:'center',padding:10,borderRadius:8,
              background:'var(--color-background-primary)',
              border:`1px solid ${val!=null?color:'var(--color-border-tertiary)'}`}}>
              <div style={{fontSize:11,color:'var(--color-text-tertiary)'}}>{label}</div>
              <div style={{fontSize:22,fontWeight:700,color:val!=null?color:'#888'}}>
                {val!=null?`${val}°`:'--'}
              </div>
              <div style={{fontSize:10,color:'var(--color-text-tertiary)',marginTop:2}}>
                now: {pitch?.toFixed(1)??'--'}°
              </div>
              {btn&&<button className="btn" style={{marginTop:6,width:'100%',fontSize:12}} disabled={step<2} onClick={record}>{btn}</button>}
            </div>
          ))}
        </div>

        {pitchRange&&(
          <div style={{textAlign:'center',padding:'8px',borderRadius:8,
            background:'rgba(33,150,243,.08)',border:'1px solid rgba(33,150,243,.2)',fontSize:13,color:'#2196f3'}}>
            Total pitch range: <strong>{pitchRange}°</strong>
          </div>
        )}

        {pitchMin!=null&&pitchMax!=null&&(
          <button className="btn" style={{width:'100%',marginTop:10,
            background:'rgba(76,175,80,.15)',color:'#4caf50',border:'1px solid #4caf50'}}
            onClick={()=>setStep(3)}>
            ✓ Pitch done — Go to Step 3
          </button>
        )}
      </div>

      {/* Step 3: Efficiency + Save */}
      <div style={{padding:14,borderRadius:10,marginBottom:12,
        background:'var(--color-background-secondary)',
        border:step===3?'2px solid #4caf50':'1px solid var(--color-border-tertiary)',
        opacity:step<3?0.6:1}}>
        <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:12}}>
          <div style={{width:28,height:28,borderRadius:'50%',background:step>=3?'#4caf50':'#888',
            display:'flex',alignItems:'center',justifyContent:'center',fontWeight:700,color:'#fff',fontSize:14}}>3</div>
          <div style={{fontWeight:500}}>Save Calibration</div>
        </div>

        <div style={{marginBottom:12}}>
          <div style={{fontSize:11,color:'var(--color-text-tertiary)',marginBottom:4}}>
            Ballistic efficiency (0.26 = calibrated from real shots)
          </div>
          <input className="input" type="number" min="0.05" max="1.0" step="0.01"
            value={efficiency} onChange={e=>setEfficiency(parseFloat(e.target.value))}/>
        </div>

        {/* Summary */}
        <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8,marginBottom:12}}>
          {[
            {label:'Center heading', val:centerHeading, unit:'°'},
            {label:'Yaw left',       val:yawLeft,       unit:'°'},
            {label:'Yaw right',      val:yawRight,      unit:'°'},
            {label:'Center pitch',   val:centerPitch,   unit:'°'},
            {label:'Pitch min',      val:pitchMin,      unit:'°'},
            {label:'Pitch max',      val:pitchMax,      unit:'°'},
            {label:'Heading offset', val:headingOffset, unit:'°'},
            {label:'Pitch offset',   val:pitchOffset,   unit:'°'},
            {label:'Efficiency',     val:efficiency,    unit:''},
          ].map(({label,val,unit})=>(
            <div key={label} style={{padding:'8px 10px',borderRadius:8,
              background:'var(--color-background-primary)',border:'1px solid var(--color-border-tertiary)'}}>
              <div style={{fontSize:10,color:'var(--color-text-tertiary)'}}>{label}</div>
              <div style={{fontSize:14,fontWeight:600,color:val!=null?undefined:'#888'}}>
                {val!=null?`${val}${unit}`:'--'}
              </div>
            </div>
          ))}
        </div>

        <button className="btn" onClick={saveCalibration} disabled={saving||step<3}
          style={{width:'100%',padding:'14px 0',fontWeight:700,fontSize:15,
            background:'rgba(76,175,80,.15)',color:'#4caf50',border:'1px solid #4caf50'}}>
          {saving?'Saving...':'💾 Save & Go to Map'}
        </button>
      </div>

      {/* Calibration History — for reference only */}
      {history.length > 0 && (
        <div style={{padding:14,borderRadius:10,marginBottom:12,
          background:'var(--color-background-secondary)',border:'1px solid var(--color-border-tertiary)'}}>
          <div style={{fontWeight:500,marginBottom:10,fontSize:13}}>
            📋 Past Calibrations (reference only — always redo on boot)
          </div>
          <div style={{display:'flex',flexDirection:'column',gap:6,maxHeight:200,overflowY:'auto'}}>
            {history.map((h,i) => (
              <div key={i} style={{padding:'8px 12px',borderRadius:8,fontSize:12,
                background:'var(--color-background-primary)',border:'1px solid var(--color-border-tertiary)'}}>
                <div style={{display:'flex',justifyContent:'space-between',marginBottom:4}}>
                  <span style={{fontWeight:600,color:'var(--color-text-secondary)'}}>
                    {new Date(h.savedAt).toLocaleString()}
                  </span>
                  <span style={{color:'var(--color-text-tertiary)'}}>
                    yaw: {h.yawMin}°→{h.yawMax}° | pitch: {h.pitchMin}°→{h.pitchMax}°
                  </span>
                </div>
                <div style={{color:'var(--color-text-tertiary)'}}>
                  center: {h.yawCenter}° | hdg offset: {h.headingOffset}° | pitch offset: {h.pitchOffset}° | eff: {h.efficiency}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Messages */}
      {msg&&(
        <div style={{padding:'10px 14px',borderRadius:8,marginBottom:8,
          background:msg.startsWith('✅')||msg.startsWith('✓')?'rgba(76,175,80,.1)':'rgba(255,152,0,.1)',
          border:msg.startsWith('✅')||msg.startsWith('✓')?'1px solid rgba(76,175,80,.3)':'1px solid rgba(255,152,0,.3)',
          color:msg.startsWith('✅')||msg.startsWith('✓')?'#4caf50':'#ff9800',fontSize:13}}>
          {msg}
        </div>
      )}
      {error&&(
        <div style={{padding:'10px 14px',borderRadius:8,
          background:'rgba(229,57,53,.1)',border:'1px solid rgba(229,57,53,.3)',
          color:'#e53935',fontSize:13}}>{error}</div>
      )}

    </div>
  )
}
