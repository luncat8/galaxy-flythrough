# Experiments

Node scripts for validating assumptions and generating baked assets. Not loaded by the page.

Each experiment writes its results to `logs/`. Keep useful logs; delete dead ends.

## Implemented scripts

### Validation tests (run on every change)

- `hash-quality-test.js` — Chi-square, serial correlation, 2D spectral, period check on PCG and Wang hash. Validates the hash used in both `experiments/lib/hash.js` and `src/render/wgsl/pcg-hash.wgsl`. Output: `logs/hash-quality.json`.
- `precision-test.js` — Quantifies f32 vs split-double precision at galactic distances (0.001 to 100 kpc). Determines when split-double is required. Output: `logs/precision-test.json`.
- `packing-test.js` — Round-trip fidelity of the 16-byte `StarPacked` struct and GPU memory budget at 10k/100k/1M/5M/20M stars. Output: `logs/packing-test.json`.
- `filter-test.js` — Priority score distribution, magnitude-band completeness, hash thinning determinism, screen-space thinning. Output: `logs/filter-test.json`.
- `wgsl-validate.js` — Cross-checks WGSL constants and function signatures against the JS source of truth. Output: `logs/wgsl-validate.json`.

### Density / star-type / nebulae tests (run when model changes)

- `density-distribution-test.js` — Validates that rejection sampling from `rhoTotal` reproduces the analytical disc/bulge/halo/arm distribution. Output: `logs/density-distribution.json`.
- `star-types-evolution-test.js` — Validates that stellar types are placed at evolutionarily-correct positions (O/B in arms, RG in bulge, etc.). Output: `logs/star-types-evolution.json`.
- `nebula-placement-test.js` — Validates compact nebula placement (HII in arms, planetary in bulge, none in halo). Output: `logs/nebula-placement.json`.
- `visualize-data.js` — Produces a JSON sample (stars + nebulae + density grid) for the Python visualisation script. Output: `logs/galaxy-sample.json`.

### Asset generation (run once per data refresh)

- `tile-encoder.js` — Reads Gaia CSV (or FITS via vendored parser), applies magnitude and quality cuts, converts RA/dec/parallax to galactic XYZ, emits binary tile `.js` files to `src/data/tiles/`. Run once per catalog refresh.
- `density-baker.js` — Evaluates the analytical Milky Way density model on a 64×64×32 grid, packs into RGBA8, writes `src/data/density-field.js`.

## Shared libraries (`experiments/lib/`)

These modules are the source of truth for the analytical model. The corresponding WGSL files in `src/render/wgsl/` must mirror them exactly — `wgsl-validate.js` enforces this.

- `density.js` — Analytical Milky Way density: thin/thick disc, bulge, halo, spiral arms. Mirrored by `density.wgsl`.
- `hash.js` — PCG + Wang hash functions. Mirrored by `pcg-hash.wgsl`.
- `sampling.js` — Rejection sampling of star positions from the density field.
- `star-types.js` — Salpeter IMF, age by component, evolution state, 18-point mass-Teff table, spectral classification. Mirrored by `procedural-gen.wgsl`.
- `nebula.js` — Compact nebula placement: 5 types (HII, reflection, planetary, dark, SNR) with gas vs stellar probability separation.

## Running

```bash
# Validation tests (run on every change)
node experiments/hash-quality-test.js
node experiments/precision-test.js
node experiments/packing-test.js
node experiments/filter-test.js
node experiments/wgsl-validate.js

# Density / star-type / nebulae tests (run when model changes)
node experiments/density-distribution-test.js
node experiments/star-types-evolution-test.js
node experiments/nebula-placement-test.js
node experiments/visualize-data.js

# Asset generation (run once per data refresh)
node experiments/density-baker.js   # writes src/data/density-field.js
node experiments/tile-encoder.js --input gaia-dr3-subset.csv --output src/data/tiles/
```

## Style

All scripts follow AGENTS.md style: single tab indent, guard `module.exports`, no per-call allocations in inner loops. Each script prints a verdict at the end and writes structured JSON to `logs/`.
