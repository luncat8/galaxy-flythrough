// experiments/shape-test.js
// The 0.4.8 shape gate: does each component reproduce the *3D* shape of the
// structure it stands for?
//
// A galaxy can be right in its face-on outline and wrong in the third
// dimension. The bar profile used to fill a boxy superellipsoid uniformly, so a
// bar was a slab: flat-topped in z, with a hard rim at the envelope (measured:
// rho(z)/rho(0) = 1.000 out to |z| = c, then 0). The eye reads that as "not a
// galaxy" long before any integral notices. These checks are about the third
// dimension:
//
//   1. no step — rho along a dense cut through each component has no single-bin
//      jump larger than a fraction of that cut's own peak, for every type
//   2. the bar's slice profile — density falls monotonically inside the body,
//      is already small at the envelope (no rim), and the analytic slice mass
//      equals the numeric integral of the same profile
//   3. the peanut — the bar is thicker at its ends than in its middle, and the
//      thickening stays inside the authored body
//   4. observed thickness — the half-density height, the axis ratios and the
//      vertical reach are in the observed bands (real B/P bars are thin: the
//      Milky Way's bar has exponential scale heights 0.70 : 0.44 : 0.18 kpc
//      along its principal axes, Wegg & Gerhard 2013, via Wegg 2014)
//   5. sampler vs field — the bar's sampled longitudinal and vertical marginals
//      follow the field's (total variation)
//
//   --png   also write experiments/logs/shape-<type>.png: the field and the
//           sampled stars, edge-on above face-on, for the human check.
//
// Output: experiments/logs/shape.json

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const density = require('../src/math/density.js');
const sampling = require('../src/math/sampling.js');
const galaxy = require('../src/math/galaxy.js');

const WANT_PNG = process.argv.indexOf('--png') >= 0;
const OUT_DIR = path.join(__dirname, 'logs');

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
	return !!pass;
}
function near(a, b, tol) {
	return Math.abs(a - b) <= tol * Math.max(Math.abs(a), Math.abs(b), 1e-12);
}

const TYPES = galaxy.GALAXY_TYPES.filter((t) => t !== galaxy.MILKY_WAY_TYPE);
const models = {};
for (const type of TYPES) models[type] = galaxy.createGalaxy({ type, seed: 42 });
const MW = galaxy.MILKY_WAY;
const ALL = [MW].concat(TYPES.map((t) => models[t]));
const BARS = ALL.filter((m) => m.spheroid.profileId === density.PROFILE_BAR);

// A bar-frame probe: world point from (xi, eta, zeta), the three coordinates
// density.js's bar branch is written in, relative to the model centre.
function barProbe(model, xi, eta, zeta) {
	const sp = model.spheroid;
	const t = sp.tiltDeg * Math.PI / 180;
	const ct = Math.cos(t);
	const st = Math.sin(t);
	const X = xi * sp.a * sp.r0;
	const Y = eta * sp.b * sp.r0;
	const Z = zeta * sp.c * sp.r0;
	return density.rhoSpheroid(model,
		model.centre.x + X * ct - Y * st, model.centre.y + X * st + Y * ct, model.centre.z + Z);
}

// ---- 1. no step ----------------------------------------------------------
//
// A "step" is a discontinuity: the density jumps by a finite amount across a
// bin, no matter how small the bin is. The detector is the second difference
// f[i+1] - 2*f[i] + f[i-1] on a dense cut: for a smooth profile it is O(f''*h^2)
// — nothing at a 5 pc bin — while at a jump of size D it is ~D. A smooth but
// steep decline (a bar's vertical falloff near its rim) and a cusp (the
// centre, where Sersic profiles genuinely have one) therefore do not register.
// The residual is reported against the model's own peak and against the cut's,
// and against the value just inside: the model-peak number is the
// "would the eye see it in an HDR frame" number, the second is the local
// contrast, which is what the milestone-3 truncation audit is about: the
// Sersic spheroid's cut at s = 8 and the disc's at |z| = discHeight are hard
// local edges (a 28% and a 100% drop of the value just inside), but they sit
// 1e-5 and 1e-6 below the model's peak, so no exposure shows them.
const STEP_BIN_KPC = 0.005;
const STEP_LIMIT = { bar: 0.01, visible: 0.02 };
const STEP_SKIP_KPC = 0.05;   // the central cusp is a feature, not a step

function cutSteps(model, from, dir, length) {
	const steps = Math.max(16, Math.round(length / STEP_BIN_KPC));
	const h = length / steps;
	const rho = new Float64Array(steps + 1);
	for (let i = 0; i <= steps; i++) {
		const t = i * h;
		rho[i] = density.rhoTotal(model, from[0] + dir[0] * t, from[1] + dir[1] * t, from[2] + dir[2] * t);
	}
	let peak = 0;
	for (const v of rho) peak = Math.max(peak, v);
	let worst = { residual: 0, cutPeak: peak, local: 0, at: null };
	for (let i = 1; i < steps; i++) {
		const t = i * h;
		const p = [from[0] + dir[0] * t, from[1] + dir[1] * t, from[2] + dir[2] * t];
		if (Math.hypot(p[0] - model.centre.x, p[1] - model.centre.y, p[2] - model.centre.z) < STEP_SKIP_KPC) continue;
		const residual = Math.abs(rho[i + 1] - 2 * rho[i] + rho[i - 1]);
		if (residual > worst.residual) {
			worst = {
				residual,
				cutPeak: peak,
				local: residual / Math.max(rho[i], 1e-12),
				at: [p[0] - model.centre.x, p[1] - model.centre.y, p[2] - model.centre.z].map((v) => +v.toFixed(2)),
			};
		}
	}
	return worst;
}

{
	// Cuts sized to each model: through the centre along all three axes, out to
	// the disc edge, out to the spheroid's own bound, and through the bar's lobe.
	const cutsFor = (model) => {
		const sp = model.spheroid;
		const discReach = model.thin.amp > 0 ? 1.2 * model.truncation.discRadius : 0;
		const sphReach = 1.2 * model.truncation.spheroidRadius * Math.max(sp.a, sp.b, sp.c) * sp.r0;
		const zReach = 1.2 * Math.max(model.truncation.discHeight, sp.c * sp.r0 * (1 + (model.bar.peanut || 0)));
		const lobe = sp.profileId === density.PROFILE_BAR ? 0.5 * sp.a * sp.r0 : 0.5 * Math.max(model.thin.L || sp.a, sp.a);
		return [
			{ name: 'z through the centre', kind: 'other', from: [model.centre.x, model.centre.y, model.centre.z - zReach], dir: [0, 0, 1], length: 2 * zReach },
			{ name: 'y through the centre', kind: 'other', from: [model.centre.x, model.centre.y - Math.max(lobe, 0.3 * zReach), model.centre.z], dir: [0, 1, 0], length: 2 * Math.max(lobe, 0.3 * zReach) },
			{ name: 'x to the body edge', kind: 'other', from: [model.centre.x, model.centre.y, model.centre.z], dir: [1, 0, 0], length: Math.max(discReach, sphReach) },
			{ name: 'z at the bar lobe', kind: 'bar', from: [model.centre.x + lobe, model.centre.y, model.centre.z - zReach], dir: [0, 0, 1], length: 2 * zReach },
			{ name: 'z through the disc at R = 8', kind: 'other', from: [model.centre.x - 8, model.centre.y, model.centre.z - zReach], dir: [0, 0, 1], length: 2 * zReach },
		];
	};
	// The peak of the whole model: the centre. A residual is "visible" or not
	// against this, which is what an HDR frame shows; the cut's own peak is the
	// local reference, meaningful where the component under test dominates the
	// cut (the bar's own cuts).
	const centrePeak = {};
	for (const model of ALL) centrePeak[model.type] = density.rhoTotal(model, model.centre.x, model.centre.y, model.centre.z);
	for (const model of ALL) {
		const peak = centrePeak[model.type];
		let worstBar = 0;
		let worstVisible = 0;
		const detail = {};
		for (const cut of cutsFor(model)) {
			const kind = cut.kind === 'bar' && model.spheroid.profileId === density.PROFILE_BAR ? 'bar' : 'other';
			const r = cutSteps(model, cut.from, cut.dir, cut.length);
			const ofCut = r.residual / Math.max(r.cutPeak, 1e-30);
			const ofModel = r.residual / Math.max(peak, 1e-30);
			detail[cut.name] = { stepOfModel: +ofModel.toExponential(1), stepOfLocal: +r.local.toFixed(2), at: r.at };
			if (kind === 'bar') worstBar = Math.max(worstBar, ofCut);
			worstVisible = Math.max(worstVisible, ofModel);
		}
		check(`${model.type}: no step in the field is visible against the model peak`,
			worstVisible <= STEP_LIMIT.visible, { worst: +worstVisible.toExponential(1), cuts: detail });
		if (model.spheroid.profileId === density.PROFILE_BAR) {
			check(`${model.type}: the bar's own body has no step at all (no rim)`,
				worstBar <= STEP_LIMIT.bar, { worst: +worstBar.toFixed(4) });
		}
	}
}

// ---- 2. the bar's slice profile ------------------------------------------

{
	for (const model of BARS) {
		const sp = model.spheroid;
		const cv = density.barVerticalExponent(model);
		// rho(zeta) on the major axis: monotone, and already small at the
		// envelope, so no rim survives a rendered edge.
		const profile = [];
		const heights = [];
		for (let i = 0; i <= 400; i++) {
			const zeta = i / 400;
			const rho = barProbe(model, 0, 0, zeta);
			profile.push(rho);
			if (rho > 0) heights.push(zeta);
		}
		let monotone = true;
		for (let i = 1; i < profile.length; i++) if (profile[i] > profile[i - 1] + 1e-12) monotone = false;
		check(`${model.type}: the bar's vertical profile falls monotonically inside the body`,
			monotone && profile[0] > 0 && heights.length > 0,
			{ centre: +profile[0].toFixed(4), envelopeZeta: +heights[heights.length - 1].toFixed(3) });
		const edge = heights[heights.length - 1];
		const nearEdge = profile[Math.round(0.98 * edge * 400)] / profile[0];
		check(`${model.type}: the bar's density is already small at its envelope (no rim)`,
			nearEdge < 0.05, { atEnvelope: +nearEdge.toFixed(4), envelopeZeta: +edge.toFixed(3), cv });
		// The analytic slice mass is the numeric integral of the slice profile.
		const G = 400;
		let numeric = 0;
		for (let i = 0; i < G; i++) {
			const u = (i + 0.5) / G;
			let row = 0;
			for (let j = 0; j < G; j++) row += density.barSliceProfile(model, u, (j + 0.5) / G);
			numeric += row / G;
		}
		numeric *= 4 / G;
		check(`${model.type}: the analytic slice mass is the numeric integral of the slice profile`,
			near(numeric, density.barSliceMass(model), 2e-3),
			{ numeric: +numeric.toFixed(6), analytic: +density.barSliceMass(model).toFixed(6) });
		// The uniform slab of the previous release is the q = 0 case of the
		// same L^n disk area, which is why the generalisation is not a new model.
		check(`${model.type}: the L^n disk area is the closed form of the slab's slice mass`,
			near(density.lnDiskArea(sp.n), 4 * Math.exp(2 * density.logGamma(1 + 1 / sp.n)
				- density.logGamma(1 + 2 / sp.n)), 1e-9), density.lnDiskArea(sp.n));
		// Vertical reach: the body ends exactly at the authored axis, or at the
		// peanut-stretched one off the centre.
		const reach = (xi) => density.barCrossSectionRadius(model, xi, density.barTipRadius(model))
			* density.barVerticalStretch(model, xi);
		check(`${model.type}: the bar's vertical support is the authored body, not more`,
			barProbe(model, 0, 0, reach(0) + 1e-6) === 0 && barProbe(model, 0.6, 0, reach(0.6) + 1e-6) === 0
			&& barProbe(model, 0, 0, reach(0) * 0.5) > 0,
			{ centre: reach(0), lobe: +reach(0.6).toFixed(4) });
	}
}

// ---- 3. the peanut -------------------------------------------------------
//
// The bar's vertical extent has to be largest off-centre: that is the whole
// content of "boxy/peanut", and it is what the observed vertical scale-height
// profile does (it rises from the centre to a peak near the end of the B/P
// region, Wegg et al. 2015). The early-type bars carry the strong peanut the
// literature reports for the class; the late-type ones are nearly elliptical,
// which is also observed, so they are only required to be no thinner than their
// centre.
{
	for (const model of BARS) {
		const sp = model.spheroid;
		const C = sp.c * sp.r0;
		const A = sp.a * sp.r0;
		// Half-extent of the body in z at xi: the envelope, where the density
		// has already fallen to a small fraction of its central value.
		const halfHeight = (xi) => density.barCrossSectionRadius(model, xi, density.barTipRadius(model))
			* density.barVerticalStretch(model, xi) * C;
		const centre = halfHeight(0);
		let best = 0;
		let bestXi = 0;
		for (let i = 1; i <= 200; i++) {
			const xi = i / 200 * 0.7;
			const h = halfHeight(xi);
			if (h > best) { best = h; bestXi = xi; }
		}
		check(`${model.type}: the bar's vertical extent does not fall off toward its ends`,
			best >= centre * 1.0005 && bestXi > 0.05,
			{ centre: +centre.toFixed(4), lobe: +best.toFixed(4), atXi: +bestXi.toFixed(3), ratio: +(best / centre).toFixed(4) });
		if (model.T <= 3) {
			check(`${model.type}: an early-type bar carries a strong boxy/peanut`,
				best >= centre * 1.10, { ratio: +(best / centre).toFixed(3) });
		}
		check(`${model.type}: the peanut never exceeds the authored body`,
			best <= C * (1 + model.bar.peanut) * 1.001,
			{ lobe: +best.toFixed(4), max: +(C * (1 + model.bar.peanut)).toFixed(4) });
	}
}

// ---- 4. observed thickness ----------------------------------------------

{
	for (const model of BARS) {
		const sp = model.spheroid;
		const A = sp.a * sp.r0;
		const rhoCentre = barProbe(model, 0, 0, 0);
		let half = sp.c * sp.r0;
		for (let i = 1; i <= 2000; i++) {
			const zeta = i / 2000;
			if (barProbe(model, 0, 0, zeta) <= 0.5 * rhoCentre) { half = zeta * sp.c * sp.r0; break; }
		}
		const ratio = half / A;
		check(`${model.type}: the bar's half-density height is bar-like (0.03-0.30 of its half-length)`,
			ratio > 0.03 && ratio < 0.30,
			{ halfDensityHeightKpc: +half.toFixed(3), halfLengthKpc: +A.toFixed(3), ratio: +ratio.toFixed(4) });
		check(`${model.type}: the bar's axis ratios are in the observed band`,
			sp.b / sp.a > 0.1 && sp.b / sp.a <= 0.7 && sp.c / sp.a > 0.05 && sp.c / sp.a <= 0.5,
			{ bOverA: +(sp.b / sp.a).toFixed(3), cOverA: +(sp.c / sp.a).toFixed(3) });
	}
}

// ---- 5. sampler vs field -------------------------------------------------

// Area-average of the bar's field over the face-on slice at height z: what a z
// histogram of the sampled stars measures.
function sliceMean(model, z, res) {
	const reach = 1.05 * model.spheroid.a * model.spheroid.r0;
	let sum = 0;
	let n = 0;
	for (let i = 0; i < res; i++) {
		const R = (i + 0.5) / res * reach;
		for (let j = 0; j < res; j++) {
			const phi = 2 * Math.PI * (j + 0.5) / res;
			sum += density.rhoSpheroid(model,
				model.centre.x + R * Math.cos(phi), model.centre.y + R * Math.sin(phi), model.centre.z + z);
			n++;
		}
	}
	return sum / n;
}

{
	// Enough stars that the *statistical* noise of a 24-bin histogram stays well
	// under the gate: the SBd bar is 2% of its galaxy by mass, so 60k stars give
	// 1.2k bulge stars and a 7% TV that is pure counting noise (measured: TV
	// falls 0.066 -> 0.030 -> 0.027 at 60k / 250k / 1M).
	const BINS = 24;
	const N = 250000;
	const buf = sampling.createBuffers(N);
	for (const model of BARS) {
		sampling.sampleGalaxyStars(model, 11, N, buf);
		const sp = model.spheroid;
		const t = sp.tiltDeg * Math.PI / 180;
		const ct = Math.cos(t);
		const st = Math.sin(t);
		const A = sp.a * sp.r0;
		const C = sp.c * sp.r0;
		const tip = density.barTipRadius(model);
		let count = 0;
		const xiHist = new Float64Array(BINS);
		const zHist = new Float64Array(BINS);
		const zMax = C * (1 + model.bar.peanut);
		for (let i = 0; i < buf.count; i++) {
			if (buf.component[i] !== density.COMPONENT_BULGE) continue;
			count++;
			const dx = buf.x[i] - model.centre.x;
			const dy = buf.y[i] - model.centre.y;
			const xi = (dx * ct + dy * st) / A;
			xiHist[Math.min(BINS - 1, Math.max(0, Math.floor((xi / tip * 0.5 + 0.5) * BINS)))]++;
			zHist[Math.min(BINS - 1, Math.floor(Math.abs(buf.z[i] - model.centre.z) / zMax * BINS))]++;
		}
		const xiRef = new Float64Array(BINS);
		let xiTotal = 0;
		for (let b = 0; b < BINS; b++) {
			const lo = -tip + 2 * tip * b / BINS;
			const hi = -tip + 2 * tip * (b + 1) / BINS;
			xiRef[b] = 0.5 * (density.barLongitudinalWeight(model, lo, tip) + density.barLongitudinalWeight(model, hi, tip)) * (hi - lo);
			xiTotal += xiRef[b];
		}
		const zRef = new Float64Array(BINS);
		let zTotal = 0;
		const STEPS = 64;
		for (let b = 0; b < BINS; b++) {
			const lo = zMax * b / BINS;
			const hi = zMax * (b + 1) / BINS;
			let sum = 0;
			for (let i = 0; i <= STEPS; i++) {
				const z = lo + (hi - lo) * i / STEPS;
				const w = (i === 0 || i === STEPS) ? 1 : (i & 1) ? 4 : 2;
				sum += w * sliceMean(model, z, 32);
			}
			zRef[b] = sum * (hi - lo) / STEPS / 3;
			zTotal += zRef[b];
		}
		const tv = (hist, ref, total, n) => {
			let sum = 0;
			for (let b = 0; b < BINS; b++) sum += Math.abs(hist[b] / Math.max(1, n) - ref[b] / Math.max(1e-12, total));
			return sum / 2;
		};
		check(`${model.type}: the sampled stars follow the bar's longitudinal profile`,
			tv(xiHist, xiRef, xiTotal, count) < 0.05,
			{ totalVariation: +tv(xiHist, xiRef, xiTotal, count).toFixed(4), stars: count });
		check(`${model.type}: the sampled stars follow the bar's vertical profile`,
			tv(zHist, zRef, zTotal, count) < 0.05,
			{ totalVariation: +tv(zHist, zRef, zTotal, count).toFixed(4) });
	}
}

// ---- report --------------------------------------------------------------

fs.mkdirSync(OUT_DIR, { recursive: true });
const failed = checks.filter((c) => !c.pass);
fs.writeFileSync(path.join(OUT_DIR, 'shape.json'), JSON.stringify({
	experiment: 'shape',
	date: new Date().toISOString().slice(0, 10),
	stepBinKpc: STEP_BIN_KPC,
	stepLimits: STEP_LIMIT,
	checks: checks.length,
	failed: failed.length,
	results: checks.map((c) => ({ name: c.name, pass: c.pass, detail: c.detail })),
}, null, 2));

for (const c of failed) console.log(`  FAIL ${c.name}  ->  ${JSON.stringify(c.detail)}`);
console.log(`${checks.length - failed.length}/${checks.length} passed, ${failed.length} failed`);
console.log(`Wrote ${path.join(OUT_DIR, 'shape.json')}`);

// ---- optional pictures ---------------------------------------------------

if (WANT_PNG) {
	for (const type of ['SBa', 'SBb', 'SBc']) {
		const model = type === 'SBb' ? MW : models[type];
		writePanels(model, path.join(OUT_DIR, `shape-${type}`));
	}
}

function writePanels(model, outBase) {
	const W = 560;
	const H = 320;
	const sp = model.spheroid;
	const A = sp.a * sp.r0;
	const C = sp.c * sp.r0;
	// One kpc per pixel scale that always frames the bar.
	const kpcPerPixel = Math.max(2.4 * A / W, 2.4 * C / H);
	const t = sp.tiltDeg * Math.PI / 180;
	const ct = Math.cos(t);
	const st = Math.sin(t);
	const c = model.centre;
	// Bar-frame -> screen. Edge-on: the major axis across, z up. Face-on: the
	// bar's own plane, major axis across, intermediate axis up.
	const project = (Xb, Yb, Zb, view) => (view === 'edge' ? [Xb, Zb] : [Xb, Yb]);
	const field = (x, y, z) => density.rhoTotal(model, c.x + x * ct - y * st, c.y + x * st + y * ct, c.z + z);

	const fieldPanels = ['edge', 'face'].map((view) => renderScalar(W, H, kpcPerPixel, view, (u, v) => {
		const [Xb, Yb, Zb] = view === 'edge' ? [u, 0, v] : [u, v, 0];
		return field(Xb, Yb, Zb);
	}));
	const N = 80000;
	const buf = sampling.sampleGalaxyStars(model, 5, N, new sampling.createBuffers(N));
	const starPanels = ['edge', 'face'].map((view) => renderStars(W, H, kpcPerPixel, view, buf, ct, st, c,
		(dx, dy, dz) => [(dx * ct + dy * st), (-dx * st + dy * ct), dz]));
	void project;
	const files = [];
	fieldPanels.concat(starPanels).forEach((ppmText, i) => {
		const f = `${outBase}-${i}.ppm`;
		fs.writeFileSync(f, ppmText);
		files.push(f);
	});
	try {
		execFileSync('convert', [files[0], files[1], '+append', `${outBase}-field.png`]);
		execFileSync('convert', [files[2], files[3], '+append', `${outBase}-stars.png`]);
		execFileSync('convert', [`${outBase}-field.png`, `${outBase}-stars.png`, '-append', `${outBase}.png`]);
		for (const f of files) fs.unlinkSync(f);
		console.log(`Wrote ${outBase}.png (field above, stars below; edge-on | face-on)`);
	} catch (e) {
		console.log(`Could not run convert (${e.message}); PPM panels kept at ${outBase}-*.ppm`);
	}
}

// An X-Y scalar panel: white(warm) = dense, log-stretched so a galaxy has a
// readable faint tail instead of one blown-out core.
function renderScalar(W, H, kpcPerPixel, view, sample) {
	const px = Buffer.alloc(W * H * 3);
	const values = new Float64Array(W * H);
	let max = 0;
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			const u = ((x + 0.5) / W - 0.5) * W * kpcPerPixel;
			const v = (0.5 - (y + 0.5) / H) * H * kpcPerPixel;
			const rho = sample(u, v);
			values[y * W + x] = rho;
			if (rho > max) max = rho;
		}
	}
	for (let i = 0; i < W * H; i++) {
		const v = max > 0 ? Math.min(1, values[i] / max) : 0;
		const s = Math.pow(v, 0.3);
		px[i * 3] = Math.min(255, s * 255);
		px[i * 3 + 1] = Math.min(255, s * 225);
		px[i * 3 + 2] = Math.min(255, s * 180);
	}
	void view;
	return ppm(W, H, px);
}

// The sampled stars, splatted additively — what the camera actually sees.
function renderStars(W, H, kpcPerPixel, view, buf, ct, st, centre, toBarFrame) {
	const acc = new Float64Array(W * H);
	for (let i = 0; i < buf.count; i++) {
		const [Xb, Yb, Zb] = toBarFrame(buf.x[i] - centre.x, buf.y[i] - centre.y, buf.z[i] - centre.z);
		const u = Xb;
		const v = view === 'edge' ? Zb : Yb;
		const px = Math.round(u / kpcPerPixel + W * 0.5);
		const py = Math.round(H * 0.5 - v / kpcPerPixel);
		if (px < 1 || px >= W - 1 || py < 1 || py >= H - 1) continue;
		for (let oy = -1; oy <= 1; oy++) {
			for (let ox = -1; ox <= 1; ox++) acc[(py + oy) * W + px + ox] += (ox === 0 && oy === 0) ? 1 : 0.3;
		}
	}
	const sorted = Float64Array.from(acc).sort();
	const max = sorted[Math.floor(sorted.length * 0.9999)] || 1;
	const px = Buffer.alloc(W * H * 3);
	for (let i = 0; i < W * H; i++) {
		const s = Math.pow(Math.min(1, acc[i] / max), 0.55) * 255;
		px[i * 3] = Math.min(255, s);
		px[i * 3 + 1] = Math.min(255, s * 0.94);
		px[i * 3 + 2] = Math.min(255, s * 0.82);
	}
	return ppm(W, H, px);
}

function ppm(W, H, px) {
	return Buffer.concat([Buffer.from(`P6\n${W} ${H}\n255\n`, 'ascii'), px]);
}
