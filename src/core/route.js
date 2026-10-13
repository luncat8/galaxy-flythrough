// src/core/route.js
// Routes and autopilot (0.5 plan §8): the in-system legs of §7's model, the synodic
// wait a low-energy transfer must sit out, the interstellar cruise between two
// stars, the two-way totals of a trade route, and the closed-form routePosition an
// autopilot flies. Pure state and arithmetic — no DOM, no canvas, no renderer —
// with preallocated structs and `out` parameters, the same contract search.js
// holds: main.js owns the glue, system-layer.js owns the pixels.
//
// The ship table (§8.1) is read from deltav.js, which owns it because §7.4's
// budget mapping consumed it a release earlier. The Kepler solver is orbit.js's,
// the one in the repo: a Hohmann leg's position is mean anomaly → eccentric
// anomaly → true anomaly, exactly what the apocenter engine already does.

'use strict';

// planets.js owns the record shapes, deltav.js the node codes, the closed forms
// and the ship table, orbit.js the Kepler solver. All three are on the page
// before this file (index.html: math before core), so the lookup is a require in
// Node and a window read in the browser — the idiom deltav.js uses for planets.
const routePlanets = (typeof module !== 'undefined' && module.exports)
	? require('../math/planets.js')
	: window.PlanetsLib;
const routeDeltaV = (typeof module !== 'undefined' && module.exports)
	? require('../math/deltav.js')
	: window.DeltaVLib;
const routeOrbit = (typeof module !== 'undefined' && module.exports)
	? require('../math/orbit.js')
	: window.OrbitLib;

const ROUTE_MAX_LEGS = 16;
const LAYOVER_Y = 0.25;              // §8.4's turn-around layover, one authored constant
const ROUTE_TAU = Math.PI * 2;
const YEAR_S = routePlanets.HOURS_PER_YEAR * 3600;
const C_KMS = 299792.458;            // km/s; a class's cruiseC is a fraction of it
const CRUISE_CAP_C = 0.2;            // §8.3's hard cap — relativity is §13's out-of-scope
const KPC_TO_M = 3.0856775814913673e19;
const LY_PER_KPC = 3261.5637771674395;   // a unit conversion, not a model constant

// Endpoint body codes, the ones planets.js's bodyDesignation names.
const ENDPOINT_PLANET = 1, ENDPOINT_BELT = 2;

// Leg kinds. A route is one timeline: the outbound chain, the layover, then the
// return chain (§8.0).
const LEG_WAIT = 0;        // holding at the departure node for the synodic window
const LEG_ASCENT = 1;      // the endpoint's own node → its low orbit
const LEG_TRANSFER = 2;    // low orbit → low orbit, §7.4's blend
const LEG_DESCENT = 3;     // low orbit → the endpoint's own node
const LEG_CRUISE = 4;      // star → star at the ship's cruise speed
const LEG_LAYOVER = 5;     // the turn-around wait at the far endpoint
const LEG_COUNT = 6;
const LEG_NAMES = ['wait window', 'ascent', 'transfer', 'descent', 'cruise', 'layover'];

const ROUTE_IN_SYSTEM = 0, ROUTE_INTERSTELLAR = 1;

// The five ship classes, as route-level feasibility reads them.
const FEAS_OK = 0, FEAS_TANK = 1, FEAS_LIFE = 2, FEAS_DOMAIN = 3;
const FEAS_NAMES = ['ok', 'over the tank', 'life support too short', 'no star drive'];

function createEndpoint() {
	return {
		kind: ENDPOINT_PLANET, index: 0, node: routeDeltaV.NODE_LOW_ORBIT,
		starKey: 0, x: 0, y: 0, z: 0,
	};
}

function createLeg() {
	return {
		kind: LEG_WAIT,
		fromKind: ENDPOINT_PLANET, fromIndex: 0, fromNode: routeDeltaV.NODE_LOW_ORBIT,
		toKind: ENDPOINT_PLANET, toIndex: 0, toNode: routeDeltaV.NODE_LOW_ORBIT,
		dv: 0, dvMin: 0, tYr: 0, tStart: 0, tEnd: 0,
		// transfer geometry: the two orbits in AU, the transfer ellipse's
		// eccentricity, the departure angle and the blend factor of §7.4.
		a1: 0, a2: 0, ecc: 0, theta1: 0, outward: true, blend: 0,
		// the chord the brachistochrone half flies, in AU
		cx1: 0, cy1: 0, cx2: 0, cy2: 0,
		// body-anchored legs (wait, ascent, descent, in-system layover): the
		// orbit the ship holds on, so the hold rides its own phase.
		holdA: 0, holdPhase: 0, holdPeriod: 1,
		// false while the leg's bodies belong to the other star: the ship is
		// between systems and there is nothing to draw it on (§8.3).
		nearSide: true,
		label: '',
	};
}

function createRoute() {
	const legs = new Array(ROUTE_MAX_LEGS);
	for (let i = 0; i < ROUTE_MAX_LEGS; i++) legs[i] = createLeg();
	return {
		kind: ROUTE_IN_SYSTEM,
		from: createEndpoint(), to: createEndpoint(),
		shipName: routeDeltaV.SHIP_DEFAULT, ship: 0, budget: routeDeltaV.BUDGET_DEFAULT,
		legs, legCount: 0, outCount: 0, layoverIndex: -1,
		tSysYr: 0,
		outDv: 0, outTimeYr: 0, totalDv: 0, totalTimeYr: 0,
		distanceKpc: 0, farResolved: true,
	};
}

// The autopilot line of §8.5, preallocated: which leg, what remains, what the
// tank has spent. One scratch per readout, not per frame.
function createStatus() {
	return { legIndex: 0, legCount: 0, label: '', remainingYr: 0, dvSpent: 0, dvTank: 0, done: true };
}

// One star's system, as a route endpoint set: the record, the star's identity and
// its position when the endpoint was picked. `far` may be null — the other star
// is not resident right now.
function createSystemSide() {
	return { record: null, starKey: 0, x: 0, y: 0, z: 0 };
}

// --- module scratch ---------------------------------------------------------
// Route building walks two bodies and one leg struct at a time; the structs are
// module scope because buildRoute never re-enters itself. deltav.js's own leg
// struct is not reused: main.js holds one of those for its dv table while a route
// is built, and two writers on one struct is a drift waiting to happen.
const bodyFrom = routeDeltaV.createBody();
const bodyTo = routeDeltaV.createBody();
const chainLeg = routeDeltaV.createLeg();

// --- helpers ----------------------------------------------------------------
function copyEndpoint(out, source) {
	out.kind = source.kind;
	out.index = source.index;
	out.node = source.node;
	out.starKey = source.starKey;
	out.x = source.x;
	out.y = source.y;
	out.z = source.z;
	return out;
}

function endpointDistanceKpc(from, to) {
	const dx = from.x - to.x, dy = from.y - to.y, dz = from.z - to.z;
	return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// The dv body an endpoint names, from the record of its own system. The endpoint
// codes are planets.js's designation codes (1 a planet, 2 a belt), which are not
// deltav.js's body-kind codes — the layer's own BODY_PLANET/BODY_BELT pair uses
// the same ones, so one mapping here serves every caller.
function bodyOf(out, record, endpoint) {
	const kind = endpoint.kind === ENDPOINT_BELT ? routeDeltaV.BODY_KIND_BELT : routeDeltaV.BODY_KIND_PLANET;
	return routeDeltaV.bodyFromSystem(out, record, kind, endpoint.index);
}

// Which side an endpoint belongs to: the near system (the one the route is drawn
// in) or the far one, or null when the far system could not be resolved.
function sideOf(endpoint, near, far) {
	if (endpoint.starKey === near.starKey) return near;
	if (far && endpoint.starKey === far.starKey) return far;
	return null;
}

// A body's phase at a system time, §4.5's law: θ = θ₀ + ROUTE_TAU·(t/P). Planets only —
// a belt has no single angle (§8.4).
function phaseAt(record, endpoint, sysYr) {
	const rows = record.planets;
	return rows.phase[endpoint.index] + ROUTE_TAU * (sysYr / rows.period[endpoint.index]);
}

// §8.4's synodic wait, at the route clock `atSysYr` (system years) for a transfer
// of `tTransferYr` flown with blend factor `blend`.
//
// The relative angle moves at ω = TAU·(1/P_arr − 1/P_dep) — negative when the
// destination is the slower orbit, which is the usual case for an outward
// transfer. The wait is the *shortest* time that brings that angle to φ_req, so
// the gap is measured the way the angle travels: forwards when ω > 0, backwards
// (TAU − gap) when it is not. Waiting for the next recurrence instead would add
// a full synodic period to half the windows.
function waitYears(record, from, to, tTransferYr, blend, atSysYr) {
	if (blend >= 1 || !(tTransferYr > 0)) return 0;
	// A belt's bodies fill a ring, so any departure angle is already aligned and
	// its phase is the layer's draw seed rather than a record field.
	if (from.kind !== ENDPOINT_PLANET || to.kind !== ENDPOINT_PLANET) return 0;
	const depPeriod = record.planets.period[from.index];
	const arrPeriod = record.planets.period[to.index];
	if (!(depPeriod > 0) || !(arrPeriod > 0)) return 0;
	const omega = ROUTE_TAU * (1 / arrPeriod - 1 / depPeriod);
	// A frozen relative angle never reaches a window it is not already in; the
	// generator's Hill repair makes the pair impossible, so this is a guard.
	if (!(omega !== 0)) return 0;
	// φ_req uses the flown time, not t_H: a blend above 0 flies a shorter leg and
	// the window opens earlier.
	const phiReq = Math.PI * (1 - 2 * tTransferYr / arrPeriod);
	const phiNow = phaseAt(record, to, atSysYr) - phaseAt(record, from, atSysYr);
	let delta = (phiReq - phiNow) % ROUTE_TAU;
	if (delta < 0) delta += ROUTE_TAU;
	if (delta < 1e-12 || delta > ROUTE_TAU - 1e-12) return 0;
	const gap = omega > 0 ? delta : ROUTE_TAU - delta;
	return (gap / Math.abs(omega)) * (1 - blend);
}

// The row label's body name: the IAU letter for a planet, `belt n` for a belt.
function endpointShort(endpoint) {
	return endpoint.kind === ENDPOINT_PLANET
		? routePlanets.PLANET_LETTERS[endpoint.index]
		: 'belt ' + (endpoint.index + 1);
}

// A node code's index in deltav.js's NODE_SHORT table, which lists the six nodes
// in the order the map stacks them.
function nodeSlotOf(node) {
	const codes = [
		routeDeltaV.NODE_SURFACE, routeDeltaV.NODE_LOW_ORBIT, routeDeltaV.NODE_GEO,
		routeDeltaV.NODE_L5, routeDeltaV.NODE_ESCAPE, routeDeltaV.NODE_BELT_BODY,
	];
	for (let i = 0; i < codes.length; i++) {
		if (codes[i] === node) return i;
	}
	return 1;
}

// One leg into the route's leg array at the running clock. Returns the leg, or
// null when the chain is full (16 legs is 3 chains' worth; the guard exists so a
// caller cannot walk past the array).
function pushLeg(out, t) {
	if (out.legCount >= ROUTE_MAX_LEGS) return null;
	const leg = out.legs[out.legCount++];
	leg.tStart = t;
	leg.tEnd = t;
	leg.dv = 0;
	leg.dvMin = 0;
	leg.tYr = 0;
	leg.blend = 0;
	leg.nearSide = true;
	return leg;
}

// The two ends every leg joins. Each endpoint contributes its body code and its
// index, and the leg's own nodes say which end of the burn it is — a transfer
// joins two bodies' low orbits, an ascent joins the endpoint's own node to its
// low orbit, a wait joins the endpoint to itself.
function setLegEndpoints(leg, from, to, fromNode, toNode) {
	leg.fromKind = from.kind;
	leg.fromIndex = from.index;
	leg.fromNode = fromNode;
	leg.toKind = to.kind;
	leg.toIndex = to.index;
	leg.toNode = toNode;
}

// A leg whose ship rides a body's own orbit: the phase and period the hold and
// the wait draw from, so a waiting ship moves with the planet it waits beside.
function setHold(leg, record, endpoint) {
	leg.holdA = record.planets.a[endpoint.index];
	leg.holdPhase = record.planets.phase[endpoint.index];
	leg.holdPeriod = record.planets.period[endpoint.index];
}

// §8.0's ascent and descent are one leg walked in either direction: the energy is
// the node leg deltav.js already computes, or the endpoint's own launch or landing
// form from the ground — and a landing is cheaper than a launch (§7.2's land
// credit). The one asymmetry of the two directions is that single difference.
function pushNodeLeg(out, kind, body, record, endpoint, t, nearSide) {
	const leg = pushLeg(out, t);
	if (!leg) return t;
	leg.kind = kind;
	const low = routeDeltaV.NODE_LOW_ORBIT;
	setLegEndpoints(leg, endpoint, endpoint,
		kind === LEG_ASCENT ? endpoint.node : low, kind === LEG_ASCENT ? low : endpoint.node);
	leg.dv = endpoint.node === routeDeltaV.groundNode(body)
		? (kind === LEG_ASCENT ? routeDeltaV.launchDv(body) : routeDeltaV.landDv(body))
		: routeDeltaV.nodeLegDv(body, endpoint.node);
	leg.dvMin = leg.dv;
	leg.tYr = routeDeltaV.nodeLegTimeYr(body, endpoint.node);
	setHold(leg, record, endpoint);
	leg.nearSide = nearSide;
	const name = `${endpointShort(endpoint)} ${routeDeltaV.NODE_SHORT[nodeSlotOf(endpoint.node)]}`;
	leg.label = kind === LEG_ASCENT ? `${name} → LEO` : `LEO → ${name}`;
	leg.tEnd = t + leg.tYr;
	return leg.tEnd;
}

function pushAscent(out, body, record, endpoint, t, nearSide) {
	return pushNodeLeg(out, LEG_ASCENT, body, record, endpoint, t, nearSide);
}

function pushDescent(out, body, record, endpoint, t, nearSide) {
	return pushNodeLeg(out, LEG_DESCENT, body, record, endpoint, t, nearSide);
}

// §8.4's wait leg: the ship holds on the departure body for the window.
function pushWait(out, record, endpoint, waitYr, t, nearSide) {
	const leg = pushLeg(out, t);
	if (!leg) return t;
	leg.kind = LEG_WAIT;
	setLegEndpoints(leg, endpoint, endpoint, endpoint.node, endpoint.node);
	leg.tYr = waitYr;
	setHold(leg, record, endpoint);
	leg.nearSide = nearSide;
	leg.label = 'wait for window';
	leg.tEnd = t + leg.tYr;
	return leg.tEnd;
}

// §8.4's transfer: low orbit to low orbit at §7.4's blend, preceded by its wait.
// Returns the clock after the transfer.
function pushTransfer(out, record, from, to, ship, t, nearSide) {
	const sameBody = from.kind === to.kind && from.index === to.index;
	const v = routeDeltaV;
	let tHYr = 0, arcM = 0, dvMin = 0, dvLeg = 0, blend = 0, tYr = 0;
	// A body against itself is a zero leg: the chain degenerates to its ascent
	// and descent, which is the whole surface → GEO answer.
	if (!sameBody) {
		v.legBetween(chainLeg, bodyFrom, v.NODE_LOW_ORBIT, bodyTo, v.NODE_LOW_ORBIT);
		tHYr = chainLeg.tHYr;
		arcM = chainLeg.arcM;
		dvMin = chainLeg.dvMin;
		const ceiling = v.dvCeilingKms(ship, arcM);
		dvLeg = v.dvLegKms(dvMin, ceiling, out.budget);
		blend = v.blendFactor(dvLeg, dvMin, arcM, tHYr * YEAR_S);
		tYr = v.legTimeS(dvLeg, dvMin, arcM, tHYr * YEAR_S) / YEAR_S;
	}
	// The wait is measured at the moment this chain departs — the running clock,
	// which for the return chain already includes the outbound and the layover.
	const wait = waitYears(record, from, to, tYr, blend, out.tSysYr + t);
	if (wait > 1e-12) {
		t = pushWait(out, record, from, wait, t, nearSide);
		if (out.legCount >= ROUTE_MAX_LEGS) return t;
	}
	const leg = pushLeg(out, t);
	if (!leg) return t;
	leg.kind = LEG_TRANSFER;
	setLegEndpoints(leg, from, to, routeDeltaV.NODE_LOW_ORBIT, routeDeltaV.NODE_LOW_ORBIT);
	leg.dv = dvLeg;
	leg.dvMin = dvMin;
	leg.tYr = tYr;
	leg.a1 = bodyFrom.aAu;
	leg.a2 = bodyTo.aAu;
	leg.outward = bodyTo.aAu > bodyFrom.aAu;
	leg.ecc = sameBody ? 0 : Math.abs(leg.a2 - leg.a1) / (leg.a1 + leg.a2);
	// The departure angle is where the departure body is when the wait ends, and
	// the chord's far end is where the arrival body will be half a turn later —
	// the two points the brachistochrone half of a blended leg flies between.
	leg.theta1 = sameBody ? 0 : phaseAt(record, from, out.tSysYr + t);
	leg.cx1 = leg.a1 * Math.cos(leg.theta1);
	leg.cy1 = leg.a1 * Math.sin(leg.theta1);
	const theta2 = leg.theta1 + Math.PI;
	leg.cx2 = leg.a2 * Math.cos(theta2);
	leg.cy2 = leg.a2 * Math.sin(theta2);
	leg.blend = blend;
	leg.nearSide = nearSide;
	leg.label = `${endpointShort(from)} → ${endpointShort(to)}`;
	leg.tEnd = t + leg.tYr;
	return leg.tEnd;
}

// §8.3's cruise: star to star at the ship's own cruise speed. The escape and the
// capture are this leg's own acceleration and deceleration, so they carry no dv
// of their own — adding the star's escape number on top would double-count what
// 2·v_cruise already spends.
function pushCruise(out, from, to, ship, distanceKpc, t) {
	const leg = pushLeg(out, t);
	if (!leg) return t;
	leg.kind = LEG_CRUISE;
	setLegEndpoints(leg, from, to, routeDeltaV.NODE_LOW_ORBIT, routeDeltaV.NODE_LOW_ORBIT);
	const vCruise = cruiseKms(ship);
	leg.dv = 2 * vCruise;
	leg.dvMin = leg.dv;
	leg.tYr = cruiseYears(ship, distanceKpc * KPC_TO_M);
	// A cruise is between systems by definition: the other star is not on this
	// canvas, so the ship is text in the report and nothing on the schematic.
	leg.nearSide = false;
	leg.label = `cruise ${(distanceKpc * LY_PER_KPC).toFixed(0)} ly`;
	leg.tEnd = t + leg.tYr;
	return leg.tEnd;
}

// §8.4's layover: the turn-around wait. It happens at the arrival endpoint, so it
// is drawable exactly when that endpoint is in the anchored system.
function pushLayover(out, record, endpoint, nearSide, t) {
	const leg = pushLeg(out, t);
	if (!leg) return t;
	leg.kind = LEG_LAYOVER;
	setLegEndpoints(leg, endpoint, endpoint, endpoint.node, endpoint.node);
	leg.tYr = LAYOVER_Y;
	if (record) setHold(leg, record, endpoint);
	leg.nearSide = nearSide;
	leg.label = `layover at ${endpointShort(endpoint)}`;
	leg.tEnd = t + leg.tYr;
	return leg.tEnd;
}

// The one in-system chain: ascent, wait, transfer, descent. Returns the clock
// after the chain.
function buildInSystemChain(out, near, from, to, ship, t) {
	const record = near.record;
	bodyOf(bodyFrom, record, from);
	bodyOf(bodyTo, record, to);
	const nearSide = from.starKey === near.starKey && to.starKey === near.starKey;
	if (from.node !== routeDeltaV.NODE_LOW_ORBIT) t = pushAscent(out, bodyFrom, record, from, t, nearSide);
	if (out.legCount < ROUTE_MAX_LEGS) t = pushTransfer(out, record, from, to, ship, t, nearSide);
	if (to.node !== routeDeltaV.NODE_LOW_ORBIT) t = pushDescent(out, bodyTo, record, to, t, nearSide);
	return t;
}

// The interstellar chain: ascent at one end, the cruise, descent at the other.
// The far end's legs need that star's system; when it is not resident they are
// dropped and the route says so rather than inventing numbers.
function buildCruiseChain(out, near, far, from, to, ship, t) {
	const fromSide = sideOf(from, near, far);
	const toSide = sideOf(to, near, far);
	if (fromSide && from.node !== routeDeltaV.NODE_LOW_ORBIT) {
		bodyOf(bodyFrom, fromSide.record, from);
		t = pushAscent(out, bodyFrom, fromSide.record, from, t, fromSide === near);
	} else if (!fromSide) {
		out.farResolved = false;
	}
	if (out.legCount < ROUTE_MAX_LEGS) t = pushCruise(out, from, to, ship, out.distanceKpc, t);
	if (toSide && to.node !== routeDeltaV.NODE_LOW_ORBIT) {
		bodyOf(bodyTo, toSide.record, to);
		t = pushDescent(out, bodyTo, toSide.record, to, t, toSide === near);
	} else if (!toSide) {
		out.farResolved = false;
	}
	return t;
}

// --- the build ---------------------------------------------------------------
// `near` is the system the route is anchored in — the open one — and `far` the
// other endpoint's, or null. The two chains share one timeline: the outbound
// legs, the layover, then the return legs, each leg's tStart/tEnd in route years
// from tSysYr.
function buildRoute(out, near, far, from, to, shipName, budget, tSysYr) {
	copyEndpoint(out.from, from);
	copyEndpoint(out.to, to);
	out.shipName = shipName;
	out.ship = routeDeltaV.shipIndex(shipName);
	out.budget = budget;
	out.tSysYr = tSysYr;
	out.legCount = 0;
	out.outCount = 0;
	out.layoverIndex = -1;
	out.outDv = 0;
	out.outTimeYr = 0;
	out.totalDv = 0;
	out.totalTimeYr = 0;
	out.farResolved = true;
	const ship = routeDeltaV.SHIP_CLASSES[out.ship];
	const interstellar = from.starKey !== to.starKey && from.starKey !== 0 && to.starKey !== 0;
	out.kind = interstellar ? ROUTE_INTERSTELLAR : ROUTE_IN_SYSTEM;
	let t = 0;
	if (interstellar) {
		out.distanceKpc = endpointDistanceKpc(from, to);
		t = buildCruiseChain(out, near, far, from, to, ship, t);
	} else {
		out.distanceKpc = 0;
		t = buildInSystemChain(out, near, from, to, ship, t);
	}
	out.outCount = out.legCount;
	out.layoverIndex = out.legCount;
	const toSide = interstellar ? sideOf(to, near, far) : near;
	t = pushLayover(out, toSide ? toSide.record : null, to, toSide === near, t);
	if (interstellar) buildCruiseChain(out, near, far, to, from, ship, t);
	else buildInSystemChain(out, near, to, from, ship, t);
	tally(out);
	return out;
}

function tally(out) {
	let dv = 0, time = 0, outDv = 0, outTime = 0;
	for (let i = 0; i < out.legCount; i++) {
		const leg = out.legs[i];
		dv += leg.dv;
		time += leg.tYr;
		if (i < out.outCount) {
			outDv += leg.dv;
			outTime += leg.tYr;
		}
	}
	out.totalDv = dv;
	out.totalTimeYr = time;
	out.outDv = outDv;
	out.outTimeYr = outTime;
}

// --- feasibility (§8.4's report) ---------------------------------------------
// The route passed in must have been built for this class: the report rebuilds
// the chain once per ship, so the numbers are that ship's own ceiling and blend.
function feasibility(route, ship) {
	if (route.kind === ROUTE_INTERSTELLAR && ship.cruiseC <= 0) return FEAS_DOMAIN;
	if (route.totalDv > ship.dv * (1 + 1e-9)) return FEAS_TANK;
	if (route.totalTimeYr > ship.lifeSupportY) return FEAS_LIFE;
	return FEAS_OK;
}

// --- the ship's cruise (§8.3) ------------------------------------------------
function cruiseKms(ship) {
	if (!(ship.cruiseC > 0)) return 0;
	return Math.min(ship.cruiseC, CRUISE_CAP_C) * C_KMS;
}

function cruiseYears(ship, distanceM) {
	const v = cruiseKms(ship) * 1000;      // m/s
	if (!(v > 0) || !(ship.accel > 0)) return Infinity;
	return (distanceM / v + v / ship.accel) / YEAR_S;
}

// --- the autopilot's position (§8.5) ----------------------------------------
// out is a Float64Array(3): [x, y] in AU in the anchored system's plane, and
// out[2] is 1 while the ship is in that plane.
function legAt(route, tYr) {
	const index = routeLegIndex(route, tYr);
	return index < 0 ? null : route.legs[index];
}

function legFraction(leg, tYr) {
	const span = leg.tEnd - leg.tStart;
	if (!(span > 0)) return 1;
	let f = (tYr - leg.tStart) / span;
	if (f < 0) f = 0;
	else if (f > 1) f = 1;
	return f;
}

// A waiting, ascending or descending ship rides its body's own orbit, so it moves
// with the planet it is beside rather than sitting at a fixed angle.
function holdPoint(out, route, leg, tYr) {
	const theta = leg.holdPhase + ROUTE_TAU * ((route.tSysYr + tYr) / leg.holdPeriod);
	out[0] = leg.holdA * Math.cos(theta);
	out[1] = leg.holdA * Math.sin(theta);
	out[2] = 1;
}

// The transfer ellipse, and the chord a blended leg flies half of. Both sweep
// exactly π radians, so θ(f) = θ_dep + π·f whichever way the transfer goes; an
// inward one walks the ellipse backwards from apoapsis, M = π·(1−f).
function transferPoint(out, leg, f) {
	const aT = (leg.a1 + leg.a2) * 0.5;
	const e = leg.ecc;
	const mean = leg.outward ? Math.PI * f : Math.PI * (1 - f);
	const E = routeOrbit.solveEccentricAnomaly(mean, e);
	const r = aT * (1 - e * Math.cos(E));
	const theta = leg.theta1 + Math.PI * f;
	const ex = r * Math.cos(theta), ey = r * Math.sin(theta);
	if (leg.blend <= 0) {
		out[0] = ex;
		out[1] = ey;
		out[2] = 1;
		return;
	}
	// x(f) along the chord: accelerate to the midpoint, flip, decelerate
	// (§8.5's parabola), blended with the ellipse by the leg's own s.
	const dx = leg.cx2 - leg.cx1, dy = leg.cy2 - leg.cy1;
	const d = Math.hypot(dx, dy);
	const xf = f <= 0.5 ? 2 * d * f * f : d - 2 * d * (1 - f) * (1 - f);
	const k = d > 0 ? xf / d : f;
	out[0] = ex * (1 - leg.blend) + (leg.cx1 + dx * k) * leg.blend;
	out[1] = ey * (1 - leg.blend) + (leg.cy1 + dy * k) * leg.blend;
	out[2] = 1;
}

function routePosition(out, route, tYr) {
	const leg = legAt(route, tYr);
	if (!leg || !leg.nearSide) {
		out[0] = 0;
		out[1] = 0;
		out[2] = 0;
		return out;
	}
	if (leg.kind === LEG_TRANSFER) transferPoint(out, leg, legFraction(leg, tYr));
	else holdPoint(out, route, leg, tYr);
	return out;
}

// The leg covering a time, by index — the caller's own loop, not a scratch.
function routeLegIndex(route, tYr) {
	const count = route.legCount;
	if (count === 0) return -1;
	if (tYr <= route.legs[0].tStart) return 0;
	let lo = 0, hi = count - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (route.legs[mid].tStart <= tYr) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

// §8.5's readout line: `route chemical · leg 3/5 (Mars capture) · 41 d remaining
// · dv spent 12.4/20 km/s`.
function routeStatus(out, route, tYr) {
	out.legCount = route.legCount;
	out.done = tYr >= route.totalTimeYr;
	out.remainingYr = 0;
	out.dvSpent = 0;
	out.dvTank = routeDeltaV.SHIP_CLASSES[route.ship].dv;
	const index = routeLegIndex(route, tYr);
	out.legIndex = index;
	if (index < 0) {
		out.label = '';
		return out;
	}
	const leg = route.legs[index];
	out.label = leg.label;
	out.remainingYr = leg.tEnd - tYr > 0 ? leg.tEnd - tYr : 0;
	for (let i = 0; i < index; i++) out.dvSpent += route.legs[i].dv;
	// A burn leg spends its dv as it flies; a wait or a layover spends nothing.
	if (leg.kind !== LEG_WAIT && leg.kind !== LEG_LAYOVER) out.dvSpent += leg.dv;
	return out;
}

const RouteLib = {
	ROUTE_MAX_LEGS, LAYOVER_Y, C_KMS, CRUISE_CAP_C,
	ENDPOINT_PLANET, ENDPOINT_BELT,
	LEG_WAIT, LEG_ASCENT, LEG_TRANSFER, LEG_DESCENT, LEG_CRUISE, LEG_LAYOVER,
	LEG_COUNT, LEG_NAMES,
	ROUTE_IN_SYSTEM, ROUTE_INTERSTELLAR,
	FEAS_OK, FEAS_TANK, FEAS_LIFE, FEAS_DOMAIN, FEAS_NAMES,
	createEndpoint, createLeg, createRoute, createStatus, createSystemSide,
	buildRoute, feasibility, cruiseKms, cruiseYears,
	routePosition, routeLegIndex, routeStatus, legAt, legFraction,
};
if (typeof module !== 'undefined') module.exports = RouteLib;
if (typeof window !== 'undefined') window.RouteLib = RouteLib;
