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
// presets.js resolves the numeric defaults from the modules that own them
// (0.5.0 added `selrad`, owned by selection.js; 0.5.3 added `systime`, owned
// by system-layer.js), so the modules it reads must be registered before
// menuDefaults() is called.
const Selection = require('../src/core/selection.js');
const SystemLayer = require('../src/render/system-layer.js');

const checks = [];
function check(name, test) {
	try { test(); checks.push({ name, pass: true }); }
	catch (error) { checks.push({ name, pass: false, detail: error.message }); }
}

const SRC = path.join(__dirname, '..', 'src');

// --- serialize / parse round trip -----------------------------------------

const SETTINGS = {
	type: 'SBb', seed: 42, age: 13.5, evolve: 1, engine: ['classic', 'apocenter'],
	time: 5, wave: 0.6, pattern: 1, apoShare: 0.35, apoForce: 0.22,
	selrad: 1.69897, exposure: 22, brightness: 1, white: 4, sat: 1.4, headroom: 8, highlight: 1,
	search: 'G,K|terran|220-300', scope: 'selection',
	sysview: 0, systime: 2, dvmap: 1, dvbudget: 0.35, ship: 'fusion',
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
		type: 'Irr', seed: 7, age: 2.25, evolve: 0, engine: ['simple', 'apocenter'],
		time: -1, wave: 0, pattern: 2.5, apoShare: 1, apoForce: 0,
		exposure: 18.5, brightness: 0.125, white: 16, sat: 0.5, headroom: 1, highlight: 0,
		search: 'M|barren', scope: 'galaxy',
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

check('search rides as a string token, scope as one of two names', () => {
	const query = Presets.serialize({ search: 'G,K|terran|220-300', scope: 'selection' });
	assert.equal(new URLSearchParams(query).get('search'), 'G,K|terran|220-300');
	assert.equal(new URLSearchParams(query).get('scope'), 'selection');
	assert.deepEqual(Presets.parse(query), { search: 'G,K|terran|220-300', scope: 'selection' });
	// An unconstrained filter adds nothing to the line; junk scope is
	// dropped rather than smuggled through, leaving the menu default.
	assert.equal(Presets.serialize({ search: '', scope: 'selection' }), 'scope=selection');
	assert.deepEqual(Presets.parse('search=M|barren&scope=banana'), { search: 'M|barren' });
	assert.deepEqual(Presets.parse('scope=galaxy'), { scope: 'galaxy' });
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
	assert.equal(d.selrad, Selection.SELRAD_DEFAULT_LOG);
	assert.equal(d.systime, SystemLayer.SYSTIME_DEFAULT);
	assert.deepEqual(d, {
		selrad: 1.69897, evolve: 0,
		exposure: 22, brightness: 1, white: 4, sat: 1.4, headroom: 8, highlight: 1,
		time: 5, wave: 0.6, pattern: 1, apoShare: 0.35, apoForce: 0.22,
		systime: 0, dvmap: 0, dvbudget: 0.35, ship: 'chemical',
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

check('the search section is wired: controls, readout, Search glue and token preset', () => {
	const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf-8');
	for (const id of ['search-scope', 'search-class', 'search-ptype', 'search-tsurf-min',
		'search-tsurf-max', 'search-terran', 'search-belt', 'search-barren', 'search-token',
		'btn-search', 'btn-search-add', 'btn-search-clear', 'val-search', 'sysread']) {
		assert.equal(html.split(`id="${id}"`).length, 2, id);
	}
	const searchAt = html.indexOf('src="core/search.js"');
	const mainAt = html.indexOf('src="main.js"');
	assert.ok(searchAt > 0 && mainAt > searchAt, 'search.js before main.js');
	const main = fs.readFileSync(path.join(SRC, 'main.js'), 'utf-8');
	for (const snippet of [
		'window.Search', 'createSearch()', 'tokenToControls', 'controlsToToken',
		'markSearchStale', 'searchSnapshot', 'sysread.textContent',
		's.search', 's.scope',
	]) {
		assert.ok(main.includes(snippet), snippet);
	}
});

check('the system view is wired: canvas, button, clock slider, view-gated rows', () => {
	const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf-8');
	for (const id of ['system', 'sysmenu', 'btn-system-view', 'sys-view', 'slider-systime', 'val-systime', 'sysread']) {
		assert.equal(html.split(`id="${id}"`).length, 2, id);
	}
	const labelsAt = html.indexOf('src="render/label-layer.js"');
	const systemAt = html.indexOf('src="render/system-layer.js"');
	const mainAt = html.indexOf('src="main.js"');
	assert.ok(labelsAt > 0 && systemAt > labelsAt && mainAt > systemAt, 'script order');
	// The systime row is gated on the open view, the data-view mirror of the
	// data-engine mechanism (§6.5): the gate tag sits in the slider's own row.
	const sliderAt = html.indexOf('id="slider-systime"');
	const row = html.slice(0, sliderAt).lastIndexOf('<div class="menu-row"');
	const tag = html.slice(0, sliderAt).lastIndexOf('data-view="system"');
	assert.ok(row > 0 && tag > row, 'slider sits in the gated row');
	const main = fs.readFileSync(path.join(SRC, 'main.js'), 'utf-8');
	for (const snippet of [
		'window.SystemLayer', 'createSystemLayer(', 'openSystemView(', 'closeSystemView(',
		'toggleSystemView(', 'writeSystemReadout(', '#sysmenu [data-view]',
		'SYSTIME_INDEX_MIN', 'SYSTIME_INDEX_MAX', 'sysTimeRateAt', 's.sysview',
	]) {
		assert.ok(main.includes(snippet), snippet);
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

check('the Milky Way builtin is the Sun-centred preset, frozen on arrival', () => {
	const preset = Presets.builtinById('milkyway');
	assert.equal(preset.label, 'Milky Way');
	assert.deepEqual(preset.view, { time: 0, epoch: 0, fly: true, home: true, constellations: true });
	const settings = Presets.builtinSettings('milkyway');
	assert.equal(settings.type, GalaxyLib.MILKY_WAY_TYPE);
	assert.equal(settings.seed, GalaxyLib.DEFAULT_SEED);
	assert.equal(settings.time, 0);
	assert.deepEqual(settings.engine, ['classic']);
	const query = Presets.builtinQuery('milkyway');
	assert.equal(query, Presets.serialize(settings));
	assert.equal(new URLSearchParams(query).get('time'), '0');
	const model = GalaxyLib.createGalaxy({ type: settings.type, seed: settings.seed, age: settings.age });
	assert.equal(model.milkyWay, true);
	assert.equal(model.home.orbitName, 'Sun');
	assert.deepEqual(model.home.orbitTarget, [0, 0, 0]);
	assert.ok(Math.hypot(model.home.position[0], model.home.position[1], model.home.position[2] - 0.005) < 1e-12);
	const landmarks = require('../src/data/landmarks.js');
	const sun = landmarks.ENTRIES[landmarks.indexOf('Sun')];
	assert.ok(sun && sun.x === 0 && sun.y === 0 && sun.z === 0, 'the preset has no Sun star');
	// The arrival camera, without the page: fly mode, then H, stands 5 pc
	// above the Sun. Orbit-then-home would circle it from 10 pc instead.
	const Camera = require('../src/core/camera.js');
	const cam = Camera.createCamera();
	cam.setFrame(model);
	cam.setMode(Camera.MODE_ORBIT_GC);
	cam.setMode(Camera.MODE_FLY);
	cam.goHome();
	const state = cam.getState();
	assert.equal(state.mode, Camera.MODE_FLY);
	assert.ok(Math.hypot(state.position[0] - model.home.position[0],
		state.position[1] - model.home.position[1],
		state.position[2] - model.home.position[2]) < 1e-9, state.position);
});

check('the Evolve builtin is the same galaxy sent to its first light, running', () => {
	const preset = Presets.builtinById('evolve');
	assert.equal(preset.label, 'Evolve');
	assert.equal(preset.view, undefined);   // settings only: the camera stays put
	const settings = Presets.builtinSettings('evolve');
	assert.equal(settings.type, GalaxyLib.MILKY_WAY_TYPE);
	assert.equal(settings.age, GalaxyLib.AGE_MIN);
	assert.equal(settings.evolve, 1);
	// The top of the star-time slider, so the run is watchable at the default
	// rebuild cadence.
	assert.equal(settings.time, 99);
	const query = Presets.builtinQuery('evolve');
	assert.equal(query, Presets.serialize(settings));
	// A preset that carries both lands on its own epoch: the replay rule reads
	// the age the field was built at, and the line says 0.2 Gyr.
	assert.equal(Presets.parse(query).age, GalaxyLib.AGE_MIN);
	assert.equal(GalaxyLib.evolveStartAge(GalaxyLib.AGE_DEFAULT), GalaxyLib.AGE_MIN);
});

check('the live clock is described and serialized by name', () => {
	assert.equal(Presets.describe({ evolve: 1 }).evolve, 'running');
	assert.equal(Presets.describe({ evolve: 0 }).evolve, 'frozen');
	assert.ok(Presets.serialize({ evolve: 1 }).includes('evolve=1'));
	assert.ok(Presets.buildLlmPrompt(SETTINGS).includes('evolve with star time: running'));
});

check('switching to the Milky Way preset flies home with the figures on', () => {
	const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf-8');
	const main = fs.readFileSync(path.join(SRC, 'main.js'), 'utf-8');
	assert.ok(html.includes('id="preset-builtin"'), 'builtin row');
	assert.ok(main.includes('preset.id'), 'buttons built from BUILTIN');
	assert.ok(main.includes('applyPresetView(preset.view)'), 'arrival view');
	// Fly first, then home: goHome in an orbit mode would circle the Sun
	// instead of standing beside it.
	const view = main.slice(main.indexOf('function applyPresetView'), main.indexOf('function applyBuiltin'));
	const flyAt = view.indexOf('MODE_FLY');
	const homeAt = view.indexOf('goHome()');
	assert.ok(flyAt > 0 && homeAt > flyAt, 'fly before home');
	assert.ok(view.includes('setConstellations'), 'constellation lines');
	assert.ok(view.includes('starTimeRate = view.time'), 'frozen rate');
	assert.ok(view.includes('starTimeMyr = view.epoch'), 'catalog epoch');
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
