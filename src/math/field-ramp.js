// src/math/field-ramp.js
// The heightmap ramps, in one place. The island painter (view-modes.html) and
// the main renderer's WebGPU field overlay both read these LUTs, so a colour
// cannot mean one distance on the chart and another in the frame.
//
// A ramp is a 256×3 byte LUT: whatever curve produced it, the painter's (and
// the shader LUT upload's) per-texel cost stays one array index, so the curve
// is evaluated here at load and never in a frame loop.
//
// Stops are [t, r, g, b] with t ascending across 0..1. Carrying the position
// is what lets a ramp whose bands are not evenly spaced say so — the
// hypsometric terrain one, where sea level is not halfway up a mountain.

'use strict';

(function () {
	// A ramp is a 256×3 byte LUT.
	function buildRamp(stops) {
		const n = 256;
		const ramp = new Uint8Array(n * 3);
		const last = stops.length - 1;
		let s = 0;
		for (let i = 0; i < n; i++) {
			const t = i / (n - 1);
			while (s < last - 1 && stops[s + 1][0] < t) s++;
			const c0 = stops[s], c1 = stops[s + 1];
			const span = c1[0] - c0[0];
			const f = span > 0 ? (t - c0[0]) / span : 0;
			ramp[i * 3] = c0[1] + (c1[1] - c0[1]) * f;
			ramp[i * 3 + 1] = c0[2] + (c1[2] - c0[2]) * f;
			ramp[i * 3 + 2] = c0[3] + (c1[3] - c0[3]) * f;
		}
		return ramp;
	}

	// Sample a continuous 0..1 → rgb curve into the same LUT shape. Uint8Array
	// wraps out-of-range values instead of clamping them, and a fitted
	// polynomial overshoots [0, 1] by a hair at its ends, so the clamp is real.
	const curveOut = new Float64Array(3);
	function buildRampFn(curve) {
		const ramp = new Uint8Array(256 * 3);
		for (let i = 0; i < 256; i++) {
			curve(i / 255, curveOut);
			for (let c = 0; c < 3; c++) {
				const v = curveOut[c] * 255;
				ramp[i * 3 + c] = v < 0 ? 0 : v > 255 ? 255 : v;
			}
		}
		return ramp;
	}

	// Turbo as its published degree-5 polynomial (Mikhailov, "Turbo: An Improved
	// Rainbow Colormap for Visualization", 2019) rather than 11 hand-picked
	// stops joined by straight lines. The stops had the right endpoints and the
	// wrong middle — measured against the polynomial they were off by up to
	// 92/255 on one channel, mean 52, which is a different colour and not a
	// rounding — and the joins between them band. Six coefficients per channel,
	// evaluated 256 times, here, once.
	const TURBO_POLY = {
		r: [0.13572138, 4.61539260, -42.66032258, 132.13108234, -152.94239396, 59.28637943],
		g: [0.09140261, 2.19418839, 4.84296658, -14.18503333, 4.27729857, 2.82956604],
		b: [0.10667330, 12.64194608, -60.58204836, 110.36276771, -89.90310912, 27.34824973],
	};
	function polyCurve(k, x, out) {
		const x2 = x * x, x3 = x2 * x, x4 = x3 * x, x5 = x4 * x;
		for (let c = 0; c < 3; c++) {
			const p = k[c];
			out[c] = p[0] + p[1] * x + p[2] * x2 + p[3] * x3 + p[4] * x4 + p[5] * x5;
		}
		return out;
	}
	function turboCurve(x, out) {
		const t = x < 0 ? 0 : x > 1 ? 1 : x;
		return polyCurve([TURBO_POLY.r, TURBO_POLY.g, TURBO_POLY.b], t, out);
	}

	// Viridis for "how far" (perceptually even), turbo for "how much hidden
	// depth" (its red end shouts), grey for a cost map you would feed a
	// pathfinder.
	const VIRIDIS = buildRamp([
		[0.0,  68,  1, 84], [0.1,  72, 36, 117], [0.2,  65, 68, 135],
		[0.3,  53, 95, 141], [0.4,  42, 120, 142], [0.5,  33, 145, 140],
		[0.6,  29, 169, 131], [0.7,  50, 192, 111], [0.8,  97, 212,  82],
		[0.9, 170, 229,  42], [1.0, 253, 231,  37],
	]);
	const TURBO = buildRampFn(turboCurve);
	// Magma: viridis's warm sibling, and the better of the two for a depth
	// spread because its dark end stays dark instead of going purple.
	const MAGMA = buildRamp([
		[0.000,   0,   0,   4], [0.125,  28,  16,  68], [0.250,  79,  18, 123],
		[0.375, 129,  37, 129], [0.500, 181,  54, 122], [0.625, 229,  80, 100],
		[0.750, 251, 135,  97], [0.875, 254, 194, 135], [1.000, 252, 253, 191],
	]);
	// The hypsometric ramp: deep water → shelf → lowland → highland → snow. On a
	// distance-from-eye map it reads the way a terrain map does, which is the
	// point of calling this a heightmap; the uneven stops are the water/land
	// split, not a sampling accident.
	const TERRAIN = buildRamp([
		[0.00,  10,  31,  97], [0.20,  20, 140, 166], [0.45,  46, 179,  77],
		[0.70, 230, 209,  56], [0.88, 199,  82,  36], [1.00, 250, 250, 255],
	]);
	const GREY = buildRamp([[0, 0, 0, 0], [1, 255, 255, 255]]);

	const RAMPS = { viridis: VIRIDIS, turbo: TURBO, magma: MAGMA, terrain: TERRAIN, grey: GREY };
	const RAMP_NAMES = ['viridis', 'turbo', 'magma', 'terrain', 'grey'];
	// So a readout can name the ramp on screen without a reverse lookup in the
	// frame loop.
	for (const name in RAMPS) RAMPS[name]._name = name;

	// Height reads as distance, so the perceptually even ramp is the default;
	// depth spread is a hazard, so turbo's red end; the slope/cost map is grey.
	// Both the island's 'gradient' and the overlay's 'slope' land on grey.
	function rampForMode(mode) {
		if (mode === 'height') return VIRIDIS;
		if (mode === 'spread') return TURBO;
		return GREY;
	}

	// An explicit menu choice wins; 'auto' (or anything unrecognised) keeps the
	// per-mode default, so switching modes still switches to the ramp that mode
	// was designed for.
	function resolveRamp(mode, which) {
		return (which && RAMPS[which]) || rampForMode(mode);
	}

	// The GPU reads the same LUT as an rgba8unorm-srgb texture: once per ramp,
	// built on first use. Alpha is opaque; the composite reads rgb only.
	const rgbaCache = new Map();
	function rampRGBA(ramp) {
		let out = rgbaCache.get(ramp);
		if (out) return out;
		out = new Uint8Array(256 * 4);
		for (let i = 0; i < 256; i++) {
			out[i * 4] = ramp[i * 3];
			out[i * 4 + 1] = ramp[i * 3 + 1];
			out[i * 4 + 2] = ramp[i * 3 + 2];
			out[i * 4 + 3] = 255;
		}
		rgbaCache.set(ramp, out);
		return out;
	}

	const FieldRamp = {
		RAMPS, RAMP_NAMES, rampForMode, resolveRamp, rampRGBA, buildRamp, buildRampFn,
	};
	if (typeof module !== 'undefined') module.exports = FieldRamp;
	if (typeof window !== 'undefined') window.FieldRamp = FieldRamp;
})();
