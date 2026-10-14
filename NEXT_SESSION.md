# Next session prompt — galaxy fly-through (0.4.9 shipped: the vertical column)

Paste this as the opening message of the next session.

---

Continue development of the galaxy fly-through engine in `/home/user/galaxy-flythrough`
(AGENTS.md conventions: single tab indent, no per-frame allocations, classic script tags,
plan-first, worklog + plan + findings updates with each step).

**Shipped this session (0.4.9, model + tests + docs):**

- **plan.md follow-up order item 2a is closed** — the vertical-preservation contract
  (0.4.0 §1.4's deferred amplitude-calibration pass), planned in
  `archive/0.4.9-plan-vertical-column.md` before any code was touched.
- The mechanism, measured first (0.4.x worklog + `experiments/logs/movement-density.json`):
  every engine swept a per-star orbital plane *through the galaxy centre*, which put
  `(qz/|q|)·cos α` into a star's height — a birth height decays with the orbit, so the
  time-averaged column came out at **mean|z| 0.66–0.87** of the field's and worst log-bin
  **0.038–0.049** against the 0.03 budget. The diagnostic that named it: the column was
  *compressed*, never heated, so no amplitude retune could fix it.
- The fix is one anchor decision, extracted into `orbit.orbitPlane` (CPU) and
  `fn orbitPlane` (WGSL, `OrbitPlane` struct): **disc/pattern stars sweep a plane parallel
  to the galactic plane through their own birth height** (the height is carried; the
  epicycle's bounded `av` wobble is the only vertical motion), **bar/pressure keep the
  centred inclined plane** the per-star basis was introduced for. `ORBIT_INCLINATION_DISC`
  is gone. All four CPU call sites and all three WGSL call sites are now call sites, not
  copies.
- The guided ellipse's semi-major axis now reads `pl.anchor`, so it passes through the
  birth point again (it was 0.6 pc off) and force 0 conserves the birth radius.
- Measured after, same run/state: vertical worst bin **0.000–0.009** (budget 0.03), mean|z|
  **1.000** on the lanes that carry exactly and 1.025–1.076 where the classic wobble runs;
  radial (0.002–0.011), arm ratios, meanR and the truncation gates unchanged.
- Pins: `orbit-test` 115/115 (two checks re-stated to the new law — cylinder/height for a
  disc star, spherical radius for a spheroidal one), `movement-density` 98/98 (the vertical
  column is now gated on §1.4's budget, not pinned as a known deviation), `wgsl-exec`
  118/118 (new 2i section: its orbit fixtures all sat at z = 0, so the shader had never
  executed the carry branch), `all-tests` → ALL TESTS PASSED.
- Docs moved with the release: `plan.md` §19 + follow-up 2a, `worklog.md`, the 0.4.x
  worklog entry, `experiments/README.md`, `README.md`'s priorities block, AGENTS.md's
  archive list, `deferred-browser-visual-plan.md`'s V1 row, `findings-pitfalls-skills.md`.

**Still open (nothing is blocked):**

1. **The 0.5/0.4 browser pass** — `deferred-browser-visual-plan.md` **V8** (routes and
   autopilot) is the freshest row, then V1–V4. This environment has no WebGPU-capable
   browser (`which chromium firefox` is empty), so the pass needs the user's machine or a
   machine with a real GPU. The CPU tests pin the numbers, not whether any of it reads;
   V1 now also asks the eye to confirm that the disc no longer warps vertically as it
   turns.
2. **The experimental-engine calibration** — both of plan.md's follow-up items that gate a
   default-engine change are now closed (parity 2026-10-11, the density measurement
   2026-10-13, the vertical contract 2026-10-14), so the guides' arm overshoot (wave 0.6
   holds 1.7–4.3× the authored contrast) and the guided-only arm floor are the next model
   questions, each needing its own plan entry.

**Known follow-ups / caveats:**

- The classic lane's bounded vertical wobble can reach `|z| + 2·av`; the measured over-cut
  share stays 0.0000 on mw/Sa/SBc over 400 Myr, but the wobble cap is the authored
  `discHeight` slab, not the sech² cut — worth a pin if a taller disc ever trips it.
- Browser-side checks (the three engines, labels/picking, the disc's new vertical
  behaviour, V1–V8) are deferred — not verified.
- `experiments/README.md`'s Tests table and the README architecture list move with the
  release; check both against `scripts/run.py` whenever a test or `src/` file ships.
- `scripts/run.py` keeps its entries alphabetised inside each group — a new experiment goes
  in the `EXPERIMENTS` dict, the `TYPES['test']` list, `m1-smoke-test.js`'s namespace list
  and `index.html`, in that order of failure.

**State:** 0.4.9 is implemented, documented and validated, and **uncommitted** —
`src/math/orbit.js`, `src/render/shaders.js`, `experiments/{orbit-test,movement-density-test,wgsl-exec-check}.js`,
the regenerated `experiments/logs/*.json`, and the docs listed above, plus the new
`archive/0.4.9-plan-vertical-column.md`. The user was not asked for a commit.

**First actions:** read AGENTS.md + `plan.md` §19/follow-up order, then either start V8 on a
real browser (record the blocked case and stop if no adapter) or open the engine-calibration
question the closed follow-ups now unblock.
