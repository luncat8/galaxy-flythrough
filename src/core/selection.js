// src/core/selection.js
// Click picking, the radius scan, and the one place that answers "where is this
// star drawn right now". Every entry point that judges a *position* dispatches
// through the shared orbit mask — the same calls the vertex stage makes
// (`engineRecordPosition` for a record, `engineLandmarkPosition` for a landmark):
//
//   * `pick` (landmarks only) — projects the landmark table with the camera's
//     viewProj and returns the nearest index within PICK_RADIUS_PX of the
//     pointer. The caller feeds the hit to camera.setOrbitTarget — selection
//     never mutates the camera itself, so a miss is a pure no-op.
//   * `pickAny` (plan §3.1, 0.5.0) — walks every resident record in the
//     renderer's five blocks, dispatches each, projects the drawn position, and
//     returns the nearest hit within PICK_RADIUS_PX. Inside PICK_TIE_PX the
//     brighter star wins, so a click on a pair takes the bright one in front
//     rather than the faint one it hides.
//   * `resolveDrawn` (ui.2) — the same dispatch for one record: what the camera
//     flies to, what it orbits, and what the readout measures.
//   * `selectAround` (plan §3.3) — the radius scan, comparing drawn positions on
//     both sides of the distance.
//
// Both buffer walks are dispatch-bound, so both are chunked across frames with
// the same begin/step contract and the same abort on a rebuild; neither is
// warmed up per frame.
//
// The walks need the buffers, which do not exist when the selection object is
// constructed, so `setRenderer(renderer)` is called by main.js after prepare().
// Nothing here allocates: the caller passes the `out` record (plan §3.1) and the
// scans write into their own preallocated SoA.

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
// Both chunked sweeps (the pick and the radius scan) check the clock every this
// many records, so the clock call is not itself the cost.
const STEP_CHECK_RECORDS = 2048;
// resolveDrawn's three answers: which frame of reference the caller got.
const DRAWN_STALE = 0;
const DRAWN_APPROX = 1;
const DRAWN_EXACT = 2;

const selectionCoords = (typeof module !== 'undefined' && module.exports)
	? require('../math/coords.js')
	: window.Coords;
// Live lookup (like label-layer.js): the orbit module loads before selection
// on the page, but tests load orderings vary. Without an orbit module there is
// no movement to dispatch, so the fallback is the identity.
const selectionOrbitFallback = {
	engineLandmarkPosition: (out, i, bx, by, bz) => { out[0] = bx; out[1] = by; out[2] = bz; return out; },
	engineRecordPosition: (out, bx, by, bz) => { out[0] = bx; out[1] = by; out[2] = bz; return false; },
	engineRecordVelocity: (out) => { out[0] = 0; out[1] = 0; out[2] = 0; return false; },
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

	// --- Drawn position (ui.2) -------------------------------------------
	// Where the sky draws one record right now: the dispatch twin of the pick's
	// hit test, for a single star instead of the whole buffer. `ref` is
	// pick-shaped ({ kind, index, key, x, y, z }, `index` block-local, `x/y/z`
	// the record's birth position) — a selection-set member, a pick, or a
	// history snapshot. `out` (Float64Array(3)) receives the drawn position.
	//
	// The return is which of the three cases applied, so a caller can be honest
	// about it instead of guessing from the engine name:
	//   DRAWN_EXACT  — dispatched from the resident record the key names;
	//   DRAWN_APPROX — dispatched, but the simple mask's θ is GPU-only (§2.6's
	//                  honest gap: the CPU returns the classic law or birth);
	//   DRAWN_STALE  — no resident record holds that key, so `out` keeps the
	//                  ref's own snapshot position.
	// The slot is validated by key exactly as resolveSet and the label layer's
	// ring map validate theirs, so a stale index can never resolve to the star
	// that happens to sit in it now.
	// The resident record a ref names, or false. Shared by the position and
	// velocity twins so the slot/key validation has one source. Fill-then-read
	// scratch, like orbitScratch: no per-frame allocation.
	const drawnIn = { bx: 0, by: 0, bz: 0, packed: 0, index: 0, landmark: false };
	function readDrawnInputs(ref) {
		if (!ref || !renderer) return false;
		const records = selectionRecords();
		const info = renderer.starBlocks();
		if (!records || !info || !info.view || !info.identity || !info.blocks) return false;
		const kind = ref.kind | 0;
		const block = info.blocks[kind];
		const index = ref.index | 0;
		if (!block || index < 0 || index >= (block.count | 0)) return false;
		const slot = (block.offset | 0) + index;
		if ((info.identity[slot] >>> 0) !== (ref.key >>> 0)) return false;
		const byteOffset = slot * records.RECORD_BYTES;
		const packed = info.view.getUint32(byteOffset + 12, true);
		if ((packed & (records.FLAG_VISIBLE << 16)) === 0) return false;
		drawnIn.bx = info.view.getFloat32(byteOffset, true);
		drawnIn.by = info.view.getFloat32(byteOffset + 4, true);
		drawnIn.bz = info.view.getFloat32(byteOffset + 8, true);
		drawnIn.packed = packed;
		drawnIn.index = index;
		drawnIn.landmark = block.kind === 'landmark';
		return true;
	}

	function resolveDrawn(ref, out) {
		if (!ref) return DRAWN_STALE;
		out[0] = ref.x; out[1] = ref.y; out[2] = ref.z;
		if (!readDrawnInputs(ref)) return DRAWN_STALE;
		if (!orbitModel) {
			out[0] = drawnIn.bx; out[1] = drawnIn.by; out[2] = drawnIn.bz;
			return DRAWN_EXACT;
		}
		if (drawnIn.landmark) {
			selectionOrbit().engineLandmarkPosition(orbitScratch, drawnIn.index,
				drawnIn.bx, drawnIn.by, drawnIn.bz, drawnIn.packed & 0xFF,
				orbitTime, orbitModel);
			out[0] = orbitScratch[0]; out[1] = orbitScratch[1]; out[2] = orbitScratch[2];
			return DRAWN_EXACT;
		}
		const approximated = selectionOrbit().engineRecordPosition(orbitScratch,
			drawnIn.bx, drawnIn.by, drawnIn.bz, drawnIn.packed, orbitTime, orbitModel) === true;
		out[0] = orbitScratch[0]; out[1] = orbitScratch[1]; out[2] = orbitScratch[2];
		return approximated ? DRAWN_APPROX : DRAWN_EXACT;
	}

	// --- Drawn velocity (ui.15) ------------------------------------------
	// The target's own drawn motion, in kpc per ship-second — the quantity §5's
	// autopilot builds its desired velocity (and so its nose) from. It is the
	// same engine dispatch as resolveDrawn, differenced across a fixed
	// *model-time* baseline either side of `orbitTime` (orbit.js's
	// engineRecordVelocity), so it does not depend on the ship clock at all.
	//
	// A consecutive-frame difference cannot serve at the fine rungs: the drawn
	// position is a f64 near 8-20 kpc, so its own ULP is ~55 km on a
	// solar-circle coordinate, while one frame of a 42 km/s star at the
	// real-time rung is 0.7 km. The frame difference is then 0 for dozens of
	// frames and one ULP — a coordinate-axis spike of thousands of km/s — on the
	// next, and the autopilot's nose followed those spikes (the reported ui.15
	// bug).
	//
	// Returns the same three answers as resolveDrawn. Without an orbit model the
	// record draws where it was born, so the answer is EXACT and the velocity
	// zero. Under the simple mask the dispatch reports the documented CPU gap
	// (APPROX): the classic bit still gives the classic derivative, the mask's
	// own static record gives zero.
	function resolveDrawnVelocity(ref, out) {
		out[0] = 0; out[1] = 0; out[2] = 0;
		if (!readDrawnInputs(ref)) return DRAWN_STALE;
		if (!orbitModel) return DRAWN_EXACT;
		// The simple engine's landmark mirror is stepped by the frame loop, not a
		// closed form of time, so the CPU has no drawn velocity for a landmark.
		// Report the gap rather than invent one (no ship target is a landmark).
		if (drawnIn.landmark) return DRAWN_APPROX;
		const approximated = selectionOrbit().engineRecordVelocity(out, drawnIn.bx,
			drawnIn.by, drawnIn.bz, drawnIn.packed, orbitTime, orbitModel) === true;
		return approximated ? DRAWN_APPROX : DRAWN_EXACT;
	}

	// Plan §3.3, "select around" — dispatch-exact since ui.2. One pass over the
	// resident records keeping everything the sky draws inside `radiusKpc` of the
	// centre it draws, ascending by distance, truncated at `maxCount`.
	//
	// The centre and the candidates are both **drawn** positions, through the same
	// engine-mask law the vertex stage, the labels and the picker use. The birth
	// scan this replaced answered a different question: measured on a 120k field
	// at 100 Myr of star time, a 50 ly birth scan around a picked star kept three
	// stars of which two were drawn outside the radius — the worst 3 172 ly away,
	// 60× the radius — while the drawn neighbourhood held a different star.
	//
	// Two frames of reference, both in the result and neither redundant:
	//   `dist2`   drawn-space kpc², the radius test and the sort key;
	//   `x/y/z`   the record's birth position, what a snapshot stores and what
	//             `stellarInputs` decomposes the density at (BLOCK_LOCAL,
	//             BLOCK_OBJECT) — so it stays the birth position on purpose.
	//
	// The dispatch makes the scan cost what the picker costs (~0.3 µs/record
	// classic, ~1.2 µs apocenter at 300k), so it borrows the picker's contract
	// rather than inventing one: `beginSelectAround` snapshots `dynamicVersion`,
	// `selectAroundStep(maxRecords, maxMs)` walks a slice under a record *and* a
	// wall-clock budget, `selectAround` is the same sweep in one call for tests
	// and small fields, and a rebuild mid-sweep aborts (`around.aborted`) instead
	// of mixing two frames. Nothing is precomputed per frame to make the click
	// cheaper: selection is rare and user-initiated, and a spatial index kept warm
	// in the frame loop would tax every frame to save one click.
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
		aborted: 0,
	};
	const aroundSweep = {
		active: false, done: true,
		k: 0, i: 0, n: 0, cap: 0, r2: 0,
		px: 0, py: 0, pz: 0,
		version: -1,
	};

	function beginSelectAround(px, py, pz, radiusKpc, maxCount) {
		around.count = 0;
		around.truncated = 0;
		around.aborted = 0;
		aroundSweep.active = false;
		aroundSweep.done = true;
		aroundSweep.n = 0;
		aroundSweep.cap = 0;
		if (!renderer || !(radiusKpc > 0)) return false;
		const records = selectionRecords();
		const info = renderer.starBlocks();
		if (!records || !info || !info.view || !info.identity) return false;
		const cap = Math.min(AROUND_CAPACITY, Math.max(0, maxCount | 0));
		if (cap === 0) return false;
		aroundSweep.px = px;
		aroundSweep.py = py;
		aroundSweep.pz = pz;
		aroundSweep.r2 = radiusKpc * radiusKpc;
		aroundSweep.cap = cap;
		aroundSweep.k = 0;
		aroundSweep.i = 0;
		aroundSweep.version = info.dynamicVersion;
		aroundSweep.active = true;
		aroundSweep.done = false;
		return true;
	}

	// The kept rows are decided on four scalars, so the insertion sort shifts four
	// scalars; the record fields the caller reads (`x/y/z`, `packed`, `colorIndex`,
	// `absMag`) are re-read once, from the record each kept row names, when the
	// sweep lands. Sorting eleven parallel arrays on every arrival was the same
	// answer reached the slow way.
	function enrichAround(info, records) {
		const view = info.view;
		const blocks = info.blocks;
		const n = aroundSweep.n;
		for (let j = 0; j < n; j++) {
			const block = blocks[around.kind[j]];
			const byteOffset = ((block.offset | 0) + around.index[j]) * records.RECORD_BYTES;
			const packed = view.getUint32(byteOffset + 12, true);
			around.x[j] = view.getFloat32(byteOffset, true);
			around.y[j] = view.getFloat32(byteOffset + 4, true);
			around.z[j] = view.getFloat32(byteOffset + 8, true);
			around.packed[j] = packed;
			around.colorIndex[j] = packed & 0xFF;
			around.absMag[j] = records.decodeAbsMag((packed >>> 8) & 0xFF);
		}
	}

	function selectAroundStep(maxRecords, maxMs) {
		if (!aroundSweep.active) return true;
		const records = selectionRecords();
		const info = renderer.starBlocks();
		// The blocks were rebuilt under the sweep: the rows already kept name
		// slots that may hold other stars now. Abort, and leave the caller's set
		// alone — a half-applied neighbourhood is worse than a repeated click.
		if (!records || !info || info.dynamicVersion !== aroundSweep.version) {
			aroundSweep.active = false;
			aroundSweep.done = true;
			around.aborted = 1;
			around.count = 0;
			return true;
		}
		const view = info.view;
		const identity = info.identity;
		const blocks = info.blocks;
		const orbit = selectionOrbit();
		const visibleBit = records.FLAG_VISIBLE << 16;
		const cap = aroundSweep.cap;
		const r2 = aroundSweep.r2;
		const cx = aroundSweep.px, cy = aroundSweep.py, cz = aroundSweep.pz;
		const budget = maxRecords === undefined || maxRecords === Infinity ? Infinity : (maxRecords | 0);
		const deadline = (maxMs > 0) ? performance.now() + maxMs : Infinity;
		let steps = 0;
		let sinceCheck = 0;
		let n = aroundSweep.n;
		while (aroundSweep.k < blocks.length && steps < budget) {
			const block = blocks[aroundSweep.k];
			const count = block.count | 0;
			if (count <= 0 || aroundSweep.i >= count) {
				aroundSweep.k++;
				aroundSweep.i = 0;
				continue;
			}
			const base = block.offset | 0;
			const isLandmark = block.kind === 'landmark';
			while (aroundSweep.i < count && steps < budget) {
				if (++sinceCheck >= STEP_CHECK_RECORDS) {
					sinceCheck = 0;
					if (performance.now() >= deadline) break;
				}
				const i = aroundSweep.i++;
				steps++;
				const slot = base + i;
				const byteOffset = slot * records.RECORD_BYTES;
				const packed = view.getUint32(byteOffset + 12, true);
				if ((packed & visibleBit) === 0) continue;
				const bx = view.getFloat32(byteOffset, true);
				const by = view.getFloat32(byteOffset + 4, true);
				const bz = view.getFloat32(byteOffset + 8, true);
				let dx = bx - cx, dy = by - cy, dz = bz - cz;
				let approximated = false;
				if (orbitModel) {
					if (isLandmark) {
						orbit.engineLandmarkPosition(orbitScratch, i, bx, by, bz,
							packed & 0xFF, orbitTime, orbitModel);
					} else {
						approximated = orbit.engineRecordPosition(orbitScratch,
							bx, by, bz, packed, orbitTime, orbitModel) === true;
					}
					dx = orbitScratch[0] - cx;
					dy = orbitScratch[1] - cy;
					dz = orbitScratch[2] - cz;
				}
				const d2 = dx * dx + dy * dy + dz * dz;
				if (d2 > r2) continue;
				// Insertion sort, descending scan: the kept list is ascending. The
				// shift at i === cap is skipped, which is what drops the farthest
				// kept member when a nearer one arrives.
				let at = n;
				while (at > 0 && around.dist2[at - 1] > d2) {
					if (at < cap) {
						around.dist2[at] = around.dist2[at - 1];
						around.keys[at] = around.keys[at - 1];
						around.kind[at] = around.kind[at - 1];
						around.index[at] = around.index[at - 1];
						around.approximated[at] = around.approximated[at - 1];
					}
					at--;
				}
				// `truncated` counts every in-radius record that did not make the
				// kept list — refused on arrival *and* evicted later by a nearer
				// one — so it always equals (inside − kept).
				if (at >= cap) { around.truncated++; continue; }
				if (n < cap) n++;
				else around.truncated++;
				around.dist2[at] = d2;
				around.keys[at] = identity[slot] >>> 0;
				around.kind[at] = aroundSweep.k;
				around.index[at] = i;
				around.approximated[at] = approximated ? 1 : 0;
			}
			if (aroundSweep.i >= count) { aroundSweep.k++; aroundSweep.i = 0; }
		}
		aroundSweep.n = n;
		if (aroundSweep.k >= blocks.length) {
			enrichAround(info, records);
			around.count = n;
			aroundSweep.active = false;
			aroundSweep.done = true;
			return true;
		}
		return steps < budget;   // budget exhausted mid-walk
	}

	function selectAround(px, py, pz, radiusKpc, maxCount) {
		if (!beginSelectAround(px, py, pz, radiusKpc, maxCount)) return 0;
		while (!selectAroundStep(1 << 24)) { /* one big step is the whole sweep */ }
		return around.count;
	}

	// ui.18 (colony-economy-plan §9): a second budgeted consumer (the
	// expansion's dispatch scan) shares this one sweep state with the
	// user's radius scan, and beginSelectAround restarts it without
	// asking. The stepper's owner compares the parameters it began with
	// against these and abandons quietly on a mismatch, so a result is
	// never consumed by the wrong side.
	function aroundSweepParams() {
		if (!aroundSweep.active) return null;
		return { px: aroundSweep.px, py: aroundSweep.py, pz: aroundSweep.pz,
			r2: aroundSweep.r2, cap: aroundSweep.cap };
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
	// projection-bound: `orbit.engineRecordPosition` costs ~0.3 µs per record
	// under the classic mask and ~1.2 µs with the apocenter pass (measured at
	// 300k — the live figures are printed by experiments/star-select-test.js
	// and logged in experiments/logs/star-select.json), so one synchronous pass
	// over 300k records is 90–360 ms — a visible hitch on every click.
	// `beginPick` starts a sweep,
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
	// than `maxMs` of wall time (checked every STEP_CHECK_RECORDS records, so the
	// clock call is not itself the cost). Both limits matter: the per-record cost
	// depends on the engine mask by a factor of four (see the header), so a fixed
	// record count would be a 2 ms slice under one mask and a 40 ms hitch under
	// another. Returns true when the sweep is finished (including "finished with
	// no hit"), false to be called again.
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
		pick, pickAny, beginPick, pickStep, pickResult,
		selectAround, beginSelectAround, selectAroundStep, aroundSweepParams, around, resolveDrawn,
		resolveDrawnVelocity,
		setOrbitState, setRenderer,
	};
}

const Selection = {
	createSelection, PICK_RADIUS_PX, PICK_TIE_PX, AROUND_CAPACITY, STEP_CHECK_RECORDS,
	DRAWN_STALE, DRAWN_APPROX, DRAWN_EXACT,
	SELRAD_MIN_LY, SELRAD_MAX_LY, SELRAD_DEFAULT_LY, SELRAD_DEFAULT_LOG,
};
if (typeof module !== 'undefined') module.exports = Selection;
if (typeof window !== 'undefined') window.Selection = Selection;
