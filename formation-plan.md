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
| F5 | **The gas picture is a coarse grid** (64 r × 96 φ × 4 z = 24 576 cells), integrated by a compute pass, ping-pong buffers, **no atomics**. Races allowed where a scatter would need them; the drift is bounded and measured. | do |
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
GAS_RINGS = 64      log-spaced r ∈ [0.02, 1.4] · discRadius
GAS_SPOKES = 96     φ
GAS_SLABS = 4       z ∈ ±2 H(R)
cells = 24 576      · 2 buffers (ping-pong) · 4 f32 slots = 786 KB
```

Four slots per cell: `m` (gas mass in arbitrary units, Σ = 1 at `T = 0`), `Z`
(the metallicity the births left behind, readout only in this series), `w`
(a slowly varying turbulence weight that gives the field its look), and `s`
(the smoothed star-formation rate the last step wrote, for the display).

### 5.2 The step

One compute dispatch per frame when the clock is running, over
`ceil(cells / 64)` workgroups:

```
disp   = Σ_slab m · (1 + β·cos(m·(φ − Ω_p·t) − phase0))      // the arm compression
sfr    = min(m, DISP_EFF · disp^1.5 · dt)                      // Schmidt–Kennicutt
m'     = m − sfr                                               // gas burned into stars
s'     = mix(s, sfr / max(dt, ε), 0.25)                        // display smoothing
```

Every cell is read from buffer A and written to buffer B, one invocation per
cell, so **there are no races at all** and no atomics: the ping-pong pair is what
buys the freedom the brief allows. `Ω_p` and `phase0` are the model's own
(`orbit.instantPatternSpeed`, `arms.phase0`) so the gas compresses along the same
ridge the stars and the nebulae use.

### 5.3 Races, where they are allowed

The allowance is for the *scatter*: if a later slice spawns a visible
star-formation event and debits its mass in the cell it landed in, two events in
one cell in one frame can each read the same pre-frame `m` and over-debit. That
is accepted, with a measured budget:

- the drift is reported in the epoch readout as `gas Δ` (the grid's own sum
  against `gas(T)` from §4),
- it is bounded by `EVENTS_PER_FRAME / cells` and stays under **1 % per Gyr** in
  the measurement §10 pins,
- it never gates anything: each field star's birth and GPU gate are exact,
independent of the gas histogram/grid, so a lost gram of gas can never make a
star appear early or late.

The physics argument is the brief's, and the plan adopts it explicitly: the
model already has dark matter, unmodelled feedback and an unmodelled IMF cut, so
a sub-percent mass leak is inside the theory's own gaps. What it must never do is
show as a visible count difference between the gas and the stars, which the
`gas Δ` readout is there to make impossible to miss.

### 5.4 The look

The grid draws as additive screen-space quads through the existing density-cell
path (path C): one instanced draw over the cells with `m > 0`, each a wide
low-alpha additive splat tinted cold (a dust lane would need an occlusion pass —
not in this series). The composite nebula/HII billboards keep their own layer and
take their *rate* from the local `s` instead of the global scalar when the grid is
live, with `gasNow` as the fallback for any consumer without a grid. At `T =
AGE_REF` the grid is 15 % of the cells' worth of gas and reads as the same dust
the nebula layer already implies; at `T = 0` it is the whole picture.

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
| Atomics for the gas | The ping-pong pair removes the need; the scatter's allowance (§5.3) is cheaper than a serialised atomic path and is measured |
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
| 5 | F5 — the gas grid, the compute step, the drawn cells | 3, 4 | M | `0.7.4: the gas is drawn where the stars are not` |
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
