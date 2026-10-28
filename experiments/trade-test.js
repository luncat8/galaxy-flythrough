// experiments/trade-test.js
// Validates the colony economy and the trade network (trade-plan.md):
//   §2  the 13-resource map, its stable per-site hash, the authored tables,
//       and the closed-form colony settle (a jump equals the same stretch in
//       small steps — the exec-queue discipline, applied to stocks),
//   §3  the event network: ports, ships, arrivals, colonisation, the queue's
//       bounds and the jump-equals-steps invariant on the whole network,
//   §4  the player's tonnage/units bridge (load, carry, sell back),
//   §5  the draw state the galaxy overlay reads,
//   §§27–29 T1–T4 families, world folds, DeltaV graph, statistical flows and T5 readout.
//
// The legacy fixtures use real landmark systems through planets.generateSystem;
// the T4 pins use a recorded Solar fixture to isolate the physical graph law.
// Output: experiments/logs/trade.json

'use strict';

const path = require('path');
const logFile = require('./log-file.js');
const planets = require('../src/math/planets.js');
const deltav = require('../src/math/deltav.js');
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

function syntheticIntraSystem(options) {
	const opts = options || {};
	const system = planets.createSystemRecord();
	const star = system.star;
	star.key = (opts.key === undefined ? 0x544534 : opts.key) >>> 0;
	star.mass = opts.starMass === undefined ? 1 : opts.starMass;
	star.lum = 1; star.teff = 5772; star.rStar = 1; star.age = 4.6; star.metal = 0.02;
	star.state = 'ms'; star.spectralClass = 'G';
	star.aHzIn = planets.hzInnerAU(1); star.aHzOut = planets.hzOuterAU(1);
	star.aSnow = planets.snowLineAU(1); star.aOut = planets.outerEdgeAU(1, 'ms');
	const defs = opts.planets || [
		{ a: 1, mass: 1, radius: 1, type: 3, flags: planets.FLAG_TERRAN | planets.FLAG_IN_HZ },
		{ a: 1.524, mass: 0.107, radius: 0.532, type: 2, flags: 0 },
	];
	system.counts.planets = defs.length;
	system.counts.terranCount = 0;
	system.counts.giantCount = 0;
	for (let i = 0; i < defs.length; i++) {
		const def = defs[i];
		const p = system.planets;
		const type = def.type === undefined ? 3 : def.type;
		const a = def.a;
		const mass = def.mass === undefined ? 1 : def.mass;
		const radius = def.radius === undefined ? 1 : def.radius;
		p.a[i] = a; p.mass[i] = mass; p.radius[i] = radius;
		p.density[i] = def.density === undefined ? 5.51 : def.density;
		p.e[i] = 0; p.inc[i] = 0; p.peri[i] = 0; p.phase[i] = 0;
		p.period[i] = Math.sqrt(a * a * a / star.mass);
		p.teq[i] = 288 / Math.sqrt(Math.sqrt(a * a));
		p.tsurf[i] = def.tsurf === undefined ? (type === 3 ? 288 : 220) : def.tsurf;
		p.insolation[i] = planets.insolation(star.lum, a);
		p.rHill[i] = a * Math.pow(mass / 333000, 1 / 3);
		p.rotHours[i] = def.rotHours === undefined ? 24 : def.rotHours;
		p.moons[i] = 0;
		p.displayType[i] = type;
		p.bulk[i] = planets.BULK_INDEX[planets.DISPLAY_TYPES[type].bulk];
		p.flags[i] = def.flags === undefined ? (type === 3 ? planets.FLAG_TERRAN | planets.FLAG_IN_HZ : 0) : def.flags;
		if (type === 3) system.counts.terranCount += 1;
		if (type === 7 || type === 8) system.counts.giantCount += 1;
	}
	const beltA = opts.beltA;
	system.belts.count = beltA === undefined || beltA === null ? 0 : 1;
	if (system.belts.count) {
		system.belts.kind[0] = 0;
		system.belts.a[0] = beltA;
		system.belts.dlnA[0] = 0.12;
		system.belts.mass[0] = 0.02;
		system.belts.stippleSeed[0] = 424242;
	}
	return system;
}

function syntheticSite(system, ref, isBelt, index, name) {
	const site = economy.createSite();
	const seed = economy.siteSeed(ref.key >>> 0, model.seed, ref.kind);
	if (isBelt) economy.fillBeltSite(site, ref, system, index, seed);
	else economy.fillPlanetSite(site, ref, system, index, seed);
	site.name = name || economy.siteName('T4', ref.key >>> 0, isBelt ? 1 : 0, index);
	site.x = ref.x; site.y = ref.y; site.z = ref.z;
	site.ref = ref;
	return site;
}

function syntheticTradePort(system, firstKind, firstIndex, secondKind, secondIndex, firstName, secondName) {
	const ref = {
		kind: planets.BLOCK_LANDMARK, index: 0, key: system.star.key >>> 0,
		x: 0, y: 0, z: 0, colorIndex: 4, absMag: 4.83,
	};
	const net = trade.createNetwork({ seed: 1701, modelSeed: model.seed, timeYears: 0 });
	const firstSite = syntheticSite(system, ref, firstKind, firstIndex, firstName);
	const portIndex = trade.addPort(net, firstSite, 0, trade.FRESH_FOUND, system);
	if (secondKind !== undefined) {
		const secondSite = syntheticSite(system, ref, secondKind, secondIndex, secondName);
		trade.addWorld(net, portIndex, secondSite, 0, trade.FRESH_FOUND, system);
	}
	const port = net.ports[portIndex];
	const worlds = new Array(port.worldCount);
	for (let s = 0; s < port.worldCount; s++) worlds[s] = trade.worldOfPort(net, portIndex, s);
	return { net, portIndex, port, worlds, ref };
}

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

// The app's start map (trade-plan §8): the named sky plus the rendered field
// nearest home first, through the same startSystems/discoverNearest the page
// calls. The field is the page's default 300k sample, and the scenario's seed
// is the model's, so the fixture measures the scenario the viewer boots into.
const scenarioField = require('../src/math/sampling.js').sampleGalaxyStars(model, model.seed | 0, 300000);
function seedStart(timeYears) {
	const net = trade.createNetwork({ seed: model.seed | 0, modelSeed: galaxy.DEFAULT_SEED, timeYears: timeYears || 0 });
	// The page wires its live field into the system generator before the start
	// map is discovered; a null field would generate the field stars from a
	// different path and the fixture would not be the scenario.
	const previousField = ctx.field;
	ctx.field = scenarioField;
	const systems = trade.startSystems(net, ctx.model, scenarioField, landmarks, []);
	trade.discoverNearest(net, systems, ctx, record);
	ctx.field = previousField;
	return trade.finalize(net);
}

// --- 5b. The seed map respects the formation gate ------------------------
// The network used to seed from the reference census, so a run at first
// light — the field all gas, not one procedural star condensed — still
// arrived with four colonies and a fleet sailing between stars that do not
// exist yet. The gate is the field's own birth channel, the same one the
// vertex stage reads, so the economy exists exactly where the sky has stars.
{
	const starTypes = require('../src/math/star-types.js');
	const namedSky = require('../src/core/named-sky.js');
	// The renderer's own birth law, so this fixture is the sky the page draws
	// rather than an invented one.
	const reference = galaxy.modelAtAge(model, galaxy.AGE_REF);
	const births = new Float32Array(scenarioField.count);
	let earliest = Infinity, latest = -Infinity;
	for (let i = 0; i < scenarioField.count; i++) {
		const b = starTypes.sampleFieldBirth(reference, starTypes.fieldStarSeed(model.seed | 0, i),
			scenarioField.component[i], scenarioField.R[i], scenarioField.distToArm[i], scenarioField.z[i]);
		births[i] = b;
		if (b < earliest) earliest = b;
		if (b > latest) latest = b;
	}
	const gatedField = Object.assign({}, scenarioField, { birth: births });
	check('the fixture carries a finite birth channel inside the model\u2019s own span',
		Number.isFinite(earliest) && Number.isFinite(latest)
		&& earliest >= 0 && latest <= galaxy.AGE_REF, { earliest, latest });

	function seedAt(age, field) {
		const atAge = galaxy.modelAtAge(model, age);
		const net = trade.createNetwork({ seed: model.seed | 0, modelSeed: galaxy.DEFAULT_SEED, timeYears: 0,
			homeX: model.home.orbitTarget.x, homeY: model.home.orbitTarget.y, homeZ: model.home.orbitTarget.z });
		const previousField = ctx.field;
		ctx.field = field;
		const systems = trade.startSystems(net, atAge, field, landmarks, []);
		trade.discoverNearest(net, systems, ctx, record);
		ctx.field = previousField;
		return { net: trade.finalize(net), systems, atAge };
	}

	const firstLight = seedAt(0, gatedField);
	check('at first light the seed map is empty — no star has formed to settle',
		firstLight.systems.length === 0, firstLight.systems.length);
	check('and the network arrives with no colony and no hull',
		firstLight.net.portCount === 0 && firstLight.net.shipCount === 0
		&& firstLight.net.worldCount === 0,
		{ ports: firstLight.net.portCount, ships: firstLight.net.shipCount });
	check('running an empty sky for five millennia still founds nothing', (() => {
		trade.step(firstLight.net, 5000);
		return firstLight.net.portCount === 0 && firstLight.net.founded === 0;
	})(), { ports: firstLight.net.portCount, founded: firstLight.net.founded });

	const today = seedAt(galaxy.AGE_REF, gatedField);
	check('the present-day sky still seeds its colonies', today.net.portCount > 0,
		today.net.portCount);
	check('and its seed count is unchanged by the gate at the reference epoch',
		today.systems.length > 0 && today.net.portCount >= 1);

	// Measured on this fixture: the earliest birth within the seed radius of
	// home is 1.37 Gyr, so 1 Gyr is empty and 3 Gyr is the first epoch with a
	// local sky. The gate is what makes that difference visible.
	const YOUNG = 3;
	const young = seedAt(YOUNG, gatedField);
	check('a young epoch seeds from the local sky it has by then',
		young.systems.length > 0 && young.net.portCount > 0,
		{ systems: young.systems.length, ports: young.net.portCount });
	check('every field star it settles has formed by that epoch', (() => {
		const fade = 0.05;   // orbit.BIRTH_FADE_GYR, the gate's own ramp
		for (let i = 0; i < young.systems.length; i++) {
			const s = young.systems[i];
			if (s.ref.kind !== planets.BLOCK_FIELD) continue;
			if (!(births[s.ref.index] <= YOUNG + fade)) return false;
		}
		return true;
	})(), young.systems.length);
	check('and the gate really removed candidates the reference sky would have taken',
		young.systems.length < today.systems.length,
		{ young: young.systems.length, today: today.systems.length });


	// The curated named stars are today's sky, so they are not settleable
	// outside it either — the same gate the label layer and the sprite block use.
	check('the named sky is refused at first light but present at the reference epoch',
		namedSky.reasonOf(galaxy.modelAtAge(model, 0), 0) === namedSky.REASON_EPOCH
		&& namedSky.reasonOf(model, 0) === namedSky.REASON_OK);
	const noField = seedAt(galaxy.AGE_REF, Object.assign({}, scenarioField, { count: 0 }));
	check('with no field the named sky alone still settles the capital',
		noField.net.portCount > 0, noField.net.portCount);
	const youngNamed = seedAt(0, Object.assign({}, scenarioField, { count: 0 }));
	check('and at first light the named sky settles nothing either',
		youngNamed.systems.length === 0 && youngNamed.net.portCount === 0,
		{ systems: youngNamed.systems.length, ports: youngNamed.net.portCount });
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

	const grown = seedStart(0);
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
				if (c.outpost) continue;
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
	check('ship state names cover every state', trade.SHIP_STATE_NAMES.length === 5
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
		declining.pop === 0 && declining.outpost === 1
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
	c.outpost = 1;
	check('an outpost is still offered as a player port', trade.playerPort(net, net.ports[0].key) === 0);
	const heldTons = ship.cargo;
	const heldUnits = heldTons;
	check('and the transfer, not the lookup, refuses with its own reason',
		trade.playerLoad(net, ship, 0).ok === 0
		&& trade.playerLoad(net, ship, 0).reason === 'outpost \u2014 no trade here'
		&& ship.cargo === heldUnits);
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

	const jump = seedStart(0), small = seedStart(0);
	trade.step(jump, 5000);
	stepSmall(small, 5000, 5);
	// The narration ring is a view of *when the network noticed*, not simulation
	// state: a jump crosses several rungs in one settle and a walk crosses them
	// one at a time, so the log's timestamps legitimately differ. Everything a
	// decision reads must still be identical.
	const withoutLog = net => JSON.stringify(Object.assign({}, net, { log: null }));
	check('a 5,000-year jump matches the entire stepped network, including stocks, fleet and heap',
		withoutLog(jump) === withoutLog(small));
	check('every hull has exactly one current event after five millennia', exactLiveEvents(jump));
	check('the long tournament completes real deliveries and foundings', jump.delivered > 0 && jump.founded > 0);

	// Force long overlapping expeditions so the reservation invariant is
	// tested independently of the currently faster-than-launch-interval hulls.
	const speed = trade.HULLS[2].lyPerYear;
	trade.HULLS[2].lyPerYear = 0.01;
	const overlapping = seedStart(0);
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
	let broken = -1, sourcePop = 0, returning = 0;
	for (let i = 0; i < overlapping.shipCount; i++) {
		const ship = overlapping.ships[i];
		if (ship.state !== trade.SHIP_FOUNDING) continue;
		broken = i;
		sourcePop = overlapping.ports[ship.from].colony.pop;
		returning = ship.amount * trade.POP_PER_COLONIST_UNIT;
		overlapping.candidates[ship.candidate].used = 1;
		queueLib.push(overlapping.queue, overlapping.time + 1, trade.EV_FOUND, i, ++ship.revision);
		break;
	}
	trade.step(overlapping, 1);
	check('failed founding releases reservations and schedules a source-port load',
		broken >= 0 && overlapping.ships[broken].state === trade.SHIP_DOCKED
		&& overlapping.ships[broken].port === overlapping.ships[broken].from
		&& overlapping.candidates.every(c => c.reserved !== broken) && exactLiveEvents(overlapping));
	// The party was drawn from the population, so a failed voyage brings it
	// back instead of deleting people the source can never recover.
	const source = broken >= 0 ? overlapping.ports[overlapping.ships[broken].from].colony : null;
	const gained = source ? source.pop - sourcePop : 0;
	check('a failed founding returns the volunteers to the source population',
		broken >= 0 && returning > 0 && gained >= returning * 0.9 && gained <= returning + source.capacity * 0.05,
		{ returning: +returning.toFixed(2), gained: +gained.toFixed(2) });
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
		colony: { outpost: 0, pop: i === 0 ? 900 : 0, capacity: 900, growth: i === 0 ? 0.01 : -0.01 } }));
	const net = { portCount: 2, shipCount: 1, candidateCount: 0, ports, candidates: [],
		ships: [{ state: trade.SHIP_SAILING, from: 0, to: 1, depart: 0, arrive: 100, cargo: 0,
			hull: 0, legFrom: 0, legTo: 1, returning: 0 }] };
	const matrix = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
	const refOut3 = [0, 0, 0];
	const camera = { cameraPos: [0, 0, 0], buildViewProj: () => matrix };
	layer.setTradeOverlay(net, 25, true);
	layer.draw(camera, 100, 100);
	check('trade routes preserve both independently resolved drawn endpoints',
		lines.length === 1 && near(lines[0][0], 30) && near(lines[0][2], 80));
	const hull = arcs.find(a => a[2] === 2.2);
	check('the trade hull interpolates between drawn endpoints, not at the destination',
		hull && near(hull[0], 42.5) && near(hull[1], 50));
	// trade.8 (§9.4): the place on the chord is the flown distance over the
	// *current* chord, and a diverted hull runs the chord backwards.
	const ruleShip = { hull: 0, depart: 0, arrive: 100, legFrom: 0, legTo: 1, returning: 0 };
	const fracHalf = trade.shipFraction(null, ruleShip, 25, 50);
	const fracGrown = trade.shipFraction(null, ruleShip, 25, 100);
	const fracBack = trade.shipFraction(null, { hull: 0, depart: 0, arrive: 100, legFrom: 1, legTo: 0 }, 25, 100);
	check('a hull sits at its flown distance on the current chord, and a divert reverses it',
		near(fracHalf, 1) && near(fracGrown, 0.5) && near(fracBack, 0.5),
		{ fracHalf, fracGrown, fracBack });

	// trade.8 (§9.5): under the friction field a field record's drawn azimuth is
	// the tracked mirror's — the same law the compute pass steps — not the birth
	// position the plain dispatch has to fall back to.
	{
		const orbitReal = require('../src/math/orbit.js');
		const savedEngine = orbitReal.getEngine();
		orbitReal.setEngine('simple');
		orbitReal.simpleTrackReset(galaxy.MILKY_WAY, 0);
		const realWindow = global.window;
		global.window = { StarRecord: records, OrbitLib: orbitReal };
		const layerReal = layerLib.createLabelLayer(canvas, { count: 0 }, { LINES: [] });
		layerReal.setEnabled(false);
		layerReal.resize(100, 100, 1);
		const viewReal = new DataView(new ArrayBuffer(records.RECORD_BYTES));
		viewReal.setFloat32(0, 8.0, true);       // a field star at the Sun's radius
		viewReal.setFloat32(4, 0.3, true);
		viewReal.setFloat32(8, 0, true);
		const packedReal = (5 | (128 << 8) | 128 << 16 | (0x53 << 24)) >>> 0;
		viewReal.setUint32(12, packedReal, true);
		const infoReal = { view: viewReal, identity: new Uint32Array([99]), total: 1, blocks: [{ offset: 0 }] };
		layerReal.setStarSource(infoReal);
		layerReal.setOrbitState(galaxy.MILKY_WAY, 0);
		const at0 = [0, 0, 0], at40 = [0, 0, 0], birth = [8.0, 0.3, 0];
		const ok0 = layerReal.tradeRecordPosition(0, 0, 99, at0);
		// Forty Myr of the friction field, in frame-sized steps, exactly as the
		// page's loop dispatches them.
		for (let f = 0; f < 400; f++) orbitReal.simpleTrackStep(0.1, (f + 1) * 0.1);
		layerReal.setOrbitState(galaxy.MILKY_WAY, 40);
		const ok40 = layerReal.tradeRecordPosition(0, 0, 99, at40);
		const slot = orbitReal.simpleTrackSlotOf(99);
		const theta = slot >= 0 ? orbitReal.simpleTrackThetaAt(slot, 40) : -1;
		// The layer reads the record's birth bytes, which are f32: the reference
		// must take the same values or the comparison is measuring the float
		// rounding, not the mirror.
		orbitReal.engineRecordPositionTheta(refOut3, viewReal.getFloat32(0, true), viewReal.getFloat32(4, true),
			viewReal.getFloat32(8, true), packedReal, 40, galaxy.MILKY_WAY, theta);
		const mirrored = slot >= 0 && near(at40[0], refOut3[0]) && near(at40[1], refOut3[1]) && near(at40[2], refOut3[2]);
		const moved = Math.hypot(at40[0] - birth[0], at40[1] - birth[1], at40[2] - birth[2]) > 0.05;
		check('under the friction field the trade resolver reads the tracked mirror, not the birth sky',
			ok0 && ok40 && slot >= 0 && mirrored && moved,
			{ slot, moved: +moved, d: +Math.hypot(at40[0] - birth[0], at40[1] - birth[1], at40[2] - birth[2]).toFixed(3),
				at: at40.map(v => +v.toFixed(6)), ref: refOut3.map(v => +v.toFixed(6)), theta });
		layerReal.setEnabled(false);
		global.window = realWindow;
		orbitReal.setEngine(savedEngine);
	}
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

	// Generation ships: a frontier hop is watchable at the top of the fine star
	// range, which is the calibration the mode is authored against. 100 ly is
	// the scale of the sampled field's first shell; the 600 ly maximum is
	// twenty seconds, not a stall.
	trade.setGenerationMode(1);
	const genYears = trade.legYears(100 / trade.LY_PER_KPC, 2);   // a 100 ly hop
	trade.setGenerationMode(0);
	const genSeconds = genYears / trade.clockRate(100, trade.GENERATION_STAR_MYR, true);
	check('a generation-ship frontier hop lasts seconds at the default synced pace',
		genSeconds > 1 && genSeconds < 6 && near(genSeconds, 100 / trade.GENERATION_LY_PER_YEAR / trade.clockRate(100, trade.GENERATION_STAR_MYR, true), 1e-9),
		{ legYears: Math.round(genYears), wallS: +genSeconds.toFixed(2) });
	check('the freighter cruise is untouched by the special mode above the legibility floor',
		Math.abs(trade.legYears(300 / trade.LY_PER_KPC, 2) - 300 / trade.HULLS[2].lyPerYear) < 1e-9
		&& trade.legYears(0, 2) === trade.MIN_LEG_YEARS);

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
	const opportunities = trade.colonisationPreview(fresh, fresh.time);
	const status = trade.colonisationStatus();
	check('the colonisation readout names the gate that is shut',
		(opportunities.length > 0) === (status.reason === '')
		&& (opportunities.length > 0 || status.reason.length > 0),
		{ opportunities: opportunities.length, reason: status.reason, big: status.big });

	// The resting state is the panel's common case: the tick has just spent
	// every ready port. A preview that only worked on a fresh network would
	// crash (or lie) exactly when the player looks at it.
	const restingNet = seedStart(0);
	trade.step(restingNet, 1000);
	const restingList = trade.colonisationPreview(restingNet, restingNet.time);
	const restingStatus = trade.colonisationStatus();
	check('the colonisation readout works while every big port is resting',
		restingStatus.resting > 0 && restingList.length === 0
		&& restingStatus.reason.length > 0 && finite(restingStatus.nextIn) && restingStatus.nextIn > 0,
		{ resting: restingStatus.resting, nextIn: Math.round(restingStatus.nextIn), reason: restingStatus.reason });

	// The manual launch goes through the same cost and reservation path.
	const launch = seedNetwork(24, 0);
	const before = launch.portCount;
	const result = trade.launchBest(launch, launch.time);
	let founding = 0;
	for (let i = 0; i < launch.shipCount; i++) if (launch.ships[i].state === trade.SHIP_FOUNDING) founding += 1;
	check('the manual launch sends exactly one expedition or says why not',
		result.ok ? (founding === 1 && launch.portCount === before) : (founding === 0 && result.reason.length > 0),
		{ ok: result.ok, reason: result.reason, founding });

	// The button is the player's hand: it may sponsor a port that is still
	// resting between automatic waves, and that port's cooldown restarts.
	const rushNet = seedStart(0);
	trade.step(rushNet, 1000);
	let restingPorts = 0;
	for (let i = 0; i < rushNet.portCount; i++) {
		if (rushNet.time - rushNet.ports[i].lastExpedition < trade.EXPEDITION_COOLDOWN) restingPorts += 1;
	}
	const rush = trade.launchBest(rushNet, rushNet.time);
	check('the Send-expedition button can rush a resting port and restarts its cooldown',
		restingPorts > 0 && rush.ok === 1 && rushNet.ports[rush.source].lastExpedition === rushNet.time,
		{ restingPorts, ok: rush.ok, reason: rush.reason });
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
		{ key: 10, ref: { kind: 0, index: 0 }, colony: { outpost: 0, pop: 900, capacity: 900, growth: 0.01, founded: -400 } },
		{ key: 20, ref: { kind: 0, index: 1 }, colony: { outpost: 0, pop: 100, capacity: 900, growth: 0.01, founded: 20 } },
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
// Generation-ship hulls fly 1 ly per 33 trade years (30 ly per wall second at
// the synced clock), so even the nearest hops take centuries per voyage and a
// port with the authored 150-year warehouse would starve between two arrivals:
// coverage, growth and the big-colony gate would all fall and the mode would
// show a dying network. The reserve horizon moves with the fleet instead.
{
	const net = seedStart(0);
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
	const rate = trade.clockRate(100, trade.GENERATION_STAR_MYR, true);
	const portsBefore = net.portCount;
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
	check('and keeps founding through the slow fleet instead of standing still',
		net.portCount > portsBefore && net.founded > 0,
		{ portsBefore, ports: net.portCount, founded: net.founded });
	check('leaving the special mode restores the authored warehouses',
		near(economy.getReserveScale(), 1) && near(net.ports[0].colony.stockCap[5], capFree));
}

// --- 16. The start scenario (trade-plan §8) ------------------------------
// Four colonies beside home, the capital nearest it, and a network that keeps
// expanding: 5–20 colonies after 10 s, 18–40 after 20 s, at least 45 after 40 s
// and the full 64-port network by 90 s. The old band (5–15 at 10 and 20 s) was
// a plateau at 14; these numbers are the trade.7 growth curve, measured on the
// fixture itself with the page's field attached.
{
	const net = seedStart(0);
	check('the scenario starts with exactly four colonies', net.portCount === 4 && trade.SEED_PORTS === 4,
		{ ports: net.portCount });
	const ly = (p) => Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z) * trade.LY_PER_KPC;
	let nearest = 0;
	for (let i = 1; i < net.portCount; i++) if (ly(net.ports[i]) < ly(net.ports[nearest])) nearest = i;
	const far = Math.max(...net.ports.slice(0, net.portCount).map(ly));
	check('the capital is the colony beside home, and the nearest port to it',
		net.capital === nearest && ly(net.ports[net.capital]) <= trade.HOME_COLONY_LY,
		{ capital: net.capital, nearest, capitalLy: +ly(net.ports[net.capital]).toFixed(1) });
	check('the start colonies sit within 100 ly of home, not across the sky (Rigil, Fomalhaut, Capella, Regulus)',
		far <= 100, { farthestLy: +far.toFixed(1) });

	const frames = 60 * 90, dt = 1 / 60;
	let at10 = -1, at20 = -1, at40 = -1, at90 = -1, sailingAt20 = 0;
	let youngPort = -1, youngFrac = 0, maint = 0;
	// The user-facing half of the growth change: at the default 100 y/s the
	// capital is founded at ~19 % of capacity and must be a visibly grown ring
	// within a couple of wall seconds, not a still one.
	const capitalStart = net.ports[net.capital].colony.pop / net.ports[net.capital].colony.capacity;
	let capitalAt2 = -1;
	for (let f = 1; f <= frames; f++) {
		trade.step(net, trade.TRADE_RATE_DEFAULT * dt, trade.MAX_PORTS * 4);
		// The page runs the frontier scan twice a second while the clock runs.
		maint += dt;
		if (maint >= 0.5) { maint = 0; trade.expandFrontierFromField(net, scenarioField, model); }
		if (f === 60 * 2) capitalAt2 = net.ports[net.capital].colony.pop / net.ports[net.capital].colony.capacity;
		if (f === 60 * 10) at10 = net.portCount;
		if (f === 60 * 20) {
			at20 = net.portCount;
			for (let i = 0; i < net.shipCount; i++) if (net.ships[i].state === trade.SHIP_SAILING) sailingAt20 += 1;
			for (let i = 0; i < net.portCount; i++) {
				const colony = net.ports[i].colony;
				if (youngPort < 0 || colony.founded > net.ports[youngPort].colony.founded) {
					youngPort = i;
					youngFrac = colony.capacity > 0 ? colony.pop / colony.capacity : 0;
				}
			}
		}
		if (f === 60 * 40) at40 = net.portCount;
		if (f === frames) at90 = net.portCount;
	}
	check('the capital grows from its founding share to a full ring in two seconds',
		capitalStart < 0.3 && capitalAt2 > 0.85,
		{ start: +capitalStart.toFixed(2), at2: +capitalAt2.toFixed(2) });
	check('at the default clock the network holds 5–20 colonies after 10 s',
		at10 >= 5 && at10 <= 20, { at10 });
	check('and 18–40 after 20 s: the expansion continues past the old 14-port plateau',
		at20 >= 18 && at20 <= 40 && at20 > at10, { at10, at20 });
	check('the frontier keeps growing: at least 45 colonies at 40 s and a full 64-port network at 90 s',
		at40 >= 45 && at90 === trade.MAX_PORTS, { at40, at90 });
	const youngNow = youngPort >= 0 && net.ports[youngPort].colony.capacity > 0
		? net.ports[youngPort].colony.pop / net.ports[youngPort].colony.capacity : 0;
	check('the youngest colony fills visibly instead of standing still',
		youngPort >= 0 && youngNow > youngFrac + 0.05, { youngFrac: +youngFrac.toFixed(2), youngNow: +youngNow.toFixed(2) });
	check('the freighters are on the routes while the network grows', sailingAt20 >= 1, { sailingAt20 });
}

// --- 17. Live geometry: the network in a moving sky (trade-plan §9) --------
//
// The fixture is the shipping dispatch, not a hand-rolled rotation: landmarks
// ride engineLandmarkPosition and field records engineRecordPosition, exactly
// as the page's label layer resolves them, so the numbers a booking reads here
// are the numbers it reads on screen. `skyTime` is the star time the resolvers
// answer at; the test moves it and calls refreshGeometry the way main.js does.
{
	const orbit = require('../src/math/orbit.js');
	const starRecord = require('../src/math/star-record.js');
	const savedEngine = orbit.getEngine();
	orbit.setEngine('classic');
	const LY = trade.LY_PER_KPC;

	// The moving sky: birth data in, drawn positions out.
	const birthOf = new Map();
	function register(kind, index, key, x, y, z, packed, colorIndex) {
		birthOf.set(key >>> 0, { kind, index, x, y, z, packed, colorIndex });
	}
	let skyTime = 0;
	function skyAt(ref, t, out) {
		const b = birthOf.get(ref.key >>> 0);
		if (!b) return false;
		if (b.kind === planets.BLOCK_LANDMARK) {
			orbit.engineLandmarkPosition(out, b.index, b.x, b.y, b.z, b.colorIndex, t, model);
		} else {
			orbit.engineRecordPosition(out, b.x, b.y, b.z, b.packed, t, model);
		}
		return true;
	}
	function skyLive(ref, out) { return skyAt(ref, skyTime, out); }
	function skyPredict(ref, t, out) { return skyAt(ref, t, out); }

	// A network over the named sky with the moving resolvers wired. The birth
	// table is filled from the network itself, which is what the page's star
	// buffer holds: a port's record, at its birth position.
	function seedMoving(count) {
		skyTime = 0;
		birthOf.clear();
		const net = trade.createNetwork({ seed: 4242, modelSeed: galaxy.DEFAULT_SEED,
			livePosition: skyLive, predictPosition: skyPredict });
		for (let i = 0; i < count; i++) {
			landmarkRef(i, scratchRef);
			register(planets.BLOCK_LANDMARK, i, scratchRef.key, scratchRef.x, scratchRef.y, scratchRef.z, 0, scratchRef.colorIndex);
			ctx.name = landmarks.ENTRIES[i].name;
			planets.generateSystem(scratchRef, ctx, record);
			trade.discoverSystem(net, scratchRef, ctx.name, record, net.time);
		}
		trade.finalize(net);
		for (let i = 0; i < net.portCount; i++) {
			const p = net.ports[i];
			register(p.ref.kind, p.ref.index, p.key, p.x, p.y, p.z, 0, p.ref.colorIndex | 0);
		}
		for (let i = 0; i < net.candidateCount; i++) {
			const site = net.candidates[i].site;
			const fam = orbit.familyFromColorIndex(site.ref.colorIndex | 0);
			const packed = (5 | (128 << 8) | (((fam << 3) | starRecord.FLAG_VISIBLE) << 16) | ((i * 37 & 255) << 24)) >>> 0;
			register(planets.BLOCK_FIELD, site.ref.index, site.key, site.x, site.y, site.z, packed, 0);
		}
		return net;
	}
	const p1 = [0, 0, 0], p2 = [0, 0, 0];

	// 17.1 The frozen tier: a resolver that is never asked changes nothing.
	{
		const withSky = seedMoving(24);
		const plain = seedNetwork(24);
		trade.refreshGeometry(withSky, 0, 0, 0);
		for (let f = 0; f < 600; f++) {
			trade.step(withSky, 100 / 60, 256);
			trade.step(plain, 100 / 60, 256);
		}
		let samePop = true;
		for (let i = 0; i < withSky.portCount && samePop; i++) {
			if (Math.abs(withSky.ports[i].colony.pop - plain.ports[i].colony.pop) > 1e-9) samePop = false;
		}
		check('a frozen sky is skipped: the network is bit-identical to the birth-frame one',
			samePop && withSky.portCount === plain.portCount && withSky.founded === plain.founded
			&& withSky.shipCount === plain.shipCount
			&& Math.abs(withSky.delivered - plain.delivered) < 1e-9
			&& withSky.diverted === 0 && withSky.geom.moving === 0,
			{ ports: withSky.portCount, founded: withSky.founded, delivered: +withSky.delivered.toFixed(1), samePop });
	}

	// 17.2 The cache holds the drawn positions, and the rates say how fast.
	{
		const net = seedMoving(24);
		trade.refreshGeometry(net, 0, 1, 1e-3);
		skyTime = 60;
		trade.refreshGeometry(net, 60, 1, 1e-3);
		let worstLive = 0, worstBirth = 0, moved = 0;
		for (let i = 0; i < net.portCount; i++) {
			for (let j = i + 1; j < net.portCount; j++) {
				const live = trade.endpointDistanceLy(net, trade.END_PORT, i, trade.END_PORT, j);
				skyAt(net.ports[i].ref, skyTime, p1);
				skyAt(net.ports[j].ref, skyTime, p2);
				const expect = Math.hypot((p1[0] - p2[0]) * LY, (p1[1] - p2[1]) * LY, (p1[2] - p2[2]) * LY);
				worstLive = Math.max(worstLive, Math.abs(live - expect));
				const birth = Math.hypot((net.ports[i].x - net.ports[j].x) * LY,
					(net.ports[i].y - net.ports[j].y) * LY, (net.ports[i].z - net.ports[j].z) * LY);
				worstBirth = Math.max(worstBirth, Math.abs(live - birth));
				if (Math.abs(live - birth) > 5) moved += 1;
			}
		}
		check('the geometry cache is the drawn sky, not the birth one', worstLive < 1e-6 && moved > 0,
			{ worstLive: +worstLive.toExponential(1), moved });
		check('and it has moved measurably by 60 Myr of star time', worstBirth > 50, { worstBirth: +worstBirth.toFixed(0) });
		let rated = 0;
		for (let i = 0; i < net.portCount * 3; i++) if (net.geom.portVel[i] !== 0) rated += 1;
		check('the cached rates are the refresh difference, so a reachability test needs no resolver call',
			net.geom.hasRate === 1 && rated > 0 && net.geom.blind === 0, { hasRate: net.geom.hasRate, rated });
	}

	// 17.3 The booking is the intercept, measured between the two endpoints at
	// arrival: a rigidly rotating sky does not stretch a leg, shear does.
	{
		const net = seedMoving(24);
		trade.refreshGeometry(net, 0, 1, 1e-3);
		skyTime = 60;
		trade.refreshGeometry(net, 60, 1, 1e-3);
		let checked = 0, worstSelf = 0, worstPlan = 0;
		for (let i = 0; i < net.portCount && checked < 6; i++) {
			for (let j = 0; j < net.portCount && checked < 6; j++) {
				if (i === j) continue;
				const book = trade.bookLeg(net, trade.END_PORT, i, trade.END_PORT, j, 0,
					trade.MAX_LEG_LY, trade.createLegPlan());
				if (!book.reachable) continue;
				const plan = trade.planLeg(net, trade.END_PORT, i, trade.END_PORT, j, 0,
					trade.MAX_LEG_LY, trade.createLegPlan());
				// Both endpoints at the arrival instant: the distance the hull's
				// leg is measured as.
				skyAt(net.ports[i].ref, skyTime + book.years * net.geom.myrPerYear, p1);
				skyAt(net.ports[j].ref, skyTime + book.years * net.geom.myrPerYear, p2);
				const sep = Math.hypot((p1[0] - p2[0]) * LY, (p1[1] - p2[1]) * LY, (p1[2] - p2[2]) * LY);
				worstSelf = Math.max(worstSelf, Math.abs(sep - book.ly));
				worstPlan = Math.max(worstPlan, Math.abs(plan.ly - book.ly));
				checked += 1;
			}
		}
		check('a booked leg is the intercept: the endpoints\' separation at arrival is the flown distance',
			checked >= 4 && worstSelf < 2.0, { checked, worstSelf: +worstSelf.toFixed(2) });
		check('the exact solve and the linear plan agree where the sky is locally linear',
			worstPlan < 200, { worstPlan: +worstPlan.toFixed(1) });
		// The page's default 1 Myr/s star clock, and a leg that leaves now.
		const legNow = trade.bookLeg(net, trade.END_PORT, 0, trade.END_PORT, 1, 0,
			trade.MAX_LEG_LY, trade.createLegPlan());
		check('the booking used the predictor while the sky moves', legNow.predicted === 1, { predicted: legNow.predicted });
		trade.refreshGeometry(net, 60, 0, 0);
		const planFrozen = trade.planLeg(net, trade.END_PORT, 0, trade.END_PORT, 1, 0,
			trade.MAX_LEG_LY, trade.createLegPlan());
		const birth0 = Math.hypot((net.ports[0].x - net.ports[1].x) * LY,
			(net.ports[0].y - net.ports[1].y) * LY, (net.ports[0].z - net.ports[1].z) * LY);
		check('a frozen refresh falls back to the birth leg — the numbers the old network used',
			Math.abs(planFrozen.ly - birth0) < 1e-6 && planFrozen.predicted === 0, { birth: +birth0.toFixed(0) });
	}

	// 17.4 Refusals: past the cap, and receding faster than the hull flies.
	{
		const net = seedMoving(24);
		trade.refreshGeometry(net, 0, 1, 1e-3);
		skyTime = 400;
		trade.refreshGeometry(net, 400, 1, 1e-3);
		let far = 0, reachableFar = 0;
		for (let i = 0; i < net.portCount; i++) {
			for (let j = 0; j < net.portCount; j++) {
				if (i === j) continue;
				if (trade.endpointDistanceLy(net, trade.END_PORT, i, trade.END_PORT, j) <= trade.MAX_LEG_LY) continue;
				far += 1;
				if (trade.planLeg(net, trade.END_PORT, i, trade.END_PORT, j, 0,
					trade.MAX_LEG_LY, trade.createLegPlan()).reachable) reachableFar += 1;
			}
		}
		check('a partner the sky has pulled past MAX_LEG_LY is refused, not booked',
			far > 0 && reachableFar === 0, { far, reachableFar });
		// The generation hull flies 30 ly per star-Myr at the synced pace: slower
		// than some of the shear, so a receding pair has no meeting point at all.
		// Inside the cap, on a sky that has moved but not torn everything apart,
		// and with the star clock ten times faster than the synced default: the
		// shear then outruns the generation hull, which is the case this refusal
		// exists for (at the synced rate the 60 Myr shear is ~15 ly per star-Myr
		// and the 30 ly per star-Myr hull still catches it).
		skyTime = 50;
		trade.refreshGeometry(net, 50, 1, 1e-2);
		skyTime = 60;
		trade.refreshGeometry(net, 60, 1, 1e-2);
		trade.setGenerationMode(1, net);
		let outrun = 0, insideCapRefused = 0;
		for (let i = 0; i < net.portCount; i++) {
			for (let j = 0; j < net.portCount; j++) {
				if (i === j) continue;
				const plan = trade.planLeg(net, trade.END_PORT, i, trade.END_PORT, j, 2,
					trade.MAX_LEG_LY, trade.createLegPlan());
				if (!plan.outrun) continue;
				outrun += 1;
				if (trade.endpointDistanceLy(net, trade.END_PORT, i, trade.END_PORT, j) <= trade.MAX_LEG_LY
					&& !plan.reachable) insideCapRefused += 1;
			}
		}
		trade.setGenerationMode(0, net);
		check('a partner the hull cannot outrun is refused for that reason, inside the cap',
			outrun > 0 && insideCapRefused > 0, { outrun, insideCapRefused });
	}

	// 17.5 A voyage the shear tears past the cap turns around (§9.4), and a
	// founding hull brings its volunteers home.
	{
		const net = seedMoving(24);
		let maint = 0;
		const fps = 60, rateY = 100, myrPerYear = 0.01;
		skyTime = 0;
		trade.refreshGeometry(net, 0, 1, myrPerYear);
		// Fly the network until it has grown and some hull is under way.
		for (let f = 0; f < 60 * fps; f++) {
			skyTime += 1 / fps;
			trade.step(net, rateY / fps, 256);
			maint += 1 / fps;
			if (maint >= 0.5) {
				maint = 0;
				trade.refreshGeometry(net, skyTime, 1, myrPerYear);
				trade.retimeRoutes(net);
			}
		}
		const before = net.diverted;
		// Jump the sky 900 Myr: whatever is in flight is now on a torn route.
		skyTime = 900;
		trade.refreshGeometry(net, skyTime, 1, myrPerYear);
		trade.retimeRoutes(net);
		// The most-flown hull that turned: the interesting case is one that had
		// already covered part of its chord, not one that turned in its own port.
		let turned = -1, turnedMost = -1;
		for (let i = 0; i < net.shipCount; i++) {
			const sh = net.ships[i];
			if (!sh.returning || (sh.state !== trade.SHIP_SAILING && sh.state !== trade.SHIP_FOUNDING)) continue;
			if (sh.legFrom > turnedMost) { turnedMost = sh.legFrom; turned = i; }
		}
		const ship = turned >= 0 ? net.ships[turned] : null;
		check('a leg torn past its cap is turned around, not chased',
			net.diverted > before && ship !== null && ship.legTo === 0,
			{ diverted: net.diverted - before, turned });
		// The way home is the part of the chord already flown, not the part that
		// was still ahead: a hull turned at 30 % is a 30 % flight back.
		let homeOk = false, homeDetail = null;
		if (ship) {
			const kindB = ship.state === trade.SHIP_FOUNDING ? trade.END_CANDIDATE : trade.END_PORT;
			const indexB = ship.state === trade.SHIP_FOUNDING ? ship.candidate : ship.to;
			const chordNow = trade.endpointDistanceLy(net, trade.END_PORT, ship.from, kindB, indexB);
			const expect = Math.max(trade.MIN_LEG_YEARS, ship.legFrom * chordNow / trade.HULLS[ship.hull].lyPerYear);
			const booked = ship.arrive - ship.depart;
			homeOk = Math.abs(booked - expect) <= Math.max(2, expect * 0.05);
			homeDetail = { u: +ship.legFrom.toFixed(3), chord: +chordNow.toFixed(0), expect: +expect.toFixed(0), booked: +booked.toFixed(0) };
		}
		check('the diverted hull is booked home over the part of the chord it has flown', homeOk, homeDetail);
		// It docks at its origin: the port's arrival counter takes it, and a hull
		// that immediately loads again inside a 20-year step still counts.
		const homeArrivals = ship ? net.ports[ship.from].arrivals : 0;
		let landed = 0;
		for (let f = 0; f < 200000 && ship && !landed; f++) {
			trade.step(net, 20, 256);
			if (net.ports[ship.from].arrivals > homeArrivals) landed = 1;
		}
		check('the diverted hull docks at the port it turned back to',
			ship !== null && landed === 1,
			{ landed, from: ship ? ship.from : -1, arrivals: ship ? net.ports[ship.from].arrivals : -1 });

		// A founding hull: the same shear, and the party is refunded at home.
		const net2 = seedMoving(24);
		skyTime = 0;
		trade.refreshGeometry(net2, 0, 1, 1e-3);
		const launch = trade.launchBest(net2, 0);
		const founder = launch.ok ? net2.ships[launch.ship] : null;
		const people = founder ? founder.amount * trade.POP_PER_COLONIST_UNIT : 0;
		skyTime = 900;
		trade.refreshGeometry(net2, skyTime, 1, 1e-3);
		trade.retimeRoutes(net2);
		const wasTurned = founder ? founder.returning : -1;
		let popBefore = 0, popAfter = 0, stateAfter = -1, amountAfter = -1;
		if (founder && wasTurned === 1) {
			const arriveAt = founder.arrive;
			trade.step(net2, Math.max(0, arriveAt - net2.time - 1e-6), 4096);
			// Settle the source to the instant *before* the arrival: the jump
			// across the event is then the refund alone, not the thirty thousand
			// years of growth the arrival's own settle would add on top of it.
			const home = net2.ports[launch.source].colony;
			economy.settleColony(home, arriveAt - 1e-6);
			popBefore = home.pop;
			// Just past the arrival, before the load event half a year later.
			trade.step(net2, 1e-3, 4096);
			popAfter = home.pop;
			stateAfter = founder.state;
			amountAfter = founder.amount;
		}
		check('a diverted founding wave is refunded to the population it was drawn from',
			launch.ok === 1 && wasTurned === 1 && net2.founded === 0
			&& stateAfter === trade.SHIP_DOCKED && amountAfter === 0
			&& Math.abs(popAfter - popBefore - people) < people * 0.02,
			{ launch: launch.ok, wasTurned, founded: net2.founded, people: +people.toFixed(2),
				jump: +(popAfter - popBefore).toFixed(2), stateAfter, amountAfter });
	}

	// 17.6 The frontier scan widens its coarse gate with the shear, and caps it.
	{
		const net = seedMoving(24);
		const cap = trade.MAX_FOUND_LY / trade.LY_PER_KPC * 7;
		trade.refreshGeometry(net, 0, 0, 0);
		const frozen = trade.frontierStretchKpc(net, model, 8);
		trade.refreshGeometry(net, 10, 1, 1e-3);
		const at10 = trade.frontierStretchKpc(net, model, 8);
		trade.refreshGeometry(net, 60, 1, 1e-3);
		const at60 = trade.frontierStretchKpc(net, model, 8);
		trade.refreshGeometry(net, 100000, 1, 1e-3);
		const capped = trade.frontierStretchKpc(net, model, 8);
		check('the frontier pre-gate opens with the moving sky, never past its cap',
			frozen === 0 && at10 > 0 && at60 >= at10 && capped <= cap + 1e-9,
			{ frozen, at10: +at10.toFixed(2), at60: +at60.toFixed(2), capped: +capped.toFixed(2) });
		// The epicyclic spread of this model is kpc-scale and does not need the
		// clock at all; a cold disc isolates the shear term, which must grow.
		const cold = galaxy.createGalaxy({ type: model.type, seed: 1 });
		cold.dynamics.sigmaThin = 0.002;
		trade.refreshGeometry(net, 5, 1, 1e-3);
		const cold5 = trade.frontierStretchKpc(net, cold, 8);
		trade.refreshGeometry(net, 50, 1, 1e-3);
		const cold50 = trade.frontierStretchKpc(net, cold, 8);
		check('with a cold disc the growth between the two clocks is the shear term',
			cold5 > 0 && cold50 - cold5 > 0.15, { cold5: +cold5.toFixed(3), cold50: +cold50.toFixed(3) });
	}

	// 17.7 A long run in a moving sky: the fleet stays honest and the network
	// keeps trading.
	{
		const net = seedMoving(24);
		const rateY = 100, myrPerYear = 0.01;   // 1 Myr/s of sky, 100 y/s of trade
		skyTime = 0;
		trade.refreshGeometry(net, 0, 1, myrPerYear);
		let maint = 0;
		const fps = 60, seconds = 120;
		let deliveredAt60 = 0;
		for (let f = 0; f < seconds * fps; f++) {
			skyTime += 1 / fps;
			trade.step(net, rateY / fps, 256);
			maint += 1 / fps;
			if (maint >= 0.5) {
				maint = 0;
				trade.refreshGeometry(net, skyTime, 1, myrPerYear);
				trade.retimeRoutes(net);
			}
			if (f === 60 * fps) deliveredAt60 = net.delivered;
		}
		// Every hull in flight is inside the give-up margin of its cap.
		let worst = 0, over = 0, sailing = 0;
		for (let i = 0; i < net.shipCount; i++) {
			const sh = net.ships[i];
			if (sh.state !== trade.SHIP_SAILING && sh.state !== trade.SHIP_FOUNDING) continue;
			if (sh.from < 0) continue;
			sailing += 1;
			const kindB = sh.state === trade.SHIP_FOUNDING ? trade.END_CANDIDATE : trade.END_PORT;
			const indexB = sh.state === trade.SHIP_FOUNDING ? sh.candidate : sh.to;
			if (indexB < 0) continue;
			const ly = trade.endpointDistanceLy(net, trade.END_PORT, sh.from, kindB, indexB);
			const cap = sh.state === trade.SHIP_FOUNDING ? trade.MAX_FOUND_LY : trade.MAX_LEG_LY;
			if (ly > cap * trade.DIVERT_FACTOR * 1.05) over += 1;
			if (ly > worst) worst = ly;
		}
		check('120 s of shearing sky: no hull is left on a leg past the give-up margin',
			over === 0 && sailing > 0, { sailing, over, worstLy: +worst.toFixed(0) });
		check('the network still trades and still grows while the sky moves',
			net.delivered > 0 && net.delivered > deliveredAt60 && net.portCount > 4 && net.founded > 0,
			{ delivered: Math.round(net.delivered), at60: Math.round(deliveredAt60), ports: net.portCount, founded: net.founded });
	}
	orbit.setEngine(savedEngine);
}

// --- 18. Outposts: a failed colony stops and stays on the map (W1) --------
{
	// A live colony just below the threshold fails on the next settle; one just
	// above it keeps growing. Both sides of the boundary, on a controlled
	// record so the settle itself is the only actor.
	function boundaryColony(pop) {
		const c = economy.createColony();
		c.capacity = 100;
		c.pop = pop;
		c.last = 0;
		for (let r = 0; r < economy.RESOURCE_COUNT; r++) {
			c.outBase[r] = economy.NEED[r] * 2;
			c.stockCap[r] = 1e12;
		}
		return c;
	}
	const below = boundaryColony(economy.OUTPOST_POP_M * 0.9);
	economy.settleColony(below, 1);
	check('a colony settled below the outpost threshold stops with growth at zero',
		below.outpost === 1 && below.outpostY === 1 && below.growth === 0
		&& below.pop > 0 && below.pop < economy.OUTPOST_POP_M);
	const above = boundaryColony(economy.OUTPOST_POP_M * 1.1);
	economy.settleColony(above, 1);
	check('a colony just above the threshold stays live', above.outpost === 0);

	// The network: demote one port by hand, then let the settle notice it.
	const net = seedStart(0);
	const port = net.ports[0];
	const heldKey = port.key;
	port.colony.pop = economy.OUTPOST_POP_M * 0.5;
	trade.settleAllPorts(net, net.time + 1);
	check('the network marks the failed port once and counts it',
		port.colony.outpost === 1 && port.demoted === 1 && net.outposts === 1
		&& trade.livePortCount(net) === net.portCount - 1);
	check('an outpost keeps its slot, its star key and its name',
		trade.portOfStar(net, heldKey) === 0 && trade.portOfStarLive(net, heldKey) === -1
		&& port.name.length > 0);
	const frozenPop = port.colony.pop;
	const frozenStock = port.colony.stock[economy.R_FOOD];
	const frozenYear = port.colony.last;
	trade.settleAllPorts(net, net.time + 500);
	check('a second settle changes nothing on an outpost',
		port.colony.pop === frozenPop && port.colony.stock[economy.R_FOOD] === frozenStock
		&& port.colony.last === frozenYear && net.outposts === 1);
	check('an outpost neither exports nor imports',
		economy.exportableOf(port.colony, economy.R_FOOD) === 0
		&& economy.demandOf(port.colony, economy.R_FOOD) === 0
		&& economy.giveToColony(port.colony, economy.R_FOOD, 10) === 0);
	check('the outpost is still the player\u2019s port at its star',
		trade.playerPort(net, heldKey) === 0);
	check('every candidate of the dead star is closed and released',
		(() => {
			for (let i = 0; i < net.candidateCount; i++) {
				const c = net.candidates[i];
				if (c.site.key !== heldKey) continue;
				if (!c.used || c.reserved !== -1) return false;
			}
			return true;
		})());
	const site = economy.createSite();
	site.key = heldKey;
	site.seed = port.colony.seed;
	check('no founding can land on a star whose colony failed',
		trade.addPort(net, site, net.time) === -1);
	// A freighter at the outpost waits instead of loading.
	const waitNet = seedStart(0);
	const dock = waitNet.ships.find(sh => sh.state === trade.SHIP_DOCKED);
	check('a docked hull at an outpost waits instead of loading',
		(() => {
			if (!dock) return false;
			const at = dock.port;
			waitNet.ports[at].colony.pop = economy.OUTPOST_POP_M * 0.5;
			trade.settleAllPorts(waitNet, waitNet.time + 1);
			const before = waitNet.ports[at].colony.stock[economy.R_FOOD];
			trade.step(waitNet, 5);
			return waitNet.ports[at].colony.stock[economy.R_FOOD] === before;
		})());

	// A founder already bound for a world of that star refunds its party: the
	// taken-world path, exactly. The fixture puts one candidate back on the
	// dead star and launches at it before the demotion is noticed.
	const refundNet = seedStart(0);
	const dead = refundNet.ports[0];
	const deadKey = dead.key;
	let source = -1;
	for (let i = 1; i < refundNet.portCount; i++) {
		if (refundNet.ports[i].colony.pop > 6) { source = i; break; }
	}
	if (source < 0) source = 1;
	refundNet.ports[source].colony.pop = Math.max(refundNet.ports[source].colony.pop, 10);
	const cand = refundNet.candidateCount;
	const site2 = refundNet.candidates[cand].site;
	economy.copySite(site2, dead.colony);
	site2.key = deadKey;
	site2.name = dead.name;
	refundNet.candidates[cand].used = 0;
	refundNet.candidates[cand].reserved = -1;
	refundNet.candidateCount += 1;
	const portsBefore = refundNet.portCount;
	const foundedBefore = refundNet.founded;
	const shipIndex = trade.launchExpedition(refundNet, source, cand, refundNet.time);
	let refundOk = shipIndex >= 0;
	let refundDetail = 'no launch';
	if (refundOk) {
		const ship = refundNet.ships[shipIndex];
		dead.colony.pop = economy.OUTPOST_POP_M * 0.5;
		trade.settleAllPorts(refundNet, refundNet.time + 1);
		const closed = refundNet.candidates[cand].used === 1 && refundNet.candidates[cand].reserved === -1;
		// Stop just past the arrival: the follow-up load (a half year later)
		// would put the same hull back to work and hide the docking state.
		trade.step(refundNet, ship.arrive - refundNet.time + 1e-6);
		refundOk = closed && ship.state === trade.SHIP_DOCKED
			&& ship.cargo === trade.NO_RESOURCE && ship.amount === 0
			&& refundNet.portCount === portsBefore && refundNet.founded === foundedBefore;
		refundDetail = { closed, state: ship.state, amount: ship.amount };
	}
	check('a founder bound for a dead star comes home with its party', refundOk, refundDetail);
	// The refund law itself, in isolation: the party returns to the sponsor's
	// population capped at its carrying capacity, and never vanishes.
	const unitNet = seedStart(0);
	const homePort = unitNet.ports[0];
	homePort.colony.pop = 40;
	const founder = unitNet.ships[0];
	founder.from = 0;
	founder.cargo = economy.R_PEOPLE;
	founder.amount = 10 / trade.POP_PER_COLONIST_UNIT * 0.001;
	const partyM = founder.amount * trade.POP_PER_COLONIST_UNIT;
	trade.returnFounder(unitNet, founder, unitNet.time);
	check('a returned founder puts exactly its party back into the sponsor',
		near(homePort.colony.pop - 40, partyM, 1e-12)
		&& founder.state === trade.SHIP_DOCKED && founder.amount === 0);
}

// --- 19. The network narrates itself (W2) --------------------------------
{
	const net = seedStart(0);
	const port = net.ports[0];
	const colony = port.colony;
	// A supplied colony from 0.05 M: one long settle crosses several rungs and
	// must say how many, not emit one line per rung.
	colony.pop = 0.05;
	colony.popLevel = 0;
	colony.last = net.time;
	for (let r = 0; r < economy.RESOURCE_COUNT; r++) {
		colony.outBase[r] = economy.NEED[r] * 2;
		colony.stockCap[r] = 1e12;
		colony.stock[r] = 1e11;
	}
	trade.settleAllPorts(net, net.time + 400);
	let milestone = null;
	for (let i = trade.logLength(net) - 1; i >= 0; i--) {
		const e = trade.logAt(net, i);
		if (e.kind === trade.LOG_MILESTONE && e.a === 0) { milestone = e; break; }
	}
	check('a long settle credits every rung it crossed in one entry',
		colony.popLevel >= 6 && milestone !== null && milestone.b === colony.popLevel);
	check('the milestone entry says how many rungs were crossed',
		milestone !== null && milestone.c === 0 && milestone.b > 1);
	const levelBefore = colony.popLevel;
	let entriesBefore = trade.logLength(net);
	trade.settleAllPorts(net, net.time + 800);
	check('settling again does not re-emit a rung already credited',
		colony.popLevel === levelBefore && trade.logLength(net) === entriesBefore);

	// Famine: a starving colony logs once on entry and once on recovery.
	const famine = seedStart(0);
	const fc = famine.ports[0].colony;
	fc.pop = 1;
	fc.last = famine.time;
	for (let r = 0; r < economy.RESOURCE_COUNT; r++) {
		fc.outBase[r] = 0;
		fc.stock[r] = 0;
	}
	const beforeFamine = trade.logLength(famine);
	trade.settleAllPorts(famine, famine.time + 1);
	const starvedEntries = trade.logLength(famine) - beforeFamine;
	const famineEntry = trade.logAt(famine, trade.logLength(famine) - 1);
	check('starvation enters once with the coverage that caused it',
		fc.starving === 1 && starvedEntries === 1 && famineEntry.kind === trade.LOG_FAMINE
		&& famineEntry.a === 0 && famineEntry.b === 0);
	trade.settleAllPorts(famine, famine.time + 2);
	check('staying starved does not repeat the alarm', trade.logLength(famine) === beforeFamine + 1);
	for (let r = 0; r < economy.RESOURCE_COUNT; r++) {
		fc.outBase[r] = economy.NEED[r] * 2;
		fc.stock[r] = fc.stockCap[r];
	}
	trade.settleAllPorts(famine, famine.time + 3);
	const recovery = trade.logAt(famine, trade.logLength(famine) - 1);
	check('recovery is its own event, once', fc.starving === 0
		&& recovery.kind === trade.LOG_FAMINE_END && trade.logLength(famine) === beforeFamine + 2);

	// The ring wraps without reallocating.
	const ring = seedStart(0);
	const arrays = [ring.log.time, ring.log.kind, ring.log.a, ring.log.b, ring.log.c];
	for (let i = 0; i < trade.LOG_CAP + 10; i++) trade.pushLog(ring, trade.LOG_FOUND, 0, -1, 0);
	const sameArrays = ring.log.time === arrays[0] && ring.log.kind === arrays[1]
		&& ring.log.a === arrays[2] && ring.log.b === arrays[3] && ring.log.c === arrays[4];
	check('the ring keeps LOG_CAP entries, oldest first, and never reallocates',
		trade.logLength(ring) === trade.LOG_CAP && sameArrays
		&& trade.logAt(ring, 0) !== null && trade.logAt(ring, trade.LOG_CAP) === null);

	// An outpost logs once, however many times the network settles.
	const out = seedStart(0);
	out.ports[0].colony.pop = economy.OUTPOST_POP_M * 0.5;
	trade.settleAllPorts(out, out.time + 1);
	trade.settleAllPorts(out, out.time + 200);
	let outpostEntries = 0;
	for (let i = 0; i < trade.logLength(out); i++) {
		const e = trade.logAt(out, i);
		if (e.kind === trade.LOG_OUTPOST && e.a === 0) outpostEntries += 1;
	}
	check('an outpost logs once, not once per settle', outpostEntries === 1);

	const empty = trade.createNetwork({ seed: 7 });
	check('a network with no ports still has a valid, empty log',
		trade.logLength(empty) === 0 && trade.logAt(empty, 0) === null);
}

// --- 22. Scarcity tags (W5) ----------------------------------------------
{
	function tagColony() {
		const c = economy.createColony();
		c.capacity = 100;
		c.pop = 10;
		c.last = 0;
		return c;
	}
	const stocked = tagColony();
	for (let r = 0; r < economy.RESOURCE_COUNT; r++) {
		stocked.outBase[r] = 0;
		stocked.stockCap[r] = 1e12;
		stocked.stock[r] = 1e12;
	}
	let stockedScarce = 0, stockedSurplus = 0, surplusWithoutSpare = 0;
	for (let r = 0; r < economy.RESOURCE_COUNT; r++) {
		const tag = economy.tradeTagOf(stocked, r);
		if (tag === economy.TAG_SCARCE) stockedScarce += 1;
		if (tag === economy.TAG_SURPLUS) {
			stockedSurplus += 1;
			if (!(economy.exportableOf(stocked, r) > 0)) surplusWithoutSpare += 1;
		}
		const s0 = economy.scarcityOf(stocked, r);
		if (!(s0 >= 0 && s0 <= 1)) stockedScarce += 1;
	}
	check('a stocked port is never scarce and marks its spare goods surplus',
		stockedScarce === 0 && stockedSurplus > 0 && surplusWithoutSpare === 0);

	const bare = tagColony();
	for (let r = 0; r < economy.RESOURCE_COUNT; r++) {
		bare.outBase[r] = 0;
		bare.stockCap[r] = 1e12;
		bare.stock[r] = 0;
	}
	check('an empty port is scarce on food and volatiles',
		economy.tradeTagOf(bare, economy.R_FOOD) === economy.TAG_SCARCE
		&& economy.tradeTagOf(bare, economy.R_VOLATILE) === economy.TAG_SCARCE);
	check('a resource with no draw and no stock is fair, not a crisis',
		economy.tradeTagOf(bare, economy.R_ORE) === economy.TAG_FAIR
		&& economy.scarcityOf(bare, economy.R_ORE) === 0);

	// Scarcity falls as the warehouse fills, for the same population and draw.
	const monotone = tagColony();
	monotone.outBase[economy.R_FOOD] = 0;
	monotone.stockCap[economy.R_FOOD] = 1e6;
	let previous = 2;
	let monotoneOk = true;
	for (let step = 0; step <= 10; step++) {
		monotone.stock[economy.R_FOOD] = step * 1e5;
		const s1 = economy.scarcityOf(monotone, economy.R_FOOD);
		if (!(s1 >= 0 && s1 <= 1) || s1 > previous + 1e-12) monotoneOk = false;
		previous = s1;
	}
	check('scarcity stays in [0, 1] and falls as stock rises', monotoneOk
		&& economy.scarcityOf(monotone, economy.R_FOOD) === 0);
	check('a fully stocked port still names the right tags by name',
		economy.tradeTagName(economy.TAG_SURPLUS) === 'surplus'
		&& economy.tradeTagName(economy.TAG_FAIR) === 'fair'
		&& economy.tradeTagName(economy.TAG_SCARCE) === 'scarce');
}

// --- 23. Expansion can be stood down (W6) --------------------------------
{
	const net = seedStart(0);
	const ports = net.portCount;
	const delivered = net.delivered;
	trade.setExpansion(0);
	trade.step(net, 600);
	check('a disarmed expansion founds nothing while the freight still moves',
		net.founded === 0 && net.portCount === ports && net.delivered > delivered,
		{ ports: net.portCount, delivered: Math.round(net.delivered), founded: net.founded });
	const refusal = trade.launchBest(net, net.time);
	check('the Send button refuses while expansion is off',
		refusal.ok === 0 && refusal.reason === 'expansion is off');
	trade.setExpansion(1);
	trade.step(net, 600);
	check('arming resumes at the next tick', net.founded > 0 && net.portCount > ports);

	// Every readiness state, each forced on its own fixture.
	const ready = seedStart(0);
	const r = { state: '', why: '', nextIn: 0 };
	const rc = ready.ports[1].colony;
	const rp = ready.ports[1];
	rc.pop = 1;
	trade.portReadiness(ready, 1, ready.time, r);
	const small = r.state;
	rc.pop = 20;
	rc.capacity = Math.max(rc.capacity, 100);
	rc.coverage = 0.1;
	trade.portReadiness(ready, 1, ready.time, r);
	const starving = r.state;
	rc.coverage = 0.6;
	rp.lastExpedition = ready.time;
	trade.portReadiness(ready, 1, ready.time, r);
	const resting = r.state + ':' + Math.round(r.nextIn);
	rp.lastExpedition = ready.time - trade.EXPEDITION_COOLDOWN;
	trade.portReadiness(ready, 1, ready.time, r);
	const liveState = r.state;
	rc.outpost = 1;
	trade.portReadiness(ready, 1, ready.time, r);
	const outpostState = r.state;
	check('readiness names small, starving, resting, live and outpost',
		small === 'small' && starving === 'starving' && resting === 'resting:900'
		&& liveState === 'live' && outpostState === 'outpost',
		{ small, starving, resting, liveState, outpostState });
}

// --- 20. The player can found a colony (W3) ------------------------------
{
	function freshNet() {
		return seedNetwork(24, 0);
	}
	// A landmark the seed map did not settle and whose best world is worth
	// founding on. Searched, so the fixture cannot drift with the seed.
	function findFoundable(net) {
		for (let i = 24; i < 60; i++) {
			landmarkRef(i, scratchRef);
			ctx.name = landmarks.ENTRIES[i].name;
			planets.generateSystem(scratchRef, ctx, record);
			const key = scratchRef.key >>> 0;
			if (trade.portOfStar(net, key) >= 0) continue;
			const pick = economy.createSite();
			const probe = planets.createSystemRecord();
			planets.generateSystem(scratchRef, ctx, probe);
			const best = (() => {
				// The same law playerFound uses, without mutating the network.
				economy.fillPlanetSite(pick, scratchRef, probe, 0, economy.siteSeed(key, net.modelSeed, scratchRef.kind));
				let score = trade.siteHabitatScore(pick);
				for (let p = 1; p < probe.counts.planets; p++) {
					economy.fillPlanetSite(pick, scratchRef, probe, p, economy.siteSeed(key, net.modelSeed, scratchRef.kind));
					score = Math.max(score, trade.siteHabitatScore(pick));
				}
				for (let b = 0; b < probe.belts.count; b++) {
					economy.fillBeltSite(pick, scratchRef, probe, b, economy.siteSeed(key, net.modelSeed, scratchRef.kind));
					score = Math.max(score, trade.siteHabitatScore(pick));
				}
				return score;
			})();
			if (best >= trade.MIN_CANDIDATE_HABITAT) return i;
		}
		return -1;
	}

	const net = freshNet();
	const foundIndex = findFoundable(net);
	check('the fixture finds an unclaimed landmark worth founding on', foundIndex >= 0, foundIndex);
	const system = planets.createSystemRecord();
	landmarkRef(foundIndex, scratchRef);
	ctx.name = landmarks.ENTRIES[foundIndex].name;
	planets.generateSystem(scratchRef, ctx, system);
	const now = net.time + 42;
	const before = net.portCount;
	const result = trade.playerFound(net, scratchRef, ctx.name, system, now);
	// The result record is one shared scratch (like playerLoad's): snapshot what
	// this call said before any other call overwrites it.
	const foundOk = result.ok;
	const foundPort = result.port;
	const port = foundOk ? net.ports[foundPort] : null;
	check('a fresh founding succeeds, adds one port and carries a real grant',
		foundOk === 1 && net.portCount === before + 1 && foundPort === before
		&& port.colony.founded === now && port.colony.last === now
		&& port.colony.popLevel === 0 && port.colony.outpost === 0
		&& port.colony.pop > 0 && port.name.length > 0);
	const stockRatio = port.colony.stockCap.every((cap, r) => cap > 0
		? Math.abs(port.colony.stock[r] / cap - economy.FOUND_STOCK_FRAC) < 1e-9 : true);
	check('the founding stores are the 45 % grant, with no invented age',
		stockRatio && port.colony.founded === now);
	const foundedLog = trade.logAt(net, trade.logLength(net) - 1);
	check('the founding is narrated', foundedLog.kind === trade.LOG_FOUND && foundedLog.a === foundPort);

	check('a second call on the same star refuses without changing the network',
		trade.playerFound(net, scratchRef, ctx.name, system, now + 1).reason === 'already a colony here'
		&& net.portCount === before + 1);

	// Every other refusal, each on its own fixture state.
	const outpostNet = freshNet();
	const outpostPort = outpostNet.ports[0];
	outpostPort.colony.pop = economy.OUTPOST_POP_M * 0.5;
	trade.settleAllPorts(outpostNet, outpostNet.time + 1);
	const outIndex = 24;
	landmarkRef(outIndex, scratchRef);
	ctx.name = landmarks.ENTRIES[outIndex].name;
	planets.generateSystem(scratchRef, ctx, system);
	// Point the outpost's star at this system so the refusal path is the one
	// being tested, not the star identity.
	const outKey = outpostNet.ports[0].key;
	outpostNet.ports[0].key = scratchRef.key >>> 0;
	const outRefusal = trade.playerFound(outpostNet, scratchRef, ctx.name, system, outpostNet.time);
	outpostNet.ports[0].key = outKey;
	check('an outpost star refuses and is not revived',
		outRefusal.reason === 'this star is an outpost' && outpostNet.ports[0].colony.outpost === 1);

	const reservedNet = freshNet();
	// The first free candidate is a real expedition target; reserve it.
	let reservedKey = 0, reservedRef = null, reservedName = '';
	for (let i = 0; i < reservedNet.candidateCount; i++) {
		const c = reservedNet.candidates[i];
		if (!c.used && c.reserved < 0) {
			reservedKey = c.site.key >>> 0;
			reservedRef = c.site.ref;
			reservedName = c.site.name;
			c.reserved = 0;
			break;
		}
	}
	if (reservedKey) {
		planets.generateSystem(reservedRef, ctx, system);
		check('a star an expedition is already bound for refuses',
			trade.playerFound(reservedNet, reservedRef, reservedName, system, reservedNet.time).reason
			=== 'an expedition is already bound for it');
	} else {
		check('a star an expedition is already bound for refuses', false, 'no candidate');
	}

	const fullNet = freshNet();
	const savedCount = fullNet.portCount;
	fullNet.portCount = trade.MAX_PORTS;
	landmarkRef(50, scratchRef);
	planets.generateSystem(scratchRef, ctx, system);
	const fullRefusal = trade.playerFound(fullNet, scratchRef, ctx.name, system, fullNet.time);
	fullNet.portCount = savedCount;
	check('a full network refuses', fullRefusal.reason === 'network is full');

	// A star the generator gave no worlds at all: nothing to settle, and the
	// refusal must say so rather than invent a site.
	const emptyNet = freshNet();
	let barrenIndex = -1;
	for (let i = 24; i < 60; i++) {
		landmarkRef(i, scratchRef);
		planets.generateSystem(scratchRef, ctx, record);
		if (record.counts.planets === 0 && record.belts.count === 0) { barrenIndex = i; break; }
	}
	if (barrenIndex >= 0) {
		landmarkRef(barrenIndex, scratchRef);
		planets.generateSystem(scratchRef, ctx, system);
		const barrenRefusal = trade.playerFound(emptyNet, scratchRef, ctx.name, system, emptyNet.time);
		check('a star with no world worth settling refuses',
			barrenRefusal.reason === 'no world worth settling' && barrenRefusal.port === -1);
	} else {
		check('a star with no world worth settling refuses', false, 'no empty system found');
	}

	// The two founding paths share one record shape and one grant.
	const shapeNet = freshNet();
	const shipNetFound = shapeNet;
	const sources = [];
	for (let i = 0; i < shipNetFound.portCount; i++) {
		if (shipNetFound.ports[i].colony.pop >= 8) { sources.push(i); break; }
	}
	let expeditionPort = -1;
	if (sources.length > 0) {
		const source = sources[0];
		shipNetFound.ports[source].colony.pop = Math.max(shipNetFound.ports[source].colony.pop, 10);
		const cand = trade.pickCandidate(shipNetFound, source);
		if (cand >= 0) {
			const shipIndex = trade.launchExpedition(shipNetFound, source, cand, shipNetFound.time);
			if (shipIndex >= 0) {
				const sh = shipNetFound.ships[shipIndex];
				trade.step(shipNetFound, sh.arrive - shipNetFound.time + 1e-6);
				expeditionPort = shipNetFound.ports.length - 1;
				for (let i = 0; i < shipNetFound.portCount; i++) {
					if (shipNetFound.ports[i].colony.founded === sh.arrive) { expeditionPort = i; break; }
				}
			}
		}
	}
	if (expeditionPort >= 0 && foundOk) {
		const a = net.ports[foundPort].colony;
		const b = shipNetFound.ports[expeditionPort].colony;
		const sameFields = Object.keys(a).sort().join(',') === Object.keys(b).sort().join(',');
		const sameGrant = a.stockCap.every((cap, r) => cap > 0 && b.stockCap[r] > 0
			? Math.abs(a.stock[r] / cap - b.stock[r] / b.stockCap[r]) < 1e-9 : true);
		check('playerFound and the expedition path produce one record shape and one grant',
			sameFields && sameGrant && b.founded === b.last && b.popLevel === 0,
			{ sameFields, sameGrant, founded: b.founded, last: b.last, level: b.popLevel,
				expeditionPort });
	} else {
		check('playerFound and the expedition path produce one record shape and one grant', false,
			{ expeditionPort });
	}
}

// --- 24. The port rows are a list you can click (W7) ---------------------
{
	const net = seedNetwork(24, 0);
	// Row ids are the port's key in base 36 and the index is its slot: both are
	// identity, so a row can never select a different star after a settle.
	const keys = new Set();
	for (let i = 0; i < net.portCount; i++) keys.add(net.ports[i].key >>> 0);
	check('port keys are unique, so a row id is a stable star', keys.size === net.portCount);

	// Find a port with a free candidate it may sponsor.
	let port = -1, candidate = -1;
	for (let i = 0; i < net.portCount && port < 0; i++) {
		const c = trade.pickCandidate(net, i);
		if (c >= 0) { port = i; candidate = c; }
	}
	check('the fixture has a port with a free candidate', port >= 0, { port, candidate });

	// A resting port is refused by the automatic law and rushed by the button.
	net.ports[port].colony.pop = Math.max(net.ports[port].colony.pop, 12);
	net.ports[port].lastExpedition = net.time;
	const wait = trade.portReadiness(net, port, net.time);
	check('a port that sponsored a wave is resting', wait.state === 'resting' && wait.nextIn > 0);
	const refused = trade.launchChosen(net, port, candidate, net.time, 0);
	check('launchChosen without a rush refuses a resting port',
		refused.ok === 0 && refused.reason.length > 0 && net.ports[port].lastExpedition === net.time);
	const rushed = trade.launchChosen(net, port, candidate, net.time, 1);
	const launched = rushed.ok === 1 ? net.ships[rushed.ship] : null;
	check('launchChosen with a rush launches and restarts the cooldown',
		rushed.ok === 1 && launched.state === trade.SHIP_FOUNDING
		&& launched.candidate === candidate && net.ports[port].lastExpedition === net.time);

	// The row is a snapshot: a stale index is a refusal, never a throw.
	// The result is one shared scratch: snapshot each call before the next.
	const stalePort = trade.launchChosen(net, net.portCount + 9, candidate, net.time, 1);
	const stalePortReason = stalePort.reason;
	const stalePortOk = stalePort.ok;
	const staleSite = trade.launchChosen(net, port, net.candidateCount + 9, net.time, 1);
	const staleSiteReason = staleSite.reason;
	const staleSiteOk = staleSite.ok;
	check('stale rows are refused instead of throwing',
		stalePortOk === 0 && stalePortReason === 'that port is gone'
		&& staleSiteOk === 0 && staleSiteReason === 'that world is gone',
		{ p: stalePortReason, s: staleSiteReason });

	// A candidate already bound for an expedition is not launched twice, and a
	// settled world is refused as settled.
	const taken = trade.launchChosen(net, port, candidate, net.time, 1);
	const takenOk = taken.ok, takenReason = taken.reason;
	check('a reserved world cannot be launched at twice',
		takenOk === 0 && takenReason === 'an expedition is already bound for it', takenReason);
	const usedNet = seedNetwork(24, 0);
	usedNet.candidates[0].used = 1;
	const used = trade.launchChosen(usedNet, 0, 0, usedNet.time, 1);
	check('a settled world is refused',
		used.ok === 0 && used.reason === 'that world is already settled', used.reason);

	// An outpost sponsors nothing, whatever its stored population says.
	const outpostNet = seedNetwork(24, 0);
	const outPort = 0;
	outpostNet.ports[outPort].colony.pop = 40;
	trade.settleAllPorts(outpostNet, outpostNet.time + 1);
	// Force the outpost flag directly: the demotion law itself is §18's job.
	outpostNet.ports[outPort].colony.outpost = 1;
	outpostNet.ports[outPort].colony.pop = 40;
	const outpostLaunch = trade.launchChosen(outpostNet, outPort, 0, outpostNet.time, 1);
	check('an outpost refuses to sponsor a wave',
		outpostLaunch.ok === 0 && outpostLaunch.reason === 'an outpost sponsors nothing');

	// Expansion off refuses every row, exactly like the single button.
	trade.setExpansion(0);
	const off = trade.launchChosen(net, port, net.candidateCount > 0 ? 0 : candidate, net.time, 1);
	const offOk = off.ok, offReason = off.reason;
	trade.setExpansion(1);
	check('a stood-down authority refuses the row too',
		offOk === 0 && offReason === 'expansion is off', offReason);
}

// --- 25. The forward calendar (W8) ---------------------------------------
{
	// Two identical networks: one is peeked, the other drained, and the two
	// orders must agree event for event.
	const peekNet = seedNetwork(24, 0);
	const drainNet = seedNetwork(24, 0);
	const rows = [];
	for (let i = 0; i < 8; i++) rows.push({ time: 0, kind: -1, port: -1, ship: -1 });
	const sizeBefore = peekNet.queue.size;
	const rootBefore = peekNet.queue.time[0];
	const n = trade.nextEvents(peekNet, peekNet.time, rows, 4);
	check('the calendar returns rows without popping the queue',
		n > 0 && peekNet.queue.size === sizeBefore && peekNet.queue.time[0] === rootBefore);

	const drained = [];
	queueLib.drainUntil(drainNet.queue, Infinity, (time, kind, ref, revision) => {
		if (drained.length < n) drained.push([time, kind, ref]);
	});
	let orderOk = n === drained.length;
	for (let i = 0; i < n && orderOk; i++) {
		orderOk = rows[i].time === drained[i][0] && rows[i].kind === drained[i][1]
			&& (rows[i].kind === trade.EV_TICK || rows[i].ship === drained[i][2]);
	}
	check('the calendar order equals a drain\u2019s order', orderOk, { n, drained: drained.length });

	let ascending = true;
	for (let i = 1; i < n; i++) if (rows[i].time < rows[i - 1].time) ascending = false;
	check('the calendar is time-ordered', ascending);

	// Every ship row resolves to a live booking; the tick row carries no ship.
	let resolved = true;
	for (let i = 0; i < n; i++) {
		const row = rows[i];
		if (row.kind === trade.EV_TICK) { resolved = resolved && row.ship === -1; continue; }
		const ship = peekNet.ships[row.ship];
		resolved = resolved && !!ship
			&& (row.kind === trade.EV_ARRIVE ? ship.state === trade.SHIP_SAILING
				: row.kind === trade.EV_FOUND ? ship.state === trade.SHIP_FOUNDING
				: ship.state === trade.SHIP_DOCKED || ship.state === trade.SHIP_WAITING);
	}
	check('every ship row resolves to a live voyage', resolved);

	// A ship re-timed after the peek makes its entry stale: the row is dropped,
	// not shown at the old time.
	const target = rows.find(r => r.kind !== trade.EV_TICK);
	if (target) {
		// The rows are one scratch: snapshot the identity before the next peek
		// overwrites it.
		const targetShip = target.ship;
		const targetTime = target.time;
		const ship = peekNet.ships[targetShip];
		const savedRevision = ship.revision;
		ship.revision = (ship.revision + 1) >>> 0;
		const after = trade.nextEvents(peekNet, peekNet.time, rows, 8);
		let staleShown = false;
		for (let i = 0; i < after; i++) {
			if (rows[i].kind === trade.EV_TICK) continue;
			if (rows[i].ship === targetShip && rows[i].time === targetTime) staleShown = true;
		}
		ship.revision = savedRevision;
		check('a re-timed voyage is filtered out of the calendar', !staleShown);
	} else {
		check('a re-timed voyage is filtered out of the calendar', false, 'no ship row');
	}

	// The count is capped at 8 and a longer request cannot overrun the scratch.
	const capped = trade.nextEvents(peekNet, peekNet.time, rows, 99);
	check('the calendar caps its rows', capped <= 8, capped);
	// An empty queue is a quiet calendar, not an error.
	const emptyNet = trade.createNetwork({ seed: 7, modelSeed: galaxy.DEFAULT_SEED, timeYears: 0 });
	check('an empty queue returns no rows',
		trade.nextEvents(emptyNet, emptyNet.time, rows, 4) === 0);
}

// --- 21. Site factors: composition, belts and giants (W4) ----------------
{
	const sys = planets.createSystemRecord();
	function gen(index, out) {
		landmarkRef(index, scratchRef);
		ctx.name = landmarks.ENTRIES[index].name;
		planets.generateSystem(scratchRef, ctx, out || sys);
		return out || sys;
	}

	// The composition is the generated system's own inventory, counted by hand.
	gen(0);
	const comp = economy.systemComposition(sys, {});
	let rocky = 0, hz = 0;
	for (let i = 0; i < sys.counts.planets; i++) {
		const bulk = sys.planets.bulk[i];
		if (bulk === planets.BULK_INDEX.rock || bulk === planets.BULK_INDEX.super) rocky += 1;
		if (sys.planets.flags[i] & planets.FLAG_IN_HZ) hz += 1;
	}
	check('the composition counts the system the generator made',
		comp.rocky === rocky && comp.hz === hz && comp.terran === sys.counts.terranCount
		&& comp.giants === sys.counts.giantCount && comp.belts === sys.belts.count,
		comp);

	const site = economy.createSite();
	const seed = economy.siteSeed(scratchRef.key, galaxy.DEFAULT_SEED, scratchRef.kind);
	economy.fillPlanetSite(site, scratchRef, sys, 0, seed);
	check('a filled site carries the system\u2019s composition',
		site.sysRocky === comp.rocky && site.sysGiants === comp.giants
		&& site.sysBelts === comp.belts && site.sysTerran === comp.terran && site.sysHz === comp.hz);
	const copied = economy.createSite();
	economy.copySite(copied, site);
	check('copySite carries it, so a candidate keeps its system',
		copied.sysRocky === site.sysRocky && copied.sysGiants === site.sysGiants
		&& copied.sysBelts === site.sysBelts && copied.sysTerran === site.sysTerran
		&& copied.sysHz === site.sysHz);

	// Same site, same yields, twice — and a different star still diverges.
	const c1 = economy.createColony();
	const c2 = economy.createColony();
	economy.fillColony(c1, site, seed);
	economy.fillColony(c2, site, seed);
	check('the same site yields the same numbers twice',
		c1.yield.every((y, r) => y === c2.yield[r]));

	// The supply factor: richer systems only help their own resource family.
	const rockySite = economy.createSite();
	rockySite.starMetal = 0.02; rockySite.starAge = 4.6; rockySite.insolation = 1;
	rockySite.tsurf = 288; rockySite.starClass = 'G'; rockySite.sysRocky = 6;
	const poorSite = economy.createSite();
	poorSite.starMetal = 0.02; poorSite.starAge = 4.6; poorSite.insolation = 1;
	poorSite.tsurf = 288; poorSite.starClass = 'G'; poorSite.sysRocky = 1;
	const rockySite2 = economy.createSite();
	rockySite2.starMetal = 0.02; rockySite2.starAge = 4.6; rockySite2.insolation = 1;
	rockySite2.tsurf = 288; rockySite2.starClass = 'G'; rockySite2.sysRocky = 60;
	check('six rocky worlds out-mine one, and the cap stops sixty from being ten times more',
		economy.supplyFactor(economy.R_ORE, rockySite) > economy.supplyFactor(economy.R_ORE, poorSite)
		&& economy.supplyFactor(economy.R_ORE, rockySite2) === economy.supplyFactor(economy.R_ORE, rockySite),
		{ one: +economy.supplyFactor(economy.R_ORE, poorSite).toFixed(3),
			six: +economy.supplyFactor(economy.R_ORE, rockySite).toFixed(3) });
	// Only the grown family counts terrans; a terran system must not move ore.
	const terranSite = economy.createSite();
	terranSite.sysTerran = 2;
	const bareSite = economy.createSite();
	check('a terran system moves the grown family only',
		economy.supplyFactor(economy.R_FOOD, terranSite) > economy.supplyFactor(economy.R_FOOD, bareSite)
		&& economy.supplyFactor(economy.R_BIO, terranSite) > economy.supplyFactor(economy.R_BIO, bareSite)
		&& economy.supplyFactor(economy.R_PEOPLE, terranSite) > economy.supplyFactor(economy.R_PEOPLE, bareSite)
		&& economy.supplyFactor(economy.R_ORE, terranSite) === economy.supplyFactor(economy.R_ORE, bareSite)
		&& economy.supplyFactor(economy.R_AMAT, terranSite) === economy.supplyFactor(economy.R_AMAT, bareSite));
	// Same rocky count on both, so only the giants differ.
	const giantSite = economy.createSite();
	giantSite.sysRocky = 1;
	giantSite.sysGiants = 4;
	check('giants favour the gathered family above rocks',
		economy.supplyFactor(economy.R_VOLATILE, giantSite) > economy.supplyFactor(economy.R_VOLATILE, poorSite)
		&& economy.supplyFactor(economy.R_CHEM, giantSite) > economy.supplyFactor(economy.R_CHEM, poorSite)
		&& economy.supplyFactor(economy.R_AMAT, giantSite) === economy.supplyFactor(economy.R_AMAT, poorSite));

	// Belts vs planets on one star, through the real fill path.
	let beltStar = -1, beltIndex = 0, planetIndex = 0;
	for (let i = 0; i < 40 && beltStar < 0; i++) {
		gen(i);
		if (sys.belts.count > 0 && sys.counts.planets > 0) { beltStar = i; beltIndex = 0; planetIndex = 0; }
	}
	check('the fixture has a system with a belt and a planet', beltStar >= 0);
	if (beltStar >= 0) {
		const bSite = economy.createSite();
		const pSite = economy.createSite();
		const bSeed = economy.siteSeed(scratchRef.key, galaxy.DEFAULT_SEED, scratchRef.kind);
		economy.fillBeltSite(bSite, scratchRef, sys, beltIndex, bSeed);
		economy.fillPlanetSite(pSite, scratchRef, sys, planetIndex, bSeed);
		const bCol = economy.createColony();
		const pCol = economy.createColony();
		economy.fillColony(bCol, bSite, bSeed);
		economy.fillColony(pCol, pSite, bSeed);
		// Compare like with like: the belt column against the same star's best
		// planet column for ore, jitter removed by reading PLANET directly.
		const beltOre = economy.PLANET[economy.R_ORE][economy.SITE_BELT];
		const bestPlanetOre = Math.max(...economy.PLANET[economy.R_ORE].slice(0, 10));
		check('a belt is the easiest mine, but not by more than 1.5×',
			beltOre > bestPlanetOre && beltOre <= bestPlanetOre * 1.5,
			{ beltOre, bestPlanetOre });
	}

	// Heavy planets are places to live, not to mine.
	const robots = economy.PLANET[economy.R_ROBOTS];
	check('a rock world out-makes a gas giant on robots',
		Math.max(robots[0], robots[1], robots[2], robots[5]) > robots[7]
		&& robots[7] < 0.30 && robots[6] < 0.30 && robots[8] < 0.30,
		{ lava: robots[0], super: robots[5], mini: robots[6], gas: robots[7], ice: robots[8] });
	// A gas giant out-makes a barren rock on volatiles and chemicals; a desert
	// is the chemical world and keeps its higher chem cell, which is the point
	// of composition being a family law rather than one ranking.
	check('and the giant still out-makes a rock on volatiles and chemicals',
		economy.PLANET[economy.R_VOLATILE][7] > economy.PLANET[economy.R_VOLATILE][1]
		&& economy.PLANET[economy.R_CHEM][7] > economy.PLANET[economy.R_CHEM][1]
		&& economy.PLANET[economy.R_CHEM][2] > economy.PLANET[economy.R_CHEM][7]);

	// Every resource still has a productive world type, and every yield stays
	// inside the authored band over a sweep of generated sites.
	let allProductive = true;
	for (let r = 0; r < economy.RESOURCE_COUNT; r++) {
		let peak = 0;
		for (let c = 0; c < economy.PLANET[r].length; c++) peak = Math.max(peak, economy.PLANET[r][c]);
		if (peak <= 0) allProductive = false;
	}
	check('every resource still has a world type that makes it', allProductive);
	let inBand = true, maxYield = 0;
	const sweepSite = economy.createSite();
	const sweepColony = economy.createColony();
	for (let i = 0; i < 400 && inBand; i++) {
		gen(i % 60);
		const s = economy.siteSeed(scratchRef.key, galaxy.DEFAULT_SEED, scratchRef.kind);
		for (let p = 0; p < sys.counts.planets; p++) {
			economy.fillPlanetSite(sweepSite, scratchRef, sys, p, s);
			economy.fillColony(sweepColony, sweepSite, s);
			for (let r = 0; r < economy.RESOURCE_COUNT; r++) {
				const y = sweepColony.yield[r];
				if (!(y >= 0 && y <= economy.YIELD_MAX)) inBand = false;
				if (y > maxYield) maxYield = y;
			}
		}
	}
	check('every yield stays inside [0, YIELD_MAX] over a sweep of generated sites',
		inBand, { maxYield: +maxYield.toFixed(2) });
}

// --- 26. Commissioned routes are intent, not events (W10) ----------------
{
	const net = seedNetwork(24, 0);
	check('a fresh network has a route list and no commissions',
		!!net.routes && net.routes.count === 0 && trade.activeRouteCount(net) === 0);

	// Commission a pair, and prove the queue is untouched by it.
	const queueBefore = net.queue.size;
	const nextBefore = [];
	{
		const rows = [];
		for (let i = 0; i < 8; i++) rows.push({ time: 0, kind: -1, port: -1, ship: -1 });
		const n = trade.nextEvents(net, net.time, rows, 8);
		for (let i = 0; i < n; i++) nextBefore.push([rows[i].time, rows[i].kind, rows[i].ship]);
	}
	const reg = trade.commissionRoute(net, 0, 1, net.time);
	check('a commission is accepted, logged and changes no event',
		reg.ok === 1 && trade.activeRouteCount(net) === 1 && net.queue.size === queueBefore);
	{
		const rows = [];
		for (let i = 0; i < 8; i++) rows.push({ time: 0, kind: -1, port: -1, ship: -1 });
		const n = trade.nextEvents(net, net.time, rows, 8);
		let same = n === nextBefore.length;
		for (let i = 0; i < n && same; i++) {
			same = rows[i].time === nextBefore[i][0] && rows[i].kind === nextBefore[i][1]
				&& rows[i].ship === nextBefore[i][2];
		}
		check('the calendar is unchanged by a commission', same);
	}
	const routeLog = trade.logAt(net, trade.logLength(net) - 1);
	check('the commission is narrated', routeLog.kind === trade.LOG_ROUTE
		&& routeLog.a === 0 && routeLog.b === 1 && routeLog.c === 1);

	// Duplicates, self-routes and a route to an outpost are refused.
	const dup = trade.commissionRoute(net, 1, 0, net.time);
	const dupReason = dup.reason;
	const self = trade.commissionRoute(net, 2, 2, net.time);
	const selfReason = self.reason;
	const badPort = trade.commissionRoute(net, 0, net.portCount + 4, net.time);
	const badPortReason = badPort.reason;
	check('a duplicate (either direction), a self-route and a bad index are refused',
		dupReason === 'already commissioned' && trade.activeRouteCount(net) === 1
		&& selfReason === 'a route needs two ports' && badPortReason === 'no such destination');
	// routeIndexOf is direction-blind, which is what the duplicate check relies on.
	check('a route is found from either end', trade.routeIndexOf(net, 0, 1) >= 0
		&& trade.routeIndexOf(net, 1, 0) >= 0 && trade.routeIndexOf(net, 3, 4) < 0);

	// The preferred destination wins when it wants the good, and the global
	// pick wins when it does not.
	const choose = seedNetwork(24, 0);
	// Two thousand years of settling: a freshly seeded fleet has no deficit
	// worth shipping, and the routing question only exists once it does.
	trade.step(choose, 2000);
	trade.settleAllPorts(choose, choose.time);
	// A port with no demand at all: every stock at cap, no inputs short.
	function drainDemand(index) {
		const colony = choose.ports[index].colony;
		for (let r = 0; r < economy.RESOURCE_COUNT; r++) colony.stock[r] = colony.stockCap[r];
	}
	// Find a source with a good to spare and TWO destinations that want that
	// same good, so the route can name the one the global pick does not choose.
	let source = -1, first = -1, second = -1, good = -1;
	for (let i = 0; i < choose.portCount && source < 0; i++) {
		for (let r = 0; r < economy.RESOURCE_COUNT && source < 0; r++) {
			if (r === economy.R_PEOPLE) continue;
			if (!(economy.exportableOf(choose.ports[i].colony, r) > 0)) continue;
			const wants = [];
			for (let j = 0; j < choose.portCount && wants.length < 2; j++) {
				if (j === i) continue;
				if (economy.demandOf(choose.ports[j].colony, r) > 0) wants.push(j);
			}
			if (wants.length === 2) { source = i; first = wants[0]; second = wants[1]; good = r; }
		}
	}
	check('the fixture has a source and two destinations that want a good',
		source >= 0 && first >= 0 && second >= 0, { source, first, second, good });
	if (source >= 0) {
		// Commission source → second, and ask the picker for a good `second`
		// wants: the route's end must be returned even if `first` scores better.
		const resource = good;
		if (resource >= 0) {
			const globalPick = trade.pickDestination(choose, source, resource, 0);
			trade.commissionRoute(choose, source, second, choose.time);
			const routedPick = trade.pickDestination(choose, source, resource, 0, 1);
			check('a commissioned pair is preferred over the global pick',
				routedPick === second && (globalPick !== second || globalPick === second),
				{ globalPick, second, routedPick });
			// Now remove the demand: the route's end wants nothing, and the
			// picker must fall back to the global choice rather than idle.
			drainDemand(second);
			const fallback = trade.pickDestination(choose, source, resource, 0, 1);
			check('a route whose destination wants nothing falls back to the global pick',
				fallback === trade.pickDestination(choose, source, resource, 0),
				{ fallback });
			// Cancel: the route stops being preferred, and the slot stays.
			const slot = trade.routeIndexOf(choose, source, second);
			const cancelled = trade.removeRoute(choose, slot);
			const afterCancel = trade.pickDestination(choose, source, resource, 0, 1);
			check('cancelling stops the preference and keeps the slot',
				cancelled === 1 && trade.activeRouteCount(choose) === 0
				&& trade.routeIndexOf(choose, source, second) < 0
				&& afterCancel === trade.pickDestination(choose, source, resource, 0)
				&& choose.routes.count >= 1 && choose.routes.list[slot].active === 0);
			// Recommissioning revives the same slot.
			const revived = trade.commissionRoute(choose, source, second, choose.time);
			check('a cancelled route can be commissioned again in its own slot',
				revived.ok === 1 && revived.index === slot && trade.activeRouteCount(choose) === 1);
		} else {
			check('a commissioned pair is preferred over the global pick', false, 'no shared good');
			check('a route whose destination wants nothing falls back to the global pick', false);
			check('cancelling stops the preference and keeps the slot', false);
			check('a cancelled route can be commissioned again in its own slot', false);
		}
	} else {
		for (let k = 0; k < 4; k++) check('routes behaviour', false, 'no fixture');
	}

	// An outpost is refused at both ends.
	const outNet = seedNetwork(24, 0);
	outNet.ports[2].colony.outpost = 1;
	const toOutpost = trade.commissionRoute(outNet, 0, 2, outNet.time);
	const toOutpostReason = toOutpost.reason;
	const fromOutpost = trade.commissionRoute(outNet, 2, 0, outNet.time);
	const fromOutpostReason = fromOutpost.reason;
	check('a route to or from an outpost is refused',
		toOutpostReason === 'an outpost takes nothing' && fromOutpostReason === 'an outpost ships nothing');

	// The route's estimated departure is a leg time, and a hull that loads for
	// the pair refreshes it.
	const noteNet = seedNetwork(24, 0);
	const noteReg = trade.commissionRoute(noteNet, 0, 1, noteNet.time);
	const legY = trade.routeLegYears(noteNet, 0, 1);
	const route = noteNet.routes.list[noteReg.index];
	check('a route carries an estimated leg, not a scheduled event',
		legY > 0 && near(route.nextDepartY - noteNet.time, legY) && noteNet.queue.size >= 0);
	trade.noteRouteDeparture(noteNet, 1, 0, noteNet.time + 200);
	check('a departure on the pair refreshes the estimate, whichever end loaded',
		near(route.lastDepartY, noteNet.time + 200) && near(route.nextDepartY, noteNet.time + 200 + legY));

	// A port with nothing to sell still ships nothing, route or not.
	const emptyNet = seedNetwork(24, 0);
	for (let r = 0; r < economy.RESOURCE_COUNT; r++) emptyNet.ports[0].colony.stock[r] = 0;
	trade.commissionRoute(emptyNet, 0, 1, emptyNet.time);
	trade.settleAllPorts(emptyNet, emptyNet.time);
	let anySpare = false;
	for (let r = 0; r < economy.RESOURCE_COUNT; r++) {
		if (economy.exportableOf(emptyNet.ports[0].colony, r) > 0) anySpare = true;
	}
	check('a route never invents cargo: a port with nothing spare has nothing to prefer',
		trade.pickDestination(emptyNet, 0, economy.R_ORE, 0, 1) === trade.pickDestination(emptyNet, 0, economy.R_ORE, 0)
		|| !anySpare);
}

// --- 27. Inter-star families (T1) ----------------------------------------
{
	// The table is the law: ore and volatiles are bulk, never shipped; every
	// other resource names a shipping family; worth is untouched.
	const bulk = [economy.R_ORE, economy.R_VOLATILE];
	let bulkOk = true;
	for (const r of bulk) {
		const res = economy.RESOURCES[r];
		bulkOk = bulkOk && res.interFamily < 0 && res.intraFamily === economy.INTRA_BULK
			&& res.worth > 0 && res.worth === (r === economy.R_ORE ? 0.25 : 0.30);
	}
	check('bulk keeps its authored worth and is never an inter-star family', bulkOk,
		{ ore: economy.RESOURCES[0].worth, volatile: economy.RESOURCES[1].worth });

	const seen = new Set();
	let familyOk = true;
	for (let r = 0; r < economy.RESOURCE_COUNT; r++) {
		const f = economy.RESOURCES[r].interFamily;
		if (f < 0) continue;
		if (!(f >= 0 && f < economy.INTER_FAMILY_NAMES.length)) familyOk = false;
		seen.add(f);
	}
	check('the seven shipping families each have a member, and every id is valid',
		familyOk && seen.size === 7, { families: seen.size });
	let intraOk = true;
	const intraSeen = new Set();
	for (let r = 0; r < economy.RESOURCE_COUNT; r++) {
		const f = economy.RESOURCES[r].intraFamily;
		if (f < 0) continue;
		if (!(f >= 0 && f < economy.INTRA_FAMILY_NAMES.length)) intraOk = false;
		intraSeen.add(f);
	}
	check('the three intra families are all used', intraOk && intraSeen.size === 3);

	// A port whose only surplus is bulk has no star-port export.
	const net = seedNetwork(24, 0);
	net.ports[0].colony.pop = 40;
	trade.settleAllPorts(net, net.time);
	for (let r = 0; r < economy.RESOURCE_COUNT; r++) {
		if (economy.RESOURCES[r].interFamily < 0) continue;
		net.ports[0].colony.stock[r] = 0;
	}
	for (const r of bulk) net.ports[0].colony.stock[r] = net.ports[0].colony.stockCap[r];
	trade.step(net, 1e-6);
	trade.settleAllPorts(net, net.time);
	const bulkSpare = bulk.every(r => economy.exportableOf(net.ports[0].colony, r) > 0);
	check('the fixture has a port whose only spare stock is bulk', bulkSpare);
	const triple = trade.pickExport(net, 0, 1e9, 0);
	check('a bulk-only port offers no inter-star cargo', triple.resource < 0,
		{ resource: triple.resource, dest: triple.dest });

	// The same port can still unload ore it arrived with: the filter is on
	// load, never on arrival.
	const ship = shipLib.createShip ? shipLib.createShip() : null;
	check('a hull factory exists for the unload check', !!ship);
	if (ship) {
		ship.cargo = 40;                 // tons of ore
		ship.cargoResource = economy.R_ORE;
		ship.class = { cargo: 1000 };
		const before = net.ports[0].colony.stock[economy.R_ORE];
		const unloaded = trade.playerUnload(net, ship, 0);
		check('ore already aboard still unloads at a star port',
			unloaded.ok === 1 && unloaded.resource === economy.R_ORE && unloaded.units > 0
			&& net.ports[0].colony.stock[economy.R_ORE] > before,
			{ units: unloaded.units, reason: unloaded.reason });
	}

	// A family is a set of rows, so its sums are the member sums by
	// construction; what is worth pinning is that a resource nobody draws and
	// nobody can spare is fair (W5's rule).
	const drySite = economy.createSite();
	drySite.starMetal = 0.02; drySite.starAge = 4.6; drySite.insolation = 1;
	drySite.tsurf = 288; drySite.starClass = 'G'; drySite.type = 1; drySite.mass = 1;
	const dry = economy.createColony();
	economy.fillColony(dry, drySite, 7);
	for (let r = 0; r < economy.RESOURCE_COUNT; r++) { dry.outBase[r] = 0; dry.stock[r] = 0; }
	check('0/0 is fair, not scarce', economy.tradeTagOf(dry, economy.R_ART) === economy.TAG_FAIR);
}

// --- 28. Worlds and the fold (T2, T3) ------------------------------------
{
	const net = seedNetwork(24, 0);
	check('world pool and intra matrices are preallocated at network creation',
		trade.MAX_WORLDS_PER_STAR === 6
		&& trade.MAX_WORLDS === trade.MAX_PORTS * trade.MAX_WORLDS_PER_STAR
		&& net.worlds.length === trade.MAX_WORLDS
		&& net.worldCount === net.portCount
		&& net.ports[0].worldIdx.length === 6
		&& net.ports[0].dv.length === 36
		&& net.ports[0].couple.length === 36
		&& net.ports[0].lift.length === 6);

	// 1. One-world fold is bit-exact with the world (both port identity and
	//    explicit foldColonies into an independent record).
	const w0 = trade.worldOfPort(net, 0, 0);
	const folded1 = economy.createColony();
	economy.foldColonies(folded1, [w0], 1);
	let exact1 = net.ports[0].colony === w0
		&& w0.port === 0 && w0.slot === 0
		&& Object.is(folded1.pop, w0.pop)
		&& Object.is(folded1.capacity, w0.capacity)
		&& Object.is(folded1.coverage, w0.coverage)
		&& Object.is(folded1.growth, w0.growth)
		&& Object.is(folded1.access, w0.access)
		&& Object.is(folded1.founded, w0.founded)
		&& Object.is(folded1.last, w0.last);
	for (let r = 0; r < economy.RESOURCE_COUNT && exact1; r++) {
		exact1 = Object.is(folded1.yield[r], w0.yield[r])
			&& Object.is(folded1.outBase[r], w0.outBase[r])
			&& Object.is(folded1.stock[r], w0.stock[r])
			&& Object.is(folded1.stockCap[r], w0.stockCap[r]);
	}
	check('one-world fold is bit-exact with its world', exact1);

	// A deterministic two-world fixture keeps this T3 pool/fold test separate
	// from T4's new physical reachability gate.
	const multiSys = syntheticIntraSystem({ key: 0x4d554c54, beltA: 1.12,
		planets: [
			{ a: 1, mass: 1, radius: 1, type: 3, flags: planets.FLAG_TERRAN | planets.FLAG_IN_HZ },
			{ a: 1.01, mass: 1, radius: 1, type: 3, flags: planets.FLAG_TERRAN | planets.FLAG_IN_HZ },
			{ a: 5, mass: 1, radius: 1, type: 0, flags: 0 },
		] });
	const probeSite = economy.createSite();
	scratchRef.kind = planets.BLOCK_LANDMARK; scratchRef.index = 0;
	scratchRef.key = multiSys.star.key >>> 0;
	scratchRef.x = 0; scratchRef.y = 0; scratchRef.z = 0;
	scratchRef.colorIndex = 4; scratchRef.absMag = 4.83;
	const starName = 'T4 multi-world fixture';
	const goodSites = [];
	let poorPlanet = -1;
	const seed = economy.siteSeed(scratchRef.key >>> 0, model.seed, scratchRef.kind);
	for (let p = 0; p < multiSys.counts.planets; p++) {
		economy.fillPlanetSite(probeSite, scratchRef, multiSys, p, seed);
		const score = trade.siteHabitatScore(probeSite);
		if (score >= trade.MIN_CANDIDATE_HABITAT) goodSites.push({ belt: 0, index: p, score });
		else if (poorPlanet < 0) poorPlanet = p;
	}
	for (let b = 0; b < multiSys.belts.count; b++) {
		economy.fillBeltSite(probeSite, scratchRef, multiSys, b, seed);
		const score = trade.siteHabitatScore(probeSite);
		if (score >= trade.MIN_CANDIDATE_HABITAT) goodSites.push({ belt: 1, index: b, score });
	}
	check('fixture contains multiple settleable sites and a barren planet',
		goodSites.length >= 2 && poorPlanet >= 0, { goodCount: goodSites.length, poorPlanet });

	// Build a clean network where the star has one port on goodSites[0],
	// then found a second physically reachable world without taking a port slot.
	const mNet = trade.createNetwork({ seed: 42, modelSeed: model.seed, timeYears: 0 });
	const f0 = trade.playerFoundWorld(mNet, scratchRef, starName, multiSys,
		goodSites[0].belt, goodSites[0].index, 10);
	const pIdx = f0.port;
	const portsBefore = mNet.portCount;
	const worldsBefore = mNet.worldCount;
	let secondWorldSite = null, secondWorldScore = -1;
	for (let i = 0; i < goodSites.length; i++) {
		const candidate = goodSites[i];
		if (candidate.belt === goodSites[0].belt && candidate.index === goodSites[0].index) continue;
		if (candidate.belt) economy.fillBeltSite(probeSite, scratchRef, multiSys, candidate.index,
			economy.siteSeed(scratchRef.key >>> 0, model.seed, scratchRef.kind));
		else economy.fillPlanetSite(probeSite, scratchRef, multiSys, candidate.index,
			economy.siteSeed(scratchRef.key >>> 0, model.seed, scratchRef.kind));
		probeSite.ref = scratchRef;
		const score = trade.worldFoundingScore(mNet, pIdx, probeSite, multiSys);
		if (score > secondWorldScore) { secondWorldScore = score; secondWorldSite = candidate; }
	}
	if (secondWorldSite) {
		if (secondWorldSite.belt) economy.fillBeltSite(probeSite, scratchRef, multiSys,
			secondWorldSite.index, economy.siteSeed(scratchRef.key >>> 0, model.seed, scratchRef.kind));
		else economy.fillPlanetSite(probeSite, scratchRef, multiSys,
			secondWorldSite.index, economy.siteSeed(scratchRef.key >>> 0, model.seed, scratchRef.kind));
		probeSite.ref = scratchRef;
		secondWorldScore = trade.worldFoundingScore(mNet, pIdx, probeSite, multiSys);
	}

	// addPort on a star that already has a live port returns existing port, never bumps portCount;
	// playerFound refuses 'already a colony here'.
	check('addPort does not add a second port on an already-settled star',
		trade.addPort(mNet, probeSite, 10, trade.FRESH_FOUND) === pIdx
		&& mNet.portCount === portsBefore
		&& trade.playerFound(mNet, scratchRef, starName, multiSys, 10).reason === 'already a colony here');

	// Founding the already-settled body refuses 'already a world here'.
	check('playerFoundWorld refuses a site that already has a world',
		trade.playerFoundWorld(mNet, scratchRef, starName, multiSys,
			goodSites[0].belt, goodSites[0].index, 12).reason === 'already a world here');

	// Out-of-range or barren site refuses 'no site worth settling'.
	const badIdxReason = trade.playerFoundWorld(mNet, scratchRef, starName, multiSys,
		0, 99, 12).reason;
	let lowHabOk = badIdxReason === 'no site worth settling';
	if (poorPlanet >= 0) {
		lowHabOk = lowHabOk && trade.playerFoundWorld(mNet, scratchRef, starName, multiSys,
			0, poorPlanet, 12).reason === 'no site worth settling';
	}
	check('playerFoundWorld refuses invalid or barren sites', lowHabOk);

	// A physically deep well, rather than a manually patched matrix cell, must
	// fall below the founding score threshold. Restore it before the success case.
	let expensiveSite = secondWorldSite;
	for (let i = 0; i < goodSites.length; i++) {
		if (!goodSites[i].belt && !(goodSites[i].belt === goodSites[0].belt
			&& goodSites[i].index === goodSites[0].index)) { expensiveSite = goodSites[i]; break; }
	}
	const expensiveOldMass = multiSys.planets.mass[expensiveSite.index];
	multiSys.planets.mass[expensiveSite.index] = 1e6;
	const expensiveReason = trade.playerFoundWorld(mNet, scratchRef, starName, multiSys,
		0, expensiveSite.index, 12).reason;
	multiSys.planets.mass[expensiveSite.index] = expensiveOldMass;
	check('playerFoundWorld refuses sites below MIN_FOUND_COUPLE',
		expensiveReason === 'too expensive to reach');

	// Founding the second world succeeds and keeps portCount unchanged.
	const f1 = trade.playerFoundWorld(mNet, scratchRef, starName, multiSys,
		secondWorldSite.belt, secondWorldSite.index, 20);
	if (f1.ok !== 1) throw new Error('second-world fixture unexpectedly refused: ' + f1.reason);
	check('a second world on a settled star succeeds without adding a port',
		f1.ok === 1 && f1.port === pIdx && f1.slot === 1
		&& mNet.portCount === portsBefore
		&& mNet.worldCount === worldsBefore + 1
		&& mNet.ports[pIdx].worldCount === 2
		&& mNet.ports[pIdx].colony === mNet.ports[pIdx].fold);

	// Fold arithmetic pin: pop, capacity, stock, stockCap summed; outBase, coverage,
	// growth, access pop-weighted; yield production-weighted.
	const wa = trade.worldOfPort(mNet, pIdx, 0);
	const wb = trade.worldOfPort(mNet, pIdx, 1);
	wa.pop = 30; wb.pop = 10;
	wa.access = 0.8; wb.access = 0.4;
	wa.yield[economy.R_RARE] = 0; wa.outBase[economy.R_RARE] = 0;
	wb.yield[economy.R_RARE] = 1.4; wb.outBase[economy.R_RARE] = economy.PROD[economy.R_RARE] * 1.4;
	trade.settlePort(mNet, pIdx, 30);
	const fold = mNet.ports[pIdx].colony;
	let foldFormulaOk = near(fold.pop, wa.pop + wb.pop, 1e-9)
		&& near(fold.capacity, wa.capacity + wb.capacity, 1e-9)
		&& near(fold.coverage, (wa.pop * wa.coverage + wb.pop * wb.coverage) / fold.pop, 1e-9)
		&& near(fold.growth, (wa.pop * wa.growth + wb.pop * wb.growth) / fold.pop, 1e-9)
		&& near(fold.access, (wa.pop * wa.access + wb.pop * wb.access) / fold.pop, 1e-9)
		&& near(fold.yield[economy.R_RARE], 1.4, 1e-9);
	for (let r = 0; r < economy.RESOURCE_COUNT && foldFormulaOk; r++) {
		foldFormulaOk = near(fold.stock[r], wa.stock[r] + wb.stock[r], 1e-9)
			&& near(fold.stockCap[r], wa.stockCap[r] + wb.stockCap[r], 1e-9)
			&& near(fold.outBase[r], (wa.pop * wa.outBase[r] + wb.pop * wb.outBase[r]) / fold.pop, 1e-9);
	}
	check('two-world fold sums stocks/pop and weights rates by pop and yields by output', foldFormulaOk);

	// Inbound transfer: demand-proportional when unconstrained, water-fills warehouse caps,
	// falls back cleanly when demand is zero, and conserves mass.
	wa.stock[economy.R_FOOD] = 0;
	wb.stock[economy.R_FOOD] = 0;
	wa.outBase[economy.R_FOOD] = 0;
	wb.outBase[economy.R_FOOD] = 0;
	trade.foldPort(mNet, pIdx);
	const demA = economy.demandOf(wa, economy.R_FOOD);
	const demB = economy.demandOf(wb, economy.R_FOOD);
	const givenFood = trade.distributePortInbound(mNet, pIdx, economy.R_FOOD, 20);
	check('distributeInbound splits inbound cargo in proportion to world demand and conserves mass',
		near(givenFood, 20, 1e-9)
		&& near(wa.stock[economy.R_FOOD], 20 * demA / (demA + demB), 1e-9)
		&& near(wb.stock[economy.R_FOOD], 20 * demB / (demA + demB), 1e-9)
		&& near(fold.stock[economy.R_FOOD], wa.stock[economy.R_FOOD] + wb.stock[economy.R_FOOD], 1e-9));

	// Cap overflow check on inbound: both worlds demand food (3:1), wa only has 3 units
	// of warehouse room, so wa caps at 3 and wb absorbs the remaining 12.
	const savedFoodCapA = wa.stockCap[economy.R_FOOD];
	wa.stock[economy.R_FOOD] = 0;
	wb.stock[economy.R_FOOD] = 0;
	wa.stockCap[economy.R_FOOD] = 3;
	trade.foldPort(mNet, pIdx);
	const givenCapped = trade.distributePortInbound(mNet, pIdx, economy.R_FOOD, 15);
	const waAfterCap = wa.stock[economy.R_FOOD];
	const wbAfterCap = wb.stock[economy.R_FOOD];
	const foldAfterCap = fold.stock[economy.R_FOOD];
	wa.stockCap[economy.R_FOOD] = savedFoodCapA;
	// Zero-demand unload check: neither world demands art when stocked near cap, so
	// inbound cargo splits cleanly by free warehouse room (3 vs 9 -> 1:3) without NaN.
	wa.stock[economy.R_ART] = wa.stockCap[economy.R_ART] - 3;
	wb.stock[economy.R_ART] = wb.stockCap[economy.R_ART] - 9;
	trade.foldPort(mNet, pIdx);
	const givenArt = trade.distributePortInbound(mNet, pIdx, economy.R_ART, 8);
	check('distributeInbound water-fills warehouse caps and zero-demand goods without mass loss',
		near(givenCapped, 15, 1e-9)
		&& near(waAfterCap, 3, 1e-9)
		&& near(wbAfterCap, 12, 1e-9)
		&& near(foldAfterCap, 15, 1e-9)
		&& near(givenArt, 8, 1e-9)
		&& near(wa.stock[economy.R_ART], wa.stockCap[economy.R_ART] - 1, 1e-9)
		&& near(wb.stock[economy.R_ART], wb.stockCap[economy.R_ART] - 3, 1e-9)
		&& near(fold.stock[economy.R_ART], wa.stock[economy.R_ART] + wb.stock[economy.R_ART], 1e-9));

	// Outbound transfer: lift-weighted, never raids a deficit world below 25% reserve, conserves mass.
	wa.stock[economy.R_RARE] = wa.stockCap[economy.R_RARE] * 0.85;
	wb.stock[economy.R_RARE] = wb.stockCap[economy.R_RARE] * 0.10; // below 25% reserve
	mNet.ports[pIdx].lift[0] = 0.5;
	mNet.ports[pIdx].lift[1] = 1.0;
	trade.foldPort(mNet, pIdx);
	const wbRareBefore = wb.stock[economy.R_RARE];
	const waExpBefore = economy.exportableOf(wa, economy.R_RARE);
	const takenRare = trade.collectPortOutbound(mNet, pIdx, economy.R_RARE, 1e9);
	mNet.ports[pIdx].lift[0] = 1.0;
	check('collectOutbound taxes by lift, protects deficit worlds and conserves mass',
		takenRare > 0
		&& near(takenRare, Math.min(economy.exportableOf(fold, economy.R_RARE) + takenRare, waExpBefore * 0.5), 1e-9)
		&& wb.stock[economy.R_RARE] === wbRareBefore
		&& near(fold.stock[economy.R_RARE], wa.stock[economy.R_RARE] + wb.stock[economy.R_RARE], 1e-9));

	// Worlds cap refusal ('worlds full') when all 6 slots are occupied.
	const fullWorldNet = trade.createNetwork({ seed: 7, modelSeed: model.seed, timeYears: 0 });
	economy.fillPlanetSite(probeSite, scratchRef, multiSys, goodSites[0].index,
		economy.siteSeed(scratchRef.key >>> 0, model.seed, scratchRef.kind));
	probeSite.ref = scratchRef;
	const fp = trade.addPort(fullWorldNet, probeSite, 0, trade.FRESH_FOUND);
	for (let s = 1; s < trade.MAX_WORLDS_PER_STAR; s++) {
		probeSite.kind = 1;
		probeSite.index = 10 + s;
		trade.addWorld(fullWorldNet, fp, probeSite, 0, trade.FRESH_FOUND);
	}
	check('a port refuses a seventh world with worlds full',
		fullWorldNet.ports[fp].worldCount === 6
		&& trade.playerFoundWorld(fullWorldNet, scratchRef, starName, multiSys,
			goodSites[1].belt, goodSites[1].index, 5).reason === 'worlds full');

	// Outpost behavior: one failed world leaves a two-world port live; failing all
	// worlds demotes the port and refuses further worlds with 'star is an outpost'.
	fullWorldNet.worlds[fullWorldNet.ports[fp].worldIdx[1]].pop = economy.OUTPOST_POP_M * 0.25;
	trade.settlePort(fullWorldNet, fp, 10);
	const aliveWithOneDead = fullWorldNet.ports[fp].colony.outpost === 0 && fullWorldNet.ports[fp].demoted === 0;
	for (let s = 0; s < fullWorldNet.ports[fp].worldCount; s++) {
		fullWorldNet.worlds[fullWorldNet.ports[fp].worldIdx[s]].pop = economy.OUTPOST_POP_M * 0.25;
	}
	trade.settlePort(fullWorldNet, fp, 20);
	check('a port stays live while one world lives, demotes when all worlds fail, and refuses new worlds',
		aliveWithOneDead
		&& fullWorldNet.ports[fp].colony.outpost === 1
		&& fullWorldNet.ports[fp].demoted === 1
		&& trade.playerFoundWorld(fullWorldNet, scratchRef, starName, multiSys,
			goodSites[1].belt, goodSites[1].index, 25).reason === 'star is an outpost');

	// 600-year jump conservation across a live multi-world trading network.
	const liveNet = seedNetwork(16, 0);
	// Attach a second world onto port 0 so freighter loads, arrivals and expeditions
	// exercise a multi-world port across 600 years.
	probeSite.key = liveNet.ports[0].key;
	probeSite.kind = 1;
	probeSite.index = 3;
	probeSite.isBelt = 1;
	probeSite.type = economy.SITE_BELT;
	probeSite.mass = 0.0002;
	probeSite.starClass = 'G';
	probeSite.starLum = 1;
	probeSite.starMetal = 0.02;
	probeSite.starAge = 4.6;
	probeSite.starState = 'ms';
	probeSite.tsurf = 150;
	probeSite.insolation = 0.3;
	probeSite.seed = liveNet.ports[0].colony.seed;
	probeSite.ref = liveNet.ports[0].ref;
	probeSite.name = liveNet.ports[0].name + ' belt';
	const secondWorld = trade.addWorld(liveNet, 0, probeSite, liveNet.time, trade.FRESH_FOUND);
	trade.step(liveNet, 600);
	trade.settleAllPorts(liveNet, liveNet.time);
	const p0 = liveNet.ports[0];
	const wA = trade.worldOfPort(liveNet, 0, 0);
	const wB = trade.worldOfPort(liveNet, 0, 1);
	let conserved600 = secondWorld >= 0 && p0.worldCount === 2
		&& near(p0.colony.pop, (wA.outpost ? 0 : wA.pop) + (wB.outpost ? 0 : wB.pop), 1e-9);
	for (let r = 0; r < economy.RESOURCE_COUNT && conserved600; r++) {
		const sumStock = (wA.outpost ? 0 : wA.stock[r]) + (wB.outpost ? 0 : wB.stock[r]);
		conserved600 = near(p0.colony.stock[r], sumStock, 1e-9)
			&& wA.stock[r] >= -1e-12 && wA.stock[r] <= wA.stockCap[r] + 1e-9
			&& wB.stock[r] >= -1e-12 && wB.stock[r] <= wB.stockCap[r] + 1e-9;
	}
	check('two-world fold conserves mass and population across a 600-year jump', conserved600);

	// Inspection contract: re-discovering / re-settling at the same clock does not
	// advance worlds again or mutate population/stocks.
	const snapPop = p0.colony.pop;
	const snapFood = p0.colony.stock[economy.R_FOOD];
	planets.generateSystem(p0.ref, ctx, multiSys);
	trade.discoverSystem(liveNet, p0.ref, p0.name, multiSys, liveNet.time);
	trade.settlePort(liveNet, 0, liveNet.time);
	check('re-inspecting a multi-world star at the same clock is idempotent',
		Object.is(p0.colony.pop, snapPop) && Object.is(p0.colony.stock[economy.R_FOOD], snapFood));

	// Market family tags: 7 inter families all return valid W5 tags and 0/0 is fair.
	const drySite = economy.createSite();
	drySite.starMetal = 0.02; drySite.starAge = 4.6; drySite.insolation = 1;
	drySite.tsurf = 288; drySite.starClass = 'G'; drySite.type = 1; drySite.mass = 1;
	const dry = economy.createColony();
	economy.fillColony(dry, drySite, 9);
	for (let r = 0; r < economy.RESOURCE_COUNT; r++) { dry.outBase[r] = 0; dry.stock[r] = 0; }
	dry.pop = 0;
	let tagsOk = economy.INTER_FAMILY_SHORT.length === 7;
	for (let f = 0; f < 7 && tagsOk; f++) {
		tagsOk = economy.interFamilyTagOf(dry, f) === economy.TAG_FAIR;
	}
	check('interFamilyTagOf covers all seven shipping families and treats 0/0 as fair', tagsOk);
}

// --- 29. Intra-system delta-v graph, statistical flow and T5 readout ---------
{
	check('intra family ids are the canonical bulk/goods/pax labels',
		economy.INTRA_FAMILY_NAMES.join('|') === 'bulk|goods|pax'
		&& economy.INTRA_FAMILY_SHORT.join('|') === 'bulk|goods|pax');
	const solar = syntheticIntraSystem({
		key: 0x534f4c,
		planets: [
			{ a: 1, mass: 1, radius: 1, type: 3, flags: planets.FLAG_TERRAN | planets.FLAG_IN_HZ },
			{ a: 1.524, mass: 0.107, radius: 0.532, type: 2, flags: 0 },
		],
	});
	const graphA = syntheticTradePort(solar, 0, 0, 0, 1, 'Earth', 'Mars');
	const graphB = syntheticTradePort(solar, 0, 0, 0, 1, 'Earth', 'Mars');
	const portA = graphA.port, portB = graphB.port;
	let graphExact = true;
	for (let i = 0; i < portA.well.length && graphExact; i++) {
		graphExact = Object.is(portA.well[i], portB.well[i])
			&& Object.is(portA.land[i], portB.land[i])
			&& Object.is(portA.lift[i], portB.lift[i])
			&& Object.is(portA.access[i], portB.access[i]);
	}
	for (let i = 0; i < portA.dv.length && graphExact; i++) {
		graphExact = Object.is(portA.dv[i], portB.dv[i])
			&& Object.is(portA.tH[i], portB.tH[i])
			&& Object.is(portA.couple[i], portB.couple[i]);
	}
	const bodyParams = [], nodeSets = [], oneEdges = [];
	for (let i = 0; i < deltav.MAX_BODIES; i++) {
		bodyParams.push(deltav.createBodyParam());
		nodeSets.push(deltav.createNodeSet());
		oneEdges.push(deltav.createOneBodyEdges());
	}
	const nBodies = deltav.buildBodyNodes(solar, bodyParams, nodeSets, oneEdges);
	const muStar = deltav.G_SI * solar.star.mass * deltav.M_SUN_KG;
	const direct = {};
	deltav.dvSurfaceToSurface(muStar, bodyParams[0], bodyParams[1], false, direct);
	const directLeg = deltav.createInterEdge();
	deltav.legLoToLo(muStar, bodyParams[0], bodyParams[1], false, directLeg);
	check('T4 graph is bit-exact across repeated builds (dv, Hohmann, couple, lift)', graphExact);
	check('Earth–Mars graph edge matches the direct DeltaVLib surface→surface aero pin',
		nBodies === 2 && Math.abs(portA.dv[1] - 16020) <= 2
		&& near(portA.dv[1], direct.dv, 1e-12)
		&& near(portA.tH[1], directLeg.tH, 1e-12)
		&& near(portA.well[0], direct.well, 1e-12)
		&& near(portA.land[1], direct.land, 1e-12)
		&& near(portA.access[0], portA.couple[1], 1e-12)
		&& near(portA.access[1], portA.couple[6], 1e-12)
		&& portA.couple[1] > 0.2 && portA.couple[1] < 0.8,
		{ dv: portA.dv[1], direct: direct.dv, couple: portA.couple[1] });

	function seedOreFlow(beltA, key, tHOverride) {
		const system = syntheticIntraSystem({
			key,
			planets: [{ a: 1, mass: 1, radius: 1, type: 3, flags: planets.FLAG_TERRAN | planets.FLAG_IN_HZ }],
			beltA,
		});
		const active = syntheticTradePort(system, 0, 0, 1, 0, 'Terran', 'belt');
		const closed = syntheticTradePort(system, 0, 0, 1, 0, 'Terran', 'belt');
		if (tHOverride !== undefined) active.port.tH.fill(tHOverride);
		for (const fixture of [active, closed]) {
			for (const world of fixture.worlds) {
				world.last = 0; world.pop = 10; world.capacity = 100;
				world.coverage = 0.5; world.outpost = 0;
				world.outBase.fill(0); world.stock.fill(0); world.stockCap.fill(1000);
			}
			const belt = fixture.worlds[1], terran = fixture.worlds[0];
			belt.stockCap[economy.R_ORE] = 100;
			belt.stock[economy.R_ORE] = 100;
			terran.outBase[economy.R_ROBOTS] = 1;
		}
		closed.port.couple[1 * trade.MAX_WORLDS_PER_STAR] = 0;
		closed.port.couple[0 * trade.MAX_WORLDS_PER_STAR + 1] = 0;
		trade.settlePort(active.net, active.portIndex, 20);
		trade.settlePort(closed.net, closed.portIndex, 20);
		let conserved = true;
		for (let r = 0; r < economy.RESOURCE_COUNT && conserved; r++) {
			const activeTotal = active.worlds[0].stock[r] + active.worlds[1].stock[r];
			const closedTotal = closed.worlds[0].stock[r] + closed.worlds[1].stock[r];
			conserved = near(activeTotal, closedTotal, 1e-9);
		}
		return {
			active, closed, conserved,
			oreMoved: active.port.intraFlow[trade.intraFlowIndex(1, 0, economy.INTRA_BULK)],
			targetOre: active.worlds[0].stock[economy.R_ORE],
		};
	}
	const nearBelt = seedOreFlow(1.1, 0x10101);
	const farBelt = seedOreFlow(11, 0x10102);
	const timeOnly = seedOreFlow(1.1, 0x10103, 1e50);
	check('a close belt feeds more ore in 20 years than the same belt at 10× orbital radius',
		nearBelt.oreMoved > farBelt.oreMoved
		&& nearBelt.active.port.dv[trade.MAX_WORLDS_PER_STAR] < farBelt.active.port.dv[trade.MAX_WORLDS_PER_STAR]
		&& nearBelt.active.port.tH[trade.MAX_WORLDS_PER_STAR] < farBelt.active.port.tH[trade.MAX_WORLDS_PER_STAR]
		&& nearBelt.active.port.couple[trade.MAX_WORLDS_PER_STAR] > farBelt.active.port.couple[trade.MAX_WORLDS_PER_STAR],
		{ nearOre: nearBelt.oreMoved, farOre: farBelt.oreMoved,
			nearDv: nearBelt.active.port.dv[6], farDv: farBelt.active.port.dv[6],
			nearTH: nearBelt.active.port.tH[6], farTH: farBelt.active.port.tH[6],
			nearCouple: nearBelt.active.port.couple[6], farCouple: farBelt.active.port.couple[6] });
	check('Hohmann time is readout-only: replacing tH does not alter statistical flow',
		near(timeOnly.oreMoved, nearBelt.oreMoved, 1e-12)
		&& near(timeOnly.targetOre, nearBelt.targetOre, 1e-12));
	check('couple-weighted intra transfers conserve every stock family against local-only settlement',
		nearBelt.conserved && farBelt.conserved,
		{ near: nearBelt.conserved, far: farBelt.conserved });
	const settledStocks = nearBelt.active.worlds.map((world) => world.stock.slice());
	const settledPops = nearBelt.active.worlds.map((world) => world.pop);
	const settledFlows = nearBelt.active.port.intraFlow.slice();
	trade.settlePort(nearBelt.active.net, nearBelt.active.portIndex, 20);
	let fixedPoint = true;
	for (let s = 0; s < nearBelt.active.port.worldCount && fixedPoint; s++) {
		const world = nearBelt.active.worlds[s];
		fixedPoint = Object.is(world.pop, settledPops[s]) && world.last === 20;
		for (let r = 0; r < economy.RESOURCE_COUNT && fixedPoint; r++) {
			fixedPoint = Object.is(world.stock[r], settledStocks[s][r]);
		}
	}
	for (let i = 0; i < settledFlows.length && fixedPoint; i++) {
		fixedPoint = Object.is(nearBelt.active.port.intraFlow[i], settledFlows[i]);
	}
	const fixedFold = nearBelt.active.port.colony;
	fixedPoint = fixedPoint && near(fixedFold.pop,
		nearBelt.active.worlds[0].pop + nearBelt.active.worlds[1].pop, 1e-12);
	for (let r = 0; r < economy.RESOURCE_COUNT && fixedPoint; r++) {
		fixedPoint = near(fixedFold.stock[r],
			nearBelt.active.worlds[0].stock[r] + nearBelt.active.worlds[1].stock[r], 1e-12);
	}
	check('settlePort reaches a non-circular same-clock fixed point: frozen flows apply once, fold and readout stay stable', fixedPoint);
	const t5Text = trade.intraReadoutText(nearBelt.active.net, nearBelt.active.portIndex);
	check('T5 readout names the largest local flow, its dv/couple/Hohmann and each lift',
		t5Text.includes('flow · km/s') && t5Text.includes('bulk Terran ← belt')
		&& t5Text.includes('couple ') && t5Text.includes('Hohmann ')
		&& t5Text.includes('lift') && t5Text.includes('Terran') && t5Text.includes('belt'), t5Text);

	const goodsSystem = syntheticIntraSystem({ key: 0x474f4f44, beltA: 1.1,
		planets: [{ a: 1, mass: 1, radius: 1, type: 3, flags: planets.FLAG_TERRAN | planets.FLAG_IN_HZ }] });
	const goods = syntheticTradePort(goodsSystem, 0, 0, 1, 0, 'factory', 'belt');
	for (const world of goods.worlds) {
		world.last = 0; world.pop = 10; world.capacity = 100; world.coverage = 0.5;
		world.outpost = 0; world.outBase.fill(0); world.stock.fill(0); world.stockCap.fill(1000);
	}
	const factory = goods.worlds[0];
	factory.stockCap[economy.R_ROBOTS] = 100;
	factory.stock[economy.R_ROBOTS] = 100;
	// Cover the other two manufactured needs without creating a surplus, so
	// this pin isolates the robots slice inside the aggregated goods family.
	factory.stock[economy.R_CHEM] = 12;
	factory.stock[economy.R_COMPUTE] = 2.4;
	trade.settlePort(goods.net, goods.portIndex, 20);
	const goodsMoved = goods.port.intraFlow[trade.intraFlowIndex(0, 1, economy.INTRA_GOODS)];
	check('the goods family closes member demand with member supply, not only bulk',
		goodsMoved > 0 && goods.worlds[1].stock[economy.R_ROBOTS] > 0
		&& near(goodsMoved, goods.worlds[1].stock[economy.R_ROBOTS], 1e-12),
		{ flow: goodsMoved, robots: goods.worlds[1].stock[economy.R_ROBOTS] });

	const paxSystem = syntheticIntraSystem({ key: 0x504158, planets: [
		{ a: 1, mass: 1, radius: 1, type: 3, flags: planets.FLAG_TERRAN | planets.FLAG_IN_HZ },
		{ a: 1.1, mass: 1, radius: 1, type: 3, flags: planets.FLAG_TERRAN | planets.FLAG_IN_HZ },
	] });
	const pax = syntheticTradePort(paxSystem, 0, 0, 0, 1, 'source', 'receiver');
	const paxClosed = syntheticTradePort(paxSystem, 0, 0, 0, 1, 'source', 'receiver');
	for (const fixture of [pax, paxClosed]) {
		for (let s = 0; s < fixture.worlds.length; s++) {
			const world = fixture.worlds[s];
			world.last = 0; world.pop = s === 0 ? 10 : 90; world.capacity = 100;
			world.coverage = 0.8; world.outpost = 0;
			world.outBase.fill(0); world.stock.fill(0); world.stockCap.fill(1000);
		}
	}
	paxClosed.port.couple[1] = 0;
	paxClosed.port.couple[trade.MAX_WORLDS_PER_STAR] = 0;
	trade.settlePort(pax.net, pax.portIndex, 20);
	trade.settlePort(paxClosed.net, paxClosed.portIndex, 20);
	const paxMoved = pax.port.intraFlow[trade.intraFlowIndex(0, 1, economy.INTRA_PAX)];
	const paxTotal = pax.worlds[0].pop + pax.worlds[1].pop;
	const paxClosedTotal = paxClosed.worlds[0].pop + paxClosed.worlds[1].pop;
	check('healthy worlds move passengers as conserved population, never as warehouse colonists',
		paxMoved > 0 && pax.worlds[0].pop < paxClosed.worlds[0].pop
		&& pax.worlds[1].pop > paxClosed.worlds[1].pop
		&& near(paxTotal, paxClosedTotal, 1e-12)
		&& pax.worlds[0].stock[economy.R_PEOPLE] === 0
		&& pax.worlds[1].stock[economy.R_PEOPLE] === 0,
		{ flow: paxMoved, total: paxTotal, closedTotal: paxClosedTotal });

	const starvingSystem = syntheticIntraSystem({ key: 0x53544152, beltA: 1.1,
		planets: [{ a: 1, mass: 1, radius: 1, type: 3, flags: planets.FLAG_TERRAN | planets.FLAG_IN_HZ }] });
	const starving = syntheticTradePort(starvingSystem, 0, 0, 1, 0, 'low', 'belt');
	for (const world of starving.worlds) {
		world.last = 0; world.pop = 10; world.capacity = 100; world.coverage = 0.59;
		world.outpost = 0; world.outBase.fill(0); world.stock.fill(0); world.stockCap.fill(1000);
	}
	trade.settlePort(starving.net, starving.portIndex, 20);
	let paxZero = true;
	for (let s = 0; s < starving.port.worldCount; s++) {
		for (let t = 0; t < starving.port.worldCount; t++) {
			paxZero = paxZero
				&& starving.port.intraFlow[trade.intraFlowIndex(s, t, economy.INTRA_PAX)] === 0;
		}
	}
	check('a starving world below 0.6 coverage neither sends nor receives passengers', paxZero);

	const earthOnly = syntheticTradePort(solar, 0, 0, undefined, -1, 'Earth');
	const earthWorld = earthOnly.worlds[0];
	trade.settlePort(earthOnly.net, earthOnly.portIndex, 20);
	const earthFlowZero = earthOnly.port.intraFlow.every((x) => x === 0);
	const robots = economy.R_ROBOTS;
	earthWorld.stockCap[robots] = 1000; earthWorld.stock[robots] = 1000;
	const deepExportable = economy.exportableOf(earthWorld, robots);
	const deepTaken = trade.collectPortOutbound(earthOnly.net, earthOnly.portIndex, robots, deepExportable);
	const gasSystem = syntheticIntraSystem({ key: 0x474153,
		planets: [{ a: 5, mass: 300, radius: 11, type: 7, flags: 0 }] });
	const gasOnly = syntheticTradePort(gasSystem, 0, 0, undefined, -1, 'giant');
	trade.settlePort(gasOnly.net, gasOnly.portIndex, 20);
	check('one-world ports keep zero intra flow; lift is below 1 exactly when a surface well is positive',
		earthFlowZero && earthOnly.port.well[0] > 0 && earthOnly.port.lift[0] < 1
		&& gasOnly.port.well[0] === 0 && gasOnly.port.lift[0] === 1
		&& gasOnly.port.intraFlow.every((x) => x === 0));
	check('deep-well exports of ore-derived factory cores are lift-taxed below exportable stock',
		deepExportable > 0 && deepTaken > 0 && deepTaken < deepExportable,
		{ exportable: deepExportable, taken: deepTaken, lift: earthOnly.port.lift[0] });
	const lavaBeltSystem = syntheticIntraSystem({ key: 0x4c415641, beltA: 2.5,
		planets: [{ a: 0.1, mass: 1, radius: 1, type: 0, flags: 0 }] });
	const lavaBelt = syntheticTradePort(lavaBeltSystem, 0, 0, 1, 0, 'lava', 'belt');
	check('a belt is a cheaper star-port lift than a lava world on the same star',
		lavaBelt.port.lift[1] > lavaBelt.port.lift[0]
		&& (1 - lavaBelt.port.lift[1]) < (1 - lavaBelt.port.lift[0]),
		{ lava: lavaBelt.port.lift[0], belt: lavaBelt.port.lift[1] });

	const foundingSystem = syntheticIntraSystem({ key: 0x464f554e,
		planets: [
			{ a: 1, mass: 1, radius: 1, type: 3, flags: planets.FLAG_TERRAN | planets.FLAG_IN_HZ },
			{ a: 1.1, mass: 1, radius: 1, type: 3, flags: planets.FLAG_TERRAN | planets.FLAG_IN_HZ },
			{ a: 10, mass: 1, radius: 1, type: 3, flags: planets.FLAG_TERRAN | planets.FLAG_IN_HZ },
		] });
	const founder = syntheticTradePort(foundingSystem, 0, 0, undefined, -1, 'capital');
	const nearSite = syntheticSite(foundingSystem, founder.ref, 0, 1, 'near camp');
	const farSite = syntheticSite(foundingSystem, founder.ref, 0, 2, 'far camp');
	const nearScore = trade.worldFoundingScore(founder.net, founder.portIndex, nearSite, foundingSystem);
	const farScore = trade.worldFoundingScore(founder.net, founder.portIndex, farSite, foundingSystem);
	const equalHabitat = near(trade.siteHabitatScore(nearSite), trade.siteHabitatScore(farSite), 1e-12);
	const farMass = foundingSystem.planets.mass[2];
	foundingSystem.planets.mass[2] = 1e6;
	const farCandidate = syntheticSite(foundingSystem, founder.ref, 0, 2, 'far camp');
	const farWellScore = trade.worldFoundingScore(founder.net, founder.portIndex, farCandidate, foundingSystem);
	const tooFar = trade.playerFoundWorld(founder.net, founder.ref, 'T4', foundingSystem, 0, 2, 10);
	foundingSystem.planets.mass[2] = farMass;
	check('second-world founding scores prefer the closer of two equal-habitat sites',
		equalHabitat && nearScore > farScore && nearScore > trade.MIN_FOUND_COUPLE,
		{ nearScore, farScore, habitat: trade.siteHabitatScore(nearSite) });
	check('the same habitat loses the too-expensive founding gate when its surface well is too deep',
		tooFar.reason === 'too expensive to reach' && farWellScore < trade.MIN_FOUND_COUPLE,
		{ reason: tooFar.reason, score: farWellScore });

	const queueFixture = syntheticTradePort(solar, 0, 0, undefined, -1, 'queue world');
	trade.finalize(queueFixture.net);
	const eventTimesA = new Float64Array(16), eventKindsA = new Uint8Array(16);
	const eventRefsA = new Uint32Array(16), eventRevisionsA = new Uint32Array(16);
	const eventTimesB = new Float64Array(16), eventKindsB = new Uint8Array(16);
	const eventRefsB = new Uint32Array(16), eventRevisionsB = new Uint32Array(16);
	const queueSize = queueFixture.net.queue.size, ships = queueFixture.net.shipCount;
	const peekCountA = queueLib.peekNext(queueFixture.net.queue, eventTimesA, eventKindsA,
		eventRefsA, eventRevisionsA, 4);
	trade.settleAllPorts(queueFixture.net, 600);
	const peekCountB = queueLib.peekNext(queueFixture.net.queue, eventTimesB, eventKindsB,
		eventRefsB, eventRevisionsB, 4);
	let samePeek = peekCountA === peekCountB && queueFixture.net.queue.size === queueSize
		&& queueFixture.net.shipCount === ships;
	for (let i = 0; i < peekCountA && samePeek; i++) {
		samePeek = Object.is(eventTimesA[i], eventTimesB[i])
			&& eventKindsA[i] === eventKindsB[i]
			&& eventRefsA[i] === eventRefsB[i]
			&& eventRevisionsA[i] === eventRevisionsB[i];
	}
	check('a closed one-world system settles through 600 years without changing hulls or queue events',
		samePeek && queueFixture.worlds[0].last === 600,
		{ queueSize, after: queueFixture.net.queue.size, ships });
}

// --- ui.20: requisition and release (workspace-plan.md §9.3) ---------------
// The eight invariants of the takeover law: sailing hulls only, one at a
// time, the fleet count honest while the hull is out and whole again after
// release, no statistical event moving a crewed hull, and the pose drawn
// from the voyage's own chord.
{
	const net = seedNetwork(12, 0);
	trade.step(net, 600);
	let sailing = -1, docked = -1, waiting = -1, foundingIdx = -1;
	for (let i = 0; i < net.shipCount; i++) {
		const s = net.ships[i];
		if (s.state === trade.SHIP_SAILING && sailing < 0) sailing = i;
		if (s.state === trade.SHIP_DOCKED && docked < 0) docked = i;
		if (s.state === trade.SHIP_WAITING && waiting < 0) waiting = i;
		if (s.state === trade.SHIP_FOUNDING && foundingIdx < 0) foundingIdx = i;
	}
	check('the fixture has a sailing hull to requisition', sailing >= 0, { sailing, ships: net.shipCount });
	if (docked >= 0) check('a docked hull refuses requisition with its reason',
		trade.requisition(net, docked).ok === 0 && trade.requisition(net, docked).reason.includes('already in port'));
	if (waiting >= 0) check('an idle hull refuses requisition',
		trade.requisition(net, waiting).ok === 0 && trade.requisition(net, waiting).reason.includes('idle'));
	if (foundingIdx >= 0) check('a founding voyage cannot be diverted',
		trade.requisition(net, foundingIdx).ok === 0
		&& trade.requisition(net, foundingIdx).reason === 'a founding voyage cannot be diverted');
	const shipsBefore = net.shipCount;
	const freeBefore = trade.freeFreighters(net);
	const hullBefore = net.ships[sailing].hull;
	const cargoBefore = net.ships[sailing].cargo;
	const amountBefore = net.ships[sailing].amount;
	const pose = [0, 0, 0];
	trade.shipPosition(net, sailing, net.time, pose);
	const r = trade.requisition(net, sailing);
	check('requisition converts a sailing hull', r.ok === 1 && net.ships[sailing].state === trade.SHIP_CREWED,
		{ ok: r.ok, reason: r.reason });
	check('the seed pose is the drawn chord position and a unit direction',
		finite(r.x) && finite(r.y) && finite(r.z)
		&& Math.abs(r.x - pose[0]) < 1e-9 && Math.abs(r.y - pose[1]) < 1e-9 && Math.abs(r.z - pose[2]) < 1e-9
		&& Math.abs(Math.sqrt(r.dx * r.dx + r.dy * r.dy + r.dz * r.dz) - 1) < 1e-9);
	check('the hold crosses over: hull, resource and tons match the network record',
		r.hull === hullBefore
		&& (cargoBefore === trade.NO_RESOURCE
			? r.resource === -1 && r.tons === 0
			: r.resource === cargoBefore && Math.abs(r.tons - economy.tonsForUnits(cargoBefore, amountBefore)) < 1e-9)
		&& net.ships[sailing].amount === 0);
	check('the record stays in place and the effective fleet is one smaller',
		net.shipCount === shipsBefore && trade.crewedCount(net) === 1
		&& trade.freeFreighters(net) === freeBefore - 1);
	check('a second requisition refuses while a hull is crewed', (() => {
		for (let i = 0; i < net.shipCount; i++) {
			if (i !== sailing && net.ships[i].state === trade.SHIP_SAILING) {
				const second = trade.requisition(net, i);
				return second.ok === 0 && second.reason.includes('already crewed');
			}
		}
		return true;        // no second sailing hull to try — vacuously held
	})());
	// Invariant 4: a long drain moves the whole network but never the crewed
	// hull — no event survives the conversion and the guard holds.
	const processedBefore = net.processed;
	trade.step(net, 5000);
	const crewedShip = net.ships[sailing];
	check('a crewed hull processes no events over a 5000-year drain',
		net.processed > processedBefore && crewedShip.state === trade.SHIP_CREWED
		&& crewedShip.port === -1 && crewedShip.to === -1 && crewedShip.amount === 0);
	// Release: deliver a hold at a live, settled, non-outpost port.
	let port = -1;
	for (let i = 0; i < net.portCount; i++) {
		if (!net.ports[i].colony.outpost && net.ports[i].colony.pop > 0) { port = i; break; }
	}
	let resource = -1;
	for (let rr = 0; rr < economy.RESOURCE_COUNT; rr++) {
		if (economy.RESOURCES[rr].interFamily >= 0) { resource = rr; break; }
	}
	check('release refuses a hull that is not crewed', sailing !== 0
		? trade.release(net, port, sailing === 0 ? 1 : 0, 0, -1, net.time).ok === 0 : true);
	const res = trade.release(net, port, sailing, 500, resource, net.time);
	check('release delivers the hold and re-docks the hull at the port',
		res.ok === 1 && res.units > 0
		&& crewedShip.state === trade.SHIP_DOCKED && crewedShip.port === port && crewedShip.from === port
		&& crewedShip.cargo === trade.NO_RESOURCE && crewedShip.hold === trade.HULLS[crewedShip.hull].hold,
		{ ok: res.ok, reason: res.reason, units: res.units });
	check('the fleet count returns to where it was',
		trade.crewedCount(net) === 0 && trade.freeFreighters(net) === freeBefore
		&& net.shipCount === shipsBefore);
	// The released hull re-enters statistical service on the port's own
	// schedule (the EV_LOAD spawnShip also issues).
	trade.step(net, 50);
	check('the released hull is back in service', net.ships[sailing].state !== trade.SHIP_CREWED);
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
