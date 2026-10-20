// src/core/trade.js
// The trade network: colonies as ports, autonomous freighters and colonisation
// expeditions, all driven by the discrete-event queue (trade-plan.md §3).
//
// One event per ship, scheduled from the event's own time — an arrival loads
// and schedules the next voyage from *that* time, so a 500-year clock jump
// produces the same voyages as 500 one-year steps. Factories are not stepped
// here: a port is settled (economy.settleColony) when a ship reaches it or
// when the viewer inspects it. That is the whole point of the design.

'use strict';

(function () {
	'use strict';

	const economy = (typeof module !== 'undefined' && module.exports)
		? require('./economy.js')
		: window.EconomyLib;
	const queueLib = (typeof module !== 'undefined' && module.exports)
		? require('./exec-queue.js')
		: window.ExecQueueLib;
	const route = (typeof module !== 'undefined' && module.exports)
		? require('./route.js')
		: window.RouteLib;
	const planets = (typeof module !== 'undefined' && module.exports)
		? require('../math/planets.js')
		: window.PlanetsLib;
	const hash = (typeof module !== 'undefined' && module.exports)
		? require('../math/hash.js')
		: window.HashLib;
	const dv = (typeof module !== 'undefined' && module.exports)
		? require('../math/deltav.js')
		: window.DeltaVLib;

	const KPC_M = route.KPC_M;
	const SECONDS_PER_YEAR = dv.SECONDS_PER_YEAR;
	const LY_PER_KPC = 3261.563673;

	const PORT_CHANCE = 0.35;           // stars the galaxy has settled at all
	// The map starts smaller than it ends: the first `SEED_PORTS` settled
	// stars are the galaxy the player arrives into, and expeditions grow the
	// network toward MAX_PORTS. A map that starts full has no frontier, and
	// the brief's colonisation has nothing to do.
	const SEED_PORTS = 32;
	const MAX_PORTS = 64;
	// The hard cap counts every ship, including an expedition in flight; the
	// freighter fleet keeps its own smaller target so a founder always has a
	// slot to come home to. A port is served by ~1.5 hulls: at 64 ports and
	// 2–4 ly/year, that is a visit every century or two, which is what the
	// 150-year warehouses are sized for.
	const MAX_SHIPS = 96;
	const MAX_FREIGHTERS = 74;
	const MAX_CANDIDATES = 256;

	// The clock ladder in years per wall second. 100 y/s is the default: a
	// neighbouring-star voyage (tens of years) is under a second, a 2000-year
	// cross-arm haul is twenty, and 0 is a real pause.
	const TRADE_RATES = [0, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];
	const TRADE_RATE_DEFAULT_INDEX = 7;
	const TRADE_RATE_DEFAULT = TRADE_RATES[TRADE_RATE_DEFAULT_INDEX];
	const TRADE_ROUTES_DEFAULT = 1;

	// Event kinds. A ship's current event is the only one it owns; the tick is
	// the one global event that keeps the fleet at its target size and looks
	// for colonisation opportunities.
	const EV_ARRIVE = 0, EV_LOAD = 1, EV_WAIT = 2, EV_FOUND = 3, EV_TICK = 4;

	const SHIP_DOCKED = 0, SHIP_SAILING = 1, SHIP_WAITING = 2, SHIP_FOUNDING = 3;
	const SHIP_STATE_NAMES = ['docked', 'sailing', 'waiting', 'founding'];
	const NO_RESOURCE = 255;

	// Freighters, authored like the game-mode hulls. `lyPerYear` is the trade
	// clock's speed, not a fraction of c: at 0.9 c a 260 ly haul is a
	// three-century voyage, every port starves between two visits, and the
	// network is a slideshow. The galaxy clock (100 y/s) and the colony
	// dynamics set the pace the overlays must read at, so the hull table is
	// tuned against them — the same way the game-mode hulls are tuned against
	// the autopilot's Δv budget.
	const HULLS = [
		{ id: 'bulk', name: 'bulk freighter', lyPerYear: 2.0, hold: 30000 },
		{ id: 'hauler', name: 'hauler', lyPerYear: 3.0, hold: 15000 },
		{ id: 'clipper', name: 'clipper', lyPerYear: 4.5, hold: 8000 },
	];

	const DOCK_YEARS = 0.5;             // unload → load
	const WAIT_YEARS = 2;               // retry a port with no cargo
	const TICK_YEARS = 25;              // colonisation check
	const FIRST_LOAD_YEARS = 0.5;
	const MAX_FOUND_LY = 300;           // colonisation range: a few centuries of flight
	const COLONISTS_PER_EXPEDITION = 150;
	const ROBOTS_PER_EXPEDITION = 25;
	const POP_PER_COLONIST_UNIT = 0.004; // 150 units → 0.6 M people
	const EXPEDITION_INTERVAL = 200;     // years between launches
	const FOUND_STOCK_FRAC = 0.45;
	const INITIAL_SHIPS = 12;
	const SHIPS_PER_PORT = 1.5;
	const MAX_LEG_LY = 3000;

	// A shipment is sized to the destination's draw, not to the hold: a hold
	// that arrives full at a port which can take a tenth of it parks the rest
	// in orbit and starves the next port on the list.
	const SHIPMENT_YEARS = 150;

	// Hash streams beyond the economy's own.
	const TR_CH_ROUTE = 700, TR_CH_SHIP = 740, TR_CH_PORT = 760;

	function createPort() {
		return {
			colony: economy.createColony(),
			key: 0, name: '', kind: 0, index: 0,
			arrivals: 0, received: 0,
			x: 0, y: 0, z: 0,
			ref: { kind: 0, index: 0, key: 0, x: 0, y: 0, z: 0, colorIndex: 0, absMag: 0 },
		};
	}

	function createShip() {
		return {
			index: 0, hull: 0, hold: 0, cargo: NO_RESOURCE, amount: 0,
			state: SHIP_DOCKED, port: -1, from: -1, to: -1, candidate: -1,
			depart: 0, arrive: 0, revision: 0, trips: 0, delivered: 0, founded: 0,
		};
	}

	function createCandidate() {
		return { site: economy.createSite(), used: 0 };
	}

	function createNetwork(options) {
		const seed = (options && options.seed) | 0;
		const time = (options && options.timeYears) || 0;
		const net = {
			seed,
			modelSeed: (options && options.modelSeed) || seed,
			time,
			queue: queueLib.createExecQueue(256),
			portCount: 0,
			seedPorts: SEED_PORTS,
			shipCount: 0,
			candidateCount: 0,
			ports: [],
			ships: [],
			candidates: [],
			processed: 0,
			stale: 0,
			founded: 0,
			delivered: 0,
			lastEvent: 0,
			lastExpedition: -1e9,
			tickScheduled: 0,
			handler: null,
		};
		for (let i = 0; i < MAX_PORTS; i++) net.ports.push(createPort());
		for (let i = 0; i < MAX_SHIPS; i++) net.ships.push(createShip());
		for (let i = 0; i < MAX_CANDIDATES; i++) net.candidates.push(createCandidate());
		// The drain's callback: one closure per network, never per event.
		net.handler = (time, kind, ref, revision) => handleEvent(net, time, kind, ref, revision);
		return net;
	}

	// --- Lookups ------------------------------------------------------------

	function portOfStar(net, key) {
		const k = key >>> 0;
		for (let i = 0; i < net.portCount; i++) if (net.ports[i].key === k) return i;
		return -1;
	}

	function portIndexOf(net, key, kind, index) {
		const n = net.portCount;
		for (let i = 0; i < n; i++) {
			const p = net.ports[i];
			if (p.key === key && p.kind === kind && p.index === index) return i;
		}
		return -1;
	}

	function candidateIndexOf(net, key, kind, index) {
		const n = net.candidateCount;
		for (let i = 0; i < n; i++) {
			const c = net.candidates[i];
			if (c.site.key === key && c.site.kind === kind && c.site.index === index) return i;
		}
		return -1;
	}

	function bestPortOfStar(net, key) {
		let best = -1, bestPop = -1;
		for (let i = 0; i < net.portCount; i++) {
			const port = net.ports[i];
			if (port.key !== key) continue;
			if (port.colony.pop > bestPop) { bestPop = port.colony.pop; best = i; }
		}
		return best;
	}

	function portDistanceKpc(a, b) {
		const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
		return Math.sqrt(dx * dx + dy * dy + dz * dz);
	}

	function distanceLy(net, a, b) {
		return portDistanceKpc(net.ports[a], net.ports[b]) * LY_PER_KPC;
	}

	// THE trade-clock law: a leg's length in trade years. Speed is the hull's
	// authored `lyPerYear`; half a year is the floor so two ports at the same
	// coordinate never produce a zero-length voyage (a zero-length event would
	// let a ship cycle forever inside one step).
	function legYears(distanceKpc, hullIndex) {
		const ly = distanceKpc * LY_PER_KPC;
		const years = ly / HULLS[hullIndex].lyPerYear;
		return years > 0.5 ? years : 0.5;
	}

	// --- Ports and candidates ----------------------------------------------

	function addPort(net, site, nowYears) {
		const existing = portOfStar(net, site.key);
		if (existing >= 0) return existing;   // one colony per star
		if (net.portCount >= MAX_PORTS) return -1;
		const index = net.portCount++;
		const port = net.ports[index];
		economy.setupColony(port.colony, site, nowYears, site.seed >>> 0);
		port.key = site.key >>> 0;
		port.kind = site.kind;
		port.index = site.index;
		port.name = site.name || economy.siteName('', site.key, site.kind, site.index);
		port.x = site.x;
		port.y = site.y;
		port.z = site.z;
		const ref = site.ref;
		if (ref) {
			port.ref.kind = ref.kind;
			port.ref.index = ref.index;
			port.ref.key = ref.key >>> 0;
			port.ref.x = ref.x; port.ref.y = ref.y; port.ref.z = ref.z;
			port.ref.colorIndex = ref.colorIndex; port.ref.absMag = ref.absMag;
		}
		// A settled site is no longer a colonisation candidate.
		const c = candidateIndexOf(net, site.key, site.kind, site.index);
		if (c >= 0) net.candidates[c].used = 1;
		return index;
	}

	function addCandidate(net, site) {
		if (net.candidateCount >= MAX_CANDIDATES) return -1;
		if (candidateIndexOf(net, site.key, site.kind, site.index) >= 0) return -1;
		if (portIndexOf(net, site.key, site.kind, site.index) >= 0) return -1;
		const index = net.candidateCount++;
		const c = net.candidates[index];
		economy.copySite(c.site, site);
		c.used = 0;
		return index;
	}

	// Discover every site of one generated system. `ref` is the pick-shaped
	// star record; `system` is a planets SystemRecord. Idempotent: a second
	// inspection adds nothing, it only returns the colony indices.
	function discoverSystem(net, ref, starName, system, nowYears) {
		const key = system.star.key >>> 0;
		const seed = economy.siteSeed(key, net.modelSeed, ref.kind);
		const site = DISCOVER_SITE;
		let added = 0;
		// A star settles at most once: one colony is one port, and two
		// colonies of the same star would be a zero-year route that outbids
		// every real voyage. The star-level roll is the galaxy's settled
		// fraction; a settled star puts its colony on the best site it has,
		// and the rest of its worlds stay unsettled (no candidates).
		if (portOfStar(net, key) >= 0) return 0;
		const planets = system.counts.planets;
		const belts = system.belts;
		// The settled fraction is a seed-map property, but the seed map is
		// bounded: once `seedPorts` stars are settled the rest of the galaxy
		// stays a frontier, and only expeditions found new colonies.
		const maySettle = net.portCount < net.seedPorts
			&& hash.hash01At(seed, TR_CH_PORT) < PORT_CHANCE;
		if (maySettle) {
			let bestScore = -1, bestIndex = -1, bestBelt = 0;
			for (let i = 0; i < planets; i++) {
				economy.fillPlanetSite(site, ref, system, i, seed);
				const habitat = economy.HABITAT[site.type];
				const score = (site.flags & planets.FLAG_TERRAN) ? habitat * 1.5 : habitat;
				if (score > bestScore) { bestScore = score; bestIndex = i; bestBelt = 0; }
			}
			if (bestIndex < 0 && belts.count > 0) { bestIndex = 0; bestBelt = 1; }
			if (bestIndex >= 0) {
				if (bestBelt) economy.fillBeltSite(site, ref, system, bestIndex, seed);
				else economy.fillPlanetSite(site, ref, system, bestIndex, seed);
				site.x = ref.x; site.y = ref.y; site.z = ref.z;
				site.ref = ref;
				site.name = economy.siteName(starName || '', key, bestBelt, bestIndex);
				if (addPort(net, site, nowYears) >= 0) added++;
			}
			return added;
		}
		for (let i = 0; i < planets; i++) {
			economy.fillPlanetSite(site, ref, system, i, seed);
			site.x = ref.x; site.y = ref.y; site.z = ref.z;
			site.ref = ref;
			site.name = economy.siteName(starName || '', key, 0, i);
			addCandidate(net, site);
		}
		for (let k = 0; k < belts.count; k++) {
			economy.fillBeltSite(site, ref, system, k, seed);
			site.x = ref.x; site.y = ref.y; site.z = ref.z;
			site.ref = ref;
			site.name = economy.siteName(starName || '', key, 1, k);
			addCandidate(net, site);
		}
		return added;
	}

	// Settle the ports of one star to `nowYears` without discovering anything
	// new — the 4 Hz readout's cheap path.
	function settleSystem(net, key, nowYears) {
		for (let i = 0; i < net.portCount; i++) {
			const port = net.ports[i];
			if (port.key === key) economy.settleColony(port.colony, nowYears);
		}
	}

	// --- Ships and events ---------------------------------------------------

	function scheduleShip(net, ship, time, kind) {
		ship.revision = (ship.revision + 1) >>> 0;
		queueLib.push(net.queue, time, kind, ship.index, ship.revision);
	}

	function freeShip(net) {
		if (net.shipCount >= MAX_SHIPS) return -1;
		return net.shipCount++;
	}

	function spawnShip(net, portIndex, hullIndex, time) {
		if (net.portCount === 0) return -1;
		const index = freeShip(net);
		if (index < 0) return -1;
		const ship = net.ships[index];
		const hull = HULLS[hullIndex];
		ship.index = index;
		ship.hull = hullIndex;
		ship.hold = hull.hold;
		ship.cargo = NO_RESOURCE;
		ship.amount = 0;
		ship.hold = HULLS[ship.hull].hold;
		ship.state = SHIP_DOCKED;
		ship.port = portIndex;
		ship.from = portIndex;
		ship.to = -1;
		ship.candidate = -1;
		ship.depart = time;
		ship.arrive = time;
		ship.revision = 0;
		ship.trips = 0;
		ship.delivered = 0;
		ship.founded = 0;
		scheduleShip(net, ship, time + FIRST_LOAD_YEARS + index * 0.37, EV_LOAD);
		return index;
	}

	// Ships are created once the first ports exist; the fleet then grows with
	// the network up to MAX_SHIPS on the colonisation tick.
	function finalize(net) {
		if (net.tickScheduled) return net;
		if (net.portCount > 0) {
			const ships = Math.min(INITIAL_SHIPS, Math.max(1, Math.floor(net.portCount / 2)));
			for (let i = 0; i < ships; i++) {
				const port = Math.floor(hash.hash01At(net.seed, TR_CH_SHIP + i) * net.portCount);
				const hull = Math.floor(hash.hash01At(net.seed, TR_CH_SHIP + 64 + i) * HULLS.length);
				spawnShip(net, port, hull, net.time);
			}
		}
		net.tickScheduled = 1;
		queueLib.push(net.queue, net.time + TICK_YEARS, EV_TICK, 0, 0);
		return net;
	}

	function pickDestination(net, from, resource, time) {
		const worth = economy.RESOURCES[resource].worth;
		let best = -1, bestScore = 0;
		for (let i = 0; i < net.portCount; i++) {
			if (i === from) continue;
			const port = net.ports[i];
			if (port.colony.abandoned) continue;
			// The decision reads the world as it is at the event's own clock, not
			// as its last visitor left it — the lazy settle is cheap and exact,
			// and it is what makes a clock jump equal many small steps.
			economy.settleColony(port.colony, time);
			const demand = economy.demandOf(port.colony, resource);
			if (demand <= 0) continue;
			const ly = distanceLy(net, from, i);
			// Routes are interstellar: two colonies of the same star would be a
			// zero-year hop that outbids every real voyage.
			if (ly > MAX_LEG_LY || ly < 1) continue;
			const score = demand * worth / (1 + ly / 100);
			if (score > bestScore) { bestScore = score; best = i; }
		}
		return best;
	}

	// The best (resource, destination, amount) triple a port can sell. The
	// score is the shipment's value over the distance it must fly, so a rich
	// ore field next door beats a rare-element trickle across the arm — and a
	// port with nothing anyone wants waits.
	function pickExport(net, from, hold, time) {
		let bestResource = -1, bestDest = -1, bestAmount = 0, bestScore = 0;
		for (let r = 0; r < economy.RESOURCE_COUNT; r++) {
			if (r === economy.R_PEOPLE) continue;
			const spare = economy.exportableOf(net.ports[from].colony, r);
			if (spare <= 0) continue;
			const dest = pickDestination(net, from, r, time);
			if (dest < 0) continue;
			// Never sail with more than the destination can store: the overflow
			// would ride the hull to the next port and make every later choice
			// read as "no demand".
			const destColony = net.ports[dest].colony;
			const room = destColony.stockCap[r] - destColony.stock[r];
			if (!(room > 1)) continue;
			const want = economy.demandOf(destColony, r) * SHIPMENT_YEARS;
			let amount = spare < hold ? spare : hold;
			if (amount > room) amount = room;
			if (amount > want) amount = want;
			if (amount < 1) continue;
			const ly = distanceLy(net, from, dest);
			const score = amount * economy.RESOURCES[r].worth / (1 + ly / 200);
			if (score > bestScore) {
				bestScore = score;
				bestResource = r;
				bestDest = dest;
				bestAmount = amount;
			}
		}
		exportTriple.resource = bestResource;
		exportTriple.dest = bestDest;
		exportTriple.amount = bestAmount;
		return exportTriple;
	}

	const exportTriple = { resource: -1, dest: -1, amount: 0 };

	function sailTo(net, ship, destPort, time) {
		const port = net.ports[ship.port];
		const dest = net.ports[destPort];
		ship.from = ship.port;
		ship.to = destPort;
		ship.state = SHIP_SAILING;
		ship.depart = time;
		ship.arrive = time + legYears(portDistanceKpc(port, dest), ship.hull);
		ship.port = -1;
		scheduleShip(net, ship, ship.arrive, EV_ARRIVE);
	}

	// The arrival: settle the destination (the brief's "factory works per ship
	// arrive"), deposit what the port can take, and book the loading event.
	// The leftover stays aboard and is offered to the next port.
	function arrive(net, ship, time) {
		const port = net.ports[ship.to];
		economy.settleColony(port.colony, time);
		if (ship.amount > 0 && ship.cargo !== NO_RESOURCE) {
			const given = economy.giveToColony(port.colony, ship.cargo, ship.amount);
			ship.amount -= given;
			net.delivered += given;
			ship.delivered += given;
			port.received += given;
			if (ship.amount <= 0) {
				ship.cargo = NO_RESOURCE;
				ship.amount = 0;
			}
		}
		port.arrivals += 1;
		ship.port = ship.to;
		ship.to = -1;
		ship.state = SHIP_DOCKED;
		ship.trips += 1;
		scheduleShip(net, ship, time + DOCK_YEARS, EV_LOAD);
	}

	function waitAtPort(net, ship, time) {
		ship.state = SHIP_WAITING;
		scheduleShip(net, ship, time + WAIT_YEARS, EV_LOAD);
	}

	function loadAtPort(net, ship, time) {
		const portIndex = ship.port;
		if (portIndex < 0) return;
		const port = net.ports[portIndex];
		economy.settleColony(port.colony, time);
		if (ship.cargo !== NO_RESOURCE && ship.amount > 0) {
			// A leftover cargo the previous port could not take: try the next
			// destination for the same good before loading anything new.
			const dest = pickDestination(net, portIndex, ship.cargo, time);
			if (dest >= 0) { sailTo(net, ship, dest, time); return; }
			// Nobody has room for it. Jettison rather than deadlock the hull with
			// a cargo that every port is already full of; the next load starts
			// clean.
			ship.cargo = NO_RESOURCE;
			ship.amount = 0;
		}
		const pick = pickExport(net, portIndex, ship.hold, time);
		if (pick.resource < 0) { waitAtPort(net, ship, time); return; }
		const taken = economy.takeFromColony(port.colony, pick.resource, pick.amount);
		if (taken <= 0) { waitAtPort(net, ship, time); return; }
		ship.cargo = pick.resource;
		ship.amount = taken;
		sailTo(net, ship, pick.dest, time);
	}

	// --- Colonisation -------------------------------------------------------

	const EXPEDITION_SCRATCH = { port: -1, candidate: -1, score: 0 };
	const EXPEDITION_COST = { people: 0, robots: 0 };

	// A colony sends a share of itself, not a fixed 500 units: a belt outpost
	// of 45 M can seed a neighbour with 40 volunteers, a terran world of 900 M
	// with a few hundred. Floors keep a tiny port from launching on nothing.
	function expeditionCost(colony, out) {
		let people = colony.capacity * 0.15;
		if (people < 40) people = 40;
		if (people > 400) people = 400;
		let robots = colony.capacity * 0.03;
		if (robots < 10) robots = 10;
		if (robots > 100) robots = 100;
		out.people = people;
		out.robots = robots;
	}

	function pickCandidate(net, from) {
		const port = net.ports[from];
		let best = -1, bestScore = 0;
		for (let i = 0; i < net.candidateCount; i++) {
			const c = net.candidates[i];
			if (c.used) continue;
			if (portOfStar(net, c.site.key) >= 0) continue;
			const site = c.site;
			const dx = site.x - port.x, dy = site.y - port.y, dz = site.z - port.z;
			const ly = Math.sqrt(dx * dx + dy * dy + dz * dz) * LY_PER_KPC;
			if (ly > MAX_FOUND_LY) continue;
			const habitat = site.flags & planets.FLAG_TERRAN ? 1
				: (site.flags & planets.FLAG_IN_HZ ? 0.7 : 0.35);
			// Far worlds are the point of an expedition, but a second colony in
			// the same system is still a colony: near sites score low, not zero.
			const score = habitat * (0.6 + ly / 250);
			if (score > bestScore) { bestScore = score; best = i; }
		}
		EXPEDITION_SCRATCH.score = bestScore;
		return best;
	}

	// The best (source, candidate) pair a tick can launch: surplus people and
	// factory cores at the source, an unsettled site in range, and a score that
	// rewards a big population and a habitable, far-away world. Trying every
	// port matters — the largest colony is not always the one with a frontier.
	function bestExpedition(net) {
		let bestPort = -1, bestCandidate = -1, bestScore = 0;
		for (let i = 0; i < net.portCount; i++) {
			const colony = net.ports[i].colony;
			if (colony.abandoned) continue;
			expeditionCost(colony, EXPEDITION_COST);
			const people = economy.exportableOf(colony, economy.R_PEOPLE);
			if (people < EXPEDITION_COST.people) continue;
			if (economy.exportableOf(colony, economy.R_ROBOTS) < EXPEDITION_COST.robots) continue;
			const spare = people / EXPEDITION_COST.people;
			const candidate = pickCandidate(net, i);
			if (candidate < 0) continue;
			const score = (spare > 3 ? 3 : spare) * EXPEDITION_SCRATCH.score;
			if (score > bestScore) { bestScore = score; bestPort = i; bestCandidate = candidate; }
		}
		EXPEDITION_SCRATCH.port = bestPort;
		EXPEDITION_SCRATCH.candidate = bestCandidate;
		return EXPEDITION_SCRATCH;
	}

	// The global tick: grow the fleet toward the port count and launch one
	// colonisation expedition if a port can afford it and a candidate is in
	// range. One expedition per tick keeps the event stream calm; the tick
	// itself is rescheduled from its own time.
	function tick(net, time) {
		const wanted = Math.min(MAX_FREIGHTERS, Math.max(INITIAL_SHIPS, Math.floor(3 + net.portCount * SHIPS_PER_PORT)));
		let freighters = 0;
		for (let i = 0; i < net.shipCount; i++) if (net.ships[i].state !== SHIP_FOUNDING) freighters += 1;
		while (freighters < wanted && net.shipCount < MAX_SHIPS) {
			const port = Math.floor(hash.hash01At(net.seed, TR_CH_SHIP + net.shipCount) * net.portCount);
			const hull = Math.floor(hash.hash01At(net.seed, TR_CH_SHIP + 64 + net.shipCount) * HULLS.length);
			if (spawnShip(net, port, hull, time) < 0) break;
			freighters += 1;
		}
		if (time - net.lastExpedition >= EXPEDITION_INTERVAL) {
			const pick = bestExpedition(net);
			if (pick.port >= 0 && launchExpedition(net, pick.port, pick.candidate, time) >= 0) net.lastExpedition = time;
		}
		net.tickScheduled = 1;
		queueLib.push(net.queue, time + TICK_YEARS, EV_TICK, 0, 0);
	}

	function launchExpedition(net, source, candidateIndex, time) {
		const shipIndex = freeShip(net);
		if (shipIndex < 0) return -1;
		const sourcePort = net.ports[source];
		expeditionCost(sourcePort.colony, EXPEDITION_COST);
		const colonists = economy.takeFromColony(sourcePort.colony, economy.R_PEOPLE, EXPEDITION_COST.people);
		if (colonists < EXPEDITION_COST.people) return -1;
		economy.takeFromColony(sourcePort.colony, economy.R_ROBOTS, EXPEDITION_COST.robots);
		const ship = net.ships[shipIndex];
		const site = net.candidates[candidateIndex].site;
		ship.index = shipIndex;
		ship.hull = 2;
		ship.hold = colonists;
		ship.amount = colonists;
		ship.cargo = economy.R_PEOPLE;
		ship.state = SHIP_FOUNDING;
		ship.port = -1;
		ship.from = source;
		ship.to = -1;
		ship.candidate = candidateIndex;
		ship.depart = time;
		ship.arrive = time + legYears(portDistanceKpc(sourcePort, site), ship.hull);
		ship.revision = 0;
		ship.trips = 0;
		ship.delivered = 0;
		ship.founded = 0;
		scheduleShip(net, ship, ship.arrive, EV_FOUND);
		return shipIndex;
	}

	function foundAtCandidate(net, ship, time) {
		const c = net.candidates[ship.candidate];
		if (!c || c.used) { ship.state = SHIP_WAITING; return; }
		const portIndex = addPort(net, c.site, time);
		if (portIndex < 0) { ship.state = SHIP_WAITING; return; }
		c.used = 1;
		const colony = net.ports[portIndex].colony;
		// The expedition's people are the founding population; the stores it
		// carried become the first stock. No settle: the colony is founded now.
		colony.founded = time;
		colony.last = time;
		colony.pop = ship.amount * POP_PER_COLONIST_UNIT;
		for (let r = 0; r < economy.RESOURCE_COUNT; r++) {
			colony.stock[r] = FOUND_STOCK_FRAC * colony.stockCap[r];
		}
		colony.coverage = 0;
		colony.growth = 0;
		net.founded += 1;
		ship.founded += 1;
		ship.cargo = NO_RESOURCE;
		ship.amount = 0;
		ship.hold = HULLS[ship.hull].hold;
		ship.state = SHIP_DOCKED;
		ship.port = portIndex;
		ship.to = -1;
		ship.candidate = -1;
		scheduleShip(net, ship, time + DOCK_YEARS, EV_LOAD);
	}

	// --- The step -----------------------------------------------------------

	function handleEvent(net, time, kind, ref, revision) {
		net.processed += 1;
		if (kind === EV_TICK) { tick(net, time); return; }
		const ship = net.ships[ref];
		if (!ship || ship.revision !== revision) { net.stale += 1; return; }
		net.lastEvent = time;
		if (kind === EV_ARRIVE) arrive(net, ship, time);
		else if (kind === EV_FOUND) foundAtCandidate(net, ship, time);
		else loadAtPort(net, ship, time);       // EV_LOAD / EV_WAIT
	}

	function step(net, years) {
		if (!(years > 0)) return 0;
		const before = net.processed;
		const target = net.time + years;
		queueLib.drainUntil(net.queue, target, net.handler);
		net.time = target;
		return net.processed - before;
	}

	// --- Draw state and the player -----------------------------------------

	// A ship's position in the birth frame between its endpoints, for the
	// galaxy overlay. `time` is the drawn clock; the caller may interpolate at
	// a readout's instant instead.
	function shipPosition(net, index, time, out) {
		const ship = net.ships[index];
		const a = ship.from >= 0 ? net.ports[ship.from] : null;
		const target = ship.state === SHIP_FOUNDING
			? (ship.candidate >= 0 ? net.candidates[ship.candidate].site : null)
			: (ship.to >= 0 ? net.ports[ship.to] : null);
		if (!a || !target || ship.arrive <= ship.depart) {
			const at = ship.port >= 0 ? net.ports[ship.port] : (a || target);
			out[0] = at ? at.x : 0;
			out[1] = at ? at.y : 0;
			out[2] = at ? at.z : 0;
			return out;
		}
		let f = (time - ship.depart) / (ship.arrive - ship.depart);
		if (f < 0) f = 0;
		if (f > 1) f = 1;
		out[0] = a.x + (target.x - a.x) * f;
		out[1] = a.y + (target.y - a.y) * f;
		out[2] = a.z + (target.z - a.z) * f;
		return out;
	}

	function shipProgress(net, index) {
		const ship = net.ships[index];
		if (ship.arrive <= ship.depart) return 1;
		let f = (net.time - ship.depart) / (ship.arrive - ship.depart);
		return f < 0 ? 0 : (f > 1 ? 1 : f);
	}

	function shipStateName(ship) {
		return SHIP_STATE_NAMES[ship.state];
	}

	// The player's best port at the star it is docked at (none when the star
	// has no colony). The station key is the star's identity key.
	function playerPort(net, starKey) {
		return bestPortOfStar(net, starKey >>> 0);
	}

	// The best export a player can buy, ignoring whether an NPC freighter wants
	// it: the port's spare stock, ranked by value.
	function playerExport(net, portIndex) {
		const colony = net.ports[portIndex].colony;
		let best = -1, bestScore = 0;
		for (let r = 0; r < economy.RESOURCE_COUNT; r++) {
			const spare = economy.exportableOf(colony, r);
			if (spare <= 0) continue;
			const score = spare * economy.RESOURCES[r].worth;
			if (score > bestScore) { bestScore = score; best = r; }
		}
		return best;
	}

	// Load a port's best export into the game-mode hold. The hold is tonnage
	// (`ship.class.cargo`); stock is units, and the resource's unit mass is
	// the one bridge. Returns the shared result record.
	function playerLoad(net, ship, portIndex) {
		PLAYER_RESULT.ok = 0;
		PLAYER_RESULT.resource = -1;
		PLAYER_RESULT.units = 0;
		PLAYER_RESULT.tons = 0;
		PLAYER_RESULT.reason = '';
		if (portIndex < 0) { PLAYER_RESULT.reason = 'no trade port here'; return PLAYER_RESULT; }
		const port = net.ports[portIndex];
		economy.settleColony(port.colony, net.time);
		const carried = ship.cargoResource === undefined ? -1 : ship.cargoResource;
		const resource = playerExport(net, portIndex);
		if (resource < 0) { PLAYER_RESULT.reason = 'nothing to buy'; return PLAYER_RESULT; }
		if (ship.cargo > 0 && carried >= 0 && carried !== resource) {
			PLAYER_RESULT.reason = 'hold carries ' + economy.RESOURCES[carried].name;
			return PLAYER_RESULT;
		}
		const freeTons = ship.class.cargo - ship.cargo;
		const fits = economy.unitsForTons(resource, freeTons);
		if (fits <= 0) { PLAYER_RESULT.reason = 'hold full'; return PLAYER_RESULT; }
		const units = economy.takeFromColony(port.colony, resource, fits);
		if (units <= 0) { PLAYER_RESULT.reason = 'nothing to buy'; return PLAYER_RESULT; }
		const tons = economy.tonsForUnits(resource, units);
		ship.cargo += tons;
		ship.cargoResource = resource;
		PLAYER_RESULT.ok = 1;
		PLAYER_RESULT.resource = resource;
		PLAYER_RESULT.units = units;
		PLAYER_RESULT.tons = tons;
		return PLAYER_RESULT;
	}

	function playerUnload(net, ship, portIndex) {
		PLAYER_RESULT.ok = 0;
		PLAYER_RESULT.resource = -1;
		PLAYER_RESULT.units = 0;
		PLAYER_RESULT.tons = 0;
		PLAYER_RESULT.reason = '';
		if (portIndex < 0) { PLAYER_RESULT.reason = 'no trade port here'; return PLAYER_RESULT; }
		if (!(ship.cargo > 0) || ship.cargoResource === undefined || ship.cargoResource < 0) {
			PLAYER_RESULT.reason = 'hold is empty';
			return PLAYER_RESULT;
		}
		const r = ship.cargoResource;
		const port = net.ports[portIndex];
		economy.settleColony(port.colony, net.time);
		const units = economy.unitsForTons(r, ship.cargo);
		const given = economy.giveToColony(port.colony, r, units);
		const tons = economy.tonsForUnits(r, given);
		ship.cargo -= tons;
		if (ship.cargo < economy.RESOURCES[r].unitMassT) {
			ship.cargo = 0;
			ship.cargoResource = -1;
		}
		PLAYER_RESULT.ok = given > 0 ? 1 : 0;
		PLAYER_RESULT.resource = r;
		PLAYER_RESULT.units = given;
		PLAYER_RESULT.tons = tons;
		if (!PLAYER_RESULT.ok) PLAYER_RESULT.reason = 'port storage full';
		return PLAYER_RESULT;
	}

	const PLAYER_RESULT = { ok: 0, resource: -1, units: 0, tons: 0, reason: '' };

	const DISCOVER_SITE = economy.createSite();

	const TradeLib = {
		MAX_PORTS, MAX_SHIPS, MAX_FREIGHTERS, MAX_CANDIDATES, TRADE_RATES, TRADE_RATE_DEFAULT,
		TRADE_RATE_DEFAULT_INDEX, TRADE_ROUTES_DEFAULT,
		EV_ARRIVE, EV_LOAD, EV_WAIT, EV_FOUND, EV_TICK,
		SHIP_DOCKED, SHIP_SAILING, SHIP_WAITING, SHIP_FOUNDING, SHIP_STATE_NAMES,
		HULLS, DOCK_YEARS, WAIT_YEARS, TICK_YEARS,
		COLONISTS_PER_EXPEDITION, ROBOTS_PER_EXPEDITION, POP_PER_COLONIST_UNIT, EXPEDITION_INTERVAL,
		MAX_FOUND_LY, MAX_LEG_LY, LY_PER_KPC, NO_RESOURCE,
		createNetwork, discoverSystem, settleSystem, finalize, step,
		portIndexOf, candidateIndexOf, bestPortOfStar, distanceLy, legYears,
		shipPosition, shipProgress, shipStateName, playerPort, playerLoad, playerUnload,
	};
	if (typeof module !== 'undefined') module.exports = TradeLib;
	if (typeof window !== 'undefined') window.TradeLib = TradeLib;
})();
