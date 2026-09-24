# Damping plan — analysis

Read of `galaxy-star-movement-demo` (public tip `67ba6ea`, 2026-09-24) and of
the first draft of `damping-plan.md`. The draft's law was wrong for this
repo. What was kept, and what was sent back as advice, is below. The law that
shipped is `damping-plan.md`.

## What the linked repo actually has

The friction field is archive-only (`archive/simple-friction-field-draft.md`,
`simple-friction-field-js.html`, `simple-friction-field-webGL.html`). The draft
is qualitative: stars go slower nearer a precomputed spiral locus. The HTML is
a numerical integrator, not a closed form.

Measured constants in `simple-friction-field-js.html`:

- `D = exp(-δθ² / (2σ²))`, `σ = 0.25`, `σ²·2 = 0.125`
- `ω = ω_base · (1 − damping · D)`, `damping_strength = 0.70`
- `Ω_p = 0.15`, pitch 15°, `m = 2`
- `ω_base = V0 / (r + 0.2)`, `V0 = 1.8`, disc `r ∈ [~0.2, 6.7]`
- pattern phase is accumulated `Ω_p · dt`, not `time · speed`

Corotation for that demo is `V0/Ω_p − 0.2 ≈ 11.8`, past the outer edge of the
disc. Every star in that demo is inside corotation, so slowing the inertial
rate lengthens the time spent near the crest. That is why the jam works there.

Root `galaxy.js` (36541 B at that tip) does not contain the field. A 0.5.0
note on the tip ("global m=2 self-gravity") is not this feature.

## Why that field does not port

Two independent reasons.

**Sign, outside corotation.** This project's disc is mostly outside
corotation. On Sb seed 3: `vFlat = 0.2`, `rCore = 0.5`,
`ω_p ≈ 0.01967` rad/Myr, corotation ≈ 10.17 kpc, `m = 2`. R = 8 is still
inside (`ω_rel ≈ +0.0053`); R = 14 is outside. Outside, the pattern already
overtakes the star. Slowing the inertial rate makes the pattern sweep the star
*faster*, which empties the outer arms — the anti-jam. A law that only works
inside corotation would shear this galaxy's outer disc apart, which is the
failure the task forbids.

**Closed form.** The linked field is integrated. This repo's constraint is
`position(record, T)` as a function, the same galaxy on a revisit, no per-star
state. An integrator fails that even where the sign is right.

## Why the first draft of the plan was also wrong

The draft specified a cosine phase-pull: nudge θ toward the ridge by a term
in `cos` of the arm phase, with a strength slider capped below 1. That paints
the phase. Its radial derivative has the wrong sign relative to the arm pitch,
so neighbouring radii are pulled by different amounts and the arm shears apart
faster than the 0.4.3 differential rotation already does. It is the failure
mode the task names ("a damping slider that only shears arms apart"). It also
does not have a crest speed of zero, so a star on the ridge does not stay
there. Rejected. The file no longer specifies it.

A related trap, found while pinning the replacement: comparing one offset star
to the nearest crest is not a population test. A star on the far side of a
crest takes the long way to the next crest, so its distance can grow while the
ring as a whole tightens. The approaching side (positive azimuth offset
outside corotation, negative inside) is monotonic; the population check is the
mean |Δ| of a uniform ring.

## What was kept, and the numbers

The idea that was kept is the traffic jam itself: the arm is stars lingering
on the crest, and the sampler is not touched. The law that has crest speed
zero on both sides of corotation is the pattern-frame capture in
`damping-plan.md`:

```
dχ/dt = α · m · (Ω − Ω_p) · sin²(χ/2)
```

Closed form via `u = tan(χ/2)`. `experiments/damping-formula-check.js` compares
the shipped function to an Euler integration of the ODE (2016 samples). Worst
residual 0.00264 rad, at `R = 1.2`, `α = 0.7`, `t = 80`. Refining that one
case (6400 / 25600 / 102400 steps) gives 0.00264 / 0.00066 / 0.00017 rad. The
gap is Euler truncation. The closed form was not retuned. Log:
`experiments/logs/damping-formula.json`.

Sampler-weighted arm cosine (initial ~0.10) at `α = 0.5`, times
0/40/80/160/320/640/1200 Myr:

| R (kpc) | cosine |
|---|---|
| 3 | 0.10, 0.17, 0.32, 0.61, 0.86, 0.96, 0.99 |
| 8.2 | 0.10, 0.12, 0.16, 0.31, 0.60, 0.85, 0.95 |
| 14 | 0.10, 0.15, 0.27, 0.53, 0.81, 0.94, 0.98 |

The page default 0.60 is that measurement: a few minutes at 1 Myr/s to a
visible jam, short of the α = 1 glue. The module default stays 0, so a caller
that never sets the slider is still the 0.4.3 shear.

Approaching-side offset 0.35 rad at `α = 1`, times 0/40/80/160/320 Myr:
outside R = 14 (positive offset) `0.350, 0.298, 0.267, 0.274, 0.213` against
a sheared 1.380; inside R = 3 (negative offset) `0.350, 0.190, 0.190, 0.120,
0.019` against a sheared 0.982. The opposite side is not monotonic — see the
trap above.

Ring mean |Δ| at t = 400 Myr, 36 stars, undamped stays `π/(2m) = 0.785`.
At `α = 0.6`: R = 3 → 0.162, R = 8 → 0.634, R = 14 → 0.589. At `α = 1`:
0.057 / 0.501 / 0.441. f32 saturation of `u₀·β·t` still lands on the crest;
there is no special large-time path.

## Advice for the linked repo (not work done here)

- Their inertial `ω · (1 − s·D)` is the right sign only while the whole disc
  sits inside corotation. The moment the disc crosses corotation it anti-jams.
  The capture ODE above has the same jam on both sides and a closed form, so
  it can replace the integrator rather than sit beside it.
- Their pattern phase is an accumulated `Ω_p · dt`. A closed form of `Ω_p · T`
  revisits the same galaxy; the accumulator does not.
- The multi-type table, `deriveStar`, and the group-kinematics split (pattern
  rigid, bar streaming at `Ω(r) − Ω_p`, disc differential) are the pieces of
  this repo that would replace a single uniform rotation. None of that is a
  change to make in this tree.
