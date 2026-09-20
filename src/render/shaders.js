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
//   density        mirrors src/math/density.js
//   star-sprite    WIRED — Path B point sprites (the fly-through render path)
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
// Analytical Milky Way density model — mirrors src/math/density.js.
// Units: kpc. Sun at origin, X toward galactic centre (l=0), Y toward l=90,
// Z toward the north galactic pole.
//
// Only the pieces the compute path needs are mirrored; the sampler in
// src/math/sampling.js has no WGSL counterpart (the GPU never samples
// positions, it evaluates density per cell).

const GALACTIC_R0: f32 = 8.178;
const GALACTIC_CENTRE_X: f32 = 8.178;
const GALACTIC_CENTRE_Y: f32 = 0.0;

const THIN_L: f32 = 2.6;
const THIN_H: f32 = 0.300;
const THIN_AMP: f32 = 1.0;

const THICK_L: f32 = 3.5;
const THICK_H: f32 = 0.900;
const THICK_AMP: f32 = 0.12;

const BULGE_A: f32 = 1.5;
const BULGE_B: f32 = 0.5;
const BULGE_C: f32 = 0.4;
const BULGE_R0: f32 = 1.0;
const BULGE_AMP: f32 = 12.0;
const BULGE_TILT_DEG: f32 = 27.0;

const HALO_A_H: f32 = 1.0;
const HALO_POWER: f32 = 3.5;
const HALO_AMP: f32 = 0.0008;
const HALO_RMAX: f32 = 100.0;

const ARMS_M: u32 = 2u;
const ARMS_AMP: f32 = 0.20;
const ARMS_PITCH_DEG: f32 = 12.0;
const ARMS_RS: f32 = 3.0;
const ARMS_PHASE0: f32 = 0.0;

const ARM_MIN_RADIUS: f32 = 0.5;

// Field truncations. These must match density.js TRUNCATION: the sampler draws
// each component inside these bounds, so the shader has to see the same field.
const DISC_RADIUS: f32 = 25.0;
const DISC_HEIGHT: f32 = 3.0;
const BULGE_RADIUS: f32 = 6.0;

const COMPONENT_THIN: u32 = 0u;
const COMPONENT_THICK: u32 = 1u;
const COMPONENT_BULGE: u32 = 2u;
const COMPONENT_HALO: u32 = 3u;

fn bulgeEllipsoidRadius(dx: f32, dy: f32, dz: f32) -> f32 {
        let t: f32 = radians(BULGE_TILT_DEG);
        let ct: f32 = cos(t);
        let st: f32 = sin(t);
        let xrot: f32 = dx * ct + dy * st;
        let yrot: f32 = -dx * st + dy * ct;
        let r2: f32 = (xrot * xrot) / (BULGE_A * BULGE_A)
                + (yrot * yrot) / (BULGE_B * BULGE_B)
                + (dz * dz) / (BULGE_C * BULGE_C);
        return sqrt(r2);
}

fn insideDisc(R: f32, z: f32) -> bool {
        return R <= DISC_RADIUS && abs(z) <= DISC_HEIGHT;
}

fn rhoThin(R: f32, z: f32) -> f32 {
        if (!insideDisc(R, z)) { return 0.0; }
        let radial: f32 = select(exp(-R / THIN_L), 1.0, R < 0.01);
        let coshArg: f32 = z / (2.0 * THIN_H);
        let c: f32 = cosh(coshArg);
        return THIN_AMP * radial / (c * c);
}

fn rhoThick(R: f32, z: f32) -> f32 {
        if (!insideDisc(R, z)) { return 0.0; }
        let radial: f32 = select(exp(-R / THICK_L), 1.0, R < 0.01);
        return THICK_AMP * radial * exp(-abs(z) / THICK_H);
}

fn rhoBulge(x: f32, y: f32, z: f32) -> f32 {
        let s: f32 = bulgeEllipsoidRadius(x - GALACTIC_CENTRE_X, y - GALACTIC_CENTRE_Y, z) / BULGE_R0;
        if (s > BULGE_RADIUS) { return 0.0; }
        return BULGE_AMP * pow(1.0 + s * s, -2.5);
}

fn rhoHalo(x: f32, y: f32, z: f32) -> f32 {
        let dx: f32 = x - GALACTIC_CENTRE_X;
        let dy: f32 = y - GALACTIC_CENTRE_Y;
        let r: f32 = sqrt(dx * dx + dy * dy + z * z);
        if (r < HALO_A_H) { return HALO_AMP; }
        return HALO_AMP * pow(r / HALO_A_H, -HALO_POWER);
}

fn armFactor(R: f32, phi: f32) -> f32 {
        if (R < ARM_MIN_RADIUS) { return 1.0; }
        let k: f32 = tan(radians(ARMS_PITCH_DEG));
        let arg: f32 = f32(ARMS_M) * phi - k * log(R / ARMS_RS) + ARMS_PHASE0;
        return 1.0 + ARMS_AMP * cos(arg);
}

fn distanceToNearestArm(R: f32, phi: f32) -> f32 {
        if (R < ARM_MIN_RADIUS) { return 99.0; }
        let k: f32 = tan(radians(ARMS_PITCH_DEG));
        var best: f32 = 99.0;
        for (var n: u32 = 0u; n < ARMS_M; n = n + 1u) {
                let phiArm: f32 = (k * log(R / ARMS_RS) + 6.283185307 * f32(n)) / f32(ARMS_M);
                var dphi: f32 = phi - phiArm;
                dphi = dphi - 6.283185307 * round(dphi / 6.283185307);
                let dArc: f32 = R * abs(dphi);
                if (dArc < best) { best = dArc; }
        }
        return best;
}

fn rhoTotal(x: f32, y: f32, z: f32) -> f32 {
        let dx: f32 = x - GALACTIC_CENTRE_X;
        let dy: f32 = y - GALACTIC_CENTRE_Y;
        let R: f32 = sqrt(dx * dx + dy * dy);
        let phi: f32 = atan2(dy, dx);
        let arm: f32 = armFactor(R, phi);
        return (rhoThin(R, z) + rhoThick(R, z)) * arm + rhoBulge(x, y, z) + rhoHalo(x, y, z);
}

// Component shares at a point as vec4(thin, thick, bulge, halo), pre-arm-modulation.
fn rhoDecomposed(x: f32, y: f32, z: f32) -> vec4f {
        let dx: f32 = x - GALACTIC_CENTRE_X;
        let dy: f32 = y - GALACTIC_CENTRE_Y;
        let R: f32 = sqrt(dx * dx + dy * dy);
        let phi: f32 = atan2(dy, dx);
        let arm: f32 = armFactor(R, phi);
        return vec4f(
                rhoThin(R, z) * arm,
                rhoThick(R, z) * arm,
                rhoBulge(x, y, z),
                rhoHalo(x, y, z),
        );
}

// Mirrors density.sampleComponentIndex().
fn sampleComponent(x: f32, y: f32, z: f32, u: f32) -> u32 {
        let d: vec4f = rhoDecomposed(x, y, z);
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

const STAR_SPRITE = `
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
        cameraPos: vec4f,   // xyz absolute kpc
        viewport: vec4f,    // xy pixels, zw = 2/width, 2/height
        params: vec4f,      // x magZero, y baseSizePx, z maxSizePx, w time
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

        let rel: vec3f = vec3f(star.x, star.y, star.z) - camera.cameraPos.xyz;
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

        // Size follows the magnitude difference, not the linear flux: after
        // tone mapping every star brighter than the exposure would be exactly
        // as large as every other one. The clamp keeps a tight floor/ceiling
        // band of sizes instead of letting Sirius fill the screen.
        let sizePx: f32 = camera.params.y * clamp(1.0 - 0.4 * magDiff, 0.4, 2.0);
        let quadPx: f32 = clamp(sizePx, 1.0, camera.params.z);
        let fade: f32 = min(sizePx / 1.0, 1.0);

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

// HDR direct variant of the star sprite: same vertex shader, same fragment
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
        exposure: vec4f,   // x = linear exposure multiplier
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

        let sizePx: f32 = camera.params.y * clamp(1.0 - 0.4 * magDiff, 0.4, 2.0);
        let quadPx: f32 = clamp(sizePx, 1.0, camera.params.z);
        let fade: f32 = min(sizePx / 1.0, 1.0);

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
        // Same falloff and additive math as the SDR variant, but the output
        // is multiplied by linearExposure so the user's ; / ' keys still
        // control overall brightness on the HDR direct path. Values >1.0
        // pass through to the rgba16float swapchain unchanged.
        let r2: f32 = dot(in.uv, in.uv);
        if (r2 > 1.0) { discard; }
        let s: f32 = 1.0 - r2;
        let falloff: f32 = s * s * s;
        let intensity: f32 = in.brightness * falloff * exposure.exposure.x;
        return vec4f(in.color * intensity, intensity);
}
`;

const TONEMAP = `
// Fullscreen-triangle tone-map pass. Reads the rgba16float HDR intermediate
// (additive linear flux summed across all stars), applies the ACES Narkowicz
// fitted curve, and writes a clamped LDR pixel to the swapchain. No blend
// state: the pass overwrites the swapchain.
//
// ACES Narkowicz fitted curve: x*(2.51x+0.03)/(x*(2.43x+0.59)+0.14). Picked
// over extended Reinhard because the filmic S-curve compresses dense star
// clusters gracefully and preserves red-giant hue into the highlights.
//
// uExposure is a linear multiplier applied before ACES. Default 1.0; range
// 0.125 -> 8.0 in half-stop steps via ; / ' keys. ACES has no explicit white
// point, so uExposure is the single output brightness knob.

struct TonemapUniform {
        exposure: vec4f,   // x = linear exposure multiplier; yzw pad
};

@group(0) @binding(0) var<uniform> u: TonemapUniform;
@group(0) @binding(1) var hdrTexture: texture_2d<f32>;

fn acesNarkowicz(x: vec3f) -> vec3f {
        const a: f32 = 2.51;
        const b: f32 = 0.03;
        const c: f32 = 2.43;
        const d: f32 = 0.59;
        const e: f32 = 0.14;
        let num: vec3f = x * (a * x + vec3f(b));
        let den: vec3f = x * (c * x + vec3f(d)) + vec3f(e);
        return clamp(num / den, vec3f(0.0), vec3f(1.0));
}

@vertex
fn vs_main(@builtin(vertex_index) vid: u32) -> @builtin(position) vec4f {
        // Fullscreen triangle: covers the screen with one triangle whose
        // vertices sit at (-1,-3), (-1,1), (3,1). No vertex buffers.
        var p: array<vec2f, 3> = array<vec2f, 3>(
                vec2f(-1.0, -3.0),
                vec2f(-1.0,  1.0),
                vec2f( 3.0,  1.0),
        );
        return vec4f(p[vid], 0.0, 1.0);
}

@fragment
fn fs_main(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
        // fragCoord is in pixel space of the render target, so it can index
        // the HDR texture directly without a uv computation.
        let texel: vec2i = vec2i(i32(fragCoord.x), i32(fragCoord.y));
        let hdr: vec3f = textureLoad(hdrTexture, texel, 0).rgb * u.exposure.x;
        let ldr: vec3f = acesNarkowicz(hdr);
        return vec4f(ldr, 1.0);
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

fn sampleMassIMF(u: f32) -> f32 {
        let alpha: f32 = 2.35;
        let xMin: f32 = pow(0.08, 1.0 - alpha);
        let xMax: f32 = pow(100.0, 1.0 - alpha);
        return pow(xMin + (xMax - xMin) * u, 1.0 / (1.0 - alpha));
}

// Mirrors star-types.sampleLocalAge / classifyByTempAndState.
fn sampleLocalAge(component: u32, distToArm: f32, R: f32, u1: f32, u2: f32) -> f32 {
        let z: f32 = sqrt(-2.0 * log(max(1e-12, u1))) * cos(6.283185307 * u2);
        if (component == COMPONENT_BULGE) { return min(13.5, exp(log(10.0) + 0.3 * z)); }
        if (component == COMPONENT_HALO) { return min(13.5, exp(log(12.0) + 0.25 * z)); }
        if (component == COMPONENT_THICK) { return min(13.5, exp(log(8.0) + 0.4 * z)); }
        if (distToArm < 0.5 && R > 3.0 && R < 12.0) { return pow(u1, 3.0) * 0.3; }
        return min(13.5, exp(log(5.0) + 0.5 * z));
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

        let lambda: f32 = rhoTotal(centre.x, centre.y, centre.z)
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

                let component: u32 = sampleComponent(pos.x, pos.y, pos.z, hash01(slotSeed + 7u));
                let dx: f32 = pos.x - GALACTIC_CENTRE_X;
                let dy: f32 = pos.y - GALACTIC_CENTRE_Y;
                let R: f32 = sqrt(dx * dx + dy * dy);
                let distToArm: f32 = distanceToNearestArm(R, atan2(dy, dx));

                let mass: f32 = sampleMassIMF(hash01(slotSeed * 31u + 1u));
                let age: f32 = sampleLocalAge(component, distToArm, R, hash01(slotSeed * 31u + 2u), hash01(slotSeed * 31u + 3u));

                var state: u32 = 0u;
                var teff: f32 = teffFromMass(mass);
                var lum: f32 = luminosityFromMass(mass);
                if (age > msLifetimeGyr(mass) * 1.1) {
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

                let cls: u32 = classifyByTempAndState(teff, state);
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

// Mirror parts, kept separate so the validator can diff each one against its
// JS counterpart in src/math/.
const SHADER_PARTS = {
        'pcg-hash': PCG_HASH,
        'density': DENSITY,
        'star-sprite': STAR_SPRITE,
        'star-sprite-hdr': STAR_SPRITE_HDR,
        'tonemap': TONEMAP,
        'procedural-gen': PROCEDURAL_GEN,
        'cull': CULL,
};

// Complete, compilable modules. WGSL has no include mechanism, so the shared
// parts are concatenated here rather than fake-included in the source.
const SHADERS = {
        'star-sprite': STAR_SPRITE,
        'star-sprite-hdr': STAR_SPRITE_HDR,
        'tonemap': TONEMAP,
        'procedural-gen': PCG_HASH + DENSITY + PROCEDURAL_GEN,
        'cull': PCG_HASH + CULL,
};

// Wired shaders: the renderer picks two of these per frame.
//   SDR path (HDR canvas unsupported): star-sprite + tonemap
//   HDR path (rgba16float + extended canvas): star-sprite-hdr only
// The renderer always compiles all three so the user can resize the canvas
// to a different display without re-booting. star-sprite-hdr shares the
// additive blend state with star-sprite; it just multiplies the fragment
// output by linearExposure and writes straight to the swapchain.
const WIRED_SHADERS = ['star-sprite', 'star-sprite-hdr', 'tonemap'];

const GalaxyShaders = { SHADERS, SHADER_PARTS, WIRED_SHADERS };
if (typeof module !== 'undefined') module.exports = GalaxyShaders;
if (typeof window !== 'undefined') window.GalaxyShaders = GalaxyShaders;
