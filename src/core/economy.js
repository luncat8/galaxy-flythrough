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
	const RESOURCES = [
		{ id: 'ore', name: 'ore', family: 'raw', unitMassT: 40, worth: 0.25 },
		{ id: 'volatile', name: 'volatiles', family: 'raw', unitMassT: 30, worth: 0.30 },
		{ id: 'rare', name: 'rare elements', family: 'raw', unitMassT: 60, worth: 6 },
		{ id: 'chem', name: 'synth chemicals', family: 'synth', unitMassT: 12, worth: 1.2 },
		{ id: 'amat', name: 'antimatter', family: 'synth', unitMassT: 0.5, worth: 12 },
		{ id: 'food', name: 'food & seed', family: 'life', unitMassT: 8, worth: 0.8 },
		{ id: 'bio', name: 'biotech samples', family: 'life', unitMassT: 4, worth: 4 },
		{ id: 'people', name: 'colonists', family: 'life', unitMassT: 2, worth: 3 },
		{ id: 'robots', name: 'factory cores', family: 'goods', unitMassT: 25, worth: 2.5 },
		{ id: 'compute', name: 'computers', family: 'goods', unitMassT: 6, worth: 3.5 },
		{ id: 'soft', name: 'software & AI', family: 'data', unitMassT: 0.2, worth: 5 },
		{ id: 'data', name: 'world data', family: 'data', unitMassT: 0.2, worth: 4 },
		{ id: 'art', name: 'unique items', family: 'culture', unitMassT: 1, worth: 8 },
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
		[1.20, 0.90, 0.50, 0.15, 0.10, 0.60, 0.00, 0.00, 0.00, 0.70, 1.40], // ore
		[1.00, 0.20, 0.20, 0.30, 1.40, 0.40, 1.30, 1.50, 1.40, 0.30, 1.20], // volatile
		[1.00, 0.70, 0.10, 0.00, 0.00, 0.15, 0.00, 0.00, 0.00, 0.50, 0.80], // rare
		[0.50, 0.20, 0.60, 1.00, 0.60, 0.80, 0.50, 0.50, 0.40, 0.00, 0.20], // chem
		[0.30, 0.00, 0.00, 0.00, 0.30, 0.00, 0.10, 0.50, 0.60, 0.00, 0.00], // amat
		[0.05, 0.00, 0.50, 1.40, 0.25, 0.70, 0.05, 0.00, 0.00, 0.00, 0.10], // food
		[0.00, 0.00, 0.20, 1.20, 0.30, 0.60, 0.00, 0.00, 0.00, 0.00, 0.02], // bio
		[0.00, 0.00, 0.40, 1.20, 0.00, 0.70, 0.00, 0.00, 0.00, 0.00, 0.10], // people
		[0.40, 0.50, 0.30, 0.70, 0.20, 0.60, 0.30, 0.30, 0.30, 0.20, 0.60], // robots
		[0.00, 0.00, 0.50, 1.00, 0.00, 0.70, 0.00, 0.00, 0.00, 0.00, 0.00], // compute
		[0.00, 0.00, 0.20, 1.20, 0.00, 0.50, 0.00, 0.00, 0.00, 0.00, 0.00], // soft
		[0.00, 0.00, 0.20, 1.00, 0.00, 0.50, 0.00, 0.00, 0.00, 0.00, 0.00], // data
		[0.00, 0.00, 0.05, 0.80, 0.00, 0.30, 0.00, 0.00, 0.00, 0.00, 0.00], // art
	];

	// Carrying capacity: base millions × habitat weight × size × stability.
	const POP_CAP_BASE = 900;
	const HABITAT = new Float64Array([0.04, 0.16, 0.35, 1.00, 0.18, 0.70, 0.12, 0.20, 0.12, 0.03]);
	const HABITAT_BELT = 0.10;

	const G_MAX = 1 / 80;              // per year, fully supplied
	const DECLINE = 1 / 120;           // per year, fully starved
	const NEED_BUFFER_Y = 20;          // years of stock that count as supply
	const STOCK_BASE = 30;
	const STOCK_YEARS = 150;           // warehouse size in years of throughput
	const EXPORT_RESERVE_FRAC = 0.25;  // stock a port keeps before it sells
	const POP_MIN = 0.02;              // millions; below this a colony is abandoned
	const POP_GROWTH_CAP_FRAC = 1;     // keep the logistic inside its carrying capacity
	const YIELD_MAX = 2.5;
	const JITTER_LO = 0.70, JITTER_SPAN = 0.60;
	const FOUND_AGE_MIN = 10, FOUND_AGE_SPAN = 240;
	const FOUND_POP_BASE = 0.25, FOUND_POP_CAP_FRAC = 0.01;
	const FOUND_STOCK_FRAC = 0.60;

	// The reserve horizon scales with the fleet (trade-plan §6): a port's
	// warehouse is authored in years of its own throughput, and a world whose
	// ships take millennia to cross must hold millennia of stock or starve
	// between two arrivals. One factor, set by the mode, so the warehouse law
	// is unchanged and only its horizon moves.
	let reserveScale = 1;
	function setReserveScale(scale) {
		reserveScale = scale > 0 ? scale : 1;
		return reserveScale;
	}
	function getReserveScale() { return reserveScale; }

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
		out.seed = seed;
		return out;
	}

	// --- The site map (trade-plan.md §2.1) ----------------------------------

	function starFactor(r, site) {
		const metal = site.starMetal > 0 ? site.starMetal / 0.020 : 1;
		const metalClamped = metal < 0.35 ? 0.35 : (metal > 1.8 ? 1.8 : metal);
		const ageFactor = 1.15 - site.starAge / 20;
		const age = ageFactor < 0.6 ? 0.6 : (ageFactor > 1.2 ? 1.2 : ageFactor);
		const lightRaw = 0.55 + 0.35 * Math.log10(site.insolation > 0 ? site.insolation : 1e-6);
		const light = lightRaw < 0.15 ? 0.15 : (lightRaw > 1.8 ? 1.8 : lightRaw);
		const lifeRaw = 1 - Math.abs(site.tsurf - 288) / 220;
		const life = lifeRaw < 0.15 ? 0.15 : (lifeRaw > 1.25 ? 1.25 : lifeRaw);
		if (r === R_ORE) return Math.pow(metalClamped, 0.8) * age;
		if (r === R_VOLATILE) return 1;
		if (r === R_RARE) return Math.pow(metalClamped, 1.3) * age;
		if (r === R_CHEM) return 1;
		if (r === R_AMAT) return Math.pow(light, 1.6);
		if (r === R_FOOD || r === R_BIO) {
			const classPenalty = (site.starClass === 'O' || site.starClass === 'B' || site.starClass === 'A') ? 0.7 : 1;
			const scale = r === R_FOOD ? 1.3 : 1.2;
			return Math.min(light, scale) * classPenalty * life;
		}
		if (r === R_PEOPLE) return life;
		if (r === R_ROBOTS) return Math.pow(metalClamped, 0.4);
		if (r === R_COMPUTE) return Math.pow(metalClamped, 0.3);
		return 1;
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
			capacity: 0, pop: 0, founded: 0, last: 0, abandoned: 0,
			yield: new Float64Array(RESOURCE_COUNT),
			outBase: new Float64Array(RESOURCE_COUNT),
			stock: new Float64Array(RESOURCE_COUNT),
			stockCap: new Float64Array(RESOURCE_COUNT),
			coverage: 0, growth: 0,
			produced: 0, consumed: 0,
			seed: 0,
			ref: createStarRef(),
		};
	}

	// Fill the colony's resource map, capacity, founding and seed stocks from
	// a site, then settle from its founding age to `nowYears`. This is the
	// only constructor: a colony created by discovery and one created by a
	// colonisation expedition run the same law.
	function setupColony(colony, site, nowYears, seed) {
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
			colony.stockCap[r] = (STOCK_BASE + STOCK_YEARS * throughput * colony.capacity) * reserveScale;
			colony.stock[r] = FOUND_STOCK_FRAC * colony.stockCap[r];
		}
		const foundAge = FOUND_AGE_MIN + FOUND_AGE_SPAN * hash.hash01At(seed, EC_CH_FOUND + siteSlot(site));
		colony.founded = nowYears - foundAge;
		colony.last = colony.founded;
		let pop = FOUND_POP_BASE + FOUND_POP_CAP_FRAC * colony.capacity;
		const cap = POP_GROWTH_CAP_FRAC * colony.capacity;
		if (pop > cap) pop = cap;
		colony.pop = pop;
		colony.abandoned = 0;
		colony.coverage = 0;
		colony.growth = 0;
		colony.produced = 0;
		colony.consumed = 0;
		settleColony(colony, nowYears);
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

	const LOGISTIC_SCRATCH = { pop: 0, integral: 0 };
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

	function coverageOf(colony) {
		const pop = colony.pop;
		if (!(pop > 0)) return 0;
		let weight = 0, sum = 0;
		for (let r = 0; r < RESOURCE_COUNT; r++) {
			const need = NEED[r];
			if (need <= 0) continue;
			const want = need * pop;
			const supply = colony.outBase[r] * pop + colony.stock[r] / NEED_BUFFER_Y;
			let c = supply / want;
			if (c > 1) c = 1;
			if (c < 0) c = 0;
			sum += NEED_WEIGHT[r] * c;
			weight += NEED_WEIGHT[r];
		}
		return weight > 0 ? sum / weight : 1;
	}

	// Re-scale a live colony's warehouse when the mode changes: the cap moves by
	// the same factor and the contents follow it (a world that keeps a longer
	// year count does not keep less grain). The formula is monotone, so a
	// shrinking scale clamps instead of going negative.
	function rescaleColonyReserves(colony, factor) {
		if (colony.abandoned || !(factor > 0) || factor === 1) return factor;
		for (let r = 0; r < RESOURCE_COUNT; r++) {
			const cap = colony.stockCap[r] * factor;
			const stock = colony.stock[r] * factor;
			colony.stockCap[r] = cap;
			colony.stock[r] = stock > cap ? cap : stock;
		}
		return factor;
	}

	// Advance one colony to `nowYears`. Returns the population change, so the
	// caller can log a founding or a collapse without re-reading the record.
	function settleColony(colony, nowYears) {
		if (colony.abandoned) return 0;
		const now = nowYears;
		if (!(now > colony.last)) return 0;
		const dt = now - colony.last;
		const p0 = colony.pop;
		if (!(p0 > 0)) { colony.abandoned = 1; colony.last = now; return 0; }
		const k = colony.capacity > 0 ? colony.capacity : 1;
		const coverage = coverageOf(colony);
		const g = G_MAX * coverage - DECLINE * (1 - coverage);
		const capped = p0 > POP_GROWTH_CAP_FRAC * k ? POP_GROWTH_CAP_FRAC * k : p0;
		logisticIntegral(capped, k, g, dt, LOGISTIC_SCRATCH);
		const integral = LOGISTIC_SCRATCH.integral;
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
		let pop = LOGISTIC_SCRATCH.pop;
		if (pop > POP_GROWTH_CAP_FRAC * k) pop = POP_GROWTH_CAP_FRAC * k;
		colony.pop = pop;
		colony.coverage = coverage;
		colony.growth = g;
		colony.last = now;
		if (pop < POP_MIN) colony.abandoned = 1;
		return pop - p0;
	}

	// --- Trade helpers ------------------------------------------------------

	// Units per year the port is short of `r` after local production and its
	// own reserve. The routing score reads this; 0 means "do not import".
	function demandOf(colony, r) {
		if (colony.abandoned) return 0;
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
		if (colony.abandoned) return 0;
		const reserve = EXPORT_RESERVE_FRAC * colony.stockCap[r];
		const spare = colony.stock[r] - reserve;
		return spare > 0 ? spare : 0;
	}

	function takeFromColony(colony, r, units) {
		const limit = exportableOf(colony, r);
		let take = units < limit ? units : limit;
		if (take <= 0) return 0;
		colony.stock[r] -= take;
		return take;
	}

	function giveToColony(colony, r, units) {
		if (colony.abandoned) return 0;
		const room = colony.stockCap[r] - colony.stock[r];
		let give = units < room ? units : room;
		if (give <= 0) return 0;
		colony.stock[r] += give;
		return give;
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
		SITE_BELT,
		R_ORE, R_VOLATILE, R_RARE, R_CHEM, R_AMAT, R_FOOD, R_BIO, R_PEOPLE,
		R_ROBOTS, R_COMPUTE, R_SOFT, R_DATA, R_ART,
		setReserveScale, getReserveScale, rescaleColonyReserves,
		POP_CAP_BASE, G_MAX, DECLINE, NEED_BUFFER_Y, STOCK_BASE, STOCK_YEARS,
		EXPORT_RESERVE_FRAC, POP_MIN, POP_GROWTH_CAP_FRAC, YIELD_MAX,
		EC_CH_YIELD, EC_CH_FOUND, siteSlot,
		createSite, copySite, siteSeed, fillPlanetSite, fillBeltSite,
		createColony, setupColony, settleColony, coverageOf, inputRateOf, HABITAT, HABITAT_BELT,
		demandOf, exportableOf, takeFromColony, giveToColony,
		unitsForTons, tonsForUnits, yieldDots, formatPop, formatUnits, siteName,
	};
	if (typeof module !== 'undefined') module.exports = EconomyLib;
	if (typeof window !== 'undefined') window.EconomyLib = EconomyLib;
})();
