// experiments/density-distribution-test.js
// Validates the box-restricted sampler (sampling.sampleStarsInBox) — the API
// the model experiments and the nebula placer use to draw stars in a region.
//
// The reference is the analytical model integrated over the same box on a grid,
// so this checks the sampler against the model, not against itself.
//
// Output: experiments/logs/density-distribution.json

'use strict';

const fs = require('fs');
const path = require('path');
const density = require('../src/math/density.js');
const sampling = require('../src/math/sampling.js');

const galaxy = require('../src/math/galaxy.js');
const model = galaxy.MILKY_WAY;

const SEED = 42;
const N_STARS = 120000;
const BOX = { xMin: -20, xMax: 20, yMin: -20, yMax: 20, zMin: -3, zMax: 3 };

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
	return !!pass;
}

console.log(`Sampling ${N_STARS.toLocaleString()} stars in the box...`);
const t0 = Date.now();
const buf = sampling.sampleStarsInBox(model, SEED, N_STARS, BOX);
const sampleMs = Date.now() - t0;
console.log(`  got ${buf.count.toLocaleString()} in ${sampleMs} ms `);
check('the box sampler fills the requested count', buf.count === N_STARS, buf.count);

// --- Reference integral over the box ------------------------------------
console.log('Integrating the model over the box...');
const NB_R = 24;          // galactocentric R bins (0..22 kpc)
const NB_Z = 20;          // z bins over [-3, 3]
const R_MAX = 22;
const ref = { total: 0, R: new Float64Array(NB_R), z: new Float64Array(NB_Z), component: [0, 0, 0, 0] };
{
	const nR = 180;
	const nPhi = 96;
	const nZ = 60;
	const dR = R_MAX / nR;
	const dPhi = (2 * Math.PI) / nPhi;
	const dZ = (BOX.zMax - BOX.zMin) / nZ;
	const dRB = R_MAX / NB_R;
	const dZB = (BOX.zMax - BOX.zMin) / NB_Z;
	for (let i = 0; i < nR; i++) {
		const R = (i + 0.5) * dR;
		for (let j = 0; j < nPhi; j++) {
			const phi = (j + 0.5) * dPhi - Math.PI;
			const x = model.centre.x + R * Math.cos(phi);
			const y = model.centre.y + R * Math.sin(phi);
			if (x < BOX.xMin || x > BOX.xMax || y < BOX.yMin || y > BOX.yMax) continue;
			for (let k = 0; k < nZ; k++) {
				const z = BOX.zMin + (k + 0.5) * dZ;
				const d = density.rhoDecomposed(model, x, y, z);
				const cell = R * dR * dPhi * dZ;
				const mass = (d.thin + d.thick + d.bulge + d.halo) * cell;
				if (mass === 0) continue;
				ref.total += mass;
				ref.component[0] += d.thin * cell;
				ref.component[1] += d.thick * cell;
				ref.component[2] += d.bulge * cell;
				ref.component[3] += d.halo * cell;
				ref.R[Math.min(NB_R - 1, Math.floor(R / dRB))] += mass;
				ref.z[Math.min(NB_Z - 1, Math.floor((z - BOX.zMin) / dZB))] += mass;
			}
		}
	}
}

// --- Compare histograms --------------------------------------------------
if (ref.total === 0) {
	check('the box contains model mass at all', false);
} else {
	const dRB = R_MAX / NB_R;
	const dZB = (BOX.zMax - BOX.zMin) / NB_Z;
	const histR = new Float64Array(NB_R);
	const histZ = new Float64Array(NB_Z);
	const componentCounts = [0, 0, 0, 0];
	for (let i = 0; i < buf.count; i++) {
		const dx = buf.x[i] - model.centre.x;
		const dy = buf.y[i] - model.centre.y;
		const R = Math.sqrt(dx * dx + dy * dy);
		if (R < R_MAX) histR[Math.min(NB_R - 1, Math.floor(R / dRB))]++;
		histZ[Math.min(NB_Z - 1, Math.floor((buf.z[i] - BOX.zMin) / dZB))]++;
		componentCounts[buf.component[i]]++;
	}
	function totalVariation(obs, exp) {
		let sum = 0;
		for (let i = 0; i < obs.length; i++) sum += Math.abs(obs[i] / buf.count - exp[i] / ref.total);
		return sum / 2;
	}
	const tvR = totalVariation(histR, ref.R);
	const tvZ = totalVariation(histZ, ref.z);
	check('galactocentric R distribution matches the model (TV < 8%)', tvR < 0.08, +tvR.toFixed(4));
	check('z distribution matches the model (TV < 8%)', tvZ < 0.08, +tvZ.toFixed(4));

	const refTotalComponents = ref.component[0] + ref.component[1] + ref.component[2] + ref.component[3];
	const shares = {};
	let worstShare = 0;
	for (let c = 0; c < 4; c++) {
		const name = density.COMPONENT_NAMES[c];
		const observed = componentCounts[c] / buf.count;
		const expected = ref.component[c] / refTotalComponents;
		shares[name] = { observed: +observed.toFixed(5), expected: +expected.toFixed(5) };
		if (expected > 0.02) worstShare = Math.max(worstShare, Math.abs(observed - expected) / expected);
	}
	check('component mix matches the model within 8%', worstShare < 0.08, { worst: +worstShare.toFixed(4), ...shares });

	// The box sampler must not be a solar-neighbourhood blob: with the galactic
	// centre inside the box, a real chunk of the sample has to be bulge stars.
	check('the box sample includes the bulge population', shares.bulge.observed > 0.05, shares.bulge);
}

// --- Determinism and bounds ---------------------------------------------
{
	const again = sampling.sampleStarsInBox(model, SEED, 5000, BOX);
	const other = sampling.sampleStarsInBox(model, SEED + 1, 5000, BOX);
	let identical = true;
	let differing = 0;
	for (let i = 0; i < again.count; i++) {
		if (again.x[i] !== other.x[i]) differing++;
	}
	const first = sampling.sampleStarsInBox(model, SEED, 5000, BOX);
	for (let i = 0; i < again.count; i++) {
		if (again.x[i] !== first.x[i] || again.y[i] !== first.y[i]) identical = false;
	}
	check('the box sampler is deterministic in (seed, count, box)', identical);
	check('a different seed produces a different box sample', differing > 4900, differing);

	let outside = 0;
	for (let i = 0; i < buf.count; i++) {
		if (buf.x[i] < BOX.xMin || buf.x[i] > BOX.xMax) outside++;
		else if (buf.y[i] < BOX.yMin || buf.y[i] > BOX.yMax) outside++;
		else if (buf.z[i] < BOX.zMin || buf.z[i] > BOX.zMax) outside++;
	}
	check('every star lies inside the requested box', outside === 0, outside);
}

// --- Report --------------------------------------------------------------
let passed = 0;
let failed = 0;
for (const c of checks) {
	if (c.pass) passed++; else failed++;
	console.log(`  ${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.pass ? '' : `  -> ${JSON.stringify(c.detail)}`}`);
}
console.log(`\n${passed}/${checks.length} passed, ${failed} failed`);

const logPath = path.join(__dirname, 'logs', 'density-distribution.json');
fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.writeFileSync(logPath, JSON.stringify({
	date: new Date().toISOString(),
	seed: SEED,
	sampleSize: buf.count,
	box: BOX,
	sampleMs,
	totalChecks: checks.length,
	passed,
	failed,
	checks,
}, null, 2));
console.log(`Wrote ${logPath}`);
console.log('\n=== VERDICT ===');
console.log(failed === 0 ? 'PASS — box sampling follows the analytical density model' : `FAIL — ${failed} checks failed`);
process.exit(failed === 0 ? 0 : 1);
