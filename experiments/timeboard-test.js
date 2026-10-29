// experiments/timeboard-test.js
// The clock board (time-plan.md §1–§2): the mode table is complete and
// playable, every rate a mode names is a stop its own slider can reach, the
// star link's bridge is the law the panel prints, and the two formats say what
// the board says. Pure table, no DOM.

'use strict';

const assert = require('assert');
const TimeBoard = require('../src/core/timeboard.js');
const Trade = require('../src/core/trade.js');
const SystemLayer = require('../src/render/system-layer.js');
const Presets = require('../src/core/presets.js');

let checks = 0;
function ok(cond, msg, detail) {
	assert.ok(cond, msg + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)));
	checks++;
}

// --- The modes -------------------------------------------------------------
ok(TimeBoard.MODES.length === 3, 'three progressions', TimeBoard.MODES.length);
ok(TimeBoard.MODE_IDS.join(',') === 'generation,trade,planetary',
	'generation ship, trade and planetary, in that order', TimeBoard.MODE_IDS);
ok(TimeBoard.MODE_IDS.includes(TimeBoard.DEFAULT_MODE), 'the default is one of them',
	TimeBoard.DEFAULT_MODE);
for (const id of TimeBoard.MODE_IDS) {
	const mode = TimeBoard.modeById(id);
	ok(mode && mode.label && mode.note.length > 40, 'a mode is labelled and explained: ' + id);
	ok(TimeBoard.modeById(id).id === id, 'mode lookup round-trips: ' + id);
}
ok(TimeBoard.modeById('junk') === null && TimeBoard.modeById('') === null
	&& TimeBoard.modeById(undefined) === null, 'an unknown mode is null, never a guess');
ok(TimeBoard.modeLabel('trade') === 'trade' && TimeBoard.modeLabel('junk') === '',
	'labels come from the table');

// --- Every rate a mode sets is a stop its own slider can reach -------------
for (const mode of TimeBoard.MODES) {
	// Star time: the fine range is −1…2 Myr/s in 0.1 steps and the wide range
	// −1…99 in 0.5; a mode must land on a fine-range step of 0.1.
	ok(mode.star.rate >= 0 && mode.star.rate <= 2,
		mode.id + ': the star rate is inside the fine slider range', mode.star.rate);
	ok(Math.abs(mode.star.rate * 10 - Math.round(mode.star.rate * 10)) < 1e-9,
		mode.id + ': the star rate is a 0.1 step', mode.star.rate);
	ok(mode.star.evolve === 0 || mode.star.evolve === 1, mode.id + ': evolve is a flag');
	// The colony ladder is trade.js's, and the rate a mode names must be one of
	// its stops — otherwise a press would silently snap somewhere else.
	ok(Trade.TRADE_RATES.includes(mode.trade.rate),
		mode.id + ': the colony rate is a ladder stop', mode.trade.rate);
	ok(mode.trade.synced === 0 || mode.trade.synced === 1, mode.id + ': the colony link is a flag');
	ok(mode.trade.generation === 0 || mode.trade.generation === 1, mode.id + ': generation is a flag');
	// The schematic's ladder is the layer's. A synced mode does not need a stop
	// (the link picks the nearest), but an unlinked one sets the rate directly.
	const layer = SystemLayer;
	const index = layer.sysTimeIndexOf(mode.system.rate);
	ok(layer.sysTimeRateAt(index) === mode.system.rate,
		mode.id + ': the system rate is a schematic-ladder stop', mode.system.rate);
	ok(mode.system.synced === 0 || mode.system.synced === 1, mode.id + ': the system link is a flag');
}

// --- The three progressions mean what the plan says ------------------------
const generation = TimeBoard.modeById('generation');
const tradeMode = TimeBoard.modeById('trade');
const planetary = TimeBoard.modeById('planetary');
ok(generation.trade.generation === 1 && generation.trade.synced === 1
	&& generation.star.evolve === 1,
	'generation ship: the galaxy evolves and the colonies live on its clock');
ok(tradeMode.trade.generation === 0 && tradeMode.trade.synced === 1
	&& tradeMode.star.rate <= 2,
	'trade: fast hulls, slow but visible star time, colonies on the star clock');
ok(planetary.star.rate === 0 && planetary.star.evolve === 0 && planetary.system.synced === 0,
	'planetary: the sky holds still and the schematic keeps its own clock');
ok(planetary.trade.synced === 0 && planetary.trade.generation === 0,
	'planetary: colonies on their own slow ladder, no generation hulls');

// --- The star link ---------------------------------------------------------
// One schematic year per star Myr per wall second: 1 Myr/s of sky is 1 y/s in
// the view, which is the pace the ferries are drawn at. That is the only place
// the two clocks are related.
ok(TimeBoard.systemRateForStar(1) === 1, '1 Myr/s of sky is 1 y/s in the view',
	TimeBoard.systemRateForStar(1));
ok(TimeBoard.systemRateForStar(0.5) === 0.5, 'the bridge is linear', TimeBoard.systemRateForStar(0.5));
ok(TimeBoard.systemRateForStar(2) === 2, 'and holds at the top of the fine range');
ok(TimeBoard.systemRateForStar(0) === null && TimeBoard.systemRateForStar(-1) === null,
	'a frozen or camera-following sky has nothing to lend');
ok(TimeBoard.SYSTEM_STAR_BRIDGE === 1e-6, 'the bridge is one year per star Myr');

// A linked rate is snapped to the layer's own stop, so the panel can always
// name the rate it is running.
for (const starRate of [0.1, 0.5, 1, 2, 5]) {
	const rate = TimeBoard.systemRateForStar(starRate);
	const snapped = SystemLayer.sysTimeRateAt(SystemLayer.sysTimeIndexOf(rate));
	ok(snapped > 0, 'a linked rate lands on a running stop: ' + starRate + ' Myr/s', snapped);
}

// --- Which progression the clocks are on right now ------------------------
// The board reads the live clock set rather than remembering the last press, so
// a dragged slider moves it off the mode it was on.
function stateOf(id) {
	const mode = TimeBoard.modeById(id);
	return {
		starRate: mode.star.rate, evolve: mode.star.evolve,
		tradeRate: mode.trade.rate, tradeSynced: mode.trade.synced,
		generation: mode.trade.generation,
		systemRate: mode.system.rate, systemSynced: mode.system.synced,
	};
}
for (const mode of TimeBoard.MODES) {
	ok(TimeBoard.matchMode(stateOf(mode.id)) === mode.id,
		'a mode\u2019s own clock set matches it: ' + mode.id);
}
ok(TimeBoard.matchMode({ starRate: 1, evolve: 1, tradeRate: 100, tradeSynced: 0,
	generation: 0, systemRate: 0, systemSynced: 0 }) === '',
	'the boot defaults are hand-set, not a progression');
{
	const drifted = stateOf('trade');
	drifted.starRate = 0.3;
	ok(TimeBoard.matchMode(drifted) === '', 'a dragged star slider leaves the progression');
	const unlinked = stateOf('planetary');
	unlinked.tradeRate = 200;
	ok(TimeBoard.matchMode(unlinked) === '', 'and so does a colony ladder the mode did not set');
	const linked = stateOf('generation');
	linked.tradeRate = 2000;
	ok(TimeBoard.matchMode(linked) === 'generation',
		'a linked clock is matched by its link, not its parked ladder stop');
}

// --- The words -------------------------------------------------------------
ok(TimeBoard.formatStarRate(0) === 'frozen' && TimeBoard.formatStarRate(-1) === 'frozen',
	'a stopped sky reads frozen');
ok(TimeBoard.formatStarRate(0.5) === '0.5 Myr/s' && TimeBoard.formatStarRate(1) === '1 Myr/s',
	'the star rate reads in Myr/s');
ok(TimeBoard.formatTradeRate(1000, 1).includes('1,000 y/s')
	&& TimeBoard.formatTradeRate(1000, 1).includes('star'), 'a linked colony clock says so');
ok(TimeBoard.formatTradeRate(100, 0).includes('own'), 'an unlinked one says that instead');
ok(TimeBoard.formatTradeRate(0, 1).includes('paused'), 'a stopped colony clock reads paused');

// --- The boot default agrees with the preset language ----------------------
ok(Presets.TIME_DEFAULT === 1, 'the boot star rate is the trade mode\u2019s', Presets.TIME_DEFAULT);
ok(TimeBoard.modeById('trade').star.rate === Presets.TIME_DEFAULT,
	'...and the trade mode is the default progression');

console.log(`${checks} timeboard checks passed`);
