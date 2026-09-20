// src/core/input.js
// Keyboard + mouse input, accumulated into one shared state object.
//
// Look control has two modes and both feed the same `lookDx` / `lookDy`
// accumulators, so the camera code does not care which one is active:
//   * pointer lock (click the canvas) — free look, cursor hidden
//   * click-drag — fallback when pointer lock is unavailable (e.g. some
//     file:// contexts), and the only mode that works on trackpads with no
//     left button held
//
// Consumers take what they own and leave the rest:
//   * camera  : keys, lookDx/lookDy, wheelDelta, actions.reset
//   * renderer: actions.exposure
//
// No allocations in the hot path: listeners write into the shared state, and
// deltas are zeroed by whoever consumed them.

'use strict';

function createInput(canvas) {
	const keys = {
		forward: false, back: false, left: false, right: false,
		up: false, down: false, boost: false,
	};
	const state = {
		keys,
		lookDx: 0,
		lookDy: 0,
		wheelDelta: 0,
		dragging: false,
		pointerLocked: false,
		actions: { reset: 0, exposure: 0 },
	};

	const keyMap = {
		KeyW: 'forward', ArrowUp: 'forward',
		KeyS: 'back', ArrowDown: 'back',
		KeyD: 'right', ArrowRight: 'right',
		KeyA: 'left', ArrowLeft: 'left',
		KeyE: 'up', KeyQ: 'down',
	};

	// Ignore the first look event after a pointer lock change: browsers report
	// the cursor jump from wherever it was to the centre.
	let swallowNextMove = false;

	function onKeyDown(e) {
		const k = keyMap[e.code];
		if (k) {
			keys[k] = true;
			e.preventDefault();
			return;
		}
		if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') keys.boost = true;
		if (e.code === 'KeyR') state.actions.reset = 1;
		if (e.code === 'BracketLeft' || e.code === 'Minus') state.actions.exposure = -1;
		if (e.code === 'BracketRight' || e.code === 'Equal') state.actions.exposure = 1;
	}

	function onKeyUp(e) {
		const k = keyMap[e.code];
		if (k) {
			keys[k] = false;
			e.preventDefault();
		}
		if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') keys.boost = false;
	}

	function onMouseDown(e) {
		if (e.button !== 0) return;
		state.dragging = true;
		if (!state.pointerLocked && canvas.requestPointerLock) {
			const request = canvas.requestPointerLock();
			// Chrome returns a promise that rejects when the user agent denies
			// the lock; drag-look keeps working either way.
			if (request && request.catch) request.catch(() => {});
		}
	}

	function onMouseUp(e) {
		if (e.button === 0) state.dragging = false;
	}

	function onMouseMove(e) {
		if (!state.pointerLocked && !state.dragging) return;
		if (swallowNextMove) {
			swallowNextMove = false;
			return;
		}
		state.lookDx += e.movementX;
		state.lookDy += e.movementY;
	}

	function onWheel(e) {
		state.wheelDelta += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
		e.preventDefault();
	}

	// Releasing outside the window or switching tabs must not leave keys stuck.
	function releaseAll() {
		for (const k of Object.keys(keys)) keys[k] = false;
		state.dragging = false;
		state.lookDx = 0;
		state.lookDy = 0;
		state.wheelDelta = 0;
	}

	function onBlur() {
		releaseAll();
	}

	function onPointerLockChange() {
		state.pointerLocked = document.pointerLockElement === canvas;
		swallowNextMove = state.pointerLocked;
		if (!state.pointerLocked) releaseAll();
	}

	function onContextMenu(e) {
		e.preventDefault();
	}

	window.addEventListener('keydown', onKeyDown);
	window.addEventListener('keyup', onKeyUp);
	canvas.addEventListener('mousedown', onMouseDown);
	window.addEventListener('mouseup', onMouseUp);
	window.addEventListener('mousemove', onMouseMove);
	canvas.addEventListener('wheel', onWheel, { passive: false });
	window.addEventListener('blur', onBlur);
	canvas.addEventListener('contextmenu', onContextMenu);
	document.addEventListener('pointerlockchange', onPointerLockChange);

	canvas.tabIndex = 0;

	function dispose() {
		window.removeEventListener('keydown', onKeyDown);
		window.removeEventListener('keyup', onKeyUp);
		canvas.removeEventListener('mousedown', onMouseDown);
		window.removeEventListener('mouseup', onMouseUp);
		window.removeEventListener('mousemove', onMouseMove);
		canvas.removeEventListener('wheel', onWheel);
		window.removeEventListener('blur', onBlur);
		canvas.removeEventListener('contextmenu', onContextMenu);
		document.removeEventListener('pointerlockchange', onPointerLockChange);
	}

	return { state, releaseAll, dispose };
}

const Input = { createInput };
if (typeof module !== 'undefined') module.exports = Input;
if (typeof window !== 'undefined') window.Input = Input;
