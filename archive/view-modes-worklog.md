# View-modes series worklog

The heightmap island: `src/view-modes.html`, its three modules, and the tests that
keep it honest. Born outside the main app; since view-modes.6 the field math and the
painter are shared — `index.html` loads `math/view-modes-field.js` and
`render/view-modes-renderer.js` for its own View modes panel — and only the sandbox
page's boot glue (`view-modes.js`) stays out of the app, with
`experiments/m1-smoke-test.js` as the check that keeps it that way. Governing plan:
[`archive/view-modes-shader-plan.md`](view-modes-shader-plan.md).

---

## view-modes.0 — the island: a per-texel field, a 2D painter, one page

`archive/view-modes-shader-draft.md` asked for two heightmaps over the star field —
distance from the camera to the stars, and the depth spread between neighbours that
look close on screen — realtime while star time moves, over the constellation stars
or the nearest N, on a page that main development does not have to read. The draft
proposed diffusion for the smoothing; the shipped rule is Shepard IDW with p = 2 on
an *angular* half-width (`w = 1/(sin²δ + sin²σ)`), which is one pass over the anchors
per texel, needs no iteration, and leaves the gradient radiating from each star the
draft was after.

Three files, in the order the page loads them (the plan's
`View Modes Shader.4` isolation rule: math and data only, no `core/`, no WebGPU):

- `src/math/view-modes-field.js` — quaternions, the `createLayout` map (texel ↔ ray
  for both projections), `prepareStars`, `computeField` (modes `height` / `spread` /
  `gradient`), the log height scale, `autoResolution`, the constellation/catalog/sampled
  sets, `advancePositions` over the app's own orbit dispatch, `heightAt`.
- `src/render/view-modes-renderer.js` — `renderField` + `renderLegend` on a 2D canvas:
  one cached `ImageData`, bilinear upscale for the smoothing, contour lines, the grid,
  the star dots and constellation segments, the frustum box on a chart, a cached ramp
  strip for the legend. No per-frame allocation.
- `src/view-modes.js` — boot and glue: the app's home pose, the star-set pick, the
  drag-to-look / shift-drag-to-pan input, the readout, the sliders.

V1's numbers were wrong in ways the tests of the time did not catch (it checked value
*ranges*, which any field passes). See view-modes.1.

---

## view-modes.1 — 2026-10-17 — the projection law, and colour that means distance

The user's complaint was specific: *projection or math looks wrong and does not
correspond to stars positions*. Four causes, each now pinned by a check that fails
without the fix:

1. **The map was mirrored.** The basis was re-derived as `right = cross(worldUp,
   forward)`, which is the app's *left*, and the camera's roll was dropped. Replaced by
   `quatBasis(orientation)`, the same three axes `core/camera.js` publishes;
   `experiments/view-modes-field-test.js` compares them against `cam.forward/right/up`
   at a rolled pose and asserts `right · app.right > 0.999`.
2. **The colours did not mean distance.** The field was normalized linearly across the
   set's min/max and then auto-renormalized to `[vMin, vMax]` after smoothing, which
   threw the distance away (every landmark inside 0.005…0.802 kpc landed on one colour,
   and a set of stars all beyond the range read as *closest*). Now a fixed log decade
   scale, `lo = log10(max(1 pc, dMin))`, `hi ≥ lo + 1`, no renormalization, with the
   readout and legend quoting the kpc the ramp actually spans.
3. **`texelOf` was not scale-free.** It took the star's direction and read `lat =
   asin(v.z)` off the *unnormalized* vector, so every chart marker slid toward the
   equator — while the `dirAt → texelOf` round trip stayed green, because a unit ray is
   all it ever saw. It normalizes now, and the test pins both that a direction and
   1000× it land on the same texel and that a marker's texel ray comes back to its star
   (worst 0.000° over the 60 landmarks).
4. **The painter asked where a star is in world coordinates.** Marker and figure
   endpoints went to `texelOf` without subtracting the eye — invisible on a chart (the
   eye is ~0.005 kpc from the origin), degrees off inside the view sphere, where the
   near stars are drawn biggest. `renderField` takes `opts.eye` and subtracts.

Also landed here: the view layout takes the *window* aspect (so the field covers exactly
the frustum the app draws and a marker cannot slide off its star), texel centres use the
`(i + 0.5)/w` convention in the mapping, the painter, the readout and the drag alike; the
chart drops rows instead of squashing them when it cannot hold 180° of latitude and clamps
at the pole instead of folding the far hemisphere back over it; `constellationSegments`
misread the flat `Int16Array` of the data module as an array of pairs, which turned all 41
figure edges into (0, 0) and printed nothing.

The default hill width came down from 10° to 3° (`Field.SIGMA_DEG`): at 10° the near
stars' own texels kept only 0.72 of their height and the whole map sat inside
0.35…0.75 — no red, the flat look again. At 3° they keep 0.89 and the ramp uses 0.78.
Both numbers are now asserted.

### Tests

- `experiments/view-modes-field-test.js` — 44 checks: the camera-basis parity, 64
  landmark sightings landing on the app's own pixel within 0.05 texel, the round trips
  in both layouts and both directions, the scale's meaning and its invariances,
  coverage and finiteness, the mode-1 peak and mode-2 σ, the gradient, seam and mirror,
  the catalog bundle decode and nearest-N, star time through the landmark dispatch, the
  balanced-budget rebuild (10 ms for 500 anchors) and `autoResolution`.
- `experiments/view-modes-page-check.js` — 21 checks (22 with `--png`) that boot the *page* headlessly:
  it reads `src/view-modes.html`, evaluates its scripts in the order the page declares
  them against a stubbed canvas, pumps frames, drags, switches projection and mode, and
  asserts the readout, that a marker dot lands on its star's texel, and that the
  constellation figures were stroked. `--png` writes
  `experiments/logs/view-modes-page-{view-height,chart-height,chart-spread}.png` for the
  eye; there is no browser in the sandbox, so this is the only visual check that exists.
- Both are in `scripts/run.py` (`view-modes-field`, `view-modes-page`), so `quick`,
  `changed` and `all-tests` pick them up; `m1-smoke-test.js` pins the isolation: the
  three island files are loaded by `view-modes.html`, never by `index.html`.

### Open

The plan's GPU stages (`WebGL2` splat + blur, the exported Float32Array cost grid for
pathfinding) are not built — the CPU field hits 500 anchors at 72×40 in 10 ms, so the
GPU path is a resolution question, not a latency one. `src/view-modes.js` copies
`LOOK_SENSITIVITY` and `FOV_Y` from `core/camera.js` rather than importing them, which
is the isolation rule's cost and is said so at the copy.

---

## view-modes.2 — 2026-10-17 — the chart drag law, physical modes, and a live nearest-N

Three user reports, one file each.

### 1. The plane-chart drag glitched (the pan accelerated and slid the sky)

The pan composed `q' = arc(world ray a → world ray b) · q` from *world* rays. The
chart maps a world ray `w` to the map as `q·w`, so the ray under pixel `p` is
`q⁻¹·e(p)`, and the arc that pins a pressed point must be built from `e()`, not from
`q⁻¹·e()`. As shipped it only pinned while `q` was the identity; after one drag the
grabbed sky point slid (27° on a small drag in the reproduction), the next move
composed against an already wrong rotation, and the harder you moved the further it
ran away. This is exactly the case planet-geotectonics' `MapView.drag` handles by
keeping its pointer in `viewPointer` and composing incrementally.

Fixed as the source does, but *from the press* rather than incrementally:

- `chartDirAt(out, u, v, spanX, spanY, mirror)` — a chart pixel's ray in the chart's
  own frame (the body of `dirAt`'s plane branch, extracted).
- `quatDrag(out, q, a, b)` — `q' = arc(a → b) · q`, with `a`, `b` in that frame.
- the page stores the press ray and the press quaternion, so every move is one
  composition from the press: `(arc·q)⁻¹·e₁ = q⁻¹·e₀` up to float error, a drag that
  returns to the press pixel restores the chart exactly, and no per-move error
  accumulates. The ray is built from the *current* `chartQuat` and span, not from a
  one-frame-old layout.

Pinned by `quatDrag keeps the pressed sky point under the pointer` (dot > 1−1e-9 on a
rotated chart), `a chart drag that returns to the press pixel restores the chart`,
`chartDirAt is dirAt without the pan`, the counter-check that the old world-ray arc
drifts > 1°, and two page-level checks that drive real pointer events.

### 2. Mode 3 was hard-limited, and every mode wanted a range

The gradient was `|∇ height| · gradK` clamped to 1 against a fixed "one full height
range per 14°" scale. Near any star the slope exceeded that and every ring saturated:
the "gradient of 1" clump. It was also a slope of a *display* quantity, so it moved
when the display did.

The field is now physical and the range is separate:

| mode | raw scalar | auto range |
|---|---|---|
| 1 height | `log10(d / kpc)` (IDW) | the log distances the field takes (raw min/max) |
| 2 spread | σ of `|star − eye|`, kpc | 5th–95th percentile, log10 |
| 3 gradient | `|∇ log10 d|`, dex of distance per degree of sky | 5th–95th percentile, log10 |

- `computeRaw` writes the raw scalar and fills `stats` (including the suggested
  `autoLo/autoHi` from a 64-bin log histogram; `measure: false` skips it on frames
  that do not need it); `applyRange(raw, count, mode, range, out)` paints. The page
  keeps the range from the last read for a quarter of a second and eases toward new
  bounds, so a moving set cannot flicker the map.
- `autoRange(mode, stats, out)` owns the padding (4% of the span, a 0.3-decade
  floor around the centre). Mode 1's range is the field's own raw min/max, not the
  anchors' `dMin…dMax`: the nearest catalog star is often 10 pc away with no anchor
  on its own texel, and the forced decade this replaced spent 80% of the ramp on sky
  nothing occupied. Manual mode holds one lo/hi per mode and freezes to the live range
  when auto is unchecked (unchecking must not jump the colours). Two sliders, in the
  mode's log10 unit, with the labels reading `kpc` / `dex/°`; in mode 1 they are
  labelled near/far because the height ramp is inverted.
- The chart gradient also divides longitude by `cos(lat)` (clamped at 0.05) before
  quoting a per-degree slope, and measures the column gap the short way round the
  wrapped seam (the plain difference there is `2 − w` and overstated the slope ~w/2
  times); without the cosine a chart's high-latitude rows read low.

Mode 2's raw σ in kpc also replaces the old `dev/(dev+ref)` squeeze, which had been
hiding the whole depth structure inside 0…0.3.

### 3. Nearest-N was frozen at the pick

`buildCatalogSet` decoded, computed every distance, sorted and copied — once, when the
eye moved 10 pc (`markMoved`). So a chart pan, an eye slide or star time did not
re-pick, and the map described a neighbourhood the eye had left.

- `createCatalogIndex` decodes the bundle once (7.5 ms, 3 829 records) into flat
  arrays; `createSampledIndex` does the same for a procedural galaxy (12 000 sampled
  stars) so every galaxy type has a searchable sky.
- `queryNearest(index, measure, cx, cy, cz, want, set)` is a linear scan plus a fixed
  max-heap of `want` entries: exact (pinned against brute force at four centres),
  allocation-free, ~0.3 ms for 500 anchors. It measures the *drawn* sky (`measure`)
  but writes the winners' *birth* records and packed words, so the page's orbit
  dispatch can draw them at any star time without applying the motion twice (pinned).
- The page re-queries whenever the eye moved 2% of the set's own far edge (or 50 pc,
  whichever is larger), the star-time re-pick is throttled to 4 Hz, and the whole
  index is advanced to the current star time at 4 Hz so "nearest" means nearest
  *now*. The old `markMoved` (and the 0.01 kpc threshold) is gone.

### Also

- `experiments/view-modes-field-test.js` 44 → 65 checks; `view-modes-page-check.js`
  21 → 37, and `--png` writes two more shots (`chart-gradient`, `chart-height-250`).
- The galaxy `<select>` offered `Sab`/`Scd`, which `GalaxyLib` has never had
  (`SBa`/`SBc` are the real names); applying them threw. Fixed.

Next: the `--png` shots still cannot show the dots or names (the harness rasterizes
`drawImage` only); a browser pass is the remaining check.

---

## view-modes.3 — a parallel implementation compared; the good shaders picked

`b2c97fbf` (2026-10-17) branched from the same base as view-modes.1 (`1e06672`) and
solved the plan again: one 1552-line `src/view-modes.html` with an inline WebGL2
fragment shader, a 486-line css, and the three shipped modules deleted. Neither branch
is a descendant of the other, so this was a pick, not a merge: every taken feature was
re-implemented against main's own modules and its tests, and nothing from the alt
branch's arithmetic was copied.

### The comparison, measured

| | main (this island, CPU) | `b2c97fbf` (WebGL2 fragment) |
|---|---|---|
| field cost | O(w·h·N), ~0.3 Mpair/ms measured | the same O(w·h·N), per canvas pixel, on the GPU |
| N=500 at `balanced` | 72×40 texels → 1 texel per 720 screen px | full canvas resolution |
| 1920×1080 × 500 stars | 3455 ms/frame | inside the GPU's frame budget |
| inner loop | at the JIT's floor — interleaving the SoA made it *slower* | `pow()` per star per pixel, plus 4 extra star sweeps for the gradient and 4 more for its hillshade |

So the alt branch's only real advantage is the substrate, and its math is worse. The
GPU path stays unbuilt on purpose: per AGENTS.md it would be WGSL in
`src/render/shaders.js` with `wgsl-exec` parity, and there is no browser in this
sandbox to measure it against a CPU fallback. The plan's §1 recommendation is amended
to say so (see the plan's *Status* note).

### Taken

- **The published Turbo polynomial** (Mikhailov 2019, degree 5) replaces the 11
  hand-picked stops. Measured against the polynomial the stops were off by up to
  92/255 on one channel (mean 52) — a different colour, and the joins banded. It is
  sampled into the same 256×3 LUT at load, so the frame loop still costs one index.
- **Magma and terrain ramps, and a ramp picker.** `ramp` radio row: `auto` keeps the
  per-mode default (viridis / turbo / grey), anything else overrides for every mode.
  Stops are now `[t, r, g, b]` so the hypsometric terrain ramp can put sea level at
  0.20 instead of halfway up.
- **Shaded relief** (`relief` slider, default 6×, 0 = off): the cartographic NW light at
  45°, on the *displayed* field's own slope, so the shading and the contours cannot
  disagree about which way is up. The slope is the new shared `fieldSlope` — the same
  central differences mode 3 uses, extracted so the seam and cos(lat) rules live in one
  place — and the exaggeration's unit is a degree of sky, so it does not change when
  the resolution does. The shade is clamped to `[0.45, 1]`: relief darkens and never
  brightens, because a clipped highlight would make the colour stop meaning the value
  the legend quotes.
- **The index link.** `index.html`'s help panel gains a `view modes ↗` chip (styled with
  the panel's own chip rule, not the alt branch's inline blue).

### Left behind, with why

`fetch('data/gaia-subset.csv')` (breaks `file://`, and swallows the failure); linear
min-max height normalization (the flat-ramp bug view-modes.1 fixed); the cone term
`max(0, u − slope·r)` that makes the field a UI setting instead of a measurement;
gradient-by-four-star-sweeps plus the hard clamp (the "gradient of 1" wall);
hillshade-by-four-more; `computeAdjacencyDiscrepancy`'s O(n²) with n² `{star, ang}`
objects per refresh; `pool.sort()` + `slice()` over all stars instead of the max-heap
query; Euler yaw/pitch instead of the quaternion pan; a WebGL1 fallback that could never
compile its own `#version 300 es` sources; the Dijkstra travel-corridor and the hover
HUD (out of scope for this pick).

### Tests

`view-modes-field-test.js` 65 → 70: `fieldSlope`'s cos(lat) longitude unit, the map-ward
y sign, seam continuity and the analytic slope of `cos(lon)`, and mode 3 as exactly the
magnitude of the shared slope. `view-modes-page-check.js` 37 → 51: the ramp set and its
fallbacks, the turbo-polyto-byte pin, the ramp reaching the page and the readout, and
relief — repaints, darkens-only, differential shading, identical flat map at 0 twice, and
the measured `raw` field untouched by a display effect. `--png` writes four more shots
(`chart-height-terrain`, `chart-height-magma`, `view-height-turbo`, `chart-height-flat`).
The harness's `pump()` now keeps its frame clock monotonic (a negative `dt` was silently
starving the 4 Hz reads).

Next: the GPU path, if a browser pass shows the 72×40 budget is the thing hurting — as
WGSL in `shaders.js` with `wgsl-exec` parity, CPU field kept as the fallback and mirror.

---

## view-modes.4 — 2026-10-17 — the field in the main frame (WebGPU overlay)

The island proved the maths; this series puts the same picture inside the real
frame and makes it a property of the renderer, not of a star set picked on the
side. Three passes hang off `render/star-sprites.js` and read the renderer's own
`StarPacked` storage buffer — procedural field, landmarks, composite objects,
local gap-fill and streamed catalog, hybrid and Game mode alike. There is no
nearest-N sweep, so there is no population at which the overlay stops describing
the stars it is drawn over.

**The passes.** `field-splat` is one instanced quad per record, using the same
`starMovedPosition` header the sprite vertex stage uses (epoch map, classic →
simple → apocenter dispatch), so the field follows star time by construction.
The vertex projects the record and writes `log10(max(d, 1 pc))`; the fragment
adds the moments `(w, w·l, w·l², w)` with `w = (1−r²)²` into a half-canvas
`rgba16float` target. The footprint covers ~1.2 mean inter-star spacings, clamped
2.5…40 px, so a 50-star sky still fills the map and a 300 k-star one does not
overdraw. `field-blur` is the fixed 3×3 binomial kernel (4·centre, 2·edges,
1·corners, /16) at field resolution — separate from the composite so the
derivative modes read one blurred value, not nine texels. `field-composite`
runs **after** the tonemap on the swapchain with premultiplied alpha: the field
is a map over the picture, not another light source, so the exposure curve
cannot tint the ramp. `M` or the menu cycles off → distance → depth spread →
slope.

**The display range is physical and declared.** A bounded sample of ≤ 256
visible records, taken by an even stride over all five blocks and resolved
through `orbit.engineRecordPosition` (the picker's CPU twin of the vertex
dispatch), feeds the same estimators the island uses: the 2nd/98th percentile of
`log10(d/kpc)` for distance, the 5th/95th percentile of `log10 σ` over each
sample star's six angular neighbours for depth spread, and of `log10 |Δlog d|/Δθ`
for slope. Padding is the island's (4% of the span + 0.02 dex, 0.3 dex floor);
fewer than three visible records falls back to the declared windows
(`height` −2…1, `spread` −1.3…0.2, `slope` −1.5…0.3). The sample re-runs at 4 Hz
while the overlay is on, allocation-free: the scratch arrays are the sample's
size, not the star set's.

**Slope in dex per degree, honestly.** The field lives in screen space, so a
texel's angular size changes across the frame. The composite reconstructs it
per pixel from the pinhole camera (`tan(fovY/2)`, the quadratic ray-angle
correction) instead of dividing by a constant, which would bias every number
away from the centre.

**Shared ramps.** `math/field-ramp.js` now owns viridis, the published Turbo
polynomial, magma, the hypsometric terrain and grey, and the per-mode defaults;
the island painter and the overlay sample the same LUTs, so a colour cannot mean
one distance on the chart and another in the frame. The right-hand panel grew a
`View field` section (mode, ramp, opacity, relief, contours), the label layer a
compact card with the ramp strip and the live range, and five preset fields
(`viewfield`, `viewopacity`, `viewramp`, `viewrelief`, `viewcontours`) carry it
through copy/paste and the URL.

**Tests.** `experiments/field-overlay-test.js` pins the CPU half (21 + 1 checks:
mode ids, size clamp, footprint law, percentile windows, the 1 pc floor, the
estimators, uniform layouts, legend units, the shared LUT identities).
`experiments/renderer-test.js` pins the wiring: seven modules and seven
pipelines, six passes per frame with the overlay on and the same three with it
off, the splat drawing exactly `state.drawn` records, the composite after the
tonemap on the same swapchain view, and the uniform bytes.
`experiments/wgsl-validate.js` checks the three new modules structurally, pins
that `field-splat` reuses the shared star-position header, and that the mode ids
match `math/field-overlay.js`; `experiments/wgsl-exec-check.js` (124/124) parses
every shipped module, the new ones included. `experiments/preset-test.js` covers
the round trip and the prompt line. The full suite is green apart from
`planet-gen`'s known heap-threshold flake under load (passes standalone).

**Not done.** No browser pass: there is no GPU in the sandbox, so the blend,
the sampler and the relief curve are pinned by description rather than by a
screenshot. The island stays as the CPU reference and browser fallback — the
plan's isolation rule still holds (`m1-smoke-test.js`).

---

## view-modes.5 — 2026-10-18 — the overlay reads its own grid, and the island follows the real stars

Two reports came back on the overlay: *projection broken and it is not correspond
to actual camera position or direction*, and *stars not fit to color map*. Both
were true of the code as it stood, and neither had a cause a text review would
have found.

**The composite sampled the wrong grid.** The composite is a fullscreen pass on
the swapchain, so its fragment position is a *canvas* pixel, while the texture it
reads is the field's own (smaller) grid. The shader divided the canvas pixel by
the *field* width (`frag.x / u.viewport.x`), so on a 1920×1080 canvas with a
640×360 field it sampled uv ∈ [0, 3] — three times outside the texture, clamped
to the field's edge column. The map on screen was the field's right edge
stretched over the picture, and no star sat on its own colour: with the old
mapping the colour under every star of the test fixture is `[0, 0, 0]`, a black
map. The field and the canvas share the camera's NDC, so the two grids line up
exactly; the fix is one vec4 — the composite uniform now carries the canvas size
(`canvas: vec4f`) beside the field size, and the uv is `frag.xy / canvas.xy`.

**The relief shaded the map with the relief off.** `exag = u.params.z · 0.2` is
zero at relief 0, but the shading factor `0.45 + 0.55·max(dot(n, light), 0)` is
0.839 on a flat field, so "relief off" was 16% darker than the ramp and the
legend's strip — the flat ramp — never matched the picture. The island's rule is
the one the overlay now follows: at relief 0 there is no shading at all. With the
relief on, the legend's note says the map is shaded.

**The island did not follow the app's stars.** Four causes, in
`src/view-modes.js` and `src/math/view-modes-field.js`:

1. *A procedural galaxy's anchors were frozen.* They were sampled with a private
   seed (`0x7E57A1`) and carried **no records at all** (`packed = 0`), so the
   orbit dispatch had nothing to move: the map stood still while the app's sky
   turned. The sample is now the app's own field —
   `sampling.sampleGalaxyStars(model, model.seed, n)`, the same sampler and the
   same seed the renderer uses — and every sampled star carries the app's
   record: `starTypes.deriveStar` + `orbit.familyForStar` +
   `orbit.epochFlagsFor` + `orbit.flagsWithFamily` + `starTypes.fieldStarJitter`,
   packed with `star-record.packPacked`. The island's procedural sky is now
   literally the app's first N field stars, and the page-check asserts it.
2. *The pattern's phase never turned.* The island advanced its own star clock
   but not `orbit.setPatternClock`, so the arms the anchors orbit stood still
   while the stars slid along them. The clock and the pattern now move together,
   as in `main.js`.
3. *The epoch base was stale.* `orbit.setEpochBase(model)` was never called, so
   after a galaxy change the epoch map measured the new model against the
   *previous* one's arms and moved the anchors off the app's stars. `buildModel`
   now re-bases it, and the epoch map is the identity again.
4. *The engine was hard-coded to `classic`.* The island now carries the app's
   engine row (classic / simple / apocenter) and says in the readout when the
   simple pass is on and the anchors are records: the simple friction field has a
   CPU mirror for the landmarks, but a record's azimuth lives in the renderer's
   compute buffer, so the record anchors ride the classic law under it. The
   island's landmarks do follow the simple pass, through the app's own
   `simpleLandmarksStep`.

Two shared laws moved into `math/` so the app and the island cannot drift:
`orbit.epochFlagsFor` (the epoch bits a field record carries) and
`starTypes.fieldStarJitter` (the phase/amplitude byte). The renderer calls both.

**Tests.** `experiments/field-overlay-wgsl-check.js` (new) executes the shipping
WGSL — the splat, the blur and the composite — through wgsl_reflect's
interpreter: a 320×180 canvas, a 64×36 field, an off-origin eye and a look that
is not along an axis. It pins that the splat projects a star exactly where the
sprite pass draws it (the same matrix, the same star position), that the splat
carries the star's own log10 distance, and that the colour under a star is the
ramp colour of that star's own distance — to the last byte. The negative control
computes what the canvas/field mix-up would have produced and requires it to
differ, so the check cannot pass blind. `experiments/wgsl-validate.js` gained the
source-level gate (the composite's uv divides by the canvas size, and the
renderer tells it how big the canvas is); `experiments/field-overlay-test.js`
pins the uniform's new vec4; `experiments/view-modes-page-check.js` grew the
island's checks: the procedural anchors carry the app's records (no empty ones),
the sample *is* the app's field, the anchors move with the star clock, the epoch
base follows the model, and the engine row selects the app's passes.

**Not done.** Still no browser pass: the sandbox has no GPU, so the blend state,
the sRGB ramp round trip and the relief curve are pinned by the WGSL interpreter
and by description, not by a screenshot.

**Next step.** The browser pass is still the open item, and it now has a
checklist rather than a hope: with the overlay on, the colour under a bright
star must be the ramp colour of that star's own distance (the legend's strip
and the map must agree at relief 0), the map must move when the star clock
runs, and the island's chart must agree with the frame's stars. A second
open item: the display range is a percentile window over a 256-record
sample, so a few per cent of the stars sit outside the ramp — the honest
answer (a wider window, or a second "out of range" colour) is still open.

---

## view-modes.6 — the app hosts the island: real stars, and the WGSL overlay is gone

The user's verdict on view-modes.4/.5: *the overlay is not what we want* — the
Gaussian-moment splat+blur is a different algorithm from the island's Shepard
IDW and does not look like it — while `view-modes.html` is "what we should
implement in index.html", "but with real stars", in a separate panel with radio
buttons for the render type and a slider for the anchor source. So the .4/.5
overlay is removed root and branch (the three WGSL passes, `math/field-overlay.js`
and its tests and logs, the `View field` menu, the label-layer legend card, the
five `view*` preset keys) and the island's field and painter move *into* the app,
anchored on the renderer's own records.

**What ships.** `index.html` gains `#viewmodes` (a full-window 2D canvas above
the WebGPU frame, under the system schematic) and `#viewmenu` — its own
collapsible panel in the second right column: render type radios
(distance / depth spread / slope / `off`, `M` cycles the same four), projection
radios (3D view sphere / 2D chart), anchor source radios (constellations /
nearest / selected) with the 1–500 slider, and the island's look controls (σ,
chart span, field height, compute budget, ramp, relief, opacity, contours /
graticule / stars / names / smooth / invert / chart follows look / chart mirrors
sky, auto range plus the two log sliders). Star time, FoV and the galaxy stay
with their own panels. A new `render/view-modes-layer.js` is the app's host: one
API object, SystemLayer-style, that owns the anchor sets, the display range
(the island's 4 Hz auto-range easing and freeze-on-uncheck rule), and the
per-frame paint — through an offscreen canvas so `opacity` blends the finished
map over the live sky in view projection (registration is exact there by
construction), and directly at 100%.

**Real stars, real updates.** The anchors are the `starBlocks()` records the
sprite pass draws — not a re-derived sample. `nearest` runs the exact max-heap
query over a strided sample of the resident records (bounded 8192, advanced
through `orbit.engineRecordPosition` in 2048-entry slices per frame while star
time runs, re-picked when the eye moves 2 % of the set's own far edge or the
residency version changes); `selected` resolves the selection store's keys
against `blockInfo.identity` (a stale `bufferIdx` hint is verified, then a
linear scan; a key the sky has forgotten drops); `constellations` is the
landmark table with its figures. Every frame the winners' *birth* records are
redrawn at the app's live star time with the app's engine — the same dispatch
the vertex stage mirrors.

**Per-star landmark dispatch.** `view-modes-field.js` gained `landmarkIdx` on
`createIndex`/`queryNearest`/`advancePositions`/`prepareIndexPositions`: a
mixed set dispatches each entry through `engineLandmarkPosition` (its landmark
table row, exact simple-engine mirror) or `engineRecordPosition` as its index
says. That is the fix for the user's "not work with real stars update" — a
named anchor used to be approximated by the record law and drifted from the
sprite the sky shows. The island's own sets keep working unchanged (a whole-set
`landmark` set is the old behaviour), and `view-modes.js` labels a procedural
N-pick as "N nearest" instead of a blanket "sampled sky".

**Presets.** The retired `viewfield`/`viewopacity`/`viewramp`/`viewrelief`/
`viewcontours` become `viewmode` (off/height/spread/gradient), `viewproj`
(view/plane), `viewsource` (nearest/constellations/selected), `viewanchors` (N),
`viewramp`, `viewrelief` (0–30), `viewopacity` (0–1) — the three enum keys
validated in `presets.js` parse like `viewramp` already was, defaults from the
layer's `DEFAULTS`.

**Tests.** `experiments/view-modes-layer-test.js` (new, 31) pins the layer's
CPU half: the index takes the visible resident records with the right landmark
indices and strides a 300 k sky to the bounded cap; the nearest-N pick equals a
brute-force scan of the same records (ties unordered, nearest-first, landmark
indices copied); a selection resolves by identity key and drops dead ones;
`advancePositions` routes every mixed entry through the sprite law exactly;
the view layout carries the camera's basis and FoV; a frame paints, half
opacity blits with `globalAlpha`, `off` hides the canvas, the system schematic
stands in the way; the auto-range freeze and the setter clamps. Removed with
the overlay: `field-overlay-test.js`, `field-overlay-wgsl-check.js` and their
logs. Updated: `m1-smoke-test.js` (the island list is now just `view-modes.js`;
the three new namespaces load and register), `renderer-test.js` (four modules,
four pipelines, three passes — no field pins left), `wgsl-validate.js` (five
wired shaders, no section 2b), `preset-test.js`, `export-parity-test.js`,
`view-modes-page-check.js`, `scripts/run.py` (`sim` is `wgsl-exec` alone).
`python3 scripts/run.py quick` — 24/25, the one failure the pre-existing
`planet-gen` heap flake (passes standalone).

**Not done.** Still no browser pass of the app's map (the sandbox has no
display): the panel wiring and the canvas paint are pinned by the harnesses and
by the shared painter the island page check executes, not by a screenshot. The
nearest-N pick still measures a strided sample, so "nearest" means "nearest of
the resident sample" — exact within it, bounded across 300 k records.

**Next step.** Open `index.html` and check the map under live star time: the
named stars must hold their colour (the landmark dispatch), the selected set
must re-pick on a new selection, and 50 % opacity in 3D view must sit exactly on
the drawn stars. If the frame budget hurts at `full`, the field resolution
(`autoResolution`) is the first knob to revisit.

## 2026-10-18 — view-modes.7: the layer rewritten from zero over real stars

The user's verdict on the .6 integration: *completely remove the viewmodes
integration from index.html (keep the GUI), reimplement from zero*. The app
symptoms were (a) the initial view shows no stars at all, (b) changing "N
nearest" changes the nearest star even at the default "near" zoom, (c) the
plane chart shows the wrong field. The old suite was green through all of it —
it drove the layer with fake block kinds and asserted only API shapes.

### What was wrong with .6's architecture

`starBlocks()` hands out the *sprite* buffers: 35089 slots of which only
~34089 are live (local 30k + catalog 3829 visible of 5000), the catalog block
is already thinned to visible records, and `uploadDynamic` rewrites local +
catalog wholesale. .6 copied that into an SoA every frame and kept a
*second*, perpetual, strided-sampled nearest index over **birth** positions
with `queryNearest`'s mid-traversal range shifts. Every one of those was a
wrong turn:

- the index rebuilt every frame (`indexTime` pinned at 0 — `info.total` was
  the buffer capacity, never equal to `indexTotal`);
- the index covered only the catalog block; a field star could never be
  "nearest";
- `INDEX_CAP`'s stride sampled ~1-in-6 records — the star *next* to the eye
  was usually not in the index at all;
- partial sweeps left the index at mixed times (flashing patches);
- the measured field used `slot.cur` but picks stored birth, so the chart's
  anchor dots painted sky directions the field had left tens of Myr earlier —
  the flat-map failure the star-time pitfall warns about.

### The new design (island's `pickAnchors`, ported exactly)

The layer keeps **one compact list of the live-visible sky** — built from the
slots in `view` order (field+landmark first, the query set) plus the whole
local block and the whole catalog block — with each entry's current engine
position advanced in slices under one fixed `starTimeMyr` per sweep. The
"nearest N" set is then *the product* of an exact O(n) scan over that list:

- `fillNearest`: the same max-heap the island's `pickAnchors` runs over
  `sampleIndex` — `want = min(anchors, sky.n, MAX_STARS=1024)`, tie-broken by
  index, winners snap-shotted (birth + packed) through the same
  `engineRecordPosition`/`engineLandmarkPosition` dispatch the sprite pass
  uses at their `landmarkIdx` for names;
- `fillSelected`: the island's selected-resident rule — resolve by identity
  (slotOfKey hint + linear fallback), drop unresident identities, fall back
  to the nearest scan when none survive;
- constellations: the island's cached `buildConstellationSet` over the whole
  live sky, refreshed on `dynamicVersion`, with `drawn = advancePositions`
  before `buildConstellationSegments` so the figures track star time exactly
  (the documented fix, applied from the start);
- `needPick`: the island's whole rule, including `stateSet !== pickSet →
  false` while a constellation set is mounted and `sky.sweeping → false`;
- `field`: `sky.view` is the birth list `prepareStars` wants, `sky.cur` is
  the drawn positions `Field.texelOf` wants — same split the island keeps
  (`sampleIndex` vs `cur`);
- budget→resolution→layout→compute→range→apply in the island's frame order:
  autoResolution from the *pair* budget (balanced 1.5e6 → 424×240 at 60
  anchors), letterboxed plane layout from the chart span, measure ticks at
  0.25 s, `refreshAutoRange` at 4 Hz with the island's `liveMode:''` snap
  rule (anything else washes the map out for seconds at boot), `applyRange`
  with opacity folded into the ramp.

Old GUI contract kept whole: the `viewmode/viewproj/viewsource/viewanchors/
viewramp/viewrelief/viewopacity` preset keys, the `live`/`statusLine` 4 Hz
portrait, `sweeping`, `selected`, `setPatternClock`. The old `mode()`,
`setStarTime()`, `rebuildIndex()` and the `loop` pump are gone — the app's
frame already steps time (`setPatternClock`, `simpleLandmarksStep`); the
layer must not.

### Harnesses

- `experiments/view-modes-layer-test.js` rewritten from zero: 34 checks over
  the real catalog + two synthetic blocks — exact-nearest == brute force
  across every kind, the birth-record dispatch-once contract (the pitfall's
  query rule), star-time re-pick == brute force on the *drawn* sky (the
  flat-map fix), selected-resident + dead-identity handling, M-cycles with
  their ranges, the 2:1 letterboxed plane with the look at the chart centre,
  auto-range freeze, in-bounds status. 34/34.
- `/home/user/scratch/vm-debug.js`: real catalog + synthetic near/pole/epoch
  blocks, PNG captures; scenario D sweeps 25 Myr and the re-picked set
  matches brute force at the *new* time exactly (1.46–5.05 kpc both).
- `/home/user/scratch/vm-parity.js`: paints the page-check's island scene
  (720×405, home pose, constellations, height, budget high, relief 6)
  through the new layer vs `view-modes-page-*.png`. View shot: contrast-
  normalized correlation **0.93**. Chart shot: **0.83** after replicating the
  page-check's drag history (a chart drag turns "chart follows look" off, so
  the reference PNG is panned — unpinned my chart scored 0.67). The raw
  pixel-diff numbers (~45–60 % "big") are not the verdict: the reference PNGs
  were captured mid-range-lag, their live [lo,hi] measured on a coarser
  field, so their extremes clip to flat plateaus at p1/p10 (106 vs 197/240
  on the scale histogram) — judge by structure and normalized correlation.

### Failures along the way worth keeping

- The rewrite reproduced the app's exact "map washed out at boot" bug: with
  `live.mode` starting at `'height'` the refresh rule saw only a 1.5-decade
  manual→auto jump and eased 0.15 per tick from MANUAL_DEFAULTS. The island
  seeds `liveMode:''` so the first measurement snaps. Lesson: the
  >1.5-decade guard is a *mode-change* guard; the first read must snap.
- `statusLine`'s source label must special-case the constellation set
  (`source: 'constellations'`, not `SOURCE_LABELS[set.source]` — the island's
  own readout does).
- Truth checks must measure `advancePositions` output: `pickSet.positions`
  holds BIRTH records by contract.

Deliverables: `src/render/view-modes-layer.js` (rewritten), test suite,
parity + debug harnesses in `/home/user/scratch/`, this entry. The app's
index.html/main.js/presets wiring is unchanged from .5.

---

## view-modes.8 — 2026-10-18 — quiet defaults, and an auto range that waits for the sky to settle

Two user asks once the distance field worked: better boot defaults for the
mode's GUI, and a fix for the auto range washing the picture out to one colour
for a few seconds after a pan.

### Defaults (the app's View modes panel; the island keeps its own)

- render type **off** at boot — the map is opt-in (`M` now cycles
  off → distance → depth spread → slope → off);
- **contours off**;
- **Nearest stars 256** (was 88).

`ViewModesLayer.DEFAULTS` stays the one source: the layer's settings,
`readParams`, `presets.menuDefaults` and the `index.html` markup all read or
mirror it. The island is a dedicated map page, so it still boots into the
distance field.

### The washout, and the law that replaces the snap

The old following rule (duplicated in the island and the layer) eased 0.15
per 4 Hz read but **snapped** whenever a suggestion landed more than 1.5
decades from the live bounds. After a pan the first reads are exactly the
untrustworthy ones — residency still streaming in the app, a freshly
re-picked anchor set, a moving chart window — so the snap rewrote the live
range with an unsettled read, the settled field fell wholly outside it, and
the slow ease needed seconds to crawl back: one flat colour.

The law now lives once, in `math/view-modes-field.js`
(`createRangeState` / `offerRange` / `easeRange` / `resetRange`), and both
hosts call it:

- the first offer for a mode snaps (no older range exists in that unit —
  the .7 boot lesson, kept as the mode-change case only);
- a later offer becomes the target only after **3 consecutive offers agree
  within 0.08 dex**; disagreeing reads reset the candidate and the map keeps
  painting with the old, settled bounds;
- the display range **eases toward the trusted target every frame**
  (τ = 0.5 s) and never snaps again; degenerate offers are ignored, and the
  layer gained the island's `stats.empty` guard it was missing.

### Validation

- `view-modes-field-test.js` 78/78 — 8 new checks pin the law directly:
  alternating mutually-exclusive offers never move the display, two agreeing
  offers are not yet trusted, the third becomes the target and the display
  eases (one frame moves < 0.2 dex toward a 3-decade target), monotone
  convergence, the manual `resetRange` park, the mode-switch snap.
- `view-modes-layer-test.js` 35/35 (new boot-defaults check),
  `view-modes-page-check.js` 58/58 — its eye-move check is re-pinned to the
  new law: bounds unchanged 0.33 s after the move (one disagreeing offer),
  adopted after ~2.5 s of agreeing reads.
- `preset-test.js` 30/30; `scripts/run.py changed` 8/8.

### Lesson

A snap keyed on *distance from the current value* cannot tell a new
neighbourhood from an unsettled measurement — both are far away. Agreement
over time can. Any auto-exposure style follower over streamed data should
trust repetition, not magnitude.

Next step: if the hold + ease ever feels laggy during fast flight, trust
*expansion* earlier than shrink — widening a range can only compress
contrast, never flatten the field to one colour.

### Follow-up — 2026-10-18 — remove the stacked autorange delay

The first follow-up was still wrong in practice: it combined a rolling
three-sample median, a small per-sample target slew, and a slow display ease.
Those safeguards stacked, so after a real pan the old range could continue to
clip the new field for seconds. Replace them with one confirmation step:
keep the current display range for one changed read, confirm against the next
nearby suggestion (0.35 dex endpoint tolerance), then ease directly toward the
latest measured range with τ = 0.35 s. An isolated outlier cannot move the
range, while a stable new neighbourhood begins adapting after two reads rather
than waiting on a median window and a slew cap. The mode's first range still
initializes immediately because there is no prior scale in that mode's units.

Validation: field math 78/78, app layer 36/36, island page 58/58. The pan
regression now checks that the bounds start moving smoothly and catch up,
while the field test explicitly verifies one-read rejection, two-read
confirmation, and monotone convergence.

## view-modes.9 — 2026-10-18 — the range follows the newest read at a bounded rate

Reported: after a pan the picture washes to a single colour for a few seconds
until a new range is calculated, and a close star crossing the screen — worse
right to left, worse when fast — fills the frame with one colour and then takes
seconds to relax. The ask was explicit: keep the *old* range and adopt the new
one slowly, instead of rewriting it with an unstable measurement. The .8 law
did the first half of that and caused the second: it froze the target until
consecutive reads agreed, which a pan never does.

Two causes, one in the follower and one in the field itself.

**The follower.** The confirmation gate (`RANGE_CONFIRM_TOL`, the
`pendingLo`/`pendingHi` candidate) is removed, not tightened: while reads
disagree it *stops following*, which is the washout. What replaces it is one
pole with a distance-dependent time constant, `offerRange` taking the newest
measurement as the target at once and `easeRange` closing the gap at no more
than `RANGE_MAX_RATE` dex/s:

```
k = 1 - exp(-dt / (RANGE_TAU_S + |gap| / RANGE_MAX_RATE))   // 0.2 s, 2.5 dex/s
```

A correction the window almost fits arrives in τ; anything bigger travels at
the ceiling, so the same constant that kills the flicker also bounds a wild
read (one bad read of 2 dex moves the colours 0.5 dex and unwinds, and the
display is monotone between). A 3-dex step is fully adopted in ~2.2 s. The
first offer for a mode still snaps — the .7 boot lesson, kept as the
mode-change case only — and `RANGE_CONFIRM_TOL` is gone along with the pending
fields, so the state is `{mode, lo, hi, targetLo, targetHi}` and a test says so.
The .8 "next step" (trust *expansion* earlier than shrink) is deliberately not
taken: with the newest read always the target, both directions are followed at
the same bounded rate, and the asymmetry would reintroduce exactly the
one-way lock-in that made a flick leave the span permanently wide.

**The measurement.** `autoRange` used to take mode 1's raw min/max — the one
statistic a single anchor can move alone, and the reason a close star could
triple the window on sight. All three modes now offer the same thing: p5/p95 of
the log histogram `computeRaw` already builds for modes 2–3 (one branch, one
pass, no second `makeScale` scratch — the display range does not use the anchor
scale, so `makeScale` stays only for the distance↔height read-out). The 0.3-
decade floor, which a calm field already sits on, means the percentile costs no
contrast where there is nothing to reject. This is the plan's own wording
(`archive/view-modes-shader-plan.md`: percentiles of the sampled log
distances); min/max was the drift. `makeScale` / `heightOfDistance` /
`distanceAtHeight` — the anchor scale `computeRaw` used to quote for mode 1 —
leave with it: the legend labels its ends from the live range (`10^lo`,
`10^hi`) and no other caller existed, so section 4 of the field test now pins
the same view-modes.1 lesson (the range is a window on the field, never a
renormalization of it) on `applyRange` itself.

**And the field could see through the camera.** While measuring this it came
out that the IDW weight was `1/(sin²δ + sin²σ)`, and `sin²δ` is symmetric about
δ = 0 *and* 180°: every star painted a full-strength copy of itself at its
antipode, the map was exactly 180°-rotation-symmetric, and a close star *behind*
the eye owned the screen in front of it — which is the reported symptom almost
verbatim, and no range law could have fixed it. `q = 2 - 2c` (= 4 sin²(δ/2),
identical hill width to first order) makes the falloff monotone; the far
hemisphere is now a background instead of a second copy of the near one. A star
at 8 pc astern moves the window 0.02 dex where it used to move it 0.44.

### Validation

- `view-modes-field-test.js` 81/81 (was 78). The range block is rewritten on the
  new law: newest read becomes the target at once; a lone outlier is bounded per
  frame and unwinds by itself; monotone, rate-capped catch-up; a 3-decade pan
  never leaves the display more than a decade off; `resetRange` parks display and
  target; the state's key list is pinned. Two new checks measure the symptom on a
  real field (a close star astern must not move map or range; one in view must
  saturate rather than squeeze), and the "chart has no unpainted floor" check is
  restated — a percentile window clamps a tail on purpose, so what is pinned is
  that the tail stays under 10% of texels and the raw field keeps its span.
  Both new checks fail on the old kernel *and* on the min/max estimator, and the
  pan check fails on the gate.
- `view-modes-layer-test.js` 36/36, `view-modes-page-check.js` 58/58. Its PNG
  shots pumped 2 frames after each settings change — long enough for a *snapped*
  range, not for an eased one — so they photographed the transient: with any
  follower in place the shot is a flat, wrongly-clipped plate and looks like the
  bug. They settle for ~2.5 s now, and only with `--png` (the checked path is
  unchanged, so the FAST tier still runs in under 3 s). The pictures: the chart
  gained colour (7 084 → 10 416 distinct, dominant colour 0.6% → 3.8%) and the
  view kept its terrain, while the chart's mirror image is simply gone.
  The page's eye-move check now reads as it should: 20 frames in, the display has begun
  moving (< 0.5 dex travelled, bounded rate doing its job); 2.5 s in it has
  caught up *and* sits on the target — the gap between those two is the
  protection. `changed` 8/8; `quick` 24/25 with the pre-existing planet-gen heap
  flake (it fails and passes alternately on a pristine HEAD too).

### Lesson

A follower that must survive both a flicker and a storm does not need a vote
between measurements; it needs the newest one and a speed limit on the display.
And any spatial kernel whose weights are read as "how near in direction" must be
monotone over the whole sphere — an even function of the angle quietly doubles
the sky and hands the frame to a star nobody can see.
