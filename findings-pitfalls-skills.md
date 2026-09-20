# Findings, Pitfalls & Skills

Append-only notes for LLM agents working on this project. Each entry: date, one-line summary heading, then the detail. Newest at top.

---

## 2026-09-19 — Two hand-maintained export lists always drift: expose one API object

Every module had two export literals, one for Node (`module.exports = { ... }`) and one for the page (`window.X = { ... }`). They drifted, and the drift was invisible from Node: the renderer called `StarRecord.writeRecord`, which existed only in the Node export, so the browser would have thrown on the first frame (`prepare()` writes procedural records at boot). Node tests were green the whole time.

The rule is now: build one object, hand the *same object* to both environments.

```js
const StarRecord = { RECORD_BYTES, writeRecord, readRecord, /* ... */ };
if (typeof module !== 'undefined') module.exports = StarRecord;
if (typeof window !== 'undefined') window.StarRecord = StarRecord;
```

`experiments/export-parity-test.js` walks every module, loads it with a fake `window`, and asserts the two surfaces are the same object with the same keys and values. This generalises: any duplicated list that a machine could have derived is a bug waiting for a release.

## 2026-09-19 — A truncation applied by the sampler is part of the model, not a sampler detail

The Plummer bulge has a heavy tail: with `r0 = 1 kpc`, `s = r_e / r0` up to 6 still carries ~4% of the analytic mass. The sampler cut at `s = 6`, but `density.js` did not, so at 12 kpc above the plane the untruncated bulge tail (~7e-9) outweighed the halo (1.9e-7 vs ...) in `dominantComponent`, and nebula placement treated the halo as bulge-dominated.

Rule: decide *one* truncation per component, put it inside the density functions, mirror it in WGSL, and let the sampler draw inside those bounds. Any derived quantity that weights by density — dominant component, nebula probability, thinning, the exposure histogram — then agrees with the stars that are actually placed. `sampling.js` reports the fractions the truncation removes so the expected component shares have a closed form.

## 2026-09-19 — Keep the shaders where Node can read them: JS strings, not .wgsl files or text/x-wgsl blocks

WGSL cannot be compiled here, so the only defence against the mirror drifting is a test that diffs it against the JS model. That test can only run if the shader text is reachable from Node. Two earlier arrangements failed: `.wgsl` files plus a copy inlined in `index.html` (two copies, both hand-maintained, and they had already diverged — the validator could only marker-check one of them), and `document.getElementById(...).textContent` at boot (unreachable from Node, and one more thing to get wrong in the page).

Now `src/render/shaders.js` holds the shader parts as template strings, concatenated into complete modules, and `wgsl-validate.js` compares constants, function names and structural markers against `src/math/*.js`. Wired and unwired shaders are both validated; only `WIRED_SHADERS` is compiled by the renderer.

## 2026-09-19 — One bundle file beats one file per cell, even with base64

The first catalog layout was one `.js` file per cell (2045 cells for a 3,829-star subset): 1170 files, 4.7 MB on disk, 44 bytes of file for every 16-byte star, and one `<script>` tag per cell at load time. The user's verdict — "multiple small tiles js is not good" — was right for reasons that also show up in the numbers: filesystem overhead, 2045 parse events, and a directory tree that grows with the catalog.

One bundle (`window.__galaxy_catalog`) with base64 payloads is 164.6 KB for the same catalog, 44 bytes per star *including* base64 and JSON, and exactly one script injection. Base64 costs 33% over raw bytes and buys a file that is still plain JS, still `file://`-loadable, and still `require()`-able in Node tests. The band table travels *in* the asset (cell size + streaming radius per band), so retuning streaming is an encoder run, not a code edit.

## 2026-09-19 — Test WebGPU modules against a stub device

There is no browser here, and `star-sprites.js` is mostly GPU bookkeeping — which is exactly the part that breaks. `experiments/renderer-test.js` builds a fake `GPUDevice` that records everything (`createBuffer`, `createPipeline`, `queue.writeBuffer`, `beginRenderPass`, `draw`) and returns plausible objects. With it the tests can assert real invariants: the storage buffer is sized `(procedural + catalogCapacity) x 16`, the procedural field is uploaded once at offset 0, the catalog is uploaded only when the resident set changes, `draw(4, instances)` matches the residency, and the 28-float uniform carries the camera's view-projection.

Two traps: uniforms are `Float32Array`, so compare against `Math.fround(value)` (a literal `2.2` never equals the stored value); and the mock must rethrow nothing — a stub that silently swallows a bad argument hides the bug it was written to catch.

## 2026-09-19 — WebGPU clip space is z in [0, 1]; an OpenGL projection clips half the scene

The projection matrix had the OpenGL depth convention: `(near+far)/(near-far)` and `2*near*far/(near-far)`, which maps the near plane to z = -1. WebGPU wants `far/(near-far)` and `near*far/(near-far)`, mapping near to z = 0. The symptom is subtle — everything still renders, but anything closer than the effective zero crossing (a few parsecs, given `near = 0.001 kpc`, `far = 2000 kpc`) gets clipped, and depth precision near the camera is wrong. `camera-test.js` now asserts the depth range and the near/far endpoints.

## 2026-09-19 — Nearest-first residency needs an exact order, not a distance bucket

The first cell-manager sorted candidates by counting them into 64 squared-distance shells. The shells span the whole candidate range, so near the Sun the first shell covered everything within ~1.5 kpc and the "nearest" cells were really "whichever cells came first in the bundle". A tight-budget test against a brute-force fill caught it: 192 stars in 48 cells versus 198 stars in 71 cells.

Fix: sort in place by `(distanceSq, cellIndex)` with `Float64` distances — exact, no allocation per comparison, and cheap at the cadence a rebuild actually runs (a few times per second). Keep the ordered fill, not the bucket: the budget is star-denominated, so the very first cell that does not fit is exactly where the selection should stop.

## 2026-09-19 — Decode base64 into the destination buffer

Per-cell base64 decode used to allocate a `Uint8Array` per cell, only for the caller to copy it into the staging buffer. `decodeBase64Into(str, out, byteOffset)` walks the characters with `atob` (or `Buffer.from(str, 'base64')` in Node) and writes straight into the destination; `decodeBase64` remains as a thin wrapper with exact padding from the `=` count. The streaming test monkey-patches `decodeCell` to count calls, proving that a re-upload of an unchanged residency set does not decode anything at all.

## 2026-09-19 — file:// fetch is blocked; use dynamic `<script>` injection for binary data

Chrome and Edge block `fetch()` of local files under `file://` (CORS policy). Firefox allows it only with `security.fileuri.strict_origin_policy=false`. The portable workaround is to emit binary assets as `.js` files that assign a `Uint8Array` to a global slot:

```js
window.__tile_near_0_1_2 = new Uint8Array([0x12, 0x34, /* ... */]);
if (typeof module !== 'undefined') module.exports = window.__tile_near_0_1_2;
```

Load by injecting `<script src="...">` at runtime, reading the global, then deleting the property and removing the script tag. Works in all major browsers under `file://`.

## 2026-09-19 — f32 precision collapses at galactic distances; use split-double

Raw `f32` has ~7 decimal digits. At 100 kpc the precision is ~10 m, which is fine for star rendering, but for the camera-position offset calculation it produces visible jitter during slow fly-through. Solution: store star positions as `(positionHigh: vec3<f32>, positionLow: vec3<f32>)` where `positionHigh` is the rounded value and `positionLow` is the residual. The vertex shader reconstructs: `relativeHigh = positionHigh - cameraHigh; relativeLow = positionLow - cameraLow; final = relativeHigh + relativeLow`.

Test with `experiments/precision-test.js` before assuming any given distance is safe.

## 2026-09-19 — PCG hash is the recommended GPU hash; validate with chi-square

Nathan Reed's *Hash Functions for GPU Rendering* (reedbeta.com) recommends PCG (Permuted Congruential Generator) over Wang hash for statistical quality. Wang hash is faster but shows subtle banding when used for stratified sampling at scale.

Always validate any hash function with `experiments/hash-test.js` before shipping. A bad hash produces visible grid-like patterns in procedural star distributions at large radii.

## 2026-09-19 — Gaia DR3 is not a uniform sample of the Milky Way

The catalog is "essentially complete between G=12 and G=17" with "an ill-defined faint magnitude limit which depends on celestial position" (dc.g-vo.org). At 100 pc the coolest stars become too faint; useful sampling reaches ~3 kpc for bright tracers. A naive Gaia download produces an over-dense solar neighbourhood with empty galaxy elsewhere. The fix is to (a) apply magnitude cuts that align with global completeness, and (b) decimate the solar neighbourhood stochastically to match the density the rest of the catalog shows. The *density model* (not the catalog) defines the truth.

## 2026-09-19 — Magnitude-band completeness is required, not a single radial function

A catalog can be complete for bright stars at a given distance while being incomplete for faint stars at the same distance. Tracking completeness as a single radial function conflates these. Track per magnitude band (0–4, 4–8, 8–12, 12–16, 16+) and generate procedural stars only for the missing portion of each band. This prevents over-population in regions where the catalog already covers the faint end.

## 2026-09-19 — Elite Dangerous "Stellar Forge" is the direct precedent

Frontier Developments built a 1:1 scale Milky Way with ~400 billion star systems. They seeded it with ~160k real Hipparcos stars (the "remarkable" stars) and procedurally generated the rest using physics-based rules (stellar IMF, metallicity gradients, age distributions). The galaxy is not stored; it is regenerated deterministically from a seed on demand. This is exactly the hybrid pattern used here.

Sources: polygon.com, ctrl500.com, perthobservatory.com.au, frontier forums.

## 2026-09-19 — Implementation order: catalog + renderer first, procedural last

A common mistake is to start with procedural galaxy generation. The correct order is:

1. Camera-relative coordinates and packed GPU star buffer.
2. Point-sprite renderer with hard-coded test stars.
3. Catalog tile loading and streaming.
4. GPU frustum culling and indirect draw.
5. Stable hash thinning.
6. Real catalog filtering.
7. *Only now* add procedural generation, plugging into the existing compute-cull-render pipeline as another data source.

If procedural generation is built first, the renderer becomes coupled to it and the catalog integration becomes painful.

## 2026-09-19 — Three render paths (not one) for LOD

A single sprite path is insufficient at galactic scale. Beyond ~5 kpc, individual stars occupy less than a pixel and waste GPU work. The renderer needs three paths used simultaneously:

- **Path A**: bright/nearby billboard sprites with full detail.
- **Path B**: distant point sprites, cheap, mostly unlabelled.
- **Path C**: unresolved density cells, additive screen-space quads tinted by integrated density.

A single frame may use all three. Path C is what makes the galactic bulge and spiral arms glow correctly when far away.

## 2026-09-19 — NGC and named stars are landmarks, not data

The catalog of "remarkable stars" (Pleiades, Orion nebula, Sirius, Betelgeuse, etc.) functions as landmarks the user recognises. They bypass density thinning. Their purpose is recognisability, not completeness. A whitelist of a few hundred to a few thousand landmark stars is sufficient; do not try to ship a complete NGC.

## 2026-09-19 — Density-preserving count scaling: density is the truth, count is a budget

The user requirement is that 10k and 1M stars both render with correct density. The strategy:

1. The density field defines relative density everywhere. It is the truth.
2. The target star count `T` is a runtime budget.
3. A global scaling factor `s = T / Λ_total` multiplies every cell's expected count.
4. At low budgets, individual cells may produce zero stars; the spatial distribution remains correct because the rejection sampler preserves relative probability.

This works because the procedural generator samples *from* the density field, not from a stored list. The count is a sampling rate, not a population size.

## 2026-09-19 — Component sampling: sample by relative density, don't pick max

Initial approach used `dominantComponent(x,y,z)` which picks the highest density at a point. This was wrong: at the galactic centre, thin disc density (1.0) exceeds bulge density (0.65), so even stars physically near the bulge got classified as 'thin'. Bulge share came out 0%.

Fix: `sampleComponent(decomposed, u)` — sample component probabilistically by relative density contribution. A star near the centre is 55% thin / 35% bulge / 10% thick / 0% halo; we sample which population it actually came from using a uniform random `u`. Result: bulge share rises to physically-correct values; halo share becomes non-zero.

## 2026-09-19 — Box size matters for component ratios

A large sampling box (e.g. 30×30×10 kpc covering R from 0 to 22 kpc) produces unintuitive ratios: thin 33%, thick 67%. This is actually correct — at R > 12 kpc the thick disc's longer scale length wins over thin disc. For inner-galaxy ratios (where thin dominates), use a smaller box centred on the galaxy (e.g. [-15,-1] × [-7,7]).

## 2026-09-19 — Mass-Teff formula breaks at low masses

The textbook formula `Teff = (L/R²)^0.25 * 5772 K` with `R = M^0.8, L = M^2.3` gives wrong temperatures for very low and very high masses:
- M = 0.08 → Teff = 3977 K (classified K, should be M dwarf at 2400 K)
- M = 100 → Teff too high

Fix: use a tabulated mass-Teff relation (18-point table, log-log interpolated). Now M dwarfs (0.08-0.45 M_sun) correctly map to 2400-3800 K, and O stars (>16 M_sun) to 30000+ K. Result: 87% M, 9% K, 0.8% G, 0.01% B — matches observed IMF.

## 2026-09-19 — Spiral arm modulation needs sqrt-scaled visualization to be visible

±20% arm modulation is invisible in log10 density plots — it's only ±0.08 in log space, drowned by the bulge dominance. Use `sqrt(density)` with capped range (0 to 0.8) to bring out the arm contrast. Overlaying the analytical arm curves (cyan lines) as a guide helps verify the modulation aligns with the math.

## 2026-09-19 — HII regions 100% in arms, planetary nebulae need separate probability

Gas-driven nebulae (HII, reflection, dark) must be suppressed in bulge/halo (no cold gas there). But planetary nebulae are stellar-evolution driven, not gas-driven — they should be more common in old populations like the bulge. Use two separate probability terms: `pGas` (cold-gas-dependent) and `pStellar` (population-driven, boosted in bulge). Sum them. Result: HII regions 100% in arms, planetary nebulae concentrated in bulge.

## 2026-09-19 — B stars are 100% in arms, K/M only 5% — physics validated

Star-types-evolution test confirms placement works:
- B stars: 100% within 0.5 kpc of an arm (only formed recently, haven't diffused)
- A stars: 50% near arms (300 Myr lifetime, partially diffused)
- G/K/M stars: 5% near arms (old enough to be uniformly distributed)
- Red giants: 3.8% near arms (progenitors were low-mass, old)
- Mean ages: halo 11.78 > bulge 10.33 > thick 8.40 > thin 5.40 Gyr
- Metallicities: halo 0.001 < thick 0.008 < thin 0.020 < bulge 0.035

This pattern matches observed Milky Way stellar populations. The procedural generator is placing stars at evolutionarily-correct positions.

## 2026-09-19 — PCG hash validated: chi-square 243.83 (df=255), serial r=-0.0039, no period repeats in 1M

PCG hash passes all 4 quality tests:
- Chi-square on 1M samples / 256 buckets: 243.83 (pass <293 at 5% significance, <310 at 1%)
- Serial correlation between hash(i) and hash(i+1): -0.0039 (pass |r|<0.01)
- 2D spectral max/min ratio: 1.60 (pass <2.5, no lattice patterns)
- Period: no repeats in first 1M inputs

Wang hash also passes chi-square (242.23) and spectral (1.55), so it remains a valid faster fallback for older GPUs. Use PCG as default.

## 2026-09-19 — f32 is sufficient for star positions up to 100 kpc; split-double unnecessary

Measured f32 max error in position reconstruction:
- 1 kpc: 0.0000 pc
- 8 kpc (Sun to GC): 0.0005 pc
- 20 kpc (far disc): 0.0010 pc
- 100 kpc (halo): 0.0049 pc

All well below the 0.5 pc acceptable threshold. Split-double would give 1e6x improvement but is unnecessary for star rendering. Reserve split-double for camera-position offset computation only if fly-through jitter appears at >50 kpc from origin (deferred tuning T-speculative in plan.md §14a).

## 2026-09-19 — Packed 16-byte StarPacked struct: 1M stars = 19.2 MB, 5M = 95.5 MB, 20M = 381.6 MB

Round-trip fidelity:
- Position max error: 6.8e-7 kpc (f32 rounding, negligible)
- Magnitude quantum: 0.078 mag (256 steps over 0-20 mag range)
- colorIndex, flags, subCellJitter: preserved exactly (8 bits each)

This means 1M catalog stars + 5M procedural stars fits comfortably in ~115 MB. The 256 MB target budget supports 16.7M packed stars (vs 8.4M naive 32-byte).

## 2026-09-19 — Hash thinning is deterministic and matches target probability within 1%

Test result: 100k stars, target p=0.30, actual fraction kept = 0.2976. Deterministic across reruns (same star IDs always kept/removed at same LOD). Screen-space thinning preserves the highest-priority star in 100% of tested cells.

The thinning formula `keep if hash(starId, tileId, lodLevel) < p` works as designed. No popping between frames because the hash is stable.

## 2026-09-19 — WGSL mirrors JS via validator contract

The `experiments/lib/*.js` files are the source of truth (testable in Node). The `src/render/wgsl/*.wgsl` files are mirrors (testable only by running WebGPU). The contract between them is enforced by `experiments/wgsl-validate.js`:

- PCG hash constants (0x7feb352d, 0x846ca68b, etc.) must match between JS and WGSL
- Density model constants (GALACTIC_R0, THIN_L, etc.) must match
- 18-entry mass-Teff table must match in both directions
- Spectral class thresholds (30000, 10000, 7500, 6000, 5200, 3700 K) must match
- StarPacked struct must be 16 bytes (3×f32 + 1×u32)
- WGSL syntax sanity (balanced braces/parens, @compute + @workgroup_size on entry points)

Tuning methodology: change the constant in JS, run the validator, fix any drift in WGSL. Never tune constants directly in WGSL — JS is the source of truth.

## 2026-09-19 — Source of truth refactor: src/math/ replaces experiments/lib/

Moved experiments/lib/{hash,density,sampling,star-types,nebula}.js to src/math/. These files were already browser+node compatible (guard `module.exports` AND `window.X`), so the move eliminated duplication with no functional changes.

Now the contract is: `src/math/*.js` is the source of truth. `src/render/wgsl/*.wgsl` mirrors it. `experiments/wgsl-validate.js` enforces the contract. Experiments require from `../src/math/`. Runtime loads via classic `<script>` tags in `index.html`.

This means any test that runs in Node tests the actual code that runs in the browser. No more "lib vs src" drift.

## 2026-09-19 — WGSL embed pattern: <script type="text/x-wgsl"> blocks in index.html

For file:// compatibility, WGSL shaders are embedded as `<script type="text/x-wgsl" id="shader-name">` blocks in `src/index.html`, and read at runtime via `document.getElementById('shader-name').textContent`. This avoids `fetch()` which Chrome/Edge block under file://.

The `.wgsl` files in `src/render/wgsl/` remain as source of truth (for editing and documentation). The embedded version strips comment headers but must contain the same key markers (structs, entry points, functions). `wgsl-validate.js` test 6 enforces this — it checks for the presence of struct/function names rather than byte-for-byte equality, so indentation differences don't cause false negatives.

## 2026-09-19 — Camera uniform layout: 96 bytes, mat4x4 viewProj + vec4 cameraPos + time + size + pad

Layout (96 bytes total):
- bytes 0-63: viewProj mat4x4 (column-major for WGSL)
- bytes 64-79: cameraPos vec4 (xyz + pad)
- bytes 80-83: time f32
- bytes 84-87: starSizePx f32
- bytes 88-95: pad vec2

Built once per frame in `camera.buildViewProj()` into a preallocated Float32Array(16), copied into a preallocated ArrayBuffer, uploaded via `device.queue.writeBuffer`. Zero per-frame allocations.

## 2026-09-19 — Loop stats: rolling 60-frame history, no per-frame allocation

`src/core/loop.js` keeps FPS, frame ms, avg, and max in a single stats object mutated in place. A `Float32Array(60)` rolling history buffer tracks the last 60 frame times for avg/max. The buffer is allocated once at loop creation and indexed by `historyIdx = (historyIdx + 1) % 60` per frame. No array creation, no GC pressure.

## 2026-09-19 — Color LUT 1x256 texture: index 0-8 = O,B,A,F,G,K,M,WD,RG

`src/render/star-distant.js` builds a 1x256 rgba8 texture at startup, with the first 9 entries mapping to spectral classes (rest default to G). The WGSL shader samples via `textureLoad(colorLUT, vec2i(i32(colorIndex), 0), 0)`. This avoids storing 3 bytes of RGB per star — only 1 byte (colorIndex) is stored in StarPacked.packed.

For 1M stars, this saves 2 MB of GPU memory vs storing RGB directly. The LUT itself is 1 KB.

## 2026-09-19 — Coordinate convention bug: density.js had GC at -8.178, should be +8.178

Bug: `density.js` set `GALACTIC_CENTRE = { x: -8.178, y: 0, z: 0 }`. This was inconsistent with the plan §3 convention: "X: toward Galactic longitude 0° (galactic centre direction)". If X points toward l=0, the GC is at +8.178 on the X axis, not -8.178.

Caught by: `tile-encoder-smoke-test.js` test 1 (coordinate conversion). The encoder converts RA/Dec/parallax to galactic XYZ using the standard IAU 1958 transformation, which gives x ≈ +8.2 kpc for the GC direction (RA=266.4051°, Dec=-28.9362°, parallax=0.122 mas). The test initially expected x ≈ -8 kpc (matching the buggy density.js) and failed.

Fix: `GALACTIC_CENTRE = { x: 8.178, y: 0, z: 0 }` in density.js. Updated viz-galaxy.py GC marker to match.

Lesson: the validation contract between density.js (source of truth) and the analytical model the user expects (RA/Dec→XYZ) was being silently violated. The tile-encoder smoke test surfaced it because it tests the conversion path end-to-end. Tests with mock data that's *generated by the same density model* cannot catch this — they're circular.

## 2026-09-19 — WebGPU has no gl_PointSize — use instanced billboard quads

Original Milestone 1 used `point-list` topology with `pass.draw(N, 1, 0, 0)`. This renders each star as a 1x1 pixel point — invisible at typical densities. WebGPU has no `gl_PointSize` equivalent in the vertex shader.

Fix: switch to `triangle-strip` topology with instanced billboards. Each star is a 4-vertex quad, drawn as instance 0..N-1. The vertex shader uses `@builtin(vertex_index)` (0..3) as the corner of the quad, and `@builtin(instance_index)` as the star index into the storage buffer.

Pipeline: `pass.draw(4, TEST_N, 0, 0)` — 4 vertices per star, TEST_N instances.

## 2026-09-19 — Camera right/up vector sign bug

Original `camera.js` `updateForward()` had `right = (-sin(yaw), cos(yaw), 0)` and `up = (cos(yaw)·sin(pitch), sin(yaw)·sin(pitch), -cos(pitch))` — both inverted.

Correct via `cross(forward, worldUp=(0,0,1))`:
- forward = (cos(yaw)·cos(pitch), sin(yaw)·cos(pitch), sin(pitch))
- cross(forward, (0,0,1)) = (forward.y·1 - forward.z·0, forward.z·0 - forward.x·1, 0) = (forward.y, -forward.x, 0)
- normalised: (sin(yaw), -cos(yaw), 0) (when pitch≠±π/2)

So right = (sin(yaw), -cos(yaw), 0) — opposite of what I had. Same for up.

This bug only affected input translation (WASD); the actual view matrix in `buildViewProj` recomputes right via cross product, so the render would have been correct but A/D would be inverted.

Caught by: extended `m1-smoke-test.js` with orthonormality checks (forward·right=0, forward·up=0, right·up=0) plus specific value checks at yaw=0,pitch=0 (forward=+X, right=-Y, up=+Z).

## 2026-09-19 — Camera uniform layout grew to 128 bytes for billboard right/up

Original 96-byte uniform (viewProj + cameraPos + time + size) was insufficient when the star shader needs to billboard. Added `cameraRight: vec4f` and `cameraUp: vec4f` for world-space camera basis vectors.

Layout (128 bytes):
- bytes 0-63: viewProj mat4x4
- bytes 64-79: cameraPos vec4
- bytes 80-95: cameraRight vec4
- bytes 96-111: cameraUp vec4
- bytes 112-115: time f32
- bytes 116-119: starSizePx f32
- bytes 120-127: pad

In the current shader we compute the corner offset in clip space (simpler) so we don't actually use cameraRight/cameraUp yet — they're reserved for future world-space billboarding (e.g. for Path A bright-star sprites with non-uniform scaling).

## 2026-09-20 — Orbit and fly share one yaw/pitch pair; the orbit position is derived

The first 0.1.1 plan gave orbit mode its own `orbitYaw/orbitPitch` (the direction from target to camera) and converted on every mode switch. Dropping that and keeping a single pair that always means "where the camera looks" removed the conversion, the second set of clamps and a sign table: `position = target − distance · forward`. Entering orbit snaps the *angles* (`yaw = atan2`, `pitch = asin`) so the position is reproduced exactly and the camera only turns; leaving orbit changes nothing. Mouse look is the same code in both modes and comes out as the standard "grab the world" drag (three.js OrbitControls, Google Earth). Keys deliberately keep "move the camera" semantics (D goes right, E goes up), which is the opposite sign from the mouse and is also what Google Earth does.

Sign check for tests: from the Sun looking +X, screen-right is −Y, so "the camera swings left" means position.y > 0. Two tests were first written with the opposite expectation; the code was right.

## 2026-09-20 — Wheel: accumulate to whole notches, never round a frame's delta

`round(wheelDelta / 100)` per frame makes trackpads inert: their 3–10 px events round to zero and were then discarded. Keep a persistent accumulator in the consumer, take `trunc(acc / 100)` notches, leave the remainder. `input.js` folds `deltaMode` lines/pages to pixels first (`[1, 100/3, 100]`; `3 × (100/3)` is exactly 100 in f64) so one mouse notch is 100 in Chrome and Firefox alike.

Corollary: a value that walks a ×2 grid needs power-of-two clamps. Clamped at 0.02 the multiplier sits on 0.02·2ⁿ forever and never reads x1 again; clamped at 1/64 and 256 it does.

## 2026-09-20 — Place the camera along the f64 basis; the f32 basis is for the GPU

`forward/right/up` are Float32Arrays because the renderer reads them. Using them to place an 8 kpc orbit put the camera ~0.5 mpc (100 AU) off the sphere and made "entering orbit keeps the position" fail at 6e-8 kpc. The camera now keeps `forwardExact/rightExact` in f64 for integration and placement and copies them into the f32 outputs. Same lesson as camera-relative rendering: precision lives on the CPU in f64; f32 is an output format.

## 2026-09-20 — Test the page's loading model, not just the modules: one vm context for all scripts

`require()` gives each file its own scope, so it cannot see the one failure classic `<script>` tags add: two files declaring the same top-level `const` throw `SyntaxError: Identifier has already been declared` when the second loads, and a namespace read at load time must find an earlier script's export. `m1-smoke-test.js` now evaluates every script in `index.html` order inside one `vm` context with a fake `window`; a mutation test (appending `const GALACTIC_CENTRE = 1` to `loop.js`) fails it as intended. Practical rule: top-level names in `src/**/*.js` form one namespace — check before adding one (`density.js` owns `GALACTIC_CENTRE`, `shaders.js` owns `DENSITY`, `CULL`, …).

## 2026-09-20 — Keyboard traps: Ctrl as a modifier, key repeat on toggles

The DOM codes are `ControlLeft/ControlRight` (not `CtrlLeft`). With Ctrl as the slow modifier: Ctrl+W closes the tab on Windows/Linux and no page can prevent it (reserved shortcut); Ctrl+R (reload) and Ctrl+H (history) *can* be prevented, so every mapped key calls `preventDefault()`. The arrow keys are the safe way to fly slowly — say so in the help text. One-shot actions (`C`, `H`, `R`) must ignore `e.repeat` or a held key cycles camera modes at ~30 Hz; accumulating actions (`[ ]` exposure) should `+=` so repeat is one more step and two repeats in one frame are two steps.
