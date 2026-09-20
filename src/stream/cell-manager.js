// src/stream/cell-manager.js
// Decides which catalog cells are resident and writes them into the staging
// buffer the renderer uploads.
//
// Policy (plan.md §9, first working version): cells whose AABB is within a
// per-band radius of the camera, nearest first, until the star budget is spent.
//
//   * the candidate set is recomputed when the camera has moved half a cell of
//     the finest band, or every UPDATE_INTERVAL seconds — never per frame;
//   * a rebuild rewrites the whole catalog region from offset 0, so the
//     renderer uploads one contiguous range and draws one instance range:
//     no fragmentation, no per-cell GPU slots, no hidden-slot bookkeeping;
//   * nearest-first ordering comes from an in-place sort of the candidate
//     indices by (distanceSq, cell index) — exact, so the budget always goes to
//     the closest cells. A shell/counting sort is O(n) but quantises distance
//     over the whole 12 kpc far-band range, which puts the entire inner solar
//     neighbourhood in one shell and makes the order effectively arbitrary.
//   * decoded payloads live in an LRU keyed by cell index: crossing a cell
//     boundary costs one base64 decode, not a re-download.

'use strict';

const UPDATE_INTERVAL = 0.25;   // s between residency checks

function createCellManager(manifest, options) {
	const opts = options || {};
	const budgetStars = opts.budgetStars || 250000;
	// Residency radii come from the bundle (per band); the fallback only covers
	// bundles written before the bands carried them.
	const bandRadius = opts.bandRadius || manifest.bandRadius || [0.5, 2.5, 12.0];
	const decodeCacheLimit = opts.decodeCacheLimit || 4096;
	const cellCount = manifest.cellCount;
	const finestCellSize = manifest.cellSize.length ? Math.min.apply(null, manifest.cellSize) : 0.1;

	let capacity = Math.max(1024, Math.min(cellCount, 1 << 20));
	let candidateIdx = new Int32Array(capacity);
	// Float64 so the sort sees the same distances the brute-force reference
	// computes (a Float32 round could reorder two equidistant cells).
	let candidateDist = new Float64Array(capacity);
	let selectedIdx = new Int32Array(capacity);
	let previousIdx = new Int32Array(capacity);
	let selectedCount = 0;
	let previousCount = -1;
	let residentStars = 0;
	let version = 0;

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
			// Touch: re-inserting moves the key to the most-recent end.
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
			// Nothing in range: the resident set is empty and the renderer must
			// drop its catalog region (otherwise the last cells would stay in
			// the staging buffer and keep drawing at stale positions).
			const emptied = selectedCount !== 0;
			selectedCount = 0;
			residentStars = 0;
			previousCount = 0;
			if (emptied) version++;
			return emptied;
		}

		// Sort the candidate indices in place (nearest first, cell-index tie
		// break). This runs at most UPDATE_INTERVAL times a second, not per
		// frame, so the O(n log n) sort is nothing next to the base64 decodes
		// it protects.
		candidateIdx.subarray(0, candidates).sort((a, b) => (candidateDist[a] - candidateDist[b]) || (a - b));
		selectedCount = 0;
		residentStars = 0;
		for (let i = 0; i < candidates; i++) {
			const cell = candidateIdx[i];
			const stars = manifest.firstStar[cell + 1] - manifest.firstStar[cell];
			if (residentStars + stars > budgetStars) break;
			selectedIdx[selectedCount] = cell;
			selectedCount++;
			residentStars += stars;
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

	// Advance streaming state. Returns { starCount, changed }: starCount is the
	// number of catalog records that must be resident, changed means the
	// renderer has to re-upload the catalog region.
	function update(cameraX, cameraY, cameraZ, dt) {
		sinceUpdate += dt;
		const movedEnough = Math.abs(cameraX - lastX) > finestCellSize * 0.5
			|| Math.abs(cameraY - lastY) > finestCellSize * 0.5
			|| Math.abs(cameraZ - lastZ) > finestCellSize * 0.5;
		if (!movedEnough && sinceUpdate < UPDATE_INTERVAL) {
			return { starCount: residentStars, changed: false };
		}
		sinceUpdate = 0;
		lastX = cameraX;
		lastY = cameraY;
		lastZ = cameraZ;
		const changed = rebuild(cameraX, cameraY, cameraZ);
		return { starCount: residentStars, changed };
	}

	// Copy the resident cells into `bytes` (a Uint8Array view over the staging
	// ArrayBuffer) starting at `byteOffset`. Returns the bytes written.
	function writeInto(bytes, byteOffset) {
		let offset = byteOffset;
		for (let i = 0; i < selectedCount; i++) {
			const payload = decodeCached(selectedIdx[i]);
			bytes.set(payload, offset);
			offset += payload.length;
		}
		return offset - byteOffset;
	}

	function stats(out) {
		const s = out || {};
		s.cellsTotal = cellCount;
		s.cellsResident = selectedCount;
		s.starsResident = residentStars;
		s.cellsDecoded = cache.size;
		s.decodedBytes = cacheBytes;
		s.starsTotal = manifest.starCount;
		s.version = version;
		return s;
	}

	return { update, writeInto, stats, manifest };
}

const CellManager = { createCellManager, UPDATE_INTERVAL };
if (typeof module !== 'undefined') module.exports = CellManager;
if (typeof window !== 'undefined') window.CellManager = CellManager;
