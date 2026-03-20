import React, { useEffect, useState } from 'react'

const API = import.meta.env.VITE_API_BASE_URL || import.meta.env.VITE_API_URL || 'http://localhost:8080'

function StatusDot({ ok }) {
  return (
    <div style={{
      width:10, height:10, borderRadius:'50%', flexShrink:0,
      background:ok?'#4caf50':'#e53935',
      boxShadow:ok?'0 0 6px #4caf50':'none',
    }}/>
  )
}

function BigCard({ title, children, border }) {
  return (
    <div style={{ padding:16, borderRadius:12, background:'var(--color-background-secondary)', border:border||'1px solid var(--color-border-tertiary)' }}>
      <div style={{ fontWeight:600, fontSize:13, color:'var(--color-text-tertiary)', marginBottom:12, textTransform:'uppercase', letterSpacing:'0.05em' }}>{title}</div>
      {children}
    </div>
  )
}

function Stat({ label, value, unit, color, big }) {
  return (
    <div style={{ textAlign:'center' }}>
      <div style={{ fontSize:big?32:22, fontWeight:700, color:color||undefined, lineHeight:1 }}>
        {value??'--'}{unit&&value!=null?<span style={{ fontSize:big?16:12, fontWeight:400, marginLeft:2 }}>{unit}</span>:''}
      </div>
      <div style={{ fontSize:11, color:'var(--color-text-tertiary)', marginTop:4 }}>{label}</div>
    </div>
  )
}

export default function Dashboard() {
  const [health,    setHealth]    = useState(null)
  const [pressure,  setPressure]  = useState(null)
  const [wind,      setWind]      = useState(null)
  const [imu,       setImu]       = useState(null)
  const [solenoids, setSolenoids] = useState(null)
  const [steppers,  setSteppers]  = useState(null)
  const [lastUpdate,setLastUpdate]= useState(null)

  async function fetchAll() {
    try {
      const results = await Promise.allSettled([
        fetch(`${API}/api/health`).then(r=>r.ok?r.json():null),
        fetch(`${API}/api/pressure/latest`).then(r=>r.ok?r.json():null),
        fetch(`${API}/api/anemometer/latest`).then(r=>r.ok?r.json():null),
        fetch(`${API}/api/imu/latest`).then(r=>r.ok?r.json():null),
        fetch(`${API}/api/solenoids/status`).then(r=>r.ok?r.json():null),
        fetch(`${API}/api/steppers/status`).then(r=>r.ok?r.json():null),
      ])
      const [h,pr,wr,ir,sol,stp] = results.map(r=>r.status==='fulfilled'?r.value:null)
      if(h)   setHealth(h)
      if(pr)  setPressure(pr)
      if(wr)  setWind(wr)
      if(ir)  setImu(ir)
      if(sol) setSolenoids(sol)
      if(stp) setSteppers(stp)
      setLastUpdate(new Date())
    } catch {}
  }

  useEffect(() => {
    fetchAll()
    const id = setInterval(fetchAll, 2000)
    return () => clearInterval(id)
  }, [])

  const serverOk   = health?.status === 'ok'
  const pressureOk = pressure?.psi != null
  const windOk     = wind?.ms != null
  const imuOk      = imu?.heading != null

  return (
    <div className="container vstack">

      {/* Header */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
        <div>
          <div style={{ fontSize:22, fontWeight:700 }}>🔥 Project Ember</div>
          <div style={{ fontSize:13, color:'var(--color-text-secondary)', marginTop:2 }}>
            Wildfire Suppressor Cannon — System Status
          </div>
        </div>
        <div style={{ textAlign:'right' }}>
          <div style={{ display:'flex', alignItems:'center', gap:8, justifyContent:'flex-end' }}>
            <StatusDot ok={serverOk}/>
            <span style={{ fontWeight:600, color:serverOk?'#4caf50':'#e53935', fontSize:14 }}>
              {serverOk?'ONLINE':'OFFLINE'}
            </span>
          </div>
          <div style={{ fontSize:11, color:'var(--color-text-tertiary)', marginTop:4 }}>
            {lastUpdate?`Updated ${lastUpdate.toLocaleTimeString()}`:'Connecting...'}
          </div>
        </div>
      </div>

      {/* Status row */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10, marginBottom:16 }}>
        {[
          { label:'Backend',  ok:serverOk,   text:serverOk?'Running':'Down' },
          { label:'Pressure', ok:pressureOk, text:pressureOk?'Connected':'No Signal' },
          { label:'IMU',      ok:imuOk,      text:imuOk?'Connected':'No Signal' },
          { label:'Wind',     ok:windOk,     text:windOk?'Connected':'No Signal' },
        ].map(({label,ok,text})=>(
          <div key={label} style={{ padding:'10px 14px', borderRadius:10,
            background:'var(--color-background-secondary)',
            border:`1px solid ${ok?'rgba(76,175,80,.4)':'rgba(229,57,53,.3)'}`,
            display:'flex', alignItems:'center', gap:10 }}>
            <StatusDot ok={ok}/>
            <div>
              <div style={{ fontSize:12, fontWeight:600 }}>{label}</div>
              <div style={{ fontSize:11, color:ok?'#4caf50':'#e53935' }}>{text}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Pressure + Wind */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:12 }}>
        <BigCard title="Pressure Sensor" border={pressureOk?'1px solid rgba(76,175,80,.3)':'1px solid var(--color-border-tertiary)'}>
          <div style={{ display:'flex', justifyContent:'center', marginBottom:12 }}>
            <Stat label="Tank Pressure" value={pressure?.psi?.toFixed(1)} unit="PSI" big color={pressure?.psi>100?'#ff9800':pressure?.psi>0?'#4caf50':undefined}/>
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
            <Stat label="Bar"  value={pressure?.bar?.toFixed(3)} unit="bar"/>
            <Stat label="kPa"  value={pressure?.kpa?.toFixed(1)} unit="kPa"/>
          </div>
          {pressure?.ts&&<div style={{ fontSize:10, color:'var(--color-text-tertiary)', marginTop:8, textAlign:'right' }}>{new Date(pressure.ts).toLocaleTimeString()}</div>}
        </BigCard>

        <BigCard title="Anemometer" border={windOk?'1px solid rgba(76,175,80,.3)':'1px solid var(--color-border-tertiary)'}>
          <div style={{ display:'flex', justifyContent:'center', marginBottom:12 }}>
            <Stat label="Wind Speed" value={wind?.ms?.toFixed(1)} unit="m/s" big color={wind?.ms>5?'#ff9800':wind?.ms>0?'#4caf50':undefined}/>
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
            <Stat label="km/h"    value={wind?.kmh?.toFixed(1)} unit="km/h"/>
            <Stat label="Voltage" value={wind?.v?.toFixed(2)}   unit="V"/>
          </div>
          {wind?.ts&&<div style={{ fontSize:10, color:'var(--color-text-tertiary)', marginTop:8, textAlign:'right' }}>{new Date(wind.ts).toLocaleTimeString()}</div>}
        </BigCard>
      </div>

      {/* IMU */}
      <BigCard title="IMU — BNO055" border={imuOk?'1px solid rgba(76,175,80,.3)':'1px solid var(--color-border-tertiary)'}>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:12, marginBottom:10 }}>
          <Stat label="Heading" value={imu?.heading?.toFixed(1)} unit="°" color="#4caf50"/>
          <Stat label="Pitch"   value={imu?.pitch?.toFixed(1)}   unit="°"/>
          <Stat label="Roll"    value={imu?.roll?.toFixed(1)}    unit="°"/>
          <div style={{ textAlign:'center' }}>
            <div style={{ fontSize:16, fontWeight:700, color:imu?.calib?.sys===3?'#4caf50':'#ff9800', lineHeight:1 }}>
              {imu?.calib?`${imu.calib.sys}/${imu.calib.g}/${imu.calib.a}/${imu.calib.m}`:'--'}
            </div>
            <div style={{ fontSize:11, color:'var(--color-text-tertiary)', marginTop:4 }}>calib sys/g/a/m</div>
            {imu?.calib?.sys<3&&<div style={{ fontSize:10, color:'#ff9800', marginTop:2 }}>⚠ Move in figure-8</div>}
          </div>
        </div>
        <div style={{ display:'flex', justifyContent:'space-between', fontSize:11, color:'var(--color-text-tertiary)' }}>
          <span>Bus: {imu?.bus??'--'} | Addr: {imu?.addr??'--'}</span>
          <span>{imu?.ts?new Date(imu.ts).toLocaleTimeString():'--'}</span>
        </div>
      </BigCard>

      {/* Motors + Solenoids */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginTop:12 }}>

        <BigCard title="Motors">
          {['yaw','pitch'].map(axis=>{
            const m=steppers?.[axis]
            return(
              <div key={axis} style={{ display:'flex', justifyContent:'space-between', alignItems:'center',
                padding:'8px 10px', borderRadius:8, marginBottom:6,
                background:'var(--color-background-primary)', border:'1px solid var(--color-border-tertiary)' }}>
                <div>
                  <div style={{ fontSize:12, fontWeight:600, textTransform:'capitalize' }}>{axis}</div>
                  <div style={{ fontSize:10, color:'var(--color-text-tertiary)' }}>#{axis==='yaw'?1:2}</div>
                </div>
                <div style={{ textAlign:'right' }}>
                  <div style={{ fontSize:12, fontWeight:600, color:m?.energized?'#4caf50':'#888' }}>
                    {m?.energized?'ENABLED':'DISABLED'}
                  </div>
                  <div style={{ fontSize:10, color:'var(--color-text-tertiary)' }}>
                    {m?.currentPosition!=null?`pos: ${m.currentPosition}`:'--'}
                  </div>
                </div>
              </div>
            )
          })}
        </BigCard>

        <BigCard title="Solenoids">
          {['shoot','release'].map(s=>{
            const on=solenoids?.[s]
            return(
              <div key={s} style={{ display:'flex', justifyContent:'space-between', alignItems:'center',
                padding:'8px 10px', borderRadius:8, marginBottom:6,
                background:'var(--color-background-primary)', border:'1px solid var(--color-border-tertiary)' }}>
                <div style={{ fontSize:12, fontWeight:600, textTransform:'capitalize' }}>{s}</div>
                <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                  <StatusDot ok={!on}/>
                  <span style={{ fontSize:12, color:on?'#e53935':'#4caf50' }}>{on?'OPEN':'CLOSED'}</span>
                </div>
              </div>
            )
          })}
        </BigCard>

      </div>

      {/* Quick nav */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10, marginTop:16 }}>
        {[
          { label:'🗺 Map',        sub:'Set positions & calculate', href:'/map' },
          { label:'🎯 Aim & Fire', sub:'Align cannon & shoot',      href:'/aim' },
          { label:'⚙️ Calibration',sub:'Set limits & offsets',      href:'/calibration' },
        ].map(({label,sub,href})=>(
          <a key={href} href={href} style={{ textDecoration:'none' }}>
            <div style={{ padding:'14px 16px', borderRadius:10, cursor:'pointer',
              background:'var(--color-background-secondary)', border:'1px solid var(--color-border-tertiary)',
              transition:'border-color .2s' }}
              onMouseEnter={e=>e.currentTarget.style.borderColor='#ff9800'}
              onMouseLeave={e=>e.currentTarget.style.borderColor='var(--color-border-tertiary)'}>
              <div style={{ fontSize:16, fontWeight:600 }}>{label}</div>
              <div style={{ fontSize:12, color:'var(--color-text-secondary)', marginTop:4 }}>{sub}</div>
            </div>
          </a>
        ))}
      </div>

    </div>
  )
}
