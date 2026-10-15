// experiments/search-test.js
// Star and planet search (0.5.2, plan §5): the filter token, scope fallback,
// predicate correctness against an independent brute force, the result cap and
// nearest-first order, and the §5.3 budgets at 300k stars.
//
// Checks:
//   1. token: parse/format round-trip (including plan §5.5's `G,K|terran|220-300`),
//      bare forms, junk tolerance, empty filter.
//   2. scope fallback: selection scope with an empty set runs the galaxy and
//      says so; a non-empty set runs the set; galaxy scope runs the galaxy.
//   3. predicate correctness: a 20-filter battery (star-only, planet, and
//      conjunctions, including straddle-prone multi-range queries) over a
//      synthetic five-block field — search ≡ an independent brute force that
//      derives every star fully, summaries every planet-query star, and checks
//      ranges against full planet rows without trusting the extremes. Same
//      matched count, same kept keys, same props, same display planet.
//   4. the two exact pre-filters change nothing (covered by 3) and fire (a bare
//      barren query confirms its pre-check zeroes without a summary; a terran
//      query runs fewer summaries than it scans).
//   5. result cap: matched > 512 keeps 512 scan-first, dist2 ascending,
//      truncated = matched − kept, keys unique.
//   6. set scope: snapshot props, the stale-slot guard (kind −1, no throw,
//      record-path class), equivalence with a set-aware brute force.
//   7. timings at 300k: star-only class filter < 120 ms, planet filter
//      (class G + terran, and a tsurf range) < 600 ms, selection scope
//      (214 stars) < 2 ms. A pathological loose range is measured and logged,
//      not budgeted.
//   8. degrade: null filter/env/renderer, empty blocks, impossible ranges —
//      empty results, never a throw.
//   9. pins: the ly→kpc fallback digits, COMP_* against density's component
//      ids, the state/component/planet-type bit helpers.
//
// Output: experiments/logs/search.json

'use strict';

const fs = require('fs');
const path = require('path');

globalThis.window = globalThis;

const galaxy = require('../src/math/galaxy.js');
const sampling = require('../src/math/sampling.js');
const starTypes = require('../src/math/star-types.js');
const records = require('../src/math/star-record.js');
const density = require('../src/math/density.js');
const hash = require('../src/math/hash.js');
const orbit = require('../src/math/orbit.js');
const planets = require('../src/math/planets.js');
const cameraLib = require('../src/core/camera.js');
const starSetLib = require('../src/core/star-set.js');
const searchLib = require('../src/core/search.js');
const landmarks = require('../src/data/landmarks.js');

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
	return !!pass;
}

const model = galaxy.createGalaxy({ type: 'SBb', seed: 12345, age: 13.5 });
const LY_PER_KPC = 1 / cameraLib.LY_TO_KPC;

// --- The synthetic renderer: five blocks, written like star-sprites writes them
const FIELD_N = 6000;
const LOCAL_N = 40;
const OBJECT_N = 24;
const CATALOG_N = 60;
const LANDMARK_N = landmarks.count;
const TOTAL = FIELD_N + LANDMARK_N + OBJECT_N + LOCAL_N + CATALOG_N;
const BLOCK_ORDER = ['field', 'landmark', 'object', 'local', 'catalog'];
const COUNTS = [FIELD_N, LANDMARK_N, OBJECT_N, LOCAL_N, CATALOG_N];
const offsets = [];
{
	let off = 0;
	for (const n of COUNTS) { offsets.push(off); off += n; }
}

const staging = new ArrayBuffer(TOTAL * records.RECORD_BYTES);
const view = new DataView(staging);
const identity = new Uint32Array(TOTAL);
const blocks = BLOCK_ORDER.map((kind, k) => ({ kind, offset: offsets[k], count: COUNTS[k] }));
const memberMeta = { age: new Float64Array(OBJECT_N), component: new Int8Array(OBJECT_N) };
const info = { identity, view, blocks, total: TOTAL, dynamicVersion: 1, member: memberMeta };
const field = sampling.sampleGalaxyStars(model, model.seed | 0, FIELD_N, null);
const renderer = { starBlocks: () => info, fieldBuffers: () => field };
const genCtx = { model, field, member: memberMeta };

{
	const derived = {};
	for (let i = 0; i < FIELD_N; i++) {
		const key = starTypes.fieldStarSeed(model.seed, i);
		starTypes.deriveStar(model, key, field.component[i], field.R[i], field.distToArm[i], derived, field.z[i]);
		records.writeRecord(view, (offsets[0] + i) * records.RECORD_BYTES,
			field.x[i], field.y[i], field.z[i],
			derived.colorIndex, derived.absMag,
			orbit.flagsWithFamily(records.FLAG_VISIBLE, orbit.familyForStar(field.component[i], derived.spectralClass, model.barred)),
			Math.imul(i, 2654435761) & 0xFF);
		identity[offsets[0] + i] = key;
	}
	for (let i = 0; i < LANDMARK_N; i++) {
		const e = landmarks.ENTRIES[i];
		records.writeRecord(view, (offsets[1] + i) * records.RECORD_BYTES, e.x, e.y, e.z,
			e.colorIndex, e.absMag,
			orbit.flagsWithFamily(records.FLAG_VISIBLE | records.FLAG_LANDMARK, orbit.familyFromColorIndex(e.colorIndex)), 0);
		identity[offsets[1] + i] = planets.landmarkKey(i);
	}
	const objectsLib = require('../src/math/objects.js');
	const clustersLib = require('../src/math/clusters.js');
	// The renderer's block layout (plan §10): star clusters first, gas
	// objects after. The halo-component members the battery's `comp halo`
	// filter finds are a halo star cluster's — globulars were never
	// nebulae, and the gas layer has no halo members to give.
	const haloCluster = {
		seed: 424242, x: 1.5, y: -2.0, z: 0.8, scale: 0.002, tidal: 0.03,
		ageGyr: 12, weight: 1, component: density.COMPONENT_HALO,
	};
	const clusterSlots = clustersLib.writeClusterMembers(model, [haloCluster], view,
		offsets[2] * records.RECORD_BYTES, 4, 0, identity, offsets[2], memberMeta).written;
	const placed = objectsLib.placeObjects(model, (model.seed | 0) ^ 0x0B5E55, 4, null);
	objectsLib.writeObjectMembers(model, placed, view,
		(offsets[2] + clusterSlots) * records.RECORD_BYTES, OBJECT_N - clusterSlots, 0,
		identity, offsets[2] + clusterSlots,
		{ age: memberMeta.age.subarray(clusterSlots), component: memberMeta.component.subarray(clusterSlots) });
	const localSeed = (model.seed | 0) ^ 0x10ca1cab;
	const cell = { id: 7, x0: 1.2, y0: -0.4, z0: 0.05, size: 0.4 };
	for (let i = 0; i < LOCAL_N; i++) {
		const slotSeed = (Math.imul(localSeed, 0x9e3779b1)
			^ Math.imul(cell.id, 0x85ebca6b)
			^ Math.imul(i + 1, 0xc2b2ae3d));
		const x = cell.x0 + hash.hash01At(slotSeed, 0) * cell.size;
		const y = cell.y0 + hash.hash01At(slotSeed, 1) * cell.size;
		const z = cell.z0 + hash.hash01At(slotSeed, 2) * cell.size;
		const decomposed = density.rhoDecomposed(model, x, y, z);
		const component = density.sampleComponentIndex(decomposed, hash.hash01At(slotSeed, 3));
		starTypes.deriveStar(model, Math.imul(slotSeed, 31) + 5, component, decomposed.R, decomposed.distToArm, derived, z);
		records.writeRecord(view, (offsets[3] + i) * records.RECORD_BYTES, x, y, z,
			derived.colorIndex, derived.absMag,
			orbit.flagsWithFamily(records.FLAG_VISIBLE, orbit.familyForStar(component, derived.spectralClass, model.barred)),
			hash.pcgHash(slotSeed ^ 0xFACE) & 0xFF);
		identity[offsets[3] + i] = slotSeed >>> 0;
	}
	// Catalog: every LUT slot and a spread of magnitudes, positions fanning
	// out from the Sun so distance filters bite on this block too.
	for (let i = 0; i < CATALOG_N; i++) {
		const x = (i * 0.013) - 0.2;
		records.writeRecord(view, (offsets[4] + i) * records.RECORD_BYTES, x, 0.05, 0.9 + i * 0.001,
			i % 10, -2 + (i % 9), records.FLAG_VISIBLE, 0);
		identity[offsets[4] + i] = planets.catalogKey(3, i);
	}
}

const camera = cameraLib.createCamera();
camera.setFrame(model);
camera.setMode(cameraLib.MODE_FLY);

// --- The independent brute force -------------------------------------------
// Same model, none of search.js's machinery: every star fully derived (no slot
// pre-filter), every planet-query star summarized (no count pre-check), and
// ranges checked against full generateSystem rows without reading the extremes
// at all. Whatever search.js concludes, this re-derives the long way.
const bruteInputs = planets.createStellarInputs();
const bruteSummary = planets.createSystemSummary();
const bruteRecord = planets.createSystemRecord();
const bruteRef = { kind: 0, key: 0, index: 0, x: 0, y: 0, z: 0, colorIndex: 0, absMag: 0 };

function bruteClassMask(f) {
	let mask = (f.classes | 0) >>> 0;
	const st = f.states | 0;
	const bit = (name) => 1 << records.SPECTRAL_CLASSES.indexOf(name);
	if (st & searchLib.STATE_MS) mask |= bit('O') | bit('B') | bit('A') | bit('F') | bit('G') | bit('K') | bit('M');
	if (st & searchLib.STATE_GIANT) mask |= bit('RG') | bit('RGe');
	if (st & searchLib.STATE_WD) mask |= bit('WD');
	return mask >>> 0;
}

function bruteComponentOf(star) {
	if (star.kind === planets.BLOCK_FIELD) return field.component[star.index];
	if (star.kind === planets.BLOCK_OBJECT && star.index < memberMeta.component.length) {
		const c = memberMeta.component[star.index];
		return c < 0 ? density.COMPONENT_THIN : c;
	}
	const decomposed = density.rhoDecomposed(model, star.x, star.y, star.z);
	return density.sampleComponentIndex(decomposed, hash.hash01At(star.key, 3));
}

function bruteStarPass(star, f, camX, camY, camZ, classMask) {
	const dx = star.x - camX;
	const dy = star.y - camY;
	const dz = star.z - camZ;
	const d2 = dx * dx + dy * dy + dz * dz;
	const distLy = Math.sqrt(d2) * LY_PER_KPC;
	if (distLy < f.distMin || distLy > f.distMax) return null;
	const recordClass = star.kind === planets.BLOCK_LANDMARK
		|| star.kind === planets.BLOCK_CATALOG || star.kind < 0;
	let inputs = null;
	if (classMask) {
		if (recordClass) {
			const slot = star.colorIndex < 10 ? star.colorIndex : records.SPECTRAL_CLASSES.indexOf('M');
			if (!(((classMask >>> slot) & 1))) return null;
		} else {
			bruteRef.kind = star.kind; bruteRef.key = star.key; bruteRef.index = star.index;
			bruteRef.x = star.x; bruteRef.y = star.y; bruteRef.z = star.z;
			bruteRef.colorIndex = star.colorIndex; bruteRef.absMag = star.absMag;
			inputs = planets.stellarInputs(bruteRef, genCtx, bruteInputs);
			const bit = 1 << records.SPECTRAL_CLASSES.indexOf(inputs.spectralClass);
			if (!(classMask & bit)) return null;
		}
	}
	const hasLum = f.lumMin > 0 || f.lumMax < Infinity;
	const hasMass = f.massMin > 0 || f.massMax < Infinity;
	if ((hasLum || hasMass) && !star.snapshot) {
		if (!inputs) {
			bruteRef.kind = star.kind; bruteRef.key = star.key; bruteRef.index = star.index;
			bruteRef.x = star.x; bruteRef.y = star.y; bruteRef.z = star.z;
			bruteRef.colorIndex = star.colorIndex; bruteRef.absMag = star.absMag;
			inputs = planets.stellarInputs(bruteRef, genCtx, bruteInputs);
		}
		if (hasLum && (inputs.lum < f.lumMin || inputs.lum > f.lumMax)) return null;
		if (hasMass && (inputs.mass < f.massMin || inputs.mass > f.massMax)) return null;
	}
	if (star.snapshot) {
		if (hasLum && (star.snapshot.lum < f.lumMin || star.snapshot.lum > f.lumMax)) return null;
		if (hasMass && (star.snapshot.mass < f.massMin || star.snapshot.mass > f.massMax)) return null;
	}
	if ((f.components | 0)) {
		const comp = star.snapshotComp !== undefined && star.snapshotComp >= 0
			? star.snapshotComp : bruteComponentOf(star);
		if ((((f.components >>> comp) & 1)) === 0) return null;
	}
	return { d2, inputs };
}

function bruteDisplayPlanets(f, recordPlanets, n) {
	// The display rule, reimplemented: the first row passing every per-planet
	// predicate; the |S − 1| best terran when the conjunction splits or the
	// query names no planet; the innermost planet for a pure system query.
	const ptype = f.planetTypes | 0;
	const hasRanges = f.tsurfMin > 0 || f.tsurfMax < Infinity
		|| f.teqMin > 0 || f.teqMax < Infinity
		|| f.planetMassMin > 0 || f.planetMassMax < Infinity
		|| f.aMin > 0 || f.aMax < Infinity;
	const hasPerPlanet = !!(ptype || f.terranOnly || hasRanges);
	const rowPass = (i) => {
		if (ptype && ((((ptype >>> recordPlanets.displayType[i]) & 1)) === 0)) return false;
		if (f.terranOnly && !(recordPlanets.flags[i] & planets.FLAG_TERRAN)) return false;
		if (recordPlanets.tsurf[i] < f.tsurfMin || recordPlanets.tsurf[i] > f.tsurfMax) return false;
		if (recordPlanets.teq[i] < f.teqMin || recordPlanets.teq[i] > f.teqMax) return false;
		if (recordPlanets.mass[i] < f.planetMassMin || recordPlanets.mass[i] > f.planetMassMax) return false;
		if (recordPlanets.a[i] < f.aMin || recordPlanets.a[i] > f.aMax) return false;
		return true;
	};
	if (hasRanges) {
		for (let i = 0; i < n; i++) if (rowPass(i)) return { display: i, exact: true };
		return { display: -1, exact: false };
	}
	if (hasPerPlanet) {
		for (let i = 0; i < n; i++) if (rowPass(i)) return { display: i, exact: true };
	}
	let best = -1;
	let bestD = Infinity;
	for (let i = 0; i < n; i++) {
		if (!(recordPlanets.flags[i] & planets.FLAG_TERRAN)) continue;
		const d = Math.abs(recordPlanets.insolation[i] - 1);
		if (d < bestD) { bestD = d; best = i; }
	}
	if (best >= 0) return { display: best, exact: true };
	if (!hasPerPlanet && n > 0) return { display: 0, exact: true };
	return { display: -1, exact: true };
}

function brutePlanetPass(star, f) {
	bruteRef.kind = star.kind; bruteRef.key = star.key; bruteRef.index = star.index;
	bruteRef.x = star.x; bruteRef.y = star.y; bruteRef.z = star.z;
	bruteRef.colorIndex = star.colorIndex; bruteRef.absMag = star.absMag;
	const summary = planets.systemSummary(bruteRef, genCtx, bruteSummary);
	if (summary.count < (f.minPlanets | 0)) return null;
	if (f.barrenOnly && summary.count !== 0) return null;
	if ((f.planetTypes | 0)) {
		let hit = false;
		for (let t = 0; t < summary.typeHistogram.length; t++) {
			if ((((f.planetTypes >>> t) & 1)) && summary.typeHistogram[t] > 0) { hit = true; break; }
		}
		if (!hit) return null;
	}
	if (f.terranOnly && summary.terranCount === 0) return null;
	if (f.needsBelt && summary.beltCount === 0) return null;
	const hasRanges = f.tsurfMin > 0 || f.tsurfMax < Infinity
		|| f.teqMin > 0 || f.teqMax < Infinity
		|| f.planetMassMin > 0 || f.planetMassMax < Infinity
		|| f.aMin > 0 || f.aMax < Infinity;
	// Ranges never trust the extremes here: full rows, per-planet conjunction.
	if (hasRanges) {
		const record = planets.generateSystem(bruteRef, genCtx, bruteRecord);
		const found = bruteDisplayPlanets(f, record.planets, record.counts.planets);
		if (!found.exact) return null;
		const p = record.planets;
		return {
			nPlanets: record.counts.planets, nBelts: record.belts.count,
			best: [p.a[found.display], p.mass[found.display], p.tsurf[found.display], p.displayType[found.display]],
			letter: found.display,
		};
	}
	if (summary.count > 0) {
		const record = planets.generateSystem(bruteRef, genCtx, bruteRecord);
		const found = bruteDisplayPlanets(f, record.planets, record.counts.planets);
		if (found.display < 0) {
			return { nPlanets: summary.count, nBelts: summary.beltCount, best: null, letter: -1 };
		}
		const p = record.planets;
		return {
			nPlanets: summary.count, nBelts: summary.beltCount,
			best: [p.a[found.display], p.mass[found.display], p.tsurf[found.display], p.displayType[found.display]],
			letter: found.display,
		};
	}
	return { nPlanets: 0, nBelts: summary.beltCount, best: null, letter: -1 };
}

// --- 1. The token ------------------------------------------------------------
{
	const f = searchLib.parseFilter('G,K|terran|220-300');
	const g = 1 << records.SPECTRAL_CLASSES.indexOf('G');
	const k = 1 << records.SPECTRAL_CLASSES.indexOf('K');
	check('the plan §5.5 example parses (bare class list, flag, bare tsurf range)',
		f.classes === (g | k) && f.terranOnly === true
		&& f.tsurfMin === 220 && f.tsurfMax === 300
		&& f.teqMin === 0 && f.teqMax === Infinity,
		searchLib.formatFilter(f));
	check('format is canonical and re-parses to the same filter',
		(() => {
			const back = searchLib.parseFilter(searchLib.formatFilter(f));
			return back.classes === f.classes && back.terranOnly === f.terranOnly
				&& back.tsurfMin === 220 && back.tsurfMax === 300;
		})(), searchLib.formatFilter(f));
	check('an empty token is the unconstrained filter and formats to empty',
		(() => {
			const e = searchLib.parseFilter('');
			const d = searchLib.createFilter();
			return searchLib.formatFilter(e) === ''
				&& JSON.stringify(e) === JSON.stringify(d);
		})());
	const full = searchLib.parseFilter(
		'class:O,B|state:ms,giant|comp:thin,halo|lum:0.5-2|mass:-3|dist:10-|' +
		'ptype:TERRAN,gas_giant|terran|belt|barren|n:2|tsurf:180-320|teq:-400|pmass:0.5-|a:0.8-1.5');
	check('every keyed clause parses',
		full.classes === (searchLib.classBit('O') | searchLib.classBit('B'))
		&& full.states === (searchLib.STATE_MS | searchLib.STATE_GIANT)
		&& full.components === (searchLib.COMP_THIN | searchLib.COMP_HALO)
		&& full.lumMin === 0.5 && full.lumMax === 2
		&& full.massMin === 0 && full.massMax === 3
		&& full.distMin === 10 && full.distMax === Infinity
		&& full.planetTypes === (searchLib.planetTypeBit('TERRAN') | searchLib.planetTypeBit('GAS_GIANT'))
		&& full.terranOnly && full.needsBelt && full.barrenOnly && full.minPlanets === 2
		&& full.tsurfMin === 180 && full.tsurfMax === 320
		&& full.teqMin === 0 && full.teqMax === 400
		&& full.planetMassMin === 0.5 && full.planetMassMax === Infinity
		&& full.aMin === 0.8 && full.aMax === 1.5,
		searchLib.formatFilter(full));
	check('a full filter round-trips through format byte-identically in meaning',
		JSON.stringify(searchLib.parseFilter(searchLib.formatFilter(full))) === JSON.stringify(full));
	check('junk clauses are ignored, junk numbers fall back to open',
		(() => {
			const j = searchLib.parseFilter('class:G|nope:1|lum:abc-def|banana|n:-3');
			return j.classes === searchLib.classBit('G')
				&& j.lumMin === 0 && j.lumMax === Infinity && j.minPlanets === 0;
		})());
	check('malformed ranges (two dashes, negatives) are ignored, not half-parsed',
		(() => {
			const j = searchLib.parseFilter('mass:-5--1');
			return j.massMin === 0 && j.massMax === Infinity;
		})());
	check('the bit helpers resolve every table and reject junk',
		searchLib.classBit('M') === (1 << 6)
		&& searchLib.stateBit('giant') === searchLib.STATE_GIANT
		&& searchLib.componentBit('halo') === searchLib.COMP_HALO
		&& searchLib.planetTypeBit('ice_giant') === (1 << planets.DISPLAY_INDEX.ICE_GIANT)
		&& searchLib.classBit('X') === 0 && searchLib.planetTypeBit('X') === 0
		&& searchLib.stateBit('X') === 0 && searchLib.componentBit('X') === 0);
}

// --- 2. Scope fallback -------------------------------------------------------
{
	const search = searchLib.createSearch();
	const cam = camera.cameraPos;
	const emptySet = starSetLib.createStarSet();
	let res = search.run(searchLib.createFilter(), {
		scope: 'selection', camX: cam[0], camY: cam[1], camZ: cam[2],
		model, renderer, set: emptySet,
	});
	check('an empty set falls back to the galaxy and says so',
		res.stats.scope === 'galaxy' && res.stats.scanned === TOTAL, Object.assign({}, res.stats));
	res = search.run(searchLib.createFilter(), {
		scope: 'galaxy', camX: cam[0], camY: cam[1], camZ: cam[2],
		model, renderer, set: emptySet,
	});
	check('explicit galaxy scope scans the whole field',
		res.stats.scope === 'galaxy' && res.stats.scanned === TOTAL, Object.assign({}, res.stats));
	// One member in the set: selection scope scans exactly one star.
	const rec = records.readRecord(view, offsets[0] * records.RECORD_BYTES);
	const inputs = planets.stellarInputs({
		kind: 0, key: identity[offsets[0]] >>> 0, index: 0,
		x: rec.x, y: rec.y, z: rec.z, colorIndex: rec.colorIndex, absMag: rec.absMag,
	}, genCtx, planets.createStellarInputs());
	emptySet.setSingle({
		key: identity[offsets[0]] >>> 0, kind: 0, index: 0,
		x: rec.x, y: rec.y, z: rec.z, colorIndex: rec.colorIndex, absMag: rec.absMag,
	}, inputs, cam[0], cam[1], cam[2], 0);
	res = search.run(searchLib.createFilter(), {
		scope: 'selection', camX: cam[0], camY: cam[1], camZ: cam[2],
		model, renderer, set: emptySet,
	});
	check('a non-empty set runs the set (one member, one scanned)',
		res.stats.scope === 'selection' && res.stats.scanned === 1
		&& res.stats.matched === 1 && res.count === 1, Object.assign({}, res.stats));
}

// --- 3. The battery: search ≡ brute force -----------------------------------
// Filters are built two ways — structurally and from tokens — so the token
// paths run inside the equivalence pin, not beside it.
function filterFrom(build) {
	const f = searchLib.createFilter();
	build(f);
	return f;
}
const G = searchLib.classBit('G');
const K = searchLib.classBit('K');
const M = searchLib.classBit('M');
const RGe = searchLib.classBit('RGe');
const TERRAN = searchLib.planetTypeBit('TERRAN');
const GAS_GIANT = searchLib.planetTypeBit('GAS_GIANT');
const BATTERY = [
	['empty (match-all)', filterFrom(() => {})],
	['class G', filterFrom((f) => { f.classes = G; })],
	['class M', filterFrom((f) => { f.classes = M; })],
	['classes G,K (token)', searchLib.parseFilter('G,K')],
	['class RGe (record slots only)', filterFrom((f) => { f.classes = RGe; })],
	['state ms', filterFrom((f) => { f.states = searchLib.STATE_MS; })],
	['states giant+wd', filterFrom((f) => { f.states = searchLib.STATE_GIANT | searchLib.STATE_WD; })],
	['lum 0.5-2', filterFrom((f) => { f.lumMin = 0.5; f.lumMax = 2; })],
	['mass 0.8-1.2', filterFrom((f) => { f.massMin = 0.8; f.massMax = 1.2; })],
	['dist 0-30 ly', filterFrom((f) => { f.distMin = 0; f.distMax = 30; })],
	['dist 100-3000 ly', filterFrom((f) => { f.distMin = 100; f.distMax = 3000; })],
	['comp thin', filterFrom((f) => { f.components = searchLib.COMP_THIN; })],
	['comp halo', filterFrom((f) => { f.components = searchLib.COMP_HALO; })],
	['ptype GAS_GIANT', filterFrom((f) => { f.planetTypes = GAS_GIANT; })],
	['terran (token)', searchLib.parseFilter('terran')],
	['tsurf 180-320 (token)', searchLib.parseFilter('tsurf:180-320')],
	['teq 200-300 + tsurf 180-320 (straddle-prone)', filterFrom((f) => {
		f.teqMin = 200; f.teqMax = 300; f.tsurfMin = 180; f.tsurfMax = 320;
	})],
	['pmass 0.5-2 + a 0.8-1.5', filterFrom((f) => {
		f.planetMassMin = 0.5; f.planetMassMax = 2; f.aMin = 0.8; f.aMax = 1.5;
	})],
	['minPlanets 2', filterFrom((f) => { f.minPlanets = 2; })],
	['barren', searchLib.parseFilter('barren')],
	['belt', searchLib.parseFilter('belt')],
	['class G + terran (token)', searchLib.parseFilter('G|terran')],
	['class K + tsurf + minPlanets', filterFrom((f) => {
		f.classes = K; f.tsurfMin = 180; f.tsurfMax = 320; f.minPlanets = 1;
	})],
	['barren + class M', filterFrom((f) => { f.barrenOnly = true; f.classes = M; })],
	['dist + terran', filterFrom((f) => { f.distMin = 0; f.distMax = 30000; f.terranOnly = true; })],
	['ptype + pmass range', filterFrom((f) => { f.planetTypes = TERRAN; f.planetMassMin = 0.5; f.planetMassMax = 5; })],
];

function galaxyStars() {
	const stars = [];
	for (let k = 0; k < blocks.length; k++) {
		const block = blocks[k];
		for (let i = 0; i < block.count; i++) {
			const slot = block.offset + i;
			const rec = records.readRecord(view, slot * records.RECORD_BYTES);
			if (!rec.visible) continue;
			stars.push({
				key: identity[slot] >>> 0, kind: k, index: i,
				x: rec.x, y: rec.y, z: rec.z,
				colorIndex: rec.colorIndex, absMag: rec.absMag,
			});
		}
	}
	return stars;
}

function bruteRun(stars, f, camX, camY, camZ) {
	const classMask = bruteClassMask(f);
	const wantPlanet = !!((f.planetTypes | 0) || f.terranOnly
		|| f.tsurfMin > 0 || f.tsurfMax < Infinity
		|| f.teqMin > 0 || f.teqMax < Infinity
		|| f.planetMassMin > 0 || f.planetMassMax < Infinity
		|| f.aMin > 0 || f.aMax < Infinity
		|| (f.minPlanets | 0) > 0 || f.barrenOnly || f.needsBelt);
	const matches = [];
	for (const star of stars) {
		const pass = bruteStarPass(star, f, camX, camY, camZ, classMask);
		if (!pass) continue;
		let planet = null;
		if (wantPlanet) {
			planet = brutePlanetPass(star, f);
			if (!planet) continue;
		}
		matches.push({ star, d2: pass.d2, inputs: pass.inputs, planet });
	}
	// Scan order, deliberately unsorted: the caller keeps the first
	// MAX_RESULTS and sorts those (plan §5.3), which is not the nearest
	// MAX_RESULTS of all matches.
	return matches;
}

{
	const search = searchLib.createSearch();
	const cam = camera.cameraPos;
	const stars = galaxyStars();
	let failures = 0;
	const counts = {};
	for (const [name, f] of BATTERY) {
		const res = search.run(f, {
			scope: 'galaxy', camX: cam[0], camY: cam[1], camZ: cam[2],
			model, renderer, set: null,
		});
		const expected = bruteRun(stars, f, cam[0], cam[1], cam[2]);
		counts[name] = [expected.length, res.stats.matched];
		// Plan §5.3: the first MAX_RESULTS matches in scan order, then
		// nearest-first — not the nearest MAX_RESULTS of all matches.
		const kept = expected.slice(0, searchLib.MAX_RESULTS).sort((a, b) => a.d2 - b.d2);
		let bad = '';
		if (expected.length !== res.stats.matched) bad = `matched ${res.stats.matched} != brute ${expected.length}`;
		else if (res.count !== kept.length) bad = `kept ${res.count}`;
		else if (res.stats.truncated !== Math.max(0, expected.length - res.count)) bad = 'truncated';
		else {
			for (let i = 0; i < res.count; i++) {
				const e = kept[i];
				const s = e.star;
				if (res.keys[i] !== (s.key >>> 0) || res.kind[i] !== s.kind || res.index[i] !== s.index) {
					bad = `row ${i} identity`; break;
				}
				if (Math.abs(res.dist2[i] - e.d2) > 1e-9 * Math.max(1, e.d2)) { bad = `row ${i} dist2`; break; }
				// absMag crosses a Float32Array on the way out (0.118 mag
				// quanta), so it compares with room, not bit-exactly.
				if (res.colorIndex[i] !== s.colorIndex || Math.abs(res.absMag[i] - s.absMag) > 1e-6) {
					bad = `row ${i} record echo`; break;
				}
				if (Math.abs(res.x[i] - s.x) > 1e-12 || Math.abs(res.y[i] - s.y) > 1e-12 || Math.abs(res.z[i] - s.z) > 1e-12) {
					bad = `row ${i} position`; break;
				}
				// Props: a fresh derivation for galaxy scope (bit-identical —
				// the same call through the same channels).
				bruteRef.kind = s.kind; bruteRef.key = s.key; bruteRef.index = s.index;
				bruteRef.x = s.x; bruteRef.y = s.y; bruteRef.z = s.z;
				bruteRef.colorIndex = s.colorIndex; bruteRef.absMag = s.absMag;
				const fresh = planets.stellarInputs(bruteRef, genCtx, bruteInputs);
				const o = i * 5;
				const props = [fresh.mass, fresh.lum, fresh.teff, fresh.age, fresh.metal];
				let propsBad = false;
				for (let p = 0; p < 5; p++) {
					if (res.starProps[o + p] !== props[p]) propsBad = true;
				}
				if (propsBad) { bad = `row ${i} starProps`; break; }
				if (e.planet) {
					// The barren fast path confirms the zero count with no
					// summary, and belts are summary-computed — so its rows
					// honestly report unknown belts (COUNT_UNKNOWN), while
					// summary-collected rows of the same query stay exact.
					const beltsOk = res.nBelts[i] === e.planet.nBelts
						|| (f.barrenOnly && res.nBelts[i] === searchLib.COUNT_UNKNOWN);
					if (res.nPlanets[i] !== e.planet.nPlanets || !beltsOk) {
						bad = `row ${i} counts`; break;
					}
					const b = i * 4;
					if (e.planet.best) {
						for (let p = 0; p < 4; p++) {
							if (res.best[b + p] !== e.planet.best[p]) { bad = `row ${i} best[${p}]`; break; }
						}
						if (bad) break;
						if (res.bestLetter[i] !== e.planet.letter) { bad = `row ${i} letter`; break; }
					} else if (res.best[b + 3] !== searchLib.BEST_NONE || res.bestLetter[i] !== -1) {
						bad = `row ${i} best-none`; break;
					}
				} else if (res.nPlanets[i] !== searchLib.COUNT_UNKNOWN || res.best[i * 4 + 3] !== searchLib.BEST_NONE) {
					bad = `row ${i} star-only markers`; break;
				}
			}
		}
		if (bad) {
			failures++;
			check(`battery: ${name}`, false, bad);
		}
	}
	check(`the ${BATTERY.length}-filter battery matches the brute force (identity, order, props, display planet)`,
		failures === 0, counts);
	// The battery must actually exercise the machinery: every filter matches
	// something, and the match-all overflows the 512 cap.
	const someEmpty = BATTERY.filter(([name]) => counts[name][0] === 0).map(([name]) => name);
	check('every battery filter matches at least one star', someEmpty.length === 0, someEmpty);
	check('the match-all overflows the result cap',
		counts['empty (match-all)'][0] > searchLib.MAX_RESULTS, counts['empty (match-all)']);
}

// --- 4. The pre-filters fire (and §3 says they change nothing) ----------------
{
	const search = searchLib.createSearch();
	const cam = camera.cameraPos;
	const realSummary = planets.systemSummary;
	let calls = 0;
	planets.systemSummary = function (...args) {
		calls++;
		return realSummary.apply(this, args);
	};
	try {
		const barren = searchLib.parseFilter('barren');
		const res = search.run(barren, {
			scope: 'galaxy', camX: cam[0], camY: cam[1], camZ: cam[2],
			model, renderer, set: null,
		});
		// Pre-check zeroes confirm barren with no summary; pre-check
		// positives still run one (the ceiling μ over-approximates, so only
		// the summary can confirm the true count is zero).
		check('a bare barren query confirms its pre-check zeroes without a summary',
			calls > 0 && calls < res.stats.scanned && res.stats.matched > 0,
			{ calls, scanned: res.stats.scanned, matched: res.stats.matched });
		calls = 0;
		const terran = searchLib.parseFilter('terran');
		const res2 = search.run(terran, {
			scope: 'galaxy', camX: cam[0], camY: cam[1], camZ: cam[2],
			model, renderer, set: null,
		});
		check('a terran query skips the summary for its pre-check zeroes',
			calls > 0 && calls < res2.stats.scanned && res2.stats.matched > 0,
			{ calls, scanned: res2.stats.scanned, matched: res2.stats.matched });
	} finally {
		planets.systemSummary = realSummary;
	}
}

// --- 5. Cap, order, uniqueness ------------------------------------------------
{
	const search = searchLib.createSearch();
	const cam = camera.cameraPos;
	const res = search.run(searchLib.createFilter(), {
		scope: 'galaxy', camX: cam[0], camY: cam[1], camZ: cam[2],
		model, renderer, set: null,
	});
	let ascending = true;
	for (let i = 1; i < res.count; i++) {
		if (res.dist2[i] < res.dist2[i - 1]) { ascending = false; break; }
	}
	const seen = new Set();
	let dupes = 0;
	for (let i = 0; i < res.count; i++) {
		const k = res.keys[i] * 8 + res.kind[i];
		if (seen.has(k)) dupes++;
		seen.add(k);
	}
	let distOk = true;
	for (let i = 0; i < res.count; i++) {
		const dx = res.x[i] - cam[0];
		const dy = res.y[i] - cam[1];
		const dz = res.z[i] - cam[2];
		if (Math.abs((dx * dx + dy * dy + dz * dz) - res.dist2[i]) > 1e-9) { distOk = false; break; }
	}
	check('kept rows are nearest-first, unique, and carry true distances',
		res.count === searchLib.MAX_RESULTS && ascending && dupes === 0 && distOk,
		{ count: res.count, ascending, dupes, distOk });
}

// --- 6. Set scope --------------------------------------------------------------
{
	const set = starSetLib.createStarSet();
	const cam = camera.cameraPos;
	const inputs = planets.createStellarInputs();
	const addMember = (kind, index) => {
		const slot = offsets[kind] + index;
		const rec = records.readRecord(view, slot * records.RECORD_BYTES);
		const pick = {
			key: identity[slot] >>> 0, kind, index,
			x: rec.x, y: rec.y, z: rec.z,
			colorIndex: rec.colorIndex, absMag: rec.absMag,
		};
		planets.stellarInputs(pick, genCtx, inputs);
		set.insert(pick, inputs, cam[0], cam[1], cam[2], index);
	};
	for (let i = 0; i < 30; i++) addMember(0, i * 197);
	for (let i = 0; i < 4; i++) addMember(1, i);
	for (let i = 0; i < 3; i++) addMember(2, i * 7);
	for (let i = 0; i < 2; i++) addMember(3, i * 13);
	for (let i = 0; i < 5; i++) addMember(4, i * 11);
	// Two stale members — two different field stars, so the second insert is
	// not an upsert of the first: a slot holding another star's key, and an
	// out-of-range slot. Both must resolve through the record path.
	for (const [fieldIndex, badSlot] of [[11, 12], [13, 999999]]) {
		const staleSlot = offsets[0] + fieldIndex;
		const staleRec = records.readRecord(view, staleSlot * records.RECORD_BYTES);
		const stalePick = {
			key: identity[staleSlot] >>> 0, kind: 0, index: fieldIndex,
			x: staleRec.x, y: staleRec.y, z: staleRec.z,
			colorIndex: staleRec.colorIndex, absMag: staleRec.absMag,
		};
		planets.stellarInputs(stalePick, genCtx, inputs);
		set.insert(stalePick, inputs, cam[0], cam[1], cam[2], fieldIndex);
		set.bufferIdx[set.count - 1] = badSlot;
	}
	check('the set holds members from all five blocks plus two stale slots',
		set.count === 46, set.count);

	const search = searchLib.createSearch();
	let res = search.run(searchLib.createFilter(), {
		scope: 'selection', camX: cam[0], camY: cam[1], camZ: cam[2],
		model, renderer, set,
	});
	const staleRows = [];
	for (let i = 0; i < res.count; i++) {
		if (res.kind[i] === searchLib.KIND_UNRESOLVED) staleRows.push(i);
	}
	check('stale members resolve with kind −1 instead of throwing',
		res.stats.matched === set.count && staleRows.length === 2,
		Object.assign({ staleRows: staleRows.length }, res.stats));

	// Set-aware brute force: snapshot lum/mass/props, the guarded class path,
	// the same planet stage.
	const setStars = [];
	for (let i = 0; i < set.count; i++) {
		const kind = set.blockKind[i];
		let effKind = kind;
		let blockIndex = set.bufferIdx[i] | 0;
		if (kind === planets.BLOCK_FIELD || kind === planets.BLOCK_OBJECT) {
			const block = blocks[kind];
			const slot = blockIndex >= 0 ? block.offset + blockIndex : -1;
			if (blockIndex < 0 || blockIndex >= block.count || (identity[slot] >>> 0) !== (set.keys[i] >>> 0)) {
				effKind = -1;
				blockIndex = 0;
			}
		}
		let snapshotComp = -1;
		if (effKind === planets.BLOCK_FIELD && blockIndex < field.count) snapshotComp = field.component[blockIndex];
		else if (effKind === planets.BLOCK_OBJECT && blockIndex < memberMeta.component.length) {
			const c = memberMeta.component[blockIndex];
			snapshotComp = c < 0 ? density.COMPONENT_THIN : c;
		}
		setStars.push({
			key: set.keys[i] >>> 0, kind: effKind, index: blockIndex,
			x: set.x[i], y: set.y[i], z: set.z[i],
			colorIndex: set.colorIndex[i], absMag: set.absMag[i],
			snapshot: {
				mass: set.mass[i], lum: set.lum[i], teff: set.teff[i],
				age: set.age[i], metal: set.metal[i],
			},
			snapshotComp,
		});
	}
	const SET_BATTERY = [
		filterFrom(() => {}),
		filterFrom((f) => { f.classes = M; }),
		filterFrom((f) => { f.states = searchLib.STATE_MS; }),
		filterFrom((f) => { f.lumMin = 0.5; f.lumMax = 2; }),
		filterFrom((f) => { f.components = searchLib.COMP_THIN; }),
		searchLib.parseFilter('terran'),
		searchLib.parseFilter('tsurf:180-320'),
		searchLib.parseFilter('barren'),
		filterFrom((f) => { f.classes = G | K; f.terranOnly = true; }),
	];
	let failures = 0;
	for (const f of SET_BATTERY) {
		res = search.run(f, {
			scope: 'selection', camX: cam[0], camY: cam[1], camZ: cam[2],
			model, renderer, set,
		});
		const expected = bruteRun(setStars, f, cam[0], cam[1], cam[2]);
		const kept = expected.slice(0, searchLib.MAX_RESULTS).sort((a, b) => a.d2 - b.d2);
		let bad = '';
		if (expected.length !== res.stats.matched) bad = `matched ${res.stats.matched} != brute ${expected.length}`;
		else if (res.count !== kept.length) bad = `kept ${res.count}`;
		else {
			for (let i = 0; i < res.count; i++) {
				const s = kept[i].star;
				if (res.keys[i] !== (s.key >>> 0) || res.kind[i] !== s.kind) { bad = `row ${i} identity`; break; }
				const o = i * 5;
				if (res.starProps[o] !== s.snapshot.mass || res.starProps[o + 1] !== s.snapshot.lum
					|| res.starProps[o + 2] !== s.snapshot.teff || res.starProps[o + 3] !== s.snapshot.age
					|| res.starProps[o + 4] !== s.snapshot.metal) { bad = `row ${i} snapshot props`; break; }
				if (kept[i].planet) {
					const beltsOk = res.nBelts[i] === kept[i].planet.nBelts
						|| (f.barrenOnly && res.nBelts[i] === searchLib.COUNT_UNKNOWN);
					if (res.nPlanets[i] !== kept[i].planet.nPlanets || !beltsOk) { bad = `row ${i} counts`; break; }
					const b = i * 4;
					if (kept[i].planet.best) {
						for (let p = 0; p < 4; p++) {
							if (res.best[b + p] !== kept[i].planet.best[p]) { bad = `row ${i} best`; break; }
						}
						if (bad) break;
					}
				}
			}
		}
		if (bad) {
			failures++;
			check(`set battery: ${searchLib.formatFilter(f) || '(empty)'}`, false, bad);
		}
	}
	check(`the ${SET_BATTERY.length}-filter set battery matches the set-aware brute force (snapshot props kept)`,
		failures === 0);
}

// --- 7. Known answers: landmarks by distance -----------------------------------
{
	const search = searchLib.createSearch();
	const cam = camera.cameraPos;
	// The camera stands 5 pc above the Sun; landmark distances are from the
	// origin, so the query runs from the origin, not the camera.
	const res = search.run(filterFrom((f) => { f.distMin = 0; f.distMax = 10; }), {
		scope: 'galaxy', camX: 0, camY: 0, camZ: 0,
		model, renderer, set: null,
	});
	// Every in-range landmark is matched, every matched landmark is in range.
	const matchedLandmarks = new Set();
	for (let i = 0; i < res.count; i++) {
		if (res.kind[i] === planets.BLOCK_LANDMARK) matchedLandmarks.add(res.index[i]);
	}
	let missing = 0;
	let extra = 0;
	let inRange = 0;
	for (let i = 0; i < landmarks.count; i++) {
		const e = landmarks.ENTRIES[i];
		const dLy = Math.hypot(e.x, e.y, e.z) * LY_PER_KPC;
		if (dLy <= 10) {
			inRange++;
			if (!matchedLandmarks.has(i)) missing++;
		} else if (matchedLandmarks.has(i)) extra++;
	}
	check('a 10 ly distance filter finds exactly the landmarks within 10 ly',
		inRange > 0 && missing === 0 && extra === 0, { inRange, missing, extra });
}

// --- 8. Degrade, never throw ---------------------------------------------------
{
	const search = searchLib.createSearch();
	const cam = camera.cameraPos;
	const env = { scope: 'galaxy', camX: cam[0], camY: cam[1], camZ: cam[2], model, renderer, set: null };
	const emptyBlocks = {
		starBlocks: () => ({ identity, view, blocks: [], total: 0, dynamicVersion: 0 }),
		fieldBuffers: () => null,
	};
	const noField = { starBlocks: () => info };
	let ok = true;
	try {
		ok = ok && search.run(null, env).count === 0;
		ok = ok && search.run(searchLib.createFilter(), null).count === 0;
		ok = ok && search.run(searchLib.createFilter(), {}).count === 0;
		ok = ok && search.run(searchLib.createFilter(), Object.assign({}, env, { renderer: emptyBlocks })).count === 0;
		ok = ok && search.run(searchLib.createFilter(), Object.assign({}, env, { renderer: noField })).stats.scanned === TOTAL;
		const impossible = filterFrom((f) => { f.lumMin = 10; f.lumMax = 1; });
		ok = ok && search.run(impossible, env).stats.matched === 0;
	} catch (err) {
		ok = false;
		check('degrade detail', false, err.message);
	}
	check('null filter/env/renderer, empty blocks and impossible ranges return empty, never throw', ok);
	check('the results object is reused across runs (no per-run allocation)',
		search.run(searchLib.createFilter(), env) === search.results
		&& search.results === search.results);
}

// --- 9. Pins -------------------------------------------------------------------
{
	check('the ly→kpc fallback carries camera.js digits',
		cameraLib.LY_TO_KPC === 0.000306601, cameraLib.LY_TO_KPC);
	check('COMP_* are the density component ids as bits',
		searchLib.COMP_THIN === (1 << density.COMPONENT_THIN)
		&& searchLib.COMP_THICK === (1 << density.COMPONENT_THICK)
		&& searchLib.COMP_BULGE === (1 << density.COMPONENT_BULGE)
		&& searchLib.COMP_HALO === (1 << density.COMPONENT_HALO));
	check('the state bits are three distinct powers of two',
		(searchLib.STATE_MS | searchLib.STATE_GIANT | searchLib.STATE_WD) === 7
		&& (searchLib.STATE_MS & searchLib.STATE_GIANT) === 0
		&& (searchLib.STATE_MS & searchLib.STATE_WD) === 0
		&& (searchLib.STATE_GIANT & searchLib.STATE_WD) === 0);
	check('ten spectral classes fit the u32 classes mask',
		records.SPECTRAL_CLASSES.length === 10
		&& (1 << records.SPECTRAL_CLASSES.length) <= 0x100000000);
}

// --- 10. Timings at 300k -------------------------------------------------------
// Budgets (plan §5.3): star-only galaxy < 120 ms, planet galaxy < 600 ms,
// selection scope (214 stars) < 2 ms. Min-of-3 after a warmup run, the
// star-select convention; this run prints the live figures.
{
	const BIG_N = 300000;
	const bigStaging = new ArrayBuffer(BIG_N * records.RECORD_BYTES);
	const bigView = new DataView(bigStaging);
	const bigIdentity = new Uint32Array(BIG_N);
	const big = sampling.sampleGalaxyStars(model, model.seed | 0, BIG_N, null);
	const derived = {};
	const tBuild = Date.now();
	for (let i = 0; i < BIG_N; i++) {
		const key = starTypes.fieldStarSeed(model.seed, i);
		starTypes.deriveStar(model, key, big.component[i], big.R[i], big.distToArm[i], derived, big.z[i]);
		records.writeRecord(bigView, i * records.RECORD_BYTES, big.x[i], big.y[i], big.z[i],
			derived.colorIndex, derived.absMag,
			orbit.flagsWithFamily(records.FLAG_VISIBLE, orbit.familyForStar(big.component[i], derived.spectralClass, model.barred)), 0);
		bigIdentity[i] = key;
	}
	const buildMs = Date.now() - tBuild;
	const bigBlocks = [{ kind: 'field', offset: 0, count: BIG_N }];
	const bigRenderer = {
		starBlocks: () => ({ identity: bigIdentity, view: bigView, blocks: bigBlocks, total: BIG_N, dynamicVersion: 1, member: null }),
		fieldBuffers: () => big,
	};
	const search = searchLib.createSearch();
	const cam = camera.cameraPos;
	const time = (f, e) => {
		search.run(f, e);
		let best = Infinity;
		for (let r = 0; r < 3; r++) {
			const t0 = performance.now();
			const res = search.run(f, e);
			const wall = performance.now() - t0;
			// The stats of the fastest run, copied: res.stats is the
			// search's own object, reused by the next run. Comparing the
			// first (coldest) run's timers against the best wall would let
			// the parts exceed the whole.
			if (wall < best) {
				best = wall;
				time.last = Object.assign({}, res.stats);
			}
		}
		return best;
	};
	const classG = filterFrom((f) => { f.classes = searchLib.classBit('G'); });
	const terranG = searchLib.parseFilter('G|terran');
	const tsurf = searchLib.parseFilter('tsurf:180-320');
	const loose = searchLib.parseFilter('teq:-5000');
	const env = { scope: 'galaxy', camX: cam[0], camY: cam[1], camZ: cam[2], model, renderer: bigRenderer, set: null };
	const msClass = time(classG, env);
	const stClass = time.last;
	const msTerran = time(terranG, env);
	const stTerran = time.last;
	const msTsurf = time(tsurf, env);
	const stTsurf = time.last;
	const msLoose = time(loose, env);
	const stLoose = time.last;
	// Selection scope: 214 members off the big field (plan §5.3's example size).
	const bigSet = starSetLib.createStarSet();
	{
		const pick = {};
		const ins = planets.createStellarInputs();
		for (let i = 0; i < 214; i++) {
			const index = i * 1401;
			const rec = records.readRecord(bigView, index * records.RECORD_BYTES);
			pick.key = bigIdentity[index] >>> 0; pick.kind = 0; pick.index = index;
			pick.x = rec.x; pick.y = rec.y; pick.z = rec.z;
			pick.colorIndex = rec.colorIndex; pick.absMag = rec.absMag;
			planets.stellarInputs(pick, { model, field: big, member: null }, ins);
			bigSet.insert(pick, ins, cam[0], cam[1], cam[2], index);
		}
	}
	const setEnv = Object.assign({}, env, { scope: 'selection', set: bigSet });
	const onlyTerran = searchLib.parseFilter('terran');
	const msSet = time(onlyTerran, setEnv);
	const stSet = time.last;
	console.log(`300k: build ${buildMs} ms  ` +
		`class-G ${msClass.toFixed(1)} ms (scanned ${stClass.scanned}, matched ${stClass.matched})  ` +
		`G+terran ${msTerran.toFixed(1)} ms (matched ${stTerran.matched})  ` +
		`tsurf ${msTsurf.toFixed(1)} ms (matched ${stTsurf.matched})  ` +
		`loose-teq ${msLoose.toFixed(1)} ms (matched ${stLoose.matched})  ` +
		`set-214 ${msSet.toFixed(2)} ms (matched ${stSet.matched})`);
	check('star-only class filter over the galaxy stays under 120 ms', msClass < 120, msClass);
	check('planet filter (G + terran) over the galaxy stays under 600 ms', msTerran < 600, msTerran);
	check('planet filter (tsurf range, exact refine) over the galaxy stays under 600 ms', msTsurf < 600, msTsurf);
	check('planet filter over a 214-star set stays under 2 ms', msSet < 2, msSet);
	check('the stage timers split the wall time (sort + overhead bounded)',
		(() => {
			const sum = stTsurf.msStage1 + stTsurf.msStage2 + stTsurf.msRefine;
			return sum <= msTsurf + 1 && msTsurf - sum < 100;
		})(), { msStage1: stTsurf.msStage1, msStage2: stTsurf.msStage2, msRefine: stTsurf.msRefine, wall: msTsurf });
}

// --- Report --------------------------------------------------------------------
const failed = checks.filter((c) => !c.pass).length;
for (const c of checks) console.log(`${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.pass || c.detail === undefined ? '' : ': ' + JSON.stringify(c.detail)}`);
console.log(`\n${checks.length - failed}/${checks.length} passed`);
fs.mkdirSync(path.join(__dirname, 'logs'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'logs/search.json'), JSON.stringify({ checks, failed }, null, 2) + '\n');
process.exitCode = failed ? 1 : 0;
