// experiments/asterisms-test.js
// The observer's own figures (ui.22). The law is "what a human standing here
// would draw", so the checks are the parts of that sentence that can be
// wrong: the ranking is by *apparent* magnitude, the pool is the local sky,
// the graph is an asterism and not a mesh, and the whole thing is a function
// of the sky — same stars in, same figures out.

'use strict';

const Asterisms = require('../src/math/asterisms.js');

let checks = 0;
const failures = [];
function check(name, cond, detail) {
	checks++;
	if (cond) return;
	failures.push({ name, detail });
	console.log('  FAIL ' + name + (detail === undefined ? '' : '  -> ' + JSON.stringify(detail)));
}

// A ring of stars around the eye, evenly spaced on the sky, so the angular
// separations are known exactly: `n` stars at 360/n degrees apart.
function fillRing(pool, eye, count, radiusKpc, absMag, keyBase) {
	Asterisms.resetPool(pool);
	for (let i = 0; i < count; i++) {
		const a = (i / count) * Math.PI * 2;
		Asterisms.pushCandidate(pool, (keyBase + i) >>> 0, 0, i,
			eye[0] + Math.cos(a) * radiusKpc,
			eye[1] + Math.sin(a) * radiusKpc,
			eye[2],
			absMag, 5, eye[0], eye[1], eye[2]);
	}
	return pool.count;
}

// --- 1. The magnitude law -------------------------------------------------
{
	// The definition: at 10 pc, apparent equals absolute.
	check('apparent magnitude equals absolute at 10 pc',
		Math.abs(Asterisms.apparentMagnitude(4.83, 10) - 4.83) < 1e-9,
		Asterisms.apparentMagnitude(4.83, 10));
	check('a Sun-like star at 100 pc reads 9.83, five magnitudes fainter',
		Math.abs(Asterisms.apparentMagnitude(4.83, 100) - 9.83) < 1e-9);
	check('distance makes it brighter inward, so the ranking is by flux',
		Asterisms.apparentMagnitude(0, 5) < Asterisms.apparentMagnitude(0, 50));
	check('a zero distance does not produce -Infinity',
		Number.isFinite(Asterisms.apparentMagnitude(4.83, 0)));
}

// --- 2. The pool is the local sky ----------------------------------------
{
	const eye = new Float64Array([8, 0, 0]);
	const pool = Asterisms.pool(64);
	Asterisms.resetPool(pool);
	check('a star inside the radius joins the pool',
		Asterisms.pushCandidate(pool, 1, 0, 0, 8.1, 0, 0, 4, 5, eye[0], eye[1], eye[2])
		&& pool.count === 1);
	check('a star outside the radius is refused and counted as rejected',
		!Asterisms.pushCandidate(pool, 2, 0, 1, 8 + Asterisms.MAX_RADIUS_KPC * 1.5, 0, 0, 4, 5,
			eye[0], eye[1], eye[2])
		&& pool.count === 1 && pool.rejected === 1);
	check('the radius is the naked-eye sky, not the disc',
		Asterisms.MAX_RADIUS_KPC <= 0.5 && Asterisms.MAX_RADIUS_PC === Asterisms.MAX_RADIUS_KPC * 1000,
		{ kpc: Asterisms.MAX_RADIUS_KPC, pc: Asterisms.MAX_RADIUS_PC });
	check('the unit direction really is a unit vector', (() => {
		const len = Math.hypot(pool.dir[0], pool.dir[1], pool.dir[2]);
		return Math.abs(len - 1) < 1e-12;
	})());
	Asterisms.resetPool(pool);
	const cap = Asterisms.pool(2);
	Asterisms.pushCandidate(cap, 1, 0, 0, 8.01, 0, 0, 4, 5, eye[0], eye[1], eye[2]);
	Asterisms.pushCandidate(cap, 2, 0, 1, 8.02, 0, 0, 4, 5, eye[0], eye[1], eye[2]);
	check('a full pool refuses the next candidate instead of writing past its end',
		!Asterisms.pushCandidate(cap, 3, 0, 2, 8.03, 0, 0, 4, 5, eye[0], eye[1], eye[2])
		&& cap.count === 2);
}

// --- 3. The ranking is brightest first ----------------------------------
{
	const eye = new Float64Array([0, 0, 0]);
	const fig = Asterisms.create(4);
	const pool = Asterisms.pool(64);
	Asterisms.resetPool(pool);
	// Deliberately out of order: [key, distance kpc, absolute magnitude].
	const rows = [[1, 0.20, 8], [2, 0.05, 8], [3, 0.10, 2], [4, 0.30, 0], [5, 0.02, 12]];
	for (const [key, dist, mag] of rows) {
		Asterisms.pushCandidate(pool, key, 0, key, dist, 0, 0, mag, 5, 0, 0, 0);
	}
	Asterisms.finish(fig, pool, 0, 0, 0, 0);
	check('the set is capped at its own max', fig.count === 4, fig.count);
	check('the kept stars are the brightest by apparent magnitude', (() => {
		for (let i = 1; i < fig.count; i++) if (fig.appMag[i] < fig.appMag[i - 1]) return false;
		return true;
	})(), Array.from(fig.appMag.subarray(0, fig.count)));
	// Key 3 (M = 2 at 100 pc, m = 7.0) is brighter than key 4 (M = 0 at 300 pc,
	// m = 7.39): a two-magnitude luminosity edge does not survive three times
	// the distance, which is the point of ranking by flux.
	check('the ranking is apparent, so distance can outrank luminosity',
		fig.keys[0] === 3 && fig.keys[1] === 4,
		Array.from(fig.keys.subarray(0, fig.count)));
	check('the dimmest of the five drops out',
		Array.from(fig.keys.subarray(0, fig.count)).indexOf(1) < 0);
	check('the eye is stamped into the record',
		fig.eye[0] === 0 && fig.eye[1] === 0 && fig.eye[2] === 0);
	check('the record remembers what it scanned and what it threw away',
		fig.scanned === 5 && fig.rejected === 0, { scanned: fig.scanned, rejected: fig.rejected });
	check('a rebuild bumps the revision so a caller can see it moved', (() => {
		const before = fig.revision;
		Asterisms.finish(fig, pool, 0, 0, 0, 0);
		return fig.revision === before + 1;
	})());
}

// --- 3b. A near dim star really does beat a far bright one ---------------
{
	const fig = Asterisms.create(2);
	const pool = Asterisms.pool(8);
	Asterisms.resetPool(pool);
	// M = 5 at 20 pc reads m = 6.51; M = 0 at 400 pc reads m = 8.01. The
	// intrinsically fainter star is the brighter one in this sky.
	Asterisms.pushCandidate(pool, 10, 0, 0, 0.40, 0, 0, 0, 5, 0, 0, 0);
	Asterisms.pushCandidate(pool, 11, 0, 1, 0.02, 0, 0, 5, 5, 0, 0, 0);
	Asterisms.finish(fig, pool, 0, 0, 0, 0);
	check('the near dim star ranks first', fig.keys[0] === 11, Array.from(fig.keys));
	check('the far bright star is second, not first', fig.keys[1] === 10);
	check('and the absolute magnitudes were carried unchanged',
		fig.absMag[0] === 5 && fig.absMag[1] === 0);
}

// --- 4. Ties are broken by key, so the figures are a function of the sky --
{
	const eye = new Float64Array([0, 0, 0]);
	const figA = Asterisms.create(4);
	const figB = Asterisms.create(4);
	const poolA = Asterisms.pool(64);
	const poolB = Asterisms.pool(64);
	// Identical magnitudes and distances, pushed in opposite order.
	const push = (pool, order) => {
		Asterisms.resetPool(pool);
		for (const key of order) {
			Asterisms.pushCandidate(pool, key, 0, key, 0.1 * key, 0, 0, 5, 5, 0, 0, 0);
		}
	};
	push(poolA, [7, 3, 9, 1]);
	push(poolB, [1, 9, 3, 7]);
	Asterisms.finish(figA, poolA, 0, 0, 0, 0);
	Asterisms.finish(figB, poolB, 0, 0, 0, 0);
	check('equal magnitudes tie-break on the record key, so scan order cannot flicker a figure',
		JSON.stringify(Array.from(figA.keys.subarray(0, figA.count)))
		=== JSON.stringify(Array.from(figB.keys.subarray(0, figB.count))),
		{ a: Array.from(figA.keys.subarray(0, figA.count)), b: Array.from(figB.keys.subarray(0, figB.count)) });
}

// --- 5. The graph is an asterism, not a mesh ----------------------------
{
	const eye = new Float64Array([0, 0, 0]);
	const fig = Asterisms.create(12);
	const pool = Asterisms.pool(64);
	// 12 stars on a ring: 30° apart, exactly at the edge cap, so a neighbour
	// line is allowed and the ring closes.
	fillRing(pool, eye, 12, 0.2, 5, 100);
	Asterisms.finish(fig, pool, 0, 0, 0, 0);
	check('every candidate on the ring is in the sky', fig.count === 12, fig.count);
	check('a figure has lines', fig.edgeCount > 0, fig.edgeCount);
	check('no star carries more lines than the degree cap', (() => {
		for (let i = 0; i < fig.count; i++) if (fig.degree[i] > Asterisms.MAX_DEGREE) return false;
		return true;
	})(), Array.from(fig.degree.subarray(0, fig.count)));
	check('no line is wider than the angular cap', (() => {
		const limit = Math.cos(Asterisms.MAX_EDGE_DEG * Math.PI / 180) - 1e-9;
		for (let e = 0; e < fig.edgeCount; e++) {
			const a = fig.edges[e * 2] * 3, b = fig.edges[e * 2 + 1] * 3;
			const c = fig.dir[a] * fig.dir[b] + fig.dir[a + 1] * fig.dir[b + 1] + fig.dir[a + 2] * fig.dir[b + 2];
			if (c < limit) return false;
		}
		return true;
	})());
	check('no line joins a star to itself, and none is drawn twice', (() => {
		const seen = new Set();
		for (let e = 0; e < fig.edgeCount; e++) {
			const a = fig.edges[e * 2], b = fig.edges[e * 2 + 1];
			if (a === b) return false;
			const id = a < b ? a + ':' + b : b + ':' + a;
			if (seen.has(id)) return false;
			seen.add(id);
		}
		return true;
	})());
	check('the edge count never exceeds the degree budget',
		fig.edgeCount <= fig.count * Asterisms.MAX_DEGREE, fig.edgeCount);
	check('the total line count is the handshakes the cap allows, not a triangulation',
		fig.edgeCount * 2 <= fig.count * Asterisms.MAX_DEGREE);
}

// --- 6. A wide sky draws no false figure --------------------------------
{
	const eye = new Float64Array([0, 0, 0]);
	const fig = Asterisms.create(6);
	const pool = Asterisms.pool(64);
	Asterisms.resetPool(pool);
	// Three stars 90° apart: nothing is within 30° of anything else, so a
	// person sees three stars and no shape.
	Asterisms.pushCandidate(pool, 1, 0, 0, 0.1, 0, 0, 2, 5, 0, 0, 0);
	Asterisms.pushCandidate(pool, 2, 0, 1, 0, 0.1, 0, 2, 5, 0, 0, 0);
	Asterisms.pushCandidate(pool, 3, 0, 2, 0, 0, 0.1, 2, 5, 0, 0, 0);
	Asterisms.finish(fig, pool, 0, 0, 0, 0);
	check('stars too far apart on the sky are not connected into a figure',
		fig.count === 3 && fig.edgeCount === 0, { count: fig.count, edges: fig.edgeCount });
	check('unconnected stars still belong to their own piece',
		fig.figureCount === 3, fig.figureCount);
}

// --- 7. Connected pieces ------------------------------------------------
{
	const eye = new Float64Array([0, 0, 0]);
	const fig = Asterisms.create(8);
	const pool = Asterisms.pool(64);
	Asterisms.resetPool(pool);
	// Two tight pairs on opposite sides of the sky: two figures, not one.
	Asterisms.pushCandidate(pool, 1, 0, 0, 0.10, 0, 0, 2, 5, 0, 0, 0);
	Asterisms.pushCandidate(pool, 2, 0, 1, 0.105, 0, 0, 2, 5, 0, 0, 0);
	Asterisms.pushCandidate(pool, 3, 0, 2, -0.10, 0, 0, 2, 5, 0, 0, 0);
	Asterisms.pushCandidate(pool, 4, 0, 3, -0.105, 0, 0, 2, 5, 0, 0, 0);
	Asterisms.finish(fig, pool, 0, 0, 0, 0);
	check('two clusters on opposite sides are two figures',
		fig.figureCount === 2, fig.figureCount);
	// Keys 1/3 tie on apparent magnitude (same distance, same M), so the
	// ranking interleaves the two pairs — the pieces have to be asserted by
	// key, never by slot.
	const s1 = Asterisms.starSlot(fig, 1), s2 = Asterisms.starSlot(fig, 2);
	const s3 = Asterisms.starSlot(fig, 3), s4 = Asterisms.starSlot(fig, 4);
	check('every star is labelled with a piece, contiguous from zero', (() => {
		const seen = new Set();
		for (let i = 0; i < fig.count; i++) {
			const f = fig.figureOf[i];
			if (f < 0 || f >= fig.figureCount) return false;
			seen.add(f);
		}
		return seen.size === fig.figureCount;
	})(), Array.from(fig.figureOf.subarray(0, fig.count)));
	check('figure 0 holds the brightest star',
		fig.figureOf[0] === 0, fig.figureOf[0]);
	check('the two pairs are not in the same piece',
		fig.figureOf[s1] === fig.figureOf[s2] && fig.figureOf[s3] === fig.figureOf[s4]
		&& fig.figureOf[s1] !== fig.figureOf[s3],
		{ slots: [s1, s2, s3, s4], pieces: Array.from(fig.figureOf.subarray(0, fig.count)) });
	check('a piece is exactly the stars whose directions agree',
		fig.figureOf[s1] !== fig.figureOf[s3] && fig.figureOf[s2] !== fig.figureOf[s4]);
}

// --- 8. A different position is a different sky -------------------------
{
	const figA = Asterisms.create(6);
	const figB = Asterisms.create(6);
	const poolA = Asterisms.pool(256);
	const poolB = Asterisms.pool(256);
	// One field, two eyes 0.4 kpc apart: the near stars differ, so the figures
	// differ — which is the whole reason the feature takes a position.
	const field = [];
	let seed = 12345;
	for (let i = 0; i < 120; i++) {
		seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
		const u = ((seed >>> 8) & 0xFFFFFF) / 0xFFFFFF;
		seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
		const v = ((seed >>> 8) & 0xFFFFFF) / 0xFFFFFF;
		seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
		const w = ((seed >>> 8) & 0xFFFFFF) / 0xFFFFFF;
		field.push([0.5 * (u - 0.5), 0.5 * (v - 0.5), 0.5 * (w - 0.5), 2 + 8 * u]);
	}
	const eyeA = [0, 0, 0], eyeB = [0.4, 0, 0];
	const fill = (pool, eye) => {
		Asterisms.resetPool(pool);
		field.forEach((row, i) => Asterisms.pushCandidate(pool, i + 1, 0, i,
			row[0], row[1], row[2], row[3], 5, eye[0], eye[1], eye[2]));
	};
	fill(poolA, eyeA);
	fill(poolB, eyeB);
	Asterisms.finish(figA, poolA, eyeA[0], eyeA[1], eyeA[2], 0);
	Asterisms.finish(figB, poolB, eyeB[0], eyeB[1], eyeB[2], 0);
	check('both eyes get a full set out of the same field',
		figA.count === figA.maxStars && figB.count === figB.maxStars,
		{ a: figA.count, b: figB.count });
	check('a different position sees a different sky, so it draws different figures',
		JSON.stringify(Array.from(figA.keys)) !== JSON.stringify(Array.from(figB.keys)));
	check('the same eye on the same field rebuilds the identical set', (() => {
		const figC = Asterisms.create(6);
		fill(poolA, eyeA);
		Asterisms.finish(figC, poolA, eyeA[0], eyeA[1], eyeA[2], 0);
		return JSON.stringify(Array.from(figC.keys)) === JSON.stringify(Array.from(figA.keys))
			&& JSON.stringify(Array.from(figC.edges.subarray(0, figC.edgeCount * 2)))
			=== JSON.stringify(Array.from(figA.edges.subarray(0, figA.edgeCount * 2)));
	})());
}

// --- 9. Staleness and membership ---------------------------------------
{
	const fig = Asterisms.create(4);
	const pool = Asterisms.pool(16);
	const eye = new Float64Array([0, 0, 0]);
	Asterisms.resetPool(pool);
	Asterisms.pushCandidate(pool, 1, 0, 0, 0.1, 0, 0, 3, 5, 0, 0, 0);
	Asterisms.pushCandidate(pool, 2, 0, 1, 0.2, 0, 0, 3, 5, 0, 0, 0);
	Asterisms.finish(fig, pool, 0, 0, 0, 100);
	check('the build stamps the star time it was built at', fig.starTimeMyr === 100);
	check('a figure is fresh just under its staleness window',
		!Asterisms.stale(fig, 100 + Asterisms.STALE_MYR - 1));
	check('and stale at it, in either direction',
		Asterisms.stale(fig, 100 + Asterisms.STALE_MYR)
		&& Asterisms.stale(fig, 100 - Asterisms.STALE_MYR));
	check('membership difference is zero against its own key list',
		Asterisms.membershipDifference(fig, fig.keys, fig.count) === 0);
	check('a swapped star counts as two differences — one out, one in',
		Asterisms.membershipDifference(fig, new Uint32Array([1, 99]), 2) === 2,
		Asterisms.membershipDifference(fig, new Uint32Array([1, 99]), 2));
	check('a wholly different sky counts every star',
		Asterisms.membershipDifference(fig, new Uint32Array([7, 8]), 2) === 4);
	check('starSlot finds a member by key and refuses a stranger',
		Asterisms.starSlot(fig, 2) === 1 && Asterisms.starSlot(fig, 12345) === -1);
}

// --- 10. Degenerate input ------------------------------------------------
{
	const fig = Asterisms.create(8);
	const pool = Asterisms.pool(16);
	Asterisms.resetPool(pool);
	Asterisms.finish(fig, pool, 0, 0, 0, 0);
	check('an empty sky builds an empty figure set without throwing',
		fig.count === 0 && fig.edgeCount === 0 && fig.figureCount === 0);
	check('and reports that it drew nothing', fig.scanned === 0);
	Asterisms.resetPool(pool);
	Asterisms.pushCandidate(pool, 1, 0, 0, 0, 0, 0, 3, 5, 0, 0, 0);
	Asterisms.finish(fig, pool, 0, 0, 0, 0);
	check('a single star is a figure of one, with no lines',
		fig.count === 1 && fig.edgeCount === 0 && fig.figureCount === 1);
	check('the eye itself (zero distance) does not produce NaN anywhere',
		Number.isFinite(fig.appMag[0]) && Number.isFinite(fig.dir[0]),
		{ mag: fig.appMag[0], dir: fig.dir[0] });
	check('a default max is used when the caller asks for none',
		Asterisms.create(0).maxStars === Asterisms.DEFAULT_MAX_STARS);
}

console.log(`\n${checks - failures.length}/${checks} passed, ${failures.length} failed`);
console.log('\n=== VERDICT ===');
console.log(failures.length === 0
	? 'PASS — the observer\u2019s figures are the brightest local sky, drawn as an asterism, deterministically'
	: `FAIL — ${failures.length} checks failed`);
process.exit(failures.length === 0 ? 0 : 1);
