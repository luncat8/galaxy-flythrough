// experiments/visualize-data.js
// Produces a JSON sample of stars (with derived types/colours) and nebulae
// for the Python visualisation script to consume.
//
// Output: experiments/logs/galaxy-sample.json

'use strict';

const fs = require('fs');
const path = require('path');
const density = require('../src/math/density.js');
const sampling = require('../src/math/sampling.js');
const starTypes = require('../src/math/star-types.js');
const nebula = require('../src/math/nebula.js');

const SEED = 2024;
const N_STARS = 30000;
const N_NEBULAE = 200;
const BOX = { xMin: -25, xMax: 5, yMin: -15, yMax: 15, zMin: -5, zMax: 5 };

console.log('Precomputing rhoMax...');
const rhoMax = sampling.precomputeRhoMax(BOX, 80);

console.log(`Sampling ${N_STARS} positions...`);
const positions = sampling.sampleStars(SEED, N_STARS, BOX, rhoMax);

console.log('Deriving star properties...');
const stars = positions.map((p, i) => {
	const s = starTypes.deriveStarProps(p.x, p.y, p.z, SEED * 31 + i + 1);
	// Slim down for JSON output: only what viz needs
	return {
		x: +s.x.toFixed(4), y: +s.y.toFixed(4), z: +s.z.toFixed(4),
		R: +s.R.toFixed(4),
		cls: s.class,
		col: s.color.map(c => +c.toFixed(3)),
		absMag: +s.absMag.toFixed(2),
		mass: +s.mass.toFixed(3),
		age: +s.age.toFixed(3),
		component: s.component,
		distToArm: +s.distToArm.toFixed(3),
	};
});

console.log(`Placing ${N_NEBULAE} nebulae...`);
const nebulae = nebula.placeNebulae(SEED + 1, N_NEBULAE, BOX, rhoMax);

const slimNebulae = nebulae.map(n => ({
	x: +n.x.toFixed(4), y: +n.y.toFixed(4), z: +n.z.toFixed(4),
	type: n.type,
	size: +n.size.toFixed(3),
	col: n.color,
	opacity: +n.opacity.toFixed(2),
	R: +n.R.toFixed(4),
	distToArm: +n.distToArm.toFixed(3),
}));

// Also produce the density grid (top-down) for background visualisation
const GRID_N = 200;
const xMin = -25, xMax = 5, yMin = -15, yMax = 15;
const dx = (xMax - xMin) / GRID_N;
const dy = (yMax - yMin) / GRID_N;
const densityGrid = new Array(GRID_N * GRID_N);
for (let i = 0; i < GRID_N; i++) {
	const x = xMin + (i + 0.5) * dx;
	for (let j = 0; j < GRID_N; j++) {
		const y = yMin + (j + 0.5) * dy;
		const r = density.rhoTotal(x, y, 0);  // midplane
		densityGrid[i * GRID_N + j] = +r.toFixed(5);
	}
}

const out = {
	date: new Date().toISOString(),
	galaxy: {
		R0_kpc: density.GALACTIC_R0,
		centre: density.GALACTIC_CENTRE,
		arms: density.ARMS,
	},
	stars,
	nebulae: slimNebulae,
	densityGrid,
	densityGridMeta: { N: GRID_N, xMin, xMax, yMin, yMax },
};

const logPath = path.join(__dirname, 'logs', 'galaxy-sample.json');
fs.writeFileSync(logPath, JSON.stringify(out));
console.log(`Wrote ${logPath}  (${(fs.statSync(logPath).size / 1024).toFixed(0)} KB)`);
