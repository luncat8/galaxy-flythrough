// src/math/planets.js
// The lazy planet-system generator (plan: 0.5.0-plan-planet-generator.md).
//
// 0.5.0 lands the *input tier* of this module, because a selection snapshot has
// to carry a star's derived properties (plan §3.2) and the snapshot's anti-drift
// pin compares them with a fresh derivation. What is here now:
//
//   * the domain-separated system seed and the block-kind table (plan §2.2/§2.3),
//   * `stellarInputs` — the per-block path from a record to
//     (mass, luminosity, Teff, R★, age, Z, state, spectral class) (plan §2.4),
//   * `massFromClassAndMag` — the inversion of what a 16-byte StarPacked record
//     still carries, for the blocks that are not re-derivable (plan §2.5),
//   * the authored display-type, bulk and occurrence tables the generator reads,
//   * the occurrence tier (plan §4.4, 0.5.1-3): the μ table and bulk weights
//     with their `f_Z` / state modifiers (`bulkWeightsFor`/`bulkCdfFor`), and
//     the geometric count draw (`planetCount`, `expectedPlanetCount`),
//   * the architecture tier (plan §4.5, 0.5.1-4): the disc edges
//     (`innerEdgeAU`/`outerEdgeAU`), the log-uniform axis draw, the bulk/mass
//     draws, the Hill repair with its drop-on-overflow rule, and the orbital
//     elements — one `architecture(seed, star, out)` chain into the
//     struct-of-arrays record `createArchitecture` builds.
//
// 0.5.1's remaining tiers add temperatures, belts and the SystemRecord behind
// this same object. Everything here is a pure
// function of (model, key, record): no PRNG state, no allocation, `out` params.
//
// Why the conversion exists at all: the renderer's procedural blocks can be
// re-derived bit-exactly (same call, same arguments, same channels), but a
// landmark or a catalog star is a 16-byte record — colour index and absolute
// magnitude, nothing else. Its mass is in neither, so it is inverted from the
// luminosity the magnitude implies and clamped into the star's class bracket.

'use strict';

(function () {
	const hash = (typeof module !== 'undefined' && module.exports)
		? require('./hash.js')
		: window.HashLib;
	const density = (typeof module !== 'undefined' && module.exports)
		? require('./density.js')
		: window.DensityLib;
	const records = (typeof module !== 'undefined' && module.exports)
		? require('./star-record.js')
		: window.StarRecord;
	const starTypes = (typeof module !== 'undefined' && module.exports)
		? require('./star-types.js')
		: window.StarTypesLib;

	// --- Constants (plan §4.1) ----------------------------------------------
	const AU_M = 1.495978707e11;
	const M_SUN_KG = 1.98892e30;
	const G_SI = 6.674e-11;
	const M_EARTH_KG = 5.9722e24;
	const R_EARTH_M = 6.371e6;
	const R_SUN_M = 6.957e8;
	const TEFF_SUN = 5772;
	const RHO_EARTH = 5514;              // kg/m³
	const MAX_PLANETS = 12;
	const MAX_BELTS = 2;
	const STIPPLE_N = 384;               // belt dots, hashed once per system
	const A_SNOW_K = 2.7;                // a_snow = 2.7·sqrt(L/L☉) AU
	const HZ_S_IN = 1.05, HZ_S_OUT = 0.35;
	const K_HILL = 6;                    // minimum separation in mutual Hill radii
	const STAR_CLEARANCE = 6;            // innermost orbit, in stellar radii
	const DISK_OUT_AU = 40;              // a_out = DISK_OUT_AU·sqrt(M★/M☉)
	const A_LOCK = 0.30;                 // AU; locked below A_LOCK·sqrt(M★/M☉)
	const RUNAWAY_DT = 500;              // K, Venus-calibrated
	const RUNAWAY_ALBEDO = 0.70;
	const TERRAN_DT_BASE = 33;
	const TERRAN_DT_SPAN = 55;
	const TERRAN_DT_MAX = 65;
	const AIRLESS_M = 0.02;              // M⊕; below this, no atmosphere at all
	const ATM_RETAIN_M = 0.3;            // M⊕; below this, no runaway, no thermostat
	const DEORBIT_DV = 0.15;             // km/s; the floor of a landing burn

	// --- Star identity (plan §2.2/§2.3) -------------------------------------
	// Block kinds are hashed into the system seed, so a landmark and a field star
	// with equal keys still get different systems. Ids and names are one list:
	// star-sprites.js names its blocks with these strings and the test pins the
	// ids against that table's order.
	const BLOCK_FIELD = 0, BLOCK_LANDMARK = 1, BLOCK_OBJECT = 2, BLOCK_LOCAL = 3, BLOCK_CATALOG = 4;
	const BLOCK_NAMES = ['field', 'landmark', 'object', 'local', 'catalog'];

	const DOMAIN_PLANETS = 0x51A7E75;
	const DOMAIN_LANDMARK = 0x1A4D7E11;
	const DOMAIN_CATALOG = 0x2B5E8F32;

	// Channel map (plan §2.3): every draw inside a system is
	// hash01At(systemSeed, channel), and no two quantities share a channel.
	const CH_ESCALE = 0;
	const CH_COUNT_BASE = 2;             // count chain: CH_COUNT_BASE + n
	const CH_SLOT_BASE = 32;             // per planet: CH_SLOT_BASE + 8·p + field
	const CH_BULK = 0, CH_AXIS = 1, CH_MASS = 2, CH_ECC = 3;
	const CH_INC = 4, CH_PERI = 5, CH_PHASE = 6, CH_ROT = 7;
	const CH_BELT_INNER = 200, CH_BELT_OUTER = 210;
	const CH_STIPPLE_BASE = 300;

	// --- Authored tables -----------------------------------------------------
	// Display types (plan §4.2). `atmosphere` is the one column the delta-v
	// module reads for drag, aerocapture and landing credit — one table, three
	// consumers. Colours are sRGB bytes, deliberately not the star palette's
	// blues-for-hot convention: a blue planet and a blue star must not read the
	// same.
	const DISPLAY_TYPES = [
		{ id: 0, name: 'LAVA', bulk: 'rock', color: [255, 90, 42], albedo: 0.10, atmosphere: 'none', dtBase: 0 },
		{ id: 1, name: 'BARREN', bulk: 'rock', color: [154, 143, 130], albedo: 0.12, atmosphere: 'none', dtBase: 0 },
		{ id: 2, name: 'DESERT', bulk: 'rock', color: [217, 164, 91], albedo: 0.28, atmosphere: 'thin', dtBase: 8 },
		{ id: 3, name: 'TERRAN', bulk: 'rock', color: [79, 157, 224], albedo: 0.30, atmosphere: 'breathable', dtBase: TERRAN_DT_BASE },
		{ id: 4, name: 'ICE', bulk: 'ice', color: [207, 232, 245], albedo: 0.65, atmosphere: 'thin', dtBase: 8 },
		{ id: 5, name: 'SUPER_EARTH', bulk: 'super', color: [164, 209, 106], albedo: 0.25, atmosphere: 'thick', dtBase: 40 },
		{ id: 6, name: 'MINI_NEPTUNE', bulk: 'mini', color: [127, 212, 208], albedo: 0.45, atmosphere: 'hhe', dtBase: 60 },
		{ id: 7, name: 'GAS_GIANT', bulk: 'gas', color: [224, 176, 112], albedo: 0.50, atmosphere: 'hhe', dtBase: 30 },
		{ id: 8, name: 'ICE_GIANT', bulk: 'icegiant', color: [111, 159, 224], albedo: 0.55, atmosphere: 'hhe', dtBase: 25 },
		{ id: 9, name: 'DWARF', bulk: 'dwarf', color: [122, 122, 122], albedo: 0.10, atmosphere: 'none', dtBase: 0 },
	];
	const DISPLAY_INDEX = {};
	for (let i = 0; i < DISPLAY_TYPES.length; i++) DISPLAY_INDEX[DISPLAY_TYPES[i].name] = i;

	const ATMOSPHERES = ['none', 'thin', 'breathable', 'thick', 'hhe'];

	// Bulk classes (plan §4.3): R/R⊕ = radiusRef·(M/massRef)^p. One law per bulk,
	// because a rocky world and a gas giant of equal mass differ by a factor of
	// ten in radius.
	const BULKS = [
		{ name: 'rock', massMin: 0.05, massMax: 2.0, massRef: 1, radiusRef: 1.00, p: 0.28, rotMin: 8, rotMax: 60, eccMax: 0.15, moonsMax: 1 },
		{ name: 'ice', massMin: 0.05, massMax: 2.5, massRef: 1, radiusRef: 1.10, p: 0.28, rotMin: 8, rotMax: 60, eccMax: 0.12, moonsMax: 1 },
		{ name: 'super', massMin: 2, massMax: 10, massRef: 5, radiusRef: 1.60, p: 0.27, rotMin: 8, rotMax: 40, eccMax: 0.10, moonsMax: 2 },
		{ name: 'mini', massMin: 5, massMax: 20, massRef: 10, radiusRef: 2.80, p: 0.50, rotMin: 8, rotMax: 20, eccMax: 0.12, moonsMax: 8 },
		{ name: 'gas', massMin: 50, massMax: 3000, massRef: 318, radiusRef: 11.20, p: 0.05, rotMin: 8, rotMax: 18, eccMax: 0.35, moonsMax: 80 },
		{ name: 'icegiant', massMin: 10, massMax: 60, massRef: 17, radiusRef: 4.00, p: 0.35, rotMin: 10, rotMax: 20, eccMax: 0.25, moonsMax: 30 },
		{ name: 'dwarf', massMin: 0.0005, massMax: 0.05, massRef: 0.01, radiusRef: 0.20, p: 0.30, rotMin: 4, rotMax: 30, eccMax: 0.20, moonsMax: 0 },
	];
	const BULK_INDEX = {};
	for (let i = 0; i < BULKS.length; i++) BULK_INDEX[BULKS[i].name] = i;

	// Mean planet count by stellar class (plan §4.4), from the Kepler/RV census
	// shape: M dwarfs most productive per star, O/B the least.
	const CLASS_MU = { O: 0.02, B: 0.10, A: 0.35, F: 0.90, G: 1.20, K: 1.30, M: 1.60, WD: 0.15, RG: 0.40, RGe: 0.30 };

	// Bulk weights by stellar class (plan §4.4), rows in records.SPECTRAL_CLASSES
	// order, columns in BULKS order (rock, ice, super, mini, gas, icegiant,
	// dwarf). Authored, not fitted; each row sums to 1. The test pins the table
	// against the plan and the row/column alignment against the two lists.
	const CLASS_BULK_WEIGHTS = [
		[0.00, 0.00, 0.00, 0.00, 0.55, 0.25, 0.20],   // O
		[0.00, 0.00, 0.05, 0.10, 0.50, 0.25, 0.10],   // B
		[0.08, 0.10, 0.15, 0.20, 0.27, 0.12, 0.08],   // A
		[0.22, 0.12, 0.20, 0.15, 0.13, 0.08, 0.10],   // F
		[0.26, 0.12, 0.20, 0.14, 0.10, 0.07, 0.11],   // G
		[0.28, 0.12, 0.22, 0.12, 0.08, 0.06, 0.12],   // K
		[0.36, 0.10, 0.28, 0.10, 0.01, 0.02, 0.13],   // M
		[0.30, 0.15, 0.10, 0.03, 0.02, 0.03, 0.37],   // WD
		[0.10, 0.18, 0.15, 0.15, 0.22, 0.12, 0.08],   // RG
		[0.14, 0.24, 0.15, 0.12, 0.17, 0.10, 0.08],   // RGe
	];

	// Each row normalised into a CDF once at module load (plan §4.4): the common
	// case (thin-disc Z, main sequence — `f_Z` = 1 and no state rule) is then a
	// 7-float copy per system instead of a renormalise, and the modified case
	// has a reference to be pinned against. Row order matches
	// records.SPECTRAL_CLASSES; the last entry of each row is forced to exactly
	// 1 so a `u < cdf[i]` walk always terminates inside the row. f32 thresholds
	// are the plan's contract (a reimplementation must land on the same
	// systems), so the modified path rounds its writes through Math.fround —
	// the copy path and the renormalise path are then bit-identical.
	const CLASS_BULK_CDF = (function () {
		const cdf = new Float32Array(CLASS_BULK_WEIGHTS.length * BULKS.length);
		for (let r = 0; r < CLASS_BULK_WEIGHTS.length; r++) {
			const row = CLASS_BULK_WEIGHTS[r];
			let sum = 0;
			for (let c = 0; c < row.length; c++) sum += row[c];
			let acc = 0;
			for (let c = 0; c < row.length; c++) {
				acc += row[c] / sum;
				cdf[r * BULKS.length + c] = acc;
			}
			cdf[r * BULKS.length + row.length - 1] = 1;
		}
		return cdf;
	})();

	// Mass bracket per spectral class (plan §2.5): the window the
	// magnitude-derived mass is clamped into. A record carries no mass, and the
	// class is the only thing that says which decade it lives in.
	const CLASS_MASS_BRACKETS = {
		O: [16, 100], B: [2.5, 16], A: [1.6, 2.5], F: [1.05, 1.6],
		G: [0.85, 1.05], K: [0.55, 0.85], M: [0.08, 0.55],
		WD: [0.5, 1.4],                    // remnant mass; L is the cooling track's
		RG: [0.8, 3.0], RGe: [0.8, 3.0],   // initial mass; L is the giant's
	};

	// Temperature band per class, derived from the classifier's own boundaries
	// (star-types.CLASS_TEMP_BOUNDS) so there is no second list: each band is the
	// classifier read backwards, with the hot end taken from the mass–Teff
	// table's ceiling. The evolved classes are not on the main sequence —
	// `evolveStar` draws a giant at 3000–4000 K and a white dwarf between its
	// cooling floor and 38 000 K — so those are their bands.
	const CLASS_TEFF_BANDS = (function () {
		const bounds = starTypes.CLASS_TEMP_BOUNDS;
		const table = starTypes.MASS_TEFF_TABLE;
		const bands = {};
		const hottest = table[table.length - 1][1];
		for (let i = 0; i < bounds.length; i++) {
			// Class order is hottest first, so class i's floor is its own bound and
			// its ceiling is the previous class's floor; the coldest class floors at
			// the mass–Teff table's own minimum instead of at absolute zero.
			const lo = Math.max(bounds[i][1], table[0][1]);
			const hi = i === 0 ? hottest : bounds[i - 1][1];
			bands[bounds[i][0]] = [lo, hi];
		}
		bands.RG = [3000, 4000];
		bands.RGe = [3000, 4000];
		bands.WD = [starTypes.WD_TEFF_FLOOR, 38000];
		return bands;
	})();

	// --- Star identity helpers ----------------------------------------------

	// The one seed every planetary draw hangs off (plan §2.3). `model.seed` is in
	// the key so a new galaxy re-rolls its planets; `blockKind` keeps a landmark
	// and a field star with equal keys apart.
	function systemSeed(key, modelSeed, blockKind) {
		return hash.hash4(key >>> 0, modelSeed | 0, DOMAIN_PLANETS, blockKind | 0);
	}

	// Landmark keys are positional (the block's index, so no cell bookkeeping);
	// catalog keys are (cell, index inside the cell payload), which survives the
	// cell manager's thinning because the payload index is not the output slot.
	function landmarkKey(index) {
		return hash.hash4(DOMAIN_LANDMARK, index | 0, 0, 0);
	}

	function catalogKey(cellId, slotInCell) {
		return hash.hash4(DOMAIN_CATALOG, cellId | 0, slotInCell | 0, 0);
	}

	// --- Luminosity ↔ mass (plan §2.5) --------------------------------------

	// Invert `luminosityFromMass` branch by branch. The law is piecewise
	// L = M^α and jumps *down* at 0.7 M☉ (L(0.7⁻) = 0.440, L(0.7⁺) = 0.240), so
	// luminosities in (0.240, 0.440) have two mathematical roots; the smallest
	// valid one is taken — the fainter star for an unremarkable magnitude.
	const LUM_BRANCHES = [[0.7, 2.3], [2.0, 4.0], [20, 3.5], [Infinity, 2.8]];
	function massFromLuminosity(lum) {
		const target = lum > 1e-12 ? lum : 1e-12;
		let best = -1;
		for (let i = 0; i < LUM_BRANCHES.length; i++) {
			const alpha = LUM_BRANCHES[i][1];
			const m = Math.pow(target, 1 / alpha);
			const lo = i === 0 ? 0 : LUM_BRANCHES[i - 1][0];
			if (m >= lo && m < LUM_BRANCHES[i][0] && (best < 0 || m < best)) best = m;
		}
		// A luminosity outside every branch's range (a record at the extremes of
		// the magnitude byte) still needs an answer: the α = 4 root, clamped.
		if (best < 0) best = Math.max(0.08, Math.min(100, Math.pow(target, 1 / 4)));
		return best;
	}

	function luminosityFromMag(absMag) {
		return Math.pow(10, (4.83 - absMag) / 2.5);
	}

	// A record carries (colorIndex, absMag) and nothing else: the class names the
	// bracket, the magnitude names the luminosity, and the clamp lands the mass
	// inside the decade the class itself claims. `out.lum` receives the
	// luminosity so the caller does not compute it twice.
	function massFromClassAndMag(colorIndex, absMag, out) {
		const cls = records.SPECTRAL_CLASSES[colorIndex] || 'M';
		const bracket = CLASS_MASS_BRACKETS[cls] || CLASS_MASS_BRACKETS.M;
		const lum = luminosityFromMag(absMag);
		let m = massFromLuminosity(lum);
		if (m < bracket[0]) m = bracket[0];
		else if (m > bracket[1]) m = bracket[1];
		if (out) out.lum = lum;
		return m;
	}

	// R★/R☉ = sqrt(L/L☉)·(5772/Teff)² — L and Teff are all a radius needs, and
	// the same identity serves the generator's innermost orbit and its
	// equilibrium temperature.
	function stellarRadius(lum, teff) {
		const t = teff > 0 ? teff : TEFF_SUN;
		const scaled = TEFF_SUN / t;
		return Math.sqrt(lum > 0 ? lum : 0) * scaled * scaled;
	}

	// Geometric mean of the class's temperature band: the class is what the
	// record kept, and the mean is the honest centre of "somewhere in here".
	function teffForClass(spectralClass) {
		const band = CLASS_TEFF_BANDS[spectralClass] || CLASS_TEFF_BANDS.M;
		return Math.sqrt(band[0] * band[1]);
	}

	function stateForClass(spectralClass) {
		if (spectralClass === 'WD') return 'wd';
		if (spectralClass === 'RG' || spectralClass === 'RGe') return 'giant';
		return 'ms';
	}

	// --- Per-block stellar inputs (plan §2.4) -------------------------------

	// One shape for the snapshot, whichever path filled it: `deriveStar` writes
	// `luminosity`/`metallicity`, a record-derived star is built from `lum`, and
	// everything above this module reads `lum`/`metal`/`rStar`. `fromDerivation`
	// names the writer rather than testing the fields, so a reused `out` object
	// cannot carry a value from the previous call into this one.
	function finishInputs(out, fromDerivation) {
		if (fromDerivation) {
			out.lum = out.luminosity;
			out.metal = out.metallicity;
		} else {
			out.luminosity = out.lum;
			out.metallicity = out.metal;
		}
		out.rStar = stellarRadius(out.lum, out.teff);
		return out;
	}

	// `ref`  — what a pick produced: { kind, index, key, x, y, z, colorIndex, absMag }.
	//          `index` is the slot inside its block (plan §3.1): the field block's
	//          base is 0, so only the object block's member context needs it.
	//          `key` is the identity the renderer wrote (§2.2); the local and
	//          object paths are not derivable without it.
	// `ctx`  — { model, field, member }, where `field` is renderer.fieldBuffers()
	//          (the sampling arrays: x, y, z, R, distToArm, component, count) and
	//          `member` is renderer.starBlocks().member (the object block's
	//          per-slot age/component, written by objects.writeObjectMembers).
	// `out`  — mutated in place and returned: mass (M☉), lum (L☉), teff (K),
	//          rStar (R☉), age (Gyr), metal (Z), state, spectralClass,
	//          colorIndex, absMag.
	//
	// The two re-derivable blocks are re-derived bit-exactly: the procedural field
	// takes the same call with the same arguments and channels the renderer used,
	// and the local gap-fill's identity key *is* the renderer's `slotSeed`, so
	// `imul(key, 31) + 5` is its own deriveSeed. The other three — landmarks,
	// catalog stars and object members — keep only colour and magnitude in the
	// record, so §2.5 inverts them; their age is the model's frozen epoch and
	// their metallicity is the thin disc's (§2.4).
	function stellarInputs(ref, ctx, out) {
		const model = ctx.model;
		const kind = ref.kind | 0;

		if (kind === BLOCK_FIELD && ctx.field && ctx.field.count > 0) {
			const i = ref.index | 0;
			const field = ctx.field;
			// The identity key *is* `fieldStarSeed(seed, i)` truncated to u32 by the
			// renderer's Uint32Array; every channel the derivation reads goes
			// through pcgHash, which takes the seed mod 2^32, so re-deriving from
			// the stored key is bit-identical to the renderer's own call. Falling
			// back to the formula keeps a caller that has no key working.
			const key = (ref.key === undefined || ref.key === null)
				? starTypes.fieldStarSeed(model.seed, i) : (ref.key | 0);
			starTypes.deriveStar(model, key,
				field.component[i], field.R[i], field.distToArm[i], out, field.z[i]);
			return finishInputs(out, true);
		}

		if (kind === BLOCK_LOCAL) {
			const slotSeed = ref.key | 0;
			const decomposed = density.rhoDecomposed(model, ref.x, ref.y, ref.z);
			const component = density.sampleComponentIndex(decomposed, hash.hash01At(slotSeed, 3));
			starTypes.deriveStar(model, Math.imul(slotSeed, 31) + 5,
				component, decomposed.R, decomposed.distToArm, out, ref.z);
			return finishInputs(out, true);
		}

		// Object members are procedural too, but their record keeps neither the
		// object's age nor the component: the renderer writes both beside the
		// block (starBlocks().member, block-local slot), because the star was
		// derived with them. −1 marks a planetary nebula's central star, which the
		// renderer derived with derivePlanetaryCentral instead (plan §2.4).
		if (kind === BLOCK_OBJECT && ref.key !== undefined && ref.key !== null
			&& ctx.member && ctx.member.component) {
			const i = ref.index | 0;
			const key = ref.key | 0;
			const decomposed = density.rhoDecomposed(model, ref.x, ref.y, ref.z);
			if (ctx.member.component[i] < 0) {
				starTypes.derivePlanetaryCentral(key, density.COMPONENT_THIN,
					decomposed.R, decomposed.distToArm, out);
			} else {
				starTypes.deriveStarWithAge(model, key, ctx.member.component[i],
					decomposed.R, decomposed.distToArm, ctx.member.age[i], out);
			}
			return finishInputs(out, true);
		}

		const colorIndex = ref.colorIndex & 0xFF;
		out.colorIndex = colorIndex;
		out.absMag = ref.absMag;
		out.spectralClass = records.SPECTRAL_CLASSES[colorIndex] || 'M';
		out.state = stateForClass(out.spectralClass);
		out.teff = teffForClass(out.spectralClass);
		// massFromClassAndMag writes out.lum, so the magnitude's luminosity is
		// computed exactly once on this path.
		out.mass = massFromClassAndMag(colorIndex, ref.absMag, out);
		out.age = (model && model.populations && model.populations.age) || 0;
		out.metal = starTypes.metallicityFor(density.COMPONENT_THIN);
		return finishInputs(out, false);
	}

	// --- Occurrence (plan §4.4) ---------------------------------------------

	// Fischer & Valenti's P(giant) ∝ 10^(2[Fe/H]) with [Fe/H] = log10(Z/0.020)
	// — i.e. (Z/0.020)² — clamped so a halo star cannot erase its giant row and
	// a super-solar star cannot flood it.
	function fZFactor(z) {
		const f = (z / 0.020) * (z / 0.020);
		return f < 0.05 ? 0.05 : (f > 4 ? 4 : f);
	}

	// Mean planet count: the class row of the μ table (plan §4.4), 'M' as the
	// module's fallback for a class outside the closed list.
	function muForClass(spectralClass) {
		const mu = CLASS_MU[spectralClass];
		return mu === undefined ? CLASS_MU.M : mu;
	}

	// The class's row in the weight tables, 'M' as the fallback — one place for
	// the lookup every occurrence function shares.
	function classRowOf(spectralClass) {
		const i = records.SPECTRAL_CLASSES.indexOf(spectralClass);
		return i < 0 ? records.SPECTRAL_CLASSES.indexOf('M') : i;
	}

	// The per-system bulk weights (plan §4.4): the class row with `f_Z` applied
	// to the giant columns (gas, icegiant, mini) and the state rule applied,
	// raw (unnormalised) so the modifiers read exactly as the plan writes them.
	// `state` is `stellarInputs`' field: 'ms', 'giant' (only wide survivors —
	// rock/ice/super × 0.25) or 'wd' (the debris row IS the system: rock 0.30,
	// dwarf 0.70, replacing the class row). The rules touch disjoint columns
	// (f_Z only the giants, the giant state only rock/ice/super, the wd rule
	// everything), so their order does not matter.
	function bulkWeightsFor(spectralClass, metal, state, out) {
		if (state === 'wd') {
			for (let i = 0; i < BULKS.length; i++) out[i] = 0;
			out[BULK_INDEX.rock] = 0.30;
			out[BULK_INDEX.dwarf] = 0.70;
			return out;
		}
		const row = CLASS_BULK_WEIGHTS[classRowOf(spectralClass)];
		for (let i = 0; i < BULKS.length; i++) out[i] = row[i];
		const fz = fZFactor(metal);
		out[BULK_INDEX.gas] *= fz;
		out[BULK_INDEX.icegiant] *= fz;
		out[BULK_INDEX.mini] *= fz;
		if (state === 'giant') {
			out[BULK_INDEX.rock] *= 0.25;
			out[BULK_INDEX.ice] *= 0.25;
			out[BULK_INDEX.super] *= 0.25;
		}
		return out;
	}

	// The draw's scratch (plan §4.4): the modified weights renormalised into a
	// CDF, 7 floats in the caller's array, in place. The unmodified common case
	// is the load-time row copied — same values, since both paths round through
	// f32 (see CLASS_BULK_CDF).
	function bulkCdfFor(spectralClass, metal, state, out) {
		if (state !== 'ms' && state !== 'giant' && state !== 'wd') state = 'ms';
		const rowBase = classRowOf(spectralClass) * BULKS.length;
		if (state === 'ms' && fZFactor(metal) === 1) {
			for (let i = 0; i < BULKS.length; i++) out[i] = CLASS_BULK_CDF[rowBase + i];
			return out;
		}
		bulkWeightsFor(spectralClass, metal, state, out);
		let sum = 0;
		for (let i = 0; i < BULKS.length; i++) sum += out[i];
		let acc = 0;
		for (let i = 0; i < BULKS.length; i++) {
			acc += out[i] / sum;
			out[i] = Math.fround(acc);
		}
		out[BULKS.length - 1] = 1;
		return out;
	}

	// The count draw (plan §4.4): a geometric chain over the system's channel
	// stream — no PRNG state, no allocation, capped at MAX_PLANETS. Each step
	// continues with probability μ/(μ+n+1), so most stars have no planets, a
	// minority have a handful, and almost none are packed.
	function planetCount(systemSeed, mu) {
		let n = 0;
		while (n < MAX_PLANETS
			&& hash.hash01At(systemSeed, CH_COUNT_BASE + n) < mu / (mu + n + 1)) n++;
		return n;
	}

	// E[n] = Σ_{k≥1} Π_{j≤k} μ/(μ+j) — the analytic mean of the chain above
	// (plan §4.4): at μ = 1.2 it is 0.825, at 1.6 it is 1.0195, at 0.02 it is
	// 0.0198. The test pins these numbers and checks the draw against the
	// formula, so the chain cannot silently change shape.
	function expectedPlanetCount(mu) {
		let sum = 0, term = 1;
		for (let k = 1; k <= 1024; k++) {
			term *= mu / (mu + k);
			sum += term;
			if (term < 1e-12) break;
		}
		return sum;
	}

	// --- Architecture (plan §4.5) --------------------------------------------

	const TAU = Math.PI * 2;
	const AU_PER_R_SUN = R_SUN_M / AU_M;        // 0.0046504 — derived, not a second constant
	const M_EARTH_SUN = M_EARTH_KG / M_SUN_KG;  // planet masses → M☉ for the Hill ratio

	// The giant state's a_0 ≥ 1.5·R★_AU is an invariant here, not a branch:
	// STAR_CLEARANCE = 6 > 1.5 and R★ is the giant's inflated radius, so the
	// clearance already guarantees it (plan §4.5; the test pins it).
	function innerEdgeAU(rStar) {
		const edge = STAR_CLEARANCE * rStar * AU_PER_R_SUN;
		return edge > 0.012 ? edge : 0.012;
	}

	function outerEdgeAU(massStar, state) {
		const aOut = DISK_OUT_AU * Math.sqrt(massStar);
		return state === 'wd' && aOut > 0.05 ? 0.05 : aOut;
	}

	// The Hill repair's closed form (plan §4.5): the pair (i, i+1) is stable
	// when a_{i+1} ≥ a_i·(1+c)/(1−c) with this c. Masses in M⊕, the star's in
	// M☉ — the conversion lives here so the ratio is never fed a mixed-unit
	// pair. c ≥ 1 means no finite separation exists and the planet drops.
	function hillPushFactor(massSumEarth, massStar) {
		return 0.5 * K_HILL * Math.cbrt(massSumEarth * M_EARTH_SUN / (3 * massStar));
	}

	// Walk a 7-entry CDF (bulkCdfFor's output). The last entry is forced to 1,
	// so the walk always lands inside the row.
	function drawBulkIndex(cdf, u) {
		for (let i = 0; i < BULKS.length - 1; i++) if (u < cdf[i]) return i;
		return BULKS.length - 1;
	}

	// Log-uniform inside the bulk's §4.3 bracket: the ranges span decades, and
	// a flat draw would put nearly every giant at the top of its bracket.
	function massForBulk(bulkIndex, u) {
		const b = BULKS[bulkIndex];
		return b.massMin * Math.pow(b.massMax / b.massMin, u);
	}

	// The architecture record: struct-of-arrays at MAX_PLANETS capacity,
	// allocated once by the owner (the module's generateSystem in 0.5.1-7, the
	// tests directly). `slot` is each survivor's channel slot — the §2.3 `p`,
	// assigned at the axis sort and carried through the repair, so a dropped
	// neighbour never reshuffles a survivor's own draws.
	function createArchitecture() {
		return {
			n: 0, dropped: 0, a0: 0, aOut: 0, eScale: 0,
			slot: new Uint8Array(MAX_PLANETS),
			bulk: new Uint8Array(MAX_PLANETS),
			a: new Float64Array(MAX_PLANETS),
			mass: new Float64Array(MAX_PLANETS),
			e: new Float64Array(MAX_PLANETS),
			inc: new Float64Array(MAX_PLANETS),
			peri: new Float64Array(MAX_PLANETS),
			phase: new Float64Array(MAX_PLANETS),
			period: new Float64Array(MAX_PLANETS),
			rotHours: new Float64Array(MAX_PLANETS),
		};
	}

	const ARCH_CDF = new Float64Array(BULKS.length);

	// The §4.5 chain: count → axes → bulks → masses → repair → e/i/ω/θ/P/rot.
	// `star` is stellarInputs' output (mass, rStar, metal, state,
	// spectralClass); everything else is hash01At(seed, channel) on the §2.3
	// map. Pure in (seed, star), no allocation, out mutated and returned.
	function architecture(seed, star, out) {
		out.a0 = innerEdgeAU(star.rStar);
		out.aOut = outerEdgeAU(star.mass, star.state);
		out.n = 0;
		out.dropped = 0;
		out.eScale = 0.2 + 1.6 * hash.hash01At(seed, CH_ESCALE);
		// Crossed edges mean no disc at all (plan §4.5): reachable when a
		// record-derived WD claims a large radius.
		if (out.a0 >= out.aOut) return out;
		const drawn = planetCount(seed, muForClass(star.spectralClass));
		if (drawn === 0) return out;
		const cdf = bulkCdfFor(star.spectralClass, star.metal, star.state, ARCH_CDF);

		// Axes per slot, insertion-sorted ascending with the slot carried.
		const lnA0 = Math.log(out.a0);
		const lnSpan = Math.log(out.aOut) - lnA0;
		for (let p = 0; p < drawn; p++) {
			const axis = Math.exp(lnA0 + lnSpan * hash.hash01At(seed, CH_SLOT_BASE + 8 * p + CH_AXIS));
			let j = p;
			while (j > 0 && out.a[j - 1] > axis) {
				out.a[j] = out.a[j - 1];
				out.slot[j] = out.slot[j - 1];
				j--;
			}
			out.a[j] = axis;
			out.slot[j] = p;
		}

		// Bulks and masses before the repair — the Hill radius needs both masses.
		for (let i = 0; i < drawn; i++) {
			const base = CH_SLOT_BASE + 8 * out.slot[i];
			const b = drawBulkIndex(cdf, hash.hash01At(seed, base + CH_BULK));
			out.bulk[i] = b;
			out.mass[i] = massForBulk(b, hash.hash01At(seed, base + CH_MASS));
		}

		// The repair: push out to K_HILL mutual Hill radii or drop on overflow,
		// compacting survivors in place (reads stay ahead of writes).
		let n = 0;
		for (let i = 0; i < drawn; i++) {
			let axis = out.a[i];
			if (n > 0) {
				const c = hillPushFactor(out.mass[n - 1] + out.mass[i], star.mass);
				if (c >= 1) continue;
				const required = out.a[n - 1] * (1 + c) / (1 - c);
				if (axis < required) axis = required;
			}
			if (axis > out.aOut) continue;
			out.a[n] = axis;
			out.slot[n] = out.slot[i];
			out.bulk[n] = out.bulk[i];
			out.mass[n] = out.mass[i];
			n++;
		}
		out.n = n;
		out.dropped = drawn - n;

		// Elements per survivor, every channel its slot's (plan §4.5): one
		// eScale for the whole system, u² biasing e toward circular, the
		// inclination in degrees, Kepler III in (AU, M☉, yr), the rotation on
		// the channel the moon count will share.
		for (let i = 0; i < n; i++) {
			const base = CH_SLOT_BASE + 8 * out.slot[i];
			const b = BULKS[out.bulk[i]];
			const ue = hash.hash01At(seed, base + CH_ECC);
			out.e[i] = out.eScale * b.eccMax * ue * ue;
			out.inc[i] = out.eScale * 3 * hash.hash01At(seed, base + CH_INC);
			out.peri[i] = TAU * hash.hash01At(seed, base + CH_PERI);
			out.phase[i] = TAU * hash.hash01At(seed, base + CH_PHASE);
			out.period[i] = Math.sqrt(out.a[i] * out.a[i] * out.a[i] / star.mass);
			out.rotHours[i] = b.rotMin + (b.rotMax - b.rotMin) * hash.hash01At(seed, base + CH_ROT);
		}
		return out;
	}

	const PlanetsLib = {
		AU_M, M_SUN_KG, G_SI, M_EARTH_KG, R_EARTH_M, R_SUN_M, TEFF_SUN, RHO_EARTH,
		MAX_PLANETS, MAX_BELTS, STIPPLE_N, A_SNOW_K, HZ_S_IN, HZ_S_OUT, K_HILL,
		STAR_CLEARANCE, DISK_OUT_AU, A_LOCK, RUNAWAY_DT, RUNAWAY_ALBEDO,
		TERRAN_DT_BASE, TERRAN_DT_SPAN, TERRAN_DT_MAX, AIRLESS_M, ATM_RETAIN_M, DEORBIT_DV,
		BLOCK_FIELD, BLOCK_LANDMARK, BLOCK_OBJECT, BLOCK_LOCAL, BLOCK_CATALOG, BLOCK_NAMES,
		DOMAIN_PLANETS, DOMAIN_LANDMARK, DOMAIN_CATALOG,
		CH_ESCALE, CH_COUNT_BASE, CH_SLOT_BASE, CH_BULK, CH_AXIS, CH_MASS, CH_ECC,
		CH_INC, CH_PERI, CH_PHASE, CH_ROT, CH_BELT_INNER, CH_BELT_OUTER, CH_STIPPLE_BASE,
		DISPLAY_TYPES, DISPLAY_INDEX, ATMOSPHERES, BULKS, BULK_INDEX, CLASS_MU,
		CLASS_BULK_WEIGHTS, CLASS_BULK_CDF,
		CLASS_MASS_BRACKETS, CLASS_TEFF_BANDS,
		systemSeed, landmarkKey, catalogKey,
		massFromLuminosity, massFromClassAndMag, luminosityFromMag, stellarRadius,
		teffForClass, stateForClass, stellarInputs,
		fZFactor, muForClass, bulkWeightsFor, bulkCdfFor, planetCount, expectedPlanetCount,
		AU_PER_R_SUN, M_EARTH_SUN,
		innerEdgeAU, outerEdgeAU, hillPushFactor, drawBulkIndex, massForBulk,
		createArchitecture, architecture,
	};
	if (typeof module !== 'undefined') module.exports = PlanetsLib;
	if (typeof window !== 'undefined') window.PlanetsLib = PlanetsLib;
})();
