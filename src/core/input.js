// src/core/input.js
// Keyboard + mouse input, accumulated into one shared state object.
//
// Look control has two modes and both feed the same `lookDx` / `lookDy`
// accumulators, so the camera code does not care which one is active:
//   * fly: pointer lock on canvas press, drag-look fallback if unavailable
//   * orbit: canvas press-and-drag only, with a visible cursor
//
// Consumers take what they own and leave the rest:
//   * camera   : keys, lookDx/lookDy, wheelDelta, actions.reset/home/cameraMode
//   * renderer : actions.exposure
//   * selection: actions.pick + pickX/pickY, actions.constellations
//
// No allocations in the hot path: listeners write into the shared state, and
// deltas are zeroed by whoever consumed them.

'use strict';

// Wheel deltas arrive in pixels (Chrome mice: 100 per notch), lines (Firefox:
// 3 per notch) or pages, indexed by e.deltaMode. All three are folded into
// pixel units so one notch is 100 for every consumer.
const WHEEL_UNITS_PER_MODE = [1, 100 / 3, 100];
const CLICK_MAX_PX = 4;   // maximum pointer travel for a click rather than a drag
const FORM_TAG = /^(INPUT|SELECT|TEXTAREA)$/;

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
		pickX: 0,
		pickY: 0,
		actions: { reset: 0, home: 0, cameraMode: 0, exposure: 0, linearExposure: 0, constellations: 0, pick: 0, menu: 0, galaxyCycle: 0, freezeTime: 0 },
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
	// modes at the key-repeat rate. Tab toggles the settings menu and must
	// not cycle browser focus, hence preventDefault.
	// G regenerates the galaxy, so it is a one-shot like the other toggles:
	// key repeat would otherwise rebuild a 300k-star field at 30 Hz.
	const pressMap = { KeyR: 'reset', KeyH: 'home', KeyC: 'cameraMode', KeyP: 'constellations', KeyG: 'galaxyCycle', KeyT: 'freezeTime', Tab: 'menu' };
	// Exposure accumulates, so key repeat is one more step per repeat.
	const exposureMap = { BracketLeft: -1, Minus: -1, BracketRight: 1, Equal: 1 };
	// Linear exposure (ACES pre-multiplier) in half-stop steps. ; darker, ' brighter.
	const linearExposureMap = { Semicolon: -1, Quote: 1 };

	// Ignore the first look event after a pointer lock change: browsers report
	// the cursor jump from wherever it was to the centre.
	let flyMode = true;
	let swallowNextMove = false;
	let dragDistance = 0;
	let downX = 0;
	let downY = 0;

	// The settings menu holds form fields, and they must own their keys:
	// a number input has to accept its digits, and a focused slider has to
	// move with the arrows instead of flying the camera. Tab is the one key
	// that still belongs to the menu, because it is how the menu closes.
	function editingField(e) {
		const target = e.target;
		if (!target || !target.tagName) return false;
		return e.code !== 'Tab' && (FORM_TAG.test(target.tagName)
			|| target.tagName === 'BUTTON' || !!target.closest('#menu'));
	}

	function onKeyDown(e) {
		if (editingField(e)) return;
		const held = keyMap[e.code];
		if (held) {
			keys[held] = true;
			e.preventDefault();
			return;
		}
		const press = pressMap[e.code];
		if (press) {
			if (!e.repeat) state.actions[press] = 1;
			e.preventDefault();   // Ctrl+R would reload, Tab would move focus, etc.
			return;
		}
		const exposure = exposureMap[e.code];
		if (exposure) {
			state.actions.exposure += exposure;
			e.preventDefault();
			return;
		}
		const linear = linearExposureMap[e.code];
		if (linear) {
			state.actions.linearExposure += linear;
			e.preventDefault();
		}
	}

	function onKeyUp(e) {
		const held = keyMap[e.code];
		if (!held) return;
		keys[held] = false;
		if (!editingField(e)) e.preventDefault();
	}

	function onMouseDown(e) {
		if (e.button !== 0) return;
		canvas.focus({ preventScroll: true });
		state.dragging = true;
		dragDistance = 0;
		downX = e.clientX;
		downY = e.clientY;
		if (flyMode && !state.pointerLocked && canvas.requestPointerLock) {
			const request = canvas.requestPointerLock();
			// Chrome returns a promise that rejects when the user agent denies
			// the lock; drag-look keeps working either way.
			if (request && request.catch) request.catch(() => {});
		}
	}

	function onMouseUp(e) {
		if (e.button !== 0 || !state.dragging) return;
		state.dragging = false;
		if (e.target !== canvas || dragDistance > CLICK_MAX_PX) return;
		const dx = e.clientX - downX;
		const dy = e.clientY - downY;
		if (!state.pointerLocked && dx * dx + dy * dy > CLICK_MAX_PX * CLICK_MAX_PX) return;
		// A click without drag picks a landmark. Under pointer lock the client
		// coordinates are frozen at the lock point, so pick from the canvas
		// centre — where the camera is aiming.
		state.actions.pick = 1;
		if (state.pointerLocked) {
			state.pickX = canvas.clientWidth * 0.5;
			state.pickY = canvas.clientHeight * 0.5;
		} else {
			const rect = canvas.getBoundingClientRect();
			state.pickX = e.clientX - rect.left;
			state.pickY = e.clientY - rect.top;
		}
	}

	function onMouseMove(e) {
		if (!state.pointerLocked && (!state.dragging || e.target !== canvas)) return;
		if (swallowNextMove) {
			swallowNextMove = false;
			return;
		}
		if (state.dragging) dragDistance += Math.hypot(e.movementX, e.movementY);
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
		state.actions.pick = 0;
	}

	function setFlyMode(enabled) {
		if (flyMode === enabled) return;
		flyMode = enabled;
		releaseAll();
		if (!flyMode && document.pointerLockElement === canvas) {
			document.exitPointerLock();
			state.pointerLocked = false;
			swallowNextMove = false;
		}
	}

	function onFocusIn(e) {
		if (e.target !== canvas) releaseAll();
	}

	function onBlur() {
		releaseAll();
	}

	function onPointerLockChange() {
		state.pointerLocked = document.pointerLockElement === canvas;
		// A pending fly-mode request may resolve after the camera switched to orbit.
		if (state.pointerLocked && !flyMode) {
			document.exitPointerLock();
			state.pointerLocked = false;
		}
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
	window.addEventListener('focusin', onFocusIn);
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
		window.removeEventListener('focusin', onFocusIn);
		canvas.removeEventListener('contextmenu', onContextMenu);
		document.removeEventListener('pointerlockchange', onPointerLockChange);
	}

	return { state, setFlyMode, releaseAll, dispose };
}

const Input = { createInput, WHEEL_UNITS_PER_MODE, FORM_TAG };
if (typeof module !== 'undefined') module.exports = Input;
if (typeof window !== 'undefined') window.Input = Input;
