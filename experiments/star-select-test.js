// experiments/star-select-test.js
// 0.5.0 star selection (0.5.0-plan §3): pickAny over all five record blocks
// under the engine-mask dispatch, the simple-engine approximation report, the
// selection set, select-around, key→slot resolution, fly-to, and the two
// click-cost budgets the plan pins (pick < 16 ms, radius scan < 5 ms at 300k).
//
// The fixtures are a real SamplingLib.sampleGalaxyStars field written into a
// blocksOut-shaped stub exactly the way star-sprites.js writes it, so the pick
// walk reads the same bytes the renderer uploaded, plus one hand-written
// record per non-procedural block keyed by §2.2's rules.
//
// Output: experiments/logs/star-select.json

'use strict';

const fs = require('fs');
const path = require('path');

// Alias window so the src modules attach their API here, as in the browser.
globalThis.window = globalThis;

const hash = require('../src/math/hash.js');
const coords = require('../src/math/coords.js');
const records = require('../src/math/star-record.js');
const galaxy = require('../src/math/galaxy.js');
const sampling = require('../src/math/sampling.js');
const starTypes = require('../src/math/star-types.js');
const orbit = require('../src/math/orbit.js');
const cameraModule = require('../src/core/camera.js');
const starSetModule = require('../src/core/star-set.js');
const selectionModule = require('../src/core/selection.js');
const landmarks = require('../src/data/landmarks.js');
const constellations = require('../src/data/constellations.js');
const labelModule = require('../src/render/label-layer.js');

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
	return !!pass;
}

const W = 1280, H = 800;
const T = 300;                     // Myr: field stars have genuinely moved by now
const SEED = 3;
const BLOCK_KINDS = ['procedural', 'landmark', 'objects', 'local', 'catalog'];
const VISIBLE_BIT = 0x10000;       // FLAG_VISIBLE, bit 0 of the flags byte
const PARITY_PX = 0.5;             // plan §3.7: the pick lands within half a pixel
const TIE_PX = 3;                  // Selection.PICK_TIE_PX
const PICK_BUDGET_MS = 16;         // plan §3.1
const RADIUS_BUDGET_MS = 5;        // plan §3.3
const TIMING_PROCEDURAL = 300000;

const model = galaxy.createGalaxy({ type: 'SBb', seed: SEED });

// --- Fixture ---------------------------------------------------------------
// One record per non-procedural block, keyed by §2.2. objectMemberSeed is not
// exported from objects.js, so the objects member carries its own deterministic
// member-seed-shaped key; what matters is stability, not provenance.
const LOCAL_SEED = (SEED ^ 0x10ca1cab) | 0;
const FIXED_STARS = [
	{ kind: 'landmark', rel: [2.3, 0.7, 0.05], colorIndex: 0, absMag: -4, family: orbit.FAMILY_PATTERN, jitter: 0x5a },
	{ kind: 'objects', rel: [4.1, -0.9, 0.2], colorIndex: 5, absMag: 2, family: orbit.FAMILY_BAR, jitter: 0x31 },
	{ kind: 'local', rel: [0.6, -3.2, 0.03], colorIndex: 4, absMag: 5, family: orbit.FAMILY_PRESSURE, jitter: 0x7c },
	{ kind: 'catalog', rel: [-3.7, -2.4, -0.3], colorIndex: 7, absMag: 12, family: orbit.FAMILY_DISC, jitter: 0x19 },
];

function fixedKey(kind, inBlock) {
	if (kind === 'landmark') return hash.hash4(hash.DOMAIN_LANDMARK, inBlock, 0, 0);
	if (kind === 'objects') {
		return (Math.imul(0x0b5e55, 0x9e3779b1) ^ Math.imul(inBlock + 1, 0x85ebca6b)) >>> 0;
	}
	if (kind === 'local') {
		return (Math.imul(LOCAL_SEED, 0x9e3779b1)
			^ Math.imul(77, 0x85ebca6b)
			^ Math.imul(inBlock + 1, 0xc2b2ae3d)) >>> 0;
	}
	return hash.hash4(hash.DOMAIN_CATALOG, 77, inBlock, 0);
}

// A blocksOut-shaped stub: { identity, float32, uint32, blocks[5], total }.
// The procedural records are a real sampleGalaxyStars field derived the way
// writeProceduralRecords derives them; the rest are hand-written.
function buildFixture(proceduralCount, withFixed) {
	const field = proceduralCount > 0
		? sampling.sampleGalaxyStars(model, SEED, proceduralCount, null)
		: null;
	const fixed = withFixed ? FIXED_STARS : [];
	const counts = [proceduralCount, 0, 0, 0, 0];
	for (const s of fixed) counts[BLOCK_KINDS.indexOf(s.kind)]++;
	const blocks = [];
	let offset = 0;
	for (let b = 0; b < BLOCK_KINDS.length; b++) {
		blocks.push({ kind: BLOCK_KINDS[b], offset, count: counts[b] });
		offset += counts[b];
	}
	const total = offset;
	const staging = new ArrayBuffer(total * records.RECORD_BYTES);
	const view = new DataView(staging);
	const identity = new Uint32Array(total);
	const derived = {};
	const stars = [];
	for (let i = 0; i < proceduralCount; i++) {
		const key = starTypes.fieldStarSeed(SEED, i);
		starTypes.deriveStar(model, key, field.component[i], field.R[i],
			field.distToArm[i], derived, field.z[i]);
		records.writeRecord(view, i * records.RECORD_BYTES,
			field.x[i], field.y[i], field.z[i],
			derived.colorIndex, derived.absMag,
			orbit.flagsWithFamily(records.FLAG_VISIBLE,
				orbit.familyForStar(field.component[i], derived.spectralClass, model.barred)),
			Math.imul(i, 2654435761) & 0xFF);
		identity[i] = key;
		stars.push({ kind: 'procedural', slot: i, key, x: field.x[i], y: field.y[i], z: field.z[i] });
	}
	let slot = proceduralCount;
	const perKind = {};
	const c = model.centre;
	for (const s of fixed) {
		const inBlock = perKind[s.kind] || 0;
		perKind[s.kind] = inBlock + 1;
		const x = c.x + s.rel[0], y = c.y + s.rel[1], z = c.z + s.rel[2];
		records.writeRecord(view, slot * records.RECORD_BYTES, x, y, z,
			s.colorIndex, s.absMag, orbit.flagsWithFamily(records.FLAG_VISIBLE, s.family), s.jitter);
		identity[slot] = fixedKey(s.kind, inBlock);
		stars.push({ kind: s.kind, slot, key: identity[slot], x, y, z });
		slot++;
	}
	return {
		stub: {
			identity, view, float32: new Float32Array(staging), uint32: new Uint32Array(staging),
			blocks, total,
		},
		stars,
		field,
	};
}

function aimAt(cam, x, y, z) {
	const d = Math.hypot(x, y, z);
	cam.setState({ position: [0, 0, 0], yaw: Math.atan2(y, x), pitch: Math.asin(z / d) });
}

// The dispatch, re-stated from movement-parity-plan's table: the classic law or
// the identity baseline (whichever the mask carries), then the apocenter pass
// on its birth-selected subset. The simple engine's field-star azimuths live
// on the GPU, so a mask with its bit falls back to this baseline and says so.
const refOut = new Float64Array(3);
function referenceRecordPosition(out, bx, by, bz, packed, time) {
	const jitter = (packed >>> 24) & 255;
	const family = orbit.familyFromFlags((packed >>> 16) & 255);
	const phase = jitter & 15, amplitude = jitter >>> 4;
	if (orbit.getEngine() & orbit.ENGINE_CLASSIC) {
		orbit.orbitPosition(out, bx, by, bz, family, phase, amplitude, time, model);
	} else {
		out[0] = bx; out[1] = by; out[2] = bz;
	}
	if ((orbit.getEngine() & orbit.ENGINE_APOCENTER) && time !== 0
		&& orbit.apocenterSelected(bx, by, bz)) {
		orbit.apocenterPosition(out, bx, by, bz, family, phase, amplitude, time, model);
	}
	return out;
}

function newHit() {
	return { key: 0, blockKind: '', index: -1, x: 0, y: 0, z: 0, packed: 0, dist2: 0 };
}

// --- 1. The selection set ---------------------------------------------------
{
	const set = starSetModule.createStarSet();
	check('the set is bounded and preallocated (256 snapshots)',
		set.capacity() === starSetModule.STAR_SET_CAPACITY && set.count() === 0
		&& set.keys.length === 256 && set.primary() === 0, set.capacity());

	set.addStar(11, 5);
	set.addStar(22, 1);
	set.addStar(33, 3);
	check('addStar keeps the set nearest-first',
		set.count() === 3 && set.keyAt(0) === 22 && set.keyAt(1) === 33 && set.keyAt(2) === 11,
		[set.keyAt(0), set.keyAt(1), set.keyAt(2)]);
	check('the primary is slot 0', set.primary() === 22);
	check('indexOf and hasStar agree, and reject absent keys',
		set.indexOf(33) === 1 && set.hasStar(11) && !set.hasStar(44) && set.indexOf(44) === -1);
	check('a re-added key is re-placed at its new distance, not duplicated',
		set.addStar(11, 0.5) && set.count() === 3 && set.keyAt(0) === 11 && set.distanceAt(0) === 0.5);
	check('a duplicate add at the same distance is a no-op',
		set.addStar(22, 1) && set.count() === 3 && set.keyAt(1) === 22);
	check('an unknown key cannot become the primary', set.setPrimary(99) === false && set.primary() === 11);

	set.addStar(44, 7);
	set.addStar(55, 9);
	check('removeStar shifts the tail down and reports membership',
		set.removeStar(22) && set.count() === 4 && !set.hasStar(22)
		&& set.keyAt(0) === 11 && set.keyAt(1) === 33, [set.count(), set.keyAt(0), set.keyAt(1)]);
	check('removing an absent key is a no-op', set.removeStar(1234) === false && set.count() === 4);
	check('toggleStar removes a member and adds a stranger',
		set.toggleStar(33, 3) === false && set.toggleStar(66, 2) === true
		&& set.hasStar(66) && !set.hasStar(33));

	set.clearSet();
	set.addStar(7, 4);
	set.addStar(8, 3);
	set.addStar(9, 2);
	check('setPrimary rotates the chosen key to slot 0 and keeps the rest ordered',
		set.setPrimary(7) && set.primary() === 7 && set.keyAt(1) === 9 && set.keyAt(2) === 8,
		[set.keyAt(0), set.keyAt(1), set.keyAt(2)]);
	check('nearestSetStar finds the smallest stored distance whatever the ordering',
		set.nearestSetStar() === 1, set.nearestSetStar());
	check('setStar replaces the whole set with one star',
		set.setStar(1234, 0.25) && set.count() === 1 && set.primary() === 1234);

	// Capacity: the farthest from the camera is dropped — the cell manager's
	// nearest-first budget rule, applied to snapshots. Keys 1..256 are filed at
	// distances 999..744, so key 1 is the farthest and key 256 the nearest.
	const full = starSetModule.createStarSet();
	let drops = 0;
	for (let i = 0; i < starSetModule.STAR_SET_CAPACITY; i++) {
		if (!full.addStar(i + 1, 1000 - i)) drops++;
	}
	check('the set fills to exactly its capacity', full.count() === 256 && full.keyAt(0) === 256 && drops === 0,
		[full.count(), full.keyAt(0), drops]);
	check('a nearer newcomer evicts the farthest',
		full.addStar(10000, 500) && full.count() === 256 && full.hasStar(10000) && !full.hasStar(1)
		&& full.keyAt(0) === 10000, full.count());
	check('a farther newcomer is dropped and reports it',
		full.addStar(20000, 999) === false && full.count() === 256 && !full.hasStar(20000));
	check('an existing key at a nearer distance is re-placed without evicting',
		full.addStar(255, 400) && full.count() === 256 && full.distanceAt(full.indexOf(255)) === 400);

	check('keyDesignation is §4.11’s S<base36> form',
		starSetModule.keyDesignation(123456789) === 'S21I3V9'
		&& starSetModule.keyDesignation(4294967295) === 'S1Z141Z3'
		&& starSetModule.keyDesignation(7) === 'S7'
		&& starSetModule.keyDesignation(0) === '',
		[starSetModule.keyDesignation(123456789), starSetModule.keyDesignation(4294967295)]);
}

// --- 2. Picking: a miss is a no-op ------------------------------------------
{
	const cam = cameraModule.createCamera();
	const sel = selectionModule.createSelection(cam, landmarks);
	// One star, so "facing away" has exactly one record to miss.
	const fixture = buildFixture(1, false);
	const lone = fixture.stars[0];
	sel.setRecordBlocks(() => fixture.stub);
	aimAt(cam, lone.x, lone.y, lone.z);
	check('a click straight at the one drawn star picks it',
		sel.pickAny(W / 2, H / 2, W, H, newHit()).key === lone.key);

	const bare = selectionModule.createSelection(cam, landmarks);
	check('pickAny with no record source returns null',
		bare.pickAny(W / 2, H / 2, W, H, newHit()) === null);

	const empty = buildFixture(0, false);
	sel.setRecordBlocks(() => empty.stub);
	check('pickAny over an empty buffer returns null', sel.pickAny(W / 2, H / 2, W, H, newHit()) === null);

	sel.setRecordBlocks(() => fixture.stub);
	aimAt(cam, -lone.x, -lone.y, -lone.z);
	check('a click with the camera facing away picks nothing',
		sel.pickAny(W / 2, H / 2, W, H, newHit()) === null);
	aimAt(cam, lone.x, lone.y, lone.z);
	check('a degenerate viewport picks nothing', sel.pickAny(10, 10, 0, 0, newHit()) === null);

	// Every record invisible: the walk finds nothing and does not throw.
	const hidden = buildFixture(6, true);
	const hiddenWords = hidden.stub.uint32;
	for (let i = 0; i < hidden.stub.total; i++) hiddenWords[i * 4 + 3] &= ~VISIBLE_BIT;
	sel.setRecordBlocks(() => hidden.stub);
	let threw = false;
	let miss = null;
	try { miss = sel.pickAny(W / 2, H / 2, W, H, newHit()); } catch (error) { threw = true; }
	check('a buffer of invisible records picks nothing and throws nothing',
		!threw && miss === null, { threw, miss });
}

// --- 3. Picking any drawn star: dispatch parity, all five blocks ------------
{
	const cam = cameraModule.createCamera();
	const sel = selectionModule.createSelection(cam, landmarks);
	const fixture = buildFixture(6, true);
	const stub = fixture.stub;
	sel.setRecordBlocks(() => stub);
	const sweep = [fixture.stars[0], fixture.stars[2], ...fixture.stars.slice(6)];

	const savedEngine = orbit.getEngine();
	const savedShare = orbit.getApocenterShare();
	const savedForce = orbit.getApocenterForce();
	const savedDamping = orbit.getWaveDamping();
	orbit.setWaveDamping(0);
	orbit.setApocenterForce(orbit.APOCENTER_ECC_MAX);
	orbit.setApocenterShare(1);

	const proj = new Float32Array(3);
	const results = { exact: 0, exactTotal: 0, approxOk: 0, approxTotal: 0, minSep: Infinity, moved: 0 };
	for (const mask of [1, 2, 3, 4, 5, 6, 7]) {
		orbit.setEngine(mask);
		sel.setOrbitState(model, T);
		const expected = sweep.map((s) => {
			const w = s.slot * 4;
			return Array.from(referenceRecordPosition(refOut,
				stub.float32[w], stub.float32[w + 1], stub.float32[w + 2], stub.uint32[w + 3], T));
		});
		for (let i = 0; i < sweep.length; i++) {
			const s = sweep[i], d = expected[i];
			aimAt(cam, d[0], d[1], d[2]);
			const vp = cam.buildViewProj(W / H);
			// Unambiguous target: the nearest other star must stay outside the
			// tie band, or a brightness tie could legitimately change the winner.
			let minSep = Infinity;
			for (const other of fixture.stars) {
				if (other === s) continue;
				const w = other.slot * 4;
				const p = referenceRecordPosition(refOut,
					stub.float32[w], stub.float32[w + 1], stub.float32[w + 2], stub.uint32[w + 3], T);
				if (!coords.projectToScreen(vp, p[0], p[1], p[2], 0, 0, 0, W, H, proj)) continue;
				const sep = Math.hypot(proj[0] - W / 2, proj[1] - H / 2);
				if (sep < minSep) minSep = sep;
			}
			if (minSep < results.minSep) results.minSep = minSep;

			const hit = sel.pickAny(W / 2, H / 2, W, H, newHit());
			const right = !!(hit && hit.key === s.key && hit.index === s.slot && hit.blockKind === s.kind);
			const birth = [stub.float32[s.slot * 4], stub.float32[s.slot * 4 + 1], stub.float32[s.slot * 4 + 2]];
			if (Math.hypot(d[0] - birth[0], d[1] - birth[1], d[2] - birth[2]) > 0.2) results.moved++;
			const approx = orbit.recordPositionApproximated();
			const worldErr = hit ? Math.hypot(hit.x - d[0], hit.y - d[1], hit.z - d[2]) : Infinity;
			const pxOk = !!hit && coords.projectToScreen(vp, hit.x, hit.y, hit.z, 0, 0, 0, W, H, proj)
				&& Math.hypot(proj[0] - W / 2, proj[1] - H / 2) <= PARITY_PX;
			const exact = right && pxOk && worldErr < 1e-6;
			if (mask & orbit.ENGINE_SIMPLE) {
				results.approxTotal++;
				if (right && approx) results.approxOk++;
			} else {
				results.exactTotal++;
				if (exact) results.exact++;
			}
			if (!right) {
				check(`mask ${mask} picks the ${s.kind} record`, false,
					{ wanted: { key: s.key, slot: s.slot }, got: hit && { key: hit.key, index: hit.index, kind: hit.blockKind } });
			}
		}
	}
	orbit.setEngine(savedEngine);
	orbit.setApocenterShare(savedShare);
	orbit.setApocenterForce(savedForce);
	orbit.setWaveDamping(savedDamping);
	sel.setOrbitState(model, 0);

	check('masks 1/4/5 pick the record the dispatch moved, in every one of the five blocks',
		results.exact === results.exactTotal,
		{ exact: results.exact, of: results.exactTotal, moved: results.moved });
	check('masks 2/3/6/7 report the simple-engine approximation and still pick the baseline star',
		results.approxOk === results.approxTotal, { approxOk: results.approxOk, of: results.approxTotal });
	check('the swept stars never crowd each other inside the 3 px tie band',
		results.minSep > TIE_PX, results.minSep);
	// One star per block must actually have moved, or the parity sweep proves
	// nothing about the dispatch.
	check('the dispatch really moved the swept stars at T = 300 Myr',
		results.moved >= sweep.length, { moved: results.moved, of: sweep.length });
}

// --- 4. The apocenter subset: the pick follows the same partition -----------
{
	const c = model.centre;
	const posA = [c.x + 4.0, 0.3, 0.05];
	let posB = [c.x + 3.2, -0.6, 0.1];
	const savedShare = orbit.getApocenterShare();
	orbit.setApocenterShare(0.5);
	for (let k = 0; k < 40 && orbit.apocenterSelected(posA[0], posA[1], posA[2])
		=== orbit.apocenterSelected(posB[0], posB[1], posB[2]); k++) {
		posB = [c.x + 3.2, -0.6 + 0.05 * (k + 1), 0.1];
	}
	const selA = orbit.apocenterSelected(posA[0], posA[1], posA[2]);
	const selB = orbit.apocenterSelected(posB[0], posB[1], posB[2]);

	const blocks = [
		{ kind: 'procedural', offset: 0, count: 0 },
		{ kind: 'landmark', offset: 0, count: 2 },
		{ kind: 'objects', offset: 2, count: 0 },
		{ kind: 'local', offset: 2, count: 0 },
		{ kind: 'catalog', offset: 2, count: 0 },
	];
	const staging = new ArrayBuffer(2 * records.RECORD_BYTES);
	const view = new DataView(staging);
	const identity = Uint32Array.of(hash.hash4(hash.DOMAIN_LANDMARK, 0, 0, 0),
		hash.hash4(hash.DOMAIN_LANDMARK, 1, 0, 0));
	const flags = orbit.flagsWithFamily(records.FLAG_VISIBLE, orbit.FAMILY_DISC);
	records.writeRecord(view, 0, posA[0], posA[1], posA[2], 5, 3, flags, 0x35);
	records.writeRecord(view, records.RECORD_BYTES, posB[0], posB[1], posB[2], 5, 3, flags, 0x35);
	const stub = {
		identity, view, float32: new Float32Array(staging), uint32: new Uint32Array(staging),
		blocks, total: 2,
	};
	const cam = cameraModule.createCamera();
	const sel = selectionModule.createSelection(cam, landmarks);
	sel.setRecordBlocks(() => stub);
	const savedEngine = orbit.getEngine();
	orbit.setEngine(orbit.ENGINE_APOCENTER);
	sel.setOrbitState(model, T);
	const ok = [0, 1].map((slot) => {
		const w = slot * 4;
		const d = Array.from(referenceRecordPosition(refOut,
			stub.float32[w], stub.float32[w + 1], stub.float32[w + 2], stub.uint32[w + 3], T));
		aimAt(cam, d[0], d[1], d[2]);
		const hit = sel.pickAny(W / 2, H / 2, W, H, newHit());
		return !!(hit && hit.index === slot
			&& Math.hypot(hit.x - d[0], hit.y - d[1], hit.z - d[2]) < 1e-6);
	});
	orbit.setEngine(savedEngine);
	orbit.setApocenterShare(savedShare);
	check('under apocenter share 0.5 the pick target follows the birth-hash subset (one guided, one frozen)',
		ok[0] && ok[1] && selA !== selB, { selA, selB, ok });
}

// --- 5. Tie-break: brightness inside the band, distance outside it ----------
{
	const cam = cameraModule.createCamera();
	const sel = selectionModule.createSelection(cam, landmarks);
	const blocks = [
		{ kind: 'procedural', offset: 0, count: 2 },
		{ kind: 'landmark', offset: 2, count: 0 },
		{ kind: 'objects', offset: 2, count: 0 },
		{ kind: 'local', offset: 2, count: 0 },
		{ kind: 'catalog', offset: 2, count: 0 },
	];
	const R = 10;
	const staging = new ArrayBuffer(2 * records.RECORD_BYTES);
	const view = new DataView(staging);
	const f32 = new Float32Array(staging);
	// Pixels per kpc, measured from the projection itself: the two stars are
	// then placed a fixed number of pixels apart whatever the viewport. The
	// offset runs along the camera's up axis (world z), which projects to
	// screen y; the right axis (world y) projects to screen x.
	aimAt(cam, R, 0, 0);
	const vp0 = cam.buildViewProj(W / H);
	const measure = new Float32Array(3);
	coords.projectToScreen(vp0, R, 0, 0, 0, 0, 0, W, H, measure);
	const zeroY = measure[1];
	coords.projectToScreen(vp0, R, 0, 0.001, 0, 0, 0, W, H, measure);
	const pxPerKpc = Math.abs(measure[1] - zeroY) / 0.001;
	const dz = (TIE_PX + 1.5) / pxPerKpc;
	// record 0: bright (small absMag byte). record 1: faint, walked second.
	records.writeRecord(view, 0, R, 0, 0, 3, 1.0, records.FLAG_VISIBLE, 0);
	records.writeRecord(view, records.RECORD_BYTES, R, 0, dz, 6, 9.0, records.FLAG_VISIBLE, 0);
	const identity = Uint32Array.of(101, 202);
	const stub = { identity, view, float32: f32, uint32: new Uint32Array(staging), blocks, total: 2 };
	sel.setRecordBlocks(() => stub);
	const vp = cam.buildViewProj(W / H);
	const p0 = new Float32Array(3), p1 = new Float32Array(3);
	coords.projectToScreen(vp, R, 0, 0, 0, 0, 0, W, H, p0);
	coords.projectToScreen(vp, R, 0, dz, 0, 0, 0, W, H, p1);
	const sep = Math.hypot(p0[0] - p1[0], p0[1] - p1[1]);
	check('the tie fixture is a real pair: both visible, outside the tie band apart',
		p0[2] > 0 && p1[2] > 0 && sep > TIE_PX && sep < TIE_PX * 2 && Math.abs(p0[0] - p1[0]) < 1e-6,
		{ sep, tie: selectionModule.PICK_TIE_PX });

	const hitBright = sel.pickAny(p0[0], p0[1], W, H, newHit());
	const hitFaint = sel.pickAny(p1[0], p1[1], W, H, newHit());
	const hitMid = sel.pickAny((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, W, H, newHit());
	check('outside the tie band the nearer star wins, either way round',
		!!hitBright && hitBright.key === 101 && !!hitFaint && hitFaint.key === 202,
		{ bright: hitBright && hitBright.key, faint: hitFaint && hitFaint.key, sep });
	check('inside the tie band the brighter absolute magnitude wins over the nearer star',
		!!hitMid && hitMid.key === 101, hitMid && hitMid.key);
	check('the reported packed words carry both magnitudes (bright byte < faint byte)',
		((hitBright.packed >>> 8) & 255) < ((hitFaint.packed >>> 8) & 255),
		{ bright: (hitBright.packed >>> 8) & 255, faint: (hitFaint.packed >>> 8) & 255 });
}

// --- 6. Key → slot, and the record readers ----------------------------------
{
	const cam = cameraModule.createCamera();
	const sel = selectionModule.createSelection(cam, landmarks);
	const fixture = buildFixture(6, true);
	const stub = fixture.stub;
	sel.setRecordBlocks(() => stub);
	sel.setOrbitState(model, 0);

	const resolved = fixture.stars.map((s) => sel.resolveSlot(s.key));
	check('resolveSlot maps every fixture key back to its slot',
		resolved.every((slot, i) => slot === fixture.stars[i].slot), resolved);
	check('resolveSlot rejects an unknown key and the reserved zero key',
		sel.resolveSlot(0xdeadbeef) === -1 && sel.resolveSlot(0) === -1);

	const landmark = fixture.stars[6];
	const lw = landmark.slot * 4;
	const word = sel.recordWordAt(landmark.slot);
	check('recordWordAt returns the stored packed word',
		word === stub.uint32[lw + 3], { word, packed: stub.uint32[lw + 3] });
	check('recordWordAt reports 0 for an out-of-range slot',
		sel.recordWordAt(stub.total) === 0 && sel.recordWordAt(-1) === 0);

	const pos = new Float64Array(3);
	const okPos = sel.recordPositionAt(landmark.slot, pos);
	check('recordPositionAt returns the stored position at time 0',
		okPos && Math.abs(pos[0] - stub.float32[lw]) < 1e-12
		&& Math.abs(pos[1] - stub.float32[lw + 1]) < 1e-12
		&& Math.abs(pos[2] - stub.float32[lw + 2]) < 1e-12, Array.from(pos));
	check('recordPositionAt rejects an out-of-range slot',
		sel.recordPositionAt(stub.total, pos) === false && sel.recordPositionAt(-1, pos) === false);

	const savedEngine = orbit.getEngine();
	orbit.setEngine(orbit.ENGINE_CLASSIC);
	sel.setOrbitState(model, T);
	const movedPos = new Float64Array(3);
	const moved = sel.recordPositionAt(landmark.slot, movedPos);
	const dispatched = referenceRecordPosition(refOut,
		stub.float32[lw], stub.float32[lw + 1], stub.float32[lw + 2], stub.uint32[lw + 3], T);
	orbit.setEngine(savedEngine);
	sel.setOrbitState(model, 0);
	check('recordPositionAt dispatches the record through the shared mask at T ≠ 0',
		moved && Math.hypot(movedPos[0] - dispatched[0], movedPos[1] - dispatched[1],
			movedPos[2] - dispatched[2]) < 1e-9,
		{ movedPos: Array.from(movedPos), dispatched: Array.from(dispatched) });
	check('the readers allocate nothing: one hit object and one result object, reused',
		sel.pickAny(W / 2, H / 2, W, H) === sel.pickAny(W / 2, H / 2, W, H)
		&& sel.selectAround(0, 0, 0, 1) === sel.selectAround(0, 0, 0, 1));
}

// --- 7. Select around -------------------------------------------------------
{
// A small field with a known answer: 24 stars in a 0.5 kpc box, two of them
// invisible, so the brute-force reference has to skip them too. The radius is
// chosen from the distances themselves (between the 18th and 19th star), so
// the answer is deterministic whatever the hash happens to place.
	const N = 24;
	const boxSeed = (Math.imul(SEED, 0x9e3779b1) ^ 0x51a7e75) | 0;
	const staging = new ArrayBuffer(N * records.RECORD_BYTES);
	const view = new DataView(staging);
	const identity = new Uint32Array(N);
	for (let i = 0; i < N; i++) {
		const u = (hash.hash01At(boxSeed + i, 1) - 0.5) * 0.5;
		const v = (hash.hash01At(boxSeed + i, 2) - 0.5) * 0.5;
		const w = (hash.hash01At(boxSeed + i, 3) - 0.5) * 0.5;
		records.writeRecord(view, i * records.RECORD_BYTES, u, v, w, 4, 7,
			i === 3 || i === 17 ? 0 : records.FLAG_VISIBLE, 0);
		identity[i] = 1000 + i;
	}
	const blocks = [
		{ kind: 'procedural', offset: 0, count: N },
		{ kind: 'landmark', offset: N, count: 0 },
		{ kind: 'objects', offset: N, count: 0 },
		{ kind: 'local', offset: N, count: 0 },
		{ kind: 'catalog', offset: N, count: 0 },
	];
	const stub = { identity, view, float32: new Float32Array(staging), uint32: new Uint32Array(staging), blocks, total: N };
	const cam = cameraModule.createCamera();
	const sel = selectionModule.createSelection(cam, landmarks);
	sel.setRecordBlocks(() => stub);

	const centre = [0.05, -0.02, 0.01];
	const allD2 = [];
	for (let i = 0; i < N; i++) {
		const w = i * 4;
		if ((stub.uint32[w + 3] & VISIBLE_BIT) === 0) continue;
		const dx = stub.float32[w] - centre[0];
		const dy = stub.float32[w + 1] - centre[1];
		const dz = stub.float32[w + 2] - centre[2];
		allD2.push(dx * dx + dy * dy + dz * dz);
	}
	allD2.sort((a, b) => a - b);
	const radiusKpc = Math.sqrt(Math.sqrt(allD2[17] * allD2[18]));
	const out = sel.selectAround(centre[0], centre[1], centre[2], radiusKpc);
	const expected = [];
	for (let i = 0; i < N; i++) {
		const w = i * 4;
		if ((stub.uint32[w + 3] & VISIBLE_BIT) === 0) continue;
		const dx = stub.float32[w] - centre[0];
		const dy = stub.float32[w + 1] - centre[1];
		const dz = stub.float32[w + 2] - centre[2];
		const d2 = dx * dx + dy * dy + dz * dz;
		if (d2 > radiusKpc * radiusKpc) continue;
		expected.push({ key: identity[i], d2, i });
	}
	expected.sort((a, b) => a.d2 - b.d2);   // stable: scan order breaks ties, as the insertion sort does
	const want = expected.slice(0, starSetModule.STAR_SET_CAPACITY);
	let keysOk = out.count === want.length && out.keys.length === starSetModule.STAR_SET_CAPACITY;
	let distsOk = keysOk;
	for (let i = 0; i < want.length; i++) {
		if (out.keys[i] !== want[i].key) keysOk = false;
		if (out.dists[i] !== want[i].d2) distsOk = false;
	}
	check('selectAround equals an independent brute-force list, nearest-first',
		keysOk && distsOk && out.count > 1, { count: out.count, expected: want.length, keysOk, distsOk });

	const first = want[0];
	const focal = [stub.float32[first.i * 4], stub.float32[first.i * 4 + 1], stub.float32[first.i * 4 + 2]];
	const around = sel.selectAround(focal[0], focal[1], focal[2], radiusKpc);
	check('select-around on a star returns a non-empty set with that star at index 0',
		around.count > 0 && around.keys[0] === first.key && around.dists[0] === 0,
		{ key: around.keys[0], dist: around.dists[0] });

	const bare = selectionModule.createSelection(cam, landmarks);
	check('an empty radius, and a selection with no record source, collect nothing',
		sel.selectAround(0, 0, 0, 0).count === 0 && bare.selectAround(0, 0, 0, 0.1).count === 0);

	const roundTrip = selectionModule.radiusFromSlider(selectionModule.sliderFromRadius(50));
	check('the select radius slider round-trips (log10 0.1 … 100 000 ly)',
		Math.abs(roundTrip - 50) < 50 * 0.01 && selectionModule.SELECT_RADIUS_LY_DEFAULT === 50
		&& selectionModule.radiusFromSlider(0) === selectionModule.SELECT_RADIUS_LY_MIN
		&& selectionModule.radiusFromSlider(100) === selectionModule.SELECT_RADIUS_LY_MAX
		&& selectionModule.sliderFromRadius(selectionModule.SELECT_RADIUS_LY_MIN) === 0,
		{ roundTrip, min: selectionModule.radiusFromSlider(0), max: selectionModule.radiusFromSlider(100) });
}

// --- 8. The label layer's set rings -----------------------------------------
function createMockLayer() {
	const calls = { arcs: [], stroke: '' };
	const ctx = {
		font: '', fillStyle: '', strokeStyle: '', lineWidth: 0, textBaseline: '',
		setTransform() {}, clearRect() {}, beginPath() { calls.stroke = ctx.strokeStyle; },
		moveTo() {}, lineTo() {}, stroke() {},
		arc(x, y, r) { calls.arcs.push({ x, y, r, stroke: calls.stroke }); },
		strokeText() {}, fillText() {},
	};
	const canvas = { width: 0, height: 0, getContext: () => ctx };
	return { canvas, calls, reset() { calls.arcs.length = 0; } };
}

{
	const mock = createMockLayer();
	const layer = labelModule.createLabelLayer(mock.canvas, landmarks, constellations);
	layer.resize(W, H, 1);
	const cam = cameraModule.createCamera();
	const sel = selectionModule.createSelection(cam, landmarks);
	const fixture = buildFixture(6, true);
	const stub = fixture.stub;
	sel.setRecordBlocks(() => stub);
	layer.setRecordSource(() => stub);

	// primary = the landmark record, a member = the catalog record, plus a key
	// that is not resident right now.
	const primary = fixture.stars[6], member = fixture.stars[9];
	aimAt(cam, primary.x, primary.y, primary.z);
	layer.setSelectedKeys(Uint32Array.of(primary.key, member.key, 0x5eed1e), 3);
	mock.reset();
	layer.draw(cam, W, H);
	const vp = cam.buildViewProj(W / H);
	const proj = new Float32Array(3);
	const at = (s) => coords.projectToScreen(vp, s.x, s.y, s.z,
		cam.cameraPos[0], cam.cameraPos[1], cam.cameraPos[2], W, H, proj)
		? [proj[0], proj[1]] : null;
	const p0 = at(primary), p1 = at(member);
	const ringOf = (p) => mock.calls.arcs.find((a) => Math.hypot(a.x - p[0], a.y - p[1]) < 0.01);
	check('the label layer rings resident set members: primary bright, member dim',
		!!p0 && !!p1 && mock.calls.arcs.length === 2
		&& ringOf(p0).r === labelModule.SELECT_RING_PX && ringOf(p0).stroke === labelModule.SELECT_RING
		&& ringOf(p1).r === labelModule.SET_RING_PX && ringOf(p1).stroke === labelModule.SET_RING_STROKE,
		{ arcs: mock.calls.arcs.map((a) => ({ ...a })),
			selectRingPx: labelModule.SELECT_RING_PX, setRingPx: labelModule.SET_RING_PX });

	// A residency rebuild rewrites the dynamic blocks: the identity slot is
	// zeroed and the block count is the signature the key→slot map keys on.
	const savedCount = stub.blocks[4].count;
	const savedKey = stub.identity[9];
	stub.identity[9] = 0;
	stub.blocks[4].count = 0;
	mock.reset();
	layer.draw(cam, W, H);
	const ring0 = mock.calls.arcs[0];
	check('a block-count change rebuilds the key→slot map (the departed star loses its ring)',
		mock.calls.arcs.length === 1 && !!p0 && ring0
		&& Math.hypot(ring0.x - p0[0], ring0.y - p0[1]) < 0.01 && ring0.r === labelModule.SELECT_RING_PX,
		mock.calls.arcs.map((a) => ({ ...a })));
	stub.identity[9] = savedKey;
	stub.blocks[4].count = savedCount;

	// 256 rings is noise: the layer draws the nearest SET_RINGS_MAX members.
	// The cluster is hand-placed in a tight box so all 20 are in view.
	const CX = 10, CY = 0.5, CZ = 0.2;
	const clusterCount = 20;
	const cStaging = new ArrayBuffer(clusterCount * records.RECORD_BYTES);
	const cView = new DataView(cStaging);
	const cIdentity = new Uint32Array(clusterCount);
	const cKeys = new Uint32Array(clusterCount);
	for (let i = 0; i < clusterCount; i++) {
		records.writeRecord(cView, i * records.RECORD_BYTES,
			CX + 0.06 * Math.cos(i * 1.7), CY + 0.06 * Math.sin(i * 2.3), CZ + 0.04 * Math.cos(i),
			i, 5, records.FLAG_VISIBLE, 0);
		cIdentity[i] = 5000 + i;
		cKeys[i] = 5000 + i;
	}
	const clusterStub = {
		identity: cIdentity, view: cView, float32: new Float32Array(cStaging),
		uint32: new Uint32Array(cStaging),
		blocks: [
			{ kind: 'procedural', offset: 0, count: clusterCount },
			{ kind: 'landmark', offset: clusterCount, count: 0 },
			{ kind: 'objects', offset: clusterCount, count: 0 },
			{ kind: 'local', offset: clusterCount, count: 0 },
			{ kind: 'catalog', offset: clusterCount, count: 0 },
		],
		total: clusterCount,
	};
	aimAt(cam, CX, CY, CZ);
	layer.setRecordSource(() => clusterStub);
	layer.setSelectedKeys(cKeys, clusterCount);
	mock.reset();
	layer.draw(cam, W, H);
	check('at most SET_RINGS_MAX set members are ringed',
		mock.calls.arcs.length === labelModule.SET_RINGS_MAX, mock.calls.arcs.length);

	layer.clearSelectedKeys();
	mock.reset();
	layer.draw(cam, W, H);
	check('clearing the set leaves no rings behind', mock.calls.arcs.length === 0);
}

// --- 9. Fly to the selection ------------------------------------------------
{
	const cam = cameraModule.createCamera();
	check('the stand-off is the Sun’s at solar magnitude',
		cam.standOffFromMag(cameraModule.SOLAR_ABS_MAG) === cameraModule.FLY_TO_STAND_OFF,
		cam.standOffFromMag(cameraModule.SOLAR_ABS_MAG));
	check('a supergiant stands off at the 10 pc ceiling',
		cam.standOffFromMag(-8) === cameraModule.FLY_TO_STAND_OFF_MAX, cam.standOffFromMag(-8));
	check('a faint dwarf clamps to the 0.1 pc orbit floor',
		cam.standOffFromMag(15) === cameraModule.ORBIT_DISTANCE_MIN, cam.standOffFromMag(15));
	check('a non-finite magnitude falls back to the solar stand-off',
		cam.standOffFromMag(NaN) === cameraModule.FLY_TO_STAND_OFF, cam.standOffFromMag(NaN));

	const target = [2.5, -1.25, 0.4];
	const used = cam.flyToStar(target[0], target[1], target[2], cameraModule.SOLAR_ABS_MAG,
		{ name: 'S1Z141Z3' });
	const state = cam.getState();
	const dist = Math.hypot(state.position[0] - target[0], state.position[1] - target[1],
		state.position[2] - target[2]);
	const aim = cam.forward[0] * (target[0] - state.position[0])
		+ cam.forward[1] * (target[1] - state.position[1])
		+ cam.forward[2] * (target[2] - state.position[2]);
	check('flyToStar returns the stand-off used and orbits the target from it',
		used === cameraModule.FLY_TO_STAND_OFF && dist > 0
		&& Math.abs(dist - used) < 1e-9 * Math.max(1, dist)
		&& state.mode === cameraModule.MODE_ORBIT_OBJECT
		&& state.modeName === 'orbit object' && state.targetName === 'S1Z141Z3',
		{ used, dist, mode: state.modeName, name: state.targetName });
	check('the camera ends up aimed at the target', Math.abs(aim - dist) < 1e-6 * Math.max(1, dist), aim / dist);

	const override = cam.flyToStar(target[0], target[1], target[2], -8, { standOffKpc: 0.02 });
	check('an explicit stand-off overrides the brightness-derived one',
		override === 0.02 && Math.abs(cam.getState().orbitDistance - 0.02) < 1e-15, override);
	const clamped = cam.flyToStar(target[0], target[1], target[2], -8, { standOffKpc: 500 });
	check('an out-of-range stand-off clamps to ORBIT_DISTANCE_MAX, like every orbit distance',
		clamped === cameraModule.ORBIT_DISTANCE_MAX, clamped);

	// Already orbiting: flying to a nearby star is a dolly, not a spin, and the
	// viewer can still C back to fly.
	const before = cam.forward.slice();
	const nearby = cam.flyToStar(target[0] + 0.1, target[1] - 0.2, target[2], -8);
	const after = cam.forward.slice();
	const turn = Math.acos(Math.max(-1, Math.min(1,
		before[0] * after[0] + before[1] * after[1] + before[2] * after[2]))) * 180 / Math.PI;
	check('flying while already in orbit object turns by a small angle (a dolly, not a spin)',
		Number.isFinite(turn) && turn < 5 && nearby === cameraModule.FLY_TO_STAND_OFF_MAX,
		{ turn, nearby });
	cam.setMode(cameraModule.MODE_FLY);
	check('after fly-to the viewer can still switch back to fly',
		cam.getState().mode === cameraModule.MODE_FLY);
}

// --- 10. Cost budgets at 300k ----------------------------------------------
const timings = {};
{
	const cam = cameraModule.createCamera();
	const c = model.centre;
	aimAt(cam, c.x, c.y, c.z);
	const sel = selectionModule.createSelection(cam, landmarks);
	const t0 = Date.now();
	const fixture = buildFixture(TIMING_PROCEDURAL, false);
	timings.fixtureBuildMs = Date.now() - t0;
	sel.setRecordBlocks(() => fixture.stub);

	// Select around at capacity: the scan must return the 256 nearest of a
	// 300k-record field, in ascending distance order.
	const focus = fixture.stars[0];
	const radiusKpc = 3;
	const scan = sel.selectAround(focus.x, focus.y, focus.z, radiusKpc);
	const brute = [];
	const f32 = fixture.stub.float32, u32 = fixture.stub.uint32;
	for (let i = 0; i < TIMING_PROCEDURAL; i++) {
		const w = i * 4;
		if ((u32[w + 3] & VISIBLE_BIT) === 0) continue;
		const dx = f32[w] - focus.x, dy = f32[w + 1] - focus.y, dz = f32[w + 2] - focus.z;
		const d2 = dx * dx + dy * dy + dz * dz;
		if (d2 <= radiusKpc * radiusKpc) brute.push({ d2, key: fixture.stub.identity[i] });
	}
	brute.sort((a, b) => a.d2 - b.d2);
	const want256 = brute.slice(0, starSetModule.STAR_SET_CAPACITY);
	let truncOk = scan.count === want256.length && scan.keys.length === starSetModule.STAR_SET_CAPACITY;
	let ascending = true;
	for (let i = 1; i < scan.count; i++) if (scan.dists[i] < scan.dists[i - 1]) ascending = false;
	for (let i = 0; i < want256.length && truncOk; i++) {
		if (scan.keys[i] !== want256[i].key || scan.dists[i] !== want256[i].d2) truncOk = false;
	}
	check('at 300k the radius scan truncates at the set capacity to the nearest stars',
		truncOk && ascending && scan.count === 256 && brute.length > 256,
		{ count: scan.count, inside: brute.length, truncOk, ascending });

	function medianMs(fn, iterations) {
		const times = [];
		for (let i = 0; i < iterations; i++) {
			const s = process.hrtime.bigint();
			fn();
			times.push(Number(process.hrtime.bigint() - s) / 1e6);
		}
		times.sort((a, b) => a - b);
		return { median: times[times.length >> 1], p90: times[Math.floor(times.length * 0.9)], max: times[times.length - 1] };
	}

	const timingHit = newHit();
	// The shipped default: a frozen sky projects the stored bytes directly.
	sel.setOrbitState(model, 0);
	for (let i = 0; i < 5; i++) sel.pickAny(W / 2, H / 2, W, H, timingHit);
	const frozen = medianMs(() => { sel.pickAny(W / 2, H / 2, W, H, timingHit); }, 41);
	timings.pickFrozenMs = frozen;

	// A moving sky dispatches every record: one orbitPosition per star.
	const savedEngine = orbit.getEngine();
	orbit.setEngine(orbit.ENGINE_CLASSIC);
	sel.setOrbitState(model, T);
	for (let i = 0; i < 3; i++) sel.pickAny(W / 2, H / 2, W, H, timingHit);
	const dispatched = medianMs(() => { sel.pickAny(W / 2, H / 2, W, H, timingHit); }, 21);
	const movedHit = sel.pickAny(W / 2, H / 2, W, H, timingHit);
	const hitW = movedHit.index * 4;
	const hitMoved = Math.hypot(movedHit.x - f32[hitW], movedHit.y - f32[hitW + 1], movedHit.z - f32[hitW + 2]);
	orbit.setEngine(savedEngine);
	sel.setOrbitState(model, 0);
	timings.pickDispatchedMs = dispatched;
	timings.dispatchedHitMovedKpc = hitMoved;

	timings.radiusScanMs = medianMs(() => { sel.selectAround(focus.x, focus.y, focus.z, radiusKpc); }, 41);
	// The scan's cost is a number of matches, not a radius: from the default
	// 50 ly neighbourhood to the slider's 100 000 ly top end, one measurement
	// per decade. This is what keeps the budget honest at every radius.
	const LY = 1 / 3261.5637769;
	const byRadius = [];
	for (const ly of [50, 500, 5000, 50000, 100000]) {
		const r = sel.selectAround(focus.x, focus.y, focus.z, ly * LY);
		byRadius.push({
			radiusLy: ly,
			matches: r.count,
			ms: medianMs(() => { sel.selectAround(focus.x, focus.y, focus.z, ly * LY); }, 21).median,
		});
	}
	timings.radiusByRadius = byRadius;
	timings.records = TIMING_PROCEDURAL;
	timings.budgets = { pickMs: PICK_BUDGET_MS, radiusMs: RADIUS_BUDGET_MS };

	check(`pickAny at T = 0 walks ${TIMING_PROCEDURAL} records inside the ${PICK_BUDGET_MS} ms budget`,
		frozen.median < PICK_BUDGET_MS, frozen);
	check(`selectAround at ${TIMING_PROCEDURAL} records inside the ${RADIUS_BUDGET_MS} ms budget`,
		timings.radiusScanMs.median < RADIUS_BUDGET_MS, timings.radiusScanMs);
	check('the dispatched walk is the slow path and really moves the star it reports',
		dispatched.median > frozen.median * 2 && hitMoved > 0.05, { dispatched, frozen, hitMoved });
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
fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.writeFileSync(logPath, JSON.stringify({
	date: new Date().toISOString(),
	model: { type: 'SBb', seed: SEED },
	timeMyr: T,
	timings,
	totalChecks: checks.length,
	passed,
	failed,
	checks,
}, null, 2));
console.log(`Wrote ${logPath}`);
console.log('\n=== VERDICT ===');
console.log(failed === 0 ? 'PASS — star selection behaves as the 0.5.0 plan pins it' : `FAIL — ${failed} checks failed`);
process.exit(failed === 0 ? 0 : 1);
