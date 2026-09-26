// DOM-event regressions for mode-aware look, menu isolation and picking.
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { createInput } = require('../src/core/input.js');
const Camera = require('../src/core/camera.js');
const checks = [];
function check(name, test) {
	try { test(); checks.push({ name, pass: true }); }
	catch (error) { checks.push({ name, pass: false, detail: error.message }); }
}

class Target {
	constructor(tagName, parent = null) {
		this.tagName = tagName;
		this.parent = parent;
		this.listeners = new Map();
	}
	addEventListener(type, fn) {
		if (!this.listeners.has(type)) this.listeners.set(type, new Set());
		this.listeners.get(type).add(fn);
	}
	removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
	closest(selector) {
		return selector === '#menu' && this.inMenu ? this : null;
	}
	emit(type, fields = {}) {
		const event = { target: this, button: 0, clientX: 110, clientY: 220,
			movementX: 0, movementY: 0, deltaY: 100, deltaMode: 0, repeat: false,
			preventDefault() { this.defaultPrevented = true; }, ...fields };
		for (let node = this; node; node = node.parent) {
			for (const fn of node.listeners.get(type) || []) fn(event);
		}
		return event;
	}
}

global.window = new Target();
global.document = new Target();
const canvas = new Target('CANVAS', window);
canvas.clientWidth = 800;
canvas.clientHeight = 600;
canvas.getBoundingClientRect = () => ({ left: 10, top: 20 });
canvas.focus = () => canvas.emit('focusin');
let lockRequests = 0;
let unlockRequests = 0;
canvas.requestPointerLock = () => { lockRequests++; };
document.exitPointerLock = () => { unlockRequests++; document.pointerLockElement = null; };
function lockChanged(locked) {
	document.pointerLockElement = locked ? canvas : null;
	document.emit('pointerlockchange');
}
const slider = new Target('INPUT', window);
slider.inMenu = true;
const button = new Target('BUTTON', window);
button.inMenu = true;
const panel = new Target('DIV', window);
panel.inMenu = true;
const input = createInput(canvas);
const state = input.state;
input.setFlyMode(false);

check('orbit hover does not look or request pointer lock', () => {
	canvas.emit('mousemove', { movementX: 12 });
	assert.equal(state.lookDx, 0);
	assert.equal(lockRequests, 0);
});
check('orbit canvas drag looks without locking, and returning to origin is not a pick', () => {
	canvas.emit('mousedown');
	canvas.emit('mousemove', { movementX: 12, movementY: -6 });
	assert.equal(state.lookDx, 12);
	assert.equal(state.lookDy, -6);
	assert.equal(lockRequests, 0);
	canvas.emit('mouseup');
	assert.equal(state.dragging, false);
	assert.equal(state.actions.pick, 0);
	input.releaseAll();
});
check('canvas click picks in canvas-local CSS coordinates', () => {
	canvas.emit('mousedown');
	canvas.emit('mouseup');
	assert.equal(state.actions.pick, 1);
	assert.equal(state.pickX, 100);
	assert.equal(state.pickY, 200);
	input.releaseAll();
});
check('menu clicks, slider drags and scrolling never look, zoom or pick', () => {
	for (const target of [slider, button, panel]) {
		target.emit('mousedown');
		target.emit('mousemove', { movementX: 30 });
		target.emit('mouseup');
		assert.equal(target.emit('wheel').defaultPrevented, undefined);
	}
	assert.equal(state.lookDx, 0);
	assert.equal(state.wheelDelta, 0);
	assert.equal(state.actions.pick, 0);
	assert.equal(state.dragging, false);
});
check('a menu press followed by canvas release cannot select', () => {
	slider.emit('mousedown');
	canvas.emit('mouseup');
	assert.equal(state.actions.pick, 0);
});
check('dragging over the menu and releasing there cannot look or pick', () => {
	canvas.emit('mousedown');
	slider.emit('mousemove', { movementX: 40 });
	slider.emit('mouseup');
	canvas.emit('mousemove', { movementX: 40 });
	assert.equal(state.lookDx, 0);
	assert.equal(state.dragging, false);
	assert.equal(state.actions.pick, 0);
});
check('wheel zoom is canvas-only and normalizes line units', () => {
	assert.equal(canvas.emit('wheel', { deltaY: 3, deltaMode: 1 }).defaultPrevented, true);
	assert.equal(state.wheelDelta, 100);
	input.releaseAll();
});
check('menu controls own keyboard input except Tab', () => {
	for (const target of [slider, button, panel]) {
		assert.equal(target.emit('keydown', { code: 'ArrowUp' }).defaultPrevented, undefined);
		target.emit('keydown', { code: 'KeyC' });
		target.emit('keydown', { code: 'BracketRight' });
	}
	assert.equal(state.keys.forward, false);
	assert.equal(state.actions.cameraMode, 0);
	assert.equal(state.actions.exposure, 0);
	assert.equal(slider.emit('keydown', { code: 'Tab' }).defaultPrevented, true);
	assert.equal(state.actions.menu, 1);
	state.actions.menu = 0;
});
check('UI focus cancels held keys and drag; keyup in a field never leaves a stuck key', () => {
	canvas.emit('keydown', { code: 'KeyW' });
	canvas.emit('mousedown');
	slider.emit('focusin');
	assert.equal(state.keys.forward, false);
	assert.equal(state.dragging, false);
	canvas.emit('keydown', { code: 'KeyW' });
	assert.equal(slider.emit('keyup', { code: 'KeyW' }).defaultPrevented, undefined);
	assert.equal(state.keys.forward, false);
});
check('fly mode locks on press and keeps free-look after release', () => {
	input.setFlyMode(true);
	assert.equal(lockRequests, 0);
	canvas.emit('mousedown');
	assert.equal(lockRequests, 1);
	lockChanged(true);
	canvas.emit('mousemove', { movementX: 999 });
	assert.equal(state.lookDx, 0); // synthetic lock transition is swallowed
	canvas.emit('mouseup');
	assert.equal(state.actions.pick, 1);
	assert.equal(state.pickX, 400);
	assert.equal(state.pickY, 300);
	canvas.emit('mousemove', { movementX: 8 });
	assert.equal(state.lookDx, 8);
});
check('Escape/native unlock clears look and drag state', () => {
	lockChanged(false);
	assert.equal(state.pointerLocked, false);
	assert.equal(state.lookDx, 0);
	canvas.emit('mousemove', { movementX: 8 });
	assert.equal(state.lookDx, 0);
});
check('fly-to-orbit releases lock and cancels pending input', () => {
	lockChanged(true);
	canvas.emit('keydown', { code: 'KeyW' });
	input.setFlyMode(false);
	assert.equal(unlockRequests, 1);
	assert.equal(state.pointerLocked, false);
	lockChanged(false);
	assert.equal(state.keys.forward, false);
	assert.equal(state.lookDx, 0);
	assert.equal(state.actions.pick, 0);
});
check('late pointer-lock success is rejected in orbit mode', () => {
	lockChanged(true);
	assert.equal(unlockRequests, 2);
	assert.equal(state.pointerLocked, false);
	canvas.emit('mousemove', { movementX: 8 });
	assert.equal(state.lookDx, 0);
});
check('fly still supports drag-look without pointer lock', () => {
	input.setFlyMode(true);
	canvas.requestPointerLock = undefined;
	canvas.emit('mousedown');
	canvas.emit('mousemove', { movementX: 8 });
	assert.equal(state.lookDx, 8);
	window.emit('blur');
	assert.equal(state.lookDx, 0);
	assert.equal(state.dragging, false);
});
check('both orbit camera modes accept canvas drags without locking', () => {
	const camera = Camera.createCamera();
	for (const mode of [Camera.MODE_ORBIT_GC, Camera.MODE_ORBIT_OBJECT]) {
		camera.setMode(mode);
		input.setFlyMode(camera.getState().mode === Camera.MODE_FLY);
		const before = camera.getState().orientation;
		canvas.emit('mousedown');
		canvas.emit('mousemove', { movementX: 20 });
		camera.step(1 / 60, state);
		assert.notDeepEqual(camera.getState().orientation, before);
		assert.equal(state.pointerLocked, false);
		canvas.emit('mouseup');
	}
});
check('dispose removes all installed event listeners', () => {
	input.releaseAll();
	input.dispose();
	canvas.emit('mousedown');
	canvas.emit('keydown', { code: 'KeyW' });
	canvas.emit('wheel');
	assert.equal(state.dragging, false);
	assert.equal(state.keys.forward, false);
	assert.equal(state.wheelDelta, 0);
	for (const target of [window, document, canvas]) {
		for (const listeners of target.listeners.values()) assert.equal(listeners.size, 0);
	}
});

const failed = checks.filter(c => !c.pass).length;
for (const c of checks) console.log(`${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.detail ? ': ' + c.detail : ''}`);
console.log(`\n${checks.length - failed}/${checks.length} passed`);
fs.writeFileSync(path.join(__dirname, 'logs/input.json'), JSON.stringify({ checks, failed }, null, 2) + '\n');
process.exitCode = failed ? 1 : 0;
