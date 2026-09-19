// experiments/star-types-evolution-test.js
// Validates that stellar types are placed at evolutionarily-correct positions:
//   - O/B stars: concentrated in/near spiral arms (young, recent formation)
//   - Red giants (RG): more in bulge and thick disc (older populations)
//   - White dwarfs (WD): distributed, slightly more in older regions
//   - M dwarfs: distributed everywhere (most common by count)
//   - Metal-poor stars: halo
//
// Output: experiments/logs/star-types-evolution.json

'use strict';

const fs = require('fs');
const path = require('path');
const density = require('../src/math/density.js');
const sampling = require('../src/math/sampling.js');
const starTypes = require('../src/math/star-types.js');

const SEED = 7;
const N_STARS = 50000;
const BOX = { xMin: -25, xMax: 5, yMin: -15, yMax: 15, zMin: -5, zMax: 5 };

console.log('Precomputing rhoMax...');
const rhoMax = sampling.precomputeRhoMax(BOX, 80);
console.log(`  rhoMax = ${rhoMax.toFixed(4)}`);

console.log(`Sampling ${N_STARS} star positions...`);
const positions = sampling.sampleStars(SEED, N_STARS, BOX, rhoMax);

console.log('Deriving stellar properties (mass, age, type, evolution state)...');
const t0 = Date.now();
const stars = positions.map((p, i) => starTypes.deriveStarProps(p.x, p.y, p.z, SEED * 31 + i + 1));
console.log(`  took ${Date.now() - t0}ms`);

// Summary by class
const byClass = {};
const byComponentClass = {};  // [component][class] = count
for (const s of stars) {
	byClass[s.class] = (byClass[s.class] || 0) + 1;
	if (!byComponentClass[s.component]) byComponentClass[s.component] = {};
	byComponentClass[s.component][s.class] = (byComponentClass[s.component][s.class] || 0) + 1;
}

// Validate O/B stars are concentrated near arms.
const armStats = starTypes.classVsArmDistance(stars);

// Mean age per component
const agesByComp = {};
for (const s of stars) {
	if (!agesByComp[s.component]) agesByComp[s.component] = [];
	agesByComp[s.component].push(s.age);
}
const meanAgeByComp = {};
for (const k of Object.keys(agesByComp)) {
	const arr = agesByComp[k];
	meanAgeByComp[k] = arr.reduce((a, b) => a + b, 0) / arr.length;
}

// Mean metallicity per component
const metByComp = {};
for (const s of stars) {
	if (!metByComp[s.component]) metByComp[s.component] = [];
	metByComp[s.component].push(s.metallicity);
}
const meanMetByComp = {};
for (const k of Object.keys(metByComp)) {
	const arr = metByComp[k];
	meanMetByComp[k] = arr.reduce((a, b) => a + b, 0) / arr.length;
}

// Validate: O/B should be almost exclusively in thin disc near arms
const oBStars = stars.filter(s => s.class === 'O' || s.class === 'B');
const oBInArm = oBStars.filter(s => s.distToArm < 0.5).length;
const oBInDisc = oBStars.filter(s => Math.abs(s.z) < 0.100).length;

const out = {
	date: new Date().toISOString(),
	seed: SEED,
	N: N_STARS,
	box: BOX,
	byClass,
	byComponentClass,
	armDistanceByClass: armStats,
	meanAgeGyrByComponent: meanAgeByComp,
	meanMetallicityByComponent: meanMetByComp,
	obStars: {
		total: oBStars.length,
		inArm: oBInArm,
		inArmPct: (oBInArm / Math.max(1, oBStars.length) * 100).toFixed(1),
		inDiscPct: (oBInDisc / Math.max(1, oBStars.length) * 100).toFixed(1),
	},
	// Validate: red giants should be more in bulge/thick than in thin disc near arms
	redGiantsByComponent: byComponentClass,
};

const logPath = path.join(__dirname, 'logs', 'star-types-evolution.json');
fs.writeFileSync(logPath, JSON.stringify(out, null, 2));
console.log(`Wrote ${logPath}`);

// Print verdict
console.log('\n=== VERDICT ===');
console.log('Class distribution:');
for (const cls of ['O', 'B', 'A', 'F', 'G', 'K', 'M', 'RG', 'WD']) {
	const n = byClass[cls] || 0;
	const pct = (n / N_STARS * 100).toFixed(2);
	console.log(`  ${cls}: ${n} (${pct}%)`);
}
console.log('\nO/B stars:');
console.log(`  total: ${oBStars.length}`);
console.log(`  in arm (d < 0.5 kpc): ${oBInArm} (${out.obStars.inArmPct}%, expect >80%)`);
console.log(`  in disc midplane (|z|<100pc): ${oBInDisc} (${out.obStars.inDiscPct}%, expect >90%)`);
console.log('\nMean age by component (Gyr):');
for (const k of Object.keys(meanAgeByComp)) {
	console.log(`  ${k}: ${meanAgeByComp[k].toFixed(2)}`);
}
console.log('\nMean metallicity by component:');
for (const k of Object.keys(meanMetByComp)) {
	console.log(`  ${k}: ${meanMetByComp[k].toFixed(4)}`);
}
console.log('\nArm-distance stats per class:');
for (const cls of ['O', 'B', 'A', 'G', 'K', 'M', 'RG', 'WD']) {
	const s = armStats[cls];
	if (!s || s.n === 0) continue;
	console.log(`  ${cls}: n=${s.n}, mean d_arm=${s.mean.toFixed(2)} kpc, frac<0.5=${(s.fracLT05 * 100).toFixed(1)}%`);
}
