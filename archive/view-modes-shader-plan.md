# View Modes Shader: Heightmap Visualizations for Navigation

## Context

`archive/draft-view-modes-shader.md` asks for a separate render page that visualizes
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

---

## Out of scope
- Pathfinding
- Full game mode integration (ship slowing by heightmap).
- Volumetric nebula heightmaps.
- Export
