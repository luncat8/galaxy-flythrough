# Trade, resources, economy and colony growth — `main` vs `31c6d5a` (ui.19)

Two implementations of the same brief (`archive/draft-colony-resources-trade-fab.md`).
This is a comparison and a menu, not a plan. It was written by reading both trees:
`git archive 31c6d5a` next to `HEAD` (`61ddb96`).

- **old** = `31c6d5a4b9e06eb87b79fb334c0defc535b5a0c4`, "ui.19: colony trade made visible",
  the last commit of the *colony-economy* line (`colony-economy-plan.md`,
  `src/core/colony.js` + a 194-line `src/core/trade.js`).
- **main** = the *trade* line (`trade-plan.md`, `src/core/economy.js` +
  a 1 938-line `src/core/trade.js` + `src/core/exec-queue.js`).

The old branch is not an ancestor of `main`; the two lines share only the draft.

## 1. At a glance

| | old `31c6d5a` | main `61ddb96` |
|---|---|---|
| Core files | `colony.js` 399 L, `trade.js` 194 L | `economy.js` 594 L, `trade.js` 1 938 L, `exec-queue.js` 148 L |
| Resources | 6, one unit = 1 ton, **credits** | 13 in 6 families, unit **mass** in tonnes, no money |
| Site map | one ease vector per **system** | per **(star, planet/belt slot)** yield vector |
| Factories | fixed-step integration, 0.25 y steps, ≤ 2 048 steps | **closed-form settle** over arbitrary spans |
| Growth | logistic on `comfort`, `K` from food ease + capital | logistic on weighted **coverage**, `K` from habitat × mass × stability |
| Colony scale | 0.05–50 **thousand** people | 0.02–900 **million** people |
| Plumbing | colony `capital` invested from surplus | no capital; fixed potential output + industrial bill of materials |
| Freight | **commissioned routes**, one convoy per route, period 2 y, cap 50 t | autonomous freighters, 3 hulls, cargo sized to destination demand |
| Transit | fast 0.2 ly/y (drift ignored) or generation 1e-4 ly/y (homing) | 2–4.5 ly/y, ≥ 50 y per leg, live-geometry intercept + pursuit |
| Colonisation | automatic nearest-star scan, 24 colonies / 8 in flight | event-driven expeditions, 64 ports / 24 in flight, candidate pool + frontier scan |
| Economy clock | ship clock (game) or `star × 1e6` (sync): 1e5 y/s at 0.1 Myr/s | own ladder 0–2 000 y/s, or `star × 1 000` |
| Player | L/Shift+L **with credits**, *Found colony*, *Commission route*, route cancel | L/Shift+L stock transfers, *Send expedition* |
| Events | 64-slot ledger: route depart/arrive, milestone, famine, expedition | typed-array heap: one revision-checked event per hull + one tick |
| UI | Colonies & routes panel (colony list, route list + ✕, commission row, log) | Trade panel (clock, sync, generation, top-6 colonies, colonisation block) |
| Tests | `colony-test` 37, `trade-test` 24 | `trade-test` 134, `exec-queue-test` 27, `m1-smoke` 117 |

## 2. Clocks

**old.** `econY` is the one economy timeline. In game mode it is the shared ship
clock. In observer mode it is `dtEconY = dtStar * 1e6` **only when `tradeSync` is on**
(`main.js:5596`). With the sync off the observer's economy never lands at all —
ui.19 worked around it by shipping `sync` on and star time at 0.1 Myr/s.
At that pairing the economy clock is **100 000 trade years per wall second**.

**main.** Two independent authored clocks: the trade ladder
`[0…2 000] y/s`, default 100, plus an optional coupling
`SYNC_YEARS_PER_MYR = 1000` (`trade.js:146`) so 0.1 Myr/s of sky is 100 y/s of
trade and 2 Myr/s is the 2 000 y/s ceiling. `clockRate()` owns both rules; a
negative star rate (observer fly coupling) is a pause, not reverse time.

Verdict: main. The old pairing made every other number in its own economy
meaningless (see §9, B2/B3).

## 3. Resources and the resource map

| | old | main |
|---|---|---|
| ids | rare, chem, anti, food, fab, info | ore, volatile, rare, chem, amat, food, bio, people, robots, compute, soft, data, art |
| map granularity | system-wide `ease[6]`, then jitter ±0.06 | per-site `yield[13]`, jitter 0.7–1.3 |
| drivers | metal, luminosity, rocky/giant/belt fractions, terran/HZ counts | metallicity, age, insolation, surface temperature, planet display type, belt row |
| industry | none — production is `ease × RATE × driver` | `INPUT` bill of materials: factories consume 26 row/column goods, which is what gives ore and volatiles a market |
| scale | tons, `RATE` 400–2 000 t/y | stock units, `PROD` per million per year, `unitMassT` bridges to the hold |
| prices | `base` cr/t, `price = base·(1.6 − 1.2·supply)` | none (worth is a routing weight) |

Old is the simpler, readable model; main is the one where a planet's *type*
decides what it can make and where bulk goods have a reason to move.
Verdict: main, clearly — pick the old resource *count* only if the 13-row
readout is too much, and even then it costs the bill of materials.

Note the one place old is genuinely richer: **prices as an information channel**
(see F4/F5). Main has no scalar that says "this world wants that good badly"
except `demandOf`, which is only shown as a text list.

## 4. Colony growth

**old `advanceColony`** (`colony.js:215`), per 0.25 y step:

```
prod[r] = ease[r]·RATE[r]·driver[r]·dt      driver: capital/25, pop/50, pop/100, (capital/25)²
need[r] = pop·NEED[r]·dt                    NEED: food 20, info 1, fab .5, rare .2, chem .2, anti .05
comfort = 1 − Σshortfall / Σneed
K       = 40·(0.4 + 0.6·ease.food)·(1 + capital/25)      [thousand persons]
dPop    = 0.06·comfort·(1 − pop/K)·pop·dt − (comfort<0.4 ? 0.04·pop·dt : 0)
dCap    = 0.02·comfort·Σsurplus·dt − 0.01·capital·dt
```

- Capital is a second stock: it gates production, is fed by surplus and decays.
  Antimatter is capital²-gated, so it is a late-game export. This is the only
  real *investment* loop either version has.
- Pop floors at 0.05 k and never reaches zero: there is **no abandonment**.
- Stock is unbounded (prices floor at 0.4·base forever).
- Determinism claim: one 10 y advance == forty 0.25 y advances — true only while
  the span is ≤ 512 y; past that `coarse` is set and the chunking *is* the answer.

**main `settleColony`** (`economy.js:450`):

```
coverage = Σw[r]·min(1, (out[r]·P + stock[r]/20)/(NEED[r]·P)) / Σw
g        = coverage/40 − (1−coverage)/120
P(t)     = K/(1 + (K/P0 − 1)·e^-gt)                  closed form (expm1/log1p)
stock   += (out[r] − input[r]) · ∫P dt               clamped to [0, cap]
```

- No capital, no investment; production is potential output at authored density.
- Capacity is physical (`900 × habitat × mass^0.3 × stability`), stocks have
  warehouses, and a colony below 0.02 M people is abandoned.
- Coverage frozen at the start of each settle: constant-coverage intervals
  compose exactly, supply-limited ones do not. This is documented and tested;
  inspection can change later history. In exchange, a 500-year jump costs the
  same as a 1-year one and a million-year jump cannot blow up the frame.

Verdict: main's growth law and scale are much better; old's **capital** is the
one idea worth taking back (F6).

## 5. Trade and freight

**old.** A route is a record between two colonies (`commissionRoute`), a period
of 2 y and a per-departure cap of 50 t, guarded by the origin's own 2-year need.
Departures are ledger events; arrivals are scheduled (fast law) or homing
convoys (generation law). Cargo is always the origin's single best export.

**main.** No routes: each hull, at each arrival, scores every free resource
against every port's `demandOf` with `demand·worth/(1+ly/100)`, ships at most the
hold, the exportable stock, the destination's free room and 150 years of demand,
keeps 25 % of warehouse capacity, re-routes an undeliverable leftover and
jettisons rather than deadlock. Legs are booked against live sky: a linear plan
from cached positions+rates, then an exact intercept for the winner, pursuit,
and a turn-around past 1.6× the cap.

Verdict: main, on every axis (throughput, adaptivity, moving sky, cargo sizing).
Old's route record is worth taking back **only as player intent** (F2), not as
the freight engine.

## 6. Colonisation and expansion

| | old | main |
|---|---|---|
| trigger | `expansionStep()` each frame, per-colony `nextExpandY`, comfort ≥ 0.4, 24 colonies, 8 in flight | 25-year tick + per-port 900-year cooldown, 64 ports, 24 in flight |
| target search | `selection.beginSelectAround(radius, 12)` — a budgeted **sweep of the live selection set**, 39 ly fast / 98 ly generation | candidate pool + `expandFrontierFromField` ring scan (4 000 stars per 0.5 s, 4 new worlds per scan) |
| target record | star key + snapshot position + the resource map generated at departure | full `site` record (type, mass, flags, ref), star reserved for the whole flight |
| arrival | `createColony(...)` from the carried map; commissions a route home and a second to a near neighbour | founds on the reserved site, people become the population, warehouses 45 %, joiner in the same routing loop |
| failure | a taken star → founders are guests; no refund, no hull return | taken/out-of-reach → volunteers refunded, hull docks and loads |

Verdict: main. The old expansion is coupled to the *rendered selection set* —
if those stars are not resident, nothing is found; and it aborts and retries
whenever the user starts their own sweep. The old "mesh by auto-commissioning
two routes" is nice scenery, but main's freighter network produces the same
picture without route objects.

## 7. Player agency and money

old, at a docked port: 400 cr per hull, `L` buys the port's best export at its
own market price bounded by credits, `Shift+L` sells the hold back at the same
price; **Found colony** (free, at a port whose star has none); **Commission
route** from the Flight panel; route **✕ cancel** in the panel.
Money is local: a market reads only its own colony, so the player's margin is a
real ease differential between two ports.

main: `L`/`Shift+L` move actual stock with a tonnage hold and unit masses; no
credits, no prices, no player founding, no route control. The player's only
economic lever is the **Send expedition** button.

Verdict: this is main's one genuine gap. F1/F2/F4/F5 are the menu items.

## 8. UI and visibility

| | old | main |
|---|---|---|
| panel | *Colonies & routes*: seed button, expansion checkbox, generation ships, events log, colony list (name · pop · comfort, click selects), route list (origin → dest · next departure · ✕), commission row (two selects) | *Trade*: clock slider, sync, generation ships, Send expedition, one-line state (ports/ships/founded/hauled/years · live routes · turned back), top-6 colonies with pop bar and ↑%/y, colonisation block with the closed gate and next launch |
| overlay | port rings, route edges, convoy dots (freight cyan, founders amber), home ring | port rings scaled `2 + 5.5√(pop/K)`, growth-coloured (teal/amber/red), founding ring < 150 y, filled core > 60 % K, **candidate crosses**, faint route legs, amber founding hull |
| system view | pop, growth arc, capital, comfort, six market rows (ease bar · stock · price · tag) | pop/capacity, age, coverage, growth, 13 yields, sells + needs |
| HUD | economy line | economy line |
| H | centre on first colony (ui.19) | centre on the capital |

Old's lists are clickable and show *standing routes with their next departure*;
main's rows are text but the overlay says more about growth. Neither shows a
forward calendar (F9).

## 9. Bugs in `31c6d5a` — so we do not port the wrong half

These are the reasons the old branch reads well in prose and badly in motion.
Line numbers are from that tree.

**B1 — the economy only advances when the player looks at it.** `advanceColony`
is called from exactly two places: `colonyArrive` (`main.js:3943`) and
`colonyInspect` (`main.js:3953`, reached only from opening the system view at
`main.js:1346`). Nothing settles colonies on a tick, on a convoy arrival, or in
the frame loop. A colony starts with `stock = 0` and `comfort = 1`, so in a
watched scenario:

- populations are frozen at their founding values forever;
- no milestone or famine event is ever emitted (they are emitted *inside*
  `advanceColony`);
- `departureCargo` reads an empty stock, so **commissioned routes never carry**
  anything until someone opens V on that star once;
- the expansion gate `colony.comfort < 0.4` reads the founding 1.0, so starving
  colonies keep launching expeditions.

This is the headline bug: the old version's own scenario is a still picture with
moving dots on top.

**B2 — the ledger is 64 slots and silently drops the newest event.**
`LEDGER_CAP = 64` (`colony.js:52`), `schedule()` returns `false` when full
(`colony.js:71`) and no caller checks. A route re-arms every `PERIOD_Y = 2`
(`trade.js:37`), so under the ui.19 default pairing (1e5 trade y/s) each route
wants ~50 000 departures per wall second while the whole ledger holds 64 events
for every route, milestone, famine and expedition. When `schedule` fails the
route stops re-arming — permanently, and silently.

**B3 — the "fast" transit law is invisible at the shipped pace.** `FAST_LY_Y =
0.2` (`trade.js:34`): 100 ly is 500 y, i.e. **5 ms** at 1e5 y/s. That is why
ui.19 had to make generation ships (1e-4 ly/y) the default and pin star time to
0.1 Myr/s — the workaround became the scenario. Main's answer is the other way
round: an authored hull table, a 50-year leg floor, and a sync rate of 1/1 000
rather than 1:1.

**B4 — chunk determinism does not survive the synced clock.** `MAX_STEPS =
2048` at `BASE_DT = 0.25` means any span over 512 y coarsens. In observer mode
with sync, every settle span is thousands of years, so *every* advance is
`coarse` and the "one 10 y advance == forty 0.25 y advances" property is never
exercised in the configuration that ships.

**B5 — expansion depends on what is drawn.** `expansionStep` calls
`selection.beginSelectAround(...)` and steps it under a 2 ms/frame budget
(`ECON_SCAN_MS`). It sees only stars in the selection residency, it aborts and
retries when the user starts their own sweep, and a camera parked away from the
sky finds nothing. Main's candidate pool + frontier scan is decoupled from
rendering, and its blind endpoints are handled explicitly.

**B6 — no warehouse, no abandonment, no real throughput.** Stocks are unbounded,
prices floor at 0.4·base and stay there, convoys carry at most 50 t, and a
colony can never die (`pop` floors at 0.05 k). Main's caps, `demandOf` and
abandonment are what make routing decisions meaningful.

**B7 — small-network caps.** 24 colonies, 8 expeditions in flight, 32 net
colonies, 64 net ships. Main: 64 ports, 24 founding in flight, 128 hulls.

**B8 — cosmetic.** `EV_EXPEDITION_ARRIVE` is exported twice (`colony.js`), and
`colonies` names get a literal `" colony"` suffix at both founding sites.

The old *tests* passed 37/37 and 24/24 because they test the pure laws
(`advanceColony`, prices, ETA, convoy homing) and never the wiring that decides
*when* to call them. Main's `trade-test` 134 checks include the 600-year jump
invariance, the network growth curve and one-live-event-per-hull — the class of
test that would have caught B1 and B2.

## 10. What main already does better (do not "restore" these)

- Closed-form settle + jump invariance; no per-frame colony cost, no step cap.
- Physical capacity, warehouses, demand, abandonment, 13 goods with an input matrix.
- Live-sky distances everywhere, intercept booking, pursuit, divert with refund.
- Event queue with revisions, stale detection, budget, monotonic clock, reported lag.
- Idle-hull backoff (3 791 ms → 389 ms at the top rate), generation-mode reserve scaling.
- Overlay that shows growth (ring radius, colour, founding ring, candidate crosses).
- Test coverage that pins the integration, not just the laws.

## 11. Candidate picks

Sizes are the code I expect to touch, not ceremony.

| # | Pick | From old | Where it lands on main | Size | Risk | My call |
|---|---|---|---|---|---|---|
| **F1** | **Player-foundable colonies**: a *Found colony* action at a docked port with no colony; free; uses `pickBestSite` on the star, respects 1/star, `MAX_PORTS`, lands a typed `colony` asset | `gameFoundColony` | `trade.js` new `playerFound()`, Flight panel button, `selection-store` asset | S–M | low | **do** |
| **F2** | **Standing routes as player intent**: commission a pair, freighters prefer it at load time (not forced), route list with next departure and ✕ cancel; cancel keeps slots stable | `commissionRoute`, `removeRoute`, panel | `trade.js` route records + `loadAtPort` preference + ledger/queue re-arm + panel + overlay edges | M–L | med (two routing laws to keep consistent) | plan, then do a light version |
| **F3** | **Narrated colony events**: population milestones, famine enter/lift, abandonment, founding — bounded ring buffer + panel/log lines | ledger `EV_MILESTONE`/`EV_FAMINE`, `econLogLine` | `economy.js` emits on settle, `trade.js` logs, Trade panel tail | S–M | low | **do** |
| **F4** | **Credits + market prices**: per-hull credits, price = f(supply), `L` buys / `Shift+L` sells for money | market + `buyAtPort`/`sellAtPort` | `ship.js` credits, `economy.js` price law, main.js HUD, presets, tests | M–L | high (changes the whole "no money" contract) | decide with you |
| **F5** | **Price index readout, no money**: surplus/fair/scarce tag and a cr-equivalent per resource from stock+ease, shown in the system readout and export list | market tag | `economy.js` + readout text | S | low | **do** (cheap, and it makes `demandOf` legible) |
| **F6** | **Capital / development**: a per-colony investment stock that raises output and gates antimatter | `capital` in `advanceColony` | would break the closed-form settle as written; viable as *event-boundary tiers* (settle stays closed-form between events) | L | med–high | plan only for now |
| **F7** | **Expansion arm/disarm + per-port readiness**: a panel toggle and "why is this port resting / not big enough" per row | `expansionOn`, `nextExpandY` | `trade.js` flag + panel | S | low | **do** |
| **F8** | **Clickable colony rows and colony assets**: clicking a colony row selects its star; founding lands a typed asset with founded/capital/export in the title | `econ-colonies`, `selectionStore` | main.js list + selection store | S | low | **do** |
| **F9** | **Forward calendar**: next N queue events (arrival at X in Y y, expedition to Z, next tick) in the Trade panel | route "next departure" column | `exec-queue.js` peek-N + panel | S–M | low | **do** (fills the gap if F2 is deferred) |
| **F10** | **Starvation alarm on the sky**: colony ring/HUD marks `coverage < 0.3` and abandonment | `starving` flag | label layer + `colonyBar` | S | low | **do** |

Explicitly **not** worth porting: the 6-resource table, the fixed-step
integrator, the 64-slot ledger, the fast-freight law, select-around expansion,
thousands-scale population, unbounded stock, the 24-colony cap, and the
"no abandonment" rule. Each is either replaced by a stronger mechanism on main
or was the cause of B1–B7.

## 12. Questions

1. Which of F1–F10 do you want? (Numbers are enough.)
2. F4 (money) and F6 (capital) are the two that change main's stated design
   contract ("no prices, credits or contracts"; fixed potential output). Do you
   want either, or should the economy stay abstract?
3. Where should the picked ones land: an amendment to `trade-plan.md` first,
   a refactor of `economy.js`/`trade.js`, or straight implementation?
