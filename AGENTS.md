# AGENTS.md

Project rules for the galaxy fly-through engine. Read before writing any code.

## Style

- Single tab indentation. LF line endings.
- Avoid deep nesting of braces `{ }` and long if-else chains. Flatten with early returns, helper functions, or flat data tables.
- Avoid duplication of code. Extract shared helpers; if two functions are 80% identical, factor the 80% out.
- Avoid allocations in the hot path (per-frame loop, sim, render).
- No new `{}`, `[]`, object literals, closures, or string concat inside the frame loop.
- Reuse preallocated buffers / typed arrays / scratch objects.
- Allocate once at setup, mutate in place per frame.
- These are not strict rules — use best judgement. A 1-byte allocation in a 60 Hz loop is fine; a 4 KB closure capture is not.
- `plan*.md` is NOT the implementation log. If you need to revise the plan, edit it in place and keep it as a clean artifact. Someone forking the repo should be able to reimplement from the plan alone, without referring to chat history or implementation notes.
- Only essential, concise comments in code — explain *why* and the decision, not *what*. Prefer descriptive naming over comments.
- No legacy support, no old versions, no outdated browsers, no leftovers, no over-protecting from unreal edge cases. Clean architecture only.

## Runtime

- `file://` friendly. The page must run when double-clicked locally.
- Classic `<script>` tags only. No ES modules, no `import`/`export`, no bundler, no build step.
- Each file exposes **one API object** to both environments — the page and Node must see the same object, never two hand-written lists:
	```js
	function someFunc() { /* ... */ }
	const SomeLib = { someFunc, SOME_CONSTANT };
	if (typeof module !== 'undefined') module.exports = SomeLib;
	if (typeof window !== 'undefined') window.SomeLib = SomeLib;
	```
- No internet links at runtime. Vendor any library as a local `.js` file under `src/vendor/`.
- WGSL shaders live in `src/render/shaders.js` as JS template strings, split into mirrorable parts and concatenated into complete modules. No `.wgsl` files, no `text/x-wgsl` blocks in `index.html`, no `getElementById` at boot: `require()`-able shaders are the only way `wgsl-validate.js` can diff them against the JS model, and one copy in one place cannot drift against itself.
- The catalog is **one** bundle file, `src/data/tiles/catalog.js`, assigning `window.__galaxy_catalog` (bands, cells, base64 `StarPacked` payloads). Load once via dynamic `<script>` tag injection, read the global, delete it, remove the script. One file per cell does not scale — this catalog would be 2045 script tags.
- WebGPU compute shaders should mirror the "no allocations in hot path" rule. Avoid per-vertex `var` declarations inside tight loops; prefer writing directly into pre-typed storage buffers.

## Concepts

- **Workflow.** galaxy type -> galaxy features (arms, bar, core,...) -> density field -> stars distributions -> orbits and mechanics to keep distribution and density stable in time. Density is visible shape of galaxy and in this project is more important then star types distribution (young, old, big, N-generation, etc).

- **Camera-relative coordinates.** Galactic XYZ at kpc distances loses precision in `f32`. The shader subtracts a `f32` `camera.position` uniform from every star; measured error is 0.005 pc at 100 kpc (`precision-test.js`), so split-double is not used. The CPU keeps positions in `f64`.
- **The model is truncated, and the truncation lives in the model.** `density.js` applies the same disc/bulge cuts that the sampler draws inside (`TRUNCATION`); the WGSL mirror carries the same constants. A profile that is truncated in the sampler but not in the field makes every density-weighted decision (nebula placement, dominant component, thinning) disagree with the stars on screen.
- **Draw the frame even when nothing is resident.** An empty residency set still clears and presents; early-returning with a stale framebuffer shows a galaxy that the camera has already left.
- **Density field is the source of truth.** Catalog stars are decoration (named landmarks); the analytical density model defines the spatial distribution. Adjusting the visible star count scales the sampling rate, not the distribution.
- **Two operating modes share the pipeline.** Hybrid (catalog + procedural) and Game (pure procedural). The render pipeline does not know which mode produced a star — both write to the same `StarPacked` buffer.
- **Three render paths.** Path A: bright/nearby billboard sprites. Path B: distant point sprites. Path C: unresolved density cells (additive screen-space quads). One frame may use all three.
- **Indirect draw, no readback.** Compute shader produces visible-star indices and `drawIndirect` args in storage buffers. CPU never reads the visible-star list per frame.
- **Stable hash, no PRNG state.** Every procedural star is `(seed, cellId, slot)` hashed to its properties. PCG hash is the default. The galaxy is fully reproducible across runs and machines.
- **Plan first, implement second.** If a design decision is not in `plan.md`, add it there before coding. Do not leave architectural choices implicit in code. Feel free in improve plans or suggest any global changes if found something better.

## Files

- `AGENTS.md` — this file. Project rules.
- `plan.md` — the development plan. Clean artifact, no implementation log. §19 indexes the per-release plans; shipped ones live in `archive/`, the open one is listed below.
- `0.5.0-plan-planet-generator.md` — the 0.5 plan: star selection and multi-select (0.5.0), the lazy deterministic planet-system generator (0.5.1), star and planet search (0.5.2), the close-system schematic view (0.5.3), the delta-v map (0.5.4), routes and autopilot (0.5.5). CPU-only: no star-buffer or WGSL growth.
- `findings-pitfalls-skills.md` — notes and pitfalls for LLM agents. Write here when you find a good way to do something, a non-obvious gotcha, or a useful technique. Append-only.
- `movement-parity-plan.md` — next correctness task: engine-mask dispatch and rendered/CPU position agreement.
- `deferred-browser-visual-plan.md` — non-blocking browser checks, preset actions, bar polish and GPU profiling; separate from analytical model contracts.
- `worklog.md` — index of versioned implementation logs.
- `archive/` — versioned worklogs (`0.3.x-worklog.md`, etc.), superseded plans, and the plans of release series that have shipped (`archive/0.2-plan-HDR-saturation.md`, `archive/0.3.0-plan-galaxy-types-star-distribution.md`, `archive/0.4.0-plan-star-move.md`, `archive/0.4.7-draft-new-star-movement-type.md`, `archive/0.4.8-plan-realistic-3d-shapes.md`, `archive/damping-plan.md`, `archive/plan-0.1.1-tasks.md`). A shipped plan stays the spec a fork reimplements from — archive it, do not delete it, and keep `plan.md` §19 pointing at it. When `plan.md` is rewritten substantially, the old version moves here too.
- `experiments/` — Node measurement and validation scripts. Not loaded by the page. Run these manually to validate assumptions (hash quality, density model, precision, memory budget). `experiments/tonemap-mirror.js` is a shared model helper (not a test).
- `experiments/logs/` — keep useful results. Delete logs that turned out to be dead ends. The point is to leave a trail of *what was measured and what was learned*, not a full audit.
- `package.json` — dev-only dependencies for experiments (`wgsl_reflect`, the CPU WGSL interpreter behind `wgsl-exec`). The page never touches it; the runtime stays dependency-free.
- `src/` — runtime source. Loaded by `index.html` via classic `<script>` tags. No modules.
- `src/vendor/` — vendored libraries. Local copies only. No CDN URLs anywhere in runtime code.
- `src/data/tiles/catalog.js` — the catalog bundle emitted by `experiments/tile-encoder.js`: band table (cell size + streaming radius) and base64 `StarPacked` payloads, assigned to `window.__galaxy_catalog`.
- `src/data/landmarks.js` + `src/data/constellations.js` — the named stars (positions/magnitudes baked at load through `src/math/coords.js`) and the constellation figures as landmark-name edges; drawn as a fixed block of the star buffer plus a 2D label overlay.
- `src/stream/` — catalog streaming: `tile-loader.js` (bundle injection, manifest, per-cell decode) and `cell-manager.js` (residency set, nearest-first budget, decoded-payload LRU).
- `src/math/planets.js` — the 0.5 planet generator (CPU-only, no WGSL): the star-identity keys, `stellarInputs` (a record → mass/luminosity/Teff/R★/age/Z/state/class, per block), the authored planet tables, and the occurrence tier (μ per class, the `f_Z`/state bulk-weight modifiers, the geometric count draw). `src/core/star-set.js` — the selection set: one primary plus up to 256 snapshots keyed by the renderer's per-record identity, so a selection survives a residency rebuild.
- `src/render/shaders.js` — all WGSL, as JS strings; `WIRED_SHADERS` lists what the renderer actually compiles.
- `src/core/presets.js` — the settings-preset format: the whole menu as one URL-language text line (serialize/parse, menu defaults) plus the LLM prompt builder of `archive/copy-paste-preset-prompt.md`, and the built-in named presets (the Milky Way arrival: frozen sky, fly home beside the Sun, constellation lines). main.js owns the DOM glue (copy/paste/save/load/apply, and the builtin buttons). A field tagged with the movement pass that owns it (`engine: 'apocenter'`) is part of the preset only while that pass is selected, and the menu hides the same rows through their `data-engine` attribute.

## Workflow

- **Worklog**: record each development step and its validation in `archive/<major>.<minor>.x-worklog.md`, link new series from `worklog.md`, and end every entry with a next step suggestion.

- **Plan changes**: edit `plan.md` directly. If the change is substantial, copy the previous version to `archive/plan-vN.md` first.
- **Discoveries**: append to `findings-pitfalls-skills.md` with a date and a one-line summary heading.
- **Experiments**: write a script in `experiments/`, run it, log results to `experiments/logs/`. If the result invalidates a plan assumption, update `plan.md` and note the experiment in `findings-pitfalls-skills.md`.
- **Code**: write to `src/`. Single tab indent. No per-frame allocations. Expose one API object to both environments.
- **Wiring**: a new `src/**/*.js` file must be added to `index.html` (in dependency order) — `m1-smoke-test.js` fails if a source file is not loaded or is loaded twice — and, if it is a runtime module, to the `EXPERIMENTS`/`TYPES` tables in `scripts/run.py`.
- **Subagents**: any subagent working on this repo must read `AGENTS.md` and `plan.md` before writing code. Pass the relevant `Task ID` and the path to `worklog.md`.
