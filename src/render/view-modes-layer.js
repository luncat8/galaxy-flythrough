// src/render/view-modes-layer.js
// The view-modes heightmap as an app view — rewritten from zero (view-modes.7)
// around the island that works (src/view-modes.js), anchored on the renderer's
// own stars (starBlocks(): one staging buffer, five blocks, identity keys).
//
// The island's frame loop is the spec:
//   advance the sky → re-pick the anchors → integrate the set to the live star
//   time → sample the raw field → apply the display range → paint.
// This module is that loop over real resident records. Three contracts make
// the map agree with the picture (findings-pitfalls-skills.md, 2026-10-17):
//
//   1. A nearest-N query measures the *drawn* sky and stores the *birth*
//      record. `sky.cur` is every visible resident slot dispatched through the
//      same law the sprite pass mirrors (`orbit.engineRecordPosition` /
//      `engineLandmarkPosition`, per the slot's landmark index); the pick
//      measures `sky.cur` and copies the winner's birth words out of the
//      staging view. The set is then dispatched to the frame's star time by
//      `Field.advancePositions` — the motion is never applied twice.
//   2. "Nearest" means nearest of everything the frame draws: all five blocks
//      (field, landmark, object, local, catalog), not a catalog-only subset
//      and not a stride of a 300 k sky. The scan is exact — one linear pass
//      with a fixed max-heap of N entries, over a compact list of the live
//      visible slots the renderer keeps.
//   3. The layout comes from the camera's own forward/right/up (never a
//      re-derived basis) and the field geometry is the island's: the chart
//      quaternion from the look direction, the latitude-limited letterbox,
//      the window's own aspect on the view layout.
//
// Star time moves the sky faster than the eye: the whole resident set is
// re-dispatched on a throttle in time-budgeted slices (never one hitch), and a
// completed sweep re-picks. The frame draws the set at the *live* star time
// every frame, so the map rides the clock between sweeps.

'use strict';

(function () {
	const Field = (typeof window !== 'undefined' && window.ViewModesField)
		? window.ViewModesField
		: require('../math/view-modes-field.js');
	const Renderer = (typeof window !== 'undefined' && window.ViewModesRenderer)
		? window.ViewModesRenderer
		: require('./view-modes-renderer.js');
	const Orbit = (typeof window !== 'undefined' && window.OrbitLib)
		? window.OrbitLib
		: require('../math/orbit.js');

	const PAIRS_BUDGET = { fast: 3e5, balanced: 1.5e6, high: 6e6, full: 2.4e7 };
	const RANGE_PERIOD = 0.25;      // seconds between auto-range reads
	const SWEEP_PERIOD = 0.25;      // seconds between whole-sky advance sweeps
	const PICK_PERIOD = 0.25;       // seconds between star-time-only re-picks
	const SLICE_MS = 2.5;           // per-frame budget of the sky dispatch
	const LANDMARK_BLOCK = 'landmark';
	const RECORD_BYTES = 16;        // StarPacked: the staging buffer's record

	// One starting manual range per mode, in the mode's own log10 unit. A mode
	// without one inherits the live auto range the first time it is used.
	const MANUAL_DEFAULTS = {
		height: { lo: -3, hi: 0 },
		spread: { lo: -3, hi: -0.3 },
		gradient: { lo: -3.5, hi: -1.5 },
	};

	const MODES = ['off', 'height', 'spread', 'gradient'];
	const SOURCE_LABELS = { nearest: 'nearest', constellations: 'constellations', selected: 'selected' };

	function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

	function createViewModesLayer(canvas, opts) {
		const camera = opts.camera;
		const modelOf = opts.model;
		const blocksOf = opts.starBlocks;
		const selectionOf = opts.selection;
		const landmarks = opts.landmarks
			|| ((typeof window !== 'undefined') ? window.Landmarks : require('../data/landmarks.js'));

		const ctx = canvas.getContext('2d');

		const settings = {
			mode: 'off',               // the map stays out of the way until asked (M)
			projection: 'view',        // 'view' = view sphere, 'plane' = sky chart
			source: 'nearest',         // 'nearest' | 'constellations' | 'selected'
			anchors: 256,
			sigmaDeg: Field.SIGMA_DEG,
			budget: 'balanced',
			resH: 0,                   // 0 = auto
			ramp: 'auto',
			relief: Renderer.RELIEF_DEFAULT,
			opacity: 1,
			contours: false,
			grid: false,
			drawStars: true,
			names: true,
			smooth: true,
			invert: false,
			followLook: true,
			mirrorChart: true,
			chartSpanDeg: 360,
			autoRange: true,
		};

		// What the panel and the status line read. Mutated in place; the manual
		// table keeps one pair of slider values per mode (a mode's own range
		// survives switching away and back).
		const ranges = { height: null, spread: null, gradient: null };
		const live = {
			setN: 0,
			setSource: '—',
			pairs: 0,
			fieldMs: 0,
			lo: -3,
			hi: 0,
			// '' until the first auto-range read; the first offer in a mode
			// initializes it, later ones are followed at the shared rate.
			mode: '',
			targetLo: -3, targetHi: 0,
		};

		// Camera basis in the layout's field names; filled per frame from the
		// camera's own forward/right/up — the same axes the sprite pass projects.
		const basis = { fx: 1, fy: 0, fz: 0, rx: 0, ry: -1, rz: 0, ux: 0, uy: 0, uz: 1 };
		const chartQuat = new Float64Array([0, 0, 0, 1]);
		const layoutOpts = { kind: 'view', w: 0, h: 0, fovY: 0, aspect: 1, basis: null, spanDeg: 360, quat: null, mirror: true };
		const fieldOpts = { mode: 'height', sigmaDeg: 3, measure: false };
		const paintOpts = {
			mode: 'height', rect: null, positions: null, eye: null, set: null, viewBox: null,
			drawContours: false, contourLevels: 10, drawGrid: false, drawNames: true,
			invert: false, smooth: true, ramp: null, relief: Renderer.RELIEF_DEFAULT,
		};
		const letterbox = { x: 0, y: 0, w: 0, h: 0 };
		const cornerDir = new Float64Array(3);
		const viewBox = [new Float64Array(3), new Float64Array(3), new Float64Array(3), new Float64Array(3)];
		const VIEW_SIGNS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
		const autoRangeScratch = { lo: 0, hi: 0, span: 0 };
		const cameraState = {};
		const stats = { pairs: 0, rawLo: 0, rawHi: 0, autoLo: 0, autoHi: 0, spreadMax: 0, dMin: 0, dMax: 0, empty: true };
		const eye = new Float64Array(3);
		const layout = { kind: '', w: 0, h: 0 };
		const drawn = new Float64Array(Field.MAX_STARS * 3);   // the set at the live star time

		let raw = null;
		let field = null;
		let off = null;
		let offCtx = null;
		let rangeClock = 0;
		let pickClock = 0;
		let selStamp = 0;
		let lastOn = null;
		let stateSet = null;
		let setDirty = true;
		const pickPos = new Float64Array(3);
		let pickTime = 0;

		// ---- anchor sets ------------------------------------------------------
		// pickSet is the reusable target of every dynamic source. Its landmarkIdx
		// gives each entry its landmark-table index (or −1), so the dispatch draws
		// a landmark anchor exactly the way the sprite pass does.
		const pickSet = Field.createSet(Field.MAX_STARS);
		pickSet.landmarkIdx = new Int32Array(Field.MAX_STARS);
		const pickNames = new Array(Field.MAX_STARS);
		for (let i = 0; i < Field.MAX_STARS; i++) pickNames[i] = '';
		pickSet.names = pickNames;
		let constSet = null;

		// ---- the resident sky -------------------------------------------------
		// Every live, visible record of the renderer's staging buffer, compacted:
		// `slot` is its staging slot (the birth words live in the view),
		// `cur` its drawn position (the orbit dispatch at `curTime`). The list is
		// rebuilt when residency changes (dynamicVersion / total); `cur` is
		// re-dispatched in slices so a 500 k sky never costs one hitch.
		const sky = {
			n: 0,
			slot: new Int32Array(0),
			cur: new Float32Array(0),
			curTime: 0,
			sweeping: false,
			sweepTo: 0,
			cursor: 0,
			clock: 0,
			version: -1,
			total: 0,
			landmarkBase: -1,
			landmarkCount: 0,
			view: null,
		};

		// The query's fixed max-heap: `want` entries, root = farthest.
		const heap = { d2: new Float64Array(Field.MAX_STARS), idx: new Int32Array(Field.MAX_STARS), n: 0 };

		function heapPush(d2, idx) {
			const hd = heap.d2, hi = heap.idx;
			let i = heap.n++;
			while (i > 0) {
				const p = (i - 1) >> 1;
				if (hd[p] >= d2) break;
				hd[i] = hd[p]; hi[i] = hi[p];
				i = p;
			}
			hd[i] = d2; hi[i] = idx;
		}

		function heapSift(d2, idx, n) {
			const hd = heap.d2, hi = heap.idx;
			let i = 0;
			for (;;) {
				let c = i * 2 + 1;
				if (c >= n) break;
				if (c + 1 < n && hd[c + 1] > hd[c]) c++;
				if (hd[c] <= d2) break;
				hd[i] = hd[c]; hi[i] = hi[c];
				i = c;
			}
			hd[i] = d2; hi[i] = idx;
		}

		// Rebuild the compact list from the blocks: every visible record of every
		// block — the field the sprite pass draws is the field "nearest" means.
		// The birth words stay in the staging view; `cur` starts at birth.
		function syncSky(info) {
			const view = info && info.view;
			const list = (info && info.blocks) || [];
			sky.version = info ? info.dynamicVersion : -1;
			sky.total = info ? (info.total | 0) : 0;
			sky.view = view && list.length ? view : null;
			sky.n = 0;
			sky.curTime = 0;
			sky.sweeping = false;
			sky.cursor = 0;
			sky.landmarkBase = -1;
			sky.landmarkCount = 0;
			setDirty = true;
			if (!sky.view) return;
			for (let b = 0; b < list.length; b++) {
				if (list[b].kind === LANDMARK_BLOCK) {
					sky.landmarkBase = list[b].offset | 0;
					sky.landmarkCount = list[b].count | 0;
					break;
				}
			}
			let total = 0;
			for (let b = 0; b < list.length; b++) total += list[b].count | 0;
			if (sky.slot.length < total) {
				sky.slot = new Int32Array(total + 1024);
				sky.cur = new Float32Array((total + 1024) * 3);
			}
			const slot = sky.slot, cur = sky.cur;
			let n = 0;
			for (let b = 0; b < list.length; b++) {
				const first = list[b].offset | 0;
				const end = first + (list[b].count | 0);
				for (let s = first; s < end; s++) {
					const offBytes = s * RECORD_BYTES;
					const packed = view.getUint32(offBytes + 12, true);
					if ((packed & 0x00010000) === 0) continue;   // FLAG_VISIBLE
					slot[n] = s;
					cur[n * 3] = view.getFloat32(offBytes, true);
					cur[n * 3 + 1] = view.getFloat32(offBytes + 4, true);
					cur[n * 3 + 2] = view.getFloat32(offBytes + 8, true);
					n++;
				}
			}
			sky.n = n;
		}

		// One slice of the whole-sky dispatch. Every entry is written at the
		// sweep's own target time, so a completed sweep is one consistent frame
		// of the drawn sky — the query then measures exactly what the picture
		// shows at `curTime`.
		function advanceSkySlice(model) {
			const view = sky.view;
			if (!view || sky.n === 0 || sky.cursor >= sky.n) return;
			const slot = sky.slot, cur = sky.cur;
			const t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
			const p = advanceScratch;
			const time = sky.sweepTo;
			const base = sky.landmarkBase, count = sky.landmarkCount;
			let i = sky.cursor;
			while (i < sky.n) {
				const s = slot[i];
				const offBytes = s * RECORD_BYTES;
				const packed = view.getUint32(offBytes + 12, true);
				const bx = view.getFloat32(offBytes, true);
				const by = view.getFloat32(offBytes + 4, true);
				const bz = view.getFloat32(offBytes + 8, true);
				if (base >= 0 && s >= base && s < base + count) {
					Orbit.engineLandmarkPosition(p, s - base, bx, by, bz, packed & 0xFF, time, model);
				} else {
					Orbit.engineRecordPosition(p, bx, by, bz, packed, time, model);
				}
				cur[i * 3] = p[0]; cur[i * 3 + 1] = p[1]; cur[i * 3 + 2] = p[2];
				i++;
				// The slice is time-budgeted: a 500 k sky spreads over ~20 frames
				// instead of stalling one, and a small sky finishes in a single frame.
				if ((i & 1023) === 0
						&& (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0 > SLICE_MS) break;
			}
			sky.cursor = i;
			if (sky.cursor >= sky.n) {
				sky.curTime = sky.sweepTo;
				sky.sweeping = false;
				setDirty = true;
			}
		}
		const advanceScratch = new Float64Array(3);

		// Keep `cur` at the drawn sky: star time moving (or a rebuilt residency)
		// opens a sweep; the sweep itself is sliced. The throttle is the island's
		// INDEX_PERIOD — one dispatch of the whole sky per quarter second at most.
		function advanceSky(dt, env, model) {
			const target = env.starTimeMyr;
			if (sky.sweeping) {
				advanceSkySlice(model);
				return;
			}
			if (target === sky.curTime) return;
			sky.clock += dt;
			if (sky.clock < SWEEP_PERIOD) return;
			sky.clock = 0;
			sky.sweeping = true;
			sky.sweepTo = target;
			sky.cursor = 0;
		}

		// ---- picks ------------------------------------------------------------
		// Nearest-N is a query, not a set built once: the eye moving 2% of the
		// set's own far edge (or 50 pc, the island's floor) re-picks; a completed
		// sweep re-picks at PICK_PERIOD; a selection edit always re-picks. The
		// fixed constellation set is never re-picked — but a nearest set falls
		// back into play even under the constellations source (a procedural
		// galaxy has no named sky), which is what the pickSet identity tests.
		function needPick(stamp) {
			if (setDirty || !stateSet || !stateSet.n) return true;
			if (settings.source === 'selected' && stamp !== selStamp) return true;
			if (stateSet !== pickSet) return false;      // the fixed landmark set
			if (settings.source === 'selected') return false;
			// A sweep in flight is rewriting `cur`: hold the pick until it lands
			// (completion re-picks), so the query never measures a half-moved sky.
			if (sky.sweeping) return false;
			const moved = Math.hypot(eye[0] - pickPos[0], eye[1] - pickPos[1], eye[2] - pickPos[2]);
			if (moved > Math.max(0.05, (stateSet.dmax || 1) * 0.02)) return true;
			return pickClock > PICK_PERIOD && sky.curTime !== pickTime;
		}

		function selectionStamp() {
			const sel = selectionOf && selectionOf();
			if (!sel || !sel.count) return 0;
			let stamp = (sel.count | 0) ^ ((sel.primary | 0) << 16);
			for (let i = 0; i < sel.count; i++) stamp = (stamp * 31 + (sel.keys[i] >>> 0)) | 0;
			return stamp;
		}

		function fillNamesFrom(set) {
			for (let i = 0; i < set.n; i++) {
				const li = set.landmarkIdx[i];
				pickNames[i] = li >= 0 ? landmarks.ENTRIES[li].name : '';
			}
			set.names = pickNames;
		}

		// The store's slot hint is only a hint (it lives until the caller's next
		// key resolution); identity[slot] is the truth. A wrong hint falls back to
		// one linear scan — the rare case, and only for that member.
		function slotOfKey(identity, key, hint, info) {
			const total = info.total | 0;
			const want = key >>> 0;
			if (hint >= 0 && hint < total && identity[hint] === want) return hint;
			for (let s = 0; s < total; s++) if (identity[s] === want) return s;
			return -1;
		}

		// Copy one staging slot's birth words into set entry `n`, with the
		// landmark dispatch index the sprite pass would use for it.
		function copySlotInto(view, slot, set, n) {
			const offBytes = slot * RECORD_BYTES;
			set.positions[n * 3] = view.getFloat32(offBytes, true);
			set.positions[n * 3 + 1] = view.getFloat32(offBytes + 4, true);
			set.positions[n * 3 + 2] = view.getFloat32(offBytes + 8, true);
			const packed = view.getUint32(offBytes + 12, true);
			set.packed[n] = packed;
			set.colorIndex[n] = packed & 0xFF;
			set.landmarkIdx[n] = slot >= sky.landmarkBase && slot < sky.landmarkBase + sky.landmarkCount
				? slot - sky.landmarkBase : -1;
		}

		// Exact nearest-N over the drawn sky: one linear pass of `sky.cur` with
		// the fixed max-heap, then the winners' birth records out of the view.
		// The list lands nearest-first (the pops write farthest at the end).
		function fillNearest() {
			const want = clamp(settings.anchors | 0, 1, 500);
			const view = sky.view;
			pickSet.n = 0;
			pickSet.landmark = false;
			pickSet.segments = null;
			pickSet.source = 'nearest';
			pickSet.excludedCenter = false;
			if (!view || sky.n === 0) return;

			// When C has put the camera in orbit around the selected primary, that
			// star is a special case: it can be orders of magnitude closer than the
			// surrounding sky, and the map is meant to describe that sky, not the
			// system currently being visited. Leave it out of the nearest-anchor
			// set; the selected source still includes it when explicitly requested.
			let centerKey = -1;
			if (camera.getState && selectionOf) {
				const cam = camera.getState(cameraState);
				const sel = selectionOf();
				if (cam.modeName === 'orbit object' && sel && sel.primary >= 0 && sel.primary < sel.count) {
					centerKey = sel.keys[sel.primary] >>> 0;
				}
			}
			const info = blocksOf();
			const identity = info && info.identity;
			const n = Math.min(want, sky.n, pickSet.capacity);
			const cur = sky.cur;
			heap.n = 0;
			for (let i = 0; i < sky.n; i++) {
				if (centerKey >= 0 && identity && identity[sky.slot[i]] === centerKey) {
					pickSet.excludedCenter = true;
					continue;
				}
				const dx = cur[i * 3] - eye[0];
				const dy = cur[i * 3 + 1] - eye[1];
				const dz = cur[i * 3 + 2] - eye[2];
				const d2 = dx * dx + dy * dy + dz * dz;
				if (heap.n < n) heapPush(d2, i);
				else if (d2 < heap.d2[0]) heapSift(d2, i, n);
			}
			const picked = Math.min(n, heap.n);
			let dmin2 = Infinity, dmax2 = 0;
			for (let k = picked - 1; k >= 0; k--) {
				const d2 = heap.d2[0], src = heap.idx[0];
				if (d2 < dmin2) dmin2 = d2;
				if (d2 > dmax2) dmax2 = d2;
				copySlotInto(view, sky.slot[src], pickSet, k);
				heap.n--;
				if (heap.n > 0) heapSift(heap.d2[heap.n], heap.idx[heap.n], heap.n);
			}
			pickSet.n = picked;
			pickSet.dmin = picked ? Math.sqrt(dmin2) : 0;
			pickSet.dmax = picked ? Math.sqrt(dmax2) : 0;
			fillNamesFrom(pickSet);
		}

		// Selected members resolved against the resident blocks by identity key.
		// A member whose key is no longer resident is dropped: a snapshot the sky
		// has forgotten would draw a star the frame no longer shows.
		function fillSelected() {
			const sel = selectionOf();
			const info = blocksOf();
			const view = info && info.view;
			const identity = info && info.identity;
			pickSet.n = 0;
			pickSet.landmark = false;
			pickSet.segments = null;
			pickSet.source = 'selected';
			pickSet.excludedCenter = false;
			if (!sel || !sel.count || !view || !identity) return;
			let n = 0;
			for (let i = 0; i < sel.count && n < pickSet.capacity; i++) {
				const slot = slotOfKey(identity, sel.keys[i], sel.bufferIdx ? sel.bufferIdx[i] : -1, info);
				if (slot < 0) continue;
				const offBytes = slot * RECORD_BYTES;
				if ((view.getUint32(offBytes + 12, true) & 0x00010000) === 0) continue;
				copySlotInto(view, slot, pickSet, n);
				n++;
			}
			pickSet.n = n;
			fillNamesFrom(pickSet);
		}

		function pickAnchors() {
			// Self-contained: a pick is correct from the current camera even when
			// it runs outside the frame (tests, a control change mid-frame).
			eye[0] = camera.cameraPos[0]; eye[1] = camera.cameraPos[1]; eye[2] = camera.cameraPos[2];
			if (settings.source === 'selected') {
				fillSelected();
			} else if (settings.source === 'constellations' && landmarks.count) {
				if (!constSet) constSet = Field.buildConstellationSet({ landmarks });
				stateSet = constSet;
				return adopt();
			} else {
				fillNearest();
			}
			stateSet = pickSet;
			adopt();
		}

		function adopt() {
			pickPos[0] = eye[0]; pickPos[1] = eye[1]; pickPos[2] = eye[2];
			pickTime = sky.curTime;
			pickClock = 0;
			setDirty = false;
		}

		// ---- display range ----------------------------------------------------
		// The shared following law (Field.offerRange / easeRange): every 4 Hz
		// offer becomes the target at once and the display eases to it, fast for a
		// correction the window almost fits and rate-capped while it is far from
		// one — so a lone unsettled read nudges the colours instead of flattening
		// them, and nothing has to wait for reads to agree before the map follows
		// a pan. Unchecking auto freezes the colours where they are.
		function refreshAutoRange() {
			if (stats.empty) return;
			const a = Field.autoRange(settings.mode, stats, autoRangeScratch);
			Field.offerRange(live, settings.mode, a.lo, a.hi);
		}

		function manualRange() {
			let r = ranges[settings.mode];
			if (!r) {
				const d = MANUAL_DEFAULTS[settings.mode] || MANUAL_DEFAULTS.height;
				r = ranges[settings.mode] = { lo: d.lo, hi: d.hi };
			}
			return r;
		}

		// ---- painting ---------------------------------------------------------
		function ensureOff(w, h) {
			if (!off) {
				off = document.createElement('canvas');
				offCtx = off.getContext('2d');
			}
			if (off.width !== w || off.height !== h) {
				off.width = w; off.height = h;
				offCtx = off.getContext('2d');
			}
			return offCtx;
		}

		function frustumCorners(aspect) {
			const b = basis;
			const ty = Math.tan(camera.fovY * 0.5);
			const tx = ty * aspect;
			for (let i = 0; i < 4; i++) {
				const sx = VIEW_SIGNS[i][0] * tx, sy = VIEW_SIGNS[i][1] * ty;
				cornerDir[0] = b.fx + b.rx * sx + b.ux * sy;
				cornerDir[1] = b.fy + b.ry * sx + b.uy * sy;
				cornerDir[2] = b.fz + b.rz * sx + b.uz * sy;
				const l = Math.hypot(cornerDir[0], cornerDir[1], cornerDir[2]) || 1;
				viewBox[i][0] = cornerDir[0] / l; viewBox[i][1] = cornerDir[1] / l; viewBox[i][2] = cornerDir[2] / l;
			}
			return viewBox;
		}

		function drawLegend(target, ramp) {
			const opts = { ramp: ramp || Renderer.resolveRamp(settings.mode, settings.ramp) };
			const anchors = `${live.setN} anchors (${live.setSource})`;
			const how = settings.autoRange ? 'auto' : 'manual';
			if (settings.mode === 'height') {
				opts.title = 'mode 1 · distance from eye';
				// Height's range lo is the NEAR end (small log distance) and hi the
				// far one, because the raw value is log distance and the ramp is
				// inverted: far is the bottom colour.
				opts.low = 'far ' + Renderer.formatDistance(Math.pow(10, live.hi));
				opts.high = 'close ' + Renderer.formatDistance(Math.pow(10, live.lo));
				opts.note = `${anchors} · IDW σ ${settings.sigmaDeg}°`;
				opts.note2 = `${how} range · log10 of the distance`;
			} else if (settings.mode === 'spread') {
				opts.title = 'mode 2 · depth spread';
				opts.low = 'flat ≤ ' + Renderer.formatDistance(Math.pow(10, live.lo));
				opts.high = '≥ ' + Renderer.formatDistance(Math.pow(10, live.hi));
				opts.note = `${anchors} · peak ${Renderer.formatDistance(stats.spreadMax)}`;
				opts.note2 = `${how} range · log σ of |star−eye|`;
			} else {
				opts.title = 'mode 3 · slope of log distance';
				opts.low = 'flat ≤ ' + Renderer.formatRangeValue('gradient', live.lo);
				opts.high = '≥ ' + Renderer.formatRangeValue('gradient', live.hi);
				opts.note = `${anchors}`;
				opts.note2 = `${how} range · log · no hard top`;
			}
			Renderer.renderLegend(target, settings.mode, opts);
		}

		function paintFrame(w, h, aspect, rect) {
			const blended = settings.opacity < 1;
			const target = blended ? ensureOff(w, h) : ctx;
			paintOpts.mode = settings.mode;
			paintOpts.rect = rect;
			paintOpts.ramp = Renderer.resolveRamp(settings.mode, settings.ramp);
			paintOpts.relief = settings.relief;
			paintOpts.positions = settings.drawStars && stateSet ? drawn : null;
			paintOpts.eye = eye;
			paintOpts.set = stateSet;
			paintOpts.drawContours = settings.contours;
			paintOpts.drawGrid = settings.grid;
			paintOpts.drawNames = settings.names;
			paintOpts.invert = settings.invert;
			paintOpts.smooth = settings.smooth;
			paintOpts.viewBox = settings.projection === 'plane' ? frustumCorners(aspect) : null;
			Renderer.renderField(target, field, layout, paintOpts);
			drawLegend(target, paintOpts.ramp);
			if (blended) {
				ctx.clearRect(0, 0, w, h);
				ctx.globalAlpha = settings.opacity;
				ctx.drawImage(off, 0, 0);
				ctx.globalAlpha = 1;
			}
		}

		// ---- the frame --------------------------------------------------------
		// The island's frame, one-for-one: eye and basis from the camera, the sky
		// advance and the pick, the set at the live star time, then the layout
		// (chart quat → letterbox → createLayout), the field and the paint.
		function step(dt, env) {
			const on = settings.mode !== 'off' && !env.hidden;
			if (on !== lastOn) {
				lastOn = on;
				canvas.style.display = on ? 'block' : 'none';
			}
			if (!on) return;

			const dpr = Math.min(2, env.dpr || 1);
			const iw = Math.max(64, Math.floor(env.width * dpr));
			const ih = Math.max(64, Math.floor(env.height * dpr));
			if (canvas.width !== iw || canvas.height !== ih) {
				canvas.width = iw; canvas.height = ih;
			}

			eye[0] = camera.cameraPos[0]; eye[1] = camera.cameraPos[1]; eye[2] = camera.cameraPos[2];
			basis.fx = camera.forward[0]; basis.fy = camera.forward[1]; basis.fz = camera.forward[2];
			basis.rx = camera.right[0]; basis.ry = camera.right[1]; basis.rz = camera.right[2];
			basis.ux = camera.up[0]; basis.uy = camera.up[1]; basis.uz = camera.up[2];

			const model = modelOf();
			const info = blocksOf();
			if (!info || info.dynamicVersion !== sky.version || (info.total | 0) !== sky.total) syncSky(info);
			advanceSky(dt, env, model);

			pickClock += dt;
			const stamp = selectionStamp();
			if (needPick(stamp)) {
				selStamp = stamp;
				pickAnchors();
			}
			const set = stateSet;
			live.setN = set ? set.n : 0;
			live.setSource = !set || !set.n ? '—'
				: set === constSet ? 'constellations'
				: (SOURCE_LABELS[set.source] || set.source)
					+ (set.excludedCenter ? ' · orbit target excluded' : '');
			if (!set || !set.n) {
				ctx.clearRect(0, 0, iw, ih);
				return;
			}

			// The map is redrawn at the frame's own star time — the same dispatch
			// the vertex stage mirrors — so the anchors cannot drift from the sky.
			Field.advancePositions(set, drawn, env.starTimeMyr, model);

			const aspect = iw / Math.max(1, ih);
			const budget = PAIRS_BUDGET[settings.budget] || PAIRS_BUDGET.balanced;
			let h = settings.resH ? Math.max(16, Math.min(512, settings.resH | 0))
				: Field.autoResolution(budget, set.n || 1, aspect);
			let w = Math.max(16, Math.min(1024, Math.round(h * aspect / 8) * 8));
			// Centre the chart on the look direction: the pan quaternion maps the
			// world so that the view centre sits at lon 0 / lat 0 of the equirect
			// window.
			if (settings.projection === 'plane' && settings.followLook) {
				Field.quatArc(chartQuat, basis.fx, basis.fy, basis.fz, 1, 0, 0);
			}
			// A chart wider in latitude than the window can hold keeps its
			// degrees-per-texel — it drops rows instead of squashing them (island).
			let rect = null;
			if (settings.projection === 'plane' && settings.chartSpanDeg * h / w > 180) {
				h = Math.max(16, Math.floor(180 * w / settings.chartSpanDeg / 8) * 8);
				const rh = Math.min(ih, iw * h / w);
				rect = letterbox;
				letterbox.x = 0; letterbox.y = (ih - rh) / 2; letterbox.w = iw; letterbox.h = rh;
			}
			const lo = layoutOpts;
			lo.w = w; lo.h = h;
			if (settings.projection === 'plane') {
				lo.kind = 'plane'; lo.spanDeg = settings.chartSpanDeg;
				lo.quat = chartQuat; lo.mirror = settings.mirrorChart;
			} else {
				lo.kind = 'view';
				// The *window's* aspect, so the field covers exactly the angles the
				// app renders and a marker cannot slide off its star.
				lo.fovY = camera.fovY; lo.aspect = aspect; lo.basis = basis;
			}
			Field.createLayout(layout, lo);
			if (!raw || raw.length < w * h) {
				raw = new Float32Array(w * h);
				field = new Float32Array(w * h);
			}
			const nTexels = w * h;

			const stars = Field.prepareStars(drawn, set.n, eye[0], eye[1], eye[2]);
			rangeClock += dt;
			// The range suggestion is only read a few times a second; the field is
			// rebuilt every frame.
			const measure = settings.autoRange && (rangeClock >= RANGE_PERIOD || live.mode !== settings.mode);
			fieldOpts.mode = settings.mode;
			fieldOpts.sigmaDeg = settings.sigmaDeg;
			fieldOpts.measure = measure;
			const t0 = performance.now();
			Field.computeRaw(stars, layout, fieldOpts, raw, stats);
			live.fieldMs = performance.now() - t0;
			live.pairs = stats.pairs;

			if (settings.autoRange) {
				if (measure) { rangeClock = 0; refreshAutoRange(); }
				Field.easeRange(live, dt);
			} else {
				const r = manualRange();
				Field.resetRange(live, settings.mode, r.lo, r.hi);
			}
			Field.applyRange(raw, nTexels, settings.mode, live, field);
			paintFrame(iw, ih, aspect, rect);
		}

		// ---- controls ---------------------------------------------------------
		function setMode(mode) {
			settings.mode = MODES.indexOf(mode) >= 0 ? mode : 'off';
			rangeClock = RANGE_PERIOD;   // force a fresh range read next frame
		}

		function set(next) {
			const s = next || {};
			if (s.mode !== undefined) setMode(s.mode);
			if (s.projection !== undefined) settings.projection = s.projection === 'plane' ? 'plane' : 'view';
			if (s.source !== undefined) {
				settings.source = SOURCE_LABELS[s.source] ? s.source : 'constellations';
				setDirty = true;
			}
			if (s.anchors !== undefined) {
				settings.anchors = clamp(Math.round(s.anchors) || 1, 1, 500);
				setDirty = true;
			}
			if (s.sigmaDeg !== undefined) settings.sigmaDeg = clamp(s.sigmaDeg, 1, 20);
			if (s.budget !== undefined && PAIRS_BUDGET[s.budget]) {
				settings.budget = s.budget;
				settings.resH = 0;
			}
			if (s.resH !== undefined) settings.resH = clamp(Math.round(s.resH), 0, 512);
			if (s.ramp !== undefined) settings.ramp = String(s.ramp || 'auto');
			if (s.relief !== undefined) settings.relief = clamp(s.relief, 0, 30);
			if (s.opacity !== undefined) settings.opacity = clamp(s.opacity, 0, 1);
			if (s.contours !== undefined) settings.contours = !!s.contours;
			if (s.grid !== undefined) settings.grid = !!s.grid;
			if (s.drawStars !== undefined) settings.drawStars = !!s.drawStars;
			if (s.names !== undefined) settings.names = !!s.names;
			if (s.smooth !== undefined) settings.smooth = !!s.smooth;
			if (s.invert !== undefined) settings.invert = !!s.invert;
			if (s.followLook !== undefined) settings.followLook = !!s.followLook;
			if (s.mirrorChart !== undefined) settings.mirrorChart = !!s.mirrorChart;
			if (s.chartSpanDeg !== undefined) settings.chartSpanDeg = clamp(Math.round(s.chartSpanDeg), 15, 360);
			if (s.autoRange !== undefined) setAutoRange(!!s.autoRange);
			return settings;
		}

		function cycleMode() {
			setMode(MODES[(MODES.indexOf(settings.mode) + 1) % MODES.length]);
			return settings.mode;
		}

		// Unchecking auto freezes the colours where they are; the manual sliders
		// then edit the frozen pair.
		function setAutoRange(on) {
			if (settings.autoRange && !on) {
				const r = manualRange();
				r.lo = live.lo;
				r.hi = live.hi;
			}
			settings.autoRange = !!on;
		}

		function setRange(which, value) {
			if (!Number.isFinite(value)) return;
			if (settings.autoRange) setAutoRange(false);
			const r = manualRange();
			if (which === 'lo') r.lo = value;
			else r.hi = value;
			if (r.hi <= r.lo) {
				if (which === 'lo') r.hi = r.lo + 0.05;
				else r.lo = r.hi - 0.05;
			}
			Field.resetRange(live, settings.mode, r.lo, r.hi);
		}

		function statusLine() {
			const how = settings.autoRange ? 'auto' : 'manual';
			let rangeLine;
			if (settings.mode === 'height') {
				rangeLine = `${how} · near ${Renderer.formatDistance(Math.pow(10, live.lo))}`
					+ ` … far ${Renderer.formatDistance(Math.pow(10, live.hi))}`;
			} else if (settings.mode === 'spread') {
				rangeLine = `${how} · flat ${Renderer.formatDistance(Math.pow(10, live.lo))}`
					+ ` … deep ${Renderer.formatDistance(Math.pow(10, live.hi))}`;
			} else if (settings.mode === 'gradient') {
				rangeLine = `${how} · flat ${Renderer.formatRangeValue('gradient', live.lo)}`
					+ ` … steep ${Renderer.formatRangeValue('gradient', live.hi)}`;
			} else {
				rangeLine = 'off';
			}
			return `${live.setN} anchors (${live.setSource}) · ${rangeLine}\n`
				+ `field ${layout.w}×${layout.h} · ${(live.pairs / 1e6).toFixed(2)} M pairs · ${live.fieldMs.toFixed(1)} ms`;
		}

		return {
			step, set, setMode, cycleMode,
			setAutoRange, setRange,
			statusLine,
			settings, live,
			formatRange: (logValue) => Renderer.formatRangeValue(settings.mode, logValue),
			// Live internals, for tests only.
			internal: {
				basis, layout, sky, pickSet, drawn, stats, ranges, chartQuat,
				syncSky, pickAnchors, fillNearest, fillSelected,
			},
		};
	}

	const ViewModesLayer = {
		createViewModesLayer,
		PAIRS_BUDGET, MANUAL_DEFAULTS, MODES,
		// The panel's boot defaults, read by readParams and presets.menuDefaults.
		DEFAULTS: {
			mode: 'off',
			projection: 'view',
			source: 'nearest',
			anchors: 256,
			ramp: 'auto',
			relief: 6,
			opacity: 1,
		},
	};
	if (typeof module !== 'undefined') module.exports = ViewModesLayer;
	if (typeof window !== 'undefined') window.ViewModesLayer = ViewModesLayer;

})();
