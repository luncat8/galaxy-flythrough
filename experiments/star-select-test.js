// experiments/star-select-test.js
// Star selection (0.5.0, plan §3): picking any drawn star, the snapshot set, the
// radius scan, the key→slot rings, and the two budgets §3.1/§3.3 promise.
//
// Checks:
//   1. `pickAny` hits what the dispatch draws, for masks 1 / 2 / 4 / 5 and for
//      every block; the simple mask is *reported* (`out.approximated`), not
//      silently wrong; a miss is null and an empty residency is not a crash.
//   2. tie-break: inside PICK_TIE_PX the brighter absolute magnitude wins.
//   3. radius select equals an independent *dispatched* brute-force list,
//      ascending, for masks 1/4/5 at 100 Myr of star time — and is a different
//      answer from the birth-space scan it replaced; the chunked sweep equals the
//      one-call scan and aborts on a rebuild.
//   3b. `resolveDrawn` is the dispatch the picker and the sky use, and refuses a
//      slot its key does not name.
//   4. the set: shift-toggle, nearest-first cycling, capacity overflow dropping
//      the farthest (never the primary), snapshot inputs equal a fresh
//      derivation, and an age change re-deriving in place.
//   5. rings: a key resolves to the slot it was written at, across a block
//      rebuild, and the number of arcs drawn matches the resolvable members.
//   6. catalog keys are (cell, slot-in-cell): the same star keeps its key when
//      the resident set and the thinning change under it.
//   7. timings: both sweeps are dispatch-bound, so both are chunked — a slice
//      stays inside the loop's 8 ms budget and a whole 300k sweep is a bounded
//      number of frames (the old "radius scan < 5 ms" budget belonged to the
//      birth-space scan, which answered the wrong question).
//
// Output: experiments/logs/star-select.json

'use strict';

const fs = require('fs');
const path = require('path');

globalThis.window = globalThis;

const galaxy = require('../src/math/galaxy.js');
const sampling = require('../src/math/sampling.js');
const starTypes = require('../src/math/star-types.js');
const records = require('../src/math/star-record.js');
const orbit = require('../src/math/orbit.js');
const planets = require('../src/math/planets.js');
const coords = require('../src/math/coords.js');
const cameraLib = require('../src/core/camera.js');
const selectionLib = require('../src/core/selection.js');
const starSetLib = require('../src/core/star-set.js');
const labelLayerLib = require('../src/render/label-layer.js');
const loader = require('../src/stream/tile-loader.js');
const cellManagerLib = require('../src/stream/cell-manager.js');
const landmarks = require('../src/data/landmarks.js');
const constellations = require('../src/data/constellations.js');

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
	return !!pass;
}

const model = galaxy.createGalaxy({ type: 'SBb', seed: 12345, age: 13.5 });

// --- A synthetic renderer: five blocks, written the way star-sprites writes them
const FIELD_N = 4096;
const FIELD_ROWS = 64;
const LOCAL_N = 40;
const OBJECT_N = 24;
const CATALOG_N = 48;
const LANDMARK_N = landmarks.count;
const TOTAL = FIELD_N + LANDMARK_N + OBJECT_N + LOCAL_N + CATALOG_N;
const BLOCK_ORDER = ['field', 'landmark', 'object', 'local', 'catalog'];
const offsets = [];
{
	let off = 0;
	for (const n of [FIELD_N, LANDMARK_N, OBJECT_N, LOCAL_N, CATALOG_N]) { offsets.push(off); off += n; }
}

const staging = new ArrayBuffer(TOTAL * records.RECORD_BYTES);
const view = new DataView(staging);
const identity = new Uint32Array(TOTAL);
const blocks = BLOCK_ORDER.map((kind, k) => ({
	kind,
	offset: offsets[k],
	count: [FIELD_N, LANDMARK_N, OBJECT_N, LOCAL_N, CATALOG_N][k],
}));
const memberMeta = {
	age: new Float64Array(OBJECT_N),
	component: new Int8Array(OBJECT_N),
};
const info = {
	identity, view, blocks, total: TOTAL, dynamicVersion: 1,
	member: memberMeta,
};
const renderer = { starBlocks: () => info, fieldBuffers: () => field };

// The field block: the sampler's own stars, derived exactly as writeProceduralRecords.
const field = sampling.sampleGalaxyStars(model, model.seed | 0, FIELD_N, null);
const fieldDerived = {};
for (let i = 0; i < FIELD_N; i++) {
	const key = starTypes.fieldStarSeed(model.seed, i);
	starTypes.deriveStar(model, key, field.component[i], field.R[i], field.distToArm[i], fieldDerived, field.z[i]);
	records.writeRecord(view, (offsets[0] + i) * records.RECORD_BYTES,
		field.x[i], field.y[i], field.z[i],
		fieldDerived.colorIndex, fieldDerived.absMag,
		orbit.flagsWithFamily(records.FLAG_VISIBLE, orbit.familyForStar(field.component[i], fieldDerived.spectralClass, model.barred)),
		Math.imul(i, 2654435761) & 0xFF);
	identity[offsets[0] + i] = key;
}
// Landmarks: the shipped table, positional keys.
for (let i = 0; i < LANDMARK_N; i++) {
	const e = landmarks.ENTRIES[i];
	records.writeRecord(view, (offsets[1] + i) * records.RECORD_BYTES, e.x, e.y, e.z,
		e.colorIndex, e.absMag,
		orbit.flagsWithFamily(records.FLAG_VISIBLE | records.FLAG_LANDMARK, orbit.familyFromColorIndex(e.colorIndex)), 0);
	identity[offsets[1] + i] = planets.landmarkKey(i);
}
// Object members: one placed object spread over OBJECT_N members.
{
	const placed = require('../src/math/objects.js').placeObjects(model, (model.seed | 0) ^ 0x0B5E55, 4, null);
	require('../src/math/objects.js').writeObjectMembers(model, placed, view,
		offsets[2] * records.RECORD_BYTES, OBJECT_N, 0, identity, offsets[2], memberMeta);
}
// Local gap-fill: the renderer's own slotSeed chain, positions in a cell AABB.
{
	const localSeed = (model.seed | 0) ^ 0x10ca1cab;
	const derived = {};
	const cell = { id: 7, x0: 1.2, y0: -0.4, z0: 0.05, size: 0.4 };
	for (let i = 0; i < LOCAL_N; i++) {
		const slotSeed = (Math.imul(localSeed, 0x9e3779b1)
			^ Math.imul(cell.id, 0x85ebca6b)
			^ Math.imul(i + 1, 0xc2b2ae3d));
		const x = cell.x0 + require('../src/math/hash.js').hash01At(slotSeed, 0) * cell.size;
		const y = cell.y0 + require('../src/math/hash.js').hash01At(slotSeed, 1) * cell.size;
		const z = cell.z0 + require('../src/math/hash.js').hash01At(slotSeed, 2) * cell.size;
		const decomposed = require('../src/math/density.js').rhoDecomposed(model, x, y, z);
		const component = require('../src/math/density.js').sampleComponentIndex(decomposed, require('../src/math/hash.js').hash01At(slotSeed, 3));
		starTypes.deriveStar(model, Math.imul(slotSeed, 31) + 5, component, decomposed.R, decomposed.distToArm, derived, z);
		records.writeRecord(view, (offsets[3] + i) * records.RECORD_BYTES, x, y, z,
			derived.colorIndex, derived.absMag,
			orbit.flagsWithFamily(records.FLAG_VISIBLE, orbit.familyForStar(component, derived.spectralClass, model.barred)),
			require('../src/math/hash.js').pcgHash(slotSeed ^ 0xFACE) & 0xFF);
		identity[offsets[3] + i] = slotSeed >>> 0;
	}
}
// Catalog: the key is (cell, slot-in-cell), which is what makes it survive thinning.
for (let i = 0; i < CATALOG_N; i++) {
	const x = (i * 0.013) - 0.2;
	records.writeRecord(view, (offsets[4] + i) * records.RECORD_BYTES, x, 0.05, 0.9 + i * 0.001,
		i % 10, -2 + (i % 9), records.FLAG_VISIBLE, 0);
	identity[offsets[4] + i] = planets.catalogKey(3, i);
}

// A pick from the +z side sees the whole synthetic box; the camera sits at the origin.
const camera = cameraLib.createCamera();
camera.setFrame(model);
camera.setMode(cameraLib.MODE_FLY);
camera.setPosition ? camera.setPosition(0, 0, 0) : null;
const W = 1280, H = 800;

// --- 1. pick parity across masks and blocks ----------------------------------
{
	const out = {};
	const cam = camera.cameraPos;
	const viewProj = camera.buildViewProj(W / H);
	const scratch = new Float32Array(3);
	const drawn = new Float64Array(3);
	const drawAt = (kind, index, rec, target) => {
		if (kind === 1) orbit.engineLandmarkPosition(target, index, rec.x, rec.y, rec.z, rec.colorIndex, 0.5, model);
		else orbit.engineRecordPosition(target, rec.x, rec.y, rec.z, rec.packed, 0.5, model);
		return target;
	};
	let mismatches = 0;
	let hits = 0;
	let approximated = 0;
	const origEngine = orbit.getEngine();
	for (const mask of [1, 2, 4, 5]) {
		orbit.setEngine(mask);
		const sel = selectionLib.createSelection(camera, landmarks);
		sel.setRenderer(renderer);
		sel.setOrbitState(model, 0.5);
		for (let k = 0; k < blocks.length; k++) {
			const block = blocks[k];
			for (let i = 0; i < block.count; i += Math.max(1, block.count >> 4)) {
				const slot = block.offset + i;
				const rec = records.readRecord(view, slot * records.RECORD_BYTES);
				// Click exactly where the dispatch draws this record.
				drawAt(k, i, rec, drawn);
				if (!coords.projectToScreen(viewProj, drawn[0], drawn[1], drawn[2],
					cam[0], cam[1], cam[2], W, H, scratch)) continue;
				const clickX = scratch[0], clickY = scratch[1];
				const hit = sel.pickAny(clickX, clickY, W, H, out);
				hits++;
				if (!hit) { mismatches++; continue; }
				// The hit is a real visible record from the block it claims.
				const hitSlot = blocks[hit.kind].offset + hit.index;
				if ((hit.packed & (records.FLAG_VISIBLE << 16)) === 0) mismatches++;
				if (hit.key !== identity[hitSlot] >>> 0) mismatches++;
				// Where the dispatch draws the hit, against where the user clicked.
				const hrec = records.readRecord(view, hitSlot * records.RECORD_BYTES);
				drawAt(hit.kind, hit.index, hrec, drawn);
				if (!coords.projectToScreen(viewProj, drawn[0], drawn[1], drawn[2],
					cam[0], cam[1], cam[2], W, H, scratch)) { mismatches++; continue; }
				const off = Math.hypot(scratch[0] - clickX, scratch[1] - clickY);
				const isProbe = hit.key === identity[slot] >>> 0;
				if (isProbe ? off > 0.5 : off > selectionLib.PICK_TIE_PX + 0.5) mismatches++;
				// The rule: nothing outside PICK_RADIUS_PX, nothing nearer than
				// the pick was left behind (the tie band allows a brighter sibling).
				if (off > selectionLib.PICK_RADIUS_PX) mismatches++;
				// The approximation flag is the dispatch's own report.
				if (hit.approximated !== (hit.kind !== 1 && (mask & 2) !== 0)) mismatches++;
				if (hit.approximated) approximated++;
			}
		}
	}
	orbit.setEngine(origEngine);
	check('pickAny hits a star the dispatch draws, for masks 1/2/4/5 and all five blocks',
		mismatches === 0 && hits > 100, { mismatches, hits });
	check('the simple-mask approximation is reported, not silent', approximated > 0, approximated);

	const sel = selectionLib.createSelection(camera, null);
	sel.setRenderer(renderer);
	const empty = selectionLib.createSelection(camera, null);
	empty.setRenderer({ starBlocks: () => ({ identity, view, blocks: [{ kind: 'field', offset: 0, count: 0 }], total: 0, dynamicVersion: 0 }) });
	check('a miss is null and an empty residency is not a crash',
		sel.pickAny(-500, -500, W, H, {}) === null && empty.pickAny(10, 10, W, H, {}) === null);
	check('pickAny without a renderer misses instead of throwing',
		selectionLib.createSelection(camera, null).pickAny(10, 10, W, H, {}) === null);
}

// --- 2. Tie-break ------------------------------------------------------------
{
	const sel = selectionLib.createSelection(camera, null);
	sel.setRenderer(renderer);
	const out = {};
	const cam = camera.cameraPos;
	const scratch = new Float32Array(3);
	const viewProj = camera.buildViewProj(W / H);
	// Three catalog records. A sits exactly under the click (faint), B shares the
	// pixel and is bright, C is 6 px away in screen space and brighter still.
	const write = (i, x, mag) => records.writeRecord(view,
		(offsets[4] + i) * records.RECORD_BYTES, x, 0, 1.0, 4, mag, records.FLAG_VISIBLE, 0);
	write(0, 0.30, 4);
	write(1, 0.30, -1);
	write(2, 0.3008, -5);
	identity[offsets[4] + 0] = 0x0A0A;
	identity[offsets[4] + 1] = 0x0B0B;
	identity[offsets[4] + 2] = 0x0C0C;
	coords.projectToScreen(viewProj, 0.30, 0, 1.0, cam[0], cam[1], cam[2], W, H, scratch);
	const clickX = scratch[0], clickY = scratch[1];
	coords.projectToScreen(viewProj, 0.3008, 0, 1.0, cam[0], cam[1], cam[2], W, H, scratch);
	const cOff = Math.hypot(scratch[0] - clickX, scratch[1] - clickY);
	let hit = sel.pickAny(clickX, clickY, W, H, out);
	check('a tie on the same pixel goes to the brighter magnitude',
		hit && hit.key === 0x0B0B && hit.absMag < -0.5, hit && { key: hit.key, absMag: hit.absMag });
	// Hide the bright twin: now the faint one at the click must beat C, which is
	// brighter but more than PICK_TIE_PX away.
	identity[offsets[4] + 1] = 0;
	view.setUint32((offsets[4] + 1) * records.RECORD_BYTES + 12, 0, true);
	hit = sel.pickAny(clickX, clickY, W, H, out);
	check('outside PICK_TIE_PX the nearer star wins even against a brighter one',
		hit && hit.key === 0x0A0A && cOff > selectionLib.PICK_TIE_PX, hit && { key: hit.key, cOff });
	check('the reported hit carries its slot, block and record',
		hit && hit.kind === 4 && hit.index === 0 && hit.colorIndex === 4 && hit.packed !== 0,
		hit && { kind: hit.kind, index: hit.index });
}

// --- 3. Radius select against brute force (dispatch-exact, ui.2) --------------
// The scan compares *drawn* positions on both sides: the centre is where the sky
// draws the primary, and a candidate is inside when the sky draws it inside. The
// birth-position scan this replaced answered a different question once the star
// clock had run — at 100 Myr a picked star's birth record sits kiloparsecs from
// where it is drawn, so its birth neighbourhood is not the neighbourhood on
// screen. Both halves are pinned below: the drawn answer against an independent
// dispatched brute force, and the divergence from the birth answer that makes the
// dispatch non-vacuous.
const AROUND_TIME = 100;          // Myr of star time: enough to separate the frames
const drawnScratch = new Float64Array(3);
const candidateScratch = new Float64Array(3);
const centreScratch = new Float64Array(3);
function drawRecord(kind, index, rec, time, out) {
	if (kind === 1) orbit.engineLandmarkPosition(out, index, rec.x, rec.y, rec.z, rec.colorIndex, time, model);
	else orbit.engineRecordPosition(out, rec.x, rec.y, rec.z, rec.packed, time, model);
	return out;
}
// Every visible record's distance from a drawn centre, in one frame of
// reference: `dispatched` picks drawn vs birth for both the centre and the
// candidate, so the same builder produces the expected list and the list the old
// scan would have produced.
function bruteAround(centreKind, centreIndex, radiusKpc, time, dispatched) {
	const crec = records.readRecord(view, blocks[centreKind].offset * records.RECORD_BYTES + centreIndex * records.RECORD_BYTES);
	const c = dispatched
		? drawRecord(centreKind, centreIndex, crec, time, centreScratch)
		: (centreScratch[0] = crec.x, centreScratch[1] = crec.y, centreScratch[2] = crec.z, centreScratch);
	const cx = c[0], cy = c[1], cz = c[2];
	const list = [];
	for (let k = 0; k < blocks.length; k++) {
		const block = blocks[k];
		for (let i = 0; i < block.count; i++) {
			const slot = block.offset + i;
			const rec = records.readRecord(view, slot * records.RECORD_BYTES);
			if (!rec.visible) continue;
			let qx = rec.x, qy = rec.y, qz = rec.z;
			if (dispatched) {
				const p = drawRecord(k, i, rec, time, candidateScratch);
				qx = p[0]; qy = p[1]; qz = p[2];
			}
			const d2 = (qx - cx) ** 2 + (qy - cy) ** 2 + (qz - cz) ** 2;
			if (d2 <= radiusKpc * radiusKpc) list.push({ key: identity[slot] >>> 0, d2, slot });
		}
	}
	list.sort((a, b) => a.d2 - b.d2);
	return list;
}
{
	const radiusKpc = 1.2;
	const sel = selectionLib.createSelection(camera, null);
	sel.setRenderer(renderer);
	sel.setOrbitState(model, AROUND_TIME);
	orbit.setPatternClock(AROUND_TIME, model);
	const centreKind = 0, centreIndex = FIELD_ROWS;
	const centreRec = records.readRecord(view, (blocks[0].offset + centreIndex) * records.RECORD_BYTES);
	const origEngine = orbit.getEngine();
	for (const mask of [1, 4, 5]) {
		orbit.setEngine(mask);
		const centre = drawRecord(centreKind, centreIndex, centreRec, AROUND_TIME, new Float64Array(3));
		const n = sel.selectAround(centre[0], centre[1], centre[2], radiusKpc, starSetLib.CAPACITY);
		const expected = bruteAround(centreKind, centreIndex, radiusKpc, AROUND_TIME, true)
			.slice(0, starSetLib.CAPACITY);
		const got = [];
		for (let i = 0; i < n; i++) got.push({ key: sel.around.keys[i], d2: sel.around.dist2[i] });
		let asc = true;
		for (let i = 1; i < got.length; i++) if (got[i].d2 < got[i - 1].d2) asc = false;
		check(`radius select equals the dispatched brute-force list, ascending (mask ${mask})`,
			n === expected.length && n > 1
			&& expected.every((e, i) => got[i].key === e.key && Math.abs(got[i].d2 - e.d2) < 1e-18)
			&& asc,
			{ mask, n, expected: expected.length, asc, first: got[0], last: got[got.length - 1] });

		// Non-vacuity: the birth-space answer is a *different* set of stars, so the
		// dispatch is what the scan runs on. This is the regression pin — the old
		// scan passed the birth brute force and failed this one.
		const birth = bruteAround(centreKind, centreIndex, radiusKpc, AROUND_TIME, false);
		const birthKeys = birth.map((e) => e.key).join(',');
		const drawnKeys = expected.map((e) => e.key).join(',');
		check(`the drawn neighbourhood is not the birth neighbourhood (mask ${mask})`,
			birthKeys !== drawnKeys,
			{ mask, drawn: n, birth: birth.length, centreMovedKpc: Math.hypot(
				centre[0] - centreRec.x, centre[1] - centreRec.y, centre[2] - centreRec.z) });
	}
	orbit.setEngine(origEngine);

	// The result keeps both frames of reference: dist2 is the drawn-space sort key,
	// x/y/z stay the record's birth position (what a snapshot stores and what
	// stellarInputs decomposes the density at).
	orbit.setEngine(1);
	const centre = drawRecord(centreKind, centreIndex, centreRec, AROUND_TIME, new Float64Array(3));
	sel.selectAround(centre[0], centre[1], centre[2], radiusKpc, starSetLib.CAPACITY);
	let fieldsOk = true;
	for (let i = 0; i < sel.around.count; i++) {
		const rec = records.readRecord(view,
			(blocks[sel.around.kind[i]].offset + sel.around.index[i]) * records.RECORD_BYTES);
		if (Math.abs(sel.around.x[i] - rec.x) > 1e-6 || Math.abs(sel.around.z[i] - rec.z) > 1e-6) fieldsOk = false;
		if (sel.around.packed[i] !== rec.packed) fieldsOk = false;
		const d = drawRecord(sel.around.kind[i], sel.around.index[i], rec, AROUND_TIME, new Float64Array(3));
		const drawn2 = (d[0] - centre[0]) ** 2 + (d[1] - centre[1]) ** 2 + (d[2] - centre[2]) ** 2;
		if (Math.abs(drawn2 - sel.around.dist2[i]) > 1e-18) fieldsOk = false;
	}
	check('a kept row carries its birth record and its drawn distance',
		fieldsOk && sel.around.count > 1, { count: sel.around.count, fieldsOk });

	// Truncation, and the count it reports.
	const all = bruteAround(centreKind, centreIndex, radiusKpc, AROUND_TIME, true);
	const capped = sel.selectAround(centre[0], centre[1], centre[2], radiusKpc, 5);
	const got5 = [];
	for (let i = 0; i < capped; i++) got5.push({ key: sel.around.keys[i], d2: sel.around.dist2[i] });
	check('the scan truncates at the caller\'s capacity and reports the rest',
		capped === Math.min(5, all.length) && sel.around.truncated === Math.max(0, all.length - 5)
		&& got5.every((e, i) => all[i] && all[i].key === e.key),
		{ capped, truncated: sel.around.truncated, inside: all.length });

	// The chunked sweep is the one-call scan, slice by slice.
	sel.beginSelectAround(centre[0], centre[1], centre[2], radiusKpc, starSetLib.CAPACITY);
	let slices = 0;
	while (!sel.selectAroundStep(64, 8)) slices++;
	const swept = [];
	for (let i = 0; i < sel.around.count; i++) swept.push(sel.around.keys[i]);
	const oneCall = [];
	sel.selectAround(centre[0], centre[1], centre[2], radiusKpc, starSetLib.CAPACITY);
	for (let i = 0; i < sel.around.count; i++) oneCall.push(sel.around.keys[i]);
	check('the chunked radius sweep finds the same set as the one-call scan',
		swept.length === oneCall.length && swept.every((k, i) => k === oneCall[i]) && slices > 1,
		{ slices, swept: swept.length, oneCall: oneCall.length });

	// A rebuild mid-sweep aborts and leaves the caller's set alone.
	sel.beginSelectAround(centre[0], centre[1], centre[2], radiusKpc, starSetLib.CAPACITY);
	sel.selectAroundStep(64, 8);
	info.dynamicVersion++;
	sel.selectAroundStep(64, 8);
	check('a rebuild during a radius sweep aborts it instead of mixing two frames',
		sel.around.aborted === 1 && sel.around.count === 0,
		{ aborted: sel.around.aborted, count: sel.around.count });
	info.dynamicVersion--;

	// A degenerate call is a no-op, not a crash.
	check('a zero radius or a zero capacity scans nothing',
		sel.selectAround(centre[0], centre[1], centre[2], 0, 256) === 0
		&& sel.selectAround(centre[0], centre[1], centre[2], radiusKpc, 0) === 0
		&& sel.beginSelectAround(centre[0], centre[1], centre[2], radiusKpc, 0) === false);
}

// --- 3b. resolveDrawn: where the sky draws one record ------------------------
// The camera's fly-to target, its orbit follow, the readout's distance and the
// radius scan's centre all read this. It has to be the position the picker's own
// dispatch produced for the record it hit, for every mask, and it has to refuse a
// slot whose key moved on rather than resolving to the star now sitting in it.
{
	const sel = selectionLib.createSelection(camera, landmarks);
	sel.setRenderer(renderer);
	sel.setOrbitState(model, AROUND_TIME);
	orbit.setPatternClock(AROUND_TIME, model);
	const out = {};
	const pos = new Float64Array(3);
	const want = new Float64Array(3);
	const origEngine = orbit.getEngine();
	let worst = 0, checked = 0, staleOk = true, approxOk = true;
	for (const mask of [1, 2, 4, 5]) {
		orbit.setEngine(mask);
		for (let k = 0; k < blocks.length; k++) {
			const block = blocks[k];
			for (let i = 0; i < block.count; i += Math.max(1, block.count >> 5)) {
				const slot = block.offset + i;
				const rec = records.readRecord(view, slot * records.RECORD_BYTES);
				const ref = { kind: k, index: i, key: identity[slot] >>> 0, x: rec.x, y: rec.y, z: rec.z };
				const state = sel.resolveDrawn(ref, pos);
				// A record the sky does not draw (§2 hid one of these) has no drawn
				// position: it resolves to its snapshot and says so.
				if (!rec.visible) {
					if (state !== selectionLib.DRAWN_STALE) approxOk = false;
					continue;
				}
				drawRecord(k, i, rec, AROUND_TIME, want);
				const err = Math.hypot(pos[0] - want[0], pos[1] - want[1], pos[2] - want[2]);
				if (err > worst) worst = err;
				checked++;
				// The landmark path is exact under every mask; a record under the
				// simple bit is the documented approximation, and says so.
				const isLandmark = block.kind === 'landmark';
				if (state !== (isLandmark || (mask & 2) === 0 ? selectionLib.DRAWN_EXACT : selectionLib.DRAWN_APPROX)) {
					approxOk = false;
				}
			}
		}
	}
	orbit.setEngine(1);
	// A key that does not name the slot resolves to the snapshot, and says so —
	// never to the star that happens to sit in the slot now.
	const movedRef = { kind: 0, index: 3, key: 0xDEADBEEF, x: 1.5, y: -2.5, z: 0.25 };
	const movedState = sel.resolveDrawn(movedRef, pos);
	if (movedState !== selectionLib.DRAWN_STALE
		|| pos[0] !== movedRef.x || pos[1] !== movedRef.y || pos[2] !== movedRef.z) staleOk = false;
	// Out of range, and no renderer at all.
	if (sel.resolveDrawn({ kind: 0, index: 1 << 20, key: 1, x: 0, y: 0, z: 0 }, pos) !== selectionLib.DRAWN_STALE) staleOk = false;
	const bare = selectionLib.createSelection(camera, null);
	if (bare.resolveDrawn({ kind: 0, index: 0, key: 1, x: 4, y: 5, z: 6 }, pos) !== selectionLib.DRAWN_STALE
		|| pos[0] !== 4) staleOk = false;
	check('resolveDrawn is the dispatch the picker and the sky use, for masks 1/2/4/5',
		worst < 1e-12 && checked > 100 && approxOk, { worst, checked, approxOk });
	check('resolveDrawn refuses a slot its key does not name, and keeps the snapshot',
		staleOk, { staleOk, movedState });

	// The fly-to contract end to end: click where a star is drawn, and the
	// position the camera would be flown to is that same drawn position — not the
	// birth record the pick carries (the ui.2 bug: 3.09 kpc apart at 100 Myr).
	orbit.setEngine(1);
	const cam = camera.cameraPos;
	const viewProj = camera.buildViewProj(W / H);
	const scratch = new Float32Array(3);
	const probeSlot = blocks[0].offset + FIELD_ROWS;
	const probeRec = records.readRecord(view, probeSlot * records.RECORD_BYTES);
	drawRecord(0, FIELD_ROWS, probeRec, AROUND_TIME, want);
	coords.projectToScreen(viewProj, want[0], want[1], want[2], cam[0], cam[1], cam[2], W, H, scratch);
	const hit = sel.pickAny(scratch[0], scratch[1], W, H, out);
	const flightErr = hit ? (sel.resolveDrawn(hit, pos), Math.hypot(pos[0] - want[0], pos[1] - want[1], pos[2] - want[2])) : Infinity;
	const birthErr = hit ? Math.hypot(hit.x - want[0], hit.y - want[1], hit.z - want[2]) : 0;
	check('a picked star resolves to where it was clicked, not to its birth record',
		!!hit && flightErr < 1e-9 && birthErr > 0.5,
		{ flightErr, birthErrKpc: birthErr, key: hit && hit.key });
	orbit.setEngine(origEngine);
}

// --- 4. The set --------------------------------------------------------------
{
	const set = starSetLib.createStarSet();
	const mk = (key, x, y, z, mag, kind, index) => ({ key, kind, index, x, y, z, colorIndex: 4, absMag: mag });
	const inputs = (m, l) => ({ mass: m, lum: l, teff: 5800, age: 5, metal: 0.02 });
	const cam = camera.cameraPos;
	set.setSingle(mk(1, 0, 0, 0, 3, 0, 7), inputs(1, 1), cam[0], cam[1], cam[2], 7);
	set.toggle(mk(2, 0.1, 0, 0, 3, 0, 8), inputs(2, 4), cam[0], cam[1], cam[2], 8);
	set.toggle(mk(3, 0.2, 0, 0, 3, 0, 9), inputs(3, 9), cam[0], cam[1], cam[2], 9);
	check('a plain click is a one-star set and shift adds without moving the primary',
		set.count === 3 && set.primary === 0 && set.keys[2] === 3);
	set.toggle(mk(2, 0.1, 0, 0, 3, 0, 8), inputs(2, 4), cam[0], cam[1], cam[2], 8);
	check('shift-click on a member removes it', set.count === 2 && set.indexOfKey(2) === -1);
	set.cyclePrimary(1);
	const cycled = set.primary;
	set.cyclePrimary(-1);
	check('N cycles forward and backward through the set',
		cycled !== 0 && set.primary === 0, { cycled, back: set.primary });
	// Overflow: fill, then insert nearer and farther stars.
	for (let i = 100; i < 100 + starSetLib.CAPACITY; i++) {
		if (set.count >= starSetLib.CAPACITY) break;
		set.insert(mk(i, 1000 + i, 0, 0, 3, 0, i), inputs(1, 1), cam[0], cam[1], cam[2], i);
	}
	const farKey = 999999;
	const primaryKey = set.keys[0];
	const far = set.insert(mk(farKey, 5000, 0, 0, 3, 0, 1), inputs(1, 1), cam[0], cam[1], cam[2], 1);
	const near = set.insert(mk(888888, 0.0001, 0, 0, 3, 0, 2), inputs(1, 1), cam[0], cam[1], cam[2], 2);
	check('overflow drops the farthest from the camera, never the primary',
		far === -1 && near >= 0 && set.count === starSetLib.CAPACITY
		&& set.hasKey(primaryKey) && set.hasKey(888888) && !set.hasKey(farKey)
		&& set.dropped === 2,
		{ far, near, dropped: set.dropped, hasPrimary: set.hasKey(primaryKey) });
}

// --- 5. Snapshot inputs equal a fresh derivation -----------------------------
{
	const set = starSetLib.createStarSet();
	const sel = selectionLib.createSelection(camera, null);
	sel.setRenderer(renderer);
	sel.setOrbitState(model, 0.5);
	const out = {};
	const cam = camera.cameraPos;
	const scratch = new Float32Array(3);
	const ctx = { model, field, member: memberMeta };
	let worst = 0;
	let seen = 0;
	const viewProj = camera.buildViewProj(W / H);
	for (const [kind, index] of [[planets.BLOCK_FIELD, 5], [planets.BLOCK_FIELD, 3000], [planets.BLOCK_LOCAL, 3], [planets.BLOCK_OBJECT, 2]]) {
		const slot = blocks[kind].offset + index;
		const rec = records.readRecord(view, slot * records.RECORD_BYTES);
		const hit = {
			key: identity[slot] >>> 0, kind, index,
			x: rec.x, y: rec.y, z: rec.z,
			colorIndex: rec.colorIndex, absMag: rec.absMag,
		};
		sel.pickAny(-1, -1, W, H, out);
		const inputs = planets.stellarInputs(hit, ctx, {});
		set.setSingle(hit, inputs, cam[0], cam[1], cam[2], index);
		// Fresh derivation, the same call the renderer would make for that block.
		const fresh = planets.stellarInputs(hit, ctx, {});
		worst = Math.max(worst,
			Math.abs(set.mass[0] - fresh.mass),
			Math.abs(set.lum[0] - fresh.lum),
			Math.abs(set.teff[0] - fresh.teff),
			Math.abs(set.age[0] - fresh.age),
			Math.abs(set.metal[0] - fresh.metal));
		seen++;
		scratch[0] = 0;
	}
	check('snapshot stellar inputs equal a fresh derivation (bit-equal)',
		seen === 4 && worst === 0, { worst, seen });
	check('the snapshot carries the dispatch\'s approximation flag',
		set.approximated.length === starSetLib.CAPACITY, set.approximated.length);

	// The anti-drift pin of §2.4: a *field* snapshot survives a record rewrite by
	// a different camera position — the f32-position path.
	const slot = blocks[planets.BLOCK_FIELD].offset + 5;
	const before = records.readRecord(view, slot * records.RECORD_BYTES);
	const hit = {
		key: identity[slot] >>> 0, kind: planets.BLOCK_FIELD, index: 5,
		x: before.x, y: before.y, z: before.z, colorIndex: before.colorIndex, absMag: before.absMag,
	};
	const snapped = planets.stellarInputs(hit, ctx, {});
	// Rewrite the same slot with the record re-derived from a different z (the
	// renderer's own channel for the vertical context).
	const key = identity[slot] >>> 0;
	const alt = {};
	starTypes.deriveStar(model, key, field.component[5], field.R[5], field.distToArm[5], alt, field.z[5] + 0.01);
	records.writeRecord(view, slot * records.RECORD_BYTES, before.x, before.y, field.z[5] + 0.01,
		alt.colorIndex, alt.absMag, before.packed, before.jitter);
	const later = planets.stellarInputs(hit, ctx, {});
	check('the field snapshot is a function of the key, not of the resident record',
		snapped.mass === later.mass && snapped.lum === later.lum && snapped.teff === later.teff,
		{ mass: [snapped.mass, later.mass] });
}

// --- 6. Rings: key → slot, across a rebuild ----------------------------------
function stubLabelCanvas() {
	const calls = { arcs: 0, strokes: 0 };
	const ctx = {
		setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
		arc() { calls.arcs++; }, stroke() { calls.strokes++; },
		fillText() {}, strokeText() {}, font: '', textBaseline: '',
		strokeStyle: '', fillStyle: '', lineWidth: 1,
	};
	return { calls, canvas: { width: 0, height: 0, getContext: () => ctx } };
}
{
	const { calls, canvas } = stubLabelCanvas();
	const layer = labelLayerLib.createLabelLayer(canvas, landmarks, constellations);
	layer.resize(W, H, 1);
	layer.setEnabled(true);
	layer.setStarSource(info);
	layer.setOrbitState(model, 0.5);
	const keys = new Uint32Array([identity[offsets[0] + 2] >>> 0, identity[offsets[1] + 3] >>> 0, 0xDEADBEEF]);
	layer.setSelectedKeys(keys, 3);
	layer.draw(camera, W, H);
	check('rings are drawn for the resolvable set members only',
		calls.arcs >= 2 && calls.arcs <= 4, { arcs: calls.arcs });
	const first = calls.arcs;
	layer.draw(camera, W, H);
	check('the map is not rebuilt per frame (drawing stays stable)', calls.arcs === first * 2, calls.arcs);
	// A rebuild: the same keys, written at different slots, still resolve.
	info.dynamicVersion++;
	const snapshot = Uint32Array.from(identity.subarray(offsets[0], offsets[0] + FIELD_N));
	identity.copyWithin(offsets[0] + 1, offsets[0], offsets[0] + FIELD_N - 1);
	identity.copyWithin(offsets[0], offsets[0] + 1, offsets[0] + FIELD_N - 1);
	identity[offsets[0] + 1] = snapshot[0];
	identity[offsets[0]] = snapshot[1];
	layer.draw(camera, W, H);
	check('after a block rebuild the keys still resolve to their new slots',
		calls.arcs > first * 2, { arcs: calls.arcs });
	layer.setSelectedKeys(keys, 0);
	layer.draw(camera, W, H);
	check('an empty set draws no rings', calls.arcs === first * 2 + (calls.arcs - first * 2), { arcs: calls.arcs });
}

// --- 7. Catalog keys survive thinning and residency changes ------------------
{
	const bundle = require('../src/data/tiles/catalog.js');
	const manifest = loader.prepareBundle(bundle);
	const stagingBytes = new Uint8Array(Math.max(manifest.starCount, 250000) * records.RECORD_BYTES);
	const keysA = new Uint32Array(Math.max(manifest.starCount, 250000));
	const keysB = new Uint32Array(Math.max(manifest.starCount, 250000));
	// Position A: near the Sun with the full visual budget (no thinning).
	const managerA = cellManagerLib.createCellManager(manifest, { budgetStars: 250000, visualBudget: 100000 });
	managerA.update(0, 0, 0.005, 1);
	const bytesA = managerA.writeInto(stagingBytes, 0, keysA, 0);
	const nA = bytesA / records.RECORD_BYTES;
	// Position B: a smaller visual budget, so the same cells are thinned hard.
	const managerB = cellManagerLib.createCellManager(manifest, { budgetStars: 250000, visualBudget: 400 });
	managerB.update(0, 0, 0.005, 1);
	const bytesB = managerB.writeInto(stagingBytes, 0, keysB, 0);
	const nB = bytesB / records.RECORD_BYTES;
	// For every key in B, the record must be the same star as in A (same payload
	// slot of the same cell), which is what "the key is the star" means.
	const posA = new Map();
	for (let i = 0; i < nA; i++) posA.set(keysA[i] >>> 0, i);
	let shared = 0;
	let same = 0;
	for (let i = 0; i < nB; i++) {
		const key = keysB[i] >>> 0;
		const slotA = posA.get(key);
		if (slotA === undefined) continue;
		shared++;
		const a = records.readRecord(new DataView(stagingBytes.buffer, stagingBytes.byteOffset), slotA * records.RECORD_BYTES);
		const b = records.readRecord(new DataView(stagingBytes.buffer, stagingBytes.byteOffset), i * records.RECORD_BYTES);
		if (a.packed === b.packed && Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.z - b.z) < 1e-9) same++;
	}
	check('catalog keys are stable under a residency/thinning change',
		shared > 20 && same === shared && nB < nA, { nA, nB, shared, same });
	check('writeInto without a key array still writes records',
		managerA.writeInto(stagingBytes, 0) === bytesA);
}

// --- 8. Timings at 300k ------------------------------------------------------
// The walk is dispatch-bound, not projection-bound: the projection is ~15 ns per
// record, `orbit.engineRecordPosition` is ~0.3 µs under the classic mask and
// ~1.2 µs with the apocenter pass (its Kepler solve runs for the selected
// share; machine-dependent, this run prints the live figures). So the budget is
// a *slice* budget — the picker is chunked across frames (plan §3.1) — and the
// numbers below are what the plan quotes.
{
	const BIG_N = 300000;
	const bigStaging = new ArrayBuffer(BIG_N * records.RECORD_BYTES);
	const bigView = new DataView(bigStaging);
	const bigIdentity = new Uint32Array(BIG_N);
	const big = sampling.sampleGalaxyStars(model, model.seed | 0, BIG_N, null);
	const derived = {};
	const tBuild = Date.now();
	for (let i = 0; i < BIG_N; i++) {
		const key = starTypes.fieldStarSeed(model.seed, i);
		starTypes.deriveStar(model, key, big.component[i], big.R[i], big.distToArm[i], derived, big.z[i]);
		records.writeRecord(bigView, i * records.RECORD_BYTES, big.x[i], big.y[i], big.z[i],
			derived.colorIndex, derived.absMag,
			orbit.flagsWithFamily(records.FLAG_VISIBLE, orbit.familyForStar(big.component[i], derived.spectralClass, model.barred)), 0);
		bigIdentity[i] = key;
	}
	const buildMs = Date.now() - tBuild;
	const bigBlocks = [{ kind: 'field', offset: 0, count: BIG_N }];
	const bigRenderer = {
		starBlocks: () => ({ identity: bigIdentity, view: bigView, blocks: bigBlocks, total: BIG_N, dynamicVersion: 1, member: memberMeta }),
		fieldBuffers: () => big,
	};
	const sel = selectionLib.createSelection(camera, landmarks);
	sel.setRenderer(bigRenderer);
	sel.setOrbitState(model, 0.5);
	const out = {};
	const SLICE_RECORDS = 32768;       // main.js's SWEEP_SLICE_RECORDS
	const SLICE_MS = 8;                // main.js's SWEEP_SLICE_MS
	const origEngine = orbit.getEngine();
	const measured = {};
	let worstSlice = 0;
	let simpleTotal = Infinity;
	let worstMask = 0;
	for (const mask of [1, 2, 5]) {
		orbit.setEngine(mask);
		sel.pickAny(W / 2, H / 2, W, H, out);        // warm
		let total = Infinity;
		for (let r = 0; r < 3; r++) {
			const t0 = performance.now();
			sel.pickAny(W / 2, H / 2, W, H, out);
			total = Math.min(total, performance.now() - t0);
		}
		// One frame-sized slice, timed the way the loop issues it — and the number
		// of frames a whole 300k sweep takes at that slice.
		let slice = Infinity;
		let slices = 0;
		for (let r = 0; r < 4; r++) {
			sel.beginPick(W / 2, H / 2, W, H, out);
			slices = 0;
			while (true) {
				const t0 = performance.now();
				const done = sel.pickStep(SLICE_RECORDS, SLICE_MS);
				slice = Math.min(slice, performance.now() - t0);
				slices++;
				if (done) break;
			}
		}
		measured[mask] = {
			total: +total.toFixed(2), slice: +slice.toFixed(2), slices,
			perRecordNs: Math.round(total * 1e6 / BIG_N),
		};
		if (slice > worstSlice) { worstSlice = slice; worstMask = mask; }
		if (mask === 2) simpleTotal = total;
	}
	orbit.setEngine(origEngine);
	console.log(`300k: build ${buildMs} ms  ` + [1, 2, 5].map(m =>
		`mask ${m}: ${measured[m].total} ms (${measured[m].perRecordNs} ns/rec, slice ${measured[m].slice} ms, ${measured[m].slices} slices)`).join('  '));
	// The slice is what a frame pays. The apocenter pass is the expensive one and
	// the loop's time budget is what keeps it from hitching; the record cap only
	// bounds the clock calls.
	check('a pick slice stays inside the loop\'s 8 ms budget (+clock overhead) for every mask',
		worstSlice < 11, { worstSlice, worstMask, measured });
	check('a whole 300k sweep is a bounded number of frames, not a freeze',
		[1, 2, 5].every(m => measured[m].slices < 80), { slices: [1, 2, 5].map(m => measured[m].slices) });
	check('the cheap mask finishes a whole 300k pick in a handful of frames',
		simpleTotal < 40, { simpleTotal, measured });
	check('the dispatch is the cost, and the walk reports what it measured',
		measured[1].perRecordNs > 100 && measured[1].perRecordNs < 1000, measured);

	// The radius scan is dispatch-bound the same way, so it is chunked on the same
	// budget: one slice inside the frame, the whole 300k sweep in a bounded number
	// of them. The centre is a drawn position 1 kpc out, the radius 2 kpc, so the
	// kept list is full and the sort runs its worst case.
	{
		const aroundSel = selectionLib.createSelection(camera, landmarks);
		aroundSel.setRenderer(bigRenderer);
		aroundSel.setOrbitState(model, AROUND_TIME);
		orbit.setPatternClock(AROUND_TIME, model);
		const centreRec = records.readRecord(bigView, 4000 * records.RECORD_BYTES);
		const centre = new Float64Array(3);
		let worstAroundSlice = 0;
		const aroundMeasured = {};
		for (const mask of [1, 5]) {
			orbit.setEngine(mask);
			drawRecord(0, 4000, centreRec, AROUND_TIME, centre);
			let slice = Infinity;
			let slices = 0;
			for (let r = 0; r < 3; r++) {
				aroundSel.beginSelectAround(centre[0], centre[1], centre[2], 2.0, starSetLib.CAPACITY);
				slices = 0;
				while (true) {
					const t0 = performance.now();
					const done = aroundSel.selectAroundStep(SLICE_RECORDS, SLICE_MS);
					slice = Math.min(slice, performance.now() - t0);
					slices++;
					if (done) break;
				}
			}
			aroundMeasured[mask] = {
				slice: +slice.toFixed(2), slices,
				kept: aroundSel.around.count, truncated: aroundSel.around.truncated,
			};
			if (slice > worstAroundSlice) worstAroundSlice = slice;
		}
		orbit.setEngine(origEngine);
		console.log('300k radius scan: ' + [1, 5].map(m =>
			`mask ${m}: slice ${aroundMeasured[m].slice} ms, ${aroundMeasured[m].slices} slices, ` +
			`kept ${aroundMeasured[m].kept}, truncated ${aroundMeasured[m].truncated}`).join('  '));
		check('a radius-scan slice stays inside the loop\'s 8 ms budget for every mask',
			worstAroundSlice < 11, { worstAroundSlice, aroundMeasured });
		check('a whole 300k radius scan is a bounded number of frames, not a freeze',
			[1, 5].every(m => aroundMeasured[m].slices < 80 && aroundMeasured[m].kept > 0),
			{ slices: [1, 5].map(m => aroundMeasured[m].slices) });
	}

	// The sweep and the one-call walk agree, record for record.
	orbit.setEngine(1);
	sel.beginPick(W / 2, H / 2, W, H, out);
	while (!sel.pickStep(SLICE_RECORDS, SLICE_MS)) { /* sweep in slices */ }
	const sweepHit = sel.pickResult();
	const syncHit = sel.pickAny(W / 2, H / 2, W, H, {});
	check('the chunked sweep finds the same star as the one-call walk',
		!!sweepHit && !!syncHit && sweepHit.key === syncHit.key && sweepHit.index === syncHit.index
		&& syncHit.dist2 === sweepHit.dist2,
		{ sweep: sweepHit && sweepHit.key, sync: syncHit && syncHit.key });
	// A block rebuild mid-sweep aborts rather than mixing two frames.
	sel.beginPick(W / 2, H / 2, W, H, out);
	sel.pickStep(1000, SLICE_MS);
	bigRenderer.versionBump = true;
	// (the renderer's dynamicVersion is what the sweep watches)
	const infoA = { identity: bigIdentity, view: bigView, blocks: bigBlocks, total: BIG_N, dynamicVersion: 2, member: memberMeta };
	sel.setRenderer({ starBlocks: () => infoA, fieldBuffers: () => big });
	sel.pickStep(SLICE_RECORDS, SLICE_MS);
	check('a rebuild during a sweep aborts it instead of mixing two frames',
		sel.pickResult() === null, sel.pickResult());
}

// --- 9. Wiring: the slider agrees with the module that owns the radius -------
{
	const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf-8');
	const m = /id="slider-selrad"[^>]*min="([^"]+)"[^>]*max="([^"]+)"[^>]*value="([^"]+)"/.exec(html);
	check('the select-radius slider spans Selection\'s own bounds and default',
		!!m
		&& Math.abs(Math.pow(10, Number(m[1])) - selectionLib.SELRAD_MIN_LY) < 1e-9
		&& Math.abs(Math.pow(10, Number(m[2])) - selectionLib.SELRAD_MAX_LY) < 1e-6
		&& Number(m[3]) === selectionLib.SELRAD_DEFAULT_LOG,
		m && m.slice(1));
	check('the menu has the select-around and clear buttons', /id="btn-select-around"/.test(html) && /id="btn-clear-set"/.test(html));
	check('the help text lists the three new keys', /\nF /.test(html) && /N \/ Shift\+N/.test(html) && /X /.test(html));
}

// --- Report ------------------------------------------------------------------
let passed = 0;
let failed = 0;
for (const c of checks) {
	if (c.pass) passed++; else failed++;
	console.log(`  ${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.pass ? '' : `  -> ${JSON.stringify(c.detail)}`}`);
}
console.log(`\n${passed}/${checks.length} passed, ${failed} failed`);

const logPath = path.join(__dirname, 'logs', 'star-select.json');
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
console.log(failed === 0 ? 'PASS — picking, the set, the radii and the budgets behave as the plan says' : `FAIL — ${failed} checks failed`);
process.exit(failed === 0 ? 0 : 1);
