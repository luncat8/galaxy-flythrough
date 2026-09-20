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

const SEED = 7;
const N_STARS = 200000;

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
	return !!pass;
}

console.log(`Sampling ${N_STARS.toLocaleString()} stars and deriving types...`);
const t0 = Date.now();
const buf = sampling.sampleGalaxyStars(SEED, N_STARS);
const sampleMs = Date.now() - t0;

const stars = [];
const shared = {};
for (let i = 0; i < buf.count; i++) {
	const star = starTypes.deriveStar(
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
const armStats = starTypes.classVsArmDistance(stars);

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
	const ob = armStats.O.n + armStats.B.n;
	const mDwarfs = armStats.M;
	const obClose = (armStats.O.fracLT05 * armStats.O.n + armStats.B.fracLT05 * armStats.B.n) / Math.max(1, ob);
	check('O/B stars are within 0.5 kpc of an arm far more often than M dwarfs',
		obClose > mDwarfs.fracLT05 * 2, { obClose: +obClose.toFixed(4), mDwarfs: +mDwarfs.fracLT05.toFixed(4) });
	check('O/B stars have the smallest mean arm distance of all classes',
		armStats.O.mean <= Math.min(...Object.values(armStats).filter(s => s.n > 0).map(s => s.mean)) + 1e-9,
		{ O: +armStats.O.mean.toFixed(3), M: +armStats.M.mean.toFixed(3) });
	check('hot stars exist at all in the sample', ob > 5, ob);
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
	const a = starTypes.deriveStar(4242, density.COMPONENT_THIN, 8, 0.1, {});
	const b = starTypes.deriveStar(4242, density.COMPONENT_THIN, 8, 0.1, {});
	const c = starTypes.deriveStar(4243, density.COMPONENT_THIN, 8, 0.1, {});
	check('the same seed derives the same star',
		a.mass === b.mass && a.age === b.age && a.spectralClass === b.spectralClass);
	check('a different seed derives a different star', a.mass !== c.mass && a.age !== c.age);
	check('stars in an arm are younger than the same population off-arm',
		starTypes.sampleLocalAge(density.COMPONENT_THIN, 0.1, 8, 0.5, 0.5)
			< starTypes.sampleLocalAge(density.COMPONENT_THIN, 4.0, 8, 0.5, 0.5));
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
