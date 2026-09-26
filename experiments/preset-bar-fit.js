// experiments/preset-bar-fit.js
// Study for 0.4.8 M2: authoring numbers for the Milky Way preset's central
// component — the slice-profile bar that replaces the triaxial Plummer.
//
// Observed targets (0.4.8 plan §2, Wegg & Gerhard 2013 via Wegg 2014):
//   axis exponential scale lengths 0.70 : 0.44 : 0.18 kpc,
//   bar angle 27–29 deg, B/P half-length ~2.2–2.5 kpc,
//   bulge mass = the Plummer's massIntegrals (the component it replaces).
//
// The bounded slice family has no exponential tails, so the three scale
// lengths are matched by construction where the family has the knob:
//   x: endCap * a is the exponential rate past the plateau (the L profile IS
//      an exponential there, so the scale is exact, not fitted),
//   y: half-density width = ln2 * 0.44  (an exponential with scale 0.44 has
//      that half-density width; solved for b by bisection on the field),
//   z: half-density height = ln2 * 0.18 (solved for c the same way).
// The amplitude is then whatever the mass target needs.
//
// Output: experiments/logs/preset-bar-fit.json

'use strict';

const fs = require('fs');
const path = require('path');
const density = require('../src/math/density.js');
const galaxy = require('../src/math/galaxy.js');

// The Plummer the preset ships today, and the mass it must hand over: the
// amp-multiplied component mass (the solve convention matches B/T on the
// untruncated integrals, so the untruncated Plummer mass is the target).
const plummer = galaxy.MILKY_WAY;
const targetMass = density.componentMasses(plummer).bulge;

// The authored shape: half-length 2.3 kpc, boxiness / peanut / plateau /
// vertical at the SBb stage anchors (the preset is an SBb), the longitudinal
// cap from the observed 0.70 kpc scale. b and c start from the analytic
// half-density prediction and get bisected on the actual field.
const a = 2.3;
const n = 3.5;
const shape = {
	profile: 'bar', profileId: density.PROFILE_BAR,
	a, b: 0.405, c: 0.19, r0: 1.0, n, amp: 1, tiltDeg: 27,
};
const bar = { peanut: 0.45, endCap: 0.70 / a, plateau: 0.55, vertical: 2.40 };

function buildModel(spheroid, barShape) {
	const model = galaxy.createGalaxy({ type: 'SBb' });
	model.spheroid = Object.assign({}, spheroid, { profileId: density.PROFILE_BAR });
	model.bar = Object.assign({}, barShape);
	return model;
}

// rho along a principal axis of the tilted bar frame, in units of the central
// density (the slice at u=v=0 is 1, so the peak is exactly amp on all three).
function axisProfile(model, axis) {
	const c = model.centre;
	const t = model.spheroid.tiltDeg * Math.PI / 180;
	const ux = axis === 'x' ? Math.cos(t) : axis === 'y' ? -Math.sin(t) : 0;
	const uy = axis === 'x' ? Math.sin(t) : axis === 'y' ? Math.cos(t) : 0;
	const uz = axis === 'z' ? 1 : 0;
	return (s) => density.rhoSpheroid(model,
		c.x + ux * s, c.y + uy * s, c.z + uz * s) / model.spheroid.amp;
}

// Sign-agnostic bisection: f is monotone, f(lo) and f(hi) bracket the root.
function bisect(f, lo, hi) {
	const fLo = f(lo);
	for (let i = 0; i < 80; i++) {
		const mid = (lo + hi) / 2;
		if ((f(mid) < 0) === (fLo < 0)) lo = mid; else hi = mid;
	}
	return (lo + hi) / 2;
}

const LN2 = Math.log(2);

// Solve b for half-density width ln2*0.44 and c for half-density height
// ln2*0.18, on the real field.
function solveAxis(start, targetHmd, axis) {
	const model = buildModel(Object.assign({}, shape, axis === 'y' ? { b: start } : { c: start }), bar);
	const profile = axisProfile(model, axis);
	const hmd = bisect((t) => profile(t) - 0.5, 1e-6, Math.max(shape.b, shape.c) * 2.5);
	return { hmd, scale: hmd / LN2, next: start * (targetHmd / hmd) };
}

let b = shape.b;
let c = shape.c;
const Y_TARGET = 0.44 * LN2;
const Z_TARGET = 0.18 * LN2;
for (let i = 0; i < 12; i++) {
	const y = solveAxis(b, Y_TARGET, 'y');
	const z = solveAxis(c, Z_TARGET, 'z');
	b = y.next;
	c = z.next;
}
shape.b = +b.toFixed(4);
shape.c = +c.toFixed(4);

// Re-solve once more with the rounded values for the report.
const model = buildModel(shape, bar);
const amp = targetMass / density.massIntegrals(model).bulge;   // amp-free S
shape.amp = +amp.toFixed(3);
const solved = buildModel(shape, bar);

// Measurements on the solved shape.
const profY = axisProfile(solved, 'y');
const profZ = axisProfile(solved, 'z');
const hmdY = bisect((t) => profY(t) - 0.5, 1e-6, shape.b * 2.5);
const hmdZ = bisect((t) => profZ(t) - 0.5, 1e-6, shape.c * 2.5);

// Least-squares exponential fit over rho in [0.5, 0.05] of peak — the honest
// "what does an observer fit" number, reported alongside the exact knobs.
// Slope of the ln(rho) vs t regression; the scale is -1/slope.
function fitScale(profile, hi, lo) {
	let sX = 0, sY = 0, sXX = 0, sXY = 0, count = 0;
	const steps = 2000;
	for (let i = 0; i <= steps; i++) {
		const t = hi + (lo - hi) * i / steps;
		const rho = profile(t);
		if (rho > 0.5 || rho < 0.05) continue;
		sX += t; sY += Math.log(rho); sXX += t * t; sXY += t * Math.log(rho);
		count++;
	}
	const slope = (count * sXY - sX * sY) / (count * sXX - sX * sX);
	return -1 / slope;
}

// Mass split and the report.
const masses = density.componentMasses(solved);
const oldMasses = density.componentMasses(plummer);
const fractions = density.truncationFractions(solved);
const oldFractions = density.truncationFractions(plummer);

// Half-mass extent along the bar (the longitudinal CDF the sampler uses).
const totalLong = density.barLongitudinalIntegral(solved, 1);
const halfLong = bisect((t) => density.barEnclosedMassFraction(solved, t) - 0.5, 1e-6, 1);

// Pattern speed and loop ratio, old against new.
const omegaOld = plummer.dynamics.omegaPattern;
const newExtent = density.barTipRadius(solved);
const omegaNew = (1 - 1 / Math.SQRT2) * (solved.dynamics.vFlat /
	Math.max(solved.spheroid.a * solved.spheroid.r0 * newExtent, solved.dynamics.rCore));

const report = {
	target: {
		plummerBulgeMass: +targetMass.toFixed(4),
		scaleKpc: [0.70, 0.44, 0.18],
		halfLengthKpc: [2.2, 2.5],
		tiltDeg: [27, 29],
	},
	authored: {
		spheroid: shape,
		bar,
	},
	measured: {
		bulgeMass: +density.componentMasses(solved).bulge.toFixed(4),
		massDriftPct: +(100 * (density.componentMasses(solved).bulge / targetMass - 1)).toFixed(3),
		hmdY: +hmdY.toFixed(4),
		hmdZ: +hmdZ.toFixed(4),
		hmdTargetY: +Y_TARGET.toFixed(4),
		hmdTargetZ: +Z_TARGET.toFixed(4),
		edgeFitY: +fitScale(profY, 0, shape.b * 2).toFixed(3),
		edgeFitZ: +fitScale(profZ, 0, shape.c * 2).toFixed(3),
		longitudinalScaleKpc: +(bar.endCap * a).toFixed(3),
		longitudinalHalfDensityKpc: +((bar.plateau + bar.endCap * LN2) * a).toFixed(3),
		halfMassXikpc: +(halfLong * a).toFixed(3),
		ridgeDensityAtTip: +density.barLongitudinalProfile(solved, 1).toFixed(4),
		loopRatioBA: +(shape.b / shape.a).toFixed(4),
		omegaPatternOld: +omegaOld.toFixed(6),
		omegaPatternNew: +omegaNew.toFixed(6),
		truncationBulge: +fractions.bulge.toFixed(5),
		truncationBulgeOld: +oldFractions.bulge.toFixed(5),
		componentMasses: Object.fromEntries(Object.entries(masses).map(([k, v]) => [k, +v.toFixed(4)])),
		componentMassesOld: Object.fromEntries(Object.entries(oldMasses).map(([k, v]) => [k, +v.toFixed(4)])),
		bulgeShareOld: +(oldMasses.bulge / oldMasses.total).toFixed(4),
		bulgeShareNew: +(masses.bulge / masses.total).toFixed(4),
	},
};

console.log(JSON.stringify(report, null, 2));
fs.mkdirSync(path.join(__dirname, 'logs'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'logs/preset-bar-fit.json'), JSON.stringify(report, null, 2) + '\n');
