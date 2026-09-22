// src/math/objects.js
// Composite objects: an HII region *is* its OB association, a reflection nebula
// sits on its B stars, a globular cluster is a stellar system that happens to
// be spectacular. 0.3.2a places the objects and generates their member stars;
// 0.3.2b draws the gas as camera-facing billboards from the shell sizes below.
//
// Placement generalises nebula.js: candidates come from the field sampler and
// each is accepted with p = min(1, pHII + pOpen + pGlobular + pPlanetary + pSNR),
// the type rolled proportionally. Members are ordinary stars through the same
// IMF pipeline as field stars (star-types.js), coeval at the object's age, at
// centre + profile offset. Member i of object j is a pure function of
// (seed, j, i): the same galaxy rebuilds the same members on any machine.
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
	const OBJECT_TYPES = ['HII', 'open', 'globular', 'planetary', 'SNR'];
	// The renderer's objects block: 20k StarPacked records (320 KB), filled from
	// 400 whole-galaxy objects — enough that every type fills the budget (an E
	// from ~two dozen globulars, an Sc from ~two hundred associations/clusters).
	const OBJECT_MEMBERS_DEFAULT = 20000;
	const OBJECT_COUNT_DEFAULT = 400;

	// Acceptance rates at unit gas weight, on the ridge, in the midplane. HII
	// matches the loose gas layer's rate (it *is* that layer, with members);
	// open clusters are disc-wide at a lower rate; globulars scale with the
	// spheroid share (see objectContext); planetaries are the unchanged stellar
	// term; SNR are massive-star remnants, so the stellar term times the thin
	// fraction times an arm tracer.
	const RATE_HII = 0.05;
	const RATE_OPEN = 0.020;
	const RATE_GLOBULAR = 0.010;
	const RATE_STELLAR = 0.005;

	// Richness [lo, hi], uniform.
	const RICHNESS = {
		HII: [20, 200],
		open: [30, 300],
		globular: [200, 2000],
		planetary: [1, 1],
		SNR: [0, 0],
	};
	// HII effective radius (the fractal keeps candidates inside 2.5·R_e).
	const HII_R_MIN = 0.05;
	const HII_R_MAX = 0.15;
	// Open clusters: Plummer with a 1 pc scale, tidally cut at 10–30 pc.
	const OPEN_RC = 0.001;
	const OPEN_RT_MIN = 0.010;
	const OPEN_RT_MAX = 0.030;
	// Globulars: King W0 ≈ 6 (concentration c ≈ 1.1, x_t = 12), r_c 1–3 pc.
	const GLOB_RC_MIN = 0.001;
	const GLOB_RC_MAX = 0.003;
	const GLOB_XT = 12;
	// Coeval ages (Gyr): HII uniform, open log-uniform, globular uniform.
	const HII_AGE_MIN = 0.001;
	const HII_AGE_MAX = 0.020;
	const OPEN_AGE_MIN = 0.010;
	const OPEN_AGE_MAX = 1.0;
	const GLOB_AGE_MIN = 10.0;
	const GLOB_AGE_MAX = 13.0;
	const PLANETARY_AGE = 10.0;
	// Shell sizes for the billboard pass.
	const PLANETARY_SIZE = 0.002;
	const SNR_SIZE_MIN = 0.020;
	const SNR_SIZE_MAX = 0.120;
	// Gas types get a billboard; open/globular clusters are stars only.
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

	// Setup-time context for the per-candidate probabilities: the delivered
	// spheroid share, which the per-candidate path must not recompute (mass
	// quadrature per candidate would dominate placement).
	function objectContext(model) {
		const m = sampling.deliveredMasses(model);
		return { spheroidFrac: m.total > 0 ? m.bulge / m.total : 0 };
	}

	// Per-type acceptance probabilities at a position. The gas terms reuse the
	// nebula layer's lane, vertical scale and suppressions, so the young stars,
	// the gas clouds and the composite objects trace one lane.
	function objectProbabilitiesAt(model, x, y, z, ctx) {
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
		const pOpen = Math.min(1.0, RATE_OPEN * gasWeight * inDisc * gasBulgeSuppress * gasHaloSuppress);
		const globBias = dom === 'bulge' ? 3 : dom === 'halo' ? 1 : 0.15;
		const pGlobular = Math.min(1.0, RATE_GLOBULAR * (0.2 + 2 * ctx.spheroidFrac) * globBias);
		const pPlanetary = RATE_STELLAR * (dec.bulge > 0.05 ? 4.0 : 1.0) * (dom === 'halo' ? 0.3 : 1.0);
		const total = dec.thin + dec.thick + dec.bulge + dec.halo;
		const pSNR = pPlanetary * (total > 0 ? dec.thin / total : 0) * (0.5 + armBoost);
		return {
			p: Math.min(1.0, pHII + pOpen + pGlobular + pPlanetary + pSNR),
			pHII, pOpen, pGlobular, pPlanetary, pSNR, dec, dom,
		};
	}

	function pickObjectType(probs, u) {
		const total = probs.pHII + probs.pOpen + probs.pGlobular + probs.pPlanetary + probs.pSNR;
		let r = u * total;
		if ((r -= probs.pHII) < 0) return 'HII';
		if ((r -= probs.pOpen) < 0) return 'open';
		if ((r -= probs.pGlobular) < 0) return 'globular';
		if ((r -= probs.pPlanetary) < 0) return 'planetary';
		return 'SNR';
	}

	// Place up to N objects. Candidates come from the field sampler (inside
	// `box`, or whole-galaxy when `box` is null), each accepted with the
	// probability above. An empty model yields no objects.
	function placeObjects(model, seed, N, box) {
		const ctx = objectContext(model);
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
				const probs = objectProbabilitiesAt(model, x, y, z, ctx);
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
				} else if (type === 'open') {
					size = OPEN_RT_MIN + rSize * (OPEN_RT_MAX - OPEN_RT_MIN);
					ageGyr = Math.pow(10, Math.log10(OPEN_AGE_MIN)
						+ rAge * (Math.log10(OPEN_AGE_MAX) - Math.log10(OPEN_AGE_MIN)));
				} else if (type === 'globular') {
					size = GLOB_RC_MIN + rSize * (GLOB_RC_MAX - GLOB_RC_MIN);
					ageGyr = GLOB_AGE_MIN + rAge * (GLOB_AGE_MAX - GLOB_AGE_MIN);
				} else if (type === 'planetary') {
					size = PLANETARY_SIZE;
					ageGyr = PLANETARY_AGE;
				} else {
					size = SNR_SIZE_MIN + rSize * (SNR_SIZE_MAX - SNR_SIZE_MIN);
					ageGyr = 0.01;
				}
				// No object is older than its galaxy: the ranges above are the
				// observed present-day ones (a 10–13 Gyr globular, a 10 Gyr
				// planetary nebula), and a 1 Gyr galaxy has had no time to make
				// them. Clamping keeps the members' ages — which deriveStarWithAge
				// imposes on the whole object — inside the model's clock.
				const galaxyAge = model.populations.age;
				if (ageGyr > galaxyAge) ageGyr = galaxyAge;
				out.push({
					type, x, y, z, size, richness, ageGyr,
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
	// Plummer: M(<r) = r³/(r²+a²)^3/2, so r = a/√(u^−2/3 − 1); u is scaled into
	// the enclosed fraction at the tidal radius, which truncates exactly.
	function plummerRadius(u, a, rt) {
		const enclosed = Math.pow(rt, 3) / Math.pow(rt * rt + a * a, 1.5);
		const v = u * enclosed;
		if (!(v > 0)) return 0;
		return a / Math.sqrt(Math.pow(v, -2 / 3) - 1);
	}

	// King W0 ≈ 6 in x = r/r_c: ρ(x) ∝ ((1+x²)^−1/2 − (1+x_t²)^−1/2)², cut at
	// x_t. The profile depends on x alone, so one table serves every core
	// radius; the CDF is the same 1024-bin Simpson the discs and the bar use.
	const KING_STEPS = 1024;
	let kingGrid = null;
	let kingCdf = null;
	let kingTotal = 0;
	function kingProfile(x) {
		const t = 1 / Math.sqrt(1 + x * x) - 1 / Math.sqrt(1 + GLOB_XT * GLOB_XT);
		return t > 0 ? 4 * Math.PI * x * x * t * t : 0;
	}
	function kingSampler() {
		if (kingGrid) return;
		kingGrid = new Float64Array(KING_STEPS + 1);
		kingCdf = new Float64Array(KING_STEPS + 1);
		const h = GLOB_XT / KING_STEPS;
		for (let i = 0; i <= KING_STEPS; i++) kingGrid[i] = i * h;
		let total = 0;
		for (let i = 0; i < KING_STEPS; i++) {
			total += (h / 6) * (kingProfile(kingGrid[i])
				+ 4 * kingProfile(0.5 * (kingGrid[i] + kingGrid[i + 1]))
				+ kingProfile(kingGrid[i + 1]));
			kingCdf[i + 1] = total;
		}
		kingTotal = total;
	}
	function kingRadius(u, rc) {
		kingSampler();
		return rc * sampling.sampleTable(u, kingGrid, kingCdf, kingTotal);
	}

	function objectMemberSeed(objSeed, i) {
		return (Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(objSeed | 0, 0x85ebca6b)) | 0;
	}

	const dirScratch = new Float64Array(3);

	// Offset of member i from the object centre (kpc), a pure function of
	// (object seed, i). `out` is a caller-provided length-3 array.
	function sampleMemberOffset(obj, i, out) {
		const oSeed = obj.seed | 0;
		const memberSeed = objectMemberSeed(oSeed, i);
		if (obj.type === 'planetary') {
			out[0] = 0; out[1] = 0; out[2] = 0;
			return out;
		}
		if (obj.type === 'open' || obj.type === 'globular') {
			const u = hash.hash01At(memberSeed, 0);
			const r = obj.type === 'open'
				? plummerRadius(u, OPEN_RC, obj.size)
				: kingRadius(u, obj.size);
			sampling.sampleDirection(hash.hash01At(memberSeed, 1), hash.hash01At(memberSeed, 2), dirScratch);
			out[0] = r * dirScratch[0];
			out[1] = r * dirScratch[1];
			out[2] = r * dirScratch[2];
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

	// Quota of rendered members for object j: richness is a weight, and the
	// fixed block is apportioned over it, so a 2000-star globular renders ~10×
	// the members of a 200-star association instead of hogging the block, and
	// every placed object is represented. Cumulative rounding (Bresenham-style)
	// keeps the total exact in one pass with O(1) state: quota_j is 1 plus the
	// inner allocation over (richness − 1), which guarantees every non-empty
	// object at least its first member. When everything fits, quotas are the
	// richnesses; when even one member each does not fit (only via tiny test
	// caps — the renderer places 400 objects into 20000 slots), the first
	// objects win, in order.
	function objectQuotas(objects, maxMembers, quotas) {
		let total = 0;
		let nonzero = 0;
		for (let j = 0; j < objects.length; j++) {
			if (objects[j].richness <= 0) { quotas[j] = 0; continue; }
			total += objects[j].richness;
			nonzero++;
		}
		if (total <= maxMembers) {
			for (let j = 0; j < objects.length; j++) quotas[j] = objects[j].richness;
			return quotas;
		}
		if (nonzero > maxMembers) {
			let left = maxMembers;
			for (let j = 0; j < objects.length; j++) {
				quotas[j] = objects[j].richness > 0 && left-- > 0 ? 1 : 0;
			}
			return quotas;
		}
		const inner = total - nonzero;
		const budget = maxMembers - nonzero;
		let acc = 0;
		let prev = 0;
		for (let j = 0; j < objects.length; j++) {
			if (objects[j].richness <= 0) { quotas[j] = 0; continue; }
			acc += objects[j].richness - 1;
			const f = Math.floor(acc * budget / inner);
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
	function writeObjectMembers(model, objects, view, byteOffset, maxMembers, magOffset) {
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
			const thin = obj.type === 'HII' || obj.type === 'open';
			const component = thin ? density.COMPONENT_THIN
				: obj.type === 'globular' ? density.COMPONENT_HALO
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
				// old members (globulars) follow their component's law.
				const family = obj.ageGyr < 0.1
					? orbit.FAMILY_PATTERN
					: orbit.familyForStar(component, memberDerived.spectralClass, model.barred);
				records.writeRecord(view, byteOffset + slot * records.RECORD_BYTES, x, y, z,
					memberDerived.colorIndex, memberDerived.absMag + offset,
					orbit.flagsWithFamily(records.FLAG_VISIBLE, family),
					hash.pcgHash(memberSeed ^ 0xFACE) & 0xFF);
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
		OBJECT_TYPES, OBJECT_MEMBERS_DEFAULT, OBJECT_COUNT_DEFAULT,
		RATE_HII, RATE_OPEN, RATE_GLOBULAR, RATE_STELLAR,
		RICHNESS, HII_R_MIN, HII_R_MAX, OPEN_RC, OPEN_RT_MIN, OPEN_RT_MAX,
		GLOB_RC_MIN, GLOB_RC_MAX, GLOB_XT,
		HII_AGE_MIN, HII_AGE_MAX, OPEN_AGE_MIN, OPEN_AGE_MAX,
		GLOB_AGE_MIN, GLOB_AGE_MAX, PLANETARY_AGE,
		PLANETARY_SIZE, SNR_SIZE_MIN, SNR_SIZE_MAX,
		FRACTAL_RADIUS, FRACTAL_RETRIES,
		GAS_TYPES, BILLBOARD_RECORD_FLOATS, BILLBOARD_RECORD_BYTES,
		BILLBOARD_MIN_PX, BILLBOARD_MAX_DIST_KPC, BILLBOARD_OPACITY,
		objectContext, objectProbabilitiesAt, placeObjects,
		plummerRadius, kingRadius, sampleMemberOffset, objectQuotas, writeObjectMembers,
		objectHasGas, billboardScreenPx, billboardVisible, writeObjectBillboards,
		summariseObjects,
	};
	if (typeof module !== 'undefined') module.exports = ObjectsLib;
	if (typeof window !== 'undefined') window.ObjectsLib = ObjectsLib;
})();
