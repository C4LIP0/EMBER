import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 8080;

let sensors = [
  { id: 'BME280', type: 'Env', temperatureC: 21.3, humidity: 41, pressureHpa: 1009.2, updatedAt: new Date().toISOString() },
  { id: 'Anemometer', type: 'Wind', windSpeedMs: 4.2, windDirDeg: 30, updatedAt: new Date().toISOString() },
  { id: 'GPS', type: 'Position', lat: 45.5017, lon: -73.5673, altM: 35, updatedAt: new Date().toISOString() },
];

app.get('/api/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.get('/api/sensors', (_req, res) => res.json({ sensors }));

app.post('/api/ballistics', (req, res) => {
  const { v0, dx, dy = 0, g = 9.80665, windX = 0, windY = 0 } = req.body || {};
  if (!v0 || !dx) return res.status(400).json({ error:'v0 and dx are required (numbers)' });
  const v0sq = v0*v0;
  const termUnder = v0sq*v0sq - g*(g*dx*dx + 2*dy*v0sq);
  if (termUnder < 0) return res.status(422).json({ error:'No real solution for given inputs (target out of range for v0).' });
  const root = Math.sqrt(termUnder);
  const tan1 = (v0sq + root) / (g*dx);
  const tan2 = (v0sq - root) / (g*dx);
  const th1 = Math.atan(tan1); const th2 = Math.atan(tan2);
  const theta = th2;
  const vx = v0 * Math.cos(theta);
  const vy = v0 * Math.sin(theta);
  const a = -0.5 * g, b = vy, c = -dy;
  const disc = b*b - 4*a*c;
  const t = disc >= 0 ? ((-b + Math.sqrt(disc)) / (2*a)) : (dx / Math.max(0.001, v0+windX));
  res.json({ input:{v0,dx,dy,g,windX,windY}, thetaDeg: theta*180/Math.PI, thetaHighArcDeg: th1*180/Math.PI, thetaLowArcDeg: th2*180/Math.PI, timeOfFlightSec: t, impactVx: vx, impactVy: vy - g*t, notes:'Idealized vacuum model' });
});

app.listen(PORT, () => console.log(`API listening on http://localhost:${PORT}`));
