// src/core/trade.js
// Commissioned trade routes (colony-economy-plan.md §6, ui.17): the standing
// convoy a founded colony pair runs between its ports. Two transit laws,
// selected by the Flight panel's sync checkbox:
//   fast       — scheduled freight at FAST_LY_Y. The transit is short enough
//                that stellar drift over it is ignored, so the arrival is a
//                plain ledger event at depart + distance/speed and no star
//                position is consulted after the departure snapshot.
//   generation — ships at GENERATION_LY_Y (1 ly per 10 ky). Over their
//                flights the stars drift further than the trip, so the
//                convoys home on the destination's live position every step
//                (the better route calculation the synced clock needs) and
//                the arrival is discovered, not scheduled. etaYears is the
//                first-order estimate the departure log carries.
// Pure laws over records; main.js owns when they run (the ledger drains at
// event boundaries, the homing steps with the economy clock).

'use strict';

const colonyTrade = (typeof module !== 'undefined' && module.exports)
	? require('./colony.js')
	: window.ColonyLib;

// --- units -----------------------------------------------------------------
// 1 kpc = 3261.56 ly (KPC_M over the ly in metres, 9.4607e15).
const KPC_LY = 3261.5638;
// The generation ship: 1 ly per 10 ky. In kpc/y that is 3.066e-8 — a star
// on a 220 km/s orbit drifts roughly 7x faster, which is why the law homes
// on the live position instead of plotting an intercept.
const GENERATION_LY_Y = 1e-4;
// Fast freight: 0.2 ly/y. A 10-100 ly hop is 50-500 y of economy time, over
// which a star drifts ~1e-4 kpc — negligible next to the trip, so no star
// movement calculation is consulted at all.
const FAST_LY_Y = 0.2;
// §6's standing cadence and cap; the origin never gives up the stock below
// its own GUARD_Y-year need.
const PERIOD_Y = 2;
const CAP_T = 50;
const GUARD_Y = 2;

function distLy(x1, y1, z1, x2, y2, z2) {
	const dx = x2 - x1, dy = y2 - y1, dz = z2 - z1;
	return Math.sqrt(dx * dx + dy * dy + dz * dz) * KPC_LY;
}

// --- the routes ------------------------------------------------------------
function createRoutes() {
	return { list: [], count: 0 };
}

// A standing route between two colonies (idx into main.js's colonies array).
// The first departure is one period out: the origin needs the time to
// produce something worth carrying.
function commissionRoute(routes, origin, dest, atY) {
	const route = { id: routes.count + 1, origin, dest, nextDepartY: atY + PERIOD_Y };
	routes.list.push(route);
	routes.count++;
	return route;
}

// --- the departure cargo (§6's guard, pure) ---------------------------------
// The origin's best export, capped at CAP_T, never taking the stock below
// its own GUARD_Y-year need. tons 0 = hold this departure: the period
// retries later; no event, no stock move.
function createCargoOut() {
	return { kind: 0, tons: 0 };
}

function departureCargo(origin, out) {
	const kind = colonyTrade.bestExport(origin);
	const need = GUARD_Y * origin.pop * colonyTrade.NEED[kind];
	let tons = origin.stock[kind] - need;
	if (tons > CAP_T) tons = CAP_T;
	out.kind = kind;
	out.tons = tons > 0 ? tons : 0;
	return out;
}

// --- the fast transit (scheduled) ------------------------------------------
function fastTransitY(dLy) {
	return dLy / FAST_LY_Y;
}

// --- the generation ETA (first-order intercept) -----------------------------
// The destination is where it will be: predicted linearly from its drawn
// velocity (kpc/y), iterated t -> |dest + vel*t - from| / v until it
// settles. A destination whose drift outruns the ship diverges; the ETA is
// then the last iterate and `diverged` says the convoy chases rather than
// intercepts — it still arrives, in its own time.
function etaYears(fx, fy, fz, tx, ty, tz, vx, vy, vz, vLyY) {
	const v = vLyY / KPC_LY;
	if (!(v > 0)) return { years: Infinity, diverged: true };
	let dx = tx - fx, dy = ty - fy, dz = tz - fz;
	let t = Math.sqrt(dx * dx + dy * dy + dz * dz) / v;
	if (!(t > 0)) return { years: 0, diverged: false };
	let diverged = false;
	let converged = false;
	for (let k = 0; k < 24; k++) {
		dx = tx + vx * t - fx; dy = ty + vy * t - fy; dz = tz + vz * t - fz;
		const tNext = Math.sqrt(dx * dx + dy * dy + dz * dz) / v;
		if (Math.abs(tNext - t) <= 1e-9 * Math.max(1, t)) { t = tNext; converged = true; break; }
		if (tNext > 4 * t) { diverged = true; t = tNext; break; }
		t = tNext;
	}
	// A flee that never outran the 4x fast path still fails to settle inside
	// the iteration budget: that is the chase, not an intercept. A diverged
	// report carries no intercept time at all — only the homing law knows
	// when the ship finally arrives.
	if (!converged && !diverged) diverged = true;
	if (diverged) t = Infinity;
	return { years: t, diverged };
}

// --- the convoys (generation law only; fast freight is ledger math) --------
function createConvoys() {
	const list = [];
	for (let i = 0; i < 8; i++) list.push({ route: 0, dest: 0, kind: 0, tons: 0, x: 0, y: 0, z: 0, departY: 0, etaY: 0 });
	return { list, count: 0 };
}

function spawnConvoy(convoys, route, dest, kind, tons, x, y, z, departY, etaY) {
	if (convoys.count === convoys.list.length) {
		convoys.list.push({ route: 0, dest: 0, kind: 0, tons: 0, x: 0, y: 0, z: 0, departY: 0, etaY: 0 });
	}
	const c = convoys.list[convoys.count++];
	c.route = route; c.dest = dest; c.kind = kind; c.tons = tons;
	c.x = x; c.y = y; c.z = z; c.departY = departY; c.etaY = etaY;
	return c;
}

// advanceConvoys' position target (module scratch — like colony.js's PROD,
// the function is an event/frame stepper, never nested).
const TARGET = new Float64Array(3);

// One homing step per convoy over dtY of economy time: aim at the
// destination's current position, advance v*dtY, arrive when the step
// covers the remaining gap. destPosOf(idx, out) always fills out (live
// drawn position or the founding fallback) — that contract is main.js's.
// Arrivals are handed to onArrive(convoy, econY); removal is swap-last.
function advanceConvoys(convoys, dtY, econY, destPosOf, onArrive) {
	if (!(dtY > 0) || convoys.count === 0) return 0;
	const v = GENERATION_LY_Y / KPC_LY;
	let arrived = 0;
	for (let i = convoys.count - 1; i >= 0; i--) {
		const c = convoys.list[i];
		destPosOf(c.dest, TARGET);
		const dx = TARGET[0] - c.x, dy = TARGET[1] - c.y, dz = TARGET[2] - c.z;
		const rem = Math.sqrt(dx * dx + dy * dy + dz * dz);
		const step = v * dtY;
		if (step >= rem) {
			c.x = TARGET[0]; c.y = TARGET[1]; c.z = TARGET[2];
			arrived++;
			if (onArrive) onArrive(c, econY);
			convoys.list[i] = convoys.list[convoys.count - 1];
			convoys.list[convoys.count - 1] = c;
			convoys.count--;
			continue;
		}
		const k = step / rem;
		c.x += dx * k; c.y += dy * k; c.z += dz * k;
	}
	return arrived;
}

const TradeLib = {
	KPC_LY, GENERATION_LY_Y, FAST_LY_Y, PERIOD_Y, CAP_T, GUARD_Y,
	distLy, createRoutes, commissionRoute,
	createCargoOut, departureCargo, fastTransitY, etaYears,
	createConvoys, spawnConvoy, advanceConvoys,
};
if (typeof module !== 'undefined') module.exports = TradeLib;
if (typeof window !== 'undefined') window.TradeLib = TradeLib;
