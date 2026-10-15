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
		&& /id="canvas"/.test(html) && /id="labels"/.test(html) && /id="system"/.test(html)
		&& /id="selection-menu"/.test(html) && /id="search-results"/.test(html)
		&& /id="overlay"/.test(html) && /id="error"/.test(html),
		{ css: /style\.css/.test(html), elements: ['canvas', 'labels', 'system', 'selection-menu', 'search-results', 'overlay', 'error'].map(id => html.includes(`id="${id}"`)) });
}

{
	const main = fs.readFileSync(path.join(SRC, 'main.js'), 'utf-8');
	check('the menu iterates the full type table, not the G-key shortlist',
		/for \(const type of galaxy\.GALAXY_TYPES\)/.test(main));
	const exposureDefault = require('../src/render/star-sprites.js').EXPOSURE_DEFAULT;
	check('startup exposure is 22 and the slider agrees',
		exposureDefault === 22 && /id="slider-exposure"[^>]+value="22"/.test(html));
	check('startup stellar rate is 5 Myr/s and freeze resumes that rate',
		/let starTimeRate = 5;/.test(main)
		&& /let lastNonZeroTimeRate = starTimeRate;/.test(main)
		&& /id="slider-star-time"[^>]+value="5"/.test(html));
	check('the page starts in galaxy-centre orbit with unlocked input',
		/camera\.setFrame\(model\);[\s\S]*?camera\.setMode\(window\.Camera\.MODE_ORBIT_GC\);\s*const input = window\.Input\.createInput\(canvas\);\s*input\.setFlyMode\(false\);/.test(main));
	check('input policy follows camera mode after stepping',
		/camera\.step\(dt, input\.state\);[\s\S]*?input\.setFlyMode\(cameraStateForTime\.mode === window\.Camera\.MODE_FLY\);/.test(main));
	check('every element main.js looks up exists in index.html',
		(function () {
			const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
			const used = [...main.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
			const missing = used.filter((id) => !ids.has(id));
			return missing.length === 0;
		})(), 'missing ids');
	check('the sysmenu selector main.js queries is an id in the page',
		/#sysmenu \[data-view\]/.test(main) && /id="sysmenu"/.test(html));
	check('selection state, nearby-centred search, result picking and prior-to-current routing are wired',
		/SelectionStore\.createSelectionStore\(\)/.test(main)
		&& /selectionStore\.selectCurrent\(window\.SelectionStore\.GROUP_SPACE/.test(main)
		&& /recordSystemBodySelection\(body\)/.test(main)
		&& /type: 'planet'/.test(main) && /type: 'other'/.test(main)
		&& /selectionStore\.setAssetPair/.test(main)
		&& /centerX, centerY, centerZ/.test(main)
		&& /searchResultsList\.addEventListener\('click'/.test(main)
		&& /selectedStarEndpoints\(\)/.test(main)
		&& /historyEndpoint\(previous\), historyEndpoint\(current\)/.test(main)
		&& /routeRoundtrip/.test(main)
		&& /selection-swap/.test(html)
		&& /asset-pair-first-set/.test(html));
	// ui.2: the camera and the radius scan judge *drawn* positions, not the birth
	// records the snapshots store. There is no browser to run this in, so the
	// wiring is pinned as text — including the two shapes that must not come back
	// (a fly-to aimed at starSet.x, and the landmarks-only/simple-only follow).
	check('fly-to, the orbit target and the follow resolve drawn positions, not birth snapshots',
		/function memberDrawnPosition\(i, out\) \{\s*return selection\.resolveDrawn\(memberRefFor\(i\), out\);/.test(main)
		&& /memberDrawnPosition\(i, drawnPos\);\s*camera\.flyToStar\(drawnPos\[0\], drawnPos\[1\], drawnPos\[2\]/.test(main)
		&& /selection\.resolveDrawn\(hit, drawnPos\);\s*camera\.setOrbitTarget\(drawnPos\[0\]/.test(main)
		&& /memberDrawnPosition\(p, drawnPos\);[\s\S]{0,400}?camera\.flyToStar\(drawnPos\[0\]/.test(main)
		&& /if \(followKey >= 0 && cameraStateForTime\.mode === window\.Camera\.MODE_ORBIT_OBJECT\) \{\s*followTarget\(\);/.test(main)
		&& /const drawn = memberDrawnPosition\(i, drawnPos\);/.test(main)
		&& !/camera\.flyToStar\(starSet\.x\[/.test(main)
		&& !/simpleLandmarkPosition\(followPos/.test(main)
		&& !/followLandmark/.test(main));
	check('the radius scan is chunked on the picker\'s contract and centred on a drawn position',
		/memberDrawnPosition\(p, aroundCentre\);/.test(main)
		&& /selection\.beginSelectAround\(aroundCentre\[0\], aroundCentre\[1\],/.test(main)
		&& /if \(aroundPending && selection\.selectAroundStep\(SWEEP_SLICE_RECORDS, SWEEP_SLICE_MS\)\) \{\s*applyAroundResult\(\);/.test(main)
		&& /if \(around\.aborted\) \{/.test(main)
		&& !/selection\.selectAround\(/.test(main));
	check('the route endpoints and the readout distance are drawn-space too',
		/x: drawnPos\[0\], y: drawnPos\[1\], z: drawnPos\[2\] \};/.test(main)
		&& /selection\.resolveDrawn\(ref, drawnPos\);\s*return stellarEndpointFrom\(ref, ref\);/.test(main));
	// 0.6 E4: an age change is *not* a re-draw. The epoch places the field the
	// field was drawn into (renderer.setEpoch → orbit.epochMap), the look follows
	// in the renderer's background sweep, and only a new galaxy, seed or star
	// budget goes through redrawField at all. The phase is an accumulator
	// (orbit.advancePatternPhase), so nothing rebases it and nothing carries a
	// theta shift across a draw any more — a run of the clock adds a rate over an
	// interval instead of multiplying the current rate by the whole elapsed
	// clock, which is what the "return back in time every Evolve step" was.
	// Checked as text here because there is no browser to run it in.
	const epochFn = main.match(/function setEpoch\(age\) \{[\s\S]*?\n        \}/);
	const drawFn = main.match(/function redrawField\(next\) \{[\s\S]*?\n        \}/);
	check('an age change places the field through setEpoch: no re-draw, no rebase, no carry',
		!!epochFn && /galaxy\.modelAtAge\(model, /.test(epochFn[0])
		&& /renderer\.setEpoch\(model\);/.test(epochFn[0])
		&& !/regenerateAge|redrawField/.test(epochFn[0])
		&& !!drawFn && /renderer\.regenerate\(model\);/.test(drawFn[0])
		&& /simpleLandmarksRebind\(model\)\) initSimpleLandmarks\(\);/.test(drawFn[0])
		&& /resolveSet\(\);/.test(drawFn[0]),
		drawFn ? drawFn[0].length : null);
	check('nothing rebases the pattern phase: the loop advances it and a draw never turns the field',
		/OrbitLib\.setPatternClock\(starTimeMyr, model\)/.test(main)
		&& /OrbitLib\.resetPatternPhase\(\)/.test(main)
		&& !/rebasePatternPhase|patternPhaseOffset|thetaShift/.test(main));
	// 0.6 E2: the epoch's live clock. The law (quantum, price, drop, hold,
	// replay) is pinned numerically in galaxy-evolution-test.js — what cannot be
	// run here is the wiring: the toggle, the boot gate and the loop's step path,
	// which has to hand the tick the same dtStar the stars just integrated.
	check('the live clock is wired: the toggle, the boot gate and the step path',
		/id="galaxy-evolve"/.test(html) && /id="val-epoch"/.test(html)
		&& /galaxyEvolve\.addEventListener\('change'/.test(main)
		&& /const start = galaxy\.evolveStartAge\(model\.populations\.age\);/.test(main)
		&& /if \(evolveOn\) \{\s*const evolved = galaxy\.evolveAge\(model\.populations\.age, dtStar\);/.test(main)
		&& /if \(evolved !== model\.populations\.age\) setEpoch\(evolved\);/.test(main)
		&& /evolveOn \? galaxy\.evolveStartAge\(params\.age\) : params\.age/.test(main)
		&& /galaxyAge\.step = galaxy\.AGE_STEP;/.test(main));
	check('the epoch readout is the model\'s own age, and the drag applies every frame it changed',
		/valEpoch\.textContent = formatAge\(model\.populations\.age\);/.test(main)
		&& /if \(pendingAge !== null && pendingAge !== model\.populations\.age\) setEpoch\(pendingAge\);/.test(main)
		&& !/AGE_REGEN_INTERVAL/.test(main));
	check('opening a panel releases pointer lock',
		/function releasePanelInput\(\) \{[\s\S]*?document\.exitPointerLock\(\);[\s\S]*?\}/.test(main)
		&& /\} else \{\s*releasePanelInput\(\);/.test(main));
}

// --- 2. No global is read before it is defined --------------------------
{
	const BROWSER_GLOBALS = new Set([
		'devicePixelRatio', 'innerWidth', 'innerHeight', 'addEventListener', 'removeEventListener',
		'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'location', 'navigator',
		'matchMedia', 'Device', 'Presets', 'GalaxyShaders', 'HashLib', 'DensityLib', 'GalaxyLib', 'SamplingLib',
		'StarRecord', 'StarTypesLib', 'PlanetsLib', 'NebulaLib', 'ObjectsLib', 'Coords', 'Camera', 'Input', 'Loop', 'Selection', 'StarSet', 'SelectionStore',
		'Landmarks', 'Constellations', 'StarRenderer', 'LabelLayer', 'SystemLayer',
		'TileLoader', 'CellManager', '__galaxy_catalog', 'self', 'document', 'setTimeout',
	]);
	const defined = new Set();
	const undefinedReads = [];
	const NAMESPACES = ['Device', 'Camera', 'Input', 'Loop', 'Selection', 'StarSet', 'SelectionStore', 'Presets', 'StarRenderer', 'LabelLayer', 'SystemLayer',
		'TileLoader', 'CellManager', 'GalaxyShaders', 'HashLib', 'DensityLib', 'GalaxyLib', 'SamplingLib',
		'StarRecord', 'StarTypesLib', 'PlanetsLib', 'NebulaLib', 'ObjectsLib', 'Coords', 'Landmarks', 'Constellations'];
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
		['../src/math/star-types.js', 'StarTypesLib'], ['../src/math/planets.js', 'PlanetsLib'],
		['../src/math/orbit.js', 'OrbitLib'], ['../src/math/nebula.js', 'NebulaLib'],
		['../src/math/objects.js', 'ObjectsLib'], ['../src/math/clusters.js', 'ClustersLib'],
		['../src/math/coords.js', 'Coords'],
		['../src/core/camera.js', 'Camera'], ['../src/core/input.js', 'Input'],
		['../src/core/selection.js', 'Selection'], ['../src/core/star-set.js', 'StarSet'],
		['../src/core/selection-store.js', 'SelectionStore'], ['../src/core/loop.js', 'Loop'],
		['../src/core/presets.js', 'Presets'],
		['../src/core/device.js', 'Device'],
		['../src/data/landmarks.js', 'Landmarks'], ['../src/data/constellations.js', 'Constellations'],
		['../src/render/shaders.js', 'GalaxyShaders'], ['../src/render/star-sprites.js', 'StarRenderer'],
		['../src/render/label-layer.js', 'LabelLayer'],
		['../src/render/system-layer.js', 'SystemLayer'],
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
		// The schematic view main.js opens on V (§6.5).
		&& typeof global.window.SystemLayer.createSystemLayer === 'function'
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
	const parsed = main.readParams('?stars=5000&catalog=10000&seed=7&exposure=22&engine=apocenter&evolve=1');
	check('readParams reads every documented parameter including the apocenter engine',
		parsed.stars === 5000 && parsed.catalogStars === 10000
		&& parsed.seed === 7 && parsed.exposure === 22 && parsed.engine === 'apocenter'
		&& parsed.evolve === 1, parsed);
	const defaults = main.readParams('');
	check('readParams falls back to the renderer defaults',
		defaults.stars === global.window.StarRenderer.PROCEDURAL_STARS_DEFAULT
		&& defaults.catalogStars === global.window.StarRenderer.CATALOG_BUDGET_DEFAULT
		&& defaults.exposure === null && defaults.evolve === 0, defaults);
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
