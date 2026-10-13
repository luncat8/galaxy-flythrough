// experiments/system-layer-test.js
// 0.5.3 close-system schematic (0.5 plan §6): the headless contract of
// src/render/system-layer.js over real generated systems. A stub 2D context
// records every canvas call, so the checks are black-box — the layer is asked
// what it drew, not how.
//
// Pins: the log-polar radial axis (§6.1) monotone and inside [R_STAR_PX,
// R_EDGE_PX] for every body; the five-bucket icon ramp on log mass; the belt
// stipple hashed once per system, painted in one fill and spinning at its own
// Kepler rate; §6.3's pick returning the body the draw placed, nearest wins;
// the §6.2 item 6 selection ring and hovered designation; and no allocation
// across 1 000 warm draw calls.
//
// Output: experiments/logs/system-layer.json

'use strict';

const fs = require('fs');
const path = require('path');

// Alias window so the src modules attach their API here, as in the browser.
globalThis.window = globalThis;

const galaxy = require('../src/math/galaxy.js');
const planets = require('../src/math/planets.js');
const labels = require('../src/render/label-layer.js');
const systemLayer = require('../src/render/system-layer.js');

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
	return !!pass;
}

const stats = {};
const MODEL = galaxy.createGalaxy({ type: 'SBb', seed: 42 });
const W = 900, H = 700;
const CX = W * 0.5, CY = H * 0.5;
const EDGE = Math.min(W, H) * systemLayer.EDGE_FRACTION;
const STIPPLE_N = planets.STIPPLE_N;

// ---- the stub 2D context -------------------------------------------------
// Records into preallocated buffers: the allocation check measures the
// layer's heap, so the observer must not contribute any of its own. Every arc
// remembers the styles in force and the fill or stroke that closed its
// sub-path, so a filled icon is told apart from a stroked ring and a stipple
// dot from a planet.
function createStubContext() {
	const CAP = 32768;
	const ax = new Float64Array(CAP), ay = new Float64Array(CAP), ar = new Float64Array(CAP);
	const aFill = new Array(CAP), aStroke = new Array(CAP), aOp = new Array(CAP);
	const fStyle = new Array(512), fFrom = new Int32Array(512), fTo = new Int32Array(512);
	const tx = new Float64Array(64), ty = new Float64Array(64), tText = new Array(64);
	const ctx = {
		arcX: ax, arcY: ay, arcR: ar, arcFill: aFill, arcStroke: aStroke, arcOp: aOp,
		arcCount: 0, fillCount: 0, strokeCount: 0, clearCount: 0, ops: 0,
		fillStyle: null, fillFrom: fFrom, fillTo: fTo, fillStyleLog: fStyle,
		textX: tx, textY: ty, textS: tText, textCount: 0,
		mark: 0,
		reset() {
			for (let i = 0; i < ctx.mark; i++) aOp[i] = null;
			ctx.arcCount = 0; ctx.fillCount = 0; ctx.strokeCount = 0;
			ctx.clearCount = 0; ctx.ops = 0; ctx.textCount = 0; ctx.mark = 0;
		},
		setTransform() { ctx.ops++; },
		translate() { ctx.ops++; },
		save() { ctx.ops++; },
		restore() { ctx.ops++; },
		rotate() { ctx.ops++; },
		scale() { ctx.ops++; },
		clearRect() { ctx.ops++; ctx.clearCount++; },
		beginPath() { ctx.ops++; if (ctx.mark < ctx.arcCount) ctx.mark = ctx.arcCount; },
		moveTo() { ctx.ops++; },
		lineTo() { ctx.ops++; },
		closePath() { ctx.ops++; },
		arc(x, y, r) {
			ctx.ops++;
			const i = ctx.arcCount++;
			ax[i] = x; ay[i] = y; ar[i] = r;
			aFill[i] = ctx.fillStyle; aStroke[i] = ctx.strokeStyle; aOp[i] = null;
		},
		ellipse() { ctx.ops++; },
		fill() {
			ctx.ops++; ctx.fillCount++;
			const f = ctx.fillCount - 1;
			fStyle[f] = ctx.fillStyle; fFrom[f] = ctx.mark; fTo[f] = ctx.arcCount;
			for (let i = ctx.mark; i < ctx.arcCount; i++) aOp[i] = 'fill';
			ctx.mark = ctx.arcCount;
		},
		stroke() {
			ctx.ops++; ctx.strokeCount++;
			for (let i = ctx.mark; i < ctx.arcCount; i++) aOp[i] = 'stroke';
			ctx.mark = ctx.arcCount;
		},
		fillText(text, x, y) {
			ctx.ops++;
			tx[ctx.textCount] = x; ty[ctx.textCount] = y; tText[ctx.textCount] = text;
			ctx.textCount++;
		},
		strokeText() { ctx.ops++; },
	};
	ctx.fillStyle = '';
	ctx.strokeStyle = '';
	return ctx;
}

// ---- the systems under test ----------------------------------------------
function stellarSnapshot(over) {
	const s = planets.createStellarInputs();
	s.mass = 1; s.luminosity = 1; s.teff = 5772; s.rStar = 1; s.age = 4.5;
	s.metallicity = 0.02; s.state = planets.STATE_MS; s.spec = planets.CLASS_G;
	s.colorIndex = 4; s.absMag = 4.83; s.component = 0; s.R = 1; s.distToArm = 0;
	return Object.assign(s, over);
}

const STARS = {
	sun: stellarSnapshot(),
	kDwarf: stellarSnapshot({ mass: 0.74, luminosity: 0.3, teff: 4637, rStar: 0.85, colorIndex: 5, spec: planets.CLASS_K }),
	mDwarf: stellarSnapshot({ mass: 0.35, luminosity: 0.03, teff: 3400, rStar: 0.35, colorIndex: 6, spec: planets.CLASS_M }),
	giant: stellarSnapshot({ mass: 2.4, luminosity: 60, teff: 4800, rStar: 12, state: planets.STATE_GIANT, spec: planets.CLASS_RG, colorIndex: 9 }),
};

// One generated system matching a predicate, kept: generateSystem writes in
// place, so the scan reuses one record and returns the first match it owns.
function findSystem(starName, predicate) {
	const star = STARS[starName];
	const record = planets.createSystemRecord();
	for (let k = 0; k < 9000; k++) {
		planets.generateSystem({ key: (0x51000 + k) >>> 0, block: 0, model: MODEL }, star, record);
		if (predicate(record)) return record;
	}
	return null;
}

// Well-separated planets: no two orbits at the same mapped radius, so the
// k-th icon from the centre is the k-th planet (§6.1's monotone axis).
function separated(record, min) {
	if (record.planetCount < min) return false;
	for (let p = 1; p < record.planetCount; p++) {
		if (record.planets.a[p] / record.planets.a[p - 1] < 1.3) return false;
	}
	return true;
}

function openLayer(record, ctx) {
	const layer = systemLayer.createSystemLayer({ getContext: () => ctx });
	layer.setEnabled(true);
	layer.setSystem(record);
	layer.resize(W, H, 1);
	return layer;
}

// One frame into a fresh log: the stub accumulates, and every check reads the
// frame that is on screen, exactly like a pick between frames does.
function frame(layer, ctx, pointerX, pointerY) {
	ctx.reset();
	layer.draw(W, H, pointerX === undefined ? -1 : pointerX, pointerY === undefined ? -1 : pointerY);
	return ctx;
}

// Belt stipple dots of the current frame, in draw order (belt 0's STIPPLE_N
// first), as radii and angles from the schematic's centre.
function dotRadii(ctx) {
	const out = [];
	for (let i = 0; i < ctx.arcCount; i++) {
		if (ctx.arcOp[i] !== 'fill' || ctx.arcR[i] !== systemLayer.STIPPLE_RADIUS) continue;
		out.push(Math.hypot(ctx.arcX[i] - CX, ctx.arcY[i] - CY));
	}
	return out;
}

function dotAngles(ctx) {
	const out = [];
	for (let i = 0; i < ctx.arcCount; i++) {
		if (ctx.arcOp[i] !== 'fill' || ctx.arcR[i] !== systemLayer.STIPPLE_RADIUS) continue;
		out.push(Math.atan2(ctx.arcY[i] - CY, ctx.arcX[i] - CX));
	}
	return out;
}

// Filled arcs at one of the five icon radii: the star's own icon and halo sit
// at the centre and are dropped, a stipple dot is below the smallest bucket,
// and a locked world's two half discs are one point at one radius.
function iconArcs(ctx) {
	const out = [];
	for (let i = 0; i < ctx.arcCount; i++) {
		if (ctx.arcOp[i] !== 'fill') continue;
		if (ctx.arcR[i] < systemLayer.ICON_RADII[0]) continue;
		if (ctx.arcR[i] > systemLayer.ICON_RADII[systemLayer.ICON_RADII.length - 1]) continue;
		if (Math.abs(ctx.arcX[i] - CX) < 0.001 && Math.abs(ctx.arcY[i] - CY) < 0.001) continue;
		let found = null;
		for (let j = 0; j < out.length; j++) {
			if (Math.abs(out[j].x - ctx.arcX[i]) < 0.01 && Math.abs(out[j].y - ctx.arcY[i]) < 0.01) found = out[j];
		}
		if (found) {
			if (ctx.arcR[i] < found.r) found.r = ctx.arcR[i];
			continue;
		}
		out.push({ x: ctx.arcX[i], y: ctx.arcY[i], r: ctx.arcR[i] });
	}
	return out;
}

// The icon position of one planet, drawn on its own: a planet's phase, period
// and mapped radius are independent of the rest of its system, so promoting
// it to slot 0 of a one-planet draw places it exactly where the full draw
// does. That matches an icon to its planet without assuming an ordering, and
// survives two orbits at the same mapped radius.
function planetIcon(layer, ctx, record, p) {
	const pl = record.planets;
	const save = [pl.a[0], pl.ecc[0], pl.inc[0], pl.peri[0], pl.phase[0], pl.period[0],
		pl.mass[0], pl.display[0], pl.bulk[0], pl.flags[0], record.planetCount];
	pl.a[0] = pl.a[p]; pl.ecc[0] = pl.ecc[p]; pl.inc[0] = pl.inc[p]; pl.peri[0] = pl.peri[p];
	pl.phase[0] = pl.phase[p]; pl.period[0] = pl.period[p]; pl.mass[0] = pl.mass[p];
	pl.display[0] = pl.display[p]; pl.bulk[0] = pl.bulk[p]; pl.flags[0] = pl.flags[p];
	record.planetCount = 1;
	frame(layer, ctx);
	const icons = iconArcs(ctx);
	pl.a[0] = save[0]; pl.ecc[0] = save[1]; pl.inc[0] = save[2]; pl.peri[0] = save[3];
	pl.phase[0] = save[4]; pl.period[0] = save[5]; pl.mass[0] = save[6];
	pl.display[0] = save[7]; pl.bulk[0] = save[8]; pl.flags[0] = save[9];
	record.planetCount = save[10];
	return icons.length === 1 ? icons[0] : null;
}

function hitInfo(hit) {
	return hit ? { which: hit.which, index: hit.index, dist: hit.dist } : null;
}

function wrapAngle(d) {
	while (d <= -Math.PI) d += Math.PI * 2;
	while (d > Math.PI) d -= Math.PI * 2;
	return d;
}

// ---- 1. The layout: monotone log-polar radii, inside the schematic -------
{
	const entry = findSystem('sun', r => separated(r, 4) && r.beltCount >= 1);
	const ctx = createStubContext();
	const layer = openLayer(entry, ctx);
	frame(layer, ctx);
	check('every planet of the system is drawn once',
		iconArcs(ctx).length === entry.planetCount,
		{ icons: iconArcs(ctx).length, planets: entry.planetCount });

	let inBand = true, monotone = true;
	const radii = [];
	for (let p = 0; p < entry.planetCount; p++) {
		const icon = planetIcon(layer, ctx, entry, p);
		if (!icon) { monotone = false; continue; }
		const r = Math.hypot(icon.x - CX, icon.y - CY);
		radii.push(r);
		if (r < systemLayer.R_STAR_PX - 0.001 || r > EDGE + 0.001) inBand = false;
	}
	// Non-decreasing, not strictly: a body outside the view's radial span is
	// clamped to the axis' end, and two clamped bodies share a radius.
	for (let p = 1; p < radii.length; p++) if (radii[p] < radii[p - 1]) monotone = false;
	check('every drawn body maps inside [R_STAR_PX, R_EDGE_PX]', inBand,
		{ edge: EDGE, radii: radii.map(r => Math.round(r)) });
	check('the radial axis is monotone in a for every planet', monotone,
		{ a: entry.planets.a.slice(0, entry.planetCount), radii: radii.map(r => Math.round(r)) });

	frame(layer, ctx);
	const dots = dotRadii(ctx);
	let dotIn = dots.length === STIPPLE_N * entry.beltCount;
	for (const d of dots) if (d < systemLayer.R_STAR_PX - 0.001 || d > EDGE + 0.001) dotIn = false;
	check('every belt dot is drawn inside the schematic', dotIn,
		{ dots: dots.length, belts: entry.beltCount });
	stats.layout = { planets: entry.planetCount, belts: entry.beltCount, ops: ctx.ops };
}

// ---- 2. The icon ramp: five buckets keyed on log mass --------------------
{
	const samples = [];
	for (const name of Object.keys(STARS)) {
		for (let k = 0; k < 4000 && samples.length < 320; k++) {
			const single = planets.createSystemRecord();
			planets.generateSystem({ key: (0x62000 + k) >>> 0, block: 0, model: MODEL }, STARS[name], single);
			// One planet at a time, so its icon is the only icon-radius arc
			// the draw fills: the mass → radius mapping is read exactly.
			if (single.planetCount < 1) continue;
			single.planetCount = 1;
			const ctx = createStubContext();
			openLayer(single, ctx);
			frame(openLayer(single, ctx), ctx);
			const icons = iconArcs(ctx);
			if (icons.length !== 1) continue;
			samples.push({ mass: single.planets.mass[0], r: icons[0].r });
		}
	}
	samples.sort((p, q) => p.mass - q.mass);
	let step = true;
	for (let i = 1; i < samples.length; i++) if (samples[i].r < samples[i - 1].r) step = false;
	const buckets = [...new Set(samples.map(s => s.r))];
	check('the icon radius is a non-decreasing step function of mass over the five buckets',
		step && buckets.length <= systemLayer.ICON_RADII.length
		&& buckets.every(r => systemLayer.ICON_RADII.includes(r)),
		{ samples: samples.length, buckets });
	stats.iconSamples = samples.length;
}

// ---- 3. The belt stipple: hashed once, one fill, its own Kepler rate -----
{
	const entry = findSystem('kDwarf', r => r.beltCount === 2 && r.planetCount >= 1)
		|| findSystem('sun', r => r.beltCount === 2 && r.planetCount >= 1);
	const ctx = createStubContext();
	const layer = openLayer(entry, ctx);
	frame(layer, ctx);

	// One fill closes every dot at once; no other path draws that many arcs.
	let beltFill = -1, otherBig = 0;
	for (let f = 0; f < ctx.fillCount; f++) {
		const n = ctx.fillTo[f] - ctx.fillFrom[f];
		if (n === STIPPLE_N * entry.beltCount) beltFill = f;
		else if (n > 2 * STIPPLE_N) otherBig++;
	}
	check('one fill paints the whole belt batch', beltFill >= 0 && otherBig === 0,
		{ beltFill, fills: ctx.fillCount, dots: STIPPLE_N * entry.beltCount });

	const before = dotRadii(ctx);
	const beforeAngles = dotAngles(ctx);

	// A frozen clock: no years accumulate, so the dots are where they were.
	layer.advance(1000, 0);
	frame(layer, ctx);
	const after = dotRadii(ctx);
	let frozen = after.length === before.length;
	for (let i = 0; frozen && i < after.length; i++) frozen = after[i] === before[i];
	check('rate 0 is a true freeze', frozen, { dots: after.length });

	// A second layer, same record: the hash belongs to the system, not the
	// layer instance.
	const ctxB = createStubContext();
	frame(openLayer(entry, ctxB), ctxB);
	let same = ctxB.arcCount === ctx.arcCount;
	for (let i = 0; same && i < ctx.arcCount; i++) {
		same = ctxB.arcX[i] === ctx.arcX[i] && ctxB.arcY[i] === ctx.arcY[i] && ctxB.arcR[i] === ctx.arcR[i];
	}
	check('the same system hashes to the same dots in a second layer', same);

	// One Kepler period of belt 0 returns its dots home and a quarter period
	// rotates them by exactly a quarter turn. P = sqrt(a³/M★) in years with a
	// in AU and M★ in M☉ — the units §6.4's clock counts.
	const aB = entry.belts.a[0];
	const period = Math.sqrt(aB * aB * aB / entry.star.mass);
	layer.advance(period, 1);
	frame(layer, ctx);
	let home = true;
	for (let s = 0; s < STIPPLE_N; s++) {
		if (Math.abs(dotRadii(ctx)[s] - before[s]) > 1e-9) home = false;
		if (Math.abs(wrapAngle(dotAngles(ctx)[s] - beforeAngles[s])) > 1e-9) home = false;
	}
	check('one belt period returns every dot home', home, { period });

	layer.advance(period * 0.25, 1);
	frame(layer, ctx);
	let quarter = true;
	for (let s = 0; s < STIPPLE_N; s++) {
		if (Math.abs(wrapAngle(dotAngles(ctx)[s] - beforeAngles[s]) - Math.PI / 2) > 1e-9) quarter = false;
	}
	check('a quarter period rotates the belt exactly 90°', quarter);
	stats.kepler = { period, dots: STIPPLE_N * entry.beltCount, ops: ctx.ops };
}

// The log-polar axis, read off the draw: §6.1's mapping is affine in ln a,
// r = A + B·ln a, so two planets at known semi-major axes and known screen
// radii solve for A and B. A belt's screen radius is then predicted exactly,
// which makes the belt pick band a black-box check rather than a restatement.
// Only unclamped planets count: a body outside the view's radial span maps to
// the axis' end, where the affine relation no longer holds.
function readAxis(record, placed) {
	let p = -1, q = -1;
	for (let i = 0; i < placed.length && q < 0; i++) {
		const r = Math.hypot(placed[i].x - CX, placed[i].y - CY);
		if (r <= systemLayer.R_STAR_PX + 0.001 || r >= EDGE - 0.001) continue;
		if (p < 0) { p = i; continue; }
		if (record.planets.a[i] !== record.planets.a[p]) q = i;
	}
	if (q < 0 || !placed[p] || !placed[q]) return null;
	const la = Math.log(record.planets.a[p]), lb = Math.log(record.planets.a[q]);
	const ra = Math.hypot(placed[p].x - CX, placed[p].y - CY);
	const rb = Math.hypot(placed[q].x - CX, placed[q].y - CY);
	const B = (rb - ra) / (lb - la);
	return { A: ra - B * la, B };
}

// A belt's screen radius, and its draw against the predicted one.
function beltRadius(axis, aAu) {
	return axis.A + axis.B * Math.log(aAu);
}

// ---- 4. Picking: the body the draw placed (§6.3) -------------------------
{
	// One planet and no belt, so its pad boundary is exact.
	const single = findSystem('sun', r => r.planetCount === 1 && r.beltCount === 0);
	const ctx = createStubContext();
	const layer = openLayer(single, ctx);
	frame(layer, ctx);
	const icons = iconArcs(ctx);
	if (check('a one-planet schematic draws exactly one icon', icons.length === 1)) {
		const icon = icons[0];
		const pad = icon.r + systemLayer.PICK_PAD_PX;
		const hit = layer.pick(icon.x, icon.y);
		check('a click on the icon returns that planet',
			!!hit && hit.which === systemLayer.BODY_PLANET && hit.index === 0, hitInfo(hit));
		const edge = layer.pick(icon.x + pad - 0.5, icon.y);
		check('a click inside the pad hits', !!edge && edge.index === 0, hitInfo(edge));
		const miss = layer.pick(icon.x + pad + 1, icon.y);
		check('a click past the pad misses', miss === null, hitInfo(miss));
		const star = layer.pick(CX, CY);
		check('a click on the star is not a body', star === null, hitInfo(star));
	}

	// A multi-body system with two icons whose pads overlap: every icon picks
	// back as its own planet, empty space is a miss, and nearest wins.
	const ctxM = createStubContext();
	const scan = planets.createSystemRecord();
	const layerM = openLayer(scan, ctxM);
	// A pair of pads whose midpoint both contain: the smaller icon decides
	// that contest, and a midpoint inside only one pad is not a contest.
	function overlapPair(placed) {
		for (let i = 0; i < placed.length; i++) {
			for (let j = i + 1; j < placed.length; j++) {
				const gap = Math.hypot(placed[i].x - placed[j].x, placed[i].y - placed[j].y);
				if (gap < 2 * Math.min(placed[i].r, placed[j].r) + 2 * systemLayer.PICK_PAD_PX) return [i, j];
			}
		}
		return null;
	}
	let multi = null;
	for (let k = 0; k < 400 && !multi; k++) {
		planets.generateSystem({ key: (0x71000 + k) >>> 0, block: 0, model: MODEL }, STARS.sun, scan);
		if (scan.planetCount < 3 || scan.beltCount !== 0) continue;
		const placed = [];
		for (let p = 0; p < scan.planetCount; p++) {
			const icon = planetIcon(layerM, ctxM, scan, p);
			if (icon) placed.push(icon);
		}
		if (placed.length === scan.planetCount && overlapPair(placed)) multi = { placed };
	}
	const pair = multi ? overlapPair(multi.placed) : null;
	if (check('the fixture has two icons whose pads overlap', !!multi && !!pair,
		multi && multi.placed.length)) {
		const placed = multi.placed;
		// The full frame again: the picker tests the icons the draw placed, so
		// the single-planet probe frames must be replaced by the real one.
		frame(layerM, ctxM);
		let all = true;
		for (let p = 0; p < placed.length; p++) {
			const hit = layerM.pick(placed[p].x, placed[p].y);
			if (!hit || hit.which !== systemLayer.BODY_PLANET || hit.index !== p) all = false;
		}
		check('every icon picks back as its own planet', all);

		const [i, j] = pair;
		// Not the midpoint — an exact tie there decides nothing. A fifth of
		// the way toward icon i makes it unambiguously the nearer one.
		const mx = placed[i].x + (placed[j].x - placed[i].x) * 0.2;
		const my = placed[i].y + (placed[j].y - placed[i].y) * 0.2;
		const hit = hitInfo(layerM.pick(mx, my));
		const di = Math.hypot(placed[i].x - mx, placed[i].y - my);
		const dj = Math.hypot(placed[j].x - mx, placed[j].y - my);
		const near = di <= dj ? i : j;
		check('nearest wins between overlapping pads',
			!!hit && hit.which === systemLayer.BODY_PLANET && hit.index === near,
			{ hit, near, di, dj });
		check('empty space is a miss', layerM.pick(8, 8) === null);
	}

	// A pick is refused until a frame has been laid out.
	const fresh = systemLayer.createSystemLayer({ getContext: () => createStubContext() });
	fresh.setEnabled(true);
	fresh.setSystem(single);
	check('a pick before the first draw is a miss', fresh.pick(CX, CY + 40) === null);
}

// ---- 5. Belts are picked by their radius band ----------------------------
{
	// One belt, two planets: the log-polar axis is solved from the planets, so
	// the belt's screen radius — and therefore its pick band — is predicted.
	const one = findSystem('kDwarf', r => separated(r, 2) && r.beltCount === 1)
		|| findSystem('sun', r => separated(r, 2) && r.beltCount === 1);
	const ctx = createStubContext();
	const layer = openLayer(one, ctx);
	const placed = [];
	for (let p = 0; p < one.planetCount; p++) {
		const icon = planetIcon(layer, ctx, one, p);
		if (icon) placed.push(icon);
	}
	const axis = readAxis(one, placed);
	if (check('the fixture solves the log-polar axis', !!axis, axis)) {
		const rB = beltRadius(axis, one.belts.a[0]);
		frame(layer, ctx);
		let hits = 0, misses = 0;
		for (let k = 0; k < 4; k++) {
			const theta = k * Math.PI / 2;
			// Each answer is copied out of the shared scratch before the next
			// click is walked.
			const near = hitInfo(layer.pick(CX + (rB - 4) * Math.cos(theta), CY + (rB - 4) * Math.sin(theta)));
			const far = hitInfo(layer.pick(CX + (rB + 8) * Math.cos(theta), CY + (rB + 8) * Math.sin(theta)));
			if (near && near.which === systemLayer.BODY_BELT && near.index === 0) hits++;
			if (!far || far.which !== systemLayer.BODY_BELT || far.index !== 0) misses++;
		}
		check('a click inside the belt band picks that belt', hits === 4, { rB, hits });
		check('a click past the 6 px band picks no belt', misses === 4, { misses });
	}

	// Two belts: each band picks its own belt, and nearest wins between them.
	const two = findSystem('kDwarf', r => separated(r, 2) && r.beltCount === 2
		&& r.belts.a[1] / r.belts.a[0] > 1.15)
		|| findSystem('sun', r => separated(r, 2) && r.beltCount === 2 && r.belts.a[1] / r.belts.a[0] > 1.15);
	const ctx2 = createStubContext();
	const layer2 = openLayer(two, ctx2);
	const placed2 = [];
	for (let p = 0; p < two.planetCount; p++) {
		const icon = planetIcon(layer2, ctx2, two, p);
		if (icon) placed2.push(icon);
	}
	const axis2 = readAxis(two, placed2);
	if (check('the two-belt fixture solves the log-polar axis', !!axis2, axis2)) {
		const r0 = beltRadius(axis2, two.belts.a[0]);
		const r1 = beltRadius(axis2, two.belts.a[1]);
		frame(layer2, ctx2);
		// pick() hands back one shared scratch object, so each answer is copied
		// before the next click is walked.
		const a = hitInfo(layer2.pick(CX + r0, CY));
		const b = hitInfo(layer2.pick(CX + r1, CY));
		check('each belt band picks its own belt',
			!!a && a.which === systemLayer.BODY_BELT && a.index === 0
			&& !!b && b.which === systemLayer.BODY_BELT && b.index === 1,
			{ r0, r1, a, b });
		// The dots are the band: each belt's stipple sits inside
		// [a_b·e^{-dlnA}, a_b·e^{+dlnA}] mapped through the same axis.
		const dots2 = dotRadii(ctx2);
		let inSpan = true;
		for (let b = 0; b < two.beltCount; b++) {
			const lo = beltRadius(axis2, two.belts.a[b] * Math.exp(-two.belts.dlnA[b]));
			const hi = beltRadius(axis2, two.belts.a[b] * Math.exp(two.belts.dlnA[b]));
			for (let s = 0; s < STIPPLE_N; s++) {
				const d = dots2[b * STIPPLE_N + s];
				if (d < lo - 0.001 || d > hi + 0.001) inSpan = false;
			}
		}
		check('every dot lies inside its own belt band', inSpan, { dots: dots2.length });
	}
}

// ---- 6. The selection ring and the hovered designation (§6.2 item 6) -----
{
	const entry = findSystem('sun', r => separated(r, 2) && r.beltCount >= 1);
	const ctx = createStubContext();
	const layer = openLayer(entry, ctx);
	frame(layer, ctx);
	const placed = [];
	for (let p = 0; p < entry.planetCount; p++) placed.push(planetIcon(layer, ctx, entry, p));
	check('the ring fixture draws every planet', placed.every(Boolean), placed.length);
	check('an untouched schematic labels nothing', ctx.textCount === 0, ctx.textCount);

	layer.setSelectedBody(systemLayer.BODY_PLANET, 1);
	frame(layer, ctx);
	let ring = null;
	for (let i = 0; i < ctx.arcCount; i++) {
		if (ctx.arcOp[i] === 'stroke' && ctx.arcStroke[i] === labels.SELECT_RING) {
			ring = { x: ctx.arcX[i], y: ctx.arcY[i], r: ctx.arcR[i] };
		}
	}
	const icon = placed[1];
	check('the selected planet carries the ring colour at icon radius + pad',
		!!ring && Math.abs(ring.x - icon.x) < 0.01 && Math.abs(ring.y - icon.y) < 0.01
		&& Math.abs(ring.r - (icon.r + systemLayer.PICK_PAD_PX)) < 0.01, { ring, icon });

	layer.setSelectedBody(systemLayer.BODY_BELT, 0);
	frame(layer, ctx);
	let beltRing = null;
	for (let i = 0; i < ctx.arcCount; i++) {
		if (ctx.arcOp[i] === 'stroke' && ctx.arcStroke[i] === labels.SELECT_RING) beltRing = ctx.arcR[i];
	}
	const dots = dotRadii(ctx);
	check('the selected belt is rung inside its own dot band',
		beltRing !== null && beltRing > systemLayer.R_STAR_PX && beltRing <= EDGE, { beltRing });

	layer.setSelectedBody(systemLayer.BODY_NONE, -1);
	frame(layer, ctx, placed[0].x, placed[0].y);
	check('hovering a planet draws its designation',
		ctx.textCount === 1 && ctx.textS[0] === planets.bodyDesignation(entry, 1, 0),
		[ctx.textCount, ctx.textS[0]]);
	frame(layer, ctx, placed[0].x, placed[0].y);
	check('a held hover redraws one label, not one per frame', ctx.textCount === 1, ctx.textCount);
	frame(layer, ctx, placed[1].x, placed[1].y);
	check('hovering another planet swaps the designation',
		ctx.textCount === 1 && ctx.textS[0] === planets.bodyDesignation(entry, 1, 1), ctx.textS[0]);
	frame(layer, ctx, 4, 4);
	check('hovering empty space draws no label', ctx.textCount === 0, ctx.textCount);
	frame(layer, ctx, -1, -1);
	check('a pointer off the canvas draws no label', ctx.textCount === 0, ctx.textCount);

	frame(layer, ctx, CX + dots[0], CY);
	check('hovering a belt dot draws the belt designation',
		ctx.textCount === 1 && ctx.textS[0] === planets.bodyDesignation(entry, 2, 0),
		[ctx.textCount, ctx.textS[0]]);
	stats.ring = { planets: entry.planetCount, dots: dots.length };
}

// ---- 7. The delta-v map (§7.5) --------------------------------------------
{
	const dv = require('../src/math/deltav.js');
	const entry = findSystem('sun', r => separated(r, 3) && r.beltCount >= 1);
	const ctx = createStubContext();
	const layer = openLayer(entry, ctx);
	const bodyCount = entry.planetCount + entry.beltCount;
	const bodies = [];
	for (let i = 0; i < bodyCount; i++) {
		const b = dv.createBody();
		dv.bodyFromSystem(b, entry, i < entry.planetCount ? dv.BODY_KIND_PLANET : dv.BODY_KIND_BELT,
			i < entry.planetCount ? i : i - entry.planetCount);
		bodies.push(b);
	}
	let expectedNodes = 1;   // the star
	for (const b of bodies) {
		let bits = b.nodes;
		while (bits) { expectedNodes += bits & 1; bits >>>= 1; }
	}

	layer.setMapOpen(true);
	frame(layer, ctx);
	// The star's own label sits at the end of the frame, after the edges: the
	// last bodyCount + 1 texts are the star and one column per body.
	const columns = [];
	for (let i = ctx.textCount - (bodyCount + 1); i < ctx.textCount; i++) columns.push(ctx.textS[i]);
	const expectedColumns = [planets.bodyDesignation(entry, 0, 0)];
	for (let p = 0; p < entry.planetCount; p++) expectedColumns.push(planets.bodyDesignation(entry, 1, p));
	for (let b = 0; b < entry.beltCount; b++) expectedColumns.push(planets.bodyDesignation(entry, 2, b));
	check('the map labels the star and one column per body, planets outward then belts',
		JSON.stringify(columns) === JSON.stringify(expectedColumns), columns);

	const nodes = [];
	for (let i = 0; i < ctx.arcCount; i++) {
		if (ctx.arcR[i] === systemLayer.MAP_NODE_R) nodes.push([ctx.arcX[i], ctx.arcY[i]]);
	}
	check('the map draws the star and every node the bodies have',
		ctx.arcCount === expectedNodes && ctx.clearCount === 1,
		{ arcs: ctx.arcCount, expected: expectedNodes });

	// Each column's nodes are stacked on its x, spaced MAP_NODE_DY apart.
	let stacked = true;
	let index = 0;
	for (const b of bodies) {
		let bits = b.nodes, present = 0;
		while (bits) { present += bits & 1; bits >>>= 1; }
		const ys = [];
		for (let k = 0; k < present; k++) ys.push(nodes[index + k]);
		index += present;
		for (let k = 1; k < ys.length; k++) {
			if (Math.abs(ys[k][0] - ys[0][0]) > 0.01) stacked = false;
			if (Math.abs(Math.abs(ys[k][1] - ys[k - 1][1]) - systemLayer.MAP_NODE_DY) > 0.01) stacked = false;
		}
	}
	check('each column stacks its nodes on its own x, MAP_NODE_DY apart', stacked && index === nodes.length, { nodes: nodes.length, expected: index });

	// The edge labels are km/s to one decimal, and the first one is the origin
	// column's launch leg — the same closed form dv-map-test.js pins.
	const edgeLabels = [];
	for (let i = 0; i < ctx.textCount - (bodyCount + 1); i++) edgeLabels.push(ctx.textS[i]);
	let labelsOk = edgeLabels.length > 0 && edgeLabels.every((t) => /^\d+\.\d$/.test(t));
	const launch = dv.nodeLegDv(bodies[0], dv.NODE_LOW_ORBIT);
	if (launch >= 0 && edgeLabels.length) labelsOk = labelsOk && edgeLabels[0] === launch.toFixed(1);
	check('every edge is labelled in km/s to 0.1, the launch leg first',
		labelsOk, { count: edgeLabels.length, first: edgeLabels[0], launch: launch.toFixed(1) });

	check('the map graph has nothing to pick yet (0.5.5 picks endpoints)',
		layer.pick(CX, CY) === null);

	layer.setSelectedBody(systemLayer.BODY_PLANET, 1);
	frame(layer, ctx);
	let rung = 0;
	for (let i = 0; i < ctx.arcCount; i++) {
		if (ctx.arcStroke[i] === systemLayer.SYS_SELECT_RING) rung++;
	}
	check('the selected body’s nodes are rung in the schematic’s own ring colour', rung >= 2, rung);

	layer.setMapOpen(false);
	frame(layer, ctx);
	const icon = planetIcon(layer, ctx, entry, 0);
	check('closing the map returns to the schematic, pickable again',
		!!icon && !!hitInfo(layer.pick(icon.x, icon.y)), icon);

	stats.map = { bodies: bodyCount, edges: edgeLabels.length };
}

// ---- 8. A closed view is inert -------------------------------------------
{
	const entry = findSystem('sun', r => separated(r, 2));
	const ctx = createStubContext();
	const closed = systemLayer.createSystemLayer({ getContext: () => ctx });
	closed.setSystem(entry);
	closed.resize(W, H, 1);
	ctx.reset();
	closed.advance(5, 7);
	closed.draw(W, H, 10, 10);
	check('a closed view draws nothing, picks nothing and keeps no time',
		ctx.ops === 0 && ctx.textCount === 0 && closed.pick(CX, CY) === null, ctx.ops);

	const layer = openLayer(entry, ctx);
	const aB = entry.beltCount > 0 ? entry.belts.a[0] : entry.planets.a[0];
	const period = Math.sqrt(aB * aB * aB / entry.star.mass);
	layer.advance(period * 0.25, 1);
	frame(layer, ctx);
	const spun = dotRadii(ctx);
	const spunAngles = dotAngles(ctx);

	layer.setEnabled(false);
	layer.advance(period * 4, 1);
	frame(layer, ctx, 10, 10);
	layer.setEnabled(true);
	layer.setSystem(entry);
	layer.resize(W, H, 1);
	frame(layer, ctx);
	const again = dotRadii(ctx);
	const againAngles = dotAngles(ctx);
	let reopened = again.length === spun.length;
	for (let i = 0; reopened && i < spun.length; i++) {
		if (Math.abs(again[i] - spun[i]) > 1e-9) reopened = false;
		if (Math.abs(wrapAngle(againAngles[i] - spunAngles[i])) > 1e-9) reopened = false;
	}
	check('the clock stops with the view, and reopening re-hashes the system',
		reopened, { dots: spun.length, clears: ctx.clearCount });
}

// ---- 9. No allocation across 1 000 draw calls ----------------------------
{
	const entry = findSystem('sun', r => separated(r, 2) && r.beltCount >= 1);
	const ctx = createStubContext();
	const layer = openLayer(entry, ctx);
	// Warm up first: the steady state is what the plan's budget measures, and
	// the first passes carry whatever the earlier sections left uncollected.
	for (let i = 0; i < 3000; i++) {
		layer.advance(1 / 60, 3);
		frame(layer, ctx, CX + 120 + (i % 7), CY - 60 - (i % 5));
	}
	if (global.gc) global.gc();
	const trials = [];
	for (let t = 0; t < 5; t++) {
		layer.setSystem(entry);
		frame(layer, ctx, CX + 120, CY - 60);
		if (global.gc) global.gc();
		const before = process.memoryUsage().heapUsed;
		// The clock running and the pointer walking the schematic, so every
		// per-frame path — phases, belt spin, hover, ring — is exercised.
		for (let i = 0; i < 1000; i++) {
			layer.advance(1 / 60, 3);
			frame(layer, ctx, CX + 120 + (i % 7), CY - 60 - (i % 5));
		}
		if (global.gc) global.gc();
		trials.push(process.memoryUsage().heapUsed - before);
	}
	const sorted = trials.slice().sort((a, b) => a - b);
	const median = sorted[2];
	stats.heap = { trials, median, exposedGc: !!global.gc };
	check('1 000 warm draws allocate nothing measurable', !global.gc || median < 16 * 1024, stats.heap);
}

// ---- report --------------------------------------------------------------
const failed = checks.filter(c => !c.pass).length;
for (const c of checks) console.log(`${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.detail ? ': ' + JSON.stringify(c.detail) : ''}`);
console.log(`\n${checks.length - failed}/${checks.length} passed`);
fs.writeFileSync(path.join(__dirname, 'logs/system-layer.json'),
	JSON.stringify({ checks, failed, stats }, null, 2) + '\n');
process.exitCode = failed ? 1 : 0;
