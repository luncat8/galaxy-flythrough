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
// not return to x1).
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
		actions: { reset: 0, home: 0, cameraMode: 0, exposure: 0 },
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

// 1 - cos(angle between the view direction and the direction to the target),
// from the f64 state (camera.forward is the f32 copy for the GPU and floors
// this metric at ~1e-7 on its own).
function aimError(camera, target) {
	const s = camera.getState();
	const fx = Math.cos(s.yaw) * Math.cos(s.pitch);
	const fy = Math.sin(s.yaw) * Math.cos(s.pitch);
	const fz = Math.sin(s.pitch);
	const dx = target[0] - s.position[0];
	const dy = target[1] - s.position[1];
	const dz = target[2] - s.position[2];
	return 1 - (fx * dx + fy * dy + fz * dz) / Math.hypot(dx, dy, dz);
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

	// Pitch must be clamped short of the pole (the basis would degenerate).
	const pitchy = cameraModule.createCamera();
	const i3 = freshInput();
	for (let i = 0; i < 200; i++) {
		i3.lookDy = -500;
		pitchy.step(1 / 60, i3);
	}
	check('pitch is clamped below 90 degrees',
		Math.abs(pitchy.getState().pitch) <= cameraModule.PITCH_LIMIT + 1e-9,
		pitchy.getState().pitch);
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
		const out = { position: [0, 0, 0], velocity: [0, 0, 0] };
		return camera.getState(out) === out && out.position === out.position;
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
	const input = pressAction(camera, 'cameraMode');
	const orbitGc = camera.getState();
	check('the cameraMode action is consumed by step()', input.actions.cameraMode === 0);
	check('C from fly enters orbit-centre', orbitGc.mode === cameraModule.MODE_ORBIT_GC && orbitGc.modeName === 'orbit centre', orbitGc.modeName);
	check('orbit-centre targets the galactic centre',
		orbitGc.orbitTarget[0] === gc[0] && orbitGc.orbitTarget[1] === gc[1] && orbitGc.orbitTarget[2] === gc[2] && orbitGc.targetName === 'galactic centre',
		{ target: orbitGc.orbitTarget, name: orbitGc.targetName });
	check('entering orbit keeps the camera where it was (it turns, it does not move)',
		distanceTo(orbitGc, before.position) < 1e-9, { before: before.position, after: orbitGc.position });
	check('orbit distance is |Sun - centre|', Math.abs(orbitGc.orbitDistance - Math.hypot(8.178, 0, 0.005)) < 1e-9, orbitGc.orbitDistance);
	check('the camera looks at the target', aimError(camera, gc) < 1e-9, aimError(camera, gc));

	pressAction(camera, 'cameraMode');
	const orbitObj = camera.getState();
	check('C again enters orbit-object', orbitObj.mode === cameraModule.MODE_ORBIT_OBJECT && orbitObj.modeName === 'orbit object', orbitObj.modeName);
	check('the default object target is the Sun',
		orbitObj.orbitTarget[0] === 0 && orbitObj.orbitTarget[1] === 0 && orbitObj.orbitTarget[2] === 0 && orbitObj.targetName === 'Sun',
		{ target: orbitObj.orbitTarget, name: orbitObj.targetName });
	// The start is straight above the Sun, so aiming at it hits the pitch
	// clamp: the camera keeps its distance and slides by at most 0.02 rad.
	check('switching targets keeps the distance; only the pitch clamp moves the camera (< 0.02 rad)',
		distanceTo(orbitObj, before.position) < 0.005 * 0.02 && Math.abs(orbitObj.pitch) === cameraModule.PITCH_LIMIT,
		{ moved: distanceTo(orbitObj, before.position), pitch: orbitObj.pitch });
	check('orbit distance to the Sun is the 5 pc start height', Math.abs(orbitObj.orbitDistance - 0.005) < 1e-12, orbitObj.orbitDistance);

	pressAction(camera, 'cameraMode');
	const fly = camera.getState();
	check('C a third time returns to fly', fly.mode === cameraModule.MODE_FLY, fly.modeName);
	check('orbit -> fly is continuous: position, yaw and pitch carry over, velocity is zero',
		distanceTo(fly, orbitObj.position) < 1e-12 && fly.yaw === orbitObj.yaw && fly.pitch === orbitObj.pitch
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
	check('look input keeps the target centred', worstAim < 1e-9, worstAim);
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
	check('D circles the camera right at ORBIT_TURN_RATE (yaw + rate * t)', Math.abs(d.dYaw - turnRate) < 1e-9 && d.state.position[1] < 0, d);
	const a = orbitKeys({ left: true }, 1, DT);
	check('A circles left', Math.abs(a.dYaw + turnRate) < 1e-9 && a.state.position[1] > 0, a);
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
		Math.abs(boosted.dYaw - turnRate * cameraModule.ORBIT_KEY_BOOST) < 1e-9
		&& Math.abs(slowed.dYaw - turnRate / cameraModule.ORBIT_KEY_BOOST) < 1e-9,
		{ boosted: boosted.dYaw, slowed: slowed.dYaw });

	const at60 = orbitKeys({ right: true, forward: true }, 2, 1 / 60);
	const at144 = orbitKeys({ right: true, forward: true }, 2, 1 / 144);
	check('orbit keys are frame-rate independent',
		Math.abs(at60.dYaw - at144.dYaw) < 1e-9 && Math.abs(at60.ratio - at144.ratio) < 1e-9, { at60, at144 });

	const pitchy = orbitKeys({ up: true }, 5, DT);
	check('orbit pitch is clamped short of the pole', Math.abs(pitchy.state.pitch) <= cameraModule.PITCH_LIMIT + 1e-12
		&& Math.abs(distanceTo(pitchy.state, gc) - pitchy.state.orbitDistance) < 1e-9, pitchy.state.pitch);
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
		distanceTo(s2, s1.position) < 1e-9 && aimError(camera, [-2, 0.5, 0]) < 1e-9 && s2.targetName === 'Other star',
		{ moved: distanceTo(s2, s1.position) });

	// The centre mode ignores the object target.
	camera.setMode(cameraModule.MODE_ORBIT_GC);
	check('orbit-centre ignores the object target', camera.getState().targetName === 'galactic centre');
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
		orbitHome.yaw === beforeHome.yaw && orbitHome.pitch === beforeHome.pitch && aimError(orbiter, cameraModule.SUN_POSITION) < 1e-9);

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
	check('setState restores position, angles, multiplier and mode',
		s.mode === cameraModule.MODE_ORBIT_GC && s.speedMult === 4
		&& distanceTo(s, [1, -2, 0.3]) < 1e-9 && aimError(camera, cameraModule.GALACTIC_CENTRE_TARGET) < 1e-9, s);

	const c = cameraModule.createCamera();
	const input = freshInput();
	const out = c.getState();
	const refs = [c.viewProj, c.cameraPos, c.forward, c.right, c.up, out.position, out.velocity, out.orbitTarget];
	let stable = true;
	for (let i = 0; i < 600; i++) {
		input.keys.forward = (i % 2) === 0;
		input.keys.right = (i % 5) === 0;
		input.lookDx = i % 7;
		input.wheelDelta = (i % 90 === 0) ? -NOTCH : 0;
		input.actions.cameraMode = (i % 100 === 0) ? 1 : 0;
		input.actions.home = (i % 250 === 0) ? 1 : 0;
		c.step(DT, input);
		c.buildViewProj(1.5);
		const state = c.getState(out);
		stable = stable && state === out
			&& c.viewProj === refs[0] && c.cameraPos === refs[1] && c.forward === refs[2] && c.right === refs[3] && c.up === refs[4]
			&& out.position === refs[5] && out.velocity === refs[6] && out.orbitTarget === refs[7]
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
