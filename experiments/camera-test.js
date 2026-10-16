// experiments/camera-test.js
// Validates the camera: basis, WebGPU projection, frame-rate independence,
// input consumption, allocation behaviour, and the 0.1.1 model — ly/s speeds,
// whole-notch wheel, Shift/Ctrl factors, fly / orbit-centre / orbit-object
// modes, home and reset.
//
// These are the properties that make the fly-through feel right; the previous
// implementation failed several of them (per-frame damping, OpenGL-style
// projection, per-frame matrix allocations), and the first orbit plan would
// have failed others (trackpad wheel rounding to zero, a speed grid that could
// not return to x1). The current orientation model is quaternion-based, so the
// tests also cover pole-crossing and a non-degenerate right/up basis there.
//
// Output: experiments/logs/camera.json

'use strict';

const fs = require('fs');
const path = require('path');
const cameraModule = require('../src/core/camera.js');

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
	return !!pass;
}

function freshInput() {
	return {
		keys: { forward: false, back: false, left: false, right: false, up: false, down: false, boost: false, slow: false },
		lookDx: 0,
		lookDy: 0,
		wheelDelta: 0,
		// Only what camera.step still consumes (ui.4): mode switches need the
		// app's selection store, so main.js owns orbitCentre/orbitObject/flyMode.
		actions: { reset: 0, home: 0, exposure: 0 },
	};
}

const DT = 1 / 60;
const NOTCH = cameraModule.WHEEL_NOTCH_PX;

function run(camera, input, frames, dt) {
	for (let i = 0; i < frames; i++) camera.step(dt || DT, input);
}

function pressAction(camera, name) {
	const input = freshInput();
	input.actions[name] = 1;
	camera.step(DT, input);
	return input;
}

function scroll(camera, units) {
	const input = freshInput();
	input.wheelDelta = units;
	camera.step(DT, input);
}

function distanceTo(state, target) {
	return Math.hypot(state.position[0] - target[0], state.position[1] - target[1], state.position[2] - target[2]);
}

// 1 - cos(angle between the view direction and the direction to the target).
// Quaternion orientation means yaw/pitch are diagnostics only; the public basis
// vectors are the source of truth.
function aimError(camera, target) {
	const s = camera.getState();
	const fx = camera.forward[0];
	const fy = camera.forward[1];
	const fz = camera.forward[2];
	const dx = target[0] - s.position[0];
	const dy = target[1] - s.position[1];
	const dz = target[2] - s.position[2];
	return 1 - (fx * dx + fy * dy + fz * dz) / Math.hypot(dx, dy, dz);
}

function quatDot(a, b) {
	return Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
}

function angleError(a, b) {
	return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
}

// Transform a world point into clip space with the camera's current matrices.
function project(camera, x, y, z, aspect) {
	const m = camera.buildViewProj(aspect || 1);
	const px = x - camera.cameraPos[0];
	const py = y - camera.cameraPos[1];
	const pz = z - camera.cameraPos[2];
	// Column-major mat4 * vec4
	const cx = m[0] * px + m[4] * py + m[8] * pz + m[12];
	const cy = m[1] * px + m[5] * py + m[9] * pz + m[13];
	const cz = m[2] * px + m[6] * py + m[10] * pz + m[14];
	const cw = m[3] * px + m[7] * py + m[11] * pz + m[15];
	return { x: cx / cw, y: cy / cw, z: cz / cw, w: cw };
}

// --- Defaults ------------------------------------------------------------
{
	const camera = cameraModule.createCamera();
	check('camera starts at the Sun (0, 0, 5 pc)',
		camera.cameraPos[0] === 0 && camera.cameraPos[1] === 0 && Math.abs(camera.cameraPos[2] - 0.005) < 1e-7,
		Array.from(camera.cameraPos));
	check('camera looks toward the galactic centre (+X) by default',
		Math.abs(camera.forward[0] - 1) < 1e-6 && Math.abs(camera.forward[1]) < 1e-6 && Math.abs(camera.forward[2]) < 1e-6,
		Array.from(camera.forward));
	check('camera right at yaw 0 is -Y (screen right in a right-handed frame)',
		Math.abs(camera.right[0]) < 1e-6 && Math.abs(camera.right[1] + 1) < 1e-6,
		Array.from(camera.right));
	check('camera up at yaw 0 is +Z (north galactic pole)',
		Math.abs(camera.up[0]) < 1e-6 && Math.abs(camera.up[1]) < 1e-6 && Math.abs(camera.up[2] - 1) < 1e-6,
		Array.from(camera.up));
}

// --- Basis orthonormality over the reachable orientation space -----------
{
	const camera = cameraModule.createCamera();
	let worstDot = 0;
	let worstNorm = 0;
	const input = freshInput();
	for (let i = 0; i < 200; i++) {
		// Drive the camera through random orientations via look input.
		input.lookDx = (Math.sin(i * 12.9898) * 43758.5453 % 1) * 400;
		input.lookDy = (Math.sin(i * 78.233) * 12345.6789 % 1) * 60;
		camera.step(1 / 60, input);
		const f = camera.forward, r = camera.right, u = camera.up;
		const norm = (v) => Math.hypot(v[0], v[1], v[2]);
		worstNorm = Math.max(worstNorm, Math.abs(norm(f) - 1), Math.abs(norm(r) - 1), Math.abs(norm(u) - 1));
		worstDot = Math.max(worstDot,
			Math.abs(f[0] * r[0] + f[1] * r[1] + f[2] * r[2]),
			Math.abs(f[0] * u[0] + f[1] * u[1] + f[2] * u[2]),
			Math.abs(r[0] * u[0] + r[1] * u[1] + r[2] * u[2]));
	}
	check('basis stays orthonormal over 200 random orientations (norms)', worstNorm < 1e-6, worstNorm);
	check('basis stays orthonormal over 200 random orientations (dots)', worstDot < 1e-6, worstDot);
}

// --- Projection: WebGPU clip space, z in [0, 1] -------------------------
{
	const camera = cameraModule.createCamera();
	const aspect = 16 / 9;
	const m = camera.buildViewProj(aspect);

	// Build clip-space z for points along the view axis and check the mapping.
	function clipZ(depth, sign) {
		// Point `depth` kpc along -forward (in front of the camera).
		const p = [camera.cameraPos[0] + camera.forward[0] * depth * sign,
			camera.cameraPos[1] + camera.forward[1] * depth * sign,
			camera.cameraPos[2] + camera.forward[2] * depth * sign];
		return project(camera, p[0], p[1], p[2], aspect);
	}
	const near = clipZ(camera.near, 1);
	const far = clipZ(camera.far, 1);
	const mid = clipZ(10, 1);
	check('near plane maps to NDC z = 0', Math.abs(near.z) < 1e-3, near.z);
	check('far plane maps to NDC z = 1', Math.abs(far.z - 1) < 1e-3, far.z);
	check('mid distance stays inside [0, 1]', mid.z > 0 && mid.z < 1, mid.z);
	check('near plane has positive w', near.w > 0, near.w);

	// FOV: a point at the top edge of the frame (tan(fovY/2) * depth) is NDC y = 1.
	const depth = 5;
	const halfHeight = depth * Math.tan(camera.fovY / 2);
	const top = [camera.cameraPos[0] + camera.forward[0] * depth + camera.up[0] * halfHeight,
		camera.cameraPos[1] + camera.forward[1] * depth + camera.up[1] * halfHeight,
		camera.cameraPos[2] + camera.forward[2] * depth + camera.up[2] * halfHeight];
	const topNdc = project(camera, top[0], top[1], top[2], aspect);
	check('vertical FOV maps the top of the frame to NDC y = 1', Math.abs(topNdc.y - 1) < 1e-3, topNdc.y);

	// Aspect: the same offset along right at the same depth is NDC x = 1/aspect.
	const rightEdge = [camera.cameraPos[0] + camera.forward[0] * depth + camera.right[0] * halfHeight * aspect,
		camera.cameraPos[1] + camera.forward[1] * depth + camera.right[1] * halfHeight * aspect,
		camera.cameraPos[2] + camera.forward[2] * depth + camera.right[2] * halfHeight * aspect];
	const rightNdc = project(camera, rightEdge[0], rightEdge[1], rightEdge[2], aspect);
	check('aspect ratio maps the right edge of the frame to NDC x = 1', Math.abs(rightNdc.x - 1) < 1e-3, rightNdc.x);

	// Screen orientation: a star to the camera's right must have NDC x > 0, and
	// one "above" NDC y > 0. Sign errors here mirror the whole sky.
	const toRight = project(camera, camera.cameraPos[0] + camera.right[0] * 0.05 + camera.forward[0] * 2,
		camera.cameraPos[1] + camera.right[1] * 0.05 + camera.forward[1] * 2,
		camera.cameraPos[2] + camera.right[2] * 0.05 + camera.forward[2] * 2, aspect);
	const toUp = project(camera, camera.cameraPos[0] + camera.up[0] * 0.05 + camera.forward[0] * 2,
		camera.cameraPos[1] + camera.up[1] * 0.05 + camera.forward[1] * 2,
		camera.cameraPos[2] + camera.up[2] * 0.05 + camera.forward[2] * 2, aspect);
	check('a star to the right projects to positive NDC x', toRight.x > 0, toRight.x);
	check('a star above projects to positive NDC y', toUp.y > 0, toUp.y);

	// Behind the camera must not project into the frame.
	const behind = clipZ(5, -1);
	check('a star behind the camera has negative w (clipped)', behind.w < 0, behind.w);

	check('viewProj is a reused Float32Array', camera.viewProj === m && camera.viewProj instanceof Float32Array && camera.viewProj.length === 16);
}

// --- Projection at the old pitch pole ------------------------------------
{
	const camera = cameraModule.createCamera();
	const input = freshInput();
	input.lookDy = -0.5 * Math.PI / cameraModule.LOOK_SENSITIVITY;
	camera.step(DT, input);
	const aspect = 1;
	const depth = 2;
	const ahead = project(camera,
		camera.cameraPos[0] + camera.forward[0] * depth,
		camera.cameraPos[1] + camera.forward[1] * depth,
		camera.cameraPos[2] + camera.forward[2] * depth,
		aspect);
	const toRight = project(camera,
		camera.cameraPos[0] + camera.forward[0] * depth + camera.right[0] * 0.05,
		camera.cameraPos[1] + camera.forward[1] * depth + camera.right[1] * 0.05,
		camera.cameraPos[2] + camera.forward[2] * depth + camera.right[2] * 0.05,
		aspect);
	const toUp = project(camera,
		camera.cameraPos[0] + camera.forward[0] * depth + camera.up[0] * 0.05,
		camera.cameraPos[1] + camera.forward[1] * depth + camera.up[1] * 0.05,
		camera.cameraPos[2] + camera.forward[2] * depth + camera.up[2] * 0.05,
		aspect);
	check('looking straight up projects the forward point at screen centre', Math.abs(ahead.x) < 1e-6 && Math.abs(ahead.y) < 1e-6, ahead);
	check('looking straight up keeps the quaternion right axis on screen +X', toRight.x > 0, toRight);
	check('looking straight up keeps the quaternion up axis on screen +Y', toUp.y > 0, toUp);
}

// --- Frame-rate independence --------------------------------------------
{
	function travel(dt) {
		const camera = cameraModule.createCamera();
		const input = freshInput();
		input.keys.forward = true;
		let elapsed = 0;
		while (elapsed < 2.0 - 1e-9) {
			camera.step(dt, input);
			elapsed += dt;
		}
		const state = camera.getState();
		return Math.hypot(state.position[0], state.position[1], state.position[2] - 0.005);
	}
	const at60 = travel(1 / 60);
	const at144 = travel(1 / 144);
	const at30 = travel(1 / 30);
	const spread = Math.max(at60, at144, at30) - Math.min(at60, at144, at30);
	check('distance travelled is frame-rate independent (±1%)',
		spread / at60 < 0.01, { at30, at60, at144, spread });
	check('the camera actually moved (about 2 s at the base speed)',
		at60 > cameraModule.BASE_SPEED_KPC_S * 1.5 && at60 < cameraModule.BASE_SPEED_KPC_S * 2, at60);
}

// --- Velocity model ------------------------------------------------------
{
	const camera = cameraModule.createCamera();
	const input = freshInput();
	input.keys.forward = true;
	for (let i = 0; i < 120; i++) camera.step(1 / 60, input);
	const cruising = camera.getState();
	const expected = cameraModule.BASE_SPEED_KPC_S;
	check('velocity converges to the requested speed', Math.abs(cruising.velocity[0] - expected) / expected < 0.01, cruising.velocity[0]);
	input.keys.forward = false;
	for (let i = 0; i < 120; i++) camera.step(1 / 60, input);
	const stopped = camera.getState();
	check('velocity decays when keys are released', Math.hypot(stopped.velocity[0], stopped.velocity[1], stopped.velocity[2]) < expected * 0.01);

	input.keys.forward = true;
	input.keys.boost = true;
	for (let i = 0; i < 240; i++) camera.step(1 / 60, input);
	const boosted = camera.getState();
	check('boost multiplies speed by the documented factor',
		Math.abs(boosted.velocity[0] / expected - cameraModule.BOOST_FACTOR) < 0.05 * cameraModule.BOOST_FACTOR,
		boosted.velocity[0] / expected);
}

// --- Input consumption ---------------------------------------------------
{
	const camera = cameraModule.createCamera();
	const input = freshInput();
	input.lookDx = 100;
	input.lookDy = 0;
	input.wheelDelta = 400;
	const beforeYaw = camera.getState().yaw;
	camera.step(1 / 60, input);
	check('look deltas are consumed by step()', input.lookDx === 0 && input.lookDy === 0);
	check('wheel delta is consumed by step()', input.wheelDelta === 0);
	check('look input changes yaw by sensitivity * pixels',
		Math.abs((beforeYaw - camera.getState().yaw) - 100 * cameraModule.LOOK_SENSITIVITY) < 1e-9,
		camera.getState().yaw);
	input.actions.reset = 1;
	camera.step(1 / 60, input);
	check('reset action is consumed by step()', input.actions.reset === 0);

	// Wheel up (negative deltaY) must increase speed, wheel down decrease it.
	const scrolledUp = cameraModule.createCamera();
	const scrolledDown = cameraModule.createCamera();
	scroll(scrolledUp, -5 * NOTCH);
	scroll(scrolledDown, 5 * NOTCH);
	check('scroll up speeds up, scroll down slows down',
		scrolledUp.getState().speedMult > 1 && scrolledDown.getState().speedMult < 1,
		{ up: scrolledUp.getState().speedMult, down: scrolledDown.getState().speedMult });

	// Quaternion look is deliberately not pitch-clamped: a half-loop points back
	// along -X and leaves the camera upside down with a still-valid basis.
	const looper = cameraModule.createCamera();
	const i3 = freshInput();
	i3.lookDy = -Math.PI / cameraModule.LOOK_SENSITIVITY;
	looper.step(1 / 60, i3);
	check('look can loop past the old pitch pole without a clamp',
		looper.forward[0] < -0.999999 && looper.up[2] < -0.999999,
		{ forward: Array.from(looper.forward), up: Array.from(looper.up), pitch: looper.getState().pitch });
	check('PITCH_LIMIT is an unlimited compatibility export', cameraModule.PITCH_LIMIT === Infinity, cameraModule.PITCH_LIMIT);
}

// --- Reset ---------------------------------------------------------------
{
	const camera = cameraModule.createCamera();
	const input = freshInput();
	input.keys.forward = true;
	for (let i = 0; i < 60; i++) camera.step(1 / 60, input);
	input.keys.forward = false;
	input.actions.reset = 1;
	camera.step(1 / 60, input);
	const state = camera.getState();
	check('reset returns the camera to the start position',
		Math.abs(state.position[0]) < 1e-12 && Math.abs(state.position[1]) < 1e-12 && Math.abs(state.position[2] - 0.005) < 1e-12,
		state.position);
	check('reset clears velocity and speed multiplier',
		state.velocity[0] === 0 && state.velocity[1] === 0 && state.velocity[2] === 0 && state.speedMult === 1);
}

// --- Allocation behaviour ------------------------------------------------
{
	const camera = cameraModule.createCamera();
	const input = freshInput();
	const viewProj = camera.viewProj;
	const cameraPos = camera.cameraPos;
	const forward = camera.forward;
	const right = camera.right;
	const up = camera.up;
	let stable = true;
	for (let i = 0; i < 600; i++) {
		input.keys.forward = (i % 2) === 0;
		input.lookDx = i % 7;
		camera.step(1 / 60, input);
		camera.buildViewProj(1.5);
		stable = stable
			&& camera.viewProj === viewProj
			&& camera.cameraPos === cameraPos
			&& camera.forward === forward
			&& camera.right === right
			&& camera.up === up;
	}
	check('no buffers are reallocated across 600 frames', stable);
	check('getState honours a provided output object', (() => {
		const out = { position: [0, 0, 0], velocity: [0, 0, 0], orbitTarget: [0, 0, 0], orientation: [0, 0, 0, 1] };
		return camera.getState(out) === out && out.position === out.position && out.orientation.length === 4;
	})());
}

// --- 0.1.1: units and speed grid ------------------------------------------
{
	check('LY_TO_KPC is 1 ly in kpc (0.306601 pc)', Math.abs(cameraModule.LY_TO_KPC - 0.000306601) < 1e-12, cameraModule.LY_TO_KPC);
	check('the base speed is 8 ly/s', Math.abs(cameraModule.BASE_SPEED_KPC_S / cameraModule.LY_TO_KPC - 8) < 1e-9,
		cameraModule.BASE_SPEED_KPC_S / cameraModule.LY_TO_KPC);
	const isPowerOfTwo = (x) => Number.isInteger(Math.log2(x));
	check('speed multiplier clamps are powers of two (the x2 grid must return to exactly x1)',
		isPowerOfTwo(cameraModule.SPEED_MULT_MIN) && isPowerOfTwo(cameraModule.SPEED_MULT_MAX),
		{ min: cameraModule.SPEED_MULT_MIN, max: cameraModule.SPEED_MULT_MAX });
	check('the documented Shift / Ctrl factors are x100 / x0.1',
		cameraModule.BOOST_FACTOR === 100 && Math.abs(cameraModule.SLOW_FACTOR - 0.1) < 1e-12);

	const camera = cameraModule.createCamera();
	check('getState reports the default speed as 8 ly/s',
		Math.abs(camera.getState().speedLyPerSec - 8) < 1e-9, camera.getState().speedLyPerSec);

	scroll(camera, NOTCH);
	check('one notch down halves the speed multiplier', camera.getState().speedMult === 0.5, camera.getState().speedMult);
	scroll(camera, -NOTCH);
	scroll(camera, -NOTCH);
	check('one notch up doubles it, exactly back on the grid', camera.getState().speedMult === 2, camera.getState().speedMult);

	// Trackpads deliver many small deltas: they must add up to notches, and the
	// remainder must survive the frame instead of being discarded.
	const pad = cameraModule.createCamera();
	for (let i = 0; i < 10; i++) scroll(pad, -10);
	check('ten 10 px trackpad events make one notch', pad.getState().speedMult === 2, pad.getState().speedMult);
	scroll(pad, -250);
	check('250 px is two notches with 50 px carried over', pad.getState().speedMult === 8, pad.getState().speedMult);
	scroll(pad, -50);
	check('the carried 50 px plus 50 px completes the next notch', pad.getState().speedMult === 16, pad.getState().speedMult);
	scroll(pad, 30);
	check('a reverse scroll below one notch changes nothing yet', pad.getState().speedMult === 16, pad.getState().speedMult);
	scroll(pad, 70);
	check('the reverse remainder completes into a notch the other way', pad.getState().speedMult === 8, pad.getState().speedMult);

	scroll(pad, 100 * NOTCH);
	check('scrolling far down clamps at SPEED_MULT_MIN', pad.getState().speedMult === cameraModule.SPEED_MULT_MIN, pad.getState().speedMult);
	scroll(pad, -100 * NOTCH);
	check('scrolling far up clamps at SPEED_MULT_MAX', pad.getState().speedMult === cameraModule.SPEED_MULT_MAX, pad.getState().speedMult);
	scroll(pad, 8 * NOTCH);
	check('coming back from the clamp lands on the grid (x1 after 8 notches from x256)',
		pad.getState().speedMult === 1, pad.getState().speedMult);
}

// --- 0.1.1: Shift / Ctrl ----------------------------------------------------
{
	function cruise(boost, slow) {
		const camera = cameraModule.createCamera();
		const input = freshInput();
		input.keys.forward = true;
		input.keys.boost = boost;
		input.keys.slow = slow;
		run(camera, input, 300);
		const state = camera.getState();
		return { ratio: state.velocity[0] / cameraModule.BASE_SPEED_KPC_S, factor: state.speedFactor, lyPerSec: state.speedLyPerSec };
	}
	const boosted = cruise(true, false);
	const slowed = cruise(false, true);
	const both = cruise(true, true);
	check('Shift cruises at x100', Math.abs(boosted.ratio - 100) < 1, boosted);
	check('Ctrl cruises at x0.1', Math.abs(slowed.ratio - 0.1) < 0.001, slowed);
	check('Shift + Ctrl cruises at x10', Math.abs(both.ratio - 10) < 0.1, both);
	check('getState exposes the factor and the resulting ly/s',
		boosted.factor === 100 && Math.abs(boosted.lyPerSec - 800) < 1e-6 && slowed.factor === 0.1 && both.factor === 10,
		{ boosted, slowed, both });
}

// --- 0.1.1: mode cycle ------------------------------------------------------
{
	const camera = cameraModule.createCamera();
	const gc = cameraModule.GALACTIC_CENTRE_TARGET;
	check('the camera starts in fly mode', camera.getState().mode === cameraModule.MODE_FLY && camera.getState().modeName === 'fly',
		camera.getState().modeName);
	check('the orbit centre is the model\'s galactic centre (8.178, 0, 0)',
		gc[0] === 8.178 && gc[1] === 0 && gc[2] === 0, Array.from(gc));

	const before = camera.getState();
	const input = pressAction(camera, 'home');
	check('the home action is consumed by step()', input.actions.home === 0);
	// The fresh camera already stands at home, so the press kept the pose;
	// from here the modes are entered by setMode exactly as c/C/f do (ui.4).
	camera.setMode(cameraModule.MODE_ORBIT_GC);
	const orbitGc = camera.getState();
	check('setMode from fly enters orbit-centre (Shift+C)', orbitGc.mode === cameraModule.MODE_ORBIT_GC && orbitGc.modeName === 'orbit centre', orbitGc.modeName);
	check('orbit-centre targets the galactic centre',
		orbitGc.orbitTarget[0] === gc[0] && orbitGc.orbitTarget[1] === gc[1] && orbitGc.orbitTarget[2] === gc[2] && orbitGc.targetName === 'galactic centre',
		{ target: orbitGc.orbitTarget, name: orbitGc.targetName });
	check('entering orbit keeps the camera where it was (it turns, it does not move)',
		distanceTo(orbitGc, before.position) < 1e-9, { before: before.position, after: orbitGc.position });
	check('orbit distance is |Sun - centre|', Math.abs(orbitGc.orbitDistance - Math.hypot(8.178, 0, 0.005)) < 1e-9, orbitGc.orbitDistance);
	check('the camera looks at the target', aimError(camera, gc) < 1e-9, aimError(camera, gc));

	camera.setMode(cameraModule.MODE_ORBIT_OBJECT);
	const orbitObj = camera.getState();
	check('setMode enters orbit-object (c)', orbitObj.mode === cameraModule.MODE_ORBIT_OBJECT && orbitObj.modeName === 'orbit object', orbitObj.modeName);
	check('the default object target is the Sun',
		orbitObj.orbitTarget[0] === 0 && orbitObj.orbitTarget[1] === 0 && orbitObj.orbitTarget[2] === 0 && orbitObj.targetName === 'Sun',
		{ target: orbitObj.orbitTarget, name: orbitObj.targetName });
	// The start is straight above the Sun; quaternion aim reaches that vertical
	// direction exactly instead of sliding sideways to avoid a pitch pole.
	check('switching to the Sun target keeps the exact position and aims straight down',
		distanceTo(orbitObj, before.position) < 1e-12 && camera.forward[2] < -0.999999,
		{ moved: distanceTo(orbitObj, before.position), forward: Array.from(camera.forward), pitch: orbitObj.pitch });
	check('orbit distance to the Sun is the 5 pc start height', Math.abs(orbitObj.orbitDistance - 0.005) < 1e-12, orbitObj.orbitDistance);

	camera.setMode(cameraModule.MODE_FLY);
	const fly = camera.getState();
	check('setMode returns to the free fly camera (f)', fly.mode === cameraModule.MODE_FLY, fly.modeName);
	check('orbit -> fly is continuous: position and quaternion carry over, velocity is zero',
		distanceTo(fly, orbitObj.position) < 1e-12 && quatDot(fly.orientation, orbitObj.orientation) > 1 - 1e-12
		&& fly.velocity[0] === 0 && fly.velocity[1] === 0 && fly.velocity[2] === 0,
		{ fly, orbitObj });

	// setMode is idempotent and accepts the constants directly.
	camera.setMode(cameraModule.MODE_ORBIT_GC);
	const p1 = camera.getState().position.slice();
	camera.setMode(cameraModule.MODE_ORBIT_GC);
	check('setMode to the current mode is a no-op', distanceTo(camera.getState(), p1) === 0);
}

// --- 0.1.1: orbit motion ----------------------------------------------------
{
	const camera = cameraModule.createCamera();
	const gc = cameraModule.GALACTIC_CENTRE_TARGET;
	camera.setMode(cameraModule.MODE_ORBIT_GC);
	const radius = camera.getState().orbitDistance;

	// Random look input must move the camera on the sphere, always aimed at the target.
	const input = freshInput();
	let worstRadius = 0;
	let worstAim = 0;
	let moved = 0;
	let last = camera.getState().position.slice();
	for (let i = 0; i < 200; i++) {
		input.lookDx = (Math.sin(i * 12.9898) * 43758.5453 % 1) * 400;
		input.lookDy = (Math.sin(i * 78.233) * 12345.6789 % 1) * 60;
		camera.step(DT, input);
		const s = camera.getState();
		worstRadius = Math.max(worstRadius, Math.abs(distanceTo(s, gc) - radius) / radius);
		worstAim = Math.max(worstAim, aimError(camera, gc));
		moved += distanceTo(s, last);
		last = s.position.slice();
	}
	check('look input keeps the camera on the sphere (200 random drags)', worstRadius < 1e-9, worstRadius);
	check('look input keeps the target centred', worstAim < 1e-6, worstAim);
	check('look input actually moves the camera around the target', moved > radius, moved);
	check('orbit never accumulates velocity',
		camera.getState().velocity.every(v => v === 0), camera.getState().velocity);

	// Drag right swings the camera to the left of the target (grab the world).
	// Looking +X from the Sun, screen-right is -Y, so the camera's left is +Y.
	const dragged = cameraModule.createCamera();
	dragged.setMode(cameraModule.MODE_ORBIT_GC);
	const drag = freshInput();
	drag.lookDx = 200;
	dragged.step(DT, drag);
	check('drag right swings the camera left around the target (scene turns with the cursor)',
		dragged.getState().position[1] > 0.01, dragged.getState().position);
	const dragDown = freshInput();
	dragDown.lookDy = 200;
	dragged.step(DT, dragDown);
	check('drag down raises the camera above the target', dragged.getState().position[2] > 0.01, dragged.getState().position);

	// Wheel: distance x2 per notch, up = closer.
	const wheel = cameraModule.createCamera();
	wheel.setMode(cameraModule.MODE_ORBIT_GC);
	const d0 = wheel.getState().orbitDistance;
	scroll(wheel, NOTCH);
	check('one notch down doubles the orbit distance', Math.abs(wheel.getState().orbitDistance - 2 * d0) < 1e-12, wheel.getState().orbitDistance);
	scroll(wheel, -2 * NOTCH);
	check('two notches up halve it from there', Math.abs(wheel.getState().orbitDistance - d0 / 2) < 1e-12, wheel.getState().orbitDistance);
	check('the camera sits at the new distance, still aimed at the target',
		Math.abs(distanceTo(wheel.getState(), gc) - d0 / 2) < 1e-12 && aimError(wheel, gc) < 1e-9,
		{ distance: distanceTo(wheel.getState(), gc), aim: aimError(wheel, gc) });
	check('the speed multiplier is untouched by orbit scrolling', wheel.getState().speedMult === 1);
	scroll(wheel, 60 * NOTCH);
	check('orbit distance clamps at ORBIT_DISTANCE_MAX', wheel.getState().orbitDistance === cameraModule.ORBIT_DISTANCE_MAX, wheel.getState().orbitDistance);
	scroll(wheel, -60 * NOTCH);
	check('orbit distance clamps at ORBIT_DISTANCE_MIN', wheel.getState().orbitDistance === cameraModule.ORBIT_DISTANCE_MIN, wheel.getState().orbitDistance);

	// Keys: A/D circle, E/Q over/under, W/S dolly — at the documented rates.
	function orbitKeys(keys, seconds, dt) {
		const c = cameraModule.createCamera();
		c.setMode(cameraModule.MODE_ORBIT_GC);
		const start = c.getState();
		const i = freshInput();
		Object.assign(i.keys, keys);
		run(c, i, Math.round(seconds / dt), dt);
		const end = c.getState();
		return { dYaw: end.yaw - start.yaw, dPitch: end.pitch - start.pitch, ratio: end.orbitDistance / start.orbitDistance, state: end };
	}
	const turnRate = cameraModule.ORBIT_TURN_RATE;
	// Keys move the camera: D goes to the camera's right (-Y from the Sun side).
	const d = orbitKeys({ right: true }, 1, DT);
	check('D circles the camera right at ORBIT_TURN_RATE (yaw + rate * t)', angleError(d.dYaw, turnRate) < 1e-6 && d.state.position[1] < 0, d);
	const a = orbitKeys({ left: true }, 1, DT);
	check('A circles left', angleError(a.dYaw, -turnRate) < 1e-6 && a.state.position[1] > 0, a);
	const e = orbitKeys({ up: true }, 0.5, DT);
	check('E raises the camera over the target (pitch - rate * t)', Math.abs(e.dPitch + turnRate * 0.5) < 1e-9 && e.state.position[2] > 0, e);
	const q = orbitKeys({ down: true }, 0.5, DT);
	check('Q dips under it', Math.abs(q.dPitch - turnRate * 0.5) < 1e-9 && q.state.position[2] < 0, q);
	const w = orbitKeys({ forward: true }, 1, DT);
	check('W dollies in: distance halves per second', Math.abs(w.ratio - 0.5) < 1e-9, w.ratio);
	const s = orbitKeys({ back: true }, 2, DT);
	check('S dollies out: distance x4 in two seconds', Math.abs(s.ratio - 4) < 1e-9, s.ratio);
	const boosted = orbitKeys({ right: true, boost: true }, 1, DT);
	const slowed = orbitKeys({ right: true, slow: true }, 1, DT);
	check('Shift / Ctrl scale orbit key rates by ORBIT_KEY_BOOST, not x100',
		angleError(boosted.dYaw, turnRate * cameraModule.ORBIT_KEY_BOOST) < 1e-6
		&& angleError(slowed.dYaw, turnRate / cameraModule.ORBIT_KEY_BOOST) < 1e-6,
		{ boosted: boosted.dYaw, slowed: slowed.dYaw });

	const at60 = orbitKeys({ right: true, forward: true }, 2, 1 / 60);
	const at144 = orbitKeys({ right: true, forward: true }, 2, 1 / 144);
	check('orbit keys are frame-rate independent',
		Math.abs(at60.dYaw - at144.dYaw) < 1e-9 && Math.abs(at60.ratio - at144.ratio) < 1e-9, { at60, at144 });

	const pitchy = orbitKeys({ up: true }, Math.PI, DT);
	check('orbit keys can loop over the target without a pitch clamp',
		cameraModule.PITCH_LIMIT === Infinity
		&& Math.abs(distanceTo(pitchy.state, gc) - pitchy.state.orbitDistance) < 1e-9
		&& pitchy.state.position[0] > gc[0],
		{ position: pitchy.state.position, pitch: pitchy.state.pitch });
}

// --- 0.1.1: momentum does not cross the mode boundary ----------------------
{
	const camera = cameraModule.createCamera();
	const input = freshInput();
	input.keys.forward = true;
	input.keys.boost = true;
	run(camera, input, 120);
	input.keys.forward = false;
	input.keys.boost = false;
	const flying = camera.getState();
	camera.setMode(cameraModule.MODE_ORBIT_GC);
	run(camera, input, 60);
	const parked = camera.getState();
	check('entering orbit while moving stops the camera dead (no drift off the sphere)',
		Math.hypot(flying.velocity[0], flying.velocity[1], flying.velocity[2]) > 0.01
		&& distanceTo(parked, flying.position) < 1e-9, { flying: flying.velocity, drift: distanceTo(parked, flying.position) });
}

// --- 0.1.1: object target ---------------------------------------------------
{
	const camera = cameraModule.createCamera();
	camera.setOrbitTarget(1, 2, 3, 'Test star');
	check('setOrbitTarget in fly mode does not move the camera',
		camera.cameraPos[0] === 0 && camera.cameraPos[1] === 0 && Math.abs(camera.cameraPos[2] - 0.005) < 1e-7);
	camera.setMode(cameraModule.MODE_ORBIT_OBJECT);
	const s1 = camera.getState();
	check('orbit-object circles the set target by name',
		s1.orbitTarget[0] === 1 && s1.orbitTarget[1] === 2 && s1.orbitTarget[2] === 3 && s1.targetName === 'Test star',
		{ target: s1.orbitTarget, name: s1.targetName });
	check('distance is the distance from where the camera was', Math.abs(s1.orbitDistance - Math.hypot(1, 2, 3 - 0.005)) < 1e-9, s1.orbitDistance);
	check('and the camera aims at it', aimError(camera, [1, 2, 3]) < 1e-9);

	// Re-targeting while orbiting turns the camera from where it is.
	camera.setOrbitTarget(-2, 0.5, 0, 'Other star');
	const s2 = camera.getState();
	check('re-targeting while in orbit keeps the position and turns towards the new target',
		distanceTo(s2, s1.position) < 1e-9 && aimError(camera, [-2, 0.5, 0]) < 1e-6 && s2.targetName === 'Other star',
		{ moved: distanceTo(s2, s1.position) });

	// The centre mode ignores the object target.
	camera.setMode(cameraModule.MODE_ORBIT_GC);
	check('orbit-centre ignores the object target', camera.getState().targetName === 'galactic centre');
}

// --- Fly-to flight and follow (plan §18) ------------------------------------
{
	const TARGET = [1.2, -0.5, 0.02];
	const STAND_OFF = 0.0006;

	function freshFlight() {
		const camera = cameraModule.createCamera();
		camera.flyToStar(TARGET[0], TARGET[1], TARGET[2], 'Flight star', STAND_OFF);
		return camera;
	}

	function flyFrames(camera, frames, dt) {
		const input = freshInput();
		for (let i = 0; i < frames; i++) camera.step(dt || DT, input);
		return camera.getState();
	}

	const launched = freshFlight();
	const s0 = launched.getState();
	check('flyToStar launches a flight instead of teleporting',
		s0.flying === true && s0.mode === cameraModule.MODE_ORBIT_OBJECT && s0.targetName === 'Flight star'
		&& distanceTo(s0, cameraModule.START_POSITION) < 1e-12,
		{ flying: s0.flying, moved: distanceTo(s0, cameraModule.START_POSITION) });
	check('the flight keeps the camera stopped (velocity zero, multiplier untouched)',
		s0.velocity.every(v => v === 0) && s0.speedMult === 1, s0);

	const midCamera = freshFlight();
	const midState = flyFrames(midCamera, 60);
	const d0 = distanceTo(midState, cameraModule.START_POSITION);
	const dEnd = distanceTo(midState, TARGET);
	check('mid-flight the camera is between start and arrival',
		midState.flying === true && d0 > 1e-6 && dEnd > 2 * STAND_OFF, { fromStart: d0, toTarget: dEnd });
	check('mid-flight the camera already turns towards the target',
		aimError(midCamera, TARGET) < 0.05, aimError(midCamera, TARGET));

	const arrivedCamera = freshFlight();
	const arrived = flyFrames(arrivedCamera, 125);
	check('the flight takes 2 s and ends at the stand-off',
		arrived.flying === false && Math.abs(arrived.orbitDistance - STAND_OFF) < 1e-12
		&& Math.abs(distanceTo(arrived, TARGET) - STAND_OFF) < 1e-9,
		{ flying: arrived.flying, dist: distanceTo(arrived, TARGET) });
	check('arrival is centred: the camera aims at the star', aimError(arrivedCamera, TARGET) < 1e-6);
	check('arrival carries no velocity into the orbit', arrived.velocity.every(v => v === 0));

	// Orbit controls continue from the arrival pose.
	const post = freshInput();
	post.lookDx = 100;
	arrivedCamera.step(DT, post);
	check('after arrival the orbit controls hold the stand-off distance',
		Math.abs(distanceTo(arrivedCamera.getState(), TARGET) - STAND_OFF) < 1e-9
		&& arrivedCamera.getState().flying === false);

	// Frame-rate independence: the eased path is a function of elapsed time.
	function arrivalAt(dt) {
		const c = freshFlight();
		const input = freshInput();
		let elapsed = 0;
		while (elapsed < cameraModule.FLIGHT_DURATION_S + 0.1) {
			c.step(dt, input);
			elapsed += dt;
		}
		return c.getState();
	}
	const at60 = arrivalAt(1 / 60);
	const at144 = arrivalAt(1 / 144);
	const at30 = arrivalAt(1 / 30);
	const spread = Math.max(distanceTo(at60, TARGET), distanceTo(at144, TARGET), distanceTo(at30, TARGET))
		- Math.min(distanceTo(at60, TARGET), distanceTo(at144, TARGET), distanceTo(at30, TARGET));
	check('the flight lands identically at 30/60/144 Hz',
		spread < 1e-12 && quatDot(at60.orientation, at144.orientation) > 1 - 1e-9,
		{ spread, dot: quatDot(at60.orientation, at144.orientation) });

	// Follow: updateTarget moves the orbited object in place and the camera
	// keeps it centred at the same stand-off.
	const followed = freshFlight();
	flyFrames(followed, 125);
	const movedTarget = [TARGET[0] + 0.001, TARGET[1] - 0.0005, TARGET[2] + 0.0002];
	followed.updateTarget(movedTarget[0], movedTarget[1], movedTarget[2]);
	flyFrames(followed, 1);
	const followState = followed.getState();
	check('updateTarget moves the camera with the object, keeping it centred',
		Math.abs(distanceTo(followState, movedTarget) - STAND_OFF) < 1e-9
		&& aimError(followed, movedTarget) < 1e-6 && followState.flying === false,
		{ dist: distanceTo(followState, movedTarget), aim: aimError(followed, movedTarget) });

	// Follow during the flight: the arrival pose tracks a moving target.
	const chase = freshFlight();
	flyFrames(chase, 60);
	chase.updateTarget(movedTarget[0], movedTarget[1], movedTarget[2]);
	const chased = flyFrames(chase, 80);
	check('a target that moves mid-flight is met at the end of the flight',
		chased.flying === false && Math.abs(distanceTo(chased, movedTarget) - STAND_OFF) < 1e-9,
		{ dist: distanceTo(chased, movedTarget) });

	// A fast mover (5 Myr/s of star time carries a disc star ~100 pc/s, far
	// more than the 0.6 pc stand-off per frame). main.js updates the target
	// *before* the step, and the flight is flown in the target's frame: the
	// camera closes monotonically, never overshoots, and ends centred.
	const runner = freshFlight();
	const runnerPos = TARGET.slice();
	const runnerVelocity = [0.08, -0.05, 0.01];      // kpc/s
	const runnerInput = freshInput();
	let closing = true;
	let lastRange = Infinity;
	for (let i = 0; i < 125; i++) {
		runnerPos[0] += runnerVelocity[0] * DT;
		runnerPos[1] += runnerVelocity[1] * DT;
		runnerPos[2] += runnerVelocity[2] * DT;
		runner.updateTarget(runnerPos[0], runnerPos[1], runnerPos[2]);
		runner.step(DT, runnerInput);
		const range = distanceTo(runner.getState(), runnerPos);
		closing = closing && range <= lastRange + 1e-12;
		lastRange = range;
	}
	const caught = runner.getState();
	check('flying to a fast-moving star closes monotonically (no overshoot)', closing);
	check('flying to a fast-moving star ends at the stand-off, centred on it, camera target = the star',
		caught.flying === false && Math.abs(distanceTo(caught, runnerPos) - STAND_OFF) < 1e-9
		&& aimError(runner, runnerPos) < 1e-6
		&& distanceTo({ position: caught.orbitTarget }, runnerPos) < 1e-12,
		{ dist: distanceTo(caught, runnerPos), aim: aimError(runner, runnerPos) });

	// Cancellation: user input ends the flight at the current pose the same frame.
	const grab = freshFlight();
	flyFrames(grab, 30);
	const before = grab.getState();
	const cancel = freshInput();
	cancel.lookDx = 60;
	grab.step(DT, cancel);
	const after = grab.getState();
	check('a look delta cancels the flight and hands control over the same frame',
		before.flying === true && after.flying === false, { before: before.flying, after: after.flying });
	// Continuity: the re-snap lands on the sphere of the distance the camera
	// already had; the look drag then swings it along that sphere, which keeps
	// the radius — the same "turn, not move" contract as entering orbit.
	check('cancelling re-snaps onto the sphere of the current distance',
		Math.abs(distanceTo(after, TARGET) - distanceTo(before, TARGET)) < 1e-9,
		{ radius: distanceTo(after, TARGET), was: distanceTo(before, TARGET) });
	const postCancel = freshInput();
	postCancel.lookDx = 100;
	grab.step(DT, postCancel);
	check('after a cancel the orbit re-snap aims at the target and holds the distance',
		aimError(grab, TARGET) < 1e-6
		&& Math.abs(grab.getState().orbitDistance - distanceTo(grab.getState(), TARGET)) < 1e-12,
		{ aim: aimError(grab, TARGET) });

	const keyed = freshFlight();
	flyFrames(keyed, 30);
	const keyInput = freshInput();
	keyInput.keys.forward = true;
	keyed.step(DT, keyInput);
	check('a movement key cancels the flight too', keyed.getState().flying === false);

	// standOffKpc ≤ 0 keeps the current orbit distance; large stand-offs clamp.
	const keeper = cameraModule.createCamera();
	keeper.setOrbitTarget(TARGET[0], TARGET[1], TARGET[2], 'Near star');
	keeper.setMode(cameraModule.MODE_ORBIT_OBJECT);
	const keepDist = keeper.getState().orbitDistance;
	keeper.flyToStar(TARGET[0], TARGET[1], TARGET[2], 'Near star', 0);
	const kept = flyFrames(keeper, 130);
	check('standOff 0 keeps the current distance through the flight',
		kept.flying === false && Math.abs(kept.orbitDistance - keepDist) < 1e-12, kept.orbitDistance);
	const farCamera = cameraModule.createCamera();
	farCamera.flyToStar(TARGET[0], TARGET[1], TARGET[2], 'Bright', 100);
	const farState = farCamera.getState();
	check('a stand-off above the ceiling clamps to ORBIT_DISTANCE_MAX',
		farState.flying === true && farState.orbitDistance === cameraModule.ORBIT_DISTANCE_MAX);

	// The pole approach: a launch straight along the arrival forward must not
	// degenerate the basis (galactic-north up is unavailable twice over there).
	const pole = cameraModule.createCamera();
	pole.flyToStar(0, 0, 0.6, 'Pole star', 0.0006);
	let poleWorst = 0;
	flyFrames(pole, 130);
	// Re-fly to measure inside the flight too.
	const pole2 = cameraModule.createCamera();
	pole2.flyToStar(0, 0, 0.6, 'Pole star', 0.0006);
	for (let i = 0; i < 125; i++) {
		pole2.step(DT, freshInput());
		const f = pole2.forward, r = pole2.right, u = pole2.up;
		const norm = (v) => Math.abs(Math.hypot(v[0], v[1], v[2]) - 1);
		poleWorst = Math.max(poleWorst,
			norm(f), norm(r), norm(u),
			Math.abs(f[0] * r[0] + f[1] * r[1] + f[2] * r[2]),
			Math.abs(f[0] * u[0] + f[1] * u[1] + f[2] * u[2]),
			Math.abs(r[0] * u[0] + r[1] * u[1] + r[2] * u[2]));
	}
	check('an approach straight along ±Z keeps an orthonormal basis',
		poleWorst < 1e-6, poleWorst);
	check('the pole flight arrives centred, looking up at the star',
		Math.abs(distanceTo(pole.getState(), [0, 0, 0.6]) - STAND_OFF) < 1e-9 && pole.forward[2] > 0.999,
		{ dist: distanceTo(pole.getState(), [0, 0, 0.6]), fz: pole.forward[2] });

	// A mode switch ends the flight; a relaunch mid-flight restarts from the pose.
	const acted = freshFlight();
	flyFrames(acted, 30);
	acted.setMode(cameraModule.MODE_FLY);
	check('f during a flight ends it (setMode from orbit-object to fly)',
		acted.getState().flying === false && acted.getState().mode === cameraModule.MODE_FLY);
	const relaunched = freshFlight();
	flyFrames(relaunched, 60);
	relaunched.flyToStar(-1, 0.5, 0, 'Other', 0.001);
	const rel0 = relaunched.getState();
	check('a second flyToStar mid-flight relaunches from the current pose',
		rel0.flying === true && rel0.targetName === 'Other'
		&& distanceTo(rel0, TARGET) < 0.75 * Math.hypot(
			cameraModule.START_POSITION[0] - TARGET[0],
			cameraModule.START_POSITION[1] - TARGET[1],
			cameraModule.START_POSITION[2] - TARGET[2]));
	const relaunchedEnd = flyFrames(relaunched, 150);
	check('the relaunched flight lands on the new star',
		relaunchedEnd.flying === false && Math.abs(distanceTo(relaunchedEnd, [-1, 0.5, 0]) - 0.001) < 1e-9,
		{ dist: distanceTo(relaunchedEnd, [-1, 0.5, 0]) });

	// The flight allocates nothing: buffer references survive a full flight.
	const stable = freshFlight();
	const refs = [stable.viewProj, stable.cameraPos, stable.forward, stable.right, stable.up];
	flyFrames(stable, 130);
	const out = stable.getState();
	check('no buffers are reallocated across a flight', stable.viewProj === refs[0]
		&& stable.cameraPos === refs[1] && stable.forward === refs[2]
		&& stable.right === refs[3] && stable.up === refs[4]
		&& typeof out.flying === 'boolean' && typeof out.flightProgress === 'number');
}

// --- Chase follow (j, ui.6) --------------------------------------------------
{
	const TARGET = [1.2, -0.5, 0.02];
	const STAND_OFF = 0.0006;
	// kpc/s: a disc star's apparent speed at the default star time — far more
	// than the 0.6 pc stand-off per second, exactly the case the follow feed
	// exists for.
	const VEL = [0.08, -0.05, 0.01];
	const VEL_LEN = Math.hypot(VEL[0], VEL[1], VEL[2]);
	const DIR_DOT = (camera, dir) =>
		(camera.forward[0] * dir[0] + camera.forward[1] * dir[1] + camera.forward[2] * dir[2]);

	// Arrive on the star first, so engage continuity is measured from the
	// settled orbit pose exactly like c → j in the app.
	function arrivedChase() {
		const camera = cameraModule.createCamera();
		camera.flyToStar(TARGET[0], TARGET[1], TARGET[2], 'Chase star', STAND_OFF);
		run(camera, freshInput(), 130);
		return camera;
	}

	// Chase a target that keeps its velocity; the feed is refreshed before
	// each step exactly like main.js's followTarget, and the final target
	// position is returned for the behind/centred checks.
	function chaseFrames(camera, frames, dt, input) {
		const step = dt || DT;
		const keys = input || freshInput();
		const pos = camera.getState().orbitTarget.slice();
		for (let i = 0; i < frames; i++) {
			pos[0] += VEL[0] * step;
			pos[1] += VEL[1] * step;
			pos[2] += VEL[2] * step;
			camera.updateTarget(pos[0], pos[1], pos[2]);
			camera.step(step, keys);
		}
		return pos;
	}

	check('chase is off by default', cameraModule.createCamera().getState().chase === false);

	const engage = arrivedChase();
	const before = engage.getState();
	engage.setChase(true);
	run(engage, freshInput(), 1);
	const afterEngage = engage.getState();
	check('engaging chase from a settled orbit is pose-continuous (behind = where it already is)',
		afterEngage.chase === true
		&& before.position.every((v, i) => Math.abs(v - afterEngage.position[i]) < 1e-12)
		&& quatDot(before.orientation, afterEngage.orientation) > 1 - 1e-9
		&& aimError(engage, TARGET) < 1e-6,
		{ moved: Math.hypot(afterEngage.position[0] - before.position[0],
			afterEngage.position[1] - before.position[1], afterEngage.position[2] - before.position[2]) });
	check('enabling chase outside the object orbit is a no-op, not a chase of nothing',
		(() => { const c = cameraModule.createCamera(); c.setMode(cameraModule.MODE_ORBIT_GC); c.setChase(true); return c.getState().chase === false; })());

	const follower = arrivedChase();
	follower.setChase(true);
	const followPos = chaseFrames(follower, 240);      // 4 s, 8 × CHASE_DIR_TAU
	const followed = follower.getState();
	const behind = [followed.position[0] - followPos[0], followed.position[1] - followPos[1], followed.position[2] - followPos[2]];
	const behindDot = (behind[0] * VEL[0] + behind[1] * VEL[1] + behind[2] * VEL[2]) / (Math.hypot(behind[0], behind[1], behind[2]) * VEL_LEN);
	check('the chase converges behind the target, aligned with its motion',
		DIR_DOT(follower, VEL) / VEL_LEN > 0.9999 && behindDot < -0.9999,
		{ forwardDot: DIR_DOT(follower, VEL) / VEL_LEN, behindDot });
	check('the followed object stays dead-centre at the orbit distance',
		Math.abs(distanceTo(followed, followPos) - STAND_OFF) < 1e-9 && aimError(follower, followPos) < 1e-6,
		{ dist: distanceTo(followed, followPos), aim: aimError(follower, followPos) });
	check('the chase reports the target\'s own apparent speed',
		Math.abs(followed.chaseSpeedLyPerSec - VEL_LEN / cameraModule.LY_TO_KPC) < 0.01,
		{ reported: followed.chaseSpeedLyPerSec, actual: VEL_LEN / cameraModule.LY_TO_KPC });

	// A glance: one hard look sideways, then the movement keeps flowing. The
	// star never leaves centre (position = target - distance * forward is the
	// orbit law with a different direction owner), and the alignment returns.
	const glance = arrivedChase();
	glance.setChase(true);
	chaseFrames(glance, 240);
	const spin = freshInput();
	spin.lookDx = 400;
	glance.step(DT, spin);
	const spunPos = glance.getState().orbitTarget;
	check('a glance keeps the followed object dead-centre (it orbits, not trails)',
		aimError(glance, spunPos) < 1e-6 && Math.abs(distanceTo(glance.getState(), spunPos) - STAND_OFF) < 1e-9,
		{ aim: aimError(glance, spunPos) });
	chaseFrames(glance, 240);
	check('the alignment always comes back after a glance',
		DIR_DOT(glance, VEL) / VEL_LEN > 0.9999, DIR_DOT(glance, VEL) / VEL_LEN);

	// Frozen star time: the drawn positions are bit-identical, the movement
	// feed reads zero, and the chase degenerates to a free orbit of the
	// looked direction.
	const frozen = arrivedChase();
	frozen.setChase(true);
	chaseFrames(frozen, 240);
	const frozenPos = frozen.getState().orbitTarget.slice();
	const freezeSpin = freshInput();
	freezeSpin.lookDx = 400;
	frozen.step(DT, freezeSpin);
	run(frozen, freshInput(), 60);                     // no updateTarget: time frozen
	check('a frozen target keeps the looked direction and reports no motion',
		aimError(frozen, frozenPos) < 1e-6
		&& Math.abs(distanceTo(frozen.getState(), frozenPos) - STAND_OFF) < 1e-9
		&& frozen.getState().chaseSpeedLyPerSec === 0,
		{ aim: aimError(frozen, frozenPos), speed: frozen.getState().chaseSpeedLyPerSec });

	// Leaving: the free orbit takes over at the exact pose the chase held.
	const off = arrivedChase();
	off.setChase(true);
	chaseFrames(off, 240);
	const beforeOff = off.getState();
	off.setChase(false);
	run(off, freshInput(), 1);
	const afterOff = off.getState();
	check('leaving chase is pose-continuous (the free orbit takes over exactly)',
		afterOff.chase === false
		&& beforeOff.position.every((v, i) => Math.abs(v - afterOff.position[i]) < 1e-12)
		&& quatDot(beforeOff.orientation, afterOff.orientation) > 1 - 1e-9);

	// Mode switches clear the sub-mode instead of chasing a target nobody orbits.
	const clearedFly = arrivedChase();
	clearedFly.setChase(true);
	clearedFly.setMode(cameraModule.MODE_FLY);
	check('f during a chase returns to free fly with chase off', clearedFly.getState().chase === false);
	const clearedGC = arrivedChase();
	clearedGC.setChase(true);
	clearedGC.setMode(cameraModule.MODE_ORBIT_GC);
	check('C during a chase returns to the centre orbit with chase off', clearedGC.getState().chase === false);

	// The dolly keeps working: W halves the chase distance in one second.
	const dolly = arrivedChase();
	dolly.setChase(true);
	chaseFrames(dolly, 240);
	const dollyInput = freshInput();
	dollyInput.keys.forward = true;
	run(dolly, dollyInput, 60);
	check('W/S and the wheel still dolly the chase distance',
		Math.abs(dolly.getState().orbitDistance - STAND_OFF / 2) < 1e-12, dolly.getState().orbitDistance);

	// Frame-rate independence: the ease composes over elapsed time.
	function chaseAt(dt) {
		const c = arrivedChase();
		c.setChase(true);
		const pos = chaseFrames(c, Math.round(1 / dt), dt);
		return { state: c.getState(), pos };
	}
	const at60 = chaseAt(1 / 60);
	const at30 = chaseAt(1 / 30);
	const at144 = chaseAt(1 / 144);
	const spread = Math.max(
		Math.hypot(at60.state.position[0] - at30.state.position[0], at60.state.position[1] - at30.state.position[1], at60.state.position[2] - at30.state.position[2]),
		Math.hypot(at60.state.position[0] - at144.state.position[0], at60.state.position[1] - at144.state.position[1], at60.state.position[2] - at144.state.position[2]));
	check('the chase swing lands identically at 30/60/144 Hz',
		spread < 1e-9 && quatDot(at60.state.orientation, at144.state.orientation) > 1 - 1e-9,
		{ spread, dot: quatDot(at60.state.orientation, at144.state.orientation) });

	// A circular target: the direction lags the motion by a bounded angle and
	// the distance contract never breaks. The circle starts at the arrival
	// point so the feed never reads a jump.
	const orbiting = arrivedChase();
	orbiting.setChase(true);
	const orbitInput = freshInput();
	const oPos = orbiting.getState().orbitTarget.slice();
	const OMEGA = 0.5;                                 // rad/s of target motion
	let worstDist = 0;
	for (let i = 0; i < 600; i++) {
		const a = OMEGA * DT * i;
		oPos[0] = TARGET[0] + 0.5 * (Math.cos(a) - 1);
		oPos[1] = TARGET[1] + 0.5 * Math.sin(a);
		oPos[2] = TARGET[2];
		orbiting.updateTarget(oPos[0], oPos[1], oPos[2]);
		orbiting.step(DT, orbitInput);
		worstDist = Math.max(worstDist, Math.abs(distanceTo(orbiting.getState(), oPos) - STAND_OFF));
	}
	const aEnd = OMEGA * DT * 599;
	const tangent = [-Math.sin(aEnd), Math.cos(aEnd), 0];
	const lag = Math.acos(Math.min(1, Math.max(-1, DIR_DOT(orbiting, tangent))));
	check('a curving target holds the distance and lags the motion by a bounded angle',
		worstDist < 1e-9 && lag < 2 * OMEGA * cameraModule.CHASE_DIR_TAU,
		{ worstDist, lagRad: lag, bound: 2 * OMEGA * cameraModule.CHASE_DIR_TAU });
}

// --- 0.1.1: home and reset --------------------------------------------------
{
	const camera = cameraModule.createCamera();
	const input = freshInput();
	input.keys.forward = true;
	input.keys.right = true;
	input.lookDx = 300;
	input.lookDy = -80;
	run(camera, input, 90);
	scroll(camera, -3 * NOTCH);
	const away = camera.getState();
	const homeInput = pressAction(camera, 'home');
	const home = camera.getState();
	check('the home action is consumed by step()', homeInput.actions.home === 0);
	check('H in fly teleports to the start position, level, stopped',
		distanceTo(home, cameraModule.START_POSITION) < 1e-12 && home.yaw === 0 && home.pitch === 0
		&& home.velocity.every(v => v === 0) && home.mode === cameraModule.MODE_FLY,
		{ away: away.position, home: home.position });
	check('H keeps the speed multiplier (R is the full reset)', home.speedMult === 8, home.speedMult);

	const orbiter = cameraModule.createCamera();
	orbiter.setMode(cameraModule.MODE_ORBIT_GC);
	const orbitDrag = freshInput();
	orbitDrag.lookDx = 400;
	orbitDrag.lookDy = 120;
	orbiter.step(DT, orbitDrag);
	const beforeHome = orbiter.getState();
	pressAction(orbiter, 'home');
	const orbitHome = orbiter.getState();
	check('H in orbit switches to orbit-object around the Sun',
		orbitHome.mode === cameraModule.MODE_ORBIT_OBJECT && orbitHome.targetName === 'Sun'
		&& orbitHome.orbitTarget.every(v => v === 0), { mode: orbitHome.modeName, name: orbitHome.targetName });
	check('H in orbit parks at HOME_ORBIT_DISTANCE (10 pc) from the Sun',
		Math.abs(orbitHome.orbitDistance - cameraModule.HOME_ORBIT_DISTANCE) < 1e-12
		&& Math.abs(distanceTo(orbitHome, cameraModule.SUN_POSITION) - cameraModule.HOME_ORBIT_DISTANCE) < 1e-12,
		orbitHome.orbitDistance);
	check('H in orbit keeps the viewing direction (a translation, not a spin)',
		quatDot(orbitHome.orientation, beforeHome.orientation) > 1 - 1e-12 && aimError(orbiter, cameraModule.SUN_POSITION) < 1e-6);

	orbiter.setOrbitTarget(4, 4, 4, 'Somewhere');
	scroll(orbiter, -2 * NOTCH);
	const resetInput = pressAction(orbiter, 'reset');
	const afterReset = orbiter.getState();
	check('the reset action is consumed in orbit too', resetInput.actions.reset === 0);
	check('R from orbit restores fly mode at the start, x1, object target back to the Sun',
		afterReset.mode === cameraModule.MODE_FLY && distanceTo(afterReset, cameraModule.START_POSITION) < 1e-12
		&& afterReset.speedMult === 1 && afterReset.yaw === 0 && afterReset.pitch === 0, afterReset);
	orbiter.setMode(cameraModule.MODE_ORBIT_OBJECT);
	check('after R the object target is the Sun again', orbiter.getState().targetName === 'Sun'
		&& orbiter.getState().orbitTarget.every(v => v === 0), orbiter.getState().orbitTarget);
}

// --- 0.1.1: state round trip and allocation across modes ------------------
{
	const camera = cameraModule.createCamera();
	camera.setState({ position: [1, -2, 0.3], velocity: [0, 0, 0], yaw: 0.4, pitch: -0.2, speedMult: 4, mode: cameraModule.MODE_ORBIT_GC });
	const s = camera.getState();
	check('setState restores position, orientation input, multiplier and mode',
		s.mode === cameraModule.MODE_ORBIT_GC && s.speedMult === 4
		&& distanceTo(s, [1, -2, 0.3]) < 1e-9 && aimError(camera, cameraModule.GALACTIC_CENTRE_TARGET) < 1e-6, s);

	const c = cameraModule.createCamera();
	const input = freshInput();
	const out = c.getState();
	const refs = [c.viewProj, c.cameraPos, c.forward, c.right, c.up, out.position, out.velocity, out.orbitTarget, out.orientation];
	let stable = true;
	for (let i = 0; i < 600; i++) {
		input.keys.forward = (i % 2) === 0;
		input.keys.right = (i % 5) === 0;
		input.lookDx = i % 7;
		input.wheelDelta = (i % 90 === 0) ? -NOTCH : 0;
		input.actions.home = (i % 250 === 0) ? 1 : 0;
		if (i % 100 === 99) c.setMode((c.getState().mode + 1) % 3);
		// Chase follow (ui.6) rides the mode cycle: enabled while the camera
		// orbits an object with a moving feed, cleared by the mode switches.
		if (i % 100 === 60) c.setChase(true);
		if (i % 37 === 0) c.updateTarget(1 + i * 1e-4, -0.5, 0.02);
		c.step(DT, input);
		c.buildViewProj(1.5);
		const state = c.getState(out);
		stable = stable && state === out
			&& c.viewProj === refs[0] && c.cameraPos === refs[1] && c.forward === refs[2] && c.right === refs[3] && c.up === refs[4]
			&& out.position === refs[5] && out.velocity === refs[6] && out.orbitTarget === refs[7] && out.orientation === refs[8]
			&& typeof out.modeName === 'string' && typeof out.targetName === 'string';
	}
	check('no buffers or state arrays are reallocated across 600 frames of mode switching', stable);
}

// --- Report --------------------------------------------------------------
let passed = 0;
let failed = 0;
for (const c of checks) {
	if (c.pass) passed++; else failed++;
	console.log(`  ${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.pass ? '' : `  -> ${JSON.stringify(c.detail)}`}`);
}
console.log(`\n${passed}/${checks.length} passed, ${failed} failed`);

const logPath = path.join(__dirname, 'logs', 'camera.json');
fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.writeFileSync(logPath, JSON.stringify({
	date: new Date().toISOString(),
	totalChecks: checks.length,
	passed,
	failed,
	checks,
}, null, 2));
console.log(`Wrote ${logPath}`);
console.log('\n=== VERDICT ===');
console.log(failed === 0 ? 'PASS — camera matches the documented model' : `FAIL — ${failed} checks failed`);
process.exit(failed === 0 ? 0 : 1);
