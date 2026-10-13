# Next session prompt — galaxy fly-through (0.5 series complete)

Paste this as the opening message of the next session.

---

Continue development of the galaxy fly-through engine in `/home/user/galaxy-flythrough`
(AGENTS.md conventions: single tab indent, no per-frame allocations, classic script tags,
plan-first, worklog + plan + findings updates with each step).

**Shipped this session (0.5.5 + the series' docs):**

- 0.5.5 — new file `src/core/route.js` (`RouteLib`, loaded in `index.html` after
  `core/search.js`, hence after `math/deltav.js` and `math/orbit.js` which it requires):
  the §8.0 leg chain (ascent → synodic wait → transfer → descent, layover, return; one
  preallocated timeline of 16 legs), `buildRoute(out, near, far, from, to, shipName, budget,
  tSysYr)`, the §8.4 synodic wait (shortest path to the window — the signed relative angular
  rate decides the direction), the §8.3 interstellar cruise, two-way totals, `routeStatus`
  and `routePosition` (Kepler ellipse via `orbit.js`'s solver, the brachistochrone chord,
  the Cartesian blend of the two).
- 0.5.5-3/-4 — `system-layer.js` gained `setRoute` / `setRouteEndpoints` / `pickNode` /
  `timeYr`: the dashed polyline and class-coloured ship triangle over the schematic, the
  endpoint rings on §7.5's graph and the click test against its node positions. main.js owns
  the alternating endpoint state machine, `rebuildRoute` (on a state change and at the
  readout's 4 Hz cadence while the system clock moves), `routeBlock`, the `Autopilot` /
  `Clear route` menu buttons, the `K` action in `input.js`, `#help`, and the far-system
  derivation (`deriveSystemInto`, `generateFarSystem`) a two-star route needs.
- Tests: new `experiments/route-test.js` (56 checks, registered in `scripts/run.py` as
  `route`), `experiments/system-layer-test.js` extended to 58 checks (route drawing,
  `pickNode`, endpoint rings), `experiments/preset-test.js` 30/30 (routes transient but
  wired), `experiments/input-test.js` 18/18 (K is a one-shot), `dv-map-test.js` 46/46,
  `m1-smoke` 61/61 (route.js loaded once, after orbit.js). `python3 scripts/run.py
  all-tests` → ALL TESTS PASSED, with the timing/date churn reverted so only the five
  logs carrying new checks (`route`, `system-layer`, `preset`, `input`, `m1-smoke`) are
  modified — keep that convention when you rerun.
- Docs: `0.5.0-plan-planet-generator.md` (§8 rewritten in place with the ship list, the
  endpoint/chain model, endpoint picking, autopilot and rebuild cadence; §9.1/§9.2/§9.3/§9.4;
  §10; §11 task table; five new §11.1 deviations incl. the §8.6 economy cut), `plan.md` §11
  tree + §19 + follow-up order, `worklog.md` + `archive/0.5.x-worklog.md` entry, `AGENTS.md`
  file lines, `README.md` capabilities + controls + architecture, `findings-pitfalls-skills.md`
  one 2026-10-13 entry, `deferred-browser-visual-plan.md` V8 row.

**Still open (nothing is blocked):**

1. **The 0.5 browser pass** — `deferred-browser-visual-plan.md` **V8** (routes and
   autopilot) is the freshest row, then V1–V4; the CPU tests pin the chain, the wait law, the
   cruise table, `routePosition` and the ship's position, not whether any of it reads.
2. **Movement dispatch and CPU/WGSL parity** — `movement-parity-plan.md`, the first item of
   plan.md's follow-up order; it and the browser pass are independent.
3. **0.5.2-1 remand** — `src/math/planets.js` lacks the README §2.3 channel map.

**Known follow-ups / caveats:**

- `routePosition`'s blend is a Cartesian interpolation (plan §8.5 as written); §8.5 also
  describes a wait holding at the departure body's phase, and the layover holds at the
  arrival body — both are per-frame redraws, no dirty flag, which is the point.
- `#sysread`'s route block was eyeballed against a hand-built record for column alignment;
  no automated pin of the report text exists (same caveat the dv block carries).
- Browser-side checks (endpoint rings, the ship through a wait/transfer/layover, `K`'s
  handover to the system clock, interstellar text) are deferred in V8 — not verified.

**State:** all of the above is in the working tree, uncommitted (the user was not asked
for a commit). `git status` shows the new files (`src/core/route.js`,
`experiments/route-test.js`, `experiments/logs/route.json`) and the modified files
(`src/main.js`, `src/render/system-layer.js`, `src/core/input.js`, `src/index.html`,
`scripts/run.py`, the four tests, the five logs, and the seven docs).

**First actions:** read AGENTS.md + `plan.md` §11/§19 and `0.5.0-plan-planet-generator.md`
§11, then pick up V8 (browser pass) or `movement-parity-plan.md`.
