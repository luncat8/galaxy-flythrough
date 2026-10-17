// src/math/view-modes-field.js
// Pure-CPU heightmap fields for the view-modes experiment (plan §0a / §1 / §2).
//
// Two scalar fields over a set of 3-D star positions, returned as 2-D Float32
// grids (W x H) over a plane projection aligned with the camera forward axis:
//
//   * computeCameraDistField   — smooth inverse-distance-weighted heightmap of
//                                "distance from camera to closest star".
//                                0 = far, 1 = close.
//   * computeAdjacencyVarField — smooth local variance of star depth (Z), i.e.
//                                how much visual neighbours disagree in depth.
//                                High = a 2-D shortcut is a 3-D detour.
//
// Both functions use a screen-space Gaussian "splat" (Gaussian blob at each
// projected star position) followed by a box blur, exactly as Option 3 in the
// plan. The algorithm is O(N + W*H*K) where K is the blur radius (≤ ~6), so
// it stays realtime at W=H=256, N=500 on the CPU — which is what the standalone
// page uses before any WebGL2 path.
//
// Pure functions: no DOM, no WebGL, no globals. Testable in Node.

'use strict';

(function () {
	// ---- helpers -----------------------------------------------------------

	function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

	// Project a 3-D point into camera view-plane coordinates:
	//   out.x, out.y in [-1, 1] (clamped to the view rectangle),
	//   out.z       = signed depth along camera forward (kpc, negative = behind),
	//   out.dist    = Euclidean distance (kpc, ≥ 0).
	// fovTan = tan(horizontalFovRadians / 2); vertical scale matches aspect H/W.
	function projectPoint(px, py, pz, camX, camY, camZ, fwdX, fwdY, fwdZ,
	                      rightX, rightY, rightZ, upX, upY, upZ,
	                      fovTan, aspect, out) {
		const dx = px - camX;
		const dy = py - camY;
		const dz = pz - camZ;
		const z = dx * fwdX + dy * fwdY + dz * fwdZ;
		if (z <= 1e-4) { out.x = 0; out.y = 0; out.z = z; out.dist = -1; return out; }
		const rx = dx * rightX + dy * rightY + dz * rightZ;
		const ux = dx * upX    + dy * upY    + dz * upZ;
		out.x = rx / (z * fovTan);
		out.y = ux / (z * fovTan * aspect);
		out.z = z;
		out.dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
		return out;
	}

	// Build a right-handed orthonormal basis (forward, right, up) from a forward
	// direction (doesn't have to be normalized). `up` points toward galactic
	// north when forward is in-plane.
	function buildBasis(fx, fy, fz, out) {
		// normalize forward
		let fl = Math.sqrt(fx * fx + fy * fy + fz * fz);
		if (fl < 1e-8) { fx = 0; fy = 0; fz = -1; fl = 1; }
		fx /= fl; fy /= fl; fz /= fl;
		// world up = +Z (galactic north); fall back to +Y if forward is vertical
		let wux = 0, wuy = 0, wuz = 1;
		if (Math.abs(fz) > 0.98) { wux = 0; wuy = 1; wuz = 0; }
		// right = normalize(cross(worldUp, forward))
		let rx = wuy * fz - wuz * fy;
		let ry = wuz * fx - wux * fz;
		let rz = wux * fy - wuy * fx;
		let rl = Math.sqrt(rx * rx + ry * ry + rz * rz);
		if (rl < 1e-8) { rx = 1; ry = 0; rz = 0; rl = 1; }
		rx /= rl; ry /= rl; rz /= rl;
		// up = cross(forward, right)
		const ux = fy * rz - fz * ry;
		const uy = fz * rx - fx * rz;
		const uz = fx * ry - fy * rx;
		out.fx = fx; out.fy = fy; out.fz = fz;
		out.rx = rx; out.ry = ry; out.rz = rz;
		out.ux = ux; out.uy = uy; out.uz = uz;
		return out;
	}

	// ---- splat + separable box blur (Option 3) -----------------------------

	// Splat Gaussian-weighted values at each projected star into the field.
	// For mode 1 (camera distance) we accumulate w and w*value.
	// For mode 2 (adjacency variance) we accumulate w, w*z, w*z².
	// The splat is a 2-D Gaussian with sigma = splatSigma (in texels), and we
	// iterate only over a 3-sigma box around each star.
	function splatStars(w, h, positions, count, cam, opts, sums) {
		// sums: { w, wz?, wz2? } Float32Array of size w*h. mode 1 uses w + wz as
		// w*d (where d = normalised distance); mode 2 uses w + wz + wz2.
		const field = sums.w;
		const fieldZ = sums.wz;
		const fieldZ2 = sums.wz2;
		field.fill(0);
		if (fieldZ) fieldZ.fill(0);
		if (fieldZ2) fieldZ2.fill(0);

		const basis = buildBasis(cam.fx, cam.fy, cam.fz, {});
		const aspect = h / w;
		const fovTan = Math.tan((opts.fovDeg * Math.PI / 180) * 0.5);
		const splatSigma = opts.splatSigma || 14;  // texels
		const splatRadius = Math.max(2, Math.ceil(splatSigma * 3));
		const invTwoSig2 = 1 / (2 * splatSigma * splatSigma);
		const p = { x: 0, y: 0, z: 0, dist: 0 };

		// Distance normalization across the set (mode 1).
		let dMin = Infinity, dMax = -Infinity;
		if (opts.normalizeDist) {
			for (let i = 0; i < count; i++) {
				const px = positions[i * 3], py = positions[i * 3 + 1], pz = positions[i * 3 + 2];
				const dx = px - cam.x, dy = py - cam.y, dz = pz - cam.z;
				const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
				if (d < dMin) dMin = d;
				if (d > dMax) dMax = d;
			}
			if (dMax - dMin < 1e-6) dMax = dMin + 1;
		}

		for (let i = 0; i < count; i++) {
			const px = positions[i * 3], py = positions[i * 3 + 1], pz = positions[i * 3 + 2];
			projectPoint(px, py, pz, cam.x, cam.y, cam.z,
				basis.fx, basis.fy, basis.fz, basis.rx, basis.ry, basis.rz,
				basis.ux, basis.uy, basis.uz, fovTan, aspect, p);
			if (p.dist < 0) continue;  // behind camera
			// screen coords in texels (0..w, 0..h), y flipped so up is +y
			const sx = (p.x * 0.5 + 0.5) * w;
			const sy = (1 - (p.y * 0.5 + 0.5)) * h;
			const x0 = Math.max(0, Math.floor(sx - splatRadius));
			const x1 = Math.min(w - 1, Math.ceil(sx + splatRadius));
			const y0 = Math.max(0, Math.floor(sy - splatRadius));
			const y1 = Math.min(h - 1, Math.ceil(sy + splatRadius));

			let val = 0;
			let zVal = 0, z2Val = 0;
			if (opts.mode === 'camera-dist') {
				// 0 far → 1 close
				const t = (p.dist - dMin) / (dMax - dMin);
				val = 1 - clamp(t, 0, 1);
			} else if (opts.mode === 'adjacency') {
				zVal = p.z;
				z2Val = p.z * p.z;
			}

			for (let yy = y0; yy <= y1; yy++) {
				const dy = yy - sy;
				for (let xx = x0; xx <= x1; xx++) {
					const dx = xx - sx;
					const r2 = dx * dx + dy * dy;
					const gw = Math.exp(-r2 * invTwoSig2);
					const idx = yy * w + xx;
					field[idx] += gw;
					if (fieldZ) fieldZ[idx] += gw * (opts.mode === 'camera-dist' ? val : zVal);
					if (fieldZ2) fieldZ2[idx] += gw * z2Val;
				}
			}
		}

		if (opts.normalizeDist) { sums._dMin = dMin; sums._dMax = dMax; }
	}

	// Separable box blur — cheap, works as a poor man's Gaussian. Two passes
	// (horizontal then vertical), each replacing the field with a windowed
	// average of radius r. We reuse one scratch buffer.
	function boxBlur(field, scratch, w, h, radius) {
		if (radius < 1) return;
		const r = radius | 0;
		// horizontal: field → scratch
		for (let y = 0; y < h; y++) {
			const row = y * w;
			// running sum
			let sum = 0;
			for (let x = -r; x <= r; x++) {
				const xx = clamp(x, 0, w - 1);
				sum += field[row + xx];
			}
			const denom = 2 * r + 1;
			for (let x = 0; x < w; x++) {
				scratch[row + x] = sum / denom;
				// advance window: drop column leaving on the left, add on right
				const xOut = x - r;
				const xIn = x + r + 1;
				sum -= field[row + clamp(xOut, 0, w - 1)];
				sum += field[row + clamp(xIn, 0, w - 1)];
			}
		}
		// vertical: scratch → field
		for (let x = 0; x < w; x++) {
			let sum = 0;
			for (let y = -r; y <= r; y++) {
				const yy = clamp(y, 0, h - 1);
				sum += scratch[yy * w + x];
			}
			const denom = 2 * r + 1;
			for (let y = 0; y < h; y++) {
				field[y * w + x] = sum / denom;
				const yOut = y - r;
				const yIn = y + r + 1;
				sum -= scratch[clamp(yOut, 0, h - 1) * w + x];
				sum += scratch[clamp(yIn, 0, h - 1) * w + x];
			}
		}
	}

	// Repeated box blur approximates a Gaussian (central limit theorem): 3–4
	// constant-radius passes give a very close Gaussian without the
	// per-pixel-exp calls of a true Gaussian kernel.
	function gaussianBlur(field, scratch, w, h, radius, passes) {
		const r = Math.max(1, radius | 0);
		for (let i = 0; i < passes; i++) {
			boxBlur(field, scratch, w, h, r);
		}
	}

	// ---- public API --------------------------------------------------------

	// Compute the heightmap into `out` (Float32Array length w*h).
	//
	// positions: Float64Array/Float32Array of length count*3 (x,y,z in kpc,
	//            galactic frame).
	// count:     number of stars.
	// camera:    { x,y,z, fx,fy,fz } position + forward direction (galactic).
	// opts: {
	//   mode:        'camera-dist' | 'adjacency',
	//   w, h:        field resolution (e.g. 256, 256),
	//   fovDeg:      horizontal field of view in degrees,
	//   splatSigma:  Gaussian sigma in texels (default 14),
	//   blurRadius:  box-blur radius (default 6),
	//   blurPasses:  number of box-blur passes (default 3),
	// }
	// out: Float32Array of length w*h, filled with 0..1 heights.
	//
	// Returns out (for chaining) plus metadata { dMin, dMax } attached.
	function computeField(positions, count, camera, opts, out) {
		const w = opts.w | 0, h = opts.h | 0;
		if (!out || out.length < w * h) out = new Float32Array(w * h);
		const N = w * h;

		// Intermediate accumulators.
		const wacc = new Float32Array(N);
		const needZ = opts.mode === 'adjacency';
		const wz = needZ ? new Float32Array(N) : new Float32Array(N);
		const wz2 = needZ ? new Float32Array(N) : null;

		const sums = { w: wacc, wz, wz2 };
		splatStars(w, h, positions, count, camera, {
			mode: opts.mode,
			fovDeg: opts.fovDeg || 90,
			splatSigma: opts.splatSigma || 14,
			normalizeDist: opts.mode === 'camera-dist',
		}, sums);

		// Blur the accumulators with the same kernel so ratios stay aligned.
		const scratch = new Float32Array(N);
		const rad = opts.blurRadius || 6;
		const passes = opts.blurPasses || 3;
		gaussianBlur(wacc, scratch, w, h, rad, passes);
		if (needZ) {
			gaussianBlur(wz, scratch, w, h, rad, passes);
			gaussianBlur(wz2, scratch, w, h, rad, passes);
		} else {
			gaussianBlur(wz, scratch, w, h, rad, passes); // w*d
		}

		// Final height: divide to get normalized value, then rescale to 0..1.
		let vMin = Infinity, vMax = -Infinity;
		for (let i = 0; i < N; i++) {
			const ww = wacc[i];
			let v = 0;
			if (ww > 1e-4) {
				if (opts.mode === 'camera-dist') {
					v = wz[i] / ww;  // already 0..1-ish from splat
				} else {
					// local depth variance: E[z²] - E[z]², clamped ≥ 0
					const mz = wz[i] / ww;
					const mz2 = wz2[i] / ww;
					v = mz2 - mz * mz;
					if (v < 0) v = 0;
					v = Math.sqrt(v);  // stddev (kpc) — reads better as height
				}
			}
			out[i] = v;
			if (v < vMin) vMin = v;
			if (v > vMax) vMax = v;
		}

		// Normalize to 0..1.
		const span = vMax - vMin;
		if (span > 1e-8) {
			for (let i = 0; i < N; i++) out[i] = (out[i] - vMin) / span;
		} else {
			out.fill(0);
		}

		out._vMin = vMin;
		out._vMax = vMax;
		out._w = w;
		out._h = h;
		if (sums._dMin !== undefined) { out._dMin = sums._dMin; out._dMax = sums._dMax; }
		return out;
	}

	// Read the height at a UV coordinate (u, v in [0,1]) with bilinear interp.
	function getHeightAt(field, u, v) {
		const w = field._w, h = field._h;
		const fx = clamp(u, 0, 1) * (w - 1);
		const fy = clamp(v, 0, 1) * (h - 1);
		const x0 = Math.floor(fx), y0 = Math.floor(fy);
		const x1 = Math.min(w - 1, x0 + 1);
		const y1 = Math.min(h - 1, y0 + 1);
		const tx = fx - x0, ty = fy - y0;
		const v00 = field[y0 * w + x0];
		const v10 = field[y0 * w + x1];
		const v01 = field[y1 * w + x0];
		const v11 = field[y1 * w + x1];
		return (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
	}

	// Build the constellation anchor set (for N=0 slider value).
	// Returns a Float64Array of n*3 galactic kpc positions, plus metadata.
	// When model is the Milky Way, uses Landmarks ENTRIES (the named bright
	// stars) + the Sun at origin. For procedural galaxies (no real night sky),
	// falls back to the N_CON brightest sampled stars around home.
	function buildConstellationSet(model, opts) {
		const useLandmarks = model.type === 'SBb' && !opts.forceSampled;
		if (useLandmarks) {
			const deps = (typeof window !== 'undefined')
				? { Landmarks: window.Landmarks }
				: { Landmarks: require('../data/landmarks.js') };
			const L = deps.Landmarks;
			const n = L.count;
			const out = new Float64Array(n * 3);
			for (let i = 0; i < n; i++) {
				out[i * 3]     = L.positions[i * 3];
				out[i * 3 + 1] = L.positions[i * 3 + 1];
				out[i * 3 + 2] = L.positions[i * 3 + 2];
			}
			out._source = 'landmarks';
			out._count = n;
			return out;
		}
		// Procedural fallback: sample CON stereo-typical anchors.
		const sampleDeps = (typeof window !== 'undefined')
			? { SamplingLib: window.SamplingLib, GalaxyLib: window.GalaxyLib }
			: { SamplingLib: require('./sampling.js'), GalaxyLib: require('./galaxy.js') };
		const SAMPLING = sampleDeps.SamplingLib;
		const CON = 88;
		const big = SAMPLING.sampleGalaxyStars(model, 0xC0A57, 2000);
		// Pick the CON closest to home (origin for procedural, or model.home).
		const hx = 0, hy = 0, hz = 0;
		const dists = new Float32Array(big.count);
		const idx = new Int32Array(big.count);
		for (let i = 0; i < big.count; i++) {
			const dx = big.x[i] - hx, dy = big.y[i] - hy, dz = big.z[i] - hz;
			dists[i] = dx * dx + dy * dy + dz * dz;
			idx[i] = i;
		}
		// partial sort: take CON smallest
		idx.sort((a, b) => dists[a] - dists[b]);
		const n = Math.min(CON, big.count);
		const out = new Float64Array(n * 3);
		for (let i = 0; i < n; i++) {
			const k = idx[i];
			out[i * 3]     = big.x[k];
			out[i * 3 + 1] = big.y[k];
			out[i * 3 + 2] = big.z[k];
		}
		out._source = 'sampled';
		out._count = n;
		return out;
	}

	// Build a dynamic position set of N sampled stars (or constellations when
	// N=0). Positions are the *birth* positions — the caller is responsible for
	// orbit integration if time is non-zero.
	function buildStarSet(model, nNearest, seed) {
		if (nNearest <= 0) return buildConstellationSet(model, {});
		const deps = (typeof window !== 'undefined')
			? { SamplingLib: window.SamplingLib }
			: { SamplingLib: require('./sampling.js') };
		const SAMPLING = deps.SamplingLib;
		const NBUF = Math.max(nNearest * 4, 2000);
		const buf = SAMPLING.sampleGalaxyStars(model, seed || 0x7E57A1, NBUF);
		// pick nNearest closest to origin (home)
		const dists = new Float32Array(buf.count);
		const idx = new Int32Array(buf.count);
		for (let i = 0; i < buf.count; i++) {
			const x = buf.x[i], y = buf.y[i], z = buf.z[i];
			dists[i] = x * x + y * y + z * z;
			idx[i] = i;
		}
		idx.sort((a, b) => dists[a] - dists[b]);
		const n = Math.min(nNearest, buf.count);
		const out = new Float64Array(n * 3);
		for (let i = 0; i < n; i++) {
			const k = idx[i];
			out[i * 3]     = buf.x[k];
			out[i * 3 + 1] = buf.y[k];
			out[i * 3 + 2] = buf.z[k];
		}
		out._count = n;
		out._source = 'nearest';
		return out;
	}

	// Advance the position set through time using the orbit engine.
	// packed: an array of packed u32 records (same length as positions count).
	// If omitted, positions are returned as-is (no motion).
	function integratePositions(positions, count, packed, time, model, tmp) {
		if (!packed || time === 0) return positions;
		const outP = tmp || new Float64Array(count * 3);
		const Orbit = (typeof window !== 'undefined') ? window.OrbitLib : require('./orbit.js');
		const p3 = [0, 0, 0];
		for (let i = 0; i < count; i++) {
			const x = positions[i * 3];
			const y = positions[i * 3 + 1];
			const z = positions[i * 3 + 2];
			Orbit.engineRecordPosition(p3, x, y, z, packed[i], time, model);
			outP[i * 3]     = p3[0];
			outP[i * 3 + 1] = p3[1];
			outP[i * 3 + 2] = p3[2];
		}
		return outP;
	}

	const ViewModesField = {
		computeField,
		getHeightAt,
		buildConstellationSet,
		buildStarSet,
		integratePositions,
		buildBasis,
		projectPoint,
	};

	if (typeof module !== 'undefined') module.exports = ViewModesField;
	if (typeof window !== 'undefined') window.ViewModesField = ViewModesField;
})();
