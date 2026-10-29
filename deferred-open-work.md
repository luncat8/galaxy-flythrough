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
| **E6 — chemical evolution (low priority)** | `evolution-plan.md` §Later milestones, optional | The gas grid already carries a `Z` slot per cell (`src/math/gas-grid.js`, `GAS_SLOTS = 4`) and the fill writes a centre→edge gradient into it, but **no birth tier reads it** — the source comment says so. Making it real means stellar yields into the grid and the population tier's colour law reading metallicity from the epoch instead of one authored gradient. Baseline measured by `experiments/chemical-baseline.js`; Low priority: current interest is stellar nuclear evolution, not galactic chemical enrichment. A yield and birth-inheritance design still comes before any implementation. |
| **Apocenter visual density calibration** | `archive/0.4.7-draft-new-star-movement-type.md` | The engine is implemented and its mask composes; what was never done is calibrating its visible density against the field. Needs a browser frame to say anything. |
| **Bar polish** (dimpled X-shape / barlens) | `deferred-browser-visual-plan.md` V5 | Explicitly a separate model feature, not a cosmetic fix. V5 says: isolate a reproducible defect first, tune second. |

## Trade

| Item | Owner | Why it waits |
|---|---|---|
| **The network's rewind after a sky gate closes** | `archive/trade.x-worklog.md` (trade.24) | A port hidden by the sky gate keeps its stocks and its ships, and its world clocks are stamped so the hidden window is never repaid — but a hull that was already *flying* to a hidden destination still lands, because the queue belongs to the network. Whether a hidden pair should also refuse to launch is a design question (pause vs. persist) that trade.24 answered on the "persist" side and did not open further. |
| **T7 / F6 — capital at event boundaries** | `trade-3-plan.md` §9 | Capital inside the settle ODE double-counts against the event tiers. Returns with F6. |

## Interface

| Item | Owner | Why it waits |
|---|---|---|
| **The V14 formation rows** | `deferred-browser-visual-plan.md` §V14 | The **Formation checks** panel (`src/core/scenarios.js`) is the instrument and it is pressable; the verdict is a human looking at a real GPU. V14a's Sun-sky half closed in `0.7.8`; the procedural overview frames want one more `webgpu-smoke.html?run=all` run. |
| **V13c — the two-tier system picture** | `deferred-browser-visual-plan.md` §Trade overlay | World markers, the flow dashes and the trade card are drawn and tested; only the browser check is open. |
| **Constellations from a saved observer** | [`deferred-constellations-plan.md`](deferred-constellations-plan.md) | User reports the current feature does not work as expected. Reproduce, redesign the dedicated panel and fix the observer sky later; Node tests do not establish a visual verdict. |
| **The trade network's frame: colonies are drawn walking across the galaxy** | `trade-plan.md` §9.9, `archive/trade.x-worklog.md` trade.30 | trade.30 closed the *reported* half with a reach law instead of a frame change: a pair drawn past the 3 000 ly freight cap and a world past 600 ly of every port are reported out of reach and take no voyage, while voyages already under way finish on their bookings. What is left is the picture's own stability — at 1 Myr/s the map still winds up, the rings still leave their stars, and the rows say so. The three structural remedies remain open and unchosen: co-rotate the display frame (architectural), slow/park the star clock while the network is live (cheap), or draw the trade layer in its own birth frame (a stable map whose rings leave their stars). |
| **First colony and Earth-like search in the browser** | `deferred-browser-visual-plan.md` V16 | Confirm the empty-network top row (Search for a home / Establish here), the reason line's four states, the first capital arriving seconds after ~1.5 Gyr, and the sky refusal on an unformed star, on a real WebGPU browser; model tests are not a visual verdict. |
| **The intra fleet's picture** | `deferred-browser-visual-plan.md` §V15, [`trade-4-plan.md`](trade-4-plan.md) | The hulls are drawn on the schematic by the network's clock and read out as `fleet`; the model and the online/offline contract are pinned in Node (`trade` §30). Whether a hull *reads* as a hull at 1280×800 next to the T5 dashes is a browser verdict. |

## Closed since this index was written

- **Exact continuity on an engine switch** (0.7.10) — the row that stood here
  said the radial scale was reconstructed rather than carried and that exact
  continuity needed a lane. It shipped: `(radial scale, normal offset)` per slot
  on binding 5, a switch now lands every star on the drawn position within 7 mm
  at every rung of the audit ladder, and at `T = 0` — where the two laws are the
  same field — it moves nothing at all. `experiments/engine-switch-test.js`
  reports both lanes, so the removed residual stays on the record.

## What is not deferred, only unfinished

Nothing. The formation series (0.7.0–0.7.9), the catalog evolution rows, the
0.5 planet series and the workspace split are all closed on their own terms —
with the standing caveat that "closed" means the suites pass and, where a
real-GPU row existed, the evidence is in `experiments/logs/`.
