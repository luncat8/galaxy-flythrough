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

## ui.12 — Distance field camera projection and dedicated panel

**Projection repair.** The distance-field renderer had read vertical FoV from
`viewProj[5]`, but that matrix is already projection × view: the entry also
contains the camera's up-axis rotation and collapses toward zero as the view
rolls. The field now takes the camera's explicit `fovY`, live eye position,
forward/right/up basis, and viewport aspect. The coarse CPU pass used to set a
separate 16:9 aspect, so its auto-range measured a narrower view than the GPU
actually displayed; it now uses the same canvas aspect as the field grid.

**Kernel repair.** The old `sin²(delta)` weighting treated a star and its
antipode as equal angular neighbors, drawing a false duplicate hill and
inverting the directional meaning of the field. CPU and WGSL now use the
monotone cosine distance `1 - cos(delta)` with `1 - cos(sigma)` softening; the
plan records the law and the camera-projection contract. A regression test puts
near and far anchors on opposite rays and verifies each projected peak belongs
to the correct star.

**Interface.** Moved distance mode, anchor source and count out of Display into
a separately collapsible, cool-accented Distance field panel. Tab still toggles
all panels, and the anchor count control disables for fixed-size selected and
constellation sources.

**Validation.** `distance-field`, `renderer`, `m1-smoke`, `wgsl-validate`, and
`camera` pass 5/5; `wgsl-exec` passes 129/129 CPU/WGSL field parity checks;
`python3 scripts/run.py changed` passes 11/11 mapped suites. The renderer
regression uploads a rolled-camera pose and checks the exact eye, basis, FoV,
and viewport aspect sent to WGSL. Real browser/WebGPU visual inspection remains
outstanding in this sandbox.

**Next step suggestion.** Run the deferred real-GPU visual check with a rolled
camera and anchors on opposite sky directions; confirm the panel placement at
wide and narrow viewport sizes, and check the field render against actual
sprites while orbiting and free-flying.
