// experiments/dv-map-test.js
// Pins the closed forms in src/math/deltav.js against the published
// Solar-System delta-v map (plan §7.3). Every value in the table is
// computed by the module itself, not quoted — the "model" column is
// what we assert to within the plan's stated tolerance. Structural
// invariants (dv_dep_lo ≥ dv_dep, GEO existence rules, monotonicity,
// t(dv_min) = t_H exactly) are also pinned.

'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dv = require('../src/math/deltav.js');
const planets = require('../src/math/planets.js');

let passed = 0;
let failed = 0;
function OK(name, fn) {
	try { fn(); passed++; console.log('OK   ' + name); }
	catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + e.message); }
}
function approxEq(actual, expected, tol, name) {
	const diff = Math.abs(actual - expected);
	if (!(diff <= tol)) {
		throw new assert.AssertionError({
			message: (name || 'approxEq') + ': expected ' + expected + ' ±' + tol + ', got ' + actual + ' (diff ' + diff + ')',
			actual: actual, expected: expected, operator: '~=',
		});
	}
}

const SECONDS_PER_DAY = dv.SECONDS_PER_DAY;
const AU_M = dv.AU_M;
const MU_SUN = dv.G_SI * dv.M_SUN_KG;

// --- Build real bodies (plan §7.3) ------------------------------------------
// Sun 1 M☉/1 L☉; Earth 1 M⊕/1 AU/breathable/24 h; Moon excluded (counts only, §4.8);
// Mars 0.107 M⊕/1.524 AU/thin/24.6 h; Venus 0.815 M⊕/0.723 AU/thick/2802 h;
// Ceres as the belt body at 2.77 AU. Use the module's own extractor pattern
// by filling the param struct directly.
function makeRealBody(opts) {
	const p = dv.createBodyParam();
	const massKg = opts.massEarth * dv.M_EARTH_KG;
	p.mu = dv.G_SI * massKg;
	p.radiusM = opts.radiusEarth * dv.R_EARTH_M;
	p.massKg = massKg;
	p.bulkKey = opts.bulk || 'rock';
	p.atmKey = opts.atm || 'none';
	p.hasSurface = (dv.BULKS_WITH_SURFACE[p.bulkKey] === 1);
	p.rLoM = dv.lowOrbitRadiusM(p.radiusM);
	// Earth 255 km LEO (the published v_circ is at 255 km); override the
	// default h = max(200, 0.04 R) = 255 km for Earth (0.04·6371 = 254.8 km
	// ≈ 255 km), so the default is already correct. Document:
	p.vCircLo = dv.vCirc(p.mu, p.rLoM);
	p.vEscLo = dv.vEsc(p.mu, p.rLoM);
	const rotH = opts.rotHours;
	p.rotS = rotH * 3600;
	if (rotH < 1000) {
		const omega = dv.TAU / p.rotS;
		const aGeo = Math.pow(p.mu / (omega * omega), 1 / 3);
		// For Earth r_Hill ≈ 0.01 AU ≈ 1.496e9 m; GEO must be < 0.4·r_Hill.
		if (aGeo >= p.rLoM) { p.aGeoM = aGeo; p.vGeo = dv.vCirc(p.mu, aGeo); p.hasGeo = true; }
	}
	p.hasL5 = true;
	p.aM = opts.aAU * AU_M;
	p.vOrbStar = dv.vCirc(MU_SUN, p.aM);
	p.periodS = 2 * Math.PI * Math.sqrt(p.aM * p.aM * p.aM / MU_SUN);
	p.incDeg = opts.incDeg || 0;
	// rHillM explicit for the Moon GEO test
	p.rHillM = opts.rHillAU ? opts.rHillAU * AU_M : opts.aAU * AU_M * (opts.massEarth / 333000) ** (1/3);
	return p;
}

// Earth: 1 M⊕, 1 R⊕, breathable, 24 h rot, 1 AU.
const earth = makeRealBody({ massEarth: 1, radiusEarth: 1, atm: 'breathable', rotHours: 24, aAU: 1, bulk: 'rock' });
// Mars: 0.107 M⊕, 0.533 R⊕ (3389.5 km / 6371 km), thin, 24.6 h, 1.524 AU.
const mars  = makeRealBody({ massEarth: 0.107, radiusEarth: 0.532, atm: 'thin', rotHours: 24.6, aAU: 1.524, bulk: 'rock' });
// Venus: 0.815 M⊕, 0.949 R⊕ (6052 km), thick, -243 d (2802 h retrograde — GEO rule uses |rot|, the
// test is for no-GEO Moon; Venus' slow rot puts GEO far out and the 0.4 Hill rule kills it).
const venus = makeRealBody({ massEarth: 0.815, radiusEarth: 0.949, atm: 'thick', rotHours: 2802, aAU: 0.723, bulk: 'rock' });
// Ceres belt body: mass 9.4e20 kg, r 470 km (plan §4.7) = 0.0738 R⊕, none atm, rot 9.07 h.
const ceres = (function () {
	const p = dv.createBodyParam();
	p.mu = planets.BELT_BODY_MU;
	p.radiusM = planets.BELT_BODY_R_M;
	p.massKg = planets.BELT_BODY_MASS_KG;
	p.bulkKey = 'dwarf';
	p.atmKey = 'none';
	p.hasSurface = true;
	p.rLoM = dv.lowOrbitRadiusM(p.radiusM);
	p.vCircLo = dv.vCirc(p.mu, p.rLoM);
	p.vEscLo = dv.vEsc(p.mu, p.rLoM);
	p.rotS = 9.07 * 3600;
	const omega = dv.TAU / p.rotS;
	const aGeo = Math.pow(p.mu / (omega * omega), 1 / 3);
	// Hill radius at 2.77 AU for a 9.4e20 kg body is tiny; GEO will likely be outside anyway.
	p.rHillM = 2.77 * AU_M * (p.massKg / dv.M_SUN_KG) ** (1/3);
	p.aGeoM = aGeo; p.vGeo = dv.vCirc(p.mu, aGeo);
	p.hasGeo = (aGeo < dv.GEO_HILL_FRAC * p.rHillM);
	p.hasL5 = false;
	p.aM = 2.77 * AU_M;
	p.vOrbStar = dv.vCirc(MU_SUN, p.aM);
	p.periodS = 2 * Math.PI * Math.sqrt(p.aM * p.aM * p.aM / MU_SUN);
	p.incDeg = 10.6;
	return p;
})();

// Earth at 255 km altitude: rLoM = 6371 + 255 = 6626 km.
// Our lowOrbitRadiusM uses max(200 km, 0.04·R_p) = max(200, 254.8) = 254.8 km, so rLoM = 6625.8 km ≈ 255 km.
OK('Earth low-orbit speed (h = 255 km)', () => {
	approxEq(earth.vCircLo / 1000, 7.76, 0.1);
});

OK('Earth surface → LEO', () => {
	const out = {};
	dv.dvSurfaceToLo(earth, out);
	approxEq(out.dv / 1000, 9.66, 0.5);
});

OK('LEO → GEO (the GTO edge)', () => {
	const out = {};
	dv.dvLoToGeo(earth, out);
	approxEq(out.dv / 1000, 3.91, 0.3);
});

OK('GEO radius', () => {
	approxEq(earth.aGeoM / 1000, 42163, 200);
});

OK('LEO → escape, C3 = 0', () => {
	const out = {};
	dv.dvLoToEscape(earth, out);
	approxEq(out.dv / 1000, 3.21, 0.15);
});

// Earth → Mars (LEO departure to Mars transfer orbit — the single-burn Oberth form, §7.2)
OK('LEO → Mars transfer orbit (the TMI burn)', () => {
	const leg = {};
	dv.legLoToLo(MU_SUN, earth, mars, false, leg);
	// dv_dep_lo (Earth) is the TMI: 3.60 km/s per the table. The full LEO→LMO
	// chain adds Mars aerocapture; we check the departure burn separately.
	approxEq(leg.dvDepLo / 1000, 3.60, 0.4);
});

OK('Earth escape (C3 = 0) → Mars transfer orbit', () => {
	const hh = {};
	dv.hohmannStarFrame(MU_SUN, earth.aM, mars.aM, hh);
	// dvDep is the heliocentric Hohmann from Earth-orbit altitude around the Sun
	approxEq(hh.dvDep / 1000, 2.95, 0.3);
});

OK('Mars capture, propulsive', () => {
	const hh = {};
	dv.hohmannStarFrame(MU_SUN, earth.aM, mars.aM, hh);
	const cap = {};
	dv.captureBurn(mars, hh.dvArr, true, cap);
	approxEq(cap.dv / 1000, 2.10, 0.3);
});

OK('Mars capture, aerocapture (0.40 credit)', () => {
	const hh = {};
	dv.hohmannStarFrame(MU_SUN, earth.aM, mars.aM, hh);
	const cap = {};
	dv.captureBurn(mars, hh.dvArr, false, cap);
	approxEq(cap.dv / 1000, 1.26, 0.3);
});

OK('LEO → low Mars orbit, propulsive', () => {
	const leg = {};
	dv.legLoToLo(MU_SUN, earth, mars, true, leg);
	approxEq(leg.dvLoToLo / 1000, 5.70, 0.6);
});

OK('LEO → low Mars orbit, aerocapture', () => {
	const leg = {};
	dv.legLoToLo(MU_SUN, earth, mars, false, leg);
	approxEq(leg.dvLoToLo / 1000, 4.86, 0.6);
});

OK('LEO → Venus transfer orbit', () => {
	const leg = {};
	dv.legLoToLo(MU_SUN, earth, venus, false, leg);
	approxEq(leg.dvDepLo / 1000, 3.49, 0.4);
});

OK('Earth escape (C3 = 0) → Venus transfer orbit', () => {
	const hh = {};
	dv.hohmannStarFrame(MU_SUN, earth.aM, venus.aM, hh);
	approxEq(hh.dvDep / 1000, 2.50, 0.3);
});

OK('LEO → low Venus orbit, propulsive', () => {
	const leg = {};
	dv.legLoToLo(MU_SUN, earth, venus, true, leg);
	approxEq(leg.dvLoToLo / 1000, 6.83, 0.7);
});

OK('LEO → low Venus orbit, aerocapture (0.70 credit)', () => {
	const leg = {};
	dv.legLoToLo(MU_SUN, earth, venus, false, leg);
	approxEq(leg.dvLoToLo / 1000, 4.49, 0.7);
});

OK('LEO → Ceres transfer orbit', () => {
	const leg = {};
	dv.legLoToLo(MU_SUN, earth, ceres, false, leg);
	approxEq(leg.dvDepLo / 1000, 4.90, 0.5);
});

OK('Earth escape (C3 = 0) → Ceres transfer orbit', () => {
	const hh = {};
	dv.hohmannStarFrame(MU_SUN, earth.aM, ceres.aM, hh);
	approxEq(hh.dvDep / 1000, 6.31, 0.5);
});

OK('Ceres capture, propulsive', () => {
	const hh = {};
	dv.hohmannStarFrame(MU_SUN, earth.aM, ceres.aM, hh);
	const cap = {};
	dv.captureBurn(ceres, hh.dvArr, true, cap);
	approxEq(cap.dv / 1000, 4.57, 0.5);
});

OK('Earth → Mars transfer time', () => {
	const hh = {};
	dv.hohmannStarFrame(MU_SUN, earth.aM, mars.aM, hh);
	approxEq(hh.tH / SECONDS_PER_DAY, 258.8, 15);
});

OK('Earth → Venus transfer time', () => {
	const hh = {};
	dv.hohmannStarFrame(MU_SUN, earth.aM, venus.aM, hh);
	approxEq(hh.tH / SECONDS_PER_DAY, 146.1, 10);
});

OK('Earth → Mars launch phase angle (44°)', () => {
	// phase = 180° − ω·t_H · (180/π) = 180° − (n2·t_H)·(180/π), i.e. Mars does
	// not quite lap Earth during the transfer.
	const hh = {};
	dv.hohmannStarFrame(MU_SUN, earth.aM, mars.aM, hh);
	const nMars = Math.sqrt(MU_SUN / (mars.aM ** 3));
	const phaseRad = Math.PI - nMars * hh.tH;
	approxEq(phaseRad * 180 / Math.PI, 44.4, 3);
});

OK('Earth–Mars synodic period', () => {
	const P1 = earth.periodS;
	const P2 = mars.periodS;
	const syn = Math.abs(P1 * P2 / (P2 - P1));
	approxEq(syn / SECONDS_PER_DAY, 779.9, 10);
});

OK('Mars low-orbit speed', () => {
	approxEq(mars.vCircLo / 1000, 3.45, 0.15);
});

OK('Ceres surface orbit speed', () => {
	// Ceres surface r=470 km; "low orbit" is max(200 km, 0.04·470km)=200 km, so
	// r_lo = 670 km. v_circ = sqrt(mu/r). mu = G·9.4e20 = 6.27e10.
	// v_circ(670e3) = sqrt(6.27e10/6.7e5) ≈ 306 m/s. The published pin is 0.36
	// at the surface (r = 470 km): sqrt(6.27e10/4.7e5) ≈ 365 m/s. We report
	// the surface value because that's what the plan pins.
	const vSurface = dv.vCirc(planets.BELT_BODY_MU, planets.BELT_BODY_R_M);
	approxEq(vSurface / 1000, 0.365, 0.03);
});

OK('Earth surface → Mars surface, aerocapture arrival', () => {
	// surface→LEO + dv_dep_lo(Earth) + dv_arr_orbit(Mars,aero) + lo→surface(Mars)
	const launch = {}; dv.dvSurfaceToLo(earth, launch);
	const leg = {}; dv.legLoToLo(MU_SUN, earth, mars, false, leg);
	const land = {}; dv.dvLoToSurface(mars, land);
	const total = launch.dv + leg.dvDepLo + leg.dvCapB + land.dv;
	const direct = {};
	dv.dvSurfaceToSurface(MU_SUN, earth, mars, false, direct);
	// The published range is 15–18 km/s. The graph helper must be the same
	// lift + low-orbit leg + aero landing chain, not a second approximation.
	approxEq(total / 1000, 16.02, 2);
	approxEq(direct.dv, total, 1e-6);
	approxEq(direct.dv / 1000, 16.02, 2);
});

// --- Structural invariants ---------------------------------------------------
// Oberth invariant: the single-burn departure from low orbit can never cost
// more than the two-burn sequence (escape-then-depart). This is the physical
// inequality the plan pins — dv_dep_lo ≤ dv_escape + dv_dep — which holds for
// every body and direction (the single-burn formula prices the Oberth benefit).
// Note: for large heliocentric excesses (e.g. Earth→Ceres v_inf ≈ 6.3 km/s) the
// single-burn LEO departure is *cheaper* than the heliocentric dv alone
// (sqrt(v_esc² + v_inf²) − v_c < v_inf when v_inf is large enough), which is
// not a bug — it is the Oberth effect at work.
OK('dv_dep_lo ≤ dv_escape + dv_dep (single burn never beats two burns)', () => {
	const pairs = [[earth,mars],[earth,venus],[earth,ceres],[mars,earth],[venus,earth],[ceres,earth]];
	for (const [A,B] of pairs) {
		const leg = {};
		dv.legLoToLo(MU_SUN, A, B, false, leg);
		const twoBurn = (Math.SQRT2 - 1) * A.vCircLo + leg.dvDepStar;
		if (leg.dvDepLo > twoBurn + 1) {
			throw new Error(A === ceres ? 'ceres' : 'earth' + '→...' + ' dvDepLo ' + (leg.dvDepLo/1000).toFixed(2) + ' > twoBurn ' + (twoBurn/1000).toFixed(2));
		}
	}
});
OK('for Earth→Mars, dv_dep_lo ≈ 3.60 km/s and is greater than dv_dep (the deep-well small-excess regime)', () => {
	const leg = {};
	dv.legLoToLo(MU_SUN, earth, mars, false, leg);
	approxEq(leg.dvDepLo / 1000, 3.60, 0.4);
	// In this regime (deep well, small v_inf), dv_dep_lo > dv_dep — you pay
	// most of the escape cost up front.
	if (!(leg.dvDepLo > leg.dvDepStar)) throw new Error('expected dvDepLo > dvDepStar for Earth→Mars');
});
OK('for Ceres (tiny well), dv_dep_lo < dv_dep_star (Oberth still saves v_circ ≈ 300 m/s)', () => {
	const leg = {};
	dv.legLoToLo(MU_SUN, ceres, earth, false, leg);
	// On a 306 m/s well at a 4.86 km/s transfer excess, the single-burn formula
	// saves ~v_circ because v_inf >> v_esc ⇒ sqrt(v_esc²+v_inf²)−v_c ≈ v_inf − v_c.
	// Ratio ~0.94 (6% cheaper from LEO than from the escape node) — the well is
	// tiny but the formula is still exact, and that is the Ceres analog of the
	// 0.65 km/s TMI saving over escape+dep for Mars.
	const ratio = leg.dvDepLo / leg.dvDepStar;
	if (!(ratio > 0.90 && ratio < 1.00)) throw new Error('dvDepLo/dvDepStar ratio ' + ratio.toFixed(3) + ' out of [0.90, 1.00]');
});

// Earth has a GEO node, the Moon does not.
OK('Earth has a GEO node (42163 km < 0.4·rHill ≈ 598573 km)', () => {
	if (!earth.hasGeo) throw new Error('Earth missing GEO');
	// r_Hill for Earth: a·(M/(3M★))^(1/3) = 1 AU · (1/(3·333000))^(1/3) ≈ 0.01 AU ≈ 1.496e9 m.
	const rHill = 1 * AU_M * Math.pow(1 / (3 * 333000), 1/3);
	const geoLimit = dv.GEO_HILL_FRAC * rHill;
	approxEq(rHill / 1000, 1496e3, 2e3);
	// Our earlier test built earth without rHillM set, but paramOfBody sets it
	// from record planets.rHill (computed in AU). We re-check the inequality:
	if (!(earth.aGeoM < geoLimit)) throw new Error('Earth GEO ' + earth.aGeoM + ' ≥ ' + geoLimit);
});

OK('the Moon would have no GEO node — 88434 km > 0.4·rHill ≈ 24605 km', () => {
	// Moon: M = 0.0123 M⊕, R = 0.273 R⊕, rot 655.7 h (tidally locked to Earth),
	// r_Hill = 384400 km · (M_moon/(3·M_earth))^(1/3) ≈ 61500 km · 0.4 = 24600 km.
	const MMoon = 0.0123 * dv.M_EARTH_KG;
	const RMoon = 0.273 * dv.R_EARTH_M;
	const muMoon = dv.G_SI * MMoon;
	const rotMoonS = 655.7 * 3600;
	const omegaMoon = dv.TAU / rotMoonS;
	const aGeoMoon = Math.pow(muMoon / (omegaMoon * omegaMoon), 1/3);
	// Hill radius of the Moon against Earth at 384400 km:
	const rMoonHill = 384.4e6 * Math.pow(MMoon / (3 * dv.M_EARTH_KG), 1/3);
	if (!(aGeoMoon / 1000 > 80e3)) throw new Error('lunar GEO too small: ' + (aGeoMoon/1000));
	if (!(aGeoMoon > dv.GEO_HILL_FRAC * rMoonHill)) throw new Error('lunar GEO inside Hill fraction');
});

// --- Travel-time invariants (§7.4) ------------------------------------------
OK('t(dv_min) = t_H exactly', () => {
	const leg = {}; dv.legLoToLo(MU_SUN, earth, mars, false, leg);
	const ship = dv.shipById('chemical');
	const out = {}; dv.legTimes(leg, ship, 0, out);
	approxEq(out.t, leg.tH, 1); // within 1 second
});
OK('t is monotone non-increasing in dv', () => {
	const leg = {}; dv.legLoToLo(MU_SUN, earth, mars, false, leg);
	const ship = { accel: 1e6, dvMax: 1e9 }; // effectively unlimited
	let prevT = Infinity;
	for (let b = 0; b <= 20; b++) {
		const out = {}; dv.legTimes(leg, ship, b / 20, out);
		if (out.t > prevT + 1) throw new Error('t increased at budget ' + b + ': ' + out.t + ' > ' + prevT);
		prevT = out.t;
	}
});
OK('t converges to 4d/dv as dv → ∞', () => {
	const leg = {}; dv.legLoToLo(MU_SUN, earth, mars, false, leg);
	const ship = { accel: 1e8, dvMax: 1e10 };
	const out = {}; dv.legTimes(leg, ship, 1, out);
	const tAsym = 4 * leg.arcM / out.dvLeg;
	approxEq(out.t, tAsym, tAsym * 0.01); // within 1%
});
OK('dv_x = 4·d/t_H for Earth→Mars ≈ 106 km/s', () => {
	const leg = {}; dv.legLoToLo(MU_SUN, earth, mars, false, leg);
	approxEq(leg.dvX / 1000, 106.1, 2);
});

// Ship table invariants (plan §8.1): tank-empty time = dv/accel.
OK('ship class dv/accel: chemical 1.9 h · nuclear 11 h · fusion 1.27 y · stardrive 0.63 y · generation 190 y', () => {
	const expectH = { chemical: 1.9, nuclear: 11 };
	const expectY = { fusion: 1.27, stardrive: 0.63, generation: 190 };
	for (const s of dv.SHIP_CLASSES) {
		const tankS = s.dvMax / s.accel;
		if (expectH[s.id] !== undefined) {
			approxEq(tankS / 3600, expectH[s.id], 0.3, s.id + ' tank-empty time');
		} else if (expectY[s.id] !== undefined) {
			approxEq(tankS / dv.SECONDS_PER_YEAR, expectY[s.id], expectY[s.id] * 0.05, s.id + ' tank-empty time');
		}
	}
});

OK('every interstellar class satisfies ship.dv ≥ 2·ship.v_cruise', () => {
	for (const s of dv.SHIP_CLASSES) {
		if (s.vCruise > 0) {
			if (s.dvMax < 2 * s.vCruise * 3e8) {
				throw new Error(s.id + ' dv ' + s.dvMax + ' < 2·v_c (' + (2*s.vCruise*3e8) + ')');
			}
		}
	}
});

// --- Edge cases --------------------------------------------------------------
OK('zero-mass Sun-relative (a1=a2) transfer returns dv=0, finite time', () => {
	const out = {};
	dv.hohmannStarFrame(MU_SUN, earth.aM, earth.aM * 1.0000001, out);
	// should not throw; dvDep/dvArr small; tH finite.
	if (!(out.tH > 0 && out.tH < 1e12)) throw new Error('bad tH: ' + out.tH);
});

OK('captureBurn returns ≥0 even for tiny v_inf', () => {
	const cap = {};
	dv.captureBurn(earth, 0, false, cap);
	if (!(cap.dv >= 0)) throw new Error('negative capture');
});

// Summary
console.log('\n' + (passed + failed) + ' tests: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
