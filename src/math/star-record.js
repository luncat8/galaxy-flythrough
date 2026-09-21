// src/math/star-record.js
// The StarPacked GPU record — one definition for the whole project.
//
// Before this module existed the 16-byte layout was written out three times
// (tile encoder, renderer, packing test) and drifted. Everything now goes
// through packRecord/readRecord:
//
//   struct StarPacked {        // 16 bytes, matches WGSL in render/shaders.js
//       x: f32, y: f32, z: f32,   // absolute galactic kpc (camera-relative in shader)
//       packed: u32,
//   };
//
//   packed bits 0-7   colorIndex   index into the 256-entry colour LUT
//   packed bits 8-15  absMagByte   absolute magnitude, ABS_MAG_MIN..ABS_MAG_MAX
//   packed bits 16-23 flags        bit 0 visible, 1 landmark, 2 variable
//   packed bits 24-31 jitter       sub-cell position jitter / spare
//
// Apparent magnitude is deliberately NOT stored: the vertex shader derives it
// from the camera distance, so flying towards a star makes it brighter and
// larger. That is what makes the fly-through read as movement rather than as a
// static star field scrolling past.

'use strict';

const RECORD_BYTES = 16;
const ABS_MAG_MIN = -12.0;
const ABS_MAG_MAX = 18.0;
const ABS_MAG_SPAN = ABS_MAG_MAX - ABS_MAG_MIN;   // 30 mag over 256 steps = 0.118 mag

const FLAG_VISIBLE = 1;
const FLAG_LANDMARK = 2;
const FLAG_VARIABLE = 4;

// LUT order. Index == position in this list; the colour LUT texture is built
// from the same list so encoder and shader can never disagree.
// 'RGe' is not a classification result — it is the dedicated LUT slot the
// metal-poor spheroid-giant shift lands on: RG is already the reddest class,
// so "one step redder" needs its own entry rather than an out-of-range index.
const SPECTRAL_CLASSES = ['O', 'B', 'A', 'F', 'G', 'K', 'M', 'WD', 'RG', 'RGe'];
// Blackbody-based sRGB colours, authoritatively tuned against Mitchell
// Charity's star-colour table and Stellarium's B-V palette. Channel values
// are sRGB bytes (uploaded via rgba8unorm-srgb so the GPU linearises them
// correctly before additive blending). M-type red is intentionally de-
// saturated — the IMF produces ~87% M dwarfs, and a neon-red palette makes
// the entire field read as red; the softer chromaticity preserves type
// distinction without overwhelming everything.
const CLASS_COLORS = [
	[155, 176, 255], // O  (30000 K+) blue
	[170, 191, 255], // B  (10–30 kK) blue-white
	[213, 224, 255], // A  (7.5–10 kK) white
	[249, 245, 255], // F  (6–7.5 kK) yellow-white
	[255, 238, 221], // G  (5.2–6 kK) yellow (Sun = ~G2, 5800 K)
	[255, 207, 160], // K  (3.7–5.2 kK) pale orange
	[255, 190, 150], // M  (<3.7 kK) pale orange-red, deliberately not crimson
	[200, 210, 255], // WD (hot but faint) pale blue-white
	[255, 140, 100], // RG  deep red-orange (these are rare enough to be vivid)
	[255, 106, 76],  // RGe metal-poor spheroid giants: one LUT step redder than RG
];
const DEFAULT_CLASS_INDEX = SPECTRAL_CLASSES.indexOf('G');

function spectralClassIndex(cls) {
	const i = SPECTRAL_CLASSES.indexOf(cls);
	return i < 0 ? DEFAULT_CLASS_INDEX : i;
}

function encodeAbsMag(absMag) {
	const byte = Math.round((absMag - ABS_MAG_MIN) / ABS_MAG_SPAN * 255);
	return byte < 0 ? 0 : (byte > 255 ? 255 : byte);
}

function decodeAbsMag(byte) {
	return ABS_MAG_MIN + (byte & 0xFF) * (ABS_MAG_SPAN / 255);
}

function packPacked(colorIndex, absMag, flags, jitter) {
	return ((colorIndex & 0xFF)
		| ((encodeAbsMag(absMag) & 0xFF) << 8)
		| ((flags & 0xFF) << 16)
		| ((jitter & 0xFF) << 24)) >>> 0;
}

// Write one record into a DataView (little-endian, matching WebGPU).
function writeRecord(view, byteOffset, x, y, z, colorIndex, absMag, flags, jitter) {
	view.setFloat32(byteOffset, Math.fround(x), true);
	view.setFloat32(byteOffset + 4, Math.fround(y), true);
	view.setFloat32(byteOffset + 8, Math.fround(z), true);
	view.setUint32(byteOffset + 12, packPacked(colorIndex, absMag, flags, jitter || 0), true);
}

// Inverse of writeRecord, for tests and for the loader's sanity checks.
// Decoding is explicit: an all-zero record is not a star (FLAG_VISIBLE unset).
function readRecord(view, byteOffset) {
	const packed = view.getUint32(byteOffset + 12, true);
	return {
		x: view.getFloat32(byteOffset, true),
		y: view.getFloat32(byteOffset + 4, true),
		z: view.getFloat32(byteOffset + 8, true),
		packed,
		colorIndex: packed & 0xFF,
		absMag: decodeAbsMag((packed >>> 8) & 0xFF),
		flags: (packed >>> 16) & 0xFF,
		jitter: (packed >>> 24) & 0xFF,
		visible: ((packed >>> 16) & FLAG_VISIBLE) !== 0,
	};
}

// 256-entry RGBA8 colour LUT for the 1x256 texture read by the shader.
function buildColorLUT() {
	const data = new Uint8Array(256 * 4);
	for (let i = 0; i < 256; i++) {
		const c = CLASS_COLORS[i < CLASS_COLORS.length ? i : DEFAULT_CLASS_INDEX];
		data[i * 4 + 0] = c[0];
		data[i * 4 + 1] = c[1];
		data[i * 4 + 2] = c[2];
		data[i * 4 + 3] = 255;
	}
	return data;
}

// One API object, two namespaces: the browser and Node must expose the same
// surface, or a caller that works under Node (writeRecord) is missing in the
// page, which is exactly how this file shipped a boot-time TypeError.
const API = {
	RECORD_BYTES, ABS_MAG_MIN, ABS_MAG_MAX, ABS_MAG_SPAN,
	FLAG_VISIBLE, FLAG_LANDMARK, FLAG_VARIABLE,
	SPECTRAL_CLASSES, CLASS_COLORS, DEFAULT_CLASS_INDEX,
	spectralClassIndex, encodeAbsMag, decodeAbsMag, packPacked,
	writeRecord, readRecord, buildColorLUT,
};
if (typeof module !== 'undefined') module.exports = API;
if (typeof window !== 'undefined') window.StarRecord = API;
