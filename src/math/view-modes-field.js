// src/math/view-modes-field.js
// Pure-CPU heightmap fields for the view-modes experiment (archive/view-modes-shader-plan.md).
//
// The field is a function of a *view direction*: every texel stands for one ray
// leaving the camera, and its height is a smooth interpolation of the anchor
// stars that ray points near. Two layouts share that definition (plan
// "Projection"):
//
//   * 'view'  — the inside of the view sphere: the gnomonic (perspective)
//               window the app's camera really shows, texel for texel. A star's
//               place on the map is where the app draws the star, by
//               construction — that correspondence is the whole feature, so it
//               is pinned by experiments/view-modes-field-test.js.
//   * 'plane' — equirectangular chart of the sky (galactic l/b), panned by a
//               view quaternion the way planet-geotectonics pans its map: no
//               latitude clamp, longitude wraps freely.
//
// The field is computed as a *physical* scalar (one pass over the stars; no
// diffusion, no blur) and a display range maps it onto the painter's 0..1:
//
//   * 'height'   — mode 1. Shepard (inverse-distance-weighted) mean of the
//                  anchors' log10 distance from the eye (kpc): smooth, and log
//                  because the anchors span 5 pc to 800 pc — a linear ramp puts
//                  every real star within a few percent of the same colour.
//   * 'spread'   — mode 2. Weighted standard deviation of |star − eye| (kpc)
//                  over the same neighbourhood: the hidden depth between stars
//                  that look adjacent. A ridge means a 2-D shortcut is a 3-D
//                  detour.
//   * 'gradient' — mode 3. |∇ log10 d| in dex of distance per degree of sky:
//                  the derivative of mode 1, quoted in a real unit, so it has
//                  no hard top to clump against.
//
// The range (see "display range" below) is what turns any of the three into a
// colour; the field itself never renormalizes after smoothing.
//
// Weights are angular: w = 1 / (sin²δ + sin²σ), δ = the angle between the texel
// ray and the star, σ = the softening (a star's hill half-width). Two things
// follow, and both are the point: the field is defined over the whole sphere —
// stars behind the camera count, so the dome is never left unpainted — and the
// sum is smooth, so it reads as terrain rather than as Voronoi cells.
//
// Cost is O(w·h·N) at ~10 flops per pair: the exact, splat-free option the plan
// listed as too heavy for the CPU at full size. It fits a frame because the page
// budgets *texels* (autoResolution) rather than blurring a big grid, and the
// canvas upscales the result bilinearly for free.
//
// Pure functions: no DOM, no WebGL, no globals. Testable in Node.

'use strict';

(function () {
	// ---- helpers -----------------------------------------------------------

	const DEG = Math.PI / 180;
	const TAU = Math.PI * 2;
	// The log height scale never trusts a distance below this, so one star the
	// camera sits on (the Sun, 5 pc under the home pose) cannot flatten the ramp.
	const MIN_DIST_KPC = 0.001;      // 1 pc
	const MAX_STARS = 1024;          // anchor cap; the slider tops out at 500
	const HALF_PI = Math.PI / 2;

	function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

	// math/ and data/ only — the island never reaches into core/ or render/.
	function resolve(winName, nodePath) {
		if (typeof window !== 'undefined' && window[winName]) return window[winName];
		if (typeof require === 'function') return require(nodePath);
		return null;
	}

	// ---- quaternions (the page's drag-look and the chart's pan) -----------
	//
	// Same convention as core/camera.js: a unit quaternion whose rotated local
	// axes are +X forward, -Y right, +Z up.

	// q' = rot(axis, angle) * q — a world-frame turn, which is how the app
	// composes mouse look (yaw about the current up, pitch about the current
	// right), so a drag here behaves like a drag there.
	function quatTurn(out, qx, qy, qz, qw, ax, ay, az, angle) {
		const h = angle * 0.5, s = Math.sin(h);
		const bx = ax * s, by = ay * s, bz = az * s, bw = Math.cos(h);
		out[0] = bw * qx + bx * qw + by * qz - bz * qy;
		out[1] = bw * qy - bx * qz + by * qw + bz * qx;
		out[2] = bw * qz + bx * qy - by * qx + bz * qw;
		out[3] = bw * qw - bx * qx - by * qy - bz * qz;
		return out;
	}

	// q' = b * a, for composing an arc onto a pan.
	function quatMul(out, a, b) {
		const ax = a[0], ay = a[1], az = a[2], aw = a[3];
		const bx = b[0], by = b[1], bz = b[2], bw = b[3];
		out[0] = aw * bx + ax * bw + ay * bz - az * by;
		out[1] = aw * by - ax * bz + ay * bw + az * bx;
		out[2] = aw * bz + ax * by - ay * bx + az * bw;
		out[3] = aw * bw - ax * bx - ay * by - az * bz;
		return out;
	}

	// The shortest rotation carrying unit a onto unit b (the core of planet-
	// geotectonics' MapView.drag): a drag grabs a sky point and walks the chart
	// so it follows the pointer, with no Euler clamp anywhere.
	function quatArc(out, ax, ay, az, bx, by, bz) {
		const dot = ax * bx + ay * by + az * bz;
		let rx = ay * bz - az * by, ry = az * bx - ax * bz, rz = ax * by - ay * bx;
		let rw = 1 + dot;
		if (rw < 1e-7) {
			// Antipodal grab: any perpendicular axis works; pick a stable one.
			if (Math.abs(ax) < 0.9) { rx = 0; ry = az; rz = -ay; }
			else { rx = -az; ry = 0; rz = ax; }
			rw = 0;
		}
		const inv = 1 / Math.hypot(rx, ry, rz, rw);
		out[0] = rx * inv; out[1] = ry * inv; out[2] = rz * inv; out[3] = rw * inv;
		return out;
	}

	// Rotate a vector by q (in-place safe: out may alias the source triple's owner).
	function quatApply(out, x, y, z, q) {
		const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
		const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
		out[0] = x + qw * tx + qy * tz - qz * ty;
		out[1] = y + qw * ty + qz * tx - qx * tz;
		out[2] = z + qw * tz + qx * ty - qy * tx;
		return out;
	}

	function quatInv(out, q) { out[0] = -q[0]; out[1] = -q[1]; out[2] = -q[2]; out[3] = q[3]; return out; }

	function quatNormalize(out, q) {
		const l = Math.hypot(q[0], q[1], q[2], q[3]);
		if (l < 1e-12) { out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1; return out; }
		const inv = 1 / l;
		out[0] = q[0] * inv; out[1] = q[1] * inv; out[2] = q[2] * inv; out[3] = q[3] * inv;
		return out;
	}

	// The drag law of planet-geotectonics' MapView: q' = arc(a → b) · q, where a
	// and b are *chart-local* directions (chartDirAt). The chart maps a world ray
	// w to map space as q·w, so the ray under pixel p is q⁻¹·e(p); substituting
	// q' gives (arc·q)⁻¹·e₁ = q⁻¹·e₀ — the sky point pressed stays under the
	// pointer exactly, without an incremental Euler step to drift.
	//
	// Composing the same arc from *world* rays (q⁻¹·e) instead only pins the
	// press while q is the identity: once the chart is rotated, the arc is
	// applied in the wrong frame and the map both lags and accelerates.
	const dragArc = new Float64Array(4);
	const dragTmp = new Float64Array(4);
	function quatDrag(out, q, ax, ay, az, bx, by, bz) {
		quatArc(dragArc, ax, ay, az, bx, by, bz);
		quatMul(dragTmp, dragArc, q);
		return quatNormalize(out, dragTmp);
	}

	// Bit-exact twin of core/camera.js updateBasis: the rotation matrix columns
	// are the images of the local axes and the camera's right axis is -Y, so
	// `right` is the negated second column. Deriving an up vector from "galactic
	// north" instead — the first attempt here — mirrored the map left-right and
	// dropped the camera's roll, which is exactly why the heightmap did not
	// match the sky.
	function quatBasis(out, q) {
		const x = q[0], y = q[1], z = q[2], w = q[3];
		const xx = x * x, yy = y * y, zz = z * z;
		const xy = x * y, xz = x * z, yz = y * z;
		const wx = w * x, wy = w * y, wz = w * z;
		out.fx = 1 - 2 * (yy + zz); out.fy = 2 * (xy + wz); out.fz = 2 * (xz - wy);
		out.rx = -2 * (xy - wz); out.ry = -(1 - 2 * (xx + zz)); out.rz = -2 * (yz + wx);
		out.ux = 2 * (xz + wy); out.uy = 2 * (yz - wx); out.uz = 1 - 2 * (xx + yy);
		return out;
	}

	// ---- display range ----------------------------------------------------
	//
	// Every mode produces a raw scalar with a physical unit, and one range maps
	// it onto the 0..1 the painter's ramp expects:
	//
	//   mode      raw                          lo / hi domain (log10 unless noted)
	//   height    L = log10(d / kpc)           log10(kpc), hi is the NEAR end
	//   spread    σ of |star − eye| in kpc     log10(kpc)
	//   gradient  |∇L| in dex per degree       log10(dex/deg)
	//
	// Height is already logarithmic, so its range is a plain window on L; the
	// other two span orders of magnitude (pc to kpc, 1e-5 to 1 dex/°) and are
	// mapped through log10. Neither auto range nor a manual one re-stretches the
	// field after smoothing — the bounds are declared in the legend, which is
	// what keeps the colour a measurement rather than an adaptive paint.

	const RANGE_FLOOR = 1e-6;         // 0.001 pc / 1 µdex per degree: a log floor
	const SIGMA_DEG = 3;              // the default hill half-width, see computeField

	// 1 at dMin (close), 0 at dMax (far), log10 in between: the anchor-derived
	// auto range of mode 1.
	function makeScale(out, dMin, dMax) {
		out.lo = Math.log10(Math.max(MIN_DIST_KPC, dMin));
		out.hi = Math.max(out.lo + 1, Math.log10(Math.max(dMax, MIN_DIST_KPC)));
		out.span = out.hi - out.lo;
		return out;
	}
	function heightOfDistance(scale, dKpc) {
		return clamp(1 - (Math.log10(Math.max(MIN_DIST_KPC, dKpc)) - scale.lo) / scale.span, 0, 1);
	}
	function distanceAtHeight(scale, v) {
		return Math.pow(10, scale.lo + (1 - clamp(v, 0, 1)) * scale.span);
	}

	// One raw value → 0..1. Height is inverted (the near end is the top of the
	// ramp); the other modes climb with the raw value.
	function rangeValue(mode, raw, range) {
		const span = range.hi - range.lo;
		if (!(span > 0)) return 0;
		if (mode === 'height') return clamp((range.hi - raw) / span, 0, 1);
		const u = Math.log10(raw > RANGE_FLOOR ? raw : RANGE_FLOOR);
		return clamp((u - range.lo) / span, 0, 1);
	}

	function applyRange(raw, count, mode, range, out) {
		const span = range.hi - range.lo;
		const inv = span > 0 ? 1 / span : 0;
		if (mode === 'height') {
			for (let i = 0; i < count; i++) out[i] = clamp((range.hi - raw[i]) * inv, 0, 1);
			return out;
		}
		const lo = range.lo;
		for (let i = 0; i < count; i++) {
			const v = raw[i];
			const u = Math.log10(v > RANGE_FLOOR ? v : RANGE_FLOOR);
			out[i] = clamp((u - lo) * inv, 0, 1);
		}
		return out;
	}

	// The [lo, hi] a finished computeRaw pass suggests. Mode 1 spans the log
	// distances the field actually takes — so the near end is 1 and the far end
	// 0, and a set whose stars are all inside 100 pc uses the whole ramp instead
	// of a forced decade (the "range is very big, nothing shows" look). Modes 2
	// and 3 read the 5th/95th percentile of the log histogram, which keeps the
	// near-zero half of a depth or slope map from eating the ramp.
	function autoRange(mode, stats, out) {
		let a, b;
		if (mode === 'height') {
			a = stats.rawLo; b = stats.rawHi;
			if (!(b > a)) { a = Math.log10(Math.max(MIN_DIST_KPC, stats.dMin || MIN_DIST_KPC)); b = a + 0.3; }
		} else {
			a = stats.autoLo; b = stats.autoHi;
			if (!(b > a)) { a = stats.rawLo; b = a + 0.3; }
		}
		const pad = 0.04 * (b - a) + 0.02;
		out.lo = a - pad;
		out.hi = b + pad;
		if (out.hi - out.lo < 0.3) {
			const c = (out.lo + out.hi) * 0.5;
			out.lo = c - 0.15;
			out.hi = c + 0.15;
		}
		out.span = out.hi - out.lo;
		return out;
	}

	// ---- layout: texel <-> ray -------------------------------------------
	//
	// A layout owns the mapping only; it never touches the star set. `dirAt`
	// answers "which ray does this texel stand for", `texelOf` the inverse.
	// Directions are in the galactic frame (x toward l = 0, y toward l = 90,
	// z toward the north pole), the same frame the star positions live in.
	//
	//   createLayout(out, { kind:'view',  w, h, fovY, basis })
	//   createLayout(out, { kind:'plane', w, h, spanDeg, quat })

	function createLayout(out, opts) {
		const w = opts.w | 0, h = opts.h | 0;
		out.w = w; out.h = h;
		out.e = out.e || new Float64Array(3);
		out.wrapX = false;
		if (out.kind !== opts.kind) {
			out.kind = opts.kind;
			if (opts.kind === 'plane') out.quat = out.quat || new Float64Array([0, 0, 0, 1]);
		}
		if (opts.kind === 'plane') {
			const q = out.quat;
			if (opts.quat) { q[0] = opts.quat[0]; q[1] = opts.quat[1]; q[2] = opts.quat[2]; q[3] = opts.quat[3]; }
			const qi = out.quatInv || (out.quatInv = new Float64Array(4));
			quatInv(qi, q);
			// A sky chart is drawn as the viewer sees it: with galactic north up,
			// longitude grows to the LEFT (the app's own view does this by
			// construction, being a perspective projection from inside the sphere).
			// Reflecting lon in both mappings keeps that convention in one place.
			out.mirrorLon = opts.mirror !== false;
			const spanX = (opts.spanDeg || 360) * DEG;
			out.spanX = spanX;
			out.spanY = spanX * (h / w);
			out.texelRadX = spanX / w;
			out.texelRadY = out.spanY / h;
			out.wrapX = spanX >= TAU - 1e-6;
			return out;
		}
		out.basis = opts.basis;
		out.tanHalfY = Math.tan((opts.fovY || 60 * DEG) * 0.5);
		// The *window's* aspect, not the field's: the field exists to be the
		// camera's view, so it must cover exactly the same angles even when the
		// texel grid is rounded to a friendlier size. The upscale to the canvas is
		// then a pure stretch, and a marker stays on its star.
		out.aspect = opts.aspect || w / h;
		// Angular size of one texel, so the gradient pass can tell a texel of
		// longitude from a texel of latitude and the legend can quote degrees.
		out.texelRadX = 2 * out.tanHalfY * out.aspect / w;
		out.texelRadY = 2 * out.tanHalfY / h;
		return out;
	}

	// A chart pixel's ray in the chart's own frame, *before* the pan quaternion.
	// u, v ∈ [0, 1] across the map, v down; spans in radians. dirAt composes it
	// with quatInv; a drag takes the arc between two of these (chartDirAt +
	// quatDrag), which is the only frame in which pinning the pressed sky point
	// works for a rotated chart.
	function chartDirAt(out, u, v, spanX, spanY, mirror) {
		const lon = (mirror ? -(u - 0.5) : (u - 0.5)) * spanX;
		// A window taller than the sky saturates at the poles instead of
		// folding the far hemisphere back over them.
		let lat = (0.5 - v) * spanY;
		if (lat > HALF_PI) lat = HALF_PI; else if (lat < -HALF_PI) lat = -HALF_PI;
		const c = Math.cos(lat);
		out[0] = c * Math.cos(lon); out[1] = c * Math.sin(lon); out[2] = Math.sin(lat);
		return out;
	}

	// Unit ray of texel (px, py) into `out` (Float64Array 3).
	function dirAt(layout, px, py, out) {
		if (layout.kind === 'plane') {
			chartDirAt(layout.e, (px + 0.5) / layout.w, (py + 0.5) / layout.h,
				layout.spanX, layout.spanY, layout.mirrorLon);
			return quatApply(out, layout.e[0], layout.e[1], layout.e[2], layout.quatInv);
		}
		const u = (px + 0.5) / layout.w - 0.5;
		const v = 0.5 - (py + 0.5) / layout.h;
		// Gnomonic: the exact inverse of the app's perspective divide, so a star
		// at NDC (a, b) lands on texel (a, b) of this field.
		const b = layout.basis;
		const tx = u * 2 * layout.tanHalfY * layout.aspect;
		const ty = v * 2 * layout.tanHalfY;
		out[0] = b.fx + b.rx * tx + b.ux * ty;
		out[1] = b.fy + b.ry * tx + b.uy * ty;
		out[2] = b.fz + b.rz * tx + b.uz * ty;
		const l = Math.hypot(out[0], out[1], out[2]);
		const inv = l > 1e-12 ? 1 / l : 1;
		out[0] *= inv; out[1] *= inv; out[2] *= inv;
		return out;
	}

	// Where a direction lands, into `out` = {x, y, inside}. Any length is fine —
	// the mapping is angular — which is what lets the page hand it raw kpc.
	// On a full-width
	// chart x wraps (a figure split by the seam is the chart's own doing, and the
	// renderer breaks the segment there); elsewhere outside means outside.
	function texelOf(layout, dx, dy, dz, out) {
		// Normalize first: `lat` below is an asin of a component, so an input of
		// the wrong length would pull every marker toward the chart's equator
		// (and the view branch would keep its ratios, which is why the bug only
		// showed on the chart). Callers hand us star offsets in kpc.
		const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
		if (!(len > 1e-12)) { out.inside = false; out.x = 0; out.y = 0; return out; }
		const is = 1 / len;
		dx *= is; dy *= is; dz *= is;
		if (layout.kind === 'plane') {
			const e = layout.e;
			quatApply(e, dx, dy, dz, layout.quat);
			const lon = Math.atan2(e[1], e[0]);
			const lat = Math.asin(clamp(e[2], -1, 1));
			const sgn = layout.mirrorLon ? -1 : 1;
			let x = (sgn * lon / layout.spanX + 0.5) * layout.w - 0.5;
			const y = (0.5 - lat / layout.spanY) * layout.h - 0.5;
			if (layout.wrapX) x = ((x % layout.w) + layout.w) % layout.w;
			out.x = x; out.y = y;
			out.inside = x >= -0.5 && x < layout.w - 0.5 && y >= -0.5 && y < layout.h - 0.5;
			return out;
		}
		const b = layout.basis;
		const f = dx * b.fx + dy * b.fy + dz * b.fz;
		if (!(f > 1e-6)) { out.inside = false; out.x = 0; out.y = 0; return out; }
		out.x = (((dx * b.rx + dy * b.ry + dz * b.rz) / f) / (layout.tanHalfY * layout.aspect) * 0.5 + 0.5) * layout.w - 0.5;
		out.y = (0.5 - (((dx * b.ux + dy * b.uy + dz * b.uz) / f) / layout.tanHalfY) * 0.5) * layout.h - 0.5;
		out.inside = out.x >= -0.5 && out.x < layout.w - 0.5 && out.y >= -0.5 && out.y < layout.h - 0.5;
		return out;
	}

	// ---- star pre-pass -----------------------------------------------------
	//
	// Everything the texel loop needs is a per-star constant, so a (texel, star)
	// pair costs three multiplies, a reciprocal and four fused accumulates.
	// Positions are the current (orbit-integrated) ones; `cam` is the eye.

	const stars = {
		cap: 0, n: 0,
		dirX: null, dirY: null, dirZ: null,   // unit camera -> star
		l: null,                              // log10(distance / kpc) (modes 1, 3)
		d: null, d2: null,                    // distance, squared (mode 2 input)
		dMin: 0, dMax: 0,
	};

	// Fills the module's scratch star set and returns it. A star at the eye is
	// dropped: its direction is undefined and its hill would cover the sky.
	function prepareStars(positions, count, camX, camY, camZ) {
		const nMax = Math.min(count, MAX_STARS);
		if (stars.cap < nMax) {
			const cap = Math.max(nMax, 64);
			stars.cap = cap;
			stars.dirX = new Float64Array(cap); stars.dirY = new Float64Array(cap); stars.dirZ = new Float64Array(cap);
			stars.l = new Float32Array(cap); stars.d = new Float32Array(cap); stars.d2 = new Float32Array(cap);
		}
		let dMin = Infinity, dMax = -Infinity, n = 0;
		for (let i = 0; i < nMax; i++) {
			const dx = positions[i * 3] - camX;
			const dy = positions[i * 3 + 1] - camY;
			const dz = positions[i * 3 + 2] - camZ;
			const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
			if (!(d > 1e-9)) continue;
			const inv = 1 / d;
			stars.dirX[n] = dx * inv; stars.dirY[n] = dy * inv; stars.dirZ[n] = dz * inv;
			stars.d[n] = d; stars.d2[n] = d * d;
			stars.l[n] = Math.log10(d > MIN_DIST_KPC ? d : MIN_DIST_KPC);
			if (d < dMin) dMin = d;
			if (d > dMax) dMax = d;
			n++;
		}
		stars.n = n;
		stars.dMin = n ? dMin : 0;
		stars.dMax = n ? dMax : 0;
		return stars;
	}

	// ---- the field ---------------------------------------------------------
	//
	// `computeRaw` writes the physical scalar (see the range section) and fills
	// `stats`; `applyRange` turns it into the painter's 0..1 through the range.
	// The page keeps the two apart because its auto range follows the data at
	// 4 Hz while the field itself follows star time every frame — applying a
	// fresh auto range to every frame is the flicker view-modes.1 removed.
	//
	// opts: {
	//   mode:     'height' | 'spread' | 'gradient'
	//   sigmaDeg: IDW hill half-width in degrees (default 3). The weight is
	//             1/(sin²δ + sin²σ), so σ is the angle at which a star's hill
	//             has halved: a wide σ means a star's own texel blends more with
	//             its neighbours (10° halves the field's log-distance span) and
	//             the map reads flatter. 3° keeps 94% of the nearest anchor's
	//             peak on a chart while still joining the figures.
	//   measure:  false skips the range suggestion (the histogram / raw min-max);
	//             the field itself is unaffected. The page asks for it at 4 Hz.
	//   range:    applyRange's [lo, hi] for computeField's one-shot path.
	// }
	// stats (mutated, never allocated): { pairs, rawLo, rawHi, autoLo, autoHi,
	//   spreadMax, dMin, dMax, empty } — autoLo/Hi are this pass's suggested
	//   log-range bounds; autoRange() owns their final padding.
	const fieldScratch = { dir: new Float64Array(3), grid: null, raw: null, range: null };
	let orbitScratch = null;   // the position out-vec of the orbit dispatch
	let scaleScratch = null;

	const LOG_BINS = 64;
	const logHist = new Uint32Array(LOG_BINS);
	let histLo = 0, histW = 1;

	function fieldBuffer(which, size) {
		const cur = fieldScratch[which];
		if (cur && cur.length >= size) return cur;
		const next = new Float32Array(size);
		fieldScratch[which] = next;
		return next;
	}

	function histPercentile(frac, total) {
		const target = frac * total;
		let acc = 0;
		for (let b = 0; b < LOG_BINS; b++) {
			const next = acc + logHist[b];
			if (next > acc && next >= target) return histLo + (b + (target - acc) / logHist[b]) * histW;
			acc = next;
		}
		return histLo + LOG_BINS * histW;
	}

	// opts.measure (default true) also builds the range suggestion (mode 1's
	// anchor scale, modes 2–3's log histogram). The page asks for it a few times
	// a second, not every frame: the numbers only feed the eased range.
	function computeRaw(starsIn, layout, opts, out, stats) {
		const w = layout.w, h = layout.h, count = w * h;
		const measure = opts.measure !== false;
		const mode = opts.mode || 'height';
		const sigma = (opts.sigmaDeg === undefined ? SIGMA_DEG : opts.sigmaDeg) * DEG;
		const eps2 = Math.sin(sigma) * Math.sin(sigma);
		const n = starsIn.n;
		const wantGradient = mode === 'gradient';
		const needDepth = mode === 'spread';
		const grid = wantGradient ? fieldBuffer('grid', count) : null;
		const acc = wantGradient ? grid : out;

		stats.pairs = 0;
		stats.spreadMax = 0;
		stats.dMin = starsIn.dMin;
		stats.dMax = starsIn.dMax;
		stats.empty = n === 0;
		if (!n) {
			out.fill(0);
			stats.rawLo = 0; stats.rawHi = 0; stats.autoLo = 0; stats.autoHi = 0;
			return out;
		}

		const dir = fieldScratch.dir;
		const dirX = starsIn.dirX, dirY = starsIn.dirY, dirZ = starsIn.dirZ;
		const lv = starsIn.l, dv = starsIn.d, d2v = starsIn.d2;
		let pairs = 0, spreadMax = 0;
		for (let py = 0; py < h; py++) {
			const row = py * w;
			for (let px = 0; px < w; px++) {
				dirAt(layout, px, py, dir);
				const ax = dir[0], ay = dir[1], az = dir[2];
				let sw = 0, sv = 0, sd = 0, sd2 = 0;
				for (let i = 0; i < n; i++) {
					const c = ax * dirX[i] + ay * dirY[i] + az * dirZ[i];
					let q = 1 - c * c;
					if (q < 0) q = 0;
					const gw = 1 / (q + eps2);
					sw += gw;
					sv += gw * lv[i];
					if (needDepth) { sd += gw * dv[i]; sd2 += gw * d2v[i]; }
					pairs++;
				}
				const inv = sw > 1e-12 ? 1 / sw : 0;
				let v;
				if (needDepth) {
					// Weighted σ of the anchor distances: the hidden depth along
					// this ray, 0 where the neighbours agree.
					const mean = sd * inv;
					let varr = sd2 * inv - mean * mean;
					if (varr < 0) varr = 0;
					v = Math.sqrt(varr);
					if (v > spreadMax) spreadMax = v;
				} else {
					v = sv * inv;      // geometric-mean distance, as log10(kpc)
				}
				acc[row + px] = v;
			}
		}

		if (wantGradient) {
			// Central differences of the log-distance grid, per radian of sky
			// horizontally and vertically, then quoted per degree. The result is
			// the physical slope of mode 1 — dex of distance per degree — so it
			// does not change when the display range does, and it cannot clump
			// against a hard top (the old clamp was the "gradient of 1" wall).
			const g = grid;
			const rx = layout.texelRadX, ry = layout.texelRadY;
			const plane = layout.kind === 'plane';
			const cosClamp = 0.05;
			for (let py = 0; py < h; py++) {
				// Longitude wraps on a full chart; latitude never does — a pole is a
				// real edge of the parameterisation, and clamping there keeps the
				// derivative finite instead of wrapping north into south.
				const up = (py > 0 ? py - 1 : py) * w;
				const dn = (py < h - 1 ? py + 1 : py) * w;
				const dy = ((dn - up) / w) * ry || ry;
				const row = py * w;
				let lonScale = 1;
				if (plane) {
					// A chart's longitude rows shrink with cos(lat); the derivative
					// must be per angle of sky, not per texel of map.
					const lat = (0.5 - (py + 0.5) / h) * layout.spanY;
					lonScale = 1 / Math.max(Math.cos(lat), cosClamp);
				}
				for (let px = 0; px < w; px++) {
					const lf = layout.wrapX ? (px - 1 + w) % w : (px > 0 ? px - 1 : 0);
					const rt = layout.wrapX ? (px + 1) % w : (px < w - 1 ? px + 1 : w - 1);
					// The texel gap between lf and rt, measured the short way round
					// on a wrapped chart: at the seam the plain difference is
					// 2 − w and would overstate the slope ~w/2 times.
					let gap = rt - lf;
					if (layout.wrapX) gap = (gap + w) % w;
					if (gap <= 0) gap = 1;
					const gx = (g[row + rt] - g[row + lf]) / (gap * rx) * lonScale;
					const gy = (g[dn + px] - g[up + px]) / dy;
					out[row + px] = Math.sqrt(gx * gx + gy * gy) * DEG;
				}
			}
		}

		// The raw distribution, and the range it suggests. Mode 1's suggestion
		// comes from the anchors (autoRange rebuilds it from dMin/dMax); the
		// other modes read a log histogram, so one bright spike cannot own the
		// whole ramp.
		if (!measure) {
			stats.pairs = pairs;
			stats.spreadMax = spreadMax;
			return out;
		}
		if (mode === 'height') {
			let lo = Infinity, hi = -Infinity;
			for (let i = 0; i < count; i++) {
				const v = out[i];
				if (v < lo) lo = v;
				if (v > hi) hi = v;
			}
			stats.rawLo = lo; stats.rawHi = hi;
			const s = makeScale(scaleScratch || (scaleScratch = {}), stats.dMin, stats.dMax);
			stats.autoLo = s.lo; stats.autoHi = s.hi;
		} else {
			let lo = Infinity, hi = -Infinity;
			for (let i = 0; i < count; i++) {
				const v = out[i];
				if (!(v > RANGE_FLOOR)) continue;
				const l = Math.log10(v);
				if (l < lo) lo = l;
				if (l > hi) hi = l;
			}
			if (!(hi > lo)) { hi = (lo === Infinity ? Math.log10(RANGE_FLOOR) : lo) + 0.3; }
			if (!(lo < Infinity)) lo = hi - 0.3;
			histLo = lo;
			histW = (hi - lo) / LOG_BINS;
			if (!(histW > 0)) histW = 1;
			logHist.fill(0);
			for (let i = 0; i < count; i++) {
				const v = out[i] > RANGE_FLOOR ? out[i] : RANGE_FLOOR;
				let b = ((Math.log10(v) - lo) / histW) | 0;
				if (b < 0) b = 0; else if (b >= LOG_BINS) b = LOG_BINS - 1;
				logHist[b]++;
			}
			stats.rawLo = Math.pow(10, lo);
			stats.rawHi = Math.pow(10, hi);
			stats.autoLo = histPercentile(0.05, count);
			stats.autoHi = histPercentile(0.95, count);
		}
		stats.pairs = pairs;
		stats.spreadMax = spreadMax;
		return out;
	}

	// One-shot convenience: raw pass + a range (opts.range, or the auto one the
	// same pass suggests). The page does the two steps itself so its auto range
	// can lag the field; tests and any one-shot caller use this. `range` is reused
	// module-side when opts.range is absent, so the signature stays allocation-free.
	function computeField(starsIn, layout, opts, out, stats) {
		const count = layout.w * layout.h;
		const raw = fieldBuffer('raw', count);
		if (!stats) stats = {};
		computeRaw(starsIn, layout, opts, raw, stats);
		const mode = opts.mode || 'height';
		const range = opts.range || (fieldScratch.range || (fieldScratch.range = { lo: 0, hi: 1 }));
		if (!opts.range) autoRange(mode, stats, range);
		return applyRange(raw, count, mode, range, out);
	}

	// Bilinear read at UV (u, v in [0,1] across the map) — the entry point a
	// pathfinding or ship-steering pass would use (plan "Output for game").
	// Texel i covers [(i)/w, (i+1)/w] with its centre at (i+0.5)/w, which is the
	// same convention the painter uses to place a marker, so a cursor over a star
	// reads that star's height.
	function heightAt(field, layout, u, v, out) {
		const w = layout.w, h = layout.h;
		const fx = clamp(u * w - 0.5, 0, w - 1);
		const fy = clamp(v * h - 0.5, 0, h - 1);
		const x0 = Math.floor(fx), y0 = Math.floor(fy);
		const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
		const tx = fx - x0, ty = fy - y0;
		const r0 = y0 * w, r1 = y1 * w;
		const a = field[r0 + x0], b = field[r0 + x1], c = field[r1 + x0], d = field[r1 + x1];
		out.height = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
		return out;
	}

	// ---- star sets ---------------------------------------------------------
	//
	// The anchors are named stars (N = 0) or the real catalog stars the app draws
	// (N ≥ 1) — never a procedural guess. Every builder returns the same shape:
	//
	//   { positions: Float64Array n*3 (kpc, galactic), n, packed: Uint32Array n,
	//     colorIndex: Uint8Array n, names: string[]|null, landmark: bool,
	//     segments: Int32Array pairs|null, source }

	// The named stars, in the landmark table's own order (index 0 is the Sun).
	function buildConstellationSet(opts) {
		const L = (opts && opts.landmarks) || resolve('Landmarks', '../data/landmarks.js');
		const n = L.count;
		const positions = new Float64Array(n * 3);
		positions.set(L.positions.subarray(0, n * 3));
		const names = new Array(n);
		const colorIndex = new Uint8Array(n);
		for (let i = 0; i < n; i++) {
			names[i] = L.ENTRIES[i].name;
			colorIndex[i] = L.ENTRIES[i].colorIndex;
		}
		return {
			positions, n, packed: null, colorIndex, names, landmark: true,
			source: 'landmarks', segments: constellationSegments(),
		};
	}

	// Constellation figure edges as one flat landmark-index pair list — the
	// overlay that lets the eye check that the map matches the sky.
	//
	// data/constellations.js has already resolved the names, so each figure's
	// `edges` is a flat Int16Array [a, b, a, b, …] of Landmark indices; the
	// island only concatenates them (one array for the painter to stride two at
	// a time). Reading e[j][0] here instead of e[j] turned every edge into (0, 0)
	// and quietly erased the figures — hence the index-range check in
	// experiments/view-modes-field-test.js.
	function constellationSegments() {
		const C = resolve('Constellations', '../data/constellations.js');
		if (!C || !C.LINES) return null;
		let count = 0;
		for (let i = 0; i < C.LINES.length; i++) count += C.LINES[i].edges.length;
		const seg = new Int32Array(count);
		let k = 0;
		for (let i = 0; i < C.LINES.length; i++) {
			const e = C.LINES[i].edges;
			for (let j = 0; j < e.length; j++) seg[k++] = e[j];
		}
		return seg;
	}

	// ---- anchors: a decoded index and a nearest-N query --------------------
	//
	// The catalog is decoded once (9 ms for the 3 829-star bundle) into a flat
	// index; a nearest-N query is then one linear scan plus a fixed max-heap of
	// `want` entries — ~0.05 ms, no allocation, no per-query sort. That is what
	// lets the page re-pick the anchors as the eye or the stars move instead of
	// freezing the set at boot.

	function createSet(cap) {
		const c = Math.max(1, Math.min(MAX_STARS, cap | 0));
		return {
			positions: new Float64Array(c * 3),
			packed: new Uint32Array(c),
			colorIndex: new Uint8Array(c),
			capacity: c, n: 0,
			names: null, landmark: false, segments: null, source: '',
			dmin: 0, dmax: 0,
		};
	}

	function createIndex(positions, n, packed, colorIndex, source) {
		return { positions, n, packed, colorIndex, source };
	}

	// Decode the shipping tile bundle into one flat index. Visible records only,
	// exactly the stars the renderer draws.
	function createCatalogIndex(bundle) {
		const R = resolve('StarRecord', './star-record.js');
		const cells = bundle.cells || [];
		let total = 0;
		for (let c = 0; c < cells.length; c++) total += cells[c].n | 0;
		const pos = new Float64Array(total * 3);
		const pk = new Uint32Array(total);
		const ci = new Uint8Array(total);
		const bytes = new Uint8Array(1 << 20);
		let at = 0;
		for (let c = 0; c < cells.length; c++) {
			const cell = cells[c];
			const n = cell.n | 0;
			if (n <= 0) continue;
			const len = decodeInto(cell.d, bytes, 0);
			if (len !== n * 16) throw new Error(`catalog cell ${c}: ${len} bytes for ${n} stars`);
			const view = new DataView(bytes.buffer, 0, len);
			for (let i = 0; i < n; i++) {
				const rec = R.readRecord(view, i * 16);
				if (!rec.visible) continue;
				const off = at * 3;
				pos[off] = rec.x; pos[off + 1] = rec.y; pos[off + 2] = rec.z;
				pk[at] = rec.packed; ci[at] = rec.colorIndex;
				at++;
			}
		}
		return createIndex(pos, at, pk, ci, 'catalog');
	}

	function decodeInto(b64, out, offset) {
		if (typeof atob === 'function') {
			const bin = atob(b64);
			for (let i = 0; i < bin.length; i++) out[offset + i] = bin.charCodeAt(i);
			return bin.length;
		}
		const buf = Buffer.from(b64, 'base64');
		out.set(buf, offset);
		return buf.length;
	}

	// A procedural galaxy has no catalog and no named sky: sample it once and
	// query that sample. The sample is fixed in (model, seed), so the anchors do
	// not change when the eye does — only which of them are nearest.
	function createSampledIndex(model, count) {
		const SAMPLING = resolve('SamplingLib', './sampling.js');
		const buf = SAMPLING.sampleGalaxyStars(model, 0x7E57A1, Math.max(1024, count | 0));
		const n = buf.count;
		const positions = new Float64Array(n * 3);
		for (let i = 0; i < n; i++) {
			positions[i * 3] = buf.x[i];
			positions[i * 3 + 1] = buf.y[i];
			positions[i * 3 + 2] = buf.z[i];
		}
		return createIndex(positions, n, null, null, 'sampled');
	}

	// The max-heap of the scan: `want` entries, root = farthest.
	const queryHeap = { d2: new Float64Array(MAX_STARS), idx: new Int32Array(MAX_STARS), n: 0 };

	function heapPush(d2, idx) {
		const hd = queryHeap.d2, hi = queryHeap.idx;
		let i = queryHeap.n++;
		while (i > 0) {
			const p = (i - 1) >> 1;
			if (hd[p] >= d2) break;
			hd[i] = hd[p]; hi[i] = hi[p];
			i = p;
		}
		hd[i] = d2; hi[i] = idx;
	}

	function heapSift(d2, idx, n) {
		const hd = queryHeap.d2, hi = queryHeap.idx;
		let i = 0;
		for (;;) {
			let c = i * 2 + 1;
			if (c >= n) break;
			if (c + 1 < n && hd[c + 1] > hd[c]) c++;
			if (hd[c] <= d2) break;
			hd[i] = hd[c]; hi[i] = hi[c];
			i = c;
		}
		hd[i] = d2; hi[i] = idx;
	}

	// Fill `set` with the `want` nearest entries of `measure` — the drawn sky,
	// i.e. the index's birth positions or a time-advanced copy of them — and
	// write the winners' *birth* positions and packed words into the set. That
	// split is what lets the page advance the set with the same orbit dispatch
	// to any star time without applying the motion twice: the query says who is
	// nearest now, the set carries what is needed to redraw them later.
	// The list is written nearest-first, so a cursor can index it directly. The
	// answer is capped by the set's own capacity (createSet), never by an
	// allocation here.
	function queryNearest(index, measure, cx, cy, cz, want, set) {
		const n = Math.min(want | 0, index.n, set.capacity);
		set.n = 0;
		if (n <= 0) return set;
		const heap = queryHeap;
		const birth = index.positions;
		heap.n = 0;
		for (let i = 0; i < index.n; i++) {
			const dx = measure[i * 3] - cx;
			const dy = measure[i * 3 + 1] - cy;
			const dz = measure[i * 3 + 2] - cz;
			const d2 = dx * dx + dy * dy + dz * dz;
			if (heap.n < n) heapPush(d2, i);
			else if (d2 < heap.d2[0]) heapSift(d2, i, n);
		}
		const pk = index.packed, ci = index.colorIndex;
		let dmin2 = Infinity, dmax2 = 0;
		// Pop the max: the writes land farthest-last, so the set ends up sorted.
		for (let k = n - 1; k >= 0; k--) {
			const d2 = heap.d2[0], src = heap.idx[0];
			if (d2 < dmin2) dmin2 = d2;
			if (d2 > dmax2) dmax2 = d2;
			set.positions[k * 3] = birth[src * 3];
			set.positions[k * 3 + 1] = birth[src * 3 + 1];
			set.positions[k * 3 + 2] = birth[src * 3 + 2];
			set.packed[k] = pk ? pk[src] : 0;
			set.colorIndex[k] = ci ? ci[src] : 4;
			heap.n--;
			if (heap.n > 0) heapSift(heap.d2[heap.n], heap.idx[heap.n], heap.n);
		}
		set.n = n;
		set.landmark = false;
		set.names = null;
		set.segments = null;
		set.source = index.source;
		set.dmin = Math.sqrt(dmin2);
		set.dmax = Math.sqrt(dmax2);
		return set;
	}

	// Convenience wrapper: decode + query in one call, used by the tests and by
	// any caller that wants a one-shot set.
	function buildCatalogSet(bundle, want, center) {
		const index = createCatalogIndex(bundle);
		const set = createSet(want);
		queryNearest(index, index.positions,
			center ? center[0] : 0, center ? center[1] : 0, center ? center[2] : 0, want, set);
		return set;
	}

	// The whole index advanced to `timeMyr`, into `out` — the array a nearest-N
	// query measures when star time has moved the sky. One dispatch per record
	// (~10 ms for the catalog), so callers throttle it; 0 copies the birth frame.
	function prepareIndexPositions(index, out, timeMyr, model) {
		const n = index.n, pos = index.positions;
		if (timeMyr === 0) {
			out.set(pos.subarray(0, n * 3));
			return n;
		}
		const Orbit = resolve('OrbitLib', './orbit.js');
		const p = orbitScratch || (orbitScratch = new Float64Array(3));
		const pk = index.packed;
		for (let i = 0; i < n; i++) {
			Orbit.engineRecordPosition(p, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2],
				pk ? pk[i] : 0, timeMyr, model);
			out[i * 3] = p[0]; out[i * 3 + 1] = p[1]; out[i * 3 + 2] = p[2];
		}
		return n;
	}

	// ---- star time ---------------------------------------------------------

	// The app's own dispatch, so the map moves the way the sky does: landmarks
	// through engineLandmarkPosition (family from colour, no packed record),
	// records through engineRecordPosition (packed orbit + epoch/cluster bits).
	function advancePositions(set, out, timeMyr, model) {
		const n = set.n, pos = set.positions;
		if (timeMyr === 0) {
			for (let i = 0, m = n * 3; i < m; i++) out[i] = pos[i];
			return n;
		}
		const Orbit = resolve('OrbitLib', './orbit.js');
		const p = orbitScratch || (orbitScratch = new Float64Array(3));
		if (set.landmark) {
			for (let i = 0; i < n; i++) {
				Orbit.engineLandmarkPosition(p, i, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2],
					set.colorIndex[i], timeMyr, model);
				out[i * 3] = p[0]; out[i * 3 + 1] = p[1]; out[i * 3 + 2] = p[2];
			}
			return n;
		}
		for (let i = 0; i < n; i++) {
			Orbit.engineRecordPosition(p, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], set.packed[i], timeMyr, model);
			out[i * 3] = p[0]; out[i * 3 + 1] = p[1]; out[i * 3 + 2] = p[2];
		}
		return n;
	}

	// The texel count that keeps one rebuild inside a frame: pairs ≈ w·h·N ≤
	// budget, at the layout's own aspect.
	function autoResolution(pairsBudget, n, wOverH) {
		const h = Math.sqrt(Math.max(1, pairsBudget) / Math.max(1, n) / Math.max(0.25, wOverH));
		return Math.max(16, Math.min(512, Math.round(h / 8) * 8));
	}

	const ViewModesField = {
		DEG, TAU, MIN_DIST_KPC, MAX_STARS, RANGE_FLOOR,
		// pose
		quatTurn, quatMul, quatArc, quatApply, quatInv, quatNormalize, quatBasis, quatDrag,
		// range
		makeScale, heightOfDistance, distanceAtHeight, rangeValue, applyRange, autoRange, SIGMA_DEG,
		// layout
		createLayout, dirAt, chartDirAt, texelOf,
		// field
		prepareStars, computeRaw, computeField, heightAt, autoResolution, stars,
		// sets
		createSet, createIndex, createCatalogIndex, createSampledIndex, queryNearest,
		prepareIndexPositions, buildConstellationSet, buildCatalogSet, constellationSegments,
		advancePositions, decodeInto,
	};

	if (typeof module !== 'undefined') module.exports = ViewModesField;
	if (typeof window !== 'undefined') window.ViewModesField = ViewModesField;
})();
