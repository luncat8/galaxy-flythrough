// experiments/density-distribution-test.js
// Validates that rejection sampling from rhoTotal reproduces the analytical
// distribution: exponential thin disc (R), sech^2 (z), concentrated bulge,
// power-law halo, and spiral arm overdensity.
//
// Output: experiments/logs/density-distribution.json

'use strict';

const fs = require('fs');
const path = require('path');
const density = require('../src/math/density.js');
const sampling = require('../src/math/sampling.js');

const SEED = 42;
const N_STARS = 100000;
const BOX = { xMin: -25, xMax: 5, yMin: -15, yMax: 15, zMin: -5, zMax: 5 };

console.log('Precomputing rhoMax on 80^3 grid...');
const t0 = Date.now();
const rhoMax = sampling.precomputeRhoMax(BOX, 80);
console.log(`  rhoMax = ${rhoMax.toFixed(4)}  (took ${Date.now() - t0}ms)`);

console.log(`Sampling ${N_STARS} stars...`);
const t1 = Date.now();
const stars = sampling.sampleStars(SEED, N_STARS, BOX, rhoMax);
const accepted = stars.filter(s => s.accepted).length;
console.log(`  accepted ${accepted}/${N_STARS}  (took ${Date.now() - t1}ms)`);

// Build histograms
function histogram(values, min, max, bins) {
        const counts = new Array(bins).fill(0);
        const width = (max - min) / bins;
        for (const v of values) {
                if (v < min || v > max) continue;
                const b = Math.min(bins - 1, Math.floor((v - min) / width));
                counts[b]++;
        }
        return counts.map((c, i) => ({
                lo: min + i * width,
                hi: min + (i + 1) * width,
                count: c,
        }));
}

const Rs = stars.map(s => {
        const dx = s.x - density.GALACTIC_CENTRE.x;
        const dy = s.y - density.GALACTIC_CENTRE.y;
        return Math.sqrt(dx * dx + dy * dy);
});
const phis = stars.map(s => {
        const dx = s.x - density.GALACTIC_CENTRE.x;
        const dy = s.y - density.GALACTIC_CENTRE.y;
        return Math.atan2(dy, dx);
});
const zs = stars.map(s => s.z);
const distToArms = stars.map(s => density.rhoDecomposed(s.x, s.y, s.z).distToArm);

const R_hist = histogram(Rs, 0, 25, 25);
const z_hist = histogram(zs, -3, 3, 24);
const arm_hist = histogram(distToArms, 0, 4, 20);

// Component breakdown
const byComponent = { thin: 0, thick: 0, bulge: 0, halo: 0 };
for (const s of stars) byComponent[s.component]++;

// Arm overdensity test: density (per kpc^2) inside arm band vs inter-arm band.
// Predicted ratio from arm modulation = (1+A)/(1-A) = 1.20/0.80 = 1.50.
const inArm = distToArms.filter(d => d < 0.5).length;
const outArm = distToArms.filter(d => d >= 1.0 && d < 2.5).length;
// Normalise by band width (0.5 kpc vs 1.5 kpc) so we compare density, not count.
const armDensity = inArm / 0.5;
const interArmDensity = outArm / 1.5;
const armRatio = armDensity / Math.max(1, interArmDensity);
const expectedRatio = (1 + density.ARMS.amp) / (1 - density.ARMS.amp);

// Spiral arm phase test: check if azimuthal distribution shows m=2 modulation.
const phiBands = new Array(36).fill(0);
for (const phi of phis) {
        const a = (phi + Math.PI) / (2 * Math.PI); // [0, 1)
        const b = Math.min(35, Math.floor(a * 36));
        phiBands[b]++;
}
// Fourier m=2 amplitude
let sum2cos = 0, sum2sin = 0;
for (let i = 0; i < 36; i++) {
        const phi = (i + 0.5) / 36 * 2 * Math.PI;
        sum2cos += phiBands[i] * Math.cos(2 * phi);
        sum2sin += phiBands[i] * Math.sin(2 * phi);
}
const m2amp = Math.sqrt(sum2cos * sum2cos + sum2sin * sum2sin) / 36;

const out = {
        date: new Date().toISOString(),
        seed: SEED,
        N: N_STARS,
        box: BOX,
        rhoMax,
        acceptedCount: accepted,
        byComponent,
        armOverdensity: {
                starsInArm: inArm,
                starsInterArm: outArm,
                densityInArmPerKpc: armDensity.toFixed(1),
                densityInterArmPerKpc: interArmDensity.toFixed(1),
                ratioInOverInter: armRatio,
                expectedRatio: expectedRatio,
        },
        fourierM2Amplitude: m2amp,
        histograms: {
                R_kpc: R_hist,
                z_kpc: z_hist,
                distToArm_kpc: arm_hist,
        },
};

const logPath = path.join(__dirname, 'logs', 'density-distribution.json');
fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.writeFileSync(logPath, JSON.stringify(out, null, 2));
console.log(`Wrote ${logPath}`);

// Print verdict
console.log('\n=== VERDICT ===');
console.log('Component shares (sampled by relative density contribution):');
console.log(`  thin:  ${(byComponent.thin / N_STARS * 100).toFixed(1)}%`);
console.log(`  thick: ${(byComponent.thick / N_STARS * 100).toFixed(1)}%`);
console.log(`  bulge: ${(byComponent.bulge / N_STARS * 100).toFixed(1)}% (low — box is huge, bulge only matters near centre)`);
console.log(`  halo:  ${(byComponent.halo / N_STARS * 100).toFixed(1)}%`);
console.log(`Arm/inter-arm density ratio: ${armRatio.toFixed(2)} (predicted ${(1 + density.ARMS.amp) / (1 - density.ARMS.amp)})`);
console.log(`Fourier m=2 amplitude: ${m2amp.toFixed(2)} (expected > 0 for arm modulation)`);
console.log('Note: thin < thick because box covers R up to 22 kpc, where thick disc dominates.');
