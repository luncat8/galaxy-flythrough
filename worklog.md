# Worklog

Implementation history is grouped by release series. Append entries to the matching
`archive/<major>.<minor>.x-worklog.md`; keep this file as the index. Interface work is the
one series with no version number — it can land at any time, beside or between the model
releases — so it goes to `archive/ui.x-worklog.md` as `ui.<n>` entries.

| Series | Log | Coverage |
|---|---|---|
| 0.1.x | [0.1.x worklog](archive/0.1.x-worklog.md) | Initial planning, experiments, runtime, streaming, cameras, landmarks and HDR |
| 0.3.x | [0.3.x worklog](archive/0.3.x-worklog.md) | 0.3/0.4 planning, GalaxyModel, galaxy types and distributions, composite objects, nebula billboards, galaxy age |
| 0.4.x | [0.4.x worklog](archive/0.4.x-worklog.md) | Kinematic orbits, star-time control, group kinematics, wave-damping capture, simple and apocenter-guided engines, giant-branch evolution, HDR headroom/desat knobs, realistic 3D shapes (bar peanut, truncation floors, age–height coupling), settings presets, engine-mask dispatch, the §1.4 movement-density gate, 0.4.9 the vertical column (birth height carried, with the classic wobble's half-headroom cap keeping stars inside the explicit slab) |
| 0.5.x | [0.5.x worklog](archive/0.5.x-worklog.md) | Planet series: planning pass, 0.5.0 — per-record star identity, the chunked CPU picker, the snapshot selection set (primary + 256), fly-to, radius select, set rings — and 0.5.1 complete: the input tier, the occurrence tier (μ, f_Z/state bulk weights, the geometric count draw), the architecture tier (disc edges, log-uniform axes, bulk/mass draws, Hill repair, orbital elements), the insolation/temperature/band tier (one `thermal` pass: Teq, band refinement, runaway/thermostat with its clamp, locking, HZ/terran/hot-Jupiter flags), the belt/moon tier (snow line, fade, scouring, the cap that orders the two belts, the Ceres typical body, the stipple seed and law, `floor(moonMax·u³)`) and the record tier (`SystemRecord`/`generateSystem`, the `systemSummary` pointer with its histograms and range extremes, the §4.11 designation writers). The 0.5.1-5 review corrected five plan/code divergences; the 0.5.1-6 review added the two pins its belt/moon prose implied but nothing checked (the derived 2161 kg/m³ and the scouring count's exact bulks). 0.5.2 search shipped: the two-stage scan (`core/search.js`, token grammar, selection→galaxy fallback), the menu block with the token box, results in `#sysread`, add-results-to-selection, the `search`/`scope` preset fields, and `search-test.js` at 32/32 with every §5.3 budget passing (no frame chunking needed). 0.5.3 system view shipped: `render/system-layer.js` — the log-polar schematic (HZ annulus, orbit ellipses with `cos i` squash, belt stipples hashed once per opened system, star/planet icons with the five-bucket mass ramp, selection ring and hover designation), its own system-time clock (−1…99 y/s, frozen default, −1 coupled to the camera fly speed through `FLIGHT_TIME_GAIN`), enter/exit on V/Esc/button with the orbit-object camera lock, the byte-exact §6.6 readout in `#sysread` (shared with the search report), the `data-view`-gated menu rows, the `sysview`/`systime` preset fields, and `system-layer-test.js` at 47/47 (zero allocations over 1 000 draws, 426 stub ops/frame inside the ~800 budget). 0.5.4 delta-v map shipped: `src/math/deltav.js` — pure SI closed forms (v_circ/v_esc, SURFACE↔LO launch/landing with drag/landing-credit tables, LO↔GEO Hohmann, LO↔ESCAPE, LO↔L5 spiral, star-centred Hohmann transfers, single-burn Oberth departure, aerocapture capture credit, the energy-budget time blend `t(dv)` with the Hohmann/brachistochrone crossover `dv_x = 4d/t_H` and synodic wait scaling), plus the five ship classes' (chemical/nuclear/fusion/stardrive/generation) accel/dv table and their `dv/accel` tank-empty invariants; `experiments/dv-map-test.js` pins the published Solar-System numbers (LEO v_circ 7.76, surface→LEO 9.66, GTO 3.91, GEO 42 163 km, escape 3.21, TMI 3.60, Earth-escape→Mars 2.95, Mars aerocapture 1.26, LEO→LMO 4.86 aero / 5.70 propulsive, LEO→Ceres dep 4.90, Ceres capture 4.57, Earth→Mars 258.8 d, synodic 780 d, dv_x ≈ 106 km/s, surface→surface aero 16.02) plus structural invariants (Oberth single-burn ≤ two-burn, GEO existence rules for Earth/Moon, `t(dv_min) = t_H`, monotonicity, `t → 4d/dv`). The graph draws on the same `#system` canvas, toggled by `B`/button inside the system view (star at left, bodies in a-ordered columns, nodes stacked vertically per body — surface/LO/GEO/L5/escape skipping what the body lacks, adjacent edges labelled with the Hohmann and LO→LO km/s values); a feasibility table below shows per-destination dv, t_H, t(budget) and ship class; `#sysread` gains the §6.6 `dv  <letter>` block for the selected body (surface→LEO, LEO→GEO, LEO→escape, per-neighbour departure+aerocapture breakdown, surface→surface total, and the t-at-budget lines); menu adds `dvmap` toggle, `budget` log slider (0.35 default) and ship-class selector, all three carried as preset fields (`dvmap`, `dvbudget`). 0.5.5 ships/routes/autopilot shipped: `core/route.js`, signed windows, cumulative fuel/life limits, interstellar cruises, round trips, node picking, class-colour ship and system-time flight; 0.5.7 fixes System-panel exit, autopilot state/clock guidance and schematic animation regressions (route 41/41), full suite. |
| 0.6.x | [0.6.x worklog](archive/0.6.x-worklog.md) | 0.6.0 — the epoch tier (E1): `modelAtAge` re-solves what the galaxy *is* at an earlier epoch (spheroid assembly, disc heat, arm contrast; every factor exactly 1 at `AGE_REF`), plus the runtime coupling (E1b) an age change now implies (a re-drawn field, the re-seeded simple mirror, the selection set re-resolved by key); then **E2 shipped** — the epoch's live clock: the quantum (`AGE_STEP` 0.1 Gyr, moved to `galaxy.js`), its star-time price (`EVOLVE_MYR_PER_STEP` 100 Myr, the unit bridge rather than a second rate), `steppedAge`'s grid, the replay rule (`evolveStartAge`), the drop-not-bank tick (`evolveTick`), the shared `AGE_REGEN_INTERVAL` throttle with the Age drag, the `Evolve with star time` toggle + epoch readout in the Galaxy menu, the `evolve` preset field and the `Evolve` built-in preset; then **E3 shipped** — morphology growth: the assembly moved from amplitude to size (`spheroid.a/b/c ×= spheroidProgress^⅓` at the reference density, the delivered bulge mass still exactly `spheroidProgress` — the double-scaling `progress²` reading measured and rejected), the arm anchor riding the bar's tip (`minRadius ×= size`), the ridge re-anchored by the additive `Δphase0 = K·ln(size)` with its `Δ === 0` exactness guard, and the bar's pattern speed re-derived from its own length through the build's own `barPatternSpeed`; then the first user browser pass: the pattern-phase rebase on every same-galaxy re-draw (the Evolve step no longer turns the bar back by ΔΩ_p·T — superseded by E4's accumulator), the **Stars** budget ladder, the preset paste gate and prompt-free Ctrl+V, collapsible panels, and the one-line system brief; then **E4 shipped** — continuous epochs, the fix the user's rejected V10 rebase pointed at: the field is drawn once and *placed* at the running epoch (`orbit.setPatternClock` accumulator, `orbit.epochMap` + the WGSL twin on `camera.epoch`, per-frame look slices with the exposure on the uniform, the ridge re-anchor read from E3's own `K·ln(size)` so the map is continuous by construction, the composite objects re-placed on an age-rationed stamp), so an epoch change is a model re-solve and a uniform — no re-sample, no 300 ms step, and the same stars across the run; plus the rigid single-object cluster motion, the 75/25 halo-vs-disk/bulge cluster split and the 3-D halo orbits (see `archive/0.6-report-cluster-motion.md`) |
| ui.x | [ui.x worklog](archive/ui.x-worklog.md) | Interface series, unversioned on purpose (it can land at any time): ui.0 eased fly-to — the 2 s eased flight, the live arrival pose, the orbit handover and the moving-target follow; ui.1 Search & Selection — typed current/previous histories, two-slot asset pair, 10 pc current-star search with clickable results, previous → current star routing, and selection/search/store tests; ui.2 the drawn-position contract — fly-to and select-around read where the sky draws a star, not its birth record |

No separate 0.2 implementation entry exists in the original log. The combined
0.3/0.4 planning entry lives in 0.3.x; 0.4.x implementation entries live in the
archive log above. Historical entries are preserved verbatim; plans remain clean.

The 0.4.8 realistic-shapes task list is complete (M3.3 landed: age coupled to height,
young/old scale-height ratio 0.31 on the Milky Way preset). The plan's remaining limits
are a dimpled X-shaped bar and leaving star movement on geometry rather than density.

The root now holds only open work. The seven plans of shipped series moved to `archive/`
on 2026-10-11 (`0.2-plan-HDR-saturation.md`, `0.3.0-plan-galaxy-types-star-distribution.md`,
`0.4.0-plan-star-move.md`, `0.4.7-draft-new-star-movement-type.md`,
`0.4.8-plan-realistic-3d-shapes.md`, `damping-plan.md`, `plan-0.1.1-tasks.md`), along with
the `0.5-draft-planet-generator.txt` brief that the new plan consumes. `plan.md` §19 is the
index: shipped plans under one heading, the open series under the next. An archived plan is
still the spec a fork reimplements from — archived, never deleted.


0.6.0 (the epoch tier, E1), E2 (the epoch's live clock: the epoch runs on the
star-time axis), E3 (morphology growth: the spheroid assembles in size — `a/b/c ∝
mass^⅓` at the reference density — the arm ridge re-anchors to the moving bar tip by
the additive `Δphase0 = K·ln(size)`, and the bar's pattern speed follows from its own
length) and E4 (continuous epochs: the field is drawn once and placed at the running
epoch — the phase accumulator, the epoch map on a uniform lane and per-frame look
slices replace the re-sample and the rebase the user's V10 report was about) shipped
2026-10-14 — see `archive/0.6.x-worklog.md` and `evolution-plan.md`; E5 (events) and
E6 (chemical evolution) are the rest of the series, and none of them owns a visual
verdict.

Current priority: the deferred browser/WebGPU pass on real hardware
(`deferred-browser-visual-plan.md` — V8 for the 0.5 routes and autopilot, then V1–V4
for the engines, labels and presets). Movement dispatch and CPU/WGSL parity shipped
2026-10-11 (0.4.x log entry; `wgsl-exec` 100/104 → 115/115); the numerical
movement-density measurement landed 2026-10-13 (`experiments/movement-density-test.js`,
98 checks) and 0.4.9 shipped the vertical-column contract it opened on 2026-10-14
(`archive/0.4.9-plan-vertical-column.md`): the radial profile, the arm pattern and the
truncation held, the vertical column did not (0.66–0.87 of the field's mean|z|), and
the centred orbital plane that compressed it was replaced by a sweep basis that
carries a star's birth height. Both of plan.md's follow-up items that gate an engine
default change are therefore closed; what remains is the browser pass itself.

Complete: [the 0.5 planet series](archive/0.5.0-plan-planet-generator.md) — 0.5.0 (selection)
shipped, 0.5.1 (the generator) complete (input, occurrence, architecture,
insolation/temperature/band, belt/moon and record tiers landed — `SystemRecord`,
`generateSystem`, `systemSummary` and the designations included); 0.5.2 (search) shipped
(the scan, the menu block, `#sysread` results, the token preset); 0.5.3 (the schematic)
shipped (`render/system-layer.js`, the system-time clock, the V key, the §6.6 readout,
the `data-view` rows); 0.5.4 (the delta-v map) shipped (`src/math/deltav.js`, the graph
on `#system`, the B key, the budget slider, ship selector, the §6.6 dv block, the
Solar-System pin tests at 38/38); 0.5.5 (ships, routes, autopilot) shipped; optional economy omitted. The series is
CPU-only and additive, so it neither blocks nor depends on the parity work above — with
one coupling, stated in the plan and landed with 0.5.0: the arbitrary-star picker
dispatches positions through the same engine-mask law the parity plan pins
(`orbit.engineRecordPosition`), and until a field-star `simple` mirror exists the picker
approximates that mask and says so on screen.
