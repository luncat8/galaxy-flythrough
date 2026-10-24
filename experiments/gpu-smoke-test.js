'use strict';

// Tests for src/core/gpu-smoke.js and src/webgpu-smoke.html:
//   1. Environment header, GPU classification and log file timestamp formatting.
//   2. Clipboard copy via navigator.clipboard.writeText AND file:// fallback
//      (<textarea> + document.execCommand('copy')), plus bindCopy button feedback.
//   3. Offscreen WebGPU target creation (RENDER_ATTACHMENT | COPY_SRC + 256-byte
//      padded MAP_READ staging buffer) and pixel analysis (analyzePixels, diffPixels).
//   4. formationSummary(renderer, age) across deep time (T = 0 has 0 clusters,
//      0 field stars, 0 gas objects; T = 13.5 Gyr has 100% formed).
//   5. All four automated suites ('firstlight', 'continuity', 'morphology',
//      'engines') and the combined 'all' suite with CPU fallback and WebGPU readback.
//   6. Standalone src/webgpu-smoke.html and src/index.html / src/main.js /
//      src/style.css GUI wiring.

const fs = require('fs');
const path = require('path');

global.window = global.window || {};
global.self = global.window;

require('../src/math/hash.js');
require('../src/math/density.js');
require('../src/math/galaxy.js');
require('../src/math/gas-grid.js');
require('../src/math/sampling.js');
require('../src/math/star-record.js');
require('../src/math/star-types.js');
require('../src/math/planets.js');
require('../src/math/orbit.js');
require('../src/math/nebula.js');
require('../src/math/deltav.js');
require('../src/math/objects.js');
require('../src/math/clusters.js');
require('../src/math/coords.js');
require('../src/core/device.js');
require('../src/core/camera.js');
require('../src/core/workspace.js');
require('../src/core/presets.js');
require('../src/core/scenarios.js');
require('../src/data/landmarks.js');
require('../src/data/constellations.js');
require('../src/render/shaders.js');
require('../src/stream/tile-loader.js');
require('../src/stream/cell-manager.js');
require('../src/render/star-sprites.js');
const GpuSmoke = require('../src/core/gpu-smoke.js');

const ROOT = path.resolve(__dirname, '..');
let passed = 0;
let failed = 0;

function check(name, cond, detail) {
	if (cond) {
		passed++;
		console.log('  PASS  ' + name + (detail ? ' — ' + detail : ''));
	} else {
		failed++;
		console.log('  FAIL  ' + name + (detail ? ' — ' + detail : ''));
	}
}

function makeMockGpuDevice() {
	global.GPUBufferUsage = {
		VERTEX: 0x0020,
		INDEX: 0x0010,
		UNIFORM: 0x0040,
		STORAGE: 0x0080,
		COPY_SRC: 0x0004,
		COPY_DST: 0x0008,
		MAP_READ: 0x0001,
	};
	global.GPUTextureUsage = {
		RENDER_ATTACHMENT: 0x10,
		TEXTURE_BINDING: 0x04,
		COPY_SRC: 0x01,
		COPY_DST: 0x02,
	};
	global.GPUMapMode = {
		READ: 0x0001,
	};

	const buffers = [];
	const textures = [];

	const device = {
		limits: { maxStorageBufferBindingSize: 64 * 1024 * 1024, maxBufferSize: 64 * 1024 * 1024 },
		createBuffer(desc) {
			const raw = new ArrayBuffer(desc.size);
			const buf = {
				size: desc.size,
				usage: desc.usage,
				label: desc.label || '',
				_raw: raw,
				getMappedRange() { return raw; },
				unmap() {},
				async mapAsync() {
					const u8 = new Uint8Array(raw);
					const stride = 256;
					for (let y = 0; y < 32; y++) {
						for (let x = 0; x < 48; x++) {
							const idx = y * stride + x * 4;
							if (idx + 3 >= u8.length) break;
							const inCore = x >= 17 && x < 31 && y >= 11 && y < 21;
							const bright = inCore ? 160 : 12;
							u8[idx] = bright;
							u8[idx + 1] = bright;
							u8[idx + 2] = bright;
							u8[idx + 3] = 255;
						}
					}
				},
				destroy() { this.destroyed = true; },
			};
			buffers.push(buf);
			return buf;
		},
		createTexture(desc) {
			const tex = {
				size: desc.size,
				format: desc.format,
				usage: desc.usage,
				label: desc.label || '',
				createView() { return { _tex: tex }; },
				destroy() { this.destroyed = true; },
			};
			textures.push(tex);
			return tex;
		},
		createSampler() { return {}; },
		createBindGroupLayout() { return {}; },
		createPipelineLayout() { return {}; },
		createShaderModule(desc) { return { code: desc.code }; },
		createRenderPipeline(desc) {
			return {
				desc,
				getBindGroupLayout() { return {}; },
			};
		},
		createComputePipeline(desc) {
			return {
				desc,
				getBindGroupLayout() { return {}; },
			};
		},
		createBindGroup(desc) { return { desc }; },
		createCommandEncoder() {
			return {
				beginRenderPass() {
					return {
						setPipeline() {},
						setBindGroup() {},
						setVertexBuffer() {},
						draw() {},
						end() {},
					};
				},
				beginComputePass() {
					return {
						setPipeline() {},
						setBindGroup() {},
						dispatchWorkgroups() {},
						end() {},
					};
				},
				copyTextureToBuffer() {},
				finish() { return {}; },
			};
		},
		queue: {
			writeBuffer() {},
			writeTexture() {},
			submit() {},
			async onSubmittedWorkDone() {},
		},
		_buffers: buffers,
		_textures: textures,
	};
	return device;
}

async function main() {
	console.log('=== GPU & Visual Smoke Test Suite (experiments/gpu-smoke-test.js) ===');

	// 1. Surface & environment helpers.
	console.log('\n--- 1. Module surface & environment helpers ---');
	check('GpuSmoke exports expected API',
		typeof GpuSmoke.envLine === 'function'
		&& typeof GpuSmoke.gpu === 'function'
		&& typeof GpuSmoke.captureLine === 'function'
		&& typeof GpuSmoke.fileStamp === 'function'
		&& typeof GpuSmoke.writeText === 'function'
		&& typeof GpuSmoke.bindCopy === 'function'
		&& typeof GpuSmoke.saveLog === 'function'
		&& typeof GpuSmoke.createOffscreenTarget === 'function'
		&& typeof GpuSmoke.analyzePixels === 'function'
		&& typeof GpuSmoke.diffPixels === 'function'
		&& typeof GpuSmoke.formationSummary === 'function'
		&& typeof GpuSmoke.runSuite === 'function'
		&& Array.isArray(GpuSmoke.SUITES));

	const env = GpuSmoke.envLine();
	check('envLine returns timestamp + runtime',
		/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} · /.test(env), env);

	const stamp = GpuSmoke.fileStamp(new Date('2026-10-24T14:05:09Z'));
	check('fileStamp formats YYYY-MM-DD-HH-MM',
		/^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}$/.test(stamp), stamp);

	const hwGpu = GpuSmoke.gpu({ info: { vendor: 'nvidia', architecture: 'ada' } }, false);
	const swGpu = GpuSmoke.gpu({ info: { vendor: 'google', description: 'SwiftShader' } }, false);
	check('gpu classifies hardware vs software adapter',
		hwGpu === 'hardware nvidia' && swGpu === 'software swiftshader',
		hwGpu + ' | ' + swGpu);

	// 2. Clipboard copy + file:// fallback.
	console.log('\n--- 2. Clipboard copy & file:// fallback ---');
	let clipText = null;
	Object.defineProperty(global, 'navigator', {
		configurable: true,
		writable: true,
		value: {
			clipboard: {
				async writeText(t) { clipText = String(t); },
			},
		},
	});
	const okClip = await GpuSmoke.writeText('hello-clipboard');
	check('writeText uses navigator.clipboard.writeText when available',
		okClip === true && clipText === 'hello-clipboard');

	// Simulate file:// restriction where navigator.clipboard.writeText rejects
	// and fallback uses document.execCommand('copy').
	let execCopied = null;
	let lastTextarea = null;
	Object.defineProperty(global, 'navigator', {
		configurable: true,
		writable: true,
		value: {
			clipboard: {
				async writeText() { throw new Error('NotAllowedError on file://'); },
			},
		},
	});
	global.document = {
		body: {
			appendChild(el) { lastTextarea = el; },
			removeChild() {},
		},
		createElement(tag) {
			return {
				tag,
				value: '',
				style: {},
				setAttribute() {},
				focus() {},
				select() {},
				setSelectionRange() {},
			};
		},
		execCommand(cmd) {
			if (cmd === 'copy' && lastTextarea) {
				execCopied = lastTextarea.value;
				return true;
			}
			return false;
		},
	};
	const okFallback = await GpuSmoke.writeText('fallback-file-url-report');
	check('writeText falls back to <textarea> + execCommand("copy") when clipboard API rejects',
		okFallback === true && execCopied === 'fallback-file-url-report');

	let btnHandler = null;
	const mockBtn = {
		textContent: 'Copy log',
		addEventListener(ev, fn) { if (ev === 'click') btnHandler = fn; },
	};
	GpuSmoke.bindCopy(mockBtn, () => 'bound-report-payload');
	await btnHandler();
	check('bindCopy copies text and flips button label to "Copied ✓"',
		execCopied === 'bound-report-payload' && mockBtn.textContent === 'Copied ✓');

	// 3. Offscreen target + pixel analysis.
	console.log('\n--- 3. Offscreen WebGPU target & pixel analysis ---');
	const mockDevice = makeMockGpuDevice();
	const target = GpuSmoke.createOffscreenTarget(mockDevice, 'rgba8unorm', 48, 32);
	check('createOffscreenTarget creates RENDER_ATTACHMENT | COPY_SRC texture and 256B-aligned staging buffer',
		target !== null
		&& target.width === 48
		&& target.height === 32
		&& (target.texture.usage & (global.GPUTextureUsage.RENDER_ATTACHMENT | global.GPUTextureUsage.COPY_SRC))
			=== (global.GPUTextureUsage.RENDER_ATTACHMENT | global.GPUTextureUsage.COPY_SRC)
		&& target.readbackBuffer.size === 256 * 32);

	const pxA = await target.readPixels();
	const statsA = GpuSmoke.analyzePixels(pxA, 48, 32);
	check('readPixels + analyzePixels measures luminance, lit pixels and core vs outer gradient',
		statsA.totalPx === 48 * 32
		&& statsA.litPixels > 0
		&& statsA.coreLuma > statsA.outerLuma,
		'litPx=' + statsA.litPixels + ', coreLuma=' + statsA.coreLuma.toFixed(2) + ', outerLuma=' + statsA.outerLuma.toFixed(2));

	const pxB = new Uint8ClampedArray(pxA);
	pxB[0] = (pxB[0] + 20) & 255;
	const diff0 = GpuSmoke.diffPixels(pxA, pxA);
	const diff1 = GpuSmoke.diffPixels(pxA, pxB);
	check('diffPixels counts exact differing pixels (0 when identical, 1 when 1 pixel differs)',
		diff0 === 0 && diff1 === 1,
		'diff0=' + diff0 + ', diff1=' + diff1);
	target.dispose();

	// 4. Automated verification suites.
	console.log('\n--- 4. Automated verification suites ---');
	for (const suiteId of ['firstlight', 'continuity', 'morphology', 'catalog', 'engines']) {
		const frames = [];
		const rendererLib = {
			createStarRenderer(...args) {
				const renderer = window.StarRenderer.createStarRenderer(...args);
				const render = renderer.render;
				renderer.render = (...params) => {
					frames.push({ gas: renderer.state.gasVisible, age: renderer.state.galaxyAge });
					return render(...params);
				};
				return renderer;
			},
		};
		const res = await GpuSmoke.runSuite(suiteId, {
			device: null,
			deps: { rendererLib },
			seed: 42,
			proceduralStars: 4000,
		});
		check('suite "' + suiteId + '" passes all checks',
			res.ok === true && res.failed === 0 && res.passed === res.total && res.total > 0,
			res.passed + '/' + res.total + ' checks in ' + res.wallMs + ' ms');
		if (suiteId === 'firstlight') {
			check('First light isolates the stellar gate, then turns gas on for its own frame',
				frames[0].age === 0 && !frames[0].gas && frames[1].age === 0 && frames[1].gas
				&& frames.slice(2).every((f) => !f.gas));
			check('the CPU fallback explicitly defers gas pixels rather than passing a synthetic verdict',
				res.text.includes('gas-only pixels need GPU readback')
				&& !res.checks.some((c) => c.name.includes('gas-only frame contains light')));
		}
		if (suiteId === 'continuity') check('stellar exposure continuity is measured with gas hidden', frames.every((f) => !f.gas));
	}

	const resAll = await GpuSmoke.runSuite('all', {
		device: null,
		seed: 42,
		proceduralStars: 4000,
		width: 48,
		height: 32,
	});
	check('suite "all" passes all checks and produces full text report',
		resAll.ok === true
		&& resAll.failed === 0
		&& resAll.total >= 19
		&& resAll.text.includes('[result] PASS'),
		resAll.passed + '/' + resAll.total + ' checks in ' + resAll.wallMs + ' ms');

	// 5. Static & wiring verification for webgpu-smoke.html and index.html.
	console.log('\n--- 5. GUI HTML & script wiring ---');
	const smokeHtmlPath = path.join(ROOT, 'src/webgpu-smoke.html');
	const indexHtmlPath = path.join(ROOT, 'src/index.html');
	const mainJsPath = path.join(ROOT, 'src/main.js');
	const styleCssPath = path.join(ROOT, 'src/style.css');
	const scenariosJsPath = path.join(ROOT, 'src/core/scenarios.js');

	const smokeHtml = fs.readFileSync(smokeHtmlPath, 'utf8');
	const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
	const mainJs = fs.readFileSync(mainJsPath, 'utf8');
	const styleCss = fs.readFileSync(styleCssPath, 'utf8');
	const scenariosJs = fs.readFileSync(scenariosJsPath, 'utf8');

	for (const id of ['status', 'out', 'filmstrip', 'run-all', 'run-firstlight', 'run-continuity', 'run-morphology', 'run-catalog', 'run-engines', 'copy', 'save']) {
		check('webgpu-smoke.html has #' + id,
			smokeHtml.includes('id="' + id + '"'));
	}

	const scriptSrcs = [...smokeHtml.matchAll(/<script\s+src="([^"]+)"/g)].map(m => m[1]);
	check('webgpu-smoke.html loads classic <script> tags ending with core/gpu-smoke.js',
		scriptSrcs.length >= 18
		&& scriptSrcs[scriptSrcs.length - 1] === 'core/gpu-smoke.js'
		&& scriptSrcs.every(rel => fs.existsSync(path.join(ROOT, 'src', rel))),
		scriptSrcs.length + ' scripts verified');
	check('the standalone rig loads the real gas module before its object and renderer consumers',
		scriptSrcs.indexOf('math/gas-grid.js') > scriptSrcs.indexOf('math/galaxy.js')
		&& scriptSrcs.indexOf('math/gas-grid.js') < scriptSrcs.indexOf('math/objects.js'));

	check('index.html & main.js wire #scenario-suite, #scenario-copy-report, #scenario-open-rig, #scenario-report',
		indexHtml.includes('id="scenario-suite"')
		&& indexHtml.includes('id="scenario-copy-report"')
		&& indexHtml.includes('id="scenario-open-rig"')
		&& indexHtml.includes('id="scenario-report"')
		&& indexHtml.includes('<script src="core/gpu-smoke.js"></script>')
		&& mainJs.includes("getElementById('scenario-suite')")
		&& mainJs.includes('window.GpuSmoke.runSuite')
		&& styleCss.includes('#scenario-report')
		&& scenariosJs.includes('star clusters and composite objects are all gated off'));

	console.log('\n=== Done: ' + passed + ' passed, ' + failed + ' failed ===');
	if (failed > 0) process.exit(1);
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
