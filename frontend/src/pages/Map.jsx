import React, { useEffect, useMemo, useRef, useState } from 'react'
import { MapContainer, TileLayer, Marker, Polyline, Polygon, useMapEvents, useMap } from 'react-leaflet'
import L from 'leaflet'

const API = import.meta.env.VITE_API_BASE_URL || import.meta.env.VITE_API_URL || 'http://localhost:8080'
const G = 9.80665
const BARREL_A = Math.PI * (0.075 / 2) ** 2

function haversineMeters(a,b){const R=6371000,toR=x=>x*Math.PI/180,dLat=toR(b[0]-a[0]),dLon=toR(b[1]-a[1]),lat1=toR(a[0]),lat2=toR(b[0]),h=Math.sin(dLat/2)**2+Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;return 2*R*Math.asin(Math.sqrt(h))}
function bearingDeg(a,b){const toR=x=>x*Math.PI/180,toD=x=>x*180/Math.PI,lat1=toR(a[0]),lat2=toR(b[0]),dLon=toR(b[1]-a[1]),y=Math.sin(dLon)*Math.cos(lat2),x=Math.cos(lat1)*Math.sin(lat2)-Math.sin(lat1)*Math.cos(lat2)*Math.cos(dLon);return(toD(Math.atan2(y,x))+360)%360}
function destinationLatLon(lat,lon,brg,dist){const R=6371000,δ=dist/R,θ=brg*Math.PI/180,φ1=lat*Math.PI/180,λ1=lon*Math.PI/180,φ2=Math.asin(Math.sin(φ1)*Math.cos(δ)+Math.cos(φ1)*Math.sin(δ)*Math.cos(θ)),λ2=λ1+Math.atan2(Math.sin(θ)*Math.sin(δ)*Math.cos(φ1),Math.cos(δ)-Math.sin(φ1)*Math.sin(φ2));return{lat:φ2*180/Math.PI,lon:((λ2*180/Math.PI+540)%360)-180}}
function sectorPolygon(center,hdg,halfAngle,range,steps=24){if(!center)return null;const{lat,lon}=center,coords=[[lat,lon]];for(let i=0;i<=steps;i++){const p=destinationLatLon(lat,lon,hdg-halfAngle+i*(2*halfAngle/steps),range);coords.push([p.lat,p.lon])}coords.push([lat,lon]);return coords}
function parseNum(s){const n=Number(String(s).trim());return Number.isFinite(n)?n:null}
function muzzleVelocity(psi,massKg,eff){const pa=psi*6894.76,work=pa*BARREL_A*1.0*eff;return Math.min(Math.sqrt((2*work)/massKg),80)}
function calcPitch(dx,v0,windMs=0){const vEff=Math.max(1,v0-windMs*0.3),v0sq=vEff*vEff,under=v0sq*v0sq-G*(G*dx*dx);if(under<0)return null;const pitch=(Math.atan((v0sq+Math.sqrt(under))/(G*dx))*180)/Math.PI;if(pitch<45||pitch>80)return null;const vy=vEff*Math.sin(pitch*Math.PI/180);return{pitch,tof:(vy+Math.sqrt(vy*vy))/G}}
function findRequiredPsi(dist,massKg,eff,windMs=0){for(let psi=1;psi<=200;psi++){const v0=muzzleVelocity(psi,massKg,eff),bal=calcPitch(dist,v0,windMs);if(bal)return{psi,...bal}}return null}

function Alert({type='info',children}){
  const s={info:{bg:'rgba(33,150,243,.1)',border:'1px solid rgba(33,150,243,.4)',color:'#2196f3'},warning:{bg:'rgba(255,152,0,.1)',border:'1px solid rgba(255,152,0,.4)',color:'#ff9800'},danger:{bg:'rgba(229,57,53,.15)',border:'1px solid rgba(229,57,53,.5)',color:'#e53935'},success:{bg:'rgba(76,175,80,.1)',border:'1px solid rgba(76,175,80,.4)',color:'#4caf50'}}[type]
  return <div style={{padding:'10px 14px',borderRadius:8,marginBottom:8,fontSize:13,fontWeight:500,...s}}>{children}</div>
}

function CompassWidget({aimBearing, targetBearing}){
  // aimBearing = where cannon is manually set to point (yellow, always UP = center)
  // targetBearing = where it needs to go (orange)
  // We rotate the compass so aimBearing always points UP
  const S=140,C=S/2,R=C-10

  // offset so aimBearing = top (90deg offset for SVG)
  const offset = aimBearing!=null ? aimBearing : 0
  const pt=(d,r)=>{
    const angle = (d - offset - 90) * Math.PI / 180
    return {x:C+r*Math.cos(angle), y:C+r*Math.sin(angle)}
  }

  // Angle difference between target and aim
  let diff = targetBearing!=null && aimBearing!=null
    ? targetBearing - aimBearing
    : null
  if(diff!=null){ while(diff>180)diff-=360; while(diff<-180)diff+=360 }
  const aligned = diff!=null && Math.abs(diff)<=3

  return(
    <div style={{textAlign:'center'}}>
      <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`}>
        <circle cx={C} cy={C} r={R} fill="none" stroke="var(--color-border-secondary)" strokeWidth="1.5"/>
        {Array.from({length:36},(_,i)=>{const a=i*10,inner=pt(a,R-(i%9===0?10:i%3===0?7:5)),outer=pt(a,R);return<line key={i} x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y} stroke="var(--color-border-secondary)" strokeWidth={i%9===0?2:1}/>})}
        {/* Aim direction — always points UP (yellow solid) */}
        {aimBearing!=null&&(()=>{
          const tip=pt(aimBearing,R-14), tail=pt(aimBearing+180,16)
          return<line x1={tail.x} y1={tail.y} x2={tip.x} y2={tip.y} stroke="#ffeb3b" strokeWidth="3" strokeLinecap="round"/>
        })()}
        {/* Target bearing — orange dashed */}
        {targetBearing!=null&&(()=>{
          const tip=pt(targetBearing,R-14)
          return<><line x1={C} y1={C} x2={tip.x} y2={tip.y} stroke="#ff9800" strokeWidth="2" strokeDasharray="4 3"/><circle cx={tip.x} cy={tip.y} r={4} fill="#ff9800"/></>
        })()}
        {/* Center dot */}
        <circle cx={C} cy={C} r={4} fill="var(--color-text-tertiary)"/>
        {/* "AIM" label at top */}
        <text x={C} y={14} textAnchor="middle" fontSize="9" fontWeight="600" fill="#ffeb3b">AIM</text>
      </svg>
      <div style={{fontSize:11,marginTop:2}}>
        <span style={{color:'#ffeb3b'}}>● Cannon aim</span>{'  '}
        <span style={{color:'#ff9800'}}>● Target</span>
      </div>
      {diff!=null&&(
        <div style={{marginTop:2,fontWeight:600,fontSize:12,
          color:aligned?'#4caf50':Math.abs(diff)<10?'#ff9800':'#e53935'}}>
          {aligned?'✓ ALIGNED':diff<0?`← ${Math.abs(diff).toFixed(1)}° left`:`→ ${Math.abs(diff).toFixed(1)}° right`}
        </div>
      )}
      {aimBearing==null&&(
        <div style={{marginTop:4,fontSize:11,color:'var(--color-text-tertiary)'}}>Set aim direction first</div>
      )}
    </div>
  )
}

const mortarIcon=new L.DivIcon({className:'',html:'<div style="background:#4CAF50;width:24px;height:24px;border-radius:50%;border:3px solid white;box-shadow:0 2px 6px rgba(0,0,0,.4)"></div>',iconSize:[24,24],iconAnchor:[12,12]})
const targetIcon=new L.DivIcon({className:'',html:'<div style="background:#F44336;width:24px;height:24px;border-radius:50%;border:3px solid white;box-shadow:0 2px 6px rgba(0,0,0,.4)"></div>',iconSize:[24,24],iconAnchor:[12,12]})

function MapClickHandler({clickMode,onCannonSet,onTargetSet,onAimSet,cannonPos}){
  useMapEvents({click(e){
    const{lat,lng}=e.latlng
    if(clickMode==='cannon')onCannonSet({lat,lon:lng})
    else if(clickMode==='target')onTargetSet({lat,lon:lng})
    else if(clickMode==='aim'&&cannonPos){
      const brg=(Math.atan2(Math.sin((lng-cannonPos.lon)*Math.PI/180)*Math.cos(lat*Math.PI/180),Math.cos(cannonPos.lat*Math.PI/180)*Math.sin(lat*Math.PI/180)-Math.sin(cannonPos.lat*Math.PI/180)*Math.cos(lat*Math.PI/180)*Math.cos((lng-cannonPos.lon)*Math.PI/180))*180/Math.PI+360)%360
      onAimSet(parseFloat(brg.toFixed(1)))
    }
  }});return null
}
function Recenter({center}){const map=useMap();useEffect(()=>{if(center)map.setView(center,map.getZoom())},[center,map]);return null}

export default function MapPage(){
  const[mortar,setMortar]=useState(null),[target,setTarget]=useState(null)
  const[clickMode,setClickMode]=useState('target'),[autoCenter,setAutoCenter]=useState(true)
  const[mLat,setMLat]=useState(''),[mLon,setMLon]=useState('')
  const[tLat,setTLat]=useState(''),[tLon,setTLon]=useState('')
  const[manualErr,setManualErr]=useState('')
  const[massKg,setMassKg]=useState(1.0),[efficiency,setEfficiency]=useState(0.26)
  const[maxPsi,setMaxPsi]=useState(150),[planningPsi,setPlanningPsi]=useState('')
  const[imuOffset,setImuOffset]=useState(178.5),[headingOffset,setHeadingOffset]=useState(0.0)
  const[balResult,setBalResult]=useState(null),[balError,setBalError]=useState('')
  const[pressure,setPressure]=useState(null),[windLive,setWindLive]=useState({ms:null})
  const[imuState,setImuState]=useState(null)
  const[aimStatus,setAimStatus]=useState('IDLE'),[aimBusy,setAimBusy]=useState(false)
  const[fireStatus,setFireStatus]=useState('IDLE'),[firePsi,setFirePsi]=useState(null)
  const[fireArmed,setFireArmed]=useState(false)
  const[shooting,setShooting]=useState(false)
  const[shootPulseMs,setShootPulseMs]=useState(3000)
  const[autoFireMode,setAutoFireMode]=useState(false)
  const[aimBearing,setAimBearing]=useState(null)
  const[yawLeft,setYawLeft]=useState(null),[yawRight,setYawRight]=useState(null)
  const[centerHeading,setCenterHeading]=useState(null)

  useEffect(()=>{
    fetch(`${API}/api/calibration`).then(r=>r.ok?r.json():null).then(d=>{
      if(!d?.ok)return
      if(d.headingOffset!=null)setHeadingOffset(d.headingOffset)
      if(d.pitchOffset!=null)setImuOffset(d.pitchOffset)
      if(d.efficiency!=null)setEfficiency(d.efficiency)
      if(d.yawMin!=null)setYawLeft(d.yawMin)
      if(d.yawMax!=null)setYawRight(d.yawMax)
      if(d.yawCenter!=null)setCenterHeading(d.yawCenter)
    }).catch(()=>{})
  },[])

  useEffect(()=>{
    const id=setInterval(async()=>{
      try{const[pr,wr,ir]=await Promise.all([fetch(`${API}/api/pressure/latest`).then(r=>r.ok?r.json():null),fetch(`${API}/api/anemometer/latest`).then(r=>r.ok?r.json():null),fetch(`${API}/api/imu/latest`).then(r=>r.ok?r.json():null)]);if(pr)setPressure(pr);if(wr)setWindLive(wr);if(ir)setImuState(ir)}catch{}
    },500);return()=>clearInterval(id)
  },[])

  useEffect(()=>{let es=null,stopped=false;const connect=()=>{es=new EventSource(`${API}/api/autoaim/stream`);es.onmessage=e=>{if(!stopped)try{const d=JSON.parse(e.data);if(d.status)setAimStatus(d.status)}catch{}};es.onerror=()=>{if(!stopped){es?.close();setTimeout(connect,2000)}}};connect();return()=>{stopped=true;es?.close()}},[])
  useEffect(()=>{let es=null,stopped=false;const connect=()=>{es=new EventSource(`${API}/api/autofire/stream`);es.onmessage=e=>{if(!stopped)try{const d=JSON.parse(e.data);if(d.status)setFireStatus(d.status);if(d.currentPsi!=null)setFirePsi(d.currentPsi)}catch{}};es.onerror=()=>{if(!stopped){es?.close();setTimeout(connect,2000)}}};connect();return()=>{stopped=true;es?.close()}},[])

  const heading=useMemo(()=>mortar&&target?bearingDeg([mortar.lat,mortar.lon],[target.lat,target.lon]):null,[mortar,target])
  const dist=useMemo(()=>mortar&&target?haversineMeters([mortar.lat,mortar.lon],[target.lat,target.lon]):null,[mortar,target])
  const sector=useMemo(()=>mortar&&heading!=null?sectorPolygon(mortar,heading,12.5,500):null,[mortar,heading])
  const path=useMemo(()=>mortar&&target?[[mortar.lat,mortar.lon],[target.lat,target.lon]]:null,[mortar,target])
  const mapCenter=mortar?[mortar.lat,mortar.lon]:[45.009142,-74.068943]
  const currentElev=imuState?.pitch!=null?(imuState.pitch-imuOffset).toFixed(1):'--'
  const currentHdg=imuState?.heading!=null?(imuState.heading+headingOffset+360)%360:null
  const displayBearing=aimBearing  // only show when user manually sets aim direction
  const aimLinePath=useMemo(()=>{if(!mortar||displayBearing==null)return null;const end=destinationLatLon(mortar.lat,mortar.lon,displayBearing,300);return[[mortar.lat,mortar.lon],[end.lat,end.lon]]},[mortar,displayBearing])
  const aimDiff=heading!=null&&currentHdg!=null?Math.abs(((heading-currentHdg)+180)%360-180):null
  const aimAligned=aimDiff!=null&&aimDiff<=3
  const statusColor={IDLE:'#888',SEEKING:'#ff9800',ON_TARGET:'#4caf50',ERROR:'#e53935'}[aimStatus]||'#888'
  const currentPsiVal=firePsi??pressure?.psi??0

  function setMortarFromClick(pos){setMortar(pos);setMLat(pos.lat.toFixed(6));setMLon(pos.lon.toFixed(6));setClickMode('target')}
  function setTargetFromClick(pos){setTarget(pos);setTLat(pos.lat.toFixed(6));setTLon(pos.lon.toFixed(6))}
  function applyManualMortar(){const lat=parseNum(mLat),lon=parseNum(mLon);if(lat==null||lon==null)return setManualErr('Invalid cannon coordinates.');setMortar({lat,lon});setManualErr('')}
  function applyManualTarget(){const lat=parseNum(tLat),lon=parseNum(tLon);if(lat==null||lon==null)return setManualErr('Invalid target coordinates.');setTarget({lat,lon});setManualErr('')}

  function calculate(){
    setBalError('');setBalResult(null)
    if(!mortar||!target)return setBalError('Set both cannon and target on the map first.')
    const wind=windLive?.ms??0,d=haversineMeters([mortar.lat,mortar.lon],[target.lat,target.lon]),bear=bearingDeg([mortar.lat,mortar.lon],[target.lat,target.lon])
    const livePsi=pressure?.psi??0,usingPlanning=planningPsi!==''&&parseFloat(planningPsi)>0,psi=usingPlanning?parseFloat(planningPsi):livePsi
    if(psi<=0)return setBalError('Enter a Planning PSI or pressurize the tank first.')
    const v0=muzzleVelocity(psi,massKg,efficiency),bal=calcPitch(d,v0,wind)
    if(!bal){const needed=findRequiredPsi(d,massKg,efficiency,wind);return setBalError(needed?`Need more pressure! ${d.toFixed(0)}m requires at least ${needed.psi} PSI (you have ${psi.toFixed(0)} PSI).`:`Target out of range at any pressure. Distance: ${d.toFixed(0)}m`)}
    setBalResult({dist:d.toFixed(1),bearing:bear.toFixed(1),v0:v0.toFixed(1),pitch:bal.pitch.toFixed(1),tof:bal.tof.toFixed(2),psi:psi.toFixed(0),wind:wind.toFixed(1),usingPlanning})
  }

  async function handleAutoAim(){if(!balResult)return setBalError('Calculate first!');setAimBusy(true);setBalError('');try{const r=await fetch(`${API}/api/autoaim/start`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({heading:parseFloat(balResult.bearing),pitch:parseFloat(balResult.pitch)})});const j=await r.json();if(!j.ok)setBalError(j.error||'Auto-aim failed')}catch(e){setBalError(String(e.message))}finally{setAimBusy(false)}}
  async function handleStopAim(){setAimBusy(true);try{await fetch(`${API}/api/autoaim/stop`,{method:'POST'})}catch{}finally{setAimBusy(false)}}
  async function handleArm(){if(!balResult)return setBalError('Calculate first!');try{const r=await fetch(`${API}/api/autofire/arm`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({targetPsi:parseFloat(balResult.psi)})});const j=await r.json();if(j.ok)setFireArmed(true);else setBalError(j.error||'Arm failed')}catch(e){setBalError(String(e.message))}}
  async function handleDisarm(){try{await fetch(`${API}/api/autofire/stop`,{method:'POST'});await fetch(`${API}/api/autofire/reset`,{method:'POST'});setFireArmed(false)}catch{}}
  async function handleVent(){try{await fetch(`${API}/api/solenoids/release`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pulseMs:1000})})}catch(e){setBalError('Vent failed: '+e.message)}}
  async function handleShoot(){if(shooting)return;setShooting(true);try{await fetch(`${API}/api/solenoids/shoot`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pulseMs:shootPulseMs})})}catch(e){console.error(e)}setTimeout(()=>setShooting(false),shootPulseMs+500)}

  return(
    <div className="card">

      {/* Sensor bar */}
      <div style={{display:'flex',gap:20,flexWrap:'wrap',padding:'10px 16px',background:'var(--color-background-secondary)',borderRadius:10,marginBottom:10,border:'1px solid var(--color-border-tertiary)'}}>
        <div><div style={{fontSize:10,color:'var(--color-text-tertiary)'}}>PRESSURE</div><div style={{fontSize:20,fontWeight:600,color:currentPsiVal>maxPsi*0.9?'#e53935':undefined}}>{pressure?.psi!=null?`${pressure.psi.toFixed(1)} PSI`:'--'}</div></div>
        <div><div style={{fontSize:10,color:'var(--color-text-tertiary)'}}>WIND</div><div style={{fontSize:20,fontWeight:600}}>{windLive?.ms!=null?`${windLive.ms.toFixed(1)} m/s`:'--'}</div></div>
        <div><div style={{fontSize:10,color:'var(--color-text-tertiary)'}}>IMU HEADING</div><div style={{fontSize:20,fontWeight:600}}>{currentHdg!=null?`${currentHdg.toFixed(1)}°`:'--'}</div></div>
        <div><div style={{fontSize:10,color:'var(--color-text-tertiary)'}}>ELEVATION</div><div style={{fontSize:20,fontWeight:600}}>{currentElev}°</div></div>
        {aimBearing!=null&&<div><div style={{fontSize:10,color:'var(--color-text-tertiary)'}}>AIM LINE</div><div style={{fontSize:20,fontWeight:600,color:'#ffeb3b'}}>{aimBearing.toFixed(1)}°</div></div>}
        {balResult&&<div><div style={{fontSize:10,color:'var(--color-text-tertiary)'}}>AIM ERROR</div><div style={{fontSize:20,fontWeight:600,color:aimAligned?'#4caf50':aimDiff!=null&&aimDiff<10?'#ff9800':'#e53935'}}>{aimDiff!=null?`${aimDiff.toFixed(1)}°`:'--'}</div></div>}
        <div style={{marginLeft:'auto',display:'flex',alignItems:'center',gap:8}}><div style={{width:10,height:10,borderRadius:'50%',background:statusColor,boxShadow:aimStatus==='SEEKING'?`0 0 8px ${statusColor}`:'none'}}/><span style={{fontWeight:600,color:statusColor,fontSize:14}}>{aimStatus}</span></div>
      </div>

      {/* Alerts */}
      {currentPsiVal>maxPsi*0.9&&fireStatus!=='FIRED'&&<Alert type="danger">⚠️ PRESSURE CRITICAL — {currentPsiVal.toFixed(1)} PSI near max ({maxPsi} PSI) — VENT NOW!</Alert>}
      {currentPsiVal>maxPsi*0.7&&currentPsiVal<=maxPsi*0.9&&<Alert type="warning">⚡ Pressure approaching max — {currentPsiVal.toFixed(1)} / {maxPsi} PSI</Alert>}
      {aimStatus==='ON_TARGET'&&fireStatus==='IDLE'&&!fireArmed&&<Alert type="success">✅ CANNON ON TARGET — Ready to pressurize.</Alert>}
      {fireArmed&&fireStatus==='ARMED'&&<Alert type="warning">🔴 SYSTEM ARMED — Will fire at {balResult?.psi} PSI automatically.</Alert>}
      {fireStatus==='FIRED'&&<Alert type="success">🎯 FIRED! Reset when ready for next shot.</Alert>}
      {aimStatus==='ERROR'&&<Alert type="danger">❌ Auto-aim error — check IMU and motor power.</Alert>}

      {/* Map mode buttons */}
      <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:8}}>
        <button className="btn" onClick={()=>setClickMode('cannon')} style={{background:clickMode==='cannon'?'rgba(76,175,80,.2)':undefined,border:clickMode==='cannon'?'1px solid #4caf50':undefined}}>📍 Set Cannon</button>
        <button className="btn" onClick={()=>setClickMode('target')} style={{background:clickMode==='target'?'rgba(244,67,54,.2)':undefined,border:clickMode==='target'?'1px solid #f44336':undefined}}>🎯 Set Target</button>
        <button className="btn ghost" onClick={()=>setClickMode('none')}>Pan</button>
        <button className="btn" onClick={()=>setClickMode('aim')} style={{background:clickMode==='aim'?'rgba(255,235,59,.2)':undefined,border:clickMode==='aim'?'1px solid #ffeb3b':undefined,color:'#ffeb3b'}}>🟡 {aimBearing!=null?`Aim: ${aimBearing}°`:'Set Aim Direction'}</button>
        {aimBearing!=null&&<button className="btn ghost" onClick={()=>setAimBearing(null)} style={{fontSize:12}}>Clear Aim</button>}
        <button className="btn ghost" onClick={()=>setAutoCenter(v=>!v)}>{autoCenter?'Auto-center ON':'Auto-center OFF'}</button>
        <button className="btn ghost" onClick={()=>{setMortar(null);setTarget(null);setBalResult(null);setMLat('');setMLon('');setTLat('');setTLon('')}}>Clear All</button>
      </div>

      {clickMode!=='none'&&<div style={{padding:'8px 12px',borderRadius:8,marginBottom:8,fontSize:13,background:clickMode==='cannon'?'rgba(76,175,80,.1)':clickMode==='target'?'rgba(244,67,54,.1)':'rgba(255,235,59,.1)',border:clickMode==='cannon'?'1px solid rgba(76,175,80,.3)':clickMode==='target'?'1px solid rgba(244,67,54,.3)':'1px solid rgba(255,235,59,.3)',color:clickMode==='cannon'?'#4caf50':clickMode==='target'?'#f44336':'#ffeb3b'}}>{clickMode==='cannon'?'📍 Click map to place cannon':clickMode==='target'?'🎯 Click map to place target':'🟡 Click map to set aim direction'}</div>}

      {/* Map */}
      <div style={{height:'55vh',borderRadius:10,overflow:'hidden',marginBottom:10}}>
        <MapContainer center={mapCenter} zoom={16} style={{height:'100%',width:'100%'}} minZoom={2} maxZoom={19}>
          <TileLayer url="/tiles/{z}/{x}/{y}.png" attribution="© OpenStreetMap" maxZoom={18} maxNativeZoom={18} errorTileUrl="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"/>
          {autoCenter&&<Recenter center={mapCenter}/>}
          <MapClickHandler clickMode={clickMode} onCannonSet={setMortarFromClick} onTargetSet={setTargetFromClick} onAimSet={setAimBearing} cannonPos={mortar}/>
          {mortar&&<Marker position={[mortar.lat,mortar.lon]} draggable icon={mortarIcon} eventHandlers={{dragend:e=>{const p=e.target.getLatLng();setMortar({lat:p.lat,lon:p.lng});setMLat(p.lat.toFixed(6));setMLon(p.lng.toFixed(6))}}}/>}
          {target&&<Marker position={[target.lat,target.lon]} draggable icon={targetIcon} eventHandlers={{dragend:e=>{const p=e.target.getLatLng();setTarget({lat:p.lat,lon:p.lng});setTLat(p.lat.toFixed(6));setTLon(p.lng.toFixed(6))}}}/>}
          {path&&<Polyline positions={path} color="#ffcc00" weight={3} dashArray="6 6"/>}
          {sector&&<Polygon positions={sector} pathOptions={{color:'#ff6666',weight:1,fillColor:'#ff6666',fillOpacity:0.15}}/>}
          {aimLinePath&&<Polyline positions={aimLinePath} color="#ffeb3b" weight={3} opacity={0.9}/>}
        </MapContainer>
      </div>

      {/* Bearing + compass */}
      {mortar&&target&&(
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:10}}>
          <div style={{padding:16,borderRadius:10,background:'var(--color-background-secondary)',border:'1px solid var(--color-border-tertiary)',textAlign:'center'}}>
            <div style={{fontSize:11,color:'var(--color-text-tertiary)',marginBottom:4}}>BEARING TO TARGET</div>
            <div style={{fontSize:52,fontWeight:700,color:'#ff9800',lineHeight:1}}>{heading!=null?heading.toFixed(1):'--'}°</div>
            <div style={{fontSize:12,color:'var(--color-text-secondary)',marginTop:4}}>Point physical compass to this bearing</div>
            <div style={{marginTop:8,fontSize:20,fontWeight:600}}>📏 {dist!=null?dist.toFixed(1)+' m':'--'}</div>
            {aimDiff!=null&&<div style={{marginTop:6,fontSize:13,fontWeight:600,color:aimAligned?'#4caf50':aimDiff<10?'#ff9800':'#e53935'}}>{aimAligned?'✅ Cannon aligned!':currentHdg!=null?`Cannon pointing ${currentHdg.toFixed(1)}° (${aimDiff.toFixed(1)}° off)`:''}</div>}
          </div>
          <div style={{padding:16,borderRadius:10,background:'var(--color-background-secondary)',border:'1px solid var(--color-border-tertiary)',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center'}}>
            <CompassWidget aimBearing={aimBearing} targetBearing={heading}/>
          </div>
        </div>
      )}

      {/* Manual GPS */}
      <div style={{padding:12,borderRadius:10,background:'var(--color-background-secondary)',border:'1px solid var(--color-border-tertiary)',marginBottom:10}}>
        <div style={{fontWeight:500,marginBottom:10,fontSize:13}}>Manual GPS Coordinates</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr auto auto',gap:8,alignItems:'end',marginBottom:8}}>
          <div><div style={{fontSize:11,color:'var(--color-text-tertiary)'}}>Cannon Lat</div><input className="input" value={mLat} onChange={e=>setMLat(e.target.value)} placeholder="45.009142"/></div>
          <div><div style={{fontSize:11,color:'var(--color-text-tertiary)'}}>Cannon Lon</div><input className="input" value={mLon} onChange={e=>setMLon(e.target.value)} placeholder="-74.068943"/></div>
          <button className="btn" onClick={applyManualMortar}>Set Cannon</button>
          <button className="btn ghost" onClick={()=>{setMLat('');setMLon('');setMortar(null)}}>✕</button>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr auto auto',gap:8,alignItems:'end'}}>
          <div><div style={{fontSize:11,color:'var(--color-text-tertiary)'}}>Target Lat</div><input className="input" value={tLat} onChange={e=>setTLat(e.target.value)} placeholder="45.012000"/></div>
          <div><div style={{fontSize:11,color:'var(--color-text-tertiary)'}}>Target Lon</div><input className="input" value={tLon} onChange={e=>setTLon(e.target.value)} placeholder="-74.065000"/></div>
          <button className="btn" onClick={applyManualTarget}>Set Target</button>
          <button className="btn ghost" onClick={()=>{setTLat('');setTLon('');setTarget(null)}}>✕</button>
        </div>
        {manualErr&&<Alert type="danger">{manualErr}</Alert>}
      </div>

      {/* Ballistics */}
      <div style={{padding:14,borderRadius:10,background:'var(--color-background-secondary)',border:'1px solid var(--color-border-tertiary)',marginBottom:10}}>
        <div style={{fontWeight:500,marginBottom:4}}>Ballistics</div>
        <div style={{fontSize:12,color:'var(--color-text-tertiary)',marginBottom:10}}>Calibration loaded automatically — set positions then Calculate</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:10,marginBottom:10}}>
          <div><div style={{fontSize:11,color:'var(--color-text-tertiary)'}}>Balloon (kg)</div><input className="input" type="number" min="0.1" max="5" step="0.1" value={massKg} onChange={e=>setMassKg(parseFloat(e.target.value))}/></div>
          <div><div style={{fontSize:11,color:'var(--color-text-tertiary)'}}>Planning PSI</div><input className="input" type="number" min="0" max="150" step="5" placeholder="e.g. 55" value={planningPsi} onChange={e=>setPlanningPsi(e.target.value)}/></div>
          <div><div style={{fontSize:11,color:'var(--color-text-tertiary)'}}>Max PSI (safety)</div><input className="input" type="number" min="10" max="200" step="5" value={maxPsi} onChange={e=>setMaxPsi(parseFloat(e.target.value))}/></div>
          <div><div style={{fontSize:11,color:'var(--color-text-tertiary)'}}>IMU pitch offset</div><input className="input" type="number" step="0.1" value={imuOffset} onChange={e=>setImuOffset(parseFloat(e.target.value))}/></div>
          <div><div style={{fontSize:11,color:'var(--color-text-tertiary)'}}>Heading offset</div><input className="input" type="number" step="0.1" value={headingOffset} onChange={e=>setHeadingOffset(parseFloat(e.target.value))}/></div>
          <div><div style={{fontSize:11,color:'var(--color-text-tertiary)'}}>Efficiency</div><input className="input" type="number" min="0.05" max="1.0" step="0.01" value={efficiency} onChange={e=>setEfficiency(parseFloat(e.target.value))}/></div>
        </div>
        <div style={{padding:'8px 12px',borderRadius:8,marginBottom:10,fontSize:12,background:'var(--color-background-primary)',border:'1px solid var(--color-border-tertiary)',color:'var(--color-text-secondary)'}}>
          📊 1kg, eff=0.26: 50m→31PSI | 80m→50PSI | 100m→62PSI | 125m→78PSI | 150m→93PSI | 200m→124PSI
        </div>
        <button className="btn" style={{width:'100%',padding:'12px 0',fontWeight:700,fontSize:15,marginBottom:10}} onClick={calculate}>🎯 Calculate & Aim</button>
        {balError&&<Alert type="danger">{balError}</Alert>}
        {balResult&&(
          <>
            {balResult.usingPlanning&&<Alert type="warning">📋 Planning mode — pressurize to exactly <strong>{balResult.psi} PSI</strong> before firing</Alert>}
            <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8,marginBottom:10}}>
              {[{label:'Distance',value:`${balResult.dist} m`},{label:'Bearing',value:`${balResult.bearing}°`},{label:'Muzzle v0',value:`${balResult.v0} m/s`},{label:'Pitch',value:`${balResult.pitch}°`,hi:true},{label:'Flight',value:`${balResult.tof} s`},{label:'Wind',value:`${balResult.wind} m/s`},{label:'PSI used',value:`${balResult.psi} PSI`,hi:true}].map(({label,value,hi})=>(
                <div key={label} style={{background:'var(--color-background-primary)',borderRadius:8,padding:'8px 10px',border:hi?'1px solid #ff9800':'1px solid var(--color-border-tertiary)'}}>
                  <div style={{fontSize:10,color:'var(--color-text-tertiary)'}}>{label}</div>
                  <div style={{fontSize:16,fontWeight:600,color:hi?'#ff9800':undefined}}>{value}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Phase 1: Aim */}
      {balResult&&(
        <div style={{padding:14,borderRadius:10,marginBottom:10,background:'var(--color-background-secondary)',border:aimStatus==='ON_TARGET'?'2px solid #4caf50':'1px solid var(--color-border-tertiary)'}}>
          <div style={{fontWeight:500,marginBottom:10}}>Phase 1 — Aim Cannon</div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:12,marginBottom:12,padding:'12px 14px',borderRadius:8,background:'var(--color-background-primary)'}}>
            <div style={{textAlign:'center'}}><div style={{fontSize:11,color:'var(--color-text-tertiary)'}}>TARGET BEARING</div><div style={{fontSize:38,fontWeight:700,color:'#ff9800'}}>{balResult.bearing}°</div><div style={{fontSize:11,color:'var(--color-text-secondary)'}}>point compass here</div></div>
            <div style={{textAlign:'center'}}><div style={{fontSize:11,color:'var(--color-text-tertiary)'}}>TARGET PITCH</div><div style={{fontSize:38,fontWeight:700,color:'#ff9800'}}>{balResult.pitch}°</div><div style={{fontSize:11,color:'var(--color-text-secondary)'}}>tilt cannon up</div></div>
            <div style={{textAlign:'center'}}><div style={{fontSize:11,color:'var(--color-text-tertiary)'}}>CANNON NOW</div><div style={{fontSize:16,fontWeight:700,marginTop:8,color:aimAligned?'#4caf50':aimDiff!=null&&aimDiff<10?'#ff9800':'#e53935'}}>{aimAligned?'✅ ALIGNED':aimDiff!=null?`${aimDiff.toFixed(1)}° off`:'--'}</div><div style={{fontSize:11,color:'var(--color-text-secondary)'}}>hdg {currentHdg!=null?currentHdg.toFixed(1)+'°':'--'} / elev {currentElev}°</div></div>
          </div>
          <div style={{display:'flex',gap:10}}>
            <button className="btn" onClick={handleAutoAim} disabled={aimBusy||aimStatus==='SEEKING'} style={{flex:1,padding:'12px 0',fontWeight:700,background:aimStatus==='ON_TARGET'?'rgba(76,175,80,.2)':'rgba(255,152,0,.15)',color:aimStatus==='ON_TARGET'?'#4caf50':'#ff9800',border:aimStatus==='ON_TARGET'?'1px solid #4caf50':'1px solid #ff9800'}}>
              {aimStatus==='ON_TARGET'?'✅ ON TARGET':aimStatus==='SEEKING'?'⟳ Moving...':'🎯 AUTO-AIM MOTORS'}
            </button>
            {(aimStatus==='SEEKING'||aimStatus==='ON_TARGET')&&<button className="btn ghost" onClick={handleStopAim}>STOP</button>}
          </div>
        </div>
      )}

      {/* Phase 2: PSI gauge (when ON_TARGET) */}
      {balResult&&aimStatus==='ON_TARGET'&&(
        <div style={{padding:14,borderRadius:10,marginBottom:10,background:'var(--color-background-secondary)',border:fireStatus==='FIRED'?'2px solid #4caf50':fireStatus==='ARMED'?'2px solid #ff9800':'1px solid var(--color-border-tertiary)'}}>
          <div style={{fontWeight:500,marginBottom:10}}>Phase 2 — Pressurize</div>
          <div style={{marginBottom:10}}>
            <div style={{display:'flex',justifyContent:'space-between',marginBottom:6}}><span style={{fontSize:16,fontWeight:600}}>{currentPsiVal.toFixed(1)} PSI</span><span style={{fontSize:14,color:'#ff9800',fontWeight:600}}>→ {balResult.psi} PSI target</span></div>
            <div style={{height:24,borderRadius:10,background:'#2b2b2b',overflow:'hidden'}}>
              <div style={{width:`${Math.min(100,(currentPsiVal/parseFloat(balResult.psi))*100)}%`,height:'100%',background:fireStatus==='FIRED'?'#4caf50':currentPsiVal>maxPsi*0.9?'#e53935':currentPsiVal>maxPsi*0.7?'linear-gradient(90deg,#ff9900,#ff3d00)':'linear-gradient(90deg,#4caf50,#ff9900)',borderRadius:10,transition:'width .3s'}}/>
            </div>
          </div>
        </div>
      )}

      {/* Fire + Vent — always visible */}
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>

        {/* Fire mode */}
        <div style={{padding:14,borderRadius:10,background:'var(--color-background-secondary)',border:shooting?'2px solid #4caf50':'1px solid var(--color-border-tertiary)'}}>
          <div style={{fontWeight:500,marginBottom:10}}>Fire Mode</div>
          <div style={{display:'flex',gap:8,marginBottom:12}}>
            <button onClick={()=>setAutoFireMode(false)} style={{flex:1,padding:'8px 0',borderRadius:8,fontWeight:600,fontSize:12,cursor:'pointer',background:!autoFireMode?'rgba(176,0,32,.15)':'var(--color-background-primary)',color:!autoFireMode?'#b00020':'var(--color-text-secondary)',border:!autoFireMode?'1px solid rgba(176,0,32,.4)':'1px solid var(--color-border-tertiary)'}}>🔘 Manual</button>
            <button onClick={()=>setAutoFireMode(true)} style={{flex:1,padding:'8px 0',borderRadius:8,fontWeight:600,fontSize:12,cursor:'pointer',background:autoFireMode?'rgba(255,152,0,.15)':'var(--color-background-primary)',color:autoFireMode?'#ff9800':'var(--color-text-secondary)',border:autoFireMode?'1px solid #ff9800':'1px solid var(--color-border-tertiary)'}}>⚡ Auto PSI</button>
          </div>

          {!autoFireMode?(
            <>
              <div style={{display:'flex',gap:6,marginBottom:10,flexWrap:'wrap'}}>
                <span style={{fontSize:11,color:'var(--color-text-tertiary)',alignSelf:'center',whiteSpace:'nowrap'}}>Open:</span>
                {[1000,2000,3000,5000].map(ms=>(
                  <button key={ms} onClick={()=>setShootPulseMs(ms)} style={{padding:'4px 10px',borderRadius:6,fontSize:11,fontWeight:600,cursor:'pointer',background:shootPulseMs===ms?'rgba(255,152,0,.2)':'var(--color-background-primary)',border:shootPulseMs===ms?'1px solid #ff9800':'1px solid var(--color-border-tertiary)',color:shootPulseMs===ms?'#ff9800':'var(--color-text-secondary)'}}>{ms/1000}s</button>
                ))}
              </div>
              <button onClick={handleShoot} disabled={shooting} style={{width:'100%',padding:'14px 0',borderRadius:10,fontWeight:800,fontSize:18,cursor:shooting?'not-allowed':'pointer',background:shooting?'rgba(76,175,80,.2)':'rgba(176,0,32,.15)',color:shooting?'#4caf50':'#b00020',border:shooting?'2px solid #4caf50':'2px solid rgba(176,0,32,.6)',transition:'all .2s'}}>
                {shooting?`🔥 FIRING... (${shootPulseMs/1000}s)`:'🔥 SHOOT'}
              </button>
              <div style={{fontSize:11,color:'var(--color-text-tertiary)',marginTop:6,textAlign:'center'}}>Pressurize to {balResult?`${balResult.psi} PSI`:'target PSI'} then press SHOOT</div>
            </>
          ):(
            <>
              <div style={{fontSize:12,color:'var(--color-text-secondary)',marginBottom:10}}>Arms system — fires automatically when PSI reaches target</div>
              {fireStatus==='FIRED'?(
                <div style={{textAlign:'center'}}><div style={{fontSize:20,fontWeight:700,color:'#4caf50',marginBottom:8}}>🎯 FIRED!</div><button className="btn ghost" onClick={handleDisarm}>Reset</button></div>
              ):(
                <div style={{display:'flex',gap:8}}>
                  <button className="btn" onClick={handleArm} disabled={fireArmed||!balResult} style={{flex:1,padding:'12px 0',fontWeight:700,background:!balResult?'rgba(128,128,128,.08)':fireArmed?'rgba(255,152,0,.15)':'rgba(176,0,32,.15)',color:!balResult?'#555':fireArmed?'#ff9800':'#b00020',border:!balResult?'1px solid #444':fireArmed?'1px solid #ff9800':'1px solid rgba(176,0,32,.4)'}}>
                    {!balResult?'Calculate first':fireArmed?'🔴 ARMED':'ARM AUTO-FIRE'}
                  </button>
                  {fireArmed&&<button className="btn ghost" onClick={handleDisarm}>DISARM</button>}
                </div>
              )}
            </>
          )}
        </div>

        {/* Vent */}
        <div style={{padding:14,borderRadius:10,background:'var(--color-background-secondary)',border:'1px solid var(--color-border-tertiary)',display:'flex',flexDirection:'column',justifyContent:'center',gap:10}}>
          <div style={{fontWeight:500}}>Air Release</div>
          <button className="btn" onClick={handleVent} style={{padding:'14px 0',fontWeight:700,fontSize:15,width:'100%',background:'rgba(0,120,255,.12)',color:'#0b57d0',border:'1px solid rgba(0,120,255,.4)'}}>VENT AIR (GPIO24)</button>
          <div style={{fontSize:12,color:'var(--color-text-secondary)'}}>Press anytime to safely release pressure</div>
        </div>

      </div>
    </div>
  )
}
