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

No renderer/WGSL changes; overlay geometry unchanged. Next: planet-specific
docking visuals and physically calibrated interstellar freight remain deferred
per trade-plan.md.
