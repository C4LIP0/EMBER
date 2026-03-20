import React, { useEffect, useRef, useState } from 'react'
import { MapContainer, TileLayer, Marker, Polyline, Polygon, useMap, useMapEvents } from 'react-leaflet'
import L from 'leaflet'

const API = import.meta.env.VITE_API_BASE_URL || import.meta.env.VITE_API_URL || 'http://localhost:8080'
const G = 9.80665
const BARREL_A = Math.PI * (0.075 / 2) ** 2

function haversineMeters(a,b){const R=6371000,toR=x=>x*Math.PI/180,dLat=toR(b[0]-a[0]),dLon=toR(b[1]-a[1]),lat1=toR(a[0]),lat2=toR(b[0]),h=Math.sin(dLat/2)**2+Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;return 2*R*Math.asin(Math.sqrt(h))}
function bearingDeg(a,b){const toR=x=>x*Math.PI/180,toD=x=>x*180/Math.PI,lat1=toR(a[0]),lat2=toR(b[0]),dLon=toR(b[1]-a[1]),y=Math.sin(dLon)*Math.cos(lat2),x=Math.cos(lat1)*Math.sin(lat2)-Math.sin(lat1)*Math.cos(lat2)*Math.cos(dLon);return(toD(Math.atan2(y,x))+360)%360}
function destinationLatLon(lat,lon,brg,dist){const R=6371000,δ=dist/R,θ=brg*Math.PI/180,φ1=lat*Math.PI/180,λ1=lon*Math.PI/180,φ2=Math.asin(Math.sin(φ1)*Math.cos(δ)+Math.cos(φ1)*Math.sin(δ)*Math.cos(θ)),λ2=λ1+Math.atan2(Math.sin(θ)*Math.sin(δ)*Math.cos(φ1),Math.cos(δ)-Math.sin(φ1)*Math.sin(φ2));return{lat:φ2*180/Math.PI,lon:((λ2*180/Math.PI+540)%360)-180}}
function parseNum(s){const n=Number(String(s).trim());return Number.isFinite(n)?n:null}
function angleDiff(t,c){let d=t-c;while(d>180)d-=360;while(d<-180)d+=360;return d}
function muzzleVelocity(psi,massKg,eff){const pa=psi*6894.76,work=pa*BARREL_A*1.0*eff;return Math.min(Math.sqrt((2*work)/massKg),80)}
function calcPitch(dx,v0,windMs=0){const vEff=Math.max(1,v0-windMs*0.3),v0sq=vEff*vEff,under=v0sq*v0sq-G*(G*dx*dx);if(under<0)return null;const pitch=(Math.atan((v0sq+Math.sqrt(under))/(G*dx))*180)/Math.PI;if(pitch<45||pitch>80)return null;const vy=vEff*Math.sin(pitch*Math.PI/180);return{pitch,tof:(vy+Math.sqrt(vy*vy))/G}}
function findRequiredPsi(dist,massKg,eff,windMs=0){for(let psi=1;psi<=200;psi++){const v0=muzzleVelocity(psi,massKg,eff),bal=calcPitch(dist,v0,windMs);if(bal)return{psi,...bal}}return null}

function HoldBtn({label, onStart, onStop, color='#ff9800', disabled=false}) {
  const timer = useRef(null)
  const start = (e) => { e.preventDefault(); if(disabled)return; onStart(); timer.current=setInterval(onStart,150) }
  const stop  = ()  => { clearInterval(timer.current); onStop() }
  return (
    <button onMouseDown={start} onTouchStart={start} onMouseUp={stop} onMouseLeave={stop} onTouchEnd={stop}
      disabled={disabled}
      style={{padding:'16px 20px',borderRadius:10,fontWeight:700,fontSize:18,
        background:`rgba(${color==='#ff9800'?'255,152,0':'33,150,243'},.15)`,
        color,border:`2px solid ${color}`,cursor:disabled?'not-allowed':'pointer',
        opacity:disabled?0.4:1,userSelect:'none',WebkitUserSelect:'none',minWidth:80}}>
      {label}
    </button>
  )
}

function DirectionGauge({label, error, maxDeg=15, tolerance=1.5}) {
  const abs     = error!=null ? Math.abs(error) : null
  const aligned = abs!=null && abs<=tolerance
  const color   = abs==null?'#555':aligned?'#4caf50':abs<5?'#ff9800':'#e53935'
  const pct     = abs!=null ? Math.min(100,(abs/maxDeg)*100) : 0
  return (
    <div style={{padding:16,borderRadius:10,textAlign:'center',
      background:'var(--color-background-secondary)',
      border:`2px solid ${aligned?'#4caf50':'var(--color-border-tertiary)'}`,
      transition:'border-color .3s'}}>
      <div style={{fontSize:12,color:'var(--color-text-tertiary)',marginBottom:10,fontWeight:500}}>{label}</div>
      <div style={{fontSize:42,fontWeight:800,color,lineHeight:1,marginBottom:10}}>
        {abs==null ? '--' : aligned ? '✓' : (
          <>{error<-tolerance?'← ':''}{error>tolerance?'→ ':''}{abs.toFixed(1)}°</>
        )}
      </div>
      <div style={{height:12,borderRadius:6,background:'#2b2b2b',position:'relative',marginBottom:8}}>
        <div style={{position:'absolute',left:'50%',top:-3,width:2,height:18,background:'rgba(255,255,255,.25)',transform:'translateX(-50%)'}}/>
        <div style={{position:'absolute',left:error!=null&&error<0?`${50-pct/2}%`:'50%',width:`${pct/2}%`,height:'100%',background:color,borderRadius:6,transition:'all .2s'}}/>
      </div>
      <div style={{fontSize:12,color:aligned?'#4caf50':'var(--color-text-tertiary)'}}>
        {abs==null ? 'Calculate first' : aligned ? '✅ ALIGNED' :
          label.includes('YAW') ? (error<0?'Rotate LEFT':'Rotate RIGHT') :
          (error<0?'Tilt DOWN':'Tilt UP')}
      </div>
    </div>
  )
}

const mortarIcon=new L.DivIcon({className:'',html:'<div style="background:#4CAF50;width:20px;height:20px;border-radius:50%;border:2px solid white;box-shadow:0 2px 4px rgba(0,0,0,.4)"></div>',iconSize:[20,20],iconAnchor:[10,10]})
const targetIcon=new L.DivIcon({className:'',html:'<div style="background:#F44336;width:20px;height:20px;border-radius:50%;border:2px solid white;box-shadow:0 2px 4px rgba(0,0,0,.4)"></div>',iconSize:[20,20],iconAnchor:[10,10]})

function MapClickHandler({clickMode, onCannonSet, onTargetSet, onAimSet, cannonPos}) {
  useMapEvents({click(e){
    const {lat,lng}=e.latlng
    if(clickMode==='cannon') onCannonSet({lat,lon:lng})
    else if(clickMode==='target') onTargetSet({lat,lon:lng})
    else if(clickMode==='aim'&&cannonPos){
      const brg=(Math.atan2(
        Math.sin((lng-cannonPos.lon)*Math.PI/180)*Math.cos(lat*Math.PI/180),
        Math.cos(cannonPos.lat*Math.PI/180)*Math.sin(lat*Math.PI/180)-
        Math.sin(cannonPos.lat*Math.PI/180)*Math.cos(lat*Math.PI/180)*Math.cos((lng-cannonPos.lon)*Math.PI/180)
      )*180/Math.PI+360)%360
      onAimSet(parseFloat(brg.toFixed(1)))
    }
  }}); return null
}
function Recenter({center}){const map=useMap();useEffect(()=>{if(center)map.setView(center,map.getZoom())},[center,map]);return null}

export default function AimFirePage() {
  const [mortar,setMortar]=useState(null), [target,setTarget]=useState(null)
  const [mLat,setMLat]=useState(''), [mLon,setMLon]=useState('')
  const [tLat,setTLat]=useState(''), [tLon,setTLon]=useState('')
  const [cal,setCal]=useState(null)
  const [efficiency,setEfficiency]=useState(0.26)
  const [imuOffset,setImuOffset]=useState(0)
  const [hdgOffset,setHdgOffset]=useState(0)
  const [massKg,setMassKg]=useState(1.0)
  const [planPsi,setPlanPsi]=useState('')
  const [maxPsi,setMaxPsi]=useState(150)
  const [balResult,setBalResult]=useState(null)
  const [balError,setBalError]=useState('')
  const [pressure,setPressure]=useState(null)
  const [windLive,setWindLive]=useState({ms:null})
  const [imuState,setImuState]=useState(null)
  const [motorEnabled,setMotorEnabled]=useState({yaw:false,pitch:false})
  const [jogSpeed,setJogSpeed]=useState(0.15)
  const [aimStatus,setAimStatus]=useState('IDLE')
  const [fireStatus,setFireStatus]=useState('IDLE')
  const [firePsi,setFirePsi]=useState(null)
  const [fireArmed,setFireArmed]=useState(false)
  const [shooting,setShooting]=useState(false)
  const [shootPulseMs,setShootPulseMs]=useState(3000)
  const [clickMode,setClickMode]=useState('target')
  const [aimBearing,setAimBearing]=useState(null)

  useEffect(()=>{
    fetch(`${API}/api/calibration`).then(r=>r.ok?r.json():null).then(d=>{
      if(!d?.ok)return; setCal(d)
      if(d.headingOffset!=null)setHdgOffset(d.headingOffset)
      if(d.pitchOffset!=null)setImuOffset(d.pitchOffset)
      if(d.efficiency!=null)setEfficiency(d.efficiency)
    }).catch(()=>{})
  },[])

  useEffect(()=>{
    const id=setInterval(async()=>{
      try{
        const [pr,wr,ir]=await Promise.all([
          fetch(`${API}/api/pressure/latest`).then(r=>r.ok?r.json():null),
          fetch(`${API}/api/anemometer/latest`).then(r=>r.ok?r.json():null),
          fetch(`${API}/api/imu/latest`).then(r=>r.ok?r.json():null),
        ])
        if(pr)setPressure(pr); if(wr)setWindLive(wr); if(ir)setImuState(ir)
      }catch{}
    },300)
    return()=>clearInterval(id)
  },[])

  useEffect(()=>{
    let es=null,stopped=false
    const connect=()=>{es=new EventSource(`${API}/api/autoaim/stream`);es.onmessage=e=>{if(!stopped)try{const d=JSON.parse(e.data);if(d.status)setAimStatus(d.status)}catch{}};es.onerror=()=>{if(!stopped){es?.close();setTimeout(connect,2000)}}}
    connect(); return()=>{stopped=true;es?.close()}
  },[])

  useEffect(()=>{
    let es=null,stopped=false
    const connect=()=>{es=new EventSource(`${API}/api/autofire/stream`);es.onmessage=e=>{if(!stopped)try{const d=JSON.parse(e.data);if(d.status)setFireStatus(d.status);if(d.currentPsi!=null)setFirePsi(d.currentPsi)}catch{}};es.onerror=()=>{if(!stopped){es?.close();setTimeout(connect,2000)}}}
    connect(); return()=>{stopped=true;es?.close()}
  },[])

  const currentHdg  = imuState?.heading!=null?(imuState.heading+hdgOffset+360)%360:null
  const currentElev = imuState?.pitch!=null?imuState.pitch-imuOffset:null
  const targetBear  = mortar&&target?bearingDeg([mortar.lat,mortar.lon],[target.lat,target.lon]):null
  const targetDist  = mortar&&target?haversineMeters([mortar.lat,mortar.lon],[target.lat,target.lon]):null
  const yawErr      = balResult&&currentHdg!=null?angleDiff(parseFloat(balResult.bearing),currentHdg):null
  const pitchErr    = balResult&&currentElev!=null?parseFloat(balResult.pitch)-currentElev:null
  const yawOk       = yawErr!=null&&Math.abs(yawErr)<=1.5
  const pitchOk     = pitchErr!=null&&Math.abs(pitchErr)<=1.5
  const aligned     = yawOk&&pitchOk
  const currentPsiVal = firePsi??pressure?.psi??0
  const statusColor = {IDLE:'#888',SEEKING:'#ff9800',ON_TARGET:'#4caf50',ERROR:'#e53935'}[aimStatus]||'#888'

  // ── FIXED: Yellow line only shows when user manually sets aim direction ──
  const aimLinePath = mortar&&aimBearing!=null
    ?(()=>{const e=destinationLatLon(mortar.lat,mortar.lon,aimBearing,300);return[[mortar.lat,mortar.lon],[e.lat,e.lon]]})()
    :null

  // Red cone centered on aim direction using calibrated spread
  const yawSector = mortar&&aimBearing!=null&&cal?(()=>{
    const leftSpread  = cal.yawMin!=null&&cal.yawCenter!=null ? Math.abs(angleDiff(cal.yawMin,cal.yawCenter)) : 15
    const rightSpread = cal.yawMax!=null&&cal.yawCenter!=null ? Math.abs(angleDiff(cal.yawMax,cal.yawCenter)) : 15
    const halfArc = Math.max(leftSpread,rightSpread,5)
    const coords = [[mortar.lat,mortar.lon]]
    for(let i=0;i<=20;i++){
      const brg=(aimBearing-halfArc+i*(2*halfArc/20)+360)%360
      const p=destinationLatLon(mortar.lat,mortar.lon,brg,350)
      coords.push([p.lat,p.lon])
    }
    coords.push([mortar.lat,mortar.lon])
    return coords
  })():null

  async function enableMotors(){try{await fetch(`${API}/api/steppers/enable`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({axis:'yaw'})});await fetch(`${API}/api/steppers/enable`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({axis:'pitch'})});setMotorEnabled({yaw:true,pitch:true})}catch{}}
  async function jog(axis,dir){try{await fetch(`${API}/api/steppers/jog`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({axis,dir,speed01:jogSpeed})})}catch{}}
  async function stopAxis(axis){try{await fetch(`${API}/api/steppers/stop`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({axis})})}catch{}}

  function calculate(){
    setBalError('');setBalResult(null)
    if(!mortar||!target)return setBalError('Set cannon and target positions first.')
    const wind=windLive?.ms??0,d=haversineMeters([mortar.lat,mortar.lon],[target.lat,target.lon]),bear=bearingDeg([mortar.lat,mortar.lon],[target.lat,target.lon])
    const livePsi=pressure?.psi??0,usingPlan=planPsi!==''&&parseFloat(planPsi)>0,psi=usingPlan?parseFloat(planPsi):livePsi
    if(psi<=0)return setBalError('Enter Planning PSI or pressurize tank first.')
    const v0=muzzleVelocity(psi,massKg,efficiency),bal=calcPitch(d,v0,wind)
    if(!bal){const needed=findRequiredPsi(d,massKg,efficiency,wind);return setBalError(needed?`Need ${needed.psi} PSI for ${d.toFixed(0)}m (have ${psi.toFixed(0)} PSI)`:`Out of range: ${d.toFixed(0)}m`)}
    setBalResult({dist:d.toFixed(1),bearing:bear.toFixed(1),v0:v0.toFixed(1),pitch:bal.pitch.toFixed(1),tof:bal.tof.toFixed(2),psi:psi.toFixed(0),wind:wind.toFixed(1)})
  }

  async function handleAutoAim(){if(!balResult)return;try{await fetch(`${API}/api/autoaim/start`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({heading:parseFloat(balResult.bearing),pitch:parseFloat(balResult.pitch)})})}catch{}}
  async function handleStopAim(){try{await fetch(`${API}/api/autoaim/stop`,{method:'POST'})}catch{}}
  async function handleArm(){if(!balResult)return;try{const r=await fetch(`${API}/api/autofire/arm`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({targetPsi:parseFloat(balResult.psi)})});const j=await r.json();if(j.ok)setFireArmed(true)}catch{}}
  async function handleDisarm(){try{await fetch(`${API}/api/autofire/stop`,{method:'POST'});await fetch(`${API}/api/autofire/reset`,{method:'POST'});setFireArmed(false)}catch{}}
  async function handleVent(){try{await fetch(`${API}/api/solenoids/release`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pulseMs:1000})})}catch{}}
  async function handleShoot(){
    if(shooting) return
    setShooting(true)
    try{await fetch(`${API}/api/solenoids/shoot`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pulseMs:shootPulseMs})})}catch(e){console.error(e)}
    setTimeout(()=>setShooting(false), shootPulseMs+500)
  }
  function applyMortar(){const lat=parseNum(mLat),lon=parseNum(mLon);if(lat!=null&&lon!=null){setMortar({lat,lon});setClickMode('target')}}
  function applyTarget(){const lat=parseNum(tLat),lon=parseNum(tLon);if(lat!=null&&lon!=null)setTarget({lat,lon})}
  function setMortarFromClick(pos){setMortar(pos);setMLat(pos.lat.toFixed(6));setMLon(pos.lon.toFixed(6));setClickMode('target')}
  function setTargetFromClick(pos){setTarget(pos);setTLat(pos.lat.toFixed(6));setTLon(pos.lon.toFixed(6))}

  return (
    <div className="container vstack">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
        <div>
          <div style={{fontSize:20,fontWeight:600}}>🎯 Aim & Fire</div>
          <div style={{fontSize:13,color:'var(--color-text-secondary)'}}>Set target → Calculate → Align → Fire</div>
        </div>
        <div style={{display:'flex',alignItems:'center',gap:8}}>
          <div style={{width:12,height:12,borderRadius:'50%',background:statusColor,boxShadow:aimStatus==='SEEKING'?`0 0 10px ${statusColor}`:'none'}}/>
          <span style={{fontWeight:700,color:statusColor,fontSize:16}}>{aimStatus}</span>
        </div>
      </div>

      <div style={{display:'grid',gridTemplateColumns:'repeat(5,1fr)',gap:8,marginBottom:12,padding:'10px 14px',borderRadius:10,background:'var(--color-background-secondary)',border:'1px solid var(--color-border-tertiary)'}}>
        {[
          {l:'PRESSURE',  v:pressure?.psi!=null?`${pressure.psi.toFixed(1)} PSI`:'--', warn:currentPsiVal>maxPsi*0.9},
          {l:'WIND',      v:windLive?.ms!=null?`${windLive.ms.toFixed(1)} m/s`:'--'},
          {l:'HEADING',   v:currentHdg!=null?`${currentHdg.toFixed(1)}°`:'--', hi:true},
          {l:'ELEVATION', v:currentElev!=null?`${currentElev.toFixed(1)}°`:'--', hi:true},
          {l:'DISTANCE',  v:targetDist!=null?`${targetDist.toFixed(0)}m`:'--'},
        ].map(({l,v,hi,warn})=>(
          <div key={l} style={{textAlign:'center'}}>
            <div style={{fontSize:10,color:'var(--color-text-tertiary)'}}>{l}</div>
            <div style={{fontSize:16,fontWeight:600,color:warn?'#e53935':hi?'#4caf50':undefined}}>{v}</div>
          </div>
        ))}
      </div>

      {currentPsiVal>maxPsi*0.9&&fireStatus!=='FIRED'&&<div style={{padding:'10px 14px',borderRadius:8,marginBottom:8,fontSize:13,fontWeight:700,background:'rgba(229,57,53,.15)',border:'2px solid #e53935',color:'#e53935'}}>⚠️ PRESSURE CRITICAL — {currentPsiVal.toFixed(1)} PSI near max ({maxPsi}) — VENT NOW!</div>}
      {aligned&&!fireArmed&&fireStatus!=='FIRED'&&<div style={{padding:'10px 14px',borderRadius:8,marginBottom:8,fontSize:14,fontWeight:700,background:'rgba(76,175,80,.15)',border:'2px solid #4caf50',color:'#4caf50',textAlign:'center'}}>✅ CANNON ALIGNED — Ready to fire!</div>}
      {fireArmed&&<div style={{padding:'10px 14px',borderRadius:8,marginBottom:8,fontSize:13,fontWeight:700,background:'rgba(255,152,0,.1)',border:'2px solid #ff9800',color:'#ff9800',textAlign:'center'}}>🔴 ARMED — Turn on compressor → auto-fires at {balResult?.psi} PSI</div>}
      {fireStatus==='FIRED'&&<div style={{padding:'12px',borderRadius:8,marginBottom:8,fontSize:18,fontWeight:700,background:'rgba(76,175,80,.2)',border:'2px solid #4caf50',color:'#4caf50',textAlign:'center'}}>🎯 FIRED!</div>}

      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:12}}>
        <DirectionGauge label="YAW — Left / Right" error={yawErr} maxDeg={cal?.yawMin!=null&&cal?.yawMax!=null?Math.abs(angleDiff(cal.yawMax,cal.yawMin))/2:15}/>
        <DirectionGauge label="PITCH — Up / Down" error={pitchErr} maxDeg={15}/>
      </div>

      <div style={{padding:14,borderRadius:10,marginBottom:12,background:'var(--color-background-secondary)',border:'1px solid var(--color-border-tertiary)'}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
          <div style={{fontWeight:500}}>Manual Control</div>
          <div style={{display:'flex',gap:8,alignItems:'center'}}>
            <span style={{fontSize:11,color:'var(--color-text-tertiary)'}}>Speed: {Math.round(jogSpeed*100)}%</span>
            <input type="range" min="0.05" max="0.5" step="0.05" value={jogSpeed} onChange={e=>setJogSpeed(parseFloat(e.target.value))} style={{width:80}}/>
            <button className="btn" style={{fontSize:12,padding:'6px 12px',background:motorEnabled.yaw?'rgba(76,175,80,.2)':undefined,border:motorEnabled.yaw?'1px solid #4caf50':undefined}} onClick={enableMotors}>
              {motorEnabled.yaw&&motorEnabled.pitch?'✓ Motors ON':'Enable Motors'}
            </button>
          </div>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:20}}>
          <div style={{textAlign:'center'}}>
            <div style={{fontSize:12,color:'var(--color-text-tertiary)',marginBottom:8,fontWeight:500}}>YAW</div>
            <div style={{display:'flex',gap:10,justifyContent:'center'}}>
              <HoldBtn label="◀ LEFT"  onStart={()=>jog('yaw',-1)}  onStop={()=>stopAxis('yaw')}  disabled={!motorEnabled.yaw}/>
              <HoldBtn label="RIGHT ▶" onStart={()=>jog('yaw',1)}   onStop={()=>stopAxis('yaw')}  disabled={!motorEnabled.yaw}/>
            </div>
          </div>
          <div style={{textAlign:'center'}}>
            <div style={{fontSize:12,color:'var(--color-text-tertiary)',marginBottom:8,fontWeight:500}}>PITCH</div>
            <div style={{display:'flex',gap:10,justifyContent:'center'}}>
              <HoldBtn label="▲ UP"   onStart={()=>jog('pitch',-1)} onStop={()=>stopAxis('pitch')} disabled={!motorEnabled.pitch} color="#2196f3"/>
              <HoldBtn label="▼ DOWN" onStart={()=>jog('pitch',1)}  onStop={()=>stopAxis('pitch')} disabled={!motorEnabled.pitch} color="#2196f3"/>
            </div>
          </div>
        </div>
      </div>

      <div style={{padding:14,borderRadius:10,marginBottom:12,background:'var(--color-background-secondary)',border:aimStatus==='ON_TARGET'?'2px solid #4caf50':'1px solid var(--color-border-tertiary)'}}>
        <div style={{fontWeight:500,marginBottom:10}}>Auto-Aim Motors</div>
        <div style={{display:'flex',gap:10}}>
          <button className="btn" onClick={handleAutoAim} disabled={!balResult||aimStatus==='SEEKING'} style={{flex:1,padding:'12px 0',fontWeight:700,background:!balResult?'rgba(128,128,128,.1)':aimStatus==='ON_TARGET'?'rgba(76,175,80,.2)':'rgba(255,152,0,.15)',color:!balResult?'#555':aimStatus==='ON_TARGET'?'#4caf50':'#ff9800',border:!balResult?'1px solid #555':aimStatus==='ON_TARGET'?'1px solid #4caf50':'1px solid #ff9800'}}>
            {!balResult?'Calculate first':aimStatus==='ON_TARGET'?'✅ ON TARGET':aimStatus==='SEEKING'?'⟳ Moving...':'🎯 AUTO-AIM'}
          </button>
          {(aimStatus==='SEEKING'||aimStatus==='ON_TARGET')&&<button className="btn ghost" onClick={handleStopAim}>STOP</button>}
        </div>
      </div>

      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:12}}>
        <div style={{padding:12,borderRadius:10,background:'var(--color-background-secondary)',border:'1px solid var(--color-border-tertiary)'}}>
          <div style={{fontWeight:500,marginBottom:10,fontSize:13}}>GPS Positions</div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr auto',gap:6,marginBottom:6,alignItems:'end'}}>
            <div><div style={{fontSize:10,color:'var(--color-text-tertiary)'}}>Cannon Lat</div><input className="input" value={mLat} onChange={e=>setMLat(e.target.value)} placeholder="45.009"/></div>
            <div><div style={{fontSize:10,color:'var(--color-text-tertiary)'}}>Cannon Lon</div><input className="input" value={mLon} onChange={e=>setMLon(e.target.value)} placeholder="-74.068"/></div>
            <button className="btn" style={{fontSize:12}} onClick={applyMortar}>Set</button>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr auto',gap:6,alignItems:'end'}}>
            <div><div style={{fontSize:10,color:'var(--color-text-tertiary)'}}>Target Lat</div><input className="input" value={tLat} onChange={e=>setTLat(e.target.value)} placeholder="45.012"/></div>
            <div><div style={{fontSize:10,color:'var(--color-text-tertiary)'}}>Target Lon</div><input className="input" value={tLon} onChange={e=>setTLon(e.target.value)} placeholder="-74.065"/></div>
            <button className="btn" style={{fontSize:12}} onClick={applyTarget}>Set</button>
          </div>
          {targetDist!=null&&<div style={{marginTop:8,fontSize:12,color:'var(--color-text-secondary)'}}>📏 {targetDist.toFixed(1)}m &nbsp; 🧭 {targetBear?.toFixed(1)}°</div>}
        </div>

        <div style={{padding:12,borderRadius:10,background:'var(--color-background-secondary)',border:'1px solid var(--color-border-tertiary)'}}>
          <div style={{fontWeight:500,marginBottom:10,fontSize:13}}>Ballistics</div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6,marginBottom:8}}>
            <div><div style={{fontSize:10,color:'var(--color-text-tertiary)'}}>Balloon (kg)</div><input className="input" type="number" min="0.1" max="5" step="0.1" value={massKg} onChange={e=>setMassKg(parseFloat(e.target.value))}/></div>
            <div><div style={{fontSize:10,color:'var(--color-text-tertiary)'}}>Planning PSI</div><input className="input" type="number" placeholder="e.g. 55" value={planPsi} onChange={e=>setPlanPsi(e.target.value)}/></div>
            <div><div style={{fontSize:10,color:'var(--color-text-tertiary)'}}>Max PSI</div><input className="input" type="number" value={maxPsi} onChange={e=>setMaxPsi(parseFloat(e.target.value))}/></div>
            <div><div style={{fontSize:10,color:'var(--color-text-tertiary)'}}>Efficiency</div><input className="input" type="number" step="0.01" value={efficiency} onChange={e=>setEfficiency(parseFloat(e.target.value))}/></div>
          </div>
          <button className="btn" style={{width:'100%',fontWeight:700}} onClick={calculate}>🎯 Calculate</button>
          {balError&&<div style={{marginTop:6,fontSize:12,color:'#e53935'}}>{balError}</div>}
          {balResult&&(
            <>
              <div style={{marginTop:10,padding:'10px',borderRadius:8,textAlign:'center',background:'rgba(255,152,0,.1)',border:'2px solid #ff9800'}}>
                <div style={{fontSize:10,color:'var(--color-text-tertiary)'}}>PRESSURIZE TO</div>
                <div style={{fontSize:32,fontWeight:800,color:'#ff9800',lineHeight:1}}>{balResult.psi} PSI</div>
                <div style={{fontSize:10,color:'var(--color-text-tertiary)',marginTop:2}}>{balResult.pitch}° pitch · {balResult.bearing}° bearing · {balResult.dist}m</div>
              </div>
              <div style={{marginTop:8,display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:4}}>
                {[{l:'v0',v:`${balResult.v0}m/s`},{l:'Flight',v:`${balResult.tof}s`},{l:'Wind',v:`${balResult.wind}m/s`}].map(({l,v})=>(
                  <div key={l} style={{padding:'5px 8px',borderRadius:6,background:'var(--color-background-primary)',border:'1px solid var(--color-border-tertiary)'}}>
                    <div style={{fontSize:9,color:'var(--color-text-tertiary)'}}>{l}</div>
                    <div style={{fontSize:12,fontWeight:600}}>{v}</div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:8}}>
        <button className="btn" onClick={()=>setClickMode('cannon')} style={{background:clickMode==='cannon'?'rgba(76,175,80,.2)':undefined,border:clickMode==='cannon'?'1px solid #4caf50':undefined,fontSize:12}}>📍 Set Cannon</button>
        <button className="btn" onClick={()=>setClickMode('target')} style={{background:clickMode==='target'?'rgba(244,67,54,.2)':undefined,border:clickMode==='target'?'1px solid #f44336':undefined,fontSize:12}}>🎯 Set Target</button>
        <button className="btn" onClick={()=>setClickMode('aim')} style={{background:clickMode==='aim'?'rgba(255,235,59,.2)':undefined,border:clickMode==='aim'?'1px solid #ffeb3b':undefined,color:'#ffeb3b',fontSize:12}}>🟡 {aimBearing!=null?`Aim: ${aimBearing}°`:'Set Aim Direction'}</button>
        <button className="btn ghost" onClick={()=>setClickMode('none')} style={{fontSize:12}}>Pan</button>
        {aimBearing!=null&&<button className="btn ghost" onClick={()=>setAimBearing(null)} style={{fontSize:12}}>Clear Aim</button>}
      </div>

      {clickMode!=='none'&&<div style={{padding:'6px 12px',borderRadius:8,marginBottom:8,fontSize:12,background:clickMode==='cannon'?'rgba(76,175,80,.1)':clickMode==='target'?'rgba(244,67,54,.1)':'rgba(255,235,59,.1)',border:clickMode==='cannon'?'1px solid rgba(76,175,80,.3)':clickMode==='target'?'1px solid rgba(244,67,54,.3)':'1px solid rgba(255,235,59,.3)',color:clickMode==='cannon'?'#4caf50':clickMode==='target'?'#f44336':'#ffeb3b'}}>{clickMode==='cannon'?'📍 Click map to place cannon':clickMode==='target'?'🎯 Click map to place target — drag to adjust':'🟡 Click map to set aim direction'}</div>}

      <div style={{borderRadius:10,overflow:'hidden',height:280,marginBottom:12}}>
        <MapContainer center={mortar?[mortar.lat,mortar.lon]:[45.009142,-74.068943]} zoom={16} style={{height:'100%',width:'100%'}} minZoom={2} maxZoom={19}>
          <TileLayer url="/tiles/{z}/{x}/{y}.png" attribution="© OpenStreetMap" maxZoom={18} maxNativeZoom={18} errorTileUrl="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"/>
          <Recenter center={mortar?[mortar.lat,mortar.lon]:[45.009142,-74.068943]}/>
          <MapClickHandler clickMode={clickMode} onCannonSet={setMortarFromClick} onTargetSet={setTargetFromClick} onAimSet={setAimBearing} cannonPos={mortar}/>
          {mortar&&<Marker position={[mortar.lat,mortar.lon]} icon={mortarIcon} draggable eventHandlers={{dragend:e=>{const p=e.target.getLatLng();setMortar({lat:p.lat,lon:p.lng});setMLat(p.lat.toFixed(6));setMLon(p.lng.toFixed(6))}}}/>}
          {target&&<Marker position={[target.lat,target.lon]} icon={targetIcon} draggable eventHandlers={{dragend:e=>{const p=e.target.getLatLng();setTarget({lat:p.lat,lon:p.lng});setTLat(p.lat.toFixed(6));setTLon(p.lng.toFixed(6))}}}/>}
          {mortar&&target&&<Polyline positions={[[mortar.lat,mortar.lon],[target.lat,target.lon]]} color="#ffcc00" weight={2} dashArray="5 5"/>}
          {yawSector&&<Polygon positions={yawSector} pathOptions={{color:'#f44336',weight:2,fillColor:'#f44336',fillOpacity:0.1,dashArray:'6 4'}}/>}
          {aimLinePath&&<Polyline positions={aimLinePath} color="#ffeb3b" weight={3} opacity={0.9}/>}
        </MapContainer>
      </div>

      <div style={{padding:14,borderRadius:10,marginBottom:12,background:'var(--color-background-secondary)',border:shooting?'2px solid #4caf50':'1px solid var(--color-border-tertiary)'}}>
        <div style={{fontWeight:500,marginBottom:12}}>Fire</div>
        <div style={{marginBottom:14}}>
          <div style={{display:'flex',justifyContent:'space-between',marginBottom:4}}>
            <span style={{fontSize:15,fontWeight:600}}>{currentPsiVal.toFixed(1)} PSI</span>
            <span style={{fontSize:13,color:balResult?'#ff9800':'#555',fontWeight:600}}>{balResult?`Target: ${balResult.psi} PSI`:'Calculate to see target PSI'}</span>
          </div>
          <div style={{height:18,borderRadius:9,background:'#2b2b2b',overflow:'hidden'}}>
            <div style={{width:balResult?`${Math.min(100,(currentPsiVal/parseFloat(balResult.psi))*100)}%`:'0%',height:'100%',background:currentPsiVal>maxPsi*0.9?'#e53935':'linear-gradient(90deg,#4caf50,#ff9900,#ff3d00)',borderRadius:9,transition:'width .3s'}}/>
          </div>
        </div>
        <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:14}}>
          <span style={{fontSize:12,color:'var(--color-text-tertiary)',whiteSpace:'nowrap'}}>Solenoid open:</span>
          {[1000,2000,3000,5000].map(ms=>(
            <button key={ms} onClick={()=>setShootPulseMs(ms)} style={{padding:'6px 12px',borderRadius:8,fontSize:12,fontWeight:600,cursor:'pointer',background:shootPulseMs===ms?'rgba(255,152,0,.2)':'var(--color-background-primary)',border:shootPulseMs===ms?'1px solid #ff9800':'1px solid var(--color-border-tertiary)',color:shootPulseMs===ms?'#ff9800':'var(--color-text-secondary)'}}>{ms/1000}s</button>
          ))}
        </div>
        <button onClick={handleShoot} disabled={shooting} style={{width:'100%',padding:'18px 0',borderRadius:12,fontWeight:800,fontSize:20,cursor:shooting?'not-allowed':'pointer',background:shooting?'rgba(76,175,80,.2)':'rgba(176,0,32,.15)',color:shooting?'#4caf50':'#b00020',border:shooting?'2px solid #4caf50':'2px solid rgba(176,0,32,.6)',transition:'all .2s'}}>
          {shooting?`🔥 FIRING... (${shootPulseMs/1000}s)`:'🔥 SHOOT'}
        </button>
        <div style={{marginTop:8,fontSize:11,color:'var(--color-text-tertiary)',textAlign:'center'}}>Pressurize to {balResult?`${balResult.psi} PSI`:'target PSI'} first, then press SHOOT</div>
      </div>

      <div style={{padding:12,borderRadius:10,background:'var(--color-background-secondary)',border:'1px solid var(--color-border-tertiary)',display:'flex',gap:12,alignItems:'center'}}>
        <button className="btn" onClick={handleVent} style={{padding:'10px 24px',fontWeight:700,background:'rgba(0,120,255,.12)',color:'#0b57d0',border:'1px solid rgba(0,120,255,.4)'}}>VENT AIR</button>
        <span style={{fontSize:13,color:'var(--color-text-secondary)'}}>Release pressure anytime</span>
      </div>
    </div>
  )
}