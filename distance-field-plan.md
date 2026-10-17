# The distance field — the heightmap island, promoted into the main WebGPU renderer

Status: **open** (M1 and M2 done — the law, the GPU path, the test page and the
main renderer's field stage all exist; M3 and M4 are still to do). Plan written
2026-10-17, before the code.

This is the plan for the `distance-field` series. It supersedes the GPU-path
questions left open in `archive/view-modes-shader-plan.md` (the island's own
plan): the distance field stops being a 2D-canvas island and becomes a WebGPU
render stage of the main renderer, usable with **any** star situation — the
catalog, the procedural field, the selection set, the constellations, the
nearest N of whatever is resident — plus a **separate test page** that drives
the same GPU path with radio buttons and sliders.

The island (`src/view-modes.html`) is not deleted. It becomes the second
consumer of the same shared law: the CPU reference implementation and the
visual sanity check for the GPU one.

---

## 1. Goal

One field law, two implementations that must agree:

* a **CPU reference** in the main tree (`src/math/distance-field.js`) — the
  island's existing field, promoted, unchanged in its arithmetic;
* a **GPU implementation** in WGSL (`src/render/shaders.js`) driven by a
  renderer module (`src/render/distance-field-renderer.js`).

and one **UI** that lets a person choose what the field is computed *over*
(anchors) and what it *means* (mode), without touching code.

The acceptance test for "one law, two implementations" is numerical: the WGSL
compute and display must reproduce the CPU field on the same anchors to within
the f32 budget, checked by `wgsl-exec` fixtures in
`experiments/wgsl-exec-check.js`, not by eye.

---

## 2. The law (unchanged from the island)

For every texel of a grid, and every anchor `i` (a star at drawn position
`p_i`, the eye at `e`):

```
d_i    = |p_i - e|                       (kpc)
u_i    = (p_i - e) / d_i                 (unit direction, eye -> star)
c      = clamp(dot(ray(texel), u_i), -1, 1)
q      = 1 - c                            (monotone cosine distance, 0 at the star,
                                           2 at its antipode)
s      = 1 - cos(sigma)                   (softening; sigma is the hill half-width)
w_i    = 1 / (q + s)                      (Shepard IDW)
```

and the three raw (physical) scalars:

| mode | raw value | unit | display mapping |
|---|---|---|---|
| `height` | `sum(w_i * log10(max(d_i, 1e-3))) / sum(w_i)` | dex (log10 kpc) | **inverted** linear window on log10 d |
| `spread` | `sqrt(max(0, sum(w_i d_i^2)/sum(w_i) - (sum(w_i d_i)/sum(w_i))^2))` | kpc | `log10` window |
| `gradient` | `|grad(height)|` (central differences, per radian of sky) | dex/deg | `log10` window |

Rules that must not drift:

* **The raw scalar is physical.** The display range is a *separate* window that
  maps raw → 0..1. It is never re-derived from the smoothed field, and the
  field is **never renormalised after smoothing** (view-modes.1's lesson: a
  per-frame auto range flattens the legend and flickers).
* `height` is inverted (the near end is the top of the ramp); `spread` and
  `gradient` climb with the raw value.
* Angular distance is monotone over the sphere. `sin²(delta)` is not: it gives
  a star's antipode the same weight as the star itself, creating a false second
  projected star. Use `1 - cos(delta)` with softening `1 - cos(sigma)` in both
  CPU and WGSL.
* The main view projection uses the live camera position, forward, right and up
  vectors, its explicit vertical FoV, and the current canvas aspect. Never read
  FoV from a view-projection matrix element: after multiplication by the view
  matrix those elements include camera orientation and change on roll.
* A star *at* the eye is dropped (its direction is undefined and its hill
  would cover the sky).
* The gradient is read off the `height` grid, not off four extra star sweeps:
  one `O(w*h)` pass over what mode 1 already computed.
* On a full-sky chart the longitude wraps; the latitude does not (a pole is a
  real edge of the parameterisation). The slope's longitude rows shrink with
  `cos(lat)`, so the derivative is per angle of sky, not per texel of map.

Both projections are supported by the law and by both implementations:

* `view` — gnomonic, the app's own 60° FoV window. `ray = normalize(fwd +
  right * u * 2 tan(fovY/2) * aspect + up * v * 2 tan(fovY/2))` with
  `u = (px+0.5)/w - 0.5`, `v = 0.5 - (py+0.5)/h`.
* `plane` — the equirect sky chart, longitude mirrored (the sky as the viewer
  sees it), pannable by a quaternion.

---

## 3. File map

### Main tree (the shared law and the GPU path)

| file | role | global |
|---|---|---|
| `src/math/distance-field.js` | **promoted** from `src/math/view-modes-field.js`. The law: quaternions, layouts (`createLayout`/`dirAt`/`texelOf`), `prepareStars`, `computeRaw`, `applyRange`/`autoRange`, `fieldSlope`, `heightAt`, the star sets (`buildConstellationSet`, `createCatalogIndex`, `createSampledIndex`, `queryNearest`, `advancePositions`, `prepareIndexPositions`). | `DistanceField` |
| `src/render/distance-ramps.js` | **promoted** from `src/render/view-modes-renderer.js`: the five ramps (viridis, turbo, magma, terrain, grey), `resolveRamp`, the per-mode default ramp. One ramp source for the island painter and the GPU display pass. | `DistanceRamps` |
| `src/render/distance-field-renderer.js` | **new**. The WebGPU field renderer: the compute and display pipelines, the anchor/field/gradient buffers, the uniform packing, the ramp texture, `setAnchors`, `render`. Used by the main renderer *and* by the test page. | `DistanceFieldRenderer` |
| `src/render/shaders.js` | **new WGSL part** `distance-field` (compute + fullscreen display) and a new wired module. | `GalaxyShaders` |
| `src/render/star-sprites.js` | the main renderer gains a field stage: the field pass replaces the HDR clear when the mode is not `off`, so the field is the sky the stars are drawn on. | `StarSprites` |
| `src/core/field-anchors.js` | **new**. The anchor providers: which stars the field is computed over — `nearest` (the resident sky), `selected` (the selection set), `constellations` (the named stars). It hands over positions and nothing else; the renderer never learns which provider produced them. | `FieldAnchors` |
| `src/main.js`, `src/index.html` | the field controls (mode, source, count) and the per-frame anchor update. | — |

### The separate test page (new)

| file | role |
|---|---|
| `src/distance-field.html` | the page: a WebGPU canvas, the radio buttons, the sliders, a readout. |
| `src/distance-field.css` | the page's own styling (the island's `view-modes.css` is the model). |
| `src/distance-field-page.js` | the page's boot: device, the anchor providers, the radio/slider wiring, the render loop. |

The page is a **harness**, not a second app: it loads the same
`DistanceFieldRenderer` and the same `DistanceField` law the main app uses,
so what it shows is what the main renderer draws.

### The island (changed, not deleted)

`src/view-modes.html` now loads `math/distance-field.js` and
`render/distance-ramps.js` from the main tree instead of its own copies;
`src/render/view-modes-renderer.js` (the 2D painter) and `src/view-modes.js`
(the boot) stay island-only. The island keeps its 2D canvas, its drag-pan
chart, its contour/relief painting — the CPU path is the *reference*, and it
keeps the features the GPU path does not have yet.

---

## 4. The GPU path

### Passes

1. **field compute** (`cs_field`, `@workgroup_size(8, 8)`) — one invocation per
   grid texel. Reads the anchor buffer, evaluates the law above, writes
   `height` and `spread` into the field buffer (`array<vec4f>`, 16 B/texel).
   Cost: `O(w*h*N)`; at 320×180 and N = 512 that is 29 M texel-anchor pairs —
   a fraction of a millisecond on a discrete GPU, and the reason the GPU path
   can afford a *higher* resolution than the CPU one (the island budgets
   72×40).
2. **slope compute** (`cs_slope`) — only when the mode is `gradient`.
   Reads the `height` channel, central-differences it per radian of sky
   (longitude wraps on a chart, rows shrink with `cos(lat)`), writes the
   magnitude in dex/deg into the gradient buffer. `O(w*h)`.
3. **display** (`vs_full` + `fs_field`) — a fullscreen triangle. It reads the
   field (or gradient) buffer, maps each texel's raw value through the
   display range, and looks the colour up in the ramp texture.

   The four corners are read and the range is applied to *each* corner
   before the bilinear mix, because the range mapping is not linear for
   `spread`/`gradient` (`log10`): interpolating raw values and then mapping
   would not be the CPU's mapping. The CPU paints the 0..1 field and lets the
   canvas interpolate it; the GPU does the same, in the same order.

### Buffers and uniforms

* `anchors`: `array<vec4f>`, `xyz` = the anchor's **drawn** position in kpc
  (galactic frame), `w` = spare. Absolute positions, not eye-relative: the
  shader subtracts the eye, exactly as the star sprite does (measured f32
  error at 100 kpc: 0.005 pc).
* `field`: `array<vec4f>` — `(height, spread, 0, 0)` per texel.
* `gradient`: `array<f32>` — the slope per texel.
* `uniform` (one 160-byte block, ten `vec4f`): the eye and `tanHalfY`; the
  basis (`fwd` + the aspect, `right` + `sigma`, `up` + the anchor count); the
  chart's pan quaternion and its inverse; the grid size, the mode and the
  layout kind; the display range (`lo`, `hi`) and the chart spans; the texel
  angular sizes and the gain; the `wrapX`, `canvasW`, `canvasH` and
  `mirrorLon` flags. `DistanceFieldRenderer.packUniform` is the only place
  that writes it, and the parity fixture reads the same function, so the two
  cannot drift.

The anchors are uploaded only when the *set* changes; their positions move
with star time, so the CPU re-uploads the positions it has advanced (the
island's `advancePositions`, the same `Orbit.engineRecordPosition` dispatch the
labels and the picker use).

### Ranges

The CPU owns the range. `autoRange` (percentile-based for `spread` and
`gradient`, the anchor scale for `height`) is computed on the CPU at a few
hertz, eased, and pushed to the GPU as `lo`/`hi`. **No GPU readback**: the
range is declared, not measured on the device. This is the same split the
island uses, and it is what keeps the legend a measurement rather than an
adaptive paint.

### Where the field is drawn

* **In the main renderer**: the field pass writes the HDR intermediate
  (`rgba16float`) with the star pass switched to `loadOp: 'load'`, so the
  field is the sky and the stars add on top of it. The ramp colour is then
  scene radiance, so the display pass converts the ramp's sRGB bytes to
  linear and the app's own tonemap applies to the field and the stars
  together — one exposure for one picture.
* **In the test page**: the field is the picture, so the display pass writes
  straight to the swapchain (no tonemap).

**The sRGB decision.** The ramp's bytes are sRGB. Both canvases are
configured `colorSpace: 'srgb'`, which means the canvas encodes *linear*
values on presentation. So the display pass decodes the ramp's bytes to
linear (`fieldSrgbToLinear`) and both consumers get the same linear radiance:
the main app's filmic tonemap grades the field and the stars as one scene,
and the test page's canvas encodes them back to exactly the ramp's colour. A
separate "srgb output" flag was planned and dropped — one output convention
is one less thing to get wrong.

---

## 5. Anchors — "any stars situation"

The field is defined over an **anchor set**: a list of stars, with their drawn
positions. The GPU path is source-agnostic; the *source* is a provider that
hands over positions. Five providers, all live in the app:

| source | what it anchors on | cost |
|---|---|---|
| `nearest` | the N nearest stars of the *resident* set — whatever the renderer is drawing, catalog or procedural, in any galaxy type | a strided sample of the resident records (8000), re-picked twice a second; the winners' drawn positions are re-dispatched every frame |
| `catalog` | the nearest N of the **catalog** block alone (the Gaia subset) | the same scan, with the block filter on |
| `procedural` | the nearest N of the **generated** stars alone (the global field and the local ones) | the same scan, with the block filter on |
| `selected` | the app's selection set (≤ 256 members), drawn positions via `selection.resolveDrawn` | exact, per frame |
| `constellations` | the named stars (landmarks), at their drawn positions | exact, per frame |

The **test page** has two more, because it is a harness with a sky of its
own: `sky` (every sampled star, thinned to the cap) and its own `selected`
(the stars the user clicked).

The `nearest` scan is bounded on purpose: the resident set can be 300 k
records and a dispatch per record costs ~0.3 µs, so a full scan every frame
would be a 90 ms hitch. The scan samples with a stride (the sample is spread
over the whole sky, not taken from one corner of it) and re-picks a few times
a second; the winners are re-dispatched every frame, so the field tracks the
stars even while the set is being re-chosen.

The anchor cap is 1024 (the island's `MAX_STARS`). The GPU cost is
`O(w*h*N)`, so the cap is the field's resolution/quality trade: the CPU island
could afford 1024 at 72×40; the GPU affords 1024 at 320×180.

**The important part**: the field's *arithmetic* does not know or care which
provider produced the anchors. That is what makes "works with any stars
situation" a property of the design rather than a promise: the catalog, the
procedural galaxy, the selection set and the constellations are four providers
of the same list of positions.

---

## 6. The test page — radio buttons and sliders

`src/distance-field.html`, its own file, loaded by nothing else.

* **Render type** (radio buttons): `height` (the distance from the eye),
  `spread` (the depth spread), `gradient` (the slope of the distance), `off`.
* **Stars** (radio buttons): `nearest` N, `selected`, `constellations`, `sky` —
  and the same choice as a **slider** (the *Star source* slider steps through
  the four and moves the radio with it, so the two controls cannot disagree).
* **Count** (slider, 1…500): how many nearest stars.
* **σ** (slider, 0.5…15°): the IDW hill half-width.
* **Field width** (slider, 64…640): the GPU grid's width in texels.
* **Eye distance** (slider, 10⁻⁴…10⁴ pc): how far from the Sun the eye sits.
* **Projection** (radio buttons): `view` (the app's gnomonic window) or
  `plane` (the full-sky equirect chart).
* A click on the field picks the star under the cursor into the page's own
  selection, so the `selected` source has something to select. The search is
  over the whole sky, not over the current anchors: the anchors are the
  nearest few stars, which sit in one small patch of sky.

The page shows a live readout: the mode, the anchor count, the range, and
the field's per-mode statistics. It is the place where the GPU path is judged
against the island's CPU field side by side.

---

## 7. Stages

| stage | what | state |
|---|---|---|
| **M1** | the shared law promoted into the main tree (`math/distance-field.js`, `render/distance-ramps.js`); the island loads them; the WGSL parts; the GPU renderer module; the test page; the parity fixtures | **done** (2026-10-17) |
| **M2** | the main renderer's field stage: `star-sprites.js` draws the field as the sky; the app's controls and the anchor providers; the field works with every source | **done** (2026-10-17) |
| **M3** | the GPU path grows the island's features: contours, shaded relief, the legend strip, the per-mode range sweep | planned |
| **M4** | the pathfinding export (the island's "Output for game"): the field as a cost grid the ship can read, on the GPU or from the CPU reference | planned |

M1 is the risky part (two implementations of one law); M2 is the integration;
M3 and M4 are the extras.

---

## 8. Tests

* `experiments/distance-field-test.js` — the CPU law: the layouts, the IDW
  values, the range mapping, the slope (including the chart's wrap and
  `cos(lat)` rule), the star sets, the nearest query. The island's existing
  field test, retargeted at the promoted module.
* `experiments/distance-field-page-check.js` — the test page's wiring, headless
  with the mock WebGPU device: the radio buttons switch the mode, the slider
  changes the anchor count, the page writes the anchors and issues the
  compute + display passes.
* `experiments/wgsl-validate.js` — the new wired module's inventory and its
  formulas (the validator pins the wired list and the arithmetic).
* `experiments/wgsl-exec-check.js` — the **parity** fixtures: the same anchors
  through the CPU law and through the WGSL, compared texel by texel. The WGSL
  is f32 and the CPU is f64, so the budget is the f32 epsilon of the
  accumulated sums, not zero.
* `experiments/field-anchors-test.js` — the anchor providers: the nearest-N
  scan returns the nearest records nearest-first, the selection source uses
  the *drawn* positions, the constellations source uses the named stars, the
  count is bounded, and an empty sky yields no anchors instead of throwing.
* `experiments/m1-smoke-test.js` — the page script lists (the promoted modules
  are loaded by `index.html`; the island's own files and the test page's boot
  file are not).

---

## 9. Boundaries and open questions

* **The equirect chart is in the GPU path** (the `plane` layout is in
  `cs_field` and in the display's letterbox), but the main app only ever
  shows the `view` layout: the app's camera is a window on the sky, not a
  chart. The chart is the test page's and the island's.
* **No GPU readback.** The range is declared by the CPU. A GPU-measured
  range would need a readback stall in the frame, and the island's history
  says a range that follows every frame flickers.
* **The field is a picture, not a measurement API.** The CPU law keeps
  `heightAt` for a cursor or a pathfinder; the GPU path is a renderer.
* **The anchor cap is 1024.** Beyond that the field would need a splat+blur
  formulation instead of the exact IDW — a different law, and therefore a
  different plan. Not this one.
* The visual pass (a real browser, a real GPU) is still outstanding: this
  sandbox has no browser. The CPU/GPU parity is checked numerically, the
  page's wiring is checked headless against a mock device, and the picture
  itself is still unseen.
