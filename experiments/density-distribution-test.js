// experiments/density-distribution-test.js
// The per-type parity suite (0.3.1): the sampler against the analytical field
// for {E4, S0, SBb, Sc, Irr} — one representative of each new profile and
// mechanism:
//
//   E4   Sersic spheroid only (no disc, no halo)
//   S0   lenticular: Sersic + smooth disc + halo
//   SBb  barred: bar spheroid + arms attached at the bar end (the preset)
//   Sc   flocculent arms, steep metallicity gradient
//   Irr  irregular: FBM texture + clump hotspots, two-stage clump sampling
//
// Both references are the field itself: the component shares against the
// analytic masses per component inside the box (within 2%), and the R / z
// histograms against the field integrated over the same box on a grid
// (total variation < 8% — this is what pins the radial and vertical
// inverters, including flaring and cores).
//
// Plus the box sampler's determinism and bounds, per type.
//
// Output: experiments/logs/density-distribution.json

'use strict';

const fs = require('fs');
const path = require('path');
const density = require('../src/math/density.js');
const sampling = require('../src/math/sampling.js');

const galaxy = require('../src/math/galaxy.js');

const SEED = 42;

// One box per type, sized to the type's structure. Table types are
// galactocentric (centre at the origin); the SBb preset keeps its Sun-centred
// frame, so its box is the classic one.
const SUITE = [
	{ type: 'E4', nStars: 60000, box: { xMin: -9, xMax: 9, yMin: -9, yMax: 9, zMin: -8, zMax: 8 }, rMax: 9 },
	{ type: 'S0', nStars: 60000, box: { xMin: -16, xMax: 16, yMin: -16, yMax: 16, zMin: -4, zMax: 4 }, rMax: 16 },
	{ type: 'SBb', nStars: 120000, box: { xMin: -20, xMax: 20, yMin: -20, yMax: 20, zMin: -3, zMax: 3 }, rMax: 22 },
	// A table bar: the boxy/peanut profile and its own sampler (the SBb above is
	// the preset, whose bulge is the authored Plummer ellipsoid). The box is tight
	// so the sharp-edged bar is resolved by the field grid.
	{ type: 'SBa', nStars: 60000, box: { xMin: -8, xMax: 8, yMin: -8, yMax: 8, zMin: -2.5, zMax: 2.5 }, rMax: 8 },
	{ type: 'Sc', nStars: 60000, box: { xMin: -16, xMax: 16, yMin: -16, yMax: 16, zMin: -4, zMax: 4 }, rMax: 16 },
	{ type: 'Irr', nStars: 60000, box: { xMin: -9, xMax: 9, yMin: -9, yMax: 9, zMin: -4, zMax: 4 }, rMax: 9 },
];

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
	return !!pass;
}

// Grid integral of the full field (clumps and FBM included, the way the
// shader reads it) over the box. The R sweep runs to the box's corner
// radius — a square box holds disc mass past the inscribed circle — and
// cells outside the box are skipped, so `total` is the mass in the box while
// `R` / `Rtotal` cover the R < rMax range the R histogram bins.
function boxIntegral(model, box, rMax) {
	const cx = model.centre.x, cy = model.centre.y;
	const rMaxBox = Math.max(
		Math.hypot(Math.max(box.xMin - cx, box.xMax - cx), Math.max(box.yMin - cy, box.yMax - cy)),
		Math.hypot(Math.min(box.xMin - cx, box.xMax - cx), Math.min(box.yMin - cy, box.yMax - cy)));
	const ref = { total: 0, R: new Float64Array(24), Rtotal: 0, z: new Float64Array(20), component: [0, 0, 0, 0] };
	const nR = 240, nPhi = 96, nZ = 60;
	const dR = rMaxBox / nR;
	const dPhi = (2 * Math.PI) / nPhi;
	const dZ = (box.zMax - box.zMin) / nZ;
	const dRB = rMax / 24;
	const dZB = (box.zMax - box.zMin) / 20;
	for (let i = 0; i < nR; i++) {
		const R = (i + 0.5) * dR;
		for (let j = 0; j < nPhi; j++) {
			const phi = (j + 0.5) * dPhi - Math.PI;
			const x = cx + R * Math.cos(phi);
			const y = cy + R * Math.sin(phi);
			if (x < box.xMin || x > box.xMax || y < box.yMin || y > box.yMax) continue;
			for (let k = 0; k < nZ; k++) {
				const z = box.zMin + (k + 0.5) * dZ;
				const d = density.rhoDecomposed(model, x, y, z);
				const cell = R * dR * dPhi * dZ;
				const mass = (d.thin + d.thick + d.bulge + d.halo) * cell;
				if (mass === 0) continue;
				ref.total += mass;
				ref.component[0] += d.thin * cell;
				ref.component[1] += d.thick * cell;
				ref.component[2] += d.bulge * cell;
				ref.component[3] += d.halo * cell;
				ref.z[Math.min(19, Math.floor((z - box.zMin) / dZB))] += mass;
				if (R < rMax) {
					ref.R[Math.min(23, Math.floor(R / dRB))] += mass;
					ref.Rtotal += mass;
				}
			}
		}
	}
	return ref;
}

let totalSampleMs = 0;
for (const spec of SUITE) {
	const model = galaxy.createGalaxy({ type: spec.type, seed: SEED });
	const tag = `${spec.type} ${model.centre.z === 0 ? '(table)' : '(preset)'}`;
	console.log(`\n[${tag}] sampling ${spec.nStars.toLocaleString()} stars...`);
	const t0 = Date.now();
	const buf = sampling.sampleStarsInBox(model, SEED, spec.nStars, spec.box);
	totalSampleMs += Date.now() - t0;
	console.log(`  got ${buf.count.toLocaleString()} in ${Date.now() - t0} ms`);
	check(`${tag}: the box sampler fills the requested count`, buf.count === spec.nStars, buf.count);
	if (buf.count !== spec.nStars) continue;

	console.log(`[${tag}] integrating the field over the box...`);
	const t1 = Date.now();
	const ref = boxIntegral(model, spec.box, spec.rMax);
	console.log(`  in ${Date.now() - t1} ms, ${ref.total.toFixed(1)} mass units`);
	check(`${tag}: the box contains model mass`, ref.total > 0, ref.total);

	// --- R / z histograms vs the field integral ---------------------------
	{
		const dRB = spec.rMax / 24;
		const dZB = (spec.box.zMax - spec.box.zMin) / 20;
		const histR = new Float64Array(24);
		const histZ = new Float64Array(20);
		let nRInRange = 0;
		for (let i = 0; i < buf.count; i++) {
			const dx = buf.x[i] - model.centre.x;
			const dy = buf.y[i] - model.centre.y;
			const R = Math.sqrt(dx * dx + dy * dy);
			if (R < spec.rMax) { histR[Math.min(23, Math.floor(R / dRB))]++; nRInRange++; }
			histZ[Math.min(19, Math.floor((buf.z[i] - spec.box.zMin) / dZB))]++;
		}
		// Each histogram compares its own support: R over [0, rMax) on both
		// sides, z over the whole box.
		let tvR = 0;
		for (let i = 0; i < 24; i++) tvR += Math.abs(histR[i] / nRInRange - ref.R[i] / ref.Rtotal);
		tvR /= 2;
		let tvZ = 0;
		for (let i = 0; i < 20; i++) tvZ += Math.abs(histZ[i] / buf.count - ref.z[i] / ref.total);
		tvZ /= 2;
		check(`${tag}: galactocentric R matches the field (TV < 8%)`, tvR < 0.08, +tvR.toFixed(4));
		check(`${tag}: z matches the field (TV < 8%)`, tvZ < 0.08, +tvZ.toFixed(4));
	}

	// --- Component shares vs the analytic masses in the box ---------------
	// The box can crop the global model (a halo's far field, a disc's outer
	// tail), so the target is the field's own mass per component inside the
	// box — the same integral the R/z histograms use — not the global
	// delivered masses.
	{
		const shares = {};
		let worst = 0;
		const counts = [0, 0, 0, 0];
		for (let i = 0; i < buf.count; i++) counts[buf.component[i]]++;
		const refTotal = ref.component[0] + ref.component[1] + ref.component[2] + ref.component[3];
		for (let c = 0; c < 4; c++) {
			const name = density.COMPONENT_NAMES[c];
			const expected = ref.component[c] / refTotal;
			const observed = counts[c] / buf.count;
			shares[name] = { observed: +observed.toFixed(5), expected: +expected.toFixed(5) };
			if (expected > 0.02) worst = Math.max(worst, Math.abs(observed - expected) / expected);
		}
		check(`${tag}: component shares match the analytic masses (within 2%)`, worst < 0.02,
			{ worst: +worst.toFixed(4), ...shares });
	}

	// --- Type-specific invariants -----------------------------------------
	if (spec.type === 'E4') {
		check('E4: the whole sample is spheroid (no disc, no halo)',
			buf.component.every((c) => c === density.COMPONENT_BULGE), null);
	}
	if (spec.type === 'SBb') {
		// The preset is the Sun-centred reference: a real chunk of stars in
		// this box has to be bulge stars (not a solar-neighbourhood blob).
		const bulge = buf.component.filter((c) => c === density.COMPONENT_BULGE).length / buf.count;
		check('SBb preset: the box sample includes the bulge population', bulge > 0.05, bulge);
	}
	if (spec.type === 'Irr') {
		// The two-stage sampler: CLUMP_SHARE of the disc stars (about 2.3% of
		// all stars) is assigned inside a clump gaussian; the base disc alone
		// puts almost none there.
		let near = 0;
		for (let i = 0; i < buf.count; i++) {
			for (const c of model.clumps) {
				const dx = buf.x[i] - c.x, dy = buf.y[i] - c.y, dz = buf.z[i] - c.z;
				if (dx * dx + dy * dy + dz * dz < 4 * c.r * c.r) { near++; break; }
			}
		}
		check('Irr: the sample shows the clump concentration the field carries',
			near / buf.count > 0.015, +(near / buf.count).toFixed(4));
	}

	// --- Determinism and bounds -------------------------------------------
	{
		const again = sampling.sampleStarsInBox(model, SEED, 5000, spec.box);
		const other = sampling.sampleStarsInBox(model, SEED + 1, 5000, spec.box);
		let identical = true;
		let differing = 0;
		for (let i = 0; i < again.count; i++) {
			if (again.x[i] !== other.x[i]) differing++;
		}
		const first = sampling.sampleStarsInBox(model, SEED, 5000, spec.box);
		for (let i = 0; i < again.count; i++) {
			if (again.x[i] !== first.x[i] || again.y[i] !== first.y[i]) identical = false;
		}
		check(`${tag}: deterministic in (seed, count, box)`, identical);
		check(`${tag}: a different seed changes the sample`, differing > 4900, differing);

		let outside = 0;
		for (let i = 0; i < buf.count; i++) {
			if (buf.x[i] < spec.box.xMin || buf.x[i] > spec.box.xMax) outside++;
			else if (buf.y[i] < spec.box.yMin || buf.y[i] > spec.box.yMax) outside++;
			else if (buf.z[i] < spec.box.zMin || buf.z[i] > spec.box.zMax) outside++;
		}
		check(`${tag}: every star lies inside the requested box`, outside === 0, outside);
	}
}

// --- Report --------------------------------------------------------------
let passed = 0;
let failed = 0;
for (const c of checks) {
	if (c.pass) passed++; else failed++;
	console.log(`  ${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.pass ? '' : `  -> ${JSON.stringify(c.detail)}`}`);
}
console.log(`\n${passed}/${checks.length} passed, ${failed} failed (${totalSampleMs} ms sampling)`);

const logPath = path.join(__dirname, 'logs', 'density-distribution.json');
fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.writeFileSync(logPath, JSON.stringify({
	date: new Date().toISOString(),
	seed: SEED,
	suite: SUITE.map((s) => s.type),
	totalSampleMs,
	totalChecks: checks.length,
	passed,
	failed,
	checks,
}, null, 2));
console.log(`Wrote ${logPath}`);
console.log('\n=== VERDICT ===');
console.log(failed === 0 ? 'PASS — per-type sampling follows the analytical density model' : `FAIL — ${failed} checks failed`);
process.exit(failed === 0 ? 0 : 1);
