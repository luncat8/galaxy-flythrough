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
	const FOUND_STOCK_FRAC = 0.45;
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

	// A shipment is sized to the destination's draw, not to the hold: a hold
	// that arrives full at a port which can take a tenth of it parks the rest
	// in orbit and starves the next port on the list.
	const SHIPMENT_YEARS = 150;

	// Hash streams beyond the economy's own.
	const TR_CH_SHIP = 740, TR_CH_PORT = 760;

	function createPort() {
		return {
			colony: economy.createColony(),
			key: 0, name: '', kind: 0, index: 0,
			arrivals: 0, received: 0,
			// Trade years of the last sponsored expedition; `-INF` marks a seed
			// port, ready as soon as its colony passes the big gate.
			lastExpedition: -1e9,
			x: 0, y: 0, z: 0,
			ref: { kind: 0, index: 0, key: 0, x: 0, y: 0, z: 0, colorIndex: 0, absMag: 0 },
		};
	}

	function createShip() {
		return {
		index: 0, hull: 0, hold: 0, cargo: NO_RESOURCE, amount: 0,
		state: SHIP_DOCKED, port: -1, from: -1, to: -1, candidate: -1,
		depart: 0, arrive: 0, leg: 0, revision: 0, trips: 0, delivered: 0, founded: 0, waits: 0,
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
			seedPorts: SEED_PORTS,
			shipCount: 0,
			candidateCount: 0,
			discovered: new Set(),
			ports: [],
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
			handler: null,
		};
		for (let i = 0; i < MAX_PORTS; i++) net.ports.push(createPort());
		for (let i = 0; i < MAX_SHIPS; i++) net.ships.push(createShip());
		for (let i = 0; i < MAX_CANDIDATES; i++) net.candidates.push(createCandidate());
		// The drain's callback: one closure per network, never per event.
		net.handler = (time, kind, ref, revision) => handleEvent(net, time, kind, ref, revision);
		net.livePosition = options && options.livePosition ? options.livePosition : null;
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
			if (port.key !== key || port.colony.abandoned) continue;
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

	// A port's drawn position: the star's live drawn position when a live
	// position resolver is wired (the stars move with star time), else the
	// birth position the port was settled at. `ref` is the port's identity;
	// the fallbacks are the cached birth coordinates.
	function positionOf(net, ref, fx, fy, fz, out) {
		if (net.livePosition && net.livePosition(ref, out)) return out;
		out[0] = fx; out[1] = fy; out[2] = fz;
		return out;
	}

	const LEG_A = [0, 0, 0], LEG_B = [0, 0, 0];

	// THE trade-clock law: a leg's length in trade years. Speed is the hull's
	// authored `lyPerYear`, or the generation-ship pace (1 ly per 33 y)
	// while the special trade mode is on. The floor keeps two ports at one
	// coordinate from making a zero-length voyage (a zero-length event would
	// let a ship cycle forever inside one step), and keeps a short hop visible.
	function legYears(distanceKpc, hullIndex) {
		const ly = distanceKpc * LY_PER_KPC;
		const speed = generationMode ? GENERATION_LY_PER_YEAR : HULLS[hullIndex].lyPerYear;
		const years = ly / speed;
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
		for (let i = 0; i < net.portCount; i++) {
			const colony = net.ports[i].colony;
			if (colony.abandoned) continue;
			economy.settleColony(colony, time);
		}
	}

	function pickDestination(net, from, resource) {
		const worth = economy.RESOURCES[resource].worth;
		let best = -1, bestScore = 0;
		for (let i = 0; i < net.portCount; i++) {
			if (i === from) continue;
			const port = net.ports[i];
			if (port.colony.abandoned) continue;
			// The caller settled every port to `time` (settleAllPorts), so this
			// reads the world as it is at the event's own clock, not as its last
			// visitor left it.
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
	function pickExport(net, from, hold) {
		let bestResource = -1, bestDest = -1, bestAmount = 0, bestScore = 0;
		for (let r = 0; r < economy.RESOURCE_COUNT; r++) {
			if (r === economy.R_PEOPLE) continue;
			const spare = economy.exportableOf(net.ports[from].colony, r);
			if (spare <= 0) continue;
			const dest = pickDestination(net, from, r);
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
		// A hull that found work stops backing off.
		ship.waits = 0;
		ship.depart = time;
		ship.arrive = time + liveLegYears(net, port, dest, ship.hull);
		ship.leg = ship.arrive - ship.depart;          // booked journey; speed is constant, so time fraction == distance fraction
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
			const dest = pickDestination(net, portIndex, ship.cargo);
			if (dest >= 0) { sailTo(net, ship, dest, time); return; }
			// Nobody has room for it. Jettison rather than deadlock the hull with
			// a cargo that every port is already full of; the next load starts
			// clean.
			ship.cargo = NO_RESOURCE;
			ship.amount = 0;
		}
		const pick = pickExport(net, portIndex, ship.hold);
		if (pick.resource < 0) { waitAtPort(net, ship, time); return; }
		const taken = economy.takeFromColony(port.colony, pick.resource, pick.amount);
		if (taken <= 0) { waitAtPort(net, ship, time); return; }
		ship.cargo = pick.resource;
		ship.amount = taken;
		sailTo(net, ship, pick.dest, time);
	}

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
		if (colony.abandoned) return false;
		if (colony.pop < MIN_EXPEDITION_POP_M) return false;
		if (colony.coverage < MIN_EXPEDITION_COVERAGE) return false;
		if (colony.pop < colony.capacity * 0.08) return false;
		return true;
	}

	function pickCandidate(net, from) {
		const port = net.ports[from];
		let best = -1, bestScore = 0;
		for (let i = 0; i < net.candidateCount; i++) {
			const c = net.candidates[i];
			if (c.used || c.reserved >= 0) continue;
			if (portOfStar(net, c.site.key) >= 0) continue;
			const site = c.site;
			const dx = site.x - port.x, dy = site.y - port.y, dz = site.z - port.z;
			const ly = Math.sqrt(dx * dx + dy * dy + dz * dz) * LY_PER_KPC;
			if (ly > MAX_FOUND_LY) continue;
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
			if (colony.abandoned) continue;
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
			const dx = site.x - port.x, dy = site.y - port.y, dz = site.z - port.z;
			const ly = Math.sqrt(dx * dx + dy * dy + dz * dz) * LY_PER_KPC;
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
		let added = 0;
		let fi = net.frontierCursor | 0;
		const nearSq = MAX_FOUND_KPC * MAX_FOUND_KPC;
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
		let room = MAX_FOUNDING_IN_FLIGHT - founding;
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

	function launchExpedition(net, source, candidateIndex, time, rush) {
		const sourcePort = net.ports[source];
		if (!rush && time - sourcePort.lastExpedition < EXPEDITION_COOLDOWN) return -1;
		expeditionCost(sourcePort.colony, EXPEDITION_COST);
		if (!(EXPEDITION_COST.peopleM > 0)) return -1;
		if (sourcePort.colony.pop - EXPEDITION_COST.peopleM < MIN_FOUNDERS_REMAIN_M) return -1;
		const shipIndex = freeShip(net);
		if (shipIndex < 0) return -1;
		const colonists = EXPEDITION_COST.people;
		sourcePort.colony.pop -= EXPEDITION_COST.peopleM;
		sourcePort.lastExpedition = time;
		const ship = net.ships[shipIndex];
		const site = net.candidates[candidateIndex].site;
		for (let i = 0; i < net.candidateCount; i++) {
			if (net.candidates[i].site.key === site.key) net.candidates[i].reserved = shipIndex;
		}
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
		ship.arrive = time + liveLegYears(net, sourcePort, site, ship.hull);
		ship.leg = ship.arrive - ship.depart;
		ship.revision = 0;
		ship.trips = 0;
		ship.delivered = 0;
		ship.founded = 0;
		scheduleShip(net, ship, ship.arrive, EV_FOUND);
		return shipIndex;
	}

	// A voyage booked from where its endpoints are drawn now: while the star
	// clock runs the route endpoints are the stars' live positions, so the leg
	// is measured from where the ports are when the hull leaves. `b` is a port
	// or a candidate site (both carry a ref and birth coordinates).
	function liveLegYears(net, a, b, hullIndex) {
		positionOf(net, a.ref, a.x, a.y, a.z, LEG_A);
		positionOf(net, b.ref, b.x, b.y, b.z, LEG_B);
		const dx = LEG_A[0] - LEG_B[0], dy = LEG_A[1] - LEG_B[1], dz = LEG_A[2] - LEG_B[2];
		return legYears(Math.sqrt(dx * dx + dy * dy + dz * dz), hullIndex);
	}

	// The panel's Send-expedition button: the tick's own choice, launched now
	// instead of waiting for the next 25-year tick. Same cost, same fleet
	// limit, same reservation; a port still resting from its last wave can be
	// rushed, and its 900-year clock restarts from this launch.
	const LAUNCH_RESULT = { ok: 0, ship: -1, source: -1, candidate: -1, reason: '' };
	function launchBest(net, time) {
		// The button is the player's hand: it may sponsor a port that is still
		// resting, and that port's cooldown restarts from now. The automatic
		// tick always waits its turn.
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
		if (ship < 0) { LAUNCH_RESULT.reason = 'no hull free'; return LAUNCH_RESULT; }
		LAUNCH_RESULT.ok = 1;
		LAUNCH_RESULT.ship = ship;
		LAUNCH_RESULT.reason = '';
		return LAUNCH_RESULT;
	}

	// Re-time in-flight voyages while the stars move: the booked leg length is
	// the departure-time distance, but the drawn route endpoints are the stars'
	// live positions. Re-measure the remaining journey and reschedule the arrival
	// when it moves by more than a year; an endpoint that is not resident falls
	// back to its birth coordinates.
	// Retiming is a per-frame pass while the sky moves, so its scratch is
	// module-owned: no literals in the loop.
	const RETIME_A = [0, 0, 0], RETIME_B = [0, 0, 0];
	function retimeRoutes(net) {
		for (let i = 0; i < net.shipCount; i++) {
			const ship = net.ships[i];
			if (ship.state !== SHIP_SAILING && ship.state !== SHIP_FOUNDING) continue;
			if (!(ship.arrive > ship.depart)) continue;
			const a = ship.from >= 0 ? net.ports[ship.from] : null;
			const b = ship.state === SHIP_FOUNDING
				? (ship.candidate >= 0 ? net.candidates[ship.candidate].site : null)
				: (ship.to >= 0 ? net.ports[ship.to] : null);
			if (!a || !b) continue;
			if (!positionOf(net, a.ref, a.x, a.y, a.z, RETIME_A)) continue;
			if (!positionOf(net, b.ref, b.x, b.y, b.z, RETIME_B)) continue;
			const dx = RETIME_A[0] - RETIME_B[0], dy = RETIME_A[1] - RETIME_B[1], dz = RETIME_A[2] - RETIME_B[2];
			const total = legYears(Math.sqrt(dx * dx + dy * dy + dz * dz), ship.hull);
			// The booked journey: speed is constant, so the time fraction equals the
			// distance fraction even after a previous re-time changed ship.arrive.
			let f = ship.leg > 0 ? (net.time - ship.depart) / ship.leg : 0;
			if (f < 0) f = 0;
			if (f > 1) f = 1;
			const arrive = net.time + (1 - f) * total;
			if (!(arrive > ship.depart)) continue;
			if (Math.abs(arrive - ship.arrive) <= 1.0) continue;
			ship.arrive = arrive;
			ship.revision = (ship.revision + 1) >>> 0;
			scheduleShip(net, ship, arrive, ship.state === SHIP_FOUNDING ? EV_FOUND : EV_ARRIVE);
		}
	}

	function foundAtCandidate(net, ship, time) {
		const c = net.candidates[ship.candidate];
		const available = c && !c.used && portOfStar(net, c.site.key) < 0;
		const portIndex = available ? addPort(net, c.site, time) : -1;
		for (let i = 0; i < net.candidateCount; i++) {
			if (net.candidates[i].reserved === ship.index) net.candidates[i].reserved = -1;
		}
		if (portIndex < 0) {
			// The star was taken while the party was in flight. Put the
			// volunteers back into the source's population — they were drawn
			// from it, and a failed voyage must not delete people from the
			// ledger — then send the empty hull home for a normal load.
			if (ship.from >= 0 && ship.cargo === economy.R_PEOPLE) {
				const home = net.ports[ship.from].colony;
				const returning = ship.amount * POP_PER_COLONIST_UNIT;
				home.pop = Math.min(home.capacity, home.pop + returning);
			}
			ship.amount = 0;
			ship.cargo = NO_RESOURCE;
			ship.port = ship.from;
			ship.to = -1;
			ship.candidate = -1;
			ship.hold = HULLS[ship.hull].hold;
			scheduleShip(net, ship, time + DOCK_YEARS, EV_LOAD);
			ship.state = SHIP_DOCKED;
			return;
		}
		c.used = 1;
		const colony = net.ports[portIndex].colony;
		// The expedition's people are the founding population; the stores it
		// carried become the first stock. No settle: the colony is founded now.
		// Its first sponsored wave waits a full cooldown from this instant — a
		// network doubles by founding from colonies that have had a life of
		// their own, not by a chain reaction inside one tick.
		colony.founded = time;
		colony.last = time;
		net.ports[portIndex].lastExpedition = time;
		colony.pop = Math.min(colony.capacity, ship.amount * POP_PER_COLONIST_UNIT);
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
			for (let i = 0; i < net.portCount; i++) economy.rescaleColonyReserves(net.ports[i].colony, factor);
		}
		return generationMode;
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
	// it: the port's spare stock, ranked by the value that fits the hold.
	// Stocks are divisible, so this preserves fractional units too.
	function playerExport(net, portIndex, freeTons) {
		const colony = net.ports[portIndex].colony;
		let best = -1, bestScore = 0;
		for (let r = 0; r < economy.RESOURCE_COUNT; r++) {
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
		economy.settleColony(port.colony, net.time);
		const carried = ship.cargoResource === undefined ? -1 : ship.cargoResource;
		const freeTons = ship.class.cargo - ship.cargo;
		const resource = ship.cargo > 0 && carried >= 0 ? carried : playerExport(net, portIndex, freeTons);
		if (resource < 0) {
			PLAYER_RESULT.reason = freeTons <= 0 ? 'hold full' : 'nothing to buy that fits the hold';
			return PLAYER_RESULT;
		}
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
		MAX_PORTS, MAX_SHIPS, MAX_FREIGHTERS, MAX_CANDIDATES, TRADE_RATES, TRADE_RATE_DEFAULT,
		TRADE_RATE_DEFAULT_INDEX, TRADE_ROUTES_DEFAULT,
		SYNC_YEARS_PER_MYR, RATE_MAX, GENERATION_LY_PER_YEAR, GENERATION_RESERVE_YEARS, GENERATION_STAR_MYR,
		MIN_LEG_YEARS, SEED_PORTS, START_RADIUS_KPC, START_FIELD, clockRate,
		EV_ARRIVE, EV_LOAD, EV_WAIT, EV_FOUND, EV_TICK,
		SHIP_DOCKED, SHIP_SAILING, SHIP_WAITING, SHIP_FOUNDING, SHIP_STATE_NAMES,
		HULLS, DOCK_YEARS, WAIT_YEARS, TICK_YEARS,
		POP_PER_COLONIST_UNIT, EXPEDITION_COOLDOWN, MAX_FOUNDING_IN_FLIGHT,
		VOLUNTEER_FRAC, FOUNDERS_MIN_M, FOUNDERS_MAX_M, MIN_FOUNDERS_REMAIN_M,
		MAX_FOUND_LY, MAX_LEG_LY, LY_PER_KPC, HOME_COLONY_LY, NO_RESOURCE,
		MIN_EXPEDITION_POP_M, MIN_EXPEDITION_COVERAGE,
		createNetwork, discoverSystem, discoverNearest, startSystems, settleSystem, finalize, step, settleAllPorts,
		portIndexOf, candidateIndexOf, bestPortOfStar, distanceLy, legYears,
		shipPosition, shipProgress, shipStateName, playerPort, playerLoad, playerUnload,
		siteHabitatScore, isBigColony, colonisationPreview, pickCandidate, bestExpedition,
		launchBest, launchExpedition, retimeRoutes, colonisationStatus,
		expandFrontierFromField, setGenerationMode, generationMode: setGenerationMode,
	};

	if (typeof module !== 'undefined') module.exports = TradeLib;
	if (typeof window !== 'undefined') window.TradeLib = TradeLib;
})();
