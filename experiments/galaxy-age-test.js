// experiments/galaxy-age-test.js
// Validates 0.3.3: the galaxy's age as a *generation* parameter. Nothing here
// animates — a model is a galaxy frozen at one cosmic epoch, and the epoch
// decides its star-formation history, the gas left in it, and therefore what
// its stars look like.
//
// Six things are checked, in order:
//   1. the star-formation history: draws follow the truncated delayed
//      exponential SFR ∝ t·exp(−t/τ), stay inside the span, and stop at the
//      quenching time for the types that have one
//   2. the formation windows: every component forms inside its own window, the
//      assembly order (halo first, thin disc still forming) survives at any
//      age, and at the reference age the windows reproduce the mean component
//      ages of the lognormal priors they replaced
//   3. the population: O/B falls with age, giants and the mean colour rise,
//      remnants accumulate (the intermediate-mass channel: a giant branch,
//      then a cooling white dwarf)
//   4. the gas law: mass-conserving, exact at the reference epoch, bounded,
//      flat after quenching — and `gasRich` follows the gas left, not the
//      present-day anchor
//   5. the objects: the gas-driven mix fades with age, and nothing is older
//      than its galaxy
//   6. the exposure renormalisation: the offset's sign and size are what keeps
//      the tuned exposure meaningful at every age
//
// Output: experiments/logs/galaxy-age.json

'use strict';

const fs = require('fs');
const path = require('path');

const density = require('../src/math/density.js');
const galaxy = require('../src/math/galaxy.js');
const hash = require('../src/math/hash.js');
const objects = require('../src/math/objects.js');
const sampling = require('../src/math/sampling.js');
const starTypes = require('../src/math/star-types.js');

const TYPES = galaxy.GALAXY_TYPES;
const MW = galaxy.MILKY_WAY;
const COMPONENT_NAMES = ['thin', 'thick', 'bulge', 'halo'];
const DRAW_SEED = 0x5EED17;
const SFH_DRAWS = 20000;
const STAR_DRAWS = 120000;
const OBJECT_DRAWS = 400;

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
	return !!pass;
}
function near(a, b, tol) {
	return Math.abs(a - b) <= tol;
}

// Deterministic uniforms: a test that redraws itself cannot be debugged.
function uniforms(n, salt) {
	const out = new Float64Array(n);
	for (let i = 0; i < n; i++) out[i] = hash.hash01At(DRAW_SEED + salt, i + 1);
	return out;
}

// The truncated delayed exponential's CDF on [0, span]: what a draw of t_f has
// to be distributed like. F is galaxy.sfhCumulative, the one function the CPU
// table, the windows and the shader's bisection all read.
function sfhCdf(model, t) {
	const p = model.populations;
	const xEnd = p.sfhSpan / p.tauSfh;
	return galaxy.sfhCumulative(Math.min(t, p.sfhSpan) / p.tauSfh) / galaxy.sfhCumulative(xEnd);
}

// Kolmogorov–Smirnov: the largest gap between the empirical and the analytic
// CDF. 20k draws put the noise floor of a correct sample near 0.007, so 0.02 is
// a real margin and still catches a wrong τ, a wrong truncation or a table that
// stopped tracking the model.
function ksStatistic(sorted, cdf) {
	let worst = 0;
	for (let i = 0; i < sorted.length; i++) {
		const below = i / sorted.length;
		const at = (i + 1) / sorted.length;
		const f = cdf(sorted[i]);
		worst = Math.max(worst, Math.abs(f - below), Math.abs(f - at));
	}
	return worst;
}

const log = { date: new Date().toISOString(), types: TYPES, sfh: {}, windows: {}, population: {}, gas: {}, objects: {} };

// --- 1. The star-formation history --------------------------------------
{
	const ages = [1, 5, 13.5];
	let worstKs = 0;
	let worstMeanRel = 0;
	let spanBreak = null;
	let quenchBreak = null;
	for (const type of TYPES) {
		log.sfh[type] = {};
		for (const age of ages) {
			const model = galaxy.createGalaxy({ type, seed: 42, age });
			const p = model.populations;
			const u = uniforms(SFH_DRAWS, TYPES.indexOf(type) * 10 + ages.indexOf(age));
			const t = new Float64Array(SFH_DRAWS);
			for (let i = 0; i < SFH_DRAWS; i++) {
				t[i] = starTypes.sfhFormationTime(model, u[i]);
				if (!(t[i] >= 0) || t[i] > p.sfhSpan + 1e-9) spanBreak = { type, age, t: t[i], span: p.sfhSpan };
				if (p.quenchTime > 0 && t[i] > p.quenchTime + 1e-9) quenchBreak = { type, age, t: t[i], tq: p.quenchTime };
			}
			const sorted = Float64Array.from(t).sort();
			const ks = ksStatistic(sorted, (v) => sfhCdf(model, v));
			// Analytic mean of the truncated law: integrating t²e^(−t/τ) by parts
			// gives τ²·[2 − e^(−X)(X² + 2X + 2)] over τ²·F(X), X = span/τ.
			const X = p.sfhSpan / p.tauSfh;
			const analytic = p.tauSfh * (2 - Math.exp(-X) * (X * X + 2 * X + 2)) / galaxy.sfhCumulative(X);
			let sum = 0;
			for (let i = 0; i < SFH_DRAWS; i++) sum += t[i];
			const mean = sum / SFH_DRAWS;
			worstKs = Math.max(worstKs, ks);
			worstMeanRel = Math.max(worstMeanRel, Math.abs(mean - analytic) / analytic);
			log.sfh[type][age] = {
				tau: +p.tauSfh.toFixed(3), span: +p.sfhSpan.toFixed(3), quenchTime: +p.quenchTime.toFixed(3),
				ks: +ks.toFixed(4), mean: +mean.toFixed(4), analyticMean: +analytic.toFixed(4),
			};
		}
	}
	check('every type at every age draws t_f from the truncated delayed exponential',
		worstKs < 0.02, { worstKs: +worstKs.toFixed(4), draws: SFH_DRAWS, floor: 0.007 });
	check('the drawn mean formation time is the analytic truncated mean',
		worstMeanRel < 0.02, { worstRelative: +worstMeanRel.toFixed(4) });
	check('no star forms before the galaxy or after its span', spanBreak === null, spanBreak);
	check('a quenched type never forms a star past 1.5τ', quenchBreak === null, quenchBreak);

	// The two ends of the sequence have to read as different galaxies: an E is a
	// burst that is over, an Irr is still going.
	const burst = galaxy.createGalaxy({ type: 'E4', age: 5 });
	const late = galaxy.createGalaxy({ type: 'Irr', age: 5 });
	const meanOf = (model) => {
		const u = uniforms(4000, 99);
		let sum = 0;
		for (let i = 0; i < u.length; i++) sum += starTypes.sfhFormationTime(model, u[i]);
		return sum / u.length;
	};
	check('an E4 at 5 Gyr is a finished burst, an Irr at 5 Gyr is still forming',
		burst.populations.sfhSpan === burst.populations.quenchTime
		&& meanOf(burst) < 0.4 && meanOf(late) > 2.0,
		{ E4Span: burst.populations.sfhSpan, E4Mean: +meanOf(burst).toFixed(3), IrrMean: +meanOf(late).toFixed(3) });
	check('the age is clamped to the model range, not to the slider',
		galaxy.createGalaxy({ type: 'Sc', age: 99 }).populations.age === galaxy.AGE_MAX
		&& galaxy.createGalaxy({ type: 'Sc', age: -3 }).populations.age === galaxy.AGE_MIN
		&& MW.populations.age === galaxy.AGE_REF,
		{ max: galaxy.AGE_MAX, min: galaxy.AGE_MIN, preset: MW.populations.age });
}

// --- 2. The formation windows -------------------------------------------
{
	// The inverse table interpolates linearly between its 1025 entries, so a draw
	// can land a hair outside its window: measured worst 1.9e-5 Gyr on the
	// preset's own draws and 1.1e-6 Gyr across the whole type grid. 1e-4 Gyr is
	// five times the worst excursion and a hundred thousand times below anything
	// the population reads.
	const WINDOW_TOL_GYR = 1e-4;
	// Positions are age-independent, so one sample serves every age — which is
	// also the claim the renderer's property-only regenerate makes.
	const positions = sampling.sampleGalaxyStars(MW, 42, STAR_DRAWS);
	const windowBreak = [];
	const fieldMeans = {};
	const starMeans = {};
	let counts = [0, 0, 0, 0];
	for (const age of [1, 5, 13.5]) {
		const model = galaxy.modelAtAge(MW, age);
		const p = model.populations;
		const sums = [0, 0, 0, 0];
		counts = [0, 0, 0, 0];
		const starSums = [0, 0, 0, 0];
		const u = uniforms(STAR_DRAWS, age * 7);
		const u2 = uniforms(STAR_DRAWS, age * 7 + 1);
		for (let i = 0; i < positions.count; i++) {
			const c = positions.component[i];
			const t = starTypes.sampleFormationTime(model, c, u[i]);
			const lo = galaxy.FORMATION_WINDOW[c * 2] * p.sfhSpan;
			const hi = galaxy.FORMATION_WINDOW[c * 2 + 1] * p.sfhSpan;
			if (t < lo - WINDOW_TOL_GYR || t > hi + WINDOW_TOL_GYR) windowBreak.push({ age, component: c, t, lo, hi });
			const starAge = p.age - t;
			if (!(starAge >= 0) || starAge > p.age + 1e-9) windowBreak.push({ age, component: c, starAge });
			sums[c] += starAge;
			counts[c]++;
			// The population the sky actually shows: the same clock, plus the
			// arm newborns the gate adds to the thin disc.
			starSums[c] += starTypes.sampleLocalAge(model, c, positions.distToArm[i], positions.R[i], u[i], u2[i]);
		}
		fieldMeans[age] = sums.map((s, c) => (counts[c] ? +(s / counts[c]).toFixed(3) : null));
		starMeans[age] = starSums.map((s, c) => (counts[c] ? +(s / counts[c]).toFixed(3) : null));
	}
	log.windows.fieldMeanAgeGyr = fieldMeans;
	log.windows.meanStarAgeGyr = starMeans;
	// How many stars each component actually contributes to a preset-sized
	// sample: the context the halo's tolerance above is set by.
	log.windows.componentCounts = COMPONENT_NAMES.map((name, c) => ({ component: name, stars: counts[c] }));
	check('every component forms inside its own window, and no star is older than its galaxy',
		windowBreak.length === 0, windowBreak.slice(0, 4));
	check('the assembly order survives: halo oldest, thin disc youngest',
		starMeans[13.5][3] > starMeans[13.5][2] && starMeans[13.5][2] > starMeans[13.5][1]
		&& starMeans[13.5][1] > starMeans[13.5][0], starMeans[13.5]);
	// A 1 Gyr galaxy has a 1 Gyr halo: the window scales with the clock, which is
	// what a fixed 12 Gyr halo prior could not do.
	check('at 1 Gyr even the halo is young, and the order still holds',
		starMeans[1][3] < 1 && starMeans[1][3] > starMeans[1][2] && starMeans[1][2] > starMeans[1][0],
		starMeans[1]);
	// The calibration the windows were fitted to: at the reference epoch they
	// reproduce the mean component ages of the lognormal priors they replaced
	// (thin 4.58, thick 8.36, bulge 10.10, halo ~12). The halo tolerance is wide
	// because the preset's halo is 34 stars in 120k — its mean is noise either
	// way, which is also why a 12 Gyr prior for it was never really a measurement.
	const priorMeans = [4.58, 8.36, 10.10, 12.0];
	const tolerances = [0.25, 0.25, 0.4, 1.0];
	check('at the reference age the windows reproduce the priors they replaced',
		priorMeans.every((prior, c) => near(starMeans[13.5][c], prior, tolerances[c])),
		{ now: starMeans[13.5], priors: priorMeans, tolerances });
	log.windows.formQ = TYPES.map((type) => {
		const m = galaxy.createGalaxy({ type });
		return { type, span: +m.populations.sfhSpan.toFixed(3), formQ: m.populations.formQ.map((v) => +v.toFixed(5)) };
	});
}

// --- 3. The population follows the clock --------------------------------
{
	const positions = sampling.sampleGalaxyStars(MW, 42, STAR_DRAWS);
	const ages = [0.5, 1, 2, 8, 13.5];
	const rec = {};
	const census = {};
	for (const age of ages) {
		const model = galaxy.modelAtAge(MW, age);
		let n = 0;
		let ob = 0;
		let giant = 0;
		let wd = 0;
		let young = 0;
		let colour = 0;
		let lum = 0;
		for (let i = 0; i < positions.count; i++) {
			if (positions.component[i] !== density.COMPONENT_THIN) continue;
			starTypes.deriveStar(model, starTypes.fieldStarSeed(42, i), positions.component[i],
				positions.R[i], positions.distToArm[i], rec);
			n++;
			if (rec.spectralClass === 'O' || rec.spectralClass === 'B') ob++;
			if (rec.state === 'giant') giant++;
			if (rec.state === 'wd') wd++;
			if (rec.age < 0.3) young++;
			colour += rec.colorIndex;
			lum += rec.luminosity;
		}
		census[age] = {
			n,
			obPct: +(100 * ob / n).toFixed(3), giantPct: +(100 * giant / n).toFixed(3),
			wdPct: +(100 * wd / n).toFixed(3), youngPct: +(100 * young / n).toFixed(2),
			meanColour: +(colour / n).toFixed(4), meanLuminosity: +(lum / n).toFixed(2),
		};
	}
	log.population.thinDisc = census;
	check('the thin disc loses its O/B stars as the galaxy ages',
		census[1].obPct >= 0.5 && census[13.5].obPct <= 0.25
		&& census[0.5].obPct > census[2].obPct && census[2].obPct > census[8].obPct
		&& census[8].obPct >= census[13.5].obPct,
		{ at1Gyr: census[1].obPct, at13_5: census[13.5].obPct });
	check('the giant fraction rises monotonically, and by more than 5× over the range',
		census[0.5].giantPct < census[1].giantPct && census[1].giantPct < census[2].giantPct
		&& census[2].giantPct < census[8].giantPct && census[8].giantPct < census[13.5].giantPct
		&& census[13.5].giantPct > 5 * census[0.5].giantPct,
		{ young: census[0.5].giantPct, old: census[13.5].giantPct });
	check('the mean colour index reddens with age',
		census[0.5].meanColour < census[2].meanColour && census[2].meanColour < census[8].meanColour
		&& census[8].meanColour <= census[13.5].meanColour,
		{ young: census[0.5].meanColour, old: census[13.5].meanColour });
	// The intermediate-mass channel (0.4.5): below 8 M☉ a star is a giant for
	// a slice of its main-sequence life and a cooling white dwarf after, so
	// the remnant fraction accumulates across the galaxy's life instead of
	// saturating below 1 Gyr — 0.25% at 0.5 Gyr, 1.77% at 13.5.
	check('the remnant fraction rises with age and accumulates past 1 Gyr',
		census[0.5].wdPct <= census[1].wdPct && census[1].wdPct < census[2].wdPct
		&& census[2].wdPct < census[8].wdPct && census[8].wdPct < census[13.5].wdPct
		&& census[13.5].wdPct > 1,
		{ at0_5: census[0.5].wdPct, at1: census[1].wdPct, at13_5: census[13.5].wdPct });
	// The old star-forming field is the brighter one: it keeps forming O/B
	// stars at a similar rate (the delayed exponential is flat between 0.5
	// and 13.5 Gyr) and adds the turnoff giants on top, 2.42× in the mean.
	// Before the giant branch became temporary this ratio was 11×, driven by
	// a 3% permanent-giant tail; the exposure offset absorbs either number.
	check('the field brightens as turnoff giants join the still-forming OB tail (~2.4×)',
		census[13.5].meanLuminosity > 2 * census[0.5].meanLuminosity
		&& census[13.5].meanLuminosity < 3 * census[0.5].meanLuminosity
		&& census[0.5].meanLuminosity < census[2].meanLuminosity
		&& census[2].meanLuminosity < census[13.5].meanLuminosity,
		{ young: census[0.5].meanLuminosity, old: census[13.5].meanLuminosity });

	// A quenched type at the reference epoch is a red spheroid with nothing young
	// in it at all; the same type mid-burst is the blue E the age parameter is for.
	const e4Old = galaxy.createGalaxy({ type: 'E4', seed: 42 });
	const e4Young = galaxy.modelAtAge(e4Old, 0.5);
	const e4Positions = sampling.sampleGalaxyStars(e4Old, 42, 40000);
	const spheroidCensus = (model) => {
		let n = 0;
		let ob = 0;
		let giant = 0;
		let oldest = 0;
		let youngest = Infinity;
		for (let i = 0; i < e4Positions.count; i++) {
			starTypes.deriveStar(model, starTypes.fieldStarSeed(42, i), e4Positions.component[i],
				e4Positions.R[i], e4Positions.distToArm[i], rec);
			n++;
			if (rec.spectralClass === 'O' || rec.spectralClass === 'B') ob++;
			if (rec.state === 'giant') giant++;
			oldest = Math.max(oldest, rec.age);
			youngest = Math.min(youngest, rec.age);
		}
		return { n, obPct: +(100 * ob / n).toFixed(3), giantPct: +(100 * giant / n).toFixed(3),
			youngest: +youngest.toFixed(3), oldest: +oldest.toFixed(3) };
	};
	const oldCensus = spheroidCensus(e4Old);
	const youngCensus = spheroidCensus(e4Young);
	log.population.E4 = { at13_5: oldCensus, at0_5: youngCensus };
	check('an E4 at 13.5 Gyr is dead: no O/B, every star as old as the burst',
		oldCensus.obPct === 0 && oldCensus.youngest > 12.8 && oldCensus.oldest <= 13.5, oldCensus);
	check('the same E4 at 0.5 Gyr is mid-burst and blue',
		youngCensus.obPct > 0.2 && youngCensus.oldest <= 0.5 + 1e-9
		&& youngCensus.obPct > oldCensus.obPct, youngCensus);
}

// --- 4. The gas the SFH has not consumed --------------------------------
{
	const ages = [0.5, 1, 2, 5, 8, 13.5];
	let refBreak = null;
	let boundBreak = null;
	let monotoneBreak = null;
	let quenchDrift = null;
	let gasRichBreak = null;
	for (const type of TYPES) {
		const gases = ages.map((age) => galaxy.createGalaxy({ type, seed: 42, age }).populations);
		log.gas[type] = { gasFraction: gases[0].gasFraction, tau: gases[0].tauSfh,
			quenchTime: gases[0].quenchTime, gasNow: gases.map((p) => +p.gasNow.toFixed(4)) };
		for (let i = 0; i < ages.length; i++) {
			const p = gases[i];
			if (ages[i] === galaxy.AGE_REF && p.gasNow !== p.gasFraction) refBreak = { type, gasNow: p.gasNow, anchor: p.gasFraction };
			if (!(p.gasNow <= 1 + 1e-12) || p.gasNow < p.gasFraction - 1e-12) boundBreak = { type, age: ages[i], gasNow: p.gasNow };
			if (i > 0 && p.gasNow > gases[i - 1].gasNow + 1e-12) monotoneBreak = { type, age: ages[i], gasNow: p.gasNow, previous: gases[i - 1].gasNow };
			if (p.gasRich !== (p.gasNow >= galaxy.GAS_RICH_MIN)) gasRichBreak = { type, age: ages[i], gasNow: p.gasNow, gasRich: p.gasRich };
			// Past the quenching time the reservoir is what it is: no more stars,
			// so no more gas consumed, so no drift.
			if (p.quenchTime > 0 && ages[i] >= p.quenchTime
				&& Math.abs(p.gasNow - gases[ages.length - 1].gasNow) > 1e-12) {
				quenchDrift = { type, age: ages[i], gasNow: p.gasNow, final: gases[ages.length - 1].gasNow };
			}
		}
	}
	check('the gas law lands exactly on the observed anchor at the reference epoch', refBreak === null, refBreak);
	check('gas left is bounded: never above 1, never below the anchor', boundBreak === null, boundBreak);
	check('gas falls monotonically with age in every type', monotoneBreak === null, monotoneBreak);
	check('a quenched type stops consuming gas at its quenching time', quenchDrift === null, quenchDrift);
	check('gasRich is solved from the gas left, not from the anchor', gasRichBreak === null, gasRichBreak);

	// The two claims that make the law worth having against a plain exponential:
	// an S0 is gas-rich mid-formation and dead today, and an E4 mid-burst still
	// has most of its reservoir.
	const s0Young = galaxy.createGalaxy({ type: 'S0', age: 0.5 });
	const s0Old = galaxy.createGalaxy({ type: 'S0', age: galaxy.AGE_REF });
	const e4 = galaxy.createGalaxy({ type: 'E4', age: 0.5 });
	check('an S0 at 0.5 Gyr is star-forming and gas-rich; at 13.5 Gyr it is a quenched residual',
		s0Young.populations.gasRich === true && s0Young.populations.gasNow > 0.5
		&& s0Old.populations.gasRich === false && s0Old.populations.gasNow === s0Old.populations.gasFraction,
		{ young: +s0Young.populations.gasNow.toFixed(3), old: s0Old.populations.gasNow });
	check('an E4 mid-burst has burned only part of its reservoir',
		e4.populations.gasNow > 0.1 && e4.populations.gasNow < 0.5, +e4.populations.gasNow.toFixed(4));
	check('a late type keeps most of its gas at every age the model allows',
		[0.5, 5, 13.5].every((age) => galaxy.createGalaxy({ type: 'Irr', age }).populations.gasNow >= 0.5),
		log.gas.Irr.gasNow);
}

// --- 5. The objects follow the gas --------------------------------------
{
	const ages = [0.5, 2, 8, 13.5];
	for (const type of ['SBb', 'Sc', 'E4']) {
		const base = galaxy.createGalaxy({ type, seed: 42 });
		const mixes = {};
		let ageBreak = null;
		for (const age of ages) {
			const model = galaxy.modelAtAge(base, age);
			const placed = objects.placeObjects(model, 42 ^ 0x0B5E55, OBJECT_DRAWS, null);
			const byType = {};
			for (const o of placed) {
				byType[o.type] = (byType[o.type] || 0) + 1;
				if (o.ageGyr > model.populations.age + 1e-9) ageBreak = { type, age, object: o.type, ageGyr: o.ageGyr };
			}
			mixes[age] = { placed: placed.length, byType };
		}
		log.objects[type] = mixes;
		check(`${type}: the gas-driven object counts fall as the gas is used up`,
			(mixes[0.5].byType.HII || 0) + (mixes[0.5].byType.open || 0)
				> (mixes[13.5].byType.HII || 0) + (mixes[13.5].byType.open || 0)
			&& (mixes[0.5].byType.HII || 0) >= (mixes[2].byType.HII || 0)
			&& (mixes[2].byType.HII || 0) >= (mixes[8].byType.HII || 0),
			{ at0_5: mixes[0.5].byType, at13_5: mixes[13.5].byType });
		check(`${type}: no object is older than its galaxy`, ageBreak === null, ageBreak);
		// The old populations move the other way: a globular cluster needs time,
		// so a young galaxy has few and an old one has its full share.
		if (type !== 'E4') {
			check(`${type}: globular clusters need time, so they accumulate with age`,
				(mixes[13.5].byType.globular || 0) > (mixes[0.5].byType.globular || 0),
				{ at0_5: mixes[0.5].byType.globular || 0, at13_5: mixes[13.5].byType.globular || 0 });
		}
	}
	// The clamp, on the object that needs it: a 1 Gyr galaxy has had no time to
	// make a 13 Gyr globular, and its members are coeval with it.
	const young = galaxy.createGalaxy({ type: 'SBb', seed: 42, age: 1 });
	const placed = objects.placeObjects(young, 42 ^ 0x0B5E55, OBJECT_DRAWS, null);
	const oldest = placed.reduce((a, o) => Math.max(a, o.ageGyr), 0);
	check('a 1 Gyr galaxy has no 10 Gyr globular in it', oldest <= 1 && placed.some((o) => o.type === 'globular'),
		{ oldestObjectGyr: +oldest.toFixed(3), globulars: placed.filter((o) => o.type === 'globular').length });
}

// --- 6. The exposure renormalisation ------------------------------------
{
	const CALIBRATION_STARS = 16384;
	const positions = sampling.sampleGalaxyStars(MW, 42, STAR_DRAWS);
	let worst = 0;
	let refBreak = null;
	const offsets = {};
	log.population.exposure = {};
	for (const type of ['E4', 'Sa', 'SBb', 'Sc', 'Irr']) {
		const base = galaxy.createGalaxy({ type, seed: 42 });
		const field = sampling.sampleGalaxyStars(base, 42, STAR_DRAWS);
		const ref = starTypes.meanFieldLuminosity(galaxy.modelAtAge(base, galaxy.AGE_REF), field, CALIBRATION_STARS);
		offsets[type] = {};
		for (const age of [0.5, 2, 8, galaxy.AGE_REF]) {
			const model = galaxy.modelAtAge(base, age);
			const now = starTypes.meanFieldLuminosity(model, field, CALIBRATION_STARS);
			// The renderer's arithmetic, in full: an offset in magnitudes, added to
			// absMag before packing. A dimmer field gets a negative offset, which
			// brightens it back; a brighter young field gets a positive one.
			const offset = (now > 0 && ref > 0) ? 2.5 * Math.log10(now / ref) : 0;
			const renormalised = now * Math.pow(10, -offset / 2.5);
			worst = Math.max(worst, Math.abs(renormalised / ref - 1));
			if (age === galaxy.AGE_REF && offset !== 0) refBreak = { type, offset };
			offsets[type][age] = offset;
			log.population.exposure[`${type}@${age}`] = { meanL: +now.toFixed(3), referenceL: +ref.toFixed(3), magOffset: +offset.toFixed(4) };
		}
	}
	check('the renormalised field brightness matches the reference at every age',
		worst < 0.01, { worstRelative: +worst.toExponential(2) });
	check('the offset is exactly 0 at the reference age, every type',
		refBreak === null, refBreak);
	// A quenched E4 peaks after its burst: dimmer than the reference before
	// its giants arrive (nothing older than 0.5 Gyr has left the main
	// sequence), brighter at the 2 Gyr giant bump, then fading toward the
	// old red reference. Star-forming types keep making giants, so they never
	// show a bump of this size; the later-type check below is the bound.
	check('a quenched E4 is dimmer pre-bump, brighter at the bump, fading after',
		offsets.E4[0.5] < -1 && offsets.E4[2] > 0.3
		&& offsets.E4[8] > 0 && offsets.E4[8] < offsets.E4[2],
		{ at0_5: +offsets.E4[0.5].toFixed(3), at2: +offsets.E4[2].toFixed(3), at8: +offsets.E4[8].toFixed(3) });
	// Sa is the transition type: bulge-heavy and early-fading, dimmer than the
	// reference before 8 Gyr and within 0.15 mag of it there. (0.4.8 M3.3 moved
	// the 8 Gyr point from +0.06 to about −0.08: the reference field lost its
	// high-z young stars, so the late climb no longer clears it.)
	check('Sa peaks late: dimmer young, within 0.15 mag of the reference at 8 Gyr',
		offsets.Sa[0.5] < offsets.Sa[2] && offsets.Sa[2] < 0 && Math.abs(offsets.Sa[8]) < 0.15,
		{ at0_5: +offsets.Sa[0.5].toFixed(3), at2: +offsets.Sa[2].toFixed(3), at8: +offsets.Sa[8].toFixed(3) });
	// Later types keep forming giants, so they never show the quenched bump
	// (E4 at 2 Gyr is +0.5 mag). They are dim before any giant has left the
	// main sequence, and back under the reference once the disc is old. A 2 Gyr
	// Sc can sit ~0.14 mag above its reference: M3.3's heating floor removes
	// the reference age's high-z O/B stars, and the arriving giants briefly
	// outshine what is left. That is a bump, not the quenched one.
	let sfBreak = null;
	for (const type of ['SBb', 'Sc', 'Irr']) {
		const young = offsets[type][0.5];
		const bump = offsets[type][2];
		const old = offsets[type][8];
		if (!(young < -0.5 && bump < 0.25 && old < 0.1)) {
			sfBreak = sfBreak || { type, at0_5: young, at2: bump, at8: old };
		}
	}
	check('later star-forming types stay dim young and never show the quenched giant bump',
		sfBreak === null, sfBreak);
	// The offset is a property of the population, so a preset at the reference
	// epoch keeps the sky 0.3.2 tuned: same positions, same exposure defaults.
	check('the preset at the default age needs no offset at all',
		starTypes.meanFieldLuminosity(MW, positions, CALIBRATION_STARS)
			=== starTypes.meanFieldLuminosity(galaxy.modelAtAge(MW, galaxy.AGE_REF), positions, CALIBRATION_STARS),
		+starTypes.meanFieldLuminosity(MW, positions, CALIBRATION_STARS).toFixed(4));
}

// --- Report -------------------------------------------------------------
let passed = 0;
let failed = 0;
for (const c of checks) {
	if (c.pass) passed++; else failed++;
	console.log(`  ${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.pass ? '' : `  -> ${JSON.stringify(c.detail)}`}`);
}
console.log(`\n${passed}/${checks.length} passed, ${failed} failed`);

const logPath = path.join(__dirname, 'logs', 'galaxy-age.json');
fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.writeFileSync(logPath, JSON.stringify(Object.assign(log, {
	ageRange: [galaxy.AGE_MIN, galaxy.AGE_MAX],
	ageRef: galaxy.AGE_REF,
	formationWindow: galaxy.FORMATION_WINDOW,
	tauSfh: TYPES.map((type) => galaxy.createGalaxy({ type }).populations.tauSfh),
	totalChecks: checks.length,
	passed,
	failed,
	checks,
}), null, 2));
console.log(`Wrote ${logPath}`);
console.log('\n=== VERDICT ===');
console.log(failed === 0
	? 'PASS — the galaxy age drives the population, the gas and the exposure'
	: `FAIL — ${failed} checks failed`);
process.exit(failed === 0 ? 0 : 1);
