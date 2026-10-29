// experiments/mock-gpu.js
// The shared mock WebGPU device behind the renderer experiments (not a test —
// the same status as tonemap-mirror.js). It records every buffer write, so a
// test can decode the bytes the renderer *would* have uploaded and check them
// against the model: star records, the camera/orbit uniforms and the simple
// engine's theta lane (`gpu.thetaWrites`) and its carry lane (`gpu.carryWrites`).
//
// `createMockGpu()` returns { device, context, format, buffers, textures,
// shaderModules, pipelines, uniformWrites, tonemapUniformWrites,
// simpleUniformWrites, thetaWrites, bufferWrites, draws, passes,
// computePasses, samplers } — the renderer runs unmodified against it.

'use strict';

function createMockGpu() {
	const gpu = {
		buffers: [],
		textures: [],
		shaderModules: [],
		pipelines: [],
		uniformWrites: [],
		tonemapUniformWrites: [],
		simpleUniformWrites: [],
		thetaWrites: [],
		carryWrites: [],
		bufferWrites: [],
		draws: [],
		passes: [],
		computePasses: [],
		passedUniformData: null,
		samplers: [],
	};

	gpu.device = {
		limits: {
			maxStorageBufferBindingSize: 256 * 1024 * 1024,
			maxBufferSize: 256 * 1024 * 1024,
			maxStorageBuffersPerShaderStage: 8,
		},
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
			const texture = { label: desc.label, size: desc.size, format: desc.format, usage: desc.usage, destroy() {} };
			gpu.textures.push(texture);
			return { ...texture, createView: () => ({ texture }) };
		},
		createSampler(desc) { gpu.samplers.push(desc); return { desc }; },
		createBindGroupLayout(desc) { return { desc }; },
		createPipelineLayout(desc) { return { desc }; },
		createRenderPipeline(desc) { gpu.pipelines.push(desc); return { label: desc.label }; },
		createComputePipeline(desc) { gpu.pipelines.push(desc); return { label: desc.label }; },
		createBindGroup(desc) { return { desc }; },
		createCommandEncoder(desc) {
			return {
				label: desc && desc.label,
				beginRenderPass(passDesc) {
					gpu.lastPass = passDesc;
					const passObj = {
						label: passDesc && passDesc.label,
						desc: passDesc,
						draws: [],
						setPipeline(p) { this.pipeline = p; },
						setBindGroup() {},
						draw(vertices, instances, firstVertex, firstInstance) {
							const d = { vertices, instances, firstVertex, firstInstance, pipeline: this.pipeline, pass: this.label };
							this.draws.push(d);
							gpu.draws.push(d);
						},
						end() {},
					};
					gpu.passes.push(passObj);
					return passObj;
				},
				beginComputePass(passDesc) {
					const passObj = {
						label: passDesc && passDesc.label,
						dispatches: [],
						setPipeline(p) { this.pipeline = p; },
						setBindGroup() {},
						dispatchWorkgroups(x, y, z) {
							this.dispatches.push([x, y || 1, z || 1]);
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
			writeTexture() {},
			writeBuffer(buffer, offset, data, dataOffset, size) {
				const length = size === undefined ? data.byteLength - (dataOffset || 0) : size;
				const copy = new Uint8Array(data, dataOffset || 0, length).slice();
				if (buffer.label === 'star-camera-uniform') gpu.uniformWrites.push(copy);
				else if (buffer.label === 'tonemap-uniform') gpu.tonemapUniformWrites.push(copy);
				else if (buffer.label === 'simple-step-uniform') gpu.simpleUniformWrites.push(copy);
				else if (buffer.label === 'simple-theta') gpu.thetaWrites.push({ buffer, offset, bytes: copy });
				else if (buffer.label === 'simple-carry') gpu.carryWrites.push({ buffer, offset, bytes: copy });
				else gpu.bufferWrites.push({ buffer, offset, bytes: copy });
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

const MockGpu = { createMockGpu };
if (typeof module !== 'undefined') module.exports = MockGpu;
