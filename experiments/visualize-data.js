// experiments/visualize-data.js
// Exports a sample of the galaxy — stars with derived types and colours,
// nebulae, and a density grid — as JSON for scripts/viz-galaxy.py to draw.
// This is the human-facing check that the model looks like a galaxy.
//
// Output: experiments/logs/galaxy-sample.json

'use strict';

const fs = require('fs');
const path = require('path');
const density = require('../src/math/density.js');
const sampling = require('../src/math/sampling.js');
const starTypes = require('../src/math/star-types.js');
const nebula = require('../src/math/nebula.js');
const records = require('../src/math/star-record.js');

const galaxy = require('../src/math/galaxy.js');
const model = galaxy.MILKY_WAY;

const SEED = 2024;
const N_STARS = 30000;
const N_NEBULAE = 200;

// A box centred on the galactic centre, inside the disc truncation.
const GC = model.centre;
const BOX = { xMin: GC.x - 22, xMax: GC.x + 22, yMin: -22, yMax: 22, zMin: -3, zMax: 3 };

console.log(`Sampling ${N_STARS.toLocaleString()} stars...`);
const positions = sampling.sampleStarsInBox(model, SEED, N_STARS, BOX);
console.log(`  got ${positions.count.toLocaleString()} stars`);

const lut = records.buildColorLUT();
const scratch = {};
const stars = new Array(positions.count);
for (let i = 0; i < positions.count; i++) {
	const s = starTypes.deriveStar(model, 
		SEED * 31 + i + 1, positions.component[i], positions.R[i], positions.distToArm[i], scratch);
	const ci = s.colorIndex * 4;
	stars[i] = {
		x: +positions.x[i].toFixed(4), y: +positions.y[i].toFixed(4), z: +positions.z[i].toFixed(4),
		R: +positions.R[i].toFixed(4),
		cls: s.spectralClass,
		col: [+(lut[ci] / 255).toFixed(3), +(lut[ci + 1] / 255).toFixed(3), +(lut[ci + 2] / 255).toFixed(3)],
		absMag: +s.absMag.toFixed(2),
		mass: +s.mass.toFixed(3),
		age: +s.age.toFixed(3),
		component: density.COMPONENT_NAMES[positions.component[i]],
		distToArm: +positions.distToArm[i].toFixed(3),
	};
}

console.log(`Placing ${N_NEBULAE} nebulae...`);
const nebulae = nebula.placeNebulae(model, SEED + 1, N_NEBULAE, BOX);
const slimNebulae = nebulae.map(n => ({
	x: +n.x.toFixed(4), y: +n.y.toFixed(4), z: +n.z.toFixed(4),
	type: n.type,
	size: +n.size.toFixed(3),
	col: n.color,
	opacity: +n.opacity.toFixed(2),
	R: +n.R.toFixed(4),
	distToArm: +n.distToArm.toFixed(3),
}));

// Top-down density grid for the background.
const GRID_N = 200;
const dx = (BOX.xMax - BOX.xMin) / GRID_N;
const dy = (BOX.yMax - BOX.yMin) / GRID_N;
const densityGrid = new Array(GRID_N * GRID_N);
for (let i = 0; i < GRID_N; i++) {
	const x = BOX.xMin + (i + 0.5) * dx;
	for (let j = 0; j < GRID_N; j++) {
		const y = BOX.yMin + (j + 0.5) * dy;
		densityGrid[i * GRID_N + j] = +density.rhoTotal(model, x, y, 0).toFixed(5);
	}
}

const out = {
	date: new Date().toISOString(),
	galaxy: {
		R0_kpc: density.GALACTIC_R0,
		centre: model.centre,
		arms: model.arms,
	},
	box: BOX,
	stars,
	nebulae: slimNebulae,
	densityGrid,
	densityGridMeta: { N: GRID_N, xMin: BOX.xMin, xMax: BOX.xMax, yMin: BOX.yMin, yMax: BOX.yMax },
	nebulaSummary: nebula.summariseNebulae(nebulae),
};

const logPath = path.join(__dirname, 'logs', 'galaxy-sample.json');
fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.writeFileSync(logPath, JSON.stringify(out));
console.log(`Wrote ${logPath}  (${(fs.statSync(logPath).size / 1024).toFixed(0)} KB)`);
