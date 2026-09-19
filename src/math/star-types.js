// experiments/lib/star-types.js
// Stellar type assignment based on local population and stellar evolution.
//
// For each star position, the local component (thin/thick/bulge/halo) and
// distance to nearest spiral arm determine:
//   - local age distribution (young near arms, old in bulge/halo)
//   - metallicity (solar in disc, super-solar in bulge, low in halo)
//   - IMF sample (Salpeter)
//   - evolved state (main sequence / giant / white dwarf) from age vs MS lifetime
//
// This implements the "star types evolution position" requirement: O/B stars
// are found only in/near spiral arms, red giants concentrate in bulge, etc.

'use strict';

const density = require('./density.js');
const hash = require('./hash.js');

// Spectral classification by temperature (approximate).
// Returns one of: O, B, A, F, G, K, M, WD (white dwarf), RG (red giant).
function classifyByTempAndState(Teff, evolvedState) {
        if (evolvedState === 'wd') return 'WD';
        if (evolvedState === 'giant') return 'RG';
        if (Teff >= 30000) return 'O';
        if (Teff >= 10000) return 'B';
        if (Teff >= 7500)  return 'A';
        if (Teff >= 6000)  return 'F';
        if (Teff >= 5200)  return 'G';
        if (Teff >= 3700)  return 'K';
        return 'M';
}

// Rough colour (sRGB 0-1) by spectral class — used for visualisation.
function classColor(cls) {
        switch (cls) {
                case 'O': return [0.60, 0.70, 1.00];
                case 'B': return [0.75, 0.82, 1.00];
                case 'A': return [0.95, 0.95, 1.00];
                case 'F': return [1.00, 1.00, 0.92];
                case 'G': return [1.00, 0.95, 0.75];
                case 'K': return [1.00, 0.78, 0.50];
                case 'M': return [1.00, 0.55, 0.40];
                case 'RG': return [1.00, 0.40, 0.30];
                case 'WD': return [0.85, 0.85, 1.00];
                default:  return [1.0, 1.0, 1.0];
        }
}

// Mass-luminosity relation (rough): L/Lsun = (M/Msun)^alpha
function luminosityFromMass(m) {
        if (m < 0.7) return m ** 2.3;
        if (m < 2.0) return m ** 4.0;
        if (m < 20)  return m ** 3.5;
        return m ** 2.8; // very massive: radiation pressure flattens
}

// Mass-Teff table (empirical, main sequence). [M_sun, Teff_K].
// Interpolated in log-log space.
const MASS_TEFF_TABLE = [
        [0.08,  2400],
        [0.10,  2800],
        [0.15,  3200],
        [0.20,  3400],
        [0.30,  3600],
        [0.45,  3800],
        [0.70,  4500],
        [0.85,  5000],
        [1.00,  5800],
        [1.50,  6800],
        [2.00,  9000],
        [3.00,  12000],
        [5.00,  16000],
        [9.00,  22000],
        [16.0,  30000],
        [30.0,  38000],
        [60.0,  45000],
        [100,   50000],
];

// Mass-temperature relation via log-log interpolation of empirical table.
function teffFromMass(m) {
        if (m <= MASS_TEFF_TABLE[0][0]) return MASS_TEFF_TABLE[0][1];
        const last = MASS_TEFF_TABLE[MASS_TEFF_TABLE.length - 1];
        if (m >= last[0]) return last[1];
        for (let i = 0; i < MASS_TEFF_TABLE.length - 1; i++) {
                const lo = MASS_TEFF_TABLE[i];
                const hi = MASS_TEFF_TABLE[i + 1];
                if (m >= lo[0] && m <= hi[0]) {
                        const t = (Math.log10(m) - Math.log10(lo[0])) / (Math.log10(hi[0]) - Math.log10(lo[0]));
                        return Math.pow(10, (1 - t) * Math.log10(lo[1]) + t * Math.log10(hi[1]));
                }
        }
        return 5772;
}

// Main-sequence lifetime (Gyr). Rough: t_ms = 10 * (M/Msun)^-2.5 * L_factor
function msLifetimeGyr(m) {
        // t_ms ~ M / L (in solar units, times 10 Gyr)
        const L = luminosityFromMass(m);
        return Math.min(15.0, Math.max(0.003, 10.0 * m / L));
}

// Salpeter IMF sample: dN/dM = M^-2.35, M in [0.08, 100].
// Inverse CDF sampling: M = M_min * u^(-1/1.35)
function sampleMassIMF(u) {
        const M_min = 0.08;
        const M_max = 100.0;
        const alpha = 2.35;
        const xMin = Math.pow(M_min, 1 - alpha);
        const xMax = Math.pow(M_max, 1 - alpha);
        const x = xMin + (xMax - xMin) * u;
        return Math.pow(x, 1 / (1 - alpha));
}

// Local age distribution (Gyr) by component + arm proximity.
// Returns sampled age. Arms: very young. Bulge/halo: old. Disc: mixed.
function sampleLocalAge(component, distToArm, R, u1, u2) {
        if (component === 'bulge') {
                // Old population: log-normal, mean ~10 Gyr, sigma ~0.3 dex
                // Box-Muller
                const z = Math.sqrt(-2 * Math.log(u1 + 1e-12)) * Math.cos(2 * Math.PI * u2);
                return Math.min(13.5, Math.exp(Math.log(10) + 0.3 * z));
        }
        if (component === 'halo') {
                const z = Math.sqrt(-2 * Math.log(u1 + 1e-12)) * Math.cos(2 * Math.PI * u2);
                return Math.min(13.5, Math.exp(Math.log(12) + 0.25 * z));
        }
        if (component === 'thick') {
                const z = Math.sqrt(-2 * Math.log(u1 + 1e-12)) * Math.cos(2 * Math.PI * u2);
                return Math.min(13.5, Math.exp(Math.log(8) + 0.4 * z));
        }
        // thin disc: depends on arm proximity
        if (distToArm < 0.5 && R > 3.0 && R < 12.0) {
                // Young population in arm: power-law, t < 0.1 Gyr typically
                return Math.pow(u1, 3.0) * 0.3; // skewed young
        }
        // Disc average: log-normal mean 5 Gyr
        const z = Math.sqrt(-2 * Math.log(u1 + 1e-12)) * Math.cos(2 * Math.PI * u2);
        return Math.min(13.5, Math.exp(Math.log(5) + 0.5 * z));
}

// Metallicity by component.
function metallicityFor(component) {
        switch (component) {
                case 'thin':  return 0.020;   // solar
                case 'thick': return 0.008;
                case 'bulge': return 0.035;   // super-solar
                case 'halo':  return 0.001;
                default:      return 0.020;
        }
}

// Derive stellar properties from position + hash seed.
// Returns { mass, age, Teff, luminosity, class, color, evolvedState,
//           component, R, phi, z, distToArm, metallicity, absMag, appMag }.
function deriveStarProps(x, y, z, seed) {
        const d = density.rhoDecomposed(x, y, z);
        const uComp = hash.hash01(seed * 31 + 7);
        const component = density.sampleComponent(d, uComp);

        // Sample mass from IMF
        const uMass = hash.hash01(seed * 31 + 1);
        const mass = sampleMassIMF(uMass);

        // Sample age
        const uAge1 = hash.hash01(seed * 31 + 2);
        const uAge2 = hash.hash01(seed * 31 + 3);
        const age = sampleLocalAge(component, d.distToArm, d.R, uAge1, uAge2);

        // MS lifetime
        const tMS = msLifetimeGyr(mass);

        let evolvedState = 'ms';
        let Teff, lum;
        if (age > tMS * 1.1 && mass < 8.0) {
                // Red giant branch / AGB
                evolvedState = 'giant';
                Teff = 3000 + 1000 * hash.hash01(seed * 31 + 4); // 3000-4000 K
                lum = 100 + 10000 * hash.hash01(seed * 31 + 5);
        } else if (age > tMS * 1.1 && mass >= 8.0) {
                // Massive star already went SN — skip and emit a young replacement
                // (in practice the procedural generator should not place O/B in old regions)
                // For experiment, emit a white dwarf remnant.
                evolvedState = 'wd';
                Teff = 8000 + 30000 * hash.hash01(seed * 31 + 4); // hot cooling WD
                lum = 0.001 + 0.1 * hash.hash01(seed * 31 + 5);
        } else {
                Teff = teffFromMass(mass);
                lum = luminosityFromMass(mass);
        }

        const cls = classifyByTempAndState(Teff, evolvedState);
        const color = classColor(cls);
        const metallicity = metallicityFor(component);

        // Absolute V magnitude from luminosity: M_V = M_Vsun - 2.5*log10(L)
        const absMag = 4.83 - 2.5 * Math.log10(Math.max(1e-6, lum));

        // Apparent magnitude from distance to Sun (in kpc → parsecs)
        const distPc = Math.sqrt(x * x + y * y + z * z) * 1000;
        const appMag = absMag + 5 * Math.log10(Math.max(1, distPc)) - 5;

        return {
                x, y, z,
                mass, age, Teff, luminosity: lum,
                class: cls,
                color,
                evolvedState,
                component,
                R: d.R, phi: d.phi, zp: d.zp,
                distToArm: d.distToArm,
                metallicity,
                absMag, appMag,
        };
}

// Summary statistics over a sample of derived stars.
function summariseByComponent(stars) {
        const byClass = {};
        const byComponent = {};
        for (const s of stars) {
                if (!byClass[s.class]) byClass[s.class] = 0;
                byClass[s.class]++;
                if (!byComponent[s.component]) byComponent[s.component] = 0;
                byComponent[s.component]++;
        }
        return { byClass, byComponent, total: stars.length };
}

// Histogram of distance-to-arm for each spectral class.
// Validates that O/B are near arms, K/M distributed.
function classVsArmDistance(stars) {
        const buckets = { O: [], B: [], A: [], F: [], G: [], K: [], M: [], RG: [], WD: [] };
        for (const s of stars) {
                if (buckets[s.class]) buckets[s.class].push(s.distToArm);
        }
        const out = {};
        for (const k of Object.keys(buckets)) {
                const arr = buckets[k];
                if (arr.length === 0) { out[k] = { n: 0, mean: 0, fracLT05: 0 }; continue; }
                const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
                const lt = arr.filter(v => v < 0.5).length;
                out[k] = { n: arr.length, mean, fracLT05: lt / arr.length };
        }
        return out;
}

if (typeof module !== 'undefined') {
        module.exports = {
                classifyByTempAndState,
                classColor,
                luminosityFromMass,
                teffFromMass,
                msLifetimeGyr,
                sampleMassIMF,
                sampleLocalAge,
                metallicityFor,
                deriveStarProps,
                summariseByComponent,
                classVsArmDistance,
        };
}
if (typeof window !== 'undefined') {
        window.StarTypesLib = {
                classifyByTempAndState, classColor,
                luminosityFromMass, teffFromMass, msLifetimeGyr,
                sampleMassIMF, sampleLocalAge, metallicityFor,
                deriveStarProps, summariseByComponent, classVsArmDistance,
        };
}
