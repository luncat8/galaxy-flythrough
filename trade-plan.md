# Trade — colonies, resources and the event queue

The brief is `archive/draft-colony-resources-trade-fab.md`: deterministic resource
maps, population needs, colonisation and trade routes, with factories evaluated
**on events or inspection, never per frame**. This is a CPU-only, pipeline-neutral
series: no star-buffer or WGSL changes. Its log is `archive/trade.x-worklog.md`.

## 1. Clocks and scope

Star time (Myr/s), player flight time and trade time are separate clocks. Trade
time starts at zero, in years, on the ladder
`[0, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000]` years/wall-second,
default 100; zero pauses. A frame drains through `time + rate·min(dt, 0.25)` then
sets the clock to that target, as far as the event budget allows (§6). The clock
can instead ride the star clock through the fixed rate of §6 — the one supported
way to make colony time and galactic time move together. The wall-delta clamp avoids unbounded background-tab
catch-up; explicit simulation jumps use the same queue without the clamp.

This pass uses **abstract trade travel**, not the player's relativistic flight
law. Hulls travel at 2, 3 and 4.5 ly/trade-year; this is intentionally faster than
light so the sparse rendered star sample can sustain routes on colony timescales.
Every voyage takes at least `MIN_LEG_YEARS = 50` trade years (§8): a 10 ly freighter
hop is otherwise 2–5 years, a few frames at the 100 y/s default, and reads as a
teleport. Half a wall second per hop keeps the hulls visibly in flight.
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
scores. Four seed ports (`SEED_PORTS = 4`, §8) grow toward 64 total port slots;
256 candidate sites.
For a newly discovered star, a stable hash roll below 0.35 selects a seed colony
while seed slots remain. It occupies the highest-habitat planet (terran flag gets
1.5× preference), or the first belt if there is no planet. Otherwise every world
and belt becomes a candidate up to the cap. Terran worlds are preferred, **not
automatically settled**. Remember discovered keys even when candidate storage is
full: revisiting only settles, never changes the map or seeds a second colony.

On model reset the start map is built and discovered **nearest home first**
(`trade.startSystems` + `trade.discoverNearest`): the named landmarks (Milky Way
models) and up to 400 procedural field systems inside 1.2 kpc of home, ordered by
distance from home, not by catalogue or sample order. Stop when seed ports and
nearly all candidate slots are filled. Opening another system with V discovers
it. A reset builds a fresh deterministic network at time zero. The order is the
design: catalogue order seeded colonies 300–860 ly away with nothing in expedition
range, and the rendered field has no star within 300 ly of the Sun at all (§8).

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
| generation (§6, mode switch) | 30,000 | 0.001 |

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
per `EXPEDITION_INTERVAL = 250` years (§8 measures why not 200). Cost scales with source capacity:
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
  expeditions/reservations/capacity, player mass conservation, overlay geometry
  (including the population-scaled ring and the frontier mark), the clock laws of
  §6 (sync exchange rate, ceiling, generation-ship pacing, budgeted drain
  monotonicity and backlog) and the forced capital.
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

The trade clock and the star clock are **different calendars by construction**.
The network is authored in colony years: a 25-year tick, a 150-year warehouse, an
80-year population e-folding, voyages of tens of years. The star clock is authored
in galactic years: 0.1–2 Myr per wall second (99 Myr/s in the wide range). At a
1:1 exchange a 2 Myr/s sky asks the queue for 2·10⁶ trade years per second —
measured at ≈20 s of CPU per wall second, i.e. a frozen page — and every voyage
completes inside one frame, so hulls teleport.

So the sync is a **rate**, not an identity (`trade.js`):

- `SYNC_YEARS_PER_MYR = 1000` — one trade year per 1 000 star years. The star
  slider's fine range then lands on the trade ladder the network is tuned
  against: 0.1 Myr/s ↔ 100 y/s (the default pace), 2 Myr/s ↔ 2 000 y/s (the
  ladder's top). The coupling is exact over the whole fine range.
- `RATE_MAX = 2000` y/s — a hard ceiling on whichever clock drives the network.
  The wide star range exceeds it; the panel reports the backlog rather than
  pretending (`net.lag`, accumulated in trade years).
- `clockRate(ladderYears, starRateMyrPerS, synced)` owns both rules, so the
  slider, the readout and the frame loop cannot disagree. Zero (or a negative
  star rate — the observer's fly coupling) is a real pause.

`step(net, years, budget)` drains at most `budget` events (`drainUntil`'s own
budgeted variant). A budget that runs out stops the clock at the next due event
instead of skipping it, so the clock stays monotonic and no colony is ever asked
to settle backwards. Main passes 256 events per frame: the synced top rate needs
~50, and the budget only bites when the machine cannot follow — which the panel
says out loud ("… Myr behind").

Generation ships: the special mode flies every hull at 1 light-year per 400
trade years (`GENERATION_LY_PER_YEAR = 2.5e-3`) and sets the synced pair — star
clock at the default 1 Myr/s (`GENERATION_STAR_MYR = 1`), sync on. At that pace
the clock runs 1 000 trade y/s, so the ship covers 2.5 ly per wall second: the
start map's nearest hop (Rigil Kentaurus to Fomalhaut, ~25 ly) takes ~10 s, the
median seed hop ~30 s, and the scenario's expeditions are watchable instead of
blurred.
The first calibration, 1 ly per 1 000 years, put that hop at 25 s and the median
at 76 s, so ten expeditions sat in flight at once with nothing to see. The
ordinary freighter (2–4.5 ly/y) crosses the same hop in a fraction of a wall
second, which is exactly the blur the mode replaces. The number is a pace for
this scenario, not a fraction of c.

A fleet that slow needs a matching larder: the colony economy is authored in
years of its own throughput (a 150-year warehouse, a 20-year supply buffer), and
with 10 000-year voyages (the start map's nearest hop) a port would starve between
two arrivals — coverage, growth and the big-colony gate would all fall, and the
mode would show a *dying* network rather than a slow one. So the mode stretches
the reserve horizon to `GENERATION_RESERVE_YEARS = 5 000` (×33.3 of the authored
`STOCK_YEARS`) on every port, live colonies included. Measured on the start map
at the default synced pace over 60 s: median coverage holds at 0.47, the minimum
at 0.45, and all 14 colonies stay big — the horizon is about half the nearest hop,
which is enough because the warehouse only has to bridge the gap between
arrivals, not the whole voyage (`economy.setReserveScale` +
`rescaleColonyReserves`, driven from `setGenerationMode(on, net)`). The warehouse
law, the supply buffer and the growth rates are untouched: only the horizon
moves. Leaving the mode restores the authored values.

Idle hulls back off: a hull with nothing to carry used to re-poll every
`WAIT_YEARS = 2`, which at a 2 000 y/s clock is a thousand events a second per
idle ship — a saturated network spends its whole frame budget on retries. The
interval now doubles per failed poll up to `WAIT_YEARS_MAX = 500` and a
successful load resets it. Measured over 20 s at the synced top rate on the
24-landmark fixture: 3 791 ms → 389 ms of CPU, the backlog from 7 531 y to 0, and
the special mode founds colonies again instead of standing still.

Route re-timing: while the stars move (`dtStar > 0`) and the clock runs,
in-flight voyages are re-measured against the stars' live drawn positions
(`orbit.engineRecordPosition` through the label layer's resolver) and their
arrivals re-timed when they move by more than a year. Booking uses live positions
too, so a voyage's length is measured from where its endpoints are when it starts.
The pass is maintenance, not clock work: twice a second (`TRADE_MAINT_SECONDS`),
shared with the frontier scan, which walks 4 000 field stars per call through a
ring cursor and keeps its best-world record in module scratch.

Star-time slider: fine range −1…2 Myr/s in 0.1 steps by default (small rates are
settable); the button beside it widens the range to −1…99 Myr/s in 0.5 steps.

Presets: `tradesync` and `tradegen` (0/1) ride beside `trade`/`traderoutes`. A
preset with `tradegen` on implies sync; its own `time` wins when it names one.

## 7. Display: seeing the economy

The overlay (`label-layer.js`) is the network's picture, and it has to show
*growth*, not just existence:

- a port ring's radius is `2 + 5.5·√(pop / capacity)`, so a grown colony is
  visibly larger than a young one;
- its colour is the growth sign (teal growing, amber at capacity, red declining);
- a colony founded within the last 150 years wears a second, wider ring — a
  founding that landed two seconds ago is not one more dot in the star field;
- a colony past 60 % of capacity gets a filled core;
- every free candidate world is a small cross — the frontier the ports grow into;
- freighter routes are a faint teal, founding voyages amber, and a founding hull
  is a hollow amber ring rather than a cargo-coloured dot.

The "draw route lines" checkbox owns **only the lines**: the ports, the hulls and
the frontier marks stay on screen whenever a network exists. A network that
appears only when a "routes" box is ticked is a network nobody watches grow.

The Trade panel's colony rows carry the same information as text: a three-cell
bar, the population, and `↑ 1.25 %/y`. A `newest` row names the most recently
founded world with its age, because the six largest colonies can never show an
expansion — a new world starts small. The colonisation block names the gate that
is shut (`no big colony yet`, `no colonists or factory cores spare`, `no free
world in range`) instead of the old catch-all "no big colonies ready", and its
**Send expedition** button launches the same choice the tick would make, now,
through the same cost and reservation path.

At the top of the rate range the panel adds `time-lapse: growth is a blink at
this rate` — that is the honest answer to "why is growth hard to see at the
fastest setting": 2 000 y/s is 25 colony lifetimes per second.

## 8. The starting scenario

The page opens on a small colony network around home, centred on the colony
beside it, and the network visibly expands. The acceptance numbers are the ones
§8's tests pin (`trade-test.js` §16).

**Start.** Four seed colonies (`SEED_PORTS = 4`), not a full map. The start map
(§3) is discovered nearest home first, so the seeds are the local sky: the
capital, then the three settled-roll stars that follow it in distance order. With
the default seed (42) they are Rigil Kentaurus (4.4 ly, the capital), Fomalhaut
(25 ly), Capella (43 ly) and Regulus (79 ly). The capital is the first star with a
real world inside `HOME_COLONY_LY = 20` of home, found in the same nearest-first
order, and it is `net.capital`. With no capital (a galaxy whose home is a bare
centre) the view falls back to the frame point.

**Why nearest first.** The rendered field sample has no star within 300 ly of the
Sun (the nearest is at 307 ly), so the local sky is the named landmarks. Seeding
in catalogue order put the colonies at Canopus (310 ly), Capella and Rigel (861 ly),
where no candidate is in expedition range, and the network sat at four colonies
for twenty seconds. Discovering nearest first keeps the seeds, the candidate pool
and the first expeditions within a few tens of light-years of home. The field
still contributes its 400 nearest systems within 1.2 kpc, which are the far
frontier once the landmarks are settled.

**Arrival.** The page boots in galaxy-centre orbit and, once the loop starts,
`goToHomeColony()` runs: the same H path, a 2-second eased flight to the capital
and a ride on it while the sky moves. The observer is not teleported, and game
mode makes the capital the Flight destination as H does.

**Clocks.** The star clock starts at 1 Myr/s (was 5), from `Presets.TIME_DEFAULT`,
so the slider, the readout, the URL and the Defaults button agree. The trade clock
starts at 100 y/s unsynced (§1, unchanged): with sync on, 1 Myr/s would be 1 000
y/s, and the network reaches its 14-colony plateau in about 5 s (8 colonies at
1 s), before the 10–20 s window the scenario is read in. Generation ships (§6) sync to 1 Myr/s when enabled.

**Pace.** Expeditions launch at most once per `EXPEDITION_INTERVAL = 250` years
(was 200). Measured at the default 100 y/s, 60 frames a second, the budget of 256
events:

| seed | 10 s | 15 s | 20 s |
|------|------|------|------|
| 42   | 8    | 10   | 12   |
| 7    | 8    | 10   | 12   |
| 1234 | 8    | 10   | 11   |

At 200 years the same seed reached 9 and 14 colonies at 10 s and 20 s: inside the
band, but at its ceiling. The expedition gates are unchanged (a big colony with
40 spare people and 10 robots).

**Plateau.** The default seed levels at 14 colonies from about 30 s and stays
there to 60 s. The landmarks within 300 ly are all settled or reserved, and the
field is beyond that range. Growth past 14 needs the frontier to reach beyond the
named sky, which is a next step (§8 Next), not a tuning change.

**Legibility.** Every voyage takes at least `MIN_LEG_YEARS = 50` trade years (§1).
At the default pace a freighter's 10 ly hop used to take 2–5 years, a few frames,
which reads as a teleport. Now it is at least half a second.

**Generation ships.** Enabling the mode syncs to 1 Myr/s and flies at 2.5 ly per
wall second (§6): the start map's nearest hop takes about 10 s, the median about
30 s. Warehouses hold (median coverage 0.47 over 60 s, all colonies big).

**Checked.** `node experiments/trade-test.js` §16: four colonies at start; the
capital is the nearest port and inside 20 ly; the four are within 100 ly of home;
5–15 colonies after 10 s and after 20 s of 60-fps steps at 100 y/s; freighters on
the routes. Glitch scan (Node, 20 s default and 40 s generation): no ship moves
faster than its hull allows between frames, and no position is non-finite. The
browser was not available in this environment, so the boot flight, the overlay and
the route lines are unverified on screen; a visual pass is the next step.

**Next.**
- Widen the frontier past the landmark sky so the plateau at 14 becomes growth:
  either sample the field nearer home, or let big colonies scan the catalogue
  within reach. Measure the 10–20 s band again after.
- A visual pass in a browser: the boot flight, the four seeds in the overlay, and
  whether the 50-year legs read as motion at 100 y/s.
