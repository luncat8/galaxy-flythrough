// experiments/trade-test.js
// Validates the colony economy and the trade network (trade-plan.md):
//   §2  the 13-resource map, its stable per-site hash, the authored tables,
//       and the closed-form colony settle (a jump equals the same stretch in
//       small steps — the exec-queue discipline, applied to stocks),
//   §3  the event network: ports, ships, arrivals, colonisation, the queue's
//       bounds and the jump-equals-steps invariant on the whole network,
//   §4  the player's tonnage/units bridge (load, carry, sell back),
//   §5  the draw state the galaxy overlay reads.
//
// The fixtures are real landmark systems through planets.generateSystem, so a
// broken generator is a red test here too. Output: experiments/logs/trade.json

'use strict';

const path = require('path');
const logFile = require('./log-file.js');
const planets = require('../src/math/planets.js');
const galaxy = require('../src/math/galaxy.js');
const economy = require('../src/core/economy.js');
const trade = require('../src/core/trade.js');
const queueLib = require('../src/core/exec-queue.js');
const shipLib = require('../src/core/ship.js');
const landmarks = require('../src/data/landmarks.js');

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
	return !!pass;
}
function near(a, b, rel) {
	const tol = rel === undefined ? 1e-9 : rel;
	return Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
}
function finite(x) { return typeof x === 'number' && Number.isFinite(x); }

const model = galaxy.MILKY_WAY;
const ctx = { model, field: null, member: null, name: '' };
const record = planets.createSystemRecord();

function landmarkRef(index, out) {
	const entry = landmarks.ENTRIES[index];
	out.kind = planets.BLOCK_LANDMARK;
	out.index = index;
	out.key = planets.landmarkKey(index) >>> 0;
	out.x = entry.x; out.y = entry.y; out.z = entry.z;
	out.colorIndex = entry.colorIndex;
	out.absMag = entry.absMag;
	return out;
}

// A network over the first `count` named stars. Named systems are spread
// across the sky, so the fixture exercises long legs as well as the map.
const scratchRef = { kind: 0, index: 0, key: 0, x: 0, y: 0, z: 0, colorIndex: 0, absMag: 0 };
function seedNetwork(count, timeYears) {
	const net = trade.createNetwork({ seed: 4242, modelSeed: galaxy.DEFAULT_SEED, timeYears: timeYears || 0 });
	for (let i = 0; i < count; i++) {
		landmarkRef(i, scratchRef);
		ctx.name = landmarks.ENTRIES[i].name;
		planets.generateSystem(scratchRef, ctx, record);
		trade.discoverSystem(net, scratchRef, ctx.name, record, net.time);
	}
	return trade.finalize(net);
}

function stepSmall(net, total, chunk) {
	let left = total;
	while (left > 0) {
		const dt = left < chunk ? left : chunk;
		trade.step(net, dt);
		left -= dt;
	}
	return net;
}

// --- 1. The authored tables ----------------------------------------------
{
	const ids = new Set();
	let unique = true, positive = true, producible = true, sized = true;
	for (let r = 0; r < economy.RESOURCE_COUNT; r++) {
		const res = economy.RESOURCES[r];
		if (ids.has(res.id)) unique = false;
		ids.add(res.id);
		if (!(res.worth > 0) || !(res.unitMassT > 0)) sized = false;
		if (!(economy.PROD[r] > 0)) positive = false;
		let best = 0;
		for (let t = 0; t < economy.PLANET[r].length; t++) best = Math.max(best, economy.PLANET[r][t]);
		if (!(best > 0)) producible = false;
	}
	check('thirteen uniquely named resources, all worth hauling', unique && economy.RESOURCE_COUNT === 13);
	check('every resource has a production rate and at least one world type that makes it',
		positive && producible);
	check('every resource has a positive worth and unit mass', sized);

	// The PLANET/HABITAT columns are planets.js display types by position:
	// pin the semantics by name so a reordered DISPLAY_TYPES fails here
	// instead of silently making ice worlds into farms.
	const display = planets.DISPLAY_INDEX;
	let foodBest = 0;
	for (let t = 0; t < economy.PLANET[economy.R_FOOD].length; t++) {
		foodBest = Math.max(foodBest, economy.PLANET[economy.R_FOOD][t]);
	}
	check('the yield table columns are the display types they claim to be',
		economy.PLANET[economy.R_FOOD][display.TERRAN] === foodBest
		&& economy.PLANET[economy.R_VOLATILE][display.ICE] > economy.PLANET[economy.R_VOLATILE][display.TERRAN]
		&& economy.PLANET[economy.R_ORE][economy.SITE_BELT] > economy.PLANET[economy.R_ORE][display.TERRAN]
		&& economy.HABITAT[display.TERRAN] === 1
		&& economy.HABITAT[display.LAVA] < economy.HABITAT[display.SUPER_EARTH]);

	let orbits = true;
	for (let r = 0; r < economy.RESOURCE_COUNT; r++) {
		for (let g = 0; g < economy.RESOURCE_COUNT; g++) {
			const v = economy.INPUT[r * economy.RESOURCE_COUNT + g];
			if (!finite(v) || v < 0) orbits = false;
		}
	}
	check('the industrial bill of materials is finite and non-negative', orbits);

	let ladder = true;
	for (let i = 1; i < trade.TRADE_RATES.length; i++) {
		if (!(trade.TRADE_RATES[i] > trade.TRADE_RATES[i - 1])) ladder = false;
	}
	check('the trade clock ladder is strictly increasing from a real pause',
		ladder && trade.TRADE_RATES[0] === 0);
	check('the default trade rate is a stop on the ladder',
		trade.TRADE_RATES[trade.TRADE_RATE_DEFAULT_INDEX] === trade.TRADE_RATE_DEFAULT);
}

// --- 2. The site map is a pure function of the site's hash ----------------
{
	landmarkRef(3, scratchRef);
	planets.generateSystem(scratchRef, ctx, record);
	const site = economy.createSite();
	economy.fillPlanetSite(site, scratchRef, record, 0, 0x1234);
	const a = economy.createColony(), b = economy.createColony(), c = economy.createColony();
	economy.setupColony(a, site, 0, 0x1234);
	economy.setupColony(b, site, 0, 0x1234);
	economy.setupColony(c, site, 0, 0x99aa);
	let same = near(a.capacity, b.capacity);
	let differs = false;
	for (let r = 0; r < economy.RESOURCE_COUNT; r++) {
		if (!near(a.yield[r], b.yield[r])) same = false;
		if (!near(a.yield[r], c.yield[r], 1e-6)) differs = true;
	}
	check('the same site hash yields the same world', same);
	check('a different site hash changes the resource map', differs);
	const slotProbe = economy.createSite();
	slotProbe.index = 1;
	const beltProbe = economy.createSite();
	beltProbe.isBelt = 1;
	check('site slots are unique within a star (planet, next planet, belt)',
		economy.siteSlot(site) !== economy.siteSlot(slotProbe)
		&& economy.siteSlot(beltProbe) !== economy.siteSlot(site)
		&& economy.siteSlot(beltProbe) !== economy.siteSlot(slotProbe));

	let bounded = true, habitats = true;
	for (let i = 0; i < 8 && i < landmarks.count; i++) {
		landmarkRef(i, scratchRef);
		planets.generateSystem(scratchRef, ctx, record);
		for (let p = 0; p < record.counts.planets; p++) {
			const candidate = economy.createSite();
			economy.fillPlanetSite(candidate, scratchRef, record, p, 0x77);
			const colony = economy.createColony();
			economy.setupColony(colony, candidate, 0, 0x77);
			if (!(colony.capacity > 0)) habitats = false;
			for (let r = 0; r < economy.RESOURCE_COUNT; r++) {
				const y = colony.yield[r];
				if (!finite(y) || y < 0 || y > economy.YIELD_MAX) bounded = false;
			}
		}
	}
	check('every generated site has finite yields inside [0, YIELD_MAX] and a positive capacity',
		bounded && habitats);
}

// --- 3. The closed-form settle -------------------------------------------
{
	landmarkRef(5, scratchRef);
	planets.generateSystem(scratchRef, ctx, record);
	const site = economy.createSite();
	economy.fillPlanetSite(site, scratchRef, record, 0, 0x51);
	const one = economy.createColony();
	economy.setupColony(one, site, 0, 0x51);
	const many = economy.createColony();
	economy.setupColony(many, site, 0, 0x51);
	// The fixture is a young colony: give it a century of growth first, so the
	// comparison is not the trivial t = 0 both sides share.
	economy.settleColony(one, 100);
	economy.settleColony(many, 100);
	economy.settleColony(one, 600);
	for (let t = 100; t < 600; t += 5) economy.settleColony(many, t + 5);
	// A supply-limited colony's coverage drifts as its stocks drain, and a
	// settle freezes coverage at the interval's start — the one documented
	// approximation (trade-plan §2.1). Identical network events reproduce
	// identical approximations; different inspection schedules need not.
	check('one 500-year settle tracks a hundred 5-year settles (free colony)',
		near(one.pop, many.pop, 0.25), { one: one.pop, many: many.pop });

	// The exact law: at constant coverage the logistic is a closed form and
	// splitting is exact. Yield 2 on every resource makes a colony
	// self-sufficient in every need, so coverage is pinned at 1 whatever its
	// stocks do and no boundary can be crossed inside the interval.
	const exactOne = economy.createColony();
	economy.setupColony(exactOne, site, 0, 0x51);
	const exactMany = economy.createColony();
	economy.setupColony(exactMany, site, 0, 0x51);
	for (const colony of [exactOne, exactMany]) {
		for (let r = 0; r < economy.RESOURCE_COUNT; r++) {
			colony.yield[r] = 2;
			colony.outBase[r] = economy.PROD[r] * 2;
			colony.stock[r] = colony.stockCap[r] * 0.5;
		}
		colony.pop = colony.capacity * 0.25;
		colony.last = 0;
	}
	economy.settleColony(exactOne, 500);
	for (let t = 0; t < 500; t += 5) economy.settleColony(exactMany, t + 5);
	check('the exactness fixture really is fully supplied', exactOne.coverage === 1);
	check('one 500-year settle equals a hundred 5-year settles (population)',
		near(exactOne.pop, exactMany.pop, 1e-9), { one: exactOne.pop, many: exactMany.pop });
	let stocks = true;
	for (let r = 0; r < economy.RESOURCE_COUNT; r++) {
		if (!near(exactOne.stock[r], exactMany.stock[r], 1e-9)) stocks = false;
	}
	check('one 500-year settle equals a hundred 5-year settles (every stock)', stocks);

	let clean = true, capped = true;
	for (let r = 0; r < economy.RESOURCE_COUNT; r++) {
		const s = one.stock[r];
		if (!finite(s)) clean = false;
		if (s < 0 || s > one.stockCap[r] + 1e-6) capped = false;
	}
	check('stocks stay finite inside their warehouses', clean && capped);
	check('population stays inside [0, 1.5 × capacity]',
		finite(one.pop) && one.pop >= 0 && one.pop <= one.capacity * economy.POP_GROWTH_CAP_FRAC + 1e-6);
	check('coverage is a ratio and growth a finite rate',
		one.coverage >= 0 && one.coverage <= 1 && finite(one.growth));

	// Needs respond to stock: filling a worked example to its cap must not
	// lower coverage, and draining it must not raise coverage.
	const c = economy.createColony();
	economy.setupColony(c, site, 0, 0x51);
	economy.settleColony(c, 300);
	const before = c.coverage;
	for (let r = 0; r < economy.RESOURCE_COUNT; r++) economy.giveToColony(c, r, c.stockCap[r]);
	const filled = economy.coverageOf(c);
	check('filling the warehouses raises coverage', filled >= before - 1e-9 && filled <= 1,
		{ before, filled });

	// The demand side of the same record.
	let demand = 0;
	for (let r = 0; r < economy.RESOURCE_COUNT; r++) if (economy.demandOf(c, r) > 0) demand += 1;
	check('a full port wants nothing', demand === 0);
	// takeFromColony respects the export reserve; an empty port is empty.
	for (let r = 0; r < economy.RESOURCE_COUNT; r++) c.stock[r] = 0;
	let hungry = 0;
	for (let r = 0; r < economy.RESOURCE_COUNT; r++) if (economy.demandOf(c, r) > 0) hungry += 1;
	check('an empty port wants its needs and its industry', hungry >= 6);
}

// --- 4. The event network ------------------------------------------------
{
	const net = seedNetwork(24, 0);
	check('a seeded network makes ports and ships',
		net.portCount > 0 && net.shipCount > 0, { ports: net.portCount, ships: net.shipCount });
	const seeds = net.portCount;
	trade.step(net, 600);
	let sane = true;
	for (let i = 0; i < net.shipCount; i++) {
		const s = net.ships[i];
		if (s.state < trade.SHIP_DOCKED || s.state > trade.SHIP_FOUNDING) sane = false;
		if (!finite(s.amount) || s.amount < 0) sane = false;
		if (s.state === trade.SHIP_SAILING && !(s.arrive > s.depart)) sane = false;
	}
	check('every ship stays in a known state with a finite cargo', sane);
	check('the network clock lands exactly on the requested year', net.time === 600);
	check('ports do not vanish and ships stay capped',
		net.portCount >= seeds && net.shipCount <= trade.MAX_SHIPS,
		{ ports: net.portCount, ships: net.shipCount });
	check('the queue stays bounded by one live event per ship plus a tick',
		net.queue.size <= net.shipCount + 4, net.queue.size);
	check('arrivals are booked', net.processed > 0 && net.delivered >= 0,
		{ processed: net.processed, delivered: net.delivered });
	check('no ship ever leaves a stale event behind', net.stale === 0, net.stale);
	check('the fleet keeps sailing', (() => {
		let sailing = 0;
		for (let i = 0; i < net.shipCount; i++) if (net.ships[i].state === trade.SHIP_SAILING) sailing += 1;
		return sailing > 0;
	})());

	// Jump ≡ many small steps, at network scale: the same seed, the same
	// events, the same colonies. The claim is the exec-queue README's, and it
	// is what lets a paused tab resume without a separate fast-forward path.
	const jump = seedNetwork(24, 0);
	trade.step(jump, 600);
	const small = seedNetwork(24, 0);
	stepSmall(small, 600, 5);
	const samePorts = jump.portCount === small.portCount && jump.shipCount === small.shipCount
		&& jump.founded === small.founded;
	let sameColonies = true;
	for (let i = 0; i < jump.portCount && i < small.portCount; i++) {
		const a = jump.ports[i].colony, b = small.ports[i].colony;
		if (!near(a.pop, b.pop, 1e-6)) sameColonies = false;
	}
	check('one 600-year jump equals a hundred and twenty 5-year steps',
		samePorts && sameColonies && near(jump.delivered, small.delivered, 1e-6),
		{ jump: [jump.portCount, jump.shipCount, jump.founded, jump.delivered],
			small: [small.portCount, small.shipCount, small.founded, small.delivered] });

	// Determinism: the same seed rebuilds the same galaxy.
	const again = seedNetwork(24, 0);
	trade.step(again, 600);
	check('the same seed rebuilds the same network',
		again.portCount === jump.portCount && again.founded === jump.founded
		&& near(again.delivered, jump.delivered));
}

// --- 5. Discovery is idempotent, colonisation only adds -------------------
{
	const net = seedNetwork(12, 0);
	const before = net.portCount;
	const candidates = net.candidateCount;
	landmarkRef(7, scratchRef);
	planets.generateSystem(scratchRef, ctx, record);
	ctx.name = landmarks.ENTRIES[7].name;
	for (let i = 0; i < 3; i++) trade.discoverSystem(net, scratchRef, ctx.name, record, 0);
	check('re-inspecting a system adds no ports and no candidates',
		net.portCount === before && net.candidateCount === candidates);

	const grown = seedNetwork(24, 0);
	const start = grown.portCount;
	trade.step(grown, 2500);
	check('colonisation grows the network over two and a half millennia',
		grown.founded > 0 && grown.portCount === start + grown.founded
		&& grown.portCount <= trade.MAX_PORTS,
		{ start, end: grown.portCount, founded: grown.founded });
	check('no colony exceeds the port cap', grown.portCount <= trade.MAX_PORTS);
	check('a founded colony starts with a population and a warehouse',
		(() => {
			for (let i = 0; i < grown.portCount; i++) {
				const c = grown.ports[i].colony;
				if (c.abandoned) continue;
				if (!(c.pop > 0) || !(c.capacity > 0)) return false;
				if (!finite(c.stock[economy.R_FOOD])) return false;
			}
			return true;
		})());
}

// --- 6. The player's hold -------------------------------------------------
{
	const net = seedNetwork(24, 0);
	trade.step(net, 400);
	// Pick the port with the most spare of anything: a port with nothing to
	// sell cannot test the load path.
	let portIndex = -1, resource = -1;
	for (let i = 0; i < net.portCount && portIndex < 0; i++) {
		const colony = net.ports[i].colony;
		for (let r = 0; r < economy.RESOURCE_COUNT; r++) {
			if (economy.exportableOf(colony, r) > 0) { portIndex = i; resource = r; break; }
		}
	}
	check('the fixture has a port with a spare export', portIndex >= 0);
	const ship = shipLib.createShip('chemical');
	ship.docked = 1;
	ship.station = { key: net.ports[portIndex].key, name: net.ports[portIndex].name };
	check('a docked ship finds its port by star key', trade.playerPort(net, ship.station.key) === portIndex);

	const load = trade.playerLoad(net, ship, portIndex);
	check('loading buys a named resource into the hold',
		load.ok === 1 && load.resource >= 0 && load.units > 0 && load.tons > 0
		&& ship.cargo === load.tons && ship.cargoResource === load.resource,
		{ ok: load.ok, resource: load.resource, units: load.units, tons: load.tons });

	const again = trade.playerLoad(net, ship, portIndex);
	check('a second load either adds the same resource or explains why',
		again.ok === 0 || again.resource === ship.cargoResource);

	const unload = trade.playerUnload(net, ship, portIndex);
	check('selling back empties the hold and returns the units',
		unload.ok === 1 && unload.units > 0 && ship.cargo === 0 && ship.cargoResource === -1,
		{ ok: unload.ok, units: unload.units });
	check('an empty hold refuses to sell', trade.playerUnload(net, ship, portIndex).ok === 0);

	const empty = shipLib.createShip('chemical');
	empty.docked = 1;
	check('a hold with no cargo cannot sell', trade.playerUnload(net, empty, portIndex).ok === 0);
	check('loading at no port explains itself', trade.playerLoad(net, ship, -1).ok === 0
		&& trade.playerLoad(net, ship, -1).reason.length > 0);

	// The draw state the overlay reads: every sailing hull has two ends and a
	// position between them.
	const out = [0, 0, 0];
	let placed = 0, finitePositions = true;
	for (let i = 0; i < net.shipCount; i++) {
		const s = net.ships[i];
		if (s.state !== trade.SHIP_SAILING) continue;
		trade.shipPosition(net, i, net.time, out);
		if (!finite(out[0]) || !finite(out[1]) || !finite(out[2])) finitePositions = false;
		placed += 1;
	}
	check('sailing hulls have a finite draw position', placed > 0 && finitePositions);
	check('ship state names cover every state', trade.SHIP_STATE_NAMES.length === 4
		&& trade.SHIP_STATE_NAMES.every(name => name.length > 0)
		&& trade.shipStateName(net.ships[0]).length > 0);
}

// --- 7. The queue itself --------------------------------------------------
{
	const queue = queueLib.createExecQueue(4);
	const seen = [];
	queueLib.push(queue, 30, 0, 1, 0);
	queueLib.push(queue, 10, 0, 2, 0);
	queueLib.push(queue, 20, 0, 3, 0);
	queueLib.drainUntil(queue, 25, (time, kind, ref) => seen.push([time, ref]));
	check('a min-heap drains in time order, not push order',
		JSON.stringify(seen) === JSON.stringify([[10, 2], [20, 3]]), seen);
	check('a partly drained queue reports its next event time', queueLib.peekTime(queue) === 30);
	queueLib.drainUntil(queue, 1e9, () => {});
	check('an empty queue stays empty and reports Infinity',
		queue.size === 0 && queueLib.peekTime(queue) === Infinity);

	const edge = queueLib.createExecQueue(2);
	const edgeSeen = [];
	queueLib.push(edge, 20, 9, 3, 0);
	queueLib.push(edge, 10, 7, 1, 0);
	queueLib.drainUntil(edge, 20, (time, kind) => {
		edgeSeen.push(time);
		if (kind === 7) queueLib.push(edge, 15, 8, 2, 0);
		if (kind === 8) queueLib.push(edge, 25, 9, 4, 0);
	});
	check('a push inside a drain runs in the same drain when due, and the target itself is due',
		JSON.stringify(edgeSeen) === JSON.stringify([10, 15, 20])
		&& edge.size === 1 && queueLib.peekTime(edge) === 25, edgeSeen);

	const big = queueLib.createExecQueue(4);
	const times = [];
	for (let i = 0; i < 2000; i++) times.push((((i * 2654435761) >>> 0) % 100003) / 16);
	for (let i = 0; i < times.length; i++) queueLib.push(big, times[i], 0, i, 0);
	const drained = [];
	queueLib.drainUntil(big, Infinity, (time) => drained.push(time));
	const sorted = [...times].sort((a, b) => a - b);
	check('growth past capacity keeps 2,000 events in time order',
		JSON.stringify(drained) === JSON.stringify(sorted));
}

// --- 8. Long intervals, lifecycle and conservation regressions ------------
{
	function controlledColony(supplied) {
		const c = economy.createColony();
		c.capacity = 100;
		c.pop = 25;
		c.last = 0;
		for (let r = 0; r < economy.RESOURCE_COUNT; r++) {
			c.outBase[r] = supplied ? economy.NEED[r] * 2 : 0;
			c.stockCap[r] = 1e12;
		}
		return c;
	}
	const growing = controlledColony(true);
	economy.settleColony(growing, 1e6);
	check('a million years of supplied growth tends to K, not zero',
		near(growing.pop, growing.capacity) && finite(growing.produced) && growing.produced > 0);
	const declining = controlledColony(false);
	economy.settleColony(declining, 1e6);
	const decayArea = -declining.capacity / economy.DECLINE * Math.log1p(-0.25);
	let netNeed = 0;
	for (const rate of economy.NEED) netNeed += rate;
	check('long starvation tends to zero with a finite positive consumption integral',
		declining.pop === 0 && declining.abandoned === 1
		&& near(declining.consumed, decayArea * netNeed));
	const equilibrium = controlledColony(true);
	equilibrium.pop = equilibrium.capacity;
	economy.settleColony(equilibrium, 1e6);
	check('population at carrying capacity is an exact finite equilibrium',
		equilibrium.pop === equilibrium.capacity && finite(equilibrium.consumed));
	const tiny = controlledColony(true);
	economy.settleColony(tiny, 1e-10);
	const initialSlope = economy.G_MAX * 25 * 0.75;
	check('very short settles retain the logistic increment', near((tiny.pop - 25) / 1e-10, initialSlope, 1e-3));

	const net = seedNetwork(24, 0);
	const c = net.ports[0].colony;
	c.stock.fill(0);
	c.stock[economy.R_FOOD] = c.stockCap[economy.R_FOOD];
	const ship = { class: { cargo: 9 }, cargo: 0, cargoResource: -1 };
	const before = c.stock[economy.R_FOOD];
	const loaded = trade.playerLoad(net, ship, 0).units;
	check('fractional stock units fit a tonnage hold without wasting room',
		near(ship.cargo, 9) && near(loaded, 9 / 8) && near(before - c.stock[economy.R_FOOD], loaded));
	c.stock[economy.R_FOOD] = c.stockCap[economy.R_FOOD] - 0.5;
	const given = trade.playerUnload(net, ship, 0).tons;
	check('a partial unload preserves the fractional cargo left aboard',
		near(given, 4) && near(ship.cargo, 5) && ship.cargoResource === economy.R_FOOD);
	const blockedCargo = ship.cargo;
	check('a full warehouse refuses without discarding the remaining cargo',
		trade.playerUnload(net, ship, 0).ok === 0 && ship.cargo === blockedCargo);
	c.stock[economy.R_FOOD] = 0;
	const finalGiven = trade.playerUnload(net, ship, 0).tons;
	check('the final fractional unload conserves all nine tonnes',
		near(given + finalGiven, 9) && ship.cargo === 0 && ship.cargoResource === -1);
	ship.cargo = 1;
	ship.cargoResource = economy.R_FOOD;
	c.stock[economy.R_FOOD] = c.stockCap[economy.R_FOOD];
	c.stock[economy.R_RARE] = c.stockCap[economy.R_RARE];
	check('a nonempty hold tops up its resource even when another export ranks higher',
		trade.playerLoad(net, ship, 0).ok === 1 && ship.cargoResource === economy.R_FOOD);
	c.abandoned = 1;
	check('an abandoned colony is not offered as a player port', trade.playerPort(net, net.ports[0].key) === -1);
}

function exactLiveEvents(net) {
	const live = new Uint32Array(net.shipCount);
	let ticks = 0;
	for (let i = 0; i < net.queue.size; i++) {
		if (net.queue.kind[i] === trade.EV_TICK) { ticks++; continue; }
		const index = net.queue.ref[i];
		if (index < net.shipCount && net.queue.revision[i] === net.ships[index].revision) live[index]++;
	}
	return ticks === 1 && live.every(n => n === 1);
}
{
	const empty = trade.finalize(trade.createNetwork({ seed: 4242 }));
	trade.step(empty, 5000);
	check('a portless network keeps only its global tick and no orphan ships',
		empty.portCount === 0 && empty.shipCount === 0 && empty.queue.size === 1 && exactLiveEvents(empty));

	const jump = seedNetwork(60, 0), small = seedNetwork(60, 0);
	trade.step(jump, 5000);
	stepSmall(small, 5000, 5);
	check('a 5,000-year jump matches the entire stepped network, including stocks, fleet and heap',
		JSON.stringify(jump) === JSON.stringify(small));
	check('every hull has exactly one current event after five millennia', exactLiveEvents(jump));
	check('the long tournament completes real deliveries and foundings', jump.delivered > 0 && jump.founded > 0);

	// Force long overlapping expeditions so the reservation invariant is
	// tested independently of the currently faster-than-launch-interval hulls.
	const speed = trade.HULLS[2].lyPerYear;
	trade.HULLS[2].lyPerYear = 0.01;
	const overlapping = seedNetwork(60, 0);
	for (let i = 0; i < overlapping.portCount; i++) {
		const c = overlapping.ports[i].colony;
		c.stock.set(c.stockCap);
	}
	trade.step(overlapping, 1000);
	trade.HULLS[2].lyPerYear = speed;
	const targets = new Set();
	let founders = 0, uniqueTargets = true;
	for (let i = 0; i < overlapping.shipCount; i++) {
		const ship = overlapping.ships[i];
		if (ship.state !== trade.SHIP_FOUNDING) continue;
		const candidate = overlapping.candidates[ship.candidate];
		if (targets.has(candidate.site.key)) uniqueTargets = false;
		targets.add(candidate.site.key);
		founders++;
		for (let j = 0; j < overlapping.candidateCount; j++) {
			const c = overlapping.candidates[j];
			if (c.site.key === candidate.site.key && c.reserved !== i) uniqueTargets = false;
		}
	}
	check('overlapping expeditions reserve distinct whole systems', founders >= 2 && uniqueTargets, founders);
	check('in-flight founding capacity and live-event invariants hold',
		overlapping.portCount + founders <= trade.MAX_PORTS && exactLiveEvents(overlapping));
	// An externally invalidated candidate must not strand its arriving hull.
	let broken = -1;
	for (let i = 0; i < overlapping.shipCount; i++) {
		const ship = overlapping.ships[i];
		if (ship.state !== trade.SHIP_FOUNDING) continue;
		broken = i;
		overlapping.candidates[ship.candidate].used = 1;
		queueLib.push(overlapping.queue, overlapping.time + 1, trade.EV_FOUND, i, ++ship.revision);
		break;
	}
	trade.step(overlapping, 1);
	check('failed founding releases reservations and schedules a source-port load',
		broken >= 0 && overlapping.ships[broken].state === trade.SHIP_DOCKED
		&& overlapping.ships[broken].port === overlapping.ships[broken].from
		&& overlapping.candidates.every(c => c.reserved !== broken) && exactLiveEvents(overlapping));
}

// --- 9. The overlay must not alias the two drawn endpoints ---------------
{
	const previousWindow = global.window;
	const records = require('../src/math/star-record.js');
	const layerLib = require('../src/render/label-layer.js');
	const lines = [], arcs = [];
	let clears = 0;
	let penX = 0, penY = 0;
	const context = {
		setTransform() {}, clearRect() { clears++; }, beginPath() {}, stroke() {}, fill() {},
		moveTo(x, y) { penX = x; penY = y; },
		lineTo(x, y) { lines.push([penX, penY, x, y]); },
		arc(x, y, radius) { arcs.push([x, y, radius]); },
	};
	const canvas = { width: 0, height: 0, getContext: () => context };
	// A nonzero displacement exercises the motion path, not just raw records.
	const orbit = {
		engineRecordPosition(out, x, y, z) { out[0] = x + 0.1; out[1] = y; out[2] = z; },
	};
	global.window = { StarRecord: records, OrbitLib: orbit };
	const layer = layerLib.createLabelLayer(canvas, { count: 0 }, { LINES: [] });
	layer.setEnabled(false);
	layer.resize(100, 100, 1);
	const view = new DataView(new ArrayBuffer(2 * records.RECORD_BYTES));
	view.setFloat32(0, -0.5, true);
	view.setFloat32(records.RECORD_BYTES, 0.5, true);
	const info = { view, identity: new Uint32Array([10, 20]), total: 2, blocks: [{ offset: 0 }] };
	layer.setStarSource(info);
	layer.setOrbitState({}, 1);
	const ports = [0, 1].map(i => ({ key: info.identity[i], ref: { kind: 0, index: i },
		colony: { abandoned: 0, pop: i === 0 ? 900 : 0, capacity: 900, growth: i === 0 ? 0.01 : -0.01 } }));
	const net = { portCount: 2, shipCount: 1, candidateCount: 0, ports, candidates: [],
		ships: [{ state: trade.SHIP_SAILING, from: 0, to: 1, depart: 0, arrive: 100, cargo: 0 }] };
	const matrix = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
	const camera = { cameraPos: [0, 0, 0], buildViewProj: () => matrix };
	layer.setTradeOverlay(net, 25, true);
	layer.draw(camera, 100, 100);
	check('trade routes preserve both independently resolved drawn endpoints',
		lines.length === 1 && near(lines[0][0], 30) && near(lines[0][2], 80));
	const hull = arcs.find(a => a[2] === 2.2);
	check('the trade hull interpolates between drawn endpoints, not at the destination',
		hull && near(hull[0], 42.5) && near(hull[1], 50));
	// trade.3: a port's ring is its population, coloured by its growth sign, so
	// the overlay shows a colony growing instead of N identical rings; a free
	// candidate world is a small cross, so the frontier is visible as one.
	net.candidateCount = 1;
	net.candidates.push({ used: 0, reserved: -1, site: { key: info.identity[0], ref: { kind: 0, index: 0 } } });
	lines.length = 0;
	arcs.length = 0;
	layer.draw(camera, 100, 100);
	const bigRing = arcs.find(a => near(a[2], 2 + 5.5));
	const smallRing = arcs.find(a => near(a[2], 2));
	check('a port ring scales with its colony and a frontier world is marked',
		!!bigRing && !!smallRing && lines.length === 3, { arcs: arcs.length, lines: lines.length });
	net.candidateCount = 0;
	net.candidates.length = 0;
	info.identity[1] = 99;
	lines.length = 0;
	arcs.length = 0;
	layer.draw(camera, 100, 100);
	check('a nonresident endpoint hides its route and hull', lines.length === 0 && !arcs.some(a => a[2] === 2.2));
	const beforeClear = clears;
	layer.setTradeOverlay(net, 25, false);
	layer.draw(camera, 100, 100);
	check('turning trade off clears its last frame even with labels and chrome disabled', clears === beforeClear + 1);
	layer.draw(camera, 100, 100);
	check('a hidden trade overlay does not keep clearing every frame', clears === beforeClear + 1);
	global.window = previousWindow;
}

// --- 10. Discovery bounds and application cargo gating --------------------
{
	const net = trade.createNetwork({ seed: 4242, modelSeed: model.seed });
	net.seedPorts = 0;
	landmarkRef(3, scratchRef);
	planets.generateSystem(scratchRef, ctx, record);
	trade.discoverSystem(net, scratchRef, 'frontier', record, 0);
	const candidates = net.candidateCount;
	net.seedPorts = 32;
	trade.discoverSystem(net, scratchRef, 'frontier', record, 100);
	check('a discovered frontier cannot be rerolled into a seed port', net.portCount === 0 && net.candidateCount === candidates);
	const seeded = seedNetwork(24, 0);
	const port = seeded.ports[0];
	landmarkRef(port.ref.index, scratchRef);
	planets.generateSystem(scratchRef, ctx, record);
	trade.discoverSystem(seeded, scratchRef, port.name, record, 50);
	check('reinspection settles a known port without changing its identity', port.colony.last === 50 && port.key === scratchRef.key);

	// Build a dense synthetic catalog through the public generator/discovery
	// APIs; leave one port slot and several nearby candidate stars.
	const capped = trade.createNetwork({ seed: 4242, modelSeed: model.seed });
	capped.seedPorts = trade.MAX_PORTS - 1;
	const ref = { kind: planets.BLOCK_CATALOG, index: 0, key: 0, x: 0, y: 0, z: 0, colorIndex: 4, absMag: 4 };
	for (let i = 1; i < 2000 && capped.portCount < capped.seedPorts; i++) {
		ref.key = i;
		ref.index = i;
		ref.x = i * 1e-5;
		planets.generateSystem(ref, ctx, record);
		trade.discoverSystem(capped, ref, '', record, 0);
	}
	for (let i = 0; i < capped.portCount; i++) capped.ports[i].colony.stock.set(capped.ports[i].colony.stockCap);
	const speed = trade.HULLS[2].lyPerYear;
	trade.HULLS[2].lyPerYear = 0.00001;
	trade.finalize(capped);
	trade.step(capped, 1000);
	trade.HULLS[2].lyPerYear = speed;
	let founding = 0;
	for (let i = 0; i < capped.shipCount; i++) if (capped.ships[i].state === trade.SHIP_FOUNDING) founding++;
	check('one remaining port slot permits exactly one outstanding founding',
		capped.portCount === trade.MAX_PORTS - 1 && founding === 1 && exactLiveEvents(capped));

	const fs = require('fs'), vm = require('vm');
	const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
	const transfer = main.match(/function gameCargoTransfer\(unload\) \{[\s\S]*?\n\t\}/)[0];
	let message = '';
	const ship = { docked: 1, cargo: 7, cargoResource: economy.R_FOOD };
	const context = { ship, gameTradePort: () => -1, setAutoMsg: text => { message = text; } };
	vm.runInNewContext(transfer + '\ngameCargoTransfer(false);', context);
	check('application loading at a colony-free dock cannot create free containers', ship.cargo === 7 && message.includes('no colony'));
	vm.runInNewContext(transfer + '\ngameCargoTransfer(true);', context);
	check('application unloading at a colony-free dock preserves the hold', ship.cargo === 7 && ship.cargoResource === economy.R_FOOD);
	ship.docked = 0;
	vm.runInNewContext(transfer + '\ngameCargoTransfer(false);', context);
	check('application cargo transfer still requires docking', ship.cargo === 7 && message.includes('only at a dock'));
}

// --- 11. The clock laws (trade-plan §6) -----------------------------------
{
	// The sync is a rate, not an identity: a synced sky must land on the trade
	// ladder the network is tuned for, exactly, across the fine star range.
	check('the synced clock maps the star slider onto the trade ladder',
		trade.clockRate(100, 0.1, true) === 100 && trade.clockRate(100, 2, true) === 2000,
		{ slow: trade.clockRate(100, 0.1, true), fast: trade.clockRate(100, 2, true) });
	check('the synced clock never exceeds the drain ceiling',
		trade.clockRate(100, 99, true) === trade.RATE_MAX && trade.RATE_MAX <= 4000,
		trade.clockRate(100, 99, true));
	check('an unsynced clock is the ladder, and both pause at zero or below',
		trade.clockRate(200, 5, false) === 200 && trade.clockRate(200, 0, true) === 0
		&& trade.clockRate(200, -1, true) === 0 && trade.clockRate(0, 0, false) === 0);

	// Generation ships: slow at the top of the fine star range, which is the
	// calibration the mode is authored against.
	trade.setGenerationMode(1);
	const genYears = trade.legYears(5 / trade.LY_PER_KPC, 2);   // a typical 5 ly hop
	trade.setGenerationMode(0);
	const genSeconds = genYears / trade.clockRate(100, 2, true);
	check('a generation-ship hop lasts seconds at the synced top rate',
		genSeconds > 1 && genSeconds < 6, { legYears: Math.round(genYears), wallS: +genSeconds.toFixed(2) });
	check('the freighter cruise is untouched by the special mode',
		Math.abs(trade.legYears(5 / trade.LY_PER_KPC, 2) - 5 / trade.HULLS[2].lyPerYear) < 1e-9);

	// The budget: a bounded frame stops the clock at the next due event, so the
	// clock never skips over an event (a colony asked to settle backwards
	// freezes), and the backlog is reported instead of hidden.
	const net = seedNetwork(24, 0);
	trade.step(net, 400);
	let monotone = true, ahead = false, budgetHits = 0;
	let last = net.time;
	for (let f = 0; f < 240; f++) {
		trade.step(net, 2000 / 60, 8);
		if (net.time < last) monotone = false;
		if (net.time > net.time) ahead = true;
		last = net.time;
		if (net.lag > 0) budgetHits += 1;
	}
	const head = net.queue.size > 0 ? net.queue.time[0] : Infinity;
	check('a budgeted drain keeps the clock monotone and never passes the next event',
		monotone && !(head < net.time), { time: Math.round(net.time), lag: Math.round(net.lag) });
	check('a budgeted clock that cannot keep up reports its backlog',
		budgetHits > 0 && net.lag > 0, Math.round(net.lag));

	// The same rate without a budget keeps up exactly: the guard is a ceiling,
	// not a change of law at the authored top.
	const full = seedNetwork(24, 0);
	for (let f = 0; f < 240; f++) trade.step(full, 2000 / 60, 0);
	check('at the synced top rate an unbudgeted clock stays exact',
		Math.abs(full.time - 240 * 2000 / 60) < 1e-6 && full.lag === 0, Math.round(full.time));

	// The capital: the first world inside the home reach becomes a port even
	// when the settled-fraction roll says no, so the arrival has a colony and H
	// has a destination.
	const home = trade.createNetwork({ seed: 4242, modelSeed: model.seed, homeX: 0, homeY: 0, homeZ: 0 });
	for (let i = 0; i < 24; i++) {
		landmarkRef(i, scratchRef);
		planets.generateSystem(scratchRef, ctx, record);
		trade.discoverSystem(home, scratchRef, ctx.name, record, 0);
	}
	trade.finalize(home);
	let capitalLy = Infinity;
	if (home.capital >= 0) {
		const p = home.ports[home.capital];
		capitalLy = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z) * trade.LY_PER_KPC;
	}
	check('a capital colony is forced beside the viewer home',
		home.capital >= 0 && capitalLy <= 20, { capital: home.ports[home.capital] ? home.ports[home.capital].name : 'none', ly: Math.round(capitalLy) });

	// The colonisation readout explains an empty frontier instead of blaming
	// big colonies, which is the bug the panel used to show.
	const fresh = seedNetwork(24, 0);
	fresh.lastExpedition = fresh.time;
	const opportunities = trade.colonisationPreview(fresh, fresh.time);
	const status = trade.colonisationStatus();
	check('the colonisation readout names the gate that is shut',
		(opportunities.length > 0) === (status.reason === '')
		&& (opportunities.length > 0 || status.reason.length > 0),
		{ opportunities: opportunities.length, reason: status.reason, big: status.big });

	// The manual launch goes through the same cost and reservation path.
	const launch = seedNetwork(24, 0);
	const before = launch.portCount;
	const result = trade.launchBest(launch, launch.time);
	let founding = 0;
	for (let i = 0; i < launch.shipCount; i++) if (launch.ships[i].state === trade.SHIP_FOUNDING) founding += 1;
	check('the manual launch sends exactly one expedition or says why not',
		result.ok ? (founding === 1 && launch.portCount === before) : (founding === 0 && result.reason.length > 0),
		{ ok: result.ok, reason: result.reason, founding });
}

// --- 12. The frontier scan, on a live field -------------------------------
// The app calls expandFrontierFromField with renderer.fieldBuffers() every half
// second. The fixture here is the real sampled field, so the path that the
// browser takes — field star index, its canonical key, a generated system, a
// candidate with a ref that resolves — is the one under test.
{
	const sampling = require('../src/math/sampling.js');
	const starTypes = require('../src/math/star-types.js');
	const net = seedNetwork(24, 0);
	trade.step(net, 4000);
	let big = 0;
	for (let i = 0; i < net.portCount; i++) if (trade.isBigColony(net.ports[i].colony)) big += 1;
	const field = sampling.sampleGalaxyStars(model, model.seed | 0, 120000);
	const before = net.candidateCount;
	const cursorBefore = net.frontierCursor;
	// The scan is a ring: one pass covers FRONTIER_SCAN stars, so a 120k field
	// needs a full sweep before the slice that holds the colonies comes round.
	let added = 0;
	for (let i = 0; i < 40; i++) added += trade.expandFrontierFromField(net, field, model);
	check('a live field grows the frontier around the big colonies',
		big > 0 && added > 0 && net.candidateCount > before,
		{ big, added, candidates: before + '->' + net.candidateCount });
	// Every added world is a real field star within reach of a big colony, and
	// its ref is the canonical identity — the key the label layer resolves
	// against the drawn record and the picker returns.
	let fieldCandidates = 0, withinReach = true, canonical = true, aliased = false;
	const seen = new Set();
	for (let i = 0; i < net.candidateCount; i++) {
		const site = net.candidates[i].site;
		if (site.ref.kind !== planets.BLOCK_FIELD) continue;
		fieldCandidates += 1;
		if (site.key >>> 0 !== starTypes.fieldStarSeed(model.seed, site.ref.index) >>> 0) canonical = false;
		if (seen.has(site.ref.index)) aliased = true;
		seen.add(site.ref.index);
		let near = false;
		for (let p = 0; p < net.portCount; p++) {
			if (!trade.isBigColony(net.ports[p].colony)) continue;
			const dx = site.ref.x - net.ports[p].x, dy = site.ref.y - net.ports[p].y, dz = site.ref.z - net.ports[p].z;
			if (Math.sqrt(dx * dx + dy * dy + dz * dz) * trade.LY_PER_KPC <= trade.MAX_FOUND_LY + 1e-6) { near = true; break; }
		}
		if (!near) withinReach = false;
	}
	check('frontier worlds are canonical, distinct and within a big colony’s reach',
		fieldCandidates > 0 && withinReach && canonical && !aliased,
		{ fieldCandidates, withinReach, canonical, aliased });
	check('the scan walks a ring cursor instead of rescanning the head',
		net.frontierCursor !== cursorBefore || added < 8 * 4,
		{ cursorBefore, cursor: net.frontierCursor });
	// A network with no big colony has no frontier to expand, and an absent
	// field is a no-op — the app calls this before the field is sampled.
	const fresh = seedNetwork(24, 0);
	const freshBefore = fresh.candidateCount;
	check('no big colony and no field both leave the frontier alone',
		trade.expandFrontierFromField(fresh, field, model) === 0
		&& trade.expandFrontierFromField(fresh, null, model) === 0
		&& fresh.candidateCount === freshBefore);
}

// --- 13. The overlay's growth cues ---------------------------------------
{
	const previousWindow = global.window;
	const records = require('../src/math/star-record.js');
	const layerLib = require('../src/render/label-layer.js');
	const lines = [], arcs = [];
	const context = {
		setTransform() {}, clearRect() {}, beginPath() {}, stroke() {}, fill() {},
		moveTo() {}, lineTo(x, y) { lines.push([x, y]); }, arc(x, y, radius) { arcs.push([x, y, radius]); },
	};
	const canvas = { width: 0, height: 0, getContext: () => context };
	const orbit = { engineRecordPosition(out, x, y, z) { out[0] = x; out[1] = y; out[2] = z; } };
	global.window = { StarRecord: records, OrbitLib: orbit };
	const layer = layerLib.createLabelLayer(canvas, { count: 0 }, { LINES: [] });
	layer.setEnabled(false);
	layer.resize(100, 100, 1);
	const view = new DataView(new ArrayBuffer(2 * records.RECORD_BYTES));
	view.setFloat32(0, -0.5, true);
	view.setFloat32(records.RECORD_BYTES, 0.5, true);
	const info = { view, identity: new Uint32Array([10, 20]), total: 2, blocks: [{ offset: 0 }] };
	layer.setStarSource(info);
	layer.setOrbitState({}, 1);
	const ports = [
		{ key: 10, ref: { kind: 0, index: 0 }, colony: { abandoned: 0, pop: 900, capacity: 900, growth: 0.01, founded: -400 } },
		{ key: 20, ref: { kind: 0, index: 1 }, colony: { abandoned: 0, pop: 100, capacity: 900, growth: 0.01, founded: 20 } },
	];
	const net = { portCount: 2, shipCount: 1, candidateCount: 0, ports, candidates: [],
		ships: [{ state: trade.SHIP_SAILING, from: 0, to: 1, depart: 0, arrive: 100, cargo: 0 }] };
	const matrix = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
	const camera = { cameraPos: [0, 0, 0], buildViewProj: () => matrix };
	const ringOf = frac => 2 + 5.5 * Math.sqrt(frac);
	// The young port is 5 years old at t = 25: it wears the extra ring.
	layer.setTradeOverlay(net, 25, true);
	layer.draw(camera, 100, 100);
	check('a colony founded within the century wears its growth ring',
		arcs.some(a => near(a[2], ringOf(100 / 900) + 2))
		&& !arcs.some(a => near(a[2], ringOf(1) + 2)),
		{ arcs: arcs.length });
	// Route lines are the checkbox's business; the colonies are not.
	lines.length = 0;
	arcs.length = 0;
	layer.setTradeOverlay(net, 25, true, false);
	layer.draw(camera, 100, 100);
	check('hiding routes keeps the colonies and hulls on screen',
		lines.length === 0 && arcs.length >= 3, { lines: lines.length, arcs: arcs.length });
	// The clock moves on: the same port stops being new.
	arcs.length = 0;
	layer.setTradeOverlay(net, 400, true, false);
	layer.draw(camera, 100, 100);
	check('a colony leaves its growth ring behind once it is old',
		!arcs.some(a => near(a[2], ringOf(100 / 900) + 2)));
	global.window = previousWindow;
}

// --- 14. A quiet network is quiet: idle hulls back off --------------------
// A hull with nothing to carry polls its port. A two-year poll at a 2 000 y/s
// clock is a thousand events a second per idle hull, which is how a saturated
// network turns into a frame budget with no work to show for it.
{
	const dead = seedNetwork(24, 0);
	for (let i = 0; i < dead.portCount; i++) {
		const colony = dead.ports[i].colony;
		colony.stock.fill(0);
		colony.stockCap.fill(0);
		colony.outBase.fill(0);
		colony.pop = 0.5;
	}
	const events = trade.step(dead, 5000);
	let waiting = 0, backedOff = 0;
	for (let i = 0; i < dead.shipCount; i++) {
		const ship = dead.ships[i];
		if (ship.state !== trade.SHIP_WAITING) continue;
		waiting += 1;
		if (ship.waits >= 6) backedOff += 1;
	}
	check('an idle hull backs off instead of polling every two years',
		waiting > 0 && backedOff === waiting && events < 1500,
		{ events, waiting, backedOff });
}

// --- 15. The generation-ship mode keeps its network alive -----------------
// Ships at 1 ly per 1 000 years take millennia per voyage, so a port with the
// authored 150-year warehouse would starve between two arrivals: coverage,
// growth and the big-colony gate would all fall and the mode would show a
// dying network. The reserve horizon moves with the fleet instead.
{
	const net = seedNetwork(24, 0);
	trade.step(net, 4000);
	const capFree = net.ports[0].colony.stockCap[5];
	let bigFree = 0;
	for (let i = 0; i < net.portCount; i++) if (trade.isBigColony(net.ports[i].colony)) bigFree += 1;
	trade.setGenerationMode(1, net);
	const capGen = net.ports[0].colony.stockCap[5];
	const expected = trade.GENERATION_RESERVE_YEARS / economy.STOCK_YEARS;
	check('the special mode sizes the warehouses to the fleet’s crossing time',
		near(capGen / capFree, expected) && near(economy.getReserveScale(), expected),
		{ ratio: +(capGen / capFree).toFixed(2), expected: +expected.toFixed(2) });
	const rate = trade.clockRate(100, 2, true);
	for (let f = 0; f < 60 * 10; f++) trade.step(net, rate / 60, 256);
	const coverage = [];
	let bigGen = 0;
	for (let i = 0; i < net.portCount; i++) {
		const colony = net.ports[i].colony;
		coverage.push(colony.coverage);
		if (trade.isBigColony(colony)) bigGen += 1;
	}
	coverage.sort((a, b) => a - b);
	const median = coverage[coverage.length >> 1];
	trade.setGenerationMode(0, net);
	check('a generation-ship network keeps its colonies instead of starving',
		bigGen >= bigFree - 1 && median > 0.3, { bigFree, bigGen, median: +median.toFixed(2) });
	check('leaving the special mode restores the authored warehouses',
		near(economy.getReserveScale(), 1) && near(net.ports[0].colony.stockCap[5], capFree));
}

// --- Summary --------------------------------------------------------------
{
	const passed = checks.filter(c => c.pass).length;
	const summary = { total: checks.length, passed, failed: checks.length - passed, checks };
	logFile.writeLog(path.join(__dirname, 'logs', 'trade.json'), summary);
	console.log(`trade: ${passed}/${checks.length} passed`);
	for (const c of checks) if (!c.pass) console.log('FAIL ' + c.name, c.detail === undefined ? '' : c.detail);
	console.log('\n=== VERDICT ===');
	console.log(passed === checks.length ? 'PASS' : 'FAIL');
	if (passed !== checks.length) process.exit(1);
}
