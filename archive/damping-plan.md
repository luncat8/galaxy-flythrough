# Wave damping — pattern-frame capture

The disc family shears off the arm it was sampled on (0.4.3, §3.3 of
`0.4.0-plan-star-move.md`). That shear is real differential rotation, and it
remains the law at strength 0. A density wave is the other half of the same
picture: stars linger on the crest, and the arm is the traffic jam, not a
paint job. This file is that jam. It is a view control, like exposure, not a
field of the galaxy model.

The cosine phase-pull that an earlier draft of this file specified, and the
inertial friction field in the linked `galaxy-star-movement-demo` archive, were
both measured and rejected. The measurements are in
`archive/damping-plan-report.md`. Do not reintroduce either.

---

## 1. Constraints this law has to keep

- **Closed form.** `position(record, T)` stays a function. No force integration,
  no per-star state, no history. Revisiting `T` gives the identical galaxy.
- **The sampler is untouched.** Capture moves stars that were already drawn. It
  does not resample, and it does not rewrite `StarPacked`. Arm geometry is
  per-model and already lives in `model.arms`.
- **One law, two sides.** The CPU mirror and `SHADER_PARTS['orbit']` evaluate
  the same arithmetic. Per-galaxy numbers arrive through the uniform, never as
  literals in the shader.
- **α = 0 is the 0.4.3 shear, bit for bit.** A caller that never touches the
  slider (tests, a headless pack) must not see a different galaxy.
- **Disc family only.** Pattern stars already ride Ω_p. The bar's x1 loop is
  not a spiral. `patternLock` already has no shear, and capture on top of it
  would fight the flag. An unarmed disc (amp 0, m < 1, pitch 0, Rs 0) and a
  star inside `arms.minRadius` skip the term.

---

## 2. The law

Let θ₀ be the birth azimuth of the star, θ_arm(R) the crest azimuth at its
birth radius, and χ the arm phase folded so every crest is 0:

```
θ_arm(R) = (K · ln(R / Rs) − phase0) / m          K = m / tan(pitch)
χ₀       = reduce(m · (θ₀ − θ_arm(R)))            onto (−π, π]
```

`density.armRidgeAzimuth` is that crest. The capture ODE, in the pattern frame:

```
dχ/dt = α · m · (Ω(R) − Ω_p) · sin²(χ/2)
```

Ω(R) is the disc's local group rate, `vFlat / max(R, rCore)`, the same clock
`omegaFrom` already uses. Crest speed is exactly zero on **both** sides of
corotation: inside, a star ahead of the wave is slowed onto the crest the wave
is sweeping toward; outside, a star the wave is overtaking is sped up onto it.
The interarm (χ = ±π) is the unstable fixed point. α = 1 is nonsingular — the
crest speed is still zero — so the slider caps at 1, not at some s < 1 glue.

Closed form, half-angle substitution `u = tan(χ/2)`:

```
β     = α · m · (Ω − Ω_p) / 2
u(t)  = u₀ / (1 − u₀ · β · t)
χ(t)  = 2 · atan(u)
```

When the denominator crosses zero the star has passed the interarm. `atan`
flips; add ±2π (the sign of Ω − Ω_p) so χ keeps moving toward the next crest
instead of teleporting back by one arm. Then

```
θ(t) = (χ(t) − χ₀) / m + Ω_p · t
```

and the rest of `orbitPosition` is unchanged: rotate the birth vector by θ,
then add the epicycle. T = 0 short-circuits to `Ω · 0` before the formula, so
the transform stays the identity. Clamp χ₀ one `1e-5` inside ±π so `tan(χ/2)`
stays finite; that point is the unstable midpoint and a star there is one
crest or the other.

α = 0 must not enter the formula. Folding strength 0 into the `atan` freezes
χ, which is not the shear.

---

## 3. Uniform

The camera uniform is shared by the star shader and the nebula billboards, so
both `CameraUniform`s carry the pair. Nebulae ignore it (gas stays on the
pattern). Layout, 16 floats at offset 28, after `dynA`/`dynB`:

```
waveA = (damping, m, K, phase0)
waveB = (Rs, minRadius, amp, 0)
```

An unarmed model packs `m = 0`, so the shader takes the same skip the CPU does
without a hard-coded galaxy. `UNIFORM_FLOATS = 44` (176 bytes). The module
default of the damping slot is 0.

---

## 4. The control

Damping is view state, not model state. `setWaveDamping` clamps to `[0, 1]`.
The module default is 0. The page sets `WAVE_DAMPING_UI_DEFAULT` (0.6) at boot:
an arm-weighted ring at the Sun climbs from cosine ~0.10 to ~0.6 in about
300 Myr, which is a few minutes at 1 Myr/s, without the full-capture glue of
α = 1. The slider is 0–1 in steps of 0.05. Defaults restores 0.6. Changing
type, seed, or age does not — a regenerate must not snap a view control.

---

## 5. What a reimplementation must pin

- T = 0 is the identity at α = 1, including a star that is not on the crest.
- A star born on the crest stays on it.
- On the side the wave is sweeping, distance to the crest falls. Do not assert
  this for an arbitrary offset: a star on the far side of a crest takes the
  long way to the next one, so its distance can grow. The population test is
  the mean |χ| of a uniform ring, which falls on both sides of corotation.
- Pattern, bar, an unarmed disc, and `patternLock` ignore the slider.
- Setting 0 after a non-zero value is bit-identical to never having set it.
- The f32 replay of the shader arithmetic stays within 0.05 kpc of the f64 law.
- Neither side contains the rejected inertial form `ω · (1 − s·D)`.
