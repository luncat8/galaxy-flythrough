# Deferred open work

An index of what is known-open and deliberately not scheduled, so a later pass
finds it instead of re-discovering it. Every row points at the plan that owns
the design; this file owns nothing but the pointer and the reason it waits.

Two other deferred files are deeper and stay authoritative for their own
subjects — this index does not summarise them, it links them:

- [`deferred-browser-visual-plan.md`](deferred-browser-visual-plan.md) — every
  visual verdict. V1–V14 are browser rows; passing a Node suite never closes one.
- [`deferred-catalog-evolution-plan.md`](deferred-catalog-evolution-plan.md) —
  the catalog's epoch behaviour. **All C1–C9 rows are closed**, including the
  real-GPU evidence in `experiments/logs/0.7.8/`; the file is now a record.

## Model

| Item | Owner | Why it waits |
|---|---|---|
| **E5 — events** (minor mergers, tidal streams, a starburst episode) | `evolution-plan.md` §Later milestones | Was gated on 0.7's record time axis, which has now shipped — so it is *unblocked*, not blocked. It is still the largest open model feature: a new object family on the composite layer plus a re-sampling path, and it must obey 0.7's rule that a clock never re-rolls what is already on screen. Needs its own plan before code. |
| **E6 — chemical evolution** | `evolution-plan.md` §Later milestones, optional | The gas grid already carries a `Z` slot per cell (`src/math/gas-grid.js`, `GAS_SLOTS = 4`) and the fill writes a centre→edge gradient into it, but **no birth tier reads it** — the source comment says so. Making it real means stellar yields into the grid and the population tier's colour law reading metallicity from the epoch instead of one authored gradient. Sandbox-verifiable end to end; the measurement comes first. |
| **Exact radial continuity on an engine switch** | `archive/0.7.x-worklog.md`, the 0.7.8 entry | `classic → simple` carries all three θ states from the drawn sky, which took the worst-star jump from 55.3 kpc to 9.7 kpc. The residual is honest lane difference: the radial scale is *reconstructed*, not carried, so exact continuity needs a radius-scale buffer lane. `experiments/engine-switch-test.js` already measures it, so the before/after is one run. |
| **Apocenter visual density calibration** | `archive/0.4.7-draft-new-star-movement-type.md` | The engine is implemented and its mask composes; what was never done is calibrating its visible density against the field. Needs a browser frame to say anything. |
| **Bar polish** (dimpled X-shape / barlens) | `deferred-browser-visual-plan.md` V5 | Explicitly a separate model feature, not a cosmetic fix. V5 says: isolate a reproducible defect first, tune second. |

## Trade

| Item | Owner | Why it waits |
|---|---|---|
| **The seed map cannot bootstrap itself** | `archive/trade.x-worklog.md` (trade.23) | With the formation gate in place, an evolving run started at first light now correctly arrives with **no** colonies — and stays that way. `expandFrontierFromField` measures its reach from the largest existing colony, so with `portCount === 0` it returns before proposing anything, and the network never founds the first port on its own. The honest fix is a throttled retry in `main.js`'s per-frame trade block that re-runs the seed as the epoch advances, not a change in `trade.js` — but it wants a decision first about whether the first port is *foundable* at all before the named sky exists, and that is a game-design question, not a wiring one. |
| **T6 — a real intra-system fleet** | [`trade-4-plan.md`](trade-4-plan.md) (design), `trade-3-plan.md` §8 (the deferral it answers) | Planned, not built. Hulls inside an opened system, on the schematic's own clock and their own queue, priced by the delta-v graph the map already draws and gated on the hull classes that can actually fly the leg. The online/offline split is the design's centre: simulated when the user is looking, closed-form average when they are not, and the two must agree. |
| **T7 / F6 — capital at event boundaries** | `trade-3-plan.md` §9 | Capital inside the settle ODE double-counts against the event tiers. Returns with F6. |

## Interface

| Item | Owner | Why it waits |
|---|---|---|
| **The V14 formation rows** | `deferred-browser-visual-plan.md` §V14 | The **Formation checks** panel (`src/core/scenarios.js`) is the instrument and it is pressable; the verdict is a human looking at a real GPU. V14a's Sun-sky half closed in `0.7.8`; the procedural overview frames want one more `webgpu-smoke.html?run=all` run. |
| **V13c — the two-tier system picture** | `deferred-browser-visual-plan.md` §Trade overlay | World markers, the flow dashes and the trade card are drawn and tested; only the browser check is open. |
| **The observer's figures in the browser** | this series, ui.22 | `create figures` (K), `my constellations` (Shift+P) and `figures auto-update` are built and unit-tested (`experiments/asterisms-test.js`, `named-sky-test.js`). What no Node test can say is whether the figures *read* as constellations at 1280×800, and whether the 2 s auto-update cadence feels like a refresh or a flicker. |

## What is not deferred, only unfinished

Nothing. The formation series (0.7.0–0.7.9), the catalog evolution rows, the
0.5 planet series and the workspace split are all closed on their own terms —
with the standing caveat that "closed" means the suites pass and, where a
real-GPU row existed, the evidence is in `experiments/logs/`.
