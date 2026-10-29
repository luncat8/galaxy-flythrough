# trade-4 — T6: a real intra-system fleet

**Status: built (trade.25, 2026-10-28), then superseded in part by
[`time-plan.md`](time-plan.md) §3 (trade.34, 2026-10-29).** The design below is
what shipped, except where §0.1 says otherwise; the implementation notes and
measurements are in `archive/trade.x-worklog.md` (trade.25). It answers the
deferral recorded in [`trade-3-plan.md`](trade-3-plan.md) §8.

**Read §0.2 first if you are reimplementing the fleet.** trade.34 replaced the
hulls-with-cargo of §0.1/§2/§3 with a *picture of the average*: a settle still
moves the couple's mass instantly (so opening the view is provably free), and
the ferries draw the settle's three largest legs on the system clock, at the
delta-v time a viewer can watch. The reason is measured, not aesthetic: at the
authored 1 000–2 000 colony years per second a Hohmann leg is a fraction of a
frame, so a hull that carries real cargo is invisible whenever the picture is
watchable.

T4 made intra-system trade a *number*: one couple-weighted transfer per settle,
priced by the delta-v graph, with no hull and no travel time. That was the right
call at the inter-star calendar — a Hohmann leg is days to years while a colony
settle is decades to millennia, so latency was noise and energy was not. Inside
an opened system the viewer is looking at exactly the scale where that stops
being true: the schematic draws orbits in years, and a dash that arrives
instantly is a picture, not a fleet. T6 is the slice that makes it a fleet.

## 0. Decisions

1. **Two clocks, two queues, never mixed.** Intra hulls ride the schematic's
   own clock (`SystemLayer.SYSTIME_LADDER`: frozen / follow-camera / 1e-4…100
   y/s) and their own heap (`net.intraQ`). The inter-star network keeps
   `net.queue` and its 100–2 000 y/s ladder. Draining one from the other is the
   64-slot-ledger failure mode in a new hat, and it is what §8 refused.
2. **Online when it is watched, closed form when it is not.** The system view
   open simulates hulls event by event; closed, T4's couple-weighted settle
   stays the operator for that port. The contract between them is §3 — the
   simulated fleet's time-average throughput must land inside the couple T4
   already used, so opening the view changes the *picture*, never the economy.
3. **The hull class is a gate, not a label.** A leg is only bookable if a class
   that can fly it exists: `deltav.SHIP_CLASSES` marks `chemical` (Δv 20 km/s)
   and `nuclear` (40 km/s) as `in-system`, and everything else as
   `interstellar`. A pair whose round trip exceeds the best in-system class's
   Δv budget is *not served* — its couple stays, because T4 already priced the
   energy, but no hull flies it. §4.
4. **Carried, never re-rolled.** The same rule 0.7 established for records: an
   intra hull in flight survives a system-view close, a camera move and a
   residency rebuild. Its state is the event, not the frame.
5. **No new money, no new resources, no new stock pile.** T4's world stocks are
   the only stocks. A hull moves mass between them and nothing else.

## 0.1 What shipped differently, and why

1. **One clock, not two.** §0.1 asked for intra hulls on the schematic's own
   `SYSTIME` ladder with their own heap. They ride the *network's* trade clock
   and a heap of their own (`net.intraQ`), and the schematic draws them as of
   that clock. Reason: the schematic can run at 1e-4 y/s while the economy runs
   at 2 000 y/s; two clocks would let a hull and the stock it carries disagree
   about when a leg happened. The queue is still separate — an intra arrival is
   a different event from an inter-star one — so §8's refusal of a shared heap
   stands.
2. **A close folds the cargo in, it does not strand it.** §3 proposed the hull
   keep an in-flight cargo and `settlePort` withhold the pair until it lands.
   Because the queue belongs to the network, the arrival simply happens whether
   or not the view is open, so nothing needs withholding. Pinned by a test that
   closes the view mid-leg.
3. **Loading is instantaneous at the settle boundary.** There is no
   `INTRA_LOAD` event: the cargo is already at the port and the settle is what
   decides its quantity, so a hull is loaded and departed in the same instant it
   is booked. `INTRA_DEPART`/`INTRA_ARRIVE` collapse into one arrival event per
   hull.
4. **The measured tolerance is 0.84 %, and it is cadence-dependent.** §3 asked
   for 5 % and for the measurement to set the number. At the app's year cadence
   5 000 years of open and closed view agree to **0.84 %**; at a coarse 10-year
   cadence the same comparison is **6.6 %**, because the leg is then 5 % of every
   interval. The test pins the fine case (0.84 %, tolerance 5 %) and this line
   records the coarse one rather than hiding it.
5. **Unserved pairs stay instantaneous.** A pair no in-system class can fly books
   no hull *and* keeps T4's instant transfer, so the engine gate can never be a
   silent economic brake. The schematic reports the count as `unserved`.

## 0.2 What trade.34 changed, and why

1. **The fleet is the picture, the trade is the average.** §3's contract —
   "the simulated fleet's throughput must land inside the couple T4 already
   used" — was held to 0.84 %, but only by letting the drawing depend on the
   economy's clock. A voyage is 0.4 y for a Hohmann leg and the network runs
   1 000 y/s, so the cargo was in flight for a fraction of a frame: the
   schematic showed an empty system, and slowing the view to watch a hull would
   have delayed real cargo. trade.34 removed the coupling: `settlePort` applies
   every transfer, `noteIntraLegs` records the three largest legs (with their
   class, delta-v and Hohmann time), and the ferries are drawn from those
   records on the *system* clock. Two 5 000-year runs now compare byte-equal
   instead of within 5 %.
2. **No hull records, no intra heap.** §2's `INTRA_LOAD`/`INTRA_DEPART`/
   `INTRA_ARRIVE`/`INTRA_WAIT` events, the `net.intraQ` heap and the twelve
   hull records are gone; §0.1's "one clock, not two" question is moot because
   there is no second clock. The class gate (§4) survives unchanged, as does
   the unserved-pair refusal, because they are what makes a pair undrawable.
3. **The schematic's clock is the fleet's timer.** §5's "hulls interpolated by
   `legTimes`" is now "hulls interpolated by the system clock over the leg's
   delta-v time", with a round trip so a standing flow reads as traffic, and
   docked ticks when the port has no transfer.
4. **The fleet is drawn in all three renders.** §5 knew only the schematic; the
   delta-v renders now draw the same boats along their escape row.
5. **The clock board.** [`time-plan.md`](time-plan.md) §1–§2 is the panel that
   says which clock every subsystem is on, and the three progressions that set
   them together.

## 1. What is wrong today

- `trade-3-plan.md` §7 draws up to three dim cargo-coloured dashes for the
  largest last-settle flows, and says so plainly: *"If a dash looks like a ship,
  it is a lie we accept until T6."*
- The intra couple is applied instantaneously at settle time. Two worlds 40 km/s
  apart exchange mass in the same instant a hull would take months to cross.
- The delta-v graph is built at founding (`fillIntraGraph`) and then only read
  for pricing and for the map. Its `legTimes` — the one number that would make
  travel real — is computed for the readout and thrown away.
- Nothing inside a system moves. The schematic animates orbits and belts; the
  economy inside it is static between settles.

## 2. The clock and the queue

`net.intraQ = queueLib.createExecQueue(INTRA_QUEUE_SLOTS)`, kinds:

| Kind | Meaning |
|---|---|
| `INTRA_LOAD` | The hull is at its source world, taking cargo. Reschedules `INTRA_DEPART` after the load tap. |
| `INTRA_DEPART` | The burn happens. Books the leg from `legTimes` and schedules `INTRA_ARRIVE`. |
| `INTRA_ARRIVE` | Delivery: write the cargo into the destination world's stock, then schedule the next `INTRA_LOAD` from the acceptance band. |
| `INTRA_WAIT` | No acceptable cargo at the source. Re-tests on the next rung. |

Drained from `system-layer.stepTime` while the view is open, and from nowhere
else. Closed, the heap is *paused*, not drained and not discarded — reopening
resumes the same hulls at the same event times.

One event per hull, exactly the inter-star discipline: an arrival schedules the
next voyage from its own time, so a 500-year jump on the system clock produces
the same voyages as 500 one-year steps. That invariant is the test, not a
comment.

## 3. The online / offline contract

This is the part that decides whether T6 is a feature or a bug source.

**Offline (the view is closed).** T4's `settlePort` runs unchanged. It is the
operator. It already applies the couple-weighted transfer, already taxes by
delta-v, and already ignores latency deliberately.

**Online (the view is open).** The hulls fly. Their throughput is *not* a second
stock pile: each delivery writes into the same world stock T4 writes, and the
rate at which hulls are dispatched is derived from the couple, so the two paths
converge on the same answer.

The contract, stated so a test can hold it:

> Over a long enough window at a fixed system clock, the mass the simulated
> fleet delivers between two worlds must equal the mass T4's couple would have
> moved over the same window, within a tolerance the plan fixes (start at 5 %,
> measure, then pin what the measurement says).

Three consequences:

- **Opening the view must not change the economy.** A 5 000-year galaxy jump
  with V open and with V closed must land the same world stocks. This is the
  single most important check in §7 and the one §8 was protecting.
- **Closing the view must not lose cargo.** A hull mid-leg when the view closes
  has mass that is neither at the source nor at the destination. It stays on the
  hull (a `cargo` field on the hull record), and the offline path must not
  double-count it — so `settlePort` skips pairs whose hull is in flight, or the
  hull's cargo is folded back on close. One of the two, decided here: **the hull
  keeps it**, and `settlePort` withholds that pair's transfer while a hull owns
  it. Simpler, and it makes "in flight" a real state rather than an accounting
  adjustment.
- **A rewind is honest.** The system clock can run backwards (`-1` follow, and
  the ladder's negative stops). The inter-star network refuses rewinds; the
  intra fleet must too — `intraQ` is monotone in its own time, and a backwards
  system clock pauses it rather than replaying it.

## 4. Hulls and the class gate

Preallocated per opened system, `INTRA_HULLS_MAX = 12`. No allocation after the
first open — same discipline as the rest of the network.

A hull record: `state`, `classId`, `sourceSlot`, `destSlot`, `family`,
`cargoMass`, `departAt`, `arriveAt`, `dvLeg`, `trips`, `delivered`.

**Booking a leg:**

1. Read the pair's Δv from the graph T4 already filled (`dv[source][dest]`),
   and its Hohmann time from `legTimes`.
2. Pick the cheapest class that can fly it: iterate `deltav.SHIP_CLASSES`
   filtered to `domain === 'in-system'`, ascending `dvMax`, and take the first
   whose budget covers the round trip (`leg.dvTotal * 2` plus the reserve the
   ship module already uses). If none can, the pair is **unserved**: no hull,
   and the schematic says so rather than drawing a dash that cannot fly.
3. The family comes from T1's three (`bulk` / `goods` / `pax`), and the cargo
   cap is the class's `cargo`.

`nuclear` will carry most pairs — Earth↔Mars is 2.95 km/s out and 1.26 km/s to
capture, and a belt leg is 5–50 km/s per `trade-3-plan.md` §6. `chemical` is the
cheap short hop; a pair beyond 20 km/s round trip is a nuclear run or nothing.
That is the "respect to available engines" requirement made concrete: the class
table decides what exists, and the map's own numbers decide what is reachable.

## 5. The surface

- **The schematic** draws hulls on the leg they are flying, interpolated between
  the two bodies' drawn positions by `legTimes` — the same interpolation the
  inter-star overlay uses for its chords. A hull at a world draws as a docked
  tick, not a dot in the middle of nowhere.
- **The three T5 dashes stay**, but they become the *standing* flows and the
  hulls become the *actual* ones. When the two disagree, the hull is right and
  the dash is the average — which is exactly the relationship §3 pins.
- **`#sysread`** gains an `intra` block: per hull, `class · family · src → dst ·
  Δv km/s · t y · cargo t`. Capped at the hulls the opened system has.
- **The Trade panel** gains one row: `intra fleet  n hulls · m in flight`, and
  nothing else. The panel is the galaxy's view; the fleet belongs to the system.

## 6. Refused, with reasons

| Idea | Why not |
|---|---|
| Intra hulls on `net.queue` | Different calendar. §8 refused it; nothing changed. |
| A visual-only overlay discarded on close | The rejected reading. Cargo must be real or the feature is decoration. |
| A new intra stock pile beside T4's | Two truths about one world's warehouse. The hull writes T4's stock. |
| Letting interstellar classes fly intra legs | A stardrive in a planet system is a different story and a different price. `domain` is the gate. |
| Simulating intra while the view is closed | The whole point of T4's closed form. The galaxy clock would pay for a picture nobody sees. |
| Rewinding the intra fleet with a negative system clock | Monotone or it is not a fleet. Pause instead. |
| Per-hull routing through intermediate bodies | One leg per voyage. Multi-hop is a later row if the map ever wants it. |

## 7. Validation (what was actually pinned)

- **The contract.** Open and closed over the same 5 000-year window land the
  same world stocks (§3). This is the gate; nothing else ships without it.
- **Jump equals steps** on `intraQ`, the same invariant `trade-test` already
  pins for the inter-star heap.
- **The class gate.** A pair beyond every in-system class's budget books no
  hull, and the schematic reports it unserved. Pin against the Solar fixture
  `dv-map-test` already uses.
- **Cargo conservation.** Mass in flight is counted exactly once, across a
  close, a reopen and a rewind attempt.
- **Determinism.** Same system record, same seed, same clock → same hull
  schedule, byte for byte.
- **Browser rows** go on `deferred-browser-visual-plan.md` as V15: the hulls
  ride their legs, the dashes and the hulls visibly agree over time, and closing
  the view mid-leg does not visibly change the economy.

All five Node rows are in `experiments/trade-test.js` §30 (trade **310/310**).
The class gate's own row from §9 — "measure how many pairs a nuclear hull can
actually fly before trusting the gate" — is answered by the Solar fixture:
Earth–Mars 16.02 km/s is a nuclear run (35.2 km/s round trip with the reserve),
a 3 km/s belt hop is chemical, and 25 km/s is unserved.

## 8. Order, size, commits

| Order | Item | Depends on | Size | Commit |
|---|---|---|---|---|
| 1 | `intraQ` + the hull records + the class gate, no drawing | T4's graph | M | `trade.23: the intra fleet has a clock, a queue and a hull that can be refused` |
| 2 | Booking and delivery against T4's stocks, with the in-flight withholding | 1 | M | `trade.24: a hull moves mass T4 already priced` |
| 3 | The online/offline contract test, pinned | 2 | S | `trade.25: opening the system view does not change the economy` |
| 4 | The schematic's hulls and the `#sysread` block | 2 | M | `trade.26: the fleet is drawn where it flies` |
| 5 | The panel row and the browser V row | 4 | S | `trade.27: the fleet is readable from the galaxy too` |

Slice 3 lands before slice 4 on purpose: the contract is the risk, and drawing
hulls before it is pinned would make a regression look like a picture problem.

## 9. Risks

| Risk | Mitigation |
|---|---|
| The online fleet drifts from T4's couple | §3's contract test, pinned before any drawing exists. If it cannot be held at 5 %, the tolerance is set from the measurement and the reason is written here, not absorbed. |
| Double-counting cargo in flight | One owner at a time: `settlePort` withholds a pair while a hull holds its mass. Pinned by the conservation check. |
| The system clock's negative rungs | `intraQ` is monotone; a backwards clock pauses. Tested, not assumed. |
| Hull count making the schematic noisy | `INTRA_HULLS_MAX = 12` and the readout cap. Twelve hulls on six worlds is already one per pair. |
| The class gate makes most systems unserved | Measured first: run the gate over the existing fixtures and record how many pairs a nuclear hull can actually fly. If the answer is "almost none", the gate is wrong before the fleet is. |
