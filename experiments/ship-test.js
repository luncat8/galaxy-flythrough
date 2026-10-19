// experiments/ship-test.js
// Validates the game-mode ship (game-mode-plan.md G1, G2): the burn/tank integral,
// the accel cap at blend angles, the cruise cap, the Space all-stop (including
// the dry-tank residual), the §5 approach profile against route.js's leg law,
// the §4 ship-time ladder (home rungs, follow, frozen), the toggle's pose
// write-through and velocity handover, life-support accrual, and zero
// per-frame allocations (the camera-test buffer-stability pin's discipline).
//
// Output: experiments/logs/ship.json

'use strict';

const fs = require('fs');
const path = require('path');
const logFile = require('./log-file.js');
const shipModule = require('../src/core/ship.js');
const cameraModule = require('../src/core/camera.js');
const routeModule = require('../src/core/route.js');
const dvModule = require('../src/math/deltav.js');
const cameraModuleG2 = cameraModule;

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
	return !!pass;
}

function close(a, b, rel) {
	const tol = rel !== undefined ? rel : 1e-9;
	const scale = Math.max(1e-30, Math.abs(a), Math.abs(b));
	return Math.abs(a - b) <= tol * scale;
}

const SEC_YEAR = dvModule.SECONDS_PER_YEAR;

// --- 1. The burn/tank invariant: dvSpent == ∫|a|dt -------------------------
{
	const ship = shipModule.createShip('stardrive');
	const dt = 1 / 60;
	// Ten taps at the home clock: inside the tank and under the cruise cap, so
	// every spent metre-per-second shows up as velocity.
	const frames = 10;
	const dtShip = shipModule.timeRateYPerS(ship, 0) * SEC_YEAR * dt;
	for (let i = 0; i < frames; i++) shipModule.step(ship, dtShip, 1, 0, 0, 1);
	const T = frames * dtShip;
	check('dvSpent equals |a|·t exactly for constant thrust',
		close(ship.dvSpent, ship.accel * T, 1e-12), { dvSpent: ship.dvSpent, expected: ship.accel * T });
	check('velocity gain equals the paid Δv (m/s ↔ kpc/ship-s bridge)',
		close(ship.vel[0] * shipModule.KPC_M, ship.dvSpent, 1e-12),
		{ velSI: ship.vel[0] * shipModule.KPC_M, dvSpent: ship.dvSpent });
	check('life support accrues on ship time',
		close(ship.lifeSpent, T, 1e-12), { lifeSpent: ship.lifeSpent, T });

	// Mixed factors: the integral is the sum of the applied magnitudes.
	const s2 = shipModule.createShip('stardrive');
	const dt1 = 1000, dt2 = 500;
	shipModule.step(s2, dt1, 1, 0, 0, 1);
	shipModule.step(s2, dt2, 1, 0, 0, 4);
	check('dvSpent tracks the applied factor (×4 reserve burns ×4 the Δv)',
		close(s2.dvSpent, s2.accel * dt1 + 4 * s2.accel * dt2, 1e-12), s2.dvSpent);

	// A frame that would spend past empty spends only what is left.
	const s3 = shipModule.createShip('chemical');
	s3.dvSpent = s3.dvMax - 100;         // 100 m/s left
	shipModule.step(s3, 1e6, 1, 0, 0, 1); // a frame far longer than the tank can pay
	check('the tank bounds the burn: dvSpent never exceeds dvMax',
		s3.dvSpent === s3.dvMax && shipModule.dvRemaining(s3) === 0, s3.dvSpent);
}

// --- 2. The accel cap at blend angles --------------------------------------
{
	const ship = shipModule.createShip('stardrive');
	shipModule.step(ship, 10, 1, 0, 0, 1);
	check('single axis burns at the class accel, bar 100%',
		ship.accelNow === ship.accel && ship.throttleFrac === 1, { accelNow: ship.accelNow });

	shipModule.step(ship, 10, 1, 1, 0, 1);
	check('forward + strafe blends to √2 and the cap clips it back to 1×',
		ship.accelNow === ship.accel && ship.throttleFrac === 1, { accelNow: ship.accelNow });

	shipModule.step(ship, 10, 0.5, 0, 0, 1);
	check('a partial blend burns proportionally (the bar reads the blend)',
		close(ship.accelNow, 0.5 * ship.accel, 1e-12) && close(ship.throttleFrac, 0.5, 1e-12),
		{ accelNow: ship.accelNow, frac: ship.throttleFrac });

	shipModule.step(ship, 10, 1, 0, 0, 4);
	check('Shift reserve: the ceiling scales ×4 and the bar is still 100%',
		ship.accelNow === 4 * ship.accel && ship.throttleFrac === 1, ship.accelNow);

	shipModule.step(ship, 10, 1, 1, 0, 4);
	check('Shift reserve blends too: √2·4 clipped to 4×',
		ship.accelNow === 4 * ship.accel, ship.accelNow);

	shipModule.step(ship, 10, 1, 0, 0, 0.25);
	check('Ctrl finesse: the ceiling scales ×¼',
		close(ship.accelNow, 0.25 * ship.accel, 1e-12), ship.accelNow);
}

// --- 3. The cruise cap ------------------------------------------------------
{
	const ship = shipModule.createShip('stardrive');
	const dtShip = 1e5;
	for (let i = 0; i < 2000; i++) shipModule.step(ship, dtShip, 1, 0, 0, 1);
	const cap = shipModule.cruiseCapKpcS(ship);
	const speed = Math.hypot(ship.vel[0], ship.vel[1], ship.vel[2]);
	check('interstellar class clamps at vCruise·c',
		close(speed, cap, 1e-12) && close(cap, 0.1 * shipModule.C / shipModule.KPC_M, 1e-12),
		{ speed, cap, c: shipModule.speedC(ship) });

	const local = shipModule.createShip('chemical');
	local.vel[0] = shipModule.cruiseCapKpcS(local) * 1.5;  // seeded over cap (the tank can't reach it)
	shipModule.step(local, 1e5, 0, 0, 0, 1);               // coasting frames clamp
	const localCap = shipModule.cruiseCapKpcS(local);
	const localSpeed = Math.hypot(local.vel[0], local.vel[1], local.vel[2]);
	check('in-system class caps at the escape-scale constant',
		close(localSpeed, localCap, 1e-12)
		&& close(localCap, shipModule.IN_SYSTEM_CRUISE_C * shipModule.C / shipModule.KPC_M, 1e-12),
		{ localSpeed, localCap });
}

// --- 4. Space all-stop, including the dry-tank residual --------------------
{
	const ship = shipModule.createShip('stardrive');
	const v0 = 0.8e-12;                  // kpc/ship-s, under the cruise cap
	ship.vel[0] = v0; ship.vel[1] = 0; ship.vel[2] = 0;
	shipModule.applyStop(ship);
	check('applyStop arms the commanded brake', ship.stopping === true);
	for (let i = 0; i < 1000 && ship.stopping; i++) shipModule.step(ship, 1e5, 0, 0, 0, 1);
	check('the stop burns counter-vector to rest and spends exactly the velocity killed',
		ship.stopping === false && Math.hypot(ship.vel[0], ship.vel[1], ship.vel[2]) === 0
		&& close(ship.dvSpent, v0 * shipModule.KPC_M, 1e-9),
		{ dvSpent: ship.dvSpent, expected: v0 * shipModule.KPC_M });

	// Dry tank: the brake can run dry and must say so.
	const dry = shipModule.createShip('stardrive');
	dry.dvSpent = dry.dvMax - 1e5;       // 1e5 m/s of brake budget
	dry.vel[0] = 0.5e-12;                // killing it costs ~1.5e7 m/s — cannot afford
	shipModule.applyStop(dry);
	shipModule.step(dry, 1e6, 0, 0, 0, 1);
	check('a stop that cannot finish leaves the residual and reports it',
		dry.stopping === false && dry.stopResidual > 0
		&& Math.hypot(dry.vel[0], dry.vel[1], dry.vel[2]) === dry.stopResidual
		&& shipModule.dvRemaining(dry) === 0,
		{ residual: dry.stopResidual, vel: Math.hypot(dry.vel[0], dry.vel[1], dry.vel[2]) });

	// Any thrust input overrides the stop command.
	const over = shipModule.createShip('stardrive');
	over.vel[0] = 0.8e-12;
	shipModule.applyStop(over);
	shipModule.step(over, 10, 0, 1, 0, 1);
	check('manual thrust overrides an active stop', over.stopping === false && over.vel[1] > 0);

	// A stop command on a stopped ship is a no-op.
	const still = shipModule.createShip('chemical');
	shipModule.applyStop(still);
	check('applyStop on a stopped ship does nothing', still.stopping === false);
}

// --- 5. The §5 profile against route.js's leg law --------------------------
{
	const ship = shipModule.createShip('stardrive');
	const a = ship.accel;
	const vc = ship.vCruise * shipModule.C;
	const out = {};
	// Unclamped: √(a·d) < v_c — the accelerate/flip/brake triangle.
	const d1 = 1e12;                     // metres, small enough to stay under v_c
	shipModule.apProfile(d1, ship, out);
	check('unclamped profile: t = 2√(d/a) and Δv = 2√(a·d)',
		close(out.timeS, 2 * Math.sqrt(d1 / a), 1e-12) && close(out.dv, 2 * Math.sqrt(a * d1), 1e-12),
		{ t: out.timeS, dv: out.dv });
	check('unclamped profile peaks under the cruise cap', out.speed < vc, out.speed);

	// Clamped: the coast plateau at v_c.
	const d2 = 8.61 * 9.4607e15;         // Sirius-ish, 8.61 ly in metres
	shipModule.apProfile(d2, ship, out);
	check('clamped profile: t = d/v_c + v_c/a and Δv = 2·v_c',
		close(out.timeS, d2 / vc + vc / a, 1e-12) && close(out.dv, 2 * vc, 1e-12),
		{ t: out.timeS, dv: out.dv, years: out.timeS / SEC_YEAR });

	// One source of truth: the ship profile *is* route.js's leg law.
	const routeOut = {};
	routeModule.interstellarLeg(d2, ship, routeOut);
	check('the profile is route.js interstellarLeg, not a re-derivation',
		routeOut.timeS === out.timeS && routeOut.dv === out.dv && routeOut.speed === out.speed,
		{ t: routeOut.timeS, dv: routeOut.dv });

	// In-system classes cannot cruise between stars at all.
	const local = shipModule.createShip('chemical');
	shipModule.apProfile(d2, local, out);
	check('an in-system class reports no interstellar profile',
		!Number.isFinite(out.timeS) && out.speed === 0, { t: out.timeS, speed: out.speed });
}

// --- 6. The §4 ship-time ladder --------------------------------------------
{
	const chem = shipModule.createShip('chemical');
	const star = shipModule.createShip('stardrive');
	const fuse = shipModule.createShip('fusion');
	// The home rung law: a full-thrust frame-tap at 60 fps spends ~1% of the
	// tank. Solve the law and demand the chosen rung land on it.
	function tapFractionAt(index, cls) {
		const rateY = shipModule.SHIP_TIME_LADDER[index];
		const dtShip = rateY * SEC_YEAR / shipModule.HOME_FPS;
		return cls.accel * dtShip / cls.dvMax;
	}
	check('chemical homes on a docking-resolution rung (~1% tank per tap)',
		close(tapFractionAt(chem.timeIndex, chem.class), shipModule.HOME_TAP_FRACTION, 0.5),
		{ rung: shipModule.SHIP_TIME_LADDER[chem.timeIndex], tap: tapFractionAt(chem.timeIndex, chem.class) });
	check('stardrive homes on a cruise-resolution rung (~1% tank per tap)',
		close(tapFractionAt(star.timeIndex, star.class), shipModule.HOME_TAP_FRACTION, 0.5),
		{ rung: shipModule.SHIP_TIME_LADDER[star.timeIndex], tap: tapFractionAt(star.timeIndex, star.class) });
	check('the home rung stays in the manual-flight band',
		[chem, star, fuse].every((s) => shipModule.SHIP_TIME_LADDER[s.timeIndex] >= shipModule.HOME_RATE_MIN
			&& shipModule.SHIP_TIME_LADDER[s.timeIndex] <= shipModule.HOME_RATE_MAX),
		[chem, star, fuse].map((s) => shipModule.SHIP_TIME_LADDER[s.timeIndex]));

	star.timeFrozen = true;
	check('frozen rung: the shared clock pauses', shipModule.timeRateYPerS(star, 0.1) === 0);
	star.timeFrozen = false;
	star.timeIndex = shipModule.SHIP_TIME_LADDER.indexOf(2);
	check('timed rung reads its y/s value', shipModule.timeRateYPerS(star, 0.1) === 2);
	star.timeIndex = 0;                  // follow
	check('follow rung couples to the ship speed (R = gain·v/c)',
		close(shipModule.timeRateYPerS(star, 0.1), shipModule.SHIP_FOLLOW_GAIN * 0.1, 1e-12),
		shipModule.timeRateYPerS(star, 0.1));

	// G5's SIM stop: real time, below the whole manual band. One wall-second
	// is one ship-second, which is the honest discovery the mode exists for.
	const sim = shipModule.createShip('chemical');
	sim.timeIndex = shipModule.SHIP_TIME_REAL_INDEX;
	check('the SIM stop is one ship-second per wall-second',
		shipModule.SHIP_TIME_LADDER[shipModule.SHIP_TIME_REAL_INDEX] === shipModule.SHIP_TIME_REAL
		&& close(shipModule.timeRateYPerS(sim, 0) * SEC_YEAR, 1, 1e-15)
		&& shipModule.formatClock(sim, 0) === 'real ×1',
		{ rate: shipModule.SHIP_TIME_REAL, perWall: shipModule.timeRateYPerS(sim, 0) * SEC_YEAR });
	const homed = ['chemical', 'stardrive', 'fusion'].map((id) => shipModule.createShip(id));
	check('the real stop is below every home rung and no class homes on it',
		homed.every((s) => s.timeIndex > shipModule.SHIP_TIME_REAL_INDEX
			&& shipModule.SHIP_TIME_LADDER[s.timeIndex] >= shipModule.HOME_RATE_MIN),
		homed.map((s) => shipModule.SHIP_TIME_LADDER[s.timeIndex]));
	check('the ladder stays ordered from the real stop to the top',
		shipModule.SHIP_TIME_LADDER.slice(shipModule.SHIP_TIME_REAL_INDEX)
			.every((rung, i, rungs) => i === 0 || rung > rungs[i - 1]));
}

// --- 7. The toggle: pose write-through and velocity handover ---------------
{
	const camera = cameraModule.createCamera();
	const rig = { position: [0, 0, 0], velocity: [0, 0, 0], orientation: [0, 0, 0, 1], speedMult: 1, mode: 0 };
	// Give the camera a real pose to hand over.
	const state = camera.getState();
	state.position[0] = 1.25; state.position[1] = -0.5; state.position[2] = 0.002;
	state.velocity[0] = 0; state.velocity[1] = 0; state.velocity[2] = 0;
	camera.setState(state);
	const before = camera.getState(rig);
	const savedPos = [before.position[0], before.position[1], before.position[2]];
	const savedQuat = [before.orientation[0], before.orientation[1], before.orientation[2], before.orientation[3]];
	// The game write-through: adopt the ship's motion, keep the pose.
	const ship = shipModule.createShip('stardrive');
	ship.pos[0] = before.position[0]; ship.pos[1] = before.position[1]; ship.pos[2] = before.position[2];
	ship.vel[0] = 3e-13; ship.vel[1] = -1e-14; ship.vel[2] = 2e-15;
	rig.velocity[0] = ship.vel[0]; rig.velocity[1] = ship.vel[1]; rig.velocity[2] = ship.vel[2];
	rig.position[0] = ship.pos[0]; rig.position[1] = ship.pos[1]; rig.position[2] = ship.pos[2];
	camera.setState(rig);
	const after = camera.getState(rig);
	check('the write-through keeps the pose bit-exact and writes the velocity',
		after.position[0] === savedPos[0] && after.position[1] === savedPos[1] && after.position[2] === savedPos[2]
		&& after.orientation[0] === savedQuat[0] && after.orientation[1] === savedQuat[1]
		&& after.orientation[2] === savedQuat[2] && after.orientation[3] === savedQuat[3]
		&& after.velocity[0] === ship.vel[0] && after.velocity[1] === ship.vel[1] && after.velocity[2] === ship.vel[2],
		{ pos: after.position, vel: after.velocity });

	// The handover's unit bridge (§2): a drawn feed of Δ kpc per wall frame
	// over `physSeconds` physical seconds seeds Δ/physSeconds kpc/ship-s.
	const drawnDelta = 5.8e-3;           // kpc this frame (time-lapse motion)
	const physSeconds = 2.6e12;          // the shared clock's seconds this frame
	const seed = drawnDelta / physSeconds;
	check('handover velocity is drawn motion per physical second',
		close(seed * shipModule.KPC_M / shipModule.C, drawnDelta / physSeconds * shipModule.KPC_M / shipModule.C, 1e-12),
		{ seedC: seed * shipModule.KPC_M / shipModule.C });
	const hot = shipModule.createShip('chemical');
	hot.vel[0] = shipModule.cruiseCapKpcS(hot) * 2;
	const hotClass = hot.class.id;
	shipModule.setClass(hot, hotClass);
	check('the hangar clamps an over-cap velocity to the class ceiling',
		close(Math.hypot(hot.vel[0], hot.vel[1], hot.vel[2]), shipModule.cruiseCapKpcS(hot), 1e-12),
		Math.hypot(hot.vel[0], hot.vel[1], hot.vel[2]));
	check('the hangar re-arms the tank to the new class',
		hot.dvSpent === 0 && hot.dvMax === dvModule.shipById(hotClass).dvMax, hot.dvMax);
}

// --- 7b. The hull's own heading (ui.11) ------------------------------
// A hull spawned at the camera adopts the camera's heading, and
// piloting it later re-poses the camera onto the stored heading —
// the same write-through discipline as position and velocity.
{
	const camera = cameraModule.createCamera();
	const rig = { position: [0, 0, 0], velocity: [0, 0, 0], orientation: [0, 0, 0, 1], speedMult: 1, mode: 0 };
	// Aim the observer somewhere off the default.
	camera.step(1 / 60, { keys: { forward: false, back: false, left: false, right: false, up: false, down: false, boost: false, slow: false }, lookDx: 260, lookDy: -110, wheelDelta: 0, actions: {} });
	const spawn = camera.getState(rig);
	const spawned = shipModule.createShip('fusion');
	// spawnFleetShip: position and heading from the camera.
	spawned.pos[0] = spawn.position[0]; spawned.pos[1] = spawn.position[1]; spawned.pos[2] = spawn.position[2];
	spawned.heading[0] = spawn.orientation[0]; spawned.heading[1] = spawn.orientation[1];
	spawned.heading[2] = spawn.orientation[2]; spawned.heading[3] = spawn.orientation[3];
	// The observer wanders, then clicks the fleet row.
	camera.step(1 / 60, { keys: { forward: false, back: false, left: false, right: false, up: false, down: false, boost: false, slow: false }, lookDx: -480, lookDy: 210, wheelDelta: 0, actions: {} });
	const adopt = camera.getState(rig);
	adopt.position[0] = spawned.pos[0]; adopt.position[1] = spawned.pos[1]; adopt.position[2] = spawned.pos[2];
	adopt.orientation[0] = spawned.heading[0]; adopt.orientation[1] = spawned.heading[1];
	adopt.orientation[2] = spawned.heading[2]; adopt.orientation[3] = spawned.heading[3];
	adopt.mode = cameraModule.MODE_FLY;
	camera.setState(adopt);
	const piloting = camera.getState(rig);
	check('selecting a hull re-poses the camera onto its stored heading',
		piloting.orientation[0] === spawned.heading[0] && piloting.orientation[1] === spawned.heading[1]
		&& piloting.orientation[2] === spawned.heading[2] && piloting.orientation[3] === spawned.heading[3],
		{ q: piloting.orientation, heading: spawned.heading });
	// A thrust burn then follows the stored heading: the velocity
	// lands on the camera's forward, which is the spawn heading.
	const rateY = shipModule.timeRateYPerS(spawned, 0);
	const dtShipS = rateY * dvModule.SECONDS_PER_YEAR * (1 / 60);
	for (let i = 0; i < 5; i++) shipModule.step(spawned, dtShipS, camera.forward[0], camera.forward[1], camera.forward[2], 1);
	const sp = Math.hypot(spawned.vel[0], spawned.vel[1], spawned.vel[2]);
	const along = (spawned.vel[0] * camera.forward[0] + spawned.vel[1] * camera.forward[1] + spawned.vel[2] * camera.forward[2]) / sp;
	check('a burn on a restored hull follows its stored heading', along > 0.999999, { along });
	// The per-frame write-back keeps the record's heading identical
	// to the live camera orientation.
	const live = camera.getState(rig);
	spawned.heading[0] = live.orientation[0]; spawned.heading[1] = live.orientation[1];
	spawned.heading[2] = live.orientation[2]; spawned.heading[3] = live.orientation[3];
	check('the record heading tracks the live camera orientation',
		spawned.heading[0] === live.orientation[0] && spawned.heading[3] === live.orientation[3], null);
}

// --- 8. Reset, refuel and the record's stability ---------------------------
{
	const ship = shipModule.createShip('fusion');
	shipModule.step(ship, 1e6, 1, 0, 0, 1);
	ship.pos[0] = 3;
	shipModule.refuel(ship);
	check('refuel re-arms the tank but keeps the flight state',
		shipModule.dvRemaining(ship) === ship.dvMax && ship.lifeSpent > 0 && ship.pos[0] === 3,
		{ remain: shipModule.dvRemaining(ship), life: ship.lifeSpent });
	shipModule.resetShip(ship);
	check('reset zeroes velocity, tank, life and the stop command',
		ship.vel[0] === 0 && ship.dvSpent === 0 && ship.lifeSpent === 0
		&& ship.stopping === false && ship.stopResidual === 0, null);

	const stable = shipModule.createShip('stardrive');
	const refs = { pos: stable.pos, vel: stable.vel, cls: stable.class, keys: Object.keys(stable).length };
	for (let i = 0; i < 600; i++) {
		const factor = i % 3 === 0 ? 4 : i % 3 === 1 ? 0.25 : 1;
		shipModule.step(stable, 1e5, i % 2, i % 3, 0, factor);
		if (i === 100) shipModule.applyStop(stable);
	}
	check('no buffers are reallocated across 600 mixed frames',
		stable.pos === refs.pos && stable.vel === refs.vel && stable.class === refs.cls
		&& Object.keys(stable).length === refs.keys,
		{ keys: Object.keys(stable).length });

	// A frozen clock accepts no impulse. The lever may be commanded, but the
	// HUD's acceleration/throttle are explicitly accepted thrust, not request.
	const frozen = shipModule.createShip('stardrive');
	shipModule.step(frozen, 0, 1, 0, 0, 1);
	check('a frozen clock burns and accepts nothing',
		frozen.dvSpent === 0 && frozen.lifeSpent === 0 && frozen.vel[0] === 0
		&& frozen.accelNow === 0 && frozen.throttleFrac === 0,
		{ dvSpent: frozen.dvSpent, accelNow: frozen.accelNow });
}

// --- 7. G3: destination profiles and accepted impulse ----------------------
{
	const ship = shipModule.createShip('stardrive');
	const plan = shipModule.createFlightPlan();
	const distance = 1 * 9.4607e15;
	shipModule.planJourney(distance, ship, shipModule.NAV_FASTEST, 0.4, 0.4, 0, plan);
	const fastTime = plan.timeS;
	const fastDv = plan.dv;
	check('fastest plan uses the class acceleration and speed cap',
		plan.feasible && plan.accelLimit === ship.accel
		&& close(plan.speedLimit, shipModule.cruiseCapKpcS(ship) * shipModule.KPC_M, 1e-12),
		{ accel: plan.accelLimit, speed: plan.speedLimit, time: plan.timeS });

	shipModule.planJourney(distance, ship, shipModule.NAV_THRUST_LIMIT, 0.25, 1, 0, plan);
	check('thrust-limit plan scales acceleration from the user setting',
		plan.feasible && close(plan.accelLimit, ship.accel * 0.25, 1e-12)
		&& plan.timeS > fastTime,
		{ accel: plan.accelLimit, time: plan.timeS, fastest: fastTime });

	shipModule.planJourney(distance, ship, shipModule.NAV_SPEED_LIMIT, 1, 0.25, 0, plan);
	check('speed-limit plan scales the cap and predicts lower Δv / longer time',
		plan.feasible && close(plan.speedLimit, shipModule.cruiseCapKpcS(ship) * shipModule.KPC_M * 0.25, 1e-12)
		&& plan.dv < fastDv && plan.timeS > fastTime,
		{ speed: plan.speedLimit, dv: plan.dv, time: plan.timeS });

	const deadline = fastTime * 2;
	shipModule.planJourney(distance, ship, shipModule.NAV_TIME_LIMIT, 1, 1, deadline, plan);
	check('time-limit plan meets a feasible deadline with legal limits',
		plan.feasible && close(plan.timeS, deadline, 1e-12)
		&& plan.accelLimit <= ship.accel * (1 + 1e-12)
		&& plan.speedLimit <= shipModule.cruiseCapKpcS(ship) * shipModule.KPC_M * (1 + 1e-12),
		{ time: plan.timeS, deadline, accel: plan.accelLimit, speed: plan.speedLimit });

	shipModule.planJourney(distance, ship, shipModule.NAV_TIME_LIMIT, 1, 1, fastTime * 0.5, plan);
	check('time-limit plan refuses a deadline shorter than the fastest legal flight',
		!plan.feasible && plan.reason === shipModule.NAV_REASON_TIME && close(plan.fastestS, fastTime, 1e-12),
		{ reason: plan.reason, fastest: plan.fastestS, requested: fastTime * 0.5 });

	const local = shipModule.createShip('chemical');
	shipModule.planJourney(distance, local, shipModule.NAV_FASTEST, 1, 1, 0, plan);
	check('destination planning preserves the in-system class restriction',
		!plan.feasible && plan.reason === shipModule.NAV_REASON_LOCAL,
		{ reason: plan.reason, time: plan.timeS });

	// A configured commit copies its limits. The future UI can change the plan
	// object without mutating the burn the autopilot already owns.
	shipModule.planJourney(distance, ship, shipModule.NAV_SPEED_LIMIT, 1, 0.4, 0, plan);
	const commitShip = shipModule.createShip('stardrive');
	const reason = shipModule.apCommitApproach(commitShip, distance / shipModule.KPC_M, 0, 0, 0, 0, 0, 0, plan);
	check('configured approach copies the forecast limits and checkout',
		reason === shipModule.AP_REASON_NONE && commitShip.ap.planMode === shipModule.NAV_SPEED_LIMIT
		&& commitShip.ap.accelLimit === plan.accelLimit && commitShip.ap.speedLimit === plan.speedLimit
		&& close(commitShip.ap.dvRequired, plan.dv, 1e-12),
		{ reason, accel: commitShip.ap.accelLimit, speed: commitShip.ap.speedLimit, dv: commitShip.ap.dvRequired });
}

{
	// Fuel follows the accepted projected impulse. At cap, a forward command is
	// projected back to the same velocity and must neither drain tank nor lie to
	// the accepted-thrust HUD. A turn and a brake pay the actual vector change.
	const atCap = shipModule.createShip('stardrive');
	const cap = shipModule.cruiseCapKpcS(atCap);
	const governed = shipModule.createShip('stardrive');
	const desiredCap = cap * 0.75;
	shipModule.step(governed, 1e8, 1, 0, 0, 1, desiredCap);
	check('the desired-speed governor accepts only the impulse up to its target',
		close(Math.hypot(governed.vel[0], governed.vel[1], governed.vel[2]), desiredCap, 1e-12)
		&& close(governed.dvSpent, desiredCap * shipModule.KPC_M, 1e-12)
		&& governed.throttleFrac > 0 && governed.throttleFrac < 1,
		{ speed: Math.hypot(governed.vel[0], governed.vel[1], governed.vel[2]), target: desiredCap, charged: governed.dvSpent });
	atCap.vel[0] = cap;
	const forwardFuel = atCap.dvSpent;
	shipModule.step(atCap, 1000, 1, 0, 0, 1);
	check('forward thrust held at cruise cap is accepted as zero and costs no fuel',
		atCap.dvSpent === forwardFuel && atCap.accelNow === 0 && atCap.throttleFrac === 0
		&& atCap.vel[0] === cap,
		{ fuel: atCap.dvSpent, accel: atCap.accelNow, speed: atCap.vel[0] });

	const turn = shipModule.createShip('stardrive');
	turn.vel[0] = cap;
	const beforeTurn = Array.from(turn.vel);
	const spentBeforeTurn = turn.dvSpent;
	shipModule.step(turn, 1000, 0, 1, 0, 1);
	const actualTurn = Math.hypot(turn.vel[0] - beforeTurn[0], turn.vel[1] - beforeTurn[1], turn.vel[2] - beforeTurn[2]) * shipModule.KPC_M;
	check('steering at cruise cap pays the accepted velocity-vector change',
		actualTurn > 0 && close(turn.dvSpent - spentBeforeTurn, actualTurn, 1e-12)
		&& close(Math.hypot(turn.vel[0], turn.vel[1], turn.vel[2]), cap, 1e-12),
		{ acceptedDv: actualTurn, charged: turn.dvSpent - spentBeforeTurn });

	const brake = shipModule.createShip('stardrive');
	brake.vel[0] = cap;
	const beforeBrake = brake.vel[0];
	shipModule.step(brake, 1000, -1, 0, 0, 1);
	const actualBrake = Math.abs(brake.vel[0] - beforeBrake) * shipModule.KPC_M;
	check('braking pays the speed actually removed',
		actualBrake > 0 && close(brake.dvSpent, actualBrake, 1e-12)
		&& brake.accelNow > 0 && brake.throttleFrac > 0,
		{ acceptedDv: actualBrake, charged: brake.dvSpent });

	const partial = shipModule.createShip('stardrive');
	partial.vel[0] = cap;
	partial.dvSpent = partial.dvMax - 1000;
	const partialBefore = Array.from(partial.vel);
	shipModule.step(partial, 1e5, 0, 1, 0, 1);
	const partialAccepted = Math.hypot(partial.vel[0] - partialBefore[0], partial.vel[1] - partialBefore[1], partial.vel[2] - partialBefore[2]) * shipModule.KPC_M;
	check('a near-empty tank accepts only the affordable projected turn',
		partial.dvSpent === partial.dvMax && partialAccepted <= 1000.001 && partialAccepted > 999.9,
		{ acceptedDv: partialAccepted, tank: partial.dvSpent });
}

// --- 8. G2: the §5 approach and follow ------------------------------------
// The commit's checkout, the refusals, the flown approach, the abort and the
// follow are one law each; the flights run the same apStep the game frame calls.
const LY_KPC = 1 / 3261.56;      // 1 kpc = 3261.56 ly
const STAND_OFF_M = 1e13;        // ~67 AU, the shell the approach ends on
const DRIFT_MS = 2.2e5;          // a stellar drift (the galactic-rotation order)
const AP_DT_WALL = 1 / 60;

function flightSteps(ship, target, targetVel, dtShipS, maxSteps, onStep) {
	let steps = 0;
	for (; steps < maxSteps && ship.ap.mode !== shipModule.AP_OFF; steps++) {
		target[0] += targetVel[0] * dtShipS;
		target[1] += targetVel[1] * dtShipS;
		target[2] += targetVel[2] * dtShipS;
		shipModule.apStep(ship, dtShipS, AP_DT_WALL, target[0], target[1], target[2],
			targetVel[0], targetVel[1], targetVel[2]);
		if (onStep) onStep(ship, steps);
	}
	return steps;
}

{
	// The commit's checkout is the leg profile's Δv and ETA, not a re-derivation.
	const ship = shipModule.createShip('stardrive');
	const d = 1 * LY_KPC;
	const reason = shipModule.apCommitApproach(ship, d, 0, 0, 0, 0, 0, STAND_OFF_M);
	const prof = { speed: 0, dv: 0, timeS: 0, distanceM: 0 };
	routeModule.interstellarLeg(d * shipModule.KPC_M - STAND_OFF_M, ship, prof);
	check('the commit arms a cold approach with the leg profile\'s Δv and ETA',
		reason === shipModule.AP_REASON_NONE && ship.ap.mode === shipModule.AP_APPROACH
		&& ship.ap.phase === shipModule.AP_PHASE_BURN
		&& close(ship.ap.dvRequired, prof.dv, 1e-12) && close(ship.ap.etaTotalS, prof.timeS, 1e-12),
		{ reason, dvRequired: ship.ap.dvRequired, dv: prof.dv, etaTotalS: ship.ap.etaTotalS, timeS: prof.timeS });
}

{
	// Refusals never touch the tank, the velocity or the mode.
	const fuel = shipModule.createShip('stardrive');
	fuel.dvSpent = fuel.dvMax - 1;
	const rFuel = shipModule.apCommitApproach(fuel, 1 * LY_KPC, 0, 0, 0, 0, 0, STAND_OFF_M);
	check('insufficient Δv refuses with the need, without burning',
		rFuel === shipModule.AP_REASON_FUEL && fuel.ap.mode === shipModule.AP_OFF
		&& fuel.dvSpent === fuel.dvMax - 1 && fuel.vel[0] === 0 && fuel.ap.reasonDv > 1,
		{ rFuel, need: fuel.ap.reasonDv });

	// 0.09c straight at a target 0.001 ly past the shell: the closing rate has
	// outrun what the class can brake inside the remaining distance.
	const hot = shipModule.createShip('stardrive');
	hot.vel[0] = 0.09 * shipModule.C / shipModule.KPC_M;
	const rHot = shipModule.apCommitApproach(hot, 0.001 * LY_KPC, 0, 0, 0, 0, 0, 1e11);
	check('a hot approach refuses rather than braking through the target',
		rHot === shipModule.AP_REASON_HOT && hot.ap.mode === shipModule.AP_OFF && hot.dvSpent === 0
		&& hot.ap.closingMs > 0,
		{ rHot, closingMs: hot.ap.closingMs });

	const local = shipModule.createShip('chemical');
	const rLocal = shipModule.apCommitApproach(local, 1 * LY_KPC, 0, 0, 0, 0, 0, STAND_OFF_M);
	check('an in-system class has no interstellar profile to fly',
		rLocal === shipModule.AP_REASON_LOCAL && local.ap.mode === shipModule.AP_OFF);

	const close0 = shipModule.createShip('stardrive');
	const rClose = shipModule.apCommitApproach(close0, (STAND_OFF_M + 7.5e10) / shipModule.KPC_M, 0, 0, 0, 0, 0, STAND_OFF_M);
	check('a target already inside the shell is refused as already there',
		rClose === shipModule.AP_REASON_CLOSE && close0.ap.mode === shipModule.AP_OFF);
}

{
	// The flown approach to a fixed star: converges on the shell, spends no more
	// than the checkout reserved, and walks burn → coast → flip → brake.
	const ship = shipModule.createShip('stardrive');
	const target = new Float64Array([1 * LY_KPC, 0, 0]);
	const still = new Float64Array(3);
	shipModule.apCommitApproach(ship, target[0], 0, 0, 0, 0, 0, STAND_OFF_M);
	const required = ship.ap.dvRequired;
	const etaTotal = ship.ap.etaTotalS;     // apEnd clears it, so the closed form is read at the commit
	const phases = new Set();
	let retrogradeSteps = 0;
	const steps = flightSteps(ship, target, still, 3e5, 20000, (s) => {
		phases.add(shipModule.AP_PHASE_NAMES[s.ap.phase]);
		// The brake is read off the nose: retrograde against a moving ship. The
		// flip beat (0.8 wall s) can cover a whole brake at 60 fps, so the phase
		// name alone cannot show it.
		const speed = Math.hypot(s.vel[0], s.vel[1], s.vel[2]);
		if (speed > 0 && (s.ap.aim[0] * s.vel[0] + s.ap.aim[1] * s.vel[1] + s.ap.aim[2] * s.vel[2]) / speed < -0.99) retrogradeSteps++;
	});
	const dist = Math.hypot(target[0] - ship.pos[0], target[1] - ship.pos[1], target[2] - ship.pos[2]) * shipModule.KPC_M;
	check('the flown approach arrives on the shell inside the checkout',
		ship.ap.mode === shipModule.AP_OFF && ship.ap.reason === shipModule.AP_REASON_ARRIVED
		&& dist <= STAND_OFF_M + shipModule.AP_ARRIVE_M && steps < 20000 && ship.dvSpent <= required * (1 + 1e-6),
		{ steps, dist, spent: ship.dvSpent, required });
	check('the flight walks burn, coast and flip, and brakes with the nose retrograde',
		phases.has('burn') && phases.has('coast') && phases.has('flip') && retrogradeSteps > 0,
		{ phases: [...phases], retrogradeSteps });
	check('the flight time is the closed form\'s own scale',
		ship.lifeSpent > 0.5 * etaTotal && ship.lifeSpent < 1.5 * etaTotal,
		{ shipS: ship.lifeSpent, etaTotal });
}

{
	// A moving target: the ship meets the drifting shell, and it does so with
	// the velocity match, not by chasing its own position.
	const ship = shipModule.createShip('stardrive');
	const v = DRIFT_MS / shipModule.KPC_M;
	const target = new Float64Array([1 * LY_KPC, 0, 0]);
	const drift = new Float64Array([0, v, 0]);
	shipModule.apCommitApproach(ship, target[0], 0, 0, 0, v, 0, STAND_OFF_M);
	const reason0 = ship.ap.mode;
	flightSteps(ship, target, drift, 3e5, 20000, null);
	const dist = Math.hypot(target[0] - ship.pos[0], target[1] - ship.pos[1], target[2] - ship.pos[2]) * shipModule.KPC_M;
	check('a drifting target is met at the shell',
		reason0 === shipModule.AP_APPROACH && ship.ap.reason === shipModule.AP_REASON_ARRIVED
		&& dist <= STAND_OFF_M + shipModule.AP_ARRIVE_M,
		{ dist, reason: shipModule.AP_REASON_NAMES[ship.ap.reason] });
}

{
	// The precision target command arrives at the live point and settles in
	// the target's rest frame: all three relative velocity axes are zero.
	const ship = shipModule.createShip('stardrive');
	const target = new Float64Array([1 * LY_KPC, 0, 0]);
	const drift = new Float64Array([0, DRIFT_MS / shipModule.KPC_M, 0]);
	const reason = shipModule.apCommitTarget(ship, target[0], 0, 0, drift[0], drift[1], drift[2]);
	const required = ship.ap.dvRequired;
	const steps = flightSteps(ship, target, drift, 3e5, 20000, null);
	const dist = Math.hypot(target[0] - ship.pos[0], target[1] - ship.pos[1], target[2] - ship.pos[2]) * shipModule.KPC_M;
	const rel = Math.hypot(ship.vel[0] - drift[0], ship.vel[1] - drift[1], ship.vel[2] - drift[2]) * shipModule.KPC_M;
	check('target autopilot settles on the moving target with 0,0,0 relative speed',
		reason === shipModule.AP_REASON_NONE && ship.ap.mode === shipModule.AP_OFF
		&& ship.ap.reason === shipModule.AP_REASON_ARRIVED && dist === 0 && rel === 0
		&& steps < 20000 && ship.dvSpent <= required * (1 + 1e-6),
		{ reason, steps, dist, rel, spent: ship.dvSpent, required });

	const near = shipModule.createShip('stardrive');
	const nearDx = 0.5 * shipModule.AP_ARRIVE_M / shipModule.KPC_M;
	const nearReason = shipModule.apCommitTarget(near, nearDx, 0, 0, 0, 0, 0);
	check('target autopilot immediately settles inside its arrival tolerance',
		nearReason === shipModule.AP_REASON_ARRIVED && near.ap.reason === shipModule.AP_REASON_ARRIVED
		&& near.pos[0] === nearDx && near.vel[0] === 0 && near.ap.mode === shipModule.AP_OFF,
		{ nearReason, x: near.pos[0] });
}

{
	const ship = shipModule.createShip('stardrive');
	ship.vel.set([3, -2, 5]);
	const axes = new Float64Array(3);
	const targetVelocity = new Float64Array([1, 1, 2]);
	shipModule.velocityComponents(ship, [1, 0, 0], [0, 1, 0], [0, 0, 1], targetVelocity, axes);
	check('velocity components project target-relative speed onto view forward/right/up',
		axes[0] === 2 && axes[1] === -3 && axes[2] === 3
		&& shipModule.formatAxisSpeed(-1 / shipModule.KPC_M).startsWith('−'), Array.from(axes));
	const cap = shipModule.timeRateCapYPerS(8 * SEC_YEAR, 4);
	check('the autopilot time-rate cap preserves a four-second wall-time arrival',
		close(cap, 2, 1e-12) && close((8 * SEC_YEAR) / (cap * SEC_YEAR), 4, 1e-12), cap);
}

{
	// Abort keeps the velocity and stops the burn; the stop command aborts too.
	const ship = shipModule.createShip('stardrive');
	const target = new Float64Array([1 * LY_KPC, 0, 0]);
	shipModule.apCommitApproach(ship, target[0], 0, 0, 0, 0, 0, STAND_OFF_M);
	flightSteps(ship, target, new Float64Array(3), 3e5, 50, null);
	const vBefore = Array.from(ship.vel);
	const spentBefore = ship.dvSpent;
	shipModule.apAbort(ship);
	for (let i = 0; i < 20; i++) shipModule.apStep(ship, 3e5, AP_DT_WALL, target[0], 0, 0, 0, 0, 0);
	check('abort ends the flight, keeps the velocity and burns nothing more',
		ship.ap.mode === shipModule.AP_OFF && ship.ap.reason === shipModule.AP_REASON_ABORTED
		&& ship.vel[0] === vBefore[0] && ship.dvSpent === spentBefore && ship.vel[0] > 0,
		{ reason: shipModule.AP_REASON_NAMES[ship.ap.reason], spent: ship.dvSpent - spentBefore });

	const stop = shipModule.createShip('stardrive');
	shipModule.apCommitApproach(stop, target[0], 0, 0, 0, 0, 0, STAND_OFF_M);
	shipModule.applyStop(stop);
	check('the all-stop aborts the autopilot first', stop.ap.mode === shipModule.AP_OFF);

	const swap = shipModule.createShip('stardrive');
	shipModule.apCommitApproach(swap, target[0], 0, 0, 0, 0, 0, STAND_OFF_M);
	shipModule.setClass(swap, 'fusion');
	check('a class swap ends the autopilot (its accel was the command\'s)', swap.ap.mode === shipModule.AP_OFF);
}

// Follow (j): a moving target, the ship starts with a mismatch and must null the
// relative velocity and trail at the stand-off; a curve costs fuel once, and the
// straight run costs nothing.
function followRun(dtShipS) {
	const ship = shipModule.createShip('stardrive');
	const v = DRIFT_MS / shipModule.KPC_M;
	const velocity = new Float64Array([v, 0, 0]);
	const target = new Float64Array([0.02 * LY_KPC, 0, 0]);   // the cruise closes it inside the horizon at every rung
	ship.vel[0] = v * 0.5;
	shipModule.apCommitFollow(ship, target[0], 0, 0, velocity[0], 0, 0, STAND_OFF_M);
	flightSteps(ship, target, velocity, dtShipS, 6000, null);
	const captured = ship.dvSpent;
	const dist = Math.hypot(target[0] - ship.pos[0], target[1] - ship.pos[1], target[2] - ship.pos[2]) * shipModule.KPC_M;
	const relStraight = Math.hypot(ship.vel[0] - velocity[0], ship.vel[1] - velocity[1], ship.vel[2] - velocity[2]) * shipModule.KPC_M;
	const straightCost = ship.dvSpent - captured;
	const before = ship.dvSpent;
	velocity[0] = 0; velocity[1] = v;
	flightSteps(ship, target, velocity, dtShipS, 6000, null);
	const relCurve = Math.hypot(ship.vel[0] - velocity[0], ship.vel[1] - velocity[1], ship.vel[2] - velocity[2]) * shipModule.KPC_M;
	return { ship, dist, relStraight, relCurve, straightCost, curveCost: ship.dvSpent - before, targetSpeedMs: DRIFT_MS, active: ship.ap.mode === shipModule.AP_FOLLOW };
}
for (const dtShipS of [3e4, 3e5, 1e6]) {
	const r = followRun(dtShipS);
	const tag = `dt=${dtShipS.toExponential(0)}`;
	// The stand-off is held to within one frame of the target's own motion: the
	// clock cannot resolve less, and a deadbeat frame lands the ship there.
	const resolutionM = r.targetSpeedMs * dtShipS + 1e-3 * STAND_OFF_M;
	check(`follow nulls the relative velocity and trails at the stand-off (${tag})`,
		r.active && r.relStraight < 10 && Math.abs(r.dist - STAND_OFF_M) <= resolutionM,
		{ relStraightMs: r.relStraight, dist: r.dist, standOff: STAND_OFF_M, resolutionM });
	check(`follow spends only on the target's curve, not its straight run (${tag})`,
		r.straightCost < 1e3 && r.curveCost > 0 && r.curveCost < 0.5 * r.ship.dvMax,
		{ straightCostMs: r.straightCost, curveCostMs: r.curveCost });
	check(`follow re-nulls after the target curves (${tag})`, r.relCurve < 100, { relCurveMs: r.relCurve });
}

{
	// Follow toggled off keeps the velocity, as an approach abort does.
	const ship = shipModule.createShip('stardrive');
	const v = DRIFT_MS / shipModule.KPC_M;
	const target = new Float64Array([1 * LY_KPC, 0, 0]);
	const velocity = new Float64Array([v, 0, 0]);
	shipModule.apCommitFollow(ship, target[0], 0, 0, v, 0, 0, STAND_OFF_M);
	flightSteps(ship, target, velocity, 3e5, 200, null);
	const vBefore = ship.vel[0];
	shipModule.apAbort(ship);
	check('follow toggled off keeps the velocity it had', ship.ap.mode === shipModule.AP_OFF && ship.vel[0] === vBefore);
}

{
	// The approach, the follow and the abort weave through one ship record with
	// no buffer reallocated (the G1 pin, extended to the autopilot's state).
	const stable = shipModule.createShip('stardrive');
	const refs = { pos: stable.pos, vel: stable.vel, ap: stable.ap, dir: stable.ap.dir, aim: stable.ap.aim, keys: Object.keys(stable).length };
	const target = new Float64Array([0.5 * LY_KPC, 0, 0]);
	const still = new Float64Array(3);
	shipModule.apCommitApproach(stable, target[0], 0, 0, 0, 0, 0, STAND_OFF_M);
	for (let i = 0; i < 300; i++) shipModule.apStep(stable, 3e5, AP_DT_WALL, target[0], 0, 0, 0, 0, 0);
	shipModule.apAbort(stable);
	shipModule.apCommitFollow(stable, target[0], 0, 0, 0, 0, 0, STAND_OFF_M);
	for (let i = 0; i < 300; i++) shipModule.apStep(stable, 3e5, AP_DT_WALL, target[0], 0, 0, 0, 0, 0);
	shipModule.apAbort(stable);
	shipModule.step(stable, 1e5, 1, 0, 0, 1);
	check('no buffers are reallocated across the approach, the follow and the abort',
		stable.pos === refs.pos && stable.vel === refs.vel && stable.ap === refs.ap
		&& stable.ap.dir === refs.dir && stable.ap.aim === refs.aim && Object.keys(stable).length === refs.keys,
		{ keys: Object.keys(stable).length });
}

// --- 8b. ui.15: the nose at the fine clock rungs ---------------------------
// The reported bug: at small ship-time rates the autopilot's nose did not hold
// the target but flicked direction every frame. The cause was upstream of the
// aim law: the game fed the target's velocity as a one-frame difference of two
// drawn positions, and at the fine rungs a frame is below the drawn position's
// own f64 ULP (55 km on a solar-circle coordinate, versus 0.7 km of motion at
// the real-time rung). The desired velocity therefore carried a 0 / one-ULP
// staircase, and the aim — the normalized command — followed it: 111° in one
// frame in this fixture. The fix is the drawn-velocity twin
// (orbit.engineRecordVelocity through selection.resolveDrawnVelocity): the
// same dispatch, sampled a fixed *model-time* baseline apart, so the estimate
// does not depend on the ship clock at all.
//
// This block flies the real apStep on the same fixture for every fine rung
// with both feeds. The drawn-velocity feed must hold the nose on the line of
// sight everywhere; the frame difference is the negative control, so the
// passing half cannot pass vacuously.
{
	const orbitModule = require('../src/math/orbit.js');
	const galaxyModule = require('../src/math/galaxy.js');
	const recordModule = require('../src/math/star-record.js');
	const MW = galaxyModule.MILKY_WAY;
	const SEC_MYR = 3.15576e13;
	const AU = 1.495978707e11;
	const T0 = 5;                                   // Myr: the orbit law is under way
	const STAND_KPC = 0.0006;                       // 0.6 pc shell
	const REM_AU = 1.2;                             // just outside the 1 AU arrival
	const bx = 8, by = 0, bz = 0.1;
	const packed = ((orbitModule.flagsWithFamily(recordModule.FLAG_VISIBLE, orbitModule.FAMILY_DISC) << 16)
		| (orbitModule.encodeJitter(3, 7) << 24)) >>> 0;
	const savedEngine = orbitModule.getEngine();
	orbitModule.setEngine(orbitModule.ENGINE_CLASSIC);
	const tvModel = new Float64Array(3);
	orbitModule.engineRecordVelocity(tvModel, bx, by, bz, packed, T0, MW);
	const drift = Math.hypot(tvModel[0], tvModel[1]);
	// Approach perpendicular to the star's own drift: the generic geometry, and
	// the one where a sideways velocity error tilts the nose most.
	const losX = -tvModel[1] / drift, losY = tvModel[0] / drift;
	const distKpc = STAND_KPC + REM_AU * AU / shipModule.KPC_M;
	const RATES = [1 / shipModule.SECONDS_PER_YEAR, 1e-6, 1e-5, 1e-4, 1e-3];

	function fly(rate, frameDiff) {
		const ship = shipModule.createShip('stardrive');
		const start = new Float64Array(3);
		orbitModule.engineRecordPosition(start, bx, by, bz, packed, T0, MW);
		ship.pos[0] = start[0] - losX * distKpc;
		ship.pos[1] = start[1] - losY * distKpc;
		ship.pos[2] = start[2];
		ship.vel[0] = tvModel[0]; ship.vel[1] = tvModel[1]; ship.vel[2] = tvModel[2];
		const reason = shipModule.apCommitApproach(ship,
			start[0] - ship.pos[0], start[1] - ship.pos[1], start[2] - ship.pos[2],
			tvModel[0], tvModel[1], tvModel[2], STAND_KPC * shipModule.KPC_M);
		const dtShip = rate * shipModule.SECONDS_PER_YEAR / 60;   // 60 fps
		const dtMyr = dtShip / SEC_MYR;
		const prevPos = new Float64Array(3), pos = new Float64Array(3), tv = new Float64Array(3);
		prevPos.set(start);
		let t = T0, prevAx = 0, prevAy = 0, prevAz = 0, havePrev = false;
		let maxStep = 0, maxLos = 0, bigSteps = 0;
		for (let f = 0; f < 1200 && ship.ap.mode !== shipModule.AP_OFF; f++) {
			t += dtMyr;
			orbitModule.engineRecordPosition(pos, bx, by, bz, packed, t, MW);
			if (frameDiff) {
				// The shipped ui.14 feed, exactly: one frame of drawn position.
				tv[0] = (pos[0] - prevPos[0]) / dtShip;
				tv[1] = (pos[1] - prevPos[1]) / dtShip;
				tv[2] = (pos[2] - prevPos[2]) / dtShip;
			} else {
				orbitModule.engineRecordVelocity(tv, bx, by, bz, packed, t, MW);
			}
			prevPos.set(pos);
			shipModule.apStep(ship, dtShip, AP_DT_WALL, pos[0], pos[1], pos[2], tv[0], tv[1], tv[2]);
			const ax = ship.ap.aim[0], ay = ship.ap.aim[1], az = ship.ap.aim[2];
			const rx = pos[0] - ship.pos[0], ry = pos[1] - ship.pos[1], rz = pos[2] - ship.pos[2];
			const rl = Math.hypot(rx, ry, rz);
			const los = Math.acos(Math.max(-1, Math.min(1,
				(ax * rx + ay * ry + az * rz) / rl))) * 180 / Math.PI;
			if (los > maxLos) maxLos = los;
			if (havePrev) {
				const step = Math.acos(Math.max(-1, Math.min(1, ax * prevAx + ay * prevAy + az * prevAz))) * 180 / Math.PI;
				if (step > maxStep) maxStep = step;
				if (step > 30) bigSteps++;
			}
			prevAx = ax; prevAy = ay; prevAz = az; havePrev = true;
		}
		return { reason, maxStep, maxLos, bigSteps };
	}

	const rows = [];
	let fixedOk = true;
	for (const rate of RATES) {
		const fixed = fly(rate, false);
		const shipped = fly(rate, true);
		rows.push({ rate, fixed, shipped });
		if (!(fixed.reason === shipModule.AP_REASON_NONE && fixed.maxStep < 0.01
			&& fixed.maxLos < 0.1 && fixed.bigSteps === 0)) fixedOk = false;
	}
	// The player-visible shape of the report: the shipped feed is worst at the
	// finest rung and improves monotonically as a frame grows past the drawn
	// position's ULP. (At the real-time rung the star's 8 kpc x-coordinate
	// advances one 55 km ULP every ~76 frames; divided by 1/60 s that reads as
	// a 3289 km/s spike — 109° of aim against a 1900 km/s closing speed.)
	const steps = rows.map((r) => r.shipped.maxStep);
	const monotone = steps[0] > 30 && steps[0] > steps[1] && steps[1] > steps[2]
		&& steps[2] > steps[3] && steps[3] > steps[4];
	check('at every fine rung the drawn-velocity feed holds the nose on the target',
		fixedOk, { rows });
	check('the frame-difference feed is worse the finer the rung (negative control)',
		monotone && rows[0].shipped.bigSteps > 10 && rows[0].shipped.maxLos > 30,
		{ steps, real: rows[0].shipped });

	orbitModule.setEngine(savedEngine);
}

// --- 9. G5: the SIM/ARCADE clock presets and the coast warp ----------------
// SIM is the ladder's real stop; ARCADE is the class's default rung plus warp
// while a destination autopilot coasts. The warp is the same four-wall-second
// floor the autopilot cap already applies, as a lower bound here instead.
{
	const still = new Float64Array(3);
	const ship = shipModule.createShip('stardrive');
	const target = new Float64Array([1 * LY_KPC, 0, 0]);
	check('the arcade warp is off by default',
		ship.arcade === false && shipModule.arcadeWarpYPerS(ship, 4) === 0);
	shipModule.apCommitApproach(ship, target[0], 0, 0, 0, 0, 0, STAND_OFF_M);
	ship.arcade = true;
	check('the warp does not touch the burn phase',
		ship.ap.phase === shipModule.AP_PHASE_BURN && shipModule.arcadeWarpYPerS(ship, 4) === 0);

	// Fly to the coast: the burn to 0.1 c is a fraction of a year, while the
	// unpowered leg to a 1 ly shell is the years-long stretch the warp exists
	// for. The step dt is the test's own; the law reads ap.etaS.
	let coastSteps = 0;
	while (coastSteps < 20000 && ship.ap.mode !== shipModule.AP_OFF
		&& ship.ap.phase !== shipModule.AP_PHASE_COAST) {
		shipModule.apStep(ship, 3e5, AP_DT_WALL, target[0], 0, 0, 0, 0, 0);
		coastSteps++;
	}
	const warp = shipModule.arcadeWarpYPerS(ship, 4);
	check('the coast warp is the flight\'s four-wall-second rate',
		ship.ap.phase === shipModule.AP_PHASE_COAST && warp > 0
			&& warp === shipModule.timeRateCapYPerS(ship.ap.etaS, 4)
			&& warp > shipModule.SHIP_TIME_LADDER[ship.timeIndex],
		{ warp, etaS: ship.ap.etaS, base: shipModule.SHIP_TIME_LADDER[ship.timeIndex] });
	check('the clock readout names the arcade base rung',
		shipModule.formatClock(ship, shipModule.speedC(ship)).startsWith('arcade +'));
	ship.timeFrozen = true;
	check('a frozen clock reads zero at both the base law and the warp',
		shipModule.timeRateYPerS(ship, 0) === 0 && shipModule.arcadeWarpYPerS(ship, 4) === 0);
	ship.timeFrozen = false;

	// A follow is station-keeping, not a destination flight: no warp.
	shipModule.apAbort(ship);
	shipModule.apCommitFollow(ship, target[0], 0, 0, 0, 0, 0, STAND_OFF_M);
	check('a follow keeps the pilot\'s rung (no destination coast warp)',
		shipModule.arcadeWarpYPerS(ship, 4) === 0);
}

{
	// The composition the page runs: the base rung + the warp, capped by the
	// four-second floor, stepped at 60 fps. The warp follows the *remaining*
	// ETA, so the rate falls with the distance — the terminal rule's own
	// shape. That is what keeps a long leg from becoming an overshoot cycle:
	// a constant commit-time rate (measured) sails a 40 ly target by ~4 ly in
	// a frame and never recovers; the decaying rate arrives in tens of
	// seconds. A far leg is bounded by the exponential tail, not by distance.
	function arcadeWall(ly) {
		const flight = shipModule.createShip('stardrive');
		const target = new Float64Array([ly * LY_KPC, 0, 0]);
		shipModule.setClockPreset(flight, 'arcade');
		const reason = shipModule.apCommitApproach(flight, target[0], 0, 0, 0, 0, 0, STAND_OFF_M);
		if (reason !== shipModule.AP_REASON_NONE) return { reason };
		const capY = shipModule.timeRateCapYPerS(flight.ap.etaS, 4);
		let wall = 0;
		while (wall < 60 && flight.ap.mode !== shipModule.AP_OFF) {
			let rate = shipModule.timeRateYPerS(flight, shipModule.speedC(flight));
			const warp = shipModule.arcadeWarpYPerS(flight, 4);
			if (warp > rate) rate = warp;
			if (rate > 0) rate = Math.min(rate, capY);
			shipModule.apStep(flight, rate * SEC_YEAR * AP_DT_WALL, AP_DT_WALL, target[0], 0, 0, 0, 0, 0);
			wall += AP_DT_WALL;
		}
		const dist = Math.hypot(target[0] - flight.pos[0], target[1] - flight.pos[1],
			target[2] - flight.pos[2]) * shipModule.KPC_M;
		return { wall, dist, arrived: flight.ap.reason === shipModule.AP_REASON_ARRIVED };
	}
	for (const ly of [1, 40]) {
		const r = arcadeWall(ly);
		check(`the arcade warp converges on a ${ly} ly target, not an overshoot cycle`,
			r.arrived && r.wall < 40, r);
	}
}

{
	// The presets themselves: SIM clears the warp and selects the real stop;
	// ARCADE snaps to the class's home rung and arms it. Both unfreeze.
	const ship = shipModule.createShip('stardrive');
	ship.timeFrozen = true;
	shipModule.setClockPreset(ship, 'sim');
	check('the SIM preset is the real stop, unfrozen, warp off',
		ship.timeIndex === shipModule.SHIP_TIME_REAL_INDEX && !ship.arcade && !ship.timeFrozen
			&& shipModule.formatClock(ship, 0) === 'real ×1');
	shipModule.setClockPreset(ship, 'arcade');
	check('the ARCADE preset snaps to the class home rung and arms the warp',
		ship.arcade && !ship.timeFrozen && ship.timeIndex === shipModule.homeTimeIndex(ship.class)
			&& shipModule.formatClock(ship, 0).startsWith('arcade +'));
	shipModule.setClass(ship, 'chemical');
	check('a class swap re-snaps the arcade clock to the new class home rung',
		ship.arcade && ship.timeIndex === shipModule.homeTimeIndex(ship.class),
		{ index: ship.timeIndex, home: shipModule.homeTimeIndex(ship.class) });
}

// --- 8. G2 chrome: the label layer's ship pass --------------------------------
// The pass runs on a recording context. Its placement is checked against the
// sprite shader's own projection (coords.projectToScreen), not against itself.
{
	const labelModule = require('../src/render/label-layer.js');
	const coords = require('../src/math/coords.js');
	const W = 800, H = 600;

	function recorder() {
		const log = { rects: [], arcs: [], segs: [], texts: [], cur: [0, 0], clears: 0 };
		const ctx = {
			lineWidth: 1, strokeStyle: '', fillStyle: '', font: '', textAlign: 'left', textBaseline: 'alphabetic',
			clearRect() { log.clears++; },
			setTransform() {},
			beginPath() {},
			moveTo(x, y) { log.cur[0] = x; log.cur[1] = y; },
			lineTo(x, y) { log.segs.push([log.cur[0], log.cur[1], x, y]); log.cur[0] = x; log.cur[1] = y; },
			arc(x, y, r) { log.arcs.push([x, y, r]); },
			rect(x, y, w, h) { log.rects.push([x, y, w, h]); },
			stroke() {},
			fill() {},
			fillText(t, x, y) { log.texts.push([t, x, y]); },
			strokeText(t, x, y) { log.texts.push([t, x, y]); },
		};
		return { ctx, log };
	}
	function sceneCamera() {
		const cam = cameraModule.createCamera();
		cam.step(1 / 60, { actions: {}, keys: {}, lookDx: 0, lookDy: 0, wheelDelta: 0 });
		return cam;
	}
	function pointAt(cam, fwd, right, up) {
		const p = new Float64Array(3);
		for (let k = 0; k < 3; k++) {
			p[k] = cam.cameraPos[k] + fwd * cam.forward[k] + right * cam.right[k] + up * cam.up[k];
		}
		return p;
	}
	function chromeState(over) {
		const s = labelModule.createShipChromeState();
		s.active = true;
		s.color = '#80e8ff';
		Object.assign(s, over || {});
		return s;
	}

	const cam = sceneCamera();
	{
		const { ctx, log } = recorder();
		const target = pointAt(cam, 1, 0.1, 0.05);
		labelModule.drawShipChrome(ctx, chromeState({ hasTarget: true, target, tagText: 'Sol 0.0 ly' }), cam, W, H);
		const out = new Float64Array(3);
		const visible = coords.projectToScreen(cam.buildViewProj(W / H), target[0], target[1], target[2],
			cam.cameraPos[0], cam.cameraPos[1], cam.cameraPos[2], W, H, out);
		const box = log.rects[0];
		check('the target frame lands where the sprite projection puts the star',
			visible && !!box && Math.abs(box[0] + 8 - out[0]) < 1e-3 && Math.abs(box[1] + 8 - out[1]) < 1e-3,
			{ box, expect: [out[0], out[1]] });
	}
	{
		const { ctx, log } = recorder();
		labelModule.drawShipChrome(ctx, chromeState({ hasAim: true, aim: Float64Array.from(cam.forward) }), cam, W, H);
		const arc = log.arcs[0];
		check('a burn straight down the view draws its marker on the crosshair',
			arc && Math.abs(arc[0] - W / 2) < 1e-6 && Math.abs(arc[1] - H / 2) < 1e-6, arc);
	}
	{
		const { ctx, log } = recorder();
		labelModule.drawShipChrome(ctx, chromeState({ hasAim: true, aim: Float64Array.from(cam.forward).map((v) => -v) }), cam, W, H);
		const arc = log.arcs[0];
		check('a nose dead astern pins upward, never onto the crosshair',
			arc && Math.abs(arc[0] - W / 2) < 1e-6 && arc[1] < H / 2 - 100, arc);
	}
	{
		const { ctx, log } = recorder();
		const target = pointAt(cam, -0.5, 0.1, 0);
		labelModule.drawShipChrome(ctx, chromeState({ hasTarget: true, target, tagText: 'behind' }), cam, W, H);
		const box = log.rects[0];
		check('a target behind the camera pins to the edge on the side to turn toward',
			box && box[0] + 8 > W / 2 && Math.abs(box[1] + 8 - H / 2) < 1e-6 && box[0] + 8 > W - 60,
			box);
	}
	{
		const { ctx, log } = recorder();
		labelModule.drawShipChrome(ctx, chromeState({ speed: 0.5, closing: 0 }), cam, W, H);
		const x = W / 2 - 160, level = H / 2;   // the tape spans cy ± 110; half of it is cy
		check('the velocity tape fills to the speed over the cap',
			log.segs.some((seg) => Math.abs(seg[0] - x) < 1e-9 && Math.abs(seg[3] - level) < 1e-9),
			log.segs.length);
	}
	{
		const { ctx, log } = recorder();
		labelModule.drawShipChrome(ctx, chromeState({ speed: 1.5 }), cam, W, H);
		const top = H / 2 - 110;
		check('a speed over the cap bleeds above the tape as one stub',
			log.segs.some((s) => Math.abs(s[0] - (W / 2 - 160)) < 1e-9 && Math.abs(s[1] - top) < 1e-9 && s[3] < top - 1));
	}
	{
		const { ctx, log } = recorder();
		labelModule.drawShipChrome(ctx, chromeState({ throttle: 0.5, fuel: 1 }), cam, W, H);
		const x0 = W / 2 - 120, y = H - 36;
		check('the throttle and fuel strip reads the applied burn and the tank',
			log.segs.some((s) => Math.abs(s[2] - (x0 + 120)) < 1e-9 && Math.abs(s[1] - y) < 1e-9)
			&& log.segs.some((s) => Math.abs(s[2] - (x0 + 240)) < 1e-9 && Math.abs(s[1] - (y + 10)) < 1e-9));
	}
	{
		// The layer draws the chrome with its labels off, and draws nothing when
		// the ship is not the rig.
		const canvasLog = recorder();
		const canvas = { width: 0, height: 0, getContext: () => canvasLog.ctx };
		const landmarks = { count: 0, positions: new Float32Array(0), ENTRIES: [] };
		const layer = labelModule.createLabelLayer(canvas, landmarks, { LINES: [] });
		layer.setEnabled(false);
		const state = chromeState({ hasTarget: true, target: pointAt(cam, 1, 0, 0), tagText: 'x' });
		layer.setShipChrome(state);
		layer.draw(cam, W, H);
		const drawn = canvasLog.log.rects.length;
		state.active = false;
		layer.draw(cam, W, H);
		const after = canvasLog.log.rects.length;
		check('the chrome draws with the labels off, and stops when the ship is not the rig',
			drawn === 1 && after === 1, { drawn, after });
	}
}

// --- 9. G4: docking, the port service and life support ----------------
// The dockable check's matrix, the commit's service effects, the
// ride (offset carried, station velocity copied, life frozen),
// the undock's rest-relative exit, the cargo law, the reset and
// class-swap clears, and the life-state ladder.
{
	// The dockable check: the frame-fixed refusal first,
	// then the shell band around the stand-off and the
	// settle threshold — both inclusive at the boundary.
	const shell = shipModule.DOCK_SHELL_M;
	check('the frame-fixed references are coordinates, not ports',
		shipModule.dockReason(0, 1e9, 0, false) === shipModule.DOCK_FIXED_POINT);
	check('a settled ship inside the shell docks',
		shipModule.dockReason(5e9, 5e9, 0, true) === shipModule.DOCK_OK);
	check('the shell band extends one arrival shell past the stand-off',
		shipModule.dockReason(5e9 + shell, 5e9, 0, true) === shipModule.DOCK_OK
		&& shipModule.dockReason(5e9 + shell * 1.0001, 5e9, 0, true) === shipModule.DOCK_OUTSIDE,
		{ shell });
	check('a moving ship does not dock',
		shipModule.dockReason(5e9, 5e9, shipModule.DOCK_REL_MS, true) === shipModule.DOCK_OK
		&& shipModule.dockReason(5e9, 5e9, shipModule.DOCK_REL_MS * 1.0001, true) === shipModule.DOCK_UNSETTLED);

	// The commit: the service, the registry and the ride offset.
	const s = shipModule.createShip('fusion');
	s.dvSpent = 1e6;
	s.lifeSpent = 10 * shipModule.SECONDS_PER_YEAR;
	s.ap.mode = shipModule.AP_APPROACH;   // a dock ends any flight
	const offset = [1e6, 2e6, -3e6];
	check('the dock commits the service and the registry',
		shipModule.dock(s, 12345, 'Sirius', offset[0], offset[1], offset[2])
		&& s.docked && s.dvSpent === 0 && s.lifeSpent === 0
		&& s.station.key === 12345 && s.station.name === 'Sirius'
		&& s.home.kind === 'star' && s.home.key === 12345
		&& s.ap.mode === shipModule.AP_OFF
		&& s.dockOffset[0] === offset[0] && s.dockOffset[1] === offset[1]
		&& s.dockOffset[2] === offset[2],
		{ docked: s.docked, dvSpent: s.dvSpent, lifeSpent: s.lifeSpent, home: s.home });

	// The ride: the station's drawn position and physical
	// velocity, copied; life does not accrue at the port.
	shipModule.dockStep(s, 10, 20, 30, 0.001, 0, 0);
	check('the ride copies the station pose and freezes life support',
		s.pos[0] === 10 + offset[0] && s.pos[1] === 20 + offset[1]
		&& s.pos[2] === 30 + offset[2]
		&& s.vel[0] === 0.001 && s.vel[1] === 0 && s.vel[2] === 0
		&& s.lifeSpent === 0,
		{ pos: [s.pos[0], s.pos[1], s.pos[2]], vel: [s.vel[0], s.vel[1], s.vel[2]] });
	shipModule.dockStep(s, 10.5, 20, 30, 0.002, 0, 0);
	check('the ride carries the offset as the station drifts',
		s.pos[0] === 10.5 + offset[0] && s.vel[0] === 0.002, s.pos[0]);

	// Undock leaves the ship at rest relative to the port.
	shipModule.undock(s);
	check('undock clears the dock and keeps the station velocity',
		!s.docked && s.station === null && s.vel[0] === 0.002, s.vel[0]);

	// The cargo law: the hold fills and empties at the dock only.
	const c = shipModule.createShip('stardrive');
	check('the hold starts empty and the class caps it',
		c.cargo === 0 && c.class.cargo === 20000, c.class.cargo);
	check('cargo refuses to move undocked',
		!shipModule.loadCargo(c) && !shipModule.unloadCargo(c) && c.cargo === 0);
	shipModule.dock(c, 1, 'port', 0, 0, 0);
	check('load fills to the class capacity, unload empties',
		shipModule.loadCargo(c) && c.cargo === c.class.cargo
		&& shipModule.unloadCargo(c) && c.cargo === 0, c.cargo);

	// Reset and the class swap clear the docked state and the
	// hold; the registry home persists (session state, like
	// the fleet).
	shipModule.loadCargo(c);
	shipModule.resetShip(c);
	check('R clears the dock and the hold',
		!c.docked && c.station === null && c.cargo === 0);
	shipModule.dock(c, 7, 'vega', 1, 1, 1);
	shipModule.setClass(c, 'chemical');
	check('the hangar swap clears the dock and empties the new hull',
		!c.docked && c.cargo === 0 && c.home.kind === 'star' && c.home.key === 7);

	// The life ladder: the warn band, expiry, and the
	// generation ship that cannot expire.
	const l = shipModule.createShip('chemical');   // 2 y
	check('life support reads exact and starts ok',
		shipModule.lifeState(l) === shipModule.LIFE_OK
		&& shipModule.lifeRemainingY(l) === 2);
	l.lifeSpent = 1.8 * shipModule.SECONDS_PER_YEAR;   // 0.2 y left: the band edge
	check('the warn band is 10% of the class life, inclusive',
		shipModule.lifeWarnY(l) === 0.2
		&& shipModule.lifeState(l) === shipModule.LIFE_CRITICAL);
	l.lifeSpent = 1.99 * shipModule.SECONDS_PER_YEAR;
	check('inside the band still reads critical',
		Math.abs(shipModule.lifeRemainingY(l) - 0.01) < 1e-9
		&& shipModule.lifeState(l) === shipModule.LIFE_CRITICAL);
	l.lifeSpent = 2 * shipModule.SECONDS_PER_YEAR;
	check('life support expires at zero',
		shipModule.lifeRemainingY(l) === 0
		&& shipModule.lifeState(l) === shipModule.LIFE_EXPIRED);
	const g = shipModule.createShip('generation');
	g.lifeSpent = 1e12;
	check('a generation ship never expires',
		shipModule.lifeRemainingY(g) === Infinity
		&& shipModule.lifeState(g) === shipModule.LIFE_OK);

	// The dock restores both clocks — the station refill
	// and the life-support service are one commit.
	l.lifeSpent = 2 * shipModule.SECONDS_PER_YEAR;
	l.dvSpent = l.dvMax;
	shipModule.dock(l, 9, 'sirius', 0, 0, 0);
	check('the station refill re-arms the tank and restores life',
		l.dvSpent === 0 && l.lifeSpent === 0
		&& shipModule.lifeState(l) === shipModule.LIFE_OK);

	// The hangar refill (G1) is not the station refill:
	// it re-arms the tank only, wherever the ship is.
	const h = shipModule.createShip('chemical');
	h.lifeSpent = 2 * shipModule.SECONDS_PER_YEAR;
	shipModule.refuel(h);
	check('the hangar refill does not restore life support',
		h.dvSpent === 0 && shipModule.lifeState(h) === shipModule.LIFE_EXPIRED);
}

// --- Report ----------------------------------------------------------------
{
	let passed = 0;
	for (const c of checks) {
		if (c.pass) passed++;
		else console.error('FAIL ' + c.name + (c.detail !== null && c.detail !== undefined ? '  -> ' + JSON.stringify(c.detail) : ''));
	}
	const summary = { total: checks.length, passed, failed: checks.length - passed, checks };
	logFile.writeLog(path.join(__dirname, 'logs', 'ship.json'), summary);
	console.log(`ship: ${passed}/${checks.length} passed`);
	if (passed !== checks.length) {
		console.log('\n=== VERDICT ===');
		console.log(`FAIL — ${checks.length - passed} checks failed`);
		process.exit(1);
	}
	console.log('\n=== VERDICT ===');
	console.log('PASS');
}
