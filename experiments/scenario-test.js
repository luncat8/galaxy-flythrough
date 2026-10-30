// experiments/scenario-test.js
// The formation checks (ui.21): the scenario table is data, so every row is
// checked before a browser is opened — each one is a valid preset fragment,
// each one stays inside the model's own clock, a frozen scenario cannot drift,
// and a running one is wide enough for the rate it asks for. The rows are the
// 0.7 browser verdict (V14) in `deferred-browser-visual-plan.md`; this test
// only proves they say what they do, not that the picture reads.

'use strict';

require('../src/math/hash.js');
require('../src/math/density.js');
require('../src/math/galaxy.js');
require('../src/core/presets.js');

const galaxy = require('../src/math/galaxy.js');
const Presets = require('../src/core/presets.js');
const ScenarioLib = require('../src/core/scenarios.js');

let checks = 0;
const failures = [];
function ok(cond, name, detail) {
	checks++;
	if (cond) return;
	failures.push({ name, detail });
	console.log('  FAIL ' + name + (detail === undefined ? '' : '  -> ' + JSON.stringify(detail)));
}

const rows = ScenarioLib.SCENARIOS.concat([ScenarioLib.PRESENT_DAY]);
const knownKeys = new Set(Presets.FIELDS.map((field) => field.key));
// The row verbs main.js's runScenario implements (the fleet is the only one).
const definedActions = new Set(['fleet']);

// --- The table ------------------------------------------------------------
ok(ScenarioLib.SCENARIOS.length >= 3, 'the panel offers more than one formation state',
	ScenarioLib.SCENARIOS.length);
const ids = rows.map((row) => row.id);
ok(ids.length === new Set(ids).size, 'scenario ids are unique', ids);
ok(ids.indexOf(ScenarioLib.PRESENT_DAY.id) === ids.length - 1
	|| ScenarioLib.SCENARIOS.every((row) => row.id !== ScenarioLib.PRESENT_DAY.id),
'the comparison frame is not one of the scenario rows');
ok(ScenarioLib.SCENARIOS.every((row) => row.label && row.what && row.watch),
'every scenario carries a label, what to look at and what proves it');
ok(rows.every((row) => row.view === 'galaxy' || row.view === 'none'),
'every scenario names a view the page implements',
rows.map((row) => row.view));

// --- Every row is a preset fragment --------------------------------------
const parsedRows = [];
for (const row of rows) {
	const query = ScenarioLib.queryOf(row);
	const settings = Presets.parse(query);
	const keys = Object.keys(settings);
	parsedRows.push({ row, query, settings });
	ok(keys.length > 0, `${row.id}: the query is a preset`, query);
	ok(keys.every((key) => knownKeys.has(key)), `${row.id}: every key is a preset field`, keys);
	// A page-action row (trade.35's fleet) is a check frame, not an epoch: it
	// must leave the sky where the session has it, so the epoch/rate rules are
	// exactly the ones it must *not* satisfy. The two families are disjoint by
	// design, and each is pinned here rather than assumed.
	if (row.action !== undefined) {
		ok(definedActions.has(row.action), `${row.id}: the action is one the page implements`, row.action);
		ok(settings.age === undefined && settings.evolve === undefined && settings.time === undefined,
			`${row.id}: an action row does not move the epoch or the star clock`, settings);
		ok(settings.mode === 'observe', `${row.id}: an action row names its workspace`, settings.mode);
		ok(row.view === 'none', `${row.id}: an action row does not move the camera`, row.view);
	} else {
		ok(settings.age !== undefined && settings.evolve !== undefined
			&& settings.time !== undefined && settings.mode === 'observe',
			`${row.id}: the row lands the epoch, the live clock, the rate and the workspace`, settings);
		ok(settings.age >= galaxy.AGE_MIN && settings.age <= galaxy.AGE_MAX,
			`${row.id}: the epoch is inside the model's range`, settings.age);
		ok((settings.evolve === 0 || settings.evolve === 1) && (settings.evolve === 1) === (settings.time > 0),
			`${row.id}: a running clock is the only reason to carry a rate`, settings);
		ok(settings.time <= 99 && settings.time >= -1,
			`${row.id}: the rate is inside the star-time slider`, settings.time);
		ok(settings.time <= 2 || row.wide === true,
			`${row.id}: a rate above the fine range widens it first`, { time: settings.time, wide: !!row.wide });
	}
	// The line a browser pass records must survive a round-trip through the
	// settings serialiser: what Copy hands back is what Run applied.
	ok(JSON.stringify(Presets.parse(query)) === JSON.stringify(settings),
		`${row.id}: the query parses to itself`, query);
}

// The states must differ, or two buttons would run the same check.
const states = parsedRows.map(({ settings }) => `${settings.age}/${settings.evolve}/${settings.time}`);
ok(states.length === new Set(states).size, 'no two scenarios land the same clock', states);
ok(new Set(parsedRows.map(({ settings }) => settings.age)).size >= 3,
	'the table spans several epochs', parsedRows.map(({ settings }) => settings.age));

// --- The one row that pins a 0.7 boundary --------------------------------
const firstLight = ScenarioLib.byId('firstlight');
ok(firstLight && Presets.parse(ScenarioLib.queryOf(firstLight)).age === galaxy.AGE_MIN,
	'first light runs at the model\u2019s own deep-time boundary (AGE_MIN)');
const today = ScenarioLib.PRESENT_DAY;
ok(Presets.parse(ScenarioLib.queryOf(today)).age === galaxy.AGE_REF,
	'the comparison frame is the reference epoch (AGE_REF)');
ok(ScenarioLib.byId('condense').wide === true && ScenarioLib.byId('walk').wide === true,
	'the two live runs widen the star-time range');

// --- Lookup ---------------------------------------------------------------
ok(ScenarioLib.byId('walk') === ScenarioLib.SCENARIOS[2], 'byId resolves a scenario');
ok(ScenarioLib.byId(today.id) === today, 'byId resolves the comparison frame');
ok(ScenarioLib.byId('junk') === null && ScenarioLib.byId('') === null && ScenarioLib.byId(undefined) === null,
	'byId is null for anything else');
ok(ScenarioLib.queryOf(null) === '', 'queryOf has no query for no row');

// --- The live readout ------------------------------------------------------
// The line under the buttons is what a browser pass reads, so it is formatted
// by the shipped function, not re-typed here: these checks pin the shape and
// the "not built yet" contract (`—`, never `undefined` or `NaN`).
{
	const line = ScenarioLib.liveLine({
		mode: 'observe', age: 1, step: 10, totalSteps: 135, rate: '20.0 Myr/s', evolve: true,
		formed: 0.5, gas: 0.25, arms: 1.5, bulge: 0.125, draws: 0,
	});
	ok(line === 'observe \u00b7 1.0 Gyr (step 10/135) \u00b7 star 20.0 Myr/s \u00b7 evolve on'
		+ '\nformed 50% \u00b7 gas 0.25 \u00b7 arms \u00d71.50 \u00b7 bulge \u00d70.13 \u00b7 draws 0 \u00b7 gas \u0394 \u2014',
	'the live line names the mode, the epoch in quanta, the rate and the four numbers', line);

	// 0.7.4 (F5): the gas grid's own mass against the drawn-census account, signed
	// and three decimals — the number that says the gas picture and the stars agree.
	const driftLine = ScenarioLib.liveLine({ mode: 'observe', age: 1, gasDelta: -0.0123 });
	ok(driftLine.indexOf('gas \u0394 \u22120.012') !== -1,
		'a negative grid drift prints signed, not absolute', driftLine);
	const positive = ScenarioLib.liveLine({ age: 1, gasDelta: 0.004 });
	ok(positive.indexOf('gas \u0394 +0.004') !== -1, 'a positive grid drift carries its sign', positive);

	// The step is derivable from the model's own clock, so a caller that forgets
	// to pass it still prints the quanta rather than a blank.
	const derived = ScenarioLib.liveLine({
		mode: 'observe', age: 2, ageMin: 0, ageMax: 13.5, ageStep: 0.1, rate: '0.0 Myr/s', evolve: false,
		formed: 1, gas: 0.05, arms: 1, bulge: 1, draws: 12,
	});
	ok(derived.indexOf('(step 20/135)') !== -1, 'the epoch prints in model quanta when the step is derived', derived);
	ok(derived.indexOf('formed 100%') !== -1 && derived.indexOf('draws 12') !== -1,
	'the formed share is whole percent and the draw count is the carried counter', derived);

	// Nothing built yet: every measured number is an em dash. A fallback that
	// prints as a value is how 0.7.3 shipped an inert gas account.
	const empty = ScenarioLib.liveLine({});
	ok(empty.indexOf('undefined') === -1 && empty.indexOf('NaN') === -1,
	'an unbuilt state never prints undefined or NaN', empty);
	ok((empty.match(/\u2014/g) || []).length >= 5, 'an unbuilt state prints em dashes for what is missing', empty);
	ok(ScenarioLib.liveLine({}).indexOf('evolve off') !== -1, 'the clock reads off unless it is on', empty);
}

// --- The page\u2019s half of an action row ----------------------------------
// The table cannot replay an action on its own, so the wiring that turns the
// verb into a picture is pinned here: runScenario dispatches it, the berth is
// chosen for what is moving (trade.js's fleetShowcase), and the selected craft
// is one the frame draws.
{
	const fs = require('fs');
	const path = require('path');
	const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf-8');
	ok(main.includes("row.action === 'fleet' ? applyFleetScenario()"),
		'runScenario runs the fleet row\u2019s action', 'dispatch missing');
	const action = main.slice(main.indexOf('function applyFleetScenario()'),
		main.indexOf('function runScenario(row)'));
	ok(action.includes('tradeLib.fleetShowcase(tradeNet, FLEET_WIND_TICKS)'),
		'the berth is the network\u2019s own, wound to a moving fleet');
	ok(action.includes('systemLayer.selectCraft('),
		'the action selects a craft, so its route\u2019s numbers are on screen');
	ok(action.indexOf("CRAFT_FERRY") < action.indexOf("CRAFT_HULL"),
		'a flying ferry wins over a hull in port when the system has legs');
	ok(action.includes('tradeLib.portFleet(tradeNet, bestPort)'),
		'the report is read from the same fleet record the layer draws');
}

// --- What the picker offers ----------------------------------------------
// Pressing Present day used to blank the picker, because the comparison frame
// had a button but no option. Every state the panel can run is an option.
{
	const offered = ScenarioLib.SCENARIOS.concat([ScenarioLib.PRESENT_DAY]);
	ok(offered.every((row) => ScenarioLib.byId(row.id) === row),
		'every option the picker lists resolves back to its row', offered.map((row) => row.id));
	ok(offered.length === ScenarioLib.SCENARIOS.length + 1,
		'the picker lists the checks and the comparison frame exactly once');
}

// --- Report ---------------------------------------------------------------
console.log(`\n${checks - failures.length}/${checks} passed, ${failures.length} failed`);
console.log('\n=== VERDICT ===');
console.log(failures.length === 0
	? 'PASS — every formation scenario is a preset, inside the clock, and says what to look at'
	: `FAIL — ${failures.length} checks failed`);
process.exit(failures.length === 0 ? 0 : 1);
