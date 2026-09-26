// experiments/preset-test.js
// Presets (archive/copy-paste-preset-prompt.md): the copy/paste text line is
// the URL language, so the round trip through serialize → parse has to be
// exact, the defaults table has to stay honest against the modules that own
// the numbers, and the LLM prompt has to carry the settings, the approach
// sketch and the two scoping questions. Also pins the page wiring: the menu
// section exists, presets.js loads before main.js, and main.js reads Presets.
//
// Output: experiments/logs/preset.json

'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

global.window = global;
const StarRenderer = require('../src/render/star-sprites.js');
const OrbitLib = require('../src/math/orbit.js');
const GalaxyLib = require('../src/math/galaxy.js');
const Presets = require('../src/core/presets.js');

const checks = [];
function check(name, test) {
	try { test(); checks.push({ name, pass: true }); }
	catch (error) { checks.push({ name, pass: false, detail: error.message }); }
}

const SRC = path.join(__dirname, '..', 'src');

// --- serialize / parse round trip -----------------------------------------

const SETTINGS = {
	type: 'SBb', seed: 42, age: 13.5, engine: ['classic', 'apocenter'],
	time: 5, wave: 0.6, pattern: 1, apoShare: 0.35, apoForce: 0.22,
	exposure: 22, brightness: 1, white: 4, sat: 1.4, headroom: 8, highlight: 1,
	stars: 300000, catalog: 250000,
};

check('serialize covers every field, in FIELDS order', () => {
	const query = Presets.serialize(SETTINGS);
	const keys = [...new URLSearchParams(query).keys()];
	assert.deepEqual(keys, Presets.FIELDS.map((f) => f.key));   // SETTINGS runs apocenter
});

check('serialize → parse is the identity on the full settings object', () => {
	const back = Presets.parse(Presets.serialize(SETTINGS));
	assert.deepEqual(back, SETTINGS);
});

check('serialize → parse is the identity on a non-default system', () => {
	const other = Object.assign({}, SETTINGS, {
		type: 'Irr', seed: 7, age: 2.25, engine: ['simple', 'apocenter'],
		time: -1, wave: 0, pattern: 2.5, apoShare: 1, apoForce: 0,
		exposure: 18.5, brightness: 0.125, white: 16, sat: 0.5, headroom: 1, highlight: 0,
		stars: 50000, catalog: 0,
	});
	assert.deepEqual(Presets.parse(Presets.serialize(other)), other);
});

// --- disabled passes are not part of the preset -----------------------------
// A knob of a movement pass that is not selected describes nothing that runs:
// the copied line must not carry it, a pasted line must not apply it, and the
// menu hides the same rows (checked against index.html/main.js below).

check('serialize drops the fields of a pass that is not selected', () => {
	const off = Object.assign({}, SETTINGS, { engine: ['classic'] });
	const keys = [...new URLSearchParams(Presets.serialize(off)).keys()];
	assert.ok(!keys.includes('apoShare') && !keys.includes('apoForce'), keys.join(','));
	assert.deepEqual(keys, Presets.FIELDS.filter((f) => !f.engine).map((f) => f.key));
	// …and carries them again as soon as the pass is back on.
	const on = Object.assign({}, SETTINGS, { engine: ['classic', 'apocenter'] });
	assert.ok(Presets.serialize(on).includes('apoShare=0.35'));
});

check('parse drops the fields of a pass the preset itself turns off', () => {
	assert.deepEqual(Presets.parse('engine=classic&apoShare=1&apoForce=0.5&sat=2'),
		{ engine: ['classic'], sat: 2 });
	assert.deepEqual(Presets.parse('engine=simple+apocenter&apoShare=1'),
		{ engine: ['simple', 'apocenter'], apoShare: 1 });
	// A preset that names no engine cannot prune: it keeps what it carries.
	assert.deepEqual(Presets.parse('apoShare=1'), { apoShare: 1 });
});

check('activeFields is the shared answer the menu and the format both use', () => {
	const keys = (engine) => Presets.activeFields({ engine }).map((f) => f.key);
	assert.ok(!keys(['classic']).includes('apoForce'));
	assert.ok(keys(['classic', 'apocenter']).includes('apoForce'));
	assert.deepEqual(keys(undefined), Presets.FIELDS.map((f) => f.key));
	assert.deepEqual(Presets.engineListOf({ engine: 'apocenter+classic' }), ['classic', 'apocenter']);
	assert.equal(Presets.engineListOf({}), null);
});

check('the prompt of a classic-only system never mentions the apocenter knobs', () => {
	const prompt = Presets.buildLlmPrompt(Object.assign({}, SETTINGS, { engine: ['classic'] }));
	assert.ok(!/apocenter stars|apocenter force/.test(prompt), 'apocenter knobs leaked');
	assert.ok(prompt.includes('stability engine: classic'));
});

check('partial presets survive: absent keys are absent, junk is dropped', () => {
	assert.deepEqual(Presets.parse('sat=2&type=Sc'), { type: 'Sc', sat: 2 });
	assert.deepEqual(Presets.parse('type=SBb&nope=1&seed=abc'), { type: 'SBb' });
	assert.deepEqual(Presets.parse(''), {});
	assert.deepEqual(Presets.parse(null), {});
});

check('engine serializes as names joined by + and parses back', () => {
	const query = Presets.serialize({ engine: ['simple', 'apocenter'] });
	assert.equal(new URLSearchParams(query).get('engine'), 'simple+apocenter');
	assert.deepEqual(Presets.parse(query), { engine: ['simple', 'apocenter'] });
});

check('parseEngineList normalizes order, case and junk', () => {
	assert.deepEqual(Presets.parseEngineList('apocenter+classic'), ['classic', 'apocenter']);
	assert.deepEqual(Presets.parseEngineList('Classic'), ['classic']);
	assert.deepEqual(Presets.parseEngineList('banana'), []);
	assert.deepEqual(Presets.parseEngineList(''), []);
	assert.deepEqual(Presets.parseEngineList('simple, apocenter!'), ['simple', 'apocenter']);
});

check('serializeEngine falls back to classic for an empty list', () => {
	assert.equal(Presets.serializeEngine([]), 'classic');
	assert.equal(Presets.serializeEngine(['banana']), 'classic');
	assert.equal(Presets.serializeEngine('apocenter'), 'apocenter');
});

// --- the defaults table -----------------------------------------------------

check('menuDefaults matches the modules that own the numbers', () => {
	const d = Presets.menuDefaults();
	assert.equal(d.exposure, StarRenderer.EXPOSURE_DEFAULT);
	assert.equal(d.brightness, StarRenderer.LINEAR_EXPOSURE_DEFAULT);
	assert.equal(d.white, StarRenderer.WHITE_POINT_DEFAULT);
	assert.equal(d.sat, StarRenderer.SATURATION_DEFAULT);
	assert.equal(d.headroom, StarRenderer.HEADROOM_DEFAULT);
	assert.equal(d.highlight, StarRenderer.HIGHLIGHT_DESAT_DEFAULT);
	assert.equal(d.time, Presets.TIME_DEFAULT);
	assert.equal(d.wave, OrbitLib.WAVE_DAMPING_UI_DEFAULT);
	assert.equal(d.pattern, OrbitLib.PATTERN_SCALE_UI_DEFAULT);
	assert.equal(d.apoShare, OrbitLib.APOCENTER_SHARE_UI_DEFAULT);
	assert.equal(d.apoForce, OrbitLib.APOCENTER_FORCE_UI_DEFAULT);
	assert.deepEqual(d, {
		exposure: 22, brightness: 1, white: 4, sat: 1.4, headroom: 8, highlight: 1,
		time: 5, wave: 0.6, pattern: 1, apoShare: 0.35, apoForce: 0.22,
	});
});

check('the default system round-trips and the model it names exists', () => {
	const system = Object.assign({
		type: GalaxyLib.MILKY_WAY_TYPE,
		seed: GalaxyLib.DEFAULT_SEED,
		age: GalaxyLib.AGE_DEFAULT,
		engine: ['classic'],
		stars: StarRenderer.PROCEDURAL_STARS_DEFAULT,
		catalog: StarRenderer.CATALOG_BUDGET_DEFAULT,
	}, Presets.menuDefaults());
	const query = Presets.serialize(system);
	// Classic-only out of the box, so the apocenter knobs are not in the line.
	const carried = Object.assign({}, system);
	delete carried.apoShare;
	delete carried.apoForce;
	assert.deepEqual(Presets.parse(query), carried);
	assert.ok(GalaxyLib.GALAXY_TYPES.includes(system.type), system.type);
});

// --- the LLM prompt ---------------------------------------------------------

const PROMPT = Presets.buildLlmPrompt(SETTINGS);

check('the prompt names the star system and every setting', () => {
	const described = Presets.describe(SETTINGS);
	for (const field of Presets.FIELDS) {
		if (field.key === 'engine') continue;   // array value, checked below by name
		assert.ok(PROMPT.includes(described[field.key]), field.key);
	}
	assert.ok(PROMPT.includes('star system: type SBb, seed 42, age 13.5 Gyr'));
	assert.ok(PROMPT.includes('classic, apocenter'));
});

check('the prompt references the project and sketches the approach offline', () => {
	assert.ok(PROMPT.includes(Presets.PROJECT_URL));
	assert.ok(PROMPT.includes('no internet'));
	assert.ok(PROMPT.includes('density field'));
	assert.ok(PROMPT.includes('hash'));
	assert.ok(PROMPT.includes('orbit'));
});

check('the prompt asks the two scoping questions before writing code', () => {
	const asks = PROMPT.indexOf('ask me two questions');
	assert.ok(asks > 0);
	const tail = PROMPT.slice(asks);
	assert.ok(/all galaxy types|selected one/.test(tail));
	assert.ok(/my current project|standalone[\s\S]*WebGPU/.test(tail));
	assert.ok(tail.trim().endsWith('like the reference?'));
});

// --- page wiring ------------------------------------------------------------

check('index.html loads presets.js before main.js and has the preset section', () => {
	const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf-8');
	const presetsAt = html.indexOf('src="core/presets.js"');
	const mainAt = html.indexOf('src="main.js"');
	assert.ok(presetsAt > 0 && mainAt > presetsAt, 'script order');
	for (const id of ['preset-text', 'preset-file', 'preset-copy', 'preset-paste',
		'preset-apply', 'preset-save', 'preset-load', 'preset-prompt']) {
		assert.equal(html.split(`id="${id}"`).length, 2, id);
	}
});

check('every engine-owned field has its menu row tagged with the same pass', () => {
	const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf-8');
	const tagged = [...html.matchAll(/data-engine="([a-z]+)"/g)].map((m) => m[1]);
	assert.ok(tagged.length >= 2, 'no data-engine rows');
	for (const name of tagged) assert.ok(Presets.ENGINE_ORDER.includes(name), name);
	for (const field of Presets.FIELDS.filter((f) => f.engine)) {
		assert.ok(tagged.includes(field.engine), field.key);
		// The row is the slider's own row, so the control id has to sit in it.
		const id = 'slider-' + field.key.replace('apoShare', 'apocenter-share').replace('apoForce', 'apocenter-force');
		const row = html.slice(0, html.indexOf(`id="${id}"`)).lastIndexOf('<div class="menu-row"');
		const tag = html.slice(0, html.indexOf(`id="${id}"`)).lastIndexOf('data-engine=');
		assert.ok(tag > row, id);
	}
});

check('main.js hides the rows of the passes that are not selected', () => {
	const main = fs.readFileSync(path.join(SRC, 'main.js'), 'utf-8');
	assert.ok(main.includes('[data-engine]'), 'row lookup');
	assert.ok(/row\.dataset\.engine/.test(main), 'row toggle');
	const sync = main.slice(main.indexOf('function syncEngine()'), main.indexOf('function changeEngines()'));
	assert.ok(sync.includes('row.style.display'), 'toggled from syncEngine');
});

check('main.js wires collect, apply, clipboard, file and prompt through Presets', () => {
	const main = fs.readFileSync(path.join(SRC, 'main.js'), 'utf-8');
	for (const snippet of [
		'window.Presets.parseEngineList', 'window.Presets.menuDefaults',
		'window.Presets.parse(', 'window.Presets.serialize(collectSettings())',
		'window.Presets.buildLlmPrompt(collectSettings())',
		'presetFile', 'btnPresetPrompt',
	]) {
		assert.ok(main.includes(snippet), snippet);
	}
});

const failed = checks.filter((c) => !c.pass).length;
for (const c of checks) console.log(`${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.detail ? ': ' + c.detail : ''}`);
console.log(`\n${checks.length - failed}/${checks.length} passed`);
fs.mkdirSync(path.join(__dirname, 'logs'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'logs/preset.json'), JSON.stringify({ checks, failed }, null, 2) + '\n');
process.exitCode = failed ? 1 : 0;
