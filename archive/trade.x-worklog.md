# Trade worklog

Unversioned, CPU-only colony/trade series. Specification: `../trade-plan.md`;
brief: `draft-colony-resources-trade-fab.md`. Browser visual work stays in
`../deferred-browser-visual-plan.md` (V13), not implied by these tests.

## trade.1 — 2026-10-20 — Resume the inherited implementation; correctness pass

The checkout already contained the heap, economy/network modules, main/preset/
input/HTML integration, label overlay and a passing 50-check trade test, but no
trade-series log. Reviewed these against the brief before extending them.

Reconciled the plan with the actual tuned design: one port per star, 32 seed/64
total ports, 96 fleet slots, 150-year warehouses, industrial potential-output
inputs, scaled expedition costs and **abstract** 2–4.5 ly/trade-year travel. The
old plan described 18 sublight ships and eight-year warehouses, which were not
what the code implemented. Documented inspection-sensitive frozen coverage,
non-constrained recipes and founding stock grants rather than claiming exact
variable-coverage accounting or conservation the model does not provide.

Correctness changes:

- Logistic population/integral now use stable `expm1`/`log1p` branches; very long
  growth approaches K, starvation approaches zero with a finite positive
  integral. The inherited long-time branches had these limits reversed.
  Population is bounded by K, including founding.
- Destination motion resolves into its own output, preserving the route's first
  endpoint. Trade-only canvases clear once when disabled; removed unused scratch.
- Discovery remembers keys even when frontier storage is full, and reinspection
  settles the existing port. Fixed a local `planets` count shadowing the module
  that made the terran flag preference ineffective.
- Expedition checks settle sources at event time; costs are checked before
  allocating a hull or deducting stock. Whole target stars are reserved in
  flight, outstanding missions reserve port capacity, and failed founding
  releases reservations and schedules the source-port load instead of stranding
  an eventless hull. Waiting uses the declared EV_WAIT event kind.
- Divisible stock/tonnage conversions preserve fractional cargo. Partial unloads
  no longer discard a sub-unit remainder; nonempty holds top up their resource.
  Abandoned colonies are excluded from player-port lookup.
- Removed the application's unfinished fallback to free G4 containers at
  colony-free docks. Shared load/unload gating now refuses these transfers;
  the Flight Port row reports the colony/population/export and cargo resource,
  with updated button tooltips and README controls.
- Empty heap pop is harmless. Registered economy/queue/trade in export-parity
  coverage; added a standalone queue stress suite to the runner.

Validation:

- `node experiments/trade-test.js`: **78/78**. Includes full-state 5,000-year jump
  versus 5-year steps, real deliveries/foundings, exact revision-matching event
  counts per hull, overlapping expeditions under deliberately slow travel, last
  port-slot reservation, failed founding recovery, fractional cargo conservation,
  application refusal at a colony-free dock and canvas-stub route/hull geometry.
- `node experiments/exec-queue-test.js`: **5/5**, including 50,000 events against a
  sorted reference, all event columns, handler-triggered growth and follow-ups,
  stale consumer revisions, empty operations and steady typed-storage reuse.
- `node experiments/export-parity-test.js`: **178/178**.
- `python3 scripts/run.py all-tests`: **38/38 suites passed** (~225 s).
- `node --check src/main.js`, `git diff --check`: passed.
- Final `quick` runs: **27/28**, with the unchanged `planet-gen` architecture
  coarse heap-delta check reporting ~3.21 MB against its 2 MB threshold under
  the partial-run preload. That suite passed in the full run and **108/108**
  standalone with log writes disabled. Left this GC/preload-sensitive measurement
  unchanged rather than relaxing an unrelated allocation threshold; trade and
  queue suites passed in both quick runs.

No WGSL, star buffer, renderer pipeline or model equations changed. No browser/
WebGPU visual verdict claimed. The open limits and follow-up scope remain listed
in trade-plan.md; this is a correctness continuation, not completion of all
possible colony gameplay.

## trade.2 — 2026-10-20 — Separate Trade panel and big-colony colonisation

Visual trade was already correct (label-layer ports/routes/hulls in drawn
space, Y toggle). Extracted its controls from Flight into its own panel so
piloting and economy have separate workspaces: trade-rate slider, draw-routes
checkbox, port/ship counters, six-largest-colonies list and a new
Colonisation section now live in #trade-menu (bottom-right, second column
beside Help, teal-tinged). Tab toggles all six panels; each collapses to its
header. Flight keeps its Port dock/cargo rows.

Colonisation: big colonies now drive expansion. Fixed pickCandidate's
inverted distance law (0.6+ly/250 preferred distant frontiers; now
habitat/(1+ly/80) prefers nearby good worlds), added habitat scoring via
siteHabitatScore (HABITAT + 1.6x terran / 1.25x HZ) with a 0.12 floor, and a
isBigColony gate (pop 5M, coverage 0.30, 8% of capacity) so only
thriving worlds with surplus people/robots launch. bestExpedition now
weights pop fraction and coverage, checks every eligible port (not just the
largest), and remains capped at one launch per 200 y. Added
colonisationPreview for the panel and expandFrontierFromField, called
every 25 trade years from the main loop with the live field: big colonies
scan field stars within 300 ly (0.092 kpc), generate their system, keep its
best habitable world as a new candidate and mark the star discovered, so the
frontier expands beyond the initial 400 seeded systems without requiring
player inspection.

Validation:

- node experiments/trade-test.js: 78/78 (jump-equals-steps, live-event
  invariant, overlapping reservations and failed-founding recovery hold; counts
  shift slightly due to stricter but still permissive big-colony gate).
- python3 scripts/run.py changed: 8/8.
- node experiments/m1-smoke-test.js: 112/112 (TradeLib export count 44->51).
- node --check src/main.js src/core/trade.js: passed.

## trade.3 — 2026-10-20 — Star-time-coupled trade controls

User-reported issues:

- The Trade panel readout could sit on stale text ("no big colonies ready")
  while the network ran, because syncTradeUi only painted while the Systems
  menu was open. Colonisation itself was verified by simulation: seed ports
  cross the big-colony gate (pop ≥ 5 M, coverage ≥ 0.30, pop ≥ 8% of
  capacity), the 25-year tick launches one expedition per 200 years from
  every eligible port, and the frontier scan adds good worlds near big
  colonies, so the network grows at the fastest trade rate.

New features:

- Sync time (Trade panel checkbox): the trade clock rides the star clock
  (starTimeRate · 10⁶ trade years per second, capped at 0.25 s of wall time
  per frame) instead of the wall-time ladder; outside game mode only. The
  trade slider is disabled and the readout shows the effective rate with a
  "synced" tag.
- Generation ships (Trade panel checkbox): every hull flies 1 light-year per
  10 000 years (GENERATION_LY_PER_YEAR = 1e-4 in legYears) and the star
  clock is set to 0.1 Myr/s, so with sync time on a 1 ly hop takes ≈10 kyr
  of star time — a tenth of a second of sky time at 0.1 Myr/s.
- Route re-timing: while the stars move (dtStar > 0) and the trade clock
  runs, in-flight voyages are re-measured against the endpoints' live drawn
  positions (label layer's record dispatch at the current star time) and the
  arrival is rescheduled when the remaining journey moves by more than a
  year. Booking also uses live positions. Non-resident endpoints fall back to
  birth coordinates. label-layer's tradeDrawnPosition is replaced by
  tradeRecordPosition(kind, index, key, out), shared by the overlay pass and
  main.js's resolver.
- Star-time slider: default fine range −1…2 Myr/s in 0.1 steps so small
  rates such as 0.1 Myr/s are settable; a "wide range / fine range" toggle
  button widens to −1…99 Myr/s in 0.5 steps.
- Presets: tradesync and tradegen (0/1) ride beside trade/traderoutes.

Files:

- src/core/trade.js: generation mode, live-position booking (sailTo,
  launchExpedition), retimeRoutes, ship.leg, TradeLib exports
  generationMode/retimeRoutes.
- src/render/label-layer.js: tradeRecordPosition replaces tradeDrawnPosition
  plus the now-unused tradeSlot; overlay draws endpoints at live positions.
- src/main.js: sync-time dt, retimeRoutes call in the loop, live-position
  resolver wired through the label layer, the two checkboxes, the range
  toggle, slider min/max/step clamping, live unconditional 4 Hz syncTradeUi,
  preset collect/apply for tradesync/tradegen.
- src/index.html: trade-sync-time, trade-generation-ships checkboxes and the
  star-time-range button.
- src/core/presets.js: tradesync/tradegen fields and defaults, LLM prompt key
  list.
- trade-plan.md: §6 documents the controls.

Validation:

- node experiments/trade-test.js: passes.
- python3 scripts/run.py changed: 12/12 passed.
- python3 scripts/run.py m1-smoke preset: passed (TradeLib export count 51->53).
- node --check on all edited sources: passed.
- Standalone Node check of generation legs, live-position booking, re-timing
  (moved endpoint, mid-voyage, birth-coordinate fallback) and sync-time dt:
  all pass.

No renderer/WGSL changes; overlay geometry unchanged. Next: planet-specific
docking visuals and physically calibrated interstellar freight remain deferred
per trade-plan.md.

## trade.4 — 2026-10-20 — The two clocks, visible growth, a stable start

The report was that colonies never visibly grow, the network sometimes
restarts, and that sync time plus the generation-ship mode make ships
teleport while the page drops to zero fps. All three traced to the clock
coupling, and the cure is a rate rather than an identity.

Measured (Node, the 24-landmark fixture, 20 s of wall time):

- 100 y/s (the ladder default): 153 events/s, 8.5 ms CPU per wall second,
  top colony 56 M → 1 045 M in 20 s. Growth *is* visible here.
- 2 000 y/s (the ladder top): 3 124 events/s, 24 ms per wall second.
- 10 000 y/s: 15 676 events/s, 97 ms per wall second — cost is linear in
  the rate, which is the whole problem.
- The old identity sync (star Myr/s · 10⁶ y/s, i.e. 2·10⁶ y/s at 2 Myr/s):
  313 ms of CPU **per frame**, 51 000 events a frame, and in 3.13 s of CPU
  the clock advanced 333 000 y of the 6 000 000 asked for. That is the
  frozen page and the teleporting hulls in one measurement.

Changes:

- Clock law in `trade.js`: `SYNC_YEARS_PER_MYR = 1000` (one trade year per
  1 000 star years), `RATE_MAX = 2000` y/s, one `clockRate(ladderYears,
  starRateMyrPerS, synced)` used by the frame loop and both readouts. The
  star slider's fine range now lands on the trade ladder it was authored
  for: 0.1 Myr/s ↔ 100 y/s, 2 Myr/s ↔ 2 000 y/s.
- `step(net, years, budget)` + `exec-queue.drainUntil(…, budget)`: a tired
  frame stops at the next due event instead of skipping it (the clock stays
  monotonic and no colony settles backwards) and the unserved span
  accumulates in `net.lag`, which the panel reports in star Myr.
  Main's budget is 256 events a frame; the maintenance passes (route
  re-timing, frontier scan) moved onto a 0.5 s wall timer instead of every
  frame, and the frontier scan lost its per-improvement `createSite()`
  allocation storm, gained a ring cursor (8 000 stars, 4 new worlds per
  scan) and a preallocated best-site record.
- Generation ships: 1 ly per 1 000 years (0.1 % c) instead of 1 ly per
  10 000 years, and the checkbox sets the calibrated pair (sync on, star
  clock 2 Myr/s). A 5 ly hop is 5 000 y ≈ 2.5 wall seconds at the top rate;
  the old constants put it at 0.025 s, which is why the mode read as
  "ships teleport".
- Growth is now a picture, not six rows of near-identical numbers: a port
  ring's radius is `2 + 5.5·√(pop/capacity)`, its colour is the growth sign,
  a colony past 60 % of capacity gets a filled core, free candidate worlds
  are crosses (the frontier), founding voyages and hulls are amber and the
  founding hull is hollow. The panel's colony rows gained a size bar and
  `↑ 1.25 %/y`, and the state line says `time-lapse` at rates ≥ 500 y/s.
- Colonisation: `colonisationStatus()` names the shut gate instead of "no
  big colonies ready" (`no big colony yet`, `no colonists or factory cores
  spare`, `no free world in range`, `waiting for the next launch window`),
  and the panel's **Send expedition** button launches the tick's own choice
  now (`launchBest`, same costs and reservations, only the 200-year window
  bypassed).
- The start is stable and has a subject: the seed map forces a **capital**
  — the first star with a world inside 20 ly of the viewer's home — whatever
  the settled-fraction roll says. With the default seed that is Rigil
  Kentaurus at 4.4 ly (the Sun has no planets in the generator, so it can
  never be the port). H selects the capital, flies the observer there and
  rides it; in game mode it becomes the Flight destination. H's action flag
  is now consumed every frame (it used to stay set in observer mode).
- 4 Hz readouts settle all ports once (`settleAllPorts`) before ranking
  them, so the panel and the big-colony count read the current state;
  `pickDestination` no longer settles every port thirteen times per load
  (one pass per decision instead), and `sailTo`, the founding booking and
  the re-time pass share one live-position helper with module scratch.
- Trade panel markup: the two checkboxes now carry the real numbers in
  their tooltips, the launch button is new, and the Controls panel's home
  button is "home colony (H)".

Files: `src/core/trade.js`, `src/core/exec-queue.js`, `src/main.js`,
`src/render/label-layer.js`, `src/index.html`, `trade-plan.md` (§1, §3.1,
§5, new §6/§7/§8), `experiments/trade-test.js` (§11 plus the growth-ring
and frontier-mark geometry checks), `experiments/m1-smoke-test.js` (the H
wiring shape).

Validation:

- `node experiments/trade-test.js`: 90/90 (adds 7 clock/launch/capital
  checks and 1 overlay check).
- `python3 scripts/run.py changed`: 13/13 (m1-smoke updated for the new H
  contract; the earlier failures were pinned text shapes, not behaviour).
- `node --check` on every edited source: passed.
- Standalone probes: clock mapping (0.1 → 100, 2 → 2 000, 99 → 2 000 cap),
  generation leg (5 ly → 5 000 y → 2.5 s), budgeted vs unbudgeted drains,
  and the identity-sync cost above.

Next: the frontier still only scans field stars, so a catalog-dominated
galaxy grows slowly; a `deferred-browser-visual-plan.md` pass should confirm
the ring scaling and the frontier marks read well against the star field,
and the capital choice is worth showing as a label on first arrival.

## trade.5 — 2026-10-20 — Growth on screen, a network that survives, a quiet fleet

The report after trade.4 was specific: colonies still did not *visibly* grow, the
network rebuilt itself at start, and the synced generation-ship mode was fast and
freezing at once. Each had a different cause.

1. **The overlay was gated by the routes checkbox.** `setTradeOverlay(net, time,
   tradeRoutesOn && !systemView)` meant unticking "draw trade routes" removed the
   ports, the hulls and the frontier with it — and the default `traderoutes=0`
   path (a preset) had no network on screen at all. The checkbox now owns only
   the route lines (`setTradeOverlay(net, time, show, routes)`); ports, hulls and
   candidate marks draw whenever a network exists.
2. **Nothing on screen said "this colony is new".** Rings already scale with
   population, but a two-second-old world is a small ring among small rings. A
   colony younger than `TRADE_YOUNG_YEARS = 150` now wears a second, wider ring,
   and the panel gained a `newest <name> <pop> <age> y old` row — the six largest
   colonies can never show an expansion.
3. **`regenerateGalaxy` re-seeded on every call**, including the epoch presets
   that only change the age. The network's clock and colonies restarted at year
   zero — the "rebuild at start" flash. Main now remembers the model the network
   belongs to (`type:seed`) and re-seeds only when that changes.
4. **A saturated network spent its frame budget on idle polling.** A hull with
   nothing to carry re-polled its port every `WAIT_YEARS = 2`; at 2 000 y/s that
   is a thousand events a second per idle hull. The retry interval doubles per
   failed poll (`WAIT_YEARS_MAX = 500`) and a load resets it. Measured over 20 s
   at the synced top rate, 24 landmarks plus a 120k-star field: 3 791 ms → 389 ms
   of CPU, backlog 7 531 y → 0, max frame 18.3 ms → 6.9 ms.
5. **The generation-ship mode starved its own network.** With 5 000-year voyages
   and a 150-year warehouse, coverage fell under the big-colony gate within a few
   thousand years and the mode froze: no growth, no expeditions, red rings. The
   mode now stretches the reserve horizon to the crossing time
   (`GENERATION_RESERVE_YEARS = 5 000`, ×33.3), live colonies included. Measured
   on the landmark fixture: 20 000 years at the synced top rate keeps all 20 big
   colonies (median coverage 0.48) instead of falling below the gate; on the app
   fixture the same mode now reaches 35 ports with 3 foundings and no backlog.

Also: the frontier scan moved to 4 000 stars per call (peak cost 23 ms → 12 ms),
keeping its ring cursor and 4-new-worlds-per-scan pacing.

Validation:

- `node experiments/trade-test.js`: 101/101. New: a live-field frontier scan
  (canonical field keys, distinct refs, within a big colony's reach, cursor
  walk, no-op without a field or a big colony), the overlay's growth cues
  (young ring appears and expires, routes off keeps colonies), idle-hull backoff,
  and the mode's warehouse stretching and restoration.
- `python3 scripts/run.py changed`: 13/13.
- Measured on the app fixture: 100 y/s 144 ms CPU / 20 s; 2 000 y/s 530 ms;
  2 000 y/s generation ships 389 ms with 35 ports and 3 foundings.
