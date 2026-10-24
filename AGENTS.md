# AGENTS.md

 These are not strict rules. Feel free in improve plans or suggest any global changes if found something better. If user's idea is not clear for you - do not guess but ask.

## Style

- Single tab indentation. LF line endings.
- Avoid deep nesting of braces `{ }` and long if-else chains. Flatten with early returns, helper functions, or flat data tables.
- Avoid duplication of code. Extract shared helpers; if two functions are 80% identical, factor the 80% out.
- Avoid allocations in the hot path (per-frame loop, sim, render).
- No new `{}`, `[]`, object literals, closures, or string concat inside the frame loop.
- Reuse preallocated buffers / typed arrays / scratch objects.
- Allocate once at setup, mutate in place per frame.
- but use best judgement. A 1-byte allocation in a 60 Hz loop is fine; a 4 KB closure capture is not.
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
- **Plan first, implement second.** If a significant design decision is not in `plan.md`, add it there before coding. Do not leave architectural choices implicit in code.

## Files

- `AGENTS.md` — this file. Project rules.
- `plan.md` — the development plan. Clean artifact, no implementation log. §19 indexes the per-release plans; shipped ones live in `archive/`, the completed 0.5 series is also archived below.
- `archive/0.5.0-plan-planet-generator.md` — the 0.5 plan: star selection and multi-select (0.5.0), the lazy deterministic planet-system generator (0.5.1), star and planet search (0.5.2), the close-system schematic view (0.5.3), the delta-v map (0.5.4), routes and autopilot (0.5.5). CPU-only: no star-buffer or WGSL growth.
- `findings-pitfalls-skills.md` — notes and pitfalls for LLM agents. Write here when you find a good way to do something, a non-obvious gotcha, or a useful technique. Append-only.
- `movement-parity-plan.md` — the engine-mask dispatch and rendered/CPU position contract
  (shipped 2026-10-11; the file is the contract, not an open task).
- `evolution-plan.md` — the 0.6 series, galaxy evolution over time: E1 the epoch tier
  (shipped, with the runtime coupling E1b), E2 the epoch's live clock (shipped: the
  epoch runs on the star-time axis, `galaxy.evolveTick`), E3 morphology growth
  (shipped: the spheroid assembles in size, `a/b/c ∝ mass^⅓`, the arm ridge
  re-anchored additively to the moving bar tip, the bar's pattern speed re-derived
  from its own length), E4 continuous epochs (shipped: the field is drawn once and
  *placed* at the running epoch — the pattern's phase is an accumulator
  (`orbit.setPatternClock`), the epoch map rides a uniform lane (`camera.epoch`,
  `orbit.epochMap`), the look follows in per-frame slices (`renderer.stepEpoch`), and
  an epoch change is never a re-sample), E5 events (**deferred** 2026-10-22, behind
  0.7's record time axis), E6 chemical evolution (optional).
- `formation-plan.md` — the 0.7 series, formation from gas: an epoch becomes a
  census rather than a tint. **0.7.0 shipped:** the composite object block is
  carried, not re-placed as the clock moves. **0.7.1 shipped:** the global field
  gets one deterministic `f32` birth per star from the reference-span SFH table,
  with a conditional arm/lane birth to preserve the established spatial OB
  population; the vertex `smoothstep(birth, birth + 0.05 Gyr, age)` gates it and
  the look follows elapsed time through `deriveStarWithAge`. CPU picks, rings,
  search and planetary stellar inputs read the same birth law. **0.7.2 shipped:**
  `AGE_MIN` 0.2 → 0, with the deep-time degeneracies resolved by meaning: the
  heat floor keeps `discHeightAt` finite for the picker, the spheroid axes
  collapse to 0 with a `spheroidA > 0` guard, `barPatternSpeed` returns 0 on a
  0-size spheroid, and the additive phase0 guard skips `Math.log(0)`. **0.7.3
  shipped:** the renderer builds a 1024-bin birth histogram once per field
  draw; `censusGasAt(age)` evaluates the smoothstep presence at O(1024) per
  frame, and the resulting view gas replaces the SFH `gasNow` only for the
  field's arm contrast. Both endpoints are exact by construction
  (`gas(0) = 1`, `gas(AGE_REF) = gasFraction`); the histogram matches the
  exact O(N) sum within 0.25 % absolute. The SFH gas stays on `populations`
  for every other consumer (nebulae, clusters, the gasRich gate). **0.7.3a
  (correction):** the census is drawn in the *reference* frame — component
  shares, truncation, birth law and the epoch map's base are `AGE_REF`'s, so a
  draw taken at deep time is the present-day census gated by birth rather than
  that epoch's degenerate geometry (a `T = 0` draw used to hand the run a
  99.7 % halo census); and the gas account's reference sum is evaluated after
  its histogram is marked valid, so `censusGasAt` returns a value at all.
  Every epoch landing goes through `main.js`'s one `solveEpochAt`. The
  **Formation checks** panel (ui.21) presses these states and reads the
  account back. Remaining: the 64×96×4 gas grid (F5) and local nebula rates.
- `deferred-browser-visual-plan.md` — non-blocking browser checks, preset actions, bar polish and GPU profiling; separate from analytical model contracts.
- `deferred-catalog-evolution-plan.md` — **deferred, non-critical, Milky Way only**: streamed catalog + local gap-fill stars keep a fixed reference-epoch look at every epoch (including First light). Contract and assumption-based prehistoric-track design for making them evolve; the WebGPU smoke suites currently run with `catalogBudgetStars: 0` and cannot detect it. Keep the passing baseline; plan here, implement later.
- `game-mode-plan.md` — the game mode (g key): the ship as the camera rig with class restrictions (accel cap, Δv tank, cruise fraction from the 0.5.4 ship table), the shared ship clock on the system-ladder convention (§4), the HUD (speed, fuel, distance to the selected object), the burn/flip autopilot and the Flight workspace. G1 shipped (ui.7): `src/core/ship.js`, the flight law, the clock, the text HUD and the input gating; G2 shipped (ui.8): the §5 approach, follow and abort commands and the §6 chrome pass in `label-layer.js`; G3 shipped (ui.9): the single-panel manual-thrust / desired-speed / destination-plan task (fastest, thrust, speed and time limits) with accepted-impulse fuel accounting; G4 shipped (ui.13): docking at any natural flight target (`O`, settled inside its stand-off shell), the station refill (tank + life support), the docked ride on the station's drawn motion, the port of registry with life support's critical band and its hard return-home marker, and the free cargo hook (`L`/`Shift+L`); G5 shipped (ui.14): the Controls-panel `sim clock`/`arcade clock` presets — the ladder's new real-time stop and the autopilot coast auto-warp — with the deferred browser visual pass the series' only open item.
- `workspace-plan.md` — the three workspaces: `observe` (free camera + galaxy control, the look and the map), `fly` (a hull, including a freighter requisitioned off the colony network's routes) and `command` (the colony observer: expeditions, routes, expansion, founding). One `workspace` state replaces the `gameMode` boolean, one panel table `src/core/workspace.js` decides each job's panels (the Flight panel splits into `#sysmenu` and `#routemenu`), the Controls panel reprints itself per workspace, the wheel steps the owning clock, and a switch never rebuilds the field, re-seeds the network or moves a ship. **Shipped (`ui.20`, W0–W6):** `src/core/workspace.js` (the pure table + transitions), the `#mode-bar`, the `#routemenu` split, the mode-scoped Controls panel, the `mode=` preset field, command's authority + Found entrance, and the W5 requisition/release law (`DeltaVLib.FREIGHTER_CLASSES`, `Ship.adoptHull`, `TradeLib.requisition`/`release`).
- `worklog.md` — index of the implementation logs, by release series, by the unversioned `ui.x` interface series and by the unversioned `tooling` series (the runner, the log writer, the generators).
- `archive/` — versioned worklogs (`0.3.x-worklog.md`, etc.), superseded plans, and the plans of release series that have shipped (`archive/0.2-plan-HDR-saturation.md`, `archive/0.3.0-plan-galaxy-types-star-distribution.md`, `archive/0.4.0-plan-star-move.md`, `archive/0.4.7-draft-new-star-movement-type.md`, `archive/0.4.8-plan-realistic-3d-shapes.md`, `archive/damping-plan.md`, `archive/plan-0.1.1-tasks.md`). A shipped plan stays the spec a fork reimplements from — archive it, do not delete it, and keep `plan.md` §19 pointing at it. When `plan.md` is rewritten substantially, the old version moves here too.
- `experiments/` — Node measurement and validation scripts. Not loaded by the page. Run these manually to validate assumptions (hash quality, density model, precision, memory budget). `experiments/tonemap-mirror.js` is a shared model helper (not a test). `experiments/log-file.js` is the one writer for `experiments/logs/*.json`: a rerun whose payload differs only in its top-level `date` keeps the file already on disk, so an unchanged run leaves the tree clean.
- `experiments/logs/` — keep useful results. Delete logs that turned out to be dead ends. The point is to leave a trail of *what was measured and what was learned*, not a full audit.
- `package.json` — dev-only dependencies for experiments (`wgsl_reflect`, the CPU WGSL interpreter behind `wgsl-exec`). The page never touches it; the runtime stays dependency-free.
- `src/` — runtime source. Loaded by `index.html` via classic `<script>` tags. No modules.
- `src/vendor/` — vendored libraries. Local copies only. No CDN URLs anywhere in runtime code.
- `src/data/tiles/catalog.js` — the catalog bundle emitted by `experiments/tile-encoder.js`: band table (cell size + streaming radius) and base64 `StarPacked` payloads, assigned to `window.__galaxy_catalog`.
- `src/data/landmarks.js` + `src/data/constellations.js` — the named stars (positions/magnitudes baked at load through `src/math/coords.js`) and the constellation figures as landmark-name edges; drawn as a fixed block of the star buffer plus a 2D label overlay.
- `src/stream/` — catalog streaming: `tile-loader.js` (bundle injection, manifest, per-cell decode) and `cell-manager.js` (residency set, nearest-first budget, decoded-payload LRU).
- `src/math/planets.js` — the 0.5 planet generator (CPU-only, no WGSL): the star-identity keys, `stellarInputs` (a record → mass/luminosity/Teff/R★/age/Z/state/class, per block), the authored planet tables, the occurrence tier (μ per class, the `f_Z`/state bulk-weight modifiers, the geometric count draw), the architecture tier (disc edges, log-uniform axes, bulk/mass draws, the Hill repair, orbital elements — `architecture()` into the `createArchitecture()` record), the insolation/temperature/band tier (one `thermal()` pass: band, display refinement, runaway, albedo, Teq/Tsurf, locking, HZ/terran flags, plus the `hzInnerAU`/`hzOuterAU` edges), the belt/moon tier (`belts()` into `createBelts()` — presence, fade, scouring, the cap that keeps the inner belt inside the outer one, the Ceres typical body, the stipple seed and `fillStipple`; `moonCount`), and the record tier (`createSystemRecord`/`createSystemSummary`, `generateSystem(ref, ctx, out)` — `stellarInputs` → `architecture` → `thermal` → `belts` → moons, the one `walkPlanets` behind `systemSummary`, and the §4.11 designation writers into one reusable buffer). `src/core/star-set.js` — the selection set: one primary plus up to 256 snapshots keyed by the renderer's per-record identity, so a selection survives a residency rebuild.
- `src/render/shaders.js` — all WGSL, as JS strings; `SHADER_MODULES` lists the modules the page and the validator resolve by name (four the renderer compiles, plus the unbound `star-sprite-hdr` reference variant).
- `src/render/system-layer.js` — the 0.5.3 close-system schematic (plan §6): a log-polar 2D-canvas overlay for the opened system — HZ annulus, `cos i`-squashed orbit ellipses, belt stipples hashed once per `enter`, star/planet icons on the five-bucket mass ramp, its own system-time clock (−1…100 y/s, −1 coupled to the camera fly speed), picking (bodies before belts), autopilot state and the byte-exact §6.6 readout. CPU-only like the label layer; main.js owns enter/exit orchestration (V/Esc/view button; the System panel only collapses to its header), the orbit-object camera lock, the shared `#sysread` and the `data-view` menu gating.
- `src/core/route.js` — CPU-only fixed-cap itineraries, shared ship table, cumulative fuel/life support, signed launch windows, interstellar cruise, closed-form autopilot positions. The system layer draws local routes; main.js wires node picking, round trips, selected-star endpoints and start/pause/resume.
- `src/core/scenarios.js` — the formation checks (ui.21): a pure table of scenario rows, each one a preset line (`query`), a view and two sentences — what the frame shows and what proves it. `main.js` applies a row through `applyPreset`, points the camera at the galactic-centre orbit and reports the live account (built epoch, formed share, view gas, arm contrast, bulge size, field draws since the row started). It is the instrument for the deferred V14 browser rows, not their result; `PRESENT_DAY` is the comparison frame at the model's own `AGE_REF`.
- `src/core/presets.js` — the settings-preset format: the whole menu as one URL-language text line (serialize/parse, menu defaults) plus the LLM prompt builder of `archive/copy-paste-preset-prompt.md`, and the built-in named presets (the Milky Way arrival: frozen sky, fly home beside the Sun, constellation lines; and `Evolve`: the same type from `AGE_MIN` with the star clock at its top rate). main.js owns the DOM glue (copy/paste/save/load/apply, the prompt-free Ctrl+V paste event, and the builtin buttons); `presetQueryOf` is the gate a clipboard or file must pass before it reaches the box — text with no preset key is reported, never printed there. Built-ins carry no star counts (the viewer's budget, not the look); a pasted `stars` re-draws the field at that budget. `applyPlan(settings, changed)` says what a preset costs before it is applied — `rebuild` (type or seed: sample the field), `redraw` (budget/coefficient), `epoch` (the same field at another time: a placement since every draw is reference-framed, 0.7.3b) or `none` — so a preset press never re-samples a field it is only re-timing. A field tagged with the movement pass that owns it (`engine: 'apocenter'`) is part of the preset only while that pass is selected, and the menu hides the same rows through their `data-engine` attribute.

## Workflow

- **Worklog**: record each development step and its validation in `archive/<major>.<minor>.x-worklog.md`, link new series from `worklog.md`, and end every entry with a next step suggestion. Interface work is the one series with no version number — it can land at any time, beside or between the model releases — so it goes to `archive/ui.x-worklog.md` as `ui.<n>` entries; development tooling goes to `archive/tooling-worklog.md` the same way.

- **Plan changes**: edit `plan.md` directly. If the change is substantial, copy the previous version to `archive/plan-vN.md` first.
- **Discoveries**: append to `findings-pitfalls-skills.md` with a date and a one-line summary heading.
- **Experiments**: write a script in `experiments/`, run it, log results to `experiments/logs/`. If the result invalidates a plan assumption, update `plan.md` and note the experiment in `findings-pitfalls-skills.md`.
- **Code**: write to `src/`. Single tab indent. No per-frame allocations. Expose one API object to both environments.
- **Wiring**: a new `src/**/*.js` file must be added to `index.html` (in dependency order) — `m1-smoke-test.js` fails if a source file is not loaded or is loaded twice — and, if it is a runtime module, to the `EXPERIMENTS`/`TYPES` tables in `scripts/run.py`.
- **Testing — run what the change can break, not everything.** `all-tests` splits along the one-way dependency DAG (`field ──► view` and `field ──► world`) into three suites: `field-tests` (density, morphology, sampling, evolution, star movement — ~147 s, 88% of wall time; zero dependency on `view` or `world`), `view-tests` (shaders, renderer, streaming, camera, view-modes, panels — ~8 s), and `world-tests` (planets, selection, search, system view, delta-v, routes, ship flight, colonisation, trade — ~12 s). While working run the named tests (`python3 scripts/run.py trade`); before you finish run `python3 scripts/run.py changed` (walks reverse dependencies automatically) or the affected domain suite (`world-tests` / `view-tests`). Run `all-tests` when touching `field` (`density`, `galaxy`, `sampling`, `orbit` — adding `view-tests + world-tests` on top of `field-tests` costs only ~20 s and verifies downstream consumers like colonisation and ship flight), before a release, or when `changed` reports an unmapped source file. Docs-only changes need no tests. A new slow test (> 5 s) goes into `SLOW` and every new test goes into `SUITES` in `scripts/run.py` (checked at import time).
- **Subagents**: any subagent working on this repo must read `AGENTS.md` and `plan.md` before writing code. Pass the relevant `Task ID` and the path to `worklog.md`.
