// src/stream/tile-loader.js
// Catalog tile bundle loading and decoding.
//
// Asset format (one file per catalog, emitted by experiments/tile-encoder.js):
//
//   window.__galaxy_catalog = {
//       version: 1,
//       source: 'gaia-subset.csv',
//       encoding: 'base64',
//       recordBytes: 16,
//       bands: { near: { cellSize: 0.025, streamRadiusKpc: 0.5 }, ... },
//       cells: [ { b: 'near', c: [3, -2, 1], n: 12, d: '<base64 of n*16 bytes>' }, ... ],
//   };
//
// Why one bundle instead of one file per cell: a 5000-star catalog used to ship
// as 1170 files averaging 2 stars each — 1170 script injections, 10x the bytes
// (decimal arrays instead of binary) and no manifest to stream against. One
// base64 bundle is one request, 4/3 of the binary size, and decodes lazily per
// cell.
//
// Base64 is used because fetch() is blocked under file://, and a base64 payload
// survives <script> injection in every browser. Decoding happens per cell on
// demand, so a 100 MB catalog costs only the cells the camera is near.

'use strict';

const BUNDLE_GLOBAL = '__galaxy_catalog';
const BUNDLE_VERSION = 1;
// Residency radii for bundles written before the bands carried their own.
const DEFAULT_BAND_RADIUS = [0.5, 2.5, 12.0];

// Decode base64 into `out` at `byteOffset`, returning the bytes written.
// Decoding straight into the destination keeps the per-cell path free of
// throwaway buffers (a cell is up to a few KB and cells are decoded while the
// camera moves).
function decodeBase64Into(str, out, byteOffset) {
	if (typeof atob === 'function') {
		const binary = atob(str);
		for (let i = 0; i < binary.length; i++) out[byteOffset + i] = binary.charCodeAt(i);
		return binary.length;
	}
	const bytes = Buffer.from(str, 'base64');
	out.set(bytes, byteOffset);
	return bytes.length;
}

function decodeBase64(str) {
	const padding = str.endsWith('==') ? 2 : (str.endsWith('=') ? 1 : 0);
	const out = new Uint8Array((str.length / 4) * 3 - padding);
	decodeBase64Into(str, out, 0);
	return out;
}

// Inject a classic <script> tag and resolve once it has executed. Works under
// file://, where fetch() and dynamic import() are blocked.
function injectScript(src, globalName) {
	return new Promise((resolve, reject) => {
		const script = document.createElement('script');
		script.src = src;
		script.async = true;
		script.onload = () => {
			const value = window[globalName];
			delete window[globalName];
			script.remove();
			if (value === undefined) {
				reject(new Error(`${src} loaded but did not define ${globalName}`));
				return;
			}
			resolve(value);
		};
		script.onerror = () => {
			script.remove();
			reject(new Error(`Failed to load ${src}`));
		};
		document.head.appendChild(script);
	});
}

// Validate the manifest and normalise it into the shape the cell manager wants:
// flat typed arrays, no per-cell objects in the streaming path.
function prepareBundle(bundle) {
	if (!bundle || bundle.version !== BUNDLE_VERSION) {
		throw new Error(`Catalog bundle version mismatch (expected ${BUNDLE_VERSION}, got ${bundle && bundle.version})`);
	}
	if (bundle.recordBytes !== 16 || bundle.encoding !== 'base64') {
		throw new Error('Unsupported catalog bundle encoding');
	}
	const cells = bundle.cells || [];
	const count = cells.length;
	const bandOf = new Uint8Array(count);
	const cellSize = new Float32Array(count);
	const origin = new Float32Array(count * 3);
	const firstStar = new Uint32Array(count + 1);
	const payloads = new Array(count);
	let totalStars = 0;

	const bandNames = Object.keys(bundle.bands);
	const bandRadius = new Float32Array(bandNames.length);
	for (let b = 0; b < bandNames.length; b++) {
		const radius = bundle.bands[bandNames[b]].streamRadiusKpc;
		bandRadius[b] = typeof radius === 'number' ? radius : (DEFAULT_BAND_RADIUS[b] || 0);
	}
	for (let i = 0; i < count; i++) {
		const cell = cells[i];
		const bandIndex = bandNames.indexOf(cell.b);
		if (bandIndex < 0) throw new Error(`Cell ${i} refers to unknown band ${cell.b}`);
		const size = bundle.bands[cell.b].cellSize;
		bandOf[i] = bandIndex;
		cellSize[i] = size;
		origin[i * 3 + 0] = cell.c[0] * size;
		origin[i * 3 + 1] = cell.c[1] * size;
		origin[i * 3 + 2] = cell.c[2] * size;
		if (typeof cell.n !== 'number' || cell.n < 0) throw new Error(`Cell ${i} has no star count`);
		firstStar[i] = totalStars;
		totalStars += cell.n;
		payloads[i] = cell.d;
	}
	firstStar[count] = totalStars;

	if (bundle.starCount !== undefined && bundle.starCount !== totalStars) {
		throw new Error(`Catalog bundle starCount ${bundle.starCount} does not match the cell manifests (${totalStars})`);
	}

	return {
		version: bundle.version,
		source: bundle.source || 'unknown',
		cellCount: count,
		starCount: totalStars,
		bandNames,
		bands: bundle.bands,
		bandRadius,
		bandOf,
		cellSize,
		origin,
		firstStar,
		payloads,
	};
}

// Decode one cell into `out` (a Uint8Array of at least cellStarCount*16 bytes),
// returning the byte length written. Throws on a truncated payload so a broken
// asset fails loudly instead of rendering garbage.
function decodeCell(manifest, cellIndex, out) {
	const stars = manifest.firstStar[cellIndex + 1] - manifest.firstStar[cellIndex];
	const expected = stars * 16;
	const written = decodeBase64Into(manifest.payloads[cellIndex], out, 0);
	if (written !== expected) {
		throw new Error(`Cell ${cellIndex} decoded to ${written} bytes, expected ${expected}`);
	}
	return expected;
}

async function loadCatalog(url) {
	const raw = await injectScript(url, BUNDLE_GLOBAL);
	return prepareBundle(raw);
}

const TileLoader = {
	BUNDLE_GLOBAL, BUNDLE_VERSION, DEFAULT_BAND_RADIUS,
	decodeBase64, decodeBase64Into, prepareBundle, decodeCell, loadCatalog,
};
if (typeof module !== 'undefined') module.exports = TileLoader;
if (typeof window !== 'undefined') window.TileLoader = TileLoader;
