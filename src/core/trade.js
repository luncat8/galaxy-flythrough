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
	const planets = (typeof module !== 'undefined' && module.exports)
		? require('../math/planets.js')
		: window.PlanetsLib;
	const hash = (typeof module !== 'undefined' && module.exports)
		? require('../math/hash.js')
		: window.HashLib;
	const LY_PER_KPC = 3261.563673;

	const PORT_CHANCE = 0.35;           // stars the galaxy has settled at all
	// The start is four colonies: the capital beside home and three more from
	// the nearest settled-roll stars. Expeditions grow the network toward
	// MAX_PORTS, so the viewer watches the net expand instead of arriving into
	// a finished one.
	const SEED_PORTS = 4;
	const MAX_PORTS = 64;
	const MAX_WORLDS_PER_STAR = 6;
	const MAX_WORLDS = MAX_PORTS * MAX_WORLDS_PER_STAR;
	const MIN_FOUND_COUPLE = 0.08;
	// The hard cap counts every ship, including an expedition in flight; the
	// freighter fleet keeps its own smaller target so a founder always has a
	// slot to come home to. A port is served by ~1.5 hulls: at 64 ports and
	// 2–4 ly/year, that is a visit every century or two, which is what the
	// 150-year warehouses are sized for.
	const MAX_SHIPS = 128;
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

	// A founding voyage always flies the clipper: the one hull that can carry a
	// party far enough, and the one whose intercept the launch plan solves for.
	const EXPEDITION_HULL = 2;

	const DOCK_YEARS = 0.5;             // unload → load
	const WAIT_YEARS = 2;               // retry a port with no cargo
	// A hull with nothing to carry polls. At a fast clock a 2-year poll is a
	// thousand events a second per idle ship, and a saturated network has many
	// idle ships: the retry interval doubles up to this ceiling and a load
	// resets it, so a quiet network is quiet and a busy one is responsive.
	const WAIT_YEARS_MAX = 500;
	const TICK_YEARS = 25;              // colonisation check
	const FIRST_LOAD_YEARS = 0.5;
	// A colony can send a wave a few centuries of flight away. 300 ly was the
	// designed range, but the local sky is a sparse sample: the landmark shell
	// ends around 120 ly and the next worlds sit at 300–600 ly, so a 300 ly
	// range left every port without a reachable candidate at 14–17 colonies.
	// 600 ly is a 1.5–3 s voyage for a freighter, and it lets the frontier
	// chain through the sampled field instead of stopping at the named sky.
	const MAX_FOUND_LY = 600;
	const POP_PER_COLONIST_UNIT = 0.004; // 1 unit → 4 000 people
	// A founding expedition is a share of the source's *population*, not a
	// warehouse good. The authored colony economy made "colonists" a produced
	// resource and "factory cores" a consumed one, so on the start map only
	// one colony in fourteen had both spare: the network reached 14 ports and
	// stood there for minutes (trade-plan §3.2). People are the one cost every
	// thriving world can pay; the factory cores are its own industry's product,
	// not a stock gate.
	const VOLUNTEER_FRAC = 0.02;         // of the source's population
	const FOUNDERS_MIN_M = 0.5;          // million people in a wave
	const FOUNDERS_MAX_M = 4.0;
	const MIN_FOUNDERS_REMAIN_M = 2.0;   // the source keeps a working population
	// One port sponsors at most one expedition per cooldown. At the default
	// 100 y/s this is the expansion's period: a network's ports double their
	// number roughly every 1 000–1 200 years, which is a wave every ~10 s and
	// a full 64-port scenario inside a minute, instead of a plateau at 14.
	const EXPEDITION_COOLDOWN = 900;    // years per port
	// Foundings in flight are capped so a large network does not spend its
	// whole hull budget on expeditions and starve the freight routes. The cap
	// is well above a seed wave (three big ports at t = 0) and far below the
	// 128-hull budget, so a doubling never locks the routes out of ships.
	const MAX_FOUNDING_IN_FLIGHT = 24;
	const INITIAL_SHIPS = 12;
	const SHIPS_PER_PORT = 1.5;
	const MAX_LEG_LY = 3000;
	// The capital's reach: a habitable world this close to the viewer's home is
	// in sight from the starting orbit, so the first thing the overlay shows is
	// a colony rather than an empty patch of sky.
	const HOME_COLONY_LY = 20;
	const HOME_COLONY_KPC = HOME_COLONY_LY / LY_PER_KPC;
	// The start map's reach: the named sky plus the rendered field this close
	// to home (trade-plan §8). The field sample has no star nearer than ~300 ly,
	// so the nearest colonies are landmarks and the field is the far frontier.
	const START_RADIUS_KPC = 1.2;
	const START_FIELD = 400;

	// --- Clocks (trade-plan §6) --------------------------------------------
	// The trade clock may ride the star clock, but the two cannot share a
	// *year*: the network's authored cadence is tens of years per event (a
	// 25-year tick, 150-year warehouses, a 40-year population e-folding),
	// while the star clock runs at millions of years per second. At a 1:1
	// exchange a 2 Myr/s sky asks the queue for 2·10⁶ years of voyages per
	// wall second — measured at 313 ms of CPU per frame (~18 s per wall
	// second, 51 000 events a frame), i.e. a frozen page. So the sync is a
	// *rate*, not an identity: one trade year per
	// 1 000 star years. The star slider's fine range then lands on the trade
	// ladder the network is tuned against — 0.1 Myr/s is the 100 y/s default
	// pace, 2 Myr/s is the 2 000 y/s top — and the coupling is exact over
	// the whole fine range.
	const SYNC_YEARS_PER_MYR = 1000;
	// The hard ceiling on the effective clock, whatever the coupling asks
	// for. The rate is the workload (one drained event per arrive/load), and
	// above the ladder's top the queue costs more than a frame. The wide
	// star range (up to 99 Myr/s) exceeds it, and the readout says so.
	const RATE_MAX = 2000;
	// The special mode's generation ship: 1 light-year per 33 trade years,
	// read at the default pace. The mode syncs to the default star rate, so
	// 1 000 trade years pass per wall second and the ship covers 30 ly per
	// wall second: the start map's nearest hop (~25 ly) takes under a second,
	// a 300 ly frontier hop 10 s, and the 600 ly maximum 20 s. A pace for this
	// scenario, not a fraction of c; the freighter is still 70–150× faster.
	// The first calibration (1 ly per 400 years) took 10 s for the nearest hop
	// and 76 s for the median, and made the mode look stalled.
	const GENERATION_LY_PER_YEAR = 3e-2;
	// The star-clock rung the generation mode syncs to (Myr/s): the default.
	const GENERATION_STAR_MYR = 1;
	// The legibility floor on any voyage. A 10 ly freighter hop is 2–5 trade
	// years, which at the 100 y/s default is a few frames — it reads as a
	// teleport. Half a wall second per hop keeps the hulls visibly in flight.
	const MIN_LEG_YEARS = 50;
	// ...and a fleet that slow needs a matching warehouse. The colony economy
	// is authored in years of its own throughput (a 150-year reserve, a 20-year
	// supply buffer); with 10 000-year voyages a port would starve between two
	// arrivals, growth would stall below the big-colony gate and the special
	// mode would show a dying network instead of a slow one. The horizon moves
	// to 5 000 years, half the nearest hop: measured on the start map, coverage
	// holds at 0.47 over a minute. Nothing else about the warehouse law changes.
	const GENERATION_RESERVE_YEARS = 5000;
	let generationMode = 0;
	// Expansion authority (W6): armed by default, so the scenario behaves as
	// before. Disarmed, the freight fleet keeps flying and the arrivals keep
	// coming — only new colonies stop. One flag beside generationMode.
	let expansionOn = 1;

	// A shipment is sized to the destination's draw, not to the hold: a hold
	// that arrives full at a port which can take a tenth of it parks the rest
	// in orbit and starves the next port on the list.
	const SHIPMENT_YEARS = 150;

	// Hash streams beyond the economy's own.
	const TR_CH_SHIP = 740, TR_CH_PORT = 760;

	// --- The network's log (W2) --------------------------------------------
	// One bounded ring, written at settle boundaries and event handlers only.
	// Entries carry indices and years, never strings: the panel turns them into
	// text at 4 Hz, which is the one place allowed to allocate.
	const LOG_CAP = 64;
	const LOG_FOUND = 0, LOG_MILESTONE = 1, LOG_FAMINE = 2, LOG_FAMINE_END = 3,
		LOG_OUTPOST = 4, LOG_ROUTE = 5, LOG_EXPEDITION = 6;

	function createLog() {
		return {
			time: new Float64Array(LOG_CAP),
			kind: new Uint8Array(LOG_CAP),
			a: new Int32Array(LOG_CAP),
			b: new Int32Array(LOG_CAP),
			c: new Int32Array(LOG_CAP),
			head: 0,
			count: 0,
		};
	}

	function pushLog(net, kind, a, b, c) {
		const log = net.log;
		const i = log.head;
		log.time[i] = net.time;
		log.kind[i] = kind;
		log.a[i] = a;
		log.b[i] = b;
		log.c[i] = c === undefined ? 0 : c;
		log.head = (i + 1) % LOG_CAP;
		if (log.count < LOG_CAP) log.count += 1;
	}

	function logLength(net) {
		return net.log.count;
	}

	// One entry by age, 0 = oldest. The record is the module scratch.
	const LOG_ENTRY = { time: 0, kind: 0, a: 0, b: 0, c: 0 };
	function logAt(net, age) {
		const log = net.log;
		const n = log.count;
		if (!(age >= 0 && age < n)) return null;
		const i = (log.head - n + age + LOG_CAP * 2) % LOG_CAP;
		LOG_ENTRY.time = log.time[i];
		LOG_ENTRY.kind = log.kind[i];
		LOG_ENTRY.a = log.a[i];
		LOG_ENTRY.b = log.b[i];
		LOG_ENTRY.c = log.c[i];
		return LOG_ENTRY;
	}

	function createWorld() {
		const world = economy.createColony();
		world.port = -1;
		world.slot = -1;
		return world;
	}

	function createPort() {
		const fold = economy.createColony();
		const worldIdx = new Int32Array(MAX_WORLDS_PER_STAR);
		worldIdx.fill(-1);
		const lift = new Float64Array(MAX_WORLDS_PER_STAR);
		lift.fill(1);
		const access = new Float64Array(MAX_WORLDS_PER_STAR);
		access.fill(1);
		const couple = new Float64Array(MAX_WORLDS_PER_STAR * MAX_WORLDS_PER_STAR);
		couple.fill(1);
		return {
			fold,
			colony: fold,
			worldIdx,
			worldCount: 0,
			well: new Float64Array(MAX_WORLDS_PER_STAR),
			land: new Float64Array(MAX_WORLDS_PER_STAR),
			lift,
			access,
			dv: new Float64Array(MAX_WORLDS_PER_STAR * MAX_WORLDS_PER_STAR),
			tH: new Float64Array(MAX_WORLDS_PER_STAR * MAX_WORLDS_PER_STAR),
			couple,
			key: 0, name: '', kind: 0, index: 0,
			arrivals: 0, received: 0,
			// Trade years of the last sponsored expedition; `-INF` marks a seed
			// port, ready as soon as its colony passes the big gate.
			lastExpedition: -1e9,
			// Set once when its colony fails: a port slot is identity, so the
			// demoted port keeps its key and place and is only counted once.
			demoted: 0,
			x: 0, y: 0, z: 0,
			ref: { kind: 0, index: 0, key: 0, x: 0, y: 0, z: 0, colorIndex: 0, absMag: 0 },
		};
	}

	function createShip() {
		return {
			index: 0, hull: 0, hold: 0, cargo: NO_RESOURCE, amount: 0,
			state: SHIP_DOCKED, port: -1, from: -1, to: -1, candidate: -1,
			depart: 0, arrive: 0, leg: 0, revision: 0, trips: 0, delivered: 0, founded: 0, waits: 0,
			// The chord the overlay draws the hull on: `from`'s live position at
			// fraction 0, `to`'s at 1. An ordinary voyage runs 0 → 1; a diverted
			// one runs from where the hull turned back to 0 (§9.4), which is what
			// keeps the dot from teleporting to the far end of its own route.
			legFrom: 0, legTo: 1, returning: 0,
		};
	}

	function createCandidate() {
		return { site: economy.createSite(), used: 0, reserved: -1 };
	}

	function createNetwork(options) {
		const seed = (options && options.seed) | 0;
		const time = (options && options.timeYears) || 0;
		const net = {
			seed,
			modelSeed: options && options.modelSeed !== undefined ? options.modelSeed | 0 : seed,
			// The viewer's home position, and the port that became the network's
			// capital: the first habitable world found near it. Arriving at a
			// colony with its freighters in sight is the difference between a
			// live economy and an empty sky (trade-plan §3), and it gives H a
			// destination that is not the Sun's empty system.
			homeX: options && options.homeX ? +options.homeX : 0,
			homeY: options && options.homeY ? +options.homeY : 0,
			homeZ: options && options.homeZ ? +options.homeZ : 0,
			capital: -1,
			time,
			// Trade years the clock is behind the rate it was asked for: a
			// budget-limited drain leaves the queue due, and this is what the
			// panel reports instead of pretending the clock kept up.
			lag: 0,
			queue: queueLib.createExecQueue(256),
			portCount: 0,
			worldCount: 0,
			// Failed colonies still own their slots; this is how many of the
			// ports are outposts (W1). `livePortCount` is the panel's number.
			outposts: 0,
			seedPorts: SEED_PORTS,
			shipCount: 0,
			candidateCount: 0,
			log: createLog(),
			routes: createRoutes(),
			discovered: new Set(),
			ports: [],
			worlds: [],
			ships: [],
			candidates: [],
			processed: 0,
			stale: 0,
			founded: 0,
			delivered: 0,
			lastEvent: 0,
			tickScheduled: 0,
			// Ring cursor of the frontier scan (a field index), so repeated
			// ticks walk the whole field instead of re-testing its head.
			frontierCursor: 0,
			// Voyages turned around by the sky (§9.4): the count the panel shows
			// when the network's routes are being torn faster than they are flown.
			diverted: 0,
			// The live-geometry cache (§9.1) and the two resolvers the app wires:
			// where an endpoint is drawn now, and where it will be drawn at a
			// star time the booking asks about. Without them the network measures
			// the birth sky, exactly as it did before this pass.
			geom: createGeometry(),
			handler: null,
		};
		for (let i = 0; i < MAX_PORTS; i++) net.ports.push(createPort());
		for (let i = 0; i < MAX_WORLDS; i++) net.worlds.push(createWorld());
		for (let i = 0; i < MAX_SHIPS; i++) net.ships.push(createShip());
		for (let i = 0; i < MAX_CANDIDATES; i++) net.candidates.push(createCandidate());
		// The drain's callback: one closure per network, never per event.
		net.handler = (time, kind, ref, revision) => handleEvent(net, time, kind, ref, revision);
		net.livePosition = options && options.livePosition ? options.livePosition : null;
		net.predictPosition = options && options.predictPosition ? options.predictPosition : null;
		return net;
	}

	// --- Worlds and the port fold (T2, T3) ----------------------------------

	const PORT_WORLDS = new Array(MAX_WORLDS_PER_STAR);
	const POP_WEIGHT = new Float64Array(MAX_WORLDS_PER_STAR);
	const POP_CAP = new Float64Array(MAX_WORLDS_PER_STAR);

	function fillPortWorlds(net, port) {
		const n = port.worldCount;
		for (let s = 0; s < n; s++) PORT_WORLDS[s] = net.worlds[port.worldIdx[s]];
		return n;
	}

	function worldOfPort(net, portIndex, slot) {
		if (!(portIndex >= 0 && portIndex < net.portCount)) return null;
		const port = net.ports[portIndex];
		if (!(slot >= 0 && slot < port.worldCount)) return null;
		return net.worlds[port.worldIdx[slot]];
	}

	function worldOfSite(net, portIndex, kind, index) {
		if (!(portIndex >= 0 && portIndex < net.portCount)) return -1;
		const port = net.ports[portIndex];
		for (let s = 0; s < port.worldCount; s++) {
			const w = net.worlds[port.worldIdx[s]];
			if (w.kind === kind && w.index === index) return s;
		}
		return -1;
	}

	function foldPort(net, index) {
		const port = net.ports[index];
		const n = port.worldCount;
		if (n === 0) return port.colony;
		// A one-world port IS that world (identity, bit-exact, zero fold cost).
		if (n === 1) {
			port.colony = net.worlds[port.worldIdx[0]];
			return port.colony;
		}
		fillPortWorlds(net, port);
		port.colony = economy.foldColonies(port.fold, PORT_WORLDS, n);
		return port.colony;
	}

	function distributePortInbound(net, index, r, units) {
		const port = net.ports[index];
		const n = fillPortWorlds(net, port);
		return economy.distributeInbound(port.colony, PORT_WORLDS, n, r, units);
	}

	function collectPortOutbound(net, index, r, units) {
		const port = net.ports[index];
		const n = fillPortWorlds(net, port);
		return economy.collectOutbound(port.colony, PORT_WORLDS, n, r, units, port.lift);
	}

	function takePortPopulation(net, index, peopleM) {
		if (!(peopleM > 0)) return 0;
		const port = net.ports[index];
		const n = port.worldCount;
		if (n === 0) return 0;
		if (n === 1) {
			const w0 = net.worlds[port.worldIdx[0]];
			w0.pop -= peopleM;
			return peopleM;
		}
		let popSum = 0, lastLive = -1;
		for (let s = 0; s < n; s++) {
			const w = net.worlds[port.worldIdx[s]];
			if (w.outpost || !(w.pop > 0)) continue;
			popSum += w.pop;
			lastLive = s;
		}
		if (!(popSum > 0) || lastLive < 0) return 0;
		const take = peopleM < popSum ? peopleM : popSum;
		let assigned = 0;
		for (let s = 0; s < n; s++) {
			const w = net.worlds[port.worldIdx[s]];
			if (w.outpost || !(w.pop > 0)) continue;
			const part = s === lastLive ? take - assigned : take * (w.pop / popSum);
			w.pop = w.pop > part ? w.pop - part : 0;
			assigned += part;
		}
		foldPort(net, index);
		return take;
	}

	function givePortPopulation(net, index, peopleM) {
		if (!(peopleM > 0)) return 0;
		const port = net.ports[index];
		const n = port.worldCount;
		if (n === 0) return 0;
		if (n === 1) {
			const w0 = net.worlds[port.worldIdx[0]];
			const before = w0.pop;
			w0.pop = Math.min(w0.capacity, w0.pop + peopleM);
			return w0.pop - before;
		}
		let roomSum = 0, lastLive = -1;
		for (let s = 0; s < n; s++) {
			const w = net.worlds[port.worldIdx[s]];
			if (w.outpost) { POP_CAP[s] = 0; continue; }
			const room = w.capacity - w.pop;
			POP_CAP[s] = room > 0 ? room : 0;
			if (POP_CAP[s] > 0) { roomSum += POP_CAP[s]; lastLive = s; }
		}
		if (!(roomSum > 0) || lastLive < 0) return 0;
		const give = peopleM < roomSum ? peopleM : roomSum;
		let assigned = 0;
		for (let s = 0; s < n; s++) {
			if (!(POP_CAP[s] > 0)) continue;
			const w = net.worlds[port.worldIdx[s]];
			const part = s === lastLive ? give - assigned : give * (POP_CAP[s] / roomSum);
			w.pop = Math.min(w.capacity, w.pop + part);
			assigned += part;
		}
		foldPort(net, index);
		return give;
	}

	// --- Lookups ------------------------------------------------------------

	// A slot exists for this star, live or outpost. This is the "can this star
	// be settled" test: a dead colony still owns its star, so no expedition or
	// player ever lands a second one on it.
	function portOfStar(net, key) {
		const k = key >>> 0;
		for (let i = 0; i < net.portCount; i++) if (net.ports[i].key === k) return i;
		return -1;
	}

	// A live colony (not an outpost) at this star. The trade-facing lookup.
	function portOfStarLive(net, key) {
		const k = key >>> 0;
		for (let i = 0; i < net.portCount; i++) {
			const port = net.ports[i];
			if (port.key === k && !port.colony.outpost) return i;
		}
		return -1;
	}

	function livePortCount(net) {
		return net.portCount - net.outposts;
	}

	function portIndexOf(net, key, kind, index) {
		const n = net.portCount;
		for (let i = 0; i < n; i++) {
			const p = net.ports[i];
			if (p.key !== key) continue;
			if (worldOfSite(net, i, kind, index) >= 0) return i;
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

	// The player's port at a star, outposts included: "no port here" is a lie
	// about a star that has a dead colony on it. The transfer helpers refuse an
	// outpost with their own reason (W1), so the port still resolves.
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

	// The distance the network acts on between two ports: the drawn one while
	// the sky moves, the birth one otherwise (which is then the drawn one).
	function distanceLy(net, a, b) {
		return endpointDistanceLy(net, END_PORT, a, END_PORT, b);
	}

	// A port's drawn position: the star's live drawn position when a live
	// position resolver is wired (the stars move with star time), else the
	// birth position the port was settled at. `ref` is the port's identity;
	// the fallbacks are the cached birth coordinates.
	function positionOf(net, ref, fx, fy, fz, out) {
		if (net.livePosition && net.livePosition(ref, out)) return out;
		out[0] = fx; out[1] = fy; out[2] = fz;
		return out;
	}

	// --- Live geometry (trade-plan §9) --------------------------------------
	//
	// Every decision the network makes is a distance, and while the star clock
	// runs the stars those distances were measured between are not where they
	// were born: differential rotation stretches a 1 000 ly pair to 6 000 ly in
	// a minute at the default 1 Myr/s (§9's table). One cache, refreshed on the
	// maintenance pass the network already runs, holds the drawn position of
	// every port and candidate and the rate each is moving at. Scoring reads the
	// cache and never the resolver — a load decision scores 64 ports against 13
	// resources, which is 800 dispatches it must not make. A frozen sky skips
	// the layer entirely, so the birth frame costs nothing and behaves exactly
	// as the network §1–§8 measured.
	const GEOM_BIRTH = 0, GEOM_LIVE = 1;
	const END_PORT = 0, END_CANDIDATE = 1;

	function createGeometry() {
		return {
			// The sky moves, and a resolver is wired to see it.
			moving: 0,
			// Star Myr per trade year: the exchange rate a prediction horizon is
			// bought with (§9.2). Zero when either clock is stopped or the app
			// cannot say — which leaves the booking a straight aim and §9.4's
			// pursuit the rest of the voyage.
			myrPerYear: 0,
			starTime: 0,
			version: 0,
			// Ports the resolver could not place (not resident, not tracked).
			blind: 0,
			hasRate: 0,
			portPos: new Float64Array(MAX_PORTS * 3),
			portVel: new Float64Array(MAX_PORTS * 3),
			portQ: new Uint8Array(MAX_PORTS),
			candPos: new Float64Array(MAX_CANDIDATES * 3),
			candVel: new Float64Array(MAX_CANDIDATES * 3),
			candQ: new Uint8Array(MAX_CANDIDATES),
		};
	}

	const GEOM_POS = [0, 0, 0];

	// One endpoint of the cache. `live` is the resolver's answer; a blind entry
	// keeps its birth coordinates and *no rate* — a position that flickers
	// between drawn and birth would otherwise read as a velocity of thousands
	// of ly per year and make every partner look unreachable.
	function fillEndpoint(net, pos, vel, quality, i, ref, bx, by, bz, invDt) {
		const o = i * 3;
		const wasLive = quality[i] === GEOM_LIVE;
		const ox = pos[o], oy = pos[o + 1], oz = pos[o + 2];
		const live = net.livePosition(ref, GEOM_POS) ? 1 : 0;
		quality[i] = live ? GEOM_LIVE : GEOM_BIRTH;
		if (live) {
			pos[o] = GEOM_POS[0]; pos[o + 1] = GEOM_POS[1]; pos[o + 2] = GEOM_POS[2];
		} else {
			pos[o] = bx; pos[o + 1] = by; pos[o + 2] = bz;
		}
		if (invDt !== 0 && live && wasLive) {
			vel[o] = (pos[o] - ox) * invDt;
			vel[o + 1] = (pos[o + 1] - oy) * invDt;
			vel[o + 2] = (pos[o + 2] - oz) * invDt;
		} else {
			vel[o] = 0; vel[o + 1] = 0; vel[o + 2] = 0;
		}
		return live;
	}

	// The maintenance pass's geometry refresh. `moving` is the app's answer to
	// "does the sky move", `myrPerYear` its exchange rate between the two
	// clocks; both are the app's to know, not the network's (§9.2).
	function refreshGeometry(net, starTimeMyr, moving, myrPerYear) {
		const geom = net.geom;
		const time = starTimeMyr > 0 ? starTimeMyr : 0;
		geom.moving = moving && net.livePosition ? 1 : 0;
		geom.myrPerYear = myrPerYear > 0 ? myrPerYear : 0;
		geom.version += 1;
		if (!geom.moving) {
			geom.starTime = time;
			geom.hasRate = 0;
			geom.blind = 0;
			return geom.version;
		}
		const dt = time - geom.starTime;
		// A backwards jump (a preset epoch, a seek) has no honest rate: drop the
		// velocities and let the next refresh re-derive them.
		const invDt = dt > 1e-9 ? 1 / dt : 0;
		// The clock the resolvers read is this refresh's, not the last one's.
		geom.starTime = time;
		let blind = 0;
		for (let i = 0; i < net.portCount; i++) {
			const port = net.ports[i];
			if (!fillEndpoint(net, geom.portPos, geom.portVel, geom.portQ, i,
				port.ref, port.x, port.y, port.z, invDt)) blind += 1;
		}
		for (let i = 0; i < net.candidateCount; i++) {
			const site = net.candidates[i].site;
			fillEndpoint(net, geom.candPos, geom.candVel, geom.candQ, i,
				site.ref, site.x, site.y, site.z, invDt);
		}
		geom.blind = blind;
		geom.hasRate = invDt !== 0 ? 1 : 0;
		return geom.version;
	}

	function endpointRef(net, kind, index) {
		return kind === END_PORT ? net.ports[index].ref : net.candidates[index].site.ref;
	}

	// The position every distance in the network is measured from.
	const END_A = [0, 0, 0], END_B = [0, 0, 0];
	function endpointPos(net, kind, index, out) {
		const geom = net.geom;
		if (!geom.moving) {
			const site = kind === END_PORT ? net.ports[index] : net.candidates[index].site;
			out[0] = site.x; out[1] = site.y; out[2] = site.z;
			return out;
		}
		const pos = kind === END_PORT ? geom.portPos : geom.candPos;
		const o = index * 3;
		out[0] = pos[o]; out[1] = pos[o + 1]; out[2] = pos[o + 2];
		return out;
	}
	function endpointIsLive(net, kind, index) {
		if (!net.geom.moving) return 1;
		const q = kind === END_PORT ? net.geom.portQ : net.geom.candQ;
		return q[index] === GEOM_LIVE ? 1 : 0;
	}

	function separationLy(ax, ay, az, bx, by, bz) {
		const dx = (ax - bx) * LY_PER_KPC, dy = (ay - by) * LY_PER_KPC, dz = (az - bz) * LY_PER_KPC;
		return Math.sqrt(dx * dx + dy * dy + dz * dz);
	}

	function endpointDistanceLy(net, kindA, indexA, kindB, indexB) {
		endpointPos(net, kindA, indexA, END_A);
		endpointPos(net, kindB, indexB, END_B);
		return separationLy(END_A[0], END_A[1], END_A[2], END_B[0], END_B[1], END_B[2]);
	}

	// The hull's speed in ly per trade year: the authored table, or the
	// generation crawl while the special mode is on.
	function hullSpeed(hullIndex) {
		return generationMode ? GENERATION_LY_PER_YEAR : HULLS[hullIndex].lyPerYear;
	}

	// THE trade-clock law: a leg's length in trade years. Speed is the hull's
	// authored `lyPerYear`, or the generation-ship pace (1 ly per 33 y)
	// while the special trade mode is on. The floor keeps two ports at one
	// coordinate from making a zero-length voyage (a zero-length event would
	// let a ship cycle forever inside one step), and keeps a short hop visible.
	function legYears(distanceKpc, hullIndex) {
		return legYearsLy(distanceKpc * LY_PER_KPC, hullIndex);
	}
	function legYearsLy(distanceLy, hullIndex) {
		const years = distanceLy / hullSpeed(hullIndex);
		return years > MIN_LEG_YEARS ? years : MIN_LEG_YEARS;
	}

	// Years of trade time per wall second, for the two ways the clock can be
	// driven: the panel's own ladder, or the star clock through the sync rate.
	// Zero is a real pause (and a negative star rate — the observer's fly
	// coupling — never runs the network backwards).
	function clockRate(ladderYears, starRateMyrPerS, synced) {
		const years = synced ? starRateMyrPerS * SYNC_YEARS_PER_MYR : ladderYears;
		if (!(years > 0)) return 0;
		return years < RATE_MAX ? years : RATE_MAX;
	}

	// --- The leg a hull actually flies (trade-plan §9.3) ---------------------
	//
	// Two laws, one after the other. The *plan* is the linear intercept: where a
	// uniformly moving endpoint is when the hull gets there, from the cached
	// positions and the cached rates. It is exact for uniform relative motion,
	// which half a second of sky is, and it costs no resolver call — so scoring
	// can ask it about every partner at once and a partner that recedes faster
	// than the hull flies is refused before it is ever booked. The *booking*
	// then re-solves the winner against the real law, by fixed-point iteration
	// on the predictor the app wires for closed-form masks and for the friction
	// field's tracked mirror; with no predictor the plan is the answer and §9.4's
	// pursuit owns the voyage.
	const INTERCEPT_ITERS = 6;
	const INTERCEPT_TOL_LY = 0.5;
	// A voyage in flight is turned around when the sky has stretched it this far
	// past the cap it was booked under (§9.4). The margin is the hysteresis
	// between "the destination drifted" and "the route is gone".
	const DIVERT_FACTOR = 1.6;
	const PLAN_A = [0, 0, 0], PLAN_B = [0, 0, 0];

	function createLegPlan() {
		return { years: 0, ly: 0, reachable: 0, predicted: 0, outrun: 0 };
	}
	const LEG_PLAN = createLegPlan();

	// The radial rate at which two endpoints separate, in ly per trade year:
	// their cached velocities (kpc per star Myr) projected on the line between
	// them, through the app's exchange rate. Zero for a blind endpoint, a frozen
	// sky, or decoupled clocks — all three of which leave the plan the plain
	// separation, which is what the network measured before this pass.
	function endpointRecession(net, kindA, indexA, kindB, indexB, a, b, ly) {
		const geom = net.geom;
		if (!geom.moving || !(geom.myrPerYear > 0) || !geom.hasRate || !(ly > 1e-9)) return 0;
		const va = kindA === END_PORT ? geom.portVel : geom.candVel;
		const vb = kindB === END_PORT ? geom.portVel : geom.candVel;
		const oa = indexA * 3, ob = indexB * 3;
		const inv = LY_PER_KPC / ly;
		const ux = (b[0] - a[0]) * inv, uy = (b[1] - a[1]) * inv, uz = (b[2] - a[2]) * inv;
		const rdot = (vb[ob] - va[oa]) * ux + (vb[ob + 1] - va[oa + 1]) * uy
			+ (vb[ob + 2] - va[oa + 2]) * uz;
		return rdot * LY_PER_KPC * geom.myrPerYear;
	}

	// The linear intercept plan for one leg, against `capLy` (MAX_LEG_LY for
	// freight, MAX_FOUND_LY for a founding). Fills and returns `out`.
	function planLeg(net, kindA, indexA, kindB, indexB, hullIndex, capLy, out) {
		const plan = out || LEG_PLAN;
		endpointPos(net, kindA, indexA, PLAN_A);
		endpointPos(net, kindB, indexB, PLAN_B);
		const ly = separationLy(PLAN_A[0], PLAN_A[1], PLAN_A[2], PLAN_B[0], PLAN_B[1], PLAN_B[2]);
		const speed = hullSpeed(hullIndex);
		plan.predicted = 0;
		plan.outrun = 0;
		plan.ly = ly;
		plan.years = legYearsLy(ly, hullIndex);
		plan.reachable = ly <= capLy ? 1 : 0;
		if (!plan.reachable || !net.geom.moving) return plan;
		const rdot = endpointRecession(net, kindA, indexA, kindB, indexB, PLAN_A, PLAN_B, ly);
		const closing = speed - rdot;
		// The endpoint outruns the hull: there is no meeting point, however long
		// the voyage is booked for. Refusing it is the honest reading of a sky
		// that shears faster than the fleet flies. `outrun` is the one refusal a
		// voyage in flight cannot argue with — distance past the cap is a
		// booking rule with a margin, this one is geometry.
		if (!(closing > 1e-9)) { plan.reachable = 0; plan.outrun = 1; return plan; }
		const years = ly / closing;
		plan.years = years > MIN_LEG_YEARS ? years : MIN_LEG_YEARS;
		// What the hull has to cross is where the endpoint is at *arrival*, not
		// the separation at departure: that is the number the cap means.
		plan.ly = ly + rdot * plan.years;
		plan.reachable = plan.ly <= capLy ? 1 : 0;
		return plan;
	}

	// The booking solve: the intercept re-measured against the law instead of its
	// linearisation. The measurement is the *separation between the two endpoints
	// at the arrival instant* — not the hull's inertial chord — because the trade
	// clock is not the sky's: a hull at 2–4.5 ly per trade year cannot keep up
	// with a disc rotating at ~750, and reading the leg in the inertial frame
	// would make every route in the galaxy unreachable within a Myr, including
	// between two stars that never move apart. In the field's own frame a rigid
	// rotation changes nothing (a route between co-rotating stars is the distance
	// between them) and the only thing that stretches a leg is the differential
	// drift, which is exactly what tears routes apart.
	//
	// `remainingFrac` is the part of the chord still ahead of the hull: 1 at
	// departure, `|legTo − u|` when a voyage is re-aimed in flight (§9.4), so the
	// same solve books a leg, re-aims it, and measures the way home after a
	// divert. Both endpoints are predicted at the *same* star time, which is what
	// cancels the common motion.
	const SOLVE_A = [0, 0, 0], SOLVE_B = [0, 0, 0];
	// Bookings pay for the full solve; a re-aim, which runs twice a second and is
	// corrected again on the next pass, pays for two iterations. On the friction
	// field one prediction is ~2.7 µs (a derive plus a few substeps), so the
	// difference is 128 hulls' worth of frame time.
	const RETIME_ITERS = 2;
	function solveRemaining(net, kindA, indexA, kindB, indexB, remainingFrac, hullIndex, capLy, out, iters) {
		const plan = out || LEG_PLAN;
		endpointPos(net, kindA, indexA, SOLVE_A);
		endpointPos(net, kindB, indexB, SOLVE_B);
		let sep = separationLy(SOLVE_A[0], SOLVE_A[1], SOLVE_A[2], SOLVE_B[0], SOLVE_B[1], SOLVE_B[2]);
		let ly = sep * remainingFrac;
		let years = legYearsLy(ly, hullIndex);
		plan.predicted = 0;
		plan.outrun = 0;
		const predictor = net.predictPosition;
		const geom = net.geom;
		if (predictor && geom.moving && geom.myrPerYear > 0
			&& endpointIsLive(net, kindA, indexA) && endpointIsLive(net, kindB, indexB)) {
			const refA = endpointRef(net, kindA, indexA);
			const refB = endpointRef(net, kindB, indexB);
			let previous = ly;
			const rounds = iters === undefined ? INTERCEPT_ITERS : iters;
			for (let k = 0; k < rounds; k++) {
				const at = geom.starTime + years * geom.myrPerYear;
				// A refused horizon (the friction field's bound) leaves the straight
				// aim standing: pursuit re-aims it twice a second anyway.
				if (!predictor(refA, at, SOLVE_A) || !predictor(refB, at, SOLVE_B)) break;
				plan.predicted = 1;
				sep = separationLy(SOLVE_A[0], SOLVE_A[1], SOLVE_A[2], SOLVE_B[0], SOLVE_B[1], SOLVE_B[2]);
				const next = sep * remainingFrac;
				// A leg that grows while the hull closes on it is a target the hull
				// cannot catch: the iteration runs away instead of settling.
				if (k > 0 && next > previous && next > capLy) plan.outrun = 1;
				previous = next;
				const settled = Math.abs(next - ly) <= INTERCEPT_TOL_LY;
				ly = next;
				years = legYearsLy(ly, hullIndex);
				if (settled) break;
			}
		}
		plan.ly = ly;
		plan.years = years;
		plan.reachable = plan.outrun ? 0 : (ly <= capLy ? 1 : 0);
		return plan;
	}

	function bookLeg(net, kindA, indexA, kindB, indexB, hullIndex, capLy, out) {
		const plan = planLeg(net, kindA, indexA, kindB, indexB, hullIndex, capLy, out);
		if (!plan.reachable) return plan;
		return solveRemaining(net, kindA, indexA, kindB, indexB, 1, hullIndex, capLy, plan);
	}

	// --- Ports and candidates ----------------------------------------------

	// Two founding modes: ROLLED_FOUND is a galaxy-rolled world (the hash
	// invents its age and the settle carries it forward), FRESH_FOUND is a
	// colony that exists from `nowYears` (the player's, or a party that just
	// landed). Same fill law, different grant.
	const ROLLED_FOUND = 0, FRESH_FOUND = 1;

	function addWorld(net, portIndex, site, nowYears, mode) {
		if (!(portIndex >= 0 && portIndex < net.portCount)) return -1;
		const port = net.ports[portIndex];
		if (port.worldCount > 0 && port.colony.outpost) return -1;
		if (worldOfSite(net, portIndex, site.kind, site.index) >= 0) return -1;
		if (port.worldCount >= MAX_WORLDS_PER_STAR || net.worldCount >= MAX_WORLDS) return -1;
		if (port.worldCount > 0) settlePort(net, portIndex, nowYears);
		if (port.worldCount > 0 && port.colony.outpost) return -1;
		const worldIndex = net.worldCount++;
		const slot = port.worldCount++;
		const world = net.worlds[worldIndex];
		port.worldIdx[slot] = worldIndex;
		if (mode === FRESH_FOUND) economy.foundColony(world, site, nowYears, site.seed >>> 0, 0);
		else economy.setupColony(world, site, nowYears, site.seed >>> 0);
		world.port = portIndex;
		world.slot = slot;
		world.access = port.access[slot];
		const c = candidateIndexOf(net, site.key, site.kind, site.index);
		if (c >= 0) net.candidates[c].used = 1;
		foldPort(net, portIndex);
		return worldIndex;
	}

	function addPort(net, site, nowYears, mode) {
		// One inter-star port per star; a star whose colony failed keeps its slot
		// and refuses every future founding (that is what "never recolonised" means).
		const existing = portOfStarLive(net, site.key);
		if (existing >= 0) return existing;
		if (portOfStar(net, site.key) >= 0) return -1;
		if (net.portCount >= MAX_PORTS || net.worldCount >= MAX_WORLDS) return -1;
		const index = net.portCount++;
		const port = net.ports[index];
		port.worldCount = 0;
		port.worldIdx.fill(-1);
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
		addWorld(net, index, site, nowYears, mode);
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

	// The best world of a system by habitat, with the terran/HZ preference the
	// seed map and the frontier scan share. One candidate per star: the pool is
	// a list of places to settle, not a gazetteer of every rock.
	const DISCOVER_PICK = { index: -1, belt: 0, score: 0 };
	function pickBestSite(site, ref, system, seed) {
		let bestScore = -1, bestIndex = -1, bestBelt = 0;
		const count = system.counts.planets | 0;
		for (let i = 0; i < count; i++) {
			economy.fillPlanetSite(site, ref, system, i, seed);
			const score = siteHabitatScore(site);
			if (score > bestScore) { bestScore = score; bestIndex = i; bestBelt = 0; }
		}
		const belts = system.belts.count | 0;
		for (let k = 0; k < belts; k++) {
			economy.fillBeltSite(site, ref, system, k, seed);
			const score = siteHabitatScore(site);
			if (score > bestScore) { bestScore = score; bestIndex = k; bestBelt = 1; }
		}
		DISCOVER_PICK.index = bestIndex;
		DISCOVER_PICK.belt = bestBelt;
		DISCOVER_PICK.score = bestScore;
		return DISCOVER_PICK;
	}

	function fillPickedSite(site, ref, system, seed, pick) {
		if (pick.belt) economy.fillBeltSite(site, ref, system, pick.index, seed);
		else economy.fillPlanetSite(site, ref, system, pick.index, seed);
		site.x = ref.x; site.y = ref.y; site.z = ref.z;
		site.ref = ref;
		return site;
	}

	// Discover one generated system: settle its best site if the star is a
	// seed, otherwise add that site as its one frontier candidate. `ref` is the
	// pick-shaped star record; `system` is a planets SystemRecord. Idempotent:
	// a second inspection only settles the existing colony.
	function discoverSystem(net, ref, starName, system, nowYears) {
		const key = system.star.key >>> 0;
		if (net.discovered.has(key)) {
			settleSystem(net, key, nowYears);
			return 0;
		}
		net.discovered.add(key);
		const seed = economy.siteSeed(key, net.modelSeed, ref.kind);
		const site = DISCOVER_SITE;
		let added = 0;
		// A star settles at most once: one colony is one port, and two
		// colonies of the same star would be a zero-year route that outbids
		// every real voyage. The star-level roll is the galaxy's settled
		// fraction; a settled star puts its colony on the best site it has,
		// and the rest of its worlds stay unsettled (no candidates).
		if (portOfStar(net, key) >= 0) return 0;
		// The settled fraction is a seed-map property, but the seed map is
		// bounded: once `seedPorts` stars are settled the rest of the galaxy
		// stays a frontier, and only expeditions found new colonies.
		// The capital overrides the settled-fraction roll once: the first star
		// with a real world inside HOME_COLONY_KPC of the viewer's home becomes
		// a port whatever the hash says. Everything else is the seed map.
		const nearHome = net.capital < 0
			&& (ref.x - net.homeX) * (ref.x - net.homeX)
				+ (ref.y - net.homeY) * (ref.y - net.homeY)
				+ (ref.z - net.homeZ) * (ref.z - net.homeZ) <= HOME_COLONY_KPC * HOME_COLONY_KPC;
		const maySettle = net.portCount < net.seedPorts
			&& (nearHome || hash.hash01At(seed, TR_CH_PORT) < PORT_CHANCE);
		if (maySettle) {
			const pick = pickBestSite(site, ref, system, seed);
			if (pick.index < 0 || pick.score < MIN_CANDIDATE_HABITAT) return added;
			fillPickedSite(site, ref, system, seed, pick);
			site.name = economy.siteName(starName || '', key, pick.belt, pick.index);
			const portIndex = addPort(net, site, nowYears);
			if (portIndex >= 0) {
				added++;
				if (nearHome && net.capital < 0) net.capital = portIndex;
			}
			return added;
		}
		// A candidate is one star's best world, not every world it has: one
		// colony per star is the rule, so the sibling slots are places no
		// expedition could ever take. Adding them anyway filled the 224-slot
		// pool with dead belts and secondary worlds, and the frontier the
		// ports could actually reach ran dry at 14 colonies (trade-plan §8).
		const pick = pickBestSite(site, ref, system, seed);
		if (pick.index < 0 || pick.score < MIN_CANDIDATE_HABITAT) return added;
		fillPickedSite(site, ref, system, seed, pick);
		site.name = economy.siteName(starName || '', key, pick.belt, pick.index);
		addCandidate(net, site);
		return added;
	}

	// --- The start map (trade-plan §8) --------------------------------------
	// Every system the boot may discover, as a ref with its name and squared
	// distance from home. The named sky is all in; the rendered field is the
	// sample within START_RADIUS_KPC, nearest first, capped at START_FIELD.
	// Built once per galaxy at boot, so the allocations are not per frame.
	function byHomeDistance(a, b) { return a.d2 - b.d2; }

	function pushStart(out, net, kind, index, key, x, y, z, colorIndex, absMag, name) {
		const dx = x - net.homeX, dy = y - net.homeY, dz = z - net.homeZ;
		const ref = { kind, index, key: key >>> 0, x, y, z, colorIndex, absMag };
		out.push({ ref, name, d2: dx * dx + dy * dy + dz * dz });
	}

	function startSystems(net, model, field, landmarks, out) {
		out.length = 0;
		if (model.milkyWay && landmarks) {
			for (let i = 0; i < landmarks.count; i++) {
				const e = landmarks.ENTRIES[i];
				pushStart(out, net, planets.BLOCK_LANDMARK, i, planets.landmarkKey(i),
					e.x, e.y, e.z, e.colorIndex, e.absMag, e.name);
			}
		}
		if (field && field.count > 0) {
			const starTypes = (typeof module !== 'undefined' && module.exports)
				? require('../math/star-types.js')
				: window.StarTypesLib;
			const near = [];
			const r2 = START_RADIUS_KPC * START_RADIUS_KPC;
			for (let i = 0; i < field.count; i++) {
				const dx = field.x[i] - net.homeX, dy = field.y[i] - net.homeY, dz = field.z[i] - net.homeZ;
				if (dx * dx + dy * dy + dz * dz > r2) continue;
				pushStart(near, net, planets.BLOCK_FIELD, i, starTypes.fieldStarSeed(model.seed, i),
					field.x[i], field.y[i], field.z[i], 0, 0, '');
			}
			near.sort(byHomeDistance);
			const take = near.length < START_FIELD ? near.length : START_FIELD;
			for (let i = 0; i < take; i++) out.push(near[i]);
		}
		out.sort(byHomeDistance);
		return out;
	}

	// Discover the start map nearest home first. The settled roll and the
	// capital then fall on the stars the viewer can reach, and the candidate
	// pool fills with the local sky — not with whatever the catalogue order
	// handed over, which put seeds 300–860 ly away with nothing in range.
	// Stops once the pool is full with the seeds placed.
	function discoverNearest(net, systems, ctx, record) {
		let added = 0;
		for (let i = 0; i < systems.length; i++) {
			if (net.portCount >= net.seedPorts && net.candidateCount >= MAX_CANDIDATES - 32) break;
			const s = systems[i];
			ctx.name = s.name;
			planets.generateSystem(s.ref, ctx, record);
			added += discoverSystem(net, s.ref, s.name, record, 0);
		}
		return added;
	}

	// Settle the ports of one star to `nowYears` without discovering anything
	// new — the 4 Hz readout's cheap path.
	function settleSystem(net, key, nowYears) {
		for (let i = 0; i < net.portCount; i++) {
			if (net.ports[i].key === key) settlePort(net, i, nowYears);
		}
	}

	// One port's settle, the only path that may demote it. Settles every live
	// world of the port, folds them into `port.colony`, and demotes the port iff
	// every world on the star has failed. Single-world ports skip the fold loop.
	function settlePort(net, index, time) {
		const port = net.ports[index];
		if (port.colony.outpost) return 0;
		const level = port.colony.popLevel;
		const starving = port.colony.starving;
		let delta = 0;
		for (let s = 0; s < port.worldCount; s++) {
			const world = net.worlds[port.worldIdx[s]];
			if (world.outpost) continue;
			delta += economy.settleColony(world, time);
		}
		const colony = foldPort(net, index);
		if (colony.popLevel !== level) pushLog(net, LOG_MILESTONE, index, colony.popLevel, level);
		if (colony.starving !== starving) {
			pushLog(net, colony.starving ? LOG_FAMINE : LOG_FAMINE_END, index,
				Math.round(colony.coverage * 100), 0);
		}
		if (colony.outpost) demotePort(net, index);
		return delta;
	}

	function demotePort(net, index) {
		const port = net.ports[index];
		if (port.demoted) return 0;
		port.demoted = 1;
		net.outposts += 1;
		pushLog(net, LOG_OUTPOST, index, Math.round(port.colony.outpostY), 0);
		// Its worlds are closed to colonisation, and a founder already in flight
		// refunds its party on arrival through the taken-world path.
		for (let i = 0; i < net.candidateCount; i++) {
			const c = net.candidates[i];
			if (c.site.key !== port.key) continue;
			c.used = 1;
			c.reserved = -1;
		}
		return 1;
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

	// Every colony settled to one instant, once. A load decision reads all
	// ports against the same clock, so settling inside the resource loop would
	// repeat the same exact work thirteen times; this pass is the one settle
	// per port per decision that makes a clock jump equal many small steps.
	function settleAllPorts(net, time) {
		for (let i = 0; i < net.portCount; i++) settlePort(net, i, time);
	}

	// The best destination for one resource, measured on the *plan* (§9.3): the
	// drawn separation and the intercept the hull would fly. A partner the sky
	// has pulled past MAX_LEG_LY, or one receding faster than the hull flies, is
	// not a destination — scoring it on its birth distance is exactly what sent
	// hulls across the arm while their own flight plan said 3 000 ly.
	const SCORE_PLAN = createLegPlan();
	// --- Standing routes (W10) ----------------------------------------------
	//
	// A route is data a load decision reads. It is not an event source and not a
	// contract: nothing is scheduled for it, no hull is tied to it, and a route
	// whose destination wants nothing is simply ignored. The list lives on the
	// network so the overlay can read it without wiring.
	const MAX_ROUTES = 32;

	function createRoutes() {
		const list = [];
		for (let i = 0; i < MAX_ROUTES; i++) {
			list.push({ origin: -1, dest: -1, active: 0, lastDepartY: 0, nextDepartY: 0 });
		}
		return { list, count: 0 };
	}

	function routeIndexOf(net, a, b) {
		const routes = net.routes;
		if (!routes) return -1;
		for (let i = 0; i < routes.count; i++) {
			const r = routes.list[i];
			if (!r.active) continue;
			if ((r.origin === a && r.dest === b) || (r.origin === b && r.dest === a)) return i;
		}
		return -1;
	}

	// The panel's estimate for a pair: the leg at the bulk hull's pace, in trade
	// years. Bookkeeping only — the real voyage is booked when a hull loads.
	const ROUTE_PLAN = createLegPlan();
	function routeLegYears(net, origin, dest) {
		const plan = planLeg(net, END_PORT, origin, END_PORT, dest, 0, MAX_LEG_LY, ROUTE_PLAN);
		return plan.reachable ? plan.years : 0;
	}

	const ROUTE_RESULT = { ok: 0, index: -1, reason: '' };
	function commissionRoute(net, origin, dest, now, out) {
		const r = out || ROUTE_RESULT;
		r.ok = 0;
		r.index = -1;
		r.reason = '';
		if (!(origin >= 0 && origin < net.portCount)) { r.reason = 'no such origin'; return r; }
		if (!(dest >= 0 && dest < net.portCount)) { r.reason = 'no such destination'; return r; }
		if (origin === dest) { r.reason = 'a route needs two ports'; return r; }
		if (net.ports[origin].colony.outpost) { r.reason = 'an outpost ships nothing'; return r; }
		if (net.ports[dest].colony.outpost) { r.reason = 'an outpost takes nothing'; return r; }
		if (routeIndexOf(net, origin, dest) >= 0) { r.reason = 'already commissioned'; return r; }
		// A cancelled route keeps its slot and is revived, so the overlay's and
		// the panel's row identities never move under a click. The same pair
		// coming back gets its own slot; a different pair takes a free one, so
		// the list is only renumbered when it has to grow.
		let index = -1;
		for (let i = 0; i < net.routes.count; i++) {
			const slot = net.routes.list[i];
			if (!slot.active && slot.origin === origin && slot.dest === dest) { index = i; break; }
		}
		if (index < 0) {
			for (let i = 0; i < net.routes.count; i++) {
				if (!net.routes.list[i].active) { index = i; break; }
			}
		}
		if (index < 0 && net.routes.count < MAX_ROUTES) index = net.routes.count;
		if (index < 0) { r.reason = 'too many routes'; return r; }
		const route = net.routes.list[index];
		if (index === net.routes.count) net.routes.count += 1;
		route.origin = origin;
		route.dest = dest;
		route.active = 1;
		route.lastDepartY = now;
		route.nextDepartY = now + routeLegYears(net, origin, dest);
		pushLog(net, LOG_ROUTE, origin, dest, 1);
		r.ok = 1;
		r.index = index;
		return r;
	}

	function removeRoute(net, index) {
		const routes = net.routes;
		if (!routes || !(index >= 0 && index < routes.count)) return 0;
		const route = routes.list[index];
		if (!route.active) return 0;
		route.active = 0;
		pushLog(net, LOG_ROUTE, route.origin, route.dest, 0);
		return 1;
	}

	function activeRouteCount(net) {
		const routes = net.routes;
		if (!routes) return 0;
		let n = 0;
		for (let i = 0; i < routes.count; i++) if (routes.list[i].active) n += 1;
		return n;
	}

	// The panel's bookkeeping, not a schedule: a hull that loaded for this pair
	// refreshes the row's last departure and the leg time the next one would take.
	function noteRouteDeparture(net, origin, dest, time) {
		const index = routeIndexOf(net, origin, dest);
		if (index < 0) return;
		const route = net.routes.list[index];
		route.lastDepartY = time;
		route.nextDepartY = time + routeLegYears(net, origin, dest);
	}

	function pickDestination(net, from, resource, hullIndex, preferFrom) {
		const worth = economy.RESOURCES[resource].worth;
		// The commissioned pair is tried first and wins only if it actually
		// wants the good and the hull can meet it; otherwise the global pick
		// runs exactly as before. A route is a preference, never a mandate.
		if (preferFrom && net.routes) {
			for (let k = 0; k < net.routes.count; k++) {
				const route = net.routes.list[k];
				if (!route.active || route.origin !== from) continue;
				const dest = route.dest;
				if (!(dest >= 0 && dest < net.portCount) || dest === from) continue;
				const port = net.ports[dest];
				if (port.colony.outpost) continue;
				if (economy.demandOf(port.colony, resource) <= 0) continue;
				const plan = planLeg(net, END_PORT, from, END_PORT, dest, hullIndex, MAX_LEG_LY, SCORE_PLAN);
				if (plan.reachable && plan.ly >= 1) return dest;
			}
		}
		let best = -1, bestScore = 0;
		for (let i = 0; i < net.portCount; i++) {
			if (i === from) continue;
			const port = net.ports[i];
			if (port.colony.outpost) continue;
			// The caller settled every port to `time` (settleAllPorts), so this
			// reads the world as it is at the event's own clock, not as its last
			// visitor left it.
			const demand = economy.demandOf(port.colony, resource);
			if (demand <= 0) continue;
			const plan = planLeg(net, END_PORT, from, END_PORT, i, hullIndex, MAX_LEG_LY, SCORE_PLAN);
			// Routes are interstellar: two colonies of the same star would be a
			// zero-year hop that outbids every real voyage.
			if (!plan.reachable || plan.ly < 1) continue;
			const score = demand * worth / (1 + plan.ly / 100);
			if (score > bestScore) { bestScore = score; best = i; }
		}
		return best;
	}

	// The best (resource, destination, amount) triple a port can sell. The
	// score is the shipment's value over the distance it must fly, so a rich
	// ore field next door beats a rare-element trickle across the arm — and a
	// port with nothing anyone wants waits.
	function pickExport(net, from, hold, hullIndex) {
		let bestResource = -1, bestDest = -1, bestAmount = 0, bestScore = 0;
		for (let r = 0; r < economy.RESOURCE_COUNT; r++) {
			// T1: an inter-star hull loads only a shipping family. The bulk
			// feedstock (ore, volatiles) keeps its worth and its exportability
			// for the intra tier and the player's readout — the filter is here,
			// on the loader, not on the resource table.
			if (economy.RESOURCES[r].interFamily < 0) continue;
			const spare = economy.exportableOf(net.ports[from].colony, r);
			if (spare <= 0) continue;
			const dest = pickDestination(net, from, r, hullIndex, 1);
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
			const plan = planLeg(net, END_PORT, from, END_PORT, dest, hullIndex, MAX_LEG_LY, SCORE_PLAN);
			if (!plan.reachable) continue;
			const score = amount * economy.RESOURCES[r].worth / (1 + plan.ly / 200);
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
	const SAIL_PLAN = createLegPlan();

	function sailTo(net, ship, destPort, time) {
		// The booking (§9.3): the winner of the scoring pass is re-solved against
		// the real law, and a leg the law refuses is not sailed. The caller has
		// already booked it once (before the cargo left the warehouse) — the
		// second solve is the same answer at the same instant, and it is what
		// keeps sailTo's own contract honest for its other caller.
		const plan = bookLeg(net, END_PORT, ship.port, END_PORT, destPort, ship.hull, MAX_LEG_LY, SAIL_PLAN);
		if (!plan.reachable) return 0;
		ship.from = ship.port;
		ship.to = destPort;
		ship.state = SHIP_SAILING;
		ship.returning = 0;
		ship.legFrom = 0;
		ship.legTo = 1;
		// A hull that found work stops backing off.
		ship.waits = 0;
		ship.depart = time;
		ship.arrive = time + plan.years;
		ship.leg = ship.arrive - ship.depart;          // booked journey; speed is constant, so time fraction == distance fraction
		ship.port = -1;
		scheduleShip(net, ship, ship.arrive, EV_ARRIVE);
		return 1;
	}

	// The arrival: settle the destination (the brief's "factory works per ship
	// arrive"), deposit what the port can take, and book the loading event.
	// The leftover stays aboard and is offered to the next port. A diverted hull
	// (§9.4) arrives back at the port it turned around from instead.
	function arrive(net, ship, time) {
		const at = ship.returning ? ship.from : ship.to;
		const port = net.ports[at];
		ship.returning = 0;
		settlePort(net, at, time);
		if (ship.amount > 0 && ship.cargo !== NO_RESOURCE) {
			const given = distributePortInbound(net, at, ship.cargo, ship.amount);
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
		ship.port = at;
		ship.to = -1;
		ship.state = SHIP_DOCKED;
		ship.trips += 1;
		scheduleShip(net, ship, time + DOCK_YEARS, EV_LOAD);
	}

	function waitAtPort(net, ship, time) {
		ship.state = SHIP_WAITING;
		ship.waits = ship.waits ? ship.waits + 1 : 1;
		const retries = ship.waits > 8 ? 8 : ship.waits;
		let delay = WAIT_YEARS * (1 << retries);
		if (delay > WAIT_YEARS_MAX) delay = WAIT_YEARS_MAX;
		scheduleShip(net, ship, time + delay, EV_WAIT);
	}

	function loadAtPort(net, ship, time) {
		const portIndex = ship.port;
		if (portIndex < 0) return;
		const port = net.ports[portIndex];
		settleAllPorts(net, time);
		if (ship.cargo !== NO_RESOURCE && ship.amount > 0) {
			// A leftover cargo the previous port could not take: try the next
			// destination for the same good before loading anything new.
			const dest = pickDestination(net, portIndex, ship.cargo, ship.hull);
			if (dest >= 0) {
				const plan = bookLeg(net, END_PORT, portIndex, END_PORT, dest, ship.hull, MAX_LEG_LY, LOAD_PLAN);
				if (plan.reachable && sailTo(net, ship, dest, time)) return;
			}
			// Nobody has room for it, or nobody the hull can still meet. Jettison
			// rather than deadlock the hull with a cargo that every port is already
			// full of; the next load starts clean.
			ship.cargo = NO_RESOURCE;
			ship.amount = 0;
		}
		const pick = pickExport(net, portIndex, ship.hold, ship.hull);
		if (pick.resource < 0) { waitAtPort(net, ship, time); return; }
		// The booking comes before the cargo leaves the warehouse: a leg the sky
		// has made unreachable must not strand a loaded hull on the pad.
		if (!bookLeg(net, END_PORT, portIndex, END_PORT, pick.dest, ship.hull, MAX_LEG_LY, LOAD_PLAN).reachable) {
			waitAtPort(net, ship, time);
			return;
		}
		const taken = collectPortOutbound(net, portIndex, pick.resource, pick.amount);
		if (taken <= 0) { waitAtPort(net, ship, time); return; }
		ship.cargo = pick.resource;
		ship.amount = taken;
		noteRouteDeparture(net, portIndex, pick.dest, time);
		sailTo(net, ship, pick.dest, time);
	}

	const LOAD_PLAN = createLegPlan();

	// --- Colonisation -------------------------------------------------------

	const EXPEDITION_SCRATCH = { port: -1, candidate: -1, score: 0 };
	const EXPEDITION_COST = { peopleM: 0, people: 0 };

	// A founding wave is a share of the source's population (2 %, 0.5–4 M),
	// not a warehouse transfer: the "colonists" stock is a cargo good and the
	// "factory cores" stock is consumed by the colony's own households, so a
	// gate on either one made expansion depend on the rare world with a people
	// yield and a robots surplus. People are the cost every thriving colony can
	// pay, and the source always keeps a working population behind.
	function expeditionCost(colony, out) {
		let peopleM = colony.pop * VOLUNTEER_FRAC;
		if (peopleM < FOUNDERS_MIN_M) peopleM = FOUNDERS_MIN_M;
		if (peopleM > FOUNDERS_MAX_M) peopleM = FOUNDERS_MAX_M;
		const affordable = colony.pop - MIN_FOUNDERS_REMAIN_M;
		if (peopleM > affordable) peopleM = affordable;
		if (!(peopleM > 0)) peopleM = 0;
		out.peopleM = peopleM;
		out.people = peopleM / POP_PER_COLONIST_UNIT;
		return out;
	}

	// Colonisation thresholds: only established, populous worlds send
	// expeditions. A port that has just been founded or is barely
	// holding on does not have surplus to colonise with. Thresholds are
	// deliberately low so even a sparse test fixture can colonise, while
	// still distinguishing a thriving big colony from a starving outpost.
	const MIN_EXPEDITION_POP_M = 5;
	const MIN_EXPEDITION_COVERAGE = 0.30;
	// Belts are 0.10 on the habitat scale: a belt outpost is a real colony
	// (the capital itself can be a belt), so the founding gate must admit it.
	const MIN_CANDIDATE_HABITAT = 0.10;

	function siteHabitatScore(site) {
		let base = site.isBelt ? economy.HABITAT_BELT : economy.HABITAT[site.type];
		if (site.flags & planets.FLAG_TERRAN) base *= 1.6;
		else if (site.flags & planets.FLAG_IN_HZ) base *= 1.25;
		return base;
	}

	function isBigColony(colony) {
		if (colony.outpost) return false;
		if (colony.pop < MIN_EXPEDITION_POP_M) return false;
		if (colony.coverage < MIN_EXPEDITION_COVERAGE) return false;
		if (colony.pop < colony.capacity * 0.08) return false;
		return true;
	}

	function pickCandidate(net, from) {
		let best = -1, bestScore = 0;
		for (let i = 0; i < net.candidateCount; i++) {
			const c = net.candidates[i];
			if (c.used || c.reserved >= 0) continue;
			if (portOfStar(net, c.site.key) >= 0) continue;
			const site = c.site;
			// The drawn separation and the intercept (§9.3), not the birth one:
			// an expedition is a 600 ly promise in the sky the viewer is watching.
			const plan = planLeg(net, END_PORT, from, END_CANDIDATE, i, EXPEDITION_HULL, MAX_FOUND_LY, SCORE_PLAN);
			if (!plan.reachable) continue;
			const ly = plan.ly;
			const habitat = siteHabitatScore(site);
			if (habitat < MIN_CANDIDATE_HABITAT) continue;
			// Prefer a good, close world: habitat quality over distance.
			// Near stars are cheaper to reach and keep the network connected.
			const distanceFactor = 1 + ly / 80;
			const score = habitat / distanceFactor;
			if (score > bestScore) { bestScore = score; best = i; }
		}
		EXPEDITION_SCRATCH.score = bestScore;
		return best;
	}

	// The best (source, candidate) pair a tick can launch: a big port past its
	// cooldown, an unsettled site in range, and a score that rewards a big
	// population and a habitable, nearby world. Trying every port matters —
	// the largest colony is not always the one with a frontier.
	function bestExpedition(net, time, rush) {
		settleAllPorts(net, time);
		let bestPort = -1, bestCandidate = -1, bestScore = 0;
		// How far the best attempt got, so the panel can say *why* nothing
		// launched instead of the old catch-all "no big colonies ready".
		let big = 0, ready = 0, resting = 0;
		let nextIn = Infinity;
		for (let i = 0; i < net.portCount; i++) {
			const port = net.ports[i];
			const colony = port.colony;
			if (colony.outpost) continue;
			if (!isBigColony(colony)) continue;
			big += 1;
			const wait = port.lastExpedition + EXPEDITION_COOLDOWN - time;
			if (wait > 0 && !rush) {
				resting += 1;
				if (wait < nextIn) nextIn = wait;
				continue;
			}
			expeditionCost(colony, EXPEDITION_COST);
			if (!(EXPEDITION_COST.peopleM > 0)) continue;
			ready += 1;
			const candidate = pickCandidate(net, i);
			if (candidate < 0) continue;
			const popFactor = Math.min(3, 0.6 + colony.pop / 120);
			const coverageBonus = 0.7 + Math.min(0.6, colony.coverage);
			const score = popFactor * coverageBonus * EXPEDITION_SCRATCH.score;
			if (score > bestScore) { bestScore = score; bestPort = i; bestCandidate = candidate; }
		}
		EXPEDITION_SCRATCH.port = bestPort;
		EXPEDITION_SCRATCH.candidate = bestCandidate;
		EXPEDITION_SCRATCH.bestScore = bestScore;
		EXPEDITION_SCRATCH.big = big;
		EXPEDITION_SCRATCH.ready = ready;
		EXPEDITION_SCRATCH.resting = resting;
		EXPEDITION_SCRATCH.nextIn = nextIn === Infinity ? 0 : nextIn;
		EXPEDITION_SCRATCH.reason = bestPort >= 0 ? ''
			: big === 0 ? 'no big colony yet'
			: ready === 0 ? 'every big colony is resting between expeditions'
			: 'no free world within ' + MAX_FOUND_LY + ' ly';
		return EXPEDITION_SCRATCH;
	}

	// The Trade panel's colonisation block, in one pass at the readout's 4 Hz:
	// every port that could launch now (ranked by bestExpedition's score) and
	// the counts that explain an empty list. The reason is the whole point — the
	// panel used to say "no big colonies ready" whenever *anything* was missing.
	const COLONISATION_PREVIEW = [];
	const COLONISATION_STATUS = {
		big: 0, ready: 0, resting: 0, candidates: 0, free: 0, founding: 0, nextIn: 0, reason: '',
	};
	function colonisationStatus() {
		return COLONISATION_STATUS;
	}
	function colonisationPreview(net, time, out) {
		out = out || COLONISATION_PREVIEW;
		out.length = 0;
		settleAllPorts(net, time);
		let big = 0, ready = 0, resting = 0, founding = 0;
		let nextIn = Infinity;
		for (let i = 0; i < net.shipCount; i++) if (net.ships[i].state === SHIP_FOUNDING) founding += 1;
		for (let i = 0; i < net.portCount; i++) {
			const port = net.ports[i];
			const colony = port.colony;
			if (!isBigColony(colony)) continue;
			big += 1;
			const wait = port.lastExpedition + EXPEDITION_COOLDOWN - time;
			if (wait > 0) {
				resting += 1;
				if (wait < nextIn) nextIn = wait;
				continue;
			}
			expeditionCost(colony, EXPEDITION_COST);
			if (!(EXPEDITION_COST.peopleM > 0)) continue;
			ready += 1;
			const candidate = pickCandidate(net, i);
			if (candidate < 0) continue;
			const site = net.candidates[candidate].site;
			const plan = planLeg(net, END_PORT, i, END_CANDIDATE, candidate, EXPEDITION_HULL, MAX_FOUND_LY, SCORE_PLAN);
			const ly = plan.ly;
			out.push({
				port: i,
				candidate,
				habitat: siteHabitatScore(site),
				ly,
				score: EXPEDITION_SCRATCH.score,
				name: site.name,
				flags: site.flags,
				type: site.type,
				peopleM: EXPEDITION_COST.peopleM,
			});
		}
		out.sort((a, b) => b.score - a.score);
		let free = 0;
		for (let i = 0; i < net.candidateCount; i++) {
			const c = net.candidates[i];
			if (!c.used && c.reserved < 0) free += 1;
		}
		COLONISATION_STATUS.big = big;
		COLONISATION_STATUS.ready = ready;
		COLONISATION_STATUS.resting = resting;
		COLONISATION_STATUS.candidates = net.candidateCount;
		COLONISATION_STATUS.free = free;
		COLONISATION_STATUS.founding = founding;
		COLONISATION_STATUS.nextIn = nextIn === Infinity ? 0 : nextIn;
		COLONISATION_STATUS.reason = out.length > 0 ? ''
			: big === 0 ? 'no big colony yet'
			: ready === 0 ? 'every big colony is resting between expeditions'
			: free === 0 ? 'no free world in range'
			: 'no free world within ' + MAX_FOUND_LY + ' ly';
		return out;
	}

	// Frontier expansion: big colonies scan nearby field stars for good
	// unclaimed worlds and add them as candidates. Called from the app's
	// trade step with its live field; no-op when field is absent or frontier
	// is full. Cheap enough for the 25-year tick but not for per-frame.
	const FRONTIER_FIELD_REF = { kind: 0, index: 0, key: 0, x: 0, y: 0, z: 0, colorIndex: 0, absMag: 0 };
	// Reuse one system record and one site for the scan to avoid per-star alloc.
	const FRONTIER_SCAN_RECORD = planets.createSystemRecord();
	const FRONTIER_SCAN_SITE = economy.createSite();
	const FRONTIER_SCAN_CTX = { model: null, field: null, member: null, name: '' };
	const MAX_FOUND_KPC = MAX_FOUND_LY / LY_PER_KPC;
	// Stars tested per frontier scan, and worlds added per scan. A ring cursor
	// walks the field, so the pair bounds both the cost of one scan and the
	// size of one visible step of frontier growth.
	const FRONTIER_SCAN = 4000, FRONTIER_PER_SCAN = 4;
	// Field-star key is the canonical starTypes seed: seed*31 + index +1.
	function frontierFieldKey(seed, index) {
		return ((seed * 31 + index + 1) | 0) >>> 0;
	}
	// Frontier scan scratch: reused per star, so a scan allocates nothing.
	const FRONTIER_BIG = new Int32Array(MAX_PORTS);
	const FRONTIER_BEST = economy.createSite();
	function frontierHabitat(site, x, y, z, kind, index) {
		site.x = x; site.y = y; site.z = z;
		site.ref = FRONTIER_FIELD_REF;
		site.name = economy.siteName('', site.key, kind, index);
		return siteHabitatScore(site);
	}

	// The shear the birth frame has accumulated since the field was drawn: a pair
	// `gapKpc` apart at galactocentric radius r separates at about (vFlat/r)·gap
	// (differential rotation), plus the epicyclic spread the classic law gives two
	// stars of different phase and rank — 2√2·σ·r/vFlat, which is ~3 kpc at the
	// Sun's radius and does not shrink with a shorter clock (it is motion the
	// stars have whether or not the clock has run). Capped at
	// FRONTIER_STRETCH_MAX× the gap: past that the pre-gate is no filter at all
	// and the scan should stay as cheap as it is.
	//
	// The exact gate behind it is bounded too: FRONTIER_LIVE_PER_SCAN resolves
	// per call (the ring cursor keeps the place), because a stretched ball around
	// 64 ports covers most of the disc and 4 000 resolves would be a 5 ms hitch
	// twice a second. The frontier then grows a little slower under a moving sky,
	// which is the right trade for a frame budget.
	const FRONTIER_STRETCH_MAX = 8;
	const FRONTIER_LIVE_PER_SCAN = 800;
	function frontierStretchKpc(net, model, radiusKpc) {
		const geom = net.geom;
		if (!geom.moving || !(geom.starTime > 0)) return 0;
		const dyn = (model && model.dynamics) || {};
		const vFlat = dyn.vFlat > 0 ? dyn.vFlat : 0;
		if (!(vFlat > 0) || !(radiusKpc > 1e-6)) return 0;
		const r = radiusKpc > dyn.rCore ? radiusKpc : dyn.rCore;
		const shear = vFlat / r * MAX_FOUND_KPC * geom.starTime;
		const epicyclic = 2 * Math.SQRT2 * (dyn.sigmaThin || 0) * r / vFlat;
		let stretch = shear + epicyclic;
		const cap = MAX_FOUND_KPC * (FRONTIER_STRETCH_MAX - 1);
		return stretch > cap ? cap : stretch;
	}

	// The exact gate: the field star's drawn position against the big ports'
	// drawn positions. One resolver call per star that passed the coarse gate.
	function frontierLiveNear(net, bigCount) {
		if (!net.livePosition(FRONTIER_FIELD_REF, GEOM_POS)) return 0;
		const nearSq = MAX_FOUND_KPC * MAX_FOUND_KPC;
		for (let b = 0; b < bigCount; b++) {
			endpointPos(net, END_PORT, FRONTIER_BIG[b], END_B);
			const dx = GEOM_POS[0] - END_B[0], dy = GEOM_POS[1] - END_B[1], dz = GEOM_POS[2] - END_B[2];
			if (dx * dx + dy * dy + dz * dz <= nearSq) return 1;
		}
		return 0;
	}

	function expandFrontierFromField(net, field, model) {
		if (!field || !model || field.count <= 0) return 0;
		if (net.candidateCount >= MAX_CANDIDATES) return 0;
		let bigCount = 0;
		for (let i = 0; i < net.portCount; i++) {
			if (isBigColony(net.ports[i].colony)) FRONTIER_BIG[bigCount++] = i;
		}
		if (bigCount === 0) return 0;
		// A ring scan: the next scan resumes where this one stopped, so repeated
		// ticks walk the whole field instead of re-testing the same head, and the
		// result stays deterministic (the cursor is part of the network's state).
		// Four new worlds per scan is the pacing: the frontier grows in steps a
		// viewer can watch, and one scan stays cheap next to the event drain.
		//
		// Two gates, and only the second one decides (§9.6). The coarse gate is
		// birth-frame because the field buffer is, stretched by the shear the
		// star clock has applied since birth, and capped: past the cap the scan
		// proposes from a neighbourhood the sky has already left, which slows the
		// frontier instead of filling it with worlds no hull can reach. The exact
		// gate is the *drawn* distance, applied before the expensive system
		// generation, so a birth-frame artefact never becomes a candidate.
		let added = 0;
		let fi = net.frontierCursor | 0;
		const centre = (model && model.centre) || { x: 0, y: 0, z: 0 };
		let rMin = Infinity;
		for (let b = 0; b < bigCount; b++) {
			const port = net.ports[FRONTIER_BIG[b]];
			const r = Math.hypot(port.x - centre.x, port.y - centre.y);
			if (r < rMin) rMin = r;
		}
		const reach = MAX_FOUND_KPC + frontierStretchKpc(net, model, rMin);
		const nearSq = reach * reach;
		const liveGate = net.geom.moving && net.livePosition ? 1 : 0;
		let liveUsed = 0;
		for (let n = 0; n < FRONTIER_SCAN && net.candidateCount < MAX_CANDIDATES; n++) {
			fi += 1;
			if (fi >= field.count) fi = 0;
			const key = frontierFieldKey(model.seed, fi);
			if (net.discovered.has(key)) continue;
			const fx = field.x[fi], fy = field.y[fi], fz = field.z[fi];
			let near = false;
			for (let b = 0; b < bigCount; b++) {
				const port = net.ports[FRONTIER_BIG[b]];
				const dx = fx - port.x, dy = fy - port.y, dz = fz - port.z;
				if (dx * dx + dy * dy + dz * dz <= nearSq) { near = true; break; }
			}
			if (!near) continue;
			FRONTIER_FIELD_REF.kind = planets.BLOCK_FIELD;
			FRONTIER_FIELD_REF.index = fi;
			FRONTIER_FIELD_REF.key = key;
			FRONTIER_FIELD_REF.x = fx; FRONTIER_FIELD_REF.y = fy; FRONTIER_FIELD_REF.z = fz;
			FRONTIER_FIELD_REF.colorIndex = 0; FRONTIER_FIELD_REF.absMag = 0;
			if (liveGate) {
				if (liveUsed >= FRONTIER_LIVE_PER_SCAN) break;
				liveUsed += 1;
				if (!frontierLiveNear(net, bigCount)) continue;
			}
			FRONTIER_SCAN_CTX.model = model;
			FRONTIER_SCAN_CTX.field = field;
			FRONTIER_SCAN_CTX.member = null;
			FRONTIER_SCAN_CTX.name = '';
			try { planets.generateSystem(FRONTIER_FIELD_REF, FRONTIER_SCAN_CTX, FRONTIER_SCAN_RECORD); } catch (e) { continue; }
			const seed = economy.siteSeed(key, net.modelSeed, FRONTIER_FIELD_REF.kind);
			const planetCount = FRONTIER_SCAN_RECORD.counts.planets | 0;
			const beltCount = FRONTIER_SCAN_RECORD.belts.count | 0;
			// One scratch site is filled for every world; only the best one is
			// copied out, and only when it beats the best so far. The scan used to
			// allocate a fresh site per improvement — a per-scan garbage storm.
			let bestHab = -1;
			for (let p = 0; p < planetCount; p++) {
				economy.fillPlanetSite(FRONTIER_SCAN_SITE, FRONTIER_FIELD_REF, FRONTIER_SCAN_RECORD, p, seed);
				const h = frontierHabitat(FRONTIER_SCAN_SITE, fx, fy, fz, 0, p);
				if (h > bestHab) { bestHab = h; economy.copySite(FRONTIER_BEST, FRONTIER_SCAN_SITE); }
			}
			for (let b = 0; b < beltCount; b++) {
				economy.fillBeltSite(FRONTIER_SCAN_SITE, FRONTIER_FIELD_REF, FRONTIER_SCAN_RECORD, b, seed);
				const h = frontierHabitat(FRONTIER_SCAN_SITE, fx, fy, fz, 1, b);
				if (h > bestHab) { bestHab = h; economy.copySite(FRONTIER_BEST, FRONTIER_SCAN_SITE); }
			}
			if (bestHab < MIN_CANDIDATE_HABITAT) continue;
			// Claim the star as discovered so it is never rescanned, then add its
			// best world as the frontier candidate.
			net.discovered.add(key);
			if (addCandidate(net, FRONTIER_BEST) >= 0 && ++added >= FRONTIER_PER_SCAN) { net.frontierCursor = fi; return added; }
		}
		net.frontierCursor = fi;
		return added;
	}

	// The global tick: grow the fleet toward the port count, then launch every
	// port that is ready — up to the founding-in-flight cap. One expedition per
	// network per 250 years was the plateau at 14 colonies: a big port could
	// wait decades (seconds of wall time) for its turn while its people piled
	// up. The per-port cooldown is the new pace, and a tick spends it on as many
	// ports as are ready.
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
		let founding = 0;
		for (let i = 0; i < net.shipCount; i++) if (net.ships[i].state === SHIP_FOUNDING) founding += 1;
		let room = expansionOn ? MAX_FOUNDING_IN_FLIGHT - founding : 0;
		while (room > 0 && net.portCount + founding < MAX_PORTS) {
			const pick = bestExpedition(net, time);
			if (pick.port < 0) break;
			const ship = launchExpedition(net, pick.port, pick.candidate, time);
			if (ship < 0) break;
			founding += 1;
			room -= 1;
		}
		net.tickScheduled = 1;
		queueLib.push(net.queue, time + TICK_YEARS, EV_TICK, 0, 0);
	}

	const LAUNCH_FAIL = { reason: '' };
	function launchExpedition(net, source, candidateIndex, time, rush) {
		const sourcePort = net.ports[source];
		LAUNCH_FAIL.reason = '';
		if (!rush && time - sourcePort.lastExpedition < EXPEDITION_COOLDOWN) {
			LAUNCH_FAIL.reason = 'the port is still resting';
			return -1;
		}
		expeditionCost(sourcePort.colony, EXPEDITION_COST);
		if (!(EXPEDITION_COST.peopleM > 0)) {
			LAUNCH_FAIL.reason = 'no volunteers to spare';
			return -1;
		}
		if (sourcePort.colony.pop - EXPEDITION_COST.peopleM < MIN_FOUNDERS_REMAIN_M) {
			LAUNCH_FAIL.reason = 'the port must keep a working population';
			return -1;
		}
		// The founding leg is booked before a single volunteer leaves the
		// population: a world the sky has made unreachable must refuse the wave,
		// not strand it (§9.3).
		const plan = bookLeg(net, END_PORT, source, END_CANDIDATE, candidateIndex,
			EXPEDITION_HULL, MAX_FOUND_LY, FOUND_PLAN);
		if (!plan.reachable) {
			// The sky, not the map: the world is inside 600 ly now but the hull
			// cannot meet it before it is not (§9.3).
			LAUNCH_FAIL.reason = 'the world is receding faster than the hull';
			return -1;
		}
		const shipIndex = freeShip(net);
		if (shipIndex < 0) {
			LAUNCH_FAIL.reason = 'no hull free';
			return -1;
		}
		const colonists = EXPEDITION_COST.people;
		takePortPopulation(net, source, EXPEDITION_COST.peopleM);
		sourcePort.lastExpedition = time;
		const ship = net.ships[shipIndex];
		const site = net.candidates[candidateIndex].site;
		for (let i = 0; i < net.candidateCount; i++) {
			if (net.candidates[i].site.key === site.key) net.candidates[i].reserved = shipIndex;
		}
		ship.index = shipIndex;
		ship.hull = EXPEDITION_HULL;
		ship.hold = colonists;
		ship.amount = colonists;
		ship.cargo = economy.R_PEOPLE;
		ship.state = SHIP_FOUNDING;
		ship.port = -1;
		ship.from = source;
		ship.to = -1;
		ship.candidate = candidateIndex;
		ship.returning = 0;
		ship.legFrom = 0;
		ship.legTo = 1;
		ship.depart = time;
		ship.arrive = time + plan.years;
		ship.leg = ship.arrive - ship.depart;
		ship.revision = 0;
		ship.trips = 0;
		ship.delivered = 0;
		ship.founded = 0;
		pushLog(net, LOG_EXPEDITION, source, candidateIndex, 0);
		scheduleShip(net, ship, ship.arrive, EV_FOUND);
		return shipIndex;
	}

	// --- Player founding (W3) -----------------------------------------------

	const FOUND_RESULT = { ok: 0, port: -1, site: null, reason: '' };

	function createFoundResult() {
		FOUND_RESULT.ok = 0;
		FOUND_RESULT.port = -1;
		FOUND_RESULT.site = null;
		FOUND_RESULT.reason = '';
		return FOUND_RESULT;
	}

	// The player's one lever: put a colony on the best world of a star the
	// network never rolled. Free — the player is the catalyst, not an owner.
	// `system` is a generated SystemRecord for `ref`; the refusals are the five
	// reasons the panel can show, each with its own word.
	const FOUND_SITE = economy.createSite();
	function playerFound(net, ref, starName, system, nowYears, out) {
		const r = out || createFoundResult();
		r.ok = 0;
		r.port = -1;
		r.site = null;
		r.reason = '';
		const key = system.star.key >>> 0;
		if (portOfStarLive(net, key) >= 0) { r.reason = 'already a colony here'; return r; }
		if (portOfStar(net, key) >= 0) { r.reason = 'this star is an outpost'; return r; }
		for (let i = 0; i < net.candidateCount; i++) {
			const c = net.candidates[i];
			if (c.site.key === key && c.reserved >= 0) {
				r.reason = 'an expedition is already bound for it';
				return r;
			}
		}
		if (net.portCount >= MAX_PORTS) { r.reason = 'network is full'; return r; }
		const seed = economy.siteSeed(key, net.modelSeed, ref.kind);
		const pick = pickBestSite(FOUND_SITE, ref, system, seed);
		if (pick.index < 0 || pick.score < MIN_CANDIDATE_HABITAT) {
			r.reason = 'no world worth settling';
			return r;
		}
		fillPickedSite(FOUND_SITE, ref, system, seed, pick);
		FOUND_SITE.name = economy.siteName(starName || '', key, pick.belt, pick.index);
		const portIndex = addPort(net, FOUND_SITE, nowYears, FRESH_FOUND);
		if (portIndex < 0) { r.reason = 'network is full'; return r; }
		for (let i = 0; i < net.candidateCount; i++) {
			if (net.candidates[i].site.key === key) net.candidates[i].used = 1;
		}
		net.founded += 1;
		pushLog(net, LOG_FOUND, portIndex, -1, 0);
		r.ok = 1;
		r.port = portIndex;
		r.site = FOUND_SITE;
		return r;
	}

	const WORLD_RESULT = { ok: 0, port: -1, world: -1, slot: -1, site: null, reason: '' };

	function createWorldFoundResult() {
		WORLD_RESULT.ok = 0;
		WORLD_RESULT.port = -1;
		WORLD_RESULT.world = -1;
		WORLD_RESULT.slot = -1;
		WORLD_RESULT.site = null;
		WORLD_RESULT.reason = '';
		return WORLD_RESULT;
	}

	// W3 extended (trade-3 plan §5.2): found a colony on a named planet or belt
	// in system view without taking a second port slot. If the star has no port
	// yet, this opens its port on that site; otherwise it appends to `worldIdx`.
	function playerFoundWorld(net, ref, starName, system, isBelt, bodyIndex, nowYears, out) {
		const r = out || createWorldFoundResult();
		r.ok = 0;
		r.port = -1;
		r.world = -1;
		r.slot = -1;
		r.site = null;
		r.reason = '';
		const key = system.star.key >>> 0;
		const belt = isBelt ? 1 : 0;
		const bodyCount = belt ? (system.belts.count | 0) : (system.counts.planets | 0);
		const seed = economy.siteSeed(key, net.modelSeed, ref.kind);
		const existingPort = portOfStar(net, key);
		if (existingPort >= 0 && net.ports[existingPort].colony.outpost) {
			r.reason = 'star is an outpost';
			return r;
		}
		if (!(bodyIndex >= 0 && bodyIndex < bodyCount)) {
			r.reason = 'no site worth settling';
			return r;
		}
		if (existingPort >= 0 && worldOfSite(net, existingPort, belt, bodyIndex) >= 0) {
			r.reason = 'already a world here';
			return r;
		}
		if (existingPort >= 0 && (net.ports[existingPort].worldCount >= MAX_WORLDS_PER_STAR || net.worldCount >= MAX_WORLDS)) {
			r.reason = 'worlds full';
			return r;
		}
		if (existingPort < 0) {
			for (let i = 0; i < net.candidateCount; i++) {
				const c = net.candidates[i];
				if (c.site.key === key && c.reserved >= 0) {
					r.reason = 'an expedition is already bound for it';
					return r;
				}
			}
			if (net.portCount >= MAX_PORTS || net.worldCount >= MAX_WORLDS) {
				r.reason = 'network is full';
				return r;
			}
		}
		const pick = { index: bodyIndex | 0, belt };
		fillPickedSite(FOUND_SITE, ref, system, seed, pick);
		if (siteHabitatScore(FOUND_SITE) < MIN_CANDIDATE_HABITAT) {
			r.reason = 'no site worth settling';
			return r;
		}
		FOUND_SITE.name = economy.siteName(starName || '', key, belt, bodyIndex | 0);
		if (existingPort < 0) {
			const portIndex = addPort(net, FOUND_SITE, nowYears, FRESH_FOUND);
			if (portIndex < 0) { r.reason = 'network is full'; return r; }
			for (let i = 0; i < net.candidateCount; i++) {
				if (net.candidates[i].site.key === key) net.candidates[i].used = 1;
			}
			net.founded += 1;
			pushLog(net, LOG_FOUND, portIndex, -1, 0);
			r.ok = 1;
			r.port = portIndex;
			r.world = net.ports[portIndex].worldIdx[0];
			r.slot = 0;
			r.site = FOUND_SITE;
			return r;
		}
		const port = net.ports[existingPort];
		const slot = port.worldCount;
		if (port.couple[slot * MAX_WORLDS_PER_STAR] < MIN_FOUND_COUPLE) {
			r.reason = 'too expensive to reach';
			return r;
		}
		const worldIndex = addWorld(net, existingPort, FOUND_SITE, nowYears, FRESH_FOUND);
		if (worldIndex < 0) {
			r.reason = port.colony.outpost ? 'star is an outpost' : 'worlds full';
			return r;
		}
		net.founded += 1;
		pushLog(net, LOG_FOUND, existingPort, -1, 0);
		r.ok = 1;
		r.port = existingPort;
		r.world = worldIndex;
		r.slot = net.worlds[worldIndex].slot;
		r.site = FOUND_SITE;
		return r;
	}

	const FOUND_PLAN = createLegPlan();
	const RETIME_PLAN = createLegPlan();
	const DIVERT_PLAN = createLegPlan();

	// The panel's Send-expedition button: the tick's own choice, launched now
	// instead of waiting for the next 25-year tick. Same cost, same fleet
	// limit, same reservation; a port still resting from its last wave can be
	// rushed, and its 900-year clock restarts from this launch.
	const LAUNCH_RESULT = { ok: 0, ship: -1, source: -1, candidate: -1, reason: '' };

	function setExpansion(on) {
		expansionOn = on > 0 ? 1 : 0;
		return expansionOn;
	}

	function expansionArmed() {
		return expansionOn;
	}

	// Why a port can (or cannot) sponsor a wave, as one record. It answers the
	// panel's per-port question and the simulation's bulk one with the same law.
	const READINESS = { state: 'live', why: '', nextIn: 0 };
	function portReadiness(net, index, time, out) {
		const r = out || READINESS;
		const colony = net.ports[index].colony;
		r.nextIn = 0;
		if (colony.outpost) { r.state = 'outpost'; r.why = 'outpost \u2014 growth stopped'; return r; }
		if (colony.pop < MIN_EXPEDITION_POP_M || colony.pop < colony.capacity * 0.08) {
			r.state = 'small';
			r.why = 'population too small to sponsor a wave';
			return r;
		}
		if (colony.coverage < MIN_EXPEDITION_COVERAGE) {
			r.state = 'starving';
			r.why = 'coverage below the expedition gate';
			return r;
		}
		const wait = net.ports[index].lastExpedition + EXPEDITION_COOLDOWN - time;
		if (wait > 0) {
			r.state = 'resting';
			r.nextIn = wait;
			r.why = 'resting ' + Math.round(wait) + ' y';
			return r;
		}
		r.state = 'live';
		r.why = '';
		return r;
	}
	function launchBest(net, time) {
		// The button is the player's hand: it may sponsor a port that is still
		// resting, and that port's cooldown restarts from now. The automatic
		// tick always waits its turn.
		if (!expansionOn) {
			LAUNCH_RESULT.ok = 0;
			LAUNCH_RESULT.ship = -1;
			LAUNCH_RESULT.source = -1;
			LAUNCH_RESULT.candidate = -1;
			LAUNCH_RESULT.reason = 'expansion is off';
			return LAUNCH_RESULT;
		}
		const pick = bestExpedition(net, time, 1);
		LAUNCH_RESULT.ok = 0;
		LAUNCH_RESULT.ship = -1;
		LAUNCH_RESULT.source = pick.port;
		LAUNCH_RESULT.candidate = pick.candidate;
		LAUNCH_RESULT.reason = pick.reason;
		let founding = 0;
		for (let i = 0; i < net.shipCount; i++) if (net.ships[i].state === SHIP_FOUNDING) founding += 1;
		if (net.portCount + founding >= MAX_PORTS) { LAUNCH_RESULT.reason = 'network is full'; return LAUNCH_RESULT; }
		if (founding >= MAX_FOUNDING_IN_FLIGHT) { LAUNCH_RESULT.reason = 'too many expeditions in flight'; return LAUNCH_RESULT; }
		if (pick.port < 0) return LAUNCH_RESULT;
		const ship = launchExpedition(net, pick.port, pick.candidate, time, 1);
		if (ship < 0) { LAUNCH_RESULT.reason = LAUNCH_FAIL.reason || 'no hull free'; return LAUNCH_RESULT; }
		LAUNCH_RESULT.ok = 1;
		LAUNCH_RESULT.ship = ship;
		LAUNCH_RESULT.reason = '';
		return LAUNCH_RESULT;
	}

	// The per-port Send button (W7): the same launch as `launchBest`, but for
	// the port and candidate the row names. The row is a snapshot from the last
	// panel refresh, so every index is re-checked here — a stale row is ignored,
	// never thrown on. `rush` may sponsor a resting port, exactly like the
	// single button; a stale row launches nothing.
	const CHOSEN_RESULT = { ok: 0, ship: -1, source: -1, candidate: -1, reason: '' };
	function launchChosen(net, port, candidate, time, rush) {
		const r = CHOSEN_RESULT;
		r.ok = 0;
		r.ship = -1;
		r.source = port;
		r.candidate = candidate;
		r.reason = '';
		if (!expansionOn) { r.reason = 'expansion is off'; return r; }
		if (!(port >= 0 && port < net.portCount)) { r.reason = 'that port is gone'; return r; }
		if (!(candidate >= 0 && candidate < net.candidateCount)) { r.reason = 'that world is gone'; return r; }
		const source = net.ports[port];
		const c = net.candidates[candidate];
		if (c.used) { r.reason = 'that world is already settled'; return r; }
		if (c.reserved >= 0) { r.reason = 'an expedition is already bound for it'; return r; }
		if (portOfStar(net, c.site.key) >= 0) { r.reason = 'that star already has a colony'; return r; }
		if (source.colony.outpost) { r.reason = 'an outpost sponsors nothing'; return r; }
		const ready = portReadiness(net, port, time);
		if (ready.state !== 'live' && !(rush && ready.state === 'resting')) {
			r.reason = ready.why || 'this port cannot sponsor a wave';
			return r;
		}
		let founding = 0;
		for (let i = 0; i < net.shipCount; i++) if (net.ships[i].state === SHIP_FOUNDING) founding += 1;
		if (net.portCount + founding >= MAX_PORTS) { r.reason = 'network is full'; return r; }
		if (founding >= MAX_FOUNDING_IN_FLIGHT) { r.reason = 'too many expeditions in flight'; return r; }
		const ship = launchExpedition(net, port, candidate, time, rush ? 1 : 0);
		if (ship < 0) { r.reason = LAUNCH_FAIL.reason || 'no hull free'; return r; }
		r.ok = 1;
		r.ship = ship;
		return r;
	}

	// --- Pursuit and the give-up (trade-plan §9.4) --------------------------
	//
	// A hull is a steering agent: twice a second it re-aims at where its
	// destination is drawn *now*, re-times the remaining journey against the
	// predictor when the app wired one, and turns around when the leg has grown
	// past its cap. The old pass only re-timed — and a re-timed leg under shear
	// grows without bound, because the same motion that made the booking wrong
	// keeps stretching it, so the hull chased a star it could never reach.
	//
	// The aim point is the hull's own drawn position, not its departure port:
	// the remaining journey is from where it is. `legFrom`/`legTo` on the ship
	// are the chord fractions the overlay interpolates, so a divert reverses
	// them and the dot keeps moving instead of jumping to the far end.
	const RETIME_A = [0, 0, 0], RETIME_B = [0, 0, 0];

	// The chord fraction a hull is drawn at. Not the elapsed time over the
	// booked one: both endpoints move, so the chord under the hull changes, and
	// a hull that has flown its `speed × elapsed` light-years sits that distance
	// along the *current* chord. A chord that grows therefore holds the hull
	// back — a receding destination is a longer chase, not a leg that completes
	// itself — and a static sky makes this exactly the time fraction it was.
	function shipFraction(net, ship, time, chordLy) {
		const span = ship.legTo - ship.legFrom;
		const length = chordLy * (span < 0 ? -span : span);
		if (!(length > 0)) return 1;
		const flown = hullSpeed(ship.hull) * (time - ship.depart);
		let f = flown / length;
		if (!(f > 0)) return 0;
		return f > 1 ? 1 : f;
	}

	// Where a hull is drawn at `time`, from the cached endpoints and the chord
	// fractions. The one geometry the overlay, the readout and the re-aim share.
	function shipAim(out, net, ship, time, ax, ay, az, bx, by, bz) {
		const chordLy = separationLy(ax, ay, az, bx, by, bz);
		const f = shipFraction(net, ship, time, chordLy);
		const u = ship.legFrom + (ship.legTo - ship.legFrom) * f;
		out[0] = ax + (bx - ax) * u;
		out[1] = ay + (by - ay) * u;
		out[2] = az + (bz - az) * u;
		return out;
	}

	// The give-up. A hull whose voyage the sky has torn past its cap flies home
	// instead — the chord it is drawn on does not change (the overlay keeps both
	// ends), only the end it is heading for, and `legTo` flips to 0 so the dot
	// turns around where it is rather than jumping to the far end of its route.
	// `u` is the hull's chord fraction at the moment it turns.
	function divertShip(net, ship, time, u, chordKind, chordIndex) {
		net.diverted += 1;
		if (ship.state === SHIP_FOUNDING) {
			// A founding hull goes home with its party: the reservation is
			// released now (the world is free for a hull that can still reach it)
			// and the volunteers are refunded when the hull docks, on the same
			// path a taken world uses.
			releaseReservation(net, ship.index);
		}
		// The way home, in the same co-moving measurement: the chord from the
		// origin to the end the hull gave up on, with `u` of it still to fly back.
		ship.returning = 1;
		ship.legFrom = u;
		ship.legTo = 0;
		// The way home is the part of the chord the hull has already flown.
		const plan = solveRemaining(net, END_PORT, ship.from, chordKind, chordIndex,
			u, ship.hull, MAX_LEG_LY, DIVERT_PLAN);
		ship.depart = time;
		ship.arrive = time + plan.years;
		ship.leg = ship.arrive - ship.depart;
		scheduleShip(net, ship, ship.arrive, ship.state === SHIP_FOUNDING ? EV_FOUND : EV_ARRIVE);
	}

	function retimeRoutes(net) {
		for (let i = 0; i < net.shipCount; i++) {
			const ship = net.ships[i];
			if (ship.state !== SHIP_SAILING && ship.state !== SHIP_FOUNDING) continue;
			if (!(ship.arrive > ship.depart)) continue;
			const founding = ship.state === SHIP_FOUNDING;
			if (founding ? ship.candidate < 0 : ship.to < 0) continue;
			if (ship.from < 0) continue;
			// The chord the overlay draws the hull on, and the fraction of it the
			// hull is at and still has to fly.
			const chordKind = founding ? END_CANDIDATE : END_PORT;
			const chordIndex = founding ? ship.candidate : ship.to;
			endpointPos(net, END_PORT, ship.from, RETIME_A);
			endpointPos(net, chordKind, chordIndex, RETIME_B);
			const chordLy = separationLy(RETIME_A[0], RETIME_A[1], RETIME_A[2],
				RETIME_B[0], RETIME_B[1], RETIME_B[2]);
			const f = shipFraction(net, ship, net.time, chordLy);
			const u = ship.legFrom + (ship.legTo - ship.legFrom) * f;
			const remainingFrac = ship.legTo > u ? ship.legTo - u : u - ship.legTo;
			const capLy = founding ? MAX_FOUND_LY : MAX_LEG_LY;
			// The remaining journey, measured the way the booking measures it: the
			// endpoints' separation at arrival, times the part of the chord still
			// ahead. With no predictor this is the plain separation, which is what
			// pursuit reduces to when there is no horizon to buy.
			const plan = solveRemaining(net, END_PORT, ship.from, chordKind, chordIndex,
				remainingFrac, ship.hull, capLy, RETIME_PLAN, RETIME_ITERS);
			// The give-up has a margin: a leg the sky has pushed a little past its
			// cap is still flown (the hull is nearly there), one it has torn well
			// past it — or one the target outruns outright — is not.
			if (!ship.returning && (plan.outrun || plan.ly > capLy * DIVERT_FACTOR)) {
				divertShip(net, ship, net.time, u, chordKind, chordIndex);
				continue;
			}
			const arrive = net.time + plan.years;
			if (!(arrive > ship.depart)) continue;
			if (Math.abs(arrive - ship.arrive) <= 1.0) continue;
			ship.arrive = arrive;
			ship.leg = ship.arrive - ship.depart;
			ship.revision = (ship.revision + 1) >>> 0;
			scheduleShip(net, ship, arrive, founding ? EV_FOUND : EV_ARRIVE);
		}
	}
	const AIM_POS = [0, 0, 0];

	// The whole target star, not just the settled site: every reservation a hull
	// holds is released when its voyage ends, whichever way it ends.
	function releaseReservation(net, shipIndex) {
		for (let i = 0; i < net.candidateCount; i++) {
			if (net.candidates[i].reserved === shipIndex) net.candidates[i].reserved = -1;
		}
	}

	// A founding hull that has to give up — its world was taken while it flew,
	// or the sky pulled the world past the reach of the hull (§9.4) — puts the
	// volunteers back into the population they were drawn from, and docks at its
	// source for a normal load. A failed voyage must not delete people from the
	// ledger, and must never leave a ship eventless.
	function returnFounder(net, ship, time) {
		pushLog(net, LOG_EXPEDITION, ship.from >= 0 ? ship.from : -1, -1, 1);
		if (ship.from >= 0 && ship.cargo === economy.R_PEOPLE) {
			givePortPopulation(net, ship.from, ship.amount * POP_PER_COLONIST_UNIT);
		}
		ship.returning = 0;
		ship.legFrom = 0;
		ship.legTo = 1;
		ship.amount = 0;
		ship.cargo = NO_RESOURCE;
		ship.port = ship.from;
		ship.to = -1;
		ship.candidate = -1;
		ship.hold = HULLS[ship.hull].hold;
		ship.state = SHIP_DOCKED;
		scheduleShip(net, ship, time + DOCK_YEARS, EV_LOAD);
	}

	function foundAtCandidate(net, ship, time) {
		releaseReservation(net, ship.index);
		// Turned around mid-flight: home with the party, no colony founded.
		if (ship.returning) { returnFounder(net, ship, time); return; }
		const c = net.candidates[ship.candidate];
		const available = c && !c.used && portOfStar(net, c.site.key) < 0;
		const portIndex = available ? addPort(net, c.site, time, FRESH_FOUND) : -1;
		if (portIndex < 0) {
			// The star was taken while the party was in flight.
			returnFounder(net, ship, time);
			return;
		}
		c.used = 1;
		const colony = net.ports[portIndex].colony;
		// The expedition's people are the founding population; foundColony gave
		// the record its founding stores and its age. No settle: the colony is
		// founded now. Its first sponsored wave waits a full cooldown from this
		// instant — a network doubles by founding from colonies that have had a
		// life of their own, not by a chain reaction inside one tick.
		net.ports[portIndex].lastExpedition = time;
		colony.pop = Math.min(colony.capacity, ship.amount * POP_PER_COLONIST_UNIT);
		net.founded += 1;
		ship.founded += 1;
		pushLog(net, LOG_FOUND, portIndex, ship.from, 0);
		ship.cargo = NO_RESOURCE;
		ship.amount = 0;
		ship.hold = HULLS[ship.hull].hold;
		ship.state = SHIP_DOCKED;
		ship.port = portIndex;
		ship.to = -1;
		ship.candidate = -1;
		ship.returning = 0;
		scheduleShip(net, ship, time + DOCK_YEARS, EV_LOAD);
	}

	// --- The forward calendar (W8) ------------------------------------------
	//
	// The queue can answer what happens next without popping anything. Each
	// row is resolved against the ship it names and dropped when the ship's
	// revision no longer matches — a re-timed or turned-around voyage must not
	// appear twice, and a row that would describe a stale booking must not
	// appear at all. The rows are module scratch, refilled in place.
	const NEXT_TIME = new Float64Array(8);
	const NEXT_KIND = new Uint8Array(8);
	const NEXT_REF = new Uint32Array(8);
	const NEXT_REVISION = new Uint32Array(8);
	const NEXT_ROWS = [];
	for (let i = 0; i < 8; i++) NEXT_ROWS.push({ time: 0, kind: -1, port: -1, ship: -1 });

	function nextEvents(net, time, out, count) {
		const k = Math.max(1, Math.min(8, count | 0 || 4));
		const found = queueLib.peekNext(net.queue, NEXT_TIME, NEXT_KIND, NEXT_REF, NEXT_REVISION, k);
		const rows = out || NEXT_ROWS;
		let n = 0;
		for (let i = 0; i < found; i++) {
			const kind = NEXT_KIND[i];
			const row = rows[n];
			if (kind === EV_TICK) {
				row.time = NEXT_TIME[i];
				row.kind = kind;
				row.port = -1;
				row.ship = -1;
				n += 1;
				continue;
			}
			const ship = net.ships[NEXT_REF[i]];
			if (!ship || ship.revision !== NEXT_REVISION[i]) continue;
			row.time = NEXT_TIME[i];
			row.kind = kind;
			row.ship = NEXT_REF[i];
			row.port = kind === EV_ARRIVE ? ship.to : kind === EV_FOUND ? -1 : ship.port;
			n += 1;
		}
		return n;
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

	// One drain to `net.time + years`, with an optional event budget. A budget
	// that runs out stops the clock at the next due event instead of skipping
	// it: an event may never fire at a time earlier than the network's clock,
	// or the colonies it settles would be asked to run backwards. The clock is
	// therefore monotonic, and a budget-limited frame leaves the rest of the
	// due work (and the lag it represents) to the next one.
	function step(net, years, budget) {
		if (!(years > 0)) return 0;
		const before = net.processed;
		const start = net.time;
		const target = start + years;
		queueLib.drainUntil(net.queue, target, net.handler, budget);
		const next = queueLib.peekTime(net.queue);
		net.time = next < target ? (next > start ? next : start) : target;
		// The debt is cumulative: the clock never runs faster than the drain can
		// follow, so a frame that cannot keep up adds to the backlog for good
		// (the panel reports it instead of pretending the clock kept up).
		net.lag += target - net.time;
		return net.processed - before;
	}

	// Special trade mode: every hull flies the generation-ship crawl, 1 ly per
	// 33 trade years, and the ports' reserves stretch to the fleet's crossing time
	// (see GENERATION_RESERVE_YEARS). Live colonies are re-scaled in place, so
	// switching modes does not strand a network mid-voyage with a 150-year
	// larder and a 5 000-year supply line.
	function setGenerationMode(on, net) {
		const next = on > 0 ? 1 : 0;
		const scale = next ? GENERATION_RESERVE_YEARS / economy.STOCK_YEARS : 1;
		const factor = scale / economy.getReserveScale();
		economy.setReserveScale(scale);
		generationMode = next;
		if (net && factor !== 1) {
			for (let i = 0; i < net.portCount; i++) {
				const port = net.ports[i];
				for (let s = 0; s < port.worldCount; s++) {
					economy.rescaleColonyReserves(net.worlds[port.worldIdx[s]], factor);
				}
				foldPort(net, i);
			}
		}
		return generationMode;
	}

	// --- Draw state and the player -----------------------------------------

	// A ship's drawn position between its endpoints, for the galaxy overlay and
	// the readout. `time` is the drawn clock; the caller may interpolate at a
	// readout's instant instead. The endpoints are the cached live positions
	// while the sky moves — a hull rides the stars it flies between — and the
	// chord fractions carry a diverted hull back along the line it came out on
	// (§9.4), so a dot never jumps.
	function shipPosition(net, index, time, out) {
		const ship = net.ships[index];
		if (ship.from < 0 || (ship.state === SHIP_FOUNDING ? ship.candidate < 0 : ship.to < 0) || ship.arrive <= ship.depart) {
			if (ship.port >= 0) return endpointPos(net, END_PORT, ship.port, out);
			if (ship.from >= 0) return endpointPos(net, END_PORT, ship.from, out);
			out[0] = 0; out[1] = 0; out[2] = 0;
			return out;
		}
		const kindB = ship.state === SHIP_FOUNDING ? END_CANDIDATE : END_PORT;
		const indexB = ship.state === SHIP_FOUNDING ? ship.candidate : ship.to;
		endpointPos(net, END_PORT, ship.from, SHP_A);
		endpointPos(net, kindB, indexB, SHP_B);
		return shipAim(out, net, ship, time, SHP_A[0], SHP_A[1], SHP_A[2], SHP_B[0], SHP_B[1], SHP_B[2]);
	}
	const SHP_A = [0, 0, 0], SHP_B = [0, 0, 0];

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
	// it: the port's spare stock, ranked by the value that fits the hold.
	// Stocks are divisible, so this preserves fractional units too.
	function playerExport(net, portIndex, freeTons) {
		const colony = net.ports[portIndex].colony;
		let best = -1, bestScore = 0;
		for (let r = 0; r < economy.RESOURCE_COUNT; r++) {
			if (economy.RESOURCES[r].interFamily < 0) continue;
			const spare = economy.exportableOf(colony, r);
			if (spare <= 0) continue;
			const fits = economy.unitsForTons(r, freeTons);
			if (fits <= 0) continue;
			const loadable = spare < fits ? spare : fits;
			const score = loadable * economy.RESOURCES[r].worth;
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
		if (port.colony.outpost) {
			PLAYER_RESULT.reason = 'outpost \u2014 no trade here';
			return PLAYER_RESULT;
		}
		settlePort(net, portIndex, net.time);
		const carried = ship.cargoResource === undefined ? -1 : ship.cargoResource;
		const freeTons = ship.class.cargo - ship.cargo;
		const resource = ship.cargo > 0 && carried >= 0 ? carried : playerExport(net, portIndex, freeTons);
		if (resource < 0) {
			PLAYER_RESULT.reason = freeTons <= 0 ? 'hold full' : 'nothing to buy that fits the hold';
			return PLAYER_RESULT;
		}
		const fits = economy.unitsForTons(resource, freeTons);
		if (fits <= 0) { PLAYER_RESULT.reason = 'hold full'; return PLAYER_RESULT; }
		const units = collectPortOutbound(net, portIndex, resource, fits);
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
		if (port.colony.outpost) {
			PLAYER_RESULT.reason = 'outpost \u2014 no trade here';
			return PLAYER_RESULT;
		}
		settlePort(net, portIndex, net.time);
		const units = economy.unitsForTons(r, ship.cargo);
		const given = distributePortInbound(net, portIndex, r, units);
		const tons = economy.tonsForUnits(r, given);
		ship.cargo -= tons;
		if (given === units) {
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
		MAX_PORTS, MAX_WORLDS_PER_STAR, MAX_WORLDS, MIN_FOUND_COUPLE,
		MAX_SHIPS, MAX_FREIGHTERS, MAX_CANDIDATES, TRADE_RATES, TRADE_RATE_DEFAULT,
		TRADE_RATE_DEFAULT_INDEX, TRADE_ROUTES_DEFAULT,
		SYNC_YEARS_PER_MYR, RATE_MAX, GENERATION_LY_PER_YEAR, GENERATION_RESERVE_YEARS, GENERATION_STAR_MYR,
		MIN_LEG_YEARS, SEED_PORTS, START_RADIUS_KPC, START_FIELD, clockRate,
		EV_ARRIVE, EV_LOAD, EV_WAIT, EV_FOUND, EV_TICK, nextEvents,
		MAX_ROUTES, createRoutes, routeIndexOf, commissionRoute, removeRoute,
		activeRouteCount, noteRouteDeparture, routeLegYears, ROUTE_RESULT,
		SHIP_DOCKED, SHIP_SAILING, SHIP_WAITING, SHIP_FOUNDING, SHIP_STATE_NAMES,
		LOG_CAP, LOG_FOUND, LOG_MILESTONE, LOG_FAMINE, LOG_FAMINE_END, LOG_OUTPOST,
		LOG_ROUTE, LOG_EXPEDITION, createLog, pushLog, logLength, logAt,
		HULLS, DOCK_YEARS, WAIT_YEARS, TICK_YEARS,
		POP_PER_COLONIST_UNIT, EXPEDITION_COOLDOWN, MAX_FOUNDING_IN_FLIGHT,
		VOLUNTEER_FRAC, FOUNDERS_MIN_M, FOUNDERS_MAX_M, MIN_FOUNDERS_REMAIN_M,
		MAX_FOUND_LY, MAX_LEG_LY, LY_PER_KPC, HOME_COLONY_LY, NO_RESOURCE,
		MIN_CANDIDATE_HABITAT,
		MIN_EXPEDITION_POP_M, MIN_EXPEDITION_COVERAGE,
		setExpansion, expansionArmed, portReadiness, launchChosen, CHOSEN_RESULT,
		ROLLED_FOUND, FRESH_FOUND, createFoundResult, playerFound,
		createWorldFoundResult, playerFoundWorld,
		createNetwork, addPort, addWorld, worldOfPort, worldOfSite, foldPort,
		distributePortInbound, collectPortOutbound,
		discoverSystem, discoverNearest, startSystems, settleSystem, settlePort, finalize, step, settleAllPorts,
		portOfStar, portOfStarLive, livePortCount, demotePort,
		portIndexOf, candidateIndexOf, bestPortOfStar, distanceLy, legYears, pickDestination, pickExport,
		shipPosition, shipProgress, shipStateName, playerPort, playerLoad, playerUnload,
		siteHabitatScore, isBigColony, colonisationPreview, pickCandidate, bestExpedition,
		launchBest, launchExpedition, returnFounder, retimeRoutes, colonisationStatus,
		expandFrontierFromField, setGenerationMode, generationMode: setGenerationMode,
		refreshGeometry, endpointPos, endpointDistanceLy, planLeg, bookLeg, shipFraction,
		createLegPlan, frontierStretchKpc, DIVERT_FACTOR, END_PORT, END_CANDIDATE,
	};

	if (typeof module !== 'undefined') module.exports = TradeLib;
	if (typeof window !== 'undefined') window.TradeLib = TradeLib;
})();
