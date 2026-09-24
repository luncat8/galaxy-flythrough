// experiments/damping-formula-check.js
// Study, not a pass/fail test. Compares the shipped capture
// (orbit.dampedDiscTheta) to an Euler integration of the ODE it claims to
// solve, and prints the sampler-weighted arm cosine the page default was
// picked from. A residual that falls as the step shrinks is Euler error,
// not a reason to retune the closed form.
//
//   node experiments/damping-formula-check.js

'use strict';

const fs = require('fs');
const path = require('path');
const orbit = require('../src/math/orbit.js');

const TAU = orbit.TAU;
const INV_TAU = 1 / TAU;

function fract(x) { return x - Math.floor(x); }
function wrap(x) { return TAU * fract(x * INV_TAU); }
function angDiff(a, b) {
	const d = fract((a - b) * INV_TAU + 0.5) - 0.5;
	return Math.abs(d * TAU);
}
function reducePi(x) { return x - TAU * Math.floor((x + Math.PI) * INV_TAU); }

function closed(theta0, thetaArm, omega, omegaP, time, alpha, m) {
	return wrap(orbit.dampedDiscTheta(theta0, thetaArm, omega, omegaP, time, alpha, m));
}

function integrate(theta0, thetaArm, omega, omegaP, time, alpha, m, steps) {
	let chi = reducePi(m * (theta0 - thetaArm));
	const chi0 = chi;
	const omegaRel = omega - omegaP;
	const dt = time / steps;
	for (let i = 0; i < steps; i++) {
		const s = Math.sin(chi * 0.5);
		chi += alpha * m * omegaRel * s * s * dt;
	}
	return wrap((chi - chi0) / m + omegaP * time);
}

const radii = [1.2, 2.5, 5.2, 8.2, 12, 18];
const vFlat = 0.225, rCore = 0.5, omegaP = 0.043;
let worst = 0, info = null, n = 0;
for (const R of radii) {
	const omega = vFlat / Math.max(R, rCore);
	for (const alpha of [0.15, 0.4, 0.7, 1]) {
		for (let k = 0; k < 12; k++) {
			const theta0 = k / 12 * TAU;
			for (const time of [0, 1, 20, 80, 200, 600, 2000]) {
				const a = closed(theta0, 0.4, omega, omegaP, time, alpha, 2);
				const b = integrate(theta0, 0.4, omega, omegaP, time, alpha, 2, Math.max(50, time * 80));
				const d = angDiff(a, b);
				n++;
				if (d > worst) { worst = d; info = { R, alpha, theta0, time, closed: a, euler: b, d }; }
			}
		}
	}
}

// The reported 0.00264 rad gap was this comparison. Refine the worst case.
const refined = [];
if (info) {
	const omega = vFlat / Math.max(info.R, rCore);
	for (const steps of [info.time * 80, info.time * 320, info.time * 1280]) {
		const b = integrate(info.theta0, 0.4, omega, omegaP, info.time, info.alpha, 2, Math.max(50, steps));
		refined.push({ steps: Math.max(50, steps), residual: angDiff(info.closed, b) });
	}
}

function weightedCos(R, alpha, time, count) {
	const omega = 0.225 / Math.max(R, 0.5);
	const pattern = 0.043, m = 2, amp = 0.2, thetaArm = 0.3;
	let wsum = 0, csum = 0;
	for (let i = 0; i < count; i++) {
		const theta0 = (i + 0.5) / count * TAU;
		const w = 1 + amp * Math.cos(m * (theta0 - thetaArm));
		const rot = alpha === 0
			? omega * time
			: closed(theta0, thetaArm, omega, pattern, time, alpha, m);
		const chi = reducePi(m * (theta0 + rot - thetaArm - pattern * time));
		wsum += w;
		csum += w * Math.cos(chi);
	}
	return csum / wsum;
}

const times = [0, 40, 80, 160, 320, 640, 1200];
const cosine = {};
for (const R of [3, 8.2, 14]) {
	cosine[R] = {};
	for (const alpha of [0, 0.25, 0.5, 0.7, 1]) {
		cosine[R][alpha] = times.map(t => Number(weightedCos(R, alpha, t, 720).toFixed(3)));
	}
}

const report = {
	date: new Date().toISOString(),
	samples: n,
	worstResidualRad: worst,
	worstCase: info,
	refined,
	note: 'A residual that falls with the step count is Euler truncation. Do not retune the closed form.',
	weightedArmCosine: { times, byRadius: cosine },
};
console.log(JSON.stringify(report, null, 2));
const logPath = path.join(__dirname, 'logs', 'damping-formula.json');
fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.writeFileSync(logPath, JSON.stringify(report, null, 2) + '\n');
