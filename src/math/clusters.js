// src/math/clusters.js
// Star clusters of THIS galaxy — and nothing else.
//
// A globular cluster is a bound group of stars inside the current galaxy:
// not a nebula (no gas, no billboard, no nebula tint — that layer is
// nebula.js / objects.js) and not another galaxy (no extragalactic object
// is modelled at this stage). What used to be predefined 'open' and
// 'globular' classes inside objects.js is replaced here by ONE generalized
// family (plan.md §10): every cluster is the same kind of object, and where
// it sits in this galaxy decides what it looks like, continuously.
//
// The one formula, per cluster:
//   centre     a field-sampler candidate, accepted with probability
//              RATE × (ρ_spheroid + ρ_halo + ½ρ_thick + gasWeight·ρ_thin)/ρ_total
//              at that point — centres trace the stellar density that can
//              host a cluster, in the disc and in the spheroid alike.
//   component  one draw from the local component fractions; the age is then
//              drawn from that component's formation window
//              (galaxy.FORMATION_WINDOW) over the model's own star-forming
//              span. Halo draws are old because the halo formed first; thin
//              draws are younger. No class, no per-class age box.
//   size       Plummer scale a, log-drawn over [SCALE_MIN, SCALE_MAX] and
//              shrunk by the spheroid/halo fraction at the centre; tidal
//              radius a·10^c with the concentration c continuous over
//              [CONC_MIN, CONC_MAX] and raised by the same fraction. Diffuse
//              young disc clusters and compact old spheroid clusters are
//              the two ends of this continuum, not two types.
//   members    one truncated Plummer law for every cluster (see
//              plummerRadius), coeval at the cluster's age through the same
//              IMF pipeline as field stars.
//   count      proportional to the galaxy's delivered stellar mass against
//              the Milky Way preset (COUNT_AT_REFERENCE clusters there).
//
// Proper motion: a cluster moves as one rigid object. All its member records
// carry the cluster's orbit family, the cluster's jitter byte, and
// StarRecord.FLAG_CLUSTER with the cluster centre's 5-bit sub-grid residue
// packed into the low mantissa bits of each member's f32 coordinates
// (orbit.packClusterCoord / orbit.clusterCentre). The movement engines
// evaluate the orbit at the shared cluster centre C(T) and add back each
// member's rigid birth offset delta = p0 - C(0), so a cluster never shears
// into an arc under differential rotation. Disk and bulge clusters orbit on
// broadly prograde paths aligned with the Galactic disk; halo clusters
// distribute orbital directions broadly in 3-D with no single dominant
// rotation.
//
// Density budget (plan §10): at true scale the cluster system is
// TRUE_FRACTION of the galaxy's stars, which in a 100 000-star render is
// ~100 particles over ~160 clusters — invisible. The rendered budget is
// therefore fieldStars × TRUE_FRACTION × exaggeration, a deliberate visual
// exaggeration, not a scale ratio: ×1 is honest, ×0 is off, and the
// coefficient is a view control (menu / `clusters=` preset key) in the
// same sense as the pattern-speed multiplier. It never reads the galaxy's
// density back: raising the field budget raises the cluster budget in
// proportion, so clusters cannot outweigh the galaxy they sit in.
//
// Units: kpc. Ages: Gyr. Member i of cluster j is a pure function of
// (seed, j, i), like every other procedural star here.

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
	const starTypes = (typeof module !== 'undefined' && module.exports)
		? require('./star-types.js')
		: window.StarTypesLib;
	const records = (typeof module !== 'undefined' && module.exports)
		? require('./star-record.js')
		: window.StarRecord;
	const orbit = (typeof module !== 'undefined' && module.exports)
		? require('./orbit.js')
		: window.OrbitLib;
	const objects = (typeof module !== 'undefined' && module.exports)
		? require('./objects.js')
		: window.ObjectsLib;

	// Cluster systems at true scale: the Milky Way's ~150 globulars plus its
	// disc clusters hold on the order of a tenth of a percent of its stars.
	const CLUSTER_TRUE_FRACTION = 0.001;
	// The default exaggeration lands a 100k-star galaxy at ~5 000 cluster
	// particles over ~160 clusters — the 10–100-per-cluster band the layer
	// is meant to be seen at. It is a display coefficient, not physics.
	const CLUSTER_EXAGGERATION_DEFAULT = 50;
	const CLUSTER_EXAGGERATION_MAX = 200;
	// Clusters in the reference galaxy (the Milky Way preset); every other
	// model scales by its delivered stellar mass against the same preset.
	const CLUSTER_COUNT_REFERENCE = 160;
	const CLUSTER_HOST_RATE = 0.08;
	// Plummer scale (kpc): 0.5–4 pc, log-drawn.
	const CLUSTER_SCALE_MIN = 0.0005;
	const CLUSTER_SCALE_MAX = 0.004;
	// Concentration c = log10(r_tidal / a), continuous.
	const CLUSTER_CONC_MIN = 0.7;
	const CLUSTER_CONC_MAX = 1.9;
	// Relative cluster mass weights span this ratio (heaviest / lightest);
	// the member budget is apportioned over them. The ratio is what keeps
	// the apportioned quotas in the intended band at the default
	// coefficient: at 100k field stars the typical cluster lands at
	// ~10–100 particles, the single heaviest only modestly above.
	const CLUSTER_WEIGHT_RATIO = 4;
	// Reference Milky Way cluster split: ~75% metal-poor halo globulars to
	// ~25% disk/bulge clusters (Zinn 1985; Harris 1996/2010; Peng et al. 2006;
	// Kruijssen 2015). Because the field stellar halo holds ~0.1% of the
	// galaxy's stellar mass while hosting ~75% of its surviving clusters, the
	// halo's specific cluster frequency is ~1000x the field's.
	const CLUSTER_HALO_FRACTION_REFERENCE = 0.75;
	const CLUSTER_HALO_SPECIFIC_FREQUENCY = 1000;
	const CLUSTER_HALO_CORE_FACTOR = 2.5;
	const CLUSTER_HALO_RMAX_KPC = 35;
	const CLUSTER_THIN_SURVIVAL = 0.25;

	// The exaggeration coefficient: view state, one number, clamped in the
	// one place that writes it (the orbit sliders' contract).
	let clusterExaggeration = CLUSTER_EXAGGERATION_DEFAULT;
	function setClusterExaggeration(value) {
		const v = Number(value);
		clusterExaggeration = v > CLUSTER_EXAGGERATION_MAX ? CLUSTER_EXAGGERATION_MAX : (v > 0 ? v : 0);
		return clusterExaggeration;
	}
	function getClusterExaggeration() { return clusterExaggeration; }

	// Rendered cluster-particle budget for a field of `fieldStars` stars.
	// Linear in both the budget and the coefficient, by construction.
	function clusterMemberBudget(fieldStars, exaggeration) {
		const e = exaggeration === undefined ? clusterExaggeration : Math.max(0, Number(exaggeration) || 0);
		return Math.round(Math.max(0, Number(fieldStars) || 0) * CLUSTER_TRUE_FRACTION * e);
	}

	// Delivered stellar mass of the reference preset, measured once: the
	// delivered masses already carry the truncation, so this is the mass
	// the sampler can actually show, in the field's own units.
	let referenceMass = 0;
	let referenceInSituShare = 0;
	function referenceDeliveredMass() {
		if (!(referenceMass > 0)) {
			const m = sampling.deliveredMasses(galaxy.MILKY_WAY);
			referenceMass = m.total;
			const inSitu = m.bulge + 0.5 * m.thick + CLUSTER_THIN_SURVIVAL * m.thin;
			referenceInSituShare = m.total > 0 ? inSitu / m.total : 0.25;
		}
		return referenceMass;
	}

	// Component cluster-hosting weights for `model`, across galaxy types and
	// galaxy ages:
	//   - At the Milky Way reference (SBb at 13.5 Gyr), haloFraction = 0.75
	//     (75% halo to 25% disk/bulge).
	//   - Across morphology, gas-rich late-type spirals and irregulars boost
	//     young thin-disc cluster formation (~30-35% disk/bulge, ~65-70% halo),
	//     while gas-poor lenticulars shift their in-situ share to the bulge and
	//     thick disc (~70% halo, ~30% bulge+thick); halo-less ellipticals
	//     (masses.halo = 0) keep 100% in their spheroid component.
	//   - Across galaxy age, young gas-rich discs form a higher share of bound
	//     in-situ disc clusters that progressively dissolve by GMC/bar tidal
	//     shocks as gas is consumed over cosmic time, raising the surviving
	//     halo fraction smoothly with age to 75% at AGE_REF.
	function clusterComponentWeights(model) {
		if (!model) return { thin: 0, thick: 0, bulge: 0, halo: 0, total: 0, haloFraction: 0, diskBulgeFraction: 0 };
		referenceDeliveredMass();
		const masses = sampling.deliveredMasses(model);
		if (!(masses.total > 0)) {
			return { thin: 0, thick: 0, bulge: 0, halo: 0, total: 0, haloFraction: 0, diskBulgeFraction: 0 };
		}
		if (!(masses.halo > 0)) {
			return { thin: 0, thick: 0, bulge: 1, halo: 0, total: 1, haloFraction: 0, diskBulgeFraction: 1 };
		}
		const pop = model.populations || {};
		const gasWeight = pop.gasRich ? pop.gasNow / galaxy.GAS_NORMAL : 0;
		const age = pop.age > 0 ? pop.age : galaxy.AGE_REF;
		const ageFactor = 1 + 0.6 * Math.max(0, 1 - age / galaxy.AGE_REF);
		const bulge = masses.bulge / masses.total;
		const thick = 0.5 * (masses.thick / masses.total);
		const thin = CLUSTER_THIN_SURVIVAL * gasWeight * ageFactor * (masses.thin / masses.total);
		const inSitu = bulge + thick + thin;
		const halo = (CLUSTER_HALO_FRACTION_REFERENCE / (1 - CLUSTER_HALO_FRACTION_REFERENCE)) * referenceInSituShare;
		const total = inSitu + halo;
		if (!(total > 0)) {
			return { thin: 0, thick: 0, bulge: 0, halo: 1, total: 1, haloFraction: 1, diskBulgeFraction: 0 };
		}
		return {
			thin: thin / total,
			thick: thick / total,
			bulge: bulge / total,
			halo: halo / total,
			total: 1,
			haloFraction: halo / total,
			diskBulgeFraction: inSitu / total,
		};
	}

	// How many clusters this galaxy hosts: its delivered stellar mass
	// against the reference galaxy's, at the reference count. An empty
	// model hosts none.
	function clusterCountFor(model) {
		if (!model) return 0;
		const masses = sampling.deliveredMasses(model);
		if (!(masses.total > 0)) return 0;
		return Math.round(CLUSTER_COUNT_REFERENCE * masses.total / referenceDeliveredMass());
	}

	// The hosting environment at a position: how much of the local stellar
	// density can host a cluster, and how much of it is the old spheroid /
	// halo population. The halo density is weighted by its specific cluster
	// frequency so outer-halo positions reflect their old globular character.
	function clusterEnvironment(model, x, y, z) {
		const dec = density.rhoDecomposed(model, x, y, z);
		const haloCluster = dec.halo * CLUSTER_HALO_SPECIFIC_FREQUENCY;
		const total = dec.thin + dec.thick + dec.bulge + haloCluster;
		const gasWeight = model.populations.gasRich ? model.populations.gasNow / galaxy.GAS_NORMAL : 0.0;
		const hostMass = dec.bulge + haloCluster + 0.5 * dec.thick + gasWeight * dec.thin;
		let dom = 'thin';
		let best = dec.thin;
		if (dec.thick > best) { dom = 'thick'; best = dec.thick; }
		if (dec.bulge > best) { dom = 'bulge'; best = dec.bulge; }
		if (haloCluster > best) { dom = 'halo'; best = haloCluster; }
		return {
			dec, dom,
			host: total > 0 ? Math.min(1, hostMass / total) : 0,
			oldFrac: total > 0 ? (dec.bulge + haloCluster) / total : 0,
		};
	}

	const dirScratch = new Float64Array(3);

	// Place up to N clusters (default: this galaxy's own count). Candidates
	// come from the field sampler (inside `box`, or whole-galaxy when `box`
	// is null), accepted with CLUSTER_HOST_RATE × host, and assigned between
	// the spherical halo and the disk/bulge components according to
	// clusterComponentWeights(model). Centres are snapped to orbit.CLUSTER_GRID_STEP
	// so every member record encodes the exact cluster centre for rigid motion.
	function placeStarClusters(model, seed, N, box) {
		const count = N === undefined || N === null ? clusterCountFor(model) : Math.max(0, Math.round(N));
		const out = [];
		if (count === 0) return out;
		const weights = clusterComponentWeights(model);
		const batch = sampling.createBuffers(4096);
		let batchSeed = seed | 0;
		let attempts = 0;
		const maxAttempts = count * 4096;
		const galaxyAge = model.populations.age;
		const sfhSpan = model.populations.sfhSpan > 0 ? model.populations.sfhSpan : galaxyAge;
		const gasWeight = model.populations.gasRich ? model.populations.gasNow / galaxy.GAS_NORMAL : 0.0;
		const ageFactor = 1 + 0.6 * Math.max(0, 1 - galaxyAge / galaxy.AGE_REF);
		const haloCut = Math.min((model.halo && model.halo.rMax) || CLUSTER_HALO_RMAX_KPC,
			CLUSTER_HALO_RMAX_KPC * (model.scaleKpc || 1));
		const haloMass = weights.halo > 0 ? density.haloRadialMass(model, haloCut) : 0;
		while (out.length < count && attempts < maxAttempts) {
			if (box) sampling.sampleStarsInBox(model, batchSeed, 4096, box, batch);
			else sampling.sampleGalaxyStars(model, batchSeed, 4096, batch);
			if (batch.count === 0) break;
			batchSeed = (Math.imul(batchSeed, 0x9e3779b1) + 0x2545f491) | 0;
			for (let i = 0; i < batch.count && out.length < count; i++) {
				attempts++;
				let x = orbit.snapClusterCoord(batch.x[i]);
				let y = orbit.snapClusterCoord(batch.y[i]);
				let z = orbit.snapClusterCoord(batch.z[i]);
				let env = clusterEnvironment(model, x, y, z);
				const base = (seed | 0) + batchSeed + i;
				if (hash.hash01At(base, 0) >= CLUSTER_HOST_RATE * env.host) continue;
				const isHalo = haloMass > 0 && hash.hash01At(base, 6) < weights.halo;
				let component;
				if (isHalo) {
					const r = sampling.sampleHaloRadius(model, hash.hash01At(base, 7), haloMass);
					sampling.sampleDirection(hash.hash01At(base, 8), hash.hash01At(base, 9), dirScratch);
					x = orbit.snapClusterCoord(model.centre.x + r * dirScratch[0]);
					y = orbit.snapClusterCoord(model.centre.y + r * dirScratch[1]);
					z = orbit.snapClusterCoord(model.centre.z + r * dirScratch[2]);
					if (box && (x < box.xMin || x > box.xMax || y < box.yMin || y > box.yMax || z < box.zMin || z > box.zMax)) {
						continue;
					}
					env = clusterEnvironment(model, x, y, z);
					component = density.COMPONENT_HALO;
				} else {
					const wThin = CLUSTER_THIN_SURVIVAL * gasWeight * ageFactor * env.dec.thin;
					const wThick = 0.5 * env.dec.thick;
					const wBulge = env.dec.bulge;
					const wSum = wThin + wThick + wBulge;
					if (wSum > 0) {
						const u = hash.hash01At(base, 1) * wSum;
						component = u < wThin ? density.COMPONENT_THIN
							: (u < wThin + wThick ? density.COMPONENT_THICK : density.COMPONENT_BULGE);
					} else {
						component = density.sampleComponentIndex(env.dec, hash.hash01At(base, 1));
					}
				}
				const w0 = galaxy.FORMATION_WINDOW[component * 2];
				const w1 = galaxy.FORMATION_WINDOW[component * 2 + 1];
				const formedAt = sfhSpan * (w0 + hash.hash01At(base, 2) * (w1 - w0));
				const ageGyr = Math.min(galaxyAge, Math.max(0.001, galaxyAge - formedAt));
				// Size: one log draw, compacted by the old fraction; the
				// concentration is the same fraction read the other way.
				const scale = Math.min(CLUSTER_SCALE_MAX, Math.max(CLUSTER_SCALE_MIN,
					CLUSTER_SCALE_MIN * Math.pow(CLUSTER_SCALE_MAX / CLUSTER_SCALE_MIN, hash.hash01At(base, 3))
					* (1 - 0.35 * env.oldFrac)));
				const concentration = CLUSTER_CONC_MIN
					+ (CLUSTER_CONC_MAX - CLUSTER_CONC_MIN) * (0.7 * hash.hash01At(base, 4) + 0.3 * env.oldFrac);
				const weight = 1 / (1 - hash.hash01At(base, 5) * (1 - 1 / CLUSTER_WEIGHT_RATIO));
				out.push({
					x, y, z, scale, concentration,
					tidal: scale * Math.pow(10, concentration),
					ageGyr, weight, component,
					oldFrac: env.oldFrac,
					R: env.dec.R, phi: env.dec.phi, zp: env.dec.zp,
					distToArm: env.dec.distToArm,
					dominant: env.dom,
					index: out.length,
					seed: base,
				});
			}
		}
		return out;
	}

	// ---- member profile ----------------------------------------------------
	// Truncated Plummer for every cluster: M(<r) = r³/(r²+a²)^3/2, so
	// r = a/√(u^−2/3 − 1); u is scaled into the enclosed fraction at the
	// tidal radius, which truncates exactly. One law, no per-class profile.
	function plummerRadius(u, a, rt) {
		const enclosed = Math.pow(rt, 3) / Math.pow(rt * rt + a * a, 1.5);
		const v = u * enclosed;
		if (!(v > 0)) return 0;
		return a / Math.sqrt(Math.pow(v, -2 / 3) - 1);
	}

	function clusterMemberSeed(clusterSeed, i) {
		return objects.objectMemberSeed(clusterSeed, i);
	}

	// Offset of member i from the cluster centre (kpc), a pure function of
	// (cluster seed, i). `out` is a caller-provided length-3 array.
	function sampleClusterMemberOffset(cluster, i, out) {
		const memberSeed = clusterMemberSeed(cluster.seed | 0, i);
		const r = plummerRadius(hash.hash01At(memberSeed, 0), cluster.scale, cluster.tidal);
		sampling.sampleDirection(hash.hash01At(memberSeed, 1), hash.hash01At(memberSeed, 2), dirScratch);
		out[0] = r * dirScratch[0];
		out[1] = r * dirScratch[1];
		out[2] = r * dirScratch[2];
		return out;
	}

	// The cluster's bulk orbit family:
	//   - Young clusters (< 100 Myr) ride the spiral/bar pattern they formed in.
	//   - Disk and bulge clusters (components 0..2 in a disk galaxy with vFlat > 0)
	//     follow broadly prograde orbits aligned with the Galactic disk (FAMILY_BAR
	//     when barred, FAMILY_DISC otherwise).
	//   - Halo clusters (component 3) and pressure-supported ellipticals (vFlat = 0)
	//     use FAMILY_PRESSURE, whose orbital tangent directions span [0, 2π) with
	//     no single dominant rotation.
	function clusterFamily(model, cluster) {
		if (cluster.ageGyr < 0.1) return orbit.FAMILY_PATTERN;
		if (cluster.component === density.COMPONENT_BULGE && model && model.dynamics && model.dynamics.vFlat > 0) {
			return model.barred ? orbit.FAMILY_BAR : orbit.FAMILY_DISC;
		}
		return orbit.familyForStar(cluster.component, 'G', model && model.barred);
	}

	// The cluster's shared orbit jitter (epicycle phase / amplitude byte):
	// one wobble for the whole system, from the cluster's own seed.
	function clusterJitter(cluster) {
		return hash.pcgHash((cluster.seed | 0) ^ 0xFACE) & 0xFF;
	}

	let quotaScratch = new Uint32Array(0);
	const memberOffset = new Float64Array(3);
	const memberDerived = {};

	// Derive the apportioned members of `clusters` into StarPacked records
	// at `view` / `byteOffset`, capped at `maxMembers` (the rendered budget,
	// typically clusterMemberBudget(fieldStars)). Same identity / memberMeta
	// contract as objects.writeObjectMembers: the caller owns the block,
	// unwritten capacity stays all-zero, and each member's stable key plus
	// its coeval age / component are written beside the record so the
	// planet module can re-derive the star from its key.
	function writeClusterMembers(model, clusters, view, byteOffset, maxMembers, magOffset, identity, identityBase, memberMeta) {
		if (quotaScratch.length < clusters.length) {
			let n = Math.max(16, quotaScratch.length);
			while (n < clusters.length) n *= 2;
			quotaScratch = new Uint32Array(n);
		}
		// Weights are relative masses, so the budget is always spent in
		// proportion (objectQuotas' `fill` mode), never read as counts.
		objects.objectQuotas(clusters, maxMembers, quotaScratch, true);
		const offset = magOffset || 0;
		const gcX = model.centre.x;
		const gcY = model.centre.y;
		let slot = 0;
		for (let j = 0; j < clusters.length && slot < maxMembers; j++) {
			const cluster = clusters[j];
			const quota = quotaScratch[j];
			if (quota <= 0) continue;
			const family = clusterFamily(model, cluster);
			const jitter = clusterJitter(cluster);
			const flags = orbit.flagsWithFamily(records.FLAG_VISIBLE | records.FLAG_CLUSTER, family);
			for (let i = 0; i < quota && slot < maxMembers; i++) {
				const memberSeed = clusterMemberSeed(cluster.seed | 0, i);
				sampleClusterMemberOffset(cluster, i, memberOffset);
				const x = orbit.packClusterCoord(cluster.x, memberOffset[0]);
				const y = orbit.packClusterCoord(cluster.y, memberOffset[1]);
				const z = orbit.packClusterCoord(cluster.z, memberOffset[2]);
				const dx = x - gcX;
				const dy = y - gcY;
				const R = Math.sqrt(dx * dx + dy * dy);
				const distToArm = density.distanceToNearestArm(model, R, Math.atan2(dy, dx));
				starTypes.deriveStarWithAge(model, memberSeed, cluster.component, R, distToArm, cluster.ageGyr, memberDerived);
				records.writeRecord(view, byteOffset + slot * records.RECORD_BYTES, x, y, z,
					memberDerived.colorIndex, memberDerived.absMag + offset,
					flags, jitter);
				if (identity) identity[identityBase + slot] = memberSeed >>> 0;
				if (memberMeta) {
					memberMeta.age[slot] = cluster.ageGyr;
					memberMeta.component[slot] = cluster.component;
				}
				slot++;
			}
		}
		return { written: slot, clusters: clusters.length };
	}

	function summariseClusters(clusters) {
		const byComponent = {};
		let ageSum = 0;
		let weightSum = 0;
		for (const c of clusters) {
			const name = density.COMPONENT_NAMES[c.component];
			byComponent[name] = (byComponent[name] || 0) + 1;
			ageSum += c.ageGyr;
			weightSum += c.weight;
		}
		return {
			total: clusters.length,
			byComponent,
			meanAgeGyr: ageSum / Math.max(1, clusters.length),
			totalWeight: weightSum,
		};
	}

	const ClustersLib = {
		CLUSTER_TRUE_FRACTION, CLUSTER_EXAGGERATION_DEFAULT, CLUSTER_EXAGGERATION_MAX,
		CLUSTER_COUNT_REFERENCE, CLUSTER_HOST_RATE,
		CLUSTER_SCALE_MIN, CLUSTER_SCALE_MAX, CLUSTER_CONC_MIN, CLUSTER_CONC_MAX,
		CLUSTER_WEIGHT_RATIO,
		CLUSTER_HALO_FRACTION_REFERENCE, CLUSTER_HALO_SPECIFIC_FREQUENCY,
		CLUSTER_HALO_CORE_FACTOR, CLUSTER_HALO_RMAX_KPC, CLUSTER_THIN_SURVIVAL,
		setClusterExaggeration, getClusterExaggeration,
		clusterMemberBudget, clusterCountFor, clusterComponentWeights, clusterEnvironment,
		placeStarClusters, plummerRadius, clusterMemberSeed,
		sampleClusterMemberOffset, clusterFamily, clusterJitter,
		writeClusterMembers, summariseClusters,
	};
	if (typeof module !== 'undefined') module.exports = ClustersLib;
	if (typeof window !== 'undefined') window.ClustersLib = ClustersLib;
})();
