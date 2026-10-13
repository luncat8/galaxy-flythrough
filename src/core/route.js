// CPU-only itineraries. Distances/dv are SI; timeline and public time are years.
(function () {
'use strict';
const dv = typeof module !== 'undefined' && module.exports ? require('../math/deltav.js') : window.DeltaVLib;
const orbit = typeof module !== 'undefined' && module.exports ? require('../math/orbit.js') : window.OrbitLib;
const TAU = Math.PI * 2;
const YEAR = dv.SECONDS_PER_YEAR;
const C = 299792458;
const KPC_M = 3.0856775814913673e19;
const LAYOVER_Y = 0.25;
const MAX_LEGS = 16;
const NODE_NAMES = ['surface', 'LO', 'GEO', 'escape', 'L5'];

function createRoute() {
	const legs = [];
	for (let i = 0; i < MAX_LEGS; i++) legs.push({ kind: '', label: '', start: 0, end: 0, dv: 0, a1: 0, a2: 0, angle: 0, endAngle: 0, phase: 0, period: 0, powered: false, from: null, to: null, endpoint: null, fromNode: 1, toNode: 1, x1: 0, y1: 0, z1: 0, x2: 0, y2: 0, z2: 0, distance: 0, cruiseSpeed: 0 });
	return { legs, count: 0, totalDv: 0, totalYears: 0, roundTripYears: 0, feasible: false, fuelFeasible: false, lifeFeasible: false, reason: '', ship: dv.SHIP_CLASSES[0], twoWay: false, start: null, end: null, epoch: 0, edge: {}, times: {}, tank: { accel: 0, dvMax: 0 }, scratch: {} };
}
function phaseAt(ref, t) {
	return ref.phase + (ref.node === 4 ? -TAU / 6 : 0) + (ref.body.periodS > 0 ? TAU * t * YEAR / ref.body.periodS : 0);
}
function launchWindow(bodyA, bodyB, phaseA, phaseB, tH, blend) {
	if (blend >= 1) return 0;
	const required = Math.PI - TAU * tH / bodyB.periodS;
	const relative = TAU / bodyB.periodS - TAU / bodyA.periodS;
	const delta = required - (phaseB - phaseA);
	if (Math.abs(relative) < 1e-18) return Math.abs(Math.atan2(Math.sin(delta), Math.cos(delta))) < 1e-8 ? 0 : Infinity;
	const directed = delta * Math.sign(relative);
	return ((directed % TAU + TAU) % TAU) / Math.abs(relative) * (1 - blend);
}
function interstellarLeg(distanceM, ship, out) {
	const v = Math.min(ship.vCruise * C, 0.2 * C, Math.sqrt(ship.accel * Math.max(0, distanceM)));
	out.speed = v;
	out.dv = 2 * v;
	out.timeS = distanceM === 0 && ship.vCruise > 0 ? 0 : v > 0 ? distanceM / v + v / ship.accel : Infinity;
	out.distanceM = distanceM;
	return out;
}
function nodeExists(ref) {
	const b = ref.body;
	return b && ref.node >= 0 && ref.node <= 4 && (ref.node !== 0 || b.hasSurface) && (ref.node !== 2 || b.hasGeo) && (ref.node !== 4 || b.hasL5);
}
function append(route, kind, label, cost, seconds, from, to, powered) {
	if (route.count === MAX_LEGS) { route.reason = 'leg limit exceeded'; return; }
	const leg = route.legs[route.count++];
	leg.kind = kind;
	leg.label = label;
	leg.start = route.totalYears;
	leg.end = leg.start + seconds / YEAR;
	leg.dv = cost;
	leg.a1 = from.body.aM;
	leg.a2 = to.body.aM;
	leg.phase = from.phase;
	leg.period = from.body.periodS;
	leg.angle = phaseAt(from, route.epoch + leg.start);
	leg.endAngle = phaseAt(to, route.epoch + leg.end);
	leg.powered = !!powered;
	leg.x1 = from.x * KPC_M; leg.y1 = from.y * KPC_M; leg.z1 = from.z * KPC_M;
	leg.x2 = to.x * KPC_M; leg.y2 = to.y * KPC_M; leg.z2 = to.z * KPC_M;
	leg.distance = kind === 'cruise' ? route.scratch.distanceM : 0;
	leg.cruiseSpeed = kind === 'cruise' ? route.scratch.speed : 0;
	// Both endpoints are kept: the map traces a transfer from one to the other
	// (system-layer §7.5); `endpoint` stays the single body a leg ends on.
	// fromNode/toNode are the graph nodes the ship rides between on the map:
	// most legs sit on one node, local legs ride the well edge to or from LO.
	leg.from = from;
	leg.to = to;
	leg.fromNode = from.node;
	leg.toNode = to.node;
	leg.endpoint = kind === 'capture' || kind === 'landing' ? to : from;
	route.totalDv += cost;
	route.totalYears = leg.end;
}
function localCost(ref, arriving, out) {
	const b = ref.body;
	if (ref.node === 0) return arriving ? dv.dvLoToSurface(b, out) : dv.dvSurfaceToLo(b, out);
	if (ref.node === 2) return dv.dvLoToGeo(b, out);
	if (ref.node === 4) return dv.dvLoToL5(b, out);
	return 0;
}
function localLeg(route, ref, arriving) {
	const cost = localCost(ref, arriving, route.scratch);
	if (ref.node === 1 || ref.node === 3) return;
	const kind = arriving ? 'landing' : 'launch';
	const seconds = ref.node === 4 ? dv.L5_PHASE_FRACTION * ref.body.periodS : cost / route.ship.accel;
	const before = route.count;
	append(route, kind, ref.label + ' ' + (arriving ? 'LO → ' + NODE_NAMES[ref.node] : NODE_NAMES[ref.node] + ' → LO'), cost, seconds, ref, ref, false);
	if (route.count > before) {
		// The ship rides the well edge: out of the node to LO, or LO into it.
		const leg = route.legs[before];
		leg.fromNode = arriving ? 1 : ref.node;
		leg.toNode = arriving ? ref.node : 1;
	}
}
function systemChain(route, from, to, budget) {
	if (from.body === to.body) {
		localLeg(route, from, false);
		if (from.node === 3 || to.node === 3) {
			const cost = dv.dvLoToEscape(from.body, route.scratch);
			append(route, 'departure', 'LO ↔ escape', cost, cost / route.ship.accel, from, to, false);
		}
		localLeg(route, to, true);
		return;
	}
	// An escape or L5 endpoint is already heliocentric, so that side has no
	// well leg: the ship neither climbs back to LO to leave nor captures into
	// LO to arrive. L5 is a second exit beside the escape node (§7.5 rails).
	if (from.node !== 4) localLeg(route, from, false);
	const edge = route.edge;
	dv.legLoToLo(from.muStar, from.body, to.body, false, edge);
	if (from.node === 3 || from.node === 4) edge.dvLoToLo += edge.dvDepStar - edge.dvDepLo;
	if (to.node === 3 || to.node === 4) edge.dvLoToLo += edge.dvArrStar - edge.dvCapB;
	route.tank.accel = route.ship.accel;
	const reserve = (to.node === 0 || to.node === 2) ? localCost(to, true, route.scratch) : 0;
	route.tank.dvMax = Math.max(0, route.ship.dvMax - route.totalDv - reserve);
	dv.legTimes(edge, route.tank, budget, route.times);
	const times = route.times;
	const wait = launchWindow(from.body, to.body, phaseAt(from, route.epoch + route.totalYears), phaseAt(to, route.epoch + route.totalYears), edge.tH, times.s);
	if (wait > 0) {
		const before = route.count;
		append(route, 'wait', from.label + ' launch window', 0, wait, from, from, false);
		if (route.count > before) {
			// The wait is spent where the departure burn happens: in LO after
			// a launch, on the escape/L5 node when leaving from there.
			const leg = route.legs[before];
			leg.fromNode = leg.toNode = (from.node === 0 || from.node === 2) ? 1 : from.node;
		}
	}
	const dep = (from.node === 3 || from.node === 4) ? edge.dvDepStar : edge.dvDepLo;
	const cap = (to.node === 3 || to.node === 4) ? edge.dvArrStar : edge.dvCapB;
	const extra = Math.max(0, times.dvLeg - edge.dvLoToLo);
	const depCost = dep;
	const capCost = cap;
	// Impulsive transfer approximation: burn costs belong to the timeline,
	// but do not add a second acceleration duration to the transfer model.
	append(route, 'departure', from.label + ' departure', depCost, 0, from, from, false);
	append(route, 'transfer', from.label + ' → ' + to.label, extra, times.t, from, to, !times.belowCrossover);
	append(route, 'capture', to.label + ' capture', capCost, 0, to, to, false);
	if (to.node !== 4) localLeg(route, to, true);
	if (!times.feasible) route.reason = 'transfer exceeds fuel/acceleration';
}
function stellarChain(route, from, to) {
	if (from.node !== 4) localLeg(route, from, false);
	const dep = (from.node === 3 || from.node === 4) ? 0 : dv.dvLoToEscape(from.body, route.scratch);
	append(route, 'departure', from.label + ' escape', dep, dep / route.ship.accel, from, from, false);
	const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
	interstellarLeg(Math.hypot(dx, dy, dz) * KPC_M, route.ship, route.scratch);
	append(route, 'cruise', from.label + ' → ' + to.label + ' interstellar', route.scratch.dv, route.scratch.timeS, from, to, true);
	const cap = (to.node === 3 || to.node === 4) ? 0 : dv.dvLoToEscape(to.body, route.scratch);
	append(route, 'capture', to.label + ' capture', cap, cap / route.ship.accel, to, to, false);
	if (to.node !== 4) localLeg(route, to, true);
}
function buildRoute(startRef, endRef, shipClass, budget, out, twoWay, epoch) {
	out.count = 0; out.totalDv = 0; out.totalYears = 0; out.roundTripYears = 0;
	out.reason = ''; out.feasible = false; out.fuelFeasible = false; out.lifeFeasible = false;
	out.start = startRef; out.end = endRef;
	out.ship = dv.shipById(shipClass);
	out.twoWay = !!twoWay; out.epoch = Number.isFinite(epoch) ? epoch : 0;
	if (!startRef || !endRef || !nodeExists(startRef) || !nodeExists(endRef)) { out.reason = 'choose valid start and destination nodes'; return out; }
	if (startRef.systemKey === endRef.systemKey && startRef.body === endRef.body && startRef.node === endRef.node) { out.reason = 'choose different endpoints'; return out; }
	const interstellar = startRef.systemKey !== endRef.systemKey;
	if (interstellar && out.ship.vCruise <= 0) { out.reason = 'ship is in-system only'; return out; }
	const chain = interstellar ? stellarChain : systemChain;
	chain(out, startRef, endRef, budget);
	if (out.twoWay) {
		append(out, 'wait', 'turn-around layover', 0, LAYOVER_Y * YEAR, endRef, endRef, false);
		chain(out, endRef, startRef, budget);
		out.roundTripYears = out.totalYears;
	}
	out.fuelFeasible = out.totalDv <= out.ship.dvMax + 1e-6;
	out.lifeFeasible = out.totalYears <= out.ship.lifeYears && Number.isFinite(out.totalYears);
	if (!out.fuelFeasible) out.reason = 'total itinerary exceeds tank (no refill)';
	else if (!out.lifeFeasible) out.reason = 'elapsed itinerary exceeds life support / no finite window';
	out.feasible = out.fuelFeasible && out.lifeFeasible && !out.reason;
	return out;
}
function routePosition(out, route, t) {
	if (out.length > 2) out[2] = 0;
	if (!route.count) { out[0] = 0; out[1] = 0; return -1; }
	const time = Math.max(0, Math.min(t, route.totalYears));
	let lo = 0, hi = route.count - 1;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (route.legs[mid].end <= time) lo = mid + 1;
		else hi = mid;
	}
	const leg = route.legs[lo];
	const f = leg.end > leg.start ? Math.max(0, Math.min(1, (time - leg.start) / (leg.end - leg.start))) : 1;
	let r, angle;
	if (leg.kind === 'cruise') {
		const seconds = (time - leg.start) * YEAR;
		const totalS = (leg.end - leg.start) * YEAR;
		const burnS = leg.cruiseSpeed / route.ship.accel;
		const remaining = totalS - seconds;
		const travelled = seconds < burnS ? 0.5 * route.ship.accel * seconds ** 2
			: remaining < burnS ? leg.distance - 0.5 * route.ship.accel * remaining ** 2
			: leg.cruiseSpeed * (seconds - 0.5 * burnS);
		const fraction = leg.distance > 0 ? travelled / leg.distance : 1;
		out[0] = leg.x1 + (leg.x2 - leg.x1) * fraction;
		out[1] = leg.y1 + (leg.y2 - leg.y1) * fraction;
		if (out.length > 2) out[2] = leg.z1 + (leg.z2 - leg.z1) * fraction;
		return lo;
	}
	if (leg.kind !== 'transfer') {
		r = leg.endpoint.body.aM;
		angle = phaseAt(leg.endpoint, route.epoch + time);
		out[0] = r * Math.cos(angle); out[1] = r * Math.sin(angle);
		if (route.start.systemKey !== route.end.systemKey) {
			out[0] += leg.endpoint.x * KPC_M; out[1] += leg.endpoint.y * KPC_M;
			if (out.length > 2) out[2] = leg.endpoint.z * KPC_M;
		}
		return lo;
	}
	if (leg.powered) {
		const x = f <= 0.5 ? 2 * f * f : 1 - 2 * (1 - f) ** 2;
		out[0] = leg.a1 * Math.cos(leg.angle) * (1 - x) + leg.a2 * Math.cos(leg.endAngle) * x;
		out[1] = leg.a1 * Math.sin(leg.angle) * (1 - x) + leg.a2 * Math.sin(leg.endAngle) * x;
		return lo;
	}
	const a = (leg.a1 + leg.a2) * 0.5;
	const e = Math.abs(leg.a2 - leg.a1) / (leg.a1 + leg.a2);
	const inward = leg.a2 < leg.a1;
	const E = orbit.solveEccentricAnomaly((inward ? Math.PI : 0) + Math.PI * f, e);
	const x = a * (Math.cos(E) - e), y = a * Math.sqrt(1 - e * e) * Math.sin(E);
	angle = leg.angle - (inward ? Math.PI : 0);
	out[0] = x * Math.cos(angle) - y * Math.sin(angle);
	out[1] = x * Math.sin(angle) + y * Math.cos(angle);
	return lo;
}
function spentDv(route, t) {
	let total = 0;
	for (let i = 0; i < route.count; i++) {
		const l = route.legs[i];
		if (t < l.start) break;
		if (l.kind === 'cruise') {
			const seconds = Math.min(t - l.start, l.end - l.start) * YEAR;
			const burnS = l.cruiseSpeed / route.ship.accel;
			const remaining = (l.end - l.start) * YEAR - seconds;
			total += route.ship.accel * (Math.min(seconds, burnS) + Math.max(0, burnS - remaining));
			continue;
		}
		total += l.dv * (l.end > l.start ? Math.min(1, (t - l.start) / (l.end - l.start)) : 1);
	}
	return total;
}
function reportLines(route, elapsed) {
	const s = route.ship;
	const lines = ['route  ' + s.label + ' · ' + (route.twoWay ? 'round trip' : 'one way') + ' · ' + (route.feasible ? 'feasible' : route.reason),
		'  cargo ' + s.cargo.toLocaleString('en-US') + ' t · crew ' + s.crew + ' · life support ' + s.lifeYears + ' y',
		'  total ' + dv.formatKms(route.totalDv) + '/' + dv.formatKms(s.dvMax) + ' km/s · ' + dv.formatDuration(route.totalYears * YEAR)];
	for (let i = 0; i < route.count; i++) {
		const l = route.legs[i];
		lines.push('  ' + (i + 1) + '. ' + l.label + ' · ' + dv.formatKms(l.dv) + ' km/s · ' + dv.formatDuration((l.end - l.start) * YEAR));
	}
	if (elapsed !== undefined && route.count) {
		// Readout is throttled, not part of the allocation-free drawing loop.
		const pos = [0, 0];
		const index = routePosition(pos, route, elapsed);
		lines.push('  autopilot · leg ' + (index + 1) + '/' + route.count + ' (' + route.legs[index].label + ') · ' + dv.formatDuration(Math.max(0, route.totalYears - elapsed) * YEAR) + ' remaining · dv spent ' + dv.formatKms(spentDv(route, elapsed)) + '/' + dv.formatKms(s.dvMax) + ' km/s');
	}
	return lines;
}
const RouteLib = { createRoute, buildRoute, routePosition, launchWindow, interstellarLeg, phaseAt, spentDv, reportLines, SHIP_CLASSES: dv.SHIP_CLASSES, MAX_LEGS, LAYOVER_Y, C, KPC_M, NODE_NAMES };
if (typeof module !== 'undefined') module.exports = RouteLib;
if (typeof window !== 'undefined') window.RouteLib = RouteLib;
})();
