// src/core/presets.js
// Settings presets (archive/copy-paste-preset-prompt.md): the whole settings
// menu as one copyable text line that can be pasted back, saved to a file and
// loaded from one — plus the prompt that hands the same star system to an LLM
// working in another project.
//
// The preset language is the URL language: the key=value pairs the page boots
// from, in one fixed order. Boot parsing stays in main.js readParams; applying
// a pasted preset is main.js glue, because only it owns the renderer, the
// model and the sliders. This file is the pure part: defaults, serialisation,
// parsing and the prompt text, shared by the page and the tests.

'use strict';

const PROJECT_URL = 'https://github.com/luncat8/galaxy-flythrough';

// The preset fields in serialized order — galaxy first (what the system is),
// then movement (how it moves), then look (how it is drawn), then the search
// query (what the viewer asked for). Boot-only counts ride at the end: a
// pasted preset cannot rebuild the star buffers, so the menu hint says they
// apply on the next boot. The result list itself is transient, like the
// camera position — only the filter and the scope are preset state (0.5.2).
//
// `engine` on a field names the movement pass that reads it: such a field is
// part of the preset only while that pass is selected. Copying a system whose
// apocenter pass is off must not carry the apocenter knobs — they describe a
// pass that is not running, and pasting them back would reconfigure a hidden
// control. The menu hides the same rows, so the text line is what is on screen.
const FIELDS = [
	{ key: 'type', label: 'galaxy type' },
	{ key: 'seed', label: 'seed' },
	{ key: 'age', label: 'age', unit: ' Gyr' },
	// The epoch's live clock (0.6 E2): the toggle 0/1, beside the epoch it runs.
	{ key: 'evolve', label: 'evolve with star time' },
	{ key: 'engine', label: 'engine' },
	{ key: 'time', label: 'star time', unit: ' Myr/s' },
	{ key: 'wave', label: 'wave damping' },
	{ key: 'pattern', label: 'pattern speed', prefix: 'x' },
	{ key: 'apoShare', label: 'apocenter stars', engine: 'apocenter' },
	{ key: 'apoForce', label: 'apocenter force', engine: 'apocenter' },
	{ key: 'selrad', label: 'select radius', unit: ' ly (log)' },
	{ key: 'exposure', label: 'exposure' },
	{ key: 'brightness', label: 'brightness', suffix: 'x' },
	{ key: 'white', label: 'white point' },
	{ key: 'sat', label: 'saturation', suffix: 'x' },
	{ key: 'headroom', label: 'headroom' },
	{ key: 'highlight', label: 'highlight desat' },
	{ key: 'search', label: 'search filter' },
	{ key: 'scope', label: 'search scope' },
	// System view (0.5.3, plan §9.4): the toggle serialized 0/1, and the view's
	// own clock in y/s. The selection *contents* are not preset state, so a
	// pasted sysview=1 with no primary opens nothing — an honest no-op.
	{ key: 'sysview', label: 'system view' },
	{ key: 'systime', label: 'system time', unit: ' y/s' },
	// Which render the open view shows: 0 the schematic, 1 the classic
	// delta-v map, 2 the rail map (0.5.6). 1 is what 0.5.4 wrote, so a pasted
	// old preset lands on the render it was copied from.
	{ key: 'dvmap', label: 'system render' },
	{ key: 'dvbudget', label: 'energy budget' },
	{ key: 'ship', label: 'ship class' },
	{ key: 'stars', label: 'procedural stars' },
	{ key: 'catalog', label: 'catalog budget' },
];

// What the Defaults button restores and an absent preset key falls back to.
// The numbers are owned by the modules that clamp them; `time` is main.js's
// startup stellar rate. Resolved lazily: this file loads before the modules
// it reads from are guaranteed to be present in a Node test.
const TIME_DEFAULT = 5;
function menuDefaults() {
	const g = typeof window !== 'undefined' ? window : global;
	const r = g.StarRenderer;
	const o = g.OrbitLib;
		return {
			// Owned by selection.js like every other numeric default (plan §9.4).
			selrad: g.Selection ? g.Selection.SELRAD_DEFAULT_LOG : 1.69897,
			// The live clock is off unless asked for (E2); a frozen epoch is what
			// every pre-0.6 preset means.
			evolve: 0,
		exposure: r.EXPOSURE_DEFAULT,
		brightness: r.LINEAR_EXPOSURE_DEFAULT,
		white: r.WHITE_POINT_DEFAULT,
		sat: r.SATURATION_DEFAULT,
		headroom: r.HEADROOM_DEFAULT,
		highlight: r.HIGHLIGHT_DESAT_DEFAULT,
		time: TIME_DEFAULT,
		wave: o.WAVE_DAMPING_UI_DEFAULT,
		pattern: o.PATTERN_SCALE_UI_DEFAULT,
		apoShare: o.APOCENTER_SHARE_UI_DEFAULT,
		apoForce: o.APOCENTER_FORCE_UI_DEFAULT,
		// The system view's own clock, owned by system-layer.js (plan §6.4):
		// 0, the frozen default. Whether the view is *open* is working state
		// like the search results — the Defaults button does not close it.
		systime: g.SystemLayer ? g.SystemLayer.SYSTIME_DEFAULT : 0,
		dvmap: g.SystemLayer ? g.SystemLayer.VIEW_DEFAULT : 0,
		dvbudget: g.SystemLayer ? g.SystemLayer.BUDGET_DEFAULT : 0.35, ship: 'chemical',
	};
}

// One engine name per composable pass, in mask order.
const ENGINE_ORDER = ['classic', 'simple', 'apocenter'];
const ENGINE_DESCRIPTIONS = {
	classic: 'classic — closed-form orbits on a rotating pattern, the stable base',
	simple: 'simple — friction force field, adjustable and game-friendly',
	apocenter: 'apocenter — guided ellipses aiming apsides at the density ridges',
};

// 'classic+simple' | 'classic' | 'simple,apocenter' → ['classic', ...] in
// ENGINE_ORDER order. Junk names are dropped; an empty list means classic.
function parseEngineList(text) {
	const wanted = String(text === undefined || text === null ? '' : text)
		.toLowerCase().split(/[^a-z]+/);
	return ENGINE_ORDER.filter((name) => wanted.includes(name));
}

// The engine selection a settings object carries, or null when it carries
// none: a partial preset that never mentions the engine cannot be pruned
// against one, so it keeps whatever it has.
function engineListOf(settings) {
	const value = settings ? settings.engine : undefined;
	if (value === undefined || value === null || value === '') return null;
	const list = Array.isArray(value) ? value : parseEngineList(value);
	return ENGINE_ORDER.filter((name) => list.includes(name));
}

// Is this field part of the preset under that engine selection? Only the
// engine-owned fields can answer no.
function fieldActive(field, engines) {
	return !field.engine || !engines || engines.includes(field.engine);
}

// The FIELDS subset a selection actually uses — the menu reads it to decide
// which rows to show, serialize/parse/describe to decide what to carry.
function activeFields(settings) {
	const engines = engineListOf(settings);
	return FIELDS.filter((field) => fieldActive(field, engines));
}

function serializeEngine(value) {
	const list = Array.isArray(value) ? value : parseEngineList(value);
	const names = ENGINE_ORDER.filter((name) => list.includes(name));
	return (names.length ? names : ['classic']).join('+');
}

// Numbers at six significant figures: enough for every slider here, and
// Number(x.toPrecision(6)) drops the trailing zeros so 22 stays "22".
function formatValue(value) {
	if (typeof value === 'number') return String(Number(value.toPrecision(6)));
	if (Array.isArray(value)) return serializeEngine(value);
	return String(value);
}

// Settings → "type=SBb&seed=42&…". Known keys in FIELDS order, unknown keys
// dropped, absent keys dropped: a partial preset applies only what it carries.
function serialize(settings) {
	const s = settings || {};
	const pairs = [];
	for (const field of activeFields(s)) {
		const value = s[field.key];
		if (value === undefined || value === null || value === '') continue;
		pairs.push(field.key + '=' + encodeURIComponent(formatValue(value)));
	}
	return pairs.join('&');
}

// The inverse. Returns only the keys the query carries; numbers that are not
// finite numbers are ignored, so a hand-edited preset cannot NaN the page.
function parse(query) {
	const params = new URLSearchParams(String(query || ''));
	const selected = engineListOf({ engine: params.get('engine') });
	const out = {};
	for (const field of FIELDS) {
		if (!fieldActive(field, selected && selected.length ? selected : null)) continue;
		if (!params.has(field.key)) continue;
		const raw = params.get(field.key).trim();
		if (raw === '') continue;
		if (field.key === 'engine') {
			if (selected && selected.length) out.engine = selected;
			continue;
		}
		if (field.key === 'ship') {
			if (['chemical', 'nuclear', 'fusion', 'stardrive', 'generation'].includes(raw)) out.ship = raw;
			continue;
		}
		if (field.key === 'type' || field.key === 'search') {
			out[field.key] = raw;
			continue;
		}
		// Only the two scopes the menu offers survive: junk cannot smuggle
		// a third scope into the page, it just leaves the menu default.
		if (field.key === 'scope') {
			if (raw === 'selection' || raw === 'galaxy') out.scope = raw;
			continue;
		}
		const value = Number(raw);
		if (Number.isFinite(value)) out[field.key] = value;
	}
	return out;
}

// "0.35" → "35%", "+5" for positive rates, engine lists as names.
function describeValue(field, value) {
	if (field.key === 'apoShare') return Math.round(value * 100) + '%';
	if (field.key === 'engine') return serializeEngine(value).split('+').join(', ');
	if (field.key === 'sysview') return value ? 'open' : 'closed';
	if (field.key === 'evolve') return value ? 'running' : 'frozen';
	if (field.key === 'dvmap') {
		const scope = typeof window !== 'undefined' ? window : global;
		const names = scope.SystemLayer ? scope.SystemLayer.VIEW_NAMES : null;
		return names && names[value] ? names[value] : String(value);
	}
	if (field.prefix === 'x') return 'x' + value;
	if (field.key === 'time' && value > 0) return '+' + value;
	return String(value) + (field.suffix || '') + (field.unit || '');
}

// The prompt is one describe per group, so a reader sees the star system
// before the look.
function describe(settings) {
	const s = settings || {};
	const byKey = {};
	for (const field of activeFields(s)) {
		const value = s[field.key];
		if (value === undefined || value === null || value === '') continue;
		byKey[field.key] = describeValue(field, value);
	}
	return byKey;
}

// The LLM prompt (the draft in archive/copy-paste-preset-prompt.md): hand the
// selected star system to a model working in another project, describe the
// approach for one with no internet access, and make it ask the two scoping
// questions before writing code.
function buildLlmPrompt(settings) {
	const d = describe(settings);
	const lines = [];
	lines.push('Implement this star system in my project:');
	lines.push('');
	lines.push('- star system: ' + ['type ' + (d.type || 'SBb'), 'seed ' + (d.seed || '42'),
		'age ' + (d.age || '13.5 Gyr')].join(', '));
	lines.push('- star movement stability engine: ' + (d.engine || 'classic'));
	for (const key of ['time', 'evolve', 'wave', 'pattern', 'apoShare', 'apoForce', 'selrad', 'sysview', 'systime', 'dvmap', 'dvbudget', 'ship']) {
		const field = FIELDS.find((f) => f.key === key);
		if (d[key] !== undefined) lines.push('- ' + field.label + ': ' + d[key]);
	}
	lines.push('- look: ' + ['exposure', 'brightness', 'white', 'sat', 'headroom', 'highlight']
		.filter((key) => d[key] !== undefined)
		.map((key) => key + ' ' + d[key]).join(', '));
	lines.push('- star counts: ' + ['stars', 'catalog']
		.filter((key) => d[key] !== undefined)
		.map((key) => d[key] + ' ' + (key === 'stars' ? 'procedural' : 'catalog budget')).join(', '));
	// The query, not the results: what the viewer asked for reproduces from
	// the filter and the scope, the way the system reproduces from type and
	// seed. An unconstrained filter is absent, never an empty line.
	if (d.search !== undefined) lines.push('- search filter: ' + d.search);
	if (d.scope !== undefined) lines.push('- search scope: ' + d.scope);
	lines.push('');
	lines.push('Reference implementation: ' + PROJECT_URL + ' (WebGPU, vanilla JS, no build step).');
	lines.push('If you have no internet access, this short description is the whole approach:');
	lines.push('- A galaxy is a type (Hubble class) + seed + age. From these, an analytical 3D');
	lines.push('  density field is built per type: thin and thick disc, a central bulge or boxy');
	lines.push('  bar, a halo, and log-spiral arm modulation. Truncation lives inside the field.');
	lines.push('- Stars are placed by sampling that field through a stable hash of (seed, cell,');
	lines.push('  slot) — no PRNG state, the same seed rebuilds the identical galaxy, and a');
	lines.push('  different visible-star count changes only the sampling rate, never the density.');
	lines.push('- Stars move on precomputed orbit families whose time-averaged distribution');
	lines.push('  reproduces the density field — not on gravity. The classic engine is the');
	lines.push('  closed-form base; two optional composable engines are a simple friction field');
	lines.push('  and apocenter-guided ellipses whose apsides aim at the spiral/bar ridges.');
	lines.push('');
	lines.push('Before writing code, ask me two questions:');
	lines.push('1. Do I want all galaxy types (the full Hubble sequence) or only this selected one?');
	lines.push('2. Should you port the system into my current project, or write a standalone');
	lines.push('   WebGPU example like the reference?');
	return lines.join('\n');
}

// Named built-in presets. A query is the settings line (the same language
// serialize emits). `view` is what the page does after that line lands:
// camera mode and constellation lines are not menu fields, so they are not
// in the line. The Milky Way one is the unmodified preset — the only model
// that has a Sun — frozen, in fly mode, at the H position beside the Sun,
// with the figures drawn.
const BUILTIN = [
	{
		id: 'milkyway',
		label: 'Milky Way',
		title: 'The Sun-centred Milky Way. Freezes star time, flies home beside the Sun, and turns constellation lines on.',
		view: { time: 0, epoch: 0, fly: true, home: true, constellations: true },
	},
	{
		id: 'evolve',
		label: 'Evolve',
		title: 'A barred spiral watched from its infancy: the star clock at the top rate and the epoch running with it, one 0.1 Gyr step per 100 Myr of star time. Each step re-draws the field (~0.7 s at 300k stars), so a lower star budget is smoother — star counts apply at the next boot.',
	},
];

function builtinById(id) {
	for (let i = 0; i < BUILTIN.length; i++) {
		if (BUILTIN[i].id === id) return BUILTIN[i];
	}
	return null;
}

// The settings line a built-in preset applies. Lazy: the numbers belong to
// the modules that clamp them, and this file loads before those modules in
// the page. An unknown id is an empty line, which apply treats as a no-op.
function builtinSettings(id) {
	if (id !== 'milkyway' && id !== 'evolve') return null;
	const g = typeof window !== 'undefined' ? window : global;
	const galaxy = g.GalaxyLib;
	const renderer = g.StarRenderer;
	// The evolve preset is the same galaxy sent back to its first light with the
	// star clock at the slider's top rate: the run needs no view, so it carries
	// settings only.
	const over = id === 'evolve' ? { age: galaxy.AGE_MIN, time: 99, evolve: 1 } : { time: 0 };
	return Object.assign({
		type: galaxy.MILKY_WAY_TYPE,
		seed: galaxy.DEFAULT_SEED,
		age: galaxy.AGE_DEFAULT,
		engine: ['classic'],
		stars: renderer.PROCEDURAL_STARS_DEFAULT,
		catalog: renderer.CATALOG_BUDGET_DEFAULT,
	}, menuDefaults(), over);
}

function builtinQuery(id) {
	const settings = builtinSettings(id);
	return settings ? serialize(settings) : '';
}

const Presets = {
	FIELDS, PROJECT_URL, ENGINE_ORDER, ENGINE_DESCRIPTIONS, TIME_DEFAULT,
	BUILTIN, builtinById, builtinSettings, builtinQuery,
	menuDefaults, parseEngineList, serializeEngine, engineListOf, fieldActive, activeFields,
	serialize, parse, describe, buildLlmPrompt,
};
if (typeof module !== 'undefined') module.exports = Presets;
if (typeof window !== 'undefined') window.Presets = Presets;
