// src/math/field-overlay.js
// The main render's field overlay, CPU half (archive/view-modes-shader-plan.md,
// "View Modes Shader.5"). The GPU half is FIELD_SPLAT + FIELD_BLUR +
// FIELD_COMPOSITE in src/render/shaders.js; this file is the pure part: the
// display range sampled from the renderer's own star blocks, the splat radius,
// the uniform layouts and the mode vocabulary.
//
// The overlay is not a second star set. It reads every block the sprite pass
// draws — procedural, landmarks, objects, local gap-fill, catalog — and the
// vertex stage reconstructs the drawn position with the same orbit dispatch,
// so the field exists at any star count, in hybrid and game mode alike.
//
// The range is physical and declared, never a per-frame renormalisation of the
// picture: the island's rule, applied to a bounded sample of the live records.

'use strict';

(function () {
	// Mode ids are the composite uniform's first float; 0 skips both field
	// passes. Mirrored by FIELD_COMPOSITE (wgsl-validate pins the list).
	const MODE_OFF = 0, MODE_HEIGHT = 1, MODE_SPREAD = 2, MODE_SLOPE = 3;
	const MODE_NAMES = ['off', 'height', 'spread', 'slope'];
	const MODE_TITLES = ['off', 'distance', 'depth spread', 'slope'];
	const MODE_IDS = { off: MODE_OFF, height: MODE_HEIGHT, spread: MODE_SPREAD, slope: MODE_SLOPE };

	// The field never trusts a distance below 1 pc: one star the camera sits on
	// (the Sun, 5 pc under the home pose) would otherwise own the whole ramp.
	const MIN_DIST_KPC = 0.001;
	const RANGE_FLOOR = 1e-6;          // 0.001 dex / 1 µdex per degree

	// Field texture size: half the canvas, clamped. The composite upscales with
	// the ramp LUT's bilinear sampler; the splat radius adapts to the star count
	// so a sparse sky still fills the map and a dense one does not overdraw.
	const FIELD_MIN_W = 256;
	const FIELD_MAX_W = 640;
	const FIELD_MIN_H = 128;
	const SPLAT_SPACING = 1.2;         // footprint radius in mean inter-star spacings
	const SPLAT_MIN_PX = 2.5;
	const SPLAT_MAX_PX = 40;

	// Display range: the island's padding rule (4% of the span + 0.02, 0.3 dex
	// floor), applied to a sample small enough to sort every refresh.
	const RANGE_SAMPLE_CAP = 256;
	const NEIGHBOURS = 6;
	const RANGE_PAD_FRAC = 0.04;
	const RANGE_PAD_DEX = 0.02;
	const RANGE_MIN_SPAN = 0.3;
	const HEIGHT_PERCENTILES = [0.02, 0.98];
	const DERIVED_PERCENTILES = [0.05, 0.95];
	const RAD2DEG = 180 / Math.PI;

	// Fewer than three visible records: a fixed window the legend can quote.
	// [lo, hi] in each mode's display unit (height: log10 kpc far→near;
	// spread: log10 σ in dex; slope: log10 dex/°).
	const FALLBACK_RANGES = {
		height: [-2, 1],
		spread: [-1.3, 0.2],
		slope: [-1.5, 0.3],
	};

	const DEFAULTS = { mode: MODE_OFF, opacity: 0.55, ramp: 'auto', relief: 0.6, contours: 8 };
	const MIN_OPACITY = 0, MAX_OPACITY = 1;
	const MIN_RELIEF = 0, MAX_RELIEF = 1;
	const MAX_CONTOURS = 12;

	function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
	function clampOpacity(v) { return clamp(+v || 0, MIN_OPACITY, MAX_OPACITY); }
	function clampRelief(v) { return clamp(+v || 0, MIN_RELIEF, MAX_RELIEF); }
	function clampContours(v) { return clamp(Math.round(+v || 0), 0, MAX_CONTOURS); }

	function modeOf(value) {
		if (typeof value === 'number') return clamp(value | 0, MODE_OFF, MODE_SLOPE);
		const id = MODE_IDS[String(value || '').toLowerCase()];
		return id === undefined ? MODE_OFF : id;
	}

	// One state per renderer, every buffer allocated once. The scratch arrays
	// are the size of the sample, not of the star set.
	function createRangeState() {
		return {
			count: 0,
			mode: MODE_OFF,
			// Sample scratch, written by sample().
			positions: new Float64Array(RANGE_SAMPLE_CAP * 3),
			dirs: new Float32Array(RANGE_SAMPLE_CAP * 3),
			logD: new Float32Array(RANGE_SAMPLE_CAP),
			spread: new Float32Array(RANGE_SAMPLE_CAP),
			slope: new Float32Array(RANGE_SAMPLE_CAP),
			scratch: new Float32Array(RANGE_SAMPLE_CAP),
			// Resolved display windows, one per mode, so a mode switch is a copy
			// rather than a re-sample.
			ranges: {
				height: { lo: FALLBACK_RANGES.height[0], hi: FALLBACK_RANGES.height[1] },
				spread: { lo: FALLBACK_RANGES.spread[0], hi: FALLBACK_RANGES.spread[1] },
				slope: { lo: FALLBACK_RANGES.slope[0], hi: FALLBACK_RANGES.slope[1] },
			},
			lo: FALLBACK_RANGES.height[0],
			hi: FALLBACK_RANGES.height[1],
			unit: 'kpc',
			samples: 0,
			// The last refresh's camera/time, so the renderer's 4 Hz caller can
			// skip a sample that would repeat the last one.
			lastX: 0, lastY: 0, lastZ: 0, lastTime: 0, fresh: false,
		};
	}

	function percentile(sorted, n, p) {
		if (n <= 0) return 0;
		let i = Math.round(p * (n - 1));
		if (i < 0) i = 0; else if (i >= n) i = n - 1;
		return sorted[i];
	}

	// Pad a raw [a, b] into a display window; the island's rule, shared with
	// the auto range. `a` and `b` are in the display unit already.
	function padRange(out, a, b) {
		if (!(b > a)) { b = a + RANGE_MIN_SPAN; }
		const pad = RANGE_PAD_FRAC * (b - a) + RANGE_PAD_DEX;
		out.lo = a - pad;
		out.hi = b + pad;
		if (out.hi - out.lo < RANGE_MIN_SPAN) {
			const c = (out.lo + out.hi) * 0.5;
			out.lo = c - RANGE_MIN_SPAN * 0.5;
			out.hi = c + RANGE_MIN_SPAN * 0.5;
		}
		return out;
	}

	const outPos = new Float64Array(3);
	const bestDot = new Float64Array(NEIGHBOURS);
	const bestIdx = new Int32Array(NEIGHBOURS);

	// Walk every block on one global stride, resolve the drawn position through
	// the shared orbit dispatch (the picker's law), and fill the sample. Returns
	// the number of visible records collected.
	function sample(state, env) {
		const blocks = env.blocks;
		const info = blocks && blocks.blocks ? blocks : { view: null, blocks: [] };
		const view = info.view;
		const list = info.blocks || [];
		if (!view || !list.length) { state.count = 0; return 0; }
		const recordBytes = env.recordBytes || 16;
		const orbit = env.orbit;
		const model = env.model;
		const time = env.time || 0;
		const cx = env.camX || 0, cy = env.camY || 0, cz = env.camZ || 0;
		let total = 0;
		for (let b = 0; b < list.length; b++) total += list[b].count | 0;
		const stride = Math.max(1, Math.ceil(total / RANGE_SAMPLE_CAP));
		let n = 0;
		for (let b = 0; b < list.length && n < RANGE_SAMPLE_CAP; b++) {
			const block = list[b];
			const first = block.offset | 0;
			const end = first + (block.count | 0);
			let slot = first + ((stride - (first % stride)) % stride);
			for (; slot < end && n < RANGE_SAMPLE_CAP; slot += stride) {
				const off = slot * recordBytes;
				const packed = view.getUint32(off + 12, true);
				// FLAG_VISIBLE lives in bits 16-23; skip zero slots and thinned
				// catalog records, exactly as the sprite vertex stage does.
				if ((packed & 0x00010000) === 0) continue;
				const bx = view.getFloat32(off, true);
				const by = view.getFloat32(off + 4, true);
				const bz = view.getFloat32(off + 8, true);
				let x = bx, y = by, z = bz;
				if (orbit && orbit.engineRecordPosition) {
					orbit.engineRecordPosition(outPos, bx, by, bz, packed, time, model);
					x = outPos[0]; y = outPos[1]; z = outPos[2];
				}
				const dx = x - cx, dy = y - cy, dz = z - cz;
				const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
				const inv = d > 1e-9 ? 1 / d : 0;
				state.positions[n * 3] = x;
				state.positions[n * 3 + 1] = y;
				state.positions[n * 3 + 2] = z;
				state.dirs[n * 3] = dx * inv;
				state.dirs[n * 3 + 1] = dy * inv;
				state.dirs[n * 3 + 2] = dz * inv;
				state.logD[n] = Math.log10(Math.max(d, MIN_DIST_KPC));
				n++;
			}
		}
		state.count = n;
		state.samples = n;
		state.lastX = cx; state.lastY = cy; state.lastZ = cz; state.lastTime = time;
		state.fresh = true;
		return n;
	}

	// The two derived estimators, over the same sample: the log-distance σ of
	// each star's angular neighbourhood (mode 2) and the nearest-neighbour
	// |Δlog d| / Δangle in dex per degree (mode 3). O(n²) with n ≤ 256.
	function derive(state) {
		const n = state.count;
		const dirs = state.dirs, logD = state.logD;
		let spreadMax = 0;
		for (let i = 0; i < n; i++) {
			for (let k = 0; k < NEIGHBOURS; k++) { bestDot[k] = -2; bestIdx[k] = -1; }
			const ix = dirs[i * 3], iy = dirs[i * 3 + 1], iz = dirs[i * 3 + 2];
			for (let j = 0; j < n; j++) {
				if (j === i) continue;
				const dot = ix * dirs[j * 3] + iy * dirs[j * 3 + 1] + iz * dirs[j * 3 + 2];
				// Fixed insertion into a tiny descending best-list: the sample is
				// 256 entries, so this is cheaper than a sort per star.
				for (let k = 0; k < NEIGHBOURS; k++) {
					if (dot <= bestDot[k]) continue;
					for (let m = NEIGHBOURS - 1; m > k; m--) {
						bestDot[m] = bestDot[m - 1];
						bestIdx[m] = bestIdx[m - 1];
					}
					bestDot[k] = dot;
					bestIdx[k] = j;
					break;
				}
			}
			if (bestIdx[0] < 0) { state.spread[i] = 0; state.slope[i] = 0; continue; }
			let sum = logD[i], sum2 = logD[i] * logD[i], used = 1;
			for (let k = 0; k < NEIGHBOURS; k++) {
				const j = bestIdx[k];
				if (j < 0) break;
				sum += logD[j];
				sum2 += logD[j] * logD[j];
				used++;
			}
			const mean = sum / used;
			let variance = sum2 / used - mean * mean;
			if (variance < 0) variance = 0;
			state.spread[i] = Math.sqrt(variance);
			if (state.spread[i] > spreadMax) spreadMax = state.spread[i];
			// The nearest neighbour's angular separation: the chord gap
			// 2(1−dot) ≈ θ², with acos for the honest endpoints.
			const dot = clamp(bestDot[0], -1, 1);
			const angle = Math.acos(dot);
			const j = bestIdx[0];
			const slope = Math.abs(logD[j] - logD[i]) / Math.max(angle, 1e-4) * RAD2DEG;
			state.slope[i] = slope;
		}
	}

	function logFloor(v) {
		return Math.log10(Math.max(v, RANGE_FLOOR));
	}

	// Resolve all three windows from the current sample. Called once per
	// refresh; a mode switch only copies the matching window into lo/hi.
	function resolveRanges(state) {
		const n = state.count;
		const scratch = state.scratch;
		const ranges = state.ranges;
		if (n < 3) {
			ranges.height.lo = FALLBACK_RANGES.height[0]; ranges.height.hi = FALLBACK_RANGES.height[1];
			ranges.spread.lo = FALLBACK_RANGES.spread[0]; ranges.spread.hi = FALLBACK_RANGES.spread[1];
			ranges.slope.lo = FALLBACK_RANGES.slope[0]; ranges.slope.hi = FALLBACK_RANGES.slope[1];
			return;
		}
		// Height: the 2nd/98th percentile of log10(d/kpc). lo is the far end,
		// hi the near end (the composite inverts this mode).
		let sub = scratch.subarray(0, n);
		sub.set(state.logD.subarray(0, n));
		sub.sort();
		padRange(ranges.height,
			percentile(sub, n, HEIGHT_PERCENTILES[0]),
			percentile(sub, n, HEIGHT_PERCENTILES[1]));
		// Spread: σ in dex is already the datum; its log spans the colours.
		sub = scratch.subarray(0, n);
		for (let i = 0; i < n; i++) sub[i] = logFloor(state.spread[i]);
		sub.sort();
		padRange(ranges.spread,
			percentile(sub, n, DERIVED_PERCENTILES[0]),
			percentile(sub, n, DERIVED_PERCENTILES[1]));
		// Slope: dex per degree, likewise log-spanned.
		sub = scratch.subarray(0, n);
		for (let i = 0; i < n; i++) sub[i] = logFloor(state.slope[i]);
		sub.sort();
		padRange(ranges.slope,
			percentile(sub, n, DERIVED_PERCENTILES[0]),
			percentile(sub, n, DERIVED_PERCENTILES[1]));
	}

	// Full refresh: sample, derive, resolve, then apply the requested mode.
	function refresh(state, env, mode) {
		sample(state, env);
		derive(state);
		resolveRanges(state);
		return applyMode(state, mode);
	}

	function applyMode(state, mode) {
		state.mode = modeOf(mode);
		if (state.mode === MODE_OFF) { state.unit = ''; return state; }
		const name = MODE_NAMES[state.mode];
		const range = state.ranges[name];
		state.lo = range.lo;
		state.hi = range.hi;
		state.unit = name === 'height' ? 'kpc'
			: name === 'spread' ? 'dex'
			: 'dex/deg';
		return state;
	}

	function fieldSize(out, width, height) {
		const w = clamp(Math.round(width / 2), FIELD_MIN_W, FIELD_MAX_W);
		const h = Math.max(FIELD_MIN_H, Math.round(w * height / Math.max(1, width)));
		out.w = w;
		out.h = h;
		return out;
	}

	// One star's footprint covers about one mean inter-star spacing on the field
	// grid, clamped at both ends so a sparse sky fills the map and a dense one
	// does not overdraw. 0 instances draws nothing.
	function splatRadius(instances, width, height) {
		const n = Math.max(0, instances | 0);
		if (n === 0) return 0;
		const cover = Math.sqrt((width * height) / n) * SPLAT_SPACING;
		return clamp(cover, SPLAT_MIN_PX, SPLAT_MAX_PX);
	}

	// Splat uniform: x radius (field texels), y/z field pixels, w the 1 pc floor.
	function packSplat(out, radiusPx, width, height) {
		out[0] = radiusPx;
		out[1] = width;
		out[2] = height;
		out[3] = MIN_DIST_KPC;
		return out;
	}

	// Composite uniform: params (mode, opacity, relief, contour levels),
	// range (lo, hi, -, -), viewport (field width, field height, tan(fovY/2), 0),
	// canvas (canvas width, canvas height, -, -).
	// The slope mode reconstructs the angular texel size from the pinhole
	// camera the field was drawn with, so it needs tanHalfY rather than a
	// pre-divided radians-per-texel: the size changes across the frame.
	// The canvas size is the composite's own frame: the pass runs on the
	// swapchain, so its fragment position is a canvas pixel, and the field
	// grid is a different (smaller) resolution of the same NDC. Without the
	// canvas size the shader would divide a canvas pixel by the field's
	// width and sample far outside the field — the map would show the edge
	// column stretched over the picture, and no star would sit on its own
	// colour.
	function packComposite(out, state, opts) {
		out[0] = state.mode;
		out[1] = clamp(opts.opacity, MIN_OPACITY, MAX_OPACITY);
		out[2] = clamp(opts.relief, MIN_RELIEF, MAX_RELIEF);
		out[3] = clamp(opts.contours | 0, 0, MAX_CONTOURS);
		out[4] = state.lo;
		out[5] = state.hi;
		out[6] = 0;
		out[7] = 0;
		out[8] = opts.fieldW;
		out[9] = opts.fieldH;
		out[10] = opts.tanHalfY;
		out[11] = 0;
		out[12] = opts.canvasW;
		out[13] = opts.canvasH;
		out[14] = 0;
		out[15] = 0;
		return out;
	}

	// The legend reads the same numbers the shader maps: a distance in kpc for
	// height, σ in dex for spread, dex/° for slope.
	function formatDistance(kpc) {
		if (!(kpc > 0)) return '0';
		if (kpc < 0.1) return (kpc * 1000).toFixed(0) + ' pc';
		if (kpc < 10) return kpc.toFixed(2) + ' kpc';
		if (kpc < 1000) return kpc.toFixed(1) + ' kpc';
		return (kpc / 1000).toFixed(1) + ' Mpc';
	}

	function legend(state, rampName) {
		const title = MODE_TITLES[state.mode] || 'off';
		if (state.mode === MODE_OFF) return { active: false, title, low: '', high: '', note: '', ramp: rampName };
		if (state.mode === MODE_HEIGHT) {
			return {
				active: true, title: 'distance',
				low: formatDistance(Math.pow(10, state.lo)),
				high: formatDistance(Math.pow(10, state.hi)),
				note: 'near = high', ramp: rampName,
			};
		}
		if (state.mode === MODE_SPREAD) {
			return {
				active: true, title: 'depth spread',
				low: Math.pow(10, state.lo).toFixed(2) + ' dex',
				high: Math.pow(10, state.hi).toFixed(2) + ' dex',
				note: 'log-distance σ', ramp: rampName,
			};
		}
		return {
			active: true, title: 'slope',
			low: Math.pow(10, state.lo).toFixed(3) + ' dex/deg',
			high: Math.pow(10, state.hi).toFixed(3) + ' dex/deg',
			note: '|∇log d|', ramp: rampName,
		};
	}

	const FieldOverlay = {
		MODE_OFF, MODE_HEIGHT, MODE_SPREAD, MODE_SLOPE,
		MODE_NAMES, MODE_TITLES, MODE_IDS,
		MIN_DIST_KPC, RANGE_FLOOR, FIELD_MIN_W, FIELD_MAX_W, FIELD_MIN_H,
		SPLAT_SPACING, SPLAT_MIN_PX, SPLAT_MAX_PX,
		RANGE_SAMPLE_CAP, NEIGHBOURS, RANGE_PAD_FRAC, RANGE_PAD_DEX, RANGE_MIN_SPAN,
		FALLBACK_RANGES, DEFAULTS, MIN_OPACITY, MAX_OPACITY, MIN_RELIEF, MAX_RELIEF, MAX_CONTOURS,
		modeOf, clampOpacity, clampRelief, clampContours, createRangeState, sample, derive, resolveRanges, refresh, applyMode,
		fieldSize, splatRadius, packSplat, packComposite, legend,
	};
	if (typeof module !== 'undefined') module.exports = FieldOverlay;
	if (typeof window !== 'undefined') window.FieldOverlay = FieldOverlay;
})();
