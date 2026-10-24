# Deferred plan — evolving the Milky Way catalog with the epoch

## Decision and status

**Deferred, non-critical.** The app is stable: the seven relevant regression suites
pass (`renderer-test` 147/147, `star-types-evolution-test` 58/58,
`star-select-test` 47/47, `search-test` 37/37, `scenario-test` 70/70,
`galaxy-evolution-test` 43/43, `gpu-smoke-test` 27/27), and the committed browser
run `experiments/logs/webgpu-smoke-2026-10-24-04-20.log` is **19/19 PASS** on a
real NVIDIA/WebGPU adapter. The one visible defect the user reports is that the
**streamed catalog stars do not participate in the epoch** — they keep a fixed
present-day look at every age, including at First light (`T = 0`).

The catalog is **Milky Way only** (`configureMode` sets `catalogBudget = 0` unless
`model.milkyWay`), so the defect never appears on any procedural/table galaxy. It
is an aesthetic/history-consistency gap, not a correctness or performance bug. We
are therefore **planning it, not implementing it now**: this file is the memory of
the issue and the contract a future change must satisfy. Preserve the passing
baseline; do not retune the density field, birth law, exposure calibration, or
default engine while closing this.

Relation to other documents: this is a *deferred* companion to
`deferred-browser-visual-plan.md` (V14a already notes catalog stars are not gated)
and to the shipped formation series `formation-plan.md` (0.7.x). It is **not** part
of `plan.md`'s analytical contracts. Record any implementation in
`archive/0.7.x-worklog.md` (or a new series) after the design questions in §6 are
answered.

## 1. The observed issue, precisely

At the Milky Way preset, scrubbing **Age** (or running **Evolve with star time**)
changes the procedural field, the clusters and the composite objects, but the
catalog stars and the local procedural gap-fill stay at their **reference-epoch
color and magnitude** at every epoch. At `T = 0` they are still drawn while the
rest of the sky is empty. Reads as "the catalog is out of evolution" — a fixed
sky overlay on an evolving galaxy. Two distinct sub-symptoms:

- **No birth gate.** Catalog / local slots are never hidden at young epochs.
- **No look evolution.** Their brightness and color never follow elapsed time.

Curated named landmarks are a *separate* block and are intentionally left visible
(this plan keeps them that way; see §5).

## 2. Root cause (current code, lines as of this plan)

1. `src/render/star-sprites.js`
   - `birthStaging` / `birthBuffer` are sized to
     `fixedCapacity = proceduralCount + landmarkCount + objectCapacity`
     (allocation ~line 703). There are **no birth times** for the local gap-fill
     block (`BLOCK_LAYOUT[3]`) or the catalog block (`BLOCK_LAYOUT[4]`).
   - `setEpoch()` (~line 1100) refreshes the field exposure (`sweepExposure()`)
     and marks the procedural look sweep stale; it does not touch streamed blocks.
   - The epoch look sweep `sweepEpochLook()` iterates only `i < proceduralCount`.
   - `uploadDynamic()` (~line 1500) writes raw catalog records from the cell
     manager and local gap-fill records on every streaming rebuild; it does not
     derive their looks for the current epoch. Local stars are re-derived during
     rebuilds, not on epoch changes.
   - `uniform[54]` = `proceduralCount` (`camera.formation.z`),
     `uniform[55]` = `proceduralCount + landmarkCount + objectCapacity`
     (`camera.formation.w`).
2. `src/render/shaders.js`
   - The vertex gate is
     `gateLimit = max(camera.formation.z, camera.formation.w)`, i.e.
     `proceduralCount + landmarkCount + objectCapacity`. Only slots
     `starIdx < gateLimit` read `birthTimes` and fade in
     (`smoothstep(birth, birth + 0.05 Gyr, age)`). Local and catalog slots exceed
     `gateLimit`, so they render at every epoch.
   - Field exposure (`camera.epoch.w`) is applied to **every** `FLAG_EPOCH`
     record. Catalog/landmark/gap-fill records deliberately clear `FLAG_EPOCH`
     (see `src/math/star-record.js` header), so today they are excluded from both
     the epoch *map* and the exposure — the observation that motivates §5.
3. CPU consumers mirror the same narrow scope:
   - `src/core/selection.js` `formationVisible()` gates `kind === 0` (field) and
     `kind === 2` (object) only.
   - `src/core/search.js` gates `BLOCK_FIELD` / `BLOCK_OBJECT` only.
   - `src/render/label-layer.js` `ringAtSlot()` resolves a birth index only for
     `kind 0/2`.
   These mean picks, searches and selection rings currently treat catalog/local
   stars as always-formed — which will become wrong once the GPU gates them.
4. `src/core/scenarios.js` — the First light `watch` text documents that "Milky
   Way catalog stars and landmarks … still draw" (0.7.1 scope). It is accurate
   today and must be updated when the gate lands.

## 3. Test blind spot (why the green log did not catch this)

Every formation configuration in `src/core/gpu-smoke.js` constructs its renderer
with `catalogBudgetStars: 0` (five sites: firstlight ×2, continuity, morphology,
engines). With no catalog attached, the local/catalog blocks are empty, so
`gateLimit` covers all remaining instances and the First light sky is genuinely
empty. **The suite cannot see the defect by construction.** Any future
implementation must add catalog-enabled coverage (§7); a run with
`catalogBudgetStars: 0` is not evidence that the catalog evolves.

## 4. Guiding principle

**Preserve observed identity and the reference-epoch appearance.** The catalog is
a set of real observed stars; replacing each with an unrelated IMF draw would
destroy the identity that selection, search, planet systems and the local sky all
key on. So:

- Anchor every derived property to the star's stable key
  `PlanetsLib.catalogKey(cellId, slotInCell)` (survives thinning and residency
  changes — the cell manager already writes this key into `identity`).
- **At `AGE_REF = 13.5 Gyr`, restore the original quantized catalog color index
  and absolute magnitude byte-for-byte** (present-day pixel parity is a hard
  contract, like E3's "13.5 Gyr frame is pixel-identical").
- Only at *earlier* epochs may a star's look differ, and only along an inferred,
  deterministic track. Positions stay the observed sky (§5).

## 5. Proposed design

### 5.1 Reconstruct a prehistoric track from assumptions, then extrapolate

We observe each star only *now*. To make it evolve we must **reconstruct the
unobserved past from explicit astrophysical assumptions and extrapolate backward**
— the direction the user suggested. Three tiers, cheapest first; pick one and pin
it before coding (§6):

- **Tier A — state/age inference from the observation (recommended start).** From
  the stable key + reference `colorIndex` + `absMag`, invert the existing
  luminosity/mass relations (`massFromLuminosity`, `MASS_TEFF_TABLE`,
  `msLifetimeGyr` in `star-types.js` / `planets.js`) to assign a present-day
  evolutionary state (main sequence, red giant, or white dwarf) and a plausible
  mass. Choose a **reference age** consistent with that state (e.g. a giant is old
  relative to its MS lifetime; a massive blue MS star is young). Set
  `birth = AGE_REF − referenceAge`.
- **Tier B — extrapolate the track.** Given the inferred mass/state, evolve the
  star backward/forward along the *same* core evolution the procedural field uses
  (`evolveStar` / `deriveStarWithAge`): a main-sequence star stays near its MS
  locus (small, smooth brightness drift); an observed giant/white dwarf reverts to
  an earlier, fainter/hotter MS state at young ages. Interpolate monotonically so
  there are no oscillations (the 3.4–3.6 Gyr lesson — use the deterministic cohort
  machinery, not a Monte Carlo draw).
- **Tier C — assumption prior for the unconstrained part.** For stars whose
  observed state does not constrain a unique age (e.g. a low-mass MS star whose
  lifetime exceeds `AGE_REF`), fall back to a smooth prior — the component's SFH
  at the reference epoch (`sampleFormationTimeAtReference` / the birth histogram)
  — so births are finite, deterministic and spread across the history rather than
  piling at one epoch. This is the "extrapolate from possible assumptions" layer:
  document the assumed prior and its tolerance, and keep it a *pure function of
  the key* so it is reproducible.

At every epoch compute `stellarAge = max(0, currentEpoch − birth)` and derive the
look; gate by `smoothstep(birth, birth + BIRTH_FADE_GYR, currentEpoch)` so the
star fades in when it "forms," never pops.

### 5.2 Birth storage and the gate

- Expand `birthStaging` / `birthBuffer` to the **full record capacity**
  (`proceduralCount + landmarkCount + objectCapacity + localProceduralCapacity +
  catalogCapacity`) and set `camera.formation.w` to that capacity (or a dedicated
  uniform), so the vertex gate covers local/catalog slots too.
- Give the curated **landmarks** a negative-fade sentinel birth (e.g. `-BIRTH_FADE_GYR`)
  so `smoothstep` is 1 at `T = 0` and they remain always-visible — preserved out
  of scope, no UI change.
- When `uploadDynamic()` writes raw catalog records, immediately prepare each
  star's stable track (§5.1) and derive its look for the **current** epoch before
  upload. Do the same for local gap-fill records using a stable reference-epoch
  birth so camera/epoch changes never resample their identity.
- Extend the epoch look sweep to the local/catalog range (bounded by the catalog
  budget, so cheap), **excluding** composite objects and landmarks. If a streaming
  rebuild changes dynamic slot contents mid-sweep, reset the in-progress sweep
  safely (bump on `blockInfo.dynamicVersion`).

### 5.3 Positions, exposure, and the FLAG_EPOCH distinction

- **Positions stay the observed sky.** Catalog/landmark/gap-fill records keep
  `FLAG_EPOCH` clear, so the epoch map never moves them; only their *look* (color/
  magnitude) and *visibility* follow the epoch. This preserves the navigational
  quality of the local sky and the First light "SBb is empty" contract.
- Catalog records carry `FLAG_EPOCH` only if positional evolution is ever wanted —
  out of scope. If it is added later, note the shader currently applies uniform
  field exposure to **every** `FLAG_EPOCH` record; the clean split is: apply
  `camera.epoch.w` only to `starIdx < proceduralCount`, bake the current field
  offset into local records (as composite objects already do), and leave catalog
  magnitudes independent of field exposure.

### 5.4 CPU parity

Update `selection.js`, `search.js`, `label-layer.js` to gate by each record's
**global slot** (not only block-local field/object indices), reading the same
birth array and `BIRTH_FADE_GYR`, so picks, searches and rings match what the GPU
draws at every epoch. Fix the stale `src/math/star-record.js` header comment that
says catalog/gap-fill records are "never epoch-mapped" — they will be epoch-*look*
derived while still not epoch-*position* mapped.

## 6. Design questions to answer before implementing

These are the decisions a fork must be able to read off this plan; resolve them and
record the answers here (and in `findings-pitfalls-skills.md`) before coding.

1. Which track tier (A/B/C) and which reference-age rule per spectral state?
2. What prior for unconstrained (long-lived MS) catalog ages, and what tolerance
   on the resulting birth distribution?
3. Should **catalog stars gate off at `T = 0`** (fully consistent with the field)
   or remain as a faint "observed anchor" sky? The user's report favors gating;
   landmarks stay exempt. Decide and pin.
4. Does the local procedural gap-fill evolve too (recommended: yes, stable
   reference-epoch births), or is only the catalog in scope?
5. Present-day parity metric: byte-exact packed color/mag, or a rendered-pixel
   tolerance? Short-lived massive catalog stars can land inside the 50 Myr
   formation fade — the metric must catch restored-but-still-fading cases.

## 7. Validation plan (catalog-enabled)

Add a **new** smoke configuration with `catalogBudgetStars > 0` on the Milky Way
preset; a run with budget 0 (§3) is not evidence. New checks:

1. At `T = 0`, **0 catalog and 0 local** stars are visible (SBb still 0 lit pixels).
2. Catalog births are finite, deterministic, and within the assumed range.
3. Stable keys, births, positions and reference records are unchanged across
   camera streaming (thinning/residency).
4. At `AGE_REF`, catalog color/magnitude is restored exactly (or within the §6.5
   tolerance) — both as packed records *and* as rendered brightness.
5. At earlier epochs the look actually changes, especially for inferred giants/WDs.
6. Selection, search and selection-ring gating match GPU visibility at 0, 0.5,
   1, 2, 3.5 and 13.5 Gyr.
7. Epoch changes trigger **no field redraws / no resampling** (`draws` stays 0),
   preserving the 0.7.x contract.
8. Existing smooth exposure/count behavior through 3.4–3.6 Gyr and 2 Myr steps is
   unchanged (re-run the continuity suite).

Mirror the checks CPU-side in `renderer-test.js` / a new `catalog-evolution-test.js`
so they run without a GPU. Regression suites to re-run after any implementation:

```bash
node experiments/renderer-test.js
node experiments/star-types-evolution-test.js
node experiments/star-select-test.js
node experiments/search-test.js
node experiments/scenario-test.js
node experiments/gpu-smoke-test.js
node experiments/wgsl-validate.js
```

## 8. Deferred checklist

All rows **deferred / not implemented**. Acceptance is evidence, not intent.

| ID | Task | Acceptance / evidence |
|---|---|---|
| C1 | Pin the track model | §6 questions answered and recorded; a pure `observedTrack(key, colorIndex, absMag) -> {birth, mass, state}` helper exists in `star-types.js` and is unit-tested for determinism and finite births. |
| C2 | Reference-epoch parity | At `AGE_REF`, packed color/mag restored exactly and rendered brightness within the §6.5 tolerance; the present-day Milky Way frame is unchanged (pixel parity). |
| C3 | Birth gate for streamed blocks | `birthStaging`/`birthBuffer` cover full capacity; `formation.w` reaches catalog; at `T = 0` catalog + local visible count is 0, landmarks still visible. |
| C4 | Look evolution | Earlier epochs change catalog looks monotonically (no 3.4–3.6-style oscillation); inferred giants/WDs revert plausibly. |
| C5 | CPU parity | Picks, searches and rings match GPU visibility across the epoch ladder; `star-record.js` comment corrected. |
| C6 | Streaming stability | Keys, births, positions stable across camera-driven thinning/residency; in-progress look sweep resets safely on `dynamicVersion` change. |
| C7 | Zero-redraw & continuity | `draws = 0` through an epoch walk; 3.4–3.6 Gyr continuity suite still passes. |
| C8 | Scenario text | First light `watch` in `scenarios.js` updated to say catalog stars are gated while curated landmarks remain visible; point at this plan. |
| C9 | Browser pass | V14a re-run on the Milky Way at 0 / 0.5 / 1 / 2 / 13.5 Gyr with catalogBudgetStars > 0; record whether the local sky now reads as *evolving* rather than a fixed overlay. |

## 9. Stop rule and non-goals

- Milky Way only, non-critical. Do **not** regress the 19/19 smoke baseline or the
  passing CPU suites to land any Cx row; each row needs its own catalog-enabled
  test before it counts.
- No positional epoch mapping for catalog/landmark/gap-fill stars (§5.3). No
  change to the density model, the procedural birth law, exposure calibration or
  engine defaults.
- Landmarks and the "SBb is empty at First light" contract stay as they are.
- If Tier B/C extrapolation cannot be made deterministic and present-day-exact
  with reasonable effort, ship Tier A gating (a star appears/ disappears with the
  epoch) first — the most visible half of "out of evolution" — and leave the
  brightness track as a later row. Record that decision here.
