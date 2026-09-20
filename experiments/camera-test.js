// experiments/camera-test.js
// Validates the fly-through camera: basis, WebGPU projection, frame-rate
// independence, input consumption and allocation behaviour.
//
// These are the properties that make the fly-through feel right; the previous
// implementation failed several of them (per-frame damping, OpenGL-style
// projection, per-frame matrix allocations).
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
		keys: { forward: false, back: false, left: false, right: false, up: false, down: false, boost: false },
		lookDx: 0,
		lookDy: 0,
		wheelDelta: 0,
		actions: { reset: 0, exposure: 0 },
	};
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
	check('the camera actually moved', at60 > 0.01, at60);
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
	const slow = cameraModule.createCamera();
	const fast = cameraModule.createCamera();
	const i1 = freshInput(); i1.wheelDelta = -500;
	const i2 = freshInput(); i2.wheelDelta = 500;
	slow.step(1 / 60, i1);
	fast.step(1 / 60, i2);
	check('scroll up speeds up, scroll down slows down',
		slow.getState().speedMult > 1 && fast.getState().speedMult < 1,
		{ up: slow.getState().speedMult, down: fast.getState().speedMult });

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
