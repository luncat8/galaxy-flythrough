// experiments/movement-density-test.js
// Time-averaged density preservation of the movement engines — the numerical
// measurement plan.md's follow-up order requires *before* any experimental-engine
// calibration or any change of the default engine, and that movement-parity-plan.md
// names as its follow-up.
//
// The workflow rule of AGENTS.md is "orbits and mechanics to keep distribution and
// density stable in time". A law can be exact at T = 0 and still be wrong: it can
// shear the arm pattern (kinematic winding), heat the vertical column, or migrate
// the radial profile. This measures those three things on the CPU mirrors the
// renderer ships (`orbit.js`), over a population drawn from the density field
// itself (`sampling.sampleGalaxyStars`), so the reference distribution is the model
// rather than another engine:
//
//   radial   log-R histogram of the disc (thin+thick) population
//   vertical log-|z| histogram of the thin disc — the pinned sech^2 column
//   arm      the m-th density harmonic of the pattern phase, in `arms.amp` units,
//            so it reads as "the arms hold at 0.19 of an authored 0.20"
//
// Three details make the numbers honest:
//   * the arm phase is the field's own variable
//     u = m·phi − K·ln(R/Rs) + phase0 − m·(Omega_p·t + phaseOffset), referenced to
//     the *rotating* crest. A fixed-annulus azimuth would cancel a perfect arm
//     (a log spiral's crest azimuth sweeps K·ln(R2/R1)/m across any annulus wide
//     enough to hold stars — the Milky Way's birth amplitude measures 0.04 in
//     azimuth and 0.21 in phase), and a static phase reference smears a rigidly
//     rotating pattern to nothing (measured: 1.01 at one instant, 0.05 averaged
//     over 400 Myr).
//   * every deviation is reported next to the sampling noise of the run that
//     produced it (the odd/even snapshot halves), so an effect is only claimed
//     when it is larger than its own counting noise.
//   * the arm population is fixed by birth radius and its phase is read at the
//     instantaneous position, so radial migration and pattern loss are two
//     numbers rather than one confounded one.
//
// Engines at the shipped view state (wave 0.6, pattern ×1, share 0.35, force 0.22):
//   1 classic — the default, gated
//   2 simple, 4 apocenter, 6 simple+apocenter — the experimental lanes, gated
//   5, 7 — on the first model, to pin that a mixed mask's density is bounded by
//         the pure populations it is built from
//   1 at wave 0 — the control: what the shipped capture lane buys, and the proof
//         the lane is load-bearing rather than decorative
//
// Output: experiments/logs/movement-density.json

'use strict';

const path = require('path');
const logFile = require('./log-file.js');

const galaxy = require('../src/math/galaxy.js');
const sampling = require('../src/math/sampling.js');
const starTypes = require('../src/math/star-types.js');
const density = require('../src/math/density.js');
const orbit = require('../src/math/orbit.js');

function arg(name, fallback) {
	const i = process.argv.indexOf('--' + name);
	if (i < 0) return fallback;
	const value = process.argv[i + 1];
	return value === undefined || value.startsWith('--') ? true : value;
}

const TYPE_LIST = String(arg('types', 'mw,Sa,SBc')).split(',').map((s) => s.trim()).filter(Boolean);
const N = Math.max(4000, Number(arg('stars', 40000)));
const SPAN = Number(arg('span', 400));       // Myr of star time covered
const SNAP = Number(arg('snap', 4));        // Myr between snapshots
const DT = Number(arg('dt', 2));            // simple-engine integration step
const SEED = Number(arg('seed', 42));
const WANT_SWEEPS = arg('sweeps', true) !== false;
const SNAPS = Math.round(SPAN / SNAP);

const TAU = orbit.TAU;
// Log bins for radius and height: the epicycle amplitude and the guided ellipse
// both scale with radius (ah/r = sqrt(2)·sigmaThin/vFlat is constant across the
// disc), so a linear histogram would count one 0.5 kpc wobble five times at
// 2 kpc what it is worth at 10 kpc. One bin is ~0.16 dex, well inside the ~10%
// radial excursion these laws have.
const RAD_BINS = 40;
const VERT_BINS = 28;
const ARM_BINS = 32;
// The shipped menu defaults of the two experimental lanes (main.js reads the
// same constants off OrbitLib).
const SHARE_UI = orbit.APOCENTER_SHARE_UI_DEFAULT;
const FORCE_UI = orbit.APOCENTER_FORCE_UI_DEFAULT;
const WAVE_UI = orbit.WAVE_DAMPING_UI_DEFAULT;

// ---- histograms -----------------------------------------------------------

function logEdges(lo, hi, bins) {
	const edges = new Float64Array(bins + 1);
	const k = Math.log(hi / lo) / bins;
	for (let b = 0; b <= bins; b++) edges[b] = lo * Math.exp(k * b);
	return edges;
}

function logIndex(edges, bins, value) {
	if (!(value > edges[0])) return 0;
	if (value >= edges[bins]) return bins - 1;
	let lo = 0, hi = bins;
	while (lo + 1 < hi) {
		const mid = (lo + hi) >> 1;
		if (value < edges[mid]) hi = mid; else lo = mid;
	}
	return lo;
}

function normalized(hist) {
	const out = new Float64Array(hist.length);
	let total = 0;
	for (const v of hist) total += v;
	if (!(total > 0)) return out;
	for (let i = 0; i < out.length; i++) out[i] = hist[i] / total;
	return out;
}

function tv(a, b) {
	let sum = 0;
	for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
	return sum / 2;
}

// Worst single-bin deviation: the form plan 0.4.0 §1.4 states its
// distribution-preservation budget in ("3% per bin").
function maxBin(a, b) {
	let worst = 0;
	for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
	return worst;
}

// First harmonic of a cyclic histogram, as a density contrast: a distribution
// p(u) ∝ 1 + A·cos(u) returns exactly A.
function harmonic(hist) {
	let re = 0, im = 0, total = 0;
	for (let b = 0; b < hist.length; b++) {
		const w = TAU * b / hist.length;
		re += hist[b] * Math.cos(w);
		im -= hist[b] * Math.sin(w);
		total += hist[b];
	}
	return total > 0 ? 2 * Math.hypot(re, im) / total : 0;
}

// ---- the population -------------------------------------------------------

function prepare(typeName) {
	const model = typeName === 'mw' ? galaxy.MILKY_WAY : galaxy.createGalaxy({ type: typeName, seed: SEED });
	const buf = sampling.sampleGalaxyStars(model, SEED, N, null);
	const n = buf.count;
	const p = {
		type: typeName, model, n,
		x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n),
		R0: new Float64Array(n), absZ0: new Float64Array(n),
		fam: new Uint8Array(n), jitter: new Uint8Array(n),
		disc: new Uint8Array(n), thin: new Uint8Array(n), armPop: new Uint8Array(n),
	};
	const derived = {};
	const centre = model.centre;
	for (let i = 0; i < n; i++) {
		// The renderer's own procedural block: same seed, same family rule, same
		// jitter byte (star-sprites.js writeProceduralRecords).
		starTypes.deriveStar(model, starTypes.fieldStarSeed(SEED, i),
			buf.component[i], buf.R[i], buf.distToArm[i], derived);
		p.x[i] = buf.x[i];
		p.y[i] = buf.y[i];
		p.z[i] = buf.z[i];
		p.R0[i] = buf.R[i];
		p.absZ0[i] = Math.abs(buf.z[i] - centre.z);
		p.fam[i] = orbit.familyForStar(buf.component[i], derived.spectralClass, model.barred);
		p.jitter[i] = (Math.imul(i, 2654435761)) & 0xFF;
		p.disc[i] = buf.component[i] <= 1 ? 1 : 0;
		p.thin[i] = buf.component[i] === 0 ? 1 : 0;
	}

	const trunc = model.truncation;
	p.radEdges = logEdges(0.05, trunc.discRadius, RAD_BINS);
	const vertCut = density.discVerticalCut(model, model.thin, trunc.discRadius, 'sech2');
	p.vertCut = vertCut;
	p.vertEdges = logEdges(1e-3, vertCut, VERT_BINS);

	// Arms: the annulus the pattern is measured in, and the phase variable the
	// field is written in. An unarmed model (S0, E, Irr) has no arm metric.
	const arms = model.arms;
	p.armed = density.armsArmed(model);
	if (p.armed) {
		p.armLo = Math.max(arms.minRadius, 0.6 * arms.Rs);
		p.armHi = Math.min(2.4 * arms.Rs, 0.92 * trunc.discRadius);
		p.armM = arms.m;
		p.armK = density.armWavenumber(model);
		p.armRs = arms.Rs;
		p.armPhase0 = arms.phase0;
		p.armAmp = arms.amp;
		p.armFloc = arms.flocculence || 0;
		// The pattern's own rotation, so the phase variable can be evaluated in
		// the pattern frame at every instant.
		p.omegaP = orbit.fillDynamics({}, model).omegaPattern;
		for (let i = 0; i < n; i++) p.armPop[i] = (p.disc[i] && p.R0[i] >= p.armLo && p.R0[i] <= p.armHi) ? 1 : 0;
	}
	return p;
}

function newAcc(prep) {
	const n = prep.n;
	return {
		radial: new Float64Array(RAD_BINS), radialOdd: new Float64Array(RAD_BINS), radialEven: new Float64Array(RAD_BINS),
		vert: new Float64Array(VERT_BINS), vertOdd: new Float64Array(VERT_BINS), vertEven: new Float64Array(VERT_BINS),
		arm: new Float64Array(ARM_BINS), armOdd: new Float64Array(ARM_BINS), armEven: new Float64Array(ARM_BINS),
		armFinal: new Float64Array(ARM_BINS),
		minR: new Float64Array(n).fill(Infinity), maxR: new Float64Array(n).fill(-Infinity),
		sumR: 0, sumR0: 0, sumZ: 0, sumZ0: 0,
		discCount: 0, thinCount: 0, armCount: 0, overCut: 0, overCutBirth: 0,
	};
}

// One frame of the field: bin every star's instantaneous position.
function accumulate(prep, pos, acc, odd, time) {
	const model = prep.model;
	const c = model.centre;
	const n = prep.n;
	// The pattern's rotation over this frame, so the arm phase is read in the
	// pattern frame (the crest the eye follows), not in the birth frame. Since
	// 0.6 E4 the pattern's phase is the accumulator, not rate×clock: the test
	// drives the same clock the shell does, so `meanPatternSpeed` times the star
	// time is the accumulated rotation.
	orbit.setPatternClock(time, model);
	const armTurn = prep.armed ? prep.armM * (orbit.meanPatternSpeed(model) * time) : 0;
	for (let i = 0; i < n; i++) {
		const dx = pos.x[i] - c.x, dy = pos.y[i] - c.y, dz = pos.z[i] - c.z;
		const R = Math.sqrt(dx * dx + dy * dy);
		if (prep.disc[i]) {
			const b = logIndex(prep.radEdges, RAD_BINS, R);
			acc.radial[b]++;
			if (odd) acc.radialOdd[b]++; else acc.radialEven[b]++;
			if (R < acc.minR[i]) acc.minR[i] = R;
			if (R > acc.maxR[i]) acc.maxR[i] = R;
			acc.sumR += R;
			acc.sumR0 += prep.R0[i];
			acc.discCount++;
		}
		if (prep.thin[i]) {
			const az = Math.abs(dz);
			const b = logIndex(prep.vertEdges, VERT_BINS, az);
			acc.vert[b]++;
			if (odd) acc.vertOdd[b]++; else acc.vertEven[b]++;
			acc.sumZ += az;
			acc.sumZ0 += prep.absZ0[i];
			acc.thinCount++;
			if (az > prep.vertCut) acc.overCut++;
		}
		if (prep.armed && prep.armPop[i]) {
			// Population fixed by birth radius; phase read at the star's current
			// position, so migration out of the ridge reads as pattern loss
			// rather than as an annulus edge effect.
			const u = prep.armM * Math.atan2(dy, dx) - prep.armK * Math.log(R / prep.armRs) + prep.armPhase0 - armTurn;
			const w = ((u % TAU) + TAU) % TAU;
			const b = Math.min(ARM_BINS - 1, (w / TAU * ARM_BINS) | 0);
			acc.arm[b]++;
			if (odd) acc.armOdd[b]++; else acc.armEven[b]++;
			if (acc.armFinal) acc.armFinal[b]++;
			acc.armCount++;
		}
	}
}

function birthAcc(prep) {
	const acc = newAcc(prep);
	const pos = { x: prep.x, y: prep.y, z: prep.z };
	accumulate(prep, pos, acc, true, 0);
	// The truncation count the birth field itself carries, for the "no star
	// leaves the model" check.
	for (let i = 0; i < prep.n; i++) if (prep.thin[i] && prep.absZ0[i] > prep.vertCut) acc.overCutBirth++;
	return acc;
}

// ---- one engine over the whole span ---------------------------------------

function runMask(prep, mask, options) {
	const opts = options || {};
	const dt = opts.dt || DT;
	const model = prep.model;
	const n = prep.n;
	const c = model.centre;
	const acc = newAcc(prep);
	const out = new Float64Array(3);
	const pos = { x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n) };

	const hasSimple = (mask & orbit.ENGINE_SIMPLE) !== 0;
	const hasClassic = (mask & orbit.ENGINE_CLASSIC) !== 0;
	const hasApo = (mask & orbit.ENGINE_APOCENTER) !== 0;

	const theta = new Float64Array(n);
	const r0 = new Float64Array(n), eccU = new Float64Array(n), peri = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		r0[i] = prep.R0[i];
		eccU[i] = orbit.simpleEccOf(prep.jitter[i]);
		peri[i] = orbit.simplePeriOf(prep.jitter[i]);
	}
	const P = hasSimple ? orbit.simpleDerived(model, {}) : null;
	const eccMax = hasSimple ? orbit.simpleEccMax(model) : 0;
	const stepsPerSnap = Math.max(1, Math.round(SNAP / dt));
	const h = SNAP / stepsPerSnap;
	if (hasSimple) for (let i = 0; i < n; i++) theta[i] = Math.atan2(prep.y[i] - c.y, prep.x[i] - c.x);

	const started = process.hrtime.bigint();
	for (let s = 1; s <= SNAPS; s++) {
		const t = s * SNAP;
		if (hasSimple) {
			// The GPU steps one azimuth per record per frame with the pattern
			// phase packed from that frame's star time; this is the same march
			// at a coarser frame, with the same substepping inside each step.
			for (let k = 0; k < stepsPerSnap; k++) {
				const phase = orbit.simplePatternPhase(model, (s - 1) * SNAP + k * h);
				for (let i = 0; i < n; i++) {
					theta[i] = orbit.simpleStepTheta(theta[i], r0[i], eccU[i], peri[i],
						prep.fam[i], P, phase, h, prep.z[i] - c.z);
				}
			}
		}
		for (let i = 0; i < n; i++) {
			if (hasSimple) {
				orbit.simplePositionFromTheta(out, theta[i], prep.x[i], prep.y[i], prep.z[i],
					prep.jitter[i], prep.fam[i], eccMax, model);
			} else if (hasClassic) {
				orbit.orbitPosition(out, prep.x[i], prep.y[i], prep.z[i], prep.fam[i],
					prep.jitter[i] & 15, prep.jitter[i] >>> 4, t, model);
			} else {
				out[0] = prep.x[i]; out[1] = prep.y[i]; out[2] = prep.z[i];
			}
			if (hasApo && orbit.apocenterSelected(prep.x[i], prep.y[i], prep.z[i])) {
				orbit.apocenterPosition(out, prep.x[i], prep.y[i], prep.z[i], prep.fam[i],
					prep.jitter[i] & 15, prep.jitter[i] >>> 4, t, model);
			}
			pos.x[i] = out[0]; pos.y[i] = out[1]; pos.z[i] = out[2];
		}
		if (s === SNAPS) acc.armFinal = new Float64Array(ARM_BINS);
		accumulate(prep, pos, acc, (s & 1) === 1, t);
	}
	const ms = Number(process.hrtime.bigint() - started) / 1e6;
	return { acc, ms };
}

// ---- metrics --------------------------------------------------------------

function metrics(prep, run) {
	const acc = run.acc;
	const birth = prep.birth;
	const radial = normalized(acc.radial);
	const radialOdd = normalized(acc.radialOdd);
	const radialEven = normalized(acc.radialEven);
	const vert = normalized(acc.vert);
	const vertOdd = normalized(acc.vertOdd);
	const vertEven = normalized(acc.vertEven);
	const arm = normalized(acc.arm);
	const armOdd = normalized(acc.armOdd);
	const armEven = normalized(acc.armEven);

	let excursion = 0;
	let disc = 0;
	for (let i = 0; i < prep.n; i++) {
		if (!prep.disc[i] || !(prep.R0[i] > 0)) continue;
		excursion += (acc.maxR[i] - acc.minR[i]) / prep.R0[i];
		disc++;
	}
	let m = {
		radialTV: tv(birth.radial, radial),
		radialNoise: tv(radialOdd, radialEven),
		vertTV: tv(birth.vert, vert),
		vertNoise: tv(vertOdd, vertEven),
		armBirth: birth.arm,
		armA: harmonic(arm),
		armNoise: Math.abs(harmonic(armOdd) - harmonic(armEven)),
		armFinal: acc.armFinal ? harmonic(acc.armFinal) : 0,
		meanR: acc.sumR / Math.max(1, acc.discCount) / (birth.meanR || 1),
		meanZ: acc.sumZ / Math.max(1, acc.thinCount) / (birth.meanZ || 1),
		excursion: disc > 0 ? excursion / disc : 0,
		overCutShare: acc.overCut / Math.max(1, acc.thinCount),
		overCutBirthShare: birth.overCutShare,
		armCount: acc.armCount,
		discCount: acc.discCount,
		thinCount: acc.thinCount,
		ms: Math.round(run.ms),
	};
	m.radialMaxBin = maxBin(birth.radial, radial);
	m.vertMaxBin = maxBin(birth.vert, vert);
	m.radialExcess = Math.max(0, m.radialTV - m.radialNoise);
	m.vertExcess = Math.max(0, m.vertTV - m.vertNoise);
	m.armRatio = m.armBirth > 0 ? m.armA / m.armBirth : 0;
	m.armRatioFinal = m.armBirth > 0 && acc.armFinal ? m.armFinal / m.armBirth : 0;
	return m;
}

function birthStats(prep, acc) {
	const radial = normalized(acc.radial);
	const vert = normalized(acc.vert);
	const arm = normalized(acc.arm);
	let sumR = 0, sumZ = 0, count = 0;
	for (let i = 0; i < prep.n; i++) {
		if (prep.disc[i]) { sumR += prep.R0[i]; count++; }
		if (prep.thin[i]) sumZ += prep.absZ0[i];
	}
	const thinCount = prep.thin.reduce((a, b) => a + b, 0);
	return {
		radial, vert, arm: harmonic(arm),
		meanR: count > 0 ? sumR / count : 1,
		meanZ: thinCount > 0 ? sumZ / thinCount : 1,
		overCutShare: acc.overCutBirth / Math.max(1, thinCount),
	};
}

// ---- tables ---------------------------------------------------------------

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
	return !!pass;
}

const rows = [];
function row(cells) { rows.push(cells); }

const ENGINES = { 1: 'classic', 2: 'simple', 4: 'apocenter', 5: 'classic+apocenter', 6: 'simple+apocenter', 7: 'simple+apocenter+classic' };

function engrave(prep, mask, label, m) {
	row([
		prep.type, String(mask), label || ENGINES[mask] || String(mask),
		m.radialTV.toFixed(3), m.radialNoise.toFixed(3), m.radialExcess.toFixed(3), m.radialMaxBin.toFixed(3),
		m.vertTV.toFixed(3), m.vertNoise.toFixed(3), m.vertExcess.toFixed(3), m.vertMaxBin.toFixed(3),
		m.armA.toFixed(3), m.armRatio.toFixed(2), m.armRatioFinal.toFixed(2),
		m.meanR.toFixed(3), m.meanZ.toFixed(3), m.excursion.toFixed(3),
		m.overCutShare.toFixed(4), String(m.ms),
	]);
	return m;
}

// Gates. Three kinds, and the difference matters:
//
//   * PLAN BUDGET — plan 0.4.0 §1.4 states the distribution-preservation
//     contract as "3% per bin" for a time-averaged histogram against the
//     analytic profile. Both the radial and the vertical columns are gated on
//     it now: 0.4.9 re-anchored the sweep basis (orbitPlane) so a disc star's
//     birth height is carried instead of rotated into an oscillation about the
//     plane. Before that pass the vertical column read 0.038-0.049 of worst bin
//     with mean|z| at 0.66-0.87 of the field's — a contraction the centred
//     plane's (qz/|q|)·cos(theta) term cannot avoid — and it was pinned here as
//     a known deviation rather than gated. The numbers that replaced them are in
//     the log and in the 0.4.x worklog entry.
//   * MOTION PROPERTY — the guided ellipse is arm-negative by construction and
//     the apocenter-only mask freezes its unselected fraction (movement-parity
//     decision 1), so its arm number is gated on a floor, not on preservation.
//     The floors are calibrated on the default 400 Myr span: the capture lane
//     needs a couple of corotation-crossing times before the pattern is held, so
//     a short run reads lower (SBc at 120 Myr is mid-capture at 0.74).
const RADIAL_BUDGET = 0.03;
const VERT_BUDGET = 0.03;
// mean|z| is the second read on the same contract: the column's scale, not its
// shape. The classic law still carries the epicycle's bounded vertical wobble
// (VERTICAL_WOBBLE_RATIO · ah, capped at half of discHeight − |z| because the
// sine-difference can move 2·av from birth), which lifts the column by up to
// ~8% on the tallest disc measured (SBc); the simple and apocenter lanes carry
// the height through the sweep basis exactly.
const VERT_MEAN_LOW = 0.95;
const VERT_MEAN_HIGH = 1.10;
const VERT_MEAN_EXACT_HIGH = 1.01;
const MEANR_LOW = 0.97;
const MEANR_HIGH = 1.03;
const ARM_FLOOR = 0.7;
const ARM_FLOOR_GUIDED = 0.15;

function gateEngine(prep, mask, label, m) {
	const type = prep.type;
	const guidedOnly = mask === 4;
	// Radial profile: plan §1.4's per-bin budget, on every lane.
	check(`${type} mask ${mask} (${label}): radial profile holds the field within plan 1.4's per-bin budget`,
		m.radialMaxBin <= RADIAL_BUDGET, { maxBin: +m.radialMaxBin.toFixed(4), budget: RADIAL_BUDGET });
	// Vertical column: the same budget, which the 0.4.9 re-anchor made hold.
	check(`${type} mask ${mask} (${label}): vertical column holds the field within plan 1.4's per-bin budget`,
		m.vertMaxBin <= VERT_BUDGET, { maxBin: +m.vertMaxBin.toFixed(4), budget: VERT_BUDGET });
	const meanHigh = (mask & orbit.ENGINE_CLASSIC) === 0 ? VERT_MEAN_EXACT_HIGH : VERT_MEAN_HIGH;
	check(`${type} mask ${mask} (${label}): the column is neither compressed nor blown up`,
		m.meanZ >= VERT_MEAN_LOW && m.meanZ <= meanHigh,
		{ meanZ: +m.meanZ.toFixed(4), band: [VERT_MEAN_LOW, meanHigh], exact: meanHigh === VERT_MEAN_EXACT_HIGH });
	check(`${type} mask ${mask} (${label}): no radial drift of the disc population`,
		m.meanR >= MEANR_LOW && m.meanR <= MEANR_HIGH, { meanR: +m.meanR.toFixed(4), band: [MEANR_LOW, MEANR_HIGH] });
	// Arm pattern: a shipping lane must hold the authored pattern (the capture
	// lane overshoots it, which is a calibration question, not a violation);
	// the guided-only mask gets the floor above.
	if (prep.armed && m.armCount > 0) {
		const floor = guidedOnly ? ARM_FLOOR_GUIDED : ARM_FLOOR;
		check(`${type} mask ${mask} (${label}): arm pattern ${guidedOnly ? 'floor' : 'held'} (birth contrast ${m.armBirth.toFixed(3)})`,
			m.armRatio >= floor, { armA: +m.armA.toFixed(4), ratio: +m.armRatio.toFixed(3), finalRatio: +m.armRatioFinal.toFixed(3), floor });
	}
	// The truncation lives in the model: no lane may push stars past it.
	check(`${type} mask ${mask} (${label}): no star leaves the model's truncation`,
		m.overCutShare <= Math.max(m.overCutBirthShare * 1.05, m.overCutBirthShare + 0.002),
		{ overCut: +m.overCutShare.toFixed(5), birth: +m.overCutBirthShare.toFixed(5) });
}

// ---- the run --------------------------------------------------------------

// The view state this experiment measures at: the shipped menu defaults. The
// globals are restored at the end so the module is left as it was found.
const savedWave = orbit.getWaveDamping();
const savedScale = orbit.getPatternScale();
const savedEngine = orbit.getEngine();
const savedShare = orbit.getApocenterShare();
const savedForce = orbit.getApocenterForce();

orbit.resetPatternPhase();
orbit.setPatternScale(1);
orbit.setWaveDamping(WAVE_UI);
orbit.setApocenterShare(SHARE_UI);
orbit.setApocenterForce(FORCE_UI);

const results = { engines: [], sweeps: {}, convergence: null, control: null };
const prepFirst = prepare(TYPE_LIST[0]);

for (const typeName of TYPE_LIST) {
	const prep = typeName === TYPE_LIST[0] ? prepFirst : prepare(typeName);
	const birthRun = birthAcc(prep);
	prep.birth = birthStats(prep, birthRun);
	console.log(`${typeName}: ${prep.n} stars, disc ${prep.disc.reduce((a, b) => a + b, 0)}, thin ${prep.thin.reduce((a, b) => a + b, 0)}, ` +
		`arm annulus [${prep.armed ? prep.armLo.toFixed(2) + '..' + prep.armHi.toFixed(2) : '-'}] ` +
		`birth arm ${prep.birth.arm.toFixed(3)} (authored amp ${prep.armed ? prep.armAmp.toFixed(2) : '-'}, floc ${prep.armed ? prep.armFloc : '-'}), ` +
		`birth over-cut ${prep.birth.overCutShare.toFixed(4)}`);

	const masks = typeName === TYPE_LIST[0] ? [1, 2, 3, 4, 5, 6, 7] : [1, 2, 4, 6];
	for (const mask of masks) {
		orbit.setEngine(mask);
		const run = runMask(prep, mask);
		const m = metrics(prep, run);
		engrave(prep, mask, null, m);
		gateEngine(prep, mask, ENGINES[mask], m);
		results.engines.push({ type: typeName, mask, metrics: m });
	}

	// The control: pure classic shear at wave 0. The capture lane is the only
	// thing holding the arm pattern in the default lane, so this run must be
	// markedly worse than the shipped one — otherwise the lane is decorative and
	// the gate above is measuring nothing.
	if (typeName === TYPE_LIST[0]) {
		orbit.setWaveDamping(0);
		orbit.setEngine(1);
		const run = runMask(prep, 1);
		const m = metrics(prep, run);
		orbit.setWaveDamping(WAVE_UI);
		engrave(prep, 1, 'classic wave0 (control)', m);
		results.control = { type: typeName, wave: 0, metrics: m };
		const shipped = results.engines.find((e) => e.type === typeName && e.mask === 1);
		if (prep.armed && m.armCount > 0 && shipped) {
			check(`${typeName}: the shipped capture lane is load-bearing — classic at wave 0 loses the arms it holds at wave ${WAVE_UI}`,
				m.armRatio < 0.5 * shipped.metrics.armRatio,
				{ armRatioNoDamping: +m.armRatio.toFixed(3), armRatioShipped: +shipped.metrics.armRatio.toFixed(3) });
		}
	}

	// Step-size convergence of the simple lane's integrator: the reported number
	// must be a property of the law, not of the march step.
	if (typeName === TYPE_LIST[0]) {
		orbit.setWaveDamping(WAVE_UI);
		orbit.setEngine(2);
		const coarse = metrics(prep, runMask(prep, 2, { dt: DT * 2 }));
		const fine = metrics(prep, runMask(prep, 2, { dt: Math.max(0.25, DT / 2) }));
		const conv = {
			dtCoarse: DT * 2, dtFine: Math.max(0.25, DT / 2),
			radialExcessCoarse: +coarse.radialExcess.toFixed(4), radialExcessFine: +fine.radialExcess.toFixed(4),
			armRatioCoarse: +coarse.armRatio.toFixed(3), armRatioFine: +fine.armRatio.toFixed(3),
			vertExcessCoarse: +coarse.vertExcess.toFixed(4), vertExcessFine: +fine.vertExcess.toFixed(4),
		};
		results.convergence = conv;
		check(`${typeName}: the simple lane's measurement is step-size converged (a 4x step span moves it less than 3%)`,
			Math.abs(coarse.radialExcess - fine.radialExcess) <= 0.02 + Math.max(coarse.radialNoise, fine.radialNoise)
			&& Math.abs(coarse.armRatio - fine.armRatio) <= 0.03 * fine.armRatio
			&& Math.abs(coarse.vertExcess - fine.vertExcess) <= 0.03 * fine.vertExcess,
			conv);
	}
}

// Mask identities the parity contract states, pinned on the measured field:
// the classic bit is masked while the simple bit is set, so 3 must be 2 and 7
// must be 6 to the last digit — every number in the table is a population
// statistic, so identical populations give identical statistics.
{
	const first = TYPE_LIST[0];
	const e = (mask) => results.engines.find((r) => r.type === first && r.mask === mask);
	const same = (a, b) => ['radialTV', 'vertTV', 'armA', 'meanR', 'meanZ', 'excursion', 'overCutShare']
		.every((k) => Math.abs(a[k] - b[k]) <= Math.abs(a[k]) * 1e-12 + 1e-12);
	const m2 = e(2), m3 = e(3), m6 = e(6), m7 = e(7);
	if (m2 && m3) {
		check(`${first}: mask 3 is mask 2 — the classic bit is masked while the simple bit is set`,
			same(m2.metrics, m3.metrics), { radialTV: [m2.metrics.radialTV, m3.metrics.radialTV], armA: [m2.metrics.armA, m3.metrics.armA] });
	}
	if (m6 && m7) {
		check(`${first}: mask 7 is mask 6 — the classic bit is masked while the simple bit is set`,
			same(m6.metrics, m7.metrics), { radialTV: [m6.metrics.radialTV, m7.metrics.radialTV], armA: [m6.metrics.armA, m7.metrics.armA] });
	}
	// A mixed mask's density is bounded by the pure populations it mixes: 35%
	// of the stars run the guided ellipse and the rest keep the classic
	// baseline, so every metric must sit between the two pure runs rather than
	// inventing a third behaviour.
	const pureClassic = e(1), pureApo = e(4), mixed5 = e(5);
	if (pureClassic && pureApo && mixed5 && prepFirst.birth) {
		const between = (lo, v, hi) => v >= Math.min(lo, hi) - 1e-9 && v <= Math.max(lo, hi) + 1e-9;
		check(`${first}: mask 5's density is bounded by its classic and apocenter parts`,
			between(pureClassic.metrics.excursion, mixed5.metrics.excursion, pureApo.metrics.excursion)
			&& between(pureClassic.metrics.meanR, mixed5.metrics.meanR, pureApo.metrics.meanR)
			&& between(pureClassic.metrics.armRatio, mixed5.metrics.armRatio, pureApo.metrics.armRatio),
			{
				excursion: [pureClassic.metrics.excursion.toFixed(3), mixed5.metrics.excursion.toFixed(3), pureApo.metrics.excursion.toFixed(3)],
				meanR: [pureClassic.metrics.meanR.toFixed(4), mixed5.metrics.meanR.toFixed(4), pureApo.metrics.meanR.toFixed(4)],
				armRatio: [pureClassic.metrics.armRatio.toFixed(3), mixed5.metrics.armRatio.toFixed(3), pureApo.metrics.armRatio.toFixed(3)],
			});
	}
}

// ---- calibration sweeps (evidence for a future default change) -------------

if (WANT_SWEEPS) {
	const prep = prepFirst;
	// The guided ellipse's own knob: how much guided eccentricity the radial
	// profile and the arms tolerate before the density stops being the model.
	{
		const values = [0.1, 0.22, 0.35, 0.45];
		const out = [];
		for (const force of values) {
			orbit.setApocenterShare(SHARE_UI);
			orbit.setApocenterForce(force);
			orbit.setEngine(4);
			const m = metrics(prep, runMask(prep, 4));
			out.push({ force, radialMaxBin: +m.radialMaxBin.toFixed(4), vertMaxBin: +m.vertMaxBin.toFixed(4), armRatio: +m.armRatio.toFixed(3), excursion: +m.excursion.toFixed(3), meanR: +m.meanR.toFixed(4), meanZ: +m.meanZ.toFixed(4) });
			engrave(prep, 4, `apocenter force ${force.toFixed(2)}`, m);
		}
		results.sweeps.apocenterForce = out;
		check(`${prep.type}: the guided ellipse keeps the radial profile inside plan 1.4's per-bin budget at every force the menu offers`,
			out.every((r) => r.radialMaxBin <= RADIAL_BUDGET),
			out.map((r) => ({ force: r.force, radialMaxBin: r.radialMaxBin })));
	}
	// The share knob mixes guided and baseline stars rather than distorting one.
	{
		const values = [0.25, 0.35, 0.6, 1.0];
		const out = [];
		for (const share of values) {
			orbit.setApocenterShare(share);
			orbit.setApocenterForce(FORCE_UI);
			orbit.setEngine(4);
			const m = metrics(prep, runMask(prep, 4));
			out.push({ share, radialMaxBin: +m.radialMaxBin.toFixed(4), vertMaxBin: +m.vertMaxBin.toFixed(4), armRatio: +m.armRatio.toFixed(3), excursion: +m.excursion.toFixed(3), meanR: +m.meanR.toFixed(4), meanZ: +m.meanZ.toFixed(4) });
			engrave(prep, 4, `apocenter share ${share.toFixed(2)}`, m);
		}
		results.sweeps.apocenterShare = out;
		check(`${prep.type}: guiding every star (share 1) still keeps the radial profile inside plan 1.4's budget and the arms above the guided floor`,
			out.every((r) => r.radialMaxBin <= RADIAL_BUDGET && r.armRatio >= ARM_FLOOR_GUIDED),
			out.map((r) => ({ share: r.share, radialMaxBin: r.radialMaxBin, armRatio: r.armRatio })));
	}
	// The capture lane's own knob, on the default engine: what wave damping buys
	// the arm pattern, which is the whole reason the lane exists.
	{
		const values = [0, 0.3, 0.6, 1];
		const out = [];
		for (const wave of values) {
			orbit.setWaveDamping(wave);
			orbit.setEngine(1);
			const m = metrics(prep, runMask(prep, 1));
			out.push({ wave, radialMaxBin: +m.radialMaxBin.toFixed(4), vertMaxBin: +m.vertMaxBin.toFixed(4), armRatio: +m.armRatio.toFixed(3), excursion: +m.excursion.toFixed(3), meanZ: +m.meanZ.toFixed(4) });
			engrave(prep, 1, `classic wave ${wave.toFixed(1)}`, m);
		}
		results.sweeps.waveDamping = out;
		check(`${prep.type}: the arm contrast the default lane holds rises with the capture slider (the lane is doing what it claims)`,
			out.every((r, i) => i === 0 || r.armRatio >= out[i - 1].armRatio - 0.02) && out[out.length - 1].armRatio > out[0].armRatio + 0.2,
			out.map((r) => ({ wave: r.wave, armRatio: r.armRatio })));
	}
	orbit.setApocenterShare(SHARE_UI);
	orbit.setApocenterForce(FORCE_UI);
	orbit.setWaveDamping(WAVE_UI);
}

// ---- report ---------------------------------------------------------------

orbit.setEngine(savedEngine);
orbit.setWaveDamping(savedWave);
orbit.setPatternScale(savedScale);
orbit.setApocenterShare(savedShare);
orbit.setApocenterForce(savedForce);

const header = ['type', 'mask', 'engine', 'radTV', 'radN', 'radExc', 'radMax', 'vertTV', 'vertN', 'vertExc', 'vertMax',
	'armA', 'armR', 'armRfinal', 'meanR', 'meanZ', 'excursion', 'overCut', 'ms'];
console.log('\n' + header.join('\t'));
for (const r of rows) console.log(r.join('\t'));

for (const c of checks) {
	if (!c.pass) console.log(`  FAIL ${c.name} -> ${JSON.stringify(c.detail)}`);
}
const passed = checks.filter((c) => c.pass).length;
console.log(`\n${passed}/${checks.length} passed, ${checks.length - passed} failed`);

// The measurement in words, so the numbers above are read as a result rather
// than as a table.
{
	const first = TYPE_LIST[0];
	const e = (mask) => results.engines.find((r) => r.type === first && r.mask === mask);
	const classic = e(1), apo = e(4);
	if (classic && apo) {
		const rad = results.engines.reduce((a, r) => Math.max(a, r.metrics.radialMaxBin), 0);
		const vert = results.engines.reduce((a, r) => Math.max(a, r.metrics.vertMaxBin), 0);
		const meanZ = results.engines.map((r) => r.metrics.meanZ);
		console.log(`\nFINDINGS (${SPAN} Myr, types ${TYPE_LIST.join('/')}, shipped view state):`);
		console.log(`  radial   preserved on every lane — worst bin ${(rad * 100).toFixed(1)}% against plan 1.4's 3% budget`);
		console.log(`  arm      held by the capture lane alone — wave 0 ratio ${results.control ? results.control.metrics.armRatio.toFixed(2) : '?'}, ` +
			`wave ${WAVE_UI} ratio ${classic.metrics.armRatio.toFixed(2)} (overshoot is a calibration question, reported not gated)`);
		console.log(`  vertical preserved (0.4.9) — worst bin ${(vert * 100).toFixed(1)}%, mean|z| ${Math.min(...meanZ).toFixed(2)}-${Math.max(...meanZ).toFixed(2)} of the birth column:`);
		console.log(`  the sweep basis carries the birth height, and the classic law's bounded vertical wobble is the only term that moves it`);
	}
}

const logPath = path.join(__dirname, 'logs', 'movement-density.json');
logFile.writeLog(logPath, {
	experiment: 'movement-density',
	date: new Date().toISOString().slice(0, 10),
	setup: { types: TYPE_LIST, stars: N, spanMyr: SPAN, snapMyr: SNAP, dtMyr: DT, seed: SEED, shareUI: SHARE_UI, forceUI: FORCE_UI, waveUI: WAVE_UI },
	radBins: RAD_BINS, vertBins: VERT_BINS, armBins: ARM_BINS,
	gates: { radialBudget: RADIAL_BUDGET, vertBudget: VERT_BUDGET, armFloor: ARM_FLOOR, armFloorGuided: ARM_FLOOR_GUIDED, meanR: [MEANR_LOW, MEANR_HIGH], meanZ: [VERT_MEAN_LOW, VERT_MEAN_HIGH], meanZExactLanes: VERT_MEAN_EXACT_HIGH },
	results,
	checks,
});
console.log('=== VERDICT === ' + (checks.length === passed ? 'PASS' : 'FAIL'));
if (checks.length !== passed) process.exit(1);
