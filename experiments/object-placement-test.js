// experiments/object-placement-test.js
// Validates the 0.3.2a composite objects — the GAS layer only since the
// star clusters moved to clusters.js (plan §10; globulars are star
// clusters inside this galaxy, not nebulae and not other galaxies):
//   - each type lands in its environment (HII on the ridges, planetaries
//     inner, SNR tracing thin+arms); no 'open'/'globular' type exists here
//   - member offsets follow the fractal gate, exactly bounded
//   - richness is apportioned over the member allowance (exact total,
//     min-1 each), and the allowance scales with the field star count
//   - placement and members are deterministic in the seed
//   - type shares follow the gas budget (quenched: zero HII)
//   - the gas block writes exactly min(allowance, richness sum)
//
// Output: experiments/logs/object-placement.json

'use strict';

const path = require('path');
const logFile = require('./log-file.js');
const density = require('../src/math/density.js');
const galaxy = require('../src/math/galaxy.js');
const objects = require('../src/math/objects.js');
const records = require('../src/math/star-record.js');
const starTypes = require('../src/math/star-types.js');

const model = galaxy.MILKY_WAY;

const SEED = 99;
// 1200 objects left only ~100 HII regions, and the arm-hugging means below
// then swung +-0.1 kpc between realisations (0.4.8 M3.1 changed one and the
// check tripped on noise, not on physics). 6000 puts ~600 in each mean.
const N_OBJECTS = 6000;
const BOX = { xMin: -20, xMax: 20, yMin: -20, yMax: 20, zMin: -2, zMax: 2 };

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
	return !!pass;
}

const mean = (list, f) => list.reduce((a, x) => a + f(x), 0) / Math.max(1, list.length);

// --- Constants -----------------------------------------------------------
{
	check('the gas layer has exactly three types (star clusters live in clusters.js, not here)',
		JSON.stringify(objects.OBJECT_TYPES) === JSON.stringify(['HII', 'planetary', 'SNR']),
		objects.OBJECT_TYPES);
	check('the gas member allowance scales with the field star count (1% of it)',
		objects.gasMemberBudget(100000) === 1000 && objects.gasMemberBudget(200000) === 2000
		&& objects.gasMemberBudget(0) === 0,
		{ at100k: objects.gasMemberBudget(100000), at200k: objects.gasMemberBudget(200000) });
	check('the renderer places 400 whole-galaxy objects',
		objects.OBJECT_COUNT_DEFAULT === 400, objects.OBJECT_COUNT_DEFAULT);
}

// --- Placement -----------------------------------------------------------
console.log(`Placing ${N_OBJECTS} objects in the box...`);
const t0 = Date.now();
const placed = objects.placeObjects(model, SEED, N_OBJECTS, BOX);
const placeMs = Date.now() - t0;
console.log(`  placed ${placed.length} in ${placeMs} ms`);
check('the placer reaches the requested count', placed.length === N_OBJECTS, placed.length);

const summary = objects.summariseObjects(placed);
const counts = summary.byType;
{
	check('all three gas types are present (no open/globular classes remain)',
		objects.OBJECT_TYPES.every(t => counts[t] > 0) && counts.open === undefined && counts.globular === undefined, counts);
	check('HII regions are present but not dominant',
		counts.HII > 0 && counts.HII / placed.length < 0.35, counts.HII / placed.length);
}

// --- Spatial sanity ------------------------------------------------------
{
	const hII = placed.filter(o => o.type === 'HII');
	const planetary = placed.filter(o => o.type === 'planetary');
	const snr = placed.filter(o => o.type === 'SNR');

	check('HII regions sit on the arm ridges (mean distance-to-arm < 0.35 kpc)',
		mean(hII, o => o.distToArm) < 0.35, +mean(hII, o => o.distToArm).toFixed(3));
	check('HII regions hug the arms tighter than the galaxy mean (planetaries trace stars, not gas)',
		mean(hII, o => o.distToArm) < mean(planetary, o => o.distToArm),
		{ hII: +mean(hII, o => o.distToArm).toFixed(3), planetary: +mean(planetary, o => o.distToArm).toFixed(3) });
	check('planetaries favour the inner galaxy (R < 3 kpc for over 40%)',
		planetary.filter(o => o.R < 3).length / planetary.length > 0.4,
		+(planetary.filter(o => o.R < 3).length / planetary.length).toFixed(2));
	const snrThin = snr.filter(o => o.component === 'thin').length / snr.length;
	// distToArm is 99 inside the arm inner edge (the bar region has no ridge to
	// be near), so the arm statistic runs over the arm region only.
	const snrArms = snr.filter(o => o.R >= model.arms.minRadius);
	check('SNR trace the thin disc and the arms (thin majority, mean arm distance < 5 kpc in the arm region)',
		snrThin > 0.5 && snrArms.length > 0 && mean(snrArms, o => o.distToArm) < 5.0,
		{ thinFrac: +snrThin.toFixed(2), meanArm: +mean(snrArms, o => o.distToArm).toFixed(2) });

	const haloish = placed.filter(o => o.component === 'halo' || Math.abs(o.z) > 1.0).length;
	check('almost no object leaks into the halo or above |z| = 1 kpc',
		haloish / placed.length < 0.06, { haloish, fraction: +(haloish / placed.length).toFixed(4) });

	const allInside = placed.every(o => o.x >= BOX.xMin && o.x <= BOX.xMax
		&& o.y >= BOX.yMin && o.y <= BOX.yMax && o.z >= BOX.zMin && o.z <= BOX.zMax);
	check('every object lies inside the requested box', allInside);
}

// --- Richness / size / age ranges ----------------------------------------
{
	const inRange = (v, lo, hi) => v >= lo && v <= hi;
	let bad = 0;
	for (const o of placed) {
		const range = objects.RICHNESS[o.type];
		if (!inRange(o.richness, range[0], range[1])) bad++;
		if (o.type === 'HII' && (!inRange(o.size, 0.05, 0.15) || !inRange(o.ageGyr, 0.001, 0.020))) bad++;
	}
	check('richness, size and age stay inside the documented ranges', bad === 0, bad);
	const planetary = placed.filter(o => o.type === 'planetary');
	check('every planetary is one central star with the 2 pc shell size',
		planetary.every(o => o.richness === 1 && o.size === 0.002), planetary.length);
	const snr = placed.filter(o => o.type === 'SNR');
	check('SNR carry no members and a 20-120 pc shell size',
		snr.every(o => o.richness === 0 && inRange(o.size, 0.020, 0.120)), snr.length);
}

// (The Plummer member profile moved with the star clusters to
// star-cluster-test.js; the fixed King profile went with the class.)

// --- Fractal members -----------------------------------------------------
{
	const RE = 0.1;
	const obj = { type: 'HII', seed: 4242, size: RE, richness: 10000 };
	const out = new Float64Array(3);
	const N = 10000;
	let max = 0;
	let above = 0;
	for (let i = 0; i < N; i++) {
		objects.sampleMemberOffset(obj, i, out);
		const r = Math.sqrt(out[0] * out[0] + out[1] * out[1] + out[2] * out[2]);
		if (r > max) max = r;
		if (density.fbm3D(out[0] / RE, out[1] / RE, out[2] / RE, 4242) > 0) above++;
	}
	check('no association member leaves the 2.5 R_e sphere', max <= 2.5 * RE * (1 + 1e-9),
		+(max / RE).toFixed(3));
	check('at least 99% of association members sit where the noise is above 0',
		above / N >= 0.99, +(above / N).toFixed(4));
	const a = new Float64Array(3);
	const b = new Float64Array(3);
	objects.sampleMemberOffset(obj, 137, a);
	objects.sampleMemberOffset(obj, 137, b);
	check('the fractal draw is deterministic in (object, member)',
		a[0] === b[0] && a[1] === b[1] && a[2] === b[2]);
}

// --- Planetary members ---------------------------------------------------
{
	const out = new Float64Array(3);
	objects.sampleMemberOffset({ type: 'planetary', seed: 5, size: 0.002, richness: 1 }, 0, out);
	check('the planetary central star sits exactly on the object centre',
		out[0] === 0 && out[1] === 0 && out[2] === 0);
}

// --- Apportionment -------------------------------------------------------
{
	const mk = (richness) => ({ richness });
	const quotas = (list, cap) => Array.from(objects.objectQuotas(list.map(mk), cap, new Uint16Array(list.length)));
	check('equal richness splits the budget evenly ([10,10,10] cap 20 -> [6,7,7])',
		JSON.stringify(quotas([10, 10, 10], 20)) === JSON.stringify([6, 7, 7]), quotas([10, 10, 10], 20));
	const skewed = quotas([100, 10, 10], 60);
	check('skewed richness keeps its contrast with an exact total ([100,10,10] cap 60)',
		skewed[0] + skewed[1] + skewed[2] === 60 && skewed[0] > skewed[1] && skewed[1] >= 1 && skewed[2] >= 1,
		skewed);
	check('when everything fits, quotas are the richnesses',
		JSON.stringify(quotas([5, 0, 3], 20)) === JSON.stringify([5, 0, 3]), quotas([5, 0, 3], 20));
	check('when even one member each does not fit, the first objects win in order',
		JSON.stringify(quotas([5, 5, 5], 2)) === JSON.stringify([1, 1, 0]), quotas([5, 5, 5], 2));
	const q = new Uint32Array(placed.length);
	const scaledCap = objects.gasMemberBudget(1000000);
	objects.objectQuotas(placed, scaledCap, q);
	let sum = 0;
	let minNonzero = Infinity;
	for (let j = 0; j < placed.length; j++) {
		sum += q[j];
		if (placed[j].richness > 0 && q[j] < minNonzero) minNonzero = q[j];
	}
	check('the placed field apportions to exactly the scaled gas allowance, every object kept',
		sum === scaledCap && minNonzero >= 1, { sum, scaledCap, minNonzero });
	check('relative cluster weights fill the budget through the same code (clusters reuse objectQuotas)',
		(() => {
			const wq = objects.objectQuotas([{ weight: 1 }, { weight: 3 }, { weight: 16 }], 100, new Uint32Array(3), true);
			return wq[0] + wq[1] + wq[2] === 100 && wq[0] >= 1 && wq[2] > wq[1];
		})(), Array.from(objects.objectQuotas([{ weight: 1 }, { weight: 3 }, { weight: 16 }], 100, new Uint32Array(3), true)));
}

// --- Stability -----------------------------------------------------------
{
	const again = objects.placeObjects(model, SEED, 50, BOX);
	const other = objects.placeObjects(model, SEED + 1, 50, BOX);
	let identical = again.length === 50;
	let differing = 0;
	for (let i = 0; i < again.length; i++) {
		if (again[i].x !== placed[i].x || again[i].type !== placed[i].type
			|| again[i].richness !== placed[i].richness || again[i].size !== placed[i].size
			|| again[i].ageGyr !== placed[i].ageGyr) identical = false;
		if (again[i].x !== other[i].x || again[i].type !== other[i].type) differing++;
	}
	check('placement is deterministic in the seed', identical);
	check('a different seed moves the objects', differing > 45, differing);

	const cap = 20000;
	const bufA = new ArrayBuffer(cap * records.RECORD_BYTES);
	const bufB = new ArrayBuffer(cap * records.RECORD_BYTES);
	const bufC = new ArrayBuffer(cap * records.RECORD_BYTES);
	const wA = objects.writeObjectMembers(model, placed, new DataView(bufA), 0, cap);
	const wB = objects.writeObjectMembers(model, placed, new DataView(bufB), 0, cap);
	const wC = objects.writeObjectMembers(model, other, new DataView(bufC), 0, cap);
	const bytesA = new Uint8Array(bufA);
	const bytesB = new Uint8Array(bufB);
	const bytesC = new Uint8Array(bufC);
	let sameBytes = 0;
	let diffRecords = 0;
	for (let i = 0; i < bytesA.length; i++) if (bytesA[i] === bytesB[i]) sameBytes++;
	for (let r = 0; r < Math.min(wA.written, wC.written); r++) {
		let same = true;
		for (let k = 0; k < records.RECORD_BYTES; k++) {
			if (bytesA[r * records.RECORD_BYTES + k] !== bytesC[r * records.RECORD_BYTES + k]) { same = false; break; }
		}
		if (!same) diffRecords++;
	}
	check('members are byte-identical for the same seed',
		wA.written === wB.written && sameBytes === bytesA.length, { written: wA.written, sameBytes });
	check('a different seed moves essentially every member',
		diffRecords > 0.95 * Math.min(wA.written, wC.written), { diffRecords, written: wA.written });
}

// --- Shares follow the gas budget ----------------------------------------
{
	const e4 = galaxy.createGalaxy({ type: 'E4' });
	const e4Objects = objects.placeObjects(e4, SEED, 400, null);
	const e4Counts = objects.summariseObjects(e4Objects).byType;
	check('a quenched elliptical has zero HII regions (its clusters live in the cluster layer)',
		(e4Counts.HII || 0) === 0, e4Counts);
	const sc = galaxy.createGalaxy({ type: 'Sc' });
	const scObjects = objects.placeObjects(sc, SEED, 400, null);
	const scCounts = objects.summariseObjects(scObjects).byType;
	check('a gas-rich Sc grows HII regions the quenched E4 cannot',
		(scCounts.HII || 0) > 0, scCounts);
}

// --- The gas block against its scaled allowance --------------------------
{
	// The allowance is 1% of the field budget, so at 100k field stars the
	// gas layer may draw 1000 members — never more, and exactly that when
	// the placed richness covers it. A quenched elliptical's planetaries
	// (richness 1 each) genuinely cannot fill it; the written count is
	// then the richness sum, not a padded number.
	const cap = objects.gasMemberBudget(100000);
	const buf = new ArrayBuffer(cap * records.RECORD_BYTES);
	const view = new DataView(buf);
	let failedType = null;
	let minMembers = Infinity;
	let minType = null;
	for (const type of galaxy.GALAXY_TYPES) {
		const m = galaxy.createGalaxy({ type });
		const objs = objects.placeObjects(m, SEED, objects.OBJECT_COUNT_DEFAULT, null);
		const totalMembers = objs.reduce((a, o) => a + o.richness, 0);
		if (totalMembers < minMembers) { minMembers = totalMembers; minType = type; }
		const written = objects.writeObjectMembers(m, objs, view, 0, cap).written;
		if (written !== Math.min(cap, totalMembers)) { failedType = `${type} (written ${written}, richness ${totalMembers})`; break; }
	}
	check('the gas block writes exactly min(allowance, placed richness) for every galaxy type',
		failedType === null, { types: galaxy.GALAXY_TYPES.length, failedType, minMembers, minType });
	const mwObjs = objects.placeObjects(model, SEED, objects.OBJECT_COUNT_DEFAULT, null);
	const mwWritten = objects.writeObjectMembers(model, mwObjs, view, 0, cap).written;
	check('the Milky Way gas layer fills its 100k-field allowance exactly',
		mwWritten === cap, { mwWritten, cap });
}

// --- Empty model ---------------------------------------------------------
{
	const empty = galaxy.createGalaxy({ type: 'E4', overrides: { spheroid: { amp: 0 } } });
	check('an empty model yields no objects', objects.placeObjects(empty, SEED, 400, null).length === 0);
}

// --- Member populations --------------------------------------------------
{
	const hII = placed.filter(o => o.type === 'HII');
	const hIICap = hII.reduce((a, o) => a + o.richness, 0);
	const hIIBuf = new ArrayBuffer(hIICap * records.RECORD_BYTES);
	const hIIWritten = objects.writeObjectMembers(model, hII, new DataView(hIIBuf), 0, hIICap).written;
	const hIIDv = new DataView(hIIBuf);
	let ob = 0;
	for (let i = 0; i < hIIWritten; i++) {
		const cls = records.SPECTRAL_CLASSES[records.readRecord(hIIDv, i * records.RECORD_BYTES).colorIndex];
		if (cls === 'O' || cls === 'B') ob++;
	}
	check('association members include O/B stars (over 0.3% of the HII census)',
		ob / hIIWritten > 0.003, { ob, written: hIIWritten, frac: +(ob / hIIWritten).toFixed(4) });

	// (Member populations of star clusters — the old-mix check that used to
	// run on 'globular' objects — moved to star-cluster-test.js.)

	const central = starTypes.derivePlanetaryCentral(424242, 2, 1.5, 99, {});
	check('the planetary central star is a hot luminous O star',
		central.spectralClass === 'O' && central.teff >= 30000 && central.teff <= 100000
		&& central.absMag >= -6 && central.absMag <= 0 && central.state === 'ms',
		{ class: central.spectralClass, teff: Math.round(central.teff), absMag: +central.absMag.toFixed(2) });

	const ref = starTypes.deriveStar(model, 777001, 0, 8.0, 0.2, {});
	const same = starTypes.deriveStarWithAge(model, 777001, 0, 8.0, 0.2, ref.age, {});
	const keys = ['mass', 'age', 'teff', 'luminosity', 'state', 'spectralClass',
		'colorIndex', 'absMag', 'metallicity', 'component', 'R', 'distToArm'];
	check('the age override with the sampled age reproduces deriveStar exactly',
		keys.every(k => same[k] === ref[k]));
}

// --- Billboards (0.3.2b) -------------------------------------------------
{
	const Camera = require('../src/core/camera.js');
	const nebula = require('../src/math/nebula.js');
	const gas = placed.filter(o => objects.objectHasGas(o.type));
	const buf = new ArrayBuffer(gas.length * objects.BILLBOARD_RECORD_BYTES);
	const written = objects.writeObjectBillboards(placed, new DataView(buf), 0, placed.length);
	check('writeObjectBillboards packs one record per object — every type here is gas (clusters never reach it)',
		written === gas.length && written === placed.length, { written, gas: gas.length, total: placed.length });
	const view = new DataView(buf);
	let tintOk = 0;
	for (let i = 0; i < written; i++) {
		const want = nebula.NEBULA_COLORS[gas[i].type];
		const r = view.getFloat32(i * objects.BILLBOARD_RECORD_BYTES + 16, true);
		const g = view.getFloat32(i * objects.BILLBOARD_RECORD_BYTES + 20, true);
		const b = view.getFloat32(i * objects.BILLBOARD_RECORD_BYTES + 24, true);
		if (r === Math.fround(want[0]) && g === Math.fround(want[1]) && b === Math.fround(want[2])) tintOk++;
	}
	check('billboard tints are NEBULA_COLORS for the object type', tintOk === written, { tintOk, written });

	const e4 = galaxy.createGalaxy({ type: 'E4' });
	const e4Objects = objects.placeObjects(e4, SEED, 400, null);
	const e4Gas = e4Objects.filter(o => objects.objectHasGas(o.type));
	check('a quenched E4 still billboards planetaries and SNR, never HII',
		e4Gas.length > 0 && e4Gas.every(o => o.type === 'planetary' || o.type === 'SNR'),
		objects.summariseObjects(e4Objects).byType);

	const fov = Camera.FOV_Y;
	check('the 4 px / 5 kpc cull: nearby HII drawn, distant smear dropped, tiny planetary dropped',
		objects.billboardVisible(0.1, 1, 1080, fov)
		&& !objects.billboardVisible(0.1, 5.1, 1080, fov)
		&& !objects.billboardVisible(0.002, 1, 1080, fov));
	check('the billboard record is 48 bytes (12 scalar slots)',
		objects.BILLBOARD_RECORD_BYTES === 48 && objects.BILLBOARD_RECORD_FLOATS === 12);
}

// --- 0.7.5: carried local rates and member placement ---------------------
{
	const gas = require('../src/math/gas-grid.js');
	const orbit = require('../src/math/orbit.js');
	const account = gas.initialize(model, galaxy.AGE_REF, model.seed);
	const buf = new ArrayBuffer(placed.length * objects.BILLBOARD_RECORD_BYTES);
	const view = new DataView(buf);
	objects.writeObjectBillboards(placed, view, 0, placed.length, account);
	let mapped = 0, valid = true;
	for (let i = 0; i < placed.length; i++) {
		const obj = placed[i], o = i * objects.BILLBOARD_RECORD_BYTES;
		const hii = obj.type === 'HII';
		const cell = hii ? gas.cellAt(account.geometry, Math.fround(obj.x), Math.fround(obj.y), Math.fround(obj.z)) : -1;
		valid = valid && view.getInt32(o + 32, true) === cell
			&& view.getFloat32(o + 36, true) === Math.fround(hii ? gas.rateScale(account, cell) : -1)
			&& view.getFloat32(o + 40, true) === Math.fround(obj.formedAt)
			&& view.getUint32(o + 44, true) === (hii ? 1 : 0);
		if (hii && cell >= 0) mapped++;
	}
	check('the shipping billboard packer carries source cell, local scale and the actual object birth', valid && mapped > 0,
		{ mapped, total: placed.length });

	const pair = [placed.find((o) => o.type === 'HII'), placed.find((o) => o.type === 'planetary')];
	const plain = new DataView(new ArrayBuffer(2 * records.RECORD_BYTES));
	const offset = new DataView(new ArrayBuffer(2 * records.RECORD_BYTES));
	objects.writeObjectMembers(model, pair, plain, 0, 2, 0);
	objects.writeObjectMembers(model, pair, offset, 0, 2, 3);
	const hii = records.readRecord(offset, 0);
	const pn = records.readRecord(offset, records.RECORD_BYTES);
	check('HII members carry the source cell epoch map; stellar remnants do not acquire it',
		(hii.flags & records.FLAG_EPOCH) !== 0 && (pn.flags & records.FLAG_EPOCH) === 0
		&& ((hii.flags >> 3) & 3) === orbit.FAMILY_PATTERN);
	check('epoch-mapped HII members read exposure once from the uniform, not also from the record',
		hii.absMag === records.readRecord(plain, 0).absMag
		&& Math.abs(pn.absMag - records.readRecord(plain, records.RECORD_BYTES).absMag - 3) < records.ABS_MAG_SPAN / 255);
}

// --- Report --------------------------------------------------------------
console.log(`\nBy type: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
	console.log(`Gas members placed: ${summary.totalMembers} (richness sum, apportioned to the scaled gas allowance)`);

let passed = 0;
let failed = 0;
for (const c of checks) {
	if (c.pass) passed++; else failed++;
	console.log(`  ${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.pass ? '' : `  -> ${JSON.stringify(c.detail)}`}`);
}
console.log(`\n${passed}/${checks.length} passed, ${failed} failed`);

const logPath = path.join(__dirname, 'logs', 'object-placement.json');
logFile.writeLog(logPath, {
	date: new Date().toISOString(),
	seed: SEED,
	targetN: N_OBJECTS,
	placedN: placed.length,
	placeMs,
	box: BOX,
	byType: summary.byType,
	byComponent: summary.byComponent,
	totalMembers: summary.totalMembers,
	meanRichness: summary.meanRichness,
	totalChecks: checks.length,
	passed,
	failed,
	checks,
});
console.log('\n=== VERDICT ===');
console.log(failed === 0 ? 'PASS — composite objects land, profile and apportion as documented' : `FAIL — ${failed} checks failed`);
process.exit(failed === 0 ? 0 : 1);
