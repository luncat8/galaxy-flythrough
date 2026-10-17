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
// Per frame: advance star time → integrate the anchors → re-pick the set if the
// eye moved → prepare the per-star constants → sample the field → paint.

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
		spreadRefPc: 200,
		gradSpanDeg: 14,
		budget: 'balanced',
		resH: 0,
		// Distance range behind the 0..1 height map.
		autoRange: true,
		rangeClock: 0,
		scale: { lo: -3, hi: 0, span: 3 },
		// Painting
		contours: true,
		contourLevels: 10,
		grid: false,
		// the star dots + figure overlay toggle (`check-stars`), not a count
		drawStars: true,
		names: true,
		invert: false,
		smooth: true,
		// Star time
		starTimeMyr: 0,
		starTimeRate: 0,
		moveStepPc: 50,
		// Data
		set: null,
		cur: null,
		field: null,
		layout: { kind: '', w: 0, h: 0 },
		stats: { pairs: 0, vMin: 0, vMax: 0, spreadMax: 0, dMin: 0, dMax: 0, empty: true },
		read: { height: 0 },
		// Input / timing
		setDirty: true,
		lastPick: new Float64Array(3),
		lastFrameMs: 0, fieldMs: 0, fps: 0,
		pointer: { u: 0.5, v: 0.5, inside: false },
		rect: null,
		catalog: null,
	};

	// ---- galaxy + star set ------------------------------------------------

	function buildModel() {
		// SBb with no overrides IS the Milky Way preset (galaxy.js spec.preset),
		// and only the preset owns the landmark table and the catalog. Any other
		// type is procedural, where the anchors fall back to sampled stars.
		state.model = GalaxyLib.createGalaxy({ type: state.galaxyType, seed: state.seed });
		state.setDirty = true;
	}

	function rebuildStarSet() {
		const c = state.pos;
		let set = null;
		if (state.model.milkyWay) {
			set = state.sourceN === 0
				? Field.buildConstellationSet({})
				: state.catalog
					? Field.buildCatalogSet(state.catalog, state.sourceN, c)
					: Field.buildSampledSet(state.model, state.sourceN, c);
		} else {
			set = Field.buildSampledSet(state.model, state.sourceN || 88, c);
		}
		state.set = set;
		state.lastPick[0] = c[0]; state.lastPick[1] = c[1]; state.lastPick[2] = c[2];
		if (!set.n) { state.cur = new Float64Array(0); refreshRange(); return; }
		if (!state.cur || state.cur.length < set.n * 3) state.cur = new Float64Array(set.n * 3);
		Field.advancePositions(set, state.cur, state.starTimeMyr, state.model);
		state.setDirty = false;
		refreshRange();
	}

	// The log height anchors. Auto mode re-reads them a few times a second — so a
	// fly tracks the local range — but never every frame: a per-frame range makes
	// the colour of a fixed star change as its neighbours move, which is exactly
	// the flicker that reads as "this map is lying". Freezing the range is what
	// lets a star-time animation be read as motion instead of as a repaint.
	function refreshRange() {
		if (!state.set || !state.set.n) return;
		if (!state.autoRange && state.scale.span > 0) return;
		const s = Field.prepareStars(state.cur, state.set.n, state.pos[0], state.pos[1], state.pos[2], null);
		if (s.n) Field.makeScale(state.scale, s.dMin, s.dMax);
	}

	function updateBasis() { Field.quatBasis(state.basis, state.pose); }

	// Centre the chart on the look direction: the pan quaternion maps the world so
	// that the view centre sits at lon 0 / lat 0 of the equirect window.
	function updateChartQuat() {
		if (!state.followLook) return;
		const b = state.basis;
		Field.quatArc(state.chartQuat, b.fx, b.fy, b.fz, 1, 0, 0);
	}

	// ---- main loop --------------------------------------------------------

	// The frame loop must not allocate, so the option records the APIs read are
	// filled in place. They also document, in one place, which fields matter.
	const layoutOpts = { kind: 'view', w: 0, h: 0, fovY: 0, aspect: 1, basis: null, spanDeg: 360, quat: null, mirror: true };
	const fieldOpts = { mode: 'height', sigmaDeg: 3, spreadRefKpc: 0.2, gradSpanDeg: 14 };
	const paintOpts = {
		mode: 'height', rect: null, positions: null, eye: null, set: null, viewBox: null,
		drawContours: false, contourLevels: 10, drawGrid: false, drawNames: false,
		invert: false, smooth: true,
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
		if (state.starTimeRate > 0 && dt > 0) state.starTimeMyr += dt * state.starTimeRate;

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
		if (state.setDirty || !state.set) rebuildStarSet();
		if (!state.set || !state.set.n) { drawReadout('no anchor stars: pick another source'); return; }

		if (state.starTimeMyr !== 0) Field.advancePositions(state.set, state.cur, state.starTimeMyr, state.model);

		state.rangeClock += dt;
		if (state.autoRange && state.rangeClock > 0.25) { state.rangeClock = 0; refreshRange(); }
		const stars = Field.prepareStars(state.cur, state.set.n, state.pos[0], state.pos[1], state.pos[2], state.scale);

		const budget = PAIRS_BUDGET[state.budget] || PAIRS_BUDGET.balanced;
		const aspect = iw / Math.max(1, ih);
		let h = state.resH ? Math.max(16, Math.min(512, state.resH | 0))
			: Field.autoResolution(budget, stars.n || 1, aspect);
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
		if (!state.field || state.field.length < w * h) state.field = new Float32Array(w * h);

		fieldOpts.mode = state.mode;
		fieldOpts.sigmaDeg = state.sigmaDeg;
		fieldOpts.spreadRefKpc = state.spreadRefPc / 1000;
		fieldOpts.gradSpanDeg = state.gradSpanDeg;
		const t0 = performance.now();
		Field.computeField(stars, state.layout, fieldOpts, state.field, state.stats);
		state.fieldMs = performance.now() - t0;

		const po = paintOpts;
		po.mode = state.mode;
		po.rect = rect;
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

	function fmtDist(kpc) {
		if (!(kpc > 0) || !Number.isFinite(kpc)) return '—';
		if (kpc < 0.1) return (kpc * 1000).toFixed(kpc * 1000 < 10 ? 2 : 0) + ' pc';
		if (kpc < 10) return kpc.toFixed(2) + ' kpc';
		return kpc.toFixed(1) + ' kpc';
	}

	function drawLegend() {
		const s = state.stats;
		const opts = {};
		if (state.mode === 'height') {
			const near = fmtDist(Math.pow(10, state.scale.lo));
			opts.title = `mode 1 · distance from the eye — ${state.set.n} anchors (${state.set.source})`;
			opts.low = 'far ' + fmtDist(Math.pow(10, state.scale.hi));
			opts.high = 'close ' + near;
			opts.note = `Shepard IDW p=2, σ ${state.sigmaDeg}°, log ${near}…${fmtDist(Math.pow(10, state.scale.hi))}`;
			opts.note2 = state.autoRange ? 'range auto · re-read every 0.25 s' : 'range frozen · colours comparable across frames';
		} else if (state.mode === 'spread') {
			opts.title = `mode 2 · depth spread — ${state.set.n} anchors`;
			opts.low = '0 (flat sky)';
			opts.high = `≥ ${fmtDist(state.spreadRefPc / 1000)}`;
			opts.note = 'σ of |star−eye| in the same direction: a ridge is a 2-D shortcut over a 3-D detour';
			opts.note2 = `peak ${fmtDist(s.spreadMax)} · half-cost at ${fmtDist(state.spreadRefPc / 1000)}`;
		} else {
			opts.title = `mode 3 · |∇ mode 1| — ${state.set.n} anchors`;
			opts.low = 'flat';
			opts.high = 'full range / ' + state.gradSpanDeg + '°';
			opts.note = 'the gradient of the height field: how fast the distance ramp climbs per degree of sky';
			opts.note2 = `field ${s.vMin.toFixed(2)}…${s.vMax.toFixed(2)}`;
		}
		Renderer.renderLegend(ctx, state.mode, opts);
	}

	function drawReadout(err) {
		if (err) { readout.textContent = err; return; }
		const b = state.basis, p = state.pos;
		const yaw = Math.atan2(b.fy, b.fx) / Field.DEG;
		const pitch = Math.asin(Math.max(-1, Math.min(1, b.fz))) / Field.DEG;
		let cursor = '';
		if (state.pointer.inside && state.field && state.layout.w) {
			Field.heightAt(state.field, state.layout, state.pointer.u, state.pointer.v, state.read);
			const v = state.read.height;
			let what;
			if (state.mode === 'height') what = '≈ ' + fmtDist(Field.distanceAtHeight(state.scale, v));
			else if (state.mode === 'spread') what = 'depth σ ≈ ' + fmtDist(v * state.spreadRefPc / 1000 / Math.max(1e-3, 1 - v));
			else what = `slope ${(v * state.gradSpanDeg).toFixed(1)}° per range`;
			cursor = `\ncursor: h ${v.toFixed(3)}  ${what}`;
		}
		readout.textContent =
			`projection: ${state.projection === 'plane'
				? `plane chart · ${state.chartSpanDeg | 0}° span${state.followLook ? ' · follows look' : ''}`
				: `view sphere · ${state.fovYDeg | 0}° vertical FoV`}\n`
			+ `source: ${state.sourceN === 0 ? 'constellations' : state.sourceN + ' nearest'} · ${state.set ? state.set.n : 0} anchors (${state.set ? state.set.source : '—'})\n`
			+ `eye: (${p[0].toFixed(3)}, ${p[1].toFixed(3)}, ${p[2].toFixed(3)}) kpc · look ${yaw.toFixed(1)}° / ${pitch.toFixed(1)}°\n`
			+ `galaxy: ${state.model.type} #${state.model.seed}${state.model.milkyWay ? ' (catalog)' : ' (procedural)'}\n`
			+ `star time: ${state.starTimeMyr.toFixed(1)} Myr (${OrbitLib.formatTimeRate(state.starTimeRate, 0)}) · engine ${OrbitLib.engineName()}\n`
			+ `field ${state.layout.w}×${state.layout.h} · ${(state.stats.pairs / 1e6).toFixed(2)} M pairs · ${state.fieldMs.toFixed(1)} ms · ${state.fps.toFixed(0)} fps`
			+ cursor;
	}

	// ---- input ------------------------------------------------------------

	let drag = null;
	const grabbed = new Float64Array(3);
	const reached = new Float64Array(3);
	const tmpQuat = new Float64Array(4);
	const tmpQuat2 = new Float64Array(4);

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

	canvas.addEventListener('pointerdown', (ev) => {
		canvas.setPointerCapture(ev.pointerId);
		pointerUV(ev, state.pointer);
		drag = { x: ev.clientX, y: ev.clientY, move: ev.shiftKey || ev.button === 1 };
		// A chart grab pins a *ray*, not a texel: the map then rotates so that ray
		// follows the pointer (planet-geotectonics MapView.drag).
		if (state.projection === 'plane' && !drag.move) {
			Field.dirAt(state.layout, state.pointer.u * state.layout.w - 0.5, state.pointer.v * state.layout.h - 0.5, grabbed);
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
		markMoved();
	}

	// Panning the chart: q' = q * arc(grabbed → ray now under the pointer), which
	// is the solve for "keep the grabbed world ray pinned under the pointer"
	// (the chart maps world→map with q, and dirAt maps map→world with q⁻¹). The
	// grabbed ray never changes during a drag, so many small steps cannot drift.
	function panChart() {
		if (!state.layout.w) return;
		Field.dirAt(state.layout, state.pointer.u * state.layout.w - 0.5,
			state.pointer.v * state.layout.h - 0.5, reached);
		Field.quatArc(tmpQuat, grabbed[0], grabbed[1], grabbed[2], reached[0], reached[1], reached[2]);
		Field.quatMul(tmpQuat2, tmpQuat, state.chartQuat);
		Field.quatNormalize(state.chartQuat, tmpQuat2);
		setFollowLook(false);
	}

	function setFollowLook(on) {
		state.followLook = on;
		const cb = $('check-follow');
		if (cb) cb.checked = on;
	}

	// Re-pick the nearest-N only when the eye has moved a real fraction of the
	// set's radius: catalog decoding is cheap but not free, and a jittering
	// selection is worse than one that lags a step.
	function markMoved() {
		const c = state.pos, p = state.lastPick;
		const d = Math.hypot(c[0] - p[0], c[1] - p[1], c[2] - p[2]);
		if (state.sourceN > 0 && d > 0.01) state.setDirty = true;
		if (state.autoRange) refreshRange();
	}

	canvas.addEventListener('wheel', (ev) => {
		ev.preventDefault();
		const f = Math.exp(ev.deltaY * 0.0015);
		if (ev.shiftKey) {
			const b = state.basis;
			const k = state.moveStepPc / 1000 * 2 * f;
			state.pos[0] += b.fx * k; state.pos[1] += b.fy * k; state.pos[2] += b.fz * k;
			markMoved();
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

	function bindUI() {
		bindRadios('view-mode', (v) => { state.mode = v; });
		bindRadios('projection', (v) => { state.projection = v; });
		bindRadios('budget', (v) => { state.budget = v; state.resH = 0; });
		bindSlider('slider-source', 'val-source',
			(v) => v === 0 ? 'constellations' : `${v | 0} nearest`,
			(v) => { state.sourceN = v | 0; state.setDirty = true; });
		bindSlider('slider-star-time', 'val-star-time',
			(v) => OrbitLib.formatTimeRate(v, 0),
			(v) => { state.starTimeRate = v; });
		// step 0.5, so the label must not floor the value.
		bindSlider('slider-sigma', 'val-sigma', (v) => `${v}°`, (v) => { state.sigmaDeg = v; });
		bindSlider('slider-spread', 'val-spread', (v) => fmtDist(v / 1000), (v) => { state.spreadRefPc = v; });
		bindSlider('slider-grad', 'val-grad', (v) => `${v | 0}°`, (v) => { state.gradSpanDeg = v; });
		bindSlider('slider-fov', 'val-fov', (v) => `${v | 0}°`, (v) => { state.fovYDeg = v; });
		bindSlider('slider-span', 'val-span', (v) => `${v | 0}°`, (v) => { state.chartSpanDeg = v; });
		bindSlider('slider-move', 'val-move', (v) => `${v | 0} pc`, (v) => { state.moveStepPc = v; });
		bindSlider('slider-res', 'val-res', (v) => v === 0 ? 'auto' : `${v | 0} px`, (v) => { state.resH = v | 0; });
		bindCheck('check-contours', (v) => { state.contours = v; });
		bindCheck('check-grid', (v) => { state.grid = v; });
		bindCheck('check-stars', (v) => { state.drawStars = v; });
		bindCheck('check-names', (v) => { state.names = v; });
		bindCheck('check-invert', (v) => { state.invert = v; });
		bindCheck('check-smooth', (v) => { state.smooth = v; });
		bindCheck('check-follow', (v) => { state.followLook = v; if (v) updateChartQuat(); });
		bindCheck('check-auto-range', (v) => { state.autoRange = v; refreshRange(); });
		bindCheck('check-mirror', (v) => { state.mirrorChart = v; });
		$('btn-home').addEventListener('click', () => {
			const home = state.model.home;
			state.pos[0] = home.position[0]; state.pos[1] = home.position[1]; state.pos[2] = home.position[2];
			state.pose[0] = 0; state.pose[1] = 0; state.pose[2] = 0; state.pose[3] = 1;
			state.starTimeMyr = 0;
			updateBasis();
			updateChartQuat();
			state.setDirty = true;
		});
		$('galaxy-apply').addEventListener('click', () => {
			const s = parseInt($('galaxy-seed').value, 10);
			state.seed = Number.isFinite(s) ? s : 42;
			state.galaxyType = ($('galaxy-type').value || 'SBb');
			state.starTimeMyr = 0;
			buildModel();
			rebuildStarSet();
		});
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
		rebuildStarSet();
		updateChartQuat();
		bindUI();
		// The one window into the page, for experiments/view-modes-page-check.js
		// (and the console): the harness has to know which layout the page actually
		// built to tell whether a painted dot landed on its star.
		window.ViewModesDebug = state;
		requestAnimationFrame(frame);
	} catch (e) {
		showError(`boot failed: ${e && e.stack ? e.stack : e}`);
	}
})();
