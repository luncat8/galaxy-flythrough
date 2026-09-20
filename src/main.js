// src/main.js
// Boot: WebGPU device → camera → input → renderer (catalog + procedural) →
// label layer + selection → loop.
//
// Overlay text is rebuilt at 4 Hz, not every frame: the frame loop stays free
// of string building and DOM writes. The label layer is the exception — it
// redraws every frame so labels track their stars while the camera moves.

'use strict';

const OVERLAY_INTERVAL = 0.25;      // s
const MAX_DPR = 2;                  // retinal 3x costs fill rate for no gain

function currentDpr() {
	return Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, MAX_DPR);
}

// Three significant figures, trailing zeros dropped: 8, 0.125, 2050.
function formatSpeed(lyPerSec) {
	return `${Number(lyPerSec.toPrecision(3))} ly/s`;
}

function formatDistance(kpc) {
	return kpc >= 1 ? `${kpc.toFixed(3)} kpc` : `${(kpc * 1000).toFixed(2)} pc`;
}

const FACTOR_LABELS = { 100: 'Shift', 0.1: 'Ctrl', 10: 'Shift+Ctrl' };
function formatFactor(factor) {
	const label = FACTOR_LABELS[factor];
	return label ? `   [${label} x${factor}]` : '';
}

function readParams(search) {
	const params = new URLSearchParams(search === undefined ? window.location.search : search);
	const number = (name, fallback) => {
		const value = params.get(name);
		// An absent or empty parameter means "use the default"; `0` is a
		// deliberate value (e.g. catalog=0 renders procedurally only).
		if (value === null || value.trim() === '') return fallback;
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : fallback;
	};
	return {
		stars: number('stars', window.StarRenderer.PROCEDURAL_STARS_DEFAULT),
		catalogStars: number('catalog', window.StarRenderer.CATALOG_BUDGET_DEFAULT),
		exposure: params.has('exposure') ? number('exposure', window.StarRenderer.EXPOSURE_DEFAULT) : null,
		seed: number('seed', 42),
	};
}

async function boot() {
	const canvas = document.getElementById('canvas');
	const overlay = document.getElementById('overlay');
	const errorBox = document.getElementById('error');
	const params = readParams();

	function showError(message) {
		errorBox.textContent = message;
		errorBox.style.display = 'block';
	}

	function resizeCanvas() {
		const dpr = currentDpr();
		const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
		const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
		if (canvas.width !== width || canvas.height !== height) {
			canvas.width = width;
			canvas.height = height;
		}
	}
	resizeCanvas();
	window.addEventListener('resize', resizeCanvas);

	let device, context, format;
	try {
		({ device, context, format } = await window.Device.initDevice(canvas));
	} catch (err) {
		showError('WebGPU init failed: ' + err.message);
		return;
	}
	window.Device.onLost = (info) => showError(`GPU device lost (${info.reason}): ${info.message}`);

	const camera = window.Camera.createCamera();
	const input = window.Input.createInput(canvas);

	const landmarks = window.Landmarks;
	const labels = window.LabelLayer.createLabelLayer(
		document.getElementById('labels'), landmarks, window.Constellations);
	const selection = window.Selection.createSelection(camera, landmarks);
	let selected = -1;

	const renderer = window.StarRenderer.createStarRenderer(device, context, format, {
		proceduralStars: params.stars,
		catalogBudgetStars: params.catalogStars,
		seed: params.seed,
	});

	// Catalog is optional: without it the procedural field still renders.
	let manifest = null;
	try {
		manifest = await window.TileLoader.loadCatalog('data/tiles/catalog.js');
	} catch (err) {
		console.warn('Catalog tiles unavailable, running procedural-only:', err.message);
	}

	try {
		renderer.prepare(manifest);
	} catch (err) {
		showError('Renderer setup failed: ' + err.message);
		return;
	}
	if (params.exposure !== null) renderer.setExposure(params.exposure);

	const statsText = {
		position: [0, 0, 0],
		velocity: [0, 0, 0],
		orbitTarget: [0, 0, 0],
	};
	let overlayTimer = OVERLAY_INTERVAL;

	function cameraLine(c) {
		if (c.mode === window.Camera.MODE_FLY) {
			return `camera ${c.modeName}   speed ${formatSpeed(c.speedLyPerSec)}  (x${c.speedMult})${formatFactor(c.speedFactor)}`;
		}
		return `camera ${c.modeName}   ${c.targetName}   distance ${formatDistance(c.orbitDistance)}`;
	}

	function selectedLine(cameraState) {
		if (selected < 0 || cameraState.mode !== window.Camera.MODE_FLY) return '';
		return `\nselected ${landmarks.ENTRIES[selected].name}   (C C orbits it)`;
	}

	function updateOverlay(state, cameraState) {
		const shutter = state.magZero.toFixed(1);
		overlay.textContent =
			`FPS ${loop.stats.fps.toFixed(0)}   frame ${loop.stats.avgFrameMs.toFixed(2)}ms (max ${loop.stats.maxFrameMs.toFixed(1)}ms)\n` +
			`stars drawn ${state.drawn.toLocaleString()}  =  procedural ${state.proceduralStars.toLocaleString()}` +
			` + landmarks ${state.landmarkStars.toLocaleString()}` +
			` + catalog ${state.catalogResidentStars.toLocaleString()}/${state.catalogTotalStars.toLocaleString()}\n` +
			`cells ${state.cellsResident}/${state.catalogCells}   decoded ${(state.decodedBytes / 1024).toFixed(0)} KB` +
			`   buffer ${(state.bufferBytes / 1048576).toFixed(1)} MB\n` +
			`exposure magZero ${shutter}   ([ / ] to change)   constellations ${labels.constellationsVisible() ? 'on' : 'off'}   (P)\n` +
			`pos (${cameraState.position[0].toFixed(3)}, ${cameraState.position[1].toFixed(3)}, ${cameraState.position[2].toFixed(3)}) kpc\n` +
			cameraLine(cameraState) +
			selectedLine(cameraState);
	}

	const loop = window.Loop.createLoop((dt, time) => {
		const actions = input.state.actions;
		const resetting = actions.reset;
		camera.step(dt, input.state);
		// R puts the orbit target back on the Sun, so a stale selection would
		// contradict it the next time the user cycles into orbit-object mode.
		if (resetting) {
			selected = -1;
			labels.setSelected(-1);
		}

		if (actions.pick) {
			actions.pick = 0;
			const hit = selection.pick(input.state.pickX, input.state.pickY, canvas.clientWidth, canvas.clientHeight);
			if (hit >= 0) {
				selected = hit;
				const entry = landmarks.ENTRIES[hit];
				camera.setOrbitTarget(entry.x, entry.y, entry.z, entry.name);
				labels.setSelected(hit);
			}
		}
		if (actions.constellations) {
			actions.constellations = 0;
			labels.toggleConstellations();
		}

		resizeCanvas();
		renderer.render(camera, canvas.width, canvas.height, time, input.state);
		labels.resize(canvas.clientWidth, canvas.clientHeight, currentDpr());
		labels.draw(camera, canvas.clientWidth, canvas.clientHeight);

		overlayTimer += dt;
		if (overlayTimer < OVERLAY_INTERVAL) return;
		overlayTimer = 0;
		updateOverlay(renderer.state, camera.getState(statsText));
	});

	loop.start();
	console.log(`Galaxy fly-through ready: ${renderer.state.proceduralStars.toLocaleString()} procedural stars, ` +
		`${renderer.state.landmarkStars} landmarks, ` +
		`${renderer.state.catalogTotalStars.toLocaleString()} catalog stars in ${renderer.state.catalogCells} cells.`);
}

// Node has no document, so requiring this file for its helpers must not boot.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
	window.addEventListener('DOMContentLoaded', boot);
}
if (typeof module !== 'undefined') {
	module.exports = { boot, readParams, formatSpeed, formatDistance, formatFactor, OVERLAY_INTERVAL, MAX_DPR };
}
