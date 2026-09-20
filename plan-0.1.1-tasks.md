# 0.1.1 Implementation Tasks — Checklist

Derived from archive/0.1.1-plan.md. Each task is small, testable, and file-scoped.

## Task 0.1.1-1: Input — slow, home, camera mode actions
- File: src/core/input.js
- Add keys.slow (CtrlLeft/CtrlRight), actions.home (KeyH), actions.cameraMode (KeyC)
- Keep existing actions.exposure, reset
- No allocs, consume in camera.js
- Test: extend camera-test.js input consumption checks

## Task 0.1.1-2: Camera constants — LY units
- File: src/core/camera.js
- Add LY_TO_KPC = 0.000306601, BASE_SPEED = 8 * LY_TO_KPC
- SPEED_MULT_MIN=0.02, MAX=200, BOOST=100, SLOW=0.1
- ORBIT_DISTANCE_MIN=0.0001, MAX=100
- Update getState to expose speedLyPerSec = speedKpcPerSec / LY_TO_KPC
- Test: speed conversion, min/max clamps

## Task 0.1.1-3: Wheel discrete x2
- File: src/core/camera.js
- Replace exponential wheel with discrete steps: steps = round(wheelDelta/100), speedMult *= 2^(-steps) in FLY, distance *= 2^(-steps) in ORBIT
- Clamp speedMult, distance
- Test: wheelDelta 100 => speedMult*0.5, -100 => *2

## Task 0.1.1-4: Orbit state
- File: src/core/camera.js
- Add MODE_FLY=0, MODE_ORBIT_GC=1, MODE_ORBIT_OBJ=2
- Add orbitTarget Float64Array(3), orbitDistance, orbitYaw, orbitPitch
- Add setOrbitTarget(x,y,z), getOrbitTarget(out), setMode(mode), toggleMode(), goHome()
- Preallocate orbitTarget, no per-frame alloc
- Test: after toggle to GC, target = (8.178,0,0), distance = |pos-target|

## Task 0.1.1-5: Orbit math — step()
- File: src/core/camera.js
- Branch step() by mode:
  - FLY: existing velocity tau integration
  - ORBIT: lookDx/Dy => yaw/pitch, W/S or wheel => distance, A/D => yaw, Q/E => pitch
  - Compute pos = target + spherical(distance, yaw, pitch)
  - forward = normalize(target-pos), right/up from forward x worldUp
  - Zero velocity on mode enter
- Keep updateBasis, updateCameraPos
- Test: orbit position lies on sphere radius=distance, forward points to target, dt independence

## Task 0.1.1-6: Home 'h'
- File: src/core/camera.js + input.js
- goHome(): FLY => pos=Sun (0,0,0.005), vel=0, yaw=0 pitch=0, mode=FLY; ORBIT => target=Sun, distance=0.01 kpc
- Input: KeyH => actions.home=1, consumed in camera.step
- Keep KeyR as reset alias
- Test: home in fly resets pos, home in orbit sets target Sun

## Task 0.1.1-7: Overlay + help
- File: src/main.js, src/index.html, src/style.css (if needed)
- Overlay: print mode string, speed ly/s, orbit target name/distance when in orbit
- Help: update text: C camera mode, H home, Shift 100x, Ctrl 0.1x, wheel x2 speed/dist
- No per-frame string alloc? Keep 4 Hz rebuild already.

## Task 0.1.1-8: Camera tests extended
- File: experiments/camera-test.js
- Add ~20 checks: mode cycle, orbit sphere, distance clamp, wheel discrete, boost 100x, slow 0.1x, both 10x, home fly, home orbit, setOrbitTarget, forward to target, no alloc still
- Log: experiments/logs/camera.json
- Run: python3 scripts/run.py camera

## Task 0.1.1-9: All-tests green
- Run python3 scripts/run.py all-tests
- Ensure 11/11 still pass
- Manual file:// test: open src/index.html, verify C, H, wheel, Shift, Ctrl

---

## 0.1.2 Tasks (next)

- Task 0.1.2-1: src/data/landmarks.js — 40 stars, XYZ from RA/Dec/dist, use tile-encoder conversion, one API object
- Task 0.1.2-2: src/data/constellations.js — 15 constellations, lines as index pairs
- Task 0.1.2-3: src/core/selection.js — pick() screen->landmark, selected state
- Task 0.1.2-4: src/render/labels.js — 2D canvas overlay, project, draw names + lines at 4 Hz
- Task 0.1.2-5: Wire in main.js + input.js (click, P toggle) + index.html canvas
- Task 0.1.2-6: experiments/landmark-test.js + update scripts/run.py

## 0.1.5 Tasks (after)

- Task 0.1.5-1: shaders.js tonemap shader (ACES)
- Task 0.1.5-2: star-sprites.js HDR intermediate texture + two-pass
- Task 0.1.5-3: input.js HDR actions + main.js controls
- Task 0.1.5-4: experiments/hdr-test.js
