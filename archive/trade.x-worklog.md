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

## trade.6 — 2026-10-20 — The four-colony start, centred on the capital

The brief: open on a colony at home H, with four colonies that send ships to
found more, reaching 5–15 colonies after 10–20 s at the default parameters, the
default star clock at 1 Myr/s, a sensible generation-ship speed, and any glitch
found along the way fixed.

Measured first, on the Node replay of the app's boot and frame loop: 32 seed
colonies (not four), 37–44 colonies at 10–25 s, and at four seeds only one
expedition in 2 000 years. Cause: the seeds were the first settled stars in
catalogue order, at 310, 42 and 861 ly, and the expedition search reaches 300 ly
(`findings-pitfalls-skills.md`, 2026-10-20).

1. **The start map is built and discovered nearest home first.** `trade.startSystems`
   collects the named sky and the field stars within 1.2 kpc (nearest 400) with
   their distances from home; `trade.discoverNearest` discovers them in that order
   and stops once the seeds and the candidate pool (224) are full. Main's
   `tradeSeedNetwork` is now four calls, and the test fixture uses the same two
   functions, so the tests exercise the scenario, not a catalogue-order one.
2. **Four seed colonies** (`SEED_PORTS = 4`). With seed 42: Rigil Kentaurus (4.4
   ly, the capital), Fomalhaut (25 ly), Capella (43 ly), Regulus (79 ly).
3. **Expedition interval 250 years** (was 200). At 200 the default seed reached 9
   and 14 colonies at 10 and 20 s, at the ceiling; at 250 it reaches 8 and 12. Seeds
   7 and 1234 give 8/12 and 8/11.
4. **The page opens on the capital.** `goToHomeColony()` runs after the loop
   starts: H's path, a 2-second eased flight from galaxy-centre orbit and a ride on
   Rigil Kentaurus. Galaxies with no capital (the Sb type measured) stay in the
   galaxy-centre view.
5. **Star clock default 1 Myr/s** (was 5). From `Presets.TIME_DEFAULT`, so the
   slider, readout, URL and Defaults button agree. The trade clock stays at 100 y/s
   unsynced: synced at 1 Myr/s the network reaches its plateau in about 5 s.
6. **Generation ships at 2.5 ly per wall second** (`GENERATION_LY_PER_YEAR = 2.5e-3`,
   was 1e-3), synced at the default 1 Myr/s (`GENERATION_STAR_MYR = 1`, was 2).
   At 1e-3 the nearest seed hop took 25 s and the median 76 s, and ten expeditions
   sat in flight with nothing visible. Now ~10 s and ~30 s. Warehouses hold: median
   coverage 0.47 over 60 s with the 5 000-year horizon, all colonies big.
7. **Legibility floor: 50 trade years per voyage** (`MIN_LEG_YEARS`, was 0.5).
   A 10 ly freighter hop was 2–5 years, a few frames at 100 y/s: it read as a
   teleport. Now at least half a wall second.
8. **Glitch scan.** Node scan of every ship's position each frame, 20 s at the
   default pace and 40 s in generation mode: no ship moved faster than its hull
   allows, no position was non-finite. The one real glitch was the short-leg blink
   (7), and the far-flung seeds (1).

Not moved: no catalogue star was moved. The far seeds were the glitch; nearest-first
removes them, and the real positions of the named stars are data.

Tests and docs:

- `experiments/trade-test.js`: 107/107. The mechanics checks (grown, jump,
  overlapping, failed founding, generation mode) run on the start map, not on a
  catalogue-order fixture. New §16 pins the scenario: four colonies, the capital
  nearest home and inside 20 ly, all four within 100 ly, 5–15 colonies after 10 s
  and after 20 s at 60 fps with the default clock, freighters on routes. The
  generation hop and freighter floor checks follow the new calibration.
- `experiments/m1-smoke-test.js`: 113/113 (startup rate 1 Myr/s, the boot centres
  on the home colony, the start map nearest-first).
- `experiments/preset-test.js`: the defaults table now says time 1.
- `python3 scripts/run.py changed`: 8/8. `quick`: 28/28.
- `trade-plan.md` §1, §3, §3.2, §6, §8 updated; `plan.md` startup line and the
  5 Myr/s timing note; README trade paragraph; the generation checkbox tooltip.

Not verified: the browser. There is no browser in this environment, so the boot
flight, the four seeds in the overlay and the 50-year legs at 100 y/s are checked
only in Node, not on screen.

Plateau: the default seed levels at 14 colonies from about 30 s. The landmarks
within 300 ly are settled or reserved, and the field is beyond that range.

Next:
- Widen the frontier past the named sky so the plateau at 14 becomes growth,
  either by sampling the field nearer home or by letting big colonies scan the
  catalogue within reach; measure the 10–20 s band again after.
- A browser pass: the boot flight, the four seeds in the overlay, and whether the
  50-year legs read as motion at 100 y/s.

## trade.7 — 2026-10-20 — Growth that shows, a frontier that opens, a visible fleet

The brief: colonies grow too slowly to see, generation ships are slow, and the
expansion stagnates. Measured first, on the Node replay of the app's boot and
frame loop with the page's own start map: 4 colonies, 6 at 5 s, 14 at 25 s, and
then flat to 120 s. The plateau was real and it had three causes, not one.

1. **The launch gate was warehouse stock, and almost nobody could pay.** The old
   colonisation cost `people = clamp(0.15*K, 40, 400)` plus
   `robots = clamp(0.03*K, 10, 100)` units, both taken from the port's
   warehouses. Measured at the plateau: `colonisationStatus()` reported
   `stocked: 1` of 14 big colonies, and 13 of 14 ports had zero exportable
   factory cores. Only one world in fourteen produced a people surplus at all.
   The other thirteen were large, fed and *unable to launch* by construction.
2. **One network-wide launch window.** A single 250-year `EXPEDITION_INTERVAL`
   plus one expedition per tick meant a big port waited decades of trade years —
   seconds of wall time — for its turn while its surplus piled up.
3. **The frontier was out of range.** The 300 ly expedition radius is shorter
   than the 300–600 ly hole in the sampled field around home; the named sky is
   inside ~120 ly and the next sampled shell is at 307 ly. Candidates existed
   (224 in the pool, 22 free within 300 ly of a port), but most were siblings of
   already-settled stars or worlds no expedition could ever take, because the
   one-colony-per-star rule means only each star's best site is a real place.

Changes:

1. **`G_MAX = 1/80 → 1/40`** in `economy.js`. At the authored coverage of 0.47
   the growth rate is now ≈0.7 %/y instead of ≈0.15 %/y: a world founded at 45 %
   of capacity reaches 90 % in ~330 trade years, 3.3 wall seconds at 100 y/s.
   The 40-year e-folding is still a colony lifetime, so the top of the ladder
   does not become a blink.
2. **Founding costs people, not stock.** `expeditionCost()` now draws
   `clamp(0.02*P, 0.5 M, 4 M)` people from the source's population and keeps at
   least 2 M behind. Nothing is taken from a warehouse; "colonists" and "factory
   cores" remain ordinary trade goods. The carried party is still a ship
   manifest in stock units (`peopleM / POP_PER_COLONIST_UNIT`), and on arrival it
   becomes the colony's population. This deleted the people/robots gate
   entirely — the gate was the plateau.
3. **Per-port cooldown.** `EXPEDITION_COOLDOWN = 900` years replaces the global
   `EXPEDITION_INTERVAL`; `tick` launches every ready port up to
   `MAX_FOUNDING_IN_FLIGHT = 24`. A tick is still 25 years, so no extra event
   pressure. A new colony's `lastExpedition` is set at founding, so it sponsors
   its first wave one cooldown after it exists. `MAX_SHIPS` 96 → 128 keeps a hull
   free for every founding voyage and the freighter target (74) intact.
4. **One candidate per star, its best site.** `discoverSystem` now settles the
   best site (`DISCOVER_PICK`) when the seed roll fires, or adds exactly that one
   best site as a candidate otherwise; a star whose best world is below
   `MIN_CANDIDATE_HABITAT` contributes nothing. The habitat gate moved 0.12 →
   0.10, because a belt is 0.10 on the habitat scale and the capital itself can
   be a belt. The pool is 224 places a port can actually take instead of 224
   slots of which most were unreachable siblings.
5. **`MAX_FOUND_LY = 300 → 600`.** The sampled field's first shell sits at
   307–600 ly, so 300 ly left the whole named sky with nothing in reach once its
   stars were settled. 600 ly is 1.3–3 s for a freighter.
6. **Generation ships `GENERATION_LY_PER_YEAR = 2.5e-3 → 3e-2`.** At the synced
   1 Myr/s (1 000 trade y/s) that is 30 ly per wall second: the nearest seed hop
   is under a second, a 300 ly frontier hop 10 s, the 600 ly maximum 20 s. The
   mode still reads as slow ships — 1/70–1/150 of a freighter's wall-second
   speed — but the fleet visibly moves and the network keeps founding.

Measured at the default 100 y/s, 60 fps, 256-event budget, 0.5 s frontier scan,
seed 42 and the page's 300k field:

| wall s  | 0 | 5 | 10 | 15 | 20 | 25 | 30 | 35 | 40 | 45 | 50 |
|---------|---|----|----|----|----|----|----|----|----|----|----|
| ports   | 4 | 8 | 11 | 16 | 27 | 32 | 44 | 50 | 56 | 63 | 64 |
| big     | 3 | 8 | 8  | 16 | 25 | 32 | 42 | 50 | 56 | 63 | 64 |
| founded | 0 | 4 | 7  | 12 | 23 | 28 | 40 | 46 | 52 | 59 | 60 |

64 ports by 50 s (5 000 trade years), population sum 0.1 B → 11.2 B, coverage
median 0.47, minimum 0.31, zero abandoned, 4.5 M units hauled by 90 s, 90 ships
of which 88–90 sailing while the network grows. The curve is not seed-specific:
seeds 42, 7, 1234 and 4242 reach 11–12 ports at 10 s, 27–30 at 20 s, 46–58 at
40 s and all 64 at 48–50 s. Generation mode at the synced
1 000 y/s: 22 ports at 10 s, 33 at 20 s, 41 at 30 s, 53 at 40 s, 61 at 50 s, 64
at 60 s; all 64 big, median coverage 0.47, minimum 0.31, zero abandoned, 1.66 M
units delivered by 120 s.

Panel and page:

- `src/main.js` colonisation block: reads `status.ready` / `status.resting` /
  `status.nextIn` (the removed `EXPEDITION_INTERVAL` field was producing `NaN`),
  formats volunteers through `economyLib.formatPop(s.amount *
  tradeLib.POP_PER_COLONIST_UNIT)`, and shows each candidate's `peopleM`. The
  reason line now distinguishes "resting" (with the next launch in years) from
  "no free world within 600 ly".
- `src/index.html`: the generation checkbox reads "Generation ships · 30 ly/s"
  with a matching tooltip; the `Send expedition` tooltip says 900 years of rest
  for the sponsoring port.
- The `Send expedition` button is now a rush: it may sponsor a port that is
  still resting between automatic waves, and that port's cooldown restarts from
  the manual launch. Without it the button was disabled almost always, because
  the 25-year tick spends every ready port immediately.

Tests and docs:

- `experiments/trade-test.js`: 114/114. §16 re-banded to the measured curve
  (5–20 at 10 s, 18–40 at 20 s, ≥ 45 at 40 s, 64 at 90 s). Two growth checks
  replaced the invalid "founding share < 0.25" one: the capital must reach
  > 0.85 of its capacity within two wall seconds from ~0.19, and the colony
  founded last before 20 s must gain at least 5 % of its capacity by 90 s. The
  failed-founding fixture now also checks that the volunteer party goes back
  into the source's population instead of vanishing from the ledger; the
  manual-launch fixture proves the button can rush a resting port; and the
  readout is checked in its common state — every big port resting — where a
  stale `rush` reference in the preview crashed before the fix. The scenario
  fixture now attaches `ctx.field` before `startSystems`, as the page does — with
  a null field the generated field stars differ and the fixture measured a
  different sky (that mismatch was the 44/51 that the old bands were written
  against). §15's generation-mode case already checks that founding continues
  through the slow fleet.
- `experiments/m1-smoke-test.js`: 113/113 (module load list and index.html
  wiring unchanged).
- `node --check` on `trade.js`, `main.js` and the test.
- `python3 scripts/run.py changed`: 8/8.
- `trade-plan.md` §2 (G_MAX law), §3 (one candidate per star), §3.1 (128 hulls,
  24 founding voyages), §3.2 (volunteer cost, 900-year cooldown, 600 ly),
  §6 (30 ly/s, measured generation curve), §7 (new panel text), §8 (start,
  pace table, growth, generation table, checked bands).

Not verified: the browser. The overlay's ring growth, the new label text and the
30 ly/s hulls are checked in Node only; there is no browser in this environment.

Next:
- A browser pass: the boot flight, the four seeds, a young colony's ring moving,
  and whether 30 ly/s voyages read as motion.
- Measure the frontier scan's 4 000-star ring per 0.5 s call with 64 ports and a
  500k field; it is the remaining per-frame cost that scales with the sample.

## trade.8 — 2026-10-20 — Live geometry: trade among moving stars

The report: at star time > 0 the network trades with stars that are no longer
near it, because every *choice* still read birth coordinates. Confirmed and
measured through the shipping dispatch (classic mask, the page's field sample):
for the field stars inside 250 pc of home, a 1 007 ly birth pair is 6 213 ly
apart at 60 Myr — one minute at the default 1 Myr/s — and 18 984 ly at 200; over
the 60-star landmark sky the mean stretch of each star's birth-nearest pair is
4.4× at 10 Myr and 37× at 100 Myr (worst 583×, Sirius–Procyon, past
`MAX_LEG_LY` with 16 of 60 pairs). Trade went the other way on all three of
§6's metrics: `pickDestination`/`pickExport`/`pickCandidate`/`bestExpedition`
and the frontier scan scored the birth distance, `liveLegYears` booked the drawn
one, and the caps were checked against the birth number — so a 30 ly hop scored
as one and flew 3 000.

The tiers, the laws and the numbers are `trade-plan.md` §9. What landed:

1. **One geometry cache** (`trade.js`): `refreshGeometry(net, starTime, moving,
   myrPerYear)` fills preallocated port/candidate position and rate arrays on
   the 2 Hz maintenance pass that already existed, refreshes before the first
   drain after a paused trade clock, and is a no-op when the sky is frozen — a
   fixture with no resolver is bit-identical to the old network (§17.1). Scoring
   reads the cache and never the resolver (800 dispatches per load decision
   otherwise); the booking resolves, because it is one hull making one decision.
2. **The leg laws.** `planLeg` is the linear intercept from the cached
   positions and rates — exact for uniform relative motion, no resolver call, so
   reachability is answered for every partner in a scoring loop. `bookLeg` then
   re-solves the winner against the law, and `solveRemaining` is the one solve
   the booking, the re-aim and the way home all use.
3. **The measurement is the endpoints' separation at arrival, in the field's
   frame** — the correction the first implementation needed. The inertial chord
   from the hull's departure point made every route in the galaxy unreachable
   inside a Myr: at the synced rate a trade year is 10⁻³ Myr of sky and the disc
   turns 765 ly per star Myr at the Sun's radius, i.e. 7.6 ly per trade year
   against a 2–4.5 ly/trade-year hull. Measured with the inertial form: the
   start map's founding waves were all refused at 0.5 Myr of star time. In the
   field's frame a rigid rotation cancels and only the differential drift
   stretches a leg — which is exactly what tears routes apart.
4. **Pursuit and the give-up.** Twice a second a hull re-aims; its chord
   position is now its *flown distance over the current chord*, not the elapsed
   time over the booked one (with the time fraction a voyage whose chord had
   grown to 12 000 years still read as 97 % flown, so nothing ever turned back).
   A hull past `DIVERT_FACTOR = 1.6` × its cap, or a target that is `outrun`,
   turns around: a freighter flies home with its cargo, a founder takes the
   failed-founding path (volunteers back into the source's population), and
   `legTo` flips to 0 so the drawn dot turns where it is. `net.diverted` shows
   on the Trade panel with a `live routes` note and a blind count.
5. **The friction field's tracked mirror** (`orbit.js`, `label-layer.js`): ≤ 512
   records, θ seeded where the renderer seeds its buffer (`initSimpleLandmarks`,
   plus `redrawField`), stepped per frame beside the landmark mirror, caught up
   from the seed instant in substep-bounded chunks for a late-tracked record,
   and integrated forward (bounded at 96 substeps) for a prediction. The mask
   ladder moved into `engineRecordPositionTheta`/`engineLandmarkPositionTheta`
   with `-1` meaning "exactly as before", so the parity contract is untouched.
   Measured: lockstep equals the shipping law to 1e-12 rad, a prediction is
   within 5e-4 rad of a per-frame reference over 2 Myr, and a 60 Myr late
   catch-up is 1.2e-4 rad (2.6 ly at 6.4 kpc).
6. **The frontier scan** keeps its cheap birth-frame gate, stretched by
   `vFlat·R·T/r` plus the epicyclic floor 2√2·σ·r/vFlat, capped at 8× the gap,
   with `FRONTIER_LIVE_PER_SCAN = 800` exact resolves behind it (a stretched ball
   around 64 ports covers most of the disc; 4 000 resolves would be a 5 ms hitch
   twice a second). The launch decision is live in any case.

Cost, measured (Node, this sandbox): `simpleTrackStep` 43 µs/frame for 512
entries at one substep; one friction-field prediction 3 µs (0.85 µs on the
closed-form masks) — one derive plus its substeps, after inlining the second
`simpleDerived` out of `simpleIntegrateTo`; a geometry refresh 0.3–0.9 ms; a
128-hull maintenance pass 512 predictions, 0.4 ms on the closed-form masks and
1.4 ms on the mirror, twice a second. Bookings pay the full six iterations, a
re-aim pays two (`RETIME_ITERS`) — it is corrected again on the next pass, and
the difference is 128 hulls' worth of `simpleDerived`.

Validated: `trade-test.js` 134/134 (114 before + §17's 20 new checks: the frozen
identity, the cache against the dispatch, the booking as the endpoints'
separation at arrival, the frozen fallback, the two refusals, the divert, the
way home booked over the flown part of the chord, the docking and the founder's
refund measured across the arrival event, the frontier stretch on a warm and a
cold disc, 120 s of shearing sky with no hull past the give-up margin, the
chord-fraction rule, and the friction field's resolver reading the tracked
mirror); `orbit-test.js` 134/134 (8 new §13 checks);
`wgsl-validate.js` 186/186 (the ladder checks now extract the θ twin; the
contract is the same); `m1-smoke` 113/113. Measurement fixture (`/tmp`, not
committed): 24 landmarks at seed 4242, defaults 1 Myr/s and 100 y/s, 120 s —
frozen 12 ports / 21 sailing / 550 800 units; moving 12 ports / 14 sailing /
356 800 units, no diverts at the default shear (a jumped sky and a 10× star
clock do turn hulls, and §17 pins both).

Not verified: the browser. The friction field's overlay positions, the panel's
new note and the divert's drawn turn are Node-only; a visual pass is still the
open item, and the "pursuit curve" remains deferred (the overlay draws a chord
between the last two live endpoints).

Note for the next run: `planet-gen`'s two coarse heap-delta checks
(`architecture`/`generateSystem` allocate nothing) fail intermittently under a
parallel `changed` run — 1 failure in 5 standalone runs, with `planets.js`
untouched. Not caused by this pass; worth a tolerance or a GC settle if it
starts biting.

Next: a browser pass over the moving sky (the overlay riding the stars, the
`live routes` note, a jumped sky turning a hull visibly around), and a decision
on whether the page should default the star clock to a slower rung while the
trade network is live — at the current default the network's geography is
stretched 4× inside a minute, which is honest but reads as a network winding
down.
