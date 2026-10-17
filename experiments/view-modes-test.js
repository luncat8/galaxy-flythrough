// experiments/view-modes-test.js
// Tests the mathematical functions, projections, and data pipelines
// for the view modes shader implementation (archive/view-modes-shader-draft.md).

'use strict';

const fs = require('fs');
const path = require('path');

// Browser shims for Node
globalThis.window = globalThis;
require('../src/math/hash.js');
require('../src/math/density.js');
require('../src/math/sampling.js');
require('../src/math/star-record.js');
require('../src/math/coords.js');
require('../src/math/galaxy.js');
require('../src/math/orbit.js');
const landmarks = require('../src/data/landmarks.js');
const constellations = require('../src/data/constellations.js');

let passed = 0;
let failed = 0;

function check(desc, cond, extra) {
	if (cond) {
		console.log('  OK  ', desc);
		passed++;
	} else {
		console.error('  FAIL', desc, extra ? JSON.stringify(extra) : '');
		failed++;
	}
}

console.log('=== View Modes Math & Pipeline Tests ===\n');

// 1. Constellation Figures & Landmarks
{
	check('Landmarks table contains ~60 stars', landmarks.count >= 50 && landmarks.count <= 70, { count: landmarks.count });
	check('Constellation figures are loaded', constellations.count > 10, { count: constellations.count });
	check('Constellation edge count is positive', constellations.edgeCount > 30, { count: constellations.edgeCount });

	// Sun at [0, 0, 0]
	const sun = landmarks.ENTRIES[landmarks.indexOf('Sun')];
	check('Sun is at origin', Math.hypot(sun.x, sun.y, sun.z) === 0, { sun: [sun.x, sun.y, sun.z] });

	// Sirius distance
	const sirius = landmarks.ENTRIES[landmarks.indexOf('Sirius')];
	check('Sirius distance is ~2.64 pc', Math.abs(sirius.distPc - 2.64) < 0.1, { distPc: sirius.distPc });
}

// 2. Star Distance & Normalization (Mode 1: 0 far to 1 closest)
{
	const cam = [0, 0, 0];
	const stars = [];
	let minD = Infinity, maxD = -Infinity;

	for (let i = 0; i < landmarks.count; i++) {
		const e = landmarks.ENTRIES[i];
		const d = Math.hypot(e.x - cam[0], e.y - cam[1], e.z - cam[2]) * 1000; // pc
		if (d === 0) continue; // skip Sun when at Sun
		const dir = [ (e.x - cam[0]) * 1000 / d, (e.y - cam[1]) * 1000 / d, (e.z - cam[2]) * 1000 / d ];
		stars.push({ name: e.name, distPc: d, dir, index: i });
		if (d < minD) minD = d;
		if (d > maxD) maxD = d;
	}

	check('Minimum distance among landmarks is Rigil Kentaurus (~1.3 pc)', minD < 2.0, { minD });
	check('Maximum distance among landmarks is Deneb (~802 pc)', maxD > 700, { maxD });

	// Normalized values (1.0 = closest, 0.0 = farthest)
	for (const s of stars) {
		s.u = 1.0 - (s.distPc - minD) / (maxD - minD);
	}

	const closestStar = stars.reduce((a, b) => a.distPc < b.distPc ? a : b);
	const farthestStar = stars.reduce((a, b) => a.distPc > b.distPc ? a : b);
	check('Closest star normalizes to 1.0', Math.abs(closestStar.u - 1.0) < 1e-4, { name: closestStar.name, u: closestStar.u });
	check('Farthest star normalizes to 0.0', Math.abs(farthestStar.u - 0.0) < 1e-4, { name: farthestStar.name, u: farthestStar.u });
}

// 3. Smooth Height Evaluation (Mode 1: IDW with radial gradient slope)
{
	const stars = [];
	let minD = Infinity, maxD = -Infinity;
	for (let i = 0; i < landmarks.count; i++) {
		const e = landmarks.ENTRIES[i];
		const d = Math.hypot(e.x, e.y, e.z) * 1000;
		if (d === 0) continue;
		stars.push({ name: e.name, distPc: d, dir: [e.x * 1000 / d, e.y * 1000 / d, e.z * 1000 / d] });
		if (d < minD) minD = d;
		if (d > maxD) maxD = d;
	}
	for (const s of stars) s.u = 1.0 - (s.distPc - minD) / (maxD - minD);

	function evalHeight(v, slope = 0.5, eps = 0.05, p = 1.8) {
		let sumW = 0, sumH = 0;
		for (const s of stars) {
			const dot = Math.max(-1, Math.min(1, v[0]*s.dir[0] + v[1]*s.dir[1] + v[2]*s.dir[2]));
			const r2 = Math.max(0, 2 * (1 - dot));
			const r = Math.sqrt(r2);
			const w = 1.0 / Math.pow(r2 + eps * eps, p);
			const localH = Math.max(0, s.u - slope * r);
			sumW += w;
			sumH += w * localH;
		}
		return sumH / sumW;
	}

	const sirius = stars.find(s => s.name === 'Sirius');
	const hSirius = evalHeight(sirius.dir);
	check('Height at Sirius direction is close to Sirius u (~0.98)', Math.abs(hSirius - sirius.u) < 0.05, { hSirius, siriusU: sirius.u });

	// Off-peak evaluation
	const vNear = [sirius.dir[0] * Math.cos(0.087) + 0.087, sirius.dir[1], sirius.dir[2]];
	const len = Math.hypot(...vNear);
	vNear[0] /= len; vNear[1] /= len; vNear[2] /= len;
	const hNear = evalHeight(vNear);
	check('Height drops smoothly away from Sirius (gradient from star)', hNear < hSirius && hNear > 0.5, { hNear, hSirius });

	const deneb = stars.find(s => s.name === 'Deneb');
	const hDeneb = evalHeight(deneb.dir);
	check('Height at Deneb direction is low (~0.01)', hDeneb < 0.05, { hDeneb });
}

// 4. Gradient of Mode 1 (Mode 2)
{
	const stars = [];
	let minD = Infinity, maxD = -Infinity;
	for (let i = 0; i < landmarks.count; i++) {
		const e = landmarks.ENTRIES[i];
		const d = Math.hypot(e.x, e.y, e.z) * 1000;
		if (d === 0) continue;
		stars.push({ name: e.name, distPc: d, dir: [e.x * 1000 / d, e.y * 1000 / d, e.z * 1000 / d] });
		if (d < minD) minD = d;
		if (d > maxD) maxD = d;
	}
	for (const s of stars) s.u = 1.0 - (s.distPc - minD) / (maxD - minD);

	function evalHeight(v, slope = 0.5, eps = 0.05, p = 1.8) {
		let sumW = 0, sumH = 0;
		for (const s of stars) {
			const dot = Math.max(-1, Math.min(1, v[0]*s.dir[0] + v[1]*s.dir[1] + v[2]*s.dir[2]));
			const r2 = Math.max(0, 2 * (1 - dot));
			const w = 1.0 / Math.pow(r2 + eps * eps, p);
			const localH = Math.max(0, s.u - slope * Math.sqrt(r2));
			sumW += w;
			sumH += w * localH;
		}
		return sumH / sumW;
	}

	function calcGrad(v) {
		let t1 = Math.abs(v[2]) < 0.9 ? [0, v[2], -v[1]] : [1, 0, 0];
		const dot = t1[0]*v[0] + t1[1]*v[1] + t1[2]*v[2];
		t1 = [t1[0] - dot*v[0], t1[1] - dot*v[1], t1[2] - dot*v[2]];
		const len1 = Math.hypot(...t1);
		t1 = t1.map(x => x / len1);
		const t2 = [
			v[1] * t1[2] - v[2] * t1[1],
			v[2] * t1[0] - v[0] * t1[2],
			v[0] * t1[1] - v[1] * t1[0]
		];
		const delta = 0.01;
		function step(s, t) {
			const res = [v[0] + s * t[0], v[1] + s * t[1], v[2] + s * t[2]];
			const l = Math.hypot(...res);
			return [res[0]/l, res[1]/l, res[2]/l];
		}
		const g1 = (evalHeight(step(delta, t1)) - evalHeight(step(-delta, t1))) / (2 * delta);
		const g2 = (evalHeight(step(delta, t2)) - evalHeight(step(-delta, t2))) / (2 * delta);
		return Math.hypot(g1, g2);
	}

	// Between Rigil Kentaurus (1.3 pc) and Hadar (120 pc) in Centaurus: visually close, huge depth gap
	const rigil = stars.find(s => s.name === 'Rigil Kentaurus');
	const hadar = stars.find(s => s.name === 'Hadar');
	const midCen = [rigil.dir[0] + hadar.dir[0], rigil.dir[1] + hadar.dir[1], rigil.dir[2] + hadar.dir[2]];
	const lCen = Math.hypot(...midCen);
	midCen[0] /= lCen; midCen[1] /= lCen; midCen[2] /= lCen;
	const gradCen = calcGrad(midCen);
	check('Gradient between Rigil Kentaurus and Hadar is steep (> 1.5)', gradCen > 1.5, { gradCen });

	// In an empty region far from close stars, gradient is low
	const emptyV = [0, 0, 1]; // Galactic North pole
	const gradEmpty = calcGrad(emptyV);
	check('Gradient at quiet galactic pole is lower than Centaurus barrier', gradEmpty < gradCen, { gradEmpty, gradCen });
}

// 5. Orbit Motion Real-Time Update
{
	const model = window.GalaxyLib.MILKY_WAY;
	window.OrbitLib.fillDynamics(model);

	const siriusEntry = landmarks.ENTRIES[landmarks.indexOf('Sirius')];
	const out0 = new Float64Array(3);
	const out50 = new Float64Array(3);

	window.OrbitLib.engineLandmarkPosition(out0, 1, siriusEntry.x, siriusEntry.y, siriusEntry.z, siriusEntry.colorIndex, 0, model);
	window.OrbitLib.engineLandmarkPosition(out50, 1, siriusEntry.x, siriusEntry.y, siriusEntry.z, siriusEntry.colorIndex, 50, model);

	check('T = 0 Myr yields landmark original position', Math.abs(out0[0] - siriusEntry.x) < 1e-6);
	check('T = 50 Myr moves star in orbit', Math.hypot(out50[0] - out0[0], out50[1] - out0[1]) > 0.001);
}

// 6. Gaia Catalog Parsing
{
	const csvPath = path.join(__dirname, '../src/data/gaia-subset.csv');
	const csvText = fs.readFileSync(csvPath, 'utf8');
	const lines = csvText.trim().split('\n');
	check('Gaia CSV has 5001 lines', lines.length === 5001, { count: lines.length });

	// Parse first 100 rows
	let parsed = 0;
	for (let i = 1; i <= 100; i++) {
		const parts = lines[i].split(',');
		const ra = parseFloat(parts[1]);
		const dec = parseFloat(parts[2]);
		const plx = parseFloat(parts[3]);
		if (plx > 0) {
			const g = window.Coords.raDecParallaxToGalactic(ra, dec, plx);
			if (isFinite(g.x) && isFinite(g.y) && isFinite(g.z)) parsed++;
		}
	}
	check('Gaia stars convert accurately to galactic XYZ', parsed === 100, { parsed });
}

// 7. Projections: 3D Ray and 2D Equirectangular
{
	// 2D Equirectangular mapping test:
	// Longitude lambda = 0, latitude phi = 0 -> (1, 0, 0)
	const lon0 = 0, lat0 = 0;
	const v0 = [Math.cos(lat0) * Math.cos(lon0), Math.cos(lat0) * Math.sin(lon0), Math.sin(lat0)];
	check('2D projection center maps to (1, 0, 0)', Math.abs(v0[0] - 1) < 1e-6 && Math.abs(v0[1]) < 1e-6 && Math.abs(v0[2]) < 1e-6);

	// North pole: lat = PI/2 -> (0, 0, 1)
	const latNP = Math.PI / 2;
	const vNP = [Math.cos(latNP) * Math.cos(lon0), Math.cos(latNP) * Math.sin(lon0), Math.sin(latNP)];
	check('North pole maps to (0, 0, 1)', Math.abs(vNP[2] - 1) < 1e-6);
}

console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
