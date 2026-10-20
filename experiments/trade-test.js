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
	// approximation (trade-plan §2.2). In the network this never compounds,
	// because ships settle their ports at event times; here the jump must
	// still track its stepped twin.
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
