# 0.7 — formation: the galaxy from gas

The series after the 0.6 evolution work. 0.6 made the galaxy's *structure* a
function of its clock (E1–E4): the spheroid assembles in size, the disc heats,
the arms follow the gas left, and the whole thing is drawn once and *placed* at
the running epoch. What it never changed is the **census**: every epoch shows the
present-day star count, re-tinted. A 0.3 Gyr galaxy therefore looks like today's
galaxy with young colours — there is nothing before the stars.

This series gives the galaxy a beginning: at `T = 0` there is gas and no stars,
and the stars condense out of that gas as the clock runs. The gas becomes a real
accounted quantity instead of a scalar, and the same drawing is used at every
epoch — no re-sample, no step, no jump.

Scope: `src/math/galaxy.js`, `src/math/star-types.js`, `src/math/sampling.js`,
`src/render/star-sprites.js`, `src/render/shaders.js` (one new lane + one gate),
`src/main.js`, the tests. No new data files, no build step, no second star
population, no N-body.

E5 (events) stays deferred — it needs its own object family and a re-sampling
path, and it would fight this series for the same records. See §11.

## 0. Decisions

| # | Item | State |
|---|---|---|
| F1 | **The epoch is a formation history.** Each global-field star carries a *birth time*, drawn once at the field draw; the running epoch shows the stars born so far. The draw itself is the *reference* census (its component shares, truncation and birth law are `AGE_REF`'s), placed at the running epoch by the map — a draw taken at deep time must not bake that epoch's degeneracy into the run (0.7.3a). | shipped 0.7.1, corrected 0.7.3a |
| F2 | **The gate is per-star and GPU-side.** One `f32` birth per global-field star in a storage buffer, one `smoothstep` in the vertex stage, one uniform lane. No per-frame CPU pass, no record rewrite. | shipped 0.7.1 |
| F3 | **The look follows the star's own age** (`T − birth`), not a re-draw of the age distribution at each epoch. `deriveStarWithAge` already exists and is the whole entry point. | shipped 0.7.1 |
| F4 | **The gas account reads the drawn census, including the smooth gate.** One 1024-bin birth histogram per draw; integrate the binned `smoothstep` presence and normalize by its value at `AGE_REF`, then `gas(T) = 1 − formed(T)·(1 − gasFraction)`, with both endpoints returned by name so `gas(AGE_REF)` is the type's own fraction bit for bit. Exact at both ends, with a measured histogram error bound between them. Every epoch landing (drag, live tick, re-draw, boot) goes through one solve, so no path keeps the SFH prior while another uses the account (0.7.3a). | shipped 0.7.3, corrected 0.7.3a |
| F5 | **The gas picture is a coarse grid** (64 r × 96 φ × 4 z = 24 576 cells), integrated by a compute pass, ping-pong buffers, **no atomics**. The cell's burn is an *exact exponential* of the epoch delta (`m' = m·exp(−burnC·boost^1.5·dt)`), so a step composes: one 5 Gyr dispatch lands where 5 000 of 1 Myr land, a rewind is a re-fill rather than a negative burn, and the grid is a function of the epoch instead of the frame size. `burnC` is calibrated at draw time so the grid's total is exactly 1 at `T = 0` and the type's own gas fraction at `AGE_REF`; a 256-bin rate histogram makes the drift against F4's account an O(256) read (`gas Δ`), and the shader and the model are pinned against each other by `wgsl-exec`. | shipped 0.7.4 |
| F6 | **The smoothness contract comes first** (§6). No epoch may re-sample, re-roll or re-place anything that was already on screen. The object block's 0.02 Gyr re-roll is the one confirmed jump and is fixed by this series. | do |
| F7 | **Deep time is a real epoch.** `AGE_MIN` 0.2 → 0, with the zero-factor traps in §7 resolved rather than clamped away. | shipped 0.7.2 |
| F8 | Per-star gas particles; a second star population spawned by the gas; N-body; a re-sample per epoch; money | **refused** (§9) |

## 1. What is wrong today

Four facts, all measured, all load-bearing for the design:

1. **The census is present-day at every epoch.** `view.regenerate` draws N stars
   once; `sweepEpochLook` re-derives their *look* per epoch but never their
   existence. An epoch is a colour grade, not a history.
2. **The gas is a scalar.** `populations.gasNow` scales the nebula/HII rates and
   the arm contrast. It is a good number on a good law
   (`gasFractionAt = gasFraction + (1 − gasFraction)(1 − sfhProgress)`), and at
   `T = 0` it is exactly 1 — the model *already* says "only early gas". Nothing
   downstream can show it because nothing downstream can be a gas.
3. **The object block re-rolls while the clock runs.** `refreshObjects` calls
   `generateObjects` every `OBJECT_REFRESH_AGE = 0.02` Gyr, which re-runs
   `placeObjects` against the *current* model and re-seeds every member from the
   new object list. Cluster members and HII members are stars in the same
   buffer. So every 0.02 Gyr, a slice of the visible sky is replaced with
   different stars at different positions, and every nebula billboard jumps. At
   the top star rate (99 Myr/s) that is **five jumps a second** — the reported
   "stars jump in some modes".
4. **`AGE_MIN = 0.2` clamps the start away.** The interesting epoch is below it.

## 2. The birth channel (F1)

### 2.1 What a star's identity becomes

A record's star is a point of the census with three independent facts:

```
position  (x, y, z)   the density field's draw — unchanged
look      mass/class  the IMF channel — unchanged
time      birth       NEW: when this star formed, in Gyr
```

`birth` is drawn once, at the field draw, from a deterministic hash channel of
the same per-star seed every other draw uses:

```
u     = hash01(fieldStarSeed(seed, i) * 31 + 6)       // channel 6; channels 1–5 remain the IMF/look
birth = formationTimeAtReference(modelRef, component[i], u) // absolute Gyr, [0, spanRef]

// One existing spatial subpopulation is kept as an explicit conditional draw:
// if the reference-model thin-disc arm + gas-lane gate accepts this star using
// its existing channels 2 and 3, birth = AGE_REF − armAge (armAge ≤ 0.3 Gyr).
// Otherwise the component-window inverse-CDF above applies.
```

with the window table read against the **reference** span, exactly as
`spheroidProgressAt` reads it:

```
spanRef = sfhSpanAt(AGE_REF, quenchTime)
xEnd    = spanRef / tauSfh
q0 = F(w0·xEnd), q1 = F(w1·xEnd)      F(x) = 1 − e^−x(1 + x)   (galaxy.sfhCumulative)
birth = tauSfh · F⁻¹(q0 + (q1 − q0)·u)
```

For the general field population, `FORMATION_WINDOW[2c], [2c+1]` is the
component's own slice, so the assembly order is automatic: halo `[0, 0.25]`,
spheroid `[0, 0.45]`, thick `[0.10, 0.65]`, thin `[0.25, 1.00]`. The CPU
reuses `star-types.js`'s existing 1025-entry inverse-CDF table, keyed by the
reference span; it does not run a second per-star bisection. The arm/lane
conditional is required because the present-day OB population is explicitly a
spatially accepted subpopulation outside the broad thin-disc window. Both paths
guarantee `birth ≤ AGE_REF`; the arm path also avoids the old `age = 0` pile.

### 2.2 Why not reuse the drawn age (measured, and rejected)

The obvious cheap form is `birth = AGE_REF − age` from the existing
`sampleLocalAge`. It needs no new draw and is exact at `AGE_REF` by construction.
It is wrong for two reasons, both measured on 20 000 stars per type in the
formation investigation; `star-types-evolution-test.js` now owns the regression
checks for the two branches:

| type | stars with `birth === 0` | census at T=2 vs `sfhProgress` | T=8 |
|---|---|---|---|
| SBb | **4.2 %** | 0.101 vs 0.082 | 0.739 vs 0.632 |
| SBc | **2.6 %** | 0.052 vs 0.053 | 0.595 vs 0.525 |
| S0 | 0 % | 1.000 vs 1.000 | 1.000 vs 1.000 |

(*Variant A*: `birth = AGE_REF − age`. The `birth === 0` column is
`sampleLocalAge`'s `min(p.age, …)` clamp piling stars at "born at the beginning",
which would flash ~4 % of the sky on at the first frame; the census column is the
age-based census drifting off the SFH because the arm gate and the heating floor
are not time laws.)

| type | census at T=2 | T=4 | T=8 | zero-pile |
|---|---|---|---|---|
| SBb | 0.045 | 0.207 | 0.703 | 0 % |
| SBc | 0.017 | 0.114 | 0.558 | 0 % |

(*Variant B*: applying the component-window inverse-CDF to every thin-disc
star.) It removes the pile entirely and tracks the SFH to within a few percent,
but it **erases the spatially gated arm-young channel**: the 0.3.1 population is
not a generic draw from the broad thin-disc window. The implementation is the
minimal hybrid of that measured law and the existing spatial prior: the accepted
arm/lane subset carries `AGE_REF − armAge`, while all other stars use Variant B.
This preserves the established OB ridge without shifting that population into
the wrong formation window. The census still need not equal `sfhProgress`,
because component mix is a *density* fact and `sfhProgress` is a *mass* fact;
F4 calibrates gas against the drawn census, not against that mass curve.

Rejected alternative, recorded so it is not re-tried: *use the drawn age and
shift the arm-gate population forward in time* — the arm's OB stars are young at
`AGE_REF` by construction, so winding the clock to 2 Gyr would delete every OB
star and leave a galaxy with no young population at all, which is the exact
opposite of what a young galaxy should look like.

### 2.3 The look law (F3)

At epoch `T` a star's age is its own elapsed time:

```
age(T) = max(0, T − birth)
```

and its look comes from `starTypes.deriveStarWithAge(modelNow, seed, component,
R, distToArm, age(T), out)` — the existing coeval entry point the composite
objects already use. Three consequences worth stating:

- **A star ages monotonically.** Today `sweepEpochLook` calls `deriveStar`, which
  re-draws the age from the *current* model's clock; the arm branch
  (`min(p.age, u³·0.3)`) never ages at all. Under `T − birth` every star has one
  lifetime and the whole population ages together, which is what makes a run
  read as evolution rather than as a sequence of unrelated samples.
- **The arm gate remains a birth-selection law, then ages normally.** The
  reference model's existing arm/height acceptance selects the spatially
  correlated young subset once. Its birth is `AGE_REF − armAge`; all accepted
  stars then age by `T − birth`, so the ridge population fades and evolves rather
  than being re-sampled or made perpetually newborn. A pure component-window
  draw would lose this observed correlation (measured in the first trial).
- **`AGE_REF` is statistically, not bit-exactly, preserved.** At `T = AGE_REF`
  every gate is 1 but the *draw* of ages moves from `sampleLocalAge` to
  `deriveStarWithAge(AGE_REF − birth)`. Class histograms, mean luminosity and the
  arm concentration of OB stars must land inside the tolerances `star-types-
  evolution` already publishes (§10); per-star literals that pinned one drawn
  age must be re-pinned to the new law. This is the series' one intentional
  break with the "exactly 1 at `AGE_REF`" contract, and it is confined to looks:
  the density field, the geometry and every position pin are untouched.

## 3. The gate (F2)

Per-global-field-star `f32` birth in a storage buffer, uploaded once per field
draw:

```
BIRTH_BYTES = 4 · proceduralCount          // 1.2 MB at 300k, one upload per draw
```

This first slice gates the global procedural census only. Gaia/catalog and named
landmarks remain observed data; composite-object members keep their own event
ages. The separate streaming local gap-fill remains outside this buffer in 0.7.1
because its residency lifetime is camera-driven, not the global census. Do not
claim a fully empty *hybrid/local* frame until that dynamic block gains carried
births and an epoch look sweep.

The vertex stage reads it and computes the presence:

```
vis = smoothstep(birth, birth + BIRTH_FADE_GYR, epochAge)
```

`BIRTH_FADE_GYR = 0.05`: at the top star rate that is a half-second fade, and it
is half an `AGE_STEP` (0.1 Gyr), so a fade can never span two epoch quanta and
the gate is smooth even when the clock is sampled. A faded star keeps its
position — it does not slide in from anywhere — so the fade is the only visual
event, and it is invisible at any sane rate.

The gate multiplies into the existing sprite brightness (path B); a fully
gated star returns the existing off-clip vertex before rasterization, so it
costs only its vertex invocation. There is no indirect draw in this renderer to
claim as an optimization.

**Test-side mirror.** `orbit.epochMap` gains nothing; the gate is a separate
scalar read, and the CPU mirror (`gateAt(birth, age)`) is one function used by
the picker, the label layer and the tests — the same one-copy rule the movement
lanes already follow.

## 4. The gas account (F4)

At the field draw, one pass over the census fills a 1024-bin birth histogram
over `[0, spanRef]`. A hard prefix count is not sufficient: the GPU renders a
smooth 0.05 Gyr gate, so stars in the fade contribute fractional presence even
before they are fully formed. The view census is therefore the sum of the same
gate the vertex stage uses, normalized to the drawn reference census:

```
bin(birth)       → count[k]                         // k = 0…1023
presence(T)      = Σ count[k] · smoothstep(binCentre[k], binCentre[k] + FADE, T)
presenceRef      = presence(AGE_REF)
formed(T)        = presence(T) / presenceRef
gas(T)           = 1 − formed(T) · (1 − gasFraction)
```

The bin approximation must be measured against the exact O(N) gate sum at draw
time; the acceptance bound is **0.25 % absolute** over 0…`AGE_REF`, and the
histogram is refined if it misses. This is a small fixed O(1024) evaluation per
frame, not an O(N) pass. Both endpoints are exact by construction: every gate
is 0 at `T = 0`, so `gas(0) = 1`; at `AGE_REF`, `presence/presenceRef` is the
same stored sum divided by itself, so `gas(AGE_REF) = gasFraction`. It is
monotone because every `smoothstep` is monotone. `gas(T)` replaces
`populations.gasNow` only for the field's gas picture; it is calibrated to the
visible (fractionally gated) census, not claimed to be the model's SFH mass.

`model.populations.gasNow` (the SFH form) stays: it is the *model's* gas, the
number the type table and the evolution pins describe, and the one a headless
consumer with no field must read. The field's `gas(T)` is a *view* quantity that
is calibrated to it at both ends (`0` and `AGE_REF`) and free to differ in
between, which is the licence §2.2's table measures.

## 5. The gas picture (F5)

### 5.1 The grid

```
GAS_RINGS = 64      log-spaced r ∈ [0.02, 1.0] · discRadius
GAS_SPOKES = 96     φ
GAS_SLABS = 4       z ∈ ±2 H(R), slab centres at ±0.5 H and ±1.5 H
cells = 24 576      · 2 buffers (ping-pong) · 4 f32 slots = 384 KB each
```

Four slots per cell: `m` (mass in units where the grid sums to 1 at `T = 0`),
`Z` (relative enrichment, readout only in this series), `w` (a stable
per-cell turbulence weight that gives the splats their texture) and `s` (the
smoothed star-formation rate the last step wrote, for 0.7.5's local nebula
rates). The index is `(ring·SPOKES + spoke)·SLABS + slab`, so a column's four
slabs are adjacent and the step reads its own column without striding.

The ring range stops at the field's truncation radius (`discRadius`) rather than
the 1.4× the first draft used: beyond it the sampler draws no stars, so gas there
would be a picture of nothing. The width of a cell is its own footprint — the
larger of the radial step and `R·Δφ` — which is also the splat size, so the gas
disc keeps the grid's geometry at any camera.

### 5.2 The law

```
boost  = max(0, 1 + amp·cos(m·φ − K·ln(R/Rs) + phase0))   the field's own ridge
rate   = burnC · boost^1.5                                 Schmidt–Kennicutt on the
                                                           crest's compressed density
m'     = m · exp(−rate · dt)                               exact, composes
s'     = s + (sfr − s) · GAS_SMOOTHING                     the display rate
```

`Ω_p` and `phase0` are the model's own (the ridge constant `K = m/tan(pitch)`,
the arm amplitude, `Rs`), so the gas burns where the stars' arms and the nebulae
are. The cell is a *pattern-family* body: it keeps its arm phase for the whole
run and is drawn rotated by the same closed form the nebula layer uses
(`camera.dynA.z·starTime + waveB.w`) plus the epoch's ridge re-anchor and heat
scale (`camera.epoch.x/z`). The phase is therefore never baked into a cell and a
slider jump cannot leave the gas pattern behind the arms.

Why the exponential and not a per-frame Euler step of a linear rate: the step is
driven by the *epoch* (a frame's delta of star time), and Euler would make the
grid depend on the frame size — the same epoch reached in 60 steps and in 6 000
would show different gas, and a slider drag would be a different galaxy. `exp`
composes, so the grid is a pure function of `T`. A clock that runs *backwards* is
a re-fill (`fillGrid` at the new age, 24 576 exps ≈ 1 ms), never a negative burn.

### 5.3 The calibration and the readout

`burnC` is solved once per draw by bisection over `[0, 64]` against the two
endpoints the F4 account requires:

```
Σ m0·exp(−burnC·rate·0)        = 1            (First light: all gas)
Σ m0·exp(−burnC·rate·AGE_REF)  = gasFraction  (the type's own present-day gas)
```

Between them the crests empty first — after the reference span the arm ridge
holds less gas than the inter-arm troughs, which is the picture the slice exists
for. Because the two endpoints are pinned and the in-between shape is the local
law, the drift against `censusGasAt` is small and measured: a 256-bin histogram
of `rate` weighted by `m0` makes `totalAt(age)` an O(256) sum, so the **Formation
checks** panel prints `gas Δ` (the grid's total minus the account) on every
frame (`ScenarioLib.liveLine`), and the test pins the histogram against the exact
O(24 576) sum.

The grid's total is *not* read back from the GPU: the readout integrates the same
calibrated law on the CPU, which is exact at both endpoints by construction. A
GPU readback would need a reduction pass (the plan refuses atomics) for a number
that is already known analytically.

### 5.4 The look

The grid draws as additive screen-space quads into the same `rgba16float`
intermediate as the stars and the nebulae: one instanced draw over all cells,
each a wide soft splat tinted cold (`GAS_COLOR`), sized by the cell's footprint
and floored at 2 px so a distant galaxy stays a haze rather than a moiré. The
flux is the cell's mass times a look gain (`GAS_GAIN_DEFAULT`), modulated by its
turbulence weight; a cell below the flux floor returns the hidden vertex, so a
burned-out cell costs only its four vertex invocations. The gain was picked from
a CPU projection of the grid at a 640 × 400 frame: with 15 000 the median gas
pixel is 0.10 linear at `T = 0` (the whole picture, the stars gated off) and
0.015 at `AGE_REF` (a faint haze under the present-day sky). It is a look
constant like `MIN_ALPHA`, not a model number, and the browser pass (V14) owns
its verdict.

The composite nebula/HII billboards keep their own layer and still read the
global scalar; taking their rate from the local `s` is 0.7.5.

### 5.5 Races

There are none: every cell is read from buffer A and written to buffer B by one
invocation, and the ping-pong pair is what leaves room for a future scatter (a
star-formation event debiting the cell it landed in — 0.7.5 or later). Nothing in
this slice scatters, so nothing drifts: the `gas Δ` readout measures the
calibration's own histogram error (< 0.25 % of the grid's mass), not a race.

### 5.6 The surface

- `src/math/gas-grid.js` (one API object): the constants, the cell geometry
  (`cellRadius`, `cellAzimuth`, `cellHeight`, `ringEdge`, `cellBoost`), the
  account (`initialize`, `fillGrid`, `step`, `total`, `totalAt`, `totalAtExact`).
- `renderer.gasGridInfo()`, `renderer.gasAccountAt(age)`,
  `renderer.setGasVisible(on)`; `state.gasCells/gasSteps/gasAge/gasVisible/
  gasTotal/gasDrift` for the HUD.
- `src/render/shaders.js`: `gas-common` (the struct, the cell geometry and the
  arm law), `gas-step` (compute, 64 invocations per workgroup, `ceil(cells/64)`
  workgroups) and `gas-cell` (the splats). The camera lane is one shared
  `CAMERA_UNIFORM` part, concatenated into the nebula and gas modules.
- Preset field: none. Turning the gas on or off is a look, and a preset that
  rebuilt the field for it would break R1.

## 6. The smoothness contract (F6)

The series' first rule, because it is the user-visible requirement: **nothing
that is already on screen may be re-sampled, re-rolled or re-placed because the
clock moved.** Stated as rules, each with its pin:

| # | Rule | Pin |
|---|---|---|
| R1 | An epoch change is a model re-solve and a uniform. No `regenerate`, no re-draw, ever. | `renderer-test` counts draws across 200 epoch steps |
| R2 | The gate is a scalar read; a star's position, key and birth never change after the draw. | buffer diff across a run |
| R3 | **Composite objects are carried, not re-rolled.** `generateObjects` runs once per draw; the object block is carried unchanged because member looks use their own fixed object age. No epoch refresh or re-placement. Placement depends on the base epoch, never the running one. | object seats byte-identical across a 1 Gyr run |
| R4 | An engine switch maps the current θ into the new engine's frame instead of re-seeding from birth positions. | max per-frame delta across a switch ≤ the orbit law's own |
| R5 | A new star budget is a new draw (a different N is a different census) — the one honest re-sample, and it is a user action, not a clock event. | — |
| R6 | Every epoch-varying quantity is continuous in `T`: the map's three terms, the gate, the look sweep, the gas grid. Discontinuities are bugs, not taste. | continuity sweep at ΔT = 1e-3 |
| R7 | The pattern phase stays an accumulator (`orbit.advancePatternPhase`); a step never re-derives it from `Ω_p·T`. | pattern-angle continuity |

R3 is the fix for the confirmed defect in §1.3 and the reason this section comes
before any of the new visuals. R4 replaces the `initSimpleLandmarks` re-seed on
an engine switch (`orbit.setEngine`) with a θ-map; the CPU mirror's
`simpleLandmarksRebind` already knows how to carry a frame, so the switch asks
it for a transfer instead of asking for a reset.

## 7. Deep time (F7)

`AGE_MIN` 0.2 → 0, so `Evolve` starts at pure gas (135 steps instead of 133).
The laws degenerate at 0 and each degeneration is a trap that must be resolved
by *meaning*, not by a clamp:

| factor at `T = 0` | value | what it must mean | resolution |
|---|---|---|---|
| `sfhProgress` | 0 | nothing has formed | correct as-is; gas = 1 |
| `spheroidProgress` | 0 | no bulge | `spheroidSize = cbrt(0) = 0` → axes 0. `orbit.solveEpochParams` must read a 0 axis as **absent**, not as an identity (`spheroidA > 0` guard already exists — pin that a 0-size spheroid maps nothing, and that the bulge's stars are all gated off by birth anyway) |
| `meanAge` | 0 | no population | `heat = 0` → `H = 0`, and `discHeightAt` divides by it. Floor `heat ≥ HEAT_FLOOR = 1e-3`; the gate hides the stars regardless, and the floor keeps the *geometry* finite for the picker and the label layer |
| `gasRatio` | `1/gasFraction` | gas-rich by the type's own inverse | `armContrast` saturates at `ARM_CONTRAST_MAX`; already correct, pin the saturation at `T = 0` |
| `barPatternSpeed` | re-derived from a 0-length bar | no bar | `omegaPattern = 0` at a 0-size spheroid, and the ridge keeps its authored base (the `delta === 0` guard) |
| `F⁻¹(q)` for a quenched type | window start ≥ span | no births before the window | `birth` clamps to `[w0·spanRef, w1·spanRef]`; a quenched S0's first birth is at its own window, not at 0 |

## 8. Model surface

- `model.populations.formQ` — unchanged (the compressed windows the population
  tier reads).
- `model.populations.formQ` remains the live-epoch window table. Birth sampling
  resolves the reference span once per field draw, reuses the existing SFH
  inverse table, and applies the arm/lane conditional only to accepted thin-disc
  stars.
- `renderer.starBlocks().formation` — `{ births: Float32Array, age, count,
  gateAt }`, stable storage beside the carried field. `fieldBuffers().birth`
  exposes the same typed array to CPU consumers. Epoch changes update `age` only;
  a new field or changed formation parameters rewrite births.
- `orbit.gateAt(birth, age)` — the one CPU mirror of the vertex stage's
  `smoothstep`; picking, selection rings and search ignore a fully absent field
  star just as the vertex stage does.
- The shader reads one storage buffer and the fourth vec4 uniform lane after the
  existing epoch lane. `renderer.setEpoch` still updates uniforms only; the gas
  account/grid remain later slices.

Preset field: none. Formation is not a setting — it is what an epoch *is*; the
existing `age`, `evolve` and `stars` fields already place a run.

## 9. Refused, with reasons

| Idea | Why not |
|---|---|
| Per-star gas particles (`N` gas points, one per star) | 300k gas points to draw a smooth field is two orders of magnitude more work than 24k cells for the same picture, and it makes the gas a second star buffer to keep in step |
| Spawn a new star population from the gas | The census is fixed at the draw; a spawning population would need a new key space, a new picker and a new label path — and it is the re-sample this series exists to remove |
| Re-sample the field when a star is born | The one thing that causes the jumps. The gate is a scalar for exactly this reason |
| True N-body or a gravity solver | Out of scope since 0.1; the density field is the source of truth |
| Atomics for the gas | The ping-pong pair and one invocation per cell remove the need; nothing in this slice scatters, and a serialised atomic path would be slower than the read A / write B pair for a grid this size |
| A dust/occlusion pass | A different render path (depth, alpha), a different series |
| Money, prices | F4 in `trade-3-plan.md`, unchanged |
| E5 events folded in here | Different records, different re-sampling path — see §11 |

## 10. Validation

Birth-law regression checks extend `experiments/star-types-evolution-test.js`
(already registered in `field-tests`); GPU buffer, uniform and smoothness checks
extend `experiments/renderer-test.js` and `experiments/wgsl-validate.js`. The
later gas-account and grid slices will add their own focused experiments.

- **Birth law.** General stars are monotone in channel 6 and inside the
  component's reference window; arm-selected thin stars are within the final
  0.3 Gyr. Every birth is finite and `≤ AGE_REF`, the channel-6 draw is
  deterministic and independent of channels 1–5, and the two census tables of
  §2.2 remain the measured alternatives rather than claims about the hybrid.
- **Gas account.** Endpoints are exact (`gas(0) = 1`, `gas(AGE_REF) =
  gasFraction`), monotone in `T`, `gas + formed = 1` inside 1e-12, the 1024-bin
  gate-weighted histogram is within 0.25 % absolute of the exact O(N) reference
  over the full age range, and its per-frame evaluation stays under 1 ms.
- **The gas grid (F5).** The grid is the size the CPU model draws; the weights
  are normalised and empty past the truncation; the calibrated total is 1 at
  `T = 0` and the type's gas fraction at `AGE_REF` for every type; the total is
  monotone in `T`; one 5 Gyr step lands where 500 × 10 Myr steps land (< 1e-6);
  the crests hold less gas than the troughs after the burn; the 256-bin
  histogram is within 0.25 % of the exact sum; the turbulence slot is
  deterministic in the draw seed. The renderer half runs on the mock device: two
  buffers at the model size, one draw upload, one dispatch per epoch delta and
  none when the clock is frozen, the ping-pong swap, the draw reading the buffer
  the step wrote, a rewind re-filling instead of burning backwards, the uniform
  lanes, `setGasVisible`, and `dispose`. `wgsl-exec` executes the shipping
  `gas-step` and `gas-cell` against the same model (mass within 2e-4 relative,
  the splat at the geometry the CPU draws, an empty cell hidden).
- **Gate.** `gateAt` is 0 at `birth`, 1 at `birth + FADE`, monotone and
  continuous through the fade. `wgsl-exec` compares the WGSL `smoothstep` to a
  single-precision CPU replay within f32 tolerance over 10k (birth, age) pairs.
- **Smoothness (R1–R4, R7).** 200 epoch steps with no `regenerate`; object seats
  byte-identical over 1 Gyr; the max per-frame positional delta of both blocks
  inside the orbit law's own bound; a θ-map engine switch inside the same bound;
  no `Ω_p·T` re-derivation.
- **Deep time.** Every row of §7 checked at `T = 0` for all types: no `NaN`,
  no division by zero, a 0-size spheroid mapped as absent, `heat` at its floor.
- **Downstream.** `star-types-evolution` (look tolerances re-pinned where §2.3
  moves them), `galaxy-evolution` (fields untouched), `planet-gen` (generator
  tables untouched; field-star inputs now use the carried birth time), `renderer`,
  `m1-smoke` (the new wiring), plus `all-tests` before the series closes.

No visual verdict is claimed. The browser rows (a pure-gas frame, a fade, a run
through 1 Gyr with no jump, the gas picture at 1280×800) go on
`deferred-browser-visual-plan.md` as V14, and they are driven from the
**Formation checks** panel (`ui.21`, `src/core/scenarios.js`): one press per row
sets the clock, the epoch and the camera, and the panel's live line reports the
built epoch, the formed share, the view gas, the arm contrast, the bulge size and
the field draws since the row started — so a run that re-sampled or fell back to
the SFH prior reads wrong on screen instead of only in a test.

Two renderer wiring defects found while building that panel are fixed in
`0.7.3a` (`archive/0.7.x-worklog.md`): the field was sampled in the running
epoch's frame (a `T = 0` draw carried a 99.7 % halo census for the whole run),
and the gas account's reference sum was computed before its histogram was
marked valid, so `censusGasAt` always returned `undefined` and the F4 view gas
never reached `solveEpoch`. Tests now draw a second renderer at `AGE_MIN` and
pin the reference mix, the identity map back at `AGE_REF` and the account's
exact endpoints.

## 11. E5 stays deferred

E5 (minor mergers, tidal streams, a starburst episode) needs a new object family
and a re-sampling path — the two things §9 refuses here. Doing both at once would
mean two different stories about how a record appears. It closes after this
series, against the same two rules: carried, never re-rolled.

## 12. Order, size, commits

| Order | Item | Depends on | Size | Commit |
|---|---|---|---|---|
| 1 | F6 R1–R4, R7 — the smoothness contract, the object block carried instead of re-rolled | — | S–M | `0.7.0: the clock stops re-rolling what is on screen` |
| 2 | F1–F3 — the birth channel, the gate, the look by elapsed time | 1 | M | `0.7.1: a star appears when its gas became it` |
| 3 | F7 — deep time: `AGE_MIN` 0 and the six degeneracies | 2 | S | `0.7.2: the galaxy starts as gas` |
| 4 | F4 — the drawn-census gas account and its readout | 2 | S | `0.7.3: what is not a star is gas` |
| 5 | F5 — the gas grid, the compute step, the drawn cells | 3, 4 | M | `0.7.4: the gas is drawn where the stars are not` — shipped |
| 6 | nebula/HII rates from the local grid, browser rows | 5 | S | `0.7.5: the nebulae eat where the gas is` |

Slice 1 lands first and alone: it is the reported defect, it needs no new
buffer, and it makes every later slice verifiable by eye.

## 13. Docs

- `evolution-plan.md`: E5 → **deferred** with the reason above; the "Later
  milestones" list points here.
- `plan.md` §19: index this file under the open series.
- `AGENTS.md`: the `src/math/star-types.js` entry gains the birth law; the
  `src/render/star-sprites.js` entry gains the gate and the gas grid.
- `README.md`: *galaxy shape stability* / current capabilities gain "the galaxy
  starts as gas and the stars condense out of it; an epoch is a census, not a
  tint".
- `findings-pitfalls-skills.md`: "a clock must never re-roll a record" and
  "calibrate the gas against the drawn census, not the SFH".
- Worklog: `archive/0.7.x-worklog.md` from slice 1.

## 14. Risks

| Risk | Mitigation |
|---|---|
| The look re-pin (F3) moves published colour/class numbers | §10's tolerance list is checked *before* the slice lands; the movement is recorded as a table, not absorbed silently |
| A fade of 300k sprites reads as a global flash | `BIRTH_FADE_GYR` is half an epoch quantum, so fades are interleaved rather than coincident; the browser row checks it |
| The gas grid disagrees with `gas(T)` | `gas Δ` in the readout; §10 pins the drift under 1 % per Gyr, and nothing downstream gates on the grid |
| A 24k-cell dispatch per frame costs more than it looks | ping-pong, one invocation per cell, no atomics; measured at 300k stars against the existing ~0.67 s re-sample the series removes — the budget is 0.5 ms |
| Deep time exposes a latent divide-by-zero elsewhere | §7's table is exhaustive over the epoch factors; the `field-tests` suite runs every type at `T = 0` |
| The object-carried fix changes today's object mix | R3 pins the *seats*; the mix at the base epoch is unchanged by construction, and `object-placement` keeps its pins |
