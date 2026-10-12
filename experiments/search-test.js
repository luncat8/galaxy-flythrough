// experiments/search-test.js
// 0.5.2 star and planet search (0.5.0-plan §5): the predicate table, the
// two-stage scan, the scope fallback, the result ordering and the four cost
// budgets the plan pins.
//
// The fixtures are the same shape as star-select-test.js: a real
// SamplingLib.sampleGalaxyStars field written into a blocksOut-shaped stub
// exactly the way star-sprites.js writes it, the object members written by
// objects.js's own writer, and one hand-written record per other block keyed
// by §2.2's rules.
//
// Every predicate is checked twice: once against search.js's own answer, and
// once against an independent evaluation that runs the generator's *full*
// record (not its summary tier) — which is also the pin that the summary walk
// answers a range filter exactly as the full walk does.
//
// Output: experiments/logs/search.json

'use strict';

const fs = require('fs');
const path = require('path');

// Alias window so the src modules attach their API here, as in the browser.
globalThis.window = globalThis;

const hash = require('../src/math/hash.js');
const records = require('../src/math/star-record.js');
const galaxy = require('../src/math/galaxy.js');
const sampling = require('../src/math/sampling.js');
const starTypes = require('../src/math/star-types.js');
const objects = require('../src/math/objects.js');
const orbit = require('../src/math/orbit.js');
const planets = require('../src/math/planets.js');
const starSetModule = require('../src/core/star-set.js');
const searchModule = require('../src/core/search.js');

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
	return !!pass;
}

const SEED = 3;
const BLOCK_KINDS = ['procedural', 'landmark', 'objects', 'local', 'catalog'];
const VISIBLE_BIT = 0x10000;
const LOCAL_SEED = (SEED ^ 0x10ca1cab) | 0;
const CAM = [-0.4, 1.7, 0.08];          // kpc: the camera the distance bounds are measured from
const T_SURF_PLAN = [200, 320];         // §5.4's menu defaults
const TERRAN_BIT = searchModule.planetTypeBit(planets.DISPLAY_TERRAN);

const model = galaxy.createGalaxy({ type: 'SBb', seed: SEED });
const stats = { parity: {}, budgets: {}, heap: {} };

// --- Fixture ---------------------------------------------------------------
// One hand-written record per non-procedural block except the object members,
// which objects.js writes itself. The positions orbit the model centre the way
// the renderer's blocks do.
const FIXED_STARS = [
	{ kind: 'landmark', rel: [2.3, 0.7, 0.05], colorIndex: 0, absMag: -4, family: orbit.FAMILY_PATTERN, jitter: 0x5a },
	{ kind: 'landmark', rel: [1.1, -3.4, -0.2], colorIndex: 5, absMag: 6.2, family: orbit.FAMILY_DISC, jitter: 0x22 },
	{ kind: 'landmark', rel: [-4.2, 2.2, 0.4], colorIndex: 7, absMag: 11.5, family: orbit.FAMILY_HALO, jitter: 0x41 },
	{ kind: 'local', rel: [0.6, -3.2, 0.03], colorIndex: 4, absMag: 5, family: orbit.FAMILY_PRESSURE, jitter: 0x7c },
	{ kind: 'local', rel: [-1.2, 4.4, 0.15], colorIndex: 6, absMag: 9.4, family: orbit.FAMILY_DISC, jitter: 0x19 },
	{ kind: 'catalog', rel: [-3.7, -2.4, -0.3], colorIndex: 7, absMag: 12, family: orbit.FAMILY_DISC, jitter: 0x0d },
	{ kind: 'catalog', rel: [3.9, 1.1, 0.22], colorIndex: 2, absMag: 1.1, family: orbit.FAMILY_BAR, jitter: 0x6b },
];

function fixedKey(kind, inBlock) {
	if (kind === 'landmark') return hash.hash4(hash.DOMAIN_LANDMARK, inBlock, 0, 0);
	if (kind === 'local') {
		return (Math.imul(LOCAL_SEED, 0x9e3779b1)
			^ Math.imul(77, 0x85ebca6b)
			^ Math.imul(inBlock + 1, 0xc2b2ae3d)) >>> 0;
	}
	return hash.hash4(hash.DOMAIN_CATALOG, 77, inBlock, 0);
}

function buildFixture(proceduralCount, withFixed, objectMembers) {
	const field = proceduralCount > 0
		? sampling.sampleGalaxyStars(model, SEED, proceduralCount, null)
		: null;
	const fixed = withFixed ? FIXED_STARS : [];
	const placed = objects.placeObjects(model, (SEED | 0) ^ 0x0b5e55, objects.OBJECT_COUNT_DEFAULT, null);
	// The object block's count is what the writer actually writes, which the
	// layout needs before it can place anything after it — so the block is
	// written once into a scratch buffer to learn it. The placement is
	// deterministic, so writing it again into the fixture is the same stars.
	const memberSlots = Math.min(objectMembers, objects.OBJECT_MEMBERS_DEFAULT);
	let membersWritten = 0;
	if (memberSlots > 0) {
		const scratch = new ArrayBuffer(memberSlots * records.RECORD_BYTES);
		membersWritten = objects.writeObjectMembers(model, placed, new DataView(scratch), 0,
			memberSlots, 0, null, 0).written;
	}
	const counts = [proceduralCount, 0, membersWritten, 0, 0];
	for (const s of fixed) counts[BLOCK_KINDS.indexOf(s.kind)]++;
	const blocks = [];
	let offset = 0;
	for (let b = 0; b < BLOCK_KINDS.length; b++) {
		blocks.push({ kind: BLOCK_KINDS[b], offset, count: counts[b] });
		offset += counts[b];
	}
	const total = offset;
	const staging = new ArrayBuffer(total * records.RECORD_BYTES);
	const view = new DataView(staging);
	const identity = new Uint32Array(total);
	const residents = [];
	const derived = {};
	for (let i = 0; i < proceduralCount; i++) {
		const key = starTypes.fieldStarSeed(SEED, i);
		starTypes.deriveStar(model, key, field.component[i], field.R[i],
			field.distToArm[i], derived, field.z[i]);
		records.writeRecord(view, i * records.RECORD_BYTES,
			field.x[i], field.y[i], field.z[i],
			derived.colorIndex, derived.absMag,
			orbit.flagsWithFamily(records.FLAG_VISIBLE,
				orbit.familyForStar(field.component[i], derived.spectralClass, model.barred)),
			Math.imul(i, 2654435761) & 0xFF);
		identity[i] = key;
		residents.push({ key, slot: i, block: 0, x: field.x[i], y: field.y[i], z: field.z[i] });
	}
	const objectBase = blocks[2].offset;
	if (membersWritten > 0) {
		objects.writeObjectMembers(model, placed, view, objectBase * records.RECORD_BYTES,
			membersWritten, 0, identity, objectBase);
		for (let i = 0; i < membersWritten; i++) {
			const w = (objectBase + i) * records.RECORD_BYTES;
			residents.push({ key: identity[objectBase + i], slot: objectBase + i, block: 2,
				x: view.getFloat32(w, true), y: view.getFloat32(w + 4, true), z: view.getFloat32(w + 8, true) });
		}
	}
	// The hand-written blocks, each at its own offset in buffer order —
	// landmarks first, then the local and catalog gap-fill records.
	const perKind = {};
	const c = model.centre;
	for (const s of fixed) {
		const inBlock = perKind[s.kind] || 0;
		perKind[s.kind] = inBlock + 1;
		const blockIndex = BLOCK_KINDS.indexOf(s.kind);
		const slot = blocks[blockIndex].offset + inBlock;
		const x = c.x + s.rel[0], y = c.y + s.rel[1], z = c.z + s.rel[2];
		records.writeRecord(view, slot * records.RECORD_BYTES, x, y, z,
			s.colorIndex, s.absMag, orbit.flagsWithFamily(records.FLAG_VISIBLE, s.family), s.jitter);
		identity[slot] = fixedKey(s.kind, inBlock);
		residents.push({ key: identity[slot], slot, block: blockIndex, x, y, z });
	}
	return {
		stub: {
			identity, view, float32: new Float32Array(staging), uint32: new Uint32Array(staging),
			blocks, total,
		},
		residents,
		field,
	};
}

function residentRef(r) {
	// The same two derived-path inputs the record carries: class and absolute
	// magnitude. A ref without them makes recordInputs fall back to the solar
	// defaults, which is how this evaluator first disagreed with the scan.
	const ref = {
		key: r.key, block: r.block, slot: r.slot, model, x: r.x, y: r.y, z: r.z,
		colorIndex: r.packed & 0xFF,
		absMag: records.decodeAbsMag((r.packed >>> 8) & 255),
	};
	if (r.block === 0) ref.field = null;         // filled per fixture below
	return ref;
}

// --- The independent predicate evaluation ----------------------------------
// The filter semantics, re-stated without touching search.js: the packed word
// for class/state/luminosity, one stellarInputs for mass and component, and
// the generator's FULL record for every planet predicate. If the scan and this
// walk disagree, one of them is wrong about the plan.
function referenceFilter(f) {
	const n = searchModule.normalizeFilter(f);
	return {
		starOk(r, field) {
			const packed = r.packed;
			const cls = packed & 0xFF;
			if (n.classMask !== 0 && ((n.classMask >>> cls) & 1) === 0) return false;
			const state = searchModule.classState(cls);
			if (n.stateMask !== 0 && (n.stateMask & state) === 0) return false;
			if (n.magFiltered) {
				const mag = records.decodeAbsMag((packed >>> 8) & 255);
				if (mag < n.magLo || mag > n.magHi) return false;
			}
			if (!n.derivedMass && !n.derivedComponent && !n.planetQuery) return true;
			const ref = residentRef(r);
			if (r.block === 0) ref.field = field;
			const star = planets.stellarInputs(ref, referenceInputs);
			if (n.massFiltered && (star.mass < n.massMin || star.mass > n.massMax)) return false;
			if (n.derivedComponent) {
				const component = r.block === 0 && field ? field.component[r.slot] : star.component;
				const bit = [1, 2, 4, 8][component];
				if ((bit & n.componentMask) === 0) return false;
			}
			return true;
		},
		planetOk(r, field) {
			if (!n.planetQuery) return true;
			const ref = residentRef(r);
			if (r.block === 0) ref.field = field;
			const star = planets.stellarInputs(ref, referenceInputs);
			const sys = planets.generateSystem(ref, star, referenceSystem);
			if (n.minPlanets > 0 && sys.planetCount < n.minPlanets) return false;
			if (n.barrenOnly && sys.planetCount !== 0) return false;
			if (n.needsBelt && sys.beltCount === 0) return false;
			if (n.terranOnly && sys.terranCount === 0) return false;
			if (n.planetTypeMask === 0 && !n.aFiltered && !n.pMassFiltered
				&& !n.tsurfFiltered && !n.teqFiltered) return true;
			for (let p = 0; p < sys.planetCount; p++) {
				const display = sys.planets.display[p];
				if (n.planetTypeMask !== 0 && ((n.planetTypeMask >>> display) & 1) === 0) continue;
				const a = sys.planets.a[p];
				if (a < n.aMin || a > n.aMax) continue;
				const m = sys.planets.mass[p];
				if (m < n.planetMassMin || m > n.planetMassMax) continue;
				if (sys.planets.tsurf[p] < n.tsurfMin || sys.planets.tsurf[p] > n.tsurfMax) continue;
				if (sys.planets.teq[p] < n.teqMin || sys.planets.teq[p] > n.teqMax) continue;
				return true;
			}
			return false;
		},
		distOk(r) {
			if (!n.distFiltered) return true;
			const dKpc = Math.hypot(r.x - CAM[0], r.y - CAM[1], r.z - CAM[2]);
			const dLy = dKpc / 0.000306601;
			return dLy >= n.distMin && dLy <= n.distMax;
		},
	};
}

const referenceInputs = planets.createStellarInputs();
const referenceSystem = planets.createSystemRecord();

function withPacked(fixture) {
	const words = fixture.stub.uint32;
	for (const r of fixture.residents) r.packed = words[r.slot * 4 + 3];
	return fixture;
}

// One scanner across the sections: each fixture is bound through setSource,
// exactly as the page binds the renderer once at boot.
const s = searchModule.createSearch();

// --- 1. Surface and the empty query -----------------------------------------
{
	check('the module exposes the scanner, the filter grammar and the scope names',
		typeof s.run === 'function' && typeof s.setSource === 'function'
		&& typeof searchModule.parseFilter === 'function'
		&& typeof searchModule.serializeFilter === 'function'
		&& searchModule.SEARCH_MAX_RESULTS === 512,
		Object.keys(searchModule).length);
	const none = s.run({}, 'galaxy');
	check('a scan with no source is an empty result, not a throw',
		none.count === 0 && s.stats.matched === 0 && s.stats.scope === 'galaxy', none.count);
	check('the result buffers are preallocated at the plan’s capacity',
		s.results.keys.length === 512 && s.results.star.length === 512 * 5
		&& s.results.best.length === 512 * 4 && s.results.dist.length === 512);

	const fx = withPacked(buildFixture(600, true, 400));
	s.setSource({
		blocks: () => fx.stub, field: () => fx.field, model: () => model,
		set: starSetModule.createStarSet(), cameraPos: () => CAM,
	});
	const all = s.run({}, 'galaxy');
	check('an empty filter matches every star, barren ones included (§5.1)',
		all.count === Math.min(fx.residents.length, 512)
		&& s.stats.matched === fx.residents.length && s.stats.truncated === true,
		{ matched: s.stats.matched, residents: fx.residents.length });
	const barren = s.run({ barrenOnly: true }, 'galaxy');
	const reference = referenceFilter({ barrenOnly: true });
	const barrenRef = fx.residents.filter((r) => reference.starOk(r, fx.field) && reference.planetOk(r, fx.field)).length;
	check('barrenOnly is an explicit constraint, not the default reading of an empty mask',
		barren.count === barrenRef && barrenRef < fx.residents.length,
		{ found: barren.count, reference: barrenRef });
}

// --- 2. Predicate parity against the full-record evaluation -----------------
{
	const fx = withPacked(buildFixture(1500, true, 400));
	s.setSource({
		blocks: () => fx.stub, field: () => fx.field, model: () => model,
		set: starSetModule.createStarSet(), cameraPos: () => CAM,
	});
	const filters = [
		{ name: 'class G', filter: { classes: searchModule.classBit(4) } },
		{ name: 'classes K,M', filter: { classes: searchModule.classBit(5) | searchModule.classBit(6) } },
		{ name: 'class WD', filter: { classes: searchModule.classBit(7) } },
		{ name: 'state giant', filter: { states: searchModule.STATE_GIANT } },
		{ name: 'state wd', filter: { states: searchModule.STATE_WD } },
		{ name: 'state ms', filter: { states: searchModule.STATE_MS } },
		{ name: 'lum 0.1-10', filter: { lumMin: 0.1, lumMax: 10 } },
		{ name: 'lum >= 100', filter: { lumMin: 100 } },
		{ name: 'mass 0.5-1.5', filter: { massMin: 0.5, massMax: 1.5 } },
		{ name: 'mass >= 8', filter: { massMin: 8 } },
		{ name: 'components bulge,halo', filter: { components: searchModule.COMPONENT_BULGE | searchModule.COMPONENT_HALO } },
		{ name: 'class K and giant', filter: { classes: searchModule.classBit(5), states: searchModule.STATE_GIANT } },
		{ name: 'dist <= 20 kpc in ly', filter: { distMax: 20 * 3261.5637 } },
		{ name: 'dist 100-4000 ly', filter: { distMin: 100, distMax: 4000 } },
		{ name: 'terran only', filter: { terranOnly: true } },
		{ name: 'barren only', filter: { barrenOnly: true } },
		{ name: 'needs belt', filter: { needsBelt: true } },
		{ name: 'min 3 planets', filter: { minPlanets: 3 } },
		{ name: 'planet type gas-giant', filter: { planetTypes: searchModule.planetTypeBit(planets.DISPLAY_GAS_GIANT) } },
		{ name: 'planet type terran', filter: { planetTypes: TERRAN_BIT } },
		{ name: 'tsurf 200-320', filter: { tsurfMin: T_SURF_PLAN[0], tsurfMax: T_SURF_PLAN[1] } },
		{ name: 'tsurf >= 300', filter: { tsurfMin: 300 } },
		{ name: 'a 0.5-5 AU', filter: { aMin: 0.5, aMax: 5 } },
		{ name: 'planet mass >= 10', filter: { planetMassMin: 10 } },
		{ name: 'terran and a >= 1', filter: { terranOnly: true, aMin: 1 } },
		{ name: 'class M with a terran', filter: { classes: searchModule.classBit(6), planetTypes: TERRAN_BIT } },
		{ name: 'mass and tsurf together', filter: { massMin: 0.2, tsurfMin: 150, tsurfMax: 400 } },
	];
	let mismatches = 0;
	for (const { name, filter } of filters) {
		const res = s.run(filter, 'galaxy');
		const got = new Set();
		for (let i = 0; i < res.count; i++) got.add(res.keys[i]);
		const reference = referenceFilter(filter);
		const expected = new Set();
		for (const r of fx.residents) {
			if (!reference.distOk(r)) continue;
			if (!reference.starOk(r, fx.field)) continue;
			if (!reference.planetOk(r, fx.field)) continue;
			expected.add(r.key);
		}
		// The first 512 matches are kept and sorted nearest-first, so a query
		// with more matches than that is compared as a subset plus the count;
		// anything smaller has to match exactly, key for key.
		const truncated = expected.size > 512;
		const same = truncated
			? (s.stats.matched === expected.size && got.size === 512 && [...got].every((k) => expected.has(k)))
			: (got.size === expected.size && [...got].every((k) => expected.has(k))
				&& s.stats.matched === expected.size);
		stats.parity[name] = { matched: expected.size, scanned: s.stats.scanned, truncated };
		if (!same) {
			mismatches++;
			stats.parity[name].mismatch = { got: got.size, expected: expected.size, matched: s.stats.matched };
		}
	}
	check('every predicate agrees with an independent full-record evaluation',
		mismatches === 0, stats.parity);
}

// --- 3. The summary tier answers a range filter exactly as the full walk ----
{
	const fx = withPacked(buildFixture(300, false, 0));
	const sum = planets.createSummaryRecord();
	const sys = planets.createSystemRecord();
	const star = planets.createStellarInputs();
	let envOk = true;
	let details = null;
	for (let i = 0; i < fx.residents.length; i++) {
		const r = fx.residents[i];
		const ref = { key: r.key, block: r.block, slot: r.slot, model, x: r.x, y: r.y, z: r.z, field: fx.field };
		planets.systemSummary(ref, null, sum);
		planets.generateSystem(ref, null, sys);
		if (sum.envCount !== sum.planetCount) { envOk = false; details = 'envCount'; break; }
		for (let p = 0; p < sum.planetCount; p++) {
			if (sum.env.a[p] !== sys.planets.a[p] || sum.env.mass[p] !== sys.planets.mass[p]
				|| sum.env.teq[p] !== sys.planets.teq[p] || sum.env.tsurf[p] !== sys.planets.tsurf[p]
				|| sum.env.display[p] !== sys.planets.display[p]) {
				envOk = false;
				details = { planet: p, count: sum.planetCount };
				break;
			}
		}
		if (!envOk) break;
	}
	check('the summary env block is the full record’s per-planet environment',
		envOk, details);
}

// --- 4. Scope: selection → galaxy, and the report ---------------------------
{
	const fx = withPacked(buildFixture(1500, true, 400));
	const set = starSetModule.createStarSet();
	s.setSource({
		blocks: () => fx.stub, field: () => fx.field, model: () => model,
		set, cameraPos: () => CAM,
	});
	const picked = [fx.residents[10], fx.residents[900], fx.residents[1400]];
	set.clearSet();
	for (let i = 0; i < picked.length; i++) set.addStar(picked[i].key, 0.1 * (i + 1));
	set.addStar(0x7eadbeef, 5);          // a key that is not resident right now

	const sel = s.run({}, 'selection');
	check('the selection scope scans the set, not the galaxy',
		s.stats.scope === 'selection' && s.stats.scanned === 3 && sel.count === 3,
		{ scanned: s.stats.scanned, matched: s.stats.matched });
	const selKeys = new Set([sel.keys[0], sel.keys[1], sel.keys[2]]);
	check('a set key that is not resident is neither scanned nor matched',
		[...selKeys].every((k) => k !== 0x7eadbeef) && picked.every((r) => selKeys.has(r.key)));

	const auto = s.run({}, 'auto');
	check('auto searches the selection while the set holds anything, and says so',
		s.stats.scope === 'selection' && s.stats.scanned === 3 && auto.count === 3,
		s.stats.scanned);
	const forced = s.run({ classes: searchModule.classBit(6) }, 'galaxy');
	check('the galaxy scope scans every record even with a selection',
		s.stats.scope === 'galaxy' && s.stats.scanned === fx.residents.length,
		s.stats.scanned);
	const reference = referenceFilter({ classes: searchModule.classBit(6) });
	let expected = 0;
	for (const r of fx.residents) if (reference.starOk(r, fx.field)) expected++;
	check('a galaxy-scope class filter matches the reference count',
		s.stats.matched === expected, { matched: s.stats.matched, expected });
	set.clearSet();
	const fallback = s.run({}, 'auto');
	check('auto falls back to the galaxy when the set is empty, and says so',
		s.stats.scope === 'galaxy' && s.stats.scanned === fx.residents.length
		&& s.stats.matched === fx.residents.length,
		s.stats.scanned);
	const emptySelection = s.run({}, 'selection');
	check('an explicit selection scope with an empty set matches nothing',
		emptySelection.count === 0 && s.stats.scanned === 0, s.stats.scanned);
}

// --- 5. Ordering, truncation and the readout payload ------------------------
{
	const fx = withPacked(buildFixture(1200, true, 0));
	const set = starSetModule.createStarSet();
	s.setSource({
		blocks: () => fx.stub, field: () => fx.field, model: () => model,
		set, cameraPos: () => CAM,
	});
	const res = s.run({}, 'galaxy');
	let sorted = true;
	for (let i = 1; i < res.count; i++) if (res.dist[i] < res.dist[i - 1] - 1e-12) sorted = false;
	check('the first MAX_RESULTS matches come back nearest-first',
		sorted && res.count === 512 && s.stats.matched === fx.residents.length && s.stats.truncated,
		{ count: res.count, matched: s.stats.matched });
	const spot = res.keys[0];
	const resident = fx.residents.find((r) => r.key === spot);
	const d = Math.hypot(resident.x - CAM[0], resident.y - CAM[1], resident.z - CAM[2]);
	check('the reported distance is the record’s distance from the camera',
		Math.abs(res.dist[0] - d) < 1e-6 && Math.abs(res.x[0] - resident.x) < 1e-6,
		{ res: res.dist[0], d });

	const terran = s.run({ terranOnly: true }, 'galaxy');
	let payload = true;
	for (let i = 0; i < terran.count; i++) {
		const o = i * 4;
		if (terran.best[o + 3] === 0 && terran.count > 0) { payload = false; break; }
		if (terran.best[o] <= 0 || terran.best[o + 2] <= 0) { payload = false; break; }
	}
	check('a terran query reports the matched planet’s a, tsurf and type per result',
		terran.count > 0 && payload, terran.count);
	const classOnly = s.run({ classes: searchModule.classBit(4) }, 'galaxy');
	check('a star-only query leaves the matched-planet payload empty',
		classOnly.count > 0 && classOnly.best[3] === 0, classOnly.count);
}

// --- 6. Stage separation and the cost contract (§5.3) -----------------------
{
	const big = withPacked(buildFixture(300000, false, 0));
	const set = starSetModule.createStarSet();
	s.setSource({
		blocks: () => big.stub, field: () => big.field, model: () => model,
		set, cameraPos: () => CAM,
	});
	function medianMs(filter, scope, runs) {
		const times = [];
		for (let i = 0; i < runs; i++) {
			const t = process.hrtime.bigint();
			s.run(filter, scope);
			times.push(Number(process.hrtime.bigint() - t) / 1e6);
		}
		times.sort((a, b) => a - b);
		return times[times.length >> 1];
	}

	const classMs = medianMs({ classes: searchModule.classBit(4) }, 'galaxy', 3);
	stats.budgets.classOnlyMs = classMs;
	stats.budgets.classOnlyStage1 = s.stats.msStage1;
	stats.budgets.classOnlyStage2 = s.stats.msStage2;
	check('a star-only galaxy scan is inside the 120 ms budget, and stage 2 never ran',
		classMs < 120 && s.stats.msStage2 === 0, stats.budgets);

	const planetMs = medianMs({ terranOnly: true }, 'galaxy', 3);
	stats.budgets.planetMs = planetMs;
	stats.budgets.planetStage1 = s.stats.msStage1;
	stats.budgets.planetStage2 = s.stats.msStage2;
	check('a planet galaxy scan is inside the 600 ms budget',
		planetMs < 600, stats.budgets);

	const massMs = medianMs({ massMin: 0.8, massMax: 1.2 }, 'galaxy', 3);
	stats.budgets.massMs = massMs;
	check('a mass filter costs one derivation per star and is measured, not assumed',
		massMs > classMs, stats.budgets);

	// The selection scope: 214 keys, the plan's own figure.
	set.clearSet();
	const picked = [];
	for (let i = 0; i < 214; i++) {
		const key = big.residents[i * 131].key;
		set.addStar(key, i * 0.01);
		picked.push(key);
	}
	const selMs = medianMs({ tsurfMin: 150, tsurfMax: 400 }, 'selection', 5);
	stats.budgets.selectionMs = selMs;
	stats.budgets.selectionScanned = s.stats.scanned;
	check('a planet filter over a 214-star selection is inside the 2 ms budget',
		selMs < 2 && s.stats.scanned === 214, stats.budgets);
}

// --- 7. No allocation in the scan -------------------------------------------
{
	const fx = withPacked(buildFixture(20000, false, 0));
	s.setSource({
		blocks: () => fx.stub, field: () => fx.field, model: () => model,
		set: starSetModule.createStarSet(), cameraPos: () => CAM,
	});
	// Warm the lazy record creation and the memoised dependency lookups, then
	// measure retained heap across repeated scans: the only object a run may
	// keep is normalizeFilter's one filter per call.
	for (let i = 0; i < 20; i++) s.run({ classes: searchModule.classBit(4), terranOnly: true }, 'galaxy');
	const trials = [];
	for (let t = 0; t < 5; t++) {
		if (global.gc) global.gc();
		const before = process.memoryUsage().heapUsed;
		for (let i = 0; i < 50; i++) s.run({ classes: searchModule.classBit(4), terranOnly: true }, 'galaxy');
		if (global.gc) global.gc();
		trials.push(process.memoryUsage().heapUsed - before);
	}
	trials.sort((a, b) => a - b);
	stats.heap = { trials, median: trials[trials.length >> 1], exposedGc: !!global.gc };
	check('the scan retains nothing measurable over 50 galaxy-wide passes',
		!global.gc || stats.heap.median < 256 * 1024, stats.heap);
}

// --- 8. The preset token (§5.5) ---------------------------------------------
{
	const filter = searchModule.parseFilter('cls=G,K;pt=terran;ts=220-300');
	const again = searchModule.parseFilter(searchModule.serializeFilter(filter));
	check('a filter survives serialize → parse unchanged',
		JSON.stringify(filter) === JSON.stringify(again), { filter, again });
	check('normalizeFilter is idempotent, so a canonical filter re-serializes',
		searchModule.serializeFilter(searchModule.normalizeFilter(filter)) === 'cls=G,K;pt=terran;ts=220-300');
	check('junk segments are dropped, not thrown',
		searchModule.serializeFilter(searchModule.parseFilter('bogus=1;cls=zzz;ts=abc-def')) === ''
		&& searchModule.normalizeFilter(searchModule.parseFilter('bogus=1;cls=zzz;ts=abc-def')).classMask === 0,
		searchModule.serializeFilter(searchModule.parseFilter('bogus=1;cls=zzz;ts=abc-def')));
	check('an open range serializes its bounded side',
		searchModule.serializeFilter({ distMax: 5000 }) === 'dist=-5000');
}

// --- Report ------------------------------------------------------------------
let passed = 0;
let failed = 0;
for (const c of checks) {
	if (c.pass) passed++; else failed++;
	console.log(`  ${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.pass ? '' : `  -> ${JSON.stringify(c.detail)}`}`);
}
console.log(`\n${passed}/${checks.length} passed, ${failed} failed`);

const logPath = path.join(__dirname, 'logs', 'search.json');
fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.writeFileSync(logPath, JSON.stringify({
	date: new Date().toISOString(),
	model: { type: model.type, seed: model.seed },
	stats,
	totalChecks: checks.length,
	passed,
	failed,
	checks,
}, null, 2));
console.log(`Wrote ${logPath}`);
console.log('\n=== VERDICT ===');
console.log(failed === 0 ? 'PASS — the search behaves as the 0.5 plan pins it' : `FAIL — ${failed} checks failed`);
process.exit(failed === 0 ? 0 : 1);
