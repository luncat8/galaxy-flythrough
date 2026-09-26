# Worklog

Implementation history is grouped by release series. Append entries to the matching
`archive/<major>.<minor>.x-worklog.md`; keep this file as the index.

| Version | Log | Coverage |
|---|---|---|
| 0.1.x | [0.1.x worklog](archive/0.1.x-worklog.md) | Initial planning, experiments, runtime, streaming, cameras, landmarks and HDR |
| 0.3.x | [0.3.x worklog](archive/0.3.x-worklog.md) | 0.3/0.4 planning, GalaxyModel, galaxy types and distributions, composite objects, nebula billboards, galaxy age |
| 0.4.x | [0.4.x worklog](archive/0.4.x-worklog.md) | Kinematic orbits, star-time control, group kinematics, wave-damping capture, simple and apocenter-guided engines, giant-branch evolution, HDR headroom/desat knobs |

No separate 0.2 implementation entry exists in the original log. The combined
0.3/0.4 planning entry lives in 0.3.x; 0.4.x implementation entries live in the
archive log above. Historical entries are preserved verbatim; plans remain clean.

Next step suggestion: visually compare classic, simple, and apocenter engines on
barred and unbarred galaxies. Measure time-averaged density histograms and review
apocenter eccentricity calibration before changing its non-default status.
