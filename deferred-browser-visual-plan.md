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

0.6 section (added 2026-10-14, with E2; V11 added with E3; V12 added with G5): the epoch tier is
geometry, so the browser pass asks whether the *sequence of epochs* reads as evolution
rather than as a stutter, and whether a young epoch reads as a young *galaxy*.
V12 joins it from game-mode G5: the clock presets are interactive, so only a live
browser can show whether the coast warp reads as playable rather than as a stutter.

| ID | Task | Acceptance / evidence |
|---|---|---|
| V10 | The live epoch clock (E2) | Milky Way preset, menu open, star time at 5 and then 99 Myr/s. Tick **Evolve with star time** at present day: the field replays from 0.2 Gyr and the epoch readout beside the Myr/s control steps 0.1 Gyr at a time, one step per 100 Myr of star time. Record: (a) whether the rebuild hitch per step is acceptable at the default star budget and at `?stars=50000`, with the frame-time readout before and after; (b) whether the stars visibly *jump* between draws (they must — a step is a new draw, not a morph) and whether anything else moves with them (camera, labels, a held selection set resolved by key, an open system view); (c) whether dragging **Age** mid-run retargets the next step cleanly, `T` freezes both clocks, and the run holds at 13.5 Gyr; (d) whether the readout ever disagrees with the Age slider or the drawn field (it must not: the readout is the built epoch). Compare against a plain age-slider drag at the same epochs, which must look identical. |
| V11 | The growing morphology (E3) | Milky Way preset at **Age** 2 Gyr, then 0.5 Gyr, then 13.5 Gyr (and once with **Evolve with star time** running through all three). Record: (a) at 2 Gyr the bar reads as a *shorter* bar (≈1.3 kpc, 0.56×) with the arm ridges leaving its ends — no seam, kink or hub-and-spoke gap at the moved tip, which is the re-anchored `phase0`'s whole job; (b) the bulge is compact but *not dimmer at its centre* — the assembly is size now, so the central density is the reference's (the amplitude is unchanged) while the body's extent shrinks; at a fixed radius outside the core the young bulge is the reference profile read at a smaller scale, so compare against the same radius at 13.5 Gyr rather than expecting equal brightness there; (c) at 0.5 Gyr the inner arms are tightly wound around a 0.55 kpc stub and the bar visibly spins faster (watch one ridge over a few hundred Myr of star time) without the field reading as a pinwheel artifact; (d) the 13.5 Gyr frame is pixel-identical to the pre-E3 sky at the same seed and exposure (the exactness contract, as a picture); (e) the epoch tooltip's `×size` agrees with what the bar's length looks like it did at 13.5 Gyr. An Sb/Sa table type at the same ages is the cross-check that the coupling is the table's and not the preset's. |
| V12 | The clock presets (G5) | Game mode, a stardrive hull, a star selected 1 ly out. **arcade clock**: the button lights, the HUD reads `ship clock arcade +0.5 y/s`, and on an autopilot approach the coast's rate note turns into `coast warp +X y/s` — record whether the coast visibly compresses into a few wall-seconds, whether the burn/flip/brake still read at the base rung, and whether the arrival is smooth (the warp follows the decaying ETA). Then the wheel: it must reshape the base rung while the warp stays armed. **sim clock**: the readout is `ship real ×1`, one wall-second is one ship-second (a thrust tap is a real second's burn, life support counts real years), and the warp is off. Freeze with `T` during a coast: the clock reads `frozen`, no `coast warp` note, and unfreezing resumes. Both buttons are disabled while observing and lights follow the live hull. |
| V13 | The three workspaces (ui.20) | Milky Way preset. `1/2/3` and the mode-bar chips: each switch swaps the panel set (observe: Search/System & routes/View modes/Display/Controls; fly: Flight/Controls; command: Search/System & routes/Trade/Controls) with no panel pixel-shift inside a column, the Controls deck reprints (no greyed foreign controls), the HUD leads with `mode <name>`, and the mode-bar clock names the owner (star / ship / trade). `g` enters fly and returns to the workspace it came from; `Tab` hides everything and a chip re-click restores. The panels menu: checking a hidden panel shows it (persists per workspace across reload), *freeze* pins the set so opening `V` does not auto-show System & routes. In fly the trade overlay draws ports and hull dots only (no route lines, no frontier crosses). Command: Send/Commission/expansion are live, a port-row click flies the camera over, **Found at selected** founds on the selected star or explains its refusal. Requisition a sailing hull from Flight's *Network hulls* list: the camera lands on a loaded freighter mid-chord aimed along its route, the network dot disappears, the fleet shows the crewed row; dock at a settled port and **Release to network** delivers the hold and the hull's dot returns. Record any panel flicker on switch, a stale inset (overlay text under a visible panel), or a workspace switch that moves the camera. |

### 0.7 section (added 2026-10-23) — formation, and the panel that makes it checkable

The formation series (`formation-plan.md`) is the one part of the model whose
verdict is *entirely* visual: whether an epoch reads as a history rather than a
tint, whether a star arrives or pops, whether the gas the arms show is the gas
the census holds. V14 is that pass. It is driven from the **Formation checks**
panel (`ui.21`), not from the sliders: every row sets star time, Evolve, the
epoch and the camera in one press, prints what to look at and what proves it,
and reports the live account (formed %, view gas, arm contrast, bulge size and
the field draws since the row started).

Record the row's own settings line with **Copy line** (the panel also writes it
into the preset box) — it is a preset, so the frame reproduces. Start each row
from the same galaxy, type and star budget; the rows keep Type, Seed, Stars and
the look, and change only the clock and the camera. Two guards make the notes
honest: the state line says *different galaxy* when Type or Seed changed under a
running row (a comparison is only a comparison at one field), and Present day is
in the select as well as on its own button, so "the same camera at 13.5 Gyr" is
one press rather than a slider hunt.

| ID | Task | Acceptance / evidence |
|---|---|---|
| V14a | **First light (T = 0)** (`firstlight`) | The procedural field is *absent*, not dim: no field stars anywhere in the frame, formed 0 %, gas 1.00, epoch 0.0 Gyr, bulge ×0.00. Milky Way catalog stars, landmarks and the local gap-fill are not gated (0.7.1's scope) — record what still draws from the Sun view and confirm it is those blocks, not the field. The catalog/local overlay that keeps a fixed look at every epoch is the one reported visible defect; it is tracked, deferred and Milky Way only, in [deferred-catalog-evolution-plan.md](deferred-catalog-evolution-plan.md) (row C9 re-checks V14a once gated). Switch Type to SBb and repeat: no stars, only the cold gas grid. The automated First light rig tests the stellar gate with gas hidden, then tests a separate gas-only frame. No NaN, no vanishing UI, no crash at the boundary. |
| V14b | **Condensation 0 → 1 Gyr** (`condense`) | The epoch advances continuously at 0.02 Gyr per wall-second. Record: (a) stars appear and brighten through the fade instead of popping as a block, at the default budget and at `?stars=50000`; (b) nothing already on screen jumps to a new position — the same star stays where it was and only gains brightness; (c) `draws` stays at 0 through the whole run; (d) formed % climbs monotonically and the gas falls. |
| V14c | **Full walk 0 → 13.5 Gyr** (`walk`) | The whole history at 0.099 Gyr per wall-second (~136 seconds). Record: (a) `draws` is 0 at the end (a clock tick never re-samples); (b) the bulge assembles in extent while its centre keeps its brightness, and the arms lose contrast as the gas falls; (c) the bar and arms never turn backwards between steps (E4's phase accumulator); (d) the run holds at 13.5 Gyr with the readout at 135/135; (e) frame time before/after at the default budget. |
| V14d | **Gas-rich arms, 1.0 Gyr vs today** (`youngarms`, then Present day) | Read the arm × and the gas off the live line at 1 Gyr, then press **Present day** without moving the camera. Record: (a) the same stars, re-placed (a model re-solve and a uniform — since 0.7.3b the press takes the epoch path, so there is no re-draw, no hitch and no lost selection); (b) the view gas is near 1.00 and the arms are at their ceiling young, and the present frame is the type's own fraction with the arms at ×1; (c) the difference reads as "gas left", not as a brightness grade — i.e. the ridge contrast changes while the disc's mean brightness does not. |
| V14e | **Bulge assembly, 2.0 Gyr vs today** (`bulge`) | Compare with Present day from the same camera. Record: (a) the bulge body is smaller and its centre is not dimmer; (b) the bar is shorter and the arm ridge leaves its tip with no seam, kink or hub-and-spoke gap; (c) the epoch tooltip's ×size agrees with the bar length you just looked at; (d) an Sb/Sa type at the same age behaves the same (the coupling is the table's, not the preset's). |
| V14f | **The step buttons** | With any row run, press **+ 0.1 Gyr** along 0 → 1 Gyr and back. Record: (a) each press is a model re-solve, not a hitch or a re-draw (`draws` unchanged); (b) the live line's step counter, the Age slider and the epoch readout always agree; (c) stepping back restores the earlier frame's look (the same stars, the same gate). |
| V14g | **The account against the SFH** (cross-check) | The view gas and SFH gas have the same endpoints but different interior laws. The HUD's object counts are the carried reference census, not a live SFH readout; HII emission now reads the local grid rate. Use `gas Δ` to compare the grid's analytic total with the census account; a nonzero interior difference is expected and is not the histogram error. If the live line ever reads `gas —`, the histogram is missing and the field fell back to the prior: record it as a defect, not as an aesthetic note. |


| V14h | **The gas picture at 1280×800** | Compare First light, 1 Gyr and Present day with fixed exposure and camera, face-on and tilted. First light is gas-only; the present-day grid is faint, not a bright second disc. Record the preset, screenshot, pixel size and GPU frame time; the 640×400 CPU radiance measurement is not an aesthetic verdict or a GPU timing. |
| V14i | **Local HII emission** | Fly within 5 kpc of a visible HII region (the billboard size/distance cull intentionally hides it in a distant overview). Freeze star time; seek the epoch forward/back and repeat the same epoch, recording the view. Light follows its local source and its own birth fade without changing object identities. Then pan/translate the camera: the shell must stay at its galactic seat, not follow the eye. Planetary/SNR light must not disappear because a cold-gas cell empties. Record epoch, camera and movement engine; whole-galaxy First light alone cannot exercise this path. |

0.7.5 headless evidence covers the local-rate arithmetic, camera subtraction,
source-cell isolation and ping-pong ownership. A Dawn **null** backend validated
shader compilation and GPU API usage, not pixels or timing. V14h/i remain open;
the CPU fallback explicitly skips the gas-only pixel verdict.

### First user pass (2026-10-14) — findings and what they changed

A partial real-browser pass by the user, recorded here as evidence; no row is passed
by it, and V3/V10 need a re-check against the fixes (0.6.x worklog, same date).

| Row | Observed | Disposition |
|---|---|---|
| UI | A panel closed with `×` had no visible way back (only `Tab`). | Fixed: `▾` (or the title) collapses a panel to its header; `Tab` still hides both. The System panel's collapse no longer exits the view. |
| V3 | Copy works. Paste prompts on every use; a clipboard that is not a preset was printed into the box. | Fixed: `Presets.presetQueryOf` gates paste and Load (non-presets are reported, not printed); `Ctrl+V` over the scene applies a preset from the paste event with no prompt. The button's prompt is the browser's own guard on `clipboard.readText` and stays. Re-check: allowed / denied / junk / empty clipboard, and `Ctrl+V` with a slider focused. |
| V1 | `apocenter` alone at 0 % share: nothing moves at any pattern speed. | By contract (movement-parity decision 1: mask 4 leaves the unselected share at birth). The menu now says so under the share slider while apocenter is the only pass. Changing the contract is a separate decision. |
| V10a | ~300 ms hitch per Evolve step at the default 300 k stars. | A **Stars** ladder (30k–500k, applied on release) in the Galaxy menu; built-in presets keep the viewer's budget. Re-check (a) at 50k. |
| V10b | Each Evolve step looked like going *back* in time. | Fixed: E3's per-epoch Ω_p with an un-reset star clock turned the pattern by ΔΩ_p·T per step; same-galaxy re-draws now rebase the phase origin (evolution-plan E2, "The pattern does not jump"). Re-check (b): the stars still jump (a new draw), the bar and arms do not turn back. |
| new | One-line system brief under `selected` (class, counts, `☀️-0.39-🌋-…` AU strip) before opening V. | Shipped; check it reads at 1280×800 with emoji fonts and hides while the view is open. |

For each engine start from the same reset/reload state rather than inheriting the
previous engine's accumulated time. Copy a complete preset for reproduction;
record camera pose/view separately because the settings line does not serialize it.
Start with V1–V4 in one short session; broaden coverage only if those find a defect.
V5–V6 can remain deferred indefinitely while the appearance is acceptable.

## Trade overlay and cargo follow-up (V13)

Deferred, not validated by the CPU/canvas-stub suite: with a seeded Milky Way
network, watch distinct route endpoints and moving cargo dots with star time
running under each engine mask. Turn labels off, then toggle Y off/on: no frozen
routes should remain. Open V: trade routes hide and colony yields/population
appear; exit: routes return. In Flight, pause trade independently of star/ship
time, round-trip `trade`/`traderoutes` through a preset, dock at a colony and use
L/Shift+L. Verify resource names, population/export text, partial-unload remainder,
and refusal at a colony-free dock. Check panel overflow at 1280×800 and a generated
galaxy reset's deterministic re-seeding. Record browser/GPU and preset as below.

### Trade panel, rows and overlay (trade-2 series, V13b)

Unseen in a browser: the whole trade-2 panel rework and its two overlay passes.
With a seeded Milky Way network, at 1280×800:

- **Rows.** `#trade-list` is six colony buttons plus the youngest. Click one:
  the camera centres on that colony (observer mode) or it becomes the Flight
  destination (game mode) and the ship does not move. The text must not jitter
  between refreshes; an outpost row must read its readiness word, not a growth
  arrow.
- **Frontier rows.** Each ready pair has its own **Send**; pressing it while
  resting must rush (the row's clock restarts at 900 years) and the message line
  must say what was launched. When expansion is stood down every Send is
  disabled.
- **Events and Forward.** The log shows eight lines and ticks new ones in; the
  calendar's four rows count down and change kind as events fire. Check they do
  not scroll the panel at 1280×800 (the panel has `max-height` and its own
  scroll).
- **Routes.** Commission a pair: a row appears with `next +N y`, a dim teal edge
  appears behind the hull chords, and a hull loading at the origin takes that
  destination when it wants the good. Cancel: the edge goes, the row goes, and a
  hull already at sea keeps flying. Commissioning must not add anything to the
  queue (watch the overlay's `queue N`).
- **Site factors.** Open a colony with V or click it: the readout's `system`
  line must print the same counts the system panel shows (rocky / giants /
  belts / terrans / HZ), and a belt world must read a higher ore bar than a
  rock world of the same star.
- **Outposts and alarms.** Let a colony starve (a fresh network with expansion
  off and a slow clock is the easy path) until it becomes an outpost: a hollow
  grey ring must remain where the live ring was, and a starving live colony must
  wear the dashed amber ring at `r + 4 px`.

### Two-tier system picture (trade-3 T4/T5, V13c)

Unseen in a browser: the world-scale trade picture and its docked founding path.
At 1280×800, with trade running:

- **Worlds and markers.** Open a settled system with V. Every founded planet or
  belt has a population-scaled growth ring; an outpost is hollow grey and a
  starving world adds the dashed amber ring. The `worlds` and `lift` lines name
  the same bodies and stay inside the readout at its 4 Hz refresh.
- **Flows and physics.** At a port with at least two worlds, wait for a settle
  with local surplus/demand. At most three dim cargo-coloured dashes connect
  the drawn body positions. They do not interpolate like hulls and closing V
  removes them without pausing the economy. Pick one listed `intra` row and
  compare its km/s with the same directed pair on the delta-v map (source well
  + LO→LO + destination landing); the couple and Hohmann text must match too.
- **Docked sibling founding.** Dock at a settled star, then press V. The ship
  and camera must not jump, only the schematic (not a delta-v render) opens,
  and its route controls stay disabled. Select an unsettled reachable planet
  or belt and use **Found colony**: the new marker and `worlds` row appear,
  `portCount` does not increase, and subsequent settles can produce local
  flows. Repeat with a locked destination that is not the galaxy primary: the
  card must still describe the docked station. Undocking closes the picture.
- **Limits.** A deep-well or distant candidate reports `too expensive to reach`;
  a sixth sibling beyond the cap reports `worlds full`. No intra hull or new
  galaxy-queue event appears. Check the expanded `#sysread` and System/Flight
  panels for overflow.

## Result template and escalation

Record: task ID; date; browser/version; OS/GPU; file/localhost/preview context;
preset; camera/view; elapsed simulation time and time rate; steps; expected vs
observed; pass/fail/blocked; optional screenshot or short clip location. Keep large
recordings outside Git.

Reprioritize crashes, device errors, unusable controls, preset data loss, or a
repeatable label/render mismatch as correctness bugs. Aesthetic bar imperfections
stay here. Never weaken sampler/field or CPU/WGSL tolerances to approve a visual
change, and never report a deferred row as passed.
