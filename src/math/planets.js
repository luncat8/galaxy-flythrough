// src/math/planets.js
// The lazy planet-system generator (0.5 plan §1.2, §2–§4): any drawn star can
// be described as a planetary system, derived on demand from its u32 identity
// key and never resident. Nothing here touches the GPU or the star buffer — the
// system view, the search stage-2 filter and the delta-v map all read the
// SystemRecord this file fills in.
//
// Three rules the module lives by:
//   - one pure function of (key, model). No PRNG state, no clock, no cache that
//     can change an answer: the same key yields the same system on every
//     machine, every run (AGENTS.md, "stable hash, no PRNG state").
//   - no allocation in generateSystem / systemSummary. The records are
//     struct-of-arrays and preallocated, the scratch is module scope, and every
//     function takes its output buffer. planet-gen-test.js pins that.
//   - every constant that appears in the model is written down in §4.1 of the
//     plan, so a tolerance failure is a model bug, not a magic number.
//
// The stellar inputs come from the record blocks themselves: the three
// procedural blocks re-run the very derivation the renderer used (§2.4), the
// landmark and catalog blocks invert what the StarPacked word kept (§2.5). A
// star's key already encodes its provenance, so one ref object is enough.

'use strict';

(function () {
	// ---- physical constants (§4.1) -----------------------------------------
	const AU_M = 1.495978707e11;          // IAU 2012
	const M_SUN_KG = 1.98892e30;          // IAU nominal solar mass
	const G_SI = 6.674e-11;
	const M_EARTH_KG = 5.9722e24;         // IAU nominal Earth mass
	const M_EARTH_SUN = M_EARTH_KG / M_SUN_KG;   // 3.0033e-6 M☉
	const R_EARTH_M = 6.371e6;            // IAU nominal Earth radius
	const R_SUN_M = 6.957e8;              // IAU nominal solar radius
	const R_SUN_AU = R_SUN_M / AU_M;      // 0.0046504
	const RHO_EARTH = M_EARTH_KG / ((4 / 3) * Math.PI * R_EARTH_M * R_EARTH_M * R_EARTH_M);
	const TEFF_SUN = 5772;                // IAU nominal solar effective temperature
	const HOURS_PER_YEAR = 8766;          // 365.25 d
	const TAU = Math.PI * 2;

	// ---- model constants (§4.1) -------------------------------------------
	const MAX_PLANETS = 12;
	const MAX_BELTS = 2;
	const STIPPLE_N = 384;
	const A_SNOW_K = 2.7;
	const HZ_S_IN = 1.05;                 // Kopparapu maximum greenhouse insolation
	const HZ_S_OUT = 0.35;                // Kopparapu early-Mars insolation
	const K_HILL = 6;                     // Chambers (2001) six mutual Hill radii
	const STAR_CLEARANCE = 6;             // von Bezold, timeless result
	const DISK_OUT_AU = 40;               // sqrt(M★/M☉) — the disc surface
	const A_LOCK = 0.30;                  // AU: a/LockRadius(M) < 1 => tidally locked
	const RUNAWAY_DT = 500;
	const RUNAWAY_ALBEDO = 0.70;
	const TERRAN_DT_BASE = 33;
	const TERRAN_DT_SPAN = 55;
	const TERRAN_DT_MAX = 65;
	const AIRLESS_M = 0.02;
	const ATM_RETAIN_M = 0.3;
	const A0_MIN_AU = 0.012;              // ~6.2 R☉, the innermost orbit there is
	const GIANT_A0_FACTOR = 1.5;          // a giant has already engulfed its inner system
	const WD_DISK_OUT_AU = 1;             // polluted-WD debris sits inside 1 AU
	const WD_BELT_PRESENCE = 0.80;
	const BELT_TYPICAL_R_M = 470000;      // 470 km body
	const BELT_TYPICAL_MASS_KG = 9.4e20;
	const BELT_TYPICAL_MU = G_SI * BELT_TYPICAL_MASS_KG;
	const BELT_ALBEDO = 0.09;             // ~P-type, Southwest Research Institute
	const BELT_DENSITY = 2160;
	const BELT_FADE_TAU = 1.5;            // Gyr: belts fade roughly like an exponential

	// ---- hashes (§2.3) ----------------------------------------------------
	const DOMAIN_PLANETS = 0x51a7e75;     // domain separation vs. landmarks and catalog
	const DOMAIN_AGE = 0x6a3f19c5;         // the derived path's population-age draw

	// Record blocks, in buffer order (renderer.starBlocks().blocks[]).
	const BLOCK_PROCEDURAL = 0, BLOCK_LANDMARK = 1, BLOCK_OBJECTS = 2, BLOCK_LOCAL = 3, BLOCK_CATALOG = 4;

	// Channel map. One draw per channel of the system seed, so two features
	// cannot silently share a draw.
	const CH_ESCALE = 0;                  // 0        the system's eccentricity scale
	const CH_COUNT = 2;                   // 2+n      the planet-count chain
	const CH_PLANET = 32;                 // 32+8·p   planet p: bulk class
	//   33+8·p semi-major axis, 34+8·p mass, 35+8·p eccentricity,
	//   36+8·p inclination, 37+8·p argument of periapsis, 38+8·p mean phase,
	//   39+8·p rotation period. The 8-wide slot ends at 39+8·p, so twelve
	//   planets fill 32 … 127 and leave 128 … 199 free.
	const CH_MOON = 128;                  // 128 + p     planet p: moon count
	const CH_BELT_IN = 200;               // 200 presence, 201-204 a, width, mass, stipple
	const CH_BELT_OUT = 210;              // 210 presence, 211-214 a, width, mass, stipple
	const CH_STIPPLE = 300;               // 300+s, s = 0…2·STIPPLE_N−1, on the belt's own seed

	// Insolation bands (§4.6), outermost first so the test can read them in order.
	const BAND_HOT = 0;                   // S > 8
	const BAND_INNER = 1;                 // HZ_S_IN < S <= 8
	const BAND_HZ = 2;                    // HZ_S_OUT <= S <= HZ_S_IN
	const BAND_COLD = 3;                  // S < HZ_S_OUT

	// Stellar states. The record carries the code, the readout reads STATE_NAMES.
	const STATE_MS = 0, STATE_GIANT = 1, STATE_WD = 2;
	const STATE_NAMES = ['ms', 'giant', 'wd'];

	// The atmosphere column of the display table (§4.2): the delta-v module not
	// read elsewhere needs it, so it lives here rather than in a second list.
	const ATM_NONE = 0, ATM_THIN = 1, ATM_BREATHABLE = 2, ATM_THICK = 3, ATM_HHE = 4;
	const ATM_NAMES = ['none', 'thin', 'breathable', 'thick', 'H/He'];

	const DISPLAY_LAVA = 0, DISPLAY_BARREN = 1, DISPLAY_DESERT = 2, DISPLAY_TERRAN = 3,
		DISPLAY_ICE = 4, DISPLAY_SUPER_EARTH = 5, DISPLAY_MINI_NEPTUNE = 6,
		DISPLAY_GAS_GIANT = 7, DISPLAY_ICE_GIANT = 8, DISPLAY_DWARF = 9;
	const DISPLAY_COUNT = 10;
	const DISPLAY_NAMES = ['LAVA', 'BARREN', 'DESERT', 'TERRAN', 'ICE', 'SUPER_EARTH',
		'MINI_NEPTUNE', 'GAS_GIANT', 'ICE_GIANT', 'DWARF'];
	// colour, albedo, atmosphere, greenhouse ΔT (§4.2), one row per display type.
	const DISPLAY_COLORS = [
		[255, 90, 42], [154, 143, 130], [217, 164, 91], [79, 157, 224],
		[207, 232, 245], [164, 209, 106], [127, 212, 208],
		[224, 176, 112], [111, 159, 224], [122, 122, 122],
	];
	const DISPLAY_ALBEDO = [0.10, 0.12, 0.28, 0.30, 0.65, 0.25, 0.45, 0.50, 0.55, 0.10];
	const DISPLAY_ATMOSPHERE = [ATM_NONE, ATM_NONE, ATM_THIN, ATM_BREATHABLE, ATM_THIN,
		ATM_THICK, ATM_HHE, ATM_HHE, ATM_HHE, ATM_NONE];
	const DISPLAY_DT = [0, 0, 8, 33, 8, 40, 60, 30, 25, 0];

	// Planet bulk classes (§4.3), column order of the weight table below.
	const BULK_ROCK = 0, BULK_ICE = 1, BULK_SUPER = 2, BULK_MINI = 3,
		BULK_GAS = 4, BULK_ICEGIANT = 5, BULK_DWARF = 6;
	const BULK_COUNT = 7;
	const BULK_NAMES = ['rock', 'ice', 'super', 'mini', 'gas', 'icegiant', 'dwarf'];
	const BULK_MASS_MIN = new Float64Array([0.05, 0.05, 2, 5, 50, 10, 0.0005]);      // M⊕
	const BULK_MASS_MAX = new Float64Array([2.0, 2.5, 10, 20, 3000, 60, 0.05]);      // M⊕
	const BULK_MREF = new Float64Array([1, 1, 5, 10, 318, 17, 0.01]);                // M⊕
	const BULK_RREF = new Float64Array([1.00, 1.10, 1.60, 2.80, 11.20, 4.00, 0.20]); // R⊕
	const BULK_P = new Float64Array([0.28, 0.28, 0.27, 0.50, 0.05, 0.35, 0.30]);
	const BULK_ROT_MIN = new Float64Array([8, 8, 8, 8, 8, 10, 4]);                   // hours
	const BULK_ROT_MAX = new Float64Array([60, 60, 40, 20, 18, 20, 30]);
	const BULK_ECC_MAX = new Float64Array([0.15, 0.12, 0.10, 0.12, 0.35, 0.25, 0.20]);
	const BULK_MOON_MAX = new Uint8Array([1, 1, 2, 8, 80, 30, 0]);
	const ECC_INC_DEG = 3;                   // eScale · 3° · u, the inclinations

	// Spectral classes, in StarRecord.SPECTRAL_CLASSES order: O B A F G K M WD RG RGe.
	const CLASS_COUNT = 10;
	const CLASS_O = 0, CLASS_B = 1, CLASS_A = 2, CLASS_F = 3, CLASS_G = 4,
		CLASS_K = 5, CLASS_M = 6, CLASS_WD = 7, CLASS_RG = 8, CLASS_RGE = 9;
	// Mean planet count per star by class (§4.4).
	const CLASS_MU = new Float64Array([0.02, 0.10, 0.35, 0.90, 1.20, 1.30, 1.60, 0.15, 0.40, 0.30]);
	// Mass brackets for the derived path (§2.5): M☉, Delfosse skeleton.
	const CLASS_MASS_MIN = new Float64Array([16, 2.5, 1.6, 1.05, 0.85, 0.55, 0.08, 0.5, 0.8, 0.8]);
	const CLASS_MASS_MAX = new Float64Array([100, 16, 2.5, 1.6, 1.05, 0.85, 0.55, 1.4, 3.0, 3.0]);

	// Row-normalised bulk weights per spectral class (§4.3): rock ice super
	// mini gas icegiant dwarf. Normalised once at load, so the per-system work
	// is applying the modifiers and accumulating a CDF in the scratch.
	const BULK_WEIGHTS = [
		[0.00, 0.00, 0.00, 0.00, 0.55, 0.25, 0.20],  // O
		[0.00, 0.00, 0.05, 0.10, 0.50, 0.25, 0.10],  // B
		[0.08, 0.10, 0.15, 0.20, 0.27, 0.12, 0.08],  // A
		[0.22, 0.12, 0.20, 0.15, 0.13, 0.08, 0.10],  // F
		[0.26, 0.12, 0.20, 0.14, 0.10, 0.07, 0.11],  // G
		[0.28, 0.12, 0.22, 0.12, 0.08, 0.06, 0.12],  // K
		[0.36, 0.10, 0.28, 0.10, 0.01, 0.02, 0.13],  // M
		[0.30, 0.15, 0.10, 0.03, 0.02, 0.03, 0.37],  // WD
		[0.10, 0.18, 0.15, 0.15, 0.22, 0.12, 0.08],  // RG
		[0.14, 0.24, 0.15, 0.12, 0.17, 0.10, 0.08],  // RGe
	];
	const BULK_W = new Float64Array(CLASS_COUNT * BULK_COUNT);
	for (let c = 0; c < CLASS_COUNT; c++) {
		const row = BULK_WEIGHTS[c];
		let sum = 0;
		for (let b = 0; b < BULK_COUNT; b++) sum += row[b];
		const inv = 1 / sum;
		for (let b = 0; b < BULK_COUNT; b++) BULK_W[c * BULK_COUNT + b] = row[b] * inv;
	}

	// Record flags (§4.9).
	const FLAG_LOCKED = 1, FLAG_HOT_JUPITER = 2, FLAG_TERRAN = 4,
		FLAG_IN_HZ = 8, FLAG_RUNAWAY = 16, FLAG_LOCKED_HZ = 32;

	// Designations (§4.11): IAU planet letters and the byte buffer the star's
	// own S<base36> name is written into.
	const PLANET_LETTERS = 'bcdefghijklm';
	const NAME_MAX = 32;
	const BASE36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

	// ---- scratch, allocated once ------------------------------------------
	const cdfScratch = new Float64Array(BULK_COUNT);
	const axisScratch = new Float64Array(MAX_PLANETS);
	const rHillScratch = new Float64Array(MAX_PLANETS);
	const bulkScratch = new Uint8Array(MAX_PLANETS);
	const massScratch = new Float64Array(MAX_PLANETS);
	const scratchPlanets = createPlanetBlock();
	const scratchBelts = createBeltBlock();
	let placementModel = null, placementAge = -1, placementCount = -1, placementMaxMembers = -1;
	let placement = null;
	let quotaScratch = new Uint16Array(0);
	const derivationScratch = createStellarInputs();
	const bodyScratch = createBodyInfo();
	const digitScratch = new Uint8Array(8);

	// ---- lazy dependencies -------------------------------------------------
	// planets.js loads before objects.js in the page, and the generator only
	// runs long after every script has been evaluated, so the dependencies are
	// resolved on first use. In Node the same lookup is a require, so the module
	// and the page read one and the same list. Resolved once and kept: a require
	// per call is not free, and the search stage runs the generator over
	// hundreds of thousands of stars (measured: require-on-every-lookup cost
	// 6 µs per system, which is the whole 20 µs budget).
	function mod(windowName, requirePath) {
		if (typeof module !== 'undefined' && module.exports) return require(requirePath);
		return window[windowName];
	}
	let hashDep = null, densityDep = null, starTypesDep = null, recordDep = null, objectsDep = null;
	function hashLib() { return hashDep || (hashDep = mod('HashLib', './hash.js')); }
	function densityLib() { return densityDep || (densityDep = mod('DensityLib', './density.js')); }
	function starTypesLib() { return starTypesDep || (starTypesDep = mod('StarTypesLib', './star-types.js')); }
	function recordLib() { return recordDep || (recordDep = mod('StarRecord', './star-record.js')); }
	function objectsLib() { return objectsDep || (objectsDep = mod('ObjectsLib', './objects.js')); }

	// ---- small shared helpers ---------------------------------------------
	function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
	function stellarRadius(lum, teff) {
		const k = TEFF_SUN / (teff > 1 ? teff : 1);
		return Math.sqrt(lum > 1e-9 ? lum : 1e-9) * k * k;
	}
	function luminosityFromAbsMag(absMag) {
		return Math.pow(10, (4.83 - absMag) / 2.5);
	}

	// The giant scaling of §4.3, from the star's metallicity.
	function giantWeightScale(metal) {
		const z = metal > 0 ? metal : 0.02;
		const f = (z / 0.020) * (z / 0.020);
		return f < 0.05 ? 0.05 : (f > 4 ? 4 : f);
	}

	// Galactic zenith height in units of the local thin-disc scale height, the
	// same expression deriveStar uses.
	function zOverH(ref, R) {
		const density = densityLib();
		const model = ref.model;
		if (ref.z === undefined || !model.thin || !(model.thin.H > 0)) return 0;
		const H = density.discHeightAt(model.thin, R);
		return H > 0 ? (ref.z - model.centre.z) / H : 0;
	}

	function stateFromClass(classIndex) {
		if (classIndex === CLASS_WD) return STATE_WD;
		if (classIndex === CLASS_RG || classIndex === CLASS_RGE) return STATE_GIANT;
		return STATE_MS;
	}

	// Exponent of the branch of luminosityFromMass that mass `m` sits in.
	function branchExponent(m) {
		if (m < 0.7) return 2.3;
		if (m < 2.0) return 4.0;
		if (m < 20) return 3.5;
		return 2.8;
	}

	// §2.5: invert what the record kept. L comes from M_V, then M comes from L
	// inside the class's mass bracket. The bracket picks the branch (the one its
	// lower bound sits in) and clamps; when the law cannot reach the inverted
	// luminosity at all — a late K star dimmer than its bracket allows — the
	// bracket's midpoint is the honest answer, not the clamp. Remnants skip the
	// law entirely: a white dwarf's or a giant's luminosity says nothing about
	// its mass.
	function massFromClassAndMag(classIndex, absMag) {
		const lo = CLASS_MASS_MIN[classIndex], hi = CLASS_MASS_MAX[classIndex];
		if (classIndex === CLASS_WD || classIndex === CLASS_RG || classIndex === CLASS_RGE) {
			return 0.5 * (lo + hi);
		}
		const m = Math.pow(luminosityFromAbsMag(absMag), 1 / branchExponent(lo));
		return (m >= lo && m <= hi) ? m : 0.5 * (lo + hi);
	}

	// ---- stellar inputs (§2.4, §2.5) --------------------------------------
	function createStellarInputs() {
		return {
			key: 0, block: 0, slot: -1,
			x: 0, y: 0, z: 0,
			mass: 1, luminosity: 1, teff: 5772, rStar: 1, age: 2, metallicity: 0.02,
			state: STATE_MS, spec: CLASS_G, spectralClass: 'G',
			colorIndex: 4, absMag: 4.83,
			component: 0, R: 0, distToArm: 0,
		};
	}

	// deriveStar / deriveStarWithAge write their fields as strings; the record
	// carries codes and the radius, so the two are translated here.
	function finishDerived(out) {
		out.state = out.state === 'wd' ? STATE_WD : (out.state === 'giant' ? STATE_GIANT : STATE_MS);
		out.spec = recordLib().spectralClassIndex(out.spectralClass);
		out.rStar = stellarRadius(out.luminosity, out.teff);
		return out;
	}

	// A star's snapshot inputs, per record block. `ref` is
	// { key, block, slot, x, y, z, model, field, colorIndex, absMag, name, objects }.
	function stellarInputs(ref, out) {
		out.key = ref.key >>> 0;
		out.block = ref.block | 0;
		out.slot = ref.slot | 0;
		out.x = ref.x;
		out.y = ref.y;
		out.z = ref.z;
		switch (out.block) {
			case BLOCK_PROCEDURAL: return fieldInputs(ref, out);
			case BLOCK_OBJECTS: return objectMemberInputs(ref, out);
			case BLOCK_LOCAL: return localInputs(ref, out);
			default: return recordInputs(ref, out);
		}
	}

	// The global procedural field: the key *is* fieldStarSeed(seed, i), so the
	// index falls out of the hash and the same deriveStar the renderer ran runs
	// again — bit exact, no scan.
	function fieldInputs(ref, out) {
		const model = ref.model;
		const i = ref.key - (model.seed * 31 + 1);
		const field = ref.field;
		if (field && i >= 0 && i < field.count) {
			starTypesLib().deriveStar(model, ref.key, field.component[i], field.R[i],
				field.distToArm[i], out, field.z[i]);
			return finishDerived(out);
		}
		return recordInputs(ref, out);
	}

	// The local gap-fill block: the key is the slot seed, so the same derive seed
	// the renderer used falls out of it. Component, radius and arm distance are
	// re-derived from the record's own position, as the renderer does.
	function localInputs(ref, out) {
		const hash = hashLib();
		const density = densityLib();
		const decomposed = density.rhoDecomposed(ref.model, ref.x, ref.y, ref.z);
		const component = density.sampleComponentIndex(decomposed, hash.hash01At(ref.key, 3));
		starTypesLib().deriveStar(ref.model, Math.imul(ref.key, 31) + 5, component,
			decomposed.R, decomposed.distToArm, out, ref.z);
		return finishDerived(out);
	}

	// A composite object's member: the key is objectMemberSeed(object seed, i),
	// so the placement resolves it and the member is derived again at the
	// object's own coeval age — exactly what the renderer wrote.
	function objectMemberInputs(ref, out) {
		const member = resolveObjectMember(ref);
		if (!member) return recordInputs(ref, out);
		const density = densityLib();
		const model = ref.model;
		const R = Math.hypot(ref.x - model.centre.x, ref.y - model.centre.y);
		const distToArm = density.distanceToNearestArm(model, R,
			Math.atan2(ref.y - model.centre.y, ref.x - model.centre.x));
		starTypesLib().deriveStarWithAge(model, ref.key, objectsLib().objectMemberComponent(member),
			R, distToArm, member.ageGyr, out);
		return finishDerived(out);
	}

	// Re-run the object placement (deterministic, cached per model) and walk the
	// apportioned members until the seeds match. A placement that does not
	// reproduce the key returns null and the caller falls back to §2.5.
	function resolveObjectMember(ref) {
		const objects = objectsLib();
		const count = ref.objects && ref.objects.count > 0 ? ref.objects.count : objects.OBJECT_COUNT_DEFAULT;
		const maxMembers = ref.objects && ref.objects.maxMembers > 0
			? ref.objects.maxMembers : objects.OBJECT_MEMBERS_DEFAULT;
		const age = ref.model.populations ? ref.model.populations.age : 0;
		if (placementModel !== ref.model || placementAge !== age
			|| placementCount !== count || placementMaxMembers !== maxMembers) {
			placement = objects.placeObjects(ref.model, (ref.model.seed | 0) ^ 0x0b5e55, count, null);
			if (quotaScratch.length < placement.length) {
				let n = Math.max(16, quotaScratch.length);
				while (n < placement.length) n *= 2;
				quotaScratch = new Uint16Array(n);
			}
			objects.objectQuotas(placement, maxMembers, quotaScratch);
			placementModel = ref.model;
			placementAge = age;
			placementCount = count;
			placementMaxMembers = maxMembers;
		}
		let slot = 0;
		for (let j = 0; j < placement.length; j++) {
			const quota = quotaScratch[j];
			if (quota <= 0) continue;
			const oSeed = placement[j].seed | 0;
			for (let i = 0; i < quota; i++) {
				if (slot >= maxMembers) return null;
				if (objects.objectMemberSeed(oSeed, i) === ref.key) return placement[j];
				slot++;
			}
		}
		return null;
	}

	// The landmark and catalog blocks kept a class and a magnitude and nothing
	// else, so their masses come from inverting the record (§2.5) and their age
	// from the population at their own position.
	function recordInputs(ref, out) {
		const starTypes = starTypesLib();
		const density = densityLib();
		const hash = hashLib();
		const colorIndex = ref.colorIndex === undefined ? CLASS_G : (ref.colorIndex | 0);
		const absMag = ref.absMag === undefined ? 4.83 : ref.absMag;
		out.colorIndex = colorIndex;
		out.absMag = absMag;
		out.spec = colorIndex;
		out.state = stateFromClass(colorIndex);
		out.spectralClass = recordLib().SPECTRAL_CLASSES[colorIndex];
		out.luminosity = luminosityFromAbsMag(absMag);
		out.mass = massFromClassAndMag(colorIndex, absMag);
		out.teff = starTypes.teffFromMass(out.mass);
		out.rStar = stellarRadius(out.luminosity, out.teff);
		const decomposed = density.rhoDecomposed(ref.model, ref.x, ref.y, ref.z);
		const ageSeed = hash.hash4(ref.key, ref.model.seed | 0, DOMAIN_AGE, out.block);
		out.component = density.sampleComponentIndex(decomposed, hash.hash01At(ageSeed, 3));
		out.R = decomposed.R;
		out.distToArm = decomposed.distToArm;
		out.metallicity = starTypes.metallicityFor(out.component);
		out.age = starTypes.sampleLocalAge(ref.model, out.component, out.R, out.distToArm,
			hash.hash01At(ageSeed, 1), hash.hash01At(ageSeed, 2), zOverH(ref, out.R));
		return out;
	}

	// ---- the record (§4.9) -------------------------------------------------
	function createPlanetBlock() {
		return {
			a: new Float64Array(MAX_PLANETS),
			mass: new Float64Array(MAX_PLANETS),
			radius: new Float64Array(MAX_PLANETS),
			density: new Float64Array(MAX_PLANETS),
			ecc: new Float64Array(MAX_PLANETS),
			inc: new Float64Array(MAX_PLANETS),
			peri: new Float64Array(MAX_PLANETS),
			phase: new Float64Array(MAX_PLANETS),
			period: new Float64Array(MAX_PLANETS),
			teq: new Float64Array(MAX_PLANETS),
			tsurf: new Float64Array(MAX_PLANETS),
			insolation: new Float64Array(MAX_PLANETS),
			rHill: new Float64Array(MAX_PLANETS),
			rotHours: new Float64Array(MAX_PLANETS),
			bulk: new Uint8Array(MAX_PLANETS),
			display: new Uint8Array(MAX_PLANETS),
			moons: new Uint8Array(MAX_PLANETS),
			flags: new Uint8Array(MAX_PLANETS),
		};
	}

	function createBeltBlock() {
		return {
			a: new Float64Array(MAX_BELTS),
			dlnA: new Float64Array(MAX_BELTS),
			mass: new Float64Array(MAX_BELTS),
			mu: new Float64Array(MAX_BELTS),
			radius: new Float64Array(MAX_BELTS),
			stipple: new Uint32Array(MAX_BELTS),
		};
	}

	function createSummaryRecord() {
		return {
			full: false,
			star: {
				key: 0, block: 0, mass: 1, lum: 1, teff: 5772, rStar: 1, age: 2, metal: 0.02,
				state: STATE_MS, spec: CLASS_G, colorIndex: 4, absMag: 4.83,
				component: 0, R: 0, distToArm: 0,
				aHzIn: 0, aHzOut: 0, aSnow: 0, aOut: 0,
				name: new Uint8Array(NAME_MAX),
			},
			// The per-planet environment the search's range filters read
			// (§5.1: tsurf, teq, mass, a). The walk classifies every planet
			// before the orbit side is skipped, so these are the same values
			// the full record writes — recorded here in both tiers, never
			// re-derived, so a summary and a full walk cannot disagree.
			env: {
				a: new Float64Array(MAX_PLANETS),
				mass: new Float64Array(MAX_PLANETS),
				teq: new Float64Array(MAX_PLANETS),
				tsurf: new Float64Array(MAX_PLANETS),
				display: new Uint8Array(MAX_PLANETS),
			},
			envCount: 0,
			planetCount: 0,
			beltCount: 0,
			terranCount: 0,
			giantCount: 0,
			maxPlanetMass: 0,
			bulkHistogram: new Uint8Array(BULK_COUNT),
			typeHistogram: new Uint8Array(DISPLAY_COUNT),
			bestTerranA: 0,
			bestTerranMass: 0,
			bestTerranTsurf: 0,
			bestTerranDisplay: 0,
		};
	}

	function createSystemRecord() {
		const record = createSummaryRecord();
		record.full = true;
		record.planets = createPlanetBlock();
		record.belts = createBeltBlock();
		return record;
	}

	let sharedSystemRecord = null;
	let sharedSummaryRecord = null;
	function sharedSystem() {
		return sharedSystemRecord || (sharedSystemRecord = createSystemRecord());
	}
	function sharedSummary() {
		return sharedSummaryRecord || (sharedSummaryRecord = createSummaryRecord());
	}

	// ---- per-body refinement (§4.6) ---------------------------------------
	function createBodyInfo() {
		return {
			insolation: 0, band: BAND_HZ, display: DISPLAY_BARREN, albedo: 0,
			teq: 0, dT: 0, tsurf: 0,
			locked: 0, hotJupiter: 0, inHZ: 0, runaway: 0,
		};
	}

	// One body's environment, independent of the hash draws: the star, the
	// semi-major axis, the mass and the bulk class are enough. The system view,
	// the search filter and the test all call this directly.
	function classifyBody(star, aAu, massEarth, bulk, out) {
		const lum = star.luminosity > 1e-9 ? star.luminosity : 1e-9;
		const mass = star.mass > 1e-4 ? star.mass : 1e-4;
		const S = lum / (aAu * aAu);
		out.insolation = S;
		out.band = S > 8 ? BAND_HOT : (S > HZ_S_IN ? BAND_INNER : (S >= HZ_S_OUT ? BAND_HZ : BAND_COLD));
		out.inHZ = out.band === BAND_HZ ? 1 : 0;
		out.locked = (aAu < A_LOCK * Math.sqrt(mass) || S > 50) ? 1 : 0;
		out.hotJupiter = ((bulk === BULK_GAS || bulk === BULK_MINI) && S > 20) ? 1 : 0;
		const rocky = bulk === BULK_ROCK || bulk === BULK_ICE || bulk === BULK_SUPER;
		out.runaway = (out.band === BAND_INNER && rocky && massEarth >= ATM_RETAIN_M) ? 1 : 0;
		out.display = displayType(bulk, out.band, massEarth);
		out.albedo = out.runaway ? RUNAWAY_ALBEDO : DISPLAY_ALBEDO[out.display];
		const rM = (star.rStar > 1e-4 ? star.rStar : 1e-4) * R_SUN_M;
		out.teq = star.teff * Math.sqrt(rM / (2 * aAu * AU_M)) * Math.pow(1 - out.albedo, 0.25);
		out.dT = greenhouseTerm(out.display, S, out.runaway);
		out.tsurf = out.teq + out.dT;
		return out;
	}

	function displayType(bulk, band, massEarth) {
		if (bulk === BULK_MINI) return DISPLAY_MINI_NEPTUNE;
		if (bulk === BULK_GAS) return DISPLAY_GAS_GIANT;
		if (bulk === BULK_ICEGIANT) return DISPLAY_ICE_GIANT;
		if (bulk === BULK_DWARF) return band === BAND_HOT ? DISPLAY_LAVA : DISPLAY_DWARF;
		if (band === BAND_HOT) return DISPLAY_LAVA;
		if (band === BAND_COLD) return DISPLAY_ICE;
		if (massEarth < AIRLESS_M) return DISPLAY_BARREN;
		if (massEarth < ATM_RETAIN_M) return band === BAND_INNER ? DISPLAY_BARREN : DISPLAY_DESERT;
		if (band === BAND_INNER) return DISPLAY_DESERT;
		return bulk === BULK_SUPER ? DISPLAY_SUPER_EARTH : DISPLAY_TERRAN;
	}

	function greenhouseTerm(display, S, runaway) {
		if (runaway) return RUNAWAY_DT;
		if (display === DISPLAY_TERRAN || display === DISPLAY_SUPER_EARTH) {
			const t = TERRAN_DT_BASE + TERRAN_DT_SPAN * clamp01(1 - S);
			return t > TERRAN_DT_MAX ? TERRAN_DT_MAX : t;
		}
		return DISPLAY_DT[display];
	}

	// ---- belts (§4.7) -----------------------------------------------------
	function beltPresence(ageGyr, giantsInside) {
		const fade = 0.25 + 0.75 * Math.exp(-ageGyr / BELT_FADE_TAU);
		const p = 0.90 * fade - 0.35 * giantsInside;
		return p < 0 ? 0 : (p > 1 ? 1 : p);
	}

	// The scouring of §4.7: every gas or ice giant inside the belt radius.
	function giantsInside(axis, bulk, count, limit) {
		let n = 0;
		for (let p = 0; p < count; p++) {
			if ((bulk[p] === BULK_GAS || bulk[p] === BULK_ICEGIANT) && axis[p] < limit) n++;
		}
		return n;
	}

	// ---- generation (§4.4, §4.5, §4.9) -------------------------------------
	// Bulk CDF for one star: the class row, the metallicity scaling of the giant
	// columns, the state modifiers, re-normalised in the scratch.
	function buildBulkCdf(star, cdf) {
		const row = star.spec * BULK_COUNT;
		const fZ = giantWeightScale(star.metallicity);
		const giant = star.state === STATE_GIANT;
		const wd = star.state === STATE_WD;
		let acc = 0;
		for (let b = 0; b < BULK_COUNT; b++) {
			let w = BULK_W[row + b];
			if (b === BULK_MINI || b === BULK_GAS || b === BULK_ICEGIANT) w *= fZ;
			if (giant && (b === BULK_ROCK || b === BULK_ICE || b === BULK_SUPER)) w *= 0.25;
			if (wd && b !== BULK_ROCK && b !== BULK_DWARF) w = 0;
			acc += w;
			cdf[b] = acc;
		}
		return acc;
	}

	// The count chain: a planet is added while a draw stays below μ/(μ+n+1).
	// That is exactly the truncated geometric whose mean and zeros §4.4 pins.
	function planetCount(seed, mu, hash01At) {
		let n = 0;
		while (n < MAX_PLANETS && hash01At(seed, CH_COUNT + n) < mu / (mu + n + 1)) n++;
		return n;
	}

	function drawMass(bulk, u) {
		return BULK_MASS_MIN[bulk] * Math.pow(BULK_MASS_MAX[bulk] / BULK_MASS_MIN[bulk], u);
	}

	// Mutual Hill radius of two neighbours, in AU (§4.5).
	function hillRadius(m1, m2, starMass, a1, a2) {
		const sum = (m1 + m2) * M_EARTH_SUN;
		return Math.cbrt(sum / (3 * starMass)) * 0.5 * (a1 + a2);
	}

	// One walk fills both record tiers: the orbit arrays are written into the
	// system record when it has them and into the module scratch when it does
	// not, so the summary is literally the same walk and the two cannot drift.
	function walk(ref, star, seed, out) {
		const hash = hashLib();
		const hash01At = hash.hash01At;
		const pcgHash = hash.pcgHash;
		// A record is reused across calls, so the histograms start empty: what a
		// caller reads is this system, not the sum of the two. The env block is
		// bounded by envCount instead of reset — a reader never passes it.
		out.bulkHistogram.fill(0);
		out.typeHistogram.fill(0);
		out.bestTerranA = 0;
		out.bestTerranMass = 0;
		out.bestTerranTsurf = 0;
		out.bestTerranDisplay = 0;

		// --- the star block
		const s = out.star;
		s.key = ref.key >>> 0;
		s.block = ref.block | 0;
		s.mass = star.mass;
		s.lum = star.luminosity;
		s.teff = star.teff;
		s.rStar = star.rStar;
		s.age = star.age;
		s.metal = star.metallicity;
		s.state = star.state;
		s.spec = star.spec;
		s.colorIndex = star.colorIndex;
		s.absMag = star.absMag;
		s.component = star.component;
		s.R = star.R;
		s.distToArm = star.distToArm;
		if (ref.name !== undefined) writeName(s.name, ref.name);
		else writeKeyDesignation(s.name, ref.key);

		const lum = star.luminosity > 1e-9 ? star.luminosity : 1e-9;
		const mass = star.mass > 1e-4 ? star.mass : 1e-4;
		s.aSnow = A_SNOW_K * Math.sqrt(lum);
		s.aHzIn = Math.sqrt(lum / HZ_S_IN);
		s.aHzOut = Math.sqrt(lum / HZ_S_OUT);
		const rStarAu = star.rStar * R_SUN_AU;
		let a0 = Math.max(A0_MIN_AU, STAR_CLEARANCE * rStarAu);
		if (star.state === STATE_GIANT) a0 = Math.max(a0, GIANT_A0_FACTOR * rStarAu);
		let aOut = DISK_OUT_AU * Math.sqrt(mass);
		if (star.state === STATE_WD) aOut = aOut < WD_DISK_OUT_AU ? aOut : WD_DISK_OUT_AU;
		s.aOut = aOut;

		// --- occurrence
		let n = planetCount(seed, CLASS_MU[star.spec], hash01At);

		// --- axes: log-uniform, then insertion-sorted ascending (n <= 12)
		const axis = axisScratch;
		const lnA0 = Math.log(a0);
		const lnSpan = Math.log(aOut) - lnA0;
		for (let p = 0; p < n; p++) {
			axis[p] = Math.exp(lnA0 + lnSpan * hash01At(seed, CH_PLANET + 8 * p + 1));
		}
		for (let i = 1; i < n; i++) {
			const a = axis[i];
			let j = i - 1;
			while (j >= 0 && axis[j] > a) { axis[j + 1] = axis[j]; j--; }
			axis[j + 1] = a;
		}

		// --- bulks and masses, keyed by the planet's index in the record
		const bulk = bulkScratch, masses = massScratch;
		const total = buildBulkCdf(star, cdfScratch);
		for (let p = 0; p < n; p++) {
			const c = CH_PLANET + 8 * p;
			const uB = hash01At(seed, c) * total;
			let b = 0;
			while (b + 1 < BULK_COUNT && uB >= cdfScratch[b]) b++;
			bulk[p] = b;
			masses[p] = drawMass(b, hash01At(seed, c + 2));
		}

		// --- the Hill repair: push a neighbour out, drop what no longer fits.
		// The mutual Hill radius the repair uses is recorded with the pair, so
		// the separation invariant holds exactly rather than to within a push.
		const rHillRec = rHillScratch;
		for (let p = 0; p + 1 < n; p++) {
			const rh = hillRadius(masses[p], masses[p + 1], mass, axis[p], axis[p + 1]);
			rHillRec[p] = rh;
			const need = axis[p] + K_HILL * rh;
			if (axis[p + 1] < need) axis[p + 1] = need;
			if (axis[p + 1] > aOut) { n = p + 1; break; }
		}

		// --- orbits, refinement and the record. A summary walks the same path
		// with the per-planet orbit draws and arrays skipped: they feed nothing
		// the counts read, and the search's first pass runs over every star.
		const planets = out.planets || scratchPlanets;
		const belts = out.belts || scratchBelts;
		const full = out.full === true;
		const eScale = full ? 0.2 + 1.6 * hash01At(seed, CH_ESCALE) : 0;
		const info = bodyScratch;
		let terranCount = 0, giantTotal = 0, maxPlanetMass = 0;
		let bestA = 0, bestMass = 0, bestTsurf = 0, bestDisplay = 0, haveBest = false;
		for (let p = 0; p < n; p++) {
			const c = CH_PLANET + 8 * p;
			const b = bulk[p];
			const a = axis[p], m = masses[p];
			classifyBody(star, a, m, b, info);
			let flags = 0;
			if (info.locked) flags |= FLAG_LOCKED;
			if (info.inHZ) {
				flags |= FLAG_IN_HZ;
				if (info.locked) flags |= FLAG_LOCKED_HZ;
			}
			if (info.hotJupiter) flags |= FLAG_HOT_JUPITER;
			if (info.runaway) flags |= FLAG_RUNAWAY;
			const terran = info.inHZ && !info.locked && !info.runaway
				&& (info.display === DISPLAY_TERRAN || info.display === DISPLAY_SUPER_EARTH)
				&& m >= 0.5 && m <= 5 && star.age > 0.5;
			if (terran) {
				flags |= FLAG_TERRAN;
				terranCount++;
				if (!haveBest) {
					haveBest = true;
					bestA = a; bestMass = m; bestTsurf = info.tsurf; bestDisplay = info.display;
				}
			}
			if (b === BULK_GAS || b === BULK_ICEGIANT) giantTotal++;
			if (m > maxPlanetMass) maxPlanetMass = m;
			out.bulkHistogram[b]++;
			out.typeHistogram[info.display]++;
			const env = out.env;
			env.a[p] = a;
			env.mass[p] = m;
			env.teq[p] = info.teq;
			env.tsurf[p] = info.tsurf;
			env.display[p] = info.display;
			if (!full) continue;

			const radius = BULK_RREF[b] * Math.pow(m / BULK_MREF[b], BULK_P[b]);
			planets.a[p] = a;
			planets.mass[p] = m;
			planets.radius[p] = radius;
			planets.density[p] = m * M_EARTH_KG / ((4 / 3) * Math.PI * Math.pow(radius * R_EARTH_M, 3));
			const ue = hash01At(seed, c + 3);
			planets.ecc[p] = eScale * BULK_ECC_MAX[b] * ue * ue;
			planets.inc[p] = eScale * ECC_INC_DEG * hash01At(seed, c + 4);
			planets.peri[p] = TAU * hash01At(seed, c + 5);
			planets.phase[p] = TAU * hash01At(seed, c + 6);
			planets.period[p] = Math.sqrt(a * a * a / mass);
			planets.teq[p] = info.teq;
			planets.tsurf[p] = info.tsurf;
			planets.insolation[p] = info.insolation;
			planets.rotHours[p] = BULK_ROT_MIN[b]
				+ (BULK_ROT_MAX[b] - BULK_ROT_MIN[b]) * hash01At(seed, c + 7);
			if (info.locked) planets.rotHours[p] = planets.period[p] * HOURS_PER_YEAR;
			planets.bulk[p] = b;
			planets.display[p] = info.display;
			planets.moons[p] = Math.floor(BULK_MOON_MAX[b]
				* Math.pow(hash01At(seed, CH_MOON + p), 3));
			planets.flags[p] = flags;
			planets.rHill[p] = p + 1 < n ? rHillScratch[p] : 0;
		}

		// --- belts: presence, then the geometry, mass and stipple seed. The
		// presence draw and the width/mass draws decide the count, so a summary
		// walks them too; only the stipple seed is orbit-side detail.
		let beltCount = 0;
		for (let belt = 0; belt < MAX_BELTS; belt++) {
			const inner = belt === 0;
			const ch = inner ? CH_BELT_IN : CH_BELT_OUT;
			const uA = hash01At(seed, ch + 1);
			const aB = inner ? s.aSnow * (0.55 + 0.40 * uA) : aOut * (0.35 + 0.45 * uA);
			const presence = (inner && star.state === STATE_WD) ? WD_BELT_PRESENCE
				: beltPresence(star.age, giantsInside(axis, bulk, n, aB));
			if (hash01At(seed, ch) >= presence) continue;
			beltCount++;
			if (!full) continue;
			const uWidth = hash01At(seed, ch + 2);
			const uMass = hash01At(seed, ch + 3);
			belts.a[belt] = aB;
			belts.dlnA[belt] = inner ? 0.10 + 0.25 * uWidth : 0.15 + 0.35 * uWidth;
			belts.mass[belt] = Math.pow(10, inner ? -4 + 2.5 * uMass : -2 + 2.0 * uMass);
			belts.mu[belt] = BELT_TYPICAL_MU;
			belts.radius[belt] = BELT_TYPICAL_R_M;
			// The stipple seed is the raw word of the channel hash01At normalises,
			// so the dots run on a seed of their own and never share a draw.
			belts.stipple[belt] = pcgHash(Math.imul(seed | 0, 0x9e3779b1) + (ch + 4)) >>> 0;
		}

		out.planetCount = n;
		out.envCount = n;
		out.beltCount = beltCount;
		out.terranCount = terranCount;
		out.giantCount = giantTotal;
		out.maxPlanetMass = maxPlanetMass;
		out.bestTerranA = bestA;
		out.bestTerranMass = bestMass;
		out.bestTerranTsurf = bestTsurf;
		out.bestTerranDisplay = bestDisplay;
		return out;
	}

	function systemSeedOf(ref) {
		return hashLib().hash4(ref.key, ref.model.seed | 0, DOMAIN_PLANETS, ref.block | 0) >>> 0;
	}

	// The whole system of one star. `snapshot` is a stellarInputs record; pass
	// null to have one filled into the module scratch (the readout wants the
	// star's mass and luminosity anyway, so it usually passes its own).
	function generateSystem(ref, snapshot, out) {
		const record = out || sharedSystem();
		const star = snapshot || stellarInputs(ref, derivationScratch);
		return walk(ref, star, systemSeedOf(ref), record);
	}

	// The same walk with only the counts kept: the search's first pass reads
	// terranCount, giantCount and the histograms, and never the orbits.
	function systemSummary(ref, snapshot, out) {
		const record = out || sharedSummary();
		const star = snapshot || stellarInputs(ref, derivationScratch);
		return walk(ref, star, systemSeedOf(ref), record);
	}

	// ---- designations (§4.11) ---------------------------------------------
	// §4.11's S<base36> designation, written straight into the byte buffer: the
	// same rule star-set.js's keyDesignation formats as a string. The search
	// generates hundreds of thousands of systems, and a string per system is a
	// megabyte of garbage; the two forms are pinned against the same values in
	// their own tests. A zero key has no designation, as in star-set.js.
	function writeKeyDesignation(buffer, key) {
		buffer.fill(0);
		let v = key >>> 0;
		if (v === 0) return 0;
		let d = 0;
		while (v > 0) {
			digitScratch[d++] = BASE36.charCodeAt(v % 36);
			v = Math.floor(v / 36);
		}
		buffer[0] = 83;   // 'S'
		for (let i = 0; i < d; i++) buffer[1 + i] = digitScratch[d - 1 - i];
		return 1 + d;
	}

	function writeName(buffer, text) {
		buffer.fill(0);
		const n = text.length < NAME_MAX ? text.length : NAME_MAX;
		for (let i = 0; i < n; i++) buffer[i] = text.charCodeAt(i) & 0x7f;
		return n;
	}

	// The star's own designation, decoded once into a string: readout-rate, not
	// frame-rate — the byte buffer stays the record's own.
	function starDesignation(system) {
		const name = system.star.name;
		let end = 0;
		while (end < name.length && name[end] !== 0) end++;
		let text = '';
		for (let i = 0; i < end; i++) text += String.fromCharCode(name[i]);
		return text;
	}

	// 0 = the star, 1 = planet p, 2 = belt b.
	function bodyDesignation(system, which, index) {
		const text = starDesignation(system);
		if (which === 1) return text + ' ' + PLANET_LETTERS[index];
		if (which === 2) return text + ' belt ' + (index + 1);
		return text;
	}

	// ---- the API ----------------------------------------------------------
	const PlanetsLib = {
		CLASS_O, CLASS_B, CLASS_A, CLASS_F, CLASS_G, CLASS_K, CLASS_M,
		CLASS_WD, CLASS_RG, CLASS_RGE, CLASS_COUNT, CLASS_MU, CLASS_MASS_MIN, CLASS_MASS_MAX,
		BLOCK_PROCEDURAL, BLOCK_LANDMARK, BLOCK_OBJECTS, BLOCK_LOCAL, BLOCK_CATALOG,
		CH_ESCALE, CH_COUNT, CH_PLANET, CH_MOON, CH_BELT_IN, CH_BELT_OUT, CH_STIPPLE,
		BAND_HOT, BAND_INNER, BAND_HZ, BAND_COLD,
		STATE_MS, STATE_GIANT, STATE_WD, STATE_NAMES,
		ATM_NONE, ATM_THIN, ATM_BREATHABLE, ATM_THICK, ATM_HHE, ATM_NAMES,
		DISPLAY_LAVA, DISPLAY_BARREN, DISPLAY_DESERT, DISPLAY_TERRAN, DISPLAY_ICE,
		DISPLAY_SUPER_EARTH, DISPLAY_MINI_NEPTUNE, DISPLAY_GAS_GIANT, DISPLAY_ICE_GIANT, DISPLAY_DWARF,
		DISPLAY_COUNT, DISPLAY_NAMES, DISPLAY_COLORS, DISPLAY_ALBEDO,
		DISPLAY_ATMOSPHERE, DISPLAY_DT,
		BULK_ROCK, BULK_ICE, BULK_SUPER, BULK_MINI, BULK_GAS, BULK_ICEGIANT, BULK_DWARF,
		BULK_COUNT, BULK_NAMES, BULK_MASS_MIN, BULK_MASS_MAX, BULK_MREF, BULK_RREF,
		BULK_P, BULK_ROT_MIN, BULK_ROT_MAX, BULK_ECC_MAX, BULK_MOON_MAX,
		FLAG_LOCKED, FLAG_HOT_JUPITER, FLAG_TERRAN, FLAG_IN_HZ, FLAG_RUNAWAY, FLAG_LOCKED_HZ,
		PLANET_LETTERS, NAME_MAX,
		MAX_PLANETS, MAX_BELTS, STIPPLE_N, A_SNOW_K, HZ_S_IN, HZ_S_OUT, K_HILL,
		STAR_CLEARANCE, DISK_OUT_AU, A_LOCK, RUNAWAY_DT, RUNAWAY_ALBEDO,
		TERRAN_DT_BASE, TERRAN_DT_SPAN, TERRAN_DT_MAX, AIRLESS_M, ATM_RETAIN_M,
		A0_MIN_AU, GIANT_A0_FACTOR, WD_DISK_OUT_AU, WD_BELT_PRESENCE,
		BELT_TYPICAL_MU, BELT_TYPICAL_R_M, BELT_ALBEDO, BELT_DENSITY, BELT_FADE_TAU,
		AU_M, M_SUN_KG, G_SI, M_EARTH_KG, M_EARTH_SUN, R_EARTH_M, R_SUN_M, R_SUN_AU,
		RHO_EARTH, TEFF_SUN, HOURS_PER_YEAR,
		DOMAIN_PLANETS, DOMAIN_AGE,
		createStellarInputs, createSystemRecord, createSummaryRecord, createBodyInfo,
		sharedSystem, sharedSummary,
		stellarInputs, generateSystem, systemSummary, classifyBody,
		massFromClassAndMag, stellarRadius, luminosityFromAbsMag,
		bodyDesignation, starDesignation,
	};
	if (typeof module !== 'undefined') module.exports = PlanetsLib;
	if (typeof window !== 'undefined') window.PlanetsLib = PlanetsLib;
})();
