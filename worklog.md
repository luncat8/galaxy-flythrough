# Worklog

Implementation history is grouped by release series. Append entries to the matching
`archive/<major>.<minor>.x-worklog.md`; keep this file as the index.

| Version | Log | Coverage |
|---|---|---|
| 0.1.x | [0.1.x worklog](archive/0.1.x-worklog.md) | Initial planning, experiments, runtime, streaming, cameras, landmarks and HDR |
| 0.3.x | [0.3.x worklog](archive/0.3.x-worklog.md) | 0.3/0.4 planning, GalaxyModel, galaxy types and distributions, composite objects, nebula billboards, galaxy age |
| 0.4.x | [0.4.x worklog](archive/0.4.x-worklog.md) | Kinematic orbits, star-time control, group kinematics, wave-damping capture, simple and apocenter-guided engines, giant-branch evolution, HDR headroom/desat knobs, realistic 3D shapes (bar peanut, truncation floors, age–height coupling), settings presets, engine-mask dispatch |
| 0.5.x | [0.5.x worklog](archive/0.5.x-worklog.md) | Planet series: planning entry so far (star identity and snapshots, the lazy CPU-only generator, search, the close-system schematic, the delta-v map, routes). No runtime code yet. |

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


Current priority: [movement dispatch and CPU/WGSL parity](movement-parity-plan.md).
The browser engine/preset pass and non-critical bar polish are explicitly deferred
in [a separate plan](deferred-browser-visual-plan.md), not completed or blocking.
See the 2026-10-11 triage entry in the 0.4.x log for reproduced failures and scope.

Next series, planned and not started: [the 0.5 planet generator](0.5.0-plan-planet-generator.md).
It is CPU-only and additive, so it neither blocks nor depends on the parity work — with one
coupling, stated in the plan: 0.5.0's arbitrary-star picker must dispatch positions through
the same engine-mask law the parity plan pins, and until a field-star `simple` mirror exists
the picker approximates that mask and says so on screen.
