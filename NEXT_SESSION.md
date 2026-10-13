# Next session prompt — galaxy fly-through (0.5 series complete, docs closed)

Paste this as the opening message of the next session.

---

Continue development of the galaxy fly-through engine in `/home/user/galaxy-flythrough`
(AGENTS.md conventions: single tab indent, no per-frame allocations, classic script tags,
plan-first, worklog + plan + findings updates with each step).

**Shipped this session (0.5.x-3, docs only):**

- The **0.5.2-1 remand is closed**. Verified before editing: `src/math/planets.js` has
  carried the whole plan §2.3 channel map since 0.5.1 (`CH_ESCALE` 0, the count chain
  `2+n`, each planet `32+8·p`, moon counts `128+p`, belts 200/210, stipples `300+s` on
  the belt's own seed), and `experiments/planet-gen-test.js` claims the entire map into
  one `Set` and fails on the first duplicate. The gap was the README: its architecture
  list predated the 0.5 series and named none of the new modules.
- `README.md` architecture now lists `math/planets.js` (with the channel map in one
  bullet), `math/deltav.js`, and the two render overlays (`label-layer.js` +
  `system-layer.js`).
- Stale pointers corrected after checking their logs: `plan.md` §19's follow-up order
  marks movement parity **done** (shipped 2026-10-11, P1–P4, `wgsl-exec` 100/104 →
  115/115; browser validation of the engines still deferred at V1/V2), and `worklog.md`'s
  priority block is the browser pass.
- The same drift fixed one directory over: `experiments/README.md`'s Tests table was frozen
  at `galaxy-age-test.js` and now carries all 27 registered tests (`input`, `preset`,
  `star-select`, `search`, `system-layer`, `shape`, `orbit`, `planet-gen`, `dv-map`,
  `route`, …), described from each test's own header. `AGENTS.md` gained a `README.md`
  file line saying both tables move with the release, and the findings entry records the
  verify-both-sides rule.
- Docs: `archive/0.5.x-worklog.md` gained the 0.5.x-3 entry. No runtime change;
  `python3 scripts/run.py all-tests` → ALL TESTS PASSED.

**Still open (nothing is blocked):**

1. **The 0.5 browser pass** — `deferred-browser-visual-plan.md` **V8** (routes and
   autopilot) is the freshest row, then V1–V4. This environment has no WebGPU-capable
   browser (`which chromium firefox` is empty), so the pass needs the user's machine or
   a machine with a real GPU. The CPU tests pin the chain, the wait law, the cruise
   table, `routePosition` and the ship's position, not whether any of it reads.
2. **Numerical movement-density measurements** — plan.md's follow-up item 2, the
   measurement that must precede any experimental-engine calibration or default change
   (time-averaged radial/vertical/arm density, `experiments/` + `logs/`).

**Known follow-ups / caveats:**

- `routePosition`'s blend is a Cartesian interpolation (plan §8.5 as written); §8.5 also
  describes a wait holding at the departure body's phase, and the layover holds at the
  arrival body — both are per-frame redraws, no dirty flag, which is the point.
- `#sysread`'s route block was eyeballed against a hand-built record for column alignment;
  no automated pin of the report text exists (same caveat the dv block carries).
- Browser-side checks (endpoint rings, the ship through a wait/transfer/layover, `K`'s
  handover to the system clock, interstellar text) are deferred in V8 — not verified.
- `experiments/README.md`'s Tests table was frozen at `galaxy-age-test.js` — now filled out
  to all 27 registered tests, so check it against `scripts/run.py` whenever a test ships.
- `scripts/run.py` keeps its entries alphabetised inside each group — a new experiment
  goes in the `EXPERIMENTS` dict, the `TYPES['test']` list, `m1-smoke-test.js`'s
  namespace list and `index.html`, in that order of failure.

**State:** 0.5.x-2 and 0.5.5 are committed; the 0.5.x-3 doc edits are uncommitted
(`README.md`, `experiments/README.md`, `plan.md`, `worklog.md`, `AGENTS.md`,
`archive/0.5.x-worklog.md`, `findings-pitfalls-skills.md`, `NEXT_SESSION.md`).
The user was not asked for a commit.

**First actions:** read AGENTS.md + `plan.md` §11/§19, then either start V8 on a real
browser (record the blocked case and stop if no adapter) or write the movement-density
measurement as an `experiments/` script with its log.
