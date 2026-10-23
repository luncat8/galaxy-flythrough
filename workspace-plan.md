# Workspaces — three jobs, one page

Status: **plan, not implemented.** This file is the spec a fork reimplements from;
it carries decisions and invariants, not an implementation log.

The page today has one rig (the camera), one optional second rig (the ship) and a
colony economy that is always running. All six panels are on screen at all times,
so every job is surrounded by the other two jobs' controls, and each control has
to be re-gated by hand (`data-observer`, `data-game`, an `if (gameMode)` in main.js)
for a state the page cannot name.

This plan gives the page **three named workspaces** — `observe`, `fly`, `command`
— one state, one panel table, one writer. A workspace decides which panels exist,
which clock the wheel steps, which HUD line is the subject and who may do what.
Switching is a UI/authority change only: no field rebuild, no network re-seed, no
ship teleport.

---

## 1. The problem, stated exactly

1. **One boolean carries three meanings.** `gameMode` (≈90 references in
   `src/main.js`) simultaneously means *the camera is the ship*, *the observer's
   keys are dead* and *the trade sync is off*. Anything that wants one of those
   three has to test the boolean, so a fourth meaning is free to sneak into the
   same flag.
2. **Panels are an accident of history, not a role.** `#sysmenu` is called
   *Flight* but holds three jobs: the fleet and pilot console (fly), the port and
   cargo hooks (fly, docked), and the system map, energy budget and route
   planner (neither — it is the observer's map). `#trade-menu` and `#help` share
   the bottom row while the map's own controls sit in another panel two columns
   away.
3. **Every panel shows every control, gated or not.** The Controls panel is one
   wall of buttons of which, in any given state, roughly a third are dead and
   greyed. `Tab` is the only bulk lever and it means *hide everything*.
4. **The colony network has a job with no name.** Founding, expeditions,
   expansion, standing routes and the network clock are spread between the Trade
   panel, the docked Port rows and two stray keys. There is no state in which the
   page is *about* the colonies.

The colony observer is therefore not a new feature: it is the third job that
already exists in pieces. Naming it is what makes the other two separable.

## 2. The decision

**Three workspaces, one table, one writer.**

- `observe` — **the sky.** Free camera, orbit and chase; star time; selection and
  search; view modes; galaxy look and presets. Nothing is piloted and nothing is
  governed.
- `fly` — **a ship.** The camera is the active hull; the ship clock owns the time
  axis; fleet, destination, autopilot, port, hold. Any hull in the fleet can be
  piloted, **including a freighter taken off the colony network's routes**
  (§9).
- `command` — **the network.** The colonies as the subject: the trade clock is
  the named clock, authority over expeditions, standing routes, expansion and
  founding; the camera flies free (a commander visits, a commander does not
  pilot).

Rules that fall out of the decision:

1. **A workspace is a state, not a pile of booleans.** Exactly one field —
   `workspace` — plus one predicate `isFlying()`. `gameMode` is retired: every
   existing site becomes `workspace === Workspace.FLY` through that predicate.
2. **A panel belongs to a job.** The panel table (§5) is the only place panel
   visibility is decided; there are no per-row mode checks in markup.
3. **A control is shown or hidden, not greyed, when its whole job is absent.**
   A control that belongs to the current job but cannot run *right now* (no
   selection, tank empty, view closed) stays visible and disabled — the existing
   distinction, made explicit (§6).
4. **The wheel steps the owning clock.** Observe: the camera's speed ladder.
   Fly: the ship clock. Command: the camera's speed ladder (the network clock has
   its own slider and arrow keys). This is the reason `fly` must remain a
   workspace of its own rather than a camera state.
5. **The world does not change when the workspace changes.** No re-sample, no
   network rebuild, no ship movement, no colony re-settle. Panels, HUD, ownership
   of the clocks and the authority gate only (§7).
6. **The network runs in every workspace.** Observing the sky does not pause the
   colonies; only the *panel and authority* move to `command`. The trade overlay
   stays drawn in all three, at the detail each job needs (§11).

## 3. The state — `src/core/workspace.js`

One small, dependency-free module, page and Node alike (AGENTS.md runtime rules),
holding the names, the panel table and the pure transitions. It owns no DOM.

```js
// workspaces
const OBSERVE = 0, FLY = 1, COMMAND = 2;
const NAMES  = ['observe', 'fly', 'command'];

// panels, as bits — the order is the load order in index.html, nothing else
const SEARCH = 0, FLIGHT = 1, ROUTES = 2, VIEWMODES = 3, DISPLAY = 4, TRADE = 5, CONTROLS = 6;
const PANEL_COUNT = 7;
const PANEL_IDS    = ['selection-menu', 'sysmenu', 'routemenu', 'viewmenu', 'menu', 'trade-menu', 'help'];
const PANEL_LABELS = ['Search & Selection', 'Flight', 'System & routes', 'View modes', 'Display', 'Trade', 'Controls'];

const MODE_PANELS = [ /* observe */ 0, /* fly */ 0, /* command */ 0 ];  // §5
```

API (all pure, `out`-free, no allocation on the hot path — nothing here is on the
frame path at all):

| function | answer |
|---|---|
| `modeFromName(name)` | 0/1/2, or `-1` for an unknown name (callers fall back to `OBSERVE`) |
| `modeName(mode)` | the name, or `''` for an out-of-range index |
| `panelsFor(mode)` | the mode's default panel mask |
| `panelBit(panel)` | `1 << panel` |
| `applyOverride(mode, mask, panel, on)` | the mask with one panel added or removed, validated |
| `sanitiseMask(mask)` | `mask & ((1 << PANEL_COUNT) - 1)`, so a stale localStorage value can never invent a panel |
| `visibleMask(mode, frozen, override, autoShow)` | `frozen ? override : panelsFor(mode) \| autoShow` — §5.3 |
| `toggleFly(current, last)` | `current === FLY ? last : FLY` — `g`'s one behaviour |

`main.js` keeps the live record:

```js
let workspace = params.workspace;        // boot, §12
let lastWorkspace = Workspace.OBSERVE;   // where `g` returns to
let panelsHidden = false;                // Tab's flag
const overrides = new Uint8Array(3);     // per-workspace override masks (7 bits), 0 = none
const panelFrozen = new Uint8Array(3);   // override active flag, so "none" and "empty" differ
```

`panelFrozen` exists because a mask of `0` is a legitimate override (*this
workspace shows nothing*); it is stored as a companion `localStorage` key rather
than invented into the mask.

## 4. The three workspaces

| | `observe` | `fly` | `command` |
|---|---|---|---|
| Subject | the sky | the ship | the colony network |
| Camera | free fly · orbit star · orbit centre · chase | the active hull (`Camera.MODE_FLY`, pose written by the ship) | free fly · orbit · chase (no ship) |
| Time axis | star time, `Myr/s` (T freezes) | ship clock, the shared axis (T freezes ship and sky) | star time, `Myr/s`; the trade clock is the named clock |
| Wheel | camera speed ×2 | ship clock rung | camera speed ×2 |
| Selection | click / search / set; `Shift+F` flies the camera | click picks the Flight target; `N` cycles the set | click / search; a colony row or legend mark **visits** (camera flight) |
| Authority | look, star time, presets | burn, autopilot, dock, hold, found (docked) | expeditions, routes, expansion, founding, network clock |
| HUD block | camera + selection + galaxy | the existing game block | network counters + camera + selection |
| Ship chrome | off | on | off |
| System view (`V`) | on | only while docked (unchanged) | on |
| Trade overlay | full | ports + hulls only | full |

**Not a workspace:** the system schematic, the delta-v map, the view-modes
heightmap and the search results are *views* — they open inside a workspace and
are gated by it, they do not replace it. A fourth mode for the map would repeat
the design mistake this plan removes.

**Reasoning for `observe` keeping five panels:** it is the general workspace and
the page's default; its job genuinely spans look, star time, selection and the
map. The two specialised workspaces are the narrow ones: `fly` keeps two panels
(Flight, Controls), `command` four (Search & Selection, System & routes, Trade,
Controls).

## 5. Panels

### 5.1 Ownership

| Panel (id) | Job | observe | fly | command |
|---|---|---|---|---|
| `selection-menu` — Search & Selection | pick objects, search, set | **on** | off | **on** |
| `sysmenu` — Flight (fleet, pilot, port, destination) | fly a hull | off | **on** | off |
| `routemenu` — System & routes (**new**, split out of `sysmenu`) | the map, its clock, energy budget, route planner | **on** | off¹ | **on** |
| `viewmenu` — View modes | the heightmap look | **on** | off | off |
| `menu` — Display (galaxy, look, presets) | the sky itself | **on** | off | off |
| `trade-menu` — Trade | govern the network | off | off | **on** |
| `help` — Controls | this workspace's keys | **on** | **on** | **on** |
| `scenario-menu` — Formation checks (ui.21) | press a formation state, read its account | **on** | off | off |

¹ auto-shown while the system view is open (§5.3) — the docked schematic in `fly`
needs its own clock and budget controls, which today live in the same panel two
columns away from the map.

`MODE_PANELS` therefore is:

```
observe: SEARCH | ROUTES | VIEWMODES | DISPLAY | CONTROLS | SCENARIO
fly:     FLIGHT | CONTROLS
command: SEARCH | ROUTES | TRADE | CONTROLS
```

The panel bits are **append-only** (`core/workspace.js`): a workspace's override
is a mask in `localStorage`, so a new panel takes the next bit and never
renumbers one already on a user's disk. The DOM order is the columns' business;
`ui.21` put the eighth panel (`SCENARIO`, bit 7) at the top of the right column
without moving the seven that came before it.

### 5.2 The split of `#sysmenu`

The panel is cut along its existing section headings, with no change to any row:

- **`#sysmenu` (Flight)** — Ships (fleet bar, `Spawn at camera`, ship list), Pilot
  (class/refuel, thrust, desired speed, velocity axes), Port (dock, cargo,
  found), Fly to destination (destination, both autopilot boxes, plan mode,
  arrival-by, forecast).
- **`#routemenu` (System & routes)** — View select + Open, System time, Budget,
  Round trip + Clear route, Start autopilot, `Current + previous`, the route
  hint, and the system/trade readout hint.

The map's own rule is unchanged: `fly` may open it only while docked, and a
docked schematic must not move the camera (game-mode-plan §7.1).

### 5.3 Columns and the auto-show rule

Columns are the existing three, filled by role:

| column | observe | fly | command |
|---|---|---|---|
| left | Search & Selection, System & routes | Flight | Search & Selection, System & routes |
| inner | View modes | — | Trade |
| right | Display, Controls | Controls | Controls |

`visibleMask` = `frozen ? override : panelsFor(mode) \| autoShow`, where
`autoShow` is currently just `ROUTES` while `systemLayer.isOpen()`. Precedence is
deliberate: a user override is authoritative, an open view only *adds* its panel.
`applyPanels()` must therefore also run on system-view open/close, beside
`syncViewRows`.

`leftPanelInset()` / `rightPanelInset()` stop returning constants: they sum the
widths of the visible panels in each column, so `#overlay` and `#sysread` keep
clearing the panels as they appear and disappear.

### 5.4 `Tab` and the override

- `Tab` toggles `panelsHidden` (hide all ↔ restore the visible set). This keeps
  today's screenshot lever and nothing else.
- The mode bar's **panels ▾** menu lists all seven panels with checkboxes and
  writes the current workspace's override (`applyOverride`, saved per workspace in
  `localStorage['galaxy.workspace.' + name + '.panels']`, `panelFrozen` beside
  it). Checking a hidden panel is the one way to see another job's panel without
  switching jobs.
- A workspace switch **clears** `panelsHidden` and re-applies; overrides survive
  (they are the user's, per workspace, and persist across reloads). Per-panel
  `▾` collapse stays exactly as it is, stored per panel id.

## 6. The Controls panel is the workspace's cheat sheet

The user-facing principle: *help shows the keys of the job you are doing, and
nothing else.*

- Every control in `#help` carries **one** attribute, `data-mode="observe fly"`,
  replacing `data-observer` and `data-game`. The list is the modes in which the
  control exists at all.
- A control whose modes do not contain the current workspace is **hidden**
  (`hidden` attribute), not greyed. A control in the current workspace that
  cannot act right now (no primary, no set, autopilot off, not docked) is
  **disabled**, as today.
- The free-text hint block at the bottom becomes three blocks, one per workspace,
  same rule. Observe keeps the fly/orbit/selection lines; fly keeps the burn
  block; command gains its own (`wheel camera speed · trade clock slider/arrows ·
  H home colony · click a colony to visit · Send expedition · Commission route`).
- The panel's header names the workspace (`Controls — fly`), so the panel answers
  "what am I doing" as well as "what do I press".

This is the same principle the first review asked for in miniature: relevance is
scoped by the selected job, not printed all at once. Nothing about the *world* is
explained here — the panel stays a control list, not a manual.

## 7. Switching

### 7.1 Keys and the mode bar

- `1` `2` `3` (`Digit1..Digit3`, unmapped today) — observe / fly / command. They
  fire the one-shot actions `modeObserve`, `modeFly`, `modeCommand`; the input
  layer's existing `editingField` guard already keeps digits out of form fields.
- `g` (`KeyG`) — also `modeFly`: `setWorkspace(Workspace.toggleFly(workspace,
  lastWorkspace))`, i.e. enter `fly`, or leave it for the workspace it was
  entered from. One action, two keys, no second code path, and the key users
  know and the README documents survives the rename.
- `Shift+g` — unused, reserved.
- `Esc` — unchanged (system view first, pointer lock in fly). A workspace is
  never exited by `Esc`: losing the helm by a stray key is not acceptable while
  a hull is moving.
- The **mode bar** (top centre, `#mode-bar`) is always visible and is the single
  place the state is legible: three chips `observe 1 · fly 2 · command 3` with the
  active one lit, the owning clock beside them (`star 1.0 Myr/s · T` /
  `ship clock +0.5 y/s · wheel` / `trade 100 y/s · slider`), and **panels ▾**.
  It replaces the overlay's `mode game` line as the answer to "where am I", and
  it is the only new always-on chrome.

### 7.2 `setWorkspace(next)` — the one writer

```
next === workspace            → re-apply (panels, bar, HUD), return
leaving FLY                   → apAbort, autoRunning = false, gameCommand = 0,
                                shipTimeRateCapY = Infinity, camera stays at the
                                hull's pose in free fly at zero ladder speed,
                                star time restored to its parked rate
entering FLY                  → §7.3 handover
entering COMMAND from FLY     → the leaving-FLY steps
leaving/entering anything else → camera untouched
always                        → system view closed if the target workspace cannot
                                hold it (fly without a dock), panelsHidden = false,
                                applyPanels(), syncModeBar(), syncControls(),
                                syncStarTime(), syncFlightUi(), syncTradeUi(),
                                input.releaseAll(), canvas.focus()
```

`lastWorkspace` is updated on every successful switch away from `fly`.

### 7.3 Handover into `fly`

Unchanged from `enterGameMode` (game-mode-plan §2), restated as the invariant:
a hull that has never been positioned adopts the camera's position **and
heading**; a hull already flown restores its own pose, velocity and tank; a first
entry out of a live follow seeds the followed object's drawn velocity; a docked
hull stays docked and its port rows re-enable.

## 8. Clocks

| | star axis | ship clock | trade clock |
|---|---|---|---|
| observe | **owns** (`Myr/s`, T) | parked | own ladder (`y/s`), sync allowed |
| fly | driven by the ship clock | **owns** (wheel, T) | own ladder, sync forced off |
| command | **owns** (`Myr/s`, T) | parked | **named clock**, sync allowed and shown |

- The trade sync law is unchanged in substance: `tradeSyncOn` is refused while
  flying (`mode !== FLY` where it used to read `!gameMode`). Observe and command
  both allow it; command is where it is *displayed* as the clock that matters.
- A workspace switch never changes a clock's value. Leaving `fly` restores the
  star rate that was parked on entry; entering `fly` re-parks it. The trade clock
  is never touched by a switch.
- The wheel owner is stated in the mode bar, because a wheel that means three
  different things is exactly the confusion this plan exists to remove.

## 9. `fly` — the fleet, and piloting a hull that is already in a route

The fleet today is player-owned hulls spawned at the camera. The user's request
adds: *any existing ship in a route is selectable and pilotable.* The network's
freighters are the existing ships in routes.

### 9.1 Why this is a conversion, not an attachment

A network hull is a statistical record: a chord between two live endpoints, two
queued events, a hold and a commodity. It has no tank, no acceleration, no life
support and — decisively — no physical speed. Its pace is authored in
**light-years per trade year**, and 1 ly/y *is* 1 c: the authored hulls fly at
2.0 c, 3.0 c and 4.5 c (`HULLS` in `src/core/trade.js`), while the fastest
pilotable class cruises at 0.10 c. The network's pace is bookkeeping — the trade
plan already declares abstract travel a limit — and a piloted hull must obey the
ship law. So taking the helm *converts* the hull once and the two speed languages
never meet again.

### 9.2 The freighter classes

The three hulls get their own table, `DeltaVLib.FREIGHTER_CLASSES`, beside the
pilot's `SHIP_CLASSES` — **not** rows appended to it. The pilot table is pinned by
position in more than one place (`route-test.js` asserts a five-element array of
full-tank hours by index, `dv-map-test.js` walks it for the `dv ≥ 2·v_c` rule,
`system-layer.js` builds the map's ship dropdown from it, `route.js` defaults to
`SHIP_CLASSES[0]`), so a sixth row is a catalogue change, not an addition.
`deltav.classById(id)` searches both tables and is what `Ship.createShip` uses; the
pilot catalogue, the map dropdown and the five-class comparison never see a
freighter.

| id | accel m/s² | Δv tank m/s | cruise | hold t | life y | maps from |
|---|---|---|---|---|---|---|
| `bulk` | 0.02 | 3.0e6 (0.010 c) | 0.010 c | 30 000 | 400 | `HULLS[0]` bulk freighter |
| `hauler` | 0.05 | 6.0e6 (0.020 c) | 0.020 c | 15 000 | 120 | `HULLS[1]` hauler |
| `clipper` | 0.15 | 20e6 (0.067 c) | 0.040 c | 8 000 | 40 | `HULLS[2]` clipper |

The rows are tuned so a requisitioned hull is a **hauler, never a racer**: every
one accelerates slower than `fusion` (0.3 m/s²) and cruises slower than
`stardrive` (0.10 c), while carrying 4–15× its hold. Taking a freighter is a real
choice with a real cost, not a free upgrade. Each row keeps the pilot table's
shape (`id, accel, dvMax, vCruise, domain, label, cargo, crew, lifeYears, color`)
so `setClass`, the HUD and the forecast read it unchanged; the hull's network
hold is copied into `cargo` so the hold the pilot sees is the hold the hull has.

### 9.3 The requisition law (`src/core/trade.js`)

New state `SHIP_CREWED = 4`, appended to `SHIP_STATE_NAMES`. New API:

```js
requisition(net, index, out)   // → { ok, reason, hull, cargoResource, amount, tons, x, y, z }
release(net, portIndex, hullIndex, tons, resource, time, out)
crewedCount(net)               // 0 or 1
freeFreighters(net)            // shipCount - crewedCount, for the panel
```

Invariants, each a test:

1. **At most one crewed hull per network.** A second requisition refuses with
   `a hull is already crewed`. One hull off the routes is a visible cost; a
   fleet of taxis would drain the network.
2. **Sailing hulls only.** `SHIP_SAILING` converts; `SHIP_DOCKED` refuses (`this
   hull is already in port — dock and take it over there`), `SHIP_WAITING`
   refuses (`this hull is idle at a port`), `SHIP_FOUNDING` refuses (`a founding
   voyage cannot be diverted`).
3. **The hull leaves the network's fleet.** The record stays inside
   `[0, shipCount)` with `state = SHIP_CREWED`, and every scheduling, counting and
   drawing loop skips that state — so nothing is compacted, no index is
   renumbered and no pending event can be mis-addressed. The network's effective
   fleet is exactly one smaller (`freeFreighters`), and it stays smaller until
   the hull is released.
4. **No event survives the conversion.** `requisition` bumps `ship.revision`
   (the queue's existing stale-event rule) *and* `handleEvent` returns early for
   `SHIP_CREWED`; the second guard is the invariant, the first is what the queue
   already guarantees.
5. **The seed pose is drawn space.** Position comes from
   `shipPosition(net, index, net.time, out)` — the same chord the overlay draws.
   Velocity comes from the hull's class cruise along that chord. The departure
   port's stellar drift is *not* added: the ship law measures velocity in the
   galactic frame, and the network's chord already moves with its endpoints, so
   adding a drift term would seed a hull with the sky's motion instead of its own.
6. **The hold is the network's cargo, capped by the class.** `tons =
   min(network amount in tons, class hold)`; `cargoResource` copies, and the
   class hold equals the network hold (§9.2), so the pilot's hold has the same
   size as the one it replaced. On release the physical hold is delivered to the
   port through the existing `distributePortInbound` and the record's `amount`
   is set from it — one transfer, no path that duplicates or evaporates a ton.
7. **Release re-uses the one record, so it needs no free slot.** The crewed
   record is already inside `[0, shipCount)`; `release` sets `state =
   SHIP_DOCKED`, `port = portIndex`, `from = portIndex`, `to = -1`, bumps the
   revision and schedules the load — the same commands `spawnShip` issues — so
   the hull is back in the network at the port where it docked and the fleet
   count returns to where it was. The pilot's physical ship record is dropped
   from the fleet.
8. **The last hull cannot be released.** A fleet of one keeps its ship: `fly`
   must not become an empty workspace. (Spawning a new hull remains available.)

### 9.4 The fleet list

`#ship-list` gains a second group, *Network hulls*, listing live freighters —
`hauler · ore 4 200 t · Rigel → Vega · 31 y` — plus **one crewed** row while a
hull is out. Rows are built at the trade panel's 4 Hz cadence, never per frame.
Clicking a network row requisitions it and enters (or stays in) `fly`; clicking a
crewed row returns to that hull (it is in the fleet like any other). Founding
voyages are not listed at all: they were never "in a route" the pilot could take.

### 9.5 Port surface

While flying a requisitioned hull the Port section shows the hull's origin
(`crewed from <port>`) and, when docked at a settled port, **Release to network**
beside Dock/Load/Unload/Found. Release is the inverse of requisition and the only
way a physical hull returns to statistical service; a pilot who never docks keeps
the hull and the network stays one freighter short — a legible consequence, not a
bug.

## 10. `command` — the network as the subject

- **Authority.** The Trade panel's existing controls become *this workspace's*:
  network clock, sync, generation ships, expansion arm, Send expedition, the
  per-row sends, Commission/Remove route. In `observe` they are hidden with the
  panel; the network still runs and still draws.
- **Founding has two entrances, one law.** Today founding requires `fly` and a
  dock (Port → Found colony). `command` adds **Found** on the colonisation row:
  the currently selected star, through `tradeLib.playerFound` with the same
  refusals (`no world worth settling`, `already a colony here`, `an expedition is
  already bound for it`, `network is full`). Neither entrance may charge, create a
  second port, or bypass the caps — a test pins that the same input through both
  entrances yields the same result record. The docked path keeps its sibling-world
  variant (`playerFoundWorld` via `V`); the command entrance is the inter-star
  port only.
- **Visiting.** A port row click, or a colony mark in the overlay, selects the
  colony's star and **flies the camera** to its orbit (`flyToPrimary`'s observer
  flight — the ship never moves because there is no ship). `H` stays home colony.
  This is the mode's one navigation verb.
- **Readout.** `#sysread` keeps the system/trade text; the HUD's command block
  leads with the network (`ports · outposts · hulls · frontier · lag`) so the
  commander sees the thing they govern first.
- **No piloting.** `fly` is one key away and the mode bar says so; inside command
  the Flight panel does not exist.

## 11. Display: HUD, overlay, chrome

1. **`#overlay` becomes per-workspace blocks.** First line always `mode <name>`;
   then the workspace's block: `observe` = camera + selection + galaxy (today's
   text minus the ship block), `fly` = today's `gameModeLine` unchanged,
   `command` = the network line (above) + camera + selection. `cameraLine`
   returns only when not flying (unchanged rule).
2. **Trade overlay detail.** `LabelLayer.setTradeOverlay(net, time, show, routes,
   detail)`: `detail = 2` full (rings, growth colour, new-colony mark, route
   lines, names), `1` ports and hulls only (no route lines, no names), `0` off.
   Observe and command draw 2; fly draws 1 — a pilot sees traffic, not
   bookkeeping. Crewed hulls are never drawn by the network layer; the pilot's own
   ship chrome is the marker.
3. **Ship chrome** (`labels.setShipChrome`) is on only in `fly` — it already reads
   `shipChrome.active`, which becomes `isFlying()`.
4. **No new per-frame work.** The mode name, the clock owner and the counters are
   read at the overlay's 4 Hz tick, exactly like every other HUD line.

## 12. Presets, boot params, persistence

- New preset field `mode`, serialized after `ship`, values by name (`observe`,
  `fly`, `command` — the language already uses names for `type`, `engine`,
  `viewmode`), default `observe`. Boot param `mode=`; `readParams` maps it through
  `Workspace.modeFromName` and falls back to `observe` for anything unknown.
- Applying a preset switches workspace **after** the settings land — one
  `setWorkspace` call, so a pasted `mode=fly` cannot interleave with a field
  re-draw.
- Panel overrides and `Tab`'s hidden flag are **not** preset state (transient,
  like the search results). Overrides persist locally per workspace; the hidden
  flag does not persist at all.
- A preset that names a mode the page cannot enter (none today: all three exist;
  `fly` with no hull spawns the default hull at the camera, as `g` already does)
  would be reported in the preset status line and fall back, never silently.

## 13. Refusals and notices

One sentence each, through the existing `setAutoMsg`/notice pattern, never a
silent no-op:

| trigger | notice |
|---|---|
| requisition a second hull | `a hull is already crewed · release it at a port first` |
| requisition a docked hull | `this hull is already in port · dock and take it over there` |
| requisition a founding voyage | `a founding voyage cannot be diverted` |
| release the only hull | `the fleet would be empty · spawn another ship first` |
| release at an outpost | `an outpost ships nothing` (existing wording) |
| Found in command with no selection | `select a star to found on` |
| Found in command, legal but refused by the law | the law's own reason, verbatim (existing) |
| `3` with no network | the panel says `no trade network yet`; the mode still enters (the network seeds with the galaxy) |

## 14. Files and wiring

| file | change |
|---|---|
| `src/core/workspace.js` | **new** — §3. No dependencies; loads immediately before `core/presets.js` (its only reader besides main.js) so `menuDefaults()` can resolve the default mode. |
| `src/index.html` | `#mode-bar` markup; `#routemenu` split out of `#sysmenu` (left column, after it); `data-mode="…"` replaces `data-observer`/`data-game`; the three hint blocks; the new script tag in dependency order. |
| `src/style.css` | `#mode-bar`; `.panel-column` contents per `body.ws-*`; `[hidden]` for panels; retire the inline-display writers' styling assumptions. |
| `src/main.js` | `workspace`/`lastWorkspace`/`overrides`/`panelsHidden` state; `setWorkspace`; `applyPanels`/`syncModeBar`/`syncControls`; `syncOverlayInset` sums visible panels; per-workspace HUD blocks; requisition/release glue; command authority glue; `gameMode` → `isFlying()` everywhere. |
| `src/core/trade.js` | `SHIP_CREWED`, `requisition`, `release`, `crewedCount`, `freeFreighters`; skip crewed hulls in the tick's spawn pass, the panel counters, `shipPosition`'s callers and the draw state; explicit guard in `handleEvent`. |
| `src/core/deltav.js` | `FREIGHTER_CLASSES` (three rows) and `classById`; `SHIP_CLASSES` untouched. |
| `src/core/ship.js` | `createShip` resolves through `classById`; `adoptHull(ship, classId, cargoTons, resource)` swaps the class on the existing record (position and heading come from the caller), re-arms the tank and sets the hold. |
| `src/render/label-layer.js` | `setTradeOverlay(..., detail)`; skip `SHIP_CREWED`. |
| `src/core/presets.js` | the `mode` field + default. |
| `README.md` | Controls table gains a `command` column; a *Workspaces* section; `g` re-described as the helm toggle. |
| `AGENTS.md` | the Files list gains `workspace-plan.md` and `src/core/workspace.js`. |
| `plan.md` §19 | the pointer to this file (and its status as it ships). |
| `archive/ui.x-worklog.md` | `ui.20` — the series entry, in the worklog's own format. |

`experiments/m1-smoke-test.js` fails unless the new source file is in
`index.html` **and** in its export table (`['../src/core/workspace.js',
'Workspace']`); `scripts/run.py` needs the new test in `EXPERIMENTS` and in
`world-tests`. `experiments/panel-test.js` pins the left column's order
(`selection-menu` then `sysmenu`) and must learn `routemenu`.

## 15. Tests

| test | what it pins |
|---|---|
| `experiments/workspace-test.js` (**new**, `world-tests`) | every panel appears in ≥1 workspace and `CONTROLS` in all three; each workspace's mask is non-empty; `modeFromName` round-trips and returns `-1` for junk; `panelsFor` equals the §5 table; override add/remove/sanitise (`0xff` never invents a panel) and the frozen-empty case; `visibleMask` precedence (override beats mode set; auto-show only adds); `toggleFly` returns `lastWorkspace`; the preset `mode` round-trip and unknown-name fallback. |
| `experiments/m1-smoke-test.js` | `workspace.js` loaded exactly once; `#mode-bar` present; no `data-observer`/`data-game` left in markup; the three hint blocks; `applyPanels` writes `hidden` (DOM stub) and `Tab` restores the mode set. |
| `experiments/input-test.js` | `Digit1..3` fire the three actions, are ignored inside form fields and panel inputs, and collide with nothing else in `pressMap`/`casedPressMap`; `g` fires `modeFly` and no `gameMode` action survives. |
| `experiments/panel-test.js` | column order with `routemenu`; the three columns still exist; `.panel[hidden]` is the only writer. |
| `experiments/trade-test.js` | the eight requisition/release invariants of §9.3 as black-box checks; a crewed hull processes no events over a 5 000-year drain (same full-state jump equivalence the file already runs); `freeFreighters` accounting; release delivers exactly what was aboard; the two founding entrances yield identical result records for identical input. |
| `experiments/ship-test.js` | the three freighter rows' authored numbers; `FREIGHTER_CLASSES` is disjoint from `SHIP_CLASSES` and `classById` reaches both; `adoptHull` re-arms the tank, sets the hold, and a full tank never exceeds the class cruise. |
| `experiments/route-test.js`, `experiments/dv-map-test.js` | unchanged and green: the pilot catalogue is still exactly five rows, and the map's dropdown and `dv ≥ 2·v_c` rule never see a freighter. |
| `experiments/preset-test.js` | `mode` serializes in §12's position, defaults to `observe`, and a paste of `mode=command` survives a round-trip. |
| `experiments/system-layer-test.js` | unchanged: the schematic's ship-class dropdown and colours still come from `SHIP_CLASSES`, so a crewed freighter never becomes a map option. |

Run what the change can break: `python3 scripts/run.py world-tests` for the
state/law work, `view-tests` for the panel/HUD work, `changed` before finishing.

## 16. Milestones

| id | scope | acceptance |
|---|---|---|
| **W0** | `workspace.js` + its test; no page change | table, names, override and toggle semantics pinned; `m1-smoke` green with the new file wired but unused |
| **W1** | `workspace` state in main.js, `isFlying()`, mode bar, `1/2/3`, `g`, preset `mode`; **all panels still visible** | behaviour identical to today except the bar; no `gameMode` left in main.js (rename only); `input`/`preset`/`m1-smoke` green |
| **W2** | `#routemenu` split, `MODE_PANELS` applied, panel overrides + menu, `Tab` semantics, insets from the visible set | each workspace shows its §5 set on entry; every panel reachable in ≤ 1 Tab + 1 menu click; `panel-test` and the inset functions follow |
| **W3** | Controls panel mode-scoping (`data-mode`, hidden-not-greyed, three hints), per-workspace HUD blocks, trade overlay detail, ship chrome gating | a workspace's Controls panel contains no control of another workspace; HUD shows one subject block; fly's overlay draws no route lines |
| **W4** | command authority: founding entrance, route/expedition ownership, visit navigation, clock naming/sync display | the two founding entrances agree; Trade panel rows are inert outside command; a `command` visit moves the camera and never a ship |
| **W5** | `FREIGHTER_CLASSES`, requisition/release, Network hulls group, port surface | a sailing hull can be taken and returned; the network is one hull short meanwhile and whole again after release; all §9.3 invariants tested |
| **W6** | docs (README, AGENTS, plan §19, worklog), browser pass, `changed` | README documents three workspaces and the helm toggle; the workspace pass has its entry in `deferred-browser-visual-plan.md`; `changed` reports nothing unmapped |

W1 is the load-bearing milestone: it converts the boolean without moving a pixel.
Everything after it is a table edit plus the two new laws (W4, W5).

## 17. Risks

1. **The ~90 `gameMode` sites.** Mitigated by W1 being a rename-only milestone
   with `isFlying()` as the single predicate; a site that needs "the trade sync
   is off" must not borrow the camera test, and `command` gives it a name.
2. **Two clocks meeting in the hold.** Requisition is the only place a trade hull
   becomes a physical ship. §9.3's invariants (no event, one crewed hull, hold
   capped) are the fences; the freighter rows keep the two speed languages apart
   by construction.
3. **Panel churn breaking the layout tests.** `panel-test` pins column order and
   two CSS blocks; the split moves `#sysmenu`'s map rows into a new panel, so the
   column assertion is rewritten in W2, not patched around.
4. **A hidden panel that was needed.** The auto-show rule (§5.3) covers the one
   real case (the docked schematic); the panels menu covers the rest. If a second
   auto-show appears, it belongs in the same rule, not in an `if`.
5. **Mode as an extra thing to learn.** Three chips with digits, one `g` and a
   Controls panel that reprints itself per workspace is the whole teaching
   surface; the bar names the owning clock so the wheel never surprises.

## 18. Open questions

1. **Should `command` founding stay free?** Every existing entrance is free
   (trade-2 deliberately has no credits). Recommend: free, same law, two
   entrances — a cost here would be the first currency in the project and belongs
   to a plan that owns money.
2. **Is a separate freighter table too much catalogue?** Alternative: map the
   three hulls onto `fusion`/`stardrive` (simpler, but a bulk freighter then
   becomes a 20 000 t stardrive, and "take the freighter" loses its point).
   Recommend the three rows in `FREIGHTER_CLASSES`.
3. **One crewed hull or many?** Recommend one: the network is the commander's
   subject, and a taxi rank would let a pilot strip it.
4. **Does `observe` keep the View modes panel?** It is a look tool and observe is
   the look workspace; the alternative is folding it into Display. Recommend
   keeping it and revisiting if the observe column feels full.
5. **Should `Tab` remember per workspace?** Today it is global and transient.
   Recommend global and transient, as specified — a hidden-panels state that
   survives a mode switch would look like a bug.

## 19. Non-goals

- No new render path, WGSL or star-buffer change. Every workspace draws the same
  frame; only chrome and authority differ.
- No second time axis. The ship clock and the star clock stay one axis under two
  names (game-mode-plan §4); the trade clock stays wall-time.
- No piloting of the system view's itinerary ship (`route.js` legs are closed-form
  plans, not hulls).
- No persistence of camera, ship fleet or panel overrides inside a preset.
- No change to the game law: burns, tank, life support, docking, approach,
  terminal rule and the trade economy's numbers are untouched by this plan.
- No money, credits, scoring or game rules: this plan separates the jobs; it does
  not add a score to them.
