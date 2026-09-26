// experiments/star-types-evolution-test.js
// Derives stellar populations on top of sampled positions and checks that the
// types land where stellar evolution says they should:
//
//   - O/B stars only exist near spiral arms (they die before they drift)
//   - red giants and white dwarfs favour old populations (bulge, halo, thick)
//   - M dwarfs dominate the census and are found everywhere
//   - metallicity follows the component, halo being the most metal poor
//   - the IMF reproduces Salpeter, and the mass -> Teff -> class chain is sane
//
// Output: experiments/logs/star-types-evolution.json

'use strict';

const fs = require('fs');
const path = require('path');
const density = require('../src/math/density.js');
const hash = require('../src/math/hash.js');
const sampling = require('../src/math/sampling.js');
const starTypes = require('../src/math/star-types.js');

const galaxy = require('../src/math/galaxy.js');
const records = require('../src/math/star-record.js');
const model = galaxy.MILKY_WAY;

const SEED = 7;
const N_STARS = 200000;

const checks = [];
// Filled by the age-census section: the same sample re-derived at three epochs.
let ageCensus = null;
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
	return !!pass;
}

console.log(`Sampling ${N_STARS.toLocaleString()} stars and deriving types...`);
const t0 = Date.now();
const buf = sampling.sampleGalaxyStars(model, SEED, N_STARS);
const sampleMs = Date.now() - t0;

const stars = [];
const shared = {};
for (let i = 0; i < buf.count; i++) {
	const star = starTypes.deriveStar(model, 
		SEED * 31 + i + 1, buf.component[i], buf.R[i], buf.distToArm[i], shared);
	star.x = buf.x[i];
	star.y = buf.y[i];
	star.z = buf.z[i];
	star.distToArm = buf.distToArm[i];
	star.R = buf.R[i];
	star.componentName = density.COMPONENT_NAMES[buf.component[i]];
	stars.push(Object.assign({}, star));
}
const deriveMs = Date.now() - t0 - sampleMs;
console.log(`  sampled in ${sampleMs} ms, derived in ${deriveMs} ms`);
check('deriveStar fills every record without allocating', shared.spectralClass !== undefined,
	{ class: shared.spectralClass, feed: stars.length });

const summary = starTypes.summariseByComponent(stars);
const classes = summary.byClass;
const armStats = starTypes.classVsArmDistance(stars, model);

// --- Type mix ------------------------------------------------------------
{
	const total = stars.length;
	check('every star carries a spectral class', stars.every(s => stars.length && s.spectralClass), classes);
	check('M dwarfs dominate the census', classes.M / total > 0.4, classes.M / total);
	const hot = (classes.O || 0) + (classes.B || 0);
	check('hot stars are rare (O+B below 3% of the census)', hot / total < 0.03, hot / total);
	check('giants and white dwarfs are both present',
		classes.RG > 0 && classes.WD > 0, { RG: classes.RG, WD: classes.WD });
	// The thin-disc age model is bimodal (a small young arm population in an
	// otherwise ~5 Gyr field), so O stars are genuinely ~1 per 100k draws. At
	// least seven classes must appear; all nine if the sample is big enough.
	check('the census spans at least seven spectral classes',
		Object.keys(classes).length >= 7, Object.keys(classes));
	check('O stars, when present, are a handful', (classes.O || 0) < total * 0.001, classes.O || 0);
}

// --- O/B stars hug the arms ---------------------------------------------
{
	// The comparison is made in the model's own lane (density.armRidgeWidth, see
	// classVsArmDistance), not against a fixed distance: on this sample a 0.5 kpc
	// cut reads O/B 0.78 against M dwarfs 0.49 — a factor 1.6 — because half a
	// kpc is most of the lane at R = 3 and a fifth of it at R = 8. Against their
	// own lane the same stars read 0.70 against 0.23, and being in the lane at
	// all is what makes an O star an O star. Field classes are compared by M and
	// B: O is a three-star sample at this size, so its own statistics are noise.
	const ob = armStats.O.n + armStats.B.n;
	const obInLane = (armStats.O.fracInLane * armStats.O.n + armStats.B.fracInLane * armStats.B.n) / Math.max(1, ob);
	check('O/B stars sit inside the arm lane far more often than M dwarfs',
		ob > 100 && obInLane > 2.5 * armStats.M.fracInLane,
		{ obInLane: +obInLane.toFixed(4), M: +armStats.M.fracInLane.toFixed(4), n: ob });
	check('O/B stars are born in the lane: mean ridge distance under 1 sigma',
		armStats.B.meanZ < 1 && armStats.M.meanZ > 2 * armStats.B.meanZ,
		{ B: +armStats.B.meanZ.toFixed(3), M: +armStats.M.meanZ.toFixed(3) });
	// What makes the lane a lane: it is 2*sigma wide out of a ridge spacing
	// lambda, so a population that ignores the arms lands inside it by area —
	// 2*sigma/lambda = 2*0.12/(1+amp) = 0.2 for the preset, a little higher in
	// practice because the disc's own azimuthal modulation already leans on the
	// arms. A population born in it lands there ~0.68 of the time (the half-normal
	// inside one sigma), which is the gap the two checks above measure.
	check('M dwarfs meet the lane at the area rate, O/B at the born rate',
		armStats.M.fracInLane > 0.15 && armStats.M.fracInLane < 0.35
		&& obInLane > 0.6 && obInLane < 0.8,
		{ M: +armStats.M.fracInLane.toFixed(4), obInLane: +obInLane.toFixed(4), areaRate: 0.24 / (1 + model.arms.amp) });
	check('hot stars exist at all in the sample', ob > 5, ob);
}

// --- The young ridge is a half-normal in the model's own arm width --------
{
	// The arm-young branch is the gate exp(-z^2/2) with z = distToArm /
	// density.armRidgeWidth(model, R), so whatever the type, the young
	// population's z is a half-normal: median 0.6745, 68% inside 1 sigma, 95%
	// inside 2. The width is the pattern's own (pitch, arm number, contrast), so
	// a star's chance of being born young follows the model rather than a
	// distance tuned for the Milky Way.
	//
	// "Young" is no longer "born in an arm": since 0.3.3 the field keeps forming
	// stars throughout the galaxy's life, so an age cut would mix in field stars
	// that never went near a ridge and flatten the half-normal. The branch is
	// identified exactly instead, by recomputing what it returns —
	// min(age, u1^3 * YOUNG_ARM_MAX_GYR) from the star's own hash channel — and
	// comparing bit-for-bit. What the check then measures is the gate's shape:
	// that the stars it accepted are distributed in z as exp(-z^2/2) says.
	const ridge = (type) => {
		const m = galaxy.createGalaxy({ type });
		const buf2 = sampling.sampleGalaxyStars(m, 4242, 200000);
		const shared2 = {};
		const z = [];
		for (let i = 0; i < buf2.count; i++) {
			if (buf2.component[i] !== density.COMPONENT_THIN) continue;
			const R = buf2.R[i];
			if (R < m.arms.Rs || R > m.populations.youngOuterR) continue;
			const deriveSeed = 4242 * 31 + i + 1;
			const s = starTypes.deriveStar(m, deriveSeed, buf2.component[i], R, buf2.distToArm[i], shared2);
			const armAge = Math.min(m.populations.age,
				Math.pow(hash.hash01(deriveSeed * 31 + 2), 3.0) * starTypes.YOUNG_ARM_MAX_GYR);
			if (s.age === armAge) z.push(buf2.distToArm[i] / density.armRidgeWidth(m, R));
		}
		z.sort((a, b) => a - b);
		const cdf = (t) => z.filter((v) => v < t).length / Math.max(1, z.length);
		return { n: z.length, median: z[z.length >> 1], p1: cdf(1), p2: cdf(2) };
	};
	for (const type of ['Sa', 'Sc']) {
		const st = ridge(type);
		check(`${type}: the arm-young population is a half-normal in the model's ridge width`,
			st.n > 400 && Math.abs(st.median - 0.6745) < 0.05
			&& Math.abs(st.p1 - 0.6827) < 0.02 && Math.abs(st.p2 - 0.9545) < 0.02,
			{ n: st.n, median: +st.median.toFixed(3), p1: +st.p1.toFixed(4), p2: +st.p2.toFixed(4) });
	}
	const sa = galaxy.createGalaxy({ type: 'Sa' });
	const sd = galaxy.createGalaxy({ type: 'Sd' });
	check('the ridge width is the pattern\'s, not a constant (Sa is tighter than Sd at one radius)',
		density.armRidgeWidth(sa, 8) < 0.8 * density.armRidgeWidth(sd, 8),
		{ Sa: +density.armRidgeWidth(sa, 8).toFixed(3), Sd: +density.armRidgeWidth(sd, 8).toFixed(3) });
	check('the ridge widens outward, in proportion to the radius',
		Math.abs(density.armRidgeWidth(sa, 8) - 2 * density.armRidgeWidth(sa, 4)) < 1e-12,
		{ at4: +density.armRidgeWidth(sa, 4).toFixed(4), at8: +density.armRidgeWidth(sa, 8).toFixed(4) });
}

// --- Age and metallicity by component -----------------------------------
{
	const meanByComp = {};
	const metalByComp = {};
	for (const s of stars) {
		const name = s.componentName;
		if (!meanByComp[name]) { meanByComp[name] = { age: 0, metal: 0, n: 0 }; }
		meanByComp[name].age += s.age;
		meanByComp[name].metal += s.metallicity;
		meanByComp[name].n++;
	}
	for (const name of Object.keys(meanByComp)) {
		meanByComp[name].age /= meanByComp[name].n;
		meanByComp[name].metal /= meanByComp[name].n;
		metalByComp[name] = +meanByComp[name].metal.toFixed(5);
	}
	check('the thin disc is the youngest population',
		meanByComp.thin.age < meanByComp.thick.age && meanByComp.thin.age < meanByComp.bulge.age,
		{ thin: +meanByComp.thin.age.toFixed(2), thick: +meanByComp.thick.age.toFixed(2), bulge: +meanByComp.bulge.age.toFixed(2) });
	check('the halo is old (> 8 Gyr on average)', meanByComp.halo.age > 8, +meanByComp.halo.age.toFixed(2));
	check('the bulge is the most metal rich population',
		metalByComp.bulge > metalByComp.thin && metalByComp.bulge > metalByComp.halo, metalByComp);
	check('the halo is the most metal poor population',
		metalByComp.halo < metalByComp.thick && metalByComp.halo < metalByComp.thin, metalByComp);
	check('giants are older on average than the main sequence',
		(() => {
			let giantAge = 0, giantN = 0, msAge = 0, msN = 0;
			for (const s of stars) {
				if (s.state === 'giant') { giantAge += s.age; giantN++; }
				else if (s.state === 'ms') { msAge += s.age; msN++; }
			}
			return giantN > 0 && msN > 0 && giantAge / giantN > msAge / msN;
		})());
}

// --- The same census across the galaxy's clock --------------------------
{
	// Everything above is one epoch: the default age. 0.3.3 made the age a
	// generation parameter, so the class mix has to move with it *per component*
	// — the windows in galaxy.js decide when each component formed, and this is
	// where that meets the IMF and the lifetimes. Positions are age-independent,
	// so one sample serves every age (the renderer's property-only regenerate
	// makes the same claim).
	const AGES = [1, 5, galaxy.AGE_REF];
	const pos = sampling.sampleGalaxyStars(model, SEED, 60000);
	const shared3 = {};
	const census = {};
	for (const age of AGES) {
		const m = galaxy.modelAtAge(model, age);
		const per = {};
		for (const name of density.COMPONENT_NAMES) per[name] = { n: 0, ob: 0, giant: 0, wd: 0, ageSum: 0, oldest: 0 };
		for (let i = 0; i < pos.count; i++) {
			const c = pos.component[i];
			const s = starTypes.deriveStar(m, starTypes.fieldStarSeed(SEED, i), c, pos.R[i], pos.distToArm[i], shared3);
			const b = per[density.COMPONENT_NAMES[c]];
			b.n++;
			b.ageSum += s.age;
			if (s.age > b.oldest) b.oldest = s.age;
			if (s.spectralClass === 'O' || s.spectralClass === 'B') b.ob++;
			if (s.state === 'giant') b.giant++;
			if (s.state === 'wd') b.wd++;
		}
		census[age] = {};
		for (const name of Object.keys(per)) {
			const b = per[name];
			census[age][name] = {
				n: b.n, meanAge: b.n ? +(b.ageSum / b.n).toFixed(3) : null, oldest: +b.oldest.toFixed(3),
				obPct: b.n ? +(100 * b.ob / b.n).toFixed(3) : null,
				giantPct: b.n ? +(100 * b.giant / b.n).toFixed(3) : null,
				wdPct: b.n ? +(100 * b.wd / b.n).toFixed(3) : null,
			};
		}
	}
	ageCensus = census;

	check('no star in any component is older than the galaxy it is in',
		AGES.every((age) => density.COMPONENT_NAMES
			.every((name) => census[age][name].oldest <= age + 1e-9)),
		AGES.map((age) => ({ age, oldest: Math.max(...density.COMPONENT_NAMES.map((n) => census[age][n].oldest)) })));
	check('the assembly order holds at every age, not just at the reference one',
		AGES.every((age) => census[age].halo.meanAge > census[age].bulge.meanAge
			&& census[age].bulge.meanAge > census[age].thick.meanAge
			&& census[age].thick.meanAge > census[age].thin.meanAge),
		AGES.map((age) => census[age].halo.meanAge));
	check('giants are a rising share of every component big enough to measure',
		density.COMPONENT_NAMES.filter((name) => census[galaxy.AGE_REF][name].n >= 500)
			.every((name) => census[1][name].giantPct < census[5][name].giantPct
				&& census[5][name].giantPct < census[galaxy.AGE_REF][name].giantPct),
		{ thin: census[galaxy.AGE_REF].thin.giantPct, haloStars: census[galaxy.AGE_REF].halo.n });
	// A hot star needs a main-sequence star above ~3 M☉ (Teff 12000 K, tMS
	// 0.64 Gyr), so an age under ~0.7 Gyr. At the reference epoch only the thin
	// disc is still forming, so that is where every hot star is. A younger galaxy
	// has hot stars in whichever component was forming then: the spheroid's
	// window closes at 0.45 of the span, so a 1 Gyr bulge still holds a few 3 M☉
	// stragglers and a 5 Gyr one holds none.
	check('the disc that is still forming holds the largest hot-star share at every age',
		AGES.every((age) => census[age].thin.obPct > census[age].thick.obPct
			&& census[age].thin.obPct > census[age].bulge.obPct
			&& census[age].thin.obPct > 0),
		AGES.map((age) => ({ age, thin: census[age].thin.obPct, bulge: census[age].bulge.obPct })));
	check('at the reference age no hot star exists outside the thin disc',
		census[galaxy.AGE_REF].thick.obPct === 0 && census[galaxy.AGE_REF].bulge.obPct === 0
		&& census[galaxy.AGE_REF].halo.obPct === 0,
		census[galaxy.AGE_REF]);
	check('the spheroid stops making hot stars once its formation window has closed',
		census[1].bulge.obPct > 0 && census[5].bulge.obPct === 0,
		{ at1Gyr: census[1].bulge.obPct, at5Gyr: census[5].bulge.obPct });
	check('a young galaxy is a blue galaxy: the disc is hotter at 1 Gyr than at 13.5',
		census[1].thin.obPct > 2 * census[galaxy.AGE_REF].thin.obPct
		&& census[1].thin.giantPct < census[galaxy.AGE_REF].thin.giantPct,
		{ obAt1: census[1].thin.obPct, obAt13_5: census[galaxy.AGE_REF].thin.obPct });
}

// --- Radial metallicity gradient ----------------------------------------
{
	const sc = galaxy.createGalaxy({ type: 'Sc', seed: 7 });
	const e4 = galaxy.createGalaxy({ type: 'E4', seed: 7 });
	// Mean colour index of main-sequence thin-disc stars at a fixed radius.
	const msMean = (m, R, n) => {
		let sum = 0;
		let count = 0;
		for (let i = 1; i <= n; i++) {
			const s = starTypes.deriveStar(m, i * 7919 + 1, density.COMPONENT_THIN, R, 2.0, {});
			if (s.state !== 'ms') continue;
			sum += s.colorIndex;
			count++;
		}
		return sum / count;
	};
	const L = sc.thin.L;
	// IMF is ~87% M, so an all-MS mean barely moves. Restrict to stars that
	// still have a step left (colourIndex < M) at the inner radius; those
	// pick up +1 by R = 2L when steep = 1.
	const msMeanSubM = (m, R, n) => {
		let sum = 0;
		let count = 0;
		for (let i = 1; i <= n; i++) {
			const s = starTypes.deriveStar(m, i * 7919 + 1, density.COMPONENT_THIN, R, 2.0, {});
			if (s.state !== 'ms' || s.colorIndex >= 6) continue;
			sum += s.colorIndex;
			count++;
		}
		return count ? sum / count : 0;
	};
	const inner = msMeanSubM(sc, L * 0.5, 8000);
	const outer = msMean(sc, L * 2.5, 8000);
	check('Sc: sub-M thin-disc stars redden by ~1 step from 0.5L to 2.5L',
		outer - inner > 0.5, { inner: +inner.toFixed(3), outer: +outer.toFixed(3) });
	const eInner = msMean(e4, L * 0.5, 4000);
	const eOuter = msMean(e4, L * 2.5, 4000);
	check('E4: the gradient is flat (no shift at any radius)',
		Math.abs(eInner - eOuter) < 1e-12, { inner: eInner, outer: eOuter });
	// Metal-poor spheroid giants: exactly 20% (the uEvolve roll) land one LUT
	// step redder than RG, in the dedicated RGe slot. 200k draws, because
	// bulge giants are a ~0.15% turnoff shell now, not a 3% tail — 300 of
	// them pin the share to 0.21 ± sampling noise.
	let giants = 0;
	let rgReddened = 0;
	for (let i = 1; i <= 200000; i++) {
		const s = starTypes.deriveStar(model, i * 7919 + 1, density.COMPONENT_BULGE, 1.0, 5.0, {});
		if (s.state !== 'giant') continue;
		giants++;
		if (s.colorIndex === records.SPECTRAL_CLASSES.length - 1) rgReddened++;
	}
	check('20% of spheroid giants shift one LUT step redder (the RGe slot)',
		giants > 100 && Math.abs(rgReddened / giants - 0.2) < 0.03,
		{ giants, share: +(rgReddened / giants).toFixed(3) });
}

// --- IMF ----------------------------------------------------------------
{
	const masses = stars.map(s => s.mass).sort((a, b) => a - b);
	check('masses stay inside the IMF support',
		masses[0] >= 0.08 && masses[masses.length - 1] <= 100.0,
		{ min: masses[0], max: masses[masses.length - 1] });
	// Salpeter slope from a histogram of log M.
	const bins = 12;
	const lo = Math.log10(0.1);
	const hi = Math.log10(10);
	const width = (hi - lo) / bins;
	const counts = new Array(bins).fill(0);
	for (const m of masses) {
		const b = Math.floor((Math.log10(m) - lo) / width);
		if (b >= 0 && b < bins) counts[b]++;
	}
	// Least-squares slope of log10(N/bin) vs log10(M/bin centre).
	let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
	for (let i = 0; i < bins; i++) {
		if (counts[i] < 5) continue;
		const x = lo + (i + 0.5) * width;
		const y = Math.log10(counts[i] / width);
		sx += x; sy += y; sxx += x * x; sxy += x * y; n++;
	}
	const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
	// dN/dlogM ~ M^-1.35 for Salpeter; a -1.35 +/- 0.35 slope fits.
	check('the mass function follows Salpeter (slope ≈ -1.35)', Math.abs(slope + 1.35) < 0.35, +slope.toFixed(3));
}

// --- Mass -> Teff -> class chain ----------------------------------------
{
	check('mass increases with temperature', starTypes.teffFromMass(0.2) < starTypes.teffFromMass(1.0)
		&& starTypes.teffFromMass(1.0) < starTypes.teffFromMass(10.0));
	check('the Sun is a G star', starTypes.classifyByTempAndState(5780, 'ms') === 'G');
	check('a 30 solar mass star is an O star', starTypes.classifyByTempAndState(starTypes.teffFromMass(30), 'ms') === 'O');
	check('evolved states win over temperature', starTypes.classifyByTempAndState(40000, 'wd') === 'WD'
		&& starTypes.classifyByTempAndState(3000, 'giant') === 'RG');
	check('main-sequence lifetime falls with mass',
		starTypes.msLifetimeGyr(20) < starTypes.msLifetimeGyr(1) && starTypes.msLifetimeGyr(1) < starTypes.msLifetimeGyr(0.2));
	const lum = starTypes.luminosityFromMass(1.0);
	check('a solar-mass star is roughly solar (M_V ≈ 4.8)', Math.abs(starTypes.absoluteMagnitude(lum) - 4.83) < 0.2,
		starTypes.absoluteMagnitude(lum));
	check('an O star is far brighter than the Sun',
		starTypes.absoluteMagnitude(starTypes.luminosityFromMass(30)) < -5,
		starTypes.absoluteMagnitude(starTypes.luminosityFromMass(30)));
}

// --- Determinism ---------------------------------------------------------
{
	const a = starTypes.deriveStar(model, 4242, density.COMPONENT_THIN, 8, 0.1, {});
	const b = starTypes.deriveStar(model, 4242, density.COMPONENT_THIN, 8, 0.1, {});
	const c = starTypes.deriveStar(model, 4243, density.COMPONENT_THIN, 8, 0.1, {});
	check('the same seed derives the same star',
		a.mass === b.mass && a.age === b.age && a.spectralClass === b.spectralClass);
	check('a different seed derives a different star', a.mass !== c.mass && a.age !== c.age);
	check('stars in an arm are younger than the same population off-arm',
		starTypes.sampleLocalAge(model, density.COMPONENT_THIN, 0.1, 8, 0.5, 0.5)
			< starTypes.sampleLocalAge(model, density.COMPONENT_THIN, 4.0, 8, 0.5, 0.5));
}

// --- The giant branch is temporary (0.4.5) --------------------------------
// Below 8 M☉ a star is a giant for a slice of its main-sequence life, then a
// cooling white dwarf. The branch lifetime is 15% of tMS, clamped to 2 Myr ..
// 1 Gyr: a solar mass lingers at the cap, a 5 M☉ star flashes through in
// 27 Myr, and a 100 M☉ star pins the floor.
{
	check('the giant branch lasts 15% of the main-sequence life, capped at 1 Gyr',
		starTypes.giantLifetimeGyr(1) === 1
		&& Math.abs(starTypes.giantLifetimeGyr(5) - 0.15 * starTypes.msLifetimeGyr(5)) < 1e-12
		&& starTypes.giantLifetimeGyr(100) === 0.002,
		{ at1: starTypes.giantLifetimeGyr(1), at5: +starTypes.giantLifetimeGyr(5).toFixed(4), at100: starTypes.giantLifetimeGyr(100) });
	check('the branch shortens with mass (red supergiants included, briefly)',
		starTypes.giantLifetimeGyr(8) < starTypes.giantLifetimeGyr(2)
		&& starTypes.giantLifetimeGyr(2) < starTypes.giantLifetimeGyr(1));
	check('the mirror constants are exported for the WGSL diff',
		starTypes.TGIANT_FRAC === 0.15 && starTypes.TGIANT_MIN === 0.002 && starTypes.TGIANT_MAX === 1
		&& starTypes.WD_COOL_TAU === 8 && starTypes.WD_TEFF_FLOOR === 4000 && starTypes.WD_LUM_FLOOR === 0.0005);
}

// --- The census per galaxy type (0.4.5) -----------------------------------
// Quenched types are dead at the default age: no O/B/A/F, giants a ~0.1%
// turnoff shell under 1.1 M☉, remnants accumulated to ~3.5%. Star-forming
// types keep O/B and the supergiant top of the branch, with fewer, hotter
// remnants. One draw serves every type's census (positions are the model's).
{
	const CENSUS_N = 60000;
	const census = {};
	for (const type of galaxy.GALAXY_TYPES) {
		const m = galaxy.createGalaxy({ type, seed: 42 });
		const pos = sampling.sampleGalaxyStars(m, 42, CENSUS_N);
		const s = { n: 0, ob: 0, af: 0, giant: 0, wd: 0, wdLum: 0, wdTeff: 0, gMax: 0, gMasses: [] };
		const shared = {};
		for (let i = 0; i < pos.count; i++) {
			starTypes.deriveStar(m, starTypes.fieldStarSeed(42, i), pos.component[i], pos.R[i], pos.distToArm[i], shared);
			s.n++;
			if (shared.spectralClass === 'O' || shared.spectralClass === 'B') s.ob++;
			if (shared.spectralClass === 'A' || shared.spectralClass === 'F') s.af++;
			if (shared.state === 'giant') { s.giant++; s.gMasses.push(shared.mass); if (shared.mass > s.gMax) s.gMax = shared.mass; }
			if (shared.state === 'wd') { s.wd++; s.wdLum += shared.luminosity; s.wdTeff += shared.teff; }
		}
		s.gMasses.sort((a, b) => a - b);
		census[type] = {
			obPct: 100 * s.ob / s.n, afPct: 100 * s.af / s.n,
			giantPct: 100 * s.giant / s.n, wdPct: 100 * s.wd / s.n,
			giantMedian: s.gMasses.length ? s.gMasses[Math.floor(s.gMasses.length / 2)] : null,
			giantMax: s.gMax, wdMeanLum: s.wd ? s.wdLum / s.wd : null, wdMeanTeff: s.wd ? s.wdTeff / s.wd : null,
		};
	}
	const quenched = ['E4', 'S0'];
	const forming = ['Sa', 'Sb', 'SBb', 'Sc', 'Sd', 'SBd', 'Irr'];
	check('quenched types are dead: no O/B/A/F at the default age',
		quenched.every((t) => census[t].obPct === 0 && census[t].afPct === 0), census.E4);
	check('quenched giants are a ~0.1% turnoff shell under 1.1 M☉',
		quenched.every((t) => census[t].giantPct > 0.05 && census[t].giantPct < 0.25
			&& census[t].giantMedian > 0.85 && census[t].giantMax < 1.1),
		{ E4: census.E4.giantPct, S0median: +census.S0.giantMedian.toFixed(3) });
	check('quenched remnants accumulate past 2.5% (they used to saturate at 0.2%)',
		quenched.every((t) => census[t].wdPct > 2.5), { E4: +census.E4.wdPct.toFixed(2), S0: +census.S0.wdPct.toFixed(2) });
	check('star-forming types keep O/B stars and the supergiant top of the branch',
		forming.every((t) => census[t].obPct > 0.05 && census[t].giantMax > 3),
		{ SBb: +census.SBb.obPct.toFixed(3), ScMax: +census.Sc.giantMax.toFixed(2) });
	check('star-forming remnants are fewer and hotter than quenched ones',
		forming.every((t) => census[t].wdPct > 1 && census[t].wdPct < 3 && census[t].wdMeanTeff > 13000)
		&& census.E4.wdMeanTeff < 13000 && census.E4.wdMeanLum < census.SBb.wdMeanLum,
		{ E4teff: Math.round(census.E4.wdMeanTeff), SBbTeff: Math.round(census.SBb.wdMeanTeff) });
}

// --- Young stars live in the gas lane (0.4.8 M3.3) ------------------------
// z/H = 0 is the old age, so every check above still describes the midplane.
// These describe the height the sky actually draws.
{
	const mid = starTypes.sampleLocalAge(model, density.COMPONENT_THIN, 0.05, 8, 0.2, 0.01, 0);
	const high = starTypes.sampleLocalAge(model, density.COMPONENT_THIN, 0.05, 8, 0.2, 0.01, 2);
	check('the midplane arm branch is still a newborn', mid < 0.05, mid);
	check('two scale heights up, the same draw is no longer young', high > 1 && high > mid, { mid, high });
	const lane = model.populations.youngScaleHeight;
	const atLane = starTypes.sampleLocalAge(model, density.COMPONENT_THIN, 4, 8, 0.5, 0.99, lane);
	const field = starTypes.sampleLocalAge(model, density.COMPONENT_THIN, 4, 8, 0.5, 0.99, 0);
	check('one gas-lane up, a field star is at least a newborn-ceiling old',
		atLane + 1e-9 >= starTypes.YOUNG_ARM_MAX_GYR && atLane + 1e-12 >= field,
		{ atLane, field, ceiling: starTypes.YOUNG_ARM_MAX_GYR });

	// Re-derive the sampled field with its height. The pin is lane occupancy,
	// not a median of a few dozen O/B stars: most newborns should sit inside
	// two gas-lane heights, and a larger share of them than of the M dwarfs.
	const gasLane = model.thin.H * model.populations.youngScaleHeight;
	const record = {};
	let ob = 0;
	let obIn = 0;
	let m = 0;
	let mIn = 0;
	for (let i = 0; i < buf.count; i++) {
		if (buf.component[i] !== density.COMPONENT_THIN) continue;
		starTypes.deriveStar(model, SEED * 31 + i + 1, buf.component[i], buf.R[i], buf.distToArm[i], record, buf.z[i]);
		const z = Math.abs(buf.z[i] - model.centre.z);
		const inside = z < 2 * gasLane;
		if (record.spectralClass === 'O' || record.spectralClass === 'B') {
			ob++;
			if (inside) obIn++;
		} else if (record.spectralClass === 'M') {
			m++;
			if (inside) mIn++;
		}
	}
	const obFrac = obIn / Math.max(1, ob);
	const mFrac = mIn / Math.max(1, m);
	check('O/B stars sit in the gas lane far more often than M dwarfs',
		ob > 20 && obFrac > 0.6 && obFrac > mFrac + 0.2,
		{ ob, obFrac: +obFrac.toFixed(3), mFrac: +mFrac.toFixed(3), gasLane: +gasLane.toFixed(3) });
}

// --- Report --------------------------------------------------------------
console.log('Class distribution:', Object.entries(classes).map(([k, v]) => `${k} ${v}`).join(', '));

let passed = 0;
let failed = 0;
for (const c of checks) {
	if (c.pass) passed++; else failed++;
	console.log(`  ${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.pass ? '' : `  -> ${JSON.stringify(c.detail)}`}`);
}
console.log(`\n${passed}/${checks.length} passed, ${failed} failed`);

const logPath = path.join(__dirname, 'logs', 'star-types-evolution.json');
fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.writeFileSync(logPath, JSON.stringify({
	date: new Date().toISOString(),
	seed: SEED,
	sampleSize: stars.length,
	sampleMs,
	deriveMs,
	byClass: classes,
	byComponent: summary.byComponent,
	classVsArmDistance: armStats,
	ageCensus,
	totalChecks: checks.length,
	passed,
	failed,
	checks,
}, null, 2));
console.log(`Wrote ${logPath}`);
console.log('\n=== VERDICT ===');
console.log(failed === 0 ? 'PASS — star types follow the evolution model' : `FAIL — ${failed} checks failed`);
process.exit(failed === 0 ? 0 : 1);
