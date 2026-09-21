// experiments/tile-encoder.js
// Offline tool: catalog CSV → one binary tile bundle for the runtime.
//
// Input : Gaia-style CSV (source_id, ra, dec, parallax, parallax_error,
//         pmra, pmdec, phot_g_mean_mag, bp_rp)
// Output: src/data/tiles/catalog.js — a bundle assigning window.__galaxy_catalog
//
// Filtering (plan.md §5):
//   - magnitude cut  : keep G < gLimit (default 12, Gaia completeness limit)
//   - quality cut    : parallax_over_error > 5
//   - radial decimation: inside 100 pc, keep with probability (r/r0)^2 so the
//     solar neighbourhood is not 100x over-dense compared to the rest
//
// Cell layout: three LOD bands, fixed cubic cells on a lattice anchored at the
// Sun. Cell index = floor(coord / cellSize), so cell bounds are derivable and
// no per-band origin offset has to be stored.
//
//   near   :  25 pc cells, stars within 250 pc
//   medium : 100 pc cells, stars within 2 kpc
//   far    : 500 pc cells, stars within 10 kpc
//
// Output bundle (see src/stream/tile-loader.js for the reader):
//
//   { version: 1, encoding: 'base64', recordBytes: 16,
//     bands: { near: { cellSize: 0.025, streamRadiusKpc: 0.5 }, ... },
//     cells: [ { b: 'near', c: [x, y, z], n: 12, d: '<base64>' } ], ... }
//
// Why a bundle and not a file per cell: the previous layout shipped 1170 files
// for 2502 stars (0.8 MB of files carrying 77 KB of records), one script
// injection per cell, and no manifest to stream against. One base64 bundle is
// one request and 4/3 of the binary size; the runtime decodes cells lazily.
//
// Usage:
//   node experiments/tile-encoder.js                                   # Gaia subset
//   node experiments/tile-encoder.js --input gaia.csv --output src/data/tiles/
//   node experiments/tile-encoder.js --mock 200000                     # synthetic
//   node experiments/tile-encoder.js --gLimit 14 --quality 3

'use strict';

const fs = require('fs');
const path = require('path');
const density = require('../src/math/density.js');
const hash = require('../src/math/hash.js');
const sampling = require('../src/math/sampling.js');
const starTypes = require('../src/math/star-types.js');
const records = require('../src/math/star-record.js');
// The conversion lives in src/math/coords.js so the runtime landmarks
// (src/data/landmarks.js) and this encoder share one frame. The self-test
// below still validates it here, where it first mattered.
const coords = require('../src/math/coords.js');

const galaxy = require('../src/math/galaxy.js');
const model = galaxy.MILKY_WAY;

const CONFIG = {
	gLimit: 12.0,               // G < 12: the magnitude where Gaia is complete
	quality: 5.0,               // parallax_over_error > 5
	decimationRadiusKpc: 0.100, // reference radius for solar-neighbourhood decimation
	// `radius` is the galactocentric radius a star must be inside to be encoded
	// into the band (near wins over medium wins over far). `streamRadiusKpc` is
	// how far the camera can be from a cell of this band before the cell is
	// dropped from the resident set — it travels with the data so the loader and
	// the cell manager cannot disagree about it.
	bands: {
		near: { cellSize: 0.025, radius: 0.250, streamRadiusKpc: 0.5 },
		medium: { cellSize: 0.100, radius: 2.000, streamRadiusKpc: 2.5 },
		far: { cellSize: 0.500, radius: 10.000, streamRadiusKpc: 12.0 },
	},
};

// --- Coordinate conversion: RA/Dec/parallax → Sun-centred galactic XYZ (kpc) ---
// Implemented in src/math/coords.js (shared with the runtime landmarks).
const raDecParallaxToGalactic = coords.raDecParallaxToGalactic;

function testCoordinateConversion() {
	const checks = [];
	// Sirius: RA 101.287155, Dec -16.716116, parallax 379.21 mas.
	const sirius = raDecParallaxToGalactic(101.287155, -16.716116, 379.21);
	checks.push({ name: 'Sirius distance ≈ 2.64 pc', pass: Math.abs(sirius.distKpc - 0.00264) < 0.0001 });
	checks.push({ name: 'Sirius galactic latitude ≈ -8 deg', pass: Math.abs(sirius.b + 8) < 2 });
	// Galactic centre direction at 8 kpc: X must be ≈ +8.178 kpc (centre is at +X).
	const gc = raDecParallaxToGalactic(266.4051, -28.9362, 0.122);
	checks.push({ name: 'Galactic centre at 8 kpc: x ≈ +8.2', pass: Math.abs(gc.x - 8.2) < 0.5 });
	checks.push({ name: 'Galactic centre at 8 kpc: |y| < 1', pass: Math.abs(gc.y) < 1 });
	return checks;
}

// --- Filtering ---
function shouldKeep(star, config) {
	if (star.appMag > config.gLimit) return false;
	if (star.parallaxOverError < config.quality) return false;
	const r = Math.sqrt(star.x * star.x + star.y * star.y + star.z * star.z);
	if (r < config.decimationRadiusKpc) {
		const keepProbability = (r / config.decimationRadiusKpc) ** 2;
		if (hash.hash01(star.sourceId) >= keepProbability) return false;
	}
	return true;
}

// Absolute magnitude from the observed G magnitude and the parallax distance.
// coords.absoluteMagnitude takes pc; the encoder measures distances in kpc.
function absoluteMagnitude(appMag, distKpc) {
	return coords.absoluteMagnitude(appMag, distKpc * 1000);
}

function bandAndCell(x, y, z, config) {
	const r = Math.sqrt(x * x + y * y + z * z);
	for (const band of Object.keys(config.bands)) {
		const spec = config.bands[band];
		if (r >= spec.radius) continue;
		const size = spec.cellSize;
		return {
			band,
			cellSize: size,
			cx: Math.floor(x / size),
			cy: Math.floor(y / size),
			cz: Math.floor(z / size),
		};
	}
	return null;
}

function encodeTiles(stars, config) {
	const tiles = new Map();
	const kept = [];
	let droppedMagnitude = 0;
	let droppedQuality = 0;
	let droppedDecimation = 0;
	let droppedOutOfBounds = 0;

	for (const star of stars) {
		if (star.appMag > config.gLimit) { droppedMagnitude++; continue; }
		if (star.parallaxOverError < config.quality) { droppedQuality++; continue; }
		const cell = bandAndCell(star.x, star.y, star.z, config);
		if (!cell) { droppedOutOfBounds++; continue; }
		const r = Math.sqrt(star.x * star.x + star.y * star.y + star.z * star.z);
		if (r < config.decimationRadiusKpc) {
			const keepProbability = (r / config.decimationRadiusKpc) ** 2;
			if (hash.hash01(star.sourceId) >= keepProbability) { droppedDecimation++; continue; }
		}
		const key = `${cell.band}|${cell.cx}|${cell.cy}|${cell.cz}`;
		let tile = tiles.get(key);
		if (!tile) {
			tile = { band: cell.band, cellSize: cell.cellSize, c: [cell.cx, cell.cy, cell.cz], stars: [] };
			tiles.set(key, tile);
		}
		tile.stars.push(star);
		kept.push(star);
	}

	return {
		tiles,
		summary: {
			input: stars.length,
			kept: kept.length,
			droppedMagnitude,
			droppedQuality,
			droppedDecimation,
			droppedOutOfBounds,
			cellCount: tiles.size,
		},
	};
}

// Pack the tiles into the bundle object read by src/stream/tile-loader.js.
function buildBundle(tiles, meta) {
	const cells = [];
	let starCount = 0;
	// Stable order: band, then z, y, x — deterministic output for a given input.
	const keys = Array.from(tiles.keys()).sort();
	for (const key of keys) {
		const tile = tiles.get(key);
		const bytes = new Uint8Array(tile.stars.length * records.RECORD_BYTES);
		const view = new DataView(bytes.buffer);
		for (let i = 0; i < tile.stars.length; i++) {
			const star = tile.stars[i];
			records.writeRecord(
				view, i * records.RECORD_BYTES,
				star.x, star.y, star.z,
				records.spectralClassIndex(star.spectralClass),
				star.absMag,
				records.FLAG_VISIBLE | (star.flags || 0),
				0,
			);
		}
		cells.push({
			b: tile.band,
			c: tile.c,
			n: tile.stars.length,
			d: Buffer.from(bytes).toString('base64'),
		});
		starCount += tile.stars.length;
	}
	const bands = {};
	for (const band of Object.keys(CONFIG.bands)) {
		bands[band] = {
			cellSize: CONFIG.bands[band].cellSize,
			streamRadiusKpc: CONFIG.bands[band].streamRadiusKpc,
		};
	}
	return {
		version: 1,
		generated: new Date().toISOString().slice(0, 10),
		source: meta.source,
		encoding: 'base64',
		recordBytes: records.RECORD_BYTES,
		bands,
		starCount,
		cellCount: cells.length,
		cells,
	};
}

function writeBundle(bundle, outPath) {
	const header = `// Auto-generated by experiments/tile-encoder.js from ${bundle.source}. Do not edit.\n`
		+ `// ${bundle.starCount} stars in ${bundle.cellCount} cells, StarPacked records, base64 payloads.\n`
		+ `// Read by src/stream/tile-loader.js (window.__galaxy_catalog).\n`;
	const body = `(function(){\n`
		+ `\tvar g = (typeof window !== 'undefined') ? window : (typeof globalThis !== 'undefined') ? globalThis : this;\n`
		+ `\tg['__galaxy_catalog'] = ${JSON.stringify(bundle)};\n`
		+ `\tif (typeof module !== 'undefined') module.exports = g['__galaxy_catalog'];\n`
		+ `})();\n`;
	fs.mkdirSync(path.dirname(outPath), { recursive: true });
	fs.writeFileSync(outPath, header + body);
	return fs.statSync(outPath).size;
}

// --- CSV ---
function readCsv(filepath) {
	const lines = fs.readFileSync(filepath, 'utf-8').split(/\r?\n/).filter(l => l.trim());
	if (lines.length < 2) return [];
	const header = lines[0].split(',').map(h => h.trim().toLowerCase());
	const rows = [];
	for (let i = 1; i < lines.length; i++) {
		const cols = lines[i].split(',');
		if (cols.length !== header.length) continue;
		const row = {};
		for (let j = 0; j < header.length; j++) row[header[j]] = cols[j].trim();
		rows.push(row);
	}
	return rows;
}

// BP-RP colour index → spectral class (rough binning, only used for the LUT).
function bpRpToSpectralClass(bpRp) {
	const v = parseFloat(bpRp);
	if (!Number.isFinite(v)) return 'G';
	if (v < -0.1) return 'O';
	if (v < 0.5) return 'B';
	if (v < 1.0) return 'A';
	if (v < 1.5) return 'F';
	if (v < 2.5) return 'K';
	return 'M';
}

function parseGaiaCsv(filepath) {
	const rows = readCsv(filepath);
	const stars = [];
	let skipped = 0;
	for (const row of rows) {
		const sourceId = parseInt(row['source_id'], 10);
		const ra = parseFloat(row['ra']);
		const dec = parseFloat(row['dec']);
		const parallax = parseFloat(row['parallax']);
		const parallaxError = parseFloat(row['parallax_error']);
		const appMag = parseFloat(row['phot_g_mean_mag']);
		if ([sourceId, ra, dec, parallax, parallaxError, appMag].some(v => !Number.isFinite(v))) { skipped++; continue; }
		if (parallax <= 0) { skipped++; continue; }
		const g = raDecParallaxToGalactic(ra, dec, parallax);
		stars.push({
			sourceId,
			x: g.x,
			y: g.y,
			z: g.z,
			distKpc: g.distKpc,
			appMag,
			absMag: absoluteMagnitude(appMag, g.distKpc),
			spectralClass: bpRpToSpectralClass(row['bp_rp']),
			parallaxOverError: parallaxError > 0 ? parallax / parallaxError : 0,
			flags: 0,
		});
	}
	return { stars, skipped };
}

// Synthetic catalog from the analytical model, for stress-testing the loader.
function generateMockStars(count, seed) {
	const positions = sampling.sampleGalaxyStars(model, seed, count);
	const stars = new Array(count);
	const derived = {};
	for (let i = 0; i < count; i++) {
		starTypes.deriveStar(model, seed * 31 + i + 1, positions.component[i], positions.R[i], positions.distToArm[i], derived);
		const distKpc = Math.sqrt(
			positions.x[i] * positions.x[i] + positions.y[i] * positions.y[i] + positions.z[i] * positions.z[i],
		);
		stars[i] = {
			sourceId: i + 1,
			x: positions.x[i],
			y: positions.y[i],
			z: positions.z[i],
			distKpc,
			appMag: derived.absMag + 5 * Math.log10(Math.max(1, distKpc * 1000)) - 5,
			absMag: derived.absMag,
			spectralClass: derived.spectralClass,
			parallaxOverError: 50,
			flags: 0,
		};
	}
	return { stars, skipped: 0 };
}

// --- CLI ---
function parseArgs(argv) {
	const args = { mock: 0, input: null, output: path.join(__dirname, '..', 'src', 'data', 'tiles'), log: true };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--mock') {
			args.mock = Number(argv[i + 1]);
			if (Number.isFinite(args.mock) && args.mock > 0) i++;
			else args.mock = 200000;
		} else if (arg === '--input') args.input = argv[++i];
		else if (arg === '--output') args.output = argv[++i];
		else if (arg === '--gLimit') CONFIG.gLimit = Number(argv[++i]);
		else if (arg === '--quality') CONFIG.quality = Number(argv[++i]);
		else if (arg === '--no-log') args.log = false;
	}
	return args;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	console.log('=== tile-encoder ===\n');

	console.log('Coordinate conversion:');
	for (const check of testCoordinateConversion()) {
		console.log(`  ${check.pass ? 'OK  ' : 'FAIL'} ${check.name}`);
	}

	let parsed;
	let source;
	if (args.mock > 0) {
		source = `mock(${args.mock})`;
		console.log(`\nGenerating ${args.mock.toLocaleString()} synthetic stars from the density model...`);
		parsed = generateMockStars(args.mock, 12345);
	} else {
		source = args.input || path.join(__dirname, '..', 'src', 'data', 'gaia-subset.csv');
		console.log(`\nReading ${source}`);
		parsed = parseGaiaCsv(source);
		source = path.basename(source);
	}
	console.log(`  parsed ${parsed.stars.length.toLocaleString()} stars` + (parsed.skipped ? ` (${parsed.skipped} skipped)` : ''));

	const { tiles, summary } = encodeTiles(parsed.stars, CONFIG);
	const bundle = buildBundle(tiles, { source });
	const outPath = path.join(args.output, 'catalog.js');
	const fileBytes = writeBundle(bundle, outPath);

	const perBand = {};
	for (const cell of bundle.cells) perBand[cell.b] = (perBand[cell.b] || 0) + cell.n;

	console.log('\nEncoding:');
	console.log(`  input:            ${summary.input.toLocaleString()}`);
	console.log(`  kept:             ${summary.kept.toLocaleString()}`);
	console.log(`  dropped magnitude: ${summary.droppedMagnitude.toLocaleString()} (G > ${CONFIG.gLimit})`);
	console.log(`  dropped quality:   ${summary.droppedQuality.toLocaleString()} (parallax SNR < ${CONFIG.quality})`);
	console.log(`  dropped decimated: ${summary.droppedDecimation.toLocaleString()} (< 100 pc)`);
	console.log(`  dropped out of bounds: ${summary.droppedOutOfBounds.toLocaleString()}`);
	console.log(`  cells: ${summary.cellCount}  (stars per band: ${Object.keys(perBand).map(b => `${b} ${perBand[b]}`).join(', ') || 'none'})`);
	console.log(`  bundle: ${outPath} — ${(fileBytes / 1024).toFixed(1)} KB`);
	if (summary.cellCount) {
		console.log(`  bytes/star in bundle: ${(fileBytes / Math.max(1, summary.kept)).toFixed(1)}`);
	}

	// Round-trip check: the runtime reader must agree with the writer.
	const loader = require('../src/stream/tile-loader.js');
	const manifest = loader.prepareBundle(bundle);
	let decoded = 0;
	const scratch = new Uint8Array(65536);
	for (let i = 0; i < manifest.cellCount; i++) {
		decoded += loader.decodeCell(manifest, i, scratch) / records.RECORD_BYTES;
	}
	const ok = decoded === manifest.starCount && manifest.starCount === summary.kept;
	console.log(`\nRound-trip: ${ok ? 'OK' : 'FAIL'} — decoded ${decoded} of ${summary.kept} stars`);

	if (args.log) {
		const logPath = path.join(__dirname, 'logs', 'tile-encoder.json');
		fs.mkdirSync(path.dirname(logPath), { recursive: true });
		fs.writeFileSync(logPath, JSON.stringify({
			date: new Date().toISOString(),
			source,
			config: CONFIG,
			summary,
			perBand,
			bundleBytes: fileBytes,
			roundTripOk: ok,
		}, null, 2));
		console.log(`Wrote ${logPath}`);
	}

	if (!ok) process.exit(1);
}

if (typeof module !== 'undefined') {
	module.exports = {
		CONFIG, raDecParallaxToGalactic, testCoordinateConversion, shouldKeep,
		absoluteMagnitude, bandAndCell, encodeTiles, buildBundle, writeBundle,
		generateMockStars, parseGaiaCsv, bpRpToSpectralClass, main,
	};
}
if (require.main === module) {
	main();
}
