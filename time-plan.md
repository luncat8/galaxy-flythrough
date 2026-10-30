# time — one clock board, three progressions, and a fleet that is a picture

**Status: built (trade.34), progressions corrected (trade.36, 2026-10-29).**
This plan is the spec a fork reimplements from: §1 the board, §2 the three
progressions and §2.1 the generation-ship law that replaced the mode, §3 the
intra fleet's new law (which supersedes `trade-4-plan.md` §0.1 and §2), §4 the
fleet in every render, §5 what is refused and what is left open.

trade.36 removed the one thing in this plan the user reported as a defect: a
progression press that set the **star** clock and an evolve switch, re-dating the
galaxy from a button about fleets. A progression is now a game-clock profile and
nothing else (§2), and a generation ship is a colony's own economical decision
rather than a global mode (§2.1).

The brief, in the user's words:

> system delta-v dependent trades — direct online when the view is opened and
> averaged offline when the player does not see it […] system ships have their
> own timer that is for good animation, but trade is averaged to the selected
> game time. […] I think we need a new panel to aggregate all timers (keeping the
> old sliders in the specific panels) to keep time organisation centralized.
> Typical task is to choose what trade and colony time is related to star time
> and opened planet-system time.

Plus the report that started it: *"I open system and plan using keys V-B-B and
don't see ships on any of the renders."*

## 0. What was wrong

1. **Four clocks, no ledger.** Star time (Myr/s), the colony clock (y/s), the
   schematic's clock (y/s) and the helm's clock (y/s) each had a control in a
   different panel, two of them had a coupling checkbox buried beside the thing
   they coupled, and nothing said what the other three were doing. Choosing a
   progression — generation ships, fast trade, a static sky — meant knowing
   four panels and two laws.
2. **The fleet's picture depended on the economy's clock.** trade.25 booked a
   settle's mass onto hulls and landed it on the network clock. At the authored
   1 000–2 000 colony years per second a Hohmann leg is a fraction of a frame,
   so the schematic was empty between arrivals and the picture moved whenever
   the *trade* clock did. Worse, the drawing could not be watched at the pace a
   viewer actually wants (0.01–1 y/s) because the data had already landed.
3. **The ferries were drawn on one render only.** `draw()` returned after the
   delta-v map, so `V` then `B` then `B` (schematic → classic map → rail render)
   showed a system with no ships on every map render — the reported bug.
4. **Nothing said which clock a colony was on.** The generation-ship mode
   silently forced star time and the sync checkbox; turning it off left the
   pair behind.

## 1. The clock board (`#time-menu`, `src/core/timeboard.js`)

A ninth workspace panel, appended as bit 8 (the bit order is append-only —
overrides are persisted masks). It lives in the inner column under **Trade**,
the panel whose clock it explains. It is present in **observe** and **command**;
fly keeps its two panels and can add it through the panels override.

The board is a **ledger plus two links**, not a second set of sliders — the
brief asked for exactly that ("keep also old sliders in specific panels"):

| Row | Clock | Where its control lives |
|---|---|---|
| star | the galaxy: Myr/s, `evolve`, the epoch | Display (`star time`, `Evolve`, `Age`) |
| colony | settles and voyages: y/s | Trade (`Trade clock`, `Sync time`) |
| system | orbits, ferries, routes: y/s | System & routes (`System time`) |
| ship | the helm: y/s | Flight / the wheel / the SIM-ARCADE presets |
| epoch | the census's age, Gyr | Display (`galaxy age`, read-only here) |

Two links, both checkboxes on the board **and** on the panel that owns the
clock, one writer each:

- **colony ← star** — `setTradeSync`. The law is trade.js's own
  `clockRate`: 1 star Myr is 1 000 colony years, capped at 2 000 y/s. `1`
  (Myr/s) × 1 000 = 1 000 y/s is the pace the network is authored for.
- **system ← star** — new in this pass. One schematic year per star Myr per
  wall second (`TimeBoard.SYSTEM_STAR_BRIDGE = 1e-6`; 1 Myr/s of sky is 1 y/s
  in the view). Applied on the frame the schematic is about to step, and snapped
  to the layer's own ladder stop, so the rate the board prints is the rate the
  orbits, ferries and routes run at. A frozen (`0`) or camera-following (`−1`)
  star clock has nothing to lend, and the layer keeps its own rung.

Neither link writes a rate the layer does not own: the board asks for a rate,
`SystemLayer.sysTimeRateAt(sysTimeIndexOf(rate))` answers with a stop, and the
slider in System & routes is repainted only when the stop changed.

## 2. The three progressions

`TimeBoard.MODES`, set as one press. A progression is a **game clock profile**:
it says what the colony clock and the opened system's clock are related to. It
never touches the star clock, the epoch or the galaxy's age — that was the
defect §0.3 records, and `trade.36` removed it. The retired "generation ship"
progression set the star rate and an evolve switch; the table below is what
replaced it.

| Progression | colony clock | schematic clock | What it is |
|---|---|---|---|
| **one clock** (`linked`) | synced to the sky (1 000 y/s at 1 Myr/s) | synced to the sky (1 y/s at 1 Myr/s) | everything the player watches advances together: the colonies, the opened system and the stars share the star clock's pace. The star clock itself is Display's, untouched |
| **trade** (`trade`, default) | synced to the sky (1 000 y/s at 1 Myr/s) | own, 1 y/s | the default. Fast hulls on a slow but visible sky: a long haul is overtaken by the stars it crosses, routes tear and go out of reach (`trade.30`'s reach law), and the frontier keeps moving |
| **planetary** (`planetary`) | own, 50 y/s | own, 0.5 y/s | nothing rides the sky: delta-v flying inside a system, orbits and ferries at a watchable half-year per second, colonies creeping. Interstellar travel still takes the colony clock's centuries |

The default is **trade**. The star clock's boot rate is `Presets.TIME_DEFAULT`
(1 Myr/s) and is *independent* of the table: no progression names it, so the
boot frame and the default progression are the same frame only because the
settings say so. Each game rate is checked against its own control's stops by
`experiments/timeboard-test.js` — a progression may never name a rate its
slider cannot reach — and the same file asserts that a progression has exactly
the four fields it uses, that no entry carries `star`, `evolve` or `generation`,
and that `applyTimeMode` in `main.js` assigns only the colony ladder and the two
links.

The notes are the plan in one sentence each, and they are printed under the
progression buttons, so the panel explains itself without this file.

**The lit button is read, never remembered.** `TimeBoard.matchMode(state)`
answers which progression the live game clocks *are* — `{ tradeRate,
tradeSynced, systemRate, systemSynced }`, and nothing else; an unlinked clock is
compared by its rate, a linked one only by the link — so dragging the colony
slider after a press leaves the progression lit no longer, and the note under it
says `hand-set`. The boot defaults (an unsynced 100 y/s colony clock, a frozen
schematic) are deliberately *not* one of the three: they are the settings menu's
own defaults, and a progression is a choice.

### 2.1 Generation ships are a colony's decision, not a clock

The retired progression also carried a global generation-hull flag: every hull
in the network flew 1 ly per 33 years and every warehouse stretched to 5 000
years. That is gone (`trade.36`). What the fleet does instead:

- A colony **may build** a generation ship when, and only when, all three hold:
  the world is **stranded** (`candidate.reach === 0`: no port within
  `MAX_FOUND_LY` 600 ly, so no expedition can be booked), it is **worth
  centuries** (`GENERATION_MIN_HABITAT` 0.42 — a terran or habitable-zone world,
  well above the ordinary founding floor of 0.10), and the colony has the people
  to spare. The ship's own reach is `GENERATION_MAX_FOUND_LY` 2 400 ly, so it
  opens a frontier the expeditions cannot.
- It flies `GENERATION_LY_PER_YEAR` = 1 ly per 33 trade years, booked on the sky
  **as charted at departure**: a colony planning a voyage of centuries plans to
  the world its telescopes see, and the drift that follows does not re-open the
  booking. The maintenance pass never re-aims it and never turns it around
  (`retimeRoutes` skips `ship.generation`), and the arrival's reach gate is the
  ship's own cap, not the freighter's.
- One colony builds one ship per `GENERATION_COOLDOWN` (20 000 years) and the
  network flies at most `MAX_GENERATION_IN_FLIGHT` (2). Generation voyages do
  **not** occupy the ordinary founding lane, so the frontier keeps expanding
  beside them.
- Nothing global moves: the freight hulls keep their table speeds, the
  warehouses keep the authored 150-year horizon, and `economy` no longer has a
  reserve scale at all.
- It is slow, which is the point: 2 000 ly is 66 000 colony years. At the
  default 100 y/s that is eleven minutes, at the top of the ladder 33 seconds —
  the player winds the clock up to watch it, exactly as the brief asked. The
  Trade panel's state line prints `· 1 generation ship (66 000 y)` so the voyage
  is findable, and the galaxy overlay draws it on its founding chord like any
  other founder.

## 3. The fleet is a picture of the average

This is the slice that changes behaviour, and it **supersedes
`trade-4-plan.md` §0.1 (one clock) and §2/§3 (the online/offline contract)**.
The new law, in one line:

> The trade is the average, the fleet is its picture. A settle moves the
> couple's mass instantly on the network's clock; the ferries draw the largest
> recent settled legs on the system clock, at the delta-v time a viewer can
> watch, and carry nothing the average has not already moved.

Why the reversal. trade.25's contract was "opening the view changes the picture,
never the economy", and it held within 0.84 %. But it made the picture a
function of the *economy's* pace: at 1 000–2 000 y/s a whole voyage is a frame,
so the schematic showed an empty system whose dots flickered once a frame; and
the fleet's animation could not be slowed to a watchable pace without delaying
real cargo. The browser pass made both visible. The user's reading — a system
fleet with its own timer for animation, and trade averaged to game time — is the
one that removes the coupling instead of tolerating it:

- **`applyIntraFlows` applies every transfer.** No booking, no withholding, no
  second ledger. The stocks are T4's again, and opening or closing the view is
  provably free: the tests compare two 5 000-year runs byte for byte.
- **`noteIntraLegs` records the picture.** Every actual settlement contributes
  its transferred quantities to the current 25-trade-year bucket. The current
  and preceding bucket form a recent window (up to 50 years); divide their totals
  by the covered time to obtain throughput per trade year. A settle spanning
  multiple buckets is recorded at its completion, not distributed into an
  invented history. This prevents an empty inspection from erasing the previous
  transfer, but old routes expire after the window and never invent cargo. The
  three largest flyable ordered pairs get exactly twelve ferries in proportion,
  with at least one each. Convert each
  resource's units using its own `unitMassT`; passengers use the existing
  colonist-unit conversion, and the readout separately reports actual people.
  Buffers and leg records are fixed per port; the window never touches stocks.
- **The class gate still refuses.** Price the outbound and return directions
  separately: `(dv[out] + dv[back]) × 1.1`. A pair whose round trip exceeds
  every in-system class's budget, or lacks a physical graph/time, is unserved:
  it still trades statistically, but no ferry is drawn and the reason is shown.
  `chemical` (20 km/s) is the short hop, `nuclear` (40 km/s) the rest.
- **The phase is the system clock's.** `system-layer.js` computes
  `timeYears / (2·legYears)` — a full out-and-back — offset per leg and per
  boat, and draws the boats along the leg between the two worlds' *drawn*
  positions. `timeYears` is the layer's own clock, so the fleet runs at whatever
  the viewer chose (or the star link above): frozen, the boats hang where they
  are; fast, they cycle. Nothing in the layer reads the network's clock.
- **A port with no transfer keeps its boats in port**, drawn as two rings of
  docked ticks around the world they load at: "the fleet is here and idle" is
  something the frame says, not something the readout has to.
- **The readout says what it is.** `intraFleetText` prints the ferries, the legs
  and recent tonnes-equivalent throughput per trade year with delta-v and time.
  Selecting a ferry separates actual cargo tonnes from passengers, gives the
  covered span and the outbound and return Δv, and names both clocks. Nothing
  is presented as cargo booked to that hull: the average is not a voyage.

Removed with the old law: `net.intraQ`, `EV_INTRA_ARRIVE`, `bookIntra`,
`arriveIntra`, `intraHandler`, `setIntraOnline`, the hull records and their
`INTRA_IDLE`/`INTRA_LOADED` states. `trade.js` keeps one intra block: the class
gate, the leg records and their readout.

## 4. The fleet in every render

The reported bug: `V` `B` `B` cycles the schematic into the two delta-v renders,
and `draw()` returned after `drawDvMap`, so no ferry was ever drawn there. Now:

- **schematic** — boats on the leg between the worlds' drawn positions (§3).
- **delta-v classic and rail** — the same boats, on the two graph columns of the
  leg's endpoints, along the escape row (`node kind 3`) the interplanetary
  transfers are drawn on. A body that is not in the graph is skipped, never
  guessed: the same refusal the class gate makes.
- The trail behind each dot (`INTRA_FERRY_TAIL_PX`) is what makes a 2 px dot
  read as a ship with a direction; the twelve seat offsets
  (`INTRA_FERRY_SEATS`) keep a leg reading as traffic rather than one bead.

## 5. Refused, and left open

| Idea | Why not |
|---|---|
| Two clocks inside one system (the schematic's and the network's, each draining its own heap) | trade-4 §8 refused it and this pass agrees: two clocks make a hull and the stock it carries disagree about when a leg happened |
| Booking cargo onto the ferries again | the picture would once more be a function of the economy's clock — §3's whole finding |
| A second set of sliders in the Time panel | the brief: the sliders stay in their panels; the board is the ledger and the links |
| Letting the colony link resume a parked star clock on a *mode* press | `resumeStarIfSynced` is the user gesture's extra only; a progression sets what it says, and it says nothing about the sky |
| A progression that sets the star clock or the epoch (the retired `generation ship` mode) | it re-dated the galaxy from a button about fleets: time is time, and the sky's clock belongs to Display. `trade.36` removed it and `experiments/timeboard-test.js` now fails if one comes back |
| A global "all hulls are generation ships" mode with stretched warehouses | same objection, plus it made every voyage a millennium and every colony a famine in waiting. The hull is a per-colony choice with its own reach and its own cap (`time-plan.md` §2.1) |
| Jump gates (planetary mode's interstellar travel) | a real feature, not a clock: routes would need a gate graph, a static star pair, and a cost law per gate. Recorded in `deferred-open-work.md`. The planetary mode ships without it and says so |
| Coupling the *helm* to star time as a new link | it already is: ui.7's shared clock takes over the star axis while flying, and the board says so in the ship row |
| The `time=` preset field | the three modes are `TimeBoard.MODES`; a preset that carried `motion=`/`timemode=` would need the boot path to run `applyTimeMode` before the first field draw. Recorded in `deferred-open-work.md` |

## 6. Validation

- `experiments/timeboard-test.js` (80 checks): the progression table, the label
  and note round-trip, every rate against its own control's stops, the three
  progressions' meaning, the star link's law and its snapping, the live four-key
  match (including a star rate handed in and ignored), the two formats, the boot
  default, and the two regression guards — no entry may carry `star`/`evolve`/
  `generation`, and `applyTimeMode` may not assign the star clock.
- `experiments/trade-test.js` §30 (rewritten): the leg records and their class
  gate, the twelve ferries' split, two 5 000-year runs byte-equal with the fleet
  live (the old 0.84 % tolerance is now an identity), the unserved pair still
  trading, jump = steps, and the readout's words.
- `experiments/panel-test.js`: the ninth panel's place in the inner column, its
  own stylesheet block, the column rule naming it, the five ledger rows and the
  two links, and the three progression buttons.
- `experiments/workspace-test.js`: the appended bit, the nine-panel table, and
  the observe/command sets.
- Browser rows (still to be read on a real GPU): `V` and repeated `B` draw
  boats in all four renders; freezing the system clock freezes them in place;
  the star link moves the schematic rate with the star slider; each mode press leaves the
  board's five rows agreeing with the four sliders it just set.
