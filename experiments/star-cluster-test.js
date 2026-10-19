// experiments/star-cluster-test.js
// Validates the star-cluster layer (plan.md §10), the fix for globular
// clusters having been modelled as nebula-class objects:
//   - a cluster is a star system inside THIS galaxy: no nebula billboard,
//     no 'open'/'globular' class, no other galaxy anywhere in the path
//   - ONE generalized formula: centres, ages, sizes, concentrations and
//     weights are continuous draws from the local environment — old,
//     compact spheroid clusters and young, diffuse disc clusters are the
//     ends of the continuum, not predefined types
//   - the member budget is bounded by the selected galaxy star count:
//     fieldStars × 0.1% (true scale) × the exaggeration coefficient, so
//     at 100k field stars and the default ×50 a typical cluster renders
//     ~10–100 particles — a deliberate visual exaggeration, not a ratio
//   - proper motion: one orbit family and one jitter byte per cluster, so
//     the system moves as a whole instead of boiling apart
//
// Output: experiments/logs/star-cluster.json

'use strict';

const path = require('path');
const logFile = require('./log-file.js');
const clusters = require('../src/math/clusters.js');
const objects = require('../src/math/objects.js');
const galaxy = require('../src/math/galaxy.js');
const sampling = require('../src/math/sampling.js');
const records = require('../src/math/star-record.js');
const orbit = require('../src/math/orbit.js');
const hash = require('../src/math/hash.js');

const model = galaxy.MILKY_WAY;
const SEED = 12345;

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
	return !!pass;
}
const mean = (list, f) => list.reduce((a, x) => a + f(x), 0) / Math.max(1, list.length);
const sorted = (list) => [...list].sort((a, b) => a - b);

// --- Not nebulae, not other galaxies --------------------------------------
{
	check('the gas layer no longer carries cluster classes (objects.js is gas only)',
		JSON.stringify(objects.OBJECT_TYPES) === JSON.stringify(['HII', 'planetary', 'SNR'])
		&& objects.RICHNESS.open === undefined && objects.RICHNESS.globular === undefined,
		objects.OBJECT_TYPES);
	const placed = clusters.placeStarClusters(model, SEED, 40, null);
	check('a placed cluster has no nebula type at all (it is not a billboard object)',
		placed.every(c => c.type === undefined),
		placed.length ? Object.keys(placed[0]) : []);
	const buf = new ArrayBuffer(placed.length * objects.BILLBOARD_RECORD_BYTES);
	check('star clusters pack zero nebula billboards',
		objects.writeObjectBillboards(placed, new DataView(buf), 0, placed.length) === 0);
	check('every cluster centre lies inside this galaxy (within 40 kpc of its centre)',
		placed.every(c => Number.isFinite(c.x + c.y + c.z)
			&& Math.hypot(c.x - model.centre.x, c.y - model.centre.y, c.z - model.centre.z) < 40));
}

// --- One generalized formula, no classes ----------------------------------
const placed = clusters.placeStarClusters(model, SEED, undefined, null);
{
	check('placement carries no class label (no open/globular kinds exist)',
		placed.every(c => c.kind === undefined && c.cls === undefined && c.type === undefined));
	check('sizes are continuous draws, not per-class constants (over 100 distinct scales)',
		new Set(placed.map(c => c.scale)).size > 100, new Set(placed.map(c => c.scale)).size);
	check('ages are continuous draws, not per-class boxes (over 100 distinct ages)',
		new Set(placed.map(c => c.ageGyr)).size > 100, new Set(placed.map(c => c.ageGyr)).size);
	check('scale and concentration stay inside the generalized ranges',
		placed.every(c => c.scale >= clusters.CLUSTER_SCALE_MIN && c.scale <= clusters.CLUSTER_SCALE_MAX
			&& c.concentration >= clusters.CLUSTER_CONC_MIN && c.concentration <= clusters.CLUSTER_CONC_MAX
			&& Math.abs(c.tidal - c.scale * Math.pow(10, c.concentration)) < 1e-12));
	check('weights are continuous relative masses inside the documented ratio',
		placed.every(c => c.weight >= 1 && c.weight <= clusters.CLUSTER_WEIGHT_RATIO * (1 + 1e-9)),
		{ min: Math.min(...placed.map(c => c.weight)), max: Math.max(...placed.map(c => c.weight)) });
	const old = placed.filter(c => c.oldFrac > 0.5);
	const young = placed.filter(c => c.oldFrac < 0.1);
	check('the old spheroid end of the continuum is more compact and more concentrated',
		old.length > 10 && young.length > 10
		&& mean(old, c => c.scale) < mean(young, c => c.scale)
		&& mean(old, c => c.concentration) > mean(young, c => c.concentration),
		{ oldScalePc: +(mean(old, c => c.scale) * 1000).toFixed(2), youngScalePc: +(mean(young, c => c.scale) * 1000).toFixed(2),
			oldConc: +mean(old, c => c.concentration).toFixed(2), youngConc: +mean(young, c => c.concentration).toFixed(2) });
	check('one galaxy hosts the whole continuum (halo, bulge, thick and thin disc components all occur)',
		placed.some(c => c.component === 0) && placed.some(c => c.component === 1)
		&& placed.some(c => c.component === 2) && placed.some(c => c.component === 3),
		clusters.summariseClusters(placed).byComponent);
}

// --- Population split: ~75% halo / ~25% disk+bulge across types and ages --
{
	const mwWeights = clusters.clusterComponentWeights(model);
	check('reference Milky Way cluster weights are 75% halo to 25% disk/bulge',
		Math.abs(mwWeights.haloFraction - 0.75) < 1e-12
		&& Math.abs(mwWeights.diskBulgeFraction - 0.25) < 1e-12,
		mwWeights);
	const haloPlaced = placed.filter(c => c.component === 3).length / placed.length;
	const diskBulgePlaced = placed.filter(c => c.component !== 3).length / placed.length;
	check('placed Milky Way clusters realize the ~75% halo / ~25% disk+bulge split (within ±5%)',
		Math.abs(haloPlaced - 0.75) <= 0.05 && Math.abs(diskBulgePlaced - 0.25) <= 0.05,
		{ haloPlaced: +haloPlaced.toFixed(3), diskBulgePlaced: +diskBulgePlaced.toFixed(3) });

	const spiralTypes = ['S0', 'Sa', 'Sb', 'SBb', 'Sc', 'Sd'];
	const spiralWeights = spiralTypes.map(type => ({
		type,
		w: clusters.clusterComponentWeights(type === 'SBb' ? model : galaxy.createGalaxy({ type, seed: SEED })),
	}));
	const meanSpiralHalo = mean(spiralWeights, x => x.w.haloFraction);
	const s0W = spiralWeights.find(x => x.type === 'S0').w;
	const sdW = spiralWeights.find(x => x.type === 'Sd').w;
	check('average disk galaxies cluster around ~70-75% halo / ~25-30% disk+bulge',
		meanSpiralHalo >= 0.68 && meanSpiralHalo <= 0.78
		&& spiralWeights.every(x => x.w.haloFraction >= 0.60 && x.w.haloFraction <= 0.80),
		{ meanSpiralHalo: +meanSpiralHalo.toFixed(3), byType: Object.fromEntries(spiralWeights.map(x => [x.type, +x.w.haloFraction.toFixed(3)])) });
	check('morphology shifts the in-situ 25-35% share: S0 is bulge-heavy while gas-rich Sd is thin-disc-heavy',
		s0W.bulge > sdW.bulge && sdW.thin > s0W.thin && s0W.thin === 0,
		{ S0: { bulge: +s0W.bulge.toFixed(3), thin: +s0W.thin.toFixed(3) }, Sd: { bulge: +sdW.bulge.toFixed(3), thin: +sdW.thin.toFixed(3) } });

	const ageGrid = [0.5, 2, 5, 8, 13.5];
	const ageWeights = ageGrid.map(age => ({
		age,
		w: clusters.clusterComponentWeights(galaxy.createGalaxy({ type: 'SBb', age, seed: SEED })),
	}));
	let monoHalo = true;
	for (let i = 1; i < ageWeights.length; i++) {
		if (!(ageWeights[i].w.haloFraction > ageWeights[i - 1].w.haloFraction)) monoHalo = false;
	}
	check('halo cluster fraction rises monotonically with galaxy age as gas is consumed and disc clusters dissolve (to 75% at 13.5 Gyr)',
		monoHalo && ageWeights[0].w.haloFraction < 0.50
		&& Math.abs(ageWeights[ageWeights.length - 1].w.haloFraction - 0.75) < 1e-12,
		Object.fromEntries(ageWeights.map(x => [x.age + 'Gyr', +x.w.haloFraction.toFixed(3)])));
}

// --- Count follows the galaxy ---------------------------------------------
{
	check('the Milky Way preset hosts the reference count',
		clusters.clusterCountFor(model) === clusters.CLUSTER_COUNT_REFERENCE, clusters.clusterCountFor(model));
	check('the placed count is the model count, not a constant',
		placed.length === clusters.clusterCountFor(model), placed.length);
	for (const type of ['E4', 'Sc', 'Irr']) {
		const m = galaxy.createGalaxy({ type });
		const expect = Math.round(clusters.CLUSTER_COUNT_REFERENCE
			* sampling.deliveredMasses(m).total / sampling.deliveredMasses(model).total);
		check(`the ${type} cluster count scales with its delivered stellar mass`,
			clusters.clusterCountFor(m) === expect,
			{ type, count: clusters.clusterCountFor(m), expect });
	}
	const e4 = galaxy.createGalaxy({ type: 'E4' });
	check('a quenched elliptical still hosts (old, bulge) clusters — they were never nebulae',
		clusters.placeStarClusters(e4, SEED, undefined, null).every(c => c.component === 2));
	const empty = galaxy.createGalaxy({ type: 'E4', overrides: { spheroid: { amp: 0 } } });
	check('an empty model hosts no clusters',
		clusters.clusterCountFor(empty) === 0 && clusters.placeStarClusters(empty, SEED, undefined, null).length === 0);
}

// --- Ages never exceed the galaxy ------------------------------------------
{
	for (const age of [2, 5, 13.5]) {
		const m = galaxy.createGalaxy({ type: 'SBb', age });
		const cs = clusters.placeStarClusters(m, SEED, undefined, null);
		check(`no cluster is older than its ${age} Gyr galaxy`,
			cs.length > 0 && cs.every(c => c.ageGyr <= age + 1e-9 && c.ageGyr >= 0.001),
			{ age, count: cs.length, maxAge: Math.max(...cs.map(c => c.ageGyr)) });
	}
	const young = clusters.placeStarClusters(galaxy.createGalaxy({ type: 'SBb', age: 2 }), SEED, undefined, null);
	check('a 2 Gyr galaxy has no ancient (10+ Gyr) cluster forced into it',
		young.every(c => c.ageGyr < 10), Math.max(...young.map(c => c.ageGyr)));
}

// --- Budget: bounded by the selected star count ---------------------------
{
	check('the true-scale fraction is a tenth of a percent of the field',
		clusters.clusterMemberBudget(100000, 1) === 100, clusters.clusterMemberBudget(100000, 1));
	check('the budget is linear in the field budget (it cannot outweigh the galaxy)',
		clusters.clusterMemberBudget(200000, 50) === 2 * clusters.clusterMemberBudget(100000, 50)
		&& clusters.clusterMemberBudget(10000, 50) === 500,
		{ at100k: clusters.clusterMemberBudget(100000, 50), at200k: clusters.clusterMemberBudget(200000, 50) });
	check('the default coefficient puts 5000 particles into a 100k-star galaxy',
		clusters.CLUSTER_EXAGGERATION_DEFAULT === 50 && clusters.clusterMemberBudget(100000) === 5000,
		clusters.clusterMemberBudget(100000));
	check('coefficient 0 turns cluster particles off; the setter clamps to [0, 200]',
		clusters.clusterMemberBudget(100000, 0) === 0
		&& clusters.setClusterExaggeration(999) === 200
		&& clusters.setClusterExaggeration(-5) === 0
		&& clusters.setClusterExaggeration(NaN) === 0
		&& clusters.setClusterExaggeration(clusters.CLUSTER_EXAGGERATION_DEFAULT) === 50);

	const budget = clusters.clusterMemberBudget(100000);
	const buf = new ArrayBuffer(budget * records.RECORD_BYTES);
	const ages = new Float64Array(budget);
	const comps = new Int16Array(budget);
	const written = clusters.writeClusterMembers(model, placed, new DataView(buf), 0, budget, 0,
		new Uint32Array(budget), 0, { age: ages, component: comps }).written;
	check('the writer spends exactly the budget (never more than the field allows)',
		written === budget, { written, budget });
	const quotas = objects.objectQuotas(placed, budget, new Uint32Array(placed.length), true);
	const qs = sorted(Array.from(quotas));
	check('at 100k field stars the typical cluster renders ~10–100 particles (the accepted exaggeration)',
		qs[Math.floor(qs.length / 2)] >= 10 && qs[Math.floor(qs.length / 2)] <= 100
		&& qs[Math.floor(qs.length * 0.9)] <= 150,
		{ min: qs[0], median: qs[Math.floor(qs.length / 2)], p90: qs[Math.floor(qs.length * 0.9)], max: qs[qs.length - 1] });
	check('every placed cluster is represented (quota at least 1 at the default coefficient)',
		qs[0] >= 1, qs[0]);
	check('halving the coefficient halves the written members exactly',
		clusters.writeClusterMembers(model, placed, new DataView(new ArrayBuffer(2500 * records.RECORD_BYTES)), 0,
			clusters.clusterMemberBudget(100000, 25), 0, null, 0, null).written === 2500);
}

// --- Member profile ---------------------------------------------------------
{
	const cluster = { seed: 777, scale: 0.001, tidal: 0.02 };
	const out = new Float64Array(3);
	const N = 20000;
	const radii = new Float64Array(N);
	for (let i = 0; i < N; i++) {
		clusters.sampleClusterMemberOffset(cluster, i, out);
		radii[i] = Math.sqrt(out[0] * out[0] + out[1] * out[1] + out[2] * out[2]);
	}
	const enclosed = (r) => Math.pow(r, 3) / Math.pow(r * r + 0.001 * 0.001, 1.5);
	const total = enclosed(0.02);
	const fracBelow = (r) => {
		let n = 0;
		for (let i = 0; i < N; i++) if (radii[i] < r) n++;
		return n / N;
	};
	let worst = 0;
	for (const r of [0.001, 0.005, 0.01]) worst = Math.max(worst, Math.abs(fracBelow(r) - enclosed(r) / total));
	check('members follow the one truncated Plummer enclosed-mass curve (within 0.02)',
		worst < 0.02, +worst.toFixed(4));
	let max = 0;
	for (let i = 0; i < N; i++) if (radii[i] > max) max = radii[i];
	check('no member leaves the cluster tidal radius', max <= 0.02 * (1 + 1e-9), +max.toFixed(5));
}

// --- Coeval members, stable identity ---------------------------------------
{
	const cap = 3000;
	const buf = new ArrayBuffer(cap * records.RECORD_BYTES);
	const ages = new Float64Array(cap);
	const comps = new Int16Array(cap);
	const identity = new Uint32Array(cap);
	clusters.writeClusterMembers(model, placed, new DataView(buf), 0, cap, 0, identity, 0,
		{ age: ages, component: comps });
	const quotas = objects.objectQuotas(placed, cap, new Uint32Array(placed.length), true);
	let slot = 0;
	let metaOk = true;
	for (let j = 0; j < placed.length; j++) {
		for (let i = 0; i < quotas[j]; i++) {
			if (ages[slot] !== placed[j].ageGyr || comps[slot] !== placed[j].component
				|| identity[slot] !== (clusters.clusterMemberSeed(placed[j].seed | 0, i) >>> 0)) metaOk = false;
			slot++;
		}
	}
	check('members are coeval, share the cluster component, and carry stable member keys', metaOk);

	const oldOnes = placed.filter(c => c.ageGyr > 10).slice(0, 8);
	const oldCap = 8000;
	const oldBuf = new ArrayBuffer(oldCap * records.RECORD_BYTES);
	const oldWritten = clusters.writeClusterMembers(model, oldOnes, new DataView(oldBuf), 0, oldCap, 0, null, 0, null).written;
	const dv = new DataView(oldBuf);
	let youngClasses = 0;
	let oldClasses = 0;
	for (let i = 0; i < oldWritten; i++) {
		const cls = records.SPECTRAL_CLASSES[records.readRecord(dv, i * records.RECORD_BYTES).colorIndex];
		if (cls === 'O' || cls === 'B' || cls === 'A' || cls === 'F') youngClasses++;
		if (cls === 'RG' || cls === 'WD') oldClasses++;
	}
	check('old (globular-like) clusters have no O/B/A/F members',
		oldWritten > 0 && youngClasses === 0, { written: oldWritten, youngClasses });
	check('old clusters show the evolved mix (RG+WD over 1%)',
		oldWritten > 0 && oldClasses / oldWritten > 0.01,
		{ oldClasses, written: oldWritten, frac: +(oldClasses / oldWritten).toFixed(4) });
}

// --- Proper motion & orbital kinematics -----------------------------------
{
	const cap = 20000;
	const buf = new ArrayBuffer(cap * records.RECORD_BYTES);
	const dv = new DataView(buf);
	const written = clusters.writeClusterMembers(model, placed, dv, 0, cap, 0, null, 0, null).written;
	const quotas = objects.objectQuotas(placed, cap, new Uint32Array(placed.length), true);
	let slot = 0;
	let uniform = true;
	let exactCentres = true;
	for (let j = 0; j < placed.length; j++) {
		if (quotas[j] === 0) continue;
		const c = placed[j];
		const first = records.readRecord(dv, slot * records.RECORD_BYTES);
		if ((first.flags & records.FLAG_CLUSTER) === 0) uniform = false;
		for (let i = 0; i < quotas[j]; i++) {
			const r = records.readRecord(dv, (slot + i) * records.RECORD_BYTES);
			if (r.jitter !== first.jitter || r.flags !== first.flags) uniform = false;
			const cx = orbit.clusterCentreCoord(r.x);
			const cy = orbit.clusterCentreCoord(r.y);
			const cz = orbit.clusterCentreCoord(r.z);
			if (cx !== c.x || cy !== c.y || cz !== c.z) exactCentres = false;
		}
		slot += quotas[j];
	}
	check('every member of a cluster carries FLAG_CLUSTER, the cluster family, and the cluster jitter byte', uniform);
	check('every member record recovers the exact bit-identical cluster centre from its f32 coordinates alone',
		written > 0 && exactCentres, { written, exactCentres });

	// Rigid single-object motion vs the old per-member differential shear:
	// with FLAG_CLUSTER and the packed centre residue, all members of a
	// cluster move by the cluster centre's displacement and never stretch
	// into a curved arc, even after 2 000 Myr (multiple galactic orbits).
	const out = new Float64Array(3);
	const cPos = new Float64Array(3);
	const off = new Float64Array(3);
	const spreadRigid = (cluster, T) => {
		const fam = clusters.clusterFamily(model, cluster);
		const j = clusters.clusterJitter(cluster);
		const packed = records.packPacked(4, 4.83,
			orbit.flagsWithFamily(records.FLAG_VISIBLE | records.FLAG_CLUSTER, fam), j);
		orbit.orbitPosition(cPos, cluster.x, cluster.y, cluster.z, fam, j & 15, j >>> 4, T, model);
		let maxRadius = 0;
		let maxDrift = 0;
		for (let i = 0; i < 40; i++) {
			clusters.sampleClusterMemberOffset(cluster, i, off);
			const mx = orbit.packClusterCoord(cluster.x, off[0]);
			const my = orbit.packClusterCoord(cluster.y, off[1]);
			const mz = orbit.packClusterCoord(cluster.z, off[2]);
			orbit.engineRecordPosition(out, mx, my, mz, packed, T, model);
			const dx = out[0] - cPos[0], dy = out[1] - cPos[1], dz = out[2] - cPos[2];
			maxRadius = Math.max(maxRadius, Math.hypot(dx, dy, dz));
			maxDrift = Math.max(maxDrift, Math.hypot(dx - (mx - cluster.x), dy - (my - cluster.y), dz - (mz - cluster.z)));
		}
		return { ratio: maxRadius / cluster.tidal, drift: maxDrift };
	};
	const spreadUnanchored = (cluster, T, sharedJitter) => {
		const fam = clusters.clusterFamily(model, cluster);
		const pts = [];
		let cx = 0, cy = 0, cz = 0;
		for (let i = 0; i < 40; i++) {
			clusters.sampleClusterMemberOffset(cluster, i, off);
			const ms = clusters.clusterMemberSeed(cluster.seed | 0, i);
			const j = sharedJitter ? clusters.clusterJitter(cluster) : (hash.pcgHash(ms ^ 0xFACE) & 0xFF);
			orbit.orbitPosition(out, cluster.x + off[0], cluster.y + off[1], cluster.z + off[2],
				fam, j & 15, j >>> 4, T, model);
			pts.push([out[0], out[1], out[2]]);
			cx += out[0]; cy += out[1]; cz += out[2];
		}
		cx /= pts.length; cy /= pts.length; cz /= pts.length;
		let md = 0;
		for (const p of pts) md = Math.max(md, Math.hypot(p[0] - cx, p[1] - cy, p[2] - cz));
		return md / cluster.tidal;
	};
	const med = (a) => a[Math.floor(a.length / 2)];
	const rigid50 = placed.map(c => spreadRigid(c, 50));
	const rigid2000 = placed.map(c => spreadRigid(c, 2000));
	const random50 = sorted(placed.map(c => spreadUnanchored(c, 50, false)));
	const sheared2000 = sorted(placed.map(c => spreadUnanchored(c, 2000, true)));
	check('after 50 Myr and 2000 Myr every cluster stays inside 1 tidal radius (moves as one rigid object, never a curved line)',
		rigid50.every(r => r.ratio <= 1.001 && r.drift < 1e-6)
		&& rigid2000.every(r => r.ratio <= 1.001 && r.drift < 1e-6),
		{ maxRatio50: +Math.max(...rigid50.map(r => r.ratio)).toFixed(4),
			maxRatio2000: +Math.max(...rigid2000.map(r => r.ratio)).toFixed(4),
			maxDriftKpc: Math.max(...rigid2000.map(r => r.drift)) });
	check('without rigid centre anchoring, differential rotation shears clusters >10x wider into arcs over 2000 Myr',
		med(sheared2000) > 10 * med(rigid2000.map(r => r.ratio)) && med(random50) > 5 * med(rigid50.map(r => r.ratio)),
		{ rigidMed2000: +med(rigid2000.map(r => r.ratio)).toFixed(2), shearedMed2000: +med(sheared2000).toFixed(2) });

	// Orbital directions:
	//   - Disk and bulge clusters follow broadly prograde orbits aligned with
	//     the Galactic disk (Lz = pl.nz > 0.98).
	//   - Halo clusters distribute orbital directions broadly in 3-D (both
	//     prograde and retrograde, plus polar/high-inclination orbits) with no
	//     single dominant rotation axis.
	const diskBulgeClusters = placed.filter(c => c.component !== 3);
	const haloClusters = placed.filter(c => c.component === 3);
	const planeFor = (c) => {
		const fam = clusters.clusterFamily(model, c);
		const j = clusters.clusterJitter(c);
		return orbit.orbitPlane(c.x - model.centre.x, c.y - model.centre.y, c.z - model.centre.z,
			fam, j & 15, j >>> 4, {});
	};
	const dbPlanes = diskBulgeClusters.map(planeFor);
	const haloPlanes = haloClusters.map(planeFor);
	const haloPrograde = haloPlanes.filter(p => p.nz > 0).length / Math.max(1, haloPlanes.length);
	const haloRetrograde = haloPlanes.filter(p => p.nz < 0).length / Math.max(1, haloPlanes.length);
	const haloPolar = haloPlanes.filter(p => Math.abs(p.nz) < 0.5).length / Math.max(1, haloPlanes.length);
	const meanLx = mean(haloPlanes, p => p.nx);
	const meanLy = mean(haloPlanes, p => p.ny);
	const meanLz = mean(haloPlanes, p => p.nz);
	const netHaloSpin = Math.hypot(meanLx, meanLy, meanLz);
	check('disk and bulge clusters follow broadly prograde orbits aligned with the Galactic disk',
		dbPlanes.length > 20 && dbPlanes.every(p => p.nz > 0.98),
		{ count: dbPlanes.length, minNz: +Math.min(...dbPlanes.map(p => p.nz)).toFixed(4) });
	check('halo clusters distribute orbital directions broadly (prograde, retrograde and polar) with no single dominant rotation',
		haloPlanes.length > 80
		&& haloPrograde >= 0.35 && haloRetrograde >= 0.35 && haloPolar >= 0.35
		&& netHaloSpin < 0.20,
		{ count: haloPlanes.length, prograde: +haloPrograde.toFixed(3), retrograde: +haloRetrograde.toFixed(3),
			polar: +haloPolar.toFixed(3), netSpin: +netHaloSpin.toFixed(3) });
}

// --- Determinism -------------------------------------------------------------
{
	const cap = 4000;
	const a = new ArrayBuffer(cap * records.RECORD_BYTES);
	const b = new ArrayBuffer(cap * records.RECORD_BYTES);
	const other = clusters.placeStarClusters(model, SEED + 1, undefined, null);
	const cBuf = new ArrayBuffer(cap * records.RECORD_BYTES);
	clusters.writeClusterMembers(model, placed, new DataView(a), 0, cap, 0, null, 0, null);
	clusters.writeClusterMembers(model, placed, new DataView(b), 0, cap, 0, null, 0, null);
	clusters.writeClusterMembers(model, other, new DataView(cBuf), 0, cap, 0, null, 0, null);
	const bytesA = new Uint8Array(a);
	const bytesB = new Uint8Array(b);
	const bytesC = new Uint8Array(cBuf);
	let same = bytesA.length === bytesB.length;
	for (let i = 0; i < bytesA.length; i++) if (bytesA[i] !== bytesB[i]) same = false;
	let diff = 0;
	for (let i = 0; i < bytesA.length; i++) if (bytesA[i] !== bytesC[i]) diff++;
	check('cluster placement and members are byte-identical for the same seed', same);
	check('a different seed moves the clusters', diff > bytesA.length * 0.5, diff);
}

// --- Report ------------------------------------------------------------------
const summary = clusters.summariseClusters(placed);
console.log(`\nMilky Way clusters: ${summary.total} (${Object.entries(summary.byComponent).map(([k, v]) => `${k} ${v}`).join(', ')}), mean age ${summary.meanAgeGyr.toFixed(1)} Gyr`);
console.log(`Budget at 100k field stars: ${clusters.clusterMemberBudget(100000)} particles (x${clusters.CLUSTER_EXAGGERATION_DEFAULT} of the true ${clusters.CLUSTER_TRUE_FRACTION * 100}%)`);

let passed = 0;
let failed = 0;
for (const c of checks) {
	if (c.pass) passed++; else failed++;
	console.log(`  ${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.pass ? '' : `  -> ${JSON.stringify(c.detail)}`}`);
}
console.log(`\n${passed}/${checks.length} passed, ${failed} failed`);

const logPath = path.join(__dirname, 'logs', 'star-cluster.json');
logFile.writeLog(logPath, {
	date: new Date().toISOString(),
	seed: SEED,
	summary,
	budgetAt100k: clusters.clusterMemberBudget(100000),
	totalChecks: checks.length,
	passed,
	failed,
	checks,
});
console.log('\n=== VERDICT ===');
console.log(failed === 0 ? 'PASS — star clusters are one generalized, budget-bound, coherently moving system inside this galaxy' : `FAIL — ${failed} checks failed`);
process.exit(failed === 0 ? 0 : 1);
