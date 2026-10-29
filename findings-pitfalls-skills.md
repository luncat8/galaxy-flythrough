# Findings, Pitfalls & Skills

## 2026-10-24 — A split-brain camera passes count-only checks while pointing away from the galaxy

The `0.7.8` real-GPU smoke log passed `29/29` checks while two of its eight
`.webp` thumbnails (`T = 0.0 Gyr (gas only).webp`, `T = 13.5 Gyr (Present day).webp`)
were nearly black (`litPx = 6` and `litPx = 75` out of `23 040` pixels). Three
distinct assumptions had conspired:

1. **`camera.cameraPos` is a derived output, not an input.** `setupGalaxyCamera`
   wrote `cam.cameraPos[0..2] = [cx, -14, 7.5]` without calling `cam.setState`.
   `StarRenderer.buildUniforms` subtracted `cam.cameraPos` in the vertex shader
   while `cam.buildViewProj` still looked along `+X` (`yaw = 0, pitch = 0`) from
   internal `pos = [0, 0, 0.005]`, projecting Galactic Centre to
   `ndc = (-3305, -2833)`. Six outer halo/gas fringe pixels clipped the corner
   of the frustum, satisfying `litPixels > 0`! Fix: always configure poses via
   `cam.setState({ position, yaw, pitch, mode })`, assert `coreLuma > outerLuma`
   on overview frames, and project CPU-fallback estimates through
   `camera.buildViewProj` so headless Node catches mis-aimed cameras too.
2. **`createGalaxy({ type: 'SBb' })` without `overrides` is the Milky Way.**
   `MILKY_WAY_TYPE` is `'SBb'`, so `sbbRef` silently carried `milkyWay === true`
   and 60 curated landmarks (`birth = -BIRTH_FADE`) at `[0, 0, 0]`, lighting 33
   pixels at `T = 0` once the camera faced the galaxy. Procedural non-Milky-Way
   controls must use a non-MW Hubble type (`Sb` / `SBc`) or pass `overrides: {}`,
   and assert `model.milkyWay === false`.
3. **Monotonic star formation grows as `O(N)`, not `O(√N)`.** Across `3.4 → 3.6 Gyr`,
   newly born stars add `ΔN ∝ N` (`+373` lit pixels at the browser's `24 000`
   budget vs `+35` at Node's `4 000` budget). Gating `max - min <= 3√N` passed at
   `N = 4 000` and failed at `N = 24 000` by mistaking steady condensation for an
   exposure dip. Gate downward drops (`max(0, c0 - c1, c1 - c2) <= 3√N + 2`)
   instead of two-sided spread, and test continuity at the browser's full star
   budget.

Skill: `litPixels > 0` only proves the frustum grazed *something*; pair every
overview frame with `coreLuma > outerLuma` and keep CPU-fallback tests inside
the same `buildViewProj` transform the GPU uses.

## 2026-10-20 — A growth plateau is usually several gates stacked

The trade network sat at 14 colonies for minutes, and every explanation found
one gate: landmarks exhausted, too few candidates, warehouse stock, the launch
interval. Each was real, and fixing any one alone changed nothing because the
others still held. The decisive measurement was not a rate but a counter: the
status line reported `stocked: 1` of 14 big colonies — thirteen were large, fed
and *unable* to pay the `people + factory cores` expedition cost, because only
one world in fourteen produced a people surplus and none of the marginal giants
held a factory-core surplus. The search loop then skipped them before it ever
looked at distance.

When a network stops growing, instrument every conjunct of the launch condition
and print the count that reaches each stage (`big`, `ready`, `resting`, free
candidates, distance). The gate with the smallest count is the one to remove
first; a domain cost (population) that every healthy node can pay is a better
founding currency than a warehouse good only some world types produce. And when
the fix is a *rate* (a 40-year e-folding) plus a *range* (600 ly) plus a *law*
(one candidate per star), measure the whole curve — 4 → 64 ports — not the one
number the old test pinned.

Skill: a plateau is a conjunction, not a single cause. Count the stages, fix the
smallest set, then re-measure the growth curve against the real start map.

## 2026-10-20 — A fixture that omits a live input measures a different scenario

The start-scenario test built its field with `sampleGalaxyStars` and passed it to
`startSystems`, but left `ctx.field = null`. The page sets `ctx.field` to the
live field before generating systems, and the generator's output depends on it:
the field stars of the start map came out different, so the fixture's network
grew 44 → 51 ports where the page's grew 56 → 64. Two rounds of band tuning were
spent on a curve the app never produced.

A scenario fixture must reproduce the app's *environment*, not just the same
seed and the same functions. Diff the fixture's boot values against the page's
(the port names, the first candidates, the first 10 s of the curve) before
writing acceptance bands, and re-measure the bands from the fixture, never from a
probe that took a different path.

Skill: when tests and probes disagree, the difference is an input, not noise.
Find the input the fixture omits before you change the numbers.

## 2026-10-20 — Idle polling is a hidden O(clock rate) cost

Every system that "tries again in a few years" multiplies its event rate by the
clock: a 2-year retry on 19 idle hulls is 19 events per 2 years at 1 y/s and
9 500 per second at a 2 000 y/s clock. A saturated trade network is *all* idle
hulls, so the frame budget went to retries and the simulation fell behind
(measured: 3.8 s of CPU per 20 s, 7 500 years of backlog). Geometric backoff
(2 y doubling to a 500-year ceiling, reset on success) cut it 10x with no
visible behaviour change: 389 ms, zero backlog.

The same shape applies to the colony economy's reserves: a fleet slowed 2 000x
must not be served by a 150-year warehouse, or the network starves between two
arrivals and the "slow mode" reads as a dying one. When a mode changes a
timescale, find every other timescale it is coupled to (retry intervals, stock
horizons, tick periods) and move them together; the test for it is not "does it
run" but "does the network still have the same big-colony count after 20 000
years".

Skill: price an idle entity per second of clock, not per event. `events/s =
entities / interval × clock rate` — the clock is the multiplier that turns a
harmless retry into the frame budget.

## 2026-10-20 — A simulation clock cannot share a year with the star clock

The trade network is authored in colony years (25-year ticks, 150-year
warehouses, 80-year population e-folding); the star clock is authored in
galactic years (0.1–99 Myr/s). Coupling them 1:1 at 2 Myr/s asks the event
queue for 2·10⁶ years of voyages per wall second: measured 313 ms of CPU per
frame, 51 000 events a frame, and 5 % of the requested clock actually
advanced. Any "sync these two clocks" feature has to be a *rate* with a
ceiling, and the frame that cannot drain to its target must stop at the next
due event (never past it, or the next colony settle runs backwards) and
report the backlog. `experiments/trade-test.js` §11 pins both halves.

Second lesson from the same pass: "the colony does not grow" was a *rendering*
complaint, not a simulation one — the simulation grew 56 M → 1 045 M in 20 s,
but the overlay drew every port as the same 3.5 px ring. Encoding a quantity
(population) into radius and its sign (growth) into colour turned the same
numbers into a picture; check what the screen shows before suspecting the
model.

Append-only notes for LLM agents working on this project. Each entry: date, one-line summary heading, then the detail. Newest at top.

---

## 2026-10-20 — Test both endpoints, event ownership and fractional conservation

A trade overlay resolved its first endpoint into `tradeA`, then used that same
array as the orbit dispatch scratch for its second endpoint. Both projections
therefore read the destination: finite-position tests passed while routes had
zero length. Resolve directly into the caller's `out` and test a nonzero-length
route plus a hull at a known fraction with motion enabled. Also test turning a
canvas-only overlay off while all other passes are disabled: the last painted
frame needs one final clear before early-returning.

An event-count upper bound cannot prove one live event per ship: eventless
owners make the queue *smaller*. Count revision-matching entries for each owner
and require exactly one (plus the global tick). Reserve whole candidate systems
and outstanding port slots before launching expeditions, and keep failure paths
scheduled. Stress overlapping expeditions independently of today's tuned speeds.

Factory stock is continuous. Flooring stock-to-tonnage conversion and then
clearing cargo below one unit silently destroys partial deliveries. Preserve
fractional units end-to-end and round only the UI. Test partial warehouse room,
a blocked unload, and a later complete unload for mass conservation.

---

## 2026-10-19 — A log that only changed its timestamp is not a change: compare the payload, not the file

Every test in `experiments/` ended with the same four lines — `mkdirSync`,
`writeFileSync(path, JSON.stringify({ date: new Date().toISOString(), ... }))` —
so `all-tests` rewrote all thirty-odd logs even when nothing the tests measure
had moved, and a tree that was clean before the run was dirty after it. Timestamps
are the one field that *always* differs; a rerun is only informative when
something else differs too. `experiments/log-file.js` now owns the write: parse
what is on disk, strip the top-level `date` from both sides, and keep the file
(its old timestamp included, untouched on disk) when the JSON matches. A changed
check, a new field, a timing or a nested `date` still writes.

Two details worth keeping:

* **Compare parsed JSON, not text.** Indent and trailing-newline differences are
  not information, and the same object built by the same code stringifies in the
  same key order — so a `JSON.stringify` comparison of the date-less objects is
  both exact and cheap. A file that fails to parse is stale by definition and
  gets replaced.
* **Only the top level is the timestamp.** A log may later carry a `date` as
  test data (a sampled epoch, an observation time); stripping keys recursively
  would hide a real change in it. If a new log needs a second volatile key, say
  so explicitly rather than widening the rule.

`scripts/run.py quick|changed` still preloads `no-log-writes.js`; it now sets
`GALAXY_LOG_WRITES=off` (so the writer reports `Kept ... (partial run)` instead of
lying about writing) and keeps the `writeFileSync` stub for the few direct writes
(PNG frames, PPM traces). `log-file-test.js` pins all of it, including that the
file's mtime is unchanged when only the date moved.

---

## 2026-10-18 — A bounded rate replaces the confirmation gate; a falloff must be monotone in δ

Supersedes the last entry of this file ("An auto follower must trust repetition,
not magnitude"). Its diagnosis was right — a suggestion far from the current
value is usually *unmeasured* data, not a new neighbourhood — but its cure is
the shape of the bug it replaced. Holding the target until consecutive 4 Hz
reads agree works on a re-pick and fails on a pan, because a pan moves *every*
read: agreement never arrives, the target stays frozen at the pre-pan window
for the whole gesture, the settled field falls outside it, and the picture is
one colour until the reads happen to line up again. Measured on a 3-decade pan
in 2 s, that law left the display 2.90 dex off the window the field wanted
(0.37 mean); the law below 0.85 and 0.13, monotone the whole way.

Two rules, both in `src/math/view-modes-field.js`:

* **Follow the newest read at a bounded rate.** `offerRange` makes the latest
  measurement the target *immediately*; `easeRange` closes the gap through a
  single pole whose time constant grows with the distance it has to travel —
  `1 - exp(-dt / (RANGE_TAU_S + |gap| / RANGE_MAX_RATE))`. A correction of the
  size a pan leaves lands in τ = 0.2 s; travel never exceeds 2.5 dex/s however
  far the target is. A rate ceiling *is* the outlier filter, and it needs no
  decision about which read to believe — and unlike a gate it can come back
  *down*, which matters: a fast flick used to leave the span permanently wider
  because only agreed (widest) offers were ever locked in. Do not add a second
  stage: a median window, a confirmation count or a smoothed offer each add
  their own delay to the real change and none of them remove the outlier (the
  two-pole version measured no better and cost a state field). The follower
  state is `{mode, lo, hi, targetLo, targetHi}` and nothing else; the field test
  asserts exactly that, so a revived safeguard has to be noticed.
* **Percentile the field, and never let it see what the camera cannot.** The
  suggestion was mode 1's raw min/max — the one statistic a single anchor can
  move by itself. p5/p95 of the same log histogram is now the estimator for all
  three modes (the shader plan asked for percentiles from the start; min/max
  was drift). One 8 pc star in a 61×61 window: the field's own extreme moves
  1.08 dex, the percentile window 0.72, and 96% of the texels stay inside the
  ramp instead of being squeezed into its top few percent. Then the fix that
  made the symptom honest at all: the IDW weight was `1/(sin²δ + sin²σ)`, and
  `sin²δ` is symmetric about δ = 0 *and* 180° — every star painted a
  full-strength copy of itself at its antipode, the whole map was
  180°-rotation-symmetric, and a close star *behind* the eye owned the screen in
  front of it, so *no* range law could have helped. `q = 2 - 2c` (= 4 sin²(δ/2),
  same width to first order, monotone up to 4) is one line and one multiply: the
  same star astern now moves the window 0.02 dex instead of 0.44. `makeScale`,
  `heightOfDistance` and `distanceAtHeight` — the anchor scale `computeRaw`
  quoted for mode 1 — go with the min/max suggestion they served: the legend
  labels its ends from the live range (`10^lo`), so nothing else called them.

Two smaller traps on the way. A percentile window clamps *on purpose*, so
"every extreme is painted inside 0..1" is not a property to demand of the
display any more — the check to keep is that the clamped tail stays a tail
(< 10% of texels) and that the raw field has no hole. And `autoRange` writes
`out.span` into the caller's scratch object, so that literal must declare
`span` too or the object changes shape at runtime.

---

## 2026-10-18 — A fullscreen pass on the swapchain reads the *canvas* grid, not the field's

The view-field overlay draws the field into its own (half-canvas) texture and then
composites it fullscreen on the swapchain. Those are two grids, and the fragment
position of a fullscreen pass is a **canvas** pixel. Dividing it by the *field* width
(`frag.x / u.viewport.x`) samples three times outside the texture; the sampler clamps,
so the picture shows the field's edge column stretched over the frame and no star sits
on its own colour — the symptom reads as "the stars do not fit the colour map", not
as a grid error. The uniform now carries both sizes (`viewport` for the texel maths,
`canvas` for the lookup), and the rule to keep: *a pass that reads a texture must know
which grid the texture lives on*.

Two ways it stayed invisible: the CPU half of the feature never touched the swapchain,
and the WGSL was only ever parsed, never executed. `experiments/field-overlay-wgsl-check.js`
now runs the shipping splat, blur and composite through wgsl_reflect's interpreter —
with the old mapping the colour under every star is `[0, 0, 0]`, a black map. Its
negative control computes what the mix-up *would* produce and requires the two to
differ, so the check cannot pass blind.

Two smaller traps in the same pass:

- **A relief that is off must not shade.** The cartographic rule is "at exaggeration 0
  the map is the flat ramp", but a shading factor of the form `ambient + (1-ambient)·dot(n, light)`
  is 0.839 on a *flat* field, so "off" was 16% darker than the legend's ramp strip and
  the two could never match. Gate the whole shading on the exaggeration, not on the
  slope.
- **A sprite and the thing that describes it must project through the same matrix.**
  The field splat reuses the sprite pass's `starMovedPosition` header and the same
  `camera.viewProj`, which is why the overlay describes the frame's own stars. A second
  projection — however careful — is a second camera, and the map stops being a map of
  what is on screen. The check that pins it compares the two passes' projected centres
  on the *shipping* shaders, with an off-origin eye and a non-square aspect.

## 2026-10-18 — An island that mirrors the app must carry the app's *records*, not just its positions

A standalone page that reads the same model can still describe a sky the app never
draws, because the app's stars are records, not positions: the record's packed word
carries the family (which orbit the star rides), the epoch bits (whether the epoch map
places it) and the jitter byte (its epicycle phase and amplitude). A sampled sky with
`packed = 0` is a set of points that never move — the map is frozen while the app's sky
turns. The fix is to build the record the app builds: the same sampler and the same
model seed (`sampling.sampleGalaxyStars(model, model.seed, n)` — the app's field is a
prefix of any longer sample of the same seed), `starTypes.deriveStar` for the class,
`orbit.familyForStar` + `orbit.epochFlagsFor` + `orbit.flagsWithFamily` for the flags,
`starTypes.fieldStarJitter` for the jitter, `star-record.packPacked` for the word.

Two clocks ride on top of that, and a page that keeps its own star clock but not these
two freezes in a different way: the pattern's phase (`orbit.setPatternClock` — the arms
the stars orbit turn with the clock) and the epoch base (`orbit.setEpochBase` — a model
change re-bases it, or the epoch map measures the new model against the old one's arms
and moves every anchor off the app's stars). Both are one call each, and both are easy
to forget because the app's `main.js` does them.

**Skill:** put a shared law in `math/` the moment two callers need it. `epochFlagsFor`
and `fieldStarJitter` were in `render/star-sprites.js`, where the island could not reach
them; moving them to `math/orbit.js` and `math/star-types.js` made the island's records
the app's records by construction instead of by copy.

---

## 2026-10-17 — Two branches solved the same plan; the GPU is the only speedup left in the heightmap, and the CPU loop has none

`b2c97fbf` rebuilt the view-modes island as one inline-WebGL2 HTML file off the same
merge base as view-modes.1. Comparing before picking (view-modes.3) produced five
lessons:

1. **Benchmark the "faster" branch before believing it.** The alt branch's speed is its
   substrate, not its algorithm: the same O(w·h·N) IDW, evaluated per canvas pixel on
   the GPU instead of per texel on the CPU. Measured here, the CPU does ~0.3 Mpair/ms,
   so main's `balanced` budget paints 72×40 texels at N=500 (one texel per 720 screen
   px) and full 1920×1080 costs 3455 ms. And the CPU inner loop has *no* headroom left:
   interleaving the star SoA into one stride-4 Float32Array made it **slower**
   (110 → 147 ms at 384×216×500) — the loop is bound on the reciprocal, and the JIT
   already keeps the split arrays hot. Don't tune what measurement says is at the floor.
2. **A frame-pumping harness must keep its clock monotonic.** `pump(n, t0)` called with a
   `t0` below the previous section's last frame gives the page a negative `dt`; the
   frame still runs, so nothing errors, and the failure surfaces three sections later as
   a starved 4 Hz auto-range read. Treat `t0` as a floor, not a value.
3. **A hot-loop refactor must be bit-exact, and an f32 scratch is not.** Extracting the
   gradient's central differences into a shared `fieldSlope` (now also the relief's
   slope source) moved mode 3 by ~25 ulps while the scratch pair was Float32Array. The
   *output* is f32 anyway, so the suite's tolerances smiled; only a throwaway parity
   script against `git show HEAD:` caught it. Run that parity before trusting green.
4. **When picking from a buggy parallel implementation, port the idea, not the
   arithmetic.** The alt branch's hillshade cost four extra full star sweeps *per pixel*
   (nine with its gradient); the same relief is one O(w·h) central-difference pass over
   the 0..1 field the page already holds. Its gradient hard-clamps to 1 — the "gradient
   of 1" wall main removed in .2; its shade multiplies up to 1.25 and clips, which makes
   the colour stop meaning the legend; and its mode-1 height is a linear min-max over
   5 pc…800 pc, putting every real star on one colour — the exact bug view-modes.1 fixed.
5. **A fitted colormap polynomial must be clamped on the way into bytes.** Turbo's
   published degree-5 polynomial overshoots [0, 1] by a hair at both ends. `Uint8Array`
   converts out-of-range by *modulo*, not clamp — a 1.002 channel lands as 0.5/255, a
   dark pixel inside a yellow ramp. (`Uint8ClampedArray` would have hidden it.)

---

## 2026-10-17 — A projection inverse needs a pixel-level parity test; a round trip through one direction hides a scale bug

The heightmap island ("the map must correspond to where the stars are") failed in four
independent ways, and each one is a testing lesson:

1. **Never re-derive a camera basis in a feature module.** The first cut built screen-right
   as `cross(worldUp, forward)`, which is the app's *left*: the whole map was mirrored and
   the camera roll was silently dropped. A parity check that samples the identity pose
   cannot see it. Read the pose (`core/camera.js`'s `forward/right/up`, or copy the constant
   when isolation forbids the import), and assert the sign explicitly
   (`right · app.right > 0.999`) at a pose that carries roll.
2. **Forward-and-back is not a two-way test.** `texelOf(dirAt(t)) == t` passed for every
   texel while `dirAt(texelOf(star))` pointed 70° away from the star, because `lat` is
   `asin(v.z)` of a component — a mapping that ignores the input's length only if you
   normalize first. Callers hand it a kpc offset (|v| ≈ 0.007), so every marker slid toward
   the equator. Pin both directions, and pin the invariance directly: *the same texel for a
   direction and for 1000× that direction*.
3. **Auto-renormalizing a measured field every frame throws away the measurement.** Scaling
   the blurred height to `[vMin, vMax]` made the legend's numbers lies: a set of stars all
   beyond the range read as 1 = "closest", and the map inverted when a bright star entered.
   Keep a fixed log scale with a floor (`max(1 pc, dMin)`) and no renorm, and test the
   invariance that must hold (all-beyond-range ⇒ floor, not peak).
4. **A `[a,b,a,b]` typed array is not an array of pairs.** `C.LINES[i].edges` is an
   `Int16Array`; reading `e[j][0]` gave `undefined` → 0, so all 41 constellation edges became
   (Sun, Sun) — a truthy array, an empty overlay, and one `!!set.segments` assertion happily
   green. Assert the contents (indices in range, `a !== b`, one named edge present) and the
   length against the data module's own `edgeCount`.

Two more, from the harness rather than the feature: a canvas stub whose `drawImage` copies
the source over the *whole* destination instead of the destination rect paints the legend
strip across the map and reports "nothing changed"; and `projectToScreen` leaves `px` stale
when the point is behind the camera, so an app-parity test must skip on that return value and
must read `cam.getState()` *after* `setState` (a pre-setState copy compares two different
cameras and passes).

---

## 2026-10-17 — A soft IDW peak is a design parameter: wide σ reads as a flat map

"Smooth like a heightmap, not flat Voronoi cells" is satisfiable without diffusion:
Shepard IDW with p=2 and an angular half-width, `w = 1/(sin²δ + sin²σ)`, gives a gradient
radiating from each star and blends two stars on the same ray to their mean by construction.
But σ sets how much of each star's own height survives: over the 60-landmark sky at
192°×176° chart resolution, σ = 10° averaged the near stars down to 0.72 of their height and
confined the whole map to 0.35…0.75 — no red anywhere, the "flat" complaint back again
through the back door. σ = 3° keeps 0.89 and uses 0.78 of the ramp. The falloff must be in
*angle*, not texels, or a chart resolution change silently restyles the map — and the peak
plus the used ramp range belong in a test, since both are the visible promise.

## 2026-10-14 — A difference-of-sines wobble needs half the headroom, not all of it

The classic vertical epicycle is `Δz = av·(sin(ψ + κt) − sin ψ)`, so its
maximum displacement from birth is `2·av`, not `av`. Capping `av` at the full
remaining slab height sounds safe but is not: on the Milky Way model, a star at
`z = 2.9 kpc` with a `3 kpc` cut, phase 8 and the top amplitude rank reaches
`z = 3.1 kpc` at half an epicycle. Cap it at `0.5·max(H − |z|, 0)` (or clamp
the final displacement) and mirror that exact rule in WGSL and any f32 replay.
Population histograms can miss this sparse edge case, so pair them with an
adversarial single-star test at both slab edges and execute that fixture on the
shipping shader.

---

## 2026-10-14 — A centred orbit plane contracts a column; the fix is an anchor choice, and it wants one extracted basis

Follow-up 2a (the vertical column) turned out to be one decision, not a calibration.
The measurement said the column was *compressed*, never heated, which rules out any
amplitude retune: heating would raise `mean|z|`. A centred plane puts
`(qz/|q|)·cos α` into z, so the birth height decays with the orbit and the time
average is `mean|cos α| ≈ 0.64` of the birth column no matter what the inclination
does — an oscillation *about the plane* cannot be the fixed point of a steady-state
column. Only carrying the height can.

So the anchor is a per-family choice, stated once: **disc and pattern stars sweep a
plane parallel to the galactic plane through their own birth height** (basis =
radial/azimuthal unit pair, normal = +z, `carry = qz`), and **bar/pressure keep the
centred inclined plane**, which is what the per-star basis was introduced for. The
vertical life a disc star keeps is the epicycle's bounded `av` wobble, which lifts
`mean|z|` by 3.7–7.6% (it is the only reason the classic lane is not exactly 1.000).
A rigid pattern belongs on the horizontal anchor too: a pattern seat sweeps a
cylinder, so the old centred circle was wrong for it in a second, visible way.

Three techniques worth reusing:

- **One basis function, mirrored once.** The plane was built four times on the CPU
  (`orbitPosition`, `apocenterPosition`, `simplePositionFromTheta`,
  `simpleLandmarkPosition`) and three times in WGSL. Extracting `orbit.orbitPlane`
  (writing `e0/e1/nrm`, the sweep radius and the carried height into a shared
  scratch object) plus `fn orbitPlane` returning a struct turned the change into one
  edit per side and made a future drift impossible — the same argument as the
  channel-map one, for geometry.
- **A re-anchored ellipse must re-derive its scale from the new anchor.** The guided
  ellipse's semi-major axis came from the 3-D radius; with a horizontal plane that
  leaves the ellipse 0.6 pc off the birth point for ever, and force 0 stops
  conserving the birth radius. `a = pl.anchor·(1 + e·cosF)/(1 − e²)` fixes both, and
  the force-0 pin catches it if someone reverts it.
- **A gate built for a known deviation has to be rewritten, not loosened, when the
  deviation is fixed.** `movement-density-test.js` had the vertical column pinned at
  a 0.06 band with `mean|z|` gated to [0.6, 0.9] — a band that *requires* the bug.
  The fix replaced it with plan §1.4's own 3%-per-bin budget, a [0.95, 1.10] mean
  band, and [0.95, 1.01] on the lanes that carry exactly (no classic wobble).
  Leaving the old pin in place would have failed the build on the fixed build.

Also: `wgsl-exec`'s orbit fixtures all sit at z = 0, so the shipped shader had never
executed the vertical branch. Adding a z = 0.35 disc star swept half a turn (and a
pressure star that still swings) is what makes the WGSL side of this claim executed
rather than mirrored-in-text.

---

## 2026-10-13 — A plan's worked example is a byte-level spec: read the column widths off it and pin it in a test

The §6.6 readout example carries the format the prose only describes: `288.00 M⊕` says the
mass column is 8 characters right-aligned, `18.40 AU` says a planet's axis is *always* two
decimals — even at ≥ 10 AU — while `a_out 34 AU` (from 34.4) says only head-line scales
round. Re-deriving paddings from the prose produced a `padStart(7)` mass column in the
first draft; it fit every plausible value and broke the example. The fix that generalizes:
when a plan prints a worked output example, the test fabricates a record reproducing that
example's system and pins the joined lines byte-for-byte (`system-layer-test.js` §6).
Prose states intent; the example encodes widths, and only a byte-exact pin catches a
one-character padding drift.

---

## 2026-10-13 — One element, two writers: give the non-owning feature a shadow copy

`#sysread` serves the search report (0.5.2) and the system-view readout (0.5.3). Two
writers into one `<pre>` need an ownership rule, not a merge: while the view is open the
schematic owns the element at its 4 Hz cadence, and a search that runs underneath updates
only its own `sysreadSearchText` copy — never the DOM. Closing restores the copy (empty →
the CSS `:empty` rule hides it again); clearing search results while the view is open
clears only the copy. Any scheme where both writers touch `textContent` fights at the
refresh cadence and flickers. The same pattern will cover 0.5.4's delta-v block, which
extends the schematic's readout rather than adding a third writer.

---

## 2026-10-13 — Overlay picking stays exact only while the body rides the drawn primitive

The schematic is flat (plan §14 Q4) because every planet is positioned by the *same*
ellipse that `ctx.ellipse` drew — `θ(t) = θ₀ + TAU·t/P` on the `(A, A·√(1−e²)·cos i)`
figure rotated by ω — so "click what you see" is an identity, not an approximation: pick
reads the `Float32Array` the draw wrote. The moment a representation diverges from the
position law (a 2.5D tilt, a projected belt band), picking must mirror the transform or
silently drift from the pixels. Two testing notes: recompute expected positions in f64 and
compare with ~0.02 px slack — the f32 storage rounds at ~1e-4 px there, so the tolerance
stays 100× tighter than any real law bug; and a heap-delta assertion across 1 000 draws
must bound, not zero — V8's GC makes the delta routinely negative, which is a pass.

---

## 2026-10-12 — Bulk-index and display-type-id are different numeric spaces — do not conflate

A thermal index sized by `DISPLAY_TYPES.length` (10 entries) and indexed by `bulkIndex`
(0–6) reads out of bounds for the upper bulk indices: dwarf at index 6 reads slot 6 in a
10-element array, which happens to hold MINI_NEPTUNE's display-type id (also 6) — wrong
bulk, wrong type, passes only by coincidence when the id happens to match. The fix is to
size the index by `BULKS.length` (7) so every bulk index lands on its own slot, or — if
the constant-type mapping is the contract — to name it `PLANET_DISPLAY_THERMAL_INDEX` and
document that entries are display-type ids, not bulk indices, so a consumer cannot
accidentally index the display-type table with the result.

Dwarf is the one bulk whose display type is NOT constant across bands: LAVA in band 0
(extreme heat), DWARF in bands 1–3. A constant thermal-index entry of DWARF is therefore
wrong for band 0. The clean fix is a special-case early return in `planetDisplay` rather
than a conditional that would make the thermal index depend on the band.

---

## 2026-10-12 — A test's expected display type must follow the plan's band-refinement table, not intuition

Three test expectations in the six-body Solar temperature table were wrong in the first
draft:

- **Mercury** (M=0.055, band 1): the plan's table says "rock, 0.02 ≤ M < 0.3 → BARREN".
  The first draft expected LAVA, confusing "close to the star" with "below the airless
  threshold" — but Mercury at 0.055 M⊕ is above AIRLESS_M (0.02), so it retains enough
  surface to be BARREN, not LAVA. The LAVA tier is for bodies below 0.02 M⊕ in band 0/1.
- **Mars** (S=0.431, band 2): the test expected band 1. 0.431 > 0.35, so Mars is in band 2
  (the habitable zone), not band 1 (the hot/runaway zone). Mars's actual temperature
  (216 K) and display type (DESERT) follow from the band-2 table, not band 1.
- **Venus** (runaway, albedo 0.70): the test expected Teq = 302 K (the base DESERT albedo
  of 0.28) but the plan's 742 K uses the runaway albedo 0.70 (cloud-shrouded), which gives
  Teq = 242 K. The albedo column in the §4.2 table is what the table assigns, not the base
  display type's — Venus is the one body where these differ.

Rule: when writing a temperature pin against the plan, check the plan's own band-refinement
table for the display type and its albedo, not what the planet "should be" by solar-system
analogy.

---

## 2026-10-11 — GPU/CPU subset membership needs bit-exact f32 hashes — and never hash moved coordinates

Two traps met while unifying the engine-mask dispatch (movement-parity-plan):

1. A per-star subset gate (the apocenter share) must decide IDENTICALLY on the
   GPU and on the CPU mirror, or a label/pick drifts off its rendered star.
   WGSL `hash01` rounds both the hash and the quotient to f32
   (`f32(pcg) / 4294967296.0`), while the CPU helper returns the exact f64
   quotient — and the uniform's share is f32 too. The selector therefore has
   to be reproduced in f32 on the CPU: `Math.fround(Math.fround(h) / 4294967296)`
   compared against `Math.fround(share)`. The integer hash chain (pcgHash /
   hash4) already matches u32 exactly via Math.imul, so that is the only fix
   needed. Any future mirror of a WGSL `hash01` gate must do the same.
2. Membership and any birth-anchored construction (the apocenter ellipse)
   must read the immutable BIRTH position. Feeding the previous pass's moved
   position into the hash re-rolls the subset every frame (stars pop in and
   out of the pass), and anchoring the ellipse to a moving point feeds back
   into whatever produced it. Composable passes work as a PARTITION of
   stars (stable birth hash picks the subset; each pass rebuilds from birth),
   not as a cascade of coordinates.
3. Related dispatch trap: a bitmask lane that runtime code clamps to nonzero
   (setEngine never leaves mask 0) still reaches shaders as 0 in tests and
   fixtures. Decide what mask 0 means in the shader (we made it the identity
   baseline) and make fixtures pack a real mask via the shipping packer
   instead of hand-writing lane values — stale hand-written IDs were half of
   the wgsl-exec failures this round.

## 2026-09-26 — A "no visible step" gate must measure against the model peak, not the local jump

The first shape-test drafts failed on fields that were smooth. An Sersic spheroid
has a cusp in drho/dr at its s = 0 core (the profile's slope is finite, the second
difference is not), and a young-population annulus can fall off steeply enough that
a finite jump threshold sees a step where there is none — E0 measured 0.84 of the
local bin value at the core, SBd 2.2% at a bulge annulus, both smooth. A local
threshold cannot separate those from a real defect, because the defect (the old
flat-z bar slab) had a *first* difference of 0.28–0.84 *of the model peak* while the
smooth features only looked large next to the local value.

The gate that works: take the cut, compute second differences on a fixed 0.005 kpc
bin, and normalise by the peak of the whole cut, not by the bin. A real discontinuity
still shows up (0.28+ of the peak); a cusp or a steep-but-smooth falloff does not
(after the slice-profile rewrite every type's worst residual is ≤ 0.0076 of the
peak against a 0.02 limit). Keep a tighter bound — 0.01 — when the cut is taken
inside the component under test, since the body is then the signal rather than a
tail. The corollary is that the check must run on the *field*, before sampling:
Poisson noise in a sampled histogram is its own much larger second difference, which
is why the same test's population checks use total variation at 250k stars instead.

## 2026-09-26 — Hard-truncating a pattern inward prints a rim; fade the contrast instead

`armFactor` used to switch the spiral pattern on at `arms.minRadius`: below it the
field was pure disc, above it the arms were at full contrast. That binary edge is a
discontinuity in rho, and the step detector found it in the Irr type at z ≈ 0.4 as a
2.3%-of-peak residual — small, but an edge-on view of an unbarred galaxy is exactly
where such an annulus shows.

The fix is to ramp the pattern's contrast to zero before its declared inner edge
(`ARM_INNER_FADE = 0.5`: full contrast at `minRadius`, zero at
`(1 − ARM_INNER_FADE)·minRadius`). Two traps: the ramp must go *inward* — starting
from `minRadius` and ramping outward instead removes the bar-end ridge coupling,
because `armFactor` at `minRadius` must still be the documented `1 + amp` for the
arm-couples-to-the-bar-end rule, and the model-parity pins catch it immediately.
And the sampler's azimuthal draw has to multiply by the same fade factor, or the
birth distribution disagrees with the field it is sampling and the marginal
histograms drift even though both look plausible in isolation.

## 2026-09-26 — A boxy/peanut bar is a superellipse slice family, and both its mass and sampler are closed-form

The 0.4.8 bar profile is rho = amp · L(xi) · (1 − |u|^n − |v|^cv)^q with
u = eta/tau, v = zeta/(P·tau) and tau the shrinking cross-section radius. Writing it
as a slice family is what makes the 3-D shape affordable: sampling needs no
rejection, and the mass integral needs no Sersic stand-in.

Two facts do the work. First, the unit superellipse integral is a beta function in
each axis, so the slice mass is `4·K(cv,q)·(1/n)·B(1/n, q+1/cv+1)` with
`K(c,q) = (1/c)·B(1/c, q+1)` — the closed form the volume pin now uses. Second, the
marginal in one coordinate keeps the same shape with the exponent raised by the other
axis's reciprocal: `p(u) ∝ (1−|u|^n)^(q+1/cv)` and `p(w) ∝ (1−w^cv)^q`, where
`w = v/(1−|u|^n)^(1/cv)`, so the vertical draw is independent of `u` and three
symmetric inverse-CDF tables suffice. Check any rewrite against the `q = 0` identity:
the same integral must reproduce the old flat ln-disk area, which is what guarantees
the new field is a refinement of the old one rather than a new look.

The knob's floor is a physical, not arithmetic, constraint: `cv < 2` makes rho(z)
turn over with infinite slope at the midplane, i.e. a crease along the galaxy's
midplane when seen edge-on, so the authored anchors stay at or above 2.0 (shipped
2.60 → 2.00) even though the plan's first draft suggested 1.8 → 1.3. And `q ≥ 1` is
what actually removes the rim: the profile meets its envelope with zero gradient, the
same reason the Plummer truncation never shows.

---

## 2026-09-21 — WGSL comments live inside a JS template literal; a backtick ends the string

Every shader in `src/render/shaders.js` is a JS template literal, so WGSL comments are
still JS string content. Writing `` `q` `` in a comment terminates the literal: the
rest of the shader becomes JS, and the failure surfaces as a SyntaxError at
`require()` time in whatever test loads the file first — not as a shader compile
error, which sends the hunt into the wrong file. The repo's own WGSL comments avoid
backticks for exactly this reason; prose in a shader comment gets single quotes or
parentheses. `wgsl-validate.js` does not catch it (it reads the file as text), and
neither does any linter here, so the cheapest guard is habit plus `node -e
"require('./src/render/shaders.js')"`.

---
## 2026-09-21 — `gasRich` does not mean the arm branch can fire

An E4 at 0.5 Gyr is gas-rich (0.196 of its reservoir still cold, above
`GAS_RICH_MIN`) and has no spiral pattern at all: `distanceToNearestArm` returns 99
where there is no ridge, the ridge gate's `pArm` is 0, and every star — including the
0.55% of O/B that make it read blue — comes from the field SFH branch. So "gas-rich
type has young arm stars" is two conditions, gas *and* arms, and any check phrased as
one of them is vacuous for half the type table. The same trap is in the mirror: the
WGSL gate reads `populations.z` (gasRich) and then `distToArm`, and a probe suite that
asserts "the arm branch ran" must ask `gasRich && arms.amp > 0`, not `gasRich`. It is
also the honest reading of "a blue elliptical": a starburst spheroid is young because
it is forming, not because it grew arms.

---
## 2026-09-21 — One CDF, two inverses: table where the cost is amortised, bisection where it is free

The truncated delayed exponential's inverse has no closed form (it is a Lambert W), so
the CPU and the GPU have to solve it differently or one of them pays for the other's
convenience. Measured on the same machine: a 1025-entry inverse table costs 3.8 ms to
build and answers a draw with two array reads — 2.8 ms per 300k stars, rms 6.3e-4 Gyr
against a 60-step reference solve — while 14-step bisection on the analytic CDF costs
91 ms per 300k stars, half of the derive pass, on the age slider's hot path. In a
compute shader the trade inverts: a per-model table cannot ride in a uniform, the work
is one cell at a time, and 14 `exp` calls are free against the cell's other cost. So
`star-types.js` tables (keyed on `(tauSfh, sfhSpan)`, rebuilt only when the clock
moves) and `procedural-gen.wgsl` bisects, and the parity test holds the two to the
*table's* accuracy (0.05 Gyr absolute) on that branch while keeping its 2e-3 relative
check for the branch that is closed-form. The rule that kept them honest: the table is
built *from* the same `sfhCumulative` the shader bisects, so there is no second
distribution to drift, and the tolerance is documented at both ends.

---
## 2026-09-21 — Replacing a prior: calibrate against the numbers it reproduced, not against intuition

0.3.3 replaced the per-component age lognormals (halo 12 Gyr, bulge 10, thick 8, thin
5 — the Milky Way's ages at one epoch) with formation windows on the galaxy's clock,
because a 1 Gyr galaxy cannot honour a 12 Gyr halo prior. The windows could just as
easily have been guesses that looked right in a histogram; what kept them honest is
that the old priors had *measurements attached*: mean component ages and, through
them, the field's mean luminosity, which is what the exposure defaults were tuned on.
Fitting the four window pairs to reproduce those means at the reference epoch
(4.62/8.33/9.89/11.32 against 4.58/8.36/10.10/~12 Gyr, mean luminosity to 0.7%) is
what makes "the default sky does not move" a property instead of a hope — and it also
exposes which old numbers were never measurements: the halo "prior" is 34 stars in a
120k sample, so its mean is noise and the test that pins the windows gives it a
1 Gyr tolerance and says so. When a model change replaces a prior, list what the old
prior reproduced and re-measure exactly those things.

---
## 2026-09-21 — A more physical model that moves 99% of the light is not a small change

The obvious 0.3.3 improvement was the intermediate-mass white-dwarf channel: a giant
phase lasting ~10% of the main-sequence life and then a WD, so remnants accumulate
with age and the WD census becomes the age tracer the draft wanted. Measuring first
showed why it is 0.5 material: today every dead low-mass star is a giant *forever*,
and those giants carry 99% of the field's flux (110 of 111 L☉ per star), so giving
them a death moves the whole exposure model — the mean luminosity falls an order of
magnitude and every tuned default is wrong until someone with a browser re-tunes it.
The honest 0.3.3 statement is the one the model actually makes: remnants above 8 M☉
rise and saturate below 1 Gyr, and the monotone age tracer is the giant fraction
(0.09 → 1.75%, a factor 19). The test pins the saturating behaviour, the plan's
out-of-scope list says why, and neither pretends. "More physical" is a direction, not
a size; measure the flux it moves before promising it.

---
## 2026-09-21 — Decide "did the field move?" from what the sampler reads

The age slider rebuilds star properties but not positions, so `regenerate` wanted a
cheap verdict on whether re-sampling would change anything. The first version of that
verdict was `type === type && seed === seed`, which an override defeats silently:
`{ thin: { H: 0.4 } }` is the same type and seed and moves every star. The shipped one
packs the uniform's geometry groups — exactly the numbers `sampleGalaxyStars` reads
(masses, truncation, arms, centre, clumps, and the seed's low 16 bits in `armShape.w`)
— into two scratch buffers and compares, through the same `packGroup` the uniform
uses, so the test is the sampler's own input list rather than a proxy for it. The
subtle trap that survived review: the uniform carries only the seed's low 16 bits
while the field hashes all 32, so two seeds can pack identical geometry and still
derive different stars — the seed is compared whole, beside the packed key, with a
comment saying why. When caching anything keyed on "same inputs", enumerate the inputs
the consumer reads; a name-level comparison is a guess about that list.
## 2026-09-21 — `shaders.js` inventory splice must cut at the first `// Mirror parts`

`SHADER_PARTS` / `SHADERS` / `SHADER_MODULES` live at the *end* of `src/render/shaders.js`. A mid-file search-replace that only updates those names can leave the original export intact and append a second copy after leftover WGSL. The file then `require()`s the first export (missing `NEBULA_BILLBOARD`) while a grep of the source still finds the new names. Cut from the first `// Mirror parts` comment through EOF and rewrite a single ending; then `node -e "console.log(Object.keys(require('./src/render/shaders.js').SHADER_PARTS))"` before trusting tests.

The mock GPU does not execute WGSL, so a vertex-shader size cull cannot change `draw()` instance counts. Pin the floor in JS (`billboardVisible` / `billboardScreenPx`) and the WGSL constants in `wgsl-validate.js`; the renderer-test only sees the packed gas count.

---
## 2026-09-21 — `k = tan(pitch)` turns spiral arms into a fan of radial spokes

The arm modulation was implemented exactly as `plan.md` wrote it: `1 + A*cos(m*phi +
k*ln(R/Rs) + phase0)` with `k = tan(i)`. But the phase that winds at pitch `i` is
`m*phi - K*ln(R/Rs)` with `K = m/tan(i)` — a log spiral is `phi = ln(R/Rs)/tan(i)`, so
multiplying the phase by `m` puts `m/tan(i)` in front of the logarithm. With `K = tan(i)`
the pattern moves 0.2 rad over a whole e-fold in radius instead of 5 rad: the "arms" are
near-radial spokes, `pitchDeg` is not an angle the field has, and the field still *looks*
busy enough near the centre that nobody notices. A design doc is not a test — this survived
0.3.0 and 0.3.1 because every check round-tripped the same wrong formula. What caught it
was drawing the field: dividing the density grid by its own azimuthal mean per radius
(`scripts/viz-galaxy.py`, middle panel) turns a 15-25% ripple on an orders-of-magnitude
falloff into the whole picture, and the difference between 7 deg of winding and a pinwheel
is unmistakable at a glance. Two independent measurements now pin it — crest azimuth at two
neighbouring radii (winding) and consecutive crest radii along a ray (`e^(2*pi/K)`) — and
both recover the anchor pitch to 0.05 deg.

The same 1/sin(i) confusion hid in the young-ridge widths. `armRidgeWidth` was written as a
fraction of the *perpendicular* spacing `2*pi*R*sin(i)/m`, while the `distToArm` its gate
read was the *azimuthal arc* `R*dphi`, i.e. `1/sin(i)` = 4.8x larger for the preset: a lane
documented as "~0.3 kpc" was sampled up to 1.4 kpc wide, and the nebula reaches documented
as the 0.8 / 1.5 kpc they were tuned at were really 3.8 / 7.2 kpc. Every width must name the
distance it is a width *of*, and the code should compute that distance rather than an
adjacent one. `distanceToNearestArm` now returns the perpendicular distance — one division
by `hypot(m, K)` after wrapping the phase residual, no loop over the m branches, and the
same expression in WGSL — so the gate's z, the ridge fraction and the nebula reach all mean
what they say. Side effect worth knowing: the fix widened the sampled lane by 1/sin(i), so
the young fraction of the thin disc went from 2.3 % to 18 % (MW preset) with the O/B census
unchanged at 0.1 % — the gate now admits the documented 0.3 kpc lane instead of a 0.06 kpc
one, and the half-normal shape of the young branch is unchanged.

---

## 2026-09-21 — Validate a distance-to-ridge gate per star, never against one width

A gate `exp(-z^2/2)` with `z = distToArm / sigma(R)` looks like a half-normal, but a
*sample* of it is a mixture: sigma varies across the sampled annulus and the mixture has
far heavier tails than any of its members. Measuring Sa-Sd with one global sigma gave
median z 0.62-0.63 and P(z<2) = 0.89 against the ideal 0.674/0.955, which reads exactly
like a code bug and is not one. Computing z per star with that star's own sigma turns the
same sample into 0.664-0.673 / 0.952-0.957. Per-star z is also what makes the test strong:
a width hard-coded for the Milky Way misses by a factor `0.3 / sigma(R)`, which is
unmissable, while a histogram in kpc can hide it.

Two traps met while measuring it. `density.distanceToNearestArm` returned the *azimuthal
arc* `R*delta_phi` to the ridge line, not the perpendicular distance, so a width quoted as
a fraction of the perpendicular spiral wavelength `2*pi*R*sin(i)/m` was a fraction `1/sin(i)`
of the wavelength the gate actually sampled across — always say which distance a width
belongs to. (Superseded the same day: the function returns the perpendicular distance now,
and the wavenumber bug that made the two differ by more than a constant is the entry above.)
And do not sort a distance array and a radius array independently before
pairing them: `dists.sort()` with `rs[i]` silently paired each distance with another star's
radius and produced a convincing 4 % tail that the fixed code does not have.

---

## 2026-09-21 — The p-generalised-normal direction is *not* uniform on the Lp ball

"Draw z ~ N(0, I₂), normalise by the Lp norm, scale by sqrt(U)" is a popular recipe for a
uniform Lp disk, and it is wrong for every p except 2. Normalising by the *L2* norm is the
classic uniform-disk trick; the Lp version normalises the direction by a different measure
and the resulting point density is not flat (it over-concentrates near the axes as p grows).
Measured against a rejection reference in 12x12 bins, N = 2e5, reduced chi-square: 4.88
(p = 1.5), 1.007 (p = 2, the only one that passes), 2.68 (2.5), 4.81 (3), 9.91 (4), 17.71
(6). Run the prototype before trusting a one-line sampling trick: the Lp "spherical
symmetry" of the p-generalised normal is about its level sets, not about the measure the
ball inherits. The bar sampler instead marginalises the cross-section area analytically
(`4*Gamma(1+1/n)^2/Gamma(1+2/n)` per unit radius squared) and inverts a 1-D CDF along the
major axis, then places the cross-section point by slice marginal + inverse CDF.

---
## 2026-09-21 — A bounded profile has no tail, but it still has a truncation

When a sampler inverts a profile that ends on its own (the boxy bar ends at |xi| = 1), the
model's truncation cut still has to mean something: "delivered / untruncated" is only
consistent if the mass integral measures the *whole* body and the truncation fraction
measures the crop, rather than the integral shrinking to the cut and the fraction sitting at
1. The cropped mass is also not the same integral over a shorter interval: cutting a boxy
superellipsoid at level R changes the cross-section at *every* xi
(`tau_R(xi)^n = R^n - |xi|^n`), so the field's marginal, the mass integral and the sampler's
CDF all take the cut as a parameter. One weight function, three consumers: if the truncation
is expressed anywhere else, a `spheroidRadius` override silently breaks only one of them.

---
## 2026-09-21 — Work in the repo directory when the sandbox is repo-scoped

Not every Arena checkout keeps the whole workspace: in this one, files written under
`/home/user/...` outside the repository were gone by the next bash call, while files inside
the repository persisted (the repo is the overlay that travels between calls). Scratch
scripts and measurement harnesses therefore go in the repo root and are deleted before the
commit, not in `/tmp` or a sibling directory — where a heredoc + `node` can look like it
succeeded while the next call finds nothing.

---
## 2026-09-21 — Colour-index steps cannot walk off the classification LUT

Radial metallicity is a *colour* modifier, not a new class. `colorIndex + 1` on an M
star lands on WD (index 7) if the LUT is only the nine spectral classes. Clamp the
thin-disc shift at M. For "one step redder than RG", RG is already last: add a
dedicated `RGe` slot that `classifyByTempAndState` never returns. In WGSL, the
procedural generator's uniform is `densityParams`, not the cell `params` GenParams —
copying `params.populations` from the JS names compiles on neither side.

---
## 2026-09-21 — Parameterising a hard-coded model without moving one shipped number

### Freeze the old numbers as a preset, derive the rest, and let provenance decide the mode

`density.js` used to hard-code the Milky Way. The refactor that keeps the suite green is to
carry those constants into `src/math/galaxy.js` verbatim as `MILKY_WAY_STRUCTURE` (with the
`bulge` group renamed `spheroid` and `TRUNCATION.bulgeRadius` renamed
`truncation.spheroidRadius`), have the type→anchor table build every *other* galaxy, and let
`createGalaxy` decide `milkyWay` from **how** the model was built — `type === 'SBb'` with no
structural override — rather than from the type string alone. That single boolean then owns
the mode rule (catalog budget, landmark block, label layer, Sun orbit home), so no consumer
has to know what a "Milky Way" is. It also means an override like `{ thin: { L: 4 } }`
correctly stops the galaxy from claiming the real catalogue.

One trap: the preset's authored B/T is 0.182 where the anchor curve interpolates 0.15 at
T = 3. Resolving the curve "for consistency" would have re-tuned the shipped bulge. Preset
wins, curve is for the other types, and the divergence is documented in both places.

### Truncation belongs in the mass, not in a rejection loop

Sampling a truncated component by rejection hides a lie: the star counts no longer match the
density field. The fix is arithmetic, `density.truncationFractions()` (how much of each
component the box keeps, Sérsic branch via the enclosed-mass integral
`γ(3n, b_n·sMax^{1/n})/Γ(3n)`) multiplied by `density.componentMasses()` into
`sampling.deliveredMasses()`, which is what the sampler weights itself with and what
`galaxy-types-test.js` re-derives to 1e-12. Running the numbers also exposed a real bug:
`componentMasses` gave the halo 0.018096 where numeric integration says 0.021447 — the flat
core term was missing — and the halo's sampled share moved 0.00022 → 0.000265. Any closed
form in this repo is worth one numeric-integration check per release; that check is now in
`density-distribution-test.js`'s methodology family.

### A WGSL mirror that can no longer hard-code numbers needs the layout as data

`SHADER_PARTS['density']` used to be diffable against `density.js` because both held the same
literals. With parameters, `src/math/galaxy.js` owns one list — `DENSITY_PARAMS_LAYOUT` of
`{name, source, fields}` (ten `vec4f` groups, 40 f32, 160 B, `@group(0) @binding(5)`) — that
`packDensityParams(model, out)` walks, `wgsl-validate.js` diffs against the struct text, and
the compute pass binds. Division of labour that keeps this honest: the validator can pin
group names, order, size, the binding slot and "every group is read by a formula", and cannot
pin arithmetic — `wgsl-exec-check.js` executes and the model tests own the numbers. Two regex
gotchas cost an hour: WGSL writes `vec4f`, not `vec4<f32>`, so the optional group must be
`(?:<f32>|f)?`, and struct fields are camelCase (`spheroidShape`), so `[a-z_0-9]+` matches
nothing and the check passes vacuously. A parity test that greps must assert it found
*something*; assert the count of parsed fields equals the layout's before comparing them.

### Multi-site text patches: assert first, edit bottom-up, and match the file's indentation

Six files needed the same insertion pattern (`require('../src/math/galaxy.js')` after the last
require, a `const model = …` line, replaced call signatures). What failed and what did not:

- The repo mixes indentation: `src/**` except `shaders.js`/`star-sprites.js` is one tab,
  those two are 4 spaces, `main.js`'s block bodies are 8-space continuation, `index.html` is
  spaces. A patch written from what another file looks like silently misses. `sed -n 'a,bp'`
  (or `cat -A` for tabs) the target block *before* writing the pattern.
- Write the script as: every `assert old in s` first, then every write. A patch that fails on
  edit 4 of 7 after writing 1–3 leaves the file half-migrated, and the rerun then fails on
  edit 1 for the wrong reason.
- When editing a markdown plan by line ranges, splice strictly bottom-up — a splice at line
  98 shifts the range you computed for line 65, and the insert lands inside the block you
  just rewrote. `git checkout -- file` and redo in one descending pass.

### A stateful renderer mock has order dependencies that look like product bugs

`renderer-test.js` grew a mode-rule section and it broke on three things that were all the
test's fault, not the code's: `state.drawn` is written inside `render()`, so asserting it
right after `regenerate()` reads the previous frame; an earlier section parks the camera
outside the catalog volume, so any residency check must come before that; and the fixed
block's frame time and the "no re-upload while parked" check both count renders, so a new
section that calls `render()` has to sit after them with its own monotonic timestamps (3/60,
4/60). Two more from `landmark-test.js` and `cell-manager.js`: a mock that counts `clearRect`
needs a `reset()` before a "does nothing" check, because the previous section already left a
count of 1; and `cell-manager.update()` early-returns unless the camera moved or 0.25 s
passed — except a fresh manager starts at `sinceUpdate = Infinity`, so its first update always
rebuilds. `state.clampedProcedural` also had to reset in `prepare()` rather than survive a
regeneration, which the mode test caught.

### A menu with real form fields needs a key guard; a deliberate rebuild stays synchronous

Adding `<select>`/`<input>` for galaxy type and seed to a page whose keys are global makes
digits and `g` flight controls while typing. `input.js` now ignores every key except `Tab`
while an `INPUT`/`SELECT`/`TEXTAREA` has focus. And regeneration measured 0.8 s at 300k (0.6 s
of sampling, 0.2 s of deriving records), which is a deliberate-action cost, not a frame cost:
synchronous, so there is no half-swapped renderer state to hide behind a progress bar.


## 2026-09-19 — Two hand-maintained export lists always drift: expose one API object

Every module had two export literals, one for Node (`module.exports = { ... }`) and one for the page (`window.X = { ... }`). They drifted, and the drift was invisible from Node: the renderer called `StarRecord.writeRecord`, which existed only in the Node export, so the browser would have thrown on the first frame (`prepare()` writes procedural records at boot). Node tests were green the whole time.

The rule is now: build one object, hand the *same object* to both environments.

```js
const StarRecord = { RECORD_BYTES, writeRecord, readRecord, /* ... */ };
if (typeof module !== 'undefined') module.exports = StarRecord;
if (typeof window !== 'undefined') window.StarRecord = StarRecord;
```

`experiments/export-parity-test.js` walks every module, loads it with a fake `window`, and asserts the two surfaces are the same object with the same keys and values. This generalises: any duplicated list that a machine could have derived is a bug waiting for a release.

## 2026-09-19 — A truncation applied by the sampler is part of the model, not a sampler detail

The Plummer bulge has a heavy tail: with `r0 = 1 kpc`, `s = r_e / r0` up to 6 still carries ~4% of the analytic mass. The sampler cut at `s = 6`, but `density.js` did not, so at 12 kpc above the plane the untruncated bulge tail (~7e-9) outweighed the halo (1.9e-7 vs ...) in `dominantComponent`, and nebula placement treated the halo as bulge-dominated.

Rule: decide *one* truncation per component, put it inside the density functions, mirror it in WGSL, and let the sampler draw inside those bounds. Any derived quantity that weights by density — dominant component, nebula probability, thinning, the exposure histogram — then agrees with the stars that are actually placed. `sampling.js` reports the fractions the truncation removes so the expected component shares have a closed form.

## 2026-09-19 — Keep the shaders where Node can read them: JS strings, not .wgsl files or text/x-wgsl blocks

WGSL cannot be compiled here, so the only defence against the mirror drifting is a test that diffs it against the JS model. That test can only run if the shader text is reachable from Node. Two earlier arrangements failed: `.wgsl` files plus a copy inlined in `index.html` (two copies, both hand-maintained, and they had already diverged — the validator could only marker-check one of them), and `document.getElementById(...).textContent` at boot (unreachable from Node, and one more thing to get wrong in the page).

Now `src/render/shaders.js` holds the shader parts as template strings, concatenated into complete modules, and `wgsl-validate.js` compares constants, function names and structural markers against `src/math/*.js`. Every module is validated, wired or not; `SHADER_MODULES` names the five the project ships, and the renderer compiles four of them.

## 2026-09-19 — One bundle file beats one file per cell, even with base64

The first catalog layout was one `.js` file per cell (2045 cells for a 3,829-star subset): 1170 files, 4.7 MB on disk, 44 bytes of file for every 16-byte star, and one `<script>` tag per cell at load time. The user's verdict — "multiple small tiles js is not good" — was right for reasons that also show up in the numbers: filesystem overhead, 2045 parse events, and a directory tree that grows with the catalog.

One bundle (`window.__galaxy_catalog`) with base64 payloads is 164.6 KB for the same catalog, 44 bytes per star *including* base64 and JSON, and exactly one script injection. Base64 costs 33% over raw bytes and buys a file that is still plain JS, still `file://`-loadable, and still `require()`-able in Node tests. The band table travels *in* the asset (cell size + streaming radius per band), so retuning streaming is an encoder run, not a code edit.

## 2026-09-19 — Test WebGPU modules against a stub device

There is no browser here, and `star-sprites.js` is mostly GPU bookkeeping — which is exactly the part that breaks. `experiments/renderer-test.js` builds a fake `GPUDevice` that records everything (`createBuffer`, `createPipeline`, `queue.writeBuffer`, `beginRenderPass`, `draw`) and returns plausible objects. With it the tests can assert real invariants: the storage buffer is sized `(procedural + catalogCapacity) x 16`, the procedural field is uploaded once at offset 0, the catalog is uploaded only when the resident set changes, `draw(4, instances)` matches the residency, and the 28-float uniform carries the camera's view-projection.

Two traps: uniforms are `Float32Array`, so compare against `Math.fround(value)` (a literal `2.2` never equals the stored value); and the mock must rethrow nothing — a stub that silently swallows a bad argument hides the bug it was written to catch.

## 2026-09-19 — WebGPU clip space is z in [0, 1]; an OpenGL projection clips half the scene

The projection matrix had the OpenGL depth convention: `(near+far)/(near-far)` and `2*near*far/(near-far)`, which maps the near plane to z = -1. WebGPU wants `far/(near-far)` and `near*far/(near-far)`, mapping near to z = 0. The symptom is subtle — everything still renders, but anything closer than the effective zero crossing (a few parsecs, given `near = 0.001 kpc`, `far = 2000 kpc`) gets clipped, and depth precision near the camera is wrong. `camera-test.js` now asserts the depth range and the near/far endpoints.

## 2026-09-19 — Nearest-first residency needs an exact order, not a distance bucket

The first cell-manager sorted candidates by counting them into 64 squared-distance shells. The shells span the whole candidate range, so near the Sun the first shell covered everything within ~1.5 kpc and the "nearest" cells were really "whichever cells came first in the bundle". A tight-budget test against a brute-force fill caught it: 192 stars in 48 cells versus 198 stars in 71 cells.

Fix: sort in place by `(distanceSq, cellIndex)` with `Float64` distances — exact, no allocation per comparison, and cheap at the cadence a rebuild actually runs (a few times per second). Keep the ordered fill, not the bucket: the budget is star-denominated, so the very first cell that does not fit is exactly where the selection should stop.

## 2026-09-19 — Decode base64 into the destination buffer

Per-cell base64 decode used to allocate a `Uint8Array` per cell, only for the caller to copy it into the staging buffer. `decodeBase64Into(str, out, byteOffset)` walks the characters with `atob` (or `Buffer.from(str, 'base64')` in Node) and writes straight into the destination; `decodeBase64` remains as a thin wrapper with exact padding from the `=` count. The streaming test monkey-patches `decodeCell` to count calls, proving that a re-upload of an unchanged residency set does not decode anything at all.

## 2026-09-19 — file:// fetch is blocked; use dynamic `<script>` injection for binary data

Chrome and Edge block `fetch()` of local files under `file://` (CORS policy). Firefox allows it only with `security.fileuri.strict_origin_policy=false`. The portable workaround is to emit binary assets as `.js` files that assign a `Uint8Array` to a global slot:

```js
window.__tile_near_0_1_2 = new Uint8Array([0x12, 0x34, /* ... */]);
if (typeof module !== 'undefined') module.exports = window.__tile_near_0_1_2;
```

Load by injecting `<script src="...">` at runtime, reading the global, then deleting the property and removing the script tag. Works in all major browsers under `file://`.

## 2026-09-19 — f32 precision collapses at galactic distances; use split-double

Raw `f32` has ~7 decimal digits. At 100 kpc the precision is ~10 m, which is fine for star rendering, but for the camera-position offset calculation it produces visible jitter during slow fly-through. Solution: store star positions as `(positionHigh: vec3<f32>, positionLow: vec3<f32>)` where `positionHigh` is the rounded value and `positionLow` is the residual. The vertex shader reconstructs: `relativeHigh = positionHigh - cameraHigh; relativeLow = positionLow - cameraLow; final = relativeHigh + relativeLow`.

Test with `experiments/precision-test.js` before assuming any given distance is safe.

## 2026-09-19 — PCG hash is the recommended GPU hash; validate with chi-square

Nathan Reed's *Hash Functions for GPU Rendering* (reedbeta.com) recommends PCG (Permuted Congruential Generator) over Wang hash for statistical quality. Wang hash is faster but shows subtle banding when used for stratified sampling at scale.

Always validate any hash function with `experiments/hash-test.js` before shipping. A bad hash produces visible grid-like patterns in procedural star distributions at large radii.

## 2026-09-19 — Gaia DR3 is not a uniform sample of the Milky Way

The catalog is "essentially complete between G=12 and G=17" with "an ill-defined faint magnitude limit which depends on celestial position" (dc.g-vo.org). At 100 pc the coolest stars become too faint; useful sampling reaches ~3 kpc for bright tracers. A naive Gaia download produces an over-dense solar neighbourhood with empty galaxy elsewhere. The fix is to (a) apply magnitude cuts that align with global completeness, and (b) decimate the solar neighbourhood stochastically to match the density the rest of the catalog shows. The *density model* (not the catalog) defines the truth.

## 2026-09-19 — Magnitude-band completeness is required, not a single radial function

A catalog can be complete for bright stars at a given distance while being incomplete for faint stars at the same distance. Tracking completeness as a single radial function conflates these. Track per magnitude band (0–4, 4–8, 8–12, 12–16, 16+) and generate procedural stars only for the missing portion of each band. This prevents over-population in regions where the catalog already covers the faint end.

## 2026-09-19 — Elite Dangerous "Stellar Forge" is the direct precedent

Frontier Developments built a 1:1 scale Milky Way with ~400 billion star systems. They seeded it with ~160k real Hipparcos stars (the "remarkable" stars) and procedurally generated the rest using physics-based rules (stellar IMF, metallicity gradients, age distributions). The galaxy is not stored; it is regenerated deterministically from a seed on demand. This is exactly the hybrid pattern used here.

Sources: polygon.com, ctrl500.com, perthobservatory.com.au, frontier forums.

## 2026-09-19 — Implementation order: catalog + renderer first, procedural last

A common mistake is to start with procedural galaxy generation. The correct order is:

1. Camera-relative coordinates and packed GPU star buffer.
2. Point-sprite renderer with hard-coded test stars.
3. Catalog tile loading and streaming.
4. GPU frustum culling and indirect draw.
5. Stable hash thinning.
6. Real catalog filtering.
7. *Only now* add procedural generation, plugging into the existing compute-cull-render pipeline as another data source.

If procedural generation is built first, the renderer becomes coupled to it and the catalog integration becomes painful.

## 2026-09-19 — Three render paths (not one) for LOD

A single sprite path is insufficient at galactic scale. Beyond ~5 kpc, individual stars occupy less than a pixel and waste GPU work. The renderer needs three paths used simultaneously:

- **Path A**: bright/nearby billboard sprites with full detail.
- **Path B**: distant point sprites, cheap, mostly unlabelled.
- **Path C**: unresolved density cells, additive screen-space quads tinted by integrated density.

A single frame may use all three. Path C is what makes the galactic bulge and spiral arms glow correctly when far away.

## 2026-09-19 — NGC and named stars are landmarks, not data

The catalog of "remarkable stars" (Pleiades, Orion nebula, Sirius, Betelgeuse, etc.) functions as landmarks the user recognises. They bypass density thinning. Their purpose is recognisability, not completeness. A whitelist of a few hundred to a few thousand landmark stars is sufficient; do not try to ship a complete NGC.

## 2026-09-19 — Density-preserving count scaling: density is the truth, count is a budget

The user requirement is that 10k and 1M stars both render with correct density. The strategy:

1. The density field defines relative density everywhere. It is the truth.
2. The target star count `T` is a runtime budget.
3. A global scaling factor `s = T / Λ_total` multiplies every cell's expected count.
4. At low budgets, individual cells may produce zero stars; the spatial distribution remains correct because the rejection sampler preserves relative probability.

This works because the procedural generator samples *from* the density field, not from a stored list. The count is a sampling rate, not a population size.

## 2026-09-19 — Component sampling: sample by relative density, don't pick max

Initial approach used `dominantComponent(x,y,z)` which picks the highest density at a point. This was wrong: at the galactic centre, thin disc density (1.0) exceeds bulge density (0.65), so even stars physically near the bulge got classified as 'thin'. Bulge share came out 0%.

Fix: `sampleComponent(decomposed, u)` — sample component probabilistically by relative density contribution. A star near the centre is 55% thin / 35% bulge / 10% thick / 0% halo; we sample which population it actually came from using a uniform random `u`. Result: bulge share rises to physically-correct values; halo share becomes non-zero.

## 2026-09-19 — Box size matters for component ratios

A large sampling box (e.g. 30×30×10 kpc covering R from 0 to 22 kpc) produces unintuitive ratios: thin 33%, thick 67%. This is actually correct — at R > 12 kpc the thick disc's longer scale length wins over thin disc. For inner-galaxy ratios (where thin dominates), use a smaller box centred on the galaxy (e.g. [-15,-1] × [-7,7]).

## 2026-09-19 — Mass-Teff formula breaks at low masses

The textbook formula `Teff = (L/R²)^0.25 * 5772 K` with `R = M^0.8, L = M^2.3` gives wrong temperatures for very low and very high masses:
- M = 0.08 → Teff = 3977 K (classified K, should be M dwarf at 2400 K)
- M = 100 → Teff too high

Fix: use a tabulated mass-Teff relation (18-point table, log-log interpolated). Now M dwarfs (0.08-0.45 M_sun) correctly map to 2400-3800 K, and O stars (>16 M_sun) to 30000+ K. Result: 87% M, 9% K, 0.8% G, 0.01% B — matches observed IMF.

## 2026-09-19 — Spiral arm modulation needs sqrt-scaled visualization to be visible

±20% arm modulation is invisible in log10 density plots — it's only ±0.08 in log space, drowned by the bulge dominance. Use `sqrt(density)` with capped range (0 to 0.8) to bring out the arm contrast. Overlaying the analytical arm curves (cyan lines) as a guide helps verify the modulation aligns with the math.

## 2026-09-19 — HII regions 100% in arms, planetary nebulae need separate probability

Gas-driven nebulae (HII, reflection, dark) must be suppressed in bulge/halo (no cold gas there). But planetary nebulae are stellar-evolution driven, not gas-driven — they should be more common in old populations like the bulge. Use two separate probability terms: `pGas` (cold-gas-dependent) and `pStellar` (population-driven, boosted in bulge). Sum them. Result: HII regions 100% in arms, planetary nebulae concentrated in bulge.

## 2026-09-19 — B stars are 100% in arms, K/M only 5% — physics validated

Star-types-evolution test confirms placement works:
- B stars: 100% within 0.5 kpc of an arm (only formed recently, haven't diffused)
- A stars: 50% near arms (300 Myr lifetime, partially diffused)
- G/K/M stars: 5% near arms (old enough to be uniformly distributed)
- Red giants: 3.8% near arms (progenitors were low-mass, old)
- Mean ages: halo 11.78 > bulge 10.33 > thick 8.40 > thin 5.40 Gyr
- Metallicities: halo 0.001 < thick 0.008 < thin 0.020 < bulge 0.035

This pattern matches observed Milky Way stellar populations. The procedural generator is placing stars at evolutionarily-correct positions.

## 2026-09-19 — PCG hash validated: chi-square 243.83 (df=255), serial r=-0.0039, no period repeats in 1M

PCG hash passes all 4 quality tests:
- Chi-square on 1M samples / 256 buckets: 243.83 (pass <293 at 5% significance, <310 at 1%)
- Serial correlation between hash(i) and hash(i+1): -0.0039 (pass |r|<0.01)
- 2D spectral max/min ratio: 1.60 (pass <2.5, no lattice patterns)
- Period: no repeats in first 1M inputs

Wang hash also passes chi-square (242.23) and spectral (1.55), so it remains a valid faster fallback for older GPUs. Use PCG as default.

## 2026-09-19 — f32 is sufficient for star positions up to 100 kpc; split-double unnecessary

Measured f32 max error in position reconstruction:
- 1 kpc: 0.0000 pc
- 8 kpc (Sun to GC): 0.0005 pc
- 20 kpc (far disc): 0.0010 pc
- 100 kpc (halo): 0.0049 pc

All well below the 0.5 pc acceptable threshold. Split-double would give 1e6x improvement but is unnecessary for star rendering. Reserve split-double for camera-position offset computation only if fly-through jitter appears at >50 kpc from origin (deferred tuning T-speculative in plan.md §14a).

## 2026-09-19 — Packed 16-byte StarPacked struct: 1M stars = 19.2 MB, 5M = 95.5 MB, 20M = 381.6 MB

Round-trip fidelity:
- Position max error: 6.8e-7 kpc (f32 rounding, negligible)
- Magnitude quantum: 0.078 mag (256 steps over 0-20 mag range)
- colorIndex, flags, subCellJitter: preserved exactly (8 bits each)

This means 1M catalog stars + 5M procedural stars fits comfortably in ~115 MB. The 256 MB target budget supports 16.7M packed stars (vs 8.4M naive 32-byte).

## 2026-09-19 — Hash thinning is deterministic and matches target probability within 1%

Test result: 100k stars, target p=0.30, actual fraction kept = 0.2976. Deterministic across reruns (same star IDs always kept/removed at same LOD). Screen-space thinning preserves the highest-priority star in 100% of tested cells.

The thinning formula `keep if hash(starId, tileId, lodLevel) < p` works as designed. No popping between frames because the hash is stable.

## 2026-09-19 — WGSL mirrors JS via validator contract

The `experiments/lib/*.js` files are the source of truth (testable in Node). The `src/render/wgsl/*.wgsl` files are mirrors (testable only by running WebGPU). The contract between them is enforced by `experiments/wgsl-validate.js`:

- PCG hash constants (0x7feb352d, 0x846ca68b, etc.) must match between JS and WGSL
- Density model constants (GALACTIC_R0, THIN_L, etc.) must match
- 18-entry mass-Teff table must match in both directions
- Spectral class thresholds (30000, 10000, 7500, 6000, 5200, 3700 K) must match
- StarPacked struct must be 16 bytes (3×f32 + 1×u32)
- WGSL syntax sanity (balanced braces/parens, @compute + @workgroup_size on entry points)

Tuning methodology: change the constant in JS, run the validator, fix any drift in WGSL. Never tune constants directly in WGSL — JS is the source of truth.

## 2026-09-19 — Source of truth refactor: src/math/ replaces experiments/lib/

Moved experiments/lib/{hash,density,sampling,star-types,nebula}.js to src/math/. These files were already browser+node compatible (guard `module.exports` AND `window.X`), so the move eliminated duplication with no functional changes.

Now the contract is: `src/math/*.js` is the source of truth. `src/render/wgsl/*.wgsl` mirrors it. `experiments/wgsl-validate.js` enforces the contract. Experiments require from `../src/math/`. Runtime loads via classic `<script>` tags in `index.html`.

This means any test that runs in Node tests the actual code that runs in the browser. No more "lib vs src" drift.

## 2026-09-19 — WGSL embed pattern: <script type="text/x-wgsl"> blocks in index.html

For file:// compatibility, WGSL shaders are embedded as `<script type="text/x-wgsl" id="shader-name">` blocks in `src/index.html`, and read at runtime via `document.getElementById('shader-name').textContent`. This avoids `fetch()` which Chrome/Edge block under file://.

The `.wgsl` files in `src/render/wgsl/` remain as source of truth (for editing and documentation). The embedded version strips comment headers but must contain the same key markers (structs, entry points, functions). `wgsl-validate.js` test 6 enforces this — it checks for the presence of struct/function names rather than byte-for-byte equality, so indentation differences don't cause false negatives.

## 2026-09-19 — Camera uniform layout: 96 bytes, mat4x4 viewProj + vec4 cameraPos + time + size + pad

Layout (96 bytes total):
- bytes 0-63: viewProj mat4x4 (column-major for WGSL)
- bytes 64-79: cameraPos vec4 (xyz + pad)
- bytes 80-83: time f32
- bytes 84-87: starSizePx f32
- bytes 88-95: pad vec2

Built once per frame in `camera.buildViewProj()` into a preallocated Float32Array(16), copied into a preallocated ArrayBuffer, uploaded via `device.queue.writeBuffer`. Zero per-frame allocations.

## 2026-09-19 — Loop stats: rolling 60-frame history, no per-frame allocation

`src/core/loop.js` keeps FPS, frame ms, avg, and max in a single stats object mutated in place. A `Float32Array(60)` rolling history buffer tracks the last 60 frame times for avg/max. The buffer is allocated once at loop creation and indexed by `historyIdx = (historyIdx + 1) % 60` per frame. No array creation, no GC pressure.

## 2026-09-19 — Color LUT 1x256 texture: index 0-8 = O,B,A,F,G,K,M,WD,RG

`src/render/star-distant.js` builds a 1x256 rgba8 texture at startup, with the first 9 entries mapping to spectral classes (rest default to G). The WGSL shader samples via `textureLoad(colorLUT, vec2i(i32(colorIndex), 0), 0)`. This avoids storing 3 bytes of RGB per star — only 1 byte (colorIndex) is stored in StarPacked.packed.

For 1M stars, this saves 2 MB of GPU memory vs storing RGB directly. The LUT itself is 1 KB.

## 2026-09-19 — Coordinate convention bug: density.js had GC at -8.178, should be +8.178

Bug: `density.js` set `GALACTIC_CENTRE = { x: -8.178, y: 0, z: 0 }`. This was inconsistent with the plan §3 convention: "X: toward Galactic longitude 0° (galactic centre direction)". If X points toward l=0, the GC is at +8.178 on the X axis, not -8.178.

Caught by: `tile-encoder-smoke-test.js` test 1 (coordinate conversion). The encoder converts RA/Dec/parallax to galactic XYZ using the standard IAU 1958 transformation, which gives x ≈ +8.2 kpc for the GC direction (RA=266.4051°, Dec=-28.9362°, parallax=0.122 mas). The test initially expected x ≈ -8 kpc (matching the buggy density.js) and failed.

Fix: `GALACTIC_CENTRE = { x: 8.178, y: 0, z: 0 }` in density.js. Updated viz-galaxy.py GC marker to match.

Lesson: the validation contract between density.js (source of truth) and the analytical model the user expects (RA/Dec→XYZ) was being silently violated. The tile-encoder smoke test surfaced it because it tests the conversion path end-to-end. Tests with mock data that's *generated by the same density model* cannot catch this — they're circular.

## 2026-09-19 — WebGPU has no gl_PointSize — use instanced billboard quads

Original Milestone 1 used `point-list` topology with `pass.draw(N, 1, 0, 0)`. This renders each star as a 1x1 pixel point — invisible at typical densities. WebGPU has no `gl_PointSize` equivalent in the vertex shader.

Fix: switch to `triangle-strip` topology with instanced billboards. Each star is a 4-vertex quad, drawn as instance 0..N-1. The vertex shader uses `@builtin(vertex_index)` (0..3) as the corner of the quad, and `@builtin(instance_index)` as the star index into the storage buffer.

Pipeline: `pass.draw(4, TEST_N, 0, 0)` — 4 vertices per star, TEST_N instances.

## 2026-09-19 — Camera right/up vector sign bug

Original `camera.js` `updateForward()` had `right = (-sin(yaw), cos(yaw), 0)` and `up = (cos(yaw)·sin(pitch), sin(yaw)·sin(pitch), -cos(pitch))` — both inverted.

Correct via `cross(forward, worldUp=(0,0,1))`:
- forward = (cos(yaw)·cos(pitch), sin(yaw)·cos(pitch), sin(pitch))
- cross(forward, (0,0,1)) = (forward.y·1 - forward.z·0, forward.z·0 - forward.x·1, 0) = (forward.y, -forward.x, 0)
- normalised: (sin(yaw), -cos(yaw), 0) (when pitch≠±π/2)

So right = (sin(yaw), -cos(yaw), 0) — opposite of what I had. Same for up.

This bug only affected input translation (WASD); the actual view matrix in `buildViewProj` recomputes right via cross product, so the render would have been correct but A/D would be inverted.

Caught by: extended `m1-smoke-test.js` with orthonormality checks (forward·right=0, forward·up=0, right·up=0) plus specific value checks at yaw=0,pitch=0 (forward=+X, right=-Y, up=+Z).

## 2026-09-19 — Camera uniform layout grew to 128 bytes for billboard right/up

Original 96-byte uniform (viewProj + cameraPos + time + size) was insufficient when the star shader needs to billboard. Added `cameraRight: vec4f` and `cameraUp: vec4f` for world-space camera basis vectors.

Layout (128 bytes):
- bytes 0-63: viewProj mat4x4
- bytes 64-79: cameraPos vec4
- bytes 80-95: cameraRight vec4
- bytes 96-111: cameraUp vec4
- bytes 112-115: time f32
- bytes 116-119: starSizePx f32
- bytes 120-127: pad

In the current shader we compute the corner offset in clip space (simpler) so we don't actually use cameraRight/cameraUp yet — they're reserved for future world-space billboarding (e.g. for Path A bright-star sprites with non-uniform scaling).

## 2026-09-20 — Orbit and fly share one yaw/pitch pair; the orbit position is derived

The first 0.1.1 plan gave orbit mode its own `orbitYaw/orbitPitch` (the direction from target to camera) and converted on every mode switch. Dropping that and keeping a single pair that always means "where the camera looks" removed the conversion, the second set of clamps and a sign table: `position = target − distance · forward`. Entering orbit snaps the *angles* (`yaw = atan2`, `pitch = asin`) so the position is reproduced exactly and the camera only turns; leaving orbit changes nothing. Mouse look is the same code in both modes and comes out as the standard "grab the world" drag (three.js OrbitControls, Google Earth). Keys deliberately keep "move the camera" semantics (D goes right, E goes up), which is the opposite sign from the mouse and is also what Google Earth does.

Sign check for tests: from the Sun looking +X, screen-right is −Y, so "the camera swings left" means position.y > 0. Two tests were first written with the opposite expectation; the code was right.

## 2026-09-20 — Wheel: accumulate to whole notches, never round a frame's delta

`round(wheelDelta / 100)` per frame makes trackpads inert: their 3–10 px events round to zero and were then discarded. Keep a persistent accumulator in the consumer, take `trunc(acc / 100)` notches, leave the remainder. `input.js` folds `deltaMode` lines/pages to pixels first (`[1, 100/3, 100]`; `3 × (100/3)` is exactly 100 in f64) so one mouse notch is 100 in Chrome and Firefox alike.

Corollary: a value that walks a ×2 grid needs power-of-two clamps. Clamped at 0.02 the multiplier sits on 0.02·2ⁿ forever and never reads x1 again; clamped at 1/64 and 256 it does.

## 2026-09-20 — Place the camera along the f64 basis; the f32 basis is for the GPU

`forward/right/up` are Float32Arrays because the renderer reads them. Using them to place an 8 kpc orbit put the camera ~0.5 mpc (100 AU) off the sphere and made "entering orbit keeps the position" fail at 6e-8 kpc. The camera now keeps `forwardExact/rightExact` in f64 for integration and placement and copies them into the f32 outputs. Same lesson as camera-relative rendering: precision lives on the CPU in f64; f32 is an output format.

## 2026-09-20 — Test the page's loading model, not just the modules: one vm context for all scripts

`require()` gives each file its own scope, so it cannot see the one failure classic `<script>` tags add: two files declaring the same top-level `const` throw `SyntaxError: Identifier has already been declared` when the second loads, and a namespace read at load time must find an earlier script's export. `m1-smoke-test.js` now evaluates every script in `index.html` order inside one `vm` context with a fake `window`; a mutation test (appending `const GALACTIC_CENTRE = 1` to `loop.js`) fails it as intended. Practical rule: top-level names in `src/**/*.js` form one namespace — check before adding one (`density.js` owns `GALACTIC_CENTRE`, `shaders.js` owns `DENSITY`, `CULL`, …).

## 2026-09-20 — Keyboard traps: Ctrl as a modifier, key repeat on toggles

The DOM codes are `ControlLeft/ControlRight` (not `CtrlLeft`). With Ctrl as the slow modifier: Ctrl+W closes the tab on Windows/Linux and no page can prevent it (reserved shortcut); Ctrl+R (reload) and Ctrl+H (history) *can* be prevented, so every mapped key calls `preventDefault()`. The arrow keys are the safe way to fly slowly — say so in the help text. One-shot actions (`C`, `H`, `R`) must ignore `e.repeat` or a held key cycles camera modes at ~30 Hz; accumulating actions (`[ ]` exposure) should `+=` so repeat is one more step and two repeats in one frame are two steps.

## 2026-09-20 — Named stars are a third, fixed block in the star buffer

Gaia saturates on exactly the stars worth labelling, so the catalog subset cannot be assumed to contain them. Landmarks live in their own block between the procedural field and the catalog region — `[procedural][landmarks][catalog]` — uploaded once with `FLAG_VISIBLE | FLAG_LANDMARK`, which keeps the drawn instance range contiguous (`draw(4, procedural + landmarks + resident)`) and keeps them drawable with zero catalog resident. Positions/magnitudes are baked at load in `data/landmarks.js` through `src/math/coords.js`, the same RA/Dec/parallax → XYZ conversion the tile encoder now uses (it moved there from the encoder so the two datasets share one frame; the Sirius/galactic-centre self-tests stayed with the encoder).

## 2026-09-20 — The label canvas must project exactly like the vertex shader

Labels that trail or sit beside their stars are worse than no labels. The 2D layer therefore uses the same math as the sprite shader: `rel = world − cameraPos`, `clip = viewProj · rel`, cull on `clip.w <= 0`, and NDC → pixels with the y flip (`screenY = height · (0.5 − ndcY/2)`; clip +y is up, screen y grows down). It redraws every frame (the overlay's 4 Hz cadence visibly lags), draws in CSS pixels under a `setTransform(dpr, …)` so labels and click picking (CSS pixels) agree with the device-pixel GPU canvas, and preallocates the screen/visibility arrays — ~60 `fillText` calls with constant strings allocate nothing.

## 2026-09-20 — Picking under pointer lock: client coordinates are frozen

Once the pointer is locked, `clientX/offsetX` stay at the lock point, so a "click" there would always pick the same screen corner. When locked, the pick point is the canvas centre — where the camera aims. A pick is a mouse-up within 4 px of mouse-down; anything farther is drag-look. `pick()` returns a landmark index or −1 and never mutates the camera: main.js wires a hit to `camera.setOrbitTarget`, and `R` clears the selection together with the orbit target so the two cannot disagree.

## 2026-09-20 — Two-pass HDR: accumulate linear, tone-map once

The original star sprite shader applied `flux / (1 + flux)` Reinhard per star in the vertex shader, then additive-blended the post-tonemap values into the swapchain. The result was that dense regions (bulge, arms) clipped to white with no highlight structure: each star had already saturated itself to < 1.0, so the sum across N stars could not exceed ~1.0 even though the scene clearly should be brighter there.

The fix is the standard filmic pipeline: (1) drop the per-star tonemap, emit raw linear flux `pow(10, -0.4·(m_app − magZero))`; (2) render sprites additively into an `rgba16float` intermediate (blendable per WebGPU core spec, no feature negotiation); (3) fullscreen-triangle pass samples the HDR texture, applies ACES Narkowicz `x·(2.51x+0.03)/(x·(2.43x+0.59)+0.14)`, writes the LDR pixel to the swapchain with `alpha = 1` and no blend state.

ACES over extended Reinhard: the filmic S-curve compresses dense star clusters gracefully and preserves red-giant hue into the highlights. Reinhard with a finite white point tends to "block up" near the white point — flat pastel whites.

Two exposure knobs: `magZero` ([ / ]) controls the magnitude → flux conversion (input dynamic range), `uExposure` (; / ') is a linear multiplier before ACES (output brightness). ACES has no explicit white point so uExposure is the only output knob. Default 1.0, range 0.125 → 8.0 (6 stops) in half-stop steps.

Star size tightened in the same change: `BASE_SIZE_PX` 2.2 → 1.5, magnitude clamp `clamp(1 − 0.4·Δmag, 0.4, 2.0)`, falloff `(1−r²)²` → `(1−r²)³`. The visible disc shrinks from a soft blob to a small bright core with a faint wing — point sources at HD/4K should look like points, not discs.

The HDR texture is recreated on canvas resize; the bind group is rebuilt then because the texture view changes. The tonemap uniform is uploaded every frame alongside the camera uniform. The renderer-test.js mock GPU was extended to record per-pass draws and the HDR texture so the two-pass submission is checkable from Node.

Tests: `hdr-test.js` for the curve (f(0)=0, f(1)≈0.8, f(16.3)≈1.0, monotonic, bounded, the brightness-gain property: five overlapping stars sum linearly and still roll off below 1.0); `wgsl-validate.js` extended for the new `tonemap` shader part and the two wired shaders; `renderer-test.js` extended for the two-pass submission (star-sprites + tonemap), the HDR texture format and size, the per-pass clear values, the linear exposure uniform and the resize-recreates-texture path.

### wgsl_reflect can execute the shipping WGSL in Node (2026-09-21)

There is no browser in the sandbox, and `wgsl-validate.js` only reads shader text — the
one claim the HDR frame rests on (a sprite emits linear flux; N overlapping sprites
tonemap brighter than one) was unverifiable. `npm install wgsl_reflect` brings
`WgslReflect` (parse) and `WgslDebug` (interpret `vs_main`/`fs_main` with real
bindings). `experiments/wgsl-exec-check.js` runs the actual `src/render/shaders.js`
strings: `debugVertex({vertex_index, instance_index}, binds)` returns the `VertexOut`
fields by name (`brightness`, `color`), `debugFragment` takes inter-stage inputs by
location index (`{0: uv, 1: color, 2: brightness}`) plus `@builtin(position)` as
`{position: [x, y, z, w]}`, and bindings are `{0: {0: {uniform: ArrayBuffer}, 1: <buffer>,
2: {texture: Uint8Array, descriptor: {size, format}}}}`. Texture formats the
interpreter understands include `rgba8unorm` and `rgba32float` (float bytes as
`Uint8Array` views over the float buffer). Dev-only dependency, so it is not in
`all-tests` — run `python3 scripts/run.py wgsl-exec`. The JS model of the tonemap pass
is shared with `hdr-test.js` through `experiments/tonemap-mirror.js`, which pulls the
Hable constants out of the WGSL text instead of retyping them.

### A tone curve's white point decides whether stars have edges (2026-09-21)

Moving the display curve after the flux sum is not enough — the white point has to sit
above the flux of the brightest thing in the frame or the "flat-white blob" failure just
moves downstream. A sprite is white wherever `flux · falloff ≳ w`, so with the `(1−r²)³`
falloff the flat-white disc radius is `r = sqrt(1 − (w/flux)^(1/3))` and it reaches 0
only when `w` exceeds the star's peak flux. Measured on the default scene (magZero 12):
the brightest landmark (Sirius, absMag 1.4 at 2.6 pc) carries flux ≈ 2.4e5, so at
w = 4 it is flat white to r = 0.99 of its sprite and even w = 16 (the slider max) leaves
r ≈ 0.98. That is fine for the shipped look (a white core with a coloured halo is the
0.2 design goal) but it means the white slider cannot un-blow a first-magnitude star —
only `magZero` can. If a future feature needs per-star gradients on bright stars, the
white range must extend past the field's peak flux (one deleted branch measured the same
effect for extended Reinhard with w up to 8192 — same law, different curve). Ship such
defaults as measured constants and pin the disc-gradient property in `hdr-test.js`.

### Deleted branches review: what was worth keeping (2026-09-21)

`arena-01a0bdf8-hdr-direct`, `arena/01a0bdcb-galaxy-flythrough` and `hdr-cam` were
reviewed against main and deleted from origin (wrong-HDR lineage: extended Reinhard /
HDR-direct-no-tonemap variants, all superseded by main's accumulate-linear +
Hable-then-saturate tonemap pass). Picked: `experiments/wgsl-exec-check.js` (rewritten
against the current shaders), `experiments/tonemap-mirror.js` (factored from both
tests), and the white-point measurement methodology above. Rejected: the Reinhard curve
itself, the no-tonemap HDR-direct path (skipping the pass breaks the white/saturation
knobs on HDR displays — main's comment already records this), `src/render/labels.js`
(main's `label-layer.js` supersedes it), and their white-point default of 1024 (measured
for their flux scale at magZero 17 — not transferable).

## 2026-09-21 — Test parameterised samplers away from the preset

The 0.3.0 suite passed while compact discs piled stars against their cut, spheroids
ignored non-unit r0, halo draws omitted the flat core and hard-coded power 3.5,
and centre.z / arm phase overrides disagreed between consumers. Global mixtures
hide low-weight component defects. Isolate each component and integrate its actual
field independently: the new `model-parity-test.js` fails 37/57 checks on the prior
code and passes 57/57 after the corrections. For a truncated CDF, invert
`u * F(cut)`; never clamp an untruncated inverse to the cut. Derive gas gates and
camera homes again after structural overrides.

## 2026-09-21 — WGSL interpreter scalar cosh is not GPU cosh

`wgsl_reflect` 1.6.0's scalar `Cosh` path calls `Math.cos`; its vector path calls
`Math.cosh`. Executing the density shader exposed 34–129% thin-disc errors that
were interpreter errors, not GPU evidence. The shipping JS and WGSL now evaluate
sech² with `e = exp(-abs(z)/H); 4e/(1+e)²`: algebraically identical, stable for thin
discs, and independent of that interpreter defect. No dependency source is patched.
The shader suite now executes density components and arm distances across all
regular types plus translated/overridden parameters, rather than only parsing the
density source. CPU interpretation still does not replace real WebGPU validation.

## 2026-09-21 — Parallel same-file edits race: last write wins

`edit_file` calls to the same file issued in one parallel block read the same
original and overwrite each other — exactly one lands, the rest report success
and vanish. Five plan edits landed one, three smoke-test edits landed one, and
a rate-constant change silently lost to an apportionment edit in the same file
(the mixes then measured identical, which is how the loss surfaced). Same-file
edits go sequentially, one per turn; different files in one block are safe. An
atomic multi-edit script (python with per-edit occurrence asserts) is the
alternative when several same-file edits must land together. Verify with
`git diff --stat` before measuring anything the edits were supposed to change.

## 2026-09-21 — Fixed GPU blocks want apportioned quotas, not fill-in-order

A 2000-star globular next to a 200-star association fills a fixed member block
10:1 under fill-in-order, so the Milky Way's 20k object slots would have been
95% globular stars. Richness is a weight: cumulative (Bresenham-style) rounding
apportions the budget over it in one pass with O(1) state, an exact total, and
every non-empty object keeping at least one member — contrast preserved, no
phantoms, deterministic in the seed. The same shape fits any fixed block fed by
uneven sources (gap-fill per cell, LOD buckets). Companion rule for clustered
profiles: a noise-threshold draw with bounded deterministic retries plus a
last-candidate fallback keeps the count exact without breaking the
`(seed, j, i)` stability contract — retries are a fixed hash sequence, so
member *i* stays a pure function.

## 2026-09-22 — Quaternion camera pole fix: don't rebuild right/up from world-up

When removing a pitch clamp, changing only the orientation integrator is not enough. Any projection code that recomputes `right = normalize(forward × worldUp)` reintroduces the same pole singularity and discards the camera's upside-down/roll state. Keep `forward/right/up` as one quaternion-derived basis and build the view matrix from those axes directly.

## 2026-09-22 — Shader constants are a parity bug waiting for the second galaxy

Hard-coding today's model's numbers in WGSL (0.041 pattern speed, 0.225 flat
velocity…) passes every test while only one galaxy type exists, then silently
draws every other type with the first type's rotation while the CPU mirror reads
the real `dynamics`. Parameterise on the first commit: pack the per-model scalars
into spare uniform vec4s and apply all defaults CPU-side once (`fillDynamics`),
so the shader reads plain numbers and "no galaxy constants in WGSL" becomes a
checkable rule. 8 floats = 32 bytes/frame; the wrong-universe bug costs far more.

## 2026-09-22 — Reduce the FULL sin argument, not the bulk angle

Reducing `ωT mod 2π` once and reusing the reduced value for every `sin` looks
like the precision fix, but epicycle arguments (`ψ + κT`, `ψ + ω̄T`) are not
integer multiples of the bulk period — feeding them the wrapped θ snaps every
wobble phase once per revolution (a visible tick at high time rates). Reduce
each transcendental's own argument (`sinTau(arg)` on both CPU and GPU). Probe
continuity with ±ε evaluations across one bulk wrap in the orbit test.

## 2026-09-22 — Default family bits mean "pattern", which is never neutral

Flags nibbles that default to 0 silently tagged every landmark and catalog star
as the pattern family while the CPU label path computed a family from the star's
class — labels then drifted off their own stars as soon as time ran. When a
decoded field has a default, either stamp it at every write/decode boundary
(tile-loader stamps the pre-0.4 bundle on decode) or make the default match what
the CPU assumes. One shared helper (`familyFromColorIndex`) used by writer,
labels and picking beats two call sites with the same hand-rolled ternary.

## 2026-09-22 — Group kinematics are free — but a group speed is not a rigid body (0.4.3)

"The structure should move as a group, not as individual orbits" is not a
performance question when orbits are closed-form: a shared ω replaces one
division with a constant, zero extra ALU, no per-star state, no CPU pass. The
0.4.1 answer (corotation lock: the disc shares the bar's Ω inside R_CR) was
still wrong in the way users see it: a *pattern* is rigid, the stars are not.
The reading that fixes it costs one sin pair: give each bar star a seat that
rides the pattern and let the star circulate about that seat at the rate it laps
the pattern, Ω(r) − Ω_p. Radius enters through a rate (not through
per-star parameters), so the group stays one group and the numbers on screen
vary the way a density wave does: fastest near the centre, zero at corotation,
reversed outside. Rule of thumb for the next structure question — ask which
entity is rigid (the pattern) and which is a group (the stars), and put the
radius dependence in the second one.

"Rigid" also survives as a *measurement* trap: a bar built from uniform-rank
closed loops drifts its own barycentre by 0.04·A (65 pc on SB0) because the loop
phase is the star's azimuth, so the loop population spreads. Anchoring the seat
(fixed phase offset per seat, not per orbit) holds the centroid inside 1.5% of the
bar radius — check the centroid, not just the extreme stars, when validating a
loop-based shape.

## Derived objects inherit the *values* they logically negate (0.4.2)

`SB0 = Object.assign({}, S0, { barred: true })` kept S0's `omegaPattern: 0` —
so the rigid **bar** family ran at ω = 0 while the disc turned: the exact
"group moves but stars freeze" symptom, invisible in any type-count test.
When a derivation changes what a field *means* (unbarred 0 → pattern speed),
override it explicitly in the branch, and add a **per-family ω > 0 sweep over
every type** (orbit-test §4b) so frozen populations can't hide in data.

## λ·ω̄ = 0 is a silent half-galaxy freeze (0.4.2)

`spinLambda: 0.0` is legal input with a valid output (bulk spin = 0) — the
spheroid still "boils" at sub-pixel amplitude, so the population reads as
frozen, not as broken. Data ranges from the plan (λ ∈ 0.05–0.3) belong in
the model table; test "every family the model uses has ω > 0", not "no throw".
Also: when re-deriving a clock shape, re-read the plan's family table first —
0.4.1's always-Keplerian ω̄ contradicted §1.1's "mean disc frequency" and had
to be reverted to the hybrid one release later.

## 2026-09-24 — A traffic jam has a sign, and it flips at corotation

Slowing a star's inertial rate near an arm (`ω · (1 − s·D)`) only jams inside
corotation, where the star is overtaking the pattern. Outside, the pattern is
already overtaking the star, and slowing the star makes the sweep *faster* —
the outer arms empty. This disc is mostly outside corotation (Sb seed 3,
R_CR ≈ 10.2 kpc), so that form, and the linked demo that uses it, do not port.
The form that jams on both sides is a pattern-frame capture whose crest speed
is zero either way: `dχ/dt = α·m·(Ω−Ω_p)·sin²(χ/2)`. A cosine phase-pull is
the other failure: its radial derivative has the wrong sign relative to the
arm pitch, so the slider shears the arms apart instead of holding them.
α = 0 must short-circuit before the closed form; folding zero into the `atan`
freezes χ, which is not the shear.

## 2026-09-24 — "Closer to the crest" is not true of an arbitrary offset

A star on the far side of a crest takes the long way to the next one, so its
distance to the nearest crest can grow while the ring tightens. The monotonic
probe is the side the wave is sweeping: positive azimuth offset outside
corotation, negative inside. The population probe is the mean |χ| of a uniform
ring, which the undamped law holds at `π/(2m)` forever. One star against one
sheared star at one time is neither.

## 2026-09-24 — A shared uniform is one size, in every fixture

`CameraUniform` is one buffer uploaded for stars and for nebula billboards.
Growing it (dynA/dynB, then waveA/waveB) means both struct declarations, the
packer, `UNIFORM_FLOATS`, and every test fixture that builds the buffer —
including the second camera in `wgsl-exec-check.js`, which is not the one the
first comment describes. A short buffer dies inside the interpreter as
`Invalid typed array length` on the first vec4 past the end, not as a failed
check. WGSL lives in a JS template literal: a backtick in a comment ends the
string, and a validator regex that bans a rejected formula will also match
that formula written in a JS comment.

## 2026-09-24 — wgsl_reflect runs one compute invocation per debug session

`WgslDebug.debugWorkgroup(entry, dispatchId, ...)` executes exactly the
invocation whose global id equals `dispatchId` — a 64-wide dispatch needs 64
re-armed sessions, not one. The fast path, `WgslExec.dispatchWorkgroups`, runs
them all at once but mis-executes struct-heavy kernels: on `simple-step` the
stepped omega came out exactly 4× (n = 1 included), while the debug path
agrees with the CPU law to 5e-7 rad. Root cause unknown, presumably a library
bug in the exec path's uniform/struct reads — the suite drives the debug path
until that changes. Cheap anyway: one `WgslDebug` reused across re-armed
sessions (no module-scope `var`s in the kernel, so re-running the prologue is
safe) steps all 64 invocations in ~46 ms, and storage writes persist across
the sessions because every session wraps the same ArrayBuffers.

## 2026-09-24 — Compare f32-packed values against Math.fround, not literals

A check that packs 1/3 into a float and compares against the JS literal with a
1e-9 tolerance fails: f32(1/3) differs from the f64 literal by ~1e-8. The fix
is exact `=== Math.fround(...)` comparison, not a looser epsilon — the epsilon
hides real drift, the fround pins the packing. Same family: the tonemap
`fs_main` returns `vec4(rgb, 1.0)`, so an exact RGB pin must read channels
0–2, not `.every(v => v === 4)`.

## 2026-09-24 — Re-seed the epoch only when positions regenerate

The simple engine's azimuth mirror (GPU buffer plus CPU landmark thetas) is
positional state. An age-only regenerate keeps the sampled field and rewrites
properties, so its thetas survive — re-seeding there diverges labels and picks
from the sprites and snaps the visible epoch. Re-seed on galaxy change,
engine switch and R reset only. The test-side shape of this rule: `renderer`
pins the theta re-seed on `setEngine`, not on `regenerate`.

## 2026-09-26 — Probe the arm lane where the arm field lives, and carry its phase

Three couplings bit at once when the MW preset's arms moved to the bar tip
(`minRadius` 0.5 → 2.3, `phase0` 0 → 2.8406):

- `density.distanceToNearestArm` returns **99** for `R < arms.minRadius` — any
  "distance to arm" statistic that averages over all R silently eats 99s. Filter
  to `R >= minRadius` first (sampling, object-placement).
- The simple lane's base is `K·ln(ρ/Rs) + Φp` with
  `Φp = Ωp·T − phase0/m` (`orbit.simplePatternPhase`). A hand-rolled on-arm
  probe or f32 replay that passes `patternPhase = 0` is off-ridge by
  `phase0/m` once the preset's phase0 is nonzero — pass
  `simplePatternPhase(model, T)`, which is what the packed uniform carries.
- A test that borrows one model's ridge azimuth to probe another's field only
  works while both share `phase0`. Compute the ridge from the model actually
  probed.

## 2026-09-26 — wgsl-exec vertex-mirror sessions: stale theta buffer

The four `debugVertex` checks (simple rebuild, eccentric rho, apocenter T=0 and
Kepler path) fail at the base commit with wgsl_reflect 1.6.0: the GPU reads a
stale binding-3 value (both sim runs return the *same* position for θ = π/2 and
θ = 0), so the session does not see the re-bound theta buffer. The compute-path
checks on the same suite pass, and `all-tests` is unaffected (wgsl-exec is
TYPES['sim'], not test). Until reconciled: treat those four as a known harness
failure, not a shader regression — the same vertex path is pinned f64-side by
orbit-test's mirror checks.

## 2026-09-26 — Measure a truncation against what shares the view, and only ever move it outward

A hard cut in a density field is visible when the density it removes is a noticeable
fraction of *what the eye has to compare it with in the same view* — not of the model's
global peak. For a disc column that reference is the column's own midplane (the cut at
R = 20 is judged against the light at R = 20, not against the bulge), for a spheroid it is
the `s = 1` level. Judged against the global peak every cut in this model looked fine;
judged against the local reference the thick disc's slab was cutting at 4% and the Sérsic
n = 4 bulge at 0.5%. `experiments/truncation-edge.js` is the reusable version.

Two further rules that fell out of fixing it:

- The search for "where is the profile faint enough" must run on the **untruncated analytic
  profile**. The first version of the study searched outward on `density.rhoTotal`, which is
  0 past the existing cut, and therefore reported every cut as already sufficient.
- A derived cut must be `max(authored, rule)`, never a replacement. Applied as a replacement
  the same rule *shrinks* the halo (100 kpc → 7.2·a_h) and Sc's spheroid (6 → 5.14), and it
  overrode a test's compact disc (`discRadius = 1.2`, `L = 3.6`) by 20×. The distinction that
  held up: authored *size* is intent (a disc break is an observed feature — keep it), an
  authored *slab height* was an artifact of the box (a disc has no vertical edge — derive it).

## 2026-09-26 — When a test fails after a model change, check the test's own resolution first

Two of the four suites that broke under the M3.1 truncation change were the tests being
wrong, and both said so only when their own sampling was raised:

- `density-distribution`'s SBb mass shares were failing at 1.9%. The reference is a box
  integral over a 40 kpc cube; a 2.3 kpc bar of steep profile inside it is badly resolved at
  240×96×60 cells. At 480×192×90 the reference moved 0.18881 → 0.18706 against the sampler's
  0.18497 and the check passed — the *reference* was off, not the sampler.
- `object-placement`'s HII arm-ridge mean jumped 0.250 → 0.374. At the suite's 1200 objects
  only ~100 are HII regions; at 12000 the true means are 0.294 → 0.308. The change reshuffles
  the whole random stream, so a small-N statistic moves far more than the effect being tested.

The cheap diagnostic in both cases: re-run the same statistic at 10× the sample (and, for a
reference integral, at 2× the grid) before touching the limit. If the number moves toward the
observation, the check was under-resolved; if it does not, the model changed.

## 2026-10-11 — Compute every number in a plan before writing it down

The 0.5 planet plan (`0.5.0-plan-planet-generator.md`) pins a lot of physics: delta-v
budgets, transfer times, equilibrium temperatures, tidal locking. Every number in it was
produced by running the plan's own formulas in a scratch script and comparing against a
published value, rather than recalled. That caught five errors a read-through would not:

- **The Hohmann launch phase angle is `π·(1 − 2·t_H/P2)`, not `π·(1 − t_H/P2)`.** The
  factor 2 is easy to drop because the formula looks like the transfer-angle identity.
  Corrected, Earth→Mars gives 44.4° against the published 44°; the wrong form gives 88°,
  which is not a number anyone would recognise but which is also not obviously absurd.
- **A brachistochrone leg's distance is the arc `π·(a1+a2)/2`, not the radius gap
  `|a2−a1|`.** With the gap, Earth→Mars crossover dv came out at 14 km/s — inside a
  chemical tank — and a 1 g ship read 2.1 days. With the arc, crossover is 106 km/s, a
  chemical hull cannot beat the ellipse at all, and 1 g reads 5.7 days. The gap version is
  *self-consistent and wrong in the direction that flatters the model*, which is the worst
  kind of error for a plan that will be implemented from.
- **A greenhouse table keyed on planet type alone makes every habitable-band world
  Earth-like, including Mars.** The fix is a mass gate (0.02 M⊕ for any atmosphere, 0.3 M⊕
  for a working cycle) plus a runaway branch with its own cloud albedo. Six real bodies then
  fall out of four constants: Mercury 433/440 K, Venus 742/737, Earth 288/288, Mars
  216/210, Moon 270/250, Ceres 163/168. A model that reproduces six bodies with one
  threshold is worth pinning; one that reproduces one body with six tunables is not.
- **A ship table needs an internal invariant.** `dv ≥ 2·v_cruise` for any interstellar
  class, or the class cannot reach the cruise speed its own row advertises. Two of five rows
  violated it as first drafted. The invariant is now a test, not a comment.
- **Numbers copied between two sections drift.** The transit table computed the generation
  ship's ceiling from 0.01 m/s² while the ship table two sections later said 0.001.
  Recomputing exposed a property nobody had intended and everybody should know: at
  0.001 m/s² that class's ceiling on Earth→Mars is 48.7 km/s, under the 106 km/s crossover,
  so a 6 000 km/s tank buys no in-system speed-up over a 20 km/s chemical hull. When the same
  constant appears twice, one of them is the table and the other is a citation — cite it,
  never retype it.

The transferable rule: when a plan carries numbers, the numbers are part of the design and
get the same treatment as code — execute them, compare against an independent source, and
write the comparison into the plan as a pin table. A pin table that says "model 3.91,
published 3.9, tolerance ±0.3" is also the acceptance test for whoever implements it.

Related, same pass: **selection identity in this repo cannot be a buffer index.** The
renderer says so in a comment ("Streaming slots are not stable star identities") because the
local gap-fill and catalog blocks are rewritten on every residency change. Anything that
remembers a star — a selection, a generated planet system, a route endpoint — has to key on
a stable per-record identity, and the cheapest stable identity is a parallel `Uint32Array`
filled where the block is written.

Also found, not fixed here (out of scope for a documentation pass): `scripts/run.py`'s
`TYPES['study']` lists `damping-formula`, but `EXPERIMENTS` has no such key, so
`python3 scripts/run.py damping-formula` prints "Unknown command" and exits 1 while
`node experiments/damping-formula-check.js` works. One missing line in `EXPERIMENTS`, and
`all-tests` never touches it because it iterates `TYPES['test']`.

## 2026-10-12 — A top-k pin needs a population larger than the cap, in buffer order

Reviewing 0.5.0's `selectAround` found a truncation counter that undercounted and a test
that could not see it. The scan keeps the nearest `maxCount` records by insertion sort into
a fixed array; when the kept list is full and a nearer record arrives, the farthest kept
member is shifted off the end — and was **not** counted in `truncated`, while a record that
arrives when full and sorts past the end **was**. So `truncated` equaled "refused on
arrival", not "inside the radius but not kept".

The existing pin (`truncated === expected.length - 5`) looked exactly right and passed —
because the chosen radius held exactly **one** record (the centre star itself), so both
sides were 0. The fix is twofold and both halves matter:

- **An eviction is a drop: count it where "not kept" is the contract.** Refused and evicted
  records are the same event to the caller. (The `star-set` capacity overflow already did
  this right — it counts both the refused star and the replaced one in `dropped`.)
- **When a test pins top-k or truncation behavior, the population must exceed the cap, in
  adversarial order** — buffer order, not distance order, so insertions and evictions both
  run. The strengthened case runs a 1.2 kpc radius (~26 records) at cap 5 and pins
  `truncated === 21` and the kept five against the brute-force top five. A vacuous pin is
  worse than no pin: it says "covered".

Same pass, two smaller ones:

- **Cross-check plan numbers with an independent series, not the module's own loop.** The
  occurrence tier's E[n] pin recomputed Σ Π μ/(μ+j) in the test and caught the plan's
  published "E[n] = 1.020 at μ = 1.6" (true value 1.0195 — the 3-decimal rounding was
  optimistic). The plan number was corrected in place; the pin is now ±5e-5. This is the
  same rule as *"Compute every number in a plan before writing it down"*, applied at
  validation time.
- **Correction to the 2026-10-11 entry's runner note:** the `scripts/run.py`
  `damping-formula` gap it recorded is not present at HEAD — `EXPERIMENTS` has the key
  (`experiments/damping-formula-check.js`), `run.py damping-formula` exits 0, and `run.py
  list` shows it under Studies. Either it was fixed before the commit landed or the note
  described an uncommitted state; verified 2026-10-12, nothing to do.

## 2026-10-12 — Worked examples in a plan are code too, and `a ** 3` is not `a·a·a`

Two catches from the 0.5.1-4 architecture pass:

- **Recompute a plan's illustrative numbers before pinning around them.** §4.5's prose
  said "One Jupiter at 1 AU around the Sun is 6·r_H = 0.59 AU (0.74 against a second
  Jupiter)" — both numbers omit the `/3` inside the Hill cube root
  (`((m_i+m_j)/(3·M★))^(1/3)`); the correct values are 0.41 and 0.52 AU. The formula in
  the same code block was right, so an implementation following the formula silently
  disagrees with the example beside it, and a reviewer "checking the numbers" would chase
  the wrong side. Same family as the E[n] = 1.020 → 1.0195 catch: a worked example is a
  statement the test must be able to reproduce, so compute it with the same code path the
  pin uses, then write it down.
- **`x ** 3` and `x * x * x` differ in the last bit.** The exponent operator goes through
  pow and rounds once; the repeated multiply rounds per step. A bit-equality pin
  (`Object.is`) against a module that writes `a * a * a` fails ~14% of the time when the
  test recomputes with `a ** 3` (1270 of 9148 planets in the 20k-system sweep). When a
  test mirrors a formula for bit-exact comparison, mirror the *operations*, not the
  mathematics — the same rule the WGSL mirrors already follow.

## 2026-10-12 — A plan's prose numbers are a second implementation: cross-check them

The 0.5.1-5 review found a divergence that no test could catch, because the test agreed with
the code and both disagreed with the plan:

- §4.2 writes the thermostat as `ΔT = min(65, 33 + 55·clamp(1 − S, 0, 1))`; the code had
  dropped the `clamp`, which only bites in `S ∈ (1, 1.05]` — the inner edge of band 2. The
  pin at S = 1.0 passes either way (the clamp is inactive there), and the §4.12 window
  [260, 296] K passes either way too (288.0 unclamped vs 290.7 clamped). **What exposed it
  was the plan's own prose ranges**: §4.6 claims TERRAN holds 261–290 K and SUPER_EARTH
  264–295 K across the band, and those are the *clamped* values (290.7 and 295.2). The
  prose and the formula were the two witnesses; the code was the outlier. Rule: when a plan
  states a range or an endpoint, recompute it from the formula before pinning, and pin the
  endpoint (the band-edge value) rather than a rounded pair of integers.
- The same pass caught three authored numbers that could not be true: §4.2's "at S = 0.35
  it saturates at 65 K (279 K)" (the formula gives 261 K — 279 is the S = 0.58 value
  written twice), §4.7's inner-belt mass comment "0.0001 – 0.079" for `10^(−4 + 2.5u)`
  (the range is 1e-4 – 3.16e-2), and §4.2's SUPER_EARTH ΔT base of 40 K, which is dead:
  SUPER_EARTH only appears in band 2, where the thermostat overrides the base with the
  TERRAN anchor. Dead authored constants are the same failure as a wrong one — set the
  column to the value the live path uses and say which rule owns it.
- **A wrong table cell survives because the test copies the table.** The band-1 row for
  airless worlds (M < 0.02) said BARREN in the plan and LAVA in both the code and the test:
  a Moon-mass body at Mercury's insolation would read molten while Mercury reads barren,
  and the code's own comment claimed the plan's row. The fix is small, but the class of bug
  is not: a table whose test was written by transcribing the implementation cannot
  validate it. Transcribe from the *plan* and diff against the code, or state the physical
  reason (no atmosphere ⇒ nothing to boil ⇒ no LAVA below S = 8) and let the pin follow it.

## 2026-10-12 — Measuring per-call allocation in V8: heap deltas lie, `--trace-gc` sums do not

The `§4.12` "generateSystem allocates nothing" pin needed a real instrument. What does *not*
work, and why — all measured on Node 22, 1M-call loops:

- **A heap delta is blind to non-escaping objects.** `terranPlanet(…)` returned a fresh
  `{inHZ, terran, lockedHZ}` per call and a 100k-call heap delta read 341 KB — comfortably
  inside the test's 2 MB threshold. V8's escape analysis scalar-replaces the object when the
  result is only read (measured: 1 scavenge per 1M calls), and only boxes it when the value
  escapes (24 scavenges per 1M). So a heap-delta pin approves an allocating function *and*
  fails the shape it is meant to protect. The guard has to be the code convention —
  out-param records, no returned objects — not a measurement.
- **`--heap-prof` misses young-generation allocation entirely here.** A control loop that
  pushes 500 000 live objects shows 0.27 MB in the profile while `--trace-gc` reports 11
  scavenges. Do not use it as the allocation oracle for a hot loop.
- **A `PerformanceObserver` GC count is dominated by unrelated events.** `architecture` ×
  200k showed 13 entries, the allocating `terranPlanet` showed 2 — backwards, for the same
  scalar-replacement reason.
- **What works: sum the scavenge bytes from `--trace-gc` after a warm-up, in a child
  process.** Emit a marker line between the warm-up loop and the measured loop, then sum
  `before − after` of every `Scavenge a (b) -> c (d) MB` line that follows the marker.
  Control loops (`pcgHash` × 1M, a pure arithmetic loop) sit at 0.3–0.9 MB; adding one
  `hash01At()` call per iteration adds ~6 B/call; the architecture tier's eight draws per
  planet cost 89 B/planet, and a class with no planets (`μ = 0.02`, 0 planets in 1M calls)
  costs exactly 0 — which is how the site was localised to the per-planet loop rather than
  the setup.
- **The residual is V8 boxing a returned double, not our objects.** `hash01At` returns a
  double; when the call is not inlined the value must be tagged, and ~36% of the time
  `pcgHash`'s `state >>> 0` also exceeds the Smi range, so it boxes too. Writing the same
  expression inline in the caller cut the churn 3.5× — but that means copying the hash into
  `planets.js`, which is worse than the garbage. Record it as a codegen cost, state the pin
  as "no objects", and keep the module's own allocations at zero.
- Corollary for budgets: cost the one-off work separately. `fillStipple` (384 dots × 2
  draws + 384 `exp`) is 2.8 µs and runs once per *opened* system; folded into the per-star
  loop it read as 3.3 µs/system and looked like a budget miss against `architecture`'s
  0.19 µs. Measure the loop the search actually walks.

## 2026-10-12 — A pin that re-derives a boundary invariant needs the boundary's own tolerance

Writing the 0.5.1-7 record pins turned two test-side bugs into failures that looked like
generator bugs:

- The record-level §4.12 check compared `a[i] − a[i−1] ≥ K_HILL·r_H` exactly. The architecture
  tier's own pin for the same invariant carries `(1 − 1e−9)`, because the stability repair
  pushes a body *onto* the requirement — the surviving gap is the product of the same
  `cbrt` and a division, and the last bit can land either side. 86 of 5 000 systems failed on
  rounding, not on spacing. Rule: when a second pin re-derives an invariant the first pin
  already states, copy the first pin's tolerance (or assert the identical statement). A
  tighter re-derivation is not a stricter test, it is a different one.
- The designation check read `designationToString(buffer, end)` *after* a second
  `writeStarDesignation` had overwritten the same 16-byte buffer, so it compared the second
  key's digits against the first key's end offset. The detail string gave it away (`S0`, the
  smaller key, reported 7 digits). Rule: a writer that returns a length into a reused buffer
  must be read before the next call — and the shortest-form rule (no zero padding) makes the
  reuse *more* dangerous, because a 1-digit and a 7-digit result both fit in the same bytes.

## 2026-10-12 — Check a record's field list against every consumer's predicate list

The 0.5.1-7 summary tier was written to §4.10's field list — `count`, both histograms, a
`bestTerran` candidate, `maxPlanetMass`, `beltCount` — and pinned green. §5.1, the consumer's
spec, then lists four *range* predicates over per-planet values (`aMin/aMax`,
`planetMassMin/planetMassMax`, `teqMin/teqMax`, `tsurfMin/tsurfMax`): "does this star have a
planet with X in [lo, hi]" is `max ≥ lo && min ≤ hi`, and a single `maxPlanetMass` answers
only the lower bound. Three of those rows could not have been implemented from the summary as
specified. The tier now carries all four pairs, with `±Infinity` sentinels so a planetless
system cannot match a range without a special case (742 of the 2 000 pinned systems are
barren, so the sentinel path is pinned too). Rule: before a tier is called done, diff its
field list against the predicate list of every module that reads it — a field a consumer
cannot act on is as much a bug as a missing one, and both are invisible to a test written
against the tier's own spec.

## 2026-10-13 — Route clocks, signed windows and browser-only search glue

Belt SI periods need `2π sqrt(a³/μ)`; the schematic's `sqrt(a_AU³/M_solar)`
year law already includes that factor through the unit system. Compare the two
clocks directly to catch unit drift. Synodic windows also need the sign of
`n_target - n_source`; absolute angular velocity alone works only in one
transfer direction. Fuel zero is a genuine empty tank, not an absent limit.

Node-side search math passed while its browser UI called nonexistent `ptypeBit`
instead of exported `planetTypeBit`. A real DOM/control run exposed it; module
export parity alone cannot check call sites. Headless Chromium's software WebGPU
lost its external instance in this sandbox: CPU canvas and UI tests still work,
but those results must not be presented as successful WebGPU galaxy rendering.

## 2026-10-14 — An epoch tier has to say which time base its windows live on

Adding a structural tier beside an existing population tier looks like "multiply the
same factors into both halves". It is not: the two tiers need **different time bases**,
and getting that wrong is silent.

The population tier compresses a galaxy's formation windows to its own age
(`sfhSpanAt(age, quench)`), which is self-similar: a 2 Gyr Sb's thin disc forms over
the same *fraction* of its life as a 13.5 Gyr one's. Feeding those compressed windows
to a structure tier therefore cannot express assembly — the ratio is nearly the same
at every age, so the tier either does nothing or drifts non-physically (an S0's thick
disc and bulge saturated by 1 Gyr while the thin disc lagged). The structure tier has
to read the same `FORMATION_WINDOW` table against the **reference** span
(`min(age, w·span_ref)`), which is monotone, bounded, exactly 1 at the reference
epoch, and is the only reading that answers "how much of this component exists yet".

Two more rules fell out of the same slice, both worth carrying into any similar one:

- **Check a scaling law against the layers that do not scale with it.** Scaling every
  component's amplitude to 0.6 % of present mass at 0.5 Gyr looked fine in the model
  tests and was wrong in the field: the gas-driven object layer scales with `gasNow`,
  not with the disc's amplitude, so the galaxy showed a full nebula lane over an
  emptied disc and its globular counts *rose* with age. A law that moves a mass has to
  move everything that mass would carry, or nothing.
- **A "no physical disc" type is not an edge case, it is 8 of 19 types.** The E
  sequence has `thin.amp = thick.amp = 0`, no disc at all, yet its two scale heights
  are still read — by the gas lane of the object layer. Heating them thinned a
  starburst's lane and a mid-burst E4 silently stopped placing HII regions. When a
  law's stated subject is a component, gate it on the component existing; the failure
  otherwise surfaces in an unrelated layer, which is exactly where it will not be
  looked for.

Two smaller traps from the same slice, both about measurement rather than physics:

- **A test that samples the field once and evaluates it at several ages stops measuring
  the law.** Once the tier moves the disc the field is drawn from, one shared field
  makes the exposure offset at 0.5 Gyr a mix of the population clock and the structural
  term (the same absolute `z` read against a `heat²`-thinner lane). Sample the field
  from the epoch's own model — which is what the renderer does — and read the
  counterfactual back at the reference epoch from *that* field.
- **Check what a scaled number feeds.** `arms.amp` is not only the sampler's contrast:
  `density.armRidgeWidth = ARM_RIDGE_FRAC·λ/(1 + arms.amp)` is read live, so raising the
  arm contrast narrows the newborn lane that the O/B stars, the nebulae and the HII
  regions are placed in. That is the field's own answer, not a second decision — but it
  is observable, so the plan states it and any lane measurement has to expect it.

And the pin that caught it was the *old* pin (`the gas-driven object counts fall as the
gas is used up`), which had been green for two releases. When a new rule makes an old
pin red, the pin is a hypothesis: check whether the model or the pin is wrong before
re-stating either. Here the model was.

## 2026-10-14 — A live clock is a grid, not a sum: float accumulation costs a rebuild

E2's `steppedAge(age)` was written the obvious way, `age + AGE_STEP`, and the test
walking 0.2 Gyr to 13.5 Gyr at 0.1 Gyr steps caught it: the 133rd step landed at
`13.499999999999968`, one ulp short of the ceiling, so the run needed a 134th micro-step
(3e-14 Gyr) to cross it. In a *display* that is invisible; in a renderer where every step
is a field re-sample and a rebuild it is a wasted frame, and the run's own specification
("133 steps") is simply false. The fix is at the root: recompute the target on the grid
from the floor, `AGE_MIN + AGE_STEP·round((age − AGE_MIN)/AGE_STEP + 1)`, which also makes
every step land on the value the *slider* shows — the grid the user can see is the grid
the model should use. Two lessons for a similar slice:

- **A stepping clock is a grid, not an accumulator.** Any law that says "advance by a
  fixed quantum, N times" has a grid implied in it; writing the accumulator loses the
  grid's exactness for free. The bug shows up as an *extra* step at the clamp boundary,
  which is the one place a test that only checks monotonicity will not look.
- **Loosening the assertion would have hidden a real cost.** The failing check demanded a
  whole quantum from the final step; the tempting fix was a tolerance on the last step.
  Because a step here is 0.67 s of sampling, the tolerance would have bought a rebuild
  that redraws an identical f32 geometry — the sloppy version is cheap only by accident
  (`sameGeometry` packs f32 and cannot see a 3e-14 Gyr change).

The companion trap is a test-authoring one, and it looked exactly like a code bug:

- **Do not read a mutable accumulator after the call that consumes it.** A check on the
  throttle read `state.debt` *after* the tick that had just reset it, so the law under
  test looked broken (`{"early":0,"late":3.1,"debt":0}`) while the code was right.
  Capture the intermediate state (`const debtHeld = state.debt;`) before the consuming
  call. Mutable-state laws want their assertions adjacent to the mutation they check.

## 2026-10-14 — Exact-zero is a form you choose: `ln 1 = 0` beats a re-solved phase, and a wrap is not the identity

E3 had to move the spiral ridge's anchor phase when the bar it hangs off grows, while
keeping the reference epoch *bit-identical* (the series' whole exactness contract). Two
forms can re-anchor a log-spiral ridge from `Rmin` to `R'min`: **re-solve** the coupling
(`phase0' = wrap(K·ln(R'min/Rs) − m·tilt)`) or **add** the wind-up between the two tips
(`phase0' = wrap(phase0 + K·ln(R'min/Rmin))`). They are the same number in exact
arithmetic and different numbers in IEEE: the re-solve recomputes a chain whose
rounding never reproduces the authored literal (the preset pins `phase0 = 2.8406`),
while the additive form is exactly `+0` at the reference epoch because `ln 1 = +0` and
`x + 0 = x` for every `x`. When a tier's contract is "every factor is exactly 1 (or 0)
at the reference point", prefer the *additive identity* for phases and the
*multiplicative identity* for scales — `Math.cbrt(1) === 1` and `Math.pow(1, x) === 1`
are spec-guaranteed, so `base × factor` needs no guard.

The additive form has one trap the multiplicative one does not:

- **A wrap is not the identity, so guard the no-op.** `wrap₂π(x)` is exact for
  `x ∈ [0, 2π)` but maps an authored base *outside* the range (an override
  `phase0: 7`) to a different number — so `wrap(base + Δ)` at `Δ = 0` would break
  bit-identity for that model even though the physics did not move. The shipped form
  is `Δ === 0 ? base : wrap(base + Δ)`: the guard costs one comparison and makes the
  reference epoch exact for *every* base, authored, table-solved or overridden.
- **Gate the coefficient, not just the delta.** The same block computes
  `K = m/tan(pitch)`, which is `Infinity` for the uncoupled SB0 (pitch 0) — and
  `Inf · ln(size)` is `-Inf`, whose wrap is `NaN`. The gate is the table's own
  coupling condition (`m > 0 && pitchDeg > 0`), reused verbatim so the epoch and the
  build cannot disagree about which bars have a ridge to move.

Companion lesson from the same slice: when two laws share a quantity, compose them by
substitution, not by multiplication. "Mass fraction = `progress`" (E1) and
"size = `mass^⅓`" (E3) have exactly one consistent solution — the amplitude stops
scaling and the axes carry the assembly. Keeping E1's `amp ×= progress` *and* adding
`axes ×= progress^⅓` makes the delivered mass `progress²` and quietly falsifies the
`∝ mass^⅓` law of the field itself (the size would ride `mass^½`). The tell is a law
stated "of the shipped field" that is only true "of the inputs": check which one a
composed factor is written against, and pin the composed invariant
(`bulge mass fraction === spheroidProgress`, to 1e-12) so the double count cannot
return.

## 2026-10-14 — A re-derived rate on an un-reset clock is a phase jump: rebase the origin

Any angle written `Ω·T + offset` on an absolute clock jumps by `ΔΩ·T` the moment Ω is
re-derived, and the jump grows with how long the clock has run. E3 made Ω_p a function
of the epoch, so each live Evolve step turned the bar back by radians — the user read
it as "going back in time", and no unit test caught it because every E3 check
compared models at `T = 0`. The fix already existed for the Pattern speed slider
(`offset += (Ω_old − Ω_new)·T`); the lesson is that *every* path that swaps the model
under a running clock (age drag, live step, budget re-draw) is the same event as a
slider move and needs the same rebase — route them through one function. Test such
laws at a large `T`, and pin the un-rebased jump as non-vacuity so the check proves
the defect it guards. Companion: a stateful lane seeded from births (the simple
engine) also needs its seeds turned into the current pattern frame, or it snaps back
to the `T = 0` layout even with a continuous phase.

## 2026-10-14 — Clipboard: readText prompts are the browser's; the paste event is not

`navigator.clipboard.readText()` may prompt on *every* call (Firefox's Paste popup;
Chrome without a persisted permission, e.g. `file://`) and no page can suppress it. A
`paste` event's `clipboardData` needs no permission, so a document-level listener
gives a prompt-free Ctrl+V path. Two traps: a global key handler that maps `KeyV` and
calls `preventDefault` on Ctrl+V cancels the paste event itself; and a listener must
skip only fields that take typed text (textarea, text/number inputs) — a focused
range slider or button should still let the scene take the paste.

## 2026-10-14 — Improve the rebase into an accumulator: `rate·clock` is a phase jump waiting for a rate change

The previous entry fixed a re-derived rate by rebasing the phase origin on every
re-draw (`offset += (Ω_old − Ω_new)·T`). That is correct *at the instants it runs* and
wrong everywhere else: the phase is still a function of the current rate times the
whole elapsed clock, so any path that changes Ω without rebasing — and a continuous
clock changes it every frame — jumps again. The user's report ("return back in time
every Evolve step") survived the rebase for exactly this reason. The durable form is to
stop multiplying: keep the angle as an **accumulator** (`phase += Ω_instant·dt`, driven
by the frame loop's own `dt`, before anything reads it) and hand the lanes the *mean*
rate `wrapAngle(phase)/clock`, so every consumer's `rate·clock` product reproduces the
accumulated phase exactly — in f32, at any clock, with no rebase term anywhere. Keep one
accessor for the consumers that genuinely integrate (the simple lane's own steps) and
they must keep the *instant* rate, not the mean: the split is "closed form reads the
mean, an integrator reads the instant". Two corollaries from the same slice: (1) a
*re-sample* cannot continue anything — new inverse-CDF draws are new identities, so
"keep the stars that survive" is a placement problem, not a speed problem; (2) an
expensive per-star pass that has to follow a clock should be sliced across frames with a
byte-range upload (`epochSweepState().stale`, one slice per frame) rather than blocked
on the frame the clock moved, and any *global* number it feeds (an exposure offset)
belongs on a uniform, never baked per record — a record-level offset that changes
mid-sweep is a visible seam.

## 2026-10-14 — When a step is a jump, the test has to run at a large clock

Every E3 pin compared models at `T = 0`, where `Ω_p·T` and `ΔΩ_p·T` are both zero — so
a family of phase bugs was invisible to a green suite. Pin such laws at a large `T`
(and pin the *un-fixed* law as non-vacuity: the naïve form drifts 1.27 rad over a run
while the accumulator drifts 1e-14). The tell in the user's report was "every Evolve
step", i.e. the defect scaled with the clock; a check at `T = 0` cannot see one.

## 2026-10-14 — A 2π-invariant quantity is invariant as a *field*, not as a point transform

The epoch map turns the arms by `−Δphase0/m`, and the first implementation read
`Δphase0` as the difference of two stored `phase0`s wrapped into one turn. That is
correct for the *density field* — the ridge condition `m·φ − K·ln(R/Rs) + phase0 = 2πn`
makes `phase0` and `phase0 + 2π` the same set of ridges, because `n` absorbs it — and
wrong for a *rotation of points*: a turn by `2π/m` maps an arm onto the *next* arm, not
onto itself, so a difference of wrapped angles puts a hard `2π/m` jump into the middle
of a run. The tell is a continuity check done by *refinement*: sample the walk at step
δ and at δ/2 and require the worst step to halve, the total path length to converge and
the net turn to be step-independent. A fixed jump fails all three (the measured worst
step was 6.27 rad, unchanged by refining), which a single-step bound never shows because
any bound large enough to pass is also large enough to hide it. The fix reads the
quantity that is continuous by construction — E3's own `K·ln(size)`, from the homology
scale ratio — instead of the wrapped pair it is equivalent to modulo 2π.

## 2026-10-15 — An arrival orientation needs a candidate chain for up, not one fallback

A fly-to flight that ends looking at a target must pick an arrival up vector. One
fallback ("if the approach is near world Z, keep the current up") is not enough: the
default Sun view's up *is* world Z, so flying straight up a pole leaves both candidates
parallel to the arrival forward and the basis extraction returns a garbage quaternion
(the trace branches quietly produce a non-unit result instead of NaN — it normalizes
into nonsense rather than failing). Use a candidate chain — world Z, then current up,
then current right: of two orthonormal vectors at most one can be near-parallel to a
given direction (`|f·u|² + |f·r|² ≤ 1`), so three candidates always contain one at
`|dot| < 0.99`. Test it by flying the degenerate approach itself and asserting
orthonormality every frame of the flight, not just at the arrival.

## 2026-10-15 — A camera flight to a moving target: re-derive the arrival pose every frame

To make a flight meet a moving object, do not store the arrival pose at launch and do
not integrate a velocity toward it. Store only the launch pose and the arrival
*bearing*; re-compute the arrival position/orientation from the live target each frame
and lerp/slerp by `smoothstep(elapsed/duration)`. The moving endpoint drags the path,
`elapsed/duration` makes the path dt-free (30/60/144 Hz land identically), and the
arrival frame is exact by construction (`s = 1` copies the endpoint). The same trick
makes the follow free: after arrival the orbit placement re-derives from the target
each frame anyway, so a per-frame `updateTarget` keeps the object centred with no new
camera code.

## 2026-10-15 — A stored position is a *birth* position: name the frame of reference, or the UI aims at empty sky

Any feature that moves stars splits one number into two: the record's birth position
(what it was sampled at, what a snapshot stores, what `stellarInputs` decomposes the
density at) and the position the sky draws it at (the birth position through the
engine-mask dispatch at the running star time). Storing the first is right — a snapshot
has to survive a residency rebuild and a derivation has to be reproducible — and reading
it as the second is a bug that no unit test on the storage catches, because the storage
is fine. It only shows up as "the camera flew to empty sky" or "the selection is not the
neighbourhood I clicked": with the shipping defaults (classic mask, star time 5 Myr/s)
20 s of watching is 100 Myr of star time, and a disc star at 8 kpc has moved ~3 kpc from
its birth record — measured 3.09 kpc (10 094 ly) between the two positions of one star.
A radius scan that compares birth to birth is *self-consistent* and still wrong: the
stars it keeps are the ones born near the primary, and differential rotation plus the
per-star family spread scatters them, so a 50 ly scan kept stars drawn 3 172 ly away
(60× the radius) while the drawn neighbourhood held a different star.

The cure is one resolver and one naming rule. Name every position field by its frame of
reference (`around.dist2` drawn, `around.x/y/z` birth — both in one row, neither
redundant), and give the callers a single `resolveDrawn(ref, out)` that runs the same
dispatch the vertex stage, the labels and the picker already run, validates the slot **by
key** (a stale index must never resolve to the star now sitting in it), treats an
invisible record as unresolvable, and returns which of the three cases applied — exact,
approximated (a `simple` bit's θ is GPU-only), or stale (the snapshot stays, and the
readout says so). Then the fly-to target, the camera follow, the scan centre and its
radius test, the readout's distance and a route's separation all read through it, and the
storage contract does not move at all.

Corollary for the follow: key it on the object's **identity**, not on a slot or a
sub-class of object. `followLandmark` (an entry index, landmarks only, one engine mask
only) became `followKey` (the set member's key, resolved per frame), which is fewer lines
and covers every block and every mask — and a member that leaves the residency stops
moving the target instead of snapping it back to a birth record.

## 2026-10-16 — Order the frame so the camera steps after the thing it follows; fly in the target's frame

A camera that follows a moving object must read the object's position *this* frame before
it steps, or it is a permanent one-frame lag (the render draws the new stars). At 5 Myr/s
of star time a disc star moves ~1.7 pc a frame, three times the fly-to stand-off, so the
lag alone put the star off-screen. And a flight that lerps between two absolute points
chases a moving target and overshoots it; ease the camera's *offset from the live target*
instead (identical for a static target). Pin both: a camera test with a fast mover updated
before each step, and a source-shape pin on the loop order, since there is no browser here.

## 2026-10-16 — Make the default test command the cheap one

Every agent ran the whole suite (223 s, 117 s of it one statistical gate) after every
edit. Time every test once, tier them, and let a dependency scan pick what a change can
reach: the string-literal file names in tests and sources are the edges (a new `require`
is a new edge, nothing to maintain). Partial runs should not rewrite committed logs —
preload a `fs.writeFileSync` filter with `node --require` rather than edit 30 tests.
Parallel runs on a 2-core box fail tests with internal timing budgets; keep serial default.
## 2026-10-16 — Eased tracking: rebase the baseline, slerp the remainder

Two ways an "ease toward a measured direction" law silently becomes frame-rate
dependent, both caught by a 30/60/144 Hz landing test:

1. **A cleared baseline skips a step.** Measuring movement against "no previous
   position yet" makes the first frame a no-op, so the effective eased time is
   (N−1)·dt — one frame shorter at 144 Hz than at 30 Hz, and the residual angle
   differs by θ·e^(−T/τ)·(dt/τ). Rebase the baseline to the target as it stands
   (after an assignment, a handover, a re-snap) instead of clearing it, and the
   ease runs every frame: N·dt for everybody.
2. **nlerp is not composable.** normalize(lerp(a, b, k)) reduces the angle by
   slightly less than (1−k), and the shortfall depends on the angle, so
   different frame sizes take different paths to "converged". slerp by k reduces
   the angle to exactly (1−k) of it, and Π(1−k_i) = e^(−Σdt/τ) — the composition
   over equal elapsed time is exact to the bit. The near-opposite guard (dot <
   −1+ε → snap to the target) is the vector case quaternion slerp solves with
   sign flipping; vectors have no double cover.

Corollary: a deterministic dispatch (frozen star time redraws bit-identical
positions) means a per-frame movement test needs no noise margin — 1e-12 kpc
against kpc-scale motion — and "no movement" is exactly zero, not jitter to
filter.

## 2026-10-16 — Panel controls that cannot drift from their keys

A button that reimplements what a key's handler does will drift from it. Instead
give every clickable control a `data-action` and have its click set the same
one-shot action flag the keydown sets — the frame loop consumes it next frame,
so there is one code path and the click inherits every future fix to it.
Checkboxes toggle natively (instant feedback) and a 4 Hz repaint from the live
state corrects the ones the app refused (a toggle that needed a selection, say)
— the checkbox is a view of the state, never a second owner of it. The one
exception is an action whose key handler reads a *held* modifier (Shift+N):
a click cannot hold a key, so that one button calls the underlying function
directly. Refocus the canvas after every panel click, or the focused control
swallows the next keystrokes.

## 2026-10-16 — A velocity dead band chatters at a stand-off on coarse clock rungs

A controller that coasts inside a dead band (\"not worth a burn\") is only safe if
the residual it leaves is smaller than what one frame does to the state. Under a
clock that advances 10⁵–10⁶ s per frame, one frame of a 220 km/s ship is ~10¹¹ m,
and a 1 %-of-impulse band is ~3·10⁴ m/s of velocity. The follow capture left a
2·10⁴ m/s residual — inside the band — so it never corrected, and each frame's
own overshoot (~6·10¹⁰ m) was re-corrected by a ±4·10⁴ m/s burn. The tank ran dry
at the stand-off with the target moving straight. Measured in a Node loop before
the fix; the fix was to shrink the band to f64 noise, because the deadbeat law
converges on its own for small errors.

The general rule: a dead band must be sized against the *state the controller
can hold after a frame*, not against the command's own impulse. Test it by
running the controller at the coarsest step the clock allows, not the finest.

## 2026-10-16 — A command into a speed cap is paid for and then thrown away

When the desired velocity exceeds a hard cap (the cruise limit), the commanded
difference keeps pushing into the cap every frame. The clamp that enforces the
cap removes the excess velocity, but the burn ledger has already charged the
full commanded acceleration — so the autopilot spent 3·10⁷ m/s of Δv holding a
ship at the cap that it could not accelerate further. Fix at the source: clip the
*desired* velocity to the cap before forming the command, so a command into the
wall is never issued.

Open question, not changed here: the manual thrust law has the same ledger
behaviour — holding forward at the cruise cap charges Δv the clamp then discards.
The G1 invariant (`dvSpent == ∫|a|dt`) is written for thrust that is not clamped,
so the fix belongs with a deliberate choice of what a clamped burn costs.

## 2026-10-16 — Aim the controller where the target will be, then check what the clock resolves

When a frame moves the ship by `v·dt` and the target moves by `v_t·dt`, the
controller and the measurement must agree on the instant they compare. The
order in the harness (target advanced, then the ship steps) and the order in the
game loop (drawn position read at the new time, then the ship integrates over
the frame) are the same, so the stand-off a sampled check reads is off by up to
one frame of target motion. Aiming at the frame's *end* made it two frames off,
not one: the deadbeat law already lands the ship on the start-of-frame chase
point, and a lead term double-counts the frame. The right assertion is the
clock's own resolution (`|dist − standOff| ≤ v_target·dt`), not a percentage.

A flip display that holds for a fixed wall-clock beat can cover a whole brake
at 60 fps. A test that waits for a phase *name* to appear will then fail for a
reason that is in the display, not the physics; read the state the phase names
(here, the nose against the velocity) instead.

## 2026-10-16 — Cruise clamps must precede fuel accounting

For a velocity-capped flight integrator, charge `|v_projected - v_before|`, not requested
`|a|dt`: a forward burn already on the speed sphere has no physical impulse, whereas a
sideways command or brake still changes the velocity vector and must spend Δv. A fixed
bisection over command duration gives a deterministic fuel-limited projected step.

## 2026-10-17 — Ship.step's direction argument is a world-frame vector

`ship.step(ship, dt, dx, dy, dz, factor)` takes the commanded direction
in world axes, not ship-local ones. A test of heading-following (ui.11)
that passes a fixed axis like `(1, 0, 0)` silently tests the wrong
thing: the burn lands on the galaxy's +X, not the camera's forward, and
the heading-adoption assertion fails with a plausible-looking
projection (~0.82 instead of ~1.0). Build the direction from the live
camera basis (`camera.forward/right/up`) before stepping, and read the
velocity back against the same basis.

The same session's second trap: `main.js` mixes literal middle dots
(`·`) and `\u00b7` escapes in otherwise identical HUD lines, so a
python patch script matching one form misses the other — match the
exact escaping per line, and patch dense blocks with a counted
`assert s.count(old) == 1` heredoc rather than a fuzzy editor match.

## 2026-10-17 — A sky-chart drag pins the ray in *map* space, from the press

For a chart whose view is a quaternion q mapping world rays to the map (`map = q·world`),
the ray under a pixel is `world = q⁻¹·e(pixel)`. The drag that keeps the pressed sky point
under the pointer is `q' = arc(e₀ → e₁)·q`, with both rays in the chart's own frame. Building
the same arc from *world* rays (`q⁻¹·e₀ → q⁻¹·e₁`) pins only while q is the identity; after
one pan it slides by tens of degrees and the next move composes against the wrong rotation,
so the map accelerates. Compose from the press (store the press quaternion and the press
ray) rather than incrementally: return-to-press then restores the chart exactly, and no
per-move error accumulates. `view-modes-field.js` has this as `chartDirAt` + `quatDrag`;
planet-geotectonics' `MapView.drag` is the incremental version of the same law.

## 2026-10-17 — A nearest-N query measures the drawn sky and stores the birth record

When star time moves the positions, "nearest to the camera" must be decided on the *drawn*
positions but the picked set must keep each record's birth position and packed word: the
draw call dispatches birth → time, and storing a time-advanced position in the set applies
the motion a second time. Split the two explicitly in the query's signature
(`queryNearest(index, measure, …)` writes `index.positions`), and let a test compare the
dispatched set against the advanced index. A max-heap of N entries over one linear scan is
exact, allocation-free, ~0.3 ms for 500 of 3 829 — no sorted array or per-query copy needed.

## 2026-10-18 — An auto follower must trust repetition, not magnitude

The view-modes auto range eased toward each 4 Hz suggestion but *snapped*
whenever one landed >1.5 decades from the live bounds, on the theory that a
far suggestion means a new neighbourhood. After a pan it means the opposite:
the first reads come from data still settling (streaming residency, a
re-picked anchor set), so the snap rewrote the live range with the least
trustworthy read available and the settled field fell wholly outside it —
one flat colour for the seconds the ease needed to crawl back. Distance
from the current value cannot distinguish "genuinely elsewhere" from "not
measured yet"; agreement across consecutive reads can. The shipped law
(`Field.offerRange`/`easeRange`, view-modes.8): only a mode's first offer
snaps, later offers must repeat within 0.08 dex three times before becoming
the target, and the display eases per frame. Applies to any auto-exposure /
auto-window follower over streamed or re-picked data.

*Superseded the same day by the entry at the top:* the agreement gate is what
froze the range through a pan. What survives here is the diagnosis (magnitude
cannot be the trust signal, only time can) and the mode's-first-offer snap.

## 2026-10-19 — Anchor edits on plain ASCII: this tree writes UI strings as escapes

`src/main.js` (and much of the older runtime) writes its HUD strings with
source-level escapes — `` ` \u00b7 ` `` rather than a literal `·`, `\u0394`
rather than `Δ` — while newer code (e.g. the game-mode block) mixes in literal
characters. Any edit-tool anchor that includes a string with a non-ASCII glyph
will silently fail to match (or match the wrong twin), because the tool matches
the raw file bytes, not the rendered glyph. Two symptoms: "context not found"
on text that visibly exists, and pins in `m1-smoke-test.js` (which regex the
source) needing `\\u00b7` to match one backslash. When editing or pinning
around UI strings, anchor on the plain-ASCII span beside them, or script the
replacement with Python reading the file as UTF-8. When adding new strings,
follow the file's local convention (check the neighbouring lines) so the file
stays internally consistent.

## 2026-10-19 — A sentinel-ordered ladder is addressed by meaning, not by index

The ship clock's ladder starts with two sentinels (`−1` follow, `0` frozen)
before its rate rungs, and one call site read the "first timed rung" as the
literal `SHIP_TIME_LADDER[2]`. Inserting G5's real-time stop (`1/31557600`
y/s, a value — not an index) between the sentinels and the 1e-5 band would
have silently changed that fallback from 1e-5 y/s to real time, a 316×
behaviour change no test named. It was caught only because the insertion
made someone read the index. The fix is the general one: export named index
constants (`SHIP_TIME_REAL_INDEX`, `SHIP_TIME_FIRST_TIMED_INDEX`), start
every "from the first rate" scan at the named one (the home-rung search had
the same literal `2`), and add a monotonicity check over the positive span so
a future insertion cannot leave the ladder unordered. A comment that says
"index 0 = follow, 1 = frozen" is documentation; a constant is a contract.

## 2026-10-19 — A time-warp must track the remaining distance, not the committed ETA

The ARCADE clock warp wanted "the flight's four-second floor" as a lower bound
instead of an upper one. The obvious form — `timeRateCapYPerS(ap.etaTotalS, 4)`,
the commit's own estimate — is wrong at scale: the controller's terminal rule
caps the closing speed at half the remaining distance *per frame*, and a fixed
rate at that size steps some 0.17 ly per frame at 60 fps. A 40 ly approach
sailed the target by ~4 ly in the frames around arrival, then reversed and
sailed back; the log showed a stable limit cycle receding at ~1 ly/s with
`phase: coast` and no arrival in ten minutes of wall time. Reusing the live
`ap.etaS` instead makes the rate proportional to the remaining distance, so a
frame covers a fraction of what is left and the approach converges
geometrically: 1 ly in 10.6 wall-seconds, 40 ly in 25. The lesson generalizes:
any auto-warp layered on a controller whose last law is "fraction of remaining
per frame" must inherit that same shape, or the two feedback laws fight.

## 2026-10-19 — A per-frame position difference is not a velocity at small dt

The game's autopilot built its desired velocity from the target's velocity, and
that velocity was a consecutive-frame difference of the *drawn* position. At
the fine ship-clock rungs the nose flicked direction every frame. The
arithmetic: the drawn position is a f64 near 8 kpc, so its own ULP is
1.78e-15 kpc ≈ **55 km** on that coordinate; a 42 km/s star moves **0.7 km**
in one real-time frame. The difference is therefore 0 for ~79 frames and then
exactly one ULP, and 55 km / (1/60 s) reads as a **3300 km/s** spike along that
axis. The star's other components step on different frames, so the *direction*
of the measured velocity changes wildly even when the magnitude looks
plausible — a 0/25.7/51.4/77.1/102.8 km/s staircase that is not the star's
motion at all.

Why it showed up in the nose: the aim is the normalized velocity command
`v_des = v_target + v_closing·dir` minus the ship's velocity, so any error in
`v_target` tilts the aim directly. Measured with the real `apStep` on a
velocity-matched arrival at 60 fps: the aim changed by up to 109° in one frame
at the real-time stop, 2° at 1e-6 y/s, 0.2° at 1e-5, 0.03° at 1e-4 and 0.004°
at 1e-3 — i.e. worse the *finer* the rung, which is exactly how the bug was
reported ("some, typically small, star times"). A frame difference's noise is
`ULP/dt`, so it explodes as dt shrinks; a *coarse* clock hides is completely.

The fix is not smoothing or a dead band: it is to differentiate in the model's
own time over a fixed baseline (±10⁴ yr here), independent of the frame rate.
10⁴ yr is far below every model timescale (epicyclic/pattern periods are tens
to hundreds of Myr) but 10¹¹ ULPs of the solar-circle coordinate, so the same
central difference is accurate to 7e-6 relative (4e-5 across the families) at
*every* rung. Because the position and the velocity go through the same engine
dispatch (`engineRecordPosition` / `engineRecordVelocity`, with the mask
ladder, cluster offsets and epoch map), the derivative belongs to exactly the
position the sky draws — a separate analytic velocity would drift from the
rendered law. The same trap applies to every other consumer of "velocity from
consecutive samples": the follow handover's `ship.vel` seed and the docked
ride both took these spikes as real motion.

Skill: when a derived quantity jitters only at small dt, compute its noise
scaling first — if it is `ULP/dt` (or `1/dt` of anything quantized), the dt is
the problem, not the law. Widen the baseline in a clock that is *not* the one
being varied.

## 2026-10-20 — A start map built in catalogue order seeds colonies nobody can reach

The trade network's seed colonies were the first settled stars in catalogue
order, with the 400 field systems discovered after them. The landmark catalogue
is not ordered by distance from home, so four colonies landed at 310, 42 and
861 ly, and the expedition search (300 ly) found nothing: the network sat at four
colonies for twenty seconds, one expedition in two thousand years.

The rendered field makes it worse. A 300 000-star sample of the Milky Way has no
star within 300 ly of the Sun (the nearest is 307 ly), so the local sky is the
named landmarks alone. Any "nearby" feature that draws on the field needs the
landmarks, or it has nothing near home to show.

The fix is an ordering, not a bigger radius: build the start map as landmarks
plus field stars inside the radius, sort by distance from home, then discover
nearest first and stop when the candidate pool is full. The seeds, the capital
and the candidate pool then fall within a few tens of light-years of home.
Verify a seeding change by printing the distances from home of the seeds and of
the first expedition targets, not just the colony count.

Skill: when a simulation's first state depends on the order a catalogue
happens to be stored in, the start looks random and the growth looks broken.
Print the distances from the origin before tuning any rate.

## 2026-10-20 — A moving-sky leg is measured in the field's frame, never the inertial one

The trade network's routes are timed by "distance / hull speed", and the
distance is between two stars that move. The first intercept solver measured
the hull's chord from its *departure point* to where the destination would be on
arrival — the obvious inertial formulation — and it refused every route in the
galaxy within a Myr of star time, including routes between stars that never
separate. The clocks are why: at the synced rate one trade year is 10⁻³ Myr of
sky, and the disc turns ~765 ly per star Myr at the Sun's radius, so the target
recedes at ~7.6 ly per trade year from a hull that flies 2–4.5. The shear the
network is *supposed* to feel is one to two orders of magnitude smaller.

Measuring the **separation between the two endpoints at the arrival instant**
fixes it: a rigid rotation cancels between two stars that share it, and what is
left is exactly the differential drift that tears routes apart. Predict both
endpoints at the same star time — not one at arrival and one now.

The same class of mistake hides in the hull's position on its chord. A fraction
of elapsed time is only the fraction of distance while the chord is constant;
under shear the chord grows, and a hull that is "97 % of the way" by the clock
is nowhere near by distance, so it never triggers the out-of-range give-up.
Use flown distance over the *current* chord, and make the give-up a margin
(1.6× the cap) rather than the cap itself, or a legitimately booked leg that
drifts by a percent starts turning around.

Skill: whenever a value is a distance or a time "under motion", ask which frame
the speed is quoted in and whether the common mode cancels. A test that only
checks `years = ly / speed` on a frozen sky cannot see this at all; the check
that finds it is the *self-consistency* one — re-evaluate the law at the
booked arrival and assert the numbers still agree.

## 2026-10-21 — Narration belongs at settle boundaries, not in the settle

The trade log was added because the panel could say what the network *is* and
never what had happened. The tempting shape — have `settleColony` report every
change it notices — breaks the closed form in two ways: the settle is called on
inspection as well as on events, so it has no single "when"; and a jump to year
10 000 must produce the same history as ten thousand single-year steps, which a
per-call observer cannot.

What worked: the *event* that changes a colony's life (a founding, a milestone
rung crossed, entering or leaving the starvation band, a demotion) writes one
number-only entry into a fixed ring, from the code that already owned that
decision. The strings live in the panel, at 4 Hz. A jump and a stepped run then
differ only in `log.time`, which is the truth.

Skill: ask "is this an event or an observation?" A settle can be called by any
inspector at any time; narration must hang off the transition, and the
transition must already exist as a decision the simulation makes.

## 2026-10-21 — A route is intent, never an event source

An earlier branch scheduled a departure event per commission, with a 64-slot
ledger, and it drifted out of sync with the hulls it was supposed to describe.
The rule that replaced it: a route is **data a load decision reads**. Nothing is
queued for it, no hull is tied to it, and cancelling one only flags the slot —
hulls already at sea keep their voyage. The queue stays one event per hull plus
the one global tick, so there is exactly one scheduler to reason about.

The preference is a *preference*: the routed destination wins only if it wants
the good and the hull can meet it, otherwise the global scoring runs unchanged.
A route that idles a hull is worse than no route.

Skill: before adding a second producer of events, ask whether the consumer can
just read the intent at decision time. A list read by one decision point is
cheaper and cannot desynchronise; a scheduled event is a promise about the
future that a moving world keeps breaking.

## 2026-10-21 — A system-level factor belongs on the site record, filled at discovery

`supplyFactor` (W4) multiplies every yield by what a system's composition says —
rocky worlds, giants, belts, terrans, habitable-zone worlds. The tempting place
to compute it is inside `fillColony`, which already walks the site. That would
mean the settle path walking a generated system, and the settle must never do
more than the site record says: it is the one function guaranteed to stay
closed-form and cheap.

The working shape: `systemComposition` runs once per system at discovery (one
pass over ≤ 14 planets), the five counts are copied onto the site, `copySite`
carries them to candidates and colonies, and the factor is a pure function of
those five ints and the resource id. A candidate therefore keeps the composition
of the system it was drawn from, and no settle ever touches a system record.

Skill: when a factor describes the *container* but is consumed per *item*,
compute it at the boundary and copy the summary. The test that catches a
regression is the cheap one: fill the same site twice, and compare the yields
to a hand-computed product.

## 2026-10-22 — Intra movement is a delta-v statistic, never a hull on the galaxy queue

The local trade closure needed the existing DeltaV graph, not another travel
model. Build the body/edge tables at founding into preallocated port matrices,
then couple flow by `1 / (1 + (dv / DV_REF)²)` and tax star-port exports by the
source well. Hohmann time is readout-only on a colony calendar. A repeated
same-time settle must be an exact no-op: freeze inputs, integrate each world
once, apply one simultaneous transfer, then fold. Re-settling after delivery
makes the interval circular and applies its own output twice.

Skill: when two calendars have different units and workloads, do not share a
heap. Statistical intra has no events; if real intra hulls return, their system
clock and queue stay separate from the galaxy's one-event-per-hull scheduler.

## 2026-10-22 — Do not gate factories, or their only UI path, on the system view

Worlds settle whether V is open or closed; opening a picture cannot create the
economy's past. The inverse wiring matters too: an API for founding sibling
worlds was tested but unreachable because Found required a docked ship while V
was observer-only. With only AI-founded one-world ports, the entire local-flow
layer would have stayed invisible in real play.

The narrow fix preserves the camera contract: a docked pilot can open only the
station's schematic with camera movement disabled, the station key owns body
picks and the trade card, and undocking closes it. Do not solve a camera-gating
problem by enabling every system-map route in game mode.

Skill: for a feature with no automatic producer, trace one real user action
from input to state change. A direct API test can pass while the shipped
scenario can never reach the feature.

## 2026-10-22 — A raw `heapUsed` difference is not an allocation measurement

`process.memoryUsage().heapUsed` moves with the collector's schedule: the same
100k-call loop read +1.3 MB, −1.1 MB, +0.8 MB and −0.8 MB at four call counts,
i.e. the delta was noise around zero, not a per-call cost. Asserting a 2 MB
bound on it made the suite flaky rather than strict. Force a collection at both
ends (`v8.setFlagsFromString('--expose-gc')`, then `vm.runInNewContext('gc')`)
and assert retained bytes — and tighten the bound, since the young-generation
slack is gone. Keep a per-call time budget beside it as the churn signal.

## 2026-10-22 — A clock must never re-roll what is already on screen

`renderer.refreshObjects` re-places the whole composite block (`generateObjects`
→ `placeObjects` against the *current* model, members re-seeded from the new
list) every `OBJECT_REFRESH_AGE = 0.02` Gyr of galaxy age. Cluster and HII
members are stars in the same `StarPacked` buffer, so at the top star rate
(99 Myr/s) the sky is replaced about five times a second — the reported "stars
jump in some modes". E4 removed this class of defect for the field (draw once,
*place* by the epoch map) and the object block was left behind because its
placement reads the age-dependent acceptance rates.

Rule: an epoch change may re-solve a model, change a uniform, or gate a scalar.
It may not call a placement function. If a block's *look* depends on the epoch,
re-derive the look bytes for the seats that already exist; if its *existence*
does, gate it per record with a birth time. Anything else shows up as a jump at
whatever rate the clock runs.

Corollary: the fix is also the feature. Once a record carries a birth time, the
same gate that stops the re-roll produces the formation history for free.

## 2026-10-22 — Calibrate the gas against the drawn census, not the SFH

The obvious formation gate is `birth = AGE_REF − age` from the existing age draw
(no new channel, exact at the reference epoch). Measured over 20k stars it piles
2.6–4.2 % of the census at `birth === 0` (the `min(p.age, …)` clamp) and drifts
up to 17 % off `sfhProgress` at intermediate epochs, because the arm gate and the
heating floor are look laws, not time laws. Drawing the birth from the
component window's inverse CDF removes the pile and tracks the SFH to a few
percent, but never *equals* it: the census's component mix is a density fact
while `sfhProgress` is a mass fact.

So do not chase the SFH. Fill a birth histogram once per field draw and define
`gas(T) = 1 − formed(T)·(1 − gasFraction)` over it: exact at both ends, monotone,
one subtraction, and — the point — the gas and the stars on screen are then
complementary by construction, which is the only comparison an eye can make. The
SFH stays the law that says where birth times come from, not what the gas is.

## A rename behind a predicate, and panels that hide by attribute (ui.20)

Replacing a widely-read boolean (`gameMode`, 75 read sites) is safe as one
regex pass **only** because reads and writes were separated first: convert
the handful of assignment sites by hand into the new state machine
(`setWorkspace`), then `\bgameMode\b → isFlying()` everywhere else. The word
boundary keeps `gameModeLine` and `helpBoxes.get('gameMode')` out of the
blast radius — but those string keys are exactly the sites the regex *would*
corrupt if converted blind, so list them before running the pass.

Panels that toggle with `style.display` writers scattered across a file
cannot grow a second owner. Moving visibility to the `hidden` attribute with
one writer (`applyPanels`) needs one CSS line to work at all —
`.panel[hidden] { display: none !important; }` — because any rule that sets
`display` on the element (`.panel { display: block }`) silently defeats the
attribute. The smoke test now pins "no `style.display =` on a panel" so the
second owner cannot creep back.

A table other tests pin *positionally* (route-test's five-element
`SHIP_CLASSES` walk) must never be appended to. A sibling table plus a
spanning lookup (`FREIGHTER_CLASSES` + `classById`, `shipById` untouched)
adds the rows without perturbing a single existing index.

And the one failure mode the Node suites cannot see: `main.js` runs inside
one long `boot()`, so a function that is *hoisted* (callable anywhere) can
still throw when its body reads a `const` declared further down the boot
sequence — temporal dead zone, at page load, with every test green because
no test executes `boot()`. `syncViewRows()` (an early boot statement) calls
`applyPanels()`, whose `panelEls`/`panelBoxes` are built a hundred lines
later. The fix is an explicit readiness latch (`panelsWired`) flipped right
after the block that builds them, with the first real apply kept at the end
of boot. When a hoisted function gains a new dependency, check the earliest
*call*, not the earliest declaration.

## 2026-10-23 — Reserve star channels by the derivation's actual hash convention

A deterministic channel is only independent if it uses the same hash convention
as the rest of that record. `deriveStar` rolls channels as `hash01(seed * 31 + n)`;
`hash01At(seed, n)` is a different stream and does not reproduce those channels.
For the formation birth added in 0.7.1, channel 6 is unused (IMF 1, age 2–3,
evolution 4–5), so `hash01(seed * 31 + 6)` is the right new draw. Also measure
conditional populations before replacing a marginal: an inverse-CDF over the
thin-disc formation window alone erases the existing spatially accepted OB
arm/lane component. Preserve that conditional as an explicit birth branch, then
let its stars age normally.

## 2026-10-23 — A smooth birth gate changes the gas-accounting statistic

A prefix count of `birth <= T` is not the same as the visible census when each
star fades in over a finite interval: births in the final 0.05 Gyr have
fractional gate weight. The gas account must integrate the same smoothstep
presence as the shader and normalize by the reference-epoch sum. That keeps both
endpoints exact while making the between-epoch gas estimate a measured histogram
approximation rather than falsely calling a hard CDF exact.

## 2026-10-23 — A carried census must be drawn in the reference frame

When a field is drawn once and *placed* at later epochs (E4), the draw's
component mix is the census for the whole run. Sampling it from the epoch that
happens to be on the clock makes the run's content depend on where it started:
at `T = 0` the spheroid is 0-size and the disc sits on the heat floor, so
`deliveredMasses` integrates almost nothing and 99.7 % of the draw came back as
halo — a galaxy that could never grow a disc, arms or a bar. Sampling
`modelAtAge(model, AGE_REF)` and measuring the epoch map from that same
reference fixes it, is exact at the reference epoch (where reference ≡ model),
and makes the map continuous by construction (the draw *is* the base). Rule: if
a structure is drawn once and reused at many times, draw it at the one time the
model's constants describe; the clock reaches it only through the placement map.

Skill: diff the component shares of a draw taken at each epoch's extremes. A
share that changes by 100× with the epoch is a draw-order bug, not a model
result.

## 2026-10-23 — Test the page's entry point, not a local re-implementation

The 0.7.3 gas account was inert in the page: `buildBirthHistogram` computed its
reference presence *before* setting the flag `evaluatePresence` guards on, so
the normaliser stayed 0 and `censusGasAt` returned `undefined` forever — while
the test suite passed, because the test built its own histogram and its own
presence loop instead of calling the renderer. Anything that ships behind a
fallback (`?? prior`, `if (x !== undefined)`) can return its fallback silently
for years. Call the shipped function from the harness with the shipped inputs,
and assert that it returns a *value* before asserting what the value is. The
same rule caught the draw-frame bug above only after the account was alive
enough to be printed.

Skill: a feature tested through a re-implementation is tested as prose. Reach
into the module (`renderer.censusFormedAt`) from the harness, and pin the
endpoints with strict equality — the fallback-free path is where the bug lives.

## 2026-10-24 — A per-frame step on a clock must compose

The gas grid's burn is driven by the *epoch delta*, not by wall time, so the
obvious loop step — `m' = m − k·rate·dt` — makes the picture depend on how the
clock got there: the same epoch reached in 60 frames and in 6 000 is a different
galaxy, a slider drag is a third, and a step size that happens to be large
subtracts more gas than the cell has. Writing the burn as `m' = m·exp(−rate·dt)`
fixes all three at once: the analytic solution composes exactly (one 5 Gyr step
lands where 500 × 10 Myr steps land, < 1e-6 in the test), `m` can never go
negative, and the state is a pure function of the epoch, so a rewind is a
re-fill rather than a negative burn. Whenever a quantity is integrated from a
clock a user can drive, ask "is this state a function of the clock's value or of
its history?" — and if it must be the value, integrate the closed form.

Skill: pin the invariant, not the loop. `step(5 Gyr) === 500 × step(10 Myr)`
catches Euler and a wrong `dt` in one assertion, and the same test doubles as the
documentation for why the shader uses `exp`.

## 2026-10-24 — Calibrating a picture to an account: pin both ends, measure the middle

The gas grid had to agree with the F4 census account (§4) without reading back
from the GPU. The shape of the law (arm compression, Schmidt–Kennicutt exponent)
was a modelling choice; the *total* was not. Solving one constant (`burnC`) by
bisection so the grid's total is exactly 1 at `T = 0` and exactly `gasFraction`
at `AGE_REF` turns "looks about right" into two exact endpoints, and makes the
middle a measured error rather than a hoped-for one — a 256-bin histogram of the
per-cell rate makes the whole check O(256) per frame, so the panel can print
`gas Δ` continuously. A zero endpoint is its own case: an elliptical reports
`gasFraction = 0`, and the honest answer is the ceiling with `clamped: false`,
not a bisection walking to a meaningless root and reporting a clamp.

Skill: when a derived quantity must match another subsystem, calibrate *to that
subsystem's endpoints* by construction, then measure the interior with a cheap
histogram; and give the degenerate target (0 here) its own explicit branch so
`clamped` keeps meaning "the fit failed", not "the value is extreme".

## 2026-10-24 — A composable reservoir needs a composable display rate too

An exact mass step is not enough if its consumer reads a history-dependent
auxiliary slot. The gas mass used `exp(−k·dt)`, but `s += (sfr − s) * 0.25`
counted frames and a direct fill reset `s` to zero. As soon as HII emission read
`s`, identical epochs would look different after a jump, a run or a paused boot.
Solve the coupled filter `ds/dT = a·(k·m − s)` analytically too. Its forcing
integral is `(exp(−k·h) − exp(−a·h))/(a−k)`. Evaluate it as
`h·exp(−min(k,a)·h)·phi(|a−k|·h)`, with a small-x series for
`phi(x) = (1−exp(−x))/x`: no cancellation at frame-sized deltas, no singularity
at equal decay rates, no overflow for a long jump. Direct fills and steps must
share that law, including the decaying tail after mass underflows.

Pin **every consumed slot**, not only total mass, across one step, many steps,
direct boot and rewind. Test relative error: an absolute tolerance of 1e-4 can
accept a completely wrong slot whose ordinary values are only 1e-5.

## 2026-10-24 — Normalisation can hide the wrong measure, and a projection can hide the wrong gain

A log-radius grid sampled a per-`dR` mass marginal at equal weights, omitting
`ΔR`. It still normalised to one, and every gas endpoint passed, but the mass was
in the wrong rings. Compare cumulative mass with an independent integral in the
same measure; a conservation check alone cannot see redistribution errors.

The look test then used `height/tan(fov/2)` for **positions**, a formula that was
correct for a billboard's *diameter*, not for the camera's half-height focal
scale. It also sized off axial distance while the shader used Euclidean
distance. The test appeared to justify a gain of 15 000. Correcting the ring
measure and projecting with the actual camera matrix required a gain of 1 800
to recover the intended ~0.068 / ~0.0087 median radiances. Reuse the shipping
camera, keep successful measurement values in the log, and distinguish scalar
pre-colour radiance from luminance. Pixel statistics are not a visual verdict.

## 2026-10-24 — A new visible layer invalidates old black-frame tests

First light's old "zero lit pixels" assertion was right when the renderer had
only stars and nebulae. After gas was drawn it became wrong, while a CPU
fallback could still pass by estimating stellar light alone. Test layers
separately: hide gas to verify the birth gate, then show it for a gas-only
readback, and explicitly **defer** that pixel verdict without a rasterizer.
Check the standalone rig's script list as well as the main page: its missing
gas module silently disabled the new layer. A native null backend can validate
shaders and bind groups but cannot provide pixel evidence either.

Also keep distinct error budgets distinct. `gas Δ` compares the grid's
exponential law with the census CDF; it is not the small histogram approximation
error. Matching two endpoints cannot imply small disagreement between them
(the measured SBb example differs by 0.217 at 5 Gyr). State the two laws and
report their difference rather than calling it GPU drift.

## 2026-10-24 — A coarse grid drawn with a dot per cell is a moiré; draw the reconstruction

The gas frame the first cut produced was a lattice: one radial dot per cell, at
about one pixel, over the whole disc. Two separate mistakes, both visible only in
a browser frame:

1. A *bounded* kernel sized to the cell keeps a light per cell, but its support
   stops at the footprint's edge, so neighbouring cells never meet — the image is
   a dot pattern sampled by the pixel grid, i.e. a moiré whose period has nothing
   to do with the gas. Draw the **reconstruction** instead: the quad spans one
   cell step either side of the centre (±ΔR, ±Δφ) and the fragment is a tent
   (1 at the centre, 0 on every edge). The edge of one cell is the centre of the
   next, where that neighbour's tent is also zero, so the hats sum to one
   everywhere and a 64 × 96 grid reads as one smooth field. Pin it with a flat
   grid: spread over the disc is 3.2 % for the tent and 7.6–7.9 % for the peaked
   kernel, and those two numbers make the regression a test rather than an
   opinion. Widening a sub-pixel cell must divide its peak by the area gained —
   spreading light, never multiplying it.
2. The quad's corners were offset from the *centre's projected* clip position by
   a pixel size. Under the perspective camera that puts the shared edges of two
   neighbours at slightly different screen positions and breaks the tiling exactly
   where the cells are largest. Project each corner from its own local position
   (`R ± ΔR`, `φ ± Δφ`) and let the perspective divide do the work.

Related: a threshold count is not an exposure measurement. The smoke rig's
continuity dip test compared `litPixels` (luma > 4) between epochs with a strict
2 % tolerance. That passes while the gas is visible (226–228 px) and fails the
same code path once 0.7.5 isolates a star-only frame, where 8–10 pixels are above
the threshold and ±1 px is just quantization. Read the smooth integral (luma) for
the dip and hold a count of N pixels to its own shot noise, `3·√N + 2`; keep a
"did not collapse to zero" clause so the test still catches the real failure.

## 2026-10-24 — Evolving an observed catalog needs identity, a reference word and two clocks

A streamed catalog record is an observation, not a complete stellar input. Derive
its missing mass/age from a stable cell/slot key and explicit priors, then use the
existing evolution core; do not replace it with a fresh IMF draw when a cell
restreams. Cache the source packed word at the reference epoch and restore that
word verbatim at `AGE_REF`. This preserves quantized colour, magnitude, flags and
jitter while still allowing the earlier track to be derived. Keep physical
`formedAt` separate from the GPU birth gate: a star younger than the 50 Myr fade
must nevertheless be fully formed at the reference epoch, so the gate birth is
clamped to `AGE_REF − fade` without changing the stellar age used by the track.

The gate and CPU consumers must use the same **global slot** domain. A birth array
that stops at the fixed field/object capacity leaves local/catalog stars visible
at First light even when the CPU helper looks correct. Give curated landmarks a
negative-fade sentinel, and test selection, both search scopes and rings at the
same epoch ladder as the GPU. Local/catalog records can evolve their look without
carrying the positional epoch bits; observed positions must not be moved by the
field's epoch map. Also keep the two dynamic GPU uploads at their own offsets:
reserved local capacity means local and catalog bytes are not one contiguous
range, and a single write can silently put catalog data in the gap. The draw has
the same constraint: use a second instanced draw with `firstInstance` at the
catalog offset, otherwise the GPU never reaches catalog slots after a partial
local block.

A zero-budget smoke suite is a blind spot, not a negative control for catalog
behaviour. The 0.7.7 catalog suite loads the real bundle and checks nonzero local
and catalog residency. All 3,829 bundled records produced deterministic finite
tracks (births 3.39678–13.49998 Gyr) with no sampled luminosity reversal; the
bundle contains only MS classes, so synthetic RG/RGe/WD fixtures are necessary.
Renderer 155/155, selection 51/51, search 39/39, stellar evolution 64/64 and the
full 43/43 suite pass. These results do not substitute for C9: no browser/GPU
executable was available for a new V14a pixel or visual verdict.

## 2026-10-24 — A lane switch is a frame transfer: measure before committing, and carry in the receiving lane's own angle

Switching a simulation between two motion laws is not "re-seed the new law's
state from the input data" — the input data is the *birth* frame, and at any
T > 0 the drawn sky has moved on. The transfer must read the outgoing lane's
closed-form drawn position and invert the incoming lane's reconstruction onto
it. Two ordering rules fall out. **Measure before committing the new mask**: a
dispatch like `engineRecordPosition` evaluates under the *current* mask, so
every "what was drawn" sample must be taken before `setEngine` flips it (the
audit that measured afterwards saw π-rad "errors" that were the new mask
approximating). **Invert in the receiving lane's own parameter**: the friction
field's θ is an in-plane sweep angle offset by the birth azimuth, which equals
the xy azimuth only for the horizontal disc/pattern planes — for the inclined
bar/pressure planes, carrying the xy azimuth put stars on the wrong side of
their tilted orbit (45 kpc worst case; projecting onto `orbitPlane`'s e0/e1
basis made the landing exact to the f32 ULP, and the classic normal wobble
provably drops out because n ⊥ e0/e1).

Quantised lookups can be non-idempotent: `clusterCentreCoord` reads its lattice
base off the input value's own f32 bits, so reducing twice lands on a different
lattice (8.3438 → 8.625 → 9). Never feed such a function its own output; run
the dispatch on the raw bytes so its internal split does the one legitimate
quantisation, and strip the member offset analytically (both lanes add it back
rigidly, so every measured quantity is the centre's).

Metric and tolerance discipline for θ audits: `wrapAngle` returns [0, 2π), so
`|wrapAngle(a − b)|` reads ~2π for equal azimuths — angular errors need the
short-way diff. GPU θ is f32 against a f64 reference, so agreement pins live at
1e-5 rad, not 1e-9 (a 1.19e-7 "failure" was one ULP). And prefer the *exact*
residual bound over an empirical margin: the carried jump is bounded by the two
lanes' own excursions (triangle inequality on the radial laws plus the normal
wobble the reconstruction lacks), which measured +0.004 kpc worst slack — a
guessed 0.15·r plane term would have been both looser and wrong.

Finally, when a GPU sync reads a CPU mirror (`prepare()` syncing landmark θ),
the mirror re-init must happen *before* the regenerate that triggers the sync —
ordering it after let the previous galaxy's integrated azimuths overwrite the
fresh birth seeds.


## 2026-10-28 — Gas Z is not stellar Z

The E6 baseline (`python3 scripts/run.py chemical-baseline`) shows the gas
grid's Z is a time-invariant *relative* radial gradient, while stars receive
a component-specific mass fraction. Gas mass evolves but does not enrich the
cell; mapping one number onto the other without a units and birth-time contract
would silently change both stellar colours and planet generation.


## 2026-10-28 — An empty sky gate can block its own bootstrap

`SKY_NONE` is also the verdict for zero ports; a retry placed inside the trade
clock's `rateY > 0` branch will stop before stars appear. Exercise the actual
clock/gate orchestration, not just a direct retry at a later epoch. An empty
`finalize` has already scheduled its tick, so first-port fleet startup must not
rely on calling `finalize` again.


### 2026-10-29 — Chunked selection must own its camera matrix

`camera.buildViewProj()` returns reused storage, not a snapshot. A multi-frame
picker must copy it before subsequent draws overwrite it. Deadline checks inside
nested block/record loops must return pending, not merely break the inner loop.
Cluster stars live in `starBlocks().blocks[BLOCK_OBJECT]`, not `fieldBuffers()`;
automatic world discovery must explicitly include their identities and member context.

## 2026-10-29 — A positive supply coefficient is not a positive population rate

The colony readout showed `0.7%/y` forever at `P = K`. That number was
`g = coverage/40 − (1 − coverage)/120`, whereas the actual positive ODE is
`dP/Pdt = g(1 − P/K)`. Inspect *both* supply coverage and capacity headroom,
then show the net instantaneous rate and an unrounded headcount so a rounded
million-person label cannot pretend nothing is changing. At a multi-world
port, add `P_world × rate_world` before dividing by total population; applying
one logistic to the port's summed capacity invents room on full worlds.

The sign branch matters too: extending the logistic to `g < 0` makes `P = K`
an exact fixed point even under total starvation. Use exponential attrition
for negative `g` with an `expm1` population integral, then recalculate the
readout *after* stocks and transfers settle. Preserve the supply coefficient
as a separately labelled potential, never call it observed growth.

Skill: derive display rates from the same state and derivative that moves the
simulation; test at the fixed points, not just at mid-capacity.

## 2026-10-29 — A carried angle is not a carried position

The engine switch carried θ exactly and still moved stars by up to 9.7 kpc.
Two different laws can agree on an angle and disagree on everything else: the
friction field rebuilds the radius from the birth anchor through its own
eccentric law, and it has no plane-normal state at all. Measure a transfer
frame's residual *component by component* before deciding it is one lane short:
project the drawn position onto the record's own sweep basis and compare the
in-plane radius and the normal offset separately (here 9.7 kpc radial, 1.4 kpc
normal). Carry every component the reconstruction cannot derive.

The sharpest test of a "the two laws agree here" claim is `T = 0`: both laws are
the birth field at first light, so a switch there must move nothing. The θ-only
carry moved stars by the reconstruction's own eccentric radius (4.8 kpc worst)
and no pin noticed, because every pin ran at `T > 0` where a jump was expected.
Add the degenerate rung to the ladder; a swap that is supposed to be invisible is
the cheapest bug detector there is.

## 2026-10-29 — The WGSL interpreter needs every binding the module reads

`wgsl-exec-check` runs the shipping sprite module through `wgsl_reflect` with
hand-built binding maps. Once the vertex stage reads a new storage lane
(`@group(0) @binding(5)`), *every* sprite fixture must supply it — a missing
binding surfaces as an unrelated-looking `RangeError: Invalid typed array
length` from deep inside the interpreter, not as "binding 5 missing". When a
shader gains a lane, grep the fixtures for the sibling binding (`4: birthBytes`)
and add the new one beside it, then keep one fixture with non-identity data so
the check fails if the shader never reads it.

Also: `array<vec2f>` works in the interpreter, but only via the binding map the
fixtures pass; and a WGSL comment may not contain backticks — the shaders are
JS template strings, so one backtick inside a `//` comment breaks the whole
module with a `SyntaxError` pointing at the comment word.
