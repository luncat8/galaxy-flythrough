# Distance-field series worklog

The distance field, promoted out of the view-modes island and into the main
WebGPU renderer: the distance from the camera to the stars, the depth spread
between neighbours that look close, and the slope of the distance, painted as
the sky the stars are drawn on. One law, two implementations (a CPU reference
and a WGSL twin), and an app that decides *which stars* the field is computed
over — so it works with any star situation, not the island's one.

Governing plan: [`distance-field-plan.md`](../distance-field-plan.md) (root, open).
The island's own plan and log stay where they are:
[`archive/view-modes-shader-plan.md`](view-modes-shader-plan.md),
[`archive/view-modes-worklog.md`](view-modes-worklog.md).

---

## distance-field.0 — 2026-10-17 — the law leaves the island

The island (`src/view-modes.html`) had the law, a 2D-canvas painter and a page
that main development never had to read. The request was to keep developing it
and to put it into the main WebGPU renderer, working with any stars
situation, with a separate test page carrying radio buttons and sliders. So
the first job was to decide what stays the island's and what becomes the
main tree's.

**The law moved; the island kept the picture.** `src/math/view-modes-field.js`
became `src/math/distance-field.js` (the global `ViewModesField` became
`DistanceField`), and the ramps were pulled out of the island's painter into
`src/render/distance-ramps.js` (`DistanceRamps`: viridis, turbo, magma,
terrain, grey — the same bytes the island has been painting with, so the
island's look did not move). The island's own two files (`render/
view-modes-renderer.js`, `view-modes.js`) stayed island-only: the 2D painter
is still the CPU reference's picture, with its contours, relief and legend.

**The GPU twin.** Two new WGSL parts in `src/render/shaders.js`:
`distance-field` (the compute: `cs_field` over the anchors, `cs_slope` over
the height grid) and `distance-field-display` (the fullscreen triangle that
maps the field through the display range and looks the colour up in the ramp
texture). Both are wired modules now — the list is seven, not five.

The law, once more, because it is the thing that must not drift: for a texel
ray `a` and an anchor at direction `u` from the eye, `c = dot(a, u)`,
`q = max(0, 1 - c²)`, `w = 1/(q + sin²σ)`, and the field accumulates
`Σw`, `Σw·log10(max(d, 1e-3))`, `Σw·d`, `Σw·d²`. Height is `Σw·log10 d / Σw`
(dex), spread is the weighted standard deviation of `d` (kpc), gradient is the
central-difference magnitude of the height grid per radian of sky, in
dex/degree. The raw scalars are physical; the display range is a separate
window that maps raw → 0..1, and the field is never renormalised after
smoothing (view-modes.1's lesson).

**The renderer module** `src/render/distance-field-renderer.js`
(`DistanceFieldRenderer`) owns the buffers, the two compute pipelines, the
per-format display pipeline, the 256×1 ramp texture and the uniform packing
(`packUniform`, 40 floats = 160 bytes). It is deliberately source-agnostic: it
knows about a *list of anchor positions* and nothing else, which is what lets
the main renderer and the test page share it.

**The test page** `src/distance-field.html` + `distance-field.css` +
`distance-field-page.js`: radio buttons for the render type (distance /
spread / gradient / off), the star source (nearest N / selected /
constellations / the whole sky) and the projection (the app's view window /
the sky chart); sliders for the count, the hill width σ, the grid width and
the eye distance; a click-picker; and a live readout. It drives the same
`DistanceFieldRenderer` the main app does, over the same law, with the CPU
owning the display range (read at 4 Hz over a coarse grid, never per frame).

**Parity is a number, not an opinion.** `experiments/wgsl-exec-check.js` runs
the shipping WGSL on the CPU interpreter and compares it with the CPU law
texel by texel: 129/129, with the worst differences at 1.7e-7 dex of height,
3.7e-6 kpc of spread, 8.6e-9 dex/deg of gradient and 1.4e-7 of colour.

Three traps of this step, each worth a line:

* The WGSL interpreter has **no `log10` builtin**, so the shipping shader
  computes `log2(x) * 0.30102999566398120` (`fieldLog10`). `log2` is the same
  function to within an ulp, far below the f32 noise the field carries.
* The **shared helpers must live in the part both modules include**. The
  display shader called `fieldLog10`, which was defined in the *compute*
  part; WGSL has no includes, so the module would not have compiled in a
  browser. `experiments/wgsl-validate.js`'s "every call target resolves in the
  module" check caught it — the interpreter did not, because the parity
  fixture only exercised the compute path.
* In a Node harness `globalThis.window` is the global object, so a module
  lookup written as `typeof window !== 'undefined' ? window.X : require(...)`
  silently yields `undefined` for a module that was not preloaded. The lookup
  has to ask whether the global is *there*: `typeof window !== 'undefined' &&
  window.X`.

**Next:** the main renderer's field stage (M2) — the field painted as the sky
under the stars, and the app's own choice of which stars it is computed over.

---

## distance-field.1 — 2026-10-17 — the field becomes the main renderer's sky

The island's field was a picture on its own page. The main renderer now
paints it under the stars, and the app decides which stars it is computed
over.

**The stage** (`src/render/star-sprites.js`): the field's compute pass and
its display pass run into the HDR intermediate (`rgba16float`) *before* the
star pass, and the star pass switches to `loadOp: 'load'` when the field is
on — so the field is the sky and the stars add on top of it, and the app's
own filmic tonemap grades the picture as one scene. With the field off, the
star pass clears as before. The grid is 180 rows tall and as wide as the
aspect asks (64…640, in steps of 8); the layout is the camera's own basis
(`camera.forward/right/up`) and `tan(fovY/2)` is read out of the projection
matrix (`1/viewProj[5]`), not assumed. The display range is the CPU law's:
`prepareStars` + `computeRaw` + `autoRange` over a 64×36 grid, four times a
second — a range that follows every frame flickers (view-modes.1).

**The anchors** (`src/core/field-anchors.js`, `FieldAnchors`): three sources,
all of them the app's own stars, at the positions they are *drawn*:

* `nearest` — the N nearest of the resident sky, whatever the renderer is
  actually drawing (catalog or procedural, any galaxy type). The scan is
  bounded: the resident set can be 300 k records and a dispatch per record
  costs ~0.3 µs, so a full scan every frame would be a 90 ms hitch. It
  samples with a stride (the sample is spread over the whole sky) and
  re-picks twice a second; the winners' drawn positions are re-dispatched
  every frame, so the field tracks the stars while the set is re-chosen.
* `selected` — the app's selection set, through `selection.resolveDrawn`
  (ui.2's drawn-position contract).
* `constellations` — the named stars, through the same mask dispatch the
  labels and the picker use.

and the nearest scan with a **block filter**, which is how the two
populations are addressed on their own: `catalog` (the Gaia subset alone) and
`procedural` (the generated stars alone). The filter reads the renderer's
block *kinds*, so it survives a change of the block order.

The anchor cap is 1024. The important part is what is *not* here: the
field's arithmetic never learns which provider produced the anchors, so
"works with any stars situation" is a property of the design rather than a
promise.

**The app's controls** (`src/index.html`, `src/main.js`): a *Distance field*
row (off / distance from eye / depth spread / gradient of distance), a *Field
stars* row (nearest N of everything drawn / catalog stars / procedural stars /
selected stars / constellations), and a *Field count* slider (1…500). The renderer's side is `setFieldMode`, `setFieldAnchors`,
`setFieldSigma` and `fieldState()`; the app's side is the choice of stars.

Checks that came with it: `experiments/renderer-test.js` grew the field
stage into the mock device's inventory (six shader modules, six pipelines),
the "field off by default" case, the grid dispatch, the display pass into the
same HDR view, the star pass switching to `load`, the anchor upload as
n×16 bytes, and the off-switch restoring the clear — 143/143. The mock's
`writeBuffer` had to be made faithful to the real API first: it counted
`dataOffset`/`size` in bytes for typed arrays, which silently truncated the
anchor upload to a quarter of its length.

**Two bugs the new tests found in the page**, both of the "the count is not
the length" family: the page's `selected` source read `picked.length` (a flat
array of xyz triples) as a *count*, so one pick became three anchors with two
of them `undefined`; and the click-picker searched the *current anchors* —
the nearest few stars, which sit in one small patch of sky — so a click
anywhere else found nothing. It now searches the whole sky.

**Next:** M3 — the island's features on the GPU path (contours, shaded relief,
the legend strip) — and the browser pass, which is the only way to *see* any
of this.

---

## Open

* **M3** — the GPU path grows the island's features: contours, shaded relief,
  the legend strip, the per-mode range sweep.
* **M4** — the pathfinding export: the field as a cost grid the ship can
  read.
* **The browser pass.** There is no browser in this sandbox, so the picture
  is still unseen: the CPU/GPU parity is numerical, the page's wiring is
  checked headless against a mock device, and the main renderer's field stage
  is checked against a mock device. What nobody has watched yet is the field
  painted under the stars on a real GPU.
* `experiments/planet-gen-test.js`'s "allocates no objects" check is flaky
  (a coarse heap delta over 100 k calls): it passed 2 of 3 runs on
  2026-10-17, unrelated to this series.
