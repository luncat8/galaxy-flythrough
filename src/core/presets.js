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
// then movement (how it moves), then look (how it is drawn). Boot-only counts
// ride at the end: a pasted preset cannot rebuild the star buffers, so the
// menu hint says they apply on the next boot.
const FIELDS = [
	{ key: 'type', label: 'galaxy type' },
	{ key: 'seed', label: 'seed' },
	{ key: 'age', label: 'age', unit: ' Gyr' },
	{ key: 'engine', label: 'engine' },
	{ key: 'time', label: 'star time', unit: ' Myr/s' },
	{ key: 'wave', label: 'wave damping' },
	{ key: 'pattern', label: 'pattern speed', prefix: 'x' },
	{ key: 'apoShare', label: 'apocenter stars' },
	{ key: 'apoForce', label: 'apocenter force' },
	{ key: 'exposure', label: 'exposure' },
	{ key: 'brightness', label: 'brightness', suffix: 'x' },
	{ key: 'white', label: 'white point' },
	{ key: 'sat', label: 'saturation', suffix: 'x' },
	{ key: 'headroom', label: 'headroom' },
	{ key: 'highlight', label: 'highlight desat' },
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
	for (const field of FIELDS) {
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
	const out = {};
	for (const field of FIELDS) {
		if (!params.has(field.key)) continue;
		const raw = params.get(field.key).trim();
		if (raw === '') continue;
		if (field.key === 'engine') {
			const engines = parseEngineList(raw);
			if (engines.length) out.engine = engines;
			continue;
		}
		if (field.key === 'type') {
			out.type = raw;
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
	if (field.prefix === 'x') return 'x' + value;
	if (field.key === 'time' && value > 0) return '+' + value;
	return String(value) + (field.suffix || '') + (field.unit || '');
}

// The prompt is one describe per group, so a reader sees the star system
// before the look.
function describe(settings) {
	const s = settings || {};
	const byKey = {};
	for (const field of FIELDS) {
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
	for (const key of ['time', 'wave', 'pattern', 'apoShare', 'apoForce']) {
		const field = FIELDS.find((f) => f.key === key);
		if (d[key] !== undefined) lines.push('- ' + field.label + ': ' + d[key]);
	}
	lines.push('- look: ' + ['exposure', 'brightness', 'white', 'sat', 'headroom', 'highlight']
		.filter((key) => d[key] !== undefined)
		.map((key) => key + ' ' + d[key]).join(', '));
	lines.push('- star counts: ' + ['stars', 'catalog']
		.filter((key) => d[key] !== undefined)
		.map((key) => d[key] + ' ' + (key === 'stars' ? 'procedural' : 'catalog budget')).join(', '));
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

const Presets = {
	FIELDS, PROJECT_URL, ENGINE_ORDER, ENGINE_DESCRIPTIONS, TIME_DEFAULT,
	menuDefaults, parseEngineList, serializeEngine, serialize, parse, describe, buildLlmPrompt,
};
if (typeof module !== 'undefined') module.exports = Presets;
if (typeof window !== 'undefined') window.Presets = Presets;
