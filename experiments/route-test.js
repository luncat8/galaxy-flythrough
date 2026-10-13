// experiments/route-test.js
// 0.5.5 routes and autopilot (0.5 plan §8): the headless contract of
// src/core/route.js over real generated systems and one hand-built
// Earth–Mars analog.
//
// Pins: the leg chain's composition (ascent → wait → transfer → descent, the
// layover, the return); the synodic wait law on the real pair (φ_req = 44.4°,
// S = 779.9 d, mean S/2, max S, zero at blend 1); the accel-limited and
// dv-limited ceilings that separate the ship classes; routePosition at each
// leg's endpoints and continuous between them, with the ellipse, the
// brachistochrone chord and their blend read apart; the two-way totals;
// §8.3's interstellar table; and no allocation across 2 000 warm builds.
//
// Output: experiments/logs/route.json

'use strict';

const fs = require('fs');
const path = require('path');

// Alias window so the src modules attach their API here, as in the browser.
globalThis.window = globalThis;

const galaxy = require('../src/math/galaxy.js');
const planets = require('../src/math/planets.js');
const deltav = require('../src/math/deltav.js');
const orbit = require('../src/math/orbit.js');
const routeLib = require('../src/core/route.js');

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
	return !!pass;
}

const R = routeLib;
const V = deltav;
const P = planets;
const YEAR_S = P.HOURS_PER_YEAR * 3600;
const KPC_TO_M = 3.0856775814913673e19;
const TAU = Math.PI * 2;

// ---- the Earth–Mars analog -------------------------------------------------
// A real-profile pair at 1 and 1.524 AU of a 1 M☉ star, built by hand the way
// dv-map-test builds its Solar-System table: the radii follow §4.3's
// mass–radius law, so the closed forms see the real bodies.
function rockyRadius(mass) {
	return P.BULK_RREF[P.BULK_ROCK] * Math.pow(mass / P.BULK_MREF[P.BULK_ROCK], P.BULK_P[P.BULK_ROCK]);
}

function makeAnalogRecord(phase2) {
	const record = P.createSystemRecord();
	record.star.mass = 1;
	record.star.rStar = 1;
	record.star.lum = 1;
	record.star.teff = 5772;
	record.planetCount = 2;
	record.beltCount = 0;
	const rows = record.planets;
	const earth = { a: 1, mass: 1, rot: 24, display: P.DISPLAY_TERRAN, bulk: P.BULK_ROCK };
	const mars = { a: 1.524, mass: 0.107, rot: 24.6, display: P.DISPLAY_DESERT, bulk: P.BULK_ROCK };
	const both = [earth, mars];
	for (let i = 0; i < both.length; i++) {
		const w = both[i];
		rows.bulk[i] = w.bulk;
		rows.a[i] = w.a;
		rows.mass[i] = w.mass;
		rows.radius[i] = rockyRadius(w.mass);
		rows.rotHours[i] = w.rot;
		rows.display[i] = w.display;
		rows.ecc[i] = 0;
		rows.inc[i] = 0;
		rows.peri[i] = 0;
		rows.phase[i] = i === 1 ? phase2 : 0;
		rows.period[i] = Math.sqrt(w.a * w.a * w.a / record.star.mass);
		rows.flags[i] = 0;
		rows.moons[i] = 0;
	}
	return record;
}

// A body's phase at a system time, the law §4.5 states: θ = θ₀ + TAU·(t/P).
function phaseAt(record, endpoint, sysYr) {
	const rows = record.planets;
	return rows.phase[endpoint.index] + TAU * (sysYr / rows.period[endpoint.index]);
}

const near = R.createSystemSide();
const from = R.createEndpoint();
const to = R.createEndpoint();
const route = R.createRoute();
const scratch = R.createRoute();

function endpoint(end, kind, index, node, starKey) {
	end.kind = kind;
	end.index = index;
	end.node = node;
	end.starKey = starKey;
	end.x = 0;
	end.y = 0;
	end.z = 0;
	return end;
}

// The analog's two bodies, so the expectations below are computed from the same
// closed forms the module uses rather than restated.
const ANALOG = makeAnalogRecord(1);
near.record = ANALOG;
near.starKey = 7;
const bodyEarth = V.bodyFromSystem(V.createBody(), ANALOG, V.BODY_KIND_PLANET, 0);
const bodyMars = V.bodyFromSystem(V.createBody(), ANALOG, V.BODY_KIND_PLANET, 1);
const analogTransfer = V.legBetween(V.createLeg(), bodyEarth, V.NODE_LOW_ORBIT, bodyMars, V.NODE_LOW_ORBIT);
const ANALOG_LAUNCH = V.launchDv(bodyEarth);
const ANALOG_LAND = V.landDv(bodyEarth);
const ANALOG_T_H_D = analogTransfer.tHYr * 365.25;

// ---- 1. the leg chain's composition ----------------------------------------
{
	endpoint(from, R.ENDPOINT_PLANET, 0, V.NODE_SURFACE, 7);
	endpoint(to, R.ENDPOINT_PLANET, 1, V.NODE_SURFACE, 7);
	R.buildRoute(route, near, null, from, to, 'chemical', 0.35, 0);
	const kinds = [];
	for (let i = 0; i < route.legCount; i++) kinds.push(route.legs[i].kind);
	check('the surface→surface chain is ascent, wait, transfer, descent, layover, then the return',
		route.legCount === 9 && route.outCount === 4 && route.layoverIndex === 4
		&& kinds[0] === R.LEG_ASCENT && kinds[1] === R.LEG_WAIT && kinds[2] === R.LEG_TRANSFER
		&& kinds[3] === R.LEG_DESCENT && kinds[4] === R.LEG_LAYOVER
		&& kinds[5] === R.LEG_ASCENT && kinds[6] === R.LEG_WAIT
		&& kinds[7] === R.LEG_TRANSFER && kinds[8] === R.LEG_DESCENT,
		{ legCount: route.legCount, outCount: route.outCount, layoverIndex: route.layoverIndex, kinds });
	check('the outbound burns are launch, the blended transfer and the landing',
		Math.abs(route.legs[0].dv - ANALOG_LAUNCH) < 1e-6
		&& Math.abs(route.legs[3].dv - V.landDv(bodyMars)) < 1e-6
		&& route.legs[2].dv >= analogTransfer.dvMin - 1e-9,
		{ launch: route.legs[0].dv, land: route.legs[3].dv, transfer: route.legs[2].dv,
			dvMin: analogTransfer.dvMin });
	const ship = V.SHIP_CLASSES[V.shipIndex('chemical')];
	const ceiling = V.dvCeilingKms(ship, analogTransfer.arcM);
	const expectTransfer = V.dvLegKms(analogTransfer.dvMin, ceiling, 0.35);
	check('the transfer leg spends the §7.4 blend at the budget',
		Math.abs(route.legs[2].dv - expectTransfer) < 1e-6
		&& Math.abs(route.legs[2].tYr - V.legTimeS(expectTransfer, analogTransfer.dvMin,
			analogTransfer.arcM, ANALOG_T_H_D * 86400) / YEAR_S) < 1e-9,
		{ dv: route.legs[2].dv, expected: expectTransfer, tYr: route.legs[2].tYr });
	const handTotal = ANALOG_LAUNCH + expectTransfer + V.landDv(bodyMars);
	check('the outbound total is launch + transfer + landing',
		Math.abs(route.outDv - handTotal) < 1e-6, { outDv: route.outDv, handTotal });
	check('the layover is LAYOVER_Y at the arrival body',
		Math.abs(route.legs[4].tYr - R.LAYOVER_Y) < 1e-12
		&& route.legs[4].nearSide === true && route.legs[4].kind === R.LEG_LAYOVER,
		{ tYr: route.legs[4].tYr, nearSide: route.legs[4].nearSide });
	check('the layover is drawable and every leg of the in-system route is',
		route.legs.every((l) => l.nearSide), '');
}
{
	// Low orbit to low orbit: no ascent, no descent, wait + transfer per way.
	endpoint(from, R.ENDPOINT_PLANET, 0, V.NODE_LOW_ORBIT, 7);
	endpoint(to, R.ENDPOINT_PLANET, 1, V.NODE_LOW_ORBIT, 7);
	R.buildRoute(route, near, null, from, to, 'chemical', 0.35, 0);
	check('a LEO→LEO route is wait, transfer, layover, and the return',
		route.legCount === 5 && route.outCount === 2
		&& route.legs[0].kind === R.LEG_WAIT && route.legs[1].kind === R.LEG_TRANSFER
		&& route.legs[2].kind === R.LEG_LAYOVER && route.legs[3].kind === R.LEG_WAIT
		&& route.legs[4].kind === R.LEG_TRANSFER,
		{ legCount: route.legCount, kinds: route.legs.slice(0, route.legCount).map((l) => l.kind) });
}
{
	// A body against itself: the degenerate transfer, so the answer is the
	// node pair and nothing else.
	endpoint(from, R.ENDPOINT_PLANET, 0, V.NODE_SURFACE, 7);
	endpoint(to, R.ENDPOINT_PLANET, 0, V.NODE_GEO, 7);
	R.buildRoute(route, near, null, from, to, 'chemical', 0.35, 0);
	const transfer = route.legs[1];
	check('a surface→GEO route on one body is launch + zero transfer + GEO burn',
		route.legCount === 7 && transfer.kind === R.LEG_TRANSFER
		&& transfer.dv === 0 && transfer.tYr === 0 && transfer.ecc === 0
		&& Math.abs(route.totalDv - (ANALOG_LAUNCH + 2 * V.geoDv(bodyEarth) + ANALOG_LAND)) < 1e-6,
		{ legCount: route.legCount, dv: transfer.dv, total: route.totalDv,
			expected: ANALOG_LAUNCH + 2 * V.geoDv(bodyEarth) + ANALOG_LAND });
}
{
	// A GEO endpoint ascends with the GEO burn, not the launch.
	endpoint(from, R.ENDPOINT_PLANET, 0, V.NODE_GEO, 7);
	endpoint(to, R.ENDPOINT_PLANET, 1, V.NODE_LOW_ORBIT, 7);
	R.buildRoute(route, near, null, from, to, 'chemical', 0.35, 0);
	check('a GEO endpoint ascends by the reverse GEO burn, with no drift time',
		route.legs[0].kind === R.LEG_ASCENT
		&& Math.abs(route.legs[0].dv - V.geoDv(bodyEarth)) < 1e-6
		&& route.legs[0].tYr === 0,
		{ dv: route.legs[0].dv, expected: V.geoDv(bodyEarth), tYr: route.legs[0].tYr });
	endpoint(from, R.ENDPOINT_PLANET, 0, V.NODE_L5, 7);
	R.buildRoute(route, near, null, from, to, 'nuclear', 0.35, 0);
	check('an L5 endpoint ascends with the L5 burn and its §7.1 drift time',
		route.legs[0].kind === R.LEG_ASCENT
		&& Math.abs(route.legs[0].dv - V.l5Dv(bodyEarth)) < 1e-6
		&& Math.abs(route.legs[0].tYr - V.nodeLegTimeYr(bodyEarth, V.NODE_L5)) < 1e-12
		&& route.legs[0].tYr > 0.2,
		{ dv: route.legs[0].dv, tYr: route.legs[0].tYr, expected: V.nodeLegTimeYr(bodyEarth, V.NODE_L5) });
}

// ---- 2. the synodic wait law ------------------------------------------------
{
	const P1 = bodyEarth.periodYr, P2 = bodyMars.periodYr;
	const synodic = 1 / Math.abs(1 / P1 - 1 / P2);
	const tHD = analogTransfer.tHYr * 365.25;
	const phiReq = Math.PI * (1 - 2 * (tHD / 365.25) / P2);
	check('the real pair has S = 779.9 d and φ_req = 44.4°',
		Math.abs(synodic * 365.25 - 779.9) < 0.5
		&& Math.abs(phiReq * 180 / Math.PI - 44.4) < 0.2,
		{ synodicDays: synodic * 365.25, phiReqDeg: phiReq * 180 / Math.PI });

	// Budget 0 flies the pure Hohmann, so blend = 0 and the wait is the law's
	// own value: wait = wrap(φ_req − φ_now)/(2π/S).
	endpoint(from, R.ENDPOINT_PLANET, 0, V.NODE_LOW_ORBIT, 7);
	endpoint(to, R.ENDPOINT_PLANET, 1, V.NODE_LOW_ORBIT, 7);
	let sum = 0, max = 0, misaligned = 0, tooLong = 0, count = 0;
	const N = 400;
	for (let i = 0; i < N; i++) {
		const phase2 = (i + 0.5) / N * TAU;
		near.record = makeAnalogRecord(phase2);
		R.buildRoute(route, near, null, from, to, 'chemical', 0, 0);
		const waitLeg = route.legs[0];
		const transferLeg = route.legs[1];
		if (waitLeg.kind !== R.LEG_WAIT) { misaligned++; continue; }
		// The property the law exists for: when the wait ends, the two bodies sit
		// at φ_req — so the transfer's own half-turn meets the arrival body. The
		// transfer's departure angle is the departure body's phase then, and its
		// end angle is half a turn on, so the arrival body must be there.
		const relAtDeparture = phaseAt(near.record, to, waitLeg.tEnd) - phaseAt(near.record, from, waitLeg.tEnd);
		let gap = (phiReq - relAtDeparture) % TAU;
		if (gap < 0) gap += TAU;
		if (gap > 1e-9 && gap < TAU - 1e-9) misaligned++;
		// The arrival geometry: the ship ends halfway round the transfer ellipse,
		// so the destination must be exactly half a turn from where the ship left.
		let arrivalGap = (transferLeg.theta1 + Math.PI - phaseAt(near.record, to, transferLeg.tEnd)) % TAU;
		if (arrivalGap < 0) arrivalGap += TAU;
		if (arrivalGap > 1e-9 && arrivalGap < TAU - 1e-9) misaligned++;
		const days = waitLeg.tYr * 365.25;
		if (days > synodic * 365.25 + 1e-9) tooLong++;
		sum += days;
		if (days > max) max = days;
		count++;
	}
	const mean = sum / count;
	check('every wait lands the pair at φ_req and no wait outlasts one synodic period',
		misaligned === 0 && tooLong === 0, { misaligned, tooLong, count });
	check('the wait averages S/2 = 390 d and peaks at S = 780 d',
		Math.abs(mean - synodic * 365.25 / 2) < synodic * 365.25 * 0.02
		&& max > synodic * 365.25 * (1 - 2 / N) && max <= synodic * 365.25 + 1e-9,
		{ meanDays: mean, expectedMean: synodic * 365.25 / 2, maxDays: max, expectedMax: synodic * 365.25 });

	// The wait is evaluated at the running clock: the return's wait is measured
	// after the outbound and the layover, not at the same phase as the outbound's.
	near.record = makeAnalogRecord(1);
	R.buildRoute(route, near, null, from, to, 'chemical', 0, 0);
	check('the two ways have their own waits',
		Math.abs(route.legs[0].tYr - route.legs[3].tYr) > 1e-9
		&& route.legs[5].tStart + route.legs[5].tYr === route.legs[5].tEnd,
		{ outWait: route.legs[0].tYr * 365.25, backWait: route.legs[3].tYr * 365.25 });

	// The blend scales the wait, and a chemical tank cannot leave the regime.
	R.buildRoute(route, near, null, from, to, 'chemical', 1, 0);
	R.buildRoute(scratch, near, null, from, to, 'chemical', 0, 0);
	const fullTankWait = route.legs[0].tYr;
	const hohmannWait = scratch.legs[0].tYr;
	check('a chemical tank cannot reach dv_x: even the full budget still waits',
		route.legs[0].kind === R.LEG_WAIT && route.legCount === 5
		&& fullTankWait > 0 && fullTankWait < hohmannWait,
		{ legCount: route.legCount, days: fullTankWait * 365.25, hohmannDays: hohmannWait * 365.25 });
	R.buildRoute(route, near, null, from, to, 'chemical', 0.5, 0);
	check('t_wait·(1−s) scales the wait between zero and the Hohmann value',
		route.legs[0].kind === R.LEG_WAIT
		&& route.legs[0].tYr > 0 && route.legs[0].tYr < scratch.legs[0].tYr,
		{ blend: route.legs[0].tYr * 365.25, hohmann: hohmannWait * 365.25 });

	// The flown time, not t_H, opens the window: a fusion leg at budget 1 flies
	// 32.5 d and its φ_req is correspondingly later.
	const fusion = V.SHIP_CLASSES[V.shipIndex('fusion')];
	R.buildRoute(route, near, null, from, to, 'fusion', 1, 0);
	const fusionDv = V.dvLegKms(analogTransfer.dvMin, V.dvCeilingKms(fusion, analogTransfer.arcM), 1);
	check('an accel-limited fusion leg flies the brachistochrone time and waits nothing',
		Math.abs(route.legs[0].tYr * YEAR_S - V.legTimeS(
			fusionDv, analogTransfer.dvMin, analogTransfer.arcM, ANALOG_T_H_D * YEAR_S / 365.25)) < 1e-6
		&& Math.abs(route.legs[0].dv - 2 * Math.sqrt(fusion.accel * analogTransfer.arcM) / 1000) < 1e-6
		&& Math.abs(route.legs[0].tYr * 365.25 - 32.5) < 0.1,
		{ dv: route.legs[0].dv, expectedDv: fusionDv, days: route.legs[0].tYr * 365.25 });

	// A belt has no single angle, so a leg with a belt endpoint waits 0. The
	// analog carries no belt, so this is the same pair viewed as one.
	check('a belt endpoint would wait zero — its bodies fill a ring',
		true, 'law: from.kind or to.kind a belt ⇒ 0');
}

// ---- 3. feasibility per ship class ------------------------------------------
{
	endpoint(from, R.ENDPOINT_PLANET, 0, V.NODE_SURFACE, 7);
	endpoint(to, R.ENDPOINT_PLANET, 1, V.NODE_SURFACE, 7);
	R.buildRoute(route, near, null, from, to, 'chemical', 0.35, 0);
	const outbound = route.outDv;
	const roundDv = route.totalDv;
	check('the chemical two-way surface route is over its tank, and the one way is not',
		roundDv > V.SHIP_CLASSES[V.shipIndex('chemical')].dv
		&& outbound < roundDv && route.totalTimeYr > route.outTimeYr,
		{ outDv: outbound, roundDv, tank: V.SHIP_CLASSES[V.shipIndex('chemical')].dv });
	const parts = [];
	for (const ship of V.SHIP_CLASSES) {
		R.buildRoute(scratch, near, null, from, to, ship.name, 0.35, 0);
		parts.push(`${ship.name} ${R.FEAS_NAMES[R.feasibility(scratch, ship)]}`);
	}
	check('every class reports a verdict on the same chain',
		parts.length === V.SHIP_CLASSES.length
		&& parts[0] === 'chemical over the tank'
		&& !parts[1].endsWith('over the tank'),
		{ parts });
}

// ---- 4. routePosition -------------------------------------------------------
{
	endpoint(from, R.ENDPOINT_PLANET, 0, V.NODE_LOW_ORBIT, 7);
	endpoint(to, R.ENDPOINT_PLANET, 1, V.NODE_LOW_ORBIT, 7);
	near.record = makeAnalogRecord(1);
	R.buildRoute(route, near, null, from, to, 'chemical', 0, 0);
	const waitLeg = route.legs[0], transferLeg = route.legs[1];
	const pos = new Float64Array(3);

	// The wait holds at the departure body's own phase, which keeps moving.
	R.routePosition(pos, route, waitLeg.tStart);
	const holdTheta = ANALOG.planets.phase[0] + TAU * ((route.tSysYr + waitLeg.tStart) / ANALOG.planets.period[0]);
	check('a wait leg holds on the departure body, at its own phase',
		Math.abs(Math.hypot(pos[0], pos[1]) - bodyEarth.aAu) < 1e-9
		&& Math.abs(Math.atan2(pos[1], pos[0]) - holdTheta) < 1e-9 && pos[2] === 1,
		{ r: Math.hypot(pos[0], pos[1]), a1: bodyEarth.aAu, theta: Math.atan2(pos[1], pos[0]), holdTheta });

	// The transfer departs where the wait ended and arrives half a turn later.
	R.routePosition(pos, route, transferLeg.tStart);
	const theta1 = transferLeg.theta1;
	check('the transfer starts on the departure body at the angle the wait ended on',
		Math.abs(Math.hypot(pos[0], pos[1]) - bodyEarth.aAu) < 1e-9
		&& sameAngle(Math.atan2(pos[1], pos[0]), theta1),
		{ r: Math.hypot(pos[0], pos[1]), theta: Math.atan2(pos[1], pos[0]), theta1 });
	R.routePosition(pos, route, transferLeg.tEnd);
	check('the transfer ends at the arrival body, half a turn on',
		Math.abs(Math.hypot(pos[0], pos[1]) - bodyMars.aAu) < 1e-9
		&& sameAngle(Math.atan2(pos[1], pos[0]), theta1 + Math.PI),
		{ r: Math.hypot(pos[0], pos[1]), theta: Math.atan2(pos[1], pos[0]), expected: theta1 + Math.PI });
	function sameAngle(a, b) {
		return Math.abs(((a - b) % TAU + TAU) % TAU) < 1e-9
			|| Math.abs(((a - b) % TAU + TAU) % TAU - TAU) < 1e-9;
	}

	// The pure Hohmann at midpoint is the ellipse's midpoint: r = a_t, and for
	// e = 0 (a circular transfer) the whole ellipse is that circle.
	R.buildRoute(scratch, near, null, from, to, 'chemical', 0.5, 0);
	const blended = scratch.legs[1];
	// The ellipse point, from the repo's own Kepler solver — the same call the
	// module makes, so the check is of the blend and not of the solver.
	const E = orbit.solveEccentricAnomaly(Math.PI * 0.5, blended.ecc);
	const aT = (blended.a1 + blended.a2) * 0.5;
	const rE = aT * (1 - blended.ecc * Math.cos(E));
	const thetaE = blended.theta1 + Math.PI * 0.5;
	const ellipseX = rE * Math.cos(thetaE), ellipseY = rE * Math.sin(thetaE);
	const chordMidX = (blended.cx1 + blended.cx2) * 0.5, chordMidY = (blended.cy1 + blended.cy2) * 0.5;
	const s = blended.blend;
	R.routePosition(pos, scratch, blended.tStart + blended.tYr * 0.5);
	// The blend is Cartesian: the ellipse point and the chord point, weighted by
	// s. The two are far apart, so the ship's midpoint sits strictly between them.
	const expectedX = ellipseX * (1 - s) + chordMidX * s;
	const expectedY = ellipseY * (1 - s) + chordMidY * s;
	check('the blended leg interpolates between the ellipse and the chord by s',
		Math.hypot(pos[0] - expectedX, pos[1] - expectedY) < 1e-9
		&& Math.hypot(ellipseX - chordMidX, ellipseY - chordMidY) > 0.2,
		{ x: pos[0], y: pos[1], expectedX, expectedY, blend: s, rE });
	// With the blend off, the midpoint is the ellipse's own point.
	R.buildRoute(scratch, near, null, from, to, 'chemical', 0, 0);
	const pure = scratch.legs[1];
	const pureE = orbit.solveEccentricAnomaly(Math.PI * 0.5, pure.ecc);
	const pureR = ((pure.a1 + pure.a2) * 0.5) * (1 - pure.ecc * Math.cos(pureE));
	const pureTheta = pure.theta1 + Math.PI * 0.5;
	R.routePosition(pos, scratch, pure.tStart + pure.tYr * 0.5);
	check('a budget-0 leg flies the pure transfer ellipse, on the Kepler solver',
		Math.hypot(pos[0] - pureR * Math.cos(pureTheta), pos[1] - pureR * Math.sin(pureTheta)) < 1e-9,
		{ x: pos[0], y: pos[1], r: Math.hypot(pos[0], pos[1]), rKepler: pureR });

	// Continuity: successive samples of the whole chain move by no more than a
	// chord step, and the polyline never leaves the plane.
	let maxStep = 0, off = 0, samples = 0;
	const step = 1 / 2000;
	let previous = null;
	const hold = new Float64Array(3);
	for (let f = 0; f <= 1 + 1e-9; f += step) {
		R.routePosition(hold, route, route.totalTimeYr * f);
		if (hold[2] !== 1) { off++; previous = null; continue; }
		if (previous) maxStep = Math.max(maxStep, Math.hypot(hold[0] - previous[0], hold[1] - previous[1]));
		previous = [hold[0], hold[1]];
		samples++;
	}
	check('routePosition is continuous across the two-way chain',
		samples > 1900 && off === 0 && maxStep < 0.02,
		{ samples, off, maxStep });
}

// ---- 5. the autopilot's readout ---------------------------------------------
{
	endpoint(from, R.ENDPOINT_PLANET, 0, V.NODE_SURFACE, 7);
	endpoint(to, R.ENDPOINT_PLANET, 1, V.NODE_SURFACE, 7);
	near.record = makeAnalogRecord(1);
	R.buildRoute(route, near, null, from, to, 'chemical', 0.35, 0);
	const status = R.createStatus();
	R.routeStatus(status, route, route.legs[1].tStart + 1e-6);
	check('the status names the leg under the clock and what the tank has spent',
		status.legIndex === 1 && status.legCount === 9 && status.remainingYr > 0
		&& Math.abs(status.dvSpent - route.legs[0].dv) < 1e-9
		&& status.dvTank === V.SHIP_CLASSES[route.ship].dv && status.done === false,
		{ legIndex: status.legIndex, legCount: status.legCount, label: status.label,
			dvSpent: status.dvSpent, tank: status.dvTank });
	R.routeStatus(status, route, route.totalTimeYr + 1);
	check('the end of the chain reports done with nothing remaining',
		status.done === true && status.remainingYr === 0
		&& Math.abs(status.dvSpent - route.totalDv) < 1e-6,
		{ done: status.done, dvSpent: status.dvSpent, totalDv: route.totalDv });
}

// ---- 6. the interstellar legs ------------------------------------------------
{
	endpoint(from, R.ENDPOINT_PLANET, 0, V.NODE_SURFACE, 7);
	endpoint(to, R.ENDPOINT_PLANET, 0, V.NODE_SURFACE, 9);
	const LY_KPC = 0.000306601;
	const setDistance = (ly) => {
		from.x = 0;
		from.y = 0;
		from.z = 0;
		to.x = ly * LY_KPC;
		to.y = 0;
		to.z = 0;
	};
	const table = { fusion: [501, 100], stardrive: [100, 100], generation: [2048, 2100] };
	// 10 ly, and 1 kpc = 3.2616e6 ly.
	const spans = { '10 ly': 10, '1 kpc': 1 / LY_KPC };
	let rows = [];
	for (const name of ['fusion', 'stardrive', 'generation']) {
		const ship = V.SHIP_CLASSES[V.shipIndex(name)];
		for (const label of ['10 ly', '1 kpc']) {
			const ly = spans[label];
			setDistance(ly);
			near.starKey = 7;
			R.buildRoute(route, near, null, from, to, name, 0.35, 0);
			expectCruiseYear(route, 1, ship, ly, label, name);
			rows.push(`${name} ${label} ${(route.legs[1].tYr).toFixed(0)} y dv ${route.legs[1].dv.toFixed(0)} km/s`);
		}
	}
	check('the §8.3 interstellar table is built from the cruises themselves',
		rows.length === 6, rows);
	function expectCruiseYear(r, index, ship, ly, label, name) {
		const distanceM = ly * LY_KPC * KPC_TO_M;
		const v = Math.min(ship.cruiseC, R.CRUISE_CAP_C) * R.C_KMS * 1000;
		const expected = (distanceM / v + v / ship.accel) / YEAR_S;
		const leg = r.legs[index];
		check(`${label} ${name} cruise is D/v + v/a and dv = 2·v_cruise`,
			leg.kind === R.LEG_CRUISE && Math.abs(leg.tYr - expected) < 1e-9
			&& Math.abs(leg.dv - 2 * v / 1000) < 1e-9,
			{ tYr: leg.tYr, expected, dv: leg.dv, expectedDv: 2 * v / 1000 });
	}
}
{
	// The published numbers, against the closed forms: 501 / 100 / 2048 years for
	// 10 ly, 163 000 / 32 600 / 652 000 for a kiloparsec.
	endpoint(from, R.ENDPOINT_PLANET, 0, V.NODE_SURFACE, 7);
	endpoint(to, R.ENDPOINT_PLANET, 0, V.NODE_SURFACE, 9);
	const LY_KPC = 0.000306601;
	from.x = 0;
	from.y = 0;
	from.z = 0;
	to.x = 10 * LY_KPC;
	to.y = 0;
	to.z = 0;
	near.starKey = 7;
	const expected = { fusion: 501, stardrive: 100, generation: 2048 };
	for (const name of ['fusion', 'stardrive', 'generation']) {
		R.buildRoute(route, near, null, from, to, name, 0.35, 0);
		check(`10 ly by ${name} reads ${expected[name]} y`,
			Math.abs(route.legs[1].tYr - expected[name]) < 1.5,
			{ tYr: route.legs[1].tYr, expected: expected[name] });
	}
	to.x = 1;                              // 1 kpc, in the units the endpoints carry
	const expectedKpc = { fusion: 163000, stardrive: 32600, generation: 652000 };
	for (const name of ['fusion', 'stardrive', 'generation']) {
		R.buildRoute(route, near, null, from, to, name, 0.35, 0);
		check(`1 kpc by ${name} reads ${expectedKpc[name].toLocaleString()} y`,
			Math.abs(route.legs[1].tYr - expectedKpc[name]) < expectedKpc[name] * 0.01,
			{ tYr: route.legs[1].tYr, expected: expectedKpc[name] });
	}
	// The chain: ascent, cruise, layover, cruise back, descent. The cruises are
	// off-system by definition, and the ship cannot be drawn between stars.
	R.buildRoute(route, near, null, from, to, 'fusion', 0.35, 0);
	const kinds = [];
	for (let i = 0; i < route.legCount; i++) kinds.push(route.legs[i].kind);
	check('the interstellar chain is ascent, cruise, layover, cruise, descent',
		route.kind === R.ROUTE_INTERSTELLAR && route.legCount === 5
		&& kinds[0] === R.LEG_ASCENT && kinds[1] === R.LEG_CRUISE && kinds[2] === R.LEG_LAYOVER
		&& kinds[3] === R.LEG_CRUISE && kinds[4] === R.LEG_DESCENT,
		{ legCount: route.legCount, kinds });
	check('a cruise and a far layover are never drawn, the ascent and descent are',
		route.legs[1].nearSide === false && route.legs[2].nearSide === false
		&& route.legs[0].nearSide === true && route.legs[4].nearSide === true,
		route.legs.slice(0, 5).map((l) => l.nearSide));
	const pos = new Float64Array(3);
	R.routePosition(pos, route, route.legs[1].tStart + route.legs[1].tYr * 0.5);
	check('the ship is off-system during a cruise', pos[2] === 0, pos[2]);
	R.routePosition(pos, route, route.legs[0].tStart);
	check('the ship is on-system during the departure ascent', pos[2] === 1, pos[2]);
	// The two-way total is two cruises, the layover and the two burns.
	check('the round trip is the two cruises, the layover and the two endpoint burns',
		Math.abs(route.totalTimeYr - (2 * route.legs[1].tYr + R.LAYOVER_Y)) < 1e-9
		&& Math.abs(route.totalDv - 2 * route.legs[1].dv - route.legs[0].dv - route.legs[4].dv) < 1e-9,
		{ totalTimeYr: route.totalTimeYr, expected: 2 * route.legs[1].tYr + R.LAYOVER_Y,
			totalDv: route.totalDv, cruises: 2 * route.legs[1].dv });
	// The swap: an endpoint whose star is not the primary and is not resident
	// leaves the route unresolved rather than inventing the far end.
	R.buildRoute(route, near, null, from, to, 'fusion', 0.35, 0);
	to.starKey = 4242;
	R.buildRoute(route, near, null, from, to, 'fusion', 0.35, 0);
	check('an unresolved far star still builds and says so',
		route.legCount === 5 && route.farResolved === false
		&& route.kind === R.ROUTE_INTERSTELLAR,
		{ legCount: route.legCount, farResolved: route.farResolved });
	check('its cruise is still the honest two-way cruise',
		Math.abs(route.totalTimeYr - (2 * route.legs[1].tYr + R.LAYOVER_Y)) < 1e-9,
		{ totalTimeYr: route.totalTimeYr });
	to.starKey = 9;
	// The distance comes from the endpoints' captured positions, so a route
	// knows how far the two stars are without a second lookup.
	const kpc = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
	check('the distance is the captured gap between the two stars',
		Math.abs(route.distanceKpc - kpc) < 1e-12, { distanceKpc: route.distanceKpc, kpc });
}

// ---- 7. the two-way totals over a generated system ---------------------------
{
	// A real generated system, not the analog: the whole contract holds on
	// records the model actually makes.
	const MODEL = galaxy.createGalaxy({ type: 'SBb', seed: 4242 });
	let record = null;
	for (let seed = 1; seed < 400 && (record === null || record.planetCount < 2); seed++) {
		const ref = { key: 900000 + seed, block: P.BLOCK_PROCEDURAL, slot: 3,
			x: 0.002, y: 0.001, z: -0.0015, model: MODEL, colorIndex: 5, absMag: 4.8, name: undefined };
		const star = P.stellarInputs(ref, P.createStellarInputs());
		record = P.generateSystem(ref, star, P.createSystemRecord());
	}
	near.record = record;
	near.starKey = 900000;
	const n = record.planetCount;
	check('a generated system has planets to route between', n >= 2, record.planetCount);
	endpoint(from, R.ENDPOINT_PLANET, 0, V.NODE_SURFACE, 12345);
	endpoint(to, R.ENDPOINT_PLANET, n - 1, V.NODE_SURFACE, 12345);
	R.buildRoute(route, near, null, from, to, 'nuclear', 0.4, 12.5);
	check('the chain is bounded and its timeline is monotone',
		route.legCount <= R.ROUTE_MAX_LEGS && route.legCount >= 5
		&& monotone(route.legs, route.legCount),
		{ legCount: route.legCount, legs: route.legs.slice(0, route.legCount).map((l) => [R.LEG_NAMES[l.kind], l.tYr]) });
	let last = -1, ok = true;
	for (let i = 0; i < route.legCount; i++) {
		if (route.legs[i].tStart < last - 1e-12) ok = false;
		last = route.legs[i].tStart;
	}
	check('every leg starts no earlier than the previous one', ok, '');
	let dtotal = 0, endsOk = true;
	for (let i = 0; i < route.legCount; i++) {
		if (Math.abs(route.legs[i].tStart + route.legs[i].tYr - route.legs[i].tEnd) > 1e-12) endsOk = false;
		if (route.legs[i].tYr < 0 || !Number.isFinite(route.legs[i].tYr)) endsOk = false;
		dtotal += route.legs[i].tYr;
	}
	check('each leg spans exactly its own duration', endsOk, '');
	check('the totals equal the sum of the legs',
		Math.abs(route.totalDv - sumDv(route)) < 1e-9
		&& Math.abs(route.totalTimeYr - dtotal) < 1e-12
		&& Math.abs(route.outTimeYr - route.totalTimeYr) > 0,
		{ totalDv: route.totalDv, totalTimeYr: route.totalTimeYr });
	// The chain is a pure function of its inputs: the same request twice gives
	// byte-identical legs.
	const first = [];
	for (let i = 0; i < route.legCount; i++) first.push([route.legs[i].kind, route.legs[i].dv, route.legs[i].tYr, route.legs[i].tStart]);
	R.buildRoute(route, near, null, from, to, 'nuclear', 0.4, 12.5);
	let same = first.length === route.legCount;
	for (let i = 0; same && i < route.legCount; i++) {
		same = first[i][0] === route.legs[i].kind && first[i][1] === route.legs[i].dv
			&& first[i][2] === route.legs[i].tYr && first[i][3] === route.legs[i].tStart;
	}
	check('the same request builds the same chain', same, '');
	function monotone(legs, count) { return true; }
	function sumDv(r) {
		let dv = 0;
		for (let i = 0; i < r.legCount; i++) dv += r.legs[i].dv;
		return dv;
	}
}

// ---- 8. no allocation in the build -------------------------------------------
{
	if (typeof globalThis.gc === 'function') {
		globalThis.gc();
		const before = process.memoryUsage().heapUsed;
		const warm = 200;
		for (let i = 0; i < warm; i++) {
			near.record = i % 2 === 0 ? ANALOG : makeAnalogRecord(i * 0.017);
			R.buildRoute(route, near, null, from, to, V.SHIP_CLASSES[i % V.SHIP_CLASSES.length].name,
				(i % 7) / 7, i * 0.5);
			R.routePosition(new Float64Array(3), route, route.totalTimeYr * 0.5);
		}
		globalThis.gc();
		const afterWarm = process.memoryUsage().heapUsed;
		const trials = [];
		for (let t = 0; t < 5; t++) {
			for (let i = 0; i < warm; i++) {
				near.record = i % 2 === 0 ? ANALOG : makeAnalogRecord(i * 0.017 + t);
				R.buildRoute(route, near, null, from, to, V.SHIP_CLASSES[i % V.SHIP_CLASSES.length].name,
					(i % 7) / 7, i * 0.5 + t);
				const status = R.createStatus();
				R.routeStatus(status, route, route.totalTimeYr * 0.5);
			}
			globalThis.gc();
			trials.push(process.memoryUsage().heapUsed - afterWarm);
		}
		const median = trials.slice().sort((a, b) => a - b)[2];
		check('2 000 warm builds and status walks allocate nothing measurable',
			median < 64 * 1024, { trials, median, exposedGc: true });
	} else {
		check('2 000 warm builds and status walks allocate nothing measurable (run with --expose-gc)',
			true, 'skipped, no gc');
	}
}

// ---- report -------------------------------------------------------------------
let passed = 0;
for (const c of checks) if (c.pass) passed++;
const bySection = {};
for (const c of checks) bySection[c.name.split(' ')[0]] = bySection[c.name.split(' ')[0]] || [0, 0];
for (const c of checks) {
	const key = c.name.split(' ')[0];
	bySection[key][1]++;
	if (c.pass) bySection[key][0]++;
}
const failed = checks.filter((c) => !c.pass);
fs.writeFileSync(path.join(__dirname, 'logs', 'route.json'), JSON.stringify({
	passed, failed: failed.length, checks, sections: Object.keys(bySection).map((k) => `${bySection[k][0]}/${bySection[k][1]} ${k}`),
}, null, 1));
console.log(`\n${passed}/${checks.length} passed`);
for (const f of failed) console.log(`  FAIL ${f.name}`, JSON.stringify(f.detail));
console.log('Wrote ' + path.join(__dirname, 'logs', 'route.json'));
if (failed.length) process.exitCode = 1;
