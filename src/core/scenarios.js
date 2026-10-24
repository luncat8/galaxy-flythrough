// src/core/scenarios.js
// The formation checks as one pressable set (ui.21): a scenario is a preset
// line, a view and the one thing to look at in it. The 0.7 series moved what an
// epoch *is* — a census with a birth time per star, a gas account read from
// that census, and a start at the first light — and none of that is visible in
// a menu of sliders: the epoch follows star time only while Evolve is on, and
// the interesting frames sit at the ends of the range. A scenario names the
// state, applies it through the page's own applyPreset, and says which number
// or shape proves it.
//
// Pure data, no DOM and no clock: main.js owns application and the live
// readout. `query` is the URL/preset language, so every scenario is also a
// line a browser pass can record and a fork can paste back.

'use strict';

// `view`: 'galaxy' — orbit the galactic centre from where the camera is, so the
// whole census is in frame; 'none' — leave the camera alone.
// `wide`: the star-time range must be widened before the rate lands (the fine
// range stops at 2 Myr/s).
const SCENARIOS = [
	{
		id: 'firstlight',
		label: 'First light — T = 0',
		query: 'age=0&evolve=0&time=0&mode=observe',
		view: 'galaxy',
		what: 'Nothing has formed yet. The procedural field, star clusters and composite objects are all gated off by their birth times, so the stars and clusters the galaxy is made of are absent, not dim.',
		watch: 'Formed must read 0 % and gas 1.00, with 0 formed clusters. Milky Way catalog stars and landmarks are not part of the gated field (0.7.1 scope) — they still draw; switch Type to SBb in Display for a truly empty sky.',
	},
	{
		id: 'condense',
		label: 'Condensation — 0 → 1 Gyr',
		wide: true,
		query: 'age=0&evolve=1&time=20&mode=observe',
		view: 'galaxy',
		what: 'The epoch runs with star time and advances continuously — 20 Myr/s of star time is 0.02 Gyr of epoch per wall-second, so this reaches 1 Gyr in fifty seconds. Stars arrive as their birth time passes.',
		watch: 'The formed share climbs smoothly, each new star brightens through the 0.05 Gyr fade, and draws stays at 0: stars appear, and nothing already on screen jumps to a new seat.',
	},
	{
		id: 'walk',
		label: 'Full walk — 0 → 13.5 Gyr',
		wide: true,
		query: 'age=0&evolve=1&time=99&mode=observe',
		view: 'galaxy',
		what: 'The whole formation history at the top star rate (99 Myr/s of star time is 0.099 Gyr of epoch per second, so 13.5 Gyr takes about two minutes): the bulge assembles in size, the arms lose contrast as the gas is spent, and the run holds at 13.5 Gyr.',
		watch: 'The field is drawn once at the start. Draws must stay at 0 for the whole run — an epoch change is a placement and a re-solve, never a re-sample.',
	},
	{
		id: 'youngarms',
		label: 'Gas-rich arms — 1.0 Gyr vs today',
		query: 'age=1&evolve=0&time=0&mode=observe',
		view: 'galaxy',
		what: 'At 1 Gyr the drawn census is still mostly gas, so the arms saturate and the disc is thin and cold.',
		watch: 'Read the arm × and the gas in the live line, then press Present day: the same census at 13.5 Gyr (the draw lands the identical positions — it samples the reference frame), view gas at the type\u2019s own fraction and the arms back at ×1.',
	},
	{
		id: 'bulge',
		label: 'Bulge assembly — 2.0 Gyr',
		query: 'age=2&evolve=0&time=0&mode=observe',
		view: 'galaxy',
		what: 'The spheroid assembles in size, not brightness: the bulge is compact while its centre keeps the reference density, and the bar is shorter.',
		watch: 'Compare with Present day from the same camera: the body grows and the arms leave the moving bar tip with no seam or kink. At a fixed radius outside the core the young bulge is the reference profile at a smaller scale.',
	},
];

// The control every comparison needs: the same galaxy, same camera, frozen at
// the reference epoch. Its age is the model's own AGE_REF, not a second copy of
// the number.
const PRESENT_DAY = {
	id: 'today',
	label: 'Present day',
	view: 'galaxy',
	what: 'The reference epoch: every formation factor is exactly 1, so this is the galaxy the type table describes.',
	watch: 'The formed share is 100 % and the view gas is the type\u2019s gas fraction. This is the frame a young scenario is compared against.',
};

function presentDayQuery() {
	const g = typeof window !== 'undefined' ? window : global;
	const ref = g.GalaxyLib ? g.GalaxyLib.AGE_REF : 13.5;
	return 'age=' + ref + '&evolve=0&time=0&mode=observe';
}

// The settings line a row applies. Resolved lazily so this file stays loadable
// in Node before the modules that own the numbers.
function queryOf(row) {
	if (!row) return '';
	return row.query || presentDayQuery();
}

// The panel's live line, formatted here rather than in main.js so the thing a
// browser pass reads is the thing the tests read. `state` is what the page has
// actually built (never the clock's wish): the mode, the epoch in quanta, the
// star rate already formatted, and the three numbers the 0.7 work moved — the
// formed share from the census, the view gas the arms are derived from, and the
// draw count, which must not move while the epoch does.
//
// A number the page has not built yet prints as an em dash instead of
// `undefined`, because a fallback that reads as a value is how the 0.7.3 gas
// account stayed inert unnoticed.
function liveLine(state) {
	const s = state || {};
	const age = Number(s.age);
	const pct = (v) => (Number.isFinite(v) ? Math.round(v * 100) : null);
	const num = (v, digits) => (Number.isFinite(v) ? v.toFixed(digits) : '\u2014');
	const formed = pct(s.formed);
	const step = Number.isFinite(s.step) ? s.step : Math.round((age - Number(s.ageMin)) / Number(s.ageStep));
	const total = Number.isFinite(s.totalSteps) ? s.totalSteps
		: (Number.isFinite(s.ageMax) && Number.isFinite(s.ageMin) && Number(s.ageStep) > 0
			? Math.round((s.ageMax - s.ageMin) / s.ageStep) : null);
	return (s.mode || '\u2014') + ' \u00b7 ' + num(age, 1) + ' Gyr'
		+ (step === null || total === null || !Number.isFinite(step) ? '' : ' (step ' + step + '/' + total + ')')
		+ ' \u00b7 star ' + (s.rate || '\u2014')
		+ ' \u00b7 evolve ' + (s.evolve ? 'on' : 'off')
		+ '\nformed ' + (formed === null ? '\u2014' : formed + '%')
		+ ' \u00b7 gas ' + num(s.gas, 2)
		+ ' \u00b7 arms \u00d7' + num(s.arms, 2)
		+ ' \u00b7 bulge \u00d7' + num(s.bulge, 2)
		+ ' \u00b7 draws ' + (Number.isFinite(s.draws) ? s.draws : 0);
}

function byId(id) {
	const wanted = String(id || '');
	for (let i = 0; i < SCENARIOS.length; i++) {
		if (SCENARIOS[i].id === wanted) return SCENARIOS[i];
	}
	return wanted === PRESENT_DAY.id ? PRESENT_DAY : null;
}

const ScenarioLib = { SCENARIOS, PRESENT_DAY, byId, queryOf, liveLine };
if (typeof module !== 'undefined') module.exports = ScenarioLib;
if (typeof window !== 'undefined') window.ScenarioLib = ScenarioLib;
