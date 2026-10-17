# View-modes series worklog

The heightmap island: `src/view-modes.html`, its three modules, and the tests that
keep it honest. Deliberately outside the main app — `index.html` does not load it,
the main renderers never import it, and `experiments/m1-smoke-test.js` is the check
that keeps it that way. Governing plan:
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
