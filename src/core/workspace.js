// src/core/workspace.js
// The three workspaces (workspace-plan.md): observe (the sky), fly (a ship),
// command (the colony network). One state, one panel table, pure transitions —
// no DOM, no dependencies; main.js owns the live record and the one writer.

'use strict';

const OBSERVE = 0, FLY = 1, COMMAND = 2;
const NAMES = ['observe', 'fly', 'command'];

// Panels as bits. The order is the load order in index.html, nothing else.
const SEARCH = 0, FLIGHT = 1, ROUTES = 2, VIEWMODES = 3, DISPLAY = 4, TRADE = 5, CONTROLS = 6;
const PANEL_COUNT = 7;
const PANEL_MASK_ALL = (1 << PANEL_COUNT) - 1;
const PANEL_IDS = ['selection-menu', 'sysmenu', 'routemenu', 'viewmenu', 'menu', 'trade-menu', 'help'];
const PANEL_LABELS = ['Search & Selection', 'Flight', 'System & routes', 'View modes', 'Display', 'Trade', 'Controls'];

function panelBit(panel) {
	return panel >= 0 && panel < PANEL_COUNT ? 1 << panel : 0;
}

// Each workspace's default panel set (workspace-plan.md §5.1).
const MODE_PANELS = [
	panelBit(SEARCH) | panelBit(ROUTES) | panelBit(VIEWMODES) | panelBit(DISPLAY) | panelBit(CONTROLS),
	panelBit(FLIGHT) | panelBit(CONTROLS),
	panelBit(SEARCH) | panelBit(ROUTES) | panelBit(TRADE) | panelBit(CONTROLS),
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
	SEARCH, FLIGHT, ROUTES, VIEWMODES, DISPLAY, TRADE, CONTROLS,
	PANEL_COUNT, PANEL_MASK_ALL, PANEL_IDS, PANEL_LABELS, MODE_PANELS,
	panelBit, modeFromName, modeName, panelsFor, sanitiseMask,
	applyOverride, visibleMask, toggleFly,
};
if (typeof module !== 'undefined') module.exports = Workspace;
if (typeof window !== 'undefined') window.Workspace = Workspace;
