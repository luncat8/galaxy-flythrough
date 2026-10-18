// experiments/field-overlay-test.js
// The CPU half of the view field overlay (view-modes.4): the mode vocabulary,
// the splat radius law, the display-range sample and its percentiles, the two
// derived estimators, the uniform layouts and the shared ramp LUTs.
//
// The GPU half is pinned by experiments/renderer-test.js (passes, targets,
// blends, uniform bytes) and experiments/wgsl-validate.js (the three modules);
// this file is about the numbers that decide what the shader draws.
//
// Output: experiments/logs/field-overlay.json

'use strict';

const fs = require('fs');
const path = require('path');

global.window = global;

const FieldRamp = require('../src/math/field-ramp.js');
const FieldOverlay = require('../src/math/field-overlay.js');
const rendererModule = require('../src/render/view-modes-renderer.js');

const checks = [];
function check(name, pass, detail) {
        checks.push({ name, pass: !!pass, detail });
        return !!pass;
}

const EPS = 1e-9;

// --- Modes and sizes ------------------------------------------------------
{
        check('the mode vocabulary is the one the preset and the menu speak',
                FieldOverlay.MODE_NAMES.join(',') === 'off,height,spread,slope'
                && FieldOverlay.MODE_IDS.spread === FieldOverlay.MODE_SPREAD
                && FieldOverlay.MODE_IDS.slope === FieldOverlay.MODE_SLOPE
                && FieldOverlay.modeOf('off') === 0 && FieldOverlay.modeOf('slope') === FieldOverlay.MODE_SLOPE
                && FieldOverlay.modeOf('nope') === 0 && FieldOverlay.modeOf(99) === FieldOverlay.MODE_SLOPE,
                FieldOverlay.MODE_NAMES);

        const s = { w: 0, h: 0 };
        check('the field is half the canvas, clamped to 256..640 wide and >= 128 tall',
                FieldOverlay.fieldSize(s, 1280, 720).w === 640 && s.h === 360
                && FieldOverlay.fieldSize(s, 400, 300).w === 256 && s.h === 192
                && FieldOverlay.fieldSize(s, 3840, 2160).w === 640 && s.h === 360
                && FieldOverlay.fieldSize(s, 300, 1200).w === 256 && s.h === 1024,
                s);

        check('a footprint covers ~1.2 mean inter-star spacings, clamped 2.5..40 px',
                FieldOverlay.splatRadius(0, 640, 360) === 0
                && Math.abs(FieldOverlay.splatRadius(10000, 640, 360)
                        - Math.sqrt(640 * 360 / 10000) * 1.2) < 1e-6
                && FieldOverlay.splatRadius(300000, 640, 360) === 2.5
                && FieldOverlay.splatRadius(50, 640, 360) === 40,
                { many: FieldOverlay.splatRadius(300000, 640, 360), few: FieldOverlay.splatRadius(50, 640, 360) });

        const su = new Float32Array(4);
        FieldOverlay.packSplat(su, 7, 640, 360);
        check('the splat uniform is radius, fieldW, fieldH, 1 pc floor',
                su[0] === 7 && su[1] === 640 && su[2] === 360
                && Math.abs(su[3] - FieldOverlay.MIN_DIST_KPC) < 1e-9, Array.from(su));
}

// --- The range sample ------------------------------------------------------
// A synthetic block: `count` records at the given positions, packed = flags in
// bits 16-23 (FLAG_VISIBLE = 1 → 0x00010000).
function makeBlocks(stars) {
        const bytes = new ArrayBuffer(Math.max(16, stars.length * 16));
        const view = new DataView(bytes);
        for (let i = 0; i < stars.length; i++) {
                view.setFloat32(i * 16, stars[i][0], true);
                view.setFloat32(i * 16 + 4, stars[i][1], true);
                view.setFloat32(i * 16 + 8, stars[i][2], true);
                view.setUint32(i * 16 + 12, 0x00010000, true);
        }
        return {
                view,
                blocks: [{ kind: 'field', offset: 0, count: stars.length }],
        };
}

function sampleOf(stars, camera, mode) {
        const state = FieldOverlay.createRangeState();
        FieldOverlay.refresh(state, {
                blocks: makeBlocks(stars),
                recordBytes: 16,
                orbit: null,
                model: null,
                time: 0,
                camX: camera[0], camY: camera[1], camZ: camera[2],
        }, mode);
        return state;
}

{
        const line = [[1, 0, 0], [2, 0, 0], [4, 0, 0], [8, 0, 0], [16, 0, 0]];
        const state = sampleOf(line, [0, 0, 0], FieldOverlay.MODE_HEIGHT);
        check('every visible record is sampled when the population is under the cap',
                state.samples === 5 && state.count === 5);
        check('height mode reads log10 distance in kpc and brackets the sample',
                state.lo < Math.log10(1) && state.hi > Math.log10(16)
                && state.unit === 'kpc'
                && state.mode === FieldOverlay.MODE_HEIGHT,
                { lo: state.lo, hi: state.hi, unit: state.unit });
        check('the display window is padded by 4% of the span plus 0.02 dex, with a 0.3 dex floor',
                Math.abs((state.hi - state.lo) - ((Math.log10(16) - 0) * 1.08 + 0.04)) < 1e-4
                || (state.hi - state.lo) >= 0.3,
                { span: state.hi - state.lo });

        const spread = sampleOf(line, [0, 0, 0], FieldOverlay.MODE_SPREAD);
        check('spread mode reports a positive σ of the log distances',
                spread.unit === 'dex' && spread.lo < spread.hi
                && Number.isFinite(spread.lo) && Number.isFinite(spread.hi),
                { lo: spread.lo, hi: spread.hi });

        const slope = sampleOf(line, [0, 0, 0], FieldOverlay.MODE_SLOPE);
        check('slope mode reports dex per degree and stays finite on a degenerate ray',
                slope.unit === 'dex/deg' && Number.isFinite(slope.lo) && Number.isFinite(slope.hi),
                { lo: slope.lo, hi: slope.hi });

        // A star the camera sits on is floored at 1 pc, not at -Infinity.
        const near = sampleOf([[0, 0, 0], [1, 0, 0], [2, 0, 0]], [0, 0, 0], FieldOverlay.MODE_HEIGHT);
        check('a star at the camera is floored at 1 pc (log10 = -3), not -∞',
                Number.isFinite(near.lo) && near.lo < -3 && near.hi > -3,
                { lo: near.lo, hi: near.hi });

        // Two visible stars at different distances along the same direction:
        // the neighbourhood σ is real, and the slope is bounded by the angle
        // floor rather than by a NaN.
        const pair = sampleOf([[1, 0, 0], [8, 0.001, 0]], [0, 0, 0], FieldOverlay.MODE_SPREAD);
        check('the estimators survive a two-star sample',
                pair.samples === 2 && Number.isFinite(pair.lo) && Number.isFinite(pair.hi),
                { samples: pair.samples, lo: pair.lo, hi: pair.hi });

        // Too few samples: the fixed window the legend can quote.
        const one = sampleOf([[1, 0, 0]], [0, 0, 0], FieldOverlay.MODE_SPREAD);
        check('fewer than three visible records falls back to the declared window',
                one.lo === FieldOverlay.FALLBACK_RANGES.spread[0]
                && one.hi === FieldOverlay.FALLBACK_RANGES.spread[1],
                { lo: one.lo, hi: one.hi });

        // Invisible records are skipped, exactly as the vertex stage skips them.
        const blocks = makeBlocks(line);
        blocks.view.setUint32(3 * 16 + 12, 0, true);
        const skipped = FieldOverlay.createRangeState();
        FieldOverlay.refresh(skipped, {
                blocks, recordBytes: 16, orbit: null, model: null, time: 0,
                camX: 0, camY: 0, camZ: 0,
        }, FieldOverlay.MODE_HEIGHT);
        check('FLAG_VISIBLE gates the range sample', skipped.samples === 4, skipped.samples);
}

// --- The 4 Hz cadence is the renderer's; the state is allocation-free ------
{
        const state = FieldOverlay.createRangeState();
        const before = [state.positions, state.dirs, state.logD, state.spread, state.slope, state.scratch];
        sampleOf([[1, 0, 0], [2, 0, 0], [4, 0, 0]], [0, 0, 0], FieldOverlay.MODE_HEIGHT);
        FieldOverlay.refresh(state, {
                blocks: makeBlocks([[1, 0, 0], [2, 0, 0], [4, 0, 0], [8, 0, 0]]),
                recordBytes: 16, orbit: null, model: null, time: 0,
                camX: 0, camY: 0, camZ: 0,
        }, FieldOverlay.MODE_HEIGHT);
        check('a refresh reuses the same scratch arrays (no per-frame allocation)',
                [state.positions, state.dirs, state.logD, state.spread, state.slope, state.scratch]
                        .every((array, i) => array === before[i]));

        const composite = new Float32Array(16);
        FieldOverlay.packComposite(composite, state, {
                opacity: 0.5, relief: 0.25, contours: 4, fieldW: 640, fieldH: 360, tanHalfY: 0.5773503,
                canvasW: 1920, canvasH: 1080,
        });
        check('the composite uniform is params, range, viewport (field size + tan(fovY/2)), canvas size',
                composite.length === 16 && composite[0] === state.mode
                && composite[1] === 0.5 && composite[2] === 0.25 && composite[3] === 4
                && Math.abs(composite[4] - state.lo) < 1e-6 && Math.abs(composite[5] - state.hi) < 1e-6
                && composite[8] === 640 && composite[9] === 360
                && Math.abs(composite[10] - 0.5773503) < 1e-6
                && composite[12] === 1920 && composite[13] === 1080,
                Array.from(composite));
        check('the canvas size is the composite\'s own frame, not the field\'s — the two grids differ',
                composite[8] !== composite[12] && composite[9] !== composite[13],
                { field: [composite[8], composite[9]], canvas: [composite[12], composite[13]] });
        check('look knobs clamp instead of leaking into the shader',
                FieldOverlay.clampOpacity(2) === 1 && FieldOverlay.clampOpacity(-1) === 0
                && FieldOverlay.clampRelief(9) === 1 && FieldOverlay.clampContours(99) === FieldOverlay.MAX_CONTOURS
                && FieldOverlay.clampContours(-3) === 0);
}

// --- The legend ------------------------------------------------------------
{
        const state = FieldOverlay.createRangeState();
        FieldOverlay.applyMode(state, FieldOverlay.MODE_HEIGHT);
        const heightLegend = FieldOverlay.legend(state, 'viridis');
        check('the height legend quotes the ramp ends in kpc', heightLegend.active === true
                && heightLegend.title === 'distance'
                && /kpc|pc$/.test(heightLegend.high) && /near/.test(heightLegend.note),
                heightLegend);
        const spreadState = FieldOverlay.createRangeState();
        FieldOverlay.applyMode(spreadState, FieldOverlay.MODE_SPREAD);
        const spreadLegend = FieldOverlay.legend(spreadState, 'turbo');
        check('the spread legend quotes σ in dex and the slope legend dex/deg',
                spreadLegend.title === 'depth spread' && /dex$/.test(spreadLegend.low)
                && FieldOverlay.legend(Object.assign(FieldOverlay.createRangeState(), { mode: 3 }), 'grey').title === 'slope',
                spreadLegend);
        check('the off mode has no active legend', FieldOverlay.legend(state, 'auto') !== null
                && FieldOverlay.legend(FieldOverlay.createRangeState(), 'auto').active === false);
}

// --- One set of ramps for the island and the frame -------------------------
{
        const Rend = rendererModule;
        check('the island painter and the overlay sample the same five LUTs',
                Rend.ramps === FieldRamp.RAMPS
                && Object.keys(Rend.ramps).length === 5
                && Rend.ramps.turbo === FieldRamp.RAMPS.turbo
                && Rend.ramps.viridis.length === 256 * 3,
                Object.keys(Rend.ramps));
        check('auto picks viridis for distance, turbo for spread, grey for anything else',
                FieldRamp.resolveRamp('height', 'auto') === FieldRamp.RAMPS.viridis
                && FieldRamp.resolveRamp('spread', 'auto') === FieldRamp.RAMPS.turbo
                && FieldRamp.resolveRamp('slope', 'auto') === FieldRamp.RAMPS.grey
                && FieldRamp.resolveRamp('gradient', 'auto') === FieldRamp.RAMPS.grey
                && FieldRamp.resolveRamp('height', 'nope') === FieldRamp.RAMPS.viridis);
        const rgba = FieldRamp.rampRGBA(FieldRamp.RAMPS.viridis);
        check('the GPU ramp is a 256×4 byte view of the same LUT with opaque alpha',
                rgba.length === 256 * 4 && rgba[0] === FieldRamp.RAMPS.viridis[0]
                && rgba[255 * 4 + 2] === FieldRamp.RAMPS.viridis[255 * 3 + 2]
                && rgba[255 * 4 + 3] === 255
                && FieldRamp.rampRGBA(FieldRamp.RAMPS.viridis) === rgba, rgba.length);
}

// --- Report ----------------------------------------------------------------
let passed = 0;
let failed = 0;
for (const c of checks) {
        if (c.pass) passed++; else failed++;
        console.log(`  ${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.pass ? '' : `  -> ${JSON.stringify(c.detail)}`}`);
}
console.log(`\n${passed}/${checks.length} passed, ${failed} failed`);

const logPath = path.join(__dirname, 'logs', 'field-overlay.json');
fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.writeFileSync(logPath, JSON.stringify({
        date: new Date().toISOString(),
        totalChecks: checks.length,
        passed,
        failed,
        checks,
}, null, 2));
console.log(`Wrote ${logPath}`);
console.log('\n=== VERDICT ===');
console.log(failed === 0 ? 'PASS — the field overlay\'s CPU half is consistent' : `FAIL — ${failed} checks failed`);
process.exit(failed === 0 ? 0 : 1);
