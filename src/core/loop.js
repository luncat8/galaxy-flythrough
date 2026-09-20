// src/core/loop.js
// requestAnimationFrame loop + rolling frame statistics.
//
// The stats (fps, frame ms, average, max) are read by the overlay and by the
// tuning decisions in plan.md, so they are kept in one preallocated object and
// updated in place: no allocation, no array churn, no GC hitches.

'use strict';

const MAX_DT = 0.1;          // s, clamp after tab switches / long stalls
const HISTORY = 60;          // frames in the rolling window

function createLoop(callback) {
	let running = false;
	let lastTime = 0;
	let rafId = 0;

	const stats = {
		fps: 0,
		dt: 0,
		frameMs: 0,
		avgFrameMs: 0,
		maxFrameMs: 0,
		frames: 0,
	};

	const history = new Float32Array(HISTORY);
	let historyIdx = 0;
	let historySum = 0;
	let historyFilled = 0;

	let fpsAccum = 0;
	let fpsFrames = 0;

	function frame(now) {
		if (!running) return;
		const dt = Math.min(MAX_DT, Math.max(0, (now - lastTime) / 1000));
		lastTime = now;

		const t0 = performance.now();
		callback(dt, now / 1000);
		const frameMs = performance.now() - t0;

		fpsAccum += dt;
		fpsFrames++;
		if (fpsAccum >= 0.5) {
			stats.fps = fpsFrames / fpsAccum;
			fpsAccum = 0;
			fpsFrames = 0;
		}

		// Rolling window with a running sum: O(1) per frame instead of O(60).
		historySum -= history[historyIdx];
		history[historyIdx] = frameMs;
		historySum += frameMs;
		historyIdx = (historyIdx + 1) % HISTORY;
		if (historyFilled < HISTORY) historyFilled++;

		stats.dt = dt;
		stats.frameMs = frameMs;
		stats.avgFrameMs = historySum / historyFilled;
		stats.maxFrameMs = 0;
		for (let i = 0; i < historyFilled; i++) {
			if (history[i] > stats.maxFrameMs) stats.maxFrameMs = history[i];
		}
		stats.frames++;

		rafId = requestAnimationFrame(frame);
	}

	function start() {
		if (running) return;
		running = true;
		lastTime = performance.now();
		fpsAccum = 0;
		fpsFrames = 0;
		rafId = requestAnimationFrame(frame);
	}

	function stop() {
		running = false;
		if (rafId) cancelAnimationFrame(rafId);
		rafId = 0;
	}

	return { start, stop, stats, isRunning: () => running };
}

const Loop = { createLoop, MAX_DT, HISTORY };
if (typeof module !== 'undefined') module.exports = Loop;
if (typeof window !== 'undefined') window.Loop = Loop;
