# Galaxy-shape + star-distribution findings & cross-project plan

## What was read

- **Current repo** (`galaxy-flythrough` at `/home/user/galaxy-flythrough`):
  - `src/main.js`, `src/index.html`, `src/math/galaxy.js`, `src/math/star-types.js`,
    `src/math/orbit.js`, `src/math/density.js`, `findings-pitfalls-skills.md`, `plan.md`.
- **Linked repo** (`luncat8/galaxy-star-movement-demo` cloned to `/tmp/star-demo`):
  - Main physics: `galaxy.js`, `index.html`.
  - Archive teaching files: `archive/simple-friction-field-webGL.html`,
    `archive/simple-friction-field-js.html`, `archive/simple-friction-field-draft.md`,
    `archive/0.4.2-worklog.md`.

## 1. Useful finding from the linked repo — “slow-field damping”

`archive/simple-friction-field-draft.md` states the idea explicitly:

> “math location of spiral arms. less distance to this location - less particle speed. we can precalculate this dumping low-speed field. (for debug draw slow-field with toggle button). this simple way to emulate Density waves”

Both `archive/simple-friction-field-js.html` and `archive/simple-friction-field-webGL.html` implement it the same way (CPU physics, GPU sprites):

```js
const D = Math.exp(-(delta_theta * delta_theta) / sigma_sq2);
const omega = omega_base_arr[i] * (1 - damping_strength * D);
```

- A Gaussian `D` (strength 0 .. 1) is computed from the star’s angular distance to the nearest spiral arm (`delta_theta`).
- Inside the arm (`D` high) the star’s angular speed is reduced; outside (`D` ~ 0) it rotates at the normal disc rate.
- The result is a **traffic jam** — stars pile up near the crest, disperse past it — producing visible spiral arms without any change to the gravitational potential.

The linked repo also documents the negative result of a related idea: the “live m=2 (S5)” feedback loop (`archive/0.4.2-worklog.md` and `galaxy.js` `updateLive`) measures the disk’s own `m=2` moment and feeds it back as a WKB term. It was found to strengthen inner arms by ~10 % but **cannot hold arms past R ≈ 4** (shot-noise dominates the outer disk), so it stays an experiment (`gfb` slider, default 0). That is a useful caution: adding dynamics does not automatically fix outer-disc shape.

## 2. Can the current project improve galaxy shape without losing star distribution?

**Yes — without touching the procedural sampler.**

The current engine separates **shape** (the density field in `src/math/density.js`) from **star properties** (population clock, IMF, spectral class, colour in `src/math/star-types.js`) and from **motion** (`src/math/orbit.js`, group kinematics). The procedural generator (`deriveStar`) reads the static density model; the renderer moves stars with the closed-form orbits. Because the sampler does not depend on velocity, adding a velocity-modulation layer to the orbit law changes the **rendered motion** and the **visual density response** (traffic jams) while preserving the exact star counts, ages, colours and positions produced by `deriveStar`.

### Specific improvement: optional “wave-damping” mode in the orbit dynamics

What to add (drawn from `archive/simple-friction-field-js.html`):

- A `dampingStrength` slider (0 .. 1, default 0) in the UI (`src/index.html` / `main.js`), similar to the linked repo’s `#damp` control.
- In `orbit.js`, when computing `omegaFrom()` for `FAMILY_DISC` and `FAMILY_PATTERN`, read `distToArm` (already produced by `density.armRidgeWidth()` / `potential()` and carried through `star-types.js` `deriveStar`). If damping is on:

```js
function omegaFrom(dyn, family, r, distToArm, damping) {
    // ... existing group-rate logic ...
    if (damping > 0 && (family === FAMILY_DISC || family === FAMILY_PATTERN)) {
        const sigma = density.armRidgeWidth(model, r);  // per-star width
        const D = Math.exp(-0.5 * (distToArm * distToArm) / (sigma * sigma));
        omega *= (1 - damping * D);
    }
    return omega;
}
```

- The shader mirror (`render/shaders.js`) receives the same scalar through the existing uniform packing (`packOrbitDynamics` / `fillDynamics`) rather than a new hard-coded constant, following the current repo’s `DENSITY_PARAMS_LAYOUT` contract (`findings-pitfalls-skills.md`: “no galaxy constants in WGSL”).

Why this improves shape:
- Stars near the arm crest physically slow, creating natural bunching (higher local density) that makes the arm read as a **streaming feature**, not just a static colour modulation.
- Outside the arm the speed is unmodified, so the outer disc keeps its honest shear (`archive/0.4.2-worklog.md`: “the outer disk shears away over ~30–70 tu”).
- The procedural star count (`N_DISK` / budget) is untouched; only the angular rate in the orbit function changes.

Why it does not break distribution:
- `deriveStar()` uses `model.populations.gasRich`, `formQ`, `sampleFormationTime()`, `evolveStar()` — none of which call `omegaFrom()`.
- The density sampler (`sampling.js`) weights by the static `density.componentMasses()`; damping is a post-sample motion modifier.

### Plan to implement (step-by-step)

1. **Read** `archive/simple-friction-field-js.html` lines 350–390 (`D`, `omega` reduction, `sigma_sq2` definition) and copy the Gaussian-damping formula into a scratch script (`experiments/damping-test.js`).
2. **Modify** `src/math/orbit.js`:
   - Add `damping` parameter to `omegaFrom()` and `omegaFor()` (defaults to 0).
   - Use `distToArm` (passed through `fillDynamics` / the scratch dynamics object, or read from a new `distToArm` argument) to compute `D` for disc/pattern families.
3. **Mirror** in WGSL (`src/render/shaders.js`): add `damping` to the packed dynamics or as a separate uniform scalar, validated by `experiments/wgsl-validate.js`.
4. **UI** (`src/index.html` / `main.js`): add a slider labelled “Wave damping” (or “Slow field”), range 0–0.90, value 0, wired to `orbitScratch` or passed through the renderer’s dynamics uniform.
5. **Test**:
   - Numeric parity: `experiments/orbit-test.js` verifies that with `damping = 0` the output is bit-identical to the current `omegaFrom()`; with `damping > 0` the reduction matches the JS reference (`D` computed with the same `sigma_sq2`).
   - Visual: `experiments/visualize-data.js` (or a new `damping-viz.js`) renders the arm density with and without damping; expect the damped version to show tighter crest lines and faster dispersion outside.

## 3. Recommendation for `galaxy-star-movement-demo` from the current project

The linked repo (`luncat8/galaxy-star-movement-demo`) uses a single authored preset (`MILKY_WAY_STRUCTURE`) and uniform random star colours. The current `galaxy-flythrough` has three things that would directly improve it:

### A. Multi-type galaxy model (`src/math/galaxy.js`)

The current repo carries flat anchor tables for `B_T`, `SERSIC_N`, `PITCH_DEG`, `ARM_AMP`, `ARM_M`, `GAS_FRACTION`, `TAU_SFH`, `H_OVER_L`, `GRADIENT_STEEP`, `BAR_BOXINESS`, etc. (`ANCHORS` object, `TYPE_SPECS`). The linked repo’s `galaxy.js` hard-codes one preset; adopting `TYPE_SPECS` (or a subset: `S0`, `Sa`, `Sb`, `Sc`, `Sd`, `Irr`) lets the physics engine (`symplectic leapfrog`) run on different shapes without rewriting the potential formulas — the potential is already parameterised (`profile`, `a`, `b`, `c`, `ab`, `om`, etc.).

Key insight from findings: the preset (`MILKY_WAY`) is preserved verbatim (`MILKY_WAY_STRUCTURE`); the table builds everything else. That preserves the linked repo’s existing “calm spiral-only” default while adding variety.

### B. Physically grounded star population (`src/math/star-types.js`)

The linked repo draws stars with fixed `brightness_arr[i] = 0.4 + 0.6 * Math.random()` and uniform colour sprites (`spriteDisk`, `spriteArm`, `spriteBulge`). The current `deriveStar()` pipeline:

- Samples IMF (`Salpeter`, `sampleMassIMF`).
- Draws formation time inside the component window (`FORMATION_WINDOW` / `formQ`) from the galaxy’s own SFH (`sfhCumulative`, `sfhProgress`).
- Evolves to spectral class (`O` through `M` + `WD`/`RG`), colour index, and absolute magnitude (`absoluteMagnitude`).
- Clamps young stars (`YOUNG_ARM_MAX_GYR`) to the arm region when `gasRich` is true.

Integrating this into the linked repo’s `init()` (instead of random brightness) gives the linked repo the same realistic colour pattern the current engine uses: blue `O/B/A` near arms, red `K/M` in the old disc, bright bulge stars. Because the linked repo uses Canvas2D/WebGL2 (not procedural GPU generation), `deriveStarProps()` (the non-render-loop wrapper) is the right entry point.

### C. Group kinematics for bar and stream (`src/math/orbit.js`)

The linked repo’s `step()` applies a uniform potential acceleration to every star (`accelSingle()`). The current `orbit.js` shows how to split the population into families (`FAMILY_PATTERN`, `FAMILY_DISC`, `FAMILY_BAR`, `FAMILY_PRESSURE`) and give each a group speed derived from the model’s rotation curve (`omegaFrom()`), with loop fractions (`BAR_LOOP_FRACTION`) and stream rates (`omegaStream()`). The linked repo’s `galaxy.js` already has `omegaPattern` (`P.spiral.om`, `P.bar.om`); wiring it through `omegaFrom()` (with the current `fillDynamics()` / `packOrbitDynamics()` pattern) replaces the uniform rotation with radius-dependent stream rates, making the bar’s internal stream visible (the “x1 loop”) without changing the symplectic integrator (`step()` remains the same leapfrog, only `vx[i]` / `vy[i]` are updated with the group-rate terms).

### D. Findings to adopt directly (`findings-pitfalls-skills.md`)

- **Phase convention audit** (`archive/0.4.2-worklog.md`): the linked repo discovered that the seed must align with the potential **well** (`alignPhase = Math.PI / 2`), not the hill. The current `galaxy.js` already uses this (`P.alignPhase = Math.PI / 2`), confirming the convention is sound and transferable.
- **No hard-coded shader constants** (`findings-pitfalls-skills.md` 2026-09-22): the linked repo’s `galaxy.js` hard-codes `V0 = 1.8`, `SIGMA_SQ2 = 0.125`, etc. in `galaxy.js` and the shader text (`VS_DISK`). The current repo’s `DENSITY_PARAMS_LAYOUT` / `packDensityParams()` / `fillDynamics()` contract solves this; the linked repo should adopt the same “one layout list, CPU packs, shader reads” rule.
- **Measure before changing** (`findings-pitfalls-skills.md` 2026-09-21): the linked repo added the live `gfb` slider after measuring that it only lifts the inner disc by ~10 % (`archive/0.4.0-worklog.md`). The current repo should keep the “measure, then toggle” discipline when adding the damping slider.

## 4. Cross-referencing the files

| Concept | Current repo file | Linked repo file | What transfers |
|---|---|---|---|
| Density-wave damping | `src/math/density.js` (potential wave) + proposed `orbit.js` change | `archive/simple-friction-field-js.html` (`omega *= 1 - damping*D`) | Add optional `omega` reduction to current `orbit.js` |
| Spiral arm phase / seed alignment | `src/math/galaxy.js` (`alignPhase`, `alignSplit`) | `archive/0.4.2-worklog.md` (`alignPhase = π/2`, well-aligned seed) | Confirm convention; keep well-alignment |
| Multi-component potential | `src/math/density.js` (disc, thick, bulge, halo, bar) | `galaxy.js` (`potential()` with `thin`, `thick`, `bulge`, `halo`, `bar`) | Adopt current `TYPE_SPECS` into linked preset |
| Star population / colour | `src/math/star-types.js` (`deriveStar`) | `archive/simple-friction-field-js.html` (uniform colour sprites) | Replace random colour with `deriveStarProps()` |
| Orbit dynamics / group speed | `src/math/orbit.js` (`FAMILY_*`, `omegaFrom`, `loopRatio`) | `galaxy.js` (`step()` with `accelSingle`) | Use current family speeds for disc/bar/pattern |
| Live m=2 feedback (negative result) | `plan.md` / `findings-pitfalls-skills.md` (S5, `gfb` stays 0) | `archive/0.4.0-worklog.md`, `archive/0.4.2-worklog.md` (same result) | Keep slider as experiment; do not make default |
| Teaching friction / drag | Not present (no friction mode) | `archive/simple-friction-field-draft.md`, `galaxy.js` (`applyDrag`) | Optional demo toggle (`btn-drag`) in current UI |

## 5. Bottom-line recommendation

**For `galaxy-flythrough` (current):** add the optional “slow-field damping” to `orbit.js` (plan above, §2). It costs one scalar uniform (`damping`) and one Gaussian per disc star per frame (`distToArm` is already available), improves the visual shape of arms (traffic-jam streaming), and preserves the procedural star distribution because the sampler (`deriveStar`) is unchanged.

**For `galaxy-star-movement-demo` (linked):** adopt the current repo’s `TYPE_SPECS` / `galaxy.js` model diversity (`§3.A`), the `deriveStar` colour pipeline (`§3.B`), and the `orbit.js` group-kinematics contract (`§3.C`). The linked repo’s physics engine (`symplectic leapfrog`, `potential()`) is sound; what it lacks is the parameterised shape model and physically grounded star population that the current engine provides. The “damping” feature can also be ported back: once the current engine has it, the linked repo can use the same `omega *= (1 - damping*D)` formula in its `step()` loop.
