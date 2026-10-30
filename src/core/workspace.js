// src/core/workspace.js
// The three workspaces (workspace-plan.md): observe (the sky), fly (a ship),
// command (the colony network). One state, one panel table, pure transitions —
// no DOM, no dependencies; main.js owns the live record and the one writer.

'use strict';

const OBSERVE = 0, FLY = 1, COMMAND = 2;
const NAMES = ['observe', 'fly', 'command'];

// Panels as bits. The bit order is append-only: a workspace's override is a
// mask in localStorage, so a new panel takes the next bit and never renumbers
// one already on a user's disk. The DOM order is the columns' business.
const SEARCH = 0, FLIGHT = 1, ROUTES = 2, VIEWMODES = 3, DISPLAY = 4, TRADE = 5, CONTROLS = 6, SCENARIO = 7, TIME = 8;
const PANEL_COUNT = 9;
const PANEL_MASK_ALL = (1 << PANEL_COUNT) - 1;
const PANEL_IDS = ['selection-menu', 'sysmenu', 'routemenu', 'viewmenu', 'menu', 'trade-menu', 'help', 'scenario-menu', 'time-menu'];
const PANEL_LABELS = ['Search & Selection', 'Flight', 'System & routes', 'View modes', 'Display', 'Trade', 'Controls', 'Formation checks', 'Time'];

function panelBit(panel) {
	return panel >= 0 && panel < PANEL_COUNT ? 1 << panel : 0;
}

// Each workspace's default panel set (workspace-plan.md §5.1).
const MODE_PANELS = [
	panelBit(SEARCH) | panelBit(ROUTES) | panelBit(VIEWMODES) | panelBit(DISPLAY) | panelBit(CONTROLS) | panelBit(SCENARIO) | panelBit(TIME),
	panelBit(FLIGHT) | panelBit(CONTROLS),
	panelBit(SEARCH) | panelBit(ROUTES) | panelBit(TRADE) | panelBit(CONTROLS) | panelBit(TIME),
];

function modeFromName(name) {
	return NAMES.indexOf(String(name || ''));
}

function modeName(mode) {
	return mode >= 0 && mode < NAMES.length ? NAMES[mode] : '';
}

function panelsFor(mode) {
	return mode >= 0 && mode < MODE_PANELS.length ? MODE_PANELS[mode] : MODE_PANELS[OBSERVE];
}

// A stale localStorage value can never invent a panel.
function sanitiseMask(mask) {
	return (mask | 0) & PANEL_MASK_ALL;
}

// The storage a live override lives in. It has to be at least PANEL_COUNT bits
// wide, or a new panel's bit is silently dropped the moment it is written: the
// page used to keep the mask in a Uint8Array, so bit 8 (the Time panel) became
// 0 the instant any checkbox was pressed and the panel could never be switched
// back on. The width is named here, next to the mask it stores, so a tenth
// panel widens the store rather than breaking it again.
const MASK_STORE_BITS = 16;
function createMaskStore(workspaces) {
	// The one guard against the bug above: a mask that does not fit its store
	// is a panel the user can never see.
	if (PANEL_COUNT > MASK_STORE_BITS) throw new Error('panel mask store too narrow');
	return new Uint16Array(workspaces);
}

function applyOverride(mode, mask, panel, on) {
	const bit = panelBit(panel);
	if (!bit) return sanitiseMask(mask);
	return sanitiseMask(on ? (mask | bit) : (mask & ~bit));
}

// The visible set: a user override is authoritative; an open view only adds
// its panel to the mode's own set (§5.3).
function visibleMask(mode, frozen, override, autoShow) {
	return sanitiseMask(frozen ? override : panelsFor(mode) | (autoShow | 0));
}

// g's one behaviour: enter fly, or leave it for the workspace it came from.
function toggleFly(current, last) {
	if (current !== FLY) return FLY;
	return last >= 0 && last < NAMES.length && last !== FLY ? last : OBSERVE;
}

const Workspace = {
	OBSERVE, FLY, COMMAND, NAMES,
	SEARCH, FLIGHT, ROUTES, VIEWMODES, DISPLAY, TRADE, CONTROLS, SCENARIO, TIME,
	PANEL_COUNT, PANEL_MASK_ALL, PANEL_IDS, PANEL_LABELS, MODE_PANELS, MASK_STORE_BITS,
	panelBit, modeFromName, modeName, panelsFor, sanitiseMask,
	applyOverride, visibleMask, toggleFly, createMaskStore,
};
if (typeof module !== 'undefined') module.exports = Workspace;
if (typeof window !== 'undefined') window.Workspace = Workspace;
