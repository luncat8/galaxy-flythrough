// experiments/tonemap-mirror.js
// The JS model of the tonemap pass the GPU runs (SHADER_PARTS['tonemap']).
// Shared by hdr-test.js (curve properties) and wgsl-exec-check.js (full-pixel
// parity against the shipping WGSL) so the two cannot drift apart from each
// other — only from the WGSL, which both pin explicitly.
//
// Constants are read out of the WGSL text at load, not retyped: a hand-copied
// constant is a second source of truth, and this repo has been bitten by that
// before (see star-record.js header).

'use strict';

const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

// Extract the Hable constants A..F and the luma weights from the tonemap part.
function loadTonemap(shaders) {
	const TONEMAP = shaders.SHADER_PARTS['tonemap'];
	const CONST_RE = /(?:const|let)\s+([A-F]|LUMA_[RGB]):\s*f32\s*=\s*([0-9.]+);/g;
	const consts = {};
	let m;
	while ((m = CONST_RE.exec(TONEMAP)) !== null) {
		consts[m[1]] = parseFloat(m[2]);
	}
	for (const k of ['A', 'B', 'C', 'D', 'E', 'F']) {
		if (typeof consts[k] !== 'number') throw new Error(`tonemap part is missing Hable constant ${k}`);
	}

	function hableRaw(x) {
		const { A, B, C, D, E, F } = consts;
		return (x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F) - E / F;
	}
	// Normalised so input 1 maps to output 1 (the WGSL divides by hable(1)).
	const curveWhite = hableRaw(1);
	function hable(x) {
		return Math.max(0, Math.min(8, hableRaw(x) / curveWhite));
	}

	return { TONEMAP, consts, curveWhite, hableRaw, hable };
}

function luma(r, g, b) {
	return LUMA_R * r + LUMA_G * g + LUMA_B * b;
}

// Full fs_main mirror: exposure → luminance compression → chromaticity
// reconstruction → saturation → highlight desaturation → output clamp.
// params = { exposure, whitePoint, saturation, outputMode } matching the
// TonemapUniform vec4f packing in star-sprites.js.
function tonemapPixel(mirror, r, g, b, params) {
	const hdr = [r * params.exposure, g * params.exposure, b * params.exposure];
	const lumaIn = Math.max(1e-6, luma(hdr[0], hdr[1], hdr[2]));
	const wp = Math.max(params.whitePoint, 0.001);
	const yNorm = lumaIn / wp;
	const lumaCompressed = mirror.hable(yNorm);
	const scale = lumaCompressed / lumaIn * wp;
	const mapped = [hdr[0] * scale, hdr[1] * scale, hdr[2] * scale];
	const mappedLuma = luma(mapped[0], mapped[1], mapped[2]);
	const sat = Math.max(0, params.saturation);
	for (let i = 0; i < 3; i++) mapped[i] = mappedLuma + (mapped[i] - mappedLuma) * sat;
	const over = Math.min(1, Math.max(0, (yNorm - 0.85) / 1.5));
	const overLuma = luma(mapped[0], mapped[1], mapped[2]);
	const peakWhite = Math.max(1.0, overLuma);
	for (let i = 0; i < 3; i++) mapped[i] = mapped[i] + (peakWhite - mapped[i]) * over * over;
	const ceiling = params.outputMode < 0.5 ? 1.0 : 8.0;
	for (let i = 0; i < 3; i++) mapped[i] = Math.min(ceiling, Math.max(0, mapped[i]));
	return mapped;
}

const TonemapMirror = { loadTonemap, tonemapPixel, luma, LUMA_R, LUMA_G, LUMA_B };
if (typeof module !== 'undefined') module.exports = TonemapMirror;
if (typeof window !== 'undefined') window.TonemapMirror = TonemapMirror;
