# View Modes — a distance-field heightmap on the view sphere

> **Shipped 2026-10-17 (ui.12).** All four stages landed as written:
> VM.0 `src/math/view-modes-field.js` + `experiments/view-modes-field-test.js`
> (16 checks), VM.1 the `view-field`/`view-shade` parts in
> `src/render/shaders.js` + `src/render/view-modes-renderer.js` +
> `experiments/view-modes-renderer-test.js` (13 checks), VM.2 the main.js
> controller (chunked sweep across frames, refresh triggers, render
> switch), the Display-menu section, the `m` key (gated in game mode like
> `V`) and the overlay readout, VM.3 the worklog and findings entries.
> `wgsl-validate` gained the two parts, the `kernelWeight` mirror and
> `textureStore` in its builtin list. Two notes versus the text below: the
> field texture is `rgba16float` (an `r32float` storage texture is not
> sampleable — the filterable 16-bit form carries the value in its red
> lane), and the empty-sky sentinel is written by the compute pass and
> read as `h < 0` in the shade pass exactly as specified.

## Context

`archive/view-modes-shader-draft.md` asks for a heightmap-like
visualization of the star field: (1) distance from the camera to the
stars, (2) the hidden depth between visually-adjacent stars — smooth,
game-usable (gradient = slow travel), live while the star clock runs,
over the constellations or the nearest N stars.

`archive/view-modes-shader-plan.md` was the first implementation plan.
It failed on one decisive point: it designed a **separate page with its
own toy orbit camera**. That cannot show what the feature is for — the
user flies the galaxy with the usual free camera (WASD, drag, wheel,
star time) and wants the distance field *as the sky of that flight*. A
second page with a second camera is a different app. This plan drops
everything the separate page needed (own boot, data plumbing, camera,
plane/sphere toggle, WebGL2/2D-canvas fallbacks, Delaunay, CPU
diffusion) and keeps the feature small: two GPU passes inside the
existing app, driven by the existing camera.

## Design

**The field is a function on the view sphere.** For every direction
from the camera there is one scalar — the "height". The sky *is* the
heightmap: an equirectangular texture in the galaxy frame, centred on
the camera, shaded like terrain (gradient → normal → key light +
contours) and presented through the existing tone mapper. A plane view
is just a patch of this sphere, so there is no plane/sphere toggle.

**Same galaxy, same camera.** `main.js` owns everything: the mode is a
menu/radio state, the source set rides the existing star-time clock,
and the frame loop calls the view-modes renderer *instead of* the star
renderer while a mode is active. Fly, orbit, chase and game modes all
work unchanged — the field is centred on whatever the camera is.

**Two modes** (radio group, default "camera distance"):

1. **Camera distance** — height at a direction = the camera-to-star
   distance of the stars in that direction, normalized per refresh
   (closest star = 1, farthest = 0).
2. **Adjacency** — per star, the mean over its k angular-nearest
   neighbours of `3D separation / transverse separation` (the depth a
   2D shortcut would hide). Visually-close-but-deeply-separated pairs
   push ridges: exactly the "slow travel" cost of the draft.

**Source set** (slider, 0..500):

- `0` = constellations: the landmark table (the named stars the main
  project already draws, Sun included). Generated galaxies have no
  landmarks — the slider then reads "nearest 48" (documented in the
  readout), never an empty sky.
- `1..500` = the nearest N stars to the camera **by drawn position**,
  found by a chunked CPU sweep over the renderer's five record blocks —
  the picker's established pattern (`selection.beginPick`/`pickStep`),
  sliced to stay inside the frame budget. Membership is refreshed when
  the camera has moved or star time has advanced; positions of the
  active set are re-evaluated every frame through the same
  `orbit.engineRecordPosition` / `engineLandmarkPosition` dispatch the
  label layer uses, so the field tracks the star clock exactly as the
  sprites do.

**The algorithm (GPU, realtime by construction)** — the old plan's
Option 1/3 hybrid, on the sphere:

- Pass 1 (compute, `view-field`): fill a small equirectangular
  `r32float` texture (768×384). Each texel converts its UV to a galaxy
  direction, then evaluates a truncated Gaussian kernel mean over the
  star array: `w = exp(−2(1−dot(dir, starDir)) / 2σ²)`, zero beyond 3σ.
  No `acos` — the kernel lives in cos-space (`2(1−cosθ) ≈ θ²`). Value =
  the weighted mean of the per-star scalars (Nadaraya–Watson). A texel
  with no star inside 3σ takes the value of its nearest star, so the
  whole sphere is always filled.
- Pass 2 (fullscreen triangle, `view-shade`): each pixel's view ray is
  built from the camera basis (the same camera-relative convention the
  sprite shader uses), converted to equirect UV, and the field is
  sampled bilinearly. The gradient (two extra samples, corrected for
  the equirect stretch by `1/cos(lat)`) gives a surface normal; a fixed
  galaxy-frame key light shades it; contours and a turbo ramp finish
  the heightmap look. Output: the view-modes HDR intermediate.
- Pass 3: the existing `tonemap` WGSL module, own pipeline, presents
  the HDR intermediate to the swapchain — so exposure/white-point/
  saturation/headroom sliders and HDR output keep working.

The per-star scalar is computed on the CPU (`view-modes-field.js`,
pure, Node-testable): mode 1 is the camera distance; mode 2 is the
adjacency ratio over the source set (O(N²) at N ≤ 500, once per
refresh). Both are normalized per refresh onto the 2nd..98th percentile
window of the set (values beyond it clamp to 0 or 1), so the map spans
its own bulk and a single outlier — a star at a few parsecs, a
near-coincident pair — cannot flatten every other star to one value.

**Kernel width** is automatic: σ = ½ × spacing × multiplier, where
spacing = √(4π/N) is the mean angular separation of the set. The half
spacing is what keeps texture: a width of one spacing or more lets each
star's weight reach its neighbours' centres, and the field collapses to
the set's mean. A smoothing slider scales the multiplier 0.25..4
(default 1). A Lorentzian kernel was tried and rejected: its heavy tail
sums every distant star into every texel, the same collapse.

**Costs** (N = 500): CPU ~0.15 ms/frame for the 500 position
evaluations + a 8 KB uniform upload; the sweep runs sliced (~3 ms per
frame while it completes, one sweep ≈ 0.5 s at 300k records, restarted
only when a trigger fires — camera motion or star time); GPU ~65 M
kernel evaluations per field fill, sub-millisecond on any discrete
GPU, a few ms on integrated. Frozen star time + still camera ⇒ zero
sweeps, a static map to inspect.

**Known approximations** (both inherited from the picker's contract,
both fine for a visualization): under the `simple` engine the CPU
dispatch reports the classic-law position (the exact azimuth lives
only in the GPU mirror); the sweep is exact for `classic` and
`apocenter`.

## Files

- `src/math/view-modes-field.js` — pure CPU field math, one API object
  `ViewModesField`: source selection (constellation anchors, the
  nearest-N bounded-heap sweep), scalar computation (distance,
  adjacency), normalization, uniform packing. No DOM, no GPU, no
  allocations after setup. Node-testable.
- `src/render/view-modes-renderer.js` — the three WebGPU passes, the
  equirect texture and the HDR intermediate (size-managed like the
  star renderer's), per-frame `render(camera, width, height, starState)`.
  One API object `ViewModesRenderer`. Reads nothing from `core/`
  except the camera's exposed basis vectors.
- WGSL in `src/render/shaders.js` (project rule: one copy, one place)
  as two new parts `view-field` (compute) and `view-shade`
  (fullscreen fragment), wired as `view-field` / `view-shade`; the
  shade path reuses the existing `tonemap` module unchanged.
- `src/main.js` — glue only: menu rows, the `m` cycle key (gated in
  game mode like `V`), the sweep scheduler, the per-frame resolve +
  upload, and the render switch:
  `viewModes.isActive() ? viewModesRenderer.render(...) : renderer.render(...)`.
- `src/index.html` — the two new script tags (dependency order: field
  after `orbit.js`, renderer after `shaders.js`) and the View modes
  menu section (radio group, source slider, smoothing slider, contours
  checkbox).
- `experiments/view-modes-field-test.js` — pure CPU tests; registered
  in `scripts/run.py` (EXPERIMENTS + TYPES['test']).

No changes to `star-sprites.js`, `camera.js`, `input.js` internals
beyond the one new action name — the feature is additive.

## Contracts

**Equirect mapping** (mirrored by both shaders; the field texture is
galaxy-frame, north = +Z, so it is stable while the camera turns and
only re-fills on translation, star motion or a source change):

- texel → direction: `u = (i+0.5)/W`, `v = (j+0.5)/H`,
  `lon = (u−0.5)·2π`, `lat = (v−0.5)·π`,
  `dir = (cos lat·cos lon, cos lat·sin lon, sin lat)`.
- direction → UV: `u = atan2(d.y, d.x)/(2π) + 0.5`,
  `v = asin(clamp(d.z,−1,1))/π + 0.5`.

**Star uniform**: one `vec4f` per star — `xyz` = unit direction from
the camera (galaxy frame), `w` = normalized scalar. MAX_STARS = 500,
so the buffer is 8 KB — inside every implementation's uniform limit.

**Field texture**: `r32float`, value 0..1, −1 = empty (no star within
3σ). The shade pass maps empty to the deep-space background.

**Camera-space ray** (shade pass vertex math): the camera's local axes
are +X forward, −Y right, +Z up (camera.js), so a pixel at NDC
`(nx, ny)` yields `dir_cam = normalize(1, −nx·tan(fovY/2)·aspect,
ny·tan(fovY/2))`, and the galaxy ray is
`forward·x − right·y + up·z` from the camera's exposed basis.

**Refresh triggers** (main.js): mode or source change; camera
translation beyond `max(0.25 kpc, 0.1 × farthest selected star)`, which
re-sweeps the nearest-N set (the set is the stars *near the camera*, so
a fixed set is wrong after flight) and refreshes the landmark scalars
in place; or star time advancing, which re-evaluates positions and
scalars every frame on the current membership. A sweep already running
is never restarted mid-walk — the trigger waits, and the next sweep
starts at completion, so the active set is always complete (never
half-walked).

## UI

A "View mode" section in the Display menu:

```
View mode:  ( ) off  ( ) camera distance  ( ) adjacency
Source:     [slider 0..500]  0 = constellations, else "N stars"
Smoothing:  [slider 0.25..4]  ×mean spacing
[x] contour lines
```

`m` cycles off → camera distance → adjacency (gated in game mode).
The overlay gains one line while active: mode, source size, and — for
camera distance — the current kpc range. The Controls panel gains the
`m` entry.

Presets and URL params deliberately do not carry the view mode in this
release: it is an inspection overlay, not a galaxy look (open question
below).

## Tests

`experiments/view-modes-field-test.js` (Node, pure CPU):

- IDW field value at a texel equals the brute-force weighted mean
  (kernel formula and truncation identical to the WGSL by construction
  — both read the same constants).
- Normalization: min → 0, max → 1, monotone; degenerate set
  (all-equal scalars) → 0.5, no NaN.
- Adjacency: ratio ≥ 1 always (3D ≥ transverse), coincident-direction
  pairs clamp, k-nearest selection exact against a sort, empty-set
  guards.
- Nearest-N sweep: the heap keeps exactly the N smallest distances
  against a full sort, across block kinds; the chunked walk covers
  every record exactly once.
- Constellation source: landmark count and the generated-galaxy
  fallback (nearest 48).
- Uniform packing: count, directions unit-length, values within 0..1.

The renderer's GPU passes cannot run in Node; a mock-device smoke test
(pipeline creation, bind-group layout, buffer sizes) follows the
`renderer-test.js` pattern and is part of the same file, skipped when
no harness exists.

## Implementation order

1. **VM.0** — `src/math/view-modes-field.js` + `experiments/view-modes-field-test.js`, registered in `scripts/run.py`.
2. **VM.1** — WGSL parts in `shaders.js` (`view-field`, `view-shade`; `view-field` mirrored by the JS kernel constants) + `src/render/view-modes-renderer.js` with the mock-device smoke test.
3. **VM.2** — `main.js` + `index.html` wiring: menu section, `m` key, sweep scheduler, per-frame resolve/upload, render switch, overlay line, Controls entry.
4. **VM.3** — worklog entry (ui.12), `plan.md` §19 link, findings notes, full `changed` suite.

Each step is shippable: VM.0 is testable alone, VM.1 compiles its
pipelines in the browser console, VM.2 is the user-visible feature.

## Open questions

- **Colour ramp**: turbo for both modes (chosen: distance reads as
  heat, adjacency ridges pop). A grayscale-with-contours option is one
  checkbox away if the turbo read bothers anyone.
- **Star weight**: all stars equal today. Magnitude-weighted kernels
  (bright stars dominate their neighbourhood) would sharpen the
  constellation mode; it is one extra uniform lane if ever wanted.
- **Presets**: the view mode is not preset state (yet) — an inspection
  overlay, not a look. If it graduates to a game-mode cost map, the
  three settings become one `view=` preset field.

## Out of scope

- Pathfinding, ship movement coupling, the 2D map export (the draft's
  game-mode application — the field is the visualization first).
- A plane projection (the view sphere subsumes it).
- CPU-side diffusion, Delaunay triangulation, WebGL2/2D-canvas
  fallbacks (the app is WebGPU-only; no-legacy is project policy).
