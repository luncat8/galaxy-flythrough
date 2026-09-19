// src/core/input.js
// Keyboard + mouse input handler.
// No allocations in the hot path: mutates a single shared state object.

'use strict';

function createInput(canvas) {
	const keys = { w: false, a: false, s: false, d: false, e: false, q: false };
	const state = {
		keys,
		mouseDown: false,
		mouseDx: 0,
		mouseDy: 0,
		scrollDelta: 0,
	};

	const keyMap = {
		'KeyW': 'w', 'KeyA': 'a', 'KeyS': 's', 'KeyD': 'd',
		'KeyE': 'e', 'KeyQ': 'q',
		// Arrow keys map to WASD for convenience
		'ArrowUp': 'w', 'ArrowDown': 's',
		'ArrowLeft': 'a', 'ArrowRight': 'd',
	};

	function onKeyDown(e) {
		const k = keyMap[e.code];
		if (k) { keys[k] = true; e.preventDefault(); }
	}
	function onKeyUp(e) {
		const k = keyMap[e.code];
		if (k) { keys[k] = false; e.preventDefault(); }
	}
	function onMouseDown(e) {
		if (e.button === 0) { state.mouseDown = true; }
	}
	function onMouseUp(e) {
		if (e.button === 0) { state.mouseDown = false; }
	}
	function onMouseMove(e) {
		if (state.mouseDown) {
			state.mouseDx += e.movementX;
			state.mouseDy += e.movementY;
		}
	}
	function onWheel(e) {
		state.scrollDelta += e.deltaY;
		e.preventDefault();
	}
	function onBlur() {
		// Reset everything on blur to avoid stuck keys
		Object.keys(keys).forEach(k => keys[k] = false);
		state.mouseDown = false;
		state.mouseDx = 0;
		state.mouseDy = 0;
		state.scrollDelta = 0;
	}

	// Attach listeners
	window.addEventListener('keydown', onKeyDown);
	window.addEventListener('keyup', onKeyUp);
	canvas.addEventListener('mousedown', onMouseDown);
	window.addEventListener('mouseup', onMouseUp);
	window.addEventListener('mousemove', onMouseMove);
	canvas.addEventListener('wheel', onWheel, { passive: false });
	window.addEventListener('blur', onBlur);

	// Allow canvas to capture focus for keyboard
	canvas.tabIndex = 0;

	function dispose() {
		window.removeEventListener('keydown', onKeyDown);
		window.removeEventListener('keyup', onKeyUp);
		canvas.removeEventListener('mousedown', onMouseDown);
		window.removeEventListener('mouseup', onMouseUp);
		window.removeEventListener('mousemove', onMouseMove);
		canvas.removeEventListener('wheel', onWheel);
		window.removeEventListener('blur', onBlur);
	}

	return { state, dispose };
}

if (typeof module !== 'undefined') {
	module.exports = { createInput };
}
if (typeof window !== 'undefined') {
	window.Input = { createInput };
}
