// src/math/deltav.js
// The delta-v map (0.5 plan §7): closed-form costs for the nodes of one
// planetary system — surface, low orbit, GEO, L5, escape, belt body — and the
// star-centred transfers between them. No integration, no Lambert solver, no
// patched conics beyond a single sphere of influence: every number is a closed
// form over the SystemRecord planets.js generated, which is what keeps the
// whole planet side CPU-only (plan §1.1) and allocation-free.
//
// The brief's bar is "not precise … just realistic looking"; the model below
// reproduces the published Solar-System map to a few percent, which is far
// past it. experiments/dv-map-test.js pins the whole table.
//
// Units: dv in km/s, distances in metres, time in seconds. The constants are
// §7.2's — a tolerance failure means one of them is wrong, not the test.

'use strict';

// planets.js owns the physical constants, the atmosphere codes and the bulk
// codes the nodes are gated on; reusing them is the same one-table rule the
// system layer follows. It loads before this file in the page, so the lookup
// is a require in Node and a window read in the browser.
const dvPlanets = (typeof module !== 'undefined' && module.exports)
	? require('../math/planets.js')
	: window.PlanetsLib;

const G_SI = dvPlanets.G_SI;
const M_SUN_KG = dvPlanets.M_SUN_KG;
const M_EARTH_KG = dvPlanets.M_EARTH_KG;
const R_EARTH_M = dvPlanets.R_EARTH_M;
const AU_M = dvPlanets.AU_M;
const KM = 1000;
const MPS_TO_KMS = 0.001;

// ---- the authored constants (§7.2) ---------------------------------------
const LAUNCH_LOSS = 1.20;              // gravity + steering losses
// Per atmosphere code (planets.js ATM_NONE … ATM_HHE): the drag a launch
// fights, the share of the capture burn aerodynamics can absorb, and the
// share of the launch burn a landing gives back. H/He is "not applicable" in
// §7.2's table — a gas giant has no surface to catch on or land on — which is
// the same as no atmosphere at all: no credit, the propulsive burn stands.
const DRAG_KM_S = new Float64Array([0, 0.15, 0.35, 0.80, 1.50]);
const AERO_FRACTION = new Float64Array([0, 0.40, 0.60, 0.70, 0]);
const LAND_CREDIT = new Float64Array([0, 0.65, 0.98, 0.95, 0]);
const DEORBIT_DV = 0.15;               // km/s: the floor of a landing burn
const L5_PHASE = 0.02;                 // the 60° drift is time, not energy
const L5_PHASE_FRACTION = 0.25;        // … and it costs a quarter of an orbit
const ORBIT_H_MIN_KM = 200;            // low orbit: h = max(200 km, 0.04·R_p)
const ORBIT_H_FRACTION = 0.04;
const GEO_ROT_MAX_H = 1000;            // a slower rotator has no meaningful GEO
const GEO_HILL_FRACTION = 0.4;         // a_geo < 0.4·r_Hill, or it is not bound

// The energy budget (§7.4): [0, 1] of the engine the viewer will burn on a
// leg, mapped logarithmically against the ship's ceiling. Default 0.35.
const BUDGET_MIN = 0, BUDGET_MAX = 1, BUDGET_DEFAULT = 0.35;

// Node codes, one bit each: a body carries the set it can have as a bitmask,
// and the map's graph walks the same codes as array indices.
const NODE_SURFACE = 1, NODE_LOW_ORBIT = 2, NODE_GEO = 4, NODE_L5 = 8,
	NODE_ESCAPE = 16, NODE_BELT_BODY = 32;
const NODE_COUNT = 6;
const NODE_NAMES = ['surface', 'low orbit', 'GEO', 'L5', 'escape', 'belt body'];
const NODE_SHORT = ['surf', 'LEO', 'GEO', 'L5', 'esc', 'belt'];

// Ship classes (§8.1). The table ships here rather than in route.js because
// §7.4's budget mapping consumes it a release earlier; route.js reads it from
// this module. dv in km/s, accel in m/s², cruise in fractions of c (0 for the
// in-system classes), life support in years (Infinity for a generation hull).
const DOMAIN_IN_SYSTEM = 0, DOMAIN_INTERSTELLAR = 1, DOMAIN_BOTH = 2;
const SHIP_CLASSES = [
	{ name: 'chemical', accel: 3, dv: 20, cruiseC: 0, cargo: 20, crew: 6, lifeSupportY: 2, domain: DOMAIN_IN_SYSTEM },
	{ name: 'nuclear', accel: 1, dv: 40, cruiseC: 0, cargo: 80, crew: 12, lifeSupportY: 4, domain: DOMAIN_IN_SYSTEM },
	{ name: 'fusion', accel: 0.3, dv: 12000, cruiseC: 0.02, cargo: 2000, crew: 40, lifeSupportY: 30, domain: DOMAIN_BOTH },
	{ name: 'stardrive', accel: 10, dv: 200000, cruiseC: 0.10, cargo: 20000, crew: 200, lifeSupportY: 200, domain: DOMAIN_INTERSTELLAR },
	{ name: 'generation', accel: 0.001, dv: 6000, cruiseC: 0.005, cargo: 1000000, crew: 5000, lifeSupportY: Infinity, domain: DOMAIN_INTERSTELLAR },
];
const SHIP_DEFAULT = 'chemical';

function shipIndex(name) {
	for (let i = 0; i < SHIP_CLASSES.length; i++) {
		if (SHIP_CLASSES[i].name === name) return i;
	}
	return 0;
}

// ---- bodies (§7.1) --------------------------------------------------------
// One body's node set and geometry, derived from a record row. Struct-of-one,
// preallocated: the map holds one array of these per system and mutates them in
// place, and the headless test builds its own.
const BODY_KIND_PLANET = 0, BODY_KIND_BELT = 1;

function createBody() {
	return {
		kind: BODY_KIND_PLANET, index: 0,
		massEarth: 0, radiusEarth: 0, rotHours: 0, atmosphere: dvPlanets.ATM_NONE,
		aAu: 0, periodYr: 0,
		mu: 0, rLoM: 0, geoM: 0, hillM: 0, starMu: 0,
		nodes: 0,
	};
}

// The node bitmask, once mu / r_lo / a_geo / r_Hill are known.
function computeNodes(body) {
	let nodes = NODE_LOW_ORBIT | NODE_ESCAPE;
	if (body.rotHours > 0 && body.rotHours < GEO_ROT_MAX_H
		&& body.geoM < GEO_HILL_FRACTION * body.hillM) nodes |= NODE_GEO;
	if (body.kind === BODY_KIND_PLANET) {
		// §7.1: L5 exists while the planet is not locked to another body. The
		// model has no moon bodies (§4.8 gives a count), so nothing locks a
		// planet and the rule never bites — a star-locked hot Jupiter keeps its
		// co-orbital point, because the star is not "another body".
		nodes |= NODE_L5;
		const bulk = body.bulk;
		if (bulk === dvPlanets.BULK_ROCK || bulk === dvPlanets.BULK_ICE
			|| bulk === dvPlanets.BULK_SUPER || bulk === dvPlanets.BULK_DWARF) nodes |= NODE_SURFACE;
	} else {
		nodes |= NODE_BELT_BODY;
	}
	body.nodes = nodes;
	return body;
}

// Everything the leg formulas need, from the two numbers a body is made of:
// its mass and radius. `starMassSolar` is the primary it orbits.
function finishBody(body, starMassSolar) {
	body.mu = G_SI * body.massEarth * M_EARTH_KG;
	const radiusM = body.radiusEarth * R_EARTH_M;
	const h = Math.max(ORBIT_H_MIN_KM * KM, ORBIT_H_FRACTION * radiusM);
	body.rLoM = radiusM + h;
	body.starMu = G_SI * starMassSolar * M_SUN_KG;
	if (body.rotHours > 0) {
		const omega = (Math.PI * 2) / (body.rotHours * 3600);
		body.geoM = Math.cbrt(body.mu / (omega * omega));
	}
	const aM = body.aAu * AU_M;
	body.hillM = aM * Math.cbrt((body.massEarth * M_EARTH_KG) / (3 * starMassSolar * M_SUN_KG));
	return computeNodes(body);
}

function bodyFromRecord(out, record, p) {
	const planets = record.planets;
	out.kind = BODY_KIND_PLANET;
	out.index = p;
	out.bulk = planets.bulk[p];
	out.massEarth = planets.mass[p];
	out.radiusEarth = planets.radius[p];
	out.rotHours = planets.rotHours[p];
	out.atmosphere = dvPlanets.DISPLAY_ATMOSPHERE[planets.display[p]];
	out.aAu = planets.a[p];
	out.periodYr = planets.period[p];
	return finishBody(out, record.star.mass);
}

// A belt's typical body (§4.7): the Ceres-analog constants, so every belt in
// the galaxy is one node with the same numbers.
function beltFromRecord(out, record, b) {
	out.kind = BODY_KIND_BELT;
	out.index = b;
	out.bulk = dvPlanets.BULK_DWARF;
	out.massEarth = dvPlanets.BELT_TYPICAL_MASS_KG / M_EARTH_KG;
	out.radiusEarth = dvPlanets.BELT_TYPICAL_R_M / R_EARTH_M;
	out.rotHours = 0;
	out.atmosphere = dvPlanets.ATM_NONE;
	out.aAu = record.belts.a[b];
	out.periodYr = Math.sqrt((out.aAu * out.aAu * out.aAu) / record.star.mass);
	return finishBody(out, record.star.mass);
}

function bodyFromSystem(out, record, kind, index) {
	return kind === BODY_KIND_BELT ? beltFromRecord(out, record, index) : bodyFromRecord(out, record, index);
}

// A body's grounded node — the surface for a solid body, the belt body for a
// belt. The launch and landing legs start and end here.
function groundNode(body) {
	return body.kind === BODY_KIND_BELT ? NODE_BELT_BODY : NODE_SURFACE;
}

// ---- the primitive closed forms (§7.2) ------------------------------------
function vCirc(mu, rM) { return Math.sqrt(mu / rM); }

// SURFACE → LOW_ORBIT: the launch loss plus the drag the atmosphere adds.
function launchDv(body) {
	return MPS_TO_KMS * (LAUNCH_LOSS * vCirc(body.mu, body.rLoM)) + DRAG_KM_S[body.atmosphere];
}

// LOW_ORBIT → SURFACE: the launch cost back, minus what the atmosphere gives.
function landDv(body) {
	const credit = LAND_CREDIT[body.atmosphere];
	const value = launchDv(body) * (1 - credit);
	return value > DEORBIT_DV ? value : DEORBIT_DV;
}

// LOW_ORBIT → ESCAPE: the parabolic excess, C3 = 0.
function escapeDv(body) {
	return MPS_TO_KMS * (Math.SQRT2 - 1) * vCirc(body.mu, body.rLoM);
}

// LOW_ORBIT → GEO: the two Hohmann burns of the transfer ellipse, in km/s.
function geoDv(body) {
	if (!(body.nodes & NODE_GEO)) return -1;
	const rLo = body.rLoM, aGeo = body.geoM;
	const vLo = vCirc(body.mu, rLo), vGeo = vCirc(body.mu, aGeo);
	const ratioLo = Math.sqrt((2 * aGeo) / (rLo + aGeo));
	const ratioGeo = Math.sqrt((2 * rLo) / (rLo + aGeo));
	return MPS_TO_KMS * (vLo * (ratioLo - 1) + vGeo * (1 - ratioGeo));
}

// LOW_ORBIT → L5: the escape plus the low-thrust drift to 60° ahead.
function l5Dv(body) {
	return escapeDv(body) + L5_PHASE * vCirc(body.starMu, body.aAu * AU_M) * MPS_TO_KMS;
}

function l5TimeYr(body) {
	return L5_PHASE_FRACTION * body.periodYr;
}

// ---- star-centred transfers (§7.2) ----------------------------------------
// The departure burn from a circular orbit at a1 onto the Hohmann ellipse to
// a2, in km/s. Burning it at the low-orbit periapsis is also the escape: the
// vis-viva excess that leaves the primary's well is carried by this one burn,
// so the inter-body chain does not add a separate C3 = 0 burn on top (§7.3's
// surface→surface pin and §6.6's example are the no-double-count numbers).
function transferDepartDv(starMu, a1Au, a2Au) {
	const v1 = vCirc(starMu, a1Au * AU_M);
	return MPS_TO_KMS * Math.abs(v1 * (Math.sqrt((2 * a2Au) / (a1Au + a2Au)) - 1));
}

// The arrival excess at a2 — the capture's v_inf, in km/s.
function transferArriveDv(starMu, a1Au, a2Au) {
	const v2 = vCirc(starMu, a2Au * AU_M);
	return MPS_TO_KMS * Math.abs(v2 * (1 - Math.sqrt((2 * a1Au) / (a1Au + a2Au))));
}

function transferTimeYr(starMu, a1Au, a2Au) {
	const aM = ((a1Au + a2Au) / 2) * AU_M;
	return Math.PI * Math.sqrt((aM * aM * aM) / starMu) / (365.25 * 86400);
}

// The Hohmann half-ellipse the leg flies, as an arc length in metres: §7.4's
// `d`, the choice the brachistochrone crossover is calibrated against.
function transferArcM(a1Au, a2Au) {
	return Math.PI * ((a1Au + a2Au) / 2) * AU_M;
}

// Capture from v_inf into low orbit: kill the excess, then circularise.
function captureDv(body, vInfKms) {
	const vInf = vInfKms / MPS_TO_KMS;
	return MPS_TO_KMS * (Math.sqrt(vInf * vInf + 2 * body.mu / body.rLoM) - vCirc(body.mu, body.rLoM));
}

// …with the atmosphere's share aerodynamically absorbed. An atmosphere the
// body has none of — and H/He, which has no surface to catch on — claims no
// credit and the propulsive burn stands.
function captureDvAero(body, vInfKms) {
	const cap = captureDv(body, vInfKms);
	return cap > 0 ? cap * (1 - AERO_FRACTION[body.atmosphere]) : 0;
}

// ---- the leg chain (§7.2) -------------------------------------------------
// One leg between two bodies, endpoint nodes included, written into `out`.
// `out.dv` is the mission number — aerocapture at the destination where the
// atmosphere offers it — and `out.dvMin` the same chain fully propulsive, the
// conservative floor the budget blend of §7.4 interpolates from.
function createLeg() {
	return {
		fromKind: BODY_KIND_PLANET, fromIndex: 0, fromNode: NODE_LOW_ORBIT,
		toKind: BODY_KIND_PLANET, toIndex: 0, toNode: NODE_LOW_ORBIT,
		depKms: 0, arrKms: 0, arrAeroKms: 0, launchKms: 0, landKms: 0,
		dv: 0, dvMin: 0, tHYr: 0, arcM: 0,
	};
}

function legBetween(out, from, fromNode, to, toNode) {
	const starMu = from.starMu;
	out.fromKind = from.kind;
	out.fromIndex = from.index;
	out.fromNode = fromNode;
	out.toKind = to.kind;
	out.toIndex = to.index;
	out.toNode = toNode;
	out.launchKms = fromNode === groundNode(from) ? launchDv(from) : 0;
	out.landKms = toNode === groundNode(to) ? landDv(to) : 0;
	const vInf = transferArriveDv(starMu, from.aAu, to.aAu);
	out.depKms = transferDepartDv(starMu, from.aAu, to.aAu);
	out.arrKms = captureDv(to, vInf);
	out.arrAeroKms = captureDvAero(to, vInf);
	out.tHYr = transferTimeYr(starMu, from.aAu, to.aAu);
	out.arcM = transferArcM(from.aAu, to.aAu);
	out.dv = out.launchKms + out.depKms + out.arrAeroKms + out.landKms;
	out.dvMin = out.launchKms + out.depKms + out.arrKms + out.landKms;
	return out;
}

// One departure leg between the body's grounded node and a node above it:
// surface → low orbit, or low orbit → GEO / L5 / escape. -1 when the body has
// no such node — no surface to leave, or no geostationary radius. This is the
// first row group the §7.5 table lists for the selected body; the arrival
// direction (low orbit → surface) is the chain's landing leg, `landDv`.
function nodeLegDv(body, node) {
	if (node === NODE_LOW_ORBIT) {
		return body.nodes & (NODE_SURFACE | NODE_BELT_BODY) ? launchDv(body) : -1;
	}
	if (node === NODE_GEO) return geoDv(body);
	if (node === NODE_ESCAPE) return escapeDv(body);
	if (node === NODE_L5) return l5Dv(body);
	return -1;
}

// The time the L5 leg's low-thrust drift takes, in years (§7.2: the 60° is
// time, not energy). Zero for every other node.
function nodeLegTimeYr(body, node) {
	return node === NODE_L5 && (body.nodes & NODE_L5) ? l5TimeYr(body) : 0;
}

// ---- travel time at an energy budget (§7.4) -------------------------------
// What this engine can spend on a leg of `arcM`: the brachistochrone dv the
// acceleration allows, or the tank, whichever binds first.
function dvCeilingKms(ship, arcM, dvRemainingKms) {
	const tank = dvRemainingKms === undefined ? ship.dv : dvRemainingKms;
	const brach = 2 * Math.sqrt(ship.accel * arcM) * MPS_TO_KMS;
	return brach < tank ? brach : tank;
}

// The budget slider, logarithmic: 0 is the minimum-energy number, 1 the ship's
// own ceiling on this leg.
function dvLegKms(dvMinKms, ceilingKms, budget) {
	if (!(dvMinKms > 0) || !(ceilingKms >= dvMinKms)) return dvMinKms;
	return dvMinKms * Math.pow(ceilingKms / dvMinKms, budget);
}

// The blend factor between the Hohmann ellipse and the constant-acceleration
// flip. Below dv_x a chemical tank buys nothing, and that flat region is the
// model saying out loud what a chemical rocket is.
function blendFactor(dvLegKms, dvMinKms, arcM, tHS) {
	const dvX = (4 * arcM) / tHS;               // m/s: the crossover
	const lo = dvMinKms * KM, hi = dvLegKms * KM;
	if (!(dvX > lo)) return 1;
	const s = (hi - lo) / (dvX - lo);
	return s < 0 ? 0 : (s > 1 ? 1 : s);
}

// t(dv): the ellipse below the crossover, the flip above it, exact at both
// ends and monotone non-increasing throughout.
function legTimeS(dvLegKms, dvMinKms, arcM, tHS) {
	const leg = Math.max(dvLegKms, dvMinKms) * KM;
	const dvX = (4 * arcM) / tHS;
	const tBrach = (4 * arcM) / (leg > dvX ? leg : dvX);
	const s = blendFactor(leg * MPS_TO_KMS, dvMinKms, arcM, tHS);
	return tHS * (1 - s) + tBrach * s;
}

// The departure wait a low-energy leg must sit out, scaled by the same blend:
// energy buys freedom from astronomy (§8.4 uses it for the synodic window).
function waitScale(dvLegKms, dvMinKms, arcM, tHS) {
	return 1 - blendFactor(dvLegKms, dvMinKms, arcM, tHS);
}

const DeltaVLib = {
	NODE_SURFACE, NODE_LOW_ORBIT, NODE_GEO, NODE_L5, NODE_ESCAPE, NODE_BELT_BODY,
	NODE_COUNT, NODE_NAMES, NODE_SHORT,
	BODY_KIND_PLANET, BODY_KIND_BELT,
	BUDGET_MIN, BUDGET_MAX, BUDGET_DEFAULT,
	LAUNCH_LOSS, DRAG_KM_S, AERO_FRACTION, LAND_CREDIT, DEORBIT_DV,
	L5_PHASE, L5_PHASE_FRACTION, ORBIT_H_MIN_KM, ORBIT_H_FRACTION,
	GEO_ROT_MAX_H, GEO_HILL_FRACTION,
	SHIP_CLASSES, SHIP_DEFAULT, shipIndex,
	DOMAIN_IN_SYSTEM, DOMAIN_INTERSTELLAR, DOMAIN_BOTH,
	createBody, createLeg,
	bodyFromRecord, beltFromRecord, bodyFromSystem, finishBody, computeNodes, groundNode,
	vCirc, launchDv, landDv, escapeDv, geoDv, l5Dv, l5TimeYr,
	transferDepartDv, transferArriveDv, transferTimeYr, transferArcM,
	captureDv, captureDvAero,
	legBetween, nodeLegDv, nodeLegTimeYr,
	dvCeilingKms, dvLegKms, blendFactor, legTimeS, waitScale,
};
if (typeof module !== 'undefined') module.exports = DeltaVLib;
if (typeof window !== 'undefined') window.DeltaVLib = DeltaVLib;
