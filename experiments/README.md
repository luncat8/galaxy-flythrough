# Experiments

Node scripts that measure the model, validate the runtime, and generate baked
assets. Nothing here is loaded by the page.

Every script writes a JSON result to `logs/`. Run them through the wrapper:

```sh
python3 scripts/run.py list        # everything available
python3 scripts/run.py all-tests   # every pass/fail test, in order
python3 scripts/run.py camera      # one script
```

## Tests (pass/fail, exit non-zero on failure)

| Script | What it pins down |
|---|---|
| `export-parity-test.js` | `module.exports` and `window.X` are one and the same object for every module, with identical keys and values. |
| `m1-smoke-test.js` | Module wiring: `index.html` loads every source file exactly once in dependency order, no namespace is read before it is defined, every script evaluates in one shared global scope the way classic `<script>` tags do (a duplicate top-level `const` is a load-time SyntaxError), the shipped catalog loads, a sample survives packing. |
| `wgsl-validate.js` | The WGSL in `src/render/shaders.js` matches the JS model: same constants, same function names, same structural markers. |
| `camera-test.js` | Camera model: orthonormal basis, NDC depth range, dt independence, 8 ly/s base with whole-notch ×2 wheel on a power-of-two grid, Shift ×100 / Ctrl ×0.1, fly → orbit-centre → orbit-object cycle (position kept on entry, on-sphere under drag, key rates, clamps), home and reset, input consumption, zero allocations over 600 frames of mode switching. |
| `renderer-test.js` | `star-sprites.js` driven by a stub WebGPU device: buffer sizing for `[global][landmarks][objects][local][catalog]`, one upload of the fixed blocks with the landmark records flagged and at their baked positions, catalog upload only when residency changes, instance counts, uniform packing, exposure clamping. |
| `hdr-test.js` | The Hable/Unreal filmic tone curve the renderer ships: fixed points, monotonicity, no NaN across the exposure range, the brightness-gain property (N overlapping stars sum linearly and roll off once), the linear exposure knob's range. Curve constants are pulled out of the WGSL; the arithmetic mirror lives in `tonemap-mirror.js`. |
| `landmark-test.js` | 0.1.2 landmarks & constellations: the shared RA/Dec → XYZ conversion and screen projection, the landmark table (count, uniqueness, baked positions/magnitudes), every constellation edge resolving, click picking (nearest within 20 px, real data + synthetic scene, behind-camera culling), and the label layer's draw/cull/toggle behaviour against a mock 2D context. |
| `tile-stream-test.js` | Encoder → loader → cell manager end to end on the shipped bundle: freshness, manifest, residency/hysteresis, nearest-first budget against a brute force, decode cache, no re-decode on re-upload. |
| `tile-encoder-smoke-test.js` | The encoder on synthetic data: cuts, band assignment, bundle schema, and a full round trip through the shipping loader. |
| `galaxy-types-test.js` | All 18 regular types: table completeness, E flattening, preset invariants, masses, truncation, populations, homes and mode rules. |
| `model-parity-test.js` | Independent field quadrature vs compact disc / scaled spheroid / cored halo samples; translated centres, arm phases, overrides, empty-model bounds and determinism. |
| `sampling-test.js` | The sampler against the analytical model: component mix, R/|z|/φ histograms, arm phase, local density ratios, determinism. |
| `density-distribution-test.js` | The box sampler against the model on a grid: radial and vertical distributions, component mix, bounds. |
| `star-types-evolution-test.js` | Stellar populations: O/B near arms, old giants, metallicity by component, Salpeter slope, mass → Teff → class chain. |
| `nebula-placement-test.js` | Nebula types in the right environments: HII on arm ridges, planetary in the old inner population, none in the halo, sizes/opacities in range. |
| `object-placement-test.js` | Composite objects: per-type environments, Plummer/King/fractal member profiles, budget apportionment, seed stability, gas-gated shares, full budget fill for all 19 types. |

## Studies (print a recommendation, no pass/fail)

- `hash-quality-test.js` — chi-square, serial correlation, 2D spectral and period tests on PCG and Wang.
- `precision-test.js` — f32 vs split-double error at 1 pc … 100 kpc. Basis for the no-split-double decision.
- `packing-test.js` — `StarPacked` round-trip fidelity and the GPU memory budget per star count.
- `filter-test.js` — priority score distribution, magnitude-band completeness, hash-thinning determinism.

## Shader simulation (needs `npm install wgsl_reflect` at the repo root)

- `wgsl-exec-check.js` — executes the shipping WGSL on the CPU (the `wgsl_reflect`
  interpreter) and checks what it computes: the sprite emits the flux the magnitude
  formula predicts (byte quantisation and sub-pixel fade included), behind-camera
  stars contribute nothing, and N stars piled on one pixel run through the real
  tonemap `fs_main` and match the JS pixel model in `tonemap-mirror.js`. Not part of
  `all-tests` only because of the dev-only dependency. Also executes the actual density
  and arm WGSL for every regular type plus a translated/overridden model; checks
  JS parity beyond the uniform-layout contract.

## Assets

- `tile-encoder.js` — reads the Gaia CSV (or `--mock` synthetic stars), applies the magnitude/quality cuts, converts to galactic XYZ, and writes `src/data/tiles/catalog.js` (one bundle, `window.__galaxy_catalog`). Ends with a loader round-trip check.
- `visualize-data.js` — exports a sample (stars with derived types, nebulae, density grid) to `logs/galaxy-sample.json` for `scripts/viz-galaxy.py`.

## Conventions

- A test prints one line per check, writes `logs/<name>.json`, and ends with a
  `=== VERDICT ===` line. Exit code 0 = pass.
- Logs stay in the repo: they are the trail of what was measured.
- No browser exists in this environment, so anything that talks to WebGPU is
  tested against a stub device (see `renderer-test.js`), validated statically
  (`m1-smoke-test.js`, `wgsl-validate.js`), or — for actual shader behaviour —
  interpreted on the CPU (`wgsl-exec-check.js`).
