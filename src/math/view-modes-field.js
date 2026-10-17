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
// Heights (both modes come out of ONE pass over the stars; no diffusion, no
// blur):
//
//   * 'height'   — mode 1. Shepard (inverse-distance-weighted) mean of the
//                  stars' own height, 0 = far, 1 = close, where a star's height
//                  is a LOG map of |star − camera| against a distance range. Log
//                  because the anchors span 5 pc to 800 pc: a linear ramp puts
//                  every real star within a few percent of the same colour.
//   * 'spread'   — mode 2. Weighted standard deviation of |star − camera| over
//                  the same neighbourhood: the hidden depth between stars that
//                  look adjacent. A ridge means a 2-D shortcut is a 3-D detour.
//   * 'gradient' — |∇height| of mode 1, the literal reading of "mode 2 is the
//                  gradient of mode 1".
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

	// ---- log height scale -------------------------------------------------

	// v = 1 at dMin (close), 0 at dMax (far), log10 in between. One pair of
	// functions, so the field, the legend and the readout cannot disagree.
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

	const SIGMA_DEG = 3;              // the default hill half-width, see computeField

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

	// Unit ray of texel (px, py) into `out` (Float64Array 3).
	function dirAt(layout, px, py, out) {
		const u = (px + 0.5) / layout.w - 0.5;
		const v = 0.5 - (py + 0.5) / layout.h;
		if (layout.kind === 'plane') {
			const e = layout.e;
			const lon = (layout.mirrorLon ? -u : u) * layout.spanX;
			// A window taller than the sky saturates at the poles instead of
			// folding the far hemisphere back over them.
			let lat = v * layout.spanY;
			if (lat > HALF_PI) lat = HALF_PI; else if (lat < -HALF_PI) lat = -HALF_PI;
			const c = Math.cos(lat);
			e[0] = c * Math.cos(lon); e[1] = c * Math.sin(lon); e[2] = Math.sin(lat);
			return quatApply(out, e[0], e[1], e[2], layout.quatInv);
		}
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
		h: null,                              // normalized height (mode 1 input)
		d: null, d2: null,                    // distance, squared (mode 2 input)
		dMin: 0, dMax: 0,
	};

	// Fills the module's scratch star set and returns it. A star at the eye is
	// dropped: its direction is undefined and its hill would cover the sky.
	function prepareStars(positions, count, camX, camY, camZ, scale) {
		const nMax = Math.min(count, MAX_STARS);
		if (stars.cap < nMax) {
			const cap = Math.max(nMax, 64);
			stars.cap = cap;
			stars.dirX = new Float64Array(cap); stars.dirY = new Float64Array(cap); stars.dirZ = new Float64Array(cap);
			stars.h = new Float32Array(cap); stars.d = new Float32Array(cap); stars.d2 = new Float32Array(cap);
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
			if (d < dMin) dMin = d;
			if (d > dMax) dMax = d;
			n++;
		}
		stars.n = n;
		stars.dMin = n ? dMin : 0;
		stars.dMax = n ? dMax : 0;
		for (let i = 0; i < n; i++) stars.h[i] = scale ? heightOfDistance(scale, stars.d[i]) : 0.5;
		return stars;
	}

	// ---- the field ---------------------------------------------------------
	//
	// opts: {
	//   mode:        'height' | 'spread' | 'gradient'
	//   sigmaDeg:    IDW hill half-width in degrees (default 3). The weight is
	//                1/(sin²δ + sin²σ), so σ is the angle at which a star's hill
	//                has halved: a wide σ means a star's own texel reads well
	//                below its true height because its neighbours average it down
	//                (10° left the whole map inside 0.35…0.75 and the near half of
	//                the ramp unused), which is the flat look this feature must not
	//                have. 3° keeps 90% of the peak while still blending figures.
	//   spreadRefKpc: mode 2's half-cost depth (default 0.2)
	//   gradSpanDeg: mode 3 — this angle spans the full height range (default 14)
	// }
	// stats (mutated, never allocated): { pairs, vMin, vMax, spreadMax, dMin,
	//                                    dMax, empty }
	const fieldScratch = { dir: new Float64Array(3), grid: null, hit: { x: 0, y: 0, inside: false } };
	let orbitScratch = null;   // the position out-vec of the orbit dispatch

	function computeField(starsIn, layout, opts, out, stats) {
		const w = layout.w, h = layout.h;
		if (!out || out.length < w * h) out = new Float32Array(w * h);
		const mode = opts.mode || 'height';
		const sigma = (opts.sigmaDeg === undefined ? SIGMA_DEG : opts.sigmaDeg) * DEG;
		const eps2 = Math.sin(sigma) * Math.sin(sigma);
		const ref = opts.spreadRefKpc || 0.2;
		const gradK = 1 / Math.max(1e-3, (opts.gradSpanDeg || 14) * DEG);
		const n = starsIn.n;
		const dirX = starsIn.dirX, dirY = starsIn.dirY, dirZ = starsIn.dirZ;
		const hv = starsIn.h, dv = starsIn.d, d2v = starsIn.d2;
		const wantGradient = mode === 'gradient';
		if (wantGradient && (!fieldScratch.grid || fieldScratch.grid.length < w * h)) {
			fieldScratch.grid = new Float32Array(w * h);
		}
		const acc = wantGradient ? fieldScratch.grid : out;
		const needDepth = mode === 'spread';
		if (!n) {
			out.fill(0);
			stats.pairs = 0; stats.vMin = 0; stats.vMax = 0; stats.spreadMax = 0; stats.empty = true;
			return out;
		}
		stats.empty = false;

		const dir = fieldScratch.dir;
		let pairs = 0, vMin = Infinity, vMax = -Infinity, spreadMax = 0;
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
					sv += gw * hv[i];
					if (needDepth) { sd += gw * dv[i]; sd2 += gw * d2v[i]; }
					pairs++;
				}
				const inv = sw > 1e-12 ? 1 / sw : 0;
				let v;
				if (needDepth) {
					const mean = sd * inv;
					let varr = sd2 * inv - mean * mean;
					if (varr < 0) varr = 0;
					const dev = Math.sqrt(varr);
					if (dev > spreadMax) spreadMax = dev;
					v = dev / (dev + ref);            // 0 = flat sky, 1 = deep cliff
				} else {
					v = sv * inv;                      // 0..1 by the log scale, no renorm
				}
				acc[row + px] = v;
				if (v < vMin) vMin = v;
				if (v > vMax) vMax = v;
			}
		}

		if (wantGradient) {
			// Central differences of the height grid, weighted so a texel of
			// longitude and a texel of latitude mean the same angle. `gradK` says
			// how steep "a full height range across gradSpanDeg" is, so the map is
			// a slope read off in degrees, not an auto-scaled texture.
			const g = fieldScratch.grid;
			const rx = layout.texelRadX, ry = layout.texelRadY;
			vMin = Infinity; vMax = -Infinity;
			for (let py = 0; py < h; py++) {
				// Longitude wraps on a full chart; latitude never does — a pole is a
				// real edge of the parameterisation, and clamping there keeps the
				// derivative finite instead of wrapping north into south.
				const up = (py > 0 ? py - 1 : py) * w;
				const dn = (py < h - 1 ? py + 1 : py) * w;
				const dy = ((dn - up) / w) * ry || ry;
				const row = py * w;
				for (let px = 0; px < w; px++) {
					const lf = layout.wrapX ? (px - 1 + w) % w : (px > 0 ? px - 1 : 0);
					const rt = layout.wrapX ? (px + 1) % w : (px < w - 1 ? px + 1 : w - 1);
					const gx = (g[row + rt] - g[row + lf]) / ((rt - lf) * rx);
					const gy = (g[dn + px] - g[up + px]) / dy;
					const v = clamp(Math.sqrt(gx * gx + gy * gy) * gradK, 0, 1);
					out[row + px] = v;
					if (v < vMin) vMin = v;
					if (v > vMax) vMax = v;
				}
			}
		}

		stats.pairs = pairs;
		stats.vMin = vMin; stats.vMax = vMax;
		stats.spreadMax = spreadMax;
		stats.dMin = starsIn.dMin; stats.dMax = starsIn.dMax;
		return out;
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

	// Nearest `want` catalog stars to `center`, decoded from the shipping tile
	// bundle (the very records the renderer draws, so a marker here is a star
	// there). `bundle` is the parsed __galaxy_catalog object: pure function.
	function buildCatalogSet(bundle, want, center) {
		const R = resolve('StarRecord', './star-record.js');
		const cells = bundle.cells || [];
		const cX = center ? center[0] : 0, cY = center ? center[1] : 0, cZ = center ? center[2] : 0;
		let total = 0;
		for (let c = 0; c < cells.length; c++) total += cells[c].n | 0;
		const ds = new Float64Array(total);
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
				ds[at] = Math.hypot(rec.x - cX, rec.y - cY, rec.z - cZ);
				pk[at] = rec.packed; ci[at] = rec.colorIndex;
				at++;
			}
		}
		const order = new Int32Array(at);
		for (let i = 0; i < at; i++) order[i] = i;
		order.sort((a, b) => ds[a] - ds[b]);
		const n = Math.min(want, at);
		const outPos = new Float64Array(n * 3);
		const outPack = new Uint32Array(n);
		const outColor = new Uint8Array(n);
		for (let i = 0; i < n; i++) {
			const k = order[i], o = k * 3, t = i * 3;
			outPos[t] = pos[o]; outPos[t + 1] = pos[o + 1]; outPos[t + 2] = pos[o + 2];
			outPack[i] = pk[k]; outColor[i] = ci[k];
		}
		return {
			positions: outPos, n, packed: outPack, colorIndex: outColor, names: null,
			landmark: false, source: 'catalog', segments: null,
			dmin: at ? ds[order[0]] : 0, dmax: at ? ds[order[Math.min(n, at) - 1]] : 0,
		};
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

	// A procedural galaxy has no catalog and no named sky: fall back to sampled
	// field stars so the experiment still runs on every galaxy type.
	function buildSampledSet(model, want, center) {
		const SAMPLING = resolve('SamplingLib', './sampling.js');
		const buf = SAMPLING.sampleGalaxyStars(model, 0x7E57A1, Math.max(want * 4, 2000));
		const cX = center ? center[0] : 0, cY = center ? center[1] : 0, cZ = center ? center[2] : 0;
		const ds = new Float64Array(buf.count), order = new Int32Array(buf.count);
		for (let i = 0; i < buf.count; i++) {
			ds[i] = Math.hypot(buf.x[i] - cX, buf.y[i] - cY, buf.z[i] - cZ);
			order[i] = i;
		}
		order.sort((a, b) => ds[a] - ds[b]);
		const n = Math.min(want, buf.count);
		const pos = new Float64Array(n * 3), packed = new Uint32Array(n), color = new Uint8Array(n);
		for (let i = 0; i < n; i++) {
			const k = order[i];
			pos[i * 3] = buf.x[k]; pos[i * 3 + 1] = buf.y[k]; pos[i * 3 + 2] = buf.z[k];
			packed[i] = buf.packed ? buf.packed[k] : 0;
			color[i] = 4;
		}
		return {
			positions: pos, n, packed, colorIndex: color, names: null,
			landmark: false, source: 'sampled', segments: null,
		};
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
		DEG, TAU, MIN_DIST_KPC, MAX_STARS,
		// pose
		quatTurn, quatMul, quatArc, quatApply, quatInv, quatNormalize, quatBasis,
		// scale
		makeScale, heightOfDistance, distanceAtHeight, SIGMA_DEG,
		// layout
		createLayout, dirAt, texelOf,
		// field
		prepareStars, computeField, heightAt, autoResolution, stars,
		// sets
		buildConstellationSet, buildCatalogSet, buildSampledSet, constellationSegments,
		advancePositions, decodeInto,
	};

	if (typeof module !== 'undefined') module.exports = ViewModesField;
	if (typeof window !== 'undefined') window.ViewModesField = ViewModesField;
})();
