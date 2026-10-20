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

## ui.6 — chase follow (j) and the clickable Controls panel

**Chase follow.** `j` turns the object orbit inside out: the camera rides
*behind* the centred object with its forward eased onto the object's drawn
movement vector, so the view is always where the object is heading and the
object stays dead-centre — position = target − distance·forward is the orbit
placement law with only the direction's owner changed, from the user to the
motion. `camera.js` carries it as a sub-mode of `MODE_ORBIT_OBJECT`:
`setChase` gates on the mode (a stray enable is a no-op), `setMode`/`reset`
clear it on the way out, and the movement feed is the same consecutive drawn
positions `followTarget` already refreshes — `updateTarget` before `step`, so
one step measures one frame of real motion. A target assignment, a flight
handover and a re-snap *rebase* the baseline to the target as it stands
instead of clearing it: a cleared baseline skips the first frame's ease, which
made the swing one frame shorter at 144 Hz than at 30 Hz — the frame-rate
test caught exactly that. The alignment ease is a slerp of the remaining angle
by 1−e^(−dt/τ), τ = CHASE_DIR_TAU 0.5 s: slerp reduces the angle to (1−k) of
it, so the composition over equal elapsed time is exact and the swing lands
identically at 30/60/144 Hz; chaseDir is renormalized once per frame so the
distance contract holds to the last bit despite the quaternion round trip.
Frozen star time draws bit-identical positions (the dispatch is
deterministic), so the movement test needs no noise margin (1e-12 kpc) and the
chase degenerates to a free orbit of the looked direction. Look and A/D/E/Q
rotate the chase direction itself — a glance is temporary by construction, the
ease pulls it back — W/S and the wheel dolly, and the toggle in either
direction is pose-continuous. `getState` gains `chase` and
`chaseSpeedLyPerSec`; the overlay's camera line reads `camera chase <name>
distance … motion <speed>`.

**Controls panel.** The read-only `<pre id="help">` is now a `#help` panel of
buttons and checkboxes, one per shortcut. Every control carries `data-action`
and fires the same one-shot action flag its key sets — the loop consumes it
next frame — so a click and a key press run one code path and no handler
logic is duplicated in the panel. Checkboxes toggle natively (optimistic) and
`syncHelpControls` repaints them from the live state at the overlay's 4 Hz, so
a toggle the app refused (j with nothing selected) visibly snaps back;
selection-dependent buttons disable with the set. prev-star is the one direct
call (the loop's N reads the held boost key, which a click cannot set). Tab
and the ▾ collapse treat it like the other panels; tooltips carry the detail
the old table had, the rest lives in the hint block.

**Game-plan review.** `game-mode-plan.md` updated for what ui.6 proves:
entering game mode from the chase seeds the ship's velocity with the followed
object's (the feed already holds it — handover continuous in velocity, not
just pose); `j` in game mode becomes the autopilot's follow command (null the
relative velocity and trail at the stand-off, the same eased-alignment law on
the ship's velocity instead of the camera's pose); and the hangar refill and
SIM/ARCADE presets ride the Controls panel's data-action pattern. README's
table and selection list follow.

**Validation.** `camera-test.js` 133 → 148: engage/leave pose continuity, the
no-op enable outside the object orbit, convergence behind + aligned + centred
+ the reported motion speed, the glance (centred through it, alignment
returns), the frozen target, f/C clearing the sub-mode, the dolly, 30/60/144 Hz
identity, and a curving target (distance held, lag bounded by 2ωτ); the
600-frame no-reallocation loop now weaves `setChase` and `updateTarget`
through the mode cycle. `input-test.js` 19 → 20: KeyJ one-shot with repeat
suppression. `m1-smoke-test.js` 72 → 73: the KeyJ map, the loop consumer, the
data-action delegation, the state repaint, Tab treating #help as a panel, and
the retired `<pre>`; `star-select-test.js`'s help-text pin re-based on the
panel's buttons (45/45 unchanged). `camera input m1-smoke star-select` and
`changed` (11 tests) pass.

**Next step suggestion.** G1 of `game-mode-plan.md` — `src/core/ship.js` with
the burn integral and the accel/cruise caps, the three-line HUD, and the
velocity-continuous entry from the chase follow that §1 now promises; the
chase movement feed is the vector to seed it with.

## ui.7 — game mode G1: the ship as the fly rig, one shared clock, the HUD

**The plan, reviewed and improved.** `game-mode-plan.md` was reviewed against
the code before a line landed, and §4–§8 were revised in place (clean artifact,
no chat residue). The important correction is the ship clock: the draft coupled
ship time to the star-time axis at its Myr/s scale — 0.5 Myr/s is 1.6e14 ship-s
per wall-s, which vaporizes a stardrive's whole Δv tank in ~1e-7 wall-seconds
and expires 200-y life support in ~10 ms. The *coupling itself* is right and
stays: one shared clock is what makes a selected star reachable (ship cruise
outruns stellar drift by ~100× at any rung; under two clocks the sky tears
past at ~100 pc/s and nothing catches it — the observer fly-to's overshoot
lesson). What §4 now specifies is the system view's own convention
(`SYSTIME_LADDER`): a geometric y/s ladder — 1-2-5 rungs 1e-5 … 1e6 y/s with
`frozen` and a `follow` rung (`R = 20·v/c`, time slows into a docking
approach on its own) — that *takes over* the star-time axis while flying
(slider stops = rung indices, wheel steps it, T freezes ship and sky), with
the observer's Myr/s rate parked and restored at the toggle. The default is
the class's home rung: the stop where a full-thrust frame-tap (60 fps) spends
~1% of the tank (chemical lands at 1e-4 y/s — docking resolution; stardrive at
0.5 y/s), so every class flies at a resolution its throttle can speak in. The
review also fixed the handover's units (the follow feed is time-lapse motion —
it must be divided by the frame's physical seconds to seed *physical*
velocity), generalized the handover to every live follow (`c`, `j` and the
Shift+F arrival all ride `followTarget`'s feed), filled the input-gating table
(`H`/`V` teleport or re-pose — a ship does neither; `Space` all-stop; the wheel
is the clock while flying), and pinned §5's profile to `route.interstellarLeg`
literally (`v_peak = min(√(a·d), v_c)`, `Δv = 2·v_peak`, `t = d/v_c + v_c/a`)
plus the hot-approach refusal.

**ship.js (G1).** `src/core/ship.js` — one record per session: class (the
`deltav.js` row, with `accel`/`vCruise` at the top level so
`route.interstellarLeg` reads the ship record directly), f64 position (kpc)
and velocity (kpc per ship-second — physical seconds, since ship-seconds and
star-seconds are one time), the Δv tank with the burn invariant
`dvSpent == ∫|a|dt` exactly (the tank bounds each frame's burn), life support
on ship time, the Space stop command (which ends exactly at rest — the first
version flipped the velocity through zero each frame and burned the whole tank
before noticing; the test caught it), the hangar (`setClass` re-arms the tank,
clamps velocity to the new cap, re-snaps the home rung), the §4 ladder and
its rung helpers, and the §6 formatters (km/s under 0.01c then c; Δv in m/s
then km/s). The thrust blend is per-axis on the camera's live basis with the
magnitude cap on the blend: full forward + full strafe commands √2 of the
class accel and the clip brings it back to 1× — the HUD bar reads the applied
magnitude over the ceiling, so the cap is what the bar displays. Shift ×4 /
Ctrl ×¼ scale the ceiling and the drain together.

**The rig (main.js).** The frame order is: follow feed → wheel/home gating →
`camera.step` (look and the gated actions) → `gameTargetFeed` →
`gameShipStep` (thrust blend, integrate, write-through) → render. The
write-through is `camera.getState(rigState)` → mutate position/velocity →
`camera.setState(rigState)` on one scratch — `camera.js` is untouched, and the
observer's fly integration with the same keys is discarded before the frame
draws. Entering game mode closes the system view (its enter path re-poses the
camera), forces the fly rig (pose-continuous from any mode), and seeds the
velocity: a live follow hands over its measured physical velocity
(`Δdrawn / framePhysSeconds` — the ui.6 chase feed the plan promised), a
first entry starts at rest, and a re-entry resumes the stored state. The
observer's mode keys (`c C f Shift+F j H V B`) answer with the notice-line
pattern and their Controls-panel controls disable (`data-observer`, repainted
at the overlay's 4 Hz); `R` resets the ship too; selection, search, N/X and
the menu are untouched — the HUD's target *is* the primary selection, resolved
drawn-space every frame so the closing rate is frame-rate honest.

**The HUD (§6).** Four overlay lines at the 4 Hz cadence: mode + clock rung,
class + throttle bar + burn reserve, speed (+applied m/s²) + fuel + life, and
the target line — name, drawn distance, closing (or an explicit `receding`),
coast ETA in ship *and* wall time, and the §5 autopilot ETA from the closed
form (the number that sells the restriction before G2 flies it). Empty tank
and dry-stop residual get their own lines. The star-time slider's readout
dresses as `ship +0.5 y/s` while flying.

**Validation.** `experiments/ship-test.js` (new, 25 checks): the burn/tank
invariant (constant thrust and mixed factors), the tank bounding a frame's
burn, the accel cap at blend angles (√2 clip, the analog blend bar, Shift/Ctrl
ceilings), the cruise cap for both domains, the Space stop (exact
velocity-killed accounting, the dry-tank residual, thrust override, the
stopped no-op), the §5 profile against `route.interstellarLeg` (unclamped
`2√(d/a)`, clamped `d/v_c + v_c/a`, in-system `∞`), the ladder (home rungs
hit the 1%-tap law for chemical/stardrive/generation, follow/frozen/timed
rates), the write-through's bit-exact pose and written velocity, the handover
bridge and the hangar's clamp/re-arm, reset/refuel semantics and a 600-frame
no-reallocation loop. `input-test.js` 20 → 21 (Space one-shot with repeat
suppression); `m1-smoke-test.js` 73 → 76 (the gated key consumers, the
handover feed, the HUD markers + ladder dress, the hangar/refill/data-observer
patterns, `Ship` in the namespace lists) with the ui.4/ui.5 pins re-based on
the gated shapes. `ship input m1-smoke camera export-parity` and `changed`
(7 tests) pass.

**Next step suggestion.** G2 — the §6 canvas chrome on the label layer
(crosshair, velocity ladder, target frame, throttle strip in the class color)
and the §5 burn/flip autopilot on `route.interstellarLeg`'s law: the fuel
checkout, the phase display, the rest-frame commit (and the hot-approach
refusal), and the `j` follow command that trails at the stand-off on the
chase-follow alignment law.

## ui.8 — game mode G2: the autopilot, the follow command and the ship chrome

The §5 autopilot and the §6 chrome that G1 left as design. `ship.js` already carried
the approach and follow laws (`apCommitApproach`, `apCommitFollow`, `apStep`, `apAbort`,
the checkout through `route.interstellarLeg`); this entry wires them and fixes what the
flown tests found.

**Commands.** `Shift+F` (approach), `j` (follow, pressed again to abort) and `f` (abort,
a notice when none runs) are requests: the key sets `gameCommand`, and the game block
consumes it after the target feed, so a command reads this frame's drawn position and
motion. Refusals and ends write one message line for a few ticks, never a silent
no-op: `insufficient Δv: need X, have Y`, `hot approach · closing U · null it first
(Space)`, `ship is in-system only`, `already at the stand-off`, `arrived`, `autopilot off
· velocity kept`, `target lost · autopilot off` (the target left the residency). A thrust
key ends a flight at the current velocity; the all-stop, a class swap, `R` and the `g`
toggle already did.

**Nose.** The autopilot's aim feeds the camera's own look accumulator (`lookDx/lookDy`),
eased at `AP_AIM_TAU` on the wall clock, so the ease is the camera's one look law and a
glance wins frame by frame. `camera.js` is untouched.

**Chrome.** `label-layer.js` gains one pass (`drawShipChrome`) on a preallocated state
record (`createShipChromeState`, `setShipChrome`): crosshair, burn marker (pinned to the
edge on the side to turn toward, upward dead astern), velocity tape with its over-cap stub
and the closure tick, target frame and tag (flipped to the left on the right half), and
the throttle/fuel strip. It draws with the observer labels off. Live geometry is per frame;
the strings are main.js's 4 Hz formatting. The Controls panel's `fly` button reads
`abort autopilot` and is live exactly while one runs; `fly to star` and `follow motion`
are no longer observer-gated.

**Fixes the flown tests found.** Three corrections to the §5 law, each now in the plan:
- *The dead band.* A 1 % band of the frame's impulse chattered at the stand-off on the
  coarse rungs (the tank ran dry with the target moving straight). It is now 10⁻⁶,
  deadbeat for small errors.
- *The desired velocity holds the cruise cap.* A command into the cap was charged then
  clamped away; the desired velocity is clipped before the command is formed.
- *The flip is any entry into brake,* from a burn or a coast: a coast keeps the nose on the
  target, so the reversal is a flip either way.

**Validation.** `experiments/ship-test.js` 68/68 (G1's 25 unchanged, G2's 43 new): the
checkout equal to the leg profile's Δv and ETA; four refusals (fuel, hot, in-system,
inside the shell), each leaving the tank, velocity and mode untouched; the flown approach
arrives on the shell inside the checkout and walks burn → coast → flip with the nose
retrograde while braking; a drifting target is met; abort keeps the velocity; the all-stop
and a class swap end the flight; the follow nulls the relative velocity and trails at the
stand-off at the clock rungs 3·10⁴, 3·10⁵ and 10⁶ s, spends nothing on its straight run
and only the correction when the target curves; the no-reallocation loop over approach,
follow and abort; and the chrome on a recording context, the target frame checked against
`coords.projectToScreen` itself. `m1-smoke` 83/83 (the G2 wiring is one block of five pins by
shape: the command path, the nose ease and feed, the HUD auto line, the chrome pass, and
the Controls wiring). `input`,
`camera`, `route`, and the `changed` tier (9/9) pass; `eslint --rule no-undef` is clean on
`main.js`, `label-layer.js` and `ship.js`.

Two results I did not expect and want on record. The follow's stand-off is held to one
frame of the target's motion, not to a percentage: at 10⁶ s a frame is 2·10¹¹ m of drift
against a 10¹³ m stand-off. And `planet-gen`'s coarse heap check (`architecture allocates
nothing per call`) is flaky on this machine (passes two runs in three); it does not load
any file this entry touched.

**Not verified in a browser.** The page needs WebGPU, and this sandbox has none. The
wiring is pinned by shape and the numbers by `ship-test.js`; the chrome's look, the
Shift+F feel and the `f`/`j` controls still need the browser pass that
`deferred-browser-visual-plan.md` already carries.

**Known limitation, left for a decision.** Holding a thrust key at the cruise cap charges
Δv the clamp discards (the same ledger as the autopilot's old bug, on the manual law).
The G1 invariant is written for unclamped thrust, so the fix needs a choice of what a
clamped burn costs; see the 2026-10-16 entry in `findings-pitfalls-skills.md`.

**Next step suggestion.** G3 — docking, refuel and life support (dock-port and base assets
from the ui.1 asset history as refuel stations, life-support timers that bite). Before it,
the browser pass for G2 (`deferred-browser-visual-plan.md`), and a decision on the
clamped-burn ledger, since a docking approach holds the cap-adjacent speeds G3 will rely on.

## ui.9 — Flight workspace, configured journeys and accepted-impulse fuel

**Decision.** The ordinary pilot workflow was split across a game HUD, keyboard-only
thrust, the System panel's hangar and the map route controls. ui.9 makes the lower-left
panel a single **Flight** workspace: configure manual power, pick and lock a destination,
compare a legal journey and engage it; the System map / transport route remains immediately
below in the same panel. The fuel decision is equally explicit: bill only velocity change
that survives the cruise cap. A held forward command at cap is not propulsion and therefore
is not fuel use; steering and braking continue to pay their actual vector changes.

**Flight workspace.** The former System heading is Flight. Its ordered Pilot section owns
the one ship selector/refuel action, a persistent 0–100% forward-thrust lever, desired
speed and an opt-in cut-thrust governor. It deliberately does not secretly brake at the
set speed. W/S temporarily replace the lever's forward axis; A/D/E/Q retain direct steering.
The destination section snapshots **Use selected** by identity, birth fallback, luminosity
stand-off and display name. Selection can then change without retargeting the flight. A
key-resolve entry is carried through `resolveSet`, including when the locked star is no
longer in the mutable selection set; a lost resident record is displayed as unavailable and
aborts an active burn rather than using stale coordinates.

**Profiles.** `Ship.createFlightPlan` / `planJourney` expose four rest-to-rest profiles:
fastest, thrust-limited, speed-limited and time-limited. The time plan rejects deadlines
shorter than hardware fastest, otherwise selects the lowest-Δv triangular or cap-speed
trapezoid. The compact forecast names the locked star, drawn distance, profile plus
relative-velocity match cost, tank margin, ship ETA and current-clock wall ETA. **Engage
flight** copies its scalar limits into the existing approach record, so later slider edits
cannot change an armed burn. Shift+F remains the legacy fastest shortcut, and local-only
classes continue to refuse destination-star planning. The Flight Abort button dispatches
the same autopilot abort command as `f`.

**Fuel law.** `advance()` now projects a requested candidate velocity onto the speed ball
*before* billing `|v_after - v_before|`. A 48-iteration scalar bisection finds the
fuel-limited fraction under that nonlinear projection; a limited frame ends exactly at the
tank bound. Manual and autopilot HUD/chrome acceleration and throttle derive from the
accepted impulse, including zero for a frozen clock or cap-discarded forward command.

**Validation.** `experiments/ship-test.js` is 80/80: all four planner modes, impossible
deadline and local-class refusal, copied configured limits, governor target acceptance,
forward-at-cap free fuel, accepted turn/brake accounting and affordable projected turning
with a nearly empty tank.
`m1-smoke-test.js` is 86/86: Flight DOM/wiring, key-resolved destination re-resolution,
configured engage, governor/manual override shape and accepted-thrust presentation. The
changed suite passes after the documentation, logs and test sources are updated. Browser
WebGPU visual interaction remains the existing deferred pass; this sandbox has no WebGPU.

**Next step suggestion.** Run the deferred browser/WebGPU visual pass with a real selected
star: verify the compact panel's scroll/collapse behaviour, governor hand-off at the desired
speed, all four forecast/readout modes, a stale-residency refusal and route access below
Flight. G4 can then add dock-port refuelling and life-support consequences without moving
the Flight workflow.

## ui.10 — Fleet, view-axis speeds and target-stop autopilot

**Decision.** Replace the single active hull assumption with a session fleet while keeping
one active ship record in the frame loop. The Flight panel now lists ships, spawns a
stationary hull at the camera position, and switches to a clicked hull (entering game mode
when needed). Each hull keeps its own position, velocity, class, tank, clock and autopilot;
parked hulls do not move or spend fuel, and switching away aborts an active command.

**Flight behavior.** Thrust is composed on the camera's live forward/right/up basis, so
forward input moves into the view. The Flight panel and game HUD show signed forward,
sideways and vertical velocity components in the camera basis, target-relative when the
target's drawn physical velocity is available and absolute otherwise. A four-second minimum
wall-time cap bounds the shared ship/sky rate for destination approach and target-stop
autopilots; slider changes recompute it from the remaining ETA, and freeze remains an
explicit override. Completion, abort, manual thrust-key input, target loss, reset and hull
changes clear the cap.

**Target stop.** The **Autopilot to target** checkbox locks the current destination (or
snapshots the primary selection), closes on the live drawn position, then matches its
physical velocity. The terminal settlement bills the velocity match and ends at exactly
zero target-relative velocity. The legacy stand-off approach and configured Engage path
remain available.

**Validation.** `experiments/ship-test.js` is 84/84, including moving-target arrival,
immediate settlement within tolerance, zero relative velocity, view-axis projection and
the four-second rate formula. `m1-smoke-test.js` is 87/87 and pins fleet wiring, camera-axis
thrust/readouts, pre-clock command processing, cap refresh/freeze behavior and target-stop
wiring. `python3 scripts/run.py changed` passes 6/6 mapped suites; syntax checks pass.
The browser/WebGPU visual pass remains unverified in this sandbox.

## ui.11 — Pilot control semantics, speed reference and heading memory

**Decision.** The game mode's forward axis now answers "how fast" two mutually
exclusive ways. The Pilot panel's Thrust lever and Desired-speed slider are the
two controls: touching either switches to it and disables the other (a thrust
change disables the speed limit, a speed change disables the thrust lever; the
checkbox flips the same switch). The disabled control's row is muted and its
value line states which control owns the axis; nothing is hard-disabled, so the
pair can never deadlock. Thrust control is the persistent lever; speed control is
cap-only — forward thrust cuts at the desired speed and a direct W/S input still
temporarily takes the axis over either way.

**Heading.** The camera's live orientation is a ship state like position and
velocity: `createShip` stores a heading quaternion, game mode writes it back each
step, and entering the mode, spawning a hull at the camera, switching hulls and
the R reset all adopt it exactly. A hull spawned at the camera flies the way the
view was aimed, and a changed heading re-projects the velocity onto the new
forward/sideways/vertical axes on the next frame.

**Speed reference (§7.4).** The axis velocities, the HUD target line and the
autopilot answer against one reference, selected three ways: the Target/Centre/Home
buttons in the Controls panel (one-shot), or keys — Shift+C (galactic centre),
H (home: the Sun in the Milky Way, a generated galaxy's centre otherwise). Shift+C
and H select the reference in both rigs; outside game mode they also orbit
(centre) and travel (home) as before, while in game mode they only change the
reference (a ship never re-poses). The galactic centre and home are frame-fixed
points: always resident, at rest (zero relative velocity), never stale, so the
speeds read absolute in that frame and the autopilot can fly to the centre
itself. The default reference stays the locked Flight destination, else the
primary selection.

**Validation.** `experiments/ship-test.js` is 89/89, including the heading
round-trip through the camera state pair (spawn adoption, observer excursion and
re-pose, per-frame write-back, R reset) and the heading-following burn.
`m1-smoke-test.js` is 92/92 with ui.11 pins for the heading wiring, fixed-point
resolution and naming, reference key handling, the three buttons, and the Pilot
control exclusivity. `python3 scripts/run.py changed` passes 7/7 mapped suites.
The browser/WebGPU visual pass remains unverified in this sandbox.


## ui.12 — nearest view-field default and bounded auto-range follow

The view-field panel now defaults to **nearest** anchors (256 stars), not the
Milky Way constellation set. The render mode itself remains off at boot; the
constellation source stays available as an explicit choice. Layer defaults,
HTML radio state, and preset fallback share the same value.

Replaced the post-pan auto-range stability gate with a three-read rolling
median, a 0.10 dex cap per 4 Hz target update, and a 1.25 s display ease. One
bad read leaves the current range alone; repeated measurements begin moving the
range without waiting for several seconds of perfectly agreeing samples, and no
single trusted read can rewrite the scale. The manual freeze continues to park
the current range and reset its history.

**Validation.** `view-modes-field-test.js` 77/77, `view-modes-layer-test.js`
36/36, `view-modes-page-check.js` 58/58, `preset-test.js` 30/30, and
`python3 scripts/run.py changed` 8/8. The field
checks include an isolated outlier, alternating offers, bounded adoption, and
monotonic convergence. Next: browser-check the view-field panel during a fast
pan on a live WebGPU session.

## ui.13 — docking, the station refill and life support (game-mode G4)

**Decision.** The last leg of the game loop (game-mode-plan §10, designed
and landed whole): any natural-object flight target is a station. `O`
docks when the ship is settled (≤ 1 m/s relative) inside the target's
stand-off shell plus one arrival shell; the commit re-arms the tank
(the *station* refill, beside the hangar's), restores life support,
records the star as the hull's **port of registry** and lands a
`dock-port` asset in the selection store's typed asset history (ui.1's
asset group, birth space like every record). Docked, the ship rides the
station — the feed resolves the station by key (destination snapshot or
star-set member) whatever the speed reference says, `dockStep` copies
its drawn position plus ride offset and its physical velocity, and life
support pauses at the port. Thrust keys, Space, `O`, the class swap, `R`
and a hull switch all undock first; a station that leaves the residency
breaks the dock with a notice. Undock leaves the ship at rest relative
to the port. Flight commands refuse while docked (`undock first`), and
the Flight panel's autopilot checkboxes disable.

**Life support gets its teeth** (§2's promise, deferred from G3): the
countdown reads exact years, warns inside the class's critical band
(10 % of `lifeYears`, floored at 0.1 y — a 2-y chemical hull warns at
0.2 y), and expires at zero. Critical turns the HUD life figure amber
(`· critical`) and fires one notice on the crossing; expired prints a
persistent `life support expired · return to <port>` line and draws the
**hard return-home marker** — an amber chrome frame and tag at the port
of registry, dismissed by nothing but the next dock. The port of
registry is the last docked station, else the frame-fixed galaxy home
(ui.11's `H` point — the Milky Way's Sun, a generated galaxy's centre),
resolved by key each frame with the follow feed's rebase rule so a port
change never reads as motion. The autopilot is *not* locked out — the
pilot may limp on; the marker is the insistence, exactly the plan's
"warning and hard return-home marker".

**The cargo hook** (prices/economy omitted, matching 0.5): `ship.cargo`
in tons against the class's capacity, `L` loads to full and `Shift+L`
empties at the dock only (refused with `cargo moves only at a dock`),
free. The HUD carries the hold on a `cargo` line while docked or
nonzero; the Flight panel's new **Port** rows hold the dock toggle,
load/unload and the port state line.

**Validation.** `experiments/ship-test.js` is 107/107 — the dockable
matrix (frame-fixed refusal, shell band inclusive at the boundary,
settle threshold), the commit's service effects, the ride (offset
carried as the station drifts, station velocity copied, life frozen),
the undock's rest-relative exit, the cargo law, the reset and
class-swap clears with the registry home persisting, the life ladder
(warn band inclusive, expiry, the generation ship that never expires)
and the hangar refill's honesty (tank only). `m1-smoke-test.js` is
104/104 with ui.13 pins for the O/L action table, the dock commit and
asset write, the docked ride and its residency break, the home feed's
key rebase, the dock refusals, the HUD/chrome lines, the Port rows and
the game-mode gating. `python3 scripts/run.py changed` passes 12/12.
The browser/WebGPU visual pass remains unverified in this sandbox.

## ui.14 — the SIM and ARCADE clock presets (game-mode-plan G5)

**Decision.** The last game-mode milestone lands as two Controls-panel
buttons on the §4 ship-time ladder, both live only in game mode
(`data-game`, the reverse of ui.7's `data-observer` gate) and lit from the
live clock (`is-active`). No renderer, WGSL, catalog or preset-language
change.

**SIM** selects the ladder's new real-time stop,
`SHIP_TIME_REAL = 1/SECONDS_PER_YEAR` (3.17e-8 y/s), inserted between the
frozen sentinel and the 1e-5 manual band so `SHIP_TIME_LADDER` stays
monotone in y/s and the slider's index mapping needs no special case. The
rung readout and the HUD print `real ×1`. The home-rung search starts at
`SHIP_TIME_FIRST_TIMED_INDEX`, and the follow rung's zero-speed fallback
(the old literal index 2) follows it, so neither can land on real time by
accident. SIM clears the arcade flag and unfreezes the clock.

**ARCADE** snaps to the class's home rung (`homeTimeIndex`) and arms
`ship.arcade`, the coast warp: while an AP_APPROACH / AP_TARGET autopilot
is in its coast phase, `arcadeWarpYPerS` returns
`timeRateCapYPerS(ap.etaS, AUTOPILOT_MIN_WALL_SECONDS)` — the autopilot's
own four-wall-second floor, the same number the existing cap applies as an
upper bound. `gameTimeRateY` takes it as a lower bound (`max(base, warp)`
before `min(rate, cap)`), so the years-long unpowered leg of a stardrive
flight plays out in seconds, the rate follows the decaying remaining ETA,
and the approach eases back onto the pilot's rung for the brake. A frozen
clock reads 0 from both laws (so the HUD's `coast warp` note cannot print
a frozen warp), a follow never warps, and a class swap re-snaps the base
rung while keeping the armed mode.

**State and display.** `arcade` is per-hull ship state like `timeIndex`
(created off, never cleared by reset), so a hull switch restores its own
clock mode; `formatClock` prefixes `arcade ` and prints `real ×1` for the
new stop. The HUD rate note says `coast warp +X y/s` when the warp is
armed and running (`actual` otherwise), and the preset press is consumed
before the shared clock is read, so it applies on its own frame.

**Validation.** `experiments/ship-test.js` is 121/121 — the real stop's
arithmetic and ladder order, the preset pair (unfreeze, SIM clears and
warps off, ARCADE homes and arms, a class swap re-snaps), the coast
warp's law (off by default, zero in the burn and on a follow, exactly the
four-second floor in the coast, above the base rung, zero frozen), and the
flown composition (1 ly in 10.6 s and 40 ly in 25 s of wall time, both
arriving). The last pair pins the warp's *decaying* remaining-ETA form:
a constant commit-time rate was measured to overshoot a 40 ly target by
~4 ly per frame and never recover — the rate must fall with the distance,
which is the terminal rule's own shape.
`m1-smoke-test.js` is 109/109 with ui.14 pins for the buttons, the
`data-game` gate, the press-before-clock ordering, the live `is-active`
lights, the HUD note and the fallback index.
`python3 scripts/run.py changed` passes 9/9. The browser/WebGPU visual
pass remains unverified in this sandbox.

## ui.15 — the target velocity is a model-time derivative (the nose-glitch fix)

**Decision.** The autopilot's target velocity — and the same number the follow
handover, the docked ride and the target-relative readouts use — is the drawn
law's own central difference over ±10⁴ yr of **model** time
(`orbit.engineRecordVelocity` behind `selection.resolveDrawnVelocity`), never a
consecutive-frame difference. No renderer, WGSL, catalog or preset change; two
new names per file, one new `DRAWN_*`-returning method on the selection API.

**The bug.** At the fine clock rungs one frame is below the drawn position's
own f64 ULP. The position is a f64 near 8–20 kpc, so its ULP is ~55 km on a
solar-circle coordinate, while a 42 km/s star moves 0.7 km in one real-time
frame. The ui.14 feed differenced consecutive drawn positions, so the measured
velocity was 0 for dozens of frames and then one ULP: a spike of 55 km /
(1/60 s) = **3300 km/s** in that coordinate axis. §5's desired velocity carries
the target's velocity, the aim is the normalized command, and `gameAimEase`
eases onto the aim, so the nose followed the staircase: measured at 109° of
one-frame aim change at the real-time stop (30 frames over 30° in 20 s), 2° at
1e-6 y/s, 0.2° at 1e-5, 0.03° at 1e-4 and 0.004° at 1e-3 — worse the finer the
rung, which is the reported "small star time: the nose does not head the
target, it changes direction every frame". The same noise seeded the follow
handover's `ship.vel` and the docked ride, so both could jolt by km/s.

**The fix.** `engineRecordVelocity(out, x, y, z, packed, time, model)` runs the
*existing* record dispatch (mask ladder, cluster offsets, epoch map) at
`time ± 0.01` Myr and divides by `2h·SECONDS_PER_MYR`, giving kpc per
ship-second — the ship's own units. The baseline is far below every model
timescale (epicyclic and pattern periods are tens to hundreds of Myr) and
10¹¹ of the position's ULP, so the difference is the law's derivative: measured
within 7·10⁻⁶ of a 10 yr baseline at the solar circle and 4·10⁻⁵ across the
disc, bar, pressure and pattern families, with a direction error of 2·10⁻³ °
worst case. It returns the dispatch's `approximated` flag (OR of both samples);
`resolveDrawnVelocity` maps that to `DRAWN_APPROX`, no model to `DRAWN_EXACT`
with zero velocity (a frame-fixed record is still), a resident-record miss to
`DRAWN_STALE`, and a landmark to `DRAWN_APPROX` with zero — the simple
landmark mirror is stepped by the frame loop and has no closed form in time, so
the CPU says so rather than inventing motion. One `drawnIn` scratch now serves
both twins' slot/key validation; the samples live in two module scratches, so
the per-frame allocation pin still holds.

**Wiring.** `main.js`'s target feed resolves the velocity every feed (including
the 4 Hz probe, because the dispatch is a function of the model clock, not
`dtShipS`), keyed off the same ref the position resolved: station, primary,
locked destination or the frame-fixed centre/home (zero). `gameTargetPrev` is
gone; only the distance baseline `gameTargetPrevDistKpc` remains, for the
closing rate. `followTarget` now calls `memberDrawnVelocity`, so the handover
seed is the drawn law's derivative; the `followPrev`/`followHasPrev`/
`followMeasureKey` rebase machinery is deleted with the frame difference it
protected.

**Validation.** `orbit-test` 126/126 with §14b: the twin's value/unit against a
10 yr central difference (`speedKms 42.393`, `relErr 7.0e-6`), 400 frames at
the real-time rung where the shipped frame difference spikes 5 times to
3289 km/s while the twin's own direction steps 1.5·10⁻⁶ °, and the simple mask
answering `true` with an exact zero. `star-select-test` 47/47 with the
`resolveDrawnVelocity` wiring (masks 1/5, worst relative error 0 against
`drawRecord` sampled at ±h) and the three gap states. `ship-test` 123/123 with
§8b: the real `apStep` flown at 60 fps on the fine-rung ladder
(real/1e-6/1e-5/1e-4/1e-3 y/s) for both feeds — the drawn-velocity feed holds
0.01° of one-frame aim change and 0.1° of LOS error everywhere, the frame
difference is 109°/2°/0.2°/0.03°/0.004° (and pins that monotone shape).
`m1-smoke` 109/109 with the handover pin rewritten to the dispatch. `quick`
26/26 and `changed` 23/23. The browser/WebGPU visual pass remains unverified in
this sandbox.

**Next.** A browser pass at the real-time stop flying at a star from 1 AU out:
the nose should sit on the target and the burn marker should not flicker. The
simple engine still has no CPU record velocity (it is the documented gap); if
the game ever needs it, the GPU-side θ readback is the only honest source.

## ui.16 — the colony economy (colony-economy-plan.md, stage 1)

**Decision.** The draft at the branch tip (`archive/draft-colony-resources-trade-fab.md`)
becomes a plan and an implementation: a deterministic resource map per system
(what is easy to produce there — the draft's "low metal, low light" penalties),
population that grows while its needs are met, and factories that work on
events, never per frame. Everything is CPU-only and additive like the game
series; the hold/credits live on the hull records the way the tank does. The
free placeholder loads of G4 ("prices and economy stay omitted") die with the
economy they stood in for.

**The plan** (`colony-economy-plan.md`, a clean artifact) fixes: six resources
(rare elements, special chemicals, antimatter, food & biotech, factory cores &
robots, software & world data — the draft's longer lists fold: computers join
`fab`, unique items are `info`'s tail, colonists are the founding population);
`resourceMapFor` as a pure function of the generated system record plus the
model seed, with the ±0.06 jitter hashed off the star's identity key
(`hash4(star.key, seed, 0x43f6c0, 1)`) so it is as reproducible as the planets;
`advanceColony` at fixed 0.25 y steps with a 2048-step coarse ceiling; the
market `0.4·BASE … 1.6·BASE` off ease and a two-year-need stock norm; and the
two events — arrive (the dock commit) and inspect (the system view's open) —
reading `gameClockY`, the shared clock's cumulative years.

**The implementation.** `src/core/colony.js` (one API object, no per-event
allocations beyond the founding); `src/core/ship.js` gains `cargoKind` and
`credits` (400 cr per hull, surviving resets and class swaps — R empties the
hold, the account survives "the crew's, not the tank's") and loses
`loadCargo`/`unloadCargo`; `main.js` wires `gameClockY` off the loop's
`dtShipS`, the arrive at the dock commit, the inspect at the open, founding
(Flight panel's **Found colony**, free, one per port, landing the typed
`colony` asset in ui.1's history exactly as the dock lands a `dock-port`),
the `L`/`Shift+L` market trade (buy the best export within the free hold and
credits, whole tons, one commodity — a hold of another kind must sell first;
sell the whole hold at the port's price), the Flight-panel market panel
(`#flight-market`), the HUD cargo/account line, and the system-view readout's
colony block (population, capital, comfort, the six market rows). The map is
generated once at founding over the same `generateSystem` record the schematic
reads, and the colony owns it after that.

**Validation.** `colony-test.js` 26/26: map determinism (same star → same
ease; different stars differ), the ease laws (metal-poor → no rare, dim → no
antimatter, terran+HZ → food, flat info), the advance law (terran-rich growth,
the chunking equality — one 10 y advance equals forty 0.25 y advances to
1e-9, the coarse flag over 700 y, no-op spans), price bounds and the
supply response, the trade math (whole tons within credits, the cross-port
margin beats the same-port wash), real generated systems over the sampler
(40 stars, in-range, no NaN), and `formatPop`. The one law the measurement
moved: the famine bound, 0.25 → 0.4 comfort — the canonical food-poor
founding (0.004 Z, 0.05 L☉, rock+dwarf) measures 0.29 comfort, misery that
still grew at the first bound. `ship-test` 121/121 after the manifest rewrite;
`quick` 27/27 (including the new `colony`); `changed` 8/9 → m1-smoke caught
the page-scope collision (see findings) and passes after the rename.

**ui.17 — the colony economy, stage 2: events, GUI, star time.** The
priority order came from the user: events first, then the GUI, then the
integration with star time. The ledger stayed in colony.js (§6's original
home): a preallocated insertion-sorted array, schedule/dueEvents/cancel,
cap 64 dropping the latest — the head survives. advanceColony grew an
optional third argument; with it the step loop emits famine-band and
pop-ladder crossings ([0.5, 1, 2, 5, 10, 20, 40]k) timestamped at the
step's own year; without it the advance is the silent stage-1 law
(colony-test proves the physics identical either way). trade.js owns the
routes and convoys: commissioning resolves the destination through the
locked Flight destination or the primary selection, the first departure
one PERIOD out, the period re-arming whether or not a departure carries;
the cargo guard is two years of the export's own need with a 50 t cap —
the guard reads NEED as shipped (index-ordered: rare 20, food 0.2; the §3
prose mismatch is in findings). The two transit laws are the user's
gameplay dial: fast freight (0.2 ly/y, arrivals scheduled at depart +
distance/speed, drift ignored by declaration, economy on the game clock
only) and generation ships (1 ly per 10 ky, star time 0.1 Myr/s, econY
synced to the star clock in observer mode so colonies age while the stars
drift on screen; the convoys home on the destination's live drawn position
each step because over these flights the stars move further than the
trip — the arrival is discovered, not scheduled; etaYears' fixed point
reports converged/diverged, a diverging destination logs "ETA ∞ — the
star outruns the ship; it chases"). The GUI: the events pre (clock line,
route/convoy counts, the log tail), the Commission route button, the
Generation ships checkbox, and the slider's two tracks — fine 0–2 Myr/s
in 0.01 steps defaulting to 1 Myr/s (0.1 Myr/s was 0.1 % of the old
100-wide track), the full −1–99 toggle beside the value, fitRateToTrack's
snap rules (follow parks at 0.1 onto fine, off-grid rates snap up to 0.5
onto full, never to 0), formatTimeRate's three decimals under 1 Myr/s,
TIME_DEFAULT 1. Tests: colony 34/34, trade 19/19, m1-smoke and preset
updated to the new defaults; quick 27/28 — planet-gen's heap check read
2.3–3.1 MB under parallel load and passed standalone twice (a GC-timing
flake on a file this stage never touched; noted in findings).

**Next.** The §7 list (mixed holds, tourism, colonist flows) stays
recorded, not promised. The deferred browser visual pass (game mode, the
colony panel) remains open in its plan.
