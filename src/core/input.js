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
//   * camera  : keys, lookDx/lookDy, wheelDelta, actions.reset/home/cameraMode
//   * renderer: actions.exposure
//
// No allocations in the hot path: listeners write into the shared state, and
// deltas are zeroed by whoever consumed them.

'use strict';

// Wheel deltas arrive in pixels (Chrome mice: 100 per notch), lines (Firefox:
// 3 per notch) or pages, indexed by e.deltaMode. All three are folded into
// pixel units so one notch is 100 for every consumer.
const WHEEL_UNITS_PER_MODE = [1, 100 / 3, 100];

function createInput(canvas) {
	const keys = {
		forward: false, back: false, left: false, right: false,
		up: false, down: false, boost: false, slow: false,
	};
	const state = {
		keys,
		lookDx: 0,
		lookDy: 0,
		wheelDelta: 0,
		dragging: false,
		pointerLocked: false,
		actions: { reset: 0, home: 0, cameraMode: 0, exposure: 0 },
	};

	// Held keys: true while down. Ctrl is the brief's slow modifier; Ctrl+W
	// closes the tab on Windows/Linux and no page can prevent it, so the arrow
	// keys double as the safe way to fly slowly.
	const keyMap = {
		KeyW: 'forward', ArrowUp: 'forward',
		KeyS: 'back', ArrowDown: 'back',
		KeyD: 'right', ArrowRight: 'right',
		KeyA: 'left', ArrowLeft: 'left',
		KeyE: 'up', KeyQ: 'down',
		ShiftLeft: 'boost', ShiftRight: 'boost',
		ControlLeft: 'slow', ControlRight: 'slow',
	};
	// One-shot actions fire on the press only: a held C must not cycle camera
	// modes at the key-repeat rate.
	const pressMap = { KeyR: 'reset', KeyH: 'home', KeyC: 'cameraMode' };
	// Exposure accumulates, so key repeat is one more step per repeat.
	const exposureMap = { BracketLeft: -1, Minus: -1, BracketRight: 1, Equal: 1 };

	// Ignore the first look event after a pointer lock change: browsers report
	// the cursor jump from wherever it was to the centre.
	let swallowNextMove = false;

	function onKeyDown(e) {
		const held = keyMap[e.code];
		if (held) {
			keys[held] = true;
			e.preventDefault();
			return;
		}
		const press = pressMap[e.code];
		if (press) {
			if (!e.repeat) state.actions[press] = 1;
			e.preventDefault();   // Ctrl+R would reload, Ctrl+H would open history
			return;
		}
		const exposure = exposureMap[e.code];
		if (exposure) {
			state.actions.exposure += exposure;
			e.preventDefault();
		}
	}

	function onKeyUp(e) {
		const held = keyMap[e.code];
		if (!held) return;
		keys[held] = false;
		e.preventDefault();
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
		state.wheelDelta += e.deltaY * (WHEEL_UNITS_PER_MODE[e.deltaMode] || 1);
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

const Input = { createInput, WHEEL_UNITS_PER_MODE };
if (typeof module !== 'undefined') module.exports = Input;
if (typeof window !== 'undefined') window.Input = Input;
