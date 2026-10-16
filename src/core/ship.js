// src/core/ship.js
// Game mode's ship (game-mode-plan.md G1/G2): one record per session — class,
// physical velocity, Δv tank, life support, the stop command, the ship-time
// ladder (§4) and the §5 autopilot. CPU-only, `out`/in-place mutation, no
// per-frame allocations.
//
// Units. Position is kpc (the camera's own); velocity is kpc per *ship*-second
// — physical seconds, because §4's shared clock makes ship-seconds and
// star-seconds the same time. The class table (deltav.js) speaks SI: accel in
// m/s², Δv in m/s, cruise as a fraction of c. SHIP_ACCEL_WORLD is the one
// bridge (m/s² → kpc/s²); fuel is the accepted SI velocity-vector impulse,
// so `dvSpent == Σ|Δv_accepted|` even when a requested burn meets the cap.
//
// One integration serves every thrust source: advance() is the manual blend's,
// the all-stop's and the autopilot's, so the tank bound, the cruise cap and
// the ledgers cannot drift between them.
//
// The approach profile (§5) is not re-derived here: apProfile() is
// route.js's interstellarLeg (0.5.5) against the ship record, which carries
// the class's accel/vCruise at the top level for exactly that call.

(function () {
'use strict';

const dv = (typeof module !== 'undefined' && module.exports)
	? require('../math/deltav.js')
	: window.DeltaVLib;
const route = (typeof module !== 'undefined' && module.exports)
	? require('./route.js')
	: window.RouteLib;

const C = route.C;
const KPC_M = route.KPC_M;
const SECONDS_PER_YEAR = dv.SECONDS_PER_YEAR;

// The m/s² → kpc/s² bridge. One kpc is KPC_M metres, so one m/s² is
// 1/KPC_M kpc/s².
const SHIP_ACCEL_WORLD = 1 / KPC_M;

// In-system classes (vCruise: 0) cap at a generous escape-scale speed —
// their real ceiling is the tank — and cannot leave the local group.
const IN_SYSTEM_CRUISE_C = 0.005;

// --- Ship time (§4): a geometric y/s ladder, the system view's convention ---
// [−1] follow: R = SHIP_FOLLOW_GAIN · v/c (time scales with the ship's speed
//      and slows into a docking approach on its own).
// [0]  frozen: the shared clock pauses — ship and sky together.
// The 1-2-5 rungs span docking resolution (a chemical frame-tap lands in the
// tens of m/s at the bottom) to galaxy-crossing (the 100 kpc disc at 0.1 c in
// minutes at the top). A ship's useful rates span many decades; that is the
// lesson of the system clock's own ladder history.
const SHIP_TIME_LADDER = [-1, 0,
	1e-5, 2e-5, 5e-5, 1e-4, 2e-4, 5e-4, 1e-3, 2e-3, 5e-3,
	0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100,
	200, 500, 1e3, 2e3, 5e3, 1e4, 2e4, 5e4, 1e5, 2e5, 5e5, 1e6];
const SHIP_TIME_INDEX_MIN = 0;
const SHIP_TIME_INDEX_MAX = SHIP_TIME_LADDER.length - 1;
const SHIP_FOLLOW_GAIN = 20;      // y/s at c — the follow rung's gain

// The class's home rung: the ladder stop where a full-thrust frame-tap
// (60 fps) spends HOME_TAP_FRACTION of the tank, so every class flies at a
// resolution its throttle can speak in. Clamped to the manual-flight band —
// beyond +2 y/s taps are nobody's home; that is warp country, not the default.
const HOME_TAP_FRACTION = 0.01;
const HOME_FPS = 60;
const HOME_RATE_MIN = 1e-5;
const HOME_RATE_MAX = 2;

// --- Autopilot (§5) ---------------------------------------------------------
// Two commands, one law: build the desired velocity, then command the exact
// difference capped at the class accel. The approach's desired velocity comes
// from route.interstellarLeg's closed forms (the profile §5 pins); the
// follow's from the target's own drawn motion. The tank, the caps and the
// integration are advance()'s, exactly as for the manual law.
const AP_OFF = 0, AP_APPROACH = 1, AP_FOLLOW = 2, AP_TARGET = 3;
const AP_PHASE_IDLE = 0, AP_PHASE_BURN = 1, AP_PHASE_FLIP = 2, AP_PHASE_COAST = 3, AP_PHASE_BRAKE = 4;
const AP_PHASE_NAMES = ['idle', 'burn', 'flip', 'coast', 'brake'];
const AP_REASON_NONE = 0, AP_REASON_NO_TARGET = 1, AP_REASON_CLOSE = 2, AP_REASON_LOCAL = 3,
	AP_REASON_FUEL = 4, AP_REASON_HOT = 5, AP_REASON_ARRIVED = 6, AP_REASON_ABORTED = 7;
const AP_REASON_NAMES = ['', 'no target', 'already at the stand-off', 'ship is in-system only',
	'insufficient Δv', 'hot approach', 'arrived', 'autopilot off'];

// G3's destination-profile choices. They are numeric rather than UI strings so
// the hot controller copies just scalar limits from a precomputed plan.
const NAV_FASTEST = 0, NAV_THRUST_LIMIT = 1, NAV_SPEED_LIMIT = 2, NAV_TIME_LIMIT = 3;
const NAV_MODE_NAMES = ['fastest', 'thrust limit', 'speed limit', 'time limit'];
const NAV_REASON_NONE = 0, NAV_REASON_DISTANCE = 1, NAV_REASON_THRUST = 2,
	NAV_REASON_SPEED = 3, NAV_REASON_TIME = 4, NAV_REASON_LOCAL = 5;
const NAV_REASON_NAMES = ['', 'destination is already at the stand-off', 'set thrust above 0%',
	'set desired speed above 0%', 'time limit is shorter than the fastest legal flight',
	'ship is in-system only'];

// The arrival shell around the stand-off (1 AU) and the terminal rule: at most
// half the remaining distance per frame. The ship clock's dt is 1e5–1e6
// ship-seconds at cruise rungs, so a frame that ignored dt would step straight
// over the target; halving converges geometrically instead, and the shell is
// where that geometric tail is called arrival.
const AP_ARRIVE_M = 1.495978707e11;
const AP_TERMINAL_FRACTION = 0.5;
// The coast dead band: an error below this fraction of one frame's full-thrust
// impulse is not worth a burn — it is the resolution the clock can express.
const AP_ERR_FRACTION = 1e-6;
// The flip beat (wall seconds — at 0.5 y/s a "real" flip is over inside one
// frame, so the phase display is the wall clock's) and the two eases: the
// follow's alignment onto the movement vector, at camera.js's chase-follow
// constant, and the nose's, slower because a 180° reversal has to read.
const AP_FLIP_HOLD_S = 0.8;
const AP_ALIGN_TAU = 0.5;
const AP_AIM_TAU = 1.0;
// A target moving slower than this is not moving (0.1 m/s, far below any
// stellar drift and far above the f64 noise of a drawn position difference).
const AP_MOVE_EPS_MPS = 0.1;

const apProfileOut = {
	speed: 0, dv: 0, timeS: 0, distanceM: 0,
	accelLimit: 0, speedLimit: 0, peakSpeed: 0,
	fastestS: 0, burnS: 0, coastS: 0, timeLimitS: 0,
	feasible: false, reason: NAV_REASON_NONE,
};

function clamp(value, lo, hi) {
	return value < lo ? lo : (value > hi ? hi : value);
}

function classRow(classId) {
	return dv.shipById(classId);
}

function homeTimeIndex(cls) {
	const burnSeconds = cls.dvMax / cls.accel;
	const rate = burnSeconds * HOME_FPS * HOME_TAP_FRACTION / SECONDS_PER_YEAR;
	const wanted = clamp(rate, HOME_RATE_MIN, HOME_RATE_MAX);
	let best = 2;    // the first timed rung (index 0 = follow, 1 = frozen)
	let bestErr = Infinity;
	for (let i = 2; i <= SHIP_TIME_INDEX_MAX; i++) {
		const err = Math.abs(Math.log(SHIP_TIME_LADDER[i] / wanted));
		if (err < bestErr) { bestErr = err; best = i; }
	}
	return best;
}

// §5's autopilot state, one record per ship: the command (off / approach /
// follow), the phase it reports, the last refusal reason, the unit geometry and
// the bookkeeping the display reads. Allocated once, mutated in place.
function createAutopilot() {
	return {
		mode: AP_OFF,
		phase: AP_PHASE_IDLE,
		reason: AP_REASON_NONE,
		dir: new Float64Array(3),      // unit ship → target (re-read every step)
		aim: new Float64Array(3),      // unit commanded nose direction
		align: new Float64Array(3),    // eased movement direction (follow)
		hasAim: false,
		hasAlign: false,
		distanceM: 0,
		closingMs: 0,                  // + closing, − receding (m/s, target frame)
		relativeMs: 0,                 // |v_ship − v_target| (m/s)
		standOffM: 0,
		// A configured G3 plan copies these scalar limits on commit. The legacy
		// Shift+F approach uses the class limits, so its G2 behaviour stays exact.
		planMode: NAV_FASTEST,
		accelLimit: 0,
		speedLimit: 0,
		dvRequired: 0,                 // the armed flight's checkout number (m/s)
		reasonDv: 0,                   // the last refusal's number (m/s)
		dvBase: 0,                     // ship.dvSpent at the commit
		dvSpent: 0,                    // m/s burned since the commit
		etaS: 0,                       // ship seconds left, the closed form
		etaTotalS: 0,                  // the armed profile's total (the flown % denominator)
		flownS: 0,                     // ship seconds flown since the commit
		flipHoldS: 0,
	};
}

function createShip(classId) {
	const cls = classRow(classId);
	return {
		class: cls,
		// The class's own numbers at the top level: route.interstellarLeg's
		// leg math reads { accel, vCruise } and the ship record is that struct.
		accel: cls.accel,
		vCruise: cls.vCruise,
		dvMax: cls.dvMax,
		lifeYears: cls.lifeYears,
		pos: new Float64Array(3),      // kpc
		vel: new Float64Array(3),      // kpc per ship-second
		// The hull's own heading as the camera's unit quaternion
		// (local +X forward, -Y right, +Z up). A hull spawned at the
		// camera adopts the camera's heading; piloting another hull
		// re-poses the camera onto it, exactly like its position.
		heading: new Float64Array([0, 0, 0, 1]),
		dvSpent: 0,                    // m/s
		lifeSpent: 0,                  // ship-seconds
		stopping: false,               // Space all-stop in progress
		stopResidual: 0,               // kpc/ship-s left when a stop ran dry
		throttleFrac: 0,               // applied burn / current ceiling, for the bar
		accelNow: 0,                   // m/s² applied this step
		timeIndex: homeTimeIndex(cls),
		timeFrozen: false,
		ap: createAutopilot(),
	};
}

// The hangar swaps the ship under you: the tank re-arms to the new class and
// the velocity clamps to the new cruise cap; the pose continues. The class's
// accel is what the §5 controller spends its commands on, so the autopilot is
// a command of the old ship — it ends here.
function setClass(ship, classId) {
	const cls = classRow(classId);
	apEnd(ship, AP_REASON_ABORTED);
	ship.class = cls;
	ship.accel = cls.accel;
	ship.vCruise = cls.vCruise;
	ship.dvMax = cls.dvMax;
	ship.lifeYears = cls.lifeYears;
	ship.dvSpent = 0;
	ship.stopping = false;
	ship.stopResidual = 0;
	ship.timeIndex = homeTimeIndex(cls);
	const cap = cruiseCapKpcS(ship);
	const speed = Math.hypot(ship.vel[0], ship.vel[1], ship.vel[2]);
	if (speed > cap && speed > 0) {
		const k = cap / speed;
		ship.vel[0] *= k; ship.vel[1] *= k; ship.vel[2] *= k;
	}
}

// R's full reset (the observer's R already resets the camera).
function resetShip(ship) {
	apEnd(ship, AP_REASON_ABORTED);
	ship.vel[0] = 0; ship.vel[1] = 0; ship.vel[2] = 0;
	ship.dvSpent = 0;
	ship.lifeSpent = 0;
	ship.stopping = false;
	ship.stopResidual = 0;
	ship.throttleFrac = 0;
	ship.accelNow = 0;
}

function refuel(ship) {
	ship.dvSpent = 0;
	ship.stopResidual = 0;
}

// Space's commanded brake. It is a manual command like thrust, so it ends any
// autopilot: two laws writing the same velocity would fight.
function applyStop(ship) {
	apEnd(ship, AP_REASON_ABORTED);
	if (Math.hypot(ship.vel[0], ship.vel[1], ship.vel[2]) > 0) ship.stopping = true;
}

function dvRemaining(ship) {
	return Math.max(0, ship.dvMax - ship.dvSpent);
}

function cruiseCapKpcS(ship) {
	const cFrac = ship.vCruise > 0 ? ship.vCruise : IN_SYSTEM_CRUISE_C;
	return cFrac * C / KPC_M;
}

// |v| as a fraction of c — the HUD's speed and the follow rung's input.
function speedC(ship) {
	return Math.hypot(ship.vel[0], ship.vel[1], ship.vel[2]) * KPC_M / C;
}

// --- G3 destination profiles ------------------------------------------------
// A flight plan is a reusable output record. Its values are copied to the
// autopilot at engage time; moving a slider later cannot mutate a running burn.
function createFlightPlan() {
	return {
		mode: NAV_FASTEST,
		distanceM: 0,
		accelLimit: 0,
		speedLimit: 0,
		peakSpeed: 0,
		dv: 0,
		matchDv: 0,
		totalDv: 0,
		fuelMargin: 0,
		standOffM: 0,
		timeS: 0,
		fastestS: 0,
		burnS: 0,
		coastS: 0,
		timeLimitS: 0,
		feasible: false,
		reason: NAV_REASON_NONE,
	};
}

// The shared rest-to-rest triangular/trapezoidal profile. `out` owns no input
// state, so apStep can reuse its module scratch for ETA updates without an
// allocation. The speed limit is a physical m/s limit in the target frame.
function profileForLimits(distanceM, accel, speedLimit, out) {
	const d = Math.max(0, distanceM);
	out.distanceM = d;
	out.accelLimit = accel;
	out.speedLimit = speedLimit;
	out.peakSpeed = 0;
	out.dv = 0;
	out.timeS = 0;
	out.burnS = 0;
	out.coastS = 0;
	out.feasible = false;
	if (d === 0) return out;
	if (!(accel > 0) || !(speedLimit > 0) || !Number.isFinite(accel) || !Number.isFinite(speedLimit)) {
		out.timeS = Infinity;
		out.feasible = false;
		return out;
	}
	const peak = Math.min(speedLimit, Math.sqrt(accel * d));
	const burn = peak / accel;
	const coast = Math.max(0, d - peak * peak / accel) / peak;
	out.peakSpeed = peak;
	out.dv = 2 * peak;
	out.burnS = burn;
	out.coastS = coast;
	out.timeS = 2 * burn + coast;
	out.feasible = true;
	return out;
}

// Build the G3 forecast. The three fraction arguments are the Flight panel's
// controls: `thrustFraction` limits acceleration, `speedFraction` limits the
// class cap, and `timeLimitS` is ship time. `out.dv` is the rest-to-rest profile
// cost; the UI adds current target-frame relative velocity for its checkout.
function planJourney(distanceM, ship, mode, thrustFraction, speedFraction, timeLimitS, out) {
	const d = Math.max(0, distanceM);
	const classAccel = ship.accel;
	const classSpeed = cruiseCapKpcS(ship) * KPC_M;
	const thrust = clamp(thrustFraction, 0, 1);
	const speed = clamp(speedFraction, 0, 1);
	out.mode = mode | 0;
	out.distanceM = d;
	out.timeLimitS = timeLimitS;
	out.fastestS = 0;
	out.reason = NAV_REASON_NONE;
	out.feasible = false;
	if (d === 0) {
		profileForLimits(0, classAccel, classSpeed, out);
		out.reason = NAV_REASON_DISTANCE;
		return out;
	}
	if (!(classAccel > 0) || !(classSpeed > 0)) {
		out.timeS = Infinity;
		out.reason = NAV_REASON_THRUST;
		return out;
	}
	// The map/route workflow serves local classes. A destination-star profile
	// must retain G2's interstellar restriction rather than using the manual
	// fallback cap as a loophole around it.
	if (!(ship.vCruise > 0)) {
		out.timeS = Infinity;
		out.reason = NAV_REASON_LOCAL;
		return out;
	}
	// Always retain the hardware's fastest time: the deadline UI prints it on
	// a refusal, and the other modes use it as useful context in tests/UI.
	const fastestPeak = Math.min(classSpeed, Math.sqrt(classAccel * d));
	out.fastestS = d / fastestPeak + fastestPeak / classAccel;
	let accel = classAccel;
	let speedLimit = classSpeed;
	if (out.mode === NAV_THRUST_LIMIT) {
		if (!(thrust > 0)) {
			out.timeS = Infinity;
			out.reason = NAV_REASON_THRUST;
			return out;
		}
		accel = classAccel * thrust;
	} else if (out.mode === NAV_SPEED_LIMIT) {
		if (!(speed > 0)) {
			out.timeS = Infinity;
			out.reason = NAV_REASON_SPEED;
			return out;
		}
		speedLimit = classSpeed * speed;
	} else if (out.mode === NAV_TIME_LIMIT) {
		if (!(timeLimitS > 0) || !Number.isFinite(timeLimitS) || timeLimitS < out.fastestS) {
			out.timeS = Infinity;
			out.reason = NAV_REASON_TIME;
			return out;
		}
		// The lowest-Δv profile that meets a feasible deadline. If a triangle
		// would exceed the speed cap, keep the cap and lower acceleration enough
		// to fill the requested time with its coast plateau.
		const trianglePeak = 2 * d / timeLimitS;
		if (trianglePeak <= classSpeed) {
			speedLimit = trianglePeak;
			accel = 4 * d / (timeLimitS * timeLimitS);
		} else {
			speedLimit = classSpeed;
			const denominator = speedLimit * timeLimitS - d;
			if (!(denominator > 0)) {
				out.timeS = Infinity;
				out.reason = NAV_REASON_TIME;
				return out;
			}
			accel = speedLimit * speedLimit / denominator;
		}
		if (accel > classAccel * (1 + 1e-12)) {
			out.timeS = Infinity;
			out.reason = NAV_REASON_TIME;
			return out;
		}
	}
	profileForLimits(d, accel, speedLimit, out);
	out.mode = mode | 0;
	out.timeLimitS = timeLimitS;
	out.fastestS = out.fastestS || 0;
	out.reason = NAV_REASON_NONE;
	out.feasible = Number.isFinite(out.timeS);
	return out;
}

// The ship clock (§4): y/s of shared time at the current rung.
function timeRateYPerS(ship, speedCNow) {
	if (ship.timeFrozen) return 0;
	const rung = SHIP_TIME_LADDER[ship.timeIndex];
	if (rung < 0) return SHIP_FOLLOW_GAIN * (speedCNow || 0);
	return rung;
}

// One frame of a world-frame acceleration (axK..azK, kpc/s²) for dtShipS ship
// seconds. Fuel is the accepted velocity-vector impulse, not requested throttle:
// the candidate velocity is projected onto the cruise-speed ball and the tank
// pays |v_after − v_before|. Thus an outward burn already at cap is free, while
// a sideways burn at cap still pays its real turn. `limitS` is the all-stop's
// exact-to-rest cap; position/life support still advance over the full frame.
// An optional governor cap is a lower *non-braking* operational cap used only
// for a positive forward manual command; the class cap remains authoritative.
function projectedImpulseDv(vx, vy, vz, ix, iy, iz, cap) {
	let px = vx + ix, py = vy + iy, pz = vz + iz;
	const speed = Math.hypot(px, py, pz);
	if (speed > cap && speed > 0) {
		const k = cap / speed;
		px *= k; py *= k; pz *= k;
	}
	return Math.hypot(px - vx, py - vy, pz - vz) * KPC_M;
}

function advance(ship, dtShipS, axK, ayK, azK, accelMs2, limitS, governorCapKpcS) {
	if (!(dtShipS > 0)) return 0;
	const classCap = cruiseCapKpcS(ship);
	const cap = governorCapKpcS > 0 ? Math.min(classCap, governorCapKpcS) : classCap;
	// A class swap or velocity handover can seed an over-cap speed. Preserve the
	// existing free bleed for that state before measuring a commanded impulse.
	let vx = ship.vel[0], vy = ship.vel[1], vz = ship.vel[2];
	const startSpeed = Math.hypot(vx, vy, vz);
	if (startSpeed > cap && startSpeed > 0) {
		const k = cap / startSpeed;
		vx *= k; vy *= k; vz *= k;
		ship.vel[0] = vx; ship.vel[1] = vy; ship.vel[2] = vz;
	}
	let appliedDv = 0;
	let fuelLimited = false;
	let burnS = dtShipS;
	if (limitS < burnS) burnS = limitS;
	if (accelMs2 > 0 && burnS > 0 && dvRemaining(ship) > 0) {
		const ix = axK * burnS, iy = ayK * burnS, iz = azK * burnS;
		let scale = 1;
		let cost = projectedImpulseDv(vx, vy, vz, ix, iy, iz, cap);
		const remain = dvRemaining(ship);
		if (cost > remain) {
			fuelLimited = true;
			// Projection makes the accepted impulse nonlinear near the cap. The
			// affordable duration is nevertheless a bounded scalar interval; a
			// fixed bisection is deterministic, allocation-free and exact enough
			// that the tank never crosses its advertised limit.
			let lo = 0, hi = 1;
			for (let i = 0; i < 48; i++) {
				const mid = (lo + hi) * 0.5;
				if (projectedImpulseDv(vx, vy, vz, ix * mid, iy * mid, iz * mid, cap) <= remain) lo = mid;
				else hi = mid;
			}
			scale = lo;
			cost = projectedImpulseDv(vx, vy, vz, ix * scale, iy * scale, iz * scale, cap);
		}
		let px = vx + ix * scale, py = vy + iy * scale, pz = vz + iz * scale;
		const speed = Math.hypot(px, py, pz);
		if (speed > cap && speed > 0) {
			const k = cap / speed;
			px *= k; py *= k; pz *= k;
		}
		// Exact radial projection at cap can leave a sub-nanometre/s roundoff
		// residue. It is not a physical impulse and must not trickle fuel away.
		if (cost < 1e-6) {
			px = vx; py = vy; pz = vz;
			cost = 0;
		}
		ship.vel[0] = px; ship.vel[1] = py; ship.vel[2] = pz;
		appliedDv = cost;
		ship.dvSpent = fuelLimited ? ship.dvMax : Math.min(ship.dvMax, ship.dvSpent + cost);
	}
	ship.pos[0] += ship.vel[0] * dtShipS;
	ship.pos[1] += ship.vel[1] * dtShipS;
	ship.pos[2] += ship.vel[2] * dtShipS;
	ship.lifeSpent += dtShipS;
	return appliedDv;
}

// The manual frame step. dirX..dirZ is the unnormalized per-axis thrust blend
// in galaxy-frame world axes (main.js folds the camera's live basis and the key
// state into it); factor is the Shift ×4 / Ctrl ×¼ modifier. The magnitude cap
// is on the blend: full forward + full strafe commands √2 of the class accel
// and the clip brings it back to 1×. HUD throttle is set from the accepted
// impulse after `advance`, never from discarded cruise-clamp request.
function step(ship, dtShipS, dirX, dirY, dirZ, factor, governorCapKpcS) {
	const dirLen = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ);
	// Manual thrust always wins over an active stop command.
	if (dirLen > 1e-12) {
		ship.stopping = false;
		ship.stopResidual = 0;
	}
	const ceiling = ship.accel * (factor > 0 ? factor : 1);
	let requestedAccel = 0;
	let ax = 0, ay = 0, az = 0;    // kpc/s²
	let limitS = Infinity;
	const tank = dvRemaining(ship);
	if (ship.stopping && tank > 0) {
		const v = Math.hypot(ship.vel[0], ship.vel[1], ship.vel[2]);
		if (v > 0) {
			// The brake is its own ceiling: full class accel, no modifier. It
			// ends exactly at rest — without the clamp the last frame's burn
			// flips the velocity through zero and the stop never recognises it.
			requestedAccel = ship.accel;
			limitS = v * KPC_M / requestedAccel;
			const k = -requestedAccel * SHIP_ACCEL_WORLD / v;
			ax = ship.vel[0] * k; ay = ship.vel[1] * k; az = ship.vel[2] * k;
		}
	} else if (dirLen > 1e-12 && tank > 0) {
		let mag = dirLen * ceiling;
		if (mag > ceiling) mag = ceiling;
		requestedAccel = mag;
		const k = mag * SHIP_ACCEL_WORLD / dirLen;
		ax = dirX * k; ay = dirY * k; az = dirZ * k;
	}
	const appliedDv = advance(ship, dtShipS, ax, ay, az, requestedAccel, limitS, governorCapKpcS);
	let acceptedAccel = dtShipS > 0 ? appliedDv / dtShipS : 0;
	if (Math.abs(acceptedAccel - requestedAccel) <= 1e-12 * Math.max(1, requestedAccel)) acceptedAccel = requestedAccel;
	ship.accelNow = acceptedAccel;
	ship.throttleFrac = ceiling > 0 ? acceptedAccel / ceiling : 0;
	if (requestedAccel > 0 && ship.stopping) {
		const speed = Math.hypot(ship.vel[0], ship.vel[1], ship.vel[2]);
		if (dvRemaining(ship) <= 1e-6 || speed <= 0) {
			// The stop ends at rest, or dry with the residual it could not kill.
			ship.stopping = false;
			if (dvRemaining(ship) <= 1e-6 && speed > 0) ship.stopResidual = speed;
		}
	}
}

// --- Autopilot (§5) ---------------------------------------------------------

// End the autopilot, keeping the velocity (aborting is returning to manual, not
// stopping) and recording why, so the HUD can say it for a few ticks.
function apEnd(ship, reason) {
	const ap = ship.ap;
	ap.mode = AP_OFF;
	ap.phase = AP_PHASE_IDLE;
	ap.hasAim = false;
	ap.hasAlign = false;
	ap.flipHoldS = 0;
	ap.etaS = 0;
	ap.etaTotalS = 0;
	ap.planMode = NAV_FASTEST;
	ap.accelLimit = 0;
	ap.speedLimit = 0;
	ap.dvRequired = 0;
	ap.dvSpent = 0;
	ap.reason = reason === undefined ? AP_REASON_ABORTED : reason;
	return ap.reason;
}

function apAbort(ship) {
	return apEnd(ship, AP_REASON_ABORTED);
}

// The largest speed an error of `errorM` may be closed at this frame: the
// braking profile, discretely. Continuous it is √(2·a·e); written as the speed
// from which a frame's burn at `a` and then the same envelope come to rest
// inside `e`, `√((a·dt)² + 2·a·e) − a·dt`, it also holds against the ship
// clock's huge dt — a frame of the profile is one frame, and a profile that
// ignored that would step over the target. Both laws below are this one
// function: the approach's error is the distance to the stand-off shell, the
// follow's is the offset from the chased point.
function closeSpeedM(errorM, accel, capMs, dtShipS) {
	const e = errorM > 0 ? errorM : 0;
	const stepAccel = accel * (dtShipS > 0 ? dtShipS : 0);
	let v = Math.sqrt(stepAccel * stepAccel + 2 * accel * e) - stepAccel;
	if (v < 0) v = 0;
	if (v > capMs) v = capMs;
	return v;
}

// The chase follow's alignment law (camera.js's easeChaseDirection): an
// exponential ease of the remaining angle, exact over equal elapsed time
// because the per-frame factor is exp(−dt/τ) and the interpolation is
// spherical. `out` is the eased unit direction, mutated in place.
function easeDirection(out, tx, ty, tz, dtWallS) {
	const len = Math.sqrt(tx * tx + ty * ty + tz * tz);
	if (len <= 0) return;
	const inv = 1 / len;
	tx *= inv; ty *= inv; tz *= inv;
	let dot = out[0] * tx + out[1] * ty + out[2] * tz;
	dot = clamp(dot, -1, 1);
	const k = 1 - Math.exp(-dtWallS / AP_ALIGN_TAU);
	if (dot > 1 - 1e-9 || dot < -1 + 1e-6) {
		// Nearly aligned (below any measurable misalignment) takes it; a full
		// reversal has no unique short way round, so the movement vector wins.
		out[0] = tx; out[1] = ty; out[2] = tz;
		return;
	}
	const theta = Math.acos(dot);
	const invSin = 1 / Math.sin(theta);
	const w0 = Math.sin((1 - k) * theta) * invSin;
	const w1 = Math.sin(k * theta) * invSin;
	out[0] = out[0] * w0 + tx * w1;
	out[1] = out[1] * w0 + ty * w1;
	out[2] = out[2] * w0 + tz * w1;
	const n = Math.sqrt(out[0] * out[0] + out[1] * out[1] + out[2] * out[2]);
	if (n > 0) {
		const s = 1 / n;
		out[0] *= s; out[1] *= s; out[2] *= s;
	}
}

function apMeasure(ship, dx, dy, dz, tvx, tvy, tvz) {
	const ap = ship.ap;
	const distKpc = Math.sqrt(dx * dx + dy * dy + dz * dz);
	if (distKpc > 0) {
		const inv = 1 / distKpc;
		ap.dir[0] = dx * inv; ap.dir[1] = dy * inv; ap.dir[2] = dz * inv;
	}
	ap.distanceM = distKpc * KPC_M;
	// The relative velocity in the target's rest frame: §5 flies against this,
	// never against the ship's galactic-frame speed.
	const wx = ship.vel[0] - tvx, wy = ship.vel[1] - tvy, wz = ship.vel[2] - tvz;
	ap.relativeMs = Math.sqrt(wx * wx + wy * wy + wz * wz) * KPC_M;
	// Closing is −d(dist)/dt: the relative velocity along the line of sight,
	// positive while the target is being caught (the HUD's convention too).
	ap.closingMs = (wx * ap.dir[0] + wy * ap.dir[1] + wz * ap.dir[2]) * KPC_M;
	ap.dvSpent = ship.dvSpent - ap.dvBase;
	return ap;
}

// §5's commit: a burn/flip approach to a drawn target `dx,dy,dz` kpc away (the
// ui.2 drawn offset) moving at (tvx,tvy,tvz) kpc per ship-second, arriving on
// the stand-off shell `standOffM`. Returns the reason code; AP_REASON_NONE
// means the flight is armed. A refusal never touches a running flight's mode —
// it only reports through reason/numbers, which the HUD prints for a few ticks.
function settleAtTarget(ship, tx, ty, tz, tvx, tvy, tvz) {
	const dvx = tvx - ship.vel[0], dvy = tvy - ship.vel[1], dvz = tvz - ship.vel[2];
	const cost = Math.hypot(dvx, dvy, dvz) * KPC_M;
	if (cost > dvRemaining(ship) + 1e-6) return false;
	ship.pos[0] = tx; ship.pos[1] = ty; ship.pos[2] = tz;
	ship.vel[0] = tvx; ship.vel[1] = tvy; ship.vel[2] = tvz;
	ship.dvSpent = Math.min(ship.dvMax, ship.dvSpent + cost);
	ship.stopping = false;
	ship.stopResidual = 0;
	ship.accelNow = 0;
	ship.throttleFrac = 0;
	return true;
}

function commitApproach(ship, dx, dy, dz, tvx, tvy, tvz, standOffM, plan, stopAtTarget) {
	const ap = apMeasure(ship, dx, dy, dz, tvx, tvy, tvz);
	const remM = ap.distanceM - standOffM;
	let accel = ship.accel;
	let speedLimit = cruiseCapKpcS(ship) * KPC_M;
	let profileDv = 0;
	let profileTime = Infinity;
	let planMode = NAV_FASTEST;
	if (plan && plan.feasible) {
		// The Flight panel calculated this exact profile against this target
		// before enqueueing the command. Copy scalar limits into `ap`; a later
		// UI edit cannot change an already engaged flight.
		accel = plan.accelLimit;
		speedLimit = plan.speedLimit;
		profileDv = plan.dv;
		profileTime = plan.timeS;
		planMode = plan.mode;
	} else {
		route.interstellarLeg(Math.max(0, remM), ship, apProfileOut);
		profileDv = apProfileOut.dv;
		profileTime = apProfileOut.timeS;
	}
	// The checkout: the profile's 2·v_peak plus the relative speed the ship is
	// carrying (zero for the cold approach §5 assumes, so this is the plan's
	// Δv_req in the case the formula is written for).
	const needMs = profileDv + ap.relativeMs;
	ap.reasonDv = needMs;
	if (remM <= AP_ARRIVE_M && !stopAtTarget) return (ap.reason = AP_REASON_CLOSE);
	if (!Number.isFinite(profileTime) || !(accel > 0) || !(speedLimit > 0)) return (ap.reason = AP_REASON_LOCAL);
	if (needMs > dvRemaining(ship)) return (ap.reason = AP_REASON_FUEL);
	if (stopAtTarget && remM <= AP_ARRIVE_M) {
		if (!settleAtTarget(ship, ship.pos[0] + dx, ship.pos[1] + dy, ship.pos[2] + dz, tvx, tvy, tvz)) {
			return (ap.reason = AP_REASON_FUEL);
		}
		apEnd(ship, AP_REASON_ARRIVED);
		return AP_REASON_ARRIVED;
	}
	// A hot approach cannot stop in time at the configured acceleration; a
	// thrust-limited plan must honestly refuse sooner than the full engine.
	if (remM > AP_ARRIVE_M && ap.closingMs > 0 && ap.closingMs * ap.closingMs > 2 * accel * remM) {
		return (ap.reason = AP_REASON_HOT);
	}
	ap.mode = stopAtTarget ? AP_TARGET : AP_APPROACH;
	ap.phase = AP_PHASE_BURN;
	ap.reason = AP_REASON_NONE;
	ap.standOffM = standOffM;
	ap.planMode = planMode;
	ap.accelLimit = accel;
	ap.speedLimit = speedLimit;
	ap.dvRequired = needMs;
	ap.etaS = profileTime;
	ap.etaTotalS = profileTime;
	ap.hasAlign = false;
	ap.dvBase = ship.dvSpent;
	ap.dvSpent = 0;
	ap.flownS = 0;
	ap.flipHoldS = 0;
	ap.aim[0] = ap.dir[0]; ap.aim[1] = ap.dir[1]; ap.aim[2] = ap.dir[2];
	ap.hasAim = true;
	return AP_REASON_NONE;
}

function apCommitApproach(ship, dx, dy, dz, tvx, tvy, tvz, standOffM, plan) {
	return commitApproach(ship, dx, dy, dz, tvx, tvy, tvz, standOffM, plan, false);
}

function apCommitTarget(ship, dx, dy, dz, tvx, tvy, tvz) {
	return commitApproach(ship, dx, dy, dz, tvx, tvy, tvz, 0, null, true);
}

// §5's follow: null the relative velocity against the target and trail it at
// the stand-off. The eased alignment starts on the current line of sight, so
// the first frames hold the distance and the swing onto the target's own
// movement direction is the ease's — exactly the chase follow's start.
function apCommitFollow(ship, dx, dy, dz, tvx, tvy, tvz, standOffM) {
	const ap = apMeasure(ship, dx, dy, dz, tvx, tvy, tvz);
	ap.standOffM = standOffM;
	ap.mode = AP_FOLLOW;
	ap.phase = AP_PHASE_COAST;
	ap.reason = AP_REASON_NONE;
	ap.planMode = NAV_FASTEST;
	ap.accelLimit = ship.accel;
	ap.speedLimit = cruiseCapKpcS(ship) * KPC_M;
	ap.dvRequired = 0;
	ap.etaS = 0;
	ap.dvBase = ship.dvSpent;
	ap.dvSpent = 0;
	ap.flownS = 0;
	ap.flipHoldS = 0;
	ap.align[0] = ap.dir[0]; ap.align[1] = ap.dir[1]; ap.align[2] = ap.dir[2];
	ap.hasAlign = true;
	ap.aim[0] = ap.dir[0]; ap.aim[1] = ap.dir[1]; ap.aim[2] = ap.dir[2];
	ap.hasAim = true;
	return AP_REASON_NONE;
}

// The autopilot's frame step: one law for both commands. Build the desired
// velocity, command the exact difference capped at the class accel (saturate →
// the profile's burn, the dead band → its coast), report the phase, aim the
// nose and integrate through advance() with the tank and the caps everyone
// else pays. Returns the applied acceleration in m/s².
function apStep(ship, dtShipS, dtWallS, tx, ty, tz, tvx, tvy, tvz) {
	const ap = ship.ap;
	if (ap.mode === AP_OFF) {
		ap.phase = AP_PHASE_IDLE;
		return 0;
	}
	apMeasure(ship, tx - ship.pos[0], ty - ship.pos[1], tz - ship.pos[2], tvx, tvy, tvz);
	const dirX = ap.dir[0], dirY = ap.dir[1], dirZ = ap.dir[2];
	const accel = ap.accelLimit > 0 ? ap.accelLimit : ship.accel;
	const capMs = ap.speedLimit > 0 ? ap.speedLimit : cruiseCapKpcS(ship) * KPC_M;
	const remM = ap.distanceM - ap.standOffM;
	let vdx = 0, vdy = 0, vdz = 0;
	if (ap.mode === AP_APPROACH || ap.mode === AP_TARGET) {
		if (remM <= AP_ARRIVE_M) {
			if (ap.mode === AP_TARGET
				&& !settleAtTarget(ship, tx, ty, tz, tvx, tvy, tvz)) {
				apEnd(ship, AP_REASON_FUEL);
				return 0;
			}
			apEnd(ship, AP_REASON_ARRIVED);
			return 0;
		}
		// The ETA counts down against the limits copied at commit, whether
		// this is the legacy fastest approach or a G3 configured plan.
		profileForLimits(Math.max(0, remM), accel, capMs, apProfileOut);
		ap.etaS = apProfileOut.timeS;
		// Close on the shell at the braking profile's speed (never past the
		// terminal rule), which is the profile's own burn–coast–brake.
		// Terminal rule (§5): at most half the remaining distance per frame,
		// so a huge dtShipS (1e5–1e6 ship-seconds at cruise rungs) cannot step
		// over the target and cause a camera glitch.
		let vCloseM = closeSpeedM(remM, accel, capMs, dtShipS);
		if (dtShipS > 0) {
			const terminalM = AP_TERMINAL_FRACTION * remM / dtShipS;
			if (vCloseM > terminalM) vCloseM = terminalM;
		}
		const vClose = vCloseM / KPC_M;
		vdx = tvx + vClose * dirX;
		vdy = tvy + vClose * dirY;
		vdz = tvz + vClose * dirZ;
	} else {
		// Follow: match the target's own motion and take out the offset from the
		// chased point — the stand-off, behind the target along the eased
		// movement direction. Only the correction costs fuel.
		const tvLen = Math.sqrt(tvx * tvx + tvy * tvy + tvz * tvz) * KPC_M;
		if (tvLen > AP_MOVE_EPS_MPS) easeDirection(ap.align, tvx, tvy, tvz, dtWallS);
		const standKpc = ap.standOffM / KPC_M;
		const ex = tx - ap.align[0] * standKpc - ship.pos[0];
		const ey = ty - ap.align[1] * standKpc - ship.pos[1];
		const ez = tz - ap.align[2] * standKpc - ship.pos[2];
		const errKpc = Math.sqrt(ex * ex + ey * ey + ez * ez);
		let corrM = closeSpeedM(errKpc * KPC_M, accel, capMs, dtShipS);
		if (dtShipS > 0) {
			const terminalM = AP_TERMINAL_FRACTION * errKpc * KPC_M / dtShipS;
			if (corrM > terminalM) corrM = terminalM;
		}
		const corr = corrM / KPC_M;
		const scale = errKpc > 0 ? corr / errKpc : 0;
		vdx = tvx + ex * scale;
		vdy = tvy + ey * scale;
		vdz = tvz + ez * scale;
	}
	// The desired velocity is a galactic-frame velocity, so it holds the chosen
	// speed limit too: target drift plus closing speed can exceed it. `advance`
	// charges only the projected, accepted impulse if a class-cap projection still
	// trims a command at the outer boundary.
	const vdMag = Math.sqrt(vdx * vdx + vdy * vdy + vdz * vdz);
	const capKpcS = capMs / KPC_M;
	if (vdMag > capKpcS && vdMag > 0) {
		const k = capKpcS / vdMag;
		vdx *= k; vdy *= k; vdz *= k;
	}
	// The command: the exact velocity difference, saturating at the class accel
	// and falling into the coast dead band. The dead band is on velocity error,
	// not on acceleration, so a huge dtShipS (1e5–1e6 ship-seconds) cannot turn a
	// large velocity error into a coast because errLen/dt is tiny — the old
	// check `mag > 1e-6*cap` made the autopilot never thrust at high time rates,
	// which is the “not properly work between stars” bug.
	const ex = vdx - ship.vel[0], ey = vdy - ship.vel[1], ez = vdz - ship.vel[2];
	const errLen = Math.sqrt(ex * ex + ey * ey + ez * ez);
	const capKpcS2 = accel * SHIP_ACCEL_WORLD;
	let axK = 0, ayK = 0, azK = 0, accelMs2 = 0;
	if (dtShipS > 0 && errLen > AP_ERR_FRACTION * capKpcS) {
		let mag = errLen / dtShipS;
		if (mag > capKpcS2) mag = capKpcS2;
		const scale = mag / errLen;
		axK = ex * scale; ayK = ey * scale; azK = ez * scale;
		accelMs2 = mag * KPC_M;
	}
	// The phase is the command's sign along the line of sight, with a beat of
	// `flip` where it reverses (the attitude the compressed clock cannot show).
	let phase = accelMs2 <= 0 ? AP_PHASE_COAST
		: (axK * dirX + ayK * dirY + azK * dirZ) >= 0 ? AP_PHASE_BURN : AP_PHASE_BRAKE;
	if (phase === AP_PHASE_BURN) ap.flipHoldS = 0;
	// The nose reverses into retrograde from a burn or a coast alike (a coast keeps
	// it on the target), so any entry into brake is the flip.
	else if (phase === AP_PHASE_BRAKE && ap.phase !== AP_PHASE_BRAKE) ap.flipHoldS = AP_FLIP_HOLD_S;
	if (ap.flipHoldS > 0) {
		ap.flipHoldS -= dtWallS;
		phase = AP_PHASE_FLIP;
	}
	ap.phase = phase;
	const appliedDv = advance(ship, dtShipS, axK, ayK, azK, accelMs2, Infinity);
	let acceptedAccel = dtShipS > 0 ? appliedDv / dtShipS : 0;
	if (Math.abs(acceptedAccel - accelMs2) <= 1e-12 * Math.max(1, accelMs2)) acceptedAccel = accelMs2;
	ship.accelNow = acceptedAccel;
	ship.throttleFrac = accel > 0 ? acceptedAccel / accel : 0;
	if (acceptedAccel <= 0) ap.phase = AP_PHASE_COAST;
	ap.flownS += dtShipS > 0 ? dtShipS : 0;
	// The nose follows accepted, not merely requested, burn. A projected-away
	// cap command (or a frozen frame) is visually a coast as well as a zero-fuel
	// / zero-throttle HUD frame.
	if (acceptedAccel > 0) {
		const inv = 1 / Math.sqrt(axK * axK + ayK * ayK + azK * azK);
		ap.aim[0] = axK * inv; ap.aim[1] = ayK * inv; ap.aim[2] = azK * inv;
	} else if (ap.mode === AP_APPROACH || ap.mode === AP_TARGET) {
		ap.aim[0] = dirX; ap.aim[1] = dirY; ap.aim[2] = dirZ;
	} else {
		ap.aim[0] = ap.align[0]; ap.aim[1] = ap.align[1]; ap.aim[2] = ap.align[2];
	}
	ap.hasAim = true;
	return acceptedAccel;
}

// Seconds of full-thrust burn left in the tank at the current throttle
// (full class accel when idle) — the HUD's burn reserve, in ship time.
function burnReserveSeconds(ship) {
	const rate = ship.accelNow > 0 ? ship.accelNow : ship.accel;
	return rate > 0 ? dvRemaining(ship) / rate : Infinity;
}

// §5's approach profile: route.js's leg law against the ship record.
// out receives { speed, dv, timeS, distanceM }; timeS is Infinity when the
// class cannot cruise there at all (vCruise: 0, interstellar distance).
function apProfile(distanceM, ship, out) {
	return route.interstellarLeg(distanceM, ship, out);
}

// --- Display (§6) -----------------------------------------------------------

function trim3(value) {
	return String(Number(value.toPrecision(3)));
}

// km/s under 0.01c, then fractions of c (the HUD's speed law).
function formatSpeed(ship) {
	const c = speedC(ship);
	if (c < 0.01) return dv.formatKms(c * C) + ' km/s';
	return trim3(c) + 'c';
}

// The same law for rates that are not the ship's own speed (closing rates).
function formatSpeedC(c) {
	const a = Math.abs(c);
	if (a < 0.01) return dv.formatKms(a * C) + ' km/s';
	return trim3(a) + 'c';
}

function velocityComponents(ship, forward, right, up, targetVelocity, out) {
	const vx = ship.vel[0] - (targetVelocity ? targetVelocity[0] : 0);
	const vy = ship.vel[1] - (targetVelocity ? targetVelocity[1] : 0);
	const vz = ship.vel[2] - (targetVelocity ? targetVelocity[2] : 0);
	out[0] = vx * forward[0] + vy * forward[1] + vz * forward[2];
	out[1] = vx * right[0] + vy * right[1] + vz * right[2];
	out[2] = vx * up[0] + vy * up[1] + vz * up[2];
	return out;
}

function formatAxisSpeed(kpcS) {
	const c = kpcS * KPC_M / C;
	const sign = c < 0 ? '−' : '+';
	const magnitude = Math.abs(c);
	if (magnitude < 0.01) return sign + dv.formatKms(magnitude * C) + ' km/s';
	return sign + trim3(magnitude) + 'c';
}

function timeRateCapYPerS(shipSeconds, minimumWallSeconds) {
	if (!(shipSeconds > 0) || !Number.isFinite(shipSeconds)) return Infinity;
	const wallSeconds = minimumWallSeconds > 0 ? minimumWallSeconds : 1;
	return shipSeconds / (wallSeconds * SECONDS_PER_YEAR);
}

// m/s with separators below 10⁶, km/s above (the HUD's fuel law).
function formatDv(mps) {
	if (mps >= 1e6) return dv.formatKms(mps) + ' km/s';
	return Math.round(mps).toLocaleString('en-US') + ' m/s';
}

function formatClock(ship, speedCNow) {
	if (ship.timeFrozen) return 'frozen';
	const rung = SHIP_TIME_LADDER[ship.timeIndex];
	if (rung < 0) return 'follow ×' + SHIP_FOLLOW_GAIN;
	return '+' + trim3(rung) + ' y/s';
}

const Ship = {
	C, KPC_M, SECONDS_PER_YEAR,
	SHIP_ACCEL_WORLD, IN_SYSTEM_CRUISE_C,
	SHIP_TIME_LADDER, SHIP_TIME_INDEX_MIN, SHIP_TIME_INDEX_MAX, SHIP_FOLLOW_GAIN,
	HOME_TAP_FRACTION, HOME_FPS, HOME_RATE_MIN, HOME_RATE_MAX,
	AP_OFF, AP_APPROACH, AP_FOLLOW, AP_TARGET,
	AP_PHASE_IDLE, AP_PHASE_BURN, AP_PHASE_FLIP, AP_PHASE_COAST, AP_PHASE_BRAKE, AP_PHASE_NAMES,
	AP_REASON_NONE, AP_REASON_NO_TARGET, AP_REASON_CLOSE, AP_REASON_LOCAL,
	AP_REASON_FUEL, AP_REASON_HOT, AP_REASON_ARRIVED, AP_REASON_ABORTED, AP_REASON_NAMES,
	AP_ARRIVE_M, AP_TERMINAL_FRACTION, AP_ERR_FRACTION, AP_FLIP_HOLD_S,
	AP_ALIGN_TAU, AP_AIM_TAU, AP_MOVE_EPS_MPS,
	NAV_FASTEST, NAV_THRUST_LIMIT, NAV_SPEED_LIMIT, NAV_TIME_LIMIT, NAV_MODE_NAMES,
	NAV_REASON_NONE, NAV_REASON_DISTANCE, NAV_REASON_THRUST, NAV_REASON_SPEED, NAV_REASON_TIME, NAV_REASON_LOCAL, NAV_REASON_NAMES,
	createShip, setClass, resetShip, refuel, applyStop, step, advance,
	homeTimeIndex, dvRemaining, cruiseCapKpcS, speedC, timeRateYPerS,
	createFlightPlan, profileForLimits, planJourney, projectedImpulseDv,
	burnReserveSeconds, apProfile,
	apEnd, apAbort, apCommitApproach, apCommitTarget, apCommitFollow, apStep, closeSpeedM, easeDirection,
	velocityComponents, formatAxisSpeed, timeRateCapYPerS,
	formatSpeed, formatSpeedC, formatDv, formatClock,
};
if (typeof module !== 'undefined') module.exports = Ship;
if (typeof window !== 'undefined') window.Ship = Ship;
})();
