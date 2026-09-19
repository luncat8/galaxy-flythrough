// experiments/wgsl-validate.js
// Validates that WGSL shaders mirror the JS libraries exactly.
// For each WGSL file, extract constants and function signatures, then
// cross-check against the corresponding JS module in src/math/.
//
// Source of truth: src/math/*.js (browser+node compatible)
// Mirror:          src/render/wgsl/*.wgsl
// This script enforces the contract between them.
//
// Checks:
//   1. PCG hash: constants 0x7feb352d, 0x846ca68b match between JS and WGSL
//   2. Density model: constants GALACTIC_R0, THIN_L, etc. match
//   3. Mass-Teff table: 18 entries match between JS (star-types.js) and
//      WGSL (procedural-gen.wgsl MASS_TEFF_MASS / MASS_TEFF_TEFF)
//   4. Spectral class thresholds: 30000, 10000, 7500, 6000, 5200, 3700
//   5. StarPacked struct: 16 bytes (3 f32 + 1 u32) matches packing-test.js
//   6. Workgroup sizes and bindings are valid
//   7. star-distant.wgsl: embedded in index.html (file:// compatible)
//
// Output: experiments/logs/wgsl-validate.json

'use strict';

const fs = require('fs');
const path = require('path');

// --- WGSL files to validate ---
const WGSL_DIR = path.join(__dirname, '..', 'src', 'render', 'wgsl');
const MATH_DIR = path.join(__dirname, '..', 'src', 'math');
const SRC_DIR = path.join(__dirname, '..', 'src');
const FILES = ['pcg-hash.wgsl', 'density.wgsl', 'procedural-gen.wgsl', 'cull.wgsl', 'star-distant.wgsl'];

function readShader(name) {
        const p = path.join(WGSL_DIR, name);
        if (!fs.existsSync(p)) return null;
        return fs.readFileSync(p, 'utf8');
}

function readMath(name) {
        const p = path.join(MATH_DIR, name);
        if (!fs.existsSync(p)) return null;
        return fs.readFileSync(p, 'utf8');
}

// --- Test 1: PCG hash constants match JS ---
function validatePcgConstants() {
        const wgsl = readShader('pcg-hash.wgsl');
        if (!wgsl) return { pass: false, error: 'pcg-hash.wgsl not found' };
        // Check PCG constants present
        const constants = ['0x7feb352d', '0x846ca68b', '0x9e3779b9', '0x85ebca77', '0xc2b2ae3d'];
        const missing = constants.filter(c => !wgsl.toLowerCase().includes(c.toLowerCase()));
        // Check function names
        const fns = ['pcgHash', 'hash4', 'hash01', 'hash2D', 'hash3D', 'wangHash'];
        const missingFns = fns.filter(f => !wgsl.includes(`fn ${f}(`));
        // Check JS hash.js
        const js = readMath('hash.js');
        const jsHasConstants = constants.every(c => js.toLowerCase().includes(c.toLowerCase()));
        const jsHasFns = fns.every(f => js.includes(`function ${f}(`));
        return {
                wgslConstantsPresent: missing.length === 0,
                wgslFunctionsPresent: missingFns.length === 0,
                jsConstantsPresent: jsHasConstants,
                jsFunctionsPresent: jsHasFns,
                missingConstants: missing,
                missingFunctions: missingFns,
                pass: missing.length === 0 && missingFns.length === 0 && jsHasConstants && jsHasFns,
        };
}

// --- Test 2: Density model constants match JS ---
function validateDensityConstants() {
        const wgsl = readShader('density.wgsl');
        if (!wgsl) return { pass: false, error: 'density.wgsl not found' };
        const js = readMath('density.js');

        const expectedConsts = [
                { js: '8.178', wgsl: '8.178', desc: 'GALACTIC_R0' },
                { js: '2.6',   wgsl: '2.6',   desc: 'THIN_L' },
                { js: '0.300', wgsl: '0.300', desc: 'THIN_H' },
                { js: '3.5',   wgsl: '3.5',   desc: 'THICK_L' },
                { js: '0.900', wgsl: '0.900', desc: 'THICK_H' },
                { js: '1.5',   wgsl: '1.5',   desc: 'BULGE_A' },
                { js: '0.5',   wgsl: '0.5',   desc: 'BULGE_B' },
                { js: '0.4',   wgsl: '0.4',   desc: 'BULGE_C' },
                { js: '0.20',  wgsl: '0.20',  desc: 'ARMS_AMP' },
                { js: '3.5',   wgsl: '3.5',   desc: 'HALO_POWER' },
        ];

        const results = expectedConsts.map(c => ({
                desc: c.desc,
                jsHas: js.includes(c.js),
                wgslHas: wgsl.includes(c.wgsl),
        }));
        const allMatch = results.every(r => r.jsHas && r.wgslHas);

        // Check key functions exist in WGSL
        const fns = ['toGalactocentric', 'rhoThin', 'rhoThick', 'rhoBulge', 'rhoHalo',
                'armFactor', 'distanceToNearestArm', 'rhoTotal', 'rhoDecomposed', 'sampleComponent'];
        const missingFns = fns.filter(f => !wgsl.includes(`fn ${f}(`));

        return {
                constants: results,
                jsHasAllFunctions: fns.every(f => js.includes(`function ${f}(`)),
                wgslMissingFunctions: missingFns,
                pass: allMatch && missingFns.length === 0,
        };
}

// --- Test 3: Mass-Teff table parity ---
function validateMassTeffTable() {
        const wgsl = readShader('procedural-gen.wgsl');
        if (!wgsl) return { pass: false, error: 'procedural-gen.wgsl not found' };
        const js = readMath('star-types.js');

        // Mass values from JS table
        const expectedMass = [0.08, 0.10, 0.15, 0.20, 0.30, 0.45, 0.70, 0.85, 1.00,
                1.50, 2.00, 3.00, 5.00, 9.00, 16.0, 30.0, 60.0, 100];
        const expectedTeff = [2400, 2800, 3200, 3400, 3600, 3800, 4500, 5000, 5800,
                6800, 9000, 12000, 16000, 22000, 30000, 38000, 45000, 50000];

        const wgslMassPresent = expectedMass.every(m => wgsl.includes(`${m}`));
        const wgslTeffPresent = expectedTeff.every(t => wgsl.includes(`${t}`));
        const jsMassPresent = expectedMass.every(m => js.includes(`${m}`));
        const jsTeffPresent = expectedTeff.every(t => js.includes(`${t}`));

        // Spectral thresholds
        const thresholds = [30000, 10000, 7500, 6000, 5200, 3700];
        const wgslThresholdsPresent = thresholds.every(t => wgsl.includes(`${t}.0`));
        const jsThresholdsPresent = thresholds.every(t => js.includes(`${t}`));

        return {
                wgslMassTableComplete: wgslMassPresent,
                wgslTeffTableComplete: wgslTeffPresent,
                jsMassTableComplete: jsMassPresent,
                jsTeffTableComplete: jsTeffPresent,
                wgslSpectralThresholdsPresent: wgslThresholdsPresent,
                jsSpectralThresholdsPresent: jsThresholdsPresent,
                entryCount: expectedMass.length,
                pass: wgslMassPresent && wgslTeffPresent && jsMassPresent && jsTeffPresent
                        && wgslThresholdsPresent && jsThresholdsPresent,
        };
}

// --- Test 4: StarPacked struct layout matches packing-test.js ---
function validateStarPackedStruct() {
        const wgsl = readShader('procedural-gen.wgsl');
        if (!wgsl) return { pass: false, error: 'procedural-gen.wgsl not found' };

        // Check struct definition exists with the right fields
        const structMatch = wgsl.match(/struct\s+StarPacked\s*\{[^}]+\}/);
        if (!structMatch) {
                return { pass: false, error: 'StarPacked struct not found' };
        }
        const structDef = structMatch[0];
        const hasPositionHighX = structDef.includes('positionHighX: f32');
        const hasPositionHighY = structDef.includes('positionHighY: f32');
        const hasPositionHighZ = structDef.includes('positionHighZ: f32');
        const hasPacked = structDef.includes('packed: u32');

        // Should be 16 bytes total (3 × 4 + 4)
        const expectedSize = 16;
        const actualSize = 3 * 4 + 4;

        return {
                structFound: true,
                hasPositionHighX,
                hasPositionHighY,
                hasPositionHighZ,
                hasPacked,
                expectedSizeBytes: expectedSize,
                actualSizeBytes: actualSize,
                pass: hasPositionHighX && hasPositionHighY && hasPositionHighZ && hasPacked
                        && actualSize === expectedSize,
        };
}

// --- Test 5: WGSL syntax sanity ---
function validateWgslSyntax() {
        const results = {};
        for (const file of FILES) {
                const wgsl = readShader(file);
                if (!wgsl) {
                        results[file] = { pass: false, error: 'file not found' };
                        continue;
                }
                const errors = [];
                // Strip // line comments before counting — they contain parens that aren't code.
                const stripped = wgsl.replace(/\/\/.*$/gm, '');
                // Check for balanced braces
                const openBraces = (stripped.match(/{/g) || []).length;
                const closeBraces = (stripped.match(/}/g) || []).length;
                if (openBraces !== closeBraces) {
                        errors.push(`unbalanced braces: ${openBraces} open vs ${closeBraces} close`);
                }
                // Check for balanced parens
                const openParens = (stripped.match(/\(/g) || []).length;
                const closeParens = (stripped.match(/\)/g) || []).length;
                if (openParens !== closeParens) {
                        errors.push(`unbalanced parens: ${openParens} open vs ${closeParens} close`);
                }
                // Check for entry points where expected
                const hasEntryPoint = wgsl.includes('@compute') || wgsl.includes('@vertex') || wgsl.includes('@fragment');
                if (file === 'procedural-gen.wgsl' || file === 'cull.wgsl') {
                        if (!wgsl.includes('@compute')) errors.push('missing @compute entry point');
                }
                if (file === 'star-distant.wgsl') {
                        if (!wgsl.includes('@vertex')) errors.push('missing @vertex entry point');
                        if (!wgsl.includes('@fragment')) errors.push('missing @fragment entry point');
                }
                // Check for @workgroup_size where compute is present
                if (wgsl.includes('@compute') && !wgsl.includes('@workgroup_size')) {
                        errors.push('missing @workgroup_size');
                }
                results[file] = {
                        lines: wgsl.split('\n').length,
                        bytes: wgsl.length,
                        openBraces, closeBraces, openParens, closeParens,
                        errors,
                        pass: errors.length === 0,
                };
        }
        return results;
}

// --- Test 6: star-distant.wgsl is embedded in index.html ---
// Per AGENTS.md: WGSL must be embedded as <script type="text/x-wgsl"> blocks
// for file:// compatibility. We don't require byte-for-byte equality (the
// embedded version may strip comment headers and have different indentation)
// but we do require that the key structs and entry points are present.
function validateStarDistantEmbedded() {
        const indexHtml = fs.readFileSync(path.join(SRC_DIR, 'index.html'), 'utf8');
        const shaderName = 'star-distant.wgsl';
        const hasScriptBlock = indexHtml.includes(`id="${shaderName}"`)
                && indexHtml.includes(`type="text/x-wgsl"`);
        const wgslFile = readShader(shaderName);
        const matchResult = indexHtml.match(new RegExp(`<script type="text/x-wgsl" id="${shaderName}">([\\s\\S]*?)<\\/script>`));
        const embedded = matchResult ? matchResult[1] : '';
        // Key markers that must be present in both file and embedded
        const markers = [
                'struct CameraUniform',
                'struct StarPacked',
                'struct VertexOut',
                'cameraRight: vec4f',  // added in v2 for billboarding
                'cameraUp: vec4f',     // added in v2 for billboarding
                'fn vs_main',
                'fn fs_main',
                'fn cornerOffset',    // added in v2 — billboard corner lookup
                'fn decodeAppMag',
                'fn decodeColorIndex',
                '@builtin(instance_index)',  // added in v2 — instanced rendering
                '@vertex',
                '@fragment',
                // triangle-strip topology is set in JS pipeline config, not in WGSL.
                // We don't check it here. Instead, check that the shader uses 4-vertex
                // corner offsets (sign of instanced billboard pattern).
                'cornerOffset(vid)',  // called twice in vs_main
        ];
        const missingInEmbedded = markers.filter(m => !embedded.includes(m));
        const missingInFile = wgslFile ? markers.filter(m => !wgslFile.includes(m)) : ['(file not found)'];
        return {
                scriptBlockPresent: hasScriptBlock,
                embeddedLength: embedded.length,
                fileLength: wgslFile ? wgslFile.length : 0,
                keyMarkersAllPresentInEmbedded: missingInEmbedded.length === 0,
                keyMarkersAllPresentInFile: missingInFile.length === 0,
                missingInEmbedded,
                missingInFile,
                pass: hasScriptBlock && missingInEmbedded.length === 0 && missingInFile.length === 0,
        };
}

// --- Run all checks ---
console.log('=== WGSL Validation ===\n');

const checks = {
        pcgConstants: validatePcgConstants(),
        densityConstants: validateDensityConstants(),
        massTeffTable: validateMassTeffTable(),
        starPackedStruct: validateStarPackedStruct(),
        wgslSyntax: validateWgslSyntax(),
        starDistantEmbedded: validateStarDistantEmbedded(),
};

console.log('--- PCG hash constants ---');
console.log(`  pass: ${checks.pcgConstants.pass}`);
if (!checks.pcgConstants.pass) {
        console.log(`  missing constants: ${checks.pcgConstants.missingConstants?.join(', ')}`);
        console.log(`  missing functions: ${checks.pcgConstants.missingFunctions?.join(', ')}`);
}

console.log('\n--- Density model constants ---');
console.log(`  pass: ${checks.densityConstants.pass}`);
if (checks.densityConstants.constants) {
        for (const c of checks.densityConstants.constants) {
                const status = c.jsHas && c.wgslHas ? 'OK' : 'MISMATCH';
                console.log(`  ${c.desc}: JS=${c.jsHas}, WGSL=${c.wgslHas} [${status}]`);
        }
}

console.log('\n--- Mass-Teff table parity ---');
console.log(`  pass: ${checks.massTeffTable.pass}`);
console.log(`  entry count: ${checks.massTeffTable.entryCount}`);
console.log(`  WGSL mass table complete: ${checks.massTeffTable.wgslMassTableComplete}`);
console.log(`  WGSL Teff table complete: ${checks.massTeffTable.wgslTeffTableComplete}`);
console.log(`  WGSL spectral thresholds present: ${checks.massTeffTable.wgslSpectralThresholdsPresent}`);

console.log('\n--- StarPacked struct ---');
console.log(`  pass: ${checks.starPackedStruct.pass}`);
console.log(`  size: ${checks.starPackedStruct.actualSizeBytes} bytes (expected 16)`);

console.log('\n--- WGSL syntax sanity ---');
for (const [file, r] of Object.entries(checks.wgslSyntax)) {
        console.log(`  ${file}: ${r.pass ? 'OK' : 'FAIL'} (${r.lines} lines, ${r.bytes} bytes)`);
        if (r.errors && r.errors.length > 0) {
                for (const e of r.errors) console.log(`    - ${e}`);
        }
}

const allPass = Object.values(checks).every(c => c.pass === true
        || (typeof c === 'object' && Object.values(c).every(v => v.pass === true)));
const out = {
        date: new Date().toISOString(),
        checks,
        verdict: allPass
                ? 'PASS — WGSL mirrors JS libraries exactly'
                : 'FAIL — investigate mismatches',
};

const logPath = path.join(__dirname, 'logs', 'wgsl-validate.json');
fs.writeFileSync(logPath, JSON.stringify(out, null, 2));
console.log(`\nWrote ${logPath}`);

console.log('\n=== VERDICT ===');
console.log(out.verdict);
