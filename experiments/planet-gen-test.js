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
// systems — and the insolation/temperature/band tier (0.5.1-5, §4.6):
// the six-body Solar temperature table driven through the one `thermal` pass
// (Mercury 433 … Ceres 163 K), the Earth Teq identity (254.6 K), the
// band-refinement mass tiers, the runaway/thermostat rules with the
// clamp(1 − S, 0, 1) anchor, the tidal-locking pins (TRAPPIST-1/Proxima locked,
// Sun not), the HZ/terran flags and the HZ-edges identity — and the belt and
// moon tier (0.5.1-6, §4.7/§4.8): the snow line, the presence law
// (0.90·fade − 0.35·nGiants), the bit-equal belt chain over main-sequence,
// giant and wd stars, the Solar belt ranges (inner 1.485–2.565 AU, outer
// 14–32 AU), the wd's single forced compact ring, the scouring that empties a
// belt, the stipple seed and law, and floor(moonMax·u³) — and the record tier
// (0.5.1-7, §4.9/§4.10/§4.11): the byte-identical system record, the star block
// as `stellarInputs`' own output with its four edges, every planet row as the
// tiers' arithmetic (the §4.3 mass–radius law and its ρ anchors, the repair's
// Hill conversion, Kepler III, one `thermal` pass, the moon count on the
// rotation channel), the §4.12 invariants read off the record, the summary
// equal to the full tier, the §4.11 designation writers, and the two budgets.
//
// Output: experiments/logs/planet-gen.json

'use strict';

const path = require('path');
const logFile = require('./log-file.js');

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
		const component = obj.type === 'HII' ? density.COMPONENT_THIN
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

// --- 7. Insolation, temperatures, band refinement, locking, HZ/terran
//     (plan §4.6, 0.5.1-5) ---------------------------------------------------
{
	// 7a. Earth Teq identity (plan §4.6 pin): L 1 L☉, Teff 5772 K, R★ 1 R☉,
	// a 1 AU, A 0.30 → Teq 254.6 K.  This is the §4.6 formula with the Sun's
	// own values, not a Monte-Carlo average. Distances are AU (the module's
	// unit) — passing metres scales Teq by sqrt(1 AU), so the arity is the pin.
	const rock = planets.BULK_INDEX.rock, ice = planets.BULK_INDEX.ice;
	const superBi = planets.BULK_INDEX.super;
	const sunStar = { mass: 1, lum: 1, teff: planets.TEFF_SUN, rStar: 1, age: 5, metal: 0.02, state: 'ms', spectralClass: 'G' };
	// One record per kept result: `thermal` mutates its out record, so two calls
	// into one record alias each other (which is the point of the out-param
	// style — the caller owns the storage).
	const th = () => planets.createThermal();
	const thermal = th();
	const Teq_Earth = planets.equilibriumTemp(planets.TEFF_SUN, 1, 1, 0.30);
	check('Teq identity: Sun (1 L☉, 5772 K, 1 R☉, 1 AU, A 0.30) → 254.6 ± 0.5 K',
		Math.abs(Teq_Earth - 254.6) < 0.5, Teq_Earth);

	// 7b. The six-body Solar table (plan §4.2/§4.6), driven through the one
	// `thermal` pass rather than through hand-assembled primitive calls: the
	// table then pins the pass the generator actually runs (band → display →
	// runaway → albedo → Teq → Tsurf), including Venus's runaway albedo 0.70.
	// The published values are the plan's, rounded to whole Kelvin.
	const solarBodies = [
		{ name: 'Mercury', a: 0.387, mass: 0.055, bulk: 'rock',
			wantDisplay: 'BARREN', wantBand: 1, wantTeq: 433, wantTsurf: 433, tol: 8 },
		{ name: 'Venus',   a: 0.723, mass: 0.815, bulk: 'rock',
			wantDisplay: 'DESERT', wantBand: 1, wantTeq: 242, wantTsurf: 742, tol: 8,
			albedo: planets.RUNAWAY_ALBEDO, runaway: true },
		{ name: 'Earth',   a: 1.000, mass: 1.000, bulk: 'rock',
			wantDisplay: 'TERRAN', wantBand: 2, wantTeq: 255, wantTsurf: 288, tol: 0.5,
			albedo: 0.30, terran: true },
		{ name: 'Mars',    a: 1.524, mass: 0.107, bulk: 'rock',
			wantDisplay: 'DESERT', wantBand: 2, wantTeq: 208, wantTsurf: 216, tol: 8, albedo: 0.28 },
		{ name: 'Moon',    a: 1.000, mass: 0.012, bulk: 'rock',
			wantDisplay: 'BARREN', wantBand: 2, wantTeq: 270, wantTsurf: 270, tol: 8, albedo: 0.12 },
		{ name: 'Ceres',   a: 2.766, mass: 0.00016, bulk: 'dwarf',
			wantDisplay: 'DWARF',  wantBand: 3, wantTeq: 163, wantTsurf: 163, tol: 8, albedo: 0.10 },
	];
	let solarOk = true;
	const solarDetails = [];
	for (const b of solarBodies) {
		const bi = planets.BULK_INDEX[b.bulk];
		const t = planets.thermal(sunStar, b.a, bi, b.mass, thermal);
		const displayName = planets.DISPLAY_TYPES[t.displayId].name;
		const bodyOk = displayName === b.wantDisplay
			&& t.band === b.wantBand
			&& Math.abs(t.insol - planets.insolation(1, b.a)) < 1e-12
			&& (b.albedo === undefined || Math.abs(t.albedo - b.albedo) < 1e-12)
			&& (b.runaway === undefined || t.runaway === b.runaway)
			&& (b.terran === undefined || t.terran === b.terran)
			&& Math.abs(t.teq - b.wantTeq) <= b.tol
			&& Math.abs(t.tsurf - b.wantTsurf) <= b.tol;
		if (!bodyOk) {
			solarOk = false;
			solarDetails.push({
				name: b.name, display: displayName, band: t.band, albedo: t.albedo,
				teq: +t.teq.toFixed(1), tsurf: +t.tsurf.toFixed(1), runaway: t.runaway,
				wantDisplay: b.wantDisplay, wantBand: b.wantBand,
				wantTeq: b.wantTeq, wantTsurf: b.wantTsurf,
			});
		}
	}
	check('six-body Solar table through `thermal` (Mercury 433 … Ceres 163, plan §4.2/§4.6)',
		solarOk, solarDetails.length ? solarDetails : 'all six match');

	// 7c. Display-type refinement mass tiers in band 2 (plan §4.6 table).
	// Rock/ice/super split by mass: < 0.02 → BARREN, < 0.3 → DESERT,
	// ≥ 0.3 → TERRAN (rock/ice) or SUPER_EARTH (super).  Gas types and
	// dwarf are constant across all bands.
	const dtNames = (id) => planets.DISPLAY_TYPES[id].name;
	const band2M = [
		[rock, 0.01,  'BARREN'], [ice, 0.01,  'BARREN'],
		[rock, 0.10,  'DESERT'], [ice, 0.10,  'DESERT'],
		[rock, 1.00,  'TERRAN'], [ice, 1.00,  'TERRAN'],
		[superBi, 1.00, 'SUPER_EARTH'],
		[planets.BULK_INDEX.gas, 318, 'GAS_GIANT'],
		[planets.BULK_INDEX.mini, 10, 'MINI_NEPTUNE'],
		[planets.BULK_INDEX.icegiant, 17, 'ICE_GIANT'],
		[planets.BULK_INDEX.dwarf, 0.01, 'DWARF'],
	];
	let dtRefineOk = true;
	const dtDetails = [];
	for (const [bi, m, want] of band2M) {
		const got = dtNames(planets.planetDisplay(bi, m, 2));
		if (got !== want) { dtRefineOk = false; dtDetails.push({ bi, m, got, want }); }
	}
	check('band 2 refinement: mass tiers for rock/ice/super and the constant gas/dwarf types',
		dtRefineOk, dtDetails.length ? dtDetails : dtNames);

	// 7d. Runaway greenhouse (plan §4.2): rock ≥ 0.3 M⊕ in band 1 gets
	// DESERT + runaway + albedo 0.70, ΔT 500 K.  Below 0.3 M⊕ no runaway.
	const runawayOk = planets.runawayGreenhouse(rock, 0.5, 1)
		&& planets.runawayGreenhouse(ice, 0.5, 1)
		&& planets.runawayGreenhouse(superBi, 0.5, 1)
		&& !planets.runawayGreenhouse(rock, 0.1, 1)
		&& !planets.runawayGreenhouse(rock, 0.5, 2)  // not in band 2
		&& !planets.runawayGreenhouse(rock, 0.5, 0); // not in band 1
	check('runaway greenhouse: ≥ 0.3 M⊕ rock/ice/super in band 1 only', runawayOk);

	// 7e. Thermostat monotonicity band (plan §4.12, numbers from §4.6):
	// across band 2, Tsurf holds 261–290 K for every TERRAN and 264–295 K for
	// every SUPER_EARTH whatever the insolation — the thermostat at work, and
	// the tighter window is what makes the clamp(1 − S, 0, 1) in the formula
	// visible: without it the inner edge would read 288 K for TERRAN (30.25 K
	// of greenhouse instead of the 33 K anchor). Sub-ATM_RETAIN_M worlds in the
	// same band have nothing regulating them and fall monotonically.
	const sunStar7 = { mass: 1, lum: 1, teff: planets.TEFF_SUN, rStar: 1, age: 5 };
	const SSteps = [1.05, 0.90, 0.70, 0.55, 0.40, 0.35];
	let thermoOk = true, thermoDetails = [];
	let terrRange = [Infinity, -Infinity], seRange = [Infinity, -Infinity];
	for (const S of SSteps) {
		const aAU = Math.sqrt(1 / S);
		const tTerr = planets.thermal(sunStar7, aAU, rock, 1, th());       // TERRAN
		const tSE = planets.thermal(sunStar7, aAU, superBi, 5, th());      // SUPER_EARTH
		if (tTerr.displayId !== planets.DISPLAY_INDEX.TERRAN
			|| tSE.displayId !== planets.DISPLAY_INDEX.SUPER_EARTH) {
			thermoOk = false;
			thermoDetails.push({ S, terr: tTerr.displayId, se: tSE.displayId });
		}
		terrRange[0] = Math.min(terrRange[0], tTerr.tsurf);
		terrRange[1] = Math.max(terrRange[1], tTerr.tsurf);
		seRange[0] = Math.min(seRange[0], tSE.tsurf);
		seRange[1] = Math.max(seRange[1], tSE.tsurf);
		// §4.12's window, exactly: the band is habitable for a world with an
		// atmosphere, and the spread across it is a few tens of kelvin.
		if (tTerr.tsurf < 260 || tTerr.tsurf > 296 || tSE.tsurf < 260 || tSE.tsurf > 296) {
			thermoOk = false;
			thermoDetails.push({ S, terr: +tTerr.tsurf.toFixed(1), se: +tSE.tsurf.toFixed(1) });
		}
	}
	// Both extremes sit at the band's edges, so the sweep's range must equal the
	// formula at HZ_S_IN and HZ_S_OUT — the plan's "261–290" and "264–295" to
	// the tenth of a kelvin, not a rounded coincidence.
	const edgeTsurf = (bulk, mass, S) =>
		planets.thermal(sunStar7, Math.sqrt(1 / S), bulk, mass, thermal).tsurf;
	const terrEdge = [edgeTsurf(rock, 1, planets.HZ_S_IN), edgeTsurf(rock, 1, planets.HZ_S_OUT)];
	const seEdge = [edgeTsurf(superBi, 5, planets.HZ_S_IN), edgeTsurf(superBi, 5, planets.HZ_S_OUT)];
	const edgesOk = Math.abs(terrRange[1] - terrEdge[0]) < 1e-9
		&& Math.abs(terrRange[0] - terrEdge[1]) < 1e-9
		&& Math.abs(seRange[1] - seEdge[0]) < 1e-9
		&& Math.abs(seRange[0] - seEdge[1]) < 1e-9;
	// Mars analogs in band 2: MONOTONICALLY falling with distance.
	let marsMono = true;
	let prevT = Infinity;
	for (const S of [0.90, 0.70, 0.55, 0.434, 0.35]) {
		const t = planets.thermal(sunStar7, Math.sqrt(1 / S), rock, 0.107, thermal);
		if (t.tsurf >= prevT) marsMono = false;
		prevT = t.tsurf;
	}
	// The band 3 case: Mars drops into ICE below S = 0.35.
	const marsT3 = planets.thermal(sunStar7, Math.sqrt(1 / 0.30), rock, 0.107, thermal);
	const marsTs3 = marsT3.tsurf;
	marsMono = marsMono && marsT3.displayId === planets.DISPLAY_INDEX.ICE && marsTs3 < prevT;
	check('thermostat: across band 2 TERRAN holds 260.8–290.7 K and SUPER_EARTH 264.2–295.2 K, both extremes at the band edges; Mars analogs fall monotonically',
		thermoOk && edgesOk && marsMono, { range: thermoDetails, edgesOk, marsMono,
			terr: terrRange.map((x) => +x.toFixed(2)), se: seRange.map((x) => +x.toFixed(2)),
			marsBand3: +marsTs3.toFixed(1), marsBand2Outer: +prevT.toFixed(1) });

	// 7e2. The clamp itself (plan §4.2's `clamp(1 − S, 0, 1)`): ΔT is exactly
	// the 33 K anchor from S = 1.0 out to the HZ inner edge, and the 65 K
	// maximum from S = 0.418 2 inwards (where 33 + 55·(1 − S) reaches 65). The
	// unclamped formula would read 30.25 K at S = 1.05.
	const dTerr = (S) => {
		const t = planets.thermal(sunStar7, Math.sqrt(1 / S), rock, 1, thermal);
		return t.tsurf - t.teq;
	};
	check('thermostat clamp: ΔT = 33 K at S 1.0 and 1.05, ΔT = 65 K at S 0.35 and at the 0.418 2 knee',
		Math.abs(dTerr(1.0) - 33) < 0.01 && Math.abs(dTerr(1.05) - 33) < 0.01
		&& Math.abs(dTerr(0.35) - 65) < 0.01 && Math.abs(dTerr(0.4182) - 65) < 0.05
		&& dTerr(0.50) > 33 && dTerr(0.50) < 65,
		{ dT: [1.05, 1.0, 0.7, 0.5, 0.4182, 0.35].map((S) => +dTerr(S).toFixed(3)) });

	// 7f. Tidal locking (plan §4.6): the lock radius scales as
	// sqrt(M★), and the published real cases reproduce.
	const lockCases = [
		{ name: 'TRAPPIST-1', M: 0.090, L: 0.0039, aHzIn: 0.061, aHzOut: 0.106,
			lock: 0.090, wantHzLocked: true },
		{ name: 'Proxima Cen', M: 0.122, L: 0.0079, aHzIn: 0.087, aHzOut: 0.150,
			lock: 0.105, wantHzLocked: true },
		{ name: 'Sun', M: 1.000, L: 1.000, aHzIn: 0.976, aHzOut: 1.690,
			lock: 0.300, wantHzLocked: false },
		{ name: '0.30 Msun', M: 0.300, L: 0.063, aHzIn: 0.244, aHzOut: 0.423,
			lock: 0.164, wantHzLocked: false },
	];
	let lockOk = true;
	const lockDetails = [];
	for (const lc of lockCases) {
		const lockR = planets.A_LOCK * Math.sqrt(lc.M);
		const hzIn = planets.hzInnerAU(lc.L);
		const hzOut = planets.hzOuterAU(lc.L);
		const lockRadOk = Math.abs(lockR - lc.lock) < 0.001;
		const hzLocked = lockR >= hzIn;
		const hzOk = Math.abs(hzIn - lc.aHzIn) < 0.002 && Math.abs(hzOut - lc.aHzOut) < 0.002;
		if (!lockRadOk || hzLocked !== lc.wantHzLocked || !hzOk) {
			lockOk = false;
			lockDetails.push({ name: lc.name, lockR: +lockR.toFixed(3), hzLocked, hzIn: +hzIn.toFixed(3) });
		}
	}
	check('tidal locking: lock radius scales as sqrt(M★); TRAPPIST-1/Proxima HZ locked, Sun not',
		lockOk, lockDetails.length ? lockDetails : 'all four match');

	// 7g. Habitable-zone and terran flags (plan §4.6), through the same
	// `thermal` pass the generator runs: inHZ = band 2, terran requires
	// TERRAN/SUPER_EARTH + 0.5–5 M⊕ + age > 0.5 Gyr + free rotation. There is
	// no runaway test in the flag — runaway is band 1 and inHZ is band 2 — so
	// Venus reads not-terran through its band, not through a second condition.
	const tEarth = planets.thermal(sunStar, 1, rock, 1, th());
	const tMars = planets.thermal(sunStar, 1.524, rock, 0.107, th());
	const tVenus = planets.thermal(sunStar, 0.723, rock, 0.815, th());
	const tMoon = planets.thermal(sunStar, 1, rock, 0.012, th());
	const tCeres = planets.thermal(sunStar, 2.766, planets.BULK_INDEX.dwarf, 0.00016, th());
	const tMercury = planets.thermal(sunStar, 0.387, rock, 0.055, th());
	// A young world in the band: age is the only flag input that is not orbital.
	const tYoung = planets.thermal({ mass: 1, lum: 1, teff: planets.TEFF_SUN, rStar: 1, age: 0.4 }, 1, rock, 1, th());
	const tHeavy = planets.thermal(sunStar, 1, superBi, 6, th());
	check('HZ/terran flags: Earth is inHZ + terran; Mars/Venus/Moon/Ceres/Mercury are not terran',
		tEarth.inHZ && tEarth.terran
		&& !tMars.terran && !tVenus.terran && !tMoon.terran && !tCeres.terran
		&& !tMercury.terran && !tVenus.inHZ && tMars.inHZ && !tMars.locked,
		{ earth: { inHZ: tEarth.inHZ, terran: tEarth.terran },
			mars: { inHZ: tMars.inHZ, terran: tMars.terran, band: tMars.band },
			venus: { inHZ: tVenus.inHZ, runaway: tVenus.runaway, band: tVenus.band },
			moon: { terran: tMoon.terran }, ceres: { terran: tCeres.terran } });
	check('terran window: a 0.4 Gyr world and a 6 M⊕ super-Earth are in the band but not terran; a 5 M⊕ one is',
		!tYoung.terran && !tHeavy.terran
		&& planets.thermal(sunStar, 1, superBi, 5, thermal).terran
		&& planets.thermal(sunStar, 1, superBi, 0.45, thermal).terran === false,
		{ young: tYoung.terran, heavy: tHeavy.terran });

	// 7h. Tidally-locked HZ worlds: lockedHZ set, terran clear (TRAPPIST-1 e,
	// Proxima b analog) — the flag pair that keeps them searchable.
	// 0.08 and 0.10 AU: inside the two lock radii (0.090, 0.105) and inside the
	// two HZ inner edges (0.061, 0.087) — exactly the §4.6 table's cases.
	const tTrappist = planets.thermal({ mass: 0.09, lum: 0.0039, teff: 2560, rStar: 0.117, age: 7 }, 0.08, rock, 1, th());
	const tProxima = planets.thermal({ mass: 0.122, lum: 0.0079, teff: 3042, rStar: 0.15, age: 5 }, 0.10, rock, 1, th());
	check('locked HZ worlds: locked + lockedHZ set, terran clear (TRAPPIST-1 e, Proxima b analog)',
		tTrappist.inHZ && tTrappist.locked && tTrappist.lockedHZ && !tTrappist.terran
		&& tProxima.inHZ && tProxima.locked && tProxima.lockedHZ && !tProxima.terran,
		{ trappist: { band: tTrappist.band, locked: tTrappist.locked, lockedHZ: tTrappist.lockedHZ, terran: tTrappist.terran },
			proxima: { band: tProxima.band, locked: tProxima.locked, lockedHZ: tProxima.lockedHZ, terran: tProxima.terran } });

	// 7h2. Flags are pure in their inputs: the same call after a different one
	// returns the same record, because hzFlags writes every flag it reads.
	const first = JSON.stringify(planets.thermal(sunStar, 1, rock, 1, thermal));
	planets.thermal(sunStar, 0.02, planets.BULK_INDEX.gas, 3000, thermal);
	planets.thermal(sunStar, 30, planets.BULK_INDEX.dwarf, 0.0001, thermal);
	const again = JSON.stringify(planets.thermal(sunStar, 1, rock, 1, thermal));
	check('thermal is pure in (star, a, bulk, mass): the record has no stale fields',
		first === again, { first, again });

	// 7i. Planet band from insolation: the §4.6 boundaries.
	const bandTests = [
		[0.10, 3], [0.349, 3], [0.35, 2], [0.50, 2], [1.05, 2],
		[1.06, 1], [2.0, 1], [8.0, 1], [8.01, 0], [20.0, 0],
	];
	let bandOk = true;
	for (const [S, want] of bandTests) {
		if (planets.planetBand(S) !== want) bandOk = false;
	}
	check('planetBand: insolation → band index at the §4.6 boundaries', bandOk);

	// 7j. Band refinement full table (plan §4.6): the entire 10×4 grid for
	// rock/ice/super mass tiers plus the constant gas types.
	const fullTable = [
		// band 0: S > 8 — all rock/ice/super LAVA; dwarf LAVA in band 0
		{ bi: rock, m: 0.01, band: 0, want: 'LAVA' },
		{ bi: rock, m: 0.10, band: 0, want: 'LAVA' },
		{ bi: rock, m: 1.00, band: 0, want: 'LAVA' },
		{ bi: superBi, m: 1.00, band: 0, want: 'LAVA' },
		{ bi: planets.BULK_INDEX.mini, m: 10, band: 0, want: 'MINI_NEPTUNE' },
		{ bi: planets.BULK_INDEX.gas, m: 300, band: 0, want: 'GAS_GIANT' },
		{ bi: planets.BULK_INDEX.icegiant, m: 20, band: 0, want: 'ICE_GIANT' },
		{ bi: planets.BULK_INDEX.dwarf, m: 0.01, band: 0, want: 'LAVA' },
		// band 1: 1.05 < S ≤ 8 — airless worlds stay BARREN at any insolation
		// (the plan's table row A): nothing boils away from a body that has no
		// atmosphere, and LAVA above 8 is the molten-surface case.
		{ bi: rock, m: 0.01, band: 1, want: 'BARREN' },
		{ bi: rock, m: 0.10, band: 1, want: 'BARREN' },
		{ bi: rock, m: 0.50, band: 1, want: 'DESERT' },
		{ bi: superBi, m: 0.50, band: 1, want: 'DESERT' },
		{ bi: planets.BULK_INDEX.dwarf, m: 0.01, band: 1, want: 'DWARF' },
		// band 2: 0.35 ≤ S ≤ 1.05 — the habitable zone
		{ bi: rock, m: 0.01, band: 2, want: 'BARREN' },
		{ bi: rock, m: 0.10, band: 2, want: 'DESERT' },
		{ bi: rock, m: 1.00, band: 2, want: 'TERRAN' },
		{ bi: superBi, m: 1.00, band: 2, want: 'SUPER_EARTH' },
		{ bi: ice, m: 1.00, band: 2, want: 'TERRAN' },
		{ bi: planets.BULK_INDEX.mini, m: 10, band: 2, want: 'MINI_NEPTUNE' },
		{ bi: planets.BULK_INDEX.gas, m: 300, band: 2, want: 'GAS_GIANT' },
		{ bi: planets.BULK_INDEX.icegiant, m: 20, band: 2, want: 'ICE_GIANT' },
		{ bi: planets.BULK_INDEX.dwarf, m: 0.01, band: 2, want: 'DWARF' },
		// band 3: S < 0.35 — all ice
		{ bi: rock, m: 0.01, band: 3, want: 'ICE' },
		{ bi: rock, m: 0.10, band: 3, want: 'ICE' },
		{ bi: rock, m: 1.00, band: 3, want: 'ICE' },
		{ bi: superBi, m: 1.00, band: 3, want: 'ICE' },
		{ bi: planets.BULK_INDEX.dwarf, m: 0.01, band: 3, want: 'DWARF' },
	];
	let fullTblOk = true;
	const fullTblDetails = [];
	for (const t of fullTable) {
		const got = dtNames(planets.planetDisplay(t.bi, t.m, t.band));
		if (got !== t.want) {
			fullTblOk = false;
			fullTblDetails.push({ bi: t.bi, m: t.m, band: t.band, got, want: t.want });
		}
	}
	check('full band-refinement table: 27 entries across all 4 bands and all bulk/mass tiers',
		fullTblOk, fullTblDetails.length ? fullTblDetails : 'all 27 match');

	// 7k. The §4.12 thermostat boundary: at S = 1.0, TERRAN ΔT is exactly
	// TERRAN_DT_BASE (33 K, Earth's insolation), and at S = 0.35 the
	// thermostat saturates at TERRAN_DT_MAX (65 K).  These are the two ends
	// of the Walker thermostat (Walker, Hays & Kasting 1981).
	const teqInner = planets.equilibriumTemp(planets.TEFF_SUN, 1, Math.sqrt(1 / 1.0), 0.30);
	const tsurfInner = planets.surfaceTemp(teqInner, planets.DISPLAY_INDEX.TERRAN, 1.0, false);
	const teqOuter = planets.equilibriumTemp(planets.TEFF_SUN, 1, Math.sqrt(1 / 0.35), 0.30);
	const tsurfOuter = planets.surfaceTemp(teqOuter, planets.DISPLAY_INDEX.TERRAN, 0.35, false);
	check('thermostat endpoints: ΔT = 33 at S = 1.0 (Earth), ΔT = 65 at S = 0.35 (Walker 1981)',
		Math.abs((tsurfInner - teqInner) - 33) < 0.5
		&& Math.abs((tsurfOuter - teqOuter) - 65) < 0.5,
		{ dT_inner: +(tsurfInner - teqInner).toFixed(1), dT_outer: +(tsurfOuter - teqOuter).toFixed(1) });

	// 7l. The HZ edges are the band's edges (plan §4.6): `inHZ` and
	// `a_hz_in ≤ a ≤ a_hz_out` are the same statement, because the two use one
	// pair of insolation constants. Swept over luminosities and axes, the two
	// readings must agree everywhere — no rounding gap at either edge.
	let hzIdentity = true;
	for (let k = 0; k < 4000; k++) {
		const L = Math.pow(10, -3 + 4 * ((k * 7919) % 1000) / 1000);
		const lum = (k % 7 === 0) ? 1 : L;
		const u = (((k * 104729) % 997) + 0.5) / 997;
		const aAU = Math.pow(10, -2 + 3 * u);           // 0.01 … 10 AU
		const inHZ = planets.planetBand(planets.insolation(lum, aAU)) === 2;
		const inside = aAU >= planets.hzInnerAU(lum) && aAU <= planets.hzOuterAU(lum);
		if (inHZ !== inside) hzIdentity = false;
	}
	check('HZ identity: band 2 ⟺ a_hz_in ≤ a ≤ a_hz_out over 4 000 (L, a) pairs',
		hzIdentity && Math.abs(planets.hzInnerAU(1) - 0.976) < 0.002
		&& Math.abs(planets.hzOuterAU(1) - 1.690) < 0.002,
		{ hzInner: +planets.hzInnerAU(1).toFixed(3), hzOuter: +planets.hzOuterAU(1).toFixed(3) });

	// 7m. The albedo the pass uses (plan §4.2): the runaway override is the
	// display type's albedo replaced by RUNAWAY_ALBEDO, and the base values are
	// the table's. This is the one place the displayed type and the temperature
	// can disagree, so it is pinned explicitly.
	const albedoOk = Math.abs(planets.albedoFor(planets.DISPLAY_INDEX.DESERT, true) - planets.RUNAWAY_ALBEDO) < 1e-12
		&& Math.abs(planets.albedoFor(planets.DISPLAY_INDEX.DESERT, false) - 0.28) < 1e-12
		&& Math.abs(planets.albedoFor(planets.DISPLAY_INDEX.TERRAN, false) - 0.30) < 1e-12
		&& planets.albedoFor(planets.DISPLAY_INDEX.TERRAN, true) === planets.RUNAWAY_ALBEDO;
	check('albedoFor: runaway → 0.70 (Venus), otherwise the display type\'s own column', albedoOk,
		{ desertRunaway: planets.albedoFor(planets.DISPLAY_INDEX.DESERT, true) });

	// 7n. The hot-Jupiter flag (plan §4.6): gas and mini-Neptune above
	// S_HOT_JUPITER, never a display type — a rock at the same insolation is
	// LAVA-and-hot, not a hot Jupiter.
	const hjOk = planets.isHotJupiter(planets.BULK_INDEX.gas, 25)
		&& planets.isHotJupiter(planets.BULK_INDEX.mini, 21)
		&& !planets.isHotJupiter(planets.BULK_INDEX.gas, 19.9)
		&& !planets.isHotJupiter(rock, 25)
		&& !planets.isHotJupiter(planets.BULK_INDEX.icegiant, 25)
		&& planets.thermal(sunStar, 0.15, planets.BULK_INDEX.gas, 400, thermal).hotJupiter
		&& planets.thermal(sunStar, 0.15, rock, 1, thermal).band === 0;
	check('hot-Jupiter flag: gas/mini above S = 20 only (not ice giants, not rock)', hjOk);

	// 7o. The runaway/band invariant (plan §4.6): runaway is band 1 and inHZ is
	// band 2, so a runaway world is never in the HZ and the flags need no second
	// test. Pinned over 20 000 systems × their planets, so the two rules cannot
	// drift apart into overlapping bands.
	const archT = planets.createArchitecture();
	let invOk = true;
	for (let s = 0; s < 20000 && invOk; s++) {
		const seed = hash.pcgHash(s);
		const st = {
			mass: 0.2 + (s % 5) * 0.4, lum: 0.01 + (s % 13) * 0.3,
			teff: 3000 + (s % 9) * 700, rStar: 0.5 + (s % 4), age: 1 + (s % 11),
			metal: 0.02, state: 'ms', spectralClass: records.SPECTRAL_CLASSES[s % 10],
		};
		planets.architecture(seed, st, archT);
		for (let i = 0; i < archT.n; i++) {
			planets.thermal(st, archT.a[i], archT.bulk[i], archT.mass[i], thermal);
			if (thermal.runaway && thermal.inHZ) invOk = false;
			if (thermal.band !== (thermal.insol > 8 ? 0 : thermal.insol > planets.HZ_S_IN ? 1 : thermal.insol >= planets.HZ_S_OUT ? 2 : 3)) invOk = false;
		}
	}
	check('runaway ⟹ not inHZ over 20 000 systems, and every band follows from its own insolation',
		invOk);
}

// --- 8. Belts and the moon count (plan §4.7/§4.8, 0.5.1-6) -----------------
{
	// 8a. The snow line and the typical body (plan §4.7). 2.7 AU for the Sun is
	// the definition of A_SNOW_K; the Ceres analog's density is derived from its
	// own mass and radius, so the three authored numbers cannot drift.
	check('snow line: 2.7 AU at 1 L☉, sqrt(L) law (0.854 AU at 0.1 L☉)',
		Math.abs(planets.snowLineAU(1) - 2.7) < 1e-12
		&& Math.abs(planets.snowLineAU(0.1) - 2.7 * Math.sqrt(0.1)) < 1e-12,
		{ sun: planets.snowLineAU(1), faint: +planets.snowLineAU(0.1).toFixed(3) });
	const bodyRho = planets.BELT_BODY_MASS_KG
		/ ((4 / 3) * Math.PI * planets.BELT_BODY_R_M * planets.BELT_BODY_R_M * planets.BELT_BODY_R_M);
	check('typical body: the Ceres analog (R 470 km, M 9.4e20 kg, ρ 2161 kg/m³ derived, μ = G·M, albedo 0.09)',
		Math.abs(planets.BELT_BODY_R_M - 470e3) < 1
		&& Math.abs(planets.BELT_BODY_MASS_KG - 9.4e20) < 1e18
		&& Math.abs(bodyRho - 2161) < 0.5
		&& planets.BELT_BODY_RHO === bodyRho
		&& Math.abs(planets.BELT_BODY_MU - planets.G_SI * 9.4e20) < 1e5
		&& planets.BELT_BODY_ALBEDO === 0.09,
		{ rho: +bodyRho.toFixed(1), mu: planets.BELT_BODY_MU.toExponential(4) });

	// 8a-2. The scouring count (plan §4.7) is the three bulks §4.4's `f_Z`
	// scales — gas, ice giant, mini-Neptune — and nothing else: a rock or an ice
	// world inside the belt radius does not clear it, which is what makes "four
	// giants ⇒ no belt" a statement about the giant columns only.
	const scourArch = planets.createArchitecture();
	scourArch.n = 7;
	const scourBulks = [planets.BULK_INDEX.rock, planets.BULK_INDEX.ice,
		planets.BULK_INDEX.super, planets.BULK_INDEX.gas, planets.BULK_INDEX.mini,
		planets.BULK_INDEX.icegiant, planets.BULK_INDEX.dwarf];
	for (let i = 0; i < 7; i++) {
		scourArch.bulk[i] = scourBulks[i];
		scourArch.a[i] = 1 + i * 0.5;
		scourArch.mass[i] = 1;
	}
	check('the scouring count is gas + ice giant + mini-Neptune, never rock/ice/super/dwarf',
		planets.giantsInsideBelt(scourArch, 1.5) === 0
		&& planets.giantsInsideBelt(scourArch, 3.6) === 3
		&& planets.giantsInsideBelt(scourArch, 100) === 3,
		{ inside1p5: planets.giantsInsideBelt(scourArch, 1.5),
			inside3p6: planets.giantsInsideBelt(scourArch, 3.6),
			inside100: planets.giantsInsideBelt(scourArch, 100) });

	// 8b. The presence law (plan §4.7): P = clamp(0.90·fade(age) − 0.35·nGiants,
	// 0, 1) with fade = 0.25 + 0.75·exp(−age/1.5 Gyr).
	const fade0 = planets.debrisFade(0), fade5 = planets.debrisFade(5), fade20 = planets.debrisFade(20);
	const fadeOk = Math.abs(fade0 - 1) < 1e-12
		&& Math.abs(fade5 - 0.27678) < 1e-4
		&& fade20 > 0.25 && fade20 < 0.251
		&& fade0 > fade5 && fade5 > fade20;                      // monotone decline
	const presenceOk = Math.abs(planets.beltPresence(0, 0) - 0.90) < 1e-12
		&& planets.beltPresence(2, 0) > planets.beltPresence(2, 1)
		&& planets.beltPresence(2, 1) > planets.beltPresence(2, 2)
		&& planets.beltPresence(2, 3) === 0                      // 0.9·0.4 − 1.05 < 0
		&& planets.beltPresence(0, 0) <= 1 && planets.beltPresence(20, 9) === 0;
	check('presence: 0.90·fade − 0.35·nGiants clamped to [0, 1], monotone in age and in giants inside',
		fadeOk && presenceOk,
		{ fade: [+fade0.toFixed(4), +fade5.toFixed(4), +fade20.toFixed(4)],
			p: [0, 1, 2, 3].map((g) => +planets.beltPresence(2, g).toFixed(3)) });

	// 8c. The chain is the documented channels (plan §2.3): bit-equal to a
	// test-side reimplementation with literal channel numbers, over 500 systems
	// across a main-sequence star, a giant and a wd.
	const beltArch = planets.createArchitecture();
	const beltOut = planets.createBelts();
	const beltRef = planets.createBelts();
	function beltsReference(seed, star, arch, out) {
		out.count = 0;
		const aLo = planets.innerEdgeAU(star.rStar);
		const aHi = planets.outerEdgeAU(star.mass, star.state);
		if (aLo >= aHi) return out;
		const snow = planets.A_SNOW_K * Math.sqrt(star.lum);
		for (let k = 0; k <= 1; k++) {
			if (k === 1 && star.state === 'wd') break;
			const base = k === 0 ? 200 : 210;
			const k0 = k === 0 ? 0.55 : 0.35, k1 = k === 0 ? 0.40 : 0.45;
			const d0 = k === 0 ? 0.10 : 0.15, d1 = k === 0 ? 0.25 : 0.35;
			const m0 = k === 0 ? -4 : -2, m1 = k === 0 ? 2.5 : 2.0;
			const ceiling = k === 0 ? aHi * 0.35 : aHi;
			if (aLo >= ceiling) continue;
			const uAxis = hash.hash01At(seed, base + 1);
			const uWidth = hash.hash01At(seed, base + 2);
			const uMass = hash.hash01At(seed, base + 3);
			const ref = k === 0 ? snow : aHi;
			const capped = ref < ceiling ? ref : ceiling;
			let a = capped * (k0 + k1 * uAxis);
			if (a < aLo) a = aLo;
			else if (a > ceiling) a = ceiling;
			let giants = 0;
			for (let i = 0; i < arch.n; i++) {
				if (arch.a[i] >= a) break;
				const b = arch.bulk[i];
				if (b === planets.BULK_INDEX.gas || b === planets.BULK_INDEX.icegiant
					|| b === planets.BULK_INDEX.mini) giants++;
			}
			let p = planets.BELT_P_MAX * planets.debrisFade(star.age) - planets.BELT_SCOUR * giants;
			if (p < 0) p = 0; else if (p > 1) p = 1;
			if (star.state === 'wd') p = planets.BELT_WD_PRESENCE;
			if (hash.hash01At(seed, base) >= p) continue;
			const i = out.count;
			out.kind[i] = k;
			out.a[i] = a;
			out.dlnA[i] = d0 + d1 * uWidth;
			out.mass[i] = Math.pow(10, m0 + m1 * uMass);
			out.stippleSeed[i] = hash.hash4(seed, base + 4, planets.CH_STIPPLE_BASE, planets.STIPPLE_N);
			out.count = i + 1;
		}
		return out;
	}
	const beltStars = [
		{ mass: 1, lum: 1, teff: planets.TEFF_SUN, rStar: 1, age: 2, metal: 0.02, state: 'ms', spectralClass: 'G' },
		{ mass: 1.2, lum: 1200, teff: 3600, rStar: 90, age: 11, metal: 0.035, state: 'giant', spectralClass: 'RG' },
		{ mass: 0.6, lum: 0.001, teff: 9000, rStar: 0.013, age: 6, metal: 0.02, state: 'wd', spectralClass: 'WD' },
	];
	let beltChainOk = true, beltDetails = [];
	for (let s = 0; s < 500; s++) {
		const st = beltStars[s % beltStars.length];
		const seed = hash.hash4(0x7BE17, s, 3, st.state.length);
		planets.architecture(seed, st, beltArch);
		planets.belts(seed, st, beltArch, beltOut);
		beltsReference(seed, st, beltArch, beltRef);
		for (let i = 0; i < Math.max(beltOut.count, beltRef.count); i++) {
			if (beltOut.kind[i] !== beltRef.kind[i] || beltOut.a[i] !== beltRef.a[i]
				|| beltOut.dlnA[i] !== beltRef.dlnA[i] || beltOut.mass[i] !== beltRef.mass[i]
				|| beltOut.stippleSeed[i] !== beltRef.stippleSeed[i]) {
				beltChainOk = false;
				beltDetails.push({ s, i, got: beltOut.a[i], want: beltRef.a[i] });
			}
		}
	}
	check('belt chain: bit-equal to a reimplementation over 500 systems (500 main-sequence, giant and wd draws)',
		beltChainOk, beltDetails.length ? beltDetails.slice(0, 3) : 'all equal');

	// 8d. Purity and determinism: same (seed, star) twice is byte-identical, a
	// different seed differs, and the record carries no state across calls.
	planets.belts(0x1234, beltStars[0], beltArch, beltOut);
	const beltFirst = beltOut.count + '|' + Array.from(beltOut.a).join(',') + '|'
		+ Array.from(beltOut.mass).join(',') + '|' + Array.from(beltOut.stippleSeed).join(',');
	planets.belts(0x1234, beltStars[1], beltArch, beltOut);        // a giant pass in between
	planets.belts(0x1234, beltStars[0], beltArch, beltOut);
	const beltSecond = beltOut.count + '|' + Array.from(beltOut.a).join(',') + '|'
		+ Array.from(beltOut.mass).join(',') + '|' + Array.from(beltOut.stippleSeed).join(',');
	planets.belts(0x1235, beltStars[0], beltArch, beltOut);
	const beltThird = beltOut.count + '|' + Array.from(beltOut.a).join(',');
	check('belts are pure in (seed, star, arch): repeat calls identical, another seed differs',
		beltFirst === beltSecond && beltThird !== beltFirst);

	// 8e. The Solar-System ranges of plan §4.7, over 20 000 Sun-like draws at
	// 2 Gyr: the asteroid analog inside the snow line's 0.55–0.95 span
	// (1.485–2.565 AU), the Kuiper analog in the disc edge's 0.35–0.80 span
	// (14–32 AU), and the masses inside the brackets that span produces.
	const sunBelt = beltStars[0];
	const innerA = [Infinity, -Infinity], outerA = [Infinity, -Infinity];
	const innerM = [Infinity, -Infinity], outerM = [Infinity, -Infinity];
	let counts = [0, 0, 0], orderViolations = 0, twoBelt = 0;
	let innerPresent = 0, outerPresent = 0;
	const innerDln = [Infinity, -Infinity];
	for (let s = 0; s < 20000; s++) {
		const seed = hash.pcgHash(s);
		planets.architecture(seed, sunBelt, beltArch);
		planets.belts(seed, sunBelt, beltArch, beltOut);
		counts[beltOut.count]++;
		for (let i = 0; i < beltOut.count; i++) {
			if (beltOut.kind[i] === 0) {
				innerPresent++;
				innerA[0] = Math.min(innerA[0], beltOut.a[i]); innerA[1] = Math.max(innerA[1], beltOut.a[i]);
				innerM[0] = Math.min(innerM[0], beltOut.mass[i]); innerM[1] = Math.max(innerM[1], beltOut.mass[i]);
				innerDln[0] = Math.min(innerDln[0], beltOut.dlnA[i]); innerDln[1] = Math.max(innerDln[1], beltOut.dlnA[i]);
			} else {
				outerPresent++;
				outerA[0] = Math.min(outerA[0], beltOut.a[i]); outerA[1] = Math.max(outerA[1], beltOut.a[i]);
				outerM[0] = Math.min(outerM[0], beltOut.mass[i]); outerM[1] = Math.max(outerM[1], beltOut.mass[i]);
			}
			if (i > 0 && beltOut.a[i] <= beltOut.a[i - 1]) orderViolations++;
			if (beltOut.mass[i] <= 0) orderViolations += 1000;    // no zero-mass placeholder
		}
		if (beltOut.count === 2) twoBelt++;
	}
	const rangeOk = innerA[0] >= 1.485 - 1e-9 && innerA[1] <= 2.565 + 1e-9
		&& outerA[0] >= 14 - 1e-9 && outerA[1] <= 32 + 1e-9
		&& innerDln[0] >= 0.10 && innerDln[1] <= 0.35
		&& innerM[0] >= 1e-4 - 1e-15 && innerM[1] <= Math.pow(10, -1.5) + 1e-15
		&& outerM[0] >= 1e-2 - 1e-15 && outerM[1] <= 1 + 1e-15;
	check('Sun-like belts: inner 1.485–2.565 AU (1e-4 – 0.032 M⊕), outer 14–32 AU (1e-2 – 1 M⊕), ascending, never empty',
		rangeOk && orderViolations === 0 && counts[0] > 0 && counts[1] > 0 && twoBelt > 0,
		{ counts, orderViolations, innerA: innerA.map((x) => +x.toFixed(3)),
			outerA: outerA.map((x) => +x.toFixed(1)),
			innerM: innerM.map((x) => +x.toExponential(2)), outerM: outerM.map((x) => +x.toExponential(2)),
			inner: innerPresent / 20000, outer: outerPresent / 20000 });

	// 8f. The scouring is what empties a belt (plan §4.7): with four gas giants
	// inside the belt radius the presence draw cannot pass, and the emergent rate
	// over 2 000 draws is exactly zero — measured on a synthetic architecture so
	// the pin does not depend on how often a real system draws four giants.
	const scoured = planets.createArchitecture();
	scoured.n = 4; scoured.aOut = 40;
	for (let i = 0; i < 4; i++) {
		scoured.slot[i] = i; scoured.bulk[i] = planets.BULK_INDEX.gas;
		scoured.mass[i] = 300; scoured.a[i] = 0.5 + i;
	}
	const empty = planets.createArchitecture();
	empty.n = 0; empty.aOut = 40;
	let presentClean = 0, presentScoured = 0;
	for (let s = 0; s < 2000; s++) {
		const seed = hash.pcgHash(s + 90000);
		planets.belts(seed, sunBelt, empty, beltOut);
		if (beltOut.count > 0 && beltOut.kind[0] === 0) presentClean++;
		planets.belts(seed, sunBelt, scoured, beltOut);
		if (beltOut.count > 0) presentScoured++;
	}
	// The unscoured inner rate is 0.90·fade(2) = 0.403; each giant inside takes
	// 0.35 off it, so four of them cannot leave a belt however the draw falls.
	check('scouring: four giants inside the inner belt ⇒ no belt at all (2 000 draws), unscoured inner rate ≈ 0.40',
		presentScoured === 0 && presentClean > 700 && presentClean < 900,
		{ presentClean, presentScoured, expected: +(planets.BELT_P_MAX * planets.debrisFade(2)).toFixed(3) });

	// 8g. The wd rule (plan §4.4/§4.7): one belt only, forced presence, inside
	// the 0.05 AU cut. And the giant case: the snow line falls outside the disc,
	// so the inner belt is capped below the outer belt and the ordering survives.
	const wdBelt = beltStars[2], giantBelt = beltStars[1];
	let wdOk = true, wdPresent = 0, wdAMax = -Infinity, wdAMin = Infinity;
	let giantOrderOk = true, giantInner = Infinity, giantOuter = -Infinity;
	for (let s = 0; s < 5000; s++) {
		const seed = hash.pcgHash(s + 4242);
		planets.architecture(seed, wdBelt, beltArch);
		planets.belts(seed, wdBelt, beltArch, beltOut);
		if (beltOut.count > 1) wdOk = false;                      // never an outer belt
		for (let i = 0; i < beltOut.count; i++) {
			wdPresent++;
			if (beltOut.kind[i] !== 0) wdOk = false;
			wdAMax = Math.max(wdAMax, beltOut.a[i]); wdAMin = Math.min(wdAMin, beltOut.a[i]);
			if (beltOut.a[i] < 0.012 || beltOut.a[i] > 0.05) wdOk = false;
		}
		planets.architecture(seed, giantBelt, beltArch);
		planets.belts(seed, giantBelt, beltArch, beltOut);
		for (let i = 0; i < beltOut.count; i++) {
			if (i > 0 && beltOut.a[i] <= beltOut.a[i - 1]) giantOrderOk = false;
			if (beltOut.kind[i] === 0) giantInner = Math.min(giantInner, beltOut.a[i]);
			else giantOuter = Math.max(giantOuter, beltOut.a[i]);
		}
	}
	check('wd belts: exactly one, forced presence (0.80), all inside [0.012, 0.05] AU',
		wdOk && Math.abs(wdPresent / 5000 - 0.8) < 0.02,
		{ rate: wdPresent / 5000, a: [+wdAMin.toFixed(4), +wdAMax.toFixed(4)] });
	check('giant belts: the capped snow line keeps the inner belt strictly inside the outer belt',
		giantOrderOk && giantInner < giantOuter && giantInner < 0.35 * 40 * Math.sqrt(giantBelt.mass),
		{ inner: +giantInner.toFixed(3), outer: +giantOuter.toFixed(3) });

	// 8h. The stipple (plan §4.7/§6.2): one seed per belt, different seeds for
	// the two belts and different systems, STIPPLE_N dots whose angles cover the
	// circle and whose radii fill the belt's own ±Δln a — the drawn belt is as
	// thick as the record says.
	const stAngles = new Float64Array(planets.STIPPLE_N);
	const stRadii = new Float64Array(planets.STIPPLE_N);
	const stAnglesRef = new Float64Array(planets.STIPPLE_N);
	const seedA = planets.beltStippleSeed(0x1234, planets.CH_BELT_INNER);
	const seedB = planets.beltStippleSeed(0x1234, planets.CH_BELT_OUTER);
	const seedC = planets.beltStippleSeed(0x9999, planets.CH_BELT_INNER);
	planets.fillStipple(seedA, 2.0, 0.2, stAngles, stRadii);
	planets.fillStipple(seedA, 2.0, 0.2, stAnglesRef, new Float64Array(planets.STIPPLE_N));
	let stAngleMin = Infinity, stAngleMax = -Infinity;
	let stRatioMin = Infinity, stRatioMax = -Infinity;
	for (let j = 0; j < planets.STIPPLE_N; j++) {
		stAngleMin = Math.min(stAngleMin, stAngles[j]);
		stAngleMax = Math.max(stAngleMax, stAngles[j]);
		stRatioMin = Math.min(stRatioMin, stRadii[j] / 2.0);
		stRatioMax = Math.max(stRatioMax, stRadii[j] / 2.0);
	}
	let stBytesOk = true;
	for (let j = 0; j < planets.STIPPLE_N; j++) if (stAngles[j] !== stAnglesRef[j]) stBytesOk = false;
	check('stipple: STIPPLE_N dots, angles in [0, 2π), radii log-uniform inside exp(±Δln a), repeatable',
		seedA !== seedB && seedA !== seedC && stBytesOk
		&& stAngleMin >= 0 && stAngleMax < Math.PI * 2
		&& stRatioMin >= Math.exp(-0.2) - 1e-9 && stRatioMax <= Math.exp(0.2) + 1e-9
		&& stAngleMax - stAngleMin > 6.0 && stRatioMin < 0.9 && stRatioMax > 1.1,
		{ angle: [+stAngleMin.toFixed(3), +stAngleMax.toFixed(3)],
			ratio: [+stRatioMin.toFixed(4), +stRatioMax.toFixed(4)] });

	// 8i. The §4.8 moon count: a count, not a system — floor(moonMax·u³), so the
	// median is far below the maximum and a giant reaches its real scale.
	const moonsOk = planets.moonCount(planets.BULK_INDEX.gas, 1) === 80
		&& planets.moonCount(planets.BULK_INDEX.gas, 0.5) === 10
		&& planets.moonCount(planets.BULK_INDEX.rock, 1) === 1
		&& planets.moonCount(planets.BULK_INDEX.dwarf, 1) === 0
		&& planets.moonCount(planets.BULK_INDEX.icegiant, 0.9999) <= 30;
	let moonMono = true, prevMoons = -1;
	for (let j = 0; j <= 100; j++) {
		const m = planets.moonCount(planets.BULK_INDEX.gas, j / 100);
		if (m < prevMoons) moonMono = false;
		prevMoons = m;
	}
	check('moons: floor(moonMax·u³) — 80 at u = 1 for a gas giant, 10 at u = 0.5, 0 for a dwarf, monotone in u',
		moonsOk && moonMono);

	// 8j. Budget and allocation (plan §4.12 for generateSystem): the belt pass
	// and the stipple fill write into caller-owned arrays and allocate nothing —
	// a coarse heap delta over 200k belt passes, the same technique the encoder
	// and the architecture tier use. The stipple is costed separately: it runs
	// once when a system is opened (§6.5), not per star in a search.
	for (let s = 0; s < 1000; s++) {
		planets.architecture(hash.pcgHash(s), sunBelt, beltArch);
		planets.belts(hash.pcgHash(s), sunBelt, beltArch, beltOut);
	}
	const beltHeapBefore = process.memoryUsage().heapUsed;
	const beltT0 = performance.now();
	for (let s = 0; s < 200000; s++) {
		planets.architecture(hash.pcgHash(s), sunBelt, beltArch);
		planets.belts(hash.pcgHash(s), sunBelt, beltArch, beltOut);
	}
	const beltUs = (performance.now() - beltT0) * 1000 / 200000;
	const beltHeapDelta = process.memoryUsage().heapUsed - beltHeapBefore;
	planets.belts(0x1234, sunBelt, beltArch, beltOut);
	const stippleSeed = beltOut.count > 0 ? beltOut.stippleSeed[0] : seedA;
	const stippleT0 = performance.now();
	for (let s = 0; s < 20000; s++) {
		planets.fillStipple(stippleSeed, 2.0, 0.2, stAngles, stRadii);
	}
	const stippleUs = (performance.now() - stippleT0) * 1000 / 20000;
	check('belts allocate nothing per call (coarse heap delta < 2 MB over 200k passes)',
		beltHeapDelta < 2 * 1024 * 1024, { beltHeapDelta });
	check('architecture + belts stay inside the 20 µs per-system budget; one stipple fill is a frame-safe one-off',
		beltUs < 20 && stippleUs < 200,
		{ usPerSystem: +beltUs.toFixed(3), usPerStippleFill: +stippleUs.toFixed(3) });
}

// --- 9. The SystemRecord, generateSystem and the summary (0.5.1-7) ----------
// Plan §4.9/§4.10/§4.11: the record a pick resolves to, the one walk both tiers
// run, and the designations.
{
	// 9a. Determinism and statelessness: the same (ref, ctx) gives a
	// byte-identical record, a record that already held another system carries
	// nothing over, and the two keyless blocks fall back to their positional
	// identity.
	const record = planets.createSystemRecord();
	const record2 = planets.createSystemRecord();
	const cols = ['a', 'mass', 'radius', 'density', 'e', 'inc', 'peri', 'phase',
		'period', 'teq', 'tsurf', 'insolation', 'rHill', 'rotHours', 'moons',
		'bulk', 'displayType', 'flags'];
	// The live fields only: the tail of a fixed-capacity column is allowed to
	// hold the previous system's bytes, exactly as the architecture record does.
	function recordBytes(r) {
		const parts = [r.star.key, r.star.mass, r.star.lum, r.star.teff, r.star.rStar,
			r.star.age, r.star.metal, r.star.state, r.star.spectralClass, r.star.colorIndex,
			r.star.aHzIn, r.star.aHzOut, r.star.aSnow, r.star.aOut, r.star.nameLen,
			Array.from(r.star.name.subarray(0, r.star.nameLen)).join(','),
			r.counts.planets, r.counts.terranCount, r.counts.giantCount,
			r.belts.count, Array.from(r.belts.kind.subarray(0, r.belts.count)).join(','),
			Array.from(r.belts.a.subarray(0, r.belts.count)).join(','),
			Array.from(r.belts.dlnA.subarray(0, r.belts.count)).join(','),
			Array.from(r.belts.mass.subarray(0, r.belts.count)).join(','),
			Array.from(r.belts.stippleSeed.subarray(0, r.belts.count)).join(',')];
		for (const c of cols) {
			parts.push(c + '=' + Array.from(r.planets[c].subarray(0, r.counts.planets)).join(','));
		}
		return parts.join('|');
	}
	const fieldCtx = { model, field, name: 'Test Star' };
	const fieldRef = { kind: planets.BLOCK_FIELD, index: 7, key: starTypes.fieldStarSeed(model.seed, 7) >>> 0 };
	planets.generateSystem(fieldRef, fieldCtx, record);
	planets.generateSystem(fieldRef, fieldCtx, record2);
	const firstBytes = recordBytes(record);
	// A giant in between (a different star, a different system), then the field
	// star again into the record that already held it.
	const giantRef = { kind: planets.BLOCK_LANDMARK, index: 4,
		colorIndex: records.SPECTRAL_CLASSES.indexOf('K'), absMag: -0.05 };
	planets.generateSystem(giantRef, { model, name: 'Arcturus' }, record2);
	const giantBytes = recordBytes(record2);
	planets.generateSystem(fieldRef, fieldCtx, record2);
	check('two calls with the same (ref, ctx) give a byte-identical system record',
		firstBytes === recordBytes(record2) && firstBytes !== giantBytes
		&& record.star.key === (fieldRef.key >>> 0),
		{ key: record.star.key, planets: record.counts.planets, belts: record.belts.count });

	const landmarkRef = { kind: planets.BLOCK_LANDMARK, index: 0,
		colorIndex: records.SPECTRAL_CLASSES.indexOf('G'), absMag: landmarks.SUN_ABS_MAG };
	const sunRec = planets.createSystemRecord();
	planets.generateSystem(landmarkRef, { model, name: 'Sun' }, sunRec);
	check('a keyless landmark ref keys off landmarkKey(index) — the §2.2 identity, not slot 0',
		sunRec.star.key === planets.landmarkKey(0)
		&& planets.systemSeed(sunRec.star.key, model.seed, planets.BLOCK_LANDMARK) !== 0,
		sunRec.star.key);

	// 9b. The star block is the input tier's own output, and its four edges are
	// the four helpers — Earth's star puts them at 0.976 / 1.690 / 2.7 / 40.
	const sun = planets.createStellarInputs();
	planets.stellarInputs(landmarkRef, { model }, sun);
	check('the star block equals stellarInputs\' record; the four edges are its helpers',
		sunRec.star.mass === sun.mass && sunRec.star.lum === sun.lum
		&& sunRec.star.teff === sun.teff && sunRec.star.rStar === sun.rStar
		&& sunRec.star.age === sun.age && sunRec.star.metal === sun.metal
		&& sunRec.star.state === sun.state && sunRec.star.spectralClass === sun.spectralClass
		&& sunRec.star.colorIndex === sun.colorIndex
		&& sunRec.star.aHzIn === planets.hzInnerAU(sun.lum)
		&& sunRec.star.aHzOut === planets.hzOuterAU(sun.lum)
		&& sunRec.star.aSnow === planets.snowLineAU(sun.lum)
		&& sunRec.star.aOut === planets.outerEdgeAU(sun.mass, sun.state),
		{ key: sunRec.star.key, mass: sunRec.star.mass, aOut: sunRec.star.aOut });
	check('a Sun-like star: HZ 0.9759–1.6903 AU, snow 2.7 AU, a_out 40 AU',
		Math.abs(sunRec.star.aHzIn - 0.9759) < 0.001 && Math.abs(sunRec.star.aHzOut - 1.6903) < 0.001
		&& Math.abs(sunRec.star.aSnow - 2.7) < 1e-9 && Math.abs(sunRec.star.aOut - 40) < 0.01,
		{ hzIn: +sunRec.star.aHzIn.toFixed(4), hzOut: +sunRec.star.aHzOut.toFixed(4),
			snow: sunRec.star.aSnow, aOut: sunRec.star.aOut });
	check('the caller\'s name lands in the record as bytes, capped at 32',
		sunRec.star.nameLen === 3
		&& String.fromCharCode.apply(null, sunRec.star.name.subarray(0, 3)) === 'Sun'
		&& record.star.nameLen === 9
		&& String.fromCharCode.apply(null, record.star.name.subarray(0, 9)) === 'Test Star',
		{ landmark: sunRec.star.nameLen, field: record.star.nameLen });

	// 9b-2. §4.9's belt block: exactly the §4.7 record, plus the typical body as
	// two references to the §4.7 constants (every belt carries the same body, so
	// they are scalars on the block, not per-slot columns).
	check('the belt block is the §4.7 record plus the two typical-body constants',
		sunRec.belts.typicalBodyMu === planets.BELT_BODY_MU
		&& sunRec.belts.typicalBodyR === planets.BELT_BODY_R_M
		&& sunRec.belts.a.length === planets.MAX_BELTS
		&& sunRec.belts.stippleSeed.length === planets.MAX_BELTS
		&& sunRec.belts.count >= 0 && sunRec.belts.count <= planets.MAX_BELTS,
		{ mu: sunRec.belts.typicalBodyMu, r: sunRec.belts.typicalBodyR });

	// 9c. Every live planet row is the tiers' own arithmetic: §4.3's radius and
	// density law, the repair's Hill conversion, Kepler III, exactly one
	// `thermal` pass, and the moon count on the rotation channel.
	const star = planets.createStellarInputs();
	const arch = planets.createArchitecture();
	const th = planets.createThermal();
	let rows = 0, lawBad = 0, thermalBad = 0, flagsBad = 0, moonsBad = 0;
	for (let s = 0; s < 400; s++) {
		const idx = (s * 37) % fieldCount;
		const key = starTypes.fieldStarSeed(model.seed, idx) >>> 0;
		const ref = { kind: planets.BLOCK_FIELD, index: idx, key };
		planets.generateSystem(ref, { model, field }, record);
		planets.stellarInputs(ref, { model, field }, star);
		const seed = planets.systemSeed(key, model.seed, planets.BLOCK_FIELD);
		planets.architecture(seed, star, arch);
		for (let i = 0; i < record.counts.planets; i++) {
			rows++;
			const bulkIndex = record.planets.bulk[i];
			const b = planets.BULKS[bulkIndex];
			const aAU = record.planets.a[i];
			const mass = record.planets.mass[i];
			const radius = planets.radiusFor(bulkIndex, mass);
			if (record.planets.radius[i] !== radius
				|| record.planets.density[i] !== planets.planetDensity(mass, radius)
				|| record.planets.rHill[i] !== aAU * planets.hillRatio(mass, star.mass)
				|| record.planets.period[i] !== Math.sqrt(aAU * aAU * aAU / star.mass)
				|| arch.a[i] !== aAU || arch.bulk[i] !== bulkIndex
				|| mass < b.massMin || mass > b.massMax) lawBad++;
			planets.thermal(star, aAU, bulkIndex, mass, th);
			if (record.planets.teq[i] !== th.teq || record.planets.tsurf[i] !== th.tsurf
				|| record.planets.insolation[i] !== th.insol
				|| record.planets.displayType[i] !== th.displayId) thermalBad++;
			let flags = 0;
			if (th.locked) flags |= planets.FLAG_LOCKED;
			if (th.hotJupiter) flags |= planets.FLAG_HOT_JUPITER;
			if (th.terran) flags |= planets.FLAG_TERRAN;
			if (th.inHZ) flags |= planets.FLAG_IN_HZ;
			if (record.planets.flags[i] !== flags) flagsBad++;
			if (th.locked
				&& record.planets.rotHours[i] !== record.planets.period[i] * planets.HOURS_PER_YEAR) flagsBad++;
			const u = hash.hash01At(seed, planets.CH_SLOT_BASE + 8 * arch.slot[i] + planets.CH_ROT);
			if (record.planets.moons[i] !== planets.moonCount(bulkIndex, u)) moonsBad++;
			if (record.planets.moons[i] > b.moonsMax) moonsBad++;
		}
	}
	check('planet rows are the tiers\' own numbers (law, rHill, period, elements) over 400 systems',
		lawBad === 0 && rows > 300, { rows, lawBad });
	check('the thermal columns are exactly one thermal() pass; flags and the locked rot = P override follow it',
		thermalBad === 0 && flagsBad === 0, { thermalBad, flagsBad });
	check('the moon count is floor(moonMax·u³) on the architecture\'s own slot draw',
		moonsBad === 0, moonsBad);

	// 9c-2. §4.3's law at its anchors: R = Rref at M = Mref by construction, and
	// the density column reproduces the table's checks (rock is exact).
	const anchors = [
		['rock', 1, 1.00, 5514], ['ice', 1, 1.10, 4143], ['super', 5, 1.60, 6731],
		['mini', 10, 2.80, 2512], ['gas', 318, 11.20, 1248], ['icegiant', 17, 4.00, 1465],
	];
	let anchorBad = 0;
	const anchorRows = [];
	for (const [name, mass, wantR, wantRho] of anchors) {
		const bulkIndex = planets.BULK_INDEX[name];
		const radius = planets.radiusFor(bulkIndex, mass);
		const rho = planets.planetDensity(mass, radius);
		anchorRows.push([name, +radius.toFixed(4), +rho.toFixed(1)]);
		if (radius !== planets.BULKS[bulkIndex].radiusRef
			|| Math.abs(rho - wantRho) > 2) anchorBad++;
	}
	const dwarfKm = planets.radiusFor(planets.BULK_INDEX.dwarf, 0.0005) * planets.R_EARTH_M / 1000;
	check('the mass–radius law is Rref at Mref for every bulk, densities match §4.3',
		anchorBad === 0 && Math.abs(dwarfKm - 519) < 2,
		{ anchors: anchorRows, dwarfKm: +dwarfKm.toFixed(1) });
}

// --- 10. The summary tier, the invariants on the record, budgets ------------
{
	const record = planets.createSystemRecord();
	const summary = planets.createSystemSummary();
	const star = planets.createStellarInputs();

	function recordHistograms(r) {
		const bulk = new Uint8Array(planets.BULKS.length);
		const type = new Uint8Array(planets.DISPLAY_TYPES.length);
		for (let i = 0; i < r.counts.planets; i++) {
			bulk[r.planets.bulk[i]]++;
			type[r.planets.displayType[i]]++;
		}
		return { bulk, type };
	}

	// 10a. §4.12's structural list, read off the record: clearance, the disc
	// edge, the Hill spacing between consecutive pairs, ascending `a`, the mass
	// brackets, the HZ flag ⟺ the HZ edges, and the counts.
	const giantInside = (bulkIndex) => bulkIndex === planets.BULK_INDEX.gas
		|| bulkIndex === planets.BULK_INDEX.icegiant || bulkIndex === planets.BULK_INDEX.mini;
	let systems = 0, invariantBad = 0, hzBad = 0, countBad = 0, terranSeen = 0, giantSeen = 0;
	for (let s = 0; s < 5000; s++) {
		const idx = (s * 7919) % fieldCount;
		const key = starTypes.fieldStarSeed(model.seed, idx) >>> 0;
		planets.generateSystem({ kind: planets.BLOCK_FIELD, index: idx, key }, { model, field }, record);
		planets.stellarInputs({ kind: planets.BLOCK_FIELD, index: idx, key }, { model, field }, star);
		systems++;
		const n = record.counts.planets;
		const aLo = planets.innerEdgeAU(record.star.rStar);
		let terrans = 0, giants = 0;
		for (let i = 0; i < n; i++) {
			const aAU = record.planets.a[i];
			if (aAU < aLo * (1 - 1e-12) || aAU > record.star.aOut * (1 + 1e-12)) invariantBad++;
			if (i > 0 && aAU <= record.planets.a[i - 1]) invariantBad++;
			if (i > 0) {
				// A pushed survivor sits exactly on the requirement, so the
				// comparison carries the architecture pin's own tolerance.
				const rH = Math.cbrt((record.planets.mass[i - 1] + record.planets.mass[i])
					* planets.M_EARTH_SUN / (3 * record.star.mass))
					* (aAU + record.planets.a[i - 1]) / 2;
				if (aAU - record.planets.a[i - 1] < planets.K_HILL * rH * (1 - 1e-9)) invariantBad++;
			}
			const inHZ = aAU >= record.star.aHzIn && aAU <= record.star.aHzOut;
			if (((record.planets.flags[i] & planets.FLAG_IN_HZ) !== 0) !== inHZ) hzBad++;
			if ((record.planets.flags[i] & planets.FLAG_TERRAN) !== 0) terrans++;
			if (giantInside(record.planets.bulk[i])) giants++;
		}
		if (terrans !== record.counts.terranCount) countBad++;
		if (giants !== record.counts.giantCount) countBad++;
		if (record.belts.count > 2 || record.belts.count < 0) countBad++;
		terranSeen += terrans;
		giantSeen += giants;
	}
	check('record invariants over 5 000 systems: clearance, a_out, K_HILL spacing, ascending a',
		invariantBad === 0, { systems, invariantBad });
	check('inHZ ⟺ a ∈ [a_hz_in, a_hz_out] on every row, and the counts are the rows\' own',
		hzBad === 0 && countBad === 0 && terranSeen > 0 && giantSeen > 0,
		{ hzBad, countBad, terranSeen, giantSeen });

	// 10b. §4.12's identity: the summary is the full tier's histograms, terran
	// flag, belt count and all four extremes — over 2 000 systems, plus the
	// best-terran candidate satisfying its own |S − 1| rule. A planetless system
	// reports the empty sentinels, so no range predicate can match it (`max ≥ lo
	// && min ≤ hi` is false when `max = -Infinity` and `min = +Infinity`).
	function recordExtremes(r) {
		const e = { aMin: Infinity, aMax: -Infinity, massMin: Infinity, massMax: -Infinity,
			teqMin: Infinity, teqMax: -Infinity, tsurfMin: Infinity, tsurfMax: -Infinity };
		for (let i = 0; i < r.counts.planets; i++) {
			e.aMin = Math.min(e.aMin, r.planets.a[i]); e.aMax = Math.max(e.aMax, r.planets.a[i]);
			e.massMin = Math.min(e.massMin, r.planets.mass[i]); e.massMax = Math.max(e.massMax, r.planets.mass[i]);
			e.teqMin = Math.min(e.teqMin, r.planets.teq[i]); e.teqMax = Math.max(e.teqMax, r.planets.teq[i]);
			e.tsurfMin = Math.min(e.tsurfMin, r.planets.tsurf[i]); e.tsurfMax = Math.max(e.tsurfMax, r.planets.tsurf[i]);
		}
		return e;
	}
	let summaryBad = 0, bestBad = 0, compared = 0, bestSeen = 0, barrenSeen = 0;
	for (let s = 0; s < 2000; s++) {
		const idx = (s * 104729) % fieldCount;
		const key = starTypes.fieldStarSeed(model.seed, idx) >>> 0;
		const ref = { kind: planets.BLOCK_FIELD, index: idx, key };
		planets.generateSystem(ref, { model, field }, record);
		planets.systemSummary(ref, { model, field }, summary);
		compared++;
		const h = recordHistograms(record);
		let diff = summary.count !== record.counts.planets
			|| summary.terranCount !== record.counts.terranCount
			|| summary.beltCount !== record.belts.count;
		for (let k = 0; k < h.bulk.length && !diff; k++) if (summary.bulkHistogram[k] !== h.bulk[k]) diff++;
		for (let k = 0; k < h.type.length && !diff; k++) if (summary.typeHistogram[k] !== h.type[k]) diff++;
		const ext = recordExtremes(record);
		for (const k in ext) if (summary[k] !== ext[k]) diff++;
		if (record.counts.planets === 0) {
			barrenSeen++;
			if (summary.aMin !== Infinity || summary.aMax !== -Infinity
				|| summary.massMin !== Infinity || summary.massMax !== -Infinity
				|| summary.teqMin !== Infinity || summary.teqMax !== -Infinity
				|| summary.tsurfMin !== Infinity || summary.tsurfMax !== -Infinity) diff++;
		}
		if (diff) summaryBad++;
		// The named candidate: the terran row with the smallest |S − 1|, ties to
		// the inner one — the same rule the walk applies.
		let bestD = Infinity, bestI = -1;
		for (let i = 0; i < record.counts.planets; i++) {
			if ((record.planets.flags[i] & planets.FLAG_TERRAN) === 0) continue;
			const d = Math.abs(record.planets.insolation[i] - 1);
			if (d < bestD) { bestD = d; bestI = i; }
		}
		if (bestI >= 0) {
			bestSeen++;
			if (summary.bestTerranA !== record.planets.a[bestI]
				|| summary.bestTerranMass !== record.planets.mass[bestI]
				|| summary.bestTerranTsurf !== record.planets.tsurf[bestI]
				|| summary.bestTerranS !== record.planets.insolation[bestI]
				|| summary.bestTerranType !== record.planets.displayType[bestI]) bestBad++;
		}
	}
	check('the summary equals the full tier\'s histograms, terran flag, belt count and all four extremes (2 000 systems)',
		summaryBad === 0 && compared === 2000 && barrenSeen > 0, { compared, summaryBad, barrenSeen });
	check('bestTerran is the |S − 1| minimum among the terran rows, ties to the inner one',
		bestBad === 0 && bestSeen > 0, { bestSeen, bestBad });

	// 10c. The scratch records are not a channel between calls: a summary taken
	// before and after a full generation of a different star is unchanged.
	const refA = { kind: planets.BLOCK_FIELD, index: 3, key: starTypes.fieldStarSeed(model.seed, 3) >>> 0 };
	const refB = { kind: planets.BLOCK_FIELD, index: 900 % fieldCount, key: starTypes.fieldStarSeed(model.seed, 900 % fieldCount) >>> 0 };
	planets.systemSummary(refA, { model, field }, summary);
	const beforeKey = summary.count + '|' + summary.beltCount + '|' + summary.bestTerranS
		+ '|' + Array.from(summary.typeHistogram).join(',');
	planets.generateSystem(refB, { model, field }, record);
	planets.systemSummary(refA, { model, field }, summary);
	const afterKey = summary.count + '|' + summary.beltCount + '|' + summary.bestTerranS
		+ '|' + Array.from(summary.typeHistogram).join(',');
	check('summary and generator share module scratch without leaking between calls',
		beforeKey === afterKey, beforeKey === afterKey ? 'identical' : { beforeKey, afterKey });

	// 10d. Budgets and allocation (§4.12): the whole call under 20 µs, the
	// summary under 6 µs, no objects allocated. The stipple is not in either —
	// §6.5 hashes it once when a system is opened, never per star.
	function budgetLoop(calls, fn) {
		const t0 = performance.now();
		for (let s = 0; s < calls; s++) fn(s);
		return (performance.now() - t0) * 1000 / calls;
	}
	const budgetRef = { kind: planets.BLOCK_FIELD, index: 11, key: starTypes.fieldStarSeed(model.seed, 11) >>> 0 };
	const stepRef = (s) => {
		const idx = s % fieldCount;
		budgetRef.index = idx;
		budgetRef.key = starTypes.fieldStarSeed(model.seed, idx) >>> 0;
	};
	for (let s = 0; s < 1000; s++) {
		stepRef(s);
		planets.generateSystem(budgetRef, { model, field }, record);
		planets.systemSummary(budgetRef, { model, field }, summary);
	}
	const heapBefore = process.memoryUsage().heapUsed;
	const fullUs = budgetLoop(10000, (s) => {
		stepRef(s);
		planets.generateSystem(budgetRef, { model, field }, record);
	});
	const summaryUs = budgetLoop(10000, (s) => {
		stepRef(s);
		planets.systemSummary(budgetRef, { model, field }, summary);
	});
	for (let s = 0; s < 100000; s++) {
		stepRef(s);
		planets.generateSystem(budgetRef, { model, field }, record);
	}
	const heapDelta = process.memoryUsage().heapUsed - heapBefore;
	check('generateSystem stays inside the 20 µs budget and the summary inside 6 µs',
		fullUs < 20 && summaryUs < 6,
		{ usPerSystem: +fullUs.toFixed(3), usPerSummary: +summaryUs.toFixed(3) });
	check('generateSystem allocates no objects (coarse heap delta < 2 MB over 100k calls)',
		heapDelta < 2 * 1024 * 1024, { heapDelta });
}

// --- 11. Designations (plan §4.11, 0.5.1-7) ---------------------------------
{
	// S + the key's uppercase base36, shortest form: the buffer writer must
	// agree with `(key >>> 0).toString(36).toUpperCase()` for every key.
	let bad = 0, sample = '';
	for (let i = 0; i < 2000; i++) {
		const key = hash.pcgHash(Math.imul(i, 2654435761));
		const end = planets.writeStarDesignation(key, planets.DESIGNATION, 0);
		const text = planets.designationToString(planets.DESIGNATION, end);
		if (text !== 'S' + (key >>> 0).toString(36).toUpperCase()) bad++;
		if (i === 0) sample = text;
	}
	// The buffer is reusable, so each write is read before the next — the
	// shortest form is part of the contract, not a formatting detail.
	const zeroEnd = planets.writeStarDesignation(0, planets.DESIGNATION, 0);
	const zeroText = planets.designationToString(planets.DESIGNATION, zeroEnd);
	const maxEnd = planets.writeStarDesignation(0xFFFFFFFF, planets.DESIGNATION, 0);
	const maxText = planets.designationToString(planets.DESIGNATION, maxEnd);
	check('star designations: S<key36 uppercase>, shortest form, 2 000 keys',
		bad === 0 && zeroEnd === 2 && zeroText === 'S0'
		&& maxEnd === 8 && maxText === 'S1Z141Z3' && maxEnd < planets.DESIGNATION_CAPACITY,
		{ sample, zero: zeroText, max: maxText, maxEnd });

	// The IAU letters and the belt names: composition is the caller's (a
	// landmark prefix, the S-form, or nothing), the suffix law is here.
	let lettersOk = true, letters = '';
	for (let i = 0; i < planets.MAX_PLANETS; i++) {
		const end = planets.writePlanetLetter(i, planets.DESIGNATION, 0);
		const text = planets.designationToString(planets.DESIGNATION, end);
		letters += text;
		if (text !== ' ' + String.fromCharCode(98 + i)) lettersOk = false;
	}
	const beltNames = [0, 1].map((slot) => {
		const end = planets.writeBeltName(slot, planets.DESIGNATION, 0);
		return planets.designationToString(planets.DESIGNATION, end);
	});
	check('planet letters run b…m in `a` order, belts read belt 1 / belt 2 by radius order',
		lettersOk && letters === ' b c d e f g h i j k l m'
		&& beltNames[0] === 'belt 1' && beltNames[1] === 'belt 2',
		{ letters: letters.trim(), belts: beltNames });
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
logFile.writeLog(logPath, {
	date: new Date().toISOString(),
	model: { type: model.type, seed: model.seed },
	totalChecks: checks.length,
	passed,
	failed,
	checks,
});
console.log('\n=== VERDICT ===');
console.log(failed === 0 ? 'PASS — identity keys, the inversion, every stellar-input path, the occurrence tier, the architecture tier, the insolation/temperature/band tier, the belt/moon tier and the record/summary/designation tier behave as documented' : `FAIL — ${failed} checks failed`);
process.exit(failed === 0 ? 0 : 1);