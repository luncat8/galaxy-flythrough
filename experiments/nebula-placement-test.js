// experiments/nebula-placement-test.js
// Validates that compact nebulae are placed in physically-correct locations:
//   - Most nebulae in spiral arms
//   - HII regions only in arm peaks with young OB stars
//   - Planetary nebulae in older bulge population
//   - Dark clouds in diffuse arm regions
//   - Almost none in halo (no cold gas there)
//
// Output: experiments/logs/nebula-placement.json

'use strict';

const fs = require('fs');
const path = require('path');
const density = require('../src/math/density.js');
const nebula = require('../src/math/nebula.js');
const sampling = require('../src/math/sampling.js');

const SEED = 99;
const N_NEBULAE = 1000;
const BOX = { xMin: -25, xMax: 5, yMin: -15, yMax: 15, zMin: -5, zMax: 5 };

console.log('Precomputing rhoMax...');
const rhoMax = sampling.precomputeRhoMax(BOX, 80);

console.log(`Placing ${N_NEBULAE} nebulae...`);
const t0 = Date.now();
const nebulae = nebula.placeNebulae(SEED, N_NEBULAE, BOX, rhoMax);
console.log(`  placed ${nebulae.length} in ${Date.now() - t0}ms`);

const summary = nebula.summariseNebulae(nebulae);

// Detailed type breakdown
const byType = summary.byType;
const byComponent = summary.byComponent;

// Validate: HII regions should be predominantly near arms (d_arm < 0.5 kpc)
const hII = nebulae.filter(n => n.type === 'HII');
const hIIInArm = hII.filter(n => n.distToArm < 0.5).length;
const hIIMeanArm = hII.reduce((a, b) => a + b.distToArm, 0) / Math.max(1, hII.length);

// Validate: planetary nebulae more in bulge (use dominant component for type validation)
const planetary = nebulae.filter(n => n.type === 'planetary');
const planetaryInBulge = planetary.filter(n => n.dominant === 'bulge').length;
const planetaryNearCentre = planetary.filter(n => n.R < 3.0).length;

// Validate: halo has very few nebulae (use dominant)
const haloNeb = nebulae.filter(n => n.dominant === 'halo').length;

const out = {
        date: new Date().toISOString(),
        seed: SEED,
        targetN: N_NEBULAE,
        placedN: nebulae.length,
        box: BOX,
        byType,
        byComponent,
        armDistBuckets: summary.armDistBuckets,
        meanSizeKpc: summary.meanSizeKpc,
        hII: {
                total: hII.length,
                inArm: hIIInArm,
                inArmPct: (hIIInArm / Math.max(1, hII.length) * 100).toFixed(1),
                meanDistToArmKpc: hIIMeanArm.toFixed(3),
        },
        planetary: {
                total: planetary.length,
                inBulge: planetaryInBulge,
                inBulgePct: (planetaryInBulge / Math.max(1, planetary.length) * 100).toFixed(1),
        },
        halo: {
                totalNebulae: haloNeb,
                expected: 0,
        },
};

const logPath = path.join(__dirname, 'logs', 'nebula-placement.json');
fs.writeFileSync(logPath, JSON.stringify(out, null, 2));
console.log(`Wrote ${logPath}`);

// Verdict
console.log('\n=== VERDICT ===');
console.log('Nebulae by type:');
for (const t of nebula.NEBULA_TYPES) {
        const n = byType[t] || 0;
        console.log(`  ${t}: ${n}`);
}
console.log('\nNebulae by galaxy component:');
for (const k of Object.keys(byComponent)) {
        console.log(`  ${k}: ${byComponent[k]}`);
}
console.log('\nHII regions:');
console.log(`  total: ${hII.length}`);
console.log(`  in arm (d<0.5kpc): ${hIIInArm} (${out.hII.inArmPct}%, expect >70%)`);
console.log(`  mean dist to arm: ${out.hII.meanDistToArmKpc} kpc (expect <0.5)`);
console.log('\nPlanetary nebulae:');
console.log(`  total: ${planetary.length}`);
console.log(`  in bulge: ${planetaryInBulge} (${out.planetary.inBulgePct}%, expect >50%)`);
console.log('\nHalo nebulae:');
console.log(`  ${haloNeb} (expect 0 or 1)`);
