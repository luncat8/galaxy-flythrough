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
| **The network's rewind after a sky gate closes** | `archive/trade.x-worklog.md` (trade.24) | A port hidden by the sky gate keeps its stocks and its ships, and its world clocks are stamped so the hidden window is never repaid — but a hull that was already *flying* to a hidden destination still lands, because the queue belongs to the network. Whether a hidden pair should also refuse to launch is a design question (pause vs. persist) that trade.24 answered on the "persist" side and did not open further. |
| **T7 / F6 — capital at event boundaries** | `trade-3-plan.md` §9 | Capital inside the settle ODE double-counts against the event tiers. Returns with F6. |

## Interface

| Item | Owner | Why it waits |
|---|---|---|
| **The V14 formation rows** | `deferred-browser-visual-plan.md` §V14 | The **Formation checks** panel (`src/core/scenarios.js`) is the instrument and it is pressable; the verdict is a human looking at a real GPU. V14a's Sun-sky half closed in `0.7.8`; the procedural overview frames want one more `webgpu-smoke.html?run=all` run. |
| **V13c — the two-tier system picture** | `deferred-browser-visual-plan.md` §Trade overlay | World markers, the flow dashes and the trade card are drawn and tested; only the browser check is open. |
| **The sky selector in the browser** | this series, ui.22 / ui.23 | The `sky` selector (off / Milky Way / own), `K` anchoring the own figures to one saved position and the rate gate that suspends both sets are built and unit-tested (`experiments/asterisms-test.js`, `named-sky-test.js`). What no Node test can say is whether the selector's layout holds at 1280×800, whether the figures *read* as constellations, and whether the 2 s auto-update cadence feels like a refresh or a flicker. |
| **The intra fleet's picture** | `deferred-browser-visual-plan.md` §V15, [`trade-4-plan.md`](trade-4-plan.md) | The hulls are drawn on the schematic by the network's clock and read out as `fleet`; the model and the online/offline contract are pinned in Node (`trade` §30). Whether a hull *reads* as a hull at 1280×800 next to the T5 dashes is a browser verdict. |

## What is not deferred, only unfinished

Nothing. The formation series (0.7.0–0.7.9), the catalog evolution rows, the
0.5 planet series and the workspace split are all closed on their own terms —
with the standing caveat that "closed" means the suites pass and, where a
real-GPU row existed, the evidence is in `experiments/logs/`.
