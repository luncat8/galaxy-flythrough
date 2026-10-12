// src/core/selection.js
// Click picking, two entry points:
//
//   * `pick` (landmarks only) — projects the landmark table with the camera's
//     viewProj and returns the nearest index within PICK_RADIUS_PX of the
//     pointer. The caller feeds the hit to camera.setOrbitTarget — selection
//     never mutates the camera itself, so a miss is a pure no-op.
//   * `pickAny` (plan §3.1, 0.5.0) — walks every resident record in the
//     renderer's five blocks, dispatches each through the shared orbit mask
//     (the same calls the vertex stage makes: `engineRecordPosition` for a
//     record, `engineLandmarkPosition` for a landmark),
//     projects the drawn position, and returns the nearest hit within
//     PICK_RADIUS_PX. Inside PICK_TIE_PX the brighter star wins, so a click on
//     a pair takes the bright one in front rather than the faint one it hides.
//
// `pickAny` needs the buffers, which do not exist when the selection object is
// constructed, so `setRenderer(renderer)` is called by main.js after prepare().
// The walk allocates nothing: the caller passes the `out` record (plan §3.1)
// and it is filled in place.

'use strict';

const PICK_RADIUS_PX = 20;
const PICK_TIE_PX = 3;
// Select-around radius (plan §3.3): world-space light-years, log slider. The
// slider is log10(ly) so the readout and a preset field are exact decimals; the
// bounds and the default live here because this module owns the radius' meaning
// (`index.html`'s slider and `presets.js`'s default both read them).
const SELRAD_MIN_LY = 0.1;
const SELRAD_MAX_LY = 100000;
const SELRAD_DEFAULT_LY = 50;
// The slider value is log10(ly), and its default is the exact decimal 1.69897
// rather than Math.log10(50): the preset field round-trips only if the default
// is the number the slider actually holds (5 significant digits, as the rest of
// the settings line uses).
const SELRAD_DEFAULT_LOG = 1.69897;
// The scan's own bound: one full set (plan §3.2) is the largest useful answer, so
// the scan never collects more than it can hand over, and its SoA is fixed.
const AROUND_CAPACITY = 256;

const selectionCoords = (typeof module !== 'undefined' && module.exports)
	? require('../math/coords.js')
	: window.Coords;
// Live lookup (like label-layer.js): the orbit module loads before selection
// on the page, but tests load orderings vary. Without an orbit module there is
// no movement to dispatch, so the fallback is the identity.
const selectionOrbitFallback = {
	engineLandmarkPosition: (out, i, bx, by, bz) => { out[0] = bx; out[1] = by; out[2] = bz; return out; },
	engineRecordPosition: (out, bx, by, bz) => { out[0] = bx; out[1] = by; out[2] = bz; return false; },
};
function selectionOrbit() {
	return (typeof window !== 'undefined' && window.OrbitLib) || selectionOrbitFallback;
}

// Live lookups, same pattern as the orbit module above: tests load orderings
// vary, and a page that forgot the script tag should degrade to "no hit"
// rather than throw on the first click.
function selectionRecords() {
	return (typeof window !== 'undefined' && window.StarRecord) || null;
}

function createSelection(camera, landmarks) {
	const scratch = new Float32Array(3);
	const orbitScratch = new Float64Array(3);
	let orbitModel = null, orbitTime = 0;
	let renderer = null;
	function setOrbitState(model, time) { orbitModel = model; orbitTime = time || 0; }
	function setRenderer(next) { renderer = next; }

	function pick(x, y, width, height) {
		if (!landmarks || landmarks.count === 0 || !(width > 0) || !(height > 0)) return -1;
		const viewProj = camera.buildViewProj(width / height);
		const pos = landmarks.positions;
		const cam = camera.cameraPos;
		let best = -1;
		let bestD2 = PICK_RADIUS_PX * PICK_RADIUS_PX;
		for (let i = 0; i < landmarks.count; i++) {
			let px = pos[i * 3], py = pos[i * 3 + 1], pz = pos[i * 3 + 2];
			if (orbitModel) {
				// The shared mask dispatch — the click target is what the GPU
				// draws, for every engine mask (labels use the same call).
				selectionOrbit().engineLandmarkPosition(orbitScratch, i, px, py, pz,
					landmarks.ENTRIES[i].colorIndex, orbitTime, orbitModel);
				px = orbitScratch[0]; py = orbitScratch[1]; pz = orbitScratch[2];
			}
			if (!selectionCoords.projectToScreen(viewProj, px, py, pz,
				cam[0], cam[1], cam[2], width, height, scratch)) continue;
			const dx = scratch[0] - x;
			const dy = scratch[1] - y;
			const d2 = dx * dx + dy * dy;
			if (d2 <= bestD2) {
				bestD2 = d2;
				best = i;
			}
		}
		return best;
	}

	// Plan §3.3, "select around": one pass over the resident records, keeping
	// everything inside `radiusKpc` of the primary's snapshot position, sorted by
	// distance ascending (insertion sort into the preallocated arrays — the count
	// is bounded by `AROUND_CAPACITY`) and truncated at `maxCount`. The result is
	// written into this object's own SoA (never allocated) and returned as a
	// count; the caller reads `around.keys[i]` … `around.dist2[i]`.
	//
	// Distances are the record's own (birth) positions, the same field a snapshot
	// stores, so the primary and a scan hit are compared in one frame of
	// reference. A record that is not visible is not part of the sky and is
	// skipped, exactly as in pickAny.
	const around = {
		keys: new Uint32Array(AROUND_CAPACITY),
		kind: new Uint8Array(AROUND_CAPACITY),
		index: new Uint32Array(AROUND_CAPACITY),
		x: new Float64Array(AROUND_CAPACITY),
		y: new Float64Array(AROUND_CAPACITY),
		z: new Float64Array(AROUND_CAPACITY),
		packed: new Uint32Array(AROUND_CAPACITY),
		colorIndex: new Uint8Array(AROUND_CAPACITY),
		absMag: new Float32Array(AROUND_CAPACITY),
		approximated: new Uint8Array(AROUND_CAPACITY),
		dist2: new Float64Array(AROUND_CAPACITY),
		count: 0,
		truncated: 0,
	};
	function selectAround(px, py, pz, radiusKpc, maxCount) {
		around.count = 0;
		around.truncated = 0;
		if (!renderer || !(radiusKpc > 0)) return 0;
		const records = selectionRecords();
		const info = renderer.starBlocks();
		if (!records || !info || !info.view || !info.identity) return 0;
		const cap = Math.min(AROUND_CAPACITY, Math.max(0, maxCount | 0));
		if (cap === 0) return 0;
		const view = info.view;
		const identity = info.identity;
		const blocks = info.blocks;
		const r2 = radiusKpc * radiusKpc;
		let n = 0;
		for (let k = 0; k < blocks.length; k++) {
			const block = blocks[k];
			const count = block.count | 0;
			if (count <= 0) continue;
			const end = (block.offset | 0) + count;
			for (let slot = block.offset | 0; slot < end; slot++) {
				const byteOffset = slot * records.RECORD_BYTES;
				const packed = view.getUint32(byteOffset + 12, true);
				if ((packed & (records.FLAG_VISIBLE << 16)) === 0) continue;
				const x = view.getFloat32(byteOffset, true);
				const y = view.getFloat32(byteOffset + 4, true);
				const z = view.getFloat32(byteOffset + 8, true);
				const dx = x - px;
				const dy = y - py;
				const dz = z - pz;
				const d2 = dx * dx + dy * dy + dz * dz;
				if (d2 > r2) continue;
				// Insertion sort, descending scan: the list is ascending.
				let i = n;
				while (i > 0 && around.dist2[i - 1] > d2) {
					around.dist2[i] = around.dist2[i - 1];
					around.keys[i] = around.keys[i - 1];
					around.kind[i] = around.kind[i - 1];
					around.index[i] = around.index[i - 1];
					around.x[i] = around.x[i - 1];
					around.y[i] = around.y[i - 1];
					around.z[i] = around.z[i - 1];
					around.packed[i] = around.packed[i - 1];
					around.colorIndex[i] = around.colorIndex[i - 1];
					around.absMag[i] = around.absMag[i - 1];
					around.approximated[i] = around.approximated[i - 1];
					i--;
				}
				if (i >= cap) { around.truncated++; continue; }
				if (n < cap) n++;
				around.dist2[i] = d2;
				around.keys[i] = identity[slot] >>> 0;
				around.kind[i] = k;
				around.index[i] = slot - (block.offset | 0);
				around.x[i] = x;
				around.y[i] = y;
				around.z[i] = z;
				around.packed[i] = packed;
				around.colorIndex[i] = packed & 0xFF;
				around.absMag[i] = records.decodeAbsMag((packed >>> 8) & 0xFF);
				// A radius scan never dispatches, so it never approximates: the
				// flag is about the *pick's* position test, not the star's record.
				around.approximated[i] = 0;
			}
		}
		around.count = n;
		return n;
	}

	// Plan §3.1. `out` is caller-owned and filled in place:
	//   { key, kind, index, x, y, z, packed, colorIndex, absMag, dist2, approximated }
	// `kind` is the block's index, which equals `PlanetsLib.BLOCK_*`
	// (planet-gen-test pins the order); `index` is the slot *inside* that block,
	// so `stellarInputs` can read an object member's member context from
	// `starBlocks().member`. `x/y/z` are the record's own (birth) position — the
	// one the stellar derivation used — not the dispatched screen position the
	// hit test compared. Returns `out` on a hit, null on a miss.
	//
	// The walk is **chunked across frames** because it is dispatch-bound, not
	// projection-bound: `orbit.engineRecordPosition` costs ~0.27 µs per record
	// under the classic mask and ~1.5 µs with the apocenter pass (measured, see
	// experiments/star-select-test.js), so one synchronous pass over 300k records
	// is 80–460 ms — a visible hitch on every click. `beginPick` starts a sweep,
	// `pickStep(maxRecords)` walks a slice and returns true when the sweep is
	// done, and `pickResult()` is the hit (or null). `pickAny` is the same walk in
	// one call, for tests and for callers that already hold a small field.
	//
	// The sweep is exact: it walks every visible record once, in the same order a
	// synchronous pass would, and the tie-break accumulates across steps. Two
	// things are snapshotted at `beginPick` — the camera's viewProj/position and
	// the renderer's `dynamicVersion` — because a click is judged against the
	// frame the user clicked on; a block rebuild during the sweep aborts it and
	// reports no hit rather than a stale key.
	const sweep = {
		active: false, done: true, out: null,
		x: 0, y: 0, width: 0, height: 0,
		k: 0, i: 0,
		bestD: 0, minD: 0, bestMag: 0, best: null,
		version: -1,
	};
	const sweepCam = new Float64Array(3);
	let sweepViewProj = null;

	function beginPick(x, y, width, height, out) {
		sweep.active = false;
		sweep.done = true;
		sweep.out = out || null;
		sweep.best = null;
		sweep.bestD = 0;
		sweep.bestMag = 0;
		sweep.k = 0;
		sweep.i = 0;
		if (!out || !renderer || !(width > 0) || !(height > 0)) return false;
		const records = selectionRecords();
		const info = renderer.starBlocks();
		if (!records || !info || !info.view || !info.identity) return false;
		sweepViewProj = camera.buildViewProj(width / height);
		const cam = camera.cameraPos;
		sweepCam[0] = cam[0]; sweepCam[1] = cam[1]; sweepCam[2] = cam[2];
		sweep.x = x;
		sweep.y = y;
		sweep.width = width;
		sweep.height = height;
		sweep.version = info.dynamicVersion;
		sweep.active = true;
		sweep.done = false;
		return true;
	}

	// Walk a slice of the current sweep: up to `maxRecords` records, and no longer
	// than `maxMs` of wall time (checked every CHECK_INTERVAL records, so the
	// clock call is not itself the cost). Both limits matter: the per-record cost
	// depends on the engine mask by a factor of four (see the header), so a fixed
	// record count would be a 2 ms slice under one mask and a 40 ms hitch under
	// another. Returns true when the sweep is finished (including "finished with
	// no hit"), false to be called again.
	const STEP_CHECK_RECORDS = 2048;
	function pickStep(maxRecords, maxMs) {
		if (!sweep.active) return true;
		const records = selectionRecords();
		const info = renderer.starBlocks();
		// The buffers moved under the sweep: the slots we have not walked yet may
		// have been rewritten, so the answer would mix two frames. Abort.
		if (!records || !info || info.dynamicVersion !== sweep.version) {
			sweep.active = false;
			sweep.done = true;
			sweep.best = null;
			return true;
		}
		const view = info.view;
		const identity = info.identity;
		const blocks = info.blocks;
		const orbit = selectionOrbit();
		const radius2 = PICK_RADIUS_PX * PICK_RADIUS_PX;
		const visibleBit = records.FLAG_VISIBLE << 16;
		const budget = maxRecords === undefined || maxRecords === Infinity ? Infinity : (maxRecords | 0);
		const deadline = (maxMs > 0) ? performance.now() + maxMs : Infinity;
		let steps = 0;
		let sinceCheck = 0;
		while (sweep.k < blocks.length && steps < budget) {
			const block = blocks[sweep.k];
			const count = block.count | 0;
			if (count <= 0 || sweep.i >= count) {
				sweep.k++;
				sweep.i = 0;
				continue;
			}
			const base = block.offset | 0;
			const isLandmark = block.kind === 'landmark';
			while (sweep.i < count && steps < budget) {
				if (++sinceCheck >= STEP_CHECK_RECORDS) {
					sinceCheck = 0;
					// Nothing has been consumed yet this iteration, so stopping
					// here resumes exactly at `sweep.i`.
					if (performance.now() >= deadline) break;
				}
				const i = sweep.i++;
				steps++;
				const slot = base + i;
				const byteOffset = slot * records.RECORD_BYTES;
				const packed = view.getUint32(byteOffset + 12, true);
				if ((packed & visibleBit) === 0) continue;
				const bx = view.getFloat32(byteOffset, true);
				const by = view.getFloat32(byteOffset + 4, true);
				const bz = view.getFloat32(byteOffset + 8, true);
				let px = bx, py = by, pz = bz;
				let approximated = false;
				if (orbitModel) {
					if (isLandmark) {
						orbit.engineLandmarkPosition(orbitScratch, i, px, py, pz,
							packed & 0xFF, orbitTime, orbitModel);
					} else {
						approximated = orbit.engineRecordPosition(orbitScratch,
							px, py, pz, packed, orbitTime, orbitModel) === true;
					}
					px = orbitScratch[0]; py = orbitScratch[1]; pz = orbitScratch[2];
				}
				if (!selectionCoords.projectToScreen(sweepViewProj, px, py, pz,
					sweepCam[0], sweepCam[1], sweepCam[2], sweep.width, sweep.height, scratch)) continue;
				const dx = scratch[0] - sweep.x;
				const dy = scratch[1] - sweep.y;
				const d2 = dx * dx + dy * dy;
				if (d2 > radius2) continue;
				const d = Math.sqrt(d2);
				const mag = records.decodeAbsMag((packed >>> 8) & 0xFF);
				// The rule (plan §3.1): the nearest record wins, and a record
				// inside PICK_TIE_PX of the nearest-so-far wins when it is
				// brighter. The band is anchored on the *nearest* distance, not on
				// the current best: anchoring on the best let a chain of
				// slightly-brighter neighbours walk the pick 4-5 px away from the
				// cursor, which the parity check in star-select-test.js caught.
				if (sweep.best === null) {
					sweep.minD = d;
				} else if (d < sweep.minD) {
					sweep.minD = d;
					// The old best is still a candidate while it is inside the band.
					if (sweep.bestD <= sweep.minD + PICK_TIE_PX && !(mag < sweep.bestMag)) continue;
				} else {
					if (d > sweep.minD + PICK_TIE_PX) continue;
					if (!(mag < sweep.bestMag)) continue;
				}
				const best = sweep.out;
				best.key = identity[slot] >>> 0;
				best.kind = sweep.k;
				best.index = i;
				best.x = bx;
				best.y = by;
				best.z = bz;
				best.packed = packed;
				best.colorIndex = packed & 0xFF;
				best.absMag = mag;
				best.dist2 = d2;
				best.approximated = approximated;
				sweep.best = best;
				sweep.bestD = d;
				sweep.bestMag = mag;
			}
			if (sweep.i >= count) { sweep.k++; sweep.i = 0; }
		}
		if (sweep.k >= blocks.length) {
			sweep.done = true;
			sweep.active = false;
			return true;
		}
		return steps < budget;   // budget exhausted mid-walk
	}

	function pickResult() {
		return sweep.done ? sweep.best : null;
	}

	function pickAny(x, y, width, height, out) {
		if (!beginPick(x, y, width, height, out)) return null;
		while (!pickStep(1 << 24)) { /* one big step is the whole sweep */ }
		return pickResult();
	}

	return {
		pick, pickAny, beginPick, pickStep, pickResult, selectAround, around,
		setOrbitState, setRenderer,
	};
}

const Selection = {
	createSelection, PICK_RADIUS_PX, PICK_TIE_PX, AROUND_CAPACITY,
	SELRAD_MIN_LY, SELRAD_MAX_LY, SELRAD_DEFAULT_LY, SELRAD_DEFAULT_LOG,
};
if (typeof module !== 'undefined') module.exports = Selection;
if (typeof window !== 'undefined') window.Selection = Selection;
