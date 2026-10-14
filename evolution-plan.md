# Galaxy evolution over time (0.6 series)

## Goal

The type table describes **present-day** galaxies: every anchor is an observed value
at the reference epoch (`AGE_REF`, 13.5 Gyr). The age slider already re-solves the
*population* clock (0.3.3: the SFH, every star's age, the gas left, the object mix),
but not the *shape*: today an Sb at 2 Gyr is today's Sb whose stars are young — same
bulge, same bar, same arm contrast, same disc thickness. A real 2 Gyr Sb is a
different object: gas-rich, arm-dominated, thin, with little or no bar.

This series makes the galaxy's structure a function of its own clock, then lets that
clock run on the star-time axis so the galaxy can be watched evolving.

The series' rule is the one 0.3.3 established for the population tier: **the epoch
scales the reference-epoch galaxy, it never re-authors it.** At `AGE_REF` every epoch
factor is exactly 1, so today's galaxies — and every pin in the suite that describes
them — are unchanged. This is not a re-tune of the density field.

## Contract decisions

1. **One clock.** The epoch numbers are solved from `(T, tauSfh, age)` — the same
   three numbers the population tier already uses — and from the same
   `FORMATION_WINDOW` table. There is no per-type evolution table and no second clock
   that could drift from `populations.gasNow`. E2 runs that clock on the star-time
   axis — the same `dt` the stars integrate with — so the epoch has no rate of its
   own either.

2. **Structural consistency.** The *population* tier keeps reading the
   span-compressed windows `solvePopulationClock` writes into `populations.formQ`
   (`sfhSpanAt(age, quenchTime)`): a young galaxy's stars form on its own, compressed
   schedule, which is what keeps its halo oldest and its thin disc youngest at any
   age. The *structure* tier cannot use those windows — a compressed schedule is
   self-similar, so a window measured against itself says the same thing at every
   age and can only scale the galaxy's total (measured and rejected below). It reads
   the same `FORMATION_WINDOW` table against the **reference** span, which is the
   only form that expresses *how much of each component has assembled* and is still
   exactly 1 at `AGE_REF`.

3. **The reference epoch is exact, not approximate.** Every factor is a ratio of the
   same expression evaluated at the same point, so it is `1` in IEEE arithmetic, not
   `0.9999999`. Scaling a value by exactly 1 is exact, so an `AGE_REF` model is
   bit-identical to the pre-0.6 model. Anything that cannot be made exact at the
   reference epoch (a re-solved length, a re-anchored ridge phase) is deferred to a
   milestone that states the exact-zero form it uses — see E3.

4. **Scale, do not re-author.** E1 multiplies amplitudes, dispersions and scale
   heights. It never changes a length, an angle, or a profile exponent, so every
   derived quantity (`dynamics.omegaPattern`, `dynamics.loopRatio`, the arm ridge
   coupling `arms.minRadius`/`phase0`) stays exactly as the type table solves it and
   no consumer can disagree with the field. One width does follow the field by
   construction: `density.armRidgeWidth` is `ARM_RIDGE_FRAC·λ/(1 + arms.amp)` read
   live, so the newborn lane narrows as the arms strengthen — which is the lane the
   O/B stars, the nebulae and the HII regions are placed in, so it is the field's own
   answer and not a second decision.

5. **No WGSL growth.** Every number the shipped tier moves is already packed per
   model (`thin`/`thick` H and amp, `spheroidShape.amp`, `arms.amp`, and the disc
   dispersions in the orbit block). The shader's density mirror reads the same
   numbers, so E1 adds no constant to WGSL and `wgsl-validate` stays a structural
   check.

6. **An epoch change is a geometry change.** `sameGeometry` already compares the
   numbers the GPU receives, so once the epoch moves them, an age step re-samples
   the field instead of only rewriting records. That is the correct outcome (the
   field *is* the epoch) and it is why the runtime coupling in E1b exists.

## E1 — the epoch tier (shipped)

### The clock

Three derived numbers per model, solved in `galaxy.js`, beside the existing
population clock (no consumer computes its own):

```
x(t)        = min(t, quenchTime) / tauSfh            span-compressed time
F(x)        = 1 − e^−x (1 + x)                       galaxy.sfhCumulative
M1(x)       = 2 − e^−x (x² + 2x + 2)                 first SFH moment
```

* **`spheroidProgress`** — the spheroid's assembly, from its own window
  `FORMATION_WINDOW[bulge] = [0, 0.45]`, read against the *reference* span:

  ```
  spheroidProgress = [F(min(age, 0.45·span_ref)/τ) − F(0)]
                   / [F(0.45·span_ref/τ) − F(0)]
  span_ref = sfhSpanAt(AGE_REF, quench)
  ```

  Both numerator and denominator use the same expression at `AGE_REF`, so the value
  is exactly `1` there. It rises monotonically with `age`, is exactly 0 before the
  window opens, and reaches exactly 1 when the window closes (0.675 Gyr for a
  quenched S0, 6.075 Gyr for an Sb), which is what "the bulge forms first" means as
  a number.

* **`meanAge`** — the mean stellar age of the population that exists at the epoch,
  from the SFH's own moments: `age − tauSfh · M1(x)/F(x)` over `x = x(age)`. For a
  quenched type the formation time freezes at the quenching time while `age` keeps
  growing, which is exactly what a dead disc does.

* **`gasRatio`** — `gasFraction > 0 ? gasNow / gasFraction : 1`. The gas law is
  already mass-conserving and lands on the anchor at `AGE_REF` (0.3.3 pin), so the
  ratio is `≥ 1` everywhere and exactly `1` at the reference epoch. The guard keeps
  the E sequence (no gas at all) from dividing by zero, and its unarmed
  `arms.amp = 0` keeps the contrast law from acting on it anyway.

### The laws

| law | factor | why |
|---|---|---|
| spheroid assembly | `spheroid.amp ×= spheroidProgress` | The bulge/bar assembles; the bar's length, its boxiness and its pattern speed are the type's own (sizes are E3, and the exact-zero form `Δphase0 = K·ln(R'min/Rmin)` is what E3 must use). |
| arm contrast | `arms.amp ×= min(sqrt(gasRatio), ARM_CONTRAST_MAX)` | Arms are the gas: the wave's contrast follows the gas left relative to the type's own anchor, sub-linearly, and saturates at `ARM_CONTRAST_MAX = 2` — beyond that the linear density-wave response is not believable and the field would read as two bright stripes. |
| disc heat | `σ ×= heat`, `thin.H ×= heat²`, `thick.H ×= heat²`, `heat = (meanAge / meanAge_ref)^HEAT_EXP`, **gated on the model having a disc** (`thin.amp > 0 ∥ thick.amp > 0`) | Disc heating: dispersion grows with the population's age (age–velocity relation, `HEAT_EXP = 0.25`), and an isothermal disc's thickness follows dispersion squared. One exponent, two visible outcomes, both discs and both dispersions by the same factor, so the type table's thick:thin height ratio is preserved exactly at every epoch. |

The disc and the halo keep their **present mass** at every epoch. That is the
load-bearing decision of the slice: the gas-driven layers (nebulae, HII regions,
open clusters) live in the disc and scale with `gasNow`, so a tier that also
emptied the disc would put the model in contradiction with its own gas layer — a
young galaxy would show a full nebula lane over a disc that had lost its stars.
The mass budget moves with the gas field that can follow it, which is E3's job.

The heat gate is the same rule seen from the other side. A model with no disc at
all — the E sequence, `thin.amp` and `thick.amp` both 0 — has no disc scale height
to move, and its two heights are read nowhere but the gas lane. Scaling them there
thinned the lane of a galaxy that never formed a disc, and a 0.5 Gyr E4 (mid-burst,
`gasNow` 0.2, gas-rich) stopped placing the HII regions and open clusters its
starburst is supposed to have. The gate is one comparison, no per-type constant.

### Rejected during implementation

Both were tried and measured; neither may come back without answering the
measurement that killed it (worklog 0.6.0 has the numbers):

* **Windows measured against the epoch's own compressed span.** Compressed windows
  are self-similar, so the ratios only scale the galaxy's total and then drift
  non-physically (an S0's thick disc and spheroid ran ahead and saturated by 1 Gyr
  while the thin disc lagged).
* **Every component's amplitude scaled by its own window.** Green for
  `galaxy-types`, and wrong: a 0.5 Gyr field emptied its thin and thick disc to
  0.6 % of present mass while the gas-driven objects stayed full, and globular
  counts *rose* with age (SBb 302 → 88). The field and the gas layer contradicted
  each other.

### Model surface

* `model.epoch = { age, assembly, spheroidProgress, meanAge, meanAgeRef, heat, gasRatio, armContrast, gasNow, gasRich }`
  — solved once at build and again on every re-solve (`modelAtAge`); read by the tests
  today and by E2's epoch readout, its first UI consumer.
  `assembly` is the existing galaxy-wide `sfhProgress`, which is what `gasNow`
  already derives from.
* `model.epochBase` — the reference-epoch values of the eight scaled numbers
  (`thinH`, `thickH`, `thinAmp`, `thickAmp`, `spheroidAmp`, `armsAmp`, `sigmaThin`,
  `sigmaThick`), written by the tier before it scales them. `modelAtAge` has to be
  able to undo and redo the epoch, and an exact undo is a stored value, not a
  division.
* `solveEpoch(populations, T)` clamps the clock once (one place, so the population
  and structure tiers cannot hold different clocks) and `applyEpoch(model, epoch)`
  writes the scaled groups, cloning each group it writes so a re-solve never
  mutates a group another model object still shares.

### Runtime coupling (E1b, shipped)

Because the epoch is packed geometry, an age change now re-samples the field. The
consequences are part of the slice, not an afterthought:

* `renderer.regenerate` already re-samples when `sameGeometry` is false, so the
  renderer needed no change — only the comment that said an age change keeps the
  field.
* The **selection set** keeps its keys (`fieldStarSeed(seed, slot)`, a function of
  the seed and the draw index, so a re-sample keeps every key valid) but its cached
  positions and stellar inputs are stale. `main.js` `resolveSet()` resolves the set's
  keys against the new identity array in one pass over the live blocks — an
  open-addressed map of the set's keys, then one walk — and rewrites slot, block kind,
  position, colour, magnitude and the five stellar inputs from the record the key now
  names. A member that is no longer resident (or not visible) keeps its readout line
  and loses its slot, which is the ring's existing missing-slot behaviour.
* The **simple-engine θ mirror**: prepare re-seeds the GPU thetas from the new birth
  positions, so the CPU mirror is re-seeded through the same path a type change uses
  (`initSimpleLandmarks()`).
* The label layer's key→slot map already rebuilds when `dynamicVersion` moves, which
  a re-sample does, so the rings follow the field with no change there.
* The age slider's throttle (`AGE_REGEN_INTERVAL`) already existed for exactly this
  cost class; it is now load-bearing rather than cosmetic.

### Validation

Shipped as `experiments/galaxy-evolution-test.js` (18 checks, registered in
`scripts/run.py` as `galaxy-evolution`, log `experiments/logs/galaxy-evolution.json`):

* **Exactness:** for every type, every epoch factor `=== 1` at `AGE_REF`, the packed
  density parameters of `modelAtAge(m, AGE_REF)` are bit-identical to a fresh build,
  and the round trip young → reference lands back on the fresh build. The Milky Way
  preset's literal pins and the type-anchor pins pass unchanged.
* **Laws:** monotone in age and bounded for every type (`heat ∈ (0, 1]`,
  `1 ≤ armContrast ≤ 2`, `0 < spheroidProgress ≤ 1`), exactly 1 at `AGE_REF`, and the
  thick:thin height ratio preserved at every epoch.
* **Scope:** of the packed geometry groups, only the four amplitude slots the tier
  owns ever move; no length, angle, profile exponent, pattern speed or disc amplitude
  moves; a model with no disc keeps its heights.
* **Field honesty:** the sampled arms carry exactly the parameter's contrast (mean
  azimuthal cosine ≈ `arms.amp/2`, measured on 300 k stars; the young/reference ratio
  matches `armContrast` within 5 %), and the sampled bulge share is the mass
  `deliveredMasses` says it should be within 0.004.
* **Runtime:** `renderer-test.js` pins that an age change re-draws the field, that the
  identity keys survive it, and that a resolved key follows the new field; `m1-smoke`
  pins that `main.js`'s age path re-seeds the mirror and calls `resolveSet`.

## E2 — the epoch's live clock (shipped)

E1 made the galaxy's structure a function of its own clock; E2 lets that clock run.
While the toggle is on, the age advances on the **star-time axis** — the same `dt` the
stars integrate with, so `T` freezes both and the star-rate slider scales both — and
the field follows in a sequence of epochs.

### The law

Three things, solved in `galaxy.js` beside the epoch tier so the page and the tests
cannot hold different ones:

| name | value | why |
|---|---|---|
| `AGE_STEP` | 0.1 Gyr | The epoch's own quantum. It is the Age slider's step, so the readout, the slider and the drawn field cannot disagree about where the galaxy is. |
| `EVOLVE_MYR_PER_STEP` | `AGE_STEP · 1000` = 100 Myr | The unit bridge, not a second rate: the star clock is in Myr and the epoch in Gyr, and one quantum costs 100 Myr of star time. |
| `evolveTick(state, age, dtStar, time, interval)` | the age to rebuild at, or 0 | One tick: accrue the star time, step when a whole quantum is paid for *and* the shell's rebuild interval has passed. |

`state.debt` is **dropped, not banked**: an applied step resets it to 0, so one step is
never more than one quantum even when the star clock runs far ahead (the top slider
rate, or a camera-coupled flight rate). The field cannot be re-drawn faster than it can
be sampled, so the clock is *sampled* rather than integrated, and the visible evolution
is a sequence of epochs by construction rather than by luck.

A step lands on `steppedAge(age)` — one quantum toward the present, on the slider's
own grid (`AGE_MIN + k·AGE_STEP`, recomputed from the floor rather than accumulated,
so the run is exactly 133 steps from 0.2 Gyr to the ceiling), holding at `AGE_MAX`,
because nothing in the model is older than the universe. A run that starts
within one step of `AGE_MAX` **replays** from `AGE_MIN` (`evolveStartAge`): at present
day there is nothing left to watch, and that is what makes the toggle do something the
first time it is ticked. Anywhere else the run continues from where the galaxy is, and
the Age slider stays a **seek**: dragging it retargets the next step.

### The surface

* A Galaxy-menu row: the `Evolve with star time` checkbox and the epoch readout
  (`#val-epoch`) beside the Myr/s control. The readout is the epoch **the field was
  built at** (`model.populations.age`), never the clock's wish, and its tooltip carries
  the rest of `model.epoch` (bulge, arm contrast, heat, gas) — E1's first UI consumer.
* The preset field `evolve` (0/1) beside `age`, and `?evolve=1` at boot.
* A built-in preset, `Evolve`: a barred spiral from `AGE_MIN` with the star clock at
  its top rate, so the run is one click instead of three settings.

### The cadence

A step is a full field re-sample — the epoch is packed geometry (E1b), so nothing
cheaper is honest — and that is what bounds the run: `createGalaxy` is a fraction of a
millisecond, while `sampleGalaxyStars` at the default 300 000 stars is ~0.32 s and one
`renderer.regenerate` ~0.67 s (measured). The tick therefore takes the shell's existing
`AGE_REGEN_INTERVAL` (0.35 s) as its interval — the same shortest-gap-between-rebuilds
the Age slider's drag already uses, because it is the same rebuild — and the two paths
share one timeline, so a drag and a live step can never double-fire.

Stated consequences, not discoveries:

* **Positions jump.** Every step re-draws the field: the stars are a new draw of the
  same galaxy, not a morph between two draws. Everything the viewer holds follows
  through E1b's rebuild path (camera, labels, the selection set re-resolved by key), so
  nothing is thrown away — but the step is a jump.
* **The frame a step lands on pays the rebuild**: ~0.7 s at the default 300 000 stars,
  ~0.11 s at 50 000. The loop's own `dt` clamp (0.1 s) hides most of it from the sim
  clock, so the star clock loses at most 0.1 s per step.
* **Rate.** One step per 100 Myr of star time: at the top slider rate the whole
  0.2 → 13.5 Gyr life is 133 steps, ~2.2 min of star time. The default 5 Myr/s makes
  it a 44-minute drift, which is why the built-in preset exists.

### Validation

`experiments/galaxy-evolution-test.js` gains the E2 law — the quantum, the drop, the
hold, the replay, one step per tick, and the run's step count — and records the
measured step cost. `m1-smoke` pins the surface (the toggle, the loop's step path, the
boot gate) and `preset-test` the round trip. No renderer or WGSL change: a live step
*is* the age rebuild the renderer already re-samples for, and E1b's pins cover it.

## Later milestones

* **E3 — morphology growth.** Sizes, not just amplitudes: `spheroid.a/b/c` self-similar
  in the assembled spheroid mass (`∝ mass^⅓`), the bar's length following it, and the
  arm ridge re-anchored to the moving bar tip by the *additive* correction
  `Δphase0 = K·ln(R'min/Rmin)` (exactly 0 at `AGE_REF`, since `ln 1 = 0`), which is the
  one form that can grow the bar without breaking the preset's literal `phase0` pin.
  A bar's pattern speed then follows from its own length, as it already does.
* **E4 — events.** Minor mergers, tidal streams and a starburst episode. These need a
  new object family (the composite-object layer is the host) and a re-sampling path,
  so they are a release of their own.
* **E5 — chemical evolution (optional).** Metallicity as a function of the epoch
  rather than one authored gradient. The observables (`gasNow`, `progress`) already
  exist; the population tier's colour law would need the measurement first.

## Non-goals

* No browser/GPU visual claim. The deferred visual pass
  (`deferred-browser-visual-plan.md`) still owns every visual verdict, and passing
  E1's Node measurements does not stand in for it.
* No change to the default epoch, the default type, the exposure contract or the
  movement engines' behaviour at the reference epoch.
* No new data files, no WGSL growth, no per-frame allocation. The epoch is solved at
  build and re-solve time only.
