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

## trade.9 — 2026-10-20 — Outposts: a failed colony stops, is marked, is never recolonised

A colony that fell below `OUTPOST_POP_M` used to vanish from the lists and stay
in the port array as a tombstone with no name — the network's history had a hole
exactly where its failure should be. W1 gives the failure a state.

`economy.demoteColony` freezes the record (`outpost`, `outpostY`, growth 0,
starving 0) and keeps its population where it is; `trade.settlePort` calls it
once, pushes one `LOG_OUTPOST` line and never settles the port again, so the
demotion is a single event rather than a per-tick observation. `portReadiness`
reports `outpost`, `livePortCount` counts only live ports, `net.outposts` is the
tombstone count, and the overlay draws a hollow grey ring from the frozen
population under the live rings (`TRADE_OUTPOST`). The panel line says `N ports ·
M outposts` and the log says `<name> is an outpost — growth stopped`.

Validated: `trade-test` §18 (outpost detection, one log entry per demotion, the
port stays resident and is never settled back to life, `livePortCount`, the
refusals that follow: no expedition, no player load). `m1-smoke` and
`export-parity` green.

## trade.10 — 2026-10-20 — The network narrates itself

The Trade panel could say what the network *is* (ports, ships, units) and never
what had *happened*. W2 adds a fixed 64-entry ring in `trade.js` — numbers only
(`time, kind, a, b, c`), written by the same code that changes the state, so no
second observer can disagree with the simulation — and a `<pre id="trade-log">`
that renders the last eight lines at the panel's 4 Hz.

Kinds: founded (with the source port, when there was one), milestone (level and
the rungs crossed in one settle), famine / famine-end (the coverage the line is
about), outpost, expedition (out, and founders returned). A jump and a stepped
run differ in `log.time` by construction, which is correct: the event happened
when it happened.

The ring wraps in place and is never reallocated; `logAt(net, i)` is
age-from-oldest, `null` past the end. The strings live in `main.js`
(`tradeLogEntryText`) because the module stays allocation-free and the panel is
the only reader.

Validated: `trade-test` §19 (milestone scanned by kind and port rather than by
position, exactly one outpost entry per demotion, jump-vs-stepped narration
equality with the log's times nulled). Two fixture mistakes were the test's, not
the code's: the milestone is not the oldest entry, and `logAt` counts from the
oldest, not the newest.

## trade.11 — 2026-10-20 — Scarcity tags in the readout

W5, readout only — no prices, no credits (F4 stays deferred). Each resource in
the yields block now carries one mark: `!` scarce (`demandOf > 0`), `+` surplus
(`exportableOf > 0` and no demand), `' '` fair, with a `+ surplus · ! scarce`
legend on the row. The port line gained `best export <r> · worst import <r>`,
both weighted by `RESOURCES[r].worth`, so the one-glance market and the routing
score agree about what matters.

Validated: `trade-test` §22 — a stocked port is never scarce, a surplus only
appears with actual spare stock, an empty port is scarce on food and volatiles,
a resource with no draw is fair, and scarcity is monotone in stock and clamped to
[0, 1].

## trade.12 — 2026-10-20 — Expansion can be stood down

The network had one pace and no switch. W6 adds `expansionOn` to the trade
module: `setExpansion`, `expansionArmed`, and `portReadiness(net, index, time)`
returning `small` / `starving` / `resting` (with `nextIn`) / `live` / `outpost`
plus a `why` word. The tick's `room` is 0 while disarmed — freight still flies,
deliveries still arrive, ports still grow — so standing down colonisation no
longer means stopping the economy. `launchBest` refuses with `expansion is off`,
and the panel's Send button disables.

The panel gains `Expansion armed` (`trade-expand`, default on, preset field
`tradeexpand`), and the colonisation state string's nested ternaries became
`colonisationWave(full, readyNow, status)` — one named function instead of an
expression that had already been mis-parenthesised once.

Validated: `trade-test` §23 (disarmed: no founding, deliveries still rise; the
reason string; re-arming founds on the next tick; the five readiness states) and
`preset-test` 30/30. Adding a preset field means editing the SETTINGS fixture and
the defaults fixture in `preset-test` or four checks fail — that is the tax.

## trade.13 — 2026-10-20 — The player can found a colony

W3. `playerFound(net, ref, starName, system, now, out)` puts a colony on the best
world of the star the ship is docked at, through the same `pickBestSite` /
`fillPickedSite` / `addPort` path the network uses. It is free: the player is the
catalyst, not an owner. Its five refusals are the panel's vocabulary — already a
colony, an outpost (which is never revived), an expedition already bound for it,
network full, no world worth settling.

`addPort` now takes a mode (`ROLLED_FOUND` / `FRESH_FOUND`): a galaxy-rolled world
invents an age and a population, a founded one starts at its grant. The
expedition's founding lost its own stock loop and pop assignment to
`economy.foundColony`, so both paths share one record shape and one grant; the
settle then carries the new world forward without a discontinuity.

Flight panel: `Found colony`, enabled only while docked on a star with no live
colony. The founding lands a typed `colony` asset in the asset history, exactly
as docking lands a `dock-port`.

Validated: `trade-test` §20 — a real founding (45 % stock, `popLevel 0`, founded
= last = now), the log line, every refusal on its own fixture, and a
field-by-field comparison of the player's colony and an expedition's (identical
keys and identical stock fractions; the first version compared `stock/cap` with
one cap for both sites and failed, which is the test's bug, not the law's).

## trade.14 — 2026-10-20 — The colonial panel is a list you can click

W7. `#trade-list` and `#colonisation-list` became `div.trade-rows` of real
buttons. A colony row selects its star through the same `handleStarPick` +
`orbitPrimary` / `setFlightDestinationFromPrimary` path H uses — the ship never
moves — and carries `data-port` (the index), not a reference. The row set is
rebuilt only when its identity changes (`count:portKey…`), the text refreshes at
the panel's 4 Hz, and non-live rows show the W6 readiness word where the growth
mark would be. The sailing hulls are one footnote under the rows, not a pseudo
colony.

The frontier rows carry an explicit Send (`launchChosen(net, port, candidate,
time, rush)`), the per-port version of the single button: it re-checks every
index a stale row could hold — gone port, gone world, settled world, reserved
world, outpost, readiness, the two caps, the disarmed authority — and then runs
`launchExpedition` with the same cost and cooldown.

One plan correction: the asset history is two slots, so a simulated founding
does **not** land a `colony` asset. At the top of the clock the network founds
every few hundred milliseconds and would overwrite whatever the player was
looking at; at ordinary rates the entry would be stale before it could be read.
Simulated foundings are the log's and the row set's job. `trade-2-plan.md` §8 now
says so.

Validated: `trade-test` §24 — unique port keys, a resting port refused without a
rush and launched with one, stale port/candidate indices refused instead of
throwing, a reserved world and a settled world refused, an outpost refused, and
the disarmed authority refusing the row.

## trade.15 — 2026-10-20 — The queue's next events are on the panel

W8. `exec-queue.peekNext(queue, outTime, outKind, outRef, outRevision, count)`
answers "what fires next" without popping: the k smallest entries of a heap
cannot sit deeper than level k − 1, so copying the first `2^k − 1` quadruples
(255 at the cap of 8) and partial-selecting them is exact. The heap is untouched,
nothing allocates after the first call, and the revision column travels with the
row — `trade.nextEvents` drops a booking whose ship has been re-timed since, so a
turned-around voyage cannot appear twice.

`#trade-calendar` shows four rows (`+12 y arrive Vega · clipper · ore`,
`+40 y load Fomalhaut · clipper`, `+25 y tick colonisation check`), built at
4 Hz. Two test bugs worth remembering: the `drainUntil` fixture takes the queue
object, not the network, and `nextEvents` reuses one row scratch — a test must
snapshot what a call said before calling again.

Validated: `exec-queue-test` 8/8 (three new checks: order equals a drain's order
on 300 entries, 10 000 peeks leave the root and the arrays untouched, the count
is clamped and an empty queue returns nothing); `trade-test` §25.

## trade.16 — 2026-10-21 — Belts are the easiest mine, giants the worst

W4, the item that touches every number downstream of the yield table.

`economy.systemComposition(system, out)` counts the system in one pass — rocky
(rock or super, not ice), giants (the generator's own `giantCount`), belts,
terrans, habitable-zone worlds — and `fillPlanetSite` / `fillBeltSite` write the
five counts onto the site. `copySite` carries them, so a candidate and a colony
keep the composition of the system they were drawn from, and the cost is paid at
discovery and inspection (one short pass over ≤ 14 planets), never in a settle.

`supplyFactor(r, site)` turns the counts into four family multipliers (mined,
gathered, grown, made) over the unchanged star situation, capped per count so a
system with twelve rocky worlds is not twelve times one with a single world. The
table edits are the plan's: belts 1.60 ore / 1.10 rare / 0.80 robots / 0.10
compute, heavy planets 0.10–0.15 robots. Rock columns and habitat values are
untouched — a belt must win on merit.

The readout gained one line: `system 4 rocky · 2 giants · 1 belt · 1 terran ·
2 HZ`, so the player can see why a world makes what it makes.

Re-measured (the fixture of §16, 60 s of frames at 100 y/s, the page's 300k
field): 8 / 11 / 16 / 27 / 32 / 44 / 50 / 56 / 63 / 64 ports at 5…50 s — the
same curve as before within a port, so the acceptance windows hold unchanged.
Median coverage 0.49 (was 0.47), minimum 0.31, zero outposts, population 0.1 →
11.2 B, 4.2–5.3 M units hauled by 90 s across seeds 42 / 7 / 1234 / 4242 (the
four now agree at every sample: the start map and the field are fixed by the
model seed and the frontier takes the nearest systems rather than a random
draw). Generation mode 22 / 33 / 41 / 53 / 61 / 64. `trade-plan.md` §2, §2.1 and
§8 updated with the measured tables.

Validated: `trade-test` §21 — composition matches a hand count of the generated
system, the site and its copy carry it, a terran system moves the grown family
only, six rocky worlds out-mine one and sixty do not beat six, giants favour the
gathered family, a belt beats the best planet column by ≤ 1.5×, a rock world
out-makes a giant on robots while the giant out-makes it on volatiles and
chemicals, every resource still has a productive world type, and every yield over
a 400-system sweep stays inside [0, 2.5].

History note (2026-10-21): this commit carries the *content* of trade.9–trade.15
as well. The sandbox's Git state was reset between turns, so those commits and
their messages are not in this branch's log; the working tree was intact, so the
code and the tests are the shipped ones and the entries above remain accurate
about the work. A reader looking for `trade.9`…`trade.15` will find their diffs
inside `trade.16`'s tree, not as separate commits.

Next: W9 (the overlay's outpost pass is in; the dashed starvation alarm and the
route layer are not) and W10 (standing routes, the last trade-2 item, which
touches the load decision). Then the trade-3 series (T1–T5, `trade-3-plan.md`),
which re-pins growth the way W4 did. The browser pass over the new panel rows,
the calendar and the composition line is still open — `deferred-browser-visual-plan.md`.

## trade.17 — 2026-10-21 — Commissioned routes as player intent, and W9's last pass

W10 (and with it W9). The old branch's one real player lever is back, re-expressed
so it cannot corrupt routing: **a route is data a load decision reads, never an
event source**.

`net.routes` (created with the network) holds up to `MAX_ROUTES = 32` slots of
`{ origin, dest, active, lastDepartY, nextDepartY }`. `commissionRoute` validates
both ends (a real port, not the same port, neither an outpost), refuses a
duplicate in either direction, and does **not** splice: a cancelled route keeps
its slot and its pair, so re-commissioning revives it and the panel's row identity
never moves under a click; a different pair takes the first free slot. Cancelling
is a flag, and a hull already at sea keeps its voyage.

`pickDestination` grew one optional `preferFrom` argument (the plan's design): the
commissioned destination is returned first *only if* it has demand for the good
and the hull can meet it, otherwise the global scoring runs unchanged. `pickExport`
passes `1`. `loadAtPort` calls `noteRouteDeparture`, which refreshes the row's
`lastDepartY`/`nextDepartY` — bookkeeping, not a schedule; `routeLegYears` is the
estimate, at the bulk hull's pace, and nothing is ever pushed to the queue for a
route.

UI: two selects and **Commission** under **Routes**, one row per active pair with
`next +N y` and a `✕`, refusals shown as the row list's note. The overlay draws a
dimmer, steadier teal edge for each active pair, behind the per-hull chords, so
the standing network and the voyages read as two layers.

One plan correction: the slot law. The first implementation only searched for a
never-used slot, so a cancelled pair could not be revived in place. The rule is
now "same pair → its own slot; else first inactive; else grow", and
`trade-2-plan.md` §11 says so.

Validated: `trade-test` §26 (a commission changes neither the queue size nor the
forward calendar; the log line; duplicate/either-direction, self, bad index and
outpost refusals; the preferred destination winning and falling back; cancel and
revive in the same slot; the estimate refreshed from either end; a port with
nothing spare cannot be preferred into shipping). `exec-queue-test` 8/8,
`m1-smoke`, `export-parity`, `preset` 30/30, `scripts/run.py changed` 12/12.

Next: the trade-2 series is complete except the browser pass. Trade-3 (`T1`,
`trade-3-plan.md`) is the following series, and it needs W1/W3/W4/W5 — all
shipped. Before starting it, the panel is worth one visual pass: three new blocks
(rows, calendar, routes) and two overlay passes have never been seen in a browser.

## trade.19 — 2026-10-21 — Bulk stays home, specialists ship

T1, the first item of `trade-3-plan.md`, and the cheapest one in the series: it
changes what an inter-star hull may *load*, not what a world produces.

`RESOURCES` gained the two routing maps the plan asks for — `intraFamily`
(resource / product / passenger, the flows T4 will simulate) and `interFamily`
(rare elements, specialist chem, antimatter, food & seed, factory cores,
information, passengers), both `-1` for "not in this tier". Ore and volatiles are
intra bulk and nothing else. The authored `family` column is untouched, as §0.1
required: it is the production family, not a routing decision.

The filter lives on the two loaders — `pickExport` (fleet) and `playerExport`
(the player's hold pick) — and nowhere else. That is the whole point of the
review correction that pre-dated this commit: `worth` still reads 0.25/0.30,
`exportableOf` still means "spare stock", and the intra tier the same numbers
feed is not silently zeroed. Unloading has no filter at all, so a hold loaded
before this law (or in-system) still empties.

The readout follows the law: `best export` is a shipping good, and `sells` names
the shipping *families* with something to load (a hull chooses a good, the panel
reads a family) while `needs` stays by resource, because an import is a specific
good.

Validated: `trade-test` §27 — bulk keeps its worth and is never a shipping
family, all seven inter families and all three intra families have members, a
port whose only surplus is bulk offers no star-port cargo, a hull that arrived
with ore still unloads it, and a resource nobody draws is `fair`, not scarce.
`m1-smoke`, `export-parity`, `scripts/run.py changed` 8/8.

Next: T2 (the fold — one inter-star port whose market is the sum of its worlds),
which is the structural item; T3 depends on it, and T4/T5 after that. The
browser pass over the trade-2 panel is still the open non-code item.

## trade.20 — 2026-10-21 — A star is many worlds and one port

T2 + T3 (`trade-3-plan.md` §4 & §5): every settled body is now a world in a
preallocated pool (`net.worlds`, length `MAX_WORLDS = 384`, up to
`MAX_WORLDS_PER_STAR = 6` per star), and each star exposes a single inter-star
port whose `port.colony` is the aggregate of its live worlds.

**Economy layer (`src/core/economy.js`).** Colony records carry `access`
(default `1`, ready for T4's `lift · intraCoverage`), `INTER_FAMILY_SHORT` adds
the seven short market labels, `interFamilyTagOf(colony, interFamily)` extends
W5's four-band ratio over inter-star shipping families (`0/0` is `fair`), and
`foldColonies(out, worlds, count)` aggregates up to 6 worlds without allocating:
single-world ports copy bit-for-bit (`count === 1`), while multi-world folds sum
`pop`, `capacity`, `stock`, `stockCap`, pop-weight `outBase`, `coverage`,
`growth`, `access`, and production-weight `yield` so a rare mine on a small belt
is never hidden by a fertile sibling's population. `distributeInbound` and
`collectOutbound` water-fill world warehouse caps and `25%` export floors in at
most `count` passes with zero heap allocation, conserving mass across capped
warehouses, zero-demand unloads, and `lift`-taxed exports while never raiding a
deficit world's reserve.

**Trade & UI layers (`src/core/trade.js`, `src/main.js`).** Each port carries
its preallocated `fold` colony, `worldIdx[6]`, `worldCount`, and 6×6 intra
matrices (`well`, `land`, `lift`, `access`, `dv`, `tH`, `couple` — identity
until T4 fills real system geometry). When `worldCount === 1`,
`port.colony === net.worlds[port.worldIdx[0]]`, keeping single-world ports
bit-identical (`Object.is`) with zero fold cost; adding a 2nd–6th world binds
`port.colony = port.fold` and folds on settle and after transfers. `settlePort`
advances all non-outpost worlds to `now`, keeps the port live while at least one
world lives, and demotes the port once all its worlds fail. Freighter loads/arrivals,
player loads/unloads, expedition volunteer draws/returns, and generation-mode
reserve scaling all route through world-level helpers and refresh the fold.
`playerFoundWorld` extends W3 in system view so selecting a planet or belt and
clicking Found adds a world to the star's port (or opens the port on that body
if unsettled), enforcing `MIN_FOUND_COUPLE` and all §5.2 refusal reasons without
ever taking a second port slot. When system view is closed, `#sysread` shows the
compact 3-line summary (`trade ... · access ...`, `system ...`, `market ...`);
opening `V` expands `worlds` above the 13 yield rows. Also fixed `syncFlightUi`'s
docked export hint to respect T1's `interFamily >= 0` filter.

**Validated.** `trade-test` §28 (`245/245`): one-world `Object.is` identity,
`addPort` non-duplication, all five `playerFoundWorld` refusals, two-world fold
weights, inbound/outbound mass conservation (including warehouse cap overflow,
zero-demand fallback, and deficit-world reserve protection), partial vs total
collapse demotion, 600-year live-fleet jump conservation, inspection idempotency,
and 7-family tags. `changed --logs` 6/6 (`2.0 s`), `view-tests + world-tests`
26/26 (`20.8 s`).

Next: T4 (`trade-3-plan.md` §6 — the intra-system layer: well/landing/lift
physics on `port.dv`/`port.couple`, intra demand/supply closure, `world.access`,
and the non-circular `settlePort` fixed point) followed by T5 (intra routes on
the `#system` schematic and the intra section on `#sysread`).

## trade.21 — 2026-10-22 — Intra flow is a delta-v statistic

T4 (`trade-3-plan.md` §6). The port's preallocated 6/6×6 buffers now carry
physical geometry rather than identity placeholders. `fillIntraGraph` builds
the same DeltaV body and directed Hohmann edge tables as the map at founding,
stores surface `well` / aerocredited `land`, `dv`, `tH`, `couple` and `lift`,
and derives live-world access. Giants/cloud habitats have no surface climb;
the diagonal alone is zero-distance. `deltav.dvSurfaceToSurface` is the thin
shared chain used by the Earth→Mars pin (16.02 km/s with aerocapture), not a
second physics implementation.

`settlePort` is deliberately non-circular: capture each live world's family
supply, demand and start-of-interval coverage; run every local closed-form
settle once; apply one simultaneous couple-weighted transfer capped by remaining
exportable, warehouse room and population room; refresh access; fold. Bulk and
manufactured goods move by member resource, while passengers move population,
never the colonists warehouse stock. A same-clock call preserves stocks,
population and the last flow exactly. Star-port collection applies `lift` to
each world's exportable, and second-world founding ranks habitat by physical
couple and well cost. No intra event enters the inter-star queue, and closed
systems settle exactly like opened ones.

Validated: `trade-test` §29, now **262/262** for the whole suite — bit-exact
repeat graphs and direct DeltaV equality, the Solar surface pin, near/far belt
flow and mass conservation, Hohmann-time independence, same-clock fixed point,
positive bulk/goods/passenger closure, passenger starvation refusal, one-world
zero flow, deep-well versus belt lift, founding score/refusal and an unchanged
queue calendar. `dv-map-test` **38/38**, `exec-queue-test` **8/8**. Review also
added the missing positive goods and passenger pins; both passed without
weakening a tolerance.

Next: T5's schematic markers/dashes and `#sysread` card, plus a real input path
for founding the second world that makes those flows visible.

## trade.22 — 2026-10-22 — The opened system shows its worlds, flows and km/s

T5 (`trade-3-plan.md` §7). `system-layer.setTradeData` binds only the opened
star's port and world pool. The schematic draws the shared population/growth
markers for every world, grey outposts and dashed amber starvation alarms, then
at most three dim cargo-coloured dashes for the largest last-settle flows.
Ranking and scratch are preallocated; closed-view draw remains a single return.
`main.js` feeds the references at readout cadence, and `#sysread` adds worlds,
intra direction/family/km/s/couple/Hohmann, per-world lift and the inter market.
These are ambient statistics, not a second fleet.

Review caught an integration hole left by T3: sibling founding existed only as
an API because Found requires docking while V was game-gated, so real play had
no way to create a multi-world port. The docked exception now opens only the
station's schematic with no camera movement, disables its route controls and
closes on undock or an incompatible hull switch. Discovery, body selection and
the trade card use the opened station key rather than assuming it is still the
galaxy primary; a successful founding refreshes the picture immediately. The
ordinary flying/observer camera contract remains unchanged.

Validated: `system-layer-test` **60/60**, including matching-star gating,
marker/alarm counts, three-flow drawing and 1,000 allocation-free frames;
`m1-smoke-test` **114/114** with a static wiring pin for the docked no-camera
path; `input-test` **21/21**, `ship-test` **123/123**, `panel-test` **11/11**,
and the T4 suites above. `scripts/run.py changed` passed **8/8** and the
combined world/view domains passed **26/26**. `node --check` and
`git diff --check` pass. No real-browser visual verdict is claimed; V13c
records the marker/dash/card, matching-km/s and docked-founding checks.

Next: run V13c in a browser on real hardware. T6 (a real intra fleet) stays
deferred and, if scheduled, must bring its own system clock and queue rather
than reusing the galaxy heap.


## trade.23 — 2026-10-28 — A colony needs a star that has formed

The user's second reported defect, and the same mistake as the constellation
one (`archive/ui.x-worklog.md`, ui.22): the network seeded from the *reference*
census, so a run at first light — the field all gas, not one procedural star
condensed — still arrived with four colonies and a fleet already sailing between
stars that do not exist yet. `startSystems` walked the landmarks and the field's
near stars with no epoch in sight, and `expandFrontierFromField` proposed worlds
the same way.

**The gate.** Both paths now read the field's own birth channel — the same one
the vertex stage's formation gate reads — through one helper:

```js
function fieldFormed(field, index, age) {
        const births = field ? field.birth : null;
        if (!births || index >= births.length) return true;
        return orbit.gateAt(births[index], age) > 0;
}
```

`renderer.fieldBuffers()` already carries `birth` (the renderer fills it from
`starTypes.sampleFieldBirth` on every field draw), so no new data is threaded
through: `trade.js` gains `orbit.js` and `named-sky.js` as dependencies and the
seed map gains a per-candidate test. A field with no birth channel keeps today's
behaviour, which is what every pre-existing fixture passes.

The curated named stars are gated by `NamedSky` rather than by the field: they
are today's sky, so outside its epoch window they are not there to settle
either. That is why `core/named-sky.js` loads before `core/trade.js` in
`index.html`.

**What the measurement said before the test was written.** The first version of
the new check asserted that a 1 Gyr epoch would seed a *smaller* local sky, and
it failed with zero candidates — which turned out to be the module being right
and the test being wrong. Measured on the page's own 300k sample, the earliest
birth within the seed radius of home (`model.home.orbitTarget` = `[0,0,0]`, the
galactic centre) is **1.367 Gyr**, so at 1 Gyr there is no local sky at all:

| age (Gyr) | formed of 300k | near home (1.2 kpc) | of those, formed |
|---|---|---|---|
| 0 | 0 | 1 019 | 0 |
| 1 | 2 735 | 1 019 | 0 |
| 2 | 13 701 | 1 019 | 12 |
| 3 | 30 634 | 1 019 | 34 |
| 5 | 104 717 | 1 019 | 219 |
| 13.5 | 299 888 | 1 019 | 1 016 |

The test now uses 3 Gyr as "young" and pins the 1 Gyr case as *empty*, which is
the stronger statement anyway.

**Validation.** `trade` **287/287**, with the new §5b block: the fixture carries
a finite birth channel inside the model's span; first light seeds an empty map
and the network arrives with `portCount === 0`, `shipCount === 0`,
`worldCount === 0`; running that empty sky for 5 000 years still founds nothing;
a 3 Gyr epoch seeds from the local sky it has, every settled field star has
`birth ≤ 3 + BIRTH_FADE_GYR`, and the seed count is strictly below the
reference epoch's; the present-day sky still seeds its colonies; and with no
field the named sky alone settles the capital at `AGE_REF` but nothing at first
light. `changed` **21/21**.

An evolving run from first light therefore starts with no economy, which is
correct but bare: `expandFrontierFromField` needs a big colony to measure reach
from, so an empty network never bootstraps itself. The honest fix — the network
seeds itself the first time its home sky has stars — is a main.js retry, not a
trade.js change, and is recorded on `deferred-open-work.md` rather than guessed
at here.

Next: T6 (`trade-4-plan.md`) — the intra fleet this slice's gates make
meaningful, since a fleet needs stars that exist.

## trade.24 — 2026-10-28 — The sky gate: a colony needs a star *now*

The user's second report, and the half of it `trade.23` did not close: *"trade
colonies also exist in all modes even when no stars should be — it spawns it."*
The seed gate stopped a cold boot from settling unformed stars. It could not stop
the other half, because the network is seeded **once per galaxy**: boot in the
present-day Milky Way, then drag the epoch to first light, and the four seed
colonies keep their ports, their stocks, their hulls and their rings on stars the
frame has already hidden. `NamedSky` gated the *sprite*; nothing gated the
*colony*.

Reproduced before it was fixed (`experiments/trade-test.js` §5c): the reference
network seeds four landmark ports at `AGE_REF`, and `applySkyGate` at first light
reports `SKY_NONE` with `skyVisiblePorts === 0` — while every ring, route and
hull kept drawing. The same probe on a procedural galaxy at 8.5 Gyr sees exactly
one of four field ports, whose measured births are 13.42, 7.74, 12.16 and 13.31
Gyr.

**The law.** `refInSky(ref, model, field)` is the one predicate, and it is the
same channel the vertex stage reads: landmarks → `namedSkySettled` (the curated
sky is today's), field → `fieldFormed` (the birth channel), everything else →
present, because the epoch map does not gate those blocks. `applySkyGate` stamps
`port.skyVisible` and `candidate.skyVisible`, counts the visible ports and
returns `SKY_ALL` / `SKY_SOME` / `SKY_NONE`. It is state, never a record rewrite,
so the same scrub forward restores the same network — which is the property that
makes it safe to run every frame.

**No phantom growth.** A hidden port is not settled (`settlePort` returns 0), and
the interval it was hidden for is not integrated when it comes back: the gate
stamps every world's `last` on *both* edges of the transition. Without that,
scrubbing to first light and back would pay four gigayears of growth into one
settle — the clock would be spent by a sky it never saw. That is pinned as a
check, not assumed.

**The surface follows the gate.** The label layer skips a port, a route, a hull
whose endpoints are not both in the sky, and a frontier mark whose star is not
there; `tradeDrawn` requires at least one visible port, so a wholly hidden
network draws nothing at all. The Trade panel's colony rows, the H block's
target, the `#sysread` trade card and the schematic's port data all read the
same flag. A landmark port follows `NamedSky`'s *own* verdict including the star
clock's rate, so a sky too fast to read hides the sprite and the colony together
— the ring on a star nobody draws is the same defect in another colour.
`skyGateText` says *"trade paused · no colony's star exists at this
epoch"* or *"trade 1 of 4 colonies in this epoch's sky"* — a paused network is
not an empty one, and the panel says which. When nothing is visible `main.js`
stops the trade clock instead of simulating a sky nobody can see.

**A fixture lesson.** The first version of the partial-visibility check asserted
that a *3 Gyr* epoch would show some of the four ports; it showed none, because
all four were born later. The 8.5 Gyr epoch is the one that sees exactly one, and
the test now pins that with the measured births written beside it. The other
false start was mine as well: `skyVisiblePorts` defaulted to 0 on a freshly
created network, so every label-layer fixture that never calls `applySkyGate`
drew nothing — fixed by adding the count in `addPort`, with the layer treating a
missing count as "all visible".

**Validation.** `trade` **300/300** (§5c added 11 checks, including the rate
gate), all-tests 46/46.

## trade.25 — 2026-10-28 — T6: the intra fleet has hulls, a class gate and a clock

`trade-4-plan.md` was written as a design and indexed as deferred. This slice
builds it: inside an opened system, the mass T4's couple priced is carried by a
hull that can actually fly the leg, on the network's own queue, priced by the
delta-v graph T4 already filled.

What shipped, against the plan's §8 order:

1. **The hulls and the gate.** `INTRA_HULLS_MAX = 12` per port, allocated on the
   first open and never again. `intraClassFor(dv)` is the engine requirement made
   concrete: iterate `deltav.SHIP_CLASSES`, keep `domain === 'in-system'`, take
   the cheapest whose budget covers `dv × 2 × 1.1` (round trip plus reserve).
   Measured: 3 km/s → `chemical`, Earth–Mars 16.02 km/s → `nuclear`, 25 km/s →
   **none**. A pair no class can fly books no hull, is marked `unserved`, and
   keeps T4's instantaneous transfer — so "respect the available engines" never
   becomes "quietly stop the economy".
2. **The booking.** `applyIntraFlows` already computes the exact mass per
   `(source, target, family, resource)`. When the port is online, `bookIntra`
   takes what the twelve hulls can hold and the settle credits only the rest.
   The quantity law is untouched: the fleet can move what the couple priced and
   nothing else.
3. **The arrival.** `EV_INTRA_ARRIVE` on `net.intraQ`, `ref = port × 12 + hull`.
   It is the only place an intra cargo becomes stock again. Twelve hulls of
   `class.cargo` is the per-settle capacity, so a busy system degrades toward T4
   rather than losing mass.
4. **The contract.** 5 000 years with the view open and closed lands the same
   world stocks to **0.84 %** at the app's year cadence. At a coarse 10-year
   cadence the same comparison is **6.6 %**, because the leg is then 5 % of every
   interval — the tolerance is pinned from the fine measurement and the coarse
   one is recorded in the plan rather than swallowed.
5. **The surface.** The schematic draws every loaded hull on its leg by the
   network's clock (`intra.clock`), pale rim + amber dot, over the T5 dashes that
   stay as the average. `#sysread` gains the `fleet` block — `class · family ·
   src → dst · km/s · remaining years · tonnes`, four rows plus `+n more` — and
   the Trade panel gains `intra n/12 flying` while a system is open.

Deliberate deviations from the plan, both recorded in `trade-4-plan.md` §0:

- **One clock, not two.** The fleet rides the network's trade clock, not the
  schematic's `SYSTIME` ladder. The schematic can run at 1e-4 y/s while the
  economy runs at 2 000 y/s; giving the fleet the ladder would mean the hulls
  and the stocks disagreed about when a leg happened. The hulls are drawn *as
  of* the network's clock, which is the clock that paid for them.
- **A close does not strand a cargo.** The plan's "the hull keeps it and
  `settlePort` withholds the pair" assumed a fleet on its own clock. Here the
  queue belongs to the network, so an in-flight cargo lands on its arrival time
  whether or not anything is looking — simpler than withholding, and pinned by a
  check that closes the view mid-leg.

`bookIntra` needed the port index, which `applyIntraFlows` had been looking up
with `net.ports.indexOf(port)`; the parameter replaced the search. The queue
handler also had to be bound per network (`net.intraHandler`) — the first version
passed `intraHandler` straight to `drainUntil`, whose signature is
`(time, kind, ref, revision)`, so the net arrived in `time` and no arrival ever
fired. The test caught it as "inFlight 3" after 40 years.

**Validation.** `trade` **310/310**: the class gate (including "no interstellar
class is ever offered"), one settle online vs offline, every loaded hull inside
its own class's budget, the arrival restoring the closed view's totals, the
unserved pair staying instantaneous, 500-year jump == 500 one-year steps on the
intra ledger, the close-mid-leg case, the readout text both ways, and §3's 5 %
contract. all-tests 46/46.

## trade.26 — 2026-10-28 — An empty network seeds itself when the sky allows it

`trade.23` recorded the hole honestly: an evolving run from first light arrived
with no colonies, and stayed that way, because seeding happens once per galaxy
and `expandFrontierFromField` measures its reach from an existing colony. The
deferred row said the fix was a throttled retry in `main.js`, and that it wanted
a decision about whether a colony may exist before the named sky does.

`trade.24`'s gate is that decision: a colony may exist exactly where the birth
channel says a star exists. So `reseedIfEmpty(net, model, field, landmarks, ctx,
record)` re-runs the boot's own `startSystems` / `discoverNearest` and may act
only on a network with **no port, no hull and no candidate** — a live economy can
never be reset by a clock crossing a threshold. `discoverNearest` gained the
founding year (`nowYears`, default 0, so every existing caller is unchanged), and
the retry keeps `net.time`.

It runs in the existing 2 Hz maintenance pass, which is also what keeps it
honest: the first frame the home sky has stars, the network seeds, and the next
frame `portCount > 0` makes the call a no-op.

One expectation was wrong here too: I asserted the re-seeded colonies would be
founded at the current trade year. They are not, and should not be — the seed map
discovers *rolled galaxy worlds*, settled in the past, exactly as at boot. The
check now pins that instead, and says why.

**Validation.** `trade` **316/316** (§31 added 4 checks: first light still finds
nothing; a later epoch seeds; the clock is kept; a seeded network is left alone).
all-tests 46/46 (207 s).


## trade.27 — 2026-10-28 — First colony after first light

The previous retry was behind `rateY > 0`, but `applySkyGate` sets an empty
network to `SKY_NONE`: after the first frame the retry could not run. It also
refused networks with candidates, and `finalize` did not spawn a ship when an
empty network already had a scheduled tick. The test had jumped directly from
first light to the present and bypassed the frame-loop gate.

Early-epoch boots now wait for a bounded, wrapping field scan, independent of
the trade clock. It requires a formed star born after 0.5 Gyr, aged at least
0.1 Gyr, with model Z ≥ 0.008, main-sequence state and a generated Terran
world. The first match becomes a freshly founded capital and gets a starter
ship even with an existing tick. Existing candidates and the clock survive; a
network with any port is never reset. These thresholds are explicitly a gameplay
proxy, not an actual generation or enrichment model. A new **Find Earth-like**
button runs the existing galaxy-scope `state:ms|terran` search and does not
found anything. Search now respects the named-sky gate for hidden landmarks.

**Validation:** trade 325/325 including a real 300k-field formation census
from 0 through 2 Gyr, first match after 27,648 examined records; clock, queue,
candidate, scan wrap, missing births, young/low-metal/no-terran refusals and
hidden port regressions. `changed` 10/10 and `world-tests` 16/16. Browser
layout and experience remain V16, not validated by Node.

Next: check V16 on real WebGPU hardware; chemical enrichment remains low
priority and constellation work remains deferred.

## trade.28 — 2026-10-28 — An empty network says why, and offers the two doors

The user's browser report on trade.27: *"automatic seems can't establish 1st
colony. need to investigate."* It is two facts, one honest and one not.

The honest one is the law. The gameplay proxy needs a star born after 0.5 Gyr
that is 0.1 Gyr old, main-sequence, at model Z ≥ 0.008, with a generated terran
world. A sky younger than 0.6 Gyr therefore cannot contain a single candidate by
construction, and on the Milky Way's reference SFH the first terran world in the
300k field appears around 1.5 Gyr: the reference census is most stars already
old, so a 1 Gyr-old galaxy has a very thin formed population. Measured on the
shipped fixture: 0 eligible records under 0.6 Gyr, ~1 per 13k records at 1.5 Gyr,
and the first match at 1.5 Gyr is record 13 722 of the sweep.

The dishonest one was the panel. It said "searching for a terran home · field
scan N" at every age, including ages where nothing could ever be found, and the
scan itself was 256 records per half second — a 300k field took ten minutes to
close — with a `generateSystem` spent on every record that merely passed the age
gate. That is why "automatic" read as broken.

What changed:

- `reseedIfEmpty` is now two halves. The sweep walks field records and queues
  the ones that clear the birth gates (4 096 records per call, a comparison
  each); the generator drains the queue into systems (128 per call, ~3 µs each)
  and founds on the first terran world. The queue is a preallocated
  `Int32Array(1024)`, compacted on head catch-up, and each queued record is
  re-tested against the epoch before it is generated. On the shipped fixture the
  first capital now lands three calls (≈1.5 s of wall time) after the sky passes
  1.5 Gyr, and a full eligible-free 300k sweep costs a few milliseconds.
- `bootstrapStatus(net, model, field)` is the empty-network line, in order: no
  drawn field, sky younger than `BOOTSTRAP_MIN_AGE_GYR` (0.6, named with the
  current age), the last closed sweep found no old metal-rich star, else the
  window's progress and queue.
- The Trade panel's top is now the task: **Search for a home** (the Search
  panel's own `state:ms|terran` press, extracted to `findEarthlike`) and
  **Establish here** (`commandFoundColony` on the selected star). The block
  shows while the network has no port and hides with the first colony; the
  Colonisation row stays for expansion. The status line moved out of
  `trade-state` into this block, so the clock row no longer carries a reason
  about a clock the network cannot use yet.
- The player's doors obey the sky gate. `playerFound` and `playerFoundWorld`
  take the caller's `refInSky` verdict and refuse a star outside this epoch's
  sky; before this, the new button could have founded a colony on an unformed
  star that no frame would ever draw.

**Validation.** trade **334/334** (§32 added 9 checks: the four status lines, a
full 300k eligible-free sweep's cost and queue, the progress window, the first
capital within eight app-cadence calls at 1.5 Gyr, and both player doors'
sky refusal). panel 16 checks, quick 36/36, changed 9/9. The buttons themselves
remain a V16 browser verdict — Node can pin the ids, the wiring and the law, not
that the row reads well on a 1280×800 panel.

## trade.29 — 2026-10-28 — The network is drawn in a frame that runs away from it

Two reports in one message. The small one first.

**1. "I don't see Search for a home."** Correct, and it was my condition's
fault: trade.28 put the two presses in a block that only appeared while the
network had **no port**, and a present-day boot always has its four seed
colonies — so the row never showed. The row is now permanent and only its reason
line belongs to the empty case (it starts `hidden` and appears when a network has
no port). The ids, the wiring and the two shared laws are unchanged.

**2. "Colonies established across the galaxy with long routes across the whole
galaxy — seems a stars position bug… it was a long before and an agent told it
was fixed, but seems an architecture flaw."**

It is not a coordinate mismatch. Every port's ring resolves through the *same*
dispatch the sprite is drawn with (`orbit.engineRecordPosition` /
`engineLandmarkPosition`, the record's own packed word), so a ring sits on its
star to the bit; the network's own data is consistent too (no NaN, no stale
`ref`, `addPort`/`addCandidate` copy every ref by value, the seed map's four
ports sit 4–79 ly out with a widest pair of 103 ly, and a 12 000-trade-year run
on a frozen sky spans 1 452 ly from home — 600 ly founding hops, five deep).

What is wrong is the **frame**, and it is the thing trade.18 left open. A colony
is a star; a star's drawn position is its orbit at the *running* star time; and a
solar-circle star sweeps 0.22 kpc per wall second at the app's default 1 Myr/s.
So a network that does not change at all is drawn walking across the galaxy:

| star clock | 10 s | 30 s | 60 s | 300 s |
|---|---|---|---|---|
| 1 Myr/s (default) | 7 619 ly | 22 227 ly | **40 416 ly** | 48 846 ly |
| 0.3 | 2 295 | 6 862 | 13 606 | 51 272 |
| 0.1 | 768 | 2 295 | 4 583 | 22 227 |
| 0.03 | 237 | 692 | 1 379 | 6 862 |
| 0.01 | 96 | 237 | 463 | 2 295 |
| 0 (frozen) | 79 | 79 | 79 | 79 |

(farthest drawn port from home; `experiments/network-frame-study.js`, the shipped
300k field, the shipping dispatch. The four seed colonies — Rigil Kentaurus b at
4 ly, Fomalhaut b at 25, Capella at 43, Regulus at 79 — are each drawn ~39 000–
40 400 ly from home after one wall minute.)

And the two clocks are incoherent by default: at 100 y/s of trade the bulk
freighter crosses 200 ly per wall second, while the sky's rotation at the Sun's
radius is 734 ly/s at 1 Myr/s — **the sky outruns even the fastest hull by 3.7×**,
which is why routes tear as fast as they are flown and why every decision the
network makes is a decision about a map that is leaving. At 0.1 Myr/s the same
sky runs 73 ly/s and the hull outruns it 2.7×; that is the pairing trade-plan §6
calls "the one the network is tuned for" — the page's default is 10× off it.

trade.18 measured exactly this and fixed the *economy* half (scoring, booking,
re-timing and the caps all read drawn positions, and a torn hull is turned
around), which is why it was reported as fixed. It deliberately left the picture
and closed with an open decision: *"whether the page should default the star
clock to a slower rung while the trade network is live — at the current default
the network's geography is stretched 4× inside a minute, which is honest but
reads as a network winding up."* That decision was never taken, so the reported
symptom is still on screen and is now measured rather than described.

**Not fixed here.** The remedy is a product decision with three shapes, recorded
in `deferred-open-work.md` as the open row it is:

1. **Co-rotate the display frame** with the disc (render `−Ω_ref·t` in the orbit
   lanes and their CPU mirror). The sky then turns only by differential motion,
   and a colony network is stable by construction — the architectural fix, and
   the largest: `orbit.js` + WGSL + labels + picking + the epoch lanes.
2. **Slow or park the star clock while the network is live** (the cheap version:
   the authored 0.1 Myr/s pair, or freeze on the command workspace). Small and
   immediate; it takes the app's own signature motion away while you manage
   colonies.
3. **Draw the trade layer in its own frame** — the birth-frame map — and stop
   resolving rings through the moving sky. The network becomes a stable strategy
   map, hulls stop tearing, and the rings are no longer on their stars; §9's live
   geometry would then be needed only for the flying pilot's own view.

**Validation.** panel 16 checks (the row's permanence and its hidden reason line
are now pinned), changed 9/9, trade 334/334 unchanged. The study is a study: it
prints, it does not pass or fail.

## trade.30 — 2026-10-28 — Reach: the pair goes out of reach, the voyage finishes

The user took the decision trade.29 left open, and took it as neither of the
three structural remedies: *"we need finish started travel and disable route
when distance become too big"*, with the star clock kept at 1 Myr/s. So the sky
keeps moving, the rings stay on their stars, and the economy answers the way a
player would — if the stars are that far apart, trade there is impossible.

**The law.** `refreshReach(net)` runs after every geometry refresh (from
`finalize`, `commissionRoute` and `retimeRoutes`) and measures in the one frame
every distance in the network is measured in, the *drawn* positions:

- a route is in reach iff `endpointDistanceLy(origin, dest) ≤ MAX_LEG_LY`
  (3 000 ly). Out of reach: the row says `out of reach · N ly` in the
  `is-unreachable` colour, the overlay stops drawing it, no hull books it
  (`planLeg` already refuses), and `routes.unreachable` counts them.
- a candidate is in reach iff it is within `MAX_FOUND_LY` (600 ly) of **some**
  live port. Otherwise it is stranded: no expedition scores it, its dot is not
  drawn, `strandedCandidates` counts it, and the colonisation row says
  `N free worlds have drifted out of reach`.
- a voyage is always in reach. It finishes.

**Voyages finish.** `retimeRoutes` no longer treats distance as a give-up: the
old `DIVERT_FACTOR` turn-around (and its `legTo = 0` flight home) fired on the
*solve's* runaway signal, which is exactly what a stretched leg raises — the
fleet spent its life sailing home from routes the sky had already closed, which
is what a viewer read as ships wandering. Now:

- the only divert left is geometry: `planLeg`'s `outrun`, a target that recedes
  faster than the hull flies, which is the one thing a booking cannot argue
  with. A diverted hull still goes home (freighter with cargo, founder with the
  volunteers refunded to the source's population).
- a chord drawn past the cap is not re-solved at all — `ship.arrive` keeps the
  arrival its departure was given, so the hull lands at the port it set out for
  instead of chasing a star that is leaving.
- inside the cap, re-timing is unchanged (§9.4).

**Founding.** `foundAtCandidate` refuses through the same law at the arrival
event: if the world is drawn past `MAX_FOUND_LY` of the party's home when the
hull docks, the party is refunded (`returnFounder`) instead of planting a colony
no route can ever serve. That closes the last way a colony could appear across
the galaxy from its network.

**The frontier keeps growing.** A full pool of 224 candidates used to freeze the
scan; if every one of them has drifted out of reach, that is 224 places no hull
can fly to and a network that stops expanding under a torn sky. `freeCandidateSlot`
returns a slot that is unused, unreserved and `reach === 0`, and `addCandidate`
can now overwrite one, so the scan recycles stranded places instead of stalling.

**The panel.** Commissioning a pair whose drawn separation is past the cap is
refused with a reason (`these ports are out of reach of the fleet`) and the
commission button is disabled while the selection is torn, so the click cannot
become a dead row. An existing row is never removed for being out of reach: the
flags are recomputed from where the stars are now, so the pair resumes by itself
the moment the sky hands it back — pausing the star clock is the quickest way.

**Validation.** trade 346/346 (new §33: the reach flag on a torn pair and back
on a frozen sky, the commission refusal, a voyage that keeps its booking and
docks at its destination on a stretched chord, the founding refund at arrival,
the stranded-slot reuse, plus §17.5/§17.7 rewritten from the turn-around law to
the finish law), panel 16, changed 14/14. `experiments/network-frame-study.js`
is unchanged and still measures the picture winding up; §9.9 records the law and
what it deliberately does not fix (the map still winds up at 1 Myr/s).

---

### trade.31 — Search-for-home and empty-network founding (`src/core/trade.js`, `src/main.js`, `src/index.html`)

Reproduced and closed the multi-gate bug where clicking **Search for a home**,
selecting a planet, and pressing **Establish here** appeared to do nothing while
the Trade panel still showed `No colonies yet.`

- **Mode authority (`canCommandTrade = () => !isFlying()`).** `#trade-menu` sits
  in the shared inner column and is visible in **Observe** (`1`) as well as
  **Command** (`3`), yet `commandFoundColony` returned silently unless
  `isCommanding()` was true and `#trade-found-here` stayed disabled in Observe
  even after selecting a star or planet (`workspace-plan.md` §2 rule 3, §13).
  Trade panel actions now work in both free-camera modes (Observe and Command)
  and refuse with a visible notice in Fly (`dock at a star to found while
  flying`).
- **Stored planet/belt selection & schematic star reset.** Selecting a planet
  from the **Selection** panel (`selectionStore.natural.current`) while system
  view (`V`) was closed did not forward the body into `foundColonyAt`, which
  read `systemLayer` only; when `systemLayer` *was* open, clicking empty space
  in the schematic left `systemLayer` at `BODY_NONE` without resetting
  `recordSystemBodySelection` back to the star. Both paths now stay in sync.
- **Post-finalize inspection near home.** `discoverSystem` checked
  `net.capital < 0 && nearHome` without `!net.tickScheduled`, so opening system
  view on an unseeded young-epoch network near home silently pre-settled a port
  as `ROLLED_FOUND` before the player clicked **Establish here**; subsequent
  star-level founding then failed with `star already has a colony`. Added
  `!net.tickScheduled` so post-`finalize` system inspection discovers
  candidates without auto-founding.
- **First-colony bootstrap & sky gate.** Added `completePlayerPortFound` in
  `src/core/trade.js` (shared by `playerFound` and `playerFoundWorld`) and
  stamped `port.skyVisible = 1` / `net.skyState` in `addPort` so the very first
  player-founded colony on an empty network (`portCount: 0 -> 1`, e.g. at an
  early galactic epoch in `SKY_NONE`) immediately becomes `net.capital`, spawns
  its starter freighter, marks the star discovered, lifts `SKY_NONE`, and clears
  `No colonies yet.` on the same tick. `tradeInspectSystem` also guards
  `discoverSystem` with `refInSky`, and `tradeSeedNetwork` skips reference-epoch
  `startSystems` at non-reference ages.
- **Visible notices outside Fly.** `setAutoMsg` previously wrote only to the
  canvas HUD inside Fly/Command. Added `#trade-action-note` in `#trade-menu`
  (mirrored to the Observe HUD line as well) and expanded refusal messages on
  barren-planet picks so founding outcomes and refusals are never silent.
- **Validation.** `trade` 350/350, `panel` 22/22 (`2/2` via `scripts/run.py`).

---

### trade.32 — Auto-colonising sibling worlds inside settled systems, T8 (`src/core/trade.js`, `src/main.js`)

Shipped **T8** (`trade-3-plan.md` §0): thriving multi-body star systems now
autonomously settle reachable sibling planets and belts inside the same port
without consuming a `MAX_PORTS` slot, allocating per event, or re-running
`PlanetsLib` on the queue tick.

- **Preallocated per-port & per-candidate `sysCache`.** Each port and frontier
  candidate owns a fixed 6-slot (`MAX_WORLDS_PER_STAR`) site and delta-v edge
  cache (`sites[6]`, `well[6]`, `land[6]`, `dvLoToLo[36]`, `tH[36]`).
  `captureSystemSites` fills it whenever a system record is handed to
  `addPort`, `addWorld`, or `addCandidate`; `foundAtCandidate` copies
  `c.sysCache` onto expedition-founded ports and runs
  `fillIntraGraphFromCache` so frontier colonies immediately inherit their
  sibling world candidates and real `DeltaVLib` coupling (falling back cleanly
  to identity coupling when a synthetic test world is absent from `sysCache`).
  Also fixed `createNetwork` to honour `options.seedPorts` (`0` at non-reference
  epochs, `SEED_PORTS` by default).
- **Exact founding law & population conservation (`sponsorSiblingWorld`).**
  `cachedSiblingScore` computes the exact `worldFoundingScore` formula
  (`siteHabitatScore * couple / (1 + candidateWell / DV_REF)`) from `sysCache`
  and `pickSiblingSite` selects the highest-scoring unsettled body clearing
  `MIN_FOUND_COUPLE` (`0.08`). On `EV_TICK`, when `expansionOn` is armed and a
  visible live port clears `SIBLING_COOLDOWN` (`900` y from `addPort` or its
  last sibling wave), `SIBLING_MIN_COVERAGE` (`0.38`), `SIBLING_MIN_POP_M`
  (`8` M), and `SIBLING_CROWD_FRAC` (`0.45` of capacity), volunteers
  (`4 %`, `0.35–2.5` M, capped at half the sibling's capacity) are drawn via
  `takePortPopulation` into `addWorld(..., FRESH_FOUND)`, conserving port
  population to machine precision while leaving `net.portCount` and
  `net.founded` untouched, incrementing `net.siblingsFounded`, and logging
  `LOG_SIBLING`.
- **Panel & system readout.** `tradeReadoutText` appends `siblingReadoutText`
  (`siblings  <site> (<dv>, score <x> | too deep (<x>))`) when `systemLayer` is
  open; `tradeLogEntryText` formats `LOG_SIBLING` (`settled    <world> in
  <port>`); `tradeRowText` badges multi-world ports with `· <N>w`; and
  `#trade-state` reports `(<W> worlds)` whenever `worldCount > portCount`.
- **Validation.** `trade` 358/358 (new §32 covering `options.seedPorts`,
  `cachedSiblingScore === worldFoundingScore`, population conservation +
  `LOG_SIBLING`, sky/expansion/cooldown/`MIN_FOUND_COUPLE` gates, 1200-year
  jump vs 1200 one-year steps equivalence, and expedition-founded port sibling
  inheritance), `panel` 25/25, `export-parity` pass.


## trade.33 — 2026-10-29 — Cluster members participate in frontier expansion

- Automatic discovery previously read only `fieldBuffers()`, excluding every
  cluster/object star. Maintenance now also supplies `starBlocks()`; one bounded
  ring scans both sources through the same candidate pipeline. Member identities,
  block-local indices and coeval stellar context are retained; visibility and
  formation gates apply, including when there is no field buffer.
- Regression uses packed cluster members at a nonzero object-block offset:
  unformed/hidden stars are excluded, canonical member systems are discovered,
  and an expedition arrives, founds a colony and accepts a trade-route commission.
- Validation: `trade` passed; `changed` passed all 10 affected groups.
- Next: visually exercise expansion from a player-founded cluster colony with
  both frozen and moving skies on WebGPU hardware.

## trade.34 — 2026-10-29 — The clock board, three progressions, and a fleet that is a picture

The browser pass on trade.25–.33 answered three complaints with one finding: the
app had four clocks with no ledger, and the intra fleet's *picture* was a
function of the economy's clock. Plan: [`time-plan.md`](../time-plan.md).

- **`src/core/timeboard.js` (new, pure).** The three progressions as one table —
  `generation` (0.5 Myr/s, Evolve, colony clock synced to the star clock,
  generation hulls, schematic at 0.05 y/s), `trade` (the default: 1 Myr/s,
  synced at 1 000 y/s, next-generation hulls, schematic 1 y/s) and `planetary`
  (frozen sky, colonies on their own 50 y/s ladder, schematic 0.5 y/s) — plus
  the star link's law (`SYSTEM_STAR_BRIDGE`: one schematic year per star Myr
  per wall second) and the board's two formats.
- **The ninth panel (`#time-menu`, workspace bit 8, observe + command).** A
  ledger of five clocks (star, colony, system, ship, epoch) and two links
  (colony ← star, system ← star) with one writer each, so the Trade panel's
  `Sync time` box and the board's box are the same switch. The sliders stay in
  their own panels, as the brief asked; the board says what they are doing.
  `applyTimeMode` writes every clock of a progression through the same state the
  sliders write — including `setGenerationMode` — so a press and four drags
  cannot disagree. `resumeStarIfSynced` stays the *user gesture's* extra: a link
  switched on over a parked sky wakes it, a mode press does not.
- **The fleet's law reversed (supersedes `trade-4-plan.md` §0.1–§3).** The
  trade is the average, the fleet is its picture: `applyIntraFlows` applies every
  transfer again (no booking, no withholding), and `noteIntraLegs` records the
  three largest legs of each settle — pair, dominant family, flow, delta-v,
  class, Hohmann leg time — splitting the twelve ferries across them. The
  schematic draws those boats on its *own* clock as a round trip, with a motion
  trail, and docked ticks when a port has no transfer. Opening or closing the
  view is now provably free: two 5 000-year runs compare byte-equal where the
  old contract allowed 5 % (measured 0.84 %).
  Removed: `net.intraQ`, `EV_INTRA_ARRIVE`, `bookIntra`, `arriveIntra`,
  `intraHandler`, `setIntraOnline`, the hull records and their two states.
  Kept: the class gate and the unserved-pair refusal — a pair no in-system
  engine can fly still trades and is still not drawn.
- **The reported bug.** `V` `B` `B` walked the schematic into the two delta-v
  renders, where `draw()` returned before any ferry was drawn. `drawDvFleet`
  now draws the same boats on the graph columns of the leg's endpoints, along
  the escape row; a body the graph does not carry is skipped, never guessed.
- **Readouts.** `intraFleetText` prints the ferries, the legs and the settle's
  flow per leg with delta-v and leg time, and names the system clock; the Trade
  panel's one row says `intra N legs`; the fleet block no longer claims
  `landed` tonnes, because the average is not a voyage.
- **Validation.** `timeboard` 56 checks (new; registered in `world-tests`),
  `trade` 371/371 (§30 rewritten), `panel` 35, `workspace` 48, `m1-smoke`
  122/122, `system-layer`, `dv-map`, `route`, `ship`, `preset`, `scenario` —
  `world-tests` 17/17 in 18 s. Browser verdict still open: `V` `B` `B`, a
  frozen schematic clock, the star link and each mode press.

## trade.35 — 2026-10-29 — The ships that were not there, the checkbox that could not be ticked, and a route's own numbers

The browser pass on trade.34 answered three reports: the **Time** panel's
checkbox could never be checked, the system view still showed **no ships** (and
asked for a scenario where one is unmistakably moving), and selecting a ship
should print **the average loads of its route that the calculation used**. The
first two were defects, not framing, and each had a single cause.

- **The checkbox (`src/core/workspace.js`).** The mode bar's `panels ▾` menu
  writes its overrides into `panelOverrides`, a `Uint8Array` — and the Time
  panel is bit **8** (256). `.applyOverride` stored 256 into a byte and read 0
  back, so the box was unchecked again on the very next pass, for ever. The
  store now carries the table's own width: `MASK_STORE_BITS` (16) and
  `createMaskStore()` build the `Uint16Array`, `main.js` uses it, and
  `sanitiseMask` already clamped to `PANEL_MASK_ALL` (511). `workspace` 55
  checks (old HEAD copy: 48).
- **Why no ship was ever drawn (`src/render/system-layer.js`).** Two gates.
  `drawIntraRoutes` returned unless the port had **more than one world**
  (`worldCount`), and with the planet model's own statistics most systems have
  exactly one — so a port with a fleet drew nothing at all; the same gate hid
  the network's hulls. Both are gone, and the layer now draws
  - the **twelve ferries** the settle split across its legs (`drawFerry` takes
    `(seat, leg)`, so each is a named craft rather than a loop index), with
    docked ticks around the loading world when there is no leg, and
  - the **network's hulls** at the port (`drawHullFleet`, `drawDvHullFleet`),
    each at the fraction of the voyage it has flown, docked ones drawn around
    the berth.
  A **craft registry** (`registerCraft` / `beginCraftFrame` / `pickCraft` /
  `selectCraft` / `clearCraft` / `selectedCraft` / `craftLabelAt` /
  `craftSelected`) makes picking the draw's own arithmetic: every ferry and hull
  registers its position as it is drawn, in the space it was drawn in (device
  pixels on the orrery, graph units on the two delta-v renders). Hover goes
  craft-first, and the click router selects a craft before falling through to
  the node/body behind it. `system-layer` 72 checks (new §12: a one-world port
  draws twelve ferry arcs, a docked ferry is pickable, the hull is clickable in
  all three renders, stale fleets are refused, select/clear/exit round-trip).
- **The record the layer draws from (`src/core/trade.js`).** `portFleet(net,
  index, out)` fills the shared `PORT_FLEET` from `net.ships` — docked first, at
  most `MAX_PORT_FLEET` (12), counting what does not fit in `docked`/`sailing`
  so nothing is silently dropped, and carrying `VOYAGE_DOCKED`/`OUT`/`IN`, the
  fraction flown, the hull, the cargo with its tonnes, the booked years and the
  hull's own trip/delivery record. A **waiting** hull is a hull at the port: it
  holds a berth and is drawn where it is (it is not a second population — the
  same `net.ships` the overlays have always drawn).
- **A ship's route, in the calculation's numbers.** `intraCraftText(net, index,
  leg, seat)` prints a ferry's own leg: `t / settle`, the per-ferry share, the
  ferries on that leg, the leg time and the round trip, `Δv`, the class gate
  (`need = dv · 2 · 1.1` against every in-system class, yes/no), the couple and
  the Hohmann time. `voyageText(net, index, slot)` prints a hull's booked voyage:
  route, `NN %` flown, booked years, arrival, tonnes and units, delivered/trips.
  A ferry in port says *why* there is no leg (`one world`, `the last settle
  moved nothing`) rather than inventing one. Both are the settle's and the
  network's own numbers; the picture and the arithmetic cannot disagree.
  `#sysread` appends the block for whatever craft is selected (`craftReadoutText`).
- **The scenario the report asked for (`src/core/scenarios.js`,
  `main.js`).** A new row, `Fleet — a colony's ships`
  (`mode=observe&systime=0.5&dvmap=2`), the first scenario whose subject is a
  picture rather than an epoch: it carries no `age`/`time`, so the session's sky
  stays where it is. It does carry the clock the hulls ride
  (`trade=20&tradesync=0`): at the synced 1 000 y/s a 150-year voyage crosses the
  escape row in a sixth of a second, so the row slows the trade clock to 20 y/s
  and the live line names it. Its page action (`applyFleetScenario`) asks
  `fleetShowcase(net, ticks)` for the berth — highest `legs·16 + sailing·4 +
  docked`, **wound in whole 25-year ticks** (≤ 12) to the network's first
  departures when the network is younger than them, so the row never opens on a
  dock — opens the delta-v rails render on that star with no camera flight, and
  **selects a moving craft** (a flying ferry first, else a hull under way). The
  live line reads
  `fleet · <port> · N hulls (d docked · s under way) · 12 ferries on L legs ·
  T t / settle · ferry 1 of 12 on leg 1 of L · system <rate>`, or the one-world
  case, `ferries in port · 1 settled world, so no in-system leg`, and adds
  `clock +N y to the first departures` when it wound. `scenario` 84 checks
  (§30's table rule split into epoch rows and action rows, plus the page wiring:
  the dispatch, the showcase call, the craft selection order, the fleet record).
  `trade` 380/380 (§30b: port coherence and the port key, `voyageText`,
  `intraCraftText` for a leg and for a port, the showcase's wind and its cap).
- **Validation.** `all-tests` 47/47 (workspace 55, trade 380, scenario 84,
  system-layer 72, preset 32 — its "every scenario is an epoch" rule now pins
  action rows as the complement), `view-tests` 21/21.
- **Open.** The three frames are still browser verdicts (`V15b`–`V15d`, and the
  new `V15e`): whether twelve amber ticks and the blue hulls read as a fleet at
  1280 × 800, whether the Time box ticks and survives a reload, and whether the
  fleet row's selected craft is on screen at its first frame.
- **Found on the way (not this entry's):** a port founded through
  `playerFoundWorld` on a network that never had `trade.finalize` run (no
  `EV_TICK` scheduled) settles nothing — `port.intra` stays null and pops freeze
  at their grant. `finalize` is the network's contract, not an optional call.

## trade.36 — 2026-10-29 — Time is time: the schematics' rails, and a generation ship a colony builds

The second browser pass answered the rest of the report: ships drifting **off
the drawn delta-v schematic lines**, and a **Time** panel whose progression
buttons "caused change [of] galaxy age". Both were real, and both were a single
wrong owner each. This entry removes the rejected design rather than layering on
it.

- **The boats ride the rails (`src/render/system-layer.js`).** The graph render
  built a path per *leg* (`buildTransferPath`/`mapPathPoint`/`drawMapRoute`) while
  the hulls were drawn on a second, independently computed edge point, so a boat
  could sit beside its line. The hull departure lane is now a **drawn element**:
  `drawHullLane()` runs inside the craft frame, strokes `HULL_LANE`
  (`rgba(150, 190, 240, 0.16)`, dash `[2, 6]`) from the berth's row to the
  star's edge and fills `hullLaneOut`; `drawHullFleet` takes its geometry from
  the lane instead of recomputing an edge. The proof is a test, not an opinion:
  `experiments/system-layer-test.js` now records every `moveTo`/`lineTo` segment
  the stub context is given, draws a frame with the port attached and **no
  fleet**, reads each boat's drawn position back through `pickCraft(x, y, out,
  outXY)`, and asserts every craft under way lies on a segment of that boatless
  frame. `{underWay 42, system 14/1/worst 0, classic 14/1/0, rails 14/1/0}`, 73
  checks. (Full graph-walk replacement of `buildTransferPath` is still open —
  `time-plan.md` §5.)
- **The progressions stopped moving the sky (`src/core/timeboard.js`,
  `src/main.js`, `src/index.html`).** A progression is a **game** clock profile:
  `linked` (one clock — both game clocks ride the sky), `trade` (default: the
  colony clock rides the sky, the schematic keeps its own 1 y/s), `planetary`
  (neither does: 50 y/s and 0.5 y/s). No entry has a `star` rate, an `evolve`
  switch or a `generation` flag; `matchMode` is asked about four keys
  (`{tradeRate, tradeSynced, systemRate, systemSynced}`) and ignores everything
  else. `applyTimeMode` writes the colony ladder, the two links and the
  schematic's rate and nothing else — `starTimeRate`, `starTimeMyr` and the
  epoch are not in its body. The `data-time-mode="generation"` button, the
  `#trade-generation-ships` checkbox, `tradeGenOn`/`tradeGenBox` and the
  `tradegen` preset key are gone; the load path already ignored a saved
  `tradegen`, and `presets.js` no longer lists it, so an old mask is stripped
  rather than honoured. `experiments/timeboard-test.js` was rewritten for the
  new table (80 checks) and now **fails if a progression grows a star rate
  again**, or if `applyTimeMode` assigns the star clock.
- **A generation ship is a colony's decision (`src/core/trade.js`).** The global
  mode (`setGenerationMode`, `GENERATION_STAR_MYR`, `GENERATION_RESERVE_YEARS`,
  `economy.setReserveScale`/`rescaleColonyReserves` and the 5 000-year
  warehouses) is deleted outright. What exists instead is the law the brief
  asked for — *any colony can build a generation ship if no other variant is
  available and if this is profit*:
  - `bestGenerationTarget(net, time)` scans the stranded candidates
    (`reach === 0`: no port inside `MAX_FOUND_LY` 600 ly), keeps the ones worth
    centuries (`GENERATION_MIN_HABITAT` 0.42 — terran/HZ worlds) inside the
    ship's own reach (`GENERATION_MAX_FOUND_LY` 2 400 ly), and picks the best
    from the colony nearest the target among the big, resting ports.
  - `launchExpedition(..., generation = 1)` books the leg at
    `GENERATION_LY_PER_YEAR` = 1 ly per 33 trade years **on the sky as charted
    at departure** (`planLeg`, no intercept — a colony plans to the world its
    telescopes see), stamps `ship.generation`, and the voyage is otherwise an
    ordinary founding wave with its own cap.
  - The maintenance pass never re-aims or turns it (`retimeRoutes` skips
    `ship.generation`), the arrival's reach gate is its own cap, and a
    generation voyage does **not** occupy the ordinary founding lane — the
    first cut did, and the frontier test caught it: with three founding slots
    held by 66 000-year voyages the network stalled at 50 ports. `tick` now
    counts ordinary and generation foundings apart, and one colony builds one
    ship per `GENERATION_COOLDOWN` (20 000 y), at most `MAX_GENERATION_IN_FLIGHT`
    (2) at a time. The Trade panel's state line prints
    `· 1 generation ship (66 000 y)` (or `· N stranded worlds` while nobody is
    building for them).
  - The voyage is the point the user asked for: 2 000 ly is 66 000 colony
    years — eleven minutes at the default 100 y/s, 33 s at the ladder's top, so
    the player winds the clock up to watch it. `trade` 385/385 now includes a
    check in §17 (the moving sky): a real terran world 2 000 ly out, put in the
    pool through `addCandidate` with the resolver's birth record, chosen by the
    decision, launched, sheared at 60 Myr — and it keeps its booked arrival, is
    never diverted, and **founds the colony**, while the freighters beside it
    keep their 150-year voyages.
- **Validation.** `world-tests` 17/17 (`trade` 385, `timeboard` 80, `scenario`
  84, `system-layer` 73, `panel` 36, `preset` 32, `workspace` 55, `m1-smoke`
  green with the retired symbol gone from its regex).
- **Left open (recorded, not implied):** `buildTransferPath`/`drawMapRoute` are
  still leg-derived — the boats ride the lanes that are drawn, but a second path
  builder remains and should become the graph walk; and the browser verdicts
  (`deferred-browser-visual-plan.md` V15a–V15e) still need a real GPU.

## trade.37 — 2026-10-30 — Local routes are recent trade, not the last inspection

- **Investigation.** In the shipped seed the starting colonies normally have
  one world; the ships on the escape row are interstellar freighters. The
  sibling gate compared a habitat-and-well-weighted *ranking score* with a
  minimum *coupling*. Rigil Kentaurus's belt scored 0.038 despite a 0.397
  coupling, so the reachable second world was refused. Latest-settle flows also
  vanished on quiet inspections; an asymmetric round trip could be rejected by
  doubling the expensive direction.
- **Simulation and view.** Player and autonomous sibling founding now gate on
  coupling and retain habitat/well for ranking. Actual settled amounts feed two
  bounded 25-year buckets; resources use their own mass factors, passengers
  use the established colonist conversion, and ferry details report tonnes
  and people per trade year separately. Quiet settlements preserve recent
  transfers, old buckets expire, sky-gate clock stamps do not replay mass, and
  a long settle is recorded at its completion. Round trips sum both directed
  Δv values with reserve, missing geometry is not invented, short times stay
  short, and the fleet always assigns exactly twelve ferries. The schematic
  explains no colony/active second world, idle traffic, missing geometry and
  unavailable hulls; outposts do not draw stale ferries. The readout settles
  first, prints distinct full world names, and distinguishes local pictures
  from booked interstellar voyages.
- **Evidence.** With the generated default start and 12.5-year settlements,
  Rigil Kentaurus automatically founds its belt at year 900 and shows a real,
  pickable local ferry by year 912.5 in all four renders; drawing/animating it
  leaves stocks and population unchanged. `trade` 405/405 and `system-layer` 81/81 include
  generated-system, expiry, units, asymmetric gates, missing/short geometry,
  exact allocation and outpost regressions. Named tests 8/8, `world-tests`
  17/17 and `changed` 11/11 passed. Browser/WebGPU appearance still requires a
  real browser/GPU.
