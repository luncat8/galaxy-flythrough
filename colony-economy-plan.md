# Colony Economy — Resources, Population and Trade

Consumes `archive/draft-colony-resources-trade-fab.md` (the seed draft at the branch
tip). The draft's three asks, restated as the spec this plan implements:

1. **A stable resource map per system** — what is easy and what is difficult to
   produce there, derived from star type, planet types and a small stable-hash
   jitter ("low metal, low light" make things difficult).
2. **Population that grows when its needs are met** — "population - needs - all
   resources are cheap and available enough - pop growth - more resources
   produced and needed".
3. **Factories that work on events, never per frame** — "factories work not per
   frame but per ship arrive event or user inspect with click on star or planet
   in system panel view". A colony's economy advances only when the player docks
   at its port (arrive) or opens its system view (inspect).

Everything here is CPU-only and additive, like the 0.5 series and game mode:
no star-buffer, WGSL or render-path changes. The hold/credits live on the hull
records the way the tank and life support already do.

## §1 Resources

Six fixed resources. One unit = one ton of hold cargo; prices in credits (cr).

| idx | id    | label                  | base cr/t | category | production driver        |
|-----|-------|------------------------|-----------|----------|--------------------------|
| 0   | rare  | rare elements          | 8         | material | capital, metals          |
| 1   | chem  | special chemicals      | 5         | material | capital, giants + belts  |
| 2   | anti  | antimatter             | 40        | material | capital squared, energy  |
| 3   | food  | food & biotech         | 3         | life     | labour, terran + light   |
| 4   | fab   | factory cores & robots | 10        | industry | capital, metals + energy |
| 5   | info  | software & world data  | 6         | culture  | labour (flat ease)       |

The draft's longer lists fold here: "computers" joins `fab` (one industrial
row); "information and world data" and "unique items" are the one `info` row
(art, religion, history are the high-value tail of the same good); colonists
and tourists stay unmodelled in this stage — founding population covers the
draft's "colonists" role, and tourism is a §7 follow-up.

## §2 The resource map (deterministic, per system)

`resourceMapFor(record, model)` is a pure function of the generated system
record (the same `generateSystem` output the schematic view reads) and the
model seed. Same star → same map, on every call, in every session.

Derived scalars, all clamped to [0, 1]:

- `metalRich = star.metal / 0.030` — solar Z 0.020 → 0.667; a metal-poor halo
  star lands near 0. The draft's "low metal" penalty.
- `lumNorm = sqrt(star.lum)` — a dim M dwarf (0.01 L☉) → 0.1, the Sun → 1.
  The draft's "low light" penalty, and the energy supply behind antimatter.
- `rockyFrac` — rock/super/dwarf planets plus twice the belt count, over
  planets plus twice the belt count plus 2 (the +2 keeps a bare system at a
  mid-low value instead of dividing by zero).
- `giantFrac` — gas/icegiant/mini planets over planets + 2.
- `beltFrac = belts.count / 2`, `terranFrac = terranCount / 2`,
  `hzFrac = in-HZ count / 2` (all clamped).

Ease, before jitter (each clamped to [0, 1]):

| id   | ease                                                              | why |
|------|-------------------------------------------------------------------|-----|
| rare | `0.15 + 0.85·metalRich·(0.35 + 0.65·rockyFrac)`                    | needs a metal-rich star *and* rock to mine |
| chem | `0.10 + 0.55·giantFrac + 0.20·beltFrac + 0.15·lumNorm`             | feedstock is volatiles from giants and belts |
| anti | `0.05 + 0.95·lumNorm`                                              | pure energy; the capital square in §3 keeps it late-game |
| food | `0.05 + 0.55·terranFrac + 0.20·hzFrac + 0.20·lumNorm`              | terran worlds, habitable light |
| fab  | `0.20 + 0.50·ease.rare + 0.30·lumNorm`                             | industry is metals plus power |
| info | `0.30`                                                             | flat: culture is population, not geography — stocks and pop carry the variation |

Jitter, the draft's "a bit of random":
`ease[i] += (hash01At(colonySeed, 0x50 + i) - 0.5) · 0.12`, clamped.
`colonySeed = hash4(star.key, model.seed, 0x43f6c0, ref.kind | 0)` — same
identity domain the planet generator keys systems by, so the jitter is as
stable as the planets.

Founding score (sizes the first settlement):
`score = clamp01(0.45·ease.food + 0.25·ease.rare + 0.15·ease.fab + 0.15·lumNorm)`.

## §3 Colony state and the advance law

`createColony(starKey, name, foundedY, map)`:

- `pop = 1 + 9·score` (thousands of persons), `capital = 1 + 5·score`
  (industrial points), `stock[6] = 0` (tons), `lastY = foundedY`.
- Session state, like a hull: colonies are founded by the player and mutate
  only inside `advanceColony`.

`advanceColony(colony, map, toY)` — the factories. Integration is fixed-step:
`dt = 0.25 y` while the span allows, capped at `MAX_STEPS = 2048` steps (a
longer span coarsens `dt = span/2048` and the readout flags `coarse`). Same
`(state, map, span)` → same result, chunking included.

Per step (all six resources in one pass, then the two scalars):

1. **Produce** `prod[r] = ease[r] · RATE[r] · driver[r] · dt` with
   `RATE` (t/y at ease 1, driver 1): rare 800, chem 800, anti 400, food 2000,
   fab 600, info 600; and drivers
   `fab/rare/chem: capital/25` (clamped), `anti: (capital/25)²`,
   `food: pop/50`, `info: pop/100` (clamped). Food and info are labour: they
   scale with people. Antimatter is the only capital-squared good — a young
   colony barely makes any, a mature one exports it.
2. **Consume** `need[r] = pop · NEED[r] · dt` with `NEED` (t per 1k persons
   per y): food 20, info 1.0, fab 0.5, rare 0.2, chem 0.2, anti 0.05.
   `take = min(stock + prod, need)`; `stock += prod - take`; `shortfall =
   need - take`. Food dominates the need side, per the draft.
3. **Comfort** `= 1 - Σ shortfall / Σ need` (0 when there are no needs) — the
   fraction of demand the colony met this step.
4. **Population** (logistic in the carrying capacity):
   `K = 40 · (0.4 + 0.6·ease.food) · (1 + capital/25)` (k persons);
   `dPop = 0.06 · comfort · (1 - pop/K) · pop · dt`, and a famine term:
   when `comfort < 0.4`, `dPop -= 0.04 · pop · dt` (4 %/y die — a colony
   meeting under 40 % of its demand is starving; the canonical food-poor
   founding measures 0.29, which the first draft's 0.25 bound let grow).
   `pop` floors
   at 0.05 k — a colony never reaches exact zero (the port still reads).
5. **Capital** `dCap = 0.02 · comfort · surplusSum · dt - 0.01 · capital · dt`,
   where `surplusSum = Σ max(0, prod - need)` (t/y). Reinvestment of the
   surplus, 1 %/y decay. Floors at 0.1.

The colony records `lastComfort` (the final step's comfort) and `coarse` for
the readout.

## §4 The market

`marketPrice(r, colony, map)`:

- `supply = clamp01(0.6·ease[r] + 0.4·stockNorm)` where
  `stockNorm = clamp01(stock[r] / (2 years of need + 50 t))` — two years of
  consumption held in stock counts as saturated.
- `price = BASE[r] · (1.6 - 1.2·supply)` — the range is `0.4·BASE` (saturated
  surplus) to `1.6·BASE` (nothing made, nothing stored). One price both ways:
  the colony is a market, not a shop with a spread; the player's margin comes
  from buying where the good is surplus and selling where it is scarce.

Tags for the readout: `SURPLUS` at price ≤ 0.7·BASE, `SCARCE` at ≥ 1.3·BASE,
else `fair`.

## §5 Trade at a port (game mode)

The hold becomes a manifest: `ship.cargoKind` (-1 empty, else a resource idx)
beside the existing `ship.cargo` tons, and `ship.credits` (starts 400 cr per
hull, like the tank a per-hull scalar). The free placeholder loads of G4
("prices and economy are omitted") are removed with this stage — the draft
supersedes them.

- **Found colony** — a button on the Flight panel's Port rows, enabled while
  docked at a port whose star has no colony. Founding is free (the player is
  the catalyst, not the owner; ownership stays out of scope). It creates the
  colony, lands a `colony` typed asset in the ui.1 asset history (the way
  docking lands a `dock-port`), and selects it.
- **`L` / Load** — only at a docked port with a colony. Buys the port's best
  export: the resource with the lowest price per ton among those the port can
  supply (any non-scarce tag first, else the cheapest), quantity
  `min(hold free, credits / price)`, floored at 0. The hold carries one bulk
  commodity at a time — a mixed hold is a §7 follow-up.
- **`Shift+L` / Unload** — sells the whole hold at the port's price for the
  held kind. At a port without a colony both refuse with a notice; there is
  no market to move goods through.
- The Port state line shows the port's market summary; the HUD gains credits
  and the hold kind.

**Arrive advances the economy**: docking at a port with a colony advances it
to the shared clock (`advanceColony(..., gameClockY)`) before the market
reads. **Inspect advances it too**: opening the system view (V, a history
restore, or the view select) of a star that owns a colony advances it the
same way. `gameClockY` accumulates only in game mode, on the shared ship
clock — in observer mode it is parked, so an inspect shows the colony frozen
at its last event. Factories never run per frame: the loop only accumulates
the clock; the expensive recompute happens inside the two event handlers.

The system view readout (appended to `#sysread` by main.js) gains a colony
block when the opened star owns one: population with growth arc, capital,
comfort, the six market rows (ease bar, stock, price, tag), and the founding
year against the shared clock.

## §6 The event ledger and the commissioned routes (stage 2, ui.17)

The stage's priority order was set with the user: events first, then the
GUI, then the integration with star time. All three shipped.

**The ledger** lives where §6 originally put it, `src/core/colony.js`: a
preallocated insertion-sorted array — `schedule`, `dueEvents`, `cancel`,
cap 64 (a full ledger drops the latest; the head, what is due soonest,
survives). Payloads: `ROUTE_DEPART` (route idx), `ROUTE_ARRIVE` (route
idx, resource kind, tons), `MILESTONE` (colony idx, the pop threshold),
`FAMINE` (colony idx, 1 entered / 0 lifted). `advanceColony` takes an
optional third argument — the ledger — and emits the step's crossings
(famine on the 0.4-comfort band, population on the [0.5, 1, 2, 5, 10, 20,
40]k ladder) timestamped at the step's own year; without it the advance
is silent, exactly the stage-1 law (colony-test proves the physics
identical either way). Drains happen at event boundaries only: after each
arrive/inspect advance and once per frame (the per-frame cost is the peek).

**Commissioned routes** (`src/core/trade.js`): a standing convoy a colony
pair runs between its ports. Commissioned at a docked port (origin colony)
for the locked-destination or primary-selection colony; the first
departure is one `PERIOD = 2 y` out and the period re-arms whether or not
a departure carries. Each departure takes the origin's best export,
capped at `CAP = 50 t`, never below the origin's own two-year need
(`GUARD_Y · pop · NEED[kind]`, the shipped index-ordered NEED — see
findings for the §3 prose mismatch): below the guard the departure is
held (no event, no stock move). The origin's stock gives the tons up at
departure; the destination's stock gains them at arrival.

**The two transit laws** — trade time as a gameplay dial, set by the
Flight panel's **Generation ships** checkbox:

- **Off (fast freight)**, `FAST_LY_Y = 0.2` ly/y: the transit is a plain
  scheduled arrival at `depart + distance/speed`; stellar drift over the
  50–500 y hop is ignored by declaration — no star position is consulted
  after the departure snapshot. The economy clock runs on the game clock
  only (the stage-1 law).
- **On (generation ships, the sync)**, `GENERATION_LY_Y = 1e-4` (1 ly per
  10 ky), star time set to 0.1 Myr/s — in observer mode the rate itself,
  in game mode the shared clock's 1e5 y/s rung. The economy clock (`econY`,
  the stage-1 `gameClockY` renamed) becomes the star clock in observer
  mode, so colonies age and convoys fly while the stars drift on screen.
  Over these flights the stars move further than the trip, so the convoys
  home on the destination's live drawn position every step — the better
  route calculation the synced clock needs — and the arrival is
  discovered, not scheduled. `etaYears`' first-order intercept (the drawn
  velocity's fixed point) carries the departure log's ETA; a destination
  that outruns the ship is reported as diverging (`ETA ∞`) and the convoy
  chases it in its own time. (ui.18 §9 refines this: the homing and the
  ETA run in the lane's origin frame — both endpoints co-move, and the
  residual separation is the flight.)

**The GUI**: the events readout under the port market (the economy clock
line, route/convoy counts, the log's tail — cached, event cadence), the
**Commission route** button on the Port rows, the **Generation ships**
checkbox, and the star-time slider's two tracks: the fine 0–2 Myr/s
default in 0.01 steps (0.1 Myr/s is 5 % of that track instead of 0.1 % of
the old 100-wide one), the full −1–99 toggle button beside the value, and
the readout's three decimals under 1 Myr/s. The observer default rate is
1 Myr/s; `fitRateToTrack` snaps off-grid rates (follow parks at 0.1 onto
the fine track, off-grid values step up to the 0.5 grid onto the full
track, never to 0).

## §7 Out of scope (recorded, not promised)

- Mixed holds (more than one commodity), shop spreads, NPC freighters the
  player does not commission, colonist/tourist flows, tourism income.
- Prices for anything the player does not trade; no galaxy-wide equilibrium —
  each market reads only its own colony.

## §8 Tests (`experiments/colony-test.js`)

- Map determinism: same record + seed → identical ease; different stars
  diverge; the jitter stays inside ±0.06 and never leaves [0, 1].
- The ease laws: a metal-poor star cannot make rare; a dim star cannot make
  antimatter or food; terran systems grow food; info is flat.
- Advance: a founding colony on a terran-rich system grows (pop, capital);
  a low-food founding star starves (comfort < 0.4 → famine term bites);
  a span over 512 y coarsens and says so; determinism of the chunking (one
  10 y advance === forty 0.25 y advances).
- Market: price bounds 0.4·BASE … 1.6·BASE; supply grows → price falls; the
  stock term saturates at two years of need.
- Trade: buy fills the hold within credits and capacity; sell empties it and
  pays; no market at a colony-less port; the round trip is profitable only
  across a real ease differential (buy-at-surplus, sell-at-scarce beats
  buy-and-sell-at-the-same-port, which loses nothing but gains nothing).
- Founding: score → pop/capital initial values; a star keeps at most one
  colony; the asset history lands the typed colony.
- The ledger (§6, ui.17): insertion order, FIFO ties, cancel, the 64 cap;
  milestones ascend inside the span and never repeat; famine enters and
  lifts in order; the ledger argument leaves the advance's physics
  identical.
- `trade-test.js` (ui.17): the units (KPC_LY, the generation speed in
  kpc/y), the cargo guard (cap 50, the two-year floor, held departures),
  the fast transit years, the ETA fixed point (static, receding,
  perpendicular, outrunning), and the homing law (static arrival within
  the flight time, the drifting chase, no false arrival when the star
  outruns the ship, swap-last removal). ui.18 adds: cancellation flags a
  route without splicing (slots stay stable, the count stops), and a
  founder convoy — negative dest — rides the same homing law through the
  convoy-record oracle.

## §9 The expansion scenario (stage 3, ui.18)

The user's scenario ask: *a colony at the home H location, ships sent out to
found colonies and trade, an expanding net of routes the player can watch* —
plus a dedicated panel so colony and route controls stop squatting in the
Flight workspace.

**The home seed.** `seedHomeColony()` anchors on `model.home.orbitTarget`
(the Sun for the Milky Way preset, the model centre for the other types —
the same place H homes to) and takes the nearest resident star a radius scan
finds. The seed runs automatically the first time game mode is entered with
no colonies, and from the panel's **Seed home colony** button (enabled until
one exists). The colony is named `Home`; its star is inserted into the
selection set so it carries a ring and a live drawn position from the first
frame. A seed that finds no star in radius reports and retries on the next
game entry — a camera parked outside the residency is the one honest failure.

**The expansion.** The panel's **Expansion** checkbox arms the automation:
each colony sponsors one expedition at a time (`nextExpandY` on the colony
record), dispatched when the economy clock reaches it, the colony is not
starving (comfort ≥ 0.4), the colony count is under 24 and fewer than 8
expeditions are in flight. A dispatch scans (budgeted, never a hitch — the
same slice stepping the click pick uses) the source colony's neighbourhood
for the nearest star with no colony and no expedition already bound for it,
inserts that star into the set, generates its resource map at departure (the
map rides with the expedition — arrival may be a Myr later, when the slot
the ref named is another star), and flies the expedition under the same two
transit laws as freight: fast freight schedules an `EV_EXPEDITION_ARRIVE`
ledger event; generation ships spawn a homing founder convoy whose `dest`
and `route` carry `-(expIdx+1)`. The cadence gap re-arms at one transit
estimate (generation) or 8 y (fast), so a source paces itself to its own
ships.

**The lane's frame is its origin.** A generation ship does 1 ly per 10 ky
while a disc star orbits at ~220 km/s — seven times the ship's speed — so an
absolute-space chase needs a good fraction of a galactic orbit to land (the
first dispatch measured a 125 Myr ETA for a 36 ly hop). But the two
endpoints of a lane *co-move*: what the ship actually flies is the residual
separation. Convoy records therefore carry positions **relative to their
origin colony's live drawn position**, `advanceConvoys`' oracle receives the
whole convoy record (dest alone cannot name the frame), the ETA intercepts
the *relative* drift — which the shared orbital motion cancels — and the
net's drawn dots map back to absolute through the same origin decode. The
same fix applies to freight convoys and their departure log. A target on a
genuinely different orbit family (a spheroid star crossing the disc) still
shows a diverged ETA and an honest chase.

**The home anchor follows the drift.** The model is Sun-centred *at birth*:
the orbit law carries the Sun and its neighbourhood around the galactic
centre, while the camera's home pose stays a fixed point in the birth frame.
A seed anchored there measured zero stars within 65 ly after the clock ran.
`homeSeedAnchor` therefore reads the Sun landmark's **drawn** position (the
other types anchor on the model's centre, which does not drift), and the
automatic game-entry seed carries the freshly boarded ship to the colony it
just made — the scenario's stage is where the sky draws Home now, not where
the birth frame parked the camera.

**Arrival founds and wires the net.** `expeditionArrive` creates the colony
from the carried map at the arrival year, lands the typed `colony` asset,
commissions the route back to the origin colony, and — when another colony
sits within twice the expansion radius — a second route to that nearest
neighbour, so the map grows a mesh, not a chain. A star that won a player
colony meanwhile keeps it; the expedition logs and retires.

**The trade net on the sky.** The label layer gains a pass (`setTradeNet`
+ `drawTradeNet`) drawn every frame from a main.js-owned state record:
active routes as segments between the colonies' live drawn positions,
colonies as small green rings (the home colony amber and larger), convoys
and founder expeditions as dots (freight cyan, founders amber). The pass
runs whenever a colony exists, in either mode, independent of the landmark
labels toggle — it is game state, not chrome.

**The panel** (`#economenu`, right column, above Controls): the seed button
and Expansion checkbox, the **Generation ships** checkbox (moved from the
Flight panel — the trade law is economy business), the events log (moved
from `#flight-events` to `#econ-events`), the colony list (name · pop ·
comfort, click selects the star), the route list (origin → dest, next
departure, ✕ cancels — a cancelled route stays in the array flagged
inactive so ledger payloads and convoy records keep their indices), and a
commission row (two selects + button) so a route can be wired between any
two colonies without docking first. The HUD gains an economy line while
colonies exist. The Flight panel keeps the dock-context Found colony and
Commission route buttons — they are the pilot's quick actions — and the
port market readout.
