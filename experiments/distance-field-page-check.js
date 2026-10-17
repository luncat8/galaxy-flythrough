// experiments/distance-field-page-check.js
// Headless boot + drive check for the standalone distance-field page
// (src/distance-field.html).
//
// The law has its own test (experiments/distance-field-test.js) and the GPU
// path has its own parity test (experiments/wgsl-exec-check.js). What neither
// can see is the page: whether the radio buttons and the sliders are wired to
// the renderer, whether the anchors reach the GPU, and whether the four
// render types and the four star sources each change what the GPU is told.
//
// So this harness stubs a WebGPU device and a DOM, evaluates the real page
// scripts in the real <script> order, pumps frames, and inspects the uniform
// and anchor uploads the page made.
//
// Run: node experiments/distance-field-page-check.js
// Output: experiments/logs/distance-field-page.json

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
	return !!pass;
}

// --- a mock WebGPU device ------------------------------------------------
globalThis.GPUBufferUsage = { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 };
globalThis.GPUTextureUsage = { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };
globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };

function createMockGpu() {
	const gpu = {
		buffers: [], textures: [], shaderModules: [], pipelines: [],
		uniformWrites: [], anchorWrites: [],
		computePasses: [], renderPasses: [], draws: [],
	};
	gpu.device = {
		limits: {
			maxStorageBufferBindingSize: 256 * 1024 * 1024,
			maxBufferSize: 256 * 1024 * 1024,
			maxStorageBuffersPerShaderStage: 8,
			maxComputeWorkgroupsPerDimension: 65535,
		},
		lost: new Promise(() => {}),
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
		createBindGroupLayout(desc) { return { desc }; },
		createPipelineLayout(desc) { return { desc }; },
		createRenderPipeline(desc) { gpu.pipelines.push(desc); return { label: desc.label }; },
		createComputePipeline(desc) { gpu.pipelines.push(desc); return { label: desc.label }; },
		createBindGroup(desc) { return { desc }; },
		createCommandEncoder(desc) {
			return {
				label: desc && desc.label,
				beginRenderPass(passDesc) {
					const pass = {
						label: passDesc && passDesc.label,
						desc: passDesc,
						draw(vertices) { gpu.draws.push({ vertices, pass: this.label }); },
						setPipeline() {}, setBindGroup() {}, end() {},
					};
					gpu.renderPasses.push(pass);
					return pass;
				},
				beginComputePass(passDesc) {
					const pass = {
						label: passDesc && passDesc.label,
						dispatches: [],
						dispatchWorkgroups(x, y, z) { this.dispatches.push([x, y || 1, z || 1]); },
						setPipeline() {}, setBindGroup() {}, end() {},
					};
					gpu.computePasses.push(pass);
					return pass;
				},
				finish() { return { label: 'command-buffer' }; },
			};
		},
		queue: {
			writeTexture() {},
			writeBuffer(buffer, offset, data, dataOffset, size) {
				// The real API counts dataOffset and size in *elements* for a
				// typed array and in bytes for an ArrayBuffer.
				const view = ArrayBuffer.isView(data);
				const elem = view ? data.BYTES_PER_ELEMENT : 1;
				const start = (dataOffset || 0) * elem;
				const length = size === undefined ? data.byteLength - start : size * elem;
				const buf = view ? data.buffer : data;
				const base = view ? data.byteOffset : 0;
				const copy = new Uint8Array(buf, base + start, length).slice();
				if (buffer.label === 'field-uniform') gpu.uniformWrites.push(copy);
				else if (buffer.label === 'field-anchors') gpu.anchorWrites.push(copy);
			},
			submit() {},
		},
	};
	gpu.context = {
		configured: null,
		configure(cfg) { this.configured = cfg; },
		getCurrentTexture: () => ({ width: 960, height: 540, createView: () => ({}) }),
	};
	gpu.format = 'bgra8unorm';
	return gpu;
}

// --- the DOM -------------------------------------------------------------
const VIEW_W = 960, VIEW_H = 540;

function makeElement(id, extra) {
	const el = Object.assign({
		id, value: '', checked: false, textContent: '', style: {}, dataset: {},
		_listeners: {},
		addEventListener(t, fn) { (el._listeners[t] || (el._listeners[t] = [])).push(fn); },
		fire(t) { const l = el._listeners[t]; if (l) for (const fn of l) fn({ preventDefault() {} }); },
		appendChild() {}, remove() {},
	}, extra || {});
	return el;
}

const gpu = createMockGpu();
const canvas = {
	id: 'field', width: VIEW_W, height: VIEW_H, clientWidth: VIEW_W, clientHeight: VIEW_H,
	style: {}, _listeners: {},
	getContext(kind) {
		if (kind === 'webgpu') return gpu.context;
		return null;
	},
	addEventListener(t, fn) { (this._listeners[t] || (this._listeners[t] = [])).push(fn); },
	getBoundingClientRect() { return { left: 0, top: 0, width: VIEW_W, height: VIEW_H }; },
};
const els = { field: canvas };
function el(id) {
	if (!els[id]) els[id] = makeElement(id);
	return els[id];
}

const html = fs.readFileSync(path.join(SRC, 'distance-field.html'), 'utf8');
for (const m of html.matchAll(/id="([^"]+)"/g)) el(m[1]);
for (const m of html.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]+)"/g)) {
	el(`${m[1]}=${m[2]}`, { value: m[2], checked: false });
}

let rafQueue = [];
globalThis.window = globalThis;
globalThis.location = { search: '' };
globalThis.devicePixelRatio = 1;
globalThis.requestAnimationFrame = (fn) => { rafQueue.push(fn); return rafQueue.length; };
globalThis.cancelAnimationFrame = () => {};
globalThis.addEventListener = () => {};
globalThis.document = {
	createElement: (tag) => makeElement(tag),
	getElementById: (id) => el(id),
	querySelectorAll(sel) {
		const m = /^input\[name="([^"]+)"\]$/.exec(sel);
		if (!m) return [];
		return Object.values(els).filter((e) => e.id && e.id.startsWith(m[1] + '='));
	},
	querySelector(sel) {
		const m = /^input\[name="([^"]+)"\]:checked$/.exec(sel);
		if (!m) return null;
		return Object.values(els).find((e) => e.id && e.id.startsWith(m[1] + '=') && e.checked) || null;
	},
	head: { appendChild: () => {} },
};
// The mock adapter, so core/device.js boots without a browser.
Object.defineProperty(globalThis, 'navigator', {
	value: {
		gpu: {
			requestAdapter: async () => ({
				limits: {
					maxStorageBufferBindingSize: 256 * 1024 * 1024,
					maxBufferSize: 256 * 1024 * 1024,
					maxStorageBuffersPerShaderStage: 8,
					maxComputeWorkgroupsPerDimension: 65535,
				},
				requestDevice: async () => gpu.device,
			}),
			getPreferredCanvasFormat: () => 'bgra8unorm',
		},
	},
	configurable: true,
	writable: true,
});

// Radio groups default to whichever tag carries `checked` in the HTML.
for (const m of html.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]+)"[^>]*checked/g)) {
	el(`${m[1]}=${m[2]}`).checked = true;
}
for (const m of html.matchAll(/id="(slider-[^"]+)"[^>]*value="([^"]+)"/g)) {
	const e = el(m[1]);
	e.value = m[2];
	e.fire('input');
}

// --- load the page's scripts, in the order the page declares them ---------
const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
check('the page loads the shared law, the ramps, the shaders, the renderer and the boot last',
	scripts.includes('math/distance-field.js')
	&& scripts.includes('render/distance-ramps.js')
	&& scripts.includes('render/shaders.js')
	&& scripts.includes('render/distance-field-renderer.js')
	&& scripts[scripts.length - 1] === 'distance-field-page.js',
	scripts);
check('the page loads the catalog bundle as a data script',
	scripts.includes('data/tiles/catalog.js'), scripts.filter((s) => s.includes('catalog')));

const errors = [];
for (const rel of scripts) {
	const file = path.join(SRC, rel);
	if (!fs.existsSync(file)) { errors.push(`missing ${rel}`); continue; }
	try {
		vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
	} catch (e) {
		errors.push(`${rel}: ${e && e.message}`);
	}
}
check('every script in the page evaluates in order', errors.length === 0, errors);

// The boot is async (it awaits the device), so let the microtasks run.
async function settle() {
	for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
}

let clock = 0;
function pump(frames, t0) {
	let t = Math.max(t0 || 0, clock);
	for (let i = 0; i < frames; i++) {
		const q = rafQueue; rafQueue = [];
		t += 16.7;
		for (const fn of q) {
			try { fn(t); } catch (e) { errors.push(`frame: ${e && e.stack ? e.stack.split('\n')[0] : e}`); }
		}
	}
	clock = t;
	return t;
}

function lastUniform() {
	const w = gpu.uniformWrites[gpu.uniformWrites.length - 1];
	return w ? new Float32Array(w.buffer, w.byteOffset, w.byteLength / 4) : null;
}
function lastAnchors() {
	const w = gpu.anchorWrites[gpu.anchorWrites.length - 1];
	return w ? new Float32Array(w.buffer, w.byteOffset, w.byteLength / 4) : null;
}

(async function main() {
	await settle();
	check('the page booted without a boot error', !el('error').textContent, el('error').textContent);
	check('the page published its state', !!window.DistanceFieldPage, typeof window.DistanceFieldPage);

	const t1 = pump(4);
	check('the first frames ran clean', errors.length === 0, errors.slice(0, 3));

	const page = window.DistanceFieldPage;
	check('the page reports the mode, the source and the projection',
		/distance field · height · nearest · view/.test(el('readout').textContent),
		el('readout').textContent.split('\n')[0]);
	check('the page has anchors', page && page.anchorCount > 0, page && page.anchorCount);

	// The GPU side: a compute pass over the grid, and a display pass.
	check('the field computed on the GPU', gpu.computePasses.length > 0
		&& gpu.computePasses[0].dispatches.length > 0, gpu.computePasses.map((p) => p.dispatches));
	check('the field was displayed', gpu.renderPasses.some((p) => p.label === 'field-display'),
		gpu.renderPasses.map((p) => p.label));
	check('the compute pass covers the whole grid',
		(() => {
			const u = lastUniform();
			if (!u) return 'no uniform';
			const w = u[24], h = u[25];
			const d = gpu.computePasses[0].dispatches[0];
			return d[0] * 8 >= w && d[1] * 8 >= h && u[24] > 0 && u[25] > 0;
		})(), lastUniform() ? [lastUniform()[24], lastUniform()[25]] : null);

	// The uniform carries the state the page set.
	{
		const u = lastUniform();
		check('the uniform carries the mode, the anchor count and the eye',
			u && u[26] === 0 && u[15] === page.anchorCount && Math.abs(u[0] - page.eye[0]) < 1e-6,
			u ? { mode: u[26], anchors: u[15], eye: u[0] } : null);
	}
	// The anchors reach the GPU as n*16 bytes.
	{
		const a = lastAnchors();
		check('the anchors reached the GPU as n×16 bytes',
			a && a.length === page.anchorCount * 4 && page.anchorCount > 0,
			a ? { floats: a.length, anchors: page.anchorCount } : null);
	}

	// --- the render type radio ------------------------------------------
	function selectRadio(name, value) {
		for (const e of Object.values(els)) {
			if (e.id && e.id.startsWith(name + '=')) e.checked = e.id === `${name}=${value}`;
		}
		const target = el(`${name}=${value}`, { value });
		target.value = value;
		target.fire('change');
	}
	selectRadio('field-mode', 'spread');
	pump(3, t1 + 100);
	check('the spread radio reaches the GPU', (() => {
		const u = lastUniform();
		return u && u[26] === 1;
	})(), lastUniform() ? lastUniform()[26] : null);
	check('the readout follows the render type', /distance field · spread/.test(el('readout').textContent),
		el('readout').textContent.split('\n')[0]);

	selectRadio('field-mode', 'gradient');
	pump(3, t1 + 200);
	check('the gradient radio reaches the GPU', (() => {
		const u = lastUniform();
		return u && u[26] === 2;
	})(), lastUniform() ? lastUniform()[26] : null);
	check('the gradient mode runs the slope pass too',
		gpu.computePasses.some((p) => p.dispatches.length >= 2),
		gpu.computePasses.map((p) => p.dispatches.length));

	const dispatchesBefore = gpu.computePasses.length;
	selectRadio('field-mode', 'off');
	pump(3, t1 + 300);
	check('the off radio stops the compute and the display',
		gpu.computePasses.length === dispatchesBefore
		&& gpu.renderPasses.some((p) => p.label === 'field-off'),
		{ compute: gpu.computePasses.length, passes: gpu.renderPasses.map((p) => p.label) });

	// --- the star source radio ------------------------------------------
	selectRadio('field-mode', 'height');
	selectRadio('field-source', 'constellations');
	pump(3, t1 + 400);
	const constAnchors = window.DistanceFieldPage.anchorCount;
	check('the constellations source gives the named stars',
		constAnchors > 0 && constAnchors <= 1024, constAnchors);
	selectRadio('field-source', 'sky');
	pump(3, t1 + 500);
	check('the whole-sky source gives the anchor cap', window.DistanceFieldPage.anchorCount > constAnchors,
		{ sky: window.DistanceFieldPage.anchorCount, constellations: constAnchors });

	// --- the source slider -----------------------------------------------
	// The slider is the same choice the radio buttons make: it must move the
	// radio with it, so the two controls cannot disagree.
	selectRadio('field-source', 'nearest');
	pump(2, t1 + 550);
	el('slider-source').value = '2';
	el('slider-source').fire('input');
	pump(3, t1 + 575);
	check('the source slider picks the source and moves the radio with it',
		window.DistanceFieldPage.source === 'constellations'
		&& el('field-source=constellations').checked === true,
		{ source: window.DistanceFieldPage.source, radio: el('field-source=constellations').checked });

	// --- the count slider ------------------------------------------------
	selectRadio('field-source', 'nearest');
	pump(3, t1 + 600);
	el('slider-count').value = '25';
	el('slider-count').fire('input');
	pump(3, t1 + 700);
	check('the count slider changes the number of anchors',
		window.DistanceFieldPage.anchorCount === 25, window.DistanceFieldPage.anchorCount);
	{
		const a = lastAnchors();
		check('the anchors uploaded match the count', a && a.length === 25 * 4, a ? a.length : null);
	}

	// --- the projection radio -------------------------------------------
	const viewW = lastUniform()[24];
	selectRadio('field-projection', 'plane');
	pump(3, t1 + 800);
	{
		const u = lastUniform();
		check('the chart radio switches the layout and doubles the grid',
			u && u[27] === 1 && u[24] > viewW, u ? { layout: u[27], w: u[24], was: viewW } : null);
	}
	selectRadio('field-projection', 'view');
	pump(3, t1 + 900);
	{
		const u = lastUniform();
		check('the view radio switches back', u && u[27] === 0, u ? u[27] : null);
	}

	// --- the sigma slider -----------------------------------------------
	const sigmaBefore = lastUniform()[11];
	el('slider-sigma').value = '9';
	el('slider-sigma').fire('input');
	pump(3, t1 + 1000);
	check('the sigma slider changes the hill width',
		Math.abs(lastUniform()[11] - sigmaBefore) > 1e-4,
		{ before: sigmaBefore, after: lastUniform()[11] });

	// --- the click picker ----------------------------------------------
	const before = window.DistanceFieldPage.anchorCount;
	el('field')._listeners.click.forEach((fn) => fn({ clientX: VIEW_W / 2, clientY: VIEW_H / 2, preventDefault() {} }));
	pump(2, t1 + 1100);
	check('a click picks a star into the selection',
		window.DistanceFieldPage.pickedCount > 0, window.DistanceFieldPage.pickedCount);
	selectRadio('field-source', 'selected');
	pump(3, t1 + 1200);
	check('the selected source uses the picks',
		window.DistanceFieldPage.anchorCount === window.DistanceFieldPage.pickedCount,
		{ anchors: window.DistanceFieldPage.anchorCount, picked: window.DistanceFieldPage.pickedCount });
	el('btn-clear-selection').fire('click');
	pump(2, t1 + 1300);
	check('the clear button empties the selection',
		window.DistanceFieldPage.pickedCount === 0, window.DistanceFieldPage.pickedCount);

	check('the page ran the whole drive without an error', errors.length === 0, errors.slice(0, 3));

	// --- the report ------------------------------------------------------
	let passed = 0, failed = 0;
	for (const c of checks) {
		if (c.pass) passed++; else failed++;
		console.log(`  ${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.pass ? '' : `  -> ${JSON.stringify(c.detail)}`}`);
	}
	console.log(`\n${passed}/${checks.length} passed, ${failed} failed`);

	const logPath = path.join(__dirname, 'logs', 'distance-field-page.json');
	fs.mkdirSync(path.dirname(logPath), { recursive: true });
	fs.writeFileSync(logPath, JSON.stringify({
		date: new Date().toISOString(),
		totalChecks: checks.length,
		passed,
		failed,
		checks,
	}, null, 2));
	console.log(`Wrote ${logPath}`);
	console.log('\n=== VERDICT ===');
	console.log(failed === 0
		? 'PASS — the distance-field page drives the renderer from its radio buttons and sliders'
		: `FAIL — ${failed} checks failed`);
	process.exit(failed === 0 ? 0 : 1);
})();
