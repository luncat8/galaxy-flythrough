// experiments/m1-smoke-test.js
// Wiring smoke test for the runtime. There is no browser in CI, and the page
// has no module system to fall back on, so two things can only be checked
// statically: that index.html loads every source file exactly once, and that
// nothing reads a global before the file that defines it has run.
//
// It also loads every module under a fake window and runs a short end-to-end
// (sample -> derive -> encode -> bundle -> loader) so a broken pipeline is a
// red test rather than a black canvas.
//
// Output: experiments/logs/m1-smoke.json

'use strict';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
global.window = global.window || global;

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
	return !!pass;
}

function walk(dir, base) {
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		const rel = path.posix.join(base, entry.name);
		if (entry.isDirectory()) out.push(...walk(full, rel));
		else if (entry.name.endsWith('.js')) out.push(rel);
	}
	return out;
}

// --- 1. The page loads exactly the source tree, in dependency order ------
const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf-8');
const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map(m => m[1]);
const sourceFiles = walk(SRC, '').filter(f => f !== 'data/tiles/catalog.js').sort();
{
	check('index.html loads main.js last', scripts[scripts.length - 1] === 'main.js', scripts[scripts.length - 1]);
	check('index.html loads every source file exactly once',
		scripts.length === new Set(scripts).size
		&& JSON.stringify([...scripts].sort()) === JSON.stringify(sourceFiles),
		{ scripts: scripts.length, sources: sourceFiles.length, missing: sourceFiles.filter(f => !scripts.includes(f)) });
	check('every script index.html references exists on disk',
		scripts.every(s => fs.existsSync(path.join(SRC, s))),
		scripts.filter(s => !fs.existsSync(path.join(SRC, s))));
	check('index.html has no leftover inline WGSL',
		!/text\/x-wgsl/.test(html), 'wgsl blocks');
	check('index.html references the stylesheet and the overlay elements',
		/<link[^>]+href="style\.css"/.test(html)
		&& /id="canvas"/.test(html) && /id="labels"/.test(html) && /id="overlay"/.test(html) && /id="error"/.test(html),
		{ css: /style\.css/.test(html), elements: ['canvas', 'labels', 'overlay', 'error'].map(id => html.includes(`id="${id}"`)) });
}

{
	const main = fs.readFileSync(path.join(SRC, 'main.js'), 'utf-8');
	check('the menu iterates the full type table, not the G-key shortlist',
		/for \(const type of galaxy\.GALAXY_TYPES\)/.test(main));
}

// --- 2. No global is read before it is defined --------------------------
{
	const BROWSER_GLOBALS = new Set([
		'devicePixelRatio', 'innerWidth', 'innerHeight', 'addEventListener', 'removeEventListener',
		'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'location', 'navigator',
		'matchMedia', 'Device', 'GalaxyShaders', 'HashLib', 'DensityLib', 'GalaxyLib', 'SamplingLib',
		'StarRecord', 'StarTypesLib', 'NebulaLib', 'Coords', 'Camera', 'Input', 'Loop', 'Selection',
		'Landmarks', 'Constellations', 'StarRenderer', 'LabelLayer',
		'TileLoader', 'CellManager', '__galaxy_catalog', 'self', 'document', 'setTimeout',
	]);
	const defined = new Set();
	const undefinedReads = [];
	const NAMESPACES = ['Device', 'Camera', 'Input', 'Loop', 'Selection', 'StarRenderer', 'LabelLayer',
		'TileLoader', 'CellManager', 'GalaxyShaders', 'HashLib', 'DensityLib', 'GalaxyLib', 'SamplingLib',
		'StarRecord', 'StarTypesLib', 'NebulaLib', 'Coords', 'Landmarks', 'Constellations'];
	for (const file of scripts) {
		const text = fs.readFileSync(path.join(SRC, file), 'utf-8');
		// Registers its own namespace before anything else can read it.
		for (const m of text.matchAll(/window\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=[^=]/g)) defined.add(m[1]);
		for (const m of text.matchAll(/window\.([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
			const name = m[1];
			const after = text.slice(m.index + m[0].length).replace(/^\s+/, '');
			if (after.startsWith('=') && !after.startsWith('==')) continue;   // assignment, not a read
			if (!NAMESPACES.includes(name)) continue;
			if (!defined.has(name)) undefinedReads.push(`${file}: window.${name}`);
		}
	}
	check('every src module namespace is defined before it is read',
		undefinedReads.length === 0, undefinedReads);
	check('all module namespaces are registered by the time main.js runs',
		NAMESPACES.every(n => defined.has(n)),
		[...defined].filter(n => n !== '__galaxy_catalog'));
}

// --- 3. Modules load and expose a usable surface ------------------------
{
	const namespaces = [
		['../src/math/hash.js', 'HashLib'], ['../src/math/density.js', 'DensityLib'],
		['../src/math/galaxy.js', 'GalaxyLib'],
		['../src/math/sampling.js', 'SamplingLib'], ['../src/math/star-record.js', 'StarRecord'],
		['../src/math/star-types.js', 'StarTypesLib'], ['../src/math/nebula.js', 'NebulaLib'],
		['../src/math/coords.js', 'Coords'],
		['../src/core/camera.js', 'Camera'], ['../src/core/input.js', 'Input'],
		['../src/core/selection.js', 'Selection'], ['../src/core/loop.js', 'Loop'],
		['../src/core/device.js', 'Device'],
		['../src/data/landmarks.js', 'Landmarks'], ['../src/data/constellations.js', 'Constellations'],
		['../src/render/shaders.js', 'GalaxyShaders'], ['../src/render/star-sprites.js', 'StarRenderer'],
		['../src/render/label-layer.js', 'LabelLayer'],
		['../src/stream/tile-loader.js', 'TileLoader'], ['../src/stream/cell-manager.js', 'CellManager'],
	];
	for (const [file, name] of namespaces) {
		let api = null;
		try {
			api = require(file);
		} catch (err) {
			check(`${name} loads under Node`, false, err.message);
			continue;
		}
		check(`${name} loads under Node and is registered on window`,
			typeof api === 'object' && api !== null && global.window[name] === api,
			{ keys: Object.keys(api || {}).length });
	}

	// The entry points main.js actually calls.
	check('the runtime entry points main.js uses all exist',
		typeof global.window.Device.initDevice === 'function'
		&& typeof global.window.Camera.createCamera === 'function'
		&& typeof global.window.Input.createInput === 'function'
		&& typeof global.window.Loop.createLoop === 'function'
		&& typeof global.window.StarRenderer.createStarRenderer === 'function'
		&& typeof global.window.TileLoader.loadCatalog === 'function'
		&& typeof global.window.CellManager.createCellManager === 'function'
		&& typeof global.window.GalaxyLib.createGalaxy === 'function'
		&& typeof global.window.GalaxyLib.packDensityParams === 'function'
		&& typeof global.window.Camera.createCamera().setFrame === 'function'
		// The two calls a galaxy change makes on the draw side: rebuild the field,
		// and silence the label layer for a model that has no named stars.
		&& typeof global.window.LabelLayer.createLabelLayer({ getContext: () => null },
			global.window.Landmarks, global.window.Constellations).setEnabled === 'function');

	const mainSrc = fs.readFileSync(path.join(SRC, 'main.js'), 'utf-8');
	check('main.js reads the wired shader through the same map the validator uses',
		/main\.js/.test('main.js') && typeof global.window.GalaxyShaders.SHADERS['star-sprite'] === 'string');
	check('main.js does not reference removed modules',
		!/star-distant|split-double|precomputeRhoMax|sampleStars\b/.test(mainSrc), 'legacy names');
}

// --- 4. The shipped catalog asset loads --------------------------------
{
	const assetPath = path.join(SRC, 'data', 'tiles', 'catalog.js');
	check('the catalog bundle is present', fs.existsSync(assetPath));
	if (fs.existsSync(assetPath)) {
		const bundle = require(assetPath);
		const manifest = global.window.TileLoader.prepareBundle(bundle);
		check('the shipped catalog prepares into a manifest',
			manifest.cellCount > 0 && manifest.starCount > 0
			&& manifest.bandNames.join(',') === 'near,medium,far',
			{ cells: manifest.cellCount, stars: manifest.starCount, bands: manifest.bandNames });
		check('the shipped catalog carries non-degenerate streaming radii',
			Array.from(manifest.bandRadius).every(r => r > 0), Array.from(manifest.bandRadius));
		const mainSrc = fs.readFileSync(path.join(SRC, 'main.js'), 'utf-8');
		const loaded = (mainSrc.match(/loadCatalog\(\s*'([^']+)'/) || [])[1];
		check('main.js loads the asset at the path the encoder writes',
			loaded === 'data/tiles/catalog.js', loaded);
	}
}

// --- 5. Boot parameters -------------------------------------------------
{
	const main = require('../src/main.js');
	check('main.js exposes its helpers without booting in Node',
		typeof main.boot === 'function' && typeof main.readParams === 'function');
	const parsed = main.readParams('?stars=5000&catalog=10000&seed=7&exposure=22');
	check('readParams reads every documented parameter',
		parsed.stars === 5000 && parsed.catalogStars === 10000
		&& parsed.seed === 7 && parsed.exposure === 22, parsed);
	const defaults = main.readParams('');
	check('readParams falls back to the renderer defaults',
		defaults.stars === global.window.StarRenderer.PROCEDURAL_STARS_DEFAULT
		&& defaults.catalogStars === global.window.StarRenderer.CATALOG_BUDGET_DEFAULT
		&& defaults.exposure === null, defaults);
	const junk = main.readParams('?stars=abc&catalog=&seed=NaN');
	check('readParams ignores non-numeric values',
		junk.stars === global.window.StarRenderer.PROCEDURAL_STARS_DEFAULT
		&& junk.catalogStars === global.window.StarRenderer.CATALOG_BUDGET_DEFAULT
		&& junk.seed === 42, junk);
}

// --- 6. The page's real loading model: one shared global scope ----------
// require() gives every module its own scope, which hides the one failure
// classic <script> tags add: two files declaring the same top-level const is a
// SyntaxError when the second one loads, and a namespace read at load time
// (camera.js reads window.DensityLib for the orbit centre) must find the
// earlier script's export. Evaluate every script in index.html order inside
// one vm context with a fake window, exactly as the browser would.
{
	const vm = require('vm');
	const page = {
		addEventListener() {}, removeEventListener() {},
		devicePixelRatio: 1, location: { search: '' }, navigator: {},
		requestAnimationFrame: () => 1, cancelAnimationFrame() {},
		performance: { now: () => 0 }, console, URLSearchParams,
		document: { addEventListener() {}, getElementById: () => null },
	};
	page.window = page;
	page.self = page;
	const context = vm.createContext(page);
	let failure = null;
	for (const file of scripts) {
		try {
			new vm.Script(fs.readFileSync(path.join(SRC, file), 'utf-8'), { filename: file }).runInContext(context);
		} catch (err) {
			failure = `${file}: ${err.constructor.name}: ${err.message}`;
			break;
		}
	}
	check('every script evaluates in one shared global scope, in page order (no duplicate top-level names)',
		failure === null, failure);
	check('camera.js finds the orbit centre through window.GalaxyLib when loaded as a page script',
		failure === null && Array.from(page.Camera.GALACTIC_CENTRE_TARGET).join(',') === '8.178,0,0'
		&& page.Camera.createCamera().getState().modeName === 'fly');
	check('the page scope builds a model per type, so ?type=Sc boots',
		failure === null && page.GalaxyLib && page.GalaxyLib.GALAXY_TYPES.length === 19
		&& page.GalaxyLib.createGalaxy({ type: 'Sc' }).arms.pitchDeg === 15
		&& page.GalaxyLib.createGalaxy({ type: 'E4' }).thin.amp === 0,
		failure || (page.GalaxyLib && page.GalaxyLib.GALAXY_TYPES));
	check('the page scope bakes the landmark table and resolves every constellation edge',
		failure === null && page.Landmarks && page.Constellations
		&& page.Landmarks.count >= 30 && page.Landmarks.count <= 60
		&& page.Constellations.count === 15 && page.Constellations.edgeCount >= 25,
		failure || { landmarks: page.Landmarks && page.Landmarks.count, figures: page.Constellations && page.Constellations.count });
}

// --- 7. Short end-to-end ------------------------------------------------
{
	const sampling = require('../src/math/sampling.js');
	const starTypes = require('../src/math/star-types.js');
	const records = require('../src/math/star-record.js');
	const galaxy = require('../src/math/galaxy.js');
	const model = galaxy.MILKY_WAY;
	const buf = sampling.sampleGalaxyStars(model, 99, 500);
	check('the end-to-end sample has the requested stars', buf.count === 500, buf.count);
	const record = {};
	starTypes.deriveStar(model, 1234, buf.component[0], buf.R[0], buf.distToArm[0], record);
	check('a sampled star derives a complete record',
		Number.isFinite(record.mass) && Number.isFinite(record.absMag)
		&& typeof record.spectralClass === 'string' && Number.isFinite(record.teff),
		{ mass: record.mass, absMag: record.absMag, spectralClass: record.spectralClass });
	const bytes = new Uint8Array(records.RECORD_BYTES);
	const view = new DataView(bytes.buffer);
	records.writeRecord(view, 0, buf.x[0], buf.y[0], buf.z[0],
		record.colorIndex, record.absMag, records.FLAG_VISIBLE, 0);
	const back = records.readRecord(view, 0);
	check('a packed record round-trips through StarPacked',
		back.visible
		&& Math.abs(back.x - Math.fround(buf.x[0])) === 0
		&& Math.abs(back.absMag - record.absMag) < records.ABS_MAG_SPAN / 255 + 1e-6,
		{ x: back.x, absMag: back.absMag });
	// Ten entries: nine classes plus the dedicated RGe slot the metal-poor
	// spheroid-giant shift lands on (star-types cannot classify an RGe, only
	// shift into it).
	check('the color LUT covers every spectral class',
		records.buildColorLUT().length === 256 * 4 && records.SPECTRAL_CLASSES.length === 10,
		records.SPECTRAL_CLASSES.length);
}

// --- Report --------------------------------------------------------------
let passed = 0;
let failed = 0;
for (const c of checks) {
	if (c.pass) passed++; else failed++;
	console.log(`  ${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.pass ? '' : `  -> ${JSON.stringify(c.detail)}`}`);
}
console.log(`\n${passed}/${checks.length} passed, ${failed} failed`);

const logPath = path.join(__dirname, 'logs', 'm1-smoke.json');
fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.writeFileSync(logPath, JSON.stringify({
	date: new Date().toISOString(),
	scripts,
	sourceFiles,
	totalChecks: checks.length,
	passed,
	failed,
	checks,
}, null, 2));
console.log(`Wrote ${logPath}`);
console.log('\n=== VERDICT ===');
console.log(failed === 0 ? 'PASS — the runtime is wired consistently' : `FAIL — ${failed} checks failed`);
process.exit(failed === 0 ? 0 : 1);
