// experiments/hash-quality-test.js
// Validates PCG and Wang hash functions for procedural generation:
//   1. Chi-square uniformity test on hash01 output (N buckets)
//   2. Serial correlation (no adjacent hash correlations)
//   3. Spectral test: 2D scatter density (visual check for lattice patterns)
//   4. Period check: ensure hash doesn't repeat within practical input range
//
// Output: experiments/logs/hash-quality.json

'use strict';

const fs = require('fs');
const path = require('path');
const hash = require('../src/math/hash.js');

const N = 1000000;            // samples
const BUCKETS = 256;          // for chi-square
const LATTICE_BINS = 64;      // for 2D spectral test

// --- Chi-square test on hash01 ---
function chiSquare01(hashFn) {
	const counts = new Array(BUCKETS).fill(0);
	for (let i = 0; i < N; i++) {
		const v = hash.hash01(i * 0x9E3779B1 >>> 0); // input mixing
		const b = Math.min(BUCKETS - 1, Math.floor(v * BUCKETS));
		counts[b]++;
	}
	const expected = N / BUCKETS;
	let chi2 = 0;
	for (let i = 0; i < BUCKETS; i++) {
		const d = counts[i] - expected;
		chi2 += (d * d) / expected;
	}
	// df = BUCKETS - 1 = 255. Critical values:
	//   5% significance: 293 (reject uniformity)
	//   1% significance: 310
	// Pass: chi2 < 293
	return { chi2, df: BUCKETS - 1, pass5pct: chi2 < 293, pass1pct: chi2 < 310, counts };
}

// --- Serial correlation: check hash(i) and hash(i+1) are independent ---
function serialCorrelation(hashFn) {
	const N2 = 200000;
	let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
	for (let i = 0; i < N2; i++) {
		const x = hash.hash01(i * 0x9E3779B1 >>> 0);
		const y = hash.hash01((i + 1) * 0x9E3779B1 >>> 0);
		sumX += x; sumY += y;
		sumXY += x * y;
		sumX2 += x * x; sumY2 += y * y;
	}
	const meanX = sumX / N2, meanY = sumY / N2;
	const cov = sumXY / N2 - meanX * meanY;
	const varX = sumX2 / N2 - meanX * meanX;
	const varY = sumY2 / N2 - meanY * meanY;
	const r = cov / Math.sqrt(Math.max(1e-12, varX * varY));
	// Pass: |r| < 0.01 (essentially uncorrelated)
	return { correlation: r, pass: Math.abs(r) < 0.01 };
}

// --- 2D spectral test: lattice pattern detection ---
// Look for visible grid patterns in hash2D output. If hash is bad,
// (x, y) pairs cluster on diagonals or grid lines.
function spectralTest(hash2Dfn) {
	const grid = new Array(LATTICE_BINS * LATTICE_BINS).fill(0);
	for (let i = 0; i < N; i++) {
		const p = hash2Dfn(i * 0x9E3779B1 >>> 0);
		const bx = Math.min(LATTICE_BINS - 1, Math.floor(p.x * LATTICE_BINS));
		const by = Math.min(LATTICE_BINS - 1, Math.floor(p.y * LATTICE_BINS));
		grid[bx * LATTICE_BINS + by]++;
	}
	// Expected count per bin: N / (LATTICE_BINS^2)
	const expected = N / (LATTICE_BINS * LATTICE_BINS);
	let min = Infinity, max = -Infinity, sumDev = 0;
	for (let i = 0; i < grid.length; i++) {
		if (grid[i] < min) min = grid[i];
		if (grid[i] > max) max = grid[i];
		sumDev += Math.abs(grid[i] - expected);
	}
	const meanAbsDev = sumDev / grid.length;
	// Pass: max/min < 2.5 (no dramatic clustering), meanAbsDev/expected < 0.2
	return {
		minCount: min,
		maxCount: max,
		ratio: max / Math.max(1, min),
		meanAbsDev,
		expected,
		passRatio: (max / Math.max(1, min)) < 2.5,
		passDev: meanAbsDev / expected < 0.2,
	};
}

// --- Period check: any repeats in first 1M inputs? ---
function periodCheck(hashFn) {
	const seen = new Set();
	let firstRepeat = -1;
	for (let i = 0; i < N; i++) {
		const h = hashFn(i) >>> 0;
		if (seen.has(h)) {
			firstRepeat = i;
			break;
		}
		seen.add(h);
	}
	// Set maxes out memory at ~50M entries; 1M is fine.
	seen.clear();
	return { firstRepeatAt: firstRepeat, testedN: N, pass: firstRepeat === -1 };
}

console.log(`Hash quality test (N=${N.toLocaleString()} samples)\n`);

console.log('--- PCG hash ---');
const pcgChi = chiSquare01();
console.log(`  chi-square: ${pcgChi.chi2.toFixed(2)} (df=255, pass5%<293): ${pcgChi.pass5pct}`);
const pcgSerial = serialCorrelation();
console.log(`  serial correlation: ${pcgSerial.correlation.toFixed(6)} (pass |r|<0.01): ${pcgSerial.pass}`);
const pcgSpectral = spectralTest(hash.hash2D);
console.log(`  spectral max/min ratio: ${pcgSpectral.ratio.toFixed(2)} (pass <2.5): ${pcgSpectral.passRatio}`);
const pcgPeriod = periodCheck(hash.pcgHash);
console.log(`  period (first repeat in ${N}): ${pcgPeriod.firstRepeatAt === -1 ? 'none' : pcgPeriod.firstRepeatAt} (pass: ${pcgPeriod.pass})`);

console.log('\n--- Wang hash (fallback) ---');
function wang01(s) { return (hash.wangHash(s) >>> 0) / 4294967296; }
function wang2D(s) {
	const a = hash.wangHash(s);
	const b = hash.wangHash(a ^ 0x9e3779b9);
	return { x: (a >>> 0) / 4294967296, y: (b >>> 0) / 4294967296 };
}
// Manual chi-square for Wang
const wangCounts = new Array(BUCKETS).fill(0);
for (let i = 0; i < N; i++) {
	const v = wang01(i * 0x9E3779B1 >>> 0);
	const b = Math.min(BUCKETS - 1, Math.floor(v * BUCKETS));
	wangCounts[b]++;
}
const wangExpected = N / BUCKETS;
let wangChi2 = 0;
for (let i = 0; i < BUCKETS; i++) {
	const d = wangCounts[i] - wangExpected;
	wangChi2 += (d * d) / wangExpected;
}
const wangSpectral = spectralTest(wang2D);
console.log(`  chi-square: ${wangChi2.toFixed(2)} (pass5%<293): ${wangChi2 < 293}`);
console.log(`  spectral max/min ratio: ${wangSpectral.ratio.toFixed(2)} (pass <2.5): ${wangSpectral.passRatio}`);

const out = {
	date: new Date().toISOString(),
	N,
	buckets: BUCKETS,
	pcg: {
		chiSquare: { value: pcgChi.chi2, df: pcgChi.df, pass5pct: pcgChi.pass5pct, pass1pct: pcgChi.pass1pct },
		serialCorrelation: { value: pcgSerial.correlation, pass: pcgSerial.pass },
		spectral: { ...pcgSpectral },
		period: { ...pcgPeriod },
		recommendation: pcgChi.pass5pct && pcgSerial.pass && pcgSpectral.passRatio && pcgPeriod.pass
			? 'PASS — use PCG as default hash'
			: 'FAIL — investigate before shipping',
	},
	wang: {
		chiSquare: { value: wangChi2, pass5pct: wangChi2 < 293 },
		spectral: { ...wangSpectral },
		recommendation: wangChi2 < 293 && wangSpectral.passRatio
			? 'PASS — Wang usable as fallback'
			: 'FAIL — Wang not usable',
	},
};

const logPath = path.join(__dirname, 'logs', 'hash-quality.json');
fs.writeFileSync(logPath, JSON.stringify(out, null, 2));
console.log(`\nWrote ${logPath}`);

console.log('\n=== VERDICT ===');
console.log(`PCG: ${out.pcg.recommendation}`);
console.log(`Wang: ${out.wang.recommendation}`);
