// src/core/field-anchors.js
// The distance field's anchor providers: which stars the field is computed
// over (distance-field-plan.md, §5).
//
// The field's arithmetic does not know or care: it takes a list of positions
// and paints them. This module is the part that answers "which stars", and it
// answers for every star situation the app has:
//
//   nearest        the N nearest of the *resident* sky - whatever the renderer
//                  is actually drawing, procedural or catalog, in any galaxy
//                  type, with or without a catalog bundle
//   selected       the app's selection set, at the positions they are drawn
//   constellations the named stars, at the positions they are drawn
//
// The drawn positions are the point (ui.2's contract): under a movement mask
// the birth record and the drawn record are different places, and a field
// built from birth positions would not sit under the stars the user sees.
//
// The nearest-N scan is bounded: the resident set can be 300k records and a
// dispatch per record costs ~0.3 µs, so a full scan every frame would be a
// 90 ms hitch. The scan therefore samples the resident records with a stride
// (the sample is spread over the whole sky) and re-picks a few times a
// second, while the winners' positions are re-dispatched every frame, so the
// field tracks the stars even while the set is being re-chosen.

'use strict';

(function () {
	const MAX_ANCHORS = 1024;
	// How many resident records the nearest-N scan samples, and how often it
	// re-picks. 8000 dispatches is about 2.5 ms.
	const SAMPLE_RECORDS = 8000;
	const PICK_PERIOD = 0.5;

	function createFieldAnchors(options) {
		const opts = options || {};
		const renderer = opts.renderer;
		const camera = opts.camera;
		const landmarks = opts.landmarks;
		const selection = opts.selection;
		const starSet = opts.starSet;
		const orbit = opts.orbit
			|| (typeof window !== 'undefined' && window.OrbitLib)
			|| (typeof module !== 'undefined' && module.exports ? require('../math/orbit.js') : null);
		const records = (typeof window !== 'undefined' && window.StarRecord)
			|| (typeof module !== 'undefined' && module.exports ? require('../math/star-record.js') : null);

		// The anchors, in the galactic frame, in kpc.
		const positions = new Float64Array(MAX_ANCHORS * 3);
		// A max-heap of the kept nearest records: the root is the farthest of
		// them, so a new candidate replaces it only when it is nearer.
		const heap = {
			d2: new Float64Array(MAX_ANCHORS),
			slot: new Int32Array(MAX_ANCHORS),
			kind: new Uint8Array(MAX_ANCHORS),
			n: 0,
		};
		// The winners, kept by slot so their drawn positions can be
		// re-dispatched every frame while the set is re-chosen.
		const winners = { slot: new Int32Array(MAX_ANCHORS), kind: new Uint8Array(MAX_ANCHORS), n: 0 };
		const drawn = new Float64Array(3);
		const scratch = new Float64Array(3);
		const ref = { kind: 0, index: 0, key: 0, x: 0, y: 0, z: 0 };

		let source = 'nearest';
		let want = 120;
		let mode = 'off';
		let model = null;
		let starTimeMyr = 0;
		let pickClock = PICK_PERIOD;
		let anchorCount = 0;

		function heapPush(d2, slot, kind) {
			let i = heap.n++;
			heap.d2[i] = d2; heap.slot[i] = slot; heap.kind[i] = kind;
			while (i > 0) {
				const p = (i - 1) >> 1;
				if (heap.d2[p] >= heap.d2[i]) break;
				const td = heap.d2[p]; heap.d2[p] = heap.d2[i]; heap.d2[i] = td;
				const ts = heap.slot[p]; heap.slot[p] = heap.slot[i]; heap.slot[i] = ts;
				const tk = heap.kind[p]; heap.kind[p] = heap.kind[i]; heap.kind[i] = tk;
				i = p;
			}
		}

		function heapSift() {
			let i = 0;
			for (;;) {
				const l = 2 * i + 1;
				const r = l + 1;
				let big = i;
				if (l < heap.n && heap.d2[l] > heap.d2[big]) big = l;
				if (r < heap.n && heap.d2[r] > heap.d2[big]) big = r;
				if (big === i) break;
				const td = heap.d2[big]; heap.d2[big] = heap.d2[i]; heap.d2[i] = td;
				const ts = heap.slot[big]; heap.slot[big] = heap.slot[i]; heap.slot[i] = ts;
				const tk = heap.kind[big]; heap.kind[big] = heap.kind[i]; heap.kind[i] = tk;
				i = big;
			}
		}

		// Removes the root (the farthest of the kept records).
		function heapPop() {
			if (heap.n <= 0) return;
			heap.n--;
			if (heap.n === 0) return;
			heap.d2[0] = heap.d2[heap.n];
			heap.slot[0] = heap.slot[heap.n];
			heap.kind[0] = heap.kind[heap.n];
			heapSift();
		}

		// The drawn position of one record, through the shared mask dispatch
		// (the same law the vertex stage, the labels and the picker use).
		function drawnRecord(kind, slot, view, byteOffset, packed) {
			let px = view.getFloat32(byteOffset, true);
			let py = view.getFloat32(byteOffset + 4, true);
			let pz = view.getFloat32(byteOffset + 8, true);
			if (orbit && model) {
				if (kind === 1) {
					orbit.engineLandmarkPosition(scratch, slot, px, py, pz, packed & 0xFF, starTimeMyr, model);
				} else {
					orbit.engineRecordPosition(scratch, px, py, pz, packed, starTimeMyr, model);
				}
				px = scratch[0]; py = scratch[1]; pz = scratch[2];
			}
			drawn[0] = px; drawn[1] = py; drawn[2] = pz;
			return drawn;
		}

		// The blocks the scan may look at. The source decides: 'nearest' is
		// the whole resident sky, 'catalog' is the Gaia subset alone and
		// 'procedural' is the generated stars alone (the global field and
		// the local ones). The block *kinds* are the renderer's, so the
		// filter survives a change of the block order.
		function blockAllowed(kind) {
			if (source === 'catalog') return kind === 'catalog';
			if (source === 'procedural') return kind === 'field' || kind === 'local';
			return true;
		}

		// Re-pick the nearest N of the resident sky. The sample is a stride
		// over the resident records, so it covers the whole sky rather than
		// one corner of it.
		function pickNearest() {
			if (!renderer || !records) return;
			const info = renderer.starBlocks();
			const view = info && info.view;
			const blocks = info && info.blocks;
			if (!view || !blocks) return;
			const cam = camera.cameraPos;
			let total = 0;
			for (let k = 0; k < blocks.length; k++) {
				if (!blockAllowed(blocks[k].kind)) continue;
				total += blocks[k].count | 0;
			}
			if (total <= 0) { winners.n = 0; return; }
			const stride = Math.max(1, Math.floor(total / SAMPLE_RECORDS));
			const keep = Math.max(1, Math.min(MAX_ANCHORS, want));
			const visibleBit = records.FLAG_VISIBLE << 16;
			heap.n = 0;
			for (let k = 0; k < blocks.length; k++) {
				const block = blocks[k];
				if (!blockAllowed(block.kind)) continue;
				const count = block.count | 0;
				const end = (block.offset | 0) + count;
				for (let slot = block.offset | 0; slot < end; slot += stride) {
					const byteOffset = slot * records.RECORD_BYTES;
					const packed = view.getUint32(byteOffset + 12, true);
					if ((packed & visibleBit) === 0) continue;
					const p = drawnRecord(k, slot - (block.offset | 0), view, byteOffset, packed);
					const dx = p[0] - cam[0], dy = p[1] - cam[1], dz = p[2] - cam[2];
					const d2 = dx * dx + dy * dy + dz * dz;
					if (heap.n < keep) {
						heapPush(d2, slot, k);
					} else if (d2 < heap.d2[0]) {
						heap.d2[0] = d2; heap.slot[0] = slot; heap.kind[0] = k;
						heapSift();
					}
				}
			}
			// The heap holds the kept records; the winners are the same set,
			// nearest first. The heap's root is the farthest of them, so the
			// winners are filled back to front from the root: the last pop is
			// the nearest, and it lands in slot 0.
			const n = heap.n;
			for (let i = n - 1; i >= 0; i--) {
				winners.slot[i] = heap.slot[0];
				winners.kind[i] = heap.kind[0];
				heapPop();
			}
			winners.n = n;
		}

		// The selection set, at the positions it is drawn.
		function fillSelected() {
			if (!starSet || !selection) return 0;
			const n = Math.min(starSet.count, MAX_ANCHORS);
			for (let i = 0; i < n; i++) {
				ref.kind = starSet.blockKind[i];
				ref.index = starSet.bufferIdx[i];
				ref.key = starSet.keys[i];
				ref.x = starSet.x[i];
				ref.y = starSet.y[i];
				ref.z = starSet.z[i];
				selection.resolveDrawn(ref, drawn);
				positions[i * 3] = drawn[0];
				positions[i * 3 + 1] = drawn[1];
				positions[i * 3 + 2] = drawn[2];
			}
			return n;
		}

		// The named stars, at the positions they are drawn.
		function fillConstellations() {
			if (!landmarks || !orbit) return 0;
			const n = Math.min(landmarks.count, MAX_ANCHORS);
			for (let i = 0; i < n; i++) {
				let px = landmarks.positions[i * 3];
				let py = landmarks.positions[i * 3 + 1];
				let pz = landmarks.positions[i * 3 + 2];
				if (model) {
					orbit.engineLandmarkPosition(scratch, i, px, py, pz,
						landmarks.ENTRIES[i].colorIndex, starTimeMyr, model);
					px = scratch[0]; py = scratch[1]; pz = scratch[2];
				}
				positions[i * 3] = px;
				positions[i * 3 + 1] = py;
				positions[i * 3 + 2] = pz;
			}
			return n;
		}

		// The nearest winners, at the positions they are drawn *now*.
		function fillNearest() {
			if (!renderer || !records) return 0;
			const info = renderer.starBlocks();
			const view = info && info.view;
			const blocks = info && info.blocks;
			if (!view || !blocks) return 0;
			const n = winners.n;
			for (let i = 0; i < n; i++) {
				const slot = winners.slot[i];
				const kind = winners.kind[i];
				const block = blocks[kind];
				const byteOffset = slot * records.RECORD_BYTES;
				const packed = view.getUint32(byteOffset + 12, true);
				const p = drawnRecord(kind, slot - (block.offset | 0), view, byteOffset, packed);
				positions[i * 3] = p[0];
				positions[i * 3 + 1] = p[1];
				positions[i * 3 + 2] = p[2];
			}
			return n;
		}

		// One call per frame: the anchors, in the galactic frame.
		function update(nextModel, nextStarTimeMyr, dt) {
			model = nextModel || model;
			starTimeMyr = nextStarTimeMyr || 0;
			if (mode === 'off') {
				anchorCount = 0;
				return anchorCount;
			}
			if (source === 'selected') {
				anchorCount = fillSelected();
			} else if (source === 'constellations') {
				anchorCount = fillConstellations();
			} else {
				pickClock += dt || 0;
				if (pickClock >= PICK_PERIOD || winners.n === 0) {
					pickClock = 0;
					pickNearest();
				}
				anchorCount = fillNearest();
			}
			return anchorCount;
		}

		return {
			update,
			positions,
			get count() { return anchorCount; },
			get source() { return source; },
			get mode() { return mode; },
			setSource(next) {
				const s = (next === 'selected' || next === 'constellations' || next === 'nearest'
					|| next === 'catalog' || next === 'procedural') ? next : 'nearest';
				if (s === source) return source;
				source = s;
				pickClock = PICK_PERIOD;
				return source;
			},
			setCount(n) {
				want = Math.max(1, Math.min(MAX_ANCHORS, n | 0));
				pickClock = PICK_PERIOD;
				return want;
			},
			setMode(next) {
				mode = (next === 'height' || next === 'spread' || next === 'gradient') ? next : 'off';
				return mode;
			},
			MAX_ANCHORS,
			SAMPLE_RECORDS,
			PICK_PERIOD,
		};
	}

	const FieldAnchors = {
		createFieldAnchors,
		MAX_ANCHORS,
		SAMPLE_RECORDS,
		PICK_PERIOD,
	};
	if (typeof module !== 'undefined') module.exports = FieldAnchors;
	if (typeof window !== 'undefined') window.FieldAnchors = FieldAnchors;
})();
