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

// The three progressions (time-plan.md §2, corrected in trade.36). A
// progression is a **game** clock profile: it says what the colony clock and
// the opened system's clock are related to. It never touches the star clock or
// the epoch — time is time, and the sky's clock is the Display panel's. A press
// that moved the star rate (and with it the galaxy's age) was the reported
// defect: watching a fleet slower must not re-date the galaxy.
//
// `trade.rate` is the ladder stop the colony clock falls back to when the link
// is off; `trade.synced` says whether the link is on. `system.rate` is the same
// for the schematic, in years per second.
const MODES = [
	{
		id: 'linked',
		label: 'one clock',
		note: 'both game clocks ride the sky: one colony year per star millennium and one schematic year per star Myr, '
			+ 'so the colonies, the opened system and the stars advance together. The star clock itself is Display\u2019s, untouched.',
		trade: { synced: 1, rate: 1000 },
		system: { synced: 1, rate: 1 },
	},
	{
		id: 'trade',
		label: 'trade',
		note: 'the colony clock rides the sky and the opened system keeps its own: 1 Myr/s of stars is 1 000 colony years per second, '
			+ 'while orbits and ferries run at a year per second. A long haul can be overtaken by the stars it crosses.',
		trade: { synced: 1, rate: 1000 },
		system: { synced: 0, rate: 1 },
	},
	{
		id: 'planetary',
		label: 'planetary',
		note: 'nothing rides the sky: colonies on their own 50 years/s ladder and the schematic at half a year per second, '
			+ 'so a fleet and a set of orbits can be watched. Interstellar voyages still take the colony clock\u2019s centuries.',
		trade: { synced: 0, rate: 50 },
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

// Which progression the game clocks are on *right now*, or '' when they are not
// on one. The board reads this instead of remembering the last press: a slider
// dragged after a press moves the board off that mode, which is the truth a
// ledger should print. `state` is the live game clock set —
// `{ tradeRate, tradeSynced, systemRate, systemSynced }`. The star clock is
// deliberately absent: it is not part of a progression (trade.36).
// An unlinked clock is compared by its rate; a linked one only by the link,
// because the star clock decides the number.
function matchMode(state) {
	for (let i = 0; i < MODES.length; i++) {
		const mode = MODES[i];
		if (mode.trade.synced !== state.tradeSynced) continue;
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
