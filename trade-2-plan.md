# Trade 2 — outposts, player agency, narrated growth, richer site factors

The plan after the comparison in `trade-branch-compare.md`. It extends `trade-plan.md`
(the shipped spec) with what main lacks and the old colony-economy line did better,
and it reworks two laws: what happens to a colony that has failed, and what makes a
world worth mining.

No new files under `src/`. No WGSL, no render-path or star-buffer change, no build
step. Every law below is CPU-only and additive to `src/core/economy.js`,
`src/core/trade.js`, `src/core/exec-queue.js`, `src/main.js`, `src/index.html`,
`src/style.css`, `src/render/label-layer.js` and the tests.

## 0. Decisions

| # | Item | State |
|---|---|---|
| W1 | **Outposts** — a failed colony stops, is marked, and is never recolonised | do |
| W2 | **Narrated events** — milestones, famine, outposts, foundings, expeditions | do |
| W3 | **Player founding** — *Found colony* at a docked port | do |
| W4 | **Site factors** — system composition, belts first, giants demoted | do |
| W5 | **Scarcity tags** — read-only surplus/fair/scarce, no money | do |
| W6 | **Expansion authority** — arm/disarm + per-port readiness | do |
| W7 | **Clickable rows + colony assets** | do |
| W8 | **Forward calendar** — the next events in the queue | do |
| W9 | **Overlay** — outpost marks, starvation alarm, route edges | do |
| W10 | **Standing routes** — player intent, preferred not enforced | do, last |
| F4 | Credits, prices, buying and selling for money | **deferred** |
| F6 | Capital / development investing into production | **deferred** |
| — | Reviving an outpost back into a colony | deferred |
| — | Route contracts, penalties, mixed holds, physical freight | deferred |
| — | Two-tier trade (3 intra / 7 inter-star, world pool, intra rates) | **deferred** — `trade-3-plan.md` |

Re-entry conditions for the deferred items, so a later pass does not have to rediscover
them:

- **F4** needs a decision on `trade-plan.md` §1's "no prices, credits or contracts"
  contract. If it returns, it returns as a hull scalar (`ship.credits`) and one price
  law per colony (`price = base × (1.6 − 1.2 × supply)`, supply from stock *and* yield),
  never as a galaxy-wide equilibrium. W5's `scarcityOf` is the number it would price on,
  so W5 is the prerequisite either way.
- **F6** cannot be added to `settleColony` without breaking the closed form. If it
  returns, it returns as **development tiers that change only at event boundaries**: the
  colony carries `tier` (0–4) and `invested`; a settle stays closed-form inside a tier,
  and a tier change is an event (`EV_DEVELOP` on the queue) that re-derives `outBase`
  and `inputRateOf`. That keeps jump invariance *per tier* and makes the tier history
  explicit instead of hidden in a stock. Gravity-trajectory's `dCap` from surplus is
  this idea as an ODE; it is the same deferral (`trade-3-plan.md` T7).
- **Two-tier trade** (3 goods inside a star, 7 between stars, many worlds, one port)
  is the following series, not a W-item: it re-pins growth the way W4 does and needs
  W1/W3/W4/W5 already on the tree. Spec: `trade-3-plan.md`.

## 1. Baseline — the seams this plan touches

| File | What it owns today | Anchors |
|---|---|---|
| `src/core/economy.js` | resources, sites, colony setup, closed-form settle, demand/export, player transfers | `SITE_BELT` 99, `PLANET` 100, `POP_MIN` 133, `createSite` 162, `copySite` 192, `fillPlanetSite` 227, `fillBeltSite` 251, `starFactor` 277, `createColony` 310, `setupColony` 332, `coverageOf` 415, `settleColony` 450, `demandOf` 489, `exportableOf` 502 |
| `src/core/trade.js` | discovery, ports, candidates, fleet, queue handlers, colonisation, live geometry, player transfers | `createPort` 185, `portOfStar` 275, `bestPortOfStar` 299, `addPort` 641, `addCandidate` 669, `pickBestSite` 684, `discoverSystem` 716, `settleAllPorts` 896, `pickDestination` 910, `pickExport` 936, `loadAtPort` 1035, `isBigColony` 1112, `pickCandidate` 1120, `bestExpedition` 1148, `colonisationPreview` 1202, `tick` 1427, `foundAtCandidate` 1696, `setGenerationMode` 1776, `playerPort`/`playerLoad`/`playerUnload` 1825/1850/1880, `TradeLib` 1914 |
| `src/core/exec-queue.js` | typed-array min-heap | `push`/`pop`/`drainUntil`/`peekTime`/`clear`, `ExecQueueLib` 143 |
| `src/main.js` | boot, clocks, panel wiring, readout text, network step | `tradeNet`, `syncTradeUi` 4256, `tradeReadoutText` 4207, `tradeLaunch` handler 1187, preset save/apply 1997/2112, `gameFoundColony` does **not** exist yet |
| `src/render/label-layer.js` | the network's picture | `drawTrade` 728, port rings 785, young ring 807, filled core 827, hulls 844, cargo colours |
| `src/index.html` | Trade panel | 487–517, `#trade-list`, `#colonisation-state`, `#colonisation-list` |
| `experiments/trade-test.js` | 134 checks | §16 start scenario 1090, §15 generation mode 1054, `abandoned` assertions 488/526/527 |

Two contracts everything else must respect:

- **One event per hull plus one tick.** No feature may add a second scheduler. W10 is
  designed around this (a route is data a load decision reads, never a scheduled event).
- **No allocation in the frame loop.** New strings are built at the 4 Hz readout only;
  new records are preallocated at network creation.

## 2. W1 — Outposts

Replace abandonment. A colony that fails does not disappear, and does not keep being
simulated either: it stops, is labelled, and the network is done with it.

### Record and law

`economy.js`:

```
OUTPOST_POP_M = 0.02        // millions; was POP_MIN
```

`createColony()` gains `outpost: 0`, `outpostY: 0` (the year it stopped), and drops
nothing else. `settleColony(colony, nowYears)`:

1. `if (colony.outpost) return 0;` — first line, before `now > last`. An outpost has no
   factories, no consumption, no growth, and its stocks are frozen.
2. At the end of a normal settle, if `pop < OUTPOST_POP_M`:
   `outpost = 1; outpostY = now; growth = 0; coverage = coverageOf(colony)` and return
   the population delta. The population is left at its last value (the outpost's staff),
   not zeroed and not floored — the number the player reads is the real end state.

Helpers keep their shape and gain the guard: `demandOf`, `exportableOf`, `giveToColony`
return 0 for an outpost (so nothing is imported, nothing is exported, nothing unloads);
`takeFromColony` already goes through `exportableOf`.

**`bestPortOfStar` must return outposts** (it currently skips `abandoned`). This is a
deliberate inversion of main's rule: "no trade port here" is a lie about a star that has
a dead colony on it, and the user asked for the outpost to be *known*. The refusals move
into the transfers:

- `playerLoad` / `playerUnload`: `if (colony.outpost) { PLAYER_RESULT.outpost = 1;
  reason = 'outpost — no trade here'; return; }`
- `playerExport` therefore finds nothing (exportable 0), but the port and its readout
  still resolve.

### Never recolonised

A port slot is identity (in-flight hulls and the panel index it), so the outpost keeps
its slot and its `key`. What must be added is the *live* distinction:

- `portOfStarLive(net, key)` — new: first port with that key that is **not** an outpost.
  Used by `addPort`'s idempotency and by anything that asks "is there a colony I can trade
  with here" (the panel, the readout, `portOfStar`'s callers that mean *live*).
- `portOfStar(net, key)` keeps meaning "a slot exists" and stays the check for **"can this
  star be settled"**: `addCandidate`, `pickCandidate`, `discoverSystem`'s settle guard and
  `foundAtCandidate`'s `available` test all keep it, which is exactly what makes an
  outpost star unreachable for every future founding — no new rule, one unchanged one.
  Swapping those to `portOfStarLive` would let an expedition land on a dead colony: do
  not.
- `addPort`: `existing = portOfStarLive(...)`; return it if found; **if `portOfStar(...)
  >= 0` return -1** — the star is an outpost, so no expedition or player can settle it
  again.
- `bestPortOfStar` stops skipping outposts (see above).
- On demotion (`economy` cannot do this; `trade.js` can): mark every candidate of that
  star `used = 1`, release any expedition reservation bound to it
  (`reserved = -1`), so a founder already in flight refunds its volunteers through the
  existing `returnFounder` path and no hull waits on a dead world.
- `net.outposts` counter, maintained by the demotion path (`net.portsLive` is
  `portCount - outposts`).

Total port slots stay capped at `MAX_PORTS` including outposts — a dead colony still owns
its name, its slot and its place on the sky. Stated here so it is not read as a bug.

### Where the demotion is noticed

`settleAllPorts(net, time)` is the one pass that touches every colony; it polls
`colony.outpost` after each settle and calls `demotePort(net, i)` once (the second call
is a no-op because `net.ports[i].demoted` is set). Also called after `arrive`,
`foundAtCandidate`, `playerLoad/Unload` and the readout's settle, so a demotion is never
missed because a port was not part of a bulk pass.

### Display

- Overlay: an outpost is a hollow grey ring (`TRADE_OUTPOST`), radius from its frozen
  population on the same `2 + 5.5√(pop/K)` law, no growth colour, no filled core, no
  young ring. It reads as a dead thing that is still on the map.
- Starvation alarm: a live colony with `coverage < STARVE_COVERAGE` (0.35) gets a dashed
  amber ring outside its own (`TRADE_ALARM`), so a colony on its way to outpost status is
  visible *before* it happens.
- Panel: the row shows `outpost` instead of `↑ 1.2 %/y`, greyed; the state line reads
  `64 ports · 3 outposts · …`.
- System readout: `trade — <name> · outpost since <year> · no trade · pop <n> M frozen`.
- HUD economy line: append ` · <n> outposts` when `n > 0`.

### Tests (`experiments/trade-test.js`, new §18)

1. A colony settled below `OUTPOST_POP_M` becomes an outpost, keeps its key and slot, and
   `growth === 0`.
2. A second settle changes nothing: same `pop`, same stocks, same `last` year.
3. `demandOf` and `exportableOf` are 0 on every resource; a freighter at that port waits
   instead of loading.
4. `bestPortOfStar` returns the outpost; `playerLoad` refuses with `outpost` set and the
   hold untouched (mass conservation). The existing check "an abandoned colony is not
   offered as a player port" (`trade-test.js:527`) inverts with this: the port **is**
   offered and the refusal lives in the transfer, because a readout that says "no colony
   here" about a dead colony is the one thing W1 exists to prevent.
5. No recolonisation: `addPort` on the outpost's site returns -1, `pickCandidate` never
   offers that star, and an expedition already bound for it refunds its party on arrival
   (party in = party out, exactly).
6. Candidates of the demoted star are `used` and reservations released.
7. A colony just above the threshold stays live (boundary check both sides).
8. `net.outposts` counts exactly the demoted ports after a 600-year run.

## 3. W2 — Narrated events

The economy on main is honest but mute. The panel says numbers; nothing says *what
happened*. One bounded log, fed at settle boundaries and event handlers only.

### Fields

`economy.js` — `POP_MILESTONES = [0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500]`
(millions, the scale the colony law actually uses), `STARVE_COVERAGE = 0.35`. The colony
carries two bookkeeping bytes, updated inside `settleColony`: `popLevel` (how many rungs
of the ladder it has been credited with) and `starving` (0/1 for `coverage <
STARVE_COVERAGE`). No callback, no global, no allocation — the settle stays a pure
function of `(record, now)`.

`trade.js` — the network owns the log:

```
LOG_CAP = 64
LOG_FOUND, LOG_MILESTONE, LOG_FAMINE, LOG_FAMINE_END, LOG_OUTPOST, LOG_ROUTE, LOG_EXPEDITION
createLog()            // { time, kind, a, b, c } typed arrays + head + count
pushLog(net, kind, a, b)   // at net.time; overwrites the oldest when full
logLength(net)
```

`a`/`b`/`c` are indices and years, never strings. Text is built in `syncTradeUi` at 4 Hz
from those indices — the one place the panel is allowed to make strings.

Detected where the events happen, never in the frame loop:

| Transition | Detected in | Line |
|---|---|---|
| `popLevel` rose | `settleAllPorts` / `arrive` / readout settle | `<port> reached <ladder> M` (+ ` · n rungs` when a jump crossed more than one) |
| `starving` 0→1 | same | `<port> is starving — coverage <x>` |
| `starving` 1→0 | same | `<port> recovered — coverage <x>` |
| founding | `addPort` from `foundAtCandidate` / `playerFound` | `colony founded at <site> from <port>` |
| outpost | W1 `demotePort` | `<port> is an outpost — growth stopped` |
| expedition | `launchExpedition` / `returnFounder` | `founders left <port> → <site>` / `founders returned to <port>` |
| route | W10 | `route <a> → <b> commissioned` / `cancelled` |

### UI

`#trade-log`, a `<pre>` under the colonisation block, last 8 lines, refreshed with the
rest of the panel:

```
  +1 204 y  Vega reached 5 M
  +1 240 y  Altair is starving — coverage 0.21
```

### Tests (new §19)

- Every rung is credited exactly once across many settles; a 5 000-year jump credits the
  top rung with `n rungs` and never re-emits a lower one.
- Famine enters once and lifts once across a starve-then-recover fixture.
- The ring wraps: `LOG_CAP + 10` pushes leave `LOG_CAP` entries, oldest first, and the
  allocation count is unchanged after the first fill.
- An outpost logs once (not once per settle).
- `logLength` never exceeds `LOG_CAP`; a network with no ports still has a valid log.

## 4. W3 — Player founding

The old branch's best small feature: the player can put a colony down at a port the
network never rolled. It is free — the player is the catalyst, not an owner.

### API

`trade.js`:

```
createFoundResult()   // { ok, port, site, reason } reused
playerFound(net, ref, starName, system, nowYears, out)
```

Law, in order, each with its own `reason`:

1. `out` reset; `portOfStarLive(net, key) >= 0` → `already a colony here`.
2. `portOfStar(net, key) >= 0` → `this star is an outpost`.
3. a candidate of that star is `reserved >= 0` → `an expedition is already bound for it`.
4. `net.portCount >= MAX_PORTS` → `network is full`.
5. `pickBestSite(...)` gives `score < MIN_CANDIDATE_HABITAT` → `no world worth settling`.

Success: the best site is filled and named (`economy.siteName`), `addPort` runs in
**fresh** mode, candidates of the star are marked `used`, `net.founded += 1`, `LOG_FOUND`.
`out` carries the port index, the site and `ok = 1`.

### Fresh founding

`economy.setupColony` invents a 10–250 year hash age and settles it — right for a star
the galaxy rolled, wrong for a colony the player just founded. Add

```
foundColony(colony, site, nowYears, seed)   // no invented age, no settle
```

which does everything `setupColony` does except the age: `founded = last = nowYears`,
`pop = min(capacity, FOUND_POP_BASE + FOUND_POP_CAP_FRAC * capacity)`, stocks at
`FOUND_STOCK_FRAC × cap`, `coverage = 0`, `growth = 0`, `popLevel = 0`, taxes none.
`addPort(net, site, nowYears, fresh)` takes a `fresh` flag (a fifth positional argument is
not acceptable — pass `FRESH_FOUND` / `ROLLED_FOUND` constants, or split into
`addPortFresh`). `setupColony` keeps its settle for discovery; `foundColony` is used by
`playerFound` and by `foundAtCandidate` (which today patches a settled colony by hand —
that patch collapses into one call, removing the duplicate).

### UI

- Flight panel, beside Load/Unload: **Found colony**, disabled unless docked at a star
  with no live colony (`syncFlightUi` + `syncTradeUi` both refresh it).
- Pressing it: `generateSystem(ref, ctx, record)` → `playerFound(...)` → on success land a
  typed `colony` asset in the asset history (`selectionStore.selectCurrent`,
  `type: 'colony'`, `id: 'colony-<key36>'`, key/kind/index/x/y/z), auto message
  `colony founded at <name> · pop <n> M`, `syncTradeUi()`. On refusal: the reason in the
  auto message.
- The keyboard keeps its business: `L`/`Shift+L` are the cargo keys; founding stays a
  panel action (no new key).

### Tests (new §20)

- Success at a fresh star: `portCount + 1`, `founded === last === now`, `popLevel === 0`,
  stocks at 45 % of cap, no invented age (`founded` not < now).
- Each refusal reason, with `ok === 0` and an unchanged network (count, keys, population).
- One colony per star: a second call on the same star refuses.
- An outpost star refuses and is not revived.
- A reserved candidate refuses.
- `foundAtCandidate` and `playerFound` produce the same record shape (one law, two
  callers): same fields set, same founding grant, same stocks.

## 5. W4 — Site factors: what makes a world worth working

Two changes with one purpose: the *system* a world sits in says how much can be built
there, and what it can be built from.

### 5.1 System composition on the site

`economy.js`:

```
createSite() gains  sysRocky, sysGiants, sysBelts, sysTerran, sysHz     // small ints
systemComposition(system, out)   // one pass: bulk classes, FLAG_TERRAN, FLAG_IN_HZ, belts.count
```

filled by `fillPlanetSite`/`fillBeltSite` (both already receive `system`, and discovery is
the only caller), copied by `copySite`. Cost: ≤ 14 planets per system, at discovery and
inspection only — never in the frame loop and never in a settle.

### 5.2 The factor law

Replaces `starFactor`'s per-resource return values with two layers: the *situation*
(authored per resource, from star metallicity/age/light/temperature) and the *system
supply* (what a prospector would count). Fractions normalise against a cap so a system
with twelve rocky worlds is not twelve times a system with one:

```
rockyF  = min(sysRocky, 6) / 6      giantF = min(sysGiants, 4) / 4
beltF   = min(sysBelts, 3) / 3      terranF = min(sysTerran, 2) / 2
hzF     = min(sysHz, 4) / 4

mined   (ore, rare, robots, compute)   × (0.80 + 0.45·rockyF + 0.55·beltF + 0.15·giantF)
gathered(volatile, chem)               × (0.85 + 0.40·giantF + 0.30·beltF + 0.10·rockyF)
grown   (food, bio, people)            × (0.85 + 0.35·terranF + 0.25·hzF + 0.10·rockyF)
made    (amat, soft, data, art)        × (0.90 + 0.20·rockyF + 0.10·beltF)
```

The star layer stays main's, unchanged in shape: metallicity `^0.8` (ore) and `^1.3`
(rare), age, per-site light from insolation, surface temperature for life, spectral-class
penalty for hot stars. Metallicity and luminosity are **not** re-tuned here — main's
per-site insolation is already the better form of the old branch's system-wide `lumNorm`,
and re-tuning it would confound the composition change.

### 5.3 Belts first, giants last

`PLANET` is resource-major: 13 rows, columns in `planets.DISPLAY_TYPES` order —
`0 LAVA, 1 BARREN, 2 DESERT, 3 TERRAN, 4 ICE, 5 SUPER_EARTH, 6 MINI_NEPTUNE,
7 GAS_GIANT, 8 ICE_GIANT, 9 DWARF` — plus the belt column at `SITE_BELT = 10`.
`trade-test.js`'s "the yield table columns are the display types they claim to be"
check pins that mapping; it must stay green, so only values change, never the shape.

Two edits, and nothing else in the table:

**Asteroids are the easiest mine.** The belt column rises on the mineable rows and
keeps its volatile strength:

| row | belt (col 10) now | belt proposed |
|---|---|---|
| ore | 1.40 | **1.60** |
| rare | 0.80 | **1.10** |
| robots | 0.60 | **0.80** |
| compute | 0.00 | **0.10** |
| volatile | 1.20 | 1.20 (unchanged) |
| chem / food / bio / people / amat / soft / data / art | 0.20 / 0.10 / 0.02 / 0.10 / 0.00 / 0.00 / 0.00 / 0.00 | unchanged |

Consequence to keep in mind: the belt's ore at 1.60 is **1.33× LAVA's 1.20**, under the
1.5× ceiling that keeps planetary mining worth building. The belt's real advantage is
that a belt occupies one slot however many belts the system has, and that a belt system
gets `beltF` in the mined factor *and* keeps its volatiles.

**Heavy planets are places to live, not to mine.** They already make no ore and no rare
elements; what they still make is factory cores, which is the one row where a gas giant
should not compete with a rocky world:

| row | MINI_NEPTUNE (6) | GAS_GIANT (7) | ICE_GIANT (8) |
|---|---|---|---|
| robots | 0.30 → **0.15** | 0.30 → **0.10** | 0.30 → **0.10** |
| volatile | 1.30 | 1.50 | 1.40 (all unchanged) |
| chem | 0.50 | 0.50 | 0.40 (unchanged) |
| ore / rare / compute / art | 0.00 | 0.00 | 0.00 (unchanged) |

Rock-family columns (`LAVA`, `BARREN`, `DESERT`, `SUPER_EARTH`, `DWARF`) are **not**
touched: belts must win on merit, not by crippling the competition. Their habitat values
stay what they are, and a giant keeps `HABITAT[7] = 0.70` against a rock's 0.04–0.35, so
the trade the player makes is explicit: a giant is where people live, a belt is where ore
comes from.

`YIELD_MAX = 2.5` still clamps; the jitter stays 0.7–1.3; determinism is untouched (same
site hash → same yields, and the composition is a function of the system record alone).

### 5.4 Readout

`tradeReadoutText` gains one line under `trade`:

```
system    4 rocky · 2 giants · 1 belt · 1 terran · 2 HZ
```

### 5.5 Re-measure, then re-pin

This changes every downstream number, so it is its own commit and nothing else rides
with it:

1. `trade-test.js` §16's growth table — 4 seeds × (10 s, 20 s, 40 s, full network) — and
   §15's generation-mode table. Re-measure and update the tables in `trade-plan.md` §8;
   keep the acceptance windows (5–20 / 18–40 / ≥45 / 64 by 90 s) unless the law moved
   them, and prefer retuning `EXPEDITION_COOLDOWN` over widening a window.
2. `trade-plan.md` §8's coverage band (median 0.47, min 0.31): re-measure and record. If
   belts now out-yield planets hard enough to lift coverage everywhere, the colony law's
   `NEED_WEIGHT` is the knob, not the factor table.
3. §2.1's `PLANET` description and §2's yield formula text.

### 5.6 Tests (new §21)

- Composition counts match the generated system (planets and belts, terran/HZ flags).
- Same site, same yields, twice; a different star still diverges.
- Belt vs planet ore/rare on one star: belt wins, and by ≤ 1.5×.
- A 6-rocky system yields more ore than a 1-rocky system at equal star situation; a
  4-giant system yields less ore and more volatiles than the rocky one.
- Terran/HZ composition moves food/bio/people only (`amat` unchanged).
- A rock world out-makes a gas giant on robots (the heavy-planet demotion), while the
  giant still out-makes it on volatiles and chemicals.
- Every resource still has at least one world type with a positive cell (the §2 check
  stays green after the table edit).
- Every yield stays inside `[0, YIELD_MAX]` over a sweep of 5 000 generated sites.

## 6. W5 — Scarcity tags (readout only)

No money. A tag says what a port wants and what it is trying to get rid of, which is the
one piece of information the old market gave the player that main does not.

`economy.js`:

```
TAG_SURPLUS = 0, TAG_FAIR = 1, TAG_SCARCE = 2
scarcityOf(colony, r) -> 0..1     // demand / (demand + supply), supply = outBase*pop + stock/NEED_BUFFER_Y
tradeTagOf(colony, r)  -> tag     // SCARCE if demand > 0, SURPLUS if exportable > 0 && demand === 0, else FAIR
tradeTagName(tag)      -> 'surplus' | 'fair' | 'scarce'
```

Readout (`tradeReadoutText`): each yield row gains ` · <tag>`; the port line gains
`best export <resource> · worst import <resource>`. Panel rows stay as they are — the
readout is where a pilot looks.

This is also F4's prerequisite: a price would be `base × (1.6 − 1.2 · (1 − scarcityOf))`.

Tests (new §22): a self-sufficient full port is never `scarce`; a starved port is
`scarce` on food and volatiles; `surplus` implies `exportableOf > 0`; `scarcityOf` is in
[0, 1] and monotone in stock; a port with no demand and no stock is `fair` (0/0 is not a
crisis).

## 7. W6 — Expansion authority

`trade.js`:

```
setExpansion(on)          // module flag beside generationMode; returns it
expansionArmed()
portReadiness(net, index, time, out)   // { state, why, nextIn }
```

States and reasons: `live` | `resting` (cooldown, `nextIn` in years) | `small` (below
`MIN_EXPEDITION_POP_M` / capacity share) | `starving` (coverage below
`MIN_EXPEDITION_COVERAGE`) | `outpost` (W1).

Behaviour: `tick` launches nothing while disarmed (freighters, arrivals and the fleet
target keep running); `launchBest` refuses with `expansion is off`, so the panel never
disagrees with the simulation.

UI: `#trade-expansion` checkbox (on by default, the scenario's current behaviour),
`tradesync`'s neighbour `tradeexpand` in the preset fields (`presets.js`, URL, README
table), and the colony rows in W7 show the readiness reason, which replaces the
all-or-nothing `colonisation-state` line with per-port truth.

Tests (new §23): a disarmed 600-year run founds nothing while `delivered` still grows;
`launchBest` refuses; each readiness state is produced by a fixture; arming resumes at
the next tick; the preset round-trips `tradeexpand`.

## 8. W7 — Clickable rows and colony assets

- `#trade-list` becomes `<div id="trade-list" class="trade-rows">` filled with
  `<button data-port="N">` rows: `name · bar · pop · ↑x.x %/y` and, for a port that is
  not `live`, its readiness `why` instead of the growth mark. Rebuilt only when the row
  set changes (count, names, outpost flags); the text is refreshed at 4 Hz.
- Click → select that star through the existing selection path (the one H uses): set
  primary, ring it, and in observer mode centre the camera on it; in game mode make it
  the Flight destination. Never move the ship.
- Assets: W3's founding and every expedition founding land the typed `colony` asset, so
  the history reads `… · colony <name> · colony <name>` the way docking lands ports.
- `#colonisation-list` rows become the top three ready expeditions with a *Send* button
  each (the same `launchBest` law, per port), which is the per-port version of the
  existing single button. `colonisationPreview` already returns `port`/`candidate`, so
  the button carries those two indices and calls `launchExpedition` through a new
  `launchChosen(net, port, candidate, time, rush)`.

Tests (new §24): port keys are unique across ports (row ids are stable); `launchChosen`
with a resting port rushes it and restarts its cooldown; a stale row (port index beyond
`portCount`) is ignored instead of throwing. The DOM behaviour is a browser item on
`deferred-browser-visual-plan.md`.

## 9. W8 — Forward calendar

`exec-queue.js` gains one read-only query, and it is the only new thing about the queue:

```
peekNext(queue, outTime, outKind, outRef, count) -> n
```

Fills the `count` earliest live entries (≤ 8) in time order. Implementation: copy the
first `min(size, 64)` triples into preallocated module scratch and partial-select; the
heap is untouched, so there is no allocation after the first call and no invariant to keep.

`trade.js`:

```
nextEvents(net, time, out, count) -> n     // { time, kind, port, ship } reusing records
```

Resolves each entry against `net.ships[ref]` and drops the ones whose `revision` no longer
matches (a re-timed or turned-around voyage must not appear twice).

UI: `#trade-calendar`, `<pre>`, 4 lines:

```
 +12 y   arrive  Vega · hauler · ore
 +40 y   load    Fomalhaut · clipper · waits
 +25 y   tick    colonisation check
```

Tests (new §25): `peekNext` order equals a full drain's order on a canonical queue; stale
revisions are filtered; `count` is capped; the queue's `size` and root are unchanged after
a peek; 10 000 peeks allocate nothing after the first (same heap identity and length).

## 10. W9 — Overlay

`label-layer.js`, inside `drawTrade`, constants beside the existing `TRADE_*`:

- **Outposts** (W1): one extra pass, `TRADE_OUTPOST` grey, hollow ring from the frozen
  population, drawn after the live ports so it reads as a remnant.
- **Starvation alarm**: a second, dashed amber ring at `r + 4 px` on any live colony with
  `coverage < STARVE_COVERAGE`; dashed via alternating `arc` segments (no `setLineDash`,
  which the canvas stub in the tests does not implement).
- **Route edges** (W10): a third route pass for commissioned pairs, drawn *behind* the
  per-hull chords, in a dimmer teal, so the standing network and the voyages read as two
  layers.

No new per-frame allocation: the passes reuse `tradeA`, `tradeB`, `scratch`; the network's
route list is read directly from `net.routes` (W10 keeps it on `net`, so the layer needs no
new wiring beyond `setTradeNet`).

Browser items (added to `deferred-browser-visual-plan.md`): outpost marks, the alarm ring,
a commissioned route, the log and calendar in the panel.

## 11. W10 — Standing routes (last, and light)

The old branch's one real player lever, re-expressed so it cannot corrupt main's routing.

**A route is data a load decision reads. It is not an event source and not a contract.**

```
createRoutes()                      // { list: [], count: 0 }, held on net.routes at createNetwork
commissionRoute(net, origin, dest, now)
routeIndexOf(net, a, b)             // either direction
removeRoute(net, index)             // flags active = 0; never splices (slot identity)
activeRouteCount(net)
```

The list lives on the network record (not in `main.js`), so the overlay reads `net.routes`
directly and W9 needs no extra wiring.

`loadAtPort` gains one step before the global pick: for each active route from this port,
take the destination's `demandOf(r)` for the resource the port can spare; score it with the
**same** `amount · worth / (1 + ly / 200)` the global pick uses. If a route exists but its
destination wants nothing, fall through to the global pick — a hull never idles for a
route. `pickExport` grows one optional `preferFrom` argument instead of a second scoring
function.

Nothing is scheduled. `nextDepartY` is panel bookkeeping: `lastDepartY + legYears(...)`,
refreshed when a hull actually loads for that pair. The queue stays one event per hull plus
the tick, so the old branch's 64-slot-ledger failure mode cannot exist here.

UI: a `Routes` block in the Trade panel — `origin → dest · next` rows with `✕`, the two
selects and *Commission* (the old panel's shape); a route is preferred, which the row's
title says out loud. Overlay edges from W9.

Tests (new §26): the preferred destination wins when it has demand; the global pick wins
when the route's destination has none; cancel stops preference and leaves in-flight hulls
alone; the queue size is unchanged by commissioning (same `peekNext` before/after);
duplicate commissions are refused; a route to an outpost is refused; cancelled routes keep
their slot.

## 12. Order, dependencies, size

| Order | Item | Depends on | Size | Commit |
|---|---|---|---|---|
| 1 | W1 outposts | — | S–M | `trade.3: outposts — a failed colony stops, is marked, and is never recolonised` |
| 2 | W2 narrated events | W1 (outpost line) | S–M | `trade.4: the network narrates itself` |
| 3 | W5 scarcity tags | — | S | `trade.5: scarcity tags in the readout` |
| 4 | W6 expansion authority | W2 (log lines) | S | `trade.6: expansion can be stood down` |
| 5 | W3 player founding | W1, W7's asset path | M | `trade.7: the player can found a colony` |
| 6 | W7 clickable rows + assets | W6 (readiness text) | M | `trade.8: the colonial panel is a list you can click` |
| 7 | W8 forward calendar | — | M | `trade.9: the queue's next events are on the panel` |
| 8 | W4 site factors | — (but touches every number) | M | `trade.10: belts are the easiest mine, giants the worst — a system's composition reaches its worlds` |
| 9 | W9 overlay | W1, W10 | S | `trade.11: outposts, alarms and commissioned routes on the sky` |
| 10 | W10 standing routes | W9 edges | L | `trade.12: commissioned routes as player intent` |

W4 sits late on purpose: it re-pins the growth tables and should not be in flight while
another item is being measured against them. W10 is last because it touches the load
decision, the hottest path in the system.

## 13. Validation

Every commit:

```
node experiments/trade-test.js          # 134 → ~175 checks
node experiments/exec-queue-test.js     # 27 checks (W8 adds the peek cases)
node experiments/m1-smoke-test.js       # 117 checks, must stay 117/117
python3 scripts/run.py changed
```

Before the series closes: `python3 scripts/run.py all-tests` (~4 min), and the browser
pass in `deferred-browser-visual-plan.md` for the panel, the outpost marks, the alarm ring
and a route edge. `planet-gen`'s known intermittent heap-delta flake under a parallel
`changed` run is not a regression signal (`trade-plan.md` §5 note).

New test sections, appended so the existing sections keep their numbering: §18 outposts,
§19 the log, §20 player founding, §21 site factors, §22 tags, §23 expansion, §24 panel
data, §25 the calendar, §26 routes. Two existing blocks change by design: §4/§6's
abandonment assertions move to §18's outpost law, and §16's growth table is re-measured
by W4 (§5.5).

## 14. Docs

- `trade-plan.md`: amend §2.1 (outposts replace abandonment, milestone ladder, the
  starvation band), §2 (site composition and the factor law; the belt/gian table), §3.2
  (player founding beside expeditions), §4 (tags, no money still), §7 (outpost and alarm
  marks, route edges), and add a §10 "Player agency" for W3/W6/W7/W10. It stays the
  reimplementable spec.
- `plan.md` §19: index `trade-2-plan.md` beside `trade-plan.md`, and
  `trade-3-plan.md` as the following series.
- `worklog.md`: a `trade.x` line for the series; the per-commit log entry goes to
  `archive/trade.x-worklog.md`.
- `README.md`: *Colonies and trade* gains outposts, the Found colony action, the expansion
  toggle, the log and the calendar; the URL table gains `tradeexpand`.
- `findings-pitfalls-skills.md`: two notes — "narration belongs at settle boundaries, not
  in the settle" and "a route is intent, never an event source" (the old branch's
  route-per-departure ledger is the counter-example), plus "a system-level factor belongs
  on the site record, filled at discovery, because a settle must never walk a system".

## 15. Risks

| Risk | Mitigation |
|---|---|
| Outposts quietly shrink the usable network (a port slot lost per failure) | Publish `portsLive` in the panel; the alarm ring (W9) makes the slide visible before the loss; W1's tests pin the count |
| Returning outposts from `bestPortOfStar` breaks a caller that assumed "a port you can trade at" | Every refusal is moved into `playerLoad`/`playerUnload`/`exportableOf` in the same commit, and §18 checks the transfer path, not just the helper |
| W4 changes the growth curve and invalidates §16's pins | W4 alone, re-measured, tables updated in `trade-plan.md` §8; acceptance windows kept |
| Belt mining overshoots and every capital becomes a belt | The ≤ 1.5× check is a test, and `HABITAT_BELT = 0.10` caps a belt colony's population, so a belt-first network cannot grow into a population network |
| W10's preference silently degrades routing | Same scoring function, preference only when the destination has demand, and §26 pins both directions; if it degrades, the fallback is the calendar alone (W8) |
| The log ring becomes a per-frame cost | Text only at 4 Hz; the ring is typed arrays and indices; the settle writes two bytes |

## 16. Following series

`trade-3-plan.md` is the two-tier economy: 3 intra goods as rates taxed by the
0.5.4 delta-v graph (that cost is what develops a system), 7 inter-star
families, a world pool under the existing one-port-per-star rule. It reads W1,
W3, W4 and W5 and re-pins growth, so it starts after this series closes. A real
inter-planet fleet with its own clock and queue (T6), capital (F6) and auto-fill
of extra worlds stay deferred there too.
