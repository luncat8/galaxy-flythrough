// src/core/gpu-smoke.js
// Browser & headless WebGPU + visual verification harness, inspired by
// planet-geotectonics (webgpu-smoke.html, tests/gpu-parity.html, js/env.js,
// js/clipboard.js, tests/gpu-readback.js):
//   - concise environment capture header (minute timestamp, browser, OS/arch,
//     GPU hardware/software + vendor word, never raw UA/model noise)
//   - file://-safe clipboard copy (navigator.clipboard with hidden textarea
//     execCommand('copy') fallback and "Copied ✓" button acknowledgement)
//   - offscreen GPU pixel readback via a dedicated RENDER_ATTACHMENT | COPY_SRC
//     texture (never copying from a swapchain canvas texture, which lacks
//     COPY_SRC on D3D12/Metal/Vulkan)
//   - four runnable suites ('firstlight', 'continuity', 'morphology', 'engines',
//     plus 'all') that run on a real WebGPU device when available and degrade
//     cleanly to a recording CPU/mock device under Node.

'use strict';

(function () {
	const ACK_MS = 1200;
	const BROWSERS = [
		[/Edg[A-Za-z]*\/(\d+)/, 'edge'],
		[/OPR\/(\d+)/, 'opera'],
		[/Firefox\/(\d+)/, 'firefox'],
		[/Chrome\/(\d+)/, 'chrome'],
		[/Version\/(\d+)[^)]*Safari/, 'safari'],
	];

	const SUITES = [
		{ id: 'all', label: 'Run all checks', desc: 'Full GPU & visual suite: shaders, First light cluster gate, 3.4–3.6 Gyr continuity, V14 morphology, engines & determinism' },
		{ id: 'firstlight', label: 'Run First Light & clusters', desc: 'T = 0 star-only gate, separate gas-only picture, and 0 → 13.5 Gyr cluster assembly' },
		{ id: 'continuity', label: 'Run 3.4–3.6 Gyr continuity', desc: 'Epoch brightness, magOffset & visible star-count continuity across 3.0–4.0 Gyr and 2 Myr/s fine steps' },
		{ id: 'morphology', label: 'Run V14 visual suite', desc: 'Formation scenarios (First light, Condensation, 1 Gyr gas-rich arms, 2 Gyr bulge assembly, Present day) with 0 redraws' },
		{ id: 'catalog', label: 'Run catalog evolution', desc: 'Nonzero-budget Milky Way catalog/local birth gates, evolving looks and exact reference restoration' },
		{ id: 'engines', label: 'Run engines & determinism', desc: 'All shipping WGSL shader modules, classic/simple/apocenter orbit engines and two-run bit-identical GPU readback' },
	];

	function pad2(n) {
		return n < 10 ? '0' + n : String(n);
	}

	function stamp(date) {
		const d = date || new Date();
		return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
			+ ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
	}

	function fileStamp(date) {
		return stamp(date).replace(' ', '-').replace(':', '-');
	}

	function browser(ua) {
		const text = ua !== undefined ? String(ua)
			: ((typeof navigator !== 'undefined' && navigator.userAgent) || '');
		for (let i = 0; i < BROWSERS.length; i++) {
			const hit = BROWSERS[i][0].exec(text);
			if (hit) return BROWSERS[i][1] + ' ' + hit[1];
		}
		if (typeof process !== 'undefined' && process.versions && process.versions.node) {
			return 'node ' + process.versions.node.split('.')[0];
		}
		return 'unknown';
	}

	function platform(ua, nav) {
		const n = nav || (typeof navigator !== 'undefined' ? navigator : null);
		const text = (ua !== undefined ? String(ua) : ((n && n.userAgent) || ''))
			+ ' ' + ((n && n.platform) || '');
		if (/Windows|Win32|Win64|ARM64/.test(text)) {
			return 'win ' + (/ARM64|aarch64/i.test(text) ? 'arm64' : 'x86_64');
		}
		if (/Android/.test(text)) {
			return 'android ' + (/ARM64|aarch64|arm64/i.test(text) ? 'arm64' : 'x86_64');
		}
		if (/Macintosh|Mac OS X|MacIntel/.test(text)) return 'mac';
		if (/Linux|X11|CrOS/.test(text)) {
			return 'linux ' + (/aarch64|arm64/i.test(text) ? 'arm64' : 'x86_64');
		}
		if (typeof process !== 'undefined' && process.platform) {
			const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
			if (process.platform === 'win32') return 'win ' + arch;
			if (process.platform === 'darwin') return 'mac';
			if (process.platform === 'linux') return 'linux ' + arch;
		}
		return 'unknown';
	}

	function gpu(adapter, fallback) {
		if (!adapter) return 'none';
		const info = adapter.info || {};
		const vendor = String(info.vendor || '').toLowerCase().split(/[^a-z0-9]+/)[0];
		const model = String(info.description || info.device || info.architecture || '').toLowerCase();
		if (fallback || vendor === 'google' || /swiftshader|llvmpipe|lavapipe|software/.test(model)) {
			return 'software ' + (vendor === 'google' || !vendor ? 'swiftshader' : vendor);
		}
		return 'hardware ' + (vendor || 'unknown');
	}

	function envLine(date, ua, nav) {
		return stamp(date) + ' \u00b7 ' + browser(ua) + ' \u00b7 ' + platform(ua, nav);
	}

	function captureLine(adapter, fallback) {
		const ts = adapter && adapter.features && typeof adapter.features.has === 'function'
			&& adapter.features.has('timestamp-query') ? 'yes' : 'no';
		return 'gpu ' + gpu(adapter, fallback) + ' \u00b7 ts-query ' + ts;
	}

	// File://-friendly clipboard copy: navigator.clipboard.writeText when
	// allowed, falling back to a temporary offscreen <textarea> + execCommand.
	function legacyCopy(text) {
		if (typeof document === 'undefined' || !document.body) return false;
		const area = document.createElement('textarea');
		area.value = String(text);
		area.setAttribute('readonly', '');
		area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
		document.body.appendChild(area);
		if (typeof area.select === 'function') area.select();
		let ok = false;
		try {
			ok = !!(document.execCommand && document.execCommand('copy'));
		} catch (e) {
			ok = false;
		}
		document.body.removeChild(area);
		return ok;
	}

	function writeText(text) {
		const str = String(text === undefined ? '' : text);
		if (typeof navigator !== 'undefined' && navigator.clipboard
			&& typeof navigator.clipboard.writeText === 'function') {
			return navigator.clipboard.writeText(str).then(
				() => true,
				() => legacyCopy(str)
			);
		}
		return Promise.resolve(legacyCopy(str));
	}

	function labelAck(button, customAckMs) {
		if (!button) return function () {};
		const original = button.textContent;
		const waitMs = customAckMs > 0 ? customAckMs : ACK_MS;
		let timer = 0;
		return function (ok) {
			if (timer) clearTimeout(timer);
			button.textContent = ok ? 'Copied \u2713' : 'Copy failed';
			timer = setTimeout(function () {
				button.textContent = original;
				timer = 0;
			}, waitMs);
		};
	}

	function bindCopy(button, getText, ack) {
		if (!button || typeof button.addEventListener !== 'function') return null;
		const onDone = ack || labelAck(button);
		button.addEventListener('click', function () {
			const payload = typeof getText === 'function' ? getText() : String(getText || '');
			return writeText(payload).then(onDone);
		});
		return button;
	}

	function saveLog(text, prefix, date) {
		if (typeof document === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') {
			return null;
		}
		const name = (prefix || 'webgpu-smoke') + '-' + fileStamp(date) + '.log';
		const blob = new Blob([String(text || '')], { type: 'text/plain' });
		const link = document.createElement('a');
		link.href = URL.createObjectURL(blob);
		link.download = name;
		link.click();
		URL.revokeObjectURL(link.href);
		return name;
	}

	// Persist the session log straight into experiments/logs/ through the
	// evidence server (scripts/evidence-server.js) — no clipboard or download
	// round trip for the C9 real-GPU runs. The URL is relative so it works
	// behind any proxy prefix; http/https only, since under file:// there is
	// no server (the page hides the button instead of calling this).
	function sendLog(text, name, frames) {
		if (typeof fetch !== 'function') return Promise.reject(new Error('no fetch'));
		const payload = { name: name || 'webgpu-smoke', text: String(text || '') };
		if (Array.isArray(frames) && frames.length > 0) payload.frames = frames;
		return fetch('./__evidence', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		}).then(function (res) {
			return res.json().then(function (j) {
				if (!res.ok || !j || !j.ok) throw new Error((j && j.error) || ('HTTP ' + res.status));
				return j;
			});
		});
	}

	function canSendLog() {
		return typeof location !== 'undefined' && location
			&& /^https?:$/.test(String(location.protocol || ''))
			&& typeof fetch === 'function';
	}

	// Sky clear colour in star-sprites.js is (0.004, 0.005, 0.010) linear ->
	// sRGB/unorm bytes ~(1, 1, 3). Any pixel with luma > 4 is star/nebula light.
	function analyzePixels(rgba, width, height) {
		const w = Math.max(1, width | 0);
		const h = Math.max(1, height | 0);
		const totalPx = w * h;
		if (!rgba || rgba.length < totalPx * 4) {
			return {
				width: w, height: h, totalPx,
				litPixels: 0, brightPixels: 0,
				totalLuma: 0, meanLuma: 0, peakLuma: 0,
				coreLuma: 0, outerLuma: 0, badValues: 0,
			};
		}
		let litPixels = 0;
		let brightPixels = 0;
		let totalLuma = 0;
		let peakLuma = 0;
		let coreSum = 0, coreCount = 0;
		let outerSum = 0, outerCount = 0;
		let badValues = 0;
		const cx0 = Math.floor(w * 0.35), cx1 = Math.ceil(w * 0.65);
		const cy0 = Math.floor(h * 0.35), cy1 = Math.ceil(h * 0.65);
		for (let y = 0; y < h; y++) {
			const inY = y >= cy0 && y < cy1;
			for (let x = 0; x < w; x++) {
				const idx = (y * w + x) * 4;
				const r = rgba[idx];
				const g = rgba[idx + 1];
				const b = rgba[idx + 2];
				if (!Number.isFinite(r + g + b)) {
					badValues++;
					continue;
				}
				const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
				const net = Math.max(0, luma - 2.0);
				if (luma > 4.0) litPixels++;
				if (luma > 25.0) brightPixels++;
				totalLuma += net;
				if (luma > peakLuma) peakLuma = luma;
				if (inY && x >= cx0 && x < cx1) {
					coreSum += net;
					coreCount++;
				} else {
					outerSum += net;
					outerCount++;
				}
			}
		}
		return {
			width: w,
			height: h,
			totalPx,
			litPixels,
			brightPixels,
			totalLuma,
			meanLuma: totalLuma / totalPx,
			peakLuma,
			coreLuma: coreCount > 0 ? coreSum / coreCount : 0,
			outerLuma: outerCount > 0 ? outerSum / outerCount : 0,
			badValues,
		};
	}

	function diffPixels(rgbaA, rgbaB) {
		if (!rgbaA || !rgbaB || rgbaA.length !== rgbaB.length) return -1;
		let diff = 0;
		for (let i = 0; i < rgbaA.length; i += 4) {
			if (rgbaA[i] !== rgbaB[i]
				|| rgbaA[i + 1] !== rgbaB[i + 1]
				|| rgbaA[i + 2] !== rgbaB[i + 2]
				|| rgbaA[i + 3] !== rgbaB[i + 3]) {
				diff++;
			}
		}
		return diff;
	}

	// Offscreen WebGPU target with RENDER_ATTACHMENT | COPY_SRC so readback never
	// copies from a swapchain canvas texture.
	function createOffscreenTarget(device, format, width, height) {
		const w = Math.max(1, width | 0);
		const h = Math.max(1, height | 0);
		const texUsage = (typeof GPUTextureUsage !== 'undefined')
			? (GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING)
			: (0x10 | 0x01 | 0x04);
		const bufUsage = (typeof GPUBufferUsage !== 'undefined')
			? (GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST)
			: (0x01 | 0x08);
		const bytesPerRow = Math.ceil((w * 4) / 256) * 256;
		const texture = device.createTexture({
			label: 'smoke-offscreen-color',
			size: [w, h, 1],
			format: format || 'rgba8unorm',
			usage: texUsage,
		});
		const readbackBuffer = device.createBuffer({
			label: 'smoke-readback-buffer',
			size: bytesPerRow * h,
			usage: bufUsage,
		});
		const context = {
			configured: false,
			configure() { this.configured = true; },
			getCurrentTexture() { return texture; },
		};
		const isBgra = String(format || '').toLowerCase().indexOf('bgra') === 0;

		async function readPixels() {
			if (!device.createCommandEncoder || !readbackBuffer.mapAsync) return null;
			const encoder = device.createCommandEncoder({ label: 'smoke-readback' });
			if (typeof encoder.copyTextureToBuffer !== 'function') return null;
			encoder.copyTextureToBuffer(
				{ texture },
				{ buffer: readbackBuffer, bytesPerRow, rowsPerImage: h },
				[w, h, 1]
			);
			device.queue.submit([encoder.finish()]);
			if (device.queue && typeof device.queue.onSubmittedWorkDone === 'function') {
				await device.queue.onSubmittedWorkDone();
			}
			const readMode = (typeof GPUMapMode !== 'undefined' && GPUMapMode.READ) ? GPUMapMode.READ : 1;
			await readbackBuffer.mapAsync(readMode);
			const mapped = new Uint8Array(readbackBuffer.getMappedRange());
			const out = new Uint8ClampedArray(w * h * 4);
			for (let y = 0; y < h; y++) {
				const rowOff = y * bytesPerRow;
				const dstOff = y * w * 4;
				for (let x = 0; x < w; x++) {
					const s = rowOff + x * 4;
					const d = dstOff + x * 4;
					if (isBgra) {
						out[d] = mapped[s + 2];
						out[d + 1] = mapped[s + 1];
						out[d + 2] = mapped[s];
						out[d + 3] = mapped[s + 3];
					} else {
						out[d] = mapped[s];
						out[d + 1] = mapped[s + 1];
						out[d + 2] = mapped[s + 2];
						out[d + 3] = mapped[s + 3];
					}
				}
			}
			readbackBuffer.unmap();
			return out;
		}

		function dispose() {
			try { if (texture && texture.destroy) texture.destroy(); } catch (e) {}
			try { if (readbackBuffer && readbackBuffer.destroy) readbackBuffer.destroy(); } catch (e) {}
		}

		return { width: w, height: h, format: format || 'rgba8unorm', texture, readbackBuffer, context, readPixels, dispose };
	}

	function resolveDeps(custom) {
		const g = typeof window !== 'undefined' ? window : globalThis;
		const req = (typeof module !== 'undefined' && module.exports && typeof require === 'function')
			? require : null;
		return {
			galaxy: (custom && custom.galaxy) || g.GalaxyLib || (req && req('../math/galaxy.js')),
			starTypes: (custom && custom.starTypes) || g.StarTypesLib || (req && req('../math/star-types.js')),
			sampling: (custom && custom.sampling) || g.SamplingLib || (req && req('../math/sampling.js')),
			orbit: (custom && custom.orbit) || g.OrbitLib || (req && req('../math/orbit.js')),
			clusters: (custom && custom.clusters) || g.ClustersLib || (req && req('../math/clusters.js')),
			objects: (custom && custom.objects) || g.ObjectsLib || (req && req('../math/objects.js')),
			records: (custom && custom.records) || g.StarRecord || (req && req('../math/star-record.js')),
			shaders: (custom && custom.shaders) || g.GalaxyShaders || (req && req('../render/shaders.js')),
			rendererLib: (custom && custom.rendererLib) || g.StarRenderer || (req && req('../render/star-sprites.js')),
			cameraLib: (custom && custom.cameraLib) || g.Camera || (req && req('./camera.js')),
			scenarios: (custom && custom.scenarios) || g.ScenarioLib || (req && req('./scenarios.js')),
			tileLoader: (custom && custom.tileLoader) || g.TileLoader || (req && req('../stream/tile-loader.js')),
			catalogBundle: (custom && custom.catalogBundle) || (req && req('../data/tiles/catalog.js')),
		};
	}

	// Fallback mock GPU device when running in Node or a browser without WebGPU
	// so the structural/exposure/formation gates can still run and produce a report.
	function createFallbackDevice() {
		if (typeof globalThis.GPUBufferUsage === 'undefined') {
			globalThis.GPUBufferUsage = { UNIFORM: 1, STORAGE: 2, COPY_DST: 4, COPY_SRC: 8, MAP_READ: 16 };
		}
		if (typeof globalThis.GPUTextureUsage === 'undefined') {
			globalThis.GPUTextureUsage = { COPY_DST: 1, TEXTURE_BINDING: 2, RENDER_ATTACHMENT: 16, COPY_SRC: 32 };
		}
		if (typeof globalThis.GPUShaderStage === 'undefined') {
			globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
		}
		const device = {
			isFallbackStub: true,
			limits: {
				maxStorageBufferBindingSize: 256 * 1024 * 1024,
				maxBufferSize: 256 * 1024 * 1024,
				maxStorageBuffersPerShaderStage: 8,
			},
			createShaderModule(desc) {
				return {
					label: desc.label,
					code: desc.code,
					getCompilationInfo() { return Promise.resolve({ messages: [] }); },
				};
			},
			createBuffer(desc) {
				return { label: desc.label, size: desc.size, usage: desc.usage, destroy() {} };
			},
			createTexture(desc) {
				return {
					label: desc.label, size: desc.size, format: desc.format, usage: desc.usage,
					createView() { return { label: desc.label }; },
					destroy() {},
				};
			},
			createSampler() { return {}; },
			createBindGroupLayout() { return {}; },
			createPipelineLayout() { return {}; },
			createBindGroup() { return {}; },
			createRenderPipeline() { return {}; },
			createComputePipeline() { return {}; },
			createCommandEncoder() {
				return {
					beginRenderPass() {
						return { setPipeline() {}, setBindGroup() {}, draw() {}, end() {} };
					},
					beginComputePass() {
						return { setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} };
					},
					copyTextureToBuffer() {},
					finish() { return {}; },
				};
			},
			queue: {
				writeBuffer() {},
				writeTexture() {},
				submit() {},
				onSubmittedWorkDone() { return Promise.resolve(); },
			},
		};
		return device;
	}

	function formationSummary(renderer, age) {
		const info = renderer.starBlocks();
		const f = info && info.formation;
		const gateAt = f && f.gateAt;
		const targetAge = age !== undefined ? age : (f ? f.age : 0);
		if (!f || !f.births || !gateAt) {
			return {
				age: targetAge,
				fieldTotal: 0, fieldActive: 0,
				clusterStarsTotal: 0, clusterStarsActive: 0,
				gasStarsTotal: 0, gasStarsActive: 0,
				objectStarsTotal: 0, objectStarsActive: 0,
				landmarkTotal: 0, landmarkActive: 0,
				localTotal: 0, localActive: 0,
				catalogTotal: 0, catalogActive: 0,
				formedFraction: 0, gasFraction: 1,
			};
		}
		let fieldActive = 0;
		for (let i = 0; i < f.count; i++) {
			if (gateAt(f.births[i], targetAge) > 0) fieldActive++;
		}
		const objOff = f.objectOffset | 0;
		const objCnt = f.objectCount | 0;
		const cluCnt = f.clusterCount | 0;
		let clusterStarsActive = 0;
		let gasStarsActive = 0;
		for (let i = 0; i < objCnt; i++) {
			if (gateAt(f.births[objOff + i], targetAge) > 0) {
				if (i < cluCnt) clusterStarsActive++;
				else gasStarsActive++;
			}
		}
		function blockFormation(blockIndex) {
			const block = info.blocks && info.blocks[blockIndex];
			const total = block ? (block.count | 0) : 0;
			const base = block ? (block.offset | 0) : 0;
			let active = 0;
			for (let i = 0; i < total; i++) {
				if (gateAt(f.births[base + i], targetAge) > 0) active++;
			}
			return { total, active };
		}
		const landmarks = blockFormation(1);
		const local = blockFormation(3);
		const catalog = blockFormation(4);
		const formed = renderer.censusFormedAt(targetAge);
		const gasNow = renderer.censusGasAt(targetAge);
		return {
			age: targetAge,
			fieldTotal: f.count,
			fieldActive,
			landmarkTotal: landmarks.total,
			landmarkActive: landmarks.active,
			localTotal: local.total,
			localActive: local.active,
			catalogTotal: catalog.total,
			catalogActive: catalog.active,
			clusterStarsTotal: cluCnt,
			clusterStarsActive,
			gasStarsTotal: Math.max(0, objCnt - cluCnt),
			gasStarsActive,
			objectStarsTotal: objCnt,
			objectStarsActive: clusterStarsActive + gasStarsActive,
			formedFraction: formed !== undefined ? formed : 0,
			gasFraction: gasNow !== undefined ? gasNow : 1,
		};
	}

	// Render one frame from a fixed galaxy-overview camera and return both CPU
	// formation/exposure metrics and (when WebGPU readback is active) pixel stats.
	async function renderEpochSample(renderer, target, camera, modelNow, timeMyr, dtStar) {
		const width = target.width;
		const height = target.height;
		renderer.render(camera, width, height, timeMyr || 0, null, dtStar || 0);
		const rgba = await target.readPixels();
		const cpu = formationSummary(renderer, modelNow.populations.age);
		if (rgba) {
			const px = analyzePixels(rgba, width, height);
			return {
				age: modelNow.populations.age,
				magOffset: renderer.state.magOffset,
				cpu,
				px,
				rgba,
				hasGpuPixels: true,
			};
		}
		// CPU radiance estimate when running under Node stub without real GPU raster.
		// Projects active records across all five blocks through camera.buildViewProj
		// relative to camera.cameraPos (mirroring the vertex stage), so an un-aimed
		// overview camera or an unexpected landmark block shows up immediately in
		// headless Node runs as well as on GPU readback.
		const deps = resolveDeps();
		const info = renderer.starBlocks();
		const births = info.formation.births;
		const vp = camera.buildViewProj(width / height);
		const cpos = camera.cameraPos;
		const posOut = [0, 0, 0];
		let litEst = 0;
		let fluxSum = 0;
		let coreSum = 0;
		let outerSum = 0;
		const LOG2_OVER_LOG10 = 3.321928095;
		const MAG_TO_FLUX = 1.328771238;
		const age = modelNow.populations.age;
		const magOff = renderer.state.magOffset || 0;
		const cx0 = Math.floor(width * 0.35), cx1 = Math.ceil(width * 0.65);
		const cy0 = Math.floor(height * 0.35), cy1 = Math.ceil(height * 0.65);
		const coreArea = Math.max(1, (cx1 - cx0) * (cy1 - cy0));
		const totalPx = width * height;
		const outerArea = Math.max(1, totalPx - coreArea);
		for (let b = 0; b < info.blocks.length; b++) {
			const blk = info.blocks[b];
			if (!blk || blk.count <= 0) continue;
			for (let i = 0; i < blk.count; i++) {
				const slot = blk.offset + i;
				const off = slot * deps.records.RECORD_BYTES;
				const packed = info.view.getUint32(off + 12, true);
				if ((packed & 0x00010000) === 0) continue;
				const g = (births && slot < births.length) ? deps.orbit.gateAt(births[slot], age) : 1;
				if (g <= 0) continue;
				const x = info.view.getFloat32(off, true);
				const y = info.view.getFloat32(off + 4, true);
				const z = info.view.getFloat32(off + 8, true);
				const flags = (packed >>> 16) & 0xFF;
				const family = (flags >>> 3) & 3;
				deps.orbit.epochMap(posOut, x, y, z, family, flags, modelNow);
				const rx = posOut[0] - cpos[0];
				const ry = posOut[1] - cpos[1];
				const rz = posOut[2] - cpos[2];
				const cw = vp[3] * rx + vp[7] * ry + vp[11] * rz + vp[15];
				if (cw <= 0) continue;
				const ndcX = (vp[0] * rx + vp[4] * ry + vp[8] * rz + vp[12]) / cw;
				const ndcY = (vp[1] * rx + vp[5] * ry + vp[9] * rz + vp[13]) / cw;
				if (Math.abs(ndcX) > 1 || Math.abs(ndcY) > 1) continue;
				const distPc = Math.max(Math.hypot(rx, ry, rz) * 1000, 0.1);
				let appMag = deps.records.decodeAbsMag((packed >>> 8) & 0xFF)
					+ 5 * Math.log2(distPc) / LOG2_OVER_LOG10 - 5;
				if ((flags & deps.records.FLAG_EPOCH) !== 0) appMag += magOff;
				const flux = Math.pow(2, -MAG_TO_FLUX * (appMag - 22.0)) * g;
				const toned = (flux / (1 + flux)) * 255;
				fluxSum += toned;
				if (flux > 0.05) litEst++;
				const pxX = (ndcX * 0.5 + 0.5) * width;
				const pxY = (-ndcY * 0.5 + 0.5) * height;
				if (pxX >= cx0 && pxX < cx1 && pxY >= cy0 && pxY < cy1) {
					coreSum += toned;
				} else {
					outerSum += toned;
				}
			}
		}
		return {
			age,
			magOffset: magOff,
			cpu,
			px: {
				width, height, totalPx,
				litPixels: litEst,
				brightPixels: litEst,
				totalLuma: fluxSum,
				meanLuma: fluxSum / totalPx,
				peakLuma: litEst > 0 ? 255 : 0,
				coreLuma: coreSum / coreArea,
				outerLuma: outerSum / outerArea,
				badValues: 0,
			},
			rgba: null,
			hasGpuPixels: false,
		};
	}

	// Whole-galaxy tilted overview camera aimed at the model's galactic centre.
	// Uses cam.setState so internal position, orientation (buildViewProj) and
	// cameraPos stay synchronized with galactic north upright and zero roll.
	function setupGalaxyCamera(cameraLib, model) {
		const cam = cameraLib.createCamera();
		cam.setFrame(model);
		const cx = (model && model.centre && model.centre.x) || 0;
		const dy = -14.0;
		const dz = 7.5;
		cam.setState({
			position: [cx, dy, dz],
			yaw: Math.PI / 2,
			pitch: -Math.atan2(dz, -dy),
			mode: cameraLib.MODE_ORBIT_GC,
		});
		return cam;
	}

	async function runSuite(kind, opts) {
		const cfg = opts || {};
		const deps = resolveDeps(cfg.deps);
		const log = [];
		const checks = [];
		const thumbnails = [];
		const onLine = typeof cfg.onLine === 'function' ? cfg.onLine : null;
		const onProgress = typeof cfg.onProgress === 'function' ? cfg.onProgress : null;
		const width = cfg.width || 192;
		const height = cfg.height || 120;
		const proceduralStars = cfg.proceduralStars || 24000;
		const seed = cfg.seed !== undefined ? cfg.seed : 42;
		const t0 = Date.now();

		function say(line) {
			log.push(line);
			if (onLine) onLine(line);
		}
		function note(tag, line) {
			say('[' + tag + '] ' + line);
		}
		function check(tag, name, pass, detail) {
			const ok = !!pass;
			checks.push({ tag, name, pass: ok, detail });
			const suffix = detail !== undefined ? ' (' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) + ')' : '';
			say('[' + tag + '] ' + (ok ? 'PASS ' : 'FAIL ') + name + suffix);
			return ok;
		}

		const mode = String(kind || 'all').toLowerCase();
		const runShaders = mode === 'all' || mode === 'engines' || mode === 'shaders';
		const runFirstLight = mode === 'all' || mode === 'firstlight';
		const runContinuity = mode === 'all' || mode === 'continuity';
		const runMorphology = mode === 'all' || mode === 'morphology';
		const runCatalog = mode === 'all' || mode === 'catalog';
		const runEngines = mode === 'all' || mode === 'engines';

		note('boot', envLine());
		let device = cfg.device || null;
		let adapter = cfg.adapter || null;
		let format = cfg.format || 'rgba8unorm';
		let usedFallback = false;
		if (!device && typeof navigator !== 'undefined' && navigator.gpu) {
			try {
				adapter = await navigator.gpu.requestAdapter({ forceFallbackAdapter: false });
				if (!adapter) {
					adapter = await navigator.gpu.requestAdapter({ forceFallbackAdapter: true });
					usedFallback = true;
				}
				if (adapter) {
					device = await adapter.requestDevice();
					if (typeof navigator.gpu.getPreferredCanvasFormat === 'function') {
						format = navigator.gpu.getPreferredCanvasFormat();
					}
				}
			} catch (err) {
				note('boot', 'WebGPU requestDevice failed (' + (err && err.message ? err.message : err) + '), using CPU fallback');
			}
		}
		if (!device) {
			device = createFallbackDevice();
			note('boot', 'gpu cpu-fallback (no WebGPU adapter in this environment)');
		} else {
			note('boot', captureLine(adapter, usedFallback) + ' \u00b7 format ' + format);
		}

		let catalogManifest = cfg.catalogManifest || null;
		let catalogLoadError = null;
		if (runCatalog && !catalogManifest) {
			try {
				if (deps.catalogBundle && deps.tileLoader) {
					catalogManifest = deps.tileLoader.prepareBundle(deps.catalogBundle);
				} else if (deps.tileLoader && typeof document !== 'undefined') {
					// Script injection keeps this valid from file:// as well as HTTP.
					catalogManifest = await deps.tileLoader.loadCatalog(cfg.catalogUrl || 'data/tiles/catalog.js');
				}
			} catch (err) {
				catalogLoadError = err;
			}
			if (!catalogManifest && !catalogLoadError) catalogLoadError = new Error('no catalog bundle or TileLoader');
		}

		// The zero-budget suites remain regression controls. Catalog evolution is
		// checked by the explicit nonzero-budget suite below, never inferred from
		// a First light run that has no streaming records.
		if ((runFirstLight || runContinuity || runMorphology) && !runCatalog) {
			note('coverage', 'these formation controls use catalogBudgetStars=0; run the catalog suite for streaming evolution coverage');
		}

		// 1. WGSL shader compilation smoke
		if (runShaders) {
			if (onProgress) onProgress('compiling WGSL shaders');
			let allCompiled = true;
			const moduleNames = deps.shaders.SHADER_MODULES;
			for (let i = 0; i < moduleNames.length; i++) {
				const modName = moduleNames[i];
				const code = deps.shaders.SHADERS[modName];
				let modOk = typeof code === 'string' && code.length > 100;
				let errText = '';
				try {
					const mod = device.createShaderModule({ label: 'smoke-' + modName, code });
					if (mod && typeof mod.getCompilationInfo === 'function') {
						const info = await mod.getCompilationInfo();
						const errs = (info && info.messages || []).filter((m) => m.type === 'error');
						if (errs.length > 0) {
							modOk = false;
							errText = errs.map((m) => m.message).join('; ');
						}
					}
				} catch (err) {
					modOk = false;
					errText = String((err && err.message) || err);
				}
				if (!modOk) allCompiled = false;
				check('shaders', modName + ' compiles cleanly', modOk,
					errText || (code.length + ' chars'));
			}
			check('shaders', 'all ' + moduleNames.length + ' shipping WGSL modules valid', allCompiled, moduleNames.join(', '));
		}

		const target = createOffscreenTarget(device, format, width, height);

		try {
			// 2. First Light (T = 0) & Cluster/Object Birth Gate
			// Uses procedural Sb (milkyWay=false, landmarkCount=0) so T = 0 has zero
			// stellar records of any kind; Milky Way landmarks + catalog are tested in
			// suite 5 ('catalog') below.
			if (runFirstLight) {
				if (onProgress) onProgress('First light (T = 0) & cluster formation');
				const sbRef = deps.galaxy.createGalaxy({ type: 'Sb', seed, age: deps.galaxy.AGE_REF });
				const renderer = deps.rendererLib.createStarRenderer(device, target.context, format, {
					proceduralStars,
					catalogBudgetStars: 0,
					model: sbRef,
				});
				renderer.prepare(null);
				const cam = setupGalaxyCamera(deps.cameraLib, sbRef);

				// Step from Present day (13.5 Gyr) down to First light (T = 0):
				const sbZero = deps.galaxy.modelAtAge(sbRef, 0);
				renderer.setEpoch(sbZero);
				renderer.stepEpoch(sbZero, 1e9);
				// Isolate the birth gate: First light is gas-only now, not black.
				renderer.setGasVisible(false);
				const sample0 = await renderEpochSample(renderer, target, cam, sbZero, 0, 0);
				thumbnails.push({ label: 'T = 0.0 Gyr (stars only; gas hidden)', sample: sample0 });

				check('firstlight', 'T = 0 census formed is 0% and gas is 1.00',
					sample0.cpu.formedFraction === 0 && sample0.cpu.gasFraction === 1,
					'formed=' + sample0.cpu.formedFraction + ' gas=' + sample0.cpu.gasFraction);
				check('firstlight', 'T = 0 gates off all field stars AND all star clusters / composite objects',
					sample0.cpu.fieldActive === 0 && sample0.cpu.clusterStarsActive === 0
					&& sample0.cpu.objectStarsActive === 0 && sample0.cpu.clusterStarsTotal > 0,
					'field=0/' + sample0.cpu.fieldTotal
					+ ' clusterStars=0/' + sample0.cpu.clusterStarsTotal
					+ ' gasStars=0/' + sample0.cpu.gasStarsTotal);
				check('firstlight', 'T = 0 star-only procedural Sb frame has 0 lit pixels (gas hidden; no orphan clusters)',
					sample0.px.litPixels === 0 && sample0.px.totalLuma === 0,
					'litPx=' + sample0.px.litPixels + ' luma=' + sample0.px.totalLuma.toFixed(2));

				renderer.setGasVisible(true);
				const gas0 = await renderEpochSample(renderer, target, cam, sbZero, 0, 0);
				thumbnails.push({ label: 'T = 0.0 Gyr (gas only)', sample: gas0 });
				check('firstlight', 'First light has a live gas grid beside the absent stellar census',
					renderer.gasGridInfo().enabled && renderer.gasGridInfo().cells > 0);
				if (gas0.hasGpuPixels) {
					check('firstlight', 'T = 0 gas-only frame contains centred disc light on GPU readback',
						gas0.px.litPixels > 0 && gas0.px.totalLuma > sample0.px.totalLuma
						&& gas0.px.coreLuma > gas0.px.outerLuma,
						'litPx=' + gas0.px.litPixels + ' luma=' + gas0.px.totalLuma.toFixed(2)
						+ ' core=' + gas0.px.coreLuma.toFixed(2) + ' outer=' + gas0.px.outerLuma.toFixed(2));
				} else {
					note('deferred', 'gas-only pixels need GPU readback; the CPU fallback does not rasterize gas');
				}
				// Keep the census-growth pixel comparison star-only too.
				renderer.setGasVisible(false);

				// Also verify booting directly at T = 0 (?age=0) still places the reference cluster census:
				const bootZeroRenderer = deps.rendererLib.createStarRenderer(device, target.context, format, {
					proceduralStars: 4000,
					catalogBudgetStars: 0,
					model: deps.galaxy.createGalaxy({ type: 'Sb', seed, age: 0 }),
				});
				const bootZeroState = bootZeroRenderer.prepare(null);
				const bootZeroSum0 = formationSummary(bootZeroRenderer, 0);
				const bootZeroSumRef = formationSummary(bootZeroRenderer, deps.galaxy.AGE_REF);
				check('firstlight', 'booting directly at T = 0 (?age=0) builds full reference cluster census, gated 0% -> 100%',
					bootZeroState.clusterCount === deps.clusters.clusterCountFor(sbRef)
					&& bootZeroSum0.clusterStarsActive === 0
					&& bootZeroSumRef.clusterStarsActive === bootZeroSumRef.clusterStarsTotal
					&& bootZeroSumRef.clusterStarsTotal > 0,
					'clusters=' + bootZeroState.clusterCount
					+ ' active@0=' + bootZeroSum0.clusterStarsActive
					+ ' active@13.5=' + bootZeroSumRef.clusterStarsActive);
				bootZeroRenderer.dispose();

				// Walk epochs 0.0 -> 0.5 -> 1.0 -> 2.0 -> 4.0 -> 13.5 Gyr and verify cluster & pixel growth:
				const walkAges = [0.0, 0.5, 1.0, 2.0, 4.0, 13.5];
				const walkSamples = [];
				for (let i = 0; i < walkAges.length; i++) {
					const a = walkAges[i];
					const mNow = deps.galaxy.modelAtAge(sbRef, a);
					mNow.populations.viewGasNow = renderer.censusGasAt(a);
					const mSolved = deps.galaxy.modelAtAge(mNow, a);
					renderer.setEpoch(mSolved);
					renderer.stepEpoch(mSolved, 1e9);
					const smp = await renderEpochSample(renderer, target, cam, mSolved, 0, 0);
					walkSamples.push(smp);
					note('firstlight', 'T=' + a.toFixed(1).padStart(4) + ' Gyr'
						+ ' \u00b7 formed ' + (smp.cpu.formedFraction * 100).toFixed(1).padStart(5) + '%'
						+ ' \u00b7 clusters ' + String(smp.cpu.clusterStarsActive).padStart(4) + '/' + smp.cpu.clusterStarsTotal
						+ ' \u00b7 field ' + String(smp.cpu.fieldActive).padStart(5) + '/' + smp.cpu.fieldTotal
						+ ' \u00b7 litPx ' + String(smp.px.litPixels).padStart(5)
						+ ' \u00b7 luma ' + smp.px.totalLuma.toFixed(0));
				}
				let clusterMono = true;
				for (let i = 1; i < walkSamples.length; i++) {
					if (walkSamples[i].cpu.clusterStarsActive < walkSamples[i - 1].cpu.clusterStarsActive) {
						clusterMono = false;
					}
				}
				const lastWalk = walkSamples[walkSamples.length - 1];
				check('firstlight', 'cluster & object members condense monotonically from 0 at T = 0 to 100% at 13.5 Gyr',
					clusterMono
					&& walkSamples[1].cpu.clusterStarsActive > 0
					&& lastWalk.cpu.clusterStarsActive === lastWalk.cpu.clusterStarsTotal
					&& lastWalk.px.litPixels > walkSamples[1].px.litPixels,
					walkSamples.map((s) => s.age + 'Gyr:' + s.cpu.clusterStarsActive).join(' -> '));
				renderer.dispose();
			}

			// 3. 3.4 - 3.5 - 3.6 Gyr Brightness & Star-Count Continuity + 2 Myr/s Clock Sweep
			if (runContinuity) {
				if (onProgress) onProgress('3.4–3.6 Gyr brightness & star-count continuity');
				const mwRef = deps.galaxy.createGalaxy({ type: 'SBb', seed, age: deps.galaxy.AGE_REF });
				const renderer = deps.rendererLib.createStarRenderer(device, target.context, format, {
					proceduralStars,
					catalogBudgetStars: 0,
					model: mwRef,
				});
				renderer.prepare(null);
				renderer.setGasVisible(false); // This suite measures stellar exposure, not reservoir depletion.
				const cam = setupGalaxyCamera(deps.cameraLib, mwRef);

				const bandAges = [3.0, 3.2, 3.3, 3.4, 3.45, 3.5, 3.55, 3.6, 3.7, 3.8, 4.0];
				const bandSamples = [];
				for (let i = 0; i < bandAges.length; i++) {
					const a = bandAges[i];
					if (onProgress) onProgress('continuity sweep ' + a.toFixed(2) + ' Gyr');
					const mNow = deps.galaxy.modelAtAge(mwRef, a);
					mNow.populations.viewGasNow = renderer.censusGasAt(a);
					const mSolved = deps.galaxy.modelAtAge(mNow, a);
					renderer.setEpoch(mSolved);
					renderer.stepEpoch(mSolved, 1e9);
					const smp = await renderEpochSample(renderer, target, cam, mSolved, 0, 0);
					bandSamples.push(smp);
					if (a === 3.4 || a === 3.5 || a === 3.6) {
						thumbnails.push({ label: 'T = ' + a.toFixed(1) + ' Gyr', sample: smp });
					}
					note('continuity', 'T=' + a.toFixed(2) + ' Gyr'
						+ ' \u00b7 magOff ' + smp.magOffset.toFixed(4)
						+ ' \u00b7 formed ' + (smp.cpu.formedFraction * 100).toFixed(2) + '%'
						+ ' \u00b7 litPx ' + String(smp.px.litPixels).padStart(5)
						+ ' \u00b7 luma ' + smp.px.totalLuma.toFixed(1));
				}

				let magNoOscillation = true;
				let worstMagStepPer01Gyr = 0;
				for (let i = 1; i < bandSamples.length; i++) {
					const dMag = bandSamples[i].magOffset - bandSamples[i - 1].magOffset;
					const dAge = Math.max(0.05, bandSamples[i].age - bandSamples[i - 1].age);
					if (dMag < -0.005) magNoOscillation = false;
					worstMagStepPer01Gyr = Math.max(worstMagStepPer01Gyr, Math.abs(dMag) * (0.1 / dAge));
				}
				const s34 = bandSamples.find((s) => Math.abs(s.age - 3.4) < 1e-6);
				const s35 = bandSamples.find((s) => Math.abs(s.age - 3.5) < 1e-6);
				const s36 = bandSamples.find((s) => Math.abs(s.age - 3.6) < 1e-6);
				// A dip is a downward step in luma or lit-pixel count: monotone growth from
				// ongoing star formation (ΔN ∝ N across 3.4 -> 3.6 Gyr) is expected and is
				// not a dip, whereas any downward step in the thresholded lit-pixel count
				// must stay within shot noise (σ ≈ √N).
				const counts = [s34.px.litPixels, s35.px.litPixels, s36.px.litPixels];
				const peakCount = Math.max.apply(null, counts);
				const maxDrop = Math.max(0, counts[0] - counts[1], counts[1] - counts[2]);
				const shotNoise = 3 * Math.sqrt(peakCount) + 2;
				const noDip35 = s34 && s35 && s36
					&& s35.px.totalLuma >= s34.px.totalLuma * 0.95
					&& s36.px.totalLuma >= s35.px.totalLuma * 0.95
					&& maxDrop <= shotNoise
					&& Math.min.apply(null, counts) > 0;

				check('continuity', 'magOffset is smooth and non-oscillating across 3.0–4.0 Gyr (worst step < 0.025 mag / 0.1 Gyr)',
					magNoOscillation && worstMagStepPer01Gyr < 0.025,
					'3.4=' + s34.magOffset.toFixed(4)
					+ ' 3.5=' + s35.magOffset.toFixed(4)
					+ ' 3.6=' + s36.magOffset.toFixed(4)
					+ ' maxStepPer0.1Gyr=' + worstMagStepPer01Gyr.toFixed(5));
				check('continuity', 'no 3.5 Gyr exposure dip between 3.4, 3.5 and 3.6 Gyr (luma within 5 %, lit count within its shot noise)',
					noDip35,
					'litPx 3.4=' + s34.px.litPixels + ' -> 3.5=' + s35.px.litPixels + ' -> 3.6=' + s36.px.litPixels
					+ ' | luma 3.4=' + s34.px.totalLuma.toFixed(0) + ' -> 3.5=' + s35.px.totalLuma.toFixed(0) + ' -> 3.6=' + s36.px.totalLuma.toFixed(0));

				// Fine 2 Myr/s (0.002 Gyr) live-clock sweep across 3.44..3.60 Gyr:
				let maxFineStep = 0;
				let prevMag = null;
				for (let age = 3.44; age <= 3.60 + 1e-9; age = Math.round((age + 0.002) * 1000) / 1000) {
					const mStep = deps.galaxy.modelAtAge(mwRef, age);
					renderer.setEpoch(mStep);
					if (prevMag !== null) {
						maxFineStep = Math.max(maxFineStep, Math.abs(renderer.state.magOffset - prevMag));
					}
					prevMag = renderer.state.magOffset;
				}
				check('continuity', '2 Myr/s live-clock step across 3.44–3.60 Gyr has sub-millimag steps (< 0.001 mag)',
					maxFineStep < 0.001,
					'maxStepPer2Myr=' + maxFineStep.toFixed(6) + ' mag');
				renderer.dispose();
			}

			// 4. V14 Formation Morphology & Zero-Redraw Contract
			if (runMorphology) {
				if (onProgress) onProgress('V14 formation scenarios & morphology');
				const refModel = deps.galaxy.createGalaxy({ type: 'SBb', seed, age: deps.galaxy.AGE_REF });
				const renderer = deps.rendererLib.createStarRenderer(device, target.context, format, {
					proceduralStars,
					catalogBudgetStars: 0,
					model: refModel,
				});
				renderer.prepare(null);
				const cam = setupGalaxyCamera(deps.cameraLib, refModel);
				const drawsStart = renderer.state.fieldSamples;

				const v14Epochs = [
					{ id: 'condense', age: 0.5, label: 'T = 0.5 Gyr (Condensation)' },
					{ id: 'youngarms', age: 1.0, label: 'T = 1.0 Gyr (Gas-rich arms)' },
					{ id: 'bulge', age: 2.0, label: 'T = 2.0 Gyr (Bulge assembly)' },
					{ id: 'today', age: deps.galaxy.AGE_REF, label: 'T = 13.5 Gyr (Present day)' },
				];
				const v14Map = {};
				for (let i = 0; i < v14Epochs.length; i++) {
					const row = v14Epochs[i];
					const mTmp = deps.galaxy.modelAtAge(refModel, row.age);
					mTmp.populations.viewGasNow = renderer.censusGasAt(row.age);
					const mNow = deps.galaxy.modelAtAge(mTmp, row.age);
					renderer.setEpoch(mNow);
					renderer.stepEpoch(mNow, 1e9);
					const smp = await renderEpochSample(renderer, target, cam, mNow, 0, 0);
					smp.armContrast = mNow.epoch.armContrast;
					smp.bulgeScale = mNow.epoch.spheroidSize;
					v14Map[row.id] = smp;
					thumbnails.push({ label: row.label, sample: smp });
					note('morphology', row.label
						+ ' \u00b7 formed ' + (smp.cpu.formedFraction * 100).toFixed(1) + '%'
						+ ' \u00b7 gas ' + smp.cpu.gasFraction.toFixed(2)
						+ ' \u00b7 arms \u00d7' + smp.armContrast.toFixed(2)
						+ ' \u00d7bulge ' + smp.bulgeScale.toFixed(2)
						+ ' \u00b7 litPx ' + smp.px.litPixels);
				}
				const drawsUsed = renderer.state.fieldSamples - drawsStart;
				check('morphology', 'walking all V14 formation epochs triggers 0 field redraws',
					drawsUsed === 0, 'draws=' + drawsUsed);
				check('morphology', '1.0 Gyr gas-rich arms have higher arm contrast than Present day (1.00)',
					v14Map.youngarms.armContrast > 1.2 && Math.abs(v14Map.today.armContrast - 1.0) < 1e-6,
					'arms@1Gyr=' + v14Map.youngarms.armContrast.toFixed(2) + ' arms@13.5Gyr=' + v14Map.today.armContrast.toFixed(2));
				check('morphology', '2.0 Gyr bulge is more compact than Present day and grows to scale 1.00',
					v14Map.bulge.bulgeScale > 0.3 && v14Map.bulge.bulgeScale < 0.75
					&& Math.abs(v14Map.today.bulgeScale - 1.0) < 1e-6,
					'bulge@2Gyr=' + v14Map.bulge.bulgeScale.toFixed(2) + ' bulge@13.5Gyr=' + v14Map.today.bulgeScale.toFixed(2));
				check('morphology', 'Present day galaxy overview is centred in the frustum (core brighter than outer frame)',
					v14Map.today.px.litPixels > 0 && v14Map.today.px.coreLuma > v14Map.today.px.outerLuma,
					'litPx=' + v14Map.today.px.litPixels
					+ ' core=' + v14Map.today.px.coreLuma.toFixed(2)
					+ ' outer=' + v14Map.today.px.outerLuma.toFixed(2));
				renderer.dispose();
			}

			// 5. Milky Way catalog/local evolution (nonzero streaming budget)
			if (runCatalog) {
				if (onProgress) onProgress('Milky Way catalog & local evolution');
				if (!catalogManifest) {
					check('catalog', 'the Milky Way catalog bundle loads for the nonzero-budget suite', false,
						catalogLoadError ? String(catalogLoadError.message || catalogLoadError) : 'missing manifest');
				} else {
					const refModel = deps.galaxy.createGalaxy({ type: 'SBb', seed, age: deps.galaxy.AGE_REF });
					const renderer = deps.rendererLib.createStarRenderer(device, target.context, format, {
						proceduralStars: Math.min(proceduralStars, 4000),
						catalogBudgetStars: Math.max(1, cfg.catalogBudgetStars || 250000),
						objectMembers: 0,
						objectCount: 0,
						gasGrid: false,
						model: refModel,
					});
					renderer.prepare(catalogManifest);
					const cam = deps.cameraLib.createCamera();
					cam.setFrame(refModel);
					// The bundled catalog is Sun-centred; do not use the galaxy
					// overview camera, which is intentionally outside its cells.
					cam.setState({
						position: [0, 0, 0],
						yaw: 0,
						pitch: 0,
						mode: deps.cameraLib.MODE_FLY,
					});
					const refSample = await renderEpochSample(renderer, target, cam, refModel, 0, 0);
					thumbnails.push({ label: 'Catalog reference epoch', sample: refSample });
					const info = renderer.starBlocks();
					const rows = new Map();
					for (const kind of [3, 4]) {
						const block = info.blocks[kind];
						for (let i = 0; i < block.count; i++) {
							const slot = block.offset + i;
							const off = slot * deps.records.RECORD_BYTES;
							const rec = deps.records.readRecord(info.view, off);
							rows.set(info.identity[slot] >>> 0, {
								kind, x: rec.x, y: rec.y, z: rec.z, packed: rec.packed,
								birth: info.formation.births[slot],
							});
						}
					}
					check('catalog', 'nonzero catalog and local blocks are resident with finite births',
						info.blocks[3].count > 0 && info.blocks[4].count > 0 && rows.size > 0
						&& Array.from(rows.values()).every((r) => Number.isFinite(r.birth)),
						{ local: info.blocks[3].count, catalog: info.blocks[4].count, rows: rows.size });

					const samplesBefore = renderer.state.fieldSamples;
					const zeroModel = deps.galaxy.modelAtAge(refModel, 0);
					renderer.setEpoch(zeroModel);
					renderer.stepEpoch(zeroModel, 1e9);
					const zeroSample = await renderEpochSample(renderer, target, cam, zeroModel, 0, 0);
					thumbnails.push({ label: 'Catalog First light', sample: zeroSample });
					check('catalog', 'T = 0 gates local/catalog stars off while curated landmarks remain',
						zeroSample.cpu.localActive === 0 && zeroSample.cpu.catalogActive === 0
						&& zeroSample.cpu.localTotal > 0 && zeroSample.cpu.catalogTotal > 0
						&& zeroSample.cpu.landmarkActive === zeroSample.cpu.landmarkTotal,
						{ local: zeroSample.cpu.localActive + '/' + zeroSample.cpu.localTotal,
							catalog: zeroSample.cpu.catalogActive + '/' + zeroSample.cpu.catalogTotal,
							landmarks: zeroSample.cpu.landmarkActive + '/' + zeroSample.cpu.landmarkTotal });

					// The C9 ladder (deferred-catalog-evolution-plan §8): walk
					// 0.5 → 1 → 2 Gyr with a thumbnail at every rung, and pin
					// the active counts monotone — gateAt is a smoothstep in
					// the epoch age over fixed births, so a count that ever
					// falls is a gating regression, not astrophysics.
					const ladder = [{ age: 0, local: zeroSample.cpu.localActive, catalog: zeroSample.cpu.catalogActive }];
					let youngSample = null;
					for (const age of [0.5, 1.0, 2.0]) {
						const ageModel = deps.galaxy.modelAtAge(refModel, age);
						renderer.setEpoch(ageModel);
						renderer.stepEpoch(ageModel, 1e9);
						const smp = await renderEpochSample(renderer, target, cam, ageModel, 0, 0);
						thumbnails.push({ label: 'Catalog T = ' + age.toFixed(1) + ' Gyr', sample: smp });
						ladder.push({ age, local: smp.cpu.localActive, catalog: smp.cpu.catalogActive });
						youngSample = smp;
					}
					let monotone = true;
					for (let i = 1; i < ladder.length; i++) {
						if (ladder[i].local < ladder[i - 1].local || ladder[i].catalog < ladder[i - 1].catalog) monotone = false;
					}
					// The bundled catalog's births start at ~3.4 Gyr, so its
					// active count is legitimately still 0 at the ladder's top
					// rung — the reference-epoch checks below pin its far end.
					// The local sky must have started forming by 2 Gyr, or the
					// ladder measured nothing at all.
					check('catalog', 'active streaming counts rise monotonically along the 0 → 2 Gyr ladder',
						monotone && ladder[ladder.length - 1].local > 0,
						{ ladder });
					let changed = 0;
					let moved = 0;
					for (const kind of [3, 4]) {
						const block = info.blocks[kind];
						for (let i = 0; i < block.count; i++) {
							const slot = block.offset + i;
							const before = rows.get(info.identity[slot] >>> 0);
							if (!before) continue;
							const rec = deps.records.readRecord(info.view, slot * deps.records.RECORD_BYTES);
							if (rec.packed !== before.packed) changed++;
							if (rec.x !== before.x || rec.y !== before.y || rec.z !== before.z) moved++;
						}
					}
					check('catalog', 'early epochs change streaming looks without changing positions or field draws',
						changed > 0 && moved === 0 && renderer.state.fieldSamples === samplesBefore,
						{ changed, moved, fieldDraws: renderer.state.fieldSamples - samplesBefore });

					renderer.setEpoch(refModel);
					renderer.stepEpoch(refModel, 1e9);
					const backSample = await renderEpochSample(renderer, target, cam, refModel, 0, 0);
					thumbnails.push({ label: 'Catalog reference restored', sample: backSample });
					let restored = 0;
					let gates = 0;
					let positions = 0;
					for (const kind of [3, 4]) {
						const block = info.blocks[kind];
						for (let i = 0; i < block.count; i++) {
							const slot = block.offset + i;
							const before = rows.get(info.identity[slot] >>> 0);
							if (!before) continue;
							const rec = deps.records.readRecord(info.view, slot * deps.records.RECORD_BYTES);
							if (rec.packed === before.packed) restored++;
							if (rec.x === before.x && rec.y === before.y && rec.z === before.z) positions++;
							if (deps.orbit.gateAt(info.formation.births[slot], deps.galaxy.AGE_REF) === 1) gates++;
						}
					}
					check('catalog', 'AGE_REF restores every packed streaming look, position and gate exactly',
						restored === rows.size && positions === rows.size && gates === rows.size,
						{ restored, positions, gates, total: rows.size });
					if (refSample.hasGpuPixels && backSample.hasGpuPixels) {
						check('catalog', 'reference GPU frame round trip has zero differing pixels',
							diffPixels(refSample.rgba, backSample.rgba) === 0,
							'diffPx=' + diffPixels(refSample.rgba, backSample.rgba));
					} else {
						note('deferred', 'catalog pixel parity requires real WebGPU readback; CPU evidence above covers packed records and gates');
					}
					renderer.dispose();
				}
			}

			// 6. Orbit Engines & Two-Run Bit Determinism
			if (runEngines) {
				if (onProgress) onProgress('orbit engines & GPU readback determinism');
				const refModel = deps.galaxy.createGalaxy({ type: 'SBb', seed, age: deps.galaxy.AGE_REF });
				const renderer = deps.rendererLib.createStarRenderer(device, target.context, format, {
					proceduralStars: Math.min(proceduralStars, 12000),
					catalogBudgetStars: 0,
					model: refModel,
				});
				renderer.prepare(null);
				const cam = setupGalaxyCamera(deps.cameraLib, refModel);

				renderer.setEngine('classic');
				const classicA = await renderEpochSample(renderer, target, cam, refModel, 25, 1);
				const classicB = await renderEpochSample(renderer, target, cam, refModel, 25, 0);
				const detDiff = (classicA.rgba && classicB.rgba) ? diffPixels(classicA.rgba, classicB.rgba) : 0;
				check('engines', 'two renders of the same state are bit-identical (0 differing pixels)',
					detDiff === 0 && classicA.px.litPixels > 0 && classicA.px.badValues === 0,
					'diffPx=' + detDiff + ' litPx=' + classicA.px.litPixels);

				renderer.setEngine('simple');
				const simpleSample = await renderEpochSample(renderer, target, cam, refModel, 26, 1);
				renderer.setEngine(['simple', 'apocenter']);
				const comboSample = await renderEpochSample(renderer, target, cam, refModel, 27, 1);
				renderer.setEngine('classic');
				check('engines', 'simple compute and simple+apocenter engines render finite lit galaxies',
					simpleSample.px.litPixels > 0 && comboSample.px.litPixels > 0
					&& simpleSample.px.badValues === 0 && comboSample.px.badValues === 0,
					'simpleLitPx=' + simpleSample.px.litPixels + ' comboLitPx=' + comboSample.px.litPixels);
				renderer.dispose();
			}
		} finally {
			target.dispose();
		}

		let passed = 0;
		let failed = 0;
		for (let i = 0; i < checks.length; i++) {
			if (checks[i].pass) passed++;
			else failed++;
		}
		const wallMs = Date.now() - t0;
		note('result', (failed === 0 ? 'PASS' : 'FAIL (' + failed + ' failed)')
			+ ' \u00b7 ' + passed + '/' + checks.length + ' checks \u00b7 wall ' + wallMs + ' ms');

		return {
			ok: failed === 0,
			passed,
			failed,
			total: checks.length,
			wallMs,
			checks,
			lines: log,
			text: log.join('\n'),
			thumbnails,
		};
	}

	const GpuSmoke = {
		ACK_MS,
		BROWSERS,
		SUITES,
		stamp,
		fileStamp,
		browser,
		platform,
		gpu,
		envLine,
		captureLine,
		legacyCopy,
		writeText,
		labelAck,
		bindCopy,
		saveLog,
		sendLog,
		canSendLog,
		analyzePixels,
		diffPixels,
		createOffscreenTarget,
		createFallbackDevice,
		formationSummary,
		setupGalaxyCamera,
		renderEpochSample,
		runSuite,
	};
	if (typeof module !== 'undefined' && module.exports) module.exports = GpuSmoke;
	if (typeof window !== 'undefined') window.GpuSmoke = GpuSmoke;
})();
