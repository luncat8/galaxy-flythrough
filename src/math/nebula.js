// src/math/nebula.js
// Nebula placement from the local young-star and dust environment, for a given
// GalaxyModel.
//
// Nebulae concentrate in spiral arms (molecular clouds form there, OB stars
// ionise them), in the thin-disc midplane, and — for the stellar-driven types —
// in old populations. Two separate probability terms encode that:
//
//   pGas     HII / reflection / dark: needs cold gas  -> arms, low |z|, no bulge
//   pStellar planetary / SNR:         needs old stars -> bulge and thick disc
//
// `populations.gasRich` switches the gas layer off entirely and `gasFraction`
// scales it, so an S0 keeps its planetary nebulae and loses its HII regions
// while a Sc gets more of both gas and arm contrast. The vertical scale comes
// from the model too (thin.H × youngScaleHeight), which is what keeps the layer
// on the same population the sampler placed.
//
// A nebula is not stored: it is a deterministic function of (seed, position,
// type roll), so the same galaxy is regenerated everywhere.

'use strict';

(function () {
	const density = (typeof module !== 'undefined' && module.exports)
		? require('./density.js')
		: window.DensityLib;
	const hash = (typeof module !== 'undefined' && module.exports)
		? require('./hash.js')
		: window.HashLib;
	const sampling = (typeof module !== 'undefined' && module.exports)
		? require('./sampling.js')
		: window.SamplingLib;

	const NEBULA_TYPES = ['HII', 'reflection', 'planetary', 'dark', 'SNR'];

	// The gas fraction at which the loose-nebula layer has its tuned strength —
	// the Milky Way's own. A gas-richer type scales the layer up, a poorer one
	// down; below `populations.gasRich` it is off entirely.
	const GAS_NORMAL = 0.15;

	// How far a cloud can sit from the arm ridge and still be read as arm gas:
	// a multiple of the model's young-ridge width (density.armRidgeWidth), which
	// is the same lane the O/B stars are born in. The numbers are the Milky
	// Way's own tuned distances, ~0.8 and ~1.5 kpc at the radius they were
	// measured at (R = 5 kpc, sigma = 0.33), so a type with a wider or tighter
	// pattern scales with it instead of inheriting them.
	const NEBULA_ARM_REACH = 2.4;
	const NEBULA_DARK_REACH = 4.6;

	const NEBULA_COLORS = {
		HII: [1.00, 0.30, 0.45],        // H-alpha pink
		reflection: [0.50, 0.65, 1.00], // scattered blue
		planetary: [0.40, 1.00, 0.70],  // [OIII] green
		dark: [0.20, 0.18, 0.16],       // dust, mostly absorbing
		SNR: [0.50, 0.20, 1.00],        // synchrotron purple
	};

	// Probability and most likely type at a position.
	function nebulaProbabilityAt(model, x, y, z) {
		const dec = density.rhoDecomposed(model, x, y, z);
		const dom = density.dominantComponent(model, x, y, z);
		const youngH = model.thin.H * model.populations.youngScaleHeight;
		const inDisc = Math.exp(-Math.abs(z - model.centre.z) / youngH);
		const ridge = density.armRidgeWidth(model, dec.R);
		const armBoost = dec.distToArm < NEBULA_ARM_REACH * ridge
			? Math.exp(-0.5 * dec.distToArm * dec.distToArm / (ridge * ridge)) : 0.0;
		const gasBulgeSuppress = dec.bulge > 0.1 ? 0.1 : 1.0;
		const gasHaloSuppress = dec.halo > 0.0005 ? 0.01 : 1.0;
		const gasWeight = model.populations.gasRich ? model.populations.gasFraction / GAS_NORMAL : 0.0;
		const pGas = Math.min(1.0, 0.05 * gasWeight * inDisc * armBoost * gasBulgeSuppress * gasHaloSuppress);
		const pStellar = 0.005 * (dec.bulge > 0.05 ? 4.0 : 1.0) * (dom === 'halo' ? 0.3 : 1.0);
		const p = Math.min(1.0, pGas + pStellar);

		const inSpiralRegion = model.populations.gasRich && dec.R > model.arms.Rs && dec.R < model.populations.youngOuterR && dom !== 'bulge';
		let type;
		if (inSpiralRegion && dec.distToArm < ridge) type = 'HII';
		else if (inSpiralRegion && dec.distToArm < NEBULA_ARM_REACH * ridge) type = 'reflection';
		else if (dom === 'bulge' || (dec.R < 3 && dec.zp < 1.0)) type = 'planetary';
		else if (model.populations.gasRich && dec.distToArm < NEBULA_DARK_REACH * ridge && dec.R > 3 && dom !== 'halo') type = 'dark';
		else type = 'SNR';

		return { p, type, dec, dom };
	}

	// Place up to N nebulae inside `box`. Candidate positions come from the
	// analytic sampler (so they follow the stellar density), then each
	// candidate is accepted with the nebula probability above.
	function placeNebulae(model, seed, N, box) {
		const out = [];
		const batch = sampling.createBuffers(4096);
		let batchSeed = seed;
		let attempts = 0;
		const maxAttempts = N * 4096;
		while (out.length < N && attempts < maxAttempts) {
			sampling.sampleStarsInBox(model, batchSeed, 4096, box, batch);
			batchSeed = (Math.imul(batchSeed, 0x9e3779b1) + 0x2545f491) | 0;
			for (let i = 0; i < batch.count && out.length < N; i++) {
				attempts++;
				const x = batch.x[i];
				const y = batch.y[i];
				const z = batch.z[i];
				const info = nebulaProbabilityAt(model, x, y, z);
				const roll = hash.hash01At(seed + batchSeed + i, 0);
				if (roll >= info.p) continue;
				const sizeRoll = hash.hash01At(seed + batchSeed + i, 1);
				const angleRoll = hash.hash01At(seed + batchSeed + i, 2);
				out.push({
					x, y, z,
					type: info.type,
					size: 0.020 + sizeRoll * 0.300,        // 20 pc .. 320 pc
					color: NEBULA_COLORS[info.type],
					opacity: 0.4 + 0.5 * hash.hash01At(seed + batchSeed + i, 3),
					orientation: angleRoll * 2 * Math.PI,
					distToArm: info.dec.distToArm,
					R: info.dec.R,
					phi: info.dec.phi,
					zp: info.dec.zp,
					component: density.COMPONENT_NAMES[batch.component[i]],
					dominant: info.dom,
					index: out.length,
					seed: seed + batchSeed + i,
				});
			}
		}
		return out;
	}

	function summariseNebulae(nebulae) {
		const byType = {};
		const byComponent = {};
		const armDistBuckets = [0, 0, 0, 0, 0];  // [0,0.3) [0.3,0.8) [0.8,1.5) [1.5,3) [3+)
		let sizeSum = 0;
		for (const n of nebulae) {
			byType[n.type] = (byType[n.type] || 0) + 1;
			byComponent[n.component] = (byComponent[n.component] || 0) + 1;
			sizeSum += n.size;
			if (n.distToArm < 0.3) armDistBuckets[0]++;
			else if (n.distToArm < 0.8) armDistBuckets[1]++;
			else if (n.distToArm < 1.5) armDistBuckets[2]++;
			else if (n.distToArm < 3.0) armDistBuckets[3]++;
			else armDistBuckets[4]++;
		}
		return {
			total: nebulae.length,
			byType,
			byComponent,
			armDistBuckets,
			meanSizeKpc: sizeSum / Math.max(1, nebulae.length),
		};
	}

	const NebulaLib = { NEBULA_TYPES, NEBULA_COLORS, GAS_NORMAL, NEBULA_ARM_REACH, NEBULA_DARK_REACH, nebulaProbabilityAt, placeNebulae, summariseNebulae };
	if (typeof module !== 'undefined') module.exports = NebulaLib;
	if (typeof window !== 'undefined') window.NebulaLib = NebulaLib;
})();
