// experiments/colony-test.js
// Validates the colony economy (colony-economy-plan.md): the resource map's
// determinism and its star-derived laws, the advance law (growth on a
// terran-rich system, famine on a food-poor one, chunking determinism, the
// coarse flag), the market's price bounds and supply response, and the
// trade math (buy within hold and credits, sell the whole hold, the
// cross-port margin).
//
// Output: experiments/logs/colony.json

'use strict';

const logFile = require('./log-file.js');
const path = require('path');
const colony = require('../src/core/colony.js');
const planets = require('../src/math/planets.js');
const galaxy = require('../src/math/galaxy.js');
const sampling = require('../src/math/sampling.js');

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
	return !!pass;
}

// --- synthetic records (§2 reads only these fields) -----------------------
//
// star.metal/lum/key drive the map; planets.bulk/flags and belts.count the
// composition. Real generated systems cover the integration pins below.
function synthRecord(opts) {
	const n = (opts.bulk || []).length;
	const flags = opts.flags || new Array(n).fill(0);
	return {
		star: {
			key: opts.key || 1, metal: opts.metal !== undefined ? opts.metal : 0.02,
			lum: opts.lum !== undefined ? opts.lum : 1, mass: 1, teff: 5700, rStar: 1,
			age: 5, state: 'ms', spectralClass: 'G',
		},
		planets: { bulk: opts.bulk || [], flags, displayType: new Array(n).fill(0) },
		belts: { count: opts.belts || 0 },
		counts: { planets: n, terranCount: opts.terran || 0, giantCount: 0 },
	};
}

const SEED = 12345;
const map = colony.createResourceMap();

// --- 1. determinism and the jitter ----------------------------------------
{
	const rec = synthRecord({ key: 77, metal: 0.02, lum: 1, bulk: [0, 0, 3], belts: 1 });
	const a = colony.resourceMapFor(rec, SEED, colony.createResourceMap());
	const b = colony.resourceMapFor(synthRecord({ key: 77, metal: 0.02, lum: 1, bulk: [0, 0, 3], belts: 1 }),
		SEED, colony.createResourceMap());
	let same = true;
	for (let i = 0; i < 6; i++) if (a.ease[i] !== b.ease[i]) same = false;
	check('the same star maps to the same ease every call', same && a.score === b.score);
	check('a different star maps differently',
		colony.resourceMapFor(synthRecord({ key: 78, metal: 0.02, lum: 1, bulk: [0, 0, 3], belts: 1 }),
			SEED, colony.createResourceMap()).ease[0] !== a.ease[0]);
	// The jitter is the plan's ±0.06 (§2): each draw is a hash01At off the
	// star's own identity key, clamped back into [0, 1] after the law.
	const hash = require('../src/math/hash.js');
	let inRange = true;
	for (let k = 0; k < 40; k++) {
		const m = colony.resourceMapFor(synthRecord({ key: 1000 + k, metal: 0.02, lum: 1, bulk: [0, 0, 3], belts: 1 }), SEED, { ease: new Float64Array(6), score: 0 });
		for (let i = 0; i < 6; i++) if (m.ease[i] < 0 || m.ease[i] > 1) inRange = false;
	}
	check('the ease stays inside [0,1] across 40 stars', inRange, { inRange });
}

// --- 2. the star-derived laws ----------------------------------------------
{
	const metalPoor = colony.resourceMapFor(synthRecord({ key: 201, metal: 0.002, lum: 1, bulk: [0, 0, 0], belts: 2 }), SEED, colony.createResourceMap());
	const metalRich = colony.resourceMapFor(synthRecord({ key: 202, metal: 0.03, lum: 1, bulk: [0, 0, 0], belts: 2 }), SEED, colony.createResourceMap());
	check('a metal-poor star cannot make rare elements',
		metalPoor.ease[0] < 0.35 && metalRich.ease[0] > metalPoor.ease[0] + 0.3,
		{ poor: metalPoor.ease[0].toFixed(3), rich: metalRich.ease[0].toFixed(3) });

	const dim = colony.resourceMapFor(synthRecord({ key: 203, metal: 0.02, lum: 0.01, bulk: [4, 4], belts: 0 }), SEED, colony.createResourceMap());
	const bright = colony.resourceMapFor(synthRecord({ key: 204, metal: 0.02, lum: 4, bulk: [4, 4], belts: 0 }), SEED, colony.createResourceMap());
	check('low light cannot make antimatter (the draft: low metal, low light)',
		dim.ease[2] < 0.2 && bright.ease[2] > 0.8,
		{ dim: dim.ease[2].toFixed(3), bright: bright.ease[2].toFixed(3) });

	// terran + HZ flags drive food; a bare rock system grows none.
	const terran = synthRecord({ key: 205, metal: 0.02, lum: 1, bulk: [0], belts: 0 });
	terran.planets.flags = [4 | 8];           // terran in HZ
	terran.counts.terranCount = 1;
	const terranMap = colony.resourceMapFor(terran, SEED, colony.createResourceMap());
	const rock = colony.resourceMapFor(synthRecord({ key: 206, metal: 0.02, lum: 1, bulk: [0], belts: 0 }),
		SEED, colony.createResourceMap());
	check('terran worlds in the HZ grow food; bare rock does not',
		terranMap.ease[3] > rock.ease[3] + 0.35 && rock.ease[3] < 0.5,
		{ terran: terranMap.ease[3].toFixed(3), rock: rock.ease[3].toFixed(3) });

	const flat = colony.resourceMapFor(synthRecord({ key: 207, metal: 0.02, lum: 0.5, bulk: [0], belts: 0 }), SEED, colony.createResourceMap());
	check('info ease is flat 0.3 before the jitter', Math.abs(flat.ease[5] - 0.3) <= 0.06 + 1e-12,
		{ info: flat.ease[5].toFixed(3) });
}

// --- 3. the advance law ----------------------------------------------------
{
	// A terran-rich founding grows over a decade.
	const good = synthRecord({ key: 301, metal: 0.025, lum: 1.2, bulk: [0, 3, 4], belts: 1 });
	good.planets.flags = [4 | 8, 0, 0];
	good.counts.terranCount = 1;
	const goodMap = colony.resourceMapFor(good, SEED, colony.createResourceMap());
	const c1 = colony.createColony(301, 'Good', 0, goodMap);
	colony.advanceColony(c1, 10);
	check('a terran-rich founding grows population and capital over 10 y',
		c1.pop > 2 && c1.capital > 2 && c1.comfort > 0.6,
		{ pop: +c1.pop.toFixed(2), capital: +c1.capital.toFixed(2), comfort: +c1.comfort.toFixed(2) });
	const popAt10 = c1.pop;
	colony.advanceColony(c1, 20);
	check('growth compounds toward the carrying capacity',
		c1.pop > popAt10 && c1.comfort > 0.5,
		{ pop: +c1.pop.toFixed(2), comfort: +c1.comfort.toFixed(2) });

	// A food-poor, dim founding starves.
	const bad = synthRecord({ key: 302, metal: 0.004, lum: 0.05, bulk: [0, 6], belts: 0 });
	const badMap = colony.resourceMapFor(bad, SEED, colony.createResourceMap());
	const c2 = colony.createColony(302, 'Bad', 0, badMap);
	const pop0 = c2.pop;
	colony.advanceColony(c2, 10);
	check('a food-poor founding starves (famine bites, population falls)',
		c2.comfort < 0.45 && c2.pop < 0.9 * pop0,
		{ pop: +c2.pop.toFixed(3), pop0: +pop0.toFixed(3), comfort: +c2.comfort.toFixed(3) });

	// Chunking determinism: one 10 y advance == forty 0.25 y advances.
	const c3 = colony.createColony(301, 'Chunk A', 0, goodMap);
	colony.advanceColony(c3, 10);
	const c4 = colony.createColony(301, 'Chunk B', 0, goodMap);
	for (let i = 1; i <= 40; i++) colony.advanceColony(c4, i * 0.25);
	check('one 10 y advance equals forty 0.25 y advances',
		Math.abs(c3.pop - c4.pop) < 1e-9 * Math.max(1, c3.pop)
			&& Math.abs(c3.capital - c4.capital) < 1e-9 * Math.max(1, c3.capital)
			&& c3.stock[3] === c4.stock[3],
		{ popA: +c3.pop.toFixed(6), popB: +c4.pop.toFixed(6) });

	// The coarse flag over a span beyond 512 y.
	const c5 = colony.createColony(301, 'Long', 0, goodMap);
	colony.advanceColony(c5, 700);
	check('a 700 y span coarsens and says so', c5.coarse === true);
	const c6 = colony.createColony(301, 'Short', 0, goodMap);
	colony.advanceColony(c6, 100);
	check('a 100 y span stays at the fine dt', c6.coarse === false);

	// No-op on a non-positive span.
	const before = c1.pop;
	colony.advanceColony(c1, c1.lastY);
	colony.advanceColony(c1, c1.lastY - 5);
	check('a non-positive span is a no-op', c1.pop === before && c1.advances === 2);
}

// --- 4. the market ---------------------------------------------------------
{
	const good = synthRecord({ key: 401, metal: 0.028, lum: 1.5, bulk: [0, 0, 3, 4], belts: 2 });
	good.planets.flags = [4 | 8, 0, 0, 0];
	good.counts.terranCount = 1;
	const goodMap = colony.resourceMapFor(good, SEED, colony.createResourceMap());
	const rich = colony.createColony(401, 'Rich', 0, goodMap);
	// Age it so stocks build.
	colony.advanceColony(rich, 30);

	const bad = synthRecord({ key: 402, metal: 0.004, lum: 0.05, bulk: [6], belts: 0 });
	const badMap = colony.resourceMapFor(bad, SEED, colony.createResourceMap());
	const poor = colony.createColony(402, 'Poor', 0, badMap);
	colony.advanceColony(poor, 30);

	let bounds = true;
	for (let r = 0; r < 6; r++) {
		const pRich = colony.marketPrice(r, rich);
		const pPoor = colony.marketPrice(r, poor);
		const base = colony.RESOURCES[r].base;
		if (pRich < 0.4 * base - 1e-9 || pRich > 1.6 * base + 1e-9) bounds = false;
		if (pPoor < 0.4 * base - 1e-9 || pPoor > 1.6 * base + 1e-9) bounds = false;
	}
	check('prices live inside 0.4·BASE … 1.6·BASE', bounds);

	// Supply grows → price falls: the rich port's best export is cheaper
	// than the same good at the poor port.
	const best = colony.bestExport(rich);
	check('the rich port undersells the poor port on its best export',
		colony.marketPrice(best, rich) < colony.marketPrice(best, poor) - 0.5,
		{ rich: +colony.marketPrice(best, rich).toFixed(2), poor: +colony.marketPrice(best, poor).toFixed(2) });
	check('bestExport is the cheapest good and a valid index',
		best >= 0 && best < 6 && colony.marketPrice(best, rich) <= colony.marketPrice(0, rich) + 1e-12);

	// The stock term: an empty-stock colony prices higher than the same
	// colony holding two years of need.
	const c = colony.createColony(402, 'Stock', 0, badMap);
	const emptyP = colony.marketPrice(0, c);
	c.stock[0] = 2 * c.pop * colony.NEED[0] + 50;   // saturated (§4)
	check('two years of need in stock saturates the supply term',
		colony.marketPrice(0, c) < emptyP - 1e-9,
		{ empty: +emptyP.toFixed(2), stocked: +colony.marketPrice(0, c).toFixed(2) });
}

// --- 5. trade --------------------------------------------------------------
{
	const good = synthRecord({ key: 501, metal: 0.028, lum: 1.5, bulk: [0, 0, 3, 4], belts: 2 });
	good.planets.flags = [4 | 8, 0, 0, 0];
	good.counts.terranCount = 1;
	const goodMap = colony.resourceMapFor(good, SEED, colony.createResourceMap());
	const exporter = colony.createColony(501, 'Exporter', 0, goodMap);
	colony.advanceColony(exporter, 30);

	const bad = synthRecord({ key: 502, metal: 0.004, lum: 0.05, bulk: [6], belts: 0 });
	const badMap = colony.resourceMapFor(bad, SEED, colony.createResourceMap());
	const importer = colony.createColony(502, 'Importer', 0, badMap);
	colony.advanceColony(importer, 30);

	// Buy at the exporter within a hold of 2000 t and 400 cr.
	const out = colony.createTradeOut();
	colony.buyAtPort(exporter, 2000, 400, out);
	check('buy fills within the hold and the credits, in whole tons',
		out.tons > 0 && out.tons <= 2000 && out.cost <= 400 + 1e-9 && out.kind >= 0
			&& out.tons === Math.floor(out.tons),
		{ tons: out.tons, cost: +out.cost.toFixed(2), kind: out.kind });
	const spend = out.cost;
	const heldKind = out.kind;
	const heldTons = out.tons;

	// Nothing affordable: a broke hull.
	colony.buyAtPort(exporter, 2000, 0.5, out);
	check('a broke hull buys nothing', out.tons === 0 && out.kind === -1);
	// No room: a full hold.
	colony.buyAtPort(exporter, 0, 400, out);
	check('a full hold buys nothing', out.tons === 0);

	// Sell the whole hold at the importer: the cross-port margin.
	const revenue = colony.sellAtPort(importer, heldKind, heldTons);
	check('selling across the ease differential is profitable',
		revenue > spend * 1.05,
		{ revenue: +revenue.toFixed(2), spend: +spend.toFixed(2) });
	// Selling back at the export port recovers only the buy price (a
	// same-port round trip is a wash by construction — one price both ways).
	const back = colony.sellAtPort(exporter, heldKind, heldTons);
	check('a same-port round trip is a wash, not a profit',
		Math.abs(back - spend) < 1e-9,
		{ back: +back.toFixed(2), spend: +spend.toFixed(2) });
	check('selling an empty hold or an invalid kind is zero',
		colony.sellAtPort(importer, -1, 10) === 0 && colony.sellAtPort(importer, 0, 0) === 0);
}

// --- 6. integration: real generated systems --------------------------------
{
	// The same generateSystem record the schematic reads, over the real
	// sampler: the map must be reproducible and in range for real stars.
	const model = galaxy.createGalaxy({ type: 'SBb', seed: 4242, age: 13.5 });
	const field = sampling.sampleGalaxyStars(model, model.seed | 0, 3000, null);
	const ctx = { model, field, member: null };
	const rec = planets.createSystemRecord();
	const m = colony.createResourceMap();
	let allInRange = true, anyScore = false;
	const scores = [];
	for (let i = 0; i < 40; i++) {
		const ref = { kind: 0, key: (i * 2654435761) >>> 0, index: i, x: 0, y: 0, z: 0 };
		const r = planets.generateSystem(ref, ctx, rec);
		colony.resourceMapFor(r, model.seed, m);
		for (let e = 0; e < 6; e++) if (m.ease[e] < 0 || m.ease[e] > 1) allInRange = false;
		if (m.score > 0.05) anyScore = true;
		scores.push(m.score);
		// A colony over a real system advances without NaN.
		const c = colony.createColony(1, 'Real', 0, m);
		colony.advanceColony(c, 25);
		if (!Number.isFinite(c.pop) || !Number.isFinite(c.capital) || !Number.isFinite(c.stock[3])) allInRange = false;
	}
	check('real generated systems map in range and advance without NaN',
		allInRange && anyScore,
		{ allInRange, anyScore, minScore: +Math.min(...scores).toFixed(3), maxScore: +Math.max(...scores).toFixed(3) });

	// formatPop's ladder.
	check('formatPop reads 5.2k / 250k / 1.50M',
		colony.formatPop(5.2) === '5.2k' && colony.formatPop(250) === '250k' && colony.formatPop(1500) === '1.50M',
		{ a: colony.formatPop(5.2), b: colony.formatPop(250), c: colony.formatPop(1500) });
}


// --- 7. the event ledger (ui.17) -------------------------------------------
{
	// schedule inserts sorted; dueEvents drains in order and only what is
	// due; ties keep insertion order; cancel drops matching events.
	const led = colony.createEventLedger();
	colony.schedule(led, 5, colony.EV_MILESTONE, 7, 0, 5);
	colony.schedule(led, 2, colony.EV_FAMINE, 7, 1, 0);
	colony.schedule(led, 5, colony.EV_ROUTE_DEPART, 1, 0, 0);
	colony.schedule(led, 9, colony.EV_ROUTE_ARRIVE, 1, 3, 12.5);
	const got = [];
	colony.dueEvents(led, 4.5, (k, a, b, c, at) => got.push([k, a, b, at]));
	check('dueEvents drains only what is due, in order',
		got.length === 1 && got[0][0] === colony.EV_FAMINE && got[0][1] === 7 && got[0][3] === 2
			&& led.count === 3,
		{ got });
	const got2 = [];
	colony.dueEvents(led, 5, (k, a, b, c, at) => got2.push([k, a, at]));
	check('equal timestamps keep insertion order (FIFO)',
		got2.length === 2 && got2[0][0] === colony.EV_MILESTONE
			&& got2[1][0] === colony.EV_ROUTE_DEPART && led.count === 1,
		{ got2 });
	check('cancel removes only the matching kind and payload',
		colony.cancel(led, colony.EV_ROUTE_ARRIVE, 1) === 1 && led.count === 0
			&& colony.cancel(led, colony.EV_ROUTE_ARRIVE, 1) === 0,
		{ count: led.count });
	const cap = colony.createEventLedger();
	let ok = 0;
	for (let i = 0; i < 70; i++) if (colony.schedule(cap, i, colony.EV_MILESTONE, i, 0, i)) ok++;
	check('the ledger caps at 64 and drops the latest, not the head',
		ok === colony.LEDGER_CAP && cap.count === colony.LEDGER_CAP && cap.at[0] === 0,
		{ ok, count: cap.count });
}

{
	// Milestones: the growth colony narrates its ladder. The crossings are
	// inside the advance's span, ascend, and never repeat on a re-advance.
	const good = synthRecord({ key: 311, metal: 0.025, lum: 1.2, bulk: [0, 3, 4], belts: 1 });
	good.planets.flags = [4 | 8, 0, 0];
	good.counts.terranCount = 1;
	const goodMap = colony.resourceMapFor(good, SEED, colony.createResourceMap());
	const c1 = colony.createColony(311, 'Milestone', 0, goodMap, 1, 0, 0);
	c1.idx = 0;
	const led = colony.createEventLedger();
	colony.advanceColony(c1, 100, led);
	const ms = [];
	colony.dueEvents(led, 100, (k, a, b, c) => { if (k === colony.EV_MILESTONE) ms.push(c); });
	let ascending = ms.length >= 2;
	for (let i = 1; i < ms.length; i++) if (ms[i] <= ms[i - 1]) ascending = false;
	const lastIdx = c1.popIdx - 1;
	check('a growing colony narrates ascending pop milestones inside the span',
		ascending && ms.length > 0 && ms[ms.length - 1] === colony.POP_MILESTONES[lastIdx]
			&& (c1.popIdx >= colony.POP_MILESTONES.length
				|| c1.pop < colony.POP_MILESTONES[c1.popIdx] + 1e-12),
		{ ms, popIdx: c1.popIdx, pop: +c1.pop.toFixed(2) });
	colony.advanceColony(c1, 101, led);
	const again = [];
	colony.dueEvents(led, 101, (k, a, b, c) => { if (k === colony.EV_MILESTONE) again.push(c); });
	const allMs = ms.concat(again);
	const seen = new Set();
	let noDups = true;
	for (const t of allMs) {
		if (seen.has(t)) noDups = false;
		seen.add(t);
	}
	check('a re-advance emits only newly crossed thresholds, never duplicates',
		noDups && (again.length === 0 || again[0] > ms[ms.length - 1])
			&& (again.length === 0
				|| colony.POP_MILESTONES.indexOf(again[again.length - 1]) === c1.popIdx - 1),
		{ ms, again, popIdx: c1.popIdx });
}

{
	// Famine: the starving colony enters the band, an injected food stock
	// lifts it out. Both crossings land on the ledger, in order.
	const bad = synthRecord({ key: 312, metal: 0.004, lum: 0.05, bulk: [0, 6], belts: 0 });
	const badMap = colony.resourceMapFor(bad, SEED, colony.createResourceMap());
	const c2 = colony.createColony(312, 'Famine', 0, badMap);
	c2.idx = 1;
	const led = colony.createEventLedger();
	colony.advanceColony(c2, 10, led);
	c2.stock[3] += 5000;   // the relief convoy the test plays
	colony.advanceColony(c2, 15, led);
	const fam = [];
	colony.dueEvents(led, 15, (k, a, b) => { if (k === colony.EV_FAMINE) fam.push(b); });
	check('famine enters and lifts, in order',
		fam.length === 2 && fam[0] === 1 && fam[1] === 0 && c2.starving === false,
		{ fam, comfort: +c2.comfort.toFixed(3) });

	// The ledger does not perturb the physics: with and without produce the
	// same state. Two fresh colonies off the same deterministic map law.
	const physRec = synthRecord({ key: 313, metal: 0.025, lum: 1.2, bulk: [0, 3, 4], belts: 1 });
	physRec.planets.flags = [4 | 8, 0, 0];
	physRec.counts.terranCount = 1;
	const c5 = colony.createColony(313, 'Ledgerless', 0,
		colony.resourceMapFor(physRec, SEED, colony.createResourceMap()));
	const c6 = colony.createColony(313, 'Ledgered', 0,
		colony.resourceMapFor(physRec, SEED, colony.createResourceMap()));
	c5.idx = 5; c6.idx = 6;
	const led2 = colony.createEventLedger();
	colony.advanceColony(c5, 100);
	colony.advanceColony(c6, 100, led2);
	let sameState = c5.pop === c6.pop && c5.capital === c6.capital
		&& c5.comfort === c6.comfort && c5.starving === c6.starving;
	for (let r = 0; r < 6; r++) if (c5.stock[r] !== c6.stock[r]) sameState = false;
	check('the ledger argument does not change the advance',
		sameState,
		{ pop: +c5.pop.toFixed(6), popLedgered: +c6.pop.toFixed(6) });
}

// --- report ----------------------------------------------------------------
const failed = checks.filter((c) => !c.pass);
console.log(`colony: ${checks.length - failed.length}/${checks.length} checks pass`);
if (failed.length) {
	for (const f of failed) console.log('  FAIL ' + f.name + '  ' + JSON.stringify(f.detail || {}));
	process.exitCode = 1;
}
logFile.writeLog(path.join(__dirname, 'logs', 'colony.json'), {
	checks: checks.length,
	failed: failed.length,
	failedNames: failed.map((f) => f.name),
});
