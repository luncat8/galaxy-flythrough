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
| `input-test.js` | DOM events against the action table: mode-aware look, menu focus isolation (typing in a field never flies the camera), pick vs drag disambiguation, one-shot keys including `K`, and the pointer lock/release cycle. |
| `preset-test.js` | The preset text line is the URL language, so serialize → parse round-trips every field exactly; the defaults table stays honest against the modules that own the numbers; engine-tagged fields ride only with their pass; selection contents and routes stay transient, off the line. |
| `renderer-test.js` | `star-sprites.js` driven by a stub WebGPU device: buffer sizing for `[global][landmarks][objects][local][catalog]`, one upload of the fixed blocks with the landmark records flagged and at their baked positions, catalog upload only when residency changes, instance counts, the nebula billboard pass (packed gas objects, 4 px / 5 kpc cull, loadOp `'load'`), uniform packing, exposure clamping. |
| `hdr-test.js` | The Hable/Unreal filmic tone curve the renderer ships: fixed points, monotonicity, no NaN across the exposure range, the brightness-gain property (N overlapping stars sum linearly and roll off once), the linear exposure knob's range. Curve constants are pulled out of the WGSL; the arithmetic mirror lives in `tonemap-mirror.js`. |
| `landmark-test.js` | 0.1.2 landmarks & constellations: the shared RA/Dec → XYZ conversion and screen projection, the landmark table (count, uniqueness, baked positions/magnitudes), every constellation edge resolving, click picking (nearest within 20 px, real data + synthetic scene, behind-camera culling), and the label layer's draw/cull/toggle behaviour against a mock 2D context. |
| `star-select-test.js` | 0.5.0 selection (0.5.0-plan §3): `pickAny` over all five record blocks under the engine-mask dispatch, the simple-engine approximation it reports, the bounded snapshot set (nearest-first, capacity drops the farthest), `select-around`, key→slot resolution, fly-to, and the two click-cost budgets (pick < 16 ms, radius scan < 5 ms at 300k). |
| `search-test.js` | 0.5.2 search (0.5.0-plan §5): the predicate table, the two-stage scan, the scope fallback, the result ordering and the four cost budgets — every predicate evaluated twice, once by the scan and once by an independent evaluator running the generator's full record. |
| `system-layer-test.js` | The headless contract of `render/system-layer.js` over real generated systems, black-box through a stub 2D context: the log-polar radial axis, the five-bucket icon ramp, belt stipples hashed once per system, the pick returning the body the draw placed, the selection ring and hovered designation, the readout's rows, the delta-v graph, the route's polyline/ship/`pickNode`, and no allocation across 1 000 warm draws. |
| `tile-stream-test.js` | Encoder → loader → cell manager end to end on the shipped bundle: freshness, manifest, residency/hysteresis, nearest-first budget against a brute force, decode cache, no re-decode on re-upload. |
| `tile-encoder-smoke-test.js` | The encoder on synthetic data: cuts, band assignment, bundle schema, and a full round trip through the shipping loader. |
| `galaxy-types-test.js` | All 18 regular types: table completeness, E flattening, preset invariants, masses, truncation, populations, homes and mode rules. |
| `model-parity-test.js` | Independent field quadrature vs compact disc / scaled spheroid / cored halo samples; translated centres, arm phases, overrides, empty-model bounds and determinism. |
| `sampling-test.js` | The sampler against the analytical model: component mix, R/|z|/φ histograms, arm phase, local density ratios, determinism. |
| `density-distribution-test.js` | The box sampler against the model on a grid: radial and vertical distributions, component mix, bounds. |
| `star-types-evolution-test.js` | Stellar populations: O/B near arms, old giants, metallicity by component, Salpeter slope, mass → Teff → class chain. |
| `nebula-placement-test.js` | Nebula types in the right environments: HII on arm ridges, planetary in the old inner population, none in the halo, sizes/opacities in range. |
| `object-placement-test.js` | Composite objects: per-type environments, Plummer/King/fractal member profiles, budget apportionment, seed stability, gas-gated shares, full budget fill for all 19 types, 32-byte billboard packing and the 4 px / 5 kpc cull. |
| `shape-test.js` | The 0.4.8 3D-shape gate: no density step along a dense cut through each component, the bar's peanut, the truncation floors and the age–height coupling — a galaxy can be right face-on and wrong in z. |
| `galaxy-age-test.js` | Galaxy age (0.3.3): the truncated delayed-exponential SFH per type (KS against the analytic CDF, mean, span and quenching), per-component formation windows and the assembly order at any age, the population's O/B, giant, remnant and colour trends, the mass-conserving gas law, object mixes and age clamps, and the exposure renormalisation offset. |
| `orbit-test.js` | The 0.4 orbit law and the 0.4.x engines: T = 0 identity, reference periods, pattern-as-one-group, disc differentiality and bar x1 loops, then the engine-mask dispatch table for every mask (share 0/0.5/1, force 0/nonzero, nonzero centres, time-stable membership) against an independent CPU model. Since 0.4.9 it also pins the two sweep anchors: a disc star's reconstruction conserves its birth **cylinder** and carries its height at every azimuth, a spheroidal star still conserves the spherical radius in its centred plane, and the classic sine-difference wobble cannot cross the explicit disc-height cut at either edge. |
| `movement-density-test.js` | Plan 0.4.0 §1.4's distribution-preservation gate: time-averaged radial (log-R), vertical (log-\|z\|) and arm-density (the m-th harmonic of the pattern-referenced phase, in `arms.amp` units) on a population sampled from the field, per engine mask at the shipped view state, every number against its own sampling noise. Pins: the radial **and vertical** columns meet the 3%-per-bin budget on every lane (0.4.9's carried birth height: vertical worst bin 0.000–0.009, mean\|z\| 1.000 on the lanes without the classic wobble), the capture lane is load-bearing (wave 0 loses the arms, wave 0.6 holds 1.7–4.3× the authored contrast), mask 3 ≡ 2 and 7 ≡ 6, a mixed mask's density sits between its parts, the integrator is step-converged, and no star leaves the truncation. |
| `planet-gen-test.js` | 0.5.1's lazy generator (0.5 plan §2–§4): the type and bulk tables, the whole §2.3 channel map claimed into one set so no two features share a draw, Hill-repair stability, the HZ/locking rules, the belt draws, the occurrence law's means, the Solar pins, the stellar-inputs exactness, and the no-allocation build. |
| `dv-map-test.js` | 0.5.4's closed forms (0.5 plan §7) against the published Solar-System map — 19 pins on the model's own formulas over a real table — plus the structural invariants (GEO vs Hill sphere, node gating, Hohmann symmetry), the §7.4 energy-budget blend over the five ship classes, and the no-allocation contract. |
| `route-test.js` | 0.5.5 routes and autopilot (0.5 plan §8): the leg chain's composition, the synodic wait law on the real Earth–Mars pair (φ_req = 44.4°, S = 779.9 d, mean S/2, max S), the accel- and dv-limited ceilings that separate the ship classes, `routePosition` at every leg's endpoints and continuous between them, the two-way totals, the §8.3 interstellar table, and no allocation across 2 000 warm builds. |
| `galaxy-evolution-test.js` | 0.6's epoch tier (E1) and its live clock (E2): every epoch factor exactly 1 at `AGE_REF` with an `AGE_REF` model bit-identical to a fresh build, the factors' laws (monotone, bounded, thick:thin preserved) for all 19 types, only-the-four-amplitudes-move, the sampled arms carrying the parameter's contrast, the disc/halo mass law — then E2's quantum (0.1 Gyr per 100 Myr of star time), its grid walk to the ceiling, the replay, drop-not-bank, the throttle, the hold, and a simulated run that never jumps more than one step. |

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

### Routes and delta-v

`python3 scripts/run.py dv-map` pins the published Solar-System map (38 checks).
`python3 scripts/run.py route` checks 0.5.5 ship invariants, signed launch windows,
cumulative fuel/life support, round trips, interstellar cruise/short-leg profiles,
Kepler/chord autopilot, transformed DV picking, maximum-body fitting and presets
(35 checks). Both are included in `all-tests`. The headless layer tests do not
claim a real WebGPU galaxy visual pass.
