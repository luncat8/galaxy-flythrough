# Galaxy Fly-Through

## short readme for human read

- fly through stars in galaxy
- realistic stars distribution generator. once done in static star position mode, now need to think what changed after implemented star movement
- good looking galaxy. almost solved. best view: stability engine check simple or classic and select Sb galaxy type.
- webGPU vanilla js


### galaxy shape stability

- classic engine currently looks most balanced

- simple friction force field - adjustable and responsive galaxy shape. fast, easy to understand. Good for games.

- apocenter movement engine - seems works but noisy. 


###

this repo https://github.com/luncat8/galaxy-flythrough.git

## LLM generated readme:

A deterministic, real-time galaxy renderer and fly-through built with vanilla JavaScript and WebGPU. It generates the visible galaxy from an analytical density field, adds a small catalog of real stars and landmarks, and moves stars with selectable kinematic stability models.

No framework, bundler, module loader, or runtime network connection is required. The browser build uses classic scripts and can run from `file://`.

## Current capabilities

- WebGPU rendering with linear HDR accumulation and filmic tone mapping
- Up to hundreds of thousands of procedural stars from a stable seed
- Milky Way preset plus the Hubble type sequence: elliptical, lenticular, spiral, barred spiral, and irregular galaxies
- Thin/thick discs, spiral arms, smooth spheroids, stellar halos, and a boxy/peanut 3D bar
- Age-dependent stellar populations, luminosity, colour, giant branches, and white dwarfs
- Epoch-dependent structure: the bulge/bar assembles, the arms follow the gas that is left and the
  disc heats with the age of its stars — exactly the type table's present-day galaxy at the
  reference epoch, and a younger, thinner, more gas-rich one before it
- A live epoch clock: the galaxy ages with star time, and its global procedural census now forms
  from deterministic birth times; stars fade in, age by elapsed time, and the reference-model arm
  population keeps its spatial correlation. Epoch steps do not re-roll the field.
- **Formation from gas**: the clock starts at the galaxy's first light (`Age` 0). At `T = 0` the
  procedural census is all gas and nothing has formed; as the epoch runs, the stars born so far
  appear through a 0.05 Gyr fade. The gas the arms are drawn with is read back from that same drawn
  census (a 1024-bin birth histogram), not from the smooth star-formation prior, so a young frame's
  arm contrast is the picture of the stars that are actually there. The gas is also **drawn**: a
  64 × 96 × 4 cell grid (`src/math/gas-grid.js`) stepped on the GPU by an exact exponential of the
  epoch delta, calibrated once per draw so its total is 1 at first light and the type's own
  present-day fraction at the reference epoch, and drawn additively as cold haze under the
  stars, one tent-shaped quad per cell so the quads reconstruct the grid instead of
  leaving a dot at each cell centre. Its mass against that account is printed as `gas Δ` in the Formation checks line and in
  the stats overlay. HII nebulae take their brightness from the **local cell's formation rate**,
  with a time-based response that gives the same rate after a jump, rewind or running clock.
  Their seats and members are carried, not re-rolled; planetary nebulae and supernova remnants
  keep their stellar-origin light rather than being switched off by an empty cold-gas cell.
- Three selectable movement models:
  - **classic** — closed-form bounded kinematic orbits; currently the most balanced default
  - **simple** — responsive friction-field integration
  - **apocenter** — experimental feature-guided elliptical orbits
- Fly, galactic-centre orbit, and selected-object orbit cameras
- Named-star selection, labels, and constellation lines
- Star selection and multi-select: click any drawn star (procedural, object, catalog or
  landmark), Shift+click to build a set of up to 256, select-around by a world-space radius,
  fly to one (`Shift+F` — a 2 s eased flight that ends orbiting the star at its luminosity
  stand-off, cancelled by any control input; a moving landmark stays centred), orbit it on
  the spot (`c`), chase it from behind aligned with its motion (`j` — the star stays
  dead-centre while the galaxy streams past where it is heading; a glance swings back),
  cycle the
  set (`N`), clear it (`X`) — each member snapshotted with its
  stellar properties, so the set survives the streaming rebuild
- Deterministic per-star planetary systems: planets, belts, moons, insolation and
  temperatures, HZ/terran/locked flags, generated lazily on the CPU for the selected star
- Star and planet search with a compact token filter (`G,K|terran|220-300`), scoped to the
  selection or the galaxy. Search pauses star time and runs once against the positions drawn
  at that instant; results report the snapshot time, and `T` resumes the clock when you're ready.
- A separate **Search & Selection** panel: star current/previous history with swap, a
  default 10 pc search centred on the current star (camera fallback), clickable results,
  and a **Fly to primary** action (`Shift+F`) for the selected result.
  The typed asset history accepts ship/base/colony/dock-port/cargo-container references and
  can capture its current entry in either slot of the two-entry asset pair.
- Close-system schematic view: `V` opens a log-polar map of the primary selection — HZ
  annulus, orbit ellipses, stippled belts, star and planet icons — with its own
  system-time clock and a full-figures readout
- Copyable settings presets and deterministic URL parameters
- CPU mirrors and model/parity tests for the JavaScript and WGSL implementations

This is a visual galaxy model, not an N-body gravity simulation. The analytical density field is the source of truth; the movement engines aim to preserve its visible structures over time.



## Workspaces (1 / 2 / 3, g)

The page has three named workspaces ([workspace-plan.md](workspace-plan.md),
ui.20) — one state, three jobs, each with its own panel set, HUD block and
Controls deck:

- **observe** (`1`) — the sky: free camera, star time, selection, the map and
  the look. Panels: Search & selection, System & routes, View modes, Display,
  Controls, Formation checks.
- **fly** (`2`) — a ship: the camera is the active hull, the ship clock owns
  the time axis, the trade overlay thins to ports and hulls. Panels: Flight,
  Controls.
- **command** (`3`) — the colony network: expeditions, standing routes,
  expansion arming and founding live here (elsewhere they are read-only), and
  a port-row click flies the camera over. Panels: Search & selection,
  System & routes, Trade, Controls.

`g` is the **helm toggle**: it enters `fly` from anywhere and returns to the
workspace it was entered from. The mode bar (top left) shows the three chips,
the owner of the current clock, and a **panels** menu whose checkboxes
override the workspace's panel set (per workspace, persisted; *freeze* pins
the override as the whole truth). `Tab` still hides everything at once. The
boot/preset parameter `mode=observe|fly|command` opens the page in a
workspace.

While commanding, a sailing network freighter can be **requisitioned** from
the Flight panel's *Network hulls* list: the hull becomes the pilot's
physical ship at its drawn chord position, cargo and all (one crewed hull at
a time; the network stays one freighter short meanwhile). Docking at a
settled port offers **Release to network** — the hold is delivered and the
hull re-enters statistical service. `command` also gets a second founding
entrance, **Found at selected**, through the same free law as the docked
Port entrance.

## Controls

| Input | Fly camera | Orbit camera | Fly workspace (`g`/`2`) |
|---|---|---|---|
| Mouse | Click to lock, then look | Press and drag the canvas | Aim (the thrust runs on the ship's axes) |
| Click without dragging | Select a star (Shift adds to the set) | Select a star (Shift adds to the set) | same — Flight can lock it as the destination; otherwise the HUD uses the primary |
| Shift+F / N / Shift+N / X | Fly to the primary · next star · previous star · clear the set | same | Shift+F runs the fastest approach to the locked destination (or primary) · next/prev/clear same |
| W / S | Forward / backward | Closer / farther | Manual forward / backward override; the Flight thrust lever is persistent |
| A / D | Strafe | Circle target | Thrust right / left |
| E / Q | Up / down | Over / under target | Thrust up / down |
| Mouse wheel | Speed ×2 per notch | Distance ×2 per notch | Ship clock rung ×1-2-5 |
| Shift / Ctrl | Rate ×100 / ×0.1 | Rate ×4 / ×0.25 | Burn ×4 reserve / ×0.25 finesse |
| Space | — | — | All-stop: burn counter-vector to rest (can run dry) |
| f / c / Shift+C | Free fly · orbit the selected star (follows it) · orbit the galactic centre **and select it as the speed reference** | same (orbit only) | `f` aborts the autopilot · `c` gated — the ship is the fly rig · Shift+C selects the reference only (no re-pose) |
| j | Chase the centred star from behind: the view aligns with its movement vector and swings back after a glance | — | the ship trails the selected star at its stand-off; press again to abort |
| O | — | — | dock at / undock from the target station (inside its shell, settled) |
| L / Shift+L | — | — | load / unload actual colony stocks at a docked trade port |
| H | Return home **and select the home reference** | same (travel only) | selects the home reference only — ships do not teleport |

**Speed reference** (game mode) — the object the axis velocities, the HUD target
line and the autopilot answer against: the locked Flight destination, else the
primary selection, by default. The **target ref / centre ref / home ref** buttons
in the Controls panel select it directly; `Shift+C` selects the galactic centre
and `H` the home (the Sun in the Milky Way) as a side effect. Centre and home are
frame-fixed points: their relative velocities are zero, so the axes read absolute.
| R | Reset the simulation and view | Same | reset active hull to camera home (full tank, zero velocity); parked hulls stay put |

Other controls:

- **Controls panel** (bottom right) — the shortcut keys as clickable buttons and
  checkboxes, each tooltip carrying the detail; `▾` collapses it to the header
- `Tab` — hide/show all panels; a panel's own `▾` (or a click on its title) collapses it to its header
- `1` / `2` / `3` — switch workspace (observe / fly / command); `G`/`g` — the helm
  toggle: enter the fly workspace as a spaceship, or return to the workspace it
  was entered from (see [Game mode](#game-mode-g) below)
- `P` — toggle constellation lines
- `T` — pause/resume star time (also works after clicking a result button)
- **sim clock** / **arcade clock** (Controls panel, fly workspace) — the two ship-clock
  presets: real time (`R = 1` ship-s per wall-s) and the default rung plus the
  autopilot coast warp (see [Game mode](#game-mode-g) below)
- the **Evolve with star time** checkbox — the galaxy's age runs with star time from 0.0 to
  13.5 Gyr, one 0.1 Gyr step per 100 Myr of star time; the Age slider is the seek, and the epoch
  readout next to it shows the built epoch. The field is drawn once and *placed* at each epoch
  (positions, look and the birth gate are re-solved, never re-sampled), so a step costs no re-draw
  and the bar and arms keep their orientation
- **Formation checks** (top right) — a scenario select plus **Run**, **Present day** and
  **− / + 0.1 Gyr** steps. Each row sets star time, Evolve, the epoch and the camera for one 0.7
  claim — first light, condensation, the full walk, gas-rich arms, bulge assembly — prints what to
  look at and what proves it, and reports the live account: formed %, view gas, arm contrast, bulge
  size and the field draws since the row started
- `V` — open/close the close-system schematic of the selected star; while docked in game mode, inspect the station without camera motion
- `B` — cycle the system view: schematic → delta-v map → delta-v rails
- `[` / `]` — exposure
- `;` / `'` — overall brightness
- `Esc` — close the system view; release the pointer in fly mode
- System panel `▾` — collapse its controls to the header without leaving the view (`V`, `Esc` or **Close** exit)
- selecting a star adds a one-line system brief under the `selected` line: star class, planet and belt
  counts, and the bodies in order with the gap between neighbours in AU, e.g. `☀️-0.39-🌋-0.33-🌍-1.3-🪐 AU`
- `Ctrl+V` over the scene (not in a text field) applies a preset from the clipboard without the browser's
  paste prompt; text that is not a preset is ignored rather than printed into the box

The settings panel opens at startup and exposes galaxy type, seed, age, the live epoch clock, star time, movement engine, pattern controls, tone mapping, and presets.

### Formation checks

The top-right **Formation checks** panel is the browser instrument for the formation
series: pick a scenario, press **Run**, and read the live line under it. The rows keep the
galaxy, the seed, the star budget and the look; they change only the clock and the camera.

| Scenario | Clock | What it is for |
|---|---|---|
| First light — T = 0 | frozen at 0.0 Gyr | the procedural field is gated off: formed 0 %, gas 1.00, a cold gas-only picture on SBb. Milky Way catalog stars and landmarks are not gated and still draw |
| Condensation — 0 → 1 Gyr | Evolve, 20 Myr/s | one 0.1 Gyr traversed every five seconds: stars arrive through the fade, and the field draws stay at 0 |
| Full walk — 0 → 13.5 Gyr | Evolve, 99 Myr/s | the whole history, still one draw: the bulge assembles in size and the arms lose contrast as the gas falls |
| Gas-rich arms — 1.0 Gyr | frozen | the young census is mostly gas, so the arms saturate; **Present day** is the same stars at the type's own fraction |
| Bulge assembly — 2.0 Gyr | frozen | the compact bulge keeps its central brightness while the bar is shorter |

**Present day** is the comparison frame at the reference epoch from the same camera — it is the
last entry in the select as well as a button — and the two step buttons move the epoch by its own
0.1 Gyr quantum with the clock held, the cheapest way to see the census grow without waiting. The
live line names the workspace the run landed in (Observe, which is also where this panel lives),
the built epoch in model quanta, the star rate, whether Evolve is on, and the four numbers:
the formed share from the drawn census, the view gas the arms used, the arm contrast and the
bulge size. A run that fell back to the smooth gas prior reads as `gas —` instead of a
plausible number, and a clock tick that re-sampled the field shows up in `draws`. If Type or Seed
changes under a running scenario the state line says *different galaxy*, because a comparison is
only a comparison at one field.

The **WebGPU checks** rig separates First light into a star-only frame (gas hidden,
zero lit stellar pixels) and a gas-only frame (gas visible, nonzero light). Its
stellar-exposure continuity sweep also hides the haze. A CPU fallback cannot
rasterize gas and explicitly defers that pixel check; passing headless tests is
not a visual verdict. `gas Δ` may be nonzero between the endpoints: it compares
the exponential grid with the census account, not two copies of the same curve.

**Copy line** hands back the whole settings line through the preset box, so a frame worth
reporting is one press from being recorded. A row that changes only the epoch is a *placement*:
every draw is reference-framed (0.7.3b), so the press re-solves the epoch and re-uploads a
uniform — no re-sample, no hitch, and the selection survives the comparison.

## Game mode (g)

Game mode ([game-mode-plan.md](game-mode-plan.md), G1–G5 + ui.10, ui.11 and ui.14) is
the same pipeline flown as a **spaceship**: the camera *is* the active hull,
its motion obeys the ship class instead of the observer's instant-response
rig, and a HUD answers how fast, how much fuel and how far to the speed
reference. `g` enters and leaves; each fleet hull keeps its own position,
velocity, heading, class, tank and clock. First entry adopts the camera pose —
position **and heading**; later entries restore the hull's saved state.
Clicking a ship in the Flight list switches to it and enters game mode if
needed.

- **Restrictions are the game.** WASD/arrows burn real Δv along the ship's axes
  (mouse aims); the ship accelerates, coasts on straight lines and runs out of
  fuel. Speed clamps at the class cruise fraction (`fusion` 0.02c,
  `stardrive` 0.1c, …); in-system classes (`chemical`, `nuclear`) cap at an
  escape-scale speed and never leave the local group. Fuel is charged for the
  **accepted velocity-vector impulse**: holding forward at the speed cap costs
  nothing, while steering and braking pay the real change in velocity. `Space`
  is a commanded brake that can run dry — the HUD reports the residual it could
  not kill.
- **One clock.** While flying, the ship's physics and the stars' drift advance
  at the same rate — the ship-time ladder on the star-time slider (`1-2-5`
  rungs from 1e-5 y/s to 1e6 y/s, plus the `sim` real-time stop below them,
  wheel-stepped, `T` freezes ship and sky
  together, a `follow` rung couples the pace to the ship's speed). One clock is
  what makes a selected star reachable: at the shared rate the ship's cruise
  outruns stellar drift by ~100×, so the star is met where it arrives. The
  observer's Myr/s star time is parked while piloting and restored on exit.
  Destination approach and target-stop autopilots cap the shared rate so travel
  takes at least four wall-clock seconds; `T`'s freeze remains an override.
  Two Controls-panel presets (game mode only) sit on that ladder: **sim clock**
  is real time — one ship-second per wall-second (`R = 1`), the honest rate at
  which interstellar travel is measured in years — and **arcade clock** snaps
  to the class's default rung and arms the **autopilot coast warp**, which
  raises the shared clock to the flight's four-second floor while a
  destination autopilot coasts, so the long unpowered leg plays out in seconds
  (burn and brake keep the pilot's rung). The HUD names the mode and an armed
  warp (`ship clock arcade +0.5 y/s · coast warp +2.5 y/s`).
- **The Flight workspace.** The lower-left **Flight** panel lists the session's
  ships and has **Spawn at camera** for a stationary hull. Clicking a row pilots
  that hull. The panel then keeps the normal task in one place: the two
  **mutually exclusive** forward-axis controls — the persistent **Thrust** lever
  (*thrust control*) and the **Desired speed** slider with *cut thrust*
  (*speed control*; forward thrust cuts at the desired speed, no hidden brake) —
  where touching one disables the other, select a destination, choose a plan
  and engage it. **Use selected** snapshots the clicked star, so
  inspecting another object cannot silently retarget a trip. The four plans are
  **fastest**, **use thrust as limit**, **use speed as limit**, and **use time
  limit**; the compact forecast shows predicted Δv cost (including the current
  velocity match), tank margin, ship time and wall time before it will engage.
  The System map and transport-route controls remain directly below it.
- **The hangar.** The Flight panel's **Ship** selector changes the active
  hull's class (0.5.4's classes: accel, Δv, cruise, life support); the swap
  re-arms that hull's tank and re-snaps its clock to the class's home rung.
  **Refuel** there (and **refuel ship** in Controls) is the hangar refill —
  free anywhere; the *station* refill lands with docking.
- **Docking and life support (G4).** Any star you fly to is a station:
  settled (≤ 1 m/s relative) inside its stand-off shell, `O` docks — the
  port re-arms the tank, restores life support, records the star as the
  hull's **port of registry** and lands a `dock-port` asset in the
  selection panel's asset history. Docked, the ship rides the station's
  drawn motion (life support pauses at the port); any thrust key, Space,
  `O`, a class swap, `R` or a hull switch leaves it. Life support counts
  down on ship time: the HUD warns inside the class's critical band
  (10 %, floored at 0.1 y), and when it runs out a **hard return-home
  marker** — an amber chrome frame on the port of registry plus a
  persistent HUD line — insists on the way back until the next dock.
  The Flight panel's **Port** rows carry the dock button and the cargo
  controls: `L` loads actual colony exports within the hold's capacity;
  `Shift+L` unloads up to available storage. No credits are involved; see
  [Colonies and trade](#colonies-and-trade).
- **The HUD** (the overlay, at its 4 Hz cadence) shows **accepted thrust** and
  burn reserve, speed in c (km/s below 0.01c) and the live acceleration, the Δv
  tank and life support, signed forward/sideways/vertical velocity components
  on the camera axes (relative to the speed reference — its name is printed
  above them), and the target line: drawn distance, closing rate, coast
  ETA in ship *and* wall time, and autopilot ETA. It does not present forward
  thrust discarded by the cruise clamp as a burn. Game mode adds the
  Port state, the cargo hold, the home-port heading while life support
  runs critical, and the persistent expired line. On first entry, a live follow
  (`c`, `j` or a completed Shift+F) seeds the new hull's physical velocity;
  spawned hulls remain stationary and previously flown hulls restore their own
  saved velocity.
- **The autopilot.** `Shift+F` remains the fastest burn to the locked Flight
  destination (or selected star when none is locked): a burn, a flip and a
  brake in the star's own frame, stopping on a luminosity-based stand-off
  (`f` aborts). **Engage plan** runs the locked destination with its forecast's
  thrust, speed or deadline limits. **Autopilot to target** is the precision
  checkbox: it closes on the live drawn position and matches the target's
  physical velocity, ending with zero target-relative speed. These destination
  flights check fuel first — `insufficient Δv: need X, have Y` — and refuse a
  hot approach instead of braking through the star. While either destination
  autopilot runs, the shared clock caps travel at a minimum of four wall seconds;
  the effective rate is shown and `T` still freezes. `j` trails the star at its
  stand-off with relative velocity nulled, so fuel burns only when the star
  curves. The HUD auto line shows phase, fraction flown, ETA in ship and wall
  time, and Δv spent against the checkout. The ship's nose follows the burn
  through the camera's own look, so a glance still wins. Thrust keys, Space, a
  class swap, target loss and `g` end a flight at the current velocity.
  While docked, thrust keys, Space and `O` undock instead, and no flight
  command engages from the port.
- **The chrome.** A crosshair at the nose, a burn marker where the commanded
  direction crosses the view, a velocity tape left of centre (over-cap speed
  bleeds above it), a target frame on the speed reference (the locked
  destination, selected star, galactic centre or home), an amber
  **return-home frame** on the port of registry while life support is
  expired, and an accepted-thrust/fuel strip in the class colour.

## Ships, routes and autopilot (0.5.5, reviewed in 0.5.6)

The lower-left **Flight** panel is the task workspace: flight setup comes first,
then the System map and route tools below it (`Tab` toggles all panels, the
**Controls** panel included); the galaxy settings stay on the right.

1. For an interstellar trip, select a star, click **Use selected**, choose a
   travel mode and review the Flight forecast before **Engage plan**. The map
   route below remains available for the economic / in-system leg.
2. Select a star and press **V**, then pick a render in the same panel's **View**
   dropdown: the system schematic, the classic delta-v map, or the delta-v rails
   map (one row per node kind, so the escape and L5 rails run level across the
   bodies). **B** cycles the three.
3. On a delta-v render, click a start node, then a destination node (surface,
   LO, GEO, escape or L5). Escape and L5 are both exits: a route starting or
   ending on either spends only the star-frame burns on that side.
4. Choose a ship and energy budget. **Round trip** adds a return after a
   0.25-year layover; fuel is not replenished. The report compares all five classes.
5. Set **System time** above zero and start autopilot. The clock is a geometric
   ladder (slowest timed stop 1e-4 y/s; 0 freezes). Around 0.1–1 y/s is a useful
   range for watching a transfer; high rates fast-forward and can finish short
   flights between rendered frames. The class-colour ship and dashed trajectory
   ride every leg on the schematic and both delta-v renders, local legs included.
   Start/resume pauses or resumes flight; changing the plan or exiting the view
   cancels it.
6. For a transport route between stars, select a first star and click a second star
   in the nearby search results, then open a system and use **Current + previous**.
   When the natural-object history contains two stars, the route runs previous →
   current; otherwise two Shift-clicked or search-added set members are the
   fallback. **Round trip** controls whether the route returns. The report covers
   parking-orbit escape, cruise and capture in real years; progress is not
   projected into a local orbital diagram.

Fuel, acceleration and life support decide feasibility; impossible plans cannot
launch. Routes are transient. Ship class, map toggle and budget survive presets.
Prices and credits remain omitted. Colonies, resources and autonomous freight are
implemented separately by the [trade plan](trade-plan.md).

## Colonies and trade

The Trade panel's clock runs independently of star and ship time: 100
years/wall-second by default; zero pauses. The page opens on the capital colony
beside home, with four colonies that found more as expeditions reach the nearby
sky. **Y** or **Draw trade routes** toggles port rings, active routes and
cargo-coloured freighters. Open a system with **V** to discover its sites and
inspect population, yields, needs, local flows and delta-v costs. Expeditions
found new colonies on the same event queue as freight arrivals.

While docked at an unsettled star, **Found colony** puts one there by the
player's own hand — free, with the usual outpost/reservation/habitat refusals.
To develop an existing port, stay docked and press **V**: this one game-mode
exception opens the station's schematic without moving the camera. Select a
planet or belt and use **Found colony** again to add a sibling world (up to six
per star), provided its habitat and surface-to-surface reachability pass.
Undocking closes the schematic; no second inter-star port is created.

Each star still has one inter-star market, folded from its worlds. Hulls load
seven shipping families; ore and volatiles stay in-system. Local bulk,
manufactured goods and passengers move as closed-form statistical flows,
weighted by the same surface/orbit/landing delta-v graph as the map. Cheap
edges feed neighbours, and a world's gravity well taxes what its port can lift.
The opened schematic marks each world and draws the three largest recent flows
as dim dashes; `#sysread` names their goods, direction, km/s, couple, Hohmann
time and per-world lift. These dashes are not extra ships or queue events.

The Trade panel lists the largest colonies, the youngest one, and every ready
expedition as clickable rows: a colony row selects its star (the ship never
moves), a frontier row carries its own **Send**. **Expansion armed** stands the
colonisation authority down while the freight fleet keeps flying. Each resource
in the selected colony's readout is tagged `+` surplus, `!` scarce or fair, and
one line reports the system's own supply — rocky worlds, giants, belts, terrans
and habitable-zone worlds — because that is what the world's yields are made
from. The **Forward** block shows the queue's next events and **Events** the
last eight things that happened, including failures: an abandoned colony becomes
an outpost, keeps its slot, and is never resettled.

Two ports can be linked with **Commission** under **Routes**: a hull loading at
the origin takes that destination first when it wants the good, and falls back to
the best voyage when it does not. A route is a preference, never a schedule —
nothing is queued for it, and cancelling one leaves every hull already at sea
alone.

At a docked trade colony **L** loads a spare resource into the tonnage-limited
hold; **Shift+L** unloads only as much as the warehouse can take. A station with
no colony cannot manufacture free cargo. The Port row reports the colony,
population, export and current hold resource. No money changes hands.

The economy is intentionally abstract: NPC travel uses authored trade speeds,
not the player's physical flight model. Factories settle on events/inspection,
never every frame; supply-limited growth is approximate and inspections can
change its subsequent history. See the trade plan for these limits.

## URL parameters

Settings can be supplied in the query string, for example:

```text
?type=SBb&seed=42&age=13.5&engine=classic&time=5&wave=0.6&pattern=1
```

Useful parameters include:

| Parameter | Meaning |
|---|---|
| `type` | Galaxy type, such as `E4`, `Sc`, `SBb`, or `Irr` |
| `seed` | Deterministic generation seed |
| `age` | Frozen galaxy age in Gyr |
| `evolve` | `1` runs the epoch with star time (from `0.0` Gyr — the galaxy's first light — holding at present day); `0` freezes it |
| `stars` | Procedural star budget (also the **Stars** slider; a pasted preset re-draws with it) |
| `catalog` | Catalog star budget; `0` selects procedural-only rendering |
| `engine` | `classic`, `simple`, `apocenter`, or a `+`-joined combination |
| `time` | Stellar time rate in Myr/s |
| `wave` | Pattern-frame capture strength |
| `pattern` | Pattern-speed multiplier |
| `exposure` | Faint-star magnitude threshold |
| `brightness`, `white`, `sat` | Display gain, white point, and saturation |
| `headroom`, `highlight` | HDR ceiling and highlight desaturation |
| `apoShare`, `apoForce` | Apocenter-engine population share and eccentricity force (apocenter alone leaves the unshared stars at birth: add `classic` for a moving baseline) |
| `sysview` | `1` opens the system schematic at load (a no-op without a selection) |
| `systime` | Schematic clock rate in years/s (`-1` follows the camera fly speed, `0` freezes) |
| `dvmap`, `dvbudget` | System render (`0` schematic, `1` delta-v classic, `2` delta-v rails) and energy budget (`0`–`1`) |
| `ship` | `chemical`, `nuclear`, `fusion`, `stardrive`, or `generation` |
| `trade`, `traderoutes` | Independent trade rate in years/s (`0` pauses) and route overlay (`0`/`1`) |
| `tradesync` | `1` runs the trade clock on star time (1 trade year per 1 000 star years) |
| `tradegen` | `1` generation-ship mode: 1 ly per 33 trade years, synced to 1 Myr/s |
| `tradeexpand` | `0` stands the colonisation authority down; freight and deliveries continue |

The Preset section in the UI serializes the complete active configuration in this same format.

## Development

Install the optional shader-interpreter dependency:

```bash
npm install
```

Run the tests that matter for what you changed — not the whole suite every time:

```bash
python3 scripts/run.py changed          # only tests that read a changed file (~0-25 s)
python3 scripts/run.py quick            # fast tier, 21 tests (~11 s)
python3 scripts/run.py camera input     # any named tests as one suite
python3 scripts/run.py all-tests        # everything (~4 min): before a merge, or after a model change
```

`quick` and `changed` skip the ten slow model/statistics gates (`movement-density` alone is
two minutes) unless `changed` finds that you touched what they measure, print only the
failing checks, and leave `experiments/logs/` alone (`--logs` writes them; `all-tests`
always does). `-j N` runs tests in parallel — timing budgets inside some tests can fail
under load, so the default is serial.

List individual experiments and tools:

```bash
python3 scripts/run.py list
```

Useful commands:

```bash
python3 scripts/run.py orbit          # movement and CPU-mirror invariants
python3 scripts/run.py shape          # 3D component shape and sampler parity
python3 scripts/run.py renderer       # render pipeline contracts
python3 scripts/run.py wgsl-validate  # WGSL structure and JS mirror checks
python3 scripts/run.py wgsl-exec      # execute shipping WGSL on the CPU
```

`wgsl-exec` is intentionally separate from `all-tests`; it depends on the development-only `wgsl_reflect` interpreter.

## Architecture

The runtime is organized as classic-script namespaces under `src/`:

- `math/galaxy.js` — immutable galaxy descriptors and the type table
- `math/density.js` — analytical stellar density components
- `math/sampling.js` — deterministic sampling from those components
- `math/star-types.js` — stellar populations and age evolution
- `math/orbit.js` — movement engines and CPU mirrors
- `render/shaders.js` — all WGSL shader source
- `render/star-sprites.js` — procedural generation, culling, HDR star passes, and tone mapping
- `stream/` — catalog bundle loading and cell residency
- `core/` — camera, input, loop, star-set selection, typed selection history, and presets
- `data/` — named landmarks, constellations, and the packed catalog

The CPU keeps world positions in `f64`. GPU rendering uses camera-relative `f32` coordinates. Procedural objects are derived from stable hashes rather than mutable random-number state, so a galaxy is reproducible from its type and seed.

See [`plan.md`](plan.md) for the complete design, the versioned plans for model details, and [`worklog.md`](worklog.md) for implementation history.

## Next priorities

[Movement CPU/WGSL parity](movement-parity-plan.md) takes priority over visual tuning.
The outstanding real-browser engine/preset checks and non-critical bar polish are
tracked in a [separate deferred plan](deferred-browser-visual-plan.md). Passing the
Node suite does not certify browser rendering or clipboard/file permissions.

## License

[MIT](LICENSE)
