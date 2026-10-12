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
//     struct-of-arrays record `createArchitecture` builds,
//   * the insolation/temperature/band tier (plan §4.6, 0.5.1-5): insolation,
//     the HZ edges, the equilibrium temperature, the four-band classification,
//     the mass-tier band-refinement table (one flat lookup, no iteration), the
//     runaway-greenhouse bifurcation, the carbonate-silicate Walker thermostat
//     with its clamp, the tidal-locking rule, the hot-Jupiter flag and the
//     HZ/terran/lockedHZ flags — the whole pass in one `thermal()` call so the
//     full tier and the summary tier cannot drift apart,
//   * the belt/moon tier (plan §4.7/§4.8, 0.5.1-6): the snow line, the debris
//     fade, the presence law with its giant scouring, the two belts' authored
//     coefficient rows, the cap that keeps the inner belt inside the outer one
//     (the degenerate giant and wd cases), the Ceres typical-body constants,
//     the per-belt stipple seed and its angle/radius law, and the moon count,
//   * the record tier (plan §4.9/§4.10/§4.11, 0.5.1-7): `createSystemRecord`'s
//     struct-of-arrays layout, the one `generateSystem(ref, ctx, out)` call that
//     runs `stellarInputs` → occurrence → architecture → `thermal` per planet →
//     belts → moons into it, the shared `walkPlanets` that makes
//     `systemSummary`'s histograms equal the full tier's by construction, and
//     the §4.11 designation writers (a reusable byte buffer, not concatenation).
//
// Everything here is a pure function of (model, key, record): no PRNG
// state and no objects allocated — every entry point mutates a caller-owned `out` record,
// which is also what keeps V8's escape analysis from being the only thing standing between
// the search loop and a per-call allocation (see findings-pitfalls-skills.md).
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
	const S_EXTREME = 8;                 // S⊕; band 0 above this — molten at any mass
	const S_LOCK = 50;                   // S⊕; the same locking rule's insolation catch
	const S_HOT_JUPITER = 20;            // S⊕; the readout/search flag, not a display type
	const RUNAWAY_DT = 500;              // K, Venus-calibrated
	const RUNAWAY_ALBEDO = 0.70;
	const TERRAN_DT_BASE = 33;
	const TERRAN_DT_SPAN = 55;
	const TERRAN_DT_MAX = 65;
	const AIRLESS_M = 0.02;              // M⊕; below this, no atmosphere at all
	const ATM_RETAIN_M = 0.3;            // M⊕; below this, no runaway, no thermostat
	const TERRAN_M_MIN = 0.5;            // M⊕; the `terran` flag's mass window
	const TERRAN_M_MAX = 5;
	const TERRAN_AGE_MIN = 0.5;          // Gyr; a biosphere needs time
	const DEORBIT_DV = 0.15;             // km/s; the floor of a landing burn
	// Belts (plan §4.7). The per-belt coefficients are the BELT_KINDS rows;
	// these are the scalars the presence law and the typical body need.
	const BELT_P_MAX = 0.90;             // presence ceiling at zero scouring
	const BELT_SCOUR = 0.35;             // per giant orbiting inside the belt
	const BELT_FADE_FLOOR = 0.25;        // the residual old-disc population
	const BELT_FADE_TAU = 1.5;           // Gyr; fade = floor + (1−floor)·exp(−age/τ)
	const BELT_WD_PRESENCE = 0.80;       // §4.4: a wd's inner belt is forced
	const BELT_BODY_R_M = 470e3;         // the Ceres analog every belt carries
	const BELT_BODY_MASS_KG = 9.4e20;
	const BELT_BODY_ALBEDO = 0.09;
	// Derived, not authored twice: M/(4/3·π·R³) is 2161 kg/m³, the published
	// Ceres density, so the three numbers cannot drift apart.
	const BELT_BODY_RHO = BELT_BODY_MASS_KG
		/ ((4 / 3) * Math.PI * BELT_BODY_R_M * BELT_BODY_R_M * BELT_BODY_R_M);
	// The record and its designations (plan §4.9/§4.11).
	const NAME_CAPACITY = 32;            // the record's landmark label, bytes
	const DESIGNATION_CAPACITY = 16;     // "S1Y3K9P b" / "belt 2" — 12 is already enough
	const HOURS_PER_YEAR = 365.25 * 24;  // a tidally locked world's rotHours = period·8766
	const FLAG_LOCKED = 1, FLAG_HOT_JUPITER = 2, FLAG_TERRAN = 4, FLAG_IN_HZ = 8;
	const BELT_BODY_MU = G_SI * BELT_BODY_MASS_KG;   // m³/s², the dv map's belt node

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
	// same. `dtBase` is the greenhouse term added to Teq *unless* a rule owns
	// it: TERRAN and SUPER_EARTH share the TERRAN_DT_BASE anchor because the
	// thermostat (§4.2) regulates both to the same target, and the super's
	// extra warmth comes from its lower albedo, not from a bigger ΔT.
	const DISPLAY_TYPES = [
		{ id: 0, name: 'LAVA', bulk: 'rock', color: [255, 90, 42], albedo: 0.10, atmosphere: 'none', dtBase: 0 },
		{ id: 1, name: 'BARREN', bulk: 'rock', color: [154, 143, 130], albedo: 0.12, atmosphere: 'none', dtBase: 0 },
		{ id: 2, name: 'DESERT', bulk: 'rock', color: [217, 164, 91], albedo: 0.28, atmosphere: 'thin', dtBase: 8 },
		{ id: 3, name: 'TERRAN', bulk: 'rock', color: [79, 157, 224], albedo: 0.30, atmosphere: 'breathable', dtBase: TERRAN_DT_BASE },
		{ id: 4, name: 'ICE', bulk: 'ice', color: [207, 232, 245], albedo: 0.65, atmosphere: 'thin', dtBase: 8 },
		{ id: 5, name: 'SUPER_EARTH', bulk: 'super', color: [164, 209, 106], albedo: 0.25, atmosphere: 'thick', dtBase: TERRAN_DT_BASE },
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

	// The §2.4 record, one shape for every path: `deriveStar` writes
	// `luminosity`/`metallicity`, a record-derived star is built from
	// `lum`/`metal`, and `finishInputs` mirrors whichever pair its writer used.
	// `generateSystem` keeps one at module scope, so the generator allocates
	// nothing per call; a caller owns its own (a snapshot, a test) and gets the
	// same monomorphic shape.
	function createStellarInputs() {
		return {
			mass: 0, lum: 0, luminosity: 0, teff: 0, rStar: 0, age: 0,
			metal: 0, metallicity: 0, state: 'ms', spectralClass: 'M',
			colorIndex: 0, absMag: 0,
		};
	}

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

	// The Hill conversion both Hill users share (plan §4.5): planet masses in
	// M⊕ against the star's M☉, so the ratio is never fed a mixed-unit pair.
	// The repair multiplies it by K_HILL/2; the record's `rHill` is a·this.
	function hillRatio(massEarth, massStar) {
		return Math.cbrt(massEarth * M_EARTH_SUN / (3 * massStar));
	}

	// The Hill repair's closed form (plan §4.5): the pair (i, i+1) is stable
	// when a_{i+1} ≥ a_i·(1+c)/(1−c) with this c. c ≥ 1 means no finite
	// separation exists and the planet drops.
	function hillPushFactor(massSumEarth, massStar) {
		return 0.5 * K_HILL * hillRatio(massSumEarth, massStar);
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

	// §4.3's mass–radius law, the one place a planet's radius comes from:
	// R = Rref·(M/Mref)^p, one row per bulk.
	function radiusFor(bulkIndex, massEarth) {
		const b = BULKS[bulkIndex];
		return b.radiusRef * Math.pow(massEarth / b.massRef, b.p);
	}

	// The density that law implies, anchored on Earth's own `RHO_EARTH`:
	// ρ/ρ⊕ = (M/M⊕)/(R/R⊕)³, so rock's 1 M⊕ row is 5514 kg/m³ by construction
	// and the authored radius law is the record's only density input (plan
	// §4.3) — no second mass–radius table can drift from the first.
	function planetDensity(massEarth, radiusEarth) {
		return RHO_EARTH * massEarth / (radiusEarth * radiusEarth * radiusEarth);
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

	// --- Insolation, temperature, band refinement (plan §4.6) ---------------

	// Insolation in S⊕: L★/a², a in AU.  No albedo — it enters through Teq,
	// not through the band or the display type, and that is what makes the whole
	// tier one straight pass with nothing to iterate.
	function insolation(lum, aAU) {
		return lum / (aAU * aAU);
	}

	// The habitable zone's edges in AU (plan §4.6) — the same two constants the
	// band's edges use, so `inHZ` and `a_hz_in ≤ a ≤ a_hz_out` cannot disagree.
	// The schematic's HZ annulus (§6.2) and the search read these, not a copy.
	function hzInnerAU(lum) {
		return Math.sqrt(lum / HZ_S_IN);
	}

	function hzOuterAU(lum) {
		return Math.sqrt(lum / HZ_S_OUT);
	}

	// Equilibrium temperature (plan §4.6): Teff★ scaled by the square root of
	// the solid-angle fraction, dimmed by (1 − A)^0.25. Distances in AU and
	// radii in R☉ — the units the rest of the module speaks — through the one
	// derived ratio AU_PER_R_SUN, so no caller can hand this metres by mistake.
	// The fourth root is sqrt∘sqrt rather than Math.pow(x, 0.25): the same value
	// to within an ulp, on a path a 300k-star search walks once per planet.
	function equilibriumTemp(teff, rStar, aAU, albedo) {
		const absorb = 1 - albedo;
		return teff * Math.sqrt(rStar * AU_PER_R_SUN / (2 * aAU))
			* Math.sqrt(Math.sqrt(absorb));
	}

	// Insolation → band index, matching the plan's boundaries exactly:
	//   0: S > S_EXTREME  (everything is LAVA or a hot giant)
	//   1: S > HZ_S_IN    (hot: runaway for M ≥ ATM_RETAIN_M)
	//   2: S ≥ HZ_S_OUT   (the habitable band, thermostat-active)
	//   3: below that     (cold: everything freezes to ICE or a cold giant)
	function planetBand(insol) {
		if (insol > S_EXTREME) return 0;
		if (insol > HZ_S_IN) return 1;
		if (insol >= HZ_S_OUT) return 2;
		return 3;
	}

	// The band-refinement table (plan §4.6): BAND_REFINEMENT_SIZE mass tiers per
	// band, one flat lookup. The tiers are the two atmosphere-retention
	// thresholds plus super's own top row; the three gas bulks never enter it
	// (their display type does not depend on insolation) and dwarf is its own
	// two-case rule.
	const _LAVA = DISPLAY_INDEX.LAVA, _BARREN = DISPLAY_INDEX.BARREN;
	const _DESERT = DISPLAY_INDEX.DESERT, _TERRAN = DISPLAY_INDEX.TERRAN;
	const _ICE = DISPLAY_INDEX.ICE, _SE = DISPLAY_INDEX.SUPER_EARTH;
	const _MN = DISPLAY_INDEX.MINI_NEPTUNE, _GG = DISPLAY_INDEX.GAS_GIANT;
	const _IG = DISPLAY_INDEX.ICE_GIANT, _DWARF = DISPLAY_INDEX.DWARF;
	const BAND_REFINEMENT_SIZE = 4;
	const PLANET_BAND_DISPLAY = [
		// band 0: S > S_EXTREME — molten at any mass
		_LAVA, _LAVA, _LAVA, _LAVA,
		// band 1: hot. An airless world has nothing to boil, so tiers 0–1 keep
		// their band-2 types; only M ≥ ATM_RETAIN_M reaches DESERT, and its
		// runaway is a ΔT/albedo override, not another display type.
		_BARREN, _BARREN, _DESERT, _DESERT,
		// band 2: the habitable band
		_BARREN, _DESERT, _TERRAN, _SE,
		// band 3: cold
		_ICE, _ICE, _ICE, _ICE,
	];

	// The display types whose answer does not depend on band or mass. Rock, ice,
	// super and dwarf are −1: consult PLANET_BAND_DISPLAY instead.
	const PLANET_DISPLAY_THERMAL_INDEX = (function () {
		const idx = new Int8Array(BULKS.length).fill(-1);
		idx[BULK_INDEX.mini] = _MN;
		idx[BULK_INDEX.gas] = _GG;
		idx[BULK_INDEX.icegiant] = _IG;
		return idx;
	})();

	// The table's row: below AIRLESS_M nothing is retained at all, below
	// ATM_RETAIN_M there is no cycle to run, and above it a super-Earth is its
	// own row (SUPER_EARTH where rock and ice are TERRAN).
	function massTier(bulkIndex, mass) {
		if (mass < AIRLESS_M) return 0;
		if (mass < ATM_RETAIN_M) return 1;
		return bulkIndex === BULK_INDEX.super ? 3 : 2;
	}

	// The band refinement (plan §4.6): one flat lookup, no iteration, no
	// convergence question. Returns a display-type id.
	function planetDisplay(bulkIndex, mass, band) {
		const constant = PLANET_DISPLAY_THERMAL_INDEX[bulkIndex];
		if (constant >= 0) return constant;
		if (bulkIndex === BULK_INDEX.dwarf) return band === 0 ? _LAVA : _DWARF;
		return PLANET_BAND_DISPLAY[band * BAND_REFINEMENT_SIZE + massTier(bulkIndex, mass)];
	}

	// Runaway greenhouse (plan §4.2): a rocky/icy/super world of
	// M ≥ ATM_RETAIN_M in band 1 (above the HZ inner edge) boils its oceans
	// and never comes back.  Below the threshold there are no volatiles to
	// run away with — a Mercury-like world keeps its equilibrium temperature.
	function runawayGreenhouse(bulkIndex, mass, band) {
		if (band !== 1) return false;
		if (mass < ATM_RETAIN_M) return false;
		return bulkIndex === BULK_INDEX.rock || bulkIndex === BULK_INDEX.ice
			|| bulkIndex === BULK_INDEX.super;
	}

	// The albedo the temperature pass uses (plan §4.2): a runaway world is
	// cloud-shrouded, so it reflects far more than its display type's base
	// albedo — this is what puts Venus at Teq 242 K instead of 302 K. One
	// function, so the type table and the runaway rule cannot disagree.
	function albedoFor(displayId, runaway) {
		return runaway ? RUNAWAY_ALBEDO : DISPLAY_TYPES[displayId].albedo;
	}

	// Surface temperature: Teq + ΔT (plan §4.2/§4.6), three branches and no
	// iteration — runaway, thermostat, or the display type's own base. `runaway`
	// comes from runawayGreenhouse, so the predicate lives in one place.
	function surfaceTemp(teq, displayId, insol, runaway) {
		if (runaway) return teq + RUNAWAY_DT;
		let dt = DISPLAY_TYPES[displayId].dtBase;
		if (displayId !== _TERRAN && displayId !== _SE) return teq + dt;
		// The carbonate-silicate thermostat (Walker, Hays & Kasting 1981): a
		// colder world outgasses more CO₂, so the greenhouse term grows as
		// insolation falls, anchored at the type's own base (33 K at S = 1 for
		// Earth) and capped at the maximum greenhouse the cycle can hold. The
		// upper clamp is unreachable inside band 2 (S ≥ 0.35) and is what makes
		// the formula right for any caller.
		let feed = 1 - insol;
		if (feed < 0) feed = 0;
		else if (feed > 1) feed = 1;
		dt += TERRAN_DT_SPAN * feed;
		if (dt > TERRAN_DT_MAX) dt = TERRAN_DT_MAX;
		return teq + dt;
	}

	// Tidal locking (plan §4.6): locked inside A_LOCK·sqrt(M★) or above the
	// insolation catch, which is what makes every hot Jupiter locked.
	function isTidallyLocked(aAU, insol, massStar) {
		return aAU < A_LOCK * Math.sqrt(massStar) || insol > S_LOCK;
	}

	// The hot-Jupiter flag (plan §4.6): a gas or mini-Neptune world above
	// S_HOT_JUPITER. Readout and search only — never a display type.
	function isHotJupiter(bulkIndex, insol) {
		if (insol <= S_HOT_JUPITER) return false;
		return bulkIndex === BULK_INDEX.gas || bulkIndex === BULK_INDEX.mini;
	}

	// The habitable-zone and terran flags (plan §4.6), written into `out` (the
	// thermal record) so a per-planet pass allocates nothing. `locked` excludes
	// the tidally-locked M-dwarf worlds from the plain `terran` flag: they are
	// still searchable by temperature, but "terran" here means an Earth analog
	// with free rotation, and `lockedHZ` keeps them findable. No runaway test —
	// runaway is band 1 and `inHZ` is band 2, so the two are already exclusive
	// by construction (the test pins that invariant instead of a dead `&&`).
	function hzFlags(displayId, mass, band, locked, age, out) {
		const inHZ = band === 2;
		out.inHZ = inHZ;
		out.lockedHZ = inHZ && locked;
		out.terran = inHZ && !locked
			&& (displayId === _TERRAN || displayId === _SE)
			&& mass >= TERRAN_M_MIN && mass <= TERRAN_M_MAX
			&& age > TERRAN_AGE_MIN;
		return out;
	}

	// One planet's whole §4.6 pass, in the plan's order: S needs no albedo, so
	// band → display → runaway → albedo → Teq → Tsurf → flags is a straight
	// line. The full tier (generateSystem, 0.5.1-7) and the summary tier (§4.10)
	// both call this, which is what makes "a summary always agrees with the full
	// system" an identity rather than a hope.
	function createThermal() {
		return {
			insol: 0, band: 0, displayId: 0, albedo: 0, teq: 0, tsurf: 0,
			runaway: false, locked: false, hotJupiter: false,
			inHZ: false, terran: false, lockedHZ: false,
		};
	}

	// `star` is stellarInputs' record (lum, teff, rStar, mass, age); `aAU`,
	// `bulkIndex` and `mass` (M⊕) come from the architecture record.
	function thermal(star, aAU, bulkIndex, mass, out) {
		const insol = insolation(star.lum, aAU);
		const band = planetBand(insol);
		const displayId = planetDisplay(bulkIndex, mass, band);
		const runaway = runawayGreenhouse(bulkIndex, mass, band);
		const albedo = albedoFor(displayId, runaway);
		const teq = equilibriumTemp(star.teff, star.rStar, aAU, albedo);
		out.insol = insol;
		out.band = band;
		out.displayId = displayId;
		out.albedo = albedo;
		out.runaway = runaway;
		out.hotJupiter = isHotJupiter(bulkIndex, insol);
		out.teq = teq;
		out.tsurf = surfaceTemp(teq, displayId, insol, runaway);
		out.locked = isTidallyLocked(aAU, insol, star.mass);
		return hzFlags(displayId, mass, band, out.locked, star.age, out);
	}

	// --- Belts (plan §4.7) ---------------------------------------------------

	const BELT_INNER = 0, BELT_OUTER = 1;
	// One row per belt: `channel` is the §2.3 base (its presence draws at +0),
	// `k0/k1` the centre as a fraction of the belt's reference radius (the snow
	// line for the asteroid analog, the disc edge for the Kuiper analog),
	// `dln0/dln1` the width span in ln a and `m0/m1` the mass span in
	// log10 M⊕. Authored from the Solar System's two belts, not fitted.
	const BELT_KINDS = [
		{ name: 'inner', channel: CH_BELT_INNER, k0: 0.55, k1: 0.40, dln0: 0.10, dln1: 0.25, m0: -4, m1: 2.5 },
		{ name: 'outer', channel: CH_BELT_OUTER, k0: 0.35, k1: 0.45, dln0: 0.15, dln1: 0.35, m0: -2, m1: 2.0 },
	];
	// A belt's channel offsets at its base (200 inner, 210 outer). Every belt
	// reads all five whether or not its presence draw passes, so a missing belt
	// never shifts another one's draws.
	const BELT_CH_PRESENCE = 0, BELT_CH_AXIS = 1, BELT_CH_WIDTH = 2;
	const BELT_CH_MASS = 3, BELT_CH_STIPPLE = 4;

	// The snow line (plan §4.7): the ices condense here, so it is the asteroid
	// belt's reference radius and — through `sqrt(L)` — the one thing that moves
	// the belts when a star evolves. 2.7 AU for the Sun.
	function snowLineAU(lum) {
		return A_SNOW_K * Math.sqrt(lum);
	}

	// The debris fade (plan §4.7): fractional luminosity falls by about an order
	// of magnitude over the first Gyr, so a young system is belt-rich and an old
	// one keeps the floor's residual population.
	function debrisFade(ageGyr) {
		return BELT_FADE_FLOOR
			+ (1 - BELT_FADE_FLOOR) * Math.exp(-ageGyr / BELT_FADE_TAU);
	}

	// Presence (plan §4.7): the faded disc fraction minus the scouring, one term
	// per giant orbiting inside the belt. Steep on purpose — three giants inside
	// and the belt is gone.
	function beltPresence(ageGyr, giants) {
		const p = BELT_P_MAX * debrisFade(ageGyr) - BELT_SCOUR * giants;
		return p < 0 ? 0 : p > 1 ? 1 : p;
	}

	// The scouring count (plan §4.7): gas, ice giant and mini-Neptune worlds
	// inside the belt's centre. `arch.a` is ascending — the architecture tier
	// insertion-sorts it — so the walk stops at the first orbit beyond the belt.
	function giantsInsideBelt(arch, aBelt) {
		let n = 0;
		for (let i = 0; i < arch.n; i++) {
			if (arch.a[i] >= aBelt) break;
			const b = arch.bulk[i];
			if (b === BULK_INDEX.gas || b === BULK_INDEX.icegiant
				|| b === BULK_INDEX.mini) n++;
		}
		return n;
	}

	// The belt record: two slots, struct-of-arrays, filled by `belts()`. A belt
	// whose presence draw fails is not written — `count` is 0, 1 or 2 and there
	// is never a zero-mass placeholder (plan §4.7). `kind` keeps which belt is
	// which, since a failed inner belt leaves the outer one at slot 0.
	function createBelts() {
		return {
			count: 0,
			kind: new Uint8Array(MAX_BELTS),
			a: new Float64Array(MAX_BELTS),
			dlnA: new Float64Array(MAX_BELTS),
			mass: new Float64Array(MAX_BELTS),
			stippleSeed: new Uint32Array(MAX_BELTS),
		};
	}

	// The stipple's own seed (plan §2.3 channel 204/214 → §4.9's `stippleSeed`):
	// a hash4 of the belt's stipple-base channel, so the 2·STIPPLE_N dot draws
	// live in a fresh channel space per belt and a record can carry one number
	// instead of 768 of them.
	function beltStippleSeed(seed, channelBase) {
		return hash.hash4(seed, channelBase + BELT_CH_STIPPLE, CH_STIPPLE_BASE, STIPPLE_N);
	}

	// The stipple law (plan §4.7, drawn by §6.2): the angle uniform, the radius
	// log-uniform across the belt's own ±Δln a, so the drawn belt is exactly as
	// thick as the record says. `angles`/`radii` are the layer's preallocated
	// arrays (§6.5) — STIPPLE_N entries of each, no allocation here — and the
	// layer only maps (angle, radius) through ρ(a) and the belt's own Kepler
	// rotation, once per system.
	function fillStipple(stippleSeed, aBelt, dlnA, angles, radii) {
		for (let j = 0; j < STIPPLE_N; j++) {
			angles[j] = TAU * hash.hash01At(stippleSeed, 2 * j);
			radii[j] = aBelt
				* Math.exp(dlnA * (2 * hash.hash01At(stippleSeed, 2 * j + 1) - 1));
		}
	}

	// The §4.7 pass: `star` is stellarInputs' record, `arch` the architecture
	// record whose giants do the scouring. Both belts draw first and test
	// presence second, so a missing belt costs no shift in the draws.
	function belts(seed, star, arch, out) {
		out.count = 0;
		const aLo = innerEdgeAU(star.rStar);
		const aHi = outerEdgeAU(star.mass, star.state);
		if (aLo >= aHi) return out;                  // no disc, no belts
		const snow = snowLineAU(star.lum);
		const wd = star.state === 'wd';
		for (let k = 0; k < MAX_BELTS; k++) {
			if (k === BELT_OUTER && wd) break;       // §4.4: a wd has no Kuiper analog
			const kind = BELT_KINDS[k];
			// The inner belt can never start beyond the outer belt's innermost
			// possible centre. That clamp is what keeps `a` ascending whatever a
			// giant's or a remnant's luminosity does to the snow line — a giant
			// star's snow line falls outside its disc, and this is where the
			// asteroid analog goes instead of past the Kuiper analog.
			const ceiling = k === BELT_INNER ? aHi * BELT_KINDS[BELT_OUTER].k0 : aHi;
			if (aLo >= ceiling) continue;            // no room for this belt
			const uAxis = hash.hash01At(seed, kind.channel + BELT_CH_AXIS);
			const uWidth = hash.hash01At(seed, kind.channel + BELT_CH_WIDTH);
			const uMass = hash.hash01At(seed, kind.channel + BELT_CH_MASS);
			// The reference radius capped at the ceiling, then the clamp into the
			// disc. For a wd the snow line is outside the 0.05 AU cut, so the cap
			// is what turns its belt into the compact debris ring §4.4 asks for
			// instead of a ring beyond the disc.
			const ref = k === BELT_INNER ? snow : aHi;
			const capped = ref < ceiling ? ref : ceiling;
			let a = capped * (kind.k0 + kind.k1 * uAxis);
			if (a < aLo) a = aLo;
			else if (a > ceiling) a = ceiling;
			const presence = wd ? BELT_WD_PRESENCE
				: beltPresence(star.age, giantsInsideBelt(arch, a));
			if (hash.hash01At(seed, kind.channel + BELT_CH_PRESENCE) >= presence) continue;
			const i = out.count;
			out.kind[i] = k;
			out.a[i] = a;
			out.dlnA[i] = kind.dln0 + kind.dln1 * uWidth;
			out.mass[i] = Math.pow(10, kind.m0 + kind.m1 * uMass);
			out.stippleSeed[i] = beltStippleSeed(seed, kind.channel);
			out.count = i + 1;
		}
		return out;
	}

	// --- Moons (plan §4.8) ---------------------------------------------------

	// A count, not a system: u³, so most worlds have none and a giant reaches
	// its real scale (Jupiter 95, Saturn 146) without a per-moon pass. Shares
	// the rotation channel — the one channel §2.3 gives it (row 39).
	function moonCount(bulkIndex, u) {
		return (BULKS[bulkIndex].moonsMax * u * u * u) | 0;
	}

	// --- The system record and its two tiers (plan §4.9/§4.10, 0.5.1-7) -----

	// §4.9's record: fixed capacity, struct-of-arrays, one instance per open
	// system (the view owns one, the test another). Nothing here is per-frame —
	// the readout reads it at 4 Hz and the schematic reads it per draw, which is
	// why the buffer is caller-owned rather than a module singleton with hidden
	// state.
	function createSystemRecord() {
		// The belt block *is* the §4.7 record — `belts()` writes into it — and
		// the only thing added on top is the typical body: §4.7's two module
		// constants, references rather than per-slot columns, because every
		// belt in the galaxy carries the same Ceres analog.
		const belts = createBelts();
		belts.typicalBodyMu = BELT_BODY_MU;
		belts.typicalBodyR = BELT_BODY_R_M;
		return {
			star: {
				key: 0, mass: 0, lum: 0, teff: 0, rStar: 0, age: 0, metal: 0,
				state: 'ms', spectralClass: 'M', colorIndex: 0,
				aHzIn: 0, aHzOut: 0, aSnow: 0, aOut: 0,
				name: new Uint8Array(NAME_CAPACITY), nameLen: 0,
			},
		planets: {
			a: new Float64Array(MAX_PLANETS),
			mass: new Float64Array(MAX_PLANETS),
			radius: new Float64Array(MAX_PLANETS),
			density: new Float64Array(MAX_PLANETS),
			e: new Float64Array(MAX_PLANETS),
			inc: new Float64Array(MAX_PLANETS),
			peri: new Float64Array(MAX_PLANETS),
			phase: new Float64Array(MAX_PLANETS),
			period: new Float64Array(MAX_PLANETS),
			teq: new Float64Array(MAX_PLANETS),
			tsurf: new Float64Array(MAX_PLANETS),
			insolation: new Float64Array(MAX_PLANETS),
			rHill: new Float64Array(MAX_PLANETS),
			rotHours: new Float64Array(MAX_PLANETS),
			moons: new Uint8Array(MAX_PLANETS),
			bulk: new Uint8Array(MAX_PLANETS),
			displayType: new Uint8Array(MAX_PLANETS),
			flags: new Uint8Array(MAX_PLANETS),
		},
			// §4.7's own record, plus the two typical-body scalars set above.
			belts,
			counts: { planets: 0, terranCount: 0, giantCount: 0 },
		};
	}

	// §4.10's summary: what a search needs to decide, and nothing a search
	// cannot act on. The four extreme pairs are §5.1's range predicates —
	// "does this star have a planet with `a`/mass/Teq/Tsurf inside [lo, hi]"
	// is `max ≥ lo && min ≤ hi` — and they start at the empty sentinels
	// (`+Infinity` / `-Infinity`) so a planetless system cannot match a
	// range. `bestTerranS` is the winning candidate's insolation — the value
	// the |S − 1| ordering reads — so the rule needs no hidden walk state.
	// One `resetSummary` owns the empty state, so the factory below and the
	// per-call reset in `systemSummary` cannot drift apart.
	function resetSummary(out) {
		out.count = 0;
		out.terranCount = 0;
		out.beltCount = 0;
		out.aMin = Infinity; out.aMax = -Infinity;
		out.massMin = Infinity; out.massMax = -Infinity;
		out.teqMin = Infinity; out.teqMax = -Infinity;
		out.tsurfMin = Infinity; out.tsurfMax = -Infinity;
		out.bulkHistogram.fill(0);
		out.typeHistogram.fill(0);
		out.bestTerranA = 0;
		out.bestTerranMass = 0;
		out.bestTerranTsurf = 0;
		out.bestTerranS = 0;
		out.bestTerranType = 0;
		return out;
	}

	function createSystemSummary() {
		return resetSummary({
			count: 0, terranCount: 0, beltCount: 0,
			aMin: 0, aMax: 0, massMin: 0, massMax: 0,
			teqMin: 0, teqMax: 0, tsurfMin: 0, tsurfMax: 0,
			bulkHistogram: new Uint8Array(BULKS.length),
			typeHistogram: new Uint8Array(DISPLAY_TYPES.length),
			bestTerranA: 0, bestTerranMass: 0, bestTerranTsurf: 0,
			bestTerranS: 0, bestTerranType: 0,
		});
	}

	// One planet's record row: the architecture's elements, the thermal pass's
	// outputs, and the three derived columns — radius and density from §4.3's
	// law, `rHill` from the same conversion the stability repair uses. The
	// rotation is the architecture's own draw, replaced by the period when §4.6
	// locked the world, and the moon count reads that same channel-39 draw.
	function writePlanet(p, i, seed, star, arch, th) {
		const bulkIndex = arch.bulk[i];
		const b = BULKS[bulkIndex];
		const mass = arch.mass[i];
		const aAU = arch.a[i];
		const radius = radiusFor(bulkIndex, mass);
		const u = hash.hash01At(seed, CH_SLOT_BASE + 8 * arch.slot[i] + CH_ROT);
		p.a[i] = aAU;
		p.mass[i] = mass;
		p.radius[i] = radius;
		p.density[i] = planetDensity(mass, radius);
		p.e[i] = arch.e[i];
		p.inc[i] = arch.inc[i];
		p.peri[i] = arch.peri[i];
		p.phase[i] = arch.phase[i];
		p.period[i] = arch.period[i];
		p.teq[i] = th.teq;
		p.tsurf[i] = th.tsurf;
		p.insolation[i] = th.insol;
		p.rHill[i] = aAU * hillRatio(mass, star.mass);
		p.rotHours[i] = th.locked ? arch.period[i] * HOURS_PER_YEAR : arch.rotHours[i];
		p.moons[i] = moonCount(bulkIndex, u);
		p.bulk[i] = bulkIndex;
		p.displayType[i] = th.displayId;
		let flags = 0;
		if (th.locked) flags |= FLAG_LOCKED;
		if (th.hotJupiter) flags |= FLAG_HOT_JUPITER;
		if (th.terran) flags |= FLAG_TERRAN;
		if (th.inHZ) flags |= FLAG_IN_HZ;
		p.flags[i] = flags;
	}

	// The one planet walk both tiers run (plan §4.10): the same count draw, the
	// same architecture, the same per-planet `thermal` pass — the full tier
	// writes the record's columns and counts, the summary accumulates. One
	// function, so "a summary of a system and the full system always agree" is
	// structural rather than a promise, and the pass a summary skips (orbits)
	// is 0.1 µs of its 6 µs budget.
	function walkPlanets(seed, star, arch, record, summary) {
		for (let i = 0; i < arch.n; i++) {
			const bulkIndex = arch.bulk[i];
			const mass = arch.mass[i];
			const th = thermal(star, arch.a[i], bulkIndex, mass, THERMAL_SCRATCH);
			if (record) {
				writePlanet(record.planets, i, seed, star, arch, th);
				if (th.terran) record.counts.terranCount++;
				if (bulkIndex === BULK_INDEX.gas || bulkIndex === BULK_INDEX.icegiant
					|| bulkIndex === BULK_INDEX.mini) record.counts.giantCount++;
			}
				if (summary) {
					summary.bulkHistogram[bulkIndex]++;
					summary.typeHistogram[th.displayId]++;
					// §5.1's range predicates read these eight numbers.
					const aAU = arch.a[i];
					if (aAU < summary.aMin) summary.aMin = aAU;
					if (aAU > summary.aMax) summary.aMax = aAU;
					if (mass < summary.massMin) summary.massMin = mass;
					if (mass > summary.massMax) summary.massMax = mass;
					if (th.teq < summary.teqMin) summary.teqMin = th.teq;
					if (th.teq > summary.teqMax) summary.teqMax = th.teq;
					if (th.tsurf < summary.tsurfMin) summary.tsurfMin = th.tsurf;
					if (th.tsurf > summary.tsurfMax) summary.tsurfMax = th.tsurf;
					if (th.terran) {
						summary.terranCount++;
						if (summary.terranCount === 1
							|| Math.abs(th.insol - 1) < Math.abs(summary.bestTerranS - 1)) {
							summary.bestTerranA = aAU;
						summary.bestTerranMass = mass;
						summary.bestTerranTsurf = th.tsurf;
						summary.bestTerranS = th.insol;
						summary.bestTerranType = th.displayId;
					}
				}
			}
		}
		return record || summary;
	}

	// The record's label: the caller's string (a landmark's name, per §4.11),
	// copied once when the system is generated rather than looked up per draw —
	// `math/` cannot depend on `data/landmarks.js`, and Node has no window.
	function writeName(out, text) {
		if (!text) return 0;
		const n = text.length < NAME_CAPACITY ? text.length : NAME_CAPACITY;
		for (let i = 0; i < n; i++) out[i] = text.charCodeAt(i) & 0xFF;
		return n;
	}

	// The §2.2 identity a pick resolves to: the renderer's key when the caller
	// has it, and the two blocks whose key is positional when it does not (the
	// field block's own §2.4 fallback, landmarks by index). Every draw hangs
	// off this, so a stale slot can never become the seed.
	function identityKey(ref, modelSeed) {
		if (ref.key !== undefined && ref.key !== null) return ref.key >>> 0;
		const kind = ref.kind | 0;
		if (kind === BLOCK_FIELD) return starTypes.fieldStarSeed(modelSeed, ref.index | 0) >>> 0;
		if (kind === BLOCK_LANDMARK) return landmarkKey(ref.index | 0);
		return 0;
	}

	function writeStar(out, star, key, ctx) {
		out.key = key;
		out.mass = star.mass;
		out.lum = star.lum;
		out.teff = star.teff;
		out.rStar = star.rStar;
		out.age = star.age;
		out.metal = star.metal;
		out.state = star.state;
		out.spectralClass = star.spectralClass;
		out.colorIndex = star.colorIndex & 0xFF;
		out.aHzIn = hzInnerAU(star.lum);
		out.aHzOut = hzOuterAU(star.lum);
		out.aSnow = snowLineAU(star.lum);
		out.aOut = outerEdgeAU(star.mass, star.state);
		out.nameLen = writeName(out.name, ctx.name);
		return out;
	}

	// The whole generator (plan §4.9): one call from a pick to a record —
	// stellar inputs → occurrence → architecture → `thermal` per planet →
	// belts → counts. `ctx` is the input tier's own context
	// `{ model, field, member }`, plus `name` for a landmark's label.
	function generateSystem(ref, ctx, out) {
		const model = ctx.model;
		const star = stellarInputs(ref, ctx, STAR_SCRATCH);
		const key = identityKey(ref, model.seed);
		const seed = systemSeed(key, model.seed, ref.kind | 0);
		writeStar(out.star, star, key, ctx);
		architecture(seed, star, ARCH_SCRATCH);
		out.counts.planets = ARCH_SCRATCH.n;
		out.counts.terranCount = 0;
		out.counts.giantCount = 0;
		walkPlanets(seed, star, ARCH_SCRATCH, out, null);
		belts(seed, star, ARCH_SCRATCH, out.belts);
		return out;
	}

	// The summary tier (plan §4.10): the same star, the same seed, the same
	// walk — with the record's columns left untouched. The belt count is the
	// one belt fact a search reads (§5.1's `needsBelt`), and it comes from the
	// same `belts()` pass, into a scratch slot that no caller can see.
	function systemSummary(ref, ctx, out) {
		const model = ctx.model;
		const star = stellarInputs(ref, ctx, STAR_SCRATCH);
		const seed = systemSeed(identityKey(ref, model.seed), model.seed, ref.kind | 0);
			architecture(seed, star, ARCH_SCRATCH);
			resetSummary(out);
			out.count = ARCH_SCRATCH.n;
			walkPlanets(seed, star, ARCH_SCRATCH, null, out);
		belts(seed, star, ARCH_SCRATCH, BELT_SCRATCH);
		out.beltCount = BELT_SCRATCH.count;
		return out;
	}

	// --- Designations (plan §4.11) ------------------------------------------

	const BASE36 = (function () {
		const digits = new Uint8Array(36);
		for (let i = 0; i < 10; i++) digits[i] = 48 + i;      // '0' … '9'
		for (let i = 10; i < 36; i++) digits[i] = 55 + i;     // 'A' … 'Z'
		return digits;
	})();

	// The reusable buffer §4.11 asks for: written by the writers below, turned
	// into text only when something changes (the 4 Hz readout, a hover) —
	// never concatenated in a frame.
	const DESIGNATION = new Uint8Array(DESIGNATION_CAPACITY);

	// "S" + the key's uppercase base36, shortest form: no zero padding, so a
	// landmark-sized key and a small one read the same way.
	function writeStarDesignation(key, out, off) {
		let k = key >>> 0;
		let digits = 1;
		for (let t = k; t >= 36; t = (t / 36) | 0) digits++;
		const end = off + 1 + digits;
		out[off] = 83;                                        // 'S'
		for (let i = end - 1; i > off; i--) {
			out[i] = BASE36[k % 36];
			k = (k / 36) | 0;
		}
		return end;
	}

	// " b", " c", … in `a` order — the IAU lowercase series, never 'a'. With
	// MAX_PLANETS = 12 the letter stops at 'm', so the two-letter continuation
	// is unreachable.
	function writePlanetLetter(index, out, off) {
		out[off] = 32;                                        // ' '
		out[off + 1] = 98 + (index & 0x7F);                   // 'b' + index
		return off + 2;
	}

	// "belt 1" / "belt 2" in radius order — the slot, not the kind: a system
	// whose only belt is the Kuiper analog still has a belt 1, because the
	// record's slots are already radius-ordered (§4.7).
	function writeBeltName(slot, out, off) {
		out[off] = 98; out[off + 1] = 101; out[off + 2] = 108; out[off + 3] = 116;
		out[off + 4] = 32;
		out[off + 5] = 49 + (slot & 0x07);                    // '1' + slot
		return off + 6;
	}

	// The one place a designation becomes a string (plan §4.11): the 4 Hz
	// readout and the hover change, never a per-frame draw.
	function designationToString(out, end) {
		let text = '';
		for (let i = 0; i < end; i++) text += String.fromCharCode(out[i]);
		return text;
	}

	// The §4.10/§2.6 star record, architecture and thermal records are reused
	// across calls (module scope, like `ARCH_CDF`): every entry point is
	// synchronous and writes its caller's `out`, so there is nothing to nest.
	const STAR_SCRATCH = createStellarInputs();
	const ARCH_SCRATCH = createArchitecture();
	const THERMAL_SCRATCH = createThermal();
	const BELT_SCRATCH = createBelts();

	const PlanetsLib = {
		AU_M, M_SUN_KG, G_SI, M_EARTH_KG, R_EARTH_M, R_SUN_M, TEFF_SUN, RHO_EARTH,
		NAME_CAPACITY, DESIGNATION_CAPACITY, HOURS_PER_YEAR,
		FLAG_LOCKED, FLAG_HOT_JUPITER, FLAG_TERRAN, FLAG_IN_HZ,
		MAX_PLANETS, MAX_BELTS, STIPPLE_N, A_SNOW_K, HZ_S_IN, HZ_S_OUT, K_HILL,
		STAR_CLEARANCE, DISK_OUT_AU, A_LOCK, S_EXTREME, S_LOCK, S_HOT_JUPITER,
		RUNAWAY_DT, RUNAWAY_ALBEDO, TERRAN_DT_BASE, TERRAN_DT_SPAN, TERRAN_DT_MAX,
		AIRLESS_M, ATM_RETAIN_M, TERRAN_M_MIN, TERRAN_M_MAX, TERRAN_AGE_MIN, DEORBIT_DV,
		BELT_P_MAX, BELT_SCOUR, BELT_FADE_FLOOR, BELT_FADE_TAU, BELT_WD_PRESENCE,
		BELT_BODY_R_M, BELT_BODY_MASS_KG, BELT_BODY_RHO, BELT_BODY_ALBEDO,
		BELT_BODY_MU,
		BLOCK_FIELD, BLOCK_LANDMARK, BLOCK_OBJECT, BLOCK_LOCAL, BLOCK_CATALOG, BLOCK_NAMES,
		DOMAIN_PLANETS, DOMAIN_LANDMARK, DOMAIN_CATALOG,
		CH_ESCALE, CH_COUNT_BASE, CH_SLOT_BASE, CH_BULK, CH_AXIS, CH_MASS, CH_ECC,
		CH_INC, CH_PERI, CH_PHASE, CH_ROT, CH_BELT_INNER, CH_BELT_OUTER, CH_STIPPLE_BASE,
		DISPLAY_TYPES, DISPLAY_INDEX, ATMOSPHERES, BULKS, BULK_INDEX, CLASS_MU,
		CLASS_BULK_WEIGHTS, CLASS_BULK_CDF,
		CLASS_MASS_BRACKETS, CLASS_TEFF_BANDS,
		systemSeed, landmarkKey, catalogKey,
		massFromLuminosity, massFromClassAndMag, luminosityFromMag, stellarRadius,
		teffForClass, stateForClass, createStellarInputs, stellarInputs,
		fZFactor, muForClass, bulkWeightsFor, bulkCdfFor, planetCount, expectedPlanetCount,
		AU_PER_R_SUN, M_EARTH_SUN,
		innerEdgeAU, outerEdgeAU, hillRatio, hillPushFactor, drawBulkIndex, massForBulk,
		radiusFor, planetDensity,
		createArchitecture, architecture,
		BAND_REFINEMENT_SIZE, PLANET_BAND_DISPLAY, PLANET_DISPLAY_THERMAL_INDEX,
		insolation, hzInnerAU, hzOuterAU, equilibriumTemp, planetBand, massTier,
		planetDisplay, runawayGreenhouse, albedoFor, surfaceTemp, isTidallyLocked,
		isHotJupiter, hzFlags, createThermal, thermal,
		BELT_INNER, BELT_OUTER, BELT_KINDS, BELT_CH_PRESENCE, BELT_CH_AXIS,
		BELT_CH_WIDTH, BELT_CH_MASS, BELT_CH_STIPPLE,
		snowLineAU, debrisFade, beltPresence, giantsInsideBelt, createBelts,
		beltStippleSeed, fillStipple, belts,
		moonCount,
		createSystemRecord, createSystemSummary, identityKey, generateSystem, systemSummary,
		BASE36, DESIGNATION, writeStarDesignation, writePlanetLetter, writeBeltName,
		designationToString,
	};
	if (typeof module !== 'undefined') module.exports = PlanetsLib;
	if (typeof window !== 'undefined') window.PlanetsLib = PlanetsLib;
})();
