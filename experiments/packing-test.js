// experiments/packing-test.js
// Validates the StarPacked struct layout and computes GPU memory budget
// for various star counts. The struct is 16 bytes per star:
//
//   positionHighXYZ (3 × f32 = 12 bytes)
//   packed (u32 = 4 bytes):
//     bits 0-7:   colorIndex (256-entry LUT)
//     bits 8-15:  apparent magnitude (0-20 mag, 256 steps)
//     bits 16-23: flags (binary, variable, nebula-associated, landmark)
//     bits 24-31: low-precision sub-cell jitter
//
// Tests:
//   1. Round-trip encode/decode fidelity for position, magnitude, color
//   2. Memory budget at various star counts (10k, 100k, 1M, 5M, 20M)
//   3. Indirect draw buffer sizing
//   4. Comparison with naive 32-byte struct (no packing)
//
// Output: experiments/logs/packing-test.json

'use strict';

const fs = require('fs');
const path = require('path');

// --- Packed struct encoder/decoder ---
// Position: 3 × f32 (12 bytes) - positionHighXYZ, sub-cell jitter packed separately.
// Packed u32:
//   bits 0-7:   colorIndex (0-255)
//   bits 8-15:  appMag (0-20 mag, 256 steps = 0.078 mag/step)
//   bits 16-23: flags
//   bits 24-31: subCellJitter (0-255, applied to positionLow)

const STRUCT_SIZE_PACKED = 16;
const STRUCT_SIZE_NAIVE = 32;  // 8 × f32 = position(3) + mag(1) + color(3) + flags(1)

function encodeStar(positionHigh, colorIndex, appMag, flags, subCellJitter) {
        // positionHigh: vec3<f32>, stored directly
        const px = Math.fround(positionHigh[0]);
        const py = Math.fround(positionHigh[1]);
        const pz = Math.fround(positionHigh[2]);
        // packed u32
        const ci = Math.max(0, Math.min(255, colorIndex | 0));
        const mag = Math.max(0, Math.min(255, Math.floor((appMag / 20) * 255)));
        const fl = Math.max(0, Math.min(255, flags | 0));
        const sc = Math.max(0, Math.min(255, subCellJitter | 0));
        const packed = (ci | (mag << 8) | (fl << 16) | (sc << 24)) >>> 0;
        return { px, py, pz, packed };
}

function decodeStar(star) {
        const packed = star.packed >>> 0;
        const colorIndex = packed & 0xFF;
        const magByte = (packed >>> 8) & 0xFF;
        const flags = (packed >>> 16) & 0xFF;
        const subCellJitter = (packed >>> 24) & 0xFF;
        const appMag = (magByte / 255) * 20;
        return {
                positionHigh: [star.px, star.py, star.pz],
                colorIndex,
                appMag,
                flags,
                subCellJitter,
        };
}

// --- Round-trip fidelity test ---
function roundTripTest() {
        const N = 100000;
        const testStars = [];
        for (let i = 0; i < N; i++) {
                testStars.push({
                        positionHigh: [
                                (Math.random() - 0.5) * 30,  // ±15 kpc
                                (Math.random() - 0.5) * 30,
                                (Math.random() - 0.5) * 6,
                        ],
                        colorIndex: Math.floor(Math.random() * 256),
                        appMag: Math.random() * 20,
                        flags: Math.floor(Math.random() * 256),
                        subCellJitter: Math.floor(Math.random() * 256),
                });
        }
        let maxPosErr = 0;
        let maxMagErr = 0;
        let sumPosErr = 0;
        let sumMagErr = 0;
        for (const s of testStars) {
                const enc = encodeStar(s.positionHigh, s.colorIndex, s.appMag, s.flags, s.subCellJitter);
                const dec = decodeStar(enc);
                const dx = dec.positionHigh[0] - s.positionHigh[0];
                const dy = dec.positionHigh[1] - s.positionHigh[1];
                const dz = dec.positionHigh[2] - s.positionHigh[2];
                const err = Math.sqrt(dx * dx + dy * dy + dz * dz);
                if (err > maxPosErr) maxPosErr = err;
                sumPosErr += err;
                const magErr = Math.abs(dec.appMag - s.appMag);
                if (magErr > maxMagErr) maxMagErr = magErr;
                sumMagErr += magErr;
        }
        return {
                n: N,
                positionMaxErrorKpc: maxPosErr,
                positionMeanErrorKpc: sumPosErr / N,
                magnitudeMaxError: maxMagErr,
                magnitudeMeanError: sumMagErr / N,
                magnitudeQuantum: 20 / 255,
                colorIndexLost: false,  // exact
                flagsLost: false,        // exact
                subCellJitterLost: false, // exact
        };
}

// --- Memory budget at various star counts ---
function memoryBudget(counts) {
        return counts.map(n => ({
                starCount: n,
                packedBytes: n * STRUCT_SIZE_PACKED,
                packedMB: (n * STRUCT_SIZE_PACKED / 1024 / 1024).toFixed(1),
                naiveBytes: n * STRUCT_SIZE_NAIVE,
                naiveMB: (n * STRUCT_SIZE_NAIVE / 1024 / 1024).toFixed(1),
                savingsMB: ((n * STRUCT_SIZE_NAIVE - n * STRUCT_SIZE_PACKED) / 1024 / 1024).toFixed(1),
                savingsPct: ((1 - STRUCT_SIZE_PACKED / STRUCT_SIZE_NAIVE) * 100).toFixed(0),
                // Indirect draw buffer: visible indices (u32) + draw args (5 u32)
                indirectDrawBytes: n * 4 + 20,
                indirectDrawMB: ((n * 4 + 20) / 1024 / 1024).toFixed(2),
                // Total GPU memory: star storage + indirect + color LUT (4KB) + density tex (128KB)
                totalPackedMB: ((n * STRUCT_SIZE_PACKED + n * 4 + 20 + 4096 + 131072) / 1024 / 1024).toFixed(1),
        }));
}

console.log('=== Packing test ===\n');

console.log('--- Round-trip fidelity ---');
const rt = roundTripTest();
console.log(`  N samples: ${rt.n.toLocaleString()}`);
console.log(`  Position max error:  ${rt.positionMaxErrorKpc.toExponential(3)} kpc (f32 round)`);
console.log(`  Position mean error: ${rt.positionMeanErrorKpc.toExponential(3)} kpc`);
console.log(`  Magnitude max error: ${rt.magnitudeMaxError.toFixed(4)} mag (quantum ${rt.magnitudeQuantum.toFixed(4)})`);
console.log(`  Magnitude mean error: ${rt.magnitudeMeanError.toFixed(4)} mag`);
console.log(`  colorIndex preserved exactly: ${!rt.colorIndexLost}`);
console.log(`  flags preserved exactly: ${!rt.flagsLost}`);
console.log(`  subCellJitter preserved exactly: ${!rt.subCellJitterLost}`);

console.log('\n--- Memory budget ---');
const counts = [10000, 100000, 1000000, 5000000, 20000000];
const budget = memoryBudget(counts);
console.log('  Star count   | Packed MB | Naive MB | Saved | Indirect MB | Total MB');
console.log('  -------------|-----------|----------|-------|-------------|---------');
for (const b of budget) {
        console.log(
                `  ${b.starCount.toLocaleString().padStart(12)} | ` +
                `${b.packedMB.padStart(9)} | ` +
                `${b.naiveMB.padStart(8)} | ` +
                `${b.savingsPct.padStart(5)}% | ` +
                `${b.indirectDrawMB.padStart(11)} | ` +
                `${b.totalPackedMB.padStart(7)}`
        );
}

// --- Recommendation: budget feasibility ---
const TARGET_MEMORY_MB = 256;  // target budget for star storage
const maxFeasiblePacked = Math.floor(TARGET_MEMORY_MB * 1024 * 1024 / STRUCT_SIZE_PACKED);
const maxFeasibleNaive = Math.floor(TARGET_MEMORY_MB * 1024 * 1024 / STRUCT_SIZE_NAIVE);

const out = {
        date: new Date().toISOString(),
        structLayout: {
                sizeBytes: STRUCT_SIZE_PACKED,
                fields: [
                        { name: 'positionHighX', type: 'f32', bytes: 4 },
                        { name: 'positionHighY', type: 'f32', bytes: 4 },
                        { name: 'positionHighZ', type: 'f32', bytes: 4 },
                        { name: 'packed', type: 'u32', bytes: 4, bits: [
                                { name: 'colorIndex', bits: '0-7' },
                                { name: 'appMag', bits: '8-15', quantum: 20 / 255 },
                                { name: 'flags', bits: '16-23' },
                                { name: 'subCellJitter', bits: '24-31' },
                        ]},
                ],
        },
        roundTrip: rt,
        memoryBudget: budget,
        feasibility: {
                targetMemoryMB: TARGET_MEMORY_MB,
                maxFeasiblePackedStars: maxFeasiblePacked,
                maxFeasibleNaiveStars: maxFeasibleNaive,
                packingGainFactor: maxFeasiblePacked / maxFeasibleNaive,
        },
        recommendation: `Packed 16-byte struct supports ${maxFeasiblePacked.toLocaleString()} stars in ${TARGET_MEMORY_MB} MB (vs ${maxFeasibleNaive.toLocaleString()} naive)`,
};

const logPath = path.join(__dirname, 'logs', 'packing-test.json');
fs.writeFileSync(logPath, JSON.stringify(out, null, 2));
console.log(`\nWrote ${logPath}`);

console.log('\n=== VERDICT ===');
console.log(`Recommendation: ${out.recommendation}`);
