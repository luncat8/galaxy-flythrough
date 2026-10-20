// src/core/colony.js
// The colony economy (colony-economy-plan.md): a deterministic per-system
// resource map, event-driven colony advances (arrive / inspect — never per
// frame), the port market, and the hold/credits trade math. Pure laws over
// session state; the wiring in main.js owns when they run.

'use strict';

// `hashColony`, not `hash`: the page evaluates every script in one shared
// global scope, and planets.js already owns the short name.
const hashColony = (typeof module !== 'undefined' && module.exports)
	? require('../math/hash.js')
	: window.HashLib;

// --- §1 resources ---------------------------------------------------------

// One unit = one ton of hold cargo. `base` is the price midpoint scale (cr/t).
const RESOURCES = [
	{ id: 'rare', label: 'rare elements', base: 8 },
	{ id: 'chem', label: 'special chemicals', base: 5 },
	{ id: 'anti', label: 'antimatter', base: 40 },
	{ id: 'food', label: 'food & biotech', base: 3 },
	{ id: 'fab', label: 'factory cores & robots', base: 10 },
	{ id: 'info', label: 'software & world data', base: 6 },
];
const RESOURCE_INDEX = {};
for (let i = 0; i < RESOURCES.length; i++) RESOURCE_INDEX[RESOURCES[i].id] = i;

// Production (t/y at ease 1, driver 1) — §3 step 1.
const RATE = [800, 800, 400, 2000, 600, 600];
// Consumption (t per 1k persons per y) — §3 step 2. Food dominates, per the
// draft: population grows only while its needs are met.
const NEED = [20, 1.0, 0.5, 0.2, 0.2, 0.05];

const N = RESOURCES.length;
const MAX_STEPS = 2048;
const BASE_DT = 0.25;             // y; the integration chunk while span allows
const JITTER = 0.12;              // the draft's "a bit of random", ±0.06
const COLONY_SEED_SALT = 0x43f6c0;

// --- §6 the event ledger (ui.17) -------------------------------------------
// Preallocated, insertion-sorted by `atY`: `schedule` keeps the order
// (binary search + shift), `dueEvents` drains the head while it is due,
// `cancel` drops matching events. Drained at event boundaries only, never
// per frame — the per-frame cost is the peek `count > 0 && at[0] <= toY`.
// Payloads: ROUTE_DEPART (a route idx), ROUTE_ARRIVE (a route idx,
// b resource kind, c tons), MILESTONE (a colony idx, c the pop threshold),
// FAMINE (a colony idx, b 1 entered / 0 lifted), EXPEDITION_ARRIVE
// (a expedition idx, ui.18 §9 — the fast-law founder landing).
const EV_ROUTE_DEPART = 0, EV_ROUTE_ARRIVE = 1, EV_MILESTONE = 2, EV_FAMINE = 3,
	EV_EXPEDITION_ARRIVE = 4;
const LEDGER_CAP = 64;
// Population milestones (k persons). The crossing years are events, so the
// GUI can narrate the colony without polling it; 40k is the carrying band's
// ceiling, a mature colony's last crossing.
const POP_MILESTONES = [0.5, 1, 2, 5, 10, 20, 40];

function createEventLedger() {
	return {
		at: new Float64Array(LEDGER_CAP),
		kind: new Int32Array(LEDGER_CAP),
		a: new Int32Array(LEDGER_CAP),
		b: new Int32Array(LEDGER_CAP),
		c: new Float64Array(LEDGER_CAP),
		count: 0,
	};
}

// Returns false when the ledger is full: the latest event is dropped, the
// head — what is due soonest — always survives.
function schedule(ledger, atY, kind, a, b, c) {
	if (ledger.count >= LEDGER_CAP) return false;
	let lo = 0, hi = ledger.count;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (ledger.at[mid] <= atY) lo = mid + 1; else hi = mid;
	}
	for (let i = ledger.count; i > lo; i--) {
		ledger.at[i] = ledger.at[i - 1]; ledger.kind[i] = ledger.kind[i - 1];
		ledger.a[i] = ledger.a[i - 1]; ledger.b[i] = ledger.b[i - 1]; ledger.c[i] = ledger.c[i - 1];
	}
	ledger.at[lo] = atY; ledger.kind[lo] = kind;
	ledger.a[lo] = a | 0; ledger.b[lo] = b | 0; ledger.c[lo] = c;
	ledger.count++;
	return true;
}

// Drains every event at or before toY, in order, into
// visit(kind, a, b, c, atY). Returns the number drained.
function dueEvents(ledger, toY, visit) {
	let drained = 0;
	while (ledger.count > 0 && ledger.at[0] <= toY) {
		visit(ledger.kind[0], ledger.a[0], ledger.b[0], ledger.c[0], ledger.at[0]);
		for (let i = 1; i < ledger.count; i++) {
			ledger.at[i - 1] = ledger.at[i]; ledger.kind[i - 1] = ledger.kind[i];
			ledger.a[i - 1] = ledger.a[i]; ledger.b[i - 1] = ledger.b[i]; ledger.c[i - 1] = ledger.c[i];
		}
		ledger.count--;
		drained++;
	}
	return drained;
}

function cancel(ledger, kind, a) {
	let removed = 0;
	for (let i = 0; i < ledger.count; i++) {
		if (ledger.kind[i] !== kind || ledger.a[i] !== (a | 0)) continue;
		for (let j = i + 1; j < ledger.count; j++) {
			ledger.at[j - 1] = ledger.at[j]; ledger.kind[j - 1] = ledger.kind[j];
			ledger.a[j - 1] = ledger.a[j]; ledger.b[j - 1] = ledger.b[j]; ledger.c[j - 1] = ledger.c[j];
		}
		ledger.count--;
		removed++;
		i--;
	}
	return removed;
}

// --- §2 the resource map --------------------------------------------------

function clamp01(v) {
	return v < 0 ? 0 : v > 1 ? 1 : v;
}

function createResourceMap() {
	return { ease: new Float64Array(N), score: 0 };
}

// Pure: the same record and seed fill the same map, every call. `record` is
// a generateSystem() output; `seed` is the model seed (the caller's model).
function resourceMapFor(record, seed, out) {
	const star = record.star;
	const planets = record.counts.planets;
	const metalRich = clamp01(star.metal / 0.030);
	const lumNorm = clamp01(Math.sqrt(Math.max(0, star.lum)));
	const beltTwice = record.belts.count * 2;
	// rock/super/dwarf are the mineable bulks; the +2 keeps a bare system
	// from dividing by a near-zero planet count.
	let rocky = 0, giants = 0;
	for (let i = 0; i < planets; i++) {
		const b = record.planets.bulk[i];
		if (b === 0 || b === 2 || b === 6) rocky++;         // rock, super, dwarf
		else if (b === 3 || b === 4 || b === 5) giants++;   // mini, gas, icegiant
	}
	const rockyFrac = clamp01((rocky + beltTwice) / (planets + beltTwice + 2));
	const giantFrac = clamp01(giants / (planets + 2));
	const beltFrac = clamp01(record.belts.count / 2);
	let terran = 0, inHz = 0;
	for (let i = 0; i < planets; i++) {
		const f = record.planets.flags[i];
		if (f & 4) terran++;
		if (f & 8) inHz++;
	}
	const terranFrac = clamp01(terran / 2);
	const hzFrac = clamp01(inHz / 2);

	const ease = out.ease;
	ease[0] = 0.15 + 0.85 * metalRich * (0.35 + 0.65 * rockyFrac);
	ease[1] = 0.10 + 0.55 * giantFrac + 0.20 * beltFrac + 0.15 * lumNorm;
	ease[2] = 0.05 + 0.95 * lumNorm;
	ease[3] = 0.05 + 0.55 * terranFrac + 0.20 * hzFrac + 0.20 * lumNorm;
	ease[4] = 0.20 + 0.50 * ease[0] + 0.30 * lumNorm;
	ease[5] = 0.30;                 // flat: culture is population, not geography

	// The jitter (§2): one stable hash draw per resource, off the star's own
	// identity key — as reproducible as the planets themselves.
	const colonySeed = hashColony.hash4(star.key, seed, COLONY_SEED_SALT, 1);
	for (let i = 0; i < N; i++) {
		ease[i] = clamp01(ease[i] + (hashColony.hash01At(colonySeed, 0x50 + i) - 0.5) * JITTER);
	}

	out.score = clamp01(0.45 * ease[3] + 0.25 * ease[0] + 0.15 * ease[4] + 0.15 * lumNorm);
	return out;
}

// --- §3 colony state and the advance law ----------------------------------

// `bx/by/bz` (kpc) is the founding snapshot — the route math's fallback
// when the star is out of the selection set. `idx` is the colonies-array
// slot the ledger's events carry; `popIdx`/`starving` carry the advance's
// event state across advances (§6).
function createColony(starKey, name, foundedY, map, bx, by, bz) {
	const pop = 1 + 9 * map.score;   // thousands of persons
	let popIdx = 0;
	while (popIdx < POP_MILESTONES.length && POP_MILESTONES[popIdx] <= pop) popIdx++;
	return {
		starKey: starKey >>> 0,
		name: String(name || ''),
		map,
		foundedY: foundedY,
		lastY: foundedY,
		pop,
		capital: 1 + 5 * map.score,    // industrial points
		stock: new Float64Array(N),    // tons
		comfort: 1,
		coarse: false,
		advances: 0,
		idx: -1,
		popIdx,
		starving: false,
		bx: bx || 0, by: by || 0, bz: bz || 0,
	};
}

// Per-step scratch (§3): advanceColony is an event handler, never nested.
const PROD = new Float64Array(N);
const TAKE = new Float64Array(N);
const WANT = new Float64Array(N);

// The factories. Fixed-step integration at BASE_DT while the span allows;
// a span over MAX_STEPS·BASE_DT coarsens and flags itself (§3). Same
// (state, map, span) → same result, chunking included. The optional ledger
// (§6, ui.17) receives the step's crossings as scheduled events; without
// one the advance is silent, exactly the stage-1 law.
function advanceColony(colony, toY, ledger) {
	const span = toY - colony.lastY;
	if (!(span > 0)) return colony;
	const map = colony.map;
	let steps = Math.ceil(span / BASE_DT);
	colony.coarse = steps > MAX_STEPS;
	const dt = colony.coarse ? span / MAX_STEPS : BASE_DT;
	if (steps > MAX_STEPS) steps = MAX_STEPS;
	const ease = map.ease;
	const stock = colony.stock;
	let pop = colony.pop;
	let capital = colony.capital;
	let comfort = 1;
	let stepY = colony.lastY;

	for (let s = 0; s < steps; s++) {
		let shortfallSum = 0, wantSum = 0, surplusSum = 0;
		for (let r = 0; r < N; r++) {
			// Drivers (§3 step 1): labour for food/info, capital for the
			// rest, capital squared for antimatter.
			let driver;
			if (r === 3) driver = clamp01(pop / 50);
			else if (r === 5) driver = clamp01(pop / 100);
			else if (r === 2) {
				const c = clamp01(capital / 25);
				driver = c * c;
			} else driver = clamp01(capital / 25);
			const prod = ease[r] * RATE[r] * driver * dt;
			const want = pop * NEED[r] * dt;
			const have = stock[r] + prod;
			const take = have < want ? have : want;
			stock[r] = have - take;
			const short = want - take;
			PROD[r] = prod; TAKE[r] = take; WANT[r] = want;
			shortfallSum += short;
			wantSum += want;
			if (prod > want) surplusSum += prod - want;
		}
		comfort = wantSum > 0 ? 1 - shortfallSum / wantSum : 1;

		// Population (§3 step 4): logistic toward K, famine below 0.25.
		const K = 40 * (0.4 + 0.6 * ease[3]) * (1 + capital / 25);
		let dPop = 0.06 * comfort * (1 - pop / K) * pop * dt;
		// Famine below 0.4 comfort (§3): the canonical food-poor
		// founding sits at 0.29 — misery that still grew at 0.25.
		if (comfort < 0.4) dPop -= 0.04 * pop * dt;
		pop += dPop;
		if (pop < 0.05) pop = 0.05;

		// Capital (§3 step 5): reinvested surplus, 1 %/y decay.
		let dCap = 0.02 * comfort * surplusSum * dt - 0.01 * capital * dt;
		capital += dCap;
		if (capital < 0.1) capital = 0.1;

		// The ledger's crossings (§6, ui.17): famine on the comfort
		// band, population on the milestone ladder. Timestamped at
		// the step's own year so the log reads as the timeline.
		if (ledger) {
			stepY = Math.min(stepY + dt, toY);
			const starvingNow = comfort < 0.4;
			if (starvingNow !== colony.starving) {
				colony.starving = starvingNow;
				schedule(ledger, stepY, EV_FAMINE, colony.idx, starvingNow ? 1 : 0, 0);
			}
			while (colony.popIdx < POP_MILESTONES.length && pop >= POP_MILESTONES[colony.popIdx]) {
				schedule(ledger, stepY, EV_MILESTONE, colony.idx, 0, POP_MILESTONES[colony.popIdx]);
				colony.popIdx++;
			}
		}
	}

	colony.pop = pop;
	colony.capital = capital;
	colony.comfort = comfort;
	colony.lastY = toY;
	colony.advances++;
	return colony;
}

// --- §4 the market --------------------------------------------------------

function marketSupply(r, colony) {
	const needAnnual = colony.pop * NEED[r];
	const stockNorm = clamp01(colony.stock[r] / (2 * needAnnual + 50));
	return clamp01(0.6 * colony.map.ease[r] + 0.4 * stockNorm);
}

function marketPrice(r, colony) {
	return RESOURCES[r].base * (1.6 - 1.2 * marketSupply(r, colony));
}

// -1 fair, 0 surplus (cheap — the port's export), 1 scarce (dear — the
// port's import). §4's tag bounds.
function marketTag(r, colony) {
	const p = marketPrice(r, colony) / RESOURCES[r].base;
	if (p <= 0.7) return 0;
	if (p >= 1.3) return 1;
	return -1;
}

// The port's best export: the least-scarce good, ties to the lower index.
// Price order already prefers surplus over fair over scarce.
function bestExport(colony) {
	let best = 0, bestP = Infinity;
	for (let r = 0; r < N; r++) {
		const p = marketPrice(r, colony);
		if (p < bestP) { bestP = p; best = r; }
	}
	return best;
}

// --- §5 trade math (pure; main.js applies it to the hull) ------------------

function createTradeOut() {
	return { kind: -1, tons: 0, cost: 0 };
}

// The purchase at a docked port (§5): the best export, bounded by the free
// hold and the hull's credits, whole tons. tons 0 = nothing affordable.
function buyAtPort(colony, holdFree, credits, out) {
	const kind = bestExport(colony);
	const price = marketPrice(kind, colony);
	let tons = holdFree;
	if (price > 0) {
		const afford = credits / price;
		if (afford < tons) tons = afford;
	}
	tons = Math.floor(tons);
	if (!(tons > 0) || holdFree <= 0 || credits < price) {
		out.kind = -1; out.tons = 0; out.cost = 0;
		return out;
	}
	out.kind = kind;
	out.tons = tons;
	out.cost = tons * price;
	return out;
}

// The sale: the whole hold at the port's price for the held kind.
function sellAtPort(colony, kind, tons) {
	if (!(kind >= 0 && kind < N) || !(tons > 0)) return 0;
	return tons * marketPrice(kind, colony);
}

// --- readout helpers (4 Hz / event cadence, never per frame) ---------------

// `pop` is in thousands of persons (§3): 5.2k, 250k, 1.50M.
function formatPop(pop) {
	if (pop >= 1000) return (pop / 1000).toPrecision(3) + 'M';
	if (pop >= 100) return Math.round(pop) + 'k';
	return pop.toFixed(1) + 'k';
}

function easeBar(v) {
	const filled = Math.round(v * 5);
	let s = '';
	for (let i = 0; i < 5; i++) s += i < filled ? '█' : '░';
	return s;
}

const TAG_NAMES = ['surplus', 'fair', 'scarce'];

function marketLine(r, colony) {
	const tag = marketTag(r, colony);
	return RESOURCES[r].label.padEnd(22) + ' '
		+ easeBar(colony.map.ease[r]) + ' · '
		+ Math.round(colony.stock[r]) + ' t · '
		+ marketPrice(r, colony).toFixed(1) + ' cr/t · '
		+ TAG_NAMES[tag + 1];
}

const ColonyLib = {
	RESOURCES, RESOURCE_INDEX, RATE, NEED,
	createResourceMap, resourceMapFor,
	createColony, advanceColony,
	marketSupply, marketPrice, marketTag, bestExport,
	createTradeOut, buyAtPort, sellAtPort,
	formatPop, easeBar, marketLine, TAG_NAMES,
	clamp01,
	EV_ROUTE_DEPART, EV_ROUTE_ARRIVE, EV_MILESTONE, EV_FAMINE, EV_EXPEDITION_ARRIVE, EV_EXPEDITION_ARRIVE,
	POP_MILESTONES, LEDGER_CAP,
	createEventLedger, schedule, dueEvents, cancel,
};
if (typeof module !== 'undefined') module.exports = ColonyLib;
if (typeof window !== 'undefined') window.ColonyLib = ColonyLib;
