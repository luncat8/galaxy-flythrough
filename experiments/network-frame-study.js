// experiments/network-frame-study.js
// Study, not a test: how far the colony network is DRAWN from home as the star
// clock runs, for a network that has not changed at all.
//
// The report this exists for: "colonies established across the galaxy with long
// routes across the whole galaxy". It is not a coordinate mismatch — every port
// resolves through the same dispatch the sprites are drawn with, to the bit. It
// is a frame question: a colony is a star, a star's drawn position is its orbit
// at the running star time, and at the app's default 1 Myr/s a solar-circle star
// sweeps 0.22 kpc per wall second. So a network founded inside 100 ly is drawn
// 40 000 ly across the galaxy one wall minute later, and the founding cap
// (MAX_FOUND_LY = 600) is a promise about the instant of founding, not about the
// picture.
//
// Run: node experiments/network-frame-study.js
// Prints, no pass/fail, no log file.

'use strict';

const planets = require('../src/math/planets.js');
const galaxy = require('../src/math/galaxy.js');
const trade = require('../src/core/trade.js');
const sampling = require('../src/math/sampling.js');
const starTypes = require('../src/math/star-types.js');
const orbit = require('../src/math/orbit.js');
const records = require('../src/math/star-record.js');
const landmarks = require('../src/data/landmarks.js');

const model = galaxy.MILKY_WAY;
const FIELD_STARS = 300000;
const field = sampling.sampleGalaxyStars(model, model.seed | 0, FIELD_STARS);
// The renderer's record words, rebuilt exactly as writeProceduralRecords does:
// the CPU dispatch needs the packed word, not only the sampler's arrays.
const packed = new Uint32Array(field.count);
const derived = {};
field.birth = new Float32Array(field.count);
for (let i = 0; i < field.count; i++) {
	const key = starTypes.fieldStarSeed(model.seed, i);
	starTypes.deriveStar(model, key, field.component[i], field.R[i], field.distToArm[i], derived, field.z[i]);
	packed[i] = records.packPacked(derived.colorIndex, derived.absMag,
		orbit.flagsWithFamily(records.FLAG_VISIBLE,
			orbit.familyForStar(field.component[i], derived.spectralClass, model.barred)),
		starTypes.fieldStarJitter(i));
	field.birth[i] = starTypes.sampleFieldBirth(model, starTypes.fieldStarSeed(model.seed | 0, i),
		field.component[i], field.R[i], field.distToArm[i], field.z[i]);
}

const home = model.home.orbitTarget;
const ctx = { model, field, member: null, name: '' };
const record = planets.createSystemRecord();

function seedNetwork() {
	const net = trade.createNetwork({
		seed: model.seed | 0, modelSeed: model.seed | 0, timeYears: 0,
		homeX: home[0], homeY: home[1], homeZ: home[2],
	});
	const systems = trade.startSystems(net, model, field, model.milkyWay ? landmarks : null, []);
	trade.discoverNearest(net, systems, ctx, record);
	return trade.finalize(net);
}

// A port's drawn position, through the shipping dispatch — the same call
// label-layer.js's tradeRecordPosition makes for the overlay's rings.
const out = [0, 0, 0];
function drawnLyFromHome(port, starTimeMyr) {
	const ref = port.ref;
	if (ref.kind === planets.BLOCK_FIELD) {
		orbit.engineRecordPosition(out, field.x[ref.index], field.y[ref.index], field.z[ref.index],
			packed[ref.index], starTimeMyr, model);
	} else {
		const e = landmarks.ENTRIES[ref.index];
		orbit.engineLandmarkPosition(out, ref.index, e.x, e.y, e.z, e.colorIndex, starTimeMyr, model);
	}
	return Math.hypot(out[0] - home[0], out[1] - home[1], out[2] - home[2]) * trade.LY_PER_KPC;
}

function widestPairLy(ports, starTimeMyr) {
	const pos = ports.map((p) => {
		const ref = p.ref;
		const v = [0, 0, 0];
		if (ref.kind === planets.BLOCK_FIELD) {
			orbit.engineRecordPosition(v, field.x[ref.index], field.y[ref.index], field.z[ref.index],
				packed[ref.index], starTimeMyr, model);
		} else {
			const e = landmarks.ENTRIES[ref.index];
			orbit.engineLandmarkPosition(v, ref.index, e.x, e.y, e.z, e.colorIndex, starTimeMyr, model);
		}
		return v;
	});
	let widest = 0;
	for (let i = 0; i < pos.length; i++) {
		for (let j = i + 1; j < pos.length; j++) {
			widest = Math.max(widest, Math.hypot(pos[i][0] - pos[j][0], pos[i][1] - pos[j][1],
				pos[i][2] - pos[j][2]) * trade.LY_PER_KPC);
		}
	}
	return widest;
}

const net = seedNetwork();
const ports = Array.from({ length: net.portCount }, (_, i) => net.ports[i]);

console.log('The seed map, drawn: %d ports, widest pair %s ly (MAX_FOUND_LY = %d)\n',
	net.portCount, widestPairLy(ports, 0).toFixed(0), trade.MAX_FOUND_LY);

console.log('A network that never changes, drawn at the running star clock:');
console.log('  star clock   farthest port from home at');
console.log('  (Myr/s)      10 s      30 s      60 s      300 s');
for (const rate of [1, 0.3, 0.1, 0.03, 0.01, 0]) {
	const row = [10, 30, 60, 300].map((sec) => {
		let far = 0;
		for (const port of ports) far = Math.max(far, drawnLyFromHome(port, rate * sec));
		return far.toFixed(0).padStart(9);
	});
	console.log('%s  %s ly', String(rate).padStart(9), row.join(' '));
}

console.log('\nAt the app default (1 Myr/s of star time), the four seed colonies:');
for (const port of ports) {
	console.log('  %s  %s ly -> %s ly after 60 s',
		port.name.padEnd(20), drawnLyFromHome(port, 0).toFixed(0).padStart(6),
		drawnLyFromHome(port, 60).toFixed(0).padStart(6));
}

console.log('\nWhat a hull can do over the same minute: the trade clock at the default');
console.log('100 y/s of trade against the sky\'s own rotation at the Sun\'s radius');
const dyn = (model.dynamics) || {};
const vFlat = dyn.vFlat > 0 ? dyn.vFlat : 0;
const skyLyPerMyr = vFlat * trade.LY_PER_KPC;   // kpc/Myr -> ly/Myr
for (const rate of [1, 0.1, 0.01]) {
	const skyLyPerSec = skyLyPerMyr * rate;
	const hullLyPerSec = trade.HULLS[0].lyPerYear * 100;
	console.log('  star clock %s Myr/s: sky %s ly/s, bulk freighter %s ly/s  -> the sky is %sx the hull',
		String(rate).padStart(5), skyLyPerSec.toFixed(0), hullLyPerSec.toFixed(0),
		(skyLyPerSec / hullLyPerSec).toFixed(1));
}
