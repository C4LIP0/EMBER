import React from 'react'
import './styles.css'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom'
import Dashboard from './pages/Dashboard.jsx'
import MapPage from './pages/Map.jsx'
import SensorStatus from './pages/SensorStatus.jsx'
import ManualControl from './pages/ManualControl.jsx';


// Leaflet CSS + manual icon setup (no leaflet-defaulticon-compatibility)
import 'leaflet/dist/leaflet.css'
import L from 'leaflet'
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png'
import markerIcon from 'leaflet/dist/images/marker-icon.png'
import markerShadow from 'leaflet/dist/images/marker-shadow.png'
delete L.Icon.Default.prototype._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
})

function Shell() {
  const [theme,setTheme]=React.useState(localStorage.getItem("theme")||"dark")
  React.useEffect(()=>{
    document.documentElement.setAttribute("data-theme",theme)
    localStorage.setItem("theme",theme)
  },[theme])

  return (
    <div>
      <nav style={{display:'flex',gap:12,padding:'12px 16px',borderBottom:'1px solid var(--border)',
                   position:'sticky',top:0,background:'var(--card)',zIndex:10,justifyContent:'space-between'}}>
        <div className="hstack" style={{gap:12}}>
          <b>Project Ember</b>
          <NavLink to="/" end>Dashboard</NavLink>
          <NavLink to="/map">Map</NavLink>
          <NavLink to="/sensors">Sensors</NavLink>
          <NavLink to="/manual">Manual</NavLink>
        </div>
        <button className="btn ghost" onClick={()=>setTheme(theme==="dark"?"light":"dark")}>
          {theme==="dark"?"☀️ Light":"🌙 Dark"}
        </button>
      </nav>

      <div className="container">
        <Routes>
          <Route path="/" element={<Dashboard/>}/>
          <Route path="/map" element={<MapPage/>}/>
          <Route path="/sensors" element={<SensorStatus/>}/>
          <Route path="/manual" element={<ManualControl/>}/>
        </Routes>
      </div>
    </div>
  )
}


createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  </React.StrictMode>
)
