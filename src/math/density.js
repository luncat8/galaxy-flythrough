// src/math/density.js
// The analytical galaxy density field: thin/thick disc, spheroid, halo and the
// spiral-arm modulation — evaluated for a GalaxyModel (src/math/galaxy.js),
// never for one hard-coded galaxy. Source of truth for the shape of the galaxy;
// mirrored in WGSL by src/render/shaders.js (density) and validated by
// experiments/wgsl-validate.js (struct + formula contract) and
// experiments/wgsl-exec-check.js (numeric parity through the real WGSL).
//
// Units: kpc. Coordinates: the model's world frame. `model.centre` is the
// galactocentric origin, so every function here subtracts it rather than
// assuming the Sun sits at the origin. The Milky Way preset is the Sun-centred
// frame (centre at +X); every other type puts the centre at (0, 0, 0).
//
// Amplitudes are density ratios against the Milky Way's thin-disc peak, which is
// the unit the whole model is normalised to. That keeps every absolute threshold
// in the pipeline (nebula suppression, the compute path's expected counts) on
// the same scale for every type; the type's mass level comes from
// `populations`/`massTotal` in the descriptor, not from a rescaled unit.
//
// The component names stay 'thin', 'thick', 'bulge', 'halo' for all types: index
// 2 is the *spheroid* slot, called `bulge` because that is what it holds in a
// spiral. Renaming it would churn the record format, the tests and the WGSL for
// no behavioural gain.

'use strict';

const COMPONENT_NAMES = ['thin', 'thick', 'bulge', 'halo'];
const COMPONENT_THIN = 0;
const COMPONENT_THICK = 1;
const COMPONENT_BULGE = 2;
const COMPONENT_HALO = 3;

// Spheroid profile selector. `profile` is the authored string, `profileId` the
// value the hot path and the packed uniform compare against.
const PROFILE_PLUMMER = 0;
const PROFILE_SERSIC = 1;
const PROFILE_BAR = 2;
const PROFILES = ['plummer', 'sersic', 'bar'];

// Sérsic b_n, the standard approximation (Ciotti & Bertin 1999), accurate to
// ~0.1% for n >= 0.36 — every n in the type table is >= 1.
function sersicBn(n) {
	return 2 * n - 1 / 3;
}

// ln Γ(x), Lanczos g=7. Used once per model build, never per star.
function logGamma(x) {
	const C = [
		0.99999999999980993, 676.5203681218851, -1259.1392167224028,
		771.32342877765313, -176.61502916214059, 12.507343278686905,
		-0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
	];
	if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
	const z = x - 1;
	let a = C[0];
	const t = z + 7.5;
	for (let i = 1; i < 9; i++) a += C[i] / (z + i);
	return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

// Lower incomplete gamma γ(a, x), series form. The sersic mass integral needs
// it at a = 3n (12 for n = 4) with x below a + 1 at the truncation, where the
// series converges in a few dozen terms.
function lowerGamma(a, x) {
	if (!(x > 0)) return 0;
	let term = 1 / a;
	let sum = term;
	for (let k = 1; k < 200; k++) {
		term *= x / (a + k);
		const next = sum + term;
		if (next === sum) break;
		sum = next;
	}
	return Math.exp(a * Math.log(x) - x) * sum;
}

// ---- geometry -------------------------------------------------------------

// World → galactocentric cylindrical.
function toGalactocentric(model, x, y, z) {
	const c = model.centre;
	const dx = x - c.x;
	const dy = y - c.y;
	return {
		R: Math.sqrt(dx * dx + dy * dy),
		phi: Math.atan2(dy, dx),
		zp: z - c.z,
	};
}

// Spheroid radius in units of the semiaxes, then of `r0` — the `s` every
// spheroid profile is written in. Triaxial, rotated by tiltDeg in the plane.
function spheroidEllipsoidRadius(model, dx, dy, dz) {
	const sp = model.spheroid;
	const t = sp.tiltDeg * Math.PI / 180;
	const ct = Math.cos(t);
	const st = Math.sin(t);
	const xrot = dx * ct + dy * st;
	const yrot = -dx * st + dy * ct;
	const r2 = (xrot * xrot) / (sp.a * sp.a)
		+ (yrot * yrot) / (sp.b * sp.b)
		+ (dz * dz) / (sp.c * sp.c);
	return Math.sqrt(r2) / sp.r0;
}

// Disc truncation. Arms and both discs share it, as in the model.
function insideDisc(model, R, z) {
	const t = model.truncation;
	return R <= t.discRadius && z <= t.discHeight && z >= -t.discHeight;
}

// ---- components -----------------------------------------------------------

// Thin disc: exponential in R, sech^2 in z.
function rhoThin(model, R, z) {
	if (!insideDisc(model, R, z)) return 0;
	const p = model.thin;
	const flare = p.flare || 0;
	const H = p.H * (1 + flare * R / p.L);
	let radial = Math.exp(-R / p.L);
	if (p.coreRadius) {
		radial *= R / Math.sqrt(R * R + p.coreRadius * p.coreRadius);
	}
	// sech² via a decaying exponential avoids cosh overflow for thin discs.
	const e = Math.exp(-Math.abs(z) / H);
	return p.amp * radial * 4 * e / ((1 + e) * (1 + e));
}

// Thick disc: exponential in R and |z|.
function rhoThick(model, R, z) {
	if (!insideDisc(model, R, z)) return 0;
	const p = model.thick;
	const flare = p.flare || 0;
	const H = p.H * (1 + flare * R / p.L);
	let radial = Math.exp(-R / p.L);
	if (p.coreRadius) {
		radial *= R / Math.sqrt(R * R + p.coreRadius * p.coreRadius);
	}
	return p.amp * radial * Math.exp(-Math.abs(z) / H);
}

// The spheroid: Plummer (what a spiral's bulge is), Sérsic (E/S0 body) or
// Bar (boxy/peanut bulge). Truncated at `truncation.spheroidRadius` in units of s.
function rhoSpheroid(model, x, y, z) {
	const sp = model.spheroid;
	if (sp.profileId === PROFILE_BAR) {
		const dx = x - model.centre.x;
		const dy = y - model.centre.y;
		const dz = z - model.centre.z;
		const t = sp.tiltDeg * Math.PI / 180;
		const ct = Math.cos(t);
		const st = Math.sin(t);
		const xrot = dx * ct + dy * st;
		const yrot = -dx * st + dy * ct;
		const n = sp.n || 2.5;
		const ax = Math.abs(xrot / sp.a);
		const ay = Math.abs(yrot / sp.b);
		const az = Math.abs(dz / sp.c);
		const s = Math.pow(Math.pow(ax, n) + Math.pow(ay, n) + Math.pow(az, n), 1 / n) / sp.r0;
		if (s > model.truncation.spheroidRadius) return 0;
		return sp.amp * Math.exp(-s);
	}
	const s = spheroidEllipsoidRadius(model, x - model.centre.x, y - model.centre.y, z - model.centre.z);
	if (s > model.truncation.spheroidRadius) return 0;
	if (sp.profileId === PROFILE_SERSIC) {
		return sp.amp * Math.exp(-sersicBn(sp.n) * (Math.pow(s, 1 / sp.n) - 1));
	}
	return sp.amp * Math.pow(1 + s * s, -2.5);
}

// Power-law halo with a flat core inside a_h.
function rhoHalo(model, x, y, z) {
	const h = model.halo;
	const dx = x - model.centre.x;
	const dy = y - model.centre.y;
	const dz = z - model.centre.z;
	const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
	if (r > h.rMax) return 0;
	if (r < h.a_h) return h.amp;
	return h.amp * Math.pow(r / h.a_h, -h.power);
}

// Hash noise for 2D log-spiral FBM noise in flocculent arms.
function hash2DNoise(u, v, seed) {
	const iu = Math.floor(u) | 0;
	const iv = Math.floor(v) | 0;
	const fu = u - iu;
	const fv = v - iv;
	const su = fu * fu * (3 - 2 * fu);
	const sv = fv * fv * (3 - 2 * fv);
	const h = (x, y) => {
		const x8 = (x & 0xff) >>> 0;
		const y8 = (y & 0xff) >>> 0;
		const s8 = (seed & 0xff) >>> 0;
		const h1 = (x8 * 1597 + y8 * 2869 + s8 * 3671) & 0xffff;
		const h2 = (((h1 & 0xff) * 2869 + ((h1 >> 8) & 0xff) * 1597 + ((seed >> 8) & 0xffff))) & 0xffff;
		return (h2 / 65535.0) * 2.0 - 1.0;
	};
	const n00 = h(iu, iv);
	const n10 = h(iu + 1, iv);
	const n01 = h(iu, iv + 1);
	const n11 = h(iu + 1, iv + 1);
	const nx0 = n00 + su * (n10 - n00);
	const nx1 = n01 + su * (n11 - n01);
	return nx0 + sv * (nx1 - nx0);
}

function fbm2D(u, v, seed) {
	const n1 = hash2DNoise(u, v, seed);
	const n2 = hash2DNoise(u * 2, v * 2, seed + 1);
	const n3 = hash2DNoise(u * 4, v * 4, seed + 2);
	return (n1 + 0.5 * n2 + 0.25 * n3) / 1.75;
}

// Clump factor for irregular galaxies (Irr).
function clumpFactor(model, x, y, z) {
	if (!model.clumps || model.clumps.length === 0) return 1.0;
	let sum = 1.0;
	for (let i = 0; i < model.clumps.length; i++) {
		const c = model.clumps[i];
		const dx = x - c.x;
		const dy = y - c.y;
		const dz = z - c.z;
		const d2 = dx * dx + dy * dy + dz * dz;
		sum += c.boost * Math.exp(-d2 / (2 * c.r * c.r));
	}
	return sum;
}

// Spiral arm modulation of the disc: factor in [1-A, 1+A]. `amp` 0 or `m` 0 is
// a smooth disc, which is how S0 and the E types read.
function armFactor(model, R, phi) {
	const a = model.arms;
	if (a.amp === 0 || a.m === 0 || R < a.minRadius) return 1.0;
	const k = Math.tan(a.pitchDeg * Math.PI / 180);
	const arg = a.m * phi - k * Math.log(R / a.Rs) + a.phase0;
	const grandDesign = Math.cos(arg);
	if (a.flocculence > 0) {
		const u = 2.0 * Math.log(R / a.Rs);
		const v = arg / Math.PI;
		const fbm = fbm2D(u, v, model.seed || 42);
		const combined = (1.0 - a.flocculence) * grandDesign + a.flocculence * fbm;
		return 1.0 + a.amp * combined;
	}
	return 1.0 + a.amp * grandDesign;
}

// Distance to the nearest arm ridge line (kpc). Used for young-star and nebula
// placement. With no arm pattern there is no ridge: the answer is "nowhere",
// which is what keeps young stars and gas nebulae off a smooth disc.
function distanceToNearestArm(model, R, phi) {
	const a = model.arms;
	if (a.amp === 0 || a.m === 0 || R < a.minRadius) return 99;
	const k = Math.tan(a.pitchDeg * Math.PI / 180);
	let best = 99;
	for (let n = 0; n < a.m; n++) {
		const phiArm = (k * Math.log(R / a.Rs) - a.phase0 + 2 * Math.PI * n) / a.m;
		let dphi = phi - phiArm;
		while (dphi > Math.PI) dphi -= 2 * Math.PI;
		while (dphi < -Math.PI) dphi += 2 * Math.PI;
		const dArc = R * Math.abs(dphi);
		if (dArc < best) best = dArc;
	}
	return best;
}

// ---- integrals -------------------------------------------------------------

// Amp-free mass integral of each component, in the same normalisation as the
// densities. The spiral arms average to 1.0 over phi and so do not enter.
//
//   thin:    2*pi*L^2 * 4H                (sech^2 integrates to 4H)
//   thick:   2*pi*L^2 * 2H
//   spheroid: plummer a*b*c*(4/3)*pi*r0^3
//             sersic  4*pi*a*b*c*r0^3 * e^b_n * n * b_n^-3n * Gamma(3n)
//   halo:    4*pi*a_h^3 * haloRadialMass(rMax)   (core + power law)
//
// Halo integral in units of 4*pi*a_h^3, including the flat core.
function haloRadialMass(model, radius) {
	const h = model.halo;
	const x = Math.min(radius, h.rMax) / h.a_h;
	if (x <= 1) return x * x * x / 3;
	const q = 3 - h.power;
	return 1 / 3 + (q === 0 ? Math.log(x) : Math.expm1(q * Math.log(x)) / q);
}

function barMassFraction(model, s) {
	return 1 - (1 + s + 0.5 * s * s) * Math.exp(-s);
}

function barRadiusForFraction(model, u) {
	const sMax = model.truncation.spheroidRadius;
	const total = barMassFraction(model, sMax);
	let lo = 0;
	let hi = sMax;
	for (let i = 0; i < 32; i++) {
		const mid = 0.5 * (lo + hi);
		if (barMassFraction(model, mid) < u * total) lo = mid; else hi = mid;
	}
	return 0.5 * (lo + hi);
}

function massIntegrals(model) {
	const discIntegral = (p, vertical) => 2 * Math.PI * p.L * p.L * vertical;
	const sp = model.spheroid;
	const axes = sp.a * sp.b * sp.c * sp.r0 * sp.r0 * sp.r0;
	const ah = model.halo.a_h;
	const bn = sersicBn(sp.n);
	let bulgeIntegral;
	if (sp.profileId === PROFILE_BAR) {
		bulgeIntegral = 8 * Math.PI * axes * 0.88;
	} else if (sp.profileId === PROFILE_SERSIC) {
		bulgeIntegral = 4 * Math.PI * axes * Math.exp(bn) * sp.n * Math.pow(bn, -3 * sp.n) * Math.exp(logGamma(3 * sp.n));
	} else {
		bulgeIntegral = axes * (4 / 3) * Math.PI;
	}
	return {
		thin: discIntegral(model.thin, 4 * model.thin.H),
		thick: discIntegral(model.thick, 2 * model.thick.H),
		bulge: bulgeIntegral,
		halo: 4 * Math.PI * ah * ah * ah * haloRadialMass(model, model.halo.rMax),
	};
}

// Integrated (untruncated) mass of each component. These are the weights the
// sampler draws populations with, so a star is "from the population that
// contributed it".
function componentMasses(model) {
	const i = massIntegrals(model);
	const thin = i.thin * model.thin.amp;
	const thick = i.thick * model.thick.amp;
	const bulge = i.bulge * model.spheroid.amp;
	const halo = i.halo * model.halo.amp;
	return { thin, thick, bulge, halo, total: thin + thick + bulge + halo };
}

// Fraction of each component's untruncated mass that lies inside the truncated
// volume the sampler draws from.
function truncationFractions(model) {
	const t = model.truncation;
	const discRadial = (L) => 1 - (1 + t.discRadius / L) * Math.exp(-t.discRadius / L);
	const sp = model.spheroid;
	const sMax = t.spheroidRadius;
	let bulge;
	if (sp.profileId === PROFILE_BAR) {
		bulge = barMassFraction(model, sMax);
	} else if (sp.profileId === PROFILE_SERSIC) {
		const bn = sersicBn(sp.n);
		const a = 3 * sp.n;
		bulge = lowerGamma(a, bn * Math.pow(sMax, 1 / sp.n)) / Math.exp(logGamma(a));
	} else {
		bulge = Math.pow(sMax, 3) / Math.pow(1 + sMax * sMax, 1.5);
	}
	return {
		thin: model.thin.amp > 0 ? discRadial(model.thin.L) * Math.tanh(t.discHeight / (2 * model.thin.H)) : 0,
		thick: model.thick.amp > 0 ? discRadial(model.thick.L) * (1 - Math.exp(-t.discHeight / model.thick.H)) : 0,
		bulge: model.spheroid.amp > 0 ? bulge : 0,
		halo: model.halo.amp > 0 ? 1 : 0,   // rMax is part of the distribution, not a truncation of it
	};
}

// ---- spheroid sampling helpers --------------------------------------------
// The sersic enclosed mass is M(<s) ∝ γ(3n, b_n·s^(1/n)); the sampler inverts
// it by bisection against these two functions, so the stars and the field agree
// exactly rather than to within a rejection sampler's acceptance bias.

function sersicMassFraction(model, s) {
	const sp = model.spheroid;
	const bn = sersicBn(sp.n);
	return lowerGamma(3 * sp.n, bn * Math.pow(s, 1 / sp.n));
}

// Radius (in units of s) enclosing mass fraction u of the truncated body.
// 32 deterministic bisection steps, the same contract sampleDiscRadius uses.
function sersicRadiusForFraction(model, u) {
	const sMax = model.truncation.spheroidRadius;
	const total = sersicMassFraction(model, sMax);
	let lo = 0;
	let hi = sMax;
	for (let i = 0; i < 32; i++) {
		const mid = 0.5 * (lo + hi);
		if (sersicMassFraction(model, mid) < u * total) lo = mid; else hi = mid;
	}
	return 0.5 * (lo + hi);
}

// ---- combined --------------------------------------------------------------

// Combined stellar density at world (x, y, z).
function rhoTotal(model, x, y, z) {
	const gc = toGalactocentric(model, x, y, z);
	const arm = armFactor(model, gc.R, gc.phi);
	const disc = (rhoThin(model, gc.R, gc.zp) + rhoThick(model, gc.R, gc.zp)) * arm;
	const base = disc + rhoSpheroid(model, x, y, z) + rhoHalo(model, x, y, z);
	return base * clumpFactor(model, x, y, z);
}

// Per-component densities plus the derived galactocentric quantities.
function rhoDecomposed(model, x, y, z, includeClumps = true) {
	const gc = toGalactocentric(model, x, y, z);
	const arm = armFactor(model, gc.R, gc.phi);
	const cf = includeClumps ? clumpFactor(model, x, y, z) : 1.0;
	return {
		thin: rhoThin(model, gc.R, gc.zp) * arm * cf,
		thick: rhoThick(model, gc.R, gc.zp) * arm * cf,
		bulge: rhoSpheroid(model, x, y, z) * cf,
		halo: rhoHalo(model, x, y, z) * cf,
		arm,
		R: gc.R,
		phi: gc.phi,
		zp: gc.zp,
		distToArm: distanceToNearestArm(model, gc.R, gc.phi),
	};
}

// Label of the strongest component at a position: 'thin' | 'thick' | 'bulge' | 'halo'.
function dominantComponent(model, x, y, z) {
	const d = rhoDecomposed(model, x, y, z);
	let best = 'thin';
	let bestVal = d.thin;
	if (d.thick > bestVal) { best = 'thick'; bestVal = d.thick; }
	if (d.bulge > bestVal) { best = 'bulge'; bestVal = d.bulge; }
	if (d.halo > bestVal) { best = 'halo'; bestVal = d.halo; }
	return best;
}

// Sample which population contributed a star, weighting by the relative
// density of each component at that point. Returns the canonical index used by
// sampling and star-types: 0 thin, 1 thick, 2 spheroid, 3 halo.
function sampleComponentIndex(decomposed, u) {
	const total = decomposed.thin + decomposed.thick + decomposed.bulge + decomposed.halo;
	if (total < 1e-12) return COMPONENT_THIN;
	let r = u * total;
	if ((r -= decomposed.thin) < 0) return COMPONENT_THIN;
	if ((r -= decomposed.thick) < 0) return COMPONENT_THICK;
	if ((r -= decomposed.bulge) < 0) return COMPONENT_BULGE;
	return COMPONENT_HALO;
}

const DensityLib = {
	COMPONENT_NAMES, COMPONENT_THIN, COMPONENT_THICK, COMPONENT_BULGE, COMPONENT_HALO,
	PROFILES, PROFILE_PLUMMER, PROFILE_SERSIC, PROFILE_BAR,
	sersicBn, logGamma, lowerGamma,
	componentMasses, massIntegrals, truncationFractions, haloRadialMass,
	toGalactocentric, spheroidEllipsoidRadius, insideDisc,
	rhoThin, rhoThick, rhoSpheroid, rhoHalo,
	armFactor, distanceToNearestArm,
	sersicMassFraction, sersicRadiusForFraction, barMassFraction, barRadiusForFraction,
	rhoTotal, rhoDecomposed, dominantComponent, sampleComponentIndex,
};
if (typeof module !== 'undefined') module.exports = DensityLib;
if (typeof window !== 'undefined') window.DensityLib = DensityLib;
