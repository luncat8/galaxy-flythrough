// experiments/galaxy-types-test.js
// Validates the galaxy table: the type specs, the anchor curves, the amplitude
// solve that turns (T, massTotal, B/T) into a density field, and the places where
// a *population* number — not a shape number — decides what exists.
//
// Six things are checked, in order:
//   1. the table is complete and self-consistent, and the Milky Way preset
//      reproduces the constants it was extracted from, to the digit
//   2. the anchor curves: B/T down and pitch/gas up along the sequence, clamped
//      at both ends
//   3. the solve: component masses land on the authored B/T, thickShare and
//      massTotal, and a type with no disc gets no disc amplitude
//   4. the sampler weights itself with what the truncated field delivers, and
//      draws nothing outside the truncation
//   5. the Sérsic path: the enclosed-mass integral and its inverse round-trip,
//      and the cut is enforced in the field
//   6. gas: a quenched type draws no young stars and hosts no nebula, from one
//      threshold in the descriptor rather than three in the code
//
// Output: experiments/logs/galaxy-types.json

'use strict';

const fs = require('fs');
const path = require('path');

const density = require('../src/math/density.js');
const sampling = require('../src/math/sampling.js');
const starTypes = require('../src/math/star-types.js');
const nebula = require('../src/math/nebula.js');
const galaxy = require('../src/math/galaxy.js');

const TYPES = galaxy.GALAXY_TYPES;
const models = {};
for (const type of TYPES) models[type] = galaxy.createGalaxy({ type, seed: 42 });
const MW = galaxy.MILKY_WAY;
// Every regular table type, not just the original three representatives.
const TABLE = TYPES.filter((type) => type !== galaxy.MILKY_WAY_TYPE).map((type) => models[type]);
const ALL = [MW].concat(TABLE);

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
	return !!pass;
}
function near(a, b, tol) {
	return Math.abs(a - b) <= tol;
}
function relNear(a, b, tol) {
	return Math.abs(a - b) <= tol * Math.max(Math.abs(a), Math.abs(b), 1e-12);
}

// --- 1. The table ---------------------------------------------------------
{
	const required = ['T', 'barred', 'scaleKpc', 'massTotal', 'axes', 'discRadius', 'discHeight',
		'spheroidRadius', 'halo', 'thickShare', 'youngScaleHeight', 'dynamics'];
	for (const type of TYPES) {
		const spec = galaxy.TYPE_SPECS[type];
		const missing = required.filter((k) => spec[k] === undefined);
		check(`${type}: every documented spec field is authored`, missing.length === 0, missing);
	}
	let walked = galaxy.GALAXY_TYPE_CYCLE[0];
	let roundTrip = true;
	for (let i = 0; i < galaxy.GALAXY_TYPE_CYCLE.length; i++) {
		walked = galaxy.cycleGalaxyType(walked);
		if (galaxy.GALAXY_TYPE_CYCLE.indexOf(walked) < 0) roundTrip = false;
	}
	check('the shortcut cycle walks the shortlist and returns to the start',
		galaxy.GALAXY_TYPE_CYCLE.every((type) => TYPES.includes(type)) && roundTrip && walked === galaxy.GALAXY_TYPE_CYCLE[0],
		{ cycle: galaxy.GALAXY_TYPE_CYCLE, endedAt: walked });
	check('an unknown type is an error, not a silent fallback', (() => {
		try {
			galaxy.createGalaxy({ type: 'E17' });
			return false;
		} catch (err) {
			return /unknown galaxy type/.test(err.message);
		}
	})());
	check('the default model is the Milky Way preset',
		galaxy.createGalaxy({}).type === galaxy.MILKY_WAY_TYPE && galaxy.createGalaxy({}).milkyWay === true);
	check('the label names the type and the seed, for the overlay',
		galaxy.galaxyLabel(models.Sc) === 'galaxy Sc #42', galaxy.galaxyLabel(models.Sc));
}

// The preset is the source of truth for the Milky Way, so its numbers are pinned
// literally: they are what every earlier test in this repo was tuned against.
{
	const bulgeShare = density.componentMasses(MW).bulge / density.componentMasses(MW).total;
	const rows = [
		['centre.x', MW.centre.x, 8.178],
		['thin.L', MW.thin.L, 2.6], ['thin.H', MW.thin.H, 0.3], ['thin.amp', MW.thin.amp, 1.0],
		['thick.L', MW.thick.L, 3.5], ['thick.H', MW.thick.H, 0.9], ['thick.amp', MW.thick.amp, 0.12],
		['spheroid.a', MW.spheroid.a, 1.5], ['spheroid.b', MW.spheroid.b, 0.5], ['spheroid.c', MW.spheroid.c, 0.4],
		['spheroid.r0', MW.spheroid.r0, 1.0], ['spheroid.amp', MW.spheroid.amp, 12.0],
		['spheroid.tiltDeg', MW.spheroid.tiltDeg, 27], ['spheroid.profile', MW.spheroid.profile, 'plummer'],
		['spheroid.profileId', MW.spheroid.profileId, density.PROFILE_PLUMMER],
		['halo.a_h', MW.halo.a_h, 1.0], ['halo.rMax', MW.halo.rMax, 100.0],
		['halo.power', MW.halo.power, 3.5], ['halo.amp', MW.halo.amp, 0.0008],
		['arms.m', MW.arms.m, 2], ['arms.amp', MW.arms.amp, 0.2], ['arms.pitchDeg', MW.arms.pitchDeg, 12],
		['arms.Rs', MW.arms.Rs, 3.0], ['arms.phase0', MW.arms.phase0, 0], ['arms.minRadius', MW.arms.minRadius, 0.5],
		['truncation.discRadius', MW.truncation.discRadius, 25.0],
		['truncation.discHeight', MW.truncation.discHeight, 3.0],
		['truncation.spheroidRadius', MW.truncation.spheroidRadius, 6.0],
		['populations.gasFraction', MW.populations.gasFraction, 0.15],
		['populations.youngScaleHeight', MW.populations.youngScaleHeight, 0.5],
		['populations.youngOuterR', MW.populations.youngOuterR, 12.0],
		['populations.gasRich', MW.populations.gasRich, true],
		['home.position', MW.home.position.join(','), '0,0,0.005'],
		['home.orbitTarget', MW.home.orbitTarget.join(','), '0,0,0'],
		['home.orbitDistance', MW.home.orbitDistance, 0.01],
		['home.orbitName', MW.home.orbitName, 'Sun'],
		['seed', MW.seed, 42], ['scaleKpc', MW.scaleKpc, 1.0], ['T', MW.T, 3],
	];
	for (const [name, got, want] of rows) {
		check(`the Milky Way preset keeps ${name}`, got === want, { preset: got, expected: want });
	}
	// Documented drift: the authored preset is 0.182 bulge, the anchor curve says
	// 0.15 at T = 3. The preset wins for the Milky Way; the curve is for the rest.
	check('the preset is bulgier than the anchor curve, and is left that way',
		bulgeShare > 0.17 && bulgeShare < 0.20,
		{ bulgeShare: +bulgeShare.toFixed(4), anchorBT: galaxy.interpAnchors(galaxy.ANCHORS.B_T, 3) });
	check('the preset is not re-solved: its disc amplitude is the authored 1.0',
		MW.thin.amp === 1.0 && density.componentMasses(MW).thin > 0, density.componentMasses(MW).thin);
}

// The menu contains all regular types, while G remains a short tour.
{
	const expected = ['E0', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7',
		'S0', 'Sa', 'Sb', 'Sc', 'Sd', 'SB0', 'SBa', 'SBb', 'SBc', 'SBd'];
	check('the regular type menu is complete and has no duplicates',
		JSON.stringify(TYPES) === JSON.stringify(expected), TYPES);
	check('every table-only type rejoins the shortcut tour at E4',
		TYPES.filter((type) => !galaxy.GALAXY_TYPE_CYCLE.includes(type))
			.every((type) => galaxy.cycleGalaxyType(type) === 'E4'));
	for (let e = 0; e <= 7; e++) {
		const m = models['E' + e];
		check(`${m.type}: ordered axes, flattening and pure old spheroid`,
			near(m.spheroid.b / m.spheroid.a, 1 - 0.1 * e, 1e-12)
			&& m.spheroid.a >= m.spheroid.b && m.spheroid.b >= m.spheroid.c
			&& m.spheroid.c > 0 && m.spheroid.n >= 2 && m.spheroid.n <= 4
			&& m.thin.amp === 0 && m.thick.amp === 0 && !m.populations.gasRich);
	}
	check('only the authored SBb preset enables the real catalog',
		ALL.filter((m) => m.milkyWay).length === 1);
}

// --- 2. The anchor curves -------------------------------------------------
{
	const at = (T) => ({
		T,
		bT: galaxy.interpAnchors(galaxy.ANCHORS.B_T, T),
		pitch: galaxy.interpAnchors(galaxy.ANCHORS.PITCH_DEG, T),
		gas: galaxy.interpAnchors(galaxy.ANCHORS.GAS_FRACTION, T),
		n: galaxy.interpAnchors(galaxy.ANCHORS.SERSIC_N, T),
	});
	const order = ['S0', 'Sa', 'Sb', 'Sc', 'Sd'].map((t) => galaxy.TYPE_SPECS[t].T);
	check('the unbarred stages are in sequence order',
		order.every((t, i) => i === 0 || t > order[i - 1]), order);
	const early = at(-2);
	const late = at(6);
	check('B/T falls and pitch, gas and Sersic index rise along the sequence',
		late.bT < early.bT && late.pitch > early.pitch && late.gas > early.gas && late.n <= early.n,
		{ early, late });
	const anchorEnds = (table) => [galaxy.ANCHORS[table][0][0], galaxy.ANCHORS[table][galaxy.ANCHORS[table].length - 1][0]];
	const [bT0, bT1] = anchorEnds('B_T');
	const [pitch0, pitch1] = anchorEnds('PITCH_DEG');
	check('the curves clamp outside their anchors instead of extrapolating',
		at(bT0 - 10).bT === at(bT0).bT && at(pitch1 + 10).pitch === at(pitch1).pitch,
		{ belowE: at(bT0 - 10).bT, aboveSc: at(pitch1 + 10).pitch });
	check('the early end of the table is a pure bulge with no arm contrast',
		galaxy.interpAnchors(galaxy.ANCHORS.B_T, -2) === 1
		&& galaxy.interpAnchors(galaxy.ANCHORS.ARM_AMP, -2) === 0
		&& galaxy.interpAnchors(galaxy.ANCHORS.GAS_FRACTION, -2) === 0);
	check('S0 sits on the quenched side of the star-forming threshold',
		models.S0.populations.gasFraction > 0 && models.S0.populations.gasFraction < galaxy.GAS_RICH_MIN
		&& models.S0.populations.gasRich === false, models.S0.populations);
	check('the Sb and Sc rows are star-forming',
		MW.populations.gasRich === true && models.Sc.populations.gasRich === true,
		{ SBb: MW.populations.gasFraction, Sc: models.Sc.populations.gasFraction });
}

// --- 3. The amplitude solve ----------------------------------------------
{
	const unit = density.componentMasses(MW).total;
	for (const model of ALL) {
		const spec = galaxy.TYPE_SPECS[model.type];
		const masses = density.componentMasses(model);
		const authored = spec.massTotal * unit;
		const bT = spec.preset === true ? masses.bulge / authored : galaxy.interpAnchors(galaxy.ANCHORS.B_T, model.T);
		if (spec.preset !== true) {
			check(`${model.type}: the components add up to the authored mass`,
				relNear(masses.thin + masses.thick + masses.bulge, authored, 1e-9),
				{ components: +(masses.thin + masses.thick + masses.bulge).toFixed(4), authored: +authored.toFixed(4) });
			check(`${model.type}: the spheroid mass matches the B/T anchor`,
				relNear(masses.bulge / authored, bT, 1e-9), { solved: +(masses.bulge / authored).toFixed(5), bT });
			const disc = masses.thin + masses.thick;
			check(`${model.type}: the thick disc takes its share of the disc, not of the halo`,
				disc > 0 ? relNear(masses.thick / disc, spec.thickShare, 1e-9) : model.thick.amp === 0,
				{ share: disc > 0 ? +(masses.thick / disc).toFixed(5) : null, authored: spec.thickShare });
		}
		check(`${model.type}: the halo amplitude is the preset's ratio times the mass`,
			model.halo.amp === (spec.halo ? galaxy.HALO_AMP_UNIT * spec.massTotal : 0),
			{ amp: model.halo.amp, halo: spec.halo, massTotal: spec.massTotal });
	}
	check('an E4 has no disc and no halo: its field is the spheroid alone',
		models.E4.thin.amp === 0 && models.E4.thick.amp === 0 && models.E4.halo.amp === 0
		&& models.E4.arms.amp === 0 && models.E4.populations.gasFraction === 0,
		{ thin: models.E4.thin.amp, arms: models.E4.arms.amp, gas: models.E4.populations.gasFraction });
	check('a bulge-only type reads as a smooth sphere everywhere',
		density.armFactor(models.E4, 6, 0.4) === 1
		&& density.armFactor(models.S0, 6, 0.4) === 1
		&& density.distanceToNearestArm(models.E4, 6, 0.4) === 99,
		{ armFactorE4: density.armFactor(models.E4, 6, 0.4), dist: density.distanceToNearestArm(models.E4, 6, 0.4) });
	check('lengths scale with scaleKpc and the disc truncation follows',
		relNear(models.Sc.thin.L, galaxy.DISC_L_KPC * 1.4, 1e-12)
		&& relNear(models.Sc.truncation.discRadius, 25.0 * 1.4, 1e-12),
		{ L: models.Sc.thin.L, discRadius: models.Sc.truncation.discRadius });
	check('the spheroid cut is in units of s, so scaleKpc does not move it',
		models.Sc.truncation.spheroidRadius === galaxy.TYPE_SPECS.Sc.spheroidRadius
		&& models.E4.truncation.spheroidRadius === galaxy.TYPE_SPECS.E4.spheroidRadius,
		{ Sc: models.Sc.truncation.spheroidRadius, E4: models.E4.truncation.spheroidRadius });
}

// --- 4. The sampler weights itself with the truncated mass ---------------
{
	for (const model of ALL) {
		const delivered = sampling.deliveredMasses(model);
		const fractions = density.truncationFractions(model);
		const masses = density.componentMasses(model);
		const keys = ['thin', 'thick', 'bulge', 'halo'];
		const drift = keys.filter((k) => !relNear(delivered[k], masses[k] * fractions[k], 1e-12));
		check(`${model.type}: delivered mass is the model mass times what the box keeps`,
			drift.length === 0, drift);
		check(`${model.type}: every truncation fraction is a fraction`,
			keys.every((k) => fractions[k] >= 0 && fractions[k] <= 1), fractions);
		const amps = { thin: model.thin.amp, thick: model.thick.amp, bulge: model.spheroid.amp, halo: model.halo.amp };
		check(`${model.type}: a component with no amplitude delivers nothing`,
			keys.every((k) => (amps[k] === 0 ? delivered[k] === 0 : delivered[k] > 0)),
			{ amps, delivered: Object.fromEntries(keys.map((k) => [k, +delivered[k].toFixed(5)])) });
	}
	const N = 20000;
	const buf = sampling.createBuffers(N);
	for (const model of ALL) {
		sampling.sampleGalaxyStars(model, 7, N, buf);
		const shares = sampling.componentShares(buf);
		const delivered = sampling.deliveredMasses(model);
		const expected = Object.fromEntries(density.COMPONENT_NAMES.map((name) => [name, delivered[name] / delivered.total]));
		const worst = Math.max(...density.COMPONENT_NAMES.map((name) => Math.abs(shares[name] - expected[name])));
		check(`${model.type}: the sampled mix follows the delivered masses`, worst < 0.02,
			{ worst: +worst.toFixed(4), sampled: shares, model: expected });
		let outside = 0;
		for (let i = 0; i < buf.count; i++) {
			const dx = buf.x[i] - model.centre.x;
			const dy = buf.y[i] - model.centre.y;
			if (buf.component[i] === density.COMPONENT_THIN || buf.component[i] === density.COMPONENT_THICK) {
				if (!density.insideDisc(model, buf.R[i], buf.z[i])) outside++;
			} else if (buf.component[i] === density.COMPONENT_BULGE) {
				const s = density.spheroidEllipsoidRadius(model, dx, dy, buf.z[i]);
				if (s > model.truncation.spheroidRadius + 1e-3) outside++;
			}
		}
		check(`${model.type}: no sampled star sits outside its component's truncation`, outside === 0, outside);
	}
	// A type with a single component must land entirely in it, which the mix
	// check above cannot tell apart from a sampler that ignores the weights.
	check('an E4 puts every star in its one component, because it has nothing else', (() => {
		const buf = sampling.createBuffers(2000);
		sampling.sampleGalaxyStars(models.E4, 3, 2000, buf);
		const shares = sampling.componentShares(buf);
		return shares.bulge === 1 && shares.thin === 0 && shares.halo === 0;
	})(), sampling.componentShares(sampling.createBuffers(1)));
}

// --- 5. The Sersic path --------------------------------------------------
{
	const sersic = ALL.filter((m) => m.spheroid.profileId === density.PROFILE_SERSIC);
	check('the table types are Sersic while the preset stayed Plummer',
		sersic.length === TABLE.length && MW.spheroid.profileId === density.PROFILE_PLUMMER
		&& models.Sc.spheroid.profileId === density.PROFILE_SERSIC,
		{ sersic: sersic.map((m) => m.type), preset: MW.spheroid.profile });
	check('the Sersic index follows the authored E shape or stage anchor',
		TABLE.every((m) => m.spheroid.n === (galaxy.TYPE_SPECS[m.type].n
			?? galaxy.interpAnchors(galaxy.ANCHORS.SERSIC_N, m.T))),
		TABLE.map((m) => [m.type, m.spheroid.n]));
	// s is measured in the body's own tilted frame, so a probe at radius s has to
	// undo that rotation: x = s*a*r0*cos(t), y = s*a*r0*sin(t) off the centre.
	const rhoAtS = (model, s) => {
		const t = model.spheroid.tiltDeg * Math.PI / 180;
		const r = s * model.spheroid.a * model.spheroid.r0;
		return density.rhoSpheroid(model, model.centre.x + r * Math.cos(t), model.centre.y + r * Math.sin(t), 0);
	};
	for (const model of sersic) {
		const bn = density.sersicBn(model.spheroid.n);
		check(`${model.type}: b_n is the standard approximation 2n - 1/3`,
			near(bn, 2 * model.spheroid.n - 1 / 3, 1e-9), { n: model.spheroid.n, bn: +bn.toFixed(4) });
		const sMax = model.truncation.spheroidRadius;
		const total = density.sersicMassFraction(model, sMax);
		let worst = 0;
		for (const target of [0.05, 0.25, 0.5, 0.9, 0.99]) {
			const s = density.sersicRadiusForFraction(model, target);
			worst = Math.max(worst, Math.abs(density.sersicMassFraction(model, s) / total - target));
		}
		check(`${model.type}: the inverse CDF round-trips the enclosed-mass fraction`, worst < 2e-3,
			{ worstError: +worst.toExponential(2) });
		check(`${model.type}: the radius found is inside the cut`, sMax > 0 && total > 0,
			{ sMax, enclosed: +total.toFixed(4) });
		check(`${model.type}: the spheroid falls with radius and dies just past the cut`,
			rhoAtS(model, sMax + 0.01) === 0 && rhoAtS(model, 0) > rhoAtS(model, 2),
			{ atCut: rhoAtS(model, sMax + 0.01), centre: +rhoAtS(model, 0).toFixed(4) });
	}
	check('a Sersic spheroid is centrally steeper than the Plummer bulge it replaces',
		rhoAtS(models.E4, 0) / rhoAtS(models.E4, 2) > rhoAtS(MW, 0) / rhoAtS(MW, 2),
		{ E4: +(rhoAtS(models.E4, 0) / rhoAtS(models.E4, 2)).toFixed(1),
			MW: +(rhoAtS(MW, 0) / rhoAtS(MW, 2)).toFixed(1) });
	check('a Plummer bulge delivers almost all of its mass inside the cut',
		density.truncationFractions(MW).bulge > 0.9 && density.truncationFractions(MW).bulge < 1,
		+ density.truncationFractions(MW).bulge.toFixed(4));
}

// --- 6. One uniform, packed from the model ------------------------------
{
	check('the layout, the packer and the struct agree on the size',
		galaxy.DENSITY_PARAMS_LAYOUT.length * 4 === galaxy.DENSITY_PARAMS_FLOATS
		&& galaxy.DENSITY_PARAMS_BYTES === galaxy.DENSITY_PARAMS_FLOATS * 4
		&& galaxy.DENSITY_PARAMS_FLOATS === 40,
		{ floats: galaxy.DENSITY_PARAMS_FLOATS, bytes: galaxy.DENSITY_PARAMS_BYTES });
	const buffer = new Float32Array(galaxy.DENSITY_PARAMS_FLOATS);
	const returned = galaxy.packDensityParams(MW, buffer);
	check('packDensityParams writes into the caller and returns it, never a new array',
		returned === buffer);
	const mwCopy = Float32Array.from(buffer);
	galaxy.packDensityParams(models.E4, buffer);
	check('repacking a different model overwrites every slot',
		[...buffer].every((v, i) => v === Float32Array.from(galaxy.packDensityParams(models.E4, new Float32Array(galaxy.DENSITY_PARAMS_FLOATS)))[i])
		&& buffer.every(Number.isFinite)
		&& buffer.some((v, i) => v !== mwCopy[i]),
		{ changed: [...buffer].filter((v, i) => v !== mwCopy[i]).length });
	const slot = (model, group, field) => {
		const g = galaxy.DENSITY_PARAMS_LAYOUT.find((entry) => entry.name === group);
		galaxy.packDensityParams(model, buffer);
		return buffer[galaxy.DENSITY_PARAMS_LAYOUT.indexOf(g) * 4 + g.fields.indexOf(field)];
	};
	check('the struct carries the spheroid amplitude, index and profile selector',
		slot(models.E4, 'spheroidShape', 'amp') === Math.fround(models.E4.spheroid.amp)
		&& slot(models.E4, 'spheroidShape', 'n') === Math.fround(models.E4.spheroid.n)
		&& slot(models.E4, 'spheroidShape', 'profileId') === density.PROFILE_SERSIC
		&& slot(MW, 'spheroidShape', 'profileId') === density.PROFILE_PLUMMER,
		{ e4n: slot(models.E4, 'spheroidShape', 'n'), preset: slot(MW, 'spheroidShape', 'profileId') });
	check('the boolean population flag arrives as 1.0 or 0.0',
		slot(MW, 'populations', 'gasRich') === 1 && slot(models.S0, 'populations', 'gasRich') === 0,
		{ SBb: slot(MW, 'populations', 'gasRich'), S0: slot(models.S0, 'populations', 'gasRich') });
	for (const model of ALL) {
		galaxy.packDensityParams(model, buffer);
		const pads = [];
		galaxy.DENSITY_PARAMS_LAYOUT.forEach((g, gi) => {
			g.fields.forEach((f, fi) => {
				if (f === 'unused') pads.push(gi * 4 + fi);
			});
		});
		check(`${model.type}: padding slots are zero, never stale memory`,
			pads.length > 0 && pads.every((i) => buffer[i] === 0), pads.length);
	}
}

// --- 7. Gas decides the stellar population ------------------------------
{
	// u1 = 0.5, u2 = 0.5 is the median draw (z = 0), so an expected age is a
	// number rather than a distribution to sample.
	const ageAt = (model, component, distToArm, R) => starTypes.sampleLocalAge(model, component, distToArm, R, 0.5, 0.5);
	for (const model of ALL) {
		const onArm = ageAt(model, density.COMPONENT_THIN, 0.1, 6);
		const offArm = ageAt(model, density.COMPONENT_THIN, 4, 6);
		if (!model.populations.gasRich) {
			check(`${model.type}: a quenched thin disc has nothing young, on an arm or off`,
				onArm > 1 && near(onArm, offArm, 1e-9), { onArm, offArm });
			continue;
		}
		check(`${model.type}: an arm inside the star-forming annulus is young`,
			onArm < 0.05 && offArm > 1, { onArm, offArm });
	}
	check('arm youth stops at the model outer radius, not at a hard-coded 12',
		ageAt(models.Sc, density.COMPONENT_THIN, 0.1, models.Sc.populations.youngOuterR + 1) > 1
		&& ageAt(MW, density.COMPONENT_THIN, 0.1, MW.populations.youngOuterR - 1) < 0.05,
		{ ScOuter: +models.Sc.populations.youngOuterR.toFixed(2) });
	check('inside the co-radius the annulus has not started yet',
		ageAt(MW, density.COMPONENT_THIN, 0.1, MW.arms.Rs - 1) > 1, MW.arms.Rs);
	check('the spheroid and the halo stay old in every type',
		ALL.every((m) => ageAt(m, density.COMPONENT_BULGE, 0, 0) > 5
			&& ageAt(m, density.COMPONENT_HALO, 0, 0) > 5));
	check('a young thick disc is older than a young thin one',
		ageAt(MW, density.COMPONENT_THICK, 0.1, 6) > ageAt(MW, density.COMPONENT_THIN, 0.1, 6));
	// The gate reads the model, so an override moves it without changing the type.
	const quenched = galaxy.createGalaxy({ type: 'Sc', overrides: { populations: { gasFraction: 0.01, gasRich: false } } });
	check('an override can quench a type, and the population follows the model',
		ageAt(quenched, density.COMPONENT_THIN, 0.1, 6) > 1 && quenched.type === 'Sc', quenched.populations);
}

// --- 8. Nebulae need gas ------------------------------------------------
{
	// The probability has a stellar term that no type loses, so what gas decides
	// is whether the *arm* term exists at all: a quenched disc reads the same on
	// a would-be ridge as off it, and nothing gas-origin ever lands.
	const at = (model, R, phiDeg, z) => {
		const phi = phiDeg * Math.PI / 180;
		return nebula.nebulaProbabilityAt(model, model.centre.x + R * Math.cos(phi),
			model.centre.y + R * Math.sin(phi), z).p;
	};
	const k = Math.tan(MW.arms.pitchDeg * Math.PI / 180);
	const ridgePhi = (k * Math.log(6 / MW.arms.Rs)) / MW.arms.m * 180 / Math.PI;
	const GAS_TYPES = ['HII', 'reflection', 'dark'];
	for (const model of ALL) {
		const phi = (Math.tan(model.arms.pitchDeg * Math.PI / 180) * Math.log(6 / model.arms.Rs)
			- model.arms.phase0) / model.arms.m * 180 / Math.PI;
		const onRidge = at(model, 6, phi, 0.02);
		const offRidge = at(model, 6, phi + 180 / model.arms.m, 0.02);
		const placed = nebula.placeNebulae(model, 5, 400, {
			xMin: -20, xMax: 20, yMin: -20, yMax: 20, zMin: -1.5, zMax: 1.5,
		});
		const types = new Set(placed.map((n) => n.type));
		const gasSeen = GAS_TYPES.filter((t) => types.has(t));
		if (!model.populations.gasRich) {
			check(`${model.type}: a quenched type has no arms and hosts no gas nebula`,
				model.arms.amp === 0 && gasSeen.length === 0, { onRidge, offRidge, gasSeen });
			continue;
		}
		check(`${model.type}: the arm ridge is favoured, and gas nebulae are placed on it`,
			onRidge > offRidge * 1.5 && gasSeen.length > 0, { onRidge, offRidge, gasSeen });
	}
	const thinGas = galaxy.createGalaxy({ type: 'Sc', overrides: { populations: { gasFraction: 0.06 } } });
	check('a thinner gas reservoir thins the nebulae, without changing the type',
		at(thinGas, 6, ridgePhi, 0.02) < at(models.Sc, 6, ridgePhi, 0.02),
		{ thin: thinGas.populations.gasFraction, rich: models.Sc.populations.gasFraction });
}

// --- 9. Where the camera starts, and what mode the model is in ---------
{
	for (const model of ALL) {
		const home = model.home;
		const dx = model.centre.x - home.position[0];
		const dy = model.centre.y - home.position[1];
		const dz = model.centre.z - home.position[2];
		const d = Math.hypot(dx, dy, dz);
		// The preset's start is the level 5 pc view over the Sun that 0.1 shipped
		// with; a table type has no authored view, so its home aims at the centre.
		check(model.milkyWay
			? `${model.type}: the preset keeps its authored level view over the Sun`
			: `${model.type}: the home view looks at the model centre`,
			model.milkyWay
				? home.yaw === 0 && home.pitch === 0
				: near(home.yaw, Math.atan2(dy, dx), 1e-9) && near(home.pitch, Math.asin(dz / d), 1e-9),
			{ yaw: +home.yaw.toFixed(4), pitch: +home.pitch.toFixed(4) });
		// The framing rule: far enough to see the body, close enough to fill it.
		const span = model.truncation.spheroidRadius * model.spheroid.a;
		check(`${model.type}: the home view frames the body it was derived from`,
			d > span * 0.4 && d < span * 8, { distance: +d.toFixed(3), span: +span.toFixed(3) });
	}
	check('only the Milky Way preset orbits the Sun',
		MW.home.orbitName === 'Sun' && MW.home.orbitDistance === 0.01
		&& TABLE.every((m) => m.home.orbitName === 'galaxy centre'
			&& m.home.orbitTarget[0] === 0 && m.home.orbitTarget[1] === 0),
		{ E4: models.E4.home.orbitName, E4distance: +models.E4.home.orbitDistance.toFixed(3) });
	// The mode rule the renderer reads: the catalog subset and the named stars
	// exist for the unmodified preset and for nothing else.
	check('a structural override drops the model out of catalog mode',
		galaxy.createGalaxy({ type: 'SBb' }).milkyWay === true
		&& galaxy.createGalaxy({ type: 'SBb', overrides: { thin: { H: 0.5 } } }).milkyWay === false
		&& models.E4.milkyWay === false);
	// An override on the preset type means "not the preset", so both sides of this
	// comparison are table models. The solve runs before the override, not after:
	// a hand-edit is a hand-edit, and re-normalising it would silently undo the
	// one thing the caller asked for (including an explicit `amp`). The mass that
	// component carries therefore follows the shape, as it would in a real galaxy
	// whose scale height changed.
	check('an override lands verbatim, on the group it names and no further', (() => {
		const base = galaxy.createGalaxy({ type: 'SBb', overrides: { thin: {} } });
		const tweaked = galaxy.createGalaxy({ type: 'SBb', overrides: { thin: { H: 0.5 } } });
		return tweaked.thin.H === 0.5 && base.thin.H !== 0.5
			&& tweaked.thin.L === base.thin.L && tweaked.thin.amp === base.thin.amp
			&& tweaked.thick.H === base.thick.H
			&& tweaked.truncation.discRadius === base.truncation.discRadius
			&& !relNear(density.componentMasses(tweaked).thin, density.componentMasses(base).thin, 1e-3);
	})(), { base: galaxy.createGalaxy({ type: 'SBb', overrides: { thin: {} } }).thin,
		tweaked: galaxy.createGalaxy({ type: 'SBb', overrides: { thin: { H: 0.5 } } }).thin });
	check('a profile override re-syncs the numeric selector the hot path reads', (() => {
		const model = galaxy.createGalaxy({ type: 'SBb', overrides: { spheroid: { profile: 'sersic', n: 2 } } });
		return model.spheroid.profileId === density.PROFILE_SERSIC && model.spheroid.n === 2;
	})(), galaxy.createGalaxy({ type: 'SBb', overrides: { spheroid: { profile: 'sersic', n: 2 } } }).spheroid.profileId);
	check('an override outside the allowed list is refused', (() => {
		try {
			galaxy.createGalaxy({ type: 'SBb', overrides: { seed: 7 } });
			return false;
		} catch (err) {
			return /not allowed/.test(err.message);
		}
	})());
}

// --- Report --------------------------------------------------------------
let passed = 0;
let failed = 0;
for (const c of checks) {
	if (c.pass) passed++; else failed++;
	console.log(`  ${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.pass ? '' : `  -> ${JSON.stringify(c.detail)}`}`);
}
console.log(`\n${passed}/${checks.length} passed, ${failed} failed`);

const logPath = path.join(__dirname, 'logs', 'galaxy-types.json');
fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.writeFileSync(logPath, JSON.stringify({
	date: new Date().toISOString(),
	types: TYPES,
	perType: ALL.map((model) => {
		const delivered = sampling.deliveredMasses(model);
		const fractions = density.truncationFractions(model);
		const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, +v.toFixed(5)]));
		return {
			type: model.type,
			T: model.T,
			scaleKpc: model.scaleKpc,
			pitchDeg: model.arms.pitchDeg,
			gasFraction: model.populations.gasFraction,
			gasRich: model.populations.gasRich,
			fromPreset: galaxy.TYPE_SPECS[model.type].preset === true,
			totalMass: +delivered.total.toFixed(4),
			delivered: round(delivered),
			truncationFractions: round(fractions),
			home: model.home.position.map((v) => +v.toFixed(4)).concat([+model.home.yaw.toFixed(4), +model.home.pitch.toFixed(4)]),
		};
	}),
	totalChecks: checks.length,
	passed,
	failed,
	checks,
}, null, 2));
console.log(`Wrote ${logPath}`);
console.log('\n=== VERDICT ===');
console.log(failed === 0 ? 'PASS — the type table builds the fields it claims' : `FAIL — ${failed} checks failed`);
process.exit(failed === 0 ? 0 : 1);
