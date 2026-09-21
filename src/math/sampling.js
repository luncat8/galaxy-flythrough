// src/math/sampling.js
// Star sampling from the analytical density field, for a given GalaxyModel
// (src/math/galaxy.js → src/math/density.js).
//
// Every draw is exact and single-pass: there is no rejection loop, no rhoMax
// grid and no box, so the field matches the model's local density ratios at
// any star count and no star can silently fall through to the origin. Each
// component is inverted from its own truncated profile:
//
//   thin disc:  R ~ R*exp(-R/L) (cored: from coreRadius), phi ~ arm profile,
//               z ~ sech^2(z/2H(R)) with H(R) = H(1 + flare*R/L) drawn per R
//   thick disc: R ~ R*exp(-R/L) (cored: from coreRadius), phi ~ arm profile,
//               z ~ exp(-|z|/H(R))
//   spheroid:   plummer radius or sersic radius, uniform direction, axis scaling
//   halo:       r ~ r^-1.5 on [a_h, rMax] (i.e. rho ~ r^-3.5), uniform direction
//
// Irregulars are two-stage: after the base draw, CLUMP_SHARE of the disc stars
// is re-drawn inside a hash-picked clump gaussian (sigma = clump.r), matching
// the field's hotspot boost.
//
// The spiral arms enter as an azimuthal density profile. For a fixed R the
// model's disc density is proportional to 1 + A*cos(m*phi - k*ln(R/Rs) +
// phase0), so drawing theta from p(theta) ~ 1 + A*cos(theta) by inverse CDF and
// setting phi = (theta + k*ln(R/Rs) - phase0)/m + n*2*pi/m gives exactly that
// distribution —
// the arm rejection sampler it replaces also worked, but it had to compensate
// a 17% loss of disc draws by inflating the other components' weights. A model
// with arms.amp 0 (S0, E4) skips the profile and draws a plain uniform azimuth.
//
// Output is struct-of-arrays (typed arrays per field) so a 1M-star batch does
// not allocate per-star objects, and star i is a pure function of (seed, i).
//
// The field reproduces the model *inside the sampled volume*: the disc is
// truncated at |z| = discHeight and the spheroid at spheroidRadius, which
// removes 0.01% / 3.6% / 4% of the thin, thick and bulge mass in the Milky Way
// preset. Component weights are the mass each population delivers after
// truncation (deliveredMasses()), so both the counts and the local density
// ratios are correct; the removed tails are not redistributed.

'use strict';

(function () {
	const density = (typeof module !== 'undefined' && module.exports)
		? require('./density.js')
		: window.DensityLib;
	const hash = (typeof module !== 'undefined' && module.exports)
		? require('./hash.js')
		: window.HashLib;

	const TAU = Math.PI * 2;
	// Fraction of disc stars the Irr sampler assigns directly to a clump
	// gaussian (the plan's two-stage clump sampling). The base draw keeps the
	// rest; together they approximate the field's 1 + boost hotspots. Tuned
	// so the assigned mass equals the field's measured clump excess mass
	// (2.3% of the Irr box mass, boost x3, r 0.24 kpc, 12 hotspots).
	const CLUMP_SHARE = 0.024;

	// Inverse CDF of p(R) ~ R*exp(-R/L), truncated to [0, rMax]:
	//   F(R) = 1 - (1 + R/L) * exp(-R/L)
	// No closed form, so invert with bisection — 32 deterministic steps put the
	// result well below f32 resolution. A cored disc (coreRadius > 0) inverts
	// the same exponential over [coreRadius, rMax]: the plan's documented
	// approximation to the soft R/sqrt(R^2 + c^2) core, which shares the same
	// slope and outer profile.
	function sampleDiscRadius(u, L, rMax, coreRadius, out) {
		const f = (R) => 1 - (1 + R / L) * Math.exp(-R / L);
		const lo0 = coreRadius > 0 ? coreRadius : 0;
		const target = f(lo0) + u * (f(rMax) - f(lo0));
		let lo = lo0;
		let hi = rMax;
		for (let i = 0; i < 32; i++) {
			const mid = 0.5 * (lo + hi);
			if (f(mid) < target) lo = mid; else hi = mid;
		}
		out[0] = 0.5 * (lo + hi);
	}

	// z ~ sech^2(z / 2H) truncated to |z| <= zMax. The untruncated CDF is
	// F(z) = (1 + tanh(z/2H)) / 2, so scaling the uniform into the truncation
	// keeps the profile exact instead of rejecting the tail.
	function sampleSech2Z(u, H, zMax) {
		const range = Math.tanh(zMax / (2 * H));
		return 2 * H * Math.atanh((2 * u - 1) * range);
	}

	// z ~ exp(-|z| / H) truncated to |z| <= zMax.
	function sampleLaplaceZ(u, H, zMax) {
		const range = 1 - Math.exp(-zMax / H);
		const v = (2 * u - 1) * range;
		return -H * Math.sign(v) * Math.log(1 - Math.abs(v));
	}

	// theta ~ 1 + A*cos(theta) on [0, 2*pi): F(t) = (t + A*sin(t)) / 2*pi.
	// Monotone for A < 1, so 24 bisection steps are enough.
	function sampleArmPhase(u, amp) {
		let lo = 0;
		let hi = TAU;
		for (let i = 0; i < 24; i++) {
			const mid = 0.5 * (lo + hi);
			const cdf = (mid + amp * Math.sin(mid)) / TAU;
			if (cdf < u) lo = mid; else hi = mid;
		}
		return 0.5 * (lo + hi);
	}

	// Uniform direction on the sphere from two uniforms.
	function sampleDirection(u1, u2, out) {
		const cosTheta = 2 * u1 - 1;
		const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
		const phi = TAU * u2;
		out[0] = sinTheta * Math.cos(phi);
		out[1] = sinTheta * Math.sin(phi);
		out[2] = cosTheta;
	}

	// One standard normal from two uniforms (Box-Muller, the cos branch).
	// The clump gaussian has sigma = clump.r, matching the field's
	// exp(-d^2 / (2 r^2)).
	function sampleGaussian(u1, u2) {
		return Math.sqrt(-2 * Math.log(Math.max(1e-12, u1))) * Math.cos(TAU * u2);
	}

	// Flared scale height at radius R: H(R) = H * (1 + flare * R / L).
	// `flare` 0 is the flat disc (the common case).
	function discHeightAt(group, R) {
		return group.H * (1 + (group.flare || 0) * (R / group.L));
	}

	// Plummer spheroid radius: M(<s) ~ s^3 (1 + s^2)^(-3/2) = u, truncated at
	// sMax by scaling into that fraction of the distribution.
	function samplePlummerRadius(u, sMax) {
		const sMaxMass = Math.pow(sMax, 3) / Math.pow(1 + sMax * sMax, 1.5);
		const v = Math.pow(u * sMaxMass, 2 / 3);
		return Math.sqrt(v / Math.max(1e-12, 1 - v));
	}

	// Spheroid radius in units of s, for any profile. The sersic and bar branches
	// invert density.sersicMassFraction/barMassFraction, so the stars and the field agree by
	// construction rather than by a measured acceptance rate.
	function sampleSpheroidRadius(model, u) {
		const sMax = model.truncation.spheroidRadius;
		if (model.spheroid.profileId === density.PROFILE_BAR) return density.barRadiusForFraction(model, u);
		if (model.spheroid.profileId === density.PROFILE_SERSIC) return density.sersicRadiusForFraction(model, u);
		return samplePlummerRadius(u, sMax);
	}

	function sampleHaloRadius(model, u, mass) {
		const h = model.halo;
		const target = u * mass;
		if (target <= 1 / 3) return h.a_h * Math.cbrt(3 * target);
		const q = 3 - h.power;
		const tail = target - 1 / 3;
		return h.a_h * Math.exp(q === 0 ? tail : Math.log1p(q * tail) / q);
	}

	// Mass each population contributes inside the sampled volume, in
	// componentMasses() units. These are the sampler's weights *and* the counts
	// the tests expect: the disc tails past |z| = discHeight and the spheroid
	// tail past sMax are simply absent from the field.
	function deliveredMasses(model) {
		const m = density.componentMasses(model);
		const f = density.truncationFractions(model);
		const out = {
			thin: m.thin * f.thin,
			thick: m.thick * f.thick,
			bulge: m.bulge * f.bulge,
			halo: m.halo * f.halo,
		};
		out.total = out.thin + out.thick + out.bulge + out.halo;
		return out;
	}

	function createBuffers(count) {
		return {
			count,
			x: new Float32Array(count),
			y: new Float32Array(count),
			z: new Float32Array(count),
			R: new Float32Array(count),
			distToArm: new Float32Array(count),
			component: new Uint8Array(count),
		};
	}

	// Scratch shared by the spheroid/halo direction and radius writes: allocated
	// once per call, never per star.
	const scratch = new Float64Array(3);

	// Sample `count` stars from the full analytical model. Deterministic in
	// (model, seed, count): star i is always the same star.
	function sampleGalaxyStars(model, seed, count, out) {
		const buf = out && out.x && out.x.length >= count ? out : createBuffers(count);
		buf.count = count;

		const masses = deliveredMasses(model);
		if (!(masses.total > 0)) {
			buf.count = 0;
			return buf;
		}
		const wThin = masses.thin / masses.total;
		const wThick = (masses.thin + masses.thick) / masses.total;
		const wBulge = (masses.thin + masses.thick + masses.bulge) / masses.total;

		const t = model.truncation;
		const A = model.arms.amp;
		const armM = model.arms.m;
		const armArmed = A > 0 && armM > 0;
		const armK = Math.tan(model.arms.pitchDeg * Math.PI / 180);
		const armRs = model.arms.Rs;
		const armPhase0 = model.arms.phase0;
		const tilt = model.spheroid.tiltDeg * Math.PI / 180;
		const ct = Math.cos(tilt);
		const st = Math.sin(tilt);
		const gcX = model.centre.x;
		const gcY = model.centre.y;
		const gcZ = model.centre.z;
		const haloMass = density.haloRadialMass(model, model.halo.rMax);
		const clumps = model.clumps || [];

		for (let i = 0; i < count; i++) {
			const starSeed = Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(seed | 0, 0x85ebca6b);
			const u0 = hash.hash01At(starSeed, 0);
			const u1 = hash.hash01At(starSeed, 1);
			const u2 = hash.hash01At(starSeed, 2);
			const u3 = hash.hash01At(starSeed, 3);
			const u4 = hash.hash01At(starSeed, 4);
			let x = 0;
			let y = 0;
			let z = 0;
			let component = density.COMPONENT_THIN;

		if (u0 < wThin) {
			component = density.COMPONENT_THIN;
			sampleDiscRadius(u1, model.thin.L, t.discRadius, model.thin.coreRadius || 0, scratch);
			// The z CDF is exact per radius: a flared disc draws |z| from the
			// sech^2 at H(R), which is how the field reads.
			z = sampleSech2Z(u2, discHeightAt(model.thin, scratch[0]), t.discHeight);
		} else if (u0 < wThick) {
			component = density.COMPONENT_THICK;
			sampleDiscRadius(u1, model.thick.L, t.discRadius, model.thick.coreRadius || 0, scratch);
			z = sampleLaplaceZ(u2, discHeightAt(model.thick, scratch[0]), t.discHeight);
		} else if (u0 < wBulge) {
				component = density.COMPONENT_BULGE;
				const sp = model.spheroid;
				const s = model.spheroid.r0 * sampleSpheroidRadius(model, u1);
				sampleDirection(u2, u3, scratch);
				if (sp.profileId === density.PROFILE_BAR) {
					const bn = sp.n || 2.5;
					const norm = Math.pow(Math.pow(Math.abs(scratch[0]), bn) + Math.pow(Math.abs(scratch[1]), bn) + Math.pow(Math.abs(scratch[2]), bn), 1 / bn);
					if (norm > 1e-6) {
						scratch[0] /= norm;
						scratch[1] /= norm;
						scratch[2] /= norm;
					}
				}
				const ex = sp.a * s * scratch[0];
				const ey = sp.b * s * scratch[1];
				const ez = sp.c * s * scratch[2];
				x = gcX + ex * ct - ey * st;
				y = gcY + ex * st + ey * ct;
				z = gcZ + ez;
				buf.x[i] = x;
				buf.y[i] = y;
				buf.z[i] = z;
				buf.component[i] = component;
				buf.R[i] = Math.sqrt((x - gcX) * (x - gcX) + (y - gcY) * (y - gcY));
				buf.distToArm[i] = density.distanceToNearestArm(model, buf.R[i], Math.atan2(y - gcY, x - gcX));
				continue;
			} else {
				component = density.COMPONENT_HALO;
				const r = sampleHaloRadius(model, u1, haloMass);
				sampleDirection(u2, u3, scratch);
				x = gcX + r * scratch[0];
				y = gcY + r * scratch[1];
				z = gcZ + r * scratch[2];
				buf.x[i] = x;
				buf.y[i] = y;
				buf.z[i] = z;
				buf.component[i] = component;
				buf.R[i] = Math.sqrt((x - gcX) * (x - gcX) + (y - gcY) * (y - gcY));
				buf.distToArm[i] = density.distanceToNearestArm(model, buf.R[i], Math.atan2(y - gcY, x - gcX));
				continue;
			}

			// Discs: R and z are drawn above; phi follows the arm profile.
			//
			// theta = m*phi - k*ln(R/Rs) + phase0 is drawn from 1 + A*cos(theta),
			// which fixes phi to one 2*pi/m wide window containing a single arm
			// ridge. The profile has m identical ridges, so one of the m
			// replicas is picked uniformly — without this the disc would only
			// populate half the azimuths (m = 2) and the sky would have a seam.
		const R = scratch[0];
		let phi = TAU * u3;
		if (armArmed && R >= model.arms.minRadius) {
			const theta = sampleArmPhase(u3, A);
			const replica = Math.min(armM - 1, Math.floor(u4 * armM));
			phi = (theta + armK * Math.log(R / armRs) - armPhase0) / armM + TAU * replica / armM;
		}
		x = gcX + R * Math.cos(phi);
		y = gcY + R * Math.sin(phi);
		let zWorld = gcZ + z;
		// Two-stage clump assignment (Irr): a fixed share of the disc stars is
		// drawn inside the gaussian of a hash-picked clump, giving the sample
		// the hotspot concentration the field carries. Positions are
		// galactocentric offsets, so a centre override moves them too.
		if (clumps.length > 0 && hash.hash01At(starSeed, 5) < CLUMP_SHARE) {
			const c = clumps[Math.min(clumps.length - 1, Math.floor(hash.hash01At(starSeed, 6) * clumps.length))];
			x = gcX + c.x + c.r * sampleGaussian(hash.hash01At(starSeed, 7), hash.hash01At(starSeed, 8));
			y = gcY + c.y + c.r * sampleGaussian(hash.hash01At(starSeed, 9), hash.hash01At(starSeed, 10));
			zWorld = gcZ + c.z + c.r * sampleGaussian(hash.hash01At(starSeed, 11), hash.hash01At(starSeed, 12));
		}
		buf.x[i] = x;
		buf.y[i] = y;
		buf.z[i] = zWorld;
		buf.component[i] = component;
		buf.R[i] = Math.sqrt((x - gcX) * (x - gcX) + (y - gcY) * (y - gcY));
		buf.distToArm[i] = density.distanceToNearestArm(model, buf.R[i], Math.atan2(y - gcY, x - gcX));
	}

		return buf;
	}

	// Full model restricted to an axis-aligned box. Used by the model
	// experiments, which reason about one region at a time.
	function sampleStarsInBox(model, seed, count, box, out) {
		const buf = out && out.x && out.x.length >= count ? out : createBuffers(count);
		const batchSize = 8192;
		const batch = createBuffers(batchSize);
		let n = 0;
		let batchSeed = seed;
		// The box can be a tiny slice of the galaxy, so keep drawing batches
		// until it is full; the cap keeps a hopeless box from looping forever.
		const maxAttempts = Math.ceil((count / 0.05) / batchSize) + 16;
		for (let attempt = 0; attempt < maxAttempts && n < count; attempt++) {
			sampleGalaxyStars(model, batchSeed, batchSize, batch);
			batchSeed = (Math.imul(batchSeed, 0x9e3779b1) + 0x2545f491) | 0;
			for (let i = 0; i < batch.count && n < count; i++) {
				const x = batch.x[i];
				const y = batch.y[i];
				const z = batch.z[i];
				if (x < box.xMin || x > box.xMax) continue;
				if (y < box.yMin || y > box.yMax) continue;
				if (z < box.zMin || z > box.zMax) continue;
				buf.x[n] = x;
				buf.y[n] = y;
				buf.z[n] = z;
				buf.R[n] = batch.R[i];
				buf.distToArm[n] = batch.distToArm[i];
				buf.component[n] = batch.component[i];
				n++;
			}
		}
		buf.count = n;
		return buf;
	}

	// Empirical component shares of a sample — the expectation is
	// deliveredMasses(), which the sampling test compares against.
	function componentShares(buf) {
		const counts = [0, 0, 0, 0];
		for (let i = 0; i < buf.count; i++) counts[buf.component[i]]++;
		const shares = {};
		for (let c = 0; c < 4; c++) shares[density.COMPONENT_NAMES[c]] = counts[c] / Math.max(1, buf.count);
		return shares;
	}

	const api = {
		sampleGalaxyStars,
		sampleStarsInBox,
		componentShares,
		createBuffers,
		deliveredMasses,
		CLUMP_SHARE,
	};
	if (typeof module !== 'undefined') module.exports = api;
	if (typeof window !== 'undefined') window.SamplingLib = api;
})();
