// experiments/view-modes-layer-test.js
// The app's view-modes layer (render/view-modes-layer.js): the CPU half that
// the WebGPU page cannot show in a unit test. The rewrite (view-modes.7) is
// pinned where the old layer failed in the browser:
//
//   - "nearest" is nearest of EVERYTHING the frame draws (all five blocks,
//     field stars included), not a catalog-only subset;
//   - the query measures the *drawn* sky at the running star time and stores
//     the *birth* record (the dispatch applies the motion once);
//   - the pick follows the sky as star time moves it (the flat-map bug).
//
// Plus the parts that still hold: the selected-key resolution, the per-entry
// landmark/record dispatch, the camera basis and both layouts, the paint and
// the opacity blit, the auto-range freeze and the setter clamps.
//
// Run: node experiments/view-modes-layer-test.js

'use strict';

const fs = require('fs');
const path = require('path');

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail: pass ? undefined : detail });
	console.log(`  ${pass ? 'OK  ' : 'FAIL'} ${name}${pass ? '' : `  -> ${JSON.stringify(detail)}`}`);
}

// The modules register on window.* like in a browser.
global.window = global;

const ViewModesLayer = require('../src/render/view-modes-layer.js');
const Field = require('../src/math/view-modes-field.js');
const Orbit = require('../src/math/orbit.js');
const Galaxy = require('../src/math/galaxy.js');
const Rec = require('../src/math/star-record.js');
const Landmarks = require('../src/data/landmarks.js');

// --- canvas stubs ---------------------------------------------------------
// Every 2D call is a counted no-op; createImageData allocates a real buffer
// because the painter writes through it.
function makeContext(canvas) {
	return {
		canvas,
		fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1,
		font: '', textAlign: '', textBaseline: '',
		fillRect: () => {}, clearRect: () => {}, strokeRect: () => {},
		beginPath: () => {}, moveTo: () => {}, lineTo: () => {}, closePath: () => {},
		stroke: () => {}, fill: () => {}, save: () => {}, restore: () => {},
		scale: () => {}, translate: () => {}, arc: () => {},
		setLineDash: () => {},
		fillText: () => {}, strokeText: () => {},
		setTransform: () => {}, drawImage: () => { calls.drawImage++; },
		createLinearGradient: () => ({ addColorStop: () => {} }),
		measureText: () => ({ width: 8 }),
		createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
		putImageData: () => { calls.putImageData++; },
		getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
	};
}
const calls = { drawImage: 0, putImageData: 0 };

function makeCanvas() {
	const canvas = {
		width: 0, height: 0,
		style: { display: '' },
		clientWidth: 640, clientHeight: 360,
		getContext() {
			if (!canvas._ctx) canvas._ctx = makeContext(canvas);
			return canvas._ctx;
		},
	};
	return canvas;
}

global.document = { createElement: () => makeCanvas() };

// --- a renderer's worth of blocks -----------------------------------------
// The REAL five-block staging layout starBlocks() returns: field, landmark,
// object (capacity, unwritten), local gap-fill and catalog — one staging view,
// identity keys beside them. The old test's two-block 'stars' mock is exactly
// what hid the catalog-only bug.
const REC = Rec.RECORD_BYTES;
const FIELD = 60;
const LANDMARKS = 4;
const OBJECT_CAP = 8;
const LOCAL = 6;
const CATALOG = 10;
const TOTAL = FIELD + LANDMARKS + OBJECT_CAP + LOCAL + CATALOG;
const FIELD_BASE = 0;
const LANDMARK_BASE = FIELD;
const OBJECT_BASE = FIELD + LANDMARKS;
const LOCAL_BASE = OBJECT_BASE + OBJECT_CAP;
const CATALOG_BASE = LOCAL_BASE + LOCAL;

const staging = new ArrayBuffer(TOTAL * REC);
const view = new DataView(staging);
const identity = new Uint32Array(TOTAL);

function writeSlot(slot, x, y, z, packed) {
	view.setFloat32(slot * REC, Math.fround(x), true);
	view.setFloat32(slot * REC + 4, Math.fround(y), true);
	view.setFloat32(slot * REC + 8, Math.fround(z), true);
	view.setUint32(slot * REC + 12, packed, true);
}

// Field stars sit on a ring far from the eye; invisible every 7th record (the
// index must skip it). The nearest real stars are FIELD stars — the catalog
// block is deliberately far away, so a catalog-only pick cannot win.
const EYE = [0, 0, 0];
for (let i = 0; i < FIELD; i++) {
	const r = 0.5 + 0.01 * i;
	const a = i * 0.7;
	const visible = i % 7 !== 3;
	writeSlot(FIELD_BASE + i, Math.cos(a) * r, Math.sin(a) * r, 0.02 * i - 0.5,
		Rec.packPacked(i % 10, 5, visible ? Rec.FLAG_VISIBLE : 0, 20));
	identity[FIELD_BASE + i] = 0xF000 + i;
}
for (let i = 0; i < LANDMARKS; i++) {
	writeSlot(LANDMARK_BASE + i, 3 + i, i * 0.3, i * 0.1,
		Rec.packPacked(i, 5, Rec.FLAG_VISIBLE | Rec.FLAG_LANDMARK, 0));
	identity[LANDMARK_BASE + i] = 0xA000 + i;
}
for (let i = 0; i < LOCAL; i++) {
	writeSlot(LOCAL_BASE + i, 2 + 0.1 * i, 1 + 0.1 * i, 0.5,
		Rec.packPacked(i % 10, 5, Rec.FLAG_VISIBLE, 30));
	identity[LOCAL_BASE + i] = 0xC000 + i;
}
// The catalog block: FAR away (10 kpc), so it can never enter the nearest set.
for (let i = 0; i < CATALOG; i++) {
	writeSlot(CATALOG_BASE + i, 10 + i, 10, 10,
		Rec.packPacked(i % 10, 5, Rec.FLAG_VISIBLE, 40));
	identity[CATALOG_BASE + i] = 0xD000 + i;
}

const blockInfo = {
	identity,
	view,
	blocks: [
		{ kind: 'field', offset: FIELD_BASE, count: FIELD },
		{ kind: 'landmark', offset: LANDMARK_BASE, count: LANDMARKS },
		{ kind: 'object', offset: OBJECT_BASE, count: 0 },
		{ kind: 'local', offset: LOCAL_BASE, count: LOCAL },
		{ kind: 'catalog', offset: CATALOG_BASE, count: CATALOG },
	],
	// Like the real app: total is CAPACITY, never the live count — the layer
	// must not compare the two (the old rebuild-every-frame stall did).
	total: TOTAL,
	dynamicVersion: 3,
	member: { age: null, component: null },
};

const selection = {
	count: 0, primary: -1,
	keys: new Uint32Array(8),
	bufferIdx: new Int32Array(8),
};

const model = Galaxy.MILKY_WAY;
Orbit.setEpochBase(model);
Orbit.setEngine('classic');

const camera = {
	cameraPos: new Float32Array([EYE[0], EYE[1], EYE[2], 1]),
	forward: new Float32Array([1, 0, 0]),
	right: new Float32Array([0, -1, 0]),
	up: new Float32Array([0, 0, 1]),
	fovY: Math.PI / 3,
};

const canvas = makeCanvas();
const layer = ViewModesLayer.createViewModesLayer(canvas, {
	camera,
	model: () => model,
	starBlocks: () => blockInfo,
	selection: () => selection,
	landmarks: Landmarks,
});

// --- boot defaults (view-modes.8): the map is opt-in -----------------------
check('a fresh layer boots off with nearest anchors and 256 stars',
	layer.settings.mode === 'off' && layer.settings.contours === false
	&& layer.settings.source === 'nearest' && layer.settings.anchors === 256
	&& ViewModesLayer.DEFAULTS.mode === 'off' && ViewModesLayer.DEFAULTS.source === 'nearest'
	&& ViewModesLayer.DEFAULTS.anchors === 256,
	{ ...layer.settings });
const panelHtml = fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8');
check('the GUI checks nearest, not constellations, by default',
	/name="vm-source" value="nearest" checked/.test(panelHtml)
	&& !/name="vm-source" value="constellations" checked/.test(panelHtml), null);

const env = {
	starTimeMyr: 0,
	width: 640,
	height: 360,
	dpr: 1,
	hidden: false,
};

function stepFrames(n) {
	for (let i = 0; i < n; i++) layer.step(0.016, env);
}

// A brute-force truth over the same staging view: every visible record,
// dispatched at `time` exactly the way the sprite pass does.
function truthNearest(want, time, eye) {
	const p = new Float64Array(3);
	const list = [];
	for (let s = 0; s < TOTAL; s++) {
		const packed = view.getUint32(s * REC + 12, true);
		if ((packed & 0x00010000) === 0) continue;
		const bx = view.getFloat32(s * REC, true);
		const by = view.getFloat32(s * REC + 4, true);
		const bz = view.getFloat32(s * REC + 8, true);
		if (s >= LANDMARK_BASE && s < LANDMARK_BASE + blockInfo.blocks[1].count) {
			Orbit.engineLandmarkPosition(p, s - LANDMARK_BASE, bx, by, bz, packed & 0xFF, time, model);
		} else {
			Orbit.engineRecordPosition(p, bx, by, bz, packed, time, model);
		}
		list.push({ slot: s, d: Math.hypot(p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]) });
	}
	list.sort((a, b) => a.d - b.d);
	return list.slice(0, want);
}

// --- setters clamps --------------------------------------------------------
{
	layer.set({ sigmaDeg: 99, anchors: 9000, opacity: 5, relief: -3, resH: 9999, chartSpanDeg: 1 });
	check('the setters clamp to the panel ranges (and reject an unknown budget)',
		layer.settings.sigmaDeg === 20 && layer.settings.anchors === 500
		&& layer.settings.opacity === 1 && layer.settings.relief === 0
		&& layer.settings.resH === 512 && layer.settings.chartSpanDeg === 15,
		{ ...layer.settings });
	layer.set({ budget: 'warp' });
	check('an unknown budget is ignored (the settings keep the old one)',
		layer.settings.budget === 'balanced', layer.settings.budget);
	layer.set({ mode: 'wobble' });
	check('an unknown render type falls back to off', layer.settings.mode === 'off',
		layer.settings.mode);
	layer.setMode('height');
	check('M-cycle order is height → spread → gradient → off → height',
		['height', 'spread', 'gradient', 'off', 'height'].every((m, i, a) => {
			if (i === 0) return true;
			return layer.cycleMode() === m;
		}) && layer.settings.mode === 'height');
	layer.set({ sigmaDeg: 3, anchors: 88, opacity: 1, relief: 6, resH: 0, chartSpanDeg: 360 });
}

// --- the resident-sky list: every visible record of every block ------------
{
	stepFrames(1);
	const sky = layer.internal.sky;
	check('the sky list takes every visible resident record (all five blocks)',
		sky.n === FIELD - Math.ceil(FIELD / 7) + LANDMARKS + LOCAL + CATALOG,
		{ n: sky.n });
	check('the landmark block range is captured for the per-entry dispatch',
		sky.landmarkBase === LANDMARK_BASE && sky.landmarkCount === LANDMARKS,
		{ base: sky.landmarkBase, count: sky.landmarkCount });
	const invisible = [];
	for (let i = 0; i < sky.n; i++) {
		const s = sky.slot[i];
		if ((view.getUint32(s * REC + 12, true) & 0x00010000) === 0) invisible.push(s);
	}
	check('invisible (thinned) records never enter the list', invisible.length === 0, invisible);
	check('the capacity-vs-live-count difference does not rebuild the sky every frame', (() => {
		const v0 = sky.version;
		layer.internal.sky.cursor = 99;    // a sweep in flight would reset this
		stepFrames(1);
		return sky.version === v0 && sky.cursor === 99;
	})(), { version: sky.version });
}

// --- nearest: nearest of the WHOLE drawn sky, not the catalog --------------
{
	layer.set({ source: 'nearest', anchors: 12 });
	stepFrames(2);
	const pickSet = layer.internal.pickSet;
	check('the nearest pick covers field stars (a catalog-only pick cannot win)',
		pickSet.n === 12, pickSet.n);
	const got = [];
	for (let i = 0; i < pickSet.n; i++) {
		got.push({
			x: pickSet.positions[i * 3], y: pickSet.positions[i * 3 + 1], z: pickSet.positions[i * 3 + 2],
			li: pickSet.landmarkIdx[i],
		});
	}
	// Truth: the 12 nearest visible records to the eye at t = 0 (birth = drawn).
	const want = truthNearest(12, 0, EYE);
	let exact = got.length === want.length;
	for (let k = 0; k < want.length && exact; k++) {
		const w = want[k];
		const g = got[k];
		const bx = view.getFloat32(w.slot * REC, true);
		const by = view.getFloat32(w.slot * REC + 4, true);
		const bz = view.getFloat32(w.slot * REC + 8, true);
		exact = Math.abs(g.x - bx) < 1e-6 && Math.abs(g.y - by) < 1e-6 && Math.abs(g.z - bz) < 1e-6;
	}
	check('the nearest-N pick equals a brute-force scan of the whole resident sky (nearest-first)',
		exact, got.slice(0, 3));
	check('a far catalog star never enters a nearest set',
		!got.some(g => g.x >= 10), got.map(g => g.x.toFixed(2)).join(','));
	// The winners carry the BIRTH record: dispatching the set to t = 10 must
	// land on the brute-force position at t = 10 (the motion applied once).
	const drawn = layer.internal.drawn;
	env.starTimeMyr = 10;
	stepFrames(2);
	const p = new Float64Array(3);
	let once = true;
	for (let gk = 0; gk < pickSet.n && once; gk++) {
		// The pick at t=10 happens after a sweep; until it lands the set is the
		// t=0 pick dispatched to 10. Compare the CURRENT set's drawn positions
		// against a dispatch of its own birth words — that is the "applies the
		// motion once" contract, independent of which stars were picked.
		const li = pickSet.landmarkIdx[gk];
		if (li >= 0) Orbit.engineLandmarkPosition(p, li,
			pickSet.positions[gk * 3], pickSet.positions[gk * 3 + 1], pickSet.positions[gk * 3 + 2],
			pickSet.colorIndex[gk], 10, model);
		else Orbit.engineRecordPosition(p,
			pickSet.positions[gk * 3], pickSet.positions[gk * 3 + 1], pickSet.positions[gk * 3 + 2],
			pickSet.packed[gk], 10, model);
		once = Math.abs(p[0] - drawn[gk * 3]) < 1e-9
			&& Math.abs(p[1] - drawn[gk * 3 + 1]) < 1e-9
			&& Math.abs(p[2] - drawn[gk * 3 + 2]) < 1e-9;
	}
	check('the set keeps birth records: one dispatch lands on the drawn positions (never twice)',
		once, { n: pickSet.n });
	env.starTimeMyr = 0;
}

// --- the pick follows the sky as star time moves it ------------------------
// The browser bug: the map went flat under star time because the anchors were
// re-picked against the birth sky while the picture drew the moved one.
{
	env.starTimeMyr = 30;
	// Enough frames for the throttle (0.25 s) + the sliced sweep + the re-pick.
	stepFrames(40);
	const sky = layer.internal.sky;
	check('a star-time sweep dispatches the whole sky and stamps its time',
		sky.curTime === 30 && !sky.sweeping && sky.n > 0,
		{ curTime: sky.curTime, sweeping: sky.sweeping });
	const pickSet = layer.internal.pickSet;
	const want = truthNearest(pickSet.n, 30, EYE);
	const drawn = layer.internal.drawn;
	let exact = pickSet.n === want.length && pickSet.n > 0;
	const slots = [];
	for (let k = 0; k < want.length && exact; k++) {
		const w = want[k];
		slots.push(w.slot);
		// The drawn position of the k-th pick must be the drawn position of the
		// k-th truth record (both dispatched at 30 Myr).
		const packed = view.getUint32(w.slot * REC + 12, true);
		const bx = view.getFloat32(w.slot * REC, true);
		const by = view.getFloat32(w.slot * REC + 4, true);
		const bz = view.getFloat32(w.slot * REC + 8, true);
		const p = new Float64Array(3);
		if (w.slot >= LANDMARK_BASE && w.slot < LANDMARK_BASE + LANDMARKS) {
			Orbit.engineLandmarkPosition(p, w.slot - LANDMARK_BASE, bx, by, bz, packed & 0xFF, 30, model);
		} else {
			Orbit.engineRecordPosition(p, bx, by, bz, packed, 30, model);
		}
		exact = Math.abs(p[0] - drawn[k * 3]) < 1e-6
			&& Math.abs(p[1] - drawn[k * 3 + 1]) < 1e-6
			&& Math.abs(p[2] - drawn[k * 3 + 2]) < 1e-6;
	}
	check('the re-pick at star time equals a brute-force scan of the DRAWN sky (the flat-map fix)',
		exact, { n: pickSet.n, first: slots.slice(0, 5) });
	env.starTimeMyr = 0;
	// Home again: a sweep back to 0 restores the birth measurement.
	stepFrames(40);
	check('returning to star time 0 re-picks the birth sky',
		layer.internal.sky.curTime === 0 && layer.internal.pickSet.n > 0,
		layer.internal.sky.curTime);
}

// --- selected members resolve by identity key -----------------------------
{
	const pickSet = layer.internal.pickSet;
	// Select one field star, one landmark and one dead key.
	const fieldSlot = FIELD_BASE;                  // visible (0 % 7 !== 3)
	const landmarkSlot = LANDMARK_BASE + 2;
	selection.count = 3;
	selection.primary = 0;
	selection.keys[0] = identity[fieldSlot];
	selection.keys[1] = identity[landmarkSlot];
	selection.keys[2] = 0xDEAD;                    // a key the sky has forgotten
	selection.bufferIdx[0] = -1;                   // no hint: force the scan
	selection.bufferIdx[1] = landmarkSlot;         // a correct hint
	selection.bufferIdx[2] = -1;
	layer.set({ source: 'selected' });
	stepFrames(2);
	check('a selection resolves to its resident members only (a dead key drops)',
		pickSet.n === 2 && pickSet.source === 'selected', pickSet.n);
	check('a landmark member keeps its table index; a star member gets −1',
		pickSet.landmarkIdx[0] === -1 && pickSet.landmarkIdx[1] === 2, [...pickSet.landmarkIdx.slice(0, 2)]);
	check('a named selected landmark is labelled in the pick set',
		pickSet.names[1] === Landmarks.ENTRIES[2].name, pickSet.names[1]);
	// A stale hint must still find the key by scan.
	selection.bufferIdx[0] = TOTAL - 1;            // wrong on purpose
	layer.set({ source: 'selected' });
	stepFrames(2);
	check('a stale slot hint falls back to an identity scan (key still wins)',
		pickSet.n === 2, pickSet.n);
	selection.count = 0;
	layer.set({ source: 'constellations' });
}

// --- the constellation set still rides the landmark dispatch --------------
{
	// Force the constellation source and step once more.
	layer.set({ source: 'constellations' });
	stepFrames(2);
	check('constellations build the landmark table with its figures',
		layer.live.setN === Landmarks.count && layer.live.setSource === 'constellations',
		{ n: layer.live.setN, src: layer.live.setSource });
	const drawn = layer.internal.drawn;
	env.starTimeMyr = 5;
	stepFrames(40);
	const p = new Float64Array(3);
	let ok = true;
	for (let i = 0; i < 3 && ok; i++) {
		Orbit.engineLandmarkPosition(p, i,
			Landmarks.positions[i * 3], Landmarks.positions[i * 3 + 1], Landmarks.positions[i * 3 + 2],
			Landmarks.ENTRIES[i].colorIndex, 5, model);
		ok = Math.abs(p[0] - drawn[i * 3]) < 1e-6
			&& Math.abs(p[1] - drawn[i * 3 + 1]) < 1e-6
			&& Math.abs(p[2] - drawn[i * 3 + 2]) < 1e-6;
	}
	check('every constellation anchor rides engineLandmarkPosition at the live star time',
		ok);
	env.starTimeMyr = 0;
	layer.set({ source: 'nearest', anchors: 12 });
	stepFrames(40);
}

// --- one frame: basis, layout, paint, opacity ------------------------------
{
	env.starTimeMyr = 0;
	stepFrames(3);
	const b = layer.internal.basis;
	check('the layer copies the camera axes into the layout basis',
		b.fx === camera.forward[0] && b.ry === camera.right[1] && b.uz === camera.up[2],
		b);
	const L = layer.internal.layout;
	check('the view layout matches the window aspect and the camera\'s FoV',
		L.kind === 'view' && L.aspect === 640 / 360
		&& Math.abs(L.tanHalfY - Math.tan(camera.fovY / 2)) < 1e-12,
		{ kind: L.kind, aspect: L.aspect, tanHalfY: L.tanHalfY });
	check('the frame paints through the 2D canvas (map + legend)',
		calls.drawImage > 0 && calls.putImageData > 0, { ...calls });
	check('the status line quotes the live anchors and range',
		/12 anchors \(nearest\)/.test(layer.statusLine()) && /field \d+×\d+/.test(layer.statusLine()),
		layer.statusLine());
	layer.set({ opacity: 0.5 });
	const before = calls.drawImage;
	stepFrames(1);
	check('half opacity blits the offscreen map with globalAlpha',
		calls.drawImage > before && canvas.getContext().globalAlpha === 1,
		{ before, after: calls.drawImage });
	layer.set({ opacity: 1, mode: 'off' });
	stepFrames(1);
	check('the render type off hides the map canvas',
		canvas.style.display === 'none', canvas.style.display);
	layer.set({ mode: 'height' });
	env.hidden = true;
	stepFrames(1);
	check('the map stands aside for the system schematic',
		canvas.style.display === 'none', canvas.style.display);
	env.hidden = false;
	stepFrames(1);
	check('the map returns when the schematic closes',
		canvas.style.display === 'block', canvas.style.display);
}

// --- the plane chart: letterbox + chart quat ------------------------------
{
	layer.set({ projection: 'plane' });
	camera.forward.set([0, 1, 0]);
	stepFrames(3);
	const L = layer.internal.layout;
	check('the plane layout is a chart driven by the look direction (lon 0 = look)',
		L.kind === 'plane' && L.wrapX === true
		&& Math.abs(L.spanX - 2 * Math.PI) < 1e-9
		&& Math.abs(L.texelRadX - L.texelRadY) < 1e-9,
		{ spanX: L.spanX, spanY: L.spanY, tx: L.texelRadX, ty: L.texelRadY });
	check('a 360° chart letterboxes to 2:1 instead of squashing the poles',
		L.h === Math.floor(180 * L.w / 360 / 8) * 8, { w: L.w, h: L.h });
	// A direction through the layout lands where the camera looks.
	const hit = { x: 0, y: 0, inside: false };
	Field.texelOf(L, camera.forward[0], camera.forward[1], camera.forward[2], hit);
	check('the look direction lands at the chart centre',
		hit.inside && Math.abs(hit.x - (L.w / 2 - 0.5)) < 1e-6 && Math.abs(hit.y - (L.h / 2 - 0.5)) < 1e-6,
		hit);
	camera.forward.set([1, 0, 0]);
	layer.set({ projection: 'view' });
}

// --- auto range freeze (the island's rule) --------------------------------
{
	layer.set({ source: 'nearest', anchors: 12 });
	stepFrames(20);
	const frozen = { lo: layer.live.lo, hi: layer.live.hi };
	layer.setAutoRange(false);
	check('unchecking auto range freezes the live window into the manual sliders',
		layer.settings.autoRange === false, layer.settings.autoRange);
	layer.setRange('lo', frozen.lo - 0.5);
	check('a manual slider leaves auto off and keeps lo < hi',
		layer.settings.autoRange === false && layer.live.lo < layer.live.hi,
		{ lo: layer.live.lo, hi: layer.live.hi });
	layer.set({ autoRange: true });
}

// --- Report ---------------------------------------------------------------
let passed = 0, failed = 0;
for (const c of checks) {
	if (c.pass) passed++; else failed++;
}
console.log(`\n${passed}/${checks.length} passed, ${failed} failed`);

const outDir = path.join(__dirname, 'logs');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'view-modes-layer.json'), JSON.stringify({
	test: 'view-modes-layer',
	passed, failed, checks,
}, null, 2));

process.exit(failed ? 1 : 0);
