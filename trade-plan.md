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
g = coverage/40 - (1-coverage)/120
P(t) = K / (1 + (K/P0 - 1)*exp(-g*t))
stock[r] += (out[r] - input[r]) * integral(P dt)   // clamped to [0, cap]
```

`G_MAX = 1/40` (an 80-year e-folding became 40). The network is read at 100
trade years per wall second: at the old rate a new world's ring barely moved
for ten seconds and the expansion it was supposed to feed never started. At
the authored coverage (~0.47) the rate is ≈0.7 %/y, a doubling in about a
century (one wall second).

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
while seed slots remain. It occupies the best-habitat site of the system (terran
1.6×, HZ 1.25×; a belt counts at 0.10). Otherwise the star contributes **one**
candidate: its best world. One colony per star is the rule, so a second candidate
from the same star is a place no expedition can ever take; adding every world
filled the 224-slot start pool with sibling worlds and belts and left the
reachable frontier dry at 14 colonies. A star whose best world is below
`MIN_CANDIDATE_HABITAT = 0.10` contributes nothing. Terran worlds are preferred,
**not automatically settled**. Remember discovered keys even when candidate
storage is full: revisiting only settles, never changes the map or seeds a
second colony.

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

The fleet has 128 preallocated ship slots, including expeditions: 74 freighters
and up to `MAX_FOUNDING_IN_FLIGHT = 24` founding voyages can coexist with the
seed fleet. Seed up to 12 freighters (roughly half the initial ports); every 25
years grow toward `min(74, max(12, floor(3 + 1.5*portCount)))`. Successful
expedition hulls become freighters; the target is not a retirement policy or a
hard post-founding limit. A network without ports has only its global tick, no
orphan hulls.

| hull | hold (stock units) | ly/trade-year |
|---|---|---|
| bulk | 30,000 | 2 |
| hauler | 15,000 | 3 |
| clipper | 8,000 | 4.5 |
| generation (§6, mode switch) | 30,000 | 0.03 |

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

A founding wave costs **people, not warehouse stock**. Every 25 years the tick
settles the ports and launches from every port that is ready, up to
`MAX_FOUNDING_IN_FLIGHT = 24` voyages. A port is ready when its colony is big
(population ≥ 5 M, coverage ≥ 0.30, ≥ 8 % of capacity), at least
`EXPEDITION_COOLDOWN = 900` years have passed since it last sponsored a wave,
and it can spare a party:

```
people = clamp(0.02 * P, 0.5 M, 4 M)      // drawn from the population
source keeps at least 2 M people
```

The party is deducted from the source's population on launch and becomes the new
colony's population on arrival (`P = people`, capped at K). The authored
"colonists" and "factory cores" stocks remain trade goods; they are **not** a
founding gate. That gate was the old plateau: on the start map only one world in
fourteen produced a people surplus and none of the marginal gas/ice giants could
hold a factory-core surplus, so the other thirteen never launched regardless of
population. Factory cores are built by the port's own industry; coverage is the
readiness check that the industry runs.

Search free candidate stars within `MAX_FOUND_LY = 600` and rank the best site of
each star by habitat (terran 1.6×, HZ 1.25×) over distance
(`habitat / (1 + ly/80)`). The 300 ly range was the second half of the plateau:
the sampled field has a 300 ly hole around home and its first shell sits at
307–600 ly, so a port at the end of the named sky had nothing in reach. 600 ly is
1.3–3 s for a freighter, and it lets the frontier chain through the sampled
field.

`port.lastExpedition` holds the cooldown; `foundAtCandidate` sets it to the
founding time, so a new colony sponsors its first wave one cooldown after its
own founding. Each port's clock is independent, so the network grows in a
staggered stream rather than one network-wide window: it roughly doubles every
wave (4 → 8 → 16 → 32 → 64 ports) and fills in about a minute at the default
pace. The panel's **Send expedition** button is
the player's hand: it may rush a port that is still resting, and that port's
900-year clock restarts from the launch.

Reserve the **whole target star** during flight, not only its selected planet,
and count every in-flight expedition against remaining port capacity. This
prevents duplicate launches and guarantees a port slot on arrival. A reservation
is separate from `used` (successful settlement). Seed discovery must not occupy
a reserved target. An unexpected failed founding releases its reservation and
returns the hull to a scheduled source-port load; never leave a ship eventless.

On arrival the carried people become `P = amount * 0.004` million (the party is
carried as stock units so the ship manifest and the founding law share one
number), capped at K; start warehouses at 45%, set founded/last to the event
time, and join the same routing loop. Startup warehouses are an abstract founding
grant, not a manifest of goods subtracted from the parent. A failed founding
returns the volunteers to the source's population (they were drawn from it) and
sends the empty hull home for a normal load; never leave a ship eventless.

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
  monotonicity and backlog), the colonisation law (one candidate per star,
  volunteers, per-port cooldown, the resting readout and the manual rush) and the
  §8 start scenario (the growth curve, the capital's first seconds, the full
  network by 90 s, and the forced capital).
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
40-year population e-folding, voyages of tens of years. The star clock is authored
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

Generation ships: the special mode flies every hull at 1 light-year per 33
trade years (`GENERATION_LY_PER_YEAR = 3e-2`) and sets the synced pair — star
clock at the default 1 Myr/s (`GENERATION_STAR_MYR = 1`), sync on. At that pace
the clock runs 1 000 trade y/s, so the ship covers 30 ly per wall second: the
start map's nearest hop (Rigil Kentaurus to Fomalhaut, ~25 ly) is under a
second, a 300 ly frontier hop 10 s and the 600 ly maximum 20 s, so the voyages
are watchable and the network still advances in a session. The first calibration,
1 ly per 1 000 years, put that hop at 25 s and the median at 76 s, so ten
expeditions sat in flight with nothing to see; the second, 1 ly per 400 years,
brought them to 10 s and 30 s but still took four minutes to cross the sampled
field's 600 ly shell. The ordinary
freighter (2–4.5 ly/y) crosses the same hop in a fraction of a wall second, which
is exactly the blur the mode replaces. The number is a pace for this scenario,
not a fraction of c.

A fleet that slow needs a matching larder: the colony economy is authored in
years of its own throughput (a 150-year warehouse, a 20-year supply buffer), and
with 20 000-year voyages (the farthest 600 ly sampled-field hop) a port would starve
between two arrivals — coverage, growth and the big-colony gate would all fall,
and the mode would show a *dying* network rather than a slow one. So the mode
stretches the reserve horizon to `GENERATION_RESERVE_YEARS = 5 000` (×33.3 of
the authored `STOCK_YEARS`) on every port, live colonies included. Measured on
the start map at the default synced pace: median coverage holds at 0.47, the
minimum at 0.31, zero colonies are abandoned, and the network reaches all 64
ports by 60 000 trade years (60 s of wall time at 1 000 y/s) — the horizon is
a quarter of the farthest hop, which is enough because the warehouse only
has to bridge the gap between arrivals, not the whole voyage
(`economy.setReserveScale` + `rescaleColonyReserves`, driven from
`setGenerationMode(on, net)`). The warehouse law, the supply buffer and the
growth rates are untouched: only the horizon moves. Leaving the mode restores
the authored values.

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
is shut (`no big colony yet`, `every big colony is resting between expeditions`,
`no free world within 600 ly`) and counts the resting ports and the next launch
in years, instead of the old catch-all "no big colonies ready". Its **Send
expedition** button launches the same choice the tick would make, now, through
the same cost and reservation path; it may also rush a resting port, restarting
that port's 900-year clock.

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

The seed systems are generated with the page's live field attached
(`ctx.field`), because a generated star depends on whether the generator was
looking at the field sample. Without it the fixture's start map is a different
sky from the page's, and its growth curve is not the scenario's.

**Arrival.** The page boots in galaxy-centre orbit and, once the loop starts,
`goToHomeColony()` runs: the same H path, a 2-second eased flight to the capital
and a ride on it while the sky moves. The observer is not teleported, and game
mode makes the capital the Flight destination as H does.

**Clocks.** The star clock starts at 1 Myr/s (was 5), from `Presets.TIME_DEFAULT`,
so the slider, the readout, the URL and the Defaults button agree. The trade clock
starts at 100 y/s unsynced (§1, unchanged): with sync on, 1 Myr/s would be 1 000
y/s, and the network grows too fast to watch. Generation ships (§6) sync to
1 Myr/s when enabled.

**Pace.** Each port sponsors at most one expedition per
`EXPEDITION_COOLDOWN = 900` years, and a tick launches from every port whose
cooldown is over. There is no network-wide launch window: the old single launch
per 250 years (the old `EXPEDITION_INTERVAL`) was the first half of the plateau,
because a big port then waited its turn while its people piled up. Measured at
the default 100 y/s, 60 frames a second, the 256-event budget and the 0.5 s
frontier scan (seed 42, the page's 300k field):

| wall s  | 0 | 5 | 10 | 15 | 20 | 25 | 30 | 35 | 40 | 45 | 50 |
|---------|---|----|----|----|----|----|----|----|----|----|----|
| ports   | 4 | 8 | 11 | 16 | 27 | 32 | 44 | 50 | 56 | 63 | 64 |
| big     | 3 | 8 | 8  | 16 | 25 | 32 | 42 | 50 | 56 | 63 | 64 |
| founded | 0 | 4 | 7  | 12 | 23 | 28 | 40 | 46 | 52 | 59 | 60 |

The same curve holds across galaxy seeds (300k field, same frame loop):

| seed | 10 s | 20 s | 40 s | full network |
|------|------|------|------|--------------|
| 42   | 11   | 27   | 56   | 48 s |
| 7    | 12   | 29   | 58   | 49 s |
| 1234 | 12   | 28   | 46   | 50 s |
| 4242 | 12   | 30   | 54   | 49 s |

The seed ports alone become eight inside five seconds (a wave every 900 trade
years per port, i.e. nine wall seconds at this pace). The first wave leaves on
the first tick — three of the four seeds are big at t = 0; the small belt joins
as it grows. The network then reaches `MAX_PORTS = 64` by 50 s and stays there;
at 64 the port array is full, which is a cap, not a plateau. Coverage holds at a
median 0.47, the minimum at 0.31; no colony is abandoned, the population sum
grows 0.1 B → 11.2 B over the run, and the fleet hauls 4.5 M units by 90 s.

**Colony growth.** `G_MAX = 1/40` and the authored coverage of ~0.47 give
`g ≈ 0.7 %/y`, so a world founded at 45 % of capacity is visibly growing within
a couple of wall seconds at the default pace. A world founded at 45 % reaches
90 % in ~330 trade years (3.3 s). That is the point: the ring the overlay draws
from `√(pop/capacity)` has to move while the network expands around it.

**Legibility.** Every voyage takes at least `MIN_LEG_YEARS = 50` trade years (§1).
At the default pace a freighter's 10 ly hop used to take 2–5 years, a few frames,
which reads as a teleport. Now it is at least half a second.

**Generation ships.** Enabling the mode syncs to 1 Myr/s and flies at 30 ly per
wall second (§6): the start map's nearest hop is under a second, a 300 ly
frontier hop 10 s, and the 600 ly maximum 20 s. Measured over 60 s (60 000 trade
years) at 1 000 y/s, with the same field and frontier scan:

| wall s | 10 | 20 | 30 | 40 | 50 | 60 |
|--------|----|----|----|----|----|----|
| ports  | 22 | 33 | 41 | 53 | 61 | 64 |

All 64 are big by 60 s, median coverage 0.47, minimum 0.31, zero abandoned, and
1.66 M units delivered by 120 s. The mode still reads as slow ships (30 ly/s is
1/70–1/150 of a freighter's wall-second speed), but it no longer reads as a
stalled network.

**Checked.** `node experiments/trade-test.js` §16: four colonies at start; the
capital is the nearest port and inside 20 ly; the four are within 100 ly of home;
the capital grows from its founding share (~0.19) to a full ring (> 0.85 of
capacity) inside two wall seconds; 5–20 colonies after 10 s, 18–40 after 20 s,
≥ 45 after 40 s and 64 at 90 s of 60-fps steps at 100 y/s; the youngest colony
grows visibly after 20 s; freighters on the routes. The readout is checked in
its common state (a tick has just spent every ready port, so the panel must show
the resting count and the next launch), and the manual button is checked as a
rush. A separate §15 case proves the generation mode keeps founding through the
slow fleet. Glitch scan (Node, 20 s default and 40 s generation): no
ship moves faster than its hull allows between frames, and no position is
non-finite. The browser was not available in this environment, so the boot
flight, the overlay and the route lines are unverified on screen; a visual pass
is the next step.

**Next.**
- A visual pass in a browser: the boot flight, the four seeds in the overlay, the
  ring growth of a young colony, and whether 30 ly/s voyages read as motion.
- Re-check the frontier scan's 4 000-star ring per 0.5 s call now that the
  network reaches 64 ports inside a minute; it is the remaining per-frame cost
  that scales with the field, and a wider sample (500k) has not been measured.
