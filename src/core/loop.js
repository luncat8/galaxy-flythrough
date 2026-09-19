// src/core/loop.js
// Frame loop with fixed dt and timing overlay.
// No allocations in the hot path: reuses preallocated buffers.

'use strict';

function createLoop(callback) {
	let running = false;
	let lastTime = 0;
	let rafId = 0;

	// Preallocated stats object — mutated in place per frame
	const stats = {
		fps: 0,
		frameMs: 0,
		frames: 0,
		avgFrameMs: 0,
		maxFrameMs: 0,
	};

	// Rolling FPS counter
	let fpsAccum = 0;
	let fpsFrames = 0;
	let fpsLastUpdate = 0;
	// Rolling max (last 60 frames)
	const frameMsHistory = new Float32Array(60);
	let historyIdx = 0;

	function frame(now) {
		if (!running) return;
		// Convert to seconds
		const dt = Math.min(0.1, (now - lastTime) / 1000);
		lastTime = now;

		const t0 = performance.now();
		callback(dt, now / 1000);
		const frameMs = performance.now() - t0;

		// FPS
		fpsAccum += dt;
		fpsFrames++;
		if (now / 1000 - fpsLastUpdate >= 0.5) {
			stats.fps = fpsFrames / fpsAccum;
			fpsAccum = 0;
			fpsFrames = 0;
			fpsLastUpdate = now / 1000;
		}
		// Frame ms
		stats.frameMs = frameMs;
		frameMsHistory[historyIdx] = frameMs;
		historyIdx = (historyIdx + 1) % frameMsHistory.length;
		let sum = 0, max = 0;
		for (let i = 0; i < frameMsHistory.length; i++) {
			sum += frameMsHistory[i];
			if (frameMsHistory[i] > max) max = frameMsHistory[i];
		}
		stats.avgFrameMs = sum / frameMsHistory.length;
		stats.maxFrameMs = max;
		stats.frames++;

		rafId = requestAnimationFrame(frame);
	}

	function start() {
		if (running) return;
		running = true;
		lastTime = performance.now();
		fpsLastUpdate = lastTime / 1000;
		rafId = requestAnimationFrame(frame);
	}

	function stop() {
		running = false;
		if (rafId) cancelAnimationFrame(rafId);
	}

	return { start, stop, stats };
}

if (typeof module !== 'undefined') {
	module.exports = { createLoop };
}
if (typeof window !== 'undefined') {
	window.Loop = { createLoop };
}
