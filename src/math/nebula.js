// experiments/lib/nebula.js
// Compact nebula placement based on local young-star density and ISM dust density.
//
// Nebulae concentrate in:
//   - spiral arms (where molecular clouds form, then OB stars photoionise them)
//   - thin disc midplane (low |z|)
//   - rare in bulge/halo (very little cold gas there)
//
// Each nebula is hash-seeded with deterministic position, size, type, colour.

'use strict';

const density = require('./density.js');
const hash = require('./hash.js');

// Nebula types
//   'HII'      — emission nebula (red/pink, H alpha), around young OB clusters
//   'reflection' — blue reflection nebula, around B stars
//   'planetary'  — planetary nebula (green/blue), around old WD progenitors
//   'dark'      — dark dust cloud, no emission
//   'SNR'       — supernova remnant, rare, expanding shell
const NEBULA_TYPES = ['HII', 'reflection', 'planetary', 'dark', 'SNR'];

const NEBULA_COLORS = {
        HII:        [1.00, 0.30, 0.45],   // H-alpha pink-red
        reflection: [0.50, 0.65, 1.00],   // blue
        planetary:  [0.40, 1.00, 0.70],   // green OIII
        dark:       [0.20, 0.18, 0.16],   // brown-grey, mostly absorbs
        SNR:        [0.50, 0.20, 1.00],   // purple synchrotron
};

// Probability of nebula given position (deterministic from density model).
// Returns {p, type} for the most likely type at this position.
function nebulaProbabilityAt(x, y, z) {
        const dec = density.rhoDecomposed(x, y, z);
        const dom = density.dominantComponent(x, y, z);
        // Cold gas concentrates in thin disc + arms. Use thin-disc density + arm proximity.
        const inDisc = Math.exp(-Math.abs(z) / 0.150); // tight, 150 pc scale
        const armBoost = dec.distToArm < 0.8
                ? Math.exp(-dec.distToArm * dec.distToArm / 0.20) // gaussian, ~0.45 kpc
                : 0.0;
        // Gas-driven nebulae (HII, reflection, dark) suppressed in bulge/halo (no cold gas).
        const gasBulgeSuppress = dec.bulge > 0.1 ? 0.1 : 1.0;
        const gasHaloSuppress = dec.halo > 0.0005 ? 0.01 : 1.0;
        const pGas = Math.min(1.0, 0.05 * inDisc * armBoost * gasBulgeSuppress * gasHaloSuppress);
        // Stellar-driven nebulae (planetary, SNR) depend on stellar population, not gas.
        // Higher where old stars dominate (bulge, thick disc).
        const pStellar = 0.005 * (dec.bulge > 0.05 ? 4.0 : 1.0) * (dom === 'halo' ? 0.3 : 1.0);
        const p = Math.min(1.0, pGas + pStellar);

        // Pick type by environment (dominant component drives the type)
        let type;
        if (dec.distToArm < 0.3 && dec.R > 3 && dec.R < 12 && dom !== 'bulge') {
                // Inside arm peak — likely HII region
                type = 'HII';
        } else if (dec.distToArm < 0.8 && dec.R > 3 && dec.R < 12 && dom !== 'bulge') {
                // Just off arm — reflection nebula around stray B stars
                type = 'reflection';
        } else if (dom === 'bulge' || (dec.R < 3 && dec.zp < 1.0)) {
                // Old population — planetary nebulae from WD progenitors
                type = 'planetary';
        } else if (dec.distToArm < 1.5 && dec.R > 3 && dom !== 'halo') {
                // Diffuse arm region — dark cloud
                type = 'dark';
        } else {
                // Rare SNR
                type = 'SNR';
        }
        return { p, type, dec, dom };
}

// Place N nebulae via rejection sampling: sample positions, accept by p.
// Returns array of nebula descriptors.
function placeNebulae(seed, N, box, rhoMax) {
        const out = [];
        const xRange = box.xMax - box.xMin;
        const yRange = box.yMax - box.yMin;
        const zRange = box.zMax - box.zMin;
        let i = 0;
        let attempts = 0;
        const maxAttempts = N * 1024;
        while (out.length < N && attempts < maxAttempts) {
                const h = hash.hash3D(seed * 1000003 + i + 1);
                const x = box.xMin + h.x * xRange;
                const y = box.yMin + h.y * yRange;
                const z = box.zMin + h.z * zRange;
                const starDensity = density.rhoTotal(x, y, z);
                // Need *some* stars nearby to host a nebula
                if (starDensity < 0.001 * rhoMax) {
                        i++; attempts++; continue;
                }
                const u = hash.hash01(seed * 1000003 + i + 0xC0FFEE);
                const { p, type, dec, dom } = nebulaProbabilityAt(x, y, z);
                i++; attempts++;
                if (u < p) {
                        const sizeRoll = hash.hash01(seed * 1000003 + i + 0xBEEF);
                        const size = 0.020 + sizeRoll * 0.300; // 20 pc to 320 pc
                        const orientationHash = hash.hash2D(seed * 1000003 + i + 0xCAFE);
                        out.push({
                                x, y, z,
                                type,
                                size,
                                color: NEBULA_COLORS[type],
                                opacity: 0.4 + 0.5 * hash.hash01(seed * 1000003 + i + 0xFACE),
                                orientation: orientationHash.x * 2 * Math.PI,
                                distToArm: dec.distToArm,
                                R: dec.R, phi: dec.phi, zp: dec.zp,
                                component: density.sampleComponent(dec, hash.hash01(seed * 1000003 + i + 0xF00D)),
                                dominant: dom,
                                index: out.length,
                                seed: seed * 1000003 + i,
                        });
                }
        }
        return out;
}

// Summary stats on nebula placement.
function summariseNebulae(nebulae) {
        const byType = {};
        const byComponent = {};
        const armDistBuckets = [0, 0, 0, 0, 0]; // [0,0.3) [0.3,0.8) [0.8,1.5) [1.5,3) [3+)
        for (const n of nebulae) {
                byType[n.type] = (byType[n.type] || 0) + 1;
                byComponent[n.component] = (byComponent[n.component] || 0) + 1;
                if (n.distToArm < 0.3)        armDistBuckets[0]++;
                else if (n.distToArm < 0.8)   armDistBuckets[1]++;
                else if (n.distToArm < 1.5)   armDistBuckets[2]++;
                else if (n.distToArm < 3.0)   armDistBuckets[3]++;
                else                          armDistBuckets[4]++;
        }
        const meanSize = nebulae.reduce((a, b) => a + b.size, 0) / Math.max(1, nebulae.length);
        return {
                total: nebulae.length,
                byType,
                byComponent,
                armDistBuckets,
                meanSizeKpc: meanSize,
        };
}

if (typeof module !== 'undefined') {
        module.exports = {
                NEBULA_TYPES, NEBULA_COLORS,
                nebulaProbabilityAt,
                placeNebulae,
                summariseNebulae,
        };
}
if (typeof window !== 'undefined') {
        window.NebulaLib = {
                NEBULA_TYPES, NEBULA_COLORS,
                nebulaProbabilityAt, placeNebulae, summariseNebulae,
        };
}
