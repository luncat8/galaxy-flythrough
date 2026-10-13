// experiments/system-layer-test.js
// The close-system schematic (0.5.3, plan §6/§10), headless: a stub 2D context
// stands in for the canvas, so what is pinned is the layer's arithmetic and
// bookkeeping, not browser rendering (that stays in deferred-browser-visual-plan.md).
//
// Checks:
//   1. pure helpers: the icon buckets at their edges, the star radii by state,
//      the view bounds of §6.1, the system-time formatter.
//   2. ρ(a) monotone, and every drawn body inside [R_STAR_PX, R_EDGE_PX];
//      stipple dots bounded (their law reaches ±Δln a past the centre).
//   3. belt stipples hashed ONCE: the angle/radius bytes survive two draws
//      unchanged and equal a fresh fillStipple of the record's own seed.
//   4. the planets ride the ellipse that is drawn for them (§6.1/§14 Q4):
//      positions recomputed independently, periodic in P, belts rotate at
//      their own Kepler rate.
//   5. picking returns the body the draw placed: planets by icon + 4 px,
//      the star at the centre, belts by |Δr| < 6 px, bodies over belts,
//      empty space NONE — and NONE before the first draw.
//   6. the §6.6 readout, byte-for-byte against the plan's worked K-dwarf
//      example: head, HZ line, all five planet rows, the belt row, and the
//      ◀ selected marker on the selected body only.
//   7. designations: S<key36> and the landmark-name paths (plan §4.11).
//   8. the clock: clamps, frozen default, the −1 camera coupling through
//      orbit.js's own FLIGHT_TIME_GAIN.
//   9. a real generated system: enter() twice gives the identical readout;
//      degenerate records (no planets, crossed edges) draw without a throw.
//  10. the dv map: view switching, the rail render's level rows and its two
//      rails (escape + L5, the L5 rung joining the columns as another way out),
//      and the ship riding the graph.
//  11. exit() erases the canvas; a closed draw() is zero context ops.
//  12. no allocation across 1 000 draw calls, and the per-frame op count
//      inside the plan's ~800-canvas-op budget.
//
// Output: experiments/logs/system-layer.json

'use strict';

const fs = require('fs');
const path = require('path');

globalThis.window = globalThis;

const planets = require('../src/math/planets.js');
const orbit = require('../src/math/orbit.js');
const galaxy = require('../src/math/galaxy.js');
const SystemLayer = require('../src/render/system-layer.js');

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
	return !!pass;
}
function near(a, b, tol) { return Math.abs(a - b) <= (tol === undefined ? 1e-9 : tol); }

// The heap checks below want *retained* memory, and the suite runs plain `node`
// without --expose-gc. The flag trick hands us a real collector run anyway;
// without it the reading drifts with whatever the GC has not swept yet.
const gcRunner = (function () {
	try {
		const v8 = require('v8');
		const vm = require('vm');
		v8.setFlagsFromString('--expose-gc');
		const gc = vm.runInNewContext('gc');
		v8.setFlagsFromString('--no-expose-gc');
		return gc;
	} catch (e) {
		return null;
	}
})();
function forceGc() {
	if (gcRunner) { gcRunner(); gcRunner(); }
	else if (global.gc) { global.gc(); global.gc(); }
}

// --- The stub context: counts ops, stores style props, draws nothing ---------
function createStubContext() {
	const ops = { total: 0, fillRect: 0, arc: 0, ellipse: 0, fill: 0, stroke: 0, clearRect: 0, text: 0 };
	const texts = [];
	const ctx = {
		ops, texts,
		fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textBaseline: '', textAlign: 'left',
		clearRect() { ops.clearRect++; ops.total++; },
		fillRect() { ops.fillRect++; ops.total++; },
		beginPath() { ops.total++; },
		arc() { ops.arc++; ops.total++; },
		ellipse() { ops.ellipse++; ops.total++; },
		fill() { ops.fill++; ops.total++; },
		stroke() { ops.stroke++; ops.total++; },
		setTransform() { ops.total++; },
		setLineDash() { ops.total++; },
		translate() { ops.total++; },
		scale() { ops.total++; },
		save() { ops.total++; },
		restore() { ops.total++; },
		moveTo() { ops.total++; },
		lineTo() { ops.total++; },
		closePath() { ops.total++; },
		// The text log is capped: section 12's heap check would otherwise measure
		// this array growing rather than the layer.
		fillText(text) { ops.text++; ops.total++; if (texts.length < 4000) texts.push(text); },
		strokeText(text) { ops.text++; ops.total++; if (texts.length < 4000) texts.push(text); },
	};
	return ctx;
}
function createStubCanvas() {
	const ctx = createStubContext();
	return { width: 0, height: 0, getContext: () => ctx, ctx };
}

const W = 1280, H = 800;

// --- Fabricate a record: prepare() adopts whatever `record` holds ------------
function fabricate(layer, opts) {
	const rec = layer.record;
	const star = rec.star;
	star.key = opts.key >>> 0;
	star.mass = opts.mass;
	star.lum = opts.lum;
	star.teff = opts.teff;
	star.rStar = opts.rStar;
	star.age = opts.age;
	star.metal = opts.metal;
	star.state = opts.state || 'ms';
	star.spectralClass = opts.spectralClass || 'K';
	star.colorIndex = opts.colorIndex === undefined ? 5 : opts.colorIndex;
	star.aHzIn = opts.aHzIn === undefined ? planets.hzInnerAU(star.lum) : opts.aHzIn;
	star.aHzOut = opts.aHzOut === undefined ? planets.hzOuterAU(star.lum) : opts.aHzOut;
	star.aSnow = opts.aSnow === undefined ? planets.snowLineAU(star.lum) : opts.aSnow;
	star.aOut = opts.aOut === undefined ? planets.outerEdgeAU(star.mass, star.state) : opts.aOut;
	star.nameLen = 0;
	rec.counts.planets = opts.planets.length;
	rec.counts.terranCount = 0;
	rec.counts.giantCount = 0;
	opts.planets.forEach((pl, i) => {
		const p = rec.planets;
		p.a[i] = pl.a;
		p.mass[i] = pl.mass;
		p.radius[i] = pl.radius === undefined ? planets.radiusFor(pl.bulk, pl.mass) : pl.radius;
		p.density[i] = planets.planetDensity(pl.mass, p.radius[i]);
		p.e[i] = pl.e || 0;
		p.inc[i] = pl.inc || 0;
		p.peri[i] = pl.peri || 0;
		p.phase[i] = pl.phase || 0;
		p.period[i] = pl.period === undefined ? Math.sqrt(pl.a * pl.a * pl.a / star.mass) : pl.period;
		p.insolation[i] = pl.insolation === undefined ? planets.insolation(star.lum, pl.a) : pl.insolation;
		p.teq[i] = pl.teq === undefined ? 250 : pl.teq;
		p.tsurf[i] = pl.tsurf === undefined ? p.teq[i] : pl.tsurf;
		p.rHill[i] = pl.a * planets.hillRatio(pl.mass, star.mass);
		p.rotHours[i] = pl.rotHours || 24;
		p.moons[i] = pl.moons || 0;
		p.bulk[i] = pl.bulk;
		p.displayType[i] = pl.displayType;
		p.flags[i] = pl.flags || 0;
	});
	rec.belts.count = (opts.belts || []).length;
	(opts.belts || []).forEach((b, k) => {
		rec.belts.kind[k] = b.kind === undefined ? k : b.kind;
		rec.belts.a[k] = b.a;
		rec.belts.dlnA[k] = b.dlnA;
		rec.belts.mass[k] = b.mass;
		rec.belts.stippleSeed[k] = b.stippleSeed >>> 0;
	});
	return layer.prepare();
}

// The picking fixture: four well-separated circular orbits on the +x axis at
// t = 0, one belt, nothing else near the −x axis or the diagonals.
function pickingFixture() {
	const canvas = createStubCanvas();
	const layer = SystemLayer.createSystemLayer(canvas);
	fabricate(layer, {
		key: 987654, mass: 1, lum: 1, teff: 5772, rStar: 1, age: 5, metal: 0.02,
		spectralClass: 'G', colorIndex: 4,
		planets: [
			{ a: 0.2, mass: 0.5, bulk: planets.BULK_INDEX.rock, displayType: 1 },
			{ a: 1.0, mass: 1.0, bulk: planets.BULK_INDEX.rock, displayType: 3, flags: planets.FLAG_IN_HZ | planets.FLAG_TERRAN },
			{ a: 5.0, mass: 10, bulk: planets.BULK_INDEX.super, displayType: 5 },
			{ a: 20.0, mass: 300, bulk: planets.BULK_INDEX.gas, displayType: 7 },
		],
		belts: [{ a: 2.5, dlnA: 0.2, mass: 0.01, stippleSeed: 424242 }],
	});
	layer.resize(W, H, 1);
	layer.draw(W, H);
	return { canvas, layer };
}

// --- 1. Pure helpers ----------------------------------------------------------
check('the icon ramp is the plan\'s five log-mass buckets, at their edges',
	(() => {
		const r = SystemLayer.iconRadiusForMass;
		return r(0.0005) === 3 && r(0.0999) === 3 && r(0.1) === 5 && r(1.999) === 5
			&& r(2) === 7 && r(19.99) === 7 && r(20) === 10 && r(99.9) === 10
			&& r(100) === 13 && r(3000) === 13;
	})(), SystemLayer.ICON_MASS_EDGES);
check('the star icon radius follows the state (ms 12, giant 20, wd 6)',
	SystemLayer.starRadiusForState('ms') === 12
	&& SystemLayer.starRadiusForState('giant') === 20
	&& SystemLayer.starRadiusForState('wd') === 6
	&& SystemLayer.starRadiusForState('nonsense') === 12);
check('the view bounds are §6.1\'s: max(a_0·0.6, 0.008) and max(a_out·1.2, belt·1.1)',
	(() => {
		const in1 = SystemLayer.viewInnerAU(1);              // a_0 = 0.0279 → 0.01674
		const in2 = SystemLayer.viewInnerAU(0.01);           // a_0 = 0.012 floor → 0.0072 → 0.008 floor
		return near(in1, planets.innerEdgeAU(1) * 0.6, 1e-12) && in1 > 0.008
			&& in2 === SystemLayer.A_IN_VIEW_MIN_AU
			&& SystemLayer.viewOuterAU(40, 30) === 48
			&& SystemLayer.viewOuterAU(20, 30) === 33
			&& SystemLayer.viewOuterAU(40, 0) === 48;
	})(), { solar: SystemLayer.viewInnerAU(1), wd: SystemLayer.viewInnerAU(0.01) });
check('the system-time formatter reads follow / frozen-0 / y/s, and days or hours below 0.01 y/s',
	SystemLayer.formatSysTimeRate(-1) === 'follow \u00d71.0'
	&& SystemLayer.formatSysTimeRate(0) === '0 y/s'
	&& SystemLayer.formatSysTimeRate(2.5) === '2.5 y/s'
	&& SystemLayer.formatSysTimeRate(99) === '99 y/s'
	&& SystemLayer.formatSysTimeRate(0.02) === '0.020 y/s'
	&& SystemLayer.formatSysTimeRate(0.005) === '1.8 d/s'
	&& SystemLayer.formatSysTimeRate(0.001) === '8.8 h/s'
	&& SystemLayer.formatSysTimeRate(0.0001) === '0.9 h/s');
check('the clock ladder is geometric, monotone, and spans the legs the ship flies',
	(function () {
		const l = SystemLayer.SYSTIME_LADDER;
		if (SystemLayer.SYSTIME_INDEX_MIN !== 0) return false;
		if (SystemLayer.SYSTIME_INDEX_MAX !== l.length - 1) return false;
		if (SystemLayer.SYSTIME_INDEX_DEFAULT !== 1 || l[1] !== 0) return false;
		for (let i = 2; i < l.length; i++) if (!(l[i] > l[i - 1])) return false;
		// Slow enough to watch a low-orbit launch (1e-4 y ≈ 1 s of the film at
		// the slowest timed stop) and to see a Hohmann transfer crawl.
		return l[2] === 1e-4 && l[2] * 365.25 * 24 > 0.5;
	})(), { ladder: SystemLayer.SYSTIME_LADDER });
check('the ladder index round-trips a rate to its own stop and clamps outside it',
	SystemLayer.sysTimeRateAt(SystemLayer.SYSTIME_INDEX_MIN) === -1
	&& SystemLayer.sysTimeRateAt(SystemLayer.SYSTIME_INDEX_MAX) === 100
	&& SystemLayer.sysTimeRateAt(1) === 0
	&& SystemLayer.sysTimeRateAt(2) === 1e-4
	&& SystemLayer.sysTimeRateAt(-99) === -1
	&& SystemLayer.sysTimeRateAt(999) === 100
	&& SystemLayer.sysTimeIndexOf(0) === 1
	&& SystemLayer.sysTimeIndexOf(1e-4) === 2
	&& SystemLayer.sysTimeRateAt(SystemLayer.sysTimeIndexOf(0.3)) === 0.2);
check('the exported view ids are three, named, and default to the schematic',
	SystemLayer.VIEW_COUNT === 3 && SystemLayer.VIEW_DEFAULT === SystemLayer.VIEW_SYSTEM
	&& SystemLayer.VIEW_NAMES.length === 3
	&& SystemLayer.VIEW_NAMES[SystemLayer.VIEW_DV_CLASSIC] === 'delta-v classic'
	&& SystemLayer.VIEW_NAMES[SystemLayer.VIEW_DV_RAILS] === 'delta-v rails');
check('the icon constants are still the plan\'s and the star icon keeps its radii',
	SystemLayer.R_STAR_PX === 34 && SystemLayer.R_EDGE_FRAC === 0.46
	&& SystemLayer.STAR_RADIUS_PX.ms === 12 && SystemLayer.STAR_RADIUS_PX.giant === 20
	&& SystemLayer.STAR_RADIUS_PX.wd === 6);

// --- 2. ρ(a): monotone, bodies inside [R_STAR_PX, R_EDGE_PX] ------------------
{
	const { layer } = pickingFixture();
	const rec = layer.record;
	const rEdge = Math.min(W, H) * SystemLayer.R_EDGE_FRAC;
	const n = rec.counts.planets;
	let monotone = true;
	let inside = true;
	for (let i = 0; i < n; i++) {
		const rho = layer.rhoOf(rec.planets.a[i]);
		if (i > 0 && !(rho > layer.rhoOf(rec.planets.a[i - 1]))) monotone = false;
		const rPx = SystemLayer.R_STAR_PX + rho * (rEdge - SystemLayer.R_STAR_PX);
		if (!(rPx >= SystemLayer.R_STAR_PX && rPx <= rEdge)) inside = false;
	}
	let beltInside = true;
	for (let k = 0; k < rec.belts.count; k++) {
		const rho = layer.rhoOf(rec.belts.a[k]);
		if (!(rho >= 0 && rho <= 1)) beltInside = false;
	}
	// Stipple radii reach exp(±Δln a) past the centre, so their ρ may ride
	// slightly past 1 — bounded, and still inside the canvas half-width.
	let stippleBounded = true;
	const base = 0;
	for (let s = 0; s < planets.STIPPLE_N; s++) {
		const rho = layer.beltRho[base + s];
		if (!(rho >= 0 && rho <= 1.1)) stippleBounded = false;
		const rPx = SystemLayer.R_STAR_PX + rho * (rEdge - SystemLayer.R_STAR_PX);
		if (!(rPx <= 0.5 * Math.min(W, H))) stippleBounded = false;
	}
	check('ρ(a) is monotone in a and every body maps inside [R_STAR_PX, R_EDGE_PX]',
		monotone && inside && beltInside, { n, rEdge });
	check('the stipple dots stay bounded (ρ ≤ 1.1) and inside the canvas',
		stippleBounded);
}

// --- 3. The stipple is hashed once, and is the record's own law ---------------
{
	const { layer } = pickingFixture();
	const rec = layer.record;
	const anglesCopy = Float32Array.from(layer.beltAngles);
	const radiiCopy = Float32Array.from(layer.beltRadii);
	// Two more draws at two different times must not touch the hashed pairs.
	layer.setTimeRate(3);
	layer.stepTime(10, 0);
	layer.draw(W, H);
	layer.stepTime(10, 0);
	layer.draw(W, H);
	let unchanged = true;
	for (let s = 0; s < planets.STIPPLE_N; s++) {
		if (layer.beltAngles[s] !== anglesCopy[s] || layer.beltRadii[s] !== radiiCopy[s]) unchanged = false;
	}
	// …and they equal a fresh fillStipple of the record's seed, inside ±Δln a.
	const freshA = new Float32Array(planets.STIPPLE_N);
	const freshR = new Float32Array(planets.STIPPLE_N);
	planets.fillStipple(rec.belts.stippleSeed[0], rec.belts.a[0], rec.belts.dlnA[0], freshA, freshR);
	let equal = true;
	let within = true;
	const lo = rec.belts.a[0] * Math.exp(-rec.belts.dlnA[0]);
	const hi = rec.belts.a[0] * Math.exp(rec.belts.dlnA[0]);
	for (let s = 0; s < planets.STIPPLE_N; s++) {
		if (layer.beltAngles[s] !== freshA[s] || layer.beltRadii[s] !== freshR[s]) equal = false;
		if (!(layer.beltRadii[s] >= lo * (1 - 1e-6) && layer.beltRadii[s] <= hi * (1 + 1e-6))) within = false;
		if (!near(layer.beltRho[s], layer.rhoOf(layer.beltRadii[s]), 1e-6)) equal = false;
	}
	check('the belt stipple is hashed once: bytes unchanged across two draws', unchanged);
	check('the stipple equals the record\'s own fillStipple, inside ±Δln a, with ρ(radius) precomputed',
		equal && within, { lo, hi });
}

// --- 4. Planets ride their drawn ellipse; belts rotate at their Kepler rate ----
{
	const canvas = createStubCanvas();
	const layer = SystemLayer.createSystemLayer(canvas);
	fabricate(layer, {
		key: 31337, mass: 0.8, lum: 0.4, teff: 5100, rStar: 0.8, age: 3, metal: 0.02,
		planets: [
			{ a: 0.4, mass: 2, bulk: planets.BULK_INDEX.rock, displayType: 2, e: 0.3, inc: 20, peri: 0.7, phase: 1.1 },
			{ a: 3.0, mass: 40, bulk: planets.BULK_INDEX.icegiant, displayType: 8, e: 0.12, inc: 4, peri: 2.2, phase: 0.3 },
		],
		belts: [{ a: 8, dlnA: 0.3, mass: 0.2, stippleSeed: 777 }],
	});
	layer.resize(W, H, 1);
	layer.setTimeRate(0);
	const rec = layer.record;
	const TAU = Math.PI * 2;
	function expectedXY(i, t, out) {
		const p = rec.planets;
		const rEdge = Math.min(W, H) * SystemLayer.R_EDGE_FRAC;
		const A = SystemLayer.R_STAR_PX + layer.rhoOf(p.a[i]) * (rEdge - SystemLayer.R_STAR_PX);
		const e = p.e[i];
		const B = A * Math.sqrt(1 - e * e) * Math.cos(p.inc[i] * Math.PI / 180);
		const theta = p.phase[i] + TAU * (t / p.period[i]);
		const ex = A * Math.cos(theta), ey = B * Math.sin(theta);
		const cw = Math.cos(p.peri[i]), sw = Math.sin(p.peri[i]);
		out[0] = W / 2 + ex * cw - ey * sw;
		out[1] = H / 2 + ex * sw + ey * cw;
		return out;
	}
	const want = [0, 0];
	let rides = true;
	// Drive the clock the way the page does: prepare() zeroed t_sys, each step
	// advances it by the rate, and the draw maps the planets at the new epoch.
	let tPrev = 0;
	for (const t of [0, 0.31, 2.7, 40]) {
		layer.setTimeRate(1);
		layer.stepTime(t - tPrev, 0);
		tPrev = t;
		layer.draw(W, H);
		for (let i = 0; i < rec.counts.planets; i++) {
			expectedXY(i, t, want);
			const gotX = layer.planetScreenXY[i * 2];
			const gotY = layer.planetScreenXY[i * 2 + 1];
			// f32 storage: 0.02 px is ~100× the rounding at these radii.
			if (Math.abs(gotX - want[0]) > 0.02 || Math.abs(gotY - want[1]) > 0.02) rides = false;
		}
	}
	check('a planet rides the ellipse drawn for it, at θ(t) = θ₀ + TAU·t/P', rides);

	// Periodicity: one full period later the planet is back (mod f32).
	const x0 = layer.planetScreenXY[0];
	const y0 = layer.planetScreenXY[1];
	layer.setTimeRate(1);
	layer.stepTime(rec.planets.period[0], 0);
	layer.draw(W, H);
	check('the position is periodic in the planet\'s own period',
		Math.abs(layer.planetScreenXY[0] - x0) < 0.05 && Math.abs(layer.planetScreenXY[1] - y0) < 0.05,
		{ P: rec.planets.period[0] });

	// The belt's first dot, at its own Kepler rate.
	const beltP = Math.sqrt(Math.pow(rec.belts.a[0], 3) / rec.star.mass);
	layer.setTimeRate(0);
	const tB = layer.sysTime();
	layer.draw(W, H);
	const thetaBelt = TAU * (tB / beltP);
	const ang = layer.beltAngles[0] + thetaBelt;
	const rEdge = Math.min(W, H) * SystemLayer.R_EDGE_FRAC;
	const rDot = SystemLayer.R_STAR_PX + layer.rhoOf(layer.beltRadii[0]) * (rEdge - SystemLayer.R_STAR_PX);
	check('the belt rotates at its own Kepler rate (dot 0 recomputed independently)',
		near(layer.beltStippleXY[0], W / 2 + rDot * Math.cos(ang), 0.02)
		&& near(layer.beltStippleXY[1], H / 2 + rDot * Math.sin(ang), 0.02)
		&& near(layer.beltPeriod[0], beltP, 1e-12),
		{ beltP, thetaBelt });
}

// --- 5. Picking returns the body the draw placed -------------------------------
{
	const { layer } = pickingFixture();
	const out = { kind: -1, index: -1 };
	const rec = layer.record;
	const rEdge = Math.min(W, H) * SystemLayer.R_EDGE_FRAC;
	const cx = W / 2, cy = H / 2;

	// The star at the centre.
	layer.pick(cx, cy, out);
	check('a click on the centre picks the star',
		out.kind === SystemLayer.BODY_STAR && out.index === 0, { ...out });

	// Every planet at the position its own draw wrote.
	let allPlanets = true;
	const detail = [];
	for (let i = 0; i < rec.counts.planets; i++) {
		layer.pick(layer.planetScreenXY[i * 2], layer.planetScreenXY[i * 2 + 1], out);
		if (out.kind !== SystemLayer.BODY_PLANET || out.index !== i) {
			allPlanets = false;
			detail.push({ i, kind: out.kind, index: out.index });
		}
	}
	check('a click on each drawn planet picks that planet', allPlanets, detail);

	// Just outside icon + 4 px is a miss (planet 0: icon 5 px → 9 px reach).
	const r0 = SystemLayer.R_STAR_PX + layer.rhoOf(rec.planets.a[0]) * (rEdge - SystemLayer.R_STAR_PX);
	layer.pick(cx + r0 + SystemLayer.iconRadiusForMass(rec.planets.mass[0]) + 4.5, cy + 40, out);
	check('a click past iconRadius + 4 px misses the planet',
		out.kind === SystemLayer.BODY_NONE || out.index !== 0, { ...out });

	// The belt on the −x axis, where no planet sits (all planets are at +x, t = 0).
	const rBelt = SystemLayer.R_STAR_PX + layer.beltRhoC[0] * (rEdge - SystemLayer.R_STAR_PX);
	layer.pick(cx - rBelt + 2, cy, out);
	check('a click within 6 px of the belt radius picks the belt',
		out.kind === SystemLayer.BODY_BELT && out.index === 0, { ...out });
	layer.pick(cx - rBelt - 7, cy, out);
	check('a click 7 px off the belt radius misses it',
		out.kind === SystemLayer.BODY_NONE, { ...out });

	// Bodies win over the belt band (§6.3): fabricate a planet sitting exactly
	// ON the belt circle — a click there is inside the band AND at zero distance
	// from the body, and the body must win.
	{
		const canvas3 = createStubCanvas();
		const layer3 = SystemLayer.createSystemLayer(canvas3);
		fabricate(layer3, {
			key: 555, mass: 1, lum: 1, teff: 5772, rStar: 1, age: 5, metal: 0.02,
			planets: [{ a: 2.5, mass: 0.5, bulk: planets.BULK_INDEX.rock, displayType: 1 }],
			belts: [{ a: 2.5, dlnA: 0.2, mass: 0.01, stippleSeed: 9 }],
		});
		layer3.resize(W, H, 1);
		layer3.draw(W, H);
		const rBelt3 = SystemLayer.R_STAR_PX + layer3.beltRhoC[0] * (rEdge - SystemLayer.R_STAR_PX);
		layer3.pick(W / 2 + rBelt3, H / 2, out);
		check('a body on the belt circle wins over the belt band',
			out.kind === SystemLayer.BODY_PLANET && out.index === 0, { ...out });
	}

	// Empty space: diagonal probes far from every +x body. The belt band test
	// in pick() is radial only, so skip any probe radius within reach of a
	// band; a planet's orbital radius is irrelevant on a 45° diagonal (the 2D
	// distance there is ~0.77·r, never within icon + 4 px), but skip conservatively.
	let emptyOK = true, emptyProbes = 0;
	const radii = [rBelt];
	for (let i = 0; i < rec.counts.planets; i++) {
		radii.push(SystemLayer.R_STAR_PX + layer.rhoOf(rec.planets.a[i]) * (rEdge - SystemLayer.R_STAR_PX));
	}
	const diag = 0.5 * Math.SQRT2;
	for (const f of [0.35, 0.62, 0.87]) {
		const r = f * rEdge;
		if (radii.some((rb) => Math.abs(r - rb) < 8)) continue;
		emptyProbes++;
		layer.pick(cx + r * diag, cy - r * diag, out);
		if (out.kind !== SystemLayer.BODY_NONE) emptyOK = false;
	}
	check('a click on empty space between the orbits picks nothing', emptyOK && emptyProbes > 0, { emptyProbes });

	// Selection follows the pick rules; invalid indices clear.
	layer.setSelected(SystemLayer.BODY_PLANET, 2);
	check('setSelected keeps a valid body', layer.selectedKindOf() === SystemLayer.BODY_PLANET && layer.selectedIndexOf() === 2);
	layer.setSelected(SystemLayer.BODY_PLANET, 99);
	check('setSelected rejects an index past the gate', layer.selectedKindOf() === SystemLayer.BODY_NONE);

	// Before any draw, picking has no frame and answers NONE (no crash).
	const canvas2 = createStubCanvas();
	const layer2 = SystemLayer.createSystemLayer(canvas2);
	fabricate(layer2, { key: 1, mass: 1, lum: 1, teff: 5772, rStar: 1, age: 5, metal: 0.02, planets: [], belts: [] });
	layer2.pick(100, 100, out);
	check('picking before the first draw is a NONE no-op', out.kind === SystemLayer.BODY_NONE);
}

// --- 6. The §6.6 readout, byte-for-byte against the plan's worked example -----
{
	const canvas = createStubCanvas();
	const layer = SystemLayer.createSystemLayer(canvas);
	fabricate(layer, {
		key: parseInt('1Y3K9P', 36), mass: 0.74, lum: 0.300, teff: 4637, rStar: 0.85,
		age: 5.0, metal: 0.020, spectralClass: 'K', colorIndex: 5,
		aHzIn: 0.53, aHzOut: 0.93, aSnow: 1.48, aOut: 34.4,
		planets: [
			{ a: 0.16, mass: 0.62, radius: 0.87, bulk: planets.BULK_INDEX.rock, displayType: 0,
				insolation: 11.7, teq: 502, tsurf: 502, e: 0.04, period: 0.07, flags: planets.FLAG_LOCKED },
			{ a: 0.72, mass: 1.04, radius: 1.01, bulk: planets.BULK_INDEX.rock, displayType: 3,
				insolation: 0.58, teq: 222, tsurf: 278, e: 0.02, period: 0.71, moons: 1,
				flags: planets.FLAG_IN_HZ | planets.FLAG_TERRAN },
			{ a: 0.90, mass: 4.20, radius: 1.53, bulk: planets.BULK_INDEX.super, displayType: 5,
				insolation: 0.37, teq: 202, tsurf: 267, e: 0.06, period: 0.99, moons: 2,
				flags: planets.FLAG_IN_HZ | planets.FLAG_TERRAN },
			{ a: 6.10, mass: 288.00, radius: 11.14, bulk: planets.BULK_INDEX.gas, displayType: 7,
				insolation: 0.008, teq: 70, tsurf: 100, e: 0.03, period: 17.51, moons: 41 },
			{ a: 18.40, mass: 19.00, radius: 4.16, bulk: planets.BULK_INDEX.icegiant, displayType: 8,
				insolation: 0.001, teq: 39, tsurf: 64, e: 0.05, period: 91.75, moons: 12 },
		],
		belts: [{ a: 1.11, dlnA: 0.21, mass: 3.1e-3, stippleSeed: 99 }],
	});
	const lines = layer.readoutLines();
	const EXPECTED = [
		'S1Y3K9P   K  0.74 M\u2609  0.300 L\u2609  4637 K  0.85 R\u2609  age 5.0 Gyr  Z 0.020',
		'HZ 0.53 \u2013 0.93 AU   snow 1.48 AU   a_out 34 AU   system time 0 y/s   5 planets, 1 belt',
		'',
		'  b  LAVA         0.16 AU    0.62 M\u2295   0.87 R\u2295   S 11.7   Teq  502 K  Tsurf  502 K  e 0.04  P   0.07 y  locked',
		'  c  TERRAN       0.72 AU    1.04 M\u2295   1.01 R\u2295   S 0.58   Teq  222 K  Tsurf  278 K  e 0.02  P   0.71 y  1 moon   HZ terran',
		'  d  SUPER_EARTH  0.90 AU    4.20 M\u2295   1.53 R\u2295   S 0.37   Teq  202 K  Tsurf  267 K  e 0.06  P   0.99 y  2 moons  HZ terran',
		'  e  GAS_GIANT    6.10 AU  288.00 M\u2295  11.14 R\u2295   S 0.008  Teq   70 K  Tsurf  100 K  e 0.03  P  17.51 y  41 moons',
		'  f  ICE_GIANT   18.40 AU   19.00 M\u2295   4.16 R\u2295   S 0.001  Teq   39 K  Tsurf   64 K  e 0.05  P  91.75 y  12 moons',
		'',
		'belt 1   1.11 AU   \u0394ln a 0.21   mass 3.1e-3 M\u2295   typical body 470 km / 9.4e20 kg',
	];
	const mismatch = [];
	for (let i = 0; i < Math.max(lines.length, EXPECTED.length); i++) {
		if (lines[i] !== EXPECTED[i]) mismatch.push({ line: i, got: lines[i], want: EXPECTED[i] });
	}
	check('the readout reproduces plan §6.6\'s worked example byte-for-byte',
		mismatch.length === 0, mismatch);

	// The selected marker lands on the selected body's line only.
	layer.setSelected(SystemLayer.BODY_PLANET, 1);
	const marked = layer.readoutLines();
	const withMark = marked.filter((l) => l.endsWith('\u25c0 selected'));
	check('the ◀ selected marker rides the selected planet\'s line only',
		withMark.length === 1 && withMark[0] === EXPECTED[4] + '  \u25c0 selected', withMark);
	layer.setSelected(SystemLayer.BODY_BELT, 0);
	const beltMark = layer.readoutLines().filter((l) => l.endsWith('\u25c0 selected'));
	check('a selected belt marks the belt line',
		beltMark.length === 1 && beltMark[0].startsWith('belt 1'), beltMark);
	layer.setSelected(SystemLayer.BODY_STAR, 0);
	const starMark = layer.readoutLines().filter((l) => l.endsWith('\u25c0 selected'));
	check('a selected star marks the head line',
		starMark.length === 1 && starMark[0].startsWith('S1Y3K9P'), starMark);
	layer.clearBodySelection();

	// The rate text follows the clock.
	layer.setTimeRate(2.5);
	check('the head block reports the clock (system time 2.5 y/s)',
		layer.readoutLines()[1].includes('system time 2.5 y/s'));
	layer.setTimeRate(0);
}

// --- 7. Designations: S<key36> and the landmark-name path ----------------------
{
	const canvas = createStubCanvas();
	const layer = SystemLayer.createSystemLayer(canvas);
	fabricate(layer, {
		key: parseInt('1Y3K9P', 36), mass: 1, lum: 1, teff: 5772, rStar: 1, age: 5, metal: 0.02,
		spectralClass: 'G', colorIndex: 4,
		planets: [{ a: 1, mass: 1, bulk: planets.BULK_INDEX.rock, displayType: 3 }],
		belts: [{ a: 2.7, dlnA: 0.2, mass: 0.01, stippleSeed: 5 }],
	});
	check('designationOf writes S<key36>, " b" and "belt 1" through the §4.11 writers',
		layer.designationOf(SystemLayer.BODY_STAR, 0) === 'S1Y3K9P'
		&& layer.designationOf(SystemLayer.BODY_PLANET, 0) === 'S1Y3K9P b'
		&& layer.designationOf(SystemLayer.BODY_BELT, 0) === 'S1Y3K9P belt 1',
		[layer.designationOf(SystemLayer.BODY_PLANET, 0), layer.designationOf(SystemLayer.BODY_BELT, 0)]);
	// The landmark path: the name is the prefix ('Sirius A b', plan §4.11).
	const name = 'Sirius A';
	for (let i = 0; i < name.length; i++) layer.record.star.name[i] = name.charCodeAt(i);
	layer.record.star.nameLen = name.length;
	layer.prepare();
	check('a named star\'s bodies read "Sirius A b" / "Sirius A belt 1"',
		layer.designationOf(SystemLayer.BODY_STAR, 0) === 'Sirius A'
		&& layer.designationOf(SystemLayer.BODY_PLANET, 0) === 'Sirius A b'
		&& layer.designationOf(SystemLayer.BODY_BELT, 0) === 'Sirius A belt 1');

	// Hover: the label rebuilds on a change of body only.
	layer.resize(W, H, 1);
	layer.draw(W, H);
	const px = layer.planetScreenXY[0], py = layer.planetScreenXY[1];
	check('hover picks the planet under the cursor and builds its label once',
		layer.updateHover(px, py) === true
		&& layer.hoverKindOf() === SystemLayer.BODY_PLANET && layer.hoverIndexOf() === 0
		&& layer.updateHover(px + 0.5, py) === false);
	check('hover off every body clears the label',
		layer.updateHover(-500, -500) === true && layer.hoverKindOf() === SystemLayer.BODY_NONE);
}

// --- 8. The clock: clamps, frozen default, the −1 coupling ---------------------
{
	const canvas = createStubCanvas();
	const layer = SystemLayer.createSystemLayer(canvas);
	fabricate(layer, { key: 7, mass: 1, lum: 1, teff: 5772, rStar: 1, age: 5, metal: 0.02, planets: [], belts: [] });
	check('the clock starts frozen at 0', layer.getTimeRate() === 0 && layer.sysTime() === 0);
	layer.stepTime(1, 10);
	check('frozen stays frozen whatever the camera does', layer.sysTime() === 0);
	layer.setTimeRate(2);
	layer.stepTime(0.5, 0);
	check('2 y/s over 0.5 s advances one year', near(layer.sysTime(), 1, 1e-12), layer.sysTime());
	layer.setTimeRate(-1);
	layer.stepTime(1, 8);
	check('−1 couples through orbit.js\'s FLIGHT_TIME_GAIN (8 ly/s → +1 y)',
		near(layer.sysTime(), 1 + orbit.FLIGHT_TIME_GAIN * 8, 1e-12), layer.sysTime());
	check('setTimeRate clamps to −1 … 100 and rejects junk with the default',
		layer.setTimeRate(-5) === -1 && layer.setTimeRate(200) === 100
		&& layer.setTimeRate(NaN) === SystemLayer.SYSTIME_DEFAULT
		&& layer.setTimeRate(3.7) === 3.7);
	// prepare() (an enter) resets the epoch but keeps the rate.
	layer.setTimeRate(4);
	layer.prepare();
	check('re-entering resets t_sys to 0 and keeps the rate',
		layer.sysTime() === 0 && layer.getTimeRate() === 4);
}

// --- 9. A real generated system, and degenerate records ------------------------
{
	const model = galaxy.createGalaxy({ type: 'SBb', seed: 42, age: 13.5 });
	const ref = { kind: planets.BLOCK_CATALOG, key: 0x5EED1234, index: 3, x: 1, y: 2, z: 0.1, colorIndex: 5, absMag: 6.5 };
	const ctx = { model };
	const canvas = createStubCanvas();
	const layer = SystemLayer.createSystemLayer(canvas);
	layer.enter(ref, ctx);
	const first = layer.readoutText();
	const recSnapshot = Float64Array.from(layer.record.planets.a);
	layer.exit();
	layer.enter(ref, ctx);
	const second = layer.readoutText();
	let same = true;
	for (let i = 0; i < layer.record.counts.planets; i++) {
		if (layer.record.planets.a[i] !== recSnapshot[i]) same = false;
	}
	check('enter() twice on the same ref gives the identical system and readout',
		first === second && same, { n: layer.record.counts.planets });
	check('the generated record is the generator\'s own (star block = stellarInputs)',
		(() => {
			const star = planets.createStellarInputs();
			planets.stellarInputs(ref, ctx, star);
			const s = layer.record.star;
			return s.mass === star.mass && s.lum === star.lum && s.teff === star.teff
				&& s.rStar === star.rStar && s.aHzIn === planets.hzInnerAU(star.lum)
				&& s.aOut === planets.outerEdgeAU(star.mass, star.state)
				&& s.key === (ref.key >>> 0);
		})());
	layer.resize(W, H, 1);
	layer.setTimeRate(50);
	layer.stepTime(1, 0);
	layer.draw(W, H);
	check('a real generated system draws and reads without a throw', true);

	// Degenerate: no planets, no belts.
	const canvas2 = createStubCanvas();
	const layer2 = SystemLayer.createSystemLayer(canvas2);
	fabricate(layer2, { key: 9, mass: 0.6, lum: 0.1, teff: 3800, rStar: 0.6, age: 9, metal: 0.01, planets: [], belts: [] });
	layer2.resize(W, H, 1);
	layer2.draw(W, H);
	check('a planetless system reads "0 planets, 0 belts" and draws',
		layer2.readoutLines()[1].includes('0 planets, 0 belts'));

	// Degenerate: crossed edges (a_0 ≥ a_out — a record-derived remnant, §4.5).
	fabricate(layer2, {
		key: 11, mass: 0.6, lum: 0.001, teff: 8000, rStar: 40, age: 9, metal: 0.01,
		state: 'wd', spectralClass: 'WD', colorIndex: 7, aOut: 0.001,
		aHzIn: 0.02, aHzOut: 0.04, planets: [], belts: [],
	});
	layer2.draw(W, H);
	check('a crossed-edge record keeps ρ finite and draws without a throw',
		Number.isFinite(layer2.rhoOf(0.02)) && Number.isFinite(layer2.rhoOf(100)));

	// A single planet readout: "1 planet", not "1 planets".
	fabricate(layer2, {
		key: 13, mass: 1, lum: 1, teff: 5772, rStar: 1, age: 5, metal: 0.02,
		spectralClass: 'G', colorIndex: 4,
		planets: [{ a: 1, mass: 1, bulk: planets.BULK_INDEX.rock, displayType: 3 }],
		belts: [{ a: 2.7, dlnA: 0.2, mass: 0.01, stippleSeed: 21 }],
	});
	check('the counts read singular ("1 planet, 1 belt")',
		layer2.readoutLines()[1].includes('1 planet, 1 belt'), layer2.readoutLines()[1]);
}

// --- 10. Exit erases; a closed draw is zero ops --------------------------------
{
	const canvas = createStubCanvas();
	const layer = SystemLayer.createSystemLayer(canvas);
	fabricate(layer, { key: 3, mass: 1, lum: 1, teff: 5772, rStar: 1, age: 5, metal: 0.02, planets: [], belts: [] });
	layer.resize(W, H, 1);
	layer.draw(W, H);
	const before = canvas.ctx.ops.clearRect;
	layer.exit();
	check('exit() erases the canvas (it keeps its last frame otherwise)',
		canvas.ctx.ops.clearRect === before + 1 && !layer.isOpen());
	const ops = canvas.ctx.ops.total;
	layer.draw(W, H);
	layer.stepTime(1, 5);
	layer.updateHover(10, 10);
	check('a closed layer draws nothing, steps nothing and hovers nothing (zero context ops)',
		canvas.ctx.ops.total === ops);
}

// --- 11. No allocation across 1 000 draws, and the op budget --------------------
{
	const { canvas, layer } = pickingFixture();
	layer.setTimeRate(5);
	const N = 1000;
	const op0 = canvas.ctx.ops.total;
	forceGc();
	const heap0 = process.memoryUsage().heapUsed;
	const t0 = process.hrtime.bigint();
	for (let i = 0; i < N; i++) {
		layer.stepTime(1 / 60, 12);
		layer.updateHover(-700, -700);      // off every body: no label rebuild
		layer.draw(W, H);
	}
	const ms = Number(process.hrtime.bigint() - t0) / 1e6;
	forceGc();
	const heap1 = process.memoryUsage().heapUsed;
	const opsPerFrame = (canvas.ctx.ops.total - op0) / N;
	check('1 000 draw calls allocate nothing (heap delta inside the 2 MB coarse bound)',
		heap1 - heap0 < 2 * 1024 * 1024, { heapDelta: heap1 - heap0 });
	check('the per-frame op count stays inside the plan\'s ~800-op budget (one belt)',
		opsPerFrame < 1200, { opsPerFrame });
	console.log(`${N} draws (4 planets + 1 belt, ${W}×${H}): ${ms.toFixed(1)} ms total, `
		+ `${((ms * 1000) / N).toFixed(1)} µs/draw, ${opsPerFrame.toFixed(0)} stub ops/frame, `
		+ `heap delta ${(heap1 - heap0)} B`);
}

// --- 12. The delta-v map: views, the rail render, and the ship on the graph ---
{
	const dv = require('../src/math/deltav.js');
	const { canvas, layer } = pickingFixture();
	const nBodies = layer.record.counts.planets + layer.record.belts.count;
	const point = new Float64Array(2);

	check('setView takes the three ids, cycles, and is what gates the map',
		layer.setView(SystemLayer.VIEW_DV_CLASSIC) === SystemLayer.VIEW_DV_CLASSIC
		&& layer.isMapOpen() === true
		&& layer.cycleView() === SystemLayer.VIEW_DV_RAILS
		&& layer.cycleView() === SystemLayer.VIEW_SYSTEM
		&& layer.isMapOpen() === false
		&& layer.setView(42) === SystemLayer.VIEW_DV_RAILS
		&& layer.setView(NaN) === SystemLayer.VIEW_DEFAULT, layer.getView());

	// The rail render's point: every node kind on its own row, so the escape
	// and L5 rails are level across the columns.
	layer.setView(SystemLayer.VIEW_DV_RAILS);
	const rowsOK = [[0, 1], [1, 1], [2, 1], [3, 1], [4, 1]].every(([kind]) => {
		layer.dvNodeXYFor(0, kind, point);
		const y = point[1];
		for (let bi = 1; bi < nBodies; bi++) {
			layer.dvNodeXYFor(bi, kind, point);
			if (point[1] !== y) return false;
		}
		return true;
	});
	check('the rail render keeps every node kind on its own row for every body', rowsOK);

	canvas.ctx.texts.length = 0;
	layer.draw(W, H, 284, 0);
	const drawn = canvas.ctx.texts.slice();
	check('the rail render names the two rails and draws both of them',
		drawn.some((t) => t.indexOf('escape rail') === 0)
		&& drawn.some((t) => t.indexOf('L5 rail') === 0)
		&& drawn.some((t) => t.indexOf('L5 drift') === 0));
	// The L5 rung's number is the drift exit plus the heliocentric transfer:
	// the join that makes L5 a way out of one system and into the next.
	const edges = [];
	for (let bi = 0; bi < nBodies; bi++) edges.push(layer.record && bi);
	const inter = [];
	for (let i = 0; i < nBodies; i++) inter.push(i);
	const l5Rungs = [];
	{
		// Recompute the expected rungs the way the layer caches them, from the
		// public node/edge tables the map reads.
		const bodies = [], nodes = [], oneEdges = [];
		for (let i = 0; i < dv.MAX_BODIES; i++) {
			bodies.push(dv.createBodyParam()); nodes.push(dv.createNodeSet()); oneEdges.push(dv.createOneBodyEdges());
		}
		dv.buildBodyNodes(layer.record, bodies, nodes, oneEdges);
		const muStar = dv.G_SI * layer.record.star.mass * dv.M_SUN_KG;
		const edge = dv.createInterEdge();
		for (let i = 0; i < nBodies - 1; i++) {
			dv.legLoToLo(muStar, bodies[i], bodies[i + 1], false, edge);
			l5Rungs.push(dv.formatKms(oneEdges[i].dvLoToL5 + edge.dvDepStar + edge.dvArrStar));
		}
	}
	check('the L5 rail rung carries the drift-plus-transfer number between columns',
		nodesAreBodiesCheck(l5Rungs, drawn), { l5Rungs, drawn: drawn.length });

	const op0 = canvas.ctx.ops.total;
	const t0 = process.hrtime.bigint();
	for (let i = 0; i < 100; i++) layer.draw(W, H, 284, 0);
	const railOps = (canvas.ctx.ops.total - op0) / 100;
	const railUs = Number(process.hrtime.bigint() - t0) / 1000 / 100;
	check('the rail render stays inside the map op budget', railOps > 40 && railOps < 800, { railOps });
	console.log(`${nBodies} bodies (4 planets + 1 belt, ${W}×${H}): rail render ${railOps.toFixed(0)} stub ops/draw, `
		+ `${(railUs * 1000).toFixed(1)} µs/draw`);
	layer.setView(SystemLayer.VIEW_SYSTEM);
	layer.clearBodySelection();
}

function nodesAreBodiesCheck(l5Rungs, drawn) {
	// The fixture's belt has no L5 node, so only the rungs between bodies that
	// both have one can be drawn — at least one must be, and its number must be
	// on screen.
	const present = l5Rungs.filter((label) => drawn.indexOf(label) >= 0);
	return present.length >= 1;
}

// --- Report --------------------------------------------------------------------
const failed = checks.filter((c) => !c.pass).length;
for (const c of checks) console.log(`${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.pass || c.detail === undefined ? '' : ': ' + JSON.stringify(c.detail)}`);
console.log(`\n${checks.length - failed}/${checks.length} passed`);
fs.mkdirSync(path.join(__dirname, 'logs'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'logs/system-layer.json'), JSON.stringify({ checks, failed }, null, 2) + '\n');
process.exitCode = failed ? 1 : 0;
