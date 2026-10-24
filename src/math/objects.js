// src/math/objects.js
// Gas objects: HII regions, planetary nebulae and supernova remnants — the
// nebula layer, with member stars where the object has them (an HII region
// *is* its OB association; a planetary nebula is its central star; an SNR is
// a shell with no members). 0.3.2a places the objects and generates their
// member stars; 0.3.2b draws the gas as camera-facing billboards from the
// shell sizes below.
//
// Star clusters are NOT here and are not nebulae: a globular cluster is a
// bound group of stars inside this galaxy, so it lives in clusters.js as
// stars only (no billboard, no nebula tint). The predefined open/globular
// classes that used to sit in this type list were removed with it —
// clusters.js is one generalized family, not classes.
//
// Placement generalises nebula.js: candidates come from the field sampler and
// each is accepted with p = min(1, pHII + pPlanetary + pSNR), the type rolled
// proportionally. Members are ordinary stars through the same IMF pipeline
// as field stars (star-types.js), coeval at the object's age, at centre +
// profile offset. Member i of object j is a pure function of (seed, j, i):
// the same galaxy rebuilds the same members on any machine.
//
// Units: kpc. Ages: Gyr.

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
	const galaxy = (typeof module !== 'undefined' && module.exports)
		? require('./galaxy.js')
		: window.GalaxyLib;
	const nebula = (typeof module !== 'undefined' && module.exports)
		? require('./nebula.js')
		: window.NebulaLib;
	const starTypes = (typeof module !== 'undefined' && module.exports)
		? require('./star-types.js')
		: window.StarTypesLib;
	const records = (typeof module !== 'undefined' && module.exports)
		? require('./star-record.js')
		: window.StarRecord;
	const orbit = (typeof module !== 'undefined' && module.exports)
		? require('./orbit.js')
		: window.OrbitLib;

	const TAU = Math.PI * 2;
	const OBJECT_TYPES = ['HII', 'planetary', 'SNR'];
	const OBJECT_COUNT_DEFAULT = 400;
	// The member allowance for this gas layer scales with the selected field
	// budget (plan §10): the block is drawn on top of the field, so a fixed
	// member count would outweigh a small galaxy and vanish in a large one.
	// Cluster members carry their own, separately controlled budget
	// (clusters.clusterMemberBudget); this fraction is only the gas layer's.
	const GAS_MEMBER_FRACTION = 0.01;
	function gasMemberBudget(fieldStars) {
		return Math.round(Math.max(0, Number(fieldStars) || 0) * GAS_MEMBER_FRACTION);
	}

	// Acceptance rates at unit gas weight, on the ridge, in the midplane. HII
	// matches the loose gas layer's rate (it *is* that layer, with members);
	// planetaries are the unchanged stellar term; SNR are massive-star
	// remnants, so the stellar term times the thin fraction times an arm
	// tracer.
	const RATE_HII = 0.05;
	const RATE_STELLAR = 0.005;

	// Richness [lo, hi], uniform. These are apportionment weights for the
	// member budget, not star counts the galaxy is claimed to have.
	const RICHNESS = {
		HII: [20, 200],
		planetary: [1, 1],
		SNR: [0, 0],
	};
	// HII effective radius (the fractal keeps candidates inside 2.5·R_e).
	const HII_R_MIN = 0.05;
	const HII_R_MAX = 0.15;
	// Coeval ages (Gyr): HII uniform, planetary the old-population age.
	const HII_AGE_MIN = 0.001;
	const HII_AGE_MAX = 0.020;
	const PLANETARY_AGE = 10.0;
	// Shell sizes for the billboard pass.
	const PLANETARY_SIZE = 0.002;
	const SNR_SIZE_MIN = 0.020;
	const SNR_SIZE_MAX = 0.120;
	// Every object type here is gas, so every type gets a billboard. Star
	// clusters (clusters.js) are the stars-only systems; they never reach
	// this table, which is what keeps a cluster out of the nebula pass.
	const GAS_TYPES = { HII: true, planetary: true, SNR: true };
	const BILLBOARD_RECORD_FLOATS = 8;
	const BILLBOARD_RECORD_BYTES = BILLBOARD_RECORD_FLOATS * 4;
	const BILLBOARD_MIN_PX = 4;
	const BILLBOARD_MAX_DIST_KPC = 5;
	// Peak additive alpha at the disc centre, before the (1-r²)² falloff.
	const BILLBOARD_OPACITY = { HII: 0.45, planetary: 0.55, SNR: 0.35 };
	// Fractal OB candidates: uniform in the 2.5·R_e sphere, kept where the
	// object-local 3-octave noise is above 0, with this many deterministic
	// retries before the last candidate is kept as fallback.
	const FRACTAL_RADIUS = 2.5;
	const FRACTAL_RETRIES = 10;

	// Per-type acceptance probabilities at a position. The gas terms reuse the
	// nebula layer's lane, vertical scale and suppressions, so the young stars,
	// the gas clouds and the gas objects trace one lane.
	function objectProbabilitiesAt(model, x, y, z) {
		const dec = density.rhoDecomposed(model, x, y, z);
		let dom = 'thin';
		let best = dec.thin;
		if (dec.thick > best) { dom = 'thick'; best = dec.thick; }
		if (dec.bulge > best) { dom = 'bulge'; best = dec.bulge; }
		if (dec.halo > best) { dom = 'halo'; best = dec.halo; }
		const youngH = model.thin.H * model.populations.youngScaleHeight;
		const inDisc = Math.exp(-Math.abs(z - model.centre.z) / youngH);
		const ridge = density.armRidgeWidth(model, dec.R);
		const armBoost = dec.distToArm < nebula.NEBULA_ARM_REACH * ridge
			? Math.exp(-0.5 * dec.distToArm * dec.distToArm / (ridge * ridge)) : 0.0;
		const gasBulgeSuppress = dec.bulge > 0.1 ? 0.1 : 1.0;
		const gasHaloSuppress = dec.halo > 0.0005 ? 0.01 : 1.0;
		// The gas left at the model's age (see galaxy.solvePopulationClock),
		// against the fraction the rates were tuned at. Same lane, same vertical
		// scale and same suppressions as the nebula layer, so the young stars, the
		// gas clouds and the composite objects trace one thing — and one that
		// fades as a galaxy burns its reservoir.
		const gasWeight = model.populations.gasRich ? model.populations.gasNow / galaxy.GAS_NORMAL : 0.0;
		const pHII = Math.min(1.0, RATE_HII * gasWeight * inDisc * armBoost * gasBulgeSuppress * gasHaloSuppress);
		const pPlanetary = RATE_STELLAR * (dec.bulge > 0.05 ? 4.0 : 1.0) * (dom === 'halo' ? 0.3 : 1.0);
		const total = dec.thin + dec.thick + dec.bulge + dec.halo;
		const pSNR = pPlanetary * (total > 0 ? dec.thin / total : 0) * (0.5 + armBoost);
		return {
			p: Math.min(1.0, pHII + pPlanetary + pSNR),
			pHII, pPlanetary, pSNR, dec, dom,
		};
	}

	function pickObjectType(probs, u) {
		const total = probs.pHII + probs.pPlanetary + probs.pSNR;
		let r = u * total;
		if ((r -= probs.pHII) < 0) return 'HII';
		if ((r -= probs.pPlanetary) < 0) return 'planetary';
		return 'SNR';
	}

	// Place up to N objects. Candidates come from the field sampler (inside
	// `box`, or whole-galaxy when `box` is null), each accepted with the
	// probability above. An empty model yields no objects.
	function placeObjects(model, seed, N, box) {
		const out = [];
		const batch = sampling.createBuffers(4096);
		let batchSeed = seed | 0;
		let attempts = 0;
		const maxAttempts = N * 4096;
		while (out.length < N && attempts < maxAttempts) {
			if (box) sampling.sampleStarsInBox(model, batchSeed, 4096, box, batch);
			else sampling.sampleGalaxyStars(model, batchSeed, 4096, batch);
			if (batch.count === 0) break;
			batchSeed = (Math.imul(batchSeed, 0x9e3779b1) + 0x2545f491) | 0;
			for (let i = 0; i < batch.count && out.length < N; i++) {
				attempts++;
				const x = batch.x[i];
				const y = batch.y[i];
				const z = batch.z[i];
				const probs = objectProbabilitiesAt(model, x, y, z);
				const base = (seed | 0) + batchSeed + i;
				if (hash.hash01At(base, 0) >= probs.p) continue;
				const type = pickObjectType(probs, hash.hash01At(base, 1));
				const range = RICHNESS[type];
				const richness = range[0] + Math.floor(hash.hash01At(base, 2) * (range[1] - range[0] + 1));
				const rSize = hash.hash01At(base, 3);
				const rAge = hash.hash01At(base, 4);
				let size = 0;
				let ageGyr = 0;
				if (type === 'HII') {
					size = HII_R_MIN + rSize * (HII_R_MAX - HII_R_MIN);
					ageGyr = HII_AGE_MIN + rAge * (HII_AGE_MAX - HII_AGE_MIN);
				} else if (type === 'planetary') {
					size = PLANETARY_SIZE;
					ageGyr = PLANETARY_AGE;
				} else {
					size = SNR_SIZE_MIN + rSize * (SNR_SIZE_MAX - SNR_SIZE_MIN);
					ageGyr = 0.01;
				}
				// No object is older than its galaxy: the ranges above are the
				// observed present-day ones (a 10 Gyr planetary nebula), and a
				// 1 Gyr galaxy has had no time to make one. Clamping keeps the
				// members' ages — which deriveStarWithAge imposes on the whole
				// object — inside the model's clock.
				const galaxyAge = model.populations.age;
				const sfhSpan = (model.populations && model.populations.sfhSpan > 0) ? model.populations.sfhSpan : galaxyAge;
				const compIdx = batch.component[i];
				const w0 = galaxy.FORMATION_WINDOW[compIdx * 2];
				const w1 = galaxy.FORMATION_WINDOW[compIdx * 2 + 1];
				const formedAt = Math.min(Math.max(0, sfhSpan - 0.05),
					sfhSpan * (w0 + hash.hash01At(base, 5) * (w1 - w0)));
				if (ageGyr > galaxyAge) ageGyr = galaxyAge;
				out.push({
					type, x, y, z, size, richness, formedAt, ageGyr,
					R: probs.dec.R, phi: probs.dec.phi, zp: probs.dec.zp,
					distToArm: probs.dec.distToArm,
					component: density.COMPONENT_NAMES[batch.component[i]],
					dominant: probs.dom,
					index: out.length,
					seed: base,
				});
			}
		}
		return out;
	}

	// ---- member profiles ---------------------------------------------------
	// The one member profile left here is the HII fractal below; the bounded
	// stellar profile (truncated Plummer) moved to clusters.js with the star
	// clusters, and the fixed King W0≈6 profile went with the globular class
	// it belonged to.

	function objectMemberSeed(objSeed, i) {
		return (Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(objSeed | 0, 0x85ebca6b)) | 0;
	}

	// Offset of member i from the object centre (kpc), a pure function of
	// (object seed, i). `out` is a caller-provided length-3 array.
	function sampleMemberOffset(obj, i, out) {
		const oSeed = obj.seed | 0;
		const memberSeed = objectMemberSeed(oSeed, i);
		if (obj.type !== 'HII') {
			// A planetary's only member is its central star, on the centre;
			// an SNR has no members at all (richness 0, never sampled).
			out[0] = 0; out[1] = 0; out[2] = 0;
			return out;
		}
		// Fractal OB: uniform candidates in the 2.5·R_e sphere, kept where the
		// object-local noise is above 0. The retries are a fixed hash sequence
		// (3 channels each), so the fallback keeps the count exact without
		// breaking the (seed, j, i) stability rule.
		const R = FRACTAL_RADIUS * obj.size;
		const freq = 1 / obj.size;
		let dx = 0;
		let dy = 0;
		let dz = 0;
		for (let a = 0; a < FRACTAL_RETRIES; a++) {
			const c = a * 3;
			const cosT = 2 * hash.hash01At(memberSeed, c) - 1;
			const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
			const phi = TAU * hash.hash01At(memberSeed, c + 1);
			const r = R * Math.cbrt(hash.hash01At(memberSeed, c + 2));
			dx = r * sinT * Math.cos(phi);
			dy = r * sinT * Math.sin(phi);
			dz = r * cosT;
			if (density.fbm3D(dx * freq, dy * freq, dz * freq, oSeed) > 0) break;
		}
		out[0] = dx; out[1] = dy; out[2] = dz;
		return out;
	}

	const memberOffset = new Float64Array(3);
	const memberDerived = {};

	// Quota of rendered members for object j, apportioned over a per-object
	// weight: `richness` here, a cluster's continuous `weight` in
	// clusters.js (which reuses this one apportionment rather than growing a
	// second). Cumulative rounding (Bresenham-style) keeps the total exact
	// in one pass with O(1) state: quota_j is 1 plus the inner allocation
	// over (weight − 1), which guarantees every weighted object at least
	// its first member. When everything fits, quotas are the weights
	// themselves — unless the caller passes `fill` (clusters do: their
	// weights are relative masses, not counts, so the budget is always
	// spent in proportion); when even one member each does not fit, the
	// first objects win, in order.
	function quotaWeight(o) {
		const w = o.weight !== undefined ? o.weight : o.richness;
		return w > 0 ? w : 0;
	}
	function objectQuotas(objects, maxMembers, quotas, fill) {
		let total = 0;
		let nonzero = 0;
		let integerWeights = true;
		for (let j = 0; j < objects.length; j++) {
			const w = quotaWeight(objects[j]);
			if (w <= 0) { quotas[j] = 0; continue; }
			if (w !== Math.floor(w)) integerWeights = false;
			total += w;
			nonzero++;
		}
		if (!fill && integerWeights && total <= maxMembers) {
			for (let j = 0; j < objects.length; j++) quotas[j] = Math.floor(quotaWeight(objects[j]));
			return quotas;
		}
		if (nonzero > maxMembers) {
			let left = maxMembers;
			for (let j = 0; j < objects.length; j++) {
				quotas[j] = quotaWeight(objects[j]) > 0 && left-- > 0 ? 1 : 0;
			}
			return quotas;
		}
		if (nonzero === 0 || maxMembers <= 0) return quotas;
		const inner = total - nonzero;
		const budget = maxMembers - nonzero;
		let acc = 0;
		let prev = 0;
		for (let j = 0; j < objects.length; j++) {
			const w = quotaWeight(objects[j]);
			if (w <= 0) { quotas[j] = 0; continue; }
			acc += w - 1;
			const f = inner > 0 ? Math.floor(acc * budget / inner) : 0;
			quotas[j] = 1 + (f - prev);
			prev = f;
		}
		return quotas;
	}

	let quotaScratch = new Uint16Array(0);

	// Derive the apportioned members of `objects` into StarPacked records at
	// `view` / `byteOffset`. Returns the written count; the caller zeroes
	// nothing — unwritten capacity stays all-zero (invisible).
	//
	// `magOffset` is the renderer's exposure renormalisation, in magnitudes, added
	// to absMag before packing: object members are procedural stars, so they
	// follow the field they sit in. It defaults to 0, which keeps every other
	// caller — and every test that pins a member's magnitude — on the unoffset sky.
	//
	// `identity` / `identityBase` (0.5.0) are optional: when given, each member's
	// stable key — `objectMemberSeed(oSeed, i)`, the seed this loop already
	// derives it from — is written to `identity[identityBase + slot]`. Writing it
	// here rather than recomputing it in the renderer is what keeps the key from
	// drifting away from the star it names.
	//
	// `memberMeta` (0.5.0) is optional too, indexed by the block-local `slot`: the
	// two per-object numbers a member's 16-byte record cannot carry, so the planet
	// module can re-derive the star from its key (plan §2.4). `age` is the
	// object's coeval age in Gyr; `component` is the component index the member
	// was derived with, or −1 for a planetary nebula's central star, which takes
	// `derivePlanetaryCentral` instead. Both arrays are block-local because the
	// renderer allocates them with the object block, whose slots do not move.
	function writeObjectMembers(model, objects, view, byteOffset, maxMembers, magOffset, identity, identityBase, memberMeta) {
		if (quotaScratch.length < objects.length) {
			let n = Math.max(16, quotaScratch.length);
			while (n < objects.length) n *= 2;
			quotaScratch = new Uint16Array(n);
		}
		objectQuotas(objects, maxMembers, quotaScratch);
		const offset = magOffset || 0;
		const gcX = model.centre.x;
		const gcY = model.centre.y;
		let slot = 0;
		for (let j = 0; j < objects.length && slot < maxMembers; j++) {
			const obj = objects[j];
			const quota = quotaScratch[j];
			if (quota <= 0) continue;
			const oSeed = obj.seed | 0;
			const component = obj.type === 'HII' ? density.COMPONENT_THIN
				: density.COMPONENT_NAMES.indexOf(obj.dominant);
			for (let i = 0; i < quota && slot < maxMembers; i++) {
				const memberSeed = objectMemberSeed(oSeed, i);
				sampleMemberOffset(obj, i, memberOffset);
				const x = obj.x + memberOffset[0];
				const y = obj.y + memberOffset[1];
				const z = obj.z + memberOffset[2];
				const dx = x - gcX;
				const dy = y - gcY;
				const R = Math.sqrt(dx * dx + dy * dy);
				const distToArm = density.distanceToNearestArm(model, R, Math.atan2(dy, dx));
				if (obj.type === 'planetary') starTypes.derivePlanetaryCentral(memberSeed, component, R, distToArm, memberDerived);
				else starTypes.deriveStarWithAge(model, memberSeed, component, R, distToArm, obj.ageGyr, memberDerived);
				// Orbit family: members of young objects (age < 100 Myr,
				// plan §1.2) ride the pattern with the arms they formed in;
				// older members follow their component's law.
				const family = obj.ageGyr < 0.1
					? orbit.FAMILY_PATTERN
					: orbit.familyForStar(component, memberDerived.spectralClass, model.barred);
				records.writeRecord(view, byteOffset + slot * records.RECORD_BYTES, x, y, z,
					memberDerived.colorIndex, memberDerived.absMag + offset,
					orbit.flagsWithFamily(records.FLAG_VISIBLE, family),
					hash.pcgHash(memberSeed ^ 0xFACE) & 0xFF);
				if (identity) identity[identityBase + slot] = memberSeed >>> 0;
				if (memberMeta) {
					memberMeta.age[slot] = obj.ageGyr;
					memberMeta.component[slot] = obj.type === 'planetary' ? -1 : component;
					if (memberMeta.birth) {
						memberMeta.birth[slot] = Number.isFinite(obj.formedAt) ? obj.formedAt : 0;
					}
				}
				slot++;
			}
		}
		return { written: slot, objects: objects.length };
	}

	function objectHasGas(type) {
		return GAS_TYPES[type] === true;
	}

	// Screen diameter in pixels of a sphere of radius `size` at distance
	// `dist` (kpc) under a vertical FOV. The billboard shader uses the same
	// formula — height / tan(fovY/2), not width — because FOV_Y is vertical.
	function billboardScreenPx(size, dist, heightPx, fovY) {
		if (!(dist > 0) || !(size > 0)) return 0;
		return size / dist * heightPx / Math.tan(fovY * 0.5);
	}

	function billboardVisible(size, dist, heightPx, fovY) {
		if (!(dist > 0) || dist > BILLBOARD_MAX_DIST_KPC) return false;
		return billboardScreenPx(size, dist, heightPx, fovY) >= BILLBOARD_MIN_PX;
	}

	// Pack one billboard per gas object into `view` at `byteOffset`. Returns
	// the written count; the caller draws that many instances. Layout is
	// 8 f32: xyz, size, rgb, opacity — the nebula-billboard shader's
	// NebulaPacked.
	function writeObjectBillboards(objects, view, byteOffset, max) {
		let slot = 0;
		for (let j = 0; j < objects.length && slot < max; j++) {
			const obj = objects[j];
			if (!objectHasGas(obj.type)) continue;
			const color = nebula.NEBULA_COLORS[obj.type];
			const o = byteOffset + slot * BILLBOARD_RECORD_BYTES;
			view.setFloat32(o + 0, obj.x, true);
			view.setFloat32(o + 4, obj.y, true);
			view.setFloat32(o + 8, obj.z, true);
			view.setFloat32(o + 12, obj.size, true);
			view.setFloat32(o + 16, color[0], true);
			view.setFloat32(o + 20, color[1], true);
			view.setFloat32(o + 24, color[2], true);
			view.setFloat32(o + 28, BILLBOARD_OPACITY[obj.type], true);
			slot++;
		}
		return slot;
	}

	function summariseObjects(objects) {
		const byType = {};
		const byComponent = {};
		let totalMembers = 0;
		for (const o of objects) {
			byType[o.type] = (byType[o.type] || 0) + 1;
			byComponent[o.component] = (byComponent[o.component] || 0) + 1;
			totalMembers += o.richness;
		}
		return {
			total: objects.length,
			byType, byComponent, totalMembers,
			meanRichness: totalMembers / Math.max(1, objects.length),
		};
	}

	const ObjectsLib = {
		OBJECT_TYPES, OBJECT_COUNT_DEFAULT,
		GAS_MEMBER_FRACTION, gasMemberBudget,
		RATE_HII, RATE_STELLAR,
		RICHNESS, HII_R_MIN, HII_R_MAX,
		HII_AGE_MIN, HII_AGE_MAX, PLANETARY_AGE,
		PLANETARY_SIZE, SNR_SIZE_MIN, SNR_SIZE_MAX,
		FRACTAL_RADIUS, FRACTAL_RETRIES,
		GAS_TYPES, BILLBOARD_RECORD_FLOATS, BILLBOARD_RECORD_BYTES,
		BILLBOARD_MIN_PX, BILLBOARD_MAX_DIST_KPC, BILLBOARD_OPACITY,
		objectProbabilitiesAt, placeObjects,
		objectMemberSeed,
		sampleMemberOffset, objectQuotas, writeObjectMembers,
		objectHasGas, billboardScreenPx, billboardVisible, writeObjectBillboards,
		summariseObjects,
	};
	if (typeof module !== 'undefined') module.exports = ObjectsLib;
	if (typeof window !== 'undefined') window.ObjectsLib = ObjectsLib;
})();
