import React from 'react'

export const Card = ({title, right, children}) => (
  <div className="card">
    {(title || right) && (
      <div className="hstack" style={{justifyContent:'space-between', marginBottom:8}}>
        <h2 style={{margin:'0', fontSize:18}}>{title}</h2>
        <div>{right}</div>
      </div>
    )}
    {children}
  </div>
)

export const Btn = ({children, onClick, ghost, ...rest}) => (
  <button className={`btn ${ghost ? 'ghost':''}`} onClick={onClick} {...rest}>{children}</button>
)

export const Field = ({label, ...rest}) => (
  <div>
    {label && <span className="label">{label}</span>}
    <input className="input" {...rest}/>
  </div>
)

export const Badge = ({state='ok', children}) => (
  <span className={`badge ${state}`}>{children}</span>
)

export const Section = ({title, sub, children}) => (
  <div className="vstack">
    <div className="hstack" style={{justifyContent:'space-between'}}>
      <div>
        <h1 style={{margin:'8px 0 0 0', fontSize:22}}>{title}</h1>
        {sub && <small className="muted">{sub}</small>}
      </div>
    </div>
    {children}
  </div>
)
