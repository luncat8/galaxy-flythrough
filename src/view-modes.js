// src/view-modes.js
// Boot / glue for the standalone view-modes heightmap page (archive/
// view-modes-shader-plan.md).
//
// The page is an island: it loads math/ and data/ plus these three files, and
// never touches core/, render/star-sprites.js or the WebGPU device. It agrees
// with the app anyway, because it re-derives nothing — the same home pose, the
// same 60° vertical FoV, the same gnomonic window, the same catalog + landmark
// star block, the same orbit dispatch for star time.
// experiments/view-modes-field-test.js pins the part that used to be wrong: a
// marker on this map lands on the pixel the app draws that star at.
//
// Per frame: advance star time → re-pick the nearest N if the eye or the sky
// moved → integrate the anchors → sample the raw field → apply the range → paint.
//
// Two pieces of state are worth knowing before reading on:
//   * `raw` is the physical field (log distance / depth σ / slope in dex per
//     degree) and is rebuilt every frame.
//   * `live` is the display range the painter uses (a Field range state).
//     Auto mode re-offers it the stats' suggestion at 4 Hz; the display eases
//     toward the newest offer every frame at a bounded rate and snaps only on a
//     mode change, so one mid-pan read can bend the colours but never set them.
//     Manual mode holds the two slider values. The legend quotes the same
//     numbers.

'use strict';

(function () {
	const $ = (id) => document.getElementById(id);
	const canvas = $('field');
	const ctx = canvas.getContext('2d');
	const readout = $('readout');
	const errEl = $('error');

	const Field = window.ViewModesField;
	const Renderer = window.ViewModesRenderer;
	const GalaxyLib = window.GalaxyLib;
	const OrbitLib = window.OrbitLib;

	// Same drag feel as the app (core/camera.js LOOK_SENSITIVITY), repeated here
	// on purpose: importing core/ is what the isolation rule forbids, and a look
	// that felt different would make the two views hard to compare by hand.
	const LOOK_SENS = 0.0022;
	const FOV_Y_DEG = 60;               // Camera.FOV_Y, the app's vertical FoV
	const PAIRS_BUDGET = { fast: 3e5, balanced: 1.5e6, high: 6e6, full: 2.4e7 };
	const RANGE_PERIOD = 0.25;          // seconds between auto-range reads
	const INDEX_PERIOD = 0.25;          // seconds between whole-index star-time moves
	const PICK_PERIOD = 0.25;           // seconds between star-time-only re-picks
	const SAMPLE_STARS = 12000;         // the procedural galaxy's searchable sky

	// Starting manual ranges, in the mode's own log10 unit (kpc / kpc / dex/°).
	// A mode without one inherits the live auto range the first time it is used.
	const MANUAL_DEFAULTS = {
		height: { lo: -3, hi: 0 },
		spread: { lo: -3, hi: -0.3 },
		gradient: { lo: -3.5, hi: -1.5 },
	};

	const state = {
		model: null,
		seed: 42,
		// The eye starts at the app's home pose: 5 pc above the Sun, identity
		// quaternion, looking at the galactic centre. Not an external orbit
		// camera — mode 1 is the distance from the *viewer*, which says nothing
		// from 2 kpc outside the field it is supposed to describe.
		pos: new Float64Array(3),
		pose: new Float64Array([0, 0, 0, 1]),
		basis: { fx: 1, fy: 0, fz: 0, rx: 0, ry: -1, rz: 0, ux: 0, uy: 0, uz: 1 },
		fovYDeg: FOV_Y_DEG,
		// 'view' = inside the view sphere (the gnomonic frustum window).
		// 'plane' = the equirect sky chart, panned by a quaternion.
		projection: 'view',
		chartQuat: new Float64Array([0, 0, 0, 1]),
		chartSpanDeg: 360,
		followLook: true,
		mirrorChart: true,
		// Field
		mode: 'height',
		sourceN: 0,
		sigmaDeg: Field.SIGMA_DEG,
		budget: 'balanced',
		resH: 0,
		// Display range. `live` is what the painter and the legend use; the
		// manual table keeps one pair of slider values per mode.
		autoRange: true,
		ranges: { height: null, spread: null, gradient: null },
		live: Field.createRangeState(-3, 0),
		rangeClock: 0,
		// Painting
		contours: true,
		contourLevels: 10,
		grid: false,
		// the star dots + figure overlay toggle (`check-stars`), not a count
		drawStars: true,
		names: true,
		invert: false,
		smooth: true,
		// 'auto' keeps the ramp each mode was designed for; any other value is an
		// explicit override that survives a mode switch.
		ramp: 'auto',
		relief: Renderer.RELIEF_DEFAULT,
		// Star time
		starTimeMyr: 0,
		starTimeRate: 0,
		// The movement passes the app offers. The island mirrors the ones the
		// CPU can reproduce exactly; the simple pass is integrated for the
		// landmarks (the app's own CPU mirror) and approximated for records.
		engine: ['classic'],
		moveStepPc: 50,
		// Anchors. `index` is the decoded catalog (birth positions);
		// `indexCur` is the same sky at the current star time, refreshed at
		// INDEX_PERIOD so a nearest-N query always measures what is drawn.
		catalog: null,
		index: null,
		indexCur: null,
		indexTime: 0,
		indexClock: 0,
		// A procedural galaxy's sky: the app's own field stars, sampled, with
		// the app's records. `sampleCur` is that sky at the current star time.
		sampleIndex: null,
		sampleCur: null,
		constSet: null,
		pickSet: null,
		cur: null,
		set: null,
		pickPos: new Float64Array(3),
		pickTime: 0,
		pickClock: 0,
		setDirty: true,
		// Data
		raw: null,
		field: null,
		layout: { kind: '', w: 0, h: 0 },
		stats: { pairs: 0, rawLo: 0, rawHi: 0, autoLo: 0, autoHi: 0, spreadMax: 0, dMin: 0, dMax: 0, empty: true },
		read: { height: 0 },
		readPaint: { height: 0 },
		// Input / timing
		lastFrameMs: 0, fieldMs: 0, fps: 0,
		pointer: { u: 0.5, v: 0.5, inside: false },
		rect: null,
	};

	const autoRangeScratch = { lo: 0, hi: 0, span: 0 };

	function updateBasis() { Field.quatBasis(state.basis, state.pose); }

	// Centre the chart on the look direction: the pan quaternion maps the world so
	// that the view centre sits at lon 0 / lat 0 of the equirect window.
	function updateChartQuat() {
		if (!state.followLook) return;
		const b = state.basis;
		Field.quatArc(state.chartQuat, b.fx, b.fy, b.fz, 1, 0, 0);
	}

	// ---- galaxy + anchors -------------------------------------------------

	function buildModel() {
		// SBb with no overrides IS the Milky Way preset (galaxy.js spec.preset),
		// and only the preset owns the landmark table and the catalog. Any other
		// type is procedural, where the anchors are a sampled sky.
		state.model = GalaxyLib.createGalaxy({ type: state.galaxyType, seed: state.seed });
		// The epoch base is the frame the field was drawn in. The renderer
		// re-bases it on every regeneration; without that the epoch map would
		// measure this model against the *previous* one's arms and move the
		// anchors off the app's stars.
		OrbitLib.setEpochBase(state.model);
		state.constSet = null;
		state.sampleIndex = null;
		state.sampleCur = null;
		state.indexTime = 0;
		state.indexClock = 0;
		state.setDirty = true;
	}

	// Nearest-N is a query, not a set built once: the search scans the decoded
	// index with a fixed max-heap (0.3 ms for 500 anchors) and writes the current
	// winners into one reusable set. The eye moving 2% of the set's own radius
	// re-picks; anything smaller is a drift the field already shows.
	function needPick() {
		if (state.setDirty || !state.set || !state.set.n) return true;
		if (state.set !== state.pickSet) return false;      // the fixed landmark set
		const e = state.pos, p = state.pickPos;
		const moved = Math.hypot(e[0] - p[0], e[1] - p[1], e[2] - p[2]);
		if (moved > Math.max(0.05, (state.set.dmax || 1) * 0.02)) return true;
		if (state.starTimeMyr !== state.pickTime && state.pickClock > PICK_PERIOD) return true;
		return false;
	}

	function pickAnchors() {
		const eye = state.pos;
		if (!state.model.milkyWay) {
			// A procedural galaxy's anchors are the app's own field stars: the
			// same sample, the same records, so they move with the star clock
			// and the engine exactly like the stars the app draws.
			if (!state.sampleIndex) {
				state.sampleIndex = Field.createSampledIndex(state.model, SAMPLE_STARS);
				state.sampleCur = new Float64Array(state.sampleIndex.n * 3);
			}
			state.set = state.pickSet;
			// Measure who is nearest *now* (the advanced copy); the set keeps
			// the birth records the orbit dispatch needs to draw them later.
			const src = state.indexTime !== 0 ? state.sampleCur : state.sampleIndex.positions;
			Field.queryNearest(state.sampleIndex, src,
				eye[0], eye[1], eye[2], state.sourceN || 88, state.pickSet);
		} else if (state.sourceN === 0 || !state.index) {
			if (!state.constSet) state.constSet = Field.buildConstellationSet({});
			state.set = state.constSet;
		} else {
			state.set = state.pickSet;
			// Star time moves the whole sky: measure who is nearest *now* (the
			// advanced index), while the set keeps the birth records the orbit
			// dispatch needs to draw them at the frame's time.
			const src = state.indexTime !== 0 ? state.indexCur : state.index.positions;
			Field.queryNearest(state.index, src, eye[0], eye[1], eye[2], state.sourceN, state.pickSet);
		}
		state.pickPos[0] = eye[0]; state.pickPos[1] = eye[1]; state.pickPos[2] = eye[2];
		state.pickTime = state.indexTime;
		state.pickClock = 0;
		state.setDirty = false;
	}

	// Keep the whole index current while star time runs: one dispatch per record
	// (~10 ms for the catalog), so it is throttled and only then re-picked.
	// The catalog and the procedural sample take turns — the Milky Way has no
	// sample, a procedural galaxy has no catalog — and both carry records the
	// app's dispatch understands.
	function advanceIndex(dt) {
		if (state.starTimeMyr === 0) return;
		if (Math.abs(state.starTimeMyr - state.indexTime) < 1e-9) return;
		state.indexClock += dt;
		if (state.indexClock < INDEX_PERIOD) return;
		state.indexClock = 0;
		if (state.model.milkyWay) {
			if (!state.index) return;
			Field.prepareIndexPositions(state.index, state.indexCur, state.starTimeMyr, state.model);
		} else if (state.sampleIndex && state.sampleCur) {
			Field.prepareIndexPositions(state.sampleIndex, state.sampleCur, state.starTimeMyr, state.model);
		} else {
			return;
		}
		state.indexTime = state.starTimeMyr;
		state.setDirty = true;
	}

	// ---- display range ----------------------------------------------------

	// The shared following law (Field.offerRange / easeRange): every 4 Hz read
	// becomes the target at once and the display eases to it — promptly for a
	// correction the window almost fits, rate-capped while it is far from one.
	// A lone unsettled read therefore nudges the colours instead of owning them,
	// and a real pan is never left waiting for two reads to agree.
	function refreshAutoRange() {
		const s = state.stats;
		if (s.empty) return;
		const a = Field.autoRange(state.mode, s, autoRangeScratch);
		Field.offerRange(state.live, state.mode, a.lo, a.hi);
	}

	function manualRange() {
		let r = state.ranges[state.mode];
		if (!r) {
			const d = MANUAL_DEFAULTS[state.mode];
			r = state.ranges[state.mode] = { lo: d.lo, hi: d.hi };
		}
		return r;
	}

	// Unchecking auto freezes the colours where they are: the manual range starts
	// as the live one, and every later slider move edits it from there.
	function freezeRange() {
		const r = manualRange();
		r.lo = state.live.lo;
		r.hi = state.live.hi;
	}

	function setAutoRange(on) {
		state.autoRange = on;
		const cb = $('check-auto-range');
		if (cb) cb.checked = on;
		syncRangeUI();
	}

	// ---- main loop --------------------------------------------------------

	// The frame loop must not allocate, so the option records the APIs read are
	// filled in place. They also document, in one place, which fields matter.
	const layoutOpts = { kind: 'view', w: 0, h: 0, fovY: 0, aspect: 1, basis: null, spanDeg: 360, quat: null, mirror: true };
	const fieldOpts = { mode: 'height', sigmaDeg: 3 };
	const paintOpts = {
		mode: 'height', rect: null, positions: null, eye: null, set: null, viewBox: null,
		drawContours: false, contourLevels: 10, drawGrid: false, drawNames: false,
		invert: false, smooth: true, ramp: null, relief: 0,
	};
	const letterbox = { x: 0, y: 0, w: 0, h: 0 };
	const cornerDir = new Float64Array(3);
	const viewBox = [new Float64Array(3), new Float64Array(3), new Float64Array(3), new Float64Array(3)];
	const VIEW_SIGNS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

	function frame(nowMs) {
		requestAnimationFrame(frame);
		const dt = state.lastFrameMs ? Math.min(0.1, (nowMs - state.lastFrameMs) / 1000) : 0;
		state.lastFrameMs = nowMs;
		if (dt > 0) state.fps = state.fps ? state.fps * 0.9 + (1 / dt) * 0.1 : 1 / dt;
		if (state.starTimeRate > 0 && dt > 0) {
			const dtStar = dt * state.starTimeRate;
			state.starTimeMyr += dtStar;
			// The pattern's phase is integrated with the star clock, exactly as
			// the app does it: the arms turn with the stars that ride them, so
			// a map whose anchors rotate around a *frozen* pattern would show
			// a sky the app never draws.
			OrbitLib.setPatternClock(state.starTimeMyr, state.model);
			// The simple pass keeps a CPU mirror of the friction field for the
			// landmarks; the app steps it with the same star-time delta.
			if (state.engine.indexOf('simple') >= 0) OrbitLib.simpleLandmarksStep(dtStar, state.starTimeMyr);
		}
		state.pickClock += dt;

		// One texel must be the same angle in x and y — the gradient mode divides
		// by the texel angle, and a stretched map is a stretched world.
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		const iw = Math.max(64, Math.floor(canvas.clientWidth * dpr));
		const ih = Math.max(64, Math.floor(canvas.clientHeight * dpr));
		if (canvas.width !== iw || canvas.height !== ih) { canvas.width = iw; canvas.height = ih; }

		if (state.mode === 'off') {
			ctx.fillStyle = '#05070d';
			ctx.fillRect(0, 0, iw, ih);
			drawReadout();
			return;
		}

		advanceIndex(dt);
		if (needPick()) pickAnchors();
		if (!state.set || !state.set.n) { drawReadout('no anchor stars: pick another source'); return; }
		Field.advancePositions(state.set, state.cur, state.starTimeMyr, state.model);

		const budget = PAIRS_BUDGET[state.budget] || PAIRS_BUDGET.balanced;
		const aspect = iw / Math.max(1, ih);
		let h = state.resH ? Math.max(16, Math.min(512, state.resH | 0))
			: Field.autoResolution(budget, state.set.n || 1, aspect);
		let w = Math.max(16, Math.min(1024, Math.round(h * aspect / 8) * 8));
		updateChartQuat();
		// A chart wider in latitude than the window can hold keeps its
		// degrees-per-texel — it drops rows instead of squashing them, and is
		// centred in the window. 360° of longitude is 2:1, not 16:9.
		let rect = null;
		if (state.projection === 'plane' && state.chartSpanDeg * h / w > 180) {
			h = Math.max(16, Math.floor(180 * w / state.chartSpanDeg / 8) * 8);
			const rh = Math.min(ih, iw * h / w);
			rect = letterbox;
			letterbox.x = 0; letterbox.y = (ih - rh) / 2; letterbox.w = iw; letterbox.h = rh;
		}
		state.rect = rect;
		const lo = layoutOpts;
		lo.w = w; lo.h = h;
		if (state.projection === 'plane') {
			lo.kind = 'plane'; lo.spanDeg = state.chartSpanDeg;
			lo.quat = state.chartQuat; lo.mirror = state.mirrorChart;
		} else {
			lo.kind = 'view';
			// The *window's* aspect, so the field covers exactly the angles the app
			// renders and a marker cannot slide off its star.
			lo.fovY = state.fovYDeg * Field.DEG; lo.aspect = aspect; lo.basis = state.basis;
		}
		Field.createLayout(state.layout, lo);
		if (!state.raw || state.raw.length < w * h) {
			state.raw = new Float32Array(w * h);
			state.field = new Float32Array(w * h);
		}
		const nTexels = w * h;

		const stars = Field.prepareStars(state.cur, state.set.n, state.pos[0], state.pos[1], state.pos[2]);
		state.rangeClock += dt;
		// The range suggestion is only read a few times a second; the field is
		// rebuilt every frame. Asking computeRaw for the histogram every frame
		// would spend milliseconds on numbers nobody reads.
		const measure = state.autoRange && (state.rangeClock >= RANGE_PERIOD || state.live.mode !== state.mode);
		fieldOpts.mode = state.mode;
		fieldOpts.sigmaDeg = state.sigmaDeg;
		fieldOpts.measure = measure;
		const t0 = performance.now();
		Field.computeRaw(stars, state.layout, fieldOpts, state.raw, state.stats);
		state.fieldMs = performance.now() - t0;

		if (state.autoRange) {
			if (measure) { state.rangeClock = 0; refreshAutoRange(); }
			Field.easeRange(state.live, dt);
		} else {
			const r = manualRange();
			Field.resetRange(state.live, state.mode, r.lo, r.hi);
		}
		Field.applyRange(state.raw, nTexels, state.mode, state.live, state.field);

		const po = paintOpts;
		po.mode = state.mode;
		po.rect = rect;
		// Resolved once per frame and handed to the legend too, so the strip the
		// legend draws is the strip the map was painted with.
		po.ramp = Renderer.resolveRamp(state.mode, state.ramp);
		po.relief = state.relief;
		po.positions = state.drawStars ? state.cur : null;
		// World positions in, eye-relative out — the same subtraction
		// prepareStars makes, so a dot sits on its own peak.
		po.eye = state.pos;
		po.set = state.set;
		po.drawContours = state.contours;
		po.contourLevels = state.contourLevels;
		po.drawGrid = state.grid;
		po.drawNames = state.names;
		po.invert = state.invert;
		po.smooth = state.smooth;
		po.viewBox = state.projection === 'plane' ? frustumCorners() : null;
		Renderer.renderField(ctx, state.field, state.layout, po);
		drawLegend();
		drawReadout();
		if (state.rangeClock === 0) syncRangeUI();
	}

	// The four corner rays of the app window: the dashed box that says "this is
	// what the view sphere is showing right now".
	function frustumCorners() {
		const b = state.basis;
		const ty = Math.tan(state.fovYDeg * Field.DEG * 0.5);
		const tx = ty * (canvas.width / Math.max(1, canvas.height));
		for (let i = 0; i < 4; i++) {
			const sx = VIEW_SIGNS[i][0] * tx, sy = VIEW_SIGNS[i][1] * ty;
			cornerDir[0] = b.fx + b.rx * sx + b.ux * sy;
			cornerDir[1] = b.fy + b.ry * sx + b.uy * sy;
			cornerDir[2] = b.fz + b.rz * sx + b.uz * sy;
			const l = Math.hypot(cornerDir[0], cornerDir[1], cornerDir[2]) || 1;
			viewBox[i][0] = cornerDir[0] / l; viewBox[i][1] = cornerDir[1] / l; viewBox[i][2] = cornerDir[2] / l;
		}
		return viewBox;
	}

	// ---- legend + readout -------------------------------------------------

	// The shared formatters (render/view-modes-renderer.js): the legend, the
	// readout and the range sliders quote the same string for the same number.
	const fmtDist = Renderer.formatDistance;
	const fmtSlope = Renderer.formatSlope;
	const fmtRangeValue = Renderer.formatRangeValue;

	// The legend is 260 px wide at 11 px monospace (~6.5 px a glyph): every line
	// below stays under ~38 characters so nothing is clipped at the canvas edge.
	// The readout keeps the long version.
	function drawLegend() {
		const s = state.stats;
		const live = state.live;
		const opts = { ramp: Renderer.resolveRamp(state.mode, state.ramp) };
		const anchors = `${state.set.n} anchors (${state.set.source})`;
		const how = state.autoRange ? 'auto' : 'manual';
		if (state.mode === 'height') {
			opts.title = 'mode 1 · distance from eye';
			// Height's range lo is the NEAR end (small log distance) and hi the
			// far one, because the raw value is log distance and the ramp is
			// inverted: far is the bottom colour.
			opts.low = 'far ' + fmtDist(Math.pow(10, live.hi));
			opts.high = 'close ' + fmtDist(Math.pow(10, live.lo));
			opts.note = `${anchors} · IDW σ ${state.sigmaDeg}°`;
			opts.note2 = `${how} range · log10 of the distance`;
		} else if (state.mode === 'spread') {
			opts.title = 'mode 2 · depth spread';
			opts.low = 'flat ≤ ' + fmtDist(Math.pow(10, live.lo));
			opts.high = '≥ ' + fmtDist(Math.pow(10, live.hi));
			opts.note = `${anchors} · peak ${fmtDist(s.spreadMax)}`;
			opts.note2 = `${how} range · log σ of |star−eye|`;
		} else {
			opts.title = 'mode 3 · slope of log distance';
			opts.low = 'flat ≤ ' + fmtRangeValue('gradient', live.lo);
			opts.high = '≥ ' + fmtRangeValue('gradient', live.hi);
			opts.note = `${anchors}`;
			opts.note2 = `${how} range · log · no hard top`;
		}
		Renderer.renderLegend(ctx, state.mode, opts);
	}

	// The N-anchored pick is "N nearest" for any model — of the catalog for the
	// Milky Way, of the sampled sky for a procedural one. Only sourceN = 0
	// leaves the whole set: the figures, or the sampled sky.
	function anchorSource() {
		if (state.sourceN > 0) return state.sourceN + ' nearest';
		return state.model && state.model.milkyWay ? 'constellations' : 'sampled sky';
	}

	// The simple pass owns a CPU mirror for the landmarks only: a record's
	// azimuth lives in the renderer's compute buffer, so the island's record
	// anchors ride the classic law under it. The readout says which, instead
	// of the map quietly disagreeing with the app.
	function engineNote() {
		if (state.engine.indexOf('simple') < 0) return '';
		return state.set && state.set.landmark ? '' : ' (records ride the classic law)';
	}

	function drawReadout(err) {
		if (err) { readout.textContent = err; return; }
		const b = state.basis, p = state.pos;
		const yaw = Math.atan2(b.fy, b.fx) / Field.DEG;
		const pitch = Math.asin(Math.max(-1, Math.min(1, b.fz))) / Field.DEG;
		let rangeLine;
		if (state.mode === 'height') {
			rangeLine = `${state.autoRange ? 'auto' : 'manual'} log · near ${fmtDist(Math.pow(10, state.live.lo))}`
				+ ` … far ${fmtDist(Math.pow(10, state.live.hi))}`;
		} else if (state.mode === 'spread') {
			rangeLine = `${state.autoRange ? 'auto' : 'manual'} log · flat ${fmtDist(Math.pow(10, state.live.lo))}`
				+ ` … deep ${fmtDist(Math.pow(10, state.live.hi))}`;
		} else if (state.mode === 'gradient') {
			rangeLine = `${state.autoRange ? 'auto' : 'manual'} log · flat ${fmtRangeValue('gradient', state.live.lo)}`
				+ ` … steep ${fmtRangeValue('gradient', state.live.hi)}`;
		} else {
			rangeLine = 'off';
		}
		// What the map is painted with. 'off' reports off rather than the settings
		// that would apply: a line claiming a ramp is on screen while the canvas is
		// cleared is the kind of readout that cannot be trusted.
		const rampName = Renderer.resolveRamp(state.mode, state.ramp)._name;
		const paintLine = state.mode === 'off' ? 'off'
			: `${rampName}${state.ramp === 'auto' ? ' (auto)' : ''}`
			+ ` · relief ${state.relief > 0 ? `${state.relief}×` : 'off'}`
			+ `${state.contours ? ` · contours ${state.contourLevels}` : ''}`;
		let cursor = '';
		if (state.pointer.inside && state.raw && state.layout.w) {
			const u = state.pointer.u, v = state.pointer.v;
			Field.heightAt(state.raw, state.layout, u, v, state.read);
			Field.heightAt(state.field, state.layout, u, v, state.readPaint);
			const raw = state.read.height;
			let what;
			if (state.mode === 'height') what = `≈ ${fmtDist(Math.pow(10, raw))}`;
			else if (state.mode === 'spread') what = `depth σ ≈ ${fmtDist(raw)}`;
			else what = `slope ≈ ${fmtSlope(raw)}`;
			cursor = `\ncursor: ${what}  (painted ${state.readPaint.height.toFixed(3)})`;
		}
		readout.textContent =
			`projection: ${state.projection === 'plane'
				? `plane chart · ${state.chartSpanDeg | 0}° span${state.followLook ? ' · follows look' : ''}`
				: `view sphere · ${state.fovYDeg | 0}° vertical FoV`}\n`
			+ `source: ${anchorSource()} · ${state.set ? state.set.n : 0} anchors (${state.set ? state.set.source : '—'})\n`
			+ `eye: (${p[0].toFixed(3)}, ${p[1].toFixed(3)}, ${p[2].toFixed(3)}) kpc · look ${yaw.toFixed(1)}° / ${pitch.toFixed(1)}°\n`
			+ `galaxy: ${state.model.type} #${state.model.seed}${state.model.milkyWay ? ' (catalog)' : ' (procedural)'}\n`
			+ `star time: ${state.starTimeMyr.toFixed(1)} Myr (${OrbitLib.formatTimeRate(state.starTimeRate, 0)}) · engine ${OrbitLib.engineName()}${engineNote()}\n`
			+ `range: ${rangeLine}\n`
			+ `paint: ${paintLine}\n`
			+ `field ${state.layout.w}×${state.layout.h} · ${(state.stats.pairs / 1e6).toFixed(2)} M pairs · ${state.fieldMs.toFixed(1)} ms · ${state.fps.toFixed(0)} fps`
			+ cursor;
	}

	// ---- input ------------------------------------------------------------

	let drag = null;
	const grabbedRay = new Float64Array(3);
	const reachedRay = new Float64Array(3);
	const dragStartQuat = new Float64Array(4);

	// Pointer → the *map's* UV, so the cursor readout, the chart drag and the
	// field agree even when a latitude-limited chart is letterboxed in the window.
	function pointerUV(ev, out) {
		const r = canvas.getBoundingClientRect();
		const x = (ev.clientX - r.left) / Math.max(1, r.width) * (canvas.width | 0);
		const y = (ev.clientY - r.top) / Math.max(1, r.height) * (canvas.height | 0);
		const rect = state.rect;
		if (rect) {
			out.u = (x - rect.x) / Math.max(1, rect.w);
			out.v = (y - rect.y) / Math.max(1, rect.h);
		} else {
			out.u = x / Math.max(1, canvas.width);
			out.v = y / Math.max(1, canvas.height);
		}
		out.inside = out.u >= 0 && out.u <= 1 && out.v >= 0 && out.v <= 1;
		return out;
	}

	// The pointer's ray in the chart's own frame. It must be built from the same
	// span the layout uses, but *not* from the layout's cached quaternion: the
	// pan writes a new chartQuat on every pointermove, and a ray read back from
	// a one-frame-old layout is how the old drag composed the arc against the
	// wrong rotation and accelerated.
	function chartRayAt(u, v, out) {
		const spanX = state.chartSpanDeg * Field.DEG;
		const lay = state.layout;
		const spanY = lay.w ? spanX * lay.h / lay.w : spanX * (canvas.height / Math.max(1, canvas.width));
		return Field.chartDirAt(out, u, v, spanX, spanY, state.mirrorChart);
	}

	canvas.addEventListener('pointerdown', (ev) => {
		canvas.setPointerCapture(ev.pointerId);
		pointerUV(ev, state.pointer);
		const move = ev.shiftKey || ev.button === 1;
		drag = { x: ev.clientX, y: ev.clientY, move };
		// A chart grab pins a *ray*, not a texel (planet-geotectonics
		// MapView.drag). The pressed map direction and the chart quaternion at
		// press are all the pan needs; from those every move is one exact
		// composition, so many small moves cannot drift.
		if (state.projection === 'plane' && !move) {
			dragStartQuat[0] = state.chartQuat[0]; dragStartQuat[1] = state.chartQuat[1];
			dragStartQuat[2] = state.chartQuat[2]; dragStartQuat[3] = state.chartQuat[3];
			chartRayAt(state.pointer.u, state.pointer.v, grabbedRay);
		}
	});
	canvas.addEventListener('pointermove', (ev) => {
		pointerUV(ev, state.pointer);
		if (!drag) return;
		const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
		drag.x = ev.clientX; drag.y = ev.clientY;
		if (drag.move) return panEye(dx, dy);
		if (state.projection === 'plane') return panChart();
		look(dx, dy);
	});
	canvas.addEventListener('pointerup', () => { drag = null; });
	canvas.addEventListener('pointercancel', () => { drag = null; });
	canvas.addEventListener('pointerleave', () => { state.pointer.inside = false; });

	// The app's look law: yaw about the current up, pitch about the current right.
	function look(dx, dy) {
		const b = state.basis, q = state.pose;
		if (dx !== 0) Field.quatTurn(q, q[0], q[1], q[2], q[3], b.ux, b.uy, b.uz, -dx * LOOK_SENS);
		if (dy !== 0) Field.quatTurn(q, q[0], q[1], q[2], q[3], b.rx, b.ry, b.rz, -dy * LOOK_SENS);
		Field.quatNormalize(q, q);
		updateBasis();
	}

	// Shift+drag slides the eye across the view plane, wheel+shift dollies. The
	// field is the distance from the camera, so this is the control that makes
	// mode 1 say anything other than "you are at home".
	function panEye(dx, dy) {
		const b = state.basis;
		const k = state.moveStepPc / 1000 / 100;
		state.pos[0] += (b.rx * -dx + b.ux * dy) * k;
		state.pos[1] += (b.ry * -dx + b.uy * dy) * k;
		state.pos[2] += (b.rz * -dx + b.uz * dy) * k;
	}

	// q' = arc(e₀ → e₁) · q₀, both rays in the chart frame. The pressed sky
	// point stays under the pointer because the chart maps a world ray w to
	// q·w, so (arc·q)⁻¹·e₁ = q⁻¹·e₀ — exact for any starting rotation, and
	// returning to the press pixel restores the original chart.
	function panChart() {
		if (!state.layout.w) return;
		chartRayAt(state.pointer.u, state.pointer.v, reachedRay);
		Field.quatDrag(state.chartQuat, dragStartQuat,
			grabbedRay[0], grabbedRay[1], grabbedRay[2],
			reachedRay[0], reachedRay[1], reachedRay[2]);
		if (state.followLook) setFollowLook(false);
	}

	function setFollowLook(on) {
		state.followLook = on;
		const cb = $('check-follow');
		if (cb) cb.checked = on;
	}

	canvas.addEventListener('wheel', (ev) => {
		ev.preventDefault();
		const f = Math.exp(ev.deltaY * 0.0015);
		if (ev.shiftKey) {
			const b = state.basis;
			const k = state.moveStepPc / 1000 * 2 * f;
			state.pos[0] += b.fx * k; state.pos[1] += b.fy * k; state.pos[2] += b.fz * k;
			return;
		}
		if (state.projection === 'plane') {
			state.chartSpanDeg = Math.max(15, Math.min(360, state.chartSpanDeg * f));
			syncSlider('slider-span', 'val-span', state.chartSpanDeg | 0, (v) => v + '°');
			return;
		}
		state.fovYDeg = Math.max(15, Math.min(150, state.fovYDeg * f));
		syncSlider('slider-fov', 'val-fov', Math.round(state.fovYDeg), (v) => v + '°');
	}, { passive: false });

	function syncSlider(id, valId, value, fmt) {
		const el = $(id), vEl = $(valId);
		if (el) el.value = value;
		if (vEl) vEl.textContent = fmt(value);
	}

	// The anchor slider counts the nearest stars, but the Milky Way's default
	// is the constellation set, so the label has to say which of the two the
	// page is actually using — a procedural galaxy has no constellations at
	// all.
	function sourceLabel(n) {
		if (n !== 0) return `${n | 0} nearest`;
		return state.model && state.model.milkyWay ? 'constellations' : 'sampled sky';
	}

	function syncSourceLabel() {
		const el = $('slider-source'), vEl = $('val-source');
		if (!el || !vEl) return;
		vEl.textContent = sourceLabel(el.value | 0);
	}

	// ---- UI wiring ---------------------------------------------------------

	function bindSlider(id, valId, fmt, onChange) {
		const el = $(id), vEl = $(valId);
		const update = () => {
			const v = parseFloat(el.value);
			vEl.textContent = fmt(v);
			onChange(v);
		};
		el.addEventListener('input', update);
		update();
	}
	function bindCheck(id, onChange) {
		const el = $(id);
		el.addEventListener('change', () => onChange(el.checked));
	}
	function bindRadios(name, onChange) {
		document.querySelectorAll(`input[name="${name}"]`).forEach((r) => {
			r.addEventListener('change', () => { if (r.checked) onChange(r.value); });
		});
	}

	// The two manual range sliders are log10 values; moving one takes the page
	// out of auto so the change cannot be overwritten by the next 4 Hz read.
	function bindRangeSlider(id, valId, which) {
		const el = $(id), vEl = $(valId);
		el.addEventListener('input', () => {
			const v = parseFloat(el.value);
			if (!Number.isFinite(v)) return;
			if (state.autoRange) { freezeRange(); setAutoRange(false); }
			const r = manualRange();
			r[which] = v;
			if (r.hi <= r.lo) {
				if (which === 'lo') r.hi = r.lo + 0.05;
				else r.lo = r.hi - 0.05;
			}
			vEl.textContent = fmtRangeValue(state.mode, r[which]);
			syncRangeUI();
		});
		vEl.textContent = fmtRangeValue(state.mode, parseFloat(el.value) || 0);
	}

	function syncRangeUI() {
		const lo = $('slider-range-lo'), hi = $('slider-range-hi');
		if (!lo || !hi) return;
		const near = state.mode === 'height';
		const loLabel = $('label-range-lo'), hiLabel = $('label-range-hi');
		if (loLabel) loLabel.textContent = near ? 'Near' : 'Range lo';
		if (hiLabel) hiLabel.textContent = near ? 'Far' : 'Range hi';
		const r = state.autoRange ? state.live : manualRange();
		lo.value = r.lo.toFixed(2);
		hi.value = r.hi.toFixed(2);
		lo.disabled = state.autoRange;
		hi.disabled = state.autoRange;
		const loVal = $('val-range-lo'), hiVal = $('val-range-hi');
		if (loVal) loVal.textContent = fmtRangeValue(state.mode, r.lo);
		if (hiVal) hiVal.textContent = fmtRangeValue(state.mode, r.hi);
	}

	function onModeChange(mode) {
		state.mode = mode;
		if (!state.autoRange) manualRange();
		state.rangeClock = RANGE_PERIOD;   // force a fresh range read next frame
		syncRangeUI();
	}

	// The movement passes the app offers, in the app's order. The island
	// mirrors the ones the CPU can reproduce: the classic law and the
	// apocenter ellipse are closed form, and the simple friction field has a
	// CPU mirror for the landmarks (the app's own) but not for records —
	// those live in the renderer's compute buffer. The readout says so when
	// the simple pass is on, rather than pretending the map rides it.
	function applyEngine() {
		const list = [];
		if ($('engine-classic').checked) list.push('classic');
		if ($('engine-simple').checked) list.push('simple');
		if ($('engine-apocenter').checked) list.push('apocenter');
		state.engine = list.length ? list : ['classic'];
		OrbitLib.setEngine(state.engine);
		// The landmarks' simple mirror is bound to the model and the star
		// clock, so a new engine or a new model re-binds it.
		initSimpleLandmarks();
		// The engine moves the sky, so who is nearest moves with it.
		state.setDirty = true;
	}

	function initSimpleLandmarks() {
		if (!state.constSet || !state.model) return;
		OrbitLib.simpleLandmarksInit(state.constSet.positions, state.constSet.colorIndex,
			state.constSet.n, state.model);
	}

	function bindUI() {
		bindRadios('view-mode', onModeChange);
		bindRadios('projection', (v) => { state.projection = v; });
		bindRadios('budget', (v) => { state.budget = v; state.resH = 0; });
		bindRadios('ramp', (v) => { state.ramp = v; });
		bindSlider('slider-relief', 'val-relief',
			(v) => v > 0 ? `${v}×` : 'off',
			(v) => { state.relief = v; });
		bindSlider('slider-source', 'val-source',
			(v) => sourceLabel(v),
			(v) => { state.sourceN = v | 0; state.setDirty = true; });
		bindSlider('slider-star-time', 'val-star-time',
			(v) => OrbitLib.formatTimeRate(v, 0),
			(v) => { state.starTimeRate = v; });
		// step 0.5, so the label must not floor the value.
		bindSlider('slider-sigma', 'val-sigma', (v) => `${v}°`, (v) => { state.sigmaDeg = v; });
		bindSlider('slider-fov', 'val-fov', (v) => `${v | 0}°`, (v) => { state.fovYDeg = v; });
		bindSlider('slider-span', 'val-span', (v) => `${v | 0}°`, (v) => { state.chartSpanDeg = v; });
		bindSlider('slider-move', 'val-move', (v) => `${v | 0} pc`, (v) => { state.moveStepPc = v; });
		bindSlider('slider-res', 'val-res', (v) => v === 0 ? 'auto' : `${v | 0} px`, (v) => { state.resH = v | 0; });
		bindRangeSlider('slider-range-lo', 'val-range-lo', 'lo');
		bindRangeSlider('slider-range-hi', 'val-range-hi', 'hi');
		bindCheck('check-contours', (v) => { state.contours = v; });
		bindCheck('check-grid', (v) => { state.grid = v; });
		bindCheck('check-stars', (v) => { state.drawStars = v; });
		bindCheck('check-names', (v) => { state.names = v; });
		bindCheck('check-invert', (v) => { state.invert = v; });
		bindCheck('check-smooth', (v) => { state.smooth = v; });
		bindCheck('check-follow', (v) => { state.followLook = v; if (v) updateChartQuat(); });
		bindCheck('check-auto-range', (v) => { if (!v) freezeRange(); setAutoRange(v); });
		bindCheck('check-mirror', (v) => { state.mirrorChart = v; });
		['engine-classic', 'engine-simple', 'engine-apocenter'].forEach((id) => {
			$(id).addEventListener('change', applyEngine);
		});
		$('btn-home').addEventListener('click', () => {
			const home = state.model.home;
			state.pos[0] = home.position[0]; state.pos[1] = home.position[1]; state.pos[2] = home.position[2];
			state.pose[0] = 0; state.pose[1] = 0; state.pose[2] = 0; state.pose[3] = 1;
			state.starTimeMyr = 0;
			state.indexTime = 0;
			state.indexClock = 0;
			state.setDirty = true;
			updateBasis();
			updateChartQuat();
		});
		$('galaxy-apply').addEventListener('click', () => {
			const s = parseInt($('galaxy-seed').value, 10);
			state.seed = Number.isFinite(s) ? s : 42;
			state.galaxyType = ($('galaxy-type').value || 'SBb');
			state.starTimeMyr = 0;
			buildModel();
			pickAnchors();
			// A new model re-binds the landmarks' simple mirror and the
			// anchor label (a procedural galaxy has no constellations).
			initSimpleLandmarks();
			syncSourceLabel();
		});
		syncRangeUI();
	}

	// ---- boot -------------------------------------------------------------

	function showError(msg) {
		errEl.style.display = 'block';
		errEl.textContent = msg;
		console.error(msg);
	}

	try {
		// data/tiles/catalog.js is a plain data script: it sets
		// window.__galaxy_catalog and leaves it there, which is how the island
		// reads the shipping star block without stream/tile-loader.js.
		state.catalog = window.__galaxy_catalog || null;
		if (!state.catalog) showError('catalog bundle missing (data/tiles/catalog.js) — using sampled stars');
		state.galaxyType = 'SBb';
		const home = GalaxyLib.MILKY_WAY.home;
		state.pos[0] = home.position[0]; state.pos[1] = home.position[1]; state.pos[2] = home.position[2];
		OrbitLib.setEngine('classic');
		buildModel();
		updateBasis();
		updateChartQuat();
		// The whole catalog is decoded once at boot; every nearest-N query after
		// this reads flat arrays. ~8 ms, and it is what makes re-picking per eye
		// move cheap.
		if (state.catalog) {
			state.index = Field.createCatalogIndex(state.catalog);
			state.indexCur = new Float64Array(state.index.n * 3);
		}
		state.pickSet = Field.createSet(Field.MAX_STARS);
		state.cur = new Float64Array(Field.MAX_STARS * 3);
		pickAnchors();
		// The landmarks' simple mirror is bound to the model, and the engine
		// checkboxes are the page's own copy of the app's selection.
		initSimpleLandmarks();
		bindUI();
		applyEngine();
		syncSourceLabel();
		// The one window into the page, for experiments/view-modes-page-check.js
		// (and the console): the harness has to know which layout the page actually
		// built to tell whether a painted dot landed on its star.
		window.ViewModesDebug = state;
		requestAnimationFrame(frame);
	} catch (e) {
		showError(`boot failed: ${e && e.stack ? e.stack : e}`);
	}
})();
