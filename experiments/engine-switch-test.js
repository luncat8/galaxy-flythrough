// experiments/engine-switch-test.js
// The F6 R4 engine-switch audit (formation-plan §6): an engine switch must map
// the *current* drawn azimuth into the friction field's theta state instead of
// re-seeding it from the birth positions, or every star on screen teleports by
// its whole classic orbital arc (Ω·T, unbounded in the star time) the moment
// the user ticks `simple`.
//
// The audit runs the shipping paths — StarSprites.setEngine against the
// recording mock device (the theta bytes it *would* upload), the landmark
// mirror and the tracked mirror — over a star-time ladder, and measures:
//
//   * jump_reseed  — the drawn-position delta the birth re-seed produces
//                    (the pre-R4 behaviour, computed for the record at every T)
//   * jump_shipped — the delta the shipping setEngine actually produces
//   * the law's own per-frame delta — one frame at the top star rate (99 Myr/s
//                    at 60 fps), the scale a smooth switch must stay near
//   * law-vs-law divergence — simple integrated from 0 vs classic closed form
//                    at T: the honest, irreducible part of a switch between
//                    two different laws (reported, not pinned)
//
// Pins (R4): the shipped theta equals the carried azimuth of the drawn
// position; the shipped carry lane puts every star back on the drawn radius
// and height, so a carried switch is a positional identity up to f32 (and at
// T = 0 exactly, which is what "the two laws agree at birth" means); a switch
// that does not engage simple never touches either lane; the landmark and
// tracked mirrors carry the same instant and the same frame, so labels, picks
// and trade predictions agree with the sprites.
//
// Output: experiments/logs/engine-switch.json

'use strict';

const path = require('path');
const logFile = require('./log-file.js');

// --- Browser shims (same aliases renderer-test.js uses) -------------------
globalThis.window = globalThis;
globalThis.GPUBufferUsage = { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 };
globalThis.GPUTextureUsage = { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };
globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };

require('../src/math/hash.js');
require('../src/math/density.js');
require('../src/math/galaxy.js');
require('../src/math/gas-grid.js');
require('../src/math/sampling.js');
require('../src/math/star-record.js');
require('../src/math/star-types.js');
require('../src/math/planets.js');
require('../src/math/orbit.js');
require('../src/math/nebula.js');
require('../src/math/objects.js');
require('../src/math/clusters.js');
require('../src/math/coords.js');
require('../src/data/landmarks.js');
require('../src/render/shaders.js');
require('../src/stream/tile-loader.js');
require('../src/stream/cell-manager.js');
require('../src/core/camera.js');

const rendererModule = require('../src/render/star-sprites.js');
const orbit = require('../src/math/orbit.js');
const galaxy = require('../src/math/galaxy.js');
const records = require('../src/math/star-record.js');
const loader = require('../src/stream/tile-loader.js');
const landmarks = require('../src/data/landmarks.js');
const Camera = require('../src/core/camera.js');
const createMockGpu = require('./mock-gpu.js').createMockGpu;

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
	return !!pass;
}

// The top of the star-time ladder is 99 Myr/s; one 60 fps frame is 1.65 Myr.
// That frame's own classic motion is the scale R4's pin compares against.
const TOP_RATE_MYR_S = 99;
const DT_FRAME_MYR = TOP_RATE_MYR_S / 60;

function dist3(a, b) {
	const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
	return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
function quantile(sorted, q) {
	if (!sorted.length) return 0;
	const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
	return sorted[i];
}
function stats(values) {
	const s = values.slice().sort((a, b) => a - b);
	return {
		max: s.length ? s[s.length - 1] : 0,
		p99: quantile(s, 0.99),
		median: quantile(s, 0.5),
	};
}
function azimuth(cx, cy, x, y) { return orbit.wrapAngle(Math.atan2(y - cy, x - cx)); }
// wrapAngle lands in [0, 2π), so a difference of two nearly equal azimuths
// can read as nearly 2π — the metric has to take the short way round.
function angDiff(a, b) {
	const d = Math.abs(a - b) % orbit.TAU;
	return Math.min(d, orbit.TAU - d);
}

// --- Shared model ----------------------------------------------------------
const MODEL_SEED = 7;
const model = galaxy.createGalaxy({ type: 'SBb', seed: MODEL_SEED, age: galaxy.AGE_REF });
const centre = model.centre;
const eccMax = orbit.simpleEccMax(model);
// The audit measures the engine switch, not the epoch placement: at AGE_REF
// the epoch map is the identity, so placed birth == birth for every record.
const epochIdle = !orbit.solveEpochParams(model).active;
check('the audit model is at the reference epoch (epoch map inactive, placed == birth)', epochIdle,
	{ age: model.populations.age, active: !epochIdle });

const T_LADDER = [0, 100, 500, 1000, 5000];

// ============================================================================
// Part A — the GPU theta lane: what does setEngine write, and what does the
// switch cost the drawn sky? Runs the shipping StarSprites path against the
// recording mock and decodes the theta bytes it would upload.
// ============================================================================
const gpuA = createMockGpu();
const PROCEDURAL = 6000;
const rendererA = rendererModule.createStarRenderer(gpuA.device, gpuA.context, gpuA.format, {
	proceduralStars: PROCEDURAL,
	catalogBudgetStars: 0,
	objectMembers: 2000,
	objectCount: 40,
	model,
});
rendererA.prepare(null);

// The audited slots: every resident record of the three fixed blocks.
const infoA = rendererA.starBlocks();
const slotsA = [];
for (const kind of [0, 1, 2]) {
	const block = infoA.blocks[kind];
	for (let i = 0; i < block.count; i++) {
		const slot = block.offset + i;
		const rec = records.readRecord(infoA.view, slot * records.RECORD_BYTES);
		slotsA.push({
			slot, kind, rec,
			key: infoA.identity[slot] >>> 0,
			birthR: Math.hypot(rec.x - centre.x, rec.y - centre.y),
			cluster: (rec.flags & records.FLAG_CLUSTER) !== 0,
		});
	}
}
check('the audited field covers all three fixed blocks',
	slotsA.length > 1000 && infoA.blocks[0].count > 0 && infoA.blocks[1].count > 0 && infoA.blocks[2].count > 0,
	{ field: infoA.blocks[0].count, landmarks: infoA.blocks[1].count, objects: infoA.blocks[2].count });

// The slot's placed reduction, the same one the renderer makes: cluster
// members reduce to their centre through ONE quantisation — clusterCentreCoord
// reads its lattice base off the input's own bits, so a second application
// moves the point onto a different lattice — and epoch records map to their
// placed birth (the audit pins the epoch idle, so placed == centred here).
// The parity calls run on the RAW bytes — the dispatch's own split does the
// one legitimate quantisation — and the member offset it adds back is removed
// analytically: both lanes carry it rigidly, so every measured quantity is the
// centre's, which is what the carry rule reads.
const posScratch = [0, 0, 0];
const centreScratch = [0, 0, 0];
const placeScratch = [0, 0, 0];
for (const s of slotsA) {
	const r = s.rec;
	s.cen = s.cluster
		? [orbit.clusterCentreCoord(r.x), orbit.clusterCentreCoord(r.y), orbit.clusterCentreCoord(r.z)]
		: [r.x, r.y, r.z];
	s.placed = s.cen;
	if ((r.flags & records.FLAG_EPOCH) !== 0 && !epochIdle) {
		orbit.epochMap(placeScratch, s.cen[0], s.cen[1], s.cen[2], (r.flags >> 3) & 3, r.flags, model);
		s.placed = [placeScratch[0], placeScratch[1], placeScratch[2]];
	}
	s.off = [r.x - s.cen[0], r.y - s.cen[1], r.z - s.cen[2]];
}
function drawnOf(s, time) {
	orbit.engineRecordPosition(posScratch, s.rec.x, s.rec.y, s.rec.z, s.rec.packed, time, model);
	return [posScratch[0] - s.off[0], posScratch[1] - s.off[1], posScratch[2] - s.off[2]];
}
function drawnThetaOf(s, time) {
	const p = drawnOf(s, time);
	return azimuth(centre.x, centre.y, p[0], p[1]);
}
// The birth re-seed value (what seedThetaRange writes): the azimuth of the
// placed birth position.
function reseedThetaOf(s) {
	return azimuth(centre.x, centre.y, s.placed[0], s.placed[1]);
}
function reconAt(s, theta, carry, time) {
	orbit.engineRecordPositionTheta(posScratch, s.rec.x, s.rec.y, s.rec.z, s.rec.packed, time, model, theta, carry);
	return [posScratch[0] - s.off[0], posScratch[1] - s.off[1], posScratch[2] - s.off[2]];
}

// The slot's own sweep basis — orbitPlane on the centred birth q, the basis
// the reconstruction rotates inside — and the in-plane decomposition of a
// drawn position: the angle (what the carry must land), the radius and the
// normal offset (the honest residual the two radial laws leave).
const planeScratch = { e0x: 0, e0y: 0, e0z: 0, e1x: 0, e1y: 0, e1z: 0, nx: 0, ny: 0, nz: 0, anchor: 0, carry: 0 };
for (const s of slotsA) {
	const c = s.placed;
	const orb = orbit.readOrbit(s.rec.packed);
	const pl = orbit.orbitPlane(c[0] - centre.x, c[1] - centre.y, c[2] - centre.z,
		orb.family, orb.phase, orb.amplitude, planeScratch);
	s.pl = {
		e0x: pl.e0x, e0y: pl.e0y, e0z: pl.e0z,
		e1x: pl.e1x, e1y: pl.e1y, e1z: pl.e1z,
		nx: pl.nx, ny: pl.ny, nz: pl.nz,
		anchor: pl.anchor, carry: pl.carry, family: orb.family,
	};
}
const planeProj = { d0: 0, d1: 0, n: 0 };
function projectPlane(s, p) {
	const vx = p[0] - centre.x, vy = p[1] - centre.y, vz = p[2] - centre.z - s.pl.carry;
	planeProj.d0 = vx * s.pl.e0x + vy * s.pl.e0y + vz * s.pl.e0z;
	planeProj.d1 = vx * s.pl.e1x + vy * s.pl.e1y + vz * s.pl.e1z;
	planeProj.n = vx * s.pl.nx + vy * s.pl.ny + vz * s.pl.nz;
	return planeProj;
}
// The exact residual bound of a carried switch: the reconstruction's own
// eccentric modulation of the birth anchor, plus the radial wobble the star
// already had (the two radial laws' triangle inequality), plus the classic
// normal wobble the reconstruction does not carry, plus f32 slack.
function carryBound(s, rBeforePlane, nBefore) {
	return eccMax * s.pl.anchor + Math.abs(rBeforePlane - s.pl.anchor) + Math.abs(nBefore)
		+ 1e-6 * (1 + s.pl.anchor);
}

function decodeLastThetaWrite(writes, marker) {
	const fresh = writes.slice(marker);
	if (!fresh.length) return new Float32Array(0);
	const last = fresh[fresh.length - 1];
	return new Float32Array(last.bytes.buffer, last.bytes.byteOffset, last.bytes.byteLength / 4);
}
// The carry lane's last upload, two f32 per slot (radial scale, normal offset).
function decodeLastCarryWrite(writes, marker) {
	const fresh = writes.slice(marker);
	if (!fresh.length) return new Float32Array(0);
	const last = fresh[fresh.length - 1];
	if (last.offset !== 0) return new Float32Array(0);
	return new Float32Array(last.bytes.buffer, last.bytes.byteOffset, last.bytes.byteLength / 4);
}

const ladder = [];
let landmarkThetaAt1000 = null;
let slotsByFieldKey = null;
for (const T of T_LADDER) {
	rendererA.setEngine('classic', T);
	// Everything the outgoing mask drew — positions AND the azimuths the carry
	// must reproduce — is measured while the classic mask is still current:
	// after the switch engineRecordPosition only approximates under simple.
	const before = slotsA.map((s) => drawnOf(s, T));
	const thCarryAll = slotsA.map((s) => drawnThetaOf(s, T));
	// The law's own motion in one top-rate frame at this T: the scale a
	// switch must not exceed by orders of magnitude.
	let maxLawFrame = 0;
	for (let i = 0; i < slotsA.length; i++) {
		const s = slotsA[i];
		orbit.engineRecordPosition(posScratch, s.rec.x, s.rec.y, s.rec.z, s.rec.packed, T + DT_FRAME_MYR, model);
		const d = Math.hypot(posScratch[0] - s.off[0] - before[i][0],
			posScratch[1] - s.off[1] - before[i][1], posScratch[2] - s.off[2] - before[i][2]);
		if (d > maxLawFrame) maxLawFrame = d;
	}
	const marker = gpuA.thetaWrites.length;
	const carryMarker = gpuA.carryWrites.length;
	rendererA.setEngine('simple', T);
	const thetaUploaded = decodeLastThetaWrite(gpuA.thetaWrites, marker);
	const carryUploaded = decodeLastCarryWrite(gpuA.carryWrites, carryMarker);
	const thetaErr = { carry: [], reseed: [] };
	const jumpShipped = [];
	const jumpThetaOnly = [];
	const jumpReseed = [];
	const landingErr = [];
	let boundViolations = 0;
	let boundWorstSlack = Infinity;
	for (let i = 0; i < slotsA.length; i++) {
		const s = slotsA[i];
		const thCarry = thCarryAll[i];
		const thReseed = reseedThetaOf(s);
		const thShipped = thetaUploaded.length ? thetaUploaded[s.slot] : NaN;
		const carrySlot = carryUploaded.length >= (s.slot + 1) * 2
			? [carryUploaded[s.slot * 2], carryUploaded[s.slot * 2 + 1]] : null;
		thetaErr.carry.push(angDiff(thShipped, thCarry));
		thetaErr.reseed.push(angDiff(thShipped, thReseed));
		const pb = projectPlane(s, before[i]);
		const angBefore = Math.atan2(pb.d1, pb.d0);
		const rBeforePlane = Math.hypot(pb.d0, pb.d1);
		const nBefore = pb.n;
		const afterShipped = reconAt(s, thShipped, carrySlot, T);
		const afterThetaOnly = reconAt(s, thShipped, null, T);
		const afterReseed = reconAt(s, thReseed, null, T);
		const pa = projectPlane(s, afterShipped);
		landingErr.push(angDiff(Math.atan2(pa.d1, pa.d0), angBefore));
		jumpShipped.push(dist3(afterShipped, before[i]));
		jumpThetaOnly.push(dist3(afterThetaOnly, before[i]));
		jumpReseed.push(dist3(afterReseed, before[i]));
		// The bound the carried *azimuth* alone can promise: the two radial
		// laws' excursions plus the normal the reconstruction does not carry.
		// Measured on the θ-only lane — that is the lane the bound describes.
		const slack = carryBound(s, rBeforePlane, nBefore) - dist3(afterThetaOnly, before[i]);
		if (slack < 0) boundViolations++;
		if (slack < boundWorstSlack) boundWorstSlack = slack;
	}
	const row = {
		T,
		slots: slotsA.length,
		maxLawFrameDeltaKpc: +maxLawFrame.toFixed(4),
		landingMaxErrRad: +stats(landingErr).max.toExponential(3),
		boundViolations,
		boundWorstSlackKpc: +boundWorstSlack.toFixed(4),
		shippedIsCarryAzMaxErrRad: +stats(thetaErr.carry).max.toExponential(3),
		shippedIsReseedMaxErrRad: +stats(thetaErr.reseed).max.toExponential(3),
		jumpShippedKpc: { max: +stats(jumpShipped).max.toExponential(2), p99: +stats(jumpShipped).p99.toExponential(2), median: +stats(jumpShipped).median.toExponential(2) },
		jumpThetaOnlyKpc: { max: +stats(jumpThetaOnly).max.toFixed(4), p99: +stats(jumpThetaOnly).p99.toFixed(4), median: +stats(jumpThetaOnly).median.toFixed(4) },
		jumpReseedKpc: { max: +stats(jumpReseed).max.toFixed(4), p99: +stats(jumpReseed).p99.toFixed(4), median: +stats(jumpReseed).median.toFixed(4) },
	};
	ladder.push(row);
	if (T === 1000) {
		landmarkThetaAt1000 = new Map();
		slotsByFieldKey = new Map();
		for (let i = 0; i < slotsA.length; i++) {
			const s = slotsA[i];
			if (s.kind === 1) landmarkThetaAt1000.set(s.slot - infoA.blocks[1].offset, thetaUploaded[s.slot]);
			if (s.kind === 0) slotsByFieldKey.set(s.key, {
				s, theta: thetaUploaded[s.slot], thCarry: thCarryAll[i], before: before[i],
				carry: [carryUploaded[s.slot * 2], carryUploaded[s.slot * 2 + 1]],
			});
		}
	}
}

// R4's mechanism pin: the switch lands every star on the *in-plane angle* the
// outgoing mask was drawing — for the horizontal families that is the xy
// azimuth, for the inclined bar/pressure planes the angle inside the record's
// own sweep basis (the xy azimuth is not that angle, and carrying it put
// stars on the wrong side of a tilted orbit: the measured 45 kpc worst case).
// Pre-fix this fails with the reseed's birth azimuths instead.
let landingOk = true;
let landingWorst = 0;
let boundViolationsTotal = 0;
let boundWorstSlack = Infinity;
for (const row of ladder) {
	if (!(row.landingMaxErrRad <= 1e-5)) landingOk = false;
	if (row.landingMaxErrRad > landingWorst) landingWorst = row.landingMaxErrRad;
	boundViolationsTotal += row.boundViolations;
	if (row.boundWorstSlackKpc < boundWorstSlack) boundWorstSlack = row.boundWorstSlackKpc;
}
check('R4: switching into simple lands every drawn in-plane angle (theta map, not birth re-seed)',
	landingOk && epochIdle,
	{ worstErrRad: landingWorst, ladder: ladder.map((r) => ({ T: r.T, err: r.landingMaxErrRad })) });

// The θ-only residual — what the 0.7.8 carry could promise, and the lane the
// bound below describes: the friction field's eccentric modulation of the birth
// anchor, plus the radial wobble the star already had, plus the classic normal
// wobble the reconstruction does not carry. The reseed's Ω·T teleport is
// unbounded in T; this bound is a property of the lanes, not of the clock.
check('R4: the theta-only reconstruction stays inside its own two-lane excursion bound (no teleport)',
	boundViolationsTotal === 0,
	{ violations: boundViolationsTotal, worstSlackKpc: boundWorstSlack, eccMax: +eccMax.toFixed(4) });

// 0.7.10 — the carry lane. θ alone lands the *angle*; the two lanes' radial
// laws and the classic lane's normal wobble still moved the star by up to
// 9.7 kpc. The lane's (scale, normal) is the same frame transfer measured on
// the drawn position, so what is left is the f32 rounding of two uploads and
// one projection: the switch is a positional identity to the milliparsec.
let carryLaneOk = true;
let carryWorst = 0;
let thetaOnlyWorst = 0;
for (const row of ladder) {
	if (!(row.jumpShippedKpc.max <= 1e-3)) carryLaneOk = false;
	if (row.jumpShippedKpc.max > carryWorst) carryWorst = row.jumpShippedKpc.max;
	if (row.jumpThetaOnlyKpc.max > thetaOnlyWorst) thetaOnlyWorst = row.jumpThetaOnlyKpc.max;
}
check('R4: the carry lane lands every star on the drawn position (<= 1 pc at every rung)',
	carryLaneOk,
	{ worstKpc: carryWorst, thetaOnlyWorstKpc: +thetaOnlyWorst.toFixed(3),
		ladder: ladder.map((r) => ({ T: r.T, carried: r.jumpShippedKpc.max, thetaOnly: r.jumpThetaOnlyKpc.max })) });

// T = 0 is where this is not a nicety: both laws ARE the birth field there, so
// selecting the friction field at first light must not move a single star. The
// θ-only lane failed that by the reconstruction's own eccentric radius (4.8 kpc
// worst on this model) — the carry is the fix, and this is its regression.
check('at T = 0 the carried switch is a positional identity (no star moves at first light)',
	ladder[0].jumpShippedKpc.max <= 1e-3 && ladder[0].jumpThetaOnlyKpc.max > 1,
	{ carriedKpc: ladder[0].jumpShippedKpc.max, thetaOnlyKpc: ladder[0].jumpThetaOnlyKpc.max });

// The reseed comparison, for the record: at every T > 0 the carried jump must
// be a small fraction of the birth re-seed's.
let improvementOk = true;
const improvements = [];
for (const row of ladder) {
	if (row.T === 0) continue;
	const factor = row.jumpReseedKpc.max > 0 ? row.jumpShippedKpc.max / row.jumpReseedKpc.max : 0;
	improvements.push({ T: row.T, factor: +factor.toFixed(4) });
	if (!(factor <= 0.34)) improvementOk = false;
}
check('R4: at T > 0 the carry beats the birth re-seed by more than 3x on the worst star',
	improvementOk, { improvements, lawFrameKpc: ladder.map((r) => r.maxLawFrameDeltaKpc) });

// T = 0 is the fixed point of both rules: carried == reseed == birth azimuth.
check('at T = 0 the carried seed and the birth seed agree (no boot-behaviour change)',
	ladder[0].shippedIsCarryAzMaxErrRad <= 1e-5 && ladder[0].shippedIsReseedMaxErrRad <= 1e-5,
	{ carryErr: ladder[0].shippedIsCarryAzMaxErrRad, reseedErr: ladder[0].shippedIsReseedMaxErrRad });

// A switch that does not engage simple must not touch the theta state at all:
// the buffer is current while simple runs, and unused while it does not.
{
	rendererA.setEngine('simple', 5000);
	const markerSimple = gpuA.thetaWrites.length;
	const carryMarkerSimple = gpuA.carryWrites.length;
	rendererA.setEngine(['simple', 'apocenter'], 5000);
	const keptOnMaskGrow = gpuA.thetaWrites.length === markerSimple && gpuA.carryWrites.length === carryMarkerSimple;
	rendererA.setEngine('classic', 5000);
	const keptOnLeave = gpuA.thetaWrites.length === markerSimple && gpuA.carryWrites.length === carryMarkerSimple;
	check('R4: a switch that keeps or leaves simple never re-writes the theta or carry lane',
		keptOnMaskGrow && keptOnLeave,
		{ writesAfterGrow: gpuA.thetaWrites.length - markerSimple, carryWrites: gpuA.carryWrites.length - carryMarkerSimple, keptOnLeave });
}

// The lane's other end: a field seeded from birth (boot, regenerate, R) carries
// the identity — unit radial scale, no normal offset — so the reconstruction is
// the birth law and nothing about boot changes.
{
	const seeded = gpuA.carryWrites.length ? gpuA.carryWrites[gpuA.carryWrites.length - 1] : null;
	rendererA.resetSimpleState();
	const fresh = gpuA.carryWrites[gpuA.carryWrites.length - 1];
	const pair = fresh ? new Float32Array(fresh.bytes.buffer, fresh.bytes.byteOffset, fresh.bytes.byteLength / 4) : new Float32Array(0);
	let identityOk = pair.length > 0;
	for (let i = 0; i < pair.length; i += 2) {
		if (pair[i] !== 1 || pair[i + 1] !== 0) identityOk = false;
	}
	check('a birth-seeded field carries the identity lane (unit scale, no normal offset)',
		identityOk, { pairs: pair.length / 2, seededPairs: seeded ? seeded.bytes.byteLength / 8 : 0 });
}

// Law-vs-law divergence, reported not pinned: a field run under simple from
// T = 0 against the classic closed form at T. This is the honest, physical
// part of a switch — two different laws — and the carry cannot remove it.
const divergence = (() => {
	const sample = slotsA.filter((s) => s.kind === 0 && !s.cluster && s.birthR > 1 && s.birthR < 15).slice(0, 200);
	orbit.setEngine(orbit.ENGINE_CLASSIC);
	orbit.simpleTrackReset(model, 0);
	const tracked = [];
	for (const s of sample) {
		const slot = orbit.simpleTrackStar(s.key, s.rec.x, s.rec.y, s.rec.z, s.rec.packed, model, 0);
		if (slot >= 0) tracked.push({ s, slot });
	}
	const rows = [];
	for (const T of [100, 500, 1000, 5000]) {
		while (orbit.simpleTrackTime() < T) {
			orbit.simpleTrackStep(Math.min(DT_FRAME_MYR, T - orbit.simpleTrackTime()), Math.min(T, orbit.simpleTrackTime() + DT_FRAME_MYR));
		}
		const deltas = [];
		for (const t of tracked) {
			const th = orbit.simpleTrackTheta(t.slot);
			const classicAz = drawnThetaOf(t.s, T);
			deltas.push(angDiff(th, classicAz) * t.s.birthR);
		}
		rows.push({ T, maxKpc: +stats(deltas).max.toFixed(3), medianKpc: +stats(deltas).median.toFixed(3), tracked: tracked.length });
	}
	orbit.simpleTrackReset(model, 0);
	return rows;
})();

// ============================================================================
// Part B — the landmark mirror: labels and picks must carry the same instant
// the GPU theta does, anchored on the birth table so mirror and sprites keep
// integrating at the same rate (no label drift).
// ============================================================================
const lmBirth = new Float32Array(landmarks.count * 3);
const lmColors = new Uint8Array(landmarks.count);
for (let i = 0; i < landmarks.count; i++) {
	lmBirth[i * 3] = landmarks.ENTRIES[i].x;
	lmBirth[i * 3 + 1] = landmarks.ENTRIES[i].y;
	lmBirth[i * 3 + 2] = landmarks.ENTRIES[i].z;
	lmColors[i] = landmarks.ENTRIES[i].colorIndex;
}
const T_B = 1000;
orbit.setEngine(orbit.ENGINE_CLASSIC);
const lmDrawn = new Float32Array(landmarks.count * 3);
for (let i = 0; i < landmarks.count; i++) {
	const e = landmarks.ENTRIES[i];
	orbit.engineLandmarkPosition(posScratch, i, e.x, e.y, e.z, e.colorIndex, T_B, model);
	lmDrawn[i * 3] = posScratch[0]; lmDrawn[i * 3 + 1] = posScratch[1]; lmDrawn[i * 3 + 2] = posScratch[2];
}
// The legacy switch (init from the birth table at T): what labels did before.
orbit.simpleLandmarksInit(lmBirth, lmColors, landmarks.count, model, T_B);
const lmJumpOld = [];
for (let i = 0; i < landmarks.count; i++) {
	orbit.simpleLandmarkPosition(posScratch, i);
	lmJumpOld.push(dist3(posScratch, [lmDrawn[i * 3], lmDrawn[i * 3 + 1], lmDrawn[i * 3 + 2]]));
}
const hasCarryFrom = typeof orbit.simpleLandmarksCarryFrom === 'function';
check('R4: orbit.simpleLandmarksCarryFrom exists (the mirror carries drawn azimuths on birth anchors)', hasCarryFrom);
let lmCarryOk = hasCarryFrom;
const lmJumpCarry = [];
const lmThetaErr = [];
if (hasCarryFrom) {
	orbit.simpleLandmarksInit(lmBirth, lmColors, landmarks.count, model, 0);
	const carried = orbit.simpleLandmarksCarryFrom(lmDrawn, landmarks.count, model, T_B);
	lmCarryOk = carried === landmarks.count && orbit.simpleLandmarkTime() === T_B;
	for (let i = 0; i < landmarks.count; i++) {
		orbit.simpleLandmarkPosition(posScratch, i);
		lmJumpCarry.push(dist3(posScratch, [lmDrawn[i * 3], lmDrawn[i * 3 + 1], lmDrawn[i * 3 + 2]]));
		// The mirror's theta must equal the GPU landmark slot's carried theta
		// (Part A, T = 1000) — labels ride exactly what the sprites draw.
		const gpuTheta = landmarkThetaAt1000 ? landmarkThetaAt1000.get(i) : NaN;
		lmThetaErr.push(angDiff(orbit.simpleLandmarkTheta(i), gpuTheta));
	}
}
// The mirror and the renderer evaluate the same rule on the same drawn
// positions, so the mirror is exact — and it is on the *drawn* sky, not merely
// inside the radial bound the θ-only carry could promise.
const lmExactOk = stats(lmJumpCarry).max <= 1e-9;
check('R4: the carried landmark mirror lands on the drawn sky and keeps the GPU theta',
	lmCarryOk && lmExactOk && stats(lmJumpCarry).max <= stats(lmJumpOld).max
	&& stats(lmThetaErr).max <= 1e-5,
	{
		jumpOldKpc: { max: +stats(lmJumpOld).max.toFixed(3), median: +stats(lmJumpOld).median.toFixed(3) },
		jumpCarryKpc: { max: +stats(lmJumpCarry).max.toFixed(3), median: +stats(lmJumpCarry).median.toFixed(3) },
		gpuThetaMaxErrRad: +stats(lmThetaErr).max.toExponential(3),
	});
// The mirror reconstructs through the vertex stage's own function on the
// birth anchor: same theta, same radius law, same carried frame — no
// label/sprite drift.
{
	let driftOk = true;
	const mirrorCarry = [0, 0];
	for (let i = 0; i < landmarks.count; i++) {
		const e = landmarks.ENTRIES[i];
		orbit.simpleLandmarkPosition(posScratch, i);
		const mirror = [posScratch[0], posScratch[1], posScratch[2]];
		// The mirror stores the f32 birth table (main.js keeps it in a
		// Float32Array), so the vertex-side comparison reads the same rounded
		// bytes — an f64 birth here would differ by the rounding alone.
		orbit.simpleLandmarkCarry(i, mirrorCarry);
		orbit.simplePositionFromTheta(centreScratch, orbit.simpleLandmarkTheta(i),
			lmBirth[i * 3], lmBirth[i * 3 + 1], lmBirth[i * 3 + 2],
			0, orbit.familyFromColorIndex(e.colorIndex), eccMax, model, mirrorCarry);
		if (dist3(mirror, centreScratch) > 1e-9) driftOk = false;
	}
	check('the carried mirror reconstructs identically to the vertex stage on the birth anchor (no drift)',
		driftOk && hasCarryFrom);
}

// ============================================================================
// Part C — the tracked mirror (trade-plan §9.5): a record tracked after a
// carried switch must seed from the carried azimuth at the switch instant —
// the same number the GPU theta buffer holds — or every booking would aim at
// a star the sky does not show.
// ============================================================================
{
	// The expected seed is the theta Part A captured the GPU uploading at
	// T = 1000 — the tracked mirror must start on exactly that number.
	orbit.setEngine(orbit.ENGINE_CLASSIC);
	orbit.simpleTrackReset(model, T_B, orbit.ENGINE_CLASSIC);
	const sample = Array.from(slotsByFieldKey.values()).filter((e) => !e.s.cluster && e.s.birthR > 1).slice(0, 300);
	const seedErr = [];
	for (const e of sample) {
		const slot = orbit.simpleTrackStar(e.s.key, e.s.rec.x, e.s.rec.y, e.s.rec.z, e.s.rec.packed, model, T_B);
		if (slot < 0) continue;
		seedErr.push(angDiff(orbit.simpleTrackTheta(slot), e.theta));
	}
	check('R4: tracks seeded after a carried switch start on the carried azimuth (== the GPU theta)',
		seedErr.length > 100 && stats(seedErr).max <= 1e-5,
		{ tracked: seedErr.length, maxErrRad: +stats(seedErr).max.toExponential(3) });

	// The mirror carries the whole frame, not just the azimuth: its (scale,
	// normal) is the lane the renderer uploaded for that record, and the record
	// reconstructed from it lands on the drawn position — so a trade booking
	// aims at the star the sky shows, which is the §9.5 contract.
	const carryErr = [];
	const seedJump = [];
	const pair = [1, 0];
	const landed = [0, 0, 0];
	for (const e of sample) {
		const slot = orbit.simpleTrackSlotOf(e.s.key);
		if (slot < 0) continue;
		orbit.simpleTrackCarry(slot, pair);
		carryErr.push(Math.abs(pair[0] - e.carry[0]));
		carryErr.push(Math.abs(pair[1] - e.carry[1]));
		orbit.engineRecordPositionTheta(landed, e.s.rec.x, e.s.rec.y, e.s.rec.z, e.s.rec.packed,
			T_B, model, orbit.simpleTrackTheta(slot), pair);
		seedJump.push(dist3(landed, e.before));
	}
	check('R4: a track seeded by the carry reconstructs the drawn position (scale, normal and azimuth)',
		seedJump.length > 100 && stats(seedJump).max <= 1e-6 && stats(carryErr).max <= 1e-6,
		{ tracks: seedJump.length, worstJumpKpc: +stats(seedJump).max.toExponential(2),
			worstCarryErr: +stats(carryErr).max.toExponential(2) });
	// A late track catches up to the same instant: seeded at T + dt after one
	// mirror step, it must equal a track seeded at T and stepped (same law,
	// same clock — the chunked catch-up against the lockstep step).
	const lateErr = [];
	orbit.simpleTrackStep(DT_FRAME_MYR, T_B + DT_FRAME_MYR);
	const tLate = T_B + DT_FRAME_MYR;
	for (const e of sample.slice(0, 60)) {
		const keyLate = (e.s.key ^ 0x5eed) >>> 0;
		const slotLate = orbit.simpleTrackStar(keyLate, e.s.rec.x, e.s.rec.y, e.s.rec.z, e.s.rec.packed, model, tLate);
		const slotEarly = orbit.simpleTrackSlotOf(e.s.key);
		if (slotLate < 0 || slotEarly < 0) continue;
		// The early track stepped; the late track caught up from the same
		// carried seed. Both answer for tLate — but they are different keys on
		// the same record bytes, so compare the late catch-up against a fresh
		// prediction of the early track at tLate.
		const predicted = orbit.simpleTrackThetaAt(slotEarly, tLate);
		lateErr.push(angDiff(orbit.simpleTrackTheta(slotLate), predicted));
	}
	check('R4: a record tracked one frame late catches up to the stepped mirror (chunked == lockstep)',
		lateErr.length > 20 && stats(lateErr).max <= 1e-9,
		{ pairs: lateErr.length, maxErrRad: +stats(lateErr).max.toExponential(3) });
	orbit.simpleTrackReset(model, 0);
}

// ============================================================================
// Part D — the streaming blocks: local gap-fill and catalog records live on
// the observed sky (no epoch bits) and move under the classic law like every
// other record; a carried switch must map their drawn azimuths too.
// ============================================================================
{
	const mwModel = galaxy.createGalaxy({ type: 'SBb', seed: 42, age: galaxy.AGE_REF });
	const bundle = require('../src/data/tiles/catalog.js');
	const manifest = loader.prepareBundle(bundle);
	const gpuD = createMockGpu();
	const rendererD = rendererModule.createStarRenderer(gpuD.device, gpuD.context, gpuD.format, {
		proceduralStars: 4000,
		catalogBudgetStars: 30000,
		objectMembers: 0,
		objectCount: 0,
		gasGrid: false,
		model: mwModel,
	});
	rendererD.prepare(manifest);
	const cam = Camera.createCamera();
	cam.setFrame(mwModel);
	cam.cameraPos[0] = 0; cam.cameraPos[1] = 0; cam.cameraPos[2] = 0;
	const T_D = 1000;
	rendererD.setEngine('classic', T_D);
	rendererD.render(cam, 64, 64, T_D, null, 0);
	const infoD = rendererD.starBlocks();
	const cD = mwModel.centre;
	const streamSlots = [];
	for (const kind of [3, 4]) {
		const block = infoD.blocks[kind];
		for (let i = 0; i < block.count; i++) {
			const slot = block.offset + i;
			const rec = records.readRecord(infoD.view, slot * records.RECORD_BYTES);
			streamSlots.push({ slot, kind, rec });
		}
	}
	check('the streaming audit has nonzero local and catalog blocks resident',
		infoD.blocks[3].count > 0 && infoD.blocks[4].count > 0,
		{ local: infoD.blocks[3].count, catalog: infoD.blocks[4].count });
	// The expected carried thetas, measured under the outgoing classic mask
	// before the switch commits the new one, through the one shared carry rule
	// (for the observed sky's horizontal families it is the drawn azimuth).
	const streamDrawn = streamSlots.map((s) => {
		orbit.engineRecordPosition(posScratch, s.rec.x, s.rec.y, s.rec.z, s.rec.packed, T_D, mwModel);
		return [posScratch[0], posScratch[1], posScratch[2]];
	});
	const thCarryD = streamSlots.map((s, i) => orbit.simpleCarryTheta(
		s.rec.x - cD.x, s.rec.y - cD.y, s.rec.z - cD.z,
		streamDrawn[i][0], streamDrawn[i][1], streamDrawn[i][2], s.rec.packed, mwModel));
	const marker = gpuD.thetaWrites.length;
	const carryMarkerD = gpuD.carryWrites.length;
	rendererD.setEngine('simple', T_D);
	const thetaD = decodeLastThetaWrite(gpuD.thetaWrites, marker);
	const carryD = decodeLastCarryWrite(gpuD.carryWrites, carryMarkerD);
	const carryErrD = [];
	for (let i = 0; i < streamSlots.length; i++) {
		carryErrD.push(angDiff(thetaD[streamSlots[i].slot], thCarryD[i]));
	}
	check('R4: local and catalog slots carry their drawn azimuths on the switch too',
		carryErrD.length > 0 && stats(carryErrD).max <= 1e-5,
		{ slots: carryErrD.length, maxErrRad: +stats(carryErrD).max.toExponential(3) });
	// And their frame: the streaming blocks are drawn by the same lane, so a
	// switch must not leave the observed sky a few kpc off its own stars.
	const streamJump = [];
	const streamPos = [0, 0, 0];
	for (let i = 0; i < streamSlots.length; i++) {
		const s = streamSlots[i];
		const frame = [carryD[s.slot * 2], carryD[s.slot * 2 + 1]];
		orbit.engineRecordPositionTheta(streamPos, s.rec.x, s.rec.y, s.rec.z, s.rec.packed,
			T_D, mwModel, thetaD[s.slot], frame);
		streamJump.push(dist3(streamPos, streamDrawn[i]));
	}
	check('R4: local and catalog slots carry the radial scale and normal offset as well',
		streamJump.length > 0 && stats(streamJump).max <= 1e-3,
		{ slots: streamJump.length, worstKpc: +stats(streamJump).max.toExponential(2) });
	rendererD.dispose();
}

// --- Report ---------------------------------------------------------------
orbit.setEngine(orbit.ENGINE_CLASSIC);
rendererA.dispose();

let passed = 0;
let failed = 0;
for (const c of checks) {
	if (c.pass) passed++; else failed++;
	console.log(`  ${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.pass ? '' : `  -> ${JSON.stringify(c.detail)}`}`);
}
console.log('\n--- R4 ladder (fixed blocks, kpc) ---');
for (const row of ladder) {
	console.log(`  T=${String(row.T).padStart(4)} Myr · law frame ${row.maxLawFrameDeltaKpc.toFixed(4)}`
		+ ` · carried max ${row.jumpShippedKpc.max.toExponential(2)} (med ${row.jumpShippedKpc.median.toExponential(2)})`
		+ ` · theta-only max ${row.jumpThetaOnlyKpc.max.toFixed(3)}`
		+ ` · reseed max ${row.jumpReseedKpc.max.toFixed(3)} (med ${row.jumpReseedKpc.median.toFixed(3)})`
		+ ` · landing err ${row.landingMaxErrRad.toExponential(1)} rad · bound slack ${row.boundWorstSlackKpc.toFixed(3)}`);
}
console.log('--- law-vs-law divergence (simple from 0 vs classic at T) ---');
for (const row of divergence) {
	console.log(`  T=${String(row.T).padStart(4)} Myr · max ${row.maxKpc.toFixed(3)} kpc · median ${row.medianKpc.toFixed(3)} kpc`);
}
console.log(`\n${passed}/${checks.length} passed, ${failed} failed`);

logFile.writeLog(path.join(__dirname, 'logs', 'engine-switch.json'), {
	date: new Date().toISOString(),
	model: { type: 'SBb', seed: MODEL_SEED, age: galaxy.AGE_REF, eccMax },
	topRateMyrPerS: TOP_RATE_MYR_S,
	dtFrameMyr: DT_FRAME_MYR,
	ladder,
	divergence,
	landmarks: {
		T: T_B,
		jumpOldKpc: { max: +stats(lmJumpOld).max.toFixed(4), median: +stats(lmJumpOld).median.toFixed(4) },
		jumpCarryKpc: { max: +stats(lmJumpCarry).max.toFixed(4), median: +stats(lmJumpCarry).median.toFixed(4) },
		gpuThetaMaxErrRad: +stats(lmThetaErr).max.toExponential(3),
	},
	totalChecks: checks.length,
	passed,
	failed,
	checks,
});

console.log('\n=== VERDICT ===');
console.log(failed === 0 ? 'PASS — the engine switch carries the drawn sky into the new frame' : `FAIL — ${failed} checks failed`);
process.exit(failed === 0 ? 0 : 1);
