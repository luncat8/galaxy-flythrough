// experiments/planet-gen-test.js
// The planet module's input tier (0.5.0-2a/-2b): the identity keys the renderer
// writes beside every record (plan §2.2/§2.3), the magnitude→mass inversion
// (§2.5), the stellar radius, and the per-block `stellarInputs` paths (§2.4) —
// the three re-derivable blocks pinned bit-exactly against the derivation the
// renderer itself runs, the two record-only blocks pinned to the inversion.
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
console.log(failed === 0 ? 'PASS — identity keys, the inversion and every stellar-input path behave as documented' : `FAIL — ${failed} checks failed`);
process.exit(failed === 0 ? 0 : 1);
