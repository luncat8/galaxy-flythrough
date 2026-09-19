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
- Each file guards `module.exports` so the same source also runs under Node:
	```js
	function someFunc() { /* ... */ }
	if (typeof window !== 'undefined') window.SomeFunc = someFunc;
	if (typeof module !== 'undefined') module.exports = { someFunc };
	```
- No internet links at runtime. Vendor any library as a local `.js` file under `src/vendor/`.
- WGSL shaders are embedded as `<script type="text/x-wgsl" id="shader-name">` blocks in `index.html`, and read via `document.getElementById('shader-name').textContent`. This avoids `fetch()` (which fails under `file://`).
- Binary data tiles are emitted as `.js` files that assign to a `window.__tile_xxx` slot. Load via dynamic `<script>` tag injection, extract the bytes, delete the slot, remove the script. This pattern works under `file://` in all major browsers.
- WebGPU compute shaders should mirror the "no allocations in hot path" rule. Avoid per-vertex `var` declarations inside tight loops; prefer writing directly into pre-typed storage buffers.

## Concepts

- **Camera-relative coordinates.** Galactic XYZ at kpc distances loses precision in `f32`. Always subtract `cameraPosition` before uploading to GPU. Use split-double (`positionHigh` + `positionLow`) for stars beyond ~10 kpc.
- **Density field is the source of truth.** Catalog stars are decoration (named landmarks); the analytical density model defines the spatial distribution. Adjusting the visible star count scales the sampling rate, not the distribution.
- **Two operating modes share the pipeline.** Hybrid (catalog + procedural) and Game (pure procedural). The render pipeline does not know which mode produced a star — both write to the same `StarPacked` buffer.
- **Three render paths.** Path A: bright/nearby billboard sprites. Path B: distant point sprites. Path C: unresolved density cells (additive screen-space quads). One frame may use all three.
- **Indirect draw, no readback.** Compute shader produces visible-star indices and `drawIndirect` args in storage buffers. CPU never reads the visible-star list per frame.
- **Stable hash, no PRNG state.** Every procedural star is `(seed, cellId, slot)` hashed to its properties. PCG hash is the default. The galaxy is fully reproducible across runs and machines.
- **Plan first, implement second.** If a design decision is not in `plan.md`, add it there before coding. Do not leave architectural choices implicit in code.

## Files

- `AGENTS.md` — this file. Project rules.
- `plan.md` — the development plan. Clean artifact, no implementation log.
- `findings-pitfalls-skills.md` — notes and pitfalls for LLM agents. Write here when you find a good way to do something, a non-obvious gotcha, or a useful technique. Append-only.
- `archive/` — superseded plans. When `plan.md` is rewritten substantially, the old version moves here.
- `experiments/` — Node measurement and validation scripts. Not loaded by the page. Run these manually to validate assumptions (hash quality, density model, precision, memory budget).
- `experiments/logs/` — keep useful results. Delete logs that turned out to be dead ends. The point is to leave a trail of *what was measured and what was learned*, not a full audit.
- `src/` — runtime source. Loaded by `index.html` via classic `<script>` tags. No modules.
- `src/vendor/` — vendored libraries. Local copies only. No CDN URLs anywhere in runtime code.
- `src/data/tiles/` — binary tile `.js` files emitted by `experiments/tile-encoder.js`. Each tile assigns a `Uint8Array` to a `window.__tile_xxx` slot.
- `src/render/wgsl/` — WGSL shader sources as `.wgsl` text files. At runtime, these are inlined as `<script type="text/x-wgsl">` blocks in `index.html` (or fetched in http:// mode with a graceful fallback).

## Workflow

- **Plan changes**: edit `plan.md` directly. If the change is substantial, copy the previous version to `archive/plan-vN.md` first.
- **Discoveries**: append to `findings-pitfalls-skills.md` with a date and a one-line summary heading.
- **Experiments**: write a script in `experiments/`, run it, log results to `experiments/logs/`. If the result invalidates a plan assumption, update `plan.md` and note the experiment in `findings-pitfalls-skills.md`.
- **Code**: write to `src/`. Single tab indent. No per-frame allocations. Guard `module.exports` for testability.
- **Subagents**: any subagent working on this repo must read `AGENTS.md` and `plan.md` before writing code. Pass the relevant `Task ID` and the path to `worklog.md`.
