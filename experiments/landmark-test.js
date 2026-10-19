// experiments/landmark-test.js
// Landmarks & constellations (plan.md §18, 0.1.2): the named-star table, its
// baked galactic positions, the constellation figures, click picking, and the
// label layer's draw/cull/toggle behaviour.
//
// Output: experiments/logs/landmark.json

'use strict';

const path = require('path');
const logFile = require('./log-file.js');

// Alias window so the src modules attach their API here, as in the browser.
globalThis.window = globalThis;

const coords = require('../src/math/coords.js');
const records = require('../src/math/star-record.js');
const cameraModule = require('../src/core/camera.js');
const landmarks = require('../src/data/landmarks.js');
const constellations = require('../src/data/constellations.js');
const selectionModule = require('../src/core/selection.js');
const labelModule = require('../src/render/label-layer.js');
const orbit = require('../src/math/orbit.js');
const galaxy = require('../src/math/galaxy.js');

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
	return !!pass;
}

// --- 1. The shared coordinate conversion --------------------------------
{
	const sirius = coords.raDecParallaxToGalactic(101.287155, -16.716116, 379.21);
	check('Sirius parallax 379.21 mas → 2.637 pc', Math.abs(sirius.distKpc - 0.002637) < 1e-5, sirius.distKpc);
	check('Sirius sits ~9 deg below the galactic plane', Math.abs(sirius.b + 8.9) < 2, sirius.b);
	const gc = coords.raDecParallaxToGalactic(266.4051, -28.9362, 0.122);
	check('the galactic centre direction lands at +X ≈ 8.2 kpc', Math.abs(gc.x - 8.2) < 0.5 && Math.abs(gc.y) < 1, { x: gc.x, y: gc.y });
	check('absolute magnitude: 10 pc is the reference distance',
		coords.absoluteMagnitude(1, 10) === 1 && Math.abs(coords.absoluteMagnitude(1, 100) + 4) < 1e-12,
		[coords.absoluteMagnitude(1, 10), coords.absoluteMagnitude(1, 100)]);
}

// --- 2. projectToScreen matches the shader's projection -----------------
const W = 800, H = 600;
{
	const cam = cameraModule.createCamera();
	cam.setState({ position: [0, 0, 0], yaw: 0, pitch: 0 });
	const vp = cam.buildViewProj(W / H);
	const out = new Float32Array(3);
	check('a point straight ahead projects to the screen centre',
		coords.projectToScreen(vp, 1, 0, 0, 0, 0, 0, W, H, out)
		&& Math.abs(out[0] - W / 2) < 0.5 && Math.abs(out[1] - H / 2) < 0.5, [out[0], out[1]]);
	check('a point above the view axis lands in the upper half of the screen',
		coords.projectToScreen(vp, 1, 0, 0.2, 0, 0, 0, W, H, out) && out[1] < H / 2, out[1]);
	check('a point behind the camera is rejected (clip.w <= 0)',
		!coords.projectToScreen(vp, -1, 0, 0, 0, 0, 0, W, H, out));
}

// --- 3. The landmark table ------------------------------------------------
{
	check('the table holds 30–60 named stars', landmarks.count >= 30 && landmarks.count <= 60, landmarks.count);

	const names = new Set();
	let duplicateName = null;
	const seenSky = new Set();
	let duplicateSky = null;
	for (const e of landmarks.ENTRIES) {
		if (names.has(e.name)) duplicateName = e.name;
		names.add(e.name);
		const key = e.ra.toFixed(3) + '|' + e.dec.toFixed(3);
		if (seenSky.has(key)) duplicateSky = e.name;
		seenSky.add(key);
	}
	check('no landmark name is duplicated', duplicateName === null, duplicateName);
	check('no two landmarks share the same sky position', duplicateSky === null, duplicateSky);

	let fieldsOk = true;
	for (const e of landmarks.ENTRIES) {
		const sun = e.name === 'Sun';
		if (!(e.ra >= 0 && e.ra < 360) || !(e.dec >= -90 && e.dec <= 90)) fieldsOk = false;
		if (!sun && !(e.distPc > 0)) fieldsOk = false;
		if (sun && e.distPc !== 0) fieldsOk = false;
		if (!Number.isFinite(e.mag) || !Number.isInteger(e.colorIndex) || e.colorIndex < 0 || e.colorIndex >= records.SPECTRAL_CLASSES.length) fieldsOk = false;
		// IAU abbreviations are mixed case: CMa, UMa, PsA... The Sun is the
		// origin, not a member of a figure, so it carries no abbreviation.
		if (!sun && !/^[A-Z][A-Za-z]{2}$/.test(e.constellation)) fieldsOk = false;
		if (sun && e.constellation !== '') fieldsOk = false;
	}
	check('every entry has valid ra/dec/distPc/mag/colorIndex/constellation', fieldsOk);

	let radiusOk = true, magOk = true, recomputeOk = true;
	for (let i = 0; i < landmarks.count; i++) {
		const e = landmarks.ENTRIES[i];
		const r = Math.hypot(e.x, e.y, e.z);
		if (Math.abs(r - e.distPc / 1000) > 1e-9 * Math.max(1, r)) radiusOk = false;
		const expectedMag = e.name === 'Sun' ? landmarks.SUN_ABS_MAG : coords.absoluteMagnitude(e.mag, e.distPc);
		if (Math.abs(e.absMag - expectedMag) > 1e-9) magOk = false;
		const g = coords.raDecParallaxToGalactic(e.ra, e.dec, 1000 / e.distPc);
		if (Math.abs(g.x - e.x) + Math.abs(g.y - e.y) + Math.abs(g.z - e.z) > 1e-12) recomputeOk = false;
	}
	check('every baked |xyz| equals distPc', radiusOk);
	check('every baked absMag is m − 5·log10(d_pc) + 5', magOk);
	check('every baked xyz recomputes from ra/dec/distPc through coords.js', recomputeOk);

	const siriusIdx = landmarks.indexOf('Sirius');
	const sirius = landmarks.ENTRIES[siriusIdx];
	check('Sirius is a landmark with its catalog coordinates and class',
		siriusIdx >= 0 && Math.abs(sirius.ra - 101.287) < 0.01 && Math.abs(sirius.dec + 16.716) < 0.01
		&& Math.abs(sirius.distPc - 2.64) < 0.05 && Math.abs(sirius.mag + 1.46) < 0.02
		&& sirius.constellation === 'CMa' && sirius.colorIndex === records.spectralClassIndex('A'),
		sirius && { distPc: sirius.distPc, mag: sirius.mag, constellation: sirius.constellation });

	const sunIdx = landmarks.indexOf('Sun');
	const sun = landmarks.ENTRIES[sunIdx];
	check('the Sun is the frame origin, a G star of solar absolute magnitude',
		sunIdx >= 0 && sun.x === 0 && sun.y === 0 && sun.z === 0
		&& sun.distPc === 0 && sun.absMag === landmarks.SUN_ABS_MAG
		&& sun.colorIndex === records.spectralClassIndex('G') && sun.mag === -26.74,
		sun && { x: sun.x, absMag: sun.absMag, mag: sun.mag });

	let brightest = -1;
	for (let i = 0; i < landmarks.count; i++) {
		if (landmarks.ENTRIES[i].name === 'Sun') continue;
		if (brightest < 0 || landmarks.ENTRIES[i].mag < landmarks.ENTRIES[brightest].mag) brightest = i;
	}
	check('the brightest night-sky landmark is Sirius', brightest === siriusIdx, landmarks.ENTRIES[brightest].name);

	let tooClose = 0;
	for (const e of landmarks.ENTRIES) if (e.name !== 'Sun' && e.distPc < 1) tooClose++;
	check('no night-sky landmark sits on the Sun (the camera homes 5 pc above it)', tooClose === 0);
	check('indexOf resolves every entry and rejects unknown names',
		landmarks.ENTRIES.every((e, i) => landmarks.indexOf(e.name) === i) && landmarks.indexOf('NotAStar') === -1);
}

// --- 4. The constellation figures ------------------------------------------
{
	check('the figures are ~15 named shapes with unique names',
		constellations.count === 15 && new Set(constellations.LINES.map(f => f.name)).size === constellations.count,
		constellations.count);

	let resolved = true, selfEdge = false, emptyFigure = false;
	for (const figure of constellations.LINES) {
		if (figure.edges.length === 0) emptyFigure = true;
		for (let i = 0; i < figure.edges.length; i++) {
			const idx = figure.edges[i];
			if (idx < 0 || idx >= landmarks.count) resolved = false;
		}
		for (let i = 0; i < figure.edges.length; i += 2) {
			if (figure.edges[i] === figure.edges[i + 1]) selfEdge = true;
		}
	}
	check('every edge endpoint resolves to a landmark index', resolved);
	check('no edge connects a star to itself', !selfEdge);
	check('every figure has at least one edge', !emptyFigure);
	check('the edge count is sane (≥ 25 segments for 15 figures)', constellations.edgeCount >= 25, constellations.edgeCount);

	const names = constellations.LINES.map(f => f.name);
	check('Orion and Ursa Major are among the figures',
		names.includes('Orion') && names.includes('Ursa Major'), names.join(','));
	const orion = constellations.LINES[names.indexOf('Orion')];
	check('Orion carries the full hourglass (≥ 6 edges)', orion.edges.length / 2 >= 6, orion.edges.length / 2);
}

// --- 5. Picking ------------------------------------------------------------
function aimAt(cam, x, y, z) {
	const d = Math.hypot(x, y, z);
	cam.setState({
		position: [0, 0, 0],
		yaw: Math.atan2(y, x),
		pitch: Math.asin(Math.max(-1, Math.min(1, z / d))),
	});
}

{
	check('the pick radius is the documented 20 px', selectionModule.PICK_RADIUS_PX === 20);

	// Real data: aim at a named star, click the centre, get exactly that star.
	const cam = cameraModule.createCamera();
	const siriusIdx = landmarks.indexOf('Sirius');
	const s = landmarks.ENTRIES[siriusIdx];
	aimAt(cam, s.x, s.y, s.z);
	const sel = selectionModule.createSelection(cam, landmarks);
	check('picking the screen centre while aimed at Sirius selects Sirius',
		sel.pick(W / 2, H / 2, W, H) === siriusIdx, sel.pick(W / 2, H / 2, W, H));

	const betIdx = landmarks.indexOf('Betelgeuse');
	const b = landmarks.ENTRIES[betIdx];
	aimAt(cam, b.x, b.y, b.z);
	check('picking the screen centre while aimed at Betelgeuse selects Betelgeuse',
		sel.pick(W / 2, H / 2, W, H) === betIdx, sel.pick(W / 2, H / 2, W, H));

	// Synthetic scene: two stars ~5 px apart, exact nearest-wins behaviour.
	const synthetic = {
		count: 2,
		positions: Float64Array.of(1, 0, 0, 1, 0.01, 0),
		ENTRIES: [{ name: 'A', x: 1, y: 0, z: 0 }, { name: 'B', x: 1, y: 0.01, z: 0 }],
	};
	aimAt(cam, 1, 0, 0);
	const sel2 = selectionModule.createSelection(cam, synthetic);
	const centre = sel2.pick(W / 2, H / 2, W, H);
	const offB = sel2.pick(W / 2 - 5, H / 2, W, H);
	check('the pick at the exact centre is the centred star', centre === 0, centre);
	check('a pick 5 px off-centre takes the nearer of two close stars', offB === 1, offB);
	check('a pick beyond 20 px of every star selects nothing',
		sel2.pick(W / 2 + 25, H / 2, W, H) === -1);
	aimAt(cam, -1, 0, 0);
	check('stars behind the camera are never picked', sel2.pick(W / 2, H / 2, W, H) === -1);
	check('a degenerate viewport picks nothing', sel2.pick(10, 10, 0, 0) === -1);
}

// --- 6. The label layer -----------------------------------------------------
function createMockLayer() {
	const calls = { clearRect: 0, beginPath: 0, moveTo: 0, lineTo: 0, stroke: 0, arc: 0, fillTexts: [], strokeTexts: 0, transforms: [], movePoints: [], linePoints: [] };
	const ctx = {
		font: '', fillStyle: '', strokeStyle: '', lineWidth: 0, textBaseline: '',
		setTransform(...a) { calls.transforms.push(a); },
		clearRect() { calls.clearRect++; },
		beginPath() { calls.beginPath++; },
		moveTo(x, y) { calls.moveTo++; calls.movePoints.push([x, y]); },
		lineTo(x, y) { calls.lineTo++; calls.linePoints.push([x, y]); },
		stroke() { calls.stroke++; },
		arc() { calls.arc++; },
		strokeText(text) { calls.strokeTexts++; calls.fillTexts.push(text); },
		fillText() {},
	};
	const canvas = { width: 0, height: 0, getContext: () => ctx };
	function reset() {
		calls.clearRect = 0; calls.beginPath = 0; calls.moveTo = 0; calls.lineTo = 0;
		calls.stroke = 0; calls.arc = 0; calls.fillTexts = []; calls.strokeTexts = 0;
		calls.movePoints = []; calls.linePoints = [];
	}
	return { canvas, calls, reset };
}

{
	const mock = createMockLayer();
	const layer = labelModule.createLabelLayer(mock.canvas, landmarks, constellations);
	layer.resize(W, H, 2);
	check('resize sizes the backing store by the device pixel ratio and scales the context',
		mock.canvas.width === W * 2 && mock.canvas.height === H * 2
		&& mock.calls.transforms.length === 1 && mock.calls.transforms[0][0] === 2,
		{ width: mock.canvas.width, height: mock.canvas.height });

	const cam = cameraModule.createCamera();
	const siriusIdx = landmarks.indexOf('Sirius');
	const s = landmarks.ENTRIES[siriusIdx];
	aimAt(cam, s.x, s.y, s.z);

	layer.draw(cam, W, H);
	check('one draw clears the canvas exactly once', mock.calls.clearRect === 1, mock.calls.clearRect);
	check('the aimed-at star gets a label (fillText with its constant name)',
		mock.calls.fillTexts.includes('Sirius'), mock.calls.fillTexts.length);

	// A generated galaxy has no named stars, and the layer is a fixed table: so
	// "nothing to say about this model" is a flag on the layer, not a second one.
	mock.reset();
	layer.setEnabled(false);
	layer.draw(cam, W, H);
	check('disabling erases what was drawn and stops drawing over it',
		mock.calls.clearRect === 1 && mock.calls.fillTexts.length === 0, mock.calls.clearRect);
	mock.reset();
	layer.setEnabled(false);
	layer.draw(cam, W, H);
	check('a repeat disable clears nothing (no flicker on a frame where nothing changed)',
		mock.calls.clearRect === 0, mock.calls.clearRect);
	layer.setEnabled(true);
	layer.draw(cam, W, H);
	check('re-enabling brings the labels back for the Milky Way preset',
		mock.calls.fillTexts.includes('Sirius'), mock.calls.fillTexts.length);
	check('every label gets a dark halo stroke for readability',
		mock.calls.strokeTexts === mock.calls.fillTexts.length,
		{ stroke: mock.calls.strokeTexts, fill: mock.calls.fillTexts.length });
	check('constellation lines are on by default and drawn as segments',
		mock.calls.beginPath >= 1 && mock.calls.moveTo >= 10 && mock.calls.lineTo === mock.calls.moveTo,
		{ moveTo: mock.calls.moveTo, lineTo: mock.calls.lineTo });

	mock.reset();
	layer.toggleConstellations();
	layer.draw(cam, W, H);
	check('P toggles the lines off (no segments drawn)',
		layer.constellationsVisible() === false && mock.calls.moveTo === 0, mock.calls.moveTo);
	check('labels still draw with the lines off', mock.calls.fillTexts.includes('Sirius'));

	mock.reset();
	aimAt(cam, -s.x, -s.y, -s.z);
	layer.draw(cam, W, H);
	check('labels behind the camera are culled (Sirius is gone when facing away)',
		!mock.calls.fillTexts.includes('Sirius'), mock.calls.fillTexts.length);

	mock.reset();
	aimAt(cam, s.x, s.y, s.z);
	layer.setSelected(siriusIdx);
	layer.draw(cam, W, H);
	check('the selected star gets a ring when visible', mock.calls.arc === 1, mock.calls.arc);
	mock.reset();
	aimAt(cam, -s.x, -s.y, -s.z);
	layer.draw(cam, W, H);
	check('the selection ring is culled with its star', mock.calls.arc === 0, mock.calls.arc);
}

// --- 7. Labels and picks under the engine-mask dispatch ----------------------
// The rendered star, its label and its pick target must agree for every
// engine mask (movement-parity-plan). The reference re-states the dispatch
// table — simple mirror else classic else birth, then apocenter(birth) for
// the selected subset — and the click/label positions must land on it.
{
	const model = galaxy.createGalaxy({ type: 'SBb', seed: 3 });
	const c = model.centre;
	const savedEngine = orbit.getEngine();
	const savedShare = orbit.getApocenterShare();
	const savedForce = orbit.getApocenterForce();
	const savedDamp = orbit.getWaveDamping();
	orbit.setWaveDamping(0);
	orbit.setApocenterForce(orbit.APOCENTER_ECC_MAX);
	const T = 300;

	// Two synthetic landmarks near the model centre; the second offset is
	// nudged deterministically until the pair straddles the share-0.5 subset.
	const posA = [c.x + 4.0, 0.3, 0.05];
	let posB = [c.x + 3.2, -0.6, 0.1];
	orbit.setApocenterShare(0.5);
	for (let k = 0; k < 40 && orbit.apocenterSelected(...posA) === orbit.apocenterSelected(...posB); k++) {
		posB = [c.x + 3.2, -0.6 + 0.05 * (k + 1), 0.1];
	}
	orbit.setApocenterShare(savedShare);
	const synth = {
		count: 2,
		positions: Float64Array.of(...posA, ...posB),
		ENTRIES: [
			{ name: 'A', x: posA[0], y: posA[1], z: posA[2], colorIndex: 5 },
			{ name: 'B', x: posB[0], y: posB[1], z: posB[2], colorIndex: 5 },
		],
	};
	const synthLines = { LINES: [{ name: 'AB', edges: [0, 1] }] };

	const refOut = new Float64Array(3);
	function reference(mask, i, time) {
		const bx = synth.positions[i * 3], by = synth.positions[i * 3 + 1], bz = synth.positions[i * 3 + 2];
		const fam = orbit.familyFromColorIndex(synth.ENTRIES[i].colorIndex);
		if (mask & orbit.ENGINE_SIMPLE) {
			const P = orbit.simpleDerived(model, {});
			const phase = orbit.simplePatternPhase(model, time);
			const r0 = Math.hypot(bx - c.x, by - c.y);
			const th = orbit.simpleStepTheta(Math.atan2(by - c.y, bx - c.x), r0,
				orbit.simpleEccOf(0), orbit.simplePeriOf(0), fam, P, phase, time, bz);
			orbit.simplePositionFromTheta(refOut, th, bx, by, bz, 0, fam, orbit.simpleEccMax(model), model);
		} else if (mask & orbit.ENGINE_CLASSIC) {
			orbit.orbitPosition(refOut, bx, by, bz, fam, 0, 0, time, model);
		} else {
			refOut[0] = bx; refOut[1] = by; refOut[2] = bz;
		}
		if ((mask & orbit.ENGINE_APOCENTER) && time !== 0 && orbit.apocenterSelected(bx, by, bz)) {
			orbit.apocenterPosition(refOut, bx, by, bz, fam, 0, 0, time, model);
		}
		return refOut;
	}

	const cam = cameraModule.createCamera();
	const sel = selectionModule.createSelection(cam, synth);
	const mock = createMockLayer();
	const layer = labelModule.createLabelLayer(mock.canvas, synth, synthLines);
	layer.resize(W, H, 1);
	const proj = new Float32Array(3);

	function runMask(mask, share) {
		orbit.setEngine(mask);
		orbit.setApocenterShare(share);
		const f32pos = new Float32Array(synth.positions.length);
		f32pos.set(synth.positions);
		orbit.simpleLandmarksInit(f32pos, Uint8Array.of(5, 5), 2, model);
		if (mask & orbit.ENGINE_SIMPLE) orbit.simpleLandmarksStep(T, T);
		sel.setOrbitState(model, T);
		layer.setOrbitState(model, T);
		const expected = [Array.from(reference(mask, 0, T)), Array.from(reference(mask, 1, T))];
		let pickOk = true, lineOk = true, movedCount = 0, birthWrong = 0;
		for (let i = 0; i < 2; i++) {
			aimAt(cam, expected[i][0], expected[i][1], expected[i][2]);
			if (sel.pick(W / 2, H / 2, W, H) !== i) pickOk = false;
			// A star that really moved: clicking its BIRTH spot must miss it
			// (whenever the dispatched position projects far from that spot —
			// otherwise the two click targets are indistinguishable).
			const bx = synth.positions[i * 3], by = synth.positions[i * 3 + 1], bz = synth.positions[i * 3 + 2];
			if (Math.hypot(expected[i][0] - bx, expected[i][1] - by, expected[i][2] - bz) > 0.2) {
				movedCount++;
				aimAt(cam, bx, by, bz);
				const vpB = cam.buildViewProj(W / H);
				const far = coords.projectToScreen(vpB, expected[i][0], expected[i][1], expected[i][2],
					0, 0, 0, W, H, proj) && Math.hypot(proj[0] - W / 2, proj[1] - H / 2) > 25;
				if (far && sel.pick(W / 2, H / 2, W, H) === i) birthWrong++;
			}
		}
		// The constellation line's endpoints are the projected dispatch
		// positions of both stars, in one draw.
		aimAt(cam, expected[0][0], expected[0][1], expected[0][2]);
		mock.reset();
		layer.draw(cam, W, H);
		const vp = cam.buildViewProj(W / H);
		if (mock.calls.movePoints.length !== 1 || mock.calls.linePoints.length !== 1) lineOk = false;
		else for (const [pt, idx] of [[mock.calls.movePoints[0], 0], [mock.calls.linePoints[0], 1]]) {
			if (!coords.projectToScreen(vp, expected[idx][0], expected[idx][1], expected[idx][2],
				cam.cameraPos[0], cam.cameraPos[1], cam.cameraPos[2], W, H, proj)
				|| Math.hypot(pt[0] - proj[0], pt[1] - proj[1]) > 1.5) lineOk = false;
		}
		return { pickOk, lineOk, movedCount, birthWrong };
	}

	orbit.setApocenterShare(1);
	let allPickOk = true, allLineOk = true, movedTotal = 0, birthWrongTotal = 0;
	for (const mask of [1, 2, 3, 4, 5, 6, 7]) {
		const r = runMask(mask, 1);
		if (!r.pickOk) allPickOk = false;
		if (!r.lineOk) allLineOk = false;
		movedTotal += r.movedCount;
		birthWrongTotal += r.birthWrong;
	}
	check('picking lands on the dispatched position for every mask 1–7 (share 1)',
		allPickOk && movedTotal >= 7, { allPickOk, movedTotal });
	check('label lines connect the dispatched positions for every mask 1–7', allLineOk);
	check('clicking a moved star at its birth spot misses — the pick target followed the dispatch',
		birthWrongTotal === 0, { birthWrongTotal });

	// The share-0.5 subset: the picked positions follow the SAME partition as
	// the birth hash — one landmark guided, the other on the baseline.
	const r05 = runMask(orbit.ENGINE_APOCENTER, 0.5);
	const selA = orbit.apocenterSelected(posA[0], posA[1], posA[2]);
	const selB = orbit.apocenterSelected(posB[0], posB[1], posB[2]);
	check('under share 0.5 the pick targets follow the birth-hash subset (one guided, one frozen)',
		r05.pickOk && selA !== selB, { pickOk: r05.pickOk, selA, selB });

	orbit.setEngine(savedEngine);
	orbit.setApocenterShare(savedShare);
	orbit.setApocenterForce(savedForce);
	orbit.setWaveDamping(savedDamp);
}

// --- Report ------------------------------------------------------------------
let passed = 0;
let failed = 0;
for (const c of checks) {
	if (c.pass) passed++; else failed++;
	console.log(`  ${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.pass ? '' : `  -> ${JSON.stringify(c.detail)}`}`);
}
console.log(`\n${passed}/${checks.length} passed, ${failed} failed`);

const logPath = path.join(__dirname, 'logs', 'landmark.json');
logFile.writeLog(logPath, {
	date: new Date().toISOString(),
	landmarks: landmarks.count,
	constellations: constellations.count,
	edges: constellations.edgeCount,
	totalChecks: checks.length,
	passed,
	failed,
	checks,
});
console.log('\n=== VERDICT ===');
console.log(failed === 0 ? 'PASS — landmarks, constellations and picking behave as documented' : `FAIL — ${failed} checks failed`);
process.exit(failed === 0 ? 0 : 1);
