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
		galaxy.createGalaxy({}).type === galaxy.MILKY_WAY_TYPE && galaxy.createGalaxy({}).milkyWay === true
		&& galaxy.createGalaxy({ type: null }).type === galaxy.MILKY_WAY_TYPE && galaxy.createGalaxy({ type: null }).milkyWay === true);
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
		['spheroid.a', MW.spheroid.a, 2.3], ['spheroid.b', MW.spheroid.b, 0.405], ['spheroid.c', MW.spheroid.c, 0.189],
		['spheroid.r0', MW.spheroid.r0, 1.0], ['spheroid.amp', MW.spheroid.amp, 31.36],
		['spheroid.tiltDeg', MW.spheroid.tiltDeg, 27], ['spheroid.profile', MW.spheroid.profile, 'bar'],
		['spheroid.profileId', MW.spheroid.profileId, density.PROFILE_BAR],
		['bar.peanut', MW.bar.peanut, 0.45], ['bar.endCap', MW.bar.endCap, 0.304],
		['bar.plateau', MW.bar.plateau, 0.55], ['bar.vertical', MW.bar.vertical, 2.40],
		['halo.a_h', MW.halo.a_h, 1.0], ['halo.rMax', MW.halo.rMax, 100.0],
		['halo.power', MW.halo.power, 3.5], ['halo.amp', MW.halo.amp, 0.0008],
		['arms.m', MW.arms.m, 2], ['arms.amp', MW.arms.amp, 0.2], ['arms.pitchDeg', MW.arms.pitchDeg, 12],
		['arms.Rs', MW.arms.Rs, 3.0], ['arms.phase0', MW.arms.phase0, 2.8406], ['arms.minRadius', MW.arms.minRadius, 2.3],
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
	// 0.4.8 M2: the central component is the observed boxy/peanut bar. The
	// three Wegg & Gerhard axis scale lengths (0.70 : 0.44 : 0.18 kpc) are
	// matched where the family has the knob: the longitudinal cap IS an
	// exponential of scale endCap·a, and the transverse/vertical half-density
	// extents stand in for the exponential scales (an exponential of scale h
	// has half-density extent ln2·h). The amplitude is whatever hands the
	// Plummer bulge's mass over at the observed thinness.
	check('the preset bar carries the observed half-length and axis scale lengths', (() => {
		const LN2 = Math.log(2);
		const t = MW.spheroid.tiltDeg * Math.PI / 180;
		const along = (axis, s) => {
			const ux = axis === 'x' ? Math.cos(t) : axis === 'y' ? -Math.sin(t) : 0;
			const uy = axis === 'x' ? Math.sin(t) : axis === 'y' ? Math.cos(t) : 0;
			return density.rhoSpheroid(MW, MW.centre.x + ux * s, MW.centre.y + uy * s,
				axis === 'z' ? s : 0) / MW.spheroid.amp;
		};
		const halfExtent = (axis) => {
			let lo = 1e-6, hi = MW.spheroid.a;
			for (let i = 0; i < 60; i++) {
				const mid = (lo + hi) / 2;
				if (along(axis, mid) > 0.5) lo = mid; else hi = mid;
			}
			return (lo + hi) / 2;
		};
		const halfY = halfExtent('y');
		const halfZ = halfExtent('z');
		return near(MW.spheroid.a * MW.spheroid.r0, 2.3, 1e-12)
			&& near(MW.bar.endCap * MW.spheroid.a, 0.6992, 1e-3)
			&& near(halfY, 0.44 * LN2, 0.0044 * LN2)
			&& near(halfZ, 0.18 * LN2, 0.0018 * LN2);
	})(), { endCapScale: +(MW.bar.endCap * MW.spheroid.a).toFixed(4) });
	check('the preset bar hands back the Plummer bulge mass it replaced',
		near(density.componentMasses(MW).bulge, 15.0796, 0.001),
		+ density.componentMasses(MW).bulge.toFixed(5));
}

// The menu contains all regular types, while G remains a short tour.
{
	const expected = ['E0', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7',
		'S0', 'Sa', 'Sb', 'Sc', 'Sd', 'SB0', 'SBa', 'SBb', 'SBc', 'SBd', 'Irr'];
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
	// The cut is in units of s, so scaleKpc never moves it; 0.4.8 M3.1 pushes
	// it out to the profile's own floor radius where the authored number would
	// cut mid-light (an n = 4 Sérsic at s = 8 is still at 5.4e-3 of its
	// effective-radius density), and leaves it alone where it is already past.
	check('the spheroid cut is in units of s, so scaleKpc does not move it',
		models.Sc.truncation.spheroidRadius === galaxy.TYPE_SPECS.Sc.spheroidRadius
		&& models.E4.truncation.spheroidRadius > galaxy.TYPE_SPECS.E4.spheroidRadius
		&& galaxy.createGalaxy({ type: 'E4', seed: 42 }).truncation.spheroidRadius
			=== models.E4.truncation.spheroidRadius,
		{ Sc: models.Sc.truncation.spheroidRadius, E4: models.E4.truncation.spheroidRadius });
	// Every model: the cut is at least the profile's floor radius, and at
	// least the authored minimum. E4 is the pushed case, Sc the untouched one.
	check('a cut never sits where the profile is still above the truncation floor',
		ALL.every((m) => m.spheroid.profileId === density.PROFILE_BAR
			|| (m.truncation.spheroidRadius + 1e-9
				>= density.spheroidFloorRadius(m.spheroid.profileId, m.spheroid.n)
				&& m.truncation.spheroidRadius + 1e-9 >= galaxy.TYPE_SPECS[m.type].spheroidRadius))
		&& models.E4.truncation.spheroidRadius
			=== density.spheroidFloorRadius(density.PROFILE_SERSIC, models.E4.spheroid.n),
		{ E4: +models.E4.truncation.spheroidRadius.toFixed(3),
			floorE4: +density.spheroidFloorRadius(density.PROFILE_SERSIC, models.E4.spheroid.n).toFixed(3) });
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
				// Each disc component carries its own vertical cut (0.4.8 M3.1).
				const thin = buf.component[i] === density.COMPONENT_THIN;
				if (!density.insideDisc(model, buf.R[i], buf.z[i],
					thin ? model.thin : model.thick, thin ? 'sech2' : 'laplace')) outside++;
			} else if (buf.component[i] === density.COMPONENT_BULGE) {
				let s;
				if (model.spheroid.profileId === density.PROFILE_BAR) {
					const t = model.spheroid.tiltDeg * Math.PI / 180;
					const ct = Math.cos(t), st = Math.sin(t);
					const xrot = dx * ct + dy * st, yrot = -dx * st + dy * ct;
					const n = model.spheroid.n || 2.5;
					const ax = Math.abs(xrot / model.spheroid.a), ay = Math.abs(yrot / model.spheroid.b), az = Math.abs(buf.z[i] / model.spheroid.c);
					s = Math.pow(Math.pow(ax, n) + Math.pow(ay, n) + Math.pow(az, n), 1 / n) / model.spheroid.r0;
				} else {
					s = density.spheroidEllipsoidRadius(model, dx, dy, buf.z[i]);
				}
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
	const bar = ALL.filter((m) => m.spheroid.profileId === density.PROFILE_BAR);
	check('the unbarred table types are Sersic while every barred type, the preset included, is Bar',
		sersic.length + bar.length === ALL.length && bar.includes(MW)
		&& bar.every((m) => m.barred) && sersic.every((m) => !m.barred)
		&& models.Sc.spheroid.profileId === density.PROFILE_SERSIC,
		{ sersic: sersic.map((m) => m.type), bar: bar.map((m) => m.type) });
	// One index field for two profiles: a Sérsic index for the unbarred types, the
	// boxiness for a bar, and an authored `n` (the E stages) wins over both.
	check('the spheroid index follows the authored value or the profile\'s anchor',
		TABLE.every((m) => m.spheroid.n === (galaxy.TYPE_SPECS[m.type].n
			?? (m.spheroid.profileId === density.PROFILE_BAR
				? galaxy.interpAnchors(galaxy.ANCHORS.BAR_BOXINESS, m.T)
				: galaxy.interpAnchors(galaxy.ANCHORS.SERSIC_N, m.T)))),
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
	// The comparison points are inside the bodies: half an axis out, the Sérsic
	// has already lost 2/3 of its peak while the bar's plateau is still flat.
	check('a Sersic spheroid is centrally steeper than the preset bar, even at half an axis',
		rhoAtS(models.E4, 0) / rhoAtS(models.E4, 0.5) > rhoAtS(MW, 0) / rhoAtS(MW, 0.5),
		{ E4: +(rhoAtS(models.E4, 0) / rhoAtS(models.E4, 0.5)).toFixed(1),
			MW: +(rhoAtS(MW, 0) / rhoAtS(MW, 0.5)).toFixed(1) });
	check('the bounded bar delivers its whole mass inside its tip',
		density.truncationFractions(MW).bulge === 1,
		+ density.truncationFractions(MW).bulge.toFixed(4));
}

// --- 6. One uniform, packed from the model ------------------------------
{
	// 16 flat vec4 groups plus the trailing clump array (12 vec4s). The three
	// past `populations` are 0.3.3's: the clock and the two halves of the
	// per-component formation window.
	check('the layout, the packer and the struct agree on the size',
		galaxy.DENSITY_PARAMS_LAYOUT.length * 4 + galaxy.DENSITY_PARAMS_CLUMP_FLOATS === galaxy.DENSITY_PARAMS_FLOATS
		&& galaxy.DENSITY_PARAMS_BYTES === galaxy.DENSITY_PARAMS_FLOATS * 4
		&& galaxy.DENSITY_PARAMS_FLOATS === 16 * 4 + 12 * 4,
		{ floats: galaxy.DENSITY_PARAMS_FLOATS, bytes: galaxy.DENSITY_PARAMS_BYTES,
			groups: galaxy.DENSITY_PARAMS_LAYOUT.length, clumps: galaxy.DENSITY_PARAMS_CLUMPS });
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
		&& slot(MW, 'spheroidShape', 'profileId') === density.PROFILE_BAR,
		{ e4n: slot(models.E4, 'spheroidShape', 'n'), preset: slot(MW, 'spheroidShape', 'profileId') });
	check('the boolean population flag arrives as 1.0 or 0.0',
		slot(MW, 'populations', 'gasRich') === 1 && slot(models.S0, 'populations', 'gasRich') === 0,
		{ SBb: slot(MW, 'populations', 'gasRich'), S0: slot(models.S0, 'populations', 'gasRich') });
	// 0.3.3's three groups: the clock the population formulas read, and the two
	// halves of the per-component formation window. The windows arrive as CDF
	// fractions of the model's own truncated SFH — the numbers the shader mixes —
	// not as the window fractions the descriptor authors.
	check('the clock group carries the age, the timescale and the span star formation covers',
		slot(MW, 'clock', 'age') === Math.fround(galaxy.AGE_REF)
		&& slot(MW, 'clock', 'tauSfh') === Math.fround(MW.populations.tauSfh)
		&& slot(MW, 'clock', 'sfhSpan') === Math.fround(MW.populations.sfhSpan)
		&& slot(models.E4, 'clock', 'sfhSpan') === Math.fround(models.E4.populations.quenchTime),
		{ preset: [slot(MW, 'clock', 'age'), slot(MW, 'clock', 'tauSfh'), slot(MW, 'clock', 'sfhSpan')],
			E4Span: slot(models.E4, 'clock', 'sfhSpan'), E4Quench: models.E4.populations.quenchTime });
	check('the formation windows arrive as CDF intervals, one pair per component',
		['thinLo', 'thickLo', 'bulgeLo', 'haloLo']
			.every((f, c) => slot(MW, 'formLo', f) === Math.fround(MW.populations.formQ[c * 2]))
		&& ['thinHi', 'thickHi', 'bulgeHi', 'haloHi']
			.every((f, c) => slot(MW, 'formHi', f) === Math.fround(MW.populations.formQ[c * 2 + 1]))
		&& slot(MW, 'formLo', 'haloLo') === 0 && slot(MW, 'formHi', 'thinHi') === 1,
		MW.populations.formQ.map((v) => +v.toFixed(5)));
	for (const model of ALL) {
		// q is [thinLo, thinHi, thickLo, thickHi, bulgeLo, bulgeHi, haloLo, haloHi],
		// indexed like density.COMPONENT_*.
		const q = model.populations.formQ;
		check(`${model.type}: the formation windows are nested in assembly order`,
			q.length === 8 && q.every((v) => v >= 0 && v <= 1)
			&& [0, 1, 2, 3].every((c) => q[c * 2] <= q[c * 2 + 1])
			&& q[7] <= q[5] && q[5] <= q[3] && q[3] <= q[1],
			q.map((v) => +v.toFixed(4)));
	}
	// The renderer's property-only regenerate trusts this verdict with 300k
	// stars, so it has to say "the field moves" exactly when the field moves: an
	// age step or a gas override keeps the positions, anything structural does
	// not. Note the pairs are built from one base each — the preset and a
	// table-built SBb are *not* the same geometry, which is the point of the
	// preset existing.
	const overrideOf = (overrides) => galaxy.createGalaxy({ type: 'Sc', seed: 42, overrides });
	const geometryPairs = [
		['the preset at another age', MW, galaxy.modelAtAge(MW, 2), true],
		['a table type at another age', models.Sc, galaxy.modelAtAge(models.Sc, 0.5), true],
		['a gas override', models.Sc, overrideOf({ populations: { gasFraction: 0.4 } }), true],
		['an age override', models.Sc, overrideOf({ populations: { age: 3 } }), true],
		['a disc-thickness override', models.Sc, overrideOf({ thin: { H: 0.4 } }), false],
		['an arm-contrast override', models.Sc, overrideOf({ arms: { amp: 0.4 } }), false],
		['another seed', MW, galaxy.createGalaxy({ type: 'SBb', seed: 43 }), false],
		['another type', models.Sc, models.Sd, false],
	];
	const wrongGeometry = geometryPairs.filter((pair) => galaxy.sameGeometry(pair[1], pair[2]) !== pair[3]);
	check('sameGeometry holds across an age change and breaks on anything that moves stars',
		wrongGeometry.length === 0,
		wrongGeometry.map((pair) => ({ pair: pair[0], expected: pair[3] })));
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

// --- 6b. The shape machinery: bar, coupling, clumps, gradient ------------
{
	// The bar is a boxy/peanut body (uniform inside a boxy cross-section, flat
	// along the major axis out to `plateau`, exponential past it), so its mass
	// integral is a quadrature over that body rather than a closed form. Two
	// independent checks: the ellipsoid limit is exact, and a midpoint sum of the
	// *field function itself* has to reproduce the delivered component mass.
	// SBb is the authored preset (a bar bulge since 0.4.8 M2), so the table
	// carries four barred types: SB0, SBa, SBc, SBd.
	const bar = TABLE.filter((m) => m.spheroid.profileId === density.PROFILE_BAR);
	check('every barred table type carries the bar profile', bar.length === 4,
		bar.map((m) => m.type));
	// The bar frame as the field measures it: |xi| along the major axis, and the
	// slice coordinates (u, v) inside the cross-section. Since 0.4.8 the body is
	// the *slice envelope* (|u|^n + |v|^cv = 1), not an s <= 1 level.
	function barLevel(model, x, y, z) {
		const sp = model.spheroid;
		const t = sp.tiltDeg * Math.PI / 180;
		const ct = Math.cos(t);
		const st = Math.sin(t);
		const dx = x - model.centre.x;
		const dy = y - model.centre.y;
		const dz = z - model.centre.z;
		const n = sp.n;
		const xi = (dx * ct + dy * st) / (sp.a * sp.r0);
		const eta = (-dx * st + dy * ct) / (sp.b * sp.r0);
		const tau = density.barCrossSectionRadius(model, xi, density.barTipRadius(model));
		const stretch = density.barVerticalStretch(model, xi);
		const u = tau > 0 ? eta / tau : Infinity;
		const v = tau > 0 ? dz / (sp.c * sp.r0 * stretch * tau) : Infinity;
		const cv = density.barVerticalExponent(model);
		const m = tau > 0 ? Math.pow(Math.abs(u), n) + Math.pow(Math.abs(v), cv) : Infinity;
		return { m, xi };
	}
	for (const model of bar) {
		const sp = model.spheroid;
		const axes = sp.a * sp.b * sp.c * sp.r0 ** 3;
		// The 0.4.8 slice pin: at n = 2 with no peanut and no cap the boxy body
		// is the ellipsoid of the axes, the longitudinal weight integrates to
		// 2/3 per side, and the slice mass is the closed form barSliceMass
		// carries — which is *the* check that the analytic mass and the
		// generalised slice profile describe the same body. (The uniform slab
		// this replaces is the q = 0, cv = n case of the same family, pinned
		// separately in shape-test.js.)
		const ell = galaxy.createGalaxy({ type: model.type, overrides: {
			spheroid: { n: 2 }, bar: { peanut: 0, plateau: 1, endCap: 1 },
		} });
		check(`${model.type}: the n=2 bar with no peanut has the analytic slice-profile mass`,
			relNear(density.massIntegrals(ell).bulge,
				2 * axes * density.barSliceMass(ell) * 2 / 3, 1e-9),
			density.massIntegrals(ell).bulge);
		// The vertical boxiness is authored per stage: >= 2 everywhere, so the
		// bar's vertical profile has a smooth top (a smaller exponent would put
		// a cusp at the midplane), and squarest in the early types.
		check(`${model.type}: the bar's vertical profile exponent is a smooth-top boxiness`,
			model.bar.vertical >= 2 && model.bar.vertical <= 4
			&& model.bar.vertical === galaxy.interpAnchors(galaxy.ANCHORS.BAR_VERTICAL, model.T),
			{ vertical: model.bar.vertical, T: model.T });
		// Midpoint sum of rhoSpheroid over the bar's bounding box, divided by amp:
		// the field's own integral, with no use of the closed bookkeeping.
		const span = 1.05 * Math.max(sp.a, sp.b) * sp.r0;
		const height = 1.05 * sp.c * sp.r0 * (1 + model.bar.peanut);
		const steps = 64;
		const d = 2 * span / steps;
		const dz = 2 * height / steps;
		let sum = 0;
		for (let i = 0; i < steps; i++) {
			const x = model.centre.x - span + (i + 0.5) * d;
			for (let j = 0; j < steps; j++) {
				const y = model.centre.y - span + (j + 0.5) * d;
				for (let k = 0; k < steps; k++) {
					sum += density.rhoSpheroid(model, x, y, model.centre.z - height + (k + 0.5) * dz);
				}
			}
		}
		const grid = sum * d * d * dz / sp.amp;
		check(`${model.type}: the bar mass integral is the field's own integral`,
			relNear(grid, density.massIntegrals(model).bulge, 5e-3),
			{ grid: +grid.toFixed(4), integral: +density.massIntegrals(model).bulge.toFixed(4) });
	}
	// The bar is a bounded body: a truncation shorter than its tip crops the mass,
	// the sampler follows it, and no star is ever drawn outside the body.
	for (const model of bar) {
		const cut = galaxy.createGalaxy({ type: model.type, overrides: { truncation: { spheroidRadius: 0.5 } } });
		const full = density.massIntegrals(model).bulge;
		const delivered = density.truncationFractions(cut).bulge;
		check(`${model.type}: a truncation shorter than the bar crops the delivered mass`,
			relNear(density.massIntegrals(cut).bulge, full, 1e-12) && delivered > 0.05 && delivered < 0.35,
			{ delivered: +delivered.toFixed(4), untruncated: +full.toFixed(4) });
		const buf = sampling.createBuffers(6000);
		sampling.sampleGalaxyStars(cut, 5, 6000, buf);
		let outside = 0;
		for (let i = 0; i < buf.count; i++) {
			if (buf.component[i] !== density.COMPONENT_BULGE) continue;
			const level = barLevel(cut, buf.x[i], buf.y[i], buf.z[i]);
			if (level.m > 1 + 1e-6 || Math.abs(level.xi) > 0.5 + 1e-6) outside++;
		}
		check(`${model.type}: no bar star is drawn past the cropped tip`, outside === 0, outside);
		const whole = sampling.createBuffers(6000);
		sampling.sampleGalaxyStars(model, 5, 6000, whole);
		let strayed = 0;
		for (let i = 0; i < whole.count; i++) {
			if (whole.component[i] !== density.COMPONENT_BULGE) continue;
			const level = barLevel(model, whole.x[i], whole.y[i], whole.z[i]);
			if (level.m > 1 + 1e-6 || Math.abs(level.xi) > 1 + 1e-6) strayed++;
		}
		check(`${model.type}: every sampled bar star lies inside the body the field draws`,
			strayed === 0, strayed);
	}

	// The lane widths are fractions of the pattern's ridge spacing, so the
	// spacing the field actually has must be the λ those widths are written in:
	// 2*pi*R*sin(pitch)/m = 2*pi*R/hypot(m, K). Measured here by scanning a ray
	// at fixed azimuth and reading the geometric ratio of consecutive crest
	// radii, which is e^(2*pi/K) for a log spiral — a different geometry from the
	// winding check above, and no arctangent of a chord. K comes out to within
	// 0.03 % of m/tan(pitch), and the λ it implies to within 0.03 % of the
	// formula armRidgeWidth uses.
	for (const type of ['Sa', 'Sb', 'Sc', 'Sd', 'MW']) {
		const m = type === 'MW' ? MW : galaxy.createGalaxy({ type, overrides: { arms: { flocculence: 0 } } });
		const phi = 0.3;
		const step = 0.002;
		const crests = [];
		let prev = -1;
		let prevPrev = -1;
		for (let R = m.arms.minRadius * 1.2; R < 20; R += step) {
			const v = density.armFactor(m, R, phi);
			if (prev > v && prev > prevPrev) crests.push(R - step);
			prevPrev = prev;
			prev = v;
		}
		const R1 = crests[crests.length - 2];
		const R2 = crests[crests.length - 1];
		const K = 2 * Math.PI / Math.log(R2 / R1);
		const pitch = Math.atan(m.arms.m / K) * 180 / Math.PI;
		const Rmid = Math.sqrt(R1 * R2);
		const lambdaPattern = 2 * Math.PI * Rmid / Math.hypot(m.arms.m, K);
		const lambdaWidth = 2 * Math.PI * Rmid * Math.sin(m.arms.pitchDeg * Math.PI / 180) / m.arms.m;
		check(`${type}: the crest spacing is the pattern's own, e^(2*pi/K)`,
			Math.abs(pitch - m.arms.pitchDeg) < 0.05 && Math.abs(lambdaPattern - lambdaWidth) < 0.005 * lambdaWidth,
			{ pitchFromSpacing: +pitch.toFixed(3), anchor: m.arms.pitchDeg,
				lambdaSpacing: +lambdaPattern.toFixed(4), lambdaWidth: +lambdaWidth.toFixed(4) });
	}

	// Bar-end arm coupling: for table barred types the arm inner edge IS the
	// bar's semimajor axis, and phase0 is solved so the nearest ridge passes
	// through that point at the bar's tilt.
	for (const model of bar) {
		if (model.arms.amp === 0) {
			check(`${model.type}: a barred lenticular keeps the bar and drops the arms`,
				model.arms.amp === 0 && model.arms.m === 2 && near(model.arms.minRadius, model.spheroid.a, 1e-12),
				{ minRadius: model.arms.minRadius, a: model.spheroid.a });
			continue;
		}
		const tiltRad = model.spheroid.tiltDeg * Math.PI / 180;
		check(`${model.type}: the arms start where the bar ends (minRadius = a)`,
			near(model.arms.minRadius, model.spheroid.a, 1e-12),
			{ minRadius: model.arms.minRadius, a: model.spheroid.a });
		check(`${model.type}: the ridge passes through the bar end at the bar tilt`,
			near(density.distanceToNearestArm(model, model.arms.minRadius, tiltRad), 0, 1e-9),
			density.distanceToNearestArm(model, model.arms.minRadius, tiltRad));
		check(`${model.type}: the ridge has wound off the bar end further out`,
			density.distanceToNearestArm(model, model.arms.minRadius * 2, tiltRad) > 0.1,
			density.distanceToNearestArm(model, model.arms.minRadius * 2, tiltRad));
	}
	// The preset couples its arms to its bar end through the same solved phase
	// the table path derives (galaxy.tableGeometry): minRadius = a·r0 and a
	// ridge through the tip at the bar tilt.
	check('the authored preset couples its arms to the bar end like the table path', (() => {
		const pitchRad = MW.arms.pitchDeg * Math.PI / 180;
		const tiltRad = MW.spheroid.tiltDeg * Math.PI / 180;
		const m = MW.arms.m;
		const phase = (m / Math.tan(pitchRad)) * Math.log(MW.arms.minRadius / MW.arms.Rs) - m * tiltRad;
		const wrapped = phase - 2 * Math.PI * Math.floor(phase / (2 * Math.PI));
		return near(MW.arms.minRadius, MW.spheroid.a * MW.spheroid.r0, 1e-12)
			// phase0 is authored rounded to 4 decimals; the ridge sits ~1e-5 kpc
			// off the tip as a result, which no view can see.
			&& near(MW.arms.phase0, wrapped, 1e-4)
			&& near(density.distanceToNearestArm(MW, MW.arms.minRadius, tiltRad), 0, 1e-4);
	})(), { minRadius: MW.arms.minRadius, phase0: MW.arms.phase0 });

	// The pitch angle is the angle the arms actually wind at. This measures the
	// field itself — no formula from the library is re-used — by finding the arm
	// crest with a scan at two nearby radii and reading the angle between the
	// crest line and the circumferential direction. A pitch of 12 deg means the
	// ridge has moved 1/tan(12) = 4.7 rad in azimuth after one e-fold in radius,
	// which is the difference between a spiral and a fan of straight spokes. The
	// geometric mean is the radius a log spiral's chord is measured at (a plain
	// R biases the angle up by ~3 %); the estimator is exact to 0.002 deg on a
	// true log spiral.
	for (const type of ['Sa', 'Sb', 'Sc', 'Sd', 'SBa', 'SBb', 'SBc', 'SBd']) {
		const model = galaxy.createGalaxy({ type, overrides: { arms: { flocculence: 0 } } });
		const crestPhiAt = (r) => {
			let bestPhi = 0;
			let best = -1;
			const steps = 2160 * model.arms.m;
			for (let i = 0; i < steps; i++) {
				const phi = 2 * Math.PI * i / steps;
				const v = density.armFactor(model, r, phi);
				if (v > best) { best = v; bestPhi = phi; }
			}
			return bestPhi;
		};
		const R = 6;
		const R2 = R * 1.05;
		const p1 = crestPhiAt(R);
		let dphi = crestPhiAt(R2) - p1;
		while (dphi > Math.PI / model.arms.m) dphi -= 2 * Math.PI / model.arms.m;
		while (dphi < -Math.PI / model.arms.m) dphi += 2 * Math.PI / model.arms.m;
		const pitch = Math.atan2(R2 - R, Math.sqrt(R * R2) * Math.abs(dphi)) * 180 / Math.PI;
		check(`${type}: the arm crest winds at the model's pitch angle`,
			Math.abs(pitch - model.arms.pitchDeg) < 0.15,
			{ pitch: +pitch.toFixed(3), anchor: model.arms.pitchDeg });
	}

	// Irregular clumps: 12 PCG-hashed hotspots on Irr only, stable per
	// (type, seed), inside the disc, and live in the field.
	const irr = models.Irr;
	check('Irr carries exactly CLUMP_COUNT hotspots', irr.clumps.length === galaxy.CLUMP_COUNT, irr.clumps.length);
	check('Irr clumps sit inside the disc with the authored width and boost',
		irr.clumps.every((c) => Math.abs(c.x) <= 1e-12 + galaxy.CLUMP_SPAN_R * irr.truncation.discRadius
			&& Math.abs(c.y) <= 1e-12 + galaxy.CLUMP_SPAN_R * irr.truncation.discRadius
			&& Math.abs(c.z) <= 1e-12 + galaxy.CLUMP_Z_RATIO * irr.truncation.discHeight
			&& near(c.r, galaxy.CLUMP_R_OVER_K * irr.scaleKpc, 1e-12) && near(c.boost, galaxy.CLUMP_BOOST, 1e-12)),
		irr.clumps[0]);
	check('every regular type has no clumps and no FBM texture',
		TABLE.filter((m) => m.type !== 'Irr').every((m) => m.clumps.length === 0 && m.clumpFbm === 0),
		null);
	const irrAgain = galaxy.createGalaxy({ type: 'Irr', seed: 42 });
	const irrSeed7 = galaxy.createGalaxy({ type: 'Irr', seed: 7 });
	check('Irr clumps are a pure function of (type, seed)',
		JSON.stringify(irr.clumps) === JSON.stringify(irrAgain.clumps)
		&& JSON.stringify(irr.clumps) !== JSON.stringify(irrSeed7.clumps),
		null);
	const c0 = irr.clumps[0];
	const at = density.rhoDecomposed(irr, c0.x, c0.y, c0.z, true);
	const base = density.rhoDecomposed(irr, c0.x, c0.y, c0.z, false);
	check('the field shows the hotspot boost at a clump centre',
		(at.thin + at.thick) / (base.thin + base.thick) > 2.5,
		(at.thin + at.thick) / (base.thin + base.thick));
	// And the two-stage sampler moves a visible share of stars into clumps.
	const irrSample = sampling.sampleGalaxyStars(irr, 42, 40000);
	let clumpHits = 0;
	for (let i = 0; i < irrSample.count; i++) {
		for (const c of irr.clumps) {
			const dx = irrSample.x[i] - c.x, dy = irrSample.y[i] - c.y, dz = irrSample.z[i] - c.z;
			if (dx * dx + dy * dy + dz * dz < 4 * c.r * c.r) { clumpHits++; break; }
		}
	}
	check('the sampler assigns stars to the clumps the field carries',
		clumpHits / irrSample.count > 0.015, +(clumpHits / irrSample.count).toFixed(4));

	// Radial metallicity: one dial (gradientSteep), flat in E, steep in Sc.
	check('gradientSteep is monotone up the sequence and per-type',
		relNear(models.E4.populations.gradientSteep, 0, 1e-12)
		&& relNear(models.S0.populations.gradientSteep, 0.25, 1e-9)
		&& relNear(models.Sa.populations.gradientSteep, 0.5, 1e-9)
		&& models.Sa.populations.gradientSteep < models.Sb.populations.gradientSteep
		&& models.Sb.populations.gradientSteep <= models.Sc.populations.gradientSteep
		&& relNear(models.Sc.populations.gradientSteep, 1.0, 1e-9)
		&& near(MW.populations.gradientSteep, 0.75, 1e-12),
		{ S0: models.S0.populations.gradientSteep, Sb: models.Sb.populations.gradientSteep, Sc: models.Sc.populations.gradientSteep });
	// The +1 step is reached at R = 2*L/steep. Find a seed whose star is a K
	// dwarf in the thin disc (so the shift has a step left to climb) and
	// verify the shift at the authored radius.
	let seed = 1;
	while (seed < 1000) {
		const probe = starTypes.deriveStar(models.Sc, seed, density.COMPONENT_THIN, 0.5, 2.0, {});
		if (probe.state === 'ms' && probe.spectralClass === 'K') break;
		seed++;
	}
	if (seed < 1000) {
		const inner = starTypes.deriveStar(models.Sc, seed, density.COMPONENT_THIN, 0.5, 2.0, {});
		const outer = starTypes.deriveStar(models.Sc, seed, density.COMPONENT_THIN, models.Sc.thin.L * 2 + 0.1, 2.0, {});
		check('the Sc thin disc gains one colour step by R = 2L, clamped at M',
			inner.colorIndex === 5 && outer.colorIndex === 6,
			{ inner: inner.colorIndex, outer: outer.colorIndex });
	}
	let flat = true;
	for (let i = 1; i <= 2000; i++) {
		const a = starTypes.deriveStar(models.E4, i, density.COMPONENT_THIN, 1, 2.0, {});
		const b = starTypes.deriveStar(models.E4, i, density.COMPONENT_THIN, 10, 2.0, {});
		if (a.colorIndex !== b.colorIndex) { flat = false; break; }
	}
	check('the E thin disc stays flat (no gradient, no shift)', flat, null);
	// WDs (7) and giants (8) keep their evolutionary colour; the gradient may
	// only move main-sequence stars, and only toward M.
	let neverWD = true;
	for (let i = 1; i <= 2000; i++) {
		const o = starTypes.deriveStar(models.Sc, i, density.COMPONENT_THIN, 30, 2.0, {});
		if (o.state === 'ms' && o.colorIndex > 6) { neverWD = false; break; }
	}
	check('the thin-disc gradient never promotes an MS star past M', neverWD, null);
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
	// The gate reads the model, so an override moves it without changing the
	// type. `gasRich` is not overridden: it is solved from the gas left at the
	// model's age, so an authored flag would be a second copy of one fact.
	const quenched = galaxy.createGalaxy({ type: 'Sc', overrides: { populations: { gasFraction: 0.01 } } });
	check('an override can quench a type, and the population follows the model',
		ageAt(quenched, density.COMPONENT_THIN, 0.1, 6) > 1 && quenched.type === 'Sc'
		&& quenched.populations.gasRich === false, quenched.populations);
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
	const ridgePhi = density.armRidgeAzimuth(models.Sc, 6) * 180 / Math.PI;
	const GAS_TYPES = ['HII', 'reflection', 'dark'];
	for (const model of ALL) {
		const phi = density.armRidgeAzimuth(model, 6) * 180 / Math.PI;
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
		// The framing rule: far enough to see the body, close enough to fill
		// it. The body is the bright one homeFor derives from — the disc scale
		// length, or the spheroid's semimajor axis — not the truncation, which
		// since 0.4.8 M3.1 reaches out to the profile's 1e-3 floor.
		const span = model.thin.amp > 0 ? model.thin.L : model.spheroid.a;
		check(`${model.type}: the home view frames the body it was derived from`,
			d > span * 2 && d < span * 8, { distance: +d.toFixed(3), span: +span.toFixed(3) });
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
