# Worklog

Implementation history is grouped by release series. Append entries to the matching
`archive/<major>.<minor>.x-worklog.md`; keep this file as the index.

| Version | Log | Coverage |
|---|---|---|
| 0.1.x | [0.1.x worklog](archive/0.1.x-worklog.md) | Initial planning, experiments, runtime, streaming, cameras, landmarks and HDR |
| 0.3.x | [0.3.x worklog](archive/0.3.x-worklog.md) | 0.3/0.4 planning, GalaxyModel, galaxy types and distributions, composite objects, nebula billboards, galaxy age |
| 0.4.x | [0.4.x worklog](archive/0.4.x-worklog.md) | Initial kinematic orbit slice, star-time control, GPU/CPU orbit wiring |

No separate 0.2 implementation entry exists in the original log. The combined
0.3/0.4 planning entry lives in 0.3.x; add a 0.4.x log when its implementation starts.
Historical entries are preserved verbatim; plans remain separate clean artifacts.

Next step suggestion: 0.3.3 is in (SFH, gas depletion, age slider with property-only
regenerate, exposure renormalisation). Next is 0.4 — star movement
(`0.4.0-plan-star-move.md`): predefined orbits without gravity, per-type orbit
distributions, the moving-star budget, and the star-time slider.
