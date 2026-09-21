// experiments/object-placement-test.js
// Validates the 0.3.2a composite objects:
//   - each type lands in its environment (HII on the ridges, open clusters in
//     the disc, globulars central, planetaries inner, SNR tracing thin+arms)
//   - member offsets follow Plummer / King / the fractal gate, exactly bounded
//   - richness is apportioned over the fixed block (exact total, min-1 each)
//   - placement and members are deterministic in the seed
//   - type shares follow the gas budget (quenched: zero HII/open)
//   - 400 whole-galaxy objects fill the 20k member budget for every type
//
// Output: experiments/logs/object-placement.json

'use strict';

const fs = require('fs');
const path = require('path');
const density = require('../src/math/density.js');
const galaxy = require('../src/math/galaxy.js');
const objects = require('../src/math/objects.js');
const records = require('../src/math/star-record.js');
const starTypes = require('../src/math/star-types.js');

const model = galaxy.MILKY_WAY;

const SEED = 99;
const N_OBJECTS = 1200;
const BOX = { xMin: -20, xMax: 20, yMin: -20, yMax: 20, zMin: -2, zMax: 2 };

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
	return !!pass;
}

const mean = (list, f) => list.reduce((a, x) => a + f(x), 0) / Math.max(1, list.length);

// --- Constants -----------------------------------------------------------
{
	check('five object types, in the documented order',
		JSON.stringify(objects.OBJECT_TYPES) === JSON.stringify(['HII', 'open', 'globular', 'planetary', 'SNR']),
		objects.OBJECT_TYPES);
	check('the member budget is 20000 StarPacked records (320 KB)',
		objects.OBJECT_MEMBERS_DEFAULT === 20000, objects.OBJECT_MEMBERS_DEFAULT);
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
	check('all five object types are present',
		objects.OBJECT_TYPES.every(t => counts[t] > 0), counts);
	check('HII regions are present but not dominant',
		counts.HII > 0 && counts.HII / placed.length < 0.35, counts.HII / placed.length);
}

// --- Spatial sanity ------------------------------------------------------
{
	const hII = placed.filter(o => o.type === 'HII');
	const open = placed.filter(o => o.type === 'open');
	const globular = placed.filter(o => o.type === 'globular');
	const planetary = placed.filter(o => o.type === 'planetary');
	const snr = placed.filter(o => o.type === 'SNR');

	check('HII regions sit on the arm ridges (mean distance-to-arm < 0.35 kpc)',
		mean(hII, o => o.distToArm) < 0.35, +mean(hII, o => o.distToArm).toFixed(3));
	check('HII regions hug the arms tighter than the disc-wide open clusters',
		mean(hII, o => o.distToArm) < mean(open, o => o.distToArm),
		{ hII: +mean(hII, o => o.distToArm).toFixed(3), open: +mean(open, o => o.distToArm).toFixed(3) });
	check('open clusters stay in the thin disc (mean |zp| < 0.3 kpc)',
		mean(open, o => Math.abs(o.zp)) < 0.3, +mean(open, o => Math.abs(o.zp)).toFixed(3));
	check('globulars concentrate centrally (mean R < 3 kpc, bulge-dominated majority)',
		mean(globular, o => o.R) < 3.0
		&& globular.filter(o => o.dominant === 'bulge').length / globular.length > 0.5,
		{ meanR: +mean(globular, o => o.R).toFixed(2),
			bulgeFrac: +(globular.filter(o => o.dominant === 'bulge').length / globular.length).toFixed(2) });
	check('planetaries favour the inner galaxy (R < 3 kpc for over 40%)',
		planetary.filter(o => o.R < 3).length / planetary.length > 0.4,
		+(planetary.filter(o => o.R < 3).length / planetary.length).toFixed(2));
	const snrThin = snr.filter(o => o.component === 'thin').length / snr.length;
	check('SNR trace the thin disc and the arms (thin majority, mean arm distance < 5 kpc)',
		snrThin > 0.5 && mean(snr, o => o.distToArm) < 5.0,
		{ thinFrac: +snrThin.toFixed(2), meanArm: +mean(snr, o => o.distToArm).toFixed(2) });

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
		if (o.type === 'open' && (!inRange(o.size, 0.010, 0.030) || !inRange(Math.log10(o.ageGyr), -2, 0))) bad++;
		if (o.type === 'globular' && (!inRange(o.size, 0.001, 0.003) || !inRange(o.ageGyr, 10, 13))) bad++;
	}
	check('richness, size and age stay inside the documented ranges', bad === 0, bad);
	const planetary = placed.filter(o => o.type === 'planetary');
	check('every planetary is one central star with the 2 pc shell size',
		planetary.every(o => o.richness === 1 && o.size === 0.002), planetary.length);
	const snr = placed.filter(o => o.type === 'SNR');
	check('SNR carry no members and a 20-120 pc shell size',
		snr.every(o => o.richness === 0 && inRange(o.size, 0.020, 0.120)), snr.length);
}

// --- Plummer members -----------------------------------------------------
{
	const obj = { type: 'open', seed: 12345, size: 0.02, richness: 20000 };
	const out = new Float64Array(3);
	const N = 20000;
	const radii = new Float64Array(N);
	for (let i = 0; i < N; i++) {
		objects.sampleMemberOffset(obj, i, out);
		radii[i] = Math.sqrt(out[0] * out[0] + out[1] * out[1] + out[2] * out[2]);
	}
	const enclosed = (r) => Math.pow(r, 3) / Math.pow(r * r + 0.001 * 0.001, 1.5);
	const total = enclosed(0.02);
	const fracBelow = (r) => {
		let n = 0;
		for (let i = 0; i < N; i++) if (radii[i] < r) n++;
		return n / N;
	};
	let worst = 0;
	for (const r of [0.001, 0.005, 0.01]) worst = Math.max(worst, Math.abs(fracBelow(r) - enclosed(r) / total));
	check('open members follow the truncated Plummer enclosed-mass curve (within 0.02)',
		worst < 0.02, +worst.toFixed(4));
	let max = 0;
	for (let i = 0; i < N; i++) if (radii[i] > max) max = radii[i];
	check('no open member leaves the tidal radius', max <= 0.02 * (1 + 1e-9), +max.toFixed(5));
}

// --- King members --------------------------------------------------------
{
	const RC = 0.002;
	const obj = { type: 'globular', seed: 777, size: RC, richness: 20000 };
	const out = new Float64Array(3);
	const N = 20000;
	const radii = new Float64Array(N);
	for (let i = 0; i < N; i++) {
		objects.sampleMemberOffset(obj, i, out);
		radii[i] = Math.sqrt(out[0] * out[0] + out[1] * out[1] + out[2] * out[2]) / RC;
	}
	// The documented profile, re-typed: rho(x) ~ ((1+x^2)^-1/2 - (1+12^2)^-1/2)^2.
	const kingProfile = (x) => {
		const t = 1 / Math.sqrt(1 + x * x) - 1 / Math.sqrt(1 + 144);
		return t > 0 ? 4 * Math.PI * x * x * t * t : 0;
	};
	const kingCdf = (x) => {
		const S = 2048;
		const h = x / S;
		let s = kingProfile(0) + kingProfile(x);
		for (let i = 1; i < S; i++) s += (i & 1 ? 4 : 2) * kingProfile(i * h);
		return h * s / 3;
	};
	const total = kingCdf(12);
	const fracBelow = (x) => {
		let n = 0;
		for (let i = 0; i < N; i++) if (radii[i] < x) n++;
		return n / N;
	};
	let worst = 0;
	for (const x of [1, 3, 6, 9]) worst = Math.max(worst, Math.abs(fracBelow(x) - kingCdf(x) / total));
	check('globular members follow the King W0~6 curve (within 0.02)', worst < 0.02, +worst.toFixed(4));
	let max = 0;
	for (let i = 0; i < N; i++) if (radii[i] > max) max = radii[i];
	check('no globular member leaves the tidal radius (12 r_c)', max <= 12 * (1 + 1e-9), +max.toFixed(3));
	const sorted = Array.from(radii).sort((a, b) => a - b);
	check('half the globular members sit inside 4.5 core radii (concentrated)',
		sorted[N >> 1] > 2.5 && sorted[N >> 1] < 4.5, +sorted[N >> 1].toFixed(3));
}

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
	const q = new Uint16Array(placed.length);
	objects.objectQuotas(placed, objects.OBJECT_MEMBERS_DEFAULT, q);
	let sum = 0;
	let minNonzero = Infinity;
	for (let j = 0; j < placed.length; j++) {
		sum += q[j];
		if (placed[j].richness > 0 && q[j] < minNonzero) minNonzero = q[j];
	}
	check('the placed field apportions to exactly the 20k budget, every object kept',
		sum === objects.OBJECT_MEMBERS_DEFAULT && minNonzero >= 1, { sum, minNonzero });
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
	check('a quenched elliptical has zero HII regions and zero open clusters',
		(e4Counts.HII || 0) === 0 && (e4Counts.open || 0) === 0, e4Counts);
	const sc = galaxy.createGalaxy({ type: 'Sc' });
	const scObjects = objects.placeObjects(sc, SEED, 400, null);
	const scCounts = objects.summariseObjects(scObjects).byType;
	const young = (scCounts.HII || 0) + (scCounts.open || 0);
	check('a gas-rich Sc is HII regions and open clusters in the majority',
		young / scObjects.length > 0.5, { youngFrac: +(young / scObjects.length).toFixed(2), ...scCounts });
}

// --- Every type fills the budget -----------------------------------------
{
	const cap = objects.OBJECT_MEMBERS_DEFAULT;
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
		if (written !== cap) { failedType = `${type} (written ${written})`; break; }
	}
	check('400 whole-galaxy objects fill the 20k budget for every one of the 19 types',
		failedType === null, { types: galaxy.GALAXY_TYPES.length, failedType, minMembers, minType });
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

	const glob10 = placed.filter(o => o.type === 'globular').slice(0, 10);
	const globCap = glob10.reduce((a, o) => a + o.richness, 0);
	const globBuf = new ArrayBuffer(globCap * records.RECORD_BYTES);
	const globWritten = objects.writeObjectMembers(model, glob10, new DataView(globBuf), 0, globCap).written;
	const globDv = new DataView(globBuf);
	let young = 0;
	let old = 0;
	for (let i = 0; i < globWritten; i++) {
		const cls = records.SPECTRAL_CLASSES[records.readRecord(globDv, i * records.RECORD_BYTES).colorIndex];
		if (cls === 'O' || cls === 'B' || cls === 'A' || cls === 'F') young++;
		if (cls === 'RG' || cls === 'WD') old++;
	}
	check('globular members have no O/B/A/F stars', young === 0, young);
	check('globular members show the old mix (RG+WD over 1%)',
		old / globWritten > 0.01, { old, written: globWritten, frac: +(old / globWritten).toFixed(4) });

	const open10 = placed.filter(o => o.type === 'open').slice(0, 10);
	const openCap = open10.reduce((a, o) => a + o.richness, 0);
	const openBuf = new ArrayBuffer(openCap * records.RECORD_BYTES);
	const openWritten = objects.writeObjectMembers(model, open10, new DataView(openBuf), 0, openCap).written;
	const openDv = new DataView(openBuf);
	let openYoung = 0;
	let openOld = 0;
	for (let i = 0; i < openWritten; i++) {
		const cls = records.SPECTRAL_CLASSES[records.readRecord(openDv, i * records.RECORD_BYTES).colorIndex];
		if (cls === 'O' || cls === 'B' || cls === 'A' || cls === 'F') openYoung++;
		if (cls === 'RG' || cls === 'WD') openOld++;
	}
	check('open clusters span young and old (O/B/A/F and WD/RG both present)',
		openYoung >= 5 && openOld >= 2, { openYoung, openOld });

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
	check('writeObjectBillboards packs one record per gas object and skips clusters',
		written === gas.length && written < placed.length, { written, gas: gas.length, total: placed.length });
	const view = new DataView(buf);
	let tintOk = 0;
	for (let i = 0; i < written; i++) {
		const want = nebula.NEBULA_COLORS[gas[i].type];
		const r = view.getFloat32(i * 32 + 16, true);
		const g = view.getFloat32(i * 32 + 20, true);
		const b = view.getFloat32(i * 32 + 24, true);
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
	check('the billboard record is 32 bytes (8 f32)',
		objects.BILLBOARD_RECORD_BYTES === 32 && objects.BILLBOARD_RECORD_FLOATS === 8);
}

// --- Report --------------------------------------------------------------
console.log(`\nBy type: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log(`Members placed: ${summary.totalMembers} (richness sum, apportioned to ${objects.OBJECT_MEMBERS_DEFAULT})`);

let passed = 0;
let failed = 0;
for (const c of checks) {
	if (c.pass) passed++; else failed++;
	console.log(`  ${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.pass ? '' : `  -> ${JSON.stringify(c.detail)}`}`);
}
console.log(`\n${passed}/${checks.length} passed, ${failed} failed`);

const logPath = path.join(__dirname, 'logs', 'object-placement.json');
fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.writeFileSync(logPath, JSON.stringify({
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
}, null, 2));
console.log(`Wrote ${logPath}`);
console.log('\n=== VERDICT ===');
console.log(failed === 0 ? 'PASS — composite objects land, profile and apportion as documented' : `FAIL — ${failed} checks failed`);
process.exit(failed === 0 ? 0 : 1);
