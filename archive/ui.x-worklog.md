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

**Left birth-space, knowingly:** the §5 search scan and therefore its centre. It is a
synchronous one-frame catalogue query with §5.3 budgets a per-record dispatch would break
(100–400 ms at 300k); making it exact means giving it the picker's chunking, which is a
larger change to a 1 000-line module than this fix warranted. Recorded in plan.md §19's
ui.2 entry as the follow-up.

**Validation.** `experiments/star-select-test.js` 31 → 45 checks: the radius scan against
an independent *dispatched* brute-force list under masks 1/4/5 at 100 Myr, a non-vacuity
pin that the drawn neighbourhood is not the birth one (the regression the old scan
passed), birth record + drawn distance in one kept row, truncation and its count, chunked
== one-call, the abort, degenerate calls, `resolveDrawn` parity across masks 1/2/4/5 and
all five blocks (worst error 0.000000), its refusal of a slot its key does not name and of
an invisible record, the end-to-end pin that a picked star resolves to where it was
clicked (flight error 0, birth error > 0.5 kpc), and both slice budgets at 300k. Full suite
`python3 scripts/run.py all-tests` → 30/30 suites passed, no test deleted, no tolerance
widened.

**Next step suggestion.** Give the §5 search the same treatment — a chunked,
dispatch-exact distance predicate — so "stars within 10 pc of this one" and "stars within
50 ly of this one" answer in the same frame of reference; it needs `search.run` split into
begin/step like the picker, and its §5.3 budgets restated as slice budgets.
