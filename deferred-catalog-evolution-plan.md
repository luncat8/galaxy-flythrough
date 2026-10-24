# Deferred plan — evolving the Milky Way catalog with the epoch

## Decision and status

**0.7.7 implemented; C9 real-browser evidence remains open.** The deterministic
Tier A/B/C track, streamed birth gates, reference-look restoration, CPU visibility
parity and nonzero-catalog smoke suite are implemented. The full repository suite
passes **43/43**, and the catalog smoke suite passes **4/4** under the CPU fallback.
The earlier committed browser run
`experiments/logs/webgpu-smoke-2026-10-24-04-20.log` is **19/19 PASS** on a real
NVIDIA/WebGPU adapter, but it predates this implementation and is not evidence for
C9. No new real-browser/GPU verdict is claimed here.

The catalog is **Milky Way only** (`configureMode` sets `catalogBudget = 0` unless
`model.milkyWay`), so the defect never appears on any procedural/table galaxy. The
0.7.7 scope is the deterministic Tier A/B/C track below, birth gating for catalog
and local gap-fill, CPU visibility parity, and catalog-enabled smoke coverage.
Preserve the passing baseline; do not retune the density field, field birth law,
exposure calibration, or default engine while closing this. A real-browser V14a
pass remains separate evidence (C9), not something a CPU fallback run can claim.

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

The original formation configurations in `src/core/gpu-smoke.js` construct their
renderers with `catalogBudgetStars: 0` (five sites: firstlight ×2, continuity,
morphology, engines). With no catalog attached, the local/catalog blocks are empty,
so `gateLimit` covers all remaining instances and the First light sky is genuinely
empty. **Those controls cannot see the defect by construction.** The dedicated
nonzero-budget catalog suite (§7) is required; a run with `catalogBudgetStars: 0`
is not evidence that the catalog evolves.

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

## 6. Pinned 0.7.7 design decisions

1. **Track: Tier A + B + C, all deterministic.** `observedTrack` infers `ms` /
   `giant` / `wd` from the reference LUT class. An MS initial mass comes from the
   shared class-bracketed luminosity inverse. A giant has a stable 1–3 M☉ initial-
   mass prior (its observed giant luminosity does not constrain that mass in the
   core law); a WD has a stable 1–8 M☉ progenitor prior. Giants sit at a keyed
   fraction strictly inside their giant interval; WDs sit strictly inside the
   post-giant cooling interval available at `AGE_REF`. Thus the reference state is
   consistent by construction, not by clamping the rendered class afterwards.
2. **Unconstrained ages: conditional reference SFH, not a clamp pile.** An MS star
   samples the thin-disc reference SFH between the later of its component-window
   start / `AGE_REF − 1.1·tMS` and `AGE_REF`, using key channel 16. Long-lived stars
   therefore cover the whole thin-disc window; massive blue stars are conditionally
   young. For a long-lived MS star the expected formation time is exactly the
   existing inverse-CDF result for that channel (1e-6 Gyr comparison tolerance in
   the unit test); no independent histogram fit or extra tolerance is introduced.
   Evolved-state priors are tested by their finite state intervals instead.
3. **Catalog and local both gate off at `T = 0`.** There is no observed-anchor
   exception. Curated landmarks alone carry a `-BIRTH_FADE_GYR` sentinel and remain
   fully visible. Local gap-fill uses its known procedural mass/component and a
   `sampleFieldBirth` reference birth rather than inferring a track from its own
   output; its reference record is the record restored at present day.
4. **Look extrapolation and the 50 Myr endpoint.** The catalog follows `evolveStar`
   at its inferred mass. A smooth correction anchors the derived reference magnitude
   to the observed quantized magnitude, and an observed MS has a small 0.85→1.00
   birth-to-reference luminosity ramp (about 0.18 mag), so long-lived MS stars are
   nearly stationary but not a frozen overlay. RG/RGe/WD reference classes are held
   only while the core is in that same observed state. `formedAt` and the GPU gate
   birth are separate only where necessary: gate birth is
   `min(formedAt, AGE_REF − BIRTH_FADE_GYR)`, so even an O star younger than the
   50 Myr fade is fully present at the reference epoch. Its look still uses the
   inferred physical `formedAt`; the early part of its formation fade shows age 0.
5. **Present-day parity is byte-exact and gate-aware.** At `AGE_REF`, packed catalog
   color/mag bytes must equal the source bytes exactly, local reference bytes must
   round-trip exactly, positions/flags/jitter must not change, and every dynamic
   gate must be 1 (not merely the record restored while still fading). A GPU run
   also compares a reference frame before/after an epoch round trip with **zero
   differing pixels** in the isolated catalog configuration. CPU-only evidence
   covers records and gates; it does not claim the GPU pixel row.
6. **Streaming is metadata, not identity.** Track inputs are the stable catalog key
   and the source quantized look. Dynamic slots may be rewritten, but a key always
   reconstructs the same track. A streaming upload derives the current look
   immediately and resets an in-progress dynamic sweep to the dynamic block start;
   it never restarts or resamples the procedural field.

## 7. Validation plan (catalog-enabled)

The smoke rig now has a dedicated **catalog** suite with `catalogBudgetStars > 0`
on the Milky Way preset; a run with budget 0 (§3) is not evidence. It loads the
real bundle through `TileLoader` (`loadCatalog` in the browser, `prepareBundle` in
Node). The checks are:

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

## 8. Acceptance checklist

C1–C8 have CPU/mock-renderer evidence. C9 remains open until a real browser/GPU
run supplies the pixel and visual evidence; a fallback run cannot close it.

| ID | Status | Acceptance / evidence |
|---|---|---|
| C1 | **Done** | `observedTrack` is shared and deterministic; `star-types-evolution-test` passes **64/64**, including synthetic MS/RG/RGe/WD state and finite-birth checks. |
| C2 | **CPU done; GPU row in C9** | `renderer-test` passes **155/155**: exact packed reference restoration, fixed xyz/keys, gate 1 and camera-restored records. Zero-diff pixel parity still requires real WebGPU readback. |
| C3 | **Done (CPU/mock)** | Full-capacity birth storage and gate limit are asserted; the catalog smoke suite passes **4/4** with nonzero local/catalog populations, zero streamed stars at First light and persistent landmarks. |
| C4 | **Done (CPU/mock)** | Earlier epochs change both streamed populations; the bundled 3,829-star probe found deterministic finite tracks and no sampled luminosity reversal. Synthetic evolved-state fixtures cover RG/RGe/WD. |
| C5 | **Done** | Selection/resolve, search (both scopes) and rings match the global-slot gate at 0, 0.5, 1, 2, 3.5 and 13.5 Gyr; `star-select-test` **51/51**, `search-test` **39/39**. |
| C6 | **Done (CPU/mock)** | Renderer restreaming checks shared keys, births, positions and reference looks, and verifies dynamic sweep reset; `dynamicVersion` remains the invalidation signal. |
| C7 | **Done** | Epoch walks keep `fieldSamples` unchanged; continuity and the full **43/43** suite pass. |
| C8 | **Done** | First light guidance now says catalog/local stars are gated and curated landmarks remain visible, with a pointer to this plan. |
| C9 | **Open** | Re-run V14a on the Milky Way at 0 / 0.5 / 1 / 2 / 13.5 Gyr with `catalogBudgetStars > 0`; record real-GPU pixel parity and whether the local sky reads as evolving. No browser executable is available in this sandbox. |

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
