# Trade — colonies, resources and the event queue

The brief is `archive/draft-colony-resources-trade-fab.md`: deterministic resource
maps, population needs, colonisation and trade routes, with factories evaluated
**on events or inspection, never per frame**. This is a CPU-only, pipeline-neutral
series: no star-buffer or WGSL changes. Its log is `archive/trade.x-worklog.md`.

## 1. Clocks and scope

Star time (Myr/s), player flight time and trade time are independent. Trade time
starts at zero, in years, on the ladder
`[0, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000]` years/wall-second,
default 100; zero pauses. A frame drains through `time + rate·min(dt, 0.25)` then
sets the clock to that target. The wall-delta clamp avoids unbounded background-tab
catch-up; explicit simulation jumps use the same queue without the clamp.

This pass uses **abstract trade travel**, not the player's relativistic flight
law. Hulls travel at 2, 3 and 4.5 ly/trade-year; this is intentionally faster than
light so the sparse rendered star sample can sustain routes on colony timescales.
It must not be presented as a fraction of c or a `route.interstellarLeg` result.
Changing to physical travel requires retuning the network density, warehouses and
population together, not just replacing one speed constant.

No prices, credits or contracts. Resource worth is a routing weight, not money.
The G4 container hook is replaced by transfers of actual port stocks.

## 2. Resources and the stable site map

Thirteen resources, six families (raw, synth, life, goods, data, culture):

| id | name | unit mass (t) | routing worth |
|---|---|---|---|
| ore | ore | 40 | 0.25 |
| volatile | volatiles | 30 | 0.30 |
| rare | rare elements | 60 | 6 |
| chem | synth chemicals | 12 | 1.2 |
| amat | antimatter | 0.5 | 12 |
| food | food & seed | 8 | 0.8 |
| bio | biotech samples | 4 | 4 |
| people | colonists | 2 | 3 |
| robots | factory cores | 25 | 2.5 |
| compute | computers | 6 | 3.5 |
| soft | software & AI | 0.2 | 5 |
| data | world data | 0.2 | 4 |
| art | unique items | 1 | 8 |

`economy.js` owns the authored tables: `PLANET` (13 rows × ten display types
plus a belt), `HABITAT`, `PROD`, `NEED`, `NEED_WEIGHT` and `INPUT` (the industrial
bill of materials). Their columns follow `planets.DISPLAY_INDEX`, pinned by tests.
Ore/volatiles are bulk feedstock; the other eleven cover the brief's specialist
exports. All thirteen have some productive world type.

A site is `(star key, planet-or-belt kind, index)` plus the generated physical
properties and an **owned copy** of the star's pick reference. Planet slots and
belt slots occupy distinct hash channels. With
`seed = planets.systemSeed(key, model.seed, starBlockKind)`, yields are

```
yield[r] = clamp(PLANET[r][type] * starFactor(r, site)
                 * (0.7 + 0.6 * hash01At(seed, 512 + slot*16 + r)), 0, 2.5)
```

Star factors use metallicity, age, insolation and surface temperature. Terran
flags boost food, biotech and volunteers by 1.3; the habitable-zone flag boosts
food/biotech by 1.15. No PRNG state and no reroll on inspection.

### 2.1 Population and lazy factories

Population `P` and carrying capacity `K` are millions. `K = max(1, 900 * habitat
* clamp(mass^0.3, 0.5, 2.5) * stability)`; giant/white-dwarf stability factors
are 0.7/0.6. A belt uses habitat 0.10. Population stays in `[0, K]`.

Per million-year, `out[r] = PROD[r] * yield[r]` and
`input[r] = NEED[r] + sum(out[g] * INPUT[g,r])`. This is a **potential-output
model**, not a stock-conserving recipe solver: missing factory feedstock creates
import demand but does not switch individual factories off. A future constrained
factory model must specify those switches explicitly.

Warehouses hold `30 + 150 * max(out[r], input[r]) * K` units. Seed colonies
start at 60% storage, population `0.25 + 0.01*K` (capped at K), and a stable
hash age of 10–250 years; setup settles that age to the discovery time.

Growth coverage weights household needs, not industrial inputs:

```
coverage = sum(w[r] * min(1, (out[r]*P + stock[r]/20)/(NEED[r]*P))) / sum(w)
g = coverage/80 - (1-coverage)/120
P(t) = K / (1 + (K/P0 - 1)*exp(-g*t))
stock[r] += (out[r] - input[r]) * integral(P dt)   // clamped to [0, cap]
```

Use cancellation/overflow-safe logistic evaluation (`expm1`, `log1p`), including
zero growth, equilibrium at K, and very long positive/negative intervals. Below
0.02 M a colony is abandoned: helpers refuse transfers/routing to it. Port slots
remain stable tombstones so in-flight references never change; no slot compaction
or revival in this pass. Public player-port lookup excludes abandoned colonies.

**Approximation contract:** coverage is frozen at the start of each settle.
Constant-coverage intervals compose exactly (up to floating point); supply-limited
intervals generally do not. Inspection can therefore change subsequent population
history. There is no automatic stock-boundary event or claimed exact solution for
changing coverage. Network jump invariance means identical *external actions and
event times* give identical state, not that arbitrary inspection schedules agree.

Settle on arrival, dispatch, destination scoring, the 25-year expedition check,
and the opened system's 4 Hz readout. Never settle all colonies per frame.

## 3. Discovery and the network

One colony per star avoids zero-distance intra-system freight winning all route
scores. Up to 32 seed ports grow toward 64 total port slots; 256 candidate sites.
For a newly discovered star, a stable hash roll below 0.35 selects a seed colony
while seed slots remain. It occupies the highest-habitat planet (terran flag gets
1.5× preference), or the first belt if there is no planet. Otherwise every world
and belt becomes a candidate up to the cap. Terran worlds are preferred, **not
automatically settled**. Remember discovered keys even when candidate storage is
full: revisiting only settles, never changes the map or seeds a second colony.

On model reset seed named Milky Way landmarks first, then up to 400 procedural
field systems inside 1.2 kpc of home (both generated and Milky Way models). Stop
when seed ports and nearly all candidate slots are filled. Opening another system
with V discovers it. A reset builds a fresh deterministic network at time zero.

### 3.1 Queue and freighters

`exec-queue.js` follows the min-heap approach of `luncat8/exec_queue`: parallel
typed arrays for time, kind, owner and revision; doubling growth; pop before
handler invocation so due follow-ups run in the same drain. Equal-time order is
unspecified but deterministic for the same push stream. Empty pop is harmless.
Stale revisions are consumed without effects. No steady-state queue allocations.

The fleet has 96 preallocated ship slots, including expeditions. Seed up to 12
freighters (roughly half the initial ports); every 25 years grow toward
`min(74, max(12, floor(3 + 1.5*portCount)))`. Successful expedition hulls become
freighters; the target is not a retirement policy or a hard post-founding limit.
A network without ports has only its global tick, no orphan hulls.

| hull | hold (stock units) | ly/trade-year |
|---|---|---|
| bulk | 30,000 | 2 |
| hauler | 15,000 | 3 |
| clipper | 8,000 | 4.5 |

A leg takes `max(0.5, distanceLy/speed)` years; freight routes are 1–3000 ly.
Each ship owns exactly one live revision-checked event. The one global tick is
rescheduled from its own time, as are all follow-ups:

- `EV_ARRIVE`: settle, deposit up to storage room, keep overflow aboard, then
  `EV_LOAD` after 0.5 years.
- `EV_LOAD`: choose cargo/destination, or `EV_WAIT` after 2 years.
- `EV_WAIT`: retry the load decision.
- `EV_FOUND`: found the reserved site, convert to freighter, load after 0.5 years.
- `EV_TICK`: fleet/expedition check after 25 years.

An export keeps 25% of warehouse capacity. NPCs reserve people for expeditions;
for each other surplus resource choose demand-weighted destination score
`demand * worth / (1 + ly/100)`. Ship at most the hold, exportable stock, destination
room and 150 years of destination demand; rank load value by `1 + ly/200`.
Demand is positive `input*P - out*P - stock/20`. Ties use stable iteration order.
Overflow seeks another destination; if none wants it, NPCs jettison it rather
than deadlock the hull. No cargo is silently discarded by the player's interface.

### 3.2 Colonisation as an event

Every 25 years settle source ports and look for an expedition, at most one launch
per 200 years. Cost scales with source capacity:
`people = clamp(0.15*K, 40, 400)`, `robots = clamp(0.03*K, 10, 100)` units.
Both costs must be exportable **before** allocating a ship or deducting either.
Search free candidate systems within 300 ly; rank habitat flags and distance,
then source surplus. Check all eligible ports, not just the largest.

Reserve the **whole target star** during flight, not only its selected planet,
and count every in-flight expedition against remaining port capacity. This
prevents duplicate launches and guarantees a port slot on arrival. A reservation
is separate from `used` (successful settlement). Seed discovery must not occupy
a reserved target. An unexpected failed founding releases its reservation and
returns the hull to a scheduled source-port load; never leave a ship eventless.

On arrival the carried people become `P = amount * 0.004` million, capped at K;
start warehouses at 45%, set founded/last to the event time, and join the same
routing loop. Startup warehouses are an abstract founding grant, not a manifest
of goods subtracted from the parent. Failed missions keep their people aboard.

## 4. Player and display

At a docked trade port L loads the best spare export that fits, Shift+L unloads
up to available room. No colony means no free cargo. The player's hold is tonnes;
`unitMassT` is the bridge to stock units. Resource units are **divisible** (factory
stocks are continuous); preserve fractional units on partial unload and round
only in text. A nonempty hold tops up only its existing resource. Full unload,
class change and ship reset clear `cargoResource`. The HUD names the resource;
the Flight panel names the port and its available exports.

Y/the routes checkbox controls the label-canvas overlay, default on and hidden
in system view: faint active voyage lines, cargo-coloured interpolated ship dots,
small port rings. Resolve birth refs through the same orbit dispatch as labels;
only resident identity-matched stars are drawn. Missing endpoints hide a route,
never draw it at a stale birth position. Compute each endpoint into independent
scratch storage (the second resolution must not overwrite the first).

The system readout shows population/capacity, age, coverage/growth, all thirteen
yields, exports and imports. The Flight Trade section has clock and route controls,
counters and six largest non-abandoned ports plus sailing ships, refreshed at
4 Hz. The overlay has a one-line rate/ports/ships/queue summary. Preset fields
`trade` and `traderoutes` share defaults owned by `trade.js`.

## 5. Files, validation and remaining scope

- `src/core/exec-queue.js`: typed-array heap, push/pop/drain/peek/clear.
- `src/core/economy.js`: tables, sites, colony setup/settle and transfer helpers.
- `src/core/trade.js`: discovery, fleet, queue handlers, founding, player transfers.
- `src/core/ship.js`, `presets.js`, `input.js`: cargo state, settings and Y action.
- `src/main.js`, `src/index.html`: seeding/clocks, inspection, HUD/panel/wiring.
- `src/render/label-layer.js`: resident drawn-position trade pass.
- `experiments/trade-test.js`: deterministic maps, stable-coverage split exactness,
  long-time growth/decline, caps, demand/export laws, idempotent discovery,
  multi-millennial network and exact live-event counts, full-state jump invariance,
  expeditions/reservations/capacity, player mass conservation and overlay geometry.
- `experiments/exec-queue-test.js`: 50,000-event sorted-reference comparison,
  growth, equal timestamps, due follow-ups, boundary, clear/empty and stale handling.

No per-frame object literals/closures for simulation or drawing; setup preallocates
ports, candidates, ships and scratch arrays. New discovery may allocate records of
known keys and display text is built at 4 Hz. `step` is one drain; the queue has
one event per ship plus one tick in normal operation.

Deferred: prices/contracts, constrained recipes, inspection-independent variable
coverage, port-slot recycling, buildings/terraforming/piracy, planet-specific
docking, physically calibrated interstellar freight. Real-browser/WebGPU visual
validation remains separate; canvas-stub geometry tests are not a visual verdict.

## 6. Star-time-coupled trade controls

- Sync time: a Trade-panel checkbox couples the trade clock to the star clock. While on (and outside game mode) the network advances `starTimeRate · 10⁶` trade years per wall second instead of the ladder's years per wall second; the trade slider is disabled and the readout shows the effective star-derived rate.
- Generation ships: a second checkbox switches every hull to 1 light-year per 10 000 years (`GENERATION_LY_PER_YEAR = 1e-4` ly/y in `legYears`) and sets the star clock to 0.1 Myr/s. With sync time on a 1 ly hop takes ≈10 kyr of star time — about a tenth of a second at 0.1 Myr/s.
- Route re-timing: while the stars move (`dtStar > 0`) and the trade clock runs, in-flight voyages are re-measured against the stars' live drawn positions (`orbit.engineRecordPosition` at the current star time, resolved resident-by-resident through the label layer) and their arrivals re-timed when the remaining journey changes by more than a year. The overlay's route geometry is already drawn at live drawn positions; this keeps the schedule on the moving line. Booking uses live positions too, so a voyage's length is measured from where its endpoints are when it starts.
- Star-time slider: default range −1…2 Myr/s in 0.1 steps so small rates (0.1 Myr/s) are settable; a toggle button widens it to −1…99 Myr/s in 0.5 steps.
- Presets: `tradesync` and `tradegen` (0/1) ride beside `trade`/`traderoutes`.
