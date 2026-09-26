// experiments/young-vertical.js
// 0.4.8 M3.2 audit: does the young population have a vertical structure of its
// own?
//
// The model places a star first and types it afterwards: sampling.js draws a
// position from the *component* field (thin disc, sech² at H(R)) and
// star-types.deriveStar then decides mass and age from (component, R,
// distance-to-arm). Nothing in that chain reads z, so an O star and an M dwarf
// of the same component are drawn from the same vertical profile.
//
// Observed, they are not: the OB layer of a spiral disc is 45–90 pc thick
// (Reed 2000; Bobylev & Bajkova 2016 give 50–60 pc for OB2, ~70 pc for
// classical Cepheids), against ~300 pc for the old thin disc — the disc heats
// as it ages. The model already carries the number, `populations.
// youngScaleHeight` (0.5 of thin.H for the preset, i.e. 150 pc), but only the
// gas layers read it: nebula.js and objects.js place gas clouds, HII regions
// and open clusters with exp(-|z|/(thin.H·youngScaleHeight)), so the gas sits
// in a thin lane while the O/B *stars* born in it do not.
//
// This script measures the gap per spectral class and per type.
//
// Output: experiments/logs/young-vertical.json

'use strict';

const fs = require('fs');
const path = require('path');

const density = require('../src/math/density.js');
const galaxy = require('../src/math/galaxy.js');
const sampling = require('../src/math/sampling.js');
const starTypes = require('../src/math/star-types.js');

const N = 400000;
const YOUNG_CLASSES = ['O', 'B'];
// |z| median of a sech²(z/2H) column is 2H·atanh(1/2) = 1.0986·H; of an
// exponential column, H·ln2. The disc is sech², so this inverts the median.
const SECH2_MEDIAN_TO_H = 1 / 1.0986122886681098;

function scaleHeightFromMedian(median) { return median * SECH2_MEDIAN_TO_H; }

function audit(model) {
	const buf = sampling.sampleGalaxyStars(model, 7, N);
	const record = {};
	const zByClass = {};
	const ageByClass = {};
	for (let i = 0; i < buf.count; i++) {
		if (buf.component[i] !== density.COMPONENT_THIN) continue;
		const star = starTypes.deriveStar(model, i + 1, buf.component[i], buf.R[i], buf.distToArm[i], record);
		const cls = star.spectralClass;
		const z = Math.abs(buf.z[i] - model.centre.z);
		(zByClass[cls] = zByClass[cls] || []).push(z);
		ageByClass[cls] = (ageByClass[cls] || 0) + star.ageGyr;
	}
	const rows = {};
	for (const cls of Object.keys(zByClass)) {
		const zs = zByClass[cls].sort((a, b) => a - b);
		const median = zs[Math.floor(zs.length / 2)];
		rows[cls] = {
			stars: zs.length,
			medianZ: +median.toFixed(4),
			scaleHeight: +scaleHeightFromMedian(median).toFixed(4),
			meanAgeGyr: +(ageByClass[cls] / zs.length).toFixed(3),
		};
	}
	const young = YOUNG_CLASSES.filter((c) => rows[c]);
	const youngH = young.length
		? young.reduce((a, c) => a + rows[c].scaleHeight * rows[c].stars, 0)
			/ young.reduce((a, c) => a + rows[c].stars, 0)
		: null;
	const oldH = rows.M ? rows.M.scaleHeight : null;
	return {
		thinH: +model.thin.H.toFixed(4),
		gasLaneH: +(model.thin.H * model.populations.youngScaleHeight).toFixed(4),
		youngStarH: youngH === null ? null : +youngH.toFixed(4),
		oldStarH: oldH,
		ratioYoungToOld: youngH && oldH ? +(youngH / oldH).toFixed(3) : null,
		ratioYoungToGasLane: youngH ? +(youngH / (model.thin.H * model.populations.youngScaleHeight)).toFixed(3) : null,
		classes: rows,
	};
}

const TYPES = ['SBb', 'Sb', 'Sc', 'Sd', 'Irr'];
const report = {};
report[galaxy.MILKY_WAY_TYPE + ' (preset)'] = audit(galaxy.MILKY_WAY);
for (const type of TYPES) {
	if (type === galaxy.MILKY_WAY_TYPE) continue;
	report[type] = audit(galaxy.createGalaxy({ type, seed: 42 }));
}

console.log('type          thin H   gas lane   young stars   old stars   young/old');
for (const [name, r] of Object.entries(report)) {
	console.log(`${name.padEnd(13)} ${String(r.thinH).padEnd(8)} ${String(r.gasLaneH).padEnd(10)} `
		+ `${String(r.youngStarH).padEnd(13)} ${String(r.oldStarH).padEnd(11)} ${r.ratioYoungToOld}`);
}
console.log('\nA ratio of 1.0 means the young population has no vertical structure of its');
console.log('own: O/B stars are drawn from the same sech² column as the M dwarfs, while');
console.log('the gas they are born in sits in a lane half as thick (observed: 45-90 pc');
console.log('against ~300 pc, i.e. a ratio near 0.2).');

fs.mkdirSync(path.join(__dirname, 'logs'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'logs/young-vertical.json'),
	JSON.stringify({ stars: N, youngClasses: YOUNG_CLASSES, report }, null, 2) + '\n');
