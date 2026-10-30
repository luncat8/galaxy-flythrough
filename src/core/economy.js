// src/core/economy.js
// The colony economy: the resource table, the stable-hash site map, and the
// closed-form settle that lets a colony's factories run "per ship arrival or
// on inspection" instead of per frame (trade-plan.md §2).
//
// Units. Population is millions; production and need are units per
// million-year; stock is units; a unit's mass in tonnes is the one bridge to
// the game mode's cargo hold. Time is years on the trade clock.
//
// Everything here is a pure function of (model seed, star key, planet slot)
// plus the colony's current state — no PRNG state, no allocation in settle,
// and the caller owns every record.

'use strict';

(function () {
	'use strict';

	const planets = (typeof module !== 'undefined' && module.exports)
		? require('../math/planets.js')
		: window.PlanetsLib;
	const hash = (typeof module !== 'undefined' && module.exports)
		? require('../math/hash.js')
		: window.HashLib;

	// --- Resources (trade-plan.md §2) ---------------------------------------
	const RESOURCE_COUNT = 13;
	const R_ORE = 0, R_VOLATILE = 1, R_RARE = 2, R_CHEM = 3, R_AMAT = 4,
		R_FOOD = 5, R_BIO = 6, R_PEOPLE = 7, R_ROBOTS = 8, R_COMPUTE = 9,
		R_SOFT = 10, R_DATA = 11, R_ART = 12;

	// `unitMassT` converts the player's tonnage into stock units; `worth` is
	// the routing weight only — the economy has no money and no prices.
	//
	// `family` is the authored production family (raw/synth/life/goods/data/
	// culture) and is not repurposed. `intraFamily` and `interFamily` are the
	// two-tier routing maps (trade-3-plan §3): the intra families are the
	// flows inside a star (T4's statistical trade), the inter families are
	// what an inter-star hull may load. A resource may sit in both: chem is a
	// local flow and a shipped specialist good, ore and volatiles are bulk
	// feedstock that never leaves the system.
	// The two routing maps, by id (index into the table below). `-1` means "not
	// in this tier": bulk never ships between stars, while the three intra
	// families are statistical flows inside one star (T4), never queue events.
	const INTRA_BULK = 0, INTRA_GOODS = 1, INTRA_PAX = 2;
	const INTER_RARE = 0, INTER_EXOTIC = 1, INTER_AMAT = 2, INTER_FOOD = 3,
		INTER_FAB = 4, INTER_INFO = 5, INTER_PAX = 6;
	const INTRA_FAMILY_NAMES = ['bulk', 'goods', 'pax'];
	const INTRA_FAMILY_SHORT = ['bulk', 'goods', 'pax'];
	const INTER_FAMILY_NAMES = ['rare elements', 'specialist chem', 'antimatter',
		'food & seed', 'factory cores', 'information', 'passengers'];
	const INTER_FAMILY_SHORT = ['rare', 'exotic', 'amat', 'food', 'fab', 'info', 'pax'];

	const RESOURCES = [
		{ id: 'ore', name: 'ore', family: 'raw', intraFamily: INTRA_BULK, interFamily: -1, unitMassT: 40, worth: 0.25 },
		{ id: 'volatile', name: 'volatiles', family: 'raw', intraFamily: INTRA_BULK, interFamily: -1, unitMassT: 30, worth: 0.30 },
		{ id: 'rare', name: 'rare elements', family: 'raw', intraFamily: -1, interFamily: INTER_RARE, unitMassT: 60, worth: 6 },
		{ id: 'chem', name: 'synth chemicals', family: 'synth', intraFamily: INTRA_GOODS, interFamily: INTER_EXOTIC, unitMassT: 12, worth: 1.2 },
		{ id: 'amat', name: 'antimatter', family: 'synth', intraFamily: -1, interFamily: INTER_AMAT, unitMassT: 0.5, worth: 12 },
		{ id: 'food', name: 'food & seed', family: 'life', intraFamily: -1, interFamily: INTER_FOOD, unitMassT: 8, worth: 0.8 },
		{ id: 'bio', name: 'biotech samples', family: 'life', intraFamily: -1, interFamily: INTER_EXOTIC, unitMassT: 4, worth: 4 },
		{ id: 'people', name: 'colonists', family: 'life', intraFamily: INTRA_PAX, interFamily: INTER_PAX, unitMassT: 2, worth: 3 },
		{ id: 'robots', name: 'factory cores', family: 'goods', intraFamily: INTRA_GOODS, interFamily: INTER_FAB, unitMassT: 25, worth: 2.5 },
		{ id: 'compute', name: 'computers', family: 'goods', intraFamily: INTRA_GOODS, interFamily: INTER_FAB, unitMassT: 6, worth: 3.5 },
		{ id: 'soft', name: 'software & AI', family: 'data', intraFamily: -1, interFamily: INTER_INFO, unitMassT: 0.2, worth: 5 },
		{ id: 'data', name: 'world data', family: 'data', intraFamily: -1, interFamily: INTER_INFO, unitMassT: 0.2, worth: 4 },
		{ id: 'art', name: 'unique items', family: 'culture', intraFamily: -1, interFamily: INTER_INFO, unitMassT: 1, worth: 8 },
	];

	// Gross production and population need per million per year at yield 1.
	const PROD = new Float64Array([0.55, 0.62, 0.120, 0.14, 0.050, 0.62, 0.050, 0.20, 0.050, 0.050, 0.020, 0.022, 0.006]);
	const NEED = new Float64Array([0, 0.20, 0.006, 0.06, 0.002, 0.18, 0.010, 0, 0.020, 0.012, 0.010, 0.008, 0.002]);
	// How much a shortfall in each resource throttles growth. Food and
	// volatiles are survival; the rest are the quality of life the advanced
	// goods buy.
	const NEED_WEIGHT = new Float64Array([0, 3.0, 0.6, 1.5, 0.15, 3.0, 0.3, 0, 0.7, 0.7, 0.45, 0.35, 0.12]);

	// The industrial bill of materials: producing one unit of the row good
	// consumes the listed units of column goods. NEED above is what people
	// eat and burn; this table is what the factories eat, and it is what gives
	// ore and volatiles a market — without it the bulk raw goods would pile up
	// in every warehouse and no ship would ever load them.
	const INPUT = new Float64Array(RESOURCE_COUNT * RESOURCE_COUNT);
	(function buildInputs() {
		const rows = [
			R_VOLATILE, R_ORE, 0.15,
			R_RARE, R_ORE, 0.50,
			R_CHEM, R_VOLATILE, 0.60,
			R_CHEM, R_ORE, 0.20,
			R_AMAT, R_RARE, 0.80,
			R_AMAT, R_VOLATILE, 1.20,
			R_AMAT, R_CHEM, 0.50,
			R_FOOD, R_VOLATILE, 0.15,
			R_FOOD, R_CHEM, 0.05,
			R_BIO, R_FOOD, 0.15,
			R_BIO, R_VOLATILE, 0.05,
			R_PEOPLE, R_FOOD, 0.12,
			R_PEOPLE, R_BIO, 0.02,
			R_ROBOTS, R_ORE, 1.20,
			R_ROBOTS, R_VOLATILE, 0.60,
			R_ROBOTS, R_COMPUTE, 0.15,
			R_COMPUTE, R_RARE, 0.15,
			R_COMPUTE, R_CHEM, 0.50,
			R_COMPUTE, R_VOLATILE, 0.30,
			R_SOFT, R_COMPUTE, 0.25,
			R_SOFT, R_DATA, 0.10,
			R_DATA, R_COMPUTE, 0.20,
			R_DATA, R_SOFT, 0.05,
			R_ART, R_RARE, 0.15,
			R_ART, R_BIO, 0.10,
			R_ART, R_DATA, 0.10,
		];
		for (let i = 0; i < rows.length; i += 3) INPUT[rows[i] * RESOURCE_COUNT + rows[i + 1]] = rows[i + 2];
	}());

	// The authored planet table, trade-plan.md §2.1: rows are resources,
	// columns the ten display types plus the belt. Read as "how much of this
	// resource this kind of world can make", 0 = none … 1.4 = its best.
	const SITE_BELT = 10;
	const PLANET = [
		[1.20, 0.90, 0.50, 0.15, 0.10, 0.60, 0.00, 0.00, 0.00, 0.70, 1.60], // ore
		[1.00, 0.20, 0.20, 0.30, 1.40, 0.40, 1.30, 1.50, 1.40, 0.30, 1.20], // volatile
		[1.00, 0.70, 0.10, 0.00, 0.00, 0.15, 0.00, 0.00, 0.00, 0.50, 1.10], // rare
		[0.50, 0.20, 0.60, 1.00, 0.60, 0.80, 0.50, 0.50, 0.40, 0.00, 0.20], // chem
		[0.30, 0.00, 0.00, 0.00, 0.30, 0.00, 0.10, 0.50, 0.60, 0.00, 0.00], // amat
		[0.05, 0.00, 0.50, 1.40, 0.25, 0.70, 0.05, 0.00, 0.00, 0.00, 0.10], // food
		[0.00, 0.00, 0.20, 1.20, 0.30, 0.60, 0.00, 0.00, 0.00, 0.00, 0.02], // bio
		[0.00, 0.00, 0.40, 1.20, 0.00, 0.70, 0.00, 0.00, 0.00, 0.00, 0.10], // people
		[0.40, 0.50, 0.30, 0.70, 0.20, 0.60, 0.15, 0.10, 0.10, 0.20, 0.80], // robots
		[0.00, 0.00, 0.50, 1.00, 0.00, 0.70, 0.00, 0.00, 0.00, 0.00, 0.10], // compute
		[0.00, 0.00, 0.20, 1.20, 0.00, 0.50, 0.00, 0.00, 0.00, 0.00, 0.00], // soft
		[0.00, 0.00, 0.20, 1.00, 0.00, 0.50, 0.00, 0.00, 0.00, 0.00, 0.00], // data
		[0.00, 0.00, 0.05, 0.80, 0.00, 0.30, 0.00, 0.00, 0.00, 0.00, 0.00], // art
	];

	// Carrying capacity: base millions × habitat weight × size × stability.
	const POP_CAP_BASE = 900;
	const HABITAT = new Float64Array([0.04, 0.16, 0.35, 1.00, 0.18, 0.70, 0.12, 0.20, 0.12, 0.03]);
	const HABITAT_BELT = 0.10;

	// A colony is read on the trade clock, which runs at 100 years a wall
	// second by default: an 80-year e-folding put a new world's ring nearly
	// still for ten seconds, and the expansion it should feed never started.
	// Half that keeps the logistic visibly alive (about 0.7 %/y at the
	// authored coverage) without turning the six largest colonies into a
	// blink at the top of the ladder.
	const G_MAX = 1 / 40;              // per year, fully supplied
	const DECLINE = 1 / 120;           // per year, fully starved
	const NEED_BUFFER_Y = 20;          // years of stock that count as supply
	const STOCK_BASE = 30;
	const STOCK_YEARS = 150;           // warehouse size in years of throughput
	const EXPORT_RESERVE_FRAC = 0.25;  // stock a port keeps before it sells
	// A colony below this population has failed: it stops (outpost, trade-2
	// plan §2), keeps its slot and its name, and is never recolonised. The
	// population is left where it is — the number the reader sees is the end
	// state, not a zeroed record.
	const OUTPOST_POP_M = 0.02;        // millions
	// The population ladder the narration credits, in millions: every rung is
	// logged once, and a jump across several rungs is one line with a count.
	const POP_MILESTONES = [0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500];
	// Below this coverage a live colony is in the alarm band (the overlay's
	// dashed ring, the panel's word). It is the edge the log narrates, not a
	// second growth law.
	const STARVE_COVERAGE = 0.35;
	const POP_GROWTH_CAP_FRAC = 1;     // keep the logistic inside its carrying capacity
	const YIELD_MAX = 2.5;
	const JITTER_LO = 0.70, JITTER_SPAN = 0.60;
	const FOUND_AGE_MIN = 10, FOUND_AGE_SPAN = 240;
	const FOUND_POP_BASE = 0.25, FOUND_POP_CAP_FRAC = 0.01;
	// A rolled world starts with a stocked warehouse; a founding starts with the
	// party's stores. Same law, two grants.
	const SEED_STOCK_FRAC = 0.60;
	const FOUND_STOCK_FRAC = 0.45;

	// Hash channels: the yield stream is per (planet slot, resource), the
	// founding-age stream per slot. 464+ keeps them clear of the planet
	// generator's own channels (0…~400).
	const EC_CH_YIELD = 512;
	const EC_CH_FOUND = 464;


	// --- Record shapes ------------------------------------------------------

	function createSite() {
		return {
			key: 0, kind: 0, index: 0, isBelt: 0,
			type: 0, bulk: 0, mass: 0, radius: 0, density: 0,
			insolation: 0, teq: 0, tsurf: 0, flags: 0,
			starClass: 'M', starLum: 0, starMetal: 0, starAge: 0, starState: 'ms',
			// The system's own supply (W4): bulk classes, belts, terrans and
			// habitable-zone worlds. Carried on the site so a candidate and a
			// colony keep the composition of the system they were drawn from.
			sysRocky: 0, sysGiants: 0, sysBelts: 0, sysTerran: 0, sysHz: 0,
			x: 0, y: 0, z: 0, ref: createStarRef(), seed: 0,
			name: '',
		};
	}

	// A site copies its star's pick reference (block kind + index + key + birth
	// position) because one 3D record is reused for every star the code
	// generates: a stored reference would be rewritten by the next discovery
	// and every older candidate would point at a stranger. The label layer
	// projects a candidate through this ref, so it must be the site's own.
	function createStarRef() {
		return { kind: 0, index: 0, key: 0, x: 0, y: 0, z: 0, colorIndex: 0, absMag: 0 };
	}

	function copyStarRef(out, ref) {
		out.kind = ref.kind;
		out.index = ref.index;
		out.key = ref.key >>> 0;
		out.x = ref.x; out.y = ref.y; out.z = ref.z;
		out.colorIndex = ref.colorIndex;
		out.absMag = ref.absMag;
		return out;
	}

	function copySite(out, site) {
		out.key = site.key;
		out.kind = site.kind;
		out.index = site.index;
		out.isBelt = site.isBelt;
		out.type = site.type;
		out.bulk = site.bulk;
		out.mass = site.mass;
		out.radius = site.radius;
		out.density = site.density;
		out.insolation = site.insolation;
		out.teq = site.teq;
		out.tsurf = site.tsurf;
		out.flags = site.flags;
		out.starClass = site.starClass;
		out.starLum = site.starLum;
		out.starMetal = site.starMetal;
		out.starAge = site.starAge;
		out.starState = site.starState;
		out.sysRocky = site.sysRocky;
		out.sysGiants = site.sysGiants;
		out.sysBelts = site.sysBelts;
		out.sysTerran = site.sysTerran;
		out.sysHz = site.sysHz;
		out.x = site.x; out.y = site.y; out.z = site.z;
		if (site.ref) copyStarRef(out.ref, site.ref);
		out.seed = site.seed >>> 0;
		out.name = site.name;
		return out;
	}

	// The site's identity in the model's hash space. `blockKind` is the star
	// block (field/landmark/object/local/catalog), so two blocks with equal
	// keys still map different worlds.
	function siteSeed(key, modelSeed, blockKind) {
		return planets.systemSeed(key, modelSeed, blockKind | 0);
	}

	// The system's supply, in one pass (W4). `counts` already carries the
	// terran and giant totals, so only rocky bodies and habitable-zone worlds
	// need counting; rocky means rock or super, not ice.
	const SYS_COMP = { rocky: 0, giants: 0, belts: 0, terran: 0, hz: 0 };
	function systemComposition(system, out) {
		const c = out || SYS_COMP;
		const p = system.planets;
		const n = system.counts.planets | 0;
		let rocky = 0, hz = 0;
		for (let i = 0; i < n; i++) {
			const bulk = p.bulk[i];
			if (bulk === planets.BULK_INDEX.rock || bulk === planets.BULK_INDEX.super) rocky += 1;
			if (p.flags[i] & planets.FLAG_IN_HZ) hz += 1;
		}
		c.rocky = rocky;
		c.giants = system.counts.giantCount | 0;
		c.belts = system.belts.count | 0;
		c.terran = system.counts.terranCount | 0;
		c.hz = hz;
		return c;
	}

	function writeSystemComposition(site, system) {
		const c = systemComposition(system, SYS_COMP);
		site.sysRocky = c.rocky;
		site.sysGiants = c.giants;
		site.sysBelts = c.belts;
		site.sysTerran = c.terran;
		site.sysHz = c.hz;
		return site;
	}

	// One planet's site record from a generated system. `out.name` is written
	// by the caller (it owns the star label and the planet letter).
	function fillPlanetSite(out, ref, system, index, seed) {
		const p = system.planets;
		out.key = ref.key >>> 0;
		out.kind = 0;
		out.index = index | 0;
		out.isBelt = 0;
		out.type = p.displayType[index];
		out.bulk = p.bulk[index];
		out.mass = p.mass[index];
		out.radius = p.radius[index];
		out.density = p.density[index];
		out.insolation = p.insolation[index];
		out.teq = p.teq[index];
		out.tsurf = p.tsurf[index];
		out.flags = p.flags[index];
		out.starClass = system.star.spectralClass;
		out.starLum = system.star.lum;
		out.starMetal = system.star.metal;
		out.starAge = system.star.age;
		out.starState = system.star.state;
		writeSystemComposition(out, system);
		out.seed = seed;
		return out;
	}

	function fillBeltSite(out, ref, system, index, seed) {
		const b = system.belts;
		out.key = ref.key >>> 0;
		out.kind = 1;
		out.index = index | 0;
		out.isBelt = 1;
		out.type = SITE_BELT;
		out.bulk = planets.BULK_INDEX.rock;
		out.mass = planets.BELT_BODY_MASS_KG / planets.M_EARTH_KG;
		out.radius = planets.BELT_BODY_R_M / planets.R_EARTH_M;
		out.density = planets.BELT_BODY_RHO;
		out.insolation = planets.insolation(system.star.lum, b.a[index]);
		out.teq = 120;
		out.tsurf = 120;
		out.flags = 0;
		out.starClass = system.star.spectralClass;
		out.starLum = system.star.lum;
		out.starMetal = system.star.metal;
		out.starAge = system.star.age;
		out.starState = system.star.state;
		writeSystemComposition(out, system);
		out.seed = seed;
		return out;
	}

	// --- The site map (trade-plan.md §2.1) ----------------------------------

	// The system's supply factor (W4 §5.2): what a prospector would count,
	// normalised against a cap so a system with twelve rocky worlds is not
	// twelve times a system with one. The star layer below stays the situation;
	// this multiplies it.
	function supplyFactor(r, site) {
		const rockyF = (site.sysRocky > 6 ? 6 : site.sysRocky) * (1 / 6);
		const giantF = (site.sysGiants > 4 ? 4 : site.sysGiants) * (1 / 4);
		const beltF = (site.sysBelts > 3 ? 3 : site.sysBelts) * (1 / 3);
		const terranF = (site.sysTerran > 2 ? 2 : site.sysTerran) * (1 / 2);
		const hzF = (site.sysHz > 4 ? 4 : site.sysHz) * (1 / 4);
		if (r === R_ORE || r === R_RARE || r === R_ROBOTS || r === R_COMPUTE) {
			return 0.80 + 0.45 * rockyF + 0.55 * beltF + 0.15 * giantF;
		}
		if (r === R_VOLATILE || r === R_CHEM) {
			return 0.85 + 0.40 * giantF + 0.30 * beltF + 0.10 * rockyF;
		}
		if (r === R_FOOD || r === R_BIO || r === R_PEOPLE) {
			return 0.85 + 0.35 * terranF + 0.25 * hzF + 0.10 * rockyF;
		}
		return 0.90 + 0.20 * rockyF + 0.10 * beltF;
	}

	function starFactor(r, site) {
		const metal = site.starMetal > 0 ? site.starMetal / 0.020 : 1;
		const metalClamped = metal < 0.35 ? 0.35 : (metal > 1.8 ? 1.8 : metal);
		const ageFactor = 1.15 - site.starAge / 20;
		const age = ageFactor < 0.6 ? 0.6 : (ageFactor > 1.2 ? 1.2 : ageFactor);
		const lightRaw = 0.55 + 0.35 * Math.log10(site.insolation > 0 ? site.insolation : 1e-6);
		const light = lightRaw < 0.15 ? 0.15 : (lightRaw > 1.8 ? 1.8 : lightRaw);
		const lifeRaw = 1 - Math.abs(site.tsurf - 288) / 220;
		const life = lifeRaw < 0.15 ? 0.15 : (lifeRaw > 1.25 ? 1.25 : lifeRaw);
		const supply = supplyFactor(r, site);
		if (r === R_ORE) return Math.pow(metalClamped, 0.8) * age * supply;
		if (r === R_VOLATILE) return supply;
		if (r === R_RARE) return Math.pow(metalClamped, 1.3) * age * supply;
		if (r === R_CHEM) return supply;
		if (r === R_AMAT) return Math.pow(light, 1.6) * supply;
		if (r === R_FOOD || r === R_BIO) {
			const classPenalty = (site.starClass === 'O' || site.starClass === 'B' || site.starClass === 'A') ? 0.7 : 1;
			const scale = r === R_FOOD ? 1.3 : 1.2;
			return Math.min(light, scale) * classPenalty * life * supply;
		}
		if (r === R_PEOPLE) return life * supply;
		if (r === R_ROBOTS) return Math.pow(metalClamped, 0.4) * supply;
		if (r === R_COMPUTE) return Math.pow(metalClamped, 0.3) * supply;
		return supply;
	}

	// A planet and a belt at the same slot number must not share hash streams:
	// slot 0–11 is a planet, 12–13 a belt.
	function siteSlot(site) {
		return site.isBelt ? 12 + (site.index & 3) : (site.index & 15);
	}

	// --- The colony record --------------------------------------------------

	function createColony() {
		return {
			key: 0, kind: 0, index: 0, isBelt: 0, name: '',
			starClass: 'M', starLum: 0, starMetal: 0, starAge: 0, starState: 'ms',
			type: 0, bulk: 0, mass: 0, radius: 0, density: 0,
			insolation: 0, teq: 0, tsurf: 0, flags: 0,
			capacity: 0, pop: 0, founded: 0, last: 0,
			// A failed colony: outposts keep their slot and stocks and are
			// never settled again. `outpostY` is the year it stopped.
			outpost: 0, outpostY: 0,
			// Milestones and the current supply/room snapshot for narration and
			// markers. The settle freezes coverage only while integrating.
			popLevel: 0, starving: 0,
			yield: new Float64Array(RESOURCE_COUNT),
			outBase: new Float64Array(RESOURCE_COUNT),
			stock: new Float64Array(RESOURCE_COUNT),
			stockCap: new Float64Array(RESOURCE_COUNT),
			coverage: 0, growth: 0, access: 1,
			produced: 0, consumed: 0,
			seed: 0,
			ref: createStarRef(),
		};
	}

	function copyColony(out, src) {
		copySite(out, src);
		out.capacity = src.capacity;
		out.pop = src.pop;
		out.founded = src.founded;
		out.last = src.last;
		out.outpost = src.outpost;
		out.outpostY = src.outpostY;
		out.popLevel = src.popLevel;
		out.starving = src.starving;
		out.yield.set(src.yield);
		out.outBase.set(src.outBase);
		out.stock.set(src.stock);
		out.stockCap.set(src.stockCap);
		out.coverage = src.coverage;
		out.growth = src.growth;
		out.access = src.access;
		out.produced = src.produced;
		out.consumed = src.consumed;
		out.seed = src.seed >>> 0;
		return out;
	}

	// The shared fill law: identity, capacity, yields, the industrial inputs
	// and the warehouse size. Both entry points start here, so a galaxy-rolled
	// colony and a founded one can never disagree about what a site produces.
	function fillColony(colony, site, seed) {
		copySite(colony, site);
		colony.seed = seed >>> 0;
		const typeCol = site.isBelt ? SITE_BELT : site.type;
		const habitat = site.isBelt ? HABITAT_BELT : HABITAT[site.type];
		const size = Math.pow(Math.max(0.05, site.mass) / 1, 0.3);
		const sizeFactor = size < 0.5 ? 0.5 : (size > 2.5 ? 2.5 : size);
		const stability = site.starState === 'giant' ? 0.7 : (site.starState === 'wd' ? 0.6 : 1);
		colony.capacity = Math.max(1, POP_CAP_BASE * habitat * sizeFactor * stability);
		for (let r = 0; r < RESOURCE_COUNT; r++) {
			const jitter = JITTER_LO + JITTER_SPAN * hash.hash01At(seed, EC_CH_YIELD + siteSlot(site) * 16 + r);
			let y = PLANET[r][typeCol] * starFactor(r, site) * jitter;
			if ((site.flags & planets.FLAG_TERRAN) && (r === R_FOOD || r === R_BIO || r === R_PEOPLE)) y *= 1.3;
			if ((site.flags & planets.FLAG_IN_HZ) && (r === R_FOOD || r === R_BIO)) y *= 1.15;
			if (y > YIELD_MAX) y = YIELD_MAX;
			if (y < 0) y = 0;
			colony.yield[r] = y;
			colony.outBase[r] = PROD[r] * y;
		}
		inputRateOf(colony, INPUT_SCRATCH);
		for (let r = 0; r < RESOURCE_COUNT; r++) {
			const throughput = Math.max(colony.outBase[r], INPUT_SCRATCH[r]);
			colony.stockCap[r] = STOCK_BASE + STOCK_YEARS * throughput * colony.capacity;
		}
		colony.outpost = 0;
		colony.outpostY = 0;
		colony.popLevel = 0;
		colony.starving = 0;
		colony.coverage = 0;
		colony.growth = 0;
		colony.access = 1;
		colony.produced = 0;
		colony.consumed = 0;
		return colony;
	}

	function grantStock(colony, frac) {
		for (let r = 0; r < RESOURCE_COUNT; r++) colony.stock[r] = frac * colony.stockCap[r];
	}

	// A galaxy-rolled colony: the hash invents its age and its population, and
	// the settle carries it forward from there.
	function setupColony(colony, site, nowYears, seed) {
		fillColony(colony, site, seed);
		grantStock(colony, SEED_STOCK_FRAC);
		const foundAge = FOUND_AGE_MIN + FOUND_AGE_SPAN * hash.hash01At(seed, EC_CH_FOUND + siteSlot(site));
		colony.founded = nowYears - foundAge;
		colony.last = colony.founded;
		let pop = FOUND_POP_BASE + FOUND_POP_CAP_FRAC * colony.capacity;
		const cap = POP_GROWTH_CAP_FRAC * colony.capacity;
		if (pop > cap) pop = cap;
		colony.pop = pop;
		settleColony(colony, nowYears);
		return colony;
	}

	// A colony founded now: no invented age, no settle. `popM` is the party the
	// founding carries (0 = the authored first grant). The caller may settle it
	// at its own event time; the record is valid as it stands.
	function foundColony(colony, site, nowYears, seed, popM) {
		fillColony(colony, site, seed);
		grantStock(colony, FOUND_STOCK_FRAC);
		colony.founded = nowYears;
		colony.last = nowYears;
		let pop = popM > 0 ? popM : FOUND_POP_BASE + FOUND_POP_CAP_FRAC * colony.capacity;
		const cap = POP_GROWTH_CAP_FRAC * colony.capacity;
		if (pop > cap) pop = cap;
		colony.pop = pop;
		refreshColonyHealth(colony);
		return colony;
	}

	// --- The closed-form settle (trade-plan.md §2.2) ------------------------

	// Evaluate with non-positive exponentials; expm1/log1p preserve short
	// intervals while the large positive-growth branch avoids overflow.
	function logisticIntegral(p0, k, g, dt, out) {
		if (!(dt > 0)) { out.pop = p0; out.integral = 0; return out; }
		if (g === 0 || p0 === k) {
			out.pop = p0;
			out.integral = p0 * dt;
			return out;
		}
		const q = p0 / k;
		const x = g * dt;
		if (x > 1) {
			const denom = q + (1 - q) * Math.exp(-x);
			out.pop = p0 / denom;
			out.integral = (k / g) * (x + Math.log(denom));
			return out;
		}
		const change = q * Math.expm1(x);
		out.pop = p0 * Math.exp(x) / (1 + change);
		out.integral = (k / g) * Math.log1p(change);
		return out;
	}

	// For scarcity, an exponential decay is necessary: reversing the logistic
	// would leave a world exactly at K unable to lose a single person.
	function declineIntegral(p0, g, dt, out) {
		const x = g * dt;
		out.pop = p0 * Math.exp(x);
		out.integral = p0 * Math.expm1(x) / g;
		return out;
	}

	const SETTLE_SCRATCH = { pop: 0, integral: 0 };
	const INPUT_SCRATCH = new Float64Array(RESOURCE_COUNT);

	// Per-capita draw on each resource: what people need plus what the local
	// factories consume at their current output. Constant for the colony's
	// whole life, so the settle stays closed-form.
	function inputRateOf(colony, out) {
		for (let r = 0; r < RESOURCE_COUNT; r++) out[r] = NEED[r];
		for (let g = 0; g < RESOURCE_COUNT; g++) {
			const out0 = colony.outBase[g];
			if (out0 <= 0) continue;
			const row = g * RESOURCE_COUNT;
			for (let r = 0; r < RESOURCE_COUNT; r++) out[r] += out0 * INPUT[row + r];
		}
		return out;
	}

	// Household needs alone decide coverage. Routing's `demandOf` also includes
	// factory inputs, so its scarcity tags are not a growth breakdown.
	function needCoverageOf(colony, r) {
		if (!(colony.pop > 0)) return 0;
		const need = NEED[r];
		if (!(need > 0)) return 1;
		const want = need * colony.pop;
		const supply = colony.outBase[r] * colony.pop + colony.stock[r] / NEED_BUFFER_Y;
		const covered = supply / want;
		return covered < 0 ? 0 : covered > 1 ? 1 : covered;
	}

	function coverageOf(colony) {
		if (!(colony.pop > 0)) return 0;
		let weight = 0, sum = 0;
		for (let r = 0; r < RESOURCE_COUNT; r++) {
			if (NEED[r] <= 0) continue;
			sum += NEED_WEIGHT[r] * needCoverageOf(colony, r);
			weight += NEED_WEIGHT[r];
		}
		return weight > 0 ? sum / weight : 1;
	}

	function supplyGrowthOf(coverage) {
		return G_MAX * coverage - DECLINE * (1 - coverage);
	}

	function populationRateAt(colony, coverage) {
		if (colony.outpost || !(colony.pop > 0)) return 0;
		const g = supplyGrowthOf(coverage);
		if (g <= 0) return g;
		const room = 1 - colony.pop / (colony.capacity > 0 ? colony.capacity : 1);
		return g * (room > 0 ? room : 0);
	}

	// Instantaneous natural change per person per trade year, using *current*
	// stocks. At a full world a positive supply potential produces no births.
	function populationRateOf(colony) {
		return populationRateAt(colony, coverageOf(colony));
	}

	function refreshColonyHealth(colony) {
		colony.coverage = coverageOf(colony);
		colony.growth = populationRateAt(colony, colony.coverage);
		colony.starving = !colony.outpost && colony.coverage < STARVE_COVERAGE ? 1 : 0;
		return colony;
	}

	// Advance one colony to `nowYears`. Returns the population change, so the
	// caller can log a founding or a collapse without re-reading the record.
	function settleColony(colony, nowYears) {
		if (colony.outpost) return 0;
		const now = nowYears;
		if (!(now > colony.last)) return 0;
		const dt = now - colony.last;
		const p0 = colony.pop;
		if (!(p0 > 0)) { demoteColony(colony, now); return 0; }
		const k = colony.capacity > 0 ? colony.capacity : 1;
		const g = supplyGrowthOf(coverageOf(colony));
		const capped = p0 > POP_GROWTH_CAP_FRAC * k ? POP_GROWTH_CAP_FRAC * k : p0;
		if (g < 0) declineIntegral(capped, g, dt, SETTLE_SCRATCH);
		else logisticIntegral(capped, k, g, dt, SETTLE_SCRATCH);
		const integral = SETTLE_SCRATCH.integral;
		const rate = inputRateOf(colony, INPUT_SCRATCH);
		for (let r = 0; r < RESOURCE_COUNT; r++) {
			const net = colony.outBase[r] - rate[r];
			if (net === 0) continue;
			let stock = colony.stock[r] + net * integral;
			const cap = colony.stockCap[r];
			if (stock > cap) stock = cap;
			if (stock < 0) stock = 0;
			colony.stock[r] = stock;
			if (net > 0) colony.produced += net * integral;
			else colony.consumed += -net * integral;
		}
		let pop = SETTLE_SCRATCH.pop;
		if (pop > POP_GROWTH_CAP_FRAC * k) pop = POP_GROWTH_CAP_FRAC * k;
		colony.pop = pop;
		colony.last = now;
		refreshColonyHealth(colony);
		while (colony.popLevel < POP_MILESTONES.length && pop >= POP_MILESTONES[colony.popLevel]) {
			colony.popLevel += 1;
		}
		if (pop < OUTPOST_POP_M) demoteColony(colony, now);
		return pop - p0;
	}

	// The failure: stop where it stands. No zeroing, no compaction, no revival —
	// the record is the end state, and `outpostY` is when it ended.
	function demoteColony(colony, nowYears) {
		colony.outpost = 1;
		colony.outpostY = nowYears;
		refreshColonyHealth(colony);
		return colony.outpost;
	}

	// --- Trade helpers ------------------------------------------------------

	// Units per year the port is short of `r` after local production and its
	// own reserve. The routing score reads this; 0 means "do not import".
	function demandOf(colony, r) {
		if (colony.outpost) return 0;
		const rate = inputRateOf(colony, INPUT_SCRATCH)[r];
		if (rate <= 0) return 0;
		const pop = colony.pop;
		const want = rate * pop;
		const local = colony.outBase[r] * pop;
		const reserve = colony.stock[r] / NEED_BUFFER_Y;
		const deficit = want - local - reserve;
		return deficit > 0 ? deficit : 0;
	}

	// Units a port will sell without eating into its own reserve.
	function exportableOf(colony, r) {
		if (colony.outpost) return 0;
		const reserve = EXPORT_RESERVE_FRAC * colony.stockCap[r];
		const spare = colony.stock[r] - reserve;
		return spare > 0 ? spare : 0;
	}

	// --- Scarcity (trade-2 plan §6) -----------------------------------------
	// A readout word, never money. `scarcityOf` is the share of the draw the
	// colony cannot cover locally; 0/0 is fair, not a crisis.
	const TAG_SURPLUS = 0, TAG_FAIR = 1, TAG_SCARCE = 2;

	function scarcityOf(colony, r) {
		const demand = demandOf(colony, r);
		const supply = colony.outBase[r] * colony.pop + colony.stock[r] / NEED_BUFFER_Y;
		const total = demand + supply;
		return total > 0 ? demand / total : 0;
	}

	function tradeTagOf(colony, r) {
		if (demandOf(colony, r) > 0) return TAG_SCARCE;
		if (exportableOf(colony, r) > 0) return TAG_SURPLUS;
		return TAG_FAIR;
	}

	function interFamilyTagOf(colony, familyId) {
		let surplus = 0;
		for (let r = 0; r < RESOURCE_COUNT; r++) {
			if (RESOURCES[r].interFamily !== familyId) continue;
			if (demandOf(colony, r) > 0) return TAG_SCARCE;
			if (exportableOf(colony, r) > 0) surplus = 1;
		}
		return surplus ? TAG_SURPLUS : TAG_FAIR;
	}

	function tradeTagName(tag) {
		return tag === TAG_SURPLUS ? 'surplus' : tag === TAG_SCARCE ? 'scarce' : 'fair';
	}

	function takeFromColony(colony, r, units) {
		const limit = exportableOf(colony, r);
		let take = units < limit ? units : limit;
		if (take <= 0) return 0;
		colony.stock[r] -= take;
		refreshColonyHealth(colony);
		return take;
	}

	function giveToColony(colony, r, units) {
		if (colony.outpost) return 0;
		const room = colony.stockCap[r] - colony.stock[r];
		let give = units < room ? units : room;
		if (give <= 0) return 0;
		colony.stock[r] += give;
		refreshColonyHealth(colony);
		return give;
	}

	// --- Fold and world transfers (trade-3 plan §4) ------------------------

	const FOLD_SCRATCH_MAX = 8;
	const XFER_WEIGHT = new Float64Array(FOLD_SCRATCH_MAX);
	const XFER_CAP = new Float64Array(FOLD_SCRATCH_MAX);
	const XFER_SHARE = new Float64Array(FOLD_SCRATCH_MAX);

	function foldColonies(fold, worlds, count) {
		if (!(count > 0)) return fold;
		if (count === 1) return copyColony(fold, worlds[0]);
		const prevLevel = fold.popLevel | 0;
		copySite(fold, worlds[0]);
		fold.seed = worlds[0].seed >>> 0;
		let liveCount = 0;
		let produced = 0, consumed = 0;
		for (let i = 0; i < count; i++) {
			const w = worlds[i];
			produced += w.produced;
			consumed += w.consumed;
			if (!w.outpost) liveCount += 1;
		}
		fold.produced = produced;
		fold.consumed = consumed;
		const allOutpost = liveCount === 0 ? 1 : 0;
		const nUsed = allOutpost ? count : liveCount;
		let pop = 0, capacity = 0, covSum = 0, growSum = 0, accSum = 0;
		let founded = Infinity, last = -Infinity, outpostY = 0;
		for (let r = 0; r < RESOURCE_COUNT; r++) {
			fold.stock[r] = 0;
			fold.stockCap[r] = 0;
			fold.outBase[r] = 0;
			fold.yield[r] = 0;
		}
		for (let i = 0; i < count; i++) {
			const w = worlds[i];
			if (!allOutpost && w.outpost) continue;
			pop += w.pop;
			capacity += w.capacity;
			covSum += w.pop * w.coverage;
			growSum += w.pop * w.growth;
			accSum += w.pop * w.access;
			if (w.founded < founded) founded = w.founded;
			if (w.last > last) last = w.last;
			if (w.outpostY > outpostY) outpostY = w.outpostY;
			for (let r = 0; r < RESOURCE_COUNT; r++) {
				fold.stock[r] += w.stock[r];
				fold.stockCap[r] += w.stockCap[r];
			}
		}
		const invPop = pop > 0 ? 1 / pop : 0;
		for (let r = 0; r < RESOURCE_COUNT; r++) {
			let baseSum = 0, prodSum = 0, yieldSum = 0;
			for (let i = 0; i < count; i++) {
				const w = worlds[i];
				if (!allOutpost && w.outpost) continue;
				baseSum += pop > 0 ? w.pop * w.outBase[r] : w.outBase[r];
				const q = w.pop * w.outBase[r];
				prodSum += q;
				yieldSum += q * w.yield[r];
			}
			fold.outBase[r] = pop > 0 ? baseSum * invPop : baseSum / nUsed;
			fold.yield[r] = prodSum > 0 ? yieldSum / prodSum : 0;
		}
		fold.pop = pop;
		fold.capacity = capacity;
		fold.founded = founded === Infinity ? 0 : founded;
		fold.last = last === -Infinity ? 0 : last;
		let level = prevLevel;
		while (level < POP_MILESTONES.length && pop >= POP_MILESTONES[level]) level += 1;
		fold.popLevel = level;
		if (allOutpost) {
			fold.outpost = 1;
			fold.outpostY = outpostY;
			fold.growth = 0;
			fold.starving = 0;
			fold.access = 0;
			fold.coverage = coverageOf(fold);
			return fold;
		}
		fold.outpost = 0;
		fold.outpostY = 0;
		fold.coverage = pop > 0 ? covSum * invPop : 0;
		fold.growth = pop > 0 ? growSum * invPop : 0;
		fold.access = pop > 0 ? accSum * invPop : 1;
		fold.starving = fold.coverage < STARVE_COVERAGE ? 1 : 0;
		return fold;
	}

	function refreshFoldHealth(fold, worlds, count) {
		if (count === 1) {
			const world = refreshColonyHealth(worlds[0]);
			if (fold !== world) {
				fold.coverage = world.coverage;
				fold.growth = world.growth;
				fold.starving = world.starving;
			}
			return;
		}
		let pop = 0, coverage = 0, growth = 0;
		for (let i = 0; i < count; i++) {
			const world = worlds[i];
			if (world.outpost) continue;
			refreshColonyHealth(world);
			pop += world.pop;
			coverage += world.pop * world.coverage;
			growth += world.pop * world.growth;
		}
		fold.coverage = pop > 0 ? coverage / pop : 0;
		fold.growth = pop > 0 ? growth / pop : 0;
		fold.starving = pop > 0 && !fold.outpost && fold.coverage < STARVE_COVERAGE ? 1 : 0;
	}

	// Bounded water-fill across <= FOLD_SCRATCH_MAX worlds: preserves exact
	// proportionality while unread caps hold, saturates capped slots cleanly,
	// falls back to remaining capacity when active weights sum to zero, and
	// conserves total mass to machine precision.
	function allocateBounded(count, weights, caps, total, out) {
		for (let i = 0; i < count; i++) out[i] = 0;
		let rem = total;
		for (let pass = 0; pass < count && rem > 1e-12; pass++) {
			let wSum = 0, cSum = 0, lastActive = -1;
			for (let i = 0; i < count; i++) {
				if (!(caps[i] > 0)) continue;
				cSum += caps[i];
				wSum += weights[i];
				lastActive = i;
			}
			if (!(cSum > 0) || lastActive < 0) break;
			if (rem >= cSum) {
				for (let i = 0; i < count; i++) {
					if (caps[i] > 0) { out[i] += caps[i]; caps[i] = 0; }
				}
				rem = 0;
				break;
			}
			let saturated = 0;
			for (let i = 0; i < count; i++) {
				if (!(caps[i] > 0)) continue;
				const share = wSum > 0 ? rem * (weights[i] / wSum) : rem * (caps[i] / cSum);
				if (share >= caps[i]) {
					out[i] += caps[i];
					rem -= caps[i];
					caps[i] = 0;
					saturated = 1;
				}
			}
			if (saturated) continue;
			let assigned = 0;
			for (let i = 0; i < count; i++) {
				if (!(caps[i] > 0)) continue;
				if (i === lastActive) {
					out[i] += rem - assigned;
				} else {
					const share = wSum > 0 ? rem * (weights[i] / wSum) : rem * (caps[i] / cSum);
					out[i] += share;
					assigned += share;
				}
				caps[i] = 0;
			}
			rem = 0;
			break;
		}
		let sum = 0;
		for (let i = 0; i < count; i++) sum += out[i];
		return sum;
	}

	function syncFoldResource(fold, worlds, count, r) {
		let sum = 0;
		for (let i = 0; i < count; i++) {
			if (!worlds[i].outpost) sum += worlds[i].stock[r];
		}
		fold.stock[r] = sum;
	}

	function distributeInbound(fold, worlds, count, r, units) {
		if (fold.outpost || !(count > 0) || !(units > 0)) return 0;
		if (count === 1) {
			const given = giveToColony(worlds[0], r, units);
			fold.stock[r] = worlds[0].stock[r];
			if (given > 0) refreshFoldHealth(fold, worlds, count);
			return given;
		}
		for (let i = 0; i < count; i++) {
			const w = worlds[i];
			if (w.outpost) { XFER_WEIGHT[i] = 0; XFER_CAP[i] = 0; continue; }
			const room = w.stockCap[r] - w.stock[r];
			XFER_CAP[i] = room > 0 ? room : 0;
			XFER_WEIGHT[i] = demandOf(w, r);
		}
		const given = allocateBounded(count, XFER_WEIGHT, XFER_CAP, units, XFER_SHARE);
		if (!(given > 0)) return 0;
		for (let i = 0; i < count; i++) {
			const w = worlds[i];
			if (w.outpost || !(XFER_SHARE[i] > 0)) continue;
			const next = w.stock[r] + XFER_SHARE[i];
			w.stock[r] = next > w.stockCap[r] ? w.stockCap[r] : next;
		}
		syncFoldResource(fold, worlds, count, r);
		refreshFoldHealth(fold, worlds, count);
		return given;
	}

	function collectOutbound(fold, worlds, count, r, units, lifts) {
		if (fold.outpost || !(count > 0) || !(units > 0)) return 0;
		const limit = exportableOf(fold, r);
		const want = units < limit ? units : limit;
		if (!(want > 0)) return 0;
		if (count === 1 && (!lifts || lifts[0] === 1)) {
			const taken = takeFromColony(worlds[0], r, want);
			fold.stock[r] = worlds[0].stock[r];
			if (taken > 0) refreshFoldHealth(fold, worlds, count);
			return taken;
		}
		for (let i = 0; i < count; i++) {
			const w = worlds[i];
			if (w.outpost) { XFER_WEIGHT[i] = 0; XFER_CAP[i] = 0; continue; }
			const lift = lifts ? lifts[i] : 1;
			const avail = exportableOf(w, r) * (lift > 0 ? lift : 0);
			XFER_CAP[i] = avail > 0 ? avail : 0;
			XFER_WEIGHT[i] = XFER_CAP[i];
		}
		const taken = allocateBounded(count, XFER_WEIGHT, XFER_CAP, want, XFER_SHARE);
		if (!(taken > 0)) return 0;
		for (let i = 0; i < count; i++) {
			const w = worlds[i];
			if (w.outpost || !(XFER_SHARE[i] > 0)) continue;
			const next = w.stock[r] - XFER_SHARE[i];
			w.stock[r] = next > 0 ? next : 0;
		}
		syncFoldResource(fold, worlds, count, r);
		refreshFoldHealth(fold, worlds, count);
		return taken;
	}

	// Units of a resource that fit in a hold with `tons` free.
	function unitsForTons(r, tons) {
		const mass = RESOURCES[r].unitMassT;
		return mass > 0 ? tons / mass : 0;
	}

	function tonsForUnits(r, units) {
		return units * RESOURCES[r].unitMassT;
	}

	// --- Display ------------------------------------------------------------

	// 0…5 filled dots for a yield, the readout's one-glance map.
	function yieldDots(y) {
		let dots = Math.round(y * 2);
		if (dots > 5) dots = 5;
		if (dots < 0) dots = 0;
		return dots;
	}

	function formatPop(millions) {
		if (!(millions > 0)) return '0';
		if (millions >= 1000) return (millions / 1000).toFixed(2) + ' B';
		if (millions >= 10) return millions.toFixed(1) + ' M';
		if (millions >= 1) return millions.toFixed(2) + ' M';
		return (millions * 1000).toFixed(0) + ' k';
	}

	function formatUnits(value) {
		if (!(value > 0)) return '0';
		if (value >= 1e6) return (value / 1e6).toFixed(2) + 'M';
		if (value >= 1e3) return (value / 1e3).toFixed(1) + 'k';
		if (value >= 100) return value.toFixed(0);
		if (value >= 10) return value.toFixed(1);
		return value.toFixed(2);
	}

	// "Sirius b" / "Sirius belt 1" for a named star, the S<key> designation
	// otherwise — the same letter law the system layer uses.
	function siteName(starName, key, siteKind, index) {
		if (starName) {
			return siteKind === 1
				? starName + ' belt ' + (index + 1)
				: starName + ' ' + String.fromCharCode(98 + (index & 31));
		}
		const out = planets.DESIGNATION;
		let end = planets.writeStarDesignation(key >>> 0, out, 0);
		if (siteKind === 1) { out[end] = 32; end = planets.writeBeltName(index, out, end + 1); }
		else end = planets.writePlanetLetter(index, out, end);
		return planets.designationToString(out, end);
	}

	const EconomyLib = {
		RESOURCE_COUNT, RESOURCES, PROD, NEED, NEED_WEIGHT, INPUT, PLANET,
		INTRA_BULK, INTRA_GOODS, INTRA_PAX, INTRA_FAMILY_NAMES, INTRA_FAMILY_SHORT,
		INTER_RARE, INTER_EXOTIC, INTER_AMAT, INTER_FOOD, INTER_FAB, INTER_INFO, INTER_PAX,
		INTER_FAMILY_NAMES, INTER_FAMILY_SHORT,
		SITE_BELT,
		R_ORE, R_VOLATILE, R_RARE, R_CHEM, R_AMAT, R_FOOD, R_BIO, R_PEOPLE,
		R_ROBOTS, R_COMPUTE, R_SOFT, R_DATA, R_ART,
		POP_CAP_BASE, G_MAX, DECLINE, NEED_BUFFER_Y, STOCK_BASE, STOCK_YEARS,
		EXPORT_RESERVE_FRAC, OUTPOST_POP_M, POP_MILESTONES, STARVE_COVERAGE,
		TAG_SURPLUS, TAG_FAIR, TAG_SCARCE, scarcityOf, tradeTagOf, interFamilyTagOf, tradeTagName,
		POP_GROWTH_CAP_FRAC, YIELD_MAX,
		EC_CH_YIELD, EC_CH_FOUND, siteSlot,
		createSite, copySite, siteSeed, fillPlanetSite, fillBeltSite,
		starFactor, supplyFactor, systemComposition, writeSystemComposition,
		createColony, copyColony, fillColony, setupColony, foundColony, settleColony, demoteColony,
		foldColonies, distributeInbound, collectOutbound,
		FOUND_STOCK_FRAC, SEED_STOCK_FRAC,
		needCoverageOf, coverageOf, supplyGrowthOf, populationRateOf, refreshColonyHealth,
		inputRateOf, HABITAT, HABITAT_BELT,
		demandOf, exportableOf, takeFromColony, giveToColony,
		unitsForTons, tonsForUnits, yieldDots, formatPop, formatUnits, siteName,
	};
	if (typeof module !== 'undefined') module.exports = EconomyLib;
	if (typeof window !== 'undefined') window.EconomyLib = EconomyLib;
})();
