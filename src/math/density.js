// src/math/density.js
// Analytical Milky Way density model — thin/thick disc, bulge, halo, spiral
// arms. Source of truth for the shape of the galaxy; mirrored in WGSL by
// src/render/shaders.js (density) and validated by experiments/wgsl-validate.js.
//
// Units: kpc. Coordinates: Sun at origin, X toward galactic centre (l=0),
// Y toward l=90, Z toward the north galactic pole.
//
// Amplitudes are normalised so the thin disc is 1.0. The bulge amplitude is
// chosen so the bulge holds ~20% of the disc's integrated mass, matching the
// Milky Way's bulge/disc stellar mass ratio (~1:5). See
// experiments/sampling-test.js for the measured component shares.

'use strict';

const GALACTIC_R0 = 8.178;              // Sun–centre distance, kpc (GRAVITY 2019)
const GALACTIC_CENTRE = { x: 8.178, y: 0, z: 0 };

const THIN = {
	L: 2.6,      // radial scale length, kpc
	H: 0.300,    // vertical scale height, kpc (sech^2 profile)
	amp: 1.0,
};
const THICK = {
	L: 3.5,
	H: 0.900,
	amp: 0.12,   // A_thick / A_thin
};

// Triaxial Plummer-like bulge, major axis 27 deg from the Sun–centre line.
const BULGE = {
	a: 1.5, b: 0.5, c: 0.4,   // semi-axes, kpc
	r0: 1.0,                  // Plummer scale radius, kpc
	amp: 12.0,                // central density / thin-disc peak
	tiltDeg: 27,
};

const HALO = {
	a_h: 1.0,     // core radius, kpc
	rMax: 100.0,  // truncation, kpc
	power: 3.5,
	amp: 0.0008,  // A_halo / A_thin
};

const ARMS = {
	m: 2,
	amp: 0.20,
	pitchDeg: 12,
	Rs: 3.0,      // reference radius, kpc
	phase0: 0,
};

// Truncations of the field. These are part of the model, not just a sampling
// convenience: the sampler draws each component inside these bounds, so the
// density functions apply the same cut and every derived quantity
// (dominantComponent, nebula placement, the WGSL mirror) agrees with the stars
// that are actually placed. The bulge needs it most — its Plummer tail
// (re^-5 with c = 0.4 kpc) would otherwise outweigh the halo ~12 kpc above the
// plane, a region where no bulge star is ever sampled.
const TRUNCATION = {
	discRadius: 25.0,   // kpc, max galactocentric R
	discHeight: 3.0,    // kpc, max |z|
	bulgeRadius: 6.0,   // in units of the Plummer radius
};

// Integrated (untruncated) mass of each component, in the same normalisation
// as the densities. Used as the sampling weights so a star is "from the
// population that contributed it". Spiral arms average to 1.0 over phi and so
// do not change these integrals.
//
// Integrals of the untruncated profiles; truncationFractions() in sampling.js
// converts them to the mass each component actually delivers.
//
//   thin:  2*pi*L^2 * 4H                     (sech^2 integrates to 4H)
//   thick: 2*pi*L^2 * 2H
//   bulge: a*b*c * (4/3)*pi*r0^3             (Plummer profile)
//   halo:  8*pi*a_h^3 * (1 - sqrt(a_h/rMax))
function componentMasses() {
	const thin = 2 * Math.PI * THIN.L * THIN.L * 4 * THIN.H * THIN.amp;
	const thick = 2 * Math.PI * THICK.L * THICK.L * 2 * THICK.H * THICK.amp;
	const bulge = BULGE.a * BULGE.b * BULGE.c * (4 / 3) * Math.PI * BULGE.r0 ** 3 * BULGE.amp;
	const halo = 8 * Math.PI * HALO.a_h ** 3 * (1 - Math.sqrt(HALO.a_h / HALO.rMax)) * HALO.amp;
	return { thin, thick, bulge, halo, total: thin + thick + bulge + halo };
}

// Convert Sun-centred (x, y, z) to galactocentric (R, phi, z).
function toGalactocentric(x, y, z) {
	const dx = x - GALACTIC_CENTRE.x;
	const dy = y - GALACTIC_CENTRE.y;
	return {
		R: Math.sqrt(dx * dx + dy * dy),
		phi: Math.atan2(dy, dx),
		zp: z,
	};
}

// Plummer-like ellipsoidal radius of the bulge at Sun-centred (dx, dy, dz).
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

// Thin disc: exponential in R, sech^2 in z. The R < 0.01 branch keeps the
// vertical profile intact instead of returning the midplane peak everywhere.
function insideDisc(R, z) {
	return R <= TRUNCATION.discRadius && z <= TRUNCATION.discHeight && z >= -TRUNCATION.discHeight;
}

function rhoThin(R, z) {
	if (!insideDisc(R, z)) return 0;
	const radial = R < 0.01 ? 1 : Math.exp(-R / THIN.L);
	const cosh = Math.cosh(z / (2 * THIN.H));
	return THIN.amp * radial / (cosh * cosh);
}

// Thick disc: exponential in R and |z|.
function rhoThick(R, z) {
	if (!insideDisc(R, z)) return 0;
	const radial = R < 0.01 ? 1 : Math.exp(-R / THICK.L);
	return THICK.amp * radial * Math.exp(-Math.abs(z) / THICK.H);
}

function rhoBulge(x, y, z) {
	const s = bulgeEllipsoidRadius(x - GALACTIC_CENTRE.x, y - GALACTIC_CENTRE.y, z) / BULGE.r0;
	if (s > TRUNCATION.bulgeRadius) return 0;
	return BULGE.amp * Math.pow(1 + s * s, -2.5);
}

function rhoHalo(x, y, z) {
	const dx = x - GALACTIC_CENTRE.x;
	const dy = y - GALACTIC_CENTRE.y;
	const r = Math.sqrt(dx * dx + dy * dy + z * z);
	if (r < HALO.a_h) return HALO.amp;
	return HALO.amp * Math.pow(r / HALO.a_h, -HALO.power);
}

// Spiral arm modulation of the disc: factor in [1-A, 1+A].
function armFactor(R, phi) {
	if (R < 0.5) return 1.0;
	const k = Math.tan(ARMS.pitchDeg * Math.PI / 180);
	const arg = ARMS.m * phi - k * Math.log(R / ARMS.Rs) + ARMS.phase0;
	return 1.0 + ARMS.amp * Math.cos(arg);
}

// Distance to the nearest arm ridge line (kpc). Used for young-star and
// nebula placement.
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
	return disc + rhoBulge(x, y, z) + rhoHalo(x, y, z);
}

// Per-component densities plus the derived galactocentric quantities.
function rhoDecomposed(x, y, z) {
	const gc = toGalactocentric(x, y, z);
	const arm = armFactor(gc.R, gc.phi);
	return {
		thin: rhoThin(gc.R, gc.zp) * arm,
		thick: rhoThick(gc.R, gc.zp) * arm,
		bulge: rhoBulge(x, y, z),
		halo: rhoHalo(x, y, z),
		arm,
		R: gc.R,
		phi: gc.phi,
		zp: gc.zp,
		distToArm: distanceToNearestArm(gc.R, gc.phi),
	};
}

// Label of the strongest component at a position: 'thin' | 'thick' | 'bulge' | 'halo'.
function dominantComponent(x, y, z) {
	const d = rhoDecomposed(x, y, z);
	let best = 'thin';
	let bestVal = d.thin;
	if (d.thick > bestVal) { best = 'thick'; bestVal = d.thick; }
	if (d.bulge > bestVal) { best = 'bulge'; bestVal = d.bulge; }
	if (d.halo > bestVal) { best = 'halo'; bestVal = d.halo; }
	return best;
}

// Sample which population contributed a star, weighting by the relative
// density of each component at that point. Returns the canonical index used
// by sampling and star-types: 0 thin, 1 thick, 2 bulge, 3 halo.
function sampleComponentIndex(decomposed, u) {
	const total = decomposed.thin + decomposed.thick + decomposed.bulge + decomposed.halo;
	if (total < 1e-12) return 0;
	let r = u * total;
	if ((r -= decomposed.thin) < 0) return 0;
	if ((r -= decomposed.thick) < 0) return 1;
	if ((r -= decomposed.bulge) < 0) return 2;
	return 3;
}

const COMPONENT_NAMES = ['thin', 'thick', 'bulge', 'halo'];
const COMPONENT_THIN = 0;
const COMPONENT_THICK = 1;
const COMPONENT_BULGE = 2;
const COMPONENT_HALO = 3;

const DensityLib = {
	GALACTIC_R0, GALACTIC_CENTRE,
	THIN, THICK, BULGE, HALO, ARMS, TRUNCATION,
	COMPONENT_NAMES, COMPONENT_THIN, COMPONENT_THICK, COMPONENT_BULGE, COMPONENT_HALO,
	componentMasses,
	toGalactocentric, bulgeEllipsoidRadius, insideDisc,
	rhoThin, rhoThick, rhoBulge, rhoHalo,
	armFactor, distanceToNearestArm,
	rhoTotal, rhoDecomposed, dominantComponent, sampleComponentIndex,
};
if (typeof module !== 'undefined') module.exports = DensityLib;
if (typeof window !== 'undefined') window.DensityLib = DensityLib;
