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

	// The main-sequence class boundaries, hottest first: [class, floor K]. One
	// list, two readers — this classifier and planets.js's record→temperature
	// inversion, which has to land a colour index back inside the same band the
	// renderer classified the star into. The WGSL mirror carries the same
	// numbers (procedural-gen.wgsl, pinned by wgsl-validate).
	const CLASS_TEMP_BOUNDS = [
		['O', 30000], ['B', 10000], ['A', 7500], ['F', 6000],
		['G', 5200], ['K', 3700], ['M', 0],
	];

	// Spectral class from temperature and evolution state.
	function classifyByTempAndState(Teff, evolvedState) {
		if (evolvedState === 'wd') return 'WD';
		if (evolvedState === 'giant') return 'RG';
		for (let i = 0; i < CLASS_TEMP_BOUNDS.length; i++) {
			if (Teff >= CLASS_TEMP_BOUNDS[i][1]) return CLASS_TEMP_BOUNDS[i][0];
		}
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

	// The record-to-star inverse is shared by planet inputs and observed catalog
	// tracks. A WD bracket is its remnant mass and a giant bracket its initial
	// mass; observedTrack uses separate progenitor priors for those two states.
	const CLASS_MASS_BRACKETS = {
		O: [16, 100], B: [2.5, 16], A: [1.6, 2.5], F: [1.05, 1.6],
		G: [0.85, 1.05], K: [0.55, 0.85], M: [0.08, 0.55],
		WD: [0.5, 1.4], RG: [0.8, 3.0], RGe: [0.8, 3.0],
	};
	const LUM_BRANCHES = [[0.7, 2.3], [2.0, 4.0], [20, 3.5], [Infinity, 2.8]];

	function massFromLuminosity(lum) {
		const target = lum > 1e-12 ? lum : 1e-12;
		let best = -1;
		for (let i = 0; i < LUM_BRANCHES.length; i++) {
			const alpha = LUM_BRANCHES[i][1];
			const m = Math.pow(target, 1 / alpha);
			const lo = i === 0 ? 0 : LUM_BRANCHES[i - 1][0];
			if (m >= lo && m < LUM_BRANCHES[i][0] && (best < 0 || m < best)) best = m;
		}
		// The law jumps down at 0.7 M☉; outside every branch the alpha=4 root
		// is the continuous fallback, clamped to the sampler's mass limits.
		if (best < 0) best = Math.max(0.08, Math.min(100, Math.pow(target, 1 / 4)));
		return best;
	}

	function luminosityFromMag(absMag) {
		return Math.pow(10, (4.83 - absMag) / 2.5);
	}

	function massFromClassAndMag(colorIndex, absMag, out) {
		const cls = records.SPECTRAL_CLASSES[colorIndex] || 'M';
		const bracket = CLASS_MASS_BRACKETS[cls] || CLASS_MASS_BRACKETS.M;
		const lum = luminosityFromMag(absMag);
		let m = massFromLuminosity(lum);
		if (m < bracket[0]) m = bracket[0];
		else if (m > bracket[1]) m = bracket[1];
		if (out) out.lum = lum;
		return m;
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

	// 0.4.5: the giant branch lasts a slice of the main-sequence life — 15%,
	// clamped to 2 Myr .. 1 Gyr. Massive stars flash through it in Myr (red
	// supergiants included, briefly, at the top); a solar mass lingers ~1 Gyr
	// at the cap. Past tMS*1.1 + tGiant the star is a cooling white dwarf, so
	// giants concentrate at the turnoff instead of accumulating forever and
	// the old field stops outshining the young one. Mirrored in WGSL as
	// giantLifetimeGyr (+ the TGIANT_*/WD_* constants below, same names).
	const TGIANT_FRAC = 0.15;
	const TGIANT_MIN = 0.002;
	const TGIANT_MAX = 1.0;
	const WD_COOL_TAU = 8.0;
	const WD_TEFF_FLOOR = 4000;
	const WD_LUM_FLOOR = 0.0005;
	function giantLifetimeGyr(m) {
		const t = TGIANT_FRAC * msLifetimeGyr(m);
		return t < TGIANT_MIN ? TGIANT_MIN : (t > TGIANT_MAX ? TGIANT_MAX : t);
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

	// A field draw belongs to one census, so its birth law is anchored to the
	// reference span even when the viewer starts at another epoch. The lookup
	// table is shared with the existing local-age inverse; only its cache key
	// changes, never the underlying SFH. Channel 6 is reserved for birth time.
	function formationTimeAtReference(model, q) {
		const p = model.populations;
		const spanRef = galaxy.sfhSpanAt(galaxy.AGE_REF, p.quenchTime);
		if (!(spanRef > 0)) return 0;
		ensureSfhTable(p.tauSfh, spanRef);
		const u = Math.max(0, Math.min(1, q));
		const pos = u * SFH_TABLE_STEPS;
		const i = pos < SFH_TABLE_STEPS ? pos | 0 : SFH_TABLE_STEPS - 1;
		return sfhTable[i] + (sfhTable[i + 1] - sfhTable[i]) * (pos - i);
	}

	function sampleFormationTimeAtReference(model, componentIndex, u) {
		const p = model.populations;
		const spanRef = galaxy.sfhSpanAt(galaxy.AGE_REF, p.quenchTime);
		if (!(spanRef > 0)) return 0;
		const xEnd = spanRef / p.tauSfh;
		const norm = galaxy.sfhCumulative(xEnd);
		if (!(norm > 0)) return 0;
		const w0 = galaxy.FORMATION_WINDOW[componentIndex * 2];
		const w1 = galaxy.FORMATION_WINDOW[componentIndex * 2 + 1];
		const q0 = galaxy.sfhCumulative(w0 * xEnd) / norm;
		const q1 = galaxy.sfhCumulative(w1 * xEnd) / norm;
		const q = q0 + (q1 - q0) * Math.max(0, Math.min(1, u));
		return formationTimeAtReference(model, q);
	}

	// Age in Gyr for a population. u1, u2 are independent uniforms. `zOverH` is
	// |z| / H(R) of the thin disc (signed is fine — the gate squares it). Omit
	// it, or pass 0, for the midplane, where the vertical gate is fully open and
	// this is the 0.3.3 age exactly.
	//
	// The arm branch is the O/B source and keeps the shape 0.3.1 built: a
	// half-normal gate on distToArm in units of the model's own ridge width
	// (density.armRidgeWidth), `u1³·0.3 Gyr` young inside the star-forming
	// annulus, gas-rich models only. 0.4.8 M3.3 multiplies that gate by the same
	// half-normal in height, sigma = populations.youngScaleHeight (the gas lane,
	// in units of H(R)). A newborn has to be in the arm *and* in the lane. The
	// ceiling is clamped to the galaxy's age, so a 0.2 Gyr galaxy contains no
	// 0.3 Gyr stars. No gas factor rides on the gate: with the reference-epoch
	// gas law every reachable age has at least the observed gas, so a continuous
	// boost could only re-tune one type.
	//
	// The field branch is still `age − t_f` from the component's formation
	// window — that is what keeps the assembly order (halo first, thin disc
	// still forming) at any age. It then takes a heating floor
	// `YOUNG_ARM_MAX_GYR · (z/lane)²`. Discs heat as they age, so a field star
	// one gas-lane above the midplane is at least as old as the oldest newborn;
	// without the floor the SFH's young tail plants O/B stars at every height
	// and the arm gate cannot thin the layer. The floor uses no new constant.
	function sampleArmAge(model, componentIndex, distToArm, R, u1, u2, zOverH) {
		const p = model.populations;
		if (componentIndex !== density.COMPONENT_THIN || !p.gasRich) return -1;
		const armWidth = density.armRidgeWidth(model, R);
		const pArm = Math.exp(-0.5 * (distToArm * distToArm) / (armWidth * armWidth));
		const lane = p.youngScaleHeight > 1e-3 ? p.youngScaleHeight : 1e-3;
		const zh = zOverH || 0;
		const z2 = zh * zh;
		const pZ = Math.exp(-0.5 * z2 / (lane * lane));
		if (!(u2 < pArm * pZ && R > model.arms.Rs && R < p.youngOuterR)) return -1;
		return Math.min(p.age, Math.pow(u1, 3.0) * YOUNG_ARM_MAX_GYR);
	}

	function sampleLocalAge(model, componentIndex, distToArm, R, u1, u2, zOverH) {
		const p = model.populations;
		const armAge = sampleArmAge(model, componentIndex, distToArm, R, u1, u2, zOverH);
		if (armAge >= 0) return armAge;
		const age = p.age - sampleFormationTime(model, componentIndex, u1);
		if (componentIndex !== density.COMPONENT_THIN || !p.gasRich) return age;
		const lane = p.youngScaleHeight > 1e-3 ? p.youngScaleHeight : 1e-3;
		const zh = zOverH || 0;
		const floor = YOUNG_ARM_MAX_GYR * zh * zh / (lane * lane);
		return Math.min(p.age, Math.max(age, floor));
	}

	function sampleFieldBirth(model, seed, componentIndex, R, distToArm, z) {
		// The arm/lane gate is a spatially selected, very recent population, not
		// part of the thin disc's broad SFH window. Carry that established channel
		// forward explicitly; otherwise the inverse-CDF draw erases the OB ridge.
		if (componentIndex === density.COMPONENT_THIN) {
			let zOverH = 0;
			if (model.thin && model.thin.H > 0) {
				const H = density.discHeightAt(model.thin, R);
				if (H > 0) zOverH = (z - model.centre.z) / H;
			}
			const armAge = sampleArmAge(model, componentIndex, distToArm, R,
				hash.hash01(seed * 31 + 2), hash.hash01(seed * 31 + 3), zOverH);
			if (armAge >= 0) return galaxy.AGE_REF - armAge;
		}
		return sampleFormationTimeAtReference(model, componentIndex, hash.hash01(seed * 31 + 6));
	}

	// The seed a field star at index `i` is derived with — the renderer's
	// convention, named so the exposure calibration derives exactly the stars the
	// field will hold instead of a lookalike sample.
	function fieldStarSeed(seed, i) {
		return seed * 31 + i + 1;
	}

	// The jitter byte a field star at index `i` carries in its packed record:
	// four bits of orbit phase and four of amplitude. It is a function of the
	// index alone, so a record built anywhere from the same index is the same
	// record — the renderer and the island both call this, and the island's
	// stars then move on the app's orbit law instead of standing still.
	function fieldStarJitter(i) {
		return Math.imul(i, 2654435761) & 0xFF;
	}

	// IMF-expected luminosity (L☉) of a stellar cohort at elapsed age `ageGyr`.
	// Individual Monte Carlo draws of `evolveStar` over a 4 096-star calibration
	// prefix suffer severe giant-branch shot noise: only ~0.14 % of IMF draws sit
	// in the [1.1·tMS, 1.1·tMS + tGiant] window at any instant, each carrying
	// 100–10 100 L☉ (~98 % of total luminosity), so 1–2 calibration stars entering
	// or leaving their ~0.08 Gyr giant box (e.g. at 3.45–3.60 Gyr on Milky Way)
	// swung the global exposure offset by 4.45 mag (a 5× visible star-count drop).
	// Integrating `evolveStar` analytically over log-spaced Salpeter mass bins
	// gives the smooth conditional expectation E[L | age = T - birth] in O(1) per
	// star via a 1 025-entry table.
	const COHORT_LUM_BINS = 256;
	const COHORT_AGE_STEPS = 1024;
	const COHORT_GATE_GYR = 0.5;
	const COHORT_PRIOR_WEIGHT = 16;
	const cohortLumTable = (function buildCohortLumTable() {
		const alpha = 2.35;
		const xMin = Math.pow(0.08, 1 - alpha);
		const xMax = Math.pow(100.0, 1 - alpha);
		const cdf = (m) => {
			if (m <= 0.08) return 0;
			if (m >= 100) return 1;
			return (Math.pow(m, 1 - alpha) - xMin) / (xMax - xMin);
		};
		const logMin = Math.log(0.08);
		const logMax = Math.log(8.0);
		const du = new Float64Array(COHORT_LUM_BINS);
		const lMs = new Float64Array(COHORT_LUM_BINS);
		const tTurn = new Float64Array(COHORT_LUM_BINS);
		const tGiant = new Float64Array(COHORT_LUM_BINS);
		for (let k = 0; k < COHORT_LUM_BINS; k++) {
			const m0 = Math.exp(logMin + (k / COHORT_LUM_BINS) * (logMax - logMin));
			const m1 = Math.exp(logMin + ((k + 1) / COHORT_LUM_BINS) * (logMax - logMin));
			const m = Math.sqrt(m0 * m1);
			du[k] = cdf(m1) - cdf(m0);
			lMs[k] = luminosityFromMass(m);
			// Continuous monotonic main-sequence clock across the 2 M☉ piece
			// boundary so two mass bands do not turn off at the same age.
			const lumSmooth = m < 0.7 ? Math.pow(m, 2.3) : Math.pow(m, 3.65);
			const tms = Math.min(15.0, Math.max(0.003, 10.0 * m / lumSmooth));
			tTurn[k] = 1.1 * tms;
			tGiant[k] = Math.min(TGIANT_MAX, Math.max(TGIANT_MIN, TGIANT_FRAC * tms));
		}
		const table = new Float64Array(COHORT_AGE_STEPS + 1);
		for (let s = 0; s <= COHORT_AGE_STEPS; s++) {
			const age = (s / COHORT_AGE_STEPS) * galaxy.AGE_REF;
			let sum = 0;
			for (let k = 0; k < COHORT_LUM_BINS; k++) {
				const t0 = tTurn[k];
				const tg = tGiant[k];
				const w = Math.max(0.3, 0.25 * t0);
				const t = Math.max(0, Math.min(1, (age - (t0 - 0.5 * w)) / w));
				const ms = lMs[k] * (1 - t * t * (3 - 2 * t));
				let giant = 0;
				if (t0 < 16.0) {
					const center = t0 + 0.5 * tg;
					const gw = Math.max(tg, w);
					const x = Math.abs(age - center) / gw;
					if (x < 1) {
						giant = tg * 5100 * 0.5 * (1 + Math.cos(Math.PI * x)) / gw;
					}
				}
				const wd = age > t0
					? WD_LUM_FLOOR + 0.0505 * Math.exp(-Math.max(0, age - (t0 + tg)) / WD_COOL_TAU)
					: 0;
				sum += du[k] * (ms + giant + wd);
			}
			table[s] = sum;
		}
		return table;
	})();

	function expectedCohortLuminosity(ageGyr) {
		const u = Math.max(0, Math.min(1, ageGyr / galaxy.AGE_REF)) * COHORT_AGE_STEPS;
		const i = u < COHORT_AGE_STEPS ? u | 0 : COHORT_AGE_STEPS - 1;
		return cohortLumTable[i] + (cohortLumTable[i + 1] - cohortLumTable[i]) * (u - i);
	}

	// Mean luminosity (L☉) of the first `count` sampled positions, derived the
	// way the renderer derives them. The exposure renormalisation needs "how
	// bright is this field" as one number — at the model's age, and at the
	// reference epoch over the *same* positions — so it is a function of
	// (model, field) rather than a second sampler with its own drift. One scratch
	// record, no per-star allocation.
	const calibrationRecord = {};
	function meanFieldLuminosity(model, stars, count, births, epochAge) {
		const n = Math.min(count, stars.count);
		if (!(n > 0)) return 0;
		if (births) {
			const targetAge = Number.isFinite(epochAge) ? epochAge : ((model && model.populations && model.populations.age) || 0);
			let sum = 0;
			let weight = 0;
			for (let i = 0; i < n; i++) {
				const birth = births[i];
				const t = Math.max(0, Math.min(1, (targetAge - birth + 0.5 * COHORT_GATE_GYR) / COHORT_GATE_GYR));
				const presence = t * t * (3 - 2 * t);
				if (presence <= 0) continue;
				sum += expectedCohortLuminosity(Math.max(0, targetAge - birth)) * presence;
				weight += presence;
			}
			const priorLum = expectedCohortLuminosity(0.5 * Math.max(0, targetAge));
			return (sum + COHORT_PRIOR_WEIGHT * priorLum) / (weight + COHORT_PRIOR_WEIGHT);
		}
		let sum = 0;
		let weight = 0;
		for (let i = 0; i < n; i++) {
			deriveStar(model, fieldStarSeed(model.seed, i), stars.component[i], stars.R[i],
				stars.distToArm[i], calibrationRecord, stars.z[i]);
			sum += calibrationRecord.luminosity;
			weight += 1;
		}
		return weight > 0 ? sum / weight : 0;
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
		const tDeath = tMS * 1.1 + giantLifetimeGyr(mass);

		let state = 'ms';
		let teff;
		let lum;
		if (age > tDeath) {
			// Past the giant branch: a cooling white dwarf, fading toward
			// the floor on an 8 Gyr e-folding. A young remnant reads like
			// the old massive-channel remnant; a 13 Gyr one is faint and red.
			const cool = Math.exp(-(age - tDeath) / WD_COOL_TAU);
			state = 'wd';
			teff = WD_TEFF_FLOOR + (8000 + 30000 * uEvolve - WD_TEFF_FLOOR) * cool;
			lum = WD_LUM_FLOOR + (0.001 + 0.1 * uEvolve2) * cool;
		} else if (age > tMS * 1.1) {
			if (mass >= 8.0) {
				// Massive star past its (short) MS lifetime: remnant.
				state = 'wd';
				teff = 8000 + 30000 * uEvolve;
				lum = 0.001 + 0.1 * uEvolve2;
			} else {
				// Low/intermediate mass: red giant (red supergiant at the top).
				state = 'giant';
				teff = 3000 + 1000 * uEvolve;
				lum = 100 + 10000 * uEvolve2;
			}
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

	// Core derivation. `out` is mutated in place and returned. `z` is the
	// world-frame height; omitted, the star is derived as if it sat on the
	// midplane (the vertical gate open). Callers that have a position must
	// pass it — the exposure calibration and the renderer both do, so a
	// caller that drops it derives a different population than the sky.
	function deriveStar(model, seed, componentIndex, R, distToArm, out, z) {
		const mass = sampleMassIMF(hash.hash01(seed * 31 + 1));
		let zOverH = 0;
		if (z !== undefined && z !== null && model.thin && model.thin.H > 0) {
			const H = density.discHeightAt(model.thin, R);
			if (H > 0) zOverH = (z - model.centre.z) / H;
		}
		const age = sampleLocalAge(model, componentIndex, distToArm, R,
			hash.hash01(seed * 31 + 2), hash.hash01(seed * 31 + 3), zOverH);
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

	// Invert one observed reference record into a deterministic physical track.
	// A catalog record has no mass or birth time, so its class and magnitude
	// constrain the track while stable-key channels supply the missing draws.
	// The reference state is an interior point of the observed state interval:
	// giants and white dwarfs must not be repaired by clamping their rendered
	// class after the fact. `out` and `out.core` are caller-owned and reusable.
	function observedTrack(model, key, colorIndex, absMag, out) {
		const r = out || {};
		const core = r.core || (r.core = {});
		const uBirth = hash.hash01At(key, 16);
		const uMass = hash.hash01At(key, 17);
		const uState = hash.hash01At(key, 18);
		const cls = records.SPECTRAL_CLASSES[colorIndex] || 'M';
		const kind = cls === 'WD' ? 'wd' : (cls === 'RG' || cls === 'RGe') ? 'giant' : 'ms';
		let mass;
		let refAge;
		if (kind === 'ms') {
			mass = massFromClassAndMag(colorIndex, absMag);
			const maxAge = 1.1 * msLifetimeGyr(mass);
			const p = model.populations;
			const spanRef = galaxy.sfhSpanAt(galaxy.AGE_REF, p.quenchTime);
			const w = density.COMPONENT_THIN * 2;
			const windowLo = galaxy.FORMATION_WINDOW[w] * spanRef;
			const windowHi = galaxy.FORMATION_WINDOW[w + 1] * spanRef;
			const lo = Math.max(windowLo, galaxy.AGE_REF - maxAge);
			const hi = windowHi;
			if (hi > lo && spanRef > 0) {
				const norm = galaxy.sfhCumulative(spanRef / p.tauSfh);
				const q0 = galaxy.sfhCumulative(lo / p.tauSfh) / norm;
				const q1 = galaxy.sfhCumulative(hi / p.tauSfh) / norm;
				const formed = formationTimeAtReference(model, q0 + (q1 - q0) * uBirth);
				refAge = galaxy.AGE_REF - formed;
			} else {
				// A quenched/short window can contain no observable young MS
				// star. Keep the record observable rather than manufacturing a
				// NaN or silently turning it into a different spectral class.
				refAge = Math.min(galaxy.AGE_REF, maxAge);
			}
			if (refAge < 0) refAge = 0;
			else if (refAge > maxAge) refAge = maxAge;
		} else if (kind === 'giant') {
			// Giant luminosity is an output of the branch, not an initial-mass
			// measurement. Stay inside the pinned 1–3 M☉ prior and choose
			// an interior point of the giant interval.
			mass = 1.0 + 2.0 * uMass;
			const start = 1.1 * msLifetimeGyr(mass);
			refAge = start + giantLifetimeGyr(mass) * (0.03 + 0.94 * uState);
		} else {
			// The WD bracket in a packed record is the remnant mass. Use a
			// separate progenitor prior and an interior post-giant age.
			mass = 1.0 + 7.0 * uMass;
			const start = 1.1 * msLifetimeGyr(mass) + giantLifetimeGyr(mass);
			const available = galaxy.AGE_REF - start;
			refAge = available > 0.04
				? start + 0.02 + (available - 0.04) * uState
				: Math.min(galaxy.AGE_REF, start);
		}
		r.kind = kind;
		r.refClass = cls;
		r.refColorIndex = colorIndex;
		r.mass = mass;
		r.refAge = refAge;
		r.formedAt = galaxy.AGE_REF - refAge;
		// No thin-disc metallicity shift is applied to an observed catalog
		// colour. The thick component is only a neutral evolution context.
		evolveStar(model, key, mass, refAge, density.COMPONENT_THICK, 0, 0, core);
		r.refState = core.state;
		r.refLum = core.luminosity;
		r.refAbsMag = core.absMag;
		r.observedLum = luminosityFromMag(absMag);
		return r;
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
		}, z);
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
		MASS_TEFF_TABLE, CLASS_TEMP_BOUNDS, YOUNG_ARM_MAX_GYR, SFH_TABLE_STEPS, SFH_SOLVE_STEPS,
		classifyByTempAndState, classColor, luminosityFromMass, teffFromMass,
		CLASS_MASS_BRACKETS, massFromLuminosity, luminosityFromMag, massFromClassAndMag,
		msLifetimeGyr, giantLifetimeGyr, sampleMassIMF, sampleArmAge, sampleLocalAge, metallicityFor,
		TGIANT_FRAC, TGIANT_MIN, TGIANT_MAX, WD_COOL_TAU, WD_TEFF_FLOOR, WD_LUM_FLOOR,
		sfhFormationTime, sampleFormationTime, sampleFormationTimeAtReference, sampleFieldBirth, fieldStarSeed, fieldStarJitter, meanFieldLuminosity,
		absoluteMagnitude, evolveStar, deriveStar, deriveStarWithAge, observedTrack, derivePlanetaryCentral, deriveStarProps,
		summariseByComponent, classVsArmDistance,
	};
	if (typeof module !== 'undefined') module.exports = StarTypesLib;
	if (typeof window !== 'undefined') window.StarTypesLib = StarTypesLib;
})();
