// src/math/hash.js
// PCG hash and helpers — the single hash used by the CPU sampler and mirrored
// in WGSL by src/render/shaders.js (pcg-hash). Reference: Nathan Reed,
// "Hash Functions for GPU Rendering", 2021.
//
// Every procedural star is a pure function of (seed, index), so the galaxy is
// reproducible across runs and machines and no PRNG state exists anywhere.

'use strict';

// 32-bit PCG hash. Returns uint32.
function pcgHash(input) {
	// Math.imul keeps 32-bit multiplication semantics.
	let state = input | 0;
	state = Math.imul(state, 0x7feb352d) | 0;
	state = (state ^ (state >>> 15)) | 0;
	state = Math.imul(state, 0x846ca68b) | 0;
	state = (state ^ (state >>> 13)) | 0;
	state = (state ^ (state >>> 16)) | 0;
	return state >>> 0;
}

// Combine four uint32 into one.
function hash4(a, b, c, d) {
	let h = pcgHash(a | 0);
	h = Math.imul(h, 0x9e3779b1) ^ (b | 0);
	h = pcgHash(h);
	h = Math.imul(h, 0x85ebca77) ^ (c | 0);
	h = pcgHash(h);
	h = Math.imul(h, 0xc2b2ae3d) ^ (d | 0);
	return pcgHash(h) >>> 0;
}

// hash01 in [0, 1).
function hash01(seed) {
	return pcgHash(seed) / 4294967296;
}

// hash01 of stream (seed, channel) — the non-allocating primitive every
// sampler in this repo is built from. `channel` decorrelates the draws that
// describe one star (mass, age, spin, ...).
function hash01At(seed, channel) {
	return pcgHash(Math.imul(seed | 0, 0x9e3779b1) + (channel | 0)) / 4294967296;
}

// hash2D returns {x, y} in [0,1)^2 from a single seed.
function hash2D(seed) {
	const a = pcgHash(seed);
	const b = pcgHash(a ^ 0x9e3779b9);
	return { x: a / 4294967296, y: b / 4294967296 };
}

// hash3D returns {x, y, z} in [0,1)^3 from a single seed.
function hash3D(seed) {
	const a = pcgHash(seed);
	const b = pcgHash(a ^ 0x9e3779b9);
	const c = pcgHash(b ^ 0x85ebca77);
	return { x: a / 4294967296, y: b / 4294967296, z: c / 4294967296 };
}

// Wang hash (faster, weaker statistics). Kept as the validated fallback for
// low-end GPUs; see experiments/hash-quality-test.js.
function wangHash(input) {
	let h = input | 0;
	h = Math.imul(h, 2654435761) >>> 0;
	h = (h ^ (h >>> 16)) >>> 0;
	h = Math.imul(h, 0x85ebca6b) | 0;
	h = (h ^ (h >>> 13)) >>> 0;
	h = Math.imul(h, 0xc2b2ae35) | 0;
	return (h ^ (h >>> 16)) >>> 0;
}

const HashLib = { pcgHash, hash4, hash01, hash01At, hash2D, hash3D, wangHash };
if (typeof module !== 'undefined') module.exports = HashLib;
if (typeof window !== 'undefined') window.HashLib = HashLib;
