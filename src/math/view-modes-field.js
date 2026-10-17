// src/math/view-modes-field.js
// View modes (view-modes-plan.md): the star field as a smooth
// heightmap on the view sphere. Pure CPU half — source selection,
// per-star scalars, normalization and the GPU uniform packing.
// No DOM, no GPU, no allocations after setup; Node-testable.
//
// Two modes:
//   camera distance — the height at a direction is the
//     camera-to-star distance of the stars in that direction
//     (closest = 1, farthest = 0 after normalization).
//   adjacency — per star, the mean over its k angular-nearest
//     neighbours of (3D separation / transverse separation): the
//     hidden depth a 2D shortcut would fly through. Visually
//     close but radially stacked pairs push ridges.
//
// Two sources:
//   0 = the constellation landmarks (the named stars the main
//       project already draws; generated galaxies have none, so
//       the source falls back to the nearest FALLBACK_COUNT).
//   1..MAX_STARS = the nearest N stars by DRAWN position, found
//       by a chunked sweep over the renderer's five record blocks
//       (the picker's pattern, selection.js).
//
// Positions come from the shared engine dispatch
// (orbit.engineRecordPosition / engineLandmarkPosition), so the
// field tracks the star clock exactly as the sprites do — and
// inherits the same simple-engine approximation the picker
// reports (classic law on the CPU, exact azimuths on the GPU).

'use strict';

const deps = (typeof module !== 'undefined' && module.exports)
	? { records: require('./star-record.js') }
	: { records: window.StarRecord };

// The GPU uniform holds at most this many stars (8 KB at vec4f).
const MAX_STARS = 500;
// Source slider 0 = constellations. A generated galaxy has no
// landmark table; the source then reads the nearest 48 stars so
// the mode never shows an empty sky.
const FALLBACK_CONSTELLATION_COUNT = 48;
// Adjacency neighbours (plan §Design): k angular-nearest, the
// draft's "adjacent stars" made exact.
const ADJACENCY_NEIGHBOURS = 6;
// The depth ratio is clamped before normalization: coincident
// directions give ratios that would pin the whole map to 1.
const RATIO_CLAMP = 1e4;
// The IDW kernel's truncation radius, in σ multiples — mirrored
// by the WGSL view-field part (the wgsl-validate constant check
// pins the two together).
const KERNEL_CUTOFF = 3.0;
const KERNEL_CUTOFF2 = KERNEL_CUTOFF * KERNEL_CUTOFF;
// A degenerate range (every scalar equal) pins the map at mid
// height instead of dividing by zero.
const DEGENERATE_RANGE_EPS = 1e-12;

// Block kinds, the renderer's BLOCK_LAYOUT order (search.js reads
// the same five through starBlocks()).
const BLOCK_FIELD = 0, BLOCK_LANDMARK = 1, BLOCK_OBJECT = 2,
	BLOCK_LOCAL = 3, BLOCK_CATALOG = 4;

// One preallocated scratch per field state; every entry point
// writes into caller-owned storage.
function createFieldState() {
	return {
		// The active set: (kind, index) pairs, drawn positions in
		// kpc, camera-relative unit directions, raw scalars and
		// the normalized 0..1 values the GPU reads.
		count: 0,
		source: 0,
		kinds: new Uint8Array(MAX_STARS),
		indices: new Int32Array(MAX_STARS),
		positions: new Float64Array(MAX_STARS * 3),
		directions: new Float32Array(MAX_STARS * 3),
		scalars: new Float32Array(MAX_STARS),
		values: new Float32Array(MAX_STARS),
		// The refresh's own min/max (kpc for mode 1, ratio for
		// mode 2) — the readout reports them.
		rangeMin: 0,
		rangeMax: 1,
		// The GPU star array (vec4f per star), packed by
		// packStarUniform and uploaded by the renderer.
		starUniform: new Float32Array(MAX_STARS * 4),
		// Nearest-N sweep: the bounded best-N heap. `heapDist2`
		// is a max-heap so the worst candidate sits at [0]; an
		// offer that beats it displaces the root and sifts down.
		sweepTarget: 0,
		sweepDone: true,
		heapSize: 0,
		heapDist2: new Float64Array(MAX_STARS),
		heapKinds: new Uint8Array(MAX_STARS),
		heapIndices: new Int32Array(MAX_STARS),
		// Sweep cursors: which block and slot the chunked walk is
		// on, so a sweep pauses and resumes across frames.
		sweepBlock: 0,
		sweepSlot: 0,
		// Adjacency scratch: the k angular-nearest neighbours
		// per star (largest dot products, rewritten every
		// refresh) and their ratios.
		adjBestDot: new Float32Array(MAX_STARS * ADJACENCY_NEIGHBOURS),
		adjBestIdx: new Int32Array(MAX_STARS * ADJACENCY_NEIGHBOURS),
		// Star-to-camera distances, shared by the adjacency math.
		camDist: new Float64Array(MAX_STARS),
	};
}

// --- Source selection --------------------------------------------------

// Constellation anchors: the landmark table's drawn positions at
// `time`. Returns the count written (the table size). Generated
// galaxies report 0 — the caller falls back to nearest-N.
function fillConstellationAnchors(state, landmarks, orbit, time, model) {
	const count = landmarks ? landmarks.count : 0;
	const n = Math.min(count, MAX_STARS);
	if (n === 0) { state.count = 0; return 0; }
	const pos = landmarks.positions;
	for (let i = 0; i < n; i++) {
		orbit.engineLandmarkPosition(
			scratch3, i, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2],
			landmarks.ENTRIES[i].colorIndex, time, model);
		state.positions[i * 3] = scratch3[0];
		state.positions[i * 3 + 1] = scratch3[1];
		state.positions[i * 3 + 2] = scratch3[2];
		state.kinds[i] = BLOCK_LANDMARK;
		state.indices[i] = i;
	}
	state.count = n;
	return n;
}

// The nearest-N sweep. beginSweep arms it for `target` stars;
// stepSweep walks one chunk of records through the renderer's
// blocks and returns false while walking.
function beginSweep(state, target) {
	state.sweepTarget = Math.max(1, Math.min(target, MAX_STARS));
	state.heapSize = 0;
	state.sweepBlock = 0;
	state.sweepSlot = 0;
	state.sweepDone = false;
}

// Insert a candidate into the bounded max-heap: it displaces the
// worst entry (the root) and sifts down so [0] is again largest.
// While the heap is not full the candidate appends and sifts up.
function heapOffer(state, dist2, kind, index) {
	const cap = state.sweepTarget;
	const size = state.heapSize;
	if (size < cap) {
		let i = size;
		state.heapSize = size + 1;
		while (i > 0) {
			const parent = (i - 1) >> 1;
			if (state.heapDist2[parent] >= dist2) break;
			state.heapDist2[i] = state.heapDist2[parent];
			state.heapKinds[i] = state.heapKinds[parent];
			state.heapIndices[i] = state.heapIndices[parent];
			i = parent;
		}
		state.heapDist2[i] = dist2;
		state.heapKinds[i] = kind;
		state.heapIndices[i] = index;
		return;
	}
	if (dist2 >= state.heapDist2[0]) return;
	// Sift the hole down, children against the INCOMING
	// value — comparing against the stale root content
	// would stop the descent immediately and leave a
	// larger child above the inserted one.
	let i = 0;
	for (;;) {
		const left = 2 * i + 1, right = left + 1;
		let biggest = -1;
		let best = dist2;
		if (left < cap && state.heapDist2[left] > best) {
			biggest = left; best = state.heapDist2[left];
		}
		if (right < cap && state.heapDist2[right] > best) {
			biggest = right; best = state.heapDist2[right];
		}
		if (biggest < 0) break;
		state.heapDist2[i] = best;
		state.heapKinds[i] = state.heapKinds[biggest];
		state.heapIndices[i] = state.heapIndices[biggest];
		i = biggest;
	}
	state.heapDist2[i] = dist2;
	state.heapKinds[i] = kind;
	state.heapIndices[i] = index;
}

// Walk up to maxRecords records (or maxMs of wall time) of the
// nearest-N sweep. The walk mirrors search.js's galaxy scan:
// every block, every visible record, drawn position through the
// engine dispatch, distance² against the camera. Returns true
// when the sweep is complete (the heap is then committed into
// the active set).
function stepSweep(state, env, maxRecords, maxMs) {
	const info = env.blocks;
	if (!info || !info.view || !info.blocks) { state.sweepDone = true; return true; }
	const view = info.view;
	const blocks = info.blocks;
	const recordBytes = deps.records.RECORD_BYTES;
	const visibleBit = deps.records.FLAG_VISIBLE << 16;
	const cx = env.camX, cy = env.camY, cz = env.camZ;
	const start = nowMs();
	let scanned = 0;
	while (state.sweepBlock < blocks.length) {
		const block = blocks[state.sweepBlock];
		const base = block.offset | 0;
		const count = block.count | 0;
		// `slot` is block-local (the picker's convention);
		// the byte offset adds the block's base.
		let slot = state.sweepSlot;
		while (slot < count) {
			const byteOffset = (base + slot) * recordBytes;
			const packed = view.getUint32(byteOffset + 12, true);
			scanned++;
			if ((packed & visibleBit) !== 0) {
				const x = view.getFloat32(byteOffset, true);
				const y = view.getFloat32(byteOffset + 4, true);
				const z = view.getFloat32(byteOffset + 8, true);
				resolveDrawnPosition(env, state.sweepBlock, slot,
					x, y, z, packed, scratch3);
				const dx = scratch3[0] - cx;
				const dy = scratch3[1] - cy;
				const dz = scratch3[2] - cz;
				heapOffer(state, dx * dx + dy * dy + dz * dz,
					state.sweepBlock, slot);
			}
			state.sweepSlot = slot + 1;
			slot++;
			// Both slice limits are checked per record: a
			// block can be the whole galaxy, so the record
			// cap must not wait for a block boundary.
			if (scanned >= maxRecords) return false;
			if ((scanned & 1023) === 0 && maxMs > 0 && nowMs() - start > maxMs) return false;
		}
		state.sweepBlock++;
		state.sweepSlot = 0;
	}
	// The walk is over: commit the heap into the active set.
	const n = state.heapSize;
	for (let i = 0; i < n; i++) {
		state.kinds[i] = state.heapKinds[i];
		state.indices[i] = state.heapIndices[i];
	}
	state.count = n;
	state.sweepDone = true;
	return true;
}

// The drawn position of one record, through the shared dispatch
// (the picker's resolveDrawnPosition, same convention: the simple
// engine's exact azimuths live on the GPU, so the CPU reports the
// classic law and flags the approximation).
function resolveDrawnPosition(env, kind, index, x, y, z, packed, out) {
	const orbit = env.orbit;
	if (kind === BLOCK_LANDMARK && orbit.engineLandmarkPosition) {
		orbit.engineLandmarkPosition(out, index, x, y, z,
			packed & 0xFF, env.time, env.model);
		return false;
	}
	if (!orbit.engineRecordPosition || kind < 0) {
		out[0] = x; out[1] = y; out[2] = z;
		return kind < 0;
	}
	return orbit.engineRecordPosition(out, x, y, z, packed, env.time, env.model) === true;
}

// --- Per-frame position refresh ----------------------------------------

// Re-evaluate the active set's drawn positions at the current star
// time. Called every frame while a mode is active; membership is
// the sweep's business, positions are this one's.
function refreshPositions(state, env) {
	const info = env.blocks;
	const view = info.view;
	const blocks = info.blocks;
	const recordBytes = deps.records.RECORD_BYTES;
	for (let i = 0; i < state.count; i++) {
		const kind = state.kinds[i];
		const byteOffset = ((blocks[kind].offset | 0) + state.indices[i]) * recordBytes;
		const packed = view.getUint32(byteOffset + 12, true);
		resolveDrawnPosition(env, kind, state.indices[i],
			view.getFloat32(byteOffset, true),
			view.getFloat32(byteOffset + 4, true),
			view.getFloat32(byteOffset + 8, true),
			packed, scratch3);
		state.positions[i * 3] = scratch3[0];
		state.positions[i * 3 + 1] = scratch3[1];
		state.positions[i * 3 + 2] = scratch3[2];
	}
}

// --- Scalars -----------------------------------------------------------

// Mode 1: the camera distance of every star, raw kpc.
function computeDistanceScalars(state, camX, camY, camZ) {
	let lo = Infinity, hi = -Infinity;
	for (let i = 0; i < state.count; i++) {
		const dx = state.positions[i * 3] - camX;
		const dy = state.positions[i * 3 + 1] - camY;
		const dz = state.positions[i * 3 + 2] - camZ;
		const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
		state.scalars[i] = d;
		state.camDist[i] = d;
		if (d < lo) lo = d;
		if (d > hi) hi = d;
	}
	return finalizeRange(state, lo, hi);
}

// Mode 2: the adjacency depth ratio of every star. Directions are
// camera-relative; the k angular-nearest neighbours are found by
// a full pairwise scan (N ≤ 500, once per refresh — the plan's
// O(N²) at a fraction of a millisecond).
function computeAdjacencyScalars(state, camX, camY, camZ) {
	const n = state.count;
	// Unit directions from the camera and the distances the ratio
	// denominators need, shared by every pair.
	for (let i = 0; i < n; i++) {
		const dx = state.positions[i * 3] - camX;
		const dy = state.positions[i * 3 + 1] - camY;
		const dz = state.positions[i * 3 + 2] - camZ;
		const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
		const inv = 1 / Math.max(d, 1e-12);
		state.directions[i * 3] = dx * inv;
		state.directions[i * 3 + 1] = dy * inv;
		state.directions[i * 3 + 2] = dz * inv;
		state.camDist[i] = d;
	}
	let lo = Infinity, hi = -Infinity;
	for (let i = 0; i < n; i++) {
		// The k angular-nearest neighbours (largest dots),
		// then the mean of their depth ratios. Two stars
		// at the same depth give a ratio near 1; a visually
		// close but radially stacked pair gives a large
		// one — the ridge a 2D pathfinding map must not
		// cross cheaply. The neighbour choice is by angle
		// alone: a ratio could never find the neighbours
		// it is computed over.
		const kDot = state.adjBestDot;
		const kIdx = state.adjBestIdx;
		const base = i * ADJACENCY_NEIGHBOURS;
		let kFilled = 0;
		const ix = state.directions[i * 3], iy = state.directions[i * 3 + 1],
			iz = state.directions[i * 3 + 2];
		for (let j = 0; j < n; j++) {
			if (j === i) continue;
			const dot = ix * state.directions[j * 3]
				+ iy * state.directions[j * 3 + 1]
				+ iz * state.directions[j * 3 + 2];
			if (kFilled < ADJACENCY_NEIGHBOURS) {
				kDot[base + kFilled] = dot;
				kIdx[base + kFilled] = j;
				kFilled++;
				continue;
			}
			// The k-best list is unsorted; a larger dot
			// replaces the current smallest.
			let worst = 0;
			for (let q = 1; q < ADJACENCY_NEIGHBOURS; q++) {
				if (kDot[base + q] < kDot[base + worst]) worst = q;
			}
			if (dot > kDot[base + worst]) {
				kDot[base + worst] = dot;
				kIdx[base + worst] = j;
			}
		}
		const pxi = state.positions[i * 3], pyi = state.positions[i * 3 + 1],
			pzi = state.positions[i * 3 + 2];
		let sum = 0;
		for (let j = 0; j < kFilled; j++) {
			const nb = kIdx[base + j];
			const dot = kDot[base + j];
			// The angular separation without acos: the
			// ratio only needs the small-angle form
			// θ ≈ √(2(1−cosθ)) — the chord, which is
			// what the transverse gap means at these
			// angles anyway.
			const theta = Math.sqrt(Math.max(2 * (1 - dot), 1e-12));
			const dx = state.positions[nb * 3] - pxi;
			const dy = state.positions[nb * 3 + 1] - pyi;
			const dz = state.positions[nb * 3 + 2] - pzi;
			const dist3d = Math.sqrt(dx * dx + dy * dy + dz * dz);
			const meanD = 0.5 * (state.camDist[i] + state.camDist[nb]);
			sum += Math.min(dist3d / Math.max(theta * meanD, 1e-9), RATIO_CLAMP);
		}
		const scalar = kFilled > 0 ? sum / kFilled : 1;
		state.scalars[i] = scalar;
		if (scalar < lo) lo = scalar;
		if (scalar > hi) hi = scalar;
	}
	return finalizeRange(state, lo, hi);
}

// Normalize the raw scalars into state.values (0..1, degenerate
// sets pin at 0.5) and record the range for the readout.
function finalizeRange(state, lo, hi) {
	if (!Number.isFinite(lo) || !Number.isFinite(hi) || state.count === 0) {
		state.rangeMin = 0; state.rangeMax = 1;
		return { min: 0, max: 1 };
	}
	state.rangeMin = lo;
	state.rangeMax = hi;
	const span = hi - lo;
	const invSpan = span > DEGENERATE_RANGE_EPS ? 1 / span : 0;
	for (let i = 0; i < state.count; i++) {
		// The clamp absorbs the f32 round trip: a value
		// stored at an end of the range must land on the
		// end, not one ulp outside it.
		let t = invSpan > 0 ? (state.scalars[i] - lo) * invSpan : 0.5;
		if (t < 0) t = 0;
		else if (t > 1) t = 1;
		state.values[i] = t;
	}
	return { min: lo, max: hi };
}

// --- Uniform packing ----------------------------------------------------

// Pack the GPU star array: vec4f per star — camera-relative unit
// direction (galaxy frame) and the normalized value. Returns the
// Float32Array the renderer uploads (owned by the state, reused).
function packStarUniform(state, camX, camY, camZ) {
	const out = state.starUniform;
	for (let i = 0; i < state.count; i++) {
		const dx = state.positions[i * 3] - camX;
		const dy = state.positions[i * 3 + 1] - camY;
		const dz = state.positions[i * 3 + 2] - camZ;
		const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
		// A star the camera sits on has no direction. Leave
		// it at zero: the kernel then reads dot = 0, a small
		// uniform weight — the honest answer, since the star
		// is "at distance 0" in every direction at once.
		const inv = len > 1e-9 ? 1 / len : 0;
		out[i * 4] = dx * inv;
		out[i * 4 + 1] = dy * inv;
		out[i * 4 + 2] = dz * inv;
		out[i * 4 + 3] = state.values[i];
	}
	return out;
}

// The mean angular separation of N points on a sphere: the σ the
// kernel auto-width derives from (spacing × multiplier).
function kernelSigma(starCount, multiplier) {
	const n = Math.max(1, starCount);
	return Math.sqrt(4 * Math.PI / n) * multiplier;
}

// The IDW kernel's JS twin — the WGSL view-field part carries
// the GPU form and wgsl-validate diffs the two. The weight of
// a star at angular separation θ (supplied as cosθ): a
// Lorentzian in θ², truncated at KERNEL_CUTOFF σ.
function kernelWeight(cosTheta, sigma) {
	const gap2 = 2 * (1 - cosTheta);
	if (gap2 > KERNEL_CUTOFF2 * sigma * sigma) return 0;
	const s2 = sigma * sigma;
	return s2 / (s2 + gap2);
}

function nowMs() {
	return (typeof performance !== 'undefined' && performance.now)
		? performance.now() : Date.now();
}

const scratch3 = new Float64Array(3);

const ViewModesField = {
	createFieldState,
	fillConstellationAnchors,
	beginSweep, stepSweep, heapOffer,
	refreshPositions,
	computeDistanceScalars, computeAdjacencyScalars,
	finalizeRange, packStarUniform, kernelSigma, kernelWeight,
	MODE_OFF: 0, MODE_CAMERA_DISTANCE: 1, MODE_ADJACENCY: 2,
	SOURCE_CONSTELLATIONS: 0,
	MAX_STARS, FALLBACK_CONSTELLATION_COUNT, ADJACENCY_NEIGHBOURS,
	RATIO_CLAMP, KERNEL_CUTOFF, KERNEL_CUTOFF2,
	BLOCK_FIELD, BLOCK_LANDMARK, BLOCK_OBJECT, BLOCK_LOCAL, BLOCK_CATALOG,
};
if (typeof module !== 'undefined') module.exports = ViewModesField;
if (typeof window !== 'undefined') window.ViewModesField = ViewModesField;
