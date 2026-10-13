'use strict';
const assert = require('assert');
const fs = require('fs');
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
const ctx = new Proxy({ ops: 0 }, { get(target, key) { return key in target ? target[key] : () => { target.ops++; }; } });
const layer = layerLib.createSystemLayer({ width: 0, height: 0, getContext: () => ctx });
Object.assign(layer.record.star, record.star);
Object.assign(layer.record.counts, record.counts);
for (const key of Object.keys(record.planets)) if (ArrayBuffer.isView(record.planets[key])) layer.record.planets[key].set(record.planets[key]);
Object.assign(layer.record.belts, record.belts);
layer.prepare(); layer.resize(1280, 800, 1);
const hit = { body: -1, node: -1 };
const point = new Float64Array(2);
test('DV map is centered, fitted above report and graph picking uses its transform', () => {
	layer.setDvMap(true); layer.draw(1280, 800);
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
	assert.ok(layer.routeState().feasible); assert.ok(layer.toggleAutopilot());
	layer.setTimeRate(0); layer.stepTime(10, 0); assert.ok(layer.autopilotRunning());
	layer.setTimeRate(0.5); layer.stepTime(0.1, 0); assert.ok(layer.autopilotRunning());
	assert.strictEqual(layer.toggleAutopilot(), false);
	assert.ok(layer.toggleAutopilot());
	layer.setBudget(0.2); assert.ok(!layer.autopilotRunning());
});
test('completion stops flight, schematic draws ship and report has live fuel', () => {
	layer.setBudget(0); layer.toggleAutopilot(); layer.setTimeRate(99);
	layer.setDvMap(false); layer.stepTime(1, 0); layer.draw(1280, 800);
	assert.ok(!layer.autopilotRunning()); assert.ok(layer.readoutText().includes('dv spent'));
	layer.clearRoute(); assert.strictEqual(layer.routeState().count, 0);
});
test('selected belt readout uses packed body index, not MAX_PLANETS', () => {
	layer.setSelected(layerLib.BODY_BELT, 0);
	assert.ok(layer.readoutText().includes('dv  belt1'));
});
test('two graph draws do not reformat labels or allocate leg structures', () => {
	layer.setDvMap(true);
	const original = dv.formatKms;
	dv.formatKms = () => { throw new Error('per-frame formatting'); };
	try { layer.draw(1280, 800); layer.draw(1280, 800); } finally { dv.formatKms = original; }
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
fs.writeFileSync('experiments/logs/route.json', JSON.stringify({ checks, passed: checks.filter(c => c.pass).length, failed: checks.filter(c => !c.pass).length }, null, '\t') + '\n');
console.log(`\n${checks.filter(c => c.pass).length}/${checks.length} passed`);
if (checks.some(c => !c.pass)) process.exitCode = 1;
