# Next session prompt — galaxy fly-through (0.5 series)

Paste this as the opening message of the next session.

---

Continue development of the galaxy fly-through engine in `/home/user/galaxy-flythrough`
(AGENTS.md conventions: single tab indent, no per-frame allocations, classic script tags,
plan-first, worklog + plan + findings updates with each step).

**Shipped this session (0.5.3-5 + 0.5.4):**

- 0.5.3-5 — the readout's per-planet and belt rows (`main.js` `planetLine` / `beltLine`,
  `systemLayer.selectedBody()`, `planets.js` exports `BELT_TYPICAL_MASS_KG`).
- 0.5.4 — new file `src/math/deltav.js` (`DeltaVLib`, loaded in `index.html` between
  `math/planets.js` and `math/orbit.js`): §7.1 node table as one-bit flags, §7.2 closed
  forms, `legBetween` / `nodeLegDv` / `nodeLegTimeYr`, §7.4 budget blend (`dvCeilingKms`,
  `dvLegKms`, `blendFactor`, `legTimeS`, `waitScale`) and the §8.1 ship table.
- 0.5.4-4 — §7.5's graph drawn on the `#system` canvas inside `system-layer.js`
  (`setMapOpen`, `layoutMap`, `drawMap`, map constants exported), `B` key via
  `input.js` action `dvmap`, menu rows `dvmap-toggle` / `slider-budget` / `select-ship`,
  and the readout's §7.5 table (`deltaVBlock`, `flightDays`, `feasibility`, `dvColumnTo`,
  `dvName`, `dvShort`, `nodeSlotOf`); preset fields `dvmap` / `budget` / `ship`.
- Tests: new `experiments/dv-map-test.js` (46 checks, registered in `scripts/run.py` as
  `dv-map`), `experiments/system-layer-test.js` extended to 46 checks (map contract
  section), `experiments/preset-test.js` 29/29 (new dv fields + wiring checks).
  `python3 scripts/run.py all-tests` → ALL TESTS PASSED.
- Docs: `0.5.0-plan-planet-generator.md` (§7.2 chain now four terms, §6.6 dv block,
  §7.5 leaning, §9.1/§9.2, §10, §11 task table, six new §11.1 deviations), `plan.md`
  §11 tree + §19 + follow-up order, `worklog.md` + `archive/0.5.x-worklog.md` entry,
  `AGENTS.md` file lines, `findings-pitfalls-skills.md` two 2026-10-13 entries,
  `deferred-browser-visual-plan.md` V7 row.

**Still open in the plan's task table:**

1. **0.5.5 — `src/core/route.js`: ships, routes, autopilot** (plan §8): in-system legs on
   §7's blend, the synodic-wait law (`φ_req`, `S`, `t_wait·(1−s)`), interstellar legs
   (cruise model), two-way totals, autopilot `routePosition`, route report in `#sysread`,
   endpoint picking on the dv graph, `experiments/route-test.js`. The §8.1 ship table is
   already in `deltav.js` — read it from there.
2. **0.5.x-2** — `README.md` capabilities list for the 0.5 series.
3. **0.5.2-1 remand** — `src/math/planets.js` lacks the README §2.3 channel map.

**Known follow-ups / caveats:**

- The `simple` engine's `engineRecordPosition` still approximates star motion (documented
  deviation, `star-select-test.js` pins it) — see `movement-parity-plan.md`.
- `#sysread`'s dv table was eyeballed against generated systems for column alignment only;
  no automated pin of the table text exists.
- Browser-side checks (does the dv graph fit at 1280×800, tooltips, menu gating) are
  deferred in `deferred-browser-visual-plan.md` V7 — not verified.

**First actions:** read AGENTS.md + plan.md §11/§19, then start 0.5.5-1
(`core/route.js` leg model reusing `DeltaVLib`).
