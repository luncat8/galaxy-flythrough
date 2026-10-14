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
- Three selectable movement models:
  - **classic** — closed-form bounded kinematic orbits; currently the most balanced default
  - **simple** — responsive friction-field integration
  - **apocenter** — experimental feature-guided elliptical orbits
- Fly, galactic-centre orbit, and selected-object orbit cameras
- Star selection: pick any drawn star, Shift+click to build a multi-select set, radius
  select by log light-year range, `F` to fly to the primary star with a brightness-scaled
  stand-off, `N` to cycle the primary and `X` to clear — with a live selection readout
- Named-star selection, labels, constellation lines and selection rings
- A deterministic lazy planet-system generator: any drawn star's planetary system is
  derived on demand from its stable identity key — planet count, bulk classes, orbits,
  insolation, equilibrium and surface temperatures, habitable-zone and tidal-locking
  flags, debris belts — reproducible across runs and machines, with a cheap summary tier
  for searching
- Star and planet search over the resident records, by class, state, luminosity, mass,
  component, distance, planet type, temperature and more — over the whole galaxy or the
  current selection
- The close-system schematic entry point: `V` (or the menu's System view button) opens the
  primary selection's system on its own overlay, points the camera at the star and turns
  the readout into that system's
- The delta-v map over that schematic (`B`): a graph of the bodies' own nodes and the
  transfers between them, the closed-form cost of every leg, and the ship class and energy
  budget the travel times are read against
- Routes and the autopilot: pick a start and an end node on the map and the readout shows
  the whole chain — the burns, the synodic wait a low-energy transfer has to sit out, the
  totals and every ship class's verdict on it — with `K` flying a ship along it on the
  system's own clock. Two stars' endpoints build an interstellar route: an accel–coast–decel
  cruise between them, whose length is what makes a crossing of the disc a generation ship's
  errand
- Copyable settings presets and deterministic URL parameters
- CPU mirrors and model/parity tests for the JavaScript and WGSL implementations

This is a visual galaxy model, not an N-body gravity simulation. The analytical density field is the source of truth; the movement engines aim to preserve its visible structures over time.



## Controls

| Input | Fly camera | Orbit camera |
|---|---|---|
| Mouse | Click to lock, then look | Press and drag the canvas |
| Click without dragging | Select a star as the object target | Select a star as the object target |
| W / S | Forward / backward | Closer / farther |
| A / D | Strafe | Circle target |
| E / Q | Up / down | Over / under target |
| Mouse wheel | Speed ×2 per notch | Distance ×2 per notch |
| Shift / Ctrl | Rate ×100 / ×0.1 | Rate ×4 / ×0.25 |
| C | Cycle fly → galactic centre → selected object | Same |
| H | Return home | Return to the Sun or generated-galaxy centre |
| R | Reset the simulation and view | Same |

Other controls:

- `Tab` — toggle settings
- `G` — cycle galaxy type and rebuild the field
- `P` — toggle constellation lines
- `T` — pause/resume star time
- `F` — fly to the primary selected star
- `N` / `Shift+N` — cycle the primary through the selection
- `X` — clear the selection
- `Shift+click` — add or remove one star from the selection
- `V` / `Esc` — open / close the selected star's system
- `B` — delta-v map over the open system
- click in the schematic — select a planet or belt
- click in the delta-v map — pick the route's start node, then its end node
- `K` — autopilot along the route
- `[` / `]` — exposure
- `;` / `'` — overall brightness
- `Esc` — release the pointer in fly mode

The settings panel opens at startup and exposes galaxy type, seed, age, star time, movement engine, pattern controls, tone mapping, and presets.

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
| `stars` | Procedural star budget |
| `catalog` | Catalog star budget; `0` selects procedural-only rendering |
| `engine` | `classic`, `simple`, `apocenter`, or a `+`-joined combination |
| `time` | Stellar time rate in Myr/s |
| `wave` | Pattern-frame capture strength |
| `pattern` | Pattern-speed multiplier |
| `exposure` | Faint-star magnitude threshold |
| `brightness`, `white`, `sat` | Display gain, white point, and saturation |
| `headroom`, `highlight` | HDR ceiling and highlight desaturation |
| `apoShare`, `apoForce` | Apocenter-engine population share and eccentricity force |
| `selrad` | Selection radius in light years |
| `selstars` | Dot-joined base36 selection keys, primary first |

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
python3 scripts/run.py movement-density  # do the engines hold the density field in time
python3 scripts/run.py shape          # 3D component shape and sampler parity
python3 scripts/run.py renderer       # render pipeline contracts
python3 scripts/run.py star-select    # picking, selection set, radius select, fly-to
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
- `math/planets.js` — the lazy planet-system generator: any drawn star's planetary
  system as a pure function of its identity key through one fixed hash channel map
  (plan §2.3 — one draw per channel: the count chain 2+n, each planet 32+8·p, moon
  counts 128+p, the two belts 200 and 210, belt stipples 300+s on the belt's own
  seed), so a system is reproducible across runs and machines
- `math/deltav.js` — closed-form delta-v budgets: the node table, the inter-body
  chain, the energy-budget travel-time blend, and the ship classes it is read against
- `math/orbit.js` — movement engines and CPU mirrors
- `render/shaders.js` — all WGSL shader source
- `render/star-sprites.js` — procedural generation, culling, HDR star passes, and tone mapping
- `render/label-layer.js` and `render/system-layer.js` — the CPU 2D overlays: landmark
  and constellation labels, and the close-system schematic with its delta-v map and route
- `stream/` — catalog bundle loading and cell residency
- `core/` — camera, input, loop, star set + selection, search + routes, and presets
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
