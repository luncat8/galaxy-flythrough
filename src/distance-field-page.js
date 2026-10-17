// src/distance-field-page.js
// Boot / glue for the standalone distance-field test page
// (distance-field-plan.md, §6).
//
// This page is the harness for the GPU distance field: it drives the same
// render/distance-field-renderer.js the main renderer uses, over the same
// law (math/distance-field.js), and it is the place where the radio buttons
// and sliders live:
//
//   * render type   - off / distance from eye / depth spread / gradient
//   * stars         - nearest N / selected / constellations / the whole sky
//   * count, sigma  - how many nearest stars, how wide their hills are
//   * projection    - the app's gnomonic window, or the equirect sky chart
//
// The anchors are the page's own business; the renderer only ever sees a list
// of positions. That is the point of the exercise: the same field code
// answers to the catalog, the procedural sky, the named stars and whatever
// the user picked, with nothing switched inside the renderer.
//
// The display range is the CPU law's business even here: the page runs the
// reference implementation over a coarse grid a few times a second to get the
// range's percentiles, and hands the numbers to the GPU. No readback, and no
// range that follows every frame.

'use strict';

(function () {
	const $ = (id) => document.getElementById(id);
	const canvas = $('field');
	const readout = $('readout');
	const errEl = $('error');

	const Field = window.DistanceField;
	const Ramps = window.DistanceRamps;
	const Renderer = window.DistanceFieldRenderer;
	const Device = window.Device;
	const GalaxyLib = window.GalaxyLib;
	const OrbitLib = window.OrbitLib;

	const FOV_Y_DEG = 60;              // the app's vertical FoV
	const RANGE_PERIOD = 0.25;         // seconds between the CPU range reads
	const RANGE_W = 80;                // the reference grid the range reads
	const RANGE_H = 45;
	const CHART_SPAN_DEG = 360;
	const PICK_COS = 0.990;            // a pick within ~8° of the cursor
	// The star sources, in the order the radio buttons and the source slider
	// step through them.
	const SOURCES = ['nearest', 'selected', 'constellations', 'sky'];
	const SOURCE_LABELS = ['nearest N', 'selected', 'constellations', 'the whole sky'];
	const SUN_X = 0;                   // the Sun is the origin of the frame
	const GC_X = 8.178;                // the galactic centre, kpc

	const state = {
		mode: 'height',
		source: 'nearest',
		projection: 'view',
		count: 120,
		sigmaDeg: Field.SIGMA_DEG,
		gridW: 320,
		eyeDist: Math.pow(10, -2.3),   // kpc from the Sun, away from the centre
		// The eye looks at the galactic centre: forward is +x, the camera's
		// right is -y and up is +z (the app's own basis convention).
		eye: new Float64Array(3),
		basis: { fx: 1, fy: 0, fz: 0, rx: 0, ry: -1, rz: 0, ux: 0, uy: 0, uz: 1 },
		chartQuat: new Float64Array([0, 0, 0, 1]),
		// The anchors, in their two forms: the set (records) and the drawn
		// positions the renderer uploads.
		set: null,
		cur: new Float64Array(Field.MAX_STARS * 3),
		picked: [],                     // the user's picks, xyz triples
		pickedCount: 0,
		// The display range, owned by the CPU.
		range: { lo: -3, hi: 0 },
		rangeMode: '',
		// Bookkeeping for the readout.
		anchorCount: 0,
		gridW: 0,
		gridH: 0,
		fps: 0,
		lastFrameMs: 0,
		frameCount: 0,
		ready: false,
	};

	// ---- the CPU reference, used for the range ---------------------------

	// Two reference grids: the view window and the whole-sky chart. The range
	// is read over the same sky the page is showing - the percentiles of a
	// 60° window are not the percentiles of the whole sphere.
	const rangeLayout = Field.createLayout({}, { kind: 'view', w: RANGE_W, h: RANGE_H, fovY: FOV_Y_DEG * Math.PI / 180, basis: state.basis, aspect: RANGE_W / RANGE_H });
	const rangeLayoutChart = Field.createLayout({}, { kind: 'plane', w: RANGE_W, h: RANGE_W / 2, spanDeg: CHART_SPAN_DEG, quat: state.chartQuat, mirror: true });
	let rangeRaw = new Float32Array(RANGE_W * RANGE_H);
	const rangeStats = {};
	const rangeOut = { lo: 0, hi: 1, span: 1 };
	const rangeStars = { n: 0 };

	// ---- the layout the GPU draws ---------------------------------------

	const layout = Field.createLayout({}, {
		kind: 'view', w: 320, h: 180, fovY: FOV_Y_DEG * Math.PI / 180,
		basis: state.basis, aspect: 16 / 9,
	});

	// ---- the star sets ---------------------------------------------------

	const sets = {
		catalogIndex: null,
		sampleIndex: null,
		constSet: null,
		pickSet: Field.createSet(Field.MAX_STARS),
	};

	// The anchors for the current source. Every provider ends in the same
	// place: a set of records in `state.set`, whose drawn positions are
	// integrated into `state.cur`.
	function buildAnchors() {
		const eye = state.eye;
		const src = state.source;
		if (src === 'constellations') {
			if (!sets.constSet) sets.constSet = Field.buildConstellationSet({});
			state.set = sets.constSet;
			return;
		}
		if (src === 'selected') {
			const set = sets.pickSet;
			// `picked` is a flat array of xyz triples; pickedCount is how many
			// stars that is.
			set.n = Math.min(state.pickedCount, set.capacity);
			for (let i = 0; i < set.n; i++) {
				set.positions[i * 3] = state.picked[i * 3];
				set.positions[i * 3 + 1] = state.picked[i * 3 + 1];
				set.positions[i * 3 + 2] = state.picked[i * 3 + 2];
				set.packed[i] = 0;
				set.colorIndex[i] = 4;
			}
			set.source = 'selected';
			state.set = set;
			return;
		}
		const index = (src === 'nearest' ? nearestIndex() : skyIndex());
		if (!index) { state.set = null; return; }
		if (src === 'nearest') {
			Field.queryNearest(index, index.positions, eye[0], eye[1], eye[2], state.count, sets.pickSet);
			state.set = sets.pickSet;
			return;
		}
		// The whole sky: the anchor cap decides how many, and the thinning
		// is a stride, so the sample is spread over the sky rather than
		// taken from one corner of it.
		const set = sets.pickSet;
		const want = Math.min(Field.MAX_STARS, index.n);
		const stride = Math.max(1, Math.floor(index.n / want));
		set.n = 0;
		for (let i = 0; i < index.n && set.n < want; i += stride) {
			const k = set.n++;
			set.positions[k * 3] = index.positions[i * 3];
			set.positions[k * 3 + 1] = index.positions[i * 3 + 1];
			set.positions[k * 3 + 2] = index.positions[i * 3 + 2];
			set.packed[k] = index.packed ? index.packed[i] : 0;
			set.colorIndex[k] = index.colorIndex ? index.colorIndex[i] : 4;
		}
		set.source = index.source;
		state.set = set;
	}

	function nearestIndex() {
		return sets.catalogIndex || sets.sampleIndex;
	}
	function skyIndex() {
		return sets.sampleIndex || sets.catalogIndex;
	}

	// ---- the range -------------------------------------------------------

	// The range is read from the CPU law over a coarse grid, a few times a
	// second: the GPU never measures, it is told.
	function refreshRange() {
		const set = state.set;
		if (!set || !set.n) return;
		const stars = Field.prepareStars(state.cur, set.n, state.eye[0], state.eye[1], state.eye[2]);
		rangeStars.n = stars.n;
		const grid = state.projection === 'plane' ? rangeLayoutChart : rangeLayout;
		const count = grid.w * grid.h;
		if (rangeRaw.length < count) rangeRaw = new Float32Array(count);
		Field.computeRaw(stars, grid,
			{ mode: state.mode === 'off' ? 'height' : state.mode, sigmaDeg: state.sigmaDeg, measure: true },
			rangeRaw, rangeStats);
		if (rangeStats.empty) return;
		Field.autoRange(state.mode === 'off' ? 'height' : state.mode, rangeStats, rangeOut);
		state.range.lo = rangeOut.lo;
		state.range.hi = rangeOut.hi;
		state.rangeMode = state.mode;
	}

	// ---- the frame -------------------------------------------------------

	let device = null;
	let context = null;
	let format = 'bgra8unorm';
	let renderer = null;
	let model = null;
	let rangeClock = 0;

	function updateEye() {
		state.eye[0] = SUN_X - state.eyeDist;
		state.eye[1] = 0;
		state.eye[2] = 0.005;             // 5 pc above the galactic plane
	}

	function gridFor(aspect) {
		if (state.projection === 'plane') {
			// 360° of longitude is 2:1, and the chart keeps its own aspect.
			return { w: Math.max(64, state.gridW * 2), h: Math.max(32, state.gridW) };
		}
		const h = Math.max(16, Math.round(state.gridW / Math.max(0.25, aspect) / 8) * 8);
		return { w: Math.max(16, h), h };
	}

	function frame(nowMs) {
		requestAnimationFrame(frame);
		const dt = state.lastFrameMs ? Math.min(0.1, (nowMs - state.lastFrameMs) / 1000) : 0;
		state.lastFrameMs = nowMs;
		state.frameCount++;
		if (dt > 0) state.fps = state.fps ? state.fps * 0.9 + (1 / dt) * 0.1 : 1 / dt;

		if (!renderer) return;

		const dpr = Math.min(2, window.devicePixelRatio || 1);
		const iw = Math.max(64, Math.floor(canvas.clientWidth * dpr));
		const ih = Math.max(64, Math.floor(canvas.clientHeight * dpr));
		if (canvas.width !== iw || canvas.height !== ih) { canvas.width = iw; canvas.height = ih; }
		const aspect = iw / Math.max(1, ih);

		// The anchors: the same set, integrated to the drawn positions.
		buildAnchors();
		const set = state.set;
		if (set && set.n) {
			Field.advancePositions(set, state.cur, 0, model);
			state.anchorCount = set.n;
		} else {
			state.anchorCount = 0;
		}

		// The layout: the grid the GPU works on, in the projection the page
		// is showing.
		const grid = gridFor(aspect);
		state.gridW = grid.w;
		state.gridH = grid.h;
		if (state.projection === 'plane') {
			Field.createLayout(layout, {
				kind: 'plane', w: grid.w, h: grid.h, spanDeg: CHART_SPAN_DEG,
				quat: state.chartQuat, mirror: true,
			});
		} else {
			Field.createLayout(layout, {
				kind: 'view', w: grid.w, h: grid.h, fovY: FOV_Y_DEG * Math.PI / 180,
				basis: state.basis, aspect,
			});
		}

		// The range: the CPU's, refreshed a few times a second.
		rangeClock += dt;
		if (rangeClock >= RANGE_PERIOD || state.rangeMode !== state.mode) {
			rangeClock = 0;
			refreshRange();
		}

		renderer.setLayout(layout);
		renderer.setEye(state.eye[0], state.eye[1], state.eye[2]);
		renderer.setMode(state.mode);
		renderer.setSigma(state.sigmaDeg);
		renderer.setRange(state.range.lo, state.range.hi);
		renderer.setCanvas(iw, ih);
		renderer.setAnchors(state.cur, state.anchorCount);

		const encoder = device.createCommandEncoder();
		renderer.update(encoder);
		const view = context.getCurrentTexture().createView();
		if (state.mode === 'off') {
			const pass = encoder.beginRenderPass({
				label: 'field-off',
				colorAttachments: [{
					view, loadOp: 'clear', storeOp: 'store',
					clearValue: { r: 0.02, g: 0.027, b: 0.05, a: 1 },
				}],
			});
			pass.end();
		} else {
			renderer.draw(encoder, view, format);
		}
		device.queue.submit([encoder.finish()]);

		drawReadout();
	}

	function drawReadout(extra) {
		const lines = [];
		lines.push(`distance field · ${state.mode} · ${state.source} · ${state.projection}`);
		lines.push(`anchors ${state.anchorCount}   grid ${state.gridW}×${state.gridH}`);
		lines.push(`range ${state.range.lo.toFixed(2)} … ${state.range.hi.toFixed(2)}   σ ${state.sigmaDeg}°`);
		lines.push(`eye ${state.eyeDist < 0.01 ? (state.eyeDist * 1000).toFixed(1) + ' pc' : state.eyeDist.toFixed(2) + ' kpc'} from the Sun`);
		lines.push(`picked ${state.pickedCount}   ${state.fps.toFixed(0)} fps`);
		if (extra) lines.push(extra);
		readout.textContent = lines.join('\n');
	}

	// ---- picking ---------------------------------------------------------

	// A click picks the star nearest the cursor's ray into the page's own
	// selection, so the "selected" source has something to select.
	//
	// The search is over the whole sky (the catalog and the procedural
	// sample), not over the current anchors: the anchors are the nearest few
	// stars, which sit in one small patch of sky, and a click anywhere else
	// would find nothing.
	function pickAt(clientX, clientY) {
		const rect = canvas.getBoundingClientRect();
		const cx = (clientX - rect.left) / Math.max(1, rect.width);
		const cy = (clientY - rect.top) / Math.max(1, rect.height);
		let gx = cx * layout.w;
		let gy = cy * layout.h;
		if (state.projection === 'plane') {
			// The chart is letterboxed into the canvas: undo that before
			// asking the layout which texel the cursor is on.
			const ga = layout.w / layout.h;
			const ca = rect.width / Math.max(1, rect.height);
			let rw = rect.width, rh = rect.height, ox = 0, oy = 0;
			if (ga > ca) { rw = rect.width; rh = rect.width / ga; } else { rh = rect.height; rw = rect.height * ga; }
			ox = (rect.width - rw) * 0.5; oy = (rect.height - rh) * 0.5;
			gx = (cx * rect.width - ox) / rw * layout.w;
			gy = (cy * rect.height - oy) / rh * layout.h;
		}
		const dir = new Float64Array(3);
		Field.dirAt(layout, gx - 0.5, gy - 0.5, dir);
		const eye = state.eye;
		let best = null;
		let bestCos = PICK_COS;
		for (const index of [sets.sampleIndex, sets.catalogIndex]) {
			if (!index) continue;
			for (let i = 0; i < index.n; i++) {
				const px = index.positions[i * 3];
				const py = index.positions[i * 3 + 1];
				const pz = index.positions[i * 3 + 2];
				const dx = px - eye[0];
				const dy = py - eye[1];
				const dz = pz - eye[2];
				const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
				if (!(len > 1e-9)) continue;
				const c = (dir[0] * dx + dir[1] * dy + dir[2] * dz) / len;
				if (c > bestCos) { bestCos = c; best = [px, py, pz]; }
			}
		}
		return best;
	}

	function addPick(p) {
		if (!p) return false;
		if (state.picked.length / 3 >= 256) return false;
		state.picked.push(p[0], p[1], p[2]);
		state.pickedCount = state.picked.length / 3;
		$('val-selection').textContent = `${state.pickedCount} picked`;
		return true;
	}

	// ---- the UI ----------------------------------------------------------

	// The source slider's readout, and the radio buttons' state, follow the
	// live source: the two controls are one choice.
	function syncSourceSlider() {
		const i = Math.max(0, SOURCES.indexOf(state.source));
		const slider = $('slider-source');
		if (slider && slider.value !== String(i)) slider.value = String(i);
		const val = $('val-source');
		if (val) val.textContent = SOURCE_LABELS[i];
	}

	function radioValue(name, fallback) {
		const el = document.querySelector(`input[name="${name}"]:checked`);
		return el ? el.value : fallback;
	}

	function bindUI() {
		for (const el of document.querySelectorAll('input[name="field-mode"]')) {
			el.addEventListener('change', () => {
				state.mode = radioValue('field-mode', 'height');
				drawReadout();
			});
		}
		for (const el of document.querySelectorAll('input[name="field-source"]')) {
			el.addEventListener('change', () => {
				state.source = radioValue('field-source', 'nearest');
				syncSourceSlider();
				drawReadout();
			});
		}
		for (const el of document.querySelectorAll('input[name="field-projection"]')) {
			el.addEventListener('change', () => {
				state.projection = radioValue('field-projection', 'view');
				drawReadout();
			});
		}
		// The source slider: the same choice the radio buttons make, stepped
		// by number. It moves the radio with it, so the two controls can
		// never disagree about which source is live.
		const sourceSlider = $('slider-source');
		sourceSlider.addEventListener('input', () => {
			const src = SOURCES[parseInt(sourceSlider.value, 10) || 0] || SOURCES[0];
			state.source = src;
			for (const el of document.querySelectorAll('input[name="field-source"]')) {
				el.checked = el.value === src;
			}
			syncSourceSlider();
			drawReadout();
		});
		const count = $('slider-count');
		count.addEventListener('input', () => {
			state.count = parseInt(count.value, 10) || 1;
			$('val-count').textContent = String(state.count);
		});
		const sigma = $('slider-sigma');
		sigma.addEventListener('input', () => {
			state.sigmaDeg = parseFloat(sigma.value) || Field.SIGMA_DEG;
			$('val-sigma').textContent = `${state.sigmaDeg}°`;
		});
		const res = $('slider-res');
		res.addEventListener('input', () => {
			state.gridW = parseInt(res.value, 10) || 320;
			$('val-res').textContent = String(state.gridW);
		});
		const zoom = $('slider-zoom');
		zoom.addEventListener('input', () => {
			state.eyeDist = Math.pow(10, parseFloat(zoom.value) || 0);
			updateEye();
			$('val-zoom').textContent = state.eyeDist < 0.01
				? `${(state.eyeDist * 1000).toFixed(1)} pc`
				: `${state.eyeDist.toFixed(2)} kpc`;
		});
		$('btn-clear-selection').addEventListener('click', () => {
			state.picked.length = 0;
			state.pickedCount = 0;
			$('val-selection').textContent = '0 picked';
		});
		canvas.addEventListener('click', (ev) => {
			const p = pickAt(ev.clientX, ev.clientY);
			if (!addPick(p)) drawReadout('nothing under the cursor');
		});
	}

	// ---- boot ------------------------------------------------------------

	function showError(msg) {
		errEl.style.display = 'block';
		errEl.textContent = msg;
		console.error(msg);
	}

	async function boot() {
		// data/tiles/catalog.js is a plain data script: it sets
		// window.__galaxy_catalog and leaves it there.
		const catalog = window.__galaxy_catalog || null;
		OrbitLib.setEngine('classic');
		model = GalaxyLib.createGalaxy({ type: 'SBb', seed: 42 });
		if (catalog) sets.catalogIndex = Field.createCatalogIndex(catalog);
		sets.sampleIndex = Field.createSampledIndex(model, 12000);
		updateEye();
		buildAnchors();

		const gpu = await Device.initDevice(canvas);
		device = gpu.device;
		context = gpu.context;
		format = gpu.format;
		renderer = Renderer.createDistanceFieldRenderer(device, { label: 'field' });

		bindUI();
		syncSourceSlider();
		state.ready = true;
		// The one window into the page, for experiments/distance-field-page-check.js
		// (and the console).
		window.DistanceFieldPage = state;
		requestAnimationFrame(frame);
	}

	boot().catch((e) => {
		showError(`boot failed: ${e && e.stack ? e.stack : e}`);
	});
})();
