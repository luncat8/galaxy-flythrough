// src/stream/cell-manager.js
// Decides which catalog cells are resident and writes them into the staging
// buffer the renderer uploads. Also enforces local *density parity*: the
// catalog is magnitude-dense near the Sun (~5,000 stars/kpc³ inside 0.5 kpc)
// while the procedural field is galaxy-wide (~200 stars/kpc³), and that 23×
// jump is visible as a dense "snow globe" around the camera. We:
//
//   1. Find resident cells within per-band streaming radii (existing policy).
//   2. Normalise the analytical density *inside the streaming volume itself*
//      so the summed expected count across all resident cells hits
//      VISUAL_STREAM_BUDGET (~3500 stars). This makes the near-Sun visual
//      density independent of how many stars the global galaxy-wide
//      procedural field uses — we don't want 200 stars/kpc³ next to the
//      camera, we want a rich-looking ~few-k-star field that blends smoothly
//      into the global procedural field at the streaming boundary.
//   3. Thin each cell's catalog payload stably (deterministic hash) down to
//      its expected count. Landmarks live in a separate buffer block and
//      are never thinned; only non-flagged catalog stars are thinned here.
//   4. Expose per-cell `fillNeeded` so the renderer can gap-fill under-dense
//      cells with extra local procedural stars.
//
// The rest of the residency policy matches plan.md §9: cells within a
// per-band streaming radius, nearest first, written contiguously into the
// staging buffer so the renderer uploads one range and draws one instance
// range. Decoded payloads live in an LRU.

'use strict';

const UPDATE_INTERVAL = 0.25;   // s between residency checks

// Visual budget for everything drawn inside the streaming volume (catalog
// kept + local gap-fill). Tuned empirically: 3,500 gives a rich-looking
// field near the camera without turning into a solid blob. Exposed as a
// module constant so the renderer test can pin it.
const VISUAL_STREAM_BUDGET = 3500;

// FNV-1a 32-bit hash for stable thinning. We use a small dedicated hash
// here instead of pulling in HashLib so this file can be required in Node
// tests without the dependency chain, and because we only need a uniform
// bit-mixer per (cellId, starSlot, version).
function fnv1a32(buf) {
	let h = 0x811c9dc5;
	for (let i = 0; i < buf.length; i++) {
		h ^= buf[i];
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

function hash01(cellId, slot) {
	const buf = new Uint8Array(8);
	buf[0] = cellId & 0xff;
	buf[1] = (cellId >>> 8) & 0xff;
	buf[2] = (cellId >>> 16) & 0xff;
	buf[3] = (cellId >>> 24) & 0xff;
	buf[4] = slot & 0xff;
	buf[5] = (slot >>> 8) & 0xff;
	buf[6] = (slot >>> 16) & 0xff;
	buf[7] = (slot >>> 24) & 0xff;
	return fnv1a32(buf) / 4294967296;
}

// Record flag bits (match src/math/star-record.js). Re-defined locally with a
// CM_ prefix so loading this file as a classic <script> after star-record.js
// does not collide with the same-named constants the record module declares
// at the top level.
const CM_FLAG_VISIBLE = 1;
const CM_FLAG_LANDMARK = 2;

const cellDensity = (typeof module !== 'undefined' && module.exports)
	? require('../math/density.js')
	: window.DensityLib;
const cellGalaxy = (typeof module !== 'undefined' && module.exports)
	? require('../math/galaxy.js')
	: window.GalaxyLib;

// Expected-star weights come from the same density field the procedural stars
// are sampled from, so the thinned catalog and the gap-fill agree with the sky.
// The model is the caller's, defaulting to the Milky Way preset because the
// catalog *is* a Milky Way asset (see the 0.3.0 mode rule).
function evalRho(model, cx, cy, cz) {
	return cellDensity.rhoTotal(model, cx, cy, cz);
}

function createCellManager(manifest, options) {
	const opts = options || {};
	const model = opts.model || cellGalaxy.MILKY_WAY;
	const budgetStars = opts.budgetStars || 250000;
	// Allow callers to override the visual budget (tests pin it).
	const visualBudget = opts.visualBudget || VISUAL_STREAM_BUDGET;
	const bandRadius = opts.bandRadius || manifest.bandRadius || [0.5, 2.5, 12.0];
	const decodeCacheLimit = opts.decodeCacheLimit || 4096;
	const cellCount = manifest.cellCount;
	const finestCellSize = manifest.cellSize.length ? Math.min.apply(null, manifest.cellSize) : 0.1;

	let capacity = Math.max(1024, Math.min(cellCount, 1 << 20));
	let candidateIdx = new Int32Array(capacity);
	let candidateDist = new Float64Array(capacity);
	let selectedIdx = new Int32Array(capacity);
	let previousIdx = new Int32Array(capacity);
	let selectedCount = 0;
	let previousCount = -1;
	let residentStarsRaw = 0;
	let residentStarsVisible = 0;
	let version = 0;
	let lastCellInfo = [];

	const cache = new Map();
	let cacheBytes = 0;

	let sinceUpdate = Infinity;
	let lastX = Infinity;
	let lastY = Infinity;
	let lastZ = Infinity;

	function ensureCapacity(n) {
		if (capacity >= n) return;
		while (capacity < n) capacity *= 2;
		candidateIdx = new Int32Array(capacity);
		candidateDist = new Float64Array(capacity);
		selectedIdx = new Int32Array(capacity);
		previousIdx = new Int32Array(capacity);
	}

	function decodeCached(cellIndex) {
		let bytes = cache.get(cellIndex);
		if (bytes) {
			cache.delete(cellIndex);
			cache.set(cellIndex, bytes);
			return bytes;
		}
		const stars = manifest.firstStar[cellIndex + 1] - manifest.firstStar[cellIndex];
		bytes = new Uint8Array(stars * 16);
		if (typeof window !== 'undefined') {
			window.TileLoader.decodeCell(manifest, cellIndex, bytes);
		} else {
			require('./tile-loader.js').decodeCell(manifest, cellIndex, bytes);
		}
		cache.set(cellIndex, bytes);
		cacheBytes += bytes.length;
		while (cache.size > decodeCacheLimit) {
			const oldest = cache.keys().next().value;
			cacheBytes -= cache.get(oldest).length;
			cache.delete(oldest);
		}
		return bytes;
	}

	// Rank stars in a cell by deterministic keep-score. Returns the sorted
	// order array (highest score first) and the count that should be kept
	// given `keep`. Landmarks always score 2.0 so they win regardless of
	// `keep`; the actual kept count is clamped to at least the landmark count.
	function rankCell(cellId, bytes, keep) {
		const n = bytes.length / 16;
		const order = new Array(n);
		let landmarkCount = 0;
		for (let i = 0; i < n; i++) {
			const flags = bytes[i * 16 + 14];
			const isLandmark = (flags & CM_FLAG_LANDMARK) !== 0;
			order[i] = { i, score: isLandmark ? 2.0 : hash01(cellId, i) };
			if (isLandmark) landmarkCount++;
		}
		order.sort((a, b) => b.score - a.score);
		const keepCount = Math.min(n, Math.max(landmarkCount, Math.round(keep)));
		return { order, keepCount };
	}

	function rebuild(x, y, z) {
		ensureCapacity(cellCount);
		let candidates = 0;
		for (let i = 0; i < cellCount; i++) {
			const radius = bandRadius[manifest.bandOf[i]];
			if (!(radius > 0)) continue;
			const base = i * 3;
			const size = manifest.cellSize[i];
			const lo0 = manifest.origin[base];
			const lo1 = manifest.origin[base + 1];
			const lo2 = manifest.origin[base + 2];
			const ox = x < lo0 ? lo0 - x : (x > lo0 + size ? x - lo0 - size : 0);
			const oy = y < lo1 ? lo1 - y : (y > lo1 + size ? y - lo1 - size : 0);
			const oz = z < lo2 ? lo2 - z : (z > lo2 + size ? z - lo2 - size : 0);
			const distanceSq = ox * ox + oy * oy + oz * oz;
			if (distanceSq > radius * radius) continue;
			candidateIdx[candidates] = i;
			candidateDist[candidates] = distanceSq;
			candidates++;
		}
		if (candidates === 0) {
			const emptied = selectedCount !== 0;
			selectedCount = 0;
			residentStarsRaw = 0;
			residentStarsVisible = 0;
			lastCellInfo = [];
			previousCount = 0;
			if (emptied) version++;
			return emptied;
		}

		candidateIdx.subarray(0, candidates).sort((a, b) => (candidateDist[a] - candidateDist[b]) || (a - b));
		selectedCount = 0;
		residentStarsRaw = 0;
		for (let i = 0; i < candidates; i++) {
			const cell = candidateIdx[i];
			const stars = manifest.firstStar[cell + 1] - manifest.firstStar[cell];
			if (residentStarsRaw + stars > budgetStars) break;
			selectedIdx[selectedCount] = cell;
			selectedCount++;
			residentStarsRaw += stars;
		}

		// Pass 1: evaluate raw density for each selected cell so we can compute
		// the *local* normalisation — scale the density so total expected stars
		// across the streaming volume equals visualBudget. This is what gives
		// us density parity: the same visual density near the camera as you'd
		// get if the catalog were uniformly sampled, regardless of how many
		// galaxy-wide procedural stars exist.
		const rhos = new Float32Array(selectedCount);
		const vols = new Float32Array(selectedCount);
		let rawMass = 0;
		for (let i = 0; i < selectedCount; i++) {
			const cellId = selectedIdx[i];
			const base = cellId * 3;
			const size = manifest.cellSize[cellId];
			const cx = manifest.origin[base] + size * 0.5;
			const cy = manifest.origin[base + 1] + size * 0.5;
			const cz = manifest.origin[base + 2] + size * 0.5;
			const rho = evalRho(model, cx, cy, cz);
			const vol = size * size * size;
			rhos[i] = rho;
			vols[i] = vol;
			rawMass += rho * vol;
		}
		// Avoid divide-by-zero when every cell happens to have zero density
		// (shouldn't happen inside the galaxy).
		const localScale = rawMass > 1e-9 ? visualBudget / rawMass : 1.0;

		// Pass 2: write per-cell expected/catalogKeep/fillNeeded metadata.
		lastCellInfo = new Array(selectedCount);
		for (let i = 0; i < selectedCount; i++) {
			const cellId = selectedIdx[i];
			const base = cellId * 3;
			const size = manifest.cellSize[cellId];
			const nCatalog = manifest.firstStar[cellId + 1] - manifest.firstStar[cellId];
			const expected = rhos[i] * vols[i] * localScale;
			const catalogKeep = Math.min(nCatalog, Math.max(0, Math.round(expected)));
			const fillNeeded = Math.max(0, Math.ceil(expected) - nCatalog);
			lastCellInfo[i] = {
				id: cellId,
				x0: manifest.origin[base],
				y0: manifest.origin[base + 1],
				z0: manifest.origin[base + 2],
				size,
				nCatalog,
				expected,
				catalogKeep,
				fillNeeded,
			};
		}

		let changed = selectedCount !== previousCount;
		if (!changed) {
			for (let i = 0; i < selectedCount; i++) {
				if (selectedIdx[i] !== previousIdx[i]) { changed = true; break; }
			}
		}
		if (changed) {
			previousIdx.set(selectedIdx.subarray(0, selectedCount));
			previousCount = selectedCount;
			version++;
		}
		return changed;
	}

	function update(cameraX, cameraY, cameraZ, dt) {
		sinceUpdate += dt;
		const movedEnough = Math.abs(cameraX - lastX) > finestCellSize * 0.5
			|| Math.abs(cameraY - lastY) > finestCellSize * 0.5
			|| Math.abs(cameraZ - lastZ) > finestCellSize * 0.5;
		if (!movedEnough && sinceUpdate < UPDATE_INTERVAL) {
			return { starCount: residentStarsVisible, changed: false };
		}
		sinceUpdate = 0;
		lastX = cameraX;
		lastY = cameraY;
		lastZ = cameraZ;
		const changed = rebuild(cameraX, cameraY, cameraZ);
		return { starCount: residentStarsVisible, changed };
	}

	// Copy the resident cells into `bytes`, applying stable thinning so dense
	// near-Sun cells are reduced to match expected density. Returns bytes
	// written (only *visible* records are written, packed contiguously —
	// invisible records are dropped to save GPU bandwidth).
	function writeInto(bytes, byteOffset) {
		let writeOff = byteOffset;
		let visible = 0;
		for (let i = 0; i < selectedCount; i++) {
			const cellId = selectedIdx[i];
			const info = lastCellInfo[i];
			const payload = decodeCached(cellId);
			const keep = info.catalogKeep;
			const n = payload.length / 16;
			if (n <= keep) {
				// Nothing to thin: copy the whole cell verbatim.
				bytes.set(payload, writeOff);
				writeOff += payload.length;
				visible += n;
				continue;
			}
			// Thin. Rank, then copy only the keepers — no need to mark flags
			// since we're writing a compact output (invisible records are
			// never uploaded, saving GPU bandwidth).
			const { order, keepCount } = rankCell(cellId, payload, keep);
			for (let k = 0; k < keepCount; k++) {
				const recOff = order[k].i * 16;
				for (let b = 0; b < 16; b++) bytes[writeOff++] = payload[recOff + b];
			}
			visible += keepCount;
		}
		residentStarsVisible = visible;
		return writeOff - byteOffset;
	}

	// Metadata the renderer needs to place local procedural gap-fill stars:
	// one entry per resident cell with AABB, size, and fillNeeded count.
	function getResidentInfo() {
		return { cells: lastCellInfo, totalCatalogBytes: residentStarsRaw * 16, totalVisibleCatalog: residentStarsVisible };
	}

	function stats(out) {
		const s = out || {};
		s.cellsTotal = cellCount;
		s.cellsResident = selectedCount;
		s.starsResident = residentStarsRaw;
		s.visibleStars = residentStarsVisible;
		s.cellsDecoded = cache.size;
		s.decodedBytes = cacheBytes;
		s.starsTotal = manifest.starCount;
		s.version = version;
		return s;
	}

	return { update, writeInto, stats, manifest, getResidentInfo };
}

const CellManager = { createCellManager, UPDATE_INTERVAL, VISUAL_STREAM_BUDGET };
if (typeof module !== 'undefined') module.exports = CellManager;
if (typeof window !== 'undefined') window.CellManager = CellManager;
