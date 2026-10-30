'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const logFile = require('./log-file.js');
const dv = require('../src/math/deltav.js');
const route = require('../src/core/route.js');
const planets = require('../src/math/planets.js');
const layerLib = require('../src/render/system-layer.js');
const presets = require('../src/core/presets.js');
const MU = dv.G_SI * dv.M_SUN_KG;
const YEAR = dv.SECONDS_PER_YEAR;
const checks = [];
function test(name, fn) {
	try { fn(); checks.push({ name, pass: true }); console.log('OK   ' + name); }
	catch (e) { checks.push({ name, pass: false, detail: e.message }); console.log('FAIL ' + name + ': ' + e.message); }
}
function near(a, b, tol = 1e-8) { assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`); }
function fixture() {
	const r = planets.createSystemRecord();
	r.star.key = 42; r.star.mass = 1; r.star.rStar = 1; r.star.teff = 5772;
	r.star.lum = 1; r.star.state = 'ms'; r.star.spectralClass = 'G'; r.star.aOut = 40;
	r.counts.planets = 2;
	for (let i = 0; i < 2; i++) {
		const p = r.planets;
		p.a[i] = i ? 1.524 : 1; p.mass[i] = i ? 0.107 : 1; p.radius[i] = i ? 0.532 : 1;
		p.displayType[i] = i ? planets.DISPLAY_INDEX.BARREN : planets.DISPLAY_INDEX.TERRAN;
		p.period[i] = Math.sqrt(p.a[i] ** 3); p.rotHours[i] = 24;
		p.rHill[i] = p.a[i] * (p.mass[i] / 333000 / 3) ** (1 / 3);
	}
	r.belts.count = 1; r.belts.a[0] = 2.77; r.belts.dlnA[0] = 0.1; r.belts.stippleSeed[0] = 77;
	return r;
}
const record = fixture();
const earth = dv.paramOfBody(record, 0, MU, dv.createBodyParam());
const mars = dv.paramOfBody(record, 1, MU, dv.createBodyParam());
const hh = dv.hohmannStarFrame(MU, earth.aM, mars.aM, {});
const required = Math.PI - dv.TAU * hh.tH / mars.periodS;
function endpoint(body, node, phase, label) { return { body, node, phase, label, muStar: MU, systemKey: 42, x: 0, y: 0, z: 0 }; }
const a = endpoint(earth, 1, 0, 'Earth');
const b = endpoint(mars, 1, required, 'Mars');
const r = route.createRoute();
const xy = new Float64Array(3);

test('shared ship table, payload, crew and full-tank burn times', () => {
	assert.strictEqual(route.SHIP_CLASSES, dv.SHIP_CLASSES);
	const hours = [1.85185, 11.11111, 11111.11111, 5555.55556, 1666666.66667];
	dv.SHIP_CLASSES.forEach((s, i) => { near(s.dvMax / s.accel / 3600, hours[i], 0.0001); assert.ok(s.cargo > 0 && s.crew > 0); });
});
test('all interstellar ships can accelerate and decelerate at their cruise speed', () => {
	for (const s of dv.SHIP_CLASSES) assert.ok(s.dvMax >= 2 * s.vCruise * route.C);
});
test('Earth–Mars launch angle and synodic period pins', () => {
	near(required * 180 / Math.PI, 44.35, 0.3);
	near(earth.periodS * mars.periodS / Math.abs(mars.periodS - earth.periodS) / dv.SECONDS_PER_DAY, 780, 2);
});
test('signed outward window reaches required phase', () => {
	const wait = route.launchWindow(earth, mars, 0.2, 2, hh.tH, 0);
	const rel = dv.TAU / mars.periodS - dv.TAU / earth.periodS;
	near(Math.sin(2 - 0.2 + rel * wait - required), 0);
});
test('signed inward window reaches required phase', () => {
	const reverse = dv.hohmannStarFrame(MU, mars.aM, earth.aM, {});
	const wait = route.launchWindow(mars, earth, 2, 0.2, reverse.tH, 0);
	const req = Math.PI - dv.TAU * reverse.tH / earth.periodS;
	near(Math.sin(0.2 - 2 + (dv.TAU / earth.periodS - dv.TAU / mars.periodS) * wait - req), 0);
});
test('high-energy legs have no wait; equal periods never yield NaN', () => {
	near(route.launchWindow(earth, mars, 0, 0, hh.tH, 1), 0);
	assert.strictEqual(route.launchWindow(earth, earth, 0, 1, earth.periodS / 2, 0), Infinity);
	near(route.launchWindow(earth, earth, 0, 0, earth.periodS / 2, 0), 0);
});
test('mean low-energy wait is half the synodic period', () => {
	let sum = 0;
	for (let i = 0; i < 1000; i++) sum += route.launchWindow(earth, mars, 0, required + dv.TAU * (i + 0.5) / 1000, hh.tH, 0);
	near(sum / 1000 / (earth.periodS * mars.periodS / (mars.periodS - earth.periodS)), 0.5, 1e-8);
});
test('one-way LO chain uses the DV map once and fits a chemical hull', () => {
	route.buildRoute(a, b, 'chemical', 0, r);
	const edge = dv.legLoToLo(MU, earth, mars, false, {});
	near(r.totalDv, edge.dvLoToLo, 1e-6);
	near(r.totalYears, hh.tH / YEAR, 1e-8);
	assert.ok(r.feasible);
	assert.deepEqual(r.legs.slice(0, r.count).map(l => l.kind), ['departure', 'transfer', 'capture']);
});
test('surface chain includes launch and landing with cumulative fuel', () => {
	route.buildRoute({ ...a, node: 0 }, { ...b, node: 0 }, 'nuclear', 0, r);
	assert.ok(r.feasible);
	assert.strictEqual(r.legs[0].kind, 'launch'); assert.strictEqual(r.legs[r.count - 1].kind, 'landing');
	near(r.totalDv, r.legs.slice(0, r.count).reduce((sum, l) => sum + l.dv, 0), 1e-6);
});
test('escape-node departure spends heliocentric dv, not another escape burn', () => {
	route.buildRoute({ ...a, node: 3 }, b, 'chemical', 0, r);
	near(r.legs[0].dv, hh.dvDep, 1e-6);
});
test('L5 is a second exit: L5 endpoints spend only the star-frame burns', () => {
	const edge = dv.legLoToLo(MU, earth, mars, false, {});
	// Leaving from L5 costs exactly leaving from the escape node: the ship is
	// already heliocentric, so no LO capture or well leg is charged again.
	route.buildRoute({ ...a, node: 4 }, b, 'nuclear', 0, r);
	near(r.totalDv, edge.dvDepStar + edge.dvCapB, 1e-6);
	assert.ok(!r.legs.slice(0, r.count).some(l => l.kind === 'launch'));
	// Arriving at L5 pays the star-frame arrival, not a capture plus a drift.
	route.buildRoute(a, { ...b, node: 4 }, 'nuclear', 0, r);
	near(r.totalDv, edge.dvDepLo + edge.dvArrStar, 1e-6);
	assert.ok(!r.legs.slice(0, r.count).some(l => l.kind === 'landing'));
	route.buildRoute({ ...a, node: 4 }, { ...b, node: 4 }, 'nuclear', 0, r);
	near(r.totalDv, edge.dvDepStar + edge.dvArrStar, 1e-6);
	// The map rides the well edge on local legs and sits on its node in a wait.
	route.buildRoute({ ...a, node: 0 }, { ...b, node: 4 }, 'nuclear', 0, r);
	const launch = r.legs.slice(0, r.count).find(l => l.kind === 'launch');
	assert.strictEqual(launch.fromNode, 0); assert.strictEqual(launch.toNode, 1);
	const wait = r.legs.slice(0, r.count).find(l => l.kind === 'wait');
	if (wait) { assert.strictEqual(wait.fromNode, 1); assert.strictEqual(wait.toNode, 1); }
});
test('same-body L5 legs still ride the one-body drift edge', () => {
	route.buildRoute(a, { ...a, node: 4 }, 'chemical', 0, r);
	assert.ok(r.feasible);
	near(r.totalDv, dv.dvLoToL5(earth, {}), 1e-6);
	const leg = r.legs.slice(0, r.count).find(l => l.kind === 'landing');
	assert.strictEqual(leg.fromNode, 1); assert.strictEqual(leg.toNode, 4);
});
test('round trip includes layover, reverse capture and its own window', () => {
	route.buildRoute(a, b, 'nuclear', 0, r, true);
	assert.ok(r.feasible); assert.ok(r.count <= route.MAX_LEGS);
	assert.ok(r.legs.slice(0, r.count).some(l => l.label === 'turn-around layover'));
	assert.ok(r.legs.slice(0, r.count).some(l => l.kind === 'wait' && l.label.includes('window')));
	near(r.roundTripYears, r.totalYears);
	near(r.totalDv, dv.legLoToLo(MU, earth, mars, false, {}).dvLoToLo + dv.legLoToLo(MU, mars, earth, false, {}).dvLoToLo, 1e-6);
});
test('identical nodes and absent GEO/surface nodes reject launch', () => {
	assert.ok(!route.buildRoute(a, a, 'chemical', 0, r).feasible);
	const giant = { ...mars, hasSurface: false, hasGeo: false };
	assert.ok(!route.buildRoute(a, { ...b, body: giant, node: 0 }, 'nuclear', 0, r).feasible);
	assert.ok(!route.buildRoute(a, { ...b, body: giant, node: 2 }, 'nuclear', 0, r).feasible);
});
test('same-body GEO route costs only the one-body edge', () => {
	route.buildRoute(a, { ...a, node: 2 }, 'chemical', 0, r);
	near(r.totalDv, dv.dvLoToGeo(earth, {}), 1e-6);
	assert.ok(r.feasible);
});
test('acceleration ceiling is self-consistent and max budget speeds fusion up', () => {
	const edge = dv.legLoToLo(MU, earth, mars, false, {});
	const t = dv.legTimes(edge, dv.shipById('fusion'), 1, {});
	near(t.aRequired, 0.3);
	assert.ok(t.t < edge.tH && t.feasible);
	route.buildRoute(a, b, 'fusion', 1, r); assert.ok(r.feasible);
});
test('Hohmann ellipse starts at departure and arrives at target, also inward', () => {
	for (const [start, end] of [[a, b], [b, a]]) {
		route.buildRoute(start, end, 'nuclear', 0, r);
		const l = r.legs.find(l => l.kind === 'transfer');
		route.routePosition(xy, r, l.start + 1e-10);
		near(Math.hypot(xy[0], xy[1]) / start.body.aM, 1, 1e-8);
		route.routePosition(xy, r, l.end - 1e-10);
		near(Math.hypot(xy[0], xy[1]) / end.body.aM, 1, 1e-8);
		near(Math.atan2(Math.sin(Math.atan2(xy[1], xy[0]) - l.endAngle), Math.cos(Math.atan2(xy[1], xy[0]) - l.endAngle)), 0, 1e-8);
	}
});
test('powered flip is half the chord at midpoint', () => {
	route.buildRoute(a, b, 'fusion', 1, r);
	const l = r.legs.find(l => l.kind === 'transfer');
	route.routePosition(xy, r, (l.start + l.end) / 2);
	near(xy[0] / dv.AU_M, (l.a1 * Math.cos(l.angle) + l.a2 * Math.cos(l.endAngle)) / (2 * dv.AU_M), 1e-8);
});
test('wait holds at moving departure, spent dv stays bounded', () => {
	route.buildRoute(a, { ...b, phase: 2 }, 'nuclear', 0, r);
	const l = r.legs.find(l => l.kind === 'wait');
	route.routePosition(xy, r, (l.start + l.end) / 2);
	near(Math.hypot(xy[0], xy[1]), earth.aM, 0.001);
	near(route.spentDv(r, 0), 0);
	near(route.spentDv(r, r.totalYears), r.totalDv, 1e-6);
});
test('10 ly and 1 kpc cruise times, tank and life limits', () => {
	const tenLy = 10 * route.C * YEAR;
	near(route.interstellarLeg(tenLy, dv.shipById('fusion'), {}).timeS / YEAR, 500.633, 0.1);
	near(route.interstellarLeg(tenLy, dv.shipById('generation'), {}).timeS / YEAR, 2047.5, 1);
	const star = { ...b, systemKey: 99, x: 1, y: 0, z: 0 };
	for (const id of ['chemical', 'nuclear', 'fusion', 'stardrive', 'generation']) {
		route.buildRoute(a, star, id, 0, r);
		assert.strictEqual(r.feasible, id === 'generation');
	}
	near(r.totalYears, 652000, 500);
});
test('short interstellar legs use triangular burns and nonnegative coasting', () => {
	const ship = dv.shipById('stardrive');
	const distance = 1e9;
	const result = route.interstellarLeg(distance, ship, {});
	near(result.speed, Math.sqrt(ship.accel * distance));
	near(result.timeS, 2 * Math.sqrt(distance / ship.accel));
});
test('interstellar ship position follows XYZ snapshots and flip/coast timing', () => {
	const start = { ...a, node: 3, x: 0, y: 0, z: 0 };
	const end = { ...b, node: 3, systemKey: 99, x: 1, y: 2, z: 3 };
	route.buildRoute(start, end, 'generation', 0, r);
	const l = r.legs.find(l => l.kind === 'cruise');
	route.routePosition(xy, r, (l.start + l.end) / 2);
	near(xy[0] / route.KPC_M, 0.5); near(xy[1] / route.KPC_M, 1); near(xy[2] / route.KPC_M, 1.5);
});
test('interstellar fuel stays constant during coasting', () => {
	const start = { ...a, node: 3 };
	const end = { ...b, node: 3, systemKey: 99, x: 1 };
	route.buildRoute(start, end, 'generation', 0, r);
	const l = r.legs.find(l => l.kind === 'cruise');
	near(route.spentDv(r, l.start + (l.end - l.start) * 0.25), l.dv / 2, 1e-6);
	near(route.spentDv(r, l.start + (l.end - l.start) * 0.75), l.dv / 2, 1e-6);
	near(route.spentDv(r, r.totalYears), r.totalDv, 1e-6);
});
test('zero remaining tank never becomes unlimited fuel', () => {
	const edge = dv.legLoToLo(MU, earth, mars, false, {});
	assert.ok(!dv.legTimes(edge, { accel: 1, dvMax: 0 }, 1, {}).feasible);
});
test('route rebuild resets all previous totals and feasibility', () => {
	route.buildRoute(a, { ...b, systemKey: 99, x: 1 }, 'chemical', 0, r);
	assert.ok(!r.feasible);
	route.buildRoute(a, b, 'chemical', 0, r);
	assert.ok(r.feasible); assert.strictEqual(r.count, 3);
});
test('belt period equals the dots’ Kepler-year clock (2π regression)', () => {
	const belt = dv.paramOfBelt(record, 0, MU, dv.createBodyParam());
	near(belt.periodS / YEAR, Math.sqrt(record.belts.a[0] ** 3), 0.001);
});
test('DV toggle, budget, ship survive presets and invalid ship is rejected', () => {
	const s = { dvmap: 1, dvbudget: 0.65, ship: 'generation' };
	assert.deepEqual(presets.parse(presets.serialize(s)), s);
	assert.deepEqual(presets.parse('ship=invalid'), {});
});

// Exercise the actual layer, not a second UI model.
const ctx = new Proxy({ ops: 0, lastMoveX: 0, lastMoveY: 0 }, { get(target, key) {
	if (key === 'moveTo') return (x, y) => { target.ops++; target.lastMoveX = x; target.lastMoveY = y; };
	return key in target ? target[key] : () => { target.ops++; };
} });
const layer = layerLib.createSystemLayer({ width: 0, height: 0, getContext: () => ctx });
Object.assign(layer.record.star, record.star);
Object.assign(layer.record.counts, record.counts);
for (const key of Object.keys(record.planets)) if (ArrayBuffer.isView(record.planets[key])) layer.record.planets[key].set(record.planets[key]);
Object.assign(layer.record.belts, record.belts);
layer.prepare(); layer.resize(1280, 800, 1);
const hit = { body: -1, node: -1 };
const point = new Float64Array(2);
test('DV map is centered, fitted above report and graph picking uses its transform', () => {
	layer.setView(layerLib.VIEW_DV_CLASSIC); layer.draw(1280, 800);
	const m = layer.mapLayout;
	near(m.x + m.width * m.scale / 2, 640);
	assert.ok(m.y > 0 && m.y + m.height * m.scale < 600);
	layer.dvNodeXYFor(1, 1, point);
	assert.ok(layer.pickDvNode(m.x + point[0] * m.scale, m.y + point[1] * m.scale, hit));
	assert.deepEqual(hit, { body: 1, node: 1 });
	const bodyHit = {}; layer.pick(640, 400, bodyHit); assert.strictEqual(bodyHit.kind, layerLib.BODY_NONE);
});
test('map fits narrow screens, DPR and menu clearance', () => {
	for (const [w, h, inset] of [[1280, 800, 284], [640, 480, 0], [1920, 1080, 284]]) {
		layer.resize(w, h, 2); layer.draw(w, h, inset);
		const m = layer.mapLayout;
		assert.ok(m.x >= 0 && m.x + m.width * m.scale <= w - inset);
		layer.dvNodeXYFor(2, 3, point);
		assert.ok(layer.pickDvNode(m.x + point[0] * m.scale, m.y + point[1] * m.scale, hit));
		assert.deepEqual(hit, { body: 2, node: 3 });
	}
});
test('graph endpoint picking, pause/resume and frozen system clock', () => {
	layer.setShipClass('nuclear'); layer.setBudget(0); layer.chooseRouteNode(0, 1); layer.chooseRouteNode(1, 1);
	assert.strictEqual(layer.autopilotState(), 'ready');
	assert.ok(layer.routeState().feasible); assert.ok(layer.toggleAutopilot());
	assert.strictEqual(layer.autopilotState(), 'running');
	layer.setTimeRate(0); layer.stepTime(10, 0); assert.ok(layer.autopilotRunning());
	layer.setTimeRate(0.5); layer.stepTime(0.1, 0); assert.ok(layer.autopilotRunning());
	assert.strictEqual(layer.toggleAutopilot(), false);
	assert.strictEqual(layer.autopilotState(), 'paused');
	assert.ok(layer.toggleAutopilot());
	assert.strictEqual(layer.autopilotState(), 'running');
	layer.setBudget(0.2); assert.strictEqual(layer.autopilotState(), 'ready');
});
test('system schematic ship follows System time, freezes at zero and reports flight state', () => {
	layer.setView(layerLib.VIEW_SYSTEM); layer.setBudget(0);
	assert.strictEqual(layer.autopilotState(), 'ready');
	layer.setTimeRate(0); assert.ok(layer.toggleAutopilot());
	layer.draw(1280, 800);
	const frozenX = ctx.lastMoveX, frozenY = ctx.lastMoveY;
	layer.stepTime(1, 0); layer.draw(1280, 800);
	near(ctx.lastMoveX, frozenX); near(ctx.lastMoveY, frozenY);
	assert.strictEqual(layer.autopilotState(), 'running');
	assert.ok(layer.readoutText().includes('dv spent'));

	layer.setTimeRate(0.5); layer.stepTime(1 / 60, 0); layer.draw(1280, 800);
	assert.ok(Math.hypot(ctx.lastMoveX - frozenX, ctx.lastMoveY - frozenY) > 0.1,
		'ship marker advances on the schematic at a positive clock rate');
	assert.ok(layer.autopilotRunning());
	assert.strictEqual(layer.toggleAutopilot(), false);
	assert.strictEqual(layer.autopilotState(), 'paused');
	const pausedX = ctx.lastMoveX, pausedY = ctx.lastMoveY;
	layer.stepTime(1, 0); layer.draw(1280, 800);
	near(ctx.lastMoveX, pausedX); near(ctx.lastMoveY, pausedY);

	assert.ok(layer.toggleAutopilot());
	layer.setTimeRate(100); layer.stepTime(1, 0); layer.draw(1280, 800);
	assert.strictEqual(layer.autopilotState(), 'complete');
	layer.exit();
	assert.strictEqual(layer.autopilotState(), 'empty');
	assert.strictEqual(layer.routeState().count, 0);
	layer.prepare(); layer.resize(1280, 800, 1);
});
test('selected belt readout uses packed body index, not MAX_PLANETS', () => {
	layer.setSelected(layerLib.BODY_BELT, 0);
	assert.ok(layer.readoutText().includes('dv  belt1'));
});
test('no map render reformats a label or builds a string per frame', () => {
	const original = dv.formatKms;
	const toFixed = Number.prototype.toFixed;
	for (const view of [layerLib.VIEW_DV_CLASSIC, layerLib.VIEW_DV_RAILS, layerLib.VIEW_DV_TIME]) {
		layer.setView(view);                 // builds the cached label strings
		dv.formatKms = () => { throw new Error('per-frame formatting'); };
		Number.prototype.toFixed = function () { throw new Error('per-frame toFixed'); };
		try {
			layer.draw(1280, 800);
			layer.draw(1280, 800);
		} finally {
			dv.formatKms = original;
			Number.prototype.toFixed = toFixed;
		}
	}
	layer.setView(layerLib.VIEW_DV_CLASSIC);
});
test('view switching cycles all four renders and gates picking', () => {
	layer.setView(layerLib.VIEW_SYSTEM);
	assert.strictEqual(layer.isMapOpen(), false);
	layer.cycleView();
	assert.strictEqual(layer.getView(), layerLib.VIEW_DV_CLASSIC);
	assert.ok(layer.isMapOpen());
	layer.cycleView();
	assert.strictEqual(layer.getView(), layerLib.VIEW_DV_RAILS);
	layer.cycleView();
	assert.strictEqual(layer.getView(), layerLib.VIEW_DV_TIME);
	layer.cycleView();
	assert.strictEqual(layer.getView(), layerLib.VIEW_SYSTEM);
	assert.strictEqual(layer.setView(99), layerLib.VIEW_DV_TIME);
	assert.strictEqual(layer.setView(-4), layerLib.VIEW_SYSTEM);
});

test('the rail render puts every node kind on its own row and joins both rails', () => {
	layer.setView(layerLib.VIEW_DV_RAILS);
	// A crossed body (the belt, no GEO/L5) must not shift its neighbours: the
	// escape and L5 rows are the same y for every column.
	const escRows = [], l5Rows = [];
	for (let bi = 0; bi < layer.record.counts.planets + layer.record.belts.count; bi++) {
		layer.dvNodeXYFor(bi, 3, point);
		escRows.push(point[1]);
		layer.dvNodeXYFor(bi, 4, point);
		l5Rows.push(point[1]);
	}
	assert.ok(escRows.every((y) => y === escRows[0]), String(escRows));
	assert.ok(l5Rows.every((y) => y === l5Rows[0]), String(l5Rows));
	assert.ok(l5Rows[0] > escRows[0]);
	// The nodes are drawn on those rows for both renders, and the draw with the
	// L5 rail present runs without a throw.
	layer.resize(1280, 800, 1); layer.draw(1280, 800, 284);
	assert.ok(layer.mapLayout.valid);
});

test('the ship rides the map graph: the rail row mid-leg, the node at the ends', () => {
	layer.setView(layerLib.VIEW_DV_CLASSIC);
	layer.setShipClass('nuclear'); layer.setBudget(0);
	layer.chooseRouteNode(0, 1); layer.chooseRouteNode(1, 1);
	const route = layer.routeState();
	assert.ok(route.feasible && route.count >= 3);
	const transfer = route.legs.find((l) => l.kind === 'transfer');
	assert.ok(transfer && transfer.from && transfer.to);
	// The marker follows the same clock the schematic uses: it moves while the
	// autopilot runs (flightElapsed only advances then), and the dashed path is
	// drawn from the plan either way.
	layer.setTimeRate(0); layer.stepTime(0, 0);
	layer.draw(1280, 800);            // t = 0: the origin's low orbit
	layer.dvNodeXYFor(0, 1, point);
	const atStart = [layer.mapShipXY[0], layer.mapShipXY[1]];
	near(atStart[0], point[0], 1e-6); near(atStart[1], point[1], 1e-6);
	// Mid-transfer: on the escape rail row, between the two columns.
	const mid = (transfer.start + transfer.end) * 0.5;
	layer.setTimeRate(1);
	assert.ok(layer.toggleAutopilot(), 'autopilot starts');
	layer.stepTime(mid, 0);
	layer.draw(1280, 800);
	layer.dvNodeXYFor(0, 3, point);
	near(layer.mapShipXY[1], point[1], 1e-6);
	assert.ok(layer.mapShipXY[0] > point[0] && layer.mapShipXY[0] < point[0] + layerLib.DV_COL_W);
	// At the end of the leg the marker is the destination's node.
	layer.stepTime(transfer.end - mid, 0);
	layer.draw(1280, 800);
	layer.dvNodeXYFor(1, 1, point);
	near(layer.mapShipXY[0], point[0], 1e-6); near(layer.mapShipXY[1], point[1], 1e-6);
	layer.clearRoute();
});

test('transfer Kepler solver remains accurate up to e = 0.9999', () => {
	const orbit = require('../src/math/orbit.js');
	for (const e of [0, 0.55, 0.9, 0.99, 0.9999]) {
		for (const mean of [0, 0.00001, 0.1, 1, Math.PI]) {
			const E = orbit.solveEccentricAnomaly(mean, e);
			near(Math.sin(E - e * Math.sin(E) - mean), 0, 1e-8);
		}
	}
});
test('round-trip fuel is not reset at layover; life covers waits', () => {
	route.buildRoute({ ...a, node: 0 }, { ...b, node: 0 }, 'chemical', 0, r, true);
	assert.ok(!r.feasible && !r.fuelFeasible);
	assert.ok(r.totalDv > dv.shipById('chemical').dvMax);
	assert.ok(r.totalYears > dv.shipById('chemical').lifeYears);
});
test('maximum generated body count fits and remains pickable', () => {
	const rec = layer.record;
	rec.counts.planets = planets.MAX_PLANETS;
	rec.belts.count = planets.MAX_BELTS;
	rec.belts.a[1] = 30; rec.belts.dlnA[1] = 0.2;
	for (let i = 0; i < planets.MAX_PLANETS; i++) {
		rec.planets.a[i] = 0.04 * 1.7 ** i; rec.planets.mass[i] = 1; rec.planets.radius[i] = 1;
		rec.planets.displayType[i] = planets.DISPLAY_INDEX.TERRAN;
		rec.planets.period[i] = Math.sqrt(rec.planets.a[i] ** 3);
		rec.planets.rotHours[i] = 24; rec.planets.rHill[i] = rec.planets.a[i] * 0.01;
	}
	layer.prepare(); layer.draw(1280, 800, 284);
	const m = layer.mapLayout;
	assert.ok(m.x + m.width * m.scale <= 996);
	layer.dvNodeXYFor(planets.MAX_PLANETS + 1, 1, point);
	assert.ok(layer.pickDvNode(m.x + point[0] * m.scale, m.y + point[1] * m.scale, hit));
	assert.strictEqual(hit.body, planets.MAX_PLANETS + 1);
});
test('search UI calls the exported planet-type bit function', () => {
	const main = fs.readFileSync('src/main.js', 'utf8');
	const search = require('../src/core/search.js');
	assert.strictEqual(typeof search.planetTypeBit, 'function');
	assert.ok(main.includes('searchLib.planetTypeBit'));
	assert.ok(!main.includes('searchLib.ptypeBit'));
});
test('panels collapse to their header (never closed for good) and the route hint does not send V to autopilot', () => {
	const main = fs.readFileSync('src/main.js', 'utf8');
	const html = fs.readFileSync('src/index.html', 'utf8');
	// A collapsed panel keeps its header as the handle; the System panel's
	// collapse leaves the view open, so its controls are one click away and
	// V / Esc / the view button remain the exits.
	assert.ok(html.includes('id="menu-collapse"') && html.includes('id="sysmenu-collapse"'));
	assert.ok(!html.includes('id="menu-close"') && !html.includes('id="sysmenu-close"'));
	assert.ok(main.includes('wireCollapse(menu, menuCollapse)') && main.includes('wireCollapse(sysMenu, sysMenuCollapse)'));
	const toggle = main.slice(main.indexOf('function toggleCollapse'), main.indexOf('function wireCollapse'));
	assert.ok(toggle.includes("classList.toggle('collapsed')") && !toggle.includes('closeSystemView'));
	const css = fs.readFileSync('src/style.css', 'utf8');
	assert.ok(css.includes('.panel.collapsed > :not(:first-child)'));
	assert.ok(!main.includes('V to fly it'));
});
logFile.writeLog(path.join(__dirname, 'logs', 'route.json'), { checks, passed: checks.filter(c => c.pass).length, failed: checks.filter(c => !c.pass).length }, { indent: '\t' });
console.log(`\n${checks.filter(c => c.pass).length}/${checks.length} passed`);
if (checks.some(c => !c.pass)) process.exitCode = 1;
