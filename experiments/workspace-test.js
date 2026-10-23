// experiments/workspace-test.js
// The workspace table and its pure transitions (workspace-plan.md §3, §5):
// names round-trip, the panel sets match the plan, overrides never invent a
// panel, visibility precedence holds, and the fly toggle returns home.

'use strict';

const assert = require('assert');
const W = require('../src/core/workspace.js');
const Presets = require('../src/core/presets.js');

let checks = 0;
function ok(cond, msg) { assert.ok(cond, msg); checks++; }

// --- Names ---------------------------------------------------------------
ok(W.NAMES.length === 3 && W.OBSERVE === 0 && W.FLY === 1 && W.COMMAND === 2, 'three workspaces');
for (let m = 0; m < 3; m++) ok(W.modeFromName(W.modeName(m)) === m, 'name round-trips: ' + m);
ok(W.modeFromName('junk') === -1 && W.modeFromName('') === -1 && W.modeFromName(undefined) === -1,
	'unknown names are -1');
ok(W.modeName(-1) === '' && W.modeName(3) === '', 'out-of-range mode names are empty');

// --- The panel table (§5.1) ----------------------------------------------
ok(W.PANEL_COUNT === 7 && W.PANEL_IDS.length === 7 && W.PANEL_LABELS.length === 7, 'seven panels');
const bit = W.panelBit;
assert.strictEqual(W.panelsFor(W.OBSERVE),
	bit(W.SEARCH) | bit(W.ROUTES) | bit(W.VIEWMODES) | bit(W.DISPLAY) | bit(W.CONTROLS));
assert.strictEqual(W.panelsFor(W.FLY), bit(W.FLIGHT) | bit(W.CONTROLS));
assert.strictEqual(W.panelsFor(W.COMMAND),
	bit(W.SEARCH) | bit(W.ROUTES) | bit(W.TRADE) | bit(W.CONTROLS));
checks += 3;
ok(W.panelsFor(-1) === W.panelsFor(W.OBSERVE) && W.panelsFor(9) === W.panelsFor(W.OBSERVE),
	'an unknown mode falls back to observe\u2019s set');
// Every panel appears in at least one workspace; Controls in all three; no
// workspace is empty.
let union = 0;
for (let m = 0; m < 3; m++) {
	const mask = W.panelsFor(m);
	ok(mask !== 0, 'workspace mask non-empty: ' + W.modeName(m));
	ok((mask & bit(W.CONTROLS)) !== 0, 'Controls in every workspace: ' + W.modeName(m));
	union |= mask;
}
ok(union === W.PANEL_MASK_ALL, 'every panel belongs to at least one workspace');

// --- Overrides and sanitise (§5.4) ----------------------------------------
ok(W.sanitiseMask(0xff) === W.PANEL_MASK_ALL, 'sanitise never invents a panel');
ok(W.sanitiseMask(-1) === W.PANEL_MASK_ALL && W.sanitiseMask(0) === 0, 'sanitise bounds');
let mask = W.panelsFor(W.FLY);
mask = W.applyOverride(W.FLY, mask, W.TRADE, true);
ok((mask & bit(W.TRADE)) !== 0, 'override adds a panel');
mask = W.applyOverride(W.FLY, mask, W.TRADE, false);
ok(mask === W.panelsFor(W.FLY), 'override removes a panel');
ok(W.applyOverride(W.FLY, mask, 99, true) === mask, 'an out-of-range panel changes nothing');
ok(W.applyOverride(W.FLY, 0xffff, W.TRADE, true) === W.PANEL_MASK_ALL, 'override sanitises its input');

// --- visibleMask precedence (§5.3) ----------------------------------------
const auto = bit(W.ROUTES);
assert.strictEqual(W.visibleMask(W.FLY, 0, 0, 0), W.panelsFor(W.FLY));
assert.strictEqual(W.visibleMask(W.FLY, 0, 0, auto), W.panelsFor(W.FLY) | auto,
	'auto-show only adds to the mode set');
assert.strictEqual(W.visibleMask(W.FLY, 1, bit(W.CONTROLS), auto), bit(W.CONTROLS),
	'a frozen override is authoritative');
assert.strictEqual(W.visibleMask(W.FLY, 1, 0, auto), 0,
	'a frozen empty override shows nothing \u2014 empty and none differ');
checks += 4;

// --- toggleFly (§7.1) -------------------------------------------------------
ok(W.toggleFly(W.OBSERVE, W.OBSERVE) === W.FLY, 'g enters fly');
ok(W.toggleFly(W.COMMAND, W.OBSERVE) === W.FLY, 'g enters fly from command');
ok(W.toggleFly(W.FLY, W.COMMAND) === W.COMMAND, 'g returns to where fly was entered from');
ok(W.toggleFly(W.FLY, W.FLY) === W.OBSERVE, 'a broken last falls back to observe');
ok(W.toggleFly(W.FLY, -1) === W.OBSERVE && W.toggleFly(W.FLY, 9) === W.OBSERVE,
	'an out-of-range last falls back to observe');

// --- The preset `mode` field (§12) -----------------------------------------
ok(Presets.FIELDS.some((f) => f.key === 'mode'), 'presets carry the mode field');
const shipAt = Presets.FIELDS.findIndex((f) => f.key === 'ship');
const modeAt = Presets.FIELDS.findIndex((f) => f.key === 'mode');
ok(modeAt === shipAt + 1, 'mode serializes directly after ship');
const parsed = Presets.parse('mode=command');
ok(parsed.mode === 'command', 'mode round-trips through parse');
ok(Presets.parse('mode=warp').mode === undefined, 'an unknown mode name is dropped');
ok(/(^|&)mode=fly(&|$)/.test(Presets.serialize({ mode: 'fly' })), 'mode serializes by name');

console.log(`${checks + 7} workspace checks passed`);
