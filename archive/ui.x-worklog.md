# ui.x Worklog

The UI series carries no version number on purpose: interface work can land at any
time, beside or between the model releases, so sequencing it against `0.x` implied
a dependency that does not exist. Entries are `ui.<n>`, in the order they shipped.
The brief that opened the series is `archive/ui-improve.txt`.

## ui.0 — eased fly-to: flight and follow

Fly-to is a 2 s eased flight using f64 position interpolation and shortest-path quaternion
slerp, with the arrival pose re-derived from the live target each frame. Arrival hands off to
a centred orbit; any user input cancels the flight and re-snaps to the exact orbit pose.
`camera.updateTarget` and the main.js landmark feed keep a moving orbited star centred under
the simple engine. Camera tests grew from 108 to 131 checks.

**Feature.** `flyToStar` (key `F`, `V`'s system-view entry, search/radius re-centre) no
longer teleports the camera onto the stand-off orbit. It now flies (plan.md §18,
"Fly-to flight and follow"):

- `FLIGHT_DURATION_S = 2` wall-clock seconds: eased f64 position lerp
  (`smoothstep(s)`, `s = elapsed/duration`) plus shortest-path quaternion slerp from the
  recorded launch pose. Straight line + slerp — predictable, cannot sweep the camera
  through the disc, and dt-free, so 30/60/144 Hz land on the identical pose (tested to
  `< 1e-12 kpc` spread).
- The arrival pose is **re-derived every frame** from the live `objectTarget`:
  `E = T + approach·d` on the launch bearing, arrival orientation looking at `T` with
  galactic-north up. A target that moves mid-flight is therefore met where it arrives.
- Arrival hands over to orbit-object mode at exactly the pose the path reached
  (`orbitDistance = d`, `placeOnOrbit()`) — centred, continuous, zero velocity.
- Any user input (look delta, movement key, wheel notch, C/H/R) cancels the flight the
  same frame into the usual orbit re-snap — which is exact ("turn, not move": the snap
  lands on the sphere of the distance the camera already had). A second `flyToStar`
  mid-flight relaunches from the current pose.
- New `camera.updateTarget(x, y, z)` moves the orbited object in place. main.js feeds it
  the landmark's live position (`OrbitLib.simpleLandmarkPosition`) whenever the camera
  orbits or flies to a landmark under a `simple` engine mask — the same dispatch the
  label layer draws, so the camera follows exactly when the star visibly moves
  (`followLandmark` set by `flyToPrimary`/`openSystemView`/landmark click, cleared by
  `clearSelection`). Field stars keep the snapshot target (the documented CPU honest gap).
- `getState()` exposes `flying`, `flightProgress`, and reports `orbitDistance` as the
  distance being flown to while airborne; the overlay camera line reads
  `camera flying to <name> NN%`.

**Gotcha fixed during the work.** An approach straight along ±Z makes galactic-north up
unusable *and* the default Sun-view up (+Z) parallel to the arrival forward — one
degeneracy check against world Z is not enough. The arrival-up selection is now a
candidate chain (world Z → current up → current right): of two orthonormal vectors at
most one can be near-parallel to a given direction, so the chain always yields a usable
basis (`FLIGHT_UP_POLE_COS = 0.99`).

**Validation.** `camera-test.js` expanded 108 → 131 checks (launch/mid-flight/arrival
pose contracts, stand-off 0 and clamp cases, 30/60/144 Hz arrival identity, follow after
and during flight, cancel continuity via the sphere-radius invariant, pole-approach
orthonormality across all 125 frames, relaunch, action cancellation, allocation-free
flight). Full suite `python3 scripts/run.py all-tests` → 30/30 suites passed.

**Superseded in part by ui.2.** The follow feed described above only ran for *landmarks*
under a *simple* mask, and the flight targeted the star's birth snapshot; ui.2 replaces
both with the shared drawn-position dispatch, so the camera flies to — and stays on — the
star the sky is actually drawing, for every block and every engine mask.

## ui.1 — Search & Selection workflow

Added a third, separate Search & Selection panel. `src/core/selection-store.js` keeps typed
natural-object (`star`, `planet`, `other`) current/previous snapshots and transient group-1a
search results; the asset side keeps independent `ship`, `base`, `colony`, `dock-port`,
`cargo-container` and `other` history plus a fixed two-slot typed pair. The panel exposes
natural history and swap, clickable star results, a typed asset-reference editor, and pair
slot capture/clear controls. Planet and belt picks in the system schematic join the natural
history as planet/other records.

Search remains galaxy- or selection-set-scoped, but its distance predicate now accepts an
explicit centre. The new 10 pc default (the engineering interpretation of “10 pk”) searches
around the selected star, falling back to the camera when no star is available; the search
filter and preset token continue to use light-years. Search snapshots are click-selectable and
promote a result to current while moving the former current to previous. The star-route action
uses previous → current when both are stars, with selected-set routing as fallback and the
existing round-trip control intact.

Validation added `experiments/selection-store-test.js`, a centre-relative brute-force search
case, and static wiring checks for the history, result click, and route endpoint order. The
new store test is part of `python3 scripts/run.py all-tests`.

## ui.2 — the drawn-position contract: fly-to and select-around

**The report.** Two things the user saw: `F` flew the camera to the wrong place, and
Select-around returned stars that were not the neighbourhood on screen ("seems like it
uses initial positions"). Both were the same defect, and "initial" was exactly right.

**Root cause.** A record carries its **birth** position, and the sky draws it somewhere
else: `orbit.engineRecordPosition` / `engineLandmarkPosition` — the engine-mask dispatch
the vertex stage, the labels and the picker share — place it at the running star time.
The selection set stores the birth position on purpose (`stellarInputs` decomposes the
density at it for BLOCK_LOCAL/BLOCK_OBJECT, and a snapshot must survive a residency
rebuild), but three consumers read that snapshot as if it were *where the star is*:
`flyToPrimary`, the select-around centre, and the scan's own distance test, which
compared birth to birth and never dispatched at all. With the shipping defaults
(classic mask, star time 5 Myr/s from boot) the two frames separate within seconds.

**Measured** (120k synthetic field, 100 Myr of star time — 20 s of watching at the
default rate; `experiments/star-select-test.js` now pins the contract):

| | before | after |
|---|---|---|
| fly-to target vs. the star the user clicked | **3.09 kpc (10 094 ly)** off (classic), 2.88 kpc off (apocenter) | 0 — `resolveDrawn` returns the dispatched position |
| 50 ly Select-around, members drawn outside the radius | **2 of 3 kept**, worst **3 172 ly** = 60× the radius | 0 |
| 50 ly Select-around, drawn neighbours missed | the true neighbourhood was a different star | 0 missed |

**The rule now.** One frame of reference per question: identity and stellar derivation
stay in birth space (`starSet.x/y/z`, a pick's `x/y/z`, `around.x/y/z` — unchanged
meaning); everything spatial the user sees is drawn space — the fly-to target, the
camera's orbit target and its follow, the select-around centre and radius test, the
readout's distance, and a route's interstellar separation.

**What landed.**

- `selection.resolveDrawn(ref, out)` — the dispatch for one record. `ref` is pick-shaped
  (`kind`, block-local `index`, `key`, birth `x/y/z`), so a set member, a pick and a
  history snapshot all resolve through it. The slot is validated **by key**, exactly as
  `resolveSet` and the label layer's ring map validate theirs, and an invisible record is
  not drawn at all: both return `DRAWN_STALE` and leave the snapshot in `out`, so a stale
  index can never resolve to the star now sitting in it. `DRAWN_APPROX` carries §2.6's
  honest gap (a `simple` bit's θ lives in the GPU buffer).
- **Follow by identity, not by landmark index.** `followLandmark` (landmarks only,
  `simple` only, `model.milkyWay` only, via `simpleLandmarkPosition`) is gone; `followKey`
  names the set member the camera's orbit target is, resolved by key every frame while the
  camera is in orbit-object mode — flying or arrived — and fed to `camera.updateTarget`.
  One dispatch per frame, every block, every mask. A member that leaves the residency
  stops moving the target instead of snapping it back to a birth record.
- `camera.setOrbitTarget` on a landmark click, `openSystemView`'s re-centre and its
  `far` test, and `restoreStarSnapshot`'s re-target all take the drawn position now, so
  the click, the schematic entry and the history restore aim at the star that is on screen.
- **Select-around is dispatch-exact and chunked.** The scan is dispatch-bound like the
  picker (212 ns/record classic, 946 ns with the apocenter pass at 300k), so it borrows
  the picker's contract rather than inventing one: `beginSelectAround` snapshots
  `dynamicVersion`, `selectAroundStep(maxRecords, maxMs)` walks a slice under the same
  32 768-record / 8 ms budget, `selectAround` stays the one-call form for tests, and a
  rebuild mid-sweep **aborts** (`around.aborted`) instead of mixing two frames — the set is
  left exactly as it was and the readout says "star field changed mid-scan · select around
  again". At 300k: 10 slices, worst slice 5.1 ms, ~0.2 s of frames for a whole scan.
  Per the brief, **nothing runs per frame to keep this fast**: selection is rare and
  user-initiated, and a spatial index kept warm in the frame loop would tax every frame to
  save one click. A click during a scan drops the scan (it describes a neighbourhood the
  user has already left).
- The insertion sort now shifts only the scalars it decides on (`dist2`, `key`, `kind`,
  `index`, `approximated`); `x/y/z`, `packed`, `colorIndex` and `absMag` are re-read from
  the record once, when the sweep lands, for the ≤ 256 kept rows. Eleven parallel arrays
  shifted on every arrival was the same answer reached the slow way.
- The readout's distance is drawn-space (after `F` the camera sits at the stand-off, so it
  reads ~2 ly rather than the kiloparsecs to the birth record) and says which case it is
  in: `position approximate under this engine mask` or `not resident: distance is to its
  birth record`. Route endpoints (`stellarEndpoint`, `historyEndpoint`) carry drawn
  positions, so a cruise leg's separation is the one the user is looking at.

**At the ui.2 stage, the search still used birth-space.** It was a synchronous
one-frame catalogue query, and the §5.3 budget did not yet include a per-record dispatch.
The proposed follow-up was a chunked picker-style scan; ui.3 below supersedes that proposal
with the user's chosen stop-and-inspect operation, retaining a single synchronous search.

**Validation.** `experiments/star-select-test.js` 31 → 45 checks: the radius scan against
an independent *dispatched* brute-force list under masks 1/4/5 at 100 Myr, a non-vacuity
pin that the drawn neighbourhood is not the birth one (the regression the old scan
passed), birth record + drawn distance in one kept row, truncation and its count, chunked
== one-call, the abort, degenerate calls, `resolveDrawn` parity across masks 1/2/4/5 and
all five blocks (worst error 0.000000), its refusal of a slot its key does not name and of
an invisible record, the end-to-end pin that a picked star resolves to where it was
clicked (flight error 0, birth error > 0.5 kpc), and both slice budgets at 300k. `m1-smoke-test.js` 67 → 70 checks pins the
main.js wiring that cannot be run headlessly — the fly-to/orbit-target/follow/readout all
resolve through `resolveDrawn`, the scan is chunked and drawn-centred, and the two shapes
that must not come back (a fly-to aimed at `starSet.x`, the landmarks-only/simple-only
follow) are asserted absent; all three fail on the pre-fix `main.js`, so they have teeth.
Full suite `python3 scripts/run.py all-tests` → 30/30 suites passed, no test deleted, no
tolerance widened.

**Next step suggestion at ui.2 (superseded by ui.3).** Give the §5 search a chunked,
dispatch-exact distance predicate and restate §5.3 as slice budgets. The user's later
stop-and-inspect decision instead keeps `search.run` synchronous and pauses star time.

## ui.3 — Frozen drawn-space search, result selection and flight

**Decision and review.** Revisited the previous search/select/fly workflow instead of
implementing ui.2's suggested multi-frame scan. The user's correction is decisive:
search is a stop-and-inspect action, usually used at zero or low star time, and the
clock must remain stopped while the user reviews results. Search remains one synchronous
operation; the code does not auto-resume when it finishes. The existing `T` toggle
restores the last signed non-zero rate.

**Implementation.** `runSearch()` pauses star time before parsing and scanning, passes
its fixed `starTimeMyr` to `Search.run`, and updates the slider/readout immediately. The
selected-star centre resolves through `selection.resolveDrawn`; the camera remains the
fallback. `core/search.js` applies the active `OrbitLib` record/landmark dispatch to
both galaxy and selection-scope distance tests and nearest-first ordering. It retains
birth coordinates for stellar derivation and result snapshots. The result buffers carry
an approximation flag and the time used. The UI reports the snapshot epoch, marks
approximate distances with `~`, identifies approximate/stale selected centres, and keeps
per-row approximation metadata when a result is selected or added to the set. If the
clock is resumed later, the displayed distances are still explicitly historical; a
result's identity remains selectable, and **Fly to primary** (`F` or the new button)
resolves the star's current drawn position for flight. `F/N/X` work from focused panel
buttons, and `T` also works from panel text; editable fields still own their keys.

This preserves the synchronous user experience while keeping the spatial answer
consistent with the active movement engine. A measured 300k-star classic-engine query
at 100 Myr took about 98 ms in the local test run; the test allows up to 1.5 s for that
moving-time scan and retains the original §5.3 budgets at time zero.

**Validation.** `experiments/search-test.js` 36 → 37 checks: exact frozen-time distances
for galaxy and selection scopes, birth-coordinate preservation, explicit simple-engine
approximation, plus the 300k moving-time performance pin. It passes 37/37. The focused
`input-test.js` passes 18/18, `preset-test.js` 30/30, and `m1-smoke-test.js` 71/71,
including the new fly-to control, single-operation pause wiring and keyboard scope.
The full suite passed all 31 groups with
`NODE_OPTIONS=--max-old-space-size=256 python3 scripts/run.py all-tests`. Two default-heap
runs hit the existing `planet-gen-test.js` coarse heap-delta ceiling (about 3.3–3.6 MB transient
measurements against a 2 MB limit); that suite passes standalone, and the constrained-heap
suite passes without changing the test or its threshold. Generated experiment logs were
restored so only source, test, plan and worklog changes remain.

**Follow-up.** Browser interaction smoke when practical: run a search, confirm the rate
slider stays at zero, click a result, press `F`, inspect the flight, then press `T` from
the results area and confirm the star-time clock resumes. The synchronous design is
intentional; do not chunk search unless the user revises that interaction decision.

## ui.4 — explicit camera modes (c/C/f/F), G retired to the panel, g reserved for game mode

**Decision and review.** The `C` cycle (fly → orbit centre → orbit object) was
stateless: the same key made one of three moves depending on the mode the user
had forgotten. It is replaced by explicit, case-paired keys — lowercase near,
uppercase far: `c` orbits the last selected star on the spot, centred and
followed (no flight); `Shift+C` orbits the galactic centre, centred; `f` takes
the free fly camera and stops the orbit and the follow; `Shift+F` keeps the
2 s fly-to, ending orbiting and following the object. The price is deliberate:
the fly-to leaves plain `F` (the "fly" letter now grabs the fly camera) and a
user holding Shift for boost who taps `f` gets the flight instead — the mapping
is the brief's, so that edge stands. `G` no longer cycles galaxy type (the panel
select already iterates the full table, and a 300k-star rebuild is a menu-size
action, not a hotkey one); the key is reserved for game mode — for now a toggle
with an honest placeholder line, the real design in `game-mode-plan.md`.

**Implementation.** `input.js` drops `cameraMode`/`galaxyCycle`, adds
`orbitCentre`/`orbitObject`/`flyMode`/`gameMode`, and maps `KeyC`/`KeyF`
through a shift-cased pair (`casedPressMap`); one-shots still ignore
`e.repeat`. The orbit/fly actions are consumed by main.js, not inside
`camera.step`: entering object orbit needs the selection store's drawn
position, and the camera only learns the target through `setOrbitTarget`
afterwards — `toggleMode` and the mode consumption in `camera.js` are gone
(setMode stays the single entry). `f` clears `followKey` explicitly even though
the follow is inert outside object orbit, so "disable orbit and follow" is
true state, not an accident of gating. `orbitPrimary()` beside `flyToPrimary()`
is the drawn-space, follow-keyed switch `c` fires; `g` flips one boolean and the
overlay gains a `mode game` line naming the plan file. Panel hints, the help
overlay, README's table and the "G key" label on the type select follow.

**Validation.** `input-test.js` 18 → 19 checks: the c/C/f/F/g mapping with
shift, repeat suppression, the panel-button `F/N/X` path under the new letter,
and menu field isolation re-pinned on the new action names. `camera-test.js`
re-bases the mode section on `setMode` (consumption pinned on `home` instead of
the retired `cameraMode`) and keeps the 600-frame no-reallocation contract with
direct mode switches. New `m1-smoke-test.js` pins: the cased map and `KeyG` in
`input.js`, the four loop consumers and `orbitPrimary`'s drawn+follow shape in
`main.js`, and the absent shapes (`toggleMode`, `galaxyCycle`, the old
`Fly to primary (F)` button label). `camera-test.js`, `input-test.js`,
`m1-smoke-test.js` all pass; full suite pending at commit time below.

**Next step suggestion.** G1 of `game-mode-plan.md` — `src/core/ship.js` holding
velocity/tank/class with the accel cap and the burn integral, the three-line HUD
(speed, fuel, distance + closing + ETA to the primary), and `ship-test.js`
burn/ETA/no-alloc pins. The input routing (g gating c/C/F/Shift+F, Space
all-stop) is a main.js change on top of the ui.4 action plumbing, which this
entry kept deliberately thin for exactly that handoff.

## ui.5 — fly-to lands on the star (frame order + target-frame flight), selection notice, tiered tests

**Bug.** Shift+F ended with the camera off the star ("final position and camera target
is not the object, or overshot"). Two causes, both present at the default star-time
rate of 5 Myr/s, where a disc star drawn at ~20 km/s moves ~100 pc/s (~1.7 pc a frame,
against a 0.6 pc stand-off):

1. **Frame order.** `camera.step()` ran first and `followTarget()` (which feeds the
   star's drawn position to `camera.updateTarget`) ran after the star-time advance, so
   the camera was always placed around *last* frame's target while the renderer drew
   *this* frame's stars — a permanent one-frame lag, including on the arrival frame.
   The loop is now: advance star time → set orbit state → `followTarget()` → mode
   actions consumed → `camera.step()` → render. The input pointer-lock policy is read
   after the step.
2. **Absolute path.** `stepFlight` lerped from the launch position to the live
   arrival point, so a runaway target made the camera trail it and the lerp end at the
   star's final place after a 2 s chase (a 200 pc detour at the default rate). The
   flight is now flown in the target's frame: `position = target_live + startOffset·(1−e)
   + approach·standOff·e`. A static target gives the identical path as before; a moving
   one is closed on monotonically and the handover (`placeOnOrbit`) is exact.

**Review of ui.4 (c/C/f/F/g).** The mapping and the g retirement match the brief. Found
and changed: `c` and `Shift+F` with nothing selected were silent no-ops, so the overlay
now says `no star selected · click a star first` for ~3 s; the game plan got the
target-frame/ordering rule for the autopilot and a broken `**` fixed. Left as decided:
holding Shift (boost) and tapping `f` flies to the star — the brief's mapping.

**Tests.** `camera-test.js` 131 → 133: a 80 pc/s mover (updated before each step)
is closed on monotonically and the flight ends at the stand-off, centred, with the
camera's `orbitTarget` equal to the star (fails on the old path: it overshoots).
`m1-smoke-test.js` pins the loop order (`followTarget` → `camera.step`, a single
`camera.step` call) and the notice.

**Test tiers.** The full suite measured 223 s serial, 117 s of it `movement-density`;
ten tests are over 5 s, the other 21 total 11 s. `scripts/run.py` gains `quick` (the
21), `changed` (a dependency graph built from string-literal file names in the tests
and the sources they load — no hand-kept map — selecting the tests that can observe
a changed file, plus the two wiring tests) and several-names-as-one-suite; `quick` and
`changed` print only failing checks and run with `experiments/no-log-writes.js`
preloaded so `experiments/logs/` is not dirtied by every run (`--logs` and `all-tests`
still write). `all-tests` stays for model changes and merges; AGENTS.md carries the
policy. A parallel run (`-j`) was measured to fail the timing budgets of `star-select`,
`search` and `galaxy-evolution` on the 2-core box, so serial stays the default.

**Next step suggestion.** Browser pass of Shift+F at star-time rates 0, 5 and the
camera-coupled −1 (the star should sit dead-centre on arrival at all three); then G1
of `game-mode-plan.md`.
