// experiments/orbit-test.js
// The 0.4 orbit law, on the numbers of plan §1.1/§1.4 of
// 0.4.0-plan-star-move.md plus the 0.4.3 group-kinematics rewrite:
//
//   * T = 0 is the identity for every family
//   * reference periods (solar circle, bar/pattern, halo clock)
//   * the pattern is ONE group: bar and young stars sweep the same angle at the
//     group speed galaxy.js derives from the model's own population
//   * the disc is differential: no corotation lock (the rigid "belt" of
//     0.4.1/0.4.2 is the reported bug) and the bar's stars stream on x1 loops
//     at Omega(r) - omegaPattern — a radius function, not a per-star rate
//   * the derived pattern speed lands in the observed band for every barred
//     type and corotation always falls beyond the bar's own end
//   * patternLock still forces the rigid cosmetic variant; omegaPattern = 0
//     never freezes a disc (S0/E guard)
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
const density = require('../src/math/density.js');
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

// --- 2. Reference periods and the derived group speed (plan §1.1) --------
{
	// omegaFor takes galactocentric coordinates (the law's q frame).
	const sunR = Math.hypot(MW.centre.x, MW.centre.y);
	const wSun = orbit.omegaFor(orbit.FAMILY_DISC, sunR, 0, MW);
	const tSun = orbit.TAU / wSun;
	check('solar circle R = 8.2 kpc turns in 229 ± 2 Myr',
		Math.abs(tSun - 229) < 2, { omega: wSun, period: tSun });

	// The pattern speed is derived, never authored: the apsidal precession rate
	// (Omega - kappa/2 = (1 - 1/sqrt2)*Omega, plan §1.1) at the radius that sets
	// the pattern — the bar's own end for a barred model.
	const dyn = orbit.fillDynamics({}, MW);
	const extent = MW.spheroid.a * MW.spheroid.r0; // the MW preset's bulge
	const expected = (1 - 1 / Math.SQRT2) * dyn.vFlat / Math.max(extent, dyn.rCore);
	check('the Milky Way pattern speed is the group precession rate at the bulge radius',
		Math.abs(dyn.omegaPattern - expected) < 1e-12, { omegaPattern: dyn.omegaPattern, expected });

	const wBar = orbit.omegaFor(orbit.FAMILY_BAR, 1, 0, MW);
	check('bar/pattern period 143 ± 1 Myr (derived ω_p = 0.0439 rad/Myr = 43 km/s/kpc)',
		Math.abs(orbit.TAU / wBar - 143) < 1, { omega: wBar, period: orbit.TAU / wBar });

	// Streaming rate: the bar's x1 loop frequency. It is a function of radius
	// alone, zero exactly at corotation, and it reverses beyond it.
	const rCr = MW.dynamics.vFlat / MW.dynamics.omegaPattern;
	check(`the streaming rate is zero at corotation (R_CR = ${rCr.toFixed(2)} kpc)`,
		Math.abs(orbit.omegaStream(dyn, rCr)) < 1e-9
		&& orbit.omegaStream(dyn, rCr * 0.5) > 0
		&& orbit.omegaStream(dyn, rCr * 2) < 0,
		{ at: orbit.omegaStream(dyn, rCr), in: orbit.omegaStream(dyn, rCr * 0.5), out: orbit.omegaStream(dyn, rCr * 2) });
	check('the streaming rate falls with radius inside corotation (inner stars lap the bar fastest)',
		orbit.omegaStream(dyn, 1) > orbit.omegaStream(dyn, 3) && orbit.omegaStream(dyn, 3) > orbit.omegaStream(dyn, 5),
		{ r1: orbit.omegaStream(dyn, 1), r3: orbit.omegaStream(dyn, 3), r5: orbit.omegaStream(dyn, 5) });

	// Differential disc: the local group rate everywhere, no lock, and the
	// seam-free property the 0.4.1 lock was built for is now automatic (there
	// is only one branch).
	const wIn = orbit.omegaFor(orbit.FAMILY_DISC, rCr - 0.5, 0, MW);
	check('the belt/disc is differential (no corotation lock): ω = vFlat/max(r, rCore)',
		wIn === dyn.vFlat / Math.max(rCr - 0.5, dyn.rCore)
		&& orbit.omegaFor(orbit.FAMILY_DISC, 2, 0, MW) > orbit.omegaFor(orbit.FAMILY_DISC, 6, 0, MW),
		{ wIn, w2: orbit.omegaFor(orbit.FAMILY_DISC, 2, 0, MW), w6: orbit.omegaFor(orbit.FAMILY_DISC, 6, 0, MW) });

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

// --- 4. Group kinematics: one pattern, differential disc, streaming bar ---
// The reported bug was the opposite of 0.4.1's: the bar, the arms and the whole
// inner disc turned as ONE rigid body. Now the pattern is one group (bar seats
// and young stars sweep the same angle), the disc is differential, and the
// bar's own stars stream through the pattern at a radius-dependent rate.
{
	const t = 100; // Myr
	const sweep = (x, y, fam, time, ph, amp) => {
		orbit.orbitPosition(out, x, y, 0.05, fam, ph, amp, time, MW);
		const a1 = Math.atan2(out[1] - MW.centre.y, out[0] - MW.centre.x);
		orbit.orbitPosition(out, x, y, 0.05, fam, ph, amp, 0, MW);
		const a0 = Math.atan2(out[1] - MW.centre.y, out[0] - MW.centre.x);
		let d = a1 - a0;
		d = d - orbit.TAU * Math.round(d / orbit.TAU);
		return d;
	};
	// A bar star and a young pattern star share the pattern's angle (its seat
	// is on the pattern); the small loop only perturbs it.
	const aBar = sweep(MW.centre.x + 1.5, 0.5, orbit.FAMILY_BAR, t, 4, 8);
	const aYoung = sweep(MW.centre.x + 1.5, 0.5, orbit.FAMILY_PATTERN, t, 4, 8);
	check('the pattern is one group: bar seat and young stars sweep the same angle (< 0.1°)',
		Math.abs(aBar - aYoung) < 0.002, { bar: aBar, young: aYoung });

	// The embedded disc star does NOT: it runs at its own local rate and
	// overtakes the pattern inside corotation. That is the density wave.
	const aDisc = sweep(MW.centre.x + 1.5, 0.5, orbit.FAMILY_DISC, t, 4, 8);
	check('the embedded disc star overtakes the pattern inside corotation (differential belt)',
		aDisc > aYoung + 0.05, { disc: aDisc, young: aYoung });

	// The bar's stars are not glued to the pattern: their loop phase advances
	// at the streaming rate, so the same star sits somewhere else than a
	// rotation of its T = 0 position after a while.
	const px = MW.centre.x + 1.5, py = 0.5;
	orbit.orbitPosition(out, px, py, 0.05, orbit.FAMILY_BAR, 4, 15, 40, MW);
	const looped = dist3(out, [px, py, 0.05]);
	const theta = MW.dynamics.omegaPattern * 40;
	const seatX = MW.centre.x + Math.cos(theta) * (px - MW.centre.x) - Math.sin(theta) * py;
	const seatY = Math.sin(theta) * (px - MW.centre.x) + Math.cos(theta) * py;
	check('a bar star is off its rigid seat after 40 Myr (it streams, it is not glued)',
		dist3(out, [seatX, seatY, 0.05]) > 1e-3,
		{ offSeat: dist3(out, [seatX, seatY, 0.05]), loop: looped });

	// ...but never far: the loop is bounded by the amplitude scale, so the
	// bar's outline cannot be torn. Sweep a long session and bound it.
	const dyn = orbit.fillDynamics({}, MW);
	let maxOff = 0;
	for (let tt = 0; tt <= 2000; tt += 7) {
		orbit.orbitPosition(out, px, py, 0, orbit.FAMILY_BAR, 0, 15, tt, MW);
		const th = MW.dynamics.omegaPattern * tt;
		const sx = Math.cos(th) * (px - MW.centre.x) - Math.sin(th) * py;
		const sy = Math.sin(th) * (px - MW.centre.x) + Math.cos(th) * py;
		maxOff = Math.max(maxOff, Math.hypot(out[0] - MW.centre.x - sx, out[1] - sy));
	}
	const bound = orbit.BAR_LOOP_FRACTION * dyn.pressureAmpScale * 2 + 1e-6;
	check('the bar loop stays bounded (never leaves the bar: ≤ 2 × the amplitude)',
		maxOff <= bound, { maxOff, bound });
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
	// Derived, not authored: the apsidal rate at the bar's own end (a = 1.62 kpc),
	// which is 40.7 km/s/kpc — inside the observed bar band (33-45).
	const barEnd = sb0m.spheroid.a * sb0m.spheroid.r0;
	const sb0Expected = (1 - 1 / Math.SQRT2) * sb0.vFlat / Math.max(barEnd, sb0.rCore);
	check('SB0 pattern speed is derived from the bar end (40.7 km/s/kpc, observed band 33-45)',
		sb0.omegaPattern > 0 && Math.abs(sb0.omegaPattern - sb0Expected) < 1e-12
		&& Math.abs(sb0.omegaPattern * 978 - 40.7) < 0.2,
		{ omegaPattern: sb0.omegaPattern, kmPerSecPerKpc: sb0.omegaPattern * 978 });
	check('SB0 corotation falls beyond the bar end (the bar never overflows its own corotation)',
		sb0.vFlat / sb0.omegaPattern > barEnd * 1.5,
		{ rCr: sb0.vFlat / sb0.omegaPattern, barEnd });
	check('SB0 bar stars are NOT rigid: the loop rate varies across the bar (1.7× end to end)',
		orbit.omegaStream(sb0, 0.4) > orbit.omegaStream(sb0, 1.6)
		&& Math.abs(orbit.omegaFor(orbit.FAMILY_BAR, 3.2, 0, sb0m) - sb0.omegaPattern) < 1e-12
		&& orbit.omegaStream(sb0, 0.4) / orbit.omegaStream(sb0, 1.6) > 1.5,
		{ inner: orbit.omegaStream(sb0, 0.4), outer: orbit.omegaStream(sb0, 1.6) });
	check('SB0 belt/disc no longer co-rotates with the bar (the rigid group zone is gone)',
		orbit.omegaFor(orbit.FAMILY_DISC, 2, 0, sb0m) > sb0.omegaPattern * 1.5
		&& orbit.omegaFor(orbit.FAMILY_DISC, 1, 0, sb0m) === sb0.vFlat / Math.max(1, sb0.rCore)
		&& orbit.omegaFor(orbit.FAMILY_DISC, 1, 0, sb0m) !== sb0.omegaPattern,
		{ disc2: orbit.omegaFor(orbit.FAMILY_DISC, 2, 0, sb0m), omegaPattern: sb0.omegaPattern });
	// Every barred type: the derived pattern speed lands in the observed band
	// (33-55 km/s/kpc) and corotation falls beyond the bar's own end. This is
	// the structural gate on a derivation with no constant in it.
	{
		const bad = [];
		for (const type of ['SB0', 'SBa', 'SBb', 'SBc', 'SBd']) {
			const m = galaxy.createGalaxy({ type, seed: 21 });
			const dd = orbit.fillDynamics({}, m);
			const km = dd.omegaPattern * 978;
			const end = m.spheroid.profile === 'bar' ? m.spheroid.a * m.spheroid.r0 : m.spheroid.a * m.spheroid.r0;
			const beyond = dd.omegaPattern > 0 && dd.vFlat / dd.omegaPattern > end;
			if (!(km > 30 && km < 56 && beyond)) bad.push({ type, km, rCr: dd.vFlat / dd.omegaPattern, end });
		}
		check('every barred type: derived ω_p in the observed 33-55 km/s/kpc band, corotation past the bar end',
			bad.length === 0, { bad });
	}

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
	// One period of the PROBE STAR's own bulk rate (the disc has no lock now:
	// the wrap has to be its own, not the pattern's).
	const probeX = 2, probeY = 1.5;
	const tWrap = orbit.TAU / orbit.omegaFor(orbit.FAMILY_DISC, Math.hypot(probeX, probeY), 0, MW);
	const eps = 1e-3;
	const probe = (t) => {
		orbit.orbitPosition(out, MW.centre.x + probeX, probeY, 0.2, orbit.FAMILY_DISC, 9, 12, t, MW);
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
	const u = new Float32Array(44);
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
	const pitch = MW.arms.pitchDeg * Math.PI / 180;
	check('packOrbitDynamics fills waveA/waveB = arm geometry, damping at module default 0',
		u[36] === 0 && u[37] === fr(MW.arms.m)
		&& u[38] === fr(MW.arms.m / Math.tan(pitch))
		&& u[39] === fr(MW.arms.phase0)
		&& u[40] === fr(MW.arms.Rs) && u[41] === fr(MW.arms.minRadius)
		&& u[42] === fr(MW.arms.amp) && u[43] === 0,
		{ wave: Array.from(u.slice(36, 44)) });

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
function orbitPositionF32(px, py, pz, packed, cx, time, dynA, dynB, waveA, waveB) {
	const fr = Math.fround;
	const flags = fr((packed >>> 16) & 0xff);
	const family = fr((flags >>> 3) & 3);
	const phase = fr(fr(f32i((packed >>> 24) & 15)) * fr(0.392699081699));
	const amp = fr(f32i((packed >>> 28) & 15));
	const qx = fr(fr(px) - fr(cx)); const qy = fr(fr(py) - fr(0)); const qz = fr(fr(pz) - fr(0));
	const qxx = fr(qx * qx), qyy = fr(qy * qy);
	const r = fr(Math.max(fr(Math.sqrt(fr(qxx + qyy))), fr(0.001)));
	// omega — mirrors orbitOmega exactly, including the pattern-without-a-
	// pattern fallback and the hybrid pressure clock (disc curve / Keplerian).
	const pressureClockF = () => (dynA[0] > 0
		? fr(dynA[0] / fr(Math.max(r, dynA[1])))
		: fr(fr(0.05) / fr(Math.max(fr(Math.pow(fr(Math.max(r, 0.1)), 1.5)), fr(0.01)))));
	const circF = () => (dynA[0] > 0 ? fr(dynA[0] / fr(Math.max(r, dynA[1]))) : 0);
	let omega;
	if (family === 2) omega = dynA[2];
	else if (family === 0) {
		if (dynA[2] > 0) omega = dynA[2];
		else omega = circF();
	} else if (family === 1) {
		// Differential at the local group rate; patternLock is the rigid variant.
		if (dynB[3] > 0.5 && dynA[2] > 0) omega = dynA[2];
		else omega = circF();
	} else {
		omega = fr(dynA[3] * pressureClockF());
	}
	let theta = fr(fr(6.28318530718) * fractf(fr(fr(omega) * fr(time) * fr(0.159154943092))));
	// Optional wave pair: mirrors the shader's disc capture. Absent or zero
	// damping leaves the 0.4.3 theta, which is what the cases above measure.
	if (waveA && family === 1 && waveA[0] > 0 && waveA[1] >= 1 && waveB[2] > 0 && waveB[0] > 0 && r >= waveB[1] && !(dynB[3] > 0.5)) {
		const PI = fr(3.14159265359);
		const TAU = fr(6.28318530718);
		const INV = fr(0.159154943092);
		const theta0 = fr(Math.atan2(qy, qx));
		const thetaArm = fr(fr(fr(waveA[2] * fr(Math.log(fr(r / waveB[0])))) - waveA[3]) / waveA[1]);
		const alpha = waveA[0];
		const m = waveA[1];
		const omegaP = dynA[2];
		const t = fr(time);
		if (!(t === 0 || alpha <= 0 || m < 1)) {
			const omegaRel = fr(omega - omegaP);
			if (omegaRel !== 0) {
				const strength = fr(Math.min(alpha, fr(1)));
				let chi0 = fr(fr(m * fr(theta0 - thetaArm)));
				chi0 = fr(chi0 - fr(TAU * Math.floor(fr(fr(chi0 + PI) * INV))));
				const lim = fr(PI - fr(1e-5));
				if (chi0 > lim) chi0 = lim;
				else if (chi0 < -lim) chi0 = -lim;
				const u0 = fr(Math.tan(fr(chi0 * fr(0.5))));
				const beta = fr(fr(fr(strength * m) * omegaRel) * fr(0.5));
				const denom = fr(fr(1) - fr(fr(u0 * beta) * t));
				let chi;
				if (Math.abs(denom) <= fr(1e-6)) chi = omegaRel > 0 ? PI : fr(-PI);
				else {
					chi = fr(fr(2) * fr(Math.atan(fr(u0 / denom))));
					if (denom < 0) chi = fr(chi + (omegaRel > 0 ? TAU : fr(-TAU)));
				}
				const advance = fr(fr(chi - chi0) / m);
				theta = fr(TAU * fractf(fr(fr(advance + fr(omegaP * t)) * INV)));
			}
		}
	}
	const rank = fr(fr(amp + 0.5) * fr(0.0625));
	const sinTauF = (arg) => fr(Math.sin(fr(fr(6.28318530718) * fractf(fr(fr(arg) * fr(0.159154943092))))));
	const sinPh = sinTauF(phase);
	const sinPhV = sinTauF(fr(phase + fr(1.57079632679)));
	let wr = 0, wz = 0;
	if (family === 2) {
		const stream = fr(circF() - dynA[2]);
		const ah = fr(fr(rank * fr(0.15)) * dynB[1]);
		wr = fr(ah * fr(sinTauF(fr(phase + stream * time)) - sinPh));
	} else if (family === 1) {
		const kappa = fr(fr(1.41421356237) * fr(dynA[0] / fr(Math.max(r, dynA[1]))));
		const ah = fr(fr(fr(rank * 2) * dynB[0]) / fr(Math.max(kappa, fr(1e-6))));
		const av = fr(Math.min(fr(fr(0.2) * ah), fr(Math.max(fr(dynB[2] - fr(Math.abs(qz))), 0))));
		wr = fr(ah * fr(sinTauF(fr(phase + kappa * time)) - sinPh));
		wz = fr(av * fr(sinTauF(fr(phase + fr(1.57079632679) + kappa * time)) - sinPhV));
	} else if (family === 3) {
		const a = fr(rank * dynB[1]);
		const mean = pressureClockF();
		wr = fr(a * fr(sinTauF(fr(phase + mean * time)) - sinPh));
		wz = fr(a * fr(sinTauF(fr(phase + fr(1.57079632679) + mean * time)) - sinPhV));
	}
	const radius = fr(Math.sqrt(fr(fr(qx * qx) + fr(qy * qy) + fr(qz * qz))));
	const invRadius = radius > 1e-9 ? fr(1 / radius) : 0;
	const e0x = radius > 1e-9 ? fr(qx * invRadius) : 1;
	const e0y = radius > 1e-9 ? fr(qy * invRadius) : 0;
	const e0z = radius > 1e-9 ? fr(qz * invRadius) : 0;
	const xy = fr(Math.sqrt(fr(fr(qx * qx) + fr(qy * qy))));
	const azx = xy > 1e-9 ? fr(-qy / xy) : 0;
	const azy = xy > 1e-9 ? fr(qx / xy) : 1;
	const ezx = fr(-e0z * azy), ezy = fr(e0z * azx), ezz = fr(fr(e0x * azy) - fr(e0y * azx));
	const rankIncl = fr(fr(amp + 0.5) / 16);
	const direction = fr(Math.sin(fr(fr(phase / fr(6.28318530718)) * fr(6.28318530718))));
	const maxInc = family === 2 ? 0.12 : family === 3 ? 0.30 : 0.045;
	const inc = fr(fr(maxInc * rankIncl) * direction);
	const ci = fr(Math.cos(inc)), si = fr(Math.sin(inc));
	const e1x = fr(fr(azx * ci) + fr(ezx * si));
	const e1y = fr(fr(azy * ci) + fr(ezy * si));
	const e1z = fr(ezz * si);
	const nx = fr(fr(e0y * e1z) - fr(e0z * e1y));
	const ny = fr(fr(e0z * e1x) - fr(e0x * e1z));
	const nz = fr(fr(e0x * e1y) - fr(e0y * e1x));
	const ct = fr(Math.cos(theta)), st = fr(Math.sin(theta));
	const rx = fr(fr(e0x * ct) + fr(e1x * st));
	const ry = fr(fr(e0y * ct) + fr(e1y * st));
	const rz = fr(fr(e0z * ct) + fr(e1z * st));
	const orbitRadius = radius > 1e-9 ? fr(radius + wr) : 0;
	const normalWobble = radius > 1e-9 ? wz : 0;
	return [
		fr(fr(cx) + fr(fr(orbitRadius * rx) + fr(normalWobble * nx))),
		fr(fr(0) + fr(fr(orbitRadius * ry) + fr(normalWobble * ny))),
		fr(fr(0) + fr(fr(orbitRadius * rz) + fr(normalWobble * nz))),
	];
}
function apocenterPositionF32(px, py, pz, packed, centre, time, dynA, waveA, waveB, engine) {
	const fr = Math.fround, TAU = fr(6.28318530718), PI = fr(3.14159265359);
	if (time === 0) return [fr(px), fr(py), fr(pz)];
	const flags = (packed >>> 16) & 255;
	const family = (flags >>> 3) & 3;
	const phaseBits = (packed >>> 24) & 15, ampBits = (packed >>> 28) & 15;
	const qx = fr(fr(px) - fr(centre[0])), qy = fr(fr(py) - fr(centre[1])), qz = fr(fr(pz) - fr(centre[2]));
	const radius = fr(Math.hypot(qx, qy, qz));
	if (radius <= 1e-9) return centre.map(fr);
	const theta0 = fr(Math.atan2(qy, qx));
	const R = fr(Math.max(fr(Math.hypot(qx, qy)), fr(0.001)));
	let apo = theta0;
	if ((family === 1 || family === 0) && waveA[1] >= 1 && waveB[2] > 0 && R >= waveB[1]) {
		const ridge = fr(fr(fr(waveA[2] * fr(Math.log(fr(R / waveB[0])))) - waveA[3]) / waveA[1]);
		apo = fr(ridge + fr(Math.floor(fr(fr(fr(theta0 - ridge) * waveA[1]) / TAU) + 0.5) * fr(TAU / waveA[1])));
	} else if (family === 2) {
		apo = fr(engine[2] + fr(Math.floor(fr(fr(theta0 - engine[2]) / PI + 0.5)) * PI));
	}
	const rawDelta = fr(fr(apo + PI) - theta0);
	const delta0 = fr(rawDelta - fr(TAU * Math.floor(fr(fr(rawDelta + PI) / TAU))));
	const rank = fr(fr(ampBits + 0.5) * fr(0.0625));
	const ecc = fr(Math.min(fr(engine[1] * rank), 0.55));
	const root = fr(Math.sqrt(fr(1 - fr(ecc * ecc))));
	const cosF = fr(Math.cos(delta0)), sinF = fr(-Math.sin(delta0));
	const E0 = fr(Math.atan2(fr(root * sinF), fr(ecc + cosF)));
	const M0 = fr(E0 - fr(ecc * fr(Math.sin(E0))));
	const a = fr(fr(radius * fr(1 + fr(ecc * cosF))) / fr(1 - fr(ecc * ecc)));
	const localOmega = dynA[0] > 0 ? fr(dynA[0] / fr(Math.max(R, dynA[1])))
		: fr(fr(0.05) / fr(Math.max(fr(Math.pow(fr(Math.max(R, 0.1)), 1.5)), 0.01)));
	const meanRaw = fr(M0 + fr(fr(localOmega - dynA[2]) * fr(time)) - waveB[3]);
	const mean = fr(meanRaw - fr(TAU * Math.floor(fr(fr(meanRaw + PI) / TAU))));
	let E = mean;
	for (let i = 0; i < 5; i++) E = fr(E - fr(fr(E - fr(ecc * fr(Math.sin(E))) - mean) / fr(1 - fr(ecc * fr(Math.cos(E))))));
	const nu = fr(Math.atan2(fr(root * fr(Math.sin(E))), fr(Math.cos(E) - ecc)));
	const orbitRadius = fr(a * fr(1 - fr(ecc * fr(Math.cos(E)))));
	const delta = fr(fr(delta0 + fr(dynA[2] * fr(time))) + waveB[3]);
	const e0x = fr(qx / radius), e0y = fr(qy / radius), e0z = fr(qz / radius);
	const xy = fr(Math.hypot(qx, qy));
	const azx = xy > 1e-9 ? fr(-qy / xy) : 0, azy = xy > 1e-9 ? fr(qx / xy) : 1;
	const ezx = fr(-e0z * azy), ezy = fr(e0z * azx), ezz = fr(fr(e0x * azy) - fr(e0y * azx));
	const phase = fr(phaseBits * fr(0.392699081699));
	const incMax = family === 2 ? 0.12 : family === 3 ? 0.30 : 0.045;
	const inc = fr(fr(incMax * rank) * fr(Math.sin(phase)));
	const ci = fr(Math.cos(inc)), si = fr(Math.sin(inc));
	const e1x = fr(fr(azx * ci) + fr(ezx * si)), e1y = fr(fr(azy * ci) + fr(ezy * si)), e1z = fr(ezz * si);
	const cd = fr(Math.cos(delta)), sd = fr(Math.sin(delta)), cv = fr(Math.cos(nu)), sv = fr(Math.sin(nu));
	const px1 = fr(fr(e0x * cd) + fr(e1x * sd)), py1 = fr(fr(e0y * cd) + fr(e1y * sd)), pz1 = fr(fr(e0z * cd) + fr(e1z * sd));
	const qpx = fr(fr(-e0x * sd) + fr(e1x * cd)), qpy = fr(fr(-e0y * sd) + fr(e1y * cd)), qpz = fr(fr(-e0z * sd) + fr(e1z * cd));
	return [
		fr(centre[0] + fr(orbitRadius * fr(fr(px1 * cv) + fr(qpx * sv)))),
		fr(centre[1] + fr(orbitRadius * fr(fr(py1 * cv) + fr(qpy * sv)))),
		fr(centre[2] + fr(orbitRadius * fr(fr(pz1 * cv) + fr(qpz * sv)))),
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
		[MW.centre.x + 1.1, -0.4, 0.1, orbit.FAMILY_BAR, 13, 15, 250],
		[MW.centre.x + 1.1, -0.4, 0.1, orbit.FAMILY_BAR, 13, 15, 5000],
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

// --- 11. Wave damping: pattern-frame capture, not the inertial port ------
// The linked-repo form omega *= (1 - s*D) anti-jams outside corotation.
// Capture (dχ/dt = α m (Ω-Ω_p) sin²(χ/2)) drifts a gap star onto the crest
// on both sides, leaves T = 0 and the other families alone, and is a no-op
// on an unarmed disc.
function patternDelta(x, y, model, time) {
	const c = model.centre || { x: 0, y: 0, z: 0 };
	const qx = x - c.x, qy = y - c.y;
	const R = Math.hypot(qx, qy);
	const phi = Math.atan2(qy, qx);
	const arm = density.armRidgeAzimuth(model, R) + model.dynamics.omegaPattern * time;
	let chi = model.arms.m * (phi - arm);
	chi -= orbit.TAU * Math.floor((chi + Math.PI) / orbit.TAU);
	return Math.abs(chi) / model.arms.m;
}
{
	const sb = galaxy.createGalaxy({ type: 'Sb', seed: 3 });
	const saved = orbit.getWaveDamping();
	orbit.setWaveDamping(0);

	function at(family, x, y, t, damp) {
		orbit.setWaveDamping(damp);
		orbit.orbitPosition(out, x, y, 0, family, 0, 0, t, sb);
		return [out[0], out[1], out[2]];
	}

	// Sb corotation is ~10 kpc. The side that falls onto the *nearest* crest is
	// the one the wave is sweeping: ahead of the crest outside CR (pattern
	// overtakes the star), behind it inside CR (star overtakes the pattern).
	// The opposite side takes the long way to the next crest.
	const Rout = 14, Rin = 3, off = 0.35;
	const armOut = density.armRidgeAzimuth(sb, Rout);
	const ox = Rout * Math.cos(armOut + off), oy = Rout * Math.sin(armOut + off);
	const armIn = density.armRidgeAzimuth(sb, Rin);
	const ix = Rin * Math.cos(armIn - off), iy = Rin * Math.sin(armIn - off);
	const gx = ox, gy = oy;
	const cx = Rout * Math.cos(armOut), cy = Rout * Math.sin(armOut);

	const id = at(orbit.FAMILY_DISC, gx, gy, 0, 1);
	check('wave damping keeps T = 0 the identity (offset star, α = 1)',
		dist3(id, [gx, gy, 0]) < EPS, dist3(id, [gx, gy, 0]));

	const sheer = at(orbit.FAMILY_DISC, ox, oy, 320, 0);
	const held = at(orbit.FAMILY_DISC, ox, oy, 320, 1);
	const d0 = patternDelta(ox, oy, sb, 0);
	const dHeld = patternDelta(held[0], held[1], sb, 320);
	const dSheer = patternDelta(sheer[0], sheer[1], sb, 320);
	check('outside corotation, capture pulls the star the wave is sweeping onto the crest',
		dHeld < d0 * 0.7 && dHeld < dSheer,
		{ d0, dHeld, dSheer, R: Rout });

	const sheerIn = at(orbit.FAMILY_DISC, ix, iy, 320, 0);
	const heldIn = at(orbit.FAMILY_DISC, ix, iy, 320, 1);
	const dIn0 = patternDelta(ix, iy, sb, 0);
	const dIn = patternDelta(heldIn[0], heldIn[1], sb, 320);
	check('inside corotation, capture pulls the star the wave is sweeping onto the crest',
		dIn < dIn0 * 0.5 && dIn < patternDelta(sheerIn[0], sheerIn[1], sb, 320),
		{ dIn0, dIn, sheer: patternDelta(sheerIn[0], sheerIn[1], sb, 320) });

	function meanDelta(R, t, damp) {
		orbit.setWaveDamping(damp);
		let sum = 0;
		const n = 36;
		for (let i = 0; i < n; i++) {
			const th = (i + 0.5) / n * orbit.TAU;
			orbit.orbitPosition(out, R * Math.cos(th), R * Math.sin(th), 0, orbit.FAMILY_DISC, 0, 0, t, sb);
			sum += patternDelta(out[0], out[1], sb, t);
		}
		return sum / n;
	}
	const uniform = Math.PI / (2 * sb.arms.m);
	check('a whole ring tightens on both sides of corotation at the UI default (α = 0.6)',
		meanDelta(Rin, 400, 0.6) < 0.5 * uniform && meanDelta(Rout, 400, 0.6) < 0.85 * uniform
		&& Math.abs(meanDelta(Rin, 400, 0) - uniform) < 0.02,
		{ inner: meanDelta(Rin, 400, 0.6), outer: meanDelta(Rout, 400, 0.6), uniform });

	const crestHeld = at(orbit.FAMILY_DISC, cx, cy, 400, 1);
	check('a star born on the crest stays on it under full capture',
		patternDelta(crestHeld[0], crestHeld[1], sb, 400) < 0.05,
		patternDelta(crestHeld[0], crestHeld[1], sb, 400));

	const pat0 = at(orbit.FAMILY_PATTERN, gx, gy, 400, 0);
	const pat1 = at(orbit.FAMILY_PATTERN, gx, gy, 400, 1);
	check('pattern family ignores wave damping (already on the wave)',
		dist3(pat0, pat1) < EPS, dist3(pat0, pat1));
	const bar0 = at(orbit.FAMILY_BAR, 1.2, 0.3, 300, 0);
	const bar1 = at(orbit.FAMILY_BAR, 1.2, 0.3, 300, 1);
	check('bar family ignores wave damping (the x1 loop is not a spiral)',
		dist3(bar0, bar1) < EPS, dist3(bar0, bar1));

	orbit.setWaveDamping(1);
	orbit.orbitPosition(out, S0.centre.x + 6, 1, 0, orbit.FAMILY_DISC, 3, 4, 500, S0);
	const offPos = [out[0], out[1], out[2]];
	orbit.setWaveDamping(0);
	orbit.orbitPosition(out, S0.centre.x + 6, 1, 0, orbit.FAMILY_DISC, 3, 4, 500, S0);
	check('an unarmed disc (S0, amp 0) ignores wave damping',
		dist3(offPos, [out[0], out[1], out[2]]) < EPS, dist3(offPos, [out[0], out[1], out[2]]));

	orbit.setWaveDamping(0);
	orbit.orbitPosition(out, gx, gy, 0.1, orbit.FAMILY_DISC, 5, 9, 250, sb);
	const plain = [out[0], out[1], out[2]];
	orbit.setWaveDamping(1);
	orbit.setWaveDamping(0);
	orbit.orbitPosition(out, gx, gy, 0.1, orbit.FAMILY_DISC, 5, 9, 250, sb);
	check('damping 0 after a non-zero setting is bit-identical to never having set it',
		out[0] === plain[0] && out[1] === plain[1] && out[2] === plain[2],
		{ now: [out[0], out[1], out[2]], plain });

	check('setWaveDamping clamps to [0, 1] and the UI default is the measured 0.6',
		orbit.setWaveDamping(2) === 1 && orbit.setWaveDamping(-1) === 0
		&& orbit.WAVE_DAMPING_UI_DEFAULT === 0.6 && orbit.WAVE_DAMPING_MAX === 1);

	// f32 replay of the shader arithmetic, damping on. The 0.4.3 replay above
	// leaves the wave pair unset; this is the half that pins the capture.
	orbit.setWaveDamping(0.6);
	const packedDyn = new Float32Array(16);
	orbit.packOrbitDynamics(sb, packedDyn, 0);
	const waveA = packedDyn.slice(8, 12);
	const waveB = packedDyn.slice(12, 16);
	const dynA = packedDyn.slice(0, 4);
	const dynB = packedDyn.slice(4, 8);
	let waveWorst = 0;
	const waveCases = [
		[ox, oy, 0], [ox, oy, 80], [ox, oy, 400], [ox, oy, 2000],
		[ix, iy, 120], [cx, cy, 600], [14, -2, 1000],
	];
	for (const [x, y, t] of waveCases) {
		orbit.orbitPosition(out, x, y, 0, orbit.FAMILY_DISC, 4, 6, t, sb);
		const packed = records.packPacked(4, 3,
			orbit.flagsWithFamily(records.FLAG_VISIBLE, orbit.FAMILY_DISC), orbit.encodeJitter(4, 6));
		const gpu = orbitPositionF32(x, y, 0, packed, 0, t, dynA, dynB, waveA, waveB);
		waveWorst = Math.max(waveWorst, dist3(out, gpu));
	}
	check('f64 capture vs f32 shader replay agree within 0.05 kpc',
		waveWorst < 0.05, { waveWorst });

	orbit.setWaveDamping(saved);
}

// --- 12. The simple (friction-field) engine (0.4.5) --------------------------
// The linked-demo port behind the engine switch: integrated azimuths, slowed
// inside the arm Gaussian. Stateful where the classic law is closed-form, so
// the pins here are epoch behaviour — the jam signature, the per-type table,
// the substep cap, the landmark mirror — plus the f32 replay bound.
function simpleOmegaF32(th, r0, eccU, peri, family, S) {
	// Mirrors SHADER_PARTS['simple-step'] operation-for-operation: S is the
	// packed 20-float uniform, exactly what the GPU reads.
	const fr = Math.fround;
	const vFlat = S[4], rCore = S[5], omegaP = S[6], spin = S[7];
	const eccMax = S[8], m = S[9], invTan = S[10], armOff = S[11];
	const inv2sig2 = S[12], Rs = S[13], minR = S[14];
	const damp = S[16], pp = S[3];
	if (family === 2) {
		if (omegaP > 0) return omegaP;
		return fr(vFlat / Math.max(r0, rCore));
	}
	if (family === 3) {
		const clk = vFlat > 0 ? fr(vFlat / Math.max(r0, rCore))
			: fr(0.05 / Math.max(Math.pow(Math.max(r0, 0.1), 1.5), 0.01));
		return fr(spin * clk);
	}
	const rr = Math.max(r0, 0.001);
	const rho = fr(rr * fr(1 + fr(fr(eccMax * eccU) * Math.cos(th - peri))));
	const circ = fr(vFlat / Math.max(rho, rCore));
	if (m < 1 || r0 < minR) return circ;
	const base = Math.log(rho / Rs) * invTan + pp;
	let delta = (th - base) - armOff * Math.floor((th - base) / armOff);
	if (delta > armOff * 0.5) delta -= armOff;
	return fr(circ * fr(1 - damp * Math.exp(-delta * delta * inv2sig2)));
}
function simpleStepF32(th, r0, eccU, peri, family, S) {
	const fr = Math.fround;
	let t = fr(th);
	const nSub = S[1] | 0, h = S[0];
	for (let s = 0; s < nSub; s++) t = fr(t + fr(simpleOmegaF32(t, r0, eccU, peri, family, S) * h));
	return fr(6.28318530718 * fractf(fr(t * 0.159154943092)));
}
{
	const sb = galaxy.createGalaxy({ type: 'SBb', seed: 3 });
	const e4 = galaxy.createGalaxy({ type: 'E4', seed: 1 });
	const irr = galaxy.createGalaxy({ type: 'Irr', seed: 5 });
	const savedEngine = orbit.getEngine();
	const savedDamp = orbit.getWaveDamping();

	// The engine lane is a composable bit mask (0.4.7): classic is the base
	// law and is also the fallback, simple and apocenter are passes the vertex
	// tests by bit, and a list of names ORs them together.
	check('the classic engine is the default and unknown names fall back to it',
		savedEngine === orbit.ENGINE_CLASSIC && orbit.engineName() === 'classic'
		&& orbit.ENGINE_SIMPLE === 2 && orbit.ENGINE_APOCENTER === 4,
		{ engine: savedEngine, name: orbit.engineName() });
	check('the engine switch round-trips by name, by id and as a mask',
		orbit.setEngine('simple') === orbit.ENGINE_SIMPLE && orbit.engineName() === 'simple'
		&& orbit.setEngine('bogus') === orbit.ENGINE_CLASSIC
		&& orbit.setEngine(orbit.ENGINE_SIMPLE) === orbit.ENGINE_SIMPLE
		&& orbit.setEngine(orbit.ENGINE_CLASSIC) === orbit.ENGINE_CLASSIC
		&& orbit.setEngine(['simple', 'apocenter']) === (orbit.ENGINE_SIMPLE | orbit.ENGINE_APOCENTER)
		&& orbit.engineName() === 'simple apocenter',
		{ mask: orbit.getEngine(), name: orbit.engineName() });

	// Per-type derivation table (plan §10.1): the demo's hand-tuned constants
	// become the model's own curve, group speed, arms and dispersion.
	const P = orbit.simpleDerived(sb, {});
	check('an armed SBb derives the demo-anchored lane (σ ≈ 0.20, ecc ≈ 0.21)',
		P.armed && P.m === 2 && Math.abs(Math.sqrt(1 / (2 * P.inv2sig2)) - 0.201) < 0.005
		&& Math.abs(P.eccMax - 0.207) < 0.005 && Math.abs(P.omegaP - 0.0439) < 0.002,
		{ sigma: +Math.sqrt(1 / (2 * P.inv2sig2)).toFixed(4), ecc: +P.eccMax.toFixed(4), omegaP: +P.omegaP.toFixed(4) });
	const Pe = orbit.simpleDerived(e4, {});
	check('an unarmed E4 packs no lane, no eccentricity, pure slow rotation',
		!Pe.armed && Pe.m === 0 && Pe.eccMax === 0 && Pe.omegaP === 0
		&& Math.abs(orbit.simpleOmegaMax(Pe) - 0.021) < 0.005,
		{ armed: Pe.armed, ecc: Pe.eccMax, omax: +orbit.simpleOmegaMax(Pe).toFixed(4) });
	const Pi = orbit.simpleDerived(irr, {});
	check('a hot Irr clamps the eccentricity at 0.6 (dispersion-dominated)',
		Pi.armed && Pi.m === 4 && Pi.eccMax === 0.6, { ecc: Pi.eccMax, m: Pi.m });
	const wide = galaxy.createGalaxy({ type: 'Sc', seed: 5, overrides: { arms: { m: 4, pitchDeg: 60, Rs: 3, minRadius: 0.5, amp: 0.3, phase0: 0 } } });
	check('the lane never bridges half the interarm (σ caps at armOffset/4)',
		Math.abs(orbit.simpleSigma(wide) - Math.PI / 8) < 1e-12, { sigma: orbit.simpleSigma(wide) });
	const demo = galaxy.createGalaxy({ type: 'Sc', seed: 5, overrides: { arms: { m: 2, pitchDeg: 15, Rs: 3, minRadius: 0.5, amp: 0.3, phase0: 0 } } });
	check('at the demo geometry the lane is exactly the demo 0.25 rad',
		orbit.simpleSigma(demo) === 0.25, { sigma: orbit.simpleSigma(demo) });

	// The honest inertial signature: the slowdown is the same Gaussian on
	// both sides of corotation — what flips is the pattern-frame drift. At
	// full damping the arm itself freezes anywhere.
	orbit.setWaveDamping(1);
	const Ps = orbit.simpleDerived(MW, {});
	const armIn = density.armRidgeAzimuth(MW, 2), armOut = density.armRidgeAzimuth(MW, 10);
	const onIn = orbit.simpleOmega(armIn, 2, 0, 0, orbit.FAMILY_DISC, Ps, 0);
	const offIn = orbit.simpleOmega(armIn + Math.PI / 2, 2, 0, 0, orbit.FAMILY_DISC, Ps, 0);
	const onOut = orbit.simpleOmega(armOut, 10, 0, 0, orbit.FAMILY_DISC, Ps, 0);
	const offOut = orbit.simpleOmega(armOut + Math.PI / 2, 10, 0, 0, orbit.FAMILY_DISC, Ps, 0);
	check('inside corotation the star overtakes the pattern between arms and sticks on them',
		offIn - Ps.omegaP > 0 && onIn === 0, { off: +offIn.toFixed(4), on: onIn, omegaP: +Ps.omegaP.toFixed(4) });
	check('outside corotation the pattern overtakes the star, which still freezes on-arm',
		offOut - Ps.omegaP < 0 && onOut === 0, { off: +offOut.toFixed(5), on: onOut });

	// Families: the bar is a two-ended capture lane, pressure spins slow and
	// undamped, a flat-less disc is frozen, the centre cannot NaN.
	//
	// The bar's field is the arm jam folded onto the bar's own axis: a star on
	// the major axis is slowed toward the pattern (captured, the lane that holds
	// the bar's shape), a star in the wings streams at the full group rate
	// Omega(r), and the 3-D cosine releases both above the disc's height. A
	// rigid omega_p everywhere was the 0.4.5 form — it glued the wings to the
	// pattern, which is the "solid body" look the field exists to avoid. The
	// classic engine's seat + x1 loop is the closed-form equivalent (and stays
	// rigid there, where T is a parameter rather than an integration).
	const barAxis = orbit.simpleDerived(MW, {}).barTilt;
	const barCirc = Ps.vFlat / 2;
	const onAxisBar = orbit.simpleOmega(barAxis, 2, 0, 0, orbit.FAMILY_BAR, Ps, 0, 0);
	const wingBar = orbit.simpleOmega(barAxis + Math.PI / 2, 2, 0, 0, orbit.FAMILY_BAR, Ps, 0, 0);
	const highBar = orbit.simpleOmega(barAxis, 2, 0, 0, orbit.FAMILY_BAR, Ps, 0, Ps.verticalScale);
	check('the bar field captures on its major axis, streams in the wings and releases with height',
		onAxisBar > Ps.omegaP && onAxisBar < wingBar
		&& Math.abs(wingBar - barCirc) < 1e-5      // exp(-12) lane floor, not exactly 0
		&& Math.abs(highBar - barCirc) < 1e-9
		&& orbit.simpleOmega(0.3, 2, 0.9, 1.2, orbit.FAMILY_BAR, Ps, 0.5, 0) !== Ps.omegaP,
		{ onAxis: +onAxisBar.toFixed(5), wing: +wingBar.toFixed(5), high: +highBar.toFixed(5), circ: +barCirc.toFixed(5) });
	check('pressure spins at λ·clock with no damping and no eccentricity',
		Math.abs(orbit.simpleOmega(1, 5, 0.99, 0, orbit.FAMILY_PRESSURE, Ps, 0)
			- 0.15 * orbit.pressureClock(Ps, 5)) < 1e-12);
	check('without a flat curve the disc rate is exactly zero (unarmed E4)',
		orbit.simpleOmega(1, 5, 0.5, 0, orbit.FAMILY_DISC, Pe, 0) === 0);
	check('a star at the centre rides vFlat/rCore, finite, never log(0)',
		Number.isFinite(orbit.simpleStepTheta(0.5, 0, 0.5, 0, orbit.FAMILY_DISC, Ps, 0, 1))
		&& Math.abs(orbit.simpleOmega(0.5, 0, 0.5, 0, orbit.FAMILY_DISC, Ps, 0) - 0.45) < 1e-12);

	// The stepper: frozen time dispatches nothing, the substep cap absorbs
	// tab-switch spikes, the pattern phase is derived from T per frame.
	const sub0 = orbit.simpleSubsteps(0, 0.45, {});
	const subMW = orbit.simpleSubsteps(1, orbit.simpleOmegaMax(Ps), {});
	const subSpike = orbit.simpleSubsteps(1000, 0.45, {});
	check('frozen time steps nothing; 1 Myr at MW rates takes 3 substeps; spikes cap at 8',
		sub0.n === 0 && sub0.h === 0 && subMW.n === 3 && Math.abs(subMW.h - 1 / 3) < 1e-12
		&& subSpike.n === 8 && subSpike.h === 125,
		{ subMW, subSpike });
	check('the pattern phase is wrap(Ωp·T) per frame, zero without a pattern',
		Math.abs(orbit.simplePatternPhase(MW, 100) - 4.3934) < 0.001
		&& orbit.simplePatternPhase(e4, 100) === 0 && orbit.simplePatternPhase(MW, -5) === 0);
	orbit.setWaveDamping(0.33);
	check('the wave slider is live in the simple derived numbers too',
		orbit.simpleDerived(sb, {}).damping === 0.33);

	// The compute uniform: 20 floats, substeps and pattern phase packed with
	// the curve, the lane and the centre — unarmed packs m = 0.
	const S = new Float32Array(orbit.SIMPLE_UNIFORM_FLOATS);
	orbit.setWaveDamping(0.6);
	const Psb = orbit.simpleDerived(sb, {});
	orbit.packSimpleParams(sb, S, 0, 1, 1000, 100);
	check('the step uniform packs h/nSub/count/phase, curve, lane and centre',
		S.length === 20 && S[1] === 3 && S[0] === Math.fround(1 / 3) && S[2] === 1000
		&& S[3] === Math.fround(orbit.simplePatternPhase(sb, 100))
		&& S[4] === Math.fround(Psb.vFlat) && S[9] === 2 && S[15] === Math.fround(sb.centre.x)
		&& S[16] === Math.fround(0.6),
		{ h: S[0], nSub: S[1], count: S[2], phase: +S[3].toFixed(4), damping: S[16] });
	const Se = new Float32Array(orbit.SIMPLE_UNIFORM_FLOATS);
	orbit.packSimpleParams(e4, Se, 0, 1, 10, 0);
	check('unarmed packs m = 0 with the rate floor intact', Se[9] === 0 && Se[1] === 1 && Se[0] === 1);
	const E = new Float32Array(4);
	orbit.setEngine('simple');
	orbit.packEngineVec(sb, E, 0);
	check('the engine lane carries (mask, apocenterForce, barTilt, share)',
		E[0] === orbit.ENGINE_SIMPLE && E[1] === Math.fround(orbit.getApocenterForce())
		&& E[2] === 0 && E[3] === orbit.getApocenterShare(),
		{ lane: Array.from(E) });
	orbit.setEngine(savedEngine);

	// Vertex mirror: the azimuth turns in the star's own centre-crossing orbital
	// plane, so spherical galactocentric radius (not birth z) is conserved.
	orbit.simpleLandmarksInit(new Float64Array([MW.centre.x + 8.178, 0, 0.1]), new Uint8Array([5]), 1, MW);
	const thSun = Math.atan2(0 - 0, MW.centre.x + 8.178 - MW.centre.x);
	const birthRadius = Math.hypot(8.178, 0.1);
	orbit.simplePositionFromTheta(out, Math.PI / 2, MW.centre.x + 8.178, 0, 0.1, 0, orbit.FAMILY_DISC, Ps.eccMax, MW);
	check('the 3-D reconstruction rotates in its centre-crossing plane and conserves radius',
		Math.abs(Math.hypot(out[0] - MW.centre.x, out[1], out[2]) - birthRadius) < 1e-9,
		{ pos: [out[0], out[1], out[2]], thSun, birthRadius });

	// The CPU landmark mirror steps the same Euler the GPU dispatches, so it
	// must agree with the reference step bit-for-bit — labels and picks ride it.
	const lmPos = new Float64Array([MW.centre.x + 8.178, 0, 0.1, MW.centre.x + 2, 1, -0.2, MW.centre.x - 3, 2, 0.5]);
	const lmCol = new Uint8Array([5, 1, 3]);
	orbit.simpleLandmarksInit(lmPos, lmCol, 3, MW);
	orbit.simpleLandmarksStep(50, 200);
	const Pd = orbit.simpleDerived(MW, {});
	const ppd = orbit.simplePatternPhase(MW, 200);
	let mirrorWorst = 0;
	for (let i = 0; i < 3; i++) {
		const bx = lmPos[i * 3], by = lmPos[i * 3 + 1], bz = lmPos[i * 3 + 2];
		const r0 = Math.hypot(bx - MW.centre.x, by - 0);
		const fam = orbit.familyFromColorIndex(lmCol[i]);
		// The reference step carries the same height the mirror does: the 3-D
		// cosine in simpleOmega reads z, and a reference that dropped it would
		// disagree by the whole vertical factor (0.12 kpc on this fixture).
		const th = orbit.simpleStepTheta(Math.atan2(by - 0, bx - MW.centre.x), r0,
			orbit.simpleEccOf(0), orbit.simplePeriOf(0), fam, Pd, ppd, 50, bz);
		const ref = new Float64Array(3);
		orbit.simplePositionFromTheta(ref, th, bx, by, bz, 0, fam, orbit.simpleEccMax(MW), MW);
		const got = new Float64Array(3);
		orbit.simpleLandmarkPosition(got, i, bz);
		mirrorWorst = Math.max(mirrorWorst, dist3(ref, got));
	}
	check('the landmark mirror agrees with the reference step bit-for-bit',
		mirrorWorst === 0, { mirrorWorst });

	// f32 replay: 1000 epochs of 1 Myr, on the packed uniform the GPU reads.
	// Euler in f32 against Euler in f64 — the drift must stay far subpixel.
	const Sr = new Float32Array(orbit.SIMPLE_UNIFORM_FLOATS);
	orbit.packSimpleParams(MW, Sr, 0, 1, 1000, 0);
	const Pr = orbit.simpleDerived(MW, {});
	let th64 = 1.0, th32 = Math.fround(1.0);
	for (let k = 0; k < 1000; k++) {
		th64 = orbit.simpleStepTheta(th64, 8.178, 0.5, 0, orbit.FAMILY_DISC, Pr, 0, 1);
		th32 = simpleStepF32(th32, 8.178, 0.5, 0, orbit.FAMILY_DISC, Sr);
	}
	const drift = Math.abs(th64 - th32);
	check('f64 reference vs f32 step replay drift < 1e-4 rad over 1000 Myr',
		drift < 1e-4, { drift: +drift.toExponential(2) });

	orbit.setWaveDamping(savedDamp);
}

// --- 12. Apocenter-guided engine (0.4.7) -------------------------------
{
	const savedEngine = orbit.getEngine();
	const savedScale = orbit.getPatternScale();
	const apoOut = new Float64Array(3);
	orbit.setPatternScale(1, 0, MW);
	orbit.resetPatternPhaseOffset();
	orbit.setEngine('apocenter');
	check('apocenter is a named third engine and its mask bit round-trips',
		orbit.ENGINE_APOCENTER === 4 && orbit.setEngine(4) === 4
		&& orbit.engineName() === 'apocenter' && orbit.setEngine('apocenter') === 4);

	let identityWorst = 0;
	for (let family = 0; family < 4; family++) {
		orbit.orbitPosition(apoOut, MW.centre.x + 5.2, -1.3, 0.4, family, 7, 15, 0, MW);
		identityWorst = Math.max(identityWorst, dist3(apoOut, [MW.centre.x + 5.2, -1.3, 0.4]));
	}
	check('apocenter T = 0 is exact for all four families at a non-origin centre', identityWorst === 0, identityWorst);

	const targetR = 8;
	const ridge = density.armRidgeAzimuth(MW, targetR);
	const expectedArmApo = ridge + Math.floor((0 - ridge) * MW.arms.m / orbit.TAU + 0.5) * orbit.TAU / MW.arms.m;
	const actualArmApo = orbit.apocenterAngle(0, targetR, orbit.FAMILY_DISC, MW);
	const barApo = orbit.apocenterAngle(0, 2, orbit.FAMILY_BAR, MW);
	const expectedBarApo = MW.spheroid.tiltDeg * Math.PI / 180
		+ Math.floor((0 - MW.spheroid.tiltDeg * Math.PI / 180) / Math.PI + 0.5) * Math.PI;
	check('disc apsides select the nearest spiral ridge and bar apsides use the model bar angle',
		Math.abs(actualArmApo - expectedArmApo) < 1e-12 && Math.abs(barApo - expectedBarApo) < 1e-12,
		{ actualArmApo, expectedArmApo, barApo, expectedBarApo });

	const cr = MW.dynamics.vFlat / orbit.effectivePatternSpeed(MW);
	const crApo = orbit.apocenterAngle(0, cr, orbit.FAMILY_DISC, MW);
	const crX = MW.centre.x + cr * Math.cos(crApo), crY = cr * Math.sin(crApo);
	orbit.orbitPosition(apoOut, crX, crY, 0, orbit.FAMILY_DISC, 0, 15, 0, MW);
	orbit.orbitPosition(out, crX, crY, 0, orbit.FAMILY_DISC, 0, 15, 20, MW);
	const crAngleAfter = Math.atan2(out[1], out[0] - MW.centre.x);
	const crRadiusAfter = Math.hypot(out[0] - MW.centre.x, out[1]);
	check('an apocenter at corotation rotates with the pattern around the model centre',
		Math.abs(crRadiusAfter - cr) < 1e-8
		&& Math.abs(Math.atan2(Math.sin(crAngleAfter - crApo - orbit.effectivePatternSpeed(MW) * 20),
			Math.cos(crAngleAfter - crApo - orbit.effectivePatternSpeed(MW) * 20))) < 1e-8,
		{ initialRadius: cr, finalRadius: crRadiusAfter, angle: crAngleAfter });

	const eccentricity = orbit.APOCENTER_ECC_MAX * 15.5 / 16;
	const apoAngularRate = Math.sqrt(1 - eccentricity * eccentricity) / ((1 + eccentricity) * (1 + eccentricity));
	const periAngularRate = Math.sqrt(1 - eccentricity * eccentricity) / ((1 - eccentricity) * (1 - eccentricity));
	check('Kepler motion dwells at apocenter (angular speed lower than at pericenter)',
		apoAngularRate < periAngularRate && Number.isFinite(orbit.solveEccentricAnomaly(1e6, eccentricity)),
		{ apoAngularRate, periAngularRate });

	let bounded = true;
	for (const t of [-10000, -2500, 2500, 10000]) {
		orbit.orbitPosition(apoOut, MW.centre.x + 6, 2, 0.4, orbit.FAMILY_DISC, 9, 15, t, MW);
		const d = Math.hypot(apoOut[0] - MW.centre.x, apoOut[1], apoOut[2]);
		bounded = bounded && Number.isFinite(d) && d > 0 && d < 20;
	}
	check('the eccentric orbit stays finite and bounded in both time directions', bounded);

	const packedDynamics = new Float32Array(16);
	orbit.packOrbitDynamics(MW, packedDynamics, 0);
	const apoDynA = Array.from(packedDynamics.subarray(0, 4));
	const apoWaveA = Array.from(packedDynamics.subarray(8, 12));
	const apoWaveB = Array.from(packedDynamics.subarray(12, 16));
	const apoEngine = [2, orbit.APOCENTER_ECC_MAX, MW.spheroid.tiltDeg * Math.PI / 180, 0].map(Math.fround);
	const apoCases = [
		[MW.centre.x + 6, 1.5, 0.4, orbit.FAMILY_DISC, 5, 13, 120],
		[MW.centre.x + 2, -0.7, 0.2, orbit.FAMILY_BAR, 11, 15, 900],
		[MW.centre.x + 8, 0.2, -0.1, orbit.FAMILY_PRESSURE, 7, 9, -3000],
		[MW.centre.x + 3, 2, 0.6, orbit.FAMILY_PATTERN, 1, 12, 10000],
	];
	let apoParityWorst = 0;
	for (const [x, y, z, family, phase, amp, t] of apoCases) {
		const packed = records.packPacked(4, 3,
			orbit.flagsWithFamily(records.FLAG_VISIBLE, family), orbit.encodeJitter(phase, amp));
		orbit.apocenterPosition(apoOut, x, y, z, family, phase, amp, t, MW);
		const gpu = apocenterPositionF32(x, y, z, packed,
			[MW.centre.x, MW.centre.y, MW.centre.z], t, apoDynA, apoWaveA, apoWaveB, apoEngine);
		apoParityWorst = Math.max(apoParityWorst, dist3(apoOut, gpu));
	}
	check('apocenter CPU law agrees with an f32 replay of its WGSL inputs within 0.05 kpc',
		apoParityWorst < 0.05, apoParityWorst);

	orbit.setPatternScale(1, 0, MW);
	orbit.resetPatternPhaseOffset();
	orbit.orbitPosition(apoOut, MW.centre.x + 6, 2, 0.2, orbit.FAMILY_DISC, 6, 12, 100, MW);
	orbit.setPatternScale(1.5, 100, MW);
	orbit.orbitPosition(out, MW.centre.x + 6, 2, 0.2, orbit.FAMILY_DISC, 6, 12, 100, MW);
	check('changing pattern speed preserves apocenter-orbit phase', dist3(apoOut, out) < 1e-8, dist3(apoOut, out));
	orbit.setPatternScale(savedScale, 0, MW);
	orbit.resetPatternPhaseOffset();
	orbit.setEngine(savedEngine);
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
