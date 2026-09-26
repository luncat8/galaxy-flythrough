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

// Flared scale height H(R) = H(1 + flare*R/L), and the soft-core radial
// factor R/sqrt(R^2 + c^2) (1 without a core). These helpers are shared by
// the field's mass integrals and sampling's radial CDF, so a flare or core
// cannot silently change the distribution in only one consumer.
function discHeightAt(group, R) {
	return group.H * (1 + (group.flare || 0) * (R / group.L));
}

function discRadialFactor(group, R) {
	const c = group.coreRadius || 0;
	if (c === 0) return Math.exp(-R / group.L);
	return Math.exp(-R / group.L) * R / Math.sqrt(R * R + c * c);
}

// The vertical mass of one profile column at radius R: the z-integral of the
// profile, truncated or not. `kind` is 'sech2' for the thin disc and 'laplace'
// for the thick disc. A non-finite height means the full vertical integral.
function discVerticalMass(group, R, zMax, kind) {
	const H = discHeightAt(group, R);
	if (kind === 'laplace') {
		return zMax === Infinity ? 2 * H : 2 * H * (1 - Math.exp(-zMax / H));
	}
	return zMax === Infinity ? 4 * H : 4 * H * Math.tanh(zMax / (2 * H));
}

// Amp-free radial marginal of a disc. The radial CDF must include the
// vertical integral because flaring makes that factor depend on R.
function discRadialWeight(group, R, zMax, kind) {
	if (!(R >= 0)) return 0;
	return R * discRadialFactor(group, R) * discVerticalMass(group, R, zMax, kind);
}

// Fixed Simpson quadrature is setup-time work only. It is used for a core or a
// finite truncation, where the closed exponential integral is no longer exact.
function integrateDiscRadial(group, radius, zMax, kind) {
	if (!(radius > 0)) return 0;
	const flare = group.flare || 0;
	const core = group.coreRadius || 0;
	const full = radius === Infinity;
	if (!core && full) {
		const vertical = kind === 'laplace' ? 2 : 4;
		return 2 * Math.PI * vertical * group.H * group.L * group.L * (1 + 2 * flare);
	}
	if (!core && !flare) {
		const vertical = kind === 'laplace' ? 2 : 4;
		const radial = 1 - (1 + radius / group.L) * Math.exp(-radius / group.L);
		const height = zMax === Infinity ? 1 : (kind === 'laplace'
			? 1 - Math.exp(-zMax / group.H)
			: Math.tanh(zMax / (2 * group.H)));
		return 2 * Math.PI * vertical * group.H * group.L * group.L * radial * height;
	}
	const upper = full ? Math.max(32 * group.L, 8 * core) : radius;
	const steps = 1024;
	const h = upper / steps;
	let sum = discRadialWeight(group, 0, zMax, kind) + discRadialWeight(group, upper, zMax, kind);
	for (let i = 1; i < steps; i++) {
		const weight = discRadialWeight(group, i * h, zMax, kind);
		sum += (i & 1) === 0 ? 2 * weight : 4 * weight;
	}
	return 2 * Math.PI * h * sum / 3;
}

// Thin disc: exponential in R (soft core optional), sech^2 in z, flaring.
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

// ---- the bar (boxy/peanut inner part + exponential end caps) --------------
//
// The bar is the one spheroid profile with a boundary of its own, so it is
// written in its own frame, in units of the r0-scaled axes:
//
//   xi = x_b / (a*r0),  eta = y_b / (b*r0),  zeta = z_b / (c*r0)
//   P(xi) = 1 + peanut*xi^2                    (the peanut: thicker toward the ends)
//   tau(xi)^n = tip^n - |xi|^n                 (the boxy cross-section, tapering to
//                                               a point at the bar's end)
//
// and the density is the *slice profile* of that cross-section, not a constant:
//
//   u = eta / tau(xi),  v = zeta / (P(xi)*tau(xi))     slice coordinates
//   T(u, v) = (1 - |u|^n - |v|^cv)^q                   inside |u|^n + |v|^cv <= 1
//   rho_bar = amp * L(xi) * T(u, v)
//
// `n` is the in-plane boxiness (a boxy superellipse in the face-on plane), `cv`
// the *vertical* profile exponent — the authored `bar.vertical` — and `q` the
// interior falloff (BAR_SLICE_FALLOFF). The envelope is the same bar body as
// before: it still tapers to a point at |xi| = tip and its vertical half-extent
// is still P(xi)*tau(xi) on the major axis. What changes is that the density
// falls off *inside* the envelope instead of filling it. A bar seen edge-on is a
// smooth, vertically extended boxy/peanut structure, not a flat-topped slab with
// a rim: the Milky Way's bar falls off roughly exponentially along its principal
// axes (scale lengths 0.70 : 0.44 : 0.18 kpc, Wegg 2014 arXiv:1408.0219), its
// vertical profile is sech^2-like rather than flat (Wegg et al. 2015, MNRAS 450,
// 4050), and the vertical scale height grows toward the ends of the boxy/peanut
// region — the "peanut height function", here P(xi) (Tahmasebzadeh et al. 2023,
// arXiv:2309.11557 eq. 6; Fragkoudi et al. 2015).
//
// q >= 1 makes T reach zero at the envelope with zero slope, so the body has no
// visible edge; q = 0 reproduces the uniform slab this replaces, and cv = n with
// q = 0 is exactly the old field (the identity barSliceMass -> lnDiskArea).
//
// Because T is a fixed shape scaled by (tau, P*tau), a slice's mass is
// L(xi)*P(xi)*tau(xi)^2 times a constant — the weight the longitudinal sampler
// already integrates — so the xi CDF, the tip and the truncation fractions are
// untouched, and sampling.js inverts the slice in one pass:
// p(u) ~ (1-|u|^n)^(q + 1/cv) then p(w) ~ (1-w^cv)^q for the scaled v.
//
// A model that has no bar carries BAR_NONE; it is never read, because this
// profile is only reached when profileId is PROFILE_BAR.

const BAR_NONE = { peanut: 0, endCap: 1, plateau: 1, vertical: 2 };
// Interior falloff of the slice profile. 1.5 keeps a bar reading as a solid body
// with a smooth edge: below ~1 the slice is flat-topped again, above ~3 it is a
// thin spike and the bar's mass collapses into a needle.
const BAR_SLICE_FALLOFF = 1.5;
// Fixed Simpson quadrature, the same 1024-bin contract the disc radial integral
// uses: the field's mass and the sampler's CDF agree by construction.
const BAR_RADIAL_STEPS = 1024;

// The vertical profile exponent of a model's bar, defaulted for the models that
// carry BAR_NONE and for a partial override that never touches the field.
function barVerticalExponent(model) {
	const cv = model.bar.vertical;
	return cv > 0 ? cv : 2;
}

// The slice profile T(u, v) — one formula for the field, the sampler's tables
// and the tests. Symmetric in both coordinates, zero outside the envelope.
function barSliceProfile(model, u, v) {
	const n = model.spheroid.n;
	const m = Math.pow(Math.abs(u), n) + Math.pow(Math.abs(v), barVerticalExponent(model));
	if (!(m < 1)) return 0;
	return Math.pow(1 - m, BAR_SLICE_FALLOFF);
}

// Marginal of the slice over u: the v integral at fixed u is
// K*(1-|u|^n)^q*(1-|u|^n)^(1/cv), so p(u) ~ (1-|u|^n)^(q + 1/cv). The sampler's
// u table and the tests read this.
function barSliceUMarginal(model, u) {
	const a = Math.abs(u);
	if (!(a < 1)) return 0;
	return Math.pow(1 - Math.pow(a, model.spheroid.n), BAR_SLICE_FALLOFF + 1 / barVerticalExponent(model));
}

// Conditional of the slice along v, in the coordinate w = v/V(u) scaled by the
// slice's own v half-extent V = (1-|u|^n)^(1/cv) — which makes it independent of
// u: p(w) ~ (1 - w^cv)^q on [0, 1]. One table therefore serves every slice.
function barSliceWMarginal(model, w) {
	const a = Math.abs(w);
	if (!(a < 1)) return 0;
	return Math.pow(1 - Math.pow(a, barVerticalExponent(model)), BAR_SLICE_FALLOFF);
}

// Closed-form slice mass, m_slice = integral of T over the slice plane:
//
//   m_slice = 4 * Ku * Kv,
//   Kv = (1/cv) * B(1/cv, q+1),  Ku = (1/n) * B(1/n, q + 1/cv + 1)
//
// i.e. four quadrants times the w-integral times the u-integral. q = 0 with
// cv = n reduces it to lnDiskArea(n), the uniform slab's slice mass.
function barSliceMass(model) {
	const n = model.spheroid.n;
	const c = barVerticalExponent(model);
	const q = BAR_SLICE_FALLOFF;
	const kv = Math.exp(logGamma(1 / c) + logGamma(q + 1) - logGamma(q + 1 + 1 / c)) / c;
	const ku = Math.exp(logGamma(1 / n) + logGamma(q + 1 / c + 1) - logGamma(q + 1 / c + 1 + 1 / n)) / n;
	return 4 * kv * ku;
}

// Area of the unit L^n disk in 2D: 4*Gamma(1+1/n)^2 / Gamma(1+2/n). The uniform
// slab's slice mass — the q = 0 case. It stays because the identity with
// barSliceMass at q = 0, cv = n is what pins the generalisation.
function lnDiskArea(n) {
	return 4 * Math.exp(2 * logGamma(1 + 1 / n) - logGamma(1 + 2 / n));
}

// Where the bar's body ends: |xi| = 1, or the model's truncation if that is nearer.
// This is the radius the sampler draws inside and the field cuts at; the body
// itself (what `massIntegrals` measures) always runs to 1.
function barTipRadius(model) {
	return Math.min(1, model.truncation.spheroidRadius);
}

function barVerticalStretch(model, xi) {
	const peanut = model.bar.peanut;
	return 1 + peanut * xi * xi;
}

function barLongitudinalProfile(model, xi) {
	const x = Math.abs(xi);
	const bar = model.bar;
	if (x <= bar.plateau) return 1;
	return Math.exp(-(x - bar.plateau) / bar.endCap);
}

// Cross-section radius at xi for a body cut at `tip`: zero past either end, which
// is what makes the field vanish there. `tip` is 1 for the body itself and
// barTipRadius() for the volume the model actually samples.
function barCrossSectionRadius(model, xi, tip) {
	const n = model.spheroid.n;
	const remainder = Math.pow(tip, n) - Math.pow(Math.abs(xi), n);
	return remainder > 0 ? Math.pow(remainder, 1 / n) : 0;
}

// Single-sided marginal along the major axis: longitudinal profile times the
// cross-section area, P(xi)*tau(xi)^2. One function carries the bar's mass
// integral, its truncation fraction and the sampler's CDF, so the three cannot
// drift apart.
function barLongitudinalWeight(model, xi, tip) {
	const tau = barCrossSectionRadius(model, xi, tip);
	if (tau <= 0) return 0;
	return barLongitudinalProfile(model, xi) * barVerticalStretch(model, xi) * tau * tau;
}

function barLongitudinalIntegral(model, tip) {
	if (!(tip > 0)) return 0;
	const h = tip / BAR_RADIAL_STEPS;
	let sum = barLongitudinalWeight(model, 0, tip) + barLongitudinalWeight(model, tip, tip);
	for (let i = 1; i < BAR_RADIAL_STEPS; i++) {
		const weight = barLongitudinalWeight(model, i * h, tip);
		sum += (i & 1) === 0 ? 2 * weight : 4 * weight;
	}
	return h * sum / 3;
}

// Fraction of the bar's whole body (|xi| <= 1) that survives a cut at `tip`.
function barEnclosedMassFraction(model, tip) {
	const total = barLongitudinalIntegral(model, 1);
	return total > 0 ? barLongitudinalIntegral(model, tip) / total : 1;
}

// The spheroid: Plummer (a smooth round bulge), Sérsic (E/S0 body) or
// Bar (boxy/peanut bulge — the Milky Way preset's central component).
// Truncated at `truncation.spheroidRadius` in units of s.
function rhoSpheroid(model, x, y, z) {
	const sp = model.spheroid;
	if (sp.profileId === PROFILE_BAR) {
		const dx = x - model.centre.x;
		const dy = y - model.centre.y;
		const dz = z - model.centre.z;
		const t = sp.tiltDeg * Math.PI / 180;
		const ct = Math.cos(t);
		const st = Math.sin(t);
		const xi = (dx * ct + dy * st) / (sp.a * sp.r0);
		const eta = (-dx * st + dy * ct) / (sp.b * sp.r0);
		const ax = Math.abs(xi);
		const tip = barTipRadius(model);
		if (ax > tip) return 0;
		const tau = barCrossSectionRadius(model, xi, tip);
		if (!(tau > 0)) return 0;
		const u = eta / tau;
		const v = dz / (sp.c * sp.r0) / (barVerticalStretch(model, xi) * tau);
		const slice = barSliceProfile(model, u, v);
		if (slice <= 0) return 0;
		return sp.amp * barLongitudinalProfile(model, xi) * slice;
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

// The noise hash reads only the low 16 bits of its seed (s8 and the h2 term),
// so the model seed is reduced to 16 bits once, in the packer; the octave
// offsets (+1/+2) wrap identically in u32 WGSL and non-negative 16-bit JS.
function noiseSeed(model) {
	return (model.seed >>> 0) & 0xffff;
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

// 3D value noise and its FBM — the irregular-galaxy field has no spiral
// symmetry, so its texture is a position-based field, not (ln R, phi).
function hash3DNoise(u, v, w, seed) {
	const iu = Math.floor(u) | 0;
	const iv = Math.floor(v) | 0;
	const iw = Math.floor(w) | 0;
	const fu = u - iu;
	const fv = v - iv;
	const fw = w - iw;
	const su = fu * fu * (3 - 2 * fu);
	const sv = fv * fv * (3 - 2 * fv);
	const sw = fw * fw * (3 - 2 * fw);
	const h = (x, y, z) => {
		const x8 = (x & 0xff) >>> 0;
		const y8 = (y & 0xff) >>> 0;
		const z8 = (z & 0xff) >>> 0;
		const s8 = (seed & 0xff) >>> 0;
		const h1 = (x8 * 1597 + y8 * 2869 + z8 * 3671 + s8 * 5761) & 0xffff;
		const h2 = (((h1 & 0xff) * 2869 + ((h1 >> 8) & 0xff) * 1597 + ((seed >> 8) & 0xffff))) & 0xffff;
		return (h2 / 65535.0) * 2.0 - 1.0;
	};
	const x00 = h(iu, iv, iw) + su * (h(iu + 1, iv, iw) - h(iu, iv, iw));
	const x10 = h(iu, iv + 1, iw) + su * (h(iu + 1, iv + 1, iw) - h(iu, iv + 1, iw));
	const x01 = h(iu, iv, iw + 1) + su * (h(iu + 1, iv, iw + 1) - h(iu, iv, iw + 1));
	const x11 = h(iu, iv + 1, iw + 1) + su * (h(iu + 1, iv + 1, iw + 1) - h(iu, iv + 1, iw + 1));
	return (x00 + sv * (x10 - x00)) + sw * ((x01 + sv * (x11 - x01)) - (x00 + sv * (x10 - x00)));
}

function fbm3D(u, v, w, seed) {
	const n1 = hash3DNoise(u, v, w, seed);
	const n2 = hash3DNoise(u * 2, v * 2, w * 2, seed + 1);
	const n3 = hash3DNoise(u * 4, v * 4, w * 4, seed + 2);
	return (n1 + 0.5 * n2 + 0.25 * n3) / 1.75;
}

// Clump factor for irregular galaxies (Irr): hotspots are gaussian boosts of
// the base field. Positions are galactocentric offsets, so a centre override
// moves them with the model.
function clumpFactor(model, x, y, z) {
	if (!model.clumps || model.clumps.length === 0) return 1.0;
	const c = model.centre;
	let sum = 1.0;
	for (let i = 0; i < model.clumps.length; i++) {
		const cl = model.clumps[i];
		const dx = x - c.x - cl.x;
		const dy = y - c.y - cl.y;
		const dz = z - c.z - cl.z;
		sum += cl.boost * Math.exp(-(dx * dx + dy * dy + dz * dz) / (2 * cl.r * cl.r));
	}
	return sum;
}

// Smooth texture of an irregular: exp(k * FBM) over the base field, in
// disc-normalised coordinates so the feature size scales with the galaxy.
// Active only where clumps exist (the Irr condition); every other model
// passes through as 1.0.
function irregularFactor(model, x, y, z) {
	if (!model.clumps || model.clumps.length === 0 || !model.clumpFbm) return 1.0;
	const c = model.centre;
	const u = (x - c.x) / model.thin.L * 0.5;
	const v = (y - c.y) / model.thin.L * 0.5;
	const w = (z - c.z) / model.thin.H * 0.5;
	return Math.exp(model.clumpFbm * fbm3D(u, v, w, noiseSeed(model) + 101));
}

// The full irregular-galaxy multiplier: smooth FBM texture times hotspots.
function irregularFieldFactor(model, x, y, z) {
	return irregularFactor(model, x, y, z) * clumpFactor(model, x, y, z);
}

// Radial wavenumber of the arm pattern: the ridges solve
//   m*phi - K*ln(R/Rs) + phase0 = 2*pi*n,    K = m / tan(pitch)
// so that a ridge's tangent really does make `pitchDeg` with the
// circumferential direction, which is what a logarithmic spiral is
// (phi = ln(R/Rs)/tan(pitch)). The natural-looking shortcut K = tan(pitch)
// makes the ridges radial spokes instead: the phase then varies with phi but
// barely with R, so the "arms" fan out of the centre without winding, and the
// pitch angle is not the angle of anything. The perpendicular spacing of the
// ridges is 2*pi*R/hypot(m, K) = 2*pi*R*sin(pitch)/m, the lambda that
// armRidgeWidth is written in.
function armWavenumber(model) {
	const a = model.arms;
	return a.m / Math.tan(a.pitchDeg * Math.PI / 180);
}

// True when the model carries an arm pattern at all. An unarmed disc (S0, E)
// and a degenerate pitch (0 deg) both read as smooth.
function armsArmed(model) {
	const a = model.arms;
	return a.amp > 0 && a.m > 0 && a.pitchDeg > 0;
}

// Fade of the arm pattern inside the inner edge it is allowed from. The pattern
// is a wave, and a wave that switches on at a radius is a ring-shaped step in
// the field (measured: a 3.5% jump in an Irr at R = minRadius, where the disc is
// bright). So the pattern does not switch on — it ramps in *inward*, from zero
// at (1 - ARM_INNER_FADE)*minRadius to full contrast at minRadius. Full contrast
// at minRadius is what keeps the arms attached to the bar's end: phase0 is
// solved so a ridge passes exactly through (minRadius, bar tilt).
const ARM_INNER_FADE = 0.5;

function armInnerFade(model, R) {
	const a = model.arms;
	const inner = a.minRadius * (1 - ARM_INNER_FADE);
	if (!(inner > 0)) return 1;
	const t = Math.min(1, Math.max(0, (R - inner) / (a.minRadius - inner)));
	return t * t * (3 - 2 * t);
}

// Spiral arm modulation of the disc: factor in [1-A, 1+A]. `amp` 0 or `m` 0 is
// a smooth disc, which is how S0 and the E types read.
function armFactor(model, R, phi) {
	const a = model.arms;
	if (!armsArmed(model)) return 1.0;
	const amp = a.amp * armInnerFade(model, R);
	if (amp <= 0) return 1.0;
	const k = armWavenumber(model);
	const arg = a.m * phi - k * Math.log(R / a.Rs) + a.phase0;
	const grandDesign = Math.cos(arg);
	if (a.flocculence > 0) {
		const u = 2.0 * Math.log(R / a.Rs);
		const v = arg / Math.PI;
		const fbm = fbm2D(u, v, noiseSeed(model));
		const combined = (1.0 - a.flocculence) * grandDesign + a.flocculence * fbm;
		return 1.0 + amp * combined;
	}
	return 1.0 + amp * grandDesign;
}

// Cross-arm width of the young ridge (kpc): the lane the newborn O/B stars and
// the HII regions trace, narrower than the arm's own density enhancement. The
// ridge lines of the arm pattern are
//   lambda(R) = 2*pi*R*sin(pitch) / m = 2*pi*R / hypot(m, K)
// apart perpendicular to themselves, and the newborn lane is a fixed fraction of that spacing, sharpened by
// the arm contrast: a stronger arm (large `amp`) compresses its gas harder. The
// same pattern the field draws therefore sets its own ridge scale. The Milky
// Way's numbers land on ~0.3 kpc in the inner disc, the scale the young branch
// was originally tuned to.
const ARM_RIDGE_FRAC = 0.12;

function armRidgeWidth(model, R) {
	const a = model.arms;
	const pitch = a.pitchDeg * Math.PI / 180;
	const lambda = 2 * Math.PI * R * Math.sin(pitch) / Math.max(1, a.m);
	return ARM_RIDGE_FRAC * lambda / (1 + a.amp);
}

// Distance to the nearest arm ridge line (kpc), the quantity the
// young-population gate and the nebula lane are written in. Used for
// young-star and nebula placement. It is the perpendicular distance, not the
// arc between azimuths: the ridge condition `m*phi - K*ln(R/Rs) + phase0 =
// 2*pi*n` has gradient magnitude sqrt(m^2 + K^2)/R in the disc plane, so the
// wrapped phase residual converts to a distance by one division. With no arm
// pattern there is no ridge: the answer is "nowhere", which is what keeps
// young stars and gas nebulae off a smooth disc.
function distanceToNearestArm(model, R, phi) {
	const a = model.arms;
	if (!armsArmed(model) || R < a.minRadius) return 99;
	const k = armWavenumber(model);
	const residual = a.m * phi - k * Math.log(R / a.Rs) + a.phase0;
	let d = residual - 2 * Math.PI * Math.floor(residual / (2 * Math.PI));
	if (d > Math.PI) d -= 2 * Math.PI;
	return R * Math.abs(d) / Math.hypot(a.m, k);
}

// Azimuth of an arm ridge at radius R: the zero set of distanceToNearestArm,
// in the same convention armFactor is written in. Callers that need a point on
// the crest — tests, the visualizer, 0.3.2's object placement — read it here
// instead of re-deriving the logarithm.
function armRidgeAzimuth(model, R) {
	const a = model.arms;
	return (armWavenumber(model) * Math.log(R / a.Rs) - a.phase0) / a.m;
}

// ---- integrals -------------------------------------------------------------

// Amp-free mass integral of each component, in the same normalisation as the
// densities. The spiral arms average to 1.0 over phi and so do not enter.
//
//   thin:    2*pi*L^2 * 4H                (sech^2 integrates to 4H)
//   thick:   2*pi*L^2 * 2H
//   spheroid: plummer a*b*c*(4/3)*pi*r0^3
//             sersic  4*pi*a*b*c*r0^3 * e^b_n * n * b_n^-3n * Gamma(3n)
//             bar     48*a*b*c*r0^3 * Gamma(1+1/n)^3 / Gamma(1+3/n)
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

function massIntegrals(model) {
	const sp = model.spheroid;
	const axes = sp.a * sp.b * sp.c * sp.r0 * sp.r0 * sp.r0;
	const ah = model.halo.a_h;
	const bn = sersicBn(sp.n);
	let bulgeIntegral;
	if (sp.profileId === PROFILE_BAR) {
		// The bar's body is the unit boxy superellipsoid, so its mass is the
		// slice plane's mass, times the axes and the longitudinal marginal
		// integrated over the half-body (the sign of xi is symmetric). The end
		// caps and the peanut both live inside that squared radius; the slice
		// profile rides in barSliceMass, which degenerates to the uniform
		// slab's lnDiskArea at q = 0.
		bulgeIntegral = 2 * axes * barSliceMass(model) * barLongitudinalIntegral(model, 1);
	} else if (sp.profileId === PROFILE_SERSIC) {
		bulgeIntegral = 4 * Math.PI * axes * Math.exp(bn) * sp.n * Math.pow(bn, -3 * sp.n) * Math.exp(logGamma(3 * sp.n));
	} else {
		bulgeIntegral = axes * (4 / 3) * Math.PI;
	}
	return {
		thin: integrateDiscRadial(model.thin, Infinity, Infinity, 'sech2'),
		thick: integrateDiscRadial(model.thick, Infinity, Infinity, 'laplace'),
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
	const sp = model.spheroid;
	const sMax = t.spheroidRadius;
	let bulge;
	if (sp.profileId === PROFILE_BAR) {
		// A bar is bounded, so the only mass the cut can remove is the part of its
		// body past |xi| = spheroidRadius (a truncation override shorter than the bar).
		bulge = barEnclosedMassFraction(model, barTipRadius(model));
	} else if (sp.profileId === PROFILE_SERSIC) {
		const bn = sersicBn(sp.n);
		const a = 3 * sp.n;
		bulge = lowerGamma(a, bn * Math.pow(sMax, 1 / sp.n)) / Math.exp(logGamma(a));
	} else {
		bulge = Math.pow(sMax, 3) / Math.pow(1 + sMax * sMax, 1.5);
	}
	const thinTotal = integrateDiscRadial(model.thin, Infinity, Infinity, 'sech2');
	const thickTotal = integrateDiscRadial(model.thick, Infinity, Infinity, 'laplace');
	const thinDelivered = integrateDiscRadial(model.thin, t.discRadius, t.discHeight, 'sech2');
	const thickDelivered = integrateDiscRadial(model.thick, t.discRadius, t.discHeight, 'laplace');
	return {
		thin: model.thin.amp > 0 ? thinDelivered / thinTotal : 0,
		thick: model.thick.amp > 0 ? thickDelivered / thickTotal : 0,
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
	return base * irregularFieldFactor(model, x, y, z);
}

// Per-component densities plus the derived galactocentric quantities.
// includeClumps toggles the irregular multiplier (FBM texture + hotspots).
function rhoDecomposed(model, x, y, z, includeClumps = true) {
	const gc = toGalactocentric(model, x, y, z);
	const arm = armFactor(model, gc.R, gc.phi);
	const cf = includeClumps ? irregularFieldFactor(model, x, y, z) : 1.0;
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
	discRadialWeight,
	toGalactocentric, spheroidEllipsoidRadius, insideDisc,
	rhoThin, rhoThick, rhoSpheroid, rhoHalo,
	armFactor, armInnerFade, armRidgeWidth, distanceToNearestArm, armRidgeAzimuth, armWavenumber, armsArmed,
	ARM_INNER_FADE,
	hash2DNoise, fbm2D, hash3DNoise, fbm3D, noiseSeed,
	clumpFactor, irregularFactor, irregularFieldFactor,
	sersicMassFraction, sersicRadiusForFraction,
	barTipRadius, barVerticalStretch, barLongitudinalProfile, barCrossSectionRadius,
	barLongitudinalWeight, barLongitudinalIntegral, barEnclosedMassFraction, lnDiskArea, BAR_NONE,
	barSliceProfile, barSliceUMarginal, barSliceWMarginal, barSliceMass, barVerticalExponent, BAR_SLICE_FALLOFF,
	rhoTotal, rhoDecomposed, dominantComponent, sampleComponentIndex,
};
if (typeof module !== 'undefined') module.exports = DensityLib;
if (typeof window !== 'undefined') window.DensityLib = DensityLib;
