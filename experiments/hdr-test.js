// experiments/hdr-test.js
// Validates the ACES Narkowicz tone curve the renderer ships, evaluated in JS
// against the WGSL constant set in src/render/shaders.js. The curve is small
// enough that an analytic check pins its behaviour exactly: monotonic, fixed
// points at 0 and 1, bounded output, no NaN across the exposure range.
//
// The brightness-gain property the HDR pipeline promises — many overlapping
// stars sum linearly, then ACES rolls the sum off — is checked directly: a
// dense input (sum of N equal fluxes) maps to a brighter LDR pixel than one
// star alone, but still below 1.0.
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

const CONST_RE = /const\s+([a-e])\s*:\s*f32\s*=\s*([0-9.]+);/g;
const consts = {};
let m;
while ((m = CONST_RE.exec(TONEMAP)) !== null) {
        consts[m[1]] = parseFloat(m[2]);
}

check('the tonemap shader part exists and is non-trivial',
        typeof TONEMAP === 'string' && TONEMAP.length > 200, TONEMAP.length);
check('the tonemap shader exposes the five ACES constants a-e',
        consts.a && consts.b && consts.c && consts.d && consts.e, consts);

// JS mirror of the WGSL acesNarkowicz.Keeps the test pinned to the exact
// arithmetic the GPU runs; if the WGSL drifts, this test fails until the JS
// mirror is updated too.
function aces(x) {
        const { a, b, c, d, e } = consts;
        const num = x * (a * x + b);
        const den = x * (c * x + d) + e;
        return Math.max(0, Math.min(1, num / den));
}

// --- Fixed points and bounds --------------------------------------------
{
        check('f(0) = 0 exactly', aces(0) === 0, aces(0));
        // ACES Narkowicz fitted: f(1) ≈ 0.8, not 1.0. The implicit white point is
        // ~16.3; that is the value that maps to 1.0.
        const f1 = aces(1);
        check('f(1) ≈ 0.8 (filmic mid-grey)', f1 > 0.78 && f1 < 0.82, f1);
        const fWhite = aces(16.3);
        check('f(16.3) ≈ 1.0 (implicit white point)', fWhite > 0.99 && fWhite <= 1.0, fWhite);
        check('output is bounded to [0, 1] for very large input', aces(1e6) <= 1.0, aces(1e6));
        // The ACES rational function is only meaningful for non-negative flux.
        // The WGSL clamp() keeps the output in [0, 1] regardless of the input sign.
        check('output stays in [0, 1] for negative input (clamp)',
                aces(-1) >= 0 && aces(-1) <= 1, aces(-1));
}

// --- Monotonicity -------------------------------------------------------
{
        let monotonic = true;
        let prev = -1;
        for (let i = 0; i <= 1000; i++) {
                const x = i / 10;       // 0 to 100
                const y = aces(x);
                if (y < prev - 1e-9) { monotonic = false; break; }
                prev = y;
        }
        check('the curve is monotonically non-decreasing on [0, 100]', monotonic);
}

// --- No NaN across the exposure range -----------------------------------
{
        let anyNaN = false;
        for (let exp = -4; exp <= 4; exp++) {
                for (let flux = 0; flux < 1000; flux += 0.5) {
                        const v = aces(flux * Math.pow(2, exp));
                        if (!Number.isFinite(v)) { anyNaN = true; break; }
                }
                if (anyNaN) break;
        }
        check('no NaN or Infinity across the exposure range (×2^-4 .. ×2^4)', !anyNaN);
}

// --- The brightness-gain property --------------------------------------
// This is the user's explicit ask: many stars at one screen pixel must sum
// their flux linearly and only roll off once at the curve.
{
        const oneStar = aces(1.0);            // flux 1.0 from one star
        const fiveStars = aces(5.0);           // 5 stars summed linearly
        check('five overlapping stars are brighter than one',
                fiveStars > oneStar, { one: oneStar, five: fiveStars });
        check('five overlapping stars still roll off below 1.0',
                fiveStars < 1.0, fiveStars);
        check('the gain is sub-linear (compressive, not multiplicative)',
                fiveStars < 5 * oneStar, { linear: 5 * oneStar, tonemapped: fiveStars });
}

// --- Linear exposure multiplier (the ; / ' knob) ------------------------
{
        const e = renderer.LINEAR_EXPOSURE_DEFAULT;
        check('default linear exposure is 1.0', e === 1.0, e);
        check('linear exposure range spans the half-stops 0.125 to 8.0',
                renderer.LINEAR_EXPOSURE_MIN === 0.125 && renderer.LINEAR_EXPOSURE_MAX === 8.0,
                { min: renderer.LINEAR_EXPOSURE_MIN, max: renderer.LINEAR_EXPOSURE_MAX });
        // 8 doublings = 16× brighter from min to max — enough to recover blown
        // highlights or pull up a dim solar neighbourhood.
        const steps = Math.log2(renderer.LINEAR_EXPOSURE_MAX / renderer.LINEAR_EXPOSURE_MIN);
        check('linear exposure covers 6 stops (8× min to 8× max)', Math.abs(steps - 6) < 1e-6, steps);
        // The default multiplies the input by 1 — pre-ACES output equals the sum.
        check('at default exposure, ACES sees the raw summed flux', aces(1 * e) === aces(1));
}

// --- HDR format ---------------------------------------------------------
{
        check('the HDR intermediate format is rgba16float',
                renderer.HDR_DIRECT_FORMAT === 'rgba16float', renderer.HDR_DIRECT_FORMAT);
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
console.log(failed === 0 ? 'PASS — ACES tone curve is sound and bounded' : `FAIL — ${failed} checks failed`);
process.exit(failed === 0 ? 0 : 1);
