// experiments/planet-gen-test.js
// The planet module's input tier (0.5.0-2a/-2b): the identity keys the renderer
// writes beside every record (plan §2.2/§2.3), the magnitude→mass inversion
// (§2.5), the stellar radius, and the per-block `stellarInputs` paths (§2.4) —
// the three re-derivable blocks pinned bit-exactly against the derivation the
// renderer itself runs, the two record-only blocks pinned to the inversion —
// and the occurrence tier (0.5.1-3, §4.4): the μ table, the bulk weights with
// their f_Z / state modifiers, and the geometric count draw pinned against the
// analytic mean (E[n] = 0.825 at μ = 1.2) — and the architecture tier
// (0.5.1-4, §4.5): disc edges, the log-uniform axes, the bulk/mass draws, the
// Hill repair and the orbital elements, bit-equal to a test-side
// reimplementation and holding the §4.12 stability invariants over 20k
// systems.
//
// Output: experiments/logs/planet-gen.json

'use strict';

const fs = require('fs');
const path = require('path');

// Alias window so the src modules attach their API here, as in the browser.
globalThis.window = globalThis;

const hash = require('../src/math/hash.js');
const density = require('../src/math/density.js');
const galaxy = require('../src/math/galaxy.js');
const sampling = require('../src/math/sampling.js');
const records = require('../src/math/star-record.js');
const starTypes = require('../src/math/star-types.js');
const objects = require('../src/math/objects.js');
const planets = require('../src/math/planets.js');
const landmarks = require('../src/data/landmarks.js');

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
	return !!pass;
}

const model = galaxy.createGalaxy({ type: 'SBb', seed: 12345, age: 13.5 });

// --- 1. Identity keys (plan §2.2/§2.3) ---------------------------------------
{
	const key = 0x12345678;
	const a = planets.systemSeed(key, model.seed, planets.BLOCK_FIELD);
	check('systemSeed is the domain hash of (key, model seed, block)',
		a === hash.hash4(key >>> 0, model.seed | 0, planets.DOMAIN_PLANETS, planets.BLOCK_FIELD), a);
	check('systemSeed is deterministic', a === planets.systemSeed(key, model.seed, planets.BLOCK_FIELD), a);
	check('systemSeed separates block kinds, keys and model seeds',
		new Set([
			a,
			planets.systemSeed(key, model.seed, planets.BLOCK_LANDMARK),
			planets.systemSeed((key + 1) | 0, model.seed, planets.BLOCK_FIELD),
			planets.systemSeed(key, (model.seed + 1) | 0, planets.BLOCK_FIELD),
		]).size === 4);

	check('the five block ids name the renderer\'s five blocks in buffer order',
		planets.BLOCK_FIELD === 0 && planets.BLOCK_LANDMARK === 1 && planets.BLOCK_OBJECT === 2
		&& planets.BLOCK_LOCAL === 3 && planets.BLOCK_CATALOG === 4
		&& planets.BLOCK_NAMES.join(',') === 'field,landmark,object,local,catalog',
		planets.BLOCK_NAMES);

	// The field key is `seed*31 + i + 1`, stored in a Uint32Array by the
	// renderer. Injection is what makes it a key; the truncation is harmless
	// because every channel draw goes through pcgHash's `| 0`.
	const seed = model.seed | 0;
	let injective = true;
	const seen = new Set();
	for (let i = 0; i < 20000; i++) {
		const k = starTypes.fieldStarSeed(seed, i) >>> 0;
		if (seen.has(k)) { injective = false; break; }
		seen.add(k);
	}
	check('fieldStarSeed is injective over 20k indices (keys double as slots)', injective, seen.size);

	const full = {}, trunc = {};
	let same = true;
	for (const i of [0, 1, 7, 1234, 19999]) {
		starTypes.deriveStar(model, starTypes.fieldStarSeed(seed, i), 0, 8, 0.3, full, 0.01);
		starTypes.deriveStar(model, starTypes.fieldStarSeed(seed, i) >>> 0, 0, 8, 0.3, trunc, 0.01);
		if (full.mass !== trunc.mass || full.absMag !== trunc.absMag
			|| full.colorIndex !== trunc.colorIndex || full.age !== trunc.age) same = false;
	}
	check('the stored u32 field key re-derives the same star (pcgHash reads mod 2^32)', same);

	// Landmark keys are positional and unique across the whole table.
	let uniqueLandmarks = true;
	const lseen = new Set();
	for (let i = 0; i < landmarks.count; i++) {
		const k = planets.landmarkKey(i);
		if (lseen.has(k)) { uniqueLandmarks = false; break; }
		lseen.add(k);
	}
	check('landmark keys are unique across the whole landmark table', uniqueLandmarks, landmarks.count);
	check('landmarkKey equals the domain hash',
		planets.landmarkKey(3) === hash.hash4(planets.DOMAIN_LANDMARK, 3, 0, 0), planets.landmarkKey(3));

	check('catalogKey is (cell, slot-in-cell) and separates both',
		planets.catalogKey(7, 99) === hash.hash4(planets.DOMAIN_CATALOG, 7, 99, 0)
		&& planets.catalogKey(7, 99) !== planets.catalogKey(7, 100)
		&& planets.catalogKey(7, 99) !== planets.catalogKey(8, 99), planets.catalogKey(7, 99));

	const m0 = objects.objectMemberSeed(12345, 0) >>> 0;
	check('objectMemberSeed is stable and unique per (object, member)',
		m0 === (objects.objectMemberSeed(12345, 0) >>> 0)
		&& m0 !== (objects.objectMemberSeed(12345, 1) >>> 0)
		&& m0 !== (objects.objectMemberSeed(12346, 0) >>> 0), m0);
}

// --- 2. The §2.5 inversion ---------------------------------------------------
{
	const G = records.SPECTRAL_CLASSES.indexOf('G');
	const out = {};

	const sun = planets.massFromClassAndMag(G, 4.83, out);
	check('the Sun (G, M_V 4.83 → L 1.00) inverts to 1.00 ± 0.02 M☉',
		Math.abs(sun - 1) < 0.02 && Math.abs(out.lum - 1) < 0.01, { mass: sun, lum: out.lum });

	const A = records.SPECTRAL_CLASSES.indexOf('A');
	const sirius = planets.massFromClassAndMag(A, 1.43, out);
	check('Sirius A (A, M_V 1.43 → L 22.9) inverts to 2.45 ± 0.15 M☉',
		Math.abs(sirius - 2.45) < 0.15 && Math.abs(out.lum - 22.9) < 0.25, { mass: sirius, lum: out.lum });

	const K = records.SPECTRAL_CLASSES.indexOf('K');
	const kMass = planets.massFromClassAndMag(K, 7.5, out);
	check('a K landmark (M_V 7.5 → L 0.086) clamps to the bracket floor 0.55',
		kMass === 0.55 && Math.abs(out.lum - 0.0855) < 0.001, { mass: kMass, lum: out.lum });

	let floors = true;
	let ceilings = true;
	for (const cls of records.SPECTRAL_CLASSES) {
		const bracket = planets.CLASS_MASS_BRACKETS[cls];
		const ci = records.SPECTRAL_CLASSES.indexOf(cls);
		if (planets.massFromClassAndMag(ci, 30) !== bracket[0]) floors = false;
		if (planets.massFromClassAndMag(ci, -10) !== bracket[1]) ceilings = false;
	}
	check('every class clamps into its own bracket at both magnitude extremes', floors && ceilings);

	// The α = 2.3 / 4.0 law jumps *down* at 0.7 M☉, so (0.240, 0.440) L☉ has two
	// roots and the smallest survivor is the contract.
	const m03 = planets.massFromLuminosity(0.3);
	check('the smallest surviving branch root wins (0.3 L☉ → 0.593 M☉, not 0.740)',
		Math.abs(m03 - 0.5925) < 5e-4 && m03 < 0.7, m03);
	const jumpLo = starTypes.luminosityFromMass(0.6999);
	const jumpHi = starTypes.luminosityFromMass(0.7);
	check('the law jumps down at 0.7 M☉ (0.440 → 0.240) — the reason smallest wins',
		Math.abs(jumpLo - 0.440) < 0.002 && Math.abs(jumpHi - 0.240) < 0.002, { lo: jumpLo, hi: jumpHi });

	const WD = records.SPECTRAL_CLASSES.indexOf('WD');
	const RG = records.SPECTRAL_CLASSES.indexOf('RG');
	check('a white dwarf\'s tiny L lands on its 0.5 M☉ remnant floor',
		planets.massFromClassAndMag(WD, 12) === 0.5, planets.massFromClassAndMag(WD, 12));
	check('a giant\'s L clamps into the initial-mass bracket, by state not by cooling',
		planets.massFromClassAndMag(RG, -2) === 3.0, planets.massFromClassAndMag(RG, -2));
}

// --- 3. Stellar radius -------------------------------------------------------
{
	check('R★(1 L☉, 5772 K) = 1.000 by construction',
		Math.abs(planets.stellarRadius(1, planets.TEFF_SUN) - 1) < 1e-12, planets.stellarRadius(1, planets.TEFF_SUN));
	check('a 100 L☉ giant at 4000 K has R★ = 20.8 R☉',
		Math.abs(planets.stellarRadius(100, 4000) - 20.8) < 0.05, planets.stellarRadius(100, 4000));
	check('a degenerate luminosity gives a zero radius, not NaN',
		planets.stellarRadius(0, 3000) === 0 && planets.stellarRadius(1, 0) === planets.stellarRadius(1, planets.TEFF_SUN));
}

// --- 4. Per-block stellar inputs (plan §2.4) ---------------------------------
const fieldCount = 512;
const field = sampling.sampleGalaxyStars(model, model.seed | 0, fieldCount, null);
{
	// The field path must be the renderer's own call: same key (from the
	// identity convention), same component/R/distToArm/z from fieldBuffers().
	const expected = {};
	const actual = {};
	let worst = 0;
	let classMismatch = 0;
	for (let i = 0; i < fieldCount; i++) {
		const key = starTypes.fieldStarSeed(model.seed, i) >>> 0;
		planets.stellarInputs({ kind: planets.BLOCK_FIELD, index: i, key },
			{ model, field }, actual);
		starTypes.deriveStar(model, starTypes.fieldStarSeed(model.seed, i),
			field.component[i], field.R[i], field.distToArm[i], expected, field.z[i]);
		worst = Math.max(worst,
			Math.abs(actual.mass - expected.mass),
			Math.abs(actual.lum - expected.luminosity),
			Math.abs(actual.teff - expected.teff),
			Math.abs(actual.age - expected.age),
			Math.abs(actual.metal - expected.metallicity));
		if (actual.colorIndex !== expected.colorIndex || actual.state !== expected.state) classMismatch++;
	}
	check('the field block re-derives bit-exactly from the identity key', worst === 0 && classMismatch === 0,
		{ worst, classMismatch });

	const noKey = {};
	planets.stellarInputs({ kind: planets.BLOCK_FIELD, index: 3 }, { model, field }, noKey);
	const withKey = {};
	planets.stellarInputs({ kind: planets.BLOCK_FIELD, index: 3, key: starTypes.fieldStarSeed(model.seed, 3) >>> 0 },
		{ model, field }, withKey);
	check('a keyless field ref falls back to the seed formula and agrees',
		noKey.mass === withKey.mass && noKey.lum === withKey.lum && noKey.colorIndex === withKey.colorIndex);

	check('every field snapshot carries the derived rStar',
		Math.abs(actual.rStar - planets.stellarRadius(actual.lum, actual.teff)) < 1e-12, actual.rStar);
}

{
	// The local gap-fill path, replicated exactly as writeLocalProceduralStars
	// computes it: slotSeed → jitter position → component → deriveSeed.
	const cell = { id: 7, x0: 1.2, y0: -0.4, z0: 0.05, size: 0.4, fillNeeded: 24 };
	const localSeed = (model.seed | 0) ^ 0x10ca1cab;
	const expected = {};
	const actual = {};
	let worst = 0;
	for (let i = 0; i < cell.fillNeeded; i++) {
		const slotSeed = (Math.imul(localSeed, 0x9e3779b1)
			^ Math.imul(cell.id, 0x85ebca6b)
			^ Math.imul(i + 1, 0xc2b2ae3d));
		const sx = cell.x0 + hash.hash01At(slotSeed, 0) * cell.size;
		const sy = cell.y0 + hash.hash01At(slotSeed, 1) * cell.size;
		const sz = cell.z0 + hash.hash01At(slotSeed, 2) * cell.size;
		const decomposed = density.rhoDecomposed(model, sx, sy, sz);
		const component = density.sampleComponentIndex(decomposed, hash.hash01At(slotSeed, 3));
		starTypes.deriveStar(model, Math.imul(slotSeed, 31) + 5,
			component, decomposed.R, decomposed.distToArm, expected, sz);
		planets.stellarInputs({ kind: planets.BLOCK_LOCAL, index: i, key: slotSeed >>> 0, x: sx, y: sy, z: sz },
			{ model }, actual);
		worst = Math.max(worst,
			Math.abs(actual.mass - expected.mass),
			Math.abs(actual.lum - expected.luminosity),
			Math.abs(actual.teff - expected.teff),
			Math.abs(actual.age - expected.age));
	}
	check('the local block re-derives bit-exactly from the key (position through rhoDecomposed)', worst === 0,
		worst);
}

{
	// Object members: the record + the block's member context must reproduce the
	// writer's own derivation for the slot they were written at.
	const maxMembers = 4096;
	const placed = objects.placeObjects(model, (model.seed | 0) ^ 0x0B5E55, 80, null);
	const quotas = new Uint16Array(placed.length);
	objects.objectQuotas(placed, maxMembers, quotas);
	const staging = new ArrayBuffer(maxMembers * records.RECORD_BYTES);
	const view = new DataView(staging);
	const identity = new Uint32Array(maxMembers);
	const memberMeta = { age: new Float64Array(maxMembers), component: new Int8Array(maxMembers) };
	const written = objects.writeObjectMembers(model, placed, view, 0, maxMembers, 0,
		identity, 0, memberMeta).written;

	const expected = {};
	const actual = {};
	const memberOffset = new Float64Array(3);
	let slotWorst = 0;
	let slots = 0;
	let planetary = 0;
	let contextBad = 0;
	let slot = 0;
	for (let j = 0; j < placed.length && slot < written; j++) {
		const obj = placed[j];
		const quota = quotas[j];
		const component = (obj.type === 'HII' || obj.type === 'open') ? density.COMPONENT_THIN
			: obj.type === 'globular' ? density.COMPONENT_HALO
				: density.COMPONENT_NAMES.indexOf(obj.dominant);
		for (let i = 0; i < quota && slot < written; i++, slot++) {
			if (slot % 5 !== 0) continue;
			slots++;
			const memberSeed = objects.objectMemberSeed(obj.seed | 0, i);
			const rec = records.readRecord(view, slot * records.RECORD_BYTES);
			if (identity[slot] !== (memberSeed >>> 0)) contextBad++;
			if (memberMeta.age[slot] !== obj.ageGyr) contextBad++;
			const isPlanetary = obj.type === 'planetary';
			if (isPlanetary) {
				if (memberMeta.component[slot] !== -1) contextBad++;
				planetary++;
			} else if (memberMeta.component[slot] !== component) contextBad++;

			// The writer's own derivation, recomputed here from the placed object.
			objects.sampleMemberOffset(obj, i, memberOffset);
			const mx = obj.x + memberOffset[0];
			const my = obj.y + memberOffset[1];
			const mz = obj.z + memberOffset[2];
			const dx = mx - model.centre.x;
			const dy = my - model.centre.y;
			const R = Math.sqrt(dx * dx + dy * dy);
			const distToArm = density.distanceToNearestArm(model, R, Math.atan2(dy, dx));
			if (isPlanetary) starTypes.derivePlanetaryCentral(memberSeed, component, R, distToArm, expected);
			else starTypes.deriveStarWithAge(model, memberSeed, component, R, distToArm, obj.ageGyr, expected);

			planets.stellarInputs({
				kind: planets.BLOCK_OBJECT, index: slot, key: identity[slot],
				x: rec.x, y: rec.y, z: rec.z,
			}, { model, member: memberMeta }, actual);
			slotWorst = Math.max(slotWorst,
				Math.abs(actual.mass - expected.mass),
				Math.abs(actual.lum - expected.luminosity),
				Math.abs(actual.teff - expected.teff),
				Math.abs(actual.age - expected.age),
				Math.abs(actual.metal - expected.metallicity));
		}
	}
	check('the object block keeps key, age and component aligned with the record',
		contextBad === 0 && slots > 40, { contextBad, slots, planetary });
	check('object members re-derive bit-exactly from key + member context', slotWorst === 0, slotWorst);
}

{
	// Landmark / catalog: the record is all there is, so the class bracket, the
	// model epoch and the thin-disc metallicity are the contract.
	const G = records.SPECTRAL_CLASSES.indexOf('G');
	const out = {};
	planets.stellarInputs({ kind: planets.BLOCK_LANDMARK, index: 0, colorIndex: G, absMag: 4.83 },
		{ model }, out);
	check('a landmark takes state/Teff from its class, age from the model, Z from the thin disc',
		out.state === 'ms' && out.spectralClass === 'G'
		&& Math.abs(out.teff - planets.teffForClass('G')) < 1e-9
		&& out.age === model.populations.age
		&& out.metal === starTypes.metallicityFor(density.COMPONENT_THIN),
		{ state: out.state, teff: out.teff, age: out.age, metal: out.metal });
	check('the landmark snapshot echoes the record and carries the derived radius',
		out.colorIndex === G && Math.abs(out.absMag - 4.83) < 1e-12
		&& Math.abs(out.rStar - planets.stellarRadius(out.lum, out.teff)) < 1e-12);

	const RG = records.SPECTRAL_CLASSES.indexOf('RG');
	const cat = {};
	planets.stellarInputs({ kind: planets.BLOCK_CATALOG, index: 9, key: planets.catalogKey(3, 9), colorIndex: RG, absMag: -2 },
		{ model }, cat);
	check('a catalog giant reports state giant and the top of its bracket',
		cat.state === 'giant' && cat.mass === 3.0 && cat.spectralClass === 'RG', { mass: cat.mass, state: cat.state });
}

// --- 5. Occurrence: μ, f_Z, state, the count draw (plan §4.4, 0.5.1-3) -----
{
	// The μ table is the plan's, class for class, and muForClass reads it.
	const planMu = { O: 0.02, B: 0.10, A: 0.35, F: 0.90, G: 1.20, K: 1.30, M: 1.60, WD: 0.15, RG: 0.40, RGe: 0.30 };
	const muOk = records.SPECTRAL_CLASSES.every(cls => planets.CLASS_MU[cls] === planMu[cls])
		&& planets.muForClass('G') === 1.20 && planets.muForClass('M') === 1.60
		&& planets.muForClass('no-such-class') === planMu.M;
	check('the μ table is the plan\'s census shape, class for class', muOk, planets.CLASS_MU);

	// The mean is analytic (plan §4.4): the test pins the formula, not a
	// Monte-Carlo average. The series is summed here independently of the
	// module's loop and against the plan's published values.
	const series = (mu) => {
		let sum = 0, term = 1;
		for (let k = 1; k <= 100; k++) { term *= mu / (mu + k); sum += term; }
		return sum;
	};
	const e12 = planets.expectedPlanetCount(1.2);
	const e16 = planets.expectedPlanetCount(1.6);
	const e02 = planets.expectedPlanetCount(0.02);
	check('E[n] pins the analytic mean: 0.825 at μ = 1.2, 1.0195 at 1.6, 0.0198 at 0.02',
		Math.abs(e12 - 0.825) < 5e-4 && Math.abs(e16 - 1.0195) < 5e-5 && Math.abs(e02 - 0.0198) < 5e-5
		&& Math.abs(e12 - series(1.2)) < 1e-9 && Math.abs(e16 - series(1.6)) < 1e-9
		&& Math.abs(e02 - series(0.02)) < 1e-9,
		{ e12, e16, e02 });
	// P(n = 0) = 1/(μ+1) and P(n ≥ 4) = Π_{j<4} μ/(μ+j+1), the plan's other two
	// published consequences of the same chain.
	const p0 = 1 / (1 + 1.2);
	const pGe4 = (1.2 / 2.2) * (1.2 / 3.2) * (1.2 / 4.2) * (1.2 / 5.2);
	check('P(n = 0) = 0.455 and P(n ≥ 4) = 0.0135 at μ = 1.2 (closed forms)',
		Math.abs(p0 - 0.455) < 5e-4 && Math.abs(pGe4 - 0.0135) < 5e-5, { p0, pGe4 });

	// The draw itself, over 100k fresh system seeds: the Monte-Carlo mean is
	// within 2% of the formula (plan §4.12), the chain is the documented
	// channels (hash01At(seed, 2 + n), recomputed here independently), and it
	// is a pure function of the seed.
	const chainRef = (seed, mu) => {
		let n = 0;
		while (n < planets.MAX_PLANETS && hash.hash01At(seed, 2 + n) < mu / (mu + n + 1)) n++;
		return n;
	};
	let sum12 = 0, zero12 = 0, capHits = 0, chainBad = 0, detBad = 0;
	for (let i = 0; i < 100000; i++) {
		const seed = hash.pcgHash(i * 2654435761 + 7);
		const n = planets.planetCount(seed, 1.2);
		sum12 += n;
		if (n === 0) zero12++;
		if (n >= planets.MAX_PLANETS) capHits++;
		if (n !== chainRef(seed, 1.2)) chainBad++;
		if (planets.planetCount(seed, 1.2) !== n) detBad++;
	}
	const mcMean = sum12 / 100000;
	check('the count draw matches the analytic mean within 2% over 100k draws (§4.12)',
		Math.abs(mcMean - e12) < 0.02 * e12, { mcMean, analytic: e12 });
	check('the chain is the documented channels, deterministic, and never exceeds MAX_PLANETS',
		chainBad === 0 && detBad === 0 && capHits === 0 && zero12 / 100000 > 0.44 && zero12 / 100000 < 0.47,
		{ chainBad, detBad, capHits, pZero: zero12 / 100000 });

	// Class census over 20k systems per class (plan §4.4's emergent pins that
	// this tier can already measure): M dwarfs out-produce G, O/B average under
	// 0.1 planets a star.
	const meanFor = (clsIdx) => {
		const cls = records.SPECTRAL_CLASSES[clsIdx];
		const mu = planets.muForClass(cls);
		let sum = 0;
		for (let i = 0; i < 20000; i++) sum += planets.planetCount(hash.pcgHash((i + 1) * 0x9E3779B1 + clsIdx), mu);
		return sum / 20000;
	};
	const means = {};
	for (let r = 0; r < records.SPECTRAL_CLASSES.length; r++) means[records.SPECTRAL_CLASSES[r]] = +meanFor(r).toFixed(3);
	check('census: M averages more planets than G, O/B under 0.1 (20k systems per class)',
		means.M > means.G && means.O < 0.1 && means.B < 0.1
		&& Math.abs(means.G - e12) < 0.05 * e12 && Math.abs(means.M - e16) < 0.05 * e16,
		means);
}

{
	// f_Z: (Z/0.020)² with the plan's clamps (Fischer & Valenti, giants only).
	// The decimal literals are not exact binary fractions, so the identity is
	// pinned to 1e-12, the clamps exactly.
	const fzClose = (z, want) => Math.abs(planets.fZFactor(z) - want) < 1e-12;
	check('f_Z is (Z/0.02)² clamped to [0.05, 4]',
		planets.fZFactor(0.020) === 1 && fzClose(0.01, 0.25) && fzClose(0.035, 3.0625)
		&& planets.fZFactor(0.001) === 0.05 && planets.fZFactor(0.0001) === 0.05
		&& planets.fZFactor(0.04) === 4 && planets.fZFactor(0.2) === 4,
		{ halo: planets.fZFactor(0.001), bulge: planets.fZFactor(0.035) });

	// The weight table: the plan's rows, in SPECTRAL_CLASSES order, columns in
	// BULKS order, each row normalised into a load-time CDF.
	const planRows = {
		O: [0, 0, 0, 0, 0.55, 0.25, 0.20], B: [0, 0, 0.05, 0.10, 0.50, 0.25, 0.10],
		A: [0.08, 0.10, 0.15, 0.20, 0.27, 0.12, 0.08], F: [0.22, 0.12, 0.20, 0.15, 0.13, 0.08, 0.10],
		G: [0.26, 0.12, 0.20, 0.14, 0.10, 0.07, 0.11], K: [0.28, 0.12, 0.22, 0.12, 0.08, 0.06, 0.12],
		M: [0.36, 0.10, 0.28, 0.10, 0.01, 0.02, 0.13], WD: [0.30, 0.15, 0.10, 0.03, 0.02, 0.03, 0.37],
		RG: [0.10, 0.18, 0.15, 0.15, 0.22, 0.12, 0.08], RGe: [0.14, 0.24, 0.15, 0.12, 0.17, 0.10, 0.08],
	};
	let rowsOk = true;
	for (let r = 0; r < records.SPECTRAL_CLASSES.length; r++) {
		const row = planets.CLASS_BULK_WEIGHTS[r];
		const want = planRows[records.SPECTRAL_CLASSES[r]];
		if (!row || !want || row.length !== 7) { rowsOk = false; break; }
		let sum = 0;
		for (let c = 0; c < 7; c++) {
			if (row[c] !== want[c]) rowsOk = false;
			sum += row[c];
		}
		if (Math.abs(sum - 1) > 1e-12) rowsOk = false;
	}
	// Column c is BULKS[c]: rock..dwarf in plan order (the state rules below
	// pin the columns by name, so this is the alignment check).
	if (planets.BULKS.map(b => b.name).join(',') !== 'rock,ice,super,mini,gas,icegiant,dwarf') rowsOk = false;
	check('the bulk weight table is the plan\'s, rows in class order, columns in BULKS order', rowsOk);

	const N = planets.BULKS.length;
	let cdfOk = true;
	for (let r = 0; r < records.SPECTRAL_CLASSES.length; r++) {
		let prev = 0;
		for (let c = 0; c < N; c++) {
			const v = planets.CLASS_BULK_CDF[r * N + c];
			if (!(v >= prev)) cdfOk = false;
			prev = v;
		}
		if (prev !== 1) cdfOk = false;
	}
	check('every load-time CDF row is nondecreasing and ends at exactly 1', cdfOk);

	// bulkCdfFor: the fast path (thin-disc Z, main sequence) is the load-time
	// row, and the slow path renormalises the same weights — pinned against a
	// test-side cumsum of the raw row.
	const out = new Float64Array(N);
	planets.bulkCdfFor('G', 0.020, 'ms', out);
	const rowG = planets.CLASS_BULK_WEIGHTS[records.SPECTRAL_CLASSES.indexOf('G')];
	let acc = 0, cumOk = true;
	for (let i = 0; i < N; i++) {
		acc += rowG[i];
		if (out[i] !== planets.CLASS_BULK_CDF[records.SPECTRAL_CLASSES.indexOf('G') * N + i]) cumOk = false;
		if (Math.abs(out[i] - Math.fround(acc)) > 1e-12) cumOk = false;
	}
	planets.bulkCdfFor('G', 0.035, 'giant', out);
	let mono = 0;
	for (let i = 1; i < N; i++) if (out[i] >= out[i - 1]) mono++;
	check('bulkCdfFor: fast path is the load-time row, modified rows renormalise to a CDF',
		cumOk && out[N - 1] === 1 && mono === N - 1, { last: out[N - 1], mono });
}

{
	// The modifiers at weight level (plan §4.4): f_Z scales the giant columns
	// only, the giant state scales rock/ice/super by 0.25 only, the wd state
	// replaces the row with the debris inventory. The emergent draw-level
	// pins (giant fraction over 20k systems) land with the bulk draw (0.5.1-4);
	// what is pinned here is exactly the rule the draw will consume.
	const w = new Float64Array(7);
	const base = new Float64Array(7);
	const GIANTS = ['gas', 'icegiant', 'mini'].map(n => planets.BULK_INDEX[n]);
	const SURVIVORS = ['rock', 'ice', 'super'].map(n => planets.BULK_INDEX[n]);

	planets.bulkWeightsFor('G', 0.020, 'ms', base);
	planets.bulkWeightsFor('G', 0.035, 'ms', w);
	let fzOnlyGiants = true;
	for (let i = 0; i < 7; i++) {
		const want = GIANTS.includes(i) ? base[i] * 3.0625 : base[i];
		if (!(Math.abs(w[i] - want) <= 1e-12 * Math.max(1e-9, Math.abs(want)))) fzOnlyGiants = false;
	}
	check('f_Z scales gas/icegiant/mini only, by exactly (Z/0.02)²', fzOnlyGiants);

	planets.bulkWeightsFor('G', 0.020, 'giant', w);
	let giantRule = true;
	for (let i = 0; i < 7; i++) {
		const want = SURVIVORS.includes(i) ? base[i] * 0.25 : base[i];
		if (w[i] !== want) giantRule = false;
	}
	check('the giant state scales rock/ice/super by 0.25 (only wide survivors)', giantRule);

	let wdRule = true;
	for (const cls of records.SPECTRAL_CLASSES) {
		planets.bulkWeightsFor(cls, 0.035, 'wd', w);
		for (let i = 0; i < 7; i++) {
			const want = i === planets.BULK_INDEX.rock ? 0.30 : i === planets.BULK_INDEX.dwarf ? 0.70 : 0;
			if (w[i] !== want) wdRule = false;
		}
	}
	check('the wd state is the debris row itself: rock 0.30, dwarf 0.70, for every class', wdRule);

	// The giant share of the weights is the bulk draw's expectation: it must
	// rise by ≥ 3× between halo and bulge metallicity (plan §4.4/§4.12).
	const giantShare = (cls, z, state) => {
		planets.bulkWeightsFor(cls, z, state, w);
		let giant = 0, all = 0;
		for (let i = 0; i < 7; i++) { all += w[i]; if (GIANTS.includes(i)) giant += w[i]; }
		return giant / all;
	};
	let minRatio = Infinity, worstCls = '';
	const ratios = {};
	for (const cls of records.SPECTRAL_CLASSES) {
		const ratio = giantShare(cls, 0.035, 'ms') / giantShare(cls, 0.001, 'ms');
		ratios[cls] = +ratio.toFixed(2);
		if (ratio < minRatio) { minRatio = ratio; worstCls = cls; }
	}
	check('the giant fraction rises by ≥ 3× between halo and bulge Z, every class',
		minRatio >= 3, { minRatio, worstCls, ratios });
}

// --- 6. Architecture: edges, axes, Hill repair, elements (plan §4.5, 0.5.1-4) --
{
	const AU_PER_R_SUN = 6.957e8 / 1.495978707e11;
	const EARTH_SUN = 5.9722e24 / 1.98892e30;

	// Deterministic star factory for the sweeps: class, metallicity tier and
	// mass cycle; luminosity by state (the architecture only reads mass,
	// rStar, metal, state, class).
	const METALS = [0.001, 0.008, 0.020, 0.035];
	function makeStar(i) {
		const cls = records.SPECTRAL_CLASSES[i % records.SPECTRAL_CLASSES.length];
		const u = hash.hash01At(hash.pcgHash(i + 1), 11);
		const bracket = planets.CLASS_MASS_BRACKETS[cls];
		const mass = bracket[0] * Math.pow(bracket[1] / bracket[0], u);
		const state = planets.stateForClass(cls);
		const teff = planets.teffForClass(cls);
		const lum = state === 'wd' ? 0.001 + 0.01 * u
			: state === 'giant' ? 50 + 150 * u
			: starTypes.luminosityFromMass(mass);
		return {
			mass, rStar: planets.stellarRadius(lum, teff),
			metal: METALS[i % METALS.length], state, spectralClass: cls,
		};
	}

	// Disc edges (plan §4.5): the Sun's clearance, the 0.012 floor, the
	// sqrt(M★) outer edge, the wd cut — and the AU-per-R☉ factor derived from
	// the two §4.1 constants rather than authored twice.
	check('disc edges: Sun a0 = 6 R★ = 0.0279 AU, a_out = 40 AU; floor at 0.012; wd cut at 0.05',
		Math.abs(planets.AU_PER_R_SUN - AU_PER_R_SUN) < 1e-18
		&& Math.abs(planets.innerEdgeAU(1) - 6 * AU_PER_R_SUN) < 1e-15
		&& Math.abs(planets.innerEdgeAU(1) - 0.0279) < 2e-4
		&& planets.innerEdgeAU(0.2) === 0.012
		&& planets.outerEdgeAU(1, 'ms') === 40
		&& Math.abs(planets.outerEdgeAU(0.2, 'ms') - 40 * Math.sqrt(0.2)) < 1e-12
		&& planets.outerEdgeAU(0.6, 'wd') === 0.05
		&& planets.outerEdgeAU(1e-6, 'wd') === 40 * Math.sqrt(1e-6),
		{ sunA0: planets.innerEdgeAU(1), m02Out: planets.outerEdgeAU(0.2, 'ms') });

	// The Hill closed form (plan §4.5's corrected worked numbers): K_HILL·r_H
	// at 1 AU mean distance is 0.41 AU for one Jupiter, 0.52 for two; the push
	// lands the second Jupiter at 1.70 AU; a near-stellar pair around a small
	// star has c ≥ 1 — no finite separation, the drop branch.
	const cJ1 = planets.hillPushFactor(318, 1);
	const cJ2 = planets.hillPushFactor(636, 1);
	check('Hill: one Jupiter at 1 AU needs 0.41 AU, two 0.52; the push lands at 1.70; c ≥ 1 drops',
		Math.abs(2 * cJ1 - 0.41) < 0.005 && Math.abs(2 * cJ2 - 0.52) < 0.005
		&& Math.abs((1 + cJ2) / (1 - cJ2) - 1.696) < 0.005
		&& planets.hillPushFactor(6000, 0.08) >= 1
		&& Math.abs(cJ1 - 0.5 * planets.K_HILL * Math.cbrt(318 * EARTH_SUN / 3)) < 1e-15,
		{ oneJupiter: 2 * cJ1, twoJupiters: 2 * cJ2, push: (1 + cJ2) / (1 - cJ2) });

	// massForBulk is log-uniform inside the §4.3 bracket: exact at the ends,
	// the geometric mean at u = 0.5.
	let massLawOk = true;
	for (let b = 0; b < planets.BULKS.length; b++) {
		const bulk = planets.BULKS[b];
		if (Math.abs(planets.massForBulk(b, 0) - bulk.massMin) > 1e-12 * bulk.massMin) massLawOk = false;
		if (Math.abs(planets.massForBulk(b, 1) - bulk.massMax) > 1e-12 * bulk.massMax) massLawOk = false;
		const mid = Math.sqrt(bulk.massMin * bulk.massMax);
		if (Math.abs(planets.massForBulk(b, 0.5) - mid) > 1e-12 * mid) massLawOk = false;
	}
	check('massForBulk is log-uniform: bracket ends exact, geometric mean at u = 0.5', massLawOk,
		{ gasMid: planets.massForBulk(planets.BULK_INDEX.gas, 0.5) });

	// Crossed edges mean no disc (plan §4.5): a record-derived WD claiming a
	// 2 R☉ radius has a0 = 0.056 > the 0.05 cut, so n = 0 whatever the count
	// chain would have drawn.
	const arch = planets.createArchitecture();
	const bigWd = { mass: 0.8, rStar: 2, metal: 0.020, state: 'wd', spectralClass: 'WD' };
	let noDisc = true;
	for (let s = 0; s < 50; s++) {
		planets.architecture(hash.pcgHash(s + 77), bigWd, arch);
		if (arch.n !== 0 || arch.dropped !== 0 || arch.a0 <= arch.aOut) noDisc = false;
	}
	check('crossed edges (a0 ≥ a_out) produce no disc: n = 0 for a swollen record-derived WD', noDisc,
		{ a0: arch.a0, aOut: arch.aOut });

	// Determinism and purity: the same (seed, star) into two fresh records is
	// field-identical; a different seed or metallicity diverges.
	const archB = planets.createArchitecture();
	const sunStar = { mass: 1, rStar: 1, metal: 0.020, state: 'ms', spectralClass: 'G' };
	const FIELDS = ['slot', 'bulk', 'a', 'mass', 'e', 'inc', 'peri', 'phase', 'period', 'rotHours'];
	const sameRecord = (x, y) => {
		if (x.n !== y.n || x.dropped !== y.dropped || !Object.is(x.a0, y.a0)
			|| !Object.is(x.aOut, y.aOut) || !Object.is(x.eScale, y.eScale)) return false;
		for (const f of FIELDS) for (let i = 0; i < x.n; i++) if (!Object.is(x[f][i], y[f][i])) return false;
		return true;
	};
	let det = true, diverged = false;
	for (let s = 0; s < 200; s++) {
		const seed = hash.pcgHash(s * 331 + 17);
		planets.architecture(seed, sunStar, arch);
		planets.architecture(seed, sunStar, archB);
		if (!sameRecord(arch, archB)) det = false;
		planets.architecture(hash.pcgHash(s * 331 + 18), sunStar, archB);
		if (!sameRecord(arch, archB)) diverged = true;
	}
	check('architecture is pure in (seed, star): identical twice, diverging across seeds',
		det && diverged);

	// The strongest pin: a test-side reimplementation of the whole §4.5 chain
	// — channels as literals (eScale 0, count 2+n, slot fields 32+8p …39+8p),
	// the slot carried through sort and repair, one eScale for the system —
	// bit-equal over 500 mixed systems.
	const refCdf = new Float64Array(7);
	function refArchitecture(seed, star, out) {
		out.a0 = Math.max(0.012, 6 * star.rStar * AU_PER_R_SUN);
		out.aOut = 40 * Math.sqrt(star.mass);
		if (star.state === 'wd' && out.aOut > 0.05) out.aOut = 0.05;
		out.eScale = 0.2 + 1.6 * hash.hash01At(seed, 0);
		out.n = 0; out.dropped = 0;
		if (out.a0 >= out.aOut) return out;
		const mu = planets.muForClass(star.spectralClass);
		let drawn = 0;
		while (drawn < 12 && hash.hash01At(seed, 2 + drawn) < mu / (mu + drawn + 1)) drawn++;
		if (drawn === 0) return out;
		planets.bulkCdfFor(star.spectralClass, star.metal, star.state, refCdf);
		const lnA0 = Math.log(out.a0), lnSpan = Math.log(out.aOut) - lnA0;
		const axes = [], slots = [];
		for (let p = 0; p < drawn; p++) {
			axes.push(Math.exp(lnA0 + lnSpan * hash.hash01At(seed, 33 + 8 * p)));
			slots.push(p);
		}
		for (let i = 1; i < drawn; i++) {
			const a = axes[i], s = slots[i];
			let j = i;
			while (j > 0 && axes[j - 1] > a) { axes[j] = axes[j - 1]; slots[j] = slots[j - 1]; j--; }
			axes[j] = a; slots[j] = s;
		}
		const bulks = [], masses = [];
		for (let i = 0; i < drawn; i++) {
			const u = hash.hash01At(seed, 32 + 8 * slots[i]);
			let b = 6;
			for (let k = 0; k < 6; k++) if (u < refCdf[k]) { b = k; break; }
			bulks.push(b);
			const bk = planets.BULKS[b];
			masses.push(bk.massMin * Math.pow(bk.massMax / bk.massMin, hash.hash01At(seed, 34 + 8 * slots[i])));
		}
		let n = 0;
		for (let i = 0; i < drawn; i++) {
			let a = axes[i];
			if (n > 0) {
				const c = 3 * Math.cbrt((masses[n - 1] + masses[i]) * EARTH_SUN / (3 * star.mass));
				if (c >= 1) continue;
				const required = axes[n - 1] * (1 + c) / (1 - c);
				if (a < required) a = required;
			}
			if (a > out.aOut) continue;
			axes[n] = a; slots[n] = slots[i]; bulks[n] = bulks[i]; masses[n] = masses[i];
			n++;
		}
		out.n = n; out.dropped = drawn - n;
		for (let i = 0; i < n; i++) {
			const base = 32 + 8 * slots[i];
			const bk = planets.BULKS[bulks[i]];
			const ue = hash.hash01At(seed, base + 3);
			out.slot[i] = slots[i]; out.bulk[i] = bulks[i]; out.a[i] = axes[i]; out.mass[i] = masses[i];
			out.e[i] = out.eScale * bk.eccMax * ue * ue;
			out.inc[i] = out.eScale * 3 * hash.hash01At(seed, base + 4);
			out.peri[i] = 2 * Math.PI * hash.hash01At(seed, base + 5);
			out.phase[i] = 2 * Math.PI * hash.hash01At(seed, base + 6);
			out.period[i] = Math.sqrt(axes[i] * axes[i] * axes[i] / star.mass);
			out.rotHours[i] = bk.rotMin + (bk.rotMax - bk.rotMin) * hash.hash01At(seed, base + 7);
		}
		return out;
	}
	const ref = planets.createArchitecture();
	let bitEqual = 0;
	for (let s = 0; s < 500; s++) {
		const star = makeStar(s);
		const seed = hash.hash4(0xA5C1, s, 0, 0);
		planets.architecture(seed, star, arch);
		refArchitecture(seed, star, ref);
		if (sameRecord(arch, ref)) bitEqual++;
	}
	check('the chain is the documented channels: bit-equal to a reimplementation over 500 systems',
		bitEqual === 500, { bitEqual });

	// The §4.12 invariants over 20k mixed systems: ordered axes inside
	// [a0, a_out] and outside the clearance (for giants: outside 1.5 R★, the
	// plan's stated invariant), every pair at ≥ K_HILL mutual Hill radii,
	// masses inside their §4.3 brackets, the element ranges, Kepler III exact,
	// n + dropped equal to the count draw — and the drop is the rare outcome.
	let invariants = true, systems = 0, planetsSeen = 0, droppedSystems = 0, maxE = 0;
	const TAU = 2 * Math.PI;
	for (let s = 0; s < 20000; s++) {
		const star = makeStar(s);
		const seed = hash.hash4(0x5EED, s, 1, 2);
		planets.architecture(seed, star, arch);
		systems++;
		planetsSeen += arch.n;
		if (arch.dropped > 0) droppedSystems++;
		const drawn = planets.planetCount(seed, planets.muForClass(star.spectralClass));
		if (arch.a0 < arch.aOut && arch.n + arch.dropped !== drawn) invariants = false;
		for (let i = 0; i < arch.n; i++) {
			const b = planets.BULKS[arch.bulk[i]];
			if (arch.a[i] < arch.a0 * (1 - 1e-12) || arch.a[i] > arch.aOut * (1 + 1e-12)) invariants = false;
			if (arch.a[i] < planets.STAR_CLEARANCE * star.rStar * AU_PER_R_SUN * (1 - 1e-12)) invariants = false;
			if (star.state === 'giant' && arch.a[i] < 1.5 * star.rStar * AU_PER_R_SUN) invariants = false;
			if (i > 0) {
				if (arch.a[i] <= arch.a[i - 1]) invariants = false;
				const rH = Math.cbrt((arch.mass[i - 1] + arch.mass[i]) * EARTH_SUN / (3 * star.mass))
					* (arch.a[i - 1] + arch.a[i]) / 2;
				if (arch.a[i] - arch.a[i - 1] < planets.K_HILL * rH * (1 - 1e-9)) invariants = false;
			}
			if (arch.mass[i] < b.massMin * (1 - 1e-12) || arch.mass[i] > b.massMax * (1 + 1e-12)) invariants = false;
			if (arch.e[i] < 0 || arch.e[i] > 1.8 * b.eccMax) invariants = false;
			if (arch.e[i] > maxE) maxE = arch.e[i];
			if (arch.inc[i] < 0 || arch.inc[i] > 5.4) invariants = false;
			if (arch.peri[i] < 0 || arch.peri[i] >= TAU || arch.phase[i] < 0 || arch.phase[i] >= TAU) invariants = false;
			if (arch.rotHours[i] < b.rotMin || arch.rotHours[i] > b.rotMax) invariants = false;
			// a·a·a, not a**3: the exponent form rounds differently in the last bit.
			if (!Object.is(arch.period[i], Math.sqrt(arch.a[i] * arch.a[i] * arch.a[i] / star.mass))) invariants = false;
		}
	}
	check('§4.12 invariants over 20k systems: clearance, a_out, K_HILL spacing, brackets, elements',
		invariants, { systems, planets: planetsSeen, maxE: +maxE.toFixed(3) });
	check('dropping on overflow is the rare outcome (plan §4.5): under 10% of systems',
		droppedSystems / systems < 0.10, { dropRate: +(droppedSystems / systems).toFixed(4) });

	// Axis law: over single-planet Sun-like systems (the repair is a no-op at
	// n = 1) the ln-axis median and quartiles sit at 1/2, 1/4 and 3/4 of
	// [ln a0, ln a_out] — the draw is log-uniform, not flat.
	const lnAxes = [];
	for (let s = 0; s < 30000 && lnAxes.length < 6000; s++) {
		planets.architecture(hash.hash4(0xAE5, s, 3, 4), sunStar, arch);
		if (arch.n === 1 && arch.dropped === 0) lnAxes.push(Math.log(arch.a[0]));
	}
	lnAxes.sort((p, q) => p - q);
	const lnA0 = Math.log(planets.innerEdgeAU(1)), span = Math.log(40) - lnA0;
	const at = (q) => lnAxes[Math.floor(q * (lnAxes.length - 1))];
	check('axes are log-uniform: single-planet quartiles at 1/4, 1/2, 3/4 of [ln a0, ln a_out]',
		lnAxes.length >= 5000
		&& Math.abs(at(0.5) - (lnA0 + 0.5 * span)) < 0.02 * span
		&& Math.abs(at(0.25) - (lnA0 + 0.25 * span)) < 0.02 * span
		&& Math.abs(at(0.75) - (lnA0 + 0.75 * span)) < 0.02 * span,
		{ samples: lnAxes.length, median: +at(0.5).toFixed(3), mid: +(lnA0 + 0.5 * span).toFixed(3) });

	// WD systems are compact and debris-rich (plan §4.4/§4.12): every orbit in
	// [0.012, 0.05] — the factor-of-four span — and every bulk rock or dwarf.
	let wdOk = true, wdPlanets = 0;
	const wdStar = { mass: 0.8, rStar: 0.012, metal: 0.020, state: 'wd', spectralClass: 'WD' };
	for (let s = 0; s < 20000; s++) {
		planets.architecture(hash.hash4(0x3D, s, 5, 6), wdStar, arch);
		for (let i = 0; i < arch.n; i++) {
			wdPlanets++;
			if (arch.a[i] < 0.012 * (1 - 1e-12) || arch.a[i] > 0.05 * (1 + 1e-12)) wdOk = false;
			const name = planets.BULKS[arch.bulk[i]].name;
			if (name !== 'rock' && name !== 'dwarf') wdOk = false;
		}
	}
	check('wd systems are compact debris: orbits inside [0.012, 0.05] AU, bulks rock/dwarf only',
		wdOk && wdPlanets > 1000, { wdPlanets });

	// The emergent metallicity pin at draw level (§4.12): the drawn
	// gas/icegiant/mini share rises ≥ 3× between halo and bulge Z.
	const giantShareDrawn = (cls, metal) => {
		const bracket = planets.CLASS_MASS_BRACKETS[cls];
		const star = {
			mass: Math.sqrt(bracket[0] * bracket[1]), rStar: 1, metal,
			state: 'ms', spectralClass: cls,
		};
		let giant = 0, all = 0;
		for (let s = 0; s < 20000; s++) {
			planets.architecture(hash.hash4(0x21, s, 7, cls.charCodeAt(0)), star, arch);
			for (let i = 0; i < arch.n; i++) {
				all++;
				const name = planets.BULKS[arch.bulk[i]].name;
				if (name === 'gas' || name === 'icegiant' || name === 'mini') giant++;
			}
		}
		return giant / all;
	};
	const drawRatios = {};
	let minDrawRatio = Infinity;
	for (const cls of ['B', 'G', 'M']) {
		const ratio = giantShareDrawn(cls, 0.035) / giantShareDrawn(cls, 0.001);
		drawRatios[cls] = +ratio.toFixed(2);
		if (ratio < minDrawRatio) minDrawRatio = ratio;
	}
	check('the drawn giant share rises ≥ 3× between halo and bulge Z (B, G, M at draw level)',
		minDrawRatio >= 3, drawRatios);

	// Allocation and budget: a coarse heap-delta over 100k calls (per-call
	// object churn would be megabytes) and the per-call time against the §4.9
	// generateSystem budget of 20 µs — architecture is most of its draws.
	for (let s = 0; s < 1000; s++) planets.architecture(hash.pcgHash(s), makeStar(s), arch);
	const heapBefore = process.memoryUsage().heapUsed;
	const t0 = performance.now();
	for (let s = 0; s < 100000; s++) planets.architecture(hash.pcgHash(s), sunStar, arch);
	const usPerCall = (performance.now() - t0) * 1000 / 100000;
	const heapDelta = process.memoryUsage().heapUsed - heapBefore;
	check('architecture allocates nothing per call (coarse heap delta < 2 MB over 100k calls)',
		heapDelta < 2 * 1024 * 1024, { heapDelta });
	check('architecture is far inside the 20 µs generateSystem budget', usPerCall < 20,
		{ usPerCall: +usPerCall.toFixed(3) });
}

// --- Report ------------------------------------------------------------------
let passed = 0;
let failed = 0;
for (const c of checks) {
	if (c.pass) passed++; else failed++;
	console.log(`  ${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.pass ? '' : `  -> ${JSON.stringify(c.detail)}`}`);
}
console.log(`\n${passed}/${checks.length} passed, ${failed} failed`);

const logPath = path.join(__dirname, 'logs', 'planet-gen.json');
fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.writeFileSync(logPath, JSON.stringify({
	date: new Date().toISOString(),
	model: { type: model.type, seed: model.seed },
	totalChecks: checks.length,
	passed,
	failed,
	checks,
}, null, 2));
console.log(`Wrote ${logPath}`);
console.log('\n=== VERDICT ===');
console.log(failed === 0 ? 'PASS — identity keys, the inversion, every stellar-input path, the occurrence tier and the architecture tier behave as documented' : `FAIL — ${failed} checks failed`);
process.exit(failed === 0 ? 0 : 1);
