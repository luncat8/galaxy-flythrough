# Movement dispatch and CPU/WGSL parity

## Goal

Make the rendered star, its CPU label position, and its pick target agree for
all supported engine masks. This is sandbox-safe correctness work, ahead of the
[deferred browser/visual plan](deferred-browser-visual-plan.md). Do not change
analytical density, bar shape, sampling, or display defaults as part of this task.

The shipping engine uniform is `(mask, apocenterForce, barTilt, apocenterShare)`;
mask bits are classic=1, simple=2, apocenter=4. Older release-plan references to
exclusive IDs 0/1/2 are not the current wire format.

## Contract decisions

1. **Dispatch order and baseline.** Passes run in the canonical order
   classic → simple → apocenter, and each enabled pass *replaces* the position;
   no pass consumes the previous pass's output. Classic runs only when its bit
   is set — it is not an unconditional baseline. When neither classic nor simple
   is set, the baseline is the identity (the birth position). Results per
   nonempty mask: 1 = classic(birth); 2 = simple(birth, θ); 4 = apocenter(birth)
   for the selected subset, birth for the rest (apocenter-only leaves the
   unselected fraction frozen, it is not secret classic); 3 ≡ 2 (simple rebuilds
   from birth + azimuth and masks classic); 5 = classic baseline with the
   selected subset on Kepler ellipses; 6/7 = simple baseline with the selected
   subset on Kepler ellipses. Mask 0 is unreachable (`setEngine` clamps to
   classic). The alternative — apocenter consuming the previous pass's moved
   position — was rejected: it anchors each ellipse to a drifting point and only
   works with a per-frame CPU re-integration for the mirror.
2. **Apocenter input is the immutable birth position.** Both the selection hash
   and the ellipse construction read the record's birth coordinates. A hash of
   moved coordinates would re-roll the guided subset every frame (stars popping
   in and out of the pass), and an ellipse anchored to a moving point feeds back
   into the pass that produced it. The pass still receives the baseline position,
   but only to return it unchanged for unselected stars and at T = 0.
3. **One simple eccentricity rule.** The reconstruction reads the model-derived
   `simpleEccMax = clamp(2·SIMPLE_ECC_K·σthin/vflat, 0, SIMPLE_ECC_MAX)` on both
   sides. The GPU mirrors it from the already-packed `dynA.x` (vFlat) and
   `dynB.x` (sigmaThin) lanes — no uniform growth, no fixed 0.45 in the shader,
   no fixture-tuned constant. CPU landmarks already used this rule; the GPU
   vertex reconstruction adopts it.
4. **Identity, switching, labels and picking.** The apocenter pass is stateless
   (a pure function of birth + uniforms), so engine switches, R-reset and
   regeneration never re-seed it. The simple lane *carries* on a switch (R4):
   `renderer.setEngine(id, starTimeMyr)` walks the resident records under the
   outgoing mask and uploads `orbit.simpleCarry` of each drawn position — the
   azimuth (0.7.8), the radial scale and the normal offset (0.7.10) — so the
   integrator resumes the sky exactly as drawn, not merely the same angles. The
   re-seed remains only for the fresh-field moments (boot, regenerate, R); a
   switch with no clock given carries the birth frame *plus* the scale that puts
   the reconstruction's own eccentric radius on the birth circle, which is the
   positional identity at T = 0.
   Labels and picking share one dispatch
   (`orbit.engineLandmarkPosition`), mirroring the GPU order exactly: simple
   mirror when its bit is set (and ready), else classic when its bit is set,
   else birth; then apocenter(birth) for the selected subset at T ≠ 0.
   Selection hashes the f32 bits of the birth position on both sides — landmark
   positions and star-buffer records are baked from the same values, so the bits
   agree. Classic-only behavior is unchanged.

Isolated engine laws and composition/dispatch need separate checks: passing one
does not prove the other. A visual comparison is not required to establish
numerical parity.

## Ordered work

- [x] **P1 — Reproduce and isolate.** `npm ci`, `python3 scripts/run.py all-tests`
  and `python3 scripts/run.py wgsl-exec`. Result: all-tests green, wgsl-exec
  100/104. The four failures split into stale fixtures (§2e/§2f write the old
  exclusive IDs 1/2 into the mask lane and leave share 0) and real contract
  disagreements (GPU evaluates classic first and feeds the moved position into
  apocenter, while the CPU short-circuits to apocenter on birth coordinates;
  GPU simple reconstruction hardcodes eccMax 0.45 vs the model-derived CPU rule;
  `packEngineVec` fills barTilt only for the exact mask 4; labels/picks have no
  combined-mask dispatch).
- [x] **P2 — Specify and implement the shared dispatch.** Resolve the decisions
  above; align WGSL, CPU label/selection paths and engine packing. Preserve
  classic-script APIs, file:// operation, buffer contracts and allocation-free
  frame paths.
- [x] **P3 — Repair and extend regressions.** Use `packEngineVec` and exported
  engine constants instead of manually writing old IDs. Exercise share 0 and 1
  plus deterministic intermediate selection, force 0/nonzero, every mask,
  T=0/nonzero, and nonzero model centres. Compare full XYZ, with non-vacuity
  checks that prove the intended pass ran. Cover labels/picking as well as the
  isolated math helpers.
- [x] **P4 — Validate.** All-tests and CPU WGSL execution must pass without
  deleting tests, widening existing tolerances, or relabeling runtime
  differences as harness limitations. Add any new experiment to
  `scripts/run.py`; retain concise evidence in `experiments/logs/` and the
  0.4.x worklog. Result: all-tests green, wgsl-exec 115/115 (was 100/104);
  no tests deleted, no tolerances widened.

Time-box initial investigation to a short focused session. If choosing the
dispatch would materially change the visible movement, present the concrete
alternatives before implementing; do not expand into bar tuning or a new engine.
The apocenter pass becomes birth-anchored under combined masks (it previously
read the GPU's classic-moved position); classic-only and simple-only rendering
is bit-identical to before. The numerical follow-up this plan called for —
time-averaged radial/vertical/arm-density measurement for the experimental
engines — landed 2026-10-13 as `experiments/movement-density-test.js`
(plan.md follow-up order item 2/2a): the radial profile, the truncation and the
capture-lane arm pattern hold, and 0.4.9 (`archive/0.4.9-plan-vertical-column.md`)
closed the 2a contract by carrying birth height for disc/pattern stars.
