// experiments/view-modes-field-test.js — quick smoke test for the CPU field.
'use strict';
const assert = require('assert');
const Field = require('../src/math/view-modes-field.js');
const GalaxyLib = require('../src/math/galaxy.js');

const model = GalaxyLib.MILKY_WAY;
console.log(`Model: ${model.type}`);

// Test 1: constellation set builds (landmarks path).
const cons = Field.buildConstellationSet(model, {});
console.log(`Constellation anchors: ${cons._count} (${cons._source})`);
assert.ok(cons._count > 50, 'expected ~60+ landmarks');
assert.strictEqual(cons.length, cons._count * 3);

// Test 2: nearest-N set builds.
const N = 200;
const near = Field.buildStarSet(model, N);
console.log(`Nearest set: ${near._count} (${near._source})`);
assert.strictEqual(near._count, N);

// Test 3: camera-dist field computes.
const W = 128, H = 128;
const cam = { x: 0, y: 0, z: 0.01, fx: 0, fy: 0, fz: -1 };  // just above Sun, looking at galactic centre
const out = new Float32Array(W * H);
const t0 = Date.now();
Field.computeField(cons, cons._count, cam, {
	mode: 'camera-dist', w: W, h: H, fovDeg: 90, splatSigma: 10, blurRadius: 5, blurPasses: 3,
}, out);
const t1 = Date.now();
console.log(`camera-dist field (128^2, ${cons._count} stars): ${t1 - t0} ms`);

// Check outputs are sane: 0..1, no NaN.
let minV = 1, maxV = 0, nan = 0;
for (let i = 0; i < out.length; i++) {
	const v = out[i];
	if (!Number.isFinite(v)) { nan++; continue; }
	if (v < minV) minV = v;
	if (v > maxV) maxV = v;
}
assert.strictEqual(nan, 0, 'no NaN');
assert.ok(minV >= 0 && maxV <= 1, 'bounded 0..1');
assert.ok(maxV > 0.5, 'field must reach high values near a star');
console.log(`  range [${minV.toFixed(3)}, ${maxV.toFixed(3)}]`);

// Test 4: adjacency variance field.
const out2 = new Float32Array(W * H);
Field.computeField(cons, cons._count, cam, {
	mode: 'adjacency', w: W, h: H, fovDeg: 90, splatSigma: 10, blurRadius: 5, blurPasses: 3,
}, out2);
let minV2 = 1, maxV2 = 0, nan2 = 0;
for (let i = 0; i < out2.length; i++) {
	const v = out2[i];
	if (!Number.isFinite(v)) { nan2++; continue; }
	if (v < minV2) minV2 = v;
	if (v > maxV2) maxV2 = v;
}
assert.strictEqual(nan2, 0, 'adjacency: no NaN');
assert.ok(minV2 >= 0 && maxV2 <= 1, 'adjacency: bounded 0..1');
console.log(`adjacency field range [${minV2.toFixed(3)}, ${maxV2.toFixed(3)}]`);

// Test 5: bilinear read
const h = Field.getHeightAt(out, 0.5, 0.5);
assert.ok(h >= 0 && h <= 1);
console.log(`height at centre: ${h.toFixed(3)}`);

// Test 6: perf at N=500, 256x256
const near500 = Field.buildStarSet(model, 500);
const out3 = new Float32Array(256 * 256);
const t2 = Date.now();
Field.computeField(near500, near500._count, cam, {
	mode: 'camera-dist', w: 256, h: 256, fovDeg: 90, splatSigma: 14, blurRadius: 6, blurPasses: 3,
}, out3);
console.log(`camera-dist 256^2 with 500 stars: ${Date.now() - t2} ms`);

console.log('\nOK');
