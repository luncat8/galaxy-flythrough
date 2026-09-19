// experiments/lib/hash.js
// PCG hash and helpers - mirrors what the WGSL compute shader will use.
// Reference: Nathan Reed, "Hash Functions for GPU Rendering", 2021.

'use strict';

// 32-bit PCG hash. Returns uint32.
function pcgHash(input) {
	// Use Math.imul to keep 32-bit multiplication semantics.
	let state = input | 0;
	state = Math.imul(state, 0x7feb352d) | 0;
	state = ((state ^ (state >>> 15)) | 0) >>> 0;
	state = Math.imul(state, 0x846ca68b) | 0;
	state = ((state ^ (state >>> 13)) | 0) >>> 0;
	state = (state ^ (state >>> 16)) | 0;
	return state >>> 0;
}

// Combine four uint32 into one (poor man's 64-bit mix).
function hash4(a, b, c, d) {
	let h = pcgHash(a | 0);
	h = Math.imul(h, 0x9e3779b1) ^ (b | 0);
	h = pcgHash(h);
	h = Math.imul(h, 0x85ebca77) ^ (c | 0);
	h = pcgHash(h);
	h = Math.imul(h, 0xc2b2ae3d) ^ (d | 0);
	h = pcgHash(h);
	return h >>> 0;
}

// hash01 in [0, 1).
function hash01(seed) {
	return (pcgHash(seed) >>> 0) / 4294967296;
}

// hash2D returns {x, y} in [0,1)^2 from a single seed.
function hash2D(seed) {
	const a = pcgHash(seed);
	const b = pcgHash(a ^ 0x9e3779b9);
	return { x: (a >>> 0) / 4294967296, y: (b >>> 0) / 4294967296 };
}

// hash3D returns {x, y, z} in [0,1)^3.
function hash3D(seed) {
	const a = pcgHash(seed);
	const b = pcgHash(a ^ 0x9e3779b9);
	const c = pcgHash(b ^ 0x85ebca77);
	return {
		x: (a >>> 0) / 4294967296,
		y: (b >>> 0) / 4294967296,
		z: (c >>> 0) / 4294967296,
	};
}

// Wang hash (fallback, faster but weaker).
function wangHash(input) {
	let h = input | 0;
	h = (Math.imul(h, 2654435761) | 0) >>> 0;
	h = ((h ^ (h >>> 16)) | 0) >>> 0;
	h = Math.imul(h, 0x85ebca6b) | 0;
	h = ((h ^ (h >>> 13)) | 0) >>> 0;
	h = Math.imul(h, 0xc2b2ae35) | 0;
	h = ((h ^ (h >>> 16)) | 0) >>> 0;
	return h >>> 0;
}

if (typeof module !== 'undefined') {
	module.exports = { pcgHash, hash4, hash01, hash2D, hash3D, wangHash };
}
if (typeof window !== 'undefined') {
	window.HashLib = { pcgHash, hash4, hash01, hash2D, hash3D, wangHash };
}
