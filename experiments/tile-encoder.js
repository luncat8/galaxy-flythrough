// experiments/tile-encoder.js
// Offline tool: converts a Gaia DR3 catalog subset into binary tile files
// for streaming at runtime. Mirrors the layout in plan.md §5 (Catalog Pipeline).
//
// Input:  Gaia CSV with columns ra, dec, parallax, parallax_error,
//         pmra, pmdec, phot_g_mean_mag, bp_rp, source_id
// Output: src/data/tiles/{near,medium,far}/tile_X_Y_Z.js
//         Each file is: window.__tile_<band>_<x>_<y>_<z> = new Uint8Array([...]);
//                       if (typeof module !== 'undefined') module.exports = ...;
//
// Filtering per plan.md §6:
//   - Magnitude cut: keep only G < 12 (completeness limit)
//   - Quality cut:   parallax_over_error > 5
//   - Radial decimation: inside 100 pc, stochastically decimate by (r/r0)^2
//     where r0 = 100 pc, to reduce over-density near Sun.
//   - Landmark whitelist bypasses filtering (always kept).
//
// Output tile format (16 bytes per star, matches StarPacked):
//   positionHighX: f32 (kpc, Sun-centred, galactic XYZ)
//   positionHighY: f32
//   positionHighZ: f32
//   packed:        u32 (bits: 0-7 colorIndex, 8-15 appMag, 16-23 flags, 24-31 subCellJitter)
//
// Tile layout (per plan.md §5):
//   near:   25 pc cells, |X|<250, |Y|<250, |Z|<50 → 20×20×4 = 1600 cells max
//   medium: 100 pc cells, R<2 kpc
//   far:    500 pc cells, R<10 kpc
//
// Each tile file starts with a 32-byte header (in the Uint8Array):
//   bytes 0-11:   boundsMinXYZ (3 × f32 = 12 bytes)
//   bytes 12-23:  boundsMaxXYZ (3 × f32 = 12 bytes)
//   bytes 24-27:  starCount (u32)
//   bytes 28-31:  reserved (u32, currently 0)
// Then starCount * 16 bytes of StarPacked records.
//
// Usage:
//   node experiments/tile-encoder.js --input gaia-dr3.csv --output src/data/tiles/
//
// For testing without real Gaia data, run with --mock to generate synthetic stars
// from the analytical density model (uses src/math/sampling.js).

'use strict';

const fs = require('fs');
const path = require('path');
const density = require('../src/math/density.js');
const sampling = require('../src/math/sampling.js');
const starTypes = require('../src/math/star-types.js');
const hash = require('../src/math/hash.js');

// --- Config ---
const CONFIG = {
        magnitudeCut: 12.0,         // keep G < 12
        parallaxQualityCut: 5.0,    // parallax_over_error > 5
        radialDecimationR0: 0.100,  // 100 pc reference radius for decimation
        bands: {
                near:   { cellSize: 0.025, xMin: -0.250, xMax: 0.250, yMin: -0.250, yMax: 0.250, zMin: -0.050, zMax: 0.050 },
                medium: { cellSize: 0.100, xMin: -2.0,   xMax: 2.0,   yMin: -2.0,   yMax: 2.0,   zMin: -0.500, zMax: 0.500 },
                far:    { cellSize: 0.500, xMin: -10.0,  xMax: 10.0,  yMin: -10.0,  yMax: 10.0,  zMin: -2.000, zMax: 2.000 },
        },
};

// --- Coordinate conversion: RA/Dec/Parallax → galactic XYZ (Sun-centred, kpc) ---
// Gaia gives RA (degrees), Dec (degrees), parallax (mas).
// Convert to galactic (l, b) then to Cartesian.
// Reference: IAU 1958 conversion formulae.
function raDecParallaxToGalactic(raDeg, decDeg, parallaxMas) {
        // RA/Dec → Galactic l, b (degrees)
        // Standard transformation (IAU 1958)
        const ra = raDeg * Math.PI / 180;
        const dec = decDeg * Math.PI / 180;
        // Galactic pole: alpha_p = 192.85948°, delta_p = 27.12825°
        // Galactic centre: alpha_0 = 266.4051° (i.e. l=0 direction)
        const aP = 192.85948 * Math.PI / 180;
        const dP = 27.12825 * Math.PI / 180;
        const l0 = 122.93192 * Math.PI / 180;  // l=0 direction RA
        const sinB = Math.sin(dec) * Math.sin(dP) + Math.cos(dec) * Math.cos(dP) * Math.cos(ra - aP);
        const b = Math.asin(Math.max(-1, Math.min(1, sinB)));
        const cosL = (Math.sin(dec) - Math.sin(b) * Math.sin(dP)) / (Math.cos(b) * Math.cos(dP));
        const sinL = Math.cos(dec) * Math.sin(ra - aP) / Math.cos(b);
        let l = Math.atan2(sinL, cosL) - l0;
        while (l < 0) l += 2 * Math.PI;
        while (l >= 2 * Math.PI) l -= 2 * Math.PI;
        // Distance in kpc
        const distKpc = parallaxMas > 0 ? 1.0 / parallaxMas : 0;  // 1/parallax(mas) = kpc
        // Galactic XYZ (Sun-centred): X = toward l=0, Y = toward l=90, Z = north
        const x = distKpc * Math.cos(b) * Math.cos(l);
        const y = distKpc * Math.cos(b) * Math.sin(l);
        const z = distKpc * Math.sin(b);
        return { x, y, z, l: l * 180 / Math.PI, b: b * 180 / Math.PI, distKpc };
}

// --- Test coordinate conversion ---
function testCoordinateConversion() {
        // Sirius: RA = 101.287155°, Dec = -16.716116°, parallax = 379.21 mas
        // Expected: ~2.64 pc distance, near galactic (l,b) ≈ (227°, -8°)
        const s = raDecParallaxToGalactic(101.287155, -16.716116, 379.21);
        const checks = [];
        checks.push({ name: 'Sirius distance ≈ 0.00264 kpc (2.64 pc)', pass: Math.abs(s.distKpc - 0.00264) < 0.0001 });
        checks.push({ name: 'Sirius galactic latitude near -8°', pass: Math.abs(s.b + 8) < 2 });
        // Galactic centre direction: RA = 266.4051°, Dec = -28.9362°, parallax → 0 (very far)
        // Should produce x ~ +8.178 kpc (toward GC), y ~ 0, z ~ 0
        const gc = raDecParallaxToGalactic(266.4051, -28.9362, 0.122);  // ~8 kpc
        checks.push({ name: 'GC direction at 8 kpc: x ≈ +8 kpc', pass: Math.abs(gc.x - 8) < 0.5 });
        checks.push({ name: 'GC direction at 8 kpc: y small', pass: Math.abs(gc.y) < 1 });
        return checks;
}

// --- Filtering: apply magnitude, quality, radial decimation ---
function shouldKeep(star, landmarkSet) {
        // Landmark bypass
        if (landmarkSet.has(star.sourceId)) return true;
        // Magnitude cut
        if (star.appMag > CONFIG.magnitudeCut) return false;
        // Quality cut
        if (star.parallaxOverError < CONFIG.parallaxQualityCut) return false;
        // Radial decimation: inside 100 pc, decimate by (r/r0)^2
        const r = Math.sqrt(star.x * star.x + star.y * star.y + star.z * star.z);
        if (r < CONFIG.radialDecimationR0) {
                const keepProb = (r / CONFIG.radialDecimationR0) ** 2;
                const u = hash.hash01(star.sourceId);
                if (u >= keepProb) return false;
        }
        return true;
}

// --- Pack star into 16-byte record ---
function packStar(star) {
        const buf = new ArrayBuffer(16);
        const view = new DataView(buf);
        view.setFloat32(0, Math.fround(star.x), true);
        view.setFloat32(4, Math.fround(star.y), true);
        view.setFloat32(8, Math.fround(star.z), true);
        const colorIndex = spectralClassToIndex(star.spectralClass || 'G');
        const magByte = Math.max(0, Math.min(255, Math.floor((star.appMag / 20) * 255)));
        const flags = star.isLandmark ? 1 : 0;
        const subCellJitter = (star.sourceId * 2654435761) & 0xFF;
        const packed = (colorIndex & 0xFF)
                | ((magByte & 0xFF) << 8)
                | ((flags & 0xFF) << 16)
                | ((subCellJitter & 0xFF) << 24);
        view.setUint32(12, packed >>> 0, true);
        return new Uint8Array(buf);
}

function spectralClassToIndex(cls) {
        switch (cls) {
                case 'O': return 0;
                case 'B': return 1;
                case 'A': return 2;
                case 'F': return 3;
                case 'G': return 4;
                case 'K': return 5;
                case 'M': return 6;
                case 'WD': return 7;
                case 'RG': return 8;
                default: return 4;
        }
}

// --- Determine which band/cell a star belongs to ---
function bandAndCell(x, y, z) {
        // Choose band by distance from Sun
        const r = Math.sqrt(x * x + y * y + z * z);
        let band;
        if (r < 0.250) band = 'near';
        else if (r < 2.0) band = 'medium';
        else if (r < 10.0) band = 'far';
        else return null;  // outside all bands
        const b = CONFIG.bands[band];
        const cx = Math.floor((x - b.xMin) / b.cellSize);
        const cy = Math.floor((y - b.yMin) / b.cellSize);
        const cz = Math.floor((z - b.zMin) / b.cellSize);
        // Bounds check
        if (cx < 0 || cy < 0 || cz < 0) return null;
        const cellsX = Math.ceil((b.xMax - b.xMin) / b.cellSize);
        const cellsY = Math.ceil((b.yMax - b.yMin) / b.cellSize);
        const cellsZ = Math.ceil((b.zMax - b.zMin) / b.cellSize);
        if (cx >= cellsX || cy >= cellsY || cz >= cellsZ) return null;
        return {
                band, cx, cy, cz,
                boundsMin: [b.xMin + cx * b.cellSize, b.yMin + cy * b.cellSize, b.zMin + cz * b.cellSize],
                boundsMax: [b.xMin + (cx + 1) * b.cellSize, b.yMin + (cy + 1) * b.cellSize, b.zMin + (cz + 1) * b.cellSize],
                cellSize: b.cellSize,
        };
}

// --- Encode stars to tile files ---
// stars: array of { x, y, z, appMag, spectralClass, sourceId, isLandmark, parallaxOverError }
// outDir: directory path where tiles are written
function encodeTiles(stars, outDir) {
        // Group by cell
        const tiles = new Map();  // key: `${band}_${cx}_${cy}_${cz}` → array of stars
        const landmarkSet = new Set(stars.filter(s => s.isLandmark).map(s => s.sourceId));

        let keptCount = 0;
        let droppedMag = 0;
        let droppedQual = 0;
        let droppedDecim = 0;
        let droppedOob = 0;  // outside all bands

        for (const s of stars) {
                // Track filter reasons
                if (s.appMag > CONFIG.magnitudeCut) { droppedMag++; continue; }
                if (s.parallaxOverError < CONFIG.parallaxQualityCut) { droppedQual++; continue; }
                // Determine cell first, then apply radial decimation per-cell
                const cell = bandAndCell(s.x, s.y, s.z);
                if (!cell) { droppedOob++; continue; }
                // Apply radial decimation (skip landmarks)
                if (!s.isLandmark) {
                        const r = Math.sqrt(s.x * s.x + s.y * s.y + s.z * s.z);
                        if (r < CONFIG.radialDecimationR0) {
                                const keepProb = (r / CONFIG.radialDecimationR0) ** 2;
                                const u = hash.hash01(s.sourceId);
                                if (u >= keepProb) { droppedDecim++; continue; }
                        }
                }
                keptCount++;
                const key = `${cell.band}_${cell.cx}_${cell.cy}_${cell.cz}`;
                if (!tiles.has(key)) {
                        tiles.set(key, { band: cell.band, cx: cell.cx, cy: cell.cy, cz: cell.cz, boundsMin: cell.boundsMin, boundsMax: cell.boundsMax, stars: [] });
                }
                tiles.get(key).stars.push(s);
        }

        // Write each tile to disk
        fs.mkdirSync(outDir, { recursive: true });
        for (const [key, tile] of tiles) {
                writeTileFile(tile, outDir);
        }

        return {
                input: stars.length,
                kept: keptCount,
                droppedMagnitude: droppedMag,
                droppedQuality: droppedQual,
                droppedDecimation: droppedDecim,
                droppedOutOfBounds: droppedOob,
                tileCount: tiles.size,
                avgStarsPerTile: keptCount / Math.max(1, tiles.size),
        };
}

function writeTileFile(tile, outDir) {
        const bandDir = path.join(outDir, tile.band);
        fs.mkdirSync(bandDir, { recursive: true });
        const filename = `tile_${tile.cx}_${tile.cy}_${tile.cz}.js`;
        const filepath = path.join(bandDir, filename);

        // Header: 32 bytes
        //   bytes 0-11:  boundsMinXYZ (3 × f32 = 12)
        //   bytes 12-23: boundsMaxXYZ (3 × f32 = 12)
        //   bytes 24-27: starCount (u32)
        //   bytes 28-31: reserved (u32)
        const header = new ArrayBuffer(32);
        const hview = new DataView(header);
        hview.setFloat32(0, tile.boundsMin[0], true);
        hview.setFloat32(4, tile.boundsMin[1], true);
        hview.setFloat32(8, tile.boundsMin[2], true);
        hview.setFloat32(12, tile.boundsMax[0], true);
        hview.setFloat32(16, tile.boundsMax[1], true);
        hview.setFloat32(20, tile.boundsMax[2], true);
        hview.setUint32(24, tile.stars.length >>> 0, true);
        hview.setUint32(28, 0, true);

        // Body: starCount * 16 bytes
        const body = new Uint8Array(tile.stars.length * 16);
        for (let i = 0; i < tile.stars.length; i++) {
                const bytes = packStar(tile.stars[i]);
                body.set(bytes, i * 16);
        }

        // Concatenate header + body
        const all = new Uint8Array(header.byteLength + body.byteLength);
        all.set(new Uint8Array(header), 0);
        all.set(body, header.byteLength);

        // Emit as JS file: assigns to window.__tile_<band>_<x>_<y>_<z>
        const globalName = `__tile_${tile.band}_${tile.cx}_${tile.cy}_${tile.cz}`;
        const jsContent = `// Auto-generated by experiments/tile-encoder.js. Do not edit.\n` +
                `// Tile: band=${tile.band}, cell=(${tile.cx}, ${tile.cy}, ${tile.cz}), ${tile.stars.length} stars.\n` +
                `// Format: 32-byte header + ${tile.stars.length} x 16-byte StarPacked records.\n` +
                `(function() {\n` +
                `\tvar bytes = new Uint8Array([${Array.from(all).join(',')}]);\n` +
                `\tvar g = (typeof window !== 'undefined') ? window :\n` +
                `\t        (typeof globalThis !== 'undefined') ? globalThis :\n` +
                `\t        (typeof global !== 'undefined') ? global : this;\n` +
                `\tg['${globalName}'] = bytes;\n` +
                `\tif (typeof module !== 'undefined') module.exports = bytes;\n` +
                `})();\n`;
        fs.writeFileSync(filepath, jsContent);
}

// --- Mock data generator (for testing without real Gaia) ---
function generateMockStars(n) {
        const box = { xMin: -10, xMax: 10, yMin: -10, yMax: 10, zMin: -2, zMax: 2 };
        const rhoMax = sampling.precomputeRhoMax(box, 60);
        const positions = sampling.sampleStars(12345, n, box, rhoMax);
        return positions.map((p, i) => {
                const s = starTypes.deriveStarProps(p.x, p.y, p.z, 12345 * 31 + i + 1);
                return {
                        sourceId: i + 1,
                        x: p.x, y: p.y, z: p.z,
                        appMag: s.appMag,
                        spectralClass: s.class,
                        isLandmark: i < 100,  // mark first 100 as landmarks (Pleiades etc.)
                        parallaxOverError: 20 + Math.random() * 30,  // mock good quality
                };
        });
}

// --- CLI ---
function main() {
        const args = process.argv.slice(2);
        const isMock = args.includes('--mock');
        const inputArg = args.indexOf('--input');
        const outputArg = args.indexOf('--output');
        const outDir = outputArg >= 0 ? args[outputArg + 1] : path.join(__dirname, '..', 'src', 'data', 'tiles');

        console.log('=== tile-encoder.js ===\n');

        // Run coordinate conversion tests first
        console.log('Coordinate conversion tests:');
        const cc = testCoordinateConversion();
        for (const c of cc) {
                console.log(`  ${c.pass ? 'OK' : 'FAIL'}: ${c.name}`);
        }

        let stars;
        if (isMock) {
                console.log('\nGenerating mock data (--mock mode)...');
                stars = generateMockStars(50000);
                console.log(`  generated ${stars.length} mock stars`);
        } else if (inputArg >= 0) {
                const csvPath = args[inputArg + 1];
                console.log(`\nReading CSV: ${csvPath}`);
                // CSV parsing omitted for now — would use a stream parser
                console.log('  (CSV parsing not yet implemented; use --mock to test the encoder)');
                return;
        } else {
                console.log('\nUsage: node tile-encoder.js --input gaia.csv --output src/data/tiles/');
                console.log('       node tile-encoder.js --mock --output src/data/tiles/');
                return;
        }

        console.log('\nEncoding tiles...');
        const summary = encodeTiles(stars, outDir);
        console.log('Encoding complete.');
        console.log(`  input:    ${summary.input.toLocaleString()}`);
        console.log(`  kept:     ${summary.kept.toLocaleString()}`);
        console.log(`  dropped (magnitude):  ${summary.droppedMagnitude.toLocaleString()}`);
        console.log(`  dropped (quality):    ${summary.droppedQuality.toLocaleString()}`);
        console.log(`  dropped (decimation): ${summary.droppedDecimation.toLocaleString()}`);
        console.log(`  dropped (out of bounds): ${summary.droppedOutOfBounds.toLocaleString()}`);
        console.log(`  tiles written: ${summary.tileCount}`);
        console.log(`  avg stars/tile: ${summary.avgStarsPerTile.toFixed(1)}`);
        console.log(`  output dir: ${outDir}`);
}

if (typeof module !== 'undefined') {
        module.exports = {
                CONFIG,
                raDecParallaxToGalactic,
                testCoordinateConversion,
                shouldKeep,
                packStar,
                bandAndCell,
                encodeTiles,
                writeTileFile,
                generateMockStars,
        };
}

if (require.main === module) {
        main();
}
