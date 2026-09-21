// src/math/star-types.js
// Stellar populations: mass, age, evolution state, colour — a pure function of
// (model, seed, density component, position in the disc). Mirrored in WGSL by
// src/render/shaders.js (procedural-gen) and validated by
// experiments/wgsl-validate.js.
//
// Physics that drives the placement of star types:
//   - IMF (Salpeter) decides the mass, hence the main-sequence lifetime.
//   - Age comes from the local population: thin disc is mixed, arms are young,
//     thick disc / bulge / halo are old.
//   - A star older than its MS lifetime is a red giant (low mass) or has
//     already shed its envelope into a white dwarf (high mass).
//   - O/B stars therefore only exist near spiral arms, red giants and
//     planetary nebulae concentrate in the bulge, and the halo is old and
//     metal-poor.
//
// The galaxy's own gas budget is what makes a type young or old: no gas means
// no star formation, so the arm-young branch and the quiescent-disc prior both
// read `model.populations.gasFraction`. An E4 therefore has no O/B stars twice
// over — nothing is born young there, and anything that was would have died.
//
// deriveStar mutates a caller-provided record: the renderer derives millions
// of stars and must not allocate per star.

'use strict';

(function () {
	const density = (typeof module !== 'undefined' && module.exports)
		? require('./density.js')
		: window.DensityLib;
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

	// Age in Gyr for a population. u1, u2 are independent uniforms. The radius
	// window for the arm-young branch is the model's: the ridge only means
	// something between the arm reference radius and youngOuterR, and the
	// distance-to-arm cut is a physical scale (a few hundred pc), not a length
	// that scales with the galaxy.
	function sampleLocalAge(model, componentIndex, distToArm, R, u1, u2) {
		const logNormal = (mean, sigma) => Math.min(13.5, Math.exp(Math.log(mean) + sigma * gaussian(u1, u2)));
		switch (componentIndex) {
			case density.COMPONENT_BULGE: return logNormal(10, 0.3);
			case density.COMPONENT_HALO: return logNormal(12, 0.25);
			case density.COMPONENT_THICK: return logNormal(8, 0.4);
			default:
				if (!model.populations.gasRich) return logNormal(9, 0.4);
				const armWidth = 0.3;
				const pArm = Math.exp(-0.5 * (distToArm * distToArm) / (armWidth * armWidth));
				if (u2 < pArm && R > model.arms.Rs && R < model.populations.youngOuterR) return Math.pow(u1, 3.0) * 0.3;
				return logNormal(5, 0.5);
		}
	}

	// Box-Muller, clamped away from the log singularity.
	function gaussian(u1, u2) {
		return Math.sqrt(-2 * Math.log(Math.max(1e-12, u1))) * Math.cos(2 * Math.PI * u2);
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

	// Core derivation. `out` is mutated in place and returned.
	function deriveStar(model, seed, componentIndex, R, distToArm, out) {
		const uMass = hash.hash01(seed * 31 + 1);
		const uAge1 = hash.hash01(seed * 31 + 2);
		const uAge2 = hash.hash01(seed * 31 + 3);
		const uEvolve = hash.hash01(seed * 31 + 4);
		const uEvolve2 = hash.hash01(seed * 31 + 5);

		const mass = sampleMassIMF(uMass);
		const age = sampleLocalAge(model, componentIndex, distToArm, R, uAge1, uAge2);
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
	function classVsArmDistance(stars) {
		const buckets = {};
		for (const cls of records.SPECTRAL_CLASSES) buckets[cls] = [];
		for (const s of stars) {
			if (buckets[s.spectralClass]) buckets[s.spectralClass].push(s.distToArm);
		}
		const out = {};
		for (const cls of Object.keys(buckets)) {
			const arr = buckets[cls];
			if (arr.length === 0) {
				out[cls] = { n: 0, mean: 0, fracLT05: 0 };
				continue;
			}
			let sum = 0;
			let close = 0;
			for (const v of arr) {
				sum += v;
				if (v < 0.5) close++;
			}
			out[cls] = { n: arr.length, mean: sum / arr.length, fracLT05: close / arr.length };
		}
		return out;
	}

	const StarTypesLib = {
		MASS_TEFF_TABLE,
		classifyByTempAndState, classColor, luminosityFromMass, teffFromMass,
		msLifetimeGyr, sampleMassIMF, sampleLocalAge, metallicityFor,
		absoluteMagnitude, deriveStar, deriveStarProps,
		summariseByComponent, classVsArmDistance,
	};
	if (typeof module !== 'undefined') module.exports = StarTypesLib;
	if (typeof window !== 'undefined') window.StarTypesLib = StarTypesLib;
})();
