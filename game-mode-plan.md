# Game Mode — Spaceship Flight, Restrictions and Display (G1–G5, ui.10, ui.11 and ui.14 shipped)

The viewer is an observer: a free fly camera, two orbit modes and a cinematic
fly-to. Game mode is the same pipeline flown as a **spaceship** — the camera is
the ship, its motion is restricted by the ship class, and a HUD answers the
three questions a pilot always has: **how fast, how much fuel, how far to the
selected object.** Toggle with `g`.

Status: **G1–G3 shipped (2026-10-16); ui.10 fleet/axis/target-stop shipped
(2026-10-17); G4 shipped (2026-10-19, ui.13); G5 shipped (2026-10-19,
ui.14)** — the browser visual pass is the one G5 item still deferred. G1 is
`src/core/ship.js`,
the flight law, the shared ship clock (§4), the text HUD, the input gating and
the hangar refill; G2 is the §6 canvas chrome and the §5 burn/flip approach with
the fuel checkout, the rest-frame commit and the `j` follow command; G3 is the
single Flight workspace, keyed destination planning, four configured profiles
and accepted-impulse accounting (§7); G5 is the SIM/ARCADE clock presets and
their ladder (§4). Two pieces G1 builds on existed before it: the
**chase follow** (`j`, ui.6 — the camera rides behind the centred object with
its forward eased onto the object's drawn movement vector, `camera.js`'s
`stepChase`), whose movement feed is the velocity handover §2 and the attitude
law §5 use, and the **Controls panel** (ui.6 — the clickable replacement of the
help `<pre>`, whose buttons fire the same one-shot action flags the keys set),
which the hangar rows and SIM/ARCADE presets plug into. The system view's
clock (0.5.5, `SYSTIME_LADDER`) is the precedent for §4's ladder: a geometric
y/s axis with a coupled rung and a frozen rung.

## 1. Principles

- **One pipeline, two rigs.** Game mode is a control-and-display layer over the
  existing renderer, selection store, search, system view and routes. The star
  buffer, the WGSL and the three render paths do not know it exists — the same
  law as hybrid/procedural mode.
- **Each fleet hull keeps its own state across toggles.** On first entry, the
  active hull adopts the camera pose; later entries restore that hull's parked
  position, velocity, tank, clock and class. Selecting another fleet row moves
  the camera to that hull and enters game mode when needed. Observer movement
  does not drag parked hulls along.
- **Restrictions are the game.** The fly camera's speed ladder, instantaneous
  stops and free zoom are observer tools. The ship accelerates, coasts and runs
  out of Δv. Everything the HUD shows is a consequence of the same three
  numbers: class acceleration, class Δv, class cruise fraction.
- **Drawn space rules travel, birth space rules records** (ui.2): distance,
  closing rate and ETAs are computed against the locked Flight destination's
  *drawn* position (or the primary selection when none is locked); identity
  stays keyed.
- **One clock while flying** (§4): the ship's physics and the stars' drawn
  motion advance on the same rate. This is what makes a selected star
  reachable, and it is why the handover seeds *physical* velocity (§2).
- **No new dependencies, CPU-only.** `ship.js` is a classic script exposing one
  `Ship` namespace to page and Node alike (AGENTS.md runtime rules). G1–G3 add
  no WebGPU code; the ship chrome rides the existing 2D canvases.

## 2. Ship state — `src/core/ship.js` (G1)

The Flight workspace owns a session-local fleet. Each row has a stable id/name
and its own record from `Ship.createShip(classId)`; the active `ship` reference
selects which record the game loop integrates. Every hot-path field mutates in
place, and parked records do not move or consume fuel.

- **Class**: a row of `deltav.js` `SHIP_CLASSES` (0.5.4) — `chemical`, `nuclear`,
  `fusion`, `stardrive`, `generation` — carrying `accel` (m/s²), `dvMax` (m/s),
  `vCruise` (fraction of c), `lifeYears`, `color`. The Flight panel's ship
  selector (`dv-ship`) is the hangar: one selector, one source of truth for
  the active hull, available before and during game mode. Swapping class re-arms
  that hull's tank to the new `dvMax` and clamps its velocity to the new cruise
  cap (the hangar swaps the hull under you; the pose continues).
- **Velocity**: each hull's own f64 vector in kpc per *ship*-second (physical
  seconds; §4 makes ship-seconds and star-seconds the same time), continued
  across observer excursions. In game mode, the camera pose is written through
  the active hull's position and velocity; in observer mode, parked hulls stay
  at their saved state.
- **Throttle**: held WASD/arrow thrust along ship-local forward/right/up
  (mouse aims, exactly the fly camera's look — the thrust basis is the
  camera's live `forward`/`right`/`up`). The blend is per-axis, not
  normalized: full forward + full strafe commands √2 of the class accel and
  the magnitude cap clips it to 1×, so the HUD bar — which reads the *applied*
  magnitude over the cap — is what the cap displays. Shift = ×4 reserve burn,
  Ctrl = ×1/4 docking finesse (both scale the ceiling and the drain together).
- **Tank**: `dvRemaining = dvMax − dvSpent`, with `dvSpent` charged from the
  **accepted** velocity-vector impulse after projection onto the cruise ball
  (SI m/s). Thus the invariant is `dvSpent == Σ|v_after − v_before|`, not the
  requested `|a|·dt` when the cap discards part of a command. Tank empty →
  thrusters zero, the ship keeps coasting. Two refills exist: the hangar
  refill (G1, free, anywhere, zeroes `dvSpent`) and the **station refill**
  (G4 — docking re-arms the tank *and* restores life support, §10).
- **Life support**: `lifeYears` of ship-time from the class, decremented by
  ship time (`lifeSpent += dt_ship`); G1 displays the remainder. G4 gives it
  teeth (§10): a critical warning inside the class's warn band, and — when
  it runs out — a hard return-home marker to the port of registry that
  stays until the ship docks again. While docked the port sustains the
  crew, so the countdown pauses.

### First-entry handover and fleet restore (G1, ui.10)

A hull with no saved position adopts the camera pose on its first game-mode
entry, preserving pose continuity. A previously piloted hull instead restores
its own saved position and velocity; changing hulls intentionally re-poses the
camera to the selected row. The live-follow velocity handover applies only to a
fresh, unentered hull:

- **First entry with a live follow** seeds `ship.velocity` with the followed
  object's **physical** velocity: the feed measures drawn kpc per *wall*
  second at the current star rate — time-lapse motion — so the seed is
  `Δdrawn / (physical seconds that frame)` (§4's clock conversion), never the
  raw wall delta. Under the shared clock the star keeps drifting at that same
  physical rate and the ship rides with it — continuous in the motion the user
  sees, not only in pose.
- **First entry with no follow** adopts the camera position and starts at rest.
  A free-fly observer has no physical velocity to hand over (the 8 ly/s ladder
  is time-lapse speed), only its heading is meaningful. Later entries restore
  the hull's own stored position, velocity and heading. Spawned hulls are
  stationary and do not inherit a live-follow velocity.
- **Heading is a ship state.** Every hull stores the camera's unit quaternion
  as its own heading: a hull spawned at the camera (or a first entry) adopts
  the camera's heading, a later entry or a hull switch re-poses the camera
  from the stored heading exactly as it does the position, the per-step
  write-back keeps it live while flying, and `R` restores the reset pose's
  heading. A heading change re-projects the velocity onto the new
  forward/sideways/vertical axes on the next readout (the velocity itself is
  world-fixed — the axes moved).
- **Leaving** stores the active hull's velocity, heading and tank; the
  observer rig takes over at the same pose. Parked hulls stay at their saved
  state.

## 3. Flight law and restrictions (G1)

The restrictions replace the observer's motion while game mode is on:

- **Acceleration cap**: `|a| ≤ class.accel × SHIP_ACCEL_WORLD × factor` with
  `SHIP_ACCEL_WORLD = 1/KPC_M` the m/s² → kpc/s² bridge, and `factor` the
  Shift ×4 / Ctrl ×¼ modifier. The cap is on the blended magnitude (above).
- **Cruise cap**: `v ≤ class.vCruise·c` for interstellar classes;
  `vCruise: 0` in-system classes cap at `IN_SYSTEM_CRUISE_C` (0.005 c —
  a generous escape-scale speed; their real ceiling is the tank) and cannot
  leave the local group of stars. The galaxy is 100 kpc — the ship clock (§4)
  is what makes the cruise cap playable, not a fake speed.
- **Coasting is free, turning is free**: Newtonian straight lines between
  burns; mouse aim is gyros, no Δv cost. A requested velocity is projected onto
  the cruise ball *before* fuel is billed, so a cap-clamped forward command is
  free while a projected turn or brake pays its actual vector change.
- **Full stop**: `Space` (one-shot) commands a counter-vector burn at full
  class accel until the ship is stopped, the tank runs dry, or a thrust key
  takes over. A stop that cannot finish leaves the residual velocity and the
  HUD says so (`stop incomplete · residual …`) — the brake can run dry.

### Input routing while game mode is on (G1, G2)

The ship *is* the fly rig, so the observer's mode keys have no meaning; they
are gated to a HUD notice (the `noSelectionTicks` pattern) rather than
silently dropped, and their Controls-panel buttons disable (`data-observer`,
repainted with the live state at the overlay's 4 Hz). Three of them are not
gated any more: `Shift+F`, `f` and `j` are the ship's own commands (G2), which
is why their controls carry no `data-observer` and their titles name both
dresses:

| Key / control | In game mode |
|---|---|
| WASD / arrows / E Q | thrust along ship-local axes; W/S temporarily override the Flight forward lever — a real key input aborts the autopilot |
| Shift / Ctrl | ×4 reserve burn / ×¼ docking finesse |
| Space | one-shot all-stop (above), and the autopilot aborts first |
| mouse | aim (pointer lock / drag, exactly the fly camera's look) |
| `Shift+F` | the §5 fastest burn/flip approach to the locked Flight destination, or the primary selection when no destination is locked |
| `f` | abort the autopilot at the current velocity; a notice when none is running |
| `j` | the §5 follow command — null the relative velocity and trail the target at its stand-off; pressed again, abort |
| wheel | steps the ship-time ladder (§4) — the observer speed ladder is off duty |
| `g` | leave to the observer at the same pose (ship state stored, autopilot aborted) |
| `T` | freeze/resume the shared clock (frozen = ship *and* sky) |
| `c` `V` `B` | gated: HUD notice; controls disabled |
| `Shift+C` | select the galactic centre as the speed reference (§7.4) — no re-pose |
| `H` | select the home reference (the Sun in the Milky Way, a generated galaxy's centre otherwise) — no teleport |
| `R` | reset the active hull to camera home (full tank, zero v) and clear the locked destination; parked hulls stay put |
| `O` | dock at / undock from the target station (§10) — the port refill and life-support restore land here |
| `L` / `Shift+L` | load / unload the cargo hold at the docked station (§10) — the container hook, free (no economy) |
| click / `N` `X` / search / Tab | unchanged — selection is how the HUD gets its target |

`V` is gated because the system view re-poses the camera (its enter path
snaps to an orbit), which would teleport the ship; the HUD's target line is
the in-game readout of the same selection. `C` and `H` are the reference
selectors: in the observer rig they keep their legacy motion (`Shift+C`
orbits the centre, `H` travels home) **and** select the reference; in game
mode they only select it, because a ship never re-poses and never
teleports (G3's return-home remains an autopilot target, not a jump).
The three
ship commands keep their Controls-panel controls live: `fly to star` fires the
approach, the `follow motion` checkbox is repainted from the ship's follow
state while the ship is the rig (the observer's chase otherwise), and the
`fly` button reads `abort autopilot` and is live exactly while one is running.
The autopilot is a command, not state: it aborts on the toggle, on a thrust
key, on Space, on the hangar's class swap and on `R`.

## 4. Ship time — one clock, on the system view's ladder

The fly camera's 8 ly/s start is ~2.5×10⁸ c — honest ship classes need
compressed time. The compression is **one shared clock**, not two: while game
mode is on, the ship's physics (burns, tank, life support) and the stars'
drawn motion advance on the same rate `R`, so closing rates, ETAs and the
velocity handover are all the same physics. This is also what makes a target
*reachable*: under one clock the ship's cruise outruns stellar drift by
~10² (0.1 c vs the ~220 km/s of galactic rotation), so a star selected at
8.6 ly is met where it arrives; under two clocks — the ship compressed, the
sky left at the galaxy's usual 5 Myr/s — the sky tears past at ~100 pc/s and
nothing the ship can do ever catches it (the overshoot lesson of the
observer's fly-to).

`R` is a **ship-time ladder in ship-years per wall-second**, the same
convention as the system view's `SYSTIME_LADDER` (0.5.5):

```
SHIP_TIME_LADDER = [follow, frozen, 1e-5, 2e-5, 5e-5, … 1-2-5 …, 1e6]  (y/s)
```

- **Range** 1e-5 … 1e6 y/s: the bottom is docking resolution (a chemical
  frame-tap at full thrust lands in the tens of m/s), the top is
  galaxy-crossing (the 100 kpc disc at 0.1 c in minutes). The 1-2-5 rungs are
  deliberate stops, exactly like the system clock's — the lesson of that
  ladder's own history is that a ship's useful rates span many decades.
- **Default rung**: the class's *home* rung — the 1-2-5 stop nearest the rate
  where a full-thrust frame-tap (60 fps) spends ~1% of the tank
  (`HOME_TAP_FRACTION`), clamped to the manual-flight band 1e-5 … 2 y/s. So
  every class flies at a resolution its throttle can speak in: chemical lands
  at 1e-4 y/s (docking taps in the tens of m/s), stardrive at 0.5 y/s (a
  cruise leg to a nearby star in minutes, a 200-y life support counting down
  on a human clock). The hangar's class swap re-snaps to the new class's home
  rung; the wheel walks away from it in either direction.
- **`frozen` (0)** and the `T` key freeze the shared clock: the ship and the
  sky pause together (coasting is free, so a frozen ship simply hangs).
- **`follow` (−1)** is the coupled rung, in the system view's negative
  convention: `R = SHIP_FOLLOW_GAIN · v/c` (20 y/s at cruise) — time scales
  with the ship's own speed, so the pace reads the same at cruise and slows
  automatically into a docking approach.
- **The axis is the star-time axis under its other name**: while game mode is
  on, the star-time slider and the wheel step this ladder (slider stops are
  rung indices, as with the system view's clock) and its readout says
  `ship +2 y/s`; the observer's Myr/s rate is parked at the toggle and
  restored on exit. `evolve`, the pattern clock and the label/pick dispatch
  all read the same `dtStar` — under the ship's clock the galaxy ages and
  drifts at the pilot's pace, which is the point of the coupling.
- Decoupling is the sim mode: the bottom rungs (and `×1` via the G5 SIM
  preset, `R = 1` ship-s per wall-s) give real seconds, real distances, and
  the honest discovery of why nothing reachable by eye is close.
- **The two presets (G5).** The Controls panel carries `sim clock` and
  `arcade clock`, both live only in game mode. SIM selects the ladder's
  real-time stop (`SHIP_TIME_REAL = 1/SECONDS_PER_YEAR`, below the 1e-5
  manual band) and turns the warp off; the readout says `ship real ×1`.
  ARCADE re-snaps to the class's home rung — the default rung — and arms the
  **coast warp**: while a destination autopilot is in its unpowered coast
  phase, the shared clock rises to the rate the flight's four-wall-second
  floor implies (`arcadeWarpYPerS` = `timeRateCapYPerS(ap.etaS, 4)`), so the
  years-long leg plays out in seconds. Burn and brake keep the pilot's rung —
  that is where the clock has to stay slow enough to fly — and the existing
  autopilot cap keeps the same floor as an *upper* bound, so the warp can
  never outrun the flight. The warp follows the decaying remaining ETA, so
  the approach eases back onto the base rung instead of snapping. Freezing
  (`T`) still wins: the warp reads 0 on a frozen clock. The presets are
  per-hull clock state (`ship.arcade`, `ship.timeIndex`), so a class swap
  re-snaps the base rung and a hull switch restores its own mode; the wheel
  still steps the base rung under an armed warp. The HUD names the mode
  (`ship clock arcade +0.5 y/s · coast warp +2.5 y/s`).

Time compression is what makes the cruise cap playable; it is not a fake
speed. The HUD's ETAs are marked **ship** (the pilot's clock) and **wall**
(at the current rung) — the two numbers that make the compression legible.

## 5. Autopilot (G2)

`Shift+F` in game mode is a burn/flip approach to the locked Flight destination
(or the primary selection when no destination is locked) instead of the observer's
2 s cinematic flight:

- Profile: the closed forms of `route.js`'s `interstellarLeg` (0.5.5) — one
  source of truth, literally the same function. For distance `d`, accel `a`
  and cruise `v_c = class.vCruise·c`:
  - `v_peak = min(√(a·d), v_c)`, `Δv_req = 2·v_peak`
  - `t = 2·√(d/a)` unclamped; `t = d/v_c + v_c/a` with a coast plateau
    (the piecewise burn–coast–brake law — the two expressions are the same
    function of `v_peak`, as `interstellarLeg.timeS` already shows).
- **The flown law is a velocity match, not a timeline.** Each frame the
  autopilot builds the *desired velocity* and commands the exact difference,
  capped at the class accel (saturate → the profile's burn; zero → its coast).
  The desired velocity is the target's own motion plus a closing speed,
  `v_des = v_target − v_close·d̂`, with `v_close` the largest speed that can
  still be brought to rest on the stand-off shell:

  ```
  v_close = min( √(2·a·rem),  v_c,  rem/dt_ship · ½ )     rem = d − standOff
  ```

  The first term is the braking profile (`√(2·a·d)` at the half-way point *is*
  the profile's `v_peak`), the second is the cruise cap, and the third is the
  **terminal rule**: at most half the remaining distance per frame. The ship
  clock's dt is enormous (1e5–1e6 ship-seconds at cruise rungs), so a
  controller that ignored it would step straight over the target; halving
  converges geometrically instead. On the stand-off shell within
  `AP_ARRIVE_M` (1 AU) the flight ends (`arrived`). A coast is the dead band —
  a command below 10⁻⁶ of one frame's full-thrust impulse, i.e. numerically
  exact. A band of 1 % of the impulse is not one: on the cruise rungs the
  impulse is ~3·10⁴ m/s, the residual it would leave is comparable to one
  frame's own position change, and the controller re-burns its overshoot every
  few frames (measured on the follow at 3·10⁵ s: the tank runs dry at the
  stand-off with no target motion). The law is deadbeat for small errors, so
  the band has nothing to protect against except f64 noise.
- **The desired velocity holds the cruise cap.** `v_des` is a galactic-frame
  velocity, and the target's drift plus the closing speed can exceed the cap.
  A command into the cap wall is paid for and then clamped away, so the desired
  velocity is clipped to the cap before the command is formed.
- Fuel checkout before commit: the profile's `Δv_req` **plus the relative speed
  the ship is carrying** (`|v_ship − v_target|`, zero for a cold approach, so
  the plan's `2·v_peak` in the case the formula is written for) against
  `dvRemaining`; insufficient tank refuses with a HUD line
  (`insufficient Δv: need X, have Y`), it never strands the ship mid-flight.
- Burn, flip and brake are flown **in the target's rest frame** (closing rate,
  not ship speed, is what the profile zeroes) — the lesson of the observer's
  fly-to. The commit assumes a cold approach: the relative velocity is nulled
  first (the `j` handover or a `Space` stop); a hot approach (`u² > 2·a·rem`
  along the line — cannot stop in time at the class accel) refuses with the
  residual-speed line rather than braking through the target. An in-system
  class refuses too (`interstellarLeg` has no profile for it), as does a
  target already inside the shell.
- **Phase** (burn / flip / coast / brake) is read off the command, not a
  script: no command is `coast`; a command along the line of sight is `burn`,
  against it `brake`, and entering the brake from a burn *or a coast* holds
  `flip` for a short wall-time beat (`AP_FLIP_HOLD_S`). A coast keeps the nose
  on the target, so the reversal into retrograde is a flip either way — the
  attitude change is the one thing the shared clock cannot express: at 0.5 y/s a
  "real" flip is over inside one frame, so the display beat is the wall clock's.
  The beat can cover a whole brake at 60 fps; the brake is then read off the
  nose, not the phase name.
- **The nose follows the burn.** The commanded direction is the ship's aim and
  the camera eases onto it through its own look axis — main.js adds to the same
  `lookDx/lookDy` accumulator the mouse writes, so the ease is the camera's one
  look law (no second attitude law, `camera.js` untouched) and the pilot can
  still glance away: the look wins frame by frame and swings back, exactly like
  the chase follow's glance. A `coast` keeps the nose on the target.
- The target moves only if the frame loop updates it *before* the ship steps
  (the same order rule as the camera: target, then step, then render).
- The launch target rides the ui.2 contract: the drawn position, resolved by
  key each frame, so a star moving under the shared clock is met where it
  arrives — the same feed `camera.updateTarget` already gets, and the same
  consecutive drawn positions the chase follow (ui.6) reads as the movement
  vector (and G1's handover reads as physical velocity). The target's
  *physical* velocity is that feed divided by the frame's ship-seconds, so the
  whole autopilot is in the same units as the ship's own.
- Abort: any thrust key, `Space`, `f`, the class swap or the `g` toggle
  (returns to manual at the current velocity); the HUD shows phase and the
  ship-time ETA, and the ETA counts down as the flight closes. A target that
  leaves the residency (no drawn position) aborts with `target lost` — its
  birth record is not a place to fly to.
- **Follow (`j`)**: the ship-side twin of the observer's chase follow — the
  desired velocity is the target's own, plus a correction that pulls the ship
  onto the *chased point* `target − standOff·â`, where `â` is the target's
  movement direction eased by the same law `camera.js`'s `stepChase` runs
  (exponential ease of the remaining angle, `exp(−dt/τ)`), applied to the
  ship's velocity instead of the camera's pose. So the relative velocity is
  nulled once and the ship trails at the stand-off, and fuel burns again only
  when the target curves — the correction is the only thing that costs. The
  nose rides the eased direction (where the target is going, target centred).
  Abort is the same as the approach's.
  The stand-off is held to within one frame of the target's own motion: the
  clock cannot resolve less (at the top rung a frame is 2·10¹¹ m of drift
  against a 10¹³ m stand-off), and a deadbeat frame lands the ship there.

Implementation reuses `route.js`'s leg math (0.5.5 cruise legs) rather than
re-deriving it; `deltav.js` stays the single source of class numbers. The
attitude law — eased alignment onto a drawn-space movement vector — is
`camera.js`'s chase follow, not a new derivation.

## 6. The display (HUD and ship chrome)

G1 landed the text HUD in the overlay (`gameModeLine`, the 4 Hz cadence);
G2 draws the chrome. Both are overlays on the existing 2D label canvas or the
overlay `<pre>` — no render-path changes.

### HUD lines (G1, extended by G2)

```
mode      game · ship clock +0.5 y/s (wheel steps · T freezes) · g returns to observer
ship      stardrive · accepted thrust ▮▮▮▯▯ 82% · burn 2.1 kyr reserve · docked at Sirius port
speed     0.043c (+8.2 m/s²) · fuel 146,200/200,000 m/s Δv (73%) · life 197 y
cargo     12,000/20,000 t
home      Sirius port · 8.61 ly · closing 0.030c
life      support expired · return to Sirius port
→ Sirius B   8.61 ly · closing 0.030c · coast eta 287 y ship · 57 s wall · ap eta 158 y
auto      burn · 38% · eta 158 y ship · 12 s wall · Δv 4,100/24,600 m/s · f aborts
```

G4 adds the last three state lines between `speed` and the target
arrow: `cargo` (while docked or the hold is nonzero), `home` (while
life support is critical or expired — the port of registry's drawn
distance and closing rate) and the persistent `life` line while
support is expired. The `ship` line gains `· docked at <port>` while
docked, and the `life` figure on the `speed` line gains `· critical`
inside the warn band (§10).

- **mode**: the clock rung and the escape key; the placeholder line is gone.
- **accepted thrust**: the accepted burn over the current cap (the blend,
  post-factor and post-projection — see §2); a cruise-clamped forward request
  is therefore 0%, not a fictitious burn. The burn reserve is `dvRemaining /
  |a|` at the current thrust, full thrust when idle (ship time, via
  `deltav.formatDuration`).
- **speed**: km/s under 0.01c, then fractions of c (the plan's display law);
  the bracketed term is the applied acceleration while thrusting. The speed
  is the ship's own (galactic frame), never time-lapse wall speed.
- **fuel**: remaining Δv in m/s (km/s above 10⁶), percent of `dvMax`, and the
  empty-tank state (`tank empty · thrusters silent · coasting`).
- **target**: the locked Flight destination's name (or the primary selection
  when none is locked), in drawn space; distance through `formatLy`, closing
  rate `−d(dist)/dt` on the shared clock (a receding or drifting-past target
  says so instead of a bogus ETA), the coast ETA at the current closing in ship
  *and* wall time, and the autopilot ETA of §5 — the numbers that sell the
  restrictions. G1 computes the ap ETA from §5's closed form even before the
  autopilot flies it.
- **auto** (G2) is the §5 line: phase, the fraction of the profile flown, the
  ETA in ship *and* wall time, the Δv the flight is spending out of what the
  checkout reserved, and the abort key. A refusal replaces it with the reason
  (`insufficient Δv: need X, have Y`, `hot approach · closing U · null it first
  (Space)`, `ship is in-system only`, `already at the stand-off`) for a few
  ticks, the `noSelectionTicks` pattern — never a silent no-op.
- Empty-tank, residual-stop and arrival states get their own explicit lines.
- Gated keys answer with a notice line (the `noSelectionTicks` pattern):
  `not in game mode · g returns to observer`.

### Ship chrome (G2)

Fixed 2D overlay on the label canvas: crosshair, a velocity ladder (excess
speed bleeding past the frame), a target frame with name/distance tag, and the
throttle/fuel strip — all strokes and text, the class color from
`SHIP_CLASSES[].color`, drawn in the same pass discipline as the rings (one
more pass in `label-layer.js`'s `draw`, live numbers every frame, the strings
preformatted by main.js at the overlay's 4 Hz — the system layer's own rule).
A 3D hull mesh is **not** planned (you never see your own hull from inside; the
chrome is the ship).

- **Crosshair** — the nose, at the screen centre: a gapped cross with four
  corner ticks.
- **Burn marker** — the commanded direction (`ap.aim`) projected as a
  direction, so its offset from the crosshair *is* the aim's angle off the
  view axis: the pilot sees the ship come about (it crosses the crosshair at
  the flip) and can take the attitude over by turning into it. Behind the
  camera it pins to the screen edge with a tick, on the side the pilot turns
  toward; dead astern, with no side to turn toward, it pins upward rather
  than sitting on the crosshair as if aligned.
- **Velocity ladder** — a vertical tape left of the centre, rungs at 25/50/75
  and the class cruise cap at the top; the fill is the ship's own speed over
  the cap. Whatever exceeds the tape bleeds past the frame as a stub with a
  bright cap line: the ship's speed can only be there transiently (the
  handover seeds an over-cap velocity into a slower class), the *closure*
  marker legitimately can (a target crossing faster than the class's own
  ceiling), and both read the same way.
- **Target frame** — a box on the locked destination's drawn position (or the
  primary selection when none is locked), projected like a label and clamped to
  the screen edge when it leaves the view; the tag beside it is the name and the
  drawn distance, in the class color with the label halo.
- **Throttle / fuel strip** — bottom centre: the applied burn over the current
  ceiling on top, the remaining Δv over `dvMax` under it, with the two
  readouts main.js preformatted.
- **Return-home marker** (G4) — an amber frame and tag at the home
  port's drawn position, drawn by the same projection/clamp/flip law
  as the target frame, while life support is expired. It is *hard*:
  no toggle dismisses it, only a dock (which restores life) clears
  it. A star home that leaves the residency takes the marker with
  it — its birth record is not a place to return to; the frame-fixed
  home cannot leave.

The ordinary ship controls live in the Flight workspace, rather than appearing
only after game mode is entered: class/refuel, forward thrust, the speed
governor, destination snapshot, forecast and plan actions are adjacent. The
Controls panel keeps the keyboard-equivalent emergency/observer controls: its
`data-action` controls fire the same one-shot flags as their keys, the `g`
checkbox is already there, and `data-observer` still disables controls that
would re-pose the ship. The System-map rows below Flight remain `data-view`, so
they only expand when the observer opens the schematic.

## 7. Flight control and destination planning (G3)

G1's keyboard law is intentionally retained for fine manoeuvres, but it is not
the whole pilot workflow. The ordinary task is: choose a ship, choose one
visible destination, decide whether the priority is speed, fuel or a delivery
deadline, inspect the cost, then fly. G3 puts that task in one **Flight** panel
instead of making a player alternate between the Controls, System and overlay
panels.

### 7.1 One flight workspace

The lower-left System panel becomes **Flight**. It has two short, ordered
sections while game mode is active:

1. **Manual flight**: the ship class and refill, and the two **mutually
   exclusive** forward-axis controls (ui.11): a persistent forward-thrust
   lever (0–100%) — *thrust control*, where the setting commands the burn —
   and a desired-speed slider with its *cut thrust* checkbox — *speed
   control*, where forward thrust is accepted only while the ship is below
   the chosen fraction of the current class cap (a cap, not a brake; no
   hidden reverse thrust, and no auto-burn from rest). Touching either
   control switches the forward axis to it and disables the other: a
   thrust change turns the speed limit off, a speed change turns the
   thrust lever off. The off-duty row is muted and its value line names
   the owning control. W/S and the other axis keys remain immediate
   manoeuvre inputs and temporarily override the active forward control
   either way. This preserves mouse steering and the existing docking
   controls while letting a player set a normal cruise without holding
   W.
2. **Fly to destination**: **Use selected** snapshots the currently selected
   star as the destination. It keeps its identity, drawn-space snapshot,
   luminosity stand-off and displayed name, so changing the selection later
   does not silently retarget a flight. The destination is resolved by key
   each frame just like the G2 approach; losing residency is an honest abort,
   never a flight to a stale birth coordinate. The mode, its one relevant
   limit, forecast and **Engage** / **Abort** controls are adjacent.

The existing System map and local/interstellar route controls remain below the
flight controls in that same panel. They serve the second common task — plan a
multi-stop or economy-style transport route — without requiring a different
menu location. The schematic is still observer-only because opening it
re-poses the camera.

### 7.2 Plan modes and forecast

All four destination modes are rest-to-rest, target-frame profiles over the
remaining distance to the selected star's luminosity stand-off. Let `d` be that
distance, `a` the permitted acceleration and `v` the permitted speed. The
shared profile is

```text
v_peak = min(sqrt(a d), v)
Δv_profile = 2 v_peak
t = d / v_peak + v_peak / a
```

which is the same triangular/trapezoidal burn–coast–brake law the G2 approach
uses. A forecast adds the current target-frame relative speed as the initial
velocity-match allowance and compares the result with the **remaining** tank;
it reports predicted Δv cost, margin, ship time and wall time at the current
ship-clock rung.

- **Fastest** — class acceleration and class cruise cap.
- **Use thrust as limit** — the Manual-flight thrust lever supplies `a` as a
  fraction of the class acceleration; the class cap stays available.
- **Use speed as limit** — class acceleration stays available; the desired
  speed supplies `v` as a fraction of the class cap.
- **Use time limit** — the entered ship-time deadline is a maximum arrival
  time. If it is shorter than the fastest legal profile it is rejected. Otherwise
  the planner selects the least-Δv profile that reaches it: a triangular
  profile with `v_peak = 2d/t`, `a = 4d/t²` when that peak is under the cap,
  or a cap-speed trapezoid with `a = v²/(v t − d)` while the cap binds.

The engage command copies the forecast's acceleration and speed limits into the
G2 controller, so changing a slider later cannot mutate an active burn. Its
braking envelope is the same controller already checked by G2; the forecast is
therefore the configured profile, not an unrelated UI estimate. A shortcut
`Shift+F` remains the unconfigured fastest approach; the panel is the explicit
trade-off workflow.

### 7.3 Applied impulse is fuel

Fuel is charged for **accepted velocity-vector change**, not requested throttle
that the cruise clamp discards. For a requested impulse `i`, the integrator
projects `v + i` onto the class's speed ball and charges
`|v_after − v_before|` in m/s. If the remaining tank cannot cover that accepted
impulse, it bisects the requested interval and takes precisely the affordable
part. Consequences are deliberate:

- Holding forward at the cruise cap changes no velocity and costs no Δv.
- A turn at cap costs the real vector change after projection.
- Braking costs the velocity it removes; an all-stop still stops exactly or
  reports the residual.

`throttleFrac`, `accelNow`, the HUD and the chrome are the accepted impulse over
the frame, not a requested burn that the clamp threw away. The lever may still
say it is commanded while the HUD honestly says 0% accepted / coasting.

### 7.4 Fleet, view-axis speeds and target stop (ui.10)

The Flight workspace owns a session fleet, not one mutable global hull. Each
fleet entry has its own `Ship` record (position, velocity, class, tank, clock,
and autopilot) plus a stable display name. **Spawn ship** creates a stationary
ship at the camera's current position. Clicking a fleet row selects that ship,
places the camera at its saved position, and enters game mode if needed; the
view orientation remains the pilot's live camera orientation. Parked ships do
not move or spend fuel, and switching hulls aborts the outgoing hull's active
autopilot rather than leaving a stale command to resume later. The existing
class selector and route map follow the active hull.

The pilot readout shows signed **forward, sideways and vertical** velocity
components, projected onto the camera's live forward/right/up basis, so W
accelerates into the view and the displayed components match the controls.
They are measured against the **speed reference** (ui.11): the locked Flight
destination else the primary selection by default, or an explicit choice of
the galactic centre or home (the Milky Way's Sun; a generated galaxy's
centre) — the **target ref / centre ref / home ref** buttons in the Controls
panel, or `Shift+C` / `H` as a side effect (§3). The centre and home are
frame-fixed points: always resident, never stale, at rest, so their relative
velocities are zero and the axes read absolute in that frame; the autopilot
can fly to the centre itself. The reference's name is printed above the
velocity grid, and the HUD line names it too.

The hull's **heading** is a ship state like position and velocity (§2):
the camera's live unit quaternion, adopted on spawn and first entry,
written back every step while flying, restored on hull switch and reset.
Changing the heading moves the axes the velocities are projected on, so
the components re-project on the next readout — the velocity itself is
world-fixed.

While a destination approach or target-stop autopilot is active, its remaining
ship-time ETA and the requested clock rung bound the shared ship/sky clock so
the travel cannot be compressed below four wall-clock seconds. On a slider
change or a newly engaged approach/target stop, the cap is
`ETA_ship_seconds / (4 × seconds_per_year)` in years per wall-second; the
effective rate is the lower of that cap and the selected rung. The cap is
computed on the user action/commit, not allocated or re-solved in the frame
loop, and is cleared when the autopilot ends or is aborted. A frozen clock
remains frozen. Selecting the coupled `follow` rung from rest gets the minimum
timed rung while thrust or an autopilot is commanding motion, so the ship can
actually start.

The Flight panel's **Autopilot to target** checkbox is the precision variant of
the legacy stand-off approach. It snapshots the current destination (or the
primary selection), closes on the drawn target, then settles at its current
position while matching its physical velocity. At completion the three
view-axis target-relative velocity components are exactly zero; fuel checkout
includes the velocity match, and an active command aborts on manual thrust-key
input, target loss, all-stop or hull switch just like the other autopilots. The
existing Shift+F stand-off flight and configured Engage workflow are unchanged.

## 8. Milestones

- **G1 — ship state + HUD + restrictions (shipped 2026-10-16)**: `ship.js`
  (state, burn integral, accel/cruise caps, all-stop, the §5 profile closed
  form), the §4 shared clock and ladder (wheel/slider/T), input routing (the
  §3 gating table, Space all-stop, the hangar refill), the §6 text HUD, and
  the first-entry velocity handover from any live follow (§2). A new hull
  adopts the camera pose on first entry; ui.10's fleet extension restores a
  previously piloted hull's saved pose and velocity on later entries. The rig
  writes through `camera.getState`/`setState` scratch pairs; `camera.js` itself
  is untouched.
- **G2 — chrome + autopilot (shipped 2026-10-16)**: §6 canvas chrome (crosshair,
  burn marker, velocity ladder, target frame + tag, throttle/fuel strip), the §5
  burn/flip autopilot with the fuel checkout, the rest-frame commit and the
  phase display, the nose-through-the-look-axis aim, and the §5 follow command.
  Tests: profile/ETA pins against `route.interstellarLeg`, the flown approach
  converges on the shell inside the checked-out Δv, abort leaves the stored
  velocity, insufficient-Δv and hot approaches refuse without burning, follow
  nulls the relative velocity and trails at the stand-off.
- **G3 — Flight controls, destination plan and applied impulse (shipped
  2026-10-16)**: the single Flight workspace of §7, persistent forward thrust
  + desired-speed governor, key-resolved destination snapshots, the four plan
  modes, the Δv/time forecast, and a configured approach that copies the
  forecast's limits. The integrator charges accepted velocity-vector impulse, so
  cruise-clamped forward thrust is free while turns and braking pay their real
  Δv.
- **ui.10 — fleet and target stop (shipped 2026-10-17)**: session-local hulls,
  stationary spawn at camera, click-to-pilot, signed camera-axis speed
  components, a target-relative zero-velocity arrival command, and the shared
  four-second minimum travel-time cap (§7.4).
- **ui.11 — pilot semantics, heading and reference (shipped 2026-10-17)**: the
  mutually exclusive thrust/speed Pilot controls (§7.1), the hull heading
  state and its adoption/write-back (§2), and the selectable speed reference
  with the centre/home frame-fixed points (§7.4).
- **G4 — docking, refuel and life support (shipped 2026-10-19,
  ui.13; the design is §10)**: any natural-object flight target is a
  station; `O` docks inside its shell when settled, the station
  refill re-arms the tank *and* restores life support, the docked
  ship rides the station's drawn motion, the port of registry
  becomes the return-home marker's target when life support
  expires, and the hold loads/unloads at the dock (`L`/`Shift+L`) —
  the cargo-container hook, prices and economy omitted (matching
  0.5). Dock-port assets land in ui.1's typed asset history on
  every dock.
- **G5 — clock presets and polish (shipped 2026-10-19, ui.14)**: the
  `sim clock` and `arcade clock` Controls-panel buttons on the §4 ladder
  (SIM = `R = 1` real seconds, the ladder's new real-time stop; ARCADE =
  the class's default rung plus the autopilot coast auto-warp), the
  `data-game` gate and the live `is-active` lights, and the HUD's
  `coast warp` note. No renderer, WGSL or catalog change. The browser
  visual pass on real hardware remains deferred
  (deferred-browser-visual-plan.md's lane).

Ship display itself: G1 is honest text; G2 is the chrome above. ui.10 gives
fleet hulls session-local ids and names; a later G4 can connect them to ui.1's
typed asset history when docking and transport need persistent asset identity.

## 9. Files and tests

- `src/core/ship.js` — the `Ship` namespace (state creation, class table
  access through `deltav.js`, the accepted-impulse integrator and caps through
  one shared `advance()` that the manual law, all-stop and autopilot all pay,
  the §5 profile plus the configurable §7 planner, the autopilot record with
  its commit / step / abort and target settlement, camera-axis velocity and
  ship-clock-cap helpers, `SHIP_TIME_LADDER` and its rung helpers
  (`SHIP_TIME_REAL`, the `setClockPreset` SIM/ARCADE pair, the
  `arcadeWarpYPerS` coast law), display
  formatters). One API object for page and Node.
- `src/main.js` — the g toggle (handover, clock takeover/restore), per-hull
  fleet switching and spawn, the game frame step and `getState`/`setState`
  write-through, the key-resolved destination feed (drawn position *and*
  physical velocity), the autopilot commands and the aim it feeds into the
  camera's own look axis, the four-second rate cap, camera-axis velocity
  readouts, Flight panel/forecast/target checkbox, input gating, Controls panel
  repaint (ui.6), and the chrome state the label layer draws.
- `src/core/input.js` — `Space` (`actions.allStop`), `actions.shipRefuel`
  and G5's button-only `actions.clockSim` / `clockArcade` in the shared
  action table; everything else is main.js routing (G2 adds no action: the
  approach, the abort and the follow ride `flyTo`, `flyMode` and
  `chaseFollow`, which game mode now reads as its own commands).
- `src/core/camera.js` — no changes: the write-through is the existing
  `getState`/`setState` pair; the chase follow (ui.6) already carries the
  drawn-position movement feed and the eased-alignment law §5's follow
  command reuses; the nose ease writes the look accumulator the mouse already
  shares. Game mode reads them, it does not grow a second copy.
- `src/render/label-layer.js` — the §6 chrome pass (`setShipChrome(state)` +
  one draw at the end of `draw`): crosshair, burn marker, velocity ladder,
  target frame and tag, throttle/fuel strip. Live geometry from the passed
  floats, strings from main.js's 4 Hz formatting.
- `src/index.html` — the script tag (after `route.js`, before `main.js`), the
  `data-game`/`data-observer` attributes, the fleet list/spawn control, camera-
  axis velocity readout, target-stop checkbox, refill button and ship-command
  controls with their dual titles.
- `README.md` — controls rows and the game-mode section's autopilot paragraph.
- `experiments/ship-test.js` + a `ship` row in `scripts/run.py`; m1-smoke pins
  for the HUD markers, g wiring, ladder, gating, fleet/target-stop wiring,
  four-second cap and the camera-axis controls (along with the G2 autopilot and
  chrome contracts).

Tests (`experiments/ship-test.js`, G1): the burn/tank invariant
(`dvSpent == ∫|a|dt`), the accel cap at blend angles (the √2 blend clips to
the cap and the bar reads 100%), the cruise cap (and the in-system constant),
Space all-stop including the dry-tank residual, the §5 profile math against
`route.interstellarLeg` (unclamped `2√(d/a)`, clamped `d/v_c + v_c/a`, equal
Δv law), first-entry pose continuity and the velocity handover (drawn feed →
physical velocity through the clock, clamped to the class cap), the ladder's
rung arithmetic (default, follow, frozen), and zero per-frame allocations
(buffer-stability pin like camera-test's 600-frame one).

Tests (`experiments/ship-test.js`, G2): the commit's checkout numbers
(`dvRequired = profile.dv + |v_rel|`, the ETA equal to the closed form), the
refusals (fuel, hot, in-system, inside the shell — each leaving `dvSpent`
untouched and the mode off), the flown approach (converges on the shell,
spends no more than the checkout reserved, walks burn → flip → brake, and is
within the closed form's own scale), the phase walk's flip beat, a *moving*
target being met at the stand-off, abort keeping the velocity and stopping the
burn, and the follow (nulls the relative velocity to the stand-off, re-nulls
when the target curves, burns only for the correction), each at the clock
rungs 3·10⁴, 3·10⁵ and 10⁶ s. The chrome pass (`label-layer.js`) is checked on a
recording context against the sprite shader's own projection: the target frame
where `coords.projectToScreen` puts the star, the burn marker on the crosshair
and pinned upward dead astern, a target behind the camera pinned to the edge
on the side to turn toward, the tape's fill and over-cap stub, the strip, and
the pass drawing with the observer labels off. The no-reallocation loop weaves
the approach, the follow and the abort through the active hull's one ship record.

Tests (`experiments/ship-test.js`, G5): the real stop's arithmetic
(`SHIP_TIME_REAL · SECONDS_PER_YEAR == 1`, the readout `real ×1`, below every
home rung and inside the ordered ladder), the preset pair (`setClockPreset`
unfreezes, SIM clears the warp and selects the real stop, ARCADE snaps to the
class home rung and arms it, a class swap re-snaps the base), and the coast
warp (off by default and for a follow, zero in the burn, equal to
`timeRateCapYPerS(ap.etaS, 4)` in the coast and above the base rung, zero when
frozen), plus the flown composition at 60 fps (1 ly arrives in 10.6 wall-s,
40 ly in 25 wall-s) — which pins the warp's *remaining*-ETA form: a constant
commit-time rate overshoots a 40 ly target and never recovers. `m1-smoke-test.js` pins the Controls-panel buttons and their
`data-game` gate, the press-before-the-clock ordering, the live `is-active`
lights, the HUD's `coast warp` note and the follow-fallback index.

Tests (`experiments/ship-test.js`, G3): planner profiles for all four modes
(fastest, thrust cap, speed cap and a feasible/impossible deadline), copied
limits on the configured approach, predicted relative-speed allowance and tank
margin, and applied-impulse accounting at the cruise boundary (forward costs
zero, a turn and brake cost their actual vector changes, and a nearly empty tank
accepts only its affordable projected impulse). `m1-smoke-test.js` pins the
single Flight workspace, destination/forecast/engage wiring and the fact that
the HUD reads accepted throttle.

Budgets: ship step ≤ 0.05 ms/frame at 300k stars, zero frame-loop allocations
(pinned), and no renderer, WGSL or catalog changes anywhere in G1–G4.

## 10. Docking, refuel and life support (G4)

The last leg of the game loop: a flight ends at a *station*, the ship
is serviced there, and the clock that outlives the crew has consequences.
Everything stays CPU-only and additive — no new object family, no star
buffer, no WGSL.

### 10.1 The station

Any **natural-object flight target** is a station: the locked Flight
destination, else the primary selection — the same target the §5
autopilot answers against (`gameTargetFeed` with kind `target`). The
frame-fixed references (galactic centre, home) are coordinates, not
ports — `O` there is refused. A port is a facility of the star, not a
body in the generated system, so no new record family exists and the
picker, the feed and the autopilot keep their exact contracts.

Dockable when all four hold:

1. game mode is on (`O` is gated outside it, the §3 notice pattern),
2. the target is natural and resident (a valid drawn position),
3. **inside the port's shell** — `distanceM ≤ standOffM + DOCK_SHELL_M`,
   the stand-off the approach arrives on plus one arrival shell of
   tolerance (a target-stopped ship at the star itself is inside too),
4. **settled** — `relativeMs ≤ DOCK_REL_MS` (1 m/s: the §7.4 target-stop
   autopilot lands exactly there; Ctrl docking finesse hovers).

The dock commit (`Ship.dock(ship, key, name)`): ends any autopilot (a
dock is a manual command, like every other manual input), sets
`docked`, records the station's identity `{ key, name }` and the
**ride offset** — the ship's vector from the station's *drawn* position
at the dock, in kpc — re-arms the tank (`dvSpent = 0`, the station
refill), restores life support (`lifeSpent = 0`, the port sustains the
crew) and makes the station the **port of registry** (`ship.home`).
main.js mirrors the port into the selection store's asset history as a
`dock-port` asset (`<star> port`, the star's key) — the ui.1 typed-asset
connection §8 promised.

### 10.2 The docked ride

While docked the frame loop calls `Ship.dockStep(ship, tx…tvz)` with the
station feed's drawn position and physical velocity: the ship sits at
`station + rideOffset` and moves with the station, so the shared clock
ages the galaxy around a parked ship and the camera write-through rides
along. No thrust, no autopilot, no fuel burn, **no life-support accrual**
— the port sustains the crew. Any thrust key, Space, `O`, the class
swap, `R` and a hull switch undock first: manual input owns the ship.
`Ship.undock` leaves the ship at rest relative to the port (it keeps
the station's velocity), and a station that leaves the residency breaks
the dock with a notice — the same honest no-stale-position rule the
autopilot's target-lost follows.

### 10.3 Life support

`lifeRemainingY = lifeYears − lifeSpent / SECONDS_PER_YEAR`
(Infinity stays Infinity — a generation ship cannot outlive its hull).
Three states:

- **ok** — nothing shows;
- **critical** — `remaining ≤ max(LIFE_WARN_MIN_Y, LIFE_WARN_FRACTION ·
  lifeYears)` (10 %, floored at 0.1 y, so a 2-y chemical hull warns at
  0.2 y): the `speed` line's life figure gains `· critical`, and one
  notice fires on the crossing;
- **expired** — `remaining ≤ 0`: the HUD prints a persistent
  `life support expired · return to <port>` line and the chrome draws
  the **return-home marker**.

The teeth are the warning and the marker, exactly as §2 promised. The
autopilot is *not* locked out — the pilot may choose to limp on — but
the marker is **hard**: no toggle dismisses it, only a dock (any port,
which resets `lifeSpent`) clears it.

### 10.4 The home port and the return-home marker

`ship.home` is `{ kind: 'fixed' }` until the first dock — the galaxy's
home point, ui.11's `H` reference (the Milky Way's Sun, a generated
galaxy's centre; frame-fixed, always resident, at rest) — and
`{ kind: 'star', key, name }` after: the last port of registry, resolved
by key each frame like every other drawn-space target. main.js keeps the
pick-shaped snapshot the resolution needs (`homeRef`, exactly the
destination's pattern) and feeds the home marker's drawn position,
closing rate and staleness at game cadence. A star home that leaves the
residency hides the chrome marker and the HUD line says `not resident`;
the fixed home cannot. The HUD `home` line shows at critical *or*
expired (a pilot inside the warn band deserves the heading too); the
chrome marker draws at expired only.

### 10.5 The cargo hook

`ship.cargo` (tons, 0 … `class.cargo`; 0 at launch, emptied by a class
swap — the new hull's hold is its own). While docked, `L` loads to full
capacity and `Shift+L` unloads to zero — free, no prices (the economy
stays omitted, matching 0.5's omission). The HUD shows the hold on a
`cargo` line while docked or nonzero. The containers are session assets
like the hulls: the port's manifest is the ship's hold, and ui.1's
`cargo-container` asset type stays available for the transport work a
later interface series can hang on it.

### 10.6 Refusals and notices

Every refusal is one short message line at the overlay's cadence (the
`setAutoMsg` pattern, ~3 s), never a silent no-op: no game mode (gated
key), no resident target (`no station in range`), a frame-fixed target
(`no port at a fixed point`), outside the shell (`outside the docking
shell`), unsettled (`not settled · relative <speed>`), cargo while not
docked (`cargo moves only at a dock`), an autopilot engage while docked
(`undock first`).

### 10.7 Files and tests

- `src/core/ship.js` — the `DOCK_*`/`LIFE_*` constants, the
  `docked`/`station`/`dockOffset`/`home`/`cargo` state, `dockReason`
  (the pure dockable check), `dock`/`undock`/`dockStep`, `loadCargo`/
  `unloadCargo`, `lifeRemainingY`/`lifeState`; `resetShip` and
  `setClass` clear the docked state and the hold (the registry home
  persists — it is session state like the fleet).
- `src/core/input.js` — `dock`/`cargoLoad`/`cargoUnload` one-shot
  actions (`O`, `L`, `Shift+L`), in the shared table and the
  panel-button passthrough.
- `src/main.js` — the dock command (conditions, refusals, the asset
  write), the station feed while docked, the docked branch of the
  frame step, the home feed, the life-state transition notices, the
  §6 lines, the chrome home feed, and the Flight panel's Port rows.
- `src/render/label-layer.js` — `hasHome`/`home`/`homeTagText` in the
  ship-chrome state and the amber marker in the chrome pass (the
  target frame's projection, clamp and flip law, factored so both
  frames share it).
- `src/index.html` — the Flight workspace's Port section (dock button,
  load/unload, port state line) and the Controls gating attributes.
- `README.md` — the controls rows and the game-mode section's docking
  paragraph.
- Tests: `experiments/ship-test.js` pins the dockable check's matrix,
  the commit's service effects, the ride (offset preserved, velocity
  copied, life frozen), the undock's rest-relative exit, the cargo
  law, the reset/class-swap clears and the life-state ladder;
  `m1-smoke-test.js` pins the wiring (actions, the docked frame
  branch, the asset write, the HUD/chrome feeds).

Budgets as in G1–G3: the docked branch is O(1) per frame, zero
allocations in the loop, and no renderer, WGSL or catalog change.
