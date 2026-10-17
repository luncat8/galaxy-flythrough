// src/render/distance-field-renderer.js
// The distance field on the GPU: the compute pass that evaluates the law and
// the display pass that paints it.
//
// The law itself is math/distance-field.js — this file only carries it to the
// device. The CPU version is the reference; the WGSL twin lives in
// render/shaders.js ('distance-field' and 'distance-field-display') and the
// two are compared texel by texel in experiments/wgsl-exec-check.js.
//
// The renderer is deliberately source-agnostic: it knows about a *list of
// anchors* (positions in kpc) and nothing else. Who chose them — the catalog,
// the procedural field, the selection set, the constellations, the nearest N of
// whatever is resident — is the caller's business, which is what lets the same
// code serve the main renderer and the standalone test page.
//
// Cost: the compute pass is O(w*h*N) texel-anchor pairs, the same arithmetic
// the CPU path runs, but at a resolution the CPU could never afford (the
// island budgets 72x40; the GPU does 320x180 with the same anchors).

'use strict';

(function () {
	// The window is aliased to globalThis in the Node harnesses, so the
	// lookup has to ask whether the global is *there*, not whether a window
	// exists.
	const Shaders = (typeof window !== 'undefined' && window.GalaxyShaders)
		? window.GalaxyShaders
		: require('./shaders.js');
	const Ramps = (typeof window !== 'undefined' && window.DistanceRamps)
		? window.DistanceRamps
		: require('./distance-ramps.js');

	// The anchor cap: the same 1024 the CPU law uses. Beyond it the field
	// would need a splat+blur formulation instead of the exact IDW — a
	// different law, and therefore a different plan.
	const MAX_ANCHORS = 1024;
	const UNIFORM_FLOATS = 40;          // ten vec4s
	const UNIFORM_BYTES = UNIFORM_FLOATS * 4;
	const WORKGROUP = 8;

	const MODE_INDEX = { height: 0, spread: 1, gradient: 2 };
	const LAYOUT_VIEW = 0;
	const LAYOUT_PLANE = 1;

	// The letterbox the chart sits in, in linear light (the island's
	// #05070d, decoded from sRGB).
	const LETTERBOX = [0.0056, 0.0085, 0.0184];

	// Packs the uniform block from a state description. It is a module-level
	// function on purpose: the renderer and the parity fixture in
	// experiments/wgsl-exec-check.js must agree about the layout, and two
	// copies of forty numbers is how they would stop agreeing.
	//
	// s = {
	//   eye, basis {fx..uz}, tanHalfY, aspect, sigmaRad, anchorCount,
	//   quat, quatInv, mirrorLon, gridW, gridH, modeIndex, layoutKind,
	//   lo, hi, spanX, spanY, texelRadX, texelRadY, gain, wrapX, canvasW, canvasH
	// }
	function packUniform(out, s) {
		const b = s.basis;
		const q = s.quat;
		const qi = s.quatInv;
		out[0] = s.eye[0]; out[1] = s.eye[1]; out[2] = s.eye[2];
		out[3] = s.tanHalfY;
		out[4] = b ? b.fx : 0; out[5] = b ? b.fy : 0; out[6] = b ? b.fz : 0;
		out[7] = s.aspect;
		out[8] = b ? b.rx : 0; out[9] = b ? b.ry : 0; out[10] = b ? b.rz : 0;
		out[11] = s.sigmaRad;
		out[12] = b ? b.ux : 0; out[13] = b ? b.uy : 0; out[14] = b ? b.uz : 0;
		out[15] = s.anchorCount;
		out[16] = q ? q[0] : 0; out[17] = q ? q[1] : 0; out[18] = q ? q[2] : 0; out[19] = q ? q[3] : 1;
		out[20] = qi ? qi[0] : 0; out[21] = qi ? qi[1] : 0; out[22] = qi ? qi[2] : 0; out[23] = qi ? qi[3] : 1;
		out[24] = s.gridW; out[25] = s.gridH; out[26] = s.modeIndex; out[27] = s.layoutKind;
		out[28] = s.lo; out[29] = s.hi; out[30] = s.spanX; out[31] = s.spanY;
		out[32] = s.texelRadX; out[33] = s.texelRadY; out[34] = s.gain; out[35] = 0;
		out[36] = s.wrapX ? 1 : 0; out[37] = s.canvasW; out[38] = s.canvasH;
		out[39] = s.mirrorLon ? 1 : 0;
		return out;
	}

	function createDistanceFieldRenderer(device, options) {
		const opts = options || {};
		const label = opts.label || 'distance-field';

		const uniformBuffer = device.createBuffer({
			label: label + '-uniform',
			size: UNIFORM_BYTES,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		const anchorBuffer = device.createBuffer({
			label: label + '-anchors',
			size: MAX_ANCHORS * 16,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		});
		// One staging array for the anchors, reused: the hot path must not
		// allocate.
		const anchorStage = new Float32Array(MAX_ANCHORS * 4);
		const uniform = new Float32Array(UNIFORM_FLOATS);

		// The field and the slope live in storage buffers, not textures: a
		// storage buffer needs no filtering feature, and the display pass
		// reads the four neighbours it interpolates between by hand.
		let fieldBuffer = null;
		let slopeBuffer = null;
		let gridW = 0;
		let gridH = 0;
		let computeBindGroup = null;
		let displayBindGroup = null;

		// The ramp: the island's own bytes, uploaded as a 256x1 texture.
		const rampTexture = device.createTexture({
			label: label + '-ramp',
			size: { width: 256, height: 1 },
			format: 'rgba8unorm',
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
		});
		const rampBytes = new Uint8Array(256 * 4);
		let rampName = '';

		// The state the uniform carries.
		let mode = 'off';
		let modeIndex = 0;
		let layout = null;          // the CPU layout object (math/distance-field.js)
		let eye = [0, 0, 0];
		let sigmaRad = 3 * Math.PI / 180;
		let rangeLo = 0;
		let rangeHi = 1;
		let gain = 1;
		let canvasW = 1;
		let canvasH = 1;
		let anchorCount = 0;
		let rampChoice = 'auto';

		// ---- pipelines ------------------------------------------------------

		const computeLayout = device.createBindGroupLayout({
			label: label + '-compute-layout',
			entries: [
				{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
				{ binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
				{ binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
				{ binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
			],
		});
		const displayLayout = device.createBindGroupLayout({
			label: label + '-display-layout',
			entries: [
				{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
				{ binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
				{ binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
				{ binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
			],
		});

		const fieldModule = device.createShaderModule({
			label: label + '-module',
			code: Shaders.SHADERS['distance-field'],
		});
		const displayModule = device.createShaderModule({
			label: label + '-display-module',
			code: Shaders.SHADERS['distance-field-display'],
		});

		const fieldPipeline = device.createComputePipeline({
			label: label + '-pipeline',
			layout: device.createPipelineLayout({ bindGroupLayouts: [computeLayout] }),
			compute: { module: fieldModule, entryPoint: 'cs_field' },
		});
		const slopePipeline = device.createComputePipeline({
			label: label + '-slope-pipeline',
			layout: device.createPipelineLayout({ bindGroupLayouts: [computeLayout] }),
			compute: { module: fieldModule, entryPoint: 'cs_slope' },
		});
		// The display pass writes to a target whose format differs between the
		// HDR scene (rgba16float) and a plain swapchain (bgra8unorm), so the
		// pipeline is made per format and cached.
		const displayPipelines = new Map();
		function displayPipeline(format) {
			let p = displayPipelines.get(format);
			if (p) return p;
			p = device.createRenderPipeline({
				label: label + '-display-pipeline',
				layout: device.createPipelineLayout({ bindGroupLayouts: [displayLayout] }),
				vertex: { module: displayModule, entryPoint: 'vs_full' },
				fragment: { module: displayModule, entryPoint: 'fs_field', targets: [{ format }] },
				primitive: { topology: 'triangle-list' },
			});
			displayPipelines.set(format, p);
			return p;
		}

		// ---- buffers -------------------------------------------------------

		function ensureGrid(w, h) {
			w = Math.max(1, w | 0);
			h = Math.max(1, h | 0);
			if (w === gridW && h === gridH) return;
			gridW = w;
			gridH = h;
			if (fieldBuffer) fieldBuffer.destroy();
			if (slopeBuffer) slopeBuffer.destroy();
			fieldBuffer = device.createBuffer({
				label: label + '-field',
				size: gridW * gridH * 16,
				usage: GPUBufferUsage.STORAGE,
			});
			slopeBuffer = device.createBuffer({
				label: label + '-slope',
				size: gridW * gridH * 4,
				usage: GPUBufferUsage.STORAGE,
			});
			computeBindGroup = device.createBindGroup({
				label: label + '-compute-bind',
				layout: computeLayout,
				entries: [
					{ binding: 0, resource: { buffer: uniformBuffer } },
					{ binding: 1, resource: { buffer: anchorBuffer } },
					{ binding: 2, resource: { buffer: fieldBuffer } },
					{ binding: 3, resource: { buffer: slopeBuffer } },
				],
			});
			displayBindGroup = device.createBindGroup({
				label: label + '-display-bind',
				layout: displayLayout,
				entries: [
					{ binding: 0, resource: { buffer: uniformBuffer } },
					{ binding: 1, resource: { buffer: fieldBuffer } },
					{ binding: 2, resource: { buffer: slopeBuffer } },
					{ binding: 3, resource: rampTexture.createView() },
				],
			});
		}

		// ---- ramp ----------------------------------------------------------

		function applyRamp() {
			const name = rampChoice === 'auto'
				? Ramps.rampForMode(mode === 'off' ? 'height' : mode)
				: rampChoice;
			const ramp = Ramps.resolveRamp(mode === 'off' ? 'height' : mode, name);
			Ramps.toRgba(ramp, rampBytes);
			device.queue.writeTexture(
				{ texture: rampTexture },
				rampBytes,
				{ bytesPerRow: 256 * 4 },
				{ width: 256, height: 1 });
			rampName = name;
		}

		// ---- uniform -------------------------------------------------------

		function writeUniform() {
			const lay = layout;
			packUniform(uniform, {
				eye,
				basis: lay ? lay.basis : null,
				tanHalfY: lay ? (lay.tanHalfY || 0) : 0,
				aspect: lay ? (lay.aspect || 1) : 1,
				sigmaRad,
				anchorCount,
				quat: lay ? lay.quat : null,
				quatInv: lay ? lay.quatInv : null,
				mirrorLon: lay ? !!lay.mirrorLon : false,
				gridW,
				gridH,
				modeIndex,
				layoutKind: lay && lay.kind === 'plane' ? LAYOUT_PLANE : LAYOUT_VIEW,
				lo: rangeLo,
				hi: rangeHi,
				spanX: lay ? (lay.spanX || 0) : 0,
				spanY: lay ? (lay.spanY || 0) : 0,
				texelRadX: lay ? (lay.texelRadX || 0) : 0,
				texelRadY: lay ? (lay.texelRadY || 0) : 0,
				gain,
				wrapX: lay ? !!lay.wrapX : false,
				canvasW,
				canvasH,
			});
			device.queue.writeBuffer(uniformBuffer, 0, uniform);
		}

		// ---- public surface ------------------------------------------------

		function setLayout(next) {
			layout = next || null;
			if (layout) ensureGrid(layout.w, layout.h);
		}

		function setGrid(w, h) {
			ensureGrid(w, h);
		}

		function setEye(x, y, z) {
			eye[0] = x; eye[1] = y; eye[2] = z;
		}

		function setMode(next) {
			const m = next === 'height' || next === 'spread' || next === 'gradient' ? next : 'off';
			if (m === mode) return;
			mode = m;
			modeIndex = MODE_INDEX[m] !== undefined ? MODE_INDEX[m] : 0;
			if (rampChoice === 'auto') applyRamp();
		}

		function setSigma(deg) {
			sigmaRad = (Number.isFinite(deg) ? deg : 3) * Math.PI / 180;
		}

		function setRange(lo, hi) {
			rangeLo = Number.isFinite(lo) ? lo : 0;
			rangeHi = Number.isFinite(hi) ? hi : 1;
		}

		function setRamp(name) {
			rampChoice = name || 'auto';
			applyRamp();
		}

		function setGain(value) {
			gain = Number.isFinite(value) ? value : 1;
		}

		function setCanvas(w, h) {
			canvasW = Math.max(1, w | 0);
			canvasH = Math.max(1, h | 0);
		}

		// The anchors: absolute kpc positions, three floats each. The count is
		// capped at MAX_ANCHORS; the caller decides which stars those are.
		function setAnchors(positions, count) {
			const n = Math.max(0, Math.min(count | 0, MAX_ANCHORS));
			for (let i = 0; i < n; i++) {
				anchorStage[i * 4] = positions[i * 3];
				anchorStage[i * 4 + 1] = positions[i * 3 + 1];
				anchorStage[i * 4 + 2] = positions[i * 3 + 2];
				anchorStage[i * 4 + 3] = 0;
			}
			anchorCount = n;
			if (n > 0) {
				device.queue.writeBuffer(anchorBuffer, 0, anchorStage, 0, n * 4);
			}
		}

		// The compute passes: the field, and the slope when the mode asks for
		// it. The slope is a second O(w*h) pass over what mode 1 already
		// computed, never another O(w*h*N) sweep.
		function update(encoder) {
			if (mode === 'off' || !layout) return;
			writeUniform();
			const pass = encoder.beginComputePass({ label: label + '-compute' });
			pass.setPipeline(fieldPipeline);
			pass.setBindGroup(0, computeBindGroup);
			pass.dispatchWorkgroups(
				Math.ceil(gridW / WORKGROUP),
				Math.ceil(gridH / WORKGROUP));
			if (mode === 'gradient') {
				pass.setPipeline(slopePipeline);
				pass.dispatchWorkgroups(
					Math.ceil(gridW / WORKGROUP),
					Math.ceil(gridH / WORKGROUP));
			}
			pass.end();
		}

		// The display pass: a fullscreen triangle over the target.
		function draw(encoder, view, format) {
			if (mode === 'off' || !layout) return;
			const pass = encoder.beginRenderPass({
				label: label + '-display',
				colorAttachments: [{
					view,
					loadOp: 'clear',
					storeOp: 'store',
					clearValue: { r: LETTERBOX[0], g: LETTERBOX[1], b: LETTERBOX[2], a: 1 },
				}],
			});
			pass.setPipeline(displayPipeline(format));
			pass.setBindGroup(0, displayBindGroup);
			pass.draw(3);
			pass.end();
		}

		function destroy() {
			if (fieldBuffer) fieldBuffer.destroy();
			if (slopeBuffer) slopeBuffer.destroy();
			uniformBuffer.destroy();
			anchorBuffer.destroy();
			rampTexture.destroy();
		}

		// The first ramp is the height mode's: a field that has not been
		// switched on yet still has to have its bytes in the texture.
		applyRamp();

		return {
			setLayout,
			setGrid,
			setEye,
			setMode,
			setSigma,
			setRange,
			setRamp,
			setGain,
			setCanvas,
			setAnchors,
			update,
			draw,
			destroy,
			get mode() { return mode; },
			get anchorCount() { return anchorCount; },
			get gridW() { return gridW; },
			get gridH() { return gridH; },
			get rampName() { return rampName; },
			MAX_ANCHORS,
		};
	}

	const DistanceFieldRenderer = {
		createDistanceFieldRenderer,
		packUniform,
		UNIFORM_FLOATS,
		UNIFORM_BYTES,
		MAX_ANCHORS,
		MODE_INDEX,
	};

	if (typeof module !== 'undefined') module.exports = DistanceFieldRenderer;
	if (typeof window !== 'undefined') window.DistanceFieldRenderer = DistanceFieldRenderer;
})();
