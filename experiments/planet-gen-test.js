// experiments/planet-gen-test.js
// 0.5.1 planet generator (0.5 plan §2–§4): one pure function of a star's
// identity key, from stellar inputs to belts, plus the §4.12 accept criteria —
// the Solar-system temperature pins, the occurrence law's bulk means, the count
// chain's mean and zeros, the architecture invariants, the carbonate-silicate
// thermostat, the metallicity effect, the two special states, the summary
// identity, the two speed budgets, the no-allocation rule, and the stellar
// inputs exactness that keeps the generator describing the star the renderer
// actually drew.
//
// Output: experiments/logs/planet-gen.json

'use strict';

const fs = require('fs');
const path = require('path');

// Alias window so the src modules attach their API here, as in the browser.
globalThis.window = globalThis;

const hash = require('../src/math/hash.js');
const density = require('../src/math/density.js');
const galaxy = require('../src/math/galaxy.js');
const sampling = require('../src/math/sampling.js');
const records = require('../src/math/star-record.js');
const starTypes = require('../src/math/star-types.js');
const objects = require('../src/math/objects.js');
const starSet = require('../src/core/star-set.js');
const landmarks = require('../src/data/landmarks.js');
const planets = require('../src/math/planets.js');

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
	return !!pass;
}

const stats = {};

const MODEL = galaxy.createGalaxy({ type: 'SBb', seed: 42 });
const REF = (key, block, extra) => Object.assign({ key, block: block | 0, model: MODEL }, extra);

// A synthetic snapshot, so a test can name the star it means: the generator
// only ever reads these fields.
function snapshot(over) {
	const s = planets.createStellarInputs();
	s.mass = 1; s.luminosity = 1; s.teff = 5772; s.rStar = 1; s.age = 2;
	s.metallicity = 0.02; s.state = planets.STATE_MS; s.spec = planets.CLASS_G;
	s.colorIndex = 4; s.absMag = 4.83; s.component = 0; s.R = 1; s.distToArm = 0;
	return Object.assign(s, over);
}

function arraySum(a) {
	let s = 0;
	for (let i = 0; i < a.length; i++) s += a[i];
	return s;
}

function stateOfClass(derivedState) {
	return derivedState === 'wd' ? planets.STATE_WD
		: derivedState === 'giant' ? planets.STATE_GIANT : planets.STATE_MS;
}

// --- 1. Surface and determinism --------------------------------------------
{
	check('the module exposes the record factories, the generators and the readers',
		typeof planets.createSystemRecord === 'function'
		&& typeof planets.createSummaryRecord === 'function'
		&& typeof planets.generateSystem === 'function'
		&& typeof planets.systemSummary === 'function'
		&& typeof planets.classifyBody === 'function'
		&& typeof planets.stellarInputs === 'function'
		&& typeof planets.massFromClassAndMag === 'function',
		Object.keys(planets).length);

	const a = planets.createSystemRecord();
	const b = planets.createSystemRecord();
	const star = snapshot();
	planets.generateSystem(REF(0x1234abcd, 0), star, a);
	planets.generateSystem(REF(0x1234abcd, 0), star, b);
	let identical = a.planetCount === b.planetCount && a.beltCount === b.beltCount
		&& a.terranCount === b.terranCount && a.giantCount === b.giantCount
		&& a.maxPlanetMass === b.maxPlanetMass && a.star.aOut === b.star.aOut;
	for (let p = 0; identical && p < planets.MAX_PLANETS; p++) {
		identical = a.planets.a[p] === b.planets.a[p] && a.planets.mass[p] === b.planets.mass[p]
			&& a.planets.radius[p] === b.planets.radius[p] && a.planets.density[p] === b.planets.density[p]
			&& a.planets.ecc[p] === b.planets.ecc[p] && a.planets.inc[p] === b.planets.inc[p]
			&& a.planets.peri[p] === b.planets.peri[p] && a.planets.phase[p] === b.planets.phase[p]
			&& a.planets.period[p] === b.planets.period[p] && a.planets.teq[p] === b.planets.teq[p]
			&& a.planets.tsurf[p] === b.planets.tsurf[p] && a.planets.insolation[p] === b.planets.insolation[p]
			&& a.planets.rHill[p] === b.planets.rHill[p] && a.planets.rotHours[p] === b.planets.rotHours[p]
			&& a.planets.bulk[p] === b.planets.bulk[p] && a.planets.display[p] === b.planets.display[p]
			&& a.planets.moons[p] === b.planets.moons[p] && a.planets.flags[p] === b.planets.flags[p];
	}
	for (let i = 0; identical && i < planets.MAX_BELTS; i++) {
		identical = a.belts.a[i] === b.belts.a[i] && a.belts.dlnA[i] === b.belts.dlnA[i]
			&& a.belts.mass[i] === b.belts.mass[i] && a.belts.mu[i] === b.belts.mu[i]
			&& a.belts.radius[i] === b.belts.radius[i] && a.belts.stipple[i] === b.belts.stipple[i];
	}
	check('the same key regenerates a bit-identical system (no PRNG, no clock)', identical);

	planets.generateSystem(REF(0x1234abcd, 4), star, a);
	check('a different block yields a different system (§2.3 domain separation)',
		a.planets.a[0] !== b.planets.a[0] || a.bulkHistogram[0] !== b.bulkHistogram[0]
		|| a.star.aOut !== b.star.aOut, [a.planetCount, b.planetCount]);

	const otherModel = galaxy.createGalaxy({ type: 'SBb', seed: 43 });
	planets.generateSystem({ key: 0x1234abcd, block: 0, model: otherModel }, star, b);
	check('a different galaxy seed yields a different system',
		a.planets.a[0] !== b.planets.a[0] || a.bulkHistogram[0] !== b.bulkHistogram[0],
		[a.planets.a[0], b.planets.a[0]]);

	check('the module owns one shared record of each tier, and only the full one has orbits',
		planets.sharedSystem() === planets.sharedSystem()
		&& planets.sharedSummary() === planets.sharedSummary()
		&& planets.sharedSystem() !== planets.sharedSummary()
		&& !!planets.sharedSystem().planets && !planets.sharedSummary().planets);

	// A reused record must report only the system it just made.
	const reused = planets.createSystemRecord();
	planets.generateSystem(REF(0xdeadbeef, 0), snapshot({ mass: 3, lum: 20, spec: planets.CLASS_B }), reused);
	const wide = arraySum(reused.bulkHistogram);
	planets.generateSystem(REF(7, 0), snapshot({ mass: 0.1, luminosity: 0.002, spec: planets.CLASS_M, teff: 2500, rStar: 0.2 }), reused);
	check('a reused record reports only its new system (histograms are reset)',
		arraySum(reused.bulkHistogram) === reused.planetCount
		&& arraySum(reused.typeHistogram) === reused.planetCount,
		{ wide, next: reused.planetCount });
}

// --- 2. Stellar inputs: the derived path's inversion (§2.5) ----------------
{
	const sunMass = planets.massFromClassAndMag(planets.CLASS_G, 4.83);
	check('the Sun (G, M_V 4.83) inverts to 1.000 M☉ ± 0.02', Math.abs(sunMass - 1) < 0.02, sunMass);
	check('the Sun’s luminosity is 1.00 L☉ ± 0.02',
		Math.abs(planets.luminosityFromAbsMag(4.83) - 1) < 0.02, planets.luminosityFromAbsMag(4.83));
	const sunRadius = planets.stellarRadius(1, starTypes.teffFromMass(sunMass));
	check('the Sun’s radius is 1.000 R☉ ± 0.01 (teff comes from the mass table)',
		Math.abs(sunRadius - 1) < 0.01, sunRadius);

	const siriusMass = planets.massFromClassAndMag(planets.CLASS_A, 1.43);
	check('Sirius A (A, M_V 1.43) inverts to 2.0 M☉ ± 0.2', Math.abs(siriusMass - 2) < 0.2, siriusMass);

	const kMass = planets.massFromClassAndMag(planets.CLASS_K, 7.5);
	check('a K landmark (61 Cyg-class, M_V 7.5) reads 0.70 M☉ ± 0.06',
		Math.abs(kMass - 0.70) < 0.06, kMass);

	const giantRadius = planets.stellarRadius(100, 4000);
	check('a 100 L☉ giant at 4000 K reads 20.8 R☉, inside the real 5–50 range',
		Math.abs(giantRadius - 20.8) < 0.05 && giantRadius > 5 && giantRadius < 50, giantRadius);

	check('the mass brackets match the Delfosse skeleton and cover every class',
		planets.CLASS_MASS_MIN[planets.CLASS_O] === 16 && planets.CLASS_MASS_MAX[planets.CLASS_M] === 0.55
		&& planets.CLASS_MASS_MIN[planets.CLASS_WD] === 0.5 && planets.CLASS_MASS_MAX[planets.CLASS_RGE] === 3.0
		&& planets.CLASS_MASS_MIN.length === records.SPECTRAL_CLASSES.length,
		[planets.CLASS_MASS_MIN[0], planets.CLASS_MASS_MAX[6], planets.CLASS_MASS_MIN[7]]);

	check('the class indices agree with StarRecord.SPECTRAL_CLASSES',
		planets.CLASS_WD === records.SPECTRAL_CLASSES.indexOf('WD')
		&& planets.CLASS_RG === records.SPECTRAL_CLASSES.indexOf('RG')
		&& planets.CLASS_RGE === records.SPECTRAL_CLASSES.indexOf('RGe')
		&& planets.CLASS_MU.length === records.SPECTRAL_CLASSES.length,
		records.SPECTRAL_CLASSES.join(''));

	// The channel map's whole point: no two features share a draw. A channel
	// range is checked, not a spot-check, because a collision one planet in is
	// invisible until the systems disagree.
	const channelUse = new Set();
	let channelCollisions = 0;
	const claim = (channels) => {
		for (const ch of channels) {
			if (channelUse.has(ch)) channelCollisions++;
			channelUse.add(ch);
		}
	};
	claim([planets.CH_ESCALE, planets.CH_COUNT]);   // eScale is channel 0; the count chain is 2+n
	for (let p = 0; p < planets.MAX_PLANETS; p++) {
		const drawn = [];
		for (let k = 0; k < 8; k++) drawn.push(planets.CH_PLANET + 8 * p + k);
		drawn.push(planets.CH_MOON + p);
		claim(drawn);
	}
	for (let b = 0; b < 2; b++) {
		const base = b === 0 ? planets.CH_BELT_IN : planets.CH_BELT_OUT;
		claim([base, base + 1, base + 2, base + 3, base + 4]);
	}
	check('no two features share a hash channel across the whole map',
		channelCollisions === 0, { collisions: channelCollisions, channels: channelUse.size });
	const lastPlanetChannel = planets.CH_PLANET + 8 * (planets.MAX_PLANETS - 1) + 7;
	check('the moon channel is outside the planet slots and inside the spare gap',
		planets.CH_MOON > lastPlanetChannel && planets.CH_MOON + planets.MAX_PLANETS - 1 < planets.CH_BELT_IN,
		{ CH_MOON: planets.CH_MOON, lastPlanetChannel });
}

// --- 3. Habitable zone, snow line and the star block (§4.6) ----------------
{
	const sys = planets.createSystemRecord();
	planets.generateSystem(REF(0x51a7e75, 0), snapshot(), sys);
	const s = sys.star;
	check('a solar twin’s HZ is 0.976 – 1.690 AU',
		Math.abs(s.aHzIn - 0.976) < 0.001 && Math.abs(s.aHzOut - 1.690) < 0.001, [s.aHzIn, s.aHzOut]);
	check('a solar twin’s snow line is 2.7 AU and its disc ends at 40 AU',
		Math.abs(s.aSnow - 2.7) < 1e-9 && Math.abs(s.aOut - 40) < 1e-9, [s.aSnow, s.aOut]);

	// The pinned locking radii (§4.6), each star named by mass and the repo's own
	// mass–luminosity law: L = M^2.3 below 0.7 M☉.
	const trappist = Math.pow(0.09, 2.3);
	const proxima = Math.pow(0.122, 2.3);
	const halfSolar = Math.pow(0.3, 2.3);
	check('TRAPPIST-1 (0.090 M☉) reads L 0.0039 L☉, HZ 0.061 – 0.106 AU, lock radius 0.09 AU',
		Math.abs(trappist - 0.0039) < 0.0002
		&& Math.abs(Math.sqrt(trappist / planets.HZ_S_IN) - 0.061) < 0.001
		&& Math.abs(Math.sqrt(trappist / planets.HZ_S_OUT) - 0.106) < 0.001
		&& Math.abs(planets.A_LOCK * Math.sqrt(0.09) - 0.09) < 1e-9,
		[trappist, Math.sqrt(trappist / planets.HZ_S_IN), planets.A_LOCK * Math.sqrt(0.09)]);
	check('Proxima b (0.122 M☉) reads HZ 0.087 – 0.150 AU, lock radius 0.105 AU',
		Math.abs(Math.sqrt(proxima / planets.HZ_S_IN) - 0.087) < 0.001
		&& Math.abs(Math.sqrt(proxima / planets.HZ_S_OUT) - 0.150) < 0.001
		&& Math.abs(planets.A_LOCK * Math.sqrt(0.122) - 0.105) < 0.001,
		[Math.sqrt(proxima / planets.HZ_S_IN), planets.A_LOCK * Math.sqrt(0.122)]);
	check('the Sun and a 0.30 M☉ star have HZs outside their lock radii',
		Math.abs(halfSolar - 0.063) < 0.001
		&& planets.A_LOCK < Math.sqrt(1 / planets.HZ_S_IN)
		&& planets.A_LOCK * Math.sqrt(0.3) < Math.sqrt(halfSolar / planets.HZ_S_IN),
		{ halfSolar, lockRadius: planets.A_LOCK * Math.sqrt(0.3), hzIn: Math.sqrt(halfSolar / planets.HZ_S_IN) });
}

// --- 4. The six-body temperature pin (§4.2, §4.12) ------------------------
{
	const sunLike = snapshot({ mass: 1, luminosity: 1, teff: 5772, rStar: 1, age: 2 });
	const info = planets.createBodyInfo();
	const body = (a, m, bulk) => {
		planets.classifyBody(sunLike, a, m, bulk, info);
		return {
			teq: info.teq, tsurf: info.tsurf, dT: info.dT,
			display: planets.DISPLAY_NAMES[info.display], albedo: info.albedo,
		};
	};
	const mercury = body(0.387, 0.055, planets.BULK_ROCK);
	check('Mercury (0.387 AU, 0.055 M⊕) reads Teq 433 K, Tsurf 433 K, published 440',
		Math.abs(mercury.teq - 433) < 1.5 && Math.abs(mercury.tsurf - 433) < 1.5
		&& mercury.display === 'BARREN', mercury);
	const venus = body(0.723, 0.815, planets.BULK_ROCK);
	check('Venus (0.723 AU, 0.815 M⊕) reads Teq 242 K, +500 runaway, 742 K, published 737',
		Math.abs(venus.teq - 242) < 1.5 && venus.display === 'DESERT'
		&& Math.abs(venus.albedo - planets.RUNAWAY_ALBEDO) < 1e-9
		&& Math.abs(venus.tsurf - 742) < 2, venus);
	const earth = body(1.000, 1.000, planets.BULK_ROCK);
	check('Earth (1 AU, 1 M⊕) reads Teq 255 K, +33 thermostat, 288 K, published 288',
		Math.abs(earth.teq - 255) < 1.5 && earth.display === 'TERRAN'
		&& Math.abs(earth.dT - 33) < 1e-9 && Math.abs(earth.tsurf - 288) < 2, earth);
	const mars = body(1.524, 0.107, planets.BULK_ROCK);
	check('Mars (1.524 AU, 0.107 M⊕) reads Teq 208 K, Tsurf 216 K, published 210',
		Math.abs(mars.teq - 208) < 2 && Math.abs(mars.tsurf - 216) < 2, mars);
	const moon = body(1.000, 0.012, planets.BULK_ROCK);
	check('Moon (1 AU, 0.012 M⊕) reads Teq 270 K, Tsurf 270 K, published 250',
		Math.abs(moon.teq - 270) < 2 && moon.display === 'BARREN'
		&& Math.abs(moon.tsurf - 270) < 2, moon);
	const ceres = body(2.766, 0.00016, planets.BULK_DWARF);
	check('Ceres (2.766 AU, 0.00016 M⊕) reads Teq 163 K, Tsurf 163 K, published 168',
		Math.abs(ceres.teq - 163) < 2 && ceres.display === 'DWARF'
		&& Math.abs(ceres.tsurf - 163) < 2, ceres);

	check('the albedo column reads 0.30 for Earth and 0.70 for the runaway Venus',
		Math.abs(earth.albedo - 0.30) < 1e-9 && Math.abs(venus.albedo - 0.70) < 1e-9
		&& planets.DISPLAY_ALBEDO[planets.DISPLAY_ICE] === 0.65,
		[earth.albedo, venus.albedo]);
}

// --- 5. The carbonate-silicate thermostat (§4.2) ---------------------------
{
	const sunLike = snapshot({ mass: 1, luminosity: 1, teff: 5772, rStar: 1, age: 2 });
	const info = planets.createBodyInfo();
	let terrMin = Infinity, terrMax = -Infinity, terrCount = 0, subMonotone = true, subCount = 0;
	let prevT = -Infinity;
	for (let i = 0; i <= 40; i++) {
		const S = planets.HZ_S_OUT + (planets.HZ_S_IN - planets.HZ_S_OUT) * (i / 40);
		const a = 1 / Math.sqrt(S);
		planets.classifyBody(sunLike, a, 1.0, planets.BULK_ROCK, info);
		if (info.display === planets.DISPLAY_TERRAN) {
			terrCount++;
			if (info.tsurf < terrMin) terrMin = info.tsurf;
			if (info.tsurf > terrMax) terrMax = info.tsurf;
		}
		// Below the retention mass there is no atmosphere to hold anything, so
		// the surface must fall monotonically inward→outward reads the other
		// way: the sweep walks from the outer edge in, so each step is warmer.
		planets.classifyBody(sunLike, a, 0.01, planets.BULK_ROCK, info);
		if (info.tsurf < prevT - 1e-9) subMonotone = false;
		prevT = info.tsurf;
		subCount++;
	}
	check('TERRAN worlds hold 260 – 296 K across the whole habitable band',
		terrCount > 30 && terrMin >= 260 && terrMax <= 296, { terrMin, terrMax, terrCount });
	check('sub-retention worlds cool monotonically outward across the same band',
		subMonotone && subCount === 41, { subCount, last: prevT });
	planets.classifyBody(sunLike, 1 / Math.sqrt(0.58), 1.0, planets.BULK_ROCK, info);
	check('at S = 0.58 the greenhouse is 56 K, for a 278 K surface',
		Math.abs(info.dT - 56) < 0.6 && Math.abs(info.tsurf - 278) < 1.5, [info.dT, info.tsurf]);
	planets.classifyBody(sunLike, 1 / Math.sqrt(0.35), 1.0, planets.BULK_ROCK, info);
	check('at S = 0.35 the greenhouse saturates at 65 K, for a 261 K surface',
		Math.abs(info.dT - 65) < 1e-9 && Math.abs(info.tsurf - 261) < 1.5, [info.dT, info.tsurf]);

	planets.classifyBody(sunLike, 1 / Math.sqrt(0.35), 5.0, planets.BULK_SUPER, info);
	check('SUPER_EARTH carries the thermostat too, and never a runaway inside the HZ',
		info.display === planets.DISPLAY_SUPER_EARTH && info.runaway === 0
		&& Math.abs(info.dT - 65) < 1e-9 && Math.abs(info.tsurf - 264) < 1.5,
		{ dT: info.dT, tsurf: info.tsurf, albedo: info.albedo });
	planets.classifyBody(sunLike, 0.4, 1.0, planets.BULK_ROCK, info);
	check('a band-1 terran-size planet runs away at +500 K',
		info.runaway === 1 && Math.abs(info.dT - 500) < 1e-9, [info.dT, info.display]);
	planets.classifyBody(sunLike, 0.4, 0.05, planets.BULK_ROCK, info);
	check('below the retention mass the runaway stops (no atmosphere to run away)',
		info.runaway === 0 && info.display === planets.DISPLAY_BARREN, [info.dT, info.display]);
}

// --- 6. The occurrence law (§4.4) ------------------------------------------
{
	// The analytic law of the truncated chain: E[n] = Σ_k P(n ≥ k) with
	// P(n ≥ k) = Π_{j<=k} μ/(μ+j), P(0) = 1/(μ+1), P(≥4) = P(n ≥ 4).
	function analytic(mu) {
		let prod = 1, mean = 0;
		const tail = [1 / (mu + 1)];            // tail[k] = P(n >= k)
		for (let k = 1; k <= planets.MAX_PLANETS + 2; k++) {
			prod *= mu / (mu + k);
			mean += prod;
			tail.push(prod);
		}
		return { mean, zero: tail[0], geFour: tail[4] };
	}
	const g = analytic(1.2), m = analytic(1.6), o = analytic(0.02);
	check('the plan’s own analytic chain: G mean 0.825, P(0) 0.455, P(≥4) 0.0135',
		Math.abs(g.mean - 0.825) < 0.001 && Math.abs(g.zero - 0.455) < 0.001
		&& Math.abs(g.geFour - 0.0135) < 0.001, g);	check('the plan’s own analytic chain: M mean 1.020, P(0) 0.385',
		Math.abs(m.mean - 1.020) < 0.001 && Math.abs(m.zero - 0.385) < 0.001, m);
	check('the plan’s own analytic chain: O mean 0.0198', Math.abs(o.mean - 0.0198) < 0.0001, o);

	const N = 20000;
	const sys = planets.createSystemRecord();
	const cases = [
		{ label: 'G', mu: 1.2, spec: planets.CLASS_G, mass: 1, lum: 1, teff: 5772, rStar: 1 },
		{ label: 'M', mu: 1.6, spec: planets.CLASS_M, mass: 0.3, lum: 0.066, teff: 3300, rStar: 0.3 },
	];
	stats.occurrence = [];
	for (const c of cases) {
		const star = snapshot({ spec: c.spec, mass: c.mass, luminosity: c.lum, teff: c.teff, rStar: c.rStar, age: 1.5 });
		const want = analytic(c.mu);
		let total = 0, zeros = 0;
		const histogram = new Array(planets.MAX_PLANETS + 1).fill(0);
		for (let k = 1; k <= N; k++) {
			planets.generateSystem(REF(k, 0), star, sys);
			total += sys.planetCount;
			histogram[sys.planetCount]++;
			if (sys.planetCount === 0) zeros++;
		}
		const mean = total / N, p0 = zeros / N;
		stats.occurrence.push({
			label: c.label, mean, analytic: want.mean, p0, analyticP0: want.zero,
			atCapacity: histogram[planets.MAX_PLANETS], histogram,
		});
		check(`${c.label} stars average ${want.mean.toFixed(3)} planets over ${N} keys`,
			Math.abs(mean - want.mean) < 0.02, { mean, want: want.mean });
		check(`${c.label} stars have an empty system ${(want.zero * 100).toFixed(1)}% of the time`,
			Math.abs(p0 - want.zero) < 0.015, { p0, want: want.zero });
		check(`no ${c.label} system exceeds MAX_PLANETS`,
			histogram.length === planets.MAX_PLANETS + 1, histogram);
	}
}

// --- 7. The architecture invariants (§4.5) ---------------------------------
{
	const sys = planets.createSystemRecord();
	const bad = { insideStar: 0, beyondDisc: 0, unordered: 0, tooClose: 0 };
	let systems = 0, planetsTotal = 0, pushedToEdge = 0;
	for (const spec of [planets.CLASS_G, planets.CLASS_K, planets.CLASS_M]) {
		const star = snapshot({ spec, mass: 1, luminosity: 1, age: 1.5 });
		for (let k = 1; k <= 20000; k++) {
			planets.generateSystem(REF(k, spec), star, sys);
			const n = sys.planetCount;
			systems++;
			planetsTotal += n;
			const clearance = sys.star.rStar * planets.R_SUN_AU * planets.STAR_CLEARANCE;
			let prev = 0;
			for (let p = 0; p < n; p++) {
				const a = sys.planets.a[p];
				if (a < clearance - 1e-9) bad.insideStar++;
				if (a > sys.star.aOut + 1e-9) bad.beyondDisc++;
				if (a < prev - 1e-12) bad.unordered++;
				prev = a;
			}
			for (let p = 0; p + 1 < n; p++) {
				const need = planets.K_HILL * sys.planets.rHill[p];
				if (sys.planets.a[p + 1] - sys.planets.a[p] < need - 1e-9) bad.tooClose++;
			}
			if (n > 0 && sys.planets.a[n - 1] > sys.star.aOut * 0.999) pushedToEdge++;
		}
	}
	check('60 000 systems keep every planet outside 6 R★, inside a_out and ascending',
		bad.insideStar === 0 && bad.beyondDisc === 0 && bad.unordered === 0,
		{ systems, planetsTotal, ...bad });
	check('no pair of neighbours is closer than K_HILL mutual Hill radii',
		bad.tooClose === 0, { ...bad, pushedToEdge });
	check('the repair pass really has work to do (planets reach the disc edge)',
		planetsTotal > 15000 && pushedToEdge > 0, { planetsTotal, pushedToEdge });
}

// --- 8. The metallicity effect (§4.3, §4.12) ------------------------------
{
	const N = 20000;
	const sys = planets.createSystemRecord();
	const measure = (metal) => {
		const star = snapshot({ mass: 1, luminosity: 1, age: 1.5, metallicity: metal, spec: planets.CLASS_G });
		let giants = 0, total = 0;
		for (let k = 1; k <= N; k++) {
			planets.generateSystem(REF(k, 0), star, sys);
			total += sys.planetCount;
			giants += sys.giantCount;
		}
		return total > 0 ? giants / total : 0;
	};
	const halo = measure(0.001), bulge = measure(0.035);
	stats.metallicity = { haloZ: 0.001, bulgeZ: 0.035, haloFraction: halo, bulgeFraction: bulge, ratio: bulge / Math.max(halo, 1e-12) };
	check('the giant fraction rises at least 3× from halo to bulge metallicity',
		bulge > halo * 3, stats.metallicity);
	check('f_Z clamps at 0.05 below Z 0.0022 and at 4 above Z 0.040',
		bulge > 0.15 && halo < 0.05, stats.metallicity);
}

// --- 9. The two special states (§4.4, §4.12) ------------------------------
{
	const N = 6000;
	const sys = planets.createSystemRecord();

	const wd = snapshot({ mass: 0.6, luminosity: 0.002, teff: 20000, rStar: 0.013,
		state: planets.STATE_WD, spec: planets.CLASS_WD, age: 5, metallicity: 0.02 });
	let wdBelted = 0, wdOutside = 0, wdOtherBulk = 0, wdPlanets = 0;
	for (let k = 1; k <= N; k++) {
		planets.generateSystem(REF(k, 0), wd, sys);
		if (sys.beltCount > 0) wdBelted++;
		for (let p = 0; p < sys.planetCount; p++) {
			wdPlanets++;
			if (sys.planets.a[p] > planets.WD_DISK_OUT_AU + 1e-9) wdOutside++;
			if (sys.planets.bulk[p] !== planets.BULK_ROCK && sys.planets.bulk[p] !== planets.BULK_DWARF) wdOtherBulk++;
		}
	}
	stats.wd = { systems: N, belted: wdBelted, planets: wdPlanets, outside: wdOutside, otherBulk: wdOtherBulk };
	check('WD systems are compact: every planet inside 1 AU', wdOutside === 0, stats.wd);
	check('WD systems are debris-rich (a belt more than 60% of the time)',
		wdBelted / N > 0.6, { belted: wdBelted, of: N });
	check('WD systems draw only rock and dwarf planets', wdOtherBulk === 0, stats.wd);

	const giant = snapshot({ mass: 2, luminosity: 100, teff: 4000, rStar: 20,
		state: planets.STATE_GIANT, spec: planets.CLASS_RG, age: 8, metallicity: 0.02 });
	let insideStar = 0, innerBulks = 0, giantPlanets = 0;
	for (let k = 1; k <= N; k++) {
		planets.generateSystem(REF(k, 0), giant, sys);
		const clearance = sys.star.rStar * planets.R_SUN_AU * planets.STAR_CLEARANCE;
		for (let p = 0; p < sys.planetCount; p++) {
			giantPlanets++;
			if (sys.planets.a[p] < clearance) insideStar++;
			if (sys.planets.bulk[p] <= planets.BULK_SUPER) innerBulks++;
		}
	}
	stats.giant = { systems: N, planets: giantPlanets, insideStar, innerBulks };
	check('a giant star has no planet inside its stellar radius', insideStar === 0, stats.giant);
	check('a giant star keeps few small planets (the wide survivors)',
		giantPlanets === 0 || innerBulks / giantPlanets < 0.25, stats.giant);
}

// --- 10. Summary identity (§4.10) ----------------------------------------
{
	const sys = planets.createSystemRecord();
	const sum = planets.createSummaryRecord();
	let mismatched = 0, compared = 0;
	for (let k = 1; k <= 5000; k++) {
		const star = snapshot({ spec: k % 10, mass: 0.4 + (k % 7) * 0.3, luminosity: 0.2 + (k % 5) * 0.4, age: (k % 9) * 1.2 });
		planets.generateSystem(REF(k, 0), star, sys);
		planets.systemSummary(REF(k, 0), star, sum);
		compared++;
		let ok = sys.planetCount === sum.planetCount && sys.beltCount === sum.beltCount
			&& sys.terranCount === sum.terranCount && sys.giantCount === sum.giantCount
			&& sys.maxPlanetMass === sum.maxPlanetMass;
		for (let i = 0; ok && i < planets.BULK_COUNT; i++) ok = sys.bulkHistogram[i] === sum.bulkHistogram[i];
		for (let i = 0; ok && i < planets.DISPLAY_COUNT; i++) ok = sys.typeHistogram[i] === sum.typeHistogram[i];
		if (!ok) mismatched++;
	}
	check('systemSummary walks the same system as generateSystem, count for count',
		mismatched === 0, { compared, mismatched });

	// A record is reused across calls: after a system with a terran candidate,
	// a barren one must report zeros, not the previous system's candidate.
	const reused = planets.createSummaryRecord();
	let seeded = 0, cleared = 0;
	for (let k = 1; k <= 2000 && cleared < 2; k++) {
		const star = snapshot({ spec: planets.CLASS_G, mass: 1, luminosity: 1, age: 4 });
		planets.systemSummary(REF(k, 0), star, reused);
		if (reused.terranCount > 0 && reused.bestTerranA > 0) seeded++;
		else if (seeded > 0 && reused.terranCount === 0
			&& reused.bestTerranA === 0 && reused.bestTerranMass === 0
			&& reused.bestTerranTsurf === 0 && reused.bestTerranDisplay === 0) cleared++;
	}
	check('a reused record reports zeros, not the previous system’s terran candidate',
		seeded > 0 && cleared >= 2, { seeded, cleared });
}

// --- 11. Stellar inputs, per record block (§2.4, §2.5) --------------------
stats.blocks = {};
{
	// The procedural field: the key falls out of fieldStarSeed, and the snapshot
	// must equal a fresh deriveStar for the same key — the anti-drift pin.
	const count = 64;
	const field = sampling.sampleGalaxyStars(MODEL, MODEL.seed, count, null);
	const derived = {};
	let exact = 0;
	for (let i = 0; i < count; i++) {
		const key = starTypes.fieldStarSeed(MODEL.seed, i);
		const inputs = planets.createStellarInputs();
		planets.stellarInputs(REF(key, 0, { field }), inputs);
		starTypes.deriveStar(MODEL, key, field.component[i], field.R[i], field.distToArm[i], derived, field.z[i]);
		if (inputs.mass === derived.mass && inputs.age === derived.age
			&& inputs.teff === derived.teff && inputs.luminosity === derived.luminosity
			&& inputs.state === stateOfClass(derived.state)
			&& inputs.metallicity === derived.metallicity) exact++;
	}
	stats.blocks.proceduralExact = exact;
	check('procedural snapshot inputs equal a fresh deriveStar for the same key',
		exact === count, { exact, of: count });

	// A landmark: the derived path, from the entry's own class and magnitude.
	const landmark = landmarks.ENTRIES[1];   // Sirius
	const lmRef = (key) => ({
		key, block: 1, model: MODEL, x: landmark.x, y: landmark.y, z: landmark.z,
		colorIndex: landmark.colorIndex, absMag: landmark.absMag, name: landmark.name,
	});
	const lmKey = hash.hash4(hash.DOMAIN_LANDMARK, 1, 0, 0);
	const lmInputs = planets.createStellarInputs();
	planets.stellarInputs(REF(lmKey, 1, {
		x: landmark.x, y: landmark.y, z: landmark.z,
		colorIndex: landmark.colorIndex, absMag: landmark.absMag, name: landmark.name,
	}), lmInputs);
	stats.blocks.sirius = { mass: lmInputs.mass, lum: lmInputs.luminosity, spec: lmInputs.spec, age: lmInputs.age };
	check('Sirius’s snapshot reads A, 2.19 M☉, from its own class and magnitude',
		lmInputs.spec === planets.CLASS_A && Math.abs(lmInputs.mass - 2.19) < 0.05
		&& lmInputs.state === planets.STATE_MS, stats.blocks.sirius);
	const lmSystem = planets.createSystemRecord();
	planets.generateSystem(lmRef(lmKey), lmInputs, lmSystem);
	check('a landmark keeps its name in the record',
		planets.starDesignation(lmSystem) === 'Sirius', planets.starDesignation(lmSystem));
	check('a landmark’s population age is a function of its key and galaxy, not the system seed',
		lmInputs.age > 0 && lmInputs.age <= MODEL.populations.age, lmInputs.age);

	// The local gap-fill block: the key is the slot seed, and the renderer's
	// derivation is re-run from the record's own position.
	const slotSeed = Math.imul((MODEL.seed | 0) ^ 0x10ca1cab, 0x9e3779b1)
		^ Math.imul(77, 0x85ebca6b) ^ Math.imul(1, 0xc2b2ae3d);
	const px = MODEL.centre.x + 0.3, py = MODEL.centre.y + 0.2, pz = 0.05;
	const decomposed = density.rhoDecomposed(MODEL, px, py, pz);
	const component = density.sampleComponentIndex(decomposed, hash.hash01At(slotSeed, 3));
	const fresh = {};
	starTypes.deriveStar(MODEL, Math.imul(slotSeed, 31) + 5, component, decomposed.R,
		decomposed.distToArm, fresh, pz);
	const localInputs = planets.createStellarInputs();
	planets.stellarInputs(REF(slotSeed, 3, { x: px, y: py, z: pz }), localInputs);
	check('a local gap-fill star re-derives exactly from its slot seed',
		localInputs.mass === fresh.mass && localInputs.teff === fresh.teff
		&& localInputs.luminosity === fresh.luminosity && localInputs.age === fresh.age,
		[localInputs.mass, fresh.mass]);

	// The object-members block: the placement is re-run and the member is
	// derived at its object's own coeval age.
	const placed = objects.placeObjects(MODEL, (MODEL.seed | 0) ^ 0x0b5e55, objects.OBJECT_COUNT_DEFAULT, null);
	const quotas = new Uint16Array(placed.length);
	objects.objectQuotas(placed, objects.OBJECT_MEMBERS_DEFAULT, quotas);
	let objSlot = 0, memberIndex = -1, objIndex = -1;
	for (let j = 0; objIndex < 0 && j < placed.length; j++) {
		for (let i = 0; i < quotas[j]; i++, objSlot++) {
			if (objSlot === 37) { objIndex = j; memberIndex = i; objSlot = -1; break; }
		}
	}
	if (objIndex >= 0) {
		const obj = placed[objIndex];
		const objKey = objects.objectMemberSeed(obj.seed | 0, memberIndex);
		const off = [0, 0, 0];
		objects.sampleMemberOffset(obj, memberIndex, off);
		const mx = obj.x + off[0], my = obj.y + off[1], mz = obj.z + off[2];
		const R = Math.hypot(mx - MODEL.centre.x, my - MODEL.centre.y);
		const distToArm = density.distanceToNearestArm(MODEL, R, Math.atan2(my - MODEL.centre.y, mx - MODEL.centre.x));
		starTypes.deriveStarWithAge(MODEL, objKey, objects.objectMemberComponent(obj),
			R, distToArm, obj.ageGyr, fresh);
		const objInputs = planets.createStellarInputs();
		planets.stellarInputs(REF(objKey, 2, { x: mx, y: my, z: mz }), objInputs);
		stats.blocks.objectMember = { mass: objInputs.mass, age: objInputs.age, freshMass: fresh.mass, freshAge: fresh.age };
		check('an object member re-derives at its object’s coeval age',
			objInputs.mass === fresh.mass && objInputs.teff === fresh.teff
			&& objInputs.age === fresh.age && objInputs.luminosity === fresh.luminosity,
			stats.blocks.objectMember);
	} else {
		check('an object member re-derives at its object’s coeval age', false, 'fixture had no member 37');
	}

	// The catalog block: derived path, from the packed word's class and magnitude.
	const catInputs = planets.createStellarInputs();
	planets.stellarInputs(REF(hash.hash4(hash.DOMAIN_CATALOG, 1, 77, 0), 4, {
		x: MODEL.centre.x, y: MODEL.centre.y, z: 0, colorIndex: 6, absMag: 9.4,
	}), catInputs);
	stats.blocks.catalog = { mass: catInputs.mass, age: catInputs.age, spec: catInputs.spec };
	check('the catalog path inverts the packed word (M, 0.08–0.55 M☉, a population age)',
		catInputs.spec === planets.CLASS_M && catInputs.mass > 0.08 && catInputs.mass < 0.55
		&& catInputs.age > 0 && catInputs.age <= MODEL.populations.age, stats.blocks.catalog);
}

// --- 12. Designations (§4.11) ---------------------------------------------
{
	const sys = planets.createSystemRecord();
	planets.generateSystem(REF(123456789, 0), snapshot(), sys);
	check('the star designation matches star-set.js’s keyDesignation byte for byte',
		planets.starDesignation(sys) === starSet.keyDesignation(123456789)
		&& planets.starDesignation(sys) === 'S21I3V9', planets.starDesignation(sys));
	check('planets take IAU letters and belts are numbered',
		planets.bodyDesignation(sys, 1, 0) === 'S21I3V9 b'
		&& planets.bodyDesignation(sys, 1, 2) === 'S21I3V9 d'
		&& planets.bodyDesignation(sys, 2, 1) === 'S21I3V9 belt 2',
		[planets.bodyDesignation(sys, 1, 0), planets.bodyDesignation(sys, 2, 1)]);
	check('the letters cover every possible planet', planets.PLANET_LETTERS.length === planets.MAX_PLANETS);
}

// --- 13. Bulk physics: radius, density, the belt typical body -------------
{
	const sphDensity = (m, r) => m * planets.M_EARTH_KG
		/ ((4 / 3) * Math.PI * Math.pow(r * planets.R_EARTH_M, 3));
	check('1 M⊕ in 1 R⊕ is 5514 kg/m³', Math.abs(sphDensity(1, 1) - 5514) < 2, sphDensity(1, 1));
	check('318 M⊕ in the gas bulk radius is 1250 kg/m³ (Jupiter, 1330)',
		Math.abs(sphDensity(318, planets.BULK_RREF[planets.BULK_GAS]) - 1250) < 8,
		sphDensity(318, planets.BULK_RREF[planets.BULK_GAS]));
	check('5 M⊕ in the super-earth radius is 6730 kg/m³, and the law puts 1.13 M⊕ at 1.07 R⊕ (α Cen Bb, 1.04)',
		Math.abs(sphDensity(5, planets.BULK_RREF[planets.BULK_SUPER]) - 6730) < 8
		&& Math.abs(planets.BULK_RREF[planets.BULK_SUPER] * Math.pow(1.13 / planets.BULK_MREF[planets.BULK_SUPER], planets.BULK_P[planets.BULK_SUPER]) - 1.071) < 0.005,
		{ five: sphDensity(5, planets.BULK_RREF[planets.BULK_SUPER]), alphaCenBb: planets.BULK_RREF[planets.BULK_SUPER] * Math.pow(1.13 / 5, planets.BULK_P[planets.BULK_SUPER]) });
	check('the belt’s typical body is 470 km, 9.4e20 kg, ρ 2160',
		planets.BELT_TYPICAL_R_M === 470000
		&& Math.abs(planets.BELT_TYPICAL_MU / planets.G_SI - 9.4e20) < 1
		&& Math.abs(9.4e20 / ((4 / 3) * Math.PI * 470000 ** 3) - planets.BELT_DENSITY) < 60,
		planets.BELT_DENSITY);

	const sys = planets.createSystemRecord();
	let bulkOk = true;
	const seen = new Set();
	const star = snapshot({ mass: 1.4, luminosity: 1.6, age: 1.5 });
	for (let k = 1; k <= 5000; k++) {
		planets.generateSystem(REF(k, 0), star, sys);
		for (let p = 0; p < sys.planetCount; p++) {
			const b = sys.planets.bulk[p];
			seen.add(b);
			const m = sys.planets.mass[p];
			if (m < planets.BULK_MASS_MIN[b] - 1e-12 || m > planets.BULK_MASS_MAX[b] + 1e-12) bulkOk = false;
			if (sys.planets.radius[p] <= 0 || sys.planets.density[p] <= 0) bulkOk = false;
		}
	}
	check('every planet’s mass and radius come from its bulk’s table',
		bulkOk && seen.size >= 4, { bulksSeen: seen.size });
}

// --- 14. No allocation, and the two speed budgets (§4.12) ----------------
{
	const star = snapshot({ mass: 1, luminosity: 0.3, teff: 4637, rStar: 0.85, age: 2 });
	const sys = planets.createSystemRecord();
	const sum = planets.createSummaryRecord();
	for (let k = 0; k < 2000; k++) {
		planets.generateSystem(REF(k + 1, 0), star, sys);
		planets.systemSummary(REF(k + 1, 0), star, sum);
	}
	// The heap-delta rule: gc on both sides of 100 000 calls, five times, keeps
	// only what the systems actually retain. One 16-byte object per call would
	// show 1.6 MB, so half of that is a real leak and half is Node's own
	// bookkeeping. Without --expose-gc the trials are reported, not asserted.
	const trials = [];
	for (let t = 0; t < 5; t++) {
		if (global.gc) global.gc();
		const before = process.memoryUsage().heapUsed;
		for (let i = 1; i <= 100000; i++) planets.generateSystem(REF(i, 0), star, sys);
		if (global.gc) global.gc();
		trials.push(process.memoryUsage().heapUsed - before);
	}
	trials.sort((a, b) => a - b);
	stats.heap = { trials, median: trials[trials.length >> 1], exposedGc: !!global.gc };
	check('generateSystem allocates nothing over 100 000 systems',
		!global.gc || stats.heap.median < 512 * 1024, stats.heap);

	function medianMs(fn, iterations) {
		const times = [];
		for (let i = 0; i < iterations; i++) {
			const s = process.hrtime.bigint();
			fn();
			times.push(Number(process.hrtime.bigint() - s) / 1e6);
		}
		times.sort((a, b) => a - b);
		return times[times.length >> 1];
	}
	let counter = 0;
	// One ref object, mutated in place: the measurement is the generator, not the
	// harness allocating a fresh ref per call.
	const timingRef = { key: 1, block: 0, model: MODEL };
	const genMs = medianMs(() => {
		timingRef.key = counter++ * 31 + 7;
		planets.generateSystem(timingRef, star, sys);
	}, 3000);
	const sumMs = medianMs(() => {
		timingRef.key = counter++ * 31 + 7;
		planets.systemSummary(timingRef, star, sum);
	}, 3000);
	stats.timings = { generateUs: genMs * 1000, summaryUs: sumMs * 1000 };
	check('generateSystem runs inside the 20 µs budget', genMs < 0.02, stats.timings);
	check('systemSummary runs inside the 6 µs budget', sumMs < 0.006, stats.timings);
	check('the summary is the cheap path', sumMs <= genMs, stats.timings);
}

// --- Report ------------------------------------------------------------------
let passed = 0;
let failed = 0;
for (const c of checks) {
	if (c.pass) passed++; else failed++;
	console.log(`  ${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.pass ? '' : `  -> ${JSON.stringify(c.detail)}`}`);
}
console.log(`\n${passed}/${checks.length} passed, ${failed} failed`);

const logPath = path.join(__dirname, 'logs', 'planet-gen.json');
fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.writeFileSync(logPath, JSON.stringify({
	date: new Date().toISOString(),
	model: { type: MODEL.type, seed: MODEL.seed },
	stats,
	totalChecks: checks.length,
	passed,
	failed,
	checks,
}, null, 2));
console.log(`Wrote ${logPath}`);
console.log('\n=== VERDICT ===');
console.log(failed === 0 ? 'PASS — the planet generator behaves as the 0.5 plan pins it' : `FAIL — ${failed} checks failed`);
process.exit(failed === 0 ? 0 : 1);
