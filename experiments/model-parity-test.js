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
	const groups = { thin: { amp: 0 }, thick: { amp: 0 }, spheroid: { amp: 0 }, halo: { amp: 0 }, arms: { amp: 0 } };
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
	for (const type of ['Irr', 'constructor', '__proto__']) {
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
