# 0.1.1 Implementation Tasks — Checklist

Per-file breakdown of `plan.md` §18. The spec is there; this is the order to build it
in and what each step must prove. Status: 0.1.1 done (`camera-test.js` 104/104,
`all-tests` 11/11); 0.1.2 is next.

## Task 0.1.1-1: Input — slow, home, camera mode, wheel units
- File: src/core/input.js
- `keys.slow` on `ControlLeft`/`ControlRight` (DOM codes are `Control*`, not `Ctrl*`)
- `actions.home` (`KeyH`), `actions.cameraMode` (`KeyC`) — one-shot, ignore `e.repeat`
- `actions.exposure` accumulates `+= ±1` (key repeat welcome)
- Every mapped key `preventDefault()`s: Ctrl+R / Ctrl+H must not reload / open history
- `WHEEL_UNITS_PER_MODE = [1, 100/3, 100]`: one notch = 100 in pixel, line and page mode
- Proof: camera-test drives the same `keys` / `actions` shape; m1-smoke evaluates the
  file as a page script

## Task 0.1.1-2: Camera constants — ly units, power-of-two grid
- File: src/core/camera.js
- `LY_TO_KPC = 0.000306601`, `BASE_SPEED_KPC_S = 8 · LY_TO_KPC`
- `SPEED_MULT_MIN = 1/64`, `SPEED_MULT_MAX = 256` (powers of two: the ×2 grid must return to ×1)
- `BOOST_FACTOR = 100`, `SLOW_FACTOR = 0.1`
- `ORBIT_DISTANCE_MIN = 0.0001`, `ORBIT_DISTANCE_MAX = 100`, `ORBIT_TURN_RATE = 1`,
  `ORBIT_DOLLY_RATE = 1`, `ORBIT_KEY_BOOST = 4`, `HOME_ORBIT_DISTANCE = 0.01`
- Galactic centre read from `DensityLib.GALACTIC_CENTRE` (require under Node, window in the page)
- Proof: unit checks, clamp checks land exactly on the grid

## Task 0.1.1-3: Wheel — whole notches from a persistent accumulator
- File: src/core/camera.js
- `wheelAccum += input.wheelDelta`; consume `trunc(wheelAccum / 100)` notches, keep the remainder
- Fly: `speedMult ·= 2^−notches`; orbit: `orbitDistance ·= 2^notches`; both clamped
- Proof: ±1 notch = ×½ / ×2; ten 10 px events = one notch; 250 px = two notches + 50 carried

## Task 0.1.1-4: Orbit state — one angle pair
- File: src/core/camera.js
- `MODE_FLY / MODE_ORBIT_GC / MODE_ORBIT_OBJECT`, `MODE_NAMES`
- `objectTarget` Float64Array(3) defaulting to the Sun, `objectTargetName`, `orbitDistance`
- No `orbitYaw/orbitPitch`: orbit reuses `yaw`/`pitch`, position = target − distance · forward
- `setMode`, `toggleMode`, `setOrbitTarget(x, y, z, name)`, `goHome`, `reset`
- Entering orbit snaps angles to aim at the target so the position is unchanged
- Proof: enter keeps position (< 1 nm), aims at target, distance = |P − T|; leave is continuous

## Task 0.1.1-5: Orbit motion — step()
- File: src/core/camera.js
- Shared: actions → look (yaw/pitch, both modes) → wheel notches → mode branch
- Orbit: A/D yaw ± rate·dt, E/Q pitch ∓ rate·dt, W/S distance ·2^(∓rate·dt), Shift/Ctrl ×4/×¼
- Position along the **f64** basis (`forwardExact`), f32 `forward/right/up` are copies for the GPU
- Velocity zeroed on orbit entry, never integrated in orbit
- Proof: 200 random drags stay on the sphere (< 1e-9 rel) and centred; rates and dt independence;
  momentum does not cross the mode boundary

## Task 0.1.1-6: Home 'H', reset 'R'
- File: src/core/camera.js
- Fly `H`: position = START, yaw = pitch = 0, velocity 0, speedMult kept
- Orbit `H`: mode = ORBIT_OBJECT, target = Sun, distance = 0.01 kpc, viewing direction kept
- `R`: fly at START, speedMult 1, wheel remainder 0, object target back to the Sun
- Proof: both branches, action consumption, R from orbit

## Task 0.1.1-7: Overlay + help
- Files: src/main.js, src/index.html
- Fly line: `camera fly   speed 8 ly/s  (x1)   [Shift x100]`; orbit line: mode, target name, distance
- `formatSpeed` (3 sig. figs), `formatDistance` (kpc / pc), `formatFactor` (Shift / Ctrl / Shift+Ctrl)
- Help: two-column fly / orbit table, the Ctrl+W warning
- Proof: helpers exported and exercised under Node; m1-smoke evaluates main.js as a page script

## Task 0.1.1-8: Camera tests
- File: experiments/camera-test.js → experiments/logs/camera.json
- 31 original checks kept (one threshold retuned to the new base speed) + 73 for 0.1.1
- Run: `python3 scripts/run.py camera`

## Task 0.1.1-9: Wiring proof
- File: experiments/m1-smoke-test.js
- New: every script evaluated in one shared `vm` global scope in `index.html` order — a
  duplicate top-level `const` across classic scripts is a load-time SyntaxError that
  `require()` cannot see; camera.js must find `window.DensityLib`
- `python3 scripts/run.py all-tests` — 11/11
- Manual (needs a WebGPU browser): open `src/index.html`, C cycles, wheel ×2, Shift/Ctrl, H, R

---

## 0.1.2 Tasks (next) — see plan.md §18 for the design

- Task 0.1.2-1: src/data/landmarks.js — 40 stars, RA/Dec/dist → XYZ via the tile-encoder conversion, one API object
- Task 0.1.2-2: src/data/constellations.js — ~15 figures, name pairs resolved to indices at load
- Task 0.1.2-3: landmark block in the star buffer (`FLAG_LANDMARK`) so bright stars render regardless of the catalog
- Task 0.1.2-4: src/core/selection.js — `pick(screenX, screenY)` → nearest landmark within 20 px; click = mouse-up within 4 px of mouse-down
- Task 0.1.2-5: src/render/labels.js — 2D canvas, drawn every frame, culled behind the camera, constant strings only
- Task 0.1.2-6: input (`actions.pick`, `KeyP`), main.js wiring, index.html canvas + scripts
- Task 0.1.2-7: experiments/landmark-test.js + `scripts/run.py` tables

## 0.1.5 Tasks (after)

- Task 0.1.5-1: shaders.js `tonemap` module (ACES fitted or extended Reinhard with white point)
- Task 0.1.5-2: star-sprites.js — linear accumulation into `rgba16float`, resize-safe, tone-map pass
- Task 0.1.5-3: input.js white-point keys (`;` / `'`) + main.js controls + overlay
- Task 0.1.5-4: experiments/hdr-test.js + renderer-test two-pass checks
