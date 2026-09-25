// experiments/orbit-trace.js
// Diagnostic study: draw what the star-motion law actually does, so a "the
// stars orbit the wrong thing" report can be answered with an image instead of
// an opinion. Renders additive scatter/trace views of a sampled field:
//
//   face  — top-down on the disc plane (x right, y up), the galactic centre at
//           the image centre. Star paths must be closed rosettes about it.
//   edge  — x right, z up: the same paths seen from inside the plane. A disc
//           star must stay within a few scale heights of z = 0.
//
// Star selection and per-star jitter follow star-sprites.js exactly (same
// seed, same family rule), and the law is orbit.js — the shipped CPU mirror of
// the WGSL.
//
// Usage:
//   node experiments/orbit-trace.js [--type SBb] [--engine classic]
//       [--seed 42] [--stars 4000] [--trails 60] [--span 400] [--view face]
//       [--out experiments/logs/orbit-trace]
// Writes <out>-<type>-<engine>-<view>.png (via PPM + ImageMagick `convert`).

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const galaxy = require('../src/math/galaxy.js');
const sampling = require('../src/math/sampling.js');
const starTypes = require('../src/math/star-types.js');
const orbit = require('../src/math/orbit.js');

function arg(name, fallback) {
	const i = process.argv.indexOf('--' + name);
	if (i < 0) return fallback;
	const value = process.argv[i + 1];
	return value === undefined || value.startsWith('--') ? true : value;
}

const TYPE = String(arg('type', 'SBb'));
const ENGINE = String(arg('engine', 'classic'));
const SEED = Number(arg('seed', 42));
const STARS = Number(arg('stars', 6000));
const TRAILS = Number(arg('trails', 48));
const SPAN = Number(arg('span', 400));        // Myr of trail time
const T_STEPS = Number(arg('steps', 80));
const VIEW = String(arg('view', 'face'));
const OUT = String(arg('out', 'experiments/logs/orbit-trace'));
const W = Number(arg('width', 1100));
const H = Number(arg('height', 900));

// ---- canvas -------------------------------------------------------------
const img = new Float32Array(W * H * 3);
function clear() { img.fill(0); }
function splat(px, py, r, g, b, gain) {
	const x0 = Math.max(0, Math.floor(px - 2)), x1 = Math.min(W - 1, Math.ceil(px + 2));
	const y0 = Math.max(0, Math.floor(py - 2)), y1 = Math.min(H - 1, Math.ceil(py + 2));
	for (let y = y0; y <= y1; y++) {
		for (let x = x0; x <= x1; x++) {
			const dx = x - px, dy = y - py;
			const w = Math.exp(-(dx * dx + dy * dy) * 2.0) * gain;
			const i = (y * W + x) * 3;
			img[i] += r * w; img[i + 1] += g * w; img[i + 2] += b * w;
		}
	}
}
function writePng(file) {
	const header = Buffer.from(`P6\n${W} ${H}\n255\n`, 'ascii');
	const body = Buffer.alloc(W * H * 3);
	for (let i = 0; i < img.length; i++) {
		const v = img[i];
		body[i] = v <= 0 ? 0 : (v >= 1 ? 255 : Math.round(Math.pow(v, 0.45) * 255));
	}
	const ppm = path.join('/tmp', path.basename(file) + '.ppm');
	fs.writeFileSync(ppm, Buffer.concat([header, body]));
	execFileSync('convert', [ppm, file]);
	fs.unlinkSync(ppm);
	console.log('wrote', file);
}

// ---- field --------------------------------------------------------------
const model = galaxy.createGalaxy({ type: TYPE, seed: SEED });
const c = model.centre;
const stars = sampling.sampleGalaxyStars(model, SEED, STARS, null);
const derived = {};
const fam = new Uint8Array(STARS);
const jitter = new Uint8Array(STARS);
for (let i = 0; i < STARS; i++) {
	starTypes.deriveStar(model, starTypes.fieldStarSeed(SEED, i),
		stars.component[i], stars.R[i], stars.distToArm[i], derived);
	fam[i] = orbit.familyForStar(stars.component[i], derived.spectralClass, model.barred);
	jitter[i] = Math.imul(i, 2654435761) & 0xFF;
}

const P = orbit.simpleDerived(model, {});
const eccMax = orbit.simpleEccMax(model);
const out = new Float64Array(3);
const scratch = new Float64Array(3);

// theta0 per star (simple engine state), and the classic records.
const theta0 = new Float64Array(STARS);
for (let i = 0; i < STARS; i++) theta0[i] = Math.atan2(stars.y[i] - c.y, stars.x[i] - c.x);

function classicPos(i, time, into) {
	return orbit.orbitPosition(into, stars.x[i], stars.y[i], stars.z[i], fam[i],
		jitter[i] & 15, jitter[i] >>> 4, time, model);
}
// One theta, stepped exactly like the GPU dispatch: frame-sized Euler chunks.
function unusedSimplePos(i, fromTheta, dt, into) {
	const phase = orbit.simplePatternPhase(model, 0);
	const theta = orbit.simpleStepTheta(fromTheta, Math.hypot(stars.x[i] - c.x, stars.y[i] - c.y),
		orbit.simpleEccOf(jitter[i]), orbit.simplePeriOf(jitter[i]), fam[i], P, phase, dt);
	return orbit.simplePositionFromTheta(into, theta, stars.x[i], stars.y[i], stars.z[i],
		jitter[i], fam[i], eccMax, model);
}

// Pixel mapping: face-on looks down the disc axis (world x → right, y → up);
// edge-on looks along -y (world x → right, z → up, exaggerated).
const isFace = VIEW === 'face';
let scale = (Math.min(W, H) * 0.45) / (model.truncation.discRadius * 0.45);
if (!isFace) scale = (Math.min(W, H) * 0.42) / (model.truncation.discRadius * 0.35);
function project(x, y, z, into) {
	const u = isFace ? (x - c.x) : (x - c.x);
	const v = isFace ? (y - c.y) : (z - c.z) * 6;
	into[0] = W * 0.5 + u * scale;
	into[1] = H * 0.5 - v * scale;
}
const px = new Float64Array(2);

// ---- layers -------------------------------------------------------------
// 1. birth field, faint grey
for (let i = 0; i < STARS; i++) {
	project(stars.x[i], stars.y[i], stars.z[i], px);
	splat(px[0], px[1], 0.55, 0.60, 0.75, 0.10);
}
console.log(`type ${TYPE} engine ${ENGINE} view ${VIEW}: ${STARS} stars, rCore ${model.dynamics.rCore}, ` +
	`vFlat ${model.dynamics.vFlat}, omegaPattern ${model.dynamics.omegaPattern.toFixed(4)} rad/Myr, ` +
	`centre (${c.x}, ${c.y}, ${c.z}), eccMax ${eccMax.toFixed(3)}, discRadius ${model.truncation.discRadius}`);

// 2. trails: a spread of stars (by radius), full path over SPAN
const order = Array.from({ length: STARS }, (_, i) => i)
	.sort((a, b) => Math.hypot(stars.x[a] - c.x, stars.y[a] - c.y) - Math.hypot(stars.x[b] - c.x, stars.y[b] - c.y));
const trailStars = [];
const stride = Math.max(1, Math.floor(STARS / TRAILS));
for (let k = 0; k < STARS && trailStars.length < TRAILS; k += stride) trailStars.push(order[k]);

const dtTrail = SPAN / T_STEPS;
for (let t = 0; t < trailStars.length; t++) {
	const i = trailStars[t];
	const shade = 0.25 + 0.75 * (t / Math.max(1, trailStars.length - 1));
	const r0 = Math.hypot(stars.x[i] - c.x, stars.y[i] - c.y);
	const eccU = orbit.simpleEccOf(jitter[i]), peri = orbit.simplePeriOf(jitter[i]);
	const phase = orbit.simplePatternPhase(model, 0);
	let theta = theta0[i];
	let px0 = 0, py0 = 0;
	for (let s = 0; s <= T_STEPS; s++) {
		const time = s * dtTrail;
		if (ENGINE === 'simple') orbit.simplePositionFromTheta(out, theta, stars.x[i], stars.y[i], stars.z[i], jitter[i], fam[i], eccMax, model);
		else classicPos(i, time, out);
		project(out[0], out[1], out[2], px);
		if (s > 0) {
			const segs = Math.max(1, Math.ceil(Math.hypot(px[0] - px0, px[1] - py0) / 2));
			for (let q = 0; q <= segs; q++) {
				const u = q / segs;
				splat(px0 + (px[0] - px0) * u, py0 + (px[1] - py0) * u, 1.0, 0.30 + 0.3 * shade, 0.35 + 0.5 * shade, 0.16);
			}
		}
		px0 = px[0]; py0 = px[1];
		if (ENGINE === 'simple') theta = orbit.simpleStepTheta(theta, r0, eccU, peri, fam[i], P, phase, dtTrail);
	}
}

// 3. family census colours on the birth field for the bright components
const FAM_RGB = [[1.0, 0.45, 0.65], [0.55, 0.70, 1.0], [1.0, 0.8, 0.35], [0.5, 1.0, 0.75]];
const census = [0, 0, 0, 0];
for (let i = 0; i < STARS; i++) census[fam[i]]++;

// 4. the centre and the radius rings, drawn after the data so they read
function ring(radius, r, g, b, gain) {
	for (let a = 0; a < 2400; a++) {
		const th = a / 2400 * Math.PI * 2;
		project(c.x + radius * Math.cos(th), c.y + radius * Math.sin(th), c.z, px);
		splat(px[0], px[1], r, g, b, gain);
	}
}
ring(1, 0.6, 0.6, 0.6, 0.05);
ring(model.dynamics.vFlat / model.dynamics.omegaPattern > 0 && model.dynamics.omegaPattern > 0
	? model.dynamics.vFlat / model.dynamics.omegaPattern : 0, 0.2, 1.0, 0.4, 0.0);   // corotation, if finite
project(c.x, c.y, c.z, px);
splat(px[0], px[1], 1.0, 1.0, 1.0, 3.0);

const file = `${OUT}-${TYPE}-${ENGINE}-${VIEW}.png`;
writePng(file);
console.log('families', FAM_RGB.map((_, k) => `${orbit.FAMILY_NAMES[k]}=${census[k]}`).join(' '));
