// experiments/dv-map-test.js
// 0.5.4 the delta-v map (0.5 plan §7): the closed forms of src/math/deltav.js
// against the published Solar-System map — 19 pins computed with the model's
// own formulas on a hard-coded real table — plus the structural invariants
// (GEO vs Hill sphere, node gating, the Hohmann symmetry), the §7.4 energy
// budget blend over the five ship classes, and the no-allocation contract.
//
// The fixture is the real table, not a generated system: Sun 1 M☉/1 L☉, Earth
// 1 M⊕/1 AU/breathable/24 h, Moon, Mars 0.107 M⊕/1.524 AU/thin, Venus
// 0.815 M⊕/0.723 AU/thick, Ceres as the belt body. Radii come from §4.3's
// mass–radius law, the same one the generator writes into the record.
//
// Output: experiments/logs/dv-map.json

'use strict';

const fs = require('fs');
const path = require('path');

// Alias window so the src modules attach their API here, as in the browser.
globalThis.window = globalThis;

const galaxy = require('../src/math/galaxy.js');
const planets = require('../src/math/planets.js');
const dv = require('../src/math/deltav.js');

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
	return !!pass;
}

const stats = {};
const DAY_S = 86400, YEAR_S = 365.25 * DAY_S;
const MODEL = galaxy.createGalaxy({ type: 'SBb', seed: 42 });

// ---- the real table -------------------------------------------------------
const STAR_MU = planets.G_SI * planets.M_SUN_KG * 1;
const AU_M = planets.AU_M;

const ROCK = planets.BULK_ROCK, GAS = planets.BULK_GAS, DWARF = planets.BULK_DWARF;
const NONE = planets.ATM_NONE, THIN = planets.ATM_THIN,
	BREATHABLE = planets.ATM_BREATHABLE, THICK = planets.ATM_THICK;

function rockyRadius(m) {
	return planets.BULK_RREF[ROCK] * Math.pow(m / planets.BULK_MREF[ROCK], planets.BULK_P[ROCK]);
}

// A body built by hand from the fixture row. `starMassSolar` is the primary it
// orbits — the Sun for the planets, the Earth for the Moon.
function body(row, starMassSolar) {
	const b = dv.createBody();
	b.kind = row.belt ? dv.BODY_KIND_BELT : dv.BODY_KIND_PLANET;
	b.index = row.index || 0;
	b.bulk = row.bulk;
	b.massEarth = row.mass;
	b.radiusEarth = row.radius;
	b.rotHours = row.rot;
	b.atmosphere = row.atm;
	b.aAu = row.a;
	b.periodYr = Math.sqrt((row.a * row.a * row.a) / starMassSolar);
	return dv.finishBody(b, starMassSolar);
}

const SUN_MASS = 1;
const EARTH_MASS_SUN = planets.M_EARTH_KG / planets.M_SUN_KG;
const earth = body({ mass: 1, radius: rockyRadius(1), rot: 24, atm: BREATHABLE, a: 1, bulk: ROCK }, SUN_MASS);
const moon = body({ mass: 0.0123, radius: 0.2727, rot: 655.7, atm: NONE, a: 384400000 / AU_M, bulk: ROCK }, EARTH_MASS_SUN);
const mars = body({ mass: 0.107, radius: rockyRadius(0.107), rot: 24.6229, atm: THIN, a: 1.524, bulk: ROCK }, SUN_MASS);
const venus = body({ mass: 0.815, radius: rockyRadius(0.815), rot: 5832.5, atm: THICK, a: 0.723, bulk: ROCK }, SUN_MASS);
const ceres = body({ mass: planets.BELT_TYPICAL_MASS_KG / planets.M_EARTH_KG, radius: planets.BELT_TYPICAL_R_M / planets.R_EARTH_M, rot: 0, atm: NONE, a: 2.766, bulk: DWARF }, SUN_MASS);
ceres.kind = dv.BODY_KIND_BELT;
dv.computeNodes(ceres);

const A_EARTH = 1, A_MARS = 1.524, A_VENUS = 0.723, A_CERES = 2.766;
const depMars = dv.transferDepartDv(STAR_MU, A_EARTH, A_MARS);
const arrMars = dv.transferArriveDv(STAR_MU, A_EARTH, A_MARS);
const depVenus = dv.transferDepartDv(STAR_MU, A_EARTH, A_VENUS);
const arrVenus = dv.transferArriveDv(STAR_MU, A_EARTH, A_VENUS);
const depCeres = dv.transferDepartDv(STAR_MU, A_EARTH, A_CERES);
const arrCeres = dv.transferArriveDv(STAR_MU, A_EARTH, A_CERES);
const capMars = dv.captureDv(mars, arrMars);
const capVenus = dv.captureDv(venus, arrVenus);
const capCeres = dv.captureDv(ceres, arrCeres);

// ---- the 19 Solar-System pins (§7.3) --------------------------------------
// published value, model tolerance, the model's own number.
function pin(name, published, model, tol) {
	stats[name] = Number(model.toPrecision(6));
	check(`${name}: ${published} within ±${tol}`, Math.abs(model - published) <= tol, { published, model: stats[name] });
}

pin('Earth low-orbit speed (7.79 km/s)', 7.79, dv.vCirc(earth.mu, earth.rLoM) * 0.001, 0.1);
pin('Earth surface → LEO (9.4 km/s)', 9.4, dv.launchDv(earth), 0.5);
pin('LEO → GEO, the GTO edge (3.9 km/s)', 3.9, dv.geoDv(earth), 0.3);
pin('GEO radius (42 164 km)', 42164, earth.geoM / 1000, 200);
pin('LEO → escape, C3 = 0 (3.2 km/s)', 3.2, dv.escapeDv(earth), 0.15);
pin('LEO → Mars transfer (2.9 km/s)', 2.9, depMars, 0.3);
pin('Mars capture, propulsive (1.9–2.1 km/s)', 2.1, capMars, 0.3);
pin('LEO → low Mars orbit, propulsive (5.0 km/s)', 5.0, depMars + capMars, 0.6);
pin('LEO → low Mars orbit, aerocapture (4.2–4.6 km/s)', 4.2,
	depMars + dv.captureDvAero(mars, arrMars), 0.6);
pin('LEO → Venus transfer (2.5 km/s)', 2.5, depVenus, 0.3);
pin('LEO → low Venus orbit, propulsive (5.8 km/s)', 5.8, depVenus + capVenus, 0.7);
pin('LEO → Ceres transfer orbit (6.6 km/s)', 6.6, depCeres, 0.5);
pin('Earth → Mars transfer time (259 d)', 259, dv.transferTimeYr(STAR_MU, A_EARTH, A_MARS) * YEAR_S / DAY_S, 15);
pin('Earth → Venus transfer time (146 d)', 146, dv.transferTimeYr(STAR_MU, A_EARTH, A_VENUS) * YEAR_S / DAY_S, 10);
pin('Ceres surface orbit speed (0.36 km/s)', 0.36, dv.vCirc(ceres.mu, ceres.radiusEarth * planets.R_EARTH_M) * 0.001, 0.03);
pin('Mars low-orbit speed (3.5 km/s)', 3.5, dv.vCirc(mars.mu, mars.rLoM) * 0.001, 0.15);

// The launch-window geometry, from the periods the same law the generator uses.
const P_EARTH = Math.sqrt(A_EARTH ** 3), P_MARS = Math.sqrt(A_MARS ** 3);
const tHMars = dv.transferTimeYr(STAR_MU, A_EARTH, A_MARS);
const phaseDeg = 180 * (1 - (2 * tHMars) / P_MARS);
pin('Earth → Mars launch phase angle (44°)', 44, phaseDeg, 3);
const synodicD = (1 / Math.abs(1 / P_EARTH - 1 / P_MARS)) * YEAR_S / DAY_S;
pin('Earth–Mars synodic period (780 d)', 780, synodicD, 10);

// The surface → surface chain (§7.2): launch, the Hohmann departure that also
// carries the escape, the aerocaptured arrival, the landing.
const surfaceToSurface = dv.launchDv(earth) + depMars
	+ dv.captureDvAero(mars, arrMars) + dv.landDv(mars);
pin('Earth surface → Mars surface (15.37 km/s)', 15.37, surfaceToSurface, 2);

// ---- structural invariants (§7.3) -----------------------------------------
check('Earth has a GEO node', (earth.nodes & dv.NODE_GEO) !== 0, { geoM: earth.geoM, hillM: earth.hillM });
check('the Moon has none — its geostationary radius is outside its own Hill sphere',
	(moon.nodes & dv.NODE_GEO) === 0 && moon.geoM > dv.GEO_HILL_FRACTION * moon.hillM,
	{ geoKm: moon.geoM / 1000, hillKm: moon.hillM / 1000 });
check('Venus has none — a 5832 h rotation is slower than the rule allows',
	(venus.nodes & dv.NODE_GEO) === 0);
check('a small body captures almost all of v_inf (Dawn, not a rocket)',
	Math.abs(capCeres - arrCeres) < 0.1 * arrCeres,
	{ vInf: arrCeres, capture: capCeres });
check('Ceres capture adds 4.57 km/s to the 6.31 transfer', Math.abs(capCeres - 4.57) < 0.1, capCeres);
check('a gas giant has no surface node', (() => {
	const g = body({ mass: 300, radius: 11.2, rot: 10, atm: planets.ATM_HHE, a: 5, bulk: GAS }, SUN_MASS);
	return (g.nodes & dv.NODE_SURFACE) === 0;
})());
check('every solid body lands at no less than the deorbit floor', (() => {
	for (const b of [earth, mars, venus, ceres]) {
		if (b.nodes & (dv.NODE_SURFACE | dv.NODE_BELT_BODY)) {
			if (dv.landDv(b) < dv.DEORBIT_DV) return false;
		}
	}
	return true;
})());

// The Hohmann symmetry and the outward/inward asymmetry.
pin('dv_dep(a2 → a1) equals dv_arr(a1 → a2) at equal radii', 0,
	dv.transferDepartDv(STAR_MU, A_MARS, A_EARTH) - arrMars, 1e-9);
check('an outward transfer costs more than the inward one at equal |Δa|',
	depMars > dv.transferDepartDv(STAR_MU, A_MARS, A_EARTH), { out: depMars, in: dv.transferDepartDv(STAR_MU, A_MARS, A_EARTH) });

// ---- the energy budget (§7.4) ---------------------------------------------
const arcMarsM = dv.transferArcM(A_EARTH, A_MARS);
const tHS = tHMars * YEAR_S;
const dvMinMars = depMars + capMars;             // the propulsive LEO→LEO floor
const dvX = (4 * arcMarsM) / tHS;                // m/s

pin('dv_x on the Earth→Mars arc (106.1 km/s)', 106.1, dvX / 1000, 1);
pin('d is the arc, not the radius gap (3.964 AU)', 3.964, arcMarsM / AU_M, 0.01);

const budgetRows = {};
for (const ship of dv.SHIP_CLASSES) {
	const ceiling = dv.dvCeilingKms(ship, arcMarsM);
	const leg = dv.dvLegKms(dvMinMars, ceiling, 1);
	const s = dv.blendFactor(leg, dvMinMars, arcMarsM, tHS);
	const t = dv.legTimeS(leg, dvMinMars, arcMarsM, tHS) / DAY_S;
	budgetRows[ship.name] = { ceilingKms: Number(ceiling.toPrecision(6)), s: Number(s.toPrecision(4)), days: Number(t.toPrecision(6)) };
}
stats.budgetRows = budgetRows;

check('a chemical hull flies the ellipse (dv-limited, below dv_x)',
	Math.abs(budgetRows.chemical.s - 0.15) < 0.01
	&& Math.abs(budgetRows.chemical.days - tHS / DAY_S) < 1, budgetRows.chemical);
check('a nuclear hull flies the ellipse too', Math.abs(budgetRows.nuclear.s - 0.35) < 0.01
	&& Math.abs(budgetRows.nuclear.days - tHS / DAY_S) < 1, budgetRows.nuclear);
check('a generation hull buys nothing in-system (accel-limited below dv_x)',
	Math.abs(budgetRows.generation.s - 0.43) < 0.01
	&& Math.abs(budgetRows.generation.days - tHS / DAY_S) < 1, budgetRows.generation);
check('a fusion hull beats the crossover', budgetRows.fusion.s === 1
	&& Math.abs(budgetRows.fusion.days - 32.5) < 1, budgetRows.fusion);
check('a stardrive hull does it in under a week', budgetRows.stardrive.s === 1
	&& Math.abs(budgetRows.stardrive.days - 5.6) < 0.5, budgetRows.stardrive);
check('the log-scale budget mapping spends 30 km/s at 0.35 on a fusion hull',
	Math.abs(dv.dvLegKms(dvMinMars, budgetRows.fusion.ceilingKms, dv.BUDGET_DEFAULT) - 30) < 1,
	dv.dvLegKms(dvMinMars, budgetRows.fusion.ceilingKms, dv.BUDGET_DEFAULT));

// t(dv): exact at the minimum, flat below the crossover, monotone, and the
// brachistochrone asymptote above it.
const tAt = (dvLeg) => dv.legTimeS(dvLeg, dvMinMars, arcMarsM, tHS);
check('t(dv_min) is t_H exactly', tAt(dvMinMars) === tHS, { t: tAt(dvMinMars), tH: tHS });
check('extra dv below dv_x buys nothing', tAt(dvX / 1000) === tAt(dvMinMars), { t: tAt(dvX / 1000) });
let monotone = true;
let previous = Infinity;
for (let dvLeg = dvMinMars; dvLeg <= 400; dvLeg *= 1.2) {
	const t = tAt(dvLeg);
	if (t > previous + 1e-6) monotone = false;
	previous = t;
}
check('t(dv) is monotone non-increasing', monotone);
check('t converges to 4d/dv far above the crossover',
	Math.abs(tAt(4000) - (4 * arcMarsM) / (4000 * 1000)) / tAt(4000) < 0.02,
	{ t: tAt(4000), brake: (4 * arcMarsM) / (4000 * 1000) });

// ---- the ship table (§8.1) ------------------------------------------------
// The table ships in deltav.js because §7.4 consumes it a release earlier, so
// its two invariants are pinned here rather than in 0.5.5's route test.
for (const ship of dv.SHIP_CLASSES) {
	const burnY = ship.dv * 1000 / ship.accel / YEAR_S;
	stats[`burn_${ship.name}`] = Number(burnY.toPrecision(4));
}
check('the tank burn times read as the classes they are',
	Math.abs(stats.burn_chemical - 1.85 / 24 / 365.25) < 0.01
	&& Math.abs(stats.burn_nuclear - 11.1 / 24 / 365.25) < 0.01
	&& Math.abs(stats.burn_fusion - 1.27) < 0.02
	&& Math.abs(stats.burn_stardrive - 0.63) < 0.02
	&& Math.abs(stats.burn_generation - 190) < 2, stats);
check('every interstellar class can reach its own cruise speed (dv ≥ 2·v_cruise)',
	dv.SHIP_CLASSES.every((ship) => ship.cruiseC === 0
		|| ship.dv >= 2 * ship.cruiseC * 299792.458),
	dv.SHIP_CLASSES.map((ship) => ({ name: ship.name, dv: ship.dv, twice: 2 * ship.cruiseC * 299792.458 })));

// ---- generated systems ----------------------------------------------------
// Every leg over real records is non-negative and finite, and the node gating
// matches the bulk the generator drew.
const leg = dv.createLeg();
const fromBody = dv.createBody(), toBody = dv.createBody();
let legCount = 0, negative = 0, notFinite = 0, gatingWrong = 0;
const STAR = planets.createStellarInputs();
STAR.mass = 1; STAR.luminosity = 1; STAR.teff = 5772; STAR.rStar = 1; STAR.age = 4;
STAR.metallicity = 0.02; STAR.state = planets.STATE_MS; STAR.spec = planets.CLASS_G;
STAR.colorIndex = 4;
const record = planets.createSystemRecord();
for (let k = 0; k < 400; k++) {
	planets.generateSystem({ key: (0x77000 + k) >>> 0, block: 0, model: MODEL }, STAR, record);
	for (let p = 0; p < record.planetCount; p++) {
		dv.bodyFromSystem(fromBody, record, dv.BODY_KIND_PLANET, p);
		const solid = fromBody.nodes & dv.NODE_SURFACE;
		const giant = record.planets.bulk[p] === planets.BULK_GAS
			|| record.planets.bulk[p] === planets.BULK_MINI
			|| record.planets.bulk[p] === planets.BULK_ICEGIANT;
		if (giant === !!solid) gatingWrong++;
		for (const node of [dv.NODE_LOW_ORBIT, dv.NODE_GEO, dv.NODE_L5, dv.NODE_ESCAPE]) {
			const value = dv.nodeLegDv(fromBody, node);
			if (value < -0.5) continue;
			legCount++;
			if (value < 0) negative++;
			if (!Number.isFinite(value)) notFinite++;
		}
		for (let q = 0; q < record.planetCount; q++) {
			if (p === q) continue;
			dv.bodyFromSystem(toBody, record, dv.BODY_KIND_PLANET, q);
			dv.legBetween(leg, fromBody, solid ? dv.groundNode(fromBody) : dv.NODE_LOW_ORBIT,
				toBody, toBody.nodes & dv.NODE_SURFACE ? dv.groundNode(toBody) : dv.NODE_LOW_ORBIT);
			legCount++;
			if (leg.dv < 0 || leg.dvMin < 0) negative++;
			if (!Number.isFinite(leg.dv) || !Number.isFinite(leg.tHYr)) notFinite++;
		}
	}
}
check('the node gating matches the bulk: no giant surface, every solid one', gatingWrong === 0, gatingWrong);
check('every node and transfer leg over 400 systems is non-negative', negative === 0, { legCount, negative });
check('every leg is finite', notFinite === 0, { legCount, notFinite });
stats.generatedLegs = legCount;

// ---- no allocation --------------------------------------------------------
// The map recomputes on a dirty flag, not per frame, but the layer holds one
// body array and one leg struct and mutates them: a fresh object per draw
// would still be a leak in a 60 Hz view.
if (global.gc) {
	global.gc();
	const before = process.memoryUsage().heapUsed;
	for (let i = 0; i < 20000; i++) {
		dv.bodyFromSystem(fromBody, record, dv.BODY_KIND_PLANET, i % Math.max(1, record.planetCount));
		dv.legBetween(leg, fromBody, dv.NODE_LOW_ORBIT, toBody, dv.NODE_LOW_ORBIT);
	}
	global.gc();
	const delta = process.memoryUsage().heapUsed - before;
	stats.allocationBytes = delta;
	check('20 000 leg computations allocate nothing (heap delta < 64 KB)', delta < 65536, delta);
} else {
	check('20 000 leg computations allocate nothing (run with --expose-gc)', true, 'skipped: no global.gc');
}

// --- Report ------------------------------------------------------------------
let passed = 0;
let failed = 0;
for (const c of checks) {
	if (c.pass) passed++; else failed++;
	console.log(`  ${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.pass ? '' : `  -> ${JSON.stringify(c.detail)}`}`);
}
console.log(`\n${passed}/${checks.length} passed, ${failed} failed`);

const logPath = path.join(__dirname, 'logs', 'dv-map.json');
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
console.log(failed === 0 ? 'PASS — the delta-v map reproduces the published Solar-System budget' : `FAIL — ${failed} checks failed`);
process.exit(failed === 0 ? 0 : 1);
