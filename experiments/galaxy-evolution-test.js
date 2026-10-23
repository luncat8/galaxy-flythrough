// experiments/galaxy-evolution-test.js
// Validates 0.6 E1+E3: the epoch tier (evolution-plan.md). The type table
// describes *present-day* galaxies, so `modelAtAge(model, age)` now re-solves
// what the galaxy is at an earlier epoch — how much of the spheroid has
// assembled (since E3, in size: the axes carry the mass at the reference
// density), how cold the disc still is, how much gas the arms have to work
// with — beside what its stars are, which 0.3.3 already did.
//
// Eight things are checked, in order:
//   1. exactness: at AGE_REF every epoch factor is exactly 1 and a re-derived
//      model is bit-identical to a fresh build, in both directions
//   2. the factors' laws across [AGE_MIN, AGE_REF] for every type: monotone,
//      bounded, exactly 1 at the reference epoch, and the thick:thin height
//      ratio preserved (the disc heats, it does not re-shape)
//   3. only the epoch's numbers move: no disc length, angle or profile
//      exponent differs, and the geometry key differs in exactly the slots
//      the tier owns (heights, arm contrast, the spheroid's axes, and — for
//      a bar — the arm anchor that rides its tip)
//   4. non-vacuity, measured on sampled stars: the arm contrast the parameter
//      names is the contrast the field carries, and the bulge share matches
//      the mass the sampler was told to deliver
//   5. the disc law: the disc and the halo keep their present mass at every
//      epoch, which is what keeps the gas-driven layers (nebulae, HII regions,
//      open clusters) consistent with the field they live in
//   6. E2's live clock: the quantum and its star-time price, drop-not-bank,
//      the throttle, the hold at present day, the replay, and one end-to-end
//      run whose steps are always whole quanta
//   7. E3's morphology: the size law (self-similar, ∝ mass^⅓, the assembled
//      mass still exactly spheroidProgress), the arm ridge re-anchored to the
//      moving bar tip by the additive Δphase0 = K·ln(size), and the bar's
//      pattern speed re-derived from its own length
//   8. the pattern's orientation across epoch re-draws: the phase origin is
//      rebased so the bar and arms do not turn back by ΔΩ_p·T at each step
//
// Output: experiments/logs/galaxy-evolution.json

'use strict';

const path = require('path');
const logFile = require('./log-file.js');

const density = require('../src/math/density.js');
const galaxy = require('../src/math/galaxy.js');
const sampling = require('../src/math/sampling.js');
const starTypes = require('../src/math/star-types.js');
const orbit = require('../src/math/orbit.js');

const TYPES = galaxy.GALAXY_TYPES;
const checks = [];
const log = { version: '0.6 E1 the epoch tier + E2 the live clock + E3 morphology', laws: {}, field: {}, e3: {} };

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
				spheroidProgress: +e.spheroidProgress.toFixed(6), spheroidSize: +e.spheroidSize.toFixed(6),
				assembly: +e.assembly.toFixed(6),
			});
			if (prev) {
				const monotone = e.heat >= prev.heat - 1e-12
					&& e.armContrast <= prev.armContrast + 1e-12
					&& e.spheroidProgress >= prev.spheroidProgress - 1e-12;
				if (!monotone) lawBreak = lawBreak || { type, age, prev, now: e };
			}
			// E3's factor is E1's mass factor under the cube root — one clock,
			// no second schedule — and exactly 1 when the mass factor is.
			if (!(e.spheroidSize === Math.cbrt(e.spheroidProgress)
				&& (e.spheroidProgress === 1) === (e.spheroidSize === 1)
				&& e.spheroidSize >= 0 && e.spheroidSize <= 1 + 1e-12)) {
				boundsBreak = boundsBreak || { type, age, spheroidSize: e.spheroidSize, spheroidProgress: e.spheroidProgress };
			}
			if (!(e.heat > 0 && e.heat <= 1 + 1e-12)) boundsBreak = boundsBreak || { type, age, heat: e.heat };
			if (!(e.armContrast >= 1 - 1e-12 && e.armContrast <= galaxy.ARM_CONTRAST_MAX + 1e-12)) {
				boundsBreak = boundsBreak || { type, age, armContrast: e.armContrast };
			}
			if (!(e.spheroidProgress >= 0 && e.spheroidProgress <= 1 + 1e-12)) {
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
	check('heat ≤ 1, 1 ≤ armContrast ≤ ARM_CONTRAST_MAX, 0 ≤ spheroidProgress ≤ 1, size = progress^⅓ ∈ [0, 1]',
		boundsBreak === null, boundsBreak);
	check('the thick:thin height ratio is preserved at every epoch, every type',
		ratioBreak === null, ratioBreak);
	check('every factor is exactly 1 at the reference epoch, at the top of the table',
		refBreak === null, refBreak);
}

// --- 3. Only the epoch's numbers move ------------------------------------
// A tier that moved a disc length, an angle or a profile exponent would put
// every consumer of the field out of step with the table: the orbit engines,
// the renderer's packed uniforms and the arm ridge coupling all read the
// model's own geometry. E3's contract is the spheroid's own size — its axes,
// the arm anchor that rides the bar tip, and (for a bar) the pattern speed
// that derives from its length — and nothing else.
{
	const declared = ['thin.H', 'thick.H', 'arms.amp',
		'spheroid.a', 'spheroid.b', 'spheroid.c', 'armShape.phase0', 'armShape.minRadius'];
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
		// nothing: the assembling spheroid (its axes, at every age below the
		// window's close), the arm anchor of a bar that rides its tip, and —
		// for a model that has a disc — the disc heights. A model with neither
		// disc amplitude (the E sequence) keeps its heights on purpose: they
		// are read nowhere but the gas lane, and thinning the lane of a
		// starburst that never formed a disc would hide its HII regions
		// (galaxy.applyEpoch).
		const hasDisc = young.thin.amp > 0 || young.thick.amp > 0;
		if (!(moved.indexOf('spheroid.a') >= 0 && moved.indexOf('spheroid.b') >= 0 && moved.indexOf('spheroid.c') >= 0)) {
			structureBreak = structureBreak || { type, moved };
		}
		if (fresh.barred && !(moved.indexOf('armShape.minRadius') >= 0)) {
			structureBreak = structureBreak || { type, moved, bar: true };
		}
		if (hasDisc) {
			heatedTypes++;
			if (!(moved.indexOf('thin.H') >= 0 && moved.indexOf('thick.H') >= 0)) {
				structureBreak = structureBreak || { type, moved };
			}
		} else if (moved.indexOf('thin.H') >= 0 || moved.indexOf('thick.H') >= 0) {
			coldBreak = coldBreak || { type, moved };
		}
		// Every disc length and angle, the shape numbers and the amplitudes the
		// tier does not own: compared on the model rather than through the
		// uniform, so a group that is not packed cannot hide here. E3 moved four
		// names off this list and onto the declared one (the spheroid's axes and
		// the bar's arm anchor); the spheroid's *amp* joined it instead — the
		// assembly is size now, and the density stays the reference's. The arm
		// anchor and the bar's pattern speed move only with a bar: a non-barred
		// model's ridge and wave speed are the type table's at every epoch.
		const pairs = [
			['thin.L', fresh.thin.L, young.thin.L], ['thick.L', fresh.thick.L, young.thick.L],
			['thin.amp', fresh.thin.amp, young.thin.amp], ['thick.amp', fresh.thick.amp, young.thick.amp],
			['spheroid.amp', fresh.spheroid.amp, young.spheroid.amp],
			['spheroid.r0', fresh.spheroid.r0, young.spheroid.r0],
			['spheroid.n', fresh.spheroid.n, young.spheroid.n], ['spheroid.tiltDeg', fresh.spheroid.tiltDeg, young.spheroid.tiltDeg],
			['halo.a_h', fresh.halo.a_h, young.halo.a_h], ['halo.rMax', fresh.halo.rMax, young.halo.rMax],
			['halo.power', fresh.halo.power, young.halo.power], ['halo.amp', fresh.halo.amp, young.halo.amp],
			['arms.m', fresh.arms.m, young.arms.m], ['arms.pitchDeg', fresh.arms.pitchDeg, young.arms.pitchDeg],
			['arms.Rs', fresh.arms.Rs, young.arms.Rs],
			['dynamics.vFlat', fresh.dynamics.vFlat, young.dynamics.vFlat],
			['dynamics.rCore', fresh.dynamics.rCore, young.dynamics.rCore],
			['dynamics.loopRatio', fresh.dynamics.loopRatio, young.dynamics.loopRatio],
		];
		if (!fresh.barred) {
			pairs.push(['arms.phase0', fresh.arms.phase0, young.arms.phase0],
				['arms.minRadius', fresh.arms.minRadius, young.arms.minRadius],
				['dynamics.omegaPattern', fresh.dynamics.omegaPattern, young.dynamics.omegaPattern]);
		}
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
	check('the geometry key moves only inside the slots the tier owns',
		geometryBreak === null, geometryBreak);
	check('the assembling spheroid always moves, its bar\'s arm anchor with it, and the disc heights move wherever a disc exists',
		structureBreak === null && heatedTypes > 0, structureBreak || { heated: heatedTypes });
	check('a model with no disc keeps its own heights: the starburst lane does not thin',
		coldBreak === null, coldBreak);
	check('no disc length, angle, profile exponent or unclaimed amplitude moves, and a non-barred model keeps its ridge and wave speed',
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
			const scaled = young.spheroid.a !== fresh.spheroid.a;
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

// --- 6. E4: the epoch's live clock ---------------------------------------
// The clock that runs the epoch on the star-time axis, checked as the law the
// page calls rather than as numbers read out of main.js. E4 changed what a step
// *is*: the field is drawn once and placed by the epoch (orbit.epochMap), so a
// step is a model re-solve and a uniform lane instead of a 300k-star rebuild.
// The unit bridge, the monotone run, the hold at present day and the replay are
// the same laws as E2's; what is measured here is the step's cost, which is now
// independent of the star count.
{
	check('the epoch quantum is the slider step and its price is the unit bridge',
		galaxy.AGE_STEP === 0.1 && galaxy.EVOLVE_GYR_PER_MYR === 0.001
		&& Math.abs(galaxy.AGE_STEP * 1000 * galaxy.EVOLVE_GYR_PER_MYR - galaxy.AGE_STEP) < 1e-12,
		{ step: galaxy.AGE_STEP, gyrPerMyr: galaxy.EVOLVE_GYR_PER_MYR });

	// A continuous run: one 60 fps frame at the slider's top rate is 1.65 Myr of
	// star time, which the unit bridge turns into 0.00165 Gyr of age. The age is
	// monotone, it never jumps more than a frame is worth, and it holds at
	// present day rather than banking star time it can no longer spend.
	const FRAME_MYR = 99 / 60;
	let age = galaxy.AGE_MIN;
	let steps = 0;
	let maxJump = 0;
	while (age < galaxy.AGE_MAX && steps < 1000000) {
		const next = galaxy.evolveAge(age, FRAME_MYR);
		if (!(next > age)) break;
		maxJump = Math.max(maxJump, next - age);
		age = next;
		steps++;
	}
	const frameStep = FRAME_MYR * galaxy.EVOLVE_GYR_PER_MYR;
	check('a continuous run is monotone, never jumps more than a frame is worth, and holds at present day',
		age === galaxy.AGE_MAX && steps === Math.ceil((galaxy.AGE_MAX - galaxy.AGE_MIN) / frameStep)
		&& maxJump <= frameStep + 1e-12 && galaxy.evolveAtEnd(age),
		{ age, steps, maxJump, frameStep });
	check('the run stops where the model does',
		galaxy.evolveAge(galaxy.AGE_MAX, 1000) === galaxy.AGE_MAX
		&& galaxy.evolveAtEnd(galaxy.AGE_MAX) && !galaxy.evolveAtEnd(galaxy.AGE_MAX - galaxy.AGE_STEP / 2));

	// The replay: a run ticked on at the end of the range starts over, because
	// at present day there is nothing left to watch.
	check('a run that starts at the end replays from the beginning',
		galaxy.evolveStartAge(galaxy.AGE_MAX) === galaxy.AGE_MIN
		&& galaxy.evolveStartAge(galaxy.AGE_MAX - galaxy.AGE_STEP / 2) === galaxy.AGE_MIN
		&& galaxy.evolveStartAge(2) === 2 && galaxy.evolveStartAge(galaxy.AGE_MIN) === galaxy.AGE_MIN);

	// What a step costs now. `modelAtAge` re-solves the epoch (E1/E3 laws) and
	// `packEpochParams` is one vec4; neither reads the star count, which is the
	// whole point — 0.6's step paid 325 ms of re-sample at 300k stars.
	const orbit = require('../src/math/orbit.js');
	const lane = new Float32Array(orbit.EPOCH_FLOATS);
	let m = galaxy.createGalaxy({ type: 'SBb', age: 2 });
	const t0 = process.hrtime.bigint();
	for (let i = 0; i < 200; i++) {
		m = galaxy.modelAtAge(m, 2 + (i % 100) * galaxy.AGE_STEP);
		orbit.packEpochParams(m, lane, 0, -0.42);
	}
	const stepMs = Number(process.hrtime.bigint() - t0) / 1e6 / 200;
	check('an epoch step costs a model re-solve and one uniform lane, not a field',
		stepMs < 2, { stepMs: +stepMs.toFixed(4) });

	// The CPU mirror every pick and every label uses, and the one the sweep
	// reads: O(1) per star with the trig hoisted into solveEpochParams.
	orbit.setEpochBase(galaxy.createGalaxy({ type: 'SBb', age: galaxy.AGE_REF }));
	orbit.packEpochParams(galaxy.createGalaxy({ type: 'SBb', age: 0.5 }), lane, 0, 0);
	const out = [0, 0, 0];
	const flags = require('../src/math/star-record.js').FLAG_EPOCH;
	const t1 = process.hrtime.bigint();
	for (let i = 0; i < 300000; i++) orbit.epochMap(out, 5 + (i % 7) * 0.1, 1, 0.2, orbit.FAMILY_PATTERN, flags, m);
	const mapMs = Number(process.hrtime.bigint() - t1) / 1e6;
	check('the epoch map is a per-star constant-time placement (300k under 100 ms)',
		mapMs < 100, { mapMs: +mapMs.toFixed(1) });

	// The cadence's own number is gone: a run that used to pay a rebuild per
	// step now pays nothing at all for the field. What is left is the sweep,
	// which is the renderer's business (a slice per frame) and is measured in
	// the renderer's own test.
	const RATE = 99;                       // Myr/s, the slider's top rate
	const runWall = ((galaxy.AGE_MAX - galaxy.AGE_MIN) * 1000) / RATE / 60;
	let runAge = galaxy.AGE_MIN;
	let runSteps = 0;
	let starMyr = 0;
	while (runAge < galaxy.AGE_MAX && runSteps < 1000000) {
		starMyr += RATE / 60;
		const next = galaxy.evolveAge(runAge, RATE / 60);
		if (!(next > runAge)) break;
		runAge = next;
		runSteps++;
	}
	check('every frame of a whole run is a real step, in bounded star time',
		runAge === galaxy.AGE_MAX && starMyr >= (galaxy.AGE_MAX - galaxy.AGE_MIN) * 1000,
		{ runSteps, starMyr });
	log.evolve = {
		stepGyr: galaxy.AGE_STEP, gyrPerMyr: galaxy.EVOLVE_GYR_PER_MYR,
		steps: runSteps, starMyr, runMinutes: runWall, maxJump, rate: RATE,
		stepMs: +stepMs.toFixed(4), mapMs300k: +mapMs.toFixed(1),
	};
	console.log(`  ..   live run: ${runSteps} frames, ${(starMyr / 1000).toFixed(1)} Gyr of star time,`
		+ ` ${runWall.toFixed(1)} min of wall time at ${RATE} Myr/s; a step costs ${stepMs.toFixed(3)} ms`
		+ ` and the field is never re-sampled`);
}


// --- 7. E3: the morphology grows -----------------------------------------
// The assembled spheroid mass occupies a self-similar volume at the reference
// density: the axes carry `∝ mass^⅓`, the amp stays the type table's, and the
// delivered bulge mass fraction is therefore still exactly E1's
// `spheroidProgress` — the double-counting reading (amp and size both scaled,
// mass ∝ progress²) is what this section's mass row rejects by measurement.
// A bar drags two things with its tip: the arm's inner edge (the table's own
// identity, minRadius = a·r0, at every epoch) and the ridge that leaves from
// it, re-anchored additively by Δphase0 = K·ln(R'min/Rmin) — the one form
// that is exactly 0 at AGE_REF (ln 1 = 0) and so leaves the preset's literal
// phase0 standing. The bar's pattern speed then follows from its own length
// through the build's own derivation.
{
	const PRECESSION = 1 - 1 / Math.SQRT2;
	const ages = [galaxy.AGE_MIN, 0.5, 1, 2, 5, 8, galaxy.AGE_REF];
	let sizeBreak = null;
	let similarBreak = null;
	let massBreak = null;
	let tipBreak = null;
	let ridgeBreak = null;
	let additiveBreak = null;
	let patternBreak = null;
	let monotoneBreak = null;
	for (const type of TYPES) {
		const fresh = galaxy.createGalaxy({ type, seed: 21 });
		const ref = galaxy.modelAtAge(fresh, galaxy.AGE_REF);
		const refMass = density.componentMasses(ref).bulge;
		const ratioRef = fresh.spheroid.b / fresh.spheroid.a;
		const flatRef = fresh.spheroid.c / fresh.spheroid.a;
		const tiltRad = fresh.spheroid.tiltDeg * Math.PI / 180;
		const coupled = fresh.barred && fresh.arms.m > 0 && fresh.arms.pitchDeg > 0;
		const row = [];
		let prevOmega = null;
		for (const age of ages) {
			const m = galaxy.modelAtAge(fresh, age);
			const e = m.epoch;
			const size = e.spheroidSize;
			row.push({ age, size: +size.toFixed(4), a: +m.spheroid.a.toFixed(4),
				minRadius: +m.arms.minRadius.toFixed(4), phase0: +m.arms.phase0.toFixed(4),
				omegaPattern: +m.dynamics.omegaPattern.toFixed(6) });
			// The axes are the reference axes under one factor, so the shape the
			// type table authored (boxiness, flatness, loopRatio) is the shape
			// at every epoch — the spheroid shrinks, it does not reshape.
			if (!(Object.is(m.spheroid.a, fresh.spheroid.a * size)
				&& Object.is(m.spheroid.b, fresh.spheroid.b * size)
				&& Object.is(m.spheroid.c, fresh.spheroid.c * size))) {
				sizeBreak = sizeBreak || { type, age, size };
			}
			if (Math.abs(m.spheroid.b / m.spheroid.a / ratioRef - 1) > 1e-12
				|| Math.abs(m.spheroid.c / m.spheroid.a / flatRef - 1) > 1e-12
				|| !Object.is(m.dynamics.loopRatio, fresh.dynamics.loopRatio)) {
				similarBreak = similarBreak || { type, age };
			}
			// The mass law: the field's bulge mass fraction is the epoch's own
			// spheroidProgress — assembly moved from amp to size, it did not
			// double. The amp itself never moves.
			const bulgeNow = density.componentMasses(m).bulge;
			if (!Object.is(m.spheroid.amp, fresh.spheroid.amp)
				|| (refMass > 0 && Math.abs(bulgeNow / refMass - e.spheroidProgress) > 1e-12)) {
				massBreak = massBreak || { type, age, fraction: bulgeNow / refMass, progress: e.spheroidProgress };
			}
			if (!fresh.barred) continue;
			// The arms leave at the bar's end at every epoch, and — where a
			// ridge is coupled to that end — it still passes through it at the
			// bar's tilt, because the correction is the additive K·ln(size).
			if (Math.abs(m.arms.minRadius - m.spheroid.a * m.spheroid.r0) > 1e-12) {
				tipBreak = tipBreak || { type, age, minRadius: m.arms.minRadius, tip: m.spheroid.a * m.spheroid.r0 };
			}
			if (coupled) {
				// The preset authors phase0 rounded to 4 decimals, so the ridge
				// sits ~1e-5 kpc off the tip at every epoch — the galaxy-types
				// tolerance, now at a moved tip. At T = 0 the spheroid has not
				// assembled (size = 0) and there is no bar to anchor a ridge, so
				// the check is skipped for that epoch.
				if (size > 0) {
					const d = density.distanceToNearestArm(m, m.arms.minRadius, tiltRad);
					if (!(d < 1e-4)) ridgeBreak = ridgeBreak || { type, age, d };
				}
				const delta = size > 0 ? density.armWavenumber(m) * Math.log(size) : 0;
				const want = delta === 0 ? fresh.arms.phase0 : galaxy.wrapTwoPi(fresh.arms.phase0 + delta);
				if (Math.abs(m.arms.phase0 - want) > 1e-12) {
					additiveBreak = additiveBreak || { type, age, phase0: m.arms.phase0, want };
				}
			} else if (!Object.is(m.arms.phase0, fresh.arms.phase0)) {
				additiveBreak = additiveBreak || { type, age, uncoupled: m.arms.phase0 };
			}
			// The pattern speed is the build's own law read on the epoch's own
			// bar: shorter bar, faster pattern, flat at the rCore floor — and
			// bit-identical to the build's value at the reference epoch. A
			// 0-size spheroid (T = 0) has no bar and no pattern to drive.
			const extent = Math.min(1, m.truncation.spheroidRadius);
			const wantOmega = (m.dynamics.vFlat > 0 && m.spheroid.a > 0)
				? PRECESSION * m.dynamics.vFlat / Math.max(m.spheroid.a * m.spheroid.r0 * extent, m.dynamics.rCore)
				: 0;
			if (!Object.is(m.dynamics.omegaPattern, galaxy.barPatternSpeed(m.dynamics, m.spheroid, m))
				|| Math.abs(m.dynamics.omegaPattern - wantOmega) > 1e-15) {
				patternBreak = patternBreak || { type, age, omega: m.dynamics.omegaPattern, want: wantOmega };
			}
			// Ages walk upward, so the pattern must never speed up: a longer
			// bar is a slower one, flat only while the tip sits inside rCore.
			// At T = 0 the bar has not assembled (omega = 0) and the first
			// positive size may still sit inside rCore, so the check starts
			// once both the previous and current omegas are positive.
			if (prevOmega !== null && prevOmega > 0 && m.dynamics.omegaPattern > 0
				&& m.dynamics.omegaPattern > prevOmega + 1e-15) {
				monotoneBreak = monotoneBreak || { type, age, omega: m.dynamics.omegaPattern, prev: prevOmega };
			}
			prevOmega = m.dynamics.omegaPattern;
			if (age === galaxy.AGE_REF) {
				if (!Object.is(m.dynamics.omegaPattern, fresh.dynamics.omegaPattern)
					|| !Object.is(m.arms.phase0, fresh.arms.phase0)
					|| !Object.is(m.arms.minRadius, fresh.arms.minRadius)) {
					patternBreak = patternBreak || { type, age, ref: true };
				}
			}
		}
		log.e3[type] = row;
	}
	check('the spheroid\'s axes are the reference axes under one size factor, at every epoch',
		sizeBreak === null, sizeBreak);
	check('the growth is self-similar: boxiness, flatness and loopRatio are the type\'s at every epoch',
		similarBreak === null, similarBreak);
	check('the delivered bulge mass is still exactly spheroidProgress: assembly moved from amp to size',
		massBreak === null, massBreak);
	check('the arms leave at the bar\'s end at every epoch (minRadius = a·r0)',
		tipBreak === null, tipBreak);
	check('the coupled ridge still passes through the moved bar tip at the bar\'s tilt',
		ridgeBreak === null, ridgeBreak);
	check('the re-anchor is the additive Δphase0 = K·ln(size), and exactly nothing at the reference epoch',
		additiveBreak === null, additiveBreak);
	check('the bar\'s pattern speed is the build\'s own law on the epoch\'s own length',
		patternBreak === null, patternBreak);
	check('a younger bar is a shorter bar is a faster pattern, monotonically',
		monotoneBreak === null, monotoneBreak);

	// Non-vacuity on the stars themselves: the bulge the sampler draws is the
	// smaller one. Its mean radius scales with the axes — the same u-draws land
	// on the same s under the same profile, at the epoch's own scale.
	const N = 300000;
	const buf = sampling.createBuffers(N);
	let extentBreak = null;
	for (const type of ['SBb', 'E4']) {
		const fresh = galaxy.createGalaxy({ type, seed: 42 });
		const meanBulgeR = (model) => {
			const f = sampling.sampleGalaxyStars(model, 42, N, buf);
			let sum = 0;
			let n = 0;
			for (let i = 0; i < f.count; i++) {
				if (f.component[i] !== density.COMPONENT_BULGE) continue;
				sum += f.R[i];
				n++;
			}
			return { mean: sum / n, n };
		};
		const refMean = meanBulgeR(galaxy.modelAtAge(fresh, galaxy.AGE_REF));
		log.e3[type + '-bulgeR'] = { reference: +refMean.mean.toFixed(4) };
		for (const age of [0.5, 2, 8]) {
			const m = galaxy.modelAtAge(fresh, age);
			const young = meanBulgeR(m);
			log.e3[type + '-bulgeR'][age] = { mean: +young.mean.toFixed(4), size: +m.epoch.spheroidSize.toFixed(4) };
			if (Math.abs(young.mean / refMean.mean / m.epoch.spheroidSize - 1) > 0.03) {
				extentBreak = extentBreak || { type, age, ratio: young.mean / refMean.mean, size: m.epoch.spheroidSize };
			}
		}
	}
	check('the sampled bulge is the smaller one: its mean radius rides the size factor',
		extentBreak === null, extentBreak);
}

// --- 8. The pattern keeps its orientation across epochs ------------------
// E3 re-derives Ω_p from the bar's own length, and the star clock T is not
// reset by a re-draw, so a law of the form Ω_p·T would jump by ΔΩ_p·T at every
// live step — backwards, since the bar slows as it grows. E2 patched that by
// rebasing a phase origin on each re-draw; E4 removed the product instead. The
// phase is an accumulator, advanced per frame by the frame's own star time
// (orbit.advancePatternPhase), and the lanes multiply by the *mean* rate
// (orbit.meanPatternSpeed) so that mean·T is the accumulator itself. This pins
// both halves over a whole live run, and pins the naive law's failure so the
// defect cannot come back unnoticed.
{
	const orbit = require('../src/math/orbit.js');
	const wrapPi = (a) => a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
	// The naive law the epoch tier broke: the current rate times the whole
	// elapsed clock. Its drift is the integral of t·dΩ_p against the integral of
	// Ω_p, and it is measured here as the gap between the two at the end of a
	// whole run, plus the largest single-frame jump the law makes on the way.
	const naiveAngle = (m, t) => m.dynamics.omegaPattern * t;
	orbit.setPatternScale(1);
	orbit.resetPatternPhase();
	let m = galaxy.createGalaxy({ type: 'SBb', age: galaxy.AGE_MIN });
	let t = 0;
	let phi = 0;                 // the accumulator, unwrapped, summed frame by frame
	let worstNaiveJump = 0;
	let worstAccumulated = 0;
	let barWorst = 0;
	const bar = new Float64Array(3);
	const barNext = new Float64Array(3);
	while (m.populations.age < galaxy.AGE_MAX) {
		// One frame of star time at the top rate, and one age step: the epoch
		// advances with the clock, which is the shipping arrangement.
		const dtStar = 99 / 60;
		t += dtStar;
		const next = galaxy.modelAtAge(m, galaxy.evolveAge(m.populations.age, dtStar));
		if (next.populations.age === m.populations.age) break;
		// The shipping order (main.js): the phase is advanced at the rate the
		// model had *while the frame elapsed*, before the epoch tick that follows.
		const phaseBefore = orbit.getPatternPhase();
		const phaseMid = orbit.setPatternClock(t, m);
		const gain = wrapPi(phaseMid - phaseBefore);
		phi += gain;
		worstAccumulated = Math.max(worstAccumulated,
			Math.abs(wrapPi(gain - dtStar * orbit.instantPatternSpeed(m))));
		orbit.orbitPosition(bar, 0.8, 0.1, 0, orbit.FAMILY_BAR, 0, 0, t, m);
		const naiveJump = wrapPi(naiveAngle(next, t) - naiveAngle(m, t));
		worstNaiveJump = Math.max(worstNaiveJump, Math.abs(naiveJump));
		orbit.setPatternClock(t, next);
		orbit.orbitPosition(barNext, 0.8, 0.1, 0, orbit.FAMILY_BAR, 0, 0, t, next);
		const barTurn = Math.abs(wrapPi(Math.atan2(barNext[1], barNext[0]) - Math.atan2(bar[1], bar[0])));
		barWorst = Math.max(barWorst, barTurn);
		m = next;
	}
	// The drift the naive law accumulates over the run: the rate is re-derived by
	// every epoch step, and every step of the clock then re-scales the whole
	// elapsed history. It is what the user saw as "back in time every Evolve
	// step" — radians, not milliradians.
	const naiveDrift = wrapPi(naiveAngle(m, t) - phi);
	log.patternContinuity = { worstNaiveJump, naiveDrift, worstAccumulated, barWorst, finalT: t, phi };
	check('the naive rate-times-clock law drifts radians over a run (the defect is real)',
		Math.abs(naiveDrift) > 1, { naiveDrift, naiveJump: worstNaiveJump });
	check('the accumulator adds exactly the frame\'s own rate over the frame\'s own time',
		worstAccumulated < 1e-9, { worstAccumulated });
	// Not exact: the star's x1 loop runs at the epoch's own stream rate, so its
	// loop phase moves with the epoch — a few-mrad epicycle (≈2 pc at 0.8 kpc),
	// not the pattern turning, which was radians under the naive law.
	check('a bar-family star keeps its azimuth across every epoch step (to its x1 loop)',
		barWorst < 0.01, { barWorst });
	// The lanes multiply by the mean rate, and the product is the accumulator —
	// the invariant that lets a closed-form law ride a rate that moves.
	const mean = orbit.meanPatternSpeed(m);
	check('the lane rate times the clock is the accumulated phase',
		Math.abs(wrapPi(mean * t - orbit.getPatternPhase())) < 1e-9,
		{ product: mean * t, phase: orbit.getPatternPhase() });
	orbit.resetPatternPhase();
}


// --- 9. Deep time: T = 0 is pure gas, no stars ----------------------------
// 0.7.2 lowered AGE_MIN from 0.2 to 0 so the Evolve preset starts at the
// galaxy's first light. At T = 0 every formation-law factor degenerates: the
// plan lists each one and its resolution. This section pins them.
{
	let deepBreak = null;
	for (const type of TYPES) {
		const fresh = galaxy.createGalaxy({ type, seed: 7 });
		const m = galaxy.modelAtAge(fresh, galaxy.AGE_MIN);
		const e = m.epoch;
		const issues = [];
		// Nothing has formed: the SFH progress is 0, gas is 1.
		if (e.sfhProgress !== 0 && e.assembly !== 0) {
			// assembly reads sfhProgress; at T=0 both are 0.
		}
		if (e.assembly > 1e-15) issues.push('assembly not 0 at T=0');
		if (Math.abs(e.gasNow - 1) > 1e-12) issues.push('gasNow not 1 at T=0');
		// The spheroid has not assembled: its progress and size are 0.
		if (e.spheroidProgress !== 0) issues.push('spheroidProgress not 0 at T=0');
		if (e.spheroidSize !== 0) issues.push('spheroidSize not 0 at T=0');
		// The spheroid axes are 0: no bulge, no bar.
		if (m.spheroid.a !== 0) issues.push('spheroid.a not 0 at T=0');
		if (m.spheroid.b !== 0) issues.push('spheroid.b not 0 at T=0');
		if (m.spheroid.c !== 0) issues.push('spheroid.c not 0 at T=0');
		// Heat is floored so discHeightAt stays finite for the picker.
		if (!(e.heat > 0 && e.heat <= 1)) issues.push('heat out of (0,1] at T=0');
		// Arm contrast saturates: the gas-rich early disc has maximum arm signal.
		if (!(e.armContrast >= 1 - 1e-12 && e.armContrast <= galaxy.ARM_CONTRAST_MAX + 1e-12)) {
			issues.push('armContrast out of range at T=0');
		}
		// Disc heights are finite (heat floor keeps them above 0).
		if (!(m.thin.H > 0)) issues.push('thin.H not positive at T=0');
		if (!(m.thick.H > 0)) issues.push('thick.H not positive at T=0');
		// A barred type has no pattern at T=0 (the bar hasn't assembled).
		if (fresh.barred && m.dynamics.omegaPattern !== 0) {
			issues.push('barred omegaPattern not 0 at T=0');
		}
		// The arm inner edge rides the bar tip; both are 0 at T=0.
		if (fresh.barred && m.arms.minRadius !== 0) {
			issues.push('barred minRadius not 0 at T=0');
		}
		// Phase0 keeps its base when size is 0 (delta = 0 guard).
		if (fresh.barred && !Object.is(m.arms.phase0, fresh.arms.phase0)) {
			issues.push('phase0 moved at T=0');
		}
		// All finite: no NaN, no Infinity anywhere.
		for (const key of ['heat', 'armContrast', 'spheroidProgress', 'spheroidSize', 'gasNow']) {
			if (!isFinite(e[key])) issues.push(key + ' not finite');
		}
		if (issues.length) deepBreak = deepBreak || { type, issues };
	}
	check('at T = 0 every factor is the deep-time limit: no gas left, no spheroid, heat floored, pattern off',
		deepBreak === null, deepBreak);
}


// --- 10. Gas account (F4): the census-calibrated view gas ------------------
// The renderer's 1024-bin birth histogram replaces the SFH gasNow for the
// field's arm contrast. This section tests the histogram logic and the view
// gas it delivers, without WebGPU: the same CPU math the renderer uses,
// driven by the model's own birth draws.
{
	const BINS = 1024;
	const fade = orbit.BIRTH_FADE_GYR;

	// Build the histogram from the field's births (same logic as the renderer).
	function buildHist(births, count, spanRef) {
		const hist = new Uint32Array(BINS);
		if (count <= 0 || !(spanRef > 0)) return { hist, spanRef, total: 0 };
		const scale = BINS / spanRef;
		for (let i = 0; i < count; i++) {
			let k = (births[i] * scale) | 0;
			if (k < 0) k = 0;
			else if (k >= BINS) k = BINS - 1;
			hist[k]++;
		}
		let total = 0;
		for (let k = 0; k < BINS; k++) total += hist[k];
		return { hist, spanRef, total };
	}

	function evaluatePresence(hist, spanRef, T) {
		if (!(spanRef > 0)) return 0;
		const binWidth = spanRef / BINS;
		let sum = 0;
		for (let k = 0; k < BINS; k++) {
			if (hist[k] === 0) continue;
			const centre = (k + 0.5) * binWidth;
			let t = (T - centre) / fade;
			if (t < 0) t = 0; else if (t > 1) t = 1;
			sum += hist[k] * (t * t * (3 - 2 * t));
		}
		return sum;
	}

	// The exact O(N) presence for comparison.
	function exactPresence(births, count, T) {
		let sum = 0;
		for (let i = 0; i < count; i++) {
			let t = (T - births[i]) / fade;
			if (t < 0) t = 0; else if (t > 1) t = 1;
			sum += t * t * (3 - 2 * t);
		}
		return sum;
	}

	const N = 50000;
	const buf = sampling.createBuffers(N);
	let histBreak = null;
	let endpointBreak = null;
	let monotoneBreak = null;
	let approxBreak = null;
	log.gasAccount = {};

	for (const type of TYPES) {
		const fresh = galaxy.createGalaxy({ type, seed: 11 });
		const reference = galaxy.modelAtAge(fresh, galaxy.AGE_REF);
		const spanRef = galaxy.sfhSpanAt(galaxy.AGE_REF, reference.populations.quenchTime);
		const births = new Float64Array(N);
		const f = sampling.sampleGalaxyStars(reference, 11, N, buf);
		const count = Math.min(f.count, N);
		for (let i = 0; i < count; i++) {
			births[i] = starTypes.sampleFieldBirth(reference,
				starTypes.fieldStarSeed(reference.seed, i), f.component[i],
				f.R[i], f.distToArm[i], f.z[i]);
		}

		const { hist, total } = buildHist(births, count, spanRef);

		// The histogram's total equals the census count.
		if (total !== count) histBreak = histBreak || { type, total, count };

		const prefRef = evaluatePresence(hist, spanRef, galaxy.AGE_REF);
		const pres0 = evaluatePresence(hist, spanRef, galaxy.AGE_MIN);

		// At AGE_REF every gate is 1, so formed = 1 and viewGas = gasFraction.
		const formedRef = prefRef > 0 ? evaluatePresence(hist, spanRef, galaxy.AGE_REF) / prefRef : 1;
		const viewGasRef = 1 - formedRef * (1 - reference.populations.gasFraction);
		// At T = 0 every gate is 0, so viewGas = 1.
		const formed0 = prefRef > 0 ? pres0 / prefRef : 0;
		const viewGas0 = 1 - formed0 * (1 - reference.populations.gasFraction);

		if (Math.abs(viewGasRef - reference.populations.gasFraction) > 0.01
			|| Math.abs(viewGas0 - 1) > 0.01) {
			endpointBreak = endpointBreak || { type, viewGasRef, gasFraction: reference.populations.gasFraction, viewGas0 };
		}

		// Monotone: view gas decreases with age.
		let prevGas = 1;
		for (const age of [0, 0.5, 1, 2, 5, 8, galaxy.AGE_REF]) {
			const pres = evaluatePresence(hist, spanRef, age);
			const formed = prefRef > 0 ? pres / prefRef : 0;
			const viewGas = 1 - formed * (1 - reference.populations.gasFraction);
			if (viewGas > prevGas + 1e-9) {
				monotoneBreak = monotoneBreak || { type, age, viewGas, prevGas };
			}
			prevGas = viewGas;
		}

		// Histogram approximation vs exact O(N) sum at several epochs.
		let maxErr = 0;
		for (const age of [0, 0.5, 1, 2, 5, 8, galaxy.AGE_REF]) {
			const histPres = evaluatePresence(hist, spanRef, age);
			const exactPres = exactPresence(births, count, age);
			const err = count > 0 ? Math.abs(histPres - exactPres) / count : 0;
			if (err > maxErr) maxErr = err;
		}
		if (maxErr > 0.0025) approxBreak = approxBreak || { type, maxErr };
		log.gasAccount[type] = { count, spanRef: +spanRef.toFixed(2),
			viewGasRef: +viewGasRef.toFixed(4), viewGas0: +viewGas0.toFixed(4), maxErr: +maxErr.toFixed(6) };
	}

	check('the birth histogram total equals the census count, every type',
		histBreak === null, histBreak);
	check('view gas is exact at both endpoints: gas(AGE_REF) ≈ gasFraction, gas(0) ≈ 1',
		endpointBreak === null, endpointBreak);
	check('view gas is monotonically decreasing with age, every type',
		monotoneBreak === null, monotoneBreak);
	check('the 1024-bin histogram matches the exact O(N) sum within 0.25% absolute',
		approxBreak === null, approxBreak);
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
logFile.writeLog(logPath, Object.assign(log, {
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
}), { indent: 1 });
if (failed > 0) process.exit(1);
