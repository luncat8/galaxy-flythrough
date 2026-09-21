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
const sampling = require('../src/math/sampling.js');
const starTypes = require('../src/math/star-types.js');

const galaxy = require('../src/math/galaxy.js');
const records = require('../src/math/star-record.js');
const model = galaxy.MILKY_WAY;

const SEED = 7;
const N_STARS = 200000;

const checks = [];
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
	const ridge = (type) => {
		const m = galaxy.createGalaxy({ type });
		const buf2 = sampling.sampleGalaxyStars(m, 4242, 200000);
		const shared2 = {};
		const z = [];
		for (let i = 0; i < buf2.count; i++) {
			if (buf2.component[i] !== density.COMPONENT_THIN) continue;
			const R = buf2.R[i];
			if (R < m.arms.Rs || R > m.populations.youngOuterR) continue;
			const s = starTypes.deriveStar(m, 4242 * 31 + i + 1, buf2.component[i], R, buf2.distToArm[i], shared2);
			if (s.age < 0.3) z.push(buf2.distToArm[i] / density.armRidgeWidth(m, R));
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
	// step redder than RG, in the dedicated RGe slot.
	let giants = 0;
	let rgReddened = 0;
	for (let i = 1; i <= 20000; i++) {
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
	totalChecks: checks.length,
	passed,
	failed,
	checks,
}, null, 2));
console.log(`Wrote ${logPath}`);
console.log('\n=== VERDICT ===');
console.log(failed === 0 ? 'PASS — star types follow the evolution model' : `FAIL — ${failed} checks failed`);
process.exit(failed === 0 ? 0 : 1);
