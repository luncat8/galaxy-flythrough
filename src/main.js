// src/main.js
// Boot: WebGPU device → camera → input → renderer → loop.

'use strict';

async function boot() {
	const canvas = document.getElementById('canvas');
	const overlay = document.getElementById('overlay');
	const errorBox = document.getElementById('error');

	// Resize canvas to display
	function resizeCanvas() {
		const dpr = window.devicePixelRatio || 1;
		const w = canvas.clientWidth * dpr;
		const h = canvas.clientHeight * dpr;
		if (canvas.width !== w || canvas.height !== h) {
			canvas.width = w;
			canvas.height = h;
		}
	}
	resizeCanvas();
	window.addEventListener('resize', resizeCanvas);

	// --- Init WebGPU ---
	let device, context, format;
	try {
		({ device, context, format } = await window.Device.initDevice(canvas));
	} catch (err) {
		errorBox.textContent = 'WebGPU init failed: ' + err.message;
		errorBox.style.display = 'block';
		return;
	}

	// --- Camera + input ---
	const camera = window.Camera.createCamera();
	const input = window.Input.createInput(canvas);

	// --- Renderer ---
	const renderer = window.StarDistantRenderer.createStarDistantRenderer(device, context, format);
	renderer.generateStars();

	// --- Frame loop ---
	const loop = window.Loop.createLoop((dt, time) => {
		camera.step(dt, input.state);
		resizeCanvas();
		renderer.render(camera, canvas.width, canvas.height, time);

		// Update overlay
		const s = loop.stats;
		overlay.textContent =
			`FPS: ${s.fps.toFixed(1)}\n` +
			`frame: ${s.frameMs.toFixed(2)}ms (avg ${s.avgFrameMs.toFixed(2)} / max ${s.maxFrameMs.toFixed(2)})\n` +
			`stars: ${window.StarDistantRenderer.TEST_N.toLocaleString()}\n` +
			`pos: (${camera.getState().position[0].toFixed(3)}, ${camera.getState().position[1].toFixed(3)}, ${camera.getState().position[2].toFixed(3)}) kpc\n` +
			`speed: x${camera.getState().speedMult.toFixed(2)} (${(0.010 * camera.getState().speedMult).toFixed(4)} kpc/s)`;
	});

	loop.start();
	console.log('Galaxy fly-through started. WASD to move, mouse drag to look, scroll to adjust speed.');
}

if (typeof window !== 'undefined') {
	window.addEventListener('DOMContentLoaded', boot);
}
