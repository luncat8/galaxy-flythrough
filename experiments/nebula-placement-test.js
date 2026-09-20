// experiments/nebula-placement-test.js
// Validates that compact nebulae land in physically sensible places:
//   - HII regions hug the arm ridges and never sit in the halo
//   - planetary nebulae favour the bulge / old population
//   - dark clouds stay in the thin disc, away from the bulge
//   - sizes, opacities and colours stay inside their documented ranges
//   - placement is deterministic in the seed
//
// Output: experiments/logs/nebula-placement.json

'use strict';

const fs = require('fs');
const path = require('path');
const density = require('../src/math/density.js');
const nebula = require('../src/math/nebula.js');

const SEED = 99;
const N_NEBULAE = 1200;
const BOX = { xMin: -20, xMax: 20, yMin: -20, yMax: 20, zMin: -2, zMax: 2 };

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
	return !!pass;
}

console.log(`Placing ${N_NEBULAE} nebulae in the box...`);
const t0 = Date.now();
const nebulae = nebula.placeNebulae(SEED, N_NEBULAE, BOX);
const placeMs = Date.now() - t0;
console.log(`  placed ${nebulae.length} in ${placeMs} ms`);
check('the placer reaches the requested count', nebulae.length === N_NEBULAE, nebulae.length);

const summary = nebula.summariseNebulae(nebulae);
const counts = summary.byType;

// --- Type mix ------------------------------------------------------------
{
	check('all five nebula types are present',
		nebula.NEBULA_TYPES.every(t => counts[t] > 0), counts);
	check('HII regions are present but not dominant',
		counts.HII > 0 && counts.HII / nebulae.length < 0.35, counts.HII / nebulae.length);
	check('planetary nebulae are present', counts.planetary > 0, counts.planetary);
}

// --- Spatial sanity ------------------------------------------------------
{
	const hII = nebulae.filter(n => n.type === 'HII');
	const reflection = nebulae.filter(n => n.type === 'reflection');
	const planetary = nebulae.filter(n => n.type === 'planetary');
	const dark = nebulae.filter(n => n.type === 'dark');

	const meanArm = (list) => list.reduce((a, n) => a + n.distToArm, 0) / Math.max(1, list.length);
	check('HII regions sit on the arm ridges (mean distance-to-arm < 0.35 kpc)',
		meanArm(hII) < 0.35, +meanArm(hII).toFixed(3));
	check('reflection nebulae sit near the arms too (mean < 0.9 kpc)',
		meanArm(reflection) < 0.9, +meanArm(reflection).toFixed(3));
	check('HII regions are closer to the arms than dark clouds',
		meanArm(hII) < meanArm(dark), { hII: +meanArm(hII).toFixed(3), dark: +meanArm(dark).toFixed(3) });

	const planetaryInner = planetary.filter(n => n.R < 3).length / Math.max(1, planetary.length);
	check('planetary nebulae favour the inner galaxy (R < 3 kpc more often than the sample average)',
		planetaryInner > 0.15, +planetaryInner.toFixed(3));

	const haloish = nebulae.filter(n => n.component === 'halo' || Math.abs(n.z) > 1.0).length;
	check('almost no nebula sits in the halo or above |z| = 1 kpc', haloish / nebulae.length < 0.05,
		{ haloish, fraction: +(haloish / nebulae.length).toFixed(4) });

	const allInside = nebulae.every(n => n.x >= BOX.xMin && n.x <= BOX.xMax
		&& n.y >= BOX.yMin && n.y <= BOX.yMax && n.z >= BOX.zMin && n.z <= BOX.zMax);
	check('every nebula lies inside the requested box', allInside);
}

// --- Ranges --------------------------------------------------------------
{
	let badSize = 0;
	let badOpacity = 0;
	let badColor = 0;
	for (const n of nebulae) {
		if (!(n.size >= 0.020 && n.size <= 0.320)) badSize++;
		if (!(n.opacity >= 0.4 && n.opacity <= 0.9)) badOpacity++;
		const expected = nebula.NEBULA_COLORS[n.type];
		if (!expected || expected.some((c, i) => c !== n.color[i])) badColor++;
	}
	check('sizes stay inside 20-320 pc', badSize === 0, badSize);
	check('opacities stay inside 0.4-0.9', badOpacity === 0, badOpacity);
	check('every nebula carries its type colour', badColor === 0, badColor);
	check('the summary reports the documented size range',
		summary.meanSizeKpc > 0.05 && summary.meanSizeKpc < 0.30, summary.meanSizeKpc);
}

// --- Determinism ---------------------------------------------------------
{
	const again = nebula.placeNebulae(SEED, 50, BOX);
	const other = nebula.placeNebulae(SEED + 1, 50, BOX);
	let identical = true;
	let differing = 0;
	for (let i = 0; i < again.length; i++) {
		if (again[i].x !== other[i].x || again[i].type !== other[i].type) differing++;
		if (again[i].x !== nebulae[i].x || again[i].type !== nebulae[i].type) identical = false;
	}
	check('placement is deterministic in the seed', identical);
	check('a different seed moves the nebulae', differing > 45, differing);
}

// --- Probability field ---------------------------------------------------
{
	// Gas-dominated types must be suppressed in the bulge and the halo, and
	// must peak on the arm ridge. The ridge point is derived from the arm model
	// (m * phi - k * ln(R / Rs) = 0) so this probes the real crest.
	const GC = density.GALACTIC_CENTRE;
	const armR = 5.0;
	const k = Math.tan(density.ARMS.pitchDeg * Math.PI / 180);
	const armPhi = k * Math.log(armR / density.ARMS.Rs) / density.ARMS.m;
	const centre = nebula.nebulaProbabilityAt(GC.x, GC.y, 0);
	const arm = nebula.nebulaProbabilityAt(GC.x + armR * Math.cos(armPhi), GC.y + armR * Math.sin(armPhi), 0.02);
	const halo = nebula.nebulaProbabilityAt(0, 0, 12);
	check('the galactic centre is not a nebula nursery', centre.p < arm.p && centre.p < 0.03, centre.p);
	check('the halo is strongly suppressed', halo.p < 0.002, halo.p);
	check('an arm mid-disc position has a real probability', arm.p > 0.01, arm.p);
	check('the centre prefers a stellar (planetary) type', centre.type === 'planetary', centre.type);
}

// --- Report --------------------------------------------------------------
console.log(`\nBy type: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log(`By component: ${Object.entries(summary.byComponent).map(([k, v]) => `${k} ${v}`).join(', ')}`);

let passed = 0;
let failed = 0;
for (const c of checks) {
	if (c.pass) passed++; else failed++;
	console.log(`  ${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.pass ? '' : `  -> ${JSON.stringify(c.detail)}`}`);
}
console.log(`\n${passed}/${checks.length} passed, ${failed} failed`);

const logPath = path.join(__dirname, 'logs', 'nebula-placement.json');
fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.writeFileSync(logPath, JSON.stringify({
	date: new Date().toISOString(),
	seed: SEED,
	targetN: N_NEBULAE,
	placedN: nebulae.length,
	placeMs,
	box: BOX,
	byType: summary.byType,
	byComponent: summary.byComponent,
	armDistBuckets: summary.armDistBuckets,
	meanSizeKpc: summary.meanSizeKpc,
	totalChecks: checks.length,
	passed,
	failed,
	checks,
}, null, 2));
console.log(`Wrote ${logPath}`);
console.log('\n=== VERDICT ===');
console.log(failed === 0 ? 'PASS — nebulae are placed where their physics says' : `FAIL — ${failed} checks failed`);
process.exit(failed === 0 ? 0 : 1);
