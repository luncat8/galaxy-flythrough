// src/core/timeboard.js
// The clock board (time-plan.md §1–§2): every clock in the app, the two links
// that couple them, and the three playable progressions that set all of them at
// once. Pure data and pure transitions — no DOM, no dependencies, so the panel,
// the preset language and the tests read the same table.
//
// The clocks, in the order the board prints them:
//
//   star    the galaxy's clock, Myr/s (the sky, the epoch, the pattern phase)
//   trade   the colony network's clock, colony years/s (settles, voyages)
//   system  the opened system's clock, years/s (orbits, ferries, routes)
//   ship    the helm's clock, years/s (only while flying; rides the star axis)
//
// The two links:
//
//   trade → star   `clockRate` in trade.js maps 1 star Myr to 1 000 colony
//                  years (capped at 2 000 y/s), which is the authored pace and
//                  the reason a synced economy reads at every star rate.
//   system → star  one schematic year per star Myr per wall second, i.e. the
//                  bridge below. At 1 Myr/s the schematic runs 1 y/s: a Hohmann
//                  leg takes about half a second, which is what the ferries are
//                  drawn at. This is the only place the two are related; the
//                  layer itself knows nothing about star time.

'use strict';

// Star Myr per wall second → schematic years per wall second.
const SYSTEM_STAR_BRIDGE = 1e-6;

// The three progressions (time-plan.md §2). Each is a whole profile: a mode
// that set only one clock would leave the other three disagreeing, which is the
// state the board exists to end.
//
// `trade.rate` is the ladder stop the trade clock falls back to when the link
// is off; `trade.synced` says whether the link is on. `system.rate` is the same
// for the schematic, in years per second.
const MODES = [
	{
		id: 'generation',
		label: 'generation ship',
		note: 'the galaxy evolves and the colonies live on its clock: 0.5 Myr/s of sky is 500 colony years per second, '
			+ 'and every hull is a generation ship (1 ly per 33 years, reserves stretched to its voyage)',
		star: { rate: 0.5, evolve: 1 },
		trade: { synced: 1, rate: 500, generation: 1 },
		system: { synced: 0, rate: 0.05 },
	},
	{
		id: 'trade',
		label: 'trade',
		note: 'next-generation hulls on a slow but visible sky: 1 Myr/s of stars is 1 000 colony years per second, '
			+ 'so a long haul is overtaken by the stars it crosses and a route can go out of reach under the ship',
		star: { rate: 1, evolve: 1 },
		trade: { synced: 1, rate: 1000, generation: 0 },
		system: { synced: 0, rate: 1 },
	},
	{
		id: 'planetary',
		label: 'planetary',
		note: 'the sky holds still: delta-v flying inside a system, colonies creeping at 50 years/s, '
			+ 'and the schematic at half a year per second — a fleet you can watch. Interstellar travel wants jump gates',
		star: { rate: 0, evolve: 0 },
		trade: { synced: 0, rate: 50, generation: 0 },
		system: { synced: 0, rate: 0.5 },
	},
];

const MODE_IDS = MODES.map((mode) => mode.id);
const DEFAULT_MODE = 'trade';

function modeById(id) {
	const key = String(id || '');
	for (let i = 0; i < MODES.length; i++) if (MODES[i].id === key) return MODES[i];
	return null;
}

function modeLabel(id) {
	const mode = modeById(id);
	return mode ? mode.label : '';
}

// The schematic clock a linked system runs at, in years per wall second. A
// frozen or camera-following star clock has nothing to lend, so the caller
// keeps its own rung (0 and −1 are the layer's own bottom rungs, and the board
// prints which one is in charge).
function systemRateForStar(starRateMyrPerS) {
	const rate = Number(starRateMyrPerS);
	if (!(rate > 0)) return null;
	return rate * SYSTEM_STAR_BRIDGE / 1e-6;
}

// Which progression the clocks are on *right now*, or '' when they are not on
// one. The board reads this instead of remembering the last press: a slider
// dragged after a press moves the board off that mode, which is the truth a
// ledger should print. `state` is the live clock set —
// `{ starRate, evolve, tradeRate, tradeSynced, generation, systemRate, systemSynced }`.
// An unlinked clock is compared by its rate; a linked one only by the link,
// because the star clock decides the number.
function matchMode(state) {
	for (let i = 0; i < MODES.length; i++) {
		const mode = MODES[i];
		if (mode.star.rate !== state.starRate) continue;
		if (mode.star.evolve !== state.evolve) continue;
		if (mode.trade.synced !== state.tradeSynced) continue;
		if (mode.trade.generation !== state.generation) continue;
		if (mode.system.synced !== state.systemSynced) continue;
		if (!mode.trade.synced && mode.trade.rate !== state.tradeRate) continue;
		if (!mode.system.synced && mode.system.rate !== state.systemRate) continue;
		return mode.id;
	}
	return '';
}

// The board's own words for a rate, so the panel and the mode notes cannot
// drift apart. Star rates are Myr/s, everything else is years/s.
function formatStarRate(rateMyrPerS) {
	const rate = Number(rateMyrPerS);
	if (!(rate > 0)) return 'frozen';
	return (rate < 1 ? rate.toFixed(1) : String(Math.round(rate * 10) / 10)) + ' Myr/s';
}

function formatTradeRate(yearsPerSecond, synced) {
	const rate = Number(yearsPerSecond);
	const text = !(rate > 0) ? 'paused' : Math.round(rate).toLocaleString('en-US') + ' y/s';
	return text + (synced ? ' \u00b7 star' : ' \u00b7 own');
}

const TimeBoard = {
	SYSTEM_STAR_BRIDGE, MODES, MODE_IDS, DEFAULT_MODE,
	modeById, modeLabel, matchMode, systemRateForStar, formatStarRate, formatTradeRate,
};
if (typeof module !== 'undefined') module.exports = TimeBoard;
if (typeof window !== 'undefined') window.TimeBoard = TimeBoard;
