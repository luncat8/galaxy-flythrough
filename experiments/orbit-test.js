// experiments/orbit-test.js
// The 0.4 orbit law, on the numbers of plan §1.1/§1.4 of
// 0.4.0-plan-star-move.md plus the 0.4.1 group-kinematics amendment:
//
//   * T = 0 is the identity for every family
//   * reference periods (solar circle, bar/pattern, group zone, halo clock)
//   * the corotation GROUP ZONE: the bar, the arms and the disc inside
//     R_CR = vFlat/omegaPattern share one angular speed; the lock is
//     continuous at R_CR and never engages without a pattern
//   * patternLock extends the lock to all radii; omegaPattern = 0 never
//     freezes a disc (S0/E guard)
//   * family bit round-trips, family tables, colour-index rule
//   * wobble phases stay continuous when the bulk angle wraps
//   * the uniform packer emits exactly what camera.dynA/dynB carry
//   * CPU (f64) vs an f32 replay of the WGSL arithmetic — the numeric half of
//     the GPU mirror contract (wgsl-validate.js holds the symbolic half)
//
// Output: experiments/logs/orbit.json

'use strict';

const fs = require('fs');
const path = require('path');

const orbit = require('../src/math/orbit.js');
const galaxy = require('../src/math/galaxy.js');
const records = require('../src/math/star-record.js');

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
	return !!pass;
}

const MW = galaxy.MILKY_WAY;
const M32 = galaxy.createGalaxy({ type: 'E4', seed: 1234 });
const S0 = galaxy.createGalaxy({ type: 'S0', seed: 99 });
const SB = galaxy.createGalaxy({ type: 'Sa', seed: 7 });
const out = new Float64Array(3);
const EPS = 1e-9;

function dist3(a, b) {
	return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// --- 1. T = 0 identity ---------------------------------------------------
{
	const fixtures = [
		[9, 1, 0.1, orbit.FAMILY_PATTERN, 5, 9],
		[9, 1, 0.1, orbit.FAMILY_DISC, 3, 7],
		[9, 1, 0.1, orbit.FAMILY_BAR, 0, 0],
		[8.5, -2, 0.4, orbit.FAMILY_PRESSURE, 11, 4],
		[0.0, 0.0, 0.0, orbit.FAMILY_DISC, 1, 15],
	];
	let worst = 0;
	for (const [x, y, z, fam, ph, amp] of fixtures) {
		orbit.orbitPosition(out, x, y, z, fam, ph, amp, 0, MW);
		worst = Math.max(worst, dist3(out, [x, y, z]));
	}
	check('T = 0 is the identity for every family (|Δ| < 1e-9 kpc)', worst < EPS, worst);
}

// --- 2. Reference periods (plan §1.1) ------------------------------------
{
	// omegaFor takes galactocentric coordinates (the law's q frame).
	const sunR = Math.hypot(MW.centre.x, MW.centre.y);
	const wSun = orbit.omegaFor(orbit.FAMILY_DISC, sunR, 0, MW);
	const tSun = orbit.TAU / wSun;
	check('solar circle R = 8.2 kpc turns in 229 ± 2 Myr',
		Math.abs(tSun - 229) < 2, { omega: wSun, period: tSun });

	const wBar = orbit.omegaFor(orbit.FAMILY_BAR, 1, 0, MW);
	const tBar = orbit.TAU / wBar;
	check('bar/pattern period 154 ± 1 Myr (omegaPattern = 0.041)',
		Math.abs(tBar - 154) < 1, { omega: wBar, period: tBar });

	// Group zone: a disc star inside corotation rides the pattern exactly.
	const rCr = MW.dynamics.vFlat / MW.dynamics.omegaPattern;
	const wIn = orbit.omegaFor(orbit.FAMILY_DISC, rCr - 0.5, 0, MW);
	check(`disc inside corotation (R_CR = ${rCr.toFixed(2)} kpc) locks to the pattern speed`,
		wIn === MW.dynamics.omegaPattern, { wIn });

	// Continuity at R_CR: Omega(R) crosses omegaPattern there, so the two
	// branches agree and the seam cannot show as a shear ring.
	const wBelow = orbit.omegaFor(orbit.FAMILY_DISC, rCr - 1e-6, 0, MW);
	const wAbove = orbit.omegaFor(orbit.FAMILY_DISC, rCr + 1e-6, 0, MW);
	check('the group-zone lock is continuous at R_CR (|Δω| < 1e-6)',
		Math.abs(wBelow - wAbove) < 1e-6, { wBelow, wAbove });

	const wOut = orbit.omegaFor(orbit.FAMILY_DISC, 12, 0, MW);
	check('outside R_CR the disc keeps differential rotation (ω = vFlat/R)',
		Math.abs(wOut - MW.dynamics.vFlat / 12) < 1e-12, { wOut });
}

// --- 3. Guards: no pattern, no accidental freeze -------------------------
{
	const s0 = orbit.fillDynamics({}, S0);
	check('S0 (omegaPattern = 0) never locks: inner disc keeps turning',
		s0.omegaPattern === 0
		&& orbit.omegaFor(orbit.FAMILY_DISC, 1, 0, S0) === s0.vFlat / Math.max(1, s0.rCore),
		{ omega: orbit.omegaFor(orbit.FAMILY_DISC, 1, 0, S0) });

	const e4 = orbit.fillDynamics({}, M32);
	check('E4 pressure support boils and spins even with no disc curve',
		orbit.omegaFor(orbit.FAMILY_PRESSURE, 1, 0, M32) > 0,
		{ omega: orbit.omegaFor(orbit.FAMILY_PRESSURE, 1, 0, M32), spin: e4.spinLambda });

	const lockModel = Object.assign({}, MW, {
		dynamics: Object.assign({}, MW.dynamics, { patternLock: true }),
	});
	const wFar = orbit.omegaFor(orbit.FAMILY_DISC, 20, 0, lockModel);
	check('patternLock pins even the outer disc to the pattern speed',
		wFar === MW.dynamics.omegaPattern, { wFar });
}

// --- 4. Group coherence: the bar never lags its neighbours ---------------
// The reported bug: the bar read slower than stars near it. Inside R_CR a
// bar star, an embedded disc star and a young pattern star must cover the
// same angle over the same time — one group, one speed.
{
	const t = 100; // Myr
	const probes = [
		['bar', 9.5, 0.5, orbit.FAMILY_BAR],
		['disc-in-bar', 9.2, -0.8, orbit.FAMILY_DISC],
		['young', 9.0, 1.2, orbit.FAMILY_PATTERN],
	];
	const sweep = (x, y, fam, time) => {
		orbit.orbitPosition(out, x, y, 0.05, fam, 4, 8, time, MW);
		const a1 = Math.atan2(out[1] - MW.centre.y, out[0] - MW.centre.x);
		orbit.orbitPosition(out, x, y, 0.05, fam, 4, 8, 0, MW);
		const a0 = Math.atan2(out[1] - MW.centre.y, out[0] - MW.centre.x);
		let d = a1 - a0;
		d = d - orbit.TAU * Math.round(d / orbit.TAU);
		return d;
	};
	let ref = null, spread = 0;
	const ang = {};
	for (const [label, x, y, fam] of probes) {
		ang[label] = sweep(x, y, fam, t);
		if (ref === null) ref = ang[label];
		else spread = Math.max(spread, Math.abs(ang[label] - ref));
	}
	check('bar, embedded disc and young stars sweep the same angle in 100 Myr (< 1° apart)',
		spread < 0.0175, { spreadRad: spread, ang });
}

// --- 4b. The S0/SB0 regression: nothing that should move is frozen -------
// Reported: "half the stars almost don't move", worst on SB0 and S0. Two
// data/law defects caused it — a barred type inheriting omegaPattern = 0
// (rigid bar at ω = 0 while the disc turns) and disc-type spheroids with
// spinLambda = 0 (pressure family at ω = 0). Sweep every type: any family
// that the model puts stars in must have ω > 0.
{
	for (const type of galaxy.GALAXY_TYPES) {
		const m = type === 'SBb' ? galaxy.MILKY_WAY : galaxy.createGalaxy({ type, seed: 11 });
		const d = orbit.fillDynamics({}, m);
		const moving = [];
		if (m.barred) moving.push(['bar', d.omegaPattern > 0]);
		if (d.vFlat > 0) {
			moving.push(['disc', orbit.omegaFor(orbit.FAMILY_DISC, 3, 0, m) > 0]);
			moving.push(['pattern', orbit.omegaFor(orbit.FAMILY_PATTERN, 3, 0, m) > 0]);
		}
		moving.push(['pressure', orbit.omegaFor(orbit.FAMILY_PRESSURE, 1.5, 0, m) > 0]);
		const frozen = moving.filter(([, ok]) => !ok).map(([f]) => f);
		check(`${type}: every family the model uses has ω > 0`, frozen.length === 0, { frozen });
	}

	const s0m = galaxy.createGalaxy({ type: 'S0', seed: 11 });
	const s0 = orbit.fillDynamics({}, s0m);
	const wSph = orbit.omegaFor(orbit.FAMILY_PRESSURE, 1.5, 0, s0m);
	check('S0 spheroid/halo turns: pressure bulk = λ·Ω_disc(r) (plan §1.1, not 0)',
		Math.abs(wSph - s0.spinLambda * (s0.vFlat / Math.max(1.5, s0.rCore))) < 1e-12
		&& wSph > 0, { wSph, lambda: s0.spinLambda });
	check('S0 bright A star (pattern, no pattern to follow) orbits with the disc, not frozen',
		orbit.omegaFor(orbit.FAMILY_PATTERN, 3, 0, s0m)
			=== orbit.omegaFor(orbit.FAMILY_DISC, 3, 0, s0m),
		{ pattern: orbit.omegaFor(orbit.FAMILY_PATTERN, 3, 0, s0m) });

	const sb0m = galaxy.createGalaxy({ type: 'SB0', seed: 11 });
	const sb0 = orbit.fillDynamics({}, sb0m);
	check('SB0 carries a pattern speed (barred types never inherit ω_p = 0)',
		sb0.omegaPattern === 0.031, { omegaPattern: sb0.omegaPattern });
	check('SB0 bar is rigid at ω_p and the inner disc joins its group (R_CR = vFlat/ω_p)',
		orbit.omegaFor(orbit.FAMILY_BAR, 1.5, 0, sb0m) === sb0.omegaPattern
		&& orbit.omegaFor(orbit.FAMILY_DISC, 2, 0, sb0m) === sb0.omegaPattern
		&& Math.abs(sb0.vFlat / sb0.omegaPattern - 7.42) < 0.01,
		{ bar: orbit.omegaFor(orbit.FAMILY_BAR, 1.5, 0, sb0m), rCr: sb0.vFlat / sb0.omegaPattern });
	check('SB0 spheroid pressure spin also lives (λ·Ω_disc)',
		orbit.omegaFor(orbit.FAMILY_PRESSURE, 1.5, 0, sb0m) > 0,
		{ w: orbit.omegaFor(orbit.FAMILY_PRESSURE, 1.5, 0, sb0m) });
}

// --- 5. Sun round-trip and pattern-vs-disc shear -------------------------
{
	const sx = MW.centre.x + 8.178, sy = 0;
	const w = orbit.omegaFor(orbit.FAMILY_DISC, sx, sy, MW);
	const tPeriod = orbit.TAU / w;
	orbit.orbitPosition(out, sx, sy, 0.01, orbit.FAMILY_DISC, 0, 0, tPeriod, MW);
	// amp 0 still has the (0+0.5)/16 rank wobble; the bulk angle itself must
	// have come back exactly, so allow only the wobble scale (< 0.1 kpc).
	check('a disc star returns to its start after one period (229 Myr, < 0.1 kpc)',
		dist3(out, [sx, sy, 0.01]) < 0.1, { dist: dist3(out, [sx, sy, 0.01]), tPeriod });

	// Beyond corotation, pattern and disc genuinely shear (plan §3.3) — the
	// group zone must not have eaten the outer galaxy.
	const rOut = 10;
	const xOut = MW.centre.x + rOut;
	orbit.orbitPosition(out, xOut, 0, 0, orbit.FAMILY_PATTERN, 0, 0, 500, MW);
	const aPat = Math.atan2(out[1], out[0] - MW.centre.x);
	orbit.orbitPosition(out, xOut, 0, 0, orbit.FAMILY_DISC, 0, 0, 500, MW);
	const aDisc = Math.atan2(out[1], out[0] - MW.centre.x);
	let d = Math.abs(aPat - aDisc);
	if (d > Math.PI) d = orbit.TAU - d;
	check('pattern and disc shear apart outside R_CR (plan §3.3 survives)', d > 0.05, { d });
}

// --- 6. Family tables and record bits ------------------------------------
{
	check('familyForStar: O/B/A → pattern',
		orbit.familyForStar(1, 'O', true) === orbit.FAMILY_PATTERN
		&& orbit.familyForStar(2, 'B', false) === orbit.FAMILY_PATTERN
		&& orbit.familyForStar(3, 'A', false) === orbit.FAMILY_PATTERN);
	check('familyForStar: components drive disc/bar/pressure',
		orbit.familyForStar(0, 'G', true) === orbit.FAMILY_DISC
		&& orbit.familyForStar(1, 'M', true) === orbit.FAMILY_DISC
		&& orbit.familyForStar(2, 'K', true) === orbit.FAMILY_BAR
		&& orbit.familyForStar(2, 'K', false) === orbit.FAMILY_PRESSURE
		&& orbit.familyForStar(3, 'G', true) === orbit.FAMILY_PRESSURE);
	check('familyFromColorIndex: O/B/A (0..2) ride the pattern, the rest the disc',
		orbit.familyFromColorIndex(0) === orbit.FAMILY_PATTERN
		&& orbit.familyFromColorIndex(2) === orbit.FAMILY_PATTERN
		&& orbit.familyFromColorIndex(3) === orbit.FAMILY_DISC
		&& orbit.familyFromColorIndex(9) === orbit.FAMILY_DISC);

	const packed = records.packPacked(4, 3.2,
		orbit.flagsWithFamily(records.FLAG_VISIBLE, orbit.FAMILY_BAR),
		orbit.encodeJitter(5, 11));
	const ro = orbit.readOrbit(packed);
	check('family/phase/amplitude round-trip through the 16-byte record',
		ro.family === orbit.FAMILY_BAR && ro.phase === 5 && ro.amplitude === 11
		&& orbit.familyFromFlags((packed >>> 16) & 255) === orbit.FAMILY_BAR, ro);

	check('family numbering: StarRecord flags bits 3-4, values 0..3',
		orbit.FAMILY_PATTERN === 0 && orbit.FAMILY_DISC === 1
		&& orbit.FAMILY_BAR === 2 && orbit.FAMILY_PRESSURE === 3
		&& orbit.FAMILY_SHIFT === 3 && orbit.FAMILY_MASK === 0x18);
}

// --- 7. Wobble continuity across the bulk wrap ---------------------------
// A bug the first shader shipped: reducing only the bulk theta and reusing it
// for the epicycle argument snapped every wobble phase once per revolution.
{
	const tWrap = orbit.TAU / MW.dynamics.omegaPattern; // one pattern period
	const eps = 1e-3;
	const probe = (t) => {
		orbit.orbitPosition(out, MW.centre.x + 2, 1.5, 0.2, orbit.FAMILY_DISC, 9, 12, t, MW);
		return [out[0], out[1], out[2]];
	};
	const a = probe(tWrap - eps), b = probe(tWrap + eps);
	check('disc wobble phase stays continuous across a bulk-angle wrap (< 1 pc jump)',
		dist3(a, b) < 0.001, { dist: dist3(a, b) });

	const pWrap = probe(tWrap);
	const p0 = probe(0);
	// After exactly one pattern period the BULK angle is back; only the
	// epicycle (different frequency) has advanced — that is by design.
	const bulkBack = Math.hypot(pWrap[0] - p0[0], pWrap[1] - p0[1]);
	check('bulk angle returns after one pattern period (xy close to start)',
		bulkBack < 0.35, { bulkBack });
}

// --- 8. Uniform packer ↔ shader layout -----------------------------------
{
	const u = new Float32Array(36);
	u[27] = 12.5; // star time slot must be left alone
	orbit.packOrbitDynamics(MW, u, 28);
	const d = orbit.fillDynamics({}, MW);
	const fr = Math.fround;
	check('packOrbitDynamics fills dynA = (vFlat, rCore, omegaPattern, spinLambda)',
		u[28] === fr(d.vFlat) && u[29] === fr(d.rCore)
		&& u[30] === fr(d.omegaPattern) && u[31] === fr(d.spinLambda),
		{ dynA: Array.from(u.slice(28, 32)) });
	check('packOrbitDynamics fills dynB = (sigmaThin, pressureAmpScale, discHeight, patternLock)',
		u[32] === fr(d.sigmaThin) && u[33] === fr(d.pressureAmpScale)
		&& u[34] === fr(d.discHeight) && u[35] === fr(d.patternLock),
		{ dynB: Array.from(u.slice(32, 36)) });
	check('packing never touches the star-time slot or the camera block',
		u[27] === 12.5 && u[16] === 0, { time: u[27], u16: u[16] });

	check('pressure amplitude cap: MW bulge ≤ 0.3 × spheroid semimajor axis',
		d.pressureAmpScale <= 0.3 * MW.spheroid.a * MW.spheroid.r0 + 1e-12
		&& d.pressureAmpScale > 0,
		{ scale: d.pressureAmpScale, axis: MW.spheroid.a * MW.spheroid.r0 });
	const e4dyn = orbit.fillDynamics({}, M32);
	check('E-type spheroid uses the uncapped virial amplitude (plan §1.4)',
		Math.abs(e4dyn.pressureAmpScale
			- 2 * M32.dynamics.sigmaSpheroid / orbit.PRESSURE_CLOCK_1KPC) < 1e-12
		&& e4dyn.vFlat === 0,
		{ scale: e4dyn.pressureAmpScale, vFlat: e4dyn.vFlat });
}

// --- 9. f32 replay: CPU f64 vs the WGSL arithmetic -----------------------
// Mirrors SHADER_PARTS['orbit'] operation-for-operation with Math.fround, the
// same technique plan §5 prescribes. Sessions up to 10 000 Myr must agree to
// well under a pixel at any radius the camera flies.
function orbitPositionF32(px, py, pz, packed, cx, time, dynA, dynB) {
	const fr = Math.fround;
	const flags = fr((packed >>> 16) & 0xff);
	const family = fr((flags >>> 3) & 3);
	const phase = fr(fr(f32i((packed >>> 24) & 15)) * fr(0.392699081699));
	const amp = fr(f32i((packed >>> 28) & 15));
	const qx = fr(fr(px) - fr(cx)); const qy = fr(fr(py) - fr(0)); const qz = fr(fr(pz) - fr(0));
	let rx = fr(qx * qx); let ry = fr(qy * qy);
	const r = fr(Math.max(fr(Math.sqrt(fr(rx + ry))), fr(0.001)));
	// omega — mirrors orbitOmega exactly, including the pattern-without-a-
	// pattern fallback and the hybrid pressure clock (disc curve / Keplerian).
	const pressureClockF = () => (dynA[0] > 0
		? fr(dynA[0] / fr(Math.max(r, dynA[1])))
		: fr(fr(0.05) / fr(Math.max(fr(Math.pow(fr(Math.max(r, 0.1)), 1.5)), fr(0.01)))));
	let omega;
	if (family === 2) omega = dynA[2];
	else if (family === 0) {
		if (dynA[2] > 0) omega = dynA[2];
		else omega = dynA[0] > 0 ? fr(dynA[0] / fr(Math.max(r, dynA[1]))) : 0;
	} else if (family === 1) {
		const circ = fr(dynA[0] / fr(Math.max(r, dynA[1])));
		if (dynA[2] > 0 && dynA[0] > 0) {
			if (dynB[3] > 0.5) omega = dynA[2];
			else if (r < fr(dynA[0] / dynA[2])) omega = dynA[2];
			else omega = circ;
		} else omega = circ;
	} else {
		omega = fr(dynA[3] * pressureClockF());
	}
	const theta = fr(fr(6.28318530718) * fractf(fr(fr(omega) * fr(time) * fr(0.159154943092))));
	const rank = fr(fr(amp + 0.5) * fr(0.0625));
	const sinTauF = (arg) => fr(Math.sin(fr(fr(6.28318530718) * fractf(fr(fr(arg) * fr(0.159154943092))))));
	const sinPh = sinTauF(phase);
	const sinPhV = sinTauF(fr(phase + fr(1.57079632679)));
	let wrx = 0, wry = 0, wz = 0;
	if (family === 1) {
		const kappa = fr(fr(1.41421356237) * fr(dynA[0] / fr(Math.max(r, dynA[1]))));
		const ah = fr(fr(fr(rank * 2) * dynB[0]) / fr(Math.max(kappa, fr(1e-6))));
		const av = fr(Math.min(fr(fr(0.2) * ah), fr(Math.max(fr(dynB[2] - fr(Math.abs(qz))), 0))));
		const wr = fr(ah * fr(sinTauF(fr(phase + kappa * time)) - sinPh));
		wz = fr(av * fr(sinTauF(fr(phase + fr(1.57079632679) + kappa * time)) - sinPhV));
		wrx = fr(wr * qx / r); wry = fr(wr * qy / r);
	} else if (family === 3) {
		const a = fr(rank * dynB[1]);
		const mean = pressureClockF();
		const wr = fr(a * fr(sinTauF(fr(phase + mean * time)) - sinPh));
		wz = fr(a * fr(sinTauF(fr(phase + fr(1.57079632679) + mean * time)) - sinPhV));
		wrx = fr(wr * qx / r); wry = fr(wr * qy / r);
	}
	const ct = fr(Math.cos(theta)); const st = fr(Math.sin(theta));
	const bx = fr(qx + wrx); const by = fr(qy + wry);
	return [
		fr(fr(cx) + fr(fr(ct * bx) - fr(st * by))),
		fr(fr(0) + fr(fr(st * bx) + fr(ct * by))),
		fr(fr(0) + fr(qz + wz)),
	];
}
function fractf(x) {
	return frLocal(x - Math.floor(x));
}
function frLocal(x) { return Math.fround(x); }
function f32i(n) { return Math.fround(n); }

{
	const dyn = orbit.fillDynamics({}, MW);
	const dynA = [Math.fround(dyn.vFlat), Math.fround(dyn.rCore), Math.fround(dyn.omegaPattern), Math.fround(dyn.spinLambda)];
	const dynB = [Math.fround(dyn.sigmaThin), Math.fround(dyn.pressureAmpScale), Math.fround(dyn.discHeight), Math.fround(dyn.patternLock)];
	const cases = [
		// x, y, z, family, phase, amp, time
		[MW.centre.x + 8.178, 0, 0.01, orbit.FAMILY_DISC, 3, 9, 0],
		[MW.centre.x + 8.178, 0, 0.01, orbit.FAMILY_DISC, 3, 9, 1000],
		[MW.centre.x + 8.178, 0, 0.01, orbit.FAMILY_DISC, 3, 9, 10000],
		[MW.centre.x + 1.5, 0.5, 0.2, orbit.FAMILY_DISC, 11, 4, 3000],
		[MW.centre.x + 1.5, 0.5, 0.2, orbit.FAMILY_BAR, 0, 0, 3000],
		[MW.centre.x + 2.0, -1.0, 0.5, orbit.FAMILY_PRESSURE, 7, 14, 2000],
	];
	let worst = 0, worstCase = null;
	for (const [x, y, z, fam, ph, amp, t] of cases) {
		orbit.orbitPosition(out, x, y, z, fam, ph, amp, t, MW);
		const packed = records.packPacked(4, 3,
			orbit.flagsWithFamily(records.FLAG_VISIBLE, fam), orbit.encodeJitter(ph, amp));
		const gpu = orbitPositionF32(x, y, z, packed, MW.centre.x, t, dynA, dynB);
		const d = dist3(out, gpu);
		if (d > worst) { worst = d; worstCase = { fam, t, d }; }
	}
	// f32 loses the low bits of large angles exactly as plan §5 predicts; the
	// bound here is the visual one — far below a pixel at any fly-through
	// distance for a session up to 10 Gyr of max-rate scrubbing.
	check('f64 CPU law vs f32 WGSL replay agree within 0.05 kpc up to T = 10 000 Myr',
		worst < 0.05, { worst, worstCase });
}

// --- 10. Slider mapping (plan §6) ----------------------------------------
{
	check('slider −1 at 8 ly/s follows at 1.0 Myr/s (FLIGHT_TIME_GAIN = 0.125)',
		orbit.sliderValueToRate(-1, 8) === 1 && orbit.FLIGHT_TIME_GAIN === 0.125,
		{ rate: orbit.sliderValueToRate(-1, 8) });
	check('slider 0 is frozen, positive values pass through',
		orbit.sliderValueToRate(0, 8) === 0 && orbit.sliderValueToRate(42, 8) === 42);
	check('formatTimeRate labels follow / frozen / explicit',
		orbit.formatTimeRate(-1, 0) === 'follow ×1.0'
		&& orbit.formatTimeRate(0, 0) === 'frozen'
		&& orbit.formatTimeRate(8.25, 0) === '+8.3 Myr/s',
		[orbit.formatTimeRate(-1, 0), orbit.formatTimeRate(0, 0), orbit.formatTimeRate(8.25, 0)]);
}

// --- Report --------------------------------------------------------------
{
	let passed = 0, failed = 0;
	for (const c of checks) {
		if (c.pass) passed++; else failed++;
		console.log(`  ${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.pass ? '' : `  -> ${JSON.stringify(c.detail)}`}`);
	}
	console.log(`\n${passed}/${checks.length} passed, ${failed} failed`);
	const logPath = path.join(__dirname, 'logs', 'orbit.json');
	fs.mkdirSync(path.dirname(logPath), { recursive: true });
	fs.writeFileSync(logPath, JSON.stringify({
		date: new Date().toISOString(),
		totalChecks: checks.length,
		passed,
		failed,
		checks,
	}, null, 2));
	console.log(`Wrote ${logPath}`);
	if (failed > 0) process.exit(1);
}
