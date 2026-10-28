// src/core/named-sky.js
// When the named sky exists at all.
//
// The 60 curated stars in `data/landmarks.js` are *today's* sky, measured from
// the Sun: their coordinates are ICRS positions at J2000 and their magnitudes
// are the ones a human eye reads tonight. So are the constellation figures,
// which are edges between those names. Neither is a property of the model —
// they are a snapshot of one galaxy at one epoch seen from one place.
//
// Before this module the block was drawn unconditionally (`writeLandmarks`
// stamped every landmark with the negative birth sentinel so the formation
// gate could never close on it), which put Orion in the sky of a procedural
// Sb at its first light and at the far side of an E4. The named sky is now
// gated on the two things that actually decide whether it means anything:
//
//   * the galaxy must be the Milky Way preset (`model.milkyWay`) — a
//     procedural galaxy has its own stars and no named ones;
//   * the epoch must be within `EPOCH_TOL_GYR` of `AGE_REF` — a star's
//     position changes by ~0.15 kpc per 100 Myr at the solar circle, so a
//     figure drawn 2 Gyr out connects stars that are not neighbours any more,
//     and at first light most of them do not exist yet;
//   * the star clock must be slow enough to see it — above `MAX_RATE_MYR_PER_S`
//     a solar-circle star sweeps more than 8° per wall-second and the figures
//     are a smear, so the layer stops drawing *and* stops updating them.
//
// All three are cheap, pure and read every frame; the reasons are interned
// strings so a frame never allocates to ask why the sky is off.

'use strict';

(function () {
	const galaxy = (typeof module !== 'undefined' && module.exports)
		? require('../math/galaxy.js')
		: window.GalaxyLib;

	// ±1 Gyr of the reference epoch. A century of proper motion is invisible;
	// a gigayear of galactic rotation is not — at the solar circle 1 Gyr is
	// ~4 revolutions, so a figure held across that window is a different shape.
	const EPOCH_TOL_GYR = 1.0;
	// Above this the sky is moving faster than a figure can be read. 5 Myr/s
	// is 8.1°/s of shear at 8 kpc; the figures are gone inside a second.
	const MAX_RATE_MYR_PER_S = 5;

	const REASON_OK = 'ok';
	const REASON_NO_SKY = 'no-named-sky';
	const REASON_EPOCH = 'epoch';
	const REASON_FAST = 'star-time';

	// One sentence per reason, for the control that is greyed out. The page
	// prints these verbatim, so they say what to do, not just what is wrong.
	const REASON_TEXT = {
		[REASON_OK]: 'Milky Way, present day: the curated named stars and their figures.',
		[REASON_NO_SKY]: 'This galaxy has no named stars — the curated sky is the Milky Way only. Create your own figures from the selected position instead.',
		[REASON_EPOCH]: 'The named sky is the present-day one — within 1 Gyr of 13.5 Gyr. At this epoch those stars are elsewhere, or not formed yet.',
		[REASON_FAST]: 'Star time is running too fast to read a figure — the sky shears past it. Pause or slow below 5 Myr/s.',
	};

	function ageOf(model) {
		if (!model) return galaxy.AGE_REF;
		const pops = model.populations;
		return pops && Number.isFinite(pops.age) ? pops.age : galaxy.AGE_REF;
	}

	// Why the named sky is on or off. Interned: safe to call per frame.
	function reasonOf(model, rateMyrPerS) {
		if (!model || !model.milkyWay) return REASON_NO_SKY;
		if (Math.abs(ageOf(model) - galaxy.AGE_REF) > EPOCH_TOL_GYR) return REASON_EPOCH;
		const rate = Number(rateMyrPerS);
		if (Number.isFinite(rate) && Math.abs(rate) > MAX_RATE_MYR_PER_S) return REASON_FAST;
		return REASON_OK;
	}

	function activeOf(model, rateMyrPerS) {
		return reasonOf(model, rateMyrPerS) === REASON_OK;
	}

	// The epoch window the curated sky is valid over, for a readout.
	function epochWindow() {
		return { from: galaxy.AGE_REF - EPOCH_TOL_GYR, to: galaxy.AGE_REF + EPOCH_TOL_GYR };
	}

	function describe(reason) {
		const text = REASON_TEXT[reason];
		return text === undefined ? REASON_TEXT[REASON_NO_SKY] : text;
	}

	const NamedSky = {
		EPOCH_TOL_GYR, MAX_RATE_MYR_PER_S,
		REASON_OK, REASON_NO_SKY, REASON_EPOCH, REASON_FAST,
		REASON_TEXT, reasonOf, activeOf, epochWindow, describe, ageOf,
	};
	if (typeof module !== 'undefined') module.exports = NamedSky;
	if (typeof window !== 'undefined') window.NamedSky = NamedSky;
})();
