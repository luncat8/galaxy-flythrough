// Regression fixtures for model parameters that the Milky Way defaults hide.
'use strict';

const fs = require('fs');
const path = require('path');
const galaxy = require('../src/math/galaxy.js');
const density = require('../src/math/density.js');
const sampling = require('../src/math/sampling.js');
const nebula = require('../src/math/nebula.js');

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
}
const N = 40000;
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

function isolated(component, overrides) {
	const groups = { thin: { amp: 0 }, thick: { amp: 0 }, spheroid: { amp: 0 }, halo: { amp: 0 }, arms: { amp: 0, flocculence: 0 } };
	groups[component].amp = 1;
	for (const [group, values] of Object.entries(overrides || {})) {
		groups[group] = Object.assign(groups[group] || {}, values);
	}
	return galaxy.createGalaxy({ type: 'Sc', overrides: groups });
}

// Independent midpoint quadrature over the *field*, not the sampler's CDF.
function histogram(name, buf, coordinate, max, weight) {
	const bins = 16;
	const ref = new Float64Array(bins);
	const obs = new Float64Array(bins);
	const steps = bins * 512;
	let mass = 0;
	for (let i = 0; i < steps; i++) {
		const r = max * (i + 0.5) / steps;
		const w = weight(r) * max / steps;
		ref[Math.floor(i / 512)] += w;
		mass += w;
	}
	let outside = 0;
	for (let i = 0; i < buf.count; i++) {
		const r = coordinate(i);
		if (!Number.isFinite(r) || r < 0 || r > max + 1e-5) outside++;
		else obs[Math.min(bins - 1, Math.floor(r / max * bins))]++;
	}
	let tv = 0;
	for (let i = 0; i < bins; i++) tv += Math.abs(obs[i] / buf.count - ref[i] / mass) / 2;
	check(`${name}: all samples stay in support`, outside === 0, outside);
	check(`${name}: histogram matches integrated field (TV < 2%)`, tv < 0.02, { tv, mass });
	return mass;
}

for (const group of ['thin', 'thick']) {
	const model = isolated(group, { truncation: { discRadius: 1.2, discHeight: 0.4 } });
	const buf = sampling.sampleGalaxyStars(model, 71, N);
	const rho = group === 'thin' ? density.rhoThin : density.rhoThick;
	histogram(`compact ${group} radius`, buf, (i) => buf.R[i], model.truncation.discRadius,
		(r) => 2 * Math.PI * r * rho(model, r, 0));
	histogram(`compact ${group} height`, buf, (i) => Math.abs(buf.z[i]), model.truncation.discHeight,
		(z) => 2 * rho(model, 0, z));
	check(`${group}: central profile is exponential, not an unmodelled plateau`,
		near(rho(model, 0.005, 0) / rho(model, 0, 0), Math.exp(-0.005 / model[group].L), 1e-12));
}

for (const profile of ['plummer', 'sersic']) {
	const model = isolated('spheroid', { spheroid: { profile, r0: 2.3, n: 2, tiltDeg: 31 } });
	const buf = sampling.sampleGalaxyStars(model, 71, N);
	const sp = model.spheroid;
	const tilt = sp.tiltDeg * Math.PI / 180;
	histogram(`${profile} non-unit r0`, buf,
		(i) => density.spheroidEllipsoidRadius(model, buf.x[i], buf.y[i], buf.z[i]),
		model.truncation.spheroidRadius,
		(s) => s * s * density.rhoSpheroid(model, sp.a * sp.r0 * s * Math.cos(tilt),
			sp.a * sp.r0 * s * Math.sin(tilt), 0));
}

for (const [power, rMax] of [[2.5, 6], [3, 6], [3.5, 6], [4, 6], [3.5, 1]]) {
	const model = isolated('halo', { halo: { a_h: 2, power, rMax } });
	const buf = sampling.sampleGalaxyStars(model, 71, N);
	const mass = histogram(`halo power ${power}, radius ${rMax}`, buf,
		(i) => Math.hypot(buf.x[i], buf.y[i], buf.z[i]), rMax,
		(r) => 4 * Math.PI * r * r * density.rhoHalo(model, r, 0, 0));
	check(`halo ${power}/${rMax}: mass integral includes exactly the core and tail`,
		near(mass, density.componentMasses(model).halo, 1e-4 * mass));
	check(`halo ${power}/${rMax}: the field vanishes outside its bound`,
		density.rhoHalo(model, rMax + 0.001, 0, 0) === 0);
}

// --- The shape machinery: bar, flaring, cores, clumps, flocculence -------
{
	// Bar: the sampled superellipsoid radius matches the field's shell mass
	// dM/ds = 3*V(1)*s^2*e^-s*amp, where the total integral is the closed
	// form 6*V(1)*amp. (The angular map of the sampler is the same
	// uniform-direction scheme the plummer/sersic samplers use; the s
	// marginal is exact.)
	const bar = isolated('spheroid', { spheroid: { profile: 'bar', n: 2.5, r0: 2.3, tiltDeg: 0 } });
	const barBuf = sampling.sampleGalaxyStars(bar, 71, N);
	const M = density.massIntegrals(bar).bulge;   // = 6*V(1)*amp
	const weight = (s) => 0.5 * M * s * s * Math.exp(-s);
	histogram('bar superellipsoid radius', barBuf,
		(i) => {
			const n = bar.spheroid.n;
			const x = barBuf.x[i], y = barBuf.y[i], z = barBuf.z[i];
			const ax = Math.abs(x / bar.spheroid.a);
			const ay = Math.abs(y / bar.spheroid.b);
			const az = Math.abs(z / bar.spheroid.c);
			return Math.pow(Math.pow(ax, n) + Math.pow(ay, n) + Math.pow(az, n), 1 / n) / bar.spheroid.r0;
		},
		bar.truncation.spheroidRadius, weight);
	check('the bar field falls off as exp(-s) from its centre',
		near(density.rhoSpheroid(bar, bar.spheroid.a * 2, 0, 0),
			density.rhoSpheroid(bar, 0, 0, 0) * Math.exp(-2 / bar.spheroid.r0), 1e-9),
		{ centre: density.rhoSpheroid(bar, 0, 0, 0) });

	// Flaring: each disc reads H(R) = H(1 + flare*R/L) — thin and thick
	// separately — and the sampled (R, z) cloud matches a joint quadrature.
	for (const group of ['thin', 'thick']) {
		const model = isolated(group, { [group]: { flare: 0.3 }, truncation: { discRadius: 12, discHeight: 0.8 } });
		const L = model[group].L;
		const H = model[group].H;
		for (const [R, z] of [[2, 0.3], [5, 0.5], [8, 0.2], [0.5, 0.1]]) {
			const Hr = H * (1 + 0.3 * R / L);
			const e = Math.exp(-Math.abs(z) / Hr);
			const vertical = group === 'thin' ? 4 * e / ((1 + e) * (1 + e)) : e;
			const expected = model[group].amp * Math.exp(-R / L) * vertical;
			const actual = group === 'thin' ? density.rhoThin(model, R, z) : density.rhoThick(model, R, z);
			check(`flared ${group} disc reads H(R) at R=${R}, z=${z}`, near(actual, expected, 1e-12),
				{ actual, expected });
		}
	}
	{
		const model = isolated('thin', { thin: { flare: 0.3 }, truncation: { discRadius: 12, discHeight: 0.8 } });
		const buf = sampling.sampleGalaxyStars(model, 71, N);
		// Joint (R, z) histogram vs the field quadrature: catches a sampler
		// that draws z from the flat H while the field flares.
		const nR = 12, nZ = 8;
		const dR = 12 / nR, dZ = 1.6 / nZ;
		const obs = new Float64Array(nR * nZ);
		for (let i = 0; i < buf.count; i++) {
			const x = buf.x[i], y = buf.y[i], z = buf.z[i];
			const R = Math.sqrt(x * x + y * y);
			if (R >= 12 || Math.abs(z) >= 0.8) continue;
			obs[Math.min(nZ - 1, Math.floor(Math.abs(z) / dZ)) * nR + Math.min(nR - 1, Math.floor(R / dR))]++;
		}
		const ref = new Float64Array(nR * nZ);
		let refTotal = 0;
		const steps = 160;
		for (let i = 0; i < steps; i++) {
			const R = (i + 0.5) * 12 / steps;
			const radial = model.thin.amp * Math.exp(-R / model.thin.L) * R * (12 / steps);
			const rb = Math.min(nR - 1, Math.floor(R / dR));
			for (let j = 0; j < 40; j++) {
				const z = (j + 0.5) * 1.6 / 40;
				const Hr = model.thin.H * (1 + 0.3 * R / model.thin.L);
				const e = Math.exp(-z / Hr);
				const w = 4 * e / ((1 + e) * (1 + e)) * radial * (1.6 / 40);
				const k = Math.min(nZ - 1, Math.floor(z / dZ));
				ref[k * nR + rb] += w;
				refTotal += w;
			}
		}
		let tv = 0;
		for (let k = 0; k < obs.length; k++) tv += Math.abs(obs[k] / buf.count - ref[k] / refTotal);
		tv /= 2;
		check('the flared disc sample matches the joint (R, z) field (TV < 5%)', tv < 0.05, +tv.toFixed(4));
	}

	// Disc core: the field is the soft R/sqrt(R^2+c^2) core; the sampler
	// inverts the exponential over [coreRadius, rMax] (the plan's documented
	// approximation — no stars inside the core, the outer profile intact).
	{
		const model = isolated('thin', { thin: { coreRadius: 0.8 }, truncation: { discRadius: 12, discHeight: 0.5 } });
		const L = model.thin.L;
		for (const R of [0.1, 0.4, 0.8, 2, 5]) {
			const expected = model.thin.amp * Math.exp(-R / L) * (R / Math.sqrt(R * R + 0.64));
			check(`cored disc reads the soft core at R=${R}`, near(density.rhoThin(model, R, 0), expected, 1e-12),
				{ R, expected });
		}
		const buf = sampling.sampleGalaxyStars(model, 71, N);
		let insideCore = 0;
		let tv = 0;
		const nR = 24, dR = 12 / nR;
		const hist = new Float64Array(nR);
		for (let i = 0; i < buf.count; i++) {
			const x = buf.x[i], y = buf.y[i];
			const R = Math.sqrt(x * x + y * y);
			if (R < 0.8 - 1e-9) insideCore++;
			if (R < 12) hist[Math.min(nR - 1, Math.floor(R / dR))]++;
		}
		const ref = new Float64Array(nR);
		let refTotal = 0;
		const steps = 240;
		for (let i = 0; i < steps; i++) {
			const R = (i + 0.5) * 12 / steps;
			const w = model.thin.amp * Math.exp(-R / L) * (R / Math.sqrt(R * R + 0.64)) * R * (12 / steps);
			ref[Math.min(nR - 1, Math.floor(R / dR))] += w;
			refTotal += w;
		}
		for (let i = 0; i < nR; i++) tv += Math.abs(hist[i] / buf.count - ref[i] / refTotal);
		tv /= 2;
		check('no cored-disc star falls inside the core cutoff', insideCore === 0, insideCore);
		check('the cored disc R profile matches the field (TV < 5%)', tv < 0.05, +tv.toFixed(4));
	}

	// Bar-end arm coupling at the field: the ridge passes through the bar's
	// semimajor axis at the bar's tilt. Flocculent bars carry a noise term,
	// so the exact maximum is checked on a pure grand-design barred model.
	for (const type of ['SBa', 'SBc', 'SBd']) {
		const model = galaxy.createGalaxy({ type });
		const a = model.arms;
		const ridge = (Math.tan(a.pitchDeg * Math.PI / 180) * Math.log(a.minRadius / a.Rs) - a.phase0) / a.m;
		check(`${type}: the ridge passes through the bar end`,
			near(a.minRadius, model.spheroid.a, 1e-12)
			&& near(density.distanceToNearestArm(model, a.minRadius, ridge), 0, 1e-9),
			{ minRadius: a.minRadius, a: model.spheroid.a });
	}
	{
		const pure = galaxy.createGalaxy({ type: 'SBa', overrides: { arms: { flocculence: 0 } } });
		const a = pure.arms;
		const ridge = (Math.tan(a.pitchDeg * Math.PI / 180) * Math.log(a.minRadius / a.Rs) - a.phase0) / a.m;
		check('a grand-design bar: the ridge is the exact arm-field maximum at the bar end',
			near(density.armFactor(pure, a.minRadius, ridge), 1 + a.amp, 1e-12),
			density.armFactor(pure, a.minRadius, ridge));
	}

	// Flocculence is seeded: Sc (flocculence 0.5) reads differently under two
	// seeds, while the noise itself is a pure function of (coords, seed).
	{
		const sc42 = galaxy.createGalaxy({ type: 'Sc', seed: 42 });
		const sc7 = galaxy.createGalaxy({ type: 'Sc', seed: 7 });
		let differs = 0;
		for (const [R, phi] of [[4, 0.3], [6, 1.1], [9, 2.2], [12, 0.7]]) {
			if (density.armFactor(sc42, R, phi) !== density.armFactor(sc7, R, phi)) differs++;
		}
		check('flocculent arm fields diverge with the seed', differs >= 3, differs);
		check('the flocculence noise is a pure function of (coords, seed)',
			density.fbm2D(1.3, 0.7, 42) === density.fbm2D(1.3, 0.7, 42)
			&& density.fbm2D(1.3, 0.7, 42) !== density.fbm2D(1.3, 0.7, 7),
			density.fbm2D(1.3, 0.7, 42));
	}

	// Irregular field: the hotspot boost and the seeded FBM texture.
	{
		const irr = galaxy.createGalaxy({ type: 'Irr', seed: 42 });
		const irr7 = galaxy.createGalaxy({ type: 'Irr', seed: 7 });
		const c = irr.clumps[0];
		const full = density.rhoDecomposed(irr, c.x, c.y, c.z, true);
		const basef = density.rhoDecomposed(irr, c.x, c.y, c.z, false);
		const ratio = (full.thin + full.thick) / (basef.thin + basef.thick);
		check('the hotspot boost at a clump centre is 1+boost within the FBM band',
			ratio > 2.5 && ratio < 6.5, +ratio.toFixed(3));
		const p = [2.2, -1.1, 0.3];
		check('the FBM texture is seeded (two Irr seeds read differently)',
			density.irregularFactor(irr, p[0], p[1], p[2]) !== density.irregularFactor(irr7, p[0], p[1], p[2]),
			{ s42: density.irregularFactor(irr, p[0], p[1], p[2]), s7: density.irregularFactor(irr7, p[0], p[1], p[2]) });
		check('a regular type has no irregular texture',
			density.irregularFactor(galaxy.createGalaxy({ type: 'Sc' }), 2, 1, 0.3) === 1);
	}
}

{
	const base = galaxy.createGalaxy({ type: 'Sc' });
	const moved = galaxy.createGalaxy({ type: 'Sc', overrides: { centre: { x: 3, y: -2, z: 4 } } });
	const a = sampling.sampleGalaxyStars(base, 71, 4000);
	const b = sampling.sampleGalaxyStars(moved, 71, 4000);
	let error = 0;
	for (let i = 0; i < a.count; i++) {
		error = Math.max(error, Math.abs(b.x[i] - a.x[i] - 3), Math.abs(b.y[i] - a.y[i] + 2), Math.abs(b.z[i] - a.z[i] - 4));
	}
	check('moving the centre translates every sampled component', error < 1e-5, error);
	for (const [x, y, z] of [[0, 0, 0], [4, 1, 0.1], [-1, 2, 3], [80, 0, 0]]) {
		check(`translated field at ${x},${y},${z} is identical`,
			near(density.rhoTotal(base, x, y, z), density.rhoTotal(moved, x + 3, y - 2, z + 4), 1e-10));
		check(`translated nebula probability at ${x},${y},${z} is identical`,
			near(nebula.nebulaProbabilityAt(base, x, y, z).p,
				nebula.nebulaProbabilityAt(moved, x + 3, y - 2, z + 4).p, 1e-10));
	}
	check('centre override rebuilds radius and orbit home',
		near(moved.R0, Math.sqrt(29)) && moved.home.orbitTarget.join(',') === '3,-2,4'
		&& near(moved.home.position[2], base.home.position[2] + 4));
	const home = galaxy.createGalaxy({ type: 'Sc', overrides: { centre: { z: 4 }, home: { orbitName: 'custom' } } });
	check('explicit home fields win without staling unspecified home fields',
		home.home.orbitName === 'custom' && home.home.orbitTarget[2] === 4);
	const quenched = galaxy.createGalaxy({ type: 'Sc', overrides: { populations: { gasFraction: 0.01 } } });
	check('gasFraction alone recomputes the shared gas gate', !quenched.populations.gasRich);
	const phi = Math.tan(quenched.arms.pitchDeg * Math.PI / 180) * Math.log(6 / quenched.arms.Rs) / quenched.arms.m;
	check('quenched spiral cannot classify a nebula as gas-origin even on its ridge',
		!['HII', 'reflection', 'dark'].includes(nebula.nebulaProbabilityAt(quenched, 6 * Math.cos(phi), 6 * Math.sin(phi), 0).type));
}

{
	const model = isolated('thin', { arms: { amp: 0.7, m: 2, minRadius: 2, phase0: 1.4 } });
	check('arm field and ridge are disabled inside the model minimum radius',
		density.armFactor(model, 1, 0.3) === 1 && density.distanceToNearestArm(model, 1, 0.3) === 99);
	const k = Math.tan(model.arms.pitchDeg * Math.PI / 180);
	for (const r of [2, 4, 10]) {
		const ridge = (k * Math.log(r / model.arms.Rs) - model.arms.phase0) / model.arms.m;
		check(`phase-shifted ridge at R=${r} is the field maximum`,
			near(density.distanceToNearestArm(model, r, ridge), 0)
			&& near(density.armFactor(model, r, ridge), 1 + model.arms.amp));
	}
	const buf = sampling.sampleGalaxyStars(model, 71, N);
	let cosine = 0, sine = 0, n = 0;
	for (let i = 0; i < buf.count; i++) {
		if (buf.R[i] < model.arms.minRadius) continue;
		const phase = model.arms.m * Math.atan2(buf.y[i], buf.x[i]) - k * Math.log(buf.R[i] / model.arms.Rs) + model.arms.phase0;
		cosine += Math.cos(phase);
		sine += Math.sin(phase);
		n++;
	}
	check('sampled arm phase matches the field Fourier moment',
		near(cosine / n, model.arms.amp / 2, 0.015) && near(sine / n, 0, 0.015), { cosine: cosine / n, sine: sine / n });
	const prefix = sampling.sampleGalaxyStars(model, 71, 100);
	check('samples are stable when the requested count changes',
		prefix.x.every((x, i) => x === buf.x[i]) && prefix.z.every((z, i) => z === buf.z[i]));
}

{
	const empty = isolated('thin', { thin: { amp: 0 } });
	check('an empty model cannot emit stale stars in a box',
		sampling.sampleStarsInBox(empty, 42, 5, { xMin: -1, xMax: 1, yMin: -1, yMax: 1, zMin: -1, zMax: 1 }).count === 0);
	for (const type of ['E17', 'constructor', '__proto__']) {
		let rejected = false;
		try { galaxy.createGalaxy({ type }); } catch (err) { rejected = /unknown galaxy type/.test(err.message); }
		check(`unsupported type ${type} is rejected explicitly`, rejected);
	}
}

const failed = checks.filter((c) => !c.pass).length;
for (const c of checks) console.log(`${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.pass ? '' : ' ' + JSON.stringify(c.detail)}`);
const result = { date: new Date().toISOString(), totalChecks: checks.length, passed: checks.length - failed, failed, checks };
fs.writeFileSync(path.join(__dirname, 'logs', 'model-parity.json'), JSON.stringify(result, null, 2));
console.log(`\n${result.passed}/${checks.length} passed, ${failed} failed`);
console.log('\n=== VERDICT ===');
console.log(failed ? `FAIL — ${failed} checks failed` : 'PASS — sampling and density agree beyond the preset');
process.exitCode = failed ? 1 : 0;
