// experiments/timeboard-test.js
// The clock board (time-plan.md §1–§5): the progression table is complete and
// playable, every rate a progression names is a stop its own slider can reach,
// **no progression touches the sky**, the star link's bridge is the law the
// panel prints, and the two formats say what the board says. Pure table, no DOM.
//
// trade.36 replaced the old star/evolve/generation table. The defect it removed
// was real: pressing "generation ship" set the star clock, which re-dated the
// galaxy — time is time, game progression is game progression. These checks
// exist so the table cannot quietly grow a star rate again.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
// The page's global, so presets.js resolves the clock board the way it resolves
// every module-owned number (menuDefaults): one object, seen by both.
global.window = global;
const TimeBoard = require('../src/core/timeboard.js');
const Trade = require('../src/core/trade.js');
const SystemLayer = require('../src/render/system-layer.js');
const Presets = require('../src/core/presets.js');

let checks = 0;
function ok(cond, msg, detail) {
	assert.ok(cond, msg + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)));
	checks++;
}

// --- The progressions ------------------------------------------------------
ok(TimeBoard.MODES.length === 3, 'three progressions', TimeBoard.MODES.length);
ok(TimeBoard.MODE_IDS.join(',') === 'linked,trade,planetary',
	'one clock, trade and planetary, in that order', TimeBoard.MODE_IDS);
ok(TimeBoard.MODE_IDS.includes(TimeBoard.DEFAULT_MODE), 'the default is one of them',
	TimeBoard.DEFAULT_MODE);
for (const id of TimeBoard.MODE_IDS) {
	const mode = TimeBoard.modeById(id);
	ok(mode && mode.label && mode.note.length > 40, 'a progression is labelled and explained: ' + id);
	ok(TimeBoard.modeById(id).id === id, 'progression lookup round-trips: ' + id);
}
ok(TimeBoard.modeById('junk') === null && TimeBoard.modeById('') === null
	&& TimeBoard.modeById(undefined) === null, 'an unknown progression is null, never a guess');
ok(TimeBoard.modeById('generation') === null,
	'the retired star-moving "generation ship" progression is gone, not renamed');
ok(TimeBoard.modeLabel('trade') === 'trade' && TimeBoard.modeLabel('junk') === '',
	'labels come from the table');

// --- A progression sets the game clocks and nothing else -------------------
// This is the reported defect, pinned: a progression press may set the colony
// clock, its link, the schematic's clock and its link. It may not name the star
// clock, the epoch, or any "evolve" switch — the sky's clock belongs to the
// Display panel and to the player.
for (const mode of TimeBoard.MODES) {
	const keys = Object.keys(mode).sort().join(',');
	ok(keys === 'id,label,note,system,trade', mode.id + ': a progression has exactly the four fields it uses', keys);
	ok(mode.star === undefined, mode.id + ': no star clock on a progression');
	ok(mode.trade.evolve === undefined && mode.system.evolve === undefined,
		mode.id + ': no evolve switch anywhere on a progression');
	ok(mode.trade.generation === undefined,
		mode.id + ': no "generation ships" flag — a generation ship is a colony decision (trade.36)');
	ok(Object.keys(mode.trade).sort().join(',') === 'rate,synced',
		mode.id + ': the colony half is a link and a rate', Object.keys(mode.trade));
	ok(Object.keys(mode.system).sort().join(',') === 'rate,synced',
		mode.id + ': the schematic half is a link and a rate', Object.keys(mode.system));
}

// --- Every rate a progression names is a stop its own slider can reach -----
for (const mode of TimeBoard.MODES) {
	// The colony ladder is trade.js's, and the rate a progression names must be
	// one of its stops — otherwise a press would silently snap somewhere else.
	ok(Trade.TRADE_RATES.includes(mode.trade.rate),
		mode.id + ': the colony rate is a ladder stop', mode.trade.rate);
	ok(mode.trade.synced === 0 || mode.trade.synced === 1, mode.id + ': the colony link is a flag');
	// The schematic's ladder is the layer's. A synced progression does not need
	// a stop (the link picks the nearest), but it names one as its fallback, so
	// it must be a real stop too.
	const index = SystemLayer.sysTimeIndexOf(mode.system.rate);
	ok(SystemLayer.sysTimeRateAt(index) === mode.system.rate,
		mode.id + ': the schematic rate is a schematic-ladder stop', mode.system.rate);
	ok(mode.system.synced === 0 || mode.system.synced === 1, mode.id + ': the schematic link is a flag');
}

// --- The three progressions mean what the plan says ------------------------
const linked = TimeBoard.modeById('linked');
const tradeMode = TimeBoard.modeById('trade');
const planetary = TimeBoard.modeById('planetary');
ok(linked.trade.synced === 1 && linked.system.synced === 1,
	'one clock: both game clocks ride the sky');
ok(tradeMode.trade.synced === 1 && tradeMode.system.synced === 0,
	'trade: the colonies ride the sky, the schematic keeps its own clock');
ok(planetary.trade.synced === 0 && planetary.system.synced === 0
	&& planetary.trade.rate === 50 && planetary.system.rate === 0.5,
	'planetary: nothing rides the sky; 50 y/s of colonies and half a year per second in the view');
ok(planetary.trade.rate < tradeMode.trade.rate,
	'planetary is the slow one, which is what makes a long voyage watchable');

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

// --- Which progression the game clocks are on right now -------------------
// The board reads the live clock set rather than remembering the last press, so
// a dragged slider moves it off the progression it was on. The set is the four
// game-clock keys; the star clock is not in it.
function stateOf(id) {
	const mode = TimeBoard.modeById(id);
	return {
		tradeRate: mode.trade.rate, tradeSynced: mode.trade.synced,
		systemRate: mode.system.rate, systemSynced: mode.system.synced,
	};
}
for (const mode of TimeBoard.MODES) {
	const state = stateOf(mode.id);
	ok(Object.keys(state).length === 4, 'the board is asked about four keys: ' + mode.id, Object.keys(state));
	ok(TimeBoard.matchMode(state) === mode.id,
		'a progression\u2019s own clock set matches it: ' + mode.id);
}
ok(TimeBoard.matchMode({ tradeRate: 100, tradeSynced: 0, systemRate: 0, systemSynced: 0 }) === '',
	'the boot defaults are hand-set, not a progression');
{
	const unlinked = stateOf('planetary');
	unlinked.tradeRate = 200;
	ok(TimeBoard.matchMode(unlinked) === '', 'a colony ladder the progression did not set leaves it');
	// Turning trade's schematic link on *is* the one-clock progression: the two
	// differ by exactly that link, so the board must say so.
	const relinked = stateOf('trade');
	relinked.systemSynced = 1;
	ok(TimeBoard.matchMode(relinked) === 'linked', 'a link the progression did not set names the one that did');
	const linkedDrift = stateOf('linked');
	linkedDrift.tradeRate = 2000;
	ok(TimeBoard.matchMode(linkedDrift) === 'linked',
		'a linked clock is matched by its link, not its parked ladder stop');
	// The star clock cannot even be part of the question: the board is handed
	// the four game clocks, and extra keys are ignored, not consulted.
	const withStar = stateOf('trade');
	withStar.starRate = 0.1;
	withStar.evolve = 1;
	ok(TimeBoard.matchMode(withStar) === 'trade',
		'a star rate in the state changes nothing about which progression is on');
}

// --- The panel's writer touches only the game clocks ----------------------
// Source-level, because the defect was a writer: `applyTimeMode` must not
// assign the star clock, the epoch, or any galaxy-age state. It may set the
// colony ladder, the two links and the schematic's rate.
{
	const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
	const start = main.indexOf('function applyTimeMode(');
	const end = main.indexOf('\n        }', start);
	ok(start > 0 && end > start, 'the panel still has one applyTimeMode to read');
	const body = main.slice(start, end);
	ok(!/starTimeRate\s*=/.test(body) && !/starTimeMyr\s*=/.test(body),
		'pressing a progression does not set the star clock', body.length);
	ok(!/evolve/i.test(body) && !/generationMode|setGenerationMode|tradegen/.test(body),
		'and touches no evolve switch and no generation mode');
	ok(/tradeRateIndex\s*=/.test(body) && /setTradeSync\(/.test(body) && /setSystemSync\(/.test(body),
		'it sets the colony ladder and the two links, which is all a progression is');
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

// --- The boot default, and the preset language that feeds the panel -------
// The star clock's boot rate is the preset's own number, and no progression
// names it: the two are independent by construction.
ok(Presets.TIME_DEFAULT === 1, 'the boot star rate is 1 Myr/s', Presets.TIME_DEFAULT);
ok(TimeBoard.MODES.every((mode) => mode.star === undefined),
	'...and no progression can move it');
ok(!Presets.FIELDS.some((field) => field.key === 'tradegen'),
	'the preset language has no "generation ships" key left to carry');
{
	// The key is retired, not merely absent from FIELDS: no module may carry it
	// back in (a persisted mask that still has it is ignored by the loader).
	const files = ['core/presets.js', 'core/trade.js', 'core/timeboard.js', 'main.js'];
	let leftovers = [];
	for (const file of files) {
		const text = fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');
		if (/tradegen|GENERATION_STAR_MYR|setGenerationMode|GENERATION_RESERVE_YEARS/.test(text)) leftovers.push(file);
	}
	ok(leftovers.length === 0, 'no module still carries the retired generation-mode machinery', leftovers);
}

// --- A progression reaches a preset and a URL as a name (time-plan §7) ----
// One table (MODES), one press (applyTimeMode), one line
// (Presets.expandProgression). The three have to agree for every mode, or a
// frame the page copied as a profile would come back as `hand-set`.
{
	ok(Presets.FIELDS.some((field) => field.key === 'progression'),
		'the preset language names the progression');
	ok(Presets.FIELDS.some((field) => field.key === 'systemsync'),
		'...and the second link the board owns, which had no key before');
	ok(Presets.PROGRESSION_KEYS.join() === ['trade', 'tradesync', 'systime', 'systemsync'].join(),
		'a progression expands into exactly the four clocks the board prints', Presets.PROGRESSION_KEYS);
	for (const mode of TimeBoard.MODES) {
		const expanded = Presets.expandProgression(Presets.parse('progression=' + mode.id));
		// The four numbers are the press written down: `applyTimeMode` sets the
		// colony ladder stop and the two links to these very fields.
		ok(expanded.trade === mode.trade.rate && expanded.tradesync === mode.trade.synced
			&& expanded.systime === mode.system.rate && expanded.systemsync === mode.system.synced,
			`${mode.id}: the expansion is the press, as data`);
		ok(TimeBoard.matchMode({ tradeRate: expanded.trade, tradeSynced: expanded.tradesync,
			systemRate: expanded.systime, systemSynced: expanded.systemsync }) === mode.id,
			`${mode.id}: expanding a name and matching the clocks it wrote is the identity`);
	}
	// A frame that is on no progression copies as numbers alone: the name is
	// absent, never a wrong one, and the board still reads `hand-set` after it.
	const handSet = { progression: '', trade: 200, tradesync: 0, systime: 2, systemsync: 0 };
	ok(Presets.serialize(handSet).indexOf('progression=') < 0,
		'a hand-set frame names no progression in its line');
	ok(TimeBoard.matchMode({ tradeRate: handSet.trade, tradeSynced: handSet.tradesync,
		systemRate: handSet.systime, systemSynced: handSet.systemsync }) === '',
		'...and it comes back hand-set, which is what it was');
}

// --- The URL and the paste path carry it the same way ---------------------
{
	const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
	const readStart = main.indexOf('function readParams(');
	const read = main.slice(readStart, main.indexOf('\n}', readStart));
	ok(/window\.Presets\.expandProgression\(\{/.test(read),
		'the URL language expands a progression before boot reads a clock — so boot never presses the board early');
	// Sparse on purpose: every clock is named only when the URL names it, or a
	// default would outrank the mode. This is the bug the first cut had.
	ok(['progression: text(\'progression\', \'\')', "trade: named('trade')", "tradesync: named('tradesync')",
		"systime: named('systime')", "systemsync: named('systemsync')"]
		.every((line) => read.indexOf(line) >= 0),
		'the expansion is handed the four clocks only as far as the URL names them');
	ok(read.indexOf("number('trade'") < 0 && read.indexOf("number('systime'") < 0,
		'no defaulted clock outranks the progression it sits beside');
	ok(['clocks.trade', 'clocks.systime', 'clocks.tradesync', 'clocks.systemsync']
		.every((read_) => read.indexOf(read_) >= 0),
		'boot then reads what the expansion wrote');
	ok(/let tradeSyncOn = params\.tradesync > 0 \? 1 : 0;/.test(main)
		&& /let systemSyncOn = params\.systemsync > 0 \? 1 : 0;/.test(main),
		'both links boot from the URL, like the rates they sit beside');
	const collectStart = main.indexOf('function collectSettings()');
	const collectEnd = main.indexOf('\n        }', collectStart);
	const collect = main.slice(collectStart, collectEnd);
	ok(/progression:\s*TimeBoard\.matchMode\(clockState\(\)\)/.test(collect),
		'copy names the progression the live clocks are, not the last press');
	ok(/systemsync:\s*systemSyncOn/.test(collect) && /tradesync:\s*tradeSyncOn/.test(collect),
		'...and carries both links beside it');
	const applyStart = main.indexOf('function applyPreset(query)');
	const applyEnd = main.indexOf('\n        }', applyStart);
	const apply = main.slice(applyStart, applyEnd);
	ok(/window\.Presets\.expandProgression\(window\.Presets\.parse\(query\)\)/.test(apply),
		'a pasted progression is expanded as data before any writer runs');
	ok(!/tradeSyncOn\s*=/.test(apply),
		'the colony link has one writer, so a paste cannot leave one of its two boxes behind');
	ok(/setTradeSync\(/.test(apply) && /setSystemSync\(/.test(apply),
		'both links land through the writers the checkboxes use');
}

console.log(`${checks} timeboard checks passed`);
