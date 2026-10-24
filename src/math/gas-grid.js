// src/math/gas-grid.js
// Reference-frame gas cells: calibrated exponential depletion and a 0.05 Gyr
// response to the instantaneous SFR. Both m and s compose in epoch time, so a
// paused boot, slider jump and running clock land on the same state.
//
// Setup/on-demand CPU model of gas-step / gas-cell. The histogram supplies the
// O(256) total readout; HII billboards read the GPU's local s, without readback.

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

	const GAS_RINGS = 64;
	const GAS_SPOKES = 96;
	const GAS_SLABS = 4;
	const GAS_CELLS = GAS_RINGS * GAS_SPOKES * GAS_SLABS;
	const GAS_SLOTS = 4;                    // m, Z, w, s
	const GAS_FLOATS = GAS_CELLS * GAS_SLOTS;
	const GAS_BYTES = GAS_FLOATS * 4;       // 393 216 = 384 KB
	const GAS_R_MIN_FRAC = 0.02;            // inner edge, · discRadius
	const GAS_R_MAX_FRAC = 1.0;             // the field's own truncation radius
	const GAS_SLAB_REACH = 2.0;             // z ∈ ±2 H
	const GAS_ARM_POWER = 1.5;              // the Schmidt–Kennicutt exponent
	const GAS_SMOOTH_GYR = 0.05;            // ds/dT = (rate·m − s) / tau
	const GAS_SFR_NORMAL = -Math.log(galaxy.GAS_NORMAL) * galaxy.GAS_NORMAL / galaxy.AGE_REF;
	const GAS_RATE_MAX = 4;                 // HII emission look ceiling
	const GAS_Z_GRADIENT = 0.65;            // relative enrichment, centre → edge
	const GAS_TURBULENCE_MIN = 0.75;
	const GAS_TURBULENCE_SPAN = 0.5;
	const GAS_BURN_CEILING = 64.0;          // per Gyr; the bisection's top end
	const GAS_BURN_ITERATIONS = 40;
	// The rate histogram: m0 summed per boost bin. 256 bins over the boost range
	// makes `totalAt` an O(256) sum instead of an O(24 576) one, so the readout
	// can follow a live clock; the error is pinned against the exact sum in the
	// test (0.25 % of the grid's mass, the same budget F4's birth histogram uses).
	const GAS_RATE_BINS = 256;
	const TAU = 2 * Math.PI;

	// Cell index: slab is the fastest axis so a column's four slabs are adjacent
	// — the geometry and its inverse share one layout.
	function cellIndex(ring, spoke, slab) {
		return (ring * GAS_SPOKES + spoke) * GAS_SLABS + slab;
	}
	function ringOfCell(index) {
		return (index / (GAS_SPOKES * GAS_SLABS)) | 0;
	}
	function spokeOfCell(index) {
		return ((index / GAS_SLABS) | 0) % GAS_SPOKES;
	}
	function slabOfCell(index) {
		return index % GAS_SLABS;
	}

	// The gas lives in the reference frame, like every other drawn number: the
	// component shares, the truncation and the vertical scale are the field's
	// own reference epoch's, and the running epoch reaches the grid only through
	// the pattern rotation and the exposure of the draw.
	function geometry(reference) {
		const ref = reference || galaxy.MILKY_WAY;
		const thin = ref.thin || { L: 2.6, H: 0.3 };
		const arms = ref.arms || { m: 0, pitchDeg: 0, Rs: 1, phase0: 0, amp: 0 };
		const trunc = ref.truncation || { discRadius: 25, discHeight: 3 };
		const base = ref.epochBase || {};
		const pops = ref.populations || {};
		const pitch = Number(arms.pitchDeg) > 0 ? arms.pitchDeg * Math.PI / 180 : 0;
		const armed = arms.amp > 0 && arms.m > 0 && pitch > 0 && arms.Rs > 0;
		const height = Number(base.thinH) > 0 ? base.thinH : thin.H;
		return {
			rings: GAS_RINGS,
			spokes: GAS_SPOKES,
			slabs: GAS_SLABS,
			cells: GAS_CELLS,
			rMin: GAS_R_MIN_FRAC * trunc.discRadius,
			rMax: GAS_R_MAX_FRAC * trunc.discRadius,
			discRadius: trunc.discRadius,
			discHeight: trunc.discHeight,
			height: height > 0 ? height : 0.3,
			centreX: ref.centre ? ref.centre.x : 0,
			centreZ: ref.centre ? ref.centre.z : 0,
			armsM: armed ? arms.m : 0,
			armsK: armed ? arms.m / Math.tan(pitch) : 0,
			armsRs: armed ? arms.Rs : 1,
			armsPhase0: armed ? arms.phase0 : 0,
			armsAmp: armed ? arms.amp : 0,
			gasFraction: Number.isFinite(pops.gasFraction) ? pops.gasFraction : galaxy.MILKY_WAY.populations.gasFraction,
			ageRef: galaxy.AGE_REF,
			thin: thin,
			seed: ref.seed | 0,
		};
	}

	function ringEdge(geo, edge) {
		return geo.rMin * Math.pow(geo.rMax / geo.rMin, edge / geo.rings);
	}
	function cellRadius(geo, ring) {
		return geo.rMin * Math.pow(geo.rMax / geo.rMin, (ring + 0.5) / geo.rings);
	}
	function cellAzimuth(geo, spoke) {
		return TAU * (spoke + 0.5) / geo.spokes;
	}
	function cellHeight(geo, slab) {
		return ((slab + 0.5) / geo.slabs * 2 - 1) * GAS_SLAB_REACH * geo.height;
	}

	// Invert the carried reference seat, never its camera-relative position.
	// An out-of-grid HII region has no source cell; do not alias it to an edge.
	function cellAt(geo, x, y, z) {
		const dx = x - geo.centreX;
		const dz = z - geo.centreZ;
		const R = Math.hypot(dx, y);
		if (!(R >= geo.rMin && R < geo.rMax) || !Number.isFinite(dz)
			|| Math.abs(dz) > geo.discHeight || dz < -GAS_SLAB_REACH * geo.height
			|| dz >= GAS_SLAB_REACH * geo.height) return -1;
		const ring = Math.min(geo.rings - 1, Math.floor(Math.log(R / geo.rMin) / Math.log(geo.rMax / geo.rMin) * geo.rings));
		const phi = Math.atan2(y, dx);
		const spoke = Math.min(geo.spokes - 1, Math.floor((phi < 0 ? phi + TAU : phi) / TAU * geo.spokes));
		const slab = Math.min(geo.slabs - 1, Math.floor((dz / (GAS_SLAB_REACH * geo.height) + 1) * 0.5 * geo.slabs));
		return cellIndex(ring, spoke, slab);
	}

	function rateScale(account, index) {
		const m0 = index >= 0 ? account.weights[index] : 0;
		return m0 > 0 ? 1 / (m0 * GAS_SFR_NORMAL) : 0;
	}

	function emissionWeight(rate, scale) {
		return Math.min(GAS_RATE_MAX, Math.max(0, rate * scale));
	}

	// The arm compression of one cell: the field's own ridge law
	// (density.armFactor's cosine) in the cell's azimuth. 1−amp in the trough, 1+amp
	// on the crest; 1 everywhere for a smooth disc (S0, E, Irr).
	function cellBoost(geo, ring, spoke) {
		if (!(geo.armsAmp > 0) || !(geo.armsM > 0)) return 1;
		const R = cellRadius(geo, ring);
		const phi = cellAzimuth(geo, spoke);
		const arg = geo.armsM * phi - geo.armsK * Math.log(R / geo.armsRs) + geo.armsPhase0;
		return Math.max(0, 1 + geo.armsAmp * Math.cos(arg));
	}

	// The gas mass a cell starts with: the thin disc's own profile, weighted by
	// the vertical slab and the cell's share of the ring. Normalised to 1 over
	// the grid, which is what makes `total(T)` absolute rather than relative.
	// Cells outside the field's truncation stay empty — the sampler draws no
	// stars there either, and the plan's one truncation rule covers the gas.
	function cellWeights(geo, out) {
		const weights = out || new Float32Array(GAS_CELLS);
		const zMax = geo.discHeight;
		let sum = 0;
		for (let ring = 0; ring < geo.rings; ring++) {
			const R = cellRadius(geo, ring);
			const dr = ringEdge(geo, ring + 1) - ringEdge(geo, ring);
			const radial = R <= geo.discRadius
				? density.discRadialWeight(geo.thin, R, zMax, 'sech2') * dr : 0;
			for (let slab = 0; slab < geo.slabs; slab++) {
				const z = cellHeight(geo, slab);
				const sech = 1 / Math.cosh(z / geo.height);
				const vertical = Math.abs(z) <= zMax ? sech * sech : 0;
				const weight = radial * vertical;
				for (let spoke = 0; spoke < geo.spokes; spoke++) {
					const i = cellIndex(ring, spoke, slab);
					weights[i] = weight;
					sum += weight;
				}
			}
		}
		if (sum > 0) {
			for (let i = 0; i < GAS_CELLS; i++) weights[i] /= sum;
		}
		return weights;
	}

	// The total mass a grid drawn at T = 0 would have at `age`: the calibration
	// reads this against the model's own gas fraction.
	function calibratedTotal(weights, rate, burnC, age) {
		let total = 0;
		for (let i = 0; i < GAS_CELLS; i++) {
			const m = weights[i];
			if (m > 0) total += m * Math.exp(-burnC * rate[i] * age);
		}
		return total;
	}

	// Solve `total(AGE_REF) = gasFraction` for burnC. Monotone decreasing in
	// burnC, so a bisection is exact to the last iteration; a grid that cannot
	// reach the fraction (a permanent-gas trough above it) lands on the ceiling
	// and reports it, rather than pretending.
	function calibrate(weights, rate, gasFraction, ageRef) {
		// A gas-free type (an E at the reference epoch) has a target of 0, which
		// an exponential only reaches asymptotically: the ceiling is the honest
		// answer, and the grid is empty to f32 precision by then.
		const finite = Number.isFinite(gasFraction) ? gasFraction : 0.15;
		const target = Math.min(0.99, Math.max(0, finite));
		let lo = 0;
		let hi = GAS_BURN_CEILING;
		if (target === 0 || calibratedTotal(weights, rate, hi, ageRef) > target) {
			return { burnC: hi, clamped: target !== 0 };
		}
		for (let i = 0; i < GAS_BURN_ITERATIONS; i++) {
			const mid = 0.5 * (lo + hi);
			if (calibratedTotal(weights, rate, mid, ageRef) > target) lo = mid;
			else hi = mid;
		}
		return { burnC: 0.5 * (lo + hi), clamped: false };
	}

	// The 256-bin rate histogram the readout integrates. `rate` is already
	// boost^1.5, so the bins cover exactly the calibrated law's argument.
	function buildBins(weights, rate) {
		const mass = new Float64Array(GAS_RATE_BINS);
		const momentum = new Float64Array(GAS_RATE_BINS);
		let maxRate = 0;
		for (let i = 0; i < GAS_CELLS; i++) {
			if (!(weights[i] > 0)) continue;
			if (rate[i] > maxRate) maxRate = rate[i];
		}
		if (!(maxRate > 0)) maxRate = 1;
		for (let i = 0; i < GAS_CELLS; i++) {
			const m = weights[i];
			if (!(m > 0)) continue;
			let bin = Math.floor(rate[i] / maxRate * (GAS_RATE_BINS - 1));
			if (bin < 0) bin = 0;
			else if (bin >= GAS_RATE_BINS) bin = GAS_RATE_BINS - 1;
			mass[bin] += m;
			momentum[bin] += m * rate[i];
		}
		const centre = new Float64Array(GAS_RATE_BINS);
		for (let b = 0; b < GAS_RATE_BINS; b++) {
			if (mass[b] > 0) centre[b] = momentum[b] / mass[b];
		}
		return { count: GAS_RATE_BINS, mass: mass, rate: centre };
	}

	// Draw the gas for one field: the account (weights, rates, calibration and
	// histogram) plus a grid filled at `age`. Setup-time only — this is what a
	// `regenerate` or a boot costs, not a frame.
	function initialize(reference, age, seed, grid) {
		const geo = geometry(reference);
		const out = grid || new Float32Array(GAS_FLOATS);
		const weights = cellWeights(geo);
		const rate = new Float32Array(GAS_CELLS);
		for (let ring = 0; ring < geo.rings; ring++) {
			for (let spoke = 0; spoke < geo.spokes; spoke++) {
				const boost = cellBoost(geo, ring, spoke);
				const powered = Math.pow(boost, GAS_ARM_POWER);
				for (let slab = 0; slab < geo.slabs; slab++) {
					rate[cellIndex(ring, spoke, slab)] = powered;
				}
			}
		}
		const solve = calibrate(weights, rate, geo.gasFraction, geo.ageRef);
		const account = {
			geometry: geo,
			weights: weights,
			rate: rate,
			burnC: solve.burnC,
			clamped: solve.clamped,
			gasFraction: geo.gasFraction,
			ageRef: geo.ageRef,
			bins: buildBins(weights, rate),
			age: 0,
		};
		fillGrid(account, age, seed | 0, out);
		return account;
	}

	// Fill a grid with the gas a draw at T = 0 has at `age`: the burn is a pure
	// function of the epoch, so a rewind (or a boot at `?age=`) is the same fill
	// as the one a run would have integrated to.
	function fillGrid(account, age, seed, out) {
		const grid = out || new Float32Array(GAS_FLOATS);
		const t = Number.isFinite(age) && age > 0 ? age : 0;
		const geo = account.geometry;
		const burnC = account.burnC;
		const zSpan = geo.discRadius > 0 ? 1 / geo.discRadius : 0;
		for (let i = 0; i < GAS_CELLS; i++) {
			const o = i * GAS_SLOTS;
			const m0 = account.weights[i];
			grid[o] = m0 * Math.exp(-burnC * account.rate[i] * t);
			const R = cellRadius(geo, ringOfCell(i));
			// Relative enrichment, centre to edge — readout only in this series:
			// no birth tier reads the grid's Z yet.
			grid[o + 1] = 1 - GAS_Z_GRADIENT * Math.min(1, R * zSpan);
			grid[o + 2] = GAS_TURBULENCE_MIN
				+ GAS_TURBULENCE_SPAN * hash.hash01At(hash.pcgHash((seed | 0) ^ i), 0);
			grid[o + 3] = rateAfter(m0, 0, burnC * account.rate[i], t);
		}
		account.age = t;
		return grid;
	}

	// Exact convolution of an exponentially falling source with an exponential
	// response. The small-x series avoids cancellation at frame-sized dt and
	// covers rate = 1/tau; factoring by min(rate, a) avoids overflow at large dt.
	function rateAfter(mass, smoothed, rate, dt) {
		const a = 1 / GAS_SMOOTH_GYR;
		const x = Math.abs(a - rate) * dt;
		const phi = x < 0.01 ? 1 - x / 2 + x * x / 6 - x * x * x / 24
			: (1 - Math.exp(-x)) / x;
		const integral = dt * Math.exp(-Math.min(rate, a) * dt) * phi;
		return smoothed * Math.exp(-a * dt) + a * rate * mass * integral;
	}

	// The CPU mirror of the WGSL step. In place: the ping-pong pair on the GPU
	// is a buffer-safety measure, not part of the law.
	function step(grid, account, dt) {
		const h = Number(dt);
		if (!(h > 0)) return grid;
		const burnC = account.burnC;
		const rate = account.rate;
		for (let i = 0; i < GAS_CELLS; i++) {
			const o = i * GAS_SLOTS;
			const m = grid[o];
			const k = burnC * rate[i];
			grid[o] = m * Math.exp(-k * h);
			grid[o + 3] = rateAfter(m, grid[o + 3], k, h);
		}
		account.age += h;
		return grid;
	}

	function total(grid) {
		let sum = 0;
		for (let i = 0; i < GAS_CELLS; i++) sum += grid[i * GAS_SLOTS];
		return sum;
	}

	// The grid's total at `age`, O(256): the readout's own account. Exact at
	// T = 0 (1); the binned AGE_REF sum matches gasFraction within histogram error.
	function totalAt(account, age) {
		const t = Number.isFinite(age) ? age : account.age;
		if (t <= 0) return 1;
		const bins = account.bins;
		let sum = 0;
		for (let b = 0; b < bins.count; b++) {
			const mass = bins.mass[b];
			if (mass > 0) sum += mass * Math.exp(-account.burnC * bins.rate[b] * t);
		}
		return sum;
	}

	// The same sum by brute force, for the test that pins the histogram.
	function totalAtExact(account, age) {
		const t = Number.isFinite(age) && age > 0 ? age : 0;
		return calibratedTotal(account.weights, account.rate, account.burnC, t);
	}

	const GasGridLib = {
		GAS_RINGS, GAS_SPOKES, GAS_SLABS, GAS_CELLS, GAS_SLOTS, GAS_FLOATS, GAS_BYTES,
		GAS_R_MIN_FRAC, GAS_R_MAX_FRAC, GAS_SLAB_REACH, GAS_ARM_POWER,
		GAS_SMOOTH_GYR, GAS_SFR_NORMAL, GAS_RATE_MAX, GAS_Z_GRADIENT, GAS_TURBULENCE_MIN, GAS_TURBULENCE_SPAN,
		GAS_BURN_CEILING, GAS_RATE_BINS,
		cellIndex, ringOfCell, spokeOfCell, slabOfCell,
		geometry, ringEdge, cellRadius, cellAzimuth, cellHeight, cellBoost, cellAt,
		rateScale, emissionWeight, rateAfter,
		cellWeights, calibrate, initialize, fillGrid, step, total, totalAt, totalAtExact,
	};
	if (typeof module !== 'undefined') module.exports = GasGridLib;
	if (typeof window !== 'undefined') window.GasGridLib = GasGridLib;
})();
