// src/math/deltav.js
// The delta-v map (0.5.4, plan §7): pure SI functions, `out` parameters,
// no allocations, no state. Everything is closed form — no Lambert solver,
// no patched conics beyond a single sphere of influence, no n-body.
// The model reproduces the published Solar-System delta-v map to a few
// percent (see experiments/dv-map-test.js for the pins).
//
// The module owns one body-struct extractor (paramOfBody / paramOfBelt)
// and three families of compute:
//   • one-body edges: SURFACE↔LOW_ORBIT, LOW_ORBIT↔GEO, LOW_ORBIT↔ESCAPE,
//                    LOW_ORBIT↔L5 (§7.2)
//   • two-body heliocentric transfer: hohmannStarFrame, departureBurnLo,
//     captureBurn, legDv (the single-burn-to-capture chain of §7.2)
//   • travel time at energy budget: legTimes, blending the Hohmann
//     ellipse against the brachistochrone limit (§7.4).
//
// A caller builds a per-system node table with buildBodyNodes and a
// per-pair edge table with buildInterEdges; nothing else in the module
// depends on the SystemRecord layout so tests can construct hand-made
// body tables directly.

(function () {
'use strict';

const planets = (typeof module !== 'undefined' && module.exports)
	? require('./planets.js')
	: ((typeof window !== 'undefined') ? window.PlanetsLib : null);

const TAU = Math.PI * 2;

// --- Physical constants (plan §4.1; mirrors planets.js values, not duplicated) -
const G_SI       = 6.674e-11;
const AU_M       = 1.495978707e11;
const M_SUN_KG   = 1.98892e30;
const M_EARTH_KG = 5.9722e24;
const R_EARTH_M  = 6.371e6;
const SECONDS_PER_DAY = 86400;
const SECONDS_PER_YEAR = SECONDS_PER_DAY * 365.25;
const HOURS_PER_DAY = 24;

// --- Authored constants (plan §7.2) -------------------------------------------
const LAUNCH_LOSS = 1.20;                // gravity + steering loss
const L5_PHASE    = 0.02;                // L5 spiral dv fraction of v_orb★
const L5_PHASE_FRACTION = 0.25;          // … in t: 90° drift / 360°
const DEORBIT_DV  = 150;                 // m/s, mandatory deorbit impulse

// Atmospheric columns keyed by the DISPLAY_TYPES atmosphere name (§4.2).
// DRAG[m/s]    — surface-to-LEO drag loss added to LAUNCH_LOSS·v_circ
// AERO         — fraction of dv_cap credited to aerocapture (capture leg)
// LAND         — fraction of dv_launch credited to atmospheric entry (landing leg)
const LAUNCH_DRAG_MS = { none: 0, thin: 150, breathable: 350, thick: 800, hhe: 1500 };
const AERO_FRACTION  = { none: 0, thin: 0.40, breathable: 0.60, thick: 0.70, hhe: 0 };
const LAND_CREDIT    = { none: 0, thin: 0.65, breathable: 0.98, thick: 0.95, hhe: 0 };

// Bodies without a surface node (§7.1): hhe worlds and super-sized worlds? —
// plan §7.1 says "giants have no surface: cloud-top only". That is exactly the
// 'hhe' atmosphere (MINI_NEPTUNE/GAS_GIANT/ICE_GIANT), which is also the class
// where aerocapture and landing credit are n/a (zeros above). §4.3 bulk=rock/ice/super/dwarf
// carry a surface; mini/gas/icegiant do not.
const BULKS_WITH_SURFACE = { rock: 1, ice: 1, super: 1, dwarf: 1 };

// GEO exists when rotation < 1000 h AND a_geo < 0.4·r_Hill (§7.1).
const GEO_MAX_ROT_H = 1000;
const GEO_HILL_FRAC = 0.4;

// Low-orbit altitude h = max(200 km, 0.04·R_p) (§7.1).
function lowOrbitRadiusM(radiusM) {
	const h = Math.max(200e3, 0.04 * radiusM);
	return radiusM + h;
}

// v_circ(r) = sqrt(mu/r)
function vCirc(mu, r) { return Math.sqrt(mu / r); }
// v_esc(r)  = sqrt(2·mu/r)
function vEsc(mu, r)  { return Math.sqrt(2 * mu / r); }

// mu(M) = G·M
function muOfMass(massKg) { return G_SI * massKg; }

// --- The body parameter struct a caller fills -------------------------------
// All quantities SI units (metres, kilograms, seconds, radians). `bulkKey` is
// the DISPLAY_TYPES bulk string ('rock','ice','super','dwarf','mini','gas','icegiant')
// — used to decide whether a SURFACE node exists. `atmKey` is the atmosphere
// column ('none','thin','breathable','thick','hhe') — three lookups share it.
// `rotHours` is the rotation period; values >= 1000 h (≈42 d) suppress GEO.
// `rHillM` is the planet's Hill radius; GEO must sit inside 0.4·rHillM.
// `aM` / `vOrbStar` are the star-relative orbital distance and circular
// velocity; 0 / 0 for the primary. `periodS` is the orbital period about the
// primary, in seconds (used for L5 phase time and synodic waits).
// `exists` flags on the returned node describe which nodes this body owns.

// paramOfBody fills `out` from a SystemRecord planet row (planets.planets[i]).
function paramOfBody(record, i, muStar, out) {
	const p = record.planets;
	const dType = planets.DISPLAY_TYPES[p.displayType[i]];
	const massKg = p.mass[i] * M_EARTH_KG;
	const radiusM = p.radius[i] * R_EARTH_M;
	const aM = p.a[i] * AU_M;
	out.mu       = G_SI * massKg;
	out.radiusM  = radiusM;
	out.massKg   = massKg;
	out.bulkKey  = dType.bulk;
	out.atmKey   = dType.atmosphere;
	out.hasSurface = (BULKS_WITH_SURFACE[dType.bulk] === 1);
	out.rLoM     = lowOrbitRadiusM(radiusM);
	out.vCircLo  = vCirc(out.mu, out.rLoM);
	out.vEscLo   = vEsc(out.mu, out.rLoM);
	// GEO synchronous radius: a_geo = (mu/ω²)^(1/3), ω = TAU/rotSeconds.
	const rotS = p.rotHours[i] * 3600;
	out.rotS = rotS;
	if (rotS > 0 && p.rotHours[i] < GEO_MAX_ROT_H) {
		const omega = TAU / rotS;
		const aGeo = Math.pow(out.mu / (omega * omega), 1 / 3);
		const rHillM = p.rHill[i] * AU_M;
		if (aGeo >= out.rLoM && aGeo < GEO_HILL_FRAC * rHillM) {
			out.aGeoM = aGeo;
			out.vGeo = vCirc(out.mu, aGeo);
			out.hasGeo = true;
		} else {
			out.aGeoM = 0; out.vGeo = 0; out.hasGeo = false;
		}
	} else {
		out.aGeoM = 0; out.vGeo = 0; out.hasGeo = false;
	}
	// L5: the planet is not tidally locked to anything (we have no moons as
	// bodies, §4.8, so every planet "not locked to another body" in the sense
	// of §7.1 — flags & FLAG_LOCKED means locked to the *star*, which is a
	// tidal/rotational state that does not suppress L5).
	out.hasL5 = true;
	out.aM       = aM;
	out.vOrbStar = vCirc(muStar, aM);
	out.periodS  = p.period[i] * SECONDS_PER_YEAR;
	out.incDeg   = p.inc[i];
	return out;
}

// paramOfBelt fills `out` for a belt's typical body (§4.7, §7.1): one
// hard-coded Ceres analog with 'none' atmosphere, 'dwarf' bulk.
function paramOfBelt(record, k, muStar, out) {
	const b = record.belts;
	const massKg = planets.BELT_BODY_MASS_KG;
	const radiusM = planets.BELT_BODY_R_M;
	const aM = b.a[k] * AU_M;
	out.mu       = G_SI * massKg;
	out.radiusM  = radiusM;
	out.massKg   = massKg;
	out.bulkKey  = 'dwarf';
	out.atmKey   = 'none';
	out.hasSurface = true;
	out.rLoM     = lowOrbitRadiusM(radiusM);
	out.vCircLo  = vCirc(out.mu, out.rLoM);
	out.vEscLo   = vEsc(out.mu, out.rLoM);
	out.aGeoM    = 0; out.vGeo = 0; out.hasGeo = false;
	// A belt body's rotation is not generated; §7.1 gives no GEO rule for it.
	out.hasL5    = false;
	out.aM       = aM;
	out.vOrbStar = vCirc(muStar, aM);
	out.periodS  = TAU * Math.sqrt(aM * aM * aM / muStar);
	out.incDeg   = 0;
	return out;
}

// --- One-body edges (§7.2) ---------------------------------------------------
// All return m/s. Results into `out` fields: { dv, ...contextual }.

// SURFACE → LOW_ORBIT: launch loss + drag
function dvSurfaceToLo(body, out) {
	const drag = LAUNCH_DRAG_MS[body.atmKey] || 0;
	const dv = LAUNCH_LOSS * body.vCircLo + drag;
	out.dv = dv;
	out.drag = drag;
	out.loss = LAUNCH_LOSS * body.vCircLo;
	return dv;
}

// LOW_ORBIT → SURFACE: deorbit impulse + (1 − LAND_CREDIT)·launch dv
function dvLoToSurface(body, out) {
	const launch = LAUNCH_LOSS * body.vCircLo + (LAUNCH_DRAG_MS[body.atmKey] || 0);
	const credit = LAND_CREDIT[body.atmKey] || 0;
	const dv = Math.max(DEORBIT_DV, launch * (1 - credit));
	out.dv = dv;
	out.credit = credit;
	out.launch = launch;
	return dv;
}

// LOW_ORBIT → GEO: Hohmann transfer between the two circular orbits about
// the same body — two burns (perigee raise + apogee circularise).
function dvLoToGeo(body, out) {
	const rLo = body.rLoM;
	const aGeo = body.aGeoM;
	const mu = body.mu;
	const vLo = body.vCircLo;
	const vGeo = body.vGeo;
	// dv1 = v_circ(rLo)·(sqrt(2·aGeo/(rLo+aGeo)) − 1)
	// dv2 = v_circ(aGeo)·(1 − sqrt(2·rLo/(rLo+aGeo)))
	const sma = (rLo + aGeo) * 0.5;
	const dv1 = vLo * (Math.sqrt(2 * aGeo / (rLo + aGeo)) - 1);
	const dv2 = vGeo * (1 - Math.sqrt(2 * rLo / (rLo + aGeo)));
	const dv = dv1 + dv2;
	out.dv = dv;
	out.dv1 = dv1;
	out.dv2 = dv2;
	out.sma = sma;
	return dv;
}

// LOW_ORBIT → ESCAPE (C3 = 0): (√2 − 1)·v_circ(r_lo)
function dvLoToEscape(body, out) {
	const dv = (Math.SQRT2 - 1) * body.vCircLo;
	out.dv = dv;
	return dv;
}

// LOW_ORBIT → L5: escape + L5_PHASE spiral; t = L5_PHASE_FRACTION·P_orb.
function dvLoToL5(body, out) {
	const esc = (Math.SQRT2 - 1) * body.vCircLo;
	const phaseDv = L5_PHASE * body.vOrbStar;
	const dv = esc + phaseDv;
	out.dv = dv;
	out.escape = esc;
	out.phase = phaseDv;
	out.timeS = L5_PHASE_FRACTION * body.periodS;
	return dv;
}

// --- Two-body heliocentric transfer (§7.2) -----------------------------------
// All in SI; muStar = G·M★; a1/a2 = orbital radii in metres.
// Returns heliocentric (escape-node) dv_dep, dv_arr and Hohmann transfer time
// t_H (seconds) in the out struct.
function hohmannStarFrame(muStar, a1, a2, out) {
	// v_orb(a) = sqrt(mu/a)
	const v1 = Math.sqrt(muStar / a1);
	const v2 = Math.sqrt(muStar / a2);
	const dvDep = Math.abs(v1 * (Math.sqrt(2 * a2 / (a1 + a2)) - 1));
	const dvArr = Math.abs(v2 * (1 - Math.sqrt(2 * a1 / (a1 + a2))));
	const aT = (a1 + a2) * 0.5;
	const tH = Math.PI * Math.sqrt((aT * aT * aT) / muStar);
	out.dvDep = dvDep;
	out.dvArr = dvArr;
	out.tH = tH;
	out.aT = aT;
	return out;
}

// Departure from low orbit, with the transfer's own excess (Oberth):
// dv_dep_lo = sqrt(v_esc(r_lo)² + dv_dep²) − v_circ(r_lo)
function departureBurnLo(body, dvDepStar, out) {
	const dv = Math.sqrt(body.vEscLo * body.vEscLo + dvDepStar * dvDepStar) - body.vCircLo;
	out.dv = dv;
	return dv;
}

// Capture into low orbit from v_inf = dv_arr, with aerocapture credit:
// dv_cap       = sqrt(v_inf² + 2·mu_p/r_lo) − v_circ(r_lo)
// dv_arr_orbit = max(0, dv_cap·(1 − AERO_FRACTION[atm]))
// When `propulsive` is true the aerocapture fraction is forced to 0.
function captureBurn(body, vInf, propulsive, out) {
	const dvCap = Math.sqrt(vInf * vInf + 2 * body.mu / body.rLoM) - body.vCircLo;
	const aeroFrac = propulsive ? 0 : (AERO_FRACTION[body.atmKey] || 0);
	const dv = Math.max(0, dvCap * (1 - aeroFrac));
	out.dv = dv;
	out.dvCap = dvCap;
	out.aeroFrac = aeroFrac;
	return dv;
}

// The full low-orbit→low-orbit leg chain between A and B (§7.2):
// dv_leg = dv_dep_lo(A) + dv_arr_orbit(B), with heliocentric dv_dep/dv_arr
// reported separately so the escape-node reading can be printed.
function legLoToLo(muStar, bodyA, bodyB, propulsive, out) {
	const a1 = bodyA.aM, a2 = bodyB.aM;
	// Inward vs outward — formulas are symmetric in absolute value; we still
	// compute the forward direction because capture on A/B differs in body.
	hohmannStarFrame(muStar, a1, a2, out);
	departureBurnLo(bodyA, out.dvDep, out);
	out.dvDepLo = out.dv;
	out.dvDepStar = out.dvDep;
	captureBurn(bodyB, out.dvArr, propulsive, out);
	out.dvCapB = out.dv;
	out.dvCapRawB = out.dvCap;
	out.aeroFracB = out.aeroFrac;
	out.dvArrStar = out.dvArr;
	out.dvLoToLo = out.dvDepLo + out.dvCapB;
	// Path length d = π·(a1+a2)/2 metres (the Hohmann half-ellipse arc, §7.4)
	// and the crossover dv at which brachistochrone beats the ellipse.
	out.arcM = Math.PI * 0.5 * (a1 + a2);
	out.dvX = 4 * out.arcM / out.tH;
	// Phase/synodic wait for the alignment window (plan §8.4):
	// t_syn = 2π/|n1 − n2|, n = 2π/P ⇒ t_syn = P1·P2/|P2 − P1|.
	const P1 = bodyA.periodS, P2 = bodyB.periodS;
	const tSyn = P1 === P2 ? Infinity : Math.abs(P1 * P2 / (P2 - P1));
	out.tWaitSyn = tSyn;
	return out;
}

// --- Travel time at an energy budget (§7.4) ---------------------------------
// ship is { accel: m/s², dvMax: m/s } — accel ceiling from the class table,
// dvMax is the tank (remaining for this leg, but 0.5.4 does not track routes
// yet: callers pass ship.dv for single-leg budgeting).
// budget ∈ [0,1] logarithmic: 0 → dv_min, 1 → dv_ceiling.
// out returns { dvLeg, s, tHS, tBrach, t, tWait, accelRequired, feasible }.
function legTimes(leg, ship, budget, out) {
	const dvMin = leg.dvLoToLo;
	const d = leg.arcM;
	const tH = leg.tH;
	const dvX = leg.dvX;
	// dv_ceiling = min(2·sqrt(a·d), ship.dvMax)
	const dvAccel = 2 * Math.sqrt(Math.max(0, ship.accel) * d);
	const dvCeiling = Math.min(dvAccel, Math.max(0, ship.dvMax));
	const b = budget < 0 ? 0 : budget > 1 ? 1 : budget;
	let dvLeg;
	if (dvMin <= 0 || dvCeiling <= dvMin || !(isFinite(dvCeiling))) {
		dvLeg = dvMin;
	} else {
		// logarithmic: dv_leg = dv_min·(dv_ceiling/dv_min)^budget
		dvLeg = dvMin * Math.pow(dvCeiling / dvMin, b);
	}
	const s = dvX > dvMin ? (dvLeg - dvMin) / (dvX - dvMin) : 1;
	const sClamp = s < 0 ? 0 : s > 1 ? 1 : s;
	const tBrach = dvLeg > 0 ? 4 * d / Math.max(dvLeg, dvX) : Infinity;
	const t = tH * (1 - sClamp) + tBrach * sClamp;
	// Wait scales with (1 − s): more energy → less need for alignment.
	const tWait = sClamp === 1 ? 0 : leg.tWaitSyn * (1 - sClamp);
	// Feasibility: required accel a = dv²/(4d) ≤ ship.accel AND dv ≤ tank.
	const aRequired = (d > 0) ? (dvLeg * dvLeg) / (4 * d) : 0;
	const feasible = dvLeg <= ship.dvMax + 1e-6 && aRequired <= ship.accel + 1e-9;
	out.dvMin = dvMin;
	out.dvCeiling = dvCeiling;
	out.dvLeg = dvLeg;
	out.s = sClamp;
	out.tH = tH;
	out.tBrach = tBrach;
	out.t = t;
	out.tWait = tWait;
	out.aRequired = aRequired;
	out.feasible = feasible;
	out.belowCrossover = (dvLeg <= dvX);
	return out;
}

// --- Per-system node & edge builder ------------------------------------------
// buildBodyNodes(record, bodies, nodes, edges): fills two parallel arrays
// (MAX_BODIES = planets.MAX_PLANETS + planets.MAX_BELTS) for the opened
// record. `bodies[i]` receives the body param struct; `nodes[i]` is a
// descriptor of which nodes exist for that body; `edges[i]` is the one-body
// edge set (surface↔lo, lo↔geo, lo↔escape, lo↔L5).
const MAX_BODIES = planets.MAX_PLANETS + planets.MAX_BELTS;

function createBodyParam() {
	return {
		mu: 0, radiusM: 0, massKg: 0,
		bulkKey: 'rock', atmKey: 'none', hasSurface: false,
		rLoM: 0, vCircLo: 0, vEscLo: 0,
		rotS: 0, aGeoM: 0, vGeo: 0, hasGeo: false,
		hasL5: false,
		aM: 0, vOrbStar: 0, periodS: 0, incDeg: 0,
	};
}

function createNodeSet() {
	return {
		kind: 0,       // 0=planet, 1=belt
		index: -1,
		letter: '',    // 'b' / 'c' / … or 'belt 1'
		hasSurface: false, hasLo: true, hasGeo: false, hasEscape: true, hasL5: false,
		// precomputed labels: used by the graph drawer + table
		label: '',
	};
}

function createOneBodyEdges() {
	return {
		dvSurfaceToLo: 0, dvLoToSurface: 0,
		dvLoToGeo: 0, dvLoToEscape: 0, dvLoToL5: 0,
		tL5S: 0,
		// cached drag breakdown for the readout
		surfaceDrag: 0, surfaceLoss: 0,
		landCredit: 0, landLaunch: 0,
		geoDv1: 0, geoDv2: 0,
		l5Escape: 0, l5Phase: 0,
	};
}

function createInterEdge() {
	return {
		i: -1, j: -1,
		dvDepLo: 0, dvDepStar: 0, dvCapB: 0, dvCapRawB: 0, aeroFracB: 0,
		dvArrStar: 0, dvLoToLo: 0, tH: 0, arcM: 0, dvX: 0, tWaitSyn: 0,
	};
}

function buildBodyNodes(record, bodies, nodes, edges) {
	const muStar = G_SI * record.star.mass * M_SUN_KG;
	const nPlanets = record.counts.planets;
	const nBelts = record.belts.count;
	let total = 0;
	for (let i = 0; i < nPlanets; i++) {
		const body = bodies[total];
		paramOfBody(record, i, muStar, body);
		const ns = nodes[total];
		ns.kind = 0; ns.index = i;
		ns.letter = String.fromCharCode(98 + i);
		const dType = planets.DISPLAY_TYPES[record.planets.displayType[i]];
		ns.label = dType.name;
		ns.hasSurface = body.hasSurface;
		ns.hasLo = true;
		ns.hasGeo = body.hasGeo;
		ns.hasEscape = true;
		ns.hasL5 = body.hasL5;
		// one-body edges
		const ed = edges[total];
		const surfUp = {}; dvSurfaceToLo(body, surfUp);
		ed.dvSurfaceToLo = surfUp.dv; ed.surfaceLoss = surfUp.loss; ed.surfaceDrag = surfUp.drag;
		const surfDown = {}; dvLoToSurface(body, surfDown);
		ed.dvLoToSurface = surfDown.dv; ed.landCredit = surfDown.credit; ed.landLaunch = surfDown.launch;
		if (body.hasGeo) {
			const geo = {}; dvLoToGeo(body, geo);
			ed.dvLoToGeo = geo.dv; ed.geoDv1 = geo.dv1; ed.geoDv2 = geo.dv2;
		} else { ed.dvLoToGeo = 0; ed.geoDv1 = 0; ed.geoDv2 = 0; }
		const esc = {}; dvLoToEscape(body, esc);
		ed.dvLoToEscape = esc.dv;
		const l5 = {}; dvLoToL5(body, l5);
		ed.dvLoToL5 = body.hasL5 ? l5.dv : 0;
		ed.tL5S = body.hasL5 ? l5.timeS : 0;
		ed.l5Escape = l5.escape; ed.l5Phase = l5.phase;
		total++;
	}
	for (let k = 0; k < nBelts; k++) {
		const body = bodies[total];
		paramOfBelt(record, k, muStar, body);
		const ns = nodes[total];
		ns.kind = 1; ns.index = k;
		ns.letter = 'belt' + (k + 1);
		ns.label = 'belt ' + (k + 1);
		ns.hasSurface = true;          // Ceres-analog: solid body
		ns.hasLo = true;
		ns.hasGeo = false;
		ns.hasEscape = true;
		ns.hasL5 = false;              // a belt body is not a primary neighbour
		const ed = edges[total];
		const surfUp = {}; dvSurfaceToLo(body, surfUp);
		ed.dvSurfaceToLo = surfUp.dv; ed.surfaceLoss = surfUp.loss; ed.surfaceDrag = surfUp.drag;
		const surfDown = {}; dvLoToSurface(body, surfDown);
		ed.dvLoToSurface = surfDown.dv; ed.landCredit = surfDown.credit; ed.landLaunch = surfDown.launch;
		ed.dvLoToGeo = 0; ed.geoDv1 = 0; ed.geoDv2 = 0;
		const esc = {}; dvLoToEscape(body, esc);
		ed.dvLoToEscape = esc.dv;
		ed.dvLoToL5 = 0; ed.tL5S = 0; ed.l5Escape = 0; ed.l5Phase = 0;
		total++;
	}
	// Return the number filled, so callers can walk.
	return total;
}

// Builds the unique body-pair inter edges: for a system with N bodies there
// are N·(N−1)/2 unordered pairs; we store i<j and the dv is symmetric in
// departure/arrival magnitudes (the hohmann formulas are directionally
// symmetric for dv_dep/dv_arr; a reverse leg simply swaps A and B, which
// is what captureBurn on the other end handles). This file computes forward
// (i→j) and the table is directional: i to j departs i, arrives j.
function buildInterEdges(muStar, bodies, nBodies, interEdges) {
	let filled = 0;
	for (let i = 0; i < nBodies; i++) {
		for (let j = 0; j < nBodies; j++) {
			if (i === j) continue;
			const out = interEdges[filled];
			out.i = i; out.j = j;
			legLoToLo(muStar, bodies[i], bodies[j], false, out);
			filled++;
		}
	}
	return filled;
}

// Lookup in interEdges (N·(N−1) entries, index i*(N−1) + (j > i ? j−1 : j)).
function interEdgeIndex(nBodies, i, j) {
	// row i has (N−1) entries; j shifts by one when j > i (the diagonal slot
	// we skip is at column i in the square layout).
	const col = j > i ? j - 1 : j;
	return i * (nBodies - 1) + col;
}

// Shared ship table (plan §8.1); vCruise is a fraction of c, dvMax is m/s.
const SHIP_CLASSES = [
	{ id: 'chemical',   accel: 3,     dvMax: 20e3,     vCruise: 0, domain: 'in-system',       label: 'chemical', cargo: 20, crew: 6, lifeYears: 2, color: '#ffcc80' },
	{ id: 'nuclear',    accel: 1,     dvMax: 40e3,     vCruise: 0, domain: 'in-system',       label: 'nuclear', cargo: 80, crew: 12, lifeYears: 4, color: '#ffe680' },
	{ id: 'fusion',     accel: 0.3,   dvMax: 12e6,     vCruise: 0.02, domain: 'interstellar', label: 'fusion', cargo: 2000, crew: 40, lifeYears: 30, color: '#80e8ff' },
	{ id: 'stardrive',  accel: 10,    dvMax: 200e6,    vCruise: 0.10, domain: 'interstellar', label: 'stardrive', cargo: 20000, crew: 200, lifeYears: 200, color: '#bd9fff' },
	{ id: 'generation', accel: 0.001, dvMax: 6e6,      vCruise: 0.005, domain: 'interstellar', label: 'generation', cargo: 1000000, crew: 5000, lifeYears: Infinity, color: '#a4e890' },
];
function shipById(id) {
	for (let i = 0; i < SHIP_CLASSES.length; i++) {
		if (SHIP_CLASSES[i].id === id) return SHIP_CLASSES[i];
	}
	return SHIP_CLASSES[0];
}

// Format seconds into human readable: 'd' days, fractional days are kept
// for small values, years for > 365 d.  This is not the route.js formatter
// (0.5.5), just the readout.
function formatDuration(seconds) {
	const days = seconds / SECONDS_PER_DAY;
	if (days < 1) return (seconds / 3600).toFixed(1) + ' h';
	if (days < 10) return days.toFixed(1) + ' d';
	if (days < 100) return Math.round(days) + ' d';
	const years = days / 365.25;
	if (years < 1000) return years.toFixed(1) + ' y';
	return Math.round(years).toLocaleString('en-US') + ' y';
}

function formatKms(metersPerSecond) {
	return (metersPerSecond / 1000).toFixed(2);
}

// --- Exports ----------------------------------------------------------------
const DeltaVLib = {
	TAU,
	G_SI, AU_M, M_SUN_KG, M_EARTH_KG, R_EARTH_M, SECONDS_PER_DAY, SECONDS_PER_YEAR,
	LAUNCH_LOSS, LAUNCH_DRAG_MS, AERO_FRACTION, LAND_CREDIT, L5_PHASE, L5_PHASE_FRACTION,
	DEORBIT_DV, GEO_MAX_ROT_H, GEO_HILL_FRAC,
	BULKS_WITH_SURFACE,
	lowOrbitRadiusM, vCirc, vEsc, muOfMass,
	paramOfBody, paramOfBelt,
	dvSurfaceToLo, dvLoToSurface, dvLoToGeo, dvLoToEscape, dvLoToL5,
	hohmannStarFrame, departureBurnLo, captureBurn, legLoToLo, legTimes,
	createBodyParam, createNodeSet, createOneBodyEdges, createInterEdge,
	buildBodyNodes, buildInterEdges, interEdgeIndex,
	MAX_BODIES,
	SHIP_CLASSES, shipById,
	formatDuration, formatKms,
};
if (typeof module !== 'undefined') module.exports = DeltaVLib;
if (typeof window !== 'undefined') window.DeltaVLib = DeltaVLib;
})();
