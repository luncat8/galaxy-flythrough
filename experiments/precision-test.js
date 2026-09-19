// experiments/precision-test.js
// Validates that f32 precision is sufficient at various galactic distances,
// and quantifies the benefit of split-double (positionHigh + positionLow).
//
// At f32 (7 decimal digits), at 10 kpc the precision is ~1 metre, at 100 kpc
// it is ~10 metres. For star rendering this is fine, but for camera position
// offset computation it produces visible jitter during slow fly-through.
//
// Simulates both f32 and split-double (f32+f32) for a range of galactic
// positions, measuring worst-case position error in parsecs.
//
// Output: experiments/logs/precision-test.json

'use strict';

const fs = require('fs');
const path = require('path');

// Simulate f32 precision: keep top 23 bits of mantissa.
function toF32(x) {
	const buf = new Float32Array(1);
	buf[0] = x;
	return buf[0];
}

// Split-double: positionHigh (f32) + positionLow (f32).
// positionHigh = round(x to f32 precision); positionLow = x - positionHigh.
// Effective precision: ~46 bits (2x f23 mantissa).
function splitDouble(x) {
	const high = toF32(x);
	const low = toF32(x - high);
	return { high, low, reconstructed: high + low };
}

// Simulated galactic positions (Sun-centred, kpc).
// Distances typical of interesting fly-through regions.
const TEST_DISTANCES_KPC = [
	0.001, 0.010, 0.100,   // nearby (< 100 pc)
	0.500, 1.0, 2.0,       // local arm
	5.0, 8.178,            // halfway to GC, at GC
	12.0, 20.0,            // far disc
	50.0, 100.0,           // halo
];

// For each distance, test 1000 random star offsets and measure worst error.
const N = 1000;

function testAt(distanceKpc) {
	let maxErrF32 = 0;
	let maxErrSplit = 0;
	let sumErrF32 = 0;
	let sumErrSplit = 0;

	for (let i = 0; i < N; i++) {
		// Random star position at this distance
		const theta = Math.random() * 2 * Math.PI;
		const phi = Math.acos(2 * Math.random() - 1);
		const sx = distanceKpc * Math.sin(phi) * Math.cos(theta);
		const sy = distanceKpc * Math.sin(phi) * Math.sin(theta);
		const sz = distanceKpc * Math.cos(phi);

		// Camera position (assume near origin for simplicity)
		const cx = 0.001 * (Math.random() - 0.5);
		const cy = 0.001 * (Math.random() - 0.5);
		const cz = 0.001 * (Math.random() - 0.5);

		// True camera-relative position
		const trueX = sx - cx;
		const trueY = sy - cy;
		const trueZ = sz - cz;
		const trueMag = Math.sqrt(trueX * trueX + trueY * trueY + trueZ * trueZ);

		// Naive f32: cast each component to f32 directly
		const f32X = toF32(trueX);
		const f32Y = toF32(trueY);
		const f32Z = toF32(trueZ);
		const f32Mag = Math.sqrt(f32X * f32X + f32Y * f32Y + f32Z * f32Z);
		const errF32 = Math.abs(f32Mag - trueMag);
		if (errF32 > maxErrF32) maxErrF32 = errF32;
		sumErrF32 += errF32;

		// Split-double: store (positionHigh, positionLow) per axis
		const split = splitDouble(trueX);
		const splitX = split.reconstructed;
		const splitY = splitDouble(trueY).reconstructed;
		const splitZ = splitDouble(trueZ).reconstructed;
		const splitMag = Math.sqrt(splitX * splitX + splitY * splitY + splitZ * splitZ);
		const errSplit = Math.abs(splitMag - trueMag);
		if (errSplit > maxErrSplit) maxErrSplit = errSplit;
		sumErrSplit += errSplit;
	}

	return {
		distanceKpc,
		nSamples: N,
		f32: {
			maxErrorPc: maxErrF32 * 1000,
			meanErrorPc: (sumErrF32 / N) * 1000,
		},
		splitDouble: {
			maxErrorPc: maxErrSplit * 1000,
			meanErrorPc: (sumErrSplit / N) * 1000,
		},
		improvementFactor: maxErrF32 / Math.max(1e-12, maxErrSplit),
	};
}

console.log('Precision test — f32 vs split-double at galactic distances\n');
console.log('Distance(kpc) | f32 max err (pc) | split max err (pc) | improvement');
console.log('--------------|------------------|--------------------|------------');

const results = [];
for (const d of TEST_DISTANCES_KPC) {
	const r = testAt(d);
	results.push(r);
	console.log(
		`${d.toFixed(3).padStart(13)} | ` +
		`${r.f32.maxErrorPc.toFixed(4).padStart(16)} | ` +
		`${r.splitDouble.maxErrorPc.toFixed(4).padStart(18)} | ` +
		`${r.improvementFactor.toFixed(0).padStart(4)}x`
	);
}

// Recommendation: where is f32 sufficient, where is split-double needed?
const f32AcceptablePc = 0.5;     // sub-parsec acceptable for stars
const splitNeededAt = results.filter(r => r.f32.maxErrorPc > f32AcceptablePc);

const out = {
	date: new Date().toISOString(),
	nSamplesPerDistance: N,
	f32AcceptableThresholdPc: f32AcceptablePc,
	results,
	recommendation: {
		f32SufficientBelow_kpc: splitNeededAt.length === 0
			? TEST_DISTANCES_KPC[TEST_DISTANCES_KPC.length - 1]
			: splitNeededAt[0].distanceKpc,
		splitDoubleNeededAbove_kpc: splitNeededAt.length > 0 ? splitNeededAt[0].distanceKpc : null,
		summary: splitNeededAt.length === 0
			? 'f32 is sufficient across tested range — split-double may be unnecessary'
			: `Use split-double above ${splitNeededAt[0].distanceKpc} kpc to keep sub-${f32AcceptablePc}pc precision`,
	},
};

const logPath = path.join(__dirname, 'logs', 'precision-test.json');
fs.writeFileSync(logPath, JSON.stringify(out, null, 2));
console.log(`\nWrote ${logPath}`);

console.log('\n=== VERDICT ===');
console.log(`Recommendation: ${out.recommendation.summary}`);
