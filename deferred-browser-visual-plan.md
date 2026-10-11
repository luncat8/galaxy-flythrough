# Deferred browser / WebGPU validation and visual polish

## Decision and scope

These tasks are explicitly deferred, not completed and not prerequisites for
sandbox-safe correctness work. The user's assessment is that Sb-type galaxies
look broadly acceptable and bar issues are non-critical. Preserve that baseline;
do not retune the density field, bar mass, sampling, or default engine without
new evidence. `classic` remains the default; `apocenter` remains experimental.

Keep this plan separate from the analytical contracts in `plan.md` and the
0.4.x model plans. Results belong in `archive/0.4.x-worklog.md`; a proposed model
change needs its own contract, measurement, and parity tests before implementation.

**Priority:** complete [movement parity](movement-parity-plan.md) first. Visual
polish must not block it. Clipboard/file browser behavior is a functional check,
not cosmetic tuning, even though its real-browser validation is deferred here.

## Environment and stop rule

Use a normal WebGPU-capable browser on the user's machine, with an actual GPU.
Open `src/index.html` locally or run `python3 scripts/run.py serve` and visit the
local server. Test clipboard permissions separately in the local-file and
localhost contexts; availability may differ. A hosted preview adds iframe/origin
restrictions and is not a substitute for local-file validation.

Time-box initial setup to 10 minutes. If no adapter is available, browser setup
requires downloads/drivers, or permissions cannot be exercised, record the blocked
case and stop. Do not build a browser/GPU automation stack just for this pass.
CPU WGSL interpretation and stub-device tests do not count as visual validation,
GPU-driver validation, or a performance measurement.

## Deferred checklist

All rows remain **deferred / not verified** until evidence is recorded.

| ID | Task | Acceptance / evidence |
|---|---|---|
| V1 | Three movement engines | Compare `classic`, `simple`, `apocenter` separately on Sb, SBb and the Milky Way preset. Use identical seed, age, star budget, camera and display settings. Observe frozen time, 1 and 5 Myr/s; pause/resume, reset, switch engines, and change pattern speed. Record disappearing stars, discontinuities, unstable arms/bars, or unexpected centre drift. Do not assume every engine switch preserves positions: record the time/reset behavior. |
| V2 | Labels, picking and combinations | After movement parity is fixed, repeat the Milky Way view with labels, constellations and a selected star under each engine and a simple+apocenter combination. Labels and click targets must follow rendered stars; menu use must not move/pick the scene inadvertently. |
| V3 | Preset copy/paste | Copy settings, change them, then paste/apply. Confirm active engine fields and controls round-trip. Exercise clipboard allowed, denied/unavailable, empty clipboard, and manual textarea paste + Apply. Denial must leave a usable manual fallback, not an unhandled error. |
| V4 | Preset save/load | Save a populated textarea (Save currently saves its contents), and test an empty textarea (serializes current settings). Load each file and confirm the same supported settings. Check file-dialog cancellation and invalid/empty input without crashing or applying unintended settings. General presets carry settings, not camera/epoch; separately verify the Milky Way button's frozen Sun-side arrival and constellations. |
| V5 | Bar polish | Capture face-on and edge-on SBa/SBb/SBc/SBd and Milky Way views. Classify the concern: silhouette, arm attachment, contrast/exposure, or time-dependent deformation. First compare frozen vs moving and hold exposure fixed. Tune only after a reproducible issue is isolated; a dimpled X/barlens or new vertical component is a separate model feature, not a quick cosmetic fix. |
| V6 | Performance and extended coverage | Only if needed: target-GPU timing, high budgets, HDR display behavior, other types and long-running sessions. Record GPU, browser, resolution and budget. No target-FPS claim from the CPU interpreter or software rendering. |

For each engine start from the same reset/reload state rather than inheriting the
previous engine's accumulated time. Copy a complete preset for reproduction;
record camera pose/view separately because the settings line does not serialize it.
Start with V1–V4 in one short session; broaden coverage only if those find a defect.
V5–V6 can remain deferred indefinitely while the appearance is acceptable.

## Result template and escalation

Record: task ID; date; browser/version; OS/GPU; file/localhost/preview context;
preset; camera/view; elapsed simulation time and time rate; steps; expected vs
observed; pass/fail/blocked; optional screenshot or short clip location. Keep large
recordings outside Git.

Reprioritize crashes, device errors, unusable controls, preset data loss, or a
repeatable label/render mismatch as correctness bugs. Aesthetic bar imperfections
stay here. Never weaken sampler/field or CPU/WGSL tolerances to approve a visual
change, and never report a deferred row as passed.
