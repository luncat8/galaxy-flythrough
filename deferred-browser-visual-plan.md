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

0.5 section (added 2026-10-12, with 0.5.0): the selection work is CPU-only, so the
browser pass asks whether it *reads*, not whether it computes.

| ID | Task | Acceptance / evidence |
|---|---|---|
| V7 | 0.5.0 picking and the set | Milky Way preset, labels on. Click a field star, an object member and a catalog star: the yellow primary ring lands on the star under the cursor, and the `selected` line names it (a landmark keeps its name; anything else is `S<key36>`). Shift+click adds; the dimmer set rings appear; `N` cycles the primary, `X` clears, `F` flies in and stops at a readable stand-off (not inside the star, not with the star behind the camera). Repeat under each engine mask and record: (a) whether the ring appears on the click or a few frames later (the sweep is chunked; ~170 ms classic, ~400 ms apocenter at 300k), (b) whether the readout's `approximated` case is visible under the apocenter pass, (c) whether a click during star-time motion lands on the star as drawn. |
| V8 | 0.5.0 radius select | `Select around` at 50 ly and at 10 kly: the readout count matches what is visible, the set rings appear only for stars still resident (a member whose cell streamed out keeps its readout line and loses its ring), and the log slider's readout reads back in ly. Then change the galaxy age with a set held: the readout's mass/lum/age must follow the new epoch (re-derived in place), and a type/seed change must clear the set. |
| V9 | 0.5.3 system view | Milky Way preset, labels on, a star selected (a landmark such as Sirius keeps its name in the readout; a field star reads `S<key36>`). `V`: the camera comes onto the star (a fly when farther than 1 pc, else only the orbit-object switch), the `#system` schematic paints above the galaxy — HZ annulus, one ellipse per planet, stippled belts, star and planet icons with the giant ring / locked half-disc / terran outline marks — and `#sysread` swaps from any search report to the system block at 4 Hz. Move the system-time slider: planets ride their ellipses, each belt rotates at its own rate, −1 follows the camera fly speed while the orbit keys drag; the galaxy's Myr/s star-time slider must not visibly move the schematic. Hover a body for its designation; click planet / belt / star to move the ring and the ◀ marker; an empty-space click clears the selection but stays in the view. Exit with `Esc`, `V` or the button: the canvas erases, the readout returns to the search text (hidden while empty), the camera keeps its orbit target, and the fly keys work again once the camera mode returns to fly. The menu's System rows appear only while the view is open. While there, record the 0.5.2 gap too: the search block and its report line render without overflow at 1280×800. |

0.6 section (added 2026-10-14, with E2; V11 added with E3): the epoch tier is
geometry, so the browser pass asks whether the *sequence of epochs* reads as evolution
rather than as a stutter, and whether a young epoch reads as a young *galaxy*.

| ID | Task | Acceptance / evidence |
|---|---|---|
| V10 | The live epoch clock (E2) | Milky Way preset, menu open, star time at 5 and then 99 Myr/s. Tick **Evolve with star time** at present day: the field replays from 0.2 Gyr and the epoch readout beside the Myr/s control steps 0.1 Gyr at a time, one step per 100 Myr of star time. Record: (a) whether the rebuild hitch per step is acceptable at the default star budget and at `?stars=50000`, with the frame-time readout before and after; (b) whether the stars visibly *jump* between draws (they must — a step is a new draw, not a morph) and whether anything else moves with them (camera, labels, a held selection set resolved by key, an open system view); (c) whether dragging **Age** mid-run retargets the next step cleanly, `T` freezes both clocks, and the run holds at 13.5 Gyr; (d) whether the readout ever disagrees with the Age slider or the drawn field (it must not: the readout is the built epoch). Compare against a plain age-slider drag at the same epochs, which must look identical. |
| V11 | The growing morphology (E3) | Milky Way preset at **Age** 2 Gyr, then 0.5 Gyr, then 13.5 Gyr (and once with **Evolve with star time** running through all three). Record: (a) at 2 Gyr the bar reads as a *shorter* bar (≈1.3 kpc, 0.56×) with the arm ridges leaving its ends — no seam, kink or hub-and-spoke gap at the moved tip, which is the re-anchored `phase0`'s whole job; (b) the bulge is compact but *not dimmer at its centre* — the assembly is size now, so the central density is the reference's (the amplitude is unchanged) while the body's extent shrinks; at a fixed radius outside the core the young bulge is the reference profile read at a smaller scale, so compare against the same radius at 13.5 Gyr rather than expecting equal brightness there; (c) at 0.5 Gyr the inner arms are tightly wound around a 0.55 kpc stub and the bar visibly spins faster (watch one ridge over a few hundred Myr of star time) without the field reading as a pinwheel artifact; (d) the 13.5 Gyr frame is pixel-identical to the pre-E3 sky at the same seed and exposure (the exactness contract, as a picture); (e) the epoch tooltip's `×size` agrees with what the bar's length looks like it did at 13.5 Gyr. An Sb/Sa table type at the same ages is the cross-check that the coupling is the table's and not the preset's. |

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
