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
  fly to one (`F` — a 2 s eased flight that ends orbiting the star at its luminosity
  stand-off, cancelled by any control input; a moving landmark stays centred), cycle the
  set (`N`), clear it (`X`) — each member snapshotted with its
  stellar properties, so the set survives the streaming rebuild
- Deterministic per-star planetary systems: planets, belts, moons, insolation and
  temperatures, HZ/terran/locked flags, generated lazily on the CPU for the selected star
- Star and planet search with a compact token filter (`G,K|terran|220-300`), scoped to the
  selection or the galaxy, with add-results-to-selection
- Close-system schematic view: `V` opens a log-polar map of the primary selection — HZ
  annulus, orbit ellipses, stippled belts, star and planet icons — with its own
  system-time clock and a full-figures readout
- Copyable settings presets and deterministic URL parameters
- CPU mirrors and model/parity tests for the JavaScript and WGSL implementations

This is a visual galaxy model, not an N-body gravity simulation. The analytical density field is the source of truth; the movement engines aim to preserve its visible structures over time.



## Controls

| Input | Fly camera | Orbit camera |
|---|---|---|
| Mouse | Click to lock, then look | Press and drag the canvas |
| Click without dragging | Select a star (Shift adds to the set) | Select a star (Shift adds to the set) |
| F / N / Shift+N / X | Fly to the primary · next star · previous star · clear the set | same |
| W / S | Forward / backward | Closer / farther |
| A / D | Strafe | Circle target |
| E / Q | Up / down | Over / under target |
| Mouse wheel | Speed ×2 per notch | Distance ×2 per notch |
| Shift / Ctrl | Rate ×100 / ×0.1 | Rate ×4 / ×0.25 |
| C | Cycle fly → galactic centre → selected object | Same |
| H | Return home | Return to the Sun or generated-galaxy centre |
| R | Reset the simulation and view | Same |

Other controls:

- `Tab` — hide/show both panels; a panel's own `▾` (or a click on its title) collapses it to its header
- `G` — cycle galaxy type and rebuild the field
- `P` — toggle constellation lines
- `T` — pause/resume star time
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

## Ships, routes and autopilot (0.5.5, reviewed in 0.5.6)

The system and ship controls live in their own panel on the left (`Tab` toggles
both panels); the galaxy settings stay on the right.

1. Select a star and press **V**, then pick a render in the left panel's **View**
   dropdown: the system schematic, the classic delta-v map, or the delta-v rails
   map (one row per node kind, so the escape and L5 rails run level across the
   bodies). **B** cycles the three.
2. On a delta-v render, click a start node, then a destination node (surface,
   LO, GEO, escape or L5). Escape and L5 are both exits: a route starting or
   ending on either spends only the star-frame burns on that side.
3. Choose a ship and energy budget. **Round trip** adds a return after a
   0.25-year layover; fuel is not replenished. The report compares all five classes.
4. Set **System time** above zero and start autopilot. The clock is a geometric
   ladder (slowest timed stop 1e-4 y/s; 0 freezes). Around 0.1–1 y/s is a useful
   range for watching a transfer; high rates fast-forward and can finish short
   flights between rendered frames. The class-colour ship and dashed trajectory
   ride every leg on the schematic and both delta-v renders, local legs included.
   Start/resume pauses or resumes flight; changing the plan or exiting the view
   cancels it.
5. For interstellar travel, select two stars with Shift-click (or add search results),
   open a system, then use **Selected stars**. It uses the first two selected stars
   and reports parking-orbit escape, cruise and capture in real years. Interstellar
   progress is shown in the report, not projected into a local orbital diagram.

Fuel, acceleration and life support decide feasibility; impossible plans cannot
launch. Routes are transient. Ship class, map toggle and budget survive presets.
The optional trade-price/economy milestone is intentionally omitted.

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

Run the complete test suite:

```bash
python3 scripts/run.py all-tests
```

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
- `core/` — camera, input, loop, selection, and presets
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
