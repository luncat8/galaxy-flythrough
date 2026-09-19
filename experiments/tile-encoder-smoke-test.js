// experiments/tile-encoder-smoke-test.js
// Validates the tile encoder end-to-end without real Gaia data.
// Generates mock stars from the analytical density model, runs them through
// the encoder, reads back the generated tile files, and verifies the binary
// format decodes correctly.
//
// Output: experiments/logs/tile-encoder-smoke.json

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const encoder = require('./tile-encoder.js');
const hash = require('../src/math/hash.js');

const checks = [];
function check(name, cond, detail) {
        checks.push({ name, pass: !!cond, detail });
        return !!cond;
}

// --- Test 1: Coordinate conversion ---
function testCoordinateConversion() {
        const cc = encoder.testCoordinateConversion();
        for (const c of cc) {
                check(`Coord conv: ${c.name}`, c.pass);
        }
}

// --- Test 2: Mock star generation ---
function testMockGeneration() {
        const stars = encoder.generateMockStars(1000);
        check('Mock: generated 1000 stars', stars.length === 1000);
        check('Mock: star has sourceId', typeof stars[0].sourceId === 'number');
        check('Mock: star has x,y,z', typeof stars[0].x === 'number' && typeof stars[0].y === 'number' && typeof stars[0].z === 'number');
        check('Mock: star has appMag', typeof stars[0].appMag === 'number');
        check('Mock: star has spectralClass', typeof stars[0].spectralClass === 'string');
        check('Mock: first 100 are landmarks', stars.slice(0, 100).every(s => s.isLandmark));
        check('Mock: stars 100+ are not landmarks', stars.slice(100).every(s => !s.isLandmark));
}

// --- Test 3: Band/cell classification ---
function testBandAndCell() {
        const near = encoder.bandAndCell(0.001, 0.002, 0.003);
        check('Band(0.001, 0.002, 0.003) = near', near && near.band === 'near');
        check('Cell coords are non-negative integers', near && near.cx >= 0 && near.cy >= 0 && near.cz >= 0);
        const med = encoder.bandAndCell(1.0, 0.5, 0.1);
        check('Band(1.0, 0.5, 0.1) = medium', med && med.band === 'medium');
        const far = encoder.bandAndCell(5.0, 3.0, 0.5);
        check('Band(5.0, 3.0, 0.5) = far', far && far.band === 'far');
        const oob = encoder.bandAndCell(50.0, 50.0, 50.0);
        check('Band(50,50,50) = null (out of bounds)', oob === null);
}

// --- Test 4: 16-byte packing round-trip ---
function testPackingRoundTrip() {
        const star = {
                x: 8.178, y: -1.234, z: 0.050,
                appMag: 5.5,
                spectralClass: 'G',
                sourceId: 12345,
                isLandmark: true,
        };
        const bytes = encoder.packStar(star);
        check('packStar returns 16 bytes', bytes.length === 16);
        // Decode
        const view = new DataView(bytes.buffer);
        const x = view.getFloat32(0, true);
        const y = view.getFloat32(4, true);
        const z = view.getFloat32(8, true);
        const packed = view.getUint32(12, true);
        const colorIndex = packed & 0xFF;
        const magByte = (packed >> 8) & 0xFF;
        const flags = (packed >> 16) & 0xFF;
        const subCellJitter = (packed >> 24) & 0xFF;
        check('Packed x round-trips', Math.abs(x - 8.178) < 1e-4);
        check('Packed y round-trips', Math.abs(y + 1.234) < 1e-4);
        check('Packed z round-trips', Math.abs(z - 0.050) < 1e-5);
        check('Packed colorIndex = 4 (G)', colorIndex === 4);
        check('Packed appMag byte ≈ 70', Math.abs(magByte - Math.floor(5.5 / 20 * 255)) < 1);
        check('Packed flags = 1 (landmark)', flags === 1);
}

// --- Test 5: Full encode-decode pipeline ---
function testEndToEnd() {
        // Use a temp dir
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'galaxy-tiles-'));
        try {
                const stars = encoder.generateMockStars(5000);
                const summary = encoder.encodeTiles(stars, tmpDir);
                check('Encode: kept > 0 stars', summary.kept > 0);
                check('Encode: wrote > 0 tiles', summary.tileCount > 0);
                check('Encode: avg stars/tile is reasonable', summary.avgStarsPerTile > 0 && summary.avgStarsPerTile < 5000);

                // Verify tile files exist with correct structure
                const bands = ['near', 'medium', 'far'];
                let totalTilesFound = 0;
                let totalStarsInTiles = 0;
                for (const band of bands) {
                        const bandDir = path.join(tmpDir, band);
                        if (!fs.existsSync(bandDir)) continue;
                        const files = fs.readdirSync(bandDir).filter(f => f.endsWith('.js'));
                        for (const f of files) {
                                totalTilesFound++;
                                const content = fs.readFileSync(path.join(bandDir, f), 'utf8');
                                check(`Tile file ${band}/${f} is valid JS`, /^\/\/ Auto-generated/.test(content));
                                check(`Tile file ${band}/${f} assigns global`, content.includes('window') || content.includes('global'));
                                // Extract the global name from the assignment pattern: g['__tile_band_x_y_z']
                                const nameMatch = content.match(/g\['__tile_(\w+)'\]/);
                                if (!nameMatch) {
                                        check(`Tile ${band}/${f} has global name`, false);
                                        continue;
                                }
                                const globalName = '__tile_' + nameMatch[1];
                                // Eval the tile file in a sandbox that exposes `globalThis`
                                // The IIFE assigns the bytes to globalThis[globalName], so we
                                // read them from there.
                                const sandbox = { Uint8Array, module: { exports: null } };
                                const fn = new Function('window', 'globalThis', 'global', 'module', 'Uint8Array',
                                        content + `\nreturn globalThis['${globalName}'];`);
                                const bytes = fn(sandbox, sandbox, sandbox, sandbox.module, Uint8Array);
                                if (bytes && bytes.length) {
                                        check(`Tile ${band}/${f} decoded to bytes`, bytes.length > 32);
                                        // Read header
                                        const hview = new DataView(bytes.buffer, bytes.byteOffset, 32);
                                        const starCount = hview.getUint32(24, true);
                                        const expectedBodyBytes = starCount * 16;
                                        const actualBodyBytes = bytes.length - 32;
                                        check(`Tile ${band}/${f} body size matches star count`, expectedBodyBytes === actualBodyBytes);
                                        totalStarsInTiles += starCount;
                                }
                        }
                }
                check('Total tiles found > 0', totalTilesFound > 0);
                check('Total stars in tiles matches kept count', Math.abs(totalStarsInTiles - summary.kept) < 1);
        } finally {
                // Clean up temp dir
                fs.rmSync(tmpDir, { recursive: true, force: true });
        }
}

// --- Run all tests ---
console.log('=== tile-encoder smoke test ===\n');

console.log('--- Test 1: Coordinate conversion ---');
testCoordinateConversion();

console.log('\n--- Test 2: Mock star generation ---');
testMockGeneration();

console.log('\n--- Test 3: Band/cell classification ---');
testBandAndCell();

console.log('\n--- Test 4: 16-byte packing round-trip ---');
testPackingRoundTrip();

console.log('\n--- Test 5: End-to-end encode/decode ---');
testEndToEnd();

// --- Print summary ---
let pass = 0, fail = 0;
for (const c of checks) {
        if (c.pass) pass++; else fail++;
        console.log(`  ${c.pass ? 'OK' : 'FAIL'}: ${c.name}`);
}
console.log(`\n${pass}/${checks.length} passed, ${fail} failed`);

const out = {
        date: new Date().toISOString(),
        totalChecks: checks.length,
        passed: pass,
        failed: fail,
        checks,
        verdict: fail === 0
                ? 'PASS — tile encoder ready for real Gaia CSV input'
                : `FAIL — ${fail} checks failed`,
};
const logPath = path.join(__dirname, 'logs', 'tile-encoder-smoke.json');
fs.writeFileSync(logPath, JSON.stringify(out, null, 2));
console.log(`\nWrote ${logPath}`);

console.log('\n=== VERDICT ===');
console.log(out.verdict);
