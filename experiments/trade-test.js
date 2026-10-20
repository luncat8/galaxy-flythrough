// experiments/trade-test.js
// Validates the commissioned trade routes (colony-economy-plan.md §6, ui.17):
// the units and the two transit laws (fast scheduled freight, generation
// ships homing on a moving target), the departure cargo guard (§6's cap and
// the two-year need floor), the ETA fixed point, and the convoy homing
// arrival/removal law.
//
// Output: experiments/logs/trade.json

'use strict';

const logFile = require('./log-file.js');
const path = require('path');
const trade = require('../src/core/trade.js');
const colony = require('../src/core/colony.js');

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
	return !!pass;
}

// --- synthetic colonies ----------------------------------------------------
// departureCargo reads bestExport (the market's cheapest) plus pop/stock.
// A flat high ease makes food (base 3 cr/t) the best export and puts the
// guard math on NEED[3] = 20 t per 1k persons per y.
function flatColony(pop, stockFood) {
	const map = colony.createResourceMap();
	map.score = 0.5;
	for (let i = 0; i < 6; i++) map.ease[i] = 0.8;
	const c = colony.createColony(1, 'Flat', 0, map, 0, 0, 0);
	c.pop = pop;
	c.stock[3] = stockFood;
	return c;
}

// --- 1. units ---------------------------------------------------------------
{
	check('KPC_LY is 3261.56 ly to a hundredth',
		Math.abs(trade.KPC_LY - 3261.56) < 0.01, { kpcLy: trade.KPC_LY });
	check('the generation ship is 1 ly per 10 ky, 3.066e-8 kpc/y',
		trade.GENERATION_LY_Y === 1e-4
			&& Math.abs(trade.GENERATION_LY_Y / trade.KPC_LY - 3.066e-8) < 1e-11,
		{ kpcPerY: trade.GENERATION_LY_Y / trade.KPC_LY });
	check('distLy reads kpc separation in ly',
		Math.abs(trade.distLy(0, 0, 0, 1, 0, 0) - 3261.5638) < 0.01
			&& Math.abs(trade.distLy(0, 0, 0, 0, 0, 0) - 0) < 1e-12,
		{ oneKpc: trade.distLy(0, 0, 0, 1, 0, 0) });
}

// --- 2. the fast transit ----------------------------------------------------
{
	check('fast freight crosses 10 ly in 50 y, 100 ly in 500 y',
		trade.fastTransitY(10) === 50 && trade.fastTransitY(100) === 500,
		{ ten: trade.fastTransitY(10) });
}

// --- 3. the departure cargo guard -------------------------------------------
{
	const out = trade.createCargoOut();
	// The guard is two years of the export's own need: 2 * pop * NEED[kind].
	// The code's NEED is index-ordered (ui.16 as shipped): food (idx 3) is
	// 0.2 t per 1k per y, so pop 10k holds a guard of 4 t.
	const guard = (pop) => 2 * pop * colony.NEED[3];
	const a = flatColony(10, 500);
	trade.departureCargo(a, out);
	check('the cap is 50 t and the kind is the best export',
		out.kind === 3 && out.tons === 50,
		{ kind: out.kind, tons: out.tons, guard: guard(10) });
	// Exactly at the guard: nothing to give.
	const b = flatColony(10, guard(10));
	trade.departureCargo(b, out);
	check('at the two-year guard the departure is held (0 t)',
		out.kind === 3 && out.tons === 0, { tons: out.tons, guard: guard(10) });
	// Below the guard: held too.
	const c = flatColony(10, 2);
	trade.departureCargo(c, out);
	check('below the guard the departure is held',
		out.tons === 0, { tons: out.tons });
	const d = flatColony(2, 5000);
	trade.departureCargo(d, out);
	check('a small colony surplus is capped at 50, not the raw excess',
		out.tons === 50,
		{ guard: guard(2), excess: 5000 - guard(2) });
}

// --- 4. the ETA fixed point -------------------------------------------------
{
	const v = trade.GENERATION_LY_Y;
	const kpcLy = trade.KPC_LY;
	// 1 ly away, static: the one-shot answer.
	const ly = 1 / kpcLy;
	const eta0 = trade.etaYears(0, 0, 0, ly, 0, 0, 0, 0, 0, v);
	check('a static destination gets the one-shot ETA (1 ly = 10 ky)',
		Math.abs(eta0.years - 1e4) < 1 && !eta0.diverged,
		{ years: eta0.years });
	// Drifting away at 10% of ship speed: t = d / (v - 0.1v) = 11.1 ky.
	const vel = 0.1 * v / kpcLy;   // kpc/y along +x
	const eta1 = trade.etaYears(0, 0, 0, ly, 0, 0, vel, 0, 0, v);
	check('a slow receding drift converges to the intercept time',
		!eta1.diverged && Math.abs(eta1.years - 1e4 / 0.9) < 0.02 * 1e4 / 0.9,
		{ years: eta1.years, expect: 1e4 / 0.9 });
	// Perpendicular drift at half ship speed: still converges.
	const eta2 = trade.etaYears(0, 0, 0, ly, 0, 0, 0, 0.5 * v / kpcLy, 0, v);
	check('a perpendicular drift still converges (the ship curves onto it)',
		!eta2.diverged && eta2.years > 1e4 && eta2.years < 2e4,
		{ years: eta2.years });
	// Fleeing at 3x ship speed: the gap opens; the report says so.
	const eta3 = trade.etaYears(0, 0, 0, ly, 0, 0, 3 * v / kpcLy, 0, 0, v);
	check('a destination that outruns the ship is reported as diverging',
		eta3.diverged && eta3.years > 2e4,
		{ years: eta3.years });
	// Zero distance: no flight at all.
	const eta4 = trade.etaYears(1, 1, 1, 1, 1, 1, 0, 0, 0, v);
	check('a zero separation is an immediate arrival',
		eta4.years === 0 && !eta4.diverged, { years: eta4.years });
}

// --- 5. routes --------------------------------------------------------------
{
	const routes = trade.createRoutes();
	const r1 = trade.commissionRoute(routes, 0, 1, 100);
	const r2 = trade.commissionRoute(routes, 1, 0, 100);
	check('commissioning sets the first departure one period out',
		r1.nextDepartY === 100 + trade.PERIOD_Y && r2.nextDepartY === 102
			&& routes.count === 2 && r1.id === 1 && r2.id === 2,
		{ r1: r1.nextDepartY, r2: r2.nextDepartY });
}

// --- 6. convoy homing -------------------------------------------------------
{
	const convoys = trade.createConvoys();
	const KPC_LY = trade.KPC_LY;
	const vKpcY = trade.GENERATION_LY_Y / KPC_LY;
	// Static target 1 kpc away: arrival after 1/v years, exactly. destPosOf
	// must fill the target — the live-drawn contract main.js honours.
	const totalY = 1 / vKpcY;
	const staticPos = (idx, out) => { out[0] = 1; out[1] = 0; out[2] = 0; return true; };
	trade.spawnConvoy(convoys, 0, 0, 3, 40, 0, 0, 0, 0, totalY);
	let arrived = [];
	for (let i = 0; i < 100 && convoys.count > 0; i++) {
		trade.advanceConvoys(convoys, totalY / 100, 0, staticPos, (c) => arrived.push(c));
	}
	check('a static destination is reached within the flight time',
		arrived.length === 1 && arrived[0].kind === 3 && arrived[0].tons === 40
			&& Math.abs(arrived[0].x - 1) < 1e-9 && Math.abs(arrived[0].y) < 1e-9,
		{ steps: arrived.length, x: arrived[0] && arrived[0].x });
	check('the arrived convoy is removed from the roster',
		convoys.count === 0, { count: convoys.count });
}

{
	// A target drifting sideways at half ship speed: the convoy curves onto
	// it and arrives within twice the straight-line time.
	const convoys = trade.createConvoys();
	const vKpcY = trade.GENERATION_LY_Y / trade.KPC_LY;
	const pos = { x: 1, y: 0 };
	const destPosOf = (idx, out) => { out[0] = pos.x; out[1] = pos.y; out[2] = 0; return true; };
	trade.spawnConvoy(convoys, 0, 0, 3, 40, 0, 0, 0, 0, 1e4);
	const dt = 500;
	let steps = 0;
	let arrivedAt = 0;
	while (convoys.count > 0 && steps < (2 / vKpcY) / dt) {
		steps++;
		// The target creeps +y at 0.5v; the convoy homes every step.
		pos.y += 0.5 * vKpcY * dt;
		trade.advanceConvoys(convoys, dt, steps * dt, destPosOf, () => { arrivedAt = steps * dt; });
	}
	check('a drifting destination is chased down within twice the direct flight',
		convoys.count === 0 && arrivedAt > 0 && arrivedAt < 2 / vKpcY,
		{ arrivedAt, direct: 1 / vKpcY });
}

{
	// A destination fleeing at 3x ship speed: the gap opens; the convoy
	// stays honest — in flight, not arrived.
	const convoys = trade.createConvoys();
	const vKpcY = trade.GENERATION_LY_Y / trade.KPC_LY;
	const pos = { x: 1, y: 0 };
	const destPosOf = (idx, out) => { out[0] = pos.x; out[1] = pos.y; out[2] = 0; return true; };
	trade.spawnConvoy(convoys, 0, 0, 3, 40, 0, 0, 0, 0, 1e4);
	const dt = 500;
	const budget = Math.ceil((4 / vKpcY) / dt);
	for (let i = 0; i < budget; i++) {
		pos.x += 3 * vKpcY * dt;
		trade.advanceConvoys(convoys, dt, i * dt, destPosOf, () => { throw new Error('must not arrive'); });
	}
	check('a destination that outruns the ship never triggers a false arrival',
		convoys.count === 1 && convoys.list[0].x < pos.x,
		{ convoyX: convoys.list[0].x, targetX: pos.x });
}

{
	// Removal is swap-last: three convoys at 1, 8.66 and 15.6 kpc from
	// their targets. One step of 2 kpc lands only the first; the other two
	// keep their state and the roster stays order-free.
	const convoys = trade.createConvoys();
	trade.spawnConvoy(convoys, 0, 0, 0, 10, 0, 0, 0, 0, 0);    // 1 kpc out
	trade.spawnConvoy(convoys, 0, 1, 1, 20, 0, 0, 0, 0, 0);   // 8.66 kpc out
	trade.spawnConvoy(convoys, 0, 2, 2, 30, 0, 0, 0, 0, 0);   // 15.6 kpc out
	const targets = { 0: [1, 0, 0], 1: [5, 5, 5], 2: [9, 9, 9] };
	const destPosOf = (idx, out) => { const t = targets[idx]; out[0] = t[0]; out[1] = t[1]; out[2] = t[2]; return true; };
	let got = [];
	trade.advanceConvoys(convoys, 2 / (trade.GENERATION_LY_Y / trade.KPC_LY), 0, destPosOf, (c) => got.push(c.kind));
	check('only the convoy whose gap the step covers arrives; the rest fly on',
		got.length === 1 && got[0] === 0 && convoys.count === 2
			&& convoys.list[0].kind !== 0 && convoys.list[1].kind !== 0,
		{ got, count: convoys.count });
}

// --- report ----------------------------------------------------------------
const failed = checks.filter((c) => !c.pass);
console.log(`trade: ${checks.length - failed.length}/${checks.length} checks pass`);
if (failed.length) {
	for (const f of failed) console.log('  FAIL ' + f.name + '  ' + JSON.stringify(f.detail || {}));
	process.exitCode = 1;
}
logFile.writeLog(path.join(__dirname, 'logs', 'trade.json'), {
	checks: checks.length,
	failed: failed.length,
	failedNames: failed.map((f) => f.name),
});
