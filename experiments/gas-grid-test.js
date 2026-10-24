// experiments/gas-grid-test.js
// 0.7.4 (F5): the gas grid from both sides.
//
// The model (src/math/gas-grid.js): the grid's geometry, its calibration, the
// burn law, path independence, the readout histogram and the endpoints the
// drawn-census account (F4) requires.
//
// The renderer (src/render/star-sprites.js): two ping-pong buffers, one compute
// dispatch per epoch delta and none when the clock is frozen, the quad draw
// with the camera lane, a rewind that re-fills instead of burning backwards,
// and the uniform lanes both passes read.
//
// The GPU cannot be reached from Node, so the renderer half runs against the
// same mock device experiments/renderer-test.js uses.
//
// Output: experiments/logs/gas-grid.json

'use strict';

const path = require('path');
const logFile = require('./log-file.js');

globalThis.window = globalThis;
globalThis.GPUBufferUsage = { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 };
globalThis.GPUTextureUsage = { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };
globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };

require('../src/math/hash.js');
require('../src/math/density.js');
require('../src/math/galaxy.js');
require('../src/math/sampling.js');
require('../src/math/star-record.js');
require('../src/math/coords.js');
require('../src/math/star-types.js');
require('../src/math/gas-grid.js');
require('../src/data/landmarks.js');
require('../src/render/shaders.js');
require('../src/stream/tile-loader.js');
require('../src/stream/cell-manager.js');
require('../src/core/camera.js');
require('../src/math/clusters.js');
require('../src/math/nebula.js');
require('../src/math/objects.js');

const gasLib = require('../src/math/gas-grid.js');
const galaxy = require('../src/math/galaxy.js');
const rendererModule = require('../src/render/star-sprites.js');
const shaders = require('../src/render/shaders.js');
const Camera = require('../src/core/camera.js');
const records = require('../src/math/star-record.js');
const density = require('../src/math/density.js');
const objects = require('../src/math/objects.js');

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
	return !!pass;
}

const TYPES = galaxy.GALAXY_TYPES;
let lookMeasurement;

// --- 1. The grid ----------------------------------------------------------
{
	check('the grid is 64 rings × 96 spokes × 4 slabs = 24 576 cells × 4 slots',
		gasLib.GAS_RINGS === 64 && gasLib.GAS_SPOKES === 96 && gasLib.GAS_SLABS === 4
		&& gasLib.GAS_CELLS === 24576 && gasLib.GAS_SLOTS === 4
		&& gasLib.GAS_FLOATS === 98304 && gasLib.GAS_BYTES === 393216,
		{ cells: gasLib.GAS_CELLS, floats: gasLib.GAS_FLOATS, bytes: gasLib.GAS_BYTES });

	// The index decomposition round-trips for every corner of the cube.
	let roundTrip = true;
	for (const [ring, spoke, slab] of [[0, 0, 0], [63, 95, 3], [17, 3, 2], [40, 60, 1]]) {
		const i = gasLib.cellIndex(ring, spoke, slab);
		roundTrip = roundTrip && gasLib.ringOfCell(i) === ring
			&& gasLib.spokeOfCell(i) === spoke && gasLib.slabOfCell(i) === slab;
	}
	check('ring/spoke/slab decompose back out of a cell index', roundTrip);

	const model = galaxy.createGalaxy({ type: 'SBb', seed: 11 });
	const geo = gasLib.geometry(galaxy.modelAtAge(model, galaxy.AGE_REF));
	check('the ring radii are log-spaced between rMin and rMax',
		Math.abs(gasLib.cellRadius(geo, 0) - geo.rMin * Math.pow(geo.rMax / geo.rMin, 0.5 / 64)) < 1e-12
		&& geo.rMax > geo.rMin && geo.rMax <= geo.discRadius + 1e-9,
		{ rMin: geo.rMin, rMax: geo.rMax });
	check('the four slabs are centred at ±1.5 H and ±0.5 H about the midplane',
		[0, 1, 2, 3].every((s) => Math.abs(gasLib.cellHeight(geo, s) - (2 * (s + 0.5) / 4 - 1) * 2 * geo.height) < 1e-12),
		[0, 1, 2, 3].map((s) => gasLib.cellHeight(geo, s)));
	check('the azimuths are the spoke centres', Math.abs(gasLib.cellAzimuth(geo, 0) - 2 * Math.PI / 96 / 2) < 1e-12);

	const weights = gasLib.cellWeights(geo);
	let sum = 0;
	for (let i = 0; i < gasLib.GAS_CELLS; i++) sum += weights[i];
	check('the gas is normalised to one over the grid', Math.abs(sum - 1) < 1e-5, sum);
	let outside = 0;
	for (let ring = 0; ring < geo.rings; ring++) {
		if (gasLib.cellRadius(geo, ring) <= geo.discRadius) continue;
		for (let spoke = 0; spoke < geo.spokes; spoke++) {
			for (let slab = 0; slab < geo.slabs; slab++) outside += weights[gasLib.cellIndex(ring, spoke, slab)];
		}
	}
	check('cells beyond the field truncation carry no gas', outside === 0, outside);

	let indexed = 0;
	for (let i = 0; i < gasLib.GAS_CELLS; i++) {
		const R = gasLib.cellRadius(geo, gasLib.ringOfCell(i));
		const phi = gasLib.cellAzimuth(geo, gasLib.spokeOfCell(i));
		if (gasLib.cellAt(geo, geo.centreX + R * Math.cos(phi), R * Math.sin(phi),
			geo.centreZ + gasLib.cellHeight(geo, gasLib.slabOfCell(i))) === i) indexed++;
	}
	check('every cell centre round-trips through the spatial inverse', indexed === gasLib.GAS_CELLS, indexed);
	const R = gasLib.cellRadius(geo, 20);
	check('the azimuth seam wraps between spoke 95 and spoke 0',
		gasLib.spokeOfCell(gasLib.cellAt(geo, geo.centreX + R, -1e-9, geo.centreZ)) === 95
		&& gasLib.spokeOfCell(gasLib.cellAt(geo, geo.centreX + R, 1e-9, geo.centreZ)) === 0);
	check('out-of-grid seats are absent, never clamped to the nearest cell',
		[[0, 0, 0], [geo.rMin - 1e-6, 0, 0], [geo.rMax + 1e-6, 0, 0],
			[R, 0, 2 * geo.height + 1e-6], [R, 0, -2 * geo.height - 1e-6], [NaN, 0, 0]]
			.every(([x, y, z]) => gasLib.cellAt(geo, geo.centreX + x, y, geo.centreZ + z) === -1));

	const cut = { ...geo, discHeight: 0.75 * geo.height };
	const cutWeights = gasLib.cellWeights(cut);
	check('slabs outside a smaller vertical truncation contain no mass or source seats',
		cutWeights.every((m, i) => gasLib.slabOfCell(i) === 0 || gasLib.slabOfCell(i) === 3 ? m === 0 : m > 0)
		&& gasLib.cellAt(cut, cut.centreX + R, 0, cut.centreZ + cut.height) === -1);

	// Independent quadrature of the radial marginal. Normalisation alone cannot
	// catch a missing dr on a log grid: it still sums to one, in the wrong place.
	const enclosed = (radius) => density.integrateDiscRadial(geo.thin, radius, geo.discHeight, 'sech2');
	const inner = enclosed(geo.rMin);
	const norm = enclosed(geo.rMax) - inner;
	const cdf = [16, 32, 48].map((edge) => {
		let mass = 0;
		for (let i = 0; i < edge * geo.spokes * geo.slabs; i++) mass += weights[i];
		return { edge, mass, exact: (enclosed(gasLib.ringEdge(geo, edge)) - inner) / norm };
	});
	check('log-ring masses match the integrated thin-disc radial CDF (including ring width)',
		cdf.every((r) => Math.abs(r.mass - r.exact) < 0.0005), cdf);
}

// --- 2. The arm law -------------------------------------------------------
{
	const model = galaxy.createGalaxy({ type: 'SBb', seed: 11 });
	const ref = galaxy.modelAtAge(model, galaxy.AGE_REF);
	const geo = gasLib.geometry(ref);
	let lo = Infinity;
	let hi = -Infinity;
	for (let ring = 0; ring < geo.rings; ring++) {
		for (let spoke = 0; spoke < geo.spokes; spoke++) {
			const b = gasLib.cellBoost(geo, ring, spoke);
			lo = Math.min(lo, b);
			hi = Math.max(hi, b);
		}
	}
	check('the arm compression spans 1−amp to 1+amp on an armed model',
		Math.abs(lo - (1 - geo.armsAmp)) < 1e-6 && Math.abs(hi - (1 + geo.armsAmp)) < 1e-6,
		{ lo, hi, amp: geo.armsAmp });
	const smooth = gasLib.geometry(galaxy.modelAtAge(galaxy.createGalaxy({ type: 'E2', seed: 11 }), galaxy.AGE_REF));
	const flat = [0, 10, 30].every((ring) => [0, 40, 80].every((spoke) => gasLib.cellBoost(smooth, ring, spoke) === 1));
	check('an unarmed type has no arm compression at all', flat && smooth.armsAmp === 0,
		{ amp: smooth.armsAmp });
}

// --- 3. The calibration and the endpoints ---------------------------------
for (const type of TYPES) {
	const model = galaxy.createGalaxy({ type, seed: 23 });
	const ref = galaxy.modelAtAge(model, galaxy.AGE_REF);
	const account = gasLib.initialize(ref, 0, model.seed);
	const total0 = gasLib.totalAtExact(account, 0);
	const totalRef = gasLib.totalAtExact(account, account.ageRef);
	const fraction = Math.max(0, Math.min(0.99, account.gasFraction));
	check(`${type}: the grid holds all the gas at T = 0`, Math.abs(total0 - 1) < 1e-6, total0);
	check(`${type}: the calibrated grid lands on the type's own gas fraction at AGE_REF`,
		Math.abs(totalRef - fraction) < 1e-4, { totalRef, fraction });
}

{
	const model = galaxy.createGalaxy({ type: 'SBb', seed: 5 });
	const ref = galaxy.modelAtAge(model, galaxy.AGE_REF);
	const account = gasLib.initialize(ref, 0, model.seed);
	const grid = new Float32Array(gasLib.GAS_FLOATS);
	gasLib.fillGrid(account, 0, model.seed, grid);
	check('the histogram total is within 0.25 % of the exact grid sum at every sampled epoch',
		[0.5, 2, 5, 9, 13.5].every((age) => {
			const exact = gasLib.totalAtExact(account, age);
			const fast = gasLib.totalAt(account, age);
			return Math.abs(fast - exact) <= 0.0025 * Math.max(exact, 1e-9);
		}),
		[0.5, 2, 5, 9, 13.5].map((age) => [age, gasLib.totalAt(account, age), gasLib.totalAtExact(account, age)]));

	// Monotone: gas only ever leaves the grid on a forward clock.
	let previous = 1.5;
	let monotone = true;
	for (let age = 0; age <= 13.5 + 1e-9; age += 0.25) {
		const total = gasLib.totalAtExact(account, age);
		monotone = monotone && total <= previous + 1e-12;
		previous = total;
	}
	check('the grid total is monotone decreasing in the epoch', monotone);

	// Path independence: the law is an exact exponential, so one step of 5 Gyr
	// lands where 500 of 10 Myr land (that is why the step can follow a slider).
	const fast = new Float32Array(gasLib.GAS_FLOATS);
	gasLib.fillGrid(account, 0, model.seed, fast);
	gasLib.step(fast, account, 5);
	const slow = new Float32Array(gasLib.GAS_FLOATS);
	gasLib.fillGrid(account, 0, model.seed, slow);
	for (let i = 0; i < 500; i++) gasLib.step(slow, account, 0.01);
	let worst = 0;
	for (let i = 0; i < gasLib.GAS_CELLS; i++) {
		worst = Math.max(worst, Math.abs(fast[i * 4] - slow[i * 4]));
	}
	check('one 5 Gyr step and 500 × 10 Myr steps land on the same masses',
		worst < 1e-6, worst);

	const direct = gasLib.fillGrid(account, 5, model.seed);
	let worstMassRel = 0, worstRateRel = 0, rateAtBoot = 0;
	for (let i = 0; i < gasLib.GAS_CELLS; i++) {
		const o = i * 4;
		worstMassRel = Math.max(worstMassRel, Math.abs(slow[o] - direct[o]) / Math.max(direct[o], 1e-30));
		worstRateRel = Math.max(worstRateRel,
			Math.abs(slow[o + 3] - direct[o + 3]) / Math.max(direct[o + 3], 1e-30),
			Math.abs(fast[o + 3] - direct[o + 3]) / Math.max(direct[o + 3], 1e-30));
		rateAtBoot += direct[o + 3];
	}
	check('one jump, 500 steps and a paused boot agree on BOTH m and s (< 2e-5 relative)',
		worstMassRel < 2e-5 && worstRateRel < 2e-5 && rateAtBoot > 0,
		{ worstMassRel, worstRateRel, rateAtBoot });
	const atZero = gasLib.fillGrid(account, 0, model.seed);
	check('First light has zero smoothed rate, even after a rewind',
		atZero.every((value, i) => i % 4 !== 3 || value === 0));
	check('cell mass cancels out of the local emission normalisation',
		Math.abs(gasLib.emissionWeight(direct[3], gasLib.rateScale(account, 0))
			- gasLib.emissionWeight(direct[7], gasLib.rateScale(account, 1))) < 1e-6);
	check('local emission is dark at zero rate and capped at the authored ceiling',
		gasLib.emissionWeight(0, 1) === 0 && gasLib.emissionWeight(100, 1) === gasLib.GAS_RATE_MAX
		&& gasLib.rateScale(account, -1) === 0);

	// The arm crest empties first: that is the picture the slice exists for.
	let crest = 0;
	let trough = 0;
	const geo = account.geometry;
	for (let ring = 0; ring < geo.rings; ring++) {
		for (let spoke = 0; spoke < geo.spokes; spoke++) {
			const boost = gasLib.cellBoost(geo, ring, spoke);
			const i = gasLib.cellIndex(ring, spoke, 0);
			if (boost > 1.05) crest += fast[i * 4];
			else if (boost < 0.95) trough += fast[i * 4];
		}
	}
	check('after the burn the arm crests hold less gas than the troughs', crest < trough,
		{ crest, trough });

	// The turbulence slot is a stable per-cell hash: the same draw gives the same
	// look, and a different seed gives a different one.
	const again = new Float32Array(gasLib.GAS_FLOATS);
	gasLib.fillGrid(account, 0, model.seed, again);
	const other = new Float32Array(gasLib.GAS_FLOATS);
	gasLib.fillGrid(account, 0, model.seed ^ 0x5f5f, other);
	let same = true;
	let differs = 0;
	for (let i = 0; i < gasLib.GAS_CELLS; i++) {
		same = same && again[i * 4 + 2] === fast[i * 4 + 2];
		if (other[i * 4 + 2] !== again[i * 4 + 2]) differs++;
	}
	check('the turbulence slot is deterministic in the draw seed', same && differs > 1000, { differs });

	// The display slot smooths the star-formation rate the step wrote.
	const sfr = fast[3];
	check('the step writes a smoothed star-formation rate into the display slot',
		Number.isFinite(sfr) && sfr > 0, sfr);
}

// The response law on its singular and short-step limits, independently of
// the model's current calibration (which might never put a cell at k = 1/tau).
{
	const a = 1 / gasLib.GAS_SMOOTH_GYR;
	const mass = 0.7, smoothed = 0.2;
	let worst = 0;
	for (const rate of [0, 1e-8, 0.15, a - 1e-7, a, a + 1e-7, 64]) {
		for (const dt of [0, 1e-9, 0.00000165, 0.00165, 0.05, 2, 13.5]) {
			const once = gasLib.rateAfter(mass, smoothed, rate, dt);
			const half = gasLib.rateAfter(mass, smoothed, rate, dt / 2);
			const twice = gasLib.rateAfter(mass * Math.exp(-rate * dt / 2), half, rate, dt / 2);
			worst = Math.max(worst, Math.abs(once - twice) / Math.max(once, 1e-30));
		}
	}
	check('the rate filter composes at tiny dt, zero burn and matching decay rates', worst < 1e-9, worst);
	const h = 0.03;
	const exact = Math.exp(-a * h) * (smoothed + a * a * mass * h);
	check('matching decay rates use the finite analytic limit',
		Math.abs(gasLib.rateAfter(mass, smoothed, a, h) - exact) < 1e-12);
	check('an empty cell keeps decaying its remaining display rate',
		gasLib.rateAfter(0, smoothed, a, h) === smoothed * Math.exp(-a * h));
}

// --- 4. The look gain ------------------------------------------------------
// `gas-cell` turns a cell's mass into linear radiance: flux = m·gain·(0.7 +
// 0.6·w), one quad of the cell's own footprint (floored at 2 px) with a
// (1 − r²)² profile, added into the HDR intermediate. Projecting that law at
// 640 × 400 is how GAS_GAIN_DEFAULT was picked, so the choice is pinned here
// with numbers instead of a sentence: T = 0 is the whole picture, AGE_REF is a
// faint haze, and the ratio between them is the type's gas fraction.
{
	const W = 640;
	const H = 400;
	const FOV_Y = Camera.FOV_Y;
	const CAM_DIST = 45;
	const FOCAL = H / Math.tan(FOV_Y * 0.5);
	const FLUX_MIN = 0.00002;
	const camera = Camera.createCamera();
	camera.forward.set([0, 0, -1]); camera.right.set([1, 0, 0]); camera.up.set([0, 1, 0]);
	const vp = camera.buildViewProj(W / H);
	const model = galaxy.createGalaxy({ type: 'SBb', seed: 7 });
	const ref = galaxy.modelAtAge(model, galaxy.AGE_REF);
	const account = gasLib.initialize(ref, 0, model.seed);
	const geo = account.geometry;
	const grid = new Float32Array(gasLib.GAS_FLOATS);
	gasLib.fillGrid(account, 0, model.seed, grid);
	// A cell's screen footprint and radiance, exactly as gas-cell computes them;
	// the pattern rotation is 0 at the epoch the projection is taken at.
	const project = (age) => {
		const image = new Float32Array(W * H);
		const heat = Math.pow(galaxy.modelAtAge(model, age).epoch.heat / ref.epoch.heat, 2);
		for (let i = 0; i < gasLib.GAS_CELLS; i++) {
			const m = grid[i * 4] * Math.exp(-account.burnC * account.rate[i] * age);
			const flux = m * rendererModule.GAS_GAIN_DEFAULT
				* (0.7 + 0.6 * Math.min(1, Math.max(0, grid[i * 4 + 2])));
			if (!(flux >= FLUX_MIN)) continue;
			const ring = gasLib.ringOfCell(i);
			const R = gasLib.cellRadius(geo, ring);
			const phi = gasLib.cellAzimuth(geo, gasLib.spokeOfCell(i));
			const world = [geo.centreX + R * Math.cos(phi), R * Math.sin(phi), geo.centreZ + gasLib.cellHeight(geo, gasLib.slabOfCell(i)) * heat];
			const eyeZ = CAM_DIST - world[2];
			if (eyeZ <= 0) continue;
			const dist = Math.hypot(world[0] - geo.centreX, world[1], eyeZ);
			const ex = world[0] - geo.centreX, ey = world[1], ez = -eyeZ;
			const cw = vp[3] * ex + vp[7] * ey + vp[11] * ez + vp[15];
			const sx = W * 0.5 * (1 + (vp[0] * ex + vp[4] * ey + vp[8] * ez + vp[12]) / cw);
			const sy = H * 0.5 * (1 - (vp[1] * ex + vp[5] * ey + vp[9] * ez + vp[13]) / cw);
			const dr = gasLib.ringEdge(geo, ring + 1) - gasLib.ringEdge(geo, ring);
			const arc = R * 2 * Math.PI / geo.spokes;
			const size = Math.max(Math.max(arc, dr) / dist * FOCAL, 2);
			const half = size * 0.5;
			const x0 = Math.max(0, Math.floor(sx - half));
			const x1 = Math.min(W, Math.ceil(sx + half));
			const y0 = Math.max(0, Math.floor(sy - half));
			const y1 = Math.min(H, Math.ceil(sy + half));
			for (let py = y0; py < y1; py++) {
				const dy = (py + 0.5 - sy) / half;
				for (let px = x0; px < x1; px++) {
					const dx = (px + 0.5 - sx) / half;
					const r2 = dx * dx + dy * dy;
					if (r2 > 1) continue;
					const s = 1 - r2;
					image[py * W + px] += flux * s * s;
				}
			}
		}
		const lit = [];
		let total = 0;
		for (let i = 0; i < image.length; i++) {
			if (!(image[i] > 0)) continue;
			lit.push(image[i]);
			total += image[i];
		}
		lit.sort((a, b) => a - b);
		return { lit: lit.length, total, median: lit[Math.floor(lit.length / 2)] || 0, p90: lit[Math.floor(lit.length * 0.9)] || 0 };
	};
	const first = project(0);
	const present = project(galaxy.AGE_REF);
	lookMeasurement = { width: W, height: H, distance: CAM_DIST, gain: rendererModule.GAS_GAIN_DEFAULT, first, present };
	check('at First light the gas covers the frame where the disc is', first.lit > Math.PI * Math.pow(geo.rMax / CAM_DIST * FOCAL * 0.5, 2) * 0.8, first);
	check('at T = 0 the median gas pixel is ~0.068 linear, p90 ~0.65 (the whole picture)',
		first.median > 0.06 && first.median < 0.075 && first.p90 > 0.58 && first.p90 < 0.72, first);
	check('at AGE_REF the median gas pixel is a faint haze, ~0.0087',
		present.median > 0.0075 && present.median < 0.010 && present.p90 > 0.07 && present.p90 < 0.10, present);
	check('the present-day haze is a small fraction of the First-light picture',
		present.total < 0.25 * first.total && first.median > 4 * present.median,
		{ firstTotal: first.total, presentTotal: present.total });
}

// --- 5. The renderer: buffers, dispatch, draw ------------------------------
function createMockGpu() {
	const gpu = {
		buffers: [], shaderModules: [], pipelines: [], uniformWrites: [], bufferWrites: [],
		passes: [], computePasses: [], draws: [], groups: [],
	};
	gpu.device = {
		limits: { maxStorageBufferBindingSize: 256 * 1024 * 1024, maxBufferSize: 256 * 1024 * 1024, maxStorageBuffersPerShaderStage: 8 },
		createBuffer(desc) {
			const buffer = { label: desc.label, size: desc.size, usage: desc.usage, destroyed: false, destroy() { this.destroyed = true; } };
			gpu.buffers.push(buffer);
			return buffer;
		},
		createShaderModule(desc) {
			gpu.shaderModules.push(desc);
			return { label: desc.label, getCompilationInfo: () => Promise.resolve({ messages: [] }) };
		},
		createTexture(desc) {
			const texture = { label: desc.label, size: desc.size, format: desc.format, destroy() {} };
			return { ...texture, createView: () => ({ texture }) };
		},
		createSampler(desc) { return { desc }; },
		createBindGroupLayout(desc) { return { desc }; },
		createPipelineLayout(desc) { return { desc }; },
		createRenderPipeline(desc) { gpu.pipelines.push(desc); return { label: desc.label }; },
		createComputePipeline(desc) { gpu.pipelines.push(desc); return { label: desc.label }; },
		createBindGroup(desc) { gpu.groups.push(desc); return { desc }; },
		createCommandEncoder() {
			return {
				beginRenderPass(desc) {
					const pass = {
						label: desc && desc.label, desc, draws: [],
						setPipeline(p) { this.pipeline = p; },
						setBindGroup(i, g) { this.group = g; },
						draw(vertices, instances) { this.draws.push({ vertices, instances }); gpu.draws.push({ pass: this.label, vertices, instances }); },
						end() {},
					};
					gpu.passes.push(pass);
					return pass;
				},
				beginComputePass(desc) {
					const pass = {
						label: desc && desc.label,
						setPipeline(p) { this.pipeline = p; },
						setBindGroup(i, g) { this.group = g; },
						dispatchWorkgroups(x, y, z) { gpu.computePasses.push({ label: this.label, x, y, z, pipeline: this.pipeline, group: this.group }); },
						end() {},
					};
					return pass;
				},
				finish() { return {}; },
			};
		},
		queue: {
			writeBuffer(buffer, offset, data, dataOffset = 0, size) {
				const length = size === undefined ? data.byteLength - dataOffset : size;
				const bytes = new Uint8Array(data.buffer || data, (data.byteOffset || 0) + dataOffset, length).slice().buffer;
				gpu.bufferWrites.push({ label: buffer.label, offset, bytes, length });
				if (buffer.label === 'gas-uniform') gpu.uniformWrites.push(new Float32Array(bytes));
			},
			writeTexture() {},
			submit() {},
		},
	};
	return gpu;
}

{
	const gpu = createMockGpu();
	// Drawn young (AGE_DEFAULT is the top of the range): the grid must have room
	// to be stepped *forward*, which is the clock a run actually walks.
	const model = galaxy.createGalaxy({ type: 'SBb', seed: 3, age: 1 });
	const renderer = rendererModule.createStarRenderer(gpu.device, { getCurrentTexture: () => ({ createView: () => ({}) }) }, 'bgra8unorm', {
		model, proceduralStars: 2000, catalogBudgetStars: 0, objectMembers: 40,
	});
	renderer.prepare(rendererModule.EMPTY_MANIFEST);

	const gridA = gpu.buffers.find((b) => b.label === 'gas-grid-a');
	const gridB = gpu.buffers.find((b) => b.label === 'gas-grid-b');
	check('a draw allocates the two ping-pong grid buffers at the model size',
		!!gridA && !!gridB && gridA.size === gasLib.GAS_BYTES && gridB.size === gasLib.GAS_BYTES,
		{ a: gridA && gridA.size, b: gridB && gridB.size });
	check('the draw uploads the grid once, into buffer A',
		gpu.bufferWrites.some((w) => w.label === 'gas-grid-a' && w.length === gasLib.GAS_BYTES)
		&& !gpu.bufferWrites.some((w) => w.label === 'gas-grid-b'),
		gpu.bufferWrites.map((w) => [w.label, w.length]));
	check('the grid step and the grid draw are separate pipelines',
		gpu.pipelines.some((p) => p.label === 'gas-step-pipeline' && p.compute)
		&& gpu.pipelines.some((p) => p.label === 'gas-cell-pipeline' && p.vertex),
		gpu.pipelines.map((p) => p.label));
	check('the draw pass is additive into the HDR intermediate',
		gpu.pipelines.filter((p) => p.label === 'gas-cell-pipeline')
			.every((p) => p.fragment.targets[0].blend.color.srcFactor === 'one'
				&& p.fragment.targets[0].blend.color.dstFactor === 'one'),
		'blend');

	const bootGrid = new Float32Array(gpu.bufferWrites.find((w) => w.label === 'gas-grid-a').bytes);
	check('a paused nonzero-age boot already uploads a live rate, not a dark grid',
		bootGrid.some((v, i) => i % 4 === 3 && v > 0));
	const nebWrite = gpu.bufferWrites.find((w) => w.label === 'nebula-storage');
	const nebView = new DataView(nebWrite.bytes);
	let linked = 0, unlinked = 0;
	for (let i = 0; i < renderer.state.nebulaBillboards; i++) {
		const o = i * objects.BILLBOARD_RECORD_BYTES;
		if (nebView.getUint32(o + 44, true)) {
			if (nebView.getInt32(o + 32, true) >= 0 && nebView.getFloat32(o + 36, true) > 0) linked++;
		} else if (nebView.getFloat32(o + 36, true) === -1) unlinked++;
	}
	check('prepare links HII seats after the grid exists and leaves stellar remnants unlinked',
		linked > 0 && unlinked > 0, { linked, unlinked });
	const membersBefore = renderer.starBlocks().view.buffer.slice(0);
	const fieldDrawsBefore = renderer.state.fieldSamples;
	const writesOf = (label) => gpu.bufferWrites.filter((w) => w.label === label).length;
	const nebWritesBefore = writesOf('nebula-storage');
	const nebPass = () => gpu.passes.filter((p) => p.label === 'nebula-billboards').at(-1);

	const camera = Camera.createCamera();
	camera.cameraPos.set([8.178, 0, 0.01]);
	const input = { actions: {} };

	// A frozen clock: no dispatch, but the grid is still drawn.
	const before = gpu.computePasses.length;
	renderer.render(camera, 640, 400, 5, input, 0);
	check('a frozen clock dispatches no gas step', gpu.computePasses.length === before,
		gpu.computePasses.map((p) => p.label));
	const gasDraw = gpu.draws.filter((d) => d.pass === 'gas-grid');
	check('the grid is drawn as one instanced quad pass over every cell',
		gasDraw.length === 1 && gasDraw[0].instances === gasLib.GAS_CELLS && gasDraw[0].vertices === 4,
		gasDraw);

	check('the frozen nebula pass reads the boot grid A',
		nebPass().group.desc.entries[2].resource.buffer === gridA);

	// A forward epoch: exactly one dispatch, one workgroup per 64 cells.
	const drawsBefore = gpu.draws.length;
	renderer.setEpoch(galaxy.modelAtAge(model, 2));
	renderer.render(camera, 640, 400, 6, input, 0);
	const steps = gpu.computePasses.filter((p) => p.label === 'gas-step');
	check('an epoch step dispatches the burn once, ceil(cells / 64) workgroups',
		steps.length === 1 && steps[0].x === Math.ceil(gasLib.GAS_CELLS / 64),
		steps.map((s) => [s.x, s.y, s.z]));
	check('the step reads buffer A and writes B on the first step',
		steps[0].group && steps[0].group.desc.entries[1].resource.buffer.label === 'gas-grid-a'
		&& steps[0].group.desc.entries[2].resource.buffer.label === 'gas-grid-b',
		steps[0].group && steps[0].group.desc.label);
	check('the frame still draws the grid after the step', gpu.draws.length > drawsBefore);
	check('the HII pass reads B in the very frame the first step writes B',
		nebPass().group.desc.entries[2].resource.buffer === gridB);

	// Second step: the ping-pong swaps, and the draw reads the buffer the step
	// just wrote (no frame ever draws a half-updated grid).
	renderer.setEpoch(galaxy.modelAtAge(model, 3));
	renderer.render(camera, 640, 400, 7, input, 0);
	const second = gpu.computePasses.filter((p) => p.label === 'gas-step')[1];
	check('the second step swaps the ping-pong pair', second
		&& second.group.desc.entries[1].resource.buffer.label === 'gas-grid-b'
		&& second.group.desc.entries[2].resource.buffer.label === 'gas-grid-a',
		second && second.group.desc.label);
	const gasDraws = gpu.passes.filter((p) => p.label === 'gas-grid');
	const lastDraw = gasDraws[gasDraws.length - 1];
	check('the draw after a step reads the buffer the step wrote',
		lastDraw && lastDraw.group.desc.entries[1].resource.buffer.label === 'gas-grid-a',
		lastDraw && lastDraw.group.desc.label);

	check('the HII pass follows the second ping-pong swap back to A',
		nebPass().group.desc.entries[2].resource.buffer === gridA);

	// The step's dt is the epoch delta, not the frame's wall clock.
	const uniforms = gpu.bufferWrites.filter((w) => w.label === 'gas-uniform');
	const last = uniforms[uniforms.length - 1];
	const lanes = new Float32Array(last.bytes.slice(0));
	check('the step uniform carries the epoch delta as dt',
		Math.abs(lanes[0] - 1) < 1e-6, { dt: lanes[0] });
	check('the step uniform carries the calibrated burn and the arm law',
		lanes[1] > 0 && lanes[3] === Math.fround(gasLib.geometry(galaxy.modelAtAge(model, galaxy.AGE_REF)).armsAmp),
		{ burnC: lanes[1], amp: lanes[3] });
	check('the rate response uniform is 1 / tau in Gyr, not a per-frame fraction',
		lanes[2] === Math.fround(1 / gasLib.GAS_SMOOTH_GYR), lanes[2]);
	check('the grid uniform carries the cell count and the look gain',
		lanes[13] === gasLib.GAS_CELLS && lanes[14] === rendererModule.GAS_GAIN_DEFAULT,
		{ cells: lanes[13], gain: lanes[14] });

	// A rewind re-fills from the epoch instead of burning backwards: no dispatch,
	// a fresh upload, and the same masses a forward run would have.
	const rewindsBefore = gpu.computePasses.length;
	const uploadsBefore = gpu.bufferWrites.filter((w) => w.label === 'gas-grid-a').length;
	renderer.setEpoch(galaxy.modelAtAge(model, 0.5));
	renderer.render(camera, 640, 400, 8, input, 0);
	check('a rewound clock re-fills the grid instead of stepping it backwards',
		gpu.computePasses.length === rewindsBefore
		&& gpu.bufferWrites.filter((w) => w.label === 'gas-grid-a').length === uploadsBefore + 1,
		{ steps: gpu.computePasses.length - rewindsBefore });

	const refAccount = gasLib.initialize(galaxy.modelAtAge(model, galaxy.AGE_REF), 0.5, model.seed);
	const refGrid = gasLib.fillGrid(refAccount, 0.5, model.seed);
	const rewindGrid = new Float32Array(gpu.bufferWrites.filter((w) => w.label === 'gas-grid-a').at(-1).bytes);
	check('rewind uploads the analytic rate as well as the mass and binds that refill for HII',
		rewindGrid.every((v, i) => v === refGrid[i]) && nebPass().group.desc.entries[2].resource.buffer === gridA);

	// The readout account: the grid's own mass against the drawn-census gas.
	const accountAt = renderer.gasAccountAt(1);
	check('the account reports the grid total, the census gas and their drift',
		!!accountAt && Number.isFinite(accountAt.total) && Number.isFinite(accountAt.gas)
			&& accountAt.total > 0 && accountAt.total < 1
			&& Math.abs(accountAt.drift - (accountAt.total - accountAt.gas)) < 1e-12,
		accountAt && { total: accountAt.total, gas: accountAt.gas, drift: accountAt.drift });
	const atZero = renderer.gasAccountAt(0);
	check('the grid and the census are both exactly all-gas at T = 0',
		Math.abs(atZero.total - 1) < 1e-6 && atZero.gas === 1, atZero && { total: atZero.total, gas: atZero.gas });

	// Visibility: off skips the pass entirely and leaves the state readable.
	const gasPasses = () => gpu.draws.filter((d) => d.pass === 'gas-grid').length;
	renderer.setGasVisible(false);
	const hiddenBefore = gasPasses();
	const hiddenSteps = gpu.computePasses.length;
	renderer.setEpoch(galaxy.modelAtAge(model, 1));
	renderer.render(camera, 640, 400, 9, input, 0);
	check('hiding the grid draws no gas pass',
		gasPasses() === hiddenBefore && renderer.gasGridInfo().visible === false,
		{ gasPasses: gasPasses(), visible: renderer.gasGridInfo().visible });
	check('hiding the haze keeps the burn running and the HII source connected',
		gpu.computePasses.length === hiddenSteps + 1 && nebPass().group.desc.entries[2].resource.buffer === gridB);
	renderer.setGasVisible(true);
	const shownBefore = gasPasses();
	renderer.render(camera, 640, 400, 10, input, 0);
	check('showing it again restores the pass', gasPasses() === shownBefore + 1,
		{ gasPasses: gasPasses() });

	// One more forward epoch so the info has a step to report after the rewind.
	renderer.setEpoch(galaxy.modelAtAge(model, 1.5));
	renderer.render(camera, 640, 400, 11, input, 0);

	// The info object is the HUD's view: live numbers, no allocation per call.
	const info = renderer.gasGridInfo();
	check('the grid info reports cells, steps, age and the calibrated burn',
		info.cells === gasLib.GAS_CELLS && info.steps >= 1 && info.age > 0 && info.burnC > 0,
		{ ...info });

	const block = renderer.starBlocks().blocks.find((b) => b.kind === 'object');
	const start = block.offset * records.RECORD_BYTES;
	const length = block.count * records.RECORD_BYTES;
	const beforeMembers = new Uint8Array(membersBefore, start, length);
	const afterMembers = new Uint8Array(renderer.starBlocks().view.buffer, start, length);
	check('local emission changes never rewrite object seats or billboard records or resample the field',
		beforeMembers.every((v, i) => v === afterMembers[i]) && writesOf('nebula-storage') === nebWritesBefore
		&& renderer.state.fieldSamples === fieldDrawsBefore);

	const oldNebula = gpu.buffers.filter((b) => b.label === 'nebula-storage').at(-1);
	renderer.regenerate(galaxy.createGalaxy({ type: 'SBc', seed: 19, age: 0.5 }));
	renderer.render(camera, 640, 400, 12, input, 0);
	const newNebula = gpu.buffers.filter((b) => b.label === 'nebula-storage').at(-1);
	check('a new field rebuilds nebula bindings without duplicating the gas pair',
		oldNebula.destroyed && newNebula !== oldNebula && nebPass().group.desc.entries[1].resource.buffer === newNebula
		&& nebPass().group.desc.entries[2].resource.buffer === gridA
		&& gpu.buffers.filter((b) => b.label === 'gas-grid-a').length === 1);

	renderer.dispose();
	check('dispose destroys both grid buffers', gridA.destroyed && gridB.destroyed,
		{ a: gridA.destroyed, b: gridB.destroyed });
}

// Missing-module and explicit-disable paths both keep a valid storage binding.
for (const missing of [true, false]) {
	const gpu = createMockGpu();
	const saved = window.GasGridLib;
	if (missing) delete window.GasGridLib;
	const renderer = rendererModule.createStarRenderer(gpu.device, { getCurrentTexture: () => ({ createView: () => ({}) }) }, 'bgra8unorm', {
		model: galaxy.createGalaxy({ type: 'SBb', seed: 3 }), proceduralStars: 200, catalogBudgetStars: 0,
		objectMembers: 20, objectCount: 40, gasGrid: missing,
	});
	window.GasGridLib = saved;
	renderer.prepare(rendererModule.EMPTY_MANIFEST);
	const camera = Camera.createCamera();
	renderer.render(camera, 320, 200, 1, { actions: {} }, 0);
	check('a renderer without the gas model still boots and draws no grid',
		renderer.state.gasCells === 0 && gpu.passes.every((p) => p.label !== 'gas-grid'),
		gpu.passes.map((p) => p.label));
	check('the disabled grid reports itself disabled', renderer.gasGridInfo().enabled === false,
		renderer.gasGridInfo());
	const dummy = gpu.buffers.find((b) => b.label === 'gas-grid-empty');
	const group = gpu.passes.find((p) => p.label === 'nebula-billboards').group;
	const packed = new DataView(gpu.bufferWrites.find((w) => w.label === 'nebula-storage').bytes);
	let unmodulated = true;
	for (let i = 0; i < renderer.state.nebulaBillboards; i++) {
		unmodulated = unmodulated && packed.getFloat32(i * objects.BILLBOARD_RECORD_BYTES + 36, true) === -1;
	}
	check('a disabled grid binds one empty vec4 and packs unmodulated emission',
		!!dummy && dummy.size === 16 && group.desc.entries[2].resource.buffer === dummy
		&& renderer.state.nebulaBillboards > 0 && unmodulated, { missing });
	renderer.dispose();
	check('dispose also destroys the disabled-grid binding', dummy.destroyed, { missing });
}

// --- 6. Report ------------------------------------------------------------
let passed = 0;
let failed = 0;
for (const c of checks) {
	if (c.pass) passed++; else failed++;
	console.log(`  ${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.pass ? '' : `  -> ${JSON.stringify(c.detail)}`}`);
}
console.log(`\n${passed}/${checks.length} passed, ${failed} failed`);

const logPath = path.join(__dirname, 'logs', 'gas-grid.json');
logFile.writeLog(logPath, {
	date: new Date().toISOString(),
	totalChecks: checks.length,
	passed,
	failed,
	lookMeasurement,
	checks: checks.map((c) => ({ name: c.name, pass: c.pass, detail: c.pass ? undefined : c.detail })),
});
console.log('\n=== VERDICT ===');
console.log(failed === 0
	? 'PASS — the gas is a calibrated grid the GPU steps and draws, and the CPU accounts for'
	: `FAIL — ${failed} checks failed`);
process.exit(failed === 0 ? 0 : 1);
