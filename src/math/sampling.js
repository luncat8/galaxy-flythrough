// src/math/sampling.js
// Star sampling from the analytical density field (src/math/density.js).
//
// Every draw is exact and single-pass: there is no rejection loop, no rhoMax
// grid and no box, so the field matches the model's local density ratios at
// any star count and no star can silently fall through to the origin. Each
// component is inverted from its own truncated profile:
//
//   thin disc:  R ~ R*exp(-R/L),  phi ~ arm profile,  z ~ sech^2(z/2H)
//   thick disc: R ~ R*exp(-R/L),  phi ~ arm profile,  z ~ exp(-|z|/H)
//   bulge:      Plummer radius,    uniform direction, triaxial scaling
//   halo:       r ~ r^-1.5 on [a_h, rMax] (i.e. rho ~ r^-3.5), uniform direction
//
// The spiral arms enter as an azimuthal density profile. For a fixed R the
// model's disc density is proportional to 1 + A*cos(m*phi - k*ln(R/Rs)), so
// drawing theta from p(theta) ~ 1 + A*cos(theta) by inverse CDF and setting
// phi = (theta + k*ln(R/Rs) - phase0)/m+n*2*pi/m gives exactly that
// distribution —
// the arm rejection sampler it replaces also worked, but it had to compensate
// a 17% loss of disc draws by inflating the other components' weights.
//
// Output is struct-of-arrays (typed arrays per field) so a 1M-star batch does
// not allocate per-star objects, and star i is a pure function of (seed, i).
//
// The field reproduces the model *inside the sampled volume*: the thin disc is
// truncated at |z| = discHeight and the bulge at a few Plummer radii, which
// removes 0.01% / 3.6% / 4% of the thin, thick and bulge mass. Component
// weights are the mass each population delivers after truncation
// (deliveredMasses()), so both the counts and the local density ratios are
// correct; the removed tails are not redistributed.

'use strict';

(function () {
	const density = (typeof module !== 'undefined' && module.exports)
		? require('./density.js')
		: window.DensityLib;
	const hash = (typeof module !== 'undefined' && module.exports)
		? require('./hash.js')
		: window.HashLib;

	const TAU = Math.PI * 2;
	// Channels per star: 0 component, 1 radius, 2 vertical/direction, 3 arm
	// phase, 4.. spare for star-types and future fields.
	const CHANNELS = 8;

	// Inverse CDF of p(R) ~ R*exp(-R/L), truncated to [0, rMax]:
	//   F(R) = 1 - (1 + R/L) * exp(-R/L)
	// No closed form, so invert with bisection — 32 deterministic steps put the
	// result well below f32 resolution.
	function sampleDiscRadius(u, L, rMax, out) {
		let lo = 0;
		let hi = rMax;
		for (let i = 0; i < 32; i++) {
			const mid = 0.5 * (lo + hi);
			const cdf = 1 - (1 + mid / L) * Math.exp(-mid / L);
			if (cdf < u) lo = mid; else hi = mid;
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

	// Plummer-like bulge radius: M(<s) ~ s^3 (1 + s^2)^(-3/2) = u, truncated at
	// sMax by scaling into that fraction of the distribution.
	function samplePlummerRadius(u, sMax) {
		const sMaxMass = Math.pow(sMax, 3) / Math.pow(1 + sMax * sMax, 1.5);
		const v = Math.pow(u * sMaxMass, 2 / 3);
		return Math.sqrt(v / Math.max(1e-12, 1 - v));
	}

	// Fraction of each component's untruncated mass that lies inside the
	// sampled volume. Radial and vertical terms are the closed-form tails of
	// the profiles; the bulge is the Plummer mass inside sMax.
	function truncationFractions() {
		const t = density.TRUNCATION;
		const discRadial = (L) => 1 - (1 + t.discRadius / L) * Math.exp(-t.discRadius / L);
		return {
			thin: discRadial(density.THIN.L) * Math.tanh(t.discHeight / (2 * density.THIN.H)),
			thick: discRadial(density.THICK.L) * (1 - Math.exp(-t.discHeight / density.THICK.H)),
			bulge: Math.pow(t.bulgeRadius, 3) / Math.pow(1 + t.bulgeRadius * t.bulgeRadius, 1.5),
			halo: 1,   // rMax is part of the distribution, not a truncation of it
		};
	}

	// Mass each population contributes inside the sampled volume, in
	// componentMasses() units. These are the sampler's weights *and* the
	// counts the tests expect: the disc tails past |z| = discHeight and the
	// bulge tail past sMax are simply absent from the field.
	function deliveredMasses() {
		const m = density.componentMasses();
		const f = truncationFractions();
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

	// Sample `count` stars from the full analytical model. Deterministic in
	// (seed, count): star i is always the same star.
	function sampleGalaxyStars(seed, count, out) {
		const buf = out && out.x && out.x.length >= count ? out : createBuffers(count);
		buf.count = count;

		const masses = deliveredMasses();
		const wThin = masses.thin / masses.total;
		const wThick = (masses.thin + masses.thick) / masses.total;
		const wBulge = (masses.thin + masses.thick + masses.bulge) / masses.total;

		const t = density.TRUNCATION;
		const A = density.ARMS.amp;
		const armK = Math.tan(density.ARMS.pitchDeg * Math.PI / 180);
		const armRs = density.ARMS.Rs;
		const armM = density.ARMS.m;
		const armPhase0 = density.ARMS.phase0;
		const tilt = density.BULGE.tiltDeg * Math.PI / 180;
		const ct = Math.cos(tilt);
		const st = Math.sin(tilt);
		const gcX = density.GALACTIC_CENTRE.x;
		const gcY = density.GALACTIC_CENTRE.y;

		const scratch = new Float64Array(3);

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
				sampleDiscRadius(u1, density.THIN.L, t.discRadius, scratch);
				z = sampleSech2Z(u2, density.THIN.H, t.discHeight);
			} else if (u0 < wThick) {
				component = density.COMPONENT_THICK;
				sampleDiscRadius(u1, density.THICK.L, t.discRadius, scratch);
				z = sampleLaplaceZ(u2, density.THICK.H, t.discHeight);
			} else if (u0 < wBulge) {
				component = density.COMPONENT_BULGE;
				const s = samplePlummerRadius(u1, t.bulgeRadius);
				sampleDirection(u2, u3, scratch);
				const ex = density.BULGE.a * s * scratch[0];
				const ey = density.BULGE.b * s * scratch[1];
				const ez = density.BULGE.c * s * scratch[2];
				x = gcX + ex * ct - ey * st;
				y = gcY + ex * st + ey * ct;
				z = ez;
				buf.x[i] = x;
				buf.y[i] = y;
				buf.z[i] = z;
				buf.component[i] = component;
				const gcBulge = density.toGalactocentric(x, y, z);
				buf.R[i] = gcBulge.R;
				buf.distToArm[i] = density.distanceToNearestArm(gcBulge.R, gcBulge.phi);
				continue;
			} else {
				component = density.COMPONENT_HALO;
				const a = density.HALO.a_h;
				const invSqrtA = 1 / Math.sqrt(a);
				const invSqrtMax = 1 / Math.sqrt(density.HALO.rMax);
				const r = 1 / Math.pow(invSqrtA - u1 * (invSqrtA - invSqrtMax), 2);
				sampleDirection(u2, u3, scratch);
				x = gcX + r * scratch[0];
				y = gcY + r * scratch[1];
				z = r * scratch[2];
				buf.x[i] = x;
				buf.y[i] = y;
				buf.z[i] = z;
				buf.component[i] = component;
				const gcHalo = density.toGalactocentric(x, y, z);
				buf.R[i] = gcHalo.R;
				buf.distToArm[i] = density.distanceToNearestArm(gcHalo.R, gcHalo.phi);
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
			if (R > 0.5) {
				const theta = sampleArmPhase(u3, A);
				const replica = Math.min(armM - 1, Math.floor(u4 * armM));
				phi = (theta + armK * Math.log(R / armRs) - armPhase0) / armM + TAU * replica / armM;
			}
			x = gcX + R * Math.cos(phi);
			y = gcY + R * Math.sin(phi);
			buf.x[i] = x;
			buf.y[i] = y;
			buf.z[i] = z;
			buf.component[i] = component;
			buf.R[i] = R;
			buf.distToArm[i] = density.distanceToNearestArm(R, Math.atan2(Math.sin(phi), Math.cos(phi)));
		}

		return buf;
	}

	// Full model restricted to an axis-aligned box. Used by the model
	// experiments, which reason about one region at a time.
	function sampleStarsInBox(seed, count, box, out) {
		const buf = out && out.x && out.x.length >= count ? out : createBuffers(count);
		const batchSize = 8192;
		const batch = createBuffers(batchSize);
		let n = 0;
		let batchSeed = seed;
		// The box can be a tiny slice of the galaxy, so keep drawing batches
		// until it is full; the cap keeps a hopeless box from looping forever.
		const maxAttempts = Math.ceil((count / 0.05) / batchSize) + 16;
		for (let attempt = 0; attempt < maxAttempts && n < count; attempt++) {
			sampleGalaxyStars(batchSeed, batchSize, batch);
			batchSeed = (Math.imul(batchSeed, 0x9e3779b1) + 0x2545f491) | 0;
			for (let i = 0; i < batchSize && n < count; i++) {
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
		truncationFractions,
	};
	if (typeof module !== 'undefined') module.exports = api;
	if (typeof window !== 'undefined') window.SamplingLib = api;
})();
