// src/math/star-types.js
// Stellar populations: mass, age, evolution state, colour — a pure function of
// (model, seed, density component, position in the disc). Mirrored in WGSL by
// src/render/shaders.js (procedural-gen) and validated by
// experiments/wgsl-validate.js.
//
// Physics that drives the placement of star types:
//   - IMF (Salpeter) decides the mass, hence the main-sequence lifetime.
//   - Age comes from the galaxy's own star-formation history: a star formed at
//     `t_f` inside its component's formation window and is `age − t_f` old now.
//     The thin disc is still forming, the halo formed first, and the arms carry
//     the newborns.
//   - A star older than its MS lifetime is a red giant (low mass) or has
//     already shed its envelope into a white dwarf (high mass).
//   - O/B stars therefore only exist near spiral arms of a galaxy young enough
//     to still be forming them, red giants and planetary nebulae concentrate in
//     the bulge, and the halo is old and metal-poor.
//
// The galaxy's own gas budget is what makes a type young or old: no gas means
// no star formation, so the arm-young branch reads `model.populations.gasRich`,
// which the clock solves from the gas left at the model's age. An E4 therefore
// has no O/B stars twice over — nothing is born young there, and anything that
// was would have died.
//
// deriveStar mutates a caller-provided record: the renderer derives millions
// of stars and must not allocate per star.

'use strict';

(function () {
	const density = (typeof module !== 'undefined' && module.exports)
		? require('./density.js')
		: window.DensityLib;
	const galaxy = (typeof module !== 'undefined' && module.exports)
		? require('./galaxy.js')
		: window.GalaxyLib;
	const hash = (typeof module !== 'undefined' && module.exports)
		? require('./hash.js')
		: window.HashLib;
	const records = (typeof module !== 'undefined' && module.exports)
		? require('./star-record.js')
		: window.StarRecord;

	// Spectral class from temperature and evolution state.
	function classifyByTempAndState(Teff, evolvedState) {
		if (evolvedState === 'wd') return 'WD';
		if (evolvedState === 'giant') return 'RG';
		if (Teff >= 30000) return 'O';
		if (Teff >= 10000) return 'B';
		if (Teff >= 7500) return 'A';
		if (Teff >= 6000) return 'F';
		if (Teff >= 5200) return 'G';
		if (Teff >= 3700) return 'K';
		return 'M';
	}

	// Rough linear-light colour by spectral class — visualisation only, the
	// renderer uses the LUT (star-record.js CLASS_COLORS) which is the
	// authoritative palette. Values here are approximations of the LUT
	// linearised from sRGB bytes.
	function classColor(cls) {
		function lin(v) { v /= 255; return v <= 0.04045 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); }
		const lut = records.CLASS_COLORS[records.spectralClassIndex(cls)];
		return [lin(lut[0]), lin(lut[1]), lin(lut[2])];
	}

	// L/Lsun = (M/Msun)^alpha, piecewise (radiation pressure flattens the top).
	function luminosityFromMass(m) {
		if (m < 0.7) return m ** 2.3;
		if (m < 2.0) return m ** 4.0;
		if (m < 20) return m ** 3.5;
		return m ** 2.8;
	}

	// Empirical main-sequence mass-Teff relation, [M_sun, Teff_K], interpolated
	// in log-log. A pure L/R formula misclassifies M dwarfs as K stars.
	const MASS_TEFF_TABLE = [
		[0.08, 2400], [0.10, 2800], [0.15, 3200], [0.20, 3400], [0.30, 3600],
		[0.45, 3800], [0.70, 4500], [0.85, 5000], [1.00, 5800], [1.50, 6800],
		[2.00, 9000], [3.00, 12000], [5.00, 16000], [9.00, 22000],
		[16.0, 30000], [30.0, 38000], [60.0, 45000], [100, 50000],
	];

	function teffFromMass(m) {
		const first = MASS_TEFF_TABLE[0];
		if (m <= first[0]) return first[1];
		const last = MASS_TEFF_TABLE[MASS_TEFF_TABLE.length - 1];
		if (m >= last[0]) return last[1];
		for (let i = 0; i < MASS_TEFF_TABLE.length - 1; i++) {
			const lo = MASS_TEFF_TABLE[i];
			const hi = MASS_TEFF_TABLE[i + 1];
			if (m < lo[0] || m > hi[0]) continue;
			const t = (Math.log10(m) - Math.log10(lo[0])) / (Math.log10(hi[0]) - Math.log10(lo[0]));
			return Math.pow(10, (1 - t) * Math.log10(lo[1]) + t * Math.log10(hi[1]));
		}
		return 5772;
	}

	// Main-sequence lifetime in Gyr: t ~ 10 * M / L.
	function msLifetimeGyr(m) {
		return Math.min(15.0, Math.max(0.003, 10.0 * m / luminosityFromMass(m)));
	}

	// Salpeter IMF sample, dN/dM ~ M^-2.35 on [0.08, 100].
	function sampleMassIMF(u) {
		const alpha = 2.35;
		const xMin = Math.pow(0.08, 1 - alpha);
		const xMax = Math.pow(100.0, 1 - alpha);
		return Math.pow(xMin + (xMax - xMin) * u, 1 / (1 - alpha));
	}

	// ---- the galaxy's clock --------------------------------------------------
	//
	// A star's age is `age − t_f`, where t_f is when it formed inside the
	// galaxy's star-formation history: the delayed exponential SFR ∝ t·exp(−t/τ)
	// truncated at the model's span (galaxy.sfhSpanAt), sampled inside the
	// component's formation window (galaxy.FORMATION_WINDOW, solved into
	// `populations.formQ` as a CDF interval). One distribution F for the ages,
	// the windows and the gas; this file only ever inverts it.
	//
	// F⁻¹ has no closed form (it is a Lambert W), so the CPU keeps a table and
	// the WGSL mirror bisects F. Measured on 300k stars: a 1025-entry table built
	// in 3.8 ms answers a draw with two array reads (2.8 ms total, rms 6.3e-4 Gyr
	// against a 60-step reference solve), where the same draws by 14-step
	// bisection cost 91 ms — half the derive pass, on the age slider's hot path.
	// wgsl-exec-check therefore compares the two sides on an absolute 0.05 Gyr
	// floor for this branch, and keeps its 2e-3 relative check for the arm one.

	const YOUNG_ARM_MAX_GYR = 0.3;   // the arm branch's oldest newborn
	const SFH_TABLE_STEPS = 1024;    // entries − 1; t_f is linear between them
	const SFH_SOLVE_STEPS = 40;      // bisection steps per table entry, at build

	// One table, keyed on the two numbers that shape it. A regenerate that only
	// moves the age rebuilds it (the span moved); a regenerate that moves neither
	// reuses it.
	let sfhTableTau = -1;
	let sfhTableSpan = -1;
	const sfhTable = new Float64Array(SFH_TABLE_STEPS + 1);

	// Bisection on the analytic CDF, used only to build the table.
	function solveSfhCumulative(target, tauSfh, xEnd) {
		let lo = 0;
		let hi = xEnd;
		for (let s = 0; s < SFH_SOLVE_STEPS; s++) {
			const mid = 0.5 * (lo + hi);
			if (galaxy.sfhCumulative(mid) < target) lo = mid; else hi = mid;
		}
		return 0.5 * (lo + hi) * tauSfh;
	}

	function ensureSfhTable(tauSfh, sfhSpan) {
		if (tauSfh === sfhTableTau && sfhSpan === sfhTableSpan) return;
		const xEnd = sfhSpan / tauSfh;
		const norm = galaxy.sfhCumulative(xEnd);
		for (let i = 0; i <= SFH_TABLE_STEPS; i++) {
			sfhTable[i] = solveSfhCumulative(i / SFH_TABLE_STEPS * norm, tauSfh, xEnd);
		}
		sfhTableTau = tauSfh;
		sfhTableSpan = sfhSpan;
	}

	// Formation time for a fraction `q` of the model's truncated SFH: the
	// inverse CDF, by table.
	function sfhFormationTime(model, q) {
		const p = model.populations;
		const span = p.sfhSpan;
		if (!(span > 0)) return 0;
		ensureSfhTable(p.tauSfh, span);
		const u = q <= 0 ? 0 : (q >= 1 ? 1 : q);
		const pos = u * SFH_TABLE_STEPS;
		const i = pos < SFH_TABLE_STEPS ? pos | 0 : SFH_TABLE_STEPS - 1;
		return sfhTable[i] + (sfhTable[i + 1] - sfhTable[i]) * (pos - i);
	}

	// Formation time of a star in `component`: its window's slice of the
	// galaxy's SFH. The window is a CDF interval, so the draw inside it is one
	// mix and one lookup, and its *shape* is still the galaxy's own SFH — a
	// component that forms over the first quarter of a burst is front-loaded
	// like the burst, not uniform in time.
	function sampleFormationTime(model, componentIndex, u) {
		const formQ = model.populations.formQ;
		const i = componentIndex * 2;
		return sfhFormationTime(model, formQ[i] + (formQ[i + 1] - formQ[i]) * u);
	}

	// Age in Gyr for a population. u1, u2 are independent uniforms.
	//
	// The arm branch is the O/B source and keeps the shape 0.3.1 built: a
	// half-normal gate on distToArm in units of the model's own ridge width
	// (density.armRidgeWidth), `u1³·0.3 Gyr` young inside the star-forming
	// annulus, gas-rich models only. Its ceiling is clamped to the galaxy's age,
	// so a 0.2 Gyr galaxy contains no 0.3 Gyr stars. No gas factor rides on the
	// gate: with the reference-epoch gas law every reachable age has at least the
	// observed gas, so a continuous boost could only re-tune one type.
	//
	// Everything else is `age − t_f` from the component's formation window, which
	// is what makes the assembly order (halo first, thin disc still forming)
	// survive at any age — a 1 Gyr galaxy has a 1 Gyr halo, and a 13.5 Gyr
	// irregular has a middle-aged disc.
	function sampleLocalAge(model, componentIndex, distToArm, R, u1, u2) {
		const p = model.populations;
		if (componentIndex === density.COMPONENT_THIN && p.gasRich) {
			const armWidth = density.armRidgeWidth(model, R);
			const pArm = Math.exp(-0.5 * (distToArm * distToArm) / (armWidth * armWidth));
			if (u2 < pArm && R > model.arms.Rs && R < p.youngOuterR) {
				return Math.min(p.age, Math.pow(u1, 3.0) * YOUNG_ARM_MAX_GYR);
			}
		}
		return p.age - sampleFormationTime(model, componentIndex, u1);
	}

	// The seed a field star at index `i` is derived with — the renderer's
	// convention, named so the exposure calibration derives exactly the stars the
	// field will hold instead of a lookalike sample.
	function fieldStarSeed(seed, i) {
		return seed * 31 + i + 1;
	}

	// Mean luminosity (L☉) of the first `count` sampled positions, derived the
	// way the renderer derives them. The exposure renormalisation needs "how
	// bright is this field" as one number — at the model's age, and at the
	// reference epoch over the *same* positions — so it is a function of
	// (model, field) rather than a second sampler with its own drift. One scratch
	// record, no per-star allocation.
	const calibrationRecord = {};
	function meanFieldLuminosity(model, stars, count) {
		const n = Math.min(count, stars.count);
		if (!(n > 0)) return 0;
		let sum = 0;
		for (let i = 0; i < n; i++) {
			deriveStar(model, fieldStarSeed(model.seed, i), stars.component[i], stars.R[i],
				stars.distToArm[i], calibrationRecord);
			sum += calibrationRecord.luminosity;
		}
		return sum / n;
	}

	function metallicityFor(componentIndex) {
		switch (componentIndex) {
			case density.COMPONENT_THIN: return 0.020;   // solar
			case density.COMPONENT_THICK: return 0.008;
			case density.COMPONENT_BULGE: return 0.035;  // super-solar
			default: return 0.001;                       // halo
		}
	}

	// Absolute V magnitude from luminosity: M_V = M_V,sun - 2.5 log10(L).
	function absoluteMagnitude(lum) {
		return 4.83 - 2.5 * Math.log10(Math.max(1e-6, lum));
	}

	// Core evolution: mass + age → state, Teff, luminosity, class, colour. Shared
	// by deriveStar (age from the local population) and deriveStarWithAge (age
	// from the composite object the star belongs to) — the IMF and the age draw
	// differ, the physics from there on does not.
	function evolveStar(model, seed, mass, age, componentIndex, R, distToArm, out) {
		const uEvolve = hash.hash01(seed * 31 + 4);
		const uEvolve2 = hash.hash01(seed * 31 + 5);

		const tMS = msLifetimeGyr(mass);

		let state = 'ms';
		let teff;
		let lum;
		if (age > tMS * 1.1 && mass >= 8.0) {
			// Massive star past its (short) MS lifetime: remnant.
			state = 'wd';
			teff = 8000 + 30000 * uEvolve;
			lum = 0.001 + 0.1 * uEvolve2;
		} else if (age > tMS * 1.1) {
			// Low/intermediate mass: red giant.
			state = 'giant';
			teff = 3000 + 1000 * uEvolve;
			lum = 100 + 10000 * uEvolve2;
		} else {
			teff = teffFromMass(mass);
			lum = luminosityFromMass(mass);
		}

		const spectralClass = classifyByTempAndState(teff, state);
		let colorIndex = records.spectralClassIndex(spectralClass);
		if (componentIndex === density.COMPONENT_THIN && state === 'ms') {
			// Radial metallicity, as a colour step only (no physics): main-
			// sequence thin-disc stars redden toward the rim, reaching the
			// full +1 step at R = 2*L/steep — flat in the E/S0 range, steep in
			// the late types (populations.gradientSteep). Clamped at M: a
			// metal-poor star reddens within the main-sequence classes and
			// never becomes a WD or a giant by colour alone.
			const L = (model.thin && model.thin.L) ? model.thin.L : 2.6;
			const steep = (model.populations && model.populations.gradientSteep) || 0;
			const shift = steep > 0 ? Math.min(1, Math.floor(R * steep / (2 * L))) : 0;
			if (shift > 0) {
				colorIndex = Math.min(records.SPECTRAL_CLASSES.indexOf('M'), colorIndex + shift);
			}
		} else if (componentIndex === density.COMPONENT_BULGE && state === 'giant' && uEvolve < 0.2) {
			// Metal-poor spheroid giants: 20% land one LUT step redder than RG,
			// in the dedicated RGe slot (RG is the reddest class, so the shift
			// needs its own entry).
			colorIndex = records.SPECTRAL_CLASSES.length - 1;
		}
		out.mass = mass;
		out.age = age;
		out.teff = teff;
		out.luminosity = lum;
		out.state = state;
		out.spectralClass = spectralClass;
		out.colorIndex = colorIndex;
		out.absMag = absoluteMagnitude(lum);
		out.metallicity = metallicityFor(componentIndex);
		out.component = componentIndex;
		out.R = R;
		out.distToArm = distToArm;
		return out;
	}

	// Core derivation. `out` is mutated in place and returned.
	function deriveStar(model, seed, componentIndex, R, distToArm, out) {
		const mass = sampleMassIMF(hash.hash01(seed * 31 + 1));
		const age = sampleLocalAge(model, componentIndex, distToArm, R,
			hash.hash01(seed * 31 + 2), hash.hash01(seed * 31 + 3));
		return evolveStar(model, seed, mass, age, componentIndex, R, distToArm, out);
	}

	// Same pipeline with the age imposed from outside: member stars of a
	// composite object are coeval at the object's age, not drawn from the local
	// population prior. Mass (channel 1) and evolution rolls (4, 5) keep their
	// field-star channels; the age channels (2, 3) are simply not drawn.
	function deriveStarWithAge(model, seed, componentIndex, R, distToArm, ageGyr, out) {
		const mass = sampleMassIMF(hash.hash01(seed * 31 + 1));
		return evolveStar(model, seed, mass, ageGyr, componentIndex, R, distToArm, out);
	}

	// The central star of a planetary nebula: a post-AGB remnant, hot and
	// luminous, on its way to the white-dwarf cooling track. Classified O (the
	// LUT's hottest slot) with state 'ms', so every consumer that switches on
	// the three known states keeps working; component/R/arm are the host's, for
	// the record only.
	function derivePlanetaryCentral(seed, componentIndex, R, distToArm, out) {
		const teff = 30000 + 70000 * hash.hash01(seed * 31 + 1);
		const lum = Math.pow(10, 2 + 2 * hash.hash01(seed * 31 + 2));
		out.mass = 0.6;
		out.age = 10;
		out.teff = teff;
		out.luminosity = lum;
		out.state = 'ms';
		out.spectralClass = 'O';
		out.colorIndex = records.spectralClassIndex('O');
		out.absMag = absoluteMagnitude(lum);
		out.metallicity = 0.020;
		out.component = componentIndex;
		out.R = R;
		out.distToArm = distToArm;
		return out;
	}

	// Convenience wrapper for the model experiments: takes a position, works
	// out the local population, and returns a full record (allocates one
	// object — never call this from the render loop).
	function deriveStarProps(model, x, y, z, seed) {
		const d = density.rhoDecomposed(model, x, y, z);
		const componentIndex = density.sampleComponentIndex(d, hash.hash01(seed * 31 + 7));
		const out = deriveStar(model, seed, componentIndex, d.R, d.distToArm, {
			x, y, z, phi: d.phi, zp: d.zp, componentName: density.COMPONENT_NAMES[componentIndex],
		});
		out.color = classColor(out.spectralClass);
		out.distPc = Math.sqrt(x * x + y * y + z * z) * 1000;
		out.appMag = out.absMag + 5 * Math.log10(Math.max(1, out.distPc)) - 5;
		return out;
	}

	function summariseByComponent(stars) {
		const byClass = {};
		const byComponent = {};
		for (const s of stars) {
			byClass[s.spectralClass] = (byClass[s.spectralClass] || 0) + 1;
			const name = density.COMPONENT_NAMES[s.component];
			byComponent[name] = (byComponent[name] || 0) + 1;
		}
		return { byClass, byComponent, total: stars.length };
	}

	// Mean distance-to-arm and the fraction within 0.5 kpc, per spectral class.
	// Arm-distance statistics per spectral class, in units of the model's own
	// young ridge (density.armRidgeWidth at each star's radius), never against a
	// fixed distance: a fixed cut is most of the lane in the inner disc and a
	// sliver of it at the rim, so it stops measuring arm hugging at all (see the
	// star-types-evolution test for the numbers). Restricted to the star-forming
	// annulus — the region nebula.js calls the spiral region — because inside
	// `arms.Rs` the lane is a fraction of the bulge and outside `youngOuterR`
	// the pattern does not form stars. `stars` records must carry `R` and
	// `distToArm`; `meanZ` is the mean ridge-relative distance, which is 0.8 for
	// a population born in the lane and ~2.5 for one that ignores it.
	function classVsArmDistance(stars, model) {
		const out = {};
		for (const cls of records.SPECTRAL_CLASSES) out[cls] = { n: 0, sum: 0, sumZ: 0, inLane: 0 };
		for (const s of stars) {
			const bucket = out[s.spectralClass];
			if (!bucket || !(s.R > model.arms.Rs && s.R < model.populations.youngOuterR)) continue;
			const sigma = density.armRidgeWidth(model, s.R);
			bucket.n++;
			bucket.sum += s.distToArm;
			bucket.sumZ += s.distToArm / sigma;
			if (s.distToArm < sigma) bucket.inLane++;
		}
		for (const cls of Object.keys(out)) {
			const b = out[cls];
			const n = Math.max(1, b.n);
			out[cls] = { n: b.n, mean: b.sum / n, meanZ: b.sumZ / n, fracInLane: b.inLane / n };
		}
		return out;
	}

	const StarTypesLib = {
		MASS_TEFF_TABLE, YOUNG_ARM_MAX_GYR, SFH_TABLE_STEPS, SFH_SOLVE_STEPS,
		classifyByTempAndState, classColor, luminosityFromMass, teffFromMass,
		msLifetimeGyr, sampleMassIMF, sampleLocalAge, metallicityFor,
		sfhFormationTime, sampleFormationTime, fieldStarSeed, meanFieldLuminosity,
		absoluteMagnitude, deriveStar, deriveStarWithAge, derivePlanetaryCentral, deriveStarProps,
		summariseByComponent, classVsArmDistance,
	};
	if (typeof module !== 'undefined') module.exports = StarTypesLib;
	if (typeof window !== 'undefined') window.StarTypesLib = StarTypesLib;
})();
