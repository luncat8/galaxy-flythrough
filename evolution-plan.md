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
   bit-identical to the pre-0.6 model. E3's re-anchor is the additive form of the
   same rule: `Δphase0 = K·ln(R'min/Rmin)` is exactly `0` at `AGE_REF` (`ln 1 = 0`),
   and a `Δ === 0` guard then keeps the stored `phase0` verbatim instead of
   re-wrapping it — wrapping is the identity on a value inside `[0, 2π)`, but not on
   an authored base outside it. Its re-solved length is exact the same way: the bar's
   pattern speed re-derives through the build's own function on bit-identical
   inputs.

4. **Scale, do not re-author.** The tier multiplies the numbers the type table
   solved: amplitudes, dispersions, scale heights and — since E3 — the spheroid's
   own axes, self-similarly, with the two numbers a bar's length decides (its arm
   anchor, its pattern speed) following it. It never changes a disc length, an
   angle, a profile exponent or a disc/halo amplitude. A derived quantity whose
   inputs do not move stays exactly the type table's (`dynamics.loopRatio` — `b/a`
   cancels under a self-similar scale); one whose inputs move follows the field
   through its own build-time derivation, never a second copy of it — the bar's
   pattern speed re-derives through `galaxy.barPatternSpeed`, and the arm ridge
   re-anchors by the additive `Δphase0` that solves the table's own coupling at the
   moved tip, so no consumer can disagree with the field. One width does follow the
   field by construction: `density.armRidgeWidth` is `ARM_RIDGE_FRAC·λ/(1 + arms.amp)` read
   live, so the newborn lane narrows as the arms strengthen — which is the lane the
   O/B stars, the nebulae and the HII regions are placed in, so it is the field's own
   answer and not a second decision.

5. **No WGSL growth.** Every number the tier moves is already packed per model
   (`thin`/`thick` H, `arms.amp`, the spheroid's `a`/`b`/`c`, `armShape`'s
   `phase0`/`minRadius`, and the disc dispersions in the orbit block). The shader's
   density mirror reads the same numbers, so the series adds no constant to WGSL and
   `wgsl-validate` stays a structural check; `wgsl-exec` runs a young-epoch bar
   through the real WGSL for the numeric parity.

6. **An epoch change is a geometry change** (E1–E3; **revised by E4**). `sameGeometry`
   already compares the numbers the GPU receives, so once the epoch moves them, an age
   step re-samples the field instead of only rewriting records. That is the correct
   outcome (the field *is* the epoch) and it is why the runtime coupling in E1b exists.
   E4 keeps the physics and moves the *mechanism*: the field is drawn once per
   (type, seed, budget, overrides) and the epoch is a continuous parameter of where
   that field is *placed*, so a run of the clock no longer re-samples at all. The
   re-sample is what a *new* field pays (another galaxy, another budget, another
   override), not what an epoch pays.

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

* **`spheroidSize`** (E3) — the linear scale the assembled spheroid mass occupies
  at the reference density: `spheroidProgress^⅓` (`Math.cbrt`), so a self-similar
  volume carries exactly the assembled mass. `cbrt(1) === 1` exactly, which is the
  exactness contract above in one call.

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
| spheroid assembly | `spheroid.a/b/c ×= spheroidSize` (= `spheroidProgress^⅓`), `spheroid.amp` untouched | The bulge/bar assembles inside-out at the reference density, so the field's bulge mass fraction is exactly `spheroidProgress` at every epoch and the shape numbers (boxiness `b/a`, flatness `c/a`, `loopRatio`) hold. This is E3's form; E1's first slice dimmed the amplitude instead — the same assembled mass — and keeping *both* would double-count the assembly into `progress²` (measured and rejected, see E3). The bar's length and pattern speed follow the assembled mass; see E3 for the arm anchor that rides the tip. |
| arm contrast | `arms.amp ×= min(sqrt(gasRatio), ARM_CONTRAST_MAX)` | Arms are the gas: the wave's contrast follows the gas left relative to the type's own anchor, sub-linearly, and saturates at `ARM_CONTRAST_MAX = 2` — beyond that the linear density-wave response is not believable and the field would read as two bright stripes. |
| disc heat | `σ ×= heat`, `thin.H ×= heat²`, `thick.H ×= heat²`, `heat = (meanAge / meanAge_ref)^HEAT_EXP`, **gated on the model having a disc** (`thin.amp > 0 ∥ thick.amp > 0`) | Disc heating: dispersion grows with the population's age (age–velocity relation, `HEAT_EXP = 0.25`), and an isothermal disc's thickness follows dispersion squared. One exponent, two visible outcomes, both discs and both dispersions by the same factor, so the type table's thick:thin height ratio is preserved exactly at every epoch. |

The disc and the halo keep their **present mass** at every epoch. That is the
load-bearing decision of the slice: the gas-driven layers (nebulae, HII regions,
open clusters) live in the disc and scale with `gasNow`, so a tier that also
emptied the disc would put the model in contradiction with its own gas layer — a
young galaxy would show a full nebula lane over a disc that had lost its stars.
The spheroid is the one component whose mass budget moves — it assembles — and
since E3 it moves as size: the same budget E1's law delivered, carried by a
smaller, equally dense body (see E3).

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

* `model.epoch = { age, assembly, spheroidProgress, spheroidSize, meanAge, meanAgeRef, heat, gasRatio, armContrast, gasNow, gasRich }`
  — solved once at build and again on every re-solve (`modelAtAge`); read by the tests
  today and by E2's epoch readout, its first UI consumer.
  `assembly` is the existing galaxy-wide `sfhProgress`, which is what `gasNow`
  already derives from.
* `model.epochBase` — the reference-epoch values of the numbers the tier scales
  (`thinH`, `thickH`, `armsAmp`, `spheroidA`, `spheroidB`, `spheroidC`,
  `armsPhase0`, `armsMinRadius`, `sigmaThin`, `sigmaThick`), written by the tier
  before it scales them, plus the two disc amplitudes (`thinAmp`, `thickAmp`) which
  never move and are stored as the heat gate's inputs. `modelAtAge` has to be able
  to undo and redo the epoch, and an exact undo is a stored value, not a division.
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
  `1 ≤ armContrast ≤ 2`, `0 < spheroidProgress ≤ 1`, `spheroidSize = progress^⅓`),
  exactly 1 at `AGE_REF`, and the thick:thin height ratio preserved at every epoch.
* **Scope:** of the packed geometry groups, only the slots the tier owns ever move —
  the disc heights, the arm contrast, and (since E3) the spheroid's axes and a bar's
  arm anchor; no disc length, angle, profile exponent or disc/halo amplitude moves, a
  non-barred model keeps its ridge phase and wave speed, and a model with no disc
  keeps its heights.
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

**Superseded by E4** — the step's *clock* (`evolveAge`, `AGE_STEP`, the rate) is the
shipped law and E4 keeps it; the re-sample this section makes the step, and the
`rebasePatternPhase` it leans on, are exactly the two mechanisms E4 replaced
(continuous placement and the phase accumulator). Read the rest of this section as the
record of the defect, and E4 for what the release does.

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
* **The pattern does not jump.** The star clock `T` is *not* reset by a step (the
  re-drawn births sit in the `T = 0` frame and are advanced by the full `T`, exactly
  like the stars they replace), but E3 re-derives Ω_p per epoch — 0.13 rad/Myr at
  0.2 Gyr, 0.029 at present for SBb — so the bar and arm angle Ω_p·T would move by
  ΔΩ_p·T at every step: radians once a few hundred Myr have run, and backwards, since
  the bar slows as it grows. Every same-galaxy re-draw (a live step, an Age drag, a
  star-budget change) therefore rebases the phase origin by the Pattern speed slider's
  own rule (`orbit.rebasePatternPhase`: `offset += (Ω_old − Ω_new)·T`), and the simple
  lane's re-seeded field and object thetas are turned by the pattern's current
  rotation (`orbit.patternRotation` = Ω_p·T + offset) while its landmarks keep the
  azimuths the CPU mirror integrated (`simpleLandmarksRebind`). A type or seed change
  is another galaxy and still resets the offset to 0.
* **The frame a step lands on pays the rebuild**: ~0.3–0.7 s at the default 300 000
  stars, ~0.11 s at 50 000. The loop's own `dt` clamp (0.1 s) hides most of it from the
  sim clock, so the star clock loses at most 0.1 s per step. The **Stars** slider in the
  Galaxy menu (a 30k–500k ladder, applied on release by one re-draw, carried by the
  `stars` preset field) is the knob for a smoother run; built-in presets leave it alone.
* **Rate.** One step per 100 Myr of star time: at the top slider rate the whole
  0.2 → 13.5 Gyr life is 133 steps, ~2.2 min of star time. The default 5 Myr/s makes
  it a 44-minute drift, which is why the built-in preset exists.

### Validation

`experiments/galaxy-evolution-test.js` gains the E2 law — the quantum, the drop, the
hold, the replay, one step per tick, and the run's step count — and records the
measured step cost. `m1-smoke` pins the surface (the toggle, the loop's step path, the
boot gate) and `preset-test` the round trip. No renderer or WGSL change: a live step
*is* the age rebuild the renderer already re-samples for, and E1b's pins cover it.

## E3 — morphology growth (shipped)

E1 scaled the epoch's amplitudes; E3 gives the assembled mass its own geometry. The
spheroid — bulge or bar — grows in self-similarly at the reference density, and the
two numbers a bar's length decides (the arm anchor at its tip, the pattern speed at
its end) follow it through their own build-time derivations. No second clock, one
new factor (the cube root the `∝ mass^⅓` law already implies), and no WGSL growth:
every moved number is already packed per model.

### The laws

| name | value | why |
|---|---|---|
| `spheroidSize` | `spheroidProgress^⅓` (`Math.cbrt`) | The linear scale the assembled spheroid mass occupies at the reference density. Exactly `1` at `AGE_REF` (`cbrt(1) = 1`), monotone in age, in `(0, 1]`. |
| spheroid growth | `spheroid.a/b/c ×= spheroidSize`, `spheroid.amp` untouched | The assembly is the size: the field's bulge mass fraction stays exactly `spheroidProgress` (E1's budget, its numbers of record), the body is a smaller, equally dense one, and boxiness `b/a`, flatness `c/a` and `loopRatio` hold at every epoch — the spheroid shrinks, it does not reshape. |
| bar-tip anchor | `arms.minRadius ×= spheroidSize` (barred models) | The table's own identity — the arms leave where the bar ends, `minRadius = a·r0` — at every epoch rather than only at the reference one. |
| ridge re-anchor | `phase0 → wrap₂π(base + Δphase0)`, `Δphase0 = K·ln(R'min/Rmin) = K·ln(spheroidSize)`, `K = m/tan(pitch)` — coupled bars only (`m > 0`, `pitchDeg > 0`) | A log-spiral's phase is logarithmic in `R`, so the ridge that passed through the old tip at the bar tilt passes through the moved tip at the same tilt under exactly the wind-up between the two tips. The correction is *additive*, hence exactly `0` at `AGE_REF` (`ln 1 = 0`) — the one form that leaves the preset's literal `phase0` pin standing. At `Δ = 0` the guard keeps the stored base verbatim, because wrapping is the identity inside `[0, 2π)` but not on an authored base outside it. An uncoupled bar (SB0: pitch 0) has no ridge to re-anchor, and its `K = m/tan 0` would be infinite — the same gate the table solves `phase0` under. |
| bar pattern speed | `dynamics.omegaPattern = barPatternSpeed(...)` on the epoch's own bar (barred models) | Derived, never authored: the build's own function, read on the scaled length — one law, one place. A shorter bar is a faster pattern, flat at the `rCore` floor while the tip sits inside the core; outside it the fast-bar ratio `R_CR/a = 1/(1 − 1/√2) ≈ 3.41` is invariant by construction, so the bar grows at its type's own corotation. A non-barred model's wave speed is the disc-wide derivation's, whose inputs the epoch does not move, and stays the build-time value. |

### The assembly is the size, not a dimming (rejected by arithmetic)

E1's first slice carried the assembled spheroid mass in a dimmed amplitude
(`amp ×= spheroidProgress`). The double-scaling reading of E3 — keep the dimming
*and* scale the axes — was rejected before shipping, by the plan's own two laws:
the field's bulge mass fraction would become `progress²` (SBb at 2 Gyr: 3.2 %
instead of the recorded 18 %), the size law `∝ mass^⅓` would be false of the
shipped field (the size would ride `mass^½`), and every E1 mass number of record —
the delivered-mass pins, the object counts, the exposure bands — would silently
move. Given *mass fraction = `spheroidProgress`* and *size = `mass^⅓`*, the
solution is unique: the amp stays the reference density and the axes carry the
assembly. The shipped pin *the delivered bulge mass is still exactly
`spheroidProgress`* is the guard against the double count coming back.

### Non-movers

Disc lengths, angles, profile exponents, disc and halo amplitudes, `arms.m`,
`arms.pitchDeg`, `arms.Rs`, `dynamics.vFlat`/`rCore`, and — for a non-barred model
— `arms.phase0`, `arms.minRadius` and `dynamics.omegaPattern`: the type table's at
every epoch. `dynamics.loopRatio` (`b/a`) cancels under a self-similar scale, so
the build-time value *is* the epoch's; re-deriving it would only add rounding.

### Validation

`galaxy-evolution-test.js` gains a seventh section (suite 28 → 37): the axes are the
reference axes under one size factor at every epoch (bitwise), the growth is
self-similar (boxiness, flatness, `loopRatio`), the mass law holds (delivered bulge
fraction `=== spheroidProgress` to 1e-12, the amp bitwise unmoved), the tip identity
`minRadius = a·r0` holds at every epoch, the coupled ridge passes through the moved
tip at the bar tilt (the preset's authored-rounding tolerance, 1e-4), the re-anchor
is the additive `K·ln(size)` form and bitwise nothing at the reference epoch, the
pattern speed is the build's law on the epoch's length, monotone in age and bitwise
the build's value at the reference epoch, and — non-vacuity on 300 k sampled stars —
the bulge's mean radius rides the size factor within 3 %. E1's reference-epoch
bit-identity pins (packed bytes, both directions) pass unchanged; the restated
scope/window pins are the contract change, not a moved number. `wgsl-exec` gains the
preset at a 2 Gyr epoch in its density-parity list (119 → 121): the real WGSL reads
the same packed numbers at the moved ridge and the shorter bar. Numbers of record:
SBb's bar is 0.55 kpc at 0.5 Gyr (`size` 0.239, `Δphase0` −13.5 rad), 1.30 kpc at
2 Gyr (0.564, −5.4 rad) and full length from its window's close at 6.075 Gyr; its
pattern speed runs 0.120 → 0.051 → 0.029 rad/Myr over the same ages at the
invariant 3.41 corotation ratio; a quenched E4 is full size from 0.27 Gyr, and SBa
at `AGE_MIN` sits on the `rCore` floor (a 0.27 kpc stub inside a 0.5 kpc core). No
renderer change: an age step is still the E1b re-sample, now of a differently
shaped field.

## E4 — continuous epochs (shipped)

### The defect

E2 shipped a live clock on the E1b coupling: one Age-slider step per
`AGE_STEP·1000` Myr of star time, each step a re-solve plus the re-sample the epoch
*is* (§6). At 300 k stars that is 325 ms of per-star work per step, and — because the
re-sample is a fresh draw and because the closed-form laws recomputed the pattern's
rotation as `omegaPattern·T` with the *current* rate — the user saw the field
re-drawn and the bar and arms jump back on every step ("looks like return back in
time every Evolve step").

The two halves of that artifact are independent and both are structural:

* **The clock's rate is not the elapsed rotation.** A model whose `omegaPattern`
  changes with the epoch (E3 re-derives it from the bar's own length) makes
  `Ω_p(T)·T` a different angle for the same star at the same star time; the pattern
  teleports by `ΔΩ_p·T`. Re-basing an offset on each rebuild — the fix the previous
  commit attempted, and which the user rejected — does not survive a *continuous*
  clock either: it re-derives a jump-free phase only at the moments a rebuild happens.
* **A re-sample is not a continuation.** New inverse-CDF draws give new stars: new
  identities, new keys, new azimuths. "Keep the stars that survive" cannot be met by
  re-drawing faster.

### The contract

**The field is drawn once per `(type, seed, budget, overrides)` and *placed* at the
running epoch.** The epoch is a continuous parameter of the placement, not a step of
the field. Consequences, all pinned:

* An epoch change is `galaxy.modelAtAge` (a re-solve, §E1's laws) plus view state — it
  is **never** `prepare()`/`regenerate()`. `state.fieldSamples` does not move, the
  records' birth bytes and the stars' keys do not move, and the thetas are not
  re-seeded.
* The birth vector of a record is in the frame of the model at the draw (the **base
  epoch**); `orbit.setEpochBase(model)` is called by the draw that establishes it, and
  `orbit.epochMap` maps a record from there into the running epoch. A record without
  `FLAG_EPOCH` (catalog stars, landmarks, catalog-space gap-fill) is the observed sky
  and the model's clock never moves it.
* The map is exactly the epoch's own laws, one rigid transform: the ridge re-anchor is
  a rotation for the **pattern family only** (`−Δphase0/m`; a disc star's lane already
  measures it against the current ridge and the bar rides the pattern's rotation, not
  the ridge), the spheroid homology scales a bulge/halo member's birth vector
  (`FLAG_EPOCH_SPHEROID`), and the disc height law scales a disc/arm member's vertical
  rank (`heat_now/heat_base)²`). It is the exact identity at the base epoch — the
  `active` gate makes a freshly drawn field bit-for-bit the field that was drawn.
  The rotation is read from the **size ratio**, `−K·ln(scale)/m`, which is E3's own
  `Δphase0 = K·ln(size)` seen as a turn — never from the difference of the two stored
  `phase0`s. The stored values are wrapped into one turn (the *field* is invariant
  under that: the ridge set repeats every 2π in `phase0`), but a point rotation by
  `2π/m` is not the identity, so a difference of wrapped angles puts a `2π/m` jump
  into the middle of a run. The size ratio is continuous and exactly 1 at the base.
* **The composite objects are the one block the map cannot carry.** Their seats are
  read from the *current* model — the arms at this epoch, the gas at this age — so an
  epoch change re-places them (`renderer.refreshObjects`, object + billboard ranges
  re-uploaded, the field's records untouched) and rations it by age
  (`OBJECT_REFRESH_AGE = 0.02` Gyr): at the top clock rate that is one re-place per
  ~0.2 s of run, not a per-frame cost.
* The map is *view state of the lane's rank*: `orbit.packEpochParams` writes
  `camera.epoch = (armRotation, spheroidScale, heatScale, fieldMagOffset)` at float 48
  (uniform 192 → 208 B) and the vertex stage applies the same transform in WGSL
  (`fn epochMap`), on the birth vector, before the engine mask ladder. The CPU twin is
  `orbit.epochMap`, used by picking and the label layer, so the three consumers place a
  record identically.
* **The pattern's phase is an accumulator, never a rate times a clock.** `orbit.setPatternClock(time, model)` advances `patternPhase += Ω_p_instant·Δt` — called from the frame loop with the frame's own star time, before anything places a star. The lanes carry `orbit.meanPatternSpeed(model)` (`wrapAngle(patternPhase)/starClock`), so the shader's and the CPU laws' `omegaPattern·T` product *is* the accumulated phase, exactly, in f32, at any clock (`STAR_TIME_WRAP` included). A rate change therefore adds no jump: it changes the rate of *future* phases only. `orbit.instantPatternSpeed` exists for the one consumer that is an integrator and wants a rate — the simple lane's own steps.
* **The look follows the epoch in slices.** The same star at another age is another
  colour and another brightness, and re-deriving 300 k looks at once is the 250 ms the
  defect was paying. `renderer` sweeps the field a few ms per frame
  (`EPOCH_SLICE_MS = 3`): each slice re-derives the look of the stars in `[at, at+n)`
  at the current model from their *own drawn* structure (× the epoch's scale law for
  their family) and uploads exactly that byte range. At 300 k a full pass is ≈ 1 s of
  frames and no frame pays more than the budget.
* **The exposure rides the uniform, not the records.** Records hold the raw `absMag`;
  the field's offset is `camera.epoch.w` (`state.magOffset = 2.5·log10(L_now/L_ref)`),
  recomputed once per sweep *pass* over the renderer's own 4096-star sample of the
  drawn field (`epochCalibrationRef` is that sample at `AGE_REF`), so a half-swept
  field cannot show a brightness seam and no sweep has to rewrite a record to keep one
  brightness.
* **The clock is continuous.** The frame loop calls `galaxy.evolveAge(age, dtStar)`
  (a real differential clock at `EVOLVE_GYR_PER_MYR`) and applies the result through
  `setEpoch` — there is no step accumulator, no `AGE_REGEN_INTERVAL`, no debt and
  nothing to hide: `AGE_STEP` remains the *slider's* quantum only.

### Validation

`renderer-test.js` (130 → 134 pins) gains the E4 block: the uniform is 208 B with the
epoch lane at 48; an epoch change writes `PROCEDURAL·16` B and only the look half — the
birth bytes and the keys are byte-identical, every rewritten record carries
`FLAG_EPOCH`, `sweptLook > 0`, and `epochSweepState().stale === false` only after a
finished pass; the young-vs-reference lane check (< 1 record changed) and the dim-young
check (`state.magOffset` against `2.5·log10(meanLum_young/meanLum_ref)` over
`StarTypesLib.meanFieldLuminosity`); the simple-lane θ seeds come from the *placed*
azimuths while landmarks keep the mirror's; the map's continuity (a pattern probe's
walk under a 0.05 Gyr and a 0.025 Gyr refinement: the worst step halves, the walk's
total length converges within 5 %, the net turn agrees within 0.02 rad, and the map is
*stationary* once the assembly windows close — the running rotation is the lane's); and
the objects' re-place with its age rationing. `galaxy-evolution-test.js` §6/§8 (36 → 38)
pins the continuous-run laws (`modelAtAge` + `packEpochParams` < 2 ms, `epochMap`
300 k < 100 ms, no field re-sample) and the accumulator against the naïve law: the
naïve `Ω_p(T)·T` drifts **1.27 rad** over a 13.3 Gyr run at 99 Myr/s (its worst
single-frame jump 0.077 rad — invisible in one 1.65 Myr frame, which is why the
defect survived the earlier suite), while the accumulator adds exactly the frame's own
rate over the frame's own interval (1.3e-14 rad) and a bar-family star keeps its
azimuth across every epoch step to its x1 loop (1.1e-6 rad). `m1-smoke-test.js` (64)
pins the shell side: an age change places the field through `setEpoch`, `redrawField`
is the re-draw path, nothing rebases `OrbitLib.setPatternClock`/`resetPatternPhase`,
and `AGE_REGEN_INTERVAL` is gone. `orbit-test.js` (123) and `wgsl-validate.js` (185)
pin the accumulator's algebra and the camera-member order; `wgsl-exec-check.js`
(121) keeps the real WGSL laws at the identity epoch lane.

### Cost, measured (node, 300 k)

| path | before (E2) | E4 |
| --- | --- | --- |
| epoch step: model re-solve | ~0.02 ms | ~0.02 ms |
| epoch step: field re-sample | 339 ms (`sampleGalaxyStars`) | — |
| epoch step: per-star look | ~250 ms | 3 ms/frame, amortized over ~1 s |
| epoch step: geometry | re-place, 325 ms total | `packEpochParams` O(1) + map O(1)/record |

### Rejected during implementation

* **`Ω_p(T)·T` with the current rate, and the `patternPhaseOffset` rebase it needed.**
  The offset form is what the rejected commit did: correct only at the moments it
  rebases. The accumulator makes the same angle *by construction*, at every frame.
* **Reading `Δphase0` as the difference of the two stored `phase0`s.** It looks
  equivalent and it is not: both are wrapped into one turn, and the wrap crosses
  somewhere in the run. `wrapTwoPi(phase0_now − phase0_base)` then jumps by `2π/m`
  and the arms turn in a single step — the very artifact E4 exists to remove,
  caught by the refinement check above (worst step 6.27 rad, step-size independent)
  and fixed by reading E3's own `K·ln(size)`.
* **Rotating every family in the map.** Rotating BAR records is exactly what the
  earlier epoch tier got wrong (the bar is not ridge-anchored), and rotating DISC
  records double-counts the ridge the disc lane already carries. Only `FAMILY_PATTERN`
  turns; `epochMap`'s doc comment says which law decided each term.
* **Baking the exposure offset into the records.** One offset per record cannot follow
  a continuous clock without rewriting every record on every pass, and a slice-wise
  rewrite of it *is* a visible seam.
* **Driving the sweep from a timer.** A slice is uploaded with
  `device.queue.writeBuffer`; the pass has to run inside the frame that draws it, and
  the tests drive it by hand (`renderer.stepEpoch(model, budget)`), which is also the
  only way a harness without a queue can pin it.
* **A re-draw at a threshold.** "Re-draw when the map's error grows" trades the
  artifact for a smaller artifact: identity is the requirement, so the base epoch
  changes only with the *field*, never with the clock.

## Later milestones

* **E5 — events.** Minor mergers, tidal streams and a starburst episode. These need a
  new object family (the composite-object layer is the host) and a re-sampling path,
  so they are a release of their own.
* **E6 — chemical evolution (optional).** Metallicity as a function of the epoch
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
