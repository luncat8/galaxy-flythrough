// src/render/view-modes-renderer.js
// 2D-canvas heightmap renderer for the view-modes experiment.
//
// Given a Float32Array heightmap (W x H) filled by view-modes-field.js, this
// module renders it to a canvas using a colour ramp, overlays contour lines
// and optional star points. Kept deliberately isolated: imports nothing from
// core/ or render/star-sprites.js — only math/view-modes-field.js for helpers.

'use strict';

(function () {
	const Field = (typeof window !== 'undefined') ? window.ViewModesField : null;

	// Viridis-inspired ramp (approximate) — 256 stops, from dark purple (0)
	// through blue/cyan/green to yellow (1). Better for distance reading.
	const VIRIDIS = buildViridis();
	// Greyscale ramp — better for game-style "cost" map.
	const GREY = buildGreyscale();
	// Turbo-like rainbow — good for depth variance (adjacency).
	const TURBO = buildTurbo();

	function buildViridis() {
		// Hand-tuned stops that approximate matplotlib viridis.
		const stops = [
			[ 68,  1, 84], [ 72, 36, 117], [ 65, 68, 135], [ 53, 95, 141],
			[ 42,120, 142], [ 33,145, 140], [ 29,169, 131], [ 50,192, 111],
			[ 97,212,  82], [170,229,  42], [253,231,  37],
		];
		return buildRamp(stops, 256);
	}
	function buildGreyscale() {
		const ramp = new Uint8ClampedArray(256 * 3);
		for (let i = 0; i < 256; i++) { ramp[i * 3] = i; ramp[i * 3 + 1] = i; ramp[i * 3 + 2] = i; }
		return ramp;
	}
	function buildTurbo() {
		// Google's turbo approximation.
		const stops = [
			[ 48, 18, 59], [ 70, 48, 126], [ 75, 98, 200], [ 39, 160, 247],
			[ 42, 210, 207], [100, 238, 126], [190, 251,  67], [255, 222,  40],
			[240, 148,  22], [205, 66,   4], [143,  0,   0],
		];
		return buildRamp(stops, 256);
	}
	function buildRamp(stops, n) {
		const ramp = new Uint8ClampedArray(n * 3);
		const last = stops.length - 1;
		for (let i = 0; i < n; i++) {
			const t = i / (n - 1) * last;
			const i0 = Math.min(last, Math.floor(t));
			const i1 = Math.min(last, i0 + 1);
			const f = t - i0;
			const c0 = stops[i0], c1 = stops[i1];
			ramp[i * 3]     = c0[0] + (c1[0] - c0[0]) * f;
			ramp[i * 3 + 1] = c0[1] + (c1[1] - c0[1]) * f;
			ramp[i * 3 + 2] = c0[2] + (c1[2] - c0[2]) * f;
		}
		return ramp;
	}

	function rampForMode(mode) {
		if (mode === 'camera-dist') return VIRIDIS;
		if (mode === 'adjacency')  return TURBO;
		return GREY;
	}

	// Render the heightmap to a canvas's ImageData. If `overlayStars` is
	// provided (positions Float64Array count*3 + camera object), small markers
	// are drawn for each visible star.
	//
	// opts: {
	//   mode: 'camera-dist' | 'adjacency',
	//   drawContours: bool,
	//   drawGrid: bool,
	//   contourLevels: number of contour bands (default 10),
	//   invert: bool (flip 0↔1),
	// }
	function renderHeightmap(ctx, field, positions, camera, opts) {
		const w = field._w, h = field._h;
		const canvas = ctx.canvas;
		const iw = canvas.width, ih = canvas.height;
		// We'll paint an ImageData of size w×h then let the canvas scale it
		// up via drawImage if iw≠w (faster than painting iw×ih in JS).
		const img = ctx.createImageData(w, h);
		const data = img.data;
		const ramp = rampForMode(opts.mode);
		const levels = (opts.contourLevels | 0) || 10;
		const contourStrength = opts.drawContours ? 0.18 : 0;  // darken at bands
		const invert = !!opts.invert;

		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				let v = field[y * w + x];
				if (invert) v = 1 - v;
				let r = ramp[((v * 255) | 0) * 3];
				let g = ramp[((v * 255) | 0) * 3 + 1];
				let b = ramp[((v * 255) | 0) * 3 + 2];

				// Contours: darken slightly when v crosses a 1/levels boundary.
				if (contourStrength > 0) {
					const band = v * levels;
					const frac = band - Math.floor(band);
					// edge at integer band → frac close to 0
					const edge = Math.min(frac, 1 - frac);
					const k = Math.max(0, 1 - edge / 0.04);  // 4% of band width
					const dim = 1 - contourStrength * k;
					r *= dim; g *= dim; b *= dim;
				}

				const di = (y * w + x) * 4;
				data[di]     = r;
				data[di + 1] = g;
				data[di + 2] = b;
				data[di + 3] = 255;
			}
		}

		// Put into an offscreen canvas to scale, then draw onto ctx.
		if (!renderHeightmap._off) renderHeightmap._off = document.createElement('canvas');
		const off = renderHeightmap._off;
		off.width = w; off.height = h;
		off.getContext('2d').putImageData(img, 0, 0);

		ctx.imageSmoothingEnabled = true;
		ctx.imageSmoothingQuality = 'high';
		ctx.drawImage(off, 0, 0, iw, ih);

		// Optional grid lines over the map (10 divisions).
		if (opts.drawGrid) {
			ctx.strokeStyle = 'rgba(255,255,255,0.12)';
			ctx.lineWidth = 1;
			ctx.beginPath();
			for (let i = 1; i < 10; i++) {
				const xg = iw * i / 10;
				const yg = ih * i / 10;
				ctx.moveTo(xg, 0); ctx.lineTo(xg, ih);
				ctx.moveTo(0, yg); ctx.lineTo(iw, yg);
			}
			ctx.stroke();
		}

		// Overlay star positions.
		if (positions && camera) {
			const n = positions._count || (positions.length / 3) | 0;
			const fovTan = Math.tan((opts.fovDeg * Math.PI / 180 || Math.PI / 2) * 0.5);
			const aspect = h / w;
			const basis = Field.buildBasis(camera.fx, camera.fy, camera.fz, {});
			const p = {};
			ctx.fillStyle = 'rgba(255,255,255,0.85)';
			ctx.strokeStyle = 'rgba(0,0,0,0.6)';
			ctx.lineWidth = 1;
			for (let i = 0; i < n; i++) {
				const px = positions[i * 3], py = positions[i * 3 + 1], pz = positions[i * 3 + 2];
				Field.projectPoint(px, py, pz, camera.x, camera.y, camera.z,
					basis.fx, basis.fy, basis.fz, basis.rx, basis.ry, basis.rz,
					basis.ux, basis.uy, basis.uz, fovTan, aspect, p);
				if (p.dist < 0) continue;
				if (Math.abs(p.x) > 1.1 || Math.abs(p.y) > 1.1) continue;
				const sx = (p.x * 0.5 + 0.5) * iw;
				const sy = (1 - (p.y * 0.5 + 0.5)) * ih;
				ctx.beginPath();
				ctx.arc(sx, sy, 2.5, 0, Math.PI * 2);
				ctx.fill();
				ctx.stroke();
			}
		}
	}

	// Render a color-legend strip in the corner.
	function renderLegend(ctx, mode, label) {
		const c = ctx.canvas;
		const iw = c.width, ih = c.height;
		const pad = 12;
		const W = 180, H = 16;
		const x = iw - W - pad, y = ih - H - pad;
		const ramp = rampForMode(mode);
		const img = ctx.createImageData(W, 1);
		for (let i = 0; i < W; i++) {
			const t = i / (W - 1);
			const ri = (t * 255) | 0;
			img.data[i * 4]     = ramp[ri * 3];
			img.data[i * 4 + 1] = ramp[ri * 3 + 1];
			img.data[i * 4 + 2] = ramp[ri * 3 + 2];
			img.data[i * 4 + 3] = 255;
		}
		const off = renderLegend._off || (renderLegend._off = document.createElement('canvas'));
		off.width = W; off.height = 1;
		off.getContext('2d').putImageData(img, 0, 0);
		ctx.fillStyle = 'rgba(0,0,0,0.55)';
		ctx.fillRect(x - 6, y - 18, W + 12, H + 28);
		ctx.drawImage(off, x, y, W, H);
		ctx.strokeStyle = 'rgba(255,255,255,0.5)';
		ctx.strokeRect(x + 0.5, y + 0.5, W, H);
		ctx.fillStyle = '#fff';
		ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
		ctx.textBaseline = 'bottom';
		ctx.fillText(label || mode, x, y - 4);
		ctx.fillText('low',  x, y + H + 13);
		ctx.fillText('high', x + W - 24, y + H + 13);
	}

	const ViewModesRenderer = {
		renderHeightmap,
		renderLegend,
		ramps: { VIRIDIS, GREY, TURBO },
	};

	if (typeof module !== 'undefined') module.exports = ViewModesRenderer;
	if (typeof window !== 'undefined') window.ViewModesRenderer = ViewModesRenderer;
})();
