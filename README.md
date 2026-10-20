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
- A live epoch clock: the galaxy ages with star time (one 0.1 Gyr step per 100 Myr of star time,
  rebuilt at the field's own sampling cadence), with the epoch readout beside the Myr/s control
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
- A colony economy over the same selection: founding at a docked port
  derives a stable resource map from the star's system, the population
  grows on met needs (famine below 40 % comfort), factories advance on
  arrive/inspect events — never per frame — and the hold trades the
  port markets' best exports across the ease differential
  ([colony-economy-plan.md](colony-economy-plan.md)). Commissioned convoy
  routes then run themselves on the economy clock — fast freight at
  0.2 ly/y, or generation ships at 1 ly per 10 ky synced to star time —
  narrated by an events ledger (milestones, famine, departures, arrivals).
  The expansion scenario grows the network on its own: Home seeds at the
  home star, founder expeditions claim neighbours and wire the routes,
  and the whole net draws on the sky (§9)
- Close-system schematic view: `V` opens a log-polar map of the primary selection — HZ
  annulus, orbit ellipses, stippled belts, star and planet icons — with its own
  system-time clock and a full-figures readout
- Copyable settings presets and deterministic URL parameters
- CPU mirrors and model/parity tests for the JavaScript and WGSL implementations

This is a visual galaxy model, not an N-body gravity simulation. The analytical density field is the source of truth; the movement engines aim to preserve its visible structures over time.



## Controls

| Input | Fly camera | Orbit camera | Game mode (`g`) |
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
| L / Shift+L | — | — | buy the port's best export into the hold / sell the whole hold, at a docked colony port |
| H | Centre on the star with the first colony (Home) and follow it, **and select the home reference** — seeds Home first if no colony exists | same (selection only) | makes Home the target — ships do not teleport |

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
- `G`/`g` — game mode: fly the same pipeline as a spaceship (see
  [Game mode](#game-mode-g) below; galaxy type changes live on the panel dropdown)
- `P` — toggle constellation lines
- `T` — pause/resume star time (also works after clicking a result button)
- **sim clock** / **arcade clock** (Controls panel, game mode) — the two ship-clock
  presets: real time (`R = 1` ship-s per wall-s) and the default rung plus the
  autopilot coast warp (see [Game mode](#game-mode-g) below)
- the star-time slider's track toggle (the mini button right of the value) —
  swap between the fine 0–2 Myr/s track (0.01 steps, where generation-ship
  time lives; 0.1 Myr/s is 5 % of the track) and the full −1–99 Myr/s
  (0.5 steps, follow at the left end); the readout carries three decimals
  under 1 Myr/s, and the observer default is 1 Myr/s
- the **Colonies & routes** panel (right column, stacked with Display and
  Controls in one viewport-capped column) — the economy's own
  workspace: **Seed home colony** founds Home at the star nearest the
  home H location (automatic at boot; once a colony exists the button
  centres on the first colony, like H), **Expansion** — on by default —
  arms the scenario (each colony sponsors founder expeditions to the
  nearest unclaimed stars; arrival founds a colony, commissions the route
  home and cross-links a neighbour, so the net of routes expands on its
  own — visible on the sky as dashed lanes, green colony rings, the
  amber Home ring and in-flight ship dots under either transit law), the colony list (click
  selects the star), the route list (click selects the origin, ✕
  cancels), a commission row for any two colonies without docking, and
  the economy events log ([colony-economy-plan.md §9](colony-economy-plan.md))
- the **Generation ships** checkbox (Colonies & routes panel) — on by
  default: sync the economy with star time, so the scenario runs in
  observer mode too: the convoys fly at 1 ly per 10 ky with
  star time at 0.1 Myr/s (in game mode: the shared clock's 1e5 y/s rung),
  homing on the moving destination; off — fast freight at 0.2 ly/y with the
  drift over the transit ignored, the economy on the game clock only
- the **Evolve with star time** checkbox — the galaxy's age runs with star time from 0.2 Gyr to
  present day; the Age slider is the seek, and the epoch readout next to it shows the field's epoch.
  The bar and arms keep their orientation across steps; each step re-draws the field, so lower
  **Stars** (30k–500k, applied on release) for a smaller hitch per step
- `V` — open/close the close-system schematic of the selected star
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
  The Flight panel's **Port** rows carry the dock button, the **Found
  colony** button and the cargo hook: **Found colony** settles a colony at
  the docked port's star ([colony-economy-plan.md](colony-economy-plan.md)),
  a deterministic resource map of what that system can produce (the star's
  metal and light, its planets, a small stable-hash jitter) driving a
  population that grows while its needs are met and starves below 40 %
  comfort. The colony's factories advance on events, never per frame:
  docking at its port (arrive) or opening its system view (inspect)
  advances it to the shared ship clock. `L` then buys the port's best
  export into the hold at the port's price (whole tons, within the free
  hold and the hull's credits) and `Shift+L` sells the whole hold there —
  one price both ways, so the margin is the ease differential between
  systems. A port without a colony has no market. **Commission route**
  stands a convoy between the port's colony and a second colony (the
  locked destination's star, or the primary selection's, when it owns
  one): every 2 y of economy time a departure carries up to 50 t of the
  origin's best export — never below its own two-year need — and lands
  it at the destination. The **Generation ships** checkbox (in the
  Colonies & routes panel since ui.18) sets the
  transit law: on, the convoys fly at 1 ly per 10 ky with star time at
  0.1 Myr/s and the economy clock synced to the star clock (colonies age
  while the stars drift; the ships home on the moving destination, the
  ETA a first-order intercept — a star that outruns the ship is reported
  as a chase); off, fast freight at 0.2 ly/y with the drift over the
  transit ignored and the economy on the game clock only. The events
  readout under the market narrates it all on the economy clock's
  timeline.
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
The trade-price/economy milestone the 0.5 plan omitted shipped with the colony
economy (ui.16, [colony-economy-plan.md](colony-economy-plan.md)).

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
| `evolve` | `1` runs the epoch with star time (from `0.2` Gyr, holding at present day); `0` freezes it |
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

The colony economy's stages 1–3 shipped (ui.16 — maps, colonies, markets,
trade; ui.17 — the event ledger, commissioned routes with the two transit
laws, the star-time sync and the events GUI; ui.18 — the expansion
scenario with the Home seed, founder expeditions, the origin-frame convoys,
the drawn trade net and the Colonies & routes panel). The §7 list (mixed
holds, tourism, colonist flows) stays recorded, not promised.

[Movement CPU/WGSL parity](movement-parity-plan.md) takes priority over visual tuning.
The outstanding real-browser engine/preset checks and non-critical bar polish are
tracked in a [separate deferred plan](deferred-browser-visual-plan.md). Passing the
Node suite does not certify browser rendering or clipboard/file permissions.

## License

[MIT](LICENSE)
