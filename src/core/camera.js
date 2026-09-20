// src/core/camera.js
// 6-DOF fly-through camera.
//
// Design notes (the parts that were wrong before, and why they are like this):
//
//   * Frame-rate independence. Velocity approaches the input target with
//     v += (vTarget - v) * (1 - exp(-dt/tau)). A per-frame constant damping
//     factor makes the ship faster on a 144 Hz monitor than on a 60 Hz one.
//   * WebGPU clip space is z in [0, 1], not the OpenGL [-1, 1]. Using the GL
//     projection clips the near field and makes depth comparisons meaningless.
//   * No depth buffer is used for additive star sprites, so near/far only
//     bound the clip volume; they are wide because the galaxy is 100 kpc deep.
//   * Zero allocation per frame: matrices are built into preallocated
//     Float32Arrays, input deltas are consumed (read and reset) in place.
//
// Position is f64 on the CPU (kpc, Sun at origin). The GPU gets the camera
// position as f32 and subtracts it from star positions in the vertex shader, so
// every rendered coordinate is near zero and f32 keeps sub-pixel accuracy.

'use strict';

const FOV_Y = Math.PI / 3;            // 60 deg vertical
const NEAR_KPC = 0.0002;              // 0.2 pc
const FAR_KPC = 500.0;                // halo is truncated at 100 kpc
const PITCH_LIMIT = Math.PI / 2 - 0.02;
const SPEED_MULT_MIN = 0.05;
const SPEED_MULT_MAX = 60.0;
const BASE_SPEED_KPC_S = 0.010;       // 10 pc/s at speedMult = 1
const VELOCITY_TAU = 0.22;            // s, velocity response time constant
const LOOK_SENSITIVITY = 0.0022;      // rad per pixel
const WHEEL_SPEED_GAIN = 0.0015;      // per wheel unit (log scale)
const BOOST_FACTOR = 8.0;
const START_POSITION = [0, 0, 0.005];

function createCamera() {
	const position = new Float64Array([START_POSITION[0], START_POSITION[1], START_POSITION[2]]);
	const velocity = new Float64Array(3);
	let yaw = 0;                    // around +Z, 0 looks at the galactic centre
	let pitch = 0;                  // around the camera right axis
	let speedMult = 1.0;

	// Outputs, allocated once.
	const viewProj = new Float32Array(16);
	const cameraPos = new Float32Array(4);
	const forward = new Float32Array(3);
	const right = new Float32Array(3);
	const up = new Float32Array(3);

	// Scratch matrices (column-major, matching WGSL mat4x4<f32>).
	const view = new Float32Array(16);
	const proj = new Float32Array(16);

	function updateCameraPos() {
		cameraPos[0] = position[0];
		cameraPos[1] = position[1];
		cameraPos[2] = position[2];
	}

	function updateBasis() {
		const cy = Math.cos(yaw);
		const sy = Math.sin(yaw);
		const cp = Math.cos(pitch);
		const sp = Math.sin(pitch);
		forward[0] = cy * cp;
		forward[1] = sy * cp;
		forward[2] = sp;
		// right = normalize(forward x worldUp) with worldUp = +Z; this is the
		// screen-right axis in a right-handed system looking down +forward.
		right[0] = sy;
		right[1] = -cy;
		right[2] = 0;
		// up = right x forward (stays continuous through the pitch clamp).
		up[0] = -cy * sp;
		up[1] = -sy * sp;
		up[2] = cp;
	}
	updateBasis();
	updateCameraPos();

	function reset() {
		position[0] = START_POSITION[0];
		position[1] = START_POSITION[1];
		position[2] = START_POSITION[2];
		velocity[0] = 0;
		velocity[1] = 0;
		velocity[2] = 0;
		yaw = 0;
		pitch = 0;
		speedMult = 1.0;
		updateBasis();
		updateCameraPos();
	}

	// Consume the per-frame input deltas, integrate, and move. Mutates `input`
	// (deltas are consumed exactly once) but allocates nothing.
	function step(dt, input) {
		if (!(dt > 0)) return;

		if (input.wheelDelta !== 0) {
			speedMult *= Math.exp(-input.wheelDelta * WHEEL_SPEED_GAIN);
			speedMult = Math.max(SPEED_MULT_MIN, Math.min(SPEED_MULT_MAX, speedMult));
			input.wheelDelta = 0;
		}

		if (input.lookDx !== 0 || input.lookDy !== 0) {
			yaw -= input.lookDx * LOOK_SENSITIVITY;
			pitch -= input.lookDy * LOOK_SENSITIVITY;
			pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
			input.lookDx = 0;
			input.lookDy = 0;
			updateBasis();
		}

		if (input.actions.reset) {
			input.actions.reset = 0;
			reset();
		}

		const keys = input.keys;
		let vx = 0, vy = 0, vz = 0;
		if (keys.forward) { vx += forward[0]; vy += forward[1]; vz += forward[2]; }
		if (keys.back) { vx -= forward[0]; vy -= forward[1]; vz -= forward[2]; }
		if (keys.right) { vx += right[0]; vy += right[1]; }
		if (keys.left) { vx -= right[0]; vy -= right[1]; }
		if (keys.up) vz += 1;
		if (keys.down) vz -= 1;

		const len = Math.sqrt(vx * vx + vy * vy + vz * vz);
		if (len > 1e-6) {
			const speed = BASE_SPEED_KPC_S * speedMult * (keys.boost ? BOOST_FACTOR : 1);
			const inv = speed / len;
			vx *= inv;
			vy *= inv;
			vz *= inv;
		} else {
			vx = 0;
			vy = 0;
			vz = 0;
		}

		// Exponential approach: identical motion at any frame rate.
		const k = 1 - Math.exp(-dt / VELOCITY_TAU);
		velocity[0] += (vx - velocity[0]) * k;
		velocity[1] += (vy - velocity[1]) * k;
		velocity[2] += (vz - velocity[2]) * k;

		position[0] += velocity[0] * dt;
		position[1] += velocity[1] * dt;
		position[2] += velocity[2] * dt;
		updateCameraPos();
	}

	// viewProj for a WebGPU render pass (z maps to [0, 1]) for CAMERA-RELATIVE
	// positions. Returns the preallocated Float32Array; callers must consume it
	// before the next call.
	//
	// The view matrix has no translation column: the shader already computes
	// starPosition - cameraPosition, so the eye is at the origin of that frame.
	// Carrying the world-space translation here would subtract the camera twice
	// and shift the entire sky by |cameraPosition| (invisible at the start
	// position, catastrophic 8 kpc away at the galactic centre).
	function buildViewProj(aspect) {
		const fx = forward[0], fy = forward[1], fz = forward[2];

		// right axis s = normalize(forward x worldUp)
		let sx = fy;
		let sy = -fx;
		let sz = 0;
		const slen = Math.sqrt(sx * sx + sy * sy);
		if (slen > 1e-8) { sx /= slen; sy /= slen; }
		else { sx = 1; sy = 0; sz = 0; }
		// camera up u = s x forward
		const ux = sy * fz - sz * fy;
		const uy = sz * fx - sx * fz;
		const uz = sx * fy - sy * fx;

		view[0] = sx; view[4] = sy; view[8] = sz;
		view[1] = ux; view[5] = uy; view[9] = uz;
		view[2] = -fx; view[6] = -fy; view[10] = -fz;
		view[3] = 0; view[7] = 0; view[11] = 0;
		view[12] = 0; view[13] = 0; view[14] = 0;
		view[15] = 1;

		const f = 1 / Math.tan(FOV_Y / 2);
		const rangeInv = 1 / (NEAR_KPC - FAR_KPC);
		proj[0] = f / aspect; proj[4] = 0; proj[8] = 0; proj[12] = 0;
		proj[1] = 0; proj[5] = f; proj[9] = 0; proj[13] = 0;
		proj[2] = 0; proj[6] = 0; proj[10] = FAR_KPC * rangeInv; proj[14] = NEAR_KPC * FAR_KPC * rangeInv;
		proj[3] = 0; proj[7] = 0; proj[11] = -1; proj[15] = 0;

		// viewProj = proj * view (column-major).
		for (let col = 0; col < 4; col++) {
			for (let row = 0; row < 4; row++) {
				let sum = 0;
				for (let k = 0; k < 4; k++) sum += proj[k * 4 + row] * view[col * 4 + k];
				viewProj[col * 4 + row] = sum;
			}
		}
		return viewProj;
	}

	// Writes into `out` (reuse it to stay allocation-free) and returns it.
	function getState(out) {
		const s = out || {};
		const p = s.position || (s.position = [0, 0, 0]);
		const v = s.velocity || (s.velocity = [0, 0, 0]);
		p[0] = position[0]; p[1] = position[1]; p[2] = position[2];
		v[0] = velocity[0]; v[1] = velocity[1]; v[2] = velocity[2];
		s.yaw = yaw;
		s.pitch = pitch;
		s.speedMult = speedMult;
		s.speedKpcPerSec = BASE_SPEED_KPC_S * speedMult;
		return s;
	}

	function setState(state) {
		position[0] = state.position[0];
		position[1] = state.position[1];
		position[2] = state.position[2];
		velocity[0] = state.velocity ? state.velocity[0] : 0;
		velocity[1] = state.velocity ? state.velocity[1] : 0;
		velocity[2] = state.velocity ? state.velocity[2] : 0;
		yaw = state.yaw || 0;
		pitch = state.pitch || 0;
		speedMult = state.speedMult || 1;
		updateBasis();
		updateCameraPos();
	}

	return {
		step,
		reset,
		buildViewProj,
		getState,
		setState,
		viewProj,
		cameraPos,
		forward,
		right,
		up,
		fovY: FOV_Y,
		near: NEAR_KPC,
		far: FAR_KPC,
	};
}

// One API object for both environments: a name that resolves under Node must
// also resolve in the page. Two hand-maintained lists drifted apart once and
// shipped a boot-time TypeError.
const Camera = {
	createCamera,
	FOV_Y, NEAR_KPC, FAR_KPC, PITCH_LIMIT,
	BASE_SPEED_KPC_S, SPEED_MULT_MIN, SPEED_MULT_MAX,
	VELOCITY_TAU, LOOK_SENSITIVITY, BOOST_FACTOR, START_POSITION,
};
if (typeof module !== 'undefined') module.exports = Camera;
if (typeof window !== 'undefined') window.Camera = Camera;
