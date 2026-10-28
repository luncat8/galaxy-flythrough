// src/math/asterisms.js
// An observer's own figures: the shapes a human standing at `eye` would draw
// between the brightest stars of *their* sky.
//
// This is not the curated Milky Way sky in `data/constellations.js`. Those
// figures are history — Orion's shape is a fact about the Sun's neighbourhood
// today. These are geometry: pick the brightest stars you can see, connect
// each one to its nearest neighbours on the sky, and you have a figure. The
// two are mutually exclusive by design (`NamedSky` decides which one is on):
// a galaxy that is not the Milky Way today has no named sky, so this is the
// only set of figures it can have.
//
// The law, in the order a person would do it:
//   1. Everything farther than `MAX_RADIUS_KPC` is not in your sky — the
//      naked-eye stars are all inside ~500 pc, and a figure drawn across the
//      whole disc would connect stars that are a thousand light years apart
//      in depth and only look adjacent by accident.
//   2. Rank by *apparent* magnitude, `M + 5·log10(d_pc) − 5`, and keep the
//      brightest `maxStars`. Apparent, not absolute: a human sees flux.
//   3. Brightest first, connect each star to its nearest neighbours on the
//      unit sphere, stopping at `MAX_DEGREE` lines per star and refusing a
//      separation wider than `MAX_EDGE_DEG`. That is what makes it read as an
//      asterism instead of a triangulation: real figures are chains and
//      corners between bright stars, not a filled mesh.
//   4. Split the graph into its connected pieces; each piece is one figure.
//
// Everything is deterministic — equal magnitudes tie-break on the record key
// — so rebuilding the same sky gives the same figures, and a slow clock
// cannot make a figure flicker between two equally valid shapes.
//
// No allocation per build: the caller fills the candidate arrays and the
// result is written into the record `create()` handed back.

'use strict';

(function () {
	// The candidate pool. A human sky is local, so the scan only has to look
	// this far: 500 pc holds every star visible to the unaided eye.
	const MAX_RADIUS_KPC = 0.5;
	const MAX_RADIUS_PC = MAX_RADIUS_KPC * 1000;
	// How many stars a figure set is built from. 28 is about the count the
	// classic figures use per hemisphere, and keeps the edge pass O(n²) at
	// a few hundred operations.
	const DEFAULT_MAX_STARS = 28;
	// Three lines per star: enough for a corner, not enough for a mesh.
	const MAX_DEGREE = 3;
	// A line wider than this is not a figure, it is a coincidence of
	// projection. 30° is the scale of the real asterisms (Orion spans ~25°).
	const MAX_EDGE_DEG = 30;
	const MAX_EDGE_COS = Math.cos(MAX_EDGE_DEG * Math.PI / 180);
	// How far the clock may run before the figures are stale. At the solar
	// circle 20 Myr is ~4 pc of shear — enough to re-rank neighbours, small
	// enough that a rebuild is not a flicker.
	const STALE_MYR = 20;
	const LOG10 = Math.LN10;

	// One figure set. `edges` are index pairs into the star arrays.
	function create(maxStars, maxCandidates) {
		const n = maxStars > 0 ? maxStars | 0 : DEFAULT_MAX_STARS;
		const cap = maxCandidates > 0 ? maxCandidates | 0 : 4096;
		return {
			maxStars: n,
			// The eye the figures were built from, kpc.
			eye: new Float64Array(3),
			// The stars, brightest first.
			count: 0,
			keys: new Uint32Array(n),
			kind: new Int8Array(n),
			index: new Uint32Array(n),
			absMag: new Float32Array(n),
			appMag: new Float32Array(n),
			colorIndex: new Uint8Array(n),
			dir: new Float64Array(n * 3),     // unit vector from the eye
			world: new Float64Array(n * 3),   // drawn position at build time
			// The graph.
			edgeCount: 0,
			edges: new Int32Array(n * MAX_DEGREE * 2),
			degree: new Uint8Array(n),
			// Connected pieces, for a readout and for colouring. `parent` is
			// the union-find's own array: relabelling `figureOf` in place would
			// destroy the structure the relabel is still walking.
			figureCount: 0,
			figureOf: new Int32Array(n),
			parent: new Int32Array(n),
			// Provenance.
			starTimeMyr: 0,
			scanned: 0,
			rejected: 0,
			revision: 0,
			// Scratch the scan may use; owned here so a build allocates nothing.
			candKeys: new Uint32Array(cap),
			candKind: new Int8Array(cap),
			candIndex: new Uint32Array(cap),
			candX: new Float64Array(cap),
			candY: new Float64Array(cap),
			candZ: new Float64Array(cap),
			candMag: new Float32Array(cap),
			candColor: new Uint8Array(cap),
			candCount: 0,
			candCapacity: cap,
		};
	}

	// Apparent magnitude from an absolute one and a distance in parsecs.
	function apparentMagnitude(absMag, distPc) {
		const d = distPc > 1e-6 ? distPc : 1e-6;
		return absMag + 5 * Math.log(d) / LOG10 - 5;
	}

	// Keep the brightest `n` rows of `f` in `out` by insertion, brightest
	// first, ties broken on the record key so the result is a function of the
	// sky and not of the scan order. `out` is a plain object of typed arrays.
	function keepBrightest(f, out, n) {
		// The record's own arrays are the bound: a caller asking for more stars
		// than `create` allocated must not write past them.
		const capacity = Math.min(n, out.appMag.length);
		let count = 0;
		for (let i = 0; i < f.count; i++) {
			const mag = f.appMag[i];
			if (count >= capacity) {
				const worst = out.appMag[count - 1];
				if (mag > worst) continue;
				if (mag === worst && f.keys[i] > out.keys[count - 1]) continue;
			}
			let at = count;
			while (at > 0) {
				const prevMag = out.appMag[at - 1];
				const prevKey = out.keys[at - 1];
				if (prevMag < mag) break;
				if (prevMag === mag && prevKey < f.keys[i]) break;
				out.appMag[at] = prevMag;
				out.keys[at] = prevKey;
				out.kind[at] = out.kind[at - 1];
				out.index[at] = out.index[at - 1];
				out.absMag[at] = out.absMag[at - 1];
				out.colorIndex[at] = out.colorIndex[at - 1];
				const d3 = at * 3, s3 = (at - 1) * 3;
				out.dir[d3] = out.dir[s3];
				out.dir[d3 + 1] = out.dir[s3 + 1];
				out.dir[d3 + 2] = out.dir[s3 + 2];
				out.world[d3] = out.world[s3];
				out.world[d3 + 1] = out.world[s3 + 1];
				out.world[d3 + 2] = out.world[s3 + 2];
				at--;
			}
			out.appMag[at] = mag;
			out.keys[at] = f.keys[i];
			out.kind[at] = f.kind[i];
			out.index[at] = f.index[i];
			out.absMag[at] = f.absMag[i];
			out.colorIndex[at] = f.colorIndex[i];
			const d3 = at * 3, s3 = i * 3;
			out.dir[d3] = f.dir[s3];
			out.dir[d3 + 1] = f.dir[s3 + 1];
			out.dir[d3 + 2] = f.dir[s3 + 2];
			out.world[d3] = f.world[s3];
			out.world[d3 + 1] = f.world[s3 + 1];
			out.world[d3 + 2] = f.world[s3 + 2];
			// A full record shifts its dimmest entry out through the insertion
			// above, so the length stays at the capacity rather than growing.
			if (count < capacity) count++;
		}
		return count;
	}

	// Scan one row of the caller's candidate pool into the figure record.
	// `f` is a scratch pool (see `pool`), not the record itself — the record
	// is only written once the ranking is known.
	function pushCandidate(f, key, kind, index, x, y, z, absMag, colorIndex, eyeX, eyeY, eyeZ) {
		const dx = x - eyeX, dy = y - eyeY, dz = z - eyeZ;
		const distKpc = Math.sqrt(dx * dx + dy * dy + dz * dz);
		if (!(distKpc <= MAX_RADIUS_KPC)) { f.rejected++; return false; }
		const i = f.count;
		if (i >= f.capacity) { f.rejected++; return false; }
		f.keys[i] = key >>> 0;
		f.kind[i] = kind | 0;
		f.index[i] = index >>> 0;
		f.absMag[i] = absMag;
		f.colorIndex[i] = colorIndex & 0xFF;
		f.appMag[i] = apparentMagnitude(absMag, distKpc * 1000);
		// The direction is unit *in kpc*, the same unit the positions are in:
		// the edge pass compares dot products against cos(MAX_EDGE_DEG), which
		// is only the angular separation if both vectors are unit.
		const inv = distKpc > 0 ? 1 / distKpc : 0;
		const o = i * 3;
		f.dir[o] = dx * inv;
		f.dir[o + 1] = dy * inv;
		f.dir[o + 2] = dz * inv;
		f.world[o] = x;
		f.world[o + 1] = y;
		f.world[o + 2] = z;
		f.count++;
		return true;
	}

	function pool(capacity) {
		const cap = capacity > 0 ? capacity | 0 : 4096;
		return {
			capacity: cap, count: 0, rejected: 0,
			keys: new Uint32Array(cap), kind: new Int8Array(cap), index: new Uint32Array(cap),
			absMag: new Float32Array(cap), colorIndex: new Uint8Array(cap),
			appMag: new Float32Array(cap),
			dir: new Float64Array(cap * 3), world: new Float64Array(cap * 3),
		};
	}

	function resetPool(f) {
		f.count = 0;
		f.rejected = 0;
		return f;
	}

	function hasEdge(fig, a, b) {
		for (let e = 0; e < fig.edgeCount; e++) {
			const o = e * 2;
			if ((fig.edges[o] === a && fig.edges[o + 1] === b)
				|| (fig.edges[o] === b && fig.edges[o + 1] === a)) return true;
		}
		return false;
	}

	// The edge pass: brightest first, nearest neighbours on the sphere, with
	// a degree cap on both ends. Brightest first matters — it is why the
	// figures hang off the stars a person would name, and why a dim star
	// never becomes the hub of a shape.
	function buildEdges(fig) {
		const n = fig.count;
		fig.edgeCount = 0;
		fig.degree.fill(0);
		for (let i = 0; i < n; i++) {
			if (fig.degree[i] >= MAX_DEGREE) continue;
			const ix = fig.dir[i * 3], iy = fig.dir[i * 3 + 1], iz = fig.dir[i * 3 + 2];
			for (let pass = 0; pass < MAX_DEGREE; pass++) {
				let best = -1;
				let bestCos = MAX_EDGE_COS;
				for (let j = 0; j < n; j++) {
					if (j === i || fig.degree[j] >= MAX_DEGREE) continue;
					if (hasEdge(fig, i, j)) continue;
					const c = ix * fig.dir[j * 3] + iy * fig.dir[j * 3 + 1] + iz * fig.dir[j * 3 + 2];
					if (c > bestCos) { bestCos = c; best = j; }
				}
				if (best < 0) break;
				const o = fig.edgeCount * 2;
				fig.edges[o] = i;
				fig.edges[o + 1] = best;
				fig.edgeCount++;
				fig.degree[i]++;
				fig.degree[best]++;
			}
		}
		return fig.edgeCount;
	}

	// Connected pieces by union-find over ≤ 28 nodes. Every star belongs to a
	// piece even with no lines, so `figureOf` is always meaningful.
	function labelFigures(fig) {
		const n = fig.count;
		const parent = fig.parent;
		for (let i = 0; i < n; i++) parent[i] = i;
		const find = (a) => {
			let r = a;
			while (parent[r] !== r) r = parent[r];
			while (parent[a] !== r) { const next = parent[a]; parent[a] = r; a = next; }
			return r;
		};
		for (let e = 0; e < fig.edgeCount; e++) {
			const ra = find(fig.edges[e * 2]);
			const rb = find(fig.edges[e * 2 + 1]);
			if (ra !== rb) parent[ra] = rb;
		}
		// Roots renumbered brightest-first, so figure 0 holds the brightest
		// star. `figureOf` is written only here, after the union-find is done
		// with `parent`.
		let count = 0;
		for (let i = 0; i < n; i++) {
			const root = find(i);
			let label = -1;
			for (let j = 0; j < i; j++) {
				if (find(j) === root) { label = fig.figureOf[j]; break; }
			}
			if (label < 0) { label = count; count++; }
			fig.figureOf[i] = label;
		}
		fig.figureCount = count;
		return count;
	}

	// Rank the pool into the record and draw the figures. `starTimeMyr` is
	// stamped so the caller can tell when the set has gone stale.
	function finish(fig, f, eyeX, eyeY, eyeZ, starTimeMyr) {
		fig.eye[0] = eyeX;
		fig.eye[1] = eyeY;
		fig.eye[2] = eyeZ;
		fig.count = keepBrightest(f, fig, fig.maxStars);
		fig.scanned = f.count + f.rejected;
		fig.rejected = f.rejected;
		fig.starTimeMyr = starTimeMyr || 0;
		buildEdges(fig);
		labelFigures(fig);
		fig.revision++;
		return fig;
	}

	// Has the clock moved far enough that the figures no longer describe the
	// sky? The caller decides when to act on it; a rebuild is not free.
	function stale(fig, starTimeMyr) {
		return Math.abs((starTimeMyr || 0) - fig.starTimeMyr) >= STALE_MYR;
	}

	// The set a rebuild of the same sky would have to change: a star that left
	// the bright list, or one that joined. Count, not identity — the caller
	// only needs to know whether the picture moved.
	function membershipDifference(fig, keys, count) {
		const n = Math.min(count | 0, keys.length);
		let shared = 0;
		for (let i = 0; i < n; i++) {
			const key = keys[i] >>> 0;
			for (let j = 0; j < fig.count; j++) {
				if (fig.keys[j] === key) { shared++; break; }
			}
		}
		return Math.abs(fig.count - shared) + Math.abs(n - shared);
	}

	function starSlot(fig, key) {
		const k = key >>> 0;
		for (let i = 0; i < fig.count; i++) if (fig.keys[i] === k) return i;
		return -1;
	}

	const Asterisms = {
		MAX_RADIUS_KPC, MAX_RADIUS_PC, DEFAULT_MAX_STARS, MAX_DEGREE, MAX_EDGE_DEG, STALE_MYR,
		create, pool, resetPool, pushCandidate, finish, buildEdges, labelFigures,
		apparentMagnitude, stale, membershipDifference, starSlot,
	};
	if (typeof module !== 'undefined') module.exports = Asterisms;
	if (typeof window !== 'undefined') window.Asterisms = Asterisms;
})();
