// src/render/view-modes-renderer.js
// 2D-canvas painter for the view-modes heightmap experiment.
//
// Takes the Float32Array field built by math/view-modes-field.js and paints it
// with a colour ramp plus contours, then overlays the anchor stars, the
// constellation figures and the current view window through *the layout's own*
// texel mapping. That is the whole design rule of this file: it never re-derives
// a projection, so an overlay marker cannot drift from the field it sits on.
// Deliberately isolated — it imports nothing from core/ or
// render/star-sprites.js.
//
// The field is painted at field resolution and upscaled by drawImage, which is
// what makes a 96-texel field read as smooth terrain: the browser's bilinear
// filter is the last mile of the diffusion the task asked for.

'use strict';

(function () {
	const Field = (typeof window !== 'undefined')
		? window.ViewModesField
		: require('../math/view-modes-field.js');

	// A ramp is a 256×3 byte LUT: whatever curve produced it, the painter's
	// per-texel cost stays one array index, so the curve is evaluated here at
	// load and never in the frame loop.
	//
	// Stops are [t, r, g, b] with t ascending across 0..1. Carrying the position
	// is what lets a ramp whose bands are not evenly spaced say so — the
	// hypsometric terrain one, where sea level is not halfway up a mountain.
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
	// So the readout can name the ramp on screen without a reverse lookup in the
	// frame loop.
	for (const name in RAMPS) RAMPS[name]._name = name;

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

	// Shaded relief, the cartographic convention: light from the north-west at
	// 45° altitude, so the slope facing up-left is the lit one and a ridge reads
	// as a ridge instead of as a colour change.
	//
	// The exaggeration's unit length is one *degree of sky* — the same unit the
	// gradient mode quotes — not one texel. A per-texel gain would flatten the
	// relief every time the resolution slider moved, shading the sampling rather
	// than the terrain.
	const LIGHT_X = -0.5, LIGHT_Y = -0.5, LIGHT_Z = Math.SQRT1_2;   // |L| = 1
	const RELIEF_AMBIENT = 0.45;      // the shadow floor: relief darkens, never blacks out
	// Vertical exaggeration, in the topographic-map sense. Measured on a 250-anchor
	// mode-1 field the displayed height runs ~0.02 per degree at the median and
	// ~0.06 at p95, so 1× tilts a lit slope by 3° against a 45° light and reads as
	// nothing; 6× puts p95 at ~20°, which is a ridge you can see and not a cliff.
	const RELIEF_DEFAULT = 6;

	// Scratch, reused every frame: no per-frame ImageData, no per-frame canvas.
	const paint = {
		img: null, w: 0, h: 0,
		fieldOff: null, fieldCtx: null,
		dir: new Float64Array(3),
		hit: { x: 0, y: 0, inside: false },
		read: { height: 0 },
		slopeX: null, slopeY: null, slopeN: 0,
	};

	function sizedCanvas(which, w, h) {
		const o = paint[which] || (paint[which] = document.createElement('canvas'));
		if (o.width !== w || o.height !== h) { o.width = w; o.height = h; paint[which + 'Ctx'] = null; }
		if (!paint[which + 'Ctx']) paint[which + 'Ctx'] = o.getContext('2d');
		return o;
	}

	// f32 is enough here and would not be enough for the gradient mode: this is
	// a lighting term on a 0..1 display value, not a quoted measurement.
	function slopeBuffers(count) {
		if (paint.slopeN >= count) return;
		paint.slopeX = new Float32Array(count);
		paint.slopeY = new Float32Array(count);
		paint.slopeN = count;
	}

	// opts: {
	//   mode, ramp, invert, smooth, drawContours, contourLevels, drawGrid,
	//   relief (0 = flat, else the shaded-relief exaggeration),
	//   positions (Float64Array n*3, WORLD coords), eye ([x,y,z] of the camera),
	//   set ({n, names, segments}), layout,
	//   viewBox (4 corner rays) — the frustum rectangle on a chart,
	// }
	//
	// `eye` is not optional in spirit: the field is built from the ray
	// star − eye, so a marker that skipped the subtraction would sit on a
	// different ray than the colour under it — off by degrees for the nearest
	// stars, which are the ones drawn biggest.
	function renderField(ctx, field, layout, opts) {
		const w = layout.w, h = layout.h;
		const iw = ctx.canvas.width | 0, ih = ctx.canvas.height | 0;
		FULL.x = 0; FULL.y = 0; FULL.w = iw; FULL.h = ih;
		const ramp = opts.ramp || rampForMode(opts.mode);
		const levels = (opts.contourLevels | 0) || 10;
		const contour = opts.drawContours ? 0.18 : 0;
		const invert = !!opts.invert;
		const relief = opts.relief > 0 ? opts.relief : 0;

		// The relief shades the *displayed* height, the same 0..1 the contours
		// are drawn on, so the two cannot disagree about which way is up. An
		// inverted map is inverted terrain, so the gain carries the sign.
		let gain = 0;
		if (relief > 0) {
			slopeBuffers(w * h);
			Field.fieldSlope(field, layout, paint.slopeX, paint.slopeY);
			gain = (invert ? -relief : relief) * Field.DEG;
		}
		const sx = paint.slopeX, sy = paint.slopeY;

		if (!paint.img || paint.w !== w || paint.h !== h) {
			paint.img = ctx.createImageData(w, h);
			paint.w = w; paint.h = h;
		}
		const data = paint.img.data;
		for (let y = 0; y < h; y++) {
			const row = y * w;
			for (let x = 0; x < w; x++) {
				let v = field[row + x];
				if (!(v >= 0)) v = 0; else if (v > 1) v = 1;
				if (invert) v = 1 - v;
				const ci = ((v * 255) | 0) * 3;
				let r = ramp[ci], g = ramp[ci + 1], b = ramp[ci + 2];
				if (gain !== 0) {
					// Lambert on n = (−dz/dx, −dz/dy, 1) with an ambient floor, and
					// never above 1: a highlight that multiplied past full scale
					// would clip the ramp and make the colour stop meaning the
					// value the legend quotes.
					const nx = sx[row + x] * gain, ny = sy[row + x] * gain;
					const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
					let d = (nx * LIGHT_X + ny * LIGHT_Y + LIGHT_Z) * inv;
					if (d < 0) d = 0;
					const sh = RELIEF_AMBIENT + (1 - RELIEF_AMBIENT) * d;
					r *= sh; g *= sh; b *= sh;
				}
				if (contour > 0) {
					// Darken where v crosses a 1/levels band edge: contour lines for
					// free, no second pass and no marching squares.
					const band = v * levels;
					const frac = band - Math.floor(band);
					const k = 1 - Math.min(frac, 1 - frac) / 0.05;
					if (k > 0) {
						const dim = 1 - contour * k;
						r *= dim; g *= dim; b *= dim;
					}
				}
				const di = (row + x) * 4;
				data[di] = r; data[di + 1] = g; data[di + 2] = b; data[di + 3] = 255;
			}
		}
		const off = sizedCanvas('fieldOff', w, h);
		paint.fieldOffCtx.putImageData(paint.img, 0, 0);
		ctx.imageSmoothingEnabled = opts.smooth !== false;
		ctx.imageSmoothingQuality = 'high';
		// A chart may be latitude-limited, so the map does not always fill the
		// window: everything — field, graticule, markers, view box — lands in one
		// rect, which is what keeps the overlays on the field they describe.
		const rect = opts.rect || FULL;
		if (rect.x > 0 || rect.y > 0) {
			ctx.fillStyle = '#05070d';
			ctx.fillRect(0, 0, iw, ih);
		}
		ctx.drawImage(off, rect.x, rect.y, rect.w, rect.h);

		if (opts.drawGrid) drawGrid(ctx, rect, layout);
		if (opts.positions && opts.set) drawStars(ctx, rect, layout, field, opts);
		if (opts.viewBox) drawViewBox(ctx, rect, layout, opts.viewBox);
	}
	const FULL = { x: 0, y: 0, w: 0, h: 0 };

	// A graticule in *ray* space: meridians and parallels of galactic longitude
	// and latitude, mapped through the layout. Dividing the texture into tenths
	// would be cheaper and would lie about what a texel is.
	function drawGrid(ctx, rect, layout) {
		ctx.strokeStyle = 'rgba(255,255,255,0.11)';
		ctx.lineWidth = 1;
		ctx.beginPath();
		for (let lon = -180; lon < 180; lon += 30) traceRayLine(ctx, layout, rect, false, lon * Field.DEG);
		for (let lat = -60; lat <= 60; lat += 30) traceRayLine(ctx, layout, rect, true, lat * Field.DEG);
		ctx.stroke();
	}

	// `parallel` picks the swept angle: a meridian sweeps latitude at a fixed
	// longitude, a parallel sweeps longitude at a fixed latitude. A step that
	// jumps over half the map is the chart seam, so the polyline breaks there
	// instead of drawing a line across the world.
	function traceRayLine(ctx, layout, rect, parallel, fixed) {
		const hit = paint.hit, dir = paint.dir;
		const sx = rect.w / layout.w, sy = rect.h / layout.h;
		const cf = Math.cos(fixed), sf = Math.sin(fixed);
		let started = false, prevX = 0, prevY = 0;
		for (let t = -180; t <= 180; t += 2) {
			const a = t * Field.DEG, ca = Math.cos(a), sa = Math.sin(a);
			if (parallel) { dir[0] = cf * ca; dir[1] = cf * sa; dir[2] = sf; }
			else { dir[0] = ca * cf; dir[1] = ca * sf; dir[2] = sa; }
			Field.texelOf(layout, dir[0], dir[1], dir[2], hit);
			if (!hit.inside) { started = false; continue; }
			const x = rect.x + (hit.x + 0.5) * sx, y = rect.y + (hit.y + 0.5) * sy;
			if (started && Math.abs(x - prevX) < sx * layout.w * 0.5 && Math.abs(y - prevY) < sy * layout.h * 0.5) ctx.lineTo(x, y);
			else ctx.moveTo(x, y);
			started = true; prevX = x; prevY = y;
		}
	}

	// Anchor stars and constellation figures, through the layout's texelOf — the
	// same call the field sampler used, which is why they cannot disagree.
	function drawStars(ctx, rect, layout, field, opts) {
		const set = opts.set, pos = opts.positions;
		const n = set.n;
		const eye = opts.eye;
		const ex = eye ? eye[0] : 0, ey = eye ? eye[1] : 0, ez = eye ? eye[2] : 0;
		const hit = paint.hit, read = paint.read;
		const sx = rect.w / layout.w, sy = rect.h / layout.h;
		const names = opts.drawNames && set.names;

		if (set.segments) {
			ctx.lineWidth = 1.2;
			ctx.strokeStyle = 'rgba(120,200,255,0.5)';
			ctx.beginPath();
			const seg = set.segments;
			for (let i = 0; i < seg.length; i += 2) {
				const a = seg[i], b = seg[i + 1];
				Field.texelOf(layout, pos[a * 3] - ex, pos[a * 3 + 1] - ey, pos[a * 3 + 2] - ez, hit);
				if (!hit.inside) { continue; }
				const ax = rect.x + (hit.x + 0.5) * sx, ay = rect.y + (hit.y + 0.5) * sy;
				Field.texelOf(layout, pos[b * 3] - ex, pos[b * 3 + 1] - ey, pos[b * 3 + 2] - ez, hit);
				if (!hit.inside) { continue; }
				const bx = rect.x + (hit.x + 0.5) * sx, by = rect.y + (hit.y + 0.5) * sy;
				// Break the segment at the seam: on a wrapped chart a line that
				// spans half the world is the seam, not a constellation.
				if (Math.abs(bx - ax) > rect.w * 0.5 || Math.abs(by - ay) > rect.h * 0.5) continue;
				ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
			}
			ctx.stroke();
		}

		for (let i = 0; i < n; i++) {
			Field.texelOf(layout, pos[i * 3] - ex, pos[i * 3 + 1] - ey, pos[i * 3 + 2] - ez, hit);
			if (!hit.inside) continue;
			const x = rect.x + (hit.x + 0.5) * sx, y = rect.y + (hit.y + 0.5) * sy;
			// Marker size reads the field height at the star's own texel, so the dot
			// and the colour underneath it tell the same story.
			Field.heightAt(field, layout, (hit.x + 0.5) / layout.w, (hit.y + 0.5) / layout.h, read);
			const r = 1.8 + 3.2 * Math.max(0, Math.min(1, read.height));
			ctx.beginPath();
			ctx.arc(x, y, r, 0, Math.PI * 2);
			ctx.fillStyle = 'rgba(255,255,255,0.92)';
			ctx.fill();
			ctx.lineWidth = 1;
			ctx.strokeStyle = 'rgba(0,0,0,0.7)';
			ctx.stroke();
			if (names && i > 0 && r > 3.4) {
				ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
				ctx.fillStyle = 'rgba(255,255,255,0.8)';
				ctx.textBaseline = 'bottom';
				ctx.fillText(names[i], x + r + 3, y - 2);
			}
		}
	}

	// The frustum outline on a chart: the four corner rays of the app window.
	// In the sphere layout the map *is* the view, so the page passes no box.
	function drawViewBox(ctx, rect, layout, corners) {
		const hit = paint.hit;
		const sx = rect.w / layout.w, sy = rect.h / layout.h;
		ctx.save();
		ctx.strokeStyle = 'rgba(255,255,255,0.85)';
		ctx.setLineDash([5, 4]);
		ctx.lineWidth = 1.2;
		ctx.beginPath();
		let open = false, prevX = 0;
		for (let i = 0; i < 4; i++) {
			const c = corners[i];
			Field.texelOf(layout, c[0], c[1], c[2], hit);
			if (!hit.inside) { open = false; continue; }
			const x = rect.x + (hit.x + 0.5) * sx, y = rect.y + (hit.y + 0.5) * sy;
			if (open && Math.abs(x - prevX) < rect.w * 0.5) ctx.lineTo(x, y);
			else ctx.moveTo(x, y);
			open = true; prevX = x;
		}
		ctx.stroke();
		ctx.restore();
	}

	// Legend: the ramp plus what its ends mean in the world. Quoting kpc (or
	// degrees for the gradient) is the point — an unlabelled ramp is exactly what
	// made the first version impossible to check.
	function renderLegend(ctx, mode, opts) {
		const c = ctx.canvas;
		const iw = c.width | 0, ih = c.height | 0;
		const W = 260, H = 12, pad = 12;
		const x = iw - W - pad, y = ih - H - pad - 30;
		const ramp = opts.ramp || rampForMode(mode);
		const strip = rampStrip(ramp);
		ctx.fillStyle = 'rgba(6,8,14,0.72)';
		ctx.fillRect(x - 8, y - 16, W + 16, H + 62);
		ctx.drawImage(strip, 0, 0, 256, 1, x, y, W, H);
		ctx.strokeStyle = 'rgba(255,255,255,0.45)';
		ctx.lineWidth = 1;
		ctx.strokeRect(x + 0.5, y + 0.5, W, H);
		ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
		ctx.textBaseline = 'alphabetic';
		ctx.textAlign = 'left';
		ctx.fillStyle = '#fff';
		ctx.fillText(opts.title || mode, x, y - 6);
		ctx.fillStyle = 'rgba(205,220,238,0.9)';
		ctx.fillText(opts.low || 'low', x, y + H + 14);
		ctx.textAlign = 'right';
		ctx.fillText(opts.high || 'high', x + W, y + H + 14);
		ctx.textAlign = 'left';
		if (opts.note) ctx.fillText(opts.note, x, y + H + 28);
		if (opts.note2) ctx.fillText(opts.note2, x, y + H + 42);
	}

	// One 256×1 canvas per ramp, built on first use and never again. Per ramp
	// rather than one shared canvas: the menu can switch ramps, and a shared
	// strip would be rebuilt on every switch and need a stale-guard to stay
	// correct.
	function rampStrip(ramp) {
		if (ramp._strip) return ramp._strip;
		const o = document.createElement('canvas');
		o.width = 256; o.height = 1;
		const cx = o.getContext('2d');
		const img = cx.createImageData(256, 1);
		for (let i = 0; i < 256; i++) {
			img.data[i * 4] = ramp[i * 3];
			img.data[i * 4 + 1] = ramp[i * 3 + 1];
			img.data[i * 4 + 2] = ramp[i * 3 + 2];
			img.data[i * 4 + 3] = 255;
		}
		cx.putImageData(img, 0, 0);
		ramp._strip = o;
		return o;
	}

	const ViewModesRenderer = {
		renderField, renderLegend, rampForMode, resolveRamp,
		ramps: RAMPS,
		RELIEF_DEFAULT,
	};

	if (typeof module !== 'undefined') module.exports = ViewModesRenderer;
	if (typeof window !== 'undefined') window.ViewModesRenderer = ViewModesRenderer;
})();
