// src/core/search.js
// Star and planet search (0.5.0-plan §5): one scan over the resident records
// that answers "which stars have planets like this", writing into preallocated
// result buffers. Pure — it takes an accessor (renderer.starBlocks() +
// fieldBuffers() + the selection set) and a filter struct, and knows nothing
// about the DOM or the renderer's lifetime.
//
// Two stages, because the filter table has two kinds of predicate. Stage 1
// runs the star predicates, from the record bytes where they are all there is
// (colour index, absolute magnitude, position) and from one `deriveStar` where
// they are not (mass, component). Stage 2 runs `systemSummary` only for the
// survivors — which is why a class filter over the whole galaxy does no planet
// work at all, and why a habitable-world filter is the expensive case.
//
// The scan reads *stored* positions, like selectAround: a query is a property
// of the model's stars, not of this instant's rotation, so the answer is
// stable while the camera moves. The camera enters only through the distance
// bounds, which §5.1 defines from the camera.

'use strict';

const SEARCH_MAX_RESULTS = 512;
const SEARCH_CHUNK = 20000;              // §5.3's frame-chunk size, if step() is ever built
// A power-of-two open-addressing table for the selection scope: the set holds
// at most 256 keys, so 1024 slots keeps the probe chains short without ever
// growing. A key of 0 marks an empty slot, and star-set.js never admits one.
const MEMBERSHIP_SLOTS = 1024;
const MEMBERSHIP_MASK = MEMBERSHIP_SLOTS - 1;

// State bits, matching planets.js's STATE_MS/GIANT/WD codes 0/1/2 shifted by
// one, so a mask can never accidentally read as "any".
const STATE_MS = 1, STATE_GIANT = 2, STATE_WD = 4;
// Component bits, in density.js's COMPONENT_NAMES order. The bit names are
// this file's own: the page's script tags share one global scope, and
// density.js already owns the COMPONENT_* index constants.
const BIT_THIN = 1, BIT_THICK = 2, BIT_BULGE = 4, BIT_HALO = 8;
const COMPONENT_BIT = [BIT_THIN, BIT_THICK, BIT_BULGE, BIT_HALO];
const COMPONENT_TOKEN_NAMES = ['thin', 'thick', 'bulge', 'halo'];

const SCOPE_AUTO = 'auto', SCOPE_SELECTION = 'selection', SCOPE_GALAXY = 'galaxy';

// Every range predicate is a number pair with an absent side at ±Infinity, so
// one comparison shape serves them all.
const HI = Infinity;

// Live dependency lookup, memoised on success: planets.js and label-layer.js
// resolve the same way, because a Node test may load this file before the
// modules it reads, and a failed lookup must retry rather than cache null.
const searchDeps = {};
function dep(windowName, requirePath) {
	const cached = searchDeps[windowName];
	if (cached) return cached;
	const found = (typeof window !== 'undefined' && window[windowName])
		|| (typeof module !== 'undefined' ? require(requirePath) : null);
	if (found) searchDeps[windowName] = found;
	return found;
}
function planetsLib() { return dep('PlanetsLib', '../math/planets.js'); }
function recordLib() { return dep('StarRecord', '../math/star-record.js'); }
// The ly↔kpc factor is Camera's own constant, read live so there is one
// definition of it; the fallback keeps a search-only Node test honest.
const LY_TO_KPC_FALLBACK = 0.000306601;
function lyToKpc() {
	const camera = dep('Camera', '../core/camera.js');
	return camera && camera.LY_TO_KPC ? camera.LY_TO_KPC : LY_TO_KPC_FALLBACK;
}

// Class index → the state bit its evolved code implies. planets.js's
// stateFromClass is the same rule, so the filter and the generator can never
// classify one record two ways.
function classState(classIndex) {
	if (classIndex === 7) return STATE_WD;                       // WD
	if (classIndex === 8 || classIndex === 9) return STATE_GIANT;   // RG, RGe
	return STATE_MS;
}

function classBit(classIndex) { return 1 << classIndex; }
function planetTypeBit(display) { return 1 << display; }

// A finite number or the fallback: a NaN, a string or undefined all mean
// "this side of the range is unbounded".
function boundOf(value, fallback) {
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
}

// The flat filter struct every caller speaks: masks as bitmasks over the
// class / state / component / display-type tables, ranges as number pairs (ly
// for distance, AU for semi-major axis, M⊕ for planet mass, K for the two
// temperatures). An absent key means "no constraint". normalizeFilter turns it
// into the scan's internal form — masks validated, ranges closed to numbers,
// luminosity bounds folded into magnitude bounds — in one object per search,
// never per record. It is idempotent: a normalized filter carries the same
// fields the flat form spells `classMask`/`stateMask`/…, so a caller may pass
// either (the UI's raw struct, a parsed preset token, or its own output).
function normalizeFilter(filter) {
	const f = filter || {};
	const lumMin = boundOf(f.lumMin, 0), lumMax = boundOf(f.lumMax, HI);
	const massMin = Math.max(0, boundOf(f.massMin, 0)), massMax = boundOf(f.massMax, HI);
	const distMin = boundOf(f.distMin, 0), distMax = boundOf(f.distMax, HI);
	const tsurfMin = boundOf(f.tsurfMin, 0), tsurfMax = boundOf(f.tsurfMax, HI);
	const teqMin = boundOf(f.teqMin, 0), teqMax = boundOf(f.teqMax, HI);
	const planetMassMin = Math.max(0, boundOf(f.planetMassMin, 0));
	const planetMassMax = boundOf(f.planetMassMax, HI);
	const aMin = Math.max(0, boundOf(f.aMin, 0)), aMax = boundOf(f.aMax, HI);
	const minPlanets = Math.max(0, boundOf(f.minPlanets, 0) | 0);
	const maskOf = (normalized, flat) => boundOf(normalized !== undefined ? normalized : flat, 0) | 0;
	const planetTypeMask = maskOf(f.planetTypeMask, f.planetTypes);
	const componentMask = maskOf(f.componentMask, f.components);
	const classMask = maskOf(f.classMask, f.classes);
	const stateMask = maskOf(f.stateMask, f.states);
	const terranOnly = !!f.terranOnly, barrenOnly = !!f.barrenOnly, needsBelt = !!f.needsBelt;
	const aFiltered = aMin > 0 || aMax < HI;
	const pMassFiltered = planetMassMin > 0 || planetMassMax < HI;
	const tsurfFiltered = tsurfMin > 0 || tsurfMax < HI;
	const teqFiltered = teqMin > 0 || teqMax < HI;
	return {
		classMask, stateMask, componentMask, planetTypeMask,
		terranOnly, barrenOnly, needsBelt, minPlanets,
		lumMin, lumMax, massMin, massMax, distMin, distMax,
		tsurfMin, tsurfMax, teqMin, teqMax,
		planetMassMin, planetMassMax, aMin, aMax,
		aFiltered, pMassFiltered, tsurfFiltered, teqFiltered,
		// Luminosity bounds are magnitude bounds in disguise: L rises as M_V
		// falls, so the scan compares the record's own magnitude instead of
		// taking a log10 per star.
		magLo: lumMax < HI ? 4.83 - 2.5 * Math.log10(lumMax) : -HI,
		magHi: lumMin > 0 ? 4.83 - 2.5 * Math.log10(lumMin) : HI,
		magFiltered: lumMin > 0 || lumMax < HI,
		massFiltered: massMin > 0 || massMax < HI,
		distFiltered: distMin > 0 || distMax < HI,
		derivedMass: massMin > 0 || massMax < HI,
		derivedComponent: componentMask !== 0,
		// Stage 2 runs only when the filter asks something a summary answers.
		planetQuery: planetTypeMask !== 0 || terranOnly || barrenOnly || needsBelt
			|| minPlanets > 0 || aFiltered || pMassFiltered || tsurfFiltered || teqFiltered,
	};
}

// ---- the preset token (§5.5) --------------------------------------------
// One search as a compact token: `key=value` segments separated by ';', in a
// fixed order so two filters with the same meaning serialize identically.
//
//   cls=G,K     spectral classes            st=ms,giant,wd   states
//   lum=0.1-100 L☉                          mass=0.5-1.5     M☉
//   dist=10-5000 ly from the camera         cmp=thin,thick   components
//   pt=terran,gas-giant display types       ts=200-320  K surface
//   te=100-400  K equilibrium               pm=0.5-10   M⊕   a=0.5-5 AU
//   minp=3      at least N planets          flag=terran+belt+noplanets
//
// A range is `lo-hi`, either side open ('-100', '5-'). §5.5's worked example
// `G,K|terran|220-300` is `cls=G,K;pt=terran;ts=220-300` here: a positional
// token breaks the moment a field is skipped, and a search is exactly the kind
// of state a viewer sets field by field.
const TOKEN_CLASSES = ['O', 'B', 'A', 'F', 'G', 'K', 'M', 'WD', 'RG', 'RGe'];
const TOKEN_STATES = ['ms', 'giant', 'wd'];
const TOKEN_COMPONENTS = COMPONENT_TOKEN_NAMES;
const TOKEN_TYPES = ['lava', 'barren', 'desert', 'terran', 'ice', 'super-earth',
	'mini-neptune', 'gas-giant', 'ice-giant', 'dwarf'];
const TOKEN_FLAGS = ['terran', 'belt', 'noplanets'];
const TOKEN_ORDER = ['cls', 'st', 'lum', 'mass', 'dist', 'cmp', 'pt',
	'ts', 'te', 'pm', 'a', 'minp', 'flag'];

// A compact mask parser: names in a known table, junk dropped. 0 means "no
// constraint", which is what an absent or empty list leaves behind. Names are
// matched case-insensitively and may be separated by commas, spaces or the
// '+' the flag list uses — never by a hyphen, which several type names own.
function maskFromNames(text, names) {
	const wanted = String(text === undefined || text === null ? '' : text)
		.toLowerCase().split(/[,+\s]+/);
	let mask = 0;
	for (const name of wanted) {
		for (let i = 0; i < names.length; i++) {
			if (names[i].toLowerCase() === name) { mask |= 1 << i; break; }
		}
	}
	return mask;
}

function parseRange(text) {
	const parts = String(text === undefined || text === null ? '' : text).split('-');
	if (parts.length !== 2) return [0, HI];
	return [boundOf(parts[0], 0), boundOf(parts[1], HI)];
}

function parseFilter(token) {
	const filter = {};
	const text = String(token === undefined || token === null ? '' : token).trim();
	if (text === '') return filter;
	for (const segment of text.split(';')) {
		const at = segment.indexOf('=');
		if (at <= 0) continue;
		const key = segment.slice(0, at).trim();
		const value = segment.slice(at + 1).trim();
		if (value === '') continue;
		const range = parseRange(value);
		switch (key) {
			case 'cls': filter.classes = maskFromNames(value, TOKEN_CLASSES); break;
			case 'st': filter.states = maskFromNames(value, TOKEN_STATES); break;
			case 'cmp': filter.components = maskFromNames(value, TOKEN_COMPONENTS); break;
			case 'pt': filter.planetTypes = maskFromNames(value, TOKEN_TYPES); break;
			case 'lum': filter.lumMin = range[0]; filter.lumMax = range[1]; break;
			case 'mass': filter.massMin = range[0]; filter.massMax = range[1]; break;
			case 'dist': filter.distMin = range[0]; filter.distMax = range[1]; break;
			case 'ts': filter.tsurfMin = range[0]; filter.tsurfMax = range[1]; break;
			case 'te': filter.teqMin = range[0]; filter.teqMax = range[1]; break;
			case 'pm': filter.planetMassMin = range[0]; filter.planetMassMax = range[1]; break;
			case 'a': filter.aMin = range[0]; filter.aMax = range[1]; break;
			case 'minp': filter.minPlanets = Math.max(0, boundOf(value, 0) | 0); break;
			case 'flag': {
				const wanted = maskFromNames(value, TOKEN_FLAGS);
				filter.terranOnly = (wanted & 1) !== 0;
				filter.needsBelt = (wanted & 2) !== 0;
				filter.barrenOnly = (wanted & 4) !== 0;
				break;
			}
		}
	}
	return filter;
}

function formatRange(min, max) {
	const lo = min > 0 && min < HI ? String(Number(min.toPrecision(6))) : '';
	const hi = max < HI ? String(Number(max.toPrecision(6))) : '';
	if (lo === '' && hi === '') return '';
	return lo + '-' + hi;
}

function maskNames(mask, names) {
	const parts = [];
	for (let i = 0; i < names.length; i++) {
		if ((mask >>> i) & 1) parts.push(names[i]);
	}
	return parts.join(',');
}

// A filter back to its token. Takes the flat form (a parsed preset key, a UI
// struct) or the normalized one — normalizeFilter is idempotent on both.
function serializeFilter(filter) {
	const f = normalizeFilter(filter);
	const segments = [];
	for (const key of TOKEN_ORDER) {
		let value = '';
		switch (key) {
			case 'cls': value = maskNames(f.classMask, TOKEN_CLASSES); break;
			case 'st': value = maskNames(f.stateMask, TOKEN_STATES); break;
			case 'lum': value = formatRange(f.lumMin, f.lumMax); break;
			case 'mass': value = formatRange(f.massMin, f.massMax); break;
			case 'dist': value = formatRange(f.distMin, f.distMax); break;
			case 'cmp': value = maskNames(f.componentMask, TOKEN_COMPONENTS); break;
			case 'pt': value = maskNames(f.planetTypeMask, TOKEN_TYPES); break;
			case 'ts': value = formatRange(f.tsurfMin, f.tsurfMax); break;
			case 'te': value = formatRange(f.teqMin, f.teqMax); break;
			case 'pm': value = formatRange(f.planetMassMin, f.planetMassMax); break;
			case 'a': value = formatRange(f.aMin, f.aMax); break;
			case 'minp': value = f.minPlanets > 0 ? String(f.minPlanets) : ''; break;
			case 'flag': {
				const parts = [];
				if (f.terranOnly) parts.push('terran');
				if (f.needsBelt) parts.push('belt');
				if (f.barrenOnly) parts.push('noplanets');
				value = parts.join('+');
				break;
			}
		}
		if (value !== '') segments.push(key + '=' + value);
	}
	return segments.join(';');
}

// ---- the scan ------------------------------------------------------------
function nowMs() {
	if (typeof performance !== 'undefined' && performance.now) return performance.now();
	return Date.now();
}

function createSearch() {
	// Staging: matches in scan order, then the first SEARCH_MAX_RESULTS sorted
	// nearest-first and gathered into the result buffers. Sorting 512 indices
	// is ~0.1 ms; keeping the payload in scan order and gathering once means
	// the sort moves indices, not payloads.
	const stgKey = new Uint32Array(SEARCH_MAX_RESULTS);
	const stgDist = new Float64Array(SEARCH_MAX_RESULTS);
	const stgSlot = new Uint32Array(SEARCH_MAX_RESULTS);
	const stgClass = new Uint8Array(SEARCH_MAX_RESULTS);
	const stgStar = new Float64Array(SEARCH_MAX_RESULTS * 5);   // mass, lum, teff, age, rStar
	const stgBest = new Float64Array(SEARCH_MAX_RESULTS * 4);   // a, mass, tsurf, display
	const order = new Uint32Array(SEARCH_MAX_RESULTS);

	const results = {
		count: 0,
		keys: new Uint32Array(SEARCH_MAX_RESULTS),
		dist: new Float64Array(SEARCH_MAX_RESULTS),               // kpc from the camera
		x: new Float64Array(SEARCH_MAX_RESULTS),
		y: new Float64Array(SEARCH_MAX_RESULTS),
		z: new Float64Array(SEARCH_MAX_RESULTS),
		slot: new Uint32Array(SEARCH_MAX_RESULTS),
		class: new Uint8Array(SEARCH_MAX_RESULTS),
		star: new Float64Array(SEARCH_MAX_RESULTS * 5),
		best: new Float64Array(SEARCH_MAX_RESULTS * 4),
	};
	const stats = {
		scope: SCOPE_AUTO, scanned: 0, matched: 0, truncated: false,
		msStage1: 0, msStage2: 0,
	};

	const memberTable = new Uint32Array(MEMBERSHIP_SLOTS);
	const ref = {
		key: 0, block: 0, slot: 0, x: 0, y: 0, z: 0, model: null, field: null,
		colorIndex: 0, absMag: 0,
	};
	// Derived once, on the first run: planets.js loads before this file in the
	// page and before createSearch in a test, but a module built against a
	// page that has not booted yet must not touch it at construction time.
	let inputs = null, summary = null;
	const best = [0, 0, 0, 0];

	// The accessor: callbacks, because the staging buffer and the identity
	// array are reallocated on every regenerate and rewritten on every
	// residency change (the same reason selection.js takes one).
	let source = null;
	function setSource(next) {
		source = next && typeof next.blocks === 'function' ? next : null;
	}

	function tableInsert(key) {
		let i = Math.imul(key, 2654435761) & MEMBERSHIP_MASK;
		while (memberTable[i] !== 0) {
			if (memberTable[i] === key) return;
			i = (i + 1) & MEMBERSHIP_MASK;
		}
		memberTable[i] = key;
	}
	function tableHas(key) {
		let i = Math.imul(key, 2654435761) & MEMBERSHIP_MASK;
		while (memberTable[i] !== 0) {
			if (memberTable[i] === key) return true;
			i = (i + 1) & MEMBERSHIP_MASK;
		}
		return false;
	}

	// The selection scope's membership: zero and rebuild the table from the
	// set's current keys. One pass over ≤256 keys, no allocation.
	function buildMembership(set) {
		memberTable.fill(0);
		const n = set ? set.count() : 0;
		for (let i = 0; i < n; i++) tableInsert(set.keyAt(i));
		return n;
	}

	// Stage 2's per-planet test, on the summary's env block. A count-only
	// query (min planets, barren, belt, terran) names no planet of its own, so
	// a terran candidate reports the star's best one and the rest report
	// nothing; a type or range query reports the first planet that satisfies
	// every predicate.
	function planetMatch(f, sum) {
		if (f.minPlanets > 0 && sum.planetCount < f.minPlanets) return false;
		if (f.barrenOnly && sum.planetCount !== 0) return false;
		if (f.needsBelt && sum.beltCount === 0) return false;
		if (f.terranOnly && sum.terranCount === 0) return false;
		if (f.planetTypeMask === 0 && !f.aFiltered && !f.pMassFiltered
			&& !f.tsurfFiltered && !f.teqFiltered) {
			if (f.terranOnly) {
				best[0] = sum.bestTerranA;
				best[1] = sum.bestTerranMass;
				best[2] = sum.bestTerranTsurf;
				best[3] = sum.bestTerranDisplay;
			}
			return true;
		}
		const env = sum.env;
		const count = sum.envCount;
		for (let p = 0; p < count; p++) {
			const display = env.display[p];
			if (f.planetTypeMask !== 0 && ((f.planetTypeMask >>> display) & 1) === 0) continue;
			const a = env.a[p];
			if (a < f.aMin || a > f.aMax) continue;
			const m = env.mass[p];
			if (m < f.planetMassMin || m > f.planetMassMax) continue;
			const tsurf = env.tsurf[p];
			if (tsurf < f.tsurfMin || tsurf > f.tsurfMax) continue;
			const teq = env.teq[p];
			if (teq < f.teqMin || teq > f.teqMax) continue;
			best[0] = a; best[1] = m; best[2] = tsurf; best[3] = display;
			return true;
		}
		return false;
	}

	// Stage 1's derived half: one stellarInputs per record that reaches it,
	// reused by stage 2 as the summary's snapshot, so a mass filter and a
	// planet filter together still cost one derivation per star.
	function derivedOk(f, star) {
		if (f.massFiltered && (star.mass < f.massMin || star.mass > f.massMax)) return false;
		if (f.derivedComponent && (COMPONENT_BIT[star.component] & f.componentMask) === 0) return false;
		return true;
	}

	function run(rawFilter, scopeArg) {
		const f = normalizeFilter(rawFilter);
		results.count = 0;
		stats.scanned = 0;
		stats.matched = 0;
		stats.truncated = false;
		stats.msStage1 = 0;
		stats.msStage2 = 0;
		best[0] = 0; best[1] = 0; best[2] = 0; best[3] = 0;
		const scope = scopeArg === SCOPE_SELECTION || scopeArg === SCOPE_GALAXY ? scopeArg : SCOPE_AUTO;
		stats.scope = scope;
		if (!source) return results;

		const set = source.set || null;
		// 'auto' is the plan's default: the selection whenever it holds
		// anything, the whole galaxy when it does not. The report names the
		// scope that ran, so a fallback is visible rather than silent.
		const selectionScope = scope === SCOPE_SELECTION
			|| (scope === SCOPE_AUTO && !!set && set.count() > 0);
		stats.scope = selectionScope ? SCOPE_SELECTION : SCOPE_GALAXY;
		if (selectionScope) buildMembership(set);

		const blocks = source.blocks();
		const table = blocks ? blocks.blocks : null;
		if (!table || table.length === 0) return results;
		const identity = blocks.identity;
		const positions = blocks.float32;
		const words = blocks.uint32;
		if (!identity || !positions || !words) return results;
		const field = typeof source.field === 'function' ? source.field() : null;
		const model = typeof source.model === 'function' ? source.model() : null;
		if (!model) return results;
		ref.model = model;
		ref.field = field;
		const cam = typeof source.cameraPos === 'function' ? source.cameraPos() : null;
		const camX = cam ? cam[0] : 0, camY = cam ? cam[1] : 0, camZ = cam ? cam[2] : 0;
		const ly = lyToKpc();
		const distMin2 = f.distMin * ly * (f.distMin * ly);
		const distMax2 = f.distMax * ly * (f.distMax * ly);
		const decode = recordLib().decodeAbsMag;
		const planets = planetsLib();
		if (!inputs) {
			inputs = planets.createStellarInputs();
			summary = planets.createSummaryRecord();
		}
		const VISIBLE = 0x10000;
		const stage1Start = nowMs();
		let derived = null;                 // the snapshot, when this record needed one
		let matched = 0;

		for (let b = 0; b < table.length; b++) {
			const block = table[b];
			const base = block.offset;
			const total = block.count;
			const blockIndex = b;           // 0..4 == planets.js's BLOCK_* order
			const fieldBuffers = blockIndex === 0 ? field : null;
			for (let i = 0; i < total; i++) {
				const slot = base + i;
				const w = slot * 4;
				const packed = words[w + 3];
				if ((packed & VISIBLE) === 0) continue;
				const key = identity[slot];
				if (selectionScope && !tableHas(key)) continue;
				// From here on the record is in scope: it counts as scanned.
				stats.scanned++;
				const px = positions[w], py = positions[w + 1], pz = positions[w + 2];
				let d2 = 0;
				if (f.distFiltered) {
					const dx = px - camX, dy = py - camY, dz = pz - camZ;
					d2 = dx * dx + dy * dy + dz * dz;
					if (d2 > distMax2 || d2 < distMin2) continue;
				}
				const cls = packed & 0xFF;
				if (f.classMask !== 0 && ((f.classMask >>> cls) & 1) === 0) continue;
				if (f.stateMask !== 0 && (f.stateMask & classState(cls)) === 0) continue;
				if (f.magFiltered) {
					const mag = decode((packed >>> 8) & 255);
					if (mag < f.magLo || mag > f.magHi) continue;
				}
				// Stage 1's derived half. The procedural block reads its
				// component from the field buffers it was sampled from; every
				// other block replays the generator's own derivation.
				derived = null;
				if (f.derivedMass || f.derivedComponent) {
					const direct = fieldBuffers ? fieldBuffers.component[i] : -1;
					if (direct >= 0 && !f.derivedMass) {
						if ((COMPONENT_BIT[direct] & f.componentMask) === 0) continue;
					} else {
						fillRef(ref, key, blockIndex, slot, px, py, pz, packed);
						const star = planets.stellarInputs(ref, inputs);
						if (!derivedOk(f, star)) continue;
						derived = star;
					}
				}
				// Stage 2: the summary walk, with the snapshot already derived.
				if (f.planetQuery) {
					if (!derived) {
						fillRef(ref, key, blockIndex, slot, px, py, pz, packed);
						derived = planets.stellarInputs(ref, inputs);
					}
					const stage2Start = nowMs();
					const sum = planets.systemSummary(ref, derived, summary);
					if (!planetMatch(f, sum)) continue;
					stats.msStage2 += nowMs() - stage2Start;
				}
				if (matched < SEARCH_MAX_RESULTS) {
					stgKey[matched] = key;
					stgDist[matched] = Math.sqrt(d2 > 0 ? d2
						: (px - camX) * (px - camX) + (py - camY) * (py - camY) + (pz - camZ) * (pz - camZ));
					stgSlot[matched] = slot;
					stgClass[matched] = cls;
					const o = matched * 5, p4 = matched * 4;
					if (derived) {
						stgStar[o] = derived.mass;
						stgStar[o + 1] = derived.luminosity;
						stgStar[o + 2] = derived.teff;
						stgStar[o + 3] = derived.age;
						stgStar[o + 4] = derived.rStar;
						stgBest[p4] = best[0];
						stgBest[p4 + 1] = best[1];
						stgBest[p4 + 2] = best[2];
						stgBest[p4 + 3] = best[3];
					} else {
						stgStar[o] = 0; stgStar[o + 1] = 0; stgStar[o + 2] = 0;
						stgStar[o + 3] = 0; stgStar[o + 4] = 0;
						stgBest[p4] = 0; stgBest[p4 + 1] = 0;
						stgBest[p4 + 2] = 0; stgBest[p4 + 3] = 0;
					}
				}
				best[0] = 0; best[1] = 0; best[2] = 0; best[3] = 0;
				matched++;
				if (matched > SEARCH_MAX_RESULTS) stats.truncated = true;
			}
		}
		stats.msStage1 = nowMs() - stage1Start - stats.msStage2;
		stats.matched = matched;

		// Nearest-first: insertion-sort the first matches by camera distance,
		// then gather. The cell manager's nearest-first rule, so "the nearest
		// Earth-like world" is answerable without a second query.
		const n = Math.min(matched, SEARCH_MAX_RESULTS);
		for (let i = 0; i < n; i++) order[i] = i;
		for (let i = 1; i < n; i++) {
			const o = order[i];
			const d = stgDist[o];
			let j = i - 1;
			while (j >= 0 && stgDist[order[j]] > d) { order[j + 1] = order[j]; j--; }
			order[j + 1] = o;
		}
		for (let r = 0; r < n; r++) {
			const m = order[r];
			results.keys[r] = stgKey[m];
			results.dist[r] = stgDist[m];
			results.slot[r] = stgSlot[m];
			results.class[r] = stgClass[m];
			const o = m * 5, p = r * 5;
			for (let k = 0; k < 5; k++) results.star[p + k] = stgStar[o + k];
			const q = m * 4, s = r * 4;
			for (let k = 0; k < 4; k++) results.best[s + k] = stgBest[q + k];
			// The result position: the record's own bytes, so a caller can act
			// on a result without re-reading the staging buffer.
			const w = stgSlot[m] * 4;
			results.x[r] = positions[w];
			results.y[r] = positions[w + 1];
			results.z[r] = positions[w + 2];
		}
		results.count = n;
		return results;
	}

	return { setSource, run, results, stats };
}

// One ref per record, filled in place: the scan never allocates, so a 300k
// pass costs no garbage. Only the landmark and catalog blocks take the derived
// path from the packed word; the procedural blocks re-derive from their own
// buffers and never read these two fields.
function fillRef(ref, key, block, slot, x, y, z, packed) {
	ref.key = key;
	ref.block = block;
	ref.slot = slot;
	ref.x = x;
	ref.y = y;
	ref.z = z;
	ref.colorIndex = packed & 0xFF;
	ref.absMag = recordLib().decodeAbsMag((packed >>> 8) & 255);
}

const Search = {
	createSearch, normalizeFilter, serializeFilter, parseFilter,
	SEARCH_MAX_RESULTS, SEARCH_CHUNK,
	SCOPE_AUTO, SCOPE_SELECTION, SCOPE_GALAXY,
	STATE_MS, STATE_GIANT, STATE_WD,
	COMPONENT_THIN: BIT_THIN, COMPONENT_THICK: BIT_THICK,
	COMPONENT_BULGE: BIT_BULGE, COMPONENT_HALO: BIT_HALO,
	COMPONENT_NAMES: COMPONENT_TOKEN_NAMES,
	classBit, planetTypeBit, classState,
	TOKEN_CLASSES, TOKEN_STATES, TOKEN_COMPONENTS, TOKEN_TYPES, TOKEN_FLAGS,
};
if (typeof module !== 'undefined') module.exports = Search;
if (typeof window !== 'undefined') window.Search = Search;
