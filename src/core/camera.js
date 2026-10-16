// src/core/camera.js
// Fly-through camera with two ways of moving: 6-DOF fly with momentum, and
// orbit around a target (the galactic centre or a selected object).
//
// Design notes (the parts that were wrong before, and why they are like this):
//
//   * Orientation is a unit quaternion, not yaw/pitch integration. Mouse and
//     orbit-key turns rotate around the camera's current screen axes, so the
//     camera can look straight up, straight down, loop over the poles, and keep
//     a valid right/up basis. `yaw` and `pitch` in getState() are diagnostics
//     derived from the forward vector for overlays/tests; they do not drive the
//     camera and therefore do not clamp it.
//   * Orbit derives the position from orientation: position = target - distance
//     * forward. Mouse look is therefore the same code in both modes, switching
//     modes is continuous, and orbit drag lands on the usual "grab the world"
//     feel (drag right, the camera swings left) with no sign table.
//   * Frame-rate independence. Fly velocity approaches the input target with
//     v += (vTarget - v) * (1 - exp(-dt/tau)); orbit angles and distance are
//     rates times dt; the fly-to flight eases on elapsed/duration. A per-frame
//     constant damping factor makes the ship faster on a 144 Hz monitor than
//     on a 60 Hz one.
//   * Fly-to (Shift+F, plan §18) is a 2 s flight, not a teleport: the camera's
//     offset from the *live* target eases from the launch offset to the
//     stand-off (flown in the target's frame, so a star that moves under star
//     time is closed on monotonically, never chased past), plus a
//     shortest-path quaternion slerp, then the orbit handover. Any user input
//     cancels into the usual orbit re-snap; updateTarget() moves the orbited
//     object so the camera follows it centred. The caller must update the
//     target *before* step() each frame.
//   * Chase follow (j, ui.6) is an orbit-object sub-mode: the camera rides
//     *behind* the target, its forward eased onto the target's movement
//     vector, so the view is always where the object is heading and the
//     object stays dead-centre (position = target - distance * forward, the
//     same law as the orbit placement — only the direction's owner changes:
//     the movement vector instead of the user). Look and A/D/E/Q rotate the
//     direction and the same ease pulls it back behind, so a glance around is
//     temporary by construction; W/S and the wheel still dolly.
//   * The wheel steps by whole notches out of a persistent accumulator.
//     Rounding each frame's delta made trackpads (3-10 px events) inert.
//   * The speed multiplier walks a x2 grid, so its clamps are powers of two:
//     clamped at 0.02 it could never return to exactly x1.
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
// Backward-compatible export for older experiments. Orientation is quaternion
// driven now, so pitch is intentionally unlimited.
const PITCH_LIMIT = Infinity;
const LY_TO_KPC = 0.000306601;        // 1 ly = 0.306601 pc
const BASE_SPEED_KPC_S = 8 * LY_TO_KPC;   // 8 ly/s at speedMult = 1
const SPEED_MULT_MIN = 1 / 64;        // powers of two: see the x2 grid note above
const SPEED_MULT_MAX = 256;
const BOOST_FACTOR = 100.0;           // Shift
const SLOW_FACTOR = 0.1;              // Ctrl
const WHEEL_NOTCH_PX = 100;           // input.js folds every deltaMode into px; one mouse notch
const VELOCITY_TAU = 0.22;            // s, velocity response time constant
const LOOK_SENSITIVITY = 0.0022;      // rad per pixel
const ORBIT_DISTANCE_MIN = 0.0001;    // 0.1 pc
const ORBIT_DISTANCE_MAX = 100.0;     // kpc
// Fly-to stand-off (plan §3.4): standOffKpc = clamp(K·sqrt(L/L☉), MIN, MAX).
const STAND_OFF_KPC_PER_SQRT_L = 0.0006;
const STAND_OFF_KPC_MAX = 0.01;       // 10 pc
const ORBIT_TURN_RATE = 1.0;          // rad/s for A/D/E/Q in orbit
const ORBIT_DOLLY_RATE = 1.0;         // octaves/s for W/S in orbit: distance halves or doubles per second
const ORBIT_KEY_BOOST = 4.0;          // Shift x4, Ctrl x1/4 on orbit key rates; x100 would be 16 turns a second
const HOME_ORBIT_DISTANCE = 0.01;     // kpc, H in orbit: the Sun from 10 pc
// Fly-to flight (plan §18): eased translation + shortest-path slerp from the
// current pose to the stand-off orbit, then the orbit handover.
const FLIGHT_DURATION_S = 2.0;
const FLIGHT_UP_POLE_COS = 0.99;      // approach this close to ±Z keeps the current up
const QUAT_EPS = 1e-12;
// Chase follow (j, ui.6): the swing onto the target's movement vector is an
// exponential ease with its own time constant, and the movement itself is
// measured between consecutive updateTarget() feeds. Frozen star time draws
// bit-identical positions (the dispatch is deterministic), so the movement
// test needs no noise margin — below the epsilon the direction simply keeps
// its last value and the chase degenerates to a free orbit.
const CHASE_DIR_TAU = 0.5;            // s, swing onto the movement vector
const CHASE_MOVE_EPS_KPC = 1e-12;     // kpc per frame; 1e-9 pc is far below star motion
// The default frame is the Milky Way preset's: the Sun-centred origin, the view
// from 5 pc above it, the galactic centre as the orbit centre. setFrame() swaps
// all of it when the user changes galaxy type, so nothing here is a second copy
// of a model constant.
const DEFAULT_FRAME = (typeof module !== 'undefined' && module.exports)
	? require('../math/galaxy.js').MILKY_WAY
	: window.GalaxyLib.MILKY_WAY;
const START_POSITION = DEFAULT_FRAME.home.position;
const SUN_POSITION = [0, 0, 0];

const MODE_FLY = 0;
const MODE_ORBIT_GC = 1;
const MODE_ORBIT_OBJECT = 2;
const MODE_NAMES = ['fly', 'orbit centre', 'orbit object'];

// The orbit centre is the model's, not a second copy of 8.178.
const GALACTIC_CENTRE_TARGET = Float64Array.of(
	DEFAULT_FRAME.centre.x, DEFAULT_FRAME.centre.y, DEFAULT_FRAME.centre.z);
const GALACTIC_CENTRE_NAME = 'galactic centre';
const SUN_NAME = DEFAULT_FRAME.home.orbitName;

function clamp(value, lo, hi) {
	return value < lo ? lo : (value > hi ? hi : value);
}

function keyFactor(keys, boost, slow) {
	return (keys.boost ? boost : 1) * (keys.slow ? slow : 1);
}

function createCamera() {
	const position = new Float64Array([START_POSITION[0], START_POSITION[1], START_POSITION[2]]);
	const velocity = new Float64Array(3);
	// Unit quaternion mapping local camera axes (+X forward, -Y right, +Z up)
	// into the galaxy frame. Identity looks at the galactic centre from the Sun.
	const orientation = new Float64Array([0, 0, 0, 1]);
	let yaw = 0;                    // diagnostic heading from forward, not control state
	let pitch = 0;                  // diagnostic elevation from forward, not control state
	let speedMult = 1.0;
	let speedFactor = 1.0;          // Shift/Ctrl product last seen in fly mode
	let wheelAccum = 0;             // px not yet worth a whole notch

	let mode = MODE_FLY;
	const objectTarget = new Float64Array([SUN_POSITION[0], SUN_POSITION[1], SUN_POSITION[2]]);
	let objectTargetName = SUN_NAME;
	let orbitDistance = HOME_ORBIT_DISTANCE;
	// The galaxy's frame: what C orbits and what H returns to. Mutated in place by
	// setFrame() so a type change rehomes the camera instead of rebuilding it.
	const orbitCentre = new Float64Array(GALACTIC_CENTRE_TARGET);
	const homePosition = new Float64Array(DEFAULT_FRAME.home.position);
	const homeOrbitTarget = new Float64Array(DEFAULT_FRAME.home.orbitTarget);
	let homeYaw = DEFAULT_FRAME.home.yaw;
	let homePitch = DEFAULT_FRAME.home.pitch;
	let homeOrbitDistance = DEFAULT_FRAME.home.orbitDistance;
	let homeOrbitName = DEFAULT_FRAME.home.orbitName;

	// Outputs, allocated once. forward/right/up are the f32 copies the renderer
	// and the tests read; the camera itself moves along the f64 basis so an
	// 8 kpc orbit is not placed with a 7-digit direction (0.5 mpc of jitter).
	const viewProj = new Float32Array(16);
	const cameraPos = new Float32Array(4);
	const forward = new Float32Array(3);
	const right = new Float32Array(3);
	const up = new Float32Array(3);
	const forwardExact = new Float64Array(3);
	const rightExact = new Float64Array(3);
	const upExact = new Float64Array(3);

	// Scratch matrices (column-major, matching WGSL mat4x4<f32>).
	const view = new Float32Array(16);
	const proj = new Float32Array(16);

	function updateCameraPos() {
		cameraPos[0] = position[0];
		cameraPos[1] = position[1];
		cameraPos[2] = position[2];
	}

	function normalizeOrientation() {
		const x = orientation[0], y = orientation[1], z = orientation[2], w = orientation[3];
		const len = Math.sqrt(x * x + y * y + z * z + w * w);
		if (len > QUAT_EPS) {
			const inv = 1 / len;
			orientation[0] = x * inv;
			orientation[1] = y * inv;
			orientation[2] = z * inv;
			orientation[3] = w * inv;
			return;
		}
		orientation[0] = 0;
		orientation[1] = 0;
		orientation[2] = 0;
		orientation[3] = 1;
	}

	function updateAnglesFromBasis() {
		yaw = Math.atan2(forwardExact[1], forwardExact[0]);
		pitch = Math.asin(clamp(forwardExact[2], -1, 1));
	}

	function updateBasis() {
		normalizeOrientation();
		const x = orientation[0], y = orientation[1], z = orientation[2], w = orientation[3];
		const xx = x * x, yy = y * y, zz = z * z;
		const xy = x * y, xz = x * z, yz = y * z;
		const wx = w * x, wy = w * y, wz = w * z;

		// Rotation matrix columns are the images of local +X, +Y, +Z. The camera's
		// local right axis is -Y, so right is the negated second column.
		forwardExact[0] = 1 - 2 * (yy + zz);
		forwardExact[1] = 2 * (xy + wz);
		forwardExact[2] = 2 * (xz - wy);
		rightExact[0] = -2 * (xy - wz);
		rightExact[1] = -(1 - 2 * (xx + zz));
		rightExact[2] = -2 * (yz + wx);
		upExact[0] = 2 * (xz + wy);
		upExact[1] = 2 * (yz - wx);
		upExact[2] = 1 - 2 * (xx + yy);

		forward.set(forwardExact);
		right.set(rightExact);
		up.set(upExact);
		updateAnglesFromBasis();
	}

	function quatFromBasis(out, fx, fy, fz, rx, ry, rz, ux, uy, uz) {
		// Standard local +Y maps to -right.
		const m00 = fx, m01 = -rx, m02 = ux;
		const m10 = fy, m11 = -ry, m12 = uy;
		const m20 = fz, m21 = -rz, m22 = uz;
		const trace = m00 + m11 + m22;
		let s;
		if (trace > 0) {
			s = Math.sqrt(trace + 1) * 2;
			out[3] = 0.25 * s;
			out[0] = (m21 - m12) / s;
			out[1] = (m02 - m20) / s;
			out[2] = (m10 - m01) / s;
		} else if (m00 > m11 && m00 > m22) {
			s = Math.sqrt(1 + m00 - m11 - m22) * 2;
			out[3] = (m21 - m12) / s;
			out[0] = 0.25 * s;
			out[1] = (m01 + m10) / s;
			out[2] = (m02 + m20) / s;
		} else if (m11 > m22) {
			s = Math.sqrt(1 + m11 - m00 - m22) * 2;
			out[3] = (m02 - m20) / s;
			out[0] = (m01 + m10) / s;
			out[1] = 0.25 * s;
			out[2] = (m12 + m21) / s;
		} else {
			s = Math.sqrt(1 + m22 - m00 - m11) * 2;
			out[3] = (m10 - m01) / s;
			out[0] = (m02 + m20) / s;
			out[1] = (m12 + m21) / s;
			out[2] = 0.25 * s;
		}
	}

	function setOrientationFromBasis(fx, fy, fz, rx, ry, rz, ux, uy, uz) {
		quatFromBasis(orientation, fx, fy, fz, rx, ry, rz, ux, uy, uz);
		updateBasis();
	}

	function setOrientationFromYawPitch(nextYaw, nextPitch) {
		const cy = Math.cos(nextYaw);
		const sy = Math.sin(nextYaw);
		const cp = Math.cos(nextPitch);
		const sp = Math.sin(nextPitch);
		setOrientationFromBasis(
			cy * cp, sy * cp, sp,
			sy, -cy, 0,
			-cy * sp, -sy * sp, cp);
	}

	function rotateOrientation(ax, ay, az, angle) {
		if (angle === 0) return;
		const axisLen = Math.sqrt(ax * ax + ay * ay + az * az);
		if (axisLen <= QUAT_EPS) return;
		const half = angle * 0.5;
		const s = Math.sin(half) / axisLen;
		const qx = ax * s;
		const qy = ay * s;
		const qz = az * s;
		const qw = Math.cos(half);
		const x = orientation[0], y = orientation[1], z = orientation[2], w = orientation[3];
		orientation[0] = qw * x + qx * w + qy * z - qz * y;
		orientation[1] = qw * y - qx * z + qy * w + qz * x;
		orientation[2] = qw * z + qx * y - qy * x + qz * w;
		orientation[3] = qw * w - qx * x - qy * y - qz * z;
	}

	function applyLook(dx, dy) {
		if (dx !== 0) {
			rotateOrientation(upExact[0], upExact[1], upExact[2], -dx * LOOK_SENSITIVITY);
			updateBasis();
		}
		if (dy !== 0) {
			rotateOrientation(rightExact[0], rightExact[1], rightExact[2], -dy * LOOK_SENSITIVITY);
			updateBasis();
		}
	}

	function aimForwardAt(dx, dy, dz) {
		const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
		if (len <= QUAT_EPS) return;
		const tx = dx / len;
		const ty = dy / len;
		const tz = dz / len;
		let dot = forwardExact[0] * tx + forwardExact[1] * ty + forwardExact[2] * tz;
		dot = clamp(dot, -1, 1);
		if (dot > 1 - 1e-12) return;
		if (dot < -1 + 1e-12) {
			rotateOrientation(upExact[0], upExact[1], upExact[2], Math.PI);
			updateBasis();
			return;
		}
		const ax = forwardExact[1] * tz - forwardExact[2] * ty;
		const ay = forwardExact[2] * tx - forwardExact[0] * tz;
		const az = forwardExact[0] * ty - forwardExact[1] * tx;
		rotateOrientation(ax, ay, az, Math.atan2(Math.sqrt(ax * ax + ay * ay + az * az), dot));
		updateBasis();
	}

	updateBasis();
	updateCameraPos();

	function setPosition(p) {
		position[0] = p[0];
		position[1] = p[1];
		position[2] = p[2];
	}

	function stopVelocity() {
		velocity[0] = 0;
		velocity[1] = 0;
		velocity[2] = 0;
	}

	// --- Orbit ------------------------------------------------------------
	function orbitTarget() {
		return mode === MODE_ORBIT_GC ? orbitCentre : objectTarget;
	}

	function placeOnOrbit() {
		const t = orbitTarget();
		position[0] = t[0] - orbitDistance * forwardExact[0];
		position[1] = t[1] - orbitDistance * forwardExact[1];
		position[2] = t[2] - orbitDistance * forwardExact[2];
		updateCameraPos();
	}

	// Aim at the target from where the camera is. With the orientation set this
	// way, target - distance * forward is the current position: entering orbit
	// turns the camera, it does not move it (unless a distance clamp intervenes).
	function snapToOrbit() {
		const t = orbitTarget();
		const dx = t[0] - position[0];
		const dy = t[1] - position[1];
		const dz = t[2] - position[2];
		const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
		orbitDistance = clamp(d, ORBIT_DISTANCE_MIN, ORBIT_DISTANCE_MAX);
		if (d > 0) aimForwardAt(dx, dy, dz);
		stopVelocity();
		rebaseChaseFeed();
		placeOnOrbit();
	}

	// The mode is chosen directly (c/C/f in input.js; ui.4 replaced the C
	// cycle), never cycled: each key knows the mode it enters. Chase follow
	// belongs to the object orbit alone, so leaving it turns chase off.
	function setMode(next) {
		if (next === mode) return;
		flightActive = false;
		if (next !== MODE_ORBIT_OBJECT) chaseOn = false;
		mode = next;
		if (mode === MODE_FLY) return;   // position and orientation continue; velocity is already zero
		snapToOrbit();
	}

	function assignObjectTarget(x, y, z, name) {
		objectTarget[0] = x;
		objectTarget[1] = y;
		objectTarget[2] = z;
		objectTargetName = name;
		rebaseChaseFeed();
	}

	// Selection hook (0.1.2 calls this on click). While the object is being
	// orbited the camera turns towards the new one from where it is.
	function setOrbitTarget(x, y, z, name) {
		flightActive = false;
		assignObjectTarget(x, y, z, name);
		if (mode === MODE_ORBIT_OBJECT) snapToOrbit();
	}

	// Stand-off for a star of luminosity `lum` L☉ (plan §3.4): the Sun lands at
	// 0.6 pc ≈ 2 ly, a late M dwarf sits on the 0.1 pc floor, and a 10 000 L☉
	// supergiant clamps to the 10 pc ceiling — the whole field in front of it
	// rather than the camera inside the star.
	function orbitStandOff(lum) {
		const l = lum > 0 ? lum : 0;
		return clamp(STAND_OFF_KPC_PER_SQRT_L * Math.sqrt(l), ORBIT_DISTANCE_MIN, STAND_OFF_KPC_MAX);
	}

	// --- Fly-to flight ----------------------------------------------------
	// flyToStar no longer teleports (plan §18): it launches a FLIGHT_DURATION_S
	// flight from the current pose to the stand-off orbit. The arrival pose is
	// re-derived from the live target every frame, so a moving object is met
	// where it arrives; any user input cancels into the usual orbit re-snap.
	const flightStartOffset = new Float64Array(3);  // launch position relative to the target
	const flightStartQuat = new Float64Array(4);
	const flightApproach = new Float64Array(3);   // unit vector, target → launch point
	const flightUp = new Float64Array(3);         // desired arrival up
	const flightQuat = new Float64Array(4);       // arrival orientation, rebuilt per frame
	let flightActive = false;
	let flightElapsed = 0;
	let flightDistance = HOME_ORBIT_DISTANCE;

	// Chase follow (j, ui.6): the eased direction the camera trails the target
	// on, and the movement feed — the target's previous drawn position, rebased
	// whenever the target is assigned rather than refreshed (a swap is not
	// motion). chaseSpeed is the target's own apparent speed, read by the HUD.
	let chaseOn = false;
	const chaseDir = new Float64Array([1, 0, 0]);
	const chasePrevTarget = new Float64Array(3);
	let chaseHasPrev = false;
	let chaseSpeedKpcPerSec = 0;

	// Shortest-path quaternion slerp into `orientation` (unit inputs assumed).
	function slerpOrientation(a, b, t) {
		let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
		const sign = dot < 0 ? -1 : 1;
		dot *= sign;
		let w0, w1;
		if (dot > 1 - 1e-9) {
			// Nearly identical: NLERP, the acos/sin table would divide by ~0.
			w0 = 1 - t;
			w1 = t;
		} else {
			const theta = Math.acos(dot > 1 ? 1 : dot);
			const invSin = 1 / Math.sin(theta);
			w0 = Math.sin((1 - t) * theta) * invSin;
			w1 = Math.sin(t * theta) * invSin;
		}
		w1 *= sign;
		orientation[0] = a[0] * w0 + b[0] * w1;
		orientation[1] = a[1] * w0 + b[1] * w1;
		orientation[2] = a[2] * w0 + b[2] * w1;
		orientation[3] = a[3] * w0 + b[3] * w1;
	}

	// Fly to a star (plan §3.4, Shift+F): orbit it at the stand-off its
	// luminosity implies, arriving by a 2 s flight instead of a jump. With
	// standOffKpc ≤ 0 the current target distance is kept.
	function flyToStar(x, y, z, name, standOffKpc) {
		assignObjectTarget(x, y, z, name);
		const dx = position[0] - x, dy = position[1] - y, dz = position[2] - z;
		const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
		flightDistance = standOffKpc > 0
			? clamp(standOffKpc, ORBIT_DISTANCE_MIN, ORBIT_DISTANCE_MAX)
			: clamp(mode === MODE_ORBIT_OBJECT ? orbitDistance : d, ORBIT_DISTANCE_MIN, ORBIT_DISTANCE_MAX);
		mode = MODE_ORBIT_OBJECT;
		if (d > QUAT_EPS) {
			const inv = 1 / d;
			flightApproach[0] = dx * inv;
			flightApproach[1] = dy * inv;
			flightApproach[2] = dz * inv;
		} else {
			// Already on the star: fly the in-place turn along -forward.
			flightApproach[0] = -forwardExact[0];
			flightApproach[1] = -forwardExact[1];
			flightApproach[2] = -forwardExact[2];
		}
		// Arrival up is galactic north; an approach that rides the pole falls
		// back to the current up, then to the current right — of two
		// orthonormal vectors at most one can be near-parallel to the arrival
		// forward (which is -approach), so the chain always finds a usable up.
		if (Math.abs(flightApproach[2]) < FLIGHT_UP_POLE_COS) {
			flightUp[0] = 0; flightUp[1] = 0; flightUp[2] = 1;
		} else if (Math.abs(upExact[0] * flightApproach[0]
			+ upExact[1] * flightApproach[1]
			+ upExact[2] * flightApproach[2]) < FLIGHT_UP_POLE_COS) {
			flightUp[0] = upExact[0]; flightUp[1] = upExact[1]; flightUp[2] = upExact[2];
		} else {
			flightUp[0] = rightExact[0]; flightUp[1] = rightExact[1]; flightUp[2] = rightExact[2];
		}
		stopVelocity();
		flightStartOffset[0] = dx;
		flightStartOffset[1] = dy;
		flightStartOffset[2] = dz;
		flightStartQuat[0] = orientation[0];
		flightStartQuat[1] = orientation[1];
		flightStartQuat[2] = orientation[2];
		flightStartQuat[3] = orientation[3];
		flightElapsed = 0;
		flightActive = true;
		return flightDistance;
	}

	function stepFlight(dt) {
		flightElapsed += dt;
		const s = flightElapsed >= FLIGHT_DURATION_S ? 1 : flightElapsed / FLIGHT_DURATION_S;
		const ease = s * s * (3 - 2 * s);
		// The flight is flown in the target's frame: the camera's offset from the
		// *live* target eases from the launch offset to the stand-off. A star that
		// moves under star time carries the camera with it, so the approach is a
		// monotonic closing and the arrival is exactly on the star — an absolute
		// start→arrival lerp would chase a moving target and overshoot it.
		const keep = 1 - ease;
		const arrive = flightDistance * ease;
		position[0] = objectTarget[0] + flightStartOffset[0] * keep + flightApproach[0] * arrive;
		position[1] = objectTarget[1] + flightStartOffset[1] * keep + flightApproach[1] * arrive;
		position[2] = objectTarget[2] + flightStartOffset[2] * keep + flightApproach[2] * arrive;
		const fx = -flightApproach[0], fy = -flightApproach[1], fz = -flightApproach[2];
		const fdot = flightUp[0] * fx + flightUp[1] * fy + flightUp[2] * fz;
		let ux = flightUp[0] - fdot * fx;
		let uy = flightUp[1] - fdot * fy;
		let uz = flightUp[2] - fdot * fz;
		const ulen = Math.sqrt(ux * ux + uy * uy + uz * uz);
		const invU = ulen > QUAT_EPS ? 1 / ulen : 0;
		ux *= invU; uy *= invU; uz *= invU;
		// right = forward × up (the image of the camera's local -Y axis).
		const rx = fy * uz - fz * uy;
		const ry = fz * ux - fx * uz;
		const rz = fx * uy - fy * ux;
		quatFromBasis(flightQuat, fx, fy, fz, rx, ry, rz, ux, uy, uz);
		slerpOrientation(flightStartQuat, flightQuat, ease);
		updateBasis();
		updateCameraPos();
		if (s === 1) {
			// Handover: exactly the pose the path reached, so arrival is
			// continuous and the orbit controls take over from here. A chase
			// re-baselines its movement feed: the flight carried the target
			// along for seconds, and that distance is not one frame's motion.
			flightActive = false;
			orbitDistance = flightDistance;
			rebaseChaseFeed();
			placeOnOrbit();
		}
	}

	// User input (or a frame change) ends the flight at the current pose: the
	// distance re-measures from where the camera is and the orientation
	// re-aims — the same continuous re-snap a mode switch uses.
	function cancelFlight() {
		if (!flightActive) return;
		flightActive = false;
		rebaseChaseFeed();
		snapToOrbit();
	}

	// --- Chase follow (j) ---------------------------------------------------
	// The feed: rebase the movement baseline to the target as it stands right
	// now — after a target assignment, a flight handover or a re-snap — so
	// the next step measures one frame of real motion, never a jump, and the
	// ease starts on the very first chase frame (a cleared baseline would
	// skip it, making the swing one frame shorter at high refresh rates).
	// The direction itself needs no reset: stepChase re-reads it from the
	// camera's forward every frame.
	function rebaseChaseFeed() {
		chasePrevTarget[0] = objectTarget[0];
		chasePrevTarget[1] = objectTarget[1];
		chasePrevTarget[2] = objectTarget[2];
		chaseHasPrev = true;
		chaseSpeedKpcPerSec = 0;
	}

	// Chase is a sub-mode of the object orbit: leaving orbit-object (f, C,
	// reset) turns it off, so the flag can never describe a mode it is not
	// running in. Enabling outside the object orbit is a no-op — the caller
	// enters that mode first (main.js's j routes through orbitPrimary).
	function setChase(enabled) {
		chaseOn = enabled && mode === MODE_ORBIT_OBJECT;
		rebaseChaseFeed();
	}

	// Ease the chase direction onto the movement vector by a spherical
	// interpolation of the remaining angle. slerp, not nlerp: slerp by the
	// fraction k reduces the angle to (1-k) of it, and the per-frame factors
	// are exp(-dt/tau), so the composition over equal elapsed time is exact —
	// the swing is frame-rate independent to the bit, like the fly velocity.
	// Returns the movement length so the caller can report the target's speed.
	function easeChaseDirection(dt, mx, my, mz) {
		const len = Math.sqrt(mx * mx + my * my + mz * mz);
		if (len <= CHASE_MOVE_EPS_KPC) return 0;
		const inv = 1 / len;
		const tx = mx * inv, ty = my * inv, tz = mz * inv;
		let dot = chaseDir[0] * tx + chaseDir[1] * ty + chaseDir[2] * tz;
		dot = clamp(dot, -1, 1);
		const k = 1 - Math.exp(-dt / CHASE_DIR_TAU);
		if (dot > 1 - 1e-9) {
			// Nearly aligned: below any measurable misalignment, take it.
			chaseDir[0] = tx; chaseDir[1] = ty; chaseDir[2] = tz;
		} else if (dot < -1 + 1e-6) {
			// A full reversal has no unique short way round; the movement
			// vector wins outright (reachable only through degenerate feeds —
			// real motion rotates through perpendicular, never jumps past it).
			chaseDir[0] = tx; chaseDir[1] = ty; chaseDir[2] = tz;
		} else {
			const theta = Math.acos(dot);
			const invSin = 1 / Math.sin(theta);
			const w0 = Math.sin((1 - k) * theta) * invSin;
			const w1 = Math.sin(k * theta) * invSin;
			chaseDir[0] = chaseDir[0] * w0 + tx * w1;
			chaseDir[1] = chaseDir[1] * w0 + ty * w1;
			chaseDir[2] = chaseDir[2] * w0 + tz * w1;
		}
		return len;
	}

	// Behind the target along the eased direction, looking where it heads:
	// position = target - distance * forward is the orbit placement law with
	// the direction owned by the movement vector, so the target stays dead
	// centre. Up rides galactic north with the fly-to's pole chain, so a
	// near-vertical motion keeps a valid basis.
	function placeChase() {
		const fx = chaseDir[0], fy = chaseDir[1], fz = chaseDir[2];
		let ux, uy, uz;
		if (Math.abs(fz) < FLIGHT_UP_POLE_COS) {
			ux = 0; uy = 0; uz = 1;
		} else if (Math.abs(upExact[0] * fx + upExact[1] * fy + upExact[2] * fz) < FLIGHT_UP_POLE_COS) {
			ux = upExact[0]; uy = upExact[1]; uz = upExact[2];
		} else {
			ux = rightExact[0]; uy = rightExact[1]; uz = rightExact[2];
		}
		const fdot = ux * fx + uy * fy + uz * fz;
		ux -= fdot * fx; uy -= fdot * fy; uz -= fdot * fz;
		const ulen = Math.sqrt(ux * ux + uy * uy + uz * uz);
		const invU = ulen > QUAT_EPS ? 1 / ulen : 0;
		ux *= invU; uy *= invU; uz *= invU;
		// right = forward × up (the image of the camera's local -Y axis).
		const rx = fy * uz - fz * uy;
		const ry = fz * ux - fx * uz;
		const rz = fx * uy - fy * ux;
		setOrientationFromBasis(fx, fy, fz, rx, ry, rz, ux, uy, uz);
		position[0] = objectTarget[0] - orbitDistance * fx;
		position[1] = objectTarget[1] - orbitDistance * fy;
		position[2] = objectTarget[2] - orbitDistance * fz;
		updateCameraPos();
	}

	// Turn, dolly, then re-own the direction: the turn (and any look, already
	// applied above) rotated the camera, the chase direction *is* that
	// forward, and the alignment ease swings it back onto the object's motion.
	// Renormalized once per frame so |position - target| = orbitDistance
	// holds to the last bit despite the quaternion round trip.
	function stepChase(dt, keys, notches) {
		const factor = keyFactor(keys, ORBIT_KEY_BOOST, 1 / ORBIT_KEY_BOOST);
		orbitTurn(dt, keys, factor);
		const octaves = dollyOctaves(dt, keys, notches, factor);
		if (octaves !== 0) orbitDistance = clamp(orbitDistance * Math.pow(2, octaves), ORBIT_DISTANCE_MIN, ORBIT_DISTANCE_MAX);
		chaseDir[0] = forwardExact[0];
		chaseDir[1] = forwardExact[1];
		chaseDir[2] = forwardExact[2];
		let moved = 0;
		if (chaseHasPrev) {
			moved = easeChaseDirection(dt,
				objectTarget[0] - chasePrevTarget[0],
				objectTarget[1] - chasePrevTarget[1],
				objectTarget[2] - chasePrevTarget[2]);
			const len = Math.sqrt(chaseDir[0] * chaseDir[0] + chaseDir[1] * chaseDir[1] + chaseDir[2] * chaseDir[2]);
			if (len > QUAT_EPS) {
				const inv = 1 / len;
				chaseDir[0] *= inv;
				chaseDir[1] *= inv;
				chaseDir[2] *= inv;
			}
		}
		chaseSpeedKpcPerSec = moved > 0 ? moved / dt : 0;
		chasePrevTarget[0] = objectTarget[0];
		chasePrevTarget[1] = objectTarget[1];
		chasePrevTarget[2] = objectTarget[2];
		chaseHasPrev = true;
		placeChase();
	}

	// Move the orbited object in place (fly-to follow): no re-snap, no rename.
	// The next orbit step re-places the camera around the new position, so the
	// star stays centred; during a flight the arrival pose follows it instead.
	function updateTarget(x, y, z) {
		objectTarget[0] = x;
		objectTarget[1] = y;
		objectTarget[2] = z;
	}

	// --- Frame / home / reset -------------------------------------------------
	// Install a galaxy's frame. A type change rehomes the camera rather than
	// re-driving it: the mode and velocity stay, the positions they were measured
	// against do not exist in the new model.
	function setFrame(model) {
		const centre = model.centre;
		orbitCentre[0] = centre.x;
		orbitCentre[1] = centre.y;
		orbitCentre[2] = centre.z;
		const home = model.home;
		homePosition[0] = home.position[0];
		homePosition[1] = home.position[1];
		homePosition[2] = home.position[2];
		homeYaw = home.yaw;
		homePitch = home.pitch;
		homeOrbitTarget[0] = home.orbitTarget[0];
		homeOrbitTarget[1] = home.orbitTarget[1];
		homeOrbitTarget[2] = home.orbitTarget[2];
		homeOrbitDistance = clamp(home.orbitDistance, ORBIT_DISTANCE_MIN, ORBIT_DISTANCE_MAX);
		homeOrbitName = home.orbitName;
		// Orbit-the-centre keeps looking at the centre from wherever the camera
		// already stands; every other mode moves to the home view, because the old
		// position can be inside the new model's spheroid.
		if (mode !== MODE_ORBIT_GC) goHome();
	}

	// Fly: teleport to the model's home view. Orbit: circle the model's home
	// target — the Sun for the Milky Way preset, the centre for any other type —
	// keeping the viewing direction so the jump is a translation, not a spin.
	function goHome() {
		flightActive = false;
		if (mode === MODE_FLY) {
			setPosition(homePosition);
			stopVelocity();
			setOrientationFromYawPitch(homeYaw, homePitch);
			updateCameraPos();
			return;
		}
		mode = MODE_ORBIT_OBJECT;
		assignObjectTarget(homeOrbitTarget[0], homeOrbitTarget[1], homeOrbitTarget[2], homeOrbitName);
		orbitDistance = homeOrbitDistance;
		placeOnOrbit();
	}

	function reset() {
		mode = MODE_FLY;
		flightActive = false;
		chaseOn = false;
		speedMult = 1.0;
		wheelAccum = 0;
		orbitDistance = homeOrbitDistance;
		assignObjectTarget(homeOrbitTarget[0], homeOrbitTarget[1], homeOrbitTarget[2], homeOrbitName);
		goHome();
	}

	// --- Per-frame --------------------------------------------------------
	// Whole notches since the last call; the remainder waits for the next one.
	function takeWheelNotches(input) {
		wheelAccum += input.wheelDelta;
		input.wheelDelta = 0;
		const notches = Math.trunc(wheelAccum / WHEEL_NOTCH_PX);
		wheelAccum -= notches * WHEEL_NOTCH_PX;
		return notches;
	}

	function stepFly(dt, keys, notches) {
		if (notches !== 0) speedMult = clamp(speedMult * Math.pow(2, -notches), SPEED_MULT_MIN, SPEED_MULT_MAX);
		speedFactor = keyFactor(keys, BOOST_FACTOR, SLOW_FACTOR);

		let vx = 0, vy = 0, vz = 0;
		if (keys.forward) { vx += forwardExact[0]; vy += forwardExact[1]; vz += forwardExact[2]; }
		if (keys.back) { vx -= forwardExact[0]; vy -= forwardExact[1]; vz -= forwardExact[2]; }
		if (keys.right) { vx += rightExact[0]; vy += rightExact[1]; vz += rightExact[2]; }
		if (keys.left) { vx -= rightExact[0]; vy -= rightExact[1]; vz -= rightExact[2]; }
		if (keys.up) { vx += upExact[0]; vy += upExact[1]; vz += upExact[2]; }
		if (keys.down) { vx -= upExact[0]; vy -= upExact[1]; vz -= upExact[2]; }

		const len = Math.sqrt(vx * vx + vy * vy + vz * vz);
		if (len > 1e-6) {
			const inv = BASE_SPEED_KPC_S * speedMult * speedFactor / len;
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

	// Keys move the camera (D goes right, E goes up, W goes closer) while the
	// mouse grabs the world; the same split Google Earth uses. The turn and
	// the dolly are helpers because chase follow (j) shares them: it is the
	// object orbit with the direction owned by the target's motion instead
	// of the user.
	function orbitTurn(dt, keys, factor) {
		const turn = ORBIT_TURN_RATE * factor * dt;
		const yawStep = (keys.right ? turn : 0) - (keys.left ? turn : 0);
		if (yawStep !== 0) {
			rotateOrientation(upExact[0], upExact[1], upExact[2], yawStep);
			updateBasis();
		}
		const pitchStep = (keys.down ? turn : 0) - (keys.up ? turn : 0);
		if (pitchStep !== 0) {
			rotateOrientation(rightExact[0], rightExact[1], rightExact[2], pitchStep);
			updateBasis();
		}
	}

	function dollyOctaves(dt, keys, notches, factor) {
		let octaves = notches;
		if (keys.forward) octaves -= ORBIT_DOLLY_RATE * factor * dt;
		if (keys.back) octaves += ORBIT_DOLLY_RATE * factor * dt;
		return octaves;
	}

	function stepOrbit(dt, keys, notches) {
		const factor = keyFactor(keys, ORBIT_KEY_BOOST, 1 / ORBIT_KEY_BOOST);
		orbitTurn(dt, keys, factor);
		const octaves = dollyOctaves(dt, keys, notches, factor);
		if (octaves !== 0) orbitDistance = clamp(orbitDistance * Math.pow(2, octaves), ORBIT_DISTANCE_MIN, ORBIT_DISTANCE_MAX);
		placeOnOrbit();
	}

	// Consume the per-frame input deltas, integrate, and move. Mutates `input`
	// (deltas are consumed exactly once) but allocates nothing.
	function step(dt, input) {
		if (!(dt > 0)) return;
		const actions = input.actions;
		// Mode switches (orbitCentre/orbitObject/flyMode) are consumed by the
		// frame owner, not here: entering orbit on a selected object needs the
		// selection store's drawn position — the camera only learns the target
		// through setOrbitTarget/flyToStar afterwards.
		if (actions.home) { actions.home = 0; flightActive = false; goHome(); }
		if (actions.reset) { actions.reset = 0; flightActive = false; reset(); }

		const notches = takeWheelNotches(input);
		if (flightActive) {
			const keys = input.keys;
			const wantsControl = input.lookDx !== 0 || input.lookDy !== 0 || notches !== 0
				|| keys.forward || keys.back || keys.left || keys.right || keys.up || keys.down;
			if (wantsControl) {
				// Hand control over this frame: the input below applies to the
				// re-snapped orbit pose, not to the abandoned flight.
				cancelFlight();
			} else {
				stepFlight(dt);
				return;
			}
		}

		if (input.lookDx !== 0 || input.lookDy !== 0) {
			applyLook(input.lookDx, input.lookDy);
			input.lookDx = 0;
			input.lookDy = 0;
		}

		if (mode === MODE_FLY) stepFly(dt, input.keys, notches);
		else if (chaseOn && mode === MODE_ORBIT_OBJECT) stepChase(dt, input.keys, notches);
		else stepOrbit(dt, input.keys, notches);
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
		const sx = right[0], sy = right[1], sz = right[2];
		const ux = up[0], uy = up[1], uz = up[2];
		const fx = forward[0], fy = forward[1], fz = forward[2];

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
		const t = s.orbitTarget || (s.orbitTarget = [0, 0, 0]);
		const q = s.orientation || (s.orientation = [0, 0, 0, 1]);
		const target = orbitTarget();
		p[0] = position[0]; p[1] = position[1]; p[2] = position[2];
		v[0] = velocity[0]; v[1] = velocity[1]; v[2] = velocity[2];
		t[0] = target[0]; t[1] = target[1]; t[2] = target[2];
		q[0] = orientation[0]; q[1] = orientation[1]; q[2] = orientation[2]; q[3] = orientation[3];
		s.yaw = yaw;
		s.pitch = pitch;
		s.mode = mode;
		s.modeName = MODE_NAMES[mode];
		s.targetName = mode === MODE_ORBIT_GC ? GALACTIC_CENTRE_NAME : objectTargetName;
		s.chase = chaseOn;
		s.chaseSpeedLyPerSec = chaseSpeedKpcPerSec / LY_TO_KPC;
		s.flying = flightActive;
		s.flightProgress = flightActive ? clamp(flightElapsed / FLIGHT_DURATION_S, 0, 1) : 1;
		// Mid-flight the reported distance is the one being flown to, not the
		// stale sphere radius the pose has not reached yet.
		s.orbitDistance = flightActive ? flightDistance : orbitDistance;
		s.speedMult = speedMult;
		s.speedFactor = speedFactor;
		s.speedKpcPerSec = BASE_SPEED_KPC_S * speedMult * speedFactor;
		s.speedLyPerSec = s.speedKpcPerSec / LY_TO_KPC;
		return s;
	}

	function setState(state) {
		setPosition(state.position);
		flightActive = false;
		velocity[0] = state.velocity ? state.velocity[0] : 0;
		velocity[1] = state.velocity ? state.velocity[1] : 0;
		velocity[2] = state.velocity ? state.velocity[2] : 0;
		speedMult = state.speedMult || 1;
		mode = MODE_FLY;
		if (state.orientation) {
			orientation[0] = state.orientation[0];
			orientation[1] = state.orientation[1];
			orientation[2] = state.orientation[2];
			orientation[3] = state.orientation[3];
			updateBasis();
		} else {
			setOrientationFromYawPitch(
				Number.isFinite(state.yaw) ? state.yaw : 0,
				Number.isFinite(state.pitch) ? state.pitch : 0);
		}
		updateCameraPos();
		if (state.mode) setMode(state.mode);
	}

	return {
		step,
		reset,
		goHome,
		setFrame,
		setMode,
		setChase,
		setOrbitTarget,
		flyToStar,
		updateTarget,
		orbitStandOff,
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
	MODE_FLY, MODE_ORBIT_GC, MODE_ORBIT_OBJECT, MODE_NAMES,
	FOV_Y, NEAR_KPC, FAR_KPC, PITCH_LIMIT,
	LY_TO_KPC, BASE_SPEED_KPC_S, SPEED_MULT_MIN, SPEED_MULT_MAX,
	BOOST_FACTOR, SLOW_FACTOR, WHEEL_NOTCH_PX,
	VELOCITY_TAU, LOOK_SENSITIVITY,
	ORBIT_DISTANCE_MIN, ORBIT_DISTANCE_MAX, ORBIT_TURN_RATE, ORBIT_DOLLY_RATE,
	ORBIT_KEY_BOOST, HOME_ORBIT_DISTANCE, STAND_OFF_KPC_PER_SQRT_L, STAND_OFF_KPC_MAX,
	FLIGHT_DURATION_S, FLIGHT_UP_POLE_COS,
	CHASE_DIR_TAU, CHASE_MOVE_EPS_KPC,
	START_POSITION, SUN_POSITION, GALACTIC_CENTRE_TARGET,
};
if (typeof module !== 'undefined') module.exports = Camera;
if (typeof window !== 'undefined') window.Camera = Camera;
