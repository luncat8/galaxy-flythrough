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

const galaxy = require('../src/math/galaxy.js');
const model = galaxy.MILKY_WAY;

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
const nebulae = nebula.placeNebulae(model, SEED, N_NEBULAE, BOX);
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
	// The gas lane is the model's young ridge, which widens with radius, so the
	// outer disc contributes a few more of these than a fixed-width gate did
	// (60 of 1200 against 59). What this guards is nebulae leaking out of the
	// disc, not the disc's own vertical tail.
	check('almost no nebula sits in the halo or above |z| = 1 kpc', haloish / nebulae.length < 0.06,
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
	const again = nebula.placeNebulae(model, SEED, 50, BOX);
	const other = nebula.placeNebulae(model, SEED + 1, 50, BOX);
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
	// must peak on the arm ridge. The probe sits on the crest the arm field
	// draws (density.armRidgeAzimuth), not on an approximation of it.
	const GC = model.centre;
	const armR = 5.0;
	const armPhi = density.armRidgeAzimuth(model, armR);
	const centre = nebula.nebulaProbabilityAt(model, GC.x, GC.y, 0);
	const arm = nebula.nebulaProbabilityAt(model, GC.x + armR * Math.cos(armPhi), GC.y + armR * Math.sin(armPhi), 0.02);
	const halo = nebula.nebulaProbabilityAt(model, 0, 0, 12);
	check('the galactic centre is not a nebula nursery', centre.p < arm.p && centre.p < 0.03, centre.p);
	check('the halo is strongly suppressed', halo.p < 0.002, halo.p);
	check('an arm mid-disc position has a real probability', arm.p > 0.01, arm.p);
	check('the centre prefers a stellar (planetary) type', centre.type === 'planetary', centre.type);
}

// --- The lane is the model's young ridge ---------------------------------
{
	// The gas probability off the crest must fall as exp(-d^2/2 sigma^2) with the
	// model's own ridge width (density.armRidgeWidth), the same lane the O/B
	// stars are born in. Two details make the measurement honest. First, the
	// probe steps off the crest *perpendicular to it* — the ridge's tangent comes
	// from two nearby crest points — because an azimuthal offset crosses the lane
	// at an angle and would measure the pitch angle rather than the width.
	// Second, the distance the probe actually landed at is measured by scanning
	// the crest line itself, not by trusting distanceToNearestArm, which is the
	// geometry under test. The off-lane baseline is the point halfway between two
	// ridges (lambda/2, i.e. 4.6-4.8 sigma, past the arm boost's 2.4 sigma
	// cutoff) at the same radius, so every other factor in the probability
	// cancels exactly and what is left is the gate.
	for (const type of ['Sa', 'Sd']) {
		const m = galaxy.createGalaxy({ type });
		const gc = m.centre;
		const R = 6.0;
		const sigma = density.armRidgeWidth(m, R);
		const crestPoint = (r) => {
			const phi = density.armRidgeAzimuth(m, r);
			return [gc.x + r * Math.cos(phi), gc.y + r * Math.sin(phi)];
		};
		const crest = [];
		for (let i = 0; i <= 2000; i++) crest.push(crestPoint(R * 0.5 + i * (R * 1.0) / 2000));
		const distanceToCrest = (p) => {
			let best = Infinity;
			for (const c of crest) {
				const d = Math.hypot(c[0] - p[0], c[1] - p[1]);
				if (d < best) best = d;
			}
			return best;
		};
		const a = crestPoint(R - sigma * 0.25);
		const b = crestPoint(R + sigma * 0.25);
		const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
		const nx = (a[1] - b[1]) / len;
		const ny = (b[0] - a[0]) / len;
		const mid = [0.5 * (a[0] + b[0]), 0.5 * (a[1] + b[1])];
		const stepOff = (s) => [mid[0] + s * nx, mid[1] + s * ny];
		const phiFar = density.armRidgeAzimuth(m, R) + Math.PI / m.arms.m;
		const far = [gc.x + R * Math.cos(phiFar), gc.y + R * Math.sin(phiFar)];
		const at = (p) => nebula.nebulaProbabilityAt(m, p[0], p[1], 0.02).p;
		const baseline = at(far);
		const pOn = stepOff(0);
		const pOff = stepOff(sigma);
		const on = at(pOn) - baseline;
		const off = at(pOff) - baseline;
		const dOn = distanceToCrest(pOn);
		const dOff = distanceToCrest(pOff);
		const rOn = Math.hypot(pOn[0] - gc.x, pOn[1] - gc.y);
		const rOff = Math.hypot(pOff[0] - gc.x, pOff[1] - gc.y);
		const zOn = dOn / density.armRidgeWidth(m, rOn);
		const zOff = dOff / density.armRidgeWidth(m, rOff);
		const expected = Math.exp(-0.5 * (zOff * zOff - zOn * zOn));
		check(`${type}: nebula gas falls as exp(-d^2/2 sigma^2) with the model's own ridge width`,
			Math.abs(off / on - expected) < 0.03 && dOff > 0.9 * sigma,
			{ sigma: +sigma.toFixed(3), measured: +(off / on).toFixed(4), expected: +expected.toFixed(4),
				dOn: +dOn.toFixed(4), dOff: +dOff.toFixed(4), baseline: +baseline.toFixed(5) });
	}
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
