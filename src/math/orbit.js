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
//
// Pattern speed (optional, slider — the linked demo's "Pattern Speed" control).
// Ω_p is derived per model (galaxy.js patternSpeed), so the control is a
// multiplier of it: 1 is the model's own group speed, 0 freezes the field and
// the bar while the disc streams through, 3 triples the sweep. It multiplies
// `dynamics.omegaPattern` once, in fillDynamics, so the classic law, the simple
// integrator, the bar's streaming rate, the capture and the nebula billboards
// cannot disagree about how fast the pattern turns.
'use strict';

const density = (typeof module !== 'undefined' && module.exports)
	? require('./density.js')
	: window.DensityLib;
const hash = (typeof module !== 'undefined' && module.exports)
	? require('./hash.js')
	: window.HashLib;

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
// Pattern-speed multiplier (the linked demo's "Pattern Speed" slider, our
// per-model equivalent). omegaPattern is *derived* per model (galaxy.js
// patternSpeed), so the honest control is a multiplier of that derived group
// speed, not a raw rad/Myr the user would have to re-range for every type:
//   0   frozen pattern — the field and the bar stand still, the disc streams
//       through them (the demo's Ω_p = 0 end)
//   1   the model's own derived group speed (the default)
//   3   three times as fast: corotation moves inward, the bar's stars fall
//       behind it (stream = Ω − Ω_p goes negative), the capture lane sweeps
// A model with no pattern (S0/E/Irr: omegaPattern 0) is unaffected at any
// setting — there is no field to rotate. Like wave damping, this is a view
// control: it is applied on the CPU in fillDynamics, so every consumer (both
// engines' laws, the uniform packers, the nebula billboards) sees one value,
// and a regenerate must not snap it back.
const PATTERN_SCALE_MAX = 3;
const PATTERN_SCALE_UI_DEFAULT = 1;

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
	dyn.omegaPattern = (d.omegaPattern || 0) * patternScale;
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

// Pattern-speed multiplier. Same shape as the damping control: one number, no
// model field, read every time dynamics are filled.
let patternScale = PATTERN_SCALE_UI_DEFAULT;
// The slider changes the angular rate, not the epoch.  This offset is the
// phase origin that makes an in-flight rate change continuous: when Ω changes
// at time T, the new law uses Ωnew*T + offsetNew = Ωold*T + offsetOld.
// It is deliberately global view state, just like patternScale and
// waveDamping, rather than a field/model property.
let patternPhaseOffset = 0;
function setPatternScale(value, time, model) {
	const v = Number(value);
	// NaN and negatives are the frozen end, not an error: the slider's floor is 0.
	const next = v > 0 ? (v > PATTERN_SCALE_MAX ? PATTERN_SCALE_MAX : v) : 0;
	const t = Number(time);
	if (model && Number.isFinite(t) && t !== 0 && next !== patternScale) {
		const baseOmega = model.dynamics && Number(model.dynamics.omegaPattern)
			? Number(model.dynamics.omegaPattern) : 0;
		patternPhaseOffset = wrapAngle(patternPhaseOffset + baseOmega * (patternScale - next) * t);
	}
	patternScale = next;
	return patternScale;
}
function getPatternScale() { return patternScale; }
function getPatternPhaseOffset() { return patternPhaseOffset; }
function resetPatternPhaseOffset() { patternPhaseOffset = 0; return patternPhaseOffset; }
// What the multiplier means on this model: the derived group speed times the
// multiplier, rad/Myr. 0 for a model with no pattern, at any setting.
function effectivePatternSpeed(model) {
	return fillDynamics(orbitScratch, model).omegaPattern;
}

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
	return dampedDiscTheta(Math.atan2(qy, qx), density.armRidgeAzimuth(model, r) + patternPhaseOffset, omega, omegaP, time, waveDamping, arms.m);
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

// Small, deterministic orbital inclinations.  The inclination is derived from
// the record's existing jitter byte, so no buffer expansion or per-star random
// state is needed.  Thin-disc stars stay close to the plane; bar/pressure stars
// get a wider spread.  The important distinction is that each plane is anchored
// at the common centre point, not that every star shares the z axis.
const ORBIT_INCLINATION_DISC = 0.045;
const ORBIT_INCLINATION_BAR = 0.12;
const ORBIT_INCLINATION_PRESSURE = 0.30;
function orbitInclination(family, phase, amplitude) {
	const rank = ((amplitude & 15) + 0.5) / 16;
	const direction = Math.sin(((phase & 15) / 16) * TAU);
	const max = family === FAMILY_BAR ? ORBIT_INCLINATION_BAR
		: family === FAMILY_PRESSURE ? ORBIT_INCLINATION_PRESSURE : ORBIT_INCLINATION_DISC;
	return max * rank * direction;
}

// Shared scratch: fill-then-read inside one call, single-threaded, no
// per-frame allocation (AGENTS hot-path rule).
const orbitScratch = { vFlat: 0, rCore: 0, omegaPattern: 0, spinLambda: 0, sigmaThin: 0, pressureAmpScale: 0, discHeight: 0, patternLock: 0 };

// p(T): a per-star orbital-plane rotation of q = p0 − centre plus bounded
// radial/normal wobble. At T = 0 both theta and every (sinTau(arg) −
// sinTau(arg0)) term are exactly zero, so the transform is the identity
// (within one add's rounding). Every plane still passes through `centre`.
function orbitPosition(out, x, y, z, family, phase, amplitude, time, model) {
	if (engine & ENGINE_APOCENTER) return apocenterPosition(out, x, y, z, family, phase, amplitude, time, model);
	const dyn = fillDynamics(orbitScratch, model);
	const c = (model && model.centre) || { x: 0, y: 0, z: 0 };
	const qx = x - c.x, qy = y - c.y, qz = z - c.z;
	const r = Math.max(Math.hypot(qx, qy), 0.001);
	const omega = omegaFrom(dyn, family, r);
	// patternLock is the cosmetic rigid disc. It already has no shear to damp,
	// and applying capture on top of it would fight the flag.
	let theta = omega * time;
	// Pattern/bar geometry is a stateful-looking view of an absolute clock.  The
	// phase origin keeps it continuous when the Pattern Speed slider changes;
	// without it Ωnew*T would teleport every pattern star at the instant of the
	// input event.
	if (family === FAMILY_PATTERN || family === FAMILY_BAR) {
		theta += patternPhaseOffset;
	}
	if (family === FAMILY_DISC && !dyn.patternLock) theta = discWaveTheta(qx, qy, r, omega, dyn.omegaPattern, time, model);
	const u = theta * INV_TAU;
	theta = TAU * (u - Math.floor(u));
	const ph = ((phase & 15) / 16) * TAU;
	const rank = ((amplitude & 15) + 0.5) / 16;
	const sinPh = sinTau(ph);
	const sinPhV = sinTau(ph + HALF_PI);
	let wr = 0, wz = 0;
	if (family === FAMILY_BAR) {
		// x1 loop: the star's circulation about its seat in the pattern frame,
		// at the rate it laps the pattern. Planar (no vertical term): the bar's
		// stars are the thin end of the spheroid and the loop is what the bar's
		// own flat cross-section can absorb.
		const stream = omegaStream(dyn, r);
		const ah = rank * BAR_LOOP_FRACTION * dyn.pressureAmpScale;
		wr = ah * (sinTau(ph + stream * time) - sinPh);
	} else if (family === FAMILY_DISC) {
		const kappa = SQRT2 * (dyn.vFlat / Math.max(r, dyn.rCore));
		const ah = rank * 2 * dyn.sigmaThin / Math.max(kappa, 1e-6);
		const av = Math.min(VERTICAL_WOBBLE_RATIO * ah, Math.max(dyn.discHeight - Math.abs(qz), 0));
		wr = ah * (sinTau(ph + kappa * time) - sinPh);
		wz = av * (sinTau(ph + HALF_PI + kappa * time) - sinPhV);
	} else if (family === FAMILY_PRESSURE) {
		const a = rank * dyn.pressureAmpScale;
		const mean = pressureClock(dyn, r);
		wr = a * (sinTau(ph + mean * time) - sinPh);
		wz = a * (sinTau(ph + HALF_PI + mean * time) - sinPhV);
	}
	// Every star gets its own orbital plane through the galaxy's centre.  The
	// old Rot_z transform made every 3-D star sweep around one infinite line
	// (the galaxy axis), which is visibly wrong for halo, bar and thick-disc
	// stars.  e0/e1 are a per-star plane basis: e0 is the birth radius and e1
	// is a deterministic, slightly inclined tangent.  The circle therefore
	// always has the same centre point `c`, while no single axis owns all stars.
	const radius = Math.hypot(qx, qy, qz);
	const invRadius = radius > 1e-9 ? 1 / radius : 0;
	const e0x = radius > 1e-9 ? qx * invRadius : 1;
	const e0y = radius > 1e-9 ? qy * invRadius : 0;
	const e0z = radius > 1e-9 ? qz * invRadius : 0;
	const xy = Math.hypot(qx, qy);
	let azx, azy;
	if (xy > 1e-9) { azx = -qy / xy; azy = qx / xy; }
	else { azx = 0; azy = 1; }
	const ezx = -e0z * azy;
	const ezy = e0z * azx;
	const ezz = e0x * azy - e0y * azx;
	const inc = orbitInclination(family, phase, amplitude);
	const ci = Math.cos(inc), si = Math.sin(inc);
	const e1x = azx * ci + ezx * si;
	const e1y = azy * ci + ezy * si;
	const e1z = ezz * si;
	const nx = e0y * e1z - e0z * e1y;
	const ny = e0z * e1x - e0x * e1z;
	const nz = e0x * e1y - e0y * e1x;
	const ct = Math.cos(theta), st = Math.sin(theta);
	const rx = e0x * ct + e1x * st;
	const ry = e0y * ct + e1y * st;
	const rz = e0z * ct + e1z * st;
	// There is no meaningful radial direction at the exact centre; keep a
	// central star at the centre instead of applying a basis-dependent wobble.
	const orbitRadius = radius > 1e-9 ? radius + wr : 0;
	const normalWobble = radius > 1e-9 ? wz : 0;
	out[0] = c.x + orbitRadius * rx + normalWobble * nx;
	out[1] = c.y + orbitRadius * ry + normalWobble * ny;
	out[2] = c.z + orbitRadius * rz + normalWobble * nz;
	return out;
}

const APOCENTER_ECC_MAX = 0.45;
const APOCENTER_ECC_CAP = 0.55;
// The menu's startup values (also the Defaults button and the presets module):
// share 0.35 mixes the pass spatially without a visible front slice, force
// 0.22 is the measured noise floor of the guided pull.
const APOCENTER_SHARE_UI_DEFAULT = 0.35;
const APOCENTER_FORCE_UI_DEFAULT = 0.22;
// Apocenter controls are intentionally view state: they can be tuned without
// rebuilding the sampled galaxy. Share is a deterministic per-star mask, so
// lowering it reduces noise instead of making an arbitrary front slice vanish.
let apocenterShare = 1;
let apocenterForce = APOCENTER_ECC_MAX;
function setApocenterShare(value) { apocenterShare = Math.max(0, Math.min(1, Number(value) || 0)); return apocenterShare; }
function setApocenterForce(value) { apocenterForce = Math.max(0, Math.min(APOCENTER_ECC_CAP, Number(value) || 0)); return apocenterForce; }
function getApocenterShare() { return apocenterShare; }
function getApocenterForce() { return apocenterForce; }
const selectorF32 = new Float32Array(3);
const selectorBits = new Uint32Array(selectorF32.buffer);

// Hash the birth f32 bit patterns, exactly as the shader bitcasts them: a
// sin() hash of kpc-scale arguments diverges between f64 and GPU f32.
function apocenterSelected(x, y, z) {
	selectorF32[0] = x; selectorF32[1] = y; selectorF32[2] = z;
	return hash.hash01(hash.hash4(selectorBits[0], selectorBits[1], selectorBits[2], 9137)) < apocenterShare;
}

function apocenterAngle(theta, radius, family, model) {
	const arms = model && model.arms;
	if ((family === FAMILY_DISC || family === FAMILY_PATTERN)
		&& arms && arms.amp > 0 && arms.m >= 1 && arms.pitchDeg > 0 && arms.Rs > 0
		&& radius >= (arms.minRadius || 0)) {
		const ridge = density.armRidgeAzimuth(model, radius);
		return ridge + Math.floor((theta - ridge) * arms.m / TAU + 0.5) * TAU / arms.m;
	}
	if (family === FAMILY_BAR) {
		const tilt = ((model && model.spheroid && model.spheroid.tiltDeg) || 0) * Math.PI / 180;
		return tilt + Math.floor((theta - tilt) / Math.PI + 0.5) * Math.PI;
	}
	return theta;
}

function solveEccentricAnomaly(mean, eccentricity) {
	const M = reduceAngle(mean);
	let E = M;
	for (let i = 0; i < 5; i++) {
		E -= (E - eccentricity * Math.sin(E) - M) / (1 - eccentricity * Math.cos(E));
	}
	return E;
}

// Analytic Kepler ellipse with its apocenter aligned to the nearest density
// ridge. Five Newton steps are bounded by e <= 0.55 and need no per-star state.
function apocenterPosition(out, x, y, z, family, phase, amplitude, time, model) {
	if (time === 0 || !apocenterSelected(x, y, z)) {
		out[0] = x; out[1] = y; out[2] = z;
		return out;
	}
	const dyn = fillDynamics(orbitScratch, model);
	const c = (model && model.centre) || { x: 0, y: 0, z: 0 };
	const qx = x - c.x, qy = y - c.y, qz = z - c.z;
	const radius = Math.hypot(qx, qy, qz);
	if (!(radius > 1e-9)) {
		out[0] = c.x; out[1] = c.y; out[2] = c.z;
		return out;
	}
	const theta0 = Math.atan2(qy, qx);
	const R = Math.max(Math.hypot(qx, qy), 0.001);
	const apo = apocenterAngle(theta0, R, family, model);
	const delta0 = reduceAngle(apo + Math.PI - theta0);
	const rank = ((amplitude & 15) + 0.5) / 16;
	const eccentricity = Math.min(APOCENTER_ECC_CAP, apocenterForce * rank);
	const root = Math.sqrt(1 - eccentricity * eccentricity);
	const cosF = Math.cos(delta0), sinF = -Math.sin(delta0);
	const E0 = Math.atan2(root * sinF, eccentricity + cosF);
	const M0 = E0 - eccentricity * Math.sin(E0);
	const a = radius * (1 + eccentricity * cosF) / (1 - eccentricity * eccentricity);
	const localOmega = dyn.vFlat > 0
		? dyn.vFlat / Math.max(R, dyn.rCore)
		: pressureClock(dyn, R);
	const mean = M0 + (localOmega - dyn.omegaPattern) * time - patternPhaseOffset;
	const E = solveEccentricAnomaly(mean, eccentricity);
	const nu = Math.atan2(root * Math.sin(E), Math.cos(E) - eccentricity);
	const orbitRadius = a * (1 - eccentricity * Math.cos(E));
	const delta = delta0 + dyn.omegaPattern * time + patternPhaseOffset;
	const e0x = qx / radius, e0y = qy / radius, e0z = qz / radius;
	const xy = Math.hypot(qx, qy);
	const azx = xy > 1e-9 ? -qy / xy : 0;
	const azy = xy > 1e-9 ? qx / xy : 1;
	const ezx = -e0z * azy, ezy = e0z * azx, ezz = e0x * azy - e0y * azx;
	const inc = orbitInclination(family, phase, amplitude);
	const ci = Math.cos(inc), si = Math.sin(inc);
	const e1x = azx * ci + ezx * si, e1y = azy * ci + ezy * si, e1z = ezz * si;
	const cd = Math.cos(delta), sd = Math.sin(delta);
	const cv = Math.cos(nu), sv = Math.sin(nu);
	const px = e0x * cd + e1x * sd, py = e0y * cd + e1y * sd, pz = e0z * cd + e1z * sd;
	const qpx = -e0x * sd + e1x * cd, qpy = -e0y * sd + e1y * cd, qpz = -e0z * sd + e1z * cd;
	out[0] = c.x + orbitRadius * (px * cv + qpx * sv);
	out[1] = c.y + orbitRadius * (py * cv + qpy * sv);
	out[2] = c.z + orbitRadius * (pz * cv + qpz * sv);
	return out;
}

// The four vec4s the star shader reads as camera.dynA / dynB / waveA / waveB.
// Nebulae share the buffer and ignore the wave pair (gas stays on the pattern).
// Layout contract shared with SHADER_PARTS['orbit'] and CameraUniform:
//   dynA  = (vFlat, rCore, omegaPattern, spinLambda)
//   dynB  = (sigmaThin, pressureAmpScale, discHeight, patternLock)
//   waveA = (damping, m, K, phase0)     K = m / tan(pitch), 0 when unarmed
//   waveB = (Rs, minRadius, amp, patternPhaseOffset)
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
	out[offset + 15] = patternPhaseOffset;
	return out;
}

function sliderValueToRate(value, speedLyPerSec) {
	if (value < 0) return (-value) * FLIGHT_TIME_GAIN * speedLyPerSec;
	return value;
}
function formatTimeRate(value, speed) { return value < 0 ? `follow ×${(-value).toFixed(1)}` : value === 0 ? 'frozen' : `+${value.toFixed(1)} Myr/s`; }

// ---- 0.4.5 simple (friction-field) engine ----------------------------------
//
// A port of the linked galaxy-star-movement-demo slow field
// (simple/simple-friction-field-webGPU.html), selected from the menu as the
// `simple` engine. Where the classic law above is an exact closed form with
// singular branches, this one is a dissipative integration: one azimuth per
// star, stepped on a GPU compute pass, slowed inside the arm Gaussian. The
// slowdown can never reverse or diverge, which is the stability the option
// exists for; the price is state (entering `simple` re-seeds from the birth
// field) and the inertial form's honest physics — it jams inside corotation
// and streams outside it (archive/damping-plan-report.md).
//
// The demo's structure is kept verbatim (eccentric rho from the current theta,
// Gaussian D on the log-spiral phase, pattern phase accumulated separately);
// its hand-tuned constants are derived per galaxy type instead. Deliberately
// not ported: the pink arm tint (real spectral types must not be tinted by
// position) and the z(theta) redistribution; the orbit-plane transform is
// instead anchored at the galaxy centre and keeps each star's orbital radius.

const ENGINE_CLASSIC = 1, ENGINE_SIMPLE = 2, ENGINE_APOCENTER = 4;
const ENGINE_NAMES = ['classic', 'simple', 'apocenter'];
let engine = ENGINE_CLASSIC;
function setEngine(id) {
	if (Array.isArray(id)) { engine = id.reduce((mask, name) => mask | (name === 'simple' ? ENGINE_SIMPLE : name === 'apocenter' ? ENGINE_APOCENTER : ENGINE_CLASSIC), 0); }
	else if (typeof id === 'number') engine = id & 7;
	else engine = id === 'apocenter' ? ENGINE_APOCENTER : id === 'simple' ? ENGINE_SIMPLE : ENGINE_CLASSIC;
	if (!engine) engine = ENGINE_CLASSIC;
	return engine;
}
function getEngine() { return engine; }
function engineName() {
	// The lane is a mask, so the friendly name is the enabled passes joined in
	// order; the bare classic bit (or an empty selection) reports 'classic'.
	const names = [];
	if (engine & ENGINE_SIMPLE) names.push('simple');
	if (engine & ENGINE_APOCENTER) names.push('apocenter');
	return names.length ? names.join(' ') : 'classic';
}

// Demo anchors: sigma 0.25 rad at m = 2 / pitch 15 deg, eccMax 0.2. The sigma
// scales with the pattern's own arm spacing (narrower spacing, narrower lane)
// and never bridges half the interarm; the eccentricity follows the thin-disc
// dispersion the same 2sigma/kappa ratio the epicycle law uses, times ECC_K.
const SIMPLE_SIGMA_BASE = 0.25;
const SIMPLE_SIGMA_PITCH_REF = 15 * Math.PI / 180;
const SIMPLE_SIGMA_MIN = 0.03;
const SIMPLE_ECC_K = 0.75;
const SIMPLE_ECC_MAX = 0.6;
// Euler substeps: at most 0.15 rad per substep, at most 8 substeps a frame. A
// tab-switch spike at max rate degrades one frame instead of exploding.
const SIMPLE_SUBSTEP_DTHETA = 0.15;
const SIMPLE_SUBSTEP_MAX = 8;
// Rate floor: a star at the centre rides the pattern instead of taking log(0).
const SIMPLE_R_MIN = 0.001;
const SIMPLE_UNIFORM_FLOATS = 20;

function simpleArmed(model) {
	const arms = model && model.arms;
	return !!(arms && arms.amp > 0 && arms.m >= 1 && arms.pitchDeg > 0 && arms.Rs > 0);
}

function simpleSigma(model) {
	const arms = model.arms;
	if (!(arms.m >= 1) || !(arms.pitchDeg > 0)) return 0;
	const armOffset = TAU / arms.m;
	let sigma = SIMPLE_SIGMA_BASE * (armOffset / Math.PI)
		* (Math.sin(arms.pitchDeg * Math.PI / 180) / Math.sin(SIMPLE_SIGMA_PITCH_REF));
	const cap = armOffset / 4;
	if (sigma > cap) sigma = cap;
	if (sigma < SIMPLE_SIGMA_MIN) sigma = SIMPLE_SIGMA_MIN;
	return sigma;
}

function simpleEccMax(model) {
	const d = (model && model.dynamics) || {};
	if (!(d.vFlat > 0)) return 0;
	const e = SIMPLE_ECC_K * 2 * (d.sigmaThin || 0) / d.vFlat;
	return e > SIMPLE_ECC_MAX ? SIMPLE_ECC_MAX : (e > 0 ? e : 0);
}

// One Euler right-hand side. P is simpleDerived(model): vFlat, rCore, omegaP,
// spinLambda double as the pressureClock dyn. theta/rho are current, r0 is
// birth; the minRadius skip reads birth so a star never flickers across it.
function simpleOmega(theta, r0, eccU, peri, family, P, patternPhase, z = 0) {
	// A disk is not infinitely thin: the arm/bar field is the in-plane
	// component of a 3-D restoring field.  Its strength follows the cosine
	// law of the distance from the mid-plane, rather than treating a star at
	// the edge of the thick disk like one in the plane.
	const h = Math.max(P.verticalScale || 1, 1e-3);
	const vertical = Math.max(0, Math.cos(Math.min(Math.abs(z) / h, 1) * HALF_PI));
	if (family === FAMILY_BAR) {
		const circ = P.vFlat > 0 ? P.vFlat / Math.max(r0, P.rCore) : 0;
		const rel = circ - P.omegaP;
		// Two-ended bar field. Stars on the major axis are captured by the
		// rotating bar, while stars in its wings stream through it. This small
		// differential term is what prevents a rigid, glued-on bar.
		let d = theta - (P.barTilt || 0);
		d -= TAU * Math.round(d / TAU);
		const axis = Math.cos(d * 2);
		const capture = Math.exp(-((1 - axis) * (1 - axis)) * 3.0) * vertical;
		return P.omegaP + rel * (0.38 + 0.62 * (1 - capture));
	}
	if (family === FAMILY_PRESSURE) return P.spinLambda * pressureClock(P, r0);
	const rr = r0 < SIMPLE_R_MIN ? SIMPLE_R_MIN : r0;
	const rho = rr * (1 + P.eccMax * eccU * Math.cos(theta - peri));
	const circ = P.vFlat / Math.max(rho, P.rCore);
	if (!P.armed || r0 < P.minRadius) return circ;
	const base = Math.log(rho / P.Rs) * P.invTanPitch + patternPhase;
	let delta = (theta - base) % P.armOffset;
	if (delta < 0) delta += P.armOffset;
	if (delta > P.armOffset * 0.5) delta -= P.armOffset;
	// The planar limit remains the familiar P.damping * Math.exp lane.
	const damp = vertical * Math.exp(-delta * delta * P.inv2sig2);
	return circ * (1 - P.damping * damp);
}

function simpleEccOf(jitter) { return (((jitter >>> 4) & 15) + 0.5) / 16; }
function simplePeriOf(jitter) { return ((jitter & 15) / 16) * TAU; }

// Per-model simple numbers, defaults applied, no allocation. damping is the
// shared wave slider, read live so the compute uniform never goes stale.
const simpleScratch = {
	vFlat: 0, rCore: DEFAULT_R_CORE, omegaP: 0, spinLambda: DEFAULT_SPIN,
	m: 0, invTanPitch: 0, armOffset: TAU, inv2sig2: 0, Rs: 1, minRadius: 0,
	eccMax: 0, damping: 0, armed: false, barTilt: 0, verticalScale: 1,
};
function simpleDerived(model, out) {
	const P = out || simpleScratch;
	const dyn = fillDynamics(orbitScratch, model);
	P.vFlat = dyn.vFlat;
	P.rCore = dyn.rCore;
	P.omegaP = dyn.omegaPattern;
	P.spinLambda = dyn.spinLambda;
	P.barTilt = model && model.spheroid ? (model.spheroid.tiltDeg || 0) * Math.PI / 180 : 0;
	P.verticalScale = model && model.truncation ? (model.truncation.discHeight || 1) : 1;
	P.armed = simpleArmed(model);
	if (P.armed) {
		const arms = model.arms;
		P.m = arms.m;
		P.invTanPitch = 1 / Math.tan(arms.pitchDeg * Math.PI / 180);
		P.armOffset = TAU / arms.m;
		const sig = simpleSigma(model);
		P.inv2sig2 = 1 / (2 * sig * sig);
		P.Rs = arms.Rs;
		P.minRadius = arms.minRadius;
	} else {
		P.m = 0;
		P.invTanPitch = 0;
		P.armOffset = TAU;
		P.inv2sig2 = 0;
		P.Rs = 1;
		P.minRadius = 0;
	}
	P.eccMax = simpleEccMax(model);
	P.damping = waveDamping;
	return P;
}

// Representative max rate over the families, for the substep count. Inner E
// stars can exceed it; the step is still bounded, just coarser there.
function simpleOmegaMax(P) {
	const disc = P.vFlat > 0 ? P.vFlat / Math.max(P.rCore, 1e-3) : 0;
	const press = P.spinLambda * pressureClock(P, Math.max(P.rCore, 0.1));
	let m = disc > press ? disc : press;
	if (P.omegaP > m) m = P.omegaP;
	return m > 1e-6 ? m : 1e-6;
}

const simpleStepScratch = { n: 1, h: 0 };
function simpleSubsteps(dtStar, omegaMax, out) {
	const sub = out || simpleStepScratch;
	if (!(dtStar > 0) || !(omegaMax > 0)) { sub.n = 0; sub.h = 0; return sub; }
	let n = Math.ceil(omegaMax * dtStar / SIMPLE_SUBSTEP_DTHETA);
	if (n < 1) n = 1;
	else if (n > SIMPLE_SUBSTEP_MAX) n = SIMPLE_SUBSTEP_MAX;
	sub.n = n;
	sub.h = dtStar / n;
	return sub;
}

function wrapAngle(x) {
	const u = x * INV_TAU;
	return TAU * (u - Math.floor(u));
}

// The pattern phase is derived per frame from the f64 star time, never a
// second accumulator, so it cannot diverge from T across engine switches and
// nebulae need no engine branch (their theta is the same product in f32).
// It is the crest's inertial azimuth offset: the classic capture measures the
// star against density.armRidgeAzimuth, whose ridge sits at
// (K·ln(R/Rs) − phase0)/m, so the simple lane's base K·ln(ρ/Rs) + Φp must carry
// Φp = Ω_p·T − phase0/m or the friction field would sit off the arms it is
// supposed to be the jam of (phase0 is 0 for the Milky Way preset and nonzero
// for every type whose arms are solved to leave the bar's end).
function simplePatternPhase(model, starTimeMyr) {
	const dyn = fillDynamics(orbitScratch, model);
	const w = dyn.omegaPattern > 0 ? dyn.omegaPattern : 0;
	const arms = (model && model.arms) || {};
	const m = arms.m >= 1 ? arms.m : 1;
	const phase0 = arms.m >= 1 ? (arms.phase0 || 0) : 0;
	const elapsed = w > 0 && Number.isFinite(starTimeMyr) && starTimeMyr > 0 ? w * starTimeMyr : 0;
	return wrapAngle(elapsed + patternPhaseOffset - phase0 / m);
}

// CPU reference step: one star, substepped Euler, pattern held per frame like
// the GPU dispatch. Landmarks and tests step through here, so it takes the same
// (theta, r0, z) triple the compute kernel reads from its record — z included,
// or the reference would silently run the planar limit while the GPU runs the
// 3-D field (that 0.12 kpc disagreement is what the landmark check caught).
function simpleStepTheta(theta, r0, eccU, peri, family, P, patternPhase, dtStar, z = 0) {
	if (!(dtStar > 0)) return theta;
	const sub = simpleSubsteps(dtStar, simpleOmegaMax(P), simpleStepScratch);
	let th = theta;
	for (let s = 0; s < sub.n; s++) th += simpleOmega(th, r0, eccU, peri, family, P, patternPhase, z) * sub.h;
	return wrapAngle(th);
}

// Vertex mirror: birth record + integrated theta = position. Family-agnostic
// except for the eccentric rho, which only disc/pattern carry. The orbit plane
// is 3-D, so even the birth height participates in the centre-point orbit.
function simplePositionFromTheta(out, theta, x, y, z, jitter, family, eccMax, model) {
	const c = (model && model.centre) || { x: 0, y: 0, z: 0 };
	const qx = x - c.x, qy = y - c.y, qz = z - c.z;
	const radius = Math.hypot(qx, qy, qz);
	const invRadius = radius > 1e-9 ? 1 / radius : 0;
	const e0x = radius > 1e-9 ? qx * invRadius : 1;
	const e0y = radius > 1e-9 ? qy * invRadius : 0;
	const e0z = radius > 1e-9 ? qz * invRadius : 0;
	const xy = Math.hypot(qx, qy);
	let azx, azy;
	if (xy > 1e-9) { azx = -qy / xy; azy = qx / xy; }
	else { azx = 0; azy = 1; }
	const ezx = -e0z * azy;
	const ezy = e0z * azx;
	const ezz = e0x * azy - e0y * azx;
	const inc = orbitInclination(family, jitter & 15, jitter >>> 4);
	const ci = Math.cos(inc), si = Math.sin(inc);
	const e1x = azx * ci + ezx * si;
	const e1y = azy * ci + ezy * si;
	const e1z = ezz * si;
	const theta0 = Math.atan2(qy, qx);
	const delta = theta - theta0;
	let rho = radius;
	if ((family === FAMILY_DISC || family === FAMILY_PATTERN) && eccMax > 0 && radius > 0) {
		rho = radius * (1 + eccMax * simpleEccOf(jitter) * Math.cos(theta - simplePeriOf(jitter)));
	}
	const ct = Math.cos(delta), st = Math.sin(delta);
	out[0] = c.x + rho * (e0x * ct + e1x * st);
	out[1] = c.y + rho * (e0y * ct + e1y * st);
	out[2] = c.z + rho * (e0z * ct + e1z * st);
	return out;
}

// Landmark mirror: one theta per named star on the CPU, stepped per frame
// beside the GPU buffer (no readback, per the indirect-draw rule). Init from
// the birth positions on boot, regenerate and engine switch; step alongside
// the frame's dtStar. f64 like the classic mirror, with the same f64-vs-f32
// bound test.
let simpleLMTheta = null;
let simpleLMR0 = null;
let simpleLMZ = null;
let simpleLandmarkQX = null, simpleLandmarkQY = null, simpleLandmarkQZ = null;
let simpleLMFam = null;
let simpleLMCount = 0;
let simpleLMModel = null;
let simpleLMEcc = 0;
function simpleLandmarksInit(positions, colorIndices, count, model) {
	if (!simpleLMTheta || simpleLMTheta.length < count) {
		simpleLMTheta = new Float64Array(count);
		simpleLMR0 = new Float64Array(count);
		simpleLMZ = new Float64Array(count);
		simpleLandmarkQX = new Float64Array(count);
		simpleLandmarkQY = new Float64Array(count);
		simpleLandmarkQZ = new Float64Array(count);
		simpleLMFam = new Uint8Array(count);
	}
	const c = (model && model.centre) || { x: 0, y: 0, z: 0 };
	for (let i = 0; i < count; i++) {
		const qx = positions[i * 3] - c.x, qy = positions[i * 3 + 1] - c.y;
		simpleLMTheta[i] = Math.atan2(qy, qx);
		simpleLMR0[i] = Math.hypot(qx, qy);
		simpleLMZ[i] = positions[i * 3 + 2] - c.z;
		simpleLandmarkQX[i] = qx;
		simpleLandmarkQY[i] = qy;
		simpleLandmarkQZ[i] = positions[i * 3 + 2] - c.z;
		simpleLMFam[i] = familyFromColorIndex(colorIndices[i]);
	}
	simpleLMCount = count;
	simpleLMModel = model || null;
	simpleLMEcc = simpleEccMax(model);
	return count;
}
function simpleLandmarksReady() { return simpleLMModel !== null && simpleLMCount > 0; }
function simpleLandmarksStep(dtStar, starTimeMyr) {
	if (!simpleLandmarksReady() || !(dtStar > 0)) return 0;
	const P = simpleDerived(simpleLMModel, simpleScratch);
	const patternPhase = simplePatternPhase(simpleLMModel, starTimeMyr);
	const sub = simpleSubsteps(dtStar, simpleOmegaMax(P), simpleStepScratch);
	const eccU = simpleEccOf(0), peri = simplePeriOf(0);
	for (let i = 0; i < simpleLMCount; i++) {
		let th = simpleLMTheta[i];
		const r0 = simpleLMR0[i], fam = simpleLMFam[i];
		for (let s = 0; s < sub.n; s++) th += simpleOmega(th, r0, eccU, peri, fam, P, patternPhase, simpleLMZ[i]) * sub.h;
		simpleLMTheta[i] = wrapAngle(th);
	}
	return simpleLMCount;
}
function simpleLandmarkPosition(out, i, z) {
	const c = simpleLMModel.centre;
	const th = simpleLMTheta[i];
	const fam = simpleLMFam[i];
	const qx = simpleLandmarkQX[i], qy = simpleLandmarkQY[i], qz = simpleLandmarkQZ[i];
	const radius = Math.hypot(qx, qy, qz);
	const invRadius = radius > 1e-9 ? 1 / radius : 0;
	const e0x = radius > 1e-9 ? qx * invRadius : 1;
	const e0y = radius > 1e-9 ? qy * invRadius : 0;
	const e0z = radius > 1e-9 ? qz * invRadius : 0;
	const xy = Math.hypot(qx, qy);
	let azx, azy;
	if (xy > 1e-9) { azx = -qy / xy; azy = qx / xy; }
	else { azx = 0; azy = 1; }
	const ezx = -e0z * azy;
	const ezy = e0z * azx;
	const ezz = e0x * azy - e0y * azx;
	const inc = orbitInclination(fam, 0, 0);
	const ci = Math.cos(inc), si = Math.sin(inc);
	const e1x = azx * ci + ezx * si;
	const e1y = azy * ci + ezy * si;
	const e1z = ezz * si;
	const theta0 = Math.atan2(qy, qx);
	const delta = th - theta0;
	let rho = radius;
	if ((fam === FAMILY_DISC || fam === FAMILY_PATTERN) && simpleLMEcc > 0 && rho > 0) {
		rho *= 1 + simpleLMEcc * simpleEccOf(0) * Math.cos(th - simplePeriOf(0));
	}
	const ct = Math.cos(delta), st = Math.sin(delta);
	out[0] = c.x + rho * (e0x * ct + e1x * st);
	out[1] = c.y + rho * (e0y * ct + e1y * st);
	out[2] = c.z + rho * (e0z * ct + e1z * st);
	return out;
}

// Compute uniform, 20 floats, packed per frame while the simple engine runs:
//   stepA = (h, nSub, count, patternPhase)
//   stepB = (vFlat, rCore, omegaP, spinLambda)
//   stepC = (eccMax, m, invTanPitch, armOffset)
//   stepD = (inv2sig2, Rs, minRadius, centreX)
//   stepE = (damping, centreY, barTilt, verticalScale)
// The last lane is deliberately geometry, not a constant: it makes the same
// friction field work for every galaxy type and for stars above the plane.
// Unarmed packs m = 0, the same skip contract as the wave pair.
function packSimpleParams(model, out, offset, dtStar, count, starTimeMyr) {
	const P = simpleDerived(model, simpleScratch);
	const sub = simpleSubsteps(dtStar, simpleOmegaMax(P), simpleStepScratch);
	const c = (model && model.centre) || { x: 0, y: 0, z: 0 };
	out[offset] = sub.h;
	out[offset + 1] = sub.n;
	out[offset + 2] = count;
	out[offset + 3] = simplePatternPhase(model, starTimeMyr);
	out[offset + 4] = P.vFlat;
	out[offset + 5] = P.rCore;
	out[offset + 6] = P.omegaP;
	out[offset + 7] = P.spinLambda;
	out[offset + 8] = P.eccMax;
	out[offset + 9] = P.m;
	out[offset + 10] = P.invTanPitch;
	out[offset + 11] = P.armOffset;
	out[offset + 12] = P.inv2sig2;
	out[offset + 13] = P.Rs;
	out[offset + 14] = P.minRadius;
	out[offset + 15] = c.x;
	out[offset + 16] = P.damping;
	out[offset + 17] = c.y;
	out[offset + 18] = P.barTilt;
	out[offset + 19] = P.verticalScale;
	return out;
}

// CameraUniform engine vec4 at offset 44: the 0.4.7 lane is
// (mask, apocenterForce, barTilt, apocenterShare) — a bit mask, not an id.
// The vertex stage tests mask bits 2 and 4; apocenter reads the force and the
// model-derived bar angle, simple reads the integrated azimuths instead.
// Pattern phase remains in the orbit uniform.
function packEngineVec(model, out, offset) {
	out[offset] = engine;
	// y is the apocenter force; simple uses a conservative fixed eccentricity
	// when both engines are enabled.
	out[offset + 1] = apocenterForce;
	out[offset + 2] = engine === ENGINE_APOCENTER
		? (((model && model.spheroid && model.spheroid.tiltDeg) || 0) * Math.PI / 180) : 0;
	out[offset + 3] = apocenterShare;
	return out;
}

const OrbitAPI = {
	FAMILY_PATTERN, FAMILY_DISC, FAMILY_BAR, FAMILY_PRESSURE, FAMILY_NAMES,
	FAMILY_SHIFT, FAMILY_MASK, FLIGHT_TIME_GAIN, TAU, PRESSURE_CLOCK_1KPC,
	VERTICAL_WOBBLE_RATIO, BAR_LOOP_FRACTION,
	WAVE_DAMPING_MAX, WAVE_DAMPING_UI_DEFAULT,
	PATTERN_SCALE_MAX, PATTERN_SCALE_UI_DEFAULT,
	ORBIT_INCLINATION_DISC, ORBIT_INCLINATION_BAR, ORBIT_INCLINATION_PRESSURE, orbitInclination,
	ENGINE_CLASSIC, ENGINE_SIMPLE, ENGINE_APOCENTER, ENGINE_NAMES,
	APOCENTER_ECC_MAX, APOCENTER_ECC_CAP, APOCENTER_SHARE_UI_DEFAULT, APOCENTER_FORCE_UI_DEFAULT,
	SIMPLE_SIGMA_BASE, SIMPLE_ECC_MAX, SIMPLE_SUBSTEP_DTHETA, SIMPLE_SUBSTEP_MAX,
	SIMPLE_R_MIN, SIMPLE_UNIFORM_FLOATS,
	familyFromFlags, flagsWithFamily, encodeJitter, readOrbit,
	familyFromColorIndex, familyForStar,
	fillDynamics, pressureClock, omegaFor, omegaFrom, omegaStream,
	setWaveDamping, getWaveDamping, setPatternScale, getPatternScale, getPatternPhaseOffset, resetPatternPhaseOffset, effectivePatternSpeed,
	dampedDiscTheta, orbitPosition, apocenterPosition, apocenterAngle, solveEccentricAnomaly,
	packOrbitDynamics, sinTau, sliderValueToRate, formatTimeRate,
	setEngine, getEngine, engineName,
	setApocenterShare, setApocenterForce, getApocenterShare, getApocenterForce, apocenterSelected,
	simpleArmed, simpleSigma, simpleEccMax, simpleOmega, simpleEccOf, simplePeriOf,
	simpleDerived, simpleOmegaMax, simpleSubsteps, wrapAngle, simplePatternPhase,
	simpleStepTheta, simplePositionFromTheta,
	simpleLandmarksInit, simpleLandmarksReady, simpleLandmarksStep, simpleLandmarkPosition,
	packSimpleParams, packEngineVec,
};
if (typeof module !== 'undefined') module.exports = OrbitAPI;
if (typeof window !== 'undefined') window.OrbitLib = OrbitAPI;
