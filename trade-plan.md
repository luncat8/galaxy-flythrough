# Trade — colonies, resources and the event queue

The brief is `archive/draft-colony-resources-trade-fab.md`: a colonisation and
trade-route event system on top of the procedural planet generator, with a
stable-hash resource map per world, population that grows when its needs are
met, and factories that work **per ship-arrival event or on inspection** —
never per frame. The time-ordered queue follows the reference implementation
[`luncat8/exec_queue`](https://github.com/luncat8/exec_queue): a binary min-heap
over parallel typed arrays, one current event per ship, revision-checked stale
entries, and scheduling from the event's own time so a clock jump produces the
same state as many small steps.

This series is **CPU-only and pipeline-neutral**. The star buffer, the WGSL and
the three render paths are untouched; colonies exist in kpc at the scale of the
galaxy, and the trade overlay is a 2D pass on the existing label canvas.

It is unversioned like the `ui.x` and `tooling` series (it can land beside or
between model releases) and its log is `archive/trade.x-worklog.md`.

---

## 1. Time

There are two time axes, and they are deliberately not the same one.

- **Star time** is Myr/s: the galaxy turns, the arms shear, the bar rotates.
- **Trade time** is years/s. Colonies live for decades and centuries; a voyage
  at 0.2 c between neighbouring stars is tens of years. On the star clock a
  single frame is 10⁴–10⁵ years, which would collapse every voyage of the
  network into one frame and make the event queue decorative.

So the trade clock is its own geometric ladder in years per wall second
(`TRADE_RATES = [0, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000]`,
default **100 y/s**, `0` pauses it). It runs with wall time and is independent
of the star clock, the ship clock and the system view's clock. The rationale is
the same one that gave the system view its own ladder (§6.4 of the 0.5 plan):
no single axis can show both a 0.5-year docking dwell and a 10⁴-year voyage,
and pretending otherwise would couple the galaxy's age to the colonists' lunch.

`trade.time` is the network's own clock in years, starting at 0. A step is
`drainUntil(time + rate·dt)` followed by `time += rate·dt`.

## 2. Resources

Thirteen resources in four families. The eleven named by the brief are the
tradable ones; `ore` and `volatiles` are the cheap bulk feedstock every colony
also needs and produces.

| id | name | family | unit mass (t) | trade worth |
|---|---|---|---|---|
| `ore` | ore | raw | 40 | 0.25 |
| `volatile` | volatiles | raw | 30 | 0.30 |
| `rare` | rare elements | raw | 60 | 6 |
| `chem` | synth chemicals | synth | 12 | 1.2 |
| `amat` | antimatter | synth | 0.5 | 12 |
| `food` | food & seed | life | 8 | 0.8 |
| `bio` | biotech samples | life | 4 | 4 |
| `people` | colonists | life | 2 | 3 |
| `robots` | factory cores | goods | 25 | 2.5 |
| `compute` | computers | goods | 6 | 3.5 |
| `soft` | software & AI | data | 0.2 | 5 |
| `data` | world data | data | 0.2 | 4 |
| `art` | unique items | culture | 1 | 8 |

`unit mass` converts the player's hold (tons) into stock units; `trade worth`
is only a routing weight — the economy has no money and no prices, matching
0.5's omission and the draft, which never mentions credits.

### 2.1 The site map (the "stable hash" of the brief)

A colony's yields are a pure function of `(key, planet slot, model seed)` — no
PRNG state, the same star always has the same resources:

```
seed   = planets.systemSeed(key, model.seed, blockKind)
yield_r = clamp( PLANET[r][type] · STAR_r(star, planet) · (0.7 + 0.6·u) , 0, 2.5 )
u      = hash01At(seed, EC_CH_YIELD + slot·16 + r)
```

- `PLANET` is the authored 13 × 11 table: rows are resources, columns the ten
  display types plus the belt. A lava world is rich in rare elements and poor
  in food; an ice world is rich in volatiles; a terran world feeds people.
- `STAR_r` uses what the star and the planet already carry: metallicity (ore,
  rare, robots), insolation (antimatter, food, biotech), stellar age (rare
  elements deplete), surface temperature (life), and the generator's own
  `FLAG_TERRAN`/`FLAG_IN_HZ` flags.
- The hash jitter is the brief's "a bit of random": ±30 %, never enough to
  make an ice world a farm.

A **site** exists when `hash01At(seed, EC_CH_SITE + slot) < SITE_CHANCE[type]`
(terran 1.0, super-earth 0.8, desert 0.55, ice 0.45, barren 0.5, gas 0.35,
ice-giant 0.3, mini-Neptune 0.3, lava 0.22, dwarf 0.2; a belt 0.3). Terran is
always settled — the brief's colonisation should not miss the one obvious
world. The rule is deterministic, so opening the same system twice never
changes its map.

### 2.2 Population, needs and the settle

A colony is a record: population `P` in millions, capacity `K`, 13 yields, 13
stocks and 13 stock caps. `K` comes from the display type's habitat weight,
the planet's mass and the star's stability (a terran world is ~900 M, an
outpost a few million).

Production and need are per million per year:

```
out_r = PROD_r · yield_r           (units per million-year)
need_r = NEED_r                     (units per million-year; seven needs)
```

`PROD` peaks at food 0.50 and ore 0.55 and is 0.002 for unique items; `NEED`
peaks at food 0.40 and volatiles 0.30 and includes a small demand for every
advanced good (so a port that makes nothing still imports). Growth weights
(food and volatiles heavy, luxuries light) turn need coverage into one scalar:

```
coverage = Σ w_r · min(1, (out_r·P + stock_r/NEED_BUFFER_Y) / (need_r·P)) / Σ w_r
g        = G_MAX · coverage − DECLINE · (1 − coverage)
```

`NEED_BUFFER_Y = 8` years of stock counts as supply; `G_MAX = 1/80 y⁻¹`,
`DECLINE = 1/120 y⁻¹` (the break-even is coverage ≈ 0.39). Population follows
the logistic ODE `dP/dt = g·P·(1 − P/K)`, whose closed form is

```
P(t) = K / (1 + A·e^(−g·t)),     A = (K − P₀)/P₀
∫P dt = K·t + (K/g)·[ln(1 + A·e^(−g·t)) − ln(1 + A)]
```

and the stock update is `Δstock_r = (out_r − need_r) · ∫P dt`, clamped to
`[0, stockCap_r]`. This is the "factories work per event, not per frame" law:

- **One settle is exact.** A colony inspected after 300 years is the same
  state, to floating point, as one settled each year *while its coverage does
  not change* — the logistic is a closed form, not a step loop.
- **Splitting is exact for a stable colony.** With coverage 1 (or any constant
  coverage) `P(2T) = P(T) ∘ P(T)` and the stock integrals add exactly; the test
  pins this to 1e−9. A colony whose needs cross a boundary inside the interval
  is settled at the boundary by its next event (documented, and the only
  approximation in the model).
- **A jump is not a special case.** Events schedule from their own time, so a
  500-year clock jump runs exactly the arrivals that would have run
  one-at-a-time.

`stockCap_r = 30 + 8 · max(out_r, need_r) · K` units — a warehouse stores a few
years of a mature colony, which is what makes imports worth shipping and
exports finite. A colony below `POP_MIN = 0.02 M` is **abandoned** (a port
leaves the network, its stock is lost).

### 2.3 Inspection

`economy.settleColony(colony, trade.time)` is the only entry point. The system
view calls it at its 4 Hz readout cadence for the opened system, so the panel
shows live numbers; every ship arrival calls it for the destination (and the
source at dispatch). No colony is ever stepped per frame.

## 3. The network

### 3.1 Ports

A port is a colony plus the star identity it lives at:
`{ colony, key, planetIndex, name, ref, x, y, z }`, where `ref` is the
pick-shaped record `{ kind, index, key, x, y, z, colorIndex, absMag }` used by
`selection.resolveDrawn` (ui.2). Ports are capped at 64; discovery is
deterministic and one-shot per key.

Seeding happens once per model:

- **Milky Way** — every landmark system is generated (`planets.generateSystem`
  with the landmark's own colour/magnitude, ~0.03 ms each) and its sites
  discovered. That gives a small, widely spread network across the real named
  stars, plus the rich candidate list of their unsettled worlds.
- **Generated galaxies** — the field is sampled evenly, systems within 3 kpc of
  the model's home are summarised until 20 usable systems are found, and those
  are generated and discovered. Same rule, no landmark table.

Opening any other system (`V`) discovers its sites on the spot and adds them
to the network — the brief's inspection path doubles as exploration. A system
already known is only settled, never re-rolled.

### 3.2 Ships and the queue

Up to 18 freighters from three authored hulls (bulk 1500 units at 0.05 c,
hauler 800 at 0.12 c, clipper 400 at 0.2 c; travel time is
`route.interstellarLeg`'s closed form, `d/v + v/a`). Each ship has **exactly
one current event**:

| kind | meaning | scheduled from |
|---|---|---|
| `EV_ARRIVE` | reach the destination port | the load event's time |
| `EV_LOAD` | unload, choose a new cargo and destination, or wait | the arrival time + 0.5 y |
| `EV_WAIT` | retry a port with nothing to load | the load event + 2 y |
| `EV_FOUND` | a colonisation expedition reaches its candidate | departure + leg time |
| `EV_TICK` | check every port for an expedition | itself + 25 y |

Every ship event carries `(shipRevision)`; a rerouted or retired ship bumps its
revision, so the stale heap entry is drained and skipped without effects. The
queue holds every event of the fleet plus one global tick — tens of entries,
not thousands, because forests of per-colony timers do not exist in this design.

On `EV_ARRIVE`:

1. settle the destination colony to the event time (this is the brief's
   "factories work per ship arrive"),
2. deposit the hold up to the stock cap (leftover stays aboard),
3. on the next tick, choose the port's best export — the resource with the
   highest `(stock − 0.25·stockCap) · tradeWorth` — take at most the hull's
   hold, and choose the destination with
   `score = demand(port, r) · tradeWorth_r / (1 + ly/100)`,
   preferring a port that is short of that resource and near enough to matter,
4. schedule the arrival from the load event's own time.

A port with nothing worth carrying gets `EV_WAIT` and is retried in two years.
Routing is deterministic: tie-breaks come from `hash4(ship id, resource, time
bucket)`, not from `Math.random`.

### 3.3 Colonisation

Every 25 years the tick looks for a port with

- a stock of `people ≥ 500` units (colonist volunteers) and `robots ≥ 100`
  (the factory cores that build the first hab), and
- a free candidate: an unsettled planet of a system already discovered.

It deducts the cost, launches an expedition ship (a fourth state, not a
freighter with cargo), and schedules `EV_FOUND` at the candidate's travel
time. On arrival the candidate's stored site profile becomes a colony with
`P = carried colonists · POP_PER_UNIT` (500 units → 2 M people) and a small
seed stock of robots and food. **Colonisation is an event**, not a special
case, and the new port joins the same routing loop immediately. Candidates are
capped at 256 and consumed once.

### 3.4 Draw positions

Ports are anchored at their star's **drawn** position (ui.2's dispatch through
`selection.resolveDrawn`), so the network rides the rotating galaxy at any
star time. A star that has left the residency (or a re-drawn field) falls back
to its birth position and is drawn as a muted route; the economy itself only
ever uses birth distances, so the simulation never depends on what is on
screen.

## 4. The player

The game mode's cargo hook becomes the economy's port interface (G4's §10.5,
economy no longer omitted):

- `L` at a docked **trade port** loads the port's best export into the hold,
  limited by the hold's tonnage and the port's export reserve; the hold records
  its `cargoResource`. `Shift+L` unloads into the port up to its stock cap.
- The HUD's `cargo` line names the resource (`12,000 t · food & seed`), and the
  Flight panel's Port row reports the port's colony, population and what it
  will sell.
- Docking at a star with no colony keeps the old container hook's refusal
  message — no cargo appears from nowhere.
- The player's holds are tonnage (`ship.class.cargo`); stock is units, and
  `unitMassT` is the one bridge. `ship.cargoResource` is new state cleared by
  `setClass`, `resetShip` and a full unload.

## 5. The display

- **Galaxy view** — a label-canvas trade pass: faint lines between port pairs
  that a ship is sailing (or has just sailed), a dot at each ship's
  interpolated drawn position coloured by cargo, and a small ring at each port.
  Toggled with `Y` / the Controls panel, on by default; hidden in the system
  view, where the schematic owns the canvas. No new render path, no WGSL.
- **Readout (`#sysread`)** — the open system gains a `trade` block after the
  §6.6 readout: each colony's planet letter, population against capacity,
  growth, the three largest stocks, exports and imports; the selected planet's
  colony expands to its 13-resource yield map (`ore ▮▮▮▯▯` …) and its needs.
- **Flight panel** — a Trade section: the trade-clock ladder (a 12-stop slider,
  `0` paused), a routes checkbox, the port/fleet/queue counters, and a
  `<pre>` with the five largest ports and the ships in flight.
- **Overlay** — one line: `trade 100 y/s · 14 ports · 9 ships · queue 11`.
- **Presets** — `trade` (the rate, y/s) and `traderoutes` (0/1) join the
  settings line; defaults are owned by `trade.js`
  (`TRADE_RATE_DEFAULT = 100`, `TRADE_ROUTES_DEFAULT = 1`).
- **R / a new galaxy** — the network is re-seeded (same seed, same ports,
  because the map is a pure function of the model seed and the star keys).

## 6. Files and tests

- `src/core/exec-queue.js` — the min-heap (`push`, `pop`, `drainUntil`,
  `peekTime`, `clear`), typed arrays only, growth by doubling, handler-driven
  pushes during a drain.
- `src/core/economy.js` — the resource table, yields, site discovery, the
  colony record, the closed-form settle, demand/export helpers and formatting.
- `src/core/trade.js` — the network (ports, candidates, ships, clock), the
  event handlers, routing, colonisation, the player's load/unload and the
  per-frame draw-position feed.
- `src/core/ship.js` — `cargoResource` state (cleared with the hold).
- `src/main.js` — seeding, the trade clock, inspection on `V`, the readout
  block, the panel, the HUD line, the overlay feed and the preset fields.
- `src/render/label-layer.js` — `setTradeOverlay` + the faint routes/ships pass.
- `src/index.html` — the three script tags and the Trade section.
- `src/core/presets.js` — the two preset fields.
- `experiments/exec-queue-test.js` — ordering, boundary (`≤ target`), growth,
  pushes inside a drain, revision/stale handling, 50 000-event stress and a
  sorted-array comparison, zero steady-state allocations.
- `experiments/economy-test.js` — resource-map determinism (same key → same
  yields; different key → different map), the site rule, the settle's closed
  form and split exactness, growth/decline break-even, stock caps, demand and
  export laws, port discovery idempotence, a network tournament over 5 000
  simulated years (every ship has exactly one live event; queue never grows
  unboundedly; at least one route cycle; a colony is founded), jump invariance
  of the event stream (one 500-year step equals a hundred 5-year steps for the
  same event times), ship-position interpolation, the player's load/unload,
  and zero allocations in `step`.

Budgets: `drainUntil` allocates nothing once the capacity is reached; a frame
advance is one `drainUntil`, and the fleet's event count is `O(ships)`; the
readout text is built at 4 Hz only; the overlay pass is O(ports + ships) with
preallocated arrays. No per-frame object literals in `main.js`.

## 7. Not in this pass

- Prices, credits, contracts and freight payment (the brief has no money; the
  `ui.1` `cargo-container` asset type remains the hook for a later interface
  series).
- Per-frame factory accounting (explicitly forbidden by the brief).
- Colony buildings/upgrades, terraforming, piracy and blockades.
- Docking at a **planet** rather than the star: the G4 station shell is a star
  shell; the economy port is the system's colony, and the readout names which
  planet the ship is trading with.
