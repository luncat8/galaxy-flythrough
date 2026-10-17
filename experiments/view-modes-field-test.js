// experiments/view-modes-field-test.js
// View modes (view-modes-plan.md), VM.0: the pure CPU half —
// source selection (constellation anchors, the nearest-N heap
// sweep), the two scalars (camera distance, adjacency depth
// ratio), normalization and the GPU uniform packing.
//
// The synthetic renderer here is the same five-block layout
// star-sprites.js writes (landmarks carrying no FLAG_EPOCH,
// exactly as writeLandmarks packs them), so the sweep walks
// records the way the page does.
//
// Output: experiments/logs/view-modes-field.json

'use strict';

const fs = require('fs');
const path = require('path');

globalThis.window = globalThis;

const galaxy = require('../src/math/galaxy.js');
const records = require('../src/math/star-record.js');
const orbit = require('../src/math/orbit.js');
const landmarks = require('../src/data/landmarks.js');
const field = require('../src/math/view-modes-field.js');

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
	return !!pass;
}

const model = galaxy.createGalaxy({ type: 'SBb', seed: 12345, age: 13.5 });

// --- A synthetic renderer: five blocks, written the way star-sprites writes them
const FIELD_N = 4096;
const LOCAL_N = 40;
const CATALOG_N = 48;
const LANDMARK_N = landmarks.count;
const TOTAL = FIELD_N + LANDMARK_N + LOCAL_N + CATALOG_N;
// The renderer's BLOCK_LAYOUT order — an empty object block
// keeps the kind indices identical to the module's.
const BLOCK_KINDS = ['field', 'landmark', 'object', 'local', 'catalog'];
const offsets = [];
{
	let base = 0;
	for (const name of BLOCK_KINDS) {
		const count = name === 'field' ? FIELD_N
			: name === 'landmark' ? LANDMARK_N
			: name === 'object' ? 0
			: name === 'local' ? LOCAL_N : CATALOG_N;
		offsets.push({ kind: name, offset: base, count });
		base += count;
	}
}
const staging = new ArrayBuffer(TOTAL * records.RECORD_BYTES);
const view = new DataView(staging);
{
	// A deterministic spread: the field block fills a disc so
	// nearest-N answers are unambiguous, the other blocks sit
	// at known spots. Landmarks carry no FLAG_EPOCH — observed
	// sky, exactly as writeLandmarks packs them.
	let slot = 0;
	for (const b of offsets) {
		for (let i = 0; i < b.count; i++, slot++) {
			let x = 0, y = 0, z = 0;
			if (b.kind === 'field') {
				// Spiral-ish disc, radius ≤ 40 kpc, |z| ≤ 1 kpc.
				const r = 40 * Math.sqrt((i + 0.5) / FIELD_N);
				const a = i * 2.399963;
				x = r * Math.cos(a);
				y = r * Math.sin(a);
				z = Math.sin(i * 0.7) * 0.5;
			} else if (b.kind === 'landmark') {
				x = landmarks.positions[i * 3];
				y = landmarks.positions[i * 3 + 1];
				z = landmarks.positions[i * 3 + 2];
			} else if (b.kind === 'local') {
				x = (i % 8) * 0.1; y = ((i >> 3) % 5) * 0.1; z = 0.05 * i;
			} else {
				x = 5 + i * 0.25; y = -3 + i * 0.1; z = 0.2 * i;
			}
			const flags = b.kind === 'landmark'
				? records.FLAG_VISIBLE | records.FLAG_LANDMARK
				: records.FLAG_VISIBLE | records.FLAG_EPOCH;
			records.writeRecord(view, slot * records.RECORD_BYTES,
				x, y, z, 4, 10, flags, 0);
		}
	}
}
const identity = new Uint32Array(TOTAL);
for (let i = 0; i < TOTAL; i++) identity[i] = 0x1000 + i;
const blockInfo = {
	identity, view,
	blocks: offsets.map((b) => ({ kind: b.kind, offset: b.offset, count: b.count })),
	total: TOTAL, dynamicVersion: 1,
	member: { age: null, component: null },
};

// The environment every field entry point reads: the picker's
// contract (renderer blocks, orbit dispatch, model, time, camera).
function makeEnv(camX, camY, camZ, time) {
	return {
		blocks: blockInfo,
		orbit, model, time,
		landmarks,
		camX, camY, camZ,
	};
}

// The drawn position of a record, the way the sweep resolves it
// (landmarks through their own dispatch — the picker's ladder).
function drawnPosition(kind, index, out) {
	const b = offsets[kind];
	const byteOffset = (b.offset + index) * records.RECORD_BYTES;
	const packed = view.getUint32(byteOffset + 12, true);
	if (kind === field.BLOCK_LANDMARK) {
		orbit.engineLandmarkPosition(out, index,
			view.getFloat32(byteOffset, true),
			view.getFloat32(byteOffset + 4, true),
			view.getFloat32(byteOffset + 8, true),
			packed & 0xFF, 0, model);
		return;
	}
	orbit.engineRecordPosition(out,
		view.getFloat32(byteOffset, true),
		view.getFloat32(byteOffset + 4, true),
		view.getFloat32(byteOffset + 8, true),
		packed, 0, model);
}

// --- 1. Constellation anchors ------------------------------------------
{
	const state = field.createFieldState();
	const n = field.fillConstellationAnchors(state, landmarks, orbit, 0, model);
	check('constellation source fills the landmark table',
		n === landmarks.count && state.count === landmarks.count,
		{ n, table: landmarks.count });
	check('constellation anchors sit at their table positions at T=0',
		Math.hypot(
			state.positions[0] - landmarks.positions[0],
			state.positions[1] - landmarks.positions[1],
			state.positions[2] - landmarks.positions[2]) < 1e-9,
		{ first: [state.positions[0], state.positions[1], state.positions[2]] });
	// A generated galaxy has no landmarks: the caller falls back.
	const generated = { type: 'Sc', seed: 7, age: 13.5 };
	check('generated galaxies report no anchors (caller falls back)',
		field.fillConstellationAnchors(state, null, orbit, 0, generated) === 0
		&& state.count === 0,
		{});
}

// --- 2. The nearest-N sweep --------------------------------------------
{
	const state = field.createFieldState();
	const env = makeEnv(1.0, 0.2, 0.05, 0);
	field.beginSweep(state, 100);
	// Chunked: tiny slices prove the pause/resume cursors.
	let guard = 0;
	while (!field.stepSweep(state, env, 500, 0) && guard++ < 1000) { /* slice */ }
	check('sweep completes and commits the target count',
		state.count === 100 && guard < 1000,
		{ count: state.count, slices: guard });

	// The heap answer must equal a brute-force nearest-100 over
	// every visible record, dispatched the same way.
	const brute = [];
	for (const b of offsets) {
		for (let i = 0; i < b.count; i++) {
			const out = [0, 0, 0];
			drawnPosition(offsets.indexOf(b), i, out);
			const dx = out[0] - 1.0, dy = out[1] - 0.2, dz = out[2] - 0.05;
			brute.push({ d2: dx * dx + dy * dy + dz * dz, kind: offsets.indexOf(b), index: i });
		}
	}
	brute.sort((a, b) => a.d2 - b.d2);
	const heapSet = new Set();
	for (let i = 0; i < state.count; i++) {
		heapSet.add(state.kinds[i] + ':' + state.indices[i]);
	}
	const bruteSet = new Set(brute.slice(0, 100).map((r) => r.kind + ':' + r.index));
	check('sweep keeps exactly the brute-force nearest 100',
		heapSet.size === 100 && [...heapSet].every((k) => bruteSet.has(k)),
		{ heapOnly: [...heapSet].filter((k) => !bruteSet.has(k)).slice(0, 4),
			bruteOnly: [...bruteSet].filter((k) => !heapSet.has(k)).slice(0, 4) });

	// Membership is stable under a second complete sweep.
	field.beginSweep(state, 100);
	while (!field.stepSweep(state, env, 100000, 0)) { /* one go */ }
	const heapSet2 = new Set();
	for (let i = 0; i < state.count; i++) heapSet2.add(state.kinds[i] + ':' + state.indices[i]);
	check('a second sweep reproduces the same set',
		heapSet.size === heapSet2.size && [...heapSet].every((k) => heapSet2.has(k)),
		{});
}

// --- 3. Scalars ---------------------------------------------------------
{
	const state = field.createFieldState();
	const env = makeEnv(1.0, 0.2, 0.05, 0);
	field.beginSweep(state, 120);
	while (!field.stepSweep(state, env, 100000, 0)) { /* one go */ }
	field.refreshPositions(state, env);
	const cam = [1.0, 0.2, 0.05];

	const range = field.computeDistanceScalars(state, cam[0], cam[1], cam[2]);
	check('distance window lies inside the brute-force range (percentile clip)',
		range.min >= bruteMin(state, cam) - 1e-9 && range.max <= bruteMax(state, cam) + 1e-9
		&& range.min < range.max,
		{ range, brute: [bruteMin(state, cam), bruteMax(state, cam)] });
	check('distance values normalize to [0, 1] with the window ends hit',
		state.values.slice(0, state.count).every((v) => v >= -1e-6 && v <= 1 + 1e-6)
		&& Math.abs(Math.min(...state.values.slice(0, state.count))) < 1e-6
		&& Math.abs(Math.max(...state.values.slice(0, state.count)) - 1) < 1e-6,
		{});
	// One outlier (a star at 0.001 kpc) must not flatten the rest.
	const near = state.positions.slice(0, 3);
	state.positions[0] = cam[0] + 0.001; state.positions[1] = cam[1]; state.positions[2] = cam[2];
	const withOutlier = field.computeDistanceScalars(state, cam[0], cam[1], cam[2]);
	const sortedValues = state.values.slice(0, state.count).sort();
	const median = sortedValues[sortedValues.length >> 1];
	check('an outlier star does not flatten the map (median stays mid-range)',
		withOutlier.min > 0.001 && median > 0.05 && median < 0.95,
		{ withOutlier, median });
	state.positions[0] = near[0]; state.positions[1] = near[1]; state.positions[2] = near[2];

	const adj = field.computeAdjacencyScalars(state, cam[0], cam[1], cam[2]);
	check('adjacency ratios are ≥ 1 (3D ≥ transverse, always)',
		adj.min >= 1 - 1e-6,
		{ min: adj.min });
	check('adjacency values normalize to [0, 1]',
		state.values.slice(0, state.count).every((v) => v >= -1e-6 && v <= 1 + 1e-6),
		{});

	// A degenerate set (all scalars equal) pins at 0.5, no NaN.
	for (let i = 0; i < state.count; i++) state.scalars[i] = 7;
	field.finalizeRange(state, 7, 7);
	check('degenerate range pins at mid height, not NaN',
		state.values.slice(0, state.count).every((v) => v === 0.5),
		{});
}

function bruteMin(state, cam) {
	let lo = Infinity;
	for (let i = 0; i < state.count; i++) {
		const dx = state.positions[i * 3] - cam[0];
		const dy = state.positions[i * 3 + 1] - cam[1];
		const dz = state.positions[i * 3 + 2] - cam[2];
		lo = Math.min(lo, Math.sqrt(dx * dx + dy * dy + dz * dz));
	}
	return lo;
}
function bruteMax(state, cam) {
	let hi = -Infinity;
	for (let i = 0; i < state.count; i++) {
		const dx = state.positions[i * 3] - cam[0];
		const dy = state.positions[i * 3 + 1] - cam[1];
		const dz = state.positions[i * 3 + 2] - cam[2];
		hi = Math.max(hi, Math.sqrt(dx * dx + dy * dy + dz * dz));
	}
	return hi;
}

// --- 4. Adjacency exactness --------------------------------------------
// Two stars at the same distance, separated by a small angle, with a
// third far away: the pair's ratio must be the 3D gap over the
// transverse gap, and the far star must not enter the k-best.
{
	const state = field.createFieldState();
	// Hand-build a 3-star set: A and B at 1 kpc, 0.01 rad apart,
	// 0.5 kpc apart in depth; C far away in another direction.
	state.count = 3;
	state.positions.set([
		1.0, 0.0, 0.0,        // A
		0.99995, 0.00999983, 0.0, // B: ~0.01 rad from A, same depth shell
		0.0, 5.0, 0.0,        // C: far away
	]);
	state.camDist.set([1.0, 1.0, 5.0]);
	state.directions.set([
		1, 0, 0,
		0.99995, 0.00999983, 0,
		0, 1, 0,
	]);
	field.computeAdjacencyScalars(state, 0, 0, 0);
	// A and B are each other's angular neighbour: with no depth
	// gap the ratio is ~1; C's neighbour list is A or B at a
	// huge angle, whose ratio is also near 1 (the depth difference
	// is the distance itself).
	check('co-moving neighbours score near the ratio floor of 1',
		state.scalars[0] >= 1 && state.scalars[0] < 1.5
		&& state.scalars[1] >= 1 && state.scalars[1] < 1.5,
		{ a: state.scalars[0], b: state.scalars[1] });

	// The ridge case: B moved 0.5 kpc behind A, the SAME
	// direction — a nearly pure depth gap.
	state.positions[3] = 1.5; state.positions[4] = 0.001; state.positions[5] = 0.0;
	const invB = 1 / Math.hypot(1.5, 0.001, 0);
	state.directions[3] = 1.5 * invB; state.directions[4] = 0.001 * invB; state.directions[5] = 0;
	state.camDist[1] = 1.5;
	field.computeAdjacencyScalars(state, 0, 0, 0);
	check('a radially stacked pair pushes the ridge (ratio >> 1)',
		state.scalars[0] > 100,
		{ a: state.scalars[0] });
}

// --- 5. Uniform packing --------------------------------------------------
{
	const state = field.createFieldState();
	const env = makeEnv(0, 0, 0, 0);
	field.beginSweep(state, 64);
	while (!field.stepSweep(state, env, 100000, 0)) { /* one go */ }
	field.refreshPositions(state, env);
	field.computeDistanceScalars(state, 0, 0, 0);
	const uniform = field.packStarUniform(state, 0, 0, 0);
	let unit = true, ranged = true;
	for (let i = 0; i < state.count; i++) {
		const dx = state.positions[i * 3], dy = state.positions[i * 3 + 1],
			dz = state.positions[i * 3 + 2];
		if (dx * dx + dy * dy + dz * dz < 1e-18) continue; // the Sun at the camera: no direction by construction
		const len = Math.hypot(uniform[i * 4], uniform[i * 4 + 1], uniform[i * 4 + 2]);
		if (Math.abs(len - 1) > 1e-5) unit = false;
		if (uniform[i * 4 + 3] < -1e-6 || uniform[i * 4 + 3] > 1 + 1e-6) ranged = false;
	}
	check('star uniform: unit directions, values in [0, 1]',
		unit && ranged, {});
	check('star uniform length is the fixed MAX_STARS stride',
		uniform.length === field.MAX_STARS * 4,
		{ length: uniform.length });
}

// --- 6. Kernel width -----------------------------------------------------
{
	const s6 = field.kernelSigma(500, 1);
	const s60 = field.kernelSigma(60, 1);
	check('kernel σ shrinks as the set grows (mean angular spacing)',
		s6 < s60 && Math.abs(s60 / s6 - Math.sqrt(500 / 60)) < 1e-9,
		{ s6, s60 });
}

// --- Report ------------------------------------------------------------------
let passed = 0;
let failed = 0;
for (const c of checks) {
	if (c.pass) passed++; else failed++;
	console.log(`  ${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.pass ? '' : `  -> ${JSON.stringify(c.detail)}`}`);
}
console.log(`\n${passed}/${checks.length} passed, ${failed} failed`);

const logPath = path.join(__dirname, 'logs', 'view-modes-field.json');
fs.writeFileSync(logPath, JSON.stringify({
	date: new Date().toISOString(),
	model: { type: model.type, seed: model.seed },
	totalChecks: checks.length,
	passed,
	failed,
	checks,
}, null, 2));
console.log(`Wrote ${logPath}`);
console.log('\n=== VERDICT ===');
console.log(failed === 0 ? 'PASS — selection, scalars, normalization and packing behave as the plan says' : `FAIL — ${failed} checks failed`);
process.exit(failed === 0 ? 0 : 1);
