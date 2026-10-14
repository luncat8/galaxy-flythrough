# Worklog

Implementation history is grouped by release series. Append entries to the matching
`archive/<major>.<minor>.x-worklog.md`; keep this file as the index.

| Version | Log | Coverage |
|---|---|---|
| 0.1.x | [0.1.x worklog](archive/0.1.x-worklog.md) | Initial planning, experiments, runtime, streaming, cameras, landmarks and HDR |
| 0.3.x | [0.3.x worklog](archive/0.3.x-worklog.md) | 0.3/0.4 planning, GalaxyModel, galaxy types and distributions, composite objects, nebula billboards, galaxy age |
| 0.4.x | [0.4.x worklog](archive/0.4.x-worklog.md) | Kinematic orbits, star-time control, group kinematics, wave-damping capture, simple and apocenter-guided engines, giant-branch evolution, HDR headroom/desat knobs, realistic 3D shapes (bar peanut, truncation floors, age–height coupling), settings presets, engine-mask dispatch, the §1.4 movement-density gate, 0.4.9 the vertical column (the birth height carried, not rotated into an oscillation) |
| 0.5.x | [0.5.x worklog](archive/0.5.x-worklog.md) | Planet series: planning entry, then 0.5.0 star selection implemented (identity keys, `pickAny` over all five blocks with engine-mask dispatch parity, the snapshot selection set, radius select, fly-to, set rings), 0.5.1 the lazy planet-system generator, 0.5.2 star and planet search (two-stage scan, scope fallback, preset token, `#sysread`), 0.5.3-1 the system-view skeleton (`#system` canvas, `render/system-layer.js`, enter/exit plumbing, the open system's readout), 0.5.3-2 the log-polar layout (habitable-zone annulus, orbit ellipses, star and planet icons), 0.5.3-3 the belt stipples hashed once per system and the system view's own clock (`systime`/`sysview` on the settings line), 0.5.3-4 schematic picking, the selection ring and the hovered designation, with `experiments/system-layer-test.js` as the headless contract for the whole readout, 0.5.3-5 the readout's per-planet and belt lines, 0.5.4 the delta-v map (`src/math/deltav.js`, the §7.5 graph and table on the `#system` canvas, `B` plus the `budget` slider and `ship` select, `experiments/dv-map-test.js`), 0.5.5 routes and the autopilot (`src/core/route.js`: the leg chain, the synodic wait, the interstellar cruise, the two-way totals and `routePosition`, with the ship icon and the graph's endpoint picking in `src/render/system-layer.js` and `experiments/route-test.js`), plus 0.5.x-3 the series' README close-out (the §2.3 channel map written into the architecture list, the experiments test table filled out, the stale parity pointers corrected). Series complete: 0.5.0–0.5.5 |

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

Next series: [the 0.5 planet generator](0.5.0-plan-planet-generator.md). 0.5.0 (star
selection), 0.5.1 (the lazy deterministic planet-system generator), 0.5.2 (star and
planet search), 0.5.3-1 (the system-view skeleton: `#system` canvas, `render/system-layer.js`,
enter/exit plumbing, `#sysread` as the open system's readout), 0.5.3-2 (the
log-polar layout: the radial axis, the habitable-zone annulus, the orbit ellipses,
the star and planet icons), 0.5.3-3 (the belt stipples hashed once per system and
the system view's own clock, with `systime`/`sysview` on the settings line) and
0.5.3-4 (schematic picking: the selection ring and the hovered designation, with
`experiments/system-layer-test.js` as the headless contract for the whole readout),
0.5.3-5 (the readout's per-planet and belt lines) and 0.5.4 (the delta-v map:
`src/math/deltav.js`, the §7.5 graph and table on the `#system` canvas, `B` plus the
`budget` slider and `ship` select, `experiments/dv-map-test.js`) and 0.5.5 (routes and
the autopilot: `src/core/route.js`, the leg chain over the delta-v closed forms, the
synodic wait, the interstellar cruise, the two-way totals, `routePosition` and the ship
icon with the graph's endpoint picking in `system-layer.js`,
`experiments/route-test.js`) are implemented — see the 2026-10-12 and 2026-10-13 entries
in the 0.5.x log. The series is complete: 0.5.0 through 0.5.5, CPU-only and additive, so it
neither blocks nor depends on the parity work — with one coupling, stated in the plan:
0.5.0's arbitrary-star picker dispatches positions through the same engine-mask law the
parity plan pins, and until a field-star `simple` mirror exists the picker approximates
that mask and says so on screen (measured: 3.2 ms frozen, 55 ms dispatched at 300k
records; the pre-reject is specified and not built).
