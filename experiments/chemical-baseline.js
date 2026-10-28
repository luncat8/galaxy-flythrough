// E6 baseline: measure the existing gas-Z and stellar-metallicity contracts.
// This is a study, not a regression pin on the absence of chemical evolution.
'use strict';

const path = require('path');
const gas = require('../src/math/gas-grid.js');
const galaxy = require('../src/math/galaxy.js');
const density = require('../src/math/density.js');
const stars = require('../src/math/star-types.js');
const logFile = require('./log-file.js');

function measure(type) {
	const model = galaxy.createGalaxy({ type, seed: 42, age: galaxy.AGE_REF });
	const grid = new Float32Array(gas.GAS_FLOATS);
	const account = gas.initialize(model, 0, 42, grid);
	const initial = new Float32Array(grid);
	const rows = [];
	for (const age of [0, galaxy.AGE_REF / 2, galaxy.AGE_REF]) {
		gas.fillGrid(account, age, 42, grid);
		let mass = 0, metalWeighted = 0, zMin = Infinity, zMax = -Infinity, maxZChange = 0;
		for (let i = 0; i < gas.GAS_CELLS; i++) {
			const o = i * gas.GAS_SLOTS;
			const m = grid[o], z = grid[o + 1];
			mass += m;
			metalWeighted += m * z;
			if (m > 0) { zMin = Math.min(zMin, z); zMax = Math.max(zMax, z); }
			maxZChange = Math.max(maxZChange, Math.abs(z - initial[o + 1]));
		}
		rows.push({ ageGyr: age, gasMass: mass, weightedRelativeZ: metalWeighted / mass, zMin, zMax, maxCellZChange: maxZChange });
	}
	// Hold the stellar mass and age fixed while changing galactic epoch. This
	// isolates metallicity from normal age-dependent stellar evolution.
	const stellar = [];
	for (const age of [0, galaxy.AGE_REF / 2, galaxy.AGE_REF]) {
		const epoch = galaxy.modelAtAge(model, age);
		const out = {};
		stars.evolveStar(epoch, 17, 1, 0.1, density.COMPONENT_THIN, 8, 0, out);
		stellar.push({ galaxyAgeGyr: age, metal: out.metallicity, colorIndex: out.colorIndex });
	}
	return { type, burnC: account.burnC, clamped: account.clamped, rows, stellar };
}

const measurements = ['SBb', 'Sa', 'Sc'].map(measure);
console.log(JSON.stringify(measurements, null, 2));
const valid = measurements.every((m) => m.rows.every((r) =>
	Number.isFinite(r.gasMass) && r.gasMass > 0 && Number.isFinite(r.weightedRelativeZ)));
logFile.writeLog(path.join(__dirname, 'logs', 'chemical-baseline.json'), {
	date: new Date().toISOString(), measurements,
	componentMetallicity: {
		thin: stars.metallicityFor(density.COMPONENT_THIN),
		thick: stars.metallicityFor(density.COMPONENT_THICK),
		bulge: stars.metallicityFor(density.COMPONENT_BULGE),
		halo: stars.metallicityFor(density.COMPONENT_HALO),
	},
});
console.log('\n=== VERDICT ===');
console.log(valid ? 'Baseline measured; no enrichment model has been tested.' : 'Invalid baseline');
process.exit(valid ? 0 : 1);
