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
const SPECTRAL_CLASSES = ['O', 'B', 'A', 'F', 'G', 'K', 'M', 'WD', 'RG'];
const CLASS_COLORS = [
	[153, 179, 255], // O  blue
	[192, 204, 255], // B  blue-white
	[242, 242, 255], // A  white
	[255, 250, 235], // F  yellow-white
	[255, 242, 192], // G  yellow
	[255, 199, 128], // K  orange
	[255, 140, 102], // M  red
	[217, 217, 255], // WD pale blue
	[255, 100, 77],  // RG deep red
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
