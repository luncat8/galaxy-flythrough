// src/view-modes.js
// Boot / glue for the standalone view-modes heightmap page (plan §0b, §3).
//
// Creates a galaxy, samples stars (constellations or nearest N), owns a tiny
// orbit camera, drives a requestAnimationFrame loop that:
//   1. advances star time (when slider > 0),
//   2. integrates orbits for the N anchor stars,
//   3. recomputes the heightmap field via ViewModesField.computeField,
//   4. paints it via ViewModesRenderer.renderHeightmap.
//
// No dependency on core/ or render/star-sprites.js — fully isolated.

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

	// ---- state -------------------------------------------------------------

	const state = {
		model: null,
		seed: 42,
		// camera: simple orbit around the Sun (origin). Azimuth/elevation/distance.
		camAzim: 0.6,
		camElev: 0.2,
		camDist: 2.0,          // kpc from origin (2 kpc ≈ a few bright-star distances)
		camFov: 90,            // deg
		// star set
		sourceN: 0,            // 0 = constellations
		birthPositions: null,  // Float64Array N*3, birth frame
		curPositions: null,    // Float64Array N*3, current frame
		packed: null,          // Uint32Array N of packed orbit records (if we need motion)
		count: 0,
		// UI
		mode: 'camera-dist',
		starTimeRate: 0,       // Myr/s, 0 = frozen, -1 = follow (treat as 0 here)
		resolution: 256,
		contours: true,
		grid: false,
		stars: true,
		invert: false,
		// timing
		starTimeMyr: 0,
		lastFrameMs: 0,
		frameMs: 0,
	};

	// ---- galaxy + star set rebuild ----------------------------------------

	function buildModel() {
		state.model = GalaxyLib.createMilkyWay();
		// Non-Milky-Way seeds: use createGalaxy for procedural. But for the
		// first pass we default to Milky Way so constellation landmarks work.
		if (state.seed !== 42) {
			state.model = GalaxyLib.createGalaxy({ type: 'SBb', seed: state.seed });
		}
		rebuildStarSet();
	}

	function rebuildStarSet() {
		const n = state.sourceN;
		const set = (n === 0)
			? Field.buildConstellationSet(state.model, {})
			: Field.buildStarSet(state.model, n, state.seed ^ 0xA5);
		state.count = set._count;
		state.birthPositions = set;
		state.curPositions = new Float64Array(state.count * 3);
		state.curPositions.set(set);
		// For motion we need packed orbit records. Sampled stars don't come
		// with orbit params — create simple zero-orbit records for them so
		// they don't crash engineRecordPosition (they'll stay at birth under
		// classic engine when amplitude is 0, but at time>0 the classic engine
		// applies epicycles; we give them a mild family so motion is visible).
		// Landmarks are FLAG_LANDMARK and don't move under engineRecordPosition
		// (they use engineLandmarkPosition separately), which is what we want —
		// the night-sky anchors stay fixed in the Milky Way preset.
		state.packed = new Uint32Array(state.count);
		const StarRecord = window.StarRecord;
		const isLandmarks = set._source === 'landmarks';
		for (let i = 0; i < state.count; i++) {
			if (isLandmarks) {
				// Use a landmark-compatible packed: no orbit family, flag landmark.
				state.packed[i] = StarRecord.packPacked(
					StarRecord.spectralClassIndex('G'), 4.83,
					StarRecord.FLAG_LANDMARK, 0);
			} else {
				// Visible + epoch-mapped so they flow with the galaxy. Give them
				// a classic thin-disc jitter so the engine displaces them.
				const jitter = 80;  // mid amplitude
				state.packed[i] = StarRecord.packPacked(
					StarRecord.spectralClassIndex('G'), 4.83,
					StarRecord.FLAG_VISIBLE | StarRecord.FLAG_EPOCH, jitter);
			}
		}
	}

	// ---- camera ------------------------------------------------------------

	function cameraVectors() {
		// Place the camera at camDist from origin; look toward origin.
		const ca = state.camAzim, ce = state.camElev;
		// position: spherical around origin
		const cx = state.camDist * Math.cos(ce) * Math.cos(ca);
		const cy = state.camDist * Math.cos(ce) * Math.sin(ca);
		const cz = state.camDist * Math.sin(ce);
		// forward = -normalized(pos) (look at origin)
		const fl = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1;
		return {
			x: cx, y: cy, z: cz,
			fx: -cx / fl, fy: -cy / fl, fz: -cz / fl,
		};
	}

	// ---- main loop ---------------------------------------------------------

	let cachedField = null;  // reused Float32Array
	let cachedW = 0, cachedH = 0;

	function frame(nowMs) {
		requestAnimationFrame(frame);
		const dt = state.lastFrameMs ? Math.min(0.1, (nowMs - state.lastFrameMs) / 1000) : 0;
		state.lastFrameMs = nowMs;

		// advance star time
		if (state.starTimeRate > 0) {
			state.starTimeMyr += dt * state.starTimeRate;
		}

		// integrate orbits if time non-zero and engine on
		if (state.packed && state.starTimeMyr !== 0) {
			Field.integratePositions(state.birthPositions, state.count,
				state.packed, state.starTimeMyr, state.model, state.curPositions);
		} else if (state.curPositions !== state.birthPositions) {
			state.curPositions.set(state.birthPositions);
		}

		// resize canvas to display
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		const iw = Math.floor(canvas.clientWidth * dpr);
		const ih = Math.floor(canvas.clientHeight * dpr);
		if (canvas.width !== iw || canvas.height !== ih) {
			canvas.width = iw; canvas.height = ih;
		}

		// compute field
		const res = state.resolution;
		const cam = cameraVectors();
		let field;
		if (state.mode === 'none') {
			ctx.fillStyle = '#05070d';
			ctx.fillRect(0, 0, canvas.width, canvas.height);
		} else {
			if (cachedW !== res || cachedH !== res || !cachedField) {
				cachedField = new Float32Array(res * res);
				cachedField._w = res; cachedField._h = res;
				cachedW = res; cachedH = res;
			}
			field = cachedField;
			const t0 = performance.now();
			Field.computeField(state.curPositions, state.count, cam, {
				mode: state.mode,
				w: res, h: res,
				fovDeg: state.camFov,
				splatSigma: Math.max(6, Math.round(res / 18)),
				blurRadius: Math.max(2, Math.round(res / 48)),
				blurPasses: 3,
			}, field);
			state.fieldMs = performance.now() - t0;

			// render
			Renderer.renderHeightmap(ctx, field,
				state.stars ? state.curPositions : null,
				cam, {
					mode: state.mode,
					drawContours: state.contours,
					drawGrid: state.grid,
					invert: state.invert,
					fovDeg: state.camFov,
				});
			const label = state.mode === 'camera-dist'
				? `Camera distance  (${state.count} src)`
				: `Depth variance (adjacency, ${state.count} src)`;
			Renderer.renderLegend(ctx, state.mode, label);
		}

		// readout
		const fps = dt > 0 ? (1 / dt).toFixed(0) : '—';
		const rateStr = state.starTimeRate === 0
			? 'frozen'
			: state.starTimeRate < 0
				? 'follow'
				: `${state.starTimeRate.toFixed(1)} Myr/s`;
		const tNow = state.starTimeMyr.toFixed(2);
		const ms = state.fieldMs ? state.fieldMs.toFixed(1) : '—';
		readout.textContent = `mode: ${state.mode}\n`
			+ `source: ${state.sourceN === 0 ? 'constellations (' + state.count + ')' : state.count + ' nearest'}\n`
			+ `star time: ${tNow} Myr  (${rateStr})\n`
			+ `camera: (${cam.x.toFixed(2)}, ${cam.y.toFixed(2)}, ${cam.z.toFixed(2)}) kpc  dist ${state.camDist.toFixed(2)} kpc\n`
			+ `FoV: ${state.camFov}°   resolution: ${res}px\n`
			+ `field compute: ${ms} ms   ${fps} fps`;
	}

	// ---- input (simple orbit drag) ----------------------------------------

	let dragging = false;
	let lastX = 0, lastY = 0;
	canvas.addEventListener('mousedown', (e) => {
		dragging = true; lastX = e.clientX; lastY = e.clientY;
	});
	window.addEventListener('mouseup', () => { dragging = false; });
	window.addEventListener('mousemove', (e) => {
		if (!dragging) return;
		const dx = e.clientX - lastX;
		const dy = e.clientY - lastY;
		lastX = e.clientX; lastY = e.clientY;
		state.camAzim -= dx * 0.005;
		state.camElev = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, state.camElev + dy * 0.005));
	});
	canvas.addEventListener('wheel', (e) => {
		e.preventDefault();
		const factor = Math.exp(e.deltaY * 0.0015);
		state.camDist = Math.max(0.01, Math.min(30, state.camDist * factor));
	}, { passive: false });

	// ---- UI wiring ---------------------------------------------------------

	function bindUI() {

	function bindSlider(id, valId, fmt, onChange) {
		const el = $(id); const vEl = $(valId);
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
		document.querySelectorAll(`input[name="${name}"]`).forEach(r => {
			r.addEventListener('change', () => { if (r.checked) onChange(r.value); });
		});
	}

	bindRadios('view-mode', (v) => { state.mode = v; });
	bindSlider('slider-source', 'val-source',
		(v) => v === 0 ? 'constellations' : `${v | 0} stars`,
		(v) => { state.sourceN = v | 0; rebuildStarSet(); });
	bindSlider('slider-star-time', 'val-star-time',
		(v) => v == 0 ? 'frozen' : v < 0 ? 'follow' : `${v.toFixed(1)} Myr/s`,
		(v) => { state.starTimeRate = v < 0 ? 0 : v; });
	bindSlider('slider-fov', 'val-fov', (v) => `${v | 0}°`, (v) => { state.camFov = v | 0; });
	bindSlider('slider-resolution', 'val-resolution', (v) => `${v | 0}`, (v) => { state.resolution = v | 0; });
	bindCheck('check-contours', (v) => { state.contours = v; });
	bindCheck('check-grid', (v) => { state.grid = v; });
	bindCheck('check-stars', (v) => { state.stars = v; });
	bindCheck('check-invert', (v) => { state.invert = v; });

	$('galaxy-apply').addEventListener('click', () => {
		const s = parseInt($('galaxy-seed').value, 10);
		if (!Number.isFinite(s)) return;
		state.seed = s;
		state.starTimeMyr = 0;
		buildModel();
	});

	}  // close bindUI()

	// ---- boot --------------------------------------------------------------

	function showError(msg) {
		errEl.style.display = 'block';
		errEl.textContent = msg;
		console.error(msg);
	}

	try {
		// Build the galaxy BEFORE wiring UI, so the slider-update callbacks
		// that fire at bindSlider time find a valid state.model.
		buildModel();
		bindUI();
		requestAnimationFrame(frame);
	} catch (e) {
		showError(`boot failed: ${e && e.stack ? e.stack : e}`);
	}
})();
