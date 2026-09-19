// experiments/lib/sampling.js
// Rejection sampling of star positions from the analytical density field.
// Uses precomputed rhoMax for efficiency.

'use strict';

const density = require('./density.js');
const hash = require('./hash.js');

// Precompute maximum density on a grid so rejection sampling has a tight bound.
function precomputeRhoMax(box, steps) {
        const dx = (box.xMax - box.xMin) / steps;
        const dy = (box.yMax - box.yMin) / steps;
        const dz = (box.zMax - box.zMin) / steps;
        let max = 0;
        for (let i = 0; i <= steps; i++) {
                const x = box.xMin + i * dx;
                for (let j = 0; j <= steps; j++) {
                        const y = box.yMin + j * dy;
                        for (let k = 0; k <= steps; k++) {
                                const z = box.zMin + k * dz;
                                const r = density.rhoTotal(x, y, z);
                                if (r > max) max = r;
                        }
                }
        }
        // 5 percent headroom to avoid rejecting true peaks due to discretisation.
        return max * 1.05;
}

// Sample one star position via rejection sampling inside the box.
function sampleOnePosition(box, rhoMax, seed) {
        const xRange = box.xMax - box.xMin;
        const yRange = box.yMax - box.yMin;
        const zRange = box.zMax - box.zMin;
        for (let attempt = 0; attempt < 64; attempt++) {
                const h = hash.hash3D(seed * 64 + attempt + 1);
                const x = box.xMin + h.x * xRange;
                const y = box.yMin + h.y * yRange;
                const z = box.zMin + h.z * zRange;
                const r = density.rhoTotal(x, y, z);
                const u = hash.hash01(seed * 64 + attempt + 0xC0FFEE);
                if (u * rhoMax < r) {
                        return { x, y, z, accepted: true, attempts: attempt + 1 };
                }
        }
        // Fallback: return last sample (very rare if rhoMax is tight).
        const h = hash.hash3D(seed + 0xDEAD);
        return {
                x: box.xMin + h.x * xRange,
                y: box.yMin + h.y * yRange,
                z: box.zMin + h.z * zRange,
                accepted: false,
                attempts: 64,
        };
}

// Sample N stars. Returns array of {x, y, z, component, attempts, index}.
// Component is sampled probabilistically by relative density contribution
// (a star is "from" the population that contributed it).
function sampleStars(seed, N, box, rhoMax) {
        const out = new Array(N);
        for (let i = 0; i < N; i++) {
                const s = sampleOnePosition(box, rhoMax, seed * 1000003 + i);
                const d = density.rhoDecomposed(s.x, s.y, s.z);
                const uComp = hash.hash01(seed * 1000003 + i + 0xFEED);
                s.component = density.sampleComponent(d, uComp);
                s.index = i;
                out[i] = s;
        }
        return out;
}

// Sample stars restricted by a predicate (e.g., arm-only).
function sampleStarsFiltered(seed, N, box, rhoMax, predicate) {
        const out = [];
        const xRange = box.xMax - box.xMin;
        const yRange = box.yMax - box.yMin;
        const zRange = box.zMax - box.zMin;
        let i = 0;
        let attempts = 0;
        while (out.length < N && attempts < N * 256) {
                const h = hash.hash3D(seed * 1000003 + i + 1);
                const x = box.xMin + h.x * xRange;
                const y = box.yMin + h.y * yRange;
                const z = box.zMin + h.z * zRange;
                const r = density.rhoTotal(x, y, z);
                const u = hash.hash01(seed * 1000003 + i + 0xC0FFEE);
                attempts++;
                i++;
                if (u * rhoMax < r) {
                        const d = density.rhoDecomposed(x, y, z);
                        if (predicate(x, y, z, d)) {
                                const uComp = hash.hash01(seed * 1000003 + i + 0xFEED);
                                out.push({
                                        x, y, z,
                                        component: density.sampleComponent(d, uComp),
                                        index: out.length,
                                });
                        }
                }
        }
        return out;
}

if (typeof module !== 'undefined') {
        module.exports = {
                precomputeRhoMax,
                sampleOnePosition,
                sampleStars,
                sampleStarsFiltered,
        };
}
if (typeof window !== 'undefined') {
        window.SamplingLib = {
                precomputeRhoMax, sampleOnePosition, sampleStars, sampleStarsFiltered,
        };
}
