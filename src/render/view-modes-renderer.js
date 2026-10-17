// src/render/view-modes-renderer.js
// View modes (view-modes-plan.md): the GPU half. Three
// passes, all inside this module, all driven by the main
// fly camera:
//
//   1. view-field  — a compute pass that fills an
//      equirectangular field texture (the "heightmap" on
//      the view sphere) from the star set's uniform
//      array, with the truncated Gaussian kernel mean (nearest-star fill).
//   2. view-shade  — a fullscreen pass that rebuilds each
//      pixel's galaxy ray from the camera basis, samples
//      the field, and terrain-shades it (gradient →
//      normal → key light → turbo ramp → contours).
//   3. tonemap     — the shared tonemap module, so the
//      exposure/white-point/saturation/headroom sliders
//      and HDR output keep working.
//
// The field texture is galaxy-frame (north = +Z), so it
// is stable while the camera turns and only re-fills
// when the stars or the camera translate.
//
// The module owns no source selection and no scalars —
// src/math/view-modes-field.js computes those on the CPU;
// this file only uploads and draws.

'use strict';

// The equirect field resolution. The kernel's σ is at
// least the mean angular spacing of the largest set
// (500 stars ≈ 9° ≈ 21 texels), so 768×384 resolves
// the field with room to spare and the compute pass
// stays a fraction of a millisecond.
const FIELD_W = 768;
const FIELD_H = 384;
// vec4f per star slot, MAX_STARS slots (the field module
// owns the constant; the buffer is the fixed stride).
// One vec4f per selectable star. The field module
// owns the authoritative MAX_STARS; the value must
// equal it (the uniform array's declared size is
// the shader's minimum binding size), and the
// smoke test pins the pair.
const STAR_UNIFORM_VEC4S = 500;
// The shade pass's HDR intermediate, like the star
// renderer's: additive-free, one clear per frame.
const VIEW_HDR_FORMAT = 'rgba16float';
// The tonemap uniform is the star renderer's layout
// (x exposure, y white point, z saturation, w output
// mode; then headroom, highlight desat).
const VIEW_TONEMAP_UNIFORM_FLOATS = 8;
// The field-fill params: count, 3 pads, σ, the empty
// sentinel, 2 pads.
const FIELD_PARAMS_FLOATS = 8;
// The shade params: camera basis (3 vec4), viewport
// (1 vec4), relief/contours/gain (1 vec4).
const SHADE_UNIFORM_FLOATS = 20;
// Fixed presentation gain: the field is 0..1, the
// tonemap's exposure lane is the user's brightness.
const FIELD_GAIN = 3.0;
// The relief exaggeration: the normalized field's slope
// is gentle, and a heightmap reads by its shading.
const RELIEF = 6.0;
// Contour lines per height decade.
const CONTOUR_LEVELS = 12;
// The empty-sky colour, the star renderer's HDR clear
// value: the view mode replaces the sky, and this is
// what "no star within the kernel" means.
const EMPTY_SKY = [0.0001, 0.0002, 0.0005];

function createViewModesRenderer(device, context, format) {
	const shaders = window.GalaxyShaders;
	if (!shaders) {
		throw new Error('GalaxyShaders missing: index.html must load render/shaders.js before render/view-modes-renderer.js');
	}

	// --- Field texture (the view-sphere heightmap) ----------
	const fieldTexture = device.createTexture({
		label: 'view-field',
		size: [FIELD_W, FIELD_H],
		format: 'rgba16float',
		usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
	});
	const fieldView = fieldTexture.createView();

	// --- Buffers -------------------------------------------
	// Star array: vec4f per slot — direction (galaxy frame,
	// unit) and the normalized scalar.
	const starUniformBuffer = device.createBuffer({
		label: 'view-stars-uniform',
		size: STAR_UNIFORM_VEC4S * 16,
		usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
	});
	// Field-fill params. `count` rides the u32 lane, so
	// the buffer is written through a Uint32Array view.
	const fieldParamsData = new ArrayBuffer(FIELD_PARAMS_FLOATS * 4);
	const fieldParams = new Float32Array(fieldParamsData);
	const fieldParamsU32 = new Uint32Array(fieldParamsData);
	const fieldParamsBuffer = device.createBuffer({
		label: 'view-field-params-uniform',
		size: FIELD_PARAMS_FLOATS * 4,
		usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
	});
	const shadeUniformData = new ArrayBuffer(SHADE_UNIFORM_FLOATS * 4);
	const shadeUniform = new Float32Array(shadeUniformData);
	const shadeUniformBuffer = device.createBuffer({
		label: 'view-shade-uniform',
		size: SHADE_UNIFORM_FLOATS * 4,
		usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
	});
	const tonemapUniformData = new ArrayBuffer(VIEW_TONEMAP_UNIFORM_FLOATS * 4);
	const tonemapUniform = new Float32Array(tonemapUniformData);
	const tonemapUniformBuffer = device.createBuffer({
		label: 'view-tonemap-uniform',
		size: VIEW_TONEMAP_UNIFORM_FLOATS * 4,
		usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
	});

	// --- Pipelines ------------------------------------------
	const fieldModule = device.createShaderModule({
		label: 'view-field',
		code: shaders.SHADERS['view-field'],
	});
	fieldModule.getCompilationInfo().then((info) => {
		for (const message of info.messages) {
			if (message.type !== 'error') continue;
			console.error('WGSL error in view-field:', `${message.lineNum}:${message.linePos} ${message.message}`);
		}
	}).catch(() => {});

	const fieldBindGroupLayout = device.createBindGroupLayout({
		label: 'view-field-layout',
		entries: [
			{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
			{ binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
			{ binding: 2, visibility: GPUShaderStage.COMPUTE, storageTexture: { format: 'rgba16float' } },
		],
	});
	const fieldPipeline = device.createComputePipeline({
		label: 'view-field-pipeline',
		layout: device.createPipelineLayout({ bindGroupLayouts: [fieldBindGroupLayout] }),
		compute: { module: fieldModule, entryPoint: 'fs_main' },
	});
	const fieldBindGroup = device.createBindGroup({
		label: 'view-field-bind-group',
		layout: fieldBindGroupLayout,
		entries: [
			{ binding: 0, resource: { buffer: fieldParamsBuffer } },
			{ binding: 1, resource: { buffer: starUniformBuffer } },
			{ binding: 2, resource: fieldView },
		],
	});

	const shadeModule = device.createShaderModule({
		label: 'view-shade',
		code: shaders.SHADERS['view-shade'],
	});
	shadeModule.getCompilationInfo().then((info) => {
		for (const message of info.messages) {
			if (message.type !== 'error') continue;
			console.error('WGSL error in view-shade:', `${message.lineNum}:${message.linePos} ${message.message}`);
		}
	}).catch(() => {});

	const fieldSampler = device.createSampler({
		label: 'view-field-sampler',
		addressModeU: 'repeat',   // the equirect seam wraps
		addressModeV: 'clamp-to-edge',
		magFilter: 'linear',
		minFilter: 'linear',
	});
	const shadeBindGroupLayout = device.createBindGroupLayout({
		label: 'view-shade-layout',
		entries: [
			{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
			{ binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
			{ binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
		],
	});
	const shadePipeline = device.createRenderPipeline({
		label: 'view-shade-pipeline',
		layout: device.createPipelineLayout({ bindGroupLayouts: [shadeBindGroupLayout] }),
		vertex: { module: shadeModule, entryPoint: 'vs_main' },
		fragment: {
			module: shadeModule,
			entryPoint: 'fs_main',
			targets: [{ format: VIEW_HDR_FORMAT, blend: undefined }],
		},
		primitive: { topology: 'triangle-list' },
	});

	const tonemapModule = device.createShaderModule({
		label: 'view-tonemap',
		code: shaders.SHADERS['tonemap'],
	});
	tonemapModule.getCompilationInfo().then((info) => {
		for (const message of info.messages) {
			if (message.type !== 'error') continue;
			console.error('WGSL error in view tonemap:', `${message.lineNum}:${message.linePos} ${message.message}`);
		}
	}).catch(() => {});

	const tonemapBindGroupLayout = device.createBindGroupLayout({
		label: 'view-tonemap-layout',
		entries: [
			{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
			{ binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
		],
	});
	const tonemapPipeline = device.createRenderPipeline({
		label: 'view-tonemap-pipeline',
		layout: device.createPipelineLayout({ bindGroupLayouts: [tonemapBindGroupLayout] }),
		vertex: { module: tonemapModule, entryPoint: 'vs_main' },
		fragment: {
			module: tonemapModule,
			entryPoint: 'fs_main',
			targets: [{ format, blend: undefined }],
		},
		primitive: { topology: 'triangle-list' },
	});

	// --- HDR intermediate (size-managed like the star renderer's)
	let hdrTexture = null;
	let hdrView = null;
	let hdrWidth = 0;
	let hdrHeight = 0;
	let shadeBindGroup = null;
	let tonemapBindGroup = null;

	function ensureHdrTexture(width, height) {
		if (hdrTexture && hdrWidth === width && hdrHeight === height) return;
		if (hdrTexture) hdrTexture.destroy();
		hdrTexture = device.createTexture({
			label: 'view-hdr-intermediate',
			size: [width, height],
			format: VIEW_HDR_FORMAT,
			usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
		});
		hdrView = hdrTexture.createView();
		hdrWidth = width;
		hdrHeight = height;
		shadeBindGroup = device.createBindGroup({
			label: 'view-shade-bind-group',
			layout: shadeBindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: shadeUniformBuffer } },
				{ binding: 1, resource: fieldView },
				{ binding: 2, resource: fieldSampler },
			],
		});
		tonemapBindGroup = device.createBindGroup({
			label: 'view-tonemap-bind-group',
			layout: tonemapBindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: tonemapUniformBuffer } },
				{ binding: 1, resource: hdrView },
			],
		});
	}

	// --- Frame ------------------------------------------------
	// `source` is the field module's committed state:
	//   { count, sigma, starUniform }
	// `exposure` is the star renderer's live state object
	// (the tonemap lanes). The camera supplies the basis
	// the shade pass rebuilds rays from.
	function render(camera, width, height, source, exposure) {
		if (!source || source.count === 0 || width === 0 || height === 0) return;

		fieldParamsU32[0] = source.count;
		fieldParams[4] = source.sigma;
		fieldParams[5] = -1;             // the empty sentinel
		device.queue.writeBuffer(fieldParamsBuffer, 0, fieldParamsData);
		device.queue.writeBuffer(starUniformBuffer, 0, source.starUniform);

		shadeUniform[0] = camera.right[0];
		shadeUniform[1] = camera.right[1];
		shadeUniform[2] = camera.right[2];
		shadeUniform[3] = 0;
		shadeUniform[4] = camera.up[0];
		shadeUniform[5] = camera.up[1];
		shadeUniform[6] = camera.up[2];
		shadeUniform[7] = 0;
		shadeUniform[8] = camera.forward[0];
		shadeUniform[9] = camera.forward[1];
		shadeUniform[10] = camera.forward[2];
		shadeUniform[11] = 0;
		shadeUniform[12] = width;
		shadeUniform[13] = height;
		shadeUniform[14] = Math.tan(camera.fovY / 2);
		shadeUniform[15] = shadeUniform[14] * (width / height);
		shadeUniform[16] = RELIEF;
		shadeUniform[17] = source.contours ? CONTOUR_LEVELS : 0;
		shadeUniform[18] = FIELD_GAIN;
		shadeUniform[19] = 0;
		device.queue.writeBuffer(shadeUniformBuffer, 0, shadeUniformData);

		tonemapUniform[0] = exposure.linearExposure;
		tonemapUniform[1] = exposure.whitePoint;
		tonemapUniform[2] = exposure.saturation;
		tonemapUniform[3] = exposure.hdrOutput ? 1 : 0;
		tonemapUniform[4] = exposure.headroom;
		tonemapUniform[5] = exposure.highlightDesat;
		device.queue.writeBuffer(tonemapUniformBuffer, 0, tonemapUniformData);

		ensureHdrTexture(width, height);

		const encoder = device.createCommandEncoder({ label: 'view-mode-frame' });

		// Pass 1: fill the equirect field.
		const fieldPass = encoder.beginComputePass({ label: 'view-field-fill' });
		fieldPass.setPipeline(fieldPipeline);
		fieldPass.setBindGroup(0, fieldBindGroup);
		fieldPass.dispatchWorkgroups(Math.ceil(FIELD_W / 8), Math.ceil(FIELD_H / 8));
		fieldPass.end();

		// Pass 2: terrain-shade it into the HDR intermediate.
		const shadePass = encoder.beginRenderPass({
			label: 'view-shade',
			colorAttachments: [{
				view: hdrView,
				clearValue: { r: EMPTY_SKY[0], g: EMPTY_SKY[1], b: EMPTY_SKY[2], a: 1 },
				loadOp: 'clear',
				storeOp: 'store',
			}],
		});
		shadePass.setPipeline(shadePipeline);
		shadePass.setBindGroup(0, shadeBindGroup);
		shadePass.draw(3, 1, 0, 0);
		shadePass.end();

		// Pass 3: present through the shared tonemap.
		const tonemapPass = encoder.beginRenderPass({
			label: 'view-tonemap',
			colorAttachments: [{
				view: context.getCurrentTexture().createView(),
				clearValue: { r: EMPTY_SKY[0], g: EMPTY_SKY[1], b: EMPTY_SKY[2], a: 1 },
				loadOp: 'clear',
				storeOp: 'store',
			}],
		});
		tonemapPass.setPipeline(tonemapPipeline);
		tonemapPass.setBindGroup(0, tonemapBindGroup);
		tonemapPass.draw(3, 1, 0, 0);
		tonemapPass.end();

		device.queue.submit([encoder.finish()]);
	}

	function dispose() {
		fieldTexture.destroy();
		starUniformBuffer.destroy();
		fieldParamsBuffer.destroy();
		shadeUniformBuffer.destroy();
		tonemapUniformBuffer.destroy();
		if (hdrTexture) hdrTexture.destroy();
	}

	return {
		render, dispose,
		fieldWidth: FIELD_W, fieldHeight: FIELD_H,
		maxStars: STAR_UNIFORM_VEC4S,
	};
}

const ViewModesRenderer = {
	createViewModesRenderer,
	FIELD_W, FIELD_H, STAR_UNIFORM_VEC4S, VIEW_HDR_FORMAT,
	VIEW_TONEMAP_UNIFORM_FLOATS, FIELD_PARAMS_FLOATS, SHADE_UNIFORM_FLOATS,
	FIELD_GAIN, RELIEF, CONTOUR_LEVELS, EMPTY_SKY,
};
if (typeof module !== 'undefined') module.exports = ViewModesRenderer;
if (typeof window !== 'undefined') window.ViewModesRenderer = ViewModesRenderer;
