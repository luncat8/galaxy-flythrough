// experiments/field-anchors-test.js
// The distance field's anchor providers (src/core/field-anchors.js).
//
// The field's arithmetic does not care which stars it is computed over; this
// file is about the part that does care: the app's own state has to reach the
// field as a list of positions, in every star situation the app has.
//
// What is checked:
//   * the nearest-N source picks the nearest of the *resident* records, in
//     drawn space, nearest first;
//   * the selection source uses the selection set, at the positions the
//     selection module resolves them to (the drawn ones);
//   * the constellations source uses the named stars;
//   * the anchor count is bounded, and an empty sky yields no anchors.
//
// Output: experiments/logs/field-anchors.json

'use strict';

const fs = require('fs');
const path = require('path');

globalThis.window = globalThis;

const records = require('../src/math/star-record.js');
const anchorsModule = require('../src/core/field-anchors.js');
const landmarks = require('../src/data/landmarks.js');

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
	return !!pass;
}

// A synthetic resident sky: ten records at known places, spread out so the
// nearest-N has a definite answer.
const RESIDENT = [
	[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [2.0, 0.0, 0.0], [3.0, 0.0, 0.0],
	[0.5, 0.5, 0.5], [0.2, 0.0, 0.1], [0.9, 0.0, 0.0], [5.0, 0.0, 0.0],
	[0.3, 0.0, 0.0], [7.0, 0.0, 0.0],
];

function makeSky() {
	const bytes = new ArrayBuffer(RESIDENT.length * records.RECORD_BYTES);
	const view = new DataView(bytes);
	const identity = new Uint32Array(RESIDENT.length);
	for (let i = 0; i < RESIDENT.length; i++) {
		const at = i * records.RECORD_BYTES;
		view.setFloat32(at, RESIDENT[i][0], true);
		view.setFloat32(at + 4, RESIDENT[i][1], true);
		view.setFloat32(at + 8, RESIDENT[i][2], true);
		// Visible, with a family bit the dispatch can read.
		view.setUint32(at + 12, (records.FLAG_VISIBLE << 16) | (1 << 19) | (i & 0xFF), true);
		identity[i] = 1000 + i;
	}
	return { bytes, view, identity };
}

const sky = makeSky();
// Two blocks, the way the renderer has them: the generated field first, the
// catalog subset second. The sources that name a population read the block
// kinds, so the test has to have both.
const FIELD_COUNT = 4;
const CATALOG_COUNT = RESIDENT.length - FIELD_COUNT;
const renderer = {
	starBlocks: () => ({
		view: sky.view,
		identity: sky.identity,
		blocks: [
			{ kind: 'field', offset: 0, count: FIELD_COUNT },
			{ kind: 'catalog', offset: FIELD_COUNT, count: CATALOG_COUNT },
		],
		total: RESIDENT.length,
		dynamicVersion: 1,
	}),
};
const camera = { cameraPos: new Float64Array([0, 0, 0]) };

// A selection set of two members, and a selection module that resolves them
// to *drawn* positions that are not their birth ones - the point of ui.2's
// contract, and the point of this file.
const starSet = {
	count: 2,
	primary: 0,
	blockKind: new Uint8Array([0, 0]),
	bufferIdx: new Int32Array([3, 7]),
	keys: new Uint32Array([11, 22]),
	x: new Float64Array([0, 0]),
	y: new Float64Array([0, 0]),
	z: new Float64Array([0, 0]),
};
const DRAWN = { 11: [0.25, 0, 0], 22: [0.75, 0, 0] };
const selection = {
	resolveDrawn(ref, out) {
		const p = DRAWN[ref.key];
		if (!p) return 0;
		out[0] = p[0]; out[1] = p[1]; out[2] = p[2];
		return 1;
	},
};

const anchors = anchorsModule.createFieldAnchors({
	renderer, camera, landmarks, selection, starSet, orbit: null,
});

// --- the nearest-N source ------------------------------------------------
anchors.setMode('height');
anchors.setSource('nearest');
anchors.setCount(3);
anchors.update(null, 0, 1);
check('the nearest source fills the anchor list', anchors.count === 3, anchors.count);
{
	// The three nearest of the synthetic sky, nearest first: the record at
	// the origin, the one at (0.2, 0, 0.1) and the one at (0.3, 0, 0).
	const d = [];
	for (let i = 0; i < anchors.count; i++) {
		d.push(Math.hypot(anchors.positions[i * 3], anchors.positions[i * 3 + 1], anchors.positions[i * 3 + 2]));
	}
	const sorted = d.slice().sort((a, b) => a - b);
	check('the nearest source returns the nearest records, nearest first',
		Math.abs(d[0] - 0) < 1e-9 && Math.abs(d[1] - Math.hypot(0.2, 0, 0.1)) < 1e-6 && Math.abs(d[2] - 0.3) < 1e-6
		&& d.every((v, i) => i === 0 || v >= d[i - 1] - 1e-12),
		d);
}
{
	// The count is the count: asking for more than the sky has cannot invent
	// stars, and asking for fewer keeps the nearest ones.
	anchors.setCount(1);
	anchors.update(null, 0, 1);
	check('the anchor count follows the request',
		anchors.count === 1 && Math.abs(anchors.positions[0]) < 1e-9, anchors.count);
	anchors.setCount(500);
	anchors.update(null, 0, 1);
	check('a count larger than the sky keeps every record and no more',
		anchors.count === RESIDENT.length, anchors.count);
}

// --- the population sources ----------------------------------------------
// 'catalog' and 'procedural' are the nearest scan with a block filter: the
// catalog subset alone, the generated stars alone.
anchors.setSource('catalog');
anchors.setCount(3);
anchors.update(null, 0, 1);
check('the catalog source only anchors on the catalog block', (() => {
	// The three nearest of the catalog block, by their distance from the eye.
	const want = [Math.hypot(0.2, 0, 0.1), 0.3, Math.hypot(0.5, 0.5, 0.5)];
	if (anchors.count !== want.length) return { count: anchors.count };
	for (let i = 0; i < want.length; i++) {
		const d = Math.hypot(anchors.positions[i * 3], anchors.positions[i * 3 + 1], anchors.positions[i * 3 + 2]);
		if (Math.abs(d - want[i]) > 1e-6) return { i, d, want: want[i] };
	}
	return true;
})(), { count: anchors.count });
anchors.setSource('procedural');
anchors.update(null, 0, 1);
check('the procedural source only anchors on the generated block',
	anchors.count === 3
	&& Math.abs(anchors.positions[0]) < 1e-9
	&& Math.abs(anchors.positions[3] - 1) < 1e-6
	&& Math.abs(anchors.positions[6] - 2) < 1e-6,
	[anchors.positions[0], anchors.positions[3], anchors.positions[6]]);
anchors.setSource('nearest');
anchors.setCount(3);
anchors.update(null, 0, 1);
check('the nearest source is back to the whole sky',
	anchors.count === 3 && Math.abs(anchors.positions[0]) < 1e-9,
	anchors.count);

// --- the selection source ------------------------------------------------
anchors.setSource('selected');
anchors.update(null, 0, 1);
check('the selection source uses the selection set', anchors.count === 2, anchors.count);
check('the selection source uses the *drawn* positions, not the birth ones',
	Math.abs(anchors.positions[0] - 0.25) < 1e-9 && Math.abs(anchors.positions[3] - 0.75) < 1e-9,
	[anchors.positions[0], anchors.positions[3]]);

// --- the constellations source -------------------------------------------
anchors.setSource('constellations');
anchors.update(null, 0, 1);
check('the constellations source uses the named stars',
	anchors.count === Math.min(landmarks.count, anchorsModule.MAX_ANCHORS)
	&& Math.abs(anchors.positions[0] - landmarks.positions[0]) < 1e-9
	&& Math.abs(anchors.positions[1] - landmarks.positions[1]) < 1e-9,
	{ count: anchors.count, landmarks: landmarks.count });

// --- the empty sky -------------------------------------------------------
{
	const empty = anchorsModule.createFieldAnchors({
		renderer: { starBlocks: () => ({ view: null, identity: null, blocks: [], total: 0 }) },
		camera, landmarks, selection, starSet, orbit: null,
	});
	empty.setMode('height');
	empty.setSource('nearest');
	empty.update(null, 0, 1);
	check('an empty sky yields no anchors instead of throwing', empty.count === 0, empty.count);
	empty.setSource('selected');
	empty.update(null, 0, 1);
	check('the selection source still works with no resident sky', empty.count === 2, empty.count);
}

// --- the mode ------------------------------------------------------------
{
	anchors.setMode('off');
	anchors.update(null, 0, 1);
	check('the field being off yields no anchors', anchors.count === 0, anchors.count);
	check('the sources are the five the plan names',
		['nearest', 'catalog', 'procedural', 'selected', 'constellations'].every((s) => {
			anchors.setSource(s);
			return anchors.source === s;
		})
		&& anchors.setSource('nonsense') === 'nearest');
}

let passed = 0, failed = 0;
for (const c of checks) {
	if (c.pass) passed++; else failed++;
	console.log(`  ${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.pass ? '' : `  -> ${JSON.stringify(c.detail)}`}`);
}
console.log(`\n${passed}/${checks.length} passed, ${failed} failed`);

const logPath = path.join(__dirname, 'logs', 'field-anchors.json');
fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.writeFileSync(logPath, JSON.stringify({
	date: new Date().toISOString(),
	totalChecks: checks.length,
	passed,
	failed,
	checks,
}, null, 2));
console.log(`Wrote ${logPath}`);
console.log('\n=== VERDICT ===');
console.log(failed === 0
	? 'PASS — the field\'s anchors answer to every star situation'
	: `FAIL — ${failed} checks failed`);
process.exit(failed === 0 ? 0 : 1);
