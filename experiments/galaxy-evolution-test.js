// experiments/galaxy-evolution-test.js
// Validates 0.6 E1: the epoch tier (evolution-plan.md). The type table
// describes *present-day* galaxies, so `modelAtAge(model, age)` now re-solves
// what the galaxy is at an earlier epoch — how much of the spheroid has
// assembled, how cold the disc still is, how much gas the arms have to work
// with — beside what its stars are, which 0.3.3 already did.
//
// Five things are checked, in order:
//   1. exactness: at AGE_REF every epoch factor is exactly 1 and a re-derived
//      model is bit-identical to a fresh build, in both directions
//   2. the factors' laws across [AGE_MIN, AGE_REF] for every type: monotone,
//      bounded, exactly 1 at the reference epoch, and the thick:thin height
//      ratio preserved (the disc heats, it does not re-shape)
//   3. only the epoch's numbers move: no length, angle, profile exponent or
//      pattern speed differs, and the geometry key differs in exactly the
//      amplitudes the tier owns
//   4. non-vacuity, measured on sampled stars: the arm contrast the parameter
//      names is the contrast the field carries, and the bulge share matches
//      the mass the sampler was told to deliver
//   5. the disc law: the disc and the halo keep their present mass at every
//      epoch, which is what keeps the gas-driven layers (nebulae, HII regions,
//      open clusters) consistent with the field they live in
//
// Output: experiments/logs/galaxy-evolution.json

'use strict';

const fs = require('fs');
const path = require('path');

const density = require('../src/math/density.js');
const galaxy = require('../src/math/galaxy.js');
const sampling = require('../src/math/sampling.js');

const TYPES = galaxy.GALAXY_TYPES;
const checks = [];
const log = { version: '0.6 E1 the epoch tier', laws: {}, field: {} };

function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
	return !!pass;
}

function sameFloats(a, b) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
	return true;
}

// --- 1. The reference epoch is untouched ---------------------------------
// Every factor is a ratio of the same expression at the same point, so at
// AGE_REF the tier multiplies by exactly 1 — and multiplying by exactly 1 is
// exact. That is what lets every pin describing today's galaxies stand, and it
// is also what the exposure renormalisation re-derives against.
{
	const refFloats = new Float32Array(galaxy.DENSITY_PARAMS_FLOATS);
	const reFloats = new Float32Array(galaxy.DENSITY_PARAMS_FLOATS);
	const backFloats = new Float32Array(galaxy.DENSITY_PARAMS_FLOATS);
	let byteBreak = null;
	let factorBreak = null;
	let populationBreak = null;
	let backBreak = null;
	for (const type of TYPES) {
		const fresh = galaxy.createGalaxy({ type, seed: 11 });
		const rederived = galaxy.modelAtAge(fresh, galaxy.AGE_REF);
		galaxy.packDensityParams(fresh, refFloats);
		galaxy.packDensityParams(rederived, reFloats);
		if (!sameFloats(refFloats, reFloats)) byteBreak = byteBreak || type;
		const e = rederived.epoch;
		if (!(e.heat === 1 && e.armContrast === 1 && e.spheroidProgress === 1 && e.assembly === 1)) {
			factorBreak = factorBreak || { type, heat: e.heat, armContrast: e.armContrast, spheroidProgress: e.spheroidProgress, assembly: e.assembly };
		}
		if (rederived.populations.gasNow !== fresh.populations.gasNow
			|| rederived.populations.gasRich !== fresh.populations.gasRich
			|| !sameFloats(rederived.populations.formQ, fresh.populations.formQ)) {
			populationBreak = populationBreak || type;
		}
		// Both directions: the tier has to be able to undo itself, because
		// `modelAtAge(model, AGE_REF)` is the renderer's reference field.
		const young = galaxy.modelAtAge(fresh, 2);
		const back = galaxy.modelAtAge(young, galaxy.AGE_REF);
		galaxy.packDensityParams(back, backFloats);
		if (!sameFloats(refFloats, backFloats)) backBreak = backBreak || type;
	}
	check('a model re-derived at the reference epoch packs to the same bytes as a fresh build',
		byteBreak === null, byteBreak);
	check('every epoch factor is exactly 1 at the reference epoch, every type',
		factorBreak === null, factorBreak);
	check('the population clock is exactly the reference clock at the reference epoch',
		populationBreak === null, populationBreak);
	check('a young model re-derived back to the reference epoch lands on the fresh build',
		backBreak === null, backBreak);
}

// --- 2. The factors' laws -------------------------------------------------
// heat and spheroidProgress rise with age, armContrast falls, all of them are
// bounded by construction and all three are exactly 1 at AGE_REF. The disc's
// two heights share one factor, so their ratio is an age-independent property
// of the type: the tier thins the disc, it does not reshape it.
{
	const ages = [galaxy.AGE_MIN, 0.5, 1, 2, 3, 5, 8, 11, galaxy.AGE_REF];
	const COMPONENTS = [
		{ name: 'H', component: 'thin' }, { name: 'H', component: 'thick' },
		{ name: 'amp', component: 'spheroid' }, { name: 'amp', component: 'arms' },
	];
	let lawBreak = null;
	let boundsBreak = null;
	let ratioBreak = null;
	let refBreak = null;
	for (const type of TYPES) {
		const fresh = galaxy.createGalaxy({ type, seed: 5 });
		const refModel = galaxy.modelAtAge(fresh, galaxy.AGE_REF);
		const refRatio = refModel.thick.H / refModel.thin.H;
		const row = [];
		let prev = null;
		for (const age of ages) {
			const m = galaxy.modelAtAge(fresh, age);
			const e = m.epoch;
			row.push({
				age, heat: +e.heat.toFixed(6), armContrast: +e.armContrast.toFixed(6),
				spheroidProgress: +e.spheroidProgress.toFixed(6), assembly: +e.assembly.toFixed(6),
			});
			if (prev) {
				const monotone = e.heat >= prev.heat - 1e-12
					&& e.armContrast <= prev.armContrast + 1e-12
					&& e.spheroidProgress >= prev.spheroidProgress - 1e-12;
				if (!monotone) lawBreak = lawBreak || { type, age, prev, now: e };
			}
			if (!(e.heat > 0 && e.heat <= 1 + 1e-12)) boundsBreak = boundsBreak || { type, age, heat: e.heat };
			if (!(e.armContrast >= 1 - 1e-12 && e.armContrast <= galaxy.ARM_CONTRAST_MAX + 1e-12)) {
				boundsBreak = boundsBreak || { type, age, armContrast: e.armContrast };
			}
			if (!(e.spheroidProgress > 0 && e.spheroidProgress <= 1 + 1e-12)) {
				boundsBreak = boundsBreak || { type, age, spheroidProgress: e.spheroidProgress };
			}
			const ratio = m.thick.H / m.thin.H;
			if (Math.abs(ratio / refRatio - 1) > 1e-12) ratioBreak = ratioBreak || { type, age, ratio, refRatio };
			if (age === galaxy.AGE_REF
				&& !(e.heat === 1 && e.armContrast === 1 && e.spheroidProgress === 1 && e.assembly === 1)) {
				refBreak = refBreak || { type, age };
			}
			prev = e;
		}
		log.laws[type] = row;
	}
	check('every epoch factor is monotone in age, for every type', lawBreak === null, lawBreak);
	check('heat ≤ 1, 1 ≤ armContrast ≤ ARM_CONTRAST_MAX, 0 < spheroidProgress ≤ 1',
		boundsBreak === null, boundsBreak);
	check('the thick:thin height ratio is preserved at every epoch, every type',
		ratioBreak === null, ratioBreak);
	check('every factor is exactly 1 at the reference epoch, at the top of the table',
		refBreak === null, refBreak);
}

// --- 3. Only the epoch's numbers move ------------------------------------
// A tier that also moved a length, an angle or a profile exponent would put
// every consumer of the field out of step with the table: the pattern speed,
// the arm ridge coupling and the orbit engines all read the model's own
// geometry, and the plan's contract is that they stay the type table's.
{
	const declared = ['thin.H', 'thick.H', 'spheroidShape.amp', 'arms.amp'];
	const a = new Float32Array(galaxy.DENSITY_PARAMS_FLOATS);
	const b = new Float32Array(galaxy.DENSITY_PARAMS_FLOATS);
	let geometryBreak = null;
	let structureBreak = null;
	let lengthBreak = null;
	let counterBreak = null;
	let coldBreak = null;
	let counted = 0;
	let heatedTypes = 0;
	for (const type of TYPES) {
		const fresh = galaxy.createGalaxy({ type, seed: 3 });
		const young = galaxy.modelAtAge(fresh, galaxy.AGE_MIN);
		galaxy.packDensityParams(fresh, a);
		galaxy.packDensityParams(young, b);
		const moved = [];
		galaxy.DENSITY_PARAMS_LAYOUT.forEach(function (group, gi) {
			// The population and clock groups are the population tier's, and they
			// move with the age by design (0.3.3). The geometry groups are what
			// decides *where* the stars are, and they are walked with their real
			// packed offsets, so a dropped group cannot shift an index.
			if (galaxy.GEOMETRY_GROUPS.indexOf(group) < 0) return;
			group.fields.forEach(function (field, fi) {
				if (Object.is(a[gi * 4 + fi], b[gi * 4 + fi])) return;
				moved.push(group.name + '.' + field);
			});
		});
		// The geometry key may move only inside the declared four.
		const extra = moved.filter((name) => declared.indexOf(name) < 0);
		if (extra.length) geometryBreak = geometryBreak || { type, extra, moved };
		// ...and the halves that must move, so the tier cannot pass by doing
		// nothing: the assembling spheroid, and — for a model that has a disc —
		// the disc heights. A model with neither disc amplitude (the E sequence)
		// keeps its heights on purpose: they are read nowhere but the gas lane,
		// and thinning the lane of a starburst that never formed a disc would
		// hide its HII regions (galaxy.applyEpoch).
		const hasDisc = young.thin.amp > 0 || young.thick.amp > 0;
		if (!(moved.indexOf('spheroidShape.amp') >= 0)) {
			structureBreak = structureBreak || { type, moved };
		}
		if (hasDisc) {
			heatedTypes++;
			if (!(moved.indexOf('thin.H') >= 0 && moved.indexOf('thick.H') >= 0)) {
				structureBreak = structureBreak || { type, moved };
			}
		} else if (moved.indexOf('thin.H') >= 0 || moved.indexOf('thick.H') >= 0) {
			coldBreak = coldBreak || { type, moved };
		}
		// The disc's own amplitudes, the halo's, and every length and angle:
		// compared on the model rather than through the uniform, so a group that
		// is not packed cannot hide here.
		const pairs = [
			['thin.L', fresh.thin.L, young.thin.L], ['thick.L', fresh.thick.L, young.thick.L],
			['thin.amp', fresh.thin.amp, young.thin.amp], ['thick.amp', fresh.thick.amp, young.thick.amp],
			['spheroid.a', fresh.spheroid.a, young.spheroid.a], ['spheroid.b', fresh.spheroid.b, young.spheroid.b],
			['spheroid.c', fresh.spheroid.c, young.spheroid.c], ['spheroid.r0', fresh.spheroid.r0, young.spheroid.r0],
			['spheroid.n', fresh.spheroid.n, young.spheroid.n], ['spheroid.tiltDeg', fresh.spheroid.tiltDeg, young.spheroid.tiltDeg],
			['halo.a_h', fresh.halo.a_h, young.halo.a_h], ['halo.rMax', fresh.halo.rMax, young.halo.rMax],
			['halo.power', fresh.halo.power, young.halo.power], ['halo.amp', fresh.halo.amp, young.halo.amp],
			['arms.m', fresh.arms.m, young.arms.m], ['arms.pitchDeg', fresh.arms.pitchDeg, young.arms.pitchDeg],
			['arms.Rs', fresh.arms.Rs, young.arms.Rs], ['arms.phase0', fresh.arms.phase0, young.arms.phase0],
			['arms.minRadius', fresh.arms.minRadius, young.arms.minRadius],
			['dynamics.vFlat', fresh.dynamics.vFlat, young.dynamics.vFlat],
			['dynamics.rCore', fresh.dynamics.rCore, young.dynamics.rCore],
			['dynamics.omegaPattern', fresh.dynamics.omegaPattern, young.dynamics.omegaPattern],
			['dynamics.loopRatio', fresh.dynamics.loopRatio, young.dynamics.loopRatio],
		];
		for (const [name, before, after] of pairs) {
			if (!Object.is(before, after)) lengthBreak = lengthBreak || { type, name, before, after };
		}
		// The two numbers the tier rewrites outside the uniform. A type with no
		// thin disc has no dispersion to heat (E0-E4), and its thick share is 0
		// for the same reason, so the claim is about the types that do have one.
		if (fresh.dynamics.sigmaThin > 0) {
			counted++;
			if (!(young.dynamics.sigmaThin < fresh.dynamics.sigmaThin
				&& young.dynamics.sigmaThick < fresh.dynamics.sigmaThick
				&& young.dynamics.sigmaThin / fresh.dynamics.sigmaThin
					=== young.dynamics.sigmaThick / fresh.dynamics.sigmaThick)) {
				counterBreak = counterBreak || { type, sigmaThin: young.dynamics.sigmaThin, sigmaThick: young.dynamics.sigmaThick };
			}
		}
	}
	check('the geometry key moves only inside the four amplitudes the tier owns',
		geometryBreak === null, geometryBreak);
	check('the assembling spheroid always moves, and the disc heights move with it wherever a disc exists',
		structureBreak === null && heatedTypes > 0, structureBreak || { heated: heatedTypes });
	check('a model with no disc keeps its own heights: the starburst lane does not thin',
		coldBreak === null, coldBreak);
	check('no length, angle, profile exponent, pattern speed or disc amplitude moves',
		lengthBreak === null, lengthBreak);
	check('the two disc dispersions scale by one heat factor below 1, wherever a disc exists',
		counterBreak === null && counted > 0, counterBreak || { types: counted });
}

// --- 4. The field carries what the parameter says ------------------------
// A parameter that does not reach the sampled stars is not a feature. The arm
// contrast is measurable from the field itself — for a fixed R the sampler's
// azimuthal profile is p ∝ 1 + A·cos(m·φ − K·ln(R/Rs) + phase0), whose mean
// cosine is exactly A/2 — and the bulge share is what the sampler's own weight
// says it delivers, so both can be checked against their own prediction.
{
	const N = 300000;
	const buf = sampling.createBuffers(N);
	let armBreak = null;
	let contrastBreak = null;
	let bulgeBreak = null;
	const measure = (model) => {
		const f = sampling.sampleGalaxyStars(model, 7, N, buf);
		const arms = model.arms;
		const k = density.armWavenumber(model);
		let sumCos = 0;
		let n = 0;
		let bulge = 0;
		for (let i = 0; i < f.count; i++) {
			const component = f.component[i];
			if (component === density.COMPONENT_BULGE) bulge++;
			if (component > density.COMPONENT_THICK) continue;
			const R = f.R[i];
			// Outside the fade-in annulus, where the model's own amplitude is
			// the one the sampler drew with.
			if (!(R > arms.minRadius && R < model.populations.youngOuterR)) continue;
			const phi = Math.atan2(f.y[i] - model.centre.y, f.x[i] - model.centre.x);
			sumCos += Math.cos(arms.m * phi - k * Math.log(R / arms.Rs) + arms.phase0);
			n++;
		}
		const masses = sampling.deliveredMasses(model);
		return {
			cos: sumCos / n, halfAmp: arms.amp / 2,
			bulgeShare: bulge / f.count, bulgeDelivered: masses.bulge / masses.total,
		};
	};
	for (const type of ['SBb', 'Sc', 'Sa']) {
		const fresh = galaxy.createGalaxy({ type, seed: 42 });
		const young = galaxy.modelAtAge(fresh, 2);
		const ref = measure(galaxy.modelAtAge(fresh, galaxy.AGE_REF));
		const now = measure(young);
		log.field[type] = { ref, young: now, armContrast: young.epoch.armContrast };
		if (Math.abs(now.cos / now.halfAmp - 1) > 0.05 || Math.abs(ref.cos / ref.halfAmp - 1) > 0.05) {
			armBreak = armBreak || { type, ref, now };
		}
		const ratio = now.cos / ref.cos;
		if (Math.abs(ratio / young.epoch.armContrast - 1) > 0.05) {
			contrastBreak = contrastBreak || { type, ratio, armContrast: young.epoch.armContrast };
		}
		if (Math.abs(now.bulgeShare - now.bulgeDelivered) > 0.004
			|| Math.abs(ref.bulgeShare - ref.bulgeDelivered) > 0.004) {
			bulgeBreak = bulgeBreak || { type, ref, now };
		}
	}
	check('the sampled arms carry exactly the contrast the parameter names',
		armBreak === null, armBreak);
	check('the young field\'s arm contrast is the tier\'s armContrast, measured on stars',
		contrastBreak === null, contrastBreak);
	check('the sampled bulge share is the mass the sampler was told to deliver',
		bulgeBreak === null, bulgeBreak);
}

// --- 5. The disc law: only the spheroid assembles ------------------------
// The gas-driven layers live in the disc and scale with `gasNow`, so a tier
// that also emptied the disc would put the field in contradiction with its own
// gas: a young galaxy would show a full nebula lane over a disc that had lost
// its stars. The disc and the halo therefore keep their present mass at every
// epoch; what grows in is the spheroid, and with it the bar.
{
	let discBreak = null;
	let windowBreak = null;
	for (const type of TYPES) {
		const fresh = galaxy.createGalaxy({ type, seed: 8 });
		for (const age of [galaxy.AGE_MIN, 1, 3]) {
			const young = galaxy.modelAtAge(fresh, age);
			if (!(young.thin.amp === fresh.thin.amp && young.thick.amp === fresh.thick.amp
				&& young.halo.amp === fresh.halo.amp)) {
				discBreak = discBreak || { type, age };
			}
			// The spheroid's share is the fraction of its own window that has
			// passed: 1 exactly once the window has closed, below it before.
			const closed = young.populations.quenchTime > 0
				? age >= 0.45 * Math.min(galaxy.AGE_REF, young.populations.quenchTime)
				: age >= 0.45 * galaxy.AGE_REF;
			const scaled = young.spheroid.amp !== fresh.spheroid.amp;
			if (closed ? scaled : !scaled) {
				windowBreak = windowBreak || { type, age, closed, progress: young.epoch.spheroidProgress };
			}
		}
	}
	check('the disc and the halo keep their present mass at every epoch',
		discBreak === null, discBreak);
	check('the spheroid moves before its window closes and is its reference self after',
		windowBreak === null, windowBreak);
}

// --- Report -------------------------------------------------------------
let passed = 0;
let failed = 0;
for (const c of checks) {
	if (c.pass) passed++; else failed++;
	console.log(`  ${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.pass ? '' : `  -> ${JSON.stringify(c.detail)}`}`);
}
console.log(`\n${passed}/${checks.length} passed, ${failed} failed`);

const logPath = path.join(__dirname, 'logs', 'galaxy-evolution.json');
fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.writeFileSync(logPath, JSON.stringify(Object.assign(log, {
	ageRange: [galaxy.AGE_MIN, galaxy.AGE_MAX],
	ageRef: galaxy.AGE_REF,
	heatExp: galaxy.HEAT_EXP,
	armContrastMax: galaxy.ARM_CONTRAST_MAX,
	formationWindow: galaxy.FORMATION_WINDOW,
	types: TYPES.length,
	totalChecks: checks.length,
	passed,
	failed,
	checks,
}), null, 1));
console.log(`Wrote ${logPath}`);
if (failed > 0) process.exit(1);
