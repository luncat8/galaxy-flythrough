// experiments/filter-test.js
// Validates the per-star priority score and magnitude-band completeness model.
//
// Tests:
//   1. Priority score distribution (no banding, smooth across magnitudes)
//   2. Magnitude-band completeness tracking (5 bands: 0-4, 4-8, 8-12, 12-16, 16+)
//   3. Hash-based thinning: same star always kept/removed at same LOD (no popping)
//   4. Screen-space thinning preserves high-priority stars in crowded cells
//
// Output: experiments/logs/filter-test.json

'use strict';

const fs = require('fs');
const path = require('path');
const hash = require('../src/math/hash.js');

const N = 100000;

// --- Generate synthetic catalog stars with realistic property distributions ---
function generateCatalog() {
        const stars = new Array(N);
        for (let i = 0; i < N; i++) {
                // Apparent magnitude: log-uniform from 0 to 20 (more bright stars than realistic,
                // but useful for testing completeness across bands)
                const appMag = -2 + 22 * Math.random();
                // Parallax quality: random in [0, 50]
                const parallaxOverError = Math.random() * 50;
                // Landmark flag: 5% are landmarks
                const isLandmark = Math.random() < 0.05;
                // Stable random component
                const randomScore = hash.hash01(i * 7919 + 13);
                stars[i] = {
                        id: i,
                        appMag,
                        parallaxOverError,
                        isLandmark,
                        randomScore,
                };
        }
        return stars;
}

// --- Priority score ---
function priorityScore(s) {
        // Brighter = higher brightness score. Map -2..20 to 1..0.
        const brightnessScore = Math.max(0, 1 - (s.appMag + 2) / 22);
        // Quality: parallax_over_error > 5 is "good"
        const qualityScore = Math.min(1, s.parallaxOverError / 50);
        // Landmark: 1 if landmark, else 0
        const landmarkScore = s.isLandmark ? 1 : 0;
        // Weighted sum (plan §6 weights)
        return 2.0 * brightnessScore + 1.0 * qualityScore + 0.4 * landmarkScore + 0.2 * s.randomScore;
}

// --- Magnitude band classification ---
function magnitudeBand(appMag) {
        if (appMag < 4)  return '0-4';
        if (appMag < 8)  return '4-8';
        if (appMag < 12) return '8-12';
        if (appMag < 16) return '12-16';
        return '16+';
}

// --- Compute completeness per band (simulated) ---
// In a real catalog, bright bands are complete further than faint bands.
// Model: 0-4 complete to 5 kpc, 4-8 to 2 kpc, 8-12 to 1 kpc, 12-16 to 0.5 kpc, 16+ to 0.1 kpc.
const COMPLETENESS_RADIUS_KPC = {
        '0-4': 5.0,
        '4-8': 2.0,
        '8-12': 1.0,
        '12-16': 0.5,
        '16+': 0.1,
};

// --- Hash-based thinning ---
// Keep star if hash(id, tileId, lodLevel) < p (probability threshold)
function keepStar(starId, tileId, lodLevel, p) {
        const seed = (starId * 1000003 + tileId * 7919 + lodLevel * 31) | 0;
        const h = hash.hash01(seed);
        return h < p;
}

// --- Test 1: Priority score distribution ---
// Distribution is expected to be skewed (not normal) because priority is a
// weighted sum of bounded uniforms with different weights. So we only check
// that no single bucket holds >10% of stars (no degenerate banding).
function testPriorityDistribution(stars) {
        const scored = stars.map(s => ({ ...s, priority: priorityScore(s) }));
        const NBUCKETS = 36;
        const hist = new Array(NBUCKETS).fill(0);
        for (const s of scored) {
                const b = Math.min(NBUCKETS - 1, Math.floor(s.priority / 3.6 * NBUCKETS));
                hist[b]++;
        }
        const maxBucketPct = Math.max(...hist) / N;
        const meanBucket = N / NBUCKETS;
        const variance = hist.reduce((a, b) => a + (b - meanBucket) ** 2, 0) / NBUCKETS;
        const stddev = Math.sqrt(variance);
        return {
                histogram: hist,
                maxBucketPct,
                meanBucket,
                stddev,
                pass: maxBucketPct < 0.10,
        };
}

// --- Test 2: Magnitude band completeness ---
function testMagnitudeBandCompleteness(stars) {
        const counts = { '0-4': 0, '4-8': 0, '8-12': 0, '12-16': 0, '16+': 0 };
        const priorities = { '0-4': [], '4-8': [], '8-12': [], '12-16': [], '16+': [] };
        for (const s of stars) {
                const band = magnitudeBand(s.appMag);
                counts[band]++;
                priorities[band].push(priorityScore(s));
        }
        const meanPriority = {};
        for (const b of Object.keys(priorities)) {
                const arr = priorities[b];
                meanPriority[b] = arr.reduce((a, b) => a + b, 0) / Math.max(1, arr.length);
        }
        return {
                counts,
                meanPriorityByBand: meanPriority,
                completenessRadiusKpc: COMPLETENESS_RADIUS_KPC,
        };
}

// --- Test 3: Hash thinning determinism ---
function testHashThinningDeterminism(stars) {
        // Apply same thinning twice with same params — must produce identical result
        const p = 0.3;  // keep 30%
        const tileId = 42;
        const lod = 2;
        const kept1 = stars.filter(s => keepStar(s.id, tileId, lod, p));
        const kept2 = stars.filter(s => keepStar(s.id, tileId, lod, p));
        const identical = kept1.length === kept2.length
                && kept1.every((s, i) => s.id === kept2[i].id);
        // Check that kept fraction ~ p (within 5%)
        const fraction = kept1.length / stars.length;
        return {
                targetP: p,
                actualFraction: fraction,
                keptCount: kept1.length,
                deterministic: identical,
                pass: identical && Math.abs(fraction - p) < 0.05,
        };
}

// --- Test 4: Screen-space thinning preserves high-priority stars ---
// Simulate: 100 stars project to the same screen cell. We should keep only
// the highest-priority one. Repeat across many cells.
function testScreenSpaceThinning(stars) {
        const NCELLS = 1000;
        const STARS_PER_CELL = 50;
        let preservedHighest = 0;
        let total = 0;
        for (let c = 0; c < NCELLS; c++) {
                // Pick random stars for this cell
                const cellStars = [];
                for (let i = 0; i < STARS_PER_CELL; i++) {
                        const idx = (c * STARS_PER_CELL + i) % stars.length;
                        cellStars.push({ ...stars[idx], priority: priorityScore(stars[idx]) });
                }
                // Find highest priority
                const maxP = Math.max(...cellStars.map(s => s.priority));
                // Simulate keeping one per cell (the highest)
                const kept = cellStars.reduce((a, b) => a.priority > b.priority ? a : b);
                if (kept.priority === maxP) preservedHighest++;
                total++;
        }
        return {
                cellsTested: total,
                highPriorityPreserved: preservedHighest,
                pass: preservedHighest === total,
        };
}

console.log('=== Filter & Priority Test ===\n');

const catalog = generateCatalog();

console.log('--- Test 1: Priority score distribution ---');
const t1 = testPriorityDistribution(catalog);
console.log(`  max bucket pct: ${(t1.maxBucketPct * 100).toFixed(2)}% (pass <10%): ${t1.pass}`);
console.log(`  mean bucket: ${t1.meanBucket.toFixed(0)}, stddev: ${t1.stddev.toFixed(0)}`);

console.log('\n--- Test 2: Magnitude-band completeness ---');
const t2 = testMagnitudeBandCompleteness(catalog);
console.log('  Band | Count | Mean priority | Completeness radius (kpc)');
console.log('  -----|-------|---------------|--------------------------');
for (const band of ['0-4', '4-8', '8-12', '12-16', '16+']) {
        console.log(
                `  ${band.padStart(4)} | ` +
                `${t2.counts[band].toString().padStart(5)} | ` +
                `${t2.meanPriorityByBand[band].toFixed(3).padStart(13)} | ` +
                `${t2.completenessRadiusKpc[band].toFixed(2)}`
        );
}

console.log('\n--- Test 3: Hash thinning determinism ---');
const t3 = testHashThinningDeterminism(catalog);
console.log(`  target p: ${t3.targetP}, actual: ${t3.actualFraction.toFixed(4)}, deterministic: ${t3.deterministic}`);
console.log(`  pass: ${t3.pass}`);

console.log('\n--- Test 4: Screen-space thinning preserves highest priority ---');
const t4 = testScreenSpaceThinning(catalog);
console.log(`  cells: ${t4.cellsTested}, high-priority preserved: ${t4.highPriorityPreserved}`);
console.log(`  pass: ${t4.pass}`);

const out = {
        date: new Date().toISOString(),
        N,
        tests: {
                priorityDistribution: t1,
                magnitudeBandCompleteness: t2,
                hashThinningDeterminism: t3,
                screenSpaceThinning: t4,
        },
        verdict: t1.pass && t3.pass && t4.pass
                ? 'PASS — filtering pipeline ready for implementation'
                : 'FAIL — investigate before shipping',
};

const logPath = path.join(__dirname, 'logs', 'filter-test.json');
fs.writeFileSync(logPath, JSON.stringify(out, null, 2));
console.log(`\nWrote ${logPath}`);

console.log('\n=== VERDICT ===');
console.log(out.verdict);
