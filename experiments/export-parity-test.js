// experiments/export-parity-test.js
// Guard against split brains between the Node API of a src module and the
// window.* API the page uses.
//
// The renderer once called StarRecord.writeRecord, which existed under Node but
// was missing from the browser export — a TypeError at boot that no Node test
// could see. This test loads every module with a fake window, then asserts that
// the two surfaces are one and the same object: same names, same values, same
// shape.
//
// Output: experiments/logs/export-parity.json

'use strict';

const fs = require('fs');
const path = require('path');

// --- Fake page -----------------------------------------------------------
global.window = {};
global.self = global.window;

const MODULES = [
	{ file: '../src/math/hash.js', global: 'HashLib' },
	{ file: '../src/math/density.js', global: 'DensityLib' },
	{ file: '../src/math/galaxy.js', global: 'GalaxyLib' },
	{ file: '../src/math/sampling.js', global: 'SamplingLib' },
	{ file: '../src/math/star-record.js', global: 'StarRecord' },
	{ file: '../src/math/star-types.js', global: 'StarTypesLib' },
	{ file: '../src/math/nebula.js', global: 'NebulaLib' },
	{ file: '../src/math/objects.js', global: 'ObjectsLib' },
	{ file: '../src/math/coords.js', global: 'Coords' },
	{ file: '../src/core/camera.js', global: 'Camera' },
	{ file: '../src/core/input.js', global: 'Input' },
	{ file: '../src/core/selection.js', global: 'Selection' },
	{ file: '../src/core/loop.js', global: 'Loop' },
	{ file: '../src/core/device.js', global: 'Device' },
	{ file: '../src/data/landmarks.js', global: 'Landmarks' },
	{ file: '../src/data/constellations.js', global: 'Constellations' },
	{ file: '../src/render/shaders.js', global: 'GalaxyShaders' },
	{ file: '../src/render/star-sprites.js', global: 'StarRenderer' },
	{ file: '../src/render/label-layer.js', global: 'LabelLayer' },
	{ file: '../src/stream/tile-loader.js', global: 'TileLoader' },
	{ file: '../src/stream/cell-manager.js', global: 'CellManager' },
];

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
	return !!pass;
}

for (const { file, global: name } of MODULES) {
	const before = new Set(Object.keys(global.window));
	let nodeApi = null;
	let loadError = null;
	try {
		nodeApi = require(file);
	} catch (err) {
		loadError = err;
	}
	const added = Object.keys(global.window).filter(k => !before.has(k));
	const winApi = global.window[name];

	check(`${name} loads under Node`, !!nodeApi && !loadError,
		loadError && loadError.message);
	check(`${name} registers exactly one window namespace (${added.join(',') || 'none'})`,
		added.length === 1 && added[0] === name, added);
	check(`${name} exposes the same object in both environments`, nodeApi === winApi,
		{ same: nodeApi === winApi });

	const nodeKeys = Object.keys(nodeApi || {}).sort();
	const winKeys = Object.keys(winApi || {}).sort();
	const nodeOnly = nodeKeys.filter(k => !winKeys.includes(k));
	const winOnly = winKeys.filter(k => !nodeKeys.includes(k));
	check(`${name} has identical key sets (${nodeKeys.length} keys)`,
		nodeOnly.length === 0 && winOnly.length === 0, { nodeOnly, winOnly });

	let mismatched = [];
	for (const key of nodeKeys) {
		if (typeof nodeApi[key] === 'function' || typeof nodeApi[key] === 'object') {
			if (nodeApi[key] !== winApi[key]) mismatched.push(key);
		} else if (nodeApi[key] !== winApi[key]) mismatched.push(key);
	}
	check(`${name} binds every key to the same value`, mismatched.length === 0, mismatched);
}

// The renderer must find its wired shader through the same lookup the
// validator uses; a rename in one place used to be invisible.
{
	const shaders = require('../src/render/shaders.js');
	check('every wired shader resolves in the SHADERS map',
		shaders.WIRED_SHADERS.every(n => typeof shaders.SHADERS[n] === 'string' && shaders.SHADERS[n].length > 0),
		shaders.WIRED_SHADERS);
	check('every SHADER_PART is a non-empty string',
		Object.entries(shaders.SHADER_PARTS).every(([, v]) => typeof v === 'string' && v.length > 0),
		Object.keys(shaders.SHADER_PARTS));
	check('the renderer and the shader map agree on the wired module',
		global.window.GalaxyShaders.SHADERS['star-sprite'] === shaders.SHADERS['star-sprite']);
}

// --- Report --------------------------------------------------------------
let passed = 0;
let failed = 0;
for (const c of checks) {
	if (c.pass) passed++; else failed++;
	console.log(`  ${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.pass ? '' : `  -> ${JSON.stringify(c.detail)}`}`);
}
console.log(`\n${passed}/${checks.length} passed, ${failed} failed`);

const logPath = path.join(__dirname, 'logs', 'export-parity.json');
fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.writeFileSync(logPath, JSON.stringify({
	date: new Date().toISOString(),
	modules: MODULES.length,
	totalChecks: checks.length,
	passed,
	failed,
	checks,
}, null, 2));
console.log(`Wrote ${logPath}`);
console.log('\n=== VERDICT ===');
console.log(failed === 0 ? 'PASS — Node and browser export surfaces match' : `FAIL — ${failed} checks failed`);
process.exit(failed === 0 ? 0 : 1);
