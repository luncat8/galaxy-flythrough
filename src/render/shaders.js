// src/render/shaders.js
// All WGSL, in one place, as a classic script.
//
// Why WGSL lives in a .js file instead of <script type="text/x-wgsl"> blocks in
// index.html plus a mirror in src/render/wgsl/: the two copies drifted, and the
// test suite could only marker-check the copy that the browser actually used.
// A JS string is
//   * file:// friendly (no fetch, no module system, no build step),
//   * require()-able in Node, so the validator checks the exact text that ships,
//   * free of HTML/JS escaping rules that make shader edits error-prone.
//
// Shader inventory:
//   pcg-hash       mirrors src/math/hash.js
//   density        mirrors src/math/density.js; the field's numbers arrive as a
//                  DensityParams uniform packed from the GalaxyModel, so the
//                  struct layout (not the values) is what the validator diffs
//   star-sprite    WIRED — Path B point sprites (the fly-through render path)
//   nebula-billboard WIRED — 0.3.2b gas quads after the sprites, before tonemap
//   procedural-gen compute path, Milestone 3 (not yet wired into the frame)
//   cull           compute path, Milestone 3 (frustum cull + thinning + indirect draw)
//
// The Milestone 3 shaders are kept as the executable form of the plan's design
// (plan.md §8/§9/§14a) and are constant-checked against the JS model by
// experiments/wgsl-validate.js. Nothing else in the runtime references them yet.

'use strict';

const PCG_HASH = `
// PCG hash and helpers — mirrors src/math/hash.js.
// Reference: Nathan Reed, "Hash Functions for GPU Rendering", 2021.
// Validated by experiments/hash-quality-test.js (chi-square, serial
// correlation, spectral, period).

fn pcgHash(input: u32) -> u32 {
        var state: u32 = input;
        state = state * 0x7feb352du;
        state = state ^ (state >> 15u);
        state = state * 0x846ca68bu;
        state = state ^ (state >> 13u);
        state = state ^ (state >> 16u);
        return state;
}

fn hash4(a: u32, b: u32, c: u32, d: u32) -> u32 {
        var h: u32 = pcgHash(a);
        h = (h * 0x9e3779b1u) ^ b;
        h = pcgHash(h);
        h = (h * 0x85ebca77u) ^ c;
        h = pcgHash(h);
        h = (h * 0xc2b2ae3du) ^ d;
        return pcgHash(h);
}

fn hash01(seed: u32) -> f32 {
        return f32(pcgHash(seed)) / 4294967296.0;
}

fn hash01At(seed: u32, channel: u32) -> f32 {
        return f32(pcgHash(seed * 0x9e3779b1u + channel)) / 4294967296.0;
}

fn hash2D(seed: u32) -> vec2f {
        let a: u32 = pcgHash(seed);
        let b: u32 = pcgHash(a ^ 0x9e3779b9u);
        return vec2f(f32(a) / 4294967296.0, f32(b) / 4294967296.0);
}

fn hash3D(seed: u32) -> vec3f {
        let a: u32 = pcgHash(seed);
        let b: u32 = pcgHash(a ^ 0x9e3779b9u);
        let c: u32 = pcgHash(b ^ 0x85ebca77u);
        return vec3f(f32(a) / 4294967296.0, f32(b) / 4294967296.0, f32(c) / 4294967296.0);
}

fn wangHash(input: u32) -> u32 {
        var h: u32 = input;
        h = h * 2654435761u;
        h = h ^ (h >> 16u);
        h = h * 0x85ebca6bu;
        h = h ^ (h >> 13u);
        h = h * 0xc2b2ae35u;
        h = h ^ (h >> 16u);
        return h;
}
`;

const DENSITY = `
// Analytical galaxy density field — mirrors src/math/density.js.
//
// The numbers are not in this text: they live in a DensityParams uniform packed
// from the GalaxyModel by src/math/galaxy.js (packDensityParams). That is the
// price of a parameterised model, and it is paid in one place — the struct's
// field list and order are pinned against the packer's layout by
// experiments/wgsl-validate.js, and the formulas are checked numerically by
// experiments/wgsl-exec-check.js against the JS model. What must never happen
// is a second copy of a constant in here.
//
// Units: kpc, model world frame; params.centre is the galactocentric origin.

struct DensityParams {
        centre: vec4f,          // xyz galactocentric origin
        thin: vec4f,            // L, H, amp, flare
        thick: vec4f,           // L, H, amp, flare
        discCore: vec4f,        // thin.coreRadius, thick.coreRadius, -, -
        spheroid: vec4f,        // a, b, c, r0
        spheroidShape: vec4f,   // amp, n, tiltDeg, profileId
        // Only the bar profile reads this one: the peanut's vertical stretch,
        // the exponential end-cap scale and the plateau it starts from, plus
        // the slice profile's vertical exponent (the vertical boxiness).
        barShape: vec4f,        // peanut, endCap, plateau, vertical
        halo: vec4f,            // a_h, rMax, power, amp
        arms: vec4f,            // m, amp, pitchDeg, Rs
        // w: low 16 bits of the model seed (the noise hash reads exactly
        // those, and 16 bits round-trip an f32 exactly).
        armShape: vec4f,        // phase0, minRadius, flocculence, noiseSeed
        populations: vec4f,     // gasFraction, youngOuterR, gasRich, gradientSteep
        // The galaxy's clock: age in Gyr, the SFH timescale (clamped positive on
        // the CPU) and the span star formation actually covers,
        // min(age, quenchTime). Solved by galaxy.solvePopulationClock, read here
        // by the population mirrors. The gas left at that age is a CPU-only
        // number, like youngScaleHeight, so it does not ride along.
        clock: vec4f,           // age, tauSfh, sfhSpan, -
        // Component formation windows as CDF intervals of the truncated SFH,
        // indexed like COMPONENT_*: a draw is one mix and one inverse.
        formLo: vec4f,          // thin, thick, bulge, halo — window start
        formHi: vec4f,          // thin, thick, bulge, halo — window end
        truncation: vec4f,      // discRadius, discHeight, spheroidRadius, -
        clumpMeta: vec4f,       // clump count, boost, kfbm, -
        // Irregular hotspots: galactocentric (x, y, z, r).
        clumps: array<vec4f, 12>,
};

// Profile selector, matching density.PROFILE_* and the packed spheroidShape.w.
const PROFILE_PLUMMER: f32 = 0.0;
const PROFILE_SERSIC: f32 = 1.0;
const PROFILE_BAR: f32 = 2.0;

const COMPONENT_THIN: u32 = 0u;
const COMPONENT_THICK: u32 = 1u;
const COMPONENT_BULGE: u32 = 2u;
const COMPONENT_HALO: u32 = 3u;

fn sersicBn(n: f32) -> f32 {
        return 2.0 * n - 1.0 / 3.0;
}

fn spheroidEllipsoidRadius(params: DensityParams, dx: f32, dy: f32, dz: f32) -> f32 {
        let t: f32 = radians(params.spheroidShape.z);
        let ct: f32 = cos(t);
        let st: f32 = sin(t);
        let xrot: f32 = dx * ct + dy * st;
        let yrot: f32 = -dx * st + dy * ct;
        let axes: vec3f = params.spheroid.xyz;
        let r2: f32 = (xrot * xrot) / (axes.x * axes.x)
                + (yrot * yrot) / (axes.y * axes.y)
                + (dz * dz) / (axes.z * axes.z);
        return sqrt(r2) / params.spheroid.w;
}

// Mirror of density.js's truncation rule (0.4.8 M3.1): the radial cut is the
// authored one, the vertical cut is the authored slab or the height where this
// component's own profile has fallen to TRUNCATION_FLOOR of its midplane
// value, whichever is farther out — so the cut never sits mid-profile and it
// follows H(R) where the disc flares. Mirrors density.VERTICAL_CUT_SECH2 /
// VERTICAL_CUT_LAPLACE: ln(4/1e-3) and ln(1/1e-3).
const VERTICAL_CUT_SECH2: f32 = 8.294049640102028;
const VERTICAL_CUT_LAPLACE: f32 = 6.907755278982137;

fn insideDisc(params: DensityParams, R: f32, z: f32, cutHeights: f32, H: f32) -> bool {
        return R <= params.truncation.x && abs(z) <= max(params.truncation.y, cutHeights * H);
}

// Flare and core each come from the group they belong to: thin reads
// thin.w (flare) and discCore.x, thick reads thick.w and discCore.y.
fn rhoThin(params: DensityParams, R: f32, z: f32) -> f32 {
        let H: f32 = params.thin.y * (1.0 + params.thin.w * R / params.thin.x);
        if (!insideDisc(params, R, z, VERTICAL_CUT_SECH2, H)) { return 0.0; }
        var radial: f32 = exp(-R / params.thin.x);
        if (params.discCore.x > 0.0) {
                radial = radial * (R / sqrt(R * R + params.discCore.x * params.discCore.x));
        }
        let e: f32 = exp(-abs(z) / H);
        return params.thin.z * radial * 4.0 * e / ((1.0 + e) * (1.0 + e));
}

fn rhoThick(params: DensityParams, R: f32, z: f32) -> f32 {
        let H: f32 = params.thick.y * (1.0 + params.thick.w * R / params.thick.x);
        if (!insideDisc(params, R, z, VERTICAL_CUT_LAPLACE, H)) { return 0.0; }
        var radial: f32 = exp(-R / params.thick.x);
        if (params.discCore.y > 0.0) {
                radial = radial * (R / sqrt(R * R + params.discCore.y * params.discCore.y));
        }
        return params.thick.z * radial * exp(-abs(z) / H);
}

// Interior falloff of the bar's cross-section profile, mirroring
// density.BAR_SLICE_FALLOFF: a shape constant, the same for every model.
const BAR_SLICE_FALLOFF: f32 = 1.5;

// Mirror of density.barSliceProfile: the bar's cross-section profile in the
// slice coordinates (u = eta/tau, v = zeta/(peanut*tau)). It reaches zero at
// the envelope with zero slope, which is what keeps the body's edge invisible.
fn barSliceProfile(n: f32, cv: f32, u: f32, v: f32) -> f32 {
        let m: f32 = pow(abs(u), n) + pow(abs(v), cv);
        if (m >= 1.0) { return 0.0; }
        return pow(1.0 - m, BAR_SLICE_FALLOFF);
}

// Both spheroid profiles are truncated at params.truncation.z, in units of s —
// the same cut the sampler draws inside, because the truncation is part of the
// model and not of the sampling.
fn rhoSpheroid(params: DensityParams, x: f32, y: f32, z: f32) -> f32 {
        let dx: f32 = x - params.centre.x;
        let dy: f32 = y - params.centre.y;
        // The bar (boxy/peanut inner part + exponential end caps): the density
        // is the cross-section's slice profile, scaled by the local section
        // (tau) and the peanut stretch, so the body has no rim and falls off
        // inside like a real bar's vertical profile does.
        if (params.spheroidShape.w >= PROFILE_BAR) {
                let t: f32 = radians(params.spheroidShape.z);
                let ct: f32 = cos(t);
                let st: f32 = sin(t);
                let axes: vec3f = params.spheroid.xyz * params.spheroid.w;
                let xi: f32 = (dx * ct + dy * st) / axes.x;
                let ax: f32 = abs(xi);
                let n: f32 = params.spheroidShape.y;
                let tip: f32 = min(1.0, params.truncation.z);
                if (ax >= tip) { return 0.0; }
                let tau: f32 = pow(max(0.0, pow(tip, n) - pow(ax, n)), 1.0 / n);
                if (tau <= 0.0) { return 0.0; }
                let eta: f32 = (-dx * st + dy * ct) / axes.y;
                let peanut: f32 = 1.0 + params.barShape.x * xi * xi;
                let slice: f32 = barSliceProfile(n, params.barShape.w, eta / tau,
                        (z - params.centre.z) / (axes.z * peanut * tau));
                if (slice <= 0.0) { return 0.0; }
                let cap: f32 = exp(-(ax - params.barShape.z) / params.barShape.y);
                return params.spheroidShape.x * select(cap, 1.0, ax <= params.barShape.z) * slice;
        }
        let s: f32 = spheroidEllipsoidRadius(params, dx, dy, z - params.centre.z);
        if (s > params.truncation.z) { return 0.0; }
        if (params.spheroidShape.w >= PROFILE_SERSIC) {
                let n: f32 = params.spheroidShape.y;
                return params.spheroidShape.x * exp(-sersicBn(n) * (pow(s, 1.0 / n) - 1.0));
        }
        return params.spheroidShape.x * pow(1.0 + s * s, -2.5);
}

fn rhoHalo(params: DensityParams, x: f32, y: f32, z: f32) -> f32 {
        let dx: f32 = x - params.centre.x;
        let dy: f32 = y - params.centre.y;
	let dz: f32 = z - params.centre.z;
	let r: f32 = sqrt(dx * dx + dy * dy + dz * dz);
	if (r > params.halo.y) { return 0.0; }
        let a: f32 = params.halo.x;
        if (r < a) { return params.halo.w; }
        return params.halo.w * pow(r / a, -params.halo.z);
}

fn noise2DCorner(x: i32, y: i32, seed: u32) -> f32 {
        let x8: u32 = u32(x) & 0xffu;
        let y8: u32 = u32(y) & 0xffu;
        let s8: u32 = seed & 0xffu;
        let h1: u32 = (x8 * 1597u + y8 * 2869u + s8 * 3671u) & 0xffffu;
        let h2: u32 = ((h1 & 0xffu) * 2869u + ((h1 >> 8u) & 0xffu) * 1597u + ((seed >> 8u) & 0xffffu)) & 0xffffu;
        return (f32(h2) / 65535.0) * 2.0 - 1.0;
}

fn hash2DNoise(u: f32, v: f32, seed: u32) -> f32 {
        let iu: i32 = i32(floor(u));
        let iv: i32 = i32(floor(v));
        let fu: f32 = u - f32(iu);
        let fv: f32 = v - f32(iv);
        let su: f32 = fu * fu * (3.0 - 2.0 * fu);
        let sv: f32 = fv * fv * (3.0 - 2.0 * fv);
        let n00: f32 = noise2DCorner(iu, iv, seed);
        let n10: f32 = noise2DCorner(iu + 1, iv, seed);
        let n01: f32 = noise2DCorner(iu, iv + 1, seed);
        let n11: f32 = noise2DCorner(iu + 1, iv + 1, seed);
        let nx0: f32 = mix(n00, n10, su);
        let nx1: f32 = mix(n01, n11, su);
        return mix(nx0, nx1, sv);
}

fn fbm2D(u: f32, v: f32, seed: u32) -> f32 {
        let n1: f32 = hash2DNoise(u, v, seed);
        let n2: f32 = hash2DNoise(u * 2.0, v * 2.0, seed + 1u);
        let n3: f32 = hash2DNoise(u * 4.0, v * 4.0, seed + 2u);
        return (n1 + 0.5 * n2 + 0.25 * n3) / 1.75;
}

// Radial wavenumber of the arm pattern, K = m/tan(pitch): the ridges solve
// m*phi - K*ln(R/Rs) + phase0 = 2*pi*n, so a ridge's tangent really does make
// pitchDeg with the circumferential direction. K = tan(pitch) would make the
// ridges radial spokes instead. Mirrors density.armWavenumber.
fn armWavenumber(params: DensityParams) -> f32 {
        return params.arms.x / tan(radians(params.arms.z));
}

// True when the model carries an arm pattern at all. Mirrors density.armsArmed.
fn armsArmed(params: DensityParams) -> bool {
        return params.arms.y > 0.0 && params.arms.x > 0.0 && params.arms.z > 0.0;
}

// Fade of the arm pattern in *inside* the inner edge it is allowed from: a
// pattern that switches on at a radius is a ring-shaped step in the field,
// visible wherever the disc is bright. Zero at (1 - ARM_INNER_FADE)*minRadius,
// full contrast at minRadius, which is what keeps the ridges attached to the
// bar's end. Mirrors density.armInnerFade.
const ARM_INNER_FADE: f32 = 0.5;

fn armInnerFade(params: DensityParams, R: f32) -> f32 {
        let inner: f32 = params.armShape.y * (1.0 - ARM_INNER_FADE);
        if (inner <= 0.0) { return 1.0; }
        let t: f32 = clamp((R - inner) / (params.armShape.y - inner), 0.0, 1.0);
        return t * t * (3.0 - 2.0 * t);
}

// amp 0 or m 0 is a smooth disc, which is how S0 and the E types read.
fn armFactor(params: DensityParams, R: f32, phi: f32) -> f32 {
        let m: f32 = params.arms.x;
        if (!armsArmed(params)) { return 1.0; }
        let amp: f32 = params.arms.y * armInnerFade(params, R);
        if (amp <= 0.0) { return 1.0; }
        let k: f32 = armWavenumber(params);
        let arg: f32 = m * phi - k * log(R / params.arms.w) + params.armShape.x;
        let grandDesign: f32 = cos(arg);
        let flocculence: f32 = params.armShape.z;
        if (flocculence > 0.0) {
                let u: f32 = 2.0 * log(R / params.arms.w);
                let v: f32 = arg / 3.1415926535;
                let fbm: f32 = fbm2D(u, v, u32(params.armShape.w));
                let combined: f32 = (1.0 - flocculence) * grandDesign + flocculence * fbm;
                return 1.0 + amp * combined;
        }
        return 1.0 + amp * grandDesign;
}

// 3D value noise and its FBM — the irregular field has no spiral symmetry, so
// its texture is position-based, not (ln R, phi). Mirrors density.hash3DNoise.
fn noise3DCorner(x: i32, y: i32, z: i32, seed: u32) -> f32 {
        let x8: u32 = u32(x) & 0xffu;
        let y8: u32 = u32(y) & 0xffu;
        let z8: u32 = u32(z) & 0xffu;
        let s8: u32 = seed & 0xffu;
        let h1: u32 = (x8 * 1597u + y8 * 2869u + z8 * 3671u + s8 * 5761u) & 0xffffu;
        let h2: u32 = ((h1 & 0xffu) * 2869u + ((h1 >> 8u) & 0xffu) * 1597u + ((seed >> 8u) & 0xffffu)) & 0xffffu;
        return (f32(h2) / 65535.0) * 2.0 - 1.0;
}

fn hash3DNoise(u: f32, v: f32, w: f32, seed: u32) -> f32 {
        let iu: i32 = i32(floor(u));
        let iv: i32 = i32(floor(v));
        let iw: i32 = i32(floor(w));
        let fu: f32 = u - f32(iu);
        let fv: f32 = v - f32(iv);
        let fw: f32 = w - f32(iw);
        let su: f32 = fu * fu * (3.0 - 2.0 * fu);
        let sv: f32 = fv * fv * (3.0 - 2.0 * fv);
        let sw: f32 = fw * fw * (3.0 - 2.0 * fw);
        let x00: f32 = mix(noise3DCorner(iu, iv, iw, seed), noise3DCorner(iu + 1, iv, iw, seed), su);
        let x10: f32 = mix(noise3DCorner(iu, iv + 1, iw, seed), noise3DCorner(iu + 1, iv + 1, iw, seed), su);
        let x01: f32 = mix(noise3DCorner(iu, iv, iw + 1, seed), noise3DCorner(iu + 1, iv, iw + 1, seed), su);
        let x11: f32 = mix(noise3DCorner(iu, iv + 1, iw + 1, seed), noise3DCorner(iu + 1, iv + 1, iw + 1, seed), su);
        return mix(mix(x00, x10, sv), mix(x01, x11, sv), sw);
}

fn fbm3D(u: f32, v: f32, w: f32, seed: u32) -> f32 {
        let n1: f32 = hash3DNoise(u, v, w, seed);
        let n2: f32 = hash3DNoise(u * 2.0, v * 2.0, w * 2.0, seed + 1u);
        let n3: f32 = hash3DNoise(u * 4.0, v * 4.0, w * 4.0, seed + 2u);
        return (n1 + 0.5 * n2 + 0.25 * n3) / 1.75;
}

// Irregular hotspots: gaussian boosts of the base field at galactocentric
// offsets. Mirrors density.clumpFactor.
fn clumpFactor(params: DensityParams, x: f32, y: f32, z: f32) -> f32 {
        let count: u32 = u32(params.clumpMeta.x);
        if (count == 0u) { return 1.0; }
        let boost: f32 = params.clumpMeta.y;
        var sum: f32 = 1.0;
        for (var i: u32 = 0u; i < count; i = i + 1u) {
                let c: vec4f = params.clumps[i];
                let dx: f32 = x - params.centre.x - c.x;
                let dy: f32 = y - params.centre.y - c.y;
                let dz: f32 = z - params.centre.z - c.z;
                sum += boost * exp(-(dx * dx + dy * dy + dz * dz) / (2.0 * c.w * c.w));
        }
        return sum;
}

// Smooth irregular texture: exp(k * FBM) in disc-normalised coordinates.
// Mirrors density.irregularFactor.
fn irregularFactor(params: DensityParams, x: f32, y: f32, z: f32) -> f32 {
        if (u32(params.clumpMeta.x) == 0u || params.clumpMeta.z == 0.0) { return 1.0; }
        let u: f32 = (x - params.centre.x) / params.thin.x * 0.5;
        let v: f32 = (y - params.centre.y) / params.thin.x * 0.5;
        let w: f32 = (z - params.centre.z) / params.thin.y * 0.5;
        return exp(params.clumpMeta.z * fbm3D(u, v, w, u32(params.armShape.w) + 101u));
}

fn irregularFieldFactor(params: DensityParams, x: f32, y: f32, z: f32) -> f32 {
        return irregularFactor(params, x, y, z) * clumpFactor(params, x, y, z);
}

// Perpendicular distance to the nearest arm ridge line, for the young-star gate
// and the nebula lane. The ridge condition's gradient magnitude is
// sqrt(m^2 + K^2)/R in the disc plane, so the wrapped phase residual converts to
// a distance by one division. With no pattern there is no ridge, so the distance
// is "nowhere" — which is what keeps young stars and gas nebulae off a smooth
// disc. Mirrors density.distanceToNearestArm.
fn distanceToNearestArm(params: DensityParams, R: f32, phi: f32) -> f32 {
        let m: f32 = params.arms.x;
        if (!armsArmed(params) || R < params.armShape.y) { return 99.0; }
        let k: f32 = armWavenumber(params);
        let residual: f32 = m * phi - k * log(R / params.arms.w) + params.armShape.x;
        var d: f32 = residual - 6.283185307 * floor(residual / 6.283185307);
        if (d > 3.1415926535) { d = d - 6.283185307; }
        return R * abs(d) / sqrt(m * m + k * k);
}

fn rhoTotal(params: DensityParams, x: f32, y: f32, z: f32) -> f32 {
        let dx: f32 = x - params.centre.x;
        let dy: f32 = y - params.centre.y;
        let R: f32 = sqrt(dx * dx + dy * dy);
        let phi: f32 = atan2(dy, dx);
        let arm: f32 = armFactor(params, R, phi);
        let base: f32 = (rhoThin(params, R, z - params.centre.z) + rhoThick(params, R, z - params.centre.z)) * arm
                + rhoSpheroid(params, x, y, z) + rhoHalo(params, x, y, z);
        return base * irregularFieldFactor(params, x, y, z);
}

// Component shares at a point as vec4(thin, thick, bulge, halo).
fn rhoDecomposed(params: DensityParams, x: f32, y: f32, z: f32) -> vec4f {
        let dx: f32 = x - params.centre.x;
        let dy: f32 = y - params.centre.y;
        let R: f32 = sqrt(dx * dx + dy * dy);
        let phi: f32 = atan2(dy, dx);
        let arm: f32 = armFactor(params, R, phi);
        let cf: f32 = irregularFieldFactor(params, x, y, z);
        return vec4f(
                rhoThin(params, R, z - params.centre.z) * arm * cf,
                rhoThick(params, R, z - params.centre.z) * arm * cf,
                rhoSpheroid(params, x, y, z) * cf,
                rhoHalo(params, x, y, z) * cf,
        );
}

// Mirrors density.sampleComponentIndex().
fn sampleComponent(params: DensityParams, x: f32, y: f32, z: f32, u: f32) -> u32 {
        let d: vec4f = rhoDecomposed(params, x, y, z);
        let total: f32 = d.x + d.y + d.z + d.w;
        if (total < 1e-12) { return COMPONENT_THIN; }
        var r: f32 = u * total;
        r = r - d.x;
        if (r < 0.0) { return COMPONENT_THIN; }
        r = r - d.y;
        if (r < 0.0) { return COMPONENT_THICK; }
        r = r - d.z;
        if (r < 0.0) { return COMPONENT_BULGE; }
        return COMPONENT_HALO;
}
`;

const ORBIT = `
// 0.4 closed-form orbit — mirrors src/math/orbit.js (symbolically by
// experiments/wgsl-validate.js, numerically by the f32 replay in
// experiments/orbit-test.js). No galaxy numbers live here: every per-model
// value arrives through camera.dynA / camera.dynB, packed by
// orbit.packOrbitDynamics — dynA = (vFlat, rCore, omegaPattern, spinLambda),
// dynB = (sigmaThin, pressureAmpScale, discHeight, patternLock),
// waveA = (damping, m, K, phase0), waveB = (Rs, minRadius, amp, patternPhaseOffset).
//
// Group kinematics (plan §1.1, 0.4.3): the pattern (the bar's and the arms'
// seats) rides the group speed galaxy.js derives from the model's own
// population; the disc rotates differentially at its local group rate Omega(r)
// with no corotation lock; and the bar's stars circulate about their seats on
// x1 loops at Omega(r) - omegaPattern, the rate at which they lap the pattern.

const TAU: f32 = 6.28318530718;
const INV_TAU: f32 = 0.159154943092;
const PI: f32 = 3.14159265359;
const HALF_PI: f32 = 1.57079632679;
const SQRT2: f32 = 1.41421356237;
// Orbit shares StarRecord's family numbering: bits 3-4 of the flags byte.
const FAMILY_PATTERN: u32 = 0u;
const FAMILY_DISC: u32 = 1u;
const FAMILY_BAR: u32 = 2u;
const FAMILY_PRESSURE: u32 = 3u;
// Plan §1.1 spheroid clock; also the 1 kpc anchor of the pressure amplitude.
const PRESSURE_CLOCK_1KPC: f32 = 0.05;
const VERTICAL_WOBBLE_RATIO: f32 = 0.2;
// The bar's x1 loop as a fraction of the spheroid amplitude scale (dynB.y).
const BAR_LOOP_FRACTION: f32 = 0.15;

// Reduce the full argument before sin: WGSL sin of a large argument is
// implementation-defined, and reducing here (not just the bulk theta) keeps
// epicycle phases continuous when the bulk angle wraps.
fn sinTau(arg: f32) -> f32 {
        return sin(TAU * fract(arg * INV_TAU));
}

fn pressureClock(dynA: vec4f, r: f32) -> f32 {
        // Plan §1.1 ω̄: mean disc frequency for disc-type galaxies, the
        // Keplerian spheroid clock only when there is no disc curve (E).
        if (dynA.x > 0.0) { return dynA.x / max(r, dynA.y); }
        return PRESSURE_CLOCK_1KPC / max(pow(max(r, 0.1), 1.5), 0.01);
}

fn orbitOmega(family: u32, r: f32, dynA: vec4f, dynB: vec4f) -> f32 {
        if (family == FAMILY_BAR) { return dynA.z; }
        if (family == FAMILY_PATTERN) {
                // No pattern (S0/E/Irr): orbit like the disc neighbours instead
                // of freezing. galaxy.js derives omegaPattern per model.
                if (dynA.z > 0.0) { return dynA.z; }
                return select(0.0, dynA.x / max(r, dynA.y), dynA.x > 0.0);
        }
        if (family == FAMILY_DISC) {
                // The local group rate. patternLock is the cosmetic rigid variant.
                if (dynB.w > 0.5 && dynA.z > 0.0) { return dynA.z; }
                return select(0.0, dynA.x / max(r, dynA.y), dynA.x > 0.0);
        }
        return dynA.w * pressureClock(dynA, r);
}

// How fast a star laps the pattern at radius r (the bar loop's frequency).
fn omegaStream(dynA: vec4f, r: f32) -> f32 {
        return select(0.0, dynA.x / max(r, dynA.y), dynA.x > 0.0) - dynA.z;
}

// Pattern-frame capture. Mirrors orbit.dampedDiscTheta. χ is m times the
// azimuth from one crest (every crest folds to 0). Crest speed is zero on
// both sides of corotation — the inertial omega*(1-s*D) form anti-jams
// outside it, and this disc is mostly outside it. Returns the wrapped
// inertial rotation of the birth vector.
fn dampedDiscTheta(theta0: f32, thetaArm: f32, omega: f32, omegaP: f32, time: f32, alpha: f32, m: f32) -> f32 {
        if (time == 0.0 || alpha <= 0.0 || m < 1.0) {
                return TAU * fract(omega * time * INV_TAU);
        }
        let omegaRel: f32 = omega - omegaP;
        if (omegaRel == 0.0) {
                return TAU * fract(omega * time * INV_TAU);
        }
        let strength: f32 = min(alpha, 1.0);
        var chi0: f32 = m * (theta0 - thetaArm);
        chi0 = chi0 - TAU * floor((chi0 + PI) * INV_TAU);
        let lim: f32 = PI - 1e-5;
        if (chi0 > lim) { chi0 = lim; }
        else if (chi0 < -lim) { chi0 = -lim; }
        let u0: f32 = tan(chi0 * 0.5);
        let beta: f32 = strength * m * omegaRel * 0.5;
        let denom: f32 = 1.0 - u0 * beta * time;
        var chi: f32;
        if (abs(denom) <= 1e-6) {
                chi = select(-PI, PI, omegaRel > 0.0);
        } else {
                chi = 2.0 * atan(u0 / denom);
                if (denom < 0.0) {
                        chi = chi + select(-TAU, TAU, omegaRel > 0.0);
                }
        }
        let advance: f32 = (chi - chi0) / m;
        return TAU * fract((advance + omegaP * time) * INV_TAU);
}

const ORBIT_INCLINATION_DISC: f32 = 0.045;
const ORBIT_INCLINATION_BAR: f32 = 0.12;
const ORBIT_INCLINATION_PRESSURE: f32 = 0.30;

fn orbitInclination(family: u32, phase: u32, amplitude: u32) -> f32 {
        let rank: f32 = (f32(amplitude) + 0.5) * 0.0625;
        let direction: f32 = sin(f32(phase) * 0.392699081699);
        var maximum: f32 = ORBIT_INCLINATION_DISC;
        if (family == FAMILY_BAR) { maximum = ORBIT_INCLINATION_BAR; }
        else if (family == FAMILY_PRESSURE) { maximum = ORBIT_INCLINATION_PRESSURE; }
        return maximum * rank * direction;
}

fn orbitPosition(p: vec3f, packed: u32, centre: vec3f, time: f32, dynA: vec4f, dynB: vec4f, waveA: vec4f, waveB: vec4f) -> vec3f {
        let flags: u32 = (packed >> 16u) & 0xFFu;
        let family: u32 = (flags >> 3u) & 3u;
        let phaseBits: u32 = (packed >> 24u) & 15u;
        let phase: f32 = f32(phaseBits) * 0.392699081699;
        let ampBits: u32 = (packed >> 28u) & 15u;
        let q: vec3f = p - centre;
        let r: f32 = max(length(q.xy), 0.001);
        let omega: f32 = orbitOmega(family, r, dynA, dynB);
        // waveA = (damping, m, K, phase0), waveB = (Rs, minRadius, amp, patternPhaseOffset).
        // The offset is the phase origin for a live pattern-rate change.
        var theta: f32 = omega * time;
        if (family == FAMILY_PATTERN || family == FAMILY_BAR) {
                theta = theta + waveB.w;
        }
        if (family == FAMILY_DISC && waveA.x > 0.0 && waveA.y >= 1.0 && waveB.z > 0.0 && waveB.x > 0.0 && r >= waveB.y && !(dynB.w > 0.5)) {
                let theta0: f32 = atan2(q.y, q.x);
                let thetaArm: f32 = (waveA.z * log(r / waveB.x) - waveA.w) / waveA.y + waveB.w;
                theta = dampedDiscTheta(theta0, thetaArm, omega, dynA.z, time, waveA.x, waveA.y);
        }
        theta = TAU * fract(theta * INV_TAU);
        let rank: f32 = (f32(ampBits) + 0.5) * 0.0625;
        let sinPh: f32 = sinTau(phase);
        let sinPhV: f32 = sinTau(phase + HALF_PI);
        var wr: f32 = 0.0;
        var wz: f32 = 0.0;
        if (family == FAMILY_BAR) {
                let stream: f32 = omegaStream(dynA, r);
                let ah: f32 = rank * BAR_LOOP_FRACTION * dynB.y;
                wr = ah * (sinTau(phase + stream * time) - sinPh);
        } else if (family == FAMILY_DISC) {
                let kappa: f32 = SQRT2 * (dynA.x / max(r, dynA.y));
                let ah: f32 = rank * 2.0 * dynB.x / max(kappa, 1e-6);
                let av: f32 = min(VERTICAL_WOBBLE_RATIO * ah, max(dynB.z - abs(q.z), 0.0));
                wr = ah * (sinTau(phase + kappa * time) - sinPh);
                wz = av * (sinTau(phase + HALF_PI + kappa * time) - sinPhV);
        } else if (family == FAMILY_PRESSURE) {
                let a: f32 = rank * dynB.y;
                let mean: f32 = pressureClock(dynA, r);
                wr = a * (sinTau(phase + mean * time) - sinPh);
                wz = a * (sinTau(phase + HALF_PI + mean * time) - sinPhV);
        }

        // Each star has a deterministic orbital plane through the galaxy's
        // centre point. This avoids making all 3-D stars rotate around one
        // infinite galaxy-axis line.
        let radius: f32 = length(q);
        var e0: vec3f = vec3f(1.0, 0.0, 0.0);
        if (radius > 1e-9) { e0 = q / radius; }
        let xy: f32 = length(q.xy);
        var az: vec3f = vec3f(0.0, 1.0, 0.0);
        if (xy > 1e-9) { az = vec3f(-q.y / xy, q.x / xy, 0.0); }
        let eZ: vec3f = cross(e0, az);
        let inc: f32 = orbitInclination(family, phaseBits, ampBits);
        let ci: f32 = cos(inc); let si: f32 = sin(inc);
        let e1: vec3f = az * ci + eZ * si;
        let normal: vec3f = cross(e0, e1);
        let radial: vec3f = e0 * cos(theta) + e1 * sin(theta);
        let orbitRadius: f32 = select(0.0, radius + wr, radius > 1e-9);
        let normalWobble: f32 = select(0.0, wz, radius > 1e-9);
        return centre + orbitRadius * radial + normalWobble * normal;
}

// Apocenter-guided Kepler ellipse, mirrored by orbit.apocenterPosition.
fn apocenterPosition(p: vec3f, packed: u32, centre: vec3f, time: f32, dynA: vec4f, waveA: vec4f, waveB: vec4f, engine: vec4f) -> vec3f {
        if (time == 0.0) { return p; }
        let selector: f32 = hash01(hash4(bitcast<u32>(p.x), bitcast<u32>(p.y), bitcast<u32>(p.z), 9137u));
        if (selector >= engine.w) { return p; }
        let flags: u32 = (packed >> 16u) & 0xFFu;
        let family: u32 = (flags >> 3u) & 3u;
        let phaseBits: u32 = (packed >> 24u) & 15u;
        let ampBits: u32 = (packed >> 28u) & 15u;
        let q: vec3f = p - centre;
        let radius: f32 = length(q);
        if (radius <= 1e-9) { return centre; }
        let theta0: f32 = atan2(q.y, q.x);
        let R: f32 = max(length(q.xy), 0.001);
        var apo: f32 = theta0;
        if ((family == FAMILY_DISC || family == FAMILY_PATTERN) && waveA.y >= 1.0 && waveB.z > 0.0 && R >= waveB.y) {
                let ridge: f32 = (waveA.z * log(R / waveB.x) - waveA.w) / waveA.y;
                apo = ridge + floor((theta0 - ridge) * waveA.y / TAU + 0.5) * TAU / waveA.y;
        } else if (family == FAMILY_BAR) {
                apo = engine.z + floor((theta0 - engine.z) / PI + 0.5) * PI;
        }
        let delta0: f32 = (apo + PI - theta0) - TAU * floor((apo + PI - theta0 + PI) / TAU);
        let rank: f32 = (f32(ampBits) + 0.5) * 0.0625;
        let ecc: f32 = min(engine.y * rank, 0.55);
        let root: f32 = sqrt(1.0 - ecc * ecc);
        let cosF: f32 = cos(delta0);
        let sinF: f32 = -sin(delta0);
        let E0: f32 = atan2(root * sinF, ecc + cosF);
        let M0: f32 = E0 - ecc * sin(E0);
        let a: f32 = radius * (1.0 + ecc * cosF) / (1.0 - ecc * ecc);
        var localOmega: f32 = pressureClock(dynA, R);
        if (dynA.x > 0.0) { localOmega = dynA.x / max(R, dynA.y); }
        let phaseOffset: f32 = waveB.w;
        let meanRaw: f32 = M0 + (localOmega - dynA.z) * time - phaseOffset;
        let mean: f32 = meanRaw - TAU * floor((meanRaw + PI) / TAU);
        var E: f32 = mean;
        for (var i: u32 = 0u; i < 5u; i = i + 1u) {
                E = E - (E - ecc * sin(E) - mean) / (1.0 - ecc * cos(E));
        }
        let nu: f32 = atan2(root * sin(E), cos(E) - ecc);
        let orbitRadius: f32 = a * (1.0 - ecc * cos(E));
        let delta: f32 = delta0 + dynA.z * time + phaseOffset;
        let e0: vec3f = q / radius;
        let xy: f32 = length(q.xy);
        var az: vec3f = vec3f(0.0, 1.0, 0.0);
        if (xy > 1e-9) { az = vec3f(-q.y / xy, q.x / xy, 0.0); }
        let eZ: vec3f = cross(e0, az);
        let inc: f32 = orbitInclination(family, phaseBits, ampBits);
        let e1: vec3f = az * cos(inc) + eZ * sin(inc);
        let eP: vec3f = e0 * cos(delta) + e1 * sin(delta);
        let eQ: vec3f = -e0 * sin(delta) + e1 * cos(delta);
        return centre + orbitRadius * (eP * cos(nu) + eQ * sin(nu));
}

// 0.4.5 simple engine: reconstruct from the integrated azimuth. Mirrors
// orbit.simplePositionFromTheta. Family-agnostic except for the eccentric
// rho, which only disc/pattern carry; the full centre-crossing birth vector
// sets the orbital plane.
fn simplePosition(p: vec3f, packed: u32, theta: f32, centre: vec3f, eccMax: f32) -> vec3f {
        let flags: u32 = (packed >> 16u) & 0xFFu;
        let family: u32 = (flags >> 3u) & 3u;
        let phaseBits: u32 = (packed >> 24u) & 15u;
        let ampBits: u32 = (packed >> 28u) & 15u;
        let q: vec3f = p - centre;
        let radius: f32 = length(q);
        var e0: vec3f = vec3f(1.0, 0.0, 0.0);
        if (radius > 1e-9) { e0 = q / radius; }
        let xy: f32 = length(q.xy);
        var az: vec3f = vec3f(0.0, 1.0, 0.0);
        if (xy > 1e-9) { az = vec3f(-q.y / xy, q.x / xy, 0.0); }
        let eZ: vec3f = cross(e0, az);
        let inc: f32 = orbitInclination(family, phaseBits, ampBits);
        let e1: vec3f = az * cos(inc) + eZ * sin(inc);
        let theta0: f32 = atan2(q.y, q.x);
        let delta: f32 = theta - theta0;
        var rho: f32 = radius;
        if ((family == FAMILY_DISC || family == FAMILY_PATTERN) && eccMax > 0.0 && radius > 0.0) {
                let eccU: f32 = (f32(ampBits) + 0.5) * 0.0625;
                let peri: f32 = f32(phaseBits) * 0.392699081699;
                rho = radius * (1.0 + eccMax * eccU * cos(theta - peri));
        }
        let radial: vec3f = e0 * cos(delta) + e1 * sin(delta);
        return centre + rho * radial;
}
`;

const SIMPLE_STEP = `
// 0.4.5 simple-engine integrator: the friction-field port of orbit.js
// (simpleOmega). One Euler chain per star per frame over the frame's substeps,
// D recomputed every substep — that feedback is the jam. Concatenated after
// the orbit part for the family constants and the pressure clock.
//
// Guards, mirroring the CPU: invisible slots and the centre early-out (no
// log(0)), unarmed packs m = 0 and skips D, the minRadius skip reads the
// birth radius. theta is wrapped every frame so f32 never holds a large angle.

struct SimpleUniform {
        stepA: vec4f,   // h, nSub, count, patternPhase
        stepB: vec4f,   // vFlat, rCore, omegaP, spinLambda
        stepC: vec4f,   // eccMax, m, invTanPitch, armOffset
        stepD: vec4f,   // inv2sig2, Rs, minRadius, centreX
        stepE: vec4f,   // damping, centreY, barTilt, verticalScale
};

struct StepStar {
        x: f32,
        y: f32,
        z: f32,
        packed: u32,
};

@group(0) @binding(0) var<uniform> simple: SimpleUniform;
@group(0) @binding(1) var<storage, read> stepStars: array<StepStar>;
@group(0) @binding(2) var<storage, read_write> stepTheta: array<f32>;

const SIMPLE_R_MIN: f32 = 0.001;
const SIMPLE_MASK_VISIBLE: u32 = 0x00010000u;

fn simpleOmega(th: f32, r0: f32, eccU: f32, peri: f32, family: u32, z: f32) -> f32 {
        let h: f32 = max(simple.stepE.w, 1e-3);
        let vertical: f32 = max(0.0, cos(min(abs(z) / h, 1.0) * HALF_PI));
        if (family == FAMILY_BAR) {
                let circ: f32 = simple.stepB.x / max(r0, simple.stepB.y);
                let rel: f32 = circ - simple.stepB.z;
                var d: f32 = th - simple.stepE.z;
                d = d - TAU * round(d / TAU);
                let axis: f32 = cos(d * 2.0);
                let capture: f32 = exp(-((1.0 - axis) * (1.0 - axis)) * 3.0) * vertical;
                return simple.stepB.z + rel * (0.38 + 0.62 * (1.0 - capture));
        }
        if (family == FAMILY_PRESSURE) {
                return simple.stepB.w * pressureClock(vec4f(simple.stepB.x, simple.stepB.y, 0.0, 0.0), r0);
        }
        let rr: f32 = max(r0, SIMPLE_R_MIN);
        let rho: f32 = rr * (1.0 + simple.stepC.x * eccU * cos(th - peri));
        let circ: f32 = simple.stepB.x / max(rho, simple.stepB.y);
        if (simple.stepC.y < 1.0 || r0 < simple.stepD.z) { return circ; }
        let base: f32 = log(rho / simple.stepD.y) * simple.stepC.z + simple.stepA.w;
        var delta: f32 = (th - base) - simple.stepC.w * floor((th - base) / simple.stepC.w);
        if (delta > simple.stepC.w * 0.5) { delta = delta - simple.stepC.w; }
        // Keep the canonical simple.stepE.x * damp form; damp includes the 3-D cosine.
        let damp: f32 = vertical * exp(-delta * delta * simple.stepD.x);
        return circ * (1.0 - simple.stepE.x * damp);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
        let idx: u32 = gid.x;
        if (idx >= u32(simple.stepA.z)) { return; }
        let star: StepStar = stepStars[idx];
        if ((star.packed & SIMPLE_MASK_VISIBLE) == 0u) { return; }
        let qx: f32 = star.x - simple.stepD.w;
        let qy: f32 = star.y - simple.stepE.y;
        let r0: f32 = length(vec2f(qx, qy));
        let family: u32 = (star.packed >> 19u) & 3u;
        let eccU: f32 = (f32((star.packed >> 28u) & 15u) + 0.5) * 0.0625;
        let peri: f32 = f32((star.packed >> 24u) & 15u) * 0.392699081699;
        var th: f32 = stepTheta[idx];
        let nSub: u32 = u32(simple.stepA.y);
        let h: f32 = simple.stepA.x;
        for (var s: u32 = 0u; s < nSub; s = s + 1u) {
                th = th + simpleOmega(th, r0, eccU, peri, family, star.z) * h;
        }
        stepTheta[idx] = TAU * fract(th * INV_TAU);
}
`;

const STAR_SPRITE = `${ORBIT}
// Path B: additive point sprites, 4 vertices per star (triangle strip).
// WebGPU has no gl_PointSize, so each star is an instanced quad whose corner
// comes from vertex_index.
//
// Address space note: the uniform holds the camera in absolute galactic kpc as
// f32 and the star positions are f32 too. Subtraction happens here, on the GPU,
// so a star 8 kpc away is rendered as a vector a few hundred units long instead
// of as a 8.0000000e3 f32 whose low bits are gone.
//
// HDR pipeline: brightness is the raw linear flux, NOT tone-mapped here. The
// additive blend into the rgba16float intermediate accumulates linearly, so
// dense regions (bulge, arms) sum to brighter pixels with their hue intact.
// The ACES tone-map lives in the tonemap module and runs once per pixel.

struct CameraUniform {
        viewProj: mat4x4<f32>,
        cameraPos: vec4f,   // xyz absolute kpc, w = model centre x (y = z = 0 by construction)
        viewport: vec4f,    // xy pixels, zw = 2/width, 2/height
        params: vec4f,      // x magZero, y baseSizePx, z maxSizePx, w star time Myr
        // Orbit dynamics packed by orbit.packOrbitDynamics — the shader must
        // hard-code no galaxy numbers (checked by wgsl-validate).
        dynA: vec4f,        // vFlat, rCore, omegaPattern, spinLambda
        dynB: vec4f,        // sigmaThin, pressureAmpScale, discHeight, patternLock
        // Wave damping packed by orbit.packOrbitDynamics. Nebulae share this
        // struct and do not read the pair — gas stays on the pattern.
        waveA: vec4f,       // damping, m, K, phase0
        waveB: vec4f,       // Rs, minRadius, amp, patternPhaseOffset
        // Engine select: (id, eccentricityMax, barTiltRadians, spare).
        // Nebulae share this struct and ignore the lane.
        engine: vec4f,
};

struct StarPacked {
        x: f32,
        y: f32,
        z: f32,
        packed: u32,   // 0-7 colorIndex | 8-15 absMag | 16-23 flags | 24-31 jitter
};

@group(0) @binding(0) var<uniform> camera: CameraUniform;
@group(0) @binding(1) var<storage, read> stars: array<StarPacked>;
@group(0) @binding(2) var colorLUT: texture_2d<f32>;
@group(0) @binding(3) var<storage, read> theta: array<f32>;   // simple-engine azimuths

struct VertexOut {
        @builtin(position) clipPos: vec4f,
        @location(0) uv: vec2f,
        @location(1) color: vec3f,
        @location(2) brightness: f32,
};

const ABS_MAG_MIN: f32 = -12.0;
const ABS_MAG_SPAN: f32 = 30.0;
const MASK_VISIBLE: u32 = 0x00010000u;   // flags byte bit 0
const LOG2_OVER_LOG10: f32 = 3.321928095;   // log2(10)
const MAG_TO_FLUX: f32 = 1.328771238;       // 0.4 * log2(10)

fn decodeAbsMag(packed: u32) -> f32 {
        return ABS_MAG_MIN + f32((packed >> 8u) & 0xFFu) * (ABS_MAG_SPAN / 255.0);
}

fn cornerOffset(vid: u32) -> vec2f {
        switch vid {
                case 0u: { return vec2f(-1.0, -1.0); }
                case 1u: { return vec2f( 1.0, -1.0); }
                case 2u: { return vec2f(-1.0,  1.0); }
                case 3u: { return vec2f( 1.0,  1.0); }
                default: { return vec2f(1.0, 1.0); }
        }
}

// A star that must not be drawn: outside the clip volume, zero brightness.
fn hidden(vid: u32) -> VertexOut {
        var out: VertexOut;
        out.clipPos = vec4f(0.0, 0.0, -1.0, 1.0);
        out.uv = vec2f(1.0, 1.0);
        out.color = vec3f(0.0, 0.0, 0.0);
        out.brightness = 0.0;
        return out;
}

@vertex
fn vs_main(
        @builtin(vertex_index) vid: u32,
        @builtin(instance_index) starIdx: u32,
) -> VertexOut {
        let star: StarPacked = stars[starIdx];
        if ((star.packed & MASK_VISIBLE) == 0u) {
                return hidden(vid);
        }

        // 0.4.5 engine branch: uniform control flow, no divergence. The simple
        // lane reconstructs from the compute-integrated azimuth in binding 3.
        var moved: vec3f;
        let birth = vec3f(star.x, star.y, star.z);
        let centre = vec3f(camera.cameraPos.w, 0.0, 0.0);
        moved = orbitPosition(birth, star.packed, centre, camera.params.w, camera.dynA, camera.dynB, camera.waveA, camera.waveB);
        if ((u32(camera.engine.x) & 2u) != 0u) {
                // Simple is a composable friction pass. Its integrated azimuth
                // provides the broad shape; apocenter can then tighten a subset.
                moved = simplePosition(birth, star.packed, theta[starIdx], centre, 0.45);
        }
        if ((u32(camera.engine.x) & 4u) != 0u) {
                moved = apocenterPosition(moved, star.packed, centre, camera.params.w,
                        camera.dynA, camera.waveA, camera.waveB, camera.engine);
        }
        let rel: vec3f = moved - camera.cameraPos.xyz;
        let clip: vec4f = camera.viewProj * vec4f(rel.x, rel.y, rel.z, 1.0);
        if (clip.w <= 0.0) {
                return hidden(vid);   // behind the camera
        }

        let distPc: f32 = max(length(rel) * 1000.0, 0.1);
        let appMag: f32 = decodeAbsMag(star.packed) + 5.0 * log2(distPc) / LOG2_OVER_LOG10 - 5.0;
        let magDiff: f32 = appMag - camera.params.x;   // negative = brighter than the exposure
        let flux: f32 = exp2(-MAG_TO_FLUX * magDiff);
        // No per-star Reinhard: the additive blend into the rgba16float HDR
        // intermediate accumulates linear flux. ACES rolls off the sum once
        // per pixel in the tonemap pass. Without this, dense regions clip to
        // white because each star has already saturated itself to 1.0.

        // Size follows the magnitude difference with a hard pixel floor so
        // even the faintest star renders as at least a sub-pixel point
        // instead of disappearing and re-appearing as the camera rotates
        // (that was the blinking-far-stars bug).
        let sizePx: f32 = camera.params.y * clamp(1.0 - 0.4 * magDiff, 0.4, 2.2);
        let quadPx: f32 = clamp(sizePx, 0.8, camera.params.z);
        // For sub-pixel stars, fade alpha by area ratio so they appear as
        // dim pixels rather than full-bright points. But never fade all the
        // way to zero — MIN_ALPHA keeps even the dimmest catalog star lit.
        let fade: f32 = clamp(sizePx / 0.8, 0.25, 1.0);

        let corner: vec2f = cornerOffset(vid);
        let offset: vec2f = corner * (quadPx * 0.5) * camera.viewport.zw;
        let onePxAlpha: f32 = select(1.0, fade, sizePx < 1.0);

        let colorIndex: u32 = star.packed & 0xFFu;
        let color: vec3f = textureLoad(colorLUT, vec2i(i32(colorIndex), 0), 0).rgb;

        var out: VertexOut;
        out.clipPos = vec4f(clip.xy + offset * clip.w, clip.zw);
        out.uv = corner;
        out.color = color;
        out.brightness = flux * onePxAlpha;
        return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
        // Tight radial profile: (1-r²)^3 shrinks the visible disc to a small
        // core with a faint wing instead of a soft blob. Premultiplied
        // additive: the alpha channel carries the same flux as RGB so the
        // blend (one, one) sums linearly in all four channels.
        let r2: f32 = dot(in.uv, in.uv);
        if (r2 > 1.0) { discard; }
        let s: f32 = 1.0 - r2;
        let falloff: f32 = s * s * s;
        let intensity: f32 = in.brightness * falloff;
        return vec4f(in.color * intensity, intensity);
}
`;

// HDR direct variant of the star sprite is DEPRECATED — the same tonemap
// pass runs on both SDR and HDR outputs; on HDR it allows values >1.0 into
// the rgba16float extended swapchain so highlights reach the monitor's
// headroom. Keeping this module around as a reference for the eventual
// path where we bypass the intermediate on ultra-low-end hardware, but it
// is not wired.
// shape, but reads an extra linearExposure uniform in the fragment stage and
// multiplies the output by it. Used when the swapchain itself is rgba16float
// with toneMapping:'extended' — there is no tonemap pass, so the user's
// `;` / `'` exposure knob has to live in the sprite shader. The output is
// not clamped to 1.0; the HDR canvas + display handle the rest.
const STAR_SPRITE_HDR = `
struct CameraUniform {
        viewProj: mat4x4<f32>,
        cameraPos: vec4f,
        viewport: vec4f,
        params: vec4f,
};

struct StarPacked {
        x: f32,
        y: f32,
        z: f32,
        packed: u32,
};

struct ExposureUniform {
        params: vec4f,   // x = linear exposure multiplier, y = whitePoint (unused on HDR direct)
};

@group(0) @binding(0) var<uniform> camera: CameraUniform;
@group(0) @binding(1) var<storage, read> stars: array<StarPacked>;
@group(0) @binding(2) var colorLUT: texture_2d<f32>;
@group(0) @binding(3) var<uniform> exposure: ExposureUniform;

struct VertexOut {
        @builtin(position) clipPos: vec4f,
        @location(0) uv: vec2f,
        @location(1) color: vec3f,
        @location(2) brightness: f32,
};

const ABS_MAG_MIN: f32 = -12.0;
const ABS_MAG_SPAN: f32 = 30.0;
const MASK_VISIBLE: u32 = 0x00010000u;
const LOG2_OVER_LOG10: f32 = 3.321928095;
const MAG_TO_FLUX: f32 = 1.328771238;

fn decodeAbsMag(packed: u32) -> f32 {
        return ABS_MAG_MIN + f32((packed >> 8u) & 0xFFu) * (ABS_MAG_SPAN / 255.0);
}

fn cornerOffset(vid: u32) -> vec2f {
        switch vid {
                case 0u: { return vec2f(-1.0, -1.0); }
                case 1u: { return vec2f( 1.0, -1.0); }
                case 2u: { return vec2f(-1.0,  1.0); }
                case 3u: { return vec2f( 1.0,  1.0); }
                default: { return vec2f(1.0, 1.0); }
        }
}

fn hidden(vid: u32) -> VertexOut {
        var out: VertexOut;
        out.clipPos = vec4f(0.0, 0.0, -1.0, 1.0);
        out.uv = vec2f(1.0, 1.0);
        out.color = vec3f(0.0, 0.0, 0.0);
        out.brightness = 0.0;
        return out;
}

@vertex
fn vs_main(
        @builtin(vertex_index) vid: u32,
        @builtin(instance_index) starIdx: u32,
) -> VertexOut {
        let star: StarPacked = stars[starIdx];
        if ((star.packed & MASK_VISIBLE) == 0u) {
                return hidden(vid);
        }

        let rel: vec3f = vec3f(star.x, star.y, star.z) - camera.cameraPos.xyz;
        let clip: vec4f = camera.viewProj * vec4f(rel.x, rel.y, rel.z, 1.0);
        if (clip.w <= 0.0) {
                return hidden(vid);
        }

        let distPc: f32 = max(length(rel) * 1000.0, 0.1);
        let appMag: f32 = decodeAbsMag(star.packed) + 5.0 * log2(distPc) / LOG2_OVER_LOG10 - 5.0;
        let magDiff: f32 = appMag - camera.params.x;
        let flux: f32 = exp2(-MAG_TO_FLUX * magDiff);

        let sizePx: f32 = camera.params.y * clamp(1.0 - 0.4 * magDiff, 0.4, 2.2);
        let quadPx: f32 = clamp(sizePx, 0.8, camera.params.z);
        let fade: f32 = clamp(sizePx / 0.8, 0.25, 1.0);

        let corner: vec2f = cornerOffset(vid);
        let offset: vec2f = corner * (quadPx * 0.5) * camera.viewport.zw;
        let onePxAlpha: f32 = select(1.0, fade, sizePx < 1.0);

        let colorIndex: u32 = star.packed & 0xFFu;
        let color: vec3f = textureLoad(colorLUT, vec2i(i32(colorIndex), 0), 0).rgb;

        var out: VertexOut;
        out.clipPos = vec4f(clip.xy + offset * clip.w, clip.zw);
        out.uv = corner;
        out.color = color;
        out.brightness = flux * onePxAlpha;
        return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
        // Same falloff and additive math as the SDR variant. On the HDR direct
        // path we multiply by exposure.params.x (brightness) and pass linear
        // values through to the rgba16float swapchain; the display does its
        // own rolloff.
        let r2: f32 = dot(in.uv, in.uv);
        if (r2 > 1.0) { discard; }
        let s: f32 = 1.0 - r2;
        let falloff: f32 = s * s * s;
        let intensity: f32 = in.brightness * falloff * exposure.params.x;
        return vec4f(in.color * intensity, intensity);
}
`;

const TONEMAP = `
// Fullscreen-triangle tone-map pass. Reads the rgba16float HDR intermediate
// (additive linear flux summed across all stars) and writes the final pixel
// to the swapchain.
//
// Design goals (tuned against Stellarium / Gaia Sky behaviour and user
// feedback on earlier attempts):
//   * White-point slider must be visibly dramatic.
//   * Saturation slider must clearly separate blue O/B stars from yellow G
//     and red M/K, even in the dense galactic bulge.
//   * Bright clusters must NOT all wash to white instantly (the user's
//     earlier complaint: "with exposure added, everything becomes white").
//   * On HDR displays (rgba16float + toneMapping:'extended'), values above
//     1.0 must remain >1.0 after the curve so the monitor's headroom shows
//     real highlights. On SDR the output is clamped to [0,1].
//
// Pipeline per pixel:
//   1. Multiply linear HDR by exposure.
//   2. Convert to CIE xyY (Rec.709 LUMA) so we compress luminance only.
//   3. Divide luminance by white point; pass through a Hable/Unreal filmic
//      curve parameterised by white point (shoulder). Outputs 0..1 for
//      SDR, but on HDR we scale by whitePoint again so highlights above
//      the knee exceed 1.0 into the swapchain.
//   4. Reconstruct RGB via chromaticity ratio (hue preserved).
//   5. Apply saturation boost around the compressed luminance.
//   6. Filmic highlight desaturation: very bright stars gently lose
//      chroma as they approach white — this mimics real film/sensor
//      bloom where overexposed stars do clip to white but only the very
//      brightest, not every star in a cluster.
//   7. Clamp to [0,1] on SDR, leave unclamped (up to a ceiling) on HDR.
//   8. Output linear RGB. On an SDR canvas (colorSpace:'srgb') WebGPU
//      applies linear→sRGB on presentation. On an HDR canvas (rgba16float
//      + toneMapping:'extended') the values stay linear and the display
//      maps them to its nit range.
//
// Uniform:
//   x = linear exposure multiplier (brightness)
//   y = white point (scene luminance mapped to ~display white; lower =
//       more highlights clip to white, higher = more headroom / colour
//       kept)
//   z = saturation (0.5 greyscale … 3.0 hyper-saturated, 1.0 natural)
//   w = output mode (0.0 = SDR clamp to [0,1], 1.0 = HDR allow >1)
// 0.4.5 second vec4:
//   x = headroom (HDR ceiling, 1..8; matches the display-nits mapping of
//       the demo present pass — 4 ≈ 400 nits on a 100-nit reference)
//   y = highlight desaturation (0 = keep pure hues to any peak, 1 =
//       today's film fade to white)
//   z, w = 0

struct TonemapUniform {
	params: vec4f,
	params2: vec4f,
};

@group(0) @binding(0) var<uniform> u: TonemapUniform;
@group(0) @binding(1) var hdrTexture: texture_2d<f32>;

const LUMA_R: f32 = 0.2126;
const LUMA_G: f32 = 0.7152;
const LUMA_B: f32 = 0.0722;

// Hable/Unreal filmic curve — chosen because it has a soft toe, a natural
// shoulder, and a single white-point parameter that visibly shifts the
// rolloff. Constants from Hable 2010 ("Uncharted 2" filmic tone mapping).
fn hableFilmic(x: f32) -> f32 {
	let A: f32 = 0.15;
	let B: f32 = 0.50;
	let C: f32 = 0.10;
	let D: f32 = 0.20;
	let E: f32 = 0.02;
	let F: f32 = 0.30;
	return ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F;
}

@vertex
fn vs_main(@builtin(vertex_index) vid: u32) -> @builtin(position) vec4f {
	var p: array<vec2f, 3> = array<vec2f, 3>(
		vec2f(-1.0, -3.0),
		vec2f(-1.0,  1.0),
		vec2f( 3.0,  1.0),
	);
	return vec4f(p[vid], 0.0, 1.0);
}

@fragment
fn fs_main(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
	let texel: vec2i = vec2i(i32(fragCoord.x), i32(fragCoord.y));
	let hdr: vec3f = textureLoad(hdrTexture, texel, 0).rgb * u.params.x;

	// --- Luminance (CIE Rec.709) ----------------------------------------
	let lumaIn: f32 = max(1e-6, dot(hdr, vec3f(LUMA_R, LUMA_G, LUMA_B)));

	// --- Filmic curve applied to luminance only -------------------------
	// Normalise by white point so that white-point = 1 clips aggressively
	// (instant blown highlights) and white-point = 16 keeps colour way
	// into the bright range. We denormalise by the inverse of hable(1)
	// so that input y = whitePoint maps exactly to output 1.0 on SDR.
	let wp: f32 = max(u.params.y, 0.001);
	let yNorm: f32 = lumaIn / wp;
	let curveWhite: f32 = hableFilmic(1.0);
	let lumaCompressed: f32 = hableFilmic(yNorm) / curveWhite;

	// --- Chromaticity reconstruction (hue preserving) ------------------
	// Scale RGB by the compression ratio so the colour ratios stay
	// intact (hue does not shift as we roll off).
	var mapped: vec3f = hdr * (lumaCompressed / lumaIn * wp);

	// --- Saturation -----------------------------------------------------
	let mappedLuma: f32 = dot(mapped, vec3f(LUMA_R, LUMA_G, LUMA_B));
	let sat: f32 = max(0.0, u.params.z);
	mapped = mix(vec3f(mappedLuma), mapped, sat);

	// --- Filmic highlight desaturation ---------------------------------
	// Bright pixels above the shoulder fade to white gently. This is
	// what makes overexposed stars look like starlight (white core with
	// a coloured halo) instead of either staying neon-coloured all the
	// way or instantly clipping. The fade starts when the compressed
	// luminance exceeds 0.85 (i.e. bright but not yet clipped) and
	// reaches full white at ~2× the white point.
	let over: f32 = clamp((yNorm - 0.85) / 1.5, 0.0, 1.0);
	let overLuma: f32 = dot(mapped, vec3f(LUMA_R, LUMA_G, LUMA_B));
	mapped = mix(mapped, vec3f(max(1.0, overLuma)), over * over * clamp(u.params2.y, 0.0, 1.0));

	// --- Output mode ----------------------------------------------------
	// w = 0 (SDR): clamp to [0,1], canvas does sRGB encode.
	// w = 1 (HDR): clamp to the headroom knob (default 8.0, today's
	// ceiling; 4.0 ≈ 400 nits on a 100-nit reference), canvas uses
	// toneMapping:'extended' so values >1 reach the monitor's headroom.
	if (u.params.w < 0.5) {
		mapped = clamp(mapped, vec3f(0.0), vec3f(1.0));
	} else {
		mapped = clamp(mapped, vec3f(0.0), vec3f(max(1.0, u.params2.x)));
	}

	return vec4f(mapped, 1.0);
}
`;

const PROCEDURAL_GEN = `
// Compute path (Milestone 3, not wired yet): generate procedural stars per
// cell around the camera. Density is the source of truth: the expected count
// of a cell is rho(cellCentre) * cellVolume * scale, and the fractional part
// is resolved by a hash roll so the field is stable and gets denser (never
// different) as scale rises.

struct StarPacked {
        x: f32,
        y: f32,
        z: f32,
        packed: u32,
};

struct GenParams {
        cellSize: f32,
        scale: f32,
        seed: u32,
        maxStarsPerCell: u32,
        cameraPos: vec3f,
        pad: f32,
};

struct CellOrigin {
        origin: vec3f,
        pad: f32,
};

@group(0) @binding(0) var<uniform> params: GenParams;
@group(0) @binding(1) var<uniform> cell: CellOrigin;
@group(0) @binding(2) var<storage, read_write> starBuffer: array<StarPacked>;
@group(0) @binding(3) var<storage, read_write> starCount: atomic<u32>;
@group(0) @binding(4) var<uniform> budget: vec4u;   // x maxStars
// The density field's numbers, packed from the GalaxyModel by
// galaxy.packDensityParams — one upload per galaxy, never per frame.
@group(0) @binding(5) var<uniform> densityParams: DensityParams;

const FLAG_VISIBLE: u32 = 1u;
const ABS_MAG_MIN: f32 = -12.0;
const ABS_MAG_SPAN: f32 = 30.0;
const LOG2_OVER_LOG10: f32 = 3.321928095;

const MASS_TEFF_MASS: array<f32, 18> = array<f32, 18>(
        0.08, 0.10, 0.15, 0.20, 0.30, 0.45, 0.70, 0.85, 1.00,
        1.50, 2.00, 3.00, 5.00, 9.00, 16.0, 30.0, 60.0, 100.0,
);
const MASS_TEFF_TEFF: array<f32, 18> = array<f32, 18>(
        2400.0, 2800.0, 3200.0, 3400.0, 3600.0, 3800.0, 4500.0, 5000.0, 5800.0,
        6800.0, 9000.0, 12000.0, 16000.0, 22000.0, 30000.0, 38000.0, 45000.0, 50000.0,
);

fn luminosityFromMass(m: f32) -> f32 {
        if (m < 0.7) { return pow(m, 2.3); }
        if (m < 2.0) { return pow(m, 4.0); }
        if (m < 20.0) { return pow(m, 3.5); }
        return pow(m, 2.8);
}

fn teffFromMass(m: f32) -> f32 {
        if (m <= MASS_TEFF_MASS[0]) { return MASS_TEFF_TEFF[0]; }
        if (m >= MASS_TEFF_MASS[17]) { return MASS_TEFF_TEFF[17]; }
        for (var i: u32 = 0u; i < 17u; i = i + 1u) {
                let lo: f32 = MASS_TEFF_MASS[i];
                let hi: f32 = MASS_TEFF_MASS[i + 1u];
                if (m < lo || m > hi) { continue; }
                let t: f32 = (log2(m) - log2(lo)) / (log2(hi) - log2(lo));
                return exp2((1.0 - t) * log2(MASS_TEFF_TEFF[i]) + t * log2(MASS_TEFF_TEFF[i + 1u]));
        }
        return 5772.0;
}

fn msLifetimeGyr(m: f32) -> f32 {
        return min(15.0, max(0.003, 10.0 * m / luminosityFromMass(m)));
}

// 0.4.5: the giant branch lasts a slice of the main-sequence life, then the
// star is a cooling remnant. Mirrors star-types.giantLifetimeGyr exactly —
// the deadline all evolution states downstream hang off.
const TGIANT_FRAC: f32 = 0.15;
const TGIANT_MIN: f32 = 0.002;
const TGIANT_MAX: f32 = 1.0;
const WD_COOL_TAU: f32 = 8.0;
const WD_TEFF_FLOOR: f32 = 4000.0;
const WD_LUM_FLOOR: f32 = 0.0005;

fn giantLifetimeGyr(m: f32) -> f32 {
        return clamp(TGIANT_FRAC * msLifetimeGyr(m), TGIANT_MIN, TGIANT_MAX);
}

fn sampleMassIMF(u: f32) -> f32 {
        let alpha: f32 = 2.35;
        let xMin: f32 = pow(0.08, 1.0 - alpha);
        let xMax: f32 = pow(100.0, 1.0 - alpha);
        return pow(xMin + (xMax - xMin) * u, 1.0 / (1.0 - alpha));
}

// Mirrors galaxy.sfhCumulative: the delayed exponential SFR ∝ t·exp(−t/τ)
// integrated and normalised, in x = t/τ. One distribution for the ages, the
// formation windows and the gas the SFH has not yet consumed.
fn sfhCumulative(x: f32) -> f32 {
        return 1.0 - exp(-x) * (1.0 + x);
}

// Bisection steps for the inverse. F has no elementary inverse (it is a Lambert
// W), and a per-model table cannot ride in a uniform, so the shader solves it
// where the CPU keeps a table instead: 14 halvings put t_f inside
// span/2^14 ≈ 1e-3 Gyr of the exact root, and a generated cell does this once
// per star. wgsl-exec-check holds the two sides to 0.05 Gyr, which is far
// coarser than anything downstream reads — evolution states flip on
// main-sequence lifetimes.
const SFH_BISECT_STEPS: u32 = 14u;

// Mirrors star-types.sfhFormationTime: the formation time t_f at which the
// model's truncated SFH has produced a fraction q of its stars. τ arrives
// clamped positive by galaxy.solvePopulationClock, so the division is safe.
fn sfhFormationTime(params: DensityParams, q: f32) -> f32 {
        let tau: f32 = params.clock.y;
        let span: f32 = params.clock.z;
        if (span <= 0.0) { return 0.0; }
        let xEnd: f32 = span / tau;
        let target: f32 = clamp(q, 0.0, 1.0) * sfhCumulative(xEnd);
        var lo: f32 = 0.0;
        var hi: f32 = xEnd;
        for (var s: u32 = 0u; s < SFH_BISECT_STEPS; s = s + 1u) {
                let mid: f32 = 0.5 * (lo + hi);
                if (sfhCumulative(mid) < target) { lo = mid; } else { hi = mid; }
        }
        return 0.5 * (lo + hi) * tau;
}

// Mirrors star-types.sampleFormationTime: a component's slice of the galaxy's
// SFH. The window is the CDF interval the CPU solved from
// galaxy.FORMATION_WINDOW, indexed like COMPONENT_*, so the shape inside the
// window is still the galaxy's own burst — a component that forms over the first
// quarter of a burst is front-loaded like the burst, not uniform in time.
fn sampleFormationTime(params: DensityParams, component: u32, u: f32) -> f32 {
        var lo: f32 = params.formLo.x;
        var hi: f32 = params.formHi.x;
        if (component == COMPONENT_THICK) { lo = params.formLo.y; hi = params.formHi.y; }
        else if (component == COMPONENT_BULGE) { lo = params.formLo.z; hi = params.formHi.z; }
        else if (component == COMPONENT_HALO) { lo = params.formLo.w; hi = params.formHi.w; }
        return sfhFormationTime(params, lo + (hi - lo) * u);
}

// The arm branch's oldest newborn, mirroring star-types.YOUNG_ARM_MAX_GYR.
const YOUNG_ARM_MAX_GYR: f32 = 0.3;

// Mirrors star-types.sampleLocalAge / classifyByTempAndState. A gas-poor disc
// forms nothing young, which is the whole of what a quenched type's population
// means here; the star-forming annulus is the model's, not a hard-coded 3..12.
// Off the arms a star is (age − t_f), which is what makes the assembly order
// (halo first, thin disc still forming) survive at any age and keeps every star
// younger than its galaxy.
fn sampleLocalAge(params: DensityParams, component: u32, distToArm: f32, R: f32, u1: f32, u2: f32) -> f32 {
        if (component == COMPONENT_THIN && params.populations.z >= 0.5) {
                // Gaussian ridge gate, not a hard cut — mirrors star-types exactly: the
                // newborn lane is a half-normal whose sigma is the pattern's own ridge
                // width, 0.12 * (2*pi*R*sin(pitch)/m) / (1 + amp), so every type's O/B
                // stars hug their own arms instead of an MW-tuned distance.
                let ridgeLambda: f32 = 6.283185307 * R * sin(radians(params.arms.z)) / max(1.0, params.arms.x);
                let armWidth: f32 = 0.12 * ridgeLambda / (1.0 + params.arms.y);
                let pArm: f32 = exp(-0.5 * distToArm * distToArm / (armWidth * armWidth));
                if (u2 < pArm && R > params.arms.w && R < params.populations.y) {
                        return min(params.clock.x, pow(u1, 3.0) * YOUNG_ARM_MAX_GYR);
                }
        }
        return params.clock.x - sampleFormationTime(params, component, u1);
}

fn classifyByTempAndState(teff: f32, state: u32) -> u32 {
        if (state == 1u) { return 7u; }   // white dwarf
        if (state == 2u) { return 8u; }   // red giant
        if (teff >= 30000.0) { return 0u; }
        if (teff >= 10000.0) { return 1u; }
        if (teff >= 7500.0) { return 2u; }
        if (teff >= 6000.0) { return 3u; }
        if (teff >= 5200.0) { return 4u; }
        if (teff >= 3700.0) { return 5u; }
        return 6u;
}

fn packRecord(x: f32, y: f32, z: f32, colorIndex: u32, absMag: f32, jitter: u32) -> StarPacked {
        let clamped: f32 = clamp((absMag - ABS_MAG_MIN) / ABS_MAG_SPAN, 0.0, 1.0);
        let magByte: u32 = u32(clamped * 255.0) & 0xFFu;
        var rec: StarPacked;
        rec.x = x;
        rec.y = y;
        rec.z = z;
        rec.packed = (colorIndex & 0xFFu) | (magByte << 8u) | (FLAG_VISIBLE << 16u) | ((jitter & 0xFFu) << 24u);
        return rec;
}

@compute @workgroup_size(64, 1, 1)
fn main(@global_invocation_id gid: vec3u) {
        let cellId: vec3i = vec3i(gid) + vec3i(cell.origin);
        let origin: vec3f = vec3f(cellId) * params.cellSize;
        let centre: vec3f = origin + vec3f(params.cellSize * 0.5);

        let lambda: f32 = rhoTotal(densityParams, centre.x, centre.y, centre.z)
                * params.cellSize * params.cellSize * params.cellSize * params.scale;
        let cellSeed: u32 = hash4(params.seed, u32(cellId.x), u32(cellId.y), u32(cellId.z));
        let whole: u32 = u32(floor(lambda));
        var count: u32 = whole;
        if (hash01(cellSeed ^ 0xFEEDF00Du) < (lambda - f32(whole))) { count = count + 1u; }
        count = min(count, min(params.maxStarsPerCell, 64u));

        for (var slot: u32 = 0u; slot < count; slot = slot + 1u) {
                let idx: u32 = atomicAdd(starCount, 1u);
                if (idx >= budget.x) { return; }

                let slotSeed: u32 = hash4(cellSeed, slot * 31u + 7u, params.seed, 0u);
                let jitter: vec3f = hash3D(slotSeed + 1u);
                let pos: vec3f = origin + jitter * params.cellSize;

                let component: u32 = sampleComponent(densityParams, pos.x, pos.y, pos.z, hash01(slotSeed + 7u));
                let dx: f32 = pos.x - densityParams.centre.x;
                let dy: f32 = pos.y - densityParams.centre.y;
                let R: f32 = sqrt(dx * dx + dy * dy);
                let distToArm: f32 = distanceToNearestArm(densityParams, R, atan2(dy, dx));

                let mass: f32 = sampleMassIMF(hash01(slotSeed * 31u + 1u));
                let age: f32 = sampleLocalAge(densityParams, component, distToArm, R, hash01(slotSeed * 31u + 2u), hash01(slotSeed * 31u + 3u));

                // 0.4.5: below 8 Msun the giant branch is temporary — past
                // tMS*1.1 + tGiant the star is a cooling white dwarf, as in
                // star-types.evolveStar. Giants concentrate at the turnoff
                // instead of accumulating forever.
                var state: u32 = 0u;
                var teff: f32 = teffFromMass(mass);
                var lum: f32 = luminosityFromMass(mass);
                let tMS: f32 = msLifetimeGyr(mass);
                let tDeath: f32 = tMS * 1.1 + giantLifetimeGyr(mass);
                if (age > tDeath) {
                        state = 1u;
                        let cool: f32 = exp(-(age - tDeath) / WD_COOL_TAU);
                        teff = WD_TEFF_FLOOR + (8000.0 + 30000.0 * hash01(slotSeed * 31u + 4u) - WD_TEFF_FLOOR) * cool;
                        lum = WD_LUM_FLOOR + (0.001 + 0.1 * hash01(slotSeed * 31u + 5u)) * cool;
                } else if (age > tMS * 1.1) {
                        if (mass >= 8.0) {
                                state = 1u;
                                teff = 8000.0 + 30000.0 * hash01(slotSeed * 31u + 4u);
                                lum = 0.001 + 0.1 * hash01(slotSeed * 31u + 5u);
                        } else {
                                state = 2u;
                                teff = 3000.0 + 1000.0 * hash01(slotSeed * 31u + 4u);
                                lum = 100.0 + 10000.0 * hash01(slotSeed * 31u + 5u);
                        }
                }

                var cls: u32 = classifyByTempAndState(teff, state);
                if (component == COMPONENT_THIN && state == 0u) {
                        // Radial metallicity gradient: +1 colour step reached
                        // at R = 2*L/steep, clamped at M — mirrors
                        // star-types.deriveStar. DensityParams, not GenParams:
                        // the latter has no populations/thin groups.
                        let steep: f32 = densityParams.populations.w;
                        if (steep > 0.0) {
                                let shift: u32 = u32(min(1.0, floor(R * steep / (2.0 * densityParams.thin.x))));
                                cls = min(6u, cls + shift);
                        }
                } else if (component == COMPONENT_BULGE && state == 2u && hash01(slotSeed * 31u + 4u) < 0.2) {
                        // 20% of metal-poor spheroid giants land in the
                        // dedicated RGe slot (the last LUT entry).
                        cls = 9u;
                }
                let absMag: f32 = 4.83 - 2.5 * log2(max(1e-6, lum)) / LOG2_OVER_LOG10;
                let jitterByte: u32 = pcgHash(slotSeed + 0xFACEu) & 0xFFu;
                starBuffer[idx] = packRecord(pos.x, pos.y, pos.z, cls, absMag, jitterByte);
        }
}

@compute @workgroup_size(1)
fn resetCounter() {
        atomicStore(&starCount, 0u);
}
`;

const CULL = `
// Compute path (Milestone 3, not wired yet): frustum cull + stable hash
// thinning + indirect draw args, so the CPU never reads back the visible list.
// Mirrors the priority/thinning model validated in experiments/filter-test.js.
//
// Indirect args are for the sprite pipeline: [4 vertices, instanceCount, 0, 0].

struct StarPacked {
        x: f32,
        y: f32,
        z: f32,
        packed: u32,
};

struct CullCamera {
        position: vec4f,
        viewDir: vec4f,
        up: vec4f,
        right: vec4f,
        fovY: f32,
        aspect: f32,
        near: f32,
        far: f32,
        targetDensity: f32,
        lodLevel: u32,
        cellId: u32,
        pad: vec2f,
};

struct CullCounts {
        candidateCount: u32,
        maxVisible: u32,
        pad: vec2u,
};

@group(0) @binding(0) var<storage, read> candidateBuffer: array<StarPacked>;
@group(0) @binding(1) var<storage, read_write> visibleIndexBuffer: array<u32>;
@group(0) @binding(2) var<storage, read_write> visibleCount: atomic<u32>;
@group(0) @binding(3) var<storage, read_write> indirectArgs: array<u32>;
@group(0) @binding(4) var<uniform> camera: CullCamera;
@group(0) @binding(5) var<uniform> counts: CullCounts;

const VERTICES_PER_SPRITE: u32 = 4u;
const ABS_MAG_MIN: f32 = -12.0;
const ABS_MAG_SPAN: f32 = 30.0;
const MASK_LANDMARK: u32 = 0x00020000u;
const MASK_VISIBLE: u32 = 0x00010000u;

fn decodeAbsMag(packed: u32) -> f32 {
        return ABS_MAG_MIN + f32((packed >> 8u) & 0xFFu) * (ABS_MAG_SPAN / 255.0);
}

// Apparent magnitude at the camera, as in the sprite vertex shader.
fn apparentMagnitude(absMag: f32, distKpc: f32) -> f32 {
        return absMag + 5.0 * log2(max(distKpc * 1000.0, 0.1)) / 3.321928095 - 5.0;
}

fn inFrustum(rel: vec3f) -> bool {
        let dist: f32 = length(rel);
        if (dist < camera.near || dist > camera.far) { return false; }
        let depth: f32 = dot(rel, camera.viewDir.xyz);
        if (depth < camera.near) { return false; }
        let halfHeight: f32 = depth * tan(camera.fovY * 0.5);
        let halfWidth: f32 = halfHeight * camera.aspect;
        // 10% margin so a sprite that is only half visible still gets drawn.
        let x: f32 = dot(rel, camera.right.xyz);
        let y: f32 = dot(rel, camera.up.xyz);
        return abs(x) <= halfWidth * 1.1 && abs(y) <= halfHeight * 1.1;
}

@compute @workgroup_size(64, 1, 1)
fn main(@global_invocation_id gid: vec3u) {
        let idx: u32 = gid.x;
        if (idx >= counts.candidateCount) { return; }

        let star: StarPacked = candidateBuffer[idx];
        if ((star.packed & MASK_VISIBLE) == 0u) { return; }

        let rel: vec3f = vec3f(star.x, star.y, star.z) - camera.position.xyz;
        if (!inFrustum(rel)) { return; }

        // Below the faint cut-off a star contributes nothing at the current
        // exposure, so it never reaches the vertex shader.
        let isLandmark: bool = (star.packed & MASK_LANDMARK) != 0u;
        let appMag: f32 = apparentMagnitude(decodeAbsMag(star.packed), length(rel));
        if (!isLandmark && appMag > camera.targetDensity) { return; }

        // Stable thinning: same star, same cell, same LOD always resolves the same
        // way, so stars never pop in and out between frames.
        let roll: f32 = hash01(hash4(idx, camera.cellId, camera.lodLevel, 0u));
        if (roll >= min(1.0, camera.targetDensity / max(1.0, appMag + 22.0))) { return; }

        let slot: u32 = atomicAdd(visibleCount, 1u);
        if (slot >= counts.maxVisible) {
                atomicSub(visibleCount, 1u);
                return;
        }
        visibleIndexBuffer[slot] = idx;
}

@compute @workgroup_size(1)
fn resetArgs() {
        atomicStore(&visibleCount, 0u);
        indirectArgs[0] = VERTICES_PER_SPRITE;
        indirectArgs[1] = 0u;
        indirectArgs[2] = 0u;
        indirectArgs[3] = 0u;
}

@compute @workgroup_size(1)
fn finalizeArgs() {
        indirectArgs[1] = atomicLoad(&visibleCount);
}
`;

const NEBULA_BILLBOARD = `
// Additive nebula billboards (0.3.2b). Camera-facing quads, size from the
// object's shell radius, colour from nebula.NEBULA_COLORS. Soft radial
// falloff, no image assets. GPU-culled below BILLBOARD_MIN_PX and beyond
// BILLBOARD_MAX_DIST kpc. Constants are mirrored from src/math/objects.js
// and Camera.FOV_Y.
//
// 0.4: gas is the pattern family (plan §1.1/§7.4) — young objects sit in the
// arms and bar, so billboards rigidly follow the pattern speed omegaPattern
// about the model centre, same closed form as the stars' bulk rotation.

struct CameraUniform {
        viewProj: mat4x4<f32>,
        cameraPos: vec4f,   // w = model centre x (y = z = 0 by construction)
        viewport: vec4f,
        params: vec4f,      // w = star time Myr
        dynA: vec4f,        // orbit dynamics: nebulae read z = omegaPattern
        dynB: vec4f,
        waveA: vec4f,       // shared layout with the star shader; nebulae ignore it
        waveB: vec4f,
        engine: vec4f,      // engine select lane; nebulae ignore it (gas rides the pattern)
};

struct NebulaPacked {
        x: f32,
        y: f32,
        z: f32,
        size: f32,
        r: f32,
        g: f32,
        b: f32,
        opacity: f32,
};

@group(0) @binding(0) var<uniform> camera: CameraUniform;
@group(0) @binding(1) var<storage, read> nebulae: array<NebulaPacked>;

struct VertexOut {
        @builtin(position) clipPos: vec4f,
        @location(0) uv: vec2f,
        @location(1) color: vec3f,
        @location(2) brightness: f32,
};

const FOV_Y: f32 = 1.047197551;
const BILLBOARD_MIN_PX: f32 = 4.0;
const BILLBOARD_MAX_DIST: f32 = 5.0;

fn cornerOffset(vid: u32) -> vec2f {
        switch vid {
                case 0u: { return vec2f(-1.0, -1.0); }
                case 1u: { return vec2f( 1.0, -1.0); }
                case 2u: { return vec2f(-1.0,  1.0); }
                case 3u: { return vec2f( 1.0,  1.0); }
                default: { return vec2f(1.0, 1.0); }
        }
}

fn hidden(vid: u32) -> VertexOut {
        var out: VertexOut;
        out.clipPos = vec4f(0.0, 0.0, -1.0, 1.0);
        out.uv = vec2f(1.0, 1.0);
        out.color = vec3f(0.0, 0.0, 0.0);
        out.brightness = 0.0;
        return out;
}

@vertex
fn vs_main(
        @builtin(vertex_index) vid: u32,
        @builtin(instance_index) idx: u32,
) -> VertexOut {
        let neb: NebulaPacked = nebulae[idx];
        if (neb.size <= 0.0 || neb.opacity <= 0.0) {
                return hidden(vid);
        }

        // Pattern-family bulk rotation about the model centre (T = 0 is the
        // identity: theta = fract(0) = 0). No wobble: gas is rigid with the
        // arms and bar.
        let theta: f32 = 6.28318530718 * fract((camera.dynA.z * camera.params.w + camera.waveB.w) * 0.159154943092);
        let qx: f32 = neb.x - camera.cameraPos.w;
        let cth: f32 = cos(theta); let sth: f32 = sin(theta);
        let rel: vec3f = vec3f(cth * qx - sth * neb.y + camera.cameraPos.w,
                sth * qx + cth * neb.y, neb.z);
        let dist: f32 = length(rel);
        if (dist > BILLBOARD_MAX_DIST) {
                return hidden(vid);
        }

        let clip: vec4f = camera.viewProj * vec4f(rel.x, rel.y, rel.z, 1.0);
        if (clip.w <= 0.0) {
                return hidden(vid);
        }

        let sizePx: f32 = neb.size / max(dist, 1.0e-6) * camera.viewport.y / tan(FOV_Y * 0.5);
        if (sizePx < BILLBOARD_MIN_PX) {
                return hidden(vid);
        }

        let corner: vec2f = cornerOffset(vid);
        let offset: vec2f = corner * (sizePx * 0.5) * camera.viewport.zw;

        var out: VertexOut;
        out.clipPos = vec4f(clip.xy + offset * clip.w, clip.zw);
        out.uv = corner;
        out.color = vec3f(neb.r, neb.g, neb.b);
        out.brightness = neb.opacity;
        return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
        let r2: f32 = dot(in.uv, in.uv);
        if (r2 > 1.0) { discard; }
        let s: f32 = 1.0 - r2;
        let falloff: f32 = s * s;
        let intensity: f32 = in.brightness * falloff;
        return vec4f(in.color * intensity, intensity);
}
`;

// Mirror parts, kept separate so the validator can diff each one against its
// JS counterpart in src/math/.
const SHADER_PARTS = {
        'pcg-hash': PCG_HASH,
        'density': DENSITY,
        'orbit': ORBIT,
        'simple-step': SIMPLE_STEP,
        'star-sprite': STAR_SPRITE,
        'star-sprite-hdr': STAR_SPRITE_HDR,
        'nebula-billboard': NEBULA_BILLBOARD,
        'tonemap': TONEMAP,
        'procedural-gen': PROCEDURAL_GEN,
        'cull': CULL,
};

// Complete, compilable modules. WGSL has no include mechanism, so the shared
// parts are concatenated here rather than fake-included in the source.
const SHADERS = {
        'star-sprite': PCG_HASH + STAR_SPRITE,
        'star-sprite-hdr': STAR_SPRITE_HDR,
        'nebula-billboard': NEBULA_BILLBOARD,
        'tonemap': TONEMAP,
        'procedural-gen': PCG_HASH + DENSITY + PROCEDURAL_GEN,
        'cull': PCG_HASH + CULL,
        'simple-step': PCG_HASH + ORBIT + SIMPLE_STEP,
};

// Wired shaders: the renderer compiles star-sprite + nebula-billboard + tonemap
// every frame, plus simple-step when the simple engine is selected.
// star-sprite-hdr is kept as a reference module and is not bound.
const WIRED_SHADERS = ['star-sprite', 'star-sprite-hdr', 'nebula-billboard', 'tonemap', 'simple-step'];

const GalaxyShaders = { SHADERS, SHADER_PARTS, WIRED_SHADERS };
if (typeof module !== 'undefined') module.exports = GalaxyShaders;
if (typeof window !== 'undefined') window.GalaxyShaders = GalaxyShaders;
