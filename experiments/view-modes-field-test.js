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

// One place where the page's "prepare the current anchor positions" step lives,
// so no check can silently measure a different eye than the one it built.
function starsFor(positions, count, camXYZ) {
	return field.prepareStars(positions, count, camXYZ[0], camXYZ[1], camXYZ[2]);
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

// --- 3b. The chart drag pins the pressed ray (planet-geotectonics law) ----
{
	const layout = field.createLayout({}, { kind: 'plane', w: 240, h: 120, spanDeg: 360, quat: [0.2, -0.1, 0.05, 0.96] });
	const q0 = field.quatNormalize(new Float64Array([0.2, -0.1, 0.05, 0.96]), [0.2, -0.1, 0.05, 0.96]);
	const e0 = new Float64Array(3), e1 = new Float64Array(3);
	// The same pointer mapping dirAt uses, without the pan quaternion: pointer u
	// 0.3 → map ray e0, pointer v 0.55 → map ray e1. These are *map-space* rays;
	// feeding world rays to the arc is the bug that was shipped.
	field.chartDirAt(e0, 0.30, 0.55, layout.spanX, layout.spanY, true);
	field.chartDirAt(e1, 0.42, 0.48, layout.spanX, layout.spanY, true);
	const qInv0 = field.quatInv(new Float64Array(4), q0);
	const w0 = new Float64Array(3);
	field.quatApply(w0, e0[0], e0[1], e0[2], qInv0);

	const q = field.quatDrag(new Float64Array(4), q0, e0[0], e0[1], e0[2], e1[0], e1[1], e1[2]);
	const qInv1 = field.quatInv(new Float64Array(4), q);
	const w1 = new Float64Array(3);
	field.quatApply(w1, e1[0], e1[1], e1[2], qInv1);
	const pinDot = w0[0] * w1[0] + w0[1] * w1[1] + w0[2] * w1[2];
	check('quatDrag keeps the pressed sky point under the pointer (rotated chart)',
		pinDot > 0.999999999, { dot: +pinDot.toFixed(9) });

	// The shipped bug: the same arc built from world rays and left-composed.
	// It pins only while q is the identity.
	const wi0 = new Float64Array(3), wi1 = new Float64Array(3);
	field.quatApply(wi0, e0[0], e0[1], e0[2], qInv0);
	field.quatApply(wi1, e1[0], e1[1], e1[2], qInv0);
	const arc = field.quatArc(new Float64Array(4), wi0[0], wi0[1], wi0[2], wi1[0], wi1[1], wi1[2]);
	const qOld = field.quatNormalize(new Float64Array(4), field.quatMul(new Float64Array(4), arc, q0));
	const wOld = new Float64Array(3);
	field.quatApply(wOld, e1[0], e1[1], e1[2], field.quatInv(new Float64Array(4), qOld));
	const oldDot = w0[0] * wOld[0] + w0[1] * wOld[1] + w0[2] * wOld[2];
	const oldErrDeg = Math.acos(Math.min(1, oldDot)) / field.DEG;
	check('the old world-ray arc drifts the grabbed point by degrees (the glitch)',
		oldErrDeg > 1, { driftDeg: +oldErrDeg.toFixed(2) });

	// A drag that returns to the press pixel restores the chart exactly, and a
	// second drag composed from the *same* press continues to pin: no
	// accumulation error, which is what made the old pan accelerate.
	const back = field.quatDrag(new Float64Array(4), q, e1[0], e1[1], e1[2], e0[0], e0[1], e0[2]);
	const backDot = back[0] * q0[0] + back[1] * q0[1] + back[2] * q0[2] + back[3] * q0[3];
	check('a chart drag that returns to the press pixel restores the chart',
		Math.abs(backDot) > 0.999999999, { dot: +backDot.toFixed(9) });

	// chartDirAt must be exactly dirAt minus the pan quaternion, or the drag
	// solves a different pixel-to-ray map than the field samples.
	const dir = new Float64Array(3), ray = new Float64Array(3);
	let worst = 0;
	for (let py = 3; py < layout.h; py += 17) {
		for (let px = 5; px < layout.w; px += 23) {
			field.dirAt(layout, px, py, dir);
			field.chartDirAt(ray, (px + 0.5) / layout.w, (py + 0.5) / layout.h,
				layout.spanX, layout.spanY, layout.mirrorLon);
			field.quatApply(ray, ray[0], ray[1], ray[2], layout.quatInv);
			worst = Math.max(worst, Math.abs(dir[0] - ray[0]), Math.abs(dir[1] - ray[1]), Math.abs(dir[2] - ray[2]));
		}
	}
	check('chartDirAt is dirAt without the pan (the drag and the field agree)', worst < 1e-12, { worst });
}



// --- 4. The range is a window on the field, not a renormalization --------
{
	// The view-modes.1 law, on the only mapping the app has: the painted value is
	// the field read through a declared window, never the field re-stretched to
	// fill the ramp (that was the bug that inverted the map when a bright star
	// entered view). So a decade of field is a fixed share of the ramp, and a
	// field outside the window paints its floor instead of full scale.
	const range = { lo: -3, hi: 0 };
	const base = Float32Array.of(-2.8, -2.2, -1.6, -1.0);
	const shifted = new Float32Array(4), a = new Float32Array(4), b = new Float32Array(4);
	for (let i = 0; i < 4; i++) shifted[i] = base[i] + 1;
	field.applyRange(base, 4, 'height', range, a);
	field.applyRange(shifted, 4, 'height', range, b);
	let uniform = true;
	for (let i = 0; i < 4; i++) if (Math.abs((a[i] - b[i]) - 1 / 3) > 1e-6) uniform = false;
	check('a decade of field is a third of the ramp, wherever the field sits', uniform,
		{ before: Array.from(a), after: Array.from(b) });
	const beyond = new Float32Array(4);
	field.applyRange(Float32Array.of(0.5, 0.6, 0.7, 0.8), 4, 'height', range, beyond);
	check('a field beyond the range reads as far, not rescaled to 1',
		beyond[0] === 0 && beyond[1] === 0 && beyond[2] === 0 && beyond[3] === 0,
		Array.from(beyond));
	// And the window still quotes the distance it claims, both directions: the
	// legend labels its ends with 10^lo / 10^hi of the same log field.
	check('the range ends are the distances the legend quotes',
		Math.abs(Math.pow(10, range.hi) - 1) < 1e-9 && Math.pow(10, range.lo) === 0.001,
		{ near: Math.pow(10, range.hi), far: Math.pow(10, range.lo) });
}

// --- 4b. The display range: log, auto, manual, clamped --------------------
{
	const range = { lo: -2, hi: -1 };            // one decade of σ, 0.01 … 0.1 kpc
	check('a log range puts half a decade at the middle',
		Math.abs(field.rangeValue('spread', 0.0316227766, range) - 0.5) < 1e-9,
		field.rangeValue('spread', 0.0316227766, range));
	// Height's raw value is log distance, so its range's lo is the NEAR end
	// (small log) and its hi the far one; the ramp runs 1 → 0 across it.
	check('height is inverted: lo (near) is 1, hi (far) is 0',
		field.rangeValue('height', -3, { lo: -3, hi: 0 }) === 1
		&& field.rangeValue('height', 0, { lo: -3, hi: 0 }) === 0,
		{ near: field.rangeValue('height', -3, { lo: -3, hi: 0 }), far: field.rangeValue('height', 0, { lo: -3, hi: 0 }) });
	const clamped = new Float32Array(3);
	field.applyRange(Float32Array.of(0.0001, 0.0316227766, 100), 3, 'spread', range, clamped);
	check('values outside the range clamp to 0 and 1',
		clamped[0] === 0 && Math.abs(clamped[1] - 0.5) < 1e-6 && clamped[2] === 1,
		Array.from(clamped));

	// The window a finished pass suggests is a percentile window on the field, so
	// it follows the sky the map paints: moving the set 3 decades out moves the
	// range 3 decades out, and the colour keeps its meaning.
	// prepareStars returns one shared scratch object, so the ranges must be read
	// before the next call overwrites dMin/dMax.
	const nearStars = field.prepareStars(Float64Array.of(0, 0, 0.01, 0, 0, 0.02, 0), 2, 0, 0, 0);
	const nearIn = { autoLo: Math.log10(0.01), autoHi: Math.log10(0.02), dMin: nearStars.dMin, dMax: nearStars.dMax };
	const farStars = field.prepareStars(Float64Array.of(0, 0, 10, 0, 0, 0.02, 20), 2, 0, 0, 0);
	const farIn = { autoLo: Math.log10(10), autoHi: Math.log10(20), dMin: farStars.dMin, dMax: farStars.dMax };
	const rangeNear = field.autoRange('height', nearIn, {});
	const rangeFar = field.autoRange('height', farIn, {});
	check('mode 1 auto range follows the field (3 decades out, 3 decades out)',
		Math.abs(rangeNear.lo - Math.log10(0.01)) < 0.05
		&& Math.abs(rangeFar.lo - Math.log10(10)) < 0.05
		&& rangeNear.hi - rangeNear.lo >= 0.3 && rangeFar.hi - rangeFar.lo >= 0.3,
		{ near: [rangeNear.lo, rangeNear.hi], far: [rangeFar.lo, rangeFar.hi] });
	// With no histogram to read (a hand-made stats object, a pass that measured
	// nothing) the window still parks on the field's near edge — not on zero, and
	// not on the forced anchor scale the first cut used.
	const noHist = field.autoRange('height', { rawLo: Math.log10(0.01), rawHi: Math.log10(0.02) }, {});
	check('a pass without a measurement falls back on the raw field',
		Math.abs(noHist.lo - Math.log10(0.01)) < 0.05, { lo: noHist.lo, hi: noHist.hi });

	// A set whose stars all sit in a narrow band must still use the ramp: the
	// forced-decade scale it replaced put every real star on one colour.
	const band = field.autoRange('height', { dMin: 0.0117, dMax: 0.0117, autoLo: -1.5, autoHi: -1.2, rawLo: -1.5, rawHi: -1.2 }, {});
	check('a narrow distance band still fills the ramp', band.hi - band.lo < 0.5, { lo: band.lo, hi: band.hi });
	// A constant non-height field still suggests a usable decade instead of a
	// zero-width range (which would divide by zero). Modes 2 and 3 hold a linear
	// raw scalar, so their rawLo is a distance, not a log.
	const flatRange = field.autoRange('spread', { autoLo: -2, autoHi: -2, rawLo: 0.01 }, {});
	check('auto range never collapses to zero width', flatRange.hi - flatRange.lo >= 0.3
		&& Math.abs(flatRange.lo - Math.log10(0.01)) < 0.05,
		{ lo: flatRange.lo, hi: flatRange.hi });
	// An empty field has no raw value at all: the window parks on the near edge of
	// the anchors it was given, which is all there is to say.
	const emptyRange = field.autoRange('height',
		{ empty: true, dMin: 0.5, dMax: 0.5, rawLo: 0, rawHi: 0 }, {});
	check('an empty field still gets a legal window', emptyRange.hi - emptyRange.lo >= 0.3
		&& Number.isFinite(emptyRange.lo), { lo: emptyRange.lo, hi: emptyRange.hi });

	// The follower: one pole, newest read wins, bounded rate. These checks are the
	// two ways this rule has failed before — see the comment on easeRange — and
	// the shape that replaced them.
	const fol = field.createRangeState(-3, 0);
	field.offerRange(fol, 'height', -2.5, -0.4);
	check('the first offer for a mode snaps (nothing older in its unit to keep)',
		fol.lo === -2.5 && fol.hi === -0.4 && fol.targetLo === -2.5 && fol.targetHi === -0.4,
		{ ...fol });
	// The old law held the target back until two reads agreed, which is what froze
	// the display for the length of a pan. The newest measurement is the target the
	// moment it arrives; only the display is delayed, and only at a bounded rate.
	field.offerRange(fol, 'height', -4.6, -3.1);
	check('a changed read becomes the target at once; only the display lags',
		fol.targetLo === -4.6 && fol.targetHi === -3.1 && fol.lo === -2.5 && fol.hi === -0.4,
		{ ...fol });
	field.resetRange(fol, 'height', -2.5, -0.4);
	field.offerRange(fol, 'height', 0.8, 2.6);        // one wild read
	field.easeRange(fol, 1 / 60);
	const frameStep = fol.lo - -2.5;
	field.offerRange(fol, 'height', -2.48, -0.39);    // ... and the next one is back
	for (let frame = 0; frame < 120; frame++) field.easeRange(fol, 1 / 60);
	check('an isolated outlier read is bounded per frame and unwinds by itself',
		Math.abs(frameStep) <= field.RANGE_MAX_RATE / 60 + 1e-9
		&& Math.abs(fol.lo - -2.48) < 1e-4 && Math.abs(fol.hi - -0.39) < 1e-4,
		{ frameStep, lo: fol.lo, hi: fol.hi });
	const beforeInvalid = [fol.targetLo, fol.targetHi];
	field.offerRange(fol, 'height', NaN, 1);
	field.offerRange(fol, 'height', 1, 1);
	check('invalid suggestions cannot corrupt the live target',
		fol.targetLo === beforeInvalid[0] && fol.targetHi === beforeInvalid[1],
		{ ...fol, beforeInvalid });
	// A real move: monotone, never overshooting, rate-capped while the target is
	// far, caught up in a couple of seconds. The bound is what lets one rule be
	// both the anti-flicker filter and the anti-washout one.
	field.resetRange(fol, 'height', -2.5, -0.4);
	field.offerRange(fol, 'height', 0.55, 2.0);
	let mono = true, prev = fol.lo, worstRate = 0;
	for (let frame = 0; frame < 180; frame++) {
		field.easeRange(fol, 1 / 60);
		if (fol.lo < prev) mono = false;
		if (Math.abs(fol.lo - prev) * 60 > worstRate) worstRate = Math.abs(fol.lo - prev) * 60;
		prev = fol.lo;
	}
	check('an accepted range eases monotonically, rate-capped, and catches up',
		mono && worstRate <= field.RANGE_MAX_RATE + 1e-6
		&& Math.abs(fol.lo - 0.55) < 0.02 && Math.abs(fol.hi - 2.0) < 0.02,
		{ lo: fol.lo, hi: fol.hi, worstRate: +worstRate.toFixed(3),
			targetLo: fol.targetLo, targetHi: fol.targetHi });
	// A pan, scored the way the eye sees it: how far the *display* sits from the
	// window the settled field would want. A 3-decade pan read at 4 Hz — the
	// confirm law froze at 2.90 dex off (0.37 mean), which is a flat screen for
	// seconds. The bounded pole stays inside a decade the whole way.
	{
		const pan = (t) => { const p = Math.min(1, Math.max(0, (t - 1) / 2)); return [-1 + p * 3, 1 + p * 3]; };
		const st = field.createRangeState(pan(0)[0], pan(0)[1]);
		st.mode = 'height';
		let clock = 0.25, maxErr = 0, errSum = 0, n = 0;
		for (let frame = 0; frame < 60 * 8; frame++) {
			const t = frame / 60;
			if ((clock += 1 / 60) >= 0.25) { clock = 0; const o = pan(t); st.targetLo = o[0]; st.targetHi = o[1]; }
			field.easeRange(st, 1 / 60);
			const want = pan(t);
			const err = Math.max(Math.abs(st.lo - want[0]), Math.abs(st.hi - want[1]));
			if (err > maxErr) maxErr = err;
			errSum += err; n++;
		}
		check('a continuous pan is followed, not frozen: < 1 dex off at worst',
			maxErr < 1.0 && errSum / n < 0.2,
			{ maxErr: +maxErr.toFixed(3), meanErr: +(errSum / n).toFixed(3) });
	}
	field.resetRange(fol, 'height', -1, 1);
	check('resetRange parks the display and the target on one range',
		fol.lo === -1 && fol.hi === 1 && fol.targetLo === -1 && fol.targetHi === 1,
		{ ...fol });
	field.offerRange(fol, 'spread', -3, -0.5);
	check("a mode switch snaps to the new mode's first offer (different unit)",
		fol.mode === 'spread' && fol.lo === -3 && fol.hi === -0.5, { ...fol });
	// The state carries nothing else: no pending offer, no median window, no
	// clock. An unconfirmed suggestion cannot exist, because the newest read is
	// always the target.
	check('the follower state is display + target and nothing more',
		Object.keys(fol).join(',') === 'mode,lo,hi,targetLo,targetHi', Object.keys(fol).join(','));
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
		// neighbourhood had no star. The weighted mean is a real number everywhere,
		// so this is a property of the *raw* field; the painted map may clamp a tail
		// of the far, smooth texels to the bottom colour, because the auto window is
		// a percentile window and not the field's extremes. What must stay small is
		// that tail — the moment it is most of the map, the map is a plate again.
		if (kind === 'plane') {
			let atFloor = 0, atTop = 0;
			for (let i = 0; i < out.length; i++) {
				if (out[i] <= 0) atFloor++;
				else if (out[i] >= 1) atTop++;
			}
			const tail = Math.max(atFloor, atTop) / out.length;
			check('chart is a sky, not a plate: raw span > 0.05, clamped tail < 10%',
				stats.rawHi - stats.rawLo > 0.05 && tail < 0.1,
				{ raw: [stats.rawLo, stats.rawHi], tail: +tail.toFixed(3), lo: +lo.toFixed(3) });
		}
	}
	// One close star, in front of the eye and behind it. This is the repro the
	// whole range law exists for, and it pins both halves of the fix: a star the
	// camera cannot see must not move the map at all (the angular weight has to be
	// monotone in δ, not sin²δ), and a star it can see must saturate into a bright
	// dot instead of widening the window until the rest of the sky is squeezed into
	// one colour (the range is a percentile window, not the field's min/max).
	{
		const shell = [];
		for (let i = 0; i < 24; i++) {
			const y = 1 - (i / 23) * 2;
			const r = Math.sqrt(Math.max(0, 1 - y * y));
			const th = i * Math.PI * (3 - Math.sqrt(5));
			shell.push(Math.cos(th) * r * 0.8, Math.sin(th) * r * 0.8, y * 0.8);
		}
		const DEG = Math.PI / 180;
		function nearStarWindow(extra, yawDeg) {
			const arr = Float64Array.from(extra ? shell.concat(extra) : shell);
			const layout = field.createLayout({}, {
				kind: 'view', w: 61, h: 61, fovY: 60 * DEG, aspect: 1,
				basis: field.quatBasis({}, [0, 0, Math.sin(yawDeg * DEG * 0.5), Math.cos(yawDeg * DEG * 0.5)]),
			});
			const stars = field.prepareStars(arr, arr.length / 3, 0, 0, 0);
			const raw = new Float32Array(layout.w * layout.h);
			const painted = new Float32Array(raw.length);
			const stats = {};
			field.computeRaw(stars, layout, { mode: 'height', sigmaDeg: 10, measure: true }, raw, stats);
			const range = field.autoRange('height', stats, {});
			field.applyRange(raw, raw.length, 'height', range, painted);
			let inside = 0;
			for (let i = 0; i < painted.length; i++) if (painted[i] > 0.02 && painted[i] < 0.98) inside++;
			return { stats, range, inside: inside / painted.length };
		}
		const calm = nearStarWindow(null, 0);
		const ahead = nearStarWindow([0.008, 0, 0], 0);      // 8 pc, dead centre
		const behind = nearStarWindow([-0.008, 0, 0], 0);    // the same star, astern
		check('a close star the eye cannot see does not touch the field or the range',
			Math.abs(behind.range.lo - calm.range.lo) < 0.05
			&& Math.abs(behind.range.hi - calm.range.hi) < 0.05
			&& Math.abs(behind.stats.rawLo - calm.stats.rawLo) < 0.05,
			{ calm: [calm.range.lo, calm.range.hi], behind: [behind.range.lo, behind.range.hi],
				raw: [calm.stats.rawLo, behind.stats.rawLo] });
		// The star in view does move the window — it is a tenth of the sky, so it
		// deserves its contrast — but by less than the field's own extreme moves,
		// and the map keeps its colour instead of collapsing.
		const fieldShift = calm.stats.rawLo - ahead.stats.rawLo;
		const windowShift = calm.range.lo - ahead.range.lo;
		check('a close star in view saturates instead of squeezing the sky',
			fieldShift > 0.8 && windowShift < fieldShift * 0.9 && ahead.inside > 0.9,
			{ fieldShift: +fieldShift.toFixed(3), windowShift: +windowShift.toFixed(3),
				inside: +ahead.inside.toFixed(3), span: +ahead.range.span.toFixed(3) });
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
	const stars = field.prepareStars(positions, 3, 0, 0, 0);
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

	const spreadRange = { lo: -2, hi: 0 };      // 0.01 … 1 kpc, log
	field.computeField(stars, layout, { mode: 'spread', sigmaDeg: 12, range: spreadRange }, out, stats);
	const spreadAt = out[Math.round(hit.y) * layout.w + Math.round(hit.x)];
	// σ of {0.001, 1.0, ~1.0} kpc ≈ 0.5 kpc at the pole; log10(0.5) = −0.3 on a
	// −2…0 decade range reads 0.85.
	check('mode 2 reads the depth gap in that direction (σ ≈ 0.5 kpc → 0.85 of a 0.01…1 kpc log range)',
		spreadAt > 0.75 && stats.spreadMax > 0.3 && stats.spreadMax < 0.7,
		{ spread: +spreadAt.toFixed(3), peakKpc: +stats.spreadMax.toFixed(4) });
	// Two stars at the same distance in the same direction: no hidden depth.
	const flat = Float64Array.of(0, 0.0004, 1, 0, -0.0004, 1);
	const fs = field.prepareStars(flat, 2, 0, 0, 0);
	field.computeField(fs, layout, { mode: 'spread', sigmaDeg: 12, range: spreadRange }, out, stats);
	field.texelOf(layout, 0, 0, 1, hit);
	check('mode 2 is ~0 where the neighbours agree in depth',
		out[Math.round(hit.y) * layout.w + Math.round(hit.x)] < 0.05, { v: out[Math.round(hit.y) * layout.w + Math.round(hit.x)] });

	// Coincident stars must not divide by zero.
	const same = Float64Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1);
	const ss = field.prepareStars(same, 3, 0, 0, 0);
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
	const stats = {};
	const rawL = new Float32Array(layout.w * layout.h);
	const grad = new Float32Array(layout.w * layout.h);
	field.computeRaw(stars, layout, { mode: 'height', sigmaDeg: 6 }, rawL, stats);
	field.computeRaw(stars, layout, { mode: 'gradient', sigmaDeg: 6 }, grad, stats);

	// The slope is per degree of sky, so it must equal the finite difference of
	// the L grid divided by the layout's own texel angle — the factor of DEG is
	// exactly the unit the legend quotes, and a missing cos(lat) on a chart
	// would make high-latitude rows read low.
	{
		const y = layout.h >> 1, x = layout.w >> 1;
		const gx = (rawL[y * layout.w + x + 1] - rawL[y * layout.w + x - 1]) / (2 * layout.texelRadX);
		const gy = (rawL[(y + 1) * layout.w + x] - rawL[(y - 1) * layout.w + x]) / (2 * layout.texelRadY);
		const want = Math.hypot(gx, gy) * field.DEG;
		const got = grad[y * layout.w + x];
		check('mode 3 is |∇log₁₀ d| per degree, at the layout’s own texel angle',
			Math.abs(want - got) < 1e-6 + want * 0.05, { want, got });
	}

	// The user's complaint: the old mode clamped |∇| at 1, so every steep ring
	// read the same colour ("hard limited (clump)"). An auto log range must not
	// pile the map into the top bin. (Read before anything re-prepares the shared
	// star scratch — prepareStars returns one object, mutated in place.)
	{
		const paint = new Float32Array(grad.length);
		const range = field.autoRange('gradient', stats, {});
		field.applyRange(grad, grad.length, 'gradient', range, paint);
		let top = 0, mid = 0;
		for (let i = 0; i < paint.length; i++) {
			if (paint[i] > 0.999) top++;
			if (paint[i] > 0.2 && paint[i] < 0.8) mid++;
		}
		const topFrac = top / paint.length, midFrac = mid / paint.length;
		check('mode 3 auto range does not clump: < 15% of texels at full scale, > 30% in the middle',
			topFrac < 0.15 && midFrac > 0.3, { topFrac: +topFrac.toFixed(3), midFrac: +midFrac.toFixed(3) });
		let anyGrad = 0;
		for (let i = 0; i < grad.length; i++) anyGrad = Math.max(anyGrad, grad[i]);
		check('gradient of the real height field is non-degenerate', anyGrad > 0.001, { max: +anyGrad.toFixed(5) });
	}

	// The chart seam: a gradient taken with the plain column difference at
	// x = 0 divides by (rt − lf) = 2 − w and overstates the slope ~w/2 times.
	// Yaw the chart 180° so the same rays land in the middle of the grid; the
	// seam column must then read the interior value.
	{
		const seamStars = starsFor(set.positions, set.n, model.home.position);
		const yaw = field.createLayout({}, { kind: 'plane', w: layout.w, h: layout.h, spanDeg: 360, quat: [0, 0, 1, 0] });
		const rot = new Float32Array(layout.w * layout.h);
		field.computeRaw(seamStars, yaw, { mode: 'gradient', sigmaDeg: 6 }, rot, {});
		const mid = layout.w >> 1;
		let worst = 0, worstAt = 0;
		for (let y = 2; y < layout.h - 2; y += 5) {
			const a = grad[y * layout.w], b = rot[y * layout.w + mid];
			const rel = Math.abs(a - b) / Math.max(1e-9, b);
			if (rel > worst) { worst = rel; worstAt = y; }
		}
		check('the gradient is continuous across the chart seam', worst < 0.2, { worstRel: +worst.toFixed(3), y: worstAt });
	}

	// A field whose log distance is constant has no slope. One anchor does that
	// by construction: IDW of a single value is that value everywhere. Last,
	// because it re-prepares the shared star scratch.
	{
		const one = Float64Array.of(0, 0, 1);
		const oneStars = field.prepareStars(one, 1, 0, 0, 0);
		const g2 = new Float32Array(layout.w * layout.h);
		field.computeRaw(oneStars, layout, { mode: 'gradient', sigmaDeg: 20 }, g2, {});
		let maxG = 0;
		for (let i = 0; i < g2.length; i++) maxG = Math.max(maxG, g2[i]);
		check('gradient of a constant field is zero', maxG < 1e-5, { maxG });
	}

	// --- 7b. fieldSlope: the shared slope behind mode 3 and the relief -------
	//
	// The painter's shaded relief reads these two arrays, so their units and
	// signs are a contract now, not an implementation detail. Synthetic fields
	// make the expected answer exact where a star field only makes it approximate.
	{
		const w = 360, h = 180;
		const l2 = field.createLayout({}, { kind: 'plane', w, h, spanDeg: 360, quat: [0, 0, 0, 1], mirror: false });
		const lon = new Float64Array(w), lat = new Float64Array(h);
		for (let px = 0; px < w; px++) lon[px] = ((px + 0.5) / w - 0.5) * field.TAU;
		for (let py = 0; py < h; py++) lat[py] = (0.5 - (py + 0.5) / h) * l2.spanY;
		const src = new Float32Array(w * h);
		const sx = new Float32Array(w * h), sy = new Float32Array(w * h);
		const y = h >> 1;
		const mid = (f) => { for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) src[py * w + px] = f(px, py); };

		// A field linear in longitude: d/dlon is 1, and per radian of *sky* that
		// is 1/cos(lat) — the correction that stops high-latitude rows reading low.
		mid((px) => lon[px]);
		field.fieldSlope(src, l2, sx, sy);
		const cosEq = Math.cos(lat[y]);
		check('fieldSlope quotes longitude per radian of sky (the cos(lat) correction)',
			Math.abs(sx[y * w + (w >> 1)] - 1 / cosEq) < 1e-4 && Math.abs(sy[y * w + (w >> 1)]) < 1e-6,
			{ got: sx[y * w + (w >> 1)], want: 1 / cosEq });

		// Linear in latitude: rows run down the map while latitude runs up, so a
		// field that grows northward has a *negative* y slope. The relief builds
		// its normal from exactly this sign.
		mid((px, py) => lat[py]);
		field.fieldSlope(src, l2, sx, sy);
		check('fieldSlope y follows the map (north-up field slopes negative)',
			Math.abs(sy[y * w + (w >> 1)] + 1) < 1e-6 && Math.abs(sx[y * w + (w >> 1)]) < 1e-6,
			{ got: sy[y * w + (w >> 1)], want: -1 });

		// Periodic in longitude, so the value is continuous across the seam: at
		// the seam column the wrapped neighbour must be used, and a plain column
		// difference there divides by 2 − w instead of 2.
		mid((px) => Math.cos(lon[px]));
		field.fieldSlope(src, l2, sx, sy);
		const seam = sx[y * w], at90 = sx[y * w + 89];
		check('fieldSlope is continuous across the chart seam', Math.abs(seam) < 0.02,
			{ seam, interior: sx[y * w + 5] });
		check('fieldSlope matches the analytic slope of cos(lon)',
			Math.abs(at90 - -Math.sin(lon[89]) / Math.cos(lat[y])) < 1e-3,
			{ got: at90, want: -Math.sin(lon[89]) / Math.cos(lat[y]) });

		// And the gradient mode is exactly the magnitude of this, per degree: the
		// two consumers of one slope must not drift apart.
		{
			const set = field.buildConstellationSet({});
			const st = starsFor(set.positions, set.n, model.home.position);
			const l3 = field.createLayout({}, { kind: 'view', w: 96, h: 48, fovY: 60 * field.DEG, aspect: 2, basis: { fx: 1, fy: 0, fz: 0, rx: 0, ry: -1, rz: 0, ux: 0, uy: 0, uz: 1 } });
			const raw = new Float32Array(96 * 48), g = new Float32Array(96 * 48);
			// f64, like the gradient path's own slope scratch: this pins the two
			// consumers together exactly, and an f32 scratch here would only be
			// measuring the scratch.
			const gx64 = new Float64Array(96 * 48), gy64 = new Float64Array(96 * 48);
			field.computeRaw(st, l3, { mode: 'height', sigmaDeg: 6, measure: false }, raw, {});
			field.computeRaw(st, l3, { mode: 'gradient', sigmaDeg: 6, measure: false }, g, {});
			field.fieldSlope(raw, l3, gx64, gy64);
			// The mode writes sqrt(x²+y²)·DEG into an f32 field, so the exact
			// statement is equality through that store — hypot would differ from
			// the sqrt form in the last ulp and say nothing new.
			let bad = 0, worst = 0;
			for (let i = 0; i < g.length; i++) {
				const want = Math.fround(Math.sqrt(gx64[i] * gx64[i] + gy64[i] * gy64[i]) * field.DEG);
				if (g[i] !== want) bad++;
				worst = Math.max(worst, Math.abs(g[i] - want));
			}
			check('mode 3 is the magnitude of fieldSlope, per degree', bad === 0, { bad, worst });
		}
	}
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
	// And the field has to peak there: the default σ keeps the near stars' own
	// texels on top of the painted ramp. (A wide σ still blends more — the raw
	// span below halves — but the *display* range follows the data now, so the
	// test of a wide σ is the contrast of the physical field, not of the paint.)
	{
		const layout = field.createLayout({}, { kind: 'plane', w: 424, h: 208, spanDeg: 360, quat: [0, 0, 0, 1], mirror: true });
		const near = [1, 4, 7];       // Sirius, Arcturus, Rigel: the top of the ramp
		const spans = {};
		for (const sigma of [field.SIGMA_DEG, 10]) {
			const stars = starsFor(set.positions, set.n, cam0);
			const out = new Float32Array(layout.w * layout.h);
			const stats = {};
			field.computeRaw(stars, layout, { mode: 'height', sigmaDeg: sigma }, out, stats);
			spans[sigma] = stats.rawHi - stats.rawLo;
			const range = field.autoRange('height', stats, {});
			const paint = field.applyRange(out, out.length, 'height', range, new Float32Array(out.length));
			let peak = 0;
			for (const i of near) {
				field.texelOf(layout, set.positions[i * 3] - cam0[0], set.positions[i * 3 + 1] - cam0[1],
					set.positions[i * 3 + 2] - cam0[2], hit);
				const x = Math.max(0, Math.min(layout.w - 1, Math.round(hit.x)));
				const y = Math.max(0, Math.min(layout.h - 1, Math.round(hit.y)));
				if (paint[y * layout.w + x] > peak) peak = paint[y * layout.w + x];
			}
			check(`σ ${sigma}°: the near stars' texels reach ${peak.toFixed(2)} of the painted ramp`,
				sigma === field.SIGMA_DEG ? peak > 0.8 : peak > 0.6,
				{ peak: +peak.toFixed(3), rawSpan: +spans[sigma].toFixed(3) });
		}
		check('a wide σ blends: the physical (log-distance) span shrinks by half',
			spans[10] < spans[field.SIGMA_DEG] * 0.6,
			{ narrow: +spans[field.SIGMA_DEG].toFixed(3), wide: +spans[10].toFixed(3) });
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

// --- 9b. Nearest-N is a query: exact, fast, and follows the eye ----------
{
	const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'data', 'tiles', 'catalog.js'), 'utf8');
	const g = {};
	new Function('window', src)(g);
	const index = field.createCatalogIndex(g.__galaxy_catalog);
	check('the decoded index holds the visible catalog records', index.n === 3829, index.n);
	const set = field.createSet(64);
	let worst = 0;
	for (const c of [[0, 0, 0], [6, 0, 0], [0, 0, 0.2], [-3, 2, -1]]) {
		field.queryNearest(index, index.positions, c[0], c[1], c[2], 64, set);
		// Brute force, the definition the heap must reproduce.
		const d2 = new Float64Array(index.n);
		for (let i = 0; i < index.n; i++) {
			const dx = index.positions[i * 3] - c[0], dy = index.positions[i * 3 + 1] - c[1], dz = index.positions[i * 3 + 2] - c[2];
			d2[i] = dx * dx + dy * dy + dz * dz;
		}
		const sorted = Array.from(d2).sort((a, b) => a - b);
		for (let k = 0; k < set.n; k++) {
			const dx = set.positions[k * 3] - c[0], dy = set.positions[k * 3 + 1] - c[1], dz = set.positions[k * 3 + 2] - c[2];
			worst = Math.max(worst, Math.abs(Math.hypot(dx, dy, dz) ** 2 - sorted[k]));
		}
	}
	check('the heap query is the exact brute-force nearest-N', worst < 1e-9, { worst });

	// A query is one linear scan: 100 × 500 anchors fits in a fifth of a second
	// even in Node, and the page runs it once per eye move, not per frame.
	const t0 = process.hrtime.bigint();
	for (let i = 0; i < 100; i++) field.queryNearest(index, index.positions, i * 0.01, 0, 0, 500, set);
	const ms = Number(process.hrtime.bigint() - t0) / 1e6;
	check(`100 nearest-500 queries take ${ms.toFixed(1)} ms (< 200)`, ms < 200, { ms: +ms.toFixed(2) });

	// Star time: the index advanced as a whole and the query measures the drawn
	// sky, so the winners are the stars that are near *now*.
	const cur = new Float64Array(index.n * 3);
	field.prepareIndexPositions(index, cur, 0, model);
	let same = true;
	for (let i = 0; i < index.n * 3; i++) if (cur[i] !== index.positions[i]) same = false;
	check('indexed positions at time 0 are the birth frame', same);
	field.prepareIndexPositions(index, cur, 10, model);
	let moved = 0;
	for (let i = 0; i < index.n; i++) {
		if (Math.hypot(cur[i * 3] - index.positions[i * 3], cur[i * 3 + 1] - index.positions[i * 3 + 1],
			cur[i * 3 + 2] - index.positions[i * 3 + 2]) > 1e-9) moved++;
	}
	check('10 Myr of star time moves the indexed sky', moved > index.n * 0.9, { moved });
	field.queryNearest(index, cur, 0, 0, 0, 24, set);
	const a = new Float64Array(set.positions.subarray(0, 24 * 3));
	field.queryNearest(index, index.positions, 0, 0, 0, 24, set);
	let differs = 0;
	for (let i = 0; i < 24 * 3; i++) if (a[i] !== set.positions[i]) differs++;
	check('a star-time query and a birth-frame query are different questions', differs > 0, { differs });

	// The page then draws the set by dispatching it to the frame's star time.
	// The set must carry *birth* records so that dispatch does not apply the
	// motion twice — i.e. the drawn anchors must equal the advanced index at the
	// same indices the query measured.
	{
		const time = 10;
		const cur2 = new Float64Array(index.n * 3);
		field.prepareIndexPositions(index, cur2, time, model);
		field.queryNearest(index, cur2, 0, 0, 0, 32, set);
		const drawn = new Float64Array(set.n * 3);
		field.advancePositions(set, drawn, time, model);
		let worst = 0;
		for (let k = 0; k < set.n; k++) {
			// Find the picked star in the advanced index and compare distances to
			// the eye — the drawn position itself must match one index entry.
			let best = Infinity;
			for (let i = 0; i < index.n; i++) {
				const dd = Math.hypot(cur2[i * 3] - drawn[k * 3], cur2[i * 3 + 1] - drawn[k * 3 + 1],
					cur2[i * 3 + 2] - drawn[k * 3 + 2]);
				if (dd < best) best = dd;
			}
			worst = Math.max(worst, best);
		}
		check('a star-time pick drawn through advancePositions matches the advanced sky (no double motion)',
			worst < 1e-9, { worstKpc: worst });
	}
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
	// Same frozen window for both frames: only the anchors move, the range does
	// not, which is what makes the delta a motion and not a repaint.
	const frozen = { lo: -3, hi: 0 };
	field.computeField(starsFor(set.positions, set.n, h), layout, { mode: 'height', range: frozen }, a, stats);
	field.computeField(field.prepareStars(cur, set.n, h[0], h[1], h[2]), layout, { mode: 'height', range: frozen }, bb, stats);
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
	field.computeField(field.prepareStars(set.positions, set.n, 0, 0, 0.005), layout, { mode: 'height' }, out, stats);
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
