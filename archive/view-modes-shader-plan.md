# View Modes Shader: Heightmap Visualizations for Navigation

## Context

`archive/view-modes-shader-draft.md` asks for a separate render page that visualizes
star fields as smooth heightmaps for game purposes: where height = travel cost,
gradient = slow travel, usable for pathfinding or ship movement. Two modes:

1. Distance from camera to star as heightmap (0..1 far→close)
2. Distance between adjacent stars as heightmap (visual neighbours with large Z gaps = high)

Must update realtime while stars move (star time slider), apply to constellations
or nearest N stars (slider 0=constellations, max 500), and stay isolated from main
code so it does not confuse main development agents.

This plan turns the draft into a shippable experiment.

---

## View Modes Shader.0 — Separate render page + data plumbing

### Goal
A standalone `src/view-modes.html` + `src/view-modes.js` that reuses math but not
rendering, similar to how `experiments/` reuses `GalaxyLib` and `OrbitLib`.

### Files
- `src/view-modes.html` — minimal canvas + UI, no WebGPU, 2D canvas or WebGL2.
- `src/view-modes.js` — boot, data source, view mode dispatcher.
- `src/render/view-modes-renderer.js` — heightmap renderer (new, isolated).
- `src/math/view-modes-field.js` — distance field computation (new, pure CPU).

All new files live under `src/` but import only `math/` and `data/` namespaces,
never `core/` or `render/star-sprites.js`. This satisfies “somewhat separate”.

### Data sources

**Mode A: constellations (default, slider 0)**
- Source: `src/data/constellations.js` lines + `landmarks.js` positions.
- Each constellation star is a point with 3D position from landmarks or from
  generated field? For procedural galaxies landmarks don't exist, so fallback to
  nearest field stars to constellation pattern? Simpler: when `model.milkyWay`,
  use landmarks; otherwise use 88 random bright stars as pseudo-constellation
  anchors. The Sun at origin and Home at `model.home.orbitTarget` are extra
  anchors (like main project's H).

**Mode B: nearest N stars (slider 1..500)**
- Source: `StarRenderer` field sampling or direct `sampling.js` sample of N stars
  around camera, or around selected primary.
- For the standalone page, we don't have a full renderer. Instead:
  - Reuse `GalaxyLib.createGalaxy` + `OrbitLib` to sample N stars via
    `sampling.sampleGalaxyStars` or via `Selection`'s nearest scan.
  - Keep a `Float64Array` of N*3 positions (kpc) updated every frame with
    `orbit.engineRecordPosition` dispatch (same as main).
- Slider: `<input type="range" min=0 max=500 step=1>` where 0 = constellations,
  1..500 = nearest N. Label shows “constellations” or “N stars”.

**Camera**
- For view-modes page, camera is simplified: orbit around galactic centre or
  around origin, with mouse drag. Reuse `Camera` but only its position, not its
  full fly logic. Or implement a tiny orbit camera in view-modes.js to avoid
  coupling.
- Distance from camera to star is Euclidean in kpc, then normalized 0..1 for
  display.

### UI (radio buttons + sliders)

```
View mode:  [o] distance from camera   [ ] adjacency Z variance   [ ] off
Source:     [ constellations | 0 ... 500 stars ]  slider
Star time:  [ -1 ... 99 Myr/s ]  same as main
Pattern:    [ 0 ... 3 ]  optional
Exposure:   not needed
```

Radio group `name="view-mode"` with 3 options: `camera-dist`, `adjacency`, `none`.
Default `camera-dist`.

---

## View Modes Shader.1 — Mode 1: Camera distance heightmap

### Problem
Given scattered points (stars) with scalar value `d_i = |star_i - camera|`,
produce a smooth heightmap over a sphere (or over a 2D projection) that looks
like a terrain: 0 = far, 1 = close (or inverse). Must be smooth, not Voronoi
facets.

### Draft suggests diffusion
Diffusion (solve Laplace with Dirichlet at stars, or iterative blur of Voronoi)
gives smooth result but is O(W*H*iterations) and needs a grid. At 512x512 and
100 iterations it's okay but not realtime for moving stars.

### Faster alternatives (evaluate in order)

**Option 1: Inverse Distance Weighting (IDW) + Gaussian falloff — simplest**
- For each pixel (or sphere texel), compute `value = Σ w_i * d_i / Σ w_i`
  where `w_i = 1 / (|p - p_i|^k + ε)` or `exp(-|p-p_i|² / σ²)`.
- Smooth, O(Pixels * N). With N=500 and 256x256 = 65k pixels, that's 32M
  distance checks per frame — too heavy for CPU, but okay in a fragment shader
  (WebGL2) with N as uniform array.
- Pros: trivial, realtime in shader, no precomputation.
- Cons: “bullseye” artifacts at stars, not true heightmap (no diffusion), but
  looks smooth if k=2 and σ tuned.

**Option 2: Delaunay triangulation + barycentric interpolation — better**
- Triangulate star projections onto sphere (or onto view plane) via
  `delaunator` (small lib, MIT, can vendor).
- For each triangle, interpolate `d_i` barycentrically, then smooth with
  one pass of Laplacian smoothing (average with neighbours).
- O(N log N) for triangulation, O(Pixels) for rasterization. Triangulation
  per frame at N=500 is ~1-2 ms in JS, acceptable.
- Pros: No bullseye, C0 continuous, can be made C1 with Clough-Tocher.
- Cons: Needs triangulation lib, still needs rasterization.

**Option 3: Screen-space splatting + blur (fastest, game-ready)**
- Render each star as a Gaussian splat into a low-res field texture (e.g.,
  128x128), with value = distance, alpha = weight.
- Then blur with separable Gaussian (two passes) or with diffusion via
  ping-pong FBO (Jacobi iterations for Poisson).
- This IS diffusion but on GPU, not CPU: 128x128 * 20 iterations is trivial.
- Pros: GPU accelerated, smooth, looks like heightmap, realtime even while
  stars move.
- Cons: Needs WebGL2, but we already have WebGPU in main; standalone can use
  2D canvas with manual blur (still okay at 128x128).

**Recommendation**
- For 0.7.1, ship **Option 3 (splat + blur)** in WebGL2, fallback to **Option 1
  IDW in fragment shader** if WebGL2 unavailable.
- Keep CPU diffusion as reference in `view-modes-field.js` for tests, but not
  in render path.

**Status (2026-10-17, amended at view-modes.3)** — shipped the CPU side instead
(IDW in `view-modes-field.js`, in the render path, at a budgeted texel count), and
the recommendation above stays open, with three corrections the shipping code
settled:

- A GPU pass for this island is **WGSL in `src/render/shaders.js` with a
  WebGPU renderer**, not inline WebGL2 GLSL in the page. The island's whole
  test story (`wgsl-validate`, `wgsl-exec`) only reaches shaders that are
  `require()`-able, and a shader the CPU interpreter can run is the one shader
  whose numbers can be pinned against `view-modes-field.js` without a browser.
- The CPU field is the **mirror and the fallback**, never just a reference:
  with no WebGPU device the page must still paint, and the parity check needs
  both sides alive in one process.
- The measured cost is what decides it. The CPU inner loop is at ~0.3 Mpair/ms
  and has no headroom left (interleaving the star SoA measured *slower*), so
  the budget buys texels: `balanced` at N=500 paints 72×40, and 1920×1080×500
  costs 3455 ms. A GPU fragment pass is therefore a resolution win, not an
  algorithmic one — worth building when a browser pass confirms the texel
  budget is the visible problem, and not before.

Two display features this plan did not name shipped at view-modes.3 and belong
to the painter, not the field: a selectable ramp (viridis / the published turbo
polynomial / magma / terrain / grey, `auto` = the per-mode default) and shaded
relief — the field's own central-difference slope (`fieldSlope`, shared with
mode 3) lit from the north-west at 45°, exaggerated per degree of sky and
clamped to darken-only so a colour always means the value the legend quotes.

### Normalization
- Compute `d_min`, `d_max` over current N stars each frame.
- Map `t = (d - d_min)/(d_max - d_min)` → 0..1, then `height = 1 - t`
  (close = high, far = low) or inverse per UI toggle.
- Color: use viridis or turbo ramp, or grayscale + contour lines for game.

### Sphere vs plane
- Draft says “fill all sphere with color”. Two interpretations:
  - **Spherical heightmap**: Render onto a sphere surrounding camera, like an
    environment map, then display as equirectangular or as 3D globe.
  - **Plane heightmap**: Project stars onto view plane (camera forward) and fill
    that plane.
- For game purpose (pathfinding 2D map), plane is more useful. For visualization,
  sphere is cooler.
- Plan: Implement both as toggle: `projection: sphere | plane`. Default plane for
  pathfinding, sphere for visualization.

---

## View Modes Shader.2 — Mode 2: Adjacency Z variance heightmap

### Problem
Stars that are close in screen space (small angular separation) but far in depth
(Z) should be high cost (slow travel). We want a map where height = “how much
hidden depth” in that direction.

### Definition
For each star, consider its k nearest neighbours in angular space (or in 3D
projected to screen). Compute `dz = |z_i - z_j|` or `|pos_i - pos_j|` in 3D vs
2D distance ratio.

Formal:
- Let `p_i` be 3D position, `q_i` be 2D screen projection (or spherical coords).
- For each pixel, find nearby stars (IDW or splat). Compute local variance of Z:
  `var_z = E[z²] - E[z]²` weighted by proximity.
- Or compute `cost = max_j |z_i - z_j| / |q_i - q_j|` for neighbours j — large
  when two stars overlap visually but are far in depth.

This is exactly what a pathfinding heightmap needs: a ridge where a 2D shortcut
is actually a long 3D detour.

### Algorithm (splat + variance, GPU)

1. Splat stars into two low-res textures: `sum_w`, `sum_wz`, `sum_wz2` (or
   `sum_w * z`, `sum_w * z²`).
2. Blur all three with same Gaussian kernel (so they stay aligned).
3. Per pixel: `mean_z = sum_wz / sum_w`, `mean_z2 = sum_wz2 / sum_w`,
   `var_z = mean_z2 - mean_z²`.
4. Height = normalized `var_z` (or `sqrt(var_z)` for stddev).

This is O(Pixels) after splat, independent of N, and gives smooth field.

### Alternative: Graph-based
- Build k-NN graph (k=6) in screen space, compute edge cost = 3D distance /
  2D distance.
- For each edge, splat its cost along the line between stars (Bresenham with
  Gaussian).
- Then blur. This emphasizes “walls” between visually close but deep stars.

### Output for game
- Export as `Float32Array` heightmap (e.g., 128x128) via `canvas.toDataURL` or
  as JSON, so pathfinding (A*) can read it: `cost = base + height * factor`.
- Provide helper `getHeightAt(uv)` for ship movement: ship slows when gradient
  high.

---

## View Modes Shader.3 — Realtime update while stars move

### Star time integration
- Reuse `OrbitLib` dispatch: each frame, for each of N stars, call
  `engineRecordPosition` with current `starTimeMyr`.
- `starTimeMyr` advances via `dt * rate` same as main loop, with wrap.
- After positions updated, recompute heightmap (splat + blur).
- At N=500 and 60 fps, CPU position update is ~0.5 ms (classic) to ~2 ms
  (apocenter), plus GPU blur ~1 ms — realtime.

### Throttling
- If N=500 and `apocenter` engine, allow 30 fps fallback: skip field rebuild
  every other frame, or use `requestAnimationFrame` with time budget.
- Slider for N should show perf hint: “500 may drop fps with apocenter”.

### UI for star time
- Same ladder as main: -1 follow, 0 frozen, 1..99 Myr/s.
- When frozen, heightmap is static and can be inspected.

---

## View Modes Shader.4 — Isolation from main code

### Module boundaries
- `view-modes-field.js` exports pure functions:
  `computeCameraDistField(positions, cameraPos, out)`,
  `computeAdjacencyVarianceField(positions, cameraMatrix, out)`,
  `normalizeField(field)`.
  No DOM, no WebGL, testable in Node.

- `view-modes-renderer.js` owns WebGL2 context, textures, shaders, blur passes.
  It imports field.js but not `core/` or `render/star-sprites.js`.

- `view-modes.js` is the glue: creates galaxy, samples stars, handles UI,
  drives loop, calls field + renderer.

- `view-modes.html` loads scripts in order:
  `hash.js`, `density.js`, `galaxy.js`, `sampling.js`, `star-record.js`,
  `star-types.js`, `orbit.js`, `coords.js`, `constellations.js`,
  `view-modes-field.js`, `view-modes-renderer.js`, `view-modes.js`.

This mirrors main's order but with only math + data.

### Tests
- `experiments/view-modes-field-test.js`: IDW vs brute force at known points,
  variance field non-negative, normalization 0..1, no NaN when stars coincide.
- `experiments/view-modes-renderer-test.js`: smoke — field texture created,
  blur does not change mean drastically, no WebGL errors (skip if no GL).
- Both tests run in `python3 scripts/run.py all-tests` but are allowed to skip
  GL parts in Node.

### No main code changes
- Main `src/index.html` and `src/main.js` keep working unchanged; view-modes is
  a separate entry point. A link from main's help panel to `view-modes.html` is
  optional.

---

## Implementation order

1. **View Modes Shader.0a** — `view-modes-field.js` pure CPU: IDW and variance computation,
   normalization, tests.
2. **View Modes Shader.0b** — `view-modes.html` + `view-modes.js` boot: galaxy creation,
   constellation vs N-nearest data source, star time slider, camera orbit.
3. **View Modes Shader.1** — `view-modes-renderer.js` WebGL2 splat + blur for camera distance:
   fragment shader that splats points, two-pass Gaussian blur, color ramp,
   sphere/plane toggle.
4. **View Modes Shader.2** — Adjacency variance mode: second splat path with wz/wz2, variance
   compute, export as Float32Array for pathfinding.
5. **View Modes Shader.3** — Realtime: hook star time, update positions per frame, perf at
   N=500, throttling, UI polish.

Each step is shippable: .0 shows points, .1 shows smooth distance map,
.2 shows cost map, .3 moves.

---

## Open questions


- **Color**: Height as grayscale + contour, or turbo? Turbo reads better for
  distance, grayscale for cost.
  *Answered at landing*: turbo for all three modes, with one contour pass at 10 levels
  on top (the lines are what make a smooth field readable as a heightmap rather than a
  wash). The ramp is a fixed function of the value, and the value is a fixed function of
  the distance, so the legend can quote kpc — see the normalization note below.

---

## Out of scope
- Pathfinding
- Full game mode integration (ship slowing by heightmap).
- Volumetric nebula heightmaps.
- Export

---

## As shipped (view-modes.0 … .2, 2026-10-17)

What differs from the plan above, and why. The entry to read is
[`archive/view-modes-worklog.md`](view-modes-worklog.md).

- **`.1`'s splat + two-pass Gaussian blur is not used.** One IDW pass over the anchors
  per texel replaces both: `w = 1/(sin²δ + sin²σ)` with δ the *angle* to the star, so
  every star gets a gradient radiating from it, two stars on one ray blend to their mean
  by construction, and the result is smooth because the canvas upscales a small
  Float32 field with bilinear filtering. No diffusion iteration, no FBO ping-pong, no
  WebGL2 — the whole painter is one `putImageData` plus a vector overlay, and 500
  anchors at the balanced budget rebuild in ~10 ms.
- **The field is physical; a separate display range colours it.** `computeRaw` writes
  the mode's own scalar — mode 1 `log10(d/kpc)`, mode 2 σ of `|star−eye|` in kpc, mode 3
  `|∇log10 d|` in dex of distance per degree of sky — and `applyRange` maps it through a
  declared range. No pass ever renormalizes after smoothing: the first cut painted
  `[vMin, vMax]` each frame, which made the legend meaningless and inverted the map when
  a bright star entered the view.
- **The range is auto by default and manual on request.** Auto reads the log
  distances the mode-1 field actually takes (its raw min/max, plus a 4% pad and a
  0.3-decade floor) and the 5th–95th percentile of a 64-bin log histogram for modes
  2–3, at 4 Hz with an ease toward the new bounds (a jump over 1.5 decades snaps — a
  new neighbourhood, not a drift). `makeScale` still maps `dMin…dMax` for callers that
  want the anchor range; the page does not, because the nearest anchor is rarely on
  the nearest texel. Manual holds one lo/hi per mode in
  the mode's log10 unit; unticking auto freezes the live range so the colours do not
  jump, and the two sliders edit it. The legend and the readout quote the same numbers
  in kpc / dex per degree, which is what makes a colour checkable.
- **Mode 3 has no hard top.** The earlier gradient was a difference of the *display*
  grid scaled by "one full height range per 14°" and clamped at 1, so every ring near a
  star saturated — the reported clump. It is now the derivative of mode 1 in a real unit
  (dex/°), divided by `cos(lat)` on a chart (the rows shrink toward the poles), with the
  clamping left to the display range where it means "off this scale" rather than "as
  steep as the scale goes".
- **σ is a visible parameter, not a constant.** It sets how much of a star's own height
  survives its neighbours' averaging; 10° left the whole sky inside 0.35..0.75 (the flat
  look the draft was written to avoid), so the default is `Field.SIGMA_DEG = 3` and the
  peak-and-ramp-usage numbers are asserted in `experiments/view-modes-field-test.js`.
- **`.2`'s variance is an IDW-weighted σ of the raw distance in kpc**, not a second
  splat and not a squeezed `σ/(σ+ref)` cost: the depth itself is the datum, and the log
  display range is what makes a cliff visible. `.3`'s gradient is the finite difference
  of mode 1's grid divided by the texel's angular size — the plan's "mode 2 may be the
  gradient of mode 1" is true in shape, but the depth gap is the more direct read, so
  both exist.
- **The projection is the app's, inverted.** The view layout is the gnomonic window of
  `core/camera.js` (`FOV_Y` 60°, the camera's own forward/right/up basis, the *window*
  aspect so the field covers exactly what the app draws); the plane layout is the
  equirect chart with quaternion drag-panning and a wrapped seam, from the
  planet-geotectonics approach. `experiments/view-modes-field-test.js` puts 64 landmark
  sightings on the app's own `projectToScreen` pixel to within 0.05 texel; nothing in
  this section is allowed to be derived twice.
- **Nearest-N is a query, not a snapshot.** `.0` decoded the bundle, computed every
  distance, sorted and copied once per eye move of 10 pc, so a chart pan or star time
  never re-picked. `createCatalogIndex` decodes the bundle once (7.5 ms, 3 829 records)
  and `queryNearest` is a linear scan plus a fixed max-heap of N entries (~0.3 ms for
  500) that measures the *drawn* sky and writes the winners' birth records for the
  orbit dispatch, so "nearest" can mean nearest now. A procedural galaxy samples its own
  12 000-star index and answers the same query. The page re-queries on a 2% eye move
  (or 50 pc, whichever is larger) and at 4 Hz under star time.
- **The chart pan is the press-composed rotation.** `chartDirAt` gives a chart pixel's
  ray in the chart's frame and `quatDrag` composes `arc(press → now) · q_press`, so the
  pressed sky point stays under the pointer for any starting rotation (the world-ray
  form pins only while the chart is unrotated — the shipped glitch) and returning to the
  press pixel restores the chart exactly. Longitude panning needs no Euler clamp;
  latitude is a real edge of the chart and saturates at the pole.
- **Isolation held.** Three files, loaded only by `src/view-modes.html`; math and data
  plus `data/tiles/catalog.js` (as a static data script, so `stream/tile-loader.js` is
  not needed), never `core/`, `render/star-sprites.js` or the device.
  `experiments/m1-smoke-test.js` asserts the three files are absent from `index.html`
  and present in the island page, so the isolation cannot rot silently. Two camera
  constants (`LOOK_SENSITIVITY`, `FOV_Y`) are copied into `src/view-modes.js` rather than
  imported — the rule's cost, marked at the copy.
- **Still open**: the `.2` export for pathfinding (a `Float32Array` cost grid handed to a
  route solver — `heightAt` already reads the last grid), a GPU path if a chart wants
  > ~1 M texel-anchor pairs, and the browser pass (no browser in the sandbox;
  `experiments/view-modes-page-check.js --png` is what stands in for eyes, and it cannot
  show the marker dots or labels because it rasterizes `drawImage` only).

---

## View Modes Shader.5 — the main-render overlay (view-modes.4, 2026-10-17)

The island proves the maths on ≤ 500 anchors in a browser-side CPU loop. The
overlay is the same field inside the real frame, on the real star set, drawn by
WebGPU. It is not a second renderer: it is three passes added to
`render/star-sprites.js`, and its input is the renderer's own star buffer — the
procedural field, the landmarks, the composite objects, the local gap-fill and
the streamed catalog, in hybrid and game mode alike. No CPU sweep picks a
nearest-N set, so there is no count at which the overlay stops describing the
sky it is drawn over.

### Passes and order

1. `field-splat` — one instanced quad per star record, the same range the sprite
   pass draws. The vertex stage reconstructs the *drawn* position with the
   shared `starMovedPosition` helper (epoch map + classic/simple/apocenter
   dispatch), projects it, and writes `l = log10(max(d, 1 pc))` at the vertex.
   The fragment returns the moments `(w, w·l, w·l², w)` with `w = (1−r²)²`,
   additively into an `rgba16float` field texture. `w` and the quad radius (in
   field texels) are set so a star covers about one mean inter-star spacing;
   the radius is clamped `2.5…40` texels so both a 50-star sky and a 300 k-star
   field fill the map.
2. `field-blur` — a fullscreen 3×3 binomial pass at field resolution, reading
   the splat texture with `textureLoad` and writing a second `rgba16float`
   texture. The moments stay aligned because all four lanes take the same
   weights. Separating this from the composite is what keeps the composite at
   one sample per value even in the two derivative modes.
3. `field-composite` — a fullscreen triangle drawn **after** the tone-map
   pass, on the swapchain with premultiplied alpha. It maps the mode's raw
   value through the display range, samples a 256×1 `rgba8unorm-srgb` ramp LUT,
   applies shaded relief and contour lines, and mixes over the finished frame
   with the opacity slider. Off (mode 0) all three field passes are skipped, so
   the overlay costs nothing when it is not in use.

### Modes and units

- `height` (1) — the weighted mean of `log10(d/kpc)`: the island's mode 1, with
  near = high. The display value is `(hi − raw)/(hi − lo)`.
- `spread` (2) — the weighted standard deviation of the same log distance, in
  dex: the island's mode 2, computed from `b/r − (g/r)²` after the blur. Display
  climbs with `log10(σ)`.
- `slope` (3) — `|∇log10(d)|` in dex per degree of sky, the island's mode 3,
  read from the same blurred mean with a one-texel central difference scaled by
  the field's angular texel size. Display climbs with `log10(slope)`.

### Display range

The range is physical and declared, never a per-frame renormalisation of the
picture. It is sampled on the CPU at 4 Hz while the overlay is on — the sample
moves with the star clock as well as the eye, so a frozen camera still describes
the sky it is drawn over — from at most 256 visible records taken by an even
stride over all five blocks, resolved through `orbit.engineRecordPosition` — the picker's dispatch,
so the sample moves with the star clock like the sprites do (the simple lane
uses the same documented classic approximation the picker reports).

- `height`: the 2nd/98th percentiles of the sampled log distances; the island's
  padding rule (4% of the span plus 0.02, 0.3 dex floor) applies.
- `spread`: for each sample star, the σ of the log distances of its 6 angular
  nearest neighbours; the 5th/95th percentiles of `log10(σ)`.
- `slope`: for each sample star and its angular nearest neighbour,
  `|Δlog10 d| / Δangle` in dex per degree; the 5th/95th percentiles of its
  `log10`.
- Fewer than 3 samples falls back to fixed ranges the legend quotes
  (`height` −2…1 dex, `spread` −1.3…0.2, `slope` −1.5…0.3).

The CPU state is allocated once (`math/field-overlay.js`) and the percentiles
sort a preallocated 256-float scratch; the refresh never allocates.

### Look

`math/field-ramp.js` owns the five island ramps (viridis, the published turbo
polynomial, magma, the hypsometric terrain, grey) and their per-mode defaults;
the island painter and the overlay read the same LUTs, so a colour cannot mean
two things in the two views. The overlay uploads the active ramp as a
`rgba8unorm-srgb` 256×1 texture and samples it bilinearly through
`textureSampleLevel`. Shaded relief is the cartographic north-west light with a
0.45 ambient floor, clamped to darken only, and contours are darkened band
edges at the slider's level count (0 = off).

### The controls

Display panel, under a `View field` heading: a mode select (off / height /
spread / slope), opacity (0…1), ramp (auto + the five), relief (0…1) and
contour levels (0…12). `M` cycles the mode. All five are preset fields
(`viewfield`, `viewopacity`, `viewramp`, `viewrelief`, `viewcontours`) and boot
params, with the defaults owned here. The 2D label layer draws the compact
legend — ramp strip, mode name, and the range in the mode's own unit — while
the overlay is on.

### Tests

`experiments/field-overlay-test.js` pins the CPU half: percentile windows, the
spread/slope estimators against hand-built star sets, the splat-radius law at
0/50/300 000 stars, the uniform layouts and the fallback ranges.
`experiments/renderer-test.js` pins the wiring: seven shader modules and
pipelines, the three extra passes and their instance counts with the overlay
on, no field passes with it off, and the composite's blend state.
`experiments/wgsl-validate.js` extends the part/wired lists and checks the
shared `starMovedPosition`, the field constants and the composite's bindings;
`wgsl-exec-check.js` parses the three new modules like every other shipped one.

---

## View Modes Shader.6 — the corrections (view-modes.5, 2026-10-18)

The plan above is the spec; this section records where the shipped code had
drifted from it, and the two laws that now pin it.

### The two grids are not the same grid

The composite is a **fullscreen pass on the swapchain**, so its fragment
position is a *canvas* pixel. The texture it reads is the field's own grid —
half the canvas, clamped to 256…640 wide. The two share the camera's NDC, so
one canvas pixel maps to one field uv, but only if the shader divides by the
*canvas* size:

```wgsl
let uv: vec2f = vec2f(frag.x / u.canvas.x, frag.y / u.canvas.y);
```

The shipped code divided by the field size (`u.viewport`), which samples three
times outside the texture on a 16:9 canvas: the picture showed the field's edge
column, and no star sat on its own colour. The uniform therefore carries **two**
sizes — `viewport` (field width, field height, tan(fovY/2)) for the texel maths,
`canvas` (canvas width, canvas height) for the lookup — and
`experiments/field-overlay-wgsl-check.js` executes the real passes to prove the
correspondence.

### Relief off means no shading

The cartographic rule is the island's: at exaggeration 0 the map is the flat
ramp, so the legend's strip is the picture. A shading factor that is constant
on a flat field (`0.45 + 0.55·max(dot(n, light), 0)` = 0.839) breaks that, so
the composite now skips the shading entirely when the relief is 0 and the
legend's note says *shaded* when it is not.

### The island's anchors are the app's stars

A procedural galaxy has no catalog, so the island samples one — but the sample
must be the *app's* sample (`sampling.sampleGalaxyStars(model, model.seed, n)`)
and every star in it must carry the *app's* record, or the anchors are a frozen
guess: `starTypes.deriveStar` for the class, `orbit.familyForStar` and
`orbit.epochFlagsFor` for the family and the epoch bits,
`orbit.flagsWithFamily` for the flags word, `starTypes.fieldStarJitter` for the
phase/amplitude byte, `star-record.packPacked` for the word. The pattern's
phase turns with the star clock (`orbit.setPatternClock`), the epoch base is
re-based on every model (`orbit.setEpochBase`), and the engine row is the
app's, with the one honest limit stated on screen: the simple friction field
has a CPU mirror for the landmarks, not for records.
