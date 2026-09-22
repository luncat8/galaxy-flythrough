// Closed-form kinematic star motion for 0.4. No gravity or integration.
'use strict';
const FAMILY_PATTERN = 0, FAMILY_DISC = 1, FAMILY_BAR = 2, FAMILY_PRESSURE = 3;
const FAMILY_NAMES = ['pattern', 'disc', 'bar', 'pressure'];
const FAMILY_SHIFT = 3, FAMILY_MASK = 3 << FAMILY_SHIFT;
const ORBIT_PHASE_MASK = 0x0f, ORBIT_AMP_SHIFT = 4;
const TAU = Math.PI * 2;
const FLIGHT_TIME_GAIN = 0.125;
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function familyFromFlags(flags) { return (flags & FAMILY_MASK) >>> FAMILY_SHIFT; }
function flagsWithFamily(flags, family) { return (flags & ~FAMILY_MASK) | ((family & 3) << FAMILY_SHIFT); }
function packOrbit(flags, phase, amplitude) {
  return flagsWithFamily(flags, FAMILY_DISC) | 0; // convenience for callers using defaults
}
function encodeOrbit(flags, family, phase, amplitude) {
  return flagsWithFamily(flags, family) | 0;
}
function readOrbit(packed) {
  const flags = (packed >>> 16) & 255, jitter = (packed >>> 24) & 255;
  return { family: familyFromFlags(flags), phase: jitter & ORBIT_PHASE_MASK, amplitude: jitter >>> ORBIT_AMP_SHIFT };
}
function familyForStar(component, spectralClass, barred) {
  if (spectralClass === 'O' || spectralClass === 'B' || spectralClass === 'A') return FAMILY_PATTERN;
  if (component === 0 || component === 1) return FAMILY_DISC;
  if (component === 2) return barred ? FAMILY_BAR : FAMILY_PRESSURE;
  return FAMILY_PRESSURE;
}
function omegaFor(family, x, y, model) {
  const d = model.dynamics || {};
  const r = Math.hypot(x, y);
  if (family === FAMILY_PATTERN || family === FAMILY_BAR) return d.omegaPattern || 0;
  if (family === FAMILY_DISC) return (d.vFlat || 0) / Math.max(r, d.rCore || 0.5);
  const mean = d.vFlat ? d.vFlat / Math.max(r, d.rCore || 1) : 0.05 / Math.max(Math.pow(Math.max(r, 0.1), 1.5), 0.01);
  return (d.spinLambda == null ? 0.1 : d.spinLambda) * mean;
}
function orbitPosition(out, x, y, z, family, phase, amplitude, time, model) {
  const c = model.centre || {x:0,y:0,z:0};
  const qx=x-c.x, qy=y-c.y, qz=z-c.z;
  const omega=omegaFor(family,qx,qy,model), theta=omega*time;
  const ct=Math.cos(theta), st=Math.sin(theta);
  const wobble=(family===FAMILY_DISC ? (amplitude/15)*0.12 : family===FAMILY_PRESSURE ? (amplitude/15)*0.08 : 0);
  const ph=phase/16*TAU, w0=Math.sin(ph), wt=Math.sin(ph+theta*Math.SQRT2);
  const wx=wobble*(wt-w0), wz=wobble*(Math.sin(ph+theta)-w0);
  out[0]=c.x+ct*(qx+wx)-st*qy; out[1]=c.y+st*(qx+wx)+ct*qy; out[2]=c.z+qz+wz;
  return out;
}
function sliderValueToRate(value, speedLyPerSec) {
  if (value < 0) return (-value) * FLIGHT_TIME_GAIN * speedLyPerSec;
  return value;
}
function formatTimeRate(value, speed) { return value < 0 ? `follow ×${(-value).toFixed(1)}` : value === 0 ? 'frozen' : `+${value.toFixed(1)} Myr/s`; }
const OrbitAPI={FAMILY_PATTERN,FAMILY_DISC,FAMILY_BAR,FAMILY_PRESSURE,FAMILY_NAMES,FAMILY_SHIFT,FAMILY_MASK,FLIGHT_TIME_GAIN,familyFromFlags,flagsWithFamily,packOrbit,encodeOrbit,readOrbit,familyForStar,omegaFor,orbitPosition,sliderValueToRate,formatTimeRate};
if(typeof module!=='undefined') module.exports=OrbitAPI;
if(typeof window!=='undefined') window.OrbitLib=OrbitAPI;
