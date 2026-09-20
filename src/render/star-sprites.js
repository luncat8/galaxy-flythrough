// src/render/star-sprites.js
// Path B: additive point sprites for every star the frame needs — the streamed
// catalog cells plus the procedural field behind them.
//
// Buffer layout (one storage buffer, one draw call):
//
//   [0 .. proceduralCount)                          procedural field, once
//   [proceduralCount .. + landmarkCount)            named landmarks, once
//   [proceduralCount + landmarkCount .. + resident) resident catalog cells,
//                                                   rewritten when the camera
//                                                   crosses a cell
//
// Landmarks sit in their own fixed block because Gaia saturates on the
// brightest stars — the catalog subset cannot be assumed to contain them
// (see data/landmarks.js). The three blocks keep the drawn instance range
// contiguous: `draw(4, proceduralCount + landmarkCount + residentCatalog)`.
// No hidden slots, no per-cell GPU allocation, no compaction pass.
//
// Frame cost: one 112-byte uniform write, one catalog buffer write (only when
// the resident set changed), one render pass with no depth attachment — the
// sprites are additive, so there is nothing to depth-test against, and writing
// depth for them would only cost bandwidth.

'use strict';

const UNIFORM_FLOATS = 28;              // 112 bytes, see star-sprite WGSL
const PROCEDURAL_STARS_DEFAULT = 300000;
const CATALOG_BUDGET_DEFAULT = 250000;
const BASE_SIZE_PX = 2.2;
const MAX_SIZE_PX = 32.0;
const EXPOSURE_MIN = 0.0;
const EXPOSURE_MAX = 40.0;
const EXPOSURE_DEFAULT = 17.0;
const EXPOSURE_STEP = 0.75;
const MAX_FRAME_DT = 0.1;

// A cell manager must exist before a catalog is attached; this keeps the
// renderer constructible in "procedural only" runs and in Node tests.
const EMPTY_MANIFEST = {
	version: 1,
	source: 'none',
	cellCount: 0,
	starCount: 0,
	bandNames: [],
	bands: {},
	bandRadius: new Float32Array(0),
	bandOf: new Uint8Array(0),
	cellSize: new Float32Array(0),
	origin: new Float32Array(0),
	firstStar: new Uint32Array(1),
	payloads: [],
};

function createStarRenderer(device, context, format, options) {
	const opts = options || {};
	const records = window.StarRecord;
	const landmarks = window.Landmarks;
	if (!landmarks || !landmarks.count) {
		throw new Error('Landmarks data missing: index.html must load data/landmarks.js before render/star-sprites.js');
	}
	const landmarkCount = landmarks.count;
	const seed = opts.seed === undefined ? 42 : opts.seed;
	const proceduralTarget = Math.max(0, opts.proceduralStars === undefined ? PROCEDURAL_STARS_DEFAULT : opts.proceduralStars);
	const catalogBudget = Math.max(0, opts.catalogBudgetStars === undefined ? CATALOG_BUDGET_DEFAULT : opts.catalogBudgetStars);

	const maxStorageBytes = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);

	// --- Shader + pipeline ------------------------------------------------
	const shaderModule = device.createShaderModule({
		label: 'star-sprite',
		code: window.GalaxyShaders.SHADERS['star-sprite'],
	});
	let shaderError = null;
	shaderModule.getCompilationInfo().then((info) => {
		for (const message of info.messages) {
			if (message.type !== 'error') continue;
			shaderError = `${message.lineNum}:${message.linePos} ${message.message}`;
			console.error('WGSL error in star-sprite:', shaderError);
		}
	}).catch(() => {});

	const uniformBuffer = device.createBuffer({
		label: 'star-camera-uniform',
		size: UNIFORM_FLOATS * 4,
		usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
	});
	const uniformData = new ArrayBuffer(UNIFORM_FLOATS * 4);
	const uniform = new Float32Array(uniformData);

	const lutTexture = device.createTexture({
		label: 'star-color-lut',
		size: [256, 1],
		format: 'rgba8unorm',
		usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
	});
	device.queue.writeTexture(
		{ texture: lutTexture },
		records.buildColorLUT(),
		{ bytesPerRow: 256 * 4, rowsPerImage: 1 },
		[256, 1],
	);

	const bindGroupLayout = device.createBindGroupLayout({
		label: 'star-sprite-layout',
		entries: [
			{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
			{ binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
			{ binding: 2, visibility: GPUShaderStage.VERTEX, texture: { sampleType: 'float' } },
		],
	});
	const pipeline = device.createRenderPipeline({
		label: 'star-sprite-pipeline',
		layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
		vertex: { module: shaderModule, entryPoint: 'vs_main' },
		fragment: {
			module: shaderModule,
			entryPoint: 'fs_main',
			targets: [{
				format,
				// Premultiplied additive: the fragment shader already returns
				// colour * alpha, so the blender must not multiply again.
				blend: {
					color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
					alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
				},
			}],
		},
		primitive: { topology: 'triangle-strip' },
	});

	// --- Storage ----------------------------------------------------------
	let starBuffer = null;
	let bindGroup = null;
	let staging = null;            // ArrayBuffer: [procedural][landmarks][catalog]
	let landmarkByteOffset = 0;
	let catalogByteOffset = 0;
	let catalogCapacity = 0;
	let proceduralCount = 0;
	let catalogResident = 0;
	let lastTime = 0;
	// The manager always exists; with no catalog it just reports zero stars.
	let manager = window.CellManager.createCellManager(EMPTY_MANIFEST, {
		budgetStars: catalogBudget,
		bandRadius: opts.bandRadius,
	});

	// Everything the overlay and the tests read, mutated in place.
	const state = {
		proceduralStars: 0,
		landmarkStars: 0,
		catalogResidentStars: 0,
		catalogTotalStars: 0,
		catalogCells: 0,
		cellsResident: 0,
		decodedBytes: 0,
		drawn: 0,
		magZero: EXPOSURE_DEFAULT,
		bufferBytes: 0,
		clampedProcedural: false,
		clampedCatalog: false,
	};

	// --- Exposure ---------------------------------------------------------
	// magZero is the apparent magnitude that maps to full white. Stars fainter
	// than ~magZero + 3 fade out; stars brighter than it saturate and grow to
	// MAX_SIZE_PX. A single exposure cannot cover the ~25 magnitudes between a
	// nearby star and the far side of the galaxy, which is what the [ and ]
	// keys are for: low exposure for the solar neighbourhood, high exposure for
	// the galaxy-scale view.
	let magZero = opts.magZero === undefined ? EXPOSURE_DEFAULT : opts.magZero;

	function setExposure(value) {
		magZero = Math.max(EXPOSURE_MIN, Math.min(EXPOSURE_MAX, value));
		state.magZero = magZero;
		return magZero;
	}

	// --- Build ------------------------------------------------------------
	function allocate(procedural, catalog) {
		if (starBuffer) starBuffer.destroy();
		proceduralCount = procedural;
		catalogCapacity = catalog;
		const totalBytes = (proceduralCount + landmarkCount + catalogCapacity) * records.RECORD_BYTES;
		if (totalBytes > maxStorageBytes) {
			throw new Error(`Star buffer of ${(totalBytes / 1048576).toFixed(1)} MB exceeds the device limit of ${(maxStorageBytes / 1048576).toFixed(1)} MB`);
		}
		staging = new ArrayBuffer(Math.max(records.RECORD_BYTES, totalBytes));
		landmarkByteOffset = proceduralCount * records.RECORD_BYTES;
		catalogByteOffset = (proceduralCount + landmarkCount) * records.RECORD_BYTES;
		starBuffer = device.createBuffer({
			label: 'star-storage',
			size: Math.max(16, totalBytes),
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		});
		bindGroup = device.createBindGroup({
			label: 'star-sprite-bind-group',
			layout: bindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: uniformBuffer } },
				{ binding: 1, resource: { buffer: starBuffer } },
				{ binding: 2, resource: lutTexture.createView() },
			],
		});
		state.bufferBytes = totalBytes;
	}

	function generateProcedural() {
		if (proceduralCount === 0) return 0;
		const sampling = window.SamplingLib;
		const starTypes = window.StarTypesLib;
		const stars = sampling.sampleGalaxyStars(seed, proceduralCount);
		const view = new DataView(staging, 0, proceduralCount * records.RECORD_BYTES);
		const derived = {};
		for (let i = 0; i < proceduralCount; i++) {
			starTypes.deriveStar(seed * 31 + i + 1, stars.component[i], stars.R[i], stars.distToArm[i], derived);
			records.writeRecord(
				view, i * records.RECORD_BYTES,
				stars.x[i], stars.y[i], stars.z[i],
				derived.colorIndex, derived.absMag,
				records.FLAG_VISIBLE, Math.imul(i, 2654435761) & 0xFF,
			);
		}
		state.proceduralStars = proceduralCount;
		return proceduralCount;
	}

	// The named stars, flagged so later cull passes never thin them away.
	// Positions are the load-time bake in data/landmarks.js.
	function writeLandmarks() {
		const view = new DataView(staging, landmarkByteOffset, landmarkCount * records.RECORD_BYTES);
		for (let i = 0; i < landmarkCount; i++) {
			const e = landmarks.ENTRIES[i];
			records.writeRecord(
				view, i * records.RECORD_BYTES,
				e.x, e.y, e.z,
				e.colorIndex, e.absMag,
				records.FLAG_VISIBLE | records.FLAG_LANDMARK, 0,
			);
		}
		state.landmarkStars = landmarkCount;
		return landmarkCount;
	}

	function attachCatalog(manifest) {
		state.catalogTotalStars = manifest.starCount;
		state.catalogCells = manifest.cellCount;
		const capacity = Math.min(manifest.starCount, catalogBudget);
		state.clampedCatalog = capacity < manifest.starCount;
		catalogCapacity = capacity;
		manager = window.CellManager.createCellManager(manifest, {
			budgetStars: catalogBudget,
			bandRadius: opts.bandRadius,
		});
		return capacity;
	}

	// One-shot setup: allocate, generate, upload, expose. Procedural field and
	// landmarks are both fixed for the life of the renderer, so they share one
	// upload.
	function prepare(manifest) {
		const catalog = manifest ? attachCatalog(manifest) : 0;
		let procedural = proceduralTarget;
		const maxRecords = Math.floor(maxStorageBytes / records.RECORD_BYTES);
		if (procedural + landmarkCount + catalog > maxRecords) {
			procedural = Math.max(0, maxRecords - landmarkCount - catalog);
			state.clampedProcedural = true;
		}
		allocate(procedural, catalog);
		generateProcedural();
		writeLandmarks();
		const fixedBytes = (proceduralCount + landmarkCount) * records.RECORD_BYTES;
		if (fixedBytes > 0) device.queue.writeBuffer(starBuffer, 0, staging, 0, fixedBytes);
		return state;
	}

	// Rewrite the catalog region of the staging buffer and upload it. Only
	// called when the resident set changed (a cell boundary crossing).
	function uploadCatalog() {
		const bytes = manager.writeInto(new Uint8Array(staging, catalogByteOffset), 0);
		catalogResident = bytes / records.RECORD_BYTES;
		if (catalogResident > 0) {
			device.queue.writeBuffer(starBuffer, catalogByteOffset, staging, catalogByteOffset, bytes);
		}
		const stats = manager.stats();
		state.cellsResident = stats.cellsResident;
		state.decodedBytes = stats.decodedBytes;
		state.catalogResidentStars = catalogResident;
		return catalogResident;
	}

	// --- Frame ------------------------------------------------------------
	function render(camera, width, height, time, input) {
		if (!starBuffer || width === 0 || height === 0) return;
		const dt = Math.min(MAX_FRAME_DT, Math.max(0, time - lastTime));
		lastTime = time;

		if (input && input.actions && input.actions.exposure) {
			setExposure(magZero + input.actions.exposure * EXPOSURE_STEP);
			input.actions.exposure = 0;
		}

		if (state.catalogTotalStars > 0) {
			const update = manager.update(camera.cameraPos[0], camera.cameraPos[1], camera.cameraPos[2], dt);
			if (update.changed) uploadCatalog();
		}

		const viewProj = camera.buildViewProj(width / height);
		uniform.set(viewProj, 0);
		uniform[16] = camera.cameraPos[0];
		uniform[17] = camera.cameraPos[1];
		uniform[18] = camera.cameraPos[2];
		uniform[19] = 0;
		uniform[20] = width;
		uniform[21] = height;
		uniform[22] = 2 / width;
		uniform[23] = 2 / height;
		uniform[24] = magZero;
		uniform[25] = BASE_SIZE_PX;
		uniform[26] = MAX_SIZE_PX;
		uniform[27] = time;
		device.queue.writeBuffer(uniformBuffer, 0, uniformData);

		// The pass runs even when nothing is drawn: an empty frame still has to
		// clear the canvas, and draw(.., 0) is free.
		const instances = state.proceduralStars + landmarkCount + catalogResident;
		state.drawn = instances;

		const encoder = device.createCommandEncoder({ label: 'star-frame' });
		const pass = encoder.beginRenderPass({
			label: 'star-sprites',
			colorAttachments: [{
				view: context.getCurrentTexture().createView(),
				clearValue: { r: 0.008, g: 0.010, b: 0.020, a: 1.0 },
				loadOp: 'clear',
				storeOp: 'store',
			}],
		});
		pass.setPipeline(pipeline);
		pass.setBindGroup(0, bindGroup);
		pass.draw(4, instances, 0, 0);
		pass.end();
		device.queue.submit([encoder.finish()]);
	}

	function dispose() {
		if (starBuffer) starBuffer.destroy();
		uniformBuffer.destroy();
		lutTexture.destroy();
	}

	return {
		prepare,
		render,
		setExposure,
		dispose,
		state,
		stats: () => state,
		shaderError: () => shaderError,
	};
}

const StarRenderer = {
	createStarRenderer, EMPTY_MANIFEST, UNIFORM_FLOATS,
	PROCEDURAL_STARS_DEFAULT, CATALOG_BUDGET_DEFAULT,
	BASE_SIZE_PX, MAX_SIZE_PX, EXPOSURE_DEFAULT, EXPOSURE_STEP,
};
if (typeof module !== 'undefined') module.exports = StarRenderer;
if (typeof window !== 'undefined') window.StarRenderer = StarRenderer;
