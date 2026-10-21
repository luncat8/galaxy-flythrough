# Trade 3 — two tiers: worlds inside a star, one port between stars

The plan after `trade-2-plan.md`. It takes the economy/trade ideas from
`luncat8/gravity-trajectory` (`0.2.0-plan-colony-economy.md`) that this galaxy
can actually use, and it refuses the ones that would undo `trade-plan.md`.

No gravity, no ballistic cargo, no game-mode change. CPU-only, additive to
`src/core/economy.js`, `src/core/trade.js`, `src/math/deltav.js` (read-only),
`src/render/system-layer.js`, the Trade / system readouts and the tests.
No WGSL, no star-buffer, no build step, no second event scheduler **in this
series**. The deferred intra fleet (T6) is the one that would own a second
clock and a second queue.

`trade-2-plan.md` W1–W10 ships first. This series re-pins growth the way W4
does, so it must not be in flight while those tables are being measured.

### 0.1 Review corrections (2026-10-21)

- **The bulk filter is a family, not a price.** §3.2 originally zeroed ore and
  volatiles' worth; that number is also the player's load score and T4's intra
  routing score. §3.2/§3.3 now say what the law needs: `interFamily = -1` is
  the loader's filter, the authored worth is untouched, and `exportableOf`
  keeps its one meaning.
- **Commit ids move behind the shipped worklog.** trade.9–trade.18 are the W
  series (trade-2 plan §12); this series starts at trade.19.

## 0. Decisions

| # | Item | State |
|---|---|---|
| T1 | **Inter-star families** — hulls carry the 7 high-value goods; bulk stays in-system | do |
| T2 | **System aggregate** — one inter-star port per star; its market is the fold of its worlds | do |
| T3 | **World pool** — up to 6 world-colonies per star, always settled, never inspected-to-exist | do |
| T4 | **Statistical intra** — 3 goods as closed-form flows, throttled by the 0.5.4 delta-v graph; that graph is what develops the system | do |
| T5 | **System-view picture** — world markers, 3-good + dv readout, ambient dashes that carry no state | do |
| T6 | Inter-planet fleet with **its own time and its own queue** | **deferred** |
| T7 | Capital reinvested from surplus | **deferred** (still F6) |
| T8 | Auto-colonising extra worlds from intra passengers | **deferred** |
| T9 | Replacing the 13-row site map or the closed-form settle | **refused** |
| F4 | Credits, prices, buying and selling for money | **deferred** (unchanged) |

Re-entry for the deferred items:

- **T6** is real inter-planet trade, not a visual lie. It returns as a
  **second calendar**: its own clock (the system-time ladder, days to years)
  and its own heap (`net.intraQ`, an `exec-queue.js` instance, never mixed
  with the inter-star queue). Hulls load the three intra families, book
  against `legLoToLo` / well burns, and write world stocks. While it is
  off, T4 is the source of truth for every star, open or closed. When it
  is on for an opened system it *replaces* T4 on that port only, and the
  measured throughput of its hulls must sit inside T4's couple-weighted
  band (the statistical law is the acceptance test, not a second economy).
  It must not push onto the inter-star `net.queue`. Spec when it returns,
  not here.
- **T7 / F6** still cannot live inside `settleColony` without breaking the
  closed form. Event-boundary development tiers, as `trade-2-plan.md` §0.
- **T8** needs T3 + T4 passenger flow (already couple-weighted) and a
  founding law that does *not* consume a `MAX_PORTS` slot. Until then a
  star is one settled world plus empty sites the player can found (W3).
- **T9** is not a deferral. The 13-row `PLANET` table, the `INPUT` bill of
  materials and the closed-form logistic are the reason this economy works
  at 100–2 000 trade y/s.

## 1. What gravity-trajectory actually offers

Read against `0.2.0-plan-colony-economy.md` and
`0.2.0-draft-economy-compare.md`. That repo is a 26-planet *system page*
with an abstract inter-star average. This repo is a 64-port *galaxy* with
an abstract intra-system average. The two-tier split is the same idea
run the other way up.

| Gravity-trajectory | Here already | Take? |
|---|---|---|
| 3 goods inside the system (`bulk`, `goods`, `migrants`) | 13 site yields, one colony per star | **yes**, as T1/T4 families, not as a replacement table |
| 7 goods between stars | the same 13, all of them loadable | **yes**, as the inter-star routing set |
| No inter-planet movement while the system is closed; averages otherwise | we never simulate intra at all | **yes**, as T4. Hulls are T6, deferred, and they get their own clock — they are not a picture drawn on the galaxy queue |
| One inter-star port per star | one colony per star | **yes** — keep the port, add worlds underneath it |
| Deterministic ease from star metal/lum + rock/giant/terran/belt fractions + hash jitter | per-site yields; W4 adds the fractions | **the fractions, not the system-wide vector**. T2's port readout is that map *derived* from the worlds. T4 adds a second derived map: the delta-v graph |
| Logistic `K`, coverage, famine below 0.4 | logistic `K`, `coverage`, W1, W2 `STARVE_COVERAGE = 0.35` | **already ours**. Do not swap the closed form for 0.25 y steps |
| Capital from surplus | F6 deferred | **no** (T7) |
| Migrants as a flow | `people` stock + expedition volunteers | **yes** for intra (T4 passenger) |
| Tags, no money | W5 | already scheduled |
| Advance only on tick, never per frame | settle on events / inspection | keep. **Never** gate world settle on the system view — gravity B1 / `31c6d5a` B1 |
| 64-slot ledger, nearest-4, cargo seeding, prices | heap + demand-weighted galaxy routing | **refuse** |

The one-line take: **many worlds per star, one port the galaxy talks to,
three local goods that never leave, seven that do, intra as a delta-v
statistic, and no second fleet until T6.**

## 2. Baseline — the seams this plan touches

| File | What it owns today | What T1–T5 add |
|---|---|---|
| `src/math/deltav.js` | well burns, `legLoToLo`, `buildBodyNodes` / `buildInterEdges`, ship table | **read-only**. T4 calls it at discovery/founding, never in settle |
| `src/core/economy.js` | 13 resources, per-site yields, closed-form settle, demand/export | families, world records, fold, couple, intra rates, lift |
| `src/core/trade.js` | one port per star, fleet, founding, player transfers | world pool, load only T1 families, intra graph on the port |
| `src/render/system-layer.js` | schematic / delta-v map, no economy | world markers, ambient dashes, 3-good + dv card |
| `src/render/label-layer.js` | galaxy trade overlay, hidden in system view | unchanged (T5 lives on the system canvas) |
| `src/main.js` | `tradeReadoutText`, Trade panel | system readout in 7+3, world list when V is open |
| `experiments/trade-test.js` | 134 checks, W1–W10 add ~40 | new §27–§30 |
| `experiments/dv-map-test.js` | 0.5.4 pins | one new pin: `dvSurfaceToSurface` helper if it lands in `deltav.js` |

Two contracts, same as trade-2:

- **One event per hull plus one tick** on the *inter-star* queue. T4 is
  data a settle reads. T6, when it returns, is a different queue on a
  different clock.
- **No allocation in the frame loop.** World records and the 6×6 dv/couple
  matrices are preallocated at network creation. Graph fill uses module
  scratch (`DeltaVLib` body/edge records), once per founding.

And one more, from gravity's B1:

- **Worlds settle even when the system view is closed.** "Do not simulate
  inter-planet *movement*" is about hulls (T6), not about factories or
  the statistical flow (T4). Skipping a closed system would freeze it.

## 3. T1 — Inter-star families (7) and intra families (3)

The 13-row site map stays the production law. Families are **routing and
readout aggregations**, not a second yield table.

### 3.1 Intra (never loaded by an inter-star hull)

| id | name | members | why it stays home |
|---|---|---|---|
| `bulk` | resource | ore, volatile | feedstock; the `INPUT` matrix already gives it a local market |
| `goods` | product | chem (local share), robots, compute | stations swap manufactures inside the well |
| `pax` | passenger | people (migrant flow) | a flow between worlds of one star |

### 3.2 Inter-star (what `pickExport` / `loadAtPort` may choose)

| id | name | members | why it ships |
|---|---|---|---|
| `rare` | rare elements | rare | geology; metal-rich rock |
| `exotic` | specialist chem | chem, bio | hard to make |
| `amat` | antimatter | amat | energy, late, high worth |
| `food` | food & seed | food | life package |
| `fab` | factory cores | robots, compute | the industrial export |
| `info` | information | soft, data, art | culture and software |
| `pax` | passengers | people | the *trade* good; expeditions still move population |

A resource may sit in both columns (chem, robots, compute, people). Intra
uses it as a local flow; inter-star may still load the surplus the fold
cannot use. Ore and volatiles are **not offered to a star-port loader**: the
filter is the family map, not a mutated worth. `worth` stays the authored
routing weight (ore 0.25, volatiles 0.30) because the player's own load pick
and T4's intra scoring read it, and a zero there would quietly delete the
bulk trade that the `INPUT` matrix exists to create. `exportableOf` keeps its
one meaning ("what the warehouse can spare") for every caller; the load law
filters.

`RESOURCES[].family` today is `raw/synth/life/goods/data/culture`. Do not
repurpose it. Add `intraFamily` and `interFamily` (`-1` = none).

### 3.3 Load law

`pickExport` and `playerLoad` skip any resource whose `interFamily` is none.
Scoring is unchanged (`amount · worth / (1 + ly / 200)`), still one resource
id in the hold. The family is the *filter* and the *readout group*.
Unloading is never filtered: a hold that arrived with ore (loaded before T1
existed, or in-system) still empties.

### 3.4 Tests (new §27)

- Ore and volatiles never appear as a star-port export, including when they
  are the only surplus.
- Each of the seven families has at least one member with `worth > 0`.
- Ore and volatiles keep their authored `worth` (0.25 / 0.30) and their
  `exportableOf` on the fold; only the star-port loader refuses them.
- A hull that arrived with ore still unloads it — the filter is on load,
  not on arrival.
- Family sums equal the member sums; 0/0 is `fair` (W5).

T1 status: **shipped as `trade.19`**. The two maps live on `RESOURCES`
(`intraFamily`, `interFamily`, `-1` = not in that tier), `pickExport` and
`playerExport` skip a resource with no shipping family, and unloading is
untouched. The readout's `sells` line names the shipping families a hull could
load and `best export` is a shipping good; `needs` stays by resource. Tests are
`trade-test` §27.

## 4. T2 — One inter-star port per star

Unchanged identity: `ports[i]` is the thing the fleet, the overlay and the
panel talk to. `portOfStar` / `portOfStarLive` (W1) stay the "is this star
settled / live" tests. There is still **one inter-star-trade port per star**.

What changes is the colony the port points at. Today `port.colony` *is* the
world. After T3 it is the **fold**:

```
foldPort(port):
  pop      = Σ world.pop
  capacity = Σ world.capacity
  stock[r] = Σ world.stock[r]
  stockCap[r] = Σ world.stockCap[r]
  outBase[r]  = pop-weighted mean of world.outBase[r]
  coverage = pop-weighted mean of world.coverage
  growth   = pop-weighted mean of world.growth
  yield[r] = production-weighted mean of world.yield[r]
  access   = pop-weighted mean of world.access          // T4
```

`demandOf` / `exportableOf` / `giveToColony` / `takeFromColony` run on the
fold for every inter-star caller. After a transfer, `distributeInbound` /
`collectOutbound` push the delta down to worlds in proportion to each
world's demand (inbound) or *lift-taxed* exportable (outbound, T4). Mass is
conserved: `Σ world.stock[r]` equals `fold.stock[r]` after every transfer
and every settle.

The player's docked star still resolves through `bestPortOfStar`. Load and
unload move fold stocks, then distribute. The hold does not learn about
worlds.

Readout, when the system view is **closed**:

```
trade     Vega · 12.4 / 80 M · coverage 0.61 · access 0.72
system    4 rocky · 2 giants · 1 belt · 1 terran · 2 HZ
market    rare surplus · food scarce · amat fair
```

The `system` line is W4's composition. The `market` line is W5 tags on the
seven families. `access` is T4's mean couple. Thirteen rows remain under
an opened system.

## 5. T3 — World pool

### 5.1 Records

```
MAX_WORLDS_PER_STAR = 6
MAX_WORLDS          = MAX_PORTS * MAX_WORLDS_PER_STAR   // 384
```

A world is a colony record plus `port` (index) and `slot` (0…5). The
network preallocates `worlds[]` at `createNetwork`. A port holds
`worldIdx[6]`, `worldCount`. Slot 0 is the founding world — the site
`addPort` already picked. Empty slots are `-1`.

### 5.2 Who gets a world

At founding (expedition or W3): one world, the best site, as today. The
fold of one world *is* that world (identity, bit-exact, pinned).

Further worlds in this series are **player-founded in system view** (W3
extended: docked at the star, system open, a named planet/belt with no
world). They do not consume a new port slot. Refusal reasons: `already a
world here`, `star is an outpost`, `worlds full`, `no site worth settling`,
and T4's `too expensive to reach` when `couple(candidate, world0) <
MIN_FOUND_COUPLE` (0.08).

T8 (auto-fill from intra passengers) is later. A star the AI founds stays
one world until the player opens it.

### 5.3 Settle

`settleAllPorts`: for each live port, settle each live world, run T4, fold.
An outpost world (W1) still short-circuits. If every world of a port is an
outpost, the port demotes as today.

Cost: 64 × 6 closed-form settles per 25-year tick in the worst case, still
nothing per frame. Single-world ports cost what they cost now.

### 5.4 Tests (new §28)

- One-world fold is bit-exact with the world.
- Two-world fold conserves mass and population across a 600-year jump.
- `addPort` still fails on a star that already has a port. A second *world*
  on that star succeeds and does not bump `portCount`.
- An outpost star still refuses a new world.
- Opening and closing the system view does not call settle extra times
  beyond the existing inspection contract.

## 6. T4 — Statistical intra, counted in delta-v

Intra-system distance is **not** zero. We already have the calculator
(`src/math/deltav.js`) and the schema (`buildBodyNodes` /
`buildInterEdges`, the same graph the schematic and the delta-v map draw).
T4 reads that graph once per founding and turns it into a **couple**: how
much of a world's surplus actually arrives at another world, and how much
of a world's production can be lifted to the star-port. That is what
develops the system — a compact, shallow-well neighbourhood feeds itself
and exports; a scattered, deep-well one does not, even if W4's yields are
fine.

Hohmann times are days to a few years (Earth–Mars `t_H` is 259 d). Colony
settles are decades to millennia. Latency is noise at this calendar;
**energy is not**. T4 taxes by delta-v and ignores pipeline delay. T6 is
the series that would make time real.

### 6.1 Graph, filled at founding, never in settle

`fillIntraGraph(port, system)` runs from `addPort` / `addWorld` (and from
a test). It uses module scratch: `createBodyParam` × `MAX_BODIES`,
`createInterEdge` × `MAX_BODIES²`, `buildBodyNodes`, `legLoToLo`. No
allocation after the first call. Same seed, same system record, same
numbers as the delta-v map — if the map says 4.86 km/s LEO→LMO, the
couple uses that 4.86.

Per world slot, stored on the port (typed arrays, 6 and 6×6):

```
well[s]      // m/s. Surface→LO if the body has a surface; else 0
             // (giants and cloud-top habitats live at LO).
land[s]      // m/s. LO→surface, aero credit included; 0 if no surface.
dv[s,t]      // m/s. well[s] + legLoToLo(s,t).dvLoToLo + land[t]
             // (nuclear, aerocapture on). 0 on the diagonal.
tH[s,t]      // s. Hohmann time, readout only in this series.
couple[s,t]  // 1 / (1 + (dv[s,t] / DV_REF)²)     DV_REF = 10e3 m/s
lift[s]      // 1 / (1 + well[s] / DV_REF)         climb to the star-port
access[s]    // mean couple[s, u] over live u ≠ s; 1 if worldCount === 1
```

The reference ship is `DeltaVLib.SHIP_CLASSES` `nuclear` (in-system, 40 km/s
tank, 80 t). It does not cap couple at the tank: a 50 km/s pair is hard
(`couple ≈ 0.04`), not impossible. Isolation is graded so a Kuiper camp
still exists, it just does not feed the capital.

`dvSurfaceToSurface` may live in `deltav.js` as a thin wrapper
(`well + lo-lo + land`) so `dv-map-test.js` can pin Earth→Mars aero against
the published 16.02 km/s. If it does not land there, economy.js sums the
three already-public functions and the pin lives in `trade-test.js` §29
with a recorded Solar-System fixture.

Recompute the slot's row and column when a world is added. Outposts stay
in the graph (the well did not move) but drop out of `access` means.

### 6.2 Flow, couple-weighted

Between worlds of the same port, once per settle, after each world's own
produce/consume and before the fold. Frozen at the start of the interval,
like coverage.

For each intra family `f` in `{bulk, goods, pax}`:

1. Each world's `exportable_f` / `demand_f` is the sum of member resources.
   Passenger is a **flow**, not a warehouse line:
   `paxOut = pop * 0.02 * years` if `coverage ≥ 0.6` and `pop < 0.8·K`,
   else 0. `paxIn` is capacity room times habitat. Misery does not attract
   (coverage < 0.6 sends and receives nothing). People moved this way are
   population, not `stock[people]`.
2. For each exporter `s` and demander `t`, the offered slice is
   `exportable_s * demand_t * couple[s,t] / Σ_u (demand_u * couple[s,u])`.
   Cap by `t`'s warehouse (or `K − pop` for passengers). A pair with
   `couple ≈ 0` does not trade, even if one has ore and the other needs it.
3. Store `intraFlow[s,t,f]` (preallocated 6×6×3) for T5 dashes.

One-world ports: all flows zero, `access = 1`, `lift` still applies to
inter-star (6.3).

Closed form: applied over the same `Δt` the settle integrated. Not claimed
exact when a stock hits a cap mid-interval.

No queue events. No per-frame work.

### 6.3 How delta-v develops the system

The couple is not a readout. It changes what a star becomes.

**Feedstock reaches factories only along cheap edges.** A terran next to a
belt (`dv` a few km/s, `couple` ~0.7–1) eats the belt's ore and grows. The
same terran with the only mine on a scattered ice dwarf (`dv` tens of km/s)
runs autarkic, coverage falls, the fold stays small. W4 says what a world
*can* make; T4 says whether the rest of the star can *use* it.

**Lift taxes the star-port.** Inter-star `collectOutbound` takes
`exportable_s[r] * lift[s]`, not the full warehouse. A deep-well lava world
is a local mine; a belt (tiny `well`) is the export pier. Giants live at
LO (`well = 0`) and become cheap hubs — which matches `HABITAT[gas]` being
a place to live, not a place to dig (W4).

**Access is a growth weight, not a second ODE.** After T4's transfers,
`settleColony` has already run; do not rerun it. `world.access` is folded
into the port and shown. The next settle sees the stocks T4 actually
moved, so coverage — and then pop — move for free. No `coverage *= access`
inside the logistic (that would double-count isolation and break the
closed form's published `g`).

**Founding a second world** (5.2) ranks by
`habitat * couple(candidate, world0) / (1 + well[candidate] / DV_REF)`.
A 50 km/s-away dwarf is a bad camp even if its ore cell is 1.4. The
refusal `too expensive to reach` is this score below `MIN_FOUND_COUPLE`.

**One-world stars still feel lift.** The start-map scenario (one world per
star, §8 of `trade-plan.md`) does not gain intra flow, but a high-well
capital exports less of its bulk-derived goods. Re-measure the growth
table only if that moves the windows; prefer retuning `DV_REF` over
widening them. Belts as capitals should get *easier* to export from, which
is W4's intended direction.

### 6.4 Tests (new §29)

- Graph determinism: same system twice, bit-exact `dv` / `couple` / `lift`.
  The numbers equal a direct `DeltaVLib` call on the same bodies.
- Earth–Mars (or the Solar fixture already in `dv-map-test.js`):
  `dv[earth,mars]` matches the published surface→surface aero pin to the
  same tolerance the map uses; `couple` is in (0.2, 0.8).
- A belt next to a terran moves more ore in 20 y than the same pair with
  the belt's `a` stretched 10× (Hohmann dv up, couple down, mass still
  conserved).
- A starving world (`coverage < 0.6`) neither sends nor receives
  passengers.
- A one-world port's intra flows are all zero; its `lift < 1` iff
  `well > 0`.
- `collectOutbound` on a deep-well world is strictly less than its
  `exportableOf` for ore-derived goods; a belt world's lift is closer to 1
  than a lava world's on the same star.
- Founding score prefers the closer of two equal-habitat sites.
- Inter-star hull counts and queue size are unchanged by T4 (same
  `peekNext` before/after a 600-year run on a one-world network).

## 7. T5 — System-view picture

`system-layer.js`, only while a port exists for the opened star. The galaxy
overlay stays hidden in system view (`trade-plan.md` §4).

- World markers on the planet/belt the site names: radius from
  `2 + 5.5√(pop/K)` in schematic pixels, growth colour as the galaxy rings,
  W1 hollow grey for an outpost, W9 dashed amber if starving.
- Ambient dashes along the schematic for the three largest `intraFlow`
  entries of the last settle: dim, cargo-coloured, **no state**. Closing V
  drops the draw; it does not drop the rates.
- Card under `#sysread`:

  ```
  worlds    2 · Vega III 4.1 M  · belt 0.6 M
  intra     bulk Vega III ← belt · 6.1 km/s · couple 0.73
  lift      Vega III 0.81 · belt 0.97
  inter     rare surplus · food scarce
  ```

The km/s is `dv[s,t]`, the same number the delta-v map would print for
that pair. No intra hull interpolation. If a dash looks like a ship, it
is a lie we accept until T6.

Browser items go on `deferred-browser-visual-plan.md`: world markers, a
dash, the card.

## 8. T6 — deferred: inter-planet trade, own time, own queue

Not in this series. Recorded so a later pass does not invent a third
design.

- **Clock.** The system-time ladder already on the schematic
  (`SystemLayer.SYSTIME_LADDER`: frozen / follow-camera / 1e-4…100 y/s).
  Intra legs are hours to years; they cannot ride the inter-star ladder
  (100–2 000 y/s), which is the teleport T6 exists to avoid.
- **Queue.** `net.intraQ = createQueue()`, kinds `INTRA_LOAD` /
  `INTRA_ARRIVE` (and a wait). One event per intra hull. Drained from
  `system-layer` / `main.js` on the system clock, never from `trade.step`.
  Mixing the two heaps is the 64-slot-ledger failure mode in a new hat.
- **Hulls.** Preallocated per opened system, small (≤ 12). Load T1's three
  intra families, book with `legTimes` against `nuclear` (or a later intra
  class), write world stocks on arrive. Couple-weighted T4 is the
  *acceptance band* for their throughput, not a second stock pile.
- **Closed view.** System clock pauses; `intraQ` pauses with it; T4
  remains the operator for that port so a 5 000-year galaxy jump does not
  depend on whether V was open. Opening V does not rewind T4; it starts
  a fleet whose average should match the couple the jump already used.
- **Not** a visual-only overlay discarded on close (that was the rejected
  reading). **Not** events on `net.queue`.

## 9. What this does not do (refused, with reasons)

| Idea | Why not |
|---|---|
| Replace 13 yields with a 7-ease vector per star | Planet *type* decides what a world makes; families are a filter, not a map |
| `advanceColony` in 0.25 y steps | At 100–2 000 y/s every span coarsens. Closed form is the product |
| Gate world settle on system view | B1: the economy becomes a still picture. T4 always runs |
| Zero-distance intra rates | The delta-v map already says the pair is 5–50 km/s. Zero made every belt identical to every neighbour and is the original reason `trade-plan.md` §3 forbids intra *ships* |
| Intra hulls on the inter-star queue | Different calendar; T6 is a second heap or it does not return |
| `coverage *= access` inside the logistic | Double-counts isolation (T4 already withheld the goods) and retunes `g` |
| Capital inside the settle ODE | F6 / T7, event-boundary tiers |
| Call a starting world an "outpost" | W1 already uses that word for a *failed* colony |
| Gravity's cargo-container seeding | Game-mode / ballistic, out of scope |
| Money | F4, unchanged |

## 10. Order, dependencies, size

| Order | Item | Depends on | Size | Commit |
|---|---|---|---|---|
| 1 | T1 inter-star families | W5 tags (readout) | S | `trade.19: inter-star hulls carry seven goods; bulk stays home` |
| 2 | T3 world pool + T2 fold | W1 outposts, W3 founding, W4 composition | M | `trade.20: a star is many worlds and one port` |
| 3 | T4 graph + couple + rates + lift | T3, `deltav.js` | M | `trade.21: intra flow is a delta-v statistic; cheap wells develop, deep ones do not` |
| 4 | T5 system-view picture | T4, W9 overlay language | S–M | `trade.22: the opened system shows its worlds, its flows and its km/s` |

T1 can land without T3: a one-world network already stops shipping ore.
T4 without two worlds still lifts the capital's exports.

W4 must already have re-pinned `trade-plan.md` §8. T4's lift on one-world
capitals is the only law that can move that table without T8; re-measure
and prefer `DV_REF` as the knob.

## 11. Validation

Every commit:

```
node experiments/trade-test.js
node experiments/exec-queue-test.js
node experiments/dv-map-test.js
node experiments/m1-smoke-test.js
python3 scripts/run.py changed
```

Before the series closes: `python3 scripts/run.py all-tests`, and the
browser pass for T5 (world markers, a dash, the card, a km/s that matches
the delta-v map for the same pair).

New sections, appended: §27 families, §28 worlds/fold, §29 intra graph
and rates, §30 system-view data (no DOM). Existing §16 growth table is
re-measured if one-world lift moves it.

## 12. Docs

- `trade-plan.md`: amend §2 (families; ore/volatiles are intra), §3 (one
  port, many worlds; fold; lift), §4 (system-view card). It stays the
  reimplementable spec of the *shipped* economy plus this series once it
  lands.
- `trade-2-plan.md`: this file is the following series; T7 is F6; T6 is
  the intra fleet with its own clock.
- `plan.md` §19: index this file beside `trade-2-plan.md`.
- `README.md`: *Colonies and trade* gains the 7+3 split, "open V to see
  the worlds", and that intra cost is the delta-v map.
- `findings-pitfalls-skills.md`: "intra movement is a delta-v statistic,
  never a hull on the galaxy queue"; "do not gate factories on the system
  view"; "two calendars do not share a heap".

## 13. Risks

| Risk | Mitigation |
|---|---|
| Fold and worlds drift apart | §28 mass conservation; transfers always distribute before the next fold |
| Six worlds × 64 ports blows the tick | closed form, cap 6, start map still 1 world |
| Intra passenger drains a capital into its belt | coverage ≥ 0.6 gate, `pop < 0.8·K`, habitat-weighted *and* couple-weighted receiver; `HABITAT_BELT = 0.10` still caps it |
| Lift starves every high-well capital and breaks §8 | one-world re-measure; `DV_REF` 10 km/s leaves Earth-like wells near 0.5–0.8, not 0; belts get easier, which W4 wants |
| `couple` disagrees with the delta-v map | same `legLoToLo` / well functions, same body params; §29 pins equality |
| T5 dashes read as a second fleet | dim, no interpolation, legend `flow · km/s`; T6 stays deferred |
| T6 later corrupts galaxy jumps | closed view pauses `intraQ`; T4 is the jump operator; mixing heaps is refused |
