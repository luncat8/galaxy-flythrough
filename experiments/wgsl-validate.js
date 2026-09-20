// experiments/wgsl-validate.js
// The renderer's WGSL mirrors the JavaScript model: the density field, the
// stellar population recipe and the packed star record all exist twice, once
// in src/math/*.js (authoritative, tested) and once in src/render/shaders.js
// (what the GPU executes). Nothing in the build can compile WGSL, so this test
// is the only thing standing between the two copies and silent drift.
//
// It checks three levels:
//   1. structural — the shader sources are plausible and complete
//   2. numeric    — every mirrored constant equals its JS source of truth
//   3. symbolic   — every mirrored function still exists in the JS model
//
// Output: experiments/logs/wgsl-validate.json

'use strict';

const fs = require('fs');
const path = require('path');

const shaders = require('../src/render/shaders.js');
const density = require('../src/math/density.js');
const records = require('../src/math/star-record.js');

const checks = [];
function check(name, pass, detail) {
        checks.push({ name, pass: !!pass, detail });
        return !!pass;
}

function readSource(relPath) {
        return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf-8');
}

// --- 1. Structure --------------------------------------------------------
{
        const names = Object.keys(shaders.SHADER_PARTS);
        check('every expected shader part is present',
                ['pcg-hash', 'density', 'star-sprite', 'star-sprite-hdr', 'tonemap', 'procedural-gen', 'cull'].every(n => names.includes(n)),
                names);
        check('every shader part is a non-empty LF-only string',
                names.every(n => typeof shaders.SHADER_PARTS[n] === 'string'
                        && shaders.SHADER_PARTS[n].length > 100
                        && !shaders.SHADER_PARTS[n].includes('\r')),
                names.map(n => [n, shaders.SHADER_PARTS[n].length]));
        check('three wired shaders are exposed (star-sprite, star-sprite-hdr, tonemap)',
                shaders.WIRED_SHADERS.length === 3
                && shaders.WIRED_SHADERS[0] === 'star-sprite'
                && shaders.WIRED_SHADERS[1] === 'star-sprite-hdr'
                && shaders.WIRED_SHADERS[2] === 'tonemap',
                shaders.WIRED_SHADERS);
        check('every wired shader exists in the module map',
                shaders.WIRED_SHADERS.every(n => typeof shaders.SHADERS[n] === 'string' && shaders.SHADERS[n].length > 0),
                Object.keys(shaders.SHADERS));

        for (const name of names) {
                const src = shaders.SHADER_PARTS[name];
                let braces = 0;
                let parens = 0;
                for (const ch of src) {
                        if (ch === '{') braces++;
                        else if (ch === '}') braces--;
                        else if (ch === '(') parens++;
                        else if (ch === ')') parens--;
                }
                check(`${name}: braces and parentheses balance`, braces === 0 && parens === 0, { braces, parens });
                check(`${name}: contains no unresolved markers`,
                        !src.includes('undefined') && !src.includes('TODO') && !src.includes('/*'), name);
                const fnCount = (src.match(/^fn\s/gm) || []).length;
                check(`${name}: declares its functions`, fnCount > 0, fnCount);
        }
}

// Grab `const NAME: type = VALUE;` from a shader part.
function wgslConsts(part) {
        const out = {};
        const re = /^const\s+([A-Za-z_0-9]+)\s*:\s*([a-z0-9]+)\s*=\s*([^;]+);/gm;
        let m;
        while ((m = re.exec(shaders.SHADER_PARTS[part])) !== null) {
                let value = m[3].trim();
                if (value.startsWith('0x')) value = parseInt(value.replace(/u$/, ''), 16);
                else value = parseFloat(value.replace(/u$/, ''));
                out[m[1]] = value;
        }
        return out;
}

// --- 2. Numeric parity ---------------------------------------------------
{
        const c = wgslConsts('density');
        const D = density;
        const mirror = [
                ['GALACTIC_R0', D.GALACTIC_R0], ['GALACTIC_CENTRE_X', D.GALACTIC_CENTRE.x], ['GALACTIC_CENTRE_Y', D.GALACTIC_CENTRE.y],
                ['THIN_L', D.THIN.L], ['THIN_H', D.THIN.H], ['THIN_AMP', D.THIN.amp],
                ['THICK_L', D.THICK.L], ['THICK_H', D.THICK.H], ['THICK_AMP', D.THICK.amp],
                ['BULGE_A', D.BULGE.a], ['BULGE_B', D.BULGE.b], ['BULGE_C', D.BULGE.c],
                ['BULGE_R0', D.BULGE.r0], ['BULGE_AMP', D.BULGE.amp], ['BULGE_TILT_DEG', D.BULGE.tiltDeg],
                ['HALO_A_H', D.HALO.a_h], ['HALO_POWER', D.HALO.power], ['HALO_AMP', D.HALO.amp], ['HALO_RMAX', D.HALO.rMax],
                ['ARMS_M', D.ARMS.m], ['ARMS_AMP', D.ARMS.amp], ['ARMS_PITCH_DEG', D.ARMS.pitchDeg],
                ['ARMS_RS', D.ARMS.Rs], ['ARMS_PHASE0', D.ARMS.phase0],
                ['DISC_RADIUS', D.TRUNCATION.discRadius], ['DISC_HEIGHT', D.TRUNCATION.discHeight],
                ['BULGE_RADIUS', D.TRUNCATION.bulgeRadius],
        ];
        for (const [name, value] of mirror) {
                check(`density.wgsl ${name} matches the JS model`, c[name] === value, { wgsl: c[name], js: value });
        }
        check('density.wgsl component indices match the JS model',
                c.COMPONENT_THIN === D.COMPONENT_THIN && c.COMPONENT_THICK === D.COMPONENT_THICK
                && c.COMPONENT_BULGE === D.COMPONENT_BULGE && c.COMPONENT_HALO === D.COMPONENT_HALO,
                { thin: c.COMPONENT_THIN, thick: c.COMPONENT_THICK, bulge: c.COMPONENT_BULGE, halo: c.COMPONENT_HALO });
}

{
        const sprite = wgslConsts('star-sprite');
        check('star-sprite.wgsl absolute magnitude range matches StarPacked',
                sprite.ABS_MAG_MIN === records.ABS_MAG_MIN && sprite.ABS_MAG_SPAN === records.ABS_MAG_SPAN,
                { wgsl: [sprite.ABS_MAG_MIN, sprite.ABS_MAG_SPAN], js: [records.ABS_MAG_MIN, records.ABS_MAG_SPAN] });
        check('star-sprite.wgsl visibility mask matches the record flag',
                sprite.MASK_VISIBLE === (records.FLAG_VISIBLE << 16),
                { wgsl: sprite.MASK_VISIBLE, js: records.FLAG_VISIBLE << 16 });

        const gen = wgslConsts('procedural-gen');
        check('procedural-gen.wgsl magnitude range matches StarPacked',
                gen.ABS_MAG_MIN === records.ABS_MAG_MIN && gen.ABS_MAG_SPAN === records.ABS_MAG_SPAN,
                { wgsl: [gen.ABS_MAG_MIN, gen.ABS_MAG_SPAN] });
        check('procedural-gen.wgsl visibility flag matches StarPacked',
                gen.FLAG_VISIBLE === records.FLAG_VISIBLE, { wgsl: gen.FLAG_VISIBLE, js: records.FLAG_VISIBLE });

        const cull = wgslConsts('cull');
        check('cull.wgsl landmark mask matches the record flag',
                cull.MASK_LANDMARK === (records.FLAG_LANDMARK << 16) && cull.MASK_VISIBLE === (records.FLAG_VISIBLE << 16),
                { wgsl: [cull.MASK_LANDMARK, cull.MASK_VISIBLE] });
        check('cull.wgsl draws four vertices per sprite', cull.VERTICES_PER_SPRITE === 4, cull.VERTICES_PER_SPRITE);
}

// --- 3. Symbolic parity --------------------------------------------------
{
        const starTypesSrc = readSource('src/math/star-types.js');
        const hashSrc = readSource('src/math/hash.js');
        const densitySrc = readSource('src/math/density.js');

        const mirrors = [
                ['pcg-hash', hashSrc, ['pcgHash', 'hash4', 'hash01', 'hash01At', 'hash2D', 'hash3D', 'wangHash']],
                ['density', densitySrc, ['bulgeEllipsoidRadius', 'rhoThin', 'rhoThick', 'rhoBulge', 'rhoHalo',
                        'armFactor', 'distanceToNearestArm', 'rhoTotal', 'rhoDecomposed']],
                ['procedural-gen', starTypesSrc, ['luminosityFromMass', 'teffFromMass', 'msLifetimeGyr',
                        'sampleMassIMF', 'sampleLocalAge', 'classifyByTempAndState']],
        ];
        for (const [part, jsSource, fns] of mirrors) {
                const wgslSrc = shaders.SHADER_PARTS[part];
                for (const fn of fns) {
                        const inWgsl = new RegExp(`^fn\\s+${fn}\\b`, 'm').test(wgslSrc);
                        const inJs = new RegExp(`function\\s+${fn}\\b`).test(jsSource);
                        check(`${part}.wgsl mirrors ${fn}`, inWgsl && inJs, { wgsl: inWgsl, js: inJs });
                }
        }

        // Numbers that pin the stellar model down. Keep them in one list so a
        // change to the recipe has to be made in both places deliberately.
        const gen = shaders.SHADER_PARTS['procedural-gen'];
        const numbers = [
                ['Salpeter slope 2.35', /2\.35/],
                ['mass floor 0.08', /0\.08/],
                ['mass ceiling 100', /100\.0/],
                ['lifetime coefficient 10', /10\.0/],
                ['O threshold 30000 K', /30000\.0/],
                ['B threshold 10000 K', /10000\.0/],
                ['A threshold 7500 K', /7500\.0/],
                ['F threshold 6000 K', /6000\.0/],
                ['G threshold 5200 K', /5200\.0/],
                ['K threshold 3700 K', /3700\.0/],
        ];
        for (const [label, re] of numbers) {
                check(`procedural-gen.wgsl still contains ${label}`, re.test(gen), label);
        }

        // The mass-Teff table is data; the WGSL carries the same breakpoints.
        const table = require('../src/math/star-types.js').MASS_TEFF_TABLE;
        const missing = table.filter(([m]) => {
                const text = m >= 1 ? m.toFixed(1).replace(/\.0$/, '.0') : m.toFixed(2);
                return !gen.includes(text);
        });
        check('procedural-gen.wgsl carries the same mass-Teff breakpoints',
                missing.length === 0, missing.map(([m]) => m));
}

// --- 4. Entry points -----------------------------------------------------
{
        const sprite = shaders.SHADERS['star-sprite'];
        check('the wired shader declares a vertex entry point', /@vertex\s*\nfn\s+vs_main/.test(sprite));
        check('the wired shader declares a fragment entry point',
                /@fragment\s*\nfn\s+fs_main/.test(sprite) || /@fragment\s+fn\s+fs_main/.test(sprite));
        check('the wired shader declares its bindings',
                /@group\(0\)\s*@binding\(0\)/.test(sprite) && /@group\(0\)\s*@binding\(1\)/.test(sprite)
                && /@group\(0\)\s*@binding\(2\)/.test(sprite));
        check('the wired shader declares the camera uniform struct', /struct\s+CameraUniform/.test(sprite));
        check('the wired shader declares its builtin vertex input',
                /@builtin\(vertex_index\)/.test(sprite));
        check('the star sprite shader no longer applies per-star Reinhard',
                !/flux\s*\/\s*\(1\.0\s*\+\s*flux\)/.test(sprite));
        check('the star sprite falloff tightens to (1-r²)³',
                /let\s+s:\s*f32\s*=\s*1\.0\s*-\s*r2/.test(sprite) && /s\s*\*\s*s\s*\*\s*s/.test(sprite));

        const tonemap = shaders.SHADERS['tonemap'];
        check('the tonemap shader declares a vertex entry point', /@vertex\s*\nfn\s+vs_main/.test(tonemap));
        check('the tonemap shader declares a fragment entry point',
                /@fragment\s*\nfn\s+fs_main/.test(tonemap) || /@fragment\s+fn\s+fs_main/.test(tonemap));
        check('the tonemap shader declares two bindings (uniform + texture)',
                /@group\(0\)\s*@binding\(0\)\s*var<uniform>/.test(tonemap)
                && /@group\(0\)\s*@binding\(1\)\s*var\s+hdrTexture:\s*texture_2d<f32>/.test(tonemap)
                && !/@group\(0\)\s*@binding\(2\)/.test(tonemap));
        check('the tonemap shader defines acesNarkowicz', /fn\s+acesNarkowicz/.test(tonemap));
        check('the tonemap shader carries the five ACES constants a-e',
                /const\s+a:\s*f32\s*=\s*2\.51/.test(tonemap)
                && /const\s+b:\s*f32\s*=\s*0\.03/.test(tonemap)
                && /const\s*c:\s*f32\s*=\s*2\.43/.test(tonemap)
                && /const\s+d:\s*f32\s*=\s*0\.59/.test(tonemap)
                && /const\s+e:\s*f32\s*=\s*0\.14/.test(tonemap));
        check('the tonemap fragment writes alpha = 1 (opaque swapchain)',
                /return\s+vec4f\(ldr,\s*1\.0\)/.test(tonemap));

        const spriteHdr = shaders.SHADERS['star-sprite-hdr'];
        check('the star-sprite-hdr shader declares a vertex entry point', /@vertex\s*\nfn\s+vs_main/.test(spriteHdr));
        check('the star-sprite-hdr shader declares a fragment entry point',
                /@fragment\s*\nfn\s+fs_main/.test(spriteHdr) || /@fragment\s+fn\s+fs_main/.test(spriteHdr));
        check('the star-sprite-hdr shader declares four bindings (camera + stars + lut + exposure)',
                /@group\(0\)\s*@binding\(0\)\s*var<uniform>\s+camera/.test(spriteHdr)
                && /@group\(0\)\s*@binding\(1\)\s*var<storage,\s*read>\s+stars/.test(spriteHdr)
                && /@group\(0\)\s*@binding\(2\)\s*var\s+colorLUT/.test(spriteHdr)
                && /@group\(0\)\s*@binding\(3\)\s*var<uniform>\s+exposure/.test(spriteHdr));
        check('the star-sprite-hdr fragment multiplies intensity by exposure.exposure.x',
                /in\.brightness\s*\*\s*falloff\s*\*\s*exposure\.exposure\.x/.test(spriteHdr));
        check('the star-sprite-hdr shader applies the same (1-r²)³ falloff as the SDR variant',
                /let\s+s:\s*f32\s*=\s*1\.0\s*-\s*r2/.test(spriteHdr) && /s\s*\*\s*s\s*\*\s*s/.test(spriteHdr));

        const gen = shaders.SHADERS['procedural-gen'];
        check('the procedural generator is a compute shader', /@compute/.test(gen) && /@workgroup_size/.test(gen));
        const cull = shaders.SHADERS['cull'];
        check('the cull shader writes indirect draw arguments',
                /indirectArgs\[1\]\s*=/.test(cull) && /var<storage,\s*read_write>\s+indirectArgs/.test(cull));
}

// --- Report --------------------------------------------------------------
let passed = 0;
let failed = 0;
for (const c of checks) {
        if (c.pass) passed++; else failed++;
        console.log(`  ${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.pass ? '' : `  -> ${JSON.stringify(c.detail)}`}`);
}
console.log(`\n${passed}/${checks.length} passed, ${failed} failed`);

const logPath = path.join(__dirname, 'logs', 'wgsl-validate.json');
fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.writeFileSync(logPath, JSON.stringify({
        date: new Date().toISOString(),
        parts: Object.keys(shaders.SHADER_PARTS).map(n => ({ name: n, lines: shaders.SHADER_PARTS[n].split('\n').length })),
        wired: shaders.WIRED_SHADERS,
        totalChecks: checks.length,
        passed,
        failed,
        checks,
}, null, 2));
console.log(`Wrote ${logPath}`);
console.log('\n=== VERDICT ===');
console.log(failed === 0 ? 'PASS — WGSL mirrors the JS model' : `FAIL — ${failed} checks failed`);
process.exit(failed === 0 ? 0 : 1);
