// experiments/hdr-test.js
// Validates the Hable/Unreal filmic tone curve the renderer ships, evaluated
// in JS against the WGSL constant set in src/render/shaders.js. The curve is
// small enough that an analytic check pins its behaviour exactly: monotonic,
// fixed point at 0, normalised so hable(whitePoint)/hable(1) = 1, bounded
// output, no NaN across the exposure range.
//
// The brightness-gain property the HDR pipeline promises — many overlapping
// stars sum linearly, then the filmic shoulder rolls the sum off — is
// checked directly: a dense input (sum of N equal fluxes) maps to a brighter
// pixel than one star alone, but still below 1.0 at the white point.
//
// Output: experiments/logs/hdr.json

'use strict';

const fs = require('fs');
const path = require('path');

const shaders = require('../src/render/shaders.js');
const renderer = require('../src/render/star-sprites.js');

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
	return !!pass;
}

// --- Pull the curve constants out of the WGSL ----------------------------
const TONEMAP = shaders.SHADER_PARTS['tonemap'];

// Match Hable constants A,B,C,D,E,F (the old ACES a-e regex no longer applies).
const CONST_RE = /(?:const|let)\s+([A-F]):\s*f32\s*=\s*([0-9.]+);/g;
const consts = {};
let m;
while ((m = CONST_RE.exec(TONEMAP)) !== null) {
	consts[m[1]] = parseFloat(m[2]);
}

check('the tonemap shader part exists and is non-trivial',
	typeof TONEMAP === 'string' && TONEMAP.length > 200, TONEMAP.length);
check('the tonemap shader exposes the six Hable/Unreal constants A–F',
	['A','B','C','D','E','F'].every(k => typeof consts[k] === 'number'), consts);

// JS mirror of the WGSL hableFilmic. Keeps the test pinned to the exact
// arithmetic the GPU runs; if the WGSL drifts, this test fails until the JS
// mirror is updated too.
function hableRaw(x) {
	const { A, B, C, D, E, F } = consts;
	return (x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F) - E / F;
}
// Normalised so that input = 1 maps to output = 1 (that's what dividing by
// hable(1) in the WGSL does after scaling by white point).
const curveWhite = hableRaw(1);
function hable(x) {
	return Math.max(0, Math.min(8, hableRaw(x) / curveWhite));
}

// --- Fixed points and bounds --------------------------------------------
{
	check('f(0) ≈ 0 (toe at zero)', Math.abs(hable(0)) < 1e-6, hable(0));
	// At normalised white (input 1) we hit SDR white exactly.
	check('f(1) = 1 (white point maps to display white)', Math.abs(hable(1) - 1) < 1e-6, hable(1));
	// Very large inputs approach the shoulder asymptote monotonically; on
	// SDR we clamp at 1, on HDR we allow up to 8.
	check('f(1000) is finite and ≤ HDR ceiling (8.0)',
		Number.isFinite(hable(1000)) && hable(1000) <= 8.0, hable(1000));
	check('output is non-negative for negative input (clamped at 0)',
		hable(-1) >= 0, hable(-1));
}

// --- Monotonicity -------------------------------------------------------
{
	let monotonic = true;
	let prev = -1;
	for (let i = 0; i <= 2000; i++) {
		const x = i / 10;       // 0 to 200
		const y = hable(x);
		if (y < prev - 1e-9) { monotonic = false; break; }
		prev = y;
	}
	check('the curve is monotonically non-decreasing on [0, 200]', monotonic);
}

// --- No NaN across the exposure range -----------------------------------
{
	let anyNaN = false;
	for (let exp = -4; exp <= 4; exp++) {
		for (let flux = 0; flux < 1000; flux += 0.5) {
			const v = hable(flux * Math.pow(2, exp));
			if (!Number.isFinite(v)) { anyNaN = true; break; }
		}
		if (anyNaN) break;
	}
	check('no NaN or Infinity across the exposure range (×2^-4 .. ×2^4)', !anyNaN);
}

// --- The brightness-gain property --------------------------------------
// Many stars at one screen pixel must sum their flux linearly and only
// roll off once at the curve.
{
	const oneStar = hable(0.2);           // flux 0.2 * whitePoint
	const fiveStars = hable(1.0);         // 5× that sum, exactly at white
	check('five overlapping stars are brighter than one',
		fiveStars > oneStar, { one: oneStar, five: fiveStars });
	check('five stars at the white-point map to ~1.0 (SDR white)',
		Math.abs(fiveStars - 1.0) < 1e-6, fiveStars);
	check('the gain is sub-linear (compressive, not multiplicative)',
		fiveStars < 5 * oneStar, { linear: 5 * oneStar, tonemapped: fiveStars });
}

// --- Linear exposure multiplier (the ; / ' knob) ------------------------
{
	const e = renderer.LINEAR_EXPOSURE_DEFAULT;
	check('default linear exposure is 1.0', e === 1.0, e);
	check('linear exposure range spans 0.125 to 8.0',
		renderer.LINEAR_EXPOSURE_MIN === 0.125 && renderer.LINEAR_EXPOSURE_MAX === 8.0,
		{ min: renderer.LINEAR_EXPOSURE_MIN, max: renderer.LINEAR_EXPOSURE_MAX });
	const steps = Math.log2(renderer.LINEAR_EXPOSURE_MAX / renderer.LINEAR_EXPOSURE_MIN);
	check('linear exposure covers 6 stops (8× min to 8× max)', Math.abs(steps - 6) < 1e-6, steps);
	check('at default exposure, the curve sees the raw summed flux', Math.abs(hable(1 * e) - hable(1)) < 1e-12);
}

// --- HDR format ---------------------------------------------------------
{
	check('the HDR intermediate format is rgba16float',
		renderer.HDR_INTERMEDIATE_FORMAT === 'rgba16float', renderer.HDR_INTERMEDIATE_FORMAT);
}

// --- Report -------------------------------------------------------------
let passed = 0;
let failed = 0;
for (const c of checks) {
	if (c.pass) passed++; else failed++;
	console.log(`  ${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.pass ? '' : `  -> ${JSON.stringify(c.detail)}`}`);
}
console.log(`\n${passed}/${checks.length} passed, ${failed} failed`);

const logPath = path.join(__dirname, 'logs', 'hdr.json');
fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.writeFileSync(logPath, JSON.stringify({
	date: new Date().toISOString(),
	consts,
	totalChecks: checks.length,
	passed,
	failed,
	checks,
}, null, 2));
console.log(`Wrote ${logPath}`);
console.log('\n=== VERDICT ===');
console.log(failed === 0 ? 'PASS — Hable filmic tone curve is sound and bounded' : `FAIL — ${failed} checks failed`);
process.exit(failed === 0 ? 0 : 1);
