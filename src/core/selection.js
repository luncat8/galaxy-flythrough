// src/core/selection.js
// Click picking: projects the landmarks with the camera's viewProj and
// returns the nearest one within PICK_RADIUS_PX of the pointer. The caller
// feeds the hit to camera.setOrbitTarget — selection never mutates the
// camera itself, so a miss is a pure no-op.
//
// 0.5.0 adds pickAny: the same walk over all five record blocks of the star
// buffer, not just the named table, so a click can hit any drawn star. The
// blocks come from a callback (renderer.starBlocks) rather than a captured
// object, because the staging buffer and the identity array are reallocated on
// every regenerate and rewritten on every residency change.

'use strict';

const PICK_RADIUS_PX = 20;
// Two stars within this many pixels of each other count as the same click
// target; the brighter absolute magnitude then wins, so a faint star behind a
// bright one is never picked over it.
const PICK_TIE_PX = 3;
// Select-around radius (plan §3.3): world-space, in light-years, so a
// neighbourhood means the same thing at every distance. Log10 in the UI.
const SELECT_RADIUS_LY_MIN = 0.1;
const SELECT_RADIUS_LY_MAX = 100000;
const SELECT_RADIUS_LY_DEFAULT = 50;
const SELECT_LOG_MIN = Math.log10(SELECT_RADIUS_LY_MIN);
const SELECT_LOG_SPAN = Math.log10(SELECT_RADIUS_LY_MAX) - SELECT_LOG_MIN;

// The slider is linear 0…100 in t and logarithmic in ly, so both ends of two
// and a half decades stay reachable with one drag.
function radiusFromSlider(value) {
	const t = Math.max(0, Math.min(100, value)) / 100;
	return Math.pow(10, SELECT_LOG_MIN + t * SELECT_LOG_SPAN);
}

function sliderFromRadius(ly) {
	const clamped = Math.max(SELECT_RADIUS_LY_MIN, Math.min(SELECT_RADIUS_LY_MAX, ly));
	return Math.round((Math.log10(clamped) - SELECT_LOG_MIN) / SELECT_LOG_SPAN * 10000) / 100;
}

const selectionCoords = (typeof module !== 'undefined' && module.exports)
	? require('../math/coords.js')
	: window.Coords;

// Does a candidate beat the current best? The nearer one wins outside the tie
// band; inside it the brighter one does, with distance as the tie-break of
// equal magnitudes (absMag bytes: smaller = brighter).
function prefers(d2, mag, bestD2, bestMag, tie2) {
	if (d2 < bestD2 - tie2) return true;
	if (d2 > bestD2 + tie2) return false;
	if (mag !== bestMag) return mag < bestMag;
	return d2 < bestD2;
}
// Live lookup (like label-layer.js): the orbit module loads before selection
// on the page, but tests load orderings vary. Without an orbit module there is
// no movement to dispatch, so the fallback is the identity.
const selectionOrbitFallback = {
	engineLandmarkPosition: (out, i, bx, by, bz) => { out[0] = bx; out[1] = by; out[2] = bz; return out; },
	engineRecordPosition: (out, x, y, z) => { out[0] = x; out[1] = y; out[2] = z; return out; },
};
function selectionOrbit() {
	return (typeof window !== 'undefined' && window.OrbitLib) || selectionOrbitFallback;
}
// The set's capacity bounds how many stars a select-around can collect, so it
// is read from the module that owns it (star-set.js loads after this one).
const selectionSetFallback = { STAR_SET_CAPACITY: 256 };
function selectionSet() {
	return (typeof window !== 'undefined' && window.StarSet) || selectionSetFallback;
}

function createSelection(camera, landmarks) {
	const scratch = new Float32Array(3);
	const orbitScratch = new Float64Array(3);
	let orbitModel = null, orbitTime = 0;
	function setOrbitState(model, time) { orbitModel = model; orbitTime = time || 0; }

	// () => renderer.starBlocks(). Null until the renderer is attached: a
	// selection built before one (Node tests, a Game-mode page) picks nothing.
	let recordBlocks = null;
	function setRecordBlocks(getter) { recordBlocks = typeof getter === 'function' ? getter : null; }

	const pickOut = {
		key: 0,              // u32 identity of the star (§2.2)
		blockKind: '',       // 'procedural' | 'landmark' | 'objects' | 'local' | 'catalog'
		index: -1,           // slot in the star buffer (== the identity index)
		x: 0, y: 0, z: 0,    // dispatched world position, kpc, f64
		packed: 0,           // the record's packed word as stored
		dist2: 0,            // squared screen distance to the pointer
	};

	// The record walk reads the staging bytes through typed arrays, not the
	// DataView: at 300k records the method calls cost more than the projection
	// they feed. The layout is little-endian, so the floats at words 0..2 and
	// the packed word at word 3 are direct element reads.
	const VISIBLE_BIT = 0x10000;          // FLAG_VISIBLE, bit 0 of the flags byte
	function pickAny(x, y, width, height, out) {
		const hit = out || pickOut;
		hit.key = 0;
		hit.blockKind = '';
		hit.index = -1;
		hit.dist2 = 0;
		if (!recordBlocks || !(width > 0) || !(height > 0)) return null;
		const blocks = recordBlocks();
		const identity = blocks.identity;
		const positions = blocks.float32;
		const words = blocks.uint32;
		const table = blocks.blocks;
		if (!identity || !positions || !words || !table) return null;
		const viewProj = camera.buildViewProj(width / height);
		const cam = camera.cameraPos;
		const orbit = selectionOrbit();
		const time = orbitTime;
		// T = 0 is the identity law of every pass (orbit.js pins it), so the
		// walk projects the stored bytes directly instead of dispatching each
		// record — exact, and it is the frozen-sky case the Milky Way arrival
		// preset ships with.
		const dispatch = time !== 0;
		const tie2 = PICK_TIE_PX * PICK_TIE_PX;
		let bestKey = 0, bestKind = '', bestSlot = -1, bestPacked = 0;
		let bestX = 0, bestY = 0, bestZ = 0, bestD2 = Infinity, bestMag = 0;
		for (let b = 0; b < table.length; b++) {
			const block = table[b];
			const base = block.offset;
			const n = block.count;
			for (let i = 0; i < n; i++) {
				const slot = base + i;
				const w = slot * 4;
				const packed = words[w + 3];
				if ((packed & VISIBLE_BIT) === 0) continue;
				let px = positions[w], py = positions[w + 1], pz = positions[w + 2];
				if (dispatch) {
					orbit.engineRecordPosition(orbitScratch, px, py, pz, packed, time, orbitModel);
					px = orbitScratch[0]; py = orbitScratch[1]; pz = orbitScratch[2];
				}
				if (!selectionCoords.projectToScreen(viewProj, px, py, pz,
					cam[0], cam[1], cam[2], width, height, scratch)) continue;
				const dx = scratch[0] - x;
				const dy = scratch[1] - y;
				const d2 = dx * dx + dy * dy;
				const mag = (packed >>> 8) & 255;
				if (bestSlot >= 0 && !prefers(d2, mag, bestD2, bestMag, tie2)) continue;
				bestKey = identity[slot];
				bestKind = block.kind;
				bestSlot = slot;
				bestPacked = packed;
				bestX = px; bestY = py; bestZ = pz;
				bestD2 = d2;
				bestMag = mag;
			}
		}
		if (bestSlot < 0) return null;
		hit.key = bestKey;
		hit.blockKind = bestKind;
		hit.index = bestSlot;
		hit.x = bestX;
		hit.y = bestY;
		hit.z = bestZ;
		hit.packed = bestPacked;
		hit.dist2 = bestD2;
		return hit;
	}

	// Select around a point (plan §3.3): every resident record inside
	// `radiusKpc`, nearest-first, truncated at the set's capacity. The scan
	// reads stored positions and does not dispatch the movement engines —
	// a neighbourhood is a property of the model, not of this instant's
	// rotation, so it is stable while the camera moves.
	const radiusOut = {
		keys: new Uint32Array(selectionSet().STAR_SET_CAPACITY),
		dists: new Float64Array(selectionSet().STAR_SET_CAPACITY),
		count: 0,
	};
	function selectAround(x, y, z, radiusKpc) {
		const out = radiusOut;
		out.count = 0;
		const r2 = radiusKpc * radiusKpc;
		const capacity = out.keys.length;
		if (recordBlocks && r2 > 0) {
			const blocks = recordBlocks();
			const identity = blocks.identity;
			const positions = blocks.float32;
			const words = blocks.uint32;
			const table = blocks.blocks;
			if (identity && positions && words && table) {
				let n = 0;
				for (let b = 0; b < table.length; b++) {
					const block = table[b];
					const base = block.offset;
					const total = block.count;
					for (let i = 0; i < total; i++) {
						const slot = base + i;
						const w = slot * 4;
						if ((words[w + 3] & VISIBLE_BIT) === 0) continue;
						const dx = positions[w] - x;
						const dy = positions[w + 1] - y;
						const dz = positions[w + 2] - z;
						const d2 = dx * dx + dy * dy + dz * dz;
						if (d2 > r2) continue;
						// A full array can only reject a newcomer that is no
						// nearer than the farthest it already holds, so skip
						// the scan: at the slider's top end every record
						// matches and the insertion walk alone would cost
						// matches × capacity.
						if (n >= capacity && d2 >= out.dists[capacity - 1]) continue;
						let j = 0;
						while (j < n && out.dists[j] <= d2) j++;
						const last = Math.min(n, capacity - 1);
						for (let k = last; k > j; k--) {
							out.keys[k] = out.keys[k - 1];
							out.dists[k] = out.dists[k - 1];
						}
						out.keys[j] = identity[slot];
						out.dists[j] = d2;
						if (n < capacity) n++;
					}
				}
				out.count = n;
			}
		}
		return out;
	}

	// Key → buffer slot, for the fly-to path and the label layer's rings.
	// One pass over the identity array (300k reads ≈ 1 ms), never per frame.
	function resolveSlot(key) {
		if (!recordBlocks || key === 0) return -1;
		const identity = recordBlocks().identity;
		if (!identity) return -1;
		for (let i = 0; i < identity.length; i++) {
			if (identity[i] === key) return i;
		}
		return -1;
	}

	// The packed word of one record slot (colour index, magnitude, flags,
	// jitter), or 0 when the slot is not a drawn star. The readout decodes it
	// without a second pass over the buffer.
	function recordWordAt(slot) {
		if (!recordBlocks || slot < 0) return 0;
		const blocks = recordBlocks();
		const words = blocks.uint32;
		if (!words || slot >= blocks.total) return 0;
		const packed = words[slot * 4 + 3];
		return (packed & VISIBLE_BIT) === 0 ? 0 : packed;
	}

	// The dispatched world position of one record slot, into `out`
	// (Float64Array(3)). False when the slot is not a drawn star.
	function recordPositionAt(slot, out) {
		if (!recordBlocks || slot < 0 || !out) return false;
		const blocks = recordBlocks();
		const positions = blocks.float32;
		const words = blocks.uint32;
		if (!positions || !words || slot >= blocks.total) return false;
		const w = slot * 4;
		const packed = words[w + 3];
		if ((packed & VISIBLE_BIT) === 0) return false;
		const px = positions[w], py = positions[w + 1], pz = positions[w + 2];
		if (orbitTime !== 0) {
			selectionOrbit().engineRecordPosition(out, px, py, pz, packed, orbitTime, orbitModel);
		} else {
			out[0] = px; out[1] = py; out[2] = pz;
		}
		return true;
	}

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

	return { pick, pickAny, setOrbitState, setRecordBlocks, selectAround, resolveSlot, recordPositionAt, recordWordAt };
}

const Selection = {
	createSelection, PICK_RADIUS_PX, PICK_TIE_PX,
	SELECT_RADIUS_LY_MIN, SELECT_RADIUS_LY_MAX, SELECT_RADIUS_LY_DEFAULT,
	radiusFromSlider, sliderFromRadius,
};
if (typeof module !== 'undefined') module.exports = Selection;
if (typeof window !== 'undefined') window.Selection = Selection;
