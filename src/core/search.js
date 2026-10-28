// src/core/search.js
// Star and planet search (0.5.2, plan §5). Pure: it takes an accessor (the
// renderer's starBlocks() + fieldBuffers() + the selection set) and a filter
// struct, and writes into preallocated result buffers. No DOM, no model.
//
// Two stages (plan §5.3). Stage 1 runs the star predicates — distance from the
// supplied centre (camera by default), spectral class, state, luminosity, mass,
// component — against the position the active engine draws at env.time. Birth
// coordinates remain the inputs to stellar derivation and the saved snapshot.
// Stage 2 runs `planets.systemSummary` only for
// survivors, and only when the filter carries a planet predicate at all.
//
// Two exact pre-filters keep the budgets without changing a single answer:
//
//   * Class/state on the three procedural blocks is the *derived* class (the
//     record's LUT slot is not the class: thin-disc main-sequence stars shift
//     one slot redder toward the rim, bulge giants land on RGe). Deriving all
//     300k stars costs ~0.7 µs each — over the 120 ms star-only budget — so a
//     record-slot pre-filter derives only stars whose slot could hold a masked
//     class (the slot itself, or one below it for the +1 shift, or RGe for an
//     RG mask). The derivation then confirms; the pre-filter can only pass
//     extra stars, never drop a match.
//   * `planetCount` with the slot's ceiling μ (the max over the slot's
//     candidate classes) is 0 only when the true count is 0 — the geometric
//     chain is monotone in μ and the architecture's repair only drops. A
//     count>0-requiring query skips the ~2 µs summary for every pre-check zero
//     (~55% of stars); a bare `barrenOnly` query confirms barren the same way
//     and never runs a summary at all. Belts are independent of planets, so
//     any query carrying `needsBelt` always runs the summary.
//
// Range predicates (tsurf/teq/pmass/a) are exact per planet, not
// extremes-overlap: the summary's extremes are the necessary condition, and
// every summary match is refined through `generateSystem` to find one planet
// satisfying all per-planet predicates together. Extremes alone return
// straddles — a 100 K and a 400 K planet bracketing a 180–320 K range — which
// is a false positive no result list may carry. Non-range planet queries are
// already exact at the summary level (histograms, counts), so they refine only
// the kept ≤ 512 for the display planet and its letter.
//
// A set member whose slot no longer holds its key (defensive only: the set
// clears on regenerate, so the page cannot produce one) resolves through the
// record path with kind −1, the existing stale convention — its slot index is
// never trusted for another star's derivation. Distances use the search-time
// drawn position; `approximated` marks the simple engine's GPU-only position gap.

(function () {
'use strict';

const searchPlanets = (typeof module !== 'undefined' && module.exports)
	? require('../math/planets.js')
	: ((typeof window !== 'undefined') ? window.PlanetsLib : null);
const searchRecords = (typeof module !== 'undefined' && module.exports)
	? require('../math/star-record.js')
	: ((typeof window !== 'undefined') ? window.StarRecord : null);
const searchHash = (typeof module !== 'undefined' && module.exports)
	? require('../math/hash.js')
	: ((typeof window !== 'undefined') ? window.HashLib : null);
const searchDensity = (typeof module !== 'undefined' && module.exports)
	? require('../math/density.js')
	: ((typeof window !== 'undefined') ? window.DensityLib : null);
const searchOrbit = (typeof module !== 'undefined' && module.exports)
	? require('../math/orbit.js')
	: ((typeof window !== 'undefined') ? window.OrbitLib : null);

// 1 ly in kpc. Owned by camera.js; the fallback carries camera.js's own digits
// for embeds that load this file without it, and search-test.js pins the two
// equal so they cannot drift.
const LY_TO_KPC_FALLBACK = 0.000306601;
function searchLyToKpc() {
	const cam = (typeof window !== 'undefined') ? window.Camera : null;
	if (cam && cam.LY_TO_KPC) return cam.LY_TO_KPC;
	if (typeof module !== 'undefined' && module.exports) {
		try {
			const camera = require('../core/camera.js');
			if (camera && camera.LY_TO_KPC) return camera.LY_TO_KPC;
		} catch (err) { /* the fallback below */ }
	}
	return LY_TO_KPC_FALLBACK;
}

// Plan §5.3's result buffers, allocated once. `index` is the block-local slot
// (what stellarInputs and the member context read); `kind` is the block, or
// KIND_UNRESOLVED (−1) for a set member whose slot no longer holds its key
// (record path, never another star's derivation); `dist2` is kpc² from the
// supplied centre's drawn position, the nearest-first sort key.
// `nPlanets`/`nBelts` are COUNT_UNKNOWN
// when the query ran no summary (a star-only filter has no planet facts);
// `best` holds the display planet's (a, mass, tsurf, type) with type
// BEST_NONE and NaNs when no planet is named.
const MAX_RESULTS = 512;
// The stage-1/stage-2 interleave quantum: survivors stage between the two
// phases in preallocated chunk arrays, and the two timers split at chunk
// boundaries. Any size gives identical results; 4096 keeps the staging small
// and the clock calls (~150 per galaxy scan) out of the noise.
const CHUNK = 4096;

const STATE_MS = 1;
const STATE_GIANT = 2;
const STATE_WD = 4;
const COMP_THIN = 1;
const COMP_THICK = 2;
const COMP_BULGE = 4;
const COMP_HALO = 8;
const SCOPE_SELECTION = 'selection';
const SCOPE_GALAXY = 'galaxy';
const KIND_UNRESOLVED = -1;
const BEST_NONE = 255;
const COUNT_UNKNOWN = 255;

function createFilter() {
	return {
		classes: 0, states: 0,
		lumMin: 0, lumMax: Infinity, massMin: 0, massMax: Infinity,
		distMin: 0, distMax: Infinity,
		components: 0,
		planetTypes: 0, terranOnly: false,
		tsurfMin: 0, tsurfMax: Infinity, teqMin: 0, teqMax: Infinity,
		planetMassMin: 0, planetMassMax: Infinity, aMin: 0, aMax: Infinity,
		minPlanets: 0, barrenOnly: false, needsBelt: false,
	};
}

function resetFilter(f) {
	f.classes = 0; f.states = 0;
	f.lumMin = 0; f.lumMax = Infinity; f.massMin = 0; f.massMax = Infinity;
	f.distMin = 0; f.distMax = Infinity;
	f.components = 0;
	f.planetTypes = 0; f.terranOnly = false;
	f.tsurfMin = 0; f.tsurfMax = Infinity; f.teqMin = 0; f.teqMax = Infinity;
	f.planetMassMin = 0; f.planetMassMax = Infinity; f.aMin = 0; f.aMax = Infinity;
	f.minPlanets = 0; f.barrenOnly = false; f.needsBelt = false;
	return f;
}

// Name → single bit, 0 when unknown. The classes bits are positions in
// StarRecord.SPECTRAL_CLASSES (bit i = the i-th class); states and components
// are the STATE_*/COMP_* ids above; planet types are positions in
// PlanetsLib.DISPLAY_TYPES.
function classBit(name) {
	if (!searchRecords) return 0;
	const i = searchRecords.SPECTRAL_CLASSES.indexOf(name);
	return i < 0 ? 0 : (1 << i);
}

function stateBit(name) {
	const n = String(name || '').toLowerCase();
	if (n === 'ms' || n === 'main-sequence' || n === 'mainsequence') return STATE_MS;
	if (n === 'giant' || n === 'rg') return STATE_GIANT;
	if (n === 'wd' || n === 'whitedwarf' || n === 'white-dwarf') return STATE_WD;
	return 0;
}

function componentBit(name) {
	const n = String(name || '').toLowerCase();
	if (n === 'thin') return COMP_THIN;
	if (n === 'thick') return COMP_THICK;
	if (n === 'bulge' || n === 'bar') return COMP_BULGE;
	if (n === 'halo') return COMP_HALO;
	return 0;
}

function planetTypeBit(name) {
	if (!searchPlanets) return 0;
	const i = searchPlanets.DISPLAY_INDEX[String(name || '').toUpperCase()];
	return i === undefined ? 0 : (1 << i);
}

// The preset token (plan §5.5), e.g. `G,K|terran|220-300`. Clauses join with
// `|`: `class:`/`state:`/`comp:`/`ptype:` comma lists, `lum:`/`mass:`/`dist:`
// /`tsurf:`/`teq:`/`pmass:`/`a:` lo-hi ranges with either end omissible,
// `terran`/`belt`/`barren` bare flags, `n:` the planet count. Bare clauses
// stay short for the common queries: a class list (`G,K`), a tsurf range
// (`220-300`), the three flags. Unknown clauses are ignored, so a hand-edited
// or newer token degrades to the clauses this version understands.
const TOKEN_RANGES = [
	['lum', 'lumMin', 'lumMax'], ['mass', 'massMin', 'massMax'],
	['dist', 'distMin', 'distMax'], ['tsurf', 'tsurfMin', 'tsurfMax'],
	['teq', 'teqMin', 'teqMax'], ['pmass', 'planetMassMin', 'planetMassMax'],
	['a', 'aMin', 'aMax'],
];

function tokenNumber(text, fallback) {
	if (text === undefined || text === null || text === '') return fallback;
	const v = Number(text);
	return Number.isFinite(v) ? v : fallback;
}

function parseRangeClause(f, clause, loKey, hiKey) {
	// Exactly one dash: `lo-hi` with either end omissible. Anything else
	// (`1-2-3`, a negative bound — every quantity here is ≥ 0) is ignored
	// rather than half-parsed.
	const parts = clause.split('-');
	if (parts.length !== 2) return;
	const lo = tokenNumber(parts[0].trim(), 0);
	const hi = tokenNumber(parts[1].trim(), Infinity);
	f[loKey] = lo < 0 ? 0 : lo;
	f[hiKey] = hi < 0 ? 0 : hi;
}

function parseListClause(text, bitOf) {
	let mask = 0;
	const parts = String(text || '').split(',');
	for (let i = 0; i < parts.length; i++) mask |= bitOf(parts[i].trim());
	return mask >>> 0;
}

function isClassList(text) {
	const parts = String(text).split(',');
	if (parts.length === 0) return false;
	for (let i = 0; i < parts.length; i++) {
		if (!classBit(parts[i].trim())) return false;
	}
	return true;
}

function parseFilter(token, out) {
	const f = resetFilter(out || createFilter());
	const clauses = String(token || '').split('|');
	for (let c = 0; c < clauses.length; c++) {
		const clause = clauses[c].trim();
		if (!clause) continue;
		const colon = clause.indexOf(':');
		const key = (colon < 0 ? clause : clause.slice(0, colon)).trim().toLowerCase();
		const value = colon < 0 ? '' : clause.slice(colon + 1).trim();
		if (key === 'class' || key === 'classes') f.classes |= parseListClause(value, classBit);
		else if (key === 'state' || key === 'states') f.states |= parseListClause(value, stateBit);
		else if (key === 'comp' || key === 'components') f.components |= parseListClause(value, componentBit);
		else if (key === 'ptype' || key === 'ptypes' || key === 'planettype' || key === 'planettypes') {
			f.planetTypes |= parseListClause(value, planetTypeBit);
		}
		else if (key === 'terran') f.terranOnly = true;
		else if (key === 'belt' || key === 'hasbelt' || key === 'needsbelt') f.needsBelt = true;
		else if (key === 'barren' || key === 'noplanets' || key === 'no-planets') f.barrenOnly = true;
		else if (key === 'n' || key === 'minplanets') {
			const n = Math.floor(tokenNumber(value, 0));
			f.minPlanets = n > 0 ? n : 0;
		}
		else {
			let ranged = false;
			for (let r = 0; r < TOKEN_RANGES.length; r++) {
				if (key === TOKEN_RANGES[r][0]) {
					parseRangeClause(f, value, TOKEN_RANGES[r][1], TOKEN_RANGES[r][2]);
					ranged = true;
					break;
				}
			}
			if (ranged) continue;
			// Bare clauses: the class list, the tsurf range, the three flags.
			if (colon < 0) {
				if (isClassList(clause)) f.classes |= parseListClause(clause, classBit);
				else if (clause.indexOf('-') >= 0) parseRangeClause(f, clause, 'tsurfMin', 'tsurfMax');
			}
			// Anything else is ignored (forward-compatible, hand-edit safe).
		}
	}
	f.classes >>>= 0; f.states >>>= 0; f.components >>>= 0; f.planetTypes >>>= 0;
	return f;
}

function formatRange(f, loKey, hiKey) {
	const lo = f[loKey];
	const hi = f[hiKey];
	if (!(lo > 0) && !(hi < Infinity)) return '';
	return (lo > 0 ? String(lo) : '') + '-' + (hi < Infinity ? String(hi) : '');
}

function formatList(mask, names) {
	const parts = [];
	for (let i = 0; i < names.length; i++) {
		if (((mask >>> 0) >>> i) & 1) parts.push(names[i]);
	}
	return parts.join(',');
}

function formatFilter(f) {
	if (!f) return '';
	const clauses = [];
	if (searchRecords && (f.classes | 0)) {
		clauses.push('class:' + formatList(f.classes, searchRecords.SPECTRAL_CLASSES));
	}
	if (f.states | 0) {
		const names = [];
		if ((f.states | 0) & STATE_MS) names.push('ms');
		if ((f.states | 0) & STATE_GIANT) names.push('giant');
		if ((f.states | 0) & STATE_WD) names.push('wd');
		clauses.push('state:' + names.join(','));
	}
	if (f.components | 0) {
		const names = [];
		if ((f.components | 0) & COMP_THIN) names.push('thin');
		if ((f.components | 0) & COMP_THICK) names.push('thick');
		if ((f.components | 0) & COMP_BULGE) names.push('bulge');
		if ((f.components | 0) & COMP_HALO) names.push('halo');
		clauses.push('comp:' + names.join(','));
	}
	for (let r = 0; r < TOKEN_RANGES.length; r++) {
		const text = formatRange(f, TOKEN_RANGES[r][1], TOKEN_RANGES[r][2]);
		if (text) clauses.push(TOKEN_RANGES[r][0] + ':' + text);
	}
	if (searchPlanets && (f.planetTypes | 0)) {
		const names = [];
		for (let i = 0; i < searchPlanets.DISPLAY_TYPES.length; i++) names.push(searchPlanets.DISPLAY_TYPES[i].name);
		clauses.push('ptype:' + formatList(f.planetTypes, names));
	}
	if (f.terranOnly) clauses.push('terran');
	if (f.needsBelt) clauses.push('belt');
	if (f.barrenOnly) clauses.push('barren');
	if ((f.minPlanets | 0) > 0) clauses.push('n:' + (f.minPlanets | 0));
	return clauses.join('|');
}

function createResults() {
	return {
		keys: new Uint32Array(MAX_RESULTS),
		kind: new Int8Array(MAX_RESULTS),
		index: new Uint32Array(MAX_RESULTS),
		x: new Float64Array(MAX_RESULTS),
		y: new Float64Array(MAX_RESULTS),
		z: new Float64Array(MAX_RESULTS),
		colorIndex: new Uint8Array(MAX_RESULTS),
		absMag: new Float64Array(MAX_RESULTS),
		approximated: new Uint8Array(MAX_RESULTS),
		starProps: new Float64Array(MAX_RESULTS * 5),
		best: new Float64Array(MAX_RESULTS * 4),
		bestLetter: new Int8Array(MAX_RESULTS),
		nPlanets: new Uint8Array(MAX_RESULTS),
		nBelts: new Uint8Array(MAX_RESULTS),
		dist2: new Float64Array(MAX_RESULTS),
		count: 0,
		stats: {
			scope: '', timeMyr: 0, scanned: 0, matched: 0, truncated: 0,
			msStage1: 0, msStage2: 0, msRefine: 0,
		},
	};
}

function createSearch() {
	const results = createResults();
	// The interleave staging between stage 1 and stage 2: survivors in scan
	// order with everything stage 2 and the collector read.
	const cKey = new Uint32Array(CHUNK);
	const cKind = new Int8Array(CHUNK);
	const cIndex = new Uint32Array(CHUNK);
	const cX = new Float64Array(CHUNK);
	const cY = new Float64Array(CHUNK);
	const cZ = new Float64Array(CHUNK);
	const cColor = new Uint8Array(CHUNK);
	const cMag = new Float64Array(CHUNK);
	const cProps = new Float64Array(CHUNK * 5);
	const cDerived = new Uint8Array(CHUNK);
	const cApprox = new Uint8Array(CHUNK);
	const cDist2 = new Float64Array(CHUNK);
	const drawnPosition = new Float64Array(3);
	// Summary matches awaiting the exactness refine (range queries only).
	const staged = new Uint16Array(CHUNK);
	// The nearest-first permutation and the row scratch it gathers through.
	const order = new Int32Array(MAX_RESULTS);
	const gather = createResults();
	// One reused stellar ref + generator context + tier records.
	const ref = { kind: 0, key: 0, index: 0, x: 0, y: 0, z: 0, colorIndex: 0, absMag: 0 };
	const genCtx = { model: null, field: null, member: null };
	let scratchInputs = null;
	let scratchSummary = null;
	let scratchRecord = null;
	// Per-run derived tables (rebuilt by beginRun from the modules' own lists,
	// never literals): class name → bit, the count pre-check's ceiling μ per
	// record slot, and the ceiling over all slots for foreign slot bytes.
	const bitByClass = {};
	const muBySlot = new Float64Array(10);
	let muCeilAll = 0;
	let mSlot = 6;
	let rgSlot = 8;
	let rgeSlot = 9;
	let chunkCount = 0;

	return { results, run };

	function classMaskForStates(states) {
		let mask = 0;
		if (states & STATE_MS) {
			mask |= bitByClass.O | bitByClass.B | bitByClass.A | bitByClass.F
				| bitByClass.G | bitByClass.K | bitByClass.M;
		}
		// Giant covers RGe too: RGe is never a derived class, but the record
		// path reads the slot literally, and stateForClass(RGe) is 'giant'.
		if (states & STATE_GIANT) mask |= bitByClass.RG | bitByClass.RGe;
		if (states & STATE_WD) mask |= bitByClass.WD;
		return mask >>> 0;
	}

	// The class pre-filter: a derived class C in the mask reaches the record
	// as slot C, as slot C+1 (the thin-disc rim shift, main sequence only,
	// clamped at M), or as RGe for a bulge RG. Passing the slot itself, one
	// below it, and RGe-for-RG is therefore a superset of the derived matches
	// — the derivation in stage 1 confirms, so the filter is exact. A foreign
	// slot byte (≥ 10) always passes; the derivation decides it.
	function slotCouldMatch(slot, mask) {
		if (slot >= 10) return true;
		if (((mask >>> slot) & 1)) return true;
		if (slot >= 1 && slot <= mSlot && (((mask >>> (slot - 1)) & 1))) return true;
		if (slot === rgeSlot && (((mask >>> rgSlot) & 1))) return true;
		return false;
	}

	// The record-path class test: the slot literally, with a foreign byte
	// reading as M — the same fallback stellarInputs applies.
	function recordSlotMatches(slot, mask) {
		const bit = slot < 10 ? slot : mSlot;
		return (((mask >>> bit) & 1) !== 0);
	}

	function beginRun() {
		for (const name in bitByClass) delete bitByClass[name];
		const names = searchRecords.SPECTRAL_CLASSES;
		for (let i = 0; i < names.length; i++) bitByClass[names[i]] = 1 << i;
		mSlot = names.indexOf('M');
		rgSlot = names.indexOf('RG');
		rgeSlot = names.indexOf('RGe');
		// The ceiling μ per slot: the max over the slot's candidate derived
		// classes (the slot's own, one below for the rim shift; RGe reads RG's
		// μ because RGe is never derived). A record-path star's true μ is its
		// slot's row, below or at the ceiling either way.
		muCeilAll = 0;
		for (let s = 0; s < 10; s++) {
			const own = s < names.length ? names[s] : 'M';
			let mu = searchPlanets.muForClass(own === 'RGe' ? 'RG' : own);
			if (s >= 1 && s <= mSlot) {
				const below = searchPlanets.muForClass(names[s - 1]);
				if (below > mu) mu = below;
			}
			muBySlot[s] = mu;
			if (mu > muCeilAll) muCeilAll = mu;
		}
		if (!scratchInputs) {
			scratchInputs = searchPlanets.createStellarInputs();
			scratchSummary = searchPlanets.createSystemSummary();
			scratchRecord = searchPlanets.createSystemRecord();
		}
	}

	function now() {
		return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
	}

	function resolveDrawnPosition(st, kind, index, x, y, z, packed, out) {
		if (kind === searchPlanets.BLOCK_LANDMARK && st.orbit
			&& st.orbit.engineLandmarkPosition) {
			st.orbit.engineLandmarkPosition(out, index, x, y, z,
				packed & 0xFF, st.time, st.model);
			return false;
		}
		if (!st.orbit || !st.orbit.engineRecordPosition || kind < 0) {
			out[0] = x; out[1] = y; out[2] = z;
			return kind < 0;
		}
		return st.orbit.engineRecordPosition(out, x, y, z, packed,
			st.time, st.model) === true;
	}

	function run(filter, env) {
		const res = results;
		const stats = res.stats;
		res.count = 0;
		stats.scope = '';
		stats.timeMyr = 0;
		stats.scanned = 0;
		stats.matched = 0;
		stats.truncated = 0;
		stats.msStage1 = 0;
		stats.msStage2 = 0;
		stats.msRefine = 0;
		if (!searchPlanets || !searchRecords || !searchHash || !searchDensity) return res;
		if (!filter || !env || !env.model || !env.renderer) return res;
		const model = env.model;
		const namedSky = (typeof module !== 'undefined' && module.exports)
			? require('./named-sky.js') : window.NamedSky;
		beginRun();

		const set = env.set || null;
		let scope = env.scope === SCOPE_GALAXY ? SCOPE_GALAXY : SCOPE_SELECTION;
		// Exactly the brief's "in all galaxy (fallback if no selected)": the
		// stats name the scope that ran, so the fallback is never invisible.
		if (scope === SCOPE_SELECTION && (!set || set.count === 0)) scope = SCOPE_GALAXY;
		stats.scope = scope;

		// The predicate plan, decided once. Distance is in ly from the supplied
		// search centre (camera by default); the scan compares drawn-space kpc².
		const lyToKpc = searchLyToKpc();
		const st = {
			filter,
			model,
			namedSkyVisible: namedSky.activeOf(model, Number.isFinite(env.rateMyrPerS) ? env.rateMyrPerS : 0),
			orbit: searchOrbit,
			time: Number.isFinite(env.time) ? env.time : 0,
			classMask: ((filter.classes | 0) | classMaskForStates(filter.states | 0)) >>> 0,
			hasLum: filter.lumMin > 0 || filter.lumMax < Infinity,
			hasMass: filter.massMin > 0 || filter.massMax < Infinity,
			compMask: filter.components | 0,
			distLo2: Math.pow(Math.max(0, filter.distMin) * lyToKpc, 2),
			distHi2: filter.distMax < Infinity
				? Math.pow(Math.max(0, filter.distMax) * lyToKpc, 2)
				: Infinity,
			ptypeMask: filter.planetTypes | 0,
			hasTsurf: filter.tsurfMin > 0 || filter.tsurfMax < Infinity,
			hasTeq: filter.teqMin > 0 || filter.teqMax < Infinity,
			hasPmass: filter.planetMassMin > 0 || filter.planetMassMax < Infinity,
			hasA: filter.aMin > 0 || filter.aMax < Infinity,
			minPlanets: filter.minPlanets | 0,
			barrenOnly: !!filter.barrenOnly,
			terranOnly: !!filter.terranOnly,
			needsBelt: !!filter.needsBelt,
			centerX: Number.isFinite(env.centerX) ? env.centerX : (env.camX || 0),
			centerY: Number.isFinite(env.centerY) ? env.centerY : (env.camY || 0),
			centerZ: Number.isFinite(env.centerZ) ? env.centerZ : (env.camZ || 0),
			modelSeed: model.seed | 0,
			blocks: null,
			segStart: 0,
		};
		stats.timeMyr = st.time;
		st.hasClass = st.classMask !== 0;
		st.hasComp = st.compMask !== 0;
		st.hasRanges = st.hasTsurf || st.hasTeq || st.hasPmass || st.hasA;
		st.wantPlanet = !!((st.ptypeMask | 0) || st.terranOnly || st.hasRanges
			|| st.minPlanets > 0 || st.barrenOnly || st.needsBelt);
		// A count of zero kills the star only when the query needs a planet
		// for a reason belts cannot satisfy: belts do not need planets.
		st.countZeroKills = !!((st.ptypeMask | 0) || st.terranOnly || st.hasRanges
			|| st.minPlanets > 0);
		// Bare barren: the pre-check's zero confirms without a summary.
		st.barrenFast = st.barrenOnly && !st.countZeroKills && !st.needsBelt;
		st.hasPerPlanet = !!((st.ptypeMask | 0) || st.terranOnly || st.hasRanges);

		const info = env.renderer.starBlocks();
		if (!info || !info.view || !info.identity || !info.blocks) return res;
		const field = env.renderer.fieldBuffers ? env.renderer.fieldBuffers() : null;
		genCtx.model = model;
		genCtx.field = field && field.count > 0 ? field : null;
		genCtx.member = info.member || null;
		st.blocks = info.blocks;
		st.formation = info.formation || null;

		chunkCount = 0;
		st.segStart = now();
		if (scope === SCOPE_GALAXY) runGalaxyStage1(st, info, genCtx.field, genCtx.member);
		else runSetStage1(st, set, info, genCtx.field, genCtx.member);
		stats.msStage1 += now() - st.segStart;
		// The trailing chunk, then nearest-first, then the kept refine for
		// non-range planet queries (range matches already carry theirs).
		if (chunkCount > 0) {
			flushChunk(st, 0, chunkCount);
			chunkCount = 0;
		}
		sortKept();
		if (st.wantPlanet && !st.hasRanges && res.count > 0) {
			const t = now();
			refineKept(st);
			stats.msRefine += now() - t;
		}
		stats.truncated = stats.matched > res.count ? stats.matched - res.count : 0;
		return res;
	}

	function runGalaxyStage1(st, info, field, member) {
		const P = searchPlanets;
		const R = searchRecords;
		const view = info.view;
		const identity = info.identity;
		const blocks = info.blocks;
		const visibleBit = R.FLAG_VISIBLE << 16;
		const recordBytes = R.RECORD_BYTES;
		const stats = results.stats;
		const f = st.filter;
		for (let k = 0; k < blocks.length; k++) {
			const block = blocks[k];
			if (k === P.BLOCK_LANDMARK && !st.namedSkyVisible) continue;
			const count = block.count | 0;
			if (count <= 0) continue;
			const base = block.offset | 0;
			const isRecordClass = k === P.BLOCK_LANDMARK || k === P.BLOCK_CATALOG;
			const end = base + count;
			for (let slot = base; slot < end; slot++) {
				const byteOffset = slot * recordBytes;
				const packed = view.getUint32(byteOffset + 12, true);
				stats.scanned++;
				if ((packed & visibleBit) === 0) continue;
				const index = slot - base;
				if (k !== P.BLOCK_LANDMARK && st.formation && st.formation.births
					&& slot < st.formation.births.length
					&& st.orbit.gateAt(st.formation.births[slot], st.formation.age) <= 0) continue;
				const x = view.getFloat32(byteOffset, true);
				const y = view.getFloat32(byteOffset + 4, true);
				const z = view.getFloat32(byteOffset + 8, true);
				const color = packed & 0xFF;
				const approximated = resolveDrawnPosition(st, k, index,
					x, y, z, packed, drawnPosition);
				const dx = drawnPosition[0] - st.centerX;
				const dy = drawnPosition[1] - st.centerY;
				const dz = drawnPosition[2] - st.centerZ;
				const d2 = dx * dx + dy * dy + dz * dz;
				if (d2 < st.distLo2 || d2 > st.distHi2) continue;
				const mag = R.decodeAbsMag((packed >>> 8) & 0xFF);
				const key = identity[slot] >>> 0;
				let needDerive = false;
				if (st.hasClass) {
					if (isRecordClass) {
						if (!recordSlotMatches(color, st.classMask)) continue;
					} else {
						if (!slotCouldMatch(color, st.classMask)) continue;
						needDerive = true;
					}
				}
				if (st.hasLum || st.hasMass) needDerive = true;
				if (st.hasComp) {
					if (k === P.BLOCK_FIELD && field && index < field.count) {
						if ((((st.compMask >>> field.component[index]) & 1)) === 0) continue;
					} else if (k === P.BLOCK_OBJECT && member && member.component
						&& index < member.component.length) {
						const c = member.component[index];
						if ((((st.compMask >>> (c < 0 ? 0 : c)) & 1)) === 0) continue;
					} else {
						// The local gap-fill convention (star-sprites.js):
						// the component the density at the position implies,
						// drawn on channel 3 of the star's own key.
						const decomposed = searchDensity.rhoDecomposed(st.model, x, y, z);
						const comp = searchDensity.sampleComponentIndex(
							decomposed, searchHash.hash01At(key, 3));
						if ((((st.compMask >>> comp) & 1)) === 0) continue;
					}
				}
				const j = appendChunk(key, k, index, x, y, z, color, mag, d2, approximated);
				if (needDerive) {
					ref.kind = k;
					ref.key = key;
					ref.index = index;
					ref.x = x; ref.y = y; ref.z = z;
					ref.colorIndex = color;
					ref.absMag = mag;
					const inputs = P.stellarInputs(ref, genCtx, scratchInputs);
					if (st.hasClass && !isRecordClass) {
						if (!((st.classMask & (bitByClass[inputs.spectralClass] || 0)))) {
							chunkCount--;
							continue;
						}
					}
					if (st.hasLum && (inputs.lum < f.lumMin || inputs.lum > f.lumMax)) {
						chunkCount--;
						continue;
					}
					if (st.hasMass && (inputs.mass < f.massMin || inputs.mass > f.massMax)) {
						chunkCount--;
						continue;
					}
					stashProps(j, inputs);
				}
				if (chunkCount >= CHUNK) {
					stats.msStage1 += now() - st.segStart;
					flushChunk(st, 0, CHUNK);
					chunkCount = 0;
					st.segStart = now();
				}
			}
		}
	}

	function runSetStage1(st, set, info, field, member) {
		const P = searchPlanets;
		const stats = results.stats;
		const f = st.filter;
		const visibleBit = searchRecords.FLAG_VISIBLE << 16;
		stats.scanned = set.count;
		for (let i = 0; i < set.count; i++) {
			const x = set.x[i];
			const y = set.y[i];
			const z = set.z[i];
			const key = set.keys[i] >>> 0;
			const rawKind = set.blockKind[i];
			const kind = rawKind < st.blocks.length ? rawKind : KIND_UNRESOLVED;
			const color = set.colorIndex[i];
			const mag = set.absMag[i];
			if (kind === P.BLOCK_LANDMARK && !st.namedSkyVisible) continue;
			let effKind = kind;
			let blockIndex = set.bufferIdx[i] | 0;
			let approximated = 1;
			if (kind >= 0) {
				const block = st.blocks[kind];
				const slot = block && blockIndex >= 0 && blockIndex < (block.count | 0)
					? (block.offset | 0) + blockIndex : -1;
				if (slot < 0 || slot >= info.identity.length
					|| (info.identity[slot] >>> 0) !== key) {
					effKind = KIND_UNRESOLVED;
					blockIndex = 0;
				} else {
					const byteOffset = slot * searchRecords.RECORD_BYTES;
					const packed = info.view.getUint32(byteOffset + 12, true);
					if ((packed & visibleBit) === 0) {
						effKind = KIND_UNRESOLVED;
						blockIndex = 0;
					} else {
						if (kind !== P.BLOCK_LANDMARK && info.formation && info.formation.births
							&& slot < info.formation.births.length
							&& st.orbit.gateAt(info.formation.births[slot], info.formation.age) <= 0) continue;
						const bx = info.view.getFloat32(byteOffset, true);
						const by = info.view.getFloat32(byteOffset + 4, true);
						const bz = info.view.getFloat32(byteOffset + 8, true);
						approximated = resolveDrawnPosition(st, kind, blockIndex,
							bx, by, bz, packed, drawnPosition) ? 1 : 0;
					}
				}
			}
			if (effKind < 0) {
				drawnPosition[0] = x; drawnPosition[1] = y; drawnPosition[2] = z;
				approximated = 1;
			}
			const dx = drawnPosition[0] - st.centerX;
			const dy = drawnPosition[1] - st.centerY;
			const dz = drawnPosition[2] - st.centerZ;
			const d2 = dx * dx + dy * dy + dz * dz;
			if (d2 < st.distLo2 || d2 > st.distHi2) continue;
			const isRecordClass = effKind < 0
				|| kind === P.BLOCK_LANDMARK || kind === P.BLOCK_CATALOG;
			if (st.hasClass) {
				if (isRecordClass) {
					if (!recordSlotMatches(color, st.classMask)) continue;
				} else {
					if (!slotCouldMatch(color, st.classMask)) continue;
					ref.kind = kind;
					ref.key = key;
					ref.index = blockIndex;
					ref.x = x; ref.y = y; ref.z = z;
					ref.colorIndex = color;
					ref.absMag = mag;
					const inputs = P.stellarInputs(ref, genCtx, scratchInputs);
					if (!((st.classMask & (bitByClass[inputs.spectralClass] || 0)))) continue;
				}
			}
			// The snapshot is the set's truth: stellar properties and birth
			// coordinates survive a residency rebuild; only the distance is live.
			if (st.hasLum && (set.lum[i] < f.lumMin || set.lum[i] > f.lumMax)) continue;
			if (st.hasMass && (set.mass[i] < f.massMin || set.mass[i] > f.massMax)) continue;
			if (st.hasComp) {
				let comp = -1;
				if (effKind === P.BLOCK_FIELD && field && blockIndex < field.count) {
					comp = field.component[blockIndex];
				} else if (effKind === P.BLOCK_OBJECT && member && member.component
					&& blockIndex < member.component.length) {
					const c = member.component[blockIndex];
					comp = c < 0 ? 0 : c;
				} else {
					const decomposed = searchDensity.rhoDecomposed(st.model, x, y, z);
					comp = searchDensity.sampleComponentIndex(
						decomposed, searchHash.hash01At(key, 3));
				}
				if ((((st.compMask >>> comp) & 1)) === 0) continue;
			}
			const j = appendChunk(key, effKind, blockIndex, x, y, z,
				color, mag, d2, approximated);
			const o = j * 5;
			cProps[o] = set.mass[i];
			cProps[o + 1] = set.lum[i];
			cProps[o + 2] = set.teff[i];
			cProps[o + 3] = set.age[i];
			cProps[o + 4] = set.metal[i];
			cDerived[j] = 1;
		}
	}

	function appendChunk(key, kind, index, x, y, z, color, mag, d2, approximated) {
		const j = chunkCount++;
		cKey[j] = key >>> 0;
		cKind[j] = kind;
		cIndex[j] = index >>> 0;
		cX[j] = x; cY[j] = y; cZ[j] = z;
		cColor[j] = color;
		cMag[j] = mag;
		cDerived[j] = 0;
		cApprox[j] = approximated ? 1 : 0;
		cDist2[j] = d2;
		return j;
	}

	function flushChunk(st, from, to) {
		const stats = results.stats;
		// Loop A: summaries + summary tests. Range queries only stage their
		// matches here; everything else collects (summary-exact) directly.
		const tA = now();
		let nStaged = 0;
		for (let j = from; j < to; j++) {
			if (!st.wantPlanet) {
				collectStarOnly(j);
				continue;
			}
			const key = cKey[j];
			const kind = cKind[j];
			// The count pre-check (§5.3's cheap stage inside the expensive
			// one): planetCount at the slot's ceiling μ. Zero means the true
			// count is zero — the chain is monotone in μ and the repair only
			// drops — so a count-needing query skips the summary, and a bare
			// barren query matches without one. needsBelt always runs the
			// summary: a barren star can still hold belts.
			if (st.countZeroKills || st.barrenFast) {
				const seed = searchPlanets.systemSeed(key, st.modelSeed, kind);
				const ceil = cColor[j] < 10 ? muBySlot[cColor[j]] : muCeilAll;
				if (searchPlanets.planetCount(seed, ceil) === 0) {
					if (st.barrenFast) {
						collectBarren(j);
						continue;
					}
					if (!st.needsBelt) continue;
				}
			}
			ref.kind = kind;
			ref.key = key;
			ref.index = cIndex[j];
			ref.x = cX[j]; ref.y = cY[j]; ref.z = cZ[j];
			ref.colorIndex = cColor[j];
			ref.absMag = cMag[j];
			const summary = searchPlanets.systemSummary(ref, genCtx, scratchSummary);
			if (!testSummary(st, summary)) continue;
			if (st.hasRanges) staged[nStaged++] = j;
			else collectSummary(j, summary);
		}
		stats.msStage2 += now() - tA;
		// Loop B: the exactness refine. The summary's extremes are necessary
		// but not sufficient — two ranges can straddle across two planets —
		// so every summary match is re-checked against full planet rows, and
		// only a star with one planet satisfying every per-planet predicate
		// is an exact match.
		if (nStaged > 0) {
			const tB = now();
			for (let s = 0; s < nStaged; s++) refineStaged(st, staged[s]);
			stats.msRefine += now() - tB;
		}
	}

	function testSummary(st, summary) {
		const f = st.filter;
		if (summary.count < st.minPlanets) return false;
		if (st.barrenOnly && summary.count !== 0) return false;
		if (st.ptypeMask) {
			let hit = false;
			const hist = summary.typeHistogram;
			for (let t = 0; t < hist.length; t++) {
				if ((((st.ptypeMask >>> t) & 1)) && hist[t] > 0) { hit = true; break; }
			}
			if (!hit) return false;
		}
		if (st.terranOnly && summary.terranCount === 0) return false;
		if (st.needsBelt && summary.beltCount === 0) return false;
		// The empty sentinels (±Infinity) fail every finite bound, so a
		// planetless system cannot match a range without a special case.
		if (st.hasTsurf && !(summary.tsurfMax >= f.tsurfMin && summary.tsurfMin <= f.tsurfMax)) return false;
		if (st.hasTeq && !(summary.teqMax >= f.teqMin && summary.teqMin <= f.teqMax)) return false;
		if (st.hasPmass && !(summary.massMax >= f.planetMassMin && summary.massMin <= f.planetMassMax)) return false;
		if (st.hasA && !(summary.aMax >= f.aMin && summary.aMin <= f.aMax)) return false;
		return true;
	}

	function testPlanetRow(st, planets, i) {
		const f = st.filter;
		if (st.ptypeMask && ((((st.ptypeMask >>> planets.displayType[i]) & 1)) === 0)) return false;
		if (st.terranOnly && !(planets.flags[i] & searchPlanets.FLAG_TERRAN)) return false;
		if (st.hasTsurf && (planets.tsurf[i] < f.tsurfMin || planets.tsurf[i] > f.tsurfMax)) return false;
		if (st.hasTeq && (planets.teq[i] < f.teqMin || planets.teq[i] > f.teqMax)) return false;
		if (st.hasPmass && (planets.mass[i] < f.planetMassMin || planets.mass[i] > f.planetMassMax)) return false;
		if (st.hasA && (planets.a[i] < f.aMin || planets.a[i] > f.aMax)) return false;
		return true;
	}

	// Best-terran scan over full rows, the summary's own rule (|S − 1|
	// minimum, ties to the inner one — rows are a-ascending, so the first
	// minimum wins).
	function bestTerranRow(planets, n) {
		let best = -1;
		let bestD = Infinity;
		for (let i = 0; i < n; i++) {
			if (!(planets.flags[i] & searchPlanets.FLAG_TERRAN)) continue;
			const d = Math.abs(planets.insolation[i] - 1);
			if (d < bestD) { bestD = d; best = i; }
		}
		return best;
	}

	function refineStaged(st, j) {
		ref.kind = cKind[j];
		ref.key = cKey[j];
		ref.index = cIndex[j];
		ref.x = cX[j]; ref.y = cY[j]; ref.z = cZ[j];
		ref.colorIndex = cColor[j];
		ref.absMag = cMag[j];
		const record = searchPlanets.generateSystem(ref, genCtx, scratchRecord);
		const n = record.counts.planets;
		let display = -1;
		for (let i = 0; i < n; i++) {
			if (testPlanetRow(st, record.planets, i)) { display = i; break; }
		}
		// No single planet satisfies the conjunction: the summary's overlap
		// was a straddle, and the star is not a match.
		if (display < 0) return;
		collectRefined(j, record, display);
	}

	// The kept refine for non-range planet queries (≤ 512 generateSystem
	// calls): the display planet and its letter. A system-level conjunction
	// (a ptype on one planet, terran on another) names no single planet, so
	// the best terran is the fallback; a pure system query (a count, a belt)
	// prefers the best terran and otherwise the innermost planet. Barren
	// matches keep the none-marker they were collected with.
	function refineKept(st) {
		const res = results;
		for (let i = 0; i < res.count; i++) {
			if (res.nPlanets[i] === 0 || res.nPlanets[i] === COUNT_UNKNOWN) continue;
			ref.kind = res.kind[i];
			ref.key = res.keys[i];
			ref.index = res.index[i];
			ref.x = res.x[i]; ref.y = res.y[i]; ref.z = res.z[i];
			ref.colorIndex = res.colorIndex[i];
			ref.absMag = res.absMag[i];
			const record = searchPlanets.generateSystem(ref, genCtx, scratchRecord);
			const n = record.counts.planets;
			let display = -1;
			if (st.hasPerPlanet) {
				for (let p = 0; p < n; p++) {
					if (testPlanetRow(st, record.planets, p)) { display = p; break; }
				}
			}
			if (display < 0) {
				if (st.hasPerPlanet) display = bestTerranRow(record.planets, n);
				else {
					const terran = bestTerranRow(record.planets, n);
					display = terran >= 0 ? terran : (n > 0 ? 0 : -1);
				}
			}
			if (display < 0) continue;
			const o = i * 4;
			res.best[o] = record.planets.a[display];
			res.best[o + 1] = record.planets.mass[display];
			res.best[o + 2] = record.planets.tsurf[display];
			res.best[o + 3] = record.planets.displayType[display];
			res.bestLetter[i] = display;
		}
	}

	function stashProps(j, inputs) {
		const o = j * 5;
		cProps[o] = inputs.mass;
		cProps[o + 1] = inputs.lum;
		cProps[o + 2] = inputs.teff;
		cProps[o + 3] = inputs.age;
		cProps[o + 4] = inputs.metal;
		cDerived[j] = 1;
	}

	function deriveChunkProps(j) {
		ref.kind = cKind[j];
		ref.key = cKey[j];
		ref.index = cIndex[j];
		ref.x = cX[j]; ref.y = cY[j]; ref.z = cZ[j];
		ref.colorIndex = cColor[j];
		ref.absMag = cMag[j];
		stashProps(j, searchPlanets.stellarInputs(ref, genCtx, scratchInputs));
	}

	function collectCommon(j) {
		const res = results;
		const stats = res.stats;
		stats.matched++;
		if (res.count >= MAX_RESULTS) return -1;
		const i = res.count++;
		res.keys[i] = cKey[j];
		res.kind[i] = cKind[j];
		res.index[i] = cIndex[j];
		res.x[i] = cX[j]; res.y[i] = cY[j]; res.z[i] = cZ[j];
		res.colorIndex[i] = cColor[j];
		res.absMag[i] = cMag[j];
		res.approximated[i] = cApprox[j];
		res.dist2[i] = cDist2[j];
		// A star that matched without derivation (a distance-only filter, a
		// record-class filter) still needs its snapshot fields for the
		// add-to-selection handover — at most 512 derivations per run.
		if (!cDerived[j]) deriveChunkProps(j);
		const s = j * 5;
		const d = i * 5;
		res.starProps[d] = cProps[s];
		res.starProps[d + 1] = cProps[s + 1];
		res.starProps[d + 2] = cProps[s + 2];
		res.starProps[d + 3] = cProps[s + 3];
		res.starProps[d + 4] = cProps[s + 4];
		return i;
	}

	function writeBestNone(i) {
		const res = results;
		const o = i * 4;
		res.best[o] = NaN;
		res.best[o + 1] = NaN;
		res.best[o + 2] = NaN;
		res.best[o + 3] = BEST_NONE;
		res.bestLetter[i] = -1;
	}

	function collectStarOnly(j) {
		const i = collectCommon(j);
		if (i < 0) return;
		results.nPlanets[i] = COUNT_UNKNOWN;
		results.nBelts[i] = COUNT_UNKNOWN;
		writeBestNone(i);
	}

	function collectBarren(j) {
		const i = collectCommon(j);
		if (i < 0) return;
		results.nPlanets[i] = 0;
		// The pre-check confirms the count, not the belts: a bare barren
		// query runs no summary, so the belt count stays unknown.
		results.nBelts[i] = COUNT_UNKNOWN;
		writeBestNone(i);
	}

	function collectSummary(j, summary) {
		const i = collectCommon(j);
		if (i < 0) return;
		results.nPlanets[i] = summary.count;
		results.nBelts[i] = summary.beltCount;
		// The display planet lands in refineKept, after the sort.
		writeBestNone(i);
	}

	function collectRefined(j, record, display) {
		const i = collectCommon(j);
		if (i < 0) return;
		results.nPlanets[i] = record.counts.planets;
		results.nBelts[i] = record.belts.count;
		const o = i * 4;
		results.best[o] = record.planets.a[display];
		results.best[o + 1] = record.planets.mass[display];
		results.best[o + 2] = record.planets.tsurf[display];
		results.best[o + 3] = record.planets.displayType[display];
		results.bestLetter[i] = display;
	}

	function sortKept() {
		const res = results;
		const n = res.count;
		for (let i = 0; i < n; i++) order[i] = i;
		// Nearest-first from the supplied centre: sorting 512 entries is
		// ~0.1 ms and keeps "the nearest Earth-like world" a one-query
		// question. TypedArray sort is in place — no allocation.
		order.subarray(0, n).sort((a, b) => res.dist2[a] - res.dist2[b]);
		if (n <= 1) return;
		copyResults(res, gather, n);
		for (let i = 0; i < n; i++) {
			const s = order[i];
			res.keys[i] = gather.keys[s];
			res.kind[i] = gather.kind[s];
			res.index[i] = gather.index[s];
			res.x[i] = gather.x[s];
			res.y[i] = gather.y[s];
			res.z[i] = gather.z[s];
			res.colorIndex[i] = gather.colorIndex[s];
			res.absMag[i] = gather.absMag[s];
			res.approximated[i] = gather.approximated[s];
			res.dist2[i] = gather.dist2[s];
			res.bestLetter[i] = gather.bestLetter[s];
			res.nPlanets[i] = gather.nPlanets[s];
			res.nBelts[i] = gather.nBelts[s];
			const d5 = i * 5;
			const s5 = s * 5;
			res.starProps[d5] = gather.starProps[s5];
			res.starProps[d5 + 1] = gather.starProps[s5 + 1];
			res.starProps[d5 + 2] = gather.starProps[s5 + 2];
			res.starProps[d5 + 3] = gather.starProps[s5 + 3];
			res.starProps[d5 + 4] = gather.starProps[s5 + 4];
			const d4 = i * 4;
			const s4 = s * 4;
			// Range-refined rows already carry their display planet; the rest
			// keep the none-marker until refineKept runs, after this sort.
			res.best[d4] = gather.best[s4];
			res.best[d4 + 1] = gather.best[s4 + 1];
			res.best[d4 + 2] = gather.best[s4 + 2];
			res.best[d4 + 3] = gather.best[s4 + 3];
		}
	}

	function copyResults(src, dst, n) {
		dst.keys.set(src.keys.subarray(0, n));
		dst.kind.set(src.kind.subarray(0, n));
		dst.index.set(src.index.subarray(0, n));
		dst.x.set(src.x.subarray(0, n));
		dst.y.set(src.y.subarray(0, n));
		dst.z.set(src.z.subarray(0, n));
		dst.colorIndex.set(src.colorIndex.subarray(0, n));
		dst.absMag.set(src.absMag.subarray(0, n));
		dst.approximated.set(src.approximated.subarray(0, n));
		dst.dist2.set(src.dist2.subarray(0, n));
		dst.bestLetter.set(src.bestLetter.subarray(0, n));
		dst.nPlanets.set(src.nPlanets.subarray(0, n));
		dst.nBelts.set(src.nBelts.subarray(0, n));
		dst.starProps.set(src.starProps.subarray(0, n * 5));
		dst.best.set(src.best.subarray(0, n * 4));
	}
	}

	const Search = {
		MAX_RESULTS, CHUNK,
		STATE_MS, STATE_GIANT, STATE_WD,
		COMP_THIN, COMP_THICK, COMP_BULGE, COMP_HALO,
		SCOPE_SELECTION, SCOPE_GALAXY,
		KIND_UNRESOLVED, BEST_NONE, COUNT_UNKNOWN,
		createFilter, resetFilter, parseFilter, formatFilter,
		classBit, stateBit, componentBit, planetTypeBit,
		createResults, createSearch,
	};
	if (typeof module !== 'undefined') module.exports = Search;
	if (typeof window !== 'undefined') window.Search = Search;
})();
