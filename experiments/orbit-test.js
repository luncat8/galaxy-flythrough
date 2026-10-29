// experiments/orbit-test.js
// The 0.4 orbit law, on the numbers of plan §1.1/§1.4 of
// archive/0.4.0-plan-star-move.md plus the 0.4.3 group-kinematics rewrite:
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

const path = require('path');
const logFile = require('./log-file.js');

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

// --- Formation gate: CPU mirror of the sprite's WGSL smoothstep ----------
{
	let monotone = true;
	let previous = -1;
	for (let i = 0; i <= 100; i++) {
		const gate = orbit.gateAt(2, 2 + orbit.BIRTH_FADE_GYR * i / 100);
		if (gate < previous) monotone = false;
		previous = gate;
	}
	check('the formation gate is exactly 0/1 at its boundaries and continuous inside',
		orbit.gateAt(2, 2) === 0
		&& orbit.gateAt(2, 2 + orbit.BIRTH_FADE_GYR) === 1
		&& Math.abs(orbit.gateAt(2, 2 + orbit.BIRTH_FADE_GYR * 0.5) - 0.5) < 1e-14
		&& monotone,
		{ fade: orbit.BIRTH_FADE_GYR, midpoint: orbit.gateAt(2, 2 + orbit.BIRTH_FADE_GYR * 0.5) });
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
	const extent = MW.spheroid.a * MW.spheroid.r0; // the MW preset's bar end
	const expected = (1 - 1 / Math.SQRT2) * dyn.vFlat / Math.max(extent, dyn.rCore);
	check('the Milky Way pattern speed is the group precession rate at the bulge radius',
		Math.abs(dyn.omegaPattern - expected) < 1e-12, { omegaPattern: dyn.omegaPattern, expected });

	const wBar = orbit.omegaFor(orbit.FAMILY_BAR, 1, 0, MW);
	check('bar/pattern period 219 ± 1 Myr (derived ω_p = 0.0287 rad/Myr = 28 km/s/kpc)',
		Math.abs(orbit.TAU / wBar - 219) < 1, { omega: wBar, period: orbit.TAU / wBar });

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
	// overtakes the pattern inside corotation. That is the density wave. The
	// probe sits in the arm region (past the bar-end inner edge) and inside
	// corotation, where the star is still converging onto the crest, so the
	// comparison is wrap-aware: the disc ends the window ahead of the pattern.
	const aDisc = sweep(MW.centre.x + 6, 0, orbit.FAMILY_DISC, t, 4, 8);
	let dDisc = aDisc - aYoung;
	dDisc = dDisc - orbit.TAU * Math.round(dDisc / orbit.TAU);
	check('the embedded disc star overtakes the pattern inside corotation (differential belt)',
		dDisc > 0.05 && dDisc < Math.PI / 2, { disc: +dDisc.toFixed(3), young: +aYoung.toFixed(3) });

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
		for (const type of ['SB0', 'SBa', 'SBc', 'SBd']) {
			const m = galaxy.createGalaxy({ type, seed: 21 });
			const dd = orbit.fillDynamics({}, m);
			const km = dd.omegaPattern * 978;
			const end = m.spheroid.profile === 'bar' ? m.spheroid.a * m.spheroid.r0 : m.spheroid.a * m.spheroid.r0;
			const beyond = dd.omegaPattern > 0 && dd.vFlat / dd.omegaPattern > end;
			if (!(km > 30 && km < 56 && beyond)) bad.push({ type, km, rCr: dd.vFlat / dd.omegaPattern, end });
		}
		check('every barred table type: derived ω_p in the observed 33-55 km/s/kpc band, corotation past the bar end',
			bad.length === 0, { bad });
		// Documented drift: the preset's measured half-length (2.3 kpc, the
		// longest bar in the repo) under the demo-anchored precession factor
		// derives 28 km/s/kpc, below the 33-55 band, and is left that way —
		// the shape is the observed one, the factor is the 0.4 convention.
		// Corotation still sits well past the bar end.
		const dp = orbit.fillDynamics({}, MW);
		const kmP = dp.omegaPattern * 978;
		check('the MW preset derives 28 km/s/kpc — below the band, documented drift — with corotation past the bar end',
			Math.abs(kmP - 28.02) < 0.05 && dp.vFlat / dp.omegaPattern > MW.spheroid.a * MW.spheroid.r0,
			{ km: +kmP.toFixed(2), rCr: +(dp.vFlat / dp.omegaPattern).toFixed(2) });
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
		const av = fr(Math.min(fr(fr(0.2) * ah), fr(fr(0.5) * fr(Math.max(fr(dynB[2] - fr(Math.abs(qz))), 0)))));
		wr = fr(ah * fr(sinTauF(fr(phase + kappa * time)) - sinPh));
		wz = fr(av * fr(sinTauF(fr(phase + fr(1.57079632679) + kappa * time)) - sinPhV));
	} else if (family === 3) {
		const a = fr(rank * dynB[1]);
		const mean = pressureClockF();
		wr = fr(a * fr(sinTauF(fr(phase + mean * time)) - sinPh));
		wz = fr(a * fr(sinTauF(fr(phase + fr(1.57079632679) + mean * time)) - sinPhV));
	}
	const radius = fr(Math.sqrt(fr(fr(qx * qx) + fr(qy * qy) + fr(qz * qz))));
	const xy = fr(Math.sqrt(fr(fr(qx * qx) + fr(qy * qy))));
	// orbitPlane: disc/pattern sweep a horizontal plane through the birth
	// height (anchor = the birth cylinder, carry = qz); bar/pressure keep the
	// centred inclined plane (anchor = the 3-D radius, carry = 0).
	let e0x, e0y, e0z, e1x, e1y, e1z, nx, ny, nz, anchor, carry;
	if ((family === 1 || family === 0) && xy > 1e-9) {
		const invXy = fr(1 / xy);
		e0x = fr(qx * invXy); e0y = fr(qy * invXy); e0z = 0;
		e1x = fr(-qy * invXy); e1y = fr(qx * invXy); e1z = 0;
		nx = 0; ny = 0; nz = 1;
		anchor = xy; carry = qz;
	} else {
		const invRadius = radius > 1e-9 ? fr(1 / radius) : 0;
		e0x = radius > 1e-9 ? fr(qx * invRadius) : 1;
		e0y = radius > 1e-9 ? fr(qy * invRadius) : 0;
		e0z = radius > 1e-9 ? fr(qz * invRadius) : 0;
		const azx = xy > 1e-9 ? fr(-qy / xy) : 0;
		const azy = xy > 1e-9 ? fr(qx / xy) : 1;
		const ezx = fr(-e0z * azy), ezy = fr(e0z * azx), ezz = fr(fr(e0x * azy) - fr(e0y * azx));
		const rankIncl = fr(fr(amp + 0.5) / 16);
		const direction = fr(Math.sin(fr(fr(phase / fr(6.28318530718)) * fr(6.28318530718))));
		const inc = family === 2 ? fr(fr(0.12 * rankIncl) * direction)
			: family === 3 ? fr(phase + fr(rankIncl * fr(0.392699081699))) : 0;
		const ci = fr(Math.cos(inc)), si = fr(Math.sin(inc));
		e1x = fr(fr(azx * ci) + fr(ezx * si));
		e1y = fr(fr(azy * ci) + fr(ezy * si));
		e1z = fr(ezz * si);
		nx = fr(fr(e0y * e1z) - fr(e0z * e1y));
		ny = fr(fr(e0z * e1x) - fr(e0x * e1z));
		nz = fr(fr(e0x * e1y) - fr(e0y * e1x));
		anchor = radius; carry = 0;
	}
	const ct = fr(Math.cos(theta)), st = fr(Math.sin(theta));
	const rx = fr(fr(e0x * ct) + fr(e1x * st));
	const ry = fr(fr(e0y * ct) + fr(e1y * st));
	const rz = fr(fr(e0z * ct) + fr(e1z * st));
	const orbitRadius = anchor > 1e-9 ? fr(anchor + wr) : 0;
	const normalWobble = anchor > 1e-9 ? wz : 0;
	return [
		fr(fr(cx) + fr(fr(orbitRadius * rx) + fr(normalWobble * nx))),
		fr(fr(0) + fr(fr(orbitRadius * ry) + fr(normalWobble * ny))),
		fr(fr(0) + fr(fr(orbitRadius * rz) + fr(normalWobble * nz) + carry)),
	];
}
function apocenterPositionF32(px, py, pz, packed, centre, time, dynA, waveA, waveB, engine) {
	const fr = Math.fround, TAU = fr(6.28318530718), PI = fr(3.14159265359);
	if (time === 0) return [fr(px), fr(py), fr(pz)];
	// The shipping CPU selector IS the f32 mirror of the WGSL gate.
	if (!orbit.apocenterSelected(px, py, pz)) return [fr(px), fr(py), fr(pz)];
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
	// orbitPlane: disc/pattern sweep a horizontal plane through the birth
	// height (anchor = the birth cylinder, carry = qz); bar/pressure keep the
	// centred inclined plane (anchor = the 3-D radius, carry = 0). `a` reads the
	// anchor so the ellipse passes through the birth point.
	const xy = fr(Math.hypot(qx, qy));
	let e0x, e0y, e0z, e1x, e1y, e1z, anchor, carry;
	if ((family === 1 || family === 0) && xy > 1e-9) {
		const invXy = fr(1 / xy);
		e0x = fr(qx * invXy); e0y = fr(qy * invXy); e0z = 0;
		e1x = fr(-qy * invXy); e1y = fr(qx * invXy); e1z = 0;
		anchor = xy; carry = qz;
	} else {
		const invRadius = fr(1 / radius);
		e0x = fr(qx * invRadius); e0y = fr(qy * invRadius); e0z = fr(qz * invRadius);
		const azx = xy > 1e-9 ? fr(-qy / xy) : 0, azy = xy > 1e-9 ? fr(qx / xy) : 1;
		const ezx = fr(-e0z * azy), ezy = fr(e0z * azx), ezz = fr(fr(e0x * azy) - fr(e0y * azx));
		const phase = fr(phaseBits * fr(0.392699081699));
		const inc = family === 2 ? fr(fr(0.12 * rank) * fr(Math.sin(phase)))
			: family === 3 ? fr(phase + fr(rank * fr(0.392699081699))) : 0;
		const ci = fr(Math.cos(inc)), si = fr(Math.sin(inc));
		e1x = fr(fr(azx * ci) + fr(ezx * si)), e1y = fr(fr(azy * ci) + fr(ezy * si)), e1z = fr(ezz * si);
		anchor = radius; carry = 0;
	}
	const a = fr(fr(anchor * fr(1 + fr(ecc * cosF))) / fr(1 - fr(ecc * ecc)));
	const localOmega = dynA[0] > 0 ? fr(dynA[0] / fr(Math.max(R, dynA[1])))
		: fr(fr(0.05) / fr(Math.max(fr(Math.pow(fr(Math.max(R, 0.1)), 1.5)), 0.01)));
	const meanRaw = fr(M0 + fr(fr(localOmega - dynA[2]) * fr(time)) - waveB[3]);
	const mean = fr(meanRaw - fr(TAU * Math.floor(fr(fr(meanRaw + PI) / TAU))));
	let E = mean;
	for (let i = 0; i < 5; i++) E = fr(E - fr(fr(E - fr(ecc * fr(Math.sin(E))) - mean) / fr(1 - fr(ecc * fr(Math.cos(E))))));
	const nu = fr(Math.atan2(fr(root * fr(Math.sin(E))), fr(Math.cos(E) - ecc)));
	const orbitRadius = fr(a * fr(1 - fr(ecc * fr(Math.cos(E)))));
	const delta = fr(fr(delta0 + fr(dynA[2] * fr(time))) + waveB[3]);
	const cd = fr(Math.cos(delta)), sd = fr(Math.sin(delta)), cv = fr(Math.cos(nu)), sv = fr(Math.sin(nu));
	const px1 = fr(fr(e0x * cd) + fr(e1x * sd)), py1 = fr(fr(e0y * cd) + fr(e1y * sd)), pz1 = fr(fr(e0z * cd) + fr(e1z * sd));
	const qpx = fr(fr(-e0x * sd) + fr(e1x * cd)), qpy = fr(fr(-e0y * sd) + fr(e1y * cd)), qpz = fr(fr(-e0z * sd) + fr(e1z * cd));
	return [
		fr(centre[0] + fr(orbitRadius * fr(fr(px1 * cv) + fr(qpx * sv)))),
		fr(centre[1] + fr(orbitRadius * fr(fr(py1 * cv) + fr(qpy * sv)))),
		fr(centre[2] + fr(orbitRadius * fr(fr(pz1 * cv) + fr(qpz * sv))) + carry),
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
		&& Math.abs(P.eccMax - 0.207) < 0.005 && Math.abs(P.omegaP - 0.0287) < 0.002,
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
	// The lane base carries the model's own phase: Φp(T) = wrap(Ωp·T − phase0/m).
	// The probes sit in the arm region — R = 4 is inside corotation, R = 10 past.
	const phi0 = orbit.simplePatternPhase(MW, 0);
	const armIn = density.armRidgeAzimuth(MW, 4), armOut = density.armRidgeAzimuth(MW, 10);
	const onIn = orbit.simpleOmega(armIn, 4, 0, 0, orbit.FAMILY_DISC, Ps, phi0);
	const offIn = orbit.simpleOmega(armIn + Math.PI / 2, 4, 0, 0, orbit.FAMILY_DISC, Ps, phi0);
	const onOut = orbit.simpleOmega(armOut, 10, 0, 0, orbit.FAMILY_DISC, Ps, phi0);
	const offOut = orbit.simpleOmega(armOut + Math.PI / 2, 10, 0, 0, orbit.FAMILY_DISC, Ps, phi0);
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
	// A fresh accumulator: with no pattern history yet, the mean rate *is* the
	// model's own, and the lane phase is the closed form the trace tools use.
	orbit.resetPatternPhase();
	check('the pattern phase is wrap(Ωp·T − phase0/m) per frame, the T=0 lane phase when frozen',
		Math.abs(orbit.simplePatternPhase(MW, 100) - 1.445) < 0.001
		&& Math.abs(orbit.simplePatternPhase(MW, 0) - 4.8629) < 0.001
		&& orbit.simplePatternPhase(MW, -5) === orbit.simplePatternPhase(MW, 0)
		&& orbit.simplePatternPhase(e4, 100) === 0);
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

	// Vertex mirror: the sweep basis is orbitPlane's. A disc star turns in the
	// plane parallel to the galactic one through its own birth height, so it
	// conserves the birth CYLINDER and carries the height (0.4.9: rotating a
	// centred plane put (qz/|q|)·cos(theta) into z and measured the field's
	// column at 0.66-0.87). A spheroidal star keeps the centred inclined plane,
	// where the spherical radius is the conserved quantity.
	const cylBirth = Math.hypot(8.178, 0);
	const sphBirth = Math.hypot(-3, 2, 0.5);
	const edgeDyn = orbit.fillDynamics({}, MW);
	const edgeR = 8.178;
	const edgeKappa = Math.SQRT2 * edgeDyn.vFlat / Math.max(edgeR, edgeDyn.rCore);
	const edgeTime = Math.PI / edgeKappa;
	const edgeMargin = 0.02;
	const edgeCut = edgeDyn.discHeight;
	const edgePackedDyn = new Float32Array(16);
	orbit.packOrbitDynamics(MW, edgePackedDyn, 0);
	const edgeDynA = edgePackedDyn.subarray(0, 4), edgeDynB = edgePackedDyn.subarray(4, 8);
	const edgeWaveA = edgePackedDyn.subarray(8, 12), edgeWaveB = edgePackedDyn.subarray(12, 16);
	orbit.orbitPosition(out, MW.centre.x + edgeR, MW.centre.y, MW.centre.z + edgeCut - edgeMargin,
		orbit.FAMILY_DISC, 8, 15, edgeTime, MW);
	const upperEdgeZ = out[2] - MW.centre.z;
	orbit.orbitPosition(out, MW.centre.x + edgeR, MW.centre.y, MW.centre.z - edgeCut + edgeMargin,
		orbit.FAMILY_DISC, 0, 15, edgeTime, MW);
	const lowerEdgeZ = out[2] - MW.centre.z;
	const edgeFlags = records.FLAG_VISIBLE | (1 << 3);
	const upperPacked = records.packPacked(4, 4.83, edgeFlags, orbit.encodeJitter(8, 15));
	const lowerPacked = records.packPacked(4, 4.83, edgeFlags, orbit.encodeJitter(0, 15));
	const upperF32 = orbitPositionF32(MW.centre.x + edgeR, MW.centre.y, MW.centre.z + edgeCut - edgeMargin,
		upperPacked, MW.centre.x, edgeTime, edgeDynA, edgeDynB, edgeWaveA, edgeWaveB);
	const lowerF32 = orbitPositionF32(MW.centre.x + edgeR, MW.centre.y, MW.centre.z - edgeCut + edgeMargin,
		lowerPacked, MW.centre.x, edgeTime, edgeDynA, edgeDynB, edgeWaveA, edgeWaveB);
	const upperF32Z = upperF32[2] - MW.centre.z, lowerF32Z = lowerF32[2] - MW.centre.z;
	check('the classic vertical wobble stays inside the explicit disc-height cut at both edges',
		upperEdgeZ <= edgeCut + 1e-8 && lowerEdgeZ >= -edgeCut - 1e-8
		&& Math.abs(upperEdgeZ - edgeCut) < 1e-8 && Math.abs(lowerEdgeZ + edgeCut) < 1e-8
		&& upperF32Z <= edgeCut + 1e-5 && lowerF32Z >= -edgeCut - 1e-5,
		{ upper: [upperEdgeZ, upperF32Z], lower: [lowerEdgeZ, lowerF32Z], cut: edgeCut, margin: edgeMargin });
	orbit.simplePositionFromTheta(out, Math.PI / 2, MW.centre.x + 8.178, 0, 0.1, 0, orbit.FAMILY_DISC, Ps.eccMax, MW);
	const discCyl = Math.hypot(out[0] - MW.centre.x, out[1]);
	const discZ = out[2];
	orbit.simplePositionFromTheta(out, Math.PI / 2, MW.centre.x - 3, 2, 0.5, 0, orbit.FAMILY_PRESSURE, Ps.eccMax, MW);
	const sphNow = Math.hypot(out[0] - MW.centre.x, out[1], out[2]);
	check('the reconstruction conserves the birth cylinder and carries the height for a disc star',
		Math.abs(discCyl - cylBirth) < 1e-9 && Math.abs(discZ - 0.1) < 1e-9,
		{ cyl: discCyl, birthCyl: cylBirth, z: discZ });
	check('a spheroidal star still sweeps its centred plane (spherical radius conserved)',
		Math.abs(sphNow - sphBirth) < 1e-9,
		{ sph: sphNow, birth: sphBirth });
	// The height is carried at every azimuth, not only at the quarter turn, and
	// the sweep stays in the horizontal plane: the horizontal distance is the
	// law's own eccentric rho (the vertical life an epicycle gives a disc star
	// is the classic law's bounded av, not this plane's geometry).
	let carried = true, planar = true;
	const eccU = (0 + 0.5) / 16, peri = 0;
	for (let k = 0; k < 24; k++) {
		const th = k * Math.PI / 12;
		orbit.simplePositionFromTheta(out, th, MW.centre.x + 8.178, 0, 0.1, 0, orbit.FAMILY_DISC, Ps.eccMax, MW);
		const rho = cylBirth * (1 + Ps.eccMax * eccU * Math.cos(th - peri));
		if (Math.abs(out[2] - 0.1) > 1e-9) carried = false;
		if (Math.abs(Math.hypot(out[0] - MW.centre.x, out[1]) - rho) > 1e-9) planar = false;
	}
	check('the disc star keeps its birth height and sweeps its own plane at every azimuth',
		carried && planar, { carried, planar });

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
		orbit.simpleLandmarkPosition(got, i);
		mirrorWorst = Math.max(mirrorWorst, dist3(ref, got));
	}
	check('the landmark mirror agrees with the reference step bit-for-bit',
		mirrorWorst === 0, { mirrorWorst });

	// f32 replay: 1000 epochs of 1 Myr, on the packed uniform the GPU reads.
	// Euler in f32 against Euler in f64 — the drift must stay far subpixel.
	const Sr = new Float32Array(orbit.SIMPLE_UNIFORM_FLOATS);
	orbit.packSimpleParams(MW, Sr, 0, 1, 1000, 0);
	const Pr = orbit.simpleDerived(MW, {});
	// The uniform's phase at T=0 is wrap(−phase0/m); the reference must carry
	// the same lane phase or the two sides disagree by the whole arm offset.
	const pp0 = orbit.simplePatternPhase(MW, 0);
	let th64 = 1.0, th32 = Math.fround(1.0);
	for (let k = 0; k < 1000; k++) {
		th64 = orbit.simpleStepTheta(th64, 8.178, 0.5, 0, orbit.FAMILY_DISC, Pr, pp0, 1);
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
	orbit.setPatternScale(1);
	orbit.resetPatternPhase();
	check('apocenter is a named third engine and its mask bit round-trips',
		orbit.ENGINE_APOCENTER === 4 && orbit.setEngine(4) === 4
		&& orbit.engineName() === 'apocenter' && orbit.setEngine('apocenter') === 4);
	orbit.setEngine(savedEngine);

	// The law itself, independent of the mask dispatch (which §13 covers):
	// share 1 guides every star, the default force is APOCENTER_ECC_MAX.
	let identityWorst = 0;
	for (let family = 0; family < 4; family++) {
		orbit.apocenterPosition(apoOut, MW.centre.x + 5.2, -1.3, 0.4, family, 7, 15, 0, MW);
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
	orbit.apocenterPosition(apoOut, crX, crY, 0, orbit.FAMILY_DISC, 0, 15, 0, MW);
	orbit.apocenterPosition(out, crX, crY, 0, orbit.FAMILY_DISC, 0, 15, 20, MW);
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
		orbit.apocenterPosition(apoOut, MW.centre.x + 6, 2, 0.4, orbit.FAMILY_DISC, 9, 15, t, MW);
		const d = Math.hypot(apoOut[0] - MW.centre.x, apoOut[1], apoOut[2]);
		bounded = bounded && Number.isFinite(d) && d > 0 && d < 20;
	}
	check('the eccentric orbit stays finite and bounded in both time directions', bounded);

	const packedDynamics = new Float32Array(16);
	orbit.packOrbitDynamics(MW, packedDynamics, 0);
	const apoDynA = Array.from(packedDynamics.subarray(0, 4));
	const apoWaveA = Array.from(packedDynamics.subarray(8, 12));
	const apoWaveB = Array.from(packedDynamics.subarray(12, 16));
	// The lane the GPU actually reads, via the shipping packer: mask bit 4,
	// the force, the model bar angle and share 1 (every star guided).
	// The CPU law and the replay below both read the module's share/force, so
	// they run under exactly the state the lane packs: apocenter mask, share 1.
	const savedShare = orbit.getApocenterShare();
	orbit.setEngine(orbit.ENGINE_APOCENTER);
	orbit.setApocenterShare(1);
	const apoLane = new Float32Array(4);
	orbit.packEngineVec(MW, apoLane, 0);
	const apoEngine = Array.from(apoLane);
	check('the packed apocenter lane is (mask bit, force, model bar angle, share)',
		apoEngine[0] === orbit.ENGINE_APOCENTER && apoEngine[1] === Math.fround(orbit.getApocenterForce())
		&& Math.abs(apoEngine[2] - Math.fround(MW.spheroid.tiltDeg * Math.PI / 180)) < 1e-7
		&& apoEngine[3] === 1,
		{ lane: apoEngine });
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

	orbit.setPatternScale(1);
	orbit.resetPatternPhase();
	// The accumulator is what the slider's continuity rides on (0.6 E4): at the
	// clock the field is on screen at, a rate change moves nothing — the phase
	// already turned is history — and only the future turns faster.
	orbit.setPatternClock(100, MW);
	orbit.apocenterPosition(apoOut, MW.centre.x + 6, 2, 0.2, orbit.FAMILY_DISC, 6, 12, 100, MW);
	orbit.setPatternScale(1.5);
	orbit.apocenterPosition(out, MW.centre.x + 6, 2, 0.2, orbit.FAMILY_DISC, 6, 12, 100, MW);
	const turnedAtOne = orbit.getPatternPhase();
	// Now the same 200 Myr turned at twice the rate: the phase the lanes carry
	// is the integral, and the product (mean rate)·T reproduces it exactly.
	orbit.setPatternScale(2);
	orbit.resetPatternPhase();
	orbit.setPatternClock(200, MW);
	orbit.apocenterPosition(out, MW.centre.x + 6, 2, 0.2, orbit.FAMILY_DISC, 6, 12, 200, MW);
	const mean = orbit.meanPatternSpeed(MW);
	check('changing pattern speed preserves the turned phase and integrates the future',
		Math.abs(turnedAtOne - 100 * MW.dynamics.omegaPattern) < 1e-9
		&& Math.abs(mean * 200 - orbit.getPatternPhase()) < 1e-9
		&& dist3(apoOut, out) > 0.05, { turnedAtOne, meanTimes: mean * 200 });
	orbit.setPatternScale(savedScale);
	orbit.resetPatternPhase();
	orbit.setEngine(savedEngine);
	orbit.setApocenterShare(savedShare);
}

// --- 13. The engine-mask dispatch (movement parity) ----------------------
// The vertex stage and orbit.engineLandmarkPosition must run one contract:
// passes classic → simple → apocenter, each replacing the position, baseline
// birth when neither classic nor simple is set, and the apocenter pass on the
// birth-selected subset only. The reference below re-states the contract's
// table independently of the dispatch implementation.
{
	const model = MW;
	const savedEngine = orbit.getEngine();
	const savedShare = orbit.getApocenterShare();
	const savedForce = orbit.getApocenterForce();
	const c = model.centre;
	const T = 250;
	// Four landmarks at distinct birth points (f64, like
	// landmarks.positions): a disc star, a pattern star, a third disc star
	// and one whose birth hash is SELECTED at share 0.5 — so the intermediate
	// share check exercises both sides of the subset.
	const lmBirth = Float64Array.of(
		c.x + 8.178, 0, 0.1,
		c.x + 3.5, 2.2, -0.15,
		c.x + 1.2, -0.9, 0.6,
		c.x + 3.05, -1.1, 0.15);
	const lmColor = Uint8Array.of(5, 1, 3, 5);   // G (disc), B (pattern), F (disc), G (disc)
	const N = 4;
	const dispatchOut = new Float64Array(3);
	const refOut = new Float64Array(3);

	function initMirror() {
		orbit.simpleLandmarksInit(lmBirth, lmColor, N, model);
	}
	// The contract's table, stated independently of engineLandmarkPosition.
	function reference(mask, i, time) {
		const bx = lmBirth[i * 3], by = lmBirth[i * 3 + 1], bz = lmBirth[i * 3 + 2];
		const fam = orbit.familyFromColorIndex(lmColor[i]);
		if (mask & orbit.ENGINE_SIMPLE) {
			const P = orbit.simpleDerived(model, {});
			const phase = orbit.simplePatternPhase(model, time);
			const r0 = Math.hypot(bx - c.x, by - c.y);
			const th = orbit.simpleStepTheta(Math.atan2(by - c.y, bx - c.x), r0,
				orbit.simpleEccOf(0), orbit.simplePeriOf(0), fam, P, phase, time, bz);
			orbit.simplePositionFromTheta(refOut, th, bx, by, bz, 0, fam, orbit.simpleEccMax(model), model);
		} else if (mask & orbit.ENGINE_CLASSIC) {
			orbit.orbitPosition(refOut, bx, by, bz, fam, 0, 0, time, model);
		} else {
			refOut[0] = bx; refOut[1] = by; refOut[2] = bz;
		}
		if ((mask & orbit.ENGINE_APOCENTER) && time !== 0 && orbit.apocenterSelected(bx, by, bz)) {
			orbit.apocenterPosition(refOut, bx, by, bz, fam, 0, 0, time, model);
		}
		return refOut;
	}

	orbit.setApocenterShare(1);
	orbit.setApocenterForce(orbit.APOCENTER_ECC_MAX);
	let tableWorst = 0, tableWorstMask = 0;
	const maskPositions = {};
	for (let mask = 1; mask <= 7; mask++) {
		orbit.setEngine(mask);
		initMirror();
		if (mask & orbit.ENGINE_SIMPLE) orbit.simpleLandmarksStep(T, T);
		maskPositions[mask] = [];
		for (let i = 0; i < N; i++) {
			orbit.engineLandmarkPosition(dispatchOut, i, lmBirth[i * 3], lmBirth[i * 3 + 1], lmBirth[i * 3 + 2], lmColor[i], T, model);
			reference(mask, i, T);
			const d = dist3(dispatchOut, refOut);
			if (d > tableWorst) { tableWorst = d; tableWorstMask = mask; }
			maskPositions[mask].push([dispatchOut[0], dispatchOut[1], dispatchOut[2]]);
		}
	}
	check('every mask 1–7 lands on the dispatch table (classic → simple → apocenter, birth baseline)',
		tableWorst < 1e-9, { tableWorst, tableWorstMask });

	// Non-vacuity at T = 250: each pair of laws must separate by > 0.1 kpc
	// on at least one landmark (inner stars rotate through a similar angle in
	// all three laws, so the proof is per-pair, not per-star) — or the table
	// check above could be passing on three copies of one law.
	const sep = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
	const maxSep = (ma, mb) => Math.max(...Array.from({ length: N }, (_, i) => sep(maskPositions[ma][i], maskPositions[mb][i])));
	const sepCS = maxSep(1, 2), sepCA = maxSep(1, 4), sepSA = maxSep(2, 4);
	check('classic, simple and apocenter-only are three distinct laws at T = 250',
		sepCS > 0.1 && sepCA > 0.1 && sepSA > 0.1, { sepCS, sepCA, sepSA });
	check('mask 3 masks classic (simple rebuilds from birth), mask 5/6 replace only the guided subset',
		sep(maskPositions[3][0], maskPositions[2][0]) < 1e-9
		&& sep(maskPositions[5][1], maskPositions[1][1]) > 0.1
		&& sep(maskPositions[6][0], maskPositions[2][0]) > 0.1,
		{ m3vsm2: sep(maskPositions[3][0], maskPositions[2][0]),
			m5classic: sep(maskPositions[5][1], maskPositions[1][1]),
			m6simple: sep(maskPositions[6][0], maskPositions[2][0]) });

	// T = 0: identity for masks without the simple bit; the simple masks keep
	// their documented eccentric-rho shape (seeded theta = birth azimuth).
	orbit.setEngine(orbit.ENGINE_APOCENTER);
	orbit.engineLandmarkPosition(dispatchOut, 0, lmBirth[0], lmBirth[1], lmBirth[2], lmColor[0], 0, model);
	check('mask 4 at T = 0 is the exact birth position (identity baseline + apocenter identity)',
		dist3(dispatchOut, [lmBirth[0], lmBirth[1], lmBirth[2]]) === 0, Array.from(dispatchOut));
	orbit.setEngine(orbit.ENGINE_CLASSIC | orbit.ENGINE_APOCENTER);
	orbit.engineLandmarkPosition(dispatchOut, 1, lmBirth[3], lmBirth[4], lmBirth[5], lmColor[1], 0, model);
	check('mask 5 at T = 0 is the birth position (classic identity)',
		dist3(dispatchOut, [lmBirth[3], lmBirth[4], lmBirth[5]]) < 1e-9, Array.from(dispatchOut));

	// Share edges: 0 freezes the apocenter pass entirely, 1 guides everyone,
	// and an intermediate share splits the landmarks deterministically by the
	// birth hash — the SAME subset at any time (membership is time-stable).
	orbit.setEngine(orbit.ENGINE_APOCENTER);
	const tA = 120, tB = 400;
	orbit.setApocenterShare(0);
	orbit.engineLandmarkPosition(dispatchOut, 0, lmBirth[0], lmBirth[1], lmBirth[2], lmColor[0], tA, model);
	check('share 0 leaves every star at its birth position (the pass never runs)',
		dist3(dispatchOut, [lmBirth[0], lmBirth[1], lmBirth[2]]) === 0, Array.from(dispatchOut));
	orbit.setApocenterShare(0.5);
	let splitOk = true, stableOk = true, guidedSeen = false, frozenSeen = false;
	for (let i = 0; i < N; i++) {
		const bx = lmBirth[i * 3], by = lmBirth[i * 3 + 1], bz = lmBirth[i * 3 + 2];
		const sel = orbit.apocenterSelected(bx, by, bz);
		if (sel) guidedSeen = true; else frozenSeen = true;
		for (const t of [tA, tB]) {
			orbit.engineLandmarkPosition(dispatchOut, i, bx, by, bz, lmColor[i], t, model);
			reference(orbit.ENGINE_APOCENTER, i, t);
			if (dist3(dispatchOut, refOut) > 1e-9) splitOk = false;
			// The ungated law: force share 1 while evaluating it, so the
			// membership the dispatch chose is what gets measured.
			let lawOk;
			if (sel) {
				orbit.setApocenterShare(1);
				orbit.apocenterPosition(refOut, bx, by, bz, orbit.familyFromColorIndex(lmColor[i]), 0, 0, t, model);
				orbit.setApocenterShare(0.5);
				lawOk = dist3(dispatchOut, refOut) < 1e-9;
			} else {
				lawOk = dist3(dispatchOut, [bx, by, bz]) === 0;
			}
			if (!lawOk) stableOk = false;
		}
	}
	check('share 0.5 splits the landmarks by the birth hash — both branches run — and the subset is the same at every time',
		splitOk && stableOk && guidedSeen && frozenSeen, { splitOk, stableOk, guidedSeen, frozenSeen });

	// Force edges: force 0 degenerates the ellipse to the local circular rate
	// (the birth radius is conserved exactly), nonzero force is eccentric.
	orbit.setApocenterShare(1);
	orbit.setApocenterForce(0);
	orbit.engineLandmarkPosition(dispatchOut, 0, lmBirth[0], lmBirth[1], lmBirth[2], lmColor[0], tB, model);
	const rBirth0 = Math.hypot(lmBirth[0] - c.x, lmBirth[1], lmBirth[2] - c.z);
	const rNow0 = Math.hypot(dispatchOut[0] - c.x, dispatchOut[1], dispatchOut[2] - c.z);
	orbit.setApocenterForce(orbit.APOCENTER_ECC_MAX);
	orbit.engineLandmarkPosition(refOut, 0, lmBirth[0], lmBirth[1], lmBirth[2], lmColor[0], tB, model);
	check('force 0 conserves the birth radius (circular limit) and differs from the eccentric orbit',
		Math.abs(rNow0 - rBirth0) < 1e-6 && dist3(dispatchOut, refOut) > 0.05,
		{ rBirth: rBirth0, rForce0: rNow0, sep: dist3(dispatchOut, refOut) });

	// The dispatch centres on the model's centre, not the world origin: the
	// Milky Way centre is at x = 8.178, and every mask's position must stay
	// within the model's scale of it.
	let centreOk = true;
	for (let mask = 1; mask <= 7; mask++) {
		for (let i = 0; i < N; i++) {
			const p = maskPositions[mask][i];
			if (!(Math.hypot(p[0] - c.x, p[1], p[2]) < 20)) centreOk = false;
		}
	}
	check('all seven masks orbit the nonzero model centre (positions stay bounded around it)',
		centreOk && c.x !== 0, { centre: [c.x, c.y, c.z] });

	orbit.setEngine(savedEngine);
	orbit.setApocenterShare(savedShare);
	orbit.setApocenterForce(savedForce);
}

// --- 14. The record dispatch (engineRecordPosition) -----------------------
// The picker walks *records*, so the record twin of the dispatch above has its
// own smoke (0.5.0-3): family/phase/amplitude come out of the packed word
// exactly as readOrbit decodes them, the classic mask moves the star and
// reports false, the simple mask is the honest gap (birth position + reports
// true), and the apocenter pass composes with both. The apocenter-only case is
// the one that needs a star actually IN the pool: with the UI default share
// the smoke star can sit outside the 30–35% subset and the run proves nothing
// either way (0.5.x worklog, open question 1). This retest forces share 1 —
// the packed word of that question, 0x00030000, at T = 0.5 — and pins the
// selected and unselected branches against the laws themselves.
{
	const model = galaxy.createGalaxy({ type: 'SBb', seed: 3 });
	const savedEngine = orbit.getEngine();
	const savedShare = orbit.getApocenterShare();
	const savedForce = orbit.getApocenterForce();
	const T = 0.5;
	const packed = 0x00030000;          // flags 0x03, jitter 0 → pattern, phase 0, amp 0
	const bx = model.centre.x + 3.1, by = 1.2, bz = 0.4;
	const recOut = new Float64Array(3);
	const refOut = new Float64Array(3);
	const bits = orbit.readOrbit(packed);
	const finite = () => Number.isFinite(recOut[0]) && Number.isFinite(recOut[1]) && Number.isFinite(recOut[2]);

	orbit.setApocenterForce(orbit.APOCENTER_ECC_MAX);

	// Classic: the record's own bits drive orbitPosition, the star moves, and
	// the dispatch reports "not approximated".
	orbit.setEngine(orbit.ENGINE_CLASSIC);
	const approxClassic = orbit.engineRecordPosition(recOut, bx, by, bz, packed, T, model);
	orbit.orbitPosition(refOut, bx, by, bz, bits.family, bits.phase, bits.amplitude, T, model);
	check('record smoke: the classic mask moves the star through its packed orbit bits and reports false',
		approxClassic === false && dist3(recOut, refOut) < 1e-12 && dist3(recOut, [bx, by, bz]) > 0.01 && finite(),
		{ pos: Array.from(recOut), moved: dist3(recOut, [bx, by, bz]), toLaw: dist3(recOut, refOut), approx: approxClassic });

	// The jitter byte is not decoration: phase/amplitude change the result.
	const packedDisc = (packed & 0x0000FFFF) | (orbit.flagsWithFamily(records.FLAG_VISIBLE, orbit.FAMILY_DISC) << 16);
	const packed2 = packedDisc | (orbit.encodeJitter(9, 14) << 24);
	orbit.engineRecordPosition(recOut, bx, by, bz, packed2, T, model);
	orbit.orbitPosition(refOut, bx, by, bz, orbit.FAMILY_DISC, 0, 0, T, model);
	check('record smoke: the packed phase/amplitude nibbles enter the classic law',
		dist3(recOut, refOut) > 1e-6, dist3(recOut, refOut));

	// Simple: a record's θ lives in the GPU compute buffer, so the dispatch
	// returns the birth position and SAYS so — the approximation is reported,
	// not silent.
	orbit.setEngine(orbit.ENGINE_SIMPLE);
	const approxSimple = orbit.engineRecordPosition(recOut, bx, by, bz, packed, T, model);
	check('record smoke: the simple mask returns the birth position and reports true',
		approxSimple === true && dist3(recOut, [bx, by, bz]) === 0, Array.from(recOut));

	// The open-question case: apocenter-only, the question's packed word,
	// T = 0.5 — with the star forced into the pool.
	orbit.setEngine(orbit.ENGINE_APOCENTER);
	orbit.setApocenterShare(1);
	const approxApo = orbit.engineRecordPosition(recOut, bx, by, bz, packed, T, model);
	orbit.apocenterPosition(refOut, bx, by, bz, bits.family, bits.phase, bits.amplitude, T, model);
	check('record smoke: in the apocenter pool, the apocenter-only mask moves the record (open question 1)',
		approxApo === false && finite() && dist3(recOut, [bx, by, bz]) > 0.05 && dist3(recOut, refOut) < 1e-12,
		{ moved: dist3(recOut, [bx, by, bz]), toLaw: dist3(recOut, refOut), approx: approxApo });

	// T = 0 is the identity and share 0 freezes the pass entirely.
	orbit.engineRecordPosition(recOut, bx, by, bz, packed, 0, model);
	const atZero = dist3(recOut, [bx, by, bz]) === 0;
	orbit.setApocenterShare(0);
	orbit.engineRecordPosition(recOut, bx, by, bz, packed, T, model);
	check('record smoke: T = 0 is the exact birth position and share 0 freezes the pass',
		atZero && dist3(recOut, [bx, by, bz]) === 0);

	// Per-star branch consistency at an intermediate share: selected records
	// follow the ellipse, unselected ones stay at birth, at every time.
	orbit.setApocenterShare(0.5);
	let splitOk = true, guided = false, frozen = false;
	for (let i = 0; i < 8; i++) {
		const sx = model.centre.x + 0.7 + i * 0.9, sy = -1.3 + i * 0.4, sz = 0.11 * i;
		const sel = orbit.apocenterSelected(sx, sy, sz);
		if (sel) guided = true; else frozen = true;
		for (const t of [T, 40]) {
			orbit.engineRecordPosition(recOut, sx, sy, sz, packed, t, model);
			if (sel) {
				orbit.setApocenterShare(1);
				orbit.apocenterPosition(refOut, sx, sy, sz, bits.family, bits.phase, bits.amplitude, t, model);
				orbit.setApocenterShare(0.5);
				if (dist3(recOut, refOut) > 1e-12) splitOk = false;
			} else if (dist3(recOut, [sx, sy, sz]) !== 0) splitOk = false;
		}
	}
	check('record smoke: share 0.5 splits records by the birth hash — both branches run',
		splitOk && guided && frozen, { splitOk, guided, frozen });

	// The composition rule: apocenter replaces the classic baseline for the
	// selected subset only; with the pass off it is exactly the classic law.
	orbit.setEngine(orbit.ENGINE_CLASSIC | orbit.ENGINE_APOCENTER);
	orbit.setApocenterShare(1);
	orbit.engineRecordPosition(recOut, bx, by, bz, packed, T, model);
	orbit.apocenterPosition(refOut, bx, by, bz, bits.family, bits.phase, bits.amplitude, T, model);
	const composed = dist3(recOut, refOut) < 1e-12;
	orbit.setApocenterShare(0);
	orbit.engineRecordPosition(recOut, bx, by, bz, packed, T, model);
	orbit.orbitPosition(refOut, bx, by, bz, bits.family, bits.phase, bits.amplitude, T, model);
	check('record smoke: the apocenter pass composes with classic — replaces for the pool, plain classic otherwise',
		composed && dist3(recOut, refOut) < 1e-12, { composed });

	orbit.setEngine(savedEngine);
	orbit.setApocenterShare(savedShare);
	orbit.setApocenterForce(savedForce);
}

// --- 14b. The drawn-velocity twin (engineRecordVelocity, ui.15) ------------
// §5's autopilot builds the nose from the target's velocity, and the game used
// to read that velocity as a one-frame difference of two drawn positions. At
// the fine clock rungs a frame is not a usable baseline: the drawn position is
// a f64 near 8 kpc, so its own ULP is ~55 km on that coordinate, while one
// real-time frame of a 42 km/s star is 0.7 km. The frame difference is then a
// 0 / one-ULP staircase whose steps read as thousands of km/s in a coordinate
// axis — the reported "nose changes direction every frame at small star times".
// The twin samples the same engine dispatch a fixed model-time baseline apart,
// so it is the drawn law's own derivative and independent of the ship clock.
// This block pins (a) the value against an independent fine-baseline central
// difference, (b) frame-to-frame stability at the real-time rung, and (c) the
// shipped frame difference's staircase as a negative control — without (c) the
// stability check would pass vacuously on a star that happened to sit still.
{
	const model = galaxy.MILKY_WAY;
	const savedEngine = orbit.getEngine();
	const savedShare = orbit.getApocenterShare();
	const savedForce = orbit.getApocenterForce();
	const SEC_MYR = 3.15576e13;
	const KPC_M = 3.085677581491367e19;
	const T = 5;                                   // Myr: the orbit law is under way
	const bx = 8, by = 0, bz = 0.1;                // solar circle: the coarse-ULP coordinate
	const packed = ((orbit.flagsWithFamily(records.FLAG_VISIBLE, orbit.FAMILY_DISC) << 16)
		| (orbit.encodeJitter(3, 7) << 24)) >>> 0;
	const v = new Float64Array(3), fineA = new Float64Array(3), fineB = new Float64Array(3);
	const pos = new Float64Array(3), next = new Float64Array(3), prevV = new Float64Array(3);

	orbit.setEngine(orbit.ENGINE_CLASSIC);
	orbit.setApocenterShare(savedShare);
	orbit.engineRecordVelocity(v, bx, by, bz, packed, T, model);
	const speedKms = Math.hypot(v[0], v[1], v[2]) * KPC_M / 1000;
	// An independent, much finer central difference (h = 10⁴ yr): the two differ
	// only by the 0.01 Myr baseline's own curvature, measured at 7·10⁻⁶ relative.
	const h = 1e-5;
	orbit.engineRecordPosition(fineA, bx, by, bz, packed, T - h, model);
	orbit.engineRecordPosition(fineB, bx, by, bz, packed, T + h, model);
	const invFine = 1 / (2 * h * SEC_MYR);
	const reference = [
		(fineB[0] - fineA[0]) * invFine,
		(fineB[1] - fineA[1]) * invFine,
		(fineB[2] - fineA[2]) * invFine,
	];
	const relErr = Math.hypot(v[0] - reference[0], v[1] - reference[1], v[2] - reference[2])
		/ Math.hypot(reference[0], reference[1], reference[2]);
	check('record velocity: the twin is the drawn law\'s derivative in kpc per ship-second',
		Math.abs(speedKms - 42.4) < 1 && relErr < 1e-4,
		{ speedKms, relErr });

	// The frame-by-frame test at the real-time rung (1 s/s at 60 fps). The
	// shipped measurement is the consecutive-position difference the game feed
	// used; the twin must not inherit its staircase.
	const dtShip = 1 / 60;
	const dtMyr = dtShip / SEC_MYR;
	orbit.engineRecordPosition(pos, bx, by, bz, packed, T, model);
	orbit.engineRecordVelocity(prevV, bx, by, bz, packed, T, model);
	let t = T, maxFrameKms = 0, frameSpikes = 0, maxStepDeg = 0;
	for (let f = 0; f < 400; f++) {
		t += dtMyr;
		orbit.engineRecordPosition(next, bx, by, bz, packed, t, model);
		const dx = (next[0] - pos[0]) / dtShip;
		const dy = (next[1] - pos[1]) / dtShip;
		const dz = (next[2] - pos[2]) / dtShip;
		const frameKms = Math.hypot(dx, dy, dz) * KPC_M / 1000;
		if (frameKms > maxFrameKms) maxFrameKms = frameKms;
		if (frameKms > 500) frameSpikes++;
		pos[0] = next[0]; pos[1] = next[1]; pos[2] = next[2];
		orbit.engineRecordVelocity(v, bx, by, bz, packed, t, model);
		const dot = (prevV[0] * v[0] + prevV[1] * v[1] + prevV[2] * v[2])
			/ (Math.hypot(prevV[0], prevV[1], prevV[2]) * Math.hypot(v[0], v[1], v[2]));
		const stepDeg = Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
		if (stepDeg > maxStepDeg) maxStepDeg = stepDeg;
		prevV[0] = v[0]; prevV[1] = v[1]; prevV[2] = v[2];
	}
	check('record velocity: at the real-time rung the twin is stable where the frame difference spikes',
		frameSpikes > 0 && maxFrameKms > 1000 && maxStepDeg < 1e-3,
		{ frameSpikes, maxFrameKms, maxStepDeg });

	// The simple mask draws the record where it was born (the documented CPU
	// gap), so its drawn velocity is exactly zero and the twin says approximated.
	orbit.setEngine(orbit.ENGINE_SIMPLE);
	const approx = orbit.engineRecordVelocity(v, bx, by, bz, packed, T, model);
	check('record velocity: the simple mask reports the gap and does not invent motion',
		approx === true && v[0] === 0 && v[1] === 0 && v[2] === 0, { approx, v: Array.from(v) });

	orbit.setEngine(savedEngine);
	orbit.setApocenterShare(savedShare);
	orbit.setApocenterForce(savedForce);
}

// --- 13. The tracked mirror and the theta ladder (trade-plan §9.5) ---------
//
// The friction field's azimuth for a *record* lives in the GPU compute buffer and
// the CPU never reads it back, so the trade network carries its own small mirror
// of the same integrator. These pins are the contract: the theta-taking dispatch
// is the plain dispatch when no theta is supplied, the mirror is the shipping law
// stepped in lockstep, a late-tracked record catches up inside a measured bound,
// and a horizon nobody can pay for is refused rather than coarsened.
{
	const records = require('../src/math/star-record.js');
	const M = galaxy.MILKY_WAY;
	const savedEngine = orbit.getEngine();
	const fr = Math.fround;
	const c = M.centre;
	// One disc record at the Sun's radius, epoch-flagged like a drawn field star.
	const bx = c.x + 8.0, by = c.y + 0.3, bz = c.z + 0.05;
	const jitter = orbit.encodeJitter(5, 8);
	const packed = (5 | (128 << 8) | (((orbit.FAMILY_DISC << 3) | records.FLAG_VISIBLE) << 24 >>> 8) | (jitter << 24)) >>> 0;
	const out = new Float64Array(3), ref = new Float64Array(3);

	// The plain ladder is unchanged by the theta-taking twin: same positions for
	// every mask, and the truthy "approximated" report under a simple bit.
	orbit.setApocenterShare(0.5);
	orbit.setApocenterForce(orbit.APOCENTER_ECC_MAX);
	let ladderWorst = 0, ladderReport = 0;
	for (let mask = 1; mask <= 7; mask++) {
		orbit.setEngine(mask);
		for (const t of [0, 40]) {
			const approximated = orbit.engineRecordPosition(out, bx, by, bz, packed, t, M);
			orbit.engineRecordPositionTheta(ref, bx, by, bz, packed, t, M, -1);
			ladderWorst = Math.max(ladderWorst, dist3(out, ref));
			if ((mask & orbit.ENGINE_SIMPLE) && approximated !== true) ladderReport += 1;
			if (!(mask & orbit.ENGINE_SIMPLE) && approximated !== false) ladderReport += 1;
		}
	}
	check('the theta ladder with no theta is the plain dispatch, for every mask and both reports',
		ladderWorst === 0 && ladderReport === 0, { ladderWorst, ladderReport });

	// A supplied theta *is* the reconstruction the vertex stage runs.
	orbit.setEngine('simple');
	const theta = 1.234;
	orbit.engineRecordPositionTheta(out, bx, by, bz, packed, 40, M, theta);
	orbit.simplePositionFromTheta(ref, theta, bx, by, bz, jitter, orbit.FAMILY_DISC, orbit.simpleEccMax(M), M);
	check('a supplied theta moves the simple lane to the vertex stage\'s own reconstruction',
		dist3(out, ref) < 1e-12 && orbit.engineRecordPositionTheta(out, bx, by, bz, packed, 40, M, theta) === false,
		{ dist: dist3(out, ref) });

	// Lockstep: the mirror is the shipping law on the frame's own dt.
	orbit.simpleTrackReset(M, 0);
	const slot = orbit.simpleTrackStar(4242, bx, by, bz, packed, M, 0);
	const P = orbit.simpleDerived(M, {});
	const eccU = orbit.simpleEccOf(jitter), peri = orbit.simplePeriOf(jitter);
	const r0 = Math.hypot(bx - c.x, by - c.y);
	let th = Math.atan2(by - c.y, bx - c.x), tNow = 0;
	const dtFrame = 1 / 60;
	for (let f = 0; f < 60 * 30; f++) {
		th = orbit.simpleStepTheta(th, r0, eccU, peri, orbit.FAMILY_DISC, P,
			orbit.simplePatternPhase(M, tNow), dtFrame, bz);
		tNow += dtFrame;
		orbit.simpleTrackStep(dtFrame, tNow);
	}
	const lockstep = Math.abs(orbit.simpleTrackTheta(slot) - orbit.wrapAngle(th));
	check('the tracked mirror steps with the frame exactly as the shipping law does (f64 lockstep)',
		slot === 0 && orbit.simpleTrackSlotOf(4242) === 0 && orbit.simpleTrackSlotOf(7) === -1
		&& orbit.simpleTrackCount() === 1 && lockstep < 1e-9,
		{ lockstep: +lockstep.toExponential(1), count: orbit.simpleTrackCount() });

	// Prediction: the same integrator run ahead, and a refusal past the bound.
	const predicted = orbit.simpleTrackThetaAt(slot, tNow + 2);
	let thRef = orbit.simpleTrackTheta(slot), tRef = tNow;
	for (let f = 0; f < 120; f++) {
		thRef = orbit.simpleStepTheta(thRef, r0, eccU, peri, orbit.FAMILY_DISC, P,
			orbit.simplePatternPhase(M, tRef), dtFrame, bz);
		tRef += dtFrame;
	}
	check('a tracked prediction is the integrator run ahead (sub-ly at 8 kpc over 2 Myr)',
		predicted >= 0 && Math.abs(predicted - orbit.wrapAngle(thRef)) < 5e-4,
		{ predicted: +predicted.toFixed(6), reference: +orbit.wrapAngle(thRef).toFixed(6) });
	const far = orbit.simpleTrackThetaAt(slot, tNow + 1e6);
	check('a horizon past the mirror\'s bound is refused, not coarsened', far === -1, { far });

	// A record tracked late catches up from the seed instant in bounded chunks.
	orbit.simpleTrackReset(M, 0);
	const first = orbit.simpleTrackStar(11, bx, by, bz, packed, M, 0);
	let t2 = 0;
	while (t2 < 60 - 1e-9) { orbit.simpleTrackStep(dtFrame, Math.min(60, t2 + dtFrame)); t2 += dtFrame; }
	const lateX = c.x - 5, lateY = c.y + 4, lateZ = c.z - 0.1;
	const latePacked = (7 | (100 << 8) | (((orbit.FAMILY_PATTERN << 3) | records.FLAG_VISIBLE | records.FLAG_EPOCH) << 16) | (0x2a << 24)) >>> 0;
	const late = orbit.simpleTrackStar(77, lateX, lateY, lateZ, latePacked, M, 60);
	const lateR0 = Math.hypot(lateX - c.x, lateY - c.y);
	let thLate = Math.atan2(lateY - c.y, lateX - c.x), t3 = 0;
	while (t3 < 60 - 1e-9) {
		const h = Math.min(dtFrame, 60 - t3);
		thLate = orbit.simpleStepTheta(thLate, lateR0, orbit.simpleEccOf(0x2a), orbit.simplePeriOf(0x2a),
			orbit.FAMILY_PATTERN, P, orbit.simplePatternPhase(M, t3), h, lateZ);
		t3 += h;
	}
	const catchUp = Math.abs(orbit.simpleTrackTheta(late) - orbit.wrapAngle(thLate));
	check('a late-tracked record catches up from the seed instant inside the measured bound',
		first === 0 && late === 1 && catchUp < 2e-3,
		{ dTheta: +catchUp.toExponential(2), ly: +(catchUp * lateR0 * 3261.563673).toFixed(1) });

	// Reset drops the azimuths; a rebind keeps them (an epoch change is not a
	// re-seed).
	const thetaBeforeRebind = orbit.simpleTrackTheta(late);
	orbit.simpleTrackRebind(M);
	const kept = orbit.simpleTrackTheta(late) === thetaBeforeRebind && orbit.simpleTrackCount() === 2;
	orbit.simpleTrackReset(M, 90);
	check('an epoch rebind keeps the azimuths and a reset drops them',
		kept && orbit.simpleTrackCount() === 0 && orbit.simpleTrackSlotOf(11) === -1
		&& orbit.simpleTrackTime() === 90, { kept, count: orbit.simpleTrackCount() });

	// --- R4 switch carry: one rule, three consumers (formation-plan §6) -----
	// engineMaskOf is the pure mask maths; setEngine's job is only to commit
	// it, so the two can never disagree about what an id means.
	{
		const ids = [['classic'], ['simple'], ['apocenter'], ['classic', 'apocenter'],
			['simple', 'apocenter'], 'classic', 'simple', 0, 1, 2, 5, 7, 9];
		let maskAgree = true;
		for (const id of ids) {
			orbit.setEngine(id);
			if (orbit.getEngine() !== orbit.engineMaskOf(id)) maskAgree = false;
		}
		orbit.setEngine('classic');
		check('engineMaskOf is the pure mask setEngine commits (arrays, names, numbers, the 0 clamp)',
			maskAgree && orbit.engineMaskOf(0) === orbit.ENGINE_CLASSIC
			&& orbit.engineMaskOf(['simple', 'apocenter']) === (orbit.ENGINE_SIMPLE | orbit.ENGINE_APOCENTER)
			&& orbit.engineMaskOf(9) === orbit.ENGINE_CLASSIC,
			{ zero: orbit.engineMaskOf(0), over: orbit.engineMaskOf(9) });

		// The masked dispatch is the current-mask ladder at theta = −1 — the
		// refactor split the function, not the behaviour.
		const mout = [0, 0, 0], tout = [0, 0, 0];
		let parWorst = 0;
		for (const mask of [orbit.ENGINE_CLASSIC, orbit.ENGINE_SIMPLE, orbit.ENGINE_APOCENTER,
			orbit.ENGINE_CLASSIC | orbit.ENGINE_APOCENTER, orbit.ENGINE_SIMPLE | orbit.ENGINE_APOCENTER]) {
			orbit.setEngine(mask);
			for (const t of [0, 37, 900]) {
				orbit.engineRecordPositionMasked(mout, bx, by, bz, packed, mask, t, M);
				orbit.engineRecordPositionTheta(tout, bx, by, bz, packed, t, M, -1);
				parWorst = Math.max(parWorst, dist3(mout, tout));
			}
			if (mask === orbit.ENGINE_CLASSIC) {
				orbit.engineRecordPosition(tout, bx, by, bz, packed, 37, M);
				orbit.engineRecordPositionMasked(mout, bx, by, bz, packed, mask, 37, M);
				parWorst = Math.max(parWorst, dist3(mout, tout));
			}
		}
		orbit.setEngine('classic');
		check('the masked dispatch is the ladder at theta = −1, for every mask and clock',
			parWorst === 0, { parWorst });

		// The carry rule itself. Horizontal families: it is the drawn xy
		// azimuth. Inclined families: the in-plane angle on the record's own
		// sweep basis — the xy azimuth is NOT that angle — and the classic
		// normal wobble must not leak into it.
		const angDiff = (a, b) => { const d = Math.abs(a - b) % orbit.TAU; return Math.min(d, orbit.TAU - d); };
		const qx = bx - c.x, qy = by - c.y, qz = bz - c.z;
		const phi = 0.77, cp = Math.cos(phi), sp = Math.sin(phi);
		const drawnH = [c.x + qx * cp - qy * sp, c.y + qx * sp + qy * cp, c.z + qz];
		const thH = orbit.simpleCarryTheta(qx, qy, qz, drawnH[0], drawnH[1], drawnH[2], packed, M);
		const pPacked = (7 | (100 << 8) | (((orbit.FAMILY_PRESSURE << 3) | records.FLAG_VISIBLE) << 16) | (0x9c << 24)) >>> 0;
		const pOrb = orbit.readOrbit(pPacked);
		const pl = orbit.orbitPlane(qx, qy, qz, pOrb.family, pOrb.phase, pOrb.amplitude, null);
		const delta = -2.1, cd = Math.cos(delta), sd = Math.sin(delta), wz = 0.35;
		const drawnP = [
			c.x + pl.anchor * (pl.e0x * cd + pl.e1x * sd) + wz * pl.nx,
			c.y + pl.anchor * (pl.e0y * cd + pl.e1y * sd) + wz * pl.ny,
			c.z + pl.anchor * (pl.e0z * cd + pl.e1z * sd) + wz * pl.nz,
		];
		const thP = orbit.simpleCarryTheta(qx, qy, qz, drawnP[0], drawnP[1], drawnP[2], pPacked, M);
		const thP0 = orbit.simpleCarryTheta(qx, qy, qz,
			drawnP[0] - wz * pl.nx, drawnP[1] - wz * pl.ny, drawnP[2] - wz * pl.nz, pPacked, M);
		const recon2 = [0, 0, 0];
		orbit.simplePositionFromTheta(recon2, thP, bx, by, bz, pOrb.jitter, pOrb.family, orbit.simpleEccMax(M), M);
		const vx = recon2[0] - c.x, vy = recon2[1] - c.y, vz = recon2[2] - c.z;
		const reconDelta = Math.atan2(vx * pl.e1x + vy * pl.e1y + vz * pl.e1z, vx * pl.e0x + vy * pl.e0y + vz * pl.e0z);
		const reconR = Math.hypot(vx * pl.e0x + vy * pl.e0y + vz * pl.e0z, vx * pl.e1x + vy * pl.e1y + vz * pl.e1z);
		check('simpleCarryTheta carries the drawn azimuth on horizontal planes and the drawn in-plane angle on tilted ones',
			angDiff(thH, orbit.wrapAngle(Math.atan2(qy, qx) + phi)) < 1e-12
			&& angDiff(thP, orbit.wrapAngle(Math.atan2(qy, qx) + delta)) < 1e-12
			&& thP === thP0
			&& angDiff(reconDelta, delta) < 1e-12 && Math.abs(reconR - pl.anchor) < 1e-12,
			{ horizontal: +angDiff(thH, orbit.wrapAngle(Math.atan2(qy, qx) + phi)).toExponential(1),
				tilted: +angDiff(thP, orbit.wrapAngle(Math.atan2(qy, qx) + delta)).toExponential(1),
				wobbleLeak: thP === thP0 ? 0 : 1 });

		// The landmark mirror carries the switch frame on UNCHANGED birth
		// anchors — re-initialising from the drawn positions instead would
		// move R0 and with it the integrator's own omega — and the frame is
		// the whole position: azimuth, radial scale and normal offset. So the
		// carried mirror lands on the drawn sky exactly, not merely on the
		// drawn azimuth.
		const lmB = Float64Array.of(c.x + 6, c.y + 1, c.z + 0.2, c.x - 4, c.y + 3, c.z - 0.1);
		const lmCc = Uint8Array.of(3, 9);
		orbit.simpleLandmarksInit(lmB, lmCc, 2, M, 0);
		const lmDrawn = Float64Array.of(c.x + 5, c.y + 3, c.z + 0.9, c.x - 4.5, c.y + 2, c.z + 0.4);
		const lmCarried = orbit.simpleLandmarksCarryFrom(lmDrawn, 2, M, 123);
		const lmPos = [0, 0, 0], lmRecon = [0, 0, 0], lmCarry = [0, 0];
		orbit.simpleLandmarkPosition(lmPos, 0);
		orbit.simpleLandmarkCarry(0, lmCarry);
		orbit.simplePositionFromTheta(lmRecon, orbit.simpleLandmarkTheta(0),
			lmB[0], lmB[1], lmB[2], 0, orbit.familyFromColorIndex(3), orbit.simpleEccMax(M), M, lmCarry);
		const lmLand = Math.max(dist3(lmPos, [lmDrawn[0], lmDrawn[1], lmDrawn[2]]),
			dist3(lmRecon, [lmDrawn[0], lmDrawn[1], lmDrawn[2]]));
		check('simpleLandmarksCarryFrom lands the mirror on the drawn sky, on birth anchors and its own clock',
			lmCarried === 2
			&& angDiff(orbit.simpleLandmarkTheta(0), orbit.wrapAngle(Math.atan2(3, 5))) < 1e-12
			&& angDiff(orbit.simpleLandmarkTheta(1), orbit.wrapAngle(Math.atan2(2, -4.5))) < 1e-12
			&& orbit.simpleLandmarkThetaAt(0, 123) === orbit.simpleLandmarkTheta(0)
			&& dist3(lmPos, lmRecon) < 1e-12
			&& lmLand < 1e-12
			&& orbit.simpleLandmarksCarryFrom(lmDrawn, 3, M, 0) === 0,
			{ carried: lmCarried, drift: +dist3(lmPos, lmRecon).toExponential(1),
				landingKpc: +lmLand.toExponential(1), carry: lmCarry.map((v) => +v.toFixed(3)) });

		// The track mirror seeds through the same rule as the renderer — raw
		// bytes into the masked dispatch, the member offset stripped, the
		// placed q into the carry — so the friction field lands where the sky
		// does. clusterCentreCoord is NOT idempotent (its lattice base comes
		// off the input's own bits), which is why the dispatch gets the raw
		// coordinates and never the pre-centred ones.
		orbit.simpleTrackReset(M, 40, orbit.ENGINE_CLASSIC);
		const tslot = orbit.simpleTrackStar(4242, bx, by, bz, packed, M, 40);
		const thPlain = orbit.simpleTrackTheta(tslot);
		orbit.engineRecordPositionMasked(mout, bx, by, bz, packed, orbit.ENGINE_CLASSIC, 40, M);
		const expTrack = orbit.simpleCarryTheta(qx, qy, qz, mout[0], mout[1], mout[2], packed, M);
		const clPacked = (7 | (100 << 8) | (((orbit.FAMILY_DISC << 3) | records.FLAG_VISIBLE | records.FLAG_CLUSTER) << 16) | (0x5b << 24)) >>> 0;
		const mx = c.x + 5.37, my = c.y - 2.11, mz = c.z + 0.43;
		const ccx = orbit.clusterCentreCoord(mx), ccy = orbit.clusterCentreCoord(my), ccz = orbit.clusterCentreCoord(mz);
		orbit.simpleTrackReset(M, 40, orbit.ENGINE_CLASSIC);
		const cslot = orbit.simpleTrackStar(31337, mx, my, mz, clPacked, M, 40);
		const thCluster = orbit.simpleTrackTheta(cslot);
		orbit.engineRecordPositionMasked(mout, mx, my, mz, clPacked, orbit.ENGINE_CLASSIC, 40, M);
		const expCl = orbit.simpleCarryTheta(ccx - c.x, ccy - c.y, ccz - c.z,
			mout[0] - (mx - ccx), mout[1] - (my - ccy), mout[2] - (mz - ccz), clPacked, M);
		check('a carry-seeded track starts on the renderer\'s own carried theta (cluster centres quantised once)',
			tslot === 0 && cslot === 0
			&& angDiff(thPlain, expTrack) < 1e-12
			&& angDiff(thCluster, expCl) < 1e-12,
			{ plain: +angDiff(thPlain, expTrack).toExponential(1),
				cluster: +angDiff(thCluster, expCl).toExponential(1) });

		// At T = 0 the carried seed IS the birth seed (boot parity), and a
		// mask that keeps the simple bit refuses the carry — the integrator's
		// own state is not a closed-form frame to carry from.
		orbit.simpleTrackReset(M, 0, orbit.ENGINE_CLASSIC);
		const zslot = orbit.simpleTrackStar(4242, bx, by, bz, packed, M, 0);
		const birthTh = orbit.wrapAngle(Math.atan2(by - c.y, bx - c.x));
		orbit.simpleTrackReset(M, 40, orbit.ENGINE_SIMPLE | orbit.ENGINE_CLASSIC);
		const rslot = orbit.simpleTrackStar(4242, bx, by, bz, packed, M, 40);
		check('the carry seed degenerates to the birth seed at T = 0 and is refused while the simple bit stays set',
			angDiff(orbit.simpleTrackTheta(zslot), birthTh) < 1e-12
			&& angDiff(orbit.simpleTrackTheta(rslot), birthTh) < 1e-12,
			{ zero: +angDiff(orbit.simpleTrackTheta(zslot), birthTh).toExponential(1),
				refused: +angDiff(orbit.simpleTrackTheta(rslot), birthTh).toExponential(1) });
		orbit.simpleTrackReset(M, 0);
		orbit.setEngine('classic');
	}

	// The landmark mirror predicts the same way, and refuses the same bound.
	const lmBirth = Float64Array.of(c.x + 8.178, 0, 0.1, c.x + 3.5, 2.2, -0.15);
	const lmColor = Uint8Array.of(5, 1);
	orbit.simpleLandmarksInit(lmBirth, lmColor, 2, M, 0);
	const lmR0 = Math.hypot(lmBirth[0] - c.x, lmBirth[1] - c.y);
	let tLm = 0;
	while (tLm < 20 - 1e-12) {
		const h = Math.min(dtFrame, 20 - tLm);
		orbit.simpleLandmarksStep(h, tLm + h);
		tLm += h;
	}
	const lmNow = orbit.simpleLandmarkTheta(0);
	const lmNext = orbit.simpleLandmarkThetaAt(0, 20.5);
	let thNext = lmNow, tNext = 20;
	while (tNext < 20.5 - 1e-12) {
		const h = Math.min(dtFrame, 20.5 - tNext);
		thNext = orbit.simpleStepTheta(thNext, lmR0, orbit.simpleEccOf(0), orbit.simplePeriOf(0),
			orbit.familyFromColorIndex(lmColor[0]), P, orbit.simplePatternPhase(M, tNext), h, lmBirth[2]);
		tNext += h;
	}
	check('the landmark mirror has a time, predicts from it, and refuses a horizon past its bound',
		Math.abs(orbit.simpleLandmarkTime() - 20) < 1e-9
		&& lmNext >= 0 && Math.abs(lmNext - orbit.wrapAngle(thNext)) < 1e-6
		&& orbit.simpleLandmarkThetaAt(0, 1e6) === -1,
		{ time: +orbit.simpleLandmarkTime().toFixed(4), d: +Math.abs(lmNext - orbit.wrapAngle(thNext)).toExponential(1) });
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
	logFile.writeLog(logPath, {
		date: new Date().toISOString(),
		totalChecks: checks.length,
		passed,
		failed,
		checks,
	});
	if (failed > 0) process.exit(1);
}
