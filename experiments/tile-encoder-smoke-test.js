// experiments/tile-encoder-smoke-test.js
// End-to-end smoke test of the tile encoder on synthetic data: sample a small
// galaxy, encode it, write the bundle to a temp file, read it back through the
// shipping loader, and decode every cell. No Gaia file needed.
//
// The point is the path that real data takes: encode -> bundle -> base64 ->
// script file -> loader -> StarPacked records. Anything that only breaks on
// real input (unit slips, band assignment, truncation of magnitudes) shows up
// here as a decode mismatch rather than as a blank sky in the browser.
//
// Output: experiments/logs/tile-encoder-smoke.json

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// The bundle file assigns to window and to module.exports; give it a window.
global.window = global.window || global;

const encoder = require('./tile-encoder.js');
const records = require('../src/math/star-record.js');
const loader = require('../src/stream/tile-loader.js');

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
	return !!pass;
}

// 32k, not 4k: since the giant branch became temporary (0.4.5), the mock
// Milky Way's bright end is the turnoff shell plus O/B stars, not a 3%
// permanent-giant tail — a 4k draw keeps ~6 stars past G < 12, too thin to
// exercise cells and bands. 32k keeps 30 at the fixed seed, in ~0.1 s.
const MOCK_STARS = 32000;
const MOCK_SEED = 20240919;

// --- 1. Coordinate conversion -------------------------------------------
{
	console.log('Coordinate conversion...');
	const results = encoder.testCoordinateConversion();
	for (const r of results) {
		check(`coord: ${r.name}`, r.pass, r.detail);
	}
}

// --- 2. Mock generation --------------------------------------------------
{
	console.log(`Generating ${MOCK_STARS} mock stars...`);
	const t0 = Date.now();
	const mock = encoder.generateMockStars(MOCK_STARS, MOCK_SEED);
	const genMs = Date.now() - t0;
	check('mock generation returns the requested star count', mock.stars.length === MOCK_STARS, mock.stars.length);
	const first = mock.stars[0];
	check('mock stars carry the fields the encoder reads',
		typeof first.sourceId === 'number' && typeof first.x === 'number'
		&& typeof first.appMag === 'number' && typeof first.spectralClass === 'string'
		&& typeof first.parallaxOverError === 'number');
	let badPos = 0;
	let badMag = 0;
	for (const s of mock.stars) {
		if (!Number.isFinite(s.x) || !Number.isFinite(s.y) || !Number.isFinite(s.z)) badPos++;
		if (!(s.appMag >= -10 && s.appMag < 60)) badMag++;
	}
	check('mock positions are finite', badPos === 0, badPos);
	check('mock apparent magnitudes are physical', badMag === 0, badMag);
	check('mock generation is deterministic',
		encoder.generateMockStars(50, MOCK_SEED).stars[0].x === encoder.generateMockStars(50, MOCK_SEED).stars[0].x);
	console.log(`  ${genMs} ms`);
}

// --- 3. Encoding ---------------------------------------------------------
const mock = encoder.generateMockStars(MOCK_STARS, MOCK_SEED);
const encodeStart = Date.now();
const { tiles, summary } = encoder.encodeTiles(mock.stars, encoder.CONFIG);
const encodeMs = Date.now() - encodeStart;
console.log(`Encoded ${summary.kept}/${summary.input} stars into ${summary.cellCount} cells in ${encodeMs} ms`);
// A whole-galaxy model sample is dominated by faint M dwarfs beyond a few
// hundred parsecs, so the G limit is expected to reject most of it. What must
// hold exactly is the cut itself, and that what survives skews near/bright.
const overLimit = mock.stars.filter(s => s.appMag > encoder.CONFIG.gLimit).length;
check('the magnitude cut removes exactly the stars fainter than the limit',
	overLimit === summary.droppedMagnitude, { overLimit, droppedMagnitude: summary.droppedMagnitude });
check('the encoder keeps a usable sample', summary.kept > 20, summary.kept);
const maxBandRadius = Math.max(...Object.values(encoder.CONFIG.bands).map(b => b.radius));
let outsideBand = 0;
for (const tile of tiles.values()) {
	for (const star of tile.stars) {
		if (Math.sqrt(star.x * star.x + star.y * star.y + star.z * star.z) > maxBandRadius) outsideBand++;
	}
}
check('every encoded star lies inside the outermost band', outsideBand === 0, { outsideBand, maxBandRadius });
check('every dropped star is accounted for',
	summary.kept + summary.droppedMagnitude + summary.droppedQuality
		+ summary.droppedDecimation + summary.droppedOutOfBounds === summary.input, summary);
check('the encoder produces cells', summary.cellCount > 0, summary.cellCount);

let totalInTiles = 0;
let badBand = 0;
for (const tile of tiles.values()) {
	totalInTiles += tile.stars.length;
	if (!Object.hasOwn(encoder.CONFIG.bands, tile.band)) badBand++;
}
check('cell payloads hold exactly the kept stars', totalInTiles === summary.kept, { totalInTiles, kept: summary.kept });
check('every cell belongs to a configured band', badBand === 0, badBand);

// --- 4. Bundle -----------------------------------------------------------
const bundle = encoder.buildBundle(tiles, { source: 'mock' });
check('the bundle records its schema version', bundle.version === 1, bundle.version);
check('the bundle record size matches StarPacked', bundle.recordBytes === records.RECORD_BYTES, bundle.recordBytes);
check('the bundle counts match the tiles', bundle.starCount === summary.kept && bundle.cellCount === summary.cellCount,
	{ stars: bundle.starCount, cells: bundle.cellCount });
check('every band carries its cell size and streaming radius',
	Object.keys(bundle.bands).length === 3
	&& Object.values(bundle.bands).every(b => b.cellSize > 0 && b.streamRadiusKpc > b.cellSize),
	bundle.bands);
check('cells are stored in a deterministic order',
	encoder.buildBundle(tiles, { source: 'mock' }).cells.every((c, i) => c.d === bundle.cells[i].d));
let badPayload = 0;
for (const cell of bundle.cells) {
	const bytes = Buffer.from(cell.d, 'base64');
	if (bytes.length !== cell.n * records.RECORD_BYTES) badPayload++;
}
check('every base64 payload decodes to n records', badPayload === 0, badPayload);

const tmpPath = path.join(os.tmpdir(), `galaxy-bundle-smoke-${process.pid}.js`);
const tmpBytes = encoder.writeBundle(bundle, tmpPath);
check('the written bundle is a plausible size',
	tmpBytes > summary.kept * records.RECORD_BYTES && tmpBytes < summary.kept * 100, tmpBytes);

// --- 5. Loader round-trip ------------------------------------------------
const loaded = require(tmpPath);
check('the bundle file hands back the same object', loaded.cellCount === bundle.cellCount);
const manifest = loader.prepareBundle(loaded);
check('the loader reads the band table from the manifest',
	manifest.bandNames.join(',') === Object.keys(bundle.bands).join(',')
	&& manifest.bandRadius.every((r, i) => r === bundle.bands[manifest.bandNames[i]].streamRadiusKpc),
	{ bands: manifest.bandNames, radii: Array.from(manifest.bandRadius) });

const scratch = new Uint8Array(4096 * records.RECORD_BYTES);
const mismatchCount = { positions: 0, outsideCell: 0, magnitude: 0, classIndex: 0, invisible: 0 };
let decodedStars = 0;
let decodedCells = 0;
for (let i = 0; i < manifest.cellCount; i++) {
	const n = manifest.starCountOf ? manifest.starCountOf(i) : bundle.cells[i].n;
	const bytes = loader.decodeCell(manifest, i, scratch);
	decodedCells++;
	const view = new DataView(scratch.buffer, 0, bytes);
	const cell = bundle.cells[i];
	const size = bundle.bands[manifest.bandNames[manifest.bandOf[i]]].cellSize;
	for (let k = 0; k < n; k++) {
		const rec = records.readRecord(view, k * records.RECORD_BYTES);
		decodedStars++;
		if (!rec.visible) mismatchCount.invisible++;
		if (!(rec.x >= cell.c[0] * size - 1e-6 && rec.x <= (cell.c[0] + 1) * size + 1e-6
			&& rec.y >= cell.c[1] * size - 1e-6 && rec.y <= (cell.c[1] + 1) * size + 1e-6
			&& rec.z >= cell.c[2] * size - 1e-6 && rec.z <= (cell.c[2] + 1) * size + 1e-6)) {
			mismatchCount.outsideCell++;
		}
		if (rec.absMag < records.ABS_MAG_MIN - 1e-3 || rec.absMag > records.ABS_MAG_MAX + 1e-3) mismatchCount.magnitude++;
	}
}
check('every star in the bundle decodes', decodedStars === bundle.starCount, { decodedStars, expected: bundle.starCount });
check('every cell decodes', decodedCells === manifest.cellCount, decodedCells);
check('decoded positions lie inside their own cell', mismatchCount.outsideCell === 0, mismatchCount);
check('decoded magnitudes stay inside the packed range', mismatchCount.magnitude === 0, mismatchCount);
check('decoded records are all visible', mismatchCount.invisible === 0, mismatchCount);

// Re-encoding the same tiles must produce the same bytes: the asset is
// reproducible, which is what lets the freshness check trust it.
const again = encoder.buildBundle(tiles, { source: 'mock' });
check('encoding is reproducible byte for byte',
	again.cells.every((c, i) => c.d === bundle.cells[i].d && c.n === bundle.cells[i].n));

fs.unlinkSync(tmpPath);

// --- Report --------------------------------------------------------------
let passed = 0;
let failed = 0;
for (const c of checks) {
	if (c.pass) passed++; else failed++;
	console.log(`  ${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.pass ? '' : `  -> ${JSON.stringify(c.detail)}`}`);
}
console.log(`\n${passed}/${checks.length} passed, ${failed} failed`);

const logPath = path.join(__dirname, 'logs', 'tile-encoder-smoke.json');
fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.writeFileSync(logPath, JSON.stringify({
	date: new Date().toISOString(),
	mockStars: MOCK_STARS,
	seed: MOCK_SEED,
	summary,
	bundleBytes: tmpBytes,
	encodeMs,
	totalChecks: checks.length,
	passed,
	failed,
	checks,
}, null, 2));
console.log(`Wrote ${logPath}`);
console.log('\n=== VERDICT ===');
console.log(failed === 0 ? 'PASS — encoder, bundle and loader agree' : `FAIL — ${failed} checks failed`);
process.exit(failed === 0 ? 0 : 1);
