// experiments/view-modes-renderer-test.js
// View modes (view-modes-plan.md), VM.1: the GPU half
// against a mock WebGPU device — the real GPU cannot be
// reached from Node, but everything around the GPU calls
// is testable: buffer sizing, uniform packing (the star
// array, the field params, the shade basis, the tonemap
// lanes), the dispatch geometry and the draw calls.
//
// Output: experiments/logs/view-modes-renderer.json

'use strict';

const fs = require('fs');
const path = require('path');

globalThis.window = globalThis;
globalThis.GPUBufferUsage = { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 };
globalThis.GPUTextureUsage = { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };
globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };

require('../src/math/hash.js');
require('../src/math/density.js');
require('../src/math/galaxy.js');
require('../src/math/orbit.js');
require('../src/data/landmarks.js');
require('../src/render/shaders.js');
const viewModesField = require('../src/math/view-modes-field.js');
const viewModesRenderer = require('../src/render/view-modes-renderer.js');
const cameraLib = require('../src/core/camera.js');

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
	return !!pass;
}

// --- Mock device (the renderer-test.js pattern) -----------------------
function createMockGpu() {
	const gpu = {
		buffers: [], textures: [], shaderModules: [], pipelines: [],
		bindGroups: [], bindGroupLayouts: [], samplers: [], bufferWrites: [],
		passes: [], computePasses: [], draws: [], dispatches: [],
	};
	gpu.device = {
		limits: { maxStorageBufferBindingSize: 256 * 1024 * 1024, maxBufferSize: 256 * 1024 * 1024 },
		createBuffer(desc) {
			const buffer = { label: desc.label, size: desc.size, usage: desc.usage, destroy() {} };
			gpu.buffers.push(buffer);
			return buffer;
		},
		createShaderModule(desc) {
			gpu.shaderModules.push(desc);
			return { label: desc.label, getCompilationInfo: () => Promise.resolve({ messages: [] }) };
		},
		createTexture(desc) {
			const texture = { label: desc.label, size: desc.size, format: desc.format, usage: desc.usage, destroy() {} };
			gpu.textures.push(texture);
			return { ...texture, createView: () => ({ texture }) };
		},
		createSampler(desc) { gpu.samplers.push(desc); return { label: desc.label }; },
		createBindGroupLayout(desc) { gpu.bindGroupLayouts.push(desc); return { desc }; },
		createPipelineLayout(desc) { return { desc }; },
		createRenderPipeline(desc) { gpu.pipelines.push(desc); return { label: desc.label }; },
		createComputePipeline(desc) { gpu.pipelines.push(desc); return { label: desc.label }; },
		createBindGroup(desc) { gpu.bindGroups.push(desc); return { desc }; },
		createCommandEncoder() {
			return {
				beginRenderPass(passDesc) {
					const passObj = {
						label: passDesc && passDesc.label, draws: [],
						setPipeline(p) { this.pipeline = p; },
						setBindGroup() {},
						draw(vertices, instances, firstVertex, firstInstance) {
							const d = { vertices, instances, pipeline: this.pipeline, pass: this.label };
							this.draws.push(d); gpu.draws.push(d);
						},
						end() {},
					};
					gpu.passes.push(passObj);
					return passObj;
				},
				beginComputePass(passDesc) {
					const passObj = {
						label: passDesc && passDesc.label, dispatches: [],
						setPipeline(p) { this.pipeline = p; },
						setBindGroup() {},
						dispatchWorkgroups(x, y, z) {
							const d = { x, y: y || 1, z: z || 1, pipeline: this.pipeline, pass: this.label };
							this.dispatches.push(d); gpu.dispatches.push(d);
						},
						end() {},
					};
					gpu.computePasses.push(passObj);
					return passObj;
				},
				finish() { return { label: 'command-buffer' }; },
			};
		},
		queue: {
			writeBuffer(buffer, offset, data) {
				const copy = new Uint8Array(data.buffer ? data.buffer : data, 0, data.byteLength || data.length).slice();
				gpu.bufferWrites.push({ buffer: buffer.label, offset, bytes: copy });
			},
			submit() {},
		},
	};
	gpu.context = {
		getCurrentTexture: () => ({ width: 1920, height: 1080, createView: () => ({}) }),
	};
	gpu.format = 'bgra8unorm';
	return gpu;
}

// --- Setup --------------------------------------------------------------
const gpu = createMockGpu();
const renderer = viewModesRenderer.createViewModesRenderer(gpu.device, gpu.context, gpu.format);
const camera = cameraLib.createCamera();
const fieldState = viewModesField.createFieldState();

// A tiny synthetic source: 4 stars around the camera,
// values packed the way main.js packs them.
const starUniform = new Float32Array(viewModesField.MAX_STARS * 4);
const dirs = [
	[1, 0, 0], [0, 1, 0], [0, 0, 1], [0.70710678, 0.70710678, 0],
];
const vals = [0.0, 0.25, 0.5, 1.0];
for (let i = 0; i < 4; i++) {
	starUniform[i * 4] = dirs[i][0];
	starUniform[i * 4 + 1] = dirs[i][1];
	starUniform[i * 4 + 2] = dirs[i][2];
	starUniform[i * 4 + 3] = vals[i];
}
fieldState.count = 4;
const source = {
	count: 4,
	sigma: viewModesField.kernelSigma(4, 1),
	starUniform,
	contours: true,
};
const exposure = {
	linearExposure: 1.0, whitePoint: 4.0, saturation: 1.4,
	headroom: 8.0, highlightDesat: 1.0, hdrOutput: false,
};

// --- 1. Pipelines and resources --------------------------------------
{
	const labels = gpu.buffers.map((b) => b.label);
	check('star uniform buffer sized MAX_STARS vec4',
		labels.includes('view-stars-uniform')
		&& gpu.buffers.find((b) => b.label === 'view-stars-uniform').size === viewModesField.MAX_STARS * 16
		&& renderer.maxStars === viewModesField.MAX_STARS,
		{ labels, rendererMax: renderer.maxStars, fieldMax: viewModesField.MAX_STARS });
	check('field texture is the fixed equirect resolution',
		gpu.textures.some((t) => t.label === 'view-field'
			&& t.size[0] === viewModesRenderer.FIELD_W
			&& t.size[1] === viewModesRenderer.FIELD_H
			&& t.format === 'rgba16float'
			&& (t.usage & GPUTextureUsage.STORAGE_BINDING) !== 0
			&& (t.usage & GPUTextureUsage.TEXTURE_BINDING) !== 0),
		gpu.textures.map((t) => t.label));
	// The compute pass writes the same texture the
	// shade pass samples, so the layout's storage-
	// format declaration must agree with the
	// texture's own format — a mismatch fails
	// bind-group validation in the browser and
	// passes silently in the mock.
	const fieldLayout = gpu.bindGroupLayouts.find((l) => l.label === 'view-field-layout');
	check('field layout declares the texture as rgba16float storage',
		!!fieldLayout && fieldLayout.entries.some((e) => e.binding === 2
			&& e.visibility === GPUShaderStage.COMPUTE
			&& e.storageTexture && e.storageTexture.format === 'rgba16float'),
		fieldLayout && fieldLayout.entries.map((e) => e.binding));
	check('field compute pipeline exists',
		gpu.pipelines.some((p) => p.label === 'view-field-pipeline'), {});
	check('shade and tonemap pipelines exist',
		gpu.pipelines.some((p) => p.label === 'view-shade-pipeline')
		&& gpu.pipelines.some((p) => p.label === 'view-tonemap-pipeline'), {});
	const starModule = gpu.shaderModules.find((m) => m.label === 'view-field');
	check('field module is the wired WGSL text',
		starModule && starModule.code === window.GalaxyShaders.SHADERS['view-field'], {});
}

// --- 2. A frame ----------------------------------------------------------
{
	const before = {
		writes: gpu.bufferWrites.length,
		passes: gpu.passes.length,
		compute: gpu.computePasses.length,
		draws: gpu.draws.length,
		dispatches: gpu.dispatches.length,
	};
	renderer.render(camera, 1920, 1080, source, exposure);
	check('a frame runs one compute and two render passes',
		gpu.computePasses.length === before.compute + 1
		&& gpu.passes.length === before.passes + 2,
		{ compute: gpu.computePasses.length, passes: gpu.passes.length });
	check('the compute pass fills the whole field texture',
		gpu.dispatches.length === 1
		&& gpu.dispatches[0].x === Math.ceil(viewModesRenderer.FIELD_W / 8)
		&& gpu.dispatches[0].y === Math.ceil(viewModesRenderer.FIELD_H / 8),
		gpu.dispatches[0]);
	check('the shade and tonemap passes draw fullscreen triangles',
		gpu.draws.length === 2 && gpu.draws.every((d) => d.vertices === 3 && d.instances === 1),
		gpu.draws);
}

// --- 3. Uniform packing ---------------------------------------------------
{
	const starWrite = gpu.bufferWrites.find((w) => w.buffer === 'view-stars-uniform');
	const stars = new Float32Array(starWrite.bytes.buffer, starWrite.bytes.byteOffset, starWrite.bytes.byteLength / 4);
	check('the star array uploads all MAX_STARS slots',
		starWrite.bytes.byteLength === viewModesField.MAX_STARS * 16
		&& stars[0] === 1 && stars[3] === 0 && stars[15] === 1,
		{ length: starWrite.bytes.byteLength });

	const paramsWrite = gpu.bufferWrites.find((w) => w.buffer === 'view-field-params-uniform');
	const params = new Float32Array(paramsWrite.bytes.buffer, paramsWrite.bytes.byteOffset, 8);
	const paramsU32 = new Uint32Array(paramsWrite.bytes.buffer, paramsWrite.bytes.byteOffset, 8);
	check('field params carry the live count, σ and the empty sentinel',
		paramsU32[0] === 4
		&& Math.abs(params[4] - source.sigma) < 1e-7
		&& params[5] === -1,
		{ count: paramsU32[0], sigma: params[4], empty: params[5] });

	const shadeWrite = gpu.bufferWrites.find((w) => w.buffer === 'view-shade-uniform');
	const shade = new Float32Array(shadeWrite.bytes.buffer, shadeWrite.bytes.byteOffset, 20);
	// The camera's basis vectors are consumed raw by the
	// shader; only the forward lane's unit length is
	// pinned here (the exact orientation is the camera's
	// own tested concern).
	const fwd = [shade[8], shade[9], shade[10]];
	const fwdLen = Math.hypot(fwd[0], fwd[1], fwd[2]);
	check('shade uniform carries the camera basis, viewport and relief',
		Math.abs(fwdLen - 1) < 1e-6
		&& shade[12] === 1920 && shade[13] === 1080
		&& shade[16] === viewModesRenderer.RELIEF
		&& shade[17] === viewModesRenderer.CONTOUR_LEVELS,
		{ fwd, fwdLen, viewport: [shade[12], shade[13]] });

	const tonemapWrite = gpu.bufferWrites.find((w) => w.buffer === 'view-tonemap-uniform');
	const tm = new Float32Array(tonemapWrite.bytes.buffer, tonemapWrite.bytes.byteOffset, 8);
	check('tonemap lanes mirror the exposure state',
		Math.abs(tm[0] - 1.0) < 1e-6 && Math.abs(tm[1] - 4.0) < 1e-6
		&& Math.abs(tm[2] - 1.4) < 1e-6 && tm[3] === 0
		&& Math.abs(tm[4] - 8.0) < 1e-6 && Math.abs(tm[5] - 1.0) < 1e-6,
		{ tm: Array.from(tm) });
}

// --- 4. Guards ------------------------------------------------------------
{
	const before = gpu.draws.length;
	renderer.render(camera, 0, 1080, source, exposure);
	renderer.render(camera, 1920, 1080, { count: 0, sigma: 0.1, starUniform: source.starUniform, contours: true }, exposure);
	check('zero width or an empty set draws nothing',
		gpu.draws.length === before, { draws: gpu.draws.length });
}

// --- Report ------------------------------------------------------------------
let passed = 0;
let failed = 0;
for (const c of checks) {
	if (c.pass) passed++; else failed++;
	console.log(`  ${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.pass ? '' : `  -> ${JSON.stringify(c.detail)}`}`);
}
console.log(`\n${passed}/${checks.length} passed, ${failed} failed`);

const logPath = path.join(__dirname, 'logs', 'view-modes-renderer.json');
fs.writeFileSync(logPath, JSON.stringify({
	date: new Date().toISOString(),
	totalChecks: checks.length,
	passed,
	failed,
	checks,
}, null, 2));
console.log(`Wrote ${logPath}`);
console.log('\n=== VERDICT ===');
console.log(failed === 0 ? 'PASS — the view-mode passes pack, dispatch and draw as the plan says' : `FAIL — ${failed} checks failed`);
process.exit(failed === 0 ? 0 : 1);
