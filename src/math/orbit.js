// src/math/orbit.js
// Closed-form kinematic star motion for 0.4. No gravity or integration.
//
// One law for every family. The GPU mirror is SHADER_PARTS['orbit'] in
// render/shaders.js — the two are pinned together by experiments/wgsl-validate.js
// (symbolic) and experiments/orbit-test.js (numeric, via an f32 replay of the
// WGSL arithmetic). Per-model numbers never live in either law: they arrive
// through fillDynamics/packOrbitDynamics (CPU) and camera.dynA/dynB (GPU).
//
// Group kinematics (0.4.3, "bar and belt should not correspond to static speed
// but some group speed of stars — bar rotates as a rigid shape is impossible").
// A bar is a *pattern*, and a pattern is a group speed: the mean precession
// rate of the population that carries it, derived per model in galaxy.js. The
// pattern rotates rigidly because that is what a density wave is, but no star
// is glued to it:
//
//   bar       the star's seat rides the pattern, and the star itself circulates
//             around that seat on an x1 loop (the wing of the bar) at the rate
//             it laps the pattern, Omega(r) - omegaPattern. That rate is a
//             function of radius, not of the star: zero at corotation (trapped
//             stars), largest at the centre (where the star overtakes the bar
//             fastest) and reversed outside it. Amplitudes stay small, so the
//             loop reads as the bar's own internal stream and never tears its
//             shape.
//   disc      differential rotation at the local group rate Omega(r) — the mean
//             orbital rate of the stars at that radius. No corotation lock: the
//             lock made the whole inner galaxy one rigid body (the reported
//             bug). patternLock (§3.3) still forces the rigid variant.
//   pattern   the young stars ride the pattern at that same group speed.
//
// Cost: one extra sin pair for the bar's stars — the same shape as the disc's
// existing epicycle, and one select less than the lock it replaces.
//
// Wave damping (optional, slider). A density wave is a slow lane that rotates
// with the pattern: stars linger on the crest and the arm is the traffic jam,
// not a paint job. The linked-repo form (inertial rate times 1 - s*D) only jams inside
// corotation — outside it the pattern already overtakes the star, and slowing
// the inertial rate makes the pattern sweep the star *faster*, which empties
// the outer arms. This disc is mostly outside corotation, so the law is the
// pattern-frame capture instead: dχ/dt = α·m·(Ω−Ω_p)·sin²(χ/2), χ the arm
// phase. Crest speed is zero on both sides of corotation, so a gap star drifts
// onto the nearest crest and stays. α = 0 is the 0.4.3 shear, bit for bit.
// Closed form, T = 0 identity, disc family only. Pattern stars already ride
// the crest; the bar's x1 loop is not a spiral.
'use strict';

const density = (typeof module !== 'undefined' && module.exports)
	? require('./density.js')
	: window.DensityLib;

const FAMILY_PATTERN = 0, FAMILY_DISC = 1, FAMILY_BAR = 2, FAMILY_PRESSURE = 3;
const FAMILY_NAMES = ['pattern', 'disc', 'bar', 'pressure'];
const FAMILY_SHIFT = 3, FAMILY_MASK = 3 << FAMILY_SHIFT;
const TAU = Math.PI * 2;
const INV_TAU = 1 / TAU;
const HALF_PI = Math.PI / 2;
const SQRT2 = Math.SQRT2;
const FLIGHT_TIME_GAIN = 0.125;
// Plan §1.1: the spheroid's own oscillation clock, 0.05 rad/Myr at 1 kpc,
// ∝ r^-1.5 outside (Keplerian). Used for pressure wobble frequency AND, at
// 1 kpc, to turn sigmaSpheroid into the pressure wobble amplitude scale.
const PRESSURE_CLOCK_1KPC = 0.05;
// Defaults applied once on the CPU so the shader reads plain numbers and
// hard-codes no galaxy values (wgsl-validate checks that).
const DEFAULT_R_CORE = 0.5;
const DEFAULT_SPIN = 0.1;
// Vertical wobble is ~1/5 of the horizontal at the Sun (plan §1.4 defaults:
// thin disc 0.6 / 0.12 kpc).
const VERTICAL_WOBBLE_RATIO = 0.2;
// The bar's x1 loop, as a fraction of the spheroid's own amplitude scale
// (pressureAmpScale, which is already capped at 0.3 of the bar's semimajor
// axis in fillDynamics). The loop is the bar's internal stream and has to stay
// small against the bar's own width: 0.15 of that cap is 4.5% of the bar's
// semimajor axis — the 90% outline of the bar stars drifts 0.2-0.5% over 400 Myr,
// about half the blur 0.25 costs, and the bar's flat cross-section still reads
// streaming at any slider rate.
const BAR_LOOP_FRACTION = 0.15;
// Wave-damping slider. The module default is 0 so a caller that never touches
// the slider (tests, a headless pack) stays on the 0.4.3 shear. The page sets
// WAVE_DAMPING_UI_DEFAULT at boot — measured so an arm-weighted ring at the
// Sun climbs from cosine 0.10 to ~0.6 in ~300 Myr, inside a few minutes at
// 1 Myr/s, without the s→1 glue of a full capture. Cap is 1: the capture ODE
// is nonsingular there (crest speed is exactly zero).
const WAVE_DAMPING_MAX = 1;
const WAVE_DAMPING_UI_DEFAULT = 0.6;

function familyFromFlags(flags) { return (flags & FAMILY_MASK) >>> FAMILY_SHIFT; }
function flagsWithFamily(flags, family) { return (flags & ~FAMILY_MASK) | ((family & 3) << FAMILY_SHIFT); }

// Jitter byte: low nibble epicycle phase, high nibble amplitude rank (§1.3).
function encodeJitter(phase, amplitude) {
	return (((amplitude & 15) << 4) | (phase & 15)) & 255;
}
function readOrbit(packed) {
	const flags = (packed >>> 16) & 255, jitter = (packed >>> 24) & 255;
	return { family: familyFromFlags(flags), phase: jitter & 15, amplitude: jitter >>> 4 };
}

// Catalog/landmark records carry only a colour index: O/B/A ride the pattern,
// everything else the disc (plan §1.2 for real Milky Way data). Star-record's
// SPECTRAL_CLASSES order puts O, B, A at indices 0..2.
function familyFromColorIndex(colorIndex) {
	return colorIndex <= 2 ? FAMILY_PATTERN : FAMILY_DISC;
}

function familyForStar(component, spectralClass, barred) {
	if (spectralClass === 'O' || spectralClass === 'B' || spectralClass === 'A') return FAMILY_PATTERN;
	if (component === 0 || component === 1) return FAMILY_DISC;
	if (component === 2) return barred ? FAMILY_BAR : FAMILY_PRESSURE;
	return FAMILY_PRESSURE;
}

// Normalised per-model orbit numbers with all defaults already applied —
// the single place the fallbacks live, so the shader never needs any.
// Writes into `dyn` (no allocation: callers reuse one scratch object).
function fillDynamics(dyn, model) {
	const d = (model && model.dynamics) || {};
	const trunc = (model && model.truncation) || {};
	const sph = (model && model.spheroid) || {};
	const sigmaSph = d.sigmaSpheroid || 0;
	// Plan §1.4: bulge pressure amplitudes inside a disc are capped at 0.3 of
	// the spheroid's own semimajor axis ("visual dynamical friction"); E-type
	// spheroids (no disc, vFlat 0) use the raw virial value.
	const axis = (sph.a || 1) * (sph.r0 || 1);
	dyn.vFlat = d.vFlat || 0;
	dyn.rCore = d.rCore > 0 ? d.rCore : DEFAULT_R_CORE;
	dyn.omegaPattern = d.omegaPattern || 0;
	dyn.spinLambda = d.spinLambda == null ? DEFAULT_SPIN : d.spinLambda;
	dyn.sigmaThin = d.sigmaThin || 0;
	// Virial scale evaluated on the same clock the law boils at (r = 1 kpc).
	const virial = 2 * sigmaSph / pressureClock(dyn, 1);
	dyn.pressureAmpScale = dyn.vFlat > 0 ? Math.min(virial, 0.3 * axis) : virial;
	dyn.discHeight = trunc.discHeight > 0 ? trunc.discHeight : 1e3;
	dyn.patternLock = d.patternLock ? 1 : 0;
	return dyn;
}

// Plan §1.1: ω̄, the spheroid's spin/boil clock — the *mean disc frequency*
// Ω(r) for disc-type galaxies (their spheroids are rotation-coupled), the
// Keplerian 0.05·r^−1.5 clock when the type has no disc curve (E). A single
// pressureClock for bulk spin, boil frequency and the amplitude scale.
function pressureClock(dyn, r) {
	if (dyn.vFlat > 0) return dyn.vFlat / Math.max(r, dyn.rCore);
	return PRESSURE_CLOCK_1KPC / Math.max(Math.pow(Math.max(r, 0.1), 1.5), 0.01);
}

// Bulk angular rate for one family at galactocentric radius r.
function omegaFrom(dyn, family, r) {
	if (family === FAMILY_BAR) return dyn.omegaPattern;
	if (family === FAMILY_PATTERN) {
		// A barred or armed model always carries omegaPattern > 0 (galaxy.js
		// derives it per model). A pattern with no pattern — S0/E/Irr — is not a
		// frozen star: it orbits like its disc neighbours (the Keplerian clock if
		// there is no disc at all).
		if (dyn.omegaPattern > 0) return dyn.omegaPattern;
		return dyn.vFlat > 0 ? dyn.vFlat / Math.max(r, dyn.rCore) : 0;
	}
	if (family === FAMILY_DISC) {
		// The local group rate: the stars at this radius, at their own mean
		// orbital speed. patternLock (plan §3.3) is the cosmetic rigid variant.
		if (dyn.patternLock && dyn.omegaPattern > 0) return dyn.omegaPattern;
		return dyn.vFlat > 0 ? dyn.vFlat / Math.max(r, dyn.rCore) : 0;
	}
	return dyn.spinLambda * pressureClock(dyn, r);
}

// How fast a star laps the pattern at radius r: the pattern-frame streaming
// rate. Zero at corotation (the star and the wave travel together — the
// trapped orbit), positive inside it (the star overtakes the bar from behind),
// negative outside it (the bar leaves the star behind). This is the bar's x1
// loop frequency, and it is a function of radius, not of the individual star.
function omegaStream(dyn, r) {
	const circ = dyn.vFlat > 0 ? dyn.vFlat / Math.max(r, dyn.rCore) : 0;
	return circ - dyn.omegaPattern;
}

// Slider state. One number, read by the orbit law and the uniform packer.
// Not on the model: it is a view control, like exposure, and a regenerate
// must not snap it back.
let waveDamping = 0;
function setWaveDamping(value) {
	const v = Number(value);
	waveDamping = v > WAVE_DAMPING_MAX ? WAVE_DAMPING_MAX : (v > 0 ? v : 0);
	return waveDamping;
}
function getWaveDamping() { return waveDamping; }

// χ wrapped to (-π, π]. Same floor form on both sides of the mirror.
function reduceAngle(x) {
	return x - TAU * Math.floor((x + Math.PI) * INV_TAU);
}

// Pattern-frame capture. χ is m times the azimuth from one crest; every crest
// folds to 0, so an m-arm pattern is one well. Returns the inertial rotation
// of the birth vector (unreduced — orbitPosition wraps it). α = 0 and a star
// already on the pattern (ω = Ω_p) both fall through to the plain rate.
function dampedDiscTheta(theta0, thetaArm, omega, omegaP, time, alpha, m) {
	if (time === 0 || !(alpha > 0) || !(m >= 1)) return omega * time;
	const strength = alpha > WAVE_DAMPING_MAX ? WAVE_DAMPING_MAX : alpha;
	const omegaRel = omega - omegaP;
	if (omegaRel === 0) return omega * time;
	let chi0 = reduceAngle(m * (theta0 - thetaArm));
	// tan(χ/2) diverges at the interarm boundary. Clamp one ulp inside; that
	// point is the unstable fixed point and a star there is one either way.
	const lim = Math.PI - 1e-5;
	if (chi0 > lim) chi0 = lim;
	else if (chi0 < -lim) chi0 = -lim;
	const u0 = Math.tan(chi0 * 0.5);
	const beta = strength * m * omegaRel * 0.5;
	const denom = 1 - u0 * beta * time;
	let chi;
	if (!(Math.abs(denom) > 1e-6)) chi = omegaRel > 0 ? Math.PI : -Math.PI;
	else {
		chi = 2 * Math.atan(u0 / denom);
		// atan flips when the star passes the interarm. Unwrap so χ keeps
		// moving toward the next crest instead of teleporting by one arm.
		if (denom < 0) chi += omegaRel > 0 ? TAU : -TAU;
	}
	return (chi - chi0) / m + omegaP * time;
}

function discWaveTheta(qx, qy, r, omega, omegaP, time, model) {
	if (!(waveDamping > 0) || time === 0) return omega * time;
	const arms = model && model.arms;
	if (!arms || !(arms.amp > 0) || !(arms.m >= 1) || !(arms.pitchDeg > 0) || !(arms.Rs > 0)) return omega * time;
	if (r < arms.minRadius) return omega * time;
	return dampedDiscTheta(Math.atan2(qy, qx), density.armRidgeAzimuth(model, r), omega, omegaP, time, waveDamping, arms.m);
}

function omegaFor(family, x, y, model) {
	const dyn = fillDynamics(orbitScratch, model);
	return omegaFrom(dyn, family, Math.max(Math.hypot(x, y), 0.001));
}

// sin with the argument reduced mod 2π first: WGSL sin of a large argument is
// implementation-defined, and reducing the full wobble argument (not the bulk
// theta) keeps the epicycle phase continuous when the bulk angle wraps.
function sinTau(arg) {
	const x = arg * INV_TAU;
	return Math.sin(TAU * (x - Math.floor(x)));
}

// Shared scratch: fill-then-read inside one call, single-threaded, no
// per-frame allocation (AGENTS hot-path rule).
const orbitScratch = { vFlat: 0, rCore: 0, omegaPattern: 0, spinLambda: 0, sigmaThin: 0, pressureAmpScale: 0, discHeight: 0, patternLock: 0 };

// p(T): centre + Rot_z(theta(T)) · (q + w(T) − w(0)),  q = p0 − centre.
// At T = 0 both theta and every (sinTau(arg) − sinTau(arg0)) term are exactly
// zero, so the transform is the identity (within one add's rounding).
function orbitPosition(out, x, y, z, family, phase, amplitude, time, model) {
	const dyn = fillDynamics(orbitScratch, model);
	const c = (model && model.centre) || { x: 0, y: 0, z: 0 };
	const qx = x - c.x, qy = y - c.y, qz = z - c.z;
	const r = Math.max(Math.hypot(qx, qy), 0.001);
	const omega = omegaFrom(dyn, family, r);
	// patternLock is the cosmetic rigid disc. It already has no shear to damp,
	// and applying capture on top of it would fight the flag.
	let theta = omega * time;
	if (family === FAMILY_DISC && !dyn.patternLock) theta = discWaveTheta(qx, qy, r, omega, dyn.omegaPattern, time, model);
	const u = theta * INV_TAU;
	theta = TAU * (u - Math.floor(u));
	const ph = ((phase & 15) / 16) * TAU;
	const rank = ((amplitude & 15) + 0.5) / 16;
	const sinPh = sinTau(ph);
	const sinPhV = sinTau(ph + HALF_PI);
	let wrx = 0, wry = 0, wz = 0;
	if (family === FAMILY_BAR) {
		// x1 loop: the star's circulation about its seat in the pattern frame,
		// at the rate it laps the pattern. Planar (no vertical term): the bar's
		// stars are the thin end of the spheroid and the loop is what the bar's
		// own flat cross-section can absorb.
		const stream = omegaStream(dyn, r);
		const ah = rank * BAR_LOOP_FRACTION * dyn.pressureAmpScale;
		const wr = ah * (sinTau(ph + stream * time) - sinPh);
		wrx = wr * qx / r; wry = wr * qy / r;
	} else if (family === FAMILY_DISC) {
		const kappa = SQRT2 * (dyn.vFlat / Math.max(r, dyn.rCore));
		const ah = rank * 2 * dyn.sigmaThin / Math.max(kappa, 1e-6);
		const av = Math.min(VERTICAL_WOBBLE_RATIO * ah, Math.max(dyn.discHeight - Math.abs(qz), 0));
		const wr = ah * (sinTau(ph + kappa * time) - sinPh);
		wz = av * (sinTau(ph + HALF_PI + kappa * time) - sinPhV);
		wrx = wr * qx / r; wry = wr * qy / r;
	} else if (family === FAMILY_PRESSURE) {
		const a = rank * dyn.pressureAmpScale;
		const mean = pressureClock(dyn, r);
		const wr = a * (sinTau(ph + mean * time) - sinPh);
		wz = a * (sinTau(ph + HALF_PI + mean * time) - sinPhV);
		wrx = wr * qx / r; wry = wr * qy / r;
	}
	const ct = Math.cos(theta), st = Math.sin(theta);
	const bx = qx + wrx, by = qy + wry;
	out[0] = c.x + ct * bx - st * by;
	out[1] = c.y + st * bx + ct * by;
	out[2] = c.z + qz + wz;
	return out;
}

// The four vec4s the star shader reads as camera.dynA / dynB / waveA / waveB.
// Nebulae share the buffer and ignore the wave pair (gas stays on the pattern).
// Layout contract shared with SHADER_PARTS['orbit'] and CameraUniform:
//   dynA  = (vFlat, rCore, omegaPattern, spinLambda)
//   dynB  = (sigmaThin, pressureAmpScale, discHeight, patternLock)
//   waveA = (damping, m, K, phase0)     K = m / tan(pitch), 0 when unarmed
//   waveB = (Rs, minRadius, amp, 0)
// Unarmed (amp 0, pitch 0, m < 1) packs m = 0 so the shader takes the same
// skip the CPU does, without a hard-coded galaxy.
function packOrbitDynamics(model, out, offset) {
	const dyn = fillDynamics(orbitScratch, model);
	out[offset] = dyn.vFlat;
	out[offset + 1] = dyn.rCore;
	out[offset + 2] = dyn.omegaPattern;
	out[offset + 3] = dyn.spinLambda;
	out[offset + 4] = dyn.sigmaThin;
	out[offset + 5] = dyn.pressureAmpScale;
	out[offset + 6] = dyn.discHeight;
	out[offset + 7] = dyn.patternLock;
	const arms = (model && model.arms) || {};
	const armed = arms.amp > 0 && arms.m >= 1 && arms.pitchDeg > 0 && arms.Rs > 0;
	out[offset + 8] = waveDamping;
	out[offset + 9] = armed ? arms.m : 0;
	out[offset + 10] = armed ? arms.m / Math.tan(arms.pitchDeg * Math.PI / 180) : 0;
	out[offset + 11] = armed ? arms.phase0 : 0;
	out[offset + 12] = armed ? arms.Rs : 1;
	out[offset + 13] = armed ? arms.minRadius : 0;
	out[offset + 14] = armed ? arms.amp : 0;
	out[offset + 15] = 0;
	return out;
}

function sliderValueToRate(value, speedLyPerSec) {
	if (value < 0) return (-value) * FLIGHT_TIME_GAIN * speedLyPerSec;
	return value;
}
function formatTimeRate(value, speed) { return value < 0 ? `follow ×${(-value).toFixed(1)}` : value === 0 ? 'frozen' : `+${value.toFixed(1)} Myr/s`; }

const OrbitAPI = {
	FAMILY_PATTERN, FAMILY_DISC, FAMILY_BAR, FAMILY_PRESSURE, FAMILY_NAMES,
	FAMILY_SHIFT, FAMILY_MASK, FLIGHT_TIME_GAIN, TAU, PRESSURE_CLOCK_1KPC,
	VERTICAL_WOBBLE_RATIO, BAR_LOOP_FRACTION,
	WAVE_DAMPING_MAX, WAVE_DAMPING_UI_DEFAULT,
	familyFromFlags, flagsWithFamily, encodeJitter, readOrbit,
	familyFromColorIndex, familyForStar,
	fillDynamics, pressureClock, omegaFor, omegaFrom, omegaStream,
	setWaveDamping, getWaveDamping, dampedDiscTheta, orbitPosition,
	packOrbitDynamics, sinTau, sliderValueToRate, formatTimeRate,
};
if (typeof module !== 'undefined') module.exports = OrbitAPI;
if (typeof window !== 'undefined') window.OrbitLib = OrbitAPI;
