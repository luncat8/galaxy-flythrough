// experiments/lib/density.js
// Analytical Milky Way density model — thin/thick disc, bulge, halo, spiral arms.
// Mirrors what will eventually be evaluated in WGSL.
//
// All units: kpc for length. Returns normalised density (peak ≈ 1.0).
// Coordinate system: Sun at origin, X toward galactic centre (l=0), Y toward l=90, Z north.
// Galactic centre is at (-8.178, 0, 0).

'use strict';

const GALACTIC_R0 = 8.178;     // Sun-centre distance, kpc (GRAVITY 2019)
// Sun-centred coordinates with X pointing toward l=0 (galactic centre direction).
// So the galactic centre is at +8.178 on the X axis.
const GALACTIC_CENTRE = { x: 8.178, y: 0, z: 0 };

// Disc parameters (see plan.md section 4)
const THIN = {
        L: 2.6,    // radial scale length, kpc
        H: 0.300, // vertical scale height, kpc (used with sech^2)
        amp: 1.0,
};
const THICK = {
        L: 3.5,
        H: 0.900,
        amp: 0.12,
};

// Bulge: triaxial Plummer-like, oriented 27 degrees from Sun-centre line
const BULGE = {
        a: 1.5, b: 0.5, c: 0.4,        // kpc semi-axes
        r0: 0.5,                       // Plummer scale
        amp: 0.65,
        tiltDeg: 27,
};

// Halo: power law
const HALO = {
        a_h: 1.0,
        power: 3.5,
        amp: 0.0008,
};

// Spiral arms: m=2 logarithmic, pitch angle 12 degrees
const ARMS = {
        m: 2,
        amp: 0.20,
        pitchDeg: 12,
        Rs: 3.0,    // reference radius, kpc
        phase0: 0,
};

// Convert (x, y, z) Sun-centred to galactocentric (R, phi, z').
function toGalactocentric(x, y, z) {
        const dx = x - GALACTIC_CENTRE.x;
        const dy = y - GALACTIC_CENTRE.y;
        const R = Math.sqrt(dx * dx + dy * dy);
        const phi = Math.atan2(dy, dx);
        return { R, phi, zp: z };
}

// Bulge uses tilted triaxial ellipsoid: rotate (dx, dy) by bulge tilt around Z.
function bulgeEllipsoidRadius(dx, dy, dz) {
        const t = BULGE.tiltDeg * Math.PI / 180;
        const ct = Math.cos(t);
        const st = Math.sin(t);
        const xrot = dx * ct + dy * st;
        const yrot = -dx * st + dy * ct;
        const r2 = (xrot * xrot) / (BULGE.a * BULGE.a)
                + (yrot * yrot) / (BULGE.b * BULGE.b)
                + (dz * dz) / (BULGE.c * BULGE.c);
        return Math.sqrt(r2);
}

function rhoThin(R, z) {
        if (R < 0.01) return THIN.amp;
        return THIN.amp * Math.exp(-R / THIN.L) / Math.cosh(z / (2 * THIN.H)) ** 2;
}

function rhoThick(R, z) {
        if (R < 0.01) return THICK.amp;
        return THICK.amp * Math.exp(-R / THICK.L) * Math.exp(-Math.abs(z) / THICK.H);
}

function rhoBulge(x, y, z) {
        const dx = x - GALACTIC_CENTRE.x;
        const dy = y - GALACTIC_CENTRE.y;
        const dz = z;
        const re = bulgeEllipsoidRadius(dx, dy, dz);
        return BULGE.amp * Math.pow(1 + (re / BULGE.r0) ** 2, -2.5);
}

function rhoHalo(x, y, z) {
        const dx = x - GALACTIC_CENTRE.x;
        const dy = y - GALACTIC_CENTRE.y;
        const dz = z;
        const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (r < HALO.a_h) return HALO.amp;
        return HALO.amp * Math.pow(r / HALO.a_h, -HALO.power);
}

// Spiral arm modulation: multiplicative on disc density.
// Returns factor in [1-A, 1+A].
function armFactor(R, phi) {
        if (R < 0.5) return 1.0;
        const k = Math.tan(ARMS.pitchDeg * Math.PI / 180);
        const arg = ARMS.m * phi - k * Math.log(R / ARMS.Rs) + ARMS.phase0;
        return 1.0 + ARMS.amp * Math.cos(arg);
}

// Distance to nearest spiral arm (kpc). Useful for young-star/nebula placement.
function distanceToNearestArm(R, phi) {
        if (R < 0.5) return 99;
        const k = Math.tan(ARMS.pitchDeg * Math.PI / 180);
        let best = 99;
        for (let n = 0; n < ARMS.m; n++) {
                const phiArm = (k * Math.log(R / ARMS.Rs) + 2 * Math.PI * n) / ARMS.m;
                let dphi = phi - phiArm;
                while (dphi > Math.PI) dphi -= 2 * Math.PI;
                while (dphi < -Math.PI) dphi += 2 * Math.PI;
                const dArc = R * Math.abs(dphi);
                if (dArc < best) best = dArc;
        }
        return best;
}

// Combined stellar density at Sun-centred (x, y, z).
function rhoTotal(x, y, z) {
        const gc = toGalactocentric(x, y, z);
        const arm = armFactor(gc.R, gc.phi);
        const disc = (rhoThin(gc.R, gc.zp) + rhoThick(gc.R, gc.zp)) * arm;
        const bulge = rhoBulge(x, y, z);
        const halo = rhoHalo(x, y, z);
        return disc + bulge + halo;
}

// Decomposed: returns each component separately (useful for population assignment).
function rhoDecomposed(x, y, z) {
        const gc = toGalactocentric(x, y, z);
        const arm = armFactor(gc.R, gc.phi);
        return {
                thin: rhoThin(gc.R, gc.zp) * arm,
                thick: rhoThick(gc.R, gc.zp) * arm,
                bulge: rhoBulge(x, y, z),
                halo: rhoHalo(x, y, z),
                arm: arm,
                R: gc.R,
                phi: gc.phi,
                zp: gc.zp,
                distToArm: distanceToNearestArm(gc.R, gc.phi),
        };
}

// Component label at a position - used to assign stellar population.
// 'thin', 'thick', 'bulge', 'halo'.
function dominantComponent(x, y, z) {
        const d = rhoDecomposed(x, y, z);
        let best = 'thin';
        let bestVal = d.thin;
        if (d.thick > bestVal) { best = 'thick'; bestVal = d.thick; }
        if (d.bulge > bestVal) { best = 'bulge'; bestVal = d.bulge; }
        if (d.halo > bestVal) { best = 'halo'; bestVal = d.halo; }
        return best;
}

// Sample a component probabilistically by relative density contribution.
// A star near the centre might be 55% thin, 35% bulge, 10% thick, 0% halo -
// we sample which population it actually belongs to.
function sampleComponent(decomposed, u) {
        const total = decomposed.thin + decomposed.thick + decomposed.bulge + decomposed.halo;
        if (total < 1e-12) return 'thin';
        let r = u * total;
        if ((r -= decomposed.thin) < 0) return 'thin';
        if ((r -= decomposed.thick) < 0) return 'thick';
        if ((r -= decomposed.bulge) < 0) return 'bulge';
        return 'halo';
}

if (typeof module !== 'undefined') {
        module.exports = {
                GALACTIC_R0,
                GALACTIC_CENTRE,
                THIN, THICK, BULGE, HALO, ARMS,
                toGalactocentric,
                rhoThin, rhoThick, rhoBulge, rhoHalo,
                armFactor, distanceToNearestArm,
                rhoTotal, rhoDecomposed, dominantComponent, sampleComponent,
        };
}
if (typeof window !== 'undefined') {
        window.DensityLib = {
                GALACTIC_R0, GALACTIC_CENTRE,
                THIN, THICK, BULGE, HALO, ARMS,
                toGalactocentric,
                rhoThin, rhoThick, rhoBulge, rhoHalo,
                armFactor, distanceToNearestArm,
                rhoTotal, rhoDecomposed, dominantComponent, sampleComponent,
        };
}
