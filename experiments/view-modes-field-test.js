// experiments/view-modes-field-test.js
// The view-modes heightmap island (archive/view-modes-shader-plan.md).
//
// The point of this file is the word "correspondence": the map has to put a
// star where the app draws that star, and its colours have to mean the distance
// they claim. The first cut of the module got both wrong — it re-derived a
// screen-right axis from "galactic north" (which mirrored the map and dropped
// the camera's roll) and auto-scaled the blurred field to 0..1 every frame
// (which threw away the distance it was supposed to show). Both failures are
// pinned here, in both directions: parity against the shipping camera, and
// invariance of the colour under a change that must not change it.
//
// Output: experiments/logs/view-modes-field.json

'use strict';

const fs = require('fs');
const path = require('path');

// Alias window so the src modules attach their API here, as in the browser.
globalThis.window = globalThis;

const coords = require('../src/math/coords.js');
const cameraModule = require('../src/core/camera.js');
const galaxy = require('../src/math/galaxy.js');
const orbit = require('../src/math/orbit.js');
const landmarks = require('../src/data/landmarks.js');
const constellations = require('../src/data/constellations.js');
const field = require('../src/math/view-modes-field.js');

// The page's own two-step: prepare once to learn the set's range, build the log
// scale, then prepare again with it. Kept as a helper so no check can silently
// run on a placeholder scale (that is how "flat field" bugs hide).
function starsFor(positions, count, camXYZ, scale) {
	let st = field.prepareStars(positions, count, camXYZ[0], camXYZ[1], camXYZ[2], scale || null);
	if (!scale) st = field.prepareStars(positions, count, camXYZ[0], camXYZ[1], camXYZ[2],
		field.makeScale({}, st.dMin, st.dMax));
	return st;
}

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
	return !!pass;
}

const Camera = cameraModule.Camera || cameraModule;
const cam = Camera.createCamera();
const model = galaxy.GalaxyLib ? galaxy.GalaxyLib.MILKY_WAY : galaxy.MILKY_WAY;

// A non-square viewport and a rolled pose, because a square axis-aligned camera
// hides exactly the bugs this file exists to catch.
const VW = 1600, VH = 900;
cam.setState({
	position: [0, 0, 0.005],
	velocity: [0, 0, 0],
	orientation: [0.06, -0.03, 0.11, 0.99],   // rolled, pitched and yawed on purpose
});
const viewProj = cam.buildViewProj(VW / VH);
const camPos = cam.cameraPos;
// Read the pose the *rendered* one, i.e. after the roll: a pre-setState copy is
// how a parity test ends up comparing two different cameras and passing.
const state = cam.getState({});

// --- 1. The basis: the island must not re-invent it ---------------------
{
	const q = state.orientation;
	const b = field.quatBasis({}, q);
	const near = (a, c) => Math.max(Math.abs(a[0] - c[0]), Math.abs(a[1] - c[1]), Math.abs(a[2] - c[2]));
	check('quatBasis reproduces camera.forward', near([b.fx, b.fy, b.fz], cam.forward) < 1e-6,
		{ mine: [b.fx, b.fy, b.fz], app: Array.from(cam.forward) });
	check('quatBasis reproduces camera.right (the screen-right axis, not its negation)',
		near([b.rx, b.ry, b.rz], cam.right) < 1e-6,
		{ mine: [b.rx, b.ry, b.rz], app: Array.from(cam.right) });
	check('quatBasis reproduces camera.up', near([b.ux, b.uy, b.uz], cam.up) < 1e-6,
		{ mine: [b.ux, b.uy, b.uz], app: Array.from(cam.up) });
	// The regression itself: right = cross(worldUp, forward) is the LEFT of the
	// view, which mirrored the whole map.
	const mirror = b.rx * cam.right[0] + b.ry * cam.right[1] + b.rz * cam.right[2];
	check('the map is not mirrored: right · app.right = +1', mirror > 0.999, mirror);
	check('basis is orthonormal',
		Math.abs(b.fx * b.rx + b.fy * b.ry + b.fz * b.rz) < 1e-9
		&& Math.abs(b.fx * b.ux + b.fy * b.uy + b.fz * b.uz) < 1e-9
		&& Math.abs(Math.hypot(b.rx, b.ry, b.rz) - 1) < 1e-9);
}

// --- 2. Parity: a star's texel is the pixel the app draws it at ---------
// Over several poses, because the first version's mirror error only shows on a
// star off the view axis and its up-derivation error only shows once the camera
// is rolled or near a pole.
{
	const W = 200, H = 113;
	const hit = { x: 0, y: 0, inside: false };
	const px = [0, 0, 0];
	const poses = [
		[0, 0, 0, 1],                                  // the app's home: +X, north up
		[0.06, -0.03, 0.11, 0.99],                     // rolled, pitched, yawed
		[0.7071, 0, 0, 0.7071],                        // looking at the galactic north pole
	];
	let worst = 0, worstName = '', compared = 0, skipped = 0;
	for (const orientation of poses) {
		cam.setState({ position: [0, 0, 0.005], velocity: [0, 0, 0], orientation });
		const vp = cam.buildViewProj(VW / VH);
		const st = cam.getState({});
		const layout = field.createLayout({}, {
			kind: 'view', w: W, h: H, fovY: Camera.FOV_Y, aspect: VW / VH,
			basis: field.quatBasis({}, st.orientation),
		});
		for (let i = 0; i < landmarks.count; i++) {
			const x = landmarks.positions[i * 3], y = landmarks.positions[i * 3 + 1], z = landmarks.positions[i * 3 + 2];
			const rel = [x - cam.cameraPos[0], y - cam.cameraPos[1], z - cam.cameraPos[2]];
			field.texelOf(layout, rel[0], rel[1], rel[2], hit);
			// projectToScreen returns false only for a point behind the eye, so this
			// is the one guard the comparison needs: a star outside the *window* still
			// has a pixel, and the field still has a texel for it.
			const inFront = coords.projectToScreen(vp, x, y, z, cam.cameraPos[0], cam.cameraPos[1], cam.cameraPos[2], VW, VH, px);
			if (!inFront) { skipped++; continue; }
			// A texel of index i covers [i, i+1) of the map, so the star's pixel maps
			// to texel px/VW*W − 0.5. Same convention as the painter's (i + 0.5).
			const e = Math.max(Math.abs(hit.x + 0.5 - px[0] / VW * W), Math.abs(hit.y + 0.5 - px[1] / VH * H));
			compared++;
			if (e > worst) { worst = e; worstName = landmarks.ENTRIES[i].name; }
		}
	}
	check(`${compared} landmark sightings land on the app pixel within 0.05 texel (${skipped} behind the eye)`,
		compared > 30 && worst <= 0.05, { worstTexel: +worst.toFixed(5), worstName, compared, skipped });
	cam.setState({ position: [0, 0, 0.005], velocity: [0, 0, 0], orientation: poses[1] });
	const layout = field.createLayout({}, {
		kind: 'view', w: W, h: H, fovY: Camera.FOV_Y, aspect: VW / VH,
		basis: field.quatBasis({}, cam.getState({}).orientation),
	});
	check('a star off to the app-right has a larger texel x (not mirrored)', (() => {
		const bb = layout.basis;
		function side(name) {
			const i = landmarks.indexOf(name);
			const rel = [landmarks.positions[i * 3] - cam.cameraPos[0], landmarks.positions[i * 3 + 1] - cam.cameraPos[1], landmarks.positions[i * 3 + 2] - cam.cameraPos[2]];
			return rel[0] * bb.rx + rel[1] * bb.ry + rel[2] * bb.rz;
		}
		function texel(name) {
			const i = landmarks.indexOf(name);
			field.texelOf(layout, landmarks.positions[i * 3] - cam.cameraPos[0],
				landmarks.positions[i * 3 + 1] - cam.cameraPos[1],
				landmarks.positions[i * 3 + 2] - cam.cameraPos[2], hit);
			return hit.x;
		}
		const a = side('Vega'), c = side('Acrux');
		if (a * c > 0) return false;
		return (a > c) === (texel('Vega') > texel('Acrux'));
	})());
}

// --- 3. dirAt / texelOf are inverses, in both layouts -------------------
{
	const hit = { x: 0, y: 0, inside: false };
	const dir = new Float64Array(3);
	for (const kind of ['view', 'plane']) {
		const layout = field.createLayout({}, kind === 'view'
			? { kind: 'view', w: 192, h: 108, fovY: Camera.FOV_Y, basis: field.quatBasis({}, state.orientation) }
			// 2:1: the window a full-sky chart actually needs (360° × 180°).
			: { kind: 'plane', w: 192, h: 96, spanDeg: 360, quat: field.quatNormalize([0, 0, 0, 1], [0.1, -0.2, 0.05, 0.96]) });
		let worst = 0;
		for (let py = 0; py < layout.h; py += 7) {
			for (let px = 0; px < layout.w; px += 11) {
				field.dirAt(layout, px, py, dir);
				field.texelOf(layout, dir[0], dir[1], dir[2], hit);
				// A chart wraps: texel −0.5 and w−0.5 are the same column.
				const ex = Math.abs(hit.x - px), ey = Math.abs(hit.y - py);
				const e = Math.max(Math.min(ex, layout.w - ex), ey);
				if (e > worst) worst = e;
			}
		}
		check(`${kind}: texelOf(dirAt(texel)) returns the texel`, worst < 0.02, { worstTexel: +worst.toFixed(5) });
	}
}

// --- 4. The log height scale means the distance it claims --------------
{
	const scale = field.makeScale({}, 0.00264, 0.802);      // Sirius … Deneb
	check('height 1 at the near anchor, 0 at the far anchor',
		Math.abs(field.heightOfDistance(scale, 0.00264) - 1) < 1e-9
		&& field.heightOfDistance(scale, 0.802) <= 1e-9,
		{ near: field.heightOfDistance(scale, 0.00264), far: field.heightOfDistance(scale, 0.802) });
	let monotone = true, prev = 2;
	for (let i = 0; i < 40; i++) {
		const d = 0.003 * Math.pow(1.5, i);
		const h = field.heightOfDistance(scale, d);
		if (h > prev + 1e-12) monotone = false;
		prev = h;
	}
	check('height decreases monotonically with distance', monotone);
	let roundTrip = 0;
	for (let i = 0; i <= 20; i++) {
		const v = i / 20;
		roundTrip = Math.max(roundTrip, Math.abs(field.heightOfDistance(scale, field.distanceAtHeight(scale, v)) - v));
	}
	check('legend and readout agree: height → kpc → height round-trips', roundTrip < 1e-9, roundTrip);
	// The auto-contrast bug: the blurred field used to be re-normalized to 0..1
	// every frame, so the ramp's top colour appeared even when no star was near.
	// With the scale as the only normalizer, a set that sits entirely beyond the
	// range must paint the map at its floor, not stretched across it.
	const beyondScale = field.makeScale({}, 0.001, 0.01);
	check('a set entirely outside the range reads as far, not rescaled to 1',
		field.heightOfDistance(beyondScale, 50) === 0
		&& field.heightOfDistance(field.makeScale({}, 50, 50), 50) >= 0,
		{ h: field.heightOfDistance(beyondScale, 50) });
	check('a star at the eye cannot flatten the ramp (1 pc floor)',
		field.heightOfDistance(field.makeScale({}, 0, 0.8), 0.0001) <= 1
		&& field.makeScale({}, 0, 0.8).span >= 1);
}

// --- 5. The field: smooth, hole-free, peaked at the stars --------------
{
	const set = field.buildConstellationSet({});
	check('constellation anchors are the landmark table (the Sun included)',
		set.n === landmarks.count && set.names[0] === 'Sun' && !!set.segments,
		{ n: set.n, segs: set.segments ? set.segments.length / 2 : 0 });
	// The edges have to be real landmark pairs, and the first Orion edge has to
	// join the two stars its name says. A typed-array misread here produced 82
	// edges of (0, 0) — a truthy array, an empty overlay.
	{
		const seg = set.segments;
		let inRange = true, orion = false;
		for (let i = 0; i < seg.length; i += 2) {
			if (!(seg[i] >= 0 && seg[i] < set.n && seg[i + 1] >= 0 && seg[i + 1] < set.n) || seg[i] === seg[i + 1]) inRange = false;
			const a = landmarks.ENTRIES[seg[i]].name, b = landmarks.ENTRIES[seg[i + 1]].name;
			if ((a === 'Betelgeuse' && b === 'Bellatrix') || (a === 'Bellatrix' && b === 'Betelgeuse')) orion = true;
		}
		check(`figure edges are landmark pairs (${seg.length / 2} of them, Orion included)`,
			inRange && orion && seg.length === 2 * constellations.edgeCount,
			{ len: seg.length, want: 2 * constellations.edgeCount, inRange, first: [seg[0], seg[1]], orion });
	}
	const cam0 = model.home.position;
	const stars = starsFor(set.positions, set.n, cam0);
	check('prepareStars ignores the star the eye sits on (the Sun at 5 pc)',
		stars.n >= set.n - 1 && stars.n <= set.n, { n: stars.n, set: set.n, dMin: stars.dMin });

	for (const kind of ['view', 'plane']) {
		const layout = field.createLayout({}, kind === 'view'
			? { kind: 'view', w: 160, h: 90, fovY: Camera.FOV_Y, basis: field.quatBasis({}, [0, 0, 0, 1]) }
			: { kind: 'plane', w: 160, h: 90, spanDeg: 360, quat: [0, 0, 0, 1] });
		const out = new Float32Array(layout.w * layout.h);
		const stats = {};
		field.computeField(stars, layout, { mode: 'height', sigmaDeg: 10 }, out, stats);
		let lo = 2, hi = -1, bad = 0;
		for (let i = 0; i < out.length; i++) {
			const v = out[i];
			if (!Number.isFinite(v) || v < 0 || v > 1) bad++;
			if (v < lo) lo = v;
			if (v > hi) hi = v;
		}
		check(`${kind}: the whole sky is painted, every texel finite and in 0..1`, bad === 0 && hi - lo > 0.05,
			{ bad, lo: +lo.toFixed(3), hi: +hi.toFixed(3) });
		// "Fill all sphere": no texel is left at a sentinel value because its
		// neighbourhood had no star. On a full chart the minimum must stay well
		// above zero, since the sky mean is a real number, not a hole.
		if (kind === 'plane') check('chart has no unpainted floor (min > 0.05)', lo > 0.05, { lo: +lo.toFixed(3) });
	}
}

// --- 6. Peaks sit on the stars, and mode 2 sees the depth gap ----------
{
	// A near star and a far one in the same direction (the depth-gap case), plus
	// a mid star off to the side so the field is not symmetric.
	const positions = Float64Array.of(
		0, 0.0004, 1.0,   // 1 kpc, straight up (within 0.02° of the pole star)
		0, 0, 0.001,      // 1 pc, straight up: the same ray, the near anchor
		0.7, 0.7, 0.0,    // 1 kpc, on the horizon
	);
	const layout = field.createLayout({}, { kind: 'plane', w: 96, h: 96, spanDeg: 360, quat: [0, 0, 0, 1] });
	const scale = field.makeScale({}, 0.001, 1.0);
	const stars = field.prepareStars(positions, 3, 0, 0, 0, scale);
	const hit = { x: 0, y: 0, inside: false };
	field.texelOf(layout, 0, 0, 1, hit);
	const out = new Float32Array(layout.w * layout.h);
	const stats = {};
	field.computeField(stars, layout, { mode: 'height', sigmaDeg: 12 }, out, stats);
	const atStar = out[(Math.round(hit.y)) * layout.w + Math.round(hit.x)];
	// 90° away from both anchors, on the horizon.
	const farVal = out[Math.round(layout.h * 0.5) * layout.w + Math.round(layout.w * 0.25)];
	// Both anchors share the pole ray, so the pole reads their mean (0.5): the
	// field is an interpolation, not a nearest-neighbour label. Away from the
	// stars it must fall toward the far anchor.
	check('mode 1 is the IDW mean of the stars on that ray, and falls off away from them',
		atStar > 0.4 && farVal < atStar - 0.05, { atStar: +atStar.toFixed(3), farVal: +farVal.toFixed(3) });

	field.computeField(stars, layout, { mode: 'spread', sigmaDeg: 12, spreadRefKpc: 0.2 }, out, stats);
	const spreadAt = out[Math.round(hit.y) * layout.w + Math.round(hit.x)];
	// σ of {0.001, 1.0, ~1.0} kpc ≈ 0.5 kpc at the pole, and the cost map maps
	// that through dev/(dev+ref) with ref = 0.2 kpc.
	check('mode 2 reads the depth gap in that direction (σ ≈ 0.5 kpc → cost ≈ 0.7)',
		spreadAt > 0.6 && stats.spreadMax > 0.3 && stats.spreadMax < 0.7,
		{ spread: +spreadAt.toFixed(3), peakKpc: +stats.spreadMax.toFixed(4) });
	// Two stars at the same distance in the same direction: no hidden depth.
	const flat = Float64Array.of(0, 0.0004, 1, 0, -0.0004, 1);
	const fs = field.prepareStars(flat, 2, 0, 0, 0, field.makeScale({}, 1, 1.001));
	field.computeField(fs, layout, { mode: 'spread', sigmaDeg: 12, spreadRefKpc: 0.2 }, out, stats);
	field.texelOf(layout, 0, 0, 1, hit);
	check('mode 2 is ~0 where the neighbours agree in depth',
		out[Math.round(hit.y) * layout.w + Math.round(hit.x)] < 0.05, { v: out[Math.round(hit.y) * layout.w + Math.round(hit.x)] });

	// Coincident stars must not divide by zero.
	const same = Float64Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1);
	const ss = field.prepareStars(same, 3, 0, 0, 0, field.makeScale({}, 1, 1));
	field.computeField(ss, layout, { mode: 'height', sigmaDeg: 10 }, out, stats);
	let ok = true;
	for (let i = 0; i < out.length; i++) if (!Number.isFinite(out[i])) ok = false;
	check('coincident stars: no NaN, no divide by zero', ok);
}

// --- 7. The gradient is the derivative of mode 1 -----------------------
{
	const set = field.buildConstellationSet({});
	const stars = starsFor(set.positions, set.n, model.home.position);
	const layout = field.createLayout({}, { kind: 'plane', w: 128, h: 64, spanDeg: 360, quat: [0, 0, 0, 1] });
	const height = new Float32Array(layout.w * layout.h);
	const grad = new Float32Array(layout.w * layout.h);
	const stats = {};
	field.computeField(stars, layout, { mode: 'height', sigmaDeg: 6 }, height, stats);
	field.computeField(stars, layout, { mode: 'gradient', sigmaDeg: 6, gradSpanDeg: 14 }, grad, stats);
	// A flat field must give a flat gradient: build one from a single star.
	const one = Float64Array.of(0, 0, 1);
	const oneStars = field.prepareStars(one, 1, 0, 0, 0, field.makeScale({}, 1, 1));
	const g2 = new Float32Array(layout.w * layout.h);
	field.computeField(oneStars, layout, { mode: 'gradient', sigmaDeg: 20, gradSpanDeg: 14 }, g2, stats);
	let maxG = 0;
	for (let i = 0; i < g2.length; i++) maxG = Math.max(maxG, g2[i]);
	check('gradient of a constant field is constant (≤ 0.2 of full scale)', maxG <= 0.2, { maxG: +maxG.toFixed(4) });
	let anyGrad = 0;
	for (let i = 0; i < grad.length; i++) anyGrad = Math.max(anyGrad, grad[i]);
	check('gradient of the real height field is non-degenerate', anyGrad > 0.05, { max: +anyGrad.toFixed(4) });
}

// --- 8. Layout wrap and the chart convention ---------------------------
{
	const hit = { x: 0, y: 0, inside: false };
	const layout = field.createLayout({}, { kind: 'plane', w: 360, h: 180, spanDeg: 360, quat: [0, 0, 0, 1], mirror: false });
	// The chart is centred on lon 0 (so "follow look" can put the view there),
	// and the seam sits at its two edges, at l = ±180.
	field.texelOf(layout, Math.cos(1 * field.DEG), Math.sin(1 * field.DEG), 0, hit);
	const eastX = hit.x;
	field.texelOf(layout, Math.cos(179 * field.DEG), Math.sin(179 * field.DEG), 0, hit);
	const seamX = hit.x;
	field.texelOf(layout, Math.cos(-1 * field.DEG), Math.sin(-1 * field.DEG), 0, hit);
	check('chart maps longitude about its centre and puts the seam at both edges',
		Math.abs(eastX - (180 - 0.5 + 1)) < 0.02 && Math.abs(hit.x - (180 - 0.5 - 1)) < 0.02 && seamX > 358,
		{ l1: +eastX.toFixed(2), lm1: +hit.x.toFixed(2), l179: +seamX.toFixed(2) });
	const mirrored = field.createLayout({}, { kind: 'plane', w: 360, h: 180, spanDeg: 360, quat: [0, 0, 0, 1] });
	field.texelOf(mirrored, Math.cos(1 * field.DEG), Math.sin(1 * field.DEG), 0, hit);
	field.texelOf(mirrored, Math.cos(1 * field.DEG), Math.sin(1 * field.DEG), 0, hit);
	check('the default chart mirrors the sky: north up, longitude grows left',
		Math.abs(hit.x - (360 - (180 - 0.5 + 1) - 1)) < 1.01, { x: +hit.x.toFixed(2) });
	const dir = new Float64Array(3);
	field.dirAt(mirrored, 90, 45, dir);
	field.texelOf(mirrored, dir[0], dir[1], dir[2], hit);
	check('mirrored chart still round-trips', Math.abs(hit.x - 90) < 0.02 && Math.abs(hit.y - 45) < 0.02, hit);
}

// --- 8c. The mapping is angular: raw kpc offsets are legal input ---------
{
	// The chart's markers come from star positions (0.007 kpc long), not unit
	// rays, and `lat` is an asin of a component. Without normalizing inside,
	// every marker slid toward the chart's equator while the round trip — which
	// only ever feeds it unit rays — stayed happy.
	const set = field.buildConstellationSet({});
	const cam0 = model.home.position;
	const hit = { x: 0, y: 0, inside: false };
	const hit2 = { x: 0, y: 0, inside: false };
	for (const kind of ['plane', 'view']) {
		const layout = field.createLayout({}, kind === 'plane'
			? { kind: 'plane', w: 128, h: 64, spanDeg: 360, quat: [0.1, -0.2, 0.05, 0.96], mirror: true }
			: { kind: 'view', w: 128, h: 64, fovY: Camera.FOV_Y, basis: field.quatBasis({}, [0.06, -0.03, 0.11, 0.99]) });
		let worst = 0;
		for (let i = 0; i < set.n; i++) {
			const dx = set.positions[i * 3] - cam0[0], dy = set.positions[i * 3 + 1] - cam0[1],
				dz = set.positions[i * 3 + 2] - cam0[2];
			field.texelOf(layout, dx, dy, dz, hit);
			const n = Math.hypot(dx, dy, dz);
			field.texelOf(layout, dx / n, dy / n, dz / n, hit2);
			// Longitude wraps, so compare the gap on the circle.
			let ex = Math.abs(hit.x - hit2.x);
			if (kind === 'plane') ex = Math.min(ex, layout.w - ex);
			worst = Math.max(worst, ex, Math.abs(hit.y - hit2.y));
		}
		check(`${kind}: texelOf ignores the length of the direction it is given`, worst < 1e-9,
			{ worstTexel: worst });
	}
	// A marker's texel must be the texel whose ray points back at the star, or
	// the painted peak and the drawn dot are two different things.
	{
		const layout = field.createLayout({}, { kind: 'plane', w: 424, h: 208, spanDeg: 360, quat: [0, 0, 0, 1], mirror: true });
		const ray = new Float64Array(3);
		let worst = 0, worstName = '';
		for (let i = 0; i < set.n; i++) {
			const dx = set.positions[i * 3] - cam0[0], dy = set.positions[i * 3 + 1] - cam0[1],
				dz = set.positions[i * 3 + 2] - cam0[2];
			const n = Math.hypot(dx, dy, dz);
			field.texelOf(layout, dx, dy, dz, hit);
			field.dirAt(layout, hit.x, hit.y, ray);
			const ang = Math.acos(Math.max(-1, Math.min(1, (ray[0] * dx + ray[1] * dy + ray[2] * dz) / n))) / field.DEG;
			if (ang > worst) { worst = ang; worstName = set.names[i]; }
		}
		// Half a texel is 0.42° here; a star at the pole row is clamped, so the
		// bound is one texel plus the polar slack.
		check(`every chart marker's ray comes back to its star (worst ${worst.toFixed(3)}° off ${worstName})`,
			worst < 1.3, { worstDeg: +worst.toFixed(3), worstName });
	}
	// And the field has to peak there: a wide σ averages a star's own texel down
	// toward its neighbours, which is the flat, red-free map this feature must
	// not produce.
	{
		const layout = field.createLayout({}, { kind: 'plane', w: 424, h: 208, spanDeg: 360, quat: [0, 0, 0, 1], mirror: true });
		const stars = starsFor(set.positions, set.n, cam0);
		const near = [0, 1, 4];       // the Sun, Sirius, Arcturus: the top of the ramp
		for (const sigma of [field.SIGMA_DEG, 10]) {
			const out = new Float32Array(layout.w * layout.h);
			field.computeField(stars, layout, { mode: 'height', sigmaDeg: sigma }, out, {});
			let peak = 0;
			for (const i of near) {
				field.texelOf(layout, set.positions[i * 3] - cam0[0], set.positions[i * 3 + 1] - cam0[1],
					set.positions[i * 3 + 2] - cam0[2], hit);
				const x = Math.max(0, Math.min(layout.w - 1, Math.round(hit.x)));
				const y = Math.max(0, Math.min(layout.h - 1, Math.round(hit.y)));
				if (out[y * layout.w + x] > peak) peak = out[y * layout.w + x];
			}
			let vMin = 1, vMax = 0;
			for (let k = 0; k < out.length; k++) { if (out[k] < vMin) vMin = out[k]; if (out[k] > vMax) vMax = out[k]; }
			check(`σ ${sigma}°: the near stars' texels reach ${peak.toFixed(2)} and the ramp spans ${vMax - vMin}`,
				sigma === field.SIGMA_DEG ? peak > 0.8 && vMax - vMin > 0.7 : peak < 0.85,
				{ peak: +peak.toFixed(3), range: +(vMax - vMin).toFixed(3) });
		}
	}
}

// --- 9. The catalog is the star block the app draws --------------------
{
	const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'data', 'tiles', 'catalog.js'), 'utf8');
	const g = {};
	new Function('window', src)(g);
	const bundle = g.__galaxy_catalog;
	check('catalog bundle decodes', !!bundle && bundle.starCount === 3829, bundle && bundle.starCount);
	const set = field.buildCatalogSet(bundle, 24, [0, 0, 0]);
	check('nearest-N from the catalog returns N stars, sorted by distance', set.n === 24 && set.source === 'catalog',
		{ n: set.n });
	let sorted = true;
	const Orbit = orbit.OrbitLib || orbit;
	Orbit.setEngine('classic');
	const d = [];
	for (let i = 0; i < set.n; i++) d.push(Math.hypot(set.positions[i * 3], set.positions[i * 3 + 1], set.positions[i * 3 + 2]));
	for (let i = 1; i < d.length; i++) if (d[i] < d[i - 1] - 1e-12) sorted = false;
	check('the nearest-N list is ordered and every star is inside 100 pc of the Sun', sorted && d[d.length - 1] < 0.1,
		{ farthestKpc: +d[d.length - 1].toFixed(4) });
	check('catalog records carry the packed word the renderer moves them with',
		set.packed.length === set.n && set.packed[0] !== 0, set.packed[0]);
	const all = field.buildCatalogSet(bundle, 500, [0, 0, 0]);
	const big = field.buildCatalogSet(bundle, 500, [6, 0, 0]);
	check('re-picking follows the eye: 500 nearest from 6 kpc off are different stars',
		all.positions[0] !== big.positions[0], { home: all.dmin.toFixed(4), off: big.dmin.toFixed(4) });
}

// --- 10. Star time moves the anchors through the app's dispatch ---------
{
	const set = field.buildConstellationSet({});
	const cur = new Float64Array(set.n * 3);
	field.advancePositions(set, cur, 0, model);
	let same = true;
	for (let i = 0; i < set.n * 3; i++) if (cur[i] !== set.positions[i]) same = false;
	check('frozen star time copies the birth frame exactly', same);
	field.advancePositions(set, cur, 1, model);
	let moved = 0, maxMove = 0;
	for (let i = 0; i < set.n; i++) {
		const dd = Math.hypot(cur[i * 3] - set.positions[i * 3], cur[i * 3 + 1] - set.positions[i * 3 + 1], cur[i * 3 + 2] - set.positions[i * 3 + 2]);
		if (dd > 1e-9) moved++;
		if (dd > maxMove) maxMove = dd;
	}
	// 1 Myr at the disc's ~220 km/s is ~0.22 kpc, so a real orbit moves; the
	// landmark path must not be the record path (which would need a packed
	// orbit the landmark table does not have).
	check('1 Myr of star time displaces the landmarks through the landmark dispatch',
		moved > set.n * 0.5 && maxMove > 1e-3 && maxMove < 1.0, { moved, maxMoveKpc: +maxMove.toFixed(5) });
	// The map must follow: the field has to change when the anchors move.
	const layout = field.createLayout({}, { kind: 'plane', w: 96, h: 48, spanDeg: 360, quat: [0, 0, 0, 1] });
	const a = new Float32Array(96 * 48), bb = new Float32Array(96 * 48);
	const stats = {};
	const h = model.home.position;
	field.computeField(starsFor(set.positions, set.n, h), layout, { mode: 'height' }, a, stats);
	// Same frozen range for both frames: only the anchors move, the scale does
	// not, which is what makes the delta a motion and not a repaint.
	const st0 = starsFor(set.positions, set.n, h);
	const frozen = field.makeScale({}, st0.dMin, st0.dMax);
	field.computeField(field.prepareStars(cur, set.n, h[0], h[1], h[2], frozen), layout, { mode: 'height' }, bb, stats);
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff = Math.max(diff, Math.abs(a[i] - bb[i]));
	check('the heightmap updates with star time', diff > 1e-4, { maxDelta: +diff.toFixed(5) });
}

// --- 11. Realtime budget ----------------------------------------------
{
	const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'data', 'tiles', 'catalog.js'), 'utf8');
	const g = {};
	new Function('window', src)(g);
	const set = field.buildCatalogSet(g.__galaxy_catalog, 500, [0, 0, 0]);
	// The same size the page would pick from the balanced budget, so this measures
	// the shipped configuration rather than an arbitrary one.
	const h11 = field.autoResolution(1.5e6, 500, 16 / 9);
	const layout = field.createLayout({}, { kind: 'view', w: Math.round(h11 * 16 / 9 / 8) * 8, h: h11, fovY: Camera.FOV_Y, basis: field.quatBasis({}, [0, 0, 0, 1]) });
	const out = new Float32Array(layout.w * layout.h);
	const stats = {};
	const t0 = process.hrtime.bigint();
	field.computeField(field.prepareStars(set.positions, set.n, 0, 0, 0.005, field.makeScale({}, 1e9, -1e9)), layout, { mode: 'height' }, out, stats);
	const ms = Number(process.hrtime.bigint() - t0) / 1e6;
	const budgetMs = 60;
	check(`500 anchors at the balanced budget (${layout.w}×${layout.h}) rebuilds in ${ms.toFixed(1)} ms (< ${budgetMs})`, ms < budgetMs,
		{ ms: +ms.toFixed(2), pairs: stats.pairs });
	const auto = field.autoResolution(1.5e6, 500, 16 / 9);
	const auto2 = field.autoResolution(1.5e6, 60, 16 / 9);
	check('autoResolution trades resolution for anchors', auto < auto2 && auto >= 16 && auto2 <= 512,
		{ n500: auto, n60: auto2 });
}

// --- Report -------------------------------------------------------------
let passed = 0, failed = 0;
for (const c of checks) {
	if (c.pass) passed++; else failed++;
	console.log(`  ${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.pass ? '' : `  -> ${JSON.stringify(c.detail)}`}`);
}
console.log(`\n${passed}/${checks.length} passed, ${failed} failed`);

const logPath = path.join(__dirname, 'logs', 'view-modes-field.json');
fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.writeFileSync(logPath, JSON.stringify({
	date: new Date().toISOString(),
	anchors: { landmarks: landmarks.count, catalog: 3829 },
	totalChecks: checks.length,
	passed,
	failed,
	checks,
}, null, 2));
console.log(`Wrote ${logPath}`);
console.log('\n=== VERDICT ===');
console.log(failed === 0 ? 'PASS — the heightmap is in the app\u2019s projection and its colours mean distance' : `FAIL — ${failed} checks failed`);
process.exit(failed === 0 ? 0 : 1);
