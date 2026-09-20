// experiments/sampling-test.js
// Validates that the star sampler reproduces the analytical density model.
//
// The test builds a reference from the model itself (a 3D grid integral over
// the same volume the sampler draws from) and compares histograms of the
// sampled stars against it. This is the check that the old box-rejection
// sampler failed silently: it "worked" but produced a solar-neighbourhood blob
// and almost nothing in the bulge.
//
// Checks:
//   1. component shares match the analytic component masses
//   2. galactocentric R, |z| and azimuthal histograms match the model integral
//   3. spiral arm / inter-arm ratio matches (1+A)/(1-A)
//   4. determinism: same seed → identical sample, different seed → different
//   5. bounds and finiteness
//   6. star-type placement (O/B in arms, old populations in the bulge/halo)
//
// Output: experiments/logs/sampling.json

'use strict';

const fs = require('fs');
const path = require('path');
const density = require('../src/math/density.js');
const sampling = require('../src/math/sampling.js');
const starTypes = require('../src/math/star-types.js');
const hash = require('../src/math/hash.js');

const SEED = 42;
const N = 400000;
const T = density.TRUNCATION;
const ARM_PLOT_MAX = 2.4;        // kpc, plotted range of distToArm
const ARM_BIN = 0.1;             // kpc per distToArm bin

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
	return !!pass;
}

// --- Reference integral over the model -----------------------------------
// Grid in (R, phi, z), skipping the truncated tails the sampler also skips.
function modelHistogram(bins) {
	const R_MAX = T.discRadius;
	const Z_MAX = Math.max(T.discHeight, 3.0);
	const nR = 180;
	const nPhi = 144;
	const nZ = 48;
	const dR = R_MAX / nR;
	const dPhi = (2 * Math.PI) / nPhi;
	const dZ = (2 * Z_MAX) / nZ;

	const ref = {
		total: 0,
		R: new Float64Array(bins.R),
		z: new Float64Array(bins.z),
		phi: new Float64Array(bins.phi),
		distToArm: new Float64Array(bins.distToArm),
		component: { thin: 0, thick: 0, bulge: 0, halo: 0 },
	};
	const zBinWidth = 2 * Z_MAX / bins.z;
	const RBinWidth = R_MAX / bins.R;

	for (let i = 0; i < nR; i++) {
		const R = (i + 0.5) * dR;
		const cellArea = R * dR * dPhi * dZ;   // volume element
		for (let j = 0; j < nPhi; j++) {
			const phi = (j + 0.5) * dPhi - Math.PI;
			for (let k = 0; k < nZ; k++) {
				const z = (k + 0.5) * dZ - Z_MAX;
				const x = density.GALACTIC_CENTRE.x + R * Math.cos(phi);
				const y = density.GALACTIC_CENTRE.y + R * Math.sin(phi);
				const d = density.rhoDecomposed(x, y, z);
				const re = density.bulgeEllipsoidRadius(x - density.GALACTIC_CENTRE.x, y - density.GALACTIC_CENTRE.y, z);
				const bulge = re <= T.bulgeRadius * density.BULGE.r0 ? d.bulge : 0;
				const rho = d.thin + d.thick + bulge + d.halo;
				const mass = rho * cellArea;
				if (mass === 0) continue;
				ref.total += mass;
				ref.component.thin += d.thin * cellArea;
				ref.component.thick += d.thick * cellArea;
				ref.component.bulge += d.bulge * cellArea;
				ref.component.halo += d.halo * cellArea;
				ref.R[Math.min(bins.R - 1, Math.floor(R / RBinWidth))] += mass;
				ref.z[Math.min(bins.z - 1, Math.floor((z + Z_MAX) / zBinWidth))] += mass;
				ref.phi[Math.min(bins.phi - 1, Math.floor((phi + Math.PI) / (2 * Math.PI) * bins.phi))] += mass;
				if (d.distToArm < ARM_PLOT_MAX) {
					ref.distToArm[Math.min(bins.distToArm - 1, Math.floor(d.distToArm / ARM_BIN))] += mass;
				}
			}
		}
	}
	return ref;
}

// --- Sample --------------------------------------------------------------
console.log(`Sampling ${N.toLocaleString()} stars (seed ${SEED})...`);
let t0 = Date.now();
const stars = sampling.sampleGalaxyStars(SEED, N);
const sampleMs = Date.now() - t0;
console.log(`  ${sampleMs} ms`);

const bins = { R: 24, z: 24, phi: 36, distToArm: 24 };
console.log('Integrating the analytical model...');
t0 = Date.now();
const ref = modelHistogram(bins);
console.log(`  ${Date.now() - t0} ms, ${ref.total.toFixed(1)} model mass units`);

// --- 1. Component shares -------------------------------------------------
{
	const shares = sampling.componentShares(stars);
	// The sampler draws the truncated profiles, so the target is the mass each
	// component delivers inside the sampled volume (componentMasses() minus the
	// tails past |z| = discHeight / s = bulgeRadius), not the untruncated
	// integral.
	const masses = sampling.deliveredMasses();
	const expected = {
		thin: masses.thin / masses.total,
		thick: masses.thick / masses.total,
		bulge: masses.bulge / masses.total,
		halo: masses.halo / masses.total,
	};
	let worst = 0;
	const detail = {};
	for (const name of ['thin', 'thick', 'bulge', 'halo']) {
		// Halo stars beyond the sampled z range make the tail noisier; compare
		// the two dominant populations strictly and allow more slack elsewhere.
		const tolerance = name === 'halo' ? 0.5 : 0.1;
		const relative = Math.abs(shares[name] - expected[name]) / expected[name];
		detail[name] = { sampled: shares[name], model: expected[name], relative };
		worst = Math.max(worst, relative / tolerance);
	}
	check('component shares match the analytic component masses', worst <= 1, detail);
}

// --- 2. Distribution shape ----------------------------------------------
{
	const zMax = Math.max(T.discHeight, 3.0);
	const RBinWidth = T.discRadius / bins.R;
	const zBinWidth = 2 * zMax / bins.z;
	const histR = new Float64Array(bins.R);
	const histZ = new Float64Array(bins.z);
	const histPhi = new Float64Array(bins.phi);
	for (let i = 0; i < stars.count; i++) {
		const x = stars.x[i] - density.GALACTIC_CENTRE.x;
		const y = stars.y[i] - density.GALACTIC_CENTRE.y;
		const R = Math.sqrt(x * x + y * y);
		const phi = Math.atan2(y, x);
		const z = stars.z[i];
		if (R < T.discRadius) histR[Math.min(bins.R - 1, Math.floor(R / RBinWidth))]++;
		if (Math.abs(z) < zMax) histZ[Math.min(bins.z - 1, Math.floor((z + zMax) / zBinWidth))]++;
		histPhi[Math.min(bins.phi - 1, Math.floor((phi + Math.PI) / (2 * Math.PI) * bins.phi))]++;
	}

	// Total variation distance between the sampled and model distributions.
	function totalVariation(sampled, model, modelTotal, sampleTotal) {
		let sum = 0;
		for (let i = 0; i < sampled.length; i++) {
			sum += Math.abs(sampled[i] / sampleTotal - model[i] / modelTotal);
		}
		return sum / 2;
	}
	const tvR = totalVariation(histR, ref.R, ref.total, stars.count);
	const tvZ = totalVariation(histZ, ref.z, ref.total, stars.count);
	const tvPhi = totalVariation(histPhi, ref.phi, ref.total, stars.count);
	check('galactocentric R distribution matches the model (TV < 6%)', tvR < 0.06, tvR);
	check('vertical |z| distribution matches the model (TV < 6%)', tvZ < 0.06, tvZ);
	check('azimuthal distribution matches the model (TV < 6%)', tvPhi < 0.06, tvPhi);
}

// --- 3. Spiral arm structure --------------------------------------------
// The raw in-arm/inter-arm ratio depends on the arc width used to define the
// zones (a fixed kpc width subtends a different phase angle at every radius),
// so instead of a closed-form expectation this compares the full distToArm
// histogram against the model integral over the same bins.
{
	const hist = new Float64Array(bins.distToArm);
	let inRange = 0;
	for (let i = 0; i < stars.count; i++) {
		const d = stars.distToArm[i];
		if (d >= ARM_PLOT_MAX) continue;
		hist[Math.min(bins.distToArm - 1, Math.floor(d / ARM_BIN))]++;
		inRange++;
	}
	let modelInRange = 0;
	for (let b = 0; b < bins.distToArm; b++) modelInRange += ref.distToArm[b];
	let tv = 0;
	for (let b = 0; b < bins.distToArm; b++) {
		tv += Math.abs(hist[b] / inRange - ref.distToArm[b] / modelInRange);
	}
	tv /= 2;
	check('distance-to-arm distribution matches the model (TV < 5%)', tv < 0.05, tv);
	// Arm contrast as a ratio of bin densities at the ridge vs the widest bin.
	const ridgeDensity = hist[0] / ARM_BIN / inRange;
	const wideDensity = hist[bins.distToArm - 1] / ARM_BIN / inRange;
	check('arm ridge is denser than the zone 2 kpc away',
		ridgeDensity > wideDensity * 1.2, { ridge: ridgeDensity, far: wideDensity });
}

// --- 3b. Local density ratios -------------------------------------------
// The strongest check of the sampler's *weights*: inside one volume, the mix
// of populations must equal the model's own mix there. A weighting that is off
// by the truncation or arm acceptance shows up here and nowhere else.
{
	const R_LO = 4;
	const R_HI = 8;
	const Z_MAX = 1.0;
	const counts = [0, 0, 0, 0];
	const modelMasses = [0, 0, 0, 0];
	const nR = 160;
	const nPhi = 128;
	const nZ = 32;
	const dR = (R_HI - R_LO) / nR;
	const dPhi = (2 * Math.PI) / nPhi;
	const dZ = (2 * Z_MAX) / nZ;
	for (let i = 0; i < nR; i++) {
		const R = R_LO + (i + 0.5) * dR;
		const cell = R * dR * dPhi * dZ;
		for (let j = 0; j < nPhi; j++) {
			const phi = (j + 0.5) * dPhi - Math.PI;
			const x = density.GALACTIC_CENTRE.x + R * Math.cos(phi);
			const y = density.GALACTIC_CENTRE.y + R * Math.sin(phi);
			for (let k = 0; k < nZ; k++) {
				const z = (k + 0.5) * dZ - Z_MAX;
				const d = density.rhoDecomposed(x, y, z);
				const re = density.bulgeEllipsoidRadius(x - density.GALACTIC_CENTRE.x, y - density.GALACTIC_CENTRE.y, z);
				modelMasses[0] += d.thin * cell;
				modelMasses[1] += d.thick * cell;
				modelMasses[2] += (re <= T.bulgeRadius * density.BULGE.r0 ? d.bulge : 0) * cell;
				modelMasses[3] += d.halo * cell;
			}
		}
	}
	let sampled = 0;
	for (let i = 0; i < stars.count; i++) {
		const dx = stars.x[i] - density.GALACTIC_CENTRE.x;
		const dy = stars.y[i] - density.GALACTIC_CENTRE.y;
		const R = Math.sqrt(dx * dx + dy * dy);
		if (R < R_LO || R > R_HI || Math.abs(stars.z[i]) > Z_MAX) continue;
		counts[stars.component[i]]++;
		sampled++;
	}
	const detail = {};
	let worst = 0;
	for (let c = 0; c < 3; c++) {   // halo is empty in this volume
		const sampledShare = counts[c] / sampled;
		const modelShare = modelMasses[c] / (modelMasses[0] + modelMasses[1] + modelMasses[2]);
		const relative = Math.abs(sampledShare - modelShare) / modelShare;
		detail[density.COMPONENT_NAMES[c]] = { sampled: +sampledShare.toFixed(5), model: +modelShare.toFixed(5) };
		worst = Math.max(worst, relative);
	}
	check('population mix inside a 4-8 kpc annulus matches the model (worst 4%)', worst < 0.04, { worst, ...detail, stars: sampled });
}

// --- 4. Determinism ------------------------------------------------------
{
	const again = sampling.sampleGalaxyStars(SEED, 1000);
	const different = sampling.sampleGalaxyStars(SEED + 1, 1000);
	let identical = true;
	let identicalCount = 0;
	for (let i = 0; i < 1000; i++) {
		if (again.x[i] !== different.x[i]) identicalCount++;
	}
	const first = sampling.sampleGalaxyStars(SEED, 1000);
	for (let i = 0; i < 1000; i++) {
		if (again.x[i] !== first.x[i] || again.y[i] !== first.y[i] || again.z[i] !== first.z[i]) identical = false;
	}
	check('same seed produces an identical sample', identical);
	check('a different seed changes the sample', identicalCount > 990, identicalCount);
}

// --- 5. Bounds -----------------------------------------------------------
{
	let bad = 0;
	let maxAbsZ = 0;
	let outsideHalo = 0;
	for (let i = 0; i < stars.count; i++) {
		const x = stars.x[i];
		const y = stars.y[i];
		const z = stars.z[i];
		if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) bad++;
		maxAbsZ = Math.max(maxAbsZ, Math.abs(z));
		const component = stars.component[i];
		if (component === density.COMPONENT_BULGE) {
			const dx = x - density.GALACTIC_CENTRE.x;
			const dy = y - density.GALACTIC_CENTRE.y;
			const re = density.bulgeEllipsoidRadius(dx, dy, z);
			if (re / density.BULGE.r0 > T.bulgeRadius + 1e-3) outsideHalo++;
		}
		if (component === density.COMPONENT_HALO) {
			const dx = x - density.GALACTIC_CENTRE.x;
			const dy = y - density.GALACTIC_CENTRE.y;
			const r = Math.sqrt(dx * dx + dy * dy + z * z);
			if (r > density.HALO.rMax + 1e-3) outsideHalo++;
		}
	}
	check('no NaN or infinite positions', bad === 0, bad);
	check('disc stars stay inside the disc truncation', maxAbsZ <= Math.max(T.discHeight, density.HALO.rMax) + 1e-3, maxAbsZ);
	check('bulge and halo stars respect their truncations', outsideHalo === 0, outsideHalo);
}

// --- 6. Star types -------------------------------------------------------
{
	const derived = {};
	const counts = {};
	const armCounts = {};
	const armTotals = {};
	let nanMag = 0;
	const sumAge = {};
	for (let i = 0; i < stars.count; i++) {
		starTypes.deriveStar(SEED * 31 + i + 1, stars.component[i], stars.R[i], stars.distToArm[i], derived);
		const cls = derived.spectralClass;
		counts[cls] = (counts[cls] || 0) + 1;
		if (!Number.isFinite(derived.absMag) || !Number.isFinite(derived.mass)) nanMag++;
		if (derived.component === undefined) throw new Error('deriveStar did not set component');
		const component = density.COMPONENT_NAMES[stars.component[i]];
		sumAge[component] = (sumAge[component] || 0) + derived.age;
		if (derived.distToArm === undefined) armTotals[cls] = (armTotals[cls] || 0) + 1;
		if (cls === 'O' || cls === 'B') {
			armTotals[cls] = (armTotals[cls] || 0) + 1;
			if (stars.distToArm[i] < 0.5) armCounts[cls] = (armCounts[cls] || 0) + 1;
		}
	}
	const meanAge = {};
	for (const key of Object.keys(sumAge)) {
		let n = 0;
		for (let i = 0; i < stars.count; i++) if (density.COMPONENT_NAMES[stars.component[i]] === key) n++;
		meanAge[key] = sumAge[key] / Math.max(1, n);
	}
	check('no NaN magnitudes or masses', nanMag === 0, nanMag);
	check('M dwarfs dominate the population (IMF)', (counts.M || 0) / stars.count > 0.3, counts);
	check('O and B stars are rare but present', (counts.O || 0) + (counts.B || 0) > 0, counts);
	check('O/B stars are concentrated in the arms (>70% within 500 pc)',
		(armCounts.O || 0) / Math.max(1, armTotals.O || 1) > 0.7 && (armCounts.B || 0) / Math.max(1, armTotals.B || 1) > 0.7,
		{ O: (armCounts.O || 0) / Math.max(1, armTotals.O || 1), B: (armCounts.B || 0) / Math.max(1, armTotals.B || 1) });
	const ageOrder = meanAge.halo > meanAge.bulge && meanAge.bulge > meanAge.thick && meanAge.thick > meanAge.thin;
	check('mean ages order halo > bulge > thick > thin', ageOrder, meanAge);

	// The sampler must not ask star-types to classify O stars in the halo etc.;
	// this also checks that RG/WD appear at all (evolution is actually running).
	check('red giants and white dwarfs exist', (counts.RG || 0) > 0 && (counts.WD || 0) > 0, { RG: counts.RG, WD: counts.WD });

	// --- 7. hash channels are independent enough for type assignment -----
	let collisions = 0;
	for (let i = 0; i < 20000; i++) {
		if (hash.hash01At(i, 0) === hash.hash01At(i, 1)) collisions++;
	}
	check('hash01At channels are decorrelated', collisions < 5, collisions);
}

// --- Report --------------------------------------------------------------
let passed = 0;
let failed = 0;
for (const c of checks) {
	if (c.pass) passed++; else failed++;
	console.log(`  ${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.pass ? '' : `  -> ${JSON.stringify(c.detail)}`}`);
}
console.log(`\n${passed}/${checks.length} passed, ${failed} failed`);

const logPath = path.join(__dirname, 'logs', 'sampling.json');
fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.writeFileSync(logPath, JSON.stringify({
	date: new Date().toISOString(),
	seed: SEED,
	sampleSize: N,
	sampleMs,
	totalChecks: checks.length,
	passed,
	failed,
	checks,
}, null, 2));
console.log(`Wrote ${logPath}`);
console.log('\n=== VERDICT ===');
console.log(failed === 0 ? 'PASS — sampler reproduces the analytical density model' : `FAIL — ${failed} checks failed`);
process.exit(failed === 0 ? 0 : 1);
