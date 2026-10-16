# Game Mode — Spaceship Flight, Restrictions and Display (plan; g key stub landed with ui.4)

The viewer is an observer: a free fly camera, two orbit modes and a cinematic
fly-to. Game mode is the same pipeline flown as a **spaceship** — the camera is
the ship, its motion is restricted by the ship class, and a HUD answers the
three questions a pilot always has: **how fast, how much fuel, how far to the
selected object.** Toggle with `g`.

Status: **planned**. ui.4 reserved the `g` key (it toggles a placeholder line in
the overlay; the galaxy type it cycled before is a panel-only control) and this
document is the design. Nothing below is implemented until its milestone ships.

## 1. Principles

- **One pipeline, two rigs.** Game mode is a control-and-display layer over the
  existing renderer, selection store, search, system view and routes. The star
  buffer, the WGSL and the three render paths do not know it exists — the same
  law as hybrid/procedural mode.
- **The ship state outlives the toggle.** Entering and leaving game mode keeps
  position, velocity and the remaining tank; the observer modes just stop
  applying ship law while it is off.
- **Restrictions are the game.* The fly camera's speed ladder, instantaneous
  stops and free zoom are observer tools. The ship accelerates, coasts and runs
  out of Δv. Everything the HUD shows is a consequence of the same three
  numbers: class acceleration, class Δv, class cruise fraction.
- **Drawn space rules travel, birth space rules records** (ui.2): distance,
  closing rate and ETAs are computed against the primary selection's *drawn*
  position; identity stays keyed.
- **No new dependencies, CPU-only.** `ship.js` is a classic script exposing one
  `Ship` namespace to page and Node alike (AGENTS.md runtime rules). G1–G3 add
  no WebGPU code; the ship chrome rides the existing 2D canvases.

## 2. Ship state — new `src/core/ship.js`

One ship record per session (a fleet/asset layer can add id/name later; the
ui.1 selection store already has `ship` and `dock-port` asset slots it will
feed):

- **Class**: a row of `deltav.js` `SHIP_CLASSES` (0.5.4) — `chemical`, `nuclear`,
  `fusion`, `stardrive`, `generation` — carrying `accel` (m/s²), `dvMax` (m/s),
  `vCruise` (fraction of c), `lifeYears`, `color`. The System panel's ship
  selector is the hangar: one selector, one source of truth.
- **Velocity**: the ship's own f64 vector, continued across observer excursions.
  The camera position is the ship position.
- **Throttle**: held WASD/arrow thrust along ship-local forward/right/up
  (mouse aims, exactly the fly camera's look). Shift = ×4 reserve burn, Ctrl =
  ×1/4 docking finesse.
- **Tank**: `dvRemaining`, initial `dvMax`. Burned Δv is the integral of applied
  thrust per ship-second: `dvSpent += |a|·dt_ship`. Tank empty → thrusters zero,
  the ship keeps coasting. Refuel lands with docking (G3); the menu exposes a
  hangar refill until then.
- **Life support**: `lifeYears` of ship-time from the class, decremented by
  ship time; a warning and a hard return-home marker when it runs out (G3).

## 3. Flight law and restrictions (G1)

The restrictions replace the observer's motion while game mode is on:

- **Orbit keys are gone**: c/C/F orbit or fly the *observer*. In game mode the
  ship has no orbit mode — `Shift+F` becomes the autopilot (G2), f stops being
  a mode key (the ship *is* the fly rig), and any thrust input overrides the
  autopilot. `g` leaves to the observer at the same pose.
- **Acceleration cap**: `|a| ≤ class.accel × SHIP_ACCEL_WORLD` with
  `SHIP_ACCEL_WORLD` the m/s² → world-units/s² bridge. The cap is per-axis
  blended, not per-key: full forward + full strafe is √2 of the thrust the HUD
  bar shows — the bar reads the blend so the cap is what the bar displays.
- **Cruise cap**: `v ≤ class.vCruise·c` for interstellar classes; `vCruise: 0`
  in-system classes cannot leave the local group of stars (their cap is a
  generous escape-scale speed). The galaxy is 100 kpc — time compression (§4)
  is what makes the cruise cap playable, not a fake speed.
- **Coasting is free, turning is free**: Newtonian straight lines between
  burns; mouse aim is gyros, no Δv cost.
- **Full stop**: Space burns counter-vector within the remaining tank (a brake
  that can run dry: the HUD marks the residual velocity when the tank cannot
  finish the stop).

## 4. Ship time

The fly camera's 8 ly/s start is ~2.5×10⁸ c — honest ship classes need
compressed time, exactly the problem the star-time slider already solves for
orbits. Ship time rate `R` [ship-seconds per wall-second] couples to the star
time axis on entry (the same negative-rate convention as the system view's
`-1` = camera-coupled): WASD burns integrate `dt_ship = R·dt_wall` — velocity,
fuel and life support all advance on ship time, and the HUD's ETAs are marked
`ship` vs `wall`. Decoupling (R = 1) is the sim mode: real seconds, real
distances, and the honest discovery of why nothing reachable by eye is close.

## 5. Autopilot (G2)

`Shift+F` in game mode is a burn/flip approach to the primary selection instead
of the observer's 2 s cinematic flight:

- Profile: closed form `t = 2·√(d/a)` for the accelerate-half/flip/brake
  triangle; a coast plateau at the cruise cap when the leg outruns it (piecewise
  burn–coast–brake, the standard textbook law).
- Fuel checkout before commit: required Δv = `2·√(d·a)` capped-profile variant;
  insufficient tank refuses with a HUD line (`insufficient Δv: need X, have Y`),
  it never strands the ship mid-flight.
- The launch target rides the ui.2 contract: the drawn position, resolved by
  key each frame, so a star moving under star time is met where it arrives —
  the same feed `camera.updateTarget` already gets.
- Abort: any thrust key or `f` (returns to manual at the current velocity);
  the HUD shows phase (burn / flip / coast / brake) and ship-time ETA.

Implementation reuses `route.js`'s leg math (0.5.5 cruise legs) rather than
re-deriving it; `deltav.js` stays the single source of class numbers.

## 6. The display (HUD and ship chrome)

G1 lands a text HUD; G2 draws the chrome. Both are overlays on the existing 2D
label canvas or a `<pre>` styled like `#sysread` — no render-path changes.

### HUD lines (G1)

```
ship stardrive · throttle ▮▮▮▮▯ 82% · burn 2.1 kyr reserve
speed 0.043c  (+8.2 m/s²) · fuel 146'200/200'000 m/s Δv (73%) · life 197 y
→ Sirius B   8.61 ly · closing 0.030c · coast eta 287 y ship · ap eta 158 y
```

- **speed**: km/s under 0.01c, then fractions of c; the bracketed term is the
  current acceleration while thrusting.
- **fuel**: remaining Δv in m/s (km/s above 10⁶), percent of `dvMax`, and the
  burn reserve at the current throttle (ship time).
- **target**: the primary selection's name (drawn-space), distance through
  `formatLy`/`formatDistance`, closing rate `d(dist)/dt`, coast ETA at current
  velocity and the autopilot ETA of §5 — the two numbers that sell the
  restrictions.
- Empty-tank and insufficient-Δv states get their own explicit lines (no
  silent no-ops).

### Ship chrome (G2)

Fixed 2D overlay on the label canvas: crosshair, a velocity ladder (excess
speed bleeding past the frame), a target frame with name/distance tag, and the
throttle/fuel strip — all strokes and text, the class color from
`SHIP_CLASSES[].color`, drawn in the same pass discipline as the rings. A 3D
hull mesh is **not** planned (you never see your own hull from inside; the
chrome is the ship).

## 7. Milestones

- **G1 — ship state + HUD + restrictions**: `ship.js` (state, burn integral,
  accel/cruise caps, full-stop), input routing (g toggle gating c/C/F/Shift+F,
  Space all-stop), the §6 text HUD, hangar refill button. Camera law converts
  between rig and ship at the toggle with zero pose discontinuity. Tests:
  `experiments/ship-test.js` — the burn/tank invariant (`dvSpent == ∫|a|dt`),
  the accel cap at blend angles, the cruise cap, ETA profile math against §5,
  the toggle's pose continuity, zero per-frame allocations (buffer-stability
  pin like camera-test's 600-frame one).
- **G2 — chrome + autopilot**: §6 canvas chrome, the §5 burn/flip autopilot
  with fuel checkout and phase display. Tests: profile/ETA pins, abort leaves
  the stored velocity, insufficient-Δv refuses without burning.
- **G3 — docking, refuel and life support**: dock-port/base assets from ui.1
  become the refuel stations; life-support timers bite; cargo containers hook
  (prices/economy stay omitted, matching 0.5).
- **G4 — polish**: SIM/ARCADE time-compression presets and the browser visual
  pass on real hardware (deferred-browser-visual-plan.md's lane).

Ship display itself: G1 is honest text; G2 is the chrome above. Asset ids and
fleet naming plug into the ui.1 typed asset history when G3 needs them.

## 8. Files and tests

- `src/core/ship.js` — new; the `Ship` namespace (state creation, class table
  access through `deltav.js`, burn/ETA closed forms, the frame step).
- `src/main.js` — the g toggle routes, HUD lines, autopilot orchestration,
  menu hangar rows (gated `data-game` like `data-view`).
- `src/index.html` — the script tag (after `route.js`, before `main.js`), the
  `#hud` element if the text HUD outgrows the overlay line.
- `README.md` — controls row and a short game-mode section replacing the g
  placeholder line.
- `experiments/ship-test.js` + a row in `scripts/run.py`; m1-smoke pins for
  the HUD ids and the g wiring.

Budgets: ship step ≤ 0.05 ms/frame at 300k stars, zero frame-loop allocations
(pinned), and no renderer, WGSL or catalog changes anywhere in G1–G3.
