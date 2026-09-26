// experiments/truncation-edge.js
// 0.4.8 M3.1 study: how visible is each truncation edge, and what would it
// cost to remove it?
//
// The field is cut in three places: the disc at |z| = discHeight and
// R = discRadius, the spheroid at s = spheroidRadius, the halo at rMax. Each
// cut is a discontinuity — the shape gate measures them as steps; this script
// measures how *bright* they are and what moving or softening them would cost:
//
//   contrastLocal  drop / value just inside — 1.0 means the whole density
//                  there disappears (true for the disc, which dominates its
//                  own edge)
//   ofColumn       drop / the density at the midplane of the same column (for
//                  the disc) or at s = 1 (for the spheroid): the reference the
//                  eye has *in the same view*, so this is the number that says
//                  whether an edge-on frame shows the cut
//   ofPeak         drop / the model's central density: the HDR-frame number
//   massOutside    the mass fraction the cut removes
//
// and, for each cut, the position that would push `ofColumn` under a target,
// with the mass and volume that costs.
//
// Output: experiments/logs/truncation-edge.json

'use strict';

const fs = require('fs');
const path = require('path');

const density = require('../src/math/density.js');
const galaxy = require('../src/math/galaxy.js');

const TARGET = 1e-3;          // wanted: an edge below 0.1% of its own column
const TYPES = galaxy.GALAXY_TYPES.filter((t) => t !== galaxy.MILKY_WAY_TYPE);
const MODELS = [galaxy.MILKY_WAY].concat(TYPES.map((t) => galaxy.createGalaxy({ type: t, seed: 42 })));
const EPS = 1e-6;

function rho(model, x, y, z) { return density.rhoTotal(model, x, y, z); }

// --- the disc's vertical cut ------------------------------------------------
// Probed on the +x axis at a few radii inside the disc. The arm factor is
// whatever the azimuth gives; the ratio is taken at a fixed (x, y), so it
// divides out.
function verticalEdge(model) {
	const t = model.truncation;
	if (!(model.thin.amp > 0 || model.thick.amp > 0)) return null;
	const radii = [0.5, 2, 4, 8, 12, 16, 20].filter((R) => R < t.discRadius);
	// Probed at the component's real cut (0.4.8 M3.1), which is the authored
	// slab or the profile's own floor height, whichever is farther out. The
	// thick disc reaches highest, so it is the edge worth measuring.
	const rows = radii.map((R) => {
		const x = model.centre.x + R;
		const zCut = Math.max(
			density.discVerticalCut(model, model.thin, R, 'sech2'),
			density.discVerticalCut(model, model.thick, R, 'laplace'));
		const inside = rho(model, x, model.centre.y, model.centre.z + zCut - EPS);
		const outside = rho(model, x, model.centre.y, model.centre.z + zCut + EPS);
		const mid = rho(model, x, model.centre.y, model.centre.z);
		const drop = inside - outside;
		return {
			R,
			ofColumn: mid > 0 ? drop / mid : 0,
			contrastLocal: inside > 0 ? drop / inside : 0,
			inside: +inside.toExponential(3),
		};
	});
	const worst = rows.reduce((a, b) => (b.ofColumn > a.ofColumn ? b : a));
	// Where the same ratio falls under the target, on the worst column. The
	// cut has to be searched on the *untruncated* profile — past the cut the
	// field is 0 by construction, which is the edge being measured.
	const profile = (R, z) => {
		const thinH = density.discHeightAt(model.thin, R);
		const thickH = density.discHeightAt(model.thick, R);
		const e = Math.exp(-Math.abs(z) / thinH);
		const sech2 = 4 * e / ((1 + e) * (1 + e));
		return model.thin.amp * density.discRadialFactor(model.thin, R) * sech2
			+ model.thick.amp * density.discRadialFactor(model.thick, R) * Math.exp(-Math.abs(z) / thickH);
	};
	const mid = profile(worst.R, 0);
	let z = 0;
	while (z < 40 && profile(worst.R, z) / mid > TARGET) z += 0.05;
	// Mass the present cut leaves out, and what the target cut would leave out.
	const f = density.truncationFractions(model);
	const at = (zMax) => {
		const thin = density.integrateDiscRadial(model.thin, t.discRadius, zMax, 'sech2')
			/ density.integrateDiscRadial(model.thin, Infinity, Infinity, 'sech2');
		const thick = density.integrateDiscRadial(model.thick, t.discRadius, zMax, 'laplace')
			/ density.integrateDiscRadial(model.thick, Infinity, Infinity, 'laplace');
		return { thin: +thin.toFixed(5), thick: +thick.toFixed(5) };
	};
	return { rows, worst, mid: +mid.toExponential(3), zForTarget: +z.toFixed(2),
		massInside: { thin: +f.thin.toFixed(5), thick: +f.thick.toFixed(5) },
		massInsideAtTarget: at(z) };
}

// --- the disc's radial cut --------------------------------------------------
function radialEdge(model) {
	const t = model.truncation;
	if (!(model.thin.amp > 0 || model.thick.amp > 0)) return null;
	const cut = density.discRadialCut(model);
	const inside = rho(model, model.centre.x + cut - EPS, model.centre.y, model.centre.z);
	const outside = rho(model, model.centre.x + cut + EPS, model.centre.y, model.centre.z);
	const mid = rho(model, model.centre.x + 0.5 * model.thin.L, model.centre.y, model.centre.z);
	return {
		cut: +cut.toFixed(2),
		ofColumn: +((inside - outside) / mid).toExponential(2),
		contrastLocal: +(inside > 0 ? (inside - outside) / inside : 0).toFixed(3),
	};
}

// --- the spheroid's cut -----------------------------------------------------
// Probed along the spheroid's own major axis, so `s` is the world distance
// divided by a*r0. The reference is the density at s = 1 (the effective
// radius for Sérsic, the Plummer core radius) — the body's own bright part.
function spheroidEdge(model) {
	const sp = model.spheroid;
	if (!(sp.amp > 0) || sp.profileId === density.PROFILE_BAR) return null;
	const sMax = model.truncation.spheroidRadius;
	const tilt = sp.tiltDeg * Math.PI / 180;
	const at = (s) => {
		const d = s * sp.a * sp.r0;
		return rho(model, model.centre.x + d * Math.cos(tilt), model.centre.y + d * Math.sin(tilt), model.centre.z);
	};
	// The untruncated profile: past the cut the field is 0, and the cut is
	// what is being measured.
	const only = (s) => (sp.profileId === density.PROFILE_SERSIC
		? Math.exp(-density.sersicBn(sp.n) * (Math.pow(s, 1 / sp.n) - 1))
		: Math.pow(1 + s * s, -2.5));
	const inside = at(sMax - EPS);
	const outside = at(sMax + EPS);
	const ref = at(1);
	const drop = inside - outside;
	// Where the spheroid's own density falls under the target of its s = 1 value.
	let s = sMax;
	const refOnly = only(1);
	const kpcPerS = sp.a * sp.r0;
	while (s < 200 && only(s) / refOnly > TARGET) s += 0.05;
	const massAt = (sEnd) => {
		if (sp.profileId !== density.PROFILE_SERSIC) return Math.pow(sEnd, 3) / Math.pow(1 + sEnd * sEnd, 1.5);
		const m = density.sersicMassFraction({ spheroid: sp }, sEnd);
		const full = density.sersicMassFraction({ spheroid: sp }, 1e4);
		return m / full;
	};
	return {
		profile: sp.profileId === density.PROFILE_SERSIC ? `sersic n=${sp.n}` : 'plummer',
		sMax,
		ofColumn: +(ref > 0 ? drop / ref : 0).toExponential(2),
		contrastLocal: +(inside > 0 ? drop / inside : 0).toFixed(3),
		massInside: +massAt(sMax).toFixed(5),
		sForTarget: +s.toFixed(2),
		kpcNow: +(sMax * kpcPerS).toFixed(2),
		kpcAtTarget: +(s * kpcPerS).toFixed(2),
		massInsideAtTarget: +massAt(s).toFixed(5),
	};
}

// --- the halo's cut ---------------------------------------------------------
function haloEdge(model) {
	const h = model.halo;
	if (!(h.amp > 0)) return null;
	const inside = rho(model, model.centre.x + h.rMax - EPS, model.centre.y, model.centre.z);
	const outside = rho(model, model.centre.x + h.rMax + EPS, model.centre.y, model.centre.z);
	const ref = rho(model, model.centre.x + h.a_h, model.centre.y, model.centre.z);
	return { ofColumn: +((inside - outside) / ref).toExponential(2), rMax: h.rMax };
}

const report = {};
for (const model of MODELS) {
	report[model.type] = {
		truncation: model.truncation,
		vertical: verticalEdge(model),
		radial: radialEdge(model),
		spheroid: spheroidEdge(model),
		halo: haloEdge(model),
	};
}

// --- summary ----------------------------------------------------------------
const lines = [];
lines.push('cut                      worst type   ofColumn   would need');
function worstOf(pick, label, need) {
	let worst = null;
	for (const type of Object.keys(report)) {
		const entry = pick(report[type]);
		if (!entry) continue;
		const v = entry.worst ? entry.worst.ofColumn : entry.ofColumn;
		if (!worst || v > worst.v) worst = { type, v, entry };
	}
	if (!worst) return;
	lines.push(`${label.padEnd(24)} ${worst.type.padEnd(12)} ${worst.v.toExponential(2).padEnd(10)} ${need(worst.entry)}`);
}
worstOf((r) => r.vertical, 'disc vertical cut', (e) => `|z| = ${e.zForTarget} kpc`);
worstOf((r) => r.radial, 'disc radial cut', (e) => `R = ${e.cut} kpc`);
worstOf((r) => r.spheroid, 'spheroid cut', (e) => `s = ${e.sForTarget} (mass ${e.massInside} → ${e.massInsideAtTarget})`);
worstOf((r) => r.halo, 'halo rMax', (e) => `r = ${e.rMax} kpc`);

for (const line of lines) console.log(line);
console.log('\nper-type detail in experiments/logs/truncation-edge.json');
fs.mkdirSync(path.join(__dirname, 'logs'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'logs/truncation-edge.json'),
	JSON.stringify({ target: TARGET, summary: lines, report }, null, 2) + '\n');
