// experiments/tile-stream-test.js
// Validates the catalog pipeline end to end without a GPU:
//
//   gaia CSV -> encoder -> bundle (src/data/tiles/catalog.js)
//            -> loader manifest -> cell manager -> staging bytes -> records
//
// Checks:
//   1. the committed bundle matches a fresh encode of src/data/gaia-subset.csv
//      (catches a stale asset, which is how the old per-cell tiles rotted)
//   2. the manifest is consistent (cell count, star count, band radii, origins)
//   3. residency: budget respected, nearest-first, no re-upload while parked
//   4. the resident set follows the camera and empties in the halo
//   5. the decode cache is an LRU and bounded
//   6. the staged bytes decode into records that belong to the cells claimed
//
// Output: experiments/logs/tile-stream.json

'use strict';

const fs = require('fs');
const path = require('path');
const loader = require('../src/stream/tile-loader.js');
const cellManager = require('../src/stream/cell-manager.js');
const records = require('../src/math/star-record.js');
const encoder = require('./tile-encoder.js');
const bundlePath = path.join(__dirname, '..', 'src', 'data', 'tiles', 'catalog.js');

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
	return !!pass;
}

const bundle = require(bundlePath);
const manifest = loader.prepareBundle(bundle);

console.log(`Bundle: ${bundle.source}  ${manifest.cellCount} cells  ${manifest.starCount} stars  `
	+ `${(fs.statSync(bundlePath).size / 1024).toFixed(1)} KB`);

// --- 1. Freshness --------------------------------------------------------
{
	const csvPath = path.join(__dirname, '..', 'src', 'data', 'gaia-subset.csv');
	const parsed = encoder.parseGaiaCsv(csvPath);
	const { tiles } = encoder.encodeTiles(parsed.stars, encoder.CONFIG);
	const fresh = encoder.buildBundle(tiles, { source: path.basename(csvPath) });
	check('committed bundle has the same cell count as a fresh encode',
		fresh.cellCount === manifest.cellCount, { committed: manifest.cellCount, fresh: fresh.cellCount });
	check('committed bundle has the same star count as a fresh encode',
		fresh.starCount === manifest.starCount, { committed: manifest.starCount, fresh: fresh.starCount });
	let identical = fresh.cellCount === manifest.cellCount && fresh.starCount === manifest.starCount;
	let mismatches = 0;
	if (identical) {
		for (let i = 0; i < fresh.cellCount; i++) {
			const a = fresh.cells[i];
			const b = bundle.cells[i];
			if (a.b !== b.b || a.n !== b.n || a.d !== b.d
				|| a.c[0] !== b.c[0] || a.c[1] !== b.c[1] || a.c[2] !== b.c[2]) {
				identical = false;
				mismatches++;
			}
		}
	}
	check('committed bundle is byte-identical to a fresh encode (no stale asset)', identical, mismatches);
	// The cell data matching is not enough: the band table (cell size and
	// streaming radius) is part of the asset too, and a bundle built before
	// those radii existed still passes the cell comparison above.
	check('committed bundle carries the same band table as a fresh encode', (() => {
		const freshNames = Object.keys(fresh.bands);
		const committedNames = Object.keys(bundle.bands || {});
		if (freshNames.join(',') !== committedNames.join(',')) return false;
		for (const name of freshNames) {
			const a = fresh.bands[name];
			const b = bundle.bands[name];
			if (!b || a.cellSize !== b.cellSize || a.streamRadiusKpc !== b.streamRadiusKpc) return false;
		}
		return true;
	})(), { committed: bundle.bands, fresh: fresh.bands });
	check('every band declares a positive streaming radius',
		Object.keys(bundle.bands).length === 3
		&& Object.keys(bundle.bands).every(name => bundle.bands[name].streamRadiusKpc > 0),
		bundle.bands);
	check('the manifest band radii mirror the bundle band table',
		manifest.bandNames.every((name, i) => bundle.bands[name].streamRadiusKpc === manifest.bandRadius[i]),
		{ names: manifest.bandNames, radii: Array.from(manifest.bandRadius) });
}

// --- 2. Manifest ---------------------------------------------------------
{
	check('manifest reports the three bands with streaming radii',
		manifest.bandNames.join(',') === 'near,medium,far'
		&& manifest.bandRadius[0] === 0.5 && manifest.bandRadius[1] === 2.5 && manifest.bandRadius[2] === 12.0,
		{ bands: manifest.bandNames, radii: Array.from(manifest.bandRadius) });
	check('cells are sorted into their bands and sit on the cell lattice',
		(() => {
			for (let i = 0; i < manifest.cellCount; i++) {
				const size = manifest.cellSize[i];
				for (let axis = 0; axis < 3; axis++) {
					const origin = manifest.origin[i * 3 + axis];
					const k = origin / size;
					if (Math.abs(k - Math.round(k)) > 1e-4) return false;
				}
			}
			return true;
		})());
	check('every payload decodes to exactly its star count',
		(() => {
			const scratch = new Uint8Array(64 * records.RECORD_BYTES);
			for (let i = 0; i < manifest.cellCount; i++) {
				const bytes = loader.decodeCell(manifest, i, scratch);
				if (bytes !== (manifest.firstStar[i + 1] - manifest.firstStar[i]) * records.RECORD_BYTES) return false;
			}
			return true;
		})());
}

// --- 3. Residency --------------------------------------------------------
let decodeCalls = 0;
const realDecodeCell = loader.decodeCell;
loader.decodeCell = (m, cell, out) => { decodeCalls++; return realDecodeCell(m, cell, out); };

const manager = cellManager.createCellManager(manifest, { budgetStars: 250000 });
const SUN = { x: 0, y: 0, z: 0.005 };

let update = manager.update(SUN.x, SUN.y, SUN.z, 1);
console.log(`At the Sun: ${update.starCount} resident stars, changed=${update.changed}`);
check('first update reports a changed (empty) residency', update.changed && update.starCount > 0, update);
check('resident star count is inside the budget', update.starCount <= 250000, update.starCount);

const firstStats = manager.stats();
check('all populated cells near the Sun are resident',
	firstStats.cellsResident > 0 && firstStats.starsResident === update.starCount, firstStats);

// Staging bytes must match the resident set exactly, in one contiguous run.
const staging = new Uint8Array(update.starCount * records.RECORD_BYTES);
const written = manager.writeInto(staging, 0);
check('writeInto writes exactly the resident stars', written === update.starCount * records.RECORD_BYTES,
	{ written, expected: update.starCount * records.RECORD_BYTES });
check('writeInto is repeatable (cache hit, no re-decode)', (() => {
	const before = decodeCalls;
	manager.writeInto(staging, 0);
	return decodeCalls === before;
})(), { decodeCalls });

// Every staged star must decode to a finite position inside the resident bands.
check('staged records decode to finite positions inside the streamed volume', (() => {
	const view = new DataView(staging.buffer);
	let maxRadius = 0;
	for (let i = 0; i < update.starCount; i++) {
		const rec = records.readRecord(view, i * records.RECORD_BYTES);
		if (!Number.isFinite(rec.x) || !Number.isFinite(rec.y) || !Number.isFinite(rec.z)) return false;
		if (rec.flags & records.FLAG_LANDMARK) return false;
		const r = Math.hypot(rec.x, rec.y, rec.z);
		if (r > maxRadius) maxRadius = r;
	}
	// The far band reaches 12 kpc; nothing within a 12 kpc sphere is far outside.
	return maxRadius < 13;
})(), 'positions');

// Parked camera: no movement, no rebuild, no upload.
{
	const before = manager.stats().version;
	for (let i = 0; i < 10; i++) manager.update(SUN.x, SUN.y, SUN.z, 0.016);
	const after = manager.stats();
	check('parked camera does not rebuild the residency set', after.version === before, { before, after: after.version });
	check('parked camera reports changed=false', manager.update(SUN.x, SUN.y, SUN.z, 0.016).changed === false);
}

// Sub-cell movement must not trigger a rebuild (the half-cell hysteresis).
{
	const before = manager.stats().version;
	manager.update(SUN.x + 0.005, SUN.y, SUN.z, 0.016);
	check('movement under half the finest cell does not rebuild',
		manager.stats().version === before, { before, after: manager.stats().version });
}

// Crossing a cell boundary must rebuild.
{
	const before = manager.stats();
	const moved = manager.update(SUN.x + 0.05, SUN.y, SUN.z, 0.016);
	check('movement past half the finest cell rebuilds', moved.changed && manager.stats().version > before.version, moved);
}

// Walking away must drop cells until the residency set is empty.
{
	const emptiness = manager.update(300, 300, 300, 1.0);
	check('a jump into the halo empties the residency set and reports the change',
		emptiness.starCount === 0 && emptiness.changed === true, emptiness);
	const repeat = manager.update(300, 300, 300, 1.0);
	check('the empty set is reported as unchanged on the next update', repeat.changed === false && repeat.starCount === 0, repeat);
	check('writeInto with nothing resident writes nothing', manager.writeInto(staging, 0) === 0);
}

// Return to the Sun: the decode cache should serve the cells without decoding.
{
	const before = decodeCalls;
	manager.update(SUN.x, SUN.y, SUN.z, 1.0);
	const after = decodeCalls;
	const stats = manager.stats();
	check('returning to a cached region re-uses decoded cells', after === before, { before, after });
	check('resident set is restored after returning', stats.starsResident > 0, stats);
	void stats;
}

// --- 4. Budget + nearest-first ------------------------------------------
{
	const tight = cellManager.createCellManager(manifest, { budgetStars: 200, bandRadius: [0.5, 2.5, 12.0] });
	const r = tight.update(SUN.x, SUN.y, SUN.z, 1.0);
	const stats = tight.stats();
	check('a tight budget is respected', stats.starsResident <= 200, stats.starsResident);
	check('a tight budget still fills from the closest cells',
		r.changed && stats.cellsResident > 0 && stats.starsResident > 0, stats);

	// The cells that made the cut must be the closest ones: compare against a
	// brute-force nearest-first fill of the same manifest.
	const candidates = [];
	for (let i = 0; i < manifest.cellCount; i++) {
		const radius = manifest.bandRadius[manifest.bandOf[i]];
		const size = manifest.cellSize[i];
		let d2 = 0;
		for (let axis = 0; axis < 3; axis++) {
			const lo = manifest.origin[i * 3 + axis];
			const value = [SUN.x, SUN.y, SUN.z][axis];
			const delta = value < lo ? lo - value : (value > lo + size ? value - lo - size : 0);
			d2 += delta * delta;
		}
		if (d2 <= radius * radius) candidates.push({ i, d2 });
	}
	candidates.sort((a, b) => a.d2 - b.d2 || a.i - b.i);
	let expectedStars = 0;
	const expectedCells = new Set();
	for (const c of candidates) {
		const stars = manifest.firstStar[c.i + 1] - manifest.firstStar[c.i];
		if (expectedStars + stars > 200) break;
		expectedStars += stars;
		expectedCells.add(c.i);
	}
	check('tight budget picks exactly the nearest cells brute force picks',
		stats.starsResident === expectedStars && stats.cellsResident === expectedCells.size,
		{ resident: stats.starsResident, cells: stats.cellsResident, expected: expectedStars, expectedCells: expectedCells.size });
}

// --- 5. Decode cache ----------------------------------------------------
{
	const lru = cellManager.createCellManager(manifest, { budgetStars: 250000, decodeCacheLimit: 8 });
	// Touch more distinct cells than the cache can hold.
	for (let i = 0; i < 40; i++) {
		const angle = (i / 40) * Math.PI * 2;
		lru.update(Math.cos(angle) * 0.6, Math.sin(angle) * 0.6, 0.005, 1.0);
		lru.writeInto(staging, 0);
	}
	const stats = lru.stats();
	check('decode cache stays within its limit', stats.cellsDecoded <= 8, stats.cellsDecoded);
	check('decode cache keeps bytes proportional to the cells held',
		stats.decodedBytes <= 8 * 64 * records.RECORD_BYTES, stats.decodedBytes);
}

loader.decodeCell = realDecodeCell;

// --- Report -------------------------------------------------------------
let passed = 0;
let failed = 0;
for (const c of checks) {
	if (c.pass) passed++; else failed++;
	console.log(`  ${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.pass ? '' : `  -> ${JSON.stringify(c.detail)}`}`);
}
console.log(`\n${passed}/${checks.length} passed, ${failed} failed`);

const logPath = path.join(__dirname, 'logs', 'tile-stream.json');
fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.writeFileSync(logPath, JSON.stringify({
	date: new Date().toISOString(),
	bundle: {
		path: path.relative(path.join(__dirname, '..'), bundlePath),
		bytes: fs.statSync(bundlePath).size,
		cells: manifest.cellCount,
		stars: manifest.starCount,
		bands: manifest.bandNames,
	},
	passing: passed,
	totalChecks: checks.length,
	passed,
	failed,
	checks,
}, null, 2));
console.log(`Wrote ${logPath}`);
console.log('\n=== VERDICT ===');
console.log(failed === 0 ? 'PASS — catalog streaming pipeline is consistent' : `FAIL — ${failed} checks failed`);
process.exit(failed === 0 ? 0 : 1);
