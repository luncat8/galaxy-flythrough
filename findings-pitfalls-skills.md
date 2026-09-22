# Findings, Pitfalls & Skills

Append-only notes for LLM agents working on this project. Each entry: date, one-line summary heading, then the detail. Newest at top.

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

`SHADER_PARTS` / `SHADERS` / `WIRED_SHADERS` live at the *end* of `src/render/shaders.js`. A mid-file search-replace that only updates those names can leave the original export intact and append a second copy after leftover WGSL. The file then `require()`s the first export (missing `NEBULA_BILLBOARD`) while a grep of the source still finds the new names. Cut from the first `// Mirror parts` comment through EOF and rewrite a single ending; then `node -e "console.log(Object.keys(require('./src/render/shaders.js').SHADER_PARTS))"` before trusting tests.

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

Now `src/render/shaders.js` holds the shader parts as template strings, concatenated into complete modules, and `wgsl-validate.js` compares constants, function names and structural markers against `src/math/*.js`. Wired and unwired shaders are both validated; only `WIRED_SHADERS` is compiled by the renderer.

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

## 2026-09-22 — Group kinematics are free: rigid patterns cost one select

"The structure should move as a group, not as individual orbits" is not a
performance question when orbits are closed-form: every star already evaluates
the same per-vertex law, and a shared ω (corotation lock inside
R_CR = vFlat/Ω_p) replaces one division with a constant — zero extra ALU, no
per-star state, no CPU pass. Make the lock continuous by construction (Ω(R)
crosses Ω_p exactly at R_CR) so the seam cannot show as a shear ring, and guard
Ω_p = 0 so pattern-less types never freeze.
