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

Thirteen resources, six authored production families (raw, synth, life, goods,
data, culture). Two independent routing maps, `intraFamily` and `interFamily`,
decide where a resource may move; they do not replace the production family or
its routing worth:

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
Ore/volatiles are bulk feedstock and never load onto an inter-star hull; the
other eleven resources cover seven shipping families. All thirteen have some
productive world type, and bulk keeps its authored worth for local routing and
the player's load scoring. Arrival/unload is never family-filtered.

A site is `(star key, planet-or-belt kind, index)` plus the generated physical
properties and an **owned copy** of the star's pick reference. Planet slots and
belt slots occupy distinct hash channels. With
`seed = planets.systemSeed(key, model.seed, starBlockKind)`, yields are

```
yield[r] = clamp(PLANET[r][type] * starFactor(r, site) * supplyFactor(r, site)
                 * (0.7 + 0.6 * hash01At(seed, 512 + slot*16 + r)), 0, 2.5)
```

`starFactor` is the *situation*: metallicity, age, insolation, surface
temperature. `supplyFactor` is the *system's supply*: what a prospector would
count, normalised against a cap so a system with twelve rocky worlds is not
twelve times a system with one.

```
rockyF = min(sysRocky, 6)/6   giantF = min(sysGiants, 4)/4   beltF = min(sysBelts, 3)/3
terranF = min(sysTerran, 2)/2 hzF = min(sysHz, 4)/4

mined    (ore, rare, robots, compute) × (0.80 + 0.45·rockyF + 0.55·beltF + 0.15·giantF)
gathered (volatile, chem)             × (0.85 + 0.40·giantF + 0.30·beltF + 0.10·rockyF)
grown    (food, bio, people)          × (0.85 + 0.35·terranF + 0.25·hzF + 0.10·rockyF)
made     (amat, soft, data, art)      × (0.90 + 0.20·rockyF + 0.10·beltF)
```

The five counts are computed once per system (`systemComposition`, one pass over
`counts.planets` — rocky means rock or super, not ice) and stored on the site, so
a candidate and a colony keep the composition of the system they were drawn
from; discovery and inspection pay for it, a settle never does.

Belts are the easiest mine: the belt column is 1.60 for ore (1.33× the richest
planet's 1.20, under the 1.5× ceiling that keeps planetary mining worth
building), 1.10 for rare, 0.80 for robots and 0.10 for compute — a belt occupies
one slot however many belts the system has, and a belt system earns `beltF` on
top. Heavy planets are places to live, not to mine: mini-Neptunes make 0.15
robots and gas/ice giants 0.10, where a rock world makes 0.40–0.70, while their
volatile and chemical strengths are unchanged. Rock-family columns and every
habitat value are untouched, so the trade is explicit: a giant is where people
live, a belt is where ore comes from.

Terran flags boost food, biotech and volunteers by 1.3; the habitable-zone flag
boosts food/biotech by 1.15. No PRNG state and no reroll on inspection.

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

### 2.2 Routing tiers and statistical intra-system closure

The two routing maps aggregate the same thirteen resources; they are not a new
yield table. `pickExport` and the player's load pick refuse `interFamily = -1`,
while arrival and unloading accept every resource.

| tier | family | members |
|---|---|---|
| intra | `bulk` | ore, volatiles |
| intra | `goods` | chem, robots, compute |
| intra | `pax` | migration drawn from population, not `stock[people]` |
| inter | `rare` | rare |
| inter | `exotic` | chem, bio |
| inter | `amat` | amat |
| inter | `food` | food |
| inter | `fab` | robots, compute |
| inter | `info` | soft, data, art |
| inter | `pax` | people stock |

Chem, robots and compute can move in either tier. Ore and volatiles keep their
worth and `exportableOf` meaning even though star-port loaders skip them.

At world founding, `trade.fillIntraGraph` reuses `deltav.buildBodyNodes` and
`buildInterEdges` for the generated system. With `DV_REF = 10 km/s`, the nuclear
Hohmann leg and aerocapture/landing credit, each world slot stores:

```
well[s]       surface→LO, or 0 for a body with no surface
land[s]       LO→surface with aero credit, or 0 with no surface
dv[s,t]       well[s] + legLoToLo(s,t).dvLoToLo + land[t]   (m/s)
tH[s,t]       the leg's Hohmann seconds (readout only)
couple[s,t]   1 / (1 + (dv[s,t] / DV_REF)²)
lift[s]       1 / (1 + well[s] / DV_REF)
access[s]     mean couple to other live worlds; 1 with no live neighbour
```

The diagonal has `dv = 0`, `couple = 1`. The graph is not rebuilt in a settle.
Outposts stay in it but leave live access means. Adding a world recomputes its
row and column from the same functions the delta-v map uses; there is no tank-
feasibility cliff at 40 km/s.

Once per port settle, freeze every live world's family exportable/demand and
coverage before the local integration. For goods, those are sums over member
resources. A healthy world (`coverage ≥ 0.6`) can offer
`P·0.02·years` passengers while `P < 0.8K`; habitat-weighted capacity room is
its receiver demand. A world below 0.6 neither sends nor receives passengers.
For each source and family, an off-world receiver's offered slice is

```
offer[s,t,f] = export[s,f] · demand[t,f] · couple[s,t]
               / Σu(demand[u,f] · couple[s,u])
```

The self share stays local. Transfers divide a family offer across demanded
member resources, cap by the source's remaining exportable and the receiver's
warehouse room (or `K − P` for passengers), and record `intraFlow[s,t,f]`.
Then settle each world once with the closed form and apply all deliveries and
exports simultaneously; post-integration availability and room are final caps.
No delivery can be re-exported in the same interval. Stock and population are
conserved by the transfer itself, while local production/consumption remains
the §2.1 approximation. A repeated settle at the same clock applies nothing
and preserves the last flows: freeze → local settle → one transfer → access →
fold is the non-circular fixed point, not an iteration.

Inter-star collection weights each world's exportable by `lift`; a belt is a
cheap pier and a deep surface well is not. Access is reported and folded, never
multiplied into coverage or the logistic. Hohmann time does not throttle these
decades-to-millennia transfers. Worlds settle whether V is open or closed, and
this operator adds no ships or events to the galaxy queue.

## 3. Discovery and the network

One inter-star port per star keeps the galaxy routing graph unambiguous; the
port can aggregate up to six world-colonies (`MAX_WORLDS_PER_STAR = 6`, 384
preallocated world records). The first founding takes the best site. AI-founded
stars stay at one world in this series; while docked with V open, the player can
found a named sibling planet or belt without taking another port slot. Duplicate
sites, outposts, the six-world cap and physically unreachable candidates are
refused.

A one-world port is that world by reference. A multi-world fold sums live
population, capacity, stock and stock caps; pop-weights `outBase`, coverage,
growth and access; and production-weights yields. Inter-star transfers then
water-fill back down to worlds by demand or lift-taxed exportable, preserving
resource mass and warehouse floors. The fleet, overlay and player hold still
see only the one fold.

Four seed ports (`SEED_PORTS = 4`, §8) grow toward 64 total port slots; 256
candidate sites. For a newly discovered star, a stable hash roll below 0.35
selects a seed colony while seed slots remain. It occupies the best-habitat site
of the system (terran 1.6×, HZ 1.25×; a belt counts at 0.10). Otherwise the star
contributes **one** candidate: its best world. One candidate per star is the
rule, so a second candidate from the same star is a place no expedition can ever
take; adding every world filled the 224-slot start pool with sibling worlds and
belts and left the reachable frontier dry at 14 colonies. A star whose best
world is below `MIN_CANDIDATE_HABITAT = 0.10` contributes nothing. Terran worlds
are preferred, **not automatically settled**. Remember discovered keys even when
candidate storage is full: revisiting only settles, never changes the map or
seeds a second port.

On model reset the start map is built and discovered **nearest home first**
(`trade.startSystems` + `trade.discoverNearest`): the named landmarks (Milky Way
models) and up to 400 procedural field systems inside 1.2 kpc of home, ordered by
distance from home, not by catalogue or sample order. Stop when seed ports and
nearly all candidate slots are filled. Opening another system with V discovers
it. A reset builds a fresh deterministic network at time zero. The order is the
design: catalogue order seeded colonies 300–860 ly away with nothing in expedition
range, and the rendered field has no star within 300 ly of the Sun at all (§8).

### 3.0 First colony after an empty sky

A network booted at an early epoch (before the named sky's applicability window)
starts empty rather than pre-settling a barely formed star. While it has no port
or ship, a wall-time-throttled, bounded scan walks the rendered procedural field,
independent of the trade clock and sky gate; candidate discoveries do not block it.
It advances a persistent cursor and wraps so new births and epoch scrubs are
reconsidered. No field birth data means wait, never guess. It must never re-seed a
network with ports, including hidden or failed ones.

There is no actual stellar-generation or enrichment model yet. As an explicit
*gameplay proxy*, require the star to have been born at least 0.5 Gyr after the
galaxy began, be at least 0.1 Gyr old, be a main-sequence star with model Z ≥
0.008, and have a generated planet flagged `terran`. These are not evidence of
second-generation ancestry, real nucleosynthesis, habitability or life. The
first eligible field record in the incremental scan is founded at the current
trade year as capital; the star's own epoch and formation gate apply. The panel
says what it is waiting for. No speculative global enrichment simulation is
introduced. If the field is too sparse or no such planet exists, it waits and
keeps scanning; it does not create an unsuitable colony. A network booted in
the present-day named-sky window keeps the existing seed map.

On success, preserve any existing candidates, make one port and initialize a
fleet even if the empty network already scheduled its global tick. The sky gate
reopens on the next pass. The search panel also provides a one-click all-resident
Earth-like search: existing `terran` + main-sequence filters, centered on the
camera, no distance limit; results are nearest-first and selectable, do not
found colonies, and do not assert generation or heavy-element history. Searches
exclude the curated landmark block when its galaxy/epoch/rate gate is closed.

Tests exercise first light, retry while gated or trade paused, existing candidates,
formation/age/metal/planet eligibility, scan wrap, later success, clock and queue
preservation, fleet startup, and no reset of a network with hidden ports. A real
browser pass must confirm status and the search button; mock tests do not prove
visual usability.

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

An export keeps 25% of warehouse capacity and may load only a resource with an
inter-star family; collection from a multi-world fold is capped by each world's
`exportable · lift`. NPCs reserve people for expeditions; for each other surplus
resource choose demand-weighted destination score
`demand * worth / (1 + ly/100)`. Ship at most the hold, lift-taxed exportable
stock, destination room and 150 years of destination demand; rank load value by
`1 + ly/200`. Demand is positive `input*P - out*P - stock/20`. Ties use stable
iteration order.
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

When the system view is closed, the readout shows the port summary (`pop / K`,
`coverage`, `access`), W4's system composition, and W5 scarcity tags across the
seven inter-star shipping families. Opening V expands the settled `worlds` list
(up to 6 worlds backing the star's single port fold), the three largest intra
flows with their family, direction, km/s, couple and Hohmann time, each world's
lift, the inter-family market, and all thirteen yields/exports/imports.

The system canvas draws a population/growth marker on every settled planet or
belt, grey for an outpost and dashed amber for starvation. The three largest
last-settle `intraFlow` entries are dim cargo-coloured dashes between the drawn
body positions. They are ambient statistics, not interpolated hulls and not a
second queue; closing V drops only the drawing. A docked pilot may open the
station's schematic without camera motion to select and found a sibling world;
undocking closes it. The real delta-v map and the intra card read the same
`dv[s,t]`, so their km/s cannot drift apart.

The Trade panel has clock and route controls, counters and six largest
non-abandoned ports plus sailing ships, refreshed at 4 Hz. The overlay has a
one-line rate/ports/ships/queue summary. Preset fields `trade` and `traderoutes`
share defaults owned by `trade.js`.

## 5. Files, validation and remaining scope

- `src/core/exec-queue.js`: typed-array heap, push/pop/drain/peek/clear.
- `src/core/economy.js`: tables, sites, colony setup/settle, fold and bounded
  world-transfer helpers.
- `src/core/trade.js`: discovery, fleet, queue handlers, founding, player transfers,
  the founding-time intra graph and fixed-point family closure, and §9's
  live-geometry cache and leg laws (the linear plan, intercept solve, pursuit,
  divert).
- `src/math/deltav.js`: the shared well/landing/Hohmann physics, including the
  surface-to-surface helper used by the Solar pin. The trade settle does not
  rebuild this graph.
- `src/render/system-layer.js`: the opened system's world markers and ambient
  intra-flow dashes, reading references supplied by `main.js`.
- `src/core/ship.js`, `presets.js`, `input.js`: cargo state, settings and Y action.
- `src/main.js`, `src/index.html`: seeding/clocks, inspection, HUD/panel/wiring,
  the geometry refresh and the exchange rate (§9.1/§9.2), the per-frame mirror step.
- `src/render/label-layer.js`: resident drawn-position trade pass, and the same
  record at a future star time — the predictor a booking solves against (§9.3).
- `src/math/orbit.js`: the θ-taking twins of the record and landmark dispatch and
  the friction field's tracked mirror (§9.5); the shader and the parity contract
  are unchanged.
- `experiments/trade-test.js`: deterministic maps, stable-coverage split exactness,
  long-time growth/decline, caps, demand/export laws, idempotent discovery,
  multi-millennial network and exact live-event counts, full-state jump invariance,
  expeditions/reservations/capacity, player mass conservation, overlay geometry
  (including the population-scaled ring and the frontier mark), the clock laws of
  §6 (sync exchange rate, ceiling, generation-ship pacing, budgeted drain
  monotonicity and backlog), the colonisation law (one candidate per star,
  volunteers, per-port cooldown, the resting readout and the manual rush), the
  §8 start scenario (the growth curve, the capital's first seconds, the full
  network by 90 s, and the forced capital) and §17's live geometry (the frozen
  identity, the cache, the intercept, the refusals, the divert and its refund,
  the frontier stretch, and 120 s of shearing sky). Sections 27–29 add the two
  routing maps, world/fold conservation, bit-exact DeltaV graph, Earth→Mars pin,
  near/far couple flows, positive bulk/goods/passenger closure, starvation and
  one-world limits, lift-taxed exports, founding score and the same-clock fixed
  point.
- `experiments/dv-map-test.js`: the published Solar edges plus the direct
  Earth→Mars surface-to-surface aerocapture pin.
- `experiments/system-layer-test.js`: matching-star trade-data gating, world /
  outpost / starvation markers, three-flow drawing and allocation-free frames.
- `experiments/exec-queue-test.js`: 50,000-event sorted-reference comparison,
  growth, equal timestamps, due follow-ups, boundary, clear/empty and stale handling.

No per-frame object literals/closures for simulation or drawing; setup preallocates
ports, worlds, candidates, ships, intra matrices and scratch arrays. New discovery
may allocate records of known keys and display text is built at 4 Hz. `step` is
one drain; the queue has one event per ship plus one tick in normal operation.

Deferred: prices/contracts, constrained recipes, inspection-independent variable
coverage, port-slot recycling, buildings/terraforming/piracy, planet-specific
docking, physically calibrated interstellar freight, a real intra-system fleet
with its own system clock and queue (T6), capital reinvestment (T7/F6),
passenger-founded extra worlds (T8), and a drawn *pursuit curve*
for a re-aimed hull (the overlay draws the chord between the two live endpoints;
the aim is live, the drawn path between the last two re-aims is not). Real-browser/WebGPU visual
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

The four network seeds 42, 7, 1234 and 4242 give the same port count at every
sample (11 / 27 / 56 at 10 / 20 / 40 s, full at 50 s): the start map and the
field are fixed by the model seed and the frontier takes the nearest systems
rather than a random draw. What the network seed does change is the freight —
4.2–5.3 M units hauled by 90 s across the four.

The seed ports alone become eight inside five seconds (a wave every 900 trade
years per port, i.e. nine wall seconds at this pace). The first wave leaves on
the first tick — three of the four seeds are big at t = 0; the small belt joins
as it grows. The network then reaches `MAX_PORTS = 64` by 50 s and stays there;
at 64 the port array is full, which is a cap, not a plateau. Coverage holds at a
median 0.49, the minimum at 0.31; no colony is abandoned, the population sum
grows 0.1 B → 11.2 B over the run, and the fleet hauls 4.2–5.3 M units by 90 s.

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

All 64 are big by 60 s, median coverage 0.48, minimum 0.31, zero abandoned, and
0.80 M units delivered by 60 s. The mode still reads as slow ships (30 ly/s is
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

## 9. Live geometry: the network in a moving sky

§6 gave *booking* and *re-timing* the stars' drawn positions. Every decision
that **chooses** a partner still measured the birth sky — `pickDestination` and
`pickExport` through `distanceLy(net, a, b)` (which reads `port.x/y/z`),
`pickCandidate` and `bestExpedition` through `site.x − port.x`, the frontier
scan's gate through the birth-frame field buffer, and the panel's `ly` the same
way. Birth coordinates are the settled instant's, and the star clock shears them
apart by differential rotation, so at star time > 0 the network traded with
stars that stopped being neighbours long ago: the score said a 30 ly hop,
`liveLegYears` booked the 3 000 ly the drawn sky actually showed, the overlay
drew a line across an arm, and neither `MAX_LEG_LY` nor `MAX_FOUND_LY` — both
checked against birth — ever fired.

Measured through the shipping dispatch (`orbit.engineRecordPosition`, classic
mask, the page's 300k-style field sample), for field stars inside 250 pc of
home — the network's actual neighbourhood — against the first star's birth
separation:

| star time | 1 Myr | 10 Myr | 60 Myr (one minute at the default 1 Myr/s) | 200 Myr |
|---|---|---|---|---|
| 798 ly | 799 | 827 | 1 492 | 5 520 |
| 348 ly | 367 | 937 | 1 246 | 6 417 |
| 838 ly | 848 | 1 139 | 3 436 | 3 911 |
| 1 007 ly | 989 | 1 517 | 6 213 | 18 984 |

and over the 60-star landmark sky, the mean stretch of each star's
birth-nearest pair is 1.2× at 1 Myr, 4.4× at 10 Myr, 19× at 50 Myr and 37× at
100 Myr (worst pair 583×: Sirius–Procyon, 5 ly at birth, 3 061 ly at 100 Myr,
past `MAX_LEG_LY` with 16 of the 60 pairs). The apocenter pass is milder — 1.8×
at 100 Myr — and not exempt.

**The rule.** Every distance the network acts on is a *live* distance, taken
from one cache, and the cache says how much it knows:

| tier | when | what the CPU knows | what the network may do |
|---|---|---|---|
| frozen | the star clock is stopped, or T = 0 | nothing moves; birth *is* live | the whole layer is skipped — zero cost, and the birth-frame behaviour §1–§8 measured |
| closed form | any mask without `simple` (classic, apocenter) | any star at any star time | score live, book the intercept |
| mirrored | the friction field, for tracked stars | θ integrated in lockstep with the GPU | score live, book the intercept over a bounded horizon |
| blind | not resident, not tracked | the birth position only | score on birth, never *predict*, and §9.4's pursuit owns the voyage |

### 9.1 One cache, refreshed on the maintenance pass

`refreshGeometry(net, starTimeMyr, moving, myrPerYear)` fills two preallocated
`Float64Array`s — `MAX_PORTS` and `MAX_CANDIDATES` positions, plus the rate each
endpoint is moving at — and bumps `net.geom.version`. It runs on the maintenance
pass the network already has (twice a second, §6), never per frame and never per
event: ≤ 320 dispatches (0.85 µs on a closed-form mask, 3 µs on the friction
field's mirror, measured) is 0.3–0.9 ms per call, and the first frame after a
paused trade clock refreshes before it drains rather than half a second into the
sky it is trading in. A no-op when the sky is frozen or
no resolver is wired, so a network with no live geometry — every fixture in
`trade-test.js` that predates §9, and every frame of a frozen sky — behaves
exactly as the birth-frame one did.

The rates are the refresh difference, in kpc per star Myr, and they exist so
that *reachability* is a scoring question: a partner that recedes faster than
the hull flies can be refused for every port in a loop with no resolver call at
all. A blind entry keeps its birth coordinates and **no rate** — an endpoint
that flickers between drawn and birth would otherwise read as a velocity of
thousands of ly per year and make every partner look unreachable.

No scoring loop calls the resolver. `pickDestination` runs 64 ports × 13
resources per load decision; at the synced top rate that is thousands of
dispatches a frame. It reads the cache, which is at most half a second old — and
half a second is 0.5 Myr of sky at the default pace: 0.12 kpc of a star's own
travel, which is common motion and cancels in every distance measured between
two endpoints, and ~7 ly of differential drift, which is the only part a leg
feels. The *booking* is the exception (§9.3): it resolves, because it is one
hull making one decision.

### 9.2 The exchange rate

Prediction needs one number the network cannot derive itself: how much *star*
time passes per *trade* year. The app passes it with the refresh:

```
myrPerYear = starRateMyrPerS / tradeRateYearsPerS      (0 when either clock is stopped)
```

Under the §6 sync this is exactly `1 / SYNC_YEARS_PER_MYR` = 10⁻³ Myr per trade
year, so a 500-year voyage predicts 0.5 Myr ahead. Decoupled, it is the
instantaneous ratio of the two ladders and an approximation by construction: the
viewer can move either slider mid-voyage. That is §9.4's job, not this one's —
the horizon is re-derived on every re-aim.

### 9.3 The intercept, measured in the field's frame

A leg booked on the current separation arrives where the destination *was*.
With a predictor the booking solves the intercept — but the measurement is the
**separation between the two endpoints at the arrival instant**, not the hull's
chord from its departure point:

```
Δ₀   = |p_B(t₀) − p_A(t₀)| / speed
Δₖ₊₁ = |p_B(t₀ + Δₖ·κ) − p_A(t₀ + Δₖ·κ)| / speed          κ = myrPerYear
```

The choice is forced by the clocks, and it is the one correction the first
implementation needed. A trade year is 10⁻³ Myr of sky at the synced rate, and
the disc turns at ~0.235 kpc/Myr at the Sun's radius — 765 ly per star Myr. At
that exchange rate the *inertial* frame asks a 2–4.5 ly/trade-year hull to
intercept a target moving at 7.6 ly per trade year, so every route in the galaxy
becomes unreachable inside a Myr, including between two stars that never move
apart. Measured on the first version of this solver: the founding waves of the
start map were all refused at 0.5 Myr of star time. In the field's own frame a
rigid rotation changes nothing — a route between co-rotating stars is the
distance between them — and the only thing that stretches a leg is the
differential drift, which is exactly what tears routes apart.

Both endpoints are predicted at the same star time, which is what cancels the
common motion. `SOLVE` runs `INTERCEPT_ITERS = 6` fixed-point iterations from
the current separation and stops at `INTERCEPT_TOL_LY = 0.5`; the map is a
contraction when the separation's rate (the cached-velocity projection, §9.1)
times κ is below the hull speed, which the freighters satisfy by two orders of
magnitude (2 000–4 500 ly/Myr of star time at the synced rate against ~15 ly/Myr
of drift at 60 Myr). A generation hull flies 30 ly/Myr and does *not* always
satisfy it: at a fast star clock the shear outruns it, the iteration runs away
instead of settling, and the plan is marked `outrun` — the partner is
**unreachable** whatever the distance, and is refused at scoring and at launch.
The ordinary case — a pair the sky has simply pulled past `MAX_LEG_LY` /
`MAX_FOUND_LY` — is refused by the same law with the cap applied to the
intercept distance, so the cap and the flown leg are finally the same number.

### 9.4 Pursuit: the hull as a steering agent

Prediction is a refinement of *booking*; pursuit is the behaviour that survives
not having it, and it is what the blind and mirrored tiers run on. Twice a
second every sailing hull re-aims at its endpoints' current live positions —
the same intercept solve from the part of the chord still ahead of it when a
predictor exists, the plain separation otherwise — and re-times its arrival.

The hull's position on the chord is its **flown distance over the current
chord**, not the elapsed time over the booked one:

```
u  = legFrom + (legTo − legFrom) · clamp(speed·(t − depart) / (chord · |legTo − legFrom|))
```

Both endpoints move, so the chord under the hull changes; a hull that has flown
`speed × elapsed` light-years sits that distance along the chord as it is now.
A chord that grows therefore holds the hull back — a receding destination is a
longer chase, not a leg that completes itself — and a static sky makes this
exactly the time fraction the overlay always drew. (With the time fraction, the
first version of this pass let a voyage whose chord had grown to 12 000 years
still read as 97 % flown, so the hull was never in danger and never turned
back.)

The give-up is a **margin**, `DIVERT_FACTOR = 1.6` of the cap the voyage was
booked under, plus the `outrun` flag which needs no margin. A hull past it is
**diverted**: a freighter flies home to the port it came from with its cargo
(the ordinary `EV_ARRIVE` path then offers it there), a founder takes the
failed-founding path, which returns the volunteers to the source's population.
`legFrom`/`legTo` carry the turn: the chord keeps both ends, `legTo` becomes 0
and `legFrom` the hull's fraction, so the dot keeps moving instead of jumping to
the far end of its route. `net.diverted` counts them and the panel says so,
because a network whose routes are being torn by the sky should show it rather
than silently accumulate thousand-year voyages.

Pursuit needs no horizon — only where the endpoints are now — so it is the
honest answer for the friction field and for decoupled clocks: aim, re-aim twice
a second, give up when the target is out of range. Its cost, measured: a
maintenance pass over a full 128-hull fleet is 512 predictions — 0.4 ms on the
closed-form masks, 1.4 ms on the friction field's mirror — twice a second, and
zero when the sky is frozen, which is why it is a maintenance pass and not a
frame pass.

### 9.5 The friction field's tracked mirror

Under a `simple` mask a field record's azimuth θ lives in the GPU compute buffer
and the CPU never reads it back (`movement-parity-plan` decision 4), so
`engineRecordPosition` returns the classic law or the birth position and reports
the approximation. For trade that is not good enough to be an approximation:
measured against the friction field's own integration, the classic law diverges
from it by 0.3–19 kpc of *position* within 50 Myr (a disc star at 13 kpc:
24 500 ly at 50 Myr, 50 600 ly at 100 Myr), because the two are different orbits
— an epicyclic family against a jammed circular one — not one law and its error
term. So under the friction field a position is either mirrored or blind; there
is no cheap stand-in.

`orbit.js` therefore carries a **tracked mirror** beside the landmark one: the
same law (`simpleOmega`, `simpleSubsteps`, `simplePositionFromTheta`), a θ per
tracked record, ≤ 512 of them, which is the network's ports plus its candidate
pool. It is seeded from the placed birth azimuth at the instant the renderer
seeds its θ buffer (`setEngine`, R, a field rebuild — main.js's
`initSimpleLandmarks` is that instant for the CPU), stepped once per frame with
the frame's own `dtStar` and substep rule, and reconstructed from the record's
raw birth the same way the vertex stage does. Cost, measured: 43 µs per frame
for all 512 entries at the rates that matter (one substep per frame at
1 Myr/s), against a compute dispatch over the whole field; a prediction is 3 µs
(a derive plus a few substeps), which is what the booking and the re-aim are
budgeted in (`INTERCEPT_ITERS` for a booking, `RETIME_ITERS = 2` for a re-aim).

A star first tracked *after* the seed instant — a frontier candidate found at
T = 50 Myr — catches up by integrating from it in substep-bounded chunks rather
than in the frame-sized ones the GPU used. Measured against per-frame stepping
over 10–1 000 Myr at 20 and 60 fps: 10⁻⁴–2·10⁻³ rad for the disc and pattern
families (3–19 ly at 8–13 kpc), worst 2.6·10⁻² rad (85 ly) for an inner bar
star, exact for the pressure family. Below a trade leg's own scale, and zero for
anything tracked from the seed. A catch-up that would cost more than
`TRACK_CATCHUP_SUBSTEPS` is refused rather than coarsened — the record stays
blind and pursuit owns the voyage.

Prediction under the mirror is the same integrator run forward on scratch state,
bounded at `SIMPLE_PREDICT_SUBSTEPS = 96` substeps (~32 Myr of horizon on the
Milky Way's own rate table, far past any leg the network books); past the bound
`simpleTrackThetaAt` returns −1 and §9.4 owns the voyage. The landmark mirror
gets the same forward integration, because the start map's local sky *is*
landmarks.

The mask ladder stays in one place: `engineRecordPositionTheta` /
`engineLandmarkPositionTheta` take an external θ (−1 = "none, behave as today"),
so the parity contract of `movement-parity-plan` is untouched for every existing
caller and the tracked path adds no second dispatch.

### 9.6 The frontier scan

The scan gates a birth-frame field buffer against birth-frame ports. Under
movement it stretches the coarse gate by the shear the clock has applied — a
pair `R` apart at radius `r` drifts by ≈ (vFlat/r)·R·T — **plus the epicyclic
spread the classic law gives two stars of different phase and rank**,
2√2·σ·r/vFlat. On the Milky Way's own numbers that floor is 3.2 kpc, so the
pre-gate is at its cap (`FRONTIER_STRETCH_MAX = 8` × the 600 ly gap = 1.29 kpc)
from the first Myr: the epicyclic motion is there whether or not the clock has
run, and the gate is the honest width of "the birth neighbourhood" rather than a
clock-grown one. What it buys is a proposal net wide enough that the *exact*
gate behind it — the drawn distance, applied before the expensive
`generateSystem` — is what decides. The stretch can only widen the net; it can
never admit a birth-frame artefact as a candidate, and the launch decision reads
§9.1's cache in any case.

The exact gate is bounded too: `FRONTIER_LIVE_PER_SCAN = 800` resolves per call
(the ring cursor keeps the place), because a stretched ball around 64 ports
covers most of the disc and 4 000 resolves would be a 5 ms hitch twice a second.
The frontier then grows a little slower under a moving sky, which is the right
trade for a frame budget.

### 9.7 What a moving sky does to the network

Measured on the 24-landmark fixture §17 uses (seed 4242, its own start map, no
frontier scan — so 12 ports is the fixture's ceiling, not the scenario's), at
the page's default rates: 1 Myr/s of sky, 100 y/s of trade, κ = 10⁻² Myr per
trade year, refreshed and re-aimed twice a second.

| run | ports | sailing at 120 s | units hauled at 120 s | diverted |
|---|---|---|---|---|
| frozen sky | 12 (by 20 s) | 21 | 550 800 | 0 |
| 120 s of sky (120 Myr) | 12 (by 20 s) | 14 | 356 800 | 0 |

The network keeps trading and keeps growing through the first twenty seconds of
shear and then holds: the four seed ports' six pairwise distances run 47–862 ly
at birth and 113–3 194 ly at 100 Myr — shear closes one pair and opens another
past the cap — so the 3 000 ly freight cap becomes the binding constraint and
the fleet works the shorter pairs it still has. Growth of *new*
colonies slows for the same reason — a 600 ly founding promise in a sky that has
stretched four times is a 2 400 ly promise — which is the honest reading of a
galaxy being wound up, not a stale map. A *jumped* sky (the test's 900 Myr in one
refresh) turns the hulls in flight around, which is §9.4 doing what it exists
for; so does a star clock ten times faster than the sync, where the shear
outruns even a generation ship. Pausing the star clock hands the network its
birth geography back at the next refresh — that is what the two separate clocks
are for (§1).

### 9.8 Checked

`experiments/trade-test.js` §17 drives the shipping dispatch as the sky (a
resolver over the network's own records) through every tier: the frozen tier is
bit-identical to the birth-frame network (ports, populations, deliveries); the
cache holds the drawn positions and the refresh difference rates; a booking is
the endpoints' separation at arrival, and a frozen refresh falls back to the
birth leg; a partner past `MAX_LEG_LY` is refused, and a generation hull refuses
a receding partner inside the cap for the `outrun` reason; a voyage the shear
tears past the cap turns around, is booked home over the part of the chord it
has flown, and docks at its origin, and a diverted founding wave is refunded to
the population it was drawn from (measured across the arrival event); the
frontier pre-gate opens with the moving sky, never past its cap, and its shear
term grows with the clock on a cold disc; the hull's chord fraction is its flown
distance (and a divert reverses it); the friction field's resolver reads the
tracked mirror rather than the birth sky; and 120 s of shearing sky leaves no
hull on a leg past the give-up margin while the network still trades and still
grows.
`experiments/orbit-test.js` §13 pins the θ ladder (with no θ it *is* the plain
dispatch, for every mask and both reports), the reconstruction against
`simplePositionFromTheta`, the mirror's lockstep against the shipping law, the
prediction against per-frame stepping, the refusal past the horizon bound, the
late-tracked catch-up bound, and the reset/rebind semantics.
`experiments/wgsl-validate.js` follows the ladder into the θ twin, so the
movement-parity contract is still pinned by source shape.
