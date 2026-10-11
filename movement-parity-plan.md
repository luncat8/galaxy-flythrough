# Next correctness task: movement dispatch and CPU/WGSL parity

## Goal

Make the rendered star, its CPU label position, and its pick target agree for
all supported engine masks. This is sandbox-safe correctness work, ahead of the
[deferred browser/visual plan](deferred-browser-visual-plan.md). Do not change
analytical density, bar shape, sampling, or display defaults as part of this task.

The shipping engine uniform is `(mask, apocenterForce, barTilt, apocenterShare)`;
mask bits are classic=1, simple=2, apocenter=4. Older release-plan references to
exclusive IDs 0/1/2 are not the current wire format.

## Contract decisions required before a runtime fix

1. Specify the baseline and ordering for each nonempty mask (1–7), including
   whether classic is always the baseline or only runs when its bit is enabled.
   Define apocenter-only versus classic+apocenter explicitly. The current shader
   evaluates classic first even when the classic bit is absent.
2. Define whether apocenter selection and ellipse construction use immutable birth
   coordinates or the preceding pass's moved position. A hash of moved coordinates
   can change membership over time; do not silently bless that as stable selection.
3. Choose one simple eccentricity rule for GPU reconstruction and CPU landmarks.
   Avoid adopting an arbitrary fixed value merely to make a stale test green.
4. Define birth identity, switch/reset semantics, and the behavior of labels/picking
   under combined engines. Keep the classic-only behavior unchanged.

Resolve these in the movement release plan before code changes. Isolated engine
laws and composition/dispatch need separate checks: passing one does not prove the
other. A visual comparison is not required to establish numerical parity.

## Ordered work

- [ ] **P1 — Reproduce and isolate.** Run `npm ci`, `python3 scripts/run.py all-tests`
  and `python3 scripts/run.py wgsl-exec`. Preserve failing details. Separate stale
  fixture inputs from actual CPU/render-path disagreements; do not suppress checks.
- [ ] **P2 — Specify and implement the shared dispatch.** Resolve the above decisions;
  align WGSL, CPU label/selection paths and engine packing. Preserve classic-script
  APIs, file:// operation, buffer contracts and allocation-free frame paths.
- [ ] **P3 — Repair and extend regressions.** Use `packEngineVec` and exported engine
  constants instead of manually writing old IDs. Exercise share 0 and 1 plus
  deterministic intermediate selection, force 0/nonzero, every mask, T=0/nonzero,
  and nonzero model centres. Compare full XYZ, with non-vacuity checks that prove
  the intended pass ran. Cover labels/picking as well as the isolated math helpers.
- [ ] **P4 — Validate.** All-tests and CPU WGSL execution must pass without deleting
  tests, widening existing tolerances, or relabeling runtime differences as harness
  limitations. Add any new experiment to `scripts/run.py`; retain concise evidence
  in `experiments/logs/` and the 0.4.x worklog.

Time-box initial investigation to a short focused session. If choosing the dispatch
would materially change the visible movement, present the concrete alternatives
before implementing; do not expand into bar tuning or a new engine. Following this
fix, a useful numerical follow-up is time-averaged radial/vertical/arm-density
measurement for experimental engines, before changing their defaults or calibration.
