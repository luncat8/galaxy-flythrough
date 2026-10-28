// experiments/named-sky-test.js
// The named sky's gate (ui.22): the curated stars and their figures are
// today's Milky Way seen from the Sun, so the checks here are about *when the
// sky exists at all* — the epoch window, the star clock's rate, and the
// exclusivity with the observer's own figures. The defect this replaces was a
// block drawn unconditionally, which put Orion in the sky of a procedural Sb
// at its first light.

'use strict';

const galaxy = require('../src/math/galaxy.js');
const NamedSky = require('../src/core/named-sky.js');
const labelModule = require('../src/render/label-layer.js');
const landmarks = require('../src/data/landmarks.js');
const constellations = require('../src/data/constellations.js');
const cameraModule = require('../src/core/camera.js');

let checks = 0;
const failures = [];
function check(name, cond, detail) {
	checks++;
	if (cond) return;
	failures.push({ name, detail });
	console.log('  FAIL ' + name + (detail === undefined ? '' : '  -> ' + JSON.stringify(detail)));
}

const AGE_REF = galaxy.AGE_REF;
const TOL = NamedSky.EPOCH_TOL_GYR;

// A model is enough of a shape for the gate: it reads `milkyWay` and
// `populations.age` and nothing else.
function model(milkyWay, age) {
	return { milkyWay, populations: { age }, type: milkyWay ? 'SBb' : 'Sb', seed: 42 };
}

// --- 1. The epoch window --------------------------------------------------
{
	const mw = model(true, AGE_REF);
	check('the Milky Way at the reference epoch has its named sky',
		NamedSky.activeOf(mw, 0) && NamedSky.reasonOf(mw, 0) === NamedSky.REASON_OK);
	check('the window is ±1 Gyr, inclusive at both ends',
		NamedSky.activeOf(model(true, AGE_REF - TOL), 0)
		&& NamedSky.activeOf(model(true, AGE_REF + TOL), 0));
	check('a step outside the window closes it',
		!NamedSky.activeOf(model(true, AGE_REF - TOL - 0.001), 0)
		&& NamedSky.reasonOf(model(true, AGE_REF - TOL - 0.001), 0) === NamedSky.REASON_EPOCH);
	check('first light has no named sky — those stars are not formed yet',
		!NamedSky.activeOf(model(true, 0), 0)
		&& NamedSky.reasonOf(model(true, 0), 0) === NamedSky.REASON_EPOCH,
		NamedSky.reasonOf(model(true, 0), 0));
	check('the mid-history epoch the formation checks run at is outside too',
		!NamedSky.activeOf(model(true, 2), 0));
	check('the window the readout quotes is the model\u2019s own ±tolerance', (() => {
		const w = NamedSky.epochWindow();
		return w.from === AGE_REF - TOL && w.to === AGE_REF + TOL;
	})(), NamedSky.epochWindow());
}

// --- 2. The galaxy -------------------------------------------------------
{
	check('a procedural galaxy never has the curated sky, at any epoch',
		NamedSky.reasonOf(model(false, AGE_REF), 0) === NamedSky.REASON_NO_SKY
		&& NamedSky.reasonOf(model(false, 0), 0) === NamedSky.REASON_NO_SKY
		&& !NamedSky.activeOf(model(false, AGE_REF), 0));
	check('the galaxy test comes first: a procedural galaxy at first light is not "epoch"',
		NamedSky.reasonOf(model(false, 0), 0) === NamedSky.REASON_NO_SKY);
	check('a missing model is refused, not assumed present',
		NamedSky.reasonOf(null, 0) === NamedSky.REASON_NO_SKY);
	check('a model with no epoch reads the reference age rather than NaN',
		NamedSky.ageOf({ milkyWay: true }) === AGE_REF && NamedSky.ageOf(null) === AGE_REF);
}

// --- 3. The star clock ---------------------------------------------------
{
	const mw = model(true, AGE_REF);
	check('a frozen clock reads the figures', NamedSky.activeOf(mw, 0));
	check('the default 1 Myr/s reads them', NamedSky.activeOf(mw, 1));
	check('the ceiling is inclusive at 5 Myr/s', NamedSky.activeOf(mw, NamedSky.MAX_RATE_MYR_PER_S));
	check('above it the sky shears past a figure, so it is hidden',
		!NamedSky.activeOf(mw, 99) && NamedSky.reasonOf(mw, 99) === NamedSky.REASON_FAST);
	check('the top clock rate is the case the rule exists for',
		!NamedSky.activeOf(mw, 99) && !NamedSky.activeOf(mw, 50));
	// The ladder's follow stop is negative (−N follows the camera), and a
	// negative rate is still a fast sky.
	check('a negative rate is gated on its magnitude, not its sign',
		!NamedSky.activeOf(mw, -99) && NamedSky.activeOf(mw, -1));
	check('a non-finite rate does not hide the sky', NamedSky.activeOf(mw, NaN));
	check('the epoch is checked before the rate, so a young sky is "epoch" not "fast"',
		NamedSky.reasonOf(model(true, 0), 99) === NamedSky.REASON_EPOCH);
}

// --- 4. The reasons the UI prints ----------------------------------------
{
	const reasons = [NamedSky.REASON_OK, NamedSky.REASON_NO_SKY,
		NamedSky.REASON_EPOCH, NamedSky.REASON_FAST];
	check('every reason has one sentence, and an unknown one falls back',
		reasons.every((r) => typeof NamedSky.describe(r) === 'string' && NamedSky.describe(r).length > 10)
		&& typeof NamedSky.describe('nonsense') === 'string');
	check('the reasons are distinct strings, so a readout cannot confuse two',
		new Set(reasons).size === reasons.length);
	check('the refusal says what to do instead of only what is wrong',
		NamedSky.describe(NamedSky.REASON_NO_SKY).toLowerCase().includes('create')
		&& NamedSky.describe(NamedSky.REASON_FAST).toLowerCase().includes('myr/s'));
}

// --- 5. The label layer obeys it -----------------------------------------
function createMockLayer() {
	const calls = { clearRect: 0, moveTo: 0, lineTo: 0, stroke: 0, fillTexts: [] };
	const ctx = {
		font: '', fillStyle: '', strokeStyle: '', lineWidth: 0, textBaseline: '',
		setTransform() {},
		clearRect() { calls.clearRect++; },
		beginPath() {},
		moveTo() { calls.moveTo++; },
		lineTo() { calls.lineTo++; },
		stroke() { calls.stroke++; },
		arc() {},
		strokeText(text) { calls.fillTexts.push(text); },
		fillText() {},
	};
	const canvas = { width: 0, height: 0, getContext: () => ctx };
	function reset() {
		calls.clearRect = 0; calls.moveTo = 0; calls.lineTo = 0;
		calls.stroke = 0; calls.fillTexts = [];
	}
	return { canvas, calls, reset };
}

// The same aim landmark-test uses: stand at the origin and look at the star,
// so it lands in the centre of the frame and its label is drawn.
function aimAt(cam, x, y, z) {
	const d = Math.hypot(x, y, z);
	cam.setState({
		position: [0, 0, 0],
		yaw: Math.atan2(y, x),
		pitch: Math.asin(Math.max(-1, Math.min(1, z / d))),
	});
}

{
	const W = 1280, H = 800;
	const mock = createMockLayer();
	const layer = labelModule.createLabelLayer(mock.canvas, landmarks, constellations);
	layer.resize(W, H, 1);
	const cam = cameraModule.createCamera();
	const s = landmarks.ENTRIES[landmarks.indexOf('Sirius')];
	aimAt(cam, s.x, s.y, s.z);

	layer.draw(cam, W, H);
	const drewLabels = mock.calls.fillTexts.length;
	const drewLines = mock.calls.lineTo;
	check('the baseline draws the curated labels and figures',
		drewLabels > 0 && drewLines > 0, { drewLabels, drewLines });

	mock.reset();
	layer.setNamedSky(false);
	layer.draw(cam, W, H);
	check('with the named sky off the layer draws no label and no figure line',
		mock.calls.fillTexts.length === 0 && mock.calls.lineTo === 0,
		{ labels: mock.calls.fillTexts.length, lines: mock.calls.lineTo });
	check('turning it off erases the frame it left behind', mock.calls.clearRect >= 1);

	mock.reset();
	layer.setNamedSky(true);
	layer.draw(cam, W, H);
	check('turning it back on restores both',
		mock.calls.fillTexts.length > 0 && mock.calls.lineTo > 0);

	check('the gate is idempotent and reports the state it holds',
		layer.setNamedSky(true) === true && layer.namedSkyActive() === true
		&& layer.setNamedSky(false) === false && layer.namedSkyActive() === false);

	// `enabled` and the gate are different questions: a procedural galaxy has
	// no curated table at all, while a gated Milky Way has one that does not
	// apply right now. Neither draws, but only one of them is a model property.
	layer.setEnabled(false);
	layer.setNamedSky(true);
	check('a model with no named stars is silent even with the gate open',
		!layer.namedSkyActive());
	layer.setEnabled(true);
	check('the gate is a property of the frame, not of the model',
		layer.namedSkyActive());
}

// --- 6. Exclusivity with the observer's own figures ----------------------
{
	const W = 1280, H = 800;
	const mock = createMockLayer();
	const layer = labelModule.createLabelLayer(mock.canvas, landmarks, constellations);
	layer.resize(W, H, 1);
	const cam = cameraModule.createCamera();
	const figure = { count: 3, keys: new Uint32Array([1, 2, 3]), edgeCount: 2,
		edges: new Int32Array([0, 1, 1, 2]) };

	check('no figures means nothing to draw', !layer.asterismsActive());
	layer.setAsterisms(figure);
	check('a figure set with the named sky on does not draw — one sky, one set of lines',
		!layer.asterismsActive());
	layer.setNamedSky(false);
	check('with the named sky gated off, the observer\'s figures are the ones drawn',
		layer.asterismsActive());
	layer.setAsterisms(null);
	check('clearing the figures leaves neither sky drawing lines',
		!layer.asterismsActive());
	layer.setAsterisms({ count: 0, keys: new Uint32Array(0), edgeCount: 0, edges: new Int32Array(0) });
	check('an empty figure set is refused rather than drawn as nothing',
		!layer.asterismsActive());
}

console.log(`\n${checks - failures.length}/${checks} passed, ${failures.length} failed`);
console.log('\n=== VERDICT ===');
console.log(failures.length === 0
	? 'PASS — the named sky exists only where it means something, and never beside another set of figures'
	: `FAIL — ${failures.length} checks failed`);
process.exit(failures.length === 0 ? 0 : 1);
