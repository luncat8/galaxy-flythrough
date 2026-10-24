// experiments/wgsl-exec-check.js
// Runs the shipping WGSL on the CPU and checks what it actually computes.
//
// Nothing else in this repo can execute a shader: no browser here, and
// wgsl-validate.js only reads the text. That leaves the one claim the HDR
// frame is built on unverified — that a sprite emits linear radiance and that
// the tonemap pass turns N overlapping sprites into a brighter pixel than one.
// This script closes that gap by interpreting src/render/shaders.js directly.
//
// Needs one dev-only dependency, which is why it is not part of `all-tests`:
//
//	npm install wgsl_reflect        # at the repo root
//	python3 scripts/run.py wgsl-exec
//
// Output: experiments/logs/wgsl-exec.json

'use strict';

const path = require('path');
const logFile = require('./log-file.js');

globalThis.window = globalThis;
require('../src/math/star-record.js');
require('../src/math/gas-grid.js');
require('../src/render/shaders.js');

const records = require('../src/math/star-record.js');
const shaders = require('../src/render/shaders.js');
const orbit = require('../src/math/orbit.js');
const galaxy = require('../src/math/galaxy.js');
const mirrorLib = require('./tonemap-mirror.js');

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
	return !!pass;
}

function report(verdict) {
	let passed = 0;
	let failed = 0;
	for (const c of checks) {
		if (c.pass) passed++; else failed++;
		console.log(`  ${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.pass ? '' : `  -> ${JSON.stringify(c.detail)}`}`);
	}
	console.log(`\n${passed}/${checks.length} passed, ${failed} failed`);
	const logPath = path.join(__dirname, 'logs', 'wgsl-exec.json');
	logFile.writeLog(logPath, {
		date: new Date().toISOString(),
		interpreter: 'wgsl_reflect',
		totalChecks: checks.length,
		passed,
		failed,
		checks,
	});
	console.log('\n=== VERDICT ===');
	console.log(failed === 0 ? `PASS — ${verdict}` : `FAIL — ${failed} checks failed`);
	process.exit(failed === 0 ? 0 : 1);
}

async function main() {
	let lib = null;
	try {
		lib = await import('wgsl_reflect/wgsl_reflect.module.js');
	} catch (err) {
		console.error('wgsl_reflect is not installed. Run `npm install wgsl_reflect` at the repo root.');
		console.error(`(import failed with: ${err.message})`);
		process.exit(2);
	}
	const { WgslReflect, WgslDebug } = lib;

	// --- 1. Every shipped module parses ----------------------------------
	for (const [name, code] of Object.entries(shaders.SHADERS)) {
		let error = null;
		try {
			new WgslReflect(code);
		} catch (err) {
			error = err.message;
		}
		check(`${name}: the shipped source parses as WGSL`, error === null, error);
	}

	// --- Fixtures --------------------------------------------------------
	// Three stars, one camera at the origin. The bright G dwarf 100 pc away is
	// ~2 magnitudes brighter than the reference exposure and shows the flux
	// formula; the faint M dwarf 200 pc away is sub-pixel and shows the fade.
	// Slot 1 is the bright star behind the camera. Absolute magnitudes go
	// through the packed byte the shader reads, so expectations decode the
	// same way.
	const MAG_ZERO = 12.0;
	const BASE_SIZE_PX = 1.3;
	const MAX_SIZE_PX = 14.0;
	const STARS = [
		{ z: -0.1, absMag: 4.83, colorIndex: 4 },    // G dwarf, 100 pc
		{ z: 0.1, absMag: 4.83, colorIndex: 4 },     // same star, behind the camera
		{ z: -0.2, absMag: 12.0, colorIndex: 6 },    // M dwarf, 200 pc, sub-pixel
	];
	const starBytes = new ArrayBuffer(STARS.length * records.RECORD_BYTES);
	const starF = new Float32Array(starBytes);
	const starU = new Uint32Array(starBytes);
	STARS.forEach((star, i) => {
		starF[i * 4] = 0;
		starF[i * 4 + 1] = 0;
		starF[i * 4 + 2] = star.z;
		starU[i * 4 + 3] = (records.FLAG_VISIBLE << 16) | (records.encodeAbsMag(star.absMag) << 8) | star.colorIndex;
	});
	const brightMag = records.decodeAbsMag(starU[3] >>> 8);
	const faintMag = records.decodeAbsMag(starU[11] >>> 8);
	const fluxAt = (absMag, distKpc) => Math.pow(2, -0.4 * Math.log2(10)
		* ((absMag + 5 * Math.log10(distKpc * 1000) - 5) - MAG_ZERO));
	// A sprite under 1 px fades by area ratio instead of shrinking further, so
	// what it deposits is the flux times that fade — the model carries it too.
	const fadeAt = (magDiff) => {
		const sizePx = BASE_SIZE_PX * Math.min(2.2, Math.max(0.4, 1 - 0.4 * magDiff));
		return sizePx < 1 ? Math.min(Math.max(sizePx / 0.8, 0.25), 1) : 1;
	};
	const emitted = (absMag, distKpc) => {
		const magDiff = (absMag + 5 * Math.log10(distKpc * 1000) - 5) - MAG_ZERO;
		return fluxAt(absMag, distKpc) * fadeAt(magDiff);
	};

	// x' = x, y' = y, w' = -z: a star on -Z projects to the viewport centre.
	const viewProj = new Float32Array(16);
	viewProj[0] = 1; viewProj[5] = 1; viewProj[11] = -1; viewProj[14] = 1;
	// 224 bytes: camera block + orbit/engine/epoch lanes + formation (age,
	// fade, global field count). The formation count stays zero for radiance
	// fixtures unless a birth-gate row explicitly enables it.
	const cameraBytes = new ArrayBuffer(56 * 4);
	const cam = new Float32Array(cameraBytes);
	cam.set(viewProj, 0);
	cam[20] = 1920; cam[21] = 1080; cam[22] = 2 / 1920; cam[23] = 2 / 1080;
	cam[24] = MAG_ZERO; cam[25] = BASE_SIZE_PX; cam[26] = MAX_SIZE_PX; cam[27] = 0;
	// The simple-engine azimuth array the renderer always binds (binding 3).
	// Non-simple masks never read it, but the simple fixtures below step and
	// reconstruct through it.
	const thetaBytes = new ArrayBuffer(64 * 4);
	const birthBytes = new ArrayBuffer(64 * 4);

	// The real LUT the renderer uploads. WgslDebug's textureLoad returns the
	// stored texel as bytes/255 (the GPU's -srgb format linearises on sample,
	// which an interpreter has no display to do); the check is self-consistent.
	const lut = records.buildColorLUT();
	const lutRgb = [lut[4 * 4] / 255, lut[4 * 4 + 1] / 255, lut[4 * 4 + 2] / 255];

	const spriteBinds = {
		0: {
			0: { uniform: cameraBytes },
			1: starBytes,
			2: { texture: lut, descriptor: { size: [256, 1], format: 'rgba8unorm' } },
			3: thetaBytes,
			4: birthBytes,
		},
	};

	const spriteCode = shaders.SHADERS['star-sprite'];

	function runStage(code, entry, stage, inputs, binds) {
		const dbg = new WgslDebug(code);
		if (!dbg[stage](entry, inputs, binds)) throw new Error(`${stage} setup failed for ${entry}`);
		let steps = 0;
		while (dbg.stepNext() && steps < 1e6) steps++;
		return dbg.getReturnValue ? dbg.getReturnValue() : dbg._returnValue;
	}

	// --- 2. The sprite emits linear radiance ------------------------------
	const vertex = runStage(spriteCode, 'vs_main', 'debugVertex',
		{ vertex_index: 3, instance_index: 0 }, spriteBinds);
	const expectedFlux = emitted(brightMag, 0.1);
	check('the vertex stage reports the flux the magnitude formula predicts',
		Math.abs(vertex.brightness - expectedFlux) / expectedFlux < 1e-5,
		{ wgsl: vertex.brightness, model: expectedFlux, absMag: brightMag });
	check('that flux is far above 1.0 — the sprite is not pre-clipped to the display range',
		vertex.brightness > 4, vertex.brightness);

	const fragment = runStage(spriteCode, 'fs_main', 'debugFragment',
		{ 0: [0, 0], 1: vertex.color, 2: vertex.brightness }, spriteBinds);
	const centre = vertex.brightness;   // falloff is 1 at the disc centre
	check('the fragment emits the full linear radiance at the disc centre',
		Math.abs(fragment[0] - centre * lutRgb[0]) / (centre * lutRgb[0]) < 1e-4,
		{ wgsl: fragment[0], expected: centre * lutRgb[0] });
	check('and tints it with the spectral colour from the LUT',
		Math.abs(vertex.color[0] - lutRgb[0]) < 1e-3 && Math.abs(vertex.color[2] - lutRgb[2]) < 1e-3,
		{ shader: vertex.color, lut: lutRgb });
	check('and writes the same flux to alpha — premultiplied additive, summed in all four channels',
		Math.abs(fragment[3] - centre) / centre < 1e-4, fragment[3]);

	const behind = runStage(spriteCode, 'vs_main', 'debugVertex',
		{ vertex_index: 3, instance_index: 1 }, spriteBinds);
	check('a star behind the camera contributes zero radiance', behind.brightness === 0, behind);

	// The field's birth gate is the same smoothstep used by the CPU picker.
	const birthView = new Float32Array(birthBytes);
	birthView[0] = 2;
	cam[52] = 2;
	cam[53] = orbit.BIRTH_FADE_GYR;
	cam[54] = 1;
	const beforeBirth = runStage(spriteCode, 'vs_main', 'debugVertex',
		{ vertex_index: 3, instance_index: 0 }, spriteBinds);
	cam[52] = 2 + orbit.BIRTH_FADE_GYR * 0.5;
	const duringBirth = runStage(spriteCode, 'vs_main', 'debugVertex',
		{ vertex_index: 3, instance_index: 0 }, spriteBinds);
	cam[52] = 2 + orbit.BIRTH_FADE_GYR;
	const afterBirth = runStage(spriteCode, 'vs_main', 'debugVertex',
		{ vertex_index: 3, instance_index: 0 }, spriteBinds);
	const gateMid = orbit.gateAt(2, cam[52] - orbit.BIRTH_FADE_GYR * 0.5);
	check('WGSL birth gate is hidden, half-lit and fully present at the three fade boundaries',
		beforeBirth.brightness === 0
		&& Math.abs(duringBirth.brightness - expectedFlux * orbit.gateAt(2, 2 + orbit.BIRTH_FADE_GYR * 0.5))
			/ expectedFlux < 1e-5
		&& Math.abs(afterBirth.brightness - expectedFlux) / expectedFlux < 1e-5
		&& gateMid > 0.49 && gateMid < 0.51,
		{ before: beforeBirth.brightness, during: duringBirth.brightness,
			after: afterBirth.brightness, cpuMid: gateMid });
	cam[54] = 0;

	// --- 2b. The orbit law runs on the shipping WGSL ----------------------
	// Plan §8: a solar-circle fixture through vs_main. The Sun sits at the
	// world origin, the model centre at x = 8.178 (R = 8.178 kpc, outside
	// R_CR = 5.49 — a differential disc orbit), Milky Way dynamics in
	// dynA/dynB, identity viewProj and the camera 5 kpc up +Y, so clip.xy is
	// (moved.x, moved.y − 5) plus the same sub-pixel corner offset in both
	// runs. Half a period later the star must be at x ≈ 8.178 + 8.178.
	// 224 bytes, matching CameraUniform. waveA/waveB stay 0 and the epoch lane
	// stays (0, 1, 1, 0) — the map's identity — so the fixtures below are the
	// same laws as before E4 for a record that carries no epoch bit. This fixture
	// measures the undamped 0.4.3 law (damping 0 is the shear, bit for bit).
	// The engine lane carries the classic MASK BIT — the dispatch's identity
	// baseline (mask 0) is reserved for the radiance fixtures; the simple and
	// apocenter passes get their own fixtures in 2e/2f/2h below.
	const orbitCamBytes = new ArrayBuffer(56 * 4);
	const ocam = new Float32Array(orbitCamBytes);
	ocam[0] = 1; ocam[5] = 1; ocam[10] = 1; ocam[15] = 1;   // identity viewProj
	ocam[17] = 5;                                           // camera y
	ocam[19] = 8.178;                                       // model centre x
	ocam[20] = 1920; ocam[21] = 1080; ocam[22] = 2 / 1920; ocam[23] = 2 / 1080;
	ocam[24] = MAG_ZERO; ocam[25] = BASE_SIZE_PX; ocam[26] = MAX_SIZE_PX;
	ocam[28] = 0.225; ocam[29] = 0.5; ocam[30] = 0.041; ocam[31] = 0;      // dynA
	ocam[32] = 0.031; ocam[33] = 0.45; ocam[34] = 3; ocam[35] = 0;         // dynB
	ocam[44] = orbit.ENGINE_CLASSIC;                                        // engine mask

	const sunBytes = new ArrayBuffer(records.RECORD_BYTES);
	const sunF = new Float32Array(sunBytes);
	const sunU = new Uint32Array(sunBytes);
	sunF[0] = 0; sunF[1] = 0; sunF[2] = 0;
	// family disc = 1 lands in flags bits 3-4 → packed word bits 19-20.
	sunU[3] = (records.FLAG_VISIBLE | (1 << 3)) << 16
		| (records.encodeAbsMag(4.83) << 8) | 4;
	const sunBinds = {
		0: {
			0: { uniform: orbitCamBytes },
			1: sunBytes,
			2: { texture: lut, descriptor: { size: [256, 1], format: 'rgba8unorm' } },
			3: thetaBytes,
			4: birthBytes,
		},
	};
	const sunOmega = 0.225 / 8.178;
	const tHalf = Math.PI / sunOmega;

	ocam[27] = 0;
	const sunAt0 = runStage(spriteCode, 'vs_main', 'debugVertex',
		{ vertex_index: 3, instance_index: 0 }, sunBinds);
	// The quad's own corner offset: vertex 3 → corner (+1, +1) at the 0.8 px
	// floor, in clip units with w' = 1.
	const offX = (0.8 * 0.5) * (2 / 1920);
	const offY = (0.8 * 0.5) * (2 / 1080);
	check('on-WGSL: at T = 0 the solar-circle star is exactly at the origin (identity rule)',
		Math.abs(sunAt0.clipPos[0] - offX) < 1e-4 && Math.abs(sunAt0.clipPos[1] - (-5 + offY)) < 1e-4,
		{ clip: Array.from(sunAt0.clipPos), off: [offX, offY] });

	ocam[27] = tHalf;
	const sunAtHalf = runStage(spriteCode, 'vs_main', 'debugVertex',
		{ vertex_index: 3, instance_index: 0 }, sunBinds);
	const expectedX = 8.178 + 8.178;
	check(`on-WGSL: after half a period (${tHalf.toFixed(1)} Myr) the star sits at x ≈ 16.356`,
		Math.abs(sunAtHalf.clipPos[0] - expectedX) < 0.3
		&& Math.abs(sunAtHalf.clipPos[1] + 5) < 0.3,
		{ clip: Array.from(sunAtHalf.clipPos), expected: [expectedX, -5] });
	// A frozen or wrongly-locked law would keep it near x = 0 — the check
	// above is only meaningful if that alternative is visibly far away.
	check('the half-period position discriminates a frozen orbit (far from T = 0)',
		Math.abs(sunAtHalf.clipPos[0] - sunAt0.clipPos[0]) > 10,
		{ dx: sunAtHalf.clipPos[0] - sunAt0.clipPos[0] });

	// --- 2c. The bar's x1 loop runs on the shipping WGSL -------------------
	// The 0.4.3 fix: the bar's stars are not glued to the pattern. Same uniform
	// as 2b, but the record is a bar star (family 2) 1.02 kpc out, with the top
	// amplitude rank, so the vertex must apply orbitPosition's bar branch — the
	// seat riding the pattern plus a loop circulating at Omega(r) - omegaPattern.
	// The displacement between two times is compared (the sub-pixel corner
	// offset cancels out), and the star is also checked to be measurably off its
	// rigid seat: a glued law fails both.
	const barBytes = new ArrayBuffer(records.RECORD_BYTES);
	const barF = new Float32Array(barBytes);
	const barU = new Uint32Array(barBytes);
	barF[0] = 8.178 + 1.0; barF[1] = 0.2; barF[2] = 0.0;
	// jitter byte 240 → phase nibble 0, amplitude nibble 15 (rank 0.969).
	barU[3] = ((records.FLAG_VISIBLE | (2 << 3)) << 16) | (records.encodeAbsMag(4.83) << 8) | 4 | (240 << 24);
	const barBinds = {
		0: {
			0: { uniform: orbitCamBytes },
			1: barBytes,
			2: { texture: lut, descriptor: { size: [256, 1], format: 'rgba8unorm' } },
			3: thetaBytes,
			4: birthBytes,
		},
	};
	// The same numbers the uniform carries, as a model the CPU law can read.
	// fillDynamics derives pressureAmpScale = min(2*sigmaSpheroid/Omega(1 kpc),
	// 0.3 * spheroid axis) = min(0.45, 0.45) = 0.45, matching dynB.y above.
	const fixtureModel = {
		centre: { x: 8.178, y: 0, z: 0 },
		dynamics: { vFlat: 0.225, rCore: 0.5, omegaPattern: 0.041, spinLambda: 0,
			sigmaThin: 0.031, sigmaSpheroid: 0.45 * 0.225 / 2 },
		spheroid: { a: 1.5, b: 1.5, c: 1.5, r0: 1 },
		truncation: { discHeight: 3 },
	};
	const barPos = (t) => {
		const o = new Float64Array(3);
		orbit.orbitPosition(o, barF[0], barF[1], barF[2], orbit.FAMILY_BAR, 0, 15, t, fixtureModel);
		return o;
	};
	const gpuAt = (t) => {
		ocam[27] = t;
		return runStage(spriteCode, 'vs_main', 'debugVertex',
			{ vertex_index: 3, instance_index: 0 }, barBinds);
	};
	// T = 0 is the identity for the bar family too: the loop starts on the seat.
	const barAt0 = gpuAt(0);
	check('on-WGSL: the bar loop starts exactly on the seat at T = 0 (identity rule)',
		Math.abs(barAt0.clipPos[0] - (barF[0] + offX)) < 2e-3
		&& Math.abs(barAt0.clipPos[1] - (barF[1] - 5 + offY)) < 2e-3,
		{ clip: Array.from(barAt0.clipPos) });

	const barT = 40;
	const barAtT = gpuAt(barT);
	const cpu0 = barPos(0), cpuT = barPos(barT);
	check('on-WGSL: the bar branch matches the CPU law at T = 40 Myr (displacement < 2 pc)',
		Math.abs((barAtT.clipPos[0] - barAt0.clipPos[0]) - (cpuT[0] - cpu0[0])) < 2e-3
		&& Math.abs((barAtT.clipPos[1] - barAt0.clipPos[1]) - (cpuT[1] - cpu0[1])) < 2e-3,
		{
			gpu: [barAtT.clipPos[0] - barAt0.clipPos[0], barAtT.clipPos[1] - barAt0.clipPos[1]],
			cpu: [cpuT[0] - cpu0[0], cpuT[1] - cpu0[1]],
		});
	// The rigid seat: where a glued law (the 0.4.2 bug) would still be at T.
	const theta = 0.041 * barT;
	const qx = barF[0] - 8.178, qy = barF[1];
	const seatX = 8.178 + Math.cos(theta) * qx - Math.sin(theta) * qy;
	const seatY = Math.sin(theta) * qx + Math.cos(theta) * qy;
	const offSeat = Math.hypot(barAtT.clipPos[0] - seatX, barAtT.clipPos[1] - (seatY - 5));
	check('on-WGSL: the bar star is measurably OFF its rigid seat (it streams, it is not glued)',
		offSeat > 0.03,
		{ offSeat, cpuOffSeat: Math.hypot(cpuT[0] - seatX, cpuT[1] - seatY) });

	// --- 2d. Pattern-frame capture runs on the shipping WGSL ---------------
	// The f32 replay in orbit-test is a hand copy. This runs the shader. Same
	// camera as 2b; the wave pair is the page default on a two-arm spiral.
	// A skip (damping left at 0) lands on the shear, which this time separates
	// from the capture by well more than the tolerance.
	const savedWave = ocam.slice(36, 44);
	const captureModel = {
		centre: fixtureModel.centre,
		dynamics: fixtureModel.dynamics,
		spheroid: fixtureModel.spheroid,
		truncation: fixtureModel.truncation,
		arms: { amp: 0.5, m: 2, pitchDeg: 12, Rs: 2.5, phase0: 0, minRadius: 1 },
	};
	const capBytes = new ArrayBuffer(records.RECORD_BYTES);
	const capF = new Float32Array(capBytes);
	const capU = new Uint32Array(capBytes);
	capF[0] = 8.178 + 3; capF[1] = 0.4; capF[2] = 0;
	capU[3] = ((records.FLAG_VISIBLE | (1 << 3)) << 16) | (records.encodeAbsMag(4.83) << 8) | 4;
	const capBinds = {
		0: {
			0: { uniform: orbitCamBytes },
			1: capBytes,
			2: { texture: lut, descriptor: { size: [256, 1], format: 'rgba8unorm' } },
			3: thetaBytes,
			4: birthBytes,
		},
	};
	const capT = 200;
	orbit.setWaveDamping(0);
	const shearPos = new Float64Array(3);
	orbit.orbitPosition(shearPos, capF[0], capF[1], capF[2], orbit.FAMILY_DISC, 0, 0, capT, captureModel);
	orbit.setWaveDamping(0.6);
	const capPacked = new Float32Array(16);
	orbit.packOrbitDynamics(captureModel, capPacked, 0);
	ocam.set(capPacked.subarray(8, 16), 36);
	ocam[27] = capT;
	const capGpu = runStage(spriteCode, 'vs_main', 'debugVertex',
		{ vertex_index: 3, instance_index: 0 }, capBinds);
	const capCpu = new Float64Array(3);
	orbit.orbitPosition(capCpu, capF[0], capF[1], capF[2], orbit.FAMILY_DISC, 0, 0, capT, captureModel);
	const gpuX = capGpu.clipPos[0] - offX;
	const gpuY = capGpu.clipPos[1] + 5 - offY;
	check('on-WGSL: capture matches the CPU law at T = 200 Myr (< 20 pc)',
		Math.hypot(gpuX - capCpu[0], gpuY - capCpu[1]) < 0.02,
		{ gpu: [gpuX, gpuY], cpu: [capCpu[0], capCpu[1]] });
	check('on-WGSL: that position is the capture, not the 0.4.3 shear',
		Math.hypot(gpuX - shearPos[0], gpuY - shearPos[1]) > 0.05,
		{ gpu: [gpuX, gpuY], shear: [shearPos[0], shearPos[1]] });
	orbit.setWaveDamping(0);
	ocam.set(savedWave, 36);

	// --- 2e. The simple-engine reconstruction runs on the shipping WGSL ----
	// The engine lane is a MASK (movement-parity-plan): the simple bit is 2.
	// The vertex skips the closed form and rebuilds the position from the
	// integrated azimuth, the birth radius and the eccentric rho. Same camera
	// as 2b (identity, 5 kpc up, centre x = 8.178); the star is born at
	// (16.356, 0, 0), family disc, jitter 0x00 (eccU = 0.03125, peri = 0).
	// The eccentricity is the MODEL rule — simpleEccMax reads vFlat (dynA.x)
	// and sigmaThin (dynB.x) off the lanes already packed for 2b:
	// 1.5 · 0.031 / 0.225 ≈ 0.20667 — no hard-coded value in the shader.
	const simBytes = new ArrayBuffer(records.RECORD_BYTES);
	const simF = new Float32Array(simBytes);
	const simU = new Uint32Array(simBytes);
	simF[0] = 8.178 + 8.178; simF[1] = 0; simF[2] = 0;
	simU[3] = ((records.FLAG_VISIBLE | (1 << 3)) << 16) | (records.encodeAbsMag(4.83) << 8) | 4;
	const simThetaBytes = new ArrayBuffer(4);
	const simTheta = new Float32Array(simThetaBytes);
	const simBinds = {
		0: {
			0: { uniform: orbitCamBytes },
			1: simBytes,
			2: { texture: lut, descriptor: { size: [256, 1], format: 'rgba8unorm' } },
			3: simThetaBytes,
		},
	};
	const simModel = { centre: { x: 8.178, y: 0, z: 0 }, dynamics: { vFlat: 0.225, sigmaThin: 0.031 } };
	const simEcc = orbit.simpleEccMax(simModel);   // = 1.5 · dynB.x / dynA.x
	const simCpu = new Float64Array(3);
	check('the fixture dyn lanes give the reconstruction a nonzero model eccentricity',
		Math.abs(simEcc - 1.5 * 0.031 / 0.225) < 1e-12 && simEcc > 0.15, simEcc);
	ocam[44] = orbit.ENGINE_SIMPLE; ocam[45] = 0; ocam[46] = 0; ocam[47] = 0;
	simTheta[0] = Math.PI / 2;
	const simQuarter = runStage(spriteCode, 'vs_main', 'debugVertex',
		{ vertex_index: 3, instance_index: 0 }, simBinds);
	orbit.simplePositionFromTheta(simCpu, Math.PI / 2, simF[0], simF[1], simF[2], 0,
		orbit.FAMILY_DISC, simEcc, simModel);
	check('on-WGSL: the simple mask rebuilds the quarter-turn position from the azimuth (< 2 pc)',
		Math.abs((simQuarter.clipPos[0] - offX) - simCpu[0]) < 2e-3
		&& Math.abs((simQuarter.clipPos[1] + 5 - offY) - simCpu[1]) < 2e-3,
		{ gpu: [simQuarter.clipPos[0] - offX, simQuarter.clipPos[1] + 5 - offY],
			cpu: [simCpu[0], simCpu[1]] });
	simTheta[0] = 0;
	const simZero = runStage(spriteCode, 'vs_main', 'debugVertex',
		{ vertex_index: 3, instance_index: 0 }, simBinds);
	orbit.simplePositionFromTheta(simCpu, 0, simF[0], simF[1], simF[2], 0,
		orbit.FAMILY_DISC, simEcc, simModel);
	check('on-WGSL: the eccentric rho shapes the rebuilt radius at theta = 0',
		Math.abs((simZero.clipPos[0] - offX) - simCpu[0]) < 2e-3
		&& Math.abs((simZero.clipPos[1] + 5 - offY) - simCpu[1]) < 2e-3,
		{ gpu: [simZero.clipPos[0] - offX, simZero.clipPos[1] + 5 - offY],
			cpu: [simCpu[0], simCpu[1]] });
	// With eccMax read as 0 the radius would be exactly the birth 8.178 —
	// the rebuilt x would sit at 16.356, 51 pc inside the eccentric answer.
	check('on-WGSL: that radius is eccentric, not the birth circle (off by 51 pc)',
		Math.abs((simZero.clipPos[0] - offX) - 16.356) > 0.01,
		{ x: simZero.clipPos[0] - offX, circular: 16.356 });
	// Non-vacuity: the eccentricity really is the model rule off the dyn
	// lanes — double sigmaThin and the rebuilt radius must change, and the
	// old fixed 0.45 answer must NOT fit.
	const savedSigma = ocam[32];
	ocam[32] = 2 * savedSigma;
	const simDoubled = runStage(spriteCode, 'vs_main', 'debugVertex',
		{ vertex_index: 3, instance_index: 0 }, simBinds);
	ocam[32] = savedSigma;
	orbit.simplePositionFromTheta(simCpu, 0, simF[0], simF[1], simF[2], 0,
		orbit.FAMILY_DISC, 0.45, simModel);
	check('on-WGSL: the reconstruction reads simpleEccMax(dynA, dynB) — not a fixed constant',
		Math.abs(simDoubled.clipPos[0] - simZero.clipPos[0]) > 0.01
		&& Math.abs((simZero.clipPos[0] - offX) - simCpu[0]) > 0.01,
		{ dx: simDoubled.clipPos[0] - simZero.clipPos[0],
			gpuX: simZero.clipPos[0] - offX, fixed045: simCpu[0] });
	ocam[44] = 0; ocam[45] = 0; ocam[46] = 0; ocam[47] = 0;

	// --- 2f. Apocenter-guided movement runs on the shipping WGSL -----------
	// The apocenter mask bit is 4; the lane is packed by the shipping packer
	// (mask, force, barTilt, share). captureModel has no bar tilt, so lane z
	// is 0; share must be 1 or the pass would (correctly) guide nothing.
	const apoBytes = new ArrayBuffer(records.RECORD_BYTES);
	const apoF = new Float32Array(apoBytes), apoU = new Uint32Array(apoBytes);
	apoF[0] = 8.178 + 6; apoF[1] = 1.5; apoF[2] = 0.2;
	apoU[3] = ((records.FLAG_VISIBLE | (1 << 3)) << 16)
		| (records.encodeAbsMag(4.83) << 8) | 4 | (orbit.encodeJitter(5, 15) << 24);
	const apoBinds = { 0: {
		0: { uniform: orbitCamBytes },
		1: apoBytes,
		2: { texture: lut, descriptor: { size: [256, 1], format: 'rgba8unorm' } },
		3: thetaBytes,
		4: birthBytes,
	} };
	const apoPacked = new Float32Array(16);
	orbit.packOrbitDynamics(captureModel, apoPacked, 0);
	ocam.set(apoPacked.subarray(0, 16), 28);
	const savedEngine = orbit.getEngine();
	const savedShare = orbit.getApocenterShare();
	const savedForce = orbit.getApocenterForce();
	orbit.setEngine(orbit.ENGINE_APOCENTER);
	orbit.setApocenterShare(1);
	orbit.setApocenterForce(orbit.APOCENTER_ECC_MAX);
	const apoLane = new Float32Array(4);
	orbit.packEngineVec(captureModel, apoLane, 0);
	ocam.set(apoLane, 44);
	check('the apocenter lane packs (mask bit, force, tilt, share) — share 1 guides every star',
		ocam[44] === orbit.ENGINE_APOCENTER && ocam[45] === Math.fround(orbit.APOCENTER_ECC_MAX)
		&& ocam[46] === 0 && ocam[47] === 1,
		{ lane: [ocam[44], ocam[45], ocam[46], ocam[47]] });
	ocam[27] = 0;
	const apoAt0 = runStage(spriteCode, 'vs_main', 'debugVertex',
		{ vertex_index: 3, instance_index: 0 }, apoBinds);
	check('on-WGSL: apocenter engine preserves its birth point at T = 0',
		Math.abs(apoAt0.clipPos[0] - (apoF[0] + offX)) < 2e-3
		&& Math.abs(apoAt0.clipPos[1] - (apoF[1] - 5 + offY)) < 2e-3,
		{ clip: Array.from(apoAt0.clipPos) });
	// Share 0: the membership gate lets no star through — the mask is set but
	// nothing moves off the birth baseline.
	ocam[47] = 0;
	ocam[27] = 120;
	const apoShare0 = runStage(spriteCode, 'vs_main', 'debugVertex',
		{ vertex_index: 3, instance_index: 0 }, apoBinds);
	check('on-WGSL: share 0 freezes every star at its birth position (the gate holds)',
		Math.abs(apoShare0.clipPos[0] - (apoF[0] + offX)) < 2e-3
		&& Math.abs(apoShare0.clipPos[1] - (apoF[1] - 5 + offY)) < 2e-3,
		{ clip: Array.from(apoShare0.clipPos) });
	ocam[47] = 1;
	const apoTime = 120;
	ocam[27] = apoTime;
	const apoAtT = runStage(spriteCode, 'vs_main', 'debugVertex',
		{ vertex_index: 3, instance_index: 0 }, apoBinds);
	const apoCpu = new Float64Array(3);
	orbit.apocenterPosition(apoCpu, apoF[0], apoF[1], apoF[2], orbit.FAMILY_DISC, 5, 15, apoTime, captureModel);
	check('on-WGSL: apocenter vertex path matches the CPU Kepler mirror (< 20 pc)',
		Math.hypot(apoAtT.clipPos[0] - offX - apoCpu[0], apoAtT.clipPos[1] + 5 - offY - apoCpu[1]) < 0.02,
		{ gpu: [apoAtT.clipPos[0] - offX, apoAtT.clipPos[1] + 5 - offY], cpu: [apoCpu[0], apoCpu[1]] });
	// Non-vacuity: the star really left its birth circle — a dead pass would
	// sit on the share-0 answer.
	check('on-WGSL: the guided star actually moves (apocenter pass is not a no-op)',
		Math.hypot(apoAtT.clipPos[0] - apoShare0.clipPos[0], apoAtT.clipPos[1] - apoShare0.clipPos[1]) > 0.05,
		{ moved: Math.hypot(apoAtT.clipPos[0] - apoShare0.clipPos[0], apoAtT.clipPos[1] - apoShare0.clipPos[1]) });
	orbit.setEngine(savedEngine);
	orbit.setApocenterShare(savedShare);
	orbit.setApocenterForce(savedForce);
	ocam[44] = 0; ocam[45] = 0; ocam[46] = 0; ocam[47] = 0;

	// --- 2h. The mask sweep: executed WGSL vs the CPU dispatch table -------
	// Every mask 1–7 through vs_main, lanes packed by the shipping packers
	// (packOrbitDynamics + packEngineVec, exported engine constants — no old
	// IDs written by hand), compared against a CPU reference that re-states
	// the dispatch table. Two stars: a disc star and a bar star, so the bar
	// apsis lane (the model's tilt) is exercised under combined masks.
	const sweepModel = { ...captureModel, spheroid: { ...captureModel.spheroid, tiltDeg: 25 } };
	const sweepBytes = new ArrayBuffer(2 * records.RECORD_BYTES);
	const sweepF = new Float32Array(sweepBytes);
	const sweepU = new Uint32Array(sweepBytes);
	// [x, y, z, family, phase, amp]
	const sweepStars = [
		[8.178 + 5, 2.1, 0.3, 1, 3, 9],
		[8.178 + 1.3, -0.4, 0.1, 2, 11, 15],
	];
	sweepStars.forEach((st, s) => {
		sweepF[s * 4] = st[0]; sweepF[s * 4 + 1] = st[1]; sweepF[s * 4 + 2] = st[2];
		sweepU[s * 4 + 3] = ((records.FLAG_VISIBLE | (st[3] << 3)) << 16)
			| (records.encodeAbsMag(4.83) << 8) | 4 | (orbit.encodeJitter(st[4], st[5]) << 24);
	});
	const sweepThetaBytes = new ArrayBuffer(8);
	const sweepTheta = new Float32Array(sweepThetaBytes);
	for (let s = 0; s < 2; s++) {
		sweepTheta[s] = Math.atan2(sweepStars[s][1], sweepStars[s][0] - 8.178) + (s === 0 ? 0.35 : -0.2);
	}
	const sweepBinds = { 0: {
		0: { uniform: orbitCamBytes },
		1: sweepBytes,
		2: { texture: lut, descriptor: { size: [256, 1], format: 'rgba8unorm' } },
		3: sweepThetaBytes,
	} };
	const sweepPacked = new Float32Array(16);
	orbit.setWaveDamping(0);
	orbit.packOrbitDynamics(sweepModel, sweepPacked, 0);
	ocam.set(sweepPacked.subarray(0, 16), 28);
	const sweepT = 120;
	ocam[27] = sweepT;
	const sweepLane = new Float32Array(4);
	const sweepRef = new Float64Array(3);
	function sweepReference(mask, s) {
		const [bx, by, bz, fam, ph, amp] = sweepStars[s];
		if (mask & orbit.ENGINE_SIMPLE) {
			orbit.simplePositionFromTheta(sweepRef, sweepTheta[s], bx, by, bz,
				orbit.encodeJitter(ph, amp), fam, orbit.simpleEccMax(sweepModel), sweepModel);
		} else if (mask & orbit.ENGINE_CLASSIC) {
			orbit.orbitPosition(sweepRef, bx, by, bz, fam, ph, amp, sweepT, sweepModel);
		} else {
			sweepRef[0] = bx; sweepRef[1] = by; sweepRef[2] = bz;
		}
		if ((mask & orbit.ENGINE_APOCENTER) && sweepT !== 0 && orbit.apocenterSelected(bx, by, bz)) {
			orbit.apocenterPosition(sweepRef, bx, by, bz, fam, ph, amp, sweepT, sweepModel);
		}
		return sweepRef;
	}
	const savedSweepShare = orbit.getApocenterShare();
	const savedSweepForce = orbit.getApocenterForce();
	orbit.setApocenterShare(1);
	orbit.setApocenterForce(orbit.APOCENTER_ECC_MAX);
	let sweepWorst = 0, sweepWorstCase = null;
	const sweepPos = {};
	let sweepTiltOk = true;
	for (let mask = 1; mask <= 7; mask++) {
		orbit.setEngine(mask);
		orbit.packEngineVec(sweepModel, sweepLane, 0);
		ocam.set(sweepLane, 44);
		if ((mask & orbit.ENGINE_APOCENTER)
			&& Math.abs(ocam[46] - Math.fround(25 * Math.PI / 180)) > 1e-7) sweepTiltOk = false;
		sweepPos[mask] = [];
		for (let s = 0; s < 2; s++) {
			const v = runStage(spriteCode, 'vs_main', 'debugVertex',
				{ vertex_index: 3, instance_index: s }, sweepBinds);
			const gx = v.clipPos[0] - offX, gy = v.clipPos[1] + 5 - offY;
			const ref = sweepReference(mask, s);
			const d = Math.hypot(gx - ref[0], gy - ref[1]);
			if (d > sweepWorst) { sweepWorst = d; sweepWorstCase = { mask, star: s, d }; }
			sweepPos[mask].push([gx, gy]);
		}
	}
	check('on-WGSL: every mask 1–7 lands where the CPU dispatch table says (both stars, < 20 pc)',
		sweepWorst < 0.02, { sweepWorst, sweepWorstCase });
	check('packEngineVec fills the bar tilt under every mask carrying the apocenter bit',
		sweepTiltOk, { tilt: Math.fround(25 * Math.PI / 180) });
	const sep2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
	check('on-WGSL: masks 1, 2 and 4 are three distinct renderings at T = 120 (> 0.1 kpc apart)',
		sep2(sweepPos[1][0], sweepPos[2][0]) > 0.1
		&& sep2(sweepPos[1][0], sweepPos[4][0]) > 0.1
		&& sep2(sweepPos[2][1], sweepPos[4][1]) > 0.1,
		{ disc: [sep2(sweepPos[1][0], sweepPos[2][0]), sep2(sweepPos[1][0], sweepPos[4][0])],
			bar: sep2(sweepPos[2][1], sweepPos[4][1]) });
	check('on-WGSL: mask 3 renders exactly what mask 2 renders (simple masks classic)',
		sep2(sweepPos[3][0], sweepPos[2][0]) < 2e-3 && sep2(sweepPos[3][1], sweepPos[2][1]) < 2e-3,
		{ d0: sep2(sweepPos[3][0], sweepPos[2][0]), d1: sep2(sweepPos[3][1], sweepPos[2][1]) });
	// T = 0 identity for the masks without the simple bit.
	ocam[27] = 0;
	orbit.setEngine(orbit.ENGINE_APOCENTER);
	orbit.packEngineVec(sweepModel, sweepLane, 0);
	ocam.set(sweepLane, 44);
	const sweepAt0 = runStage(spriteCode, 'vs_main', 'debugVertex',
		{ vertex_index: 3, instance_index: 0 }, sweepBinds);
	check('on-WGSL: mask 4 at T = 0 renders the birth position (identity baseline)',
		Math.abs(sweepAt0.clipPos[0] - (sweepStars[0][0] + offX)) < 2e-3
		&& Math.abs(sweepAt0.clipPos[1] - (sweepStars[0][1] - 5 + offY)) < 2e-3,
		{ clip: [sweepAt0.clipPos[0], sweepAt0.clipPos[1]] });
	// Force 0 degenerates the ellipse to the circular rate: the disc star's
	// radius about the centre is conserved (its plane is nearly the disc
	// plane, so the xy radius carries it), while the bounded force is
	// eccentric. The local Kepler phase creeps at Ω−Ωp ≈ 6e-4 rad/Myr here,
	// so the breathing needs a long baseline to open up.
	const sweepR0 = Math.hypot(sweepStars[0][0] - 8.178, sweepStars[0][1]);
	ocam[27] = 2000;
	orbit.setApocenterForce(0);
	orbit.packEngineVec(sweepModel, sweepLane, 0);
	ocam.set(sweepLane, 44);
	const circ = runStage(spriteCode, 'vs_main', 'debugVertex',
		{ vertex_index: 3, instance_index: 0 }, sweepBinds);
	const circR = Math.hypot(circ.clipPos[0] - offX - 8.178, circ.clipPos[1] + 5 - offY);
	orbit.setApocenterForce(orbit.APOCENTER_ECC_MAX);
	orbit.packEngineVec(sweepModel, sweepLane, 0);
	ocam.set(sweepLane, 44);
	const ecc = runStage(spriteCode, 'vs_main', 'debugVertex',
		{ vertex_index: 3, instance_index: 0 }, sweepBinds);
	const eccR = Math.hypot(ecc.clipPos[0] - offX - 8.178, ecc.clipPos[1] + 5 - offY);
	check('on-WGSL: force 0 conserves the birth radius (circular limit), nonzero force is eccentric',
		Math.abs(circR - sweepR0) < 0.01 && Math.abs(eccR - sweepR0) > 0.1,
		{ birthR: sweepR0, circR, eccR });
	orbit.setEngine(orbit.ENGINE_CLASSIC);
	orbit.setApocenterShare(savedSweepShare);
	orbit.setApocenterForce(savedSweepForce);
	ocam[27] = 0;
	ocam[44] = 0; ocam[45] = 0; ocam[46] = 0; ocam[47] = 0;

	// --- 2i. The vertical column on the shipping WGSL (0.4.9) ---------------
	// orbitPlane's second anchor: a disc/pattern star sweeps a plane parallel
	// to the galactic one through its own birth height, so z is CARRIED, while
	// a spheroidal star keeps the centred inclined plane and swings in z. The
	// fixtures above all sit at z = 0, so this is the only executed check of
	// the carry. The star is a disc star born off the plane at half the model's
	// disc height, swept half a turn — exactly where the centred basis the law
	// had before would have dropped it to z ≈ −0.35 (it put (qz/|q|)·cos θ in z
	// and measured the column at 0.66-0.87 of the field's).
	const vertDisc = new ArrayBuffer(records.RECORD_BYTES);
	const vertDiscF = new Float32Array(vertDisc), vertDiscU = new Uint32Array(vertDisc);
	vertDiscF[0] = 8.178 + 4.2; vertDiscF[1] = -1.7; vertDiscF[2] = 0.35;
	vertDiscU[3] = ((records.FLAG_VISIBLE | (1 << 3)) << 16)
		| (records.encodeAbsMag(4.83) << 8) | 4 | (orbit.encodeJitter(7, 11) << 24);
	const vertPress = new ArrayBuffer(records.RECORD_BYTES);
	const vertPressF = new Float32Array(vertPress), vertPressU = new Uint32Array(vertPress);
	vertPressF[0] = 8.178 + 4.2; vertPressF[1] = -1.7; vertPressF[2] = 0.35;
	vertPressU[3] = ((records.FLAG_VISIBLE | (3 << 3)) << 16)
		| (records.encodeAbsMag(4.83) << 8) | 4 | (orbit.encodeJitter(7, 11) << 24);
	const vertBinds = { 0: {
		0: { uniform: orbitCamBytes },
		1: vertDisc,
		2: { texture: lut, descriptor: { size: [256, 1], format: 'rgba8unorm' } },
		3: thetaBytes,
		4: birthBytes,
	} };
	const vertPressBinds = { 0: {
		0: { uniform: orbitCamBytes },
		1: vertPress,
		2: { texture: lut, descriptor: { size: [256, 1], format: 'rgba8unorm' } },
		3: thetaBytes,
		4: birthBytes,
	} };
	// No damping, so the azimuth is the plain differential rate: half a turn of
	// the solar-circle disc rate at this radius.
	const vertModel = {
		centre: fixtureModel.centre,
		dynamics: { ...fixtureModel.dynamics, omegaPattern: 0.041 },
		spheroid: fixtureModel.spheroid,
		truncation: { discHeight: 3 },
	};
	const vertR = Math.hypot(4.2, 1.7);
	const vertHalf = Math.PI / (0.225 / vertR);
	orbit.setWaveDamping(0);
	ocam[44] = orbit.ENGINE_CLASSIC;
	ocam[27] = vertHalf;
	const vertGpu = runStage(spriteCode, 'vs_main', 'debugVertex',
		{ vertex_index: 3, instance_index: 0 }, vertBinds);
	const vertCpu = new Float64Array(3);
	orbit.orbitPosition(vertCpu, vertDiscF[0], vertDiscF[1], vertDiscF[2], orbit.FAMILY_DISC, 7, 11, vertHalf, vertModel);
	const gpuZ = vertGpu.clipPos[2];
	check('on-WGSL: a disc star carries its birth height through half a turn (0.4.9 anchor)',
		Math.abs(gpuZ - vertCpu[2]) < 2e-3, { gpuZ, cpuZ: vertCpu[2], birthZ: 0.35 });
	// The centred basis the law had before would read z = 0.35·cos(π) = −0.35
	// here. What the height may still move by is the classic law's bounded
	// vertical wobble, re-derived from the fixture's own lanes: the plane
	// carries the height, the epicycle wobbles about it.
	const wobbleRank = (11 + 0.5) / 16;
	const wobbleKappa = Math.SQRT2 * (0.225 / Math.max(vertR, 0.5));
	const wobbleAh = wobbleRank * 2 * 0.031 / wobbleKappa;
	const wobbleAv = Math.min(orbit.VERTICAL_WOBBLE_RATIO * wobbleAh, 0.5 * (3 - 0.35));
	check('on-WGSL: that height is the carried one — the only motion is the bounded wobble (< 2·av)',
		Math.abs(gpuZ - 0.35) <= 2 * wobbleAv + 1e-3 && Math.abs(gpuZ - 0.35) < Math.abs(gpuZ + 0.35),
		{ gpuZ, wobbleBound: 2 * wobbleAv, centredWouldBe: -0.35 });
	// A difference of two sine values moves by up to 2*av from birth. At either
	// slab edge the GPU cap must therefore spend only half the remaining room.
	const edgeCut = vertModel.truncation.discHeight;
	const edgeMargin = 0.02;
	const edgeTime = Math.PI / wobbleKappa;
	const edgeCases = [[edgeCut - edgeMargin, 8], [-edgeCut + edgeMargin, 0]];
	const edgeCpu = new Float64Array(3);
	const edgeDetails = [];
	let edgeSafe = true;
	for (const [birthZ, phase] of edgeCases) {
		vertDiscF[2] = birthZ;
		vertDiscU[3] = ((records.FLAG_VISIBLE | (1 << 3)) << 16)
			| (records.encodeAbsMag(4.83) << 8) | 4 | (orbit.encodeJitter(phase, 15) << 24);
		ocam[27] = edgeTime;
		const edgeGpu = runStage(spriteCode, 'vs_main', 'debugVertex',
			{ vertex_index: 3, instance_index: 0 }, vertBinds);
		orbit.orbitPosition(edgeCpu, vertDiscF[0], vertDiscF[1], vertDiscF[2],
			orbit.FAMILY_DISC, phase, 15, edgeTime, vertModel);
		const edgeGpuZ = edgeGpu.clipPos[2] - vertModel.centre.z;
		const edgeCpuZ = edgeCpu[2] - vertModel.centre.z;
		if (Math.abs(edgeGpuZ - edgeCpuZ) >= 2e-3
			|| Math.abs(edgeGpuZ) > edgeCut + 2e-3
			|| Math.abs(edgeCpuZ) > edgeCut + 1e-8
			|| Math.abs(Math.abs(edgeGpuZ) - edgeCut) >= 3e-3) edgeSafe = false;
		edgeDetails.push({ birthZ, gpuZ: edgeGpuZ, cpuZ: edgeCpuZ });
	}
	check('on-WGSL: the half-headroom vertical wobble respects both disc-height edges',
		edgeSafe, { cut: edgeCut, margin: edgeMargin, edgeDetails });
	ocam[44] = orbit.ENGINE_CLASSIC;
	ocam[27] = vertHalf;
	const pressGpu = runStage(spriteCode, 'vs_main', 'debugVertex',
		{ vertex_index: 3, instance_index: 0 }, vertPressBinds);
	const pressCpu = new Float64Array(3);
	orbit.orbitPosition(pressCpu, vertPressF[0], vertPressF[1], vertPressF[2], orbit.FAMILY_PRESSURE, 7, 11, vertHalf, vertModel);
	check('on-WGSL: a spheroidal star still sweeps its centred plane (z swings, matches CPU)',
		Math.abs(pressGpu.clipPos[2] - pressCpu[2]) < 2e-3 && Math.abs(pressGpu.clipPos[2] - 0.35) > 0.05,
		{ gpuZ: pressGpu.clipPos[2], cpuZ: pressCpu[2], birthZ: 0.35 });
	ocam[27] = 0;
	ocam[44] = 0; ocam[45] = 0; ocam[46] = 0; ocam[47] = 0;

	// --- 2g. The simple-step kernel runs on the shipping WGSL --------------
	// The real compute entry, one workgroup of 64, driven invocation by
	// invocation through debugWorkgroup: WgslDebug runs exactly the invocation
	// whose global id matches, and the shared buffers persist across the
	// re-armed sessions, so all 64 slots land in one theta array. (The fast
	// path, WgslExec.dispatchWorkgroups, mis-executes this kernel — omega
	// comes out exactly 4×, n = 1 included — so the suite does not use it.
	// Probably a library bug in the exec path's struct/uniform reads; the
	// debug path agrees with the CPU law to f32 rounding, below.)
	// Fixture: an SBb at T = 0 stepped 1 Myr, all four families, jitter ranks
	// 0x00/0xff/0xa5/0x5a, the centre (R = 0, no log(0)), one invisible slot,
	// and count = 60 so slots 60–63 prove the guard.
	{
		const stepModel = galaxy.createGalaxy({ type: 'SBb' });
		const stepC = stepModel.centre;
		const STEP_COUNT = 60;
		const STEP_SLOTS = 64;
		const stepUniformBytes = new ArrayBuffer(orbit.SIMPLE_UNIFORM_FLOATS * 4);
		orbit.packSimpleParams(stepModel, new Float32Array(stepUniformBytes), 0, 1, STEP_COUNT, 0);
		const stepStarBytes = new ArrayBuffer(STEP_SLOTS * records.RECORD_BYTES);
		const stepF = new Float32Array(stepStarBytes);
		const stepU = new Uint32Array(stepStarBytes);
		const stepFams = [orbit.FAMILY_DISC, orbit.FAMILY_PATTERN, orbit.FAMILY_BAR, orbit.FAMILY_PRESSURE];
		const stepJit = [0x00, 0xff, 0xa5, 0x5a];
		for (let i = 0; i < STEP_SLOTS; i++) {
			const R = i === 7 ? 0 : (i % 15) * 0.8 + 0.2;
			const a = i * 0.7;
			stepF[i * 4] = stepC.x + R * Math.cos(a);
			stepF[i * 4 + 1] = stepC.y + R * Math.sin(a);
			stepF[i * 4 + 2] = (i % 5) * 0.1;
			const vis = i === 13 ? 0 : records.FLAG_VISIBLE;
			stepU[i * 4 + 3] = ((vis | (stepFams[i % 4] << 3)) << 16)
				| (records.encodeAbsMag(4.83) << 8) | 4 | (stepJit[i % 4] << 24);
		}
		const stepThetaBytes = new ArrayBuffer(STEP_SLOTS * 4);
		const stepTheta = new Float32Array(stepThetaBytes);
		for (let i = 0; i < STEP_SLOTS; i++) stepTheta[i] = (i * 0.37) % (Math.PI * 2) - Math.PI;
		for (let i = STEP_COUNT; i < STEP_SLOTS; i++) stepTheta[i] = 7.77;
		const stepIn = Float32Array.from(stepTheta);
		const stepBinds = { 0: { 0: { uniform: stepUniformBytes }, 1: stepStarBytes, 2: stepThetaBytes } };
		const stepDbg = new WgslDebug(shaders.SHADERS['simple-step']);
		let stepOk = true;
		for (let i = 0; i < STEP_SLOTS; i++) {
			if (!stepDbg.debugWorkgroup('main', [i, 0, 0], 1, stepBinds)) { stepOk = false; break; }
			let n = 0;
			while (stepDbg.stepNext() && n < 50000) n++;
			if (n >= 50000) { stepOk = false; break; }
		}
		check('on-WGSL: all 64 simple-step invocations run to completion', stepOk);
		const stepP = orbit.simpleDerived(stepModel);
		const stepPhase = orbit.simplePatternPhase(stepModel, 0);
		const TAU = Math.PI * 2;
		let stepWorst = 0;
		let stepWorstI = -1;
		let stepNaN = -1;
		for (let i = 0; i < STEP_COUNT; i++) {
			const packed = stepU[i * 4 + 3];
			if ((packed & 0x10000) === 0) continue;
			const r0 = Math.hypot(stepF[i * 4] - stepC.x, stepF[i * 4 + 1] - stepC.y);
			const cpu = orbit.simpleStepTheta(stepIn[i], r0,
				orbit.simpleEccOf(packed >>> 24), orbit.simplePeriOf(packed >>> 24),
				(packed >>> 19) & 3, stepP, stepPhase, 1);
			if (!Number.isFinite(stepTheta[i])) { stepNaN = i; break; }
			let d = Math.abs(stepTheta[i] - cpu) % TAU;
			if (d > Math.PI) d = TAU - d;
			if (d > stepWorst) { stepWorst = d; stepWorstI = i; }
		}
		// 4e-4 was the floor while the preset's phase0 was 0; the coupled bar
		// phase rides the lane base in f32 now and the measured worst is
		// 4.4e-4 rad (3.6 pc at the Sun ring — still far sub-pixel).
		check('on-WGSL: the kernel matches the CPU law on every live slot (< 5e-4 rad)',
			stepNaN < 0 && stepWorst < 5e-4, { worstRad: stepWorst, slot: stepWorstI, nan: stepNaN });
		check('on-WGSL: the centre steps without a NaN (the minRadius skip holds)',
			Number.isFinite(stepTheta[7]), { in: stepIn[7], out: stepTheta[7] });
		check('on-WGSL: invisible slots and slots past count keep their input azimuth',
			stepTheta[13] === stepIn[13]
			&& stepTheta[60] === stepIn[60] && stepTheta[63] === stepIn[63],
			{ invisible: [stepIn[13], stepTheta[13]], guard: [stepIn[60], stepTheta[60]] });
	}

	// --- 2j. The gas grid runs on the shipping WGSL (0.7.4 / F5) -----------
	// The grid exists twice: src/math/gas-grid.js (the law, the calibration, the
	// readout) and `gas-step` (what the GPU integrates). WgslDebug runs one
	// invocation at a time, so the probes walk a spread of the 24 576 cells —
	// inner rings, the truncation edge, both ends of the buffer — and compare
	// the mass and the display slot against the JS replay of the same step.
	{
		const gasLib = require('../src/math/gas-grid.js');
		const gasModel = galaxy.createGalaxy({ type: 'SBb', seed: 5, age: 1 });
		const gasRef = galaxy.modelAtAge(gasModel, galaxy.AGE_REF);
		const gasAccount = gasLib.initialize(gasRef, 0, gasModel.seed);
		const gasGrid = new Float32Array(gasLib.GAS_FLOATS);
		gasLib.fillGrid(gasAccount, 0, gasModel.seed, gasGrid);
		const gasGeo = gasAccount.geometry;
		const gasUniformBytes = new ArrayBuffer(16 * 4);
		const gasU = new Float32Array(gasUniformBytes);
		gasU[0] = 1;                             // dt, Gyr
		gasU[1] = gasAccount.burnC;
		gasU[2] = 1 / gasLib.GAS_SMOOTH_GYR;
		gasU[3] = gasGeo.armsAmp;
		gasU[4] = gasGeo.armsM;
		gasU[5] = gasGeo.armsK;
		gasU[6] = gasGeo.armsRs;
		gasU[7] = gasGeo.armsPhase0;
		gasU[8] = gasGeo.rMin;
		gasU[9] = gasGeo.rMax;
		gasU[10] = gasGeo.height;
		gasU[11] = gasGeo.centreX;
		gasU[12] = gasGeo.centreZ;
		gasU[13] = gasLib.GAS_CELLS;
		gasU[14] = 1400;
		gasU[15] = 1;
		const gasInBytes = gasGrid.slice().buffer;
		const gasOutBytes = new Float32Array(gasLib.GAS_FLOATS).buffer;
		const gasBinds = { 0: { 0: { uniform: gasUniformBytes }, 1: gasInBytes, 2: gasOutBytes } };
		const gasCpu = gasGrid.slice();
		gasLib.step(gasCpu, gasAccount, 1);
		const gasGroups = Math.ceil(gasLib.GAS_CELLS / 64);
		const gasProbes = [0, 1, 63, 2304, 7777, 12288, 20000, 24575];
		const gasDbg = new WgslDebug(shaders.SHADERS['gas-step']);
		let gasRan = true;
		let gasNaN = -1;
		let gasWorstMass = 0;
		let gasWorstSlot = 0;
		let gasWorstCell = -1;
		for (const cell of gasProbes) {
			if (!gasDbg.debugWorkgroup('main', [cell, 0, 0], gasGroups, gasBinds)) { gasRan = false; break; }
			let n = 0;
			while (gasDbg.stepNext() && n < 50000) n++;
			if (n >= 50000) { gasRan = false; break; }
			const out = new Float32Array(gasOutBytes);
			if (!Number.isFinite(out[cell * 4])) { gasNaN = cell; break; }
			const rel = Math.abs(out[cell * 4] - gasCpu[cell * 4]) / Math.max(gasCpu[cell * 4], 1e-9);
			if (rel > gasWorstMass) { gasWorstMass = rel; gasWorstCell = cell; }
			gasWorstSlot = Math.max(gasWorstSlot, Math.abs(out[cell * 4 + 3] - gasCpu[cell * 4 + 3]));
		}
		check('on-WGSL: the gas burn step runs for every probed cell', gasRan && gasNaN < 0,
			{ ran: gasRan, nan: gasNaN });
		check('on-WGSL: the stepped mass matches gas-grid.js (< 2e-4 relative)',
			gasWorstMass < 2e-4, { worst: gasWorstMass, cell: gasWorstCell });
		check('on-WGSL: the display slot matches the exact response (< 1e-9 absolute)',
			gasWorstSlot < 1e-9, { worst: gasWorstSlot });

		// The quad: an empty cell is hidden, a live one spans exactly its own
		// footprint (the ring step by the spoke step, unexpanded at this size) and
		// carries the flux its mass implies, scaled by the tent's 4/peak.
		const gasCamBytes = new ArrayBuffer(56 * 4);
		const gasCam = new Float32Array(gasCamBytes);
		gasCam.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 0);   // identity viewProj
		gasCam[19] = gasGeo.centreX;
		gasCam[20] = 1600; gasCam[21] = 900; gasCam[22] = 2 / 1600; gasCam[23] = 2 / 900;
		gasCam[27] = 0;                       // star time: the pattern rotation is 0
		gasCam[30] = gasGeo.armsM;            // dynA.z = the pattern speed (unused at t = 0)
		gasCam[49] = 1;                       // epoch: spheroid scale 1, identity
		gasCam[50] = 1;                       // epoch.z: heat scale 1
		const ring = 5, spoke = 10, slab = 2;
		const cellIndex = gasLib.cellIndex(ring, spoke, slab);
		const gasCellBinds = { 0: { 0: { uniform: gasCamBytes }, 1: gasInBytes, 2: { uniform: gasUniformBytes } } };
		const liveCell = runStage(shaders.SHADERS['gas-cell'], 'vs_main', 'debugVertex',
			{ vertex_index: 0, instance_index: cellIndex }, gasCellBinds);
		const R = gasLib.cellRadius(gasGeo, ring);
		const phi = gasLib.cellAzimuth(gasGeo, spoke);
		const worldX = gasGeo.centreX + R * Math.cos(phi);
		const worldY = R * Math.sin(phi);
		const worldZ = gasGeo.centreZ + gasLib.cellHeight(gasGeo, slab);
		const dist = Math.hypot(worldX, worldY, worldZ);
		const dr = gasLib.ringEdge(gasGeo, ring + 1) - gasLib.ringEdge(gasGeo, ring);
		const dPhi = Math.PI * 2 / gasGeo.spokes;
		const focal = 900 / Math.tan(1.047197551 * 0.5);
		const growR = Math.max(1, 2 / Math.max(dr / dist * focal, 1e-6));
		const growA = Math.max(1, 2 / Math.max(R * dPhi / dist * focal, 1e-6));
		const cornerR = R - growR * dr;
		const cornerPhi = phi - growA * dPhi;
		const cornerX = gasGeo.centreX + cornerR * Math.cos(cornerPhi);
		const cornerY = cornerR * Math.sin(cornerPhi);
		const m = gasGrid[cellIndex * 4];
		const w = gasGrid[cellIndex * 4 + 2];
		const flux = m * 1400 * (0.7 + 0.6 * Math.min(1, Math.max(0, w))) / (growR * growA);
		check('on-WGSL: a live cell covers the cell step either side of its centre, as the CPU look model draws it',
			Math.abs(liveCell.clipPos[0] - cornerX) < 1e-3
			&& Math.abs(liveCell.clipPos[1] - cornerY) < 1e-3
			&& Math.abs(liveCell.clipPos[3] - 1) < 1e-5,
			{ wgsl: liveCell.clipPos, expected: [cornerX, cornerY, worldZ], grow: [growR, growA] });
		check('on-WGSL: that cell carries the tent peak its mass implies',
			Math.abs(liveCell.flux - flux) / flux < 1e-3, { wgsl: liveCell.flux, model: flux });

		// A burned-out cell must cost no pixels: zero one cell's mass in a copy of
		// the buffer and the same invocation returns the hidden vertex.
		const emptyBytes = gasGrid.slice().buffer;
		new Float32Array(emptyBytes)[cellIndex * 4] = 0;
		const emptyCell = runStage(shaders.SHADERS['gas-cell'], 'vs_main', 'debugVertex',
			{ vertex_index: 0, instance_index: cellIndex },
			{ 0: { 0: { uniform: gasCamBytes }, 1: emptyBytes, 2: { uniform: gasUniformBytes } } });
		check('on-WGSL: an empty cell is clipped away before rasterization',
			emptyCell.flux === 0 && emptyCell.clipPos[2] === -1,
			{ flux: emptyCell.flux, clip: emptyCell.clipPos });
	}


	// --- 2k. The response and its actual consumer (0.7.5) -----------------
	{
		const gasLib = require('../src/math/gas-grid.js');
		const objects = require('../src/math/objects.js');
		const model = galaxy.createGalaxy({ type: 'SBb', seed: 17 });
		const account = gasLib.initialize(model, 5, model.seed);
		const geo = account.geometry;
		const params = new Float32Array(16);
		params[2] = 1 / gasLib.GAS_SMOOTH_GYR;
		params[6] = geo.armsRs;
		params[8] = geo.rMin; params[9] = geo.rMax; params[10] = geo.height;
		params[13] = 1;
		const source = new Float32Array([0.7, 0.8, 0.9, 0.2]);
		const target = new Float32Array(4);
		const bindings = { 0: { 0: { uniform: params.buffer }, 1: source.buffer, 2: target.buffer } };
		const debug = new WgslDebug(shaders.SHADERS['gas-step']);
		const dispatch = () => {
			if (!debug.debugWorkgroup('main', [0, 0, 0], 1, bindings)) throw new Error('gas-step did not start');
			let n = 0;
			while (debug.stepNext() && n < 50000) n++;
			if (n >= 50000) throw new Error('gas-step did not finish');
		};
		let worst = 0, finite = true;
		for (const rate of [0, 0.15, 20 - 0.00001, 20, 20 + 0.00001, 64]) {
			params[1] = rate;
			for (const dt of [0, 1e-9, 0.00000165, 0.00165, 0.05, 2, 13.5]) {
				params[0] = dt;
				dispatch();
				const expected = gasLib.rateAfter(source[0], source[3], params[1], params[0]);
				finite = finite && target.every(Number.isFinite);
				worst = Math.max(worst, Math.abs(target[3] - expected) / Math.max(expected, 1e-25));
			}
		}
		check('on-WGSL: the response handles zero/tiny dt and equal/near-equal decay rates', finite && worst < 2e-4,
			{ finite, worstRelative: worst });
		params[0] = 0.03; source[0] = 0;
		dispatch();
		check('on-WGSL: an exhausted cell still decays its display rate', target[0] === 0 && target[3] > 0
			&& Math.abs(target[3] - source[3] * Math.exp(-params[2] * params[0])) < 1e-7);

		source[0] = 0.7; source[3] = 0; params[0] = 0.02; params[1] = 0.15;
		const wantMass = source[0] * Math.exp(-params[1] * params[0] * 250);
		const wantRate = gasLib.rateAfter(source[0], 0, params[1], params[0] * 250);
		for (let i = 0; i < 250; i++) { dispatch(); source.set(target); }
		check('on-WGSL: 250 forward steps match a direct epoch evaluation of mass AND rate',
			Math.abs(target[0] - wantMass) / wantMass < 2e-5
			&& Math.abs(target[3] - wantRate) / wantRate < 2e-5,
			{ mass: target[0], wantMass, rate: target[3], wantRate });

		// Pack through the shipping writer, not a test-only copy of NebulaPacked.
		const grid = gasLib.fillGrid(account, 5, model.seed);
		const ring = 38, spoke = 15, slab = 2;
		const cell = gasLib.cellIndex(ring, spoke, slab);
		const R = gasLib.cellRadius(geo, ring), phi = gasLib.cellAzimuth(geo, spoke);
		const point = { x: geo.centreX + R * Math.cos(phi), y: R * Math.sin(phi), z: gasLib.cellHeight(geo, slab) };
		const otherPhi = gasLib.cellAzimuth(geo, spoke + 1);
		const placed = [
			{ ...point, type: 'HII', size: 0.1, formedAt: 2 },
			{ ...point, x: geo.centreX + R * Math.cos(otherPhi), y: R * Math.sin(otherPhi), type: 'HII', size: 0.1, formedAt: 2 },
			{ ...point, type: 'planetary', size: 0.1, formedAt: 2 },
			{ ...point, type: 'SNR', size: 0.1, formedAt: 2 },
			{ ...point, x: geo.centreX + geo.rMax + 1, type: 'HII', size: 0.1, formedAt: 2 },
		];
		const nebBytes = new ArrayBuffer(placed.length * objects.BILLBOARD_RECORD_BYTES);
		const nebView = new DataView(nebBytes);
		objects.writeObjectBillboards(placed, nebView, 0, placed.length, account);
		const camera = new Float32Array(56);
		camera.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
		camera[19] = geo.centreX;
		camera[20] = 1600; camera[21] = 900; camera[22] = 2 / 1600; camera[23] = 2 / 900;
		camera[27] = 13; camera[30] = 0.04; camera[43] = 0.27;
		camera[48] = 0.23; camera[49] = 1; camera[50] = 0.6;
		camera[52] = 5; camera[53] = orbit.BIRTH_FADE_GYR; camera[55] = 1;
		const angle = camera[30] * camera[27] + camera[43] + camera[48];
		const qx = Math.fround(point.x) - camera[19], qy = Math.fround(point.y);
		const world = [camera[19] + qx * Math.cos(angle) - qy * Math.sin(angle),
			qx * Math.sin(angle) + qy * Math.cos(angle), Math.fround(point.z) * camera[50]];
		camera[16] = world[0] + 0.25; camera[17] = world[1] - 0.4; camera[18] = world[2] + 1.7;
		const nebBinds = { 0: { 0: { uniform: camera.buffer }, 1: nebBytes, 2: grid.buffer } };
		const vertex = (i) => runStage(shaders.SHADERS['nebula-billboard'], 'vs_main', 'debugVertex',
			{ vertex_index: 0, instance_index: i }, nebBinds);
		const live = vertex(0);
		const eye = world.map((v, i) => v - camera[16 + i]);
		const size = Math.fround(0.1) / Math.hypot(...eye) * camera[21] / Math.tan(1.047197551 * 0.5);
		check('on-WGSL: HII rides its source cell and projects relative to a translated camera',
			live.brightness > 0 && Math.hypot(...world) > 5
			&& Math.abs(live.clipPos[0] - (eye[0] - size * 0.5 * camera[22])) < 2e-5
			&& Math.abs(live.clipPos[1] - (eye[1] - size * 0.5 * camera[23])) < 2e-5
			&& Math.abs(live.clipPos[2] - eye[2]) < 2e-5,
			{ clip: live.clipPos, eye, size, distanceFromOrigin: Math.hypot(...world) });
		const local = gasLib.emissionWeight(grid[cell * 4 + 3], nebView.getFloat32(36, true));
		check('on-WGSL: HII brightness is its own cell rate times opacity',
			Math.abs(live.brightness - Math.fround(objects.BILLBOARD_OPACITY.HII) * local) < 1e-6,
			{ wgsl: live.brightness, local });
		const neighbour = vertex(1);
		const savedRate = grid[cell * 4 + 3];
		grid[cell * 4 + 3] = 0;
		const empty = vertex(0), untouched = vertex(1);
		check('on-WGSL: an empty source hides only its HII, not a neighbouring cell',
			empty.brightness === 0 && empty.clipPos[2] === -1 && neighbour.brightness > 0
			&& untouched.brightness === neighbour.brightness);
		check('on-WGSL: planetary nebulae and SNR do not read the cold-gas rate',
			Math.abs(vertex(2).brightness - objects.BILLBOARD_OPACITY.planetary) < 1e-6
			&& Math.abs(vertex(3).brightness - objects.BILLBOARD_OPACITY.SNR) < 1e-6);
		check('on-WGSL: an out-of-grid HII has no source instead of aliasing an edge', vertex(4).brightness === 0);
		grid[cell * 4 + 3] = 100;
		check('on-WGSL: the local look multiplier has a finite 4x ceiling',
			Math.abs(vertex(0).brightness - objects.BILLBOARD_OPACITY.HII * gasLib.GAS_RATE_MAX) < 1e-6);
		grid[cell * 4 + 3] = savedRate;

		camera[52] = 2;
		const born = vertex(0);
		camera[52] = 2 + orbit.BIRTH_FADE_GYR / 2;
		const half = vertex(0);
		camera[52] = 2 + orbit.BIRTH_FADE_GYR;
		const full = vertex(0);
		check('on-WGSL: billboards use their carried birth, not a global startup fade',
			born.brightness === 0 && Math.abs(half.brightness / full.brightness - 0.5) < 1e-5);
		camera[52] = 0;
		check('on-WGSL: First light hides all nebula types even if a cell contains rate',
			[0, 1, 2, 3].every((i) => vertex(i).brightness === 0));
		camera[52] = 5;
		camera[16] += 6;
		check('on-WGSL: the distance cull follows the camera, not the origin', vertex(0).brightness === 0);
		camera[16] -= 6;
		objects.writeObjectBillboards(placed, nebView, 0, placed.length);
		nebBinds[0][2] = new Float32Array(4).buffer;
		check('on-WGSL: no grid uses unmodulated light with a single dummy cell binding',
			Math.abs(vertex(0).brightness - objects.BILLBOARD_OPACITY.HII) < 1e-6);
	}

	// --- 3. N stars on one pixel are brighter than one --------------------
	const faint = runStage(spriteCode, 'vs_main', 'debugVertex',
		{ vertex_index: 3, instance_index: 2 }, spriteBinds);
	check('the faint star matches the same formula, including the sub-pixel fade',
		Math.abs(faint.brightness - emitted(faintMag, 0.2)) / emitted(faintMag, 0.2) < 1e-5,
		{ wgsl: faint.brightness, model: emitted(faintMag, 0.2), unfaded: fluxAt(faintMag, 0.2) });
	check('the fade really is active for it (under 1 px), or the check above is vacuous',
		fadeAt(faintMag + 5 * Math.log10(200) - 5 - MAG_ZERO) < 1, null);
	const one = faint.brightness;   // disc centre, falloff 1

	const W = 16;
	const H = 16;
	const radianceBytes = new Uint8Array(W * H * 16);
	const radiance = new Float32Array(radianceBytes.buffer);
	const toneBytes = new ArrayBuffer(8 * 4);
	const toneUniform = new Float32Array(toneBytes);
	const compositeBinds = {
		0: {
			0: { uniform: toneBytes },
			1: { texture: radianceBytes, descriptor: { size: [W, H], format: 'rgba32float' } },
		},
	};
	const compositeCode = shaders.SHADERS['tonemap'];
	const mirror = mirrorLib.loadTonemap(shaders);

	function composite(px, py, rgb, params) {
		const i = (py * W + px) * 4;
		radiance[i] = rgb[0]; radiance[i + 1] = rgb[1]; radiance[i + 2] = rgb[2]; radiance[i + 3] = 0;
		toneUniform[0] = params.exposure;
		toneUniform[1] = params.whitePoint;
		toneUniform[2] = params.saturation;
		toneUniform[3] = params.outputMode;
		toneUniform[4] = params.headroom === undefined ? 8 : params.headroom;
		toneUniform[5] = params.highlightDesat === undefined ? 1 : params.highlightDesat;
		const out = runStage(compositeCode, 'fs_main', 'debugFragment',
			{ position: [px + 0.5, py + 0.5, 0, 1] }, compositeBinds);
		radiance[i] = 0; radiance[i + 1] = 0; radiance[i + 2] = 0;
		return out;
	}

	const DEF = { exposure: 1.0, whitePoint: 4.0, saturation: 1.0, outputMode: 1.0, headroom: 8.0, highlightDesat: 1.0 };
	const gain = [];
	let gains = true;
	let bounded = true;
	let matchesModel = true;
	for (const n of [1, 2, 4, 8, 32, 256, 1024, 8192]) {
		const out = composite(8, 8, [one * n, one * n, one * n], DEF);
		const model = mirrorLib.tonemapPixel(mirror, one * n, one * n, one * n, DEF);
		if (Math.abs(out[0] - model[0]) > 1e-4) matchesModel = false;
		if (out[0] > 8.0 + 1e-5) bounded = false;
		gain.push({ stars: n, accumulated: +(one * n).toFixed(3), display: +out[0].toFixed(5) });
		if (n > 1 && out[0] <= gain[gain.length - 2].display + 1e-9 && out[0] < 7.999) gains = false;
	}
	check('the tonemap pass matches the JS pixel model for every pile-up', matchesModel, gain);
	check('stacking stars on one pixel brightens it, right up to the ceiling', gains, gain);
	check('and never exceeds the HDR ceiling of 8', bounded, gain);
	check('the pile-up actually spans the display range instead of pinning at the ceiling',
		gain[gain.length - 1].display > 2 * gain[0].display,
		{ first: gain[0].display, last: gain[gain.length - 1].display });
	console.log('    pile-up:', gain.map(g => `${g.stars}*=${g.display}`).join('  '));

	// The bug this replaced: a display curve applied per sprite, then summed.
	// Each sprite arrived already flattened, so once the pile-up clips under
	// the old model, every larger pile-up reads the same white.
	const perSprite = one / (1 + one);
	const clipAt = Math.ceil(1 / perSprite);   // first n where the old model clips
	const counts = [clipAt, clipAt * 2, clipAt * 8];
	const oldSum = counts.map(n => Math.min(perSprite * n, 1.0));
	check(`the old per-sprite curve could not tell ${counts[0]} faint stars from ${counts[2]}`,
		oldSum[0] === oldSum[1] && oldSum[1] === oldSum[2], oldSum);
	const nowSum = counts.map(n => composite(8, 8, [one * n, one * n, one * n], DEF)[0]);
	check('the linear frame separates them',
		nowSum[0] < nowSum[1] && nowSum[1] < nowSum[2], nowSum.map(v => +v.toFixed(4)));

	// --- 4. The user knobs land where the model says -----------------------
	const grey = composite(8, 8, [one * 64, one * 32, one * 16], { ...DEF, saturation: 0.0 });
	check('saturation 0 collapses to grey',
		Math.abs(grey[0] - grey[1]) < 1e-5 && Math.abs(grey[1] - grey[2]) < 1e-5, grey);
	const sdr = composite(8, 8, [1e5, 1e5, 1e5], { ...DEF, outputMode: 0.0 });
	check('the SDR path clamps an over-flowed accumulation at 1, not at NaN',
		Number.isFinite(sdr[0]) && Math.abs(sdr[0] - 1.0) < 1e-6, sdr);
	const hdrMax = composite(8, 8, [1e5, 1e5, 1e5], DEF);
	check('the HDR path clamps at 8 so the extended swapchain gets a finite value',
		Number.isFinite(hdrMax[0]) && Math.abs(hdrMax[0] - 8.0) < 1e-6, hdrMax);
	const empty = composite(4, 4, [0, 0, 0], DEF);
	check('an empty frame is black, not NaN', empty.every(v => Number.isFinite(v)) && empty[0] < 1e-3, empty);

	// --- 4b. Headroom + highlight desat run on the shipping WGSL -----------
	// The same pixels hdr-test pins in the mirror, executed for real: pure
	// blue at desat 0 must survive to the peak untouched, the film default
	// must fade it to white, and the headroom knob must ceiling the output.
	{
		const knobCases = [
			{ rgb: [0, 0, 200], params: { ...DEF, highlightDesat: 0 } },
			{ rgb: [0, 0, 200], params: { ...DEF, highlightDesat: 0.5 } },
			{ rgb: [0, 0, 200], params: { ...DEF, highlightDesat: 1 } },
			{ rgb: [100, 100, 100], params: { ...DEF, headroom: 4 } },
			{ rgb: [100, 100, 100], params: { ...DEF, headroom: 1 } },
			{ rgb: [3, 1, 0.5], params: { ...DEF, headroom: 2, highlightDesat: 0.25 } },
		];
		let knobWorst = 0;
		let knobWorstCase = null;
		for (const kase of knobCases) {
			const out = composite(9, 9, kase.rgb, kase.params);
			const model = mirrorLib.tonemapPixel(mirror, ...kase.rgb, kase.params);
			for (let c = 0; c < 3; c++) {
				const err = Math.abs(out[c] - model[c]);
				if (err > knobWorst) { knobWorst = err; knobWorstCase = { rgb: kase.rgb, out, model }; }
			}
		}
		check('on-WGSL: the knob pixels match the JS mirror (< 2e-3)',
			knobWorst < 2e-3, { worst: knobWorst, kase: knobWorstCase });
		const pure = composite(9, 9, [0, 0, 200], { ...DEF, highlightDesat: 0 });
		check('on-WGSL: desat 0 keeps (0, 0, 200) pure blue to the peak',
			pure[0] < 1e-6 && pure[1] < 1e-6 && Math.abs(pure[2] - 8) < 1e-6, pure);
		const capped = composite(9, 9, [100, 100, 100], { ...DEF, headroom: 4 });
		check('on-WGSL: headroom 4 ceilings the same pile-up at exactly 4',
			capped[0] === 4 && capped[1] === 4 && capped[2] === 4, capped);
	}

	// Execute the real density functions, not just their struct declarations.
	const density = require('../src/math/density.js');
	// sampleLocalAge lives in the procedural module because it is only used by
	// star generation. Extract the shipping function instead of maintaining a
	// second WGSL copy in this experiment, then probe it beside the density part.
	// Since 0.3.3 the age is a chain — sampleLocalAge → the component's formation
	// window → the truncated SFH's inverse → its CDF — so the whole chain comes
	// along, with the two consts it reads.
	function extractFunction(source, name) {
		const start = source.indexOf(`fn ${name}`);
		if (start < 0) throw new Error(`missing WGSL function ${name}`);
		const open = source.indexOf('{', start);
		let depth = 0;
		for (let i = open; i < source.length; i++) {
			if (source[i] === '{') depth++;
			if (source[i] === '}') {
				depth--;
				if (depth === 0) return source.slice(start, i + 1);
			}
		}
		throw new Error(`unterminated WGSL function ${name}`);
	}
	function extractConst(source, name) {
		const found = new RegExp(`^const\\s+${name}\\s*:[^;]+;`, 'm').exec(source);
		if (!found) throw new Error(`missing WGSL const ${name}`);
		return found[0];
	}
	const genSource = shaders.SHADER_PARTS['procedural-gen'];
	// Consts first, then the chain in the order the shader declares it.
	const ageFunction = ['SFH_BISECT_STEPS', 'YOUNG_ARM_MAX_GYR']
		.map((name) => extractConst(genSource, name)).join('\n')
		+ '\n' + ['sfhCumulative', 'sfhFormationTime', 'sampleFormationTime', 'sampleLocalAge']
			.map((name) => extractFunction(genSource, name)).join('\n');
	const densityCode = shaders.SHADER_PARTS.density + '\n' + ageFunction + `
@group(0) @binding(0) var<uniform> model: DensityParams;
@fragment fn densityProbe(@location(0) p: vec3f) -> @location(0) vec4f {
	return rhoDecomposed(model, p.x, p.y, p.z);
}
@fragment fn armProbe(@location(0) p: vec2f) -> @location(0) vec4f {
	return vec4f(armFactor(model, p.x, p.y), distanceToNearestArm(model, p.x, p.y), 0.0, 0.0);
}
@fragment fn ageProbe(@location(0) p: vec4f, @location(1) q: vec4f) -> @location(0) vec4f {
	// sampleLocalAge(model, component, distToArm, R, u1, u2, zOverH)
	return vec4f(sampleLocalAge(model, u32(p.x), p.y, p.z, p.w, q.x, q.y), 0.0, 0.0, 0.0);
}
`;
	const modelBuffer = new Float32Array(galaxy.DENSITY_PARAMS_FLOATS);
	const densityBinds = { 0: { 0: { uniform: modelBuffer.buffer } } };
	const models = galaxy.GALAXY_TYPES.map((type) => galaxy.createGalaxy({ type }));
	models.push(galaxy.createGalaxy({ type: 'Sc', overrides: {
		centre: { x: 3, y: -2, z: 4 }, spheroid: { r0: 2.3, tiltDeg: 31 },
		halo: { power: 3, rMax: 8 }, arms: { minRadius: 2, phase0: 1.4 },
	} }));
	// The shape machinery, executed for real: flocculence under a non-default
	// seed (the uniform's noiseSeed slot), a flared and cored disc, and an
	// override with per-group flare/core values that differ — the old
	// cross-wired layout passed that one only because table types happened to
	// carry identical values.
	models.push(galaxy.createGalaxy({ type: 'Sc', seed: 7 }));
	models.push(galaxy.createGalaxy({ type: 'Sd', seed: 11 }));
	models.push(galaxy.createGalaxy({ type: 'Sb', overrides: {
		thin: { flare: 0.3, coreRadius: 0.8 }, thick: { flare: 0.1 },
	} }));
	// A young-epoch bar (0.6 E3): the axes have shrunk by the assembled mass's
	// cube root, the arm anchor has ridden the tip and phase0 carries the
	// additive re-anchor K·ln(size). The mirror reads the same packed numbers,
	// so the parity has to hold at the moved ridge and the shorter bar too.
	models.push(galaxy.modelAtAge(galaxy.MILKY_WAY, 2));
	for (const model of models) {
		galaxy.packDensityParams(model, modelBuffer);
		const n = galaxy.GALAXY_TYPES.length;
		const name = model.centre.z === 4 ? 'shifted/scaled/phase-shifted Sc'
			: (model === models[n + 1] ? 'flocculent Sc, seed 7'
			: (model === models[n + 2] ? 'flared/cored Sd'
			: (model === models[n + 3] ? 'asymmetric flare/core Sb'
			: (model === models[n + 4] ? 'the preset at a 2 Gyr epoch' : model.type))));
		const offsets = [[0, 0, 0], [0.005, 0, 0], [4.1, 1.3, 0.2], [-8, 0.4, -0.3], [model.halo.rMax + 1, 0, 0]];
		if (model.clumps && model.clumps.length > 0) {
			// A clump centre: the hotspot boost and the FBM texture live there.
			offsets.push([model.clumps[0].x, model.clumps[0].y, model.clumps[0].z]);
			offsets.push([model.clumps[1].x, model.clumps[1].y, model.clumps[1].z]);
		}
		if (model.spheroid.profileId === density.PROFILE_BAR) {
			// Points in the bar's own frame: inside the end cap, inside a lobe's
			// vertical reach, off-axis in the cross-section, and just past the tip.
			// The generic offsets only ever probe the bar's centre, where the peanut
			// and the cap are both inert.
			const sp = model.spheroid;
			const tilt = sp.tiltDeg * Math.PI / 180;
			const ct = Math.cos(tilt);
			const st = Math.sin(tilt);
			const A = sp.a * sp.r0;
			const B = sp.b * sp.r0;
			const C = sp.c * sp.r0;
			const tip = density.barTipRadius(model);
			const reach = density.barCrossSectionRadius(model, 0.6, tip) * density.barVerticalStretch(model, 0.6);
			offsets.push([0.75 * A * ct, 0.75 * A * st, 0]);
			offsets.push([0.7 * A * ct - 0.5 * B * st, 0.7 * A * st + 0.5 * B * ct, 0]);
			offsets.push([0.6 * A * ct, 0.6 * A * st, 0.9 * C * reach]);
			offsets.push([1.02 * A * ct, 1.02 * A * st, 0]);
		}
		let worst = 0;
		let worstCase = null;
		for (const offset of offsets) {
			const p = [offset[0] + model.centre.x, offset[1] + model.centre.y, offset[2] + model.centre.z].map(Math.fround);
			const actual = runStage(densityCode, 'densityProbe', 'debugFragment', { 0: p }, densityBinds);
			// includeClumps true: the shader always evaluates the full field.
			const expected = density.rhoDecomposed(model, p[0], p[1], p[2], true);
			for (let c = 0; c < 4; c++) {
				const value = expected[density.COMPONENT_NAMES[c]];
				const error = Math.abs(actual[c] - value) / Math.max(1e-5, value);
				if (error > worst) { worst = error; worstCase = { p, component: c, actual: actual[c], expected: value }; }
			}
		}
		check(`${name}: executed density WGSL matches JS components`, worst < 0.002, { worst, worstCase });
		let armError = 0;
		for (const r of [model.arms.minRadius / 2, 4, 10]) {
			const ridge = density.armRidgeAzimuth(model, r);
			const p = [r, ridge].map(Math.fround);
			const actual = runStage(densityCode, 'armProbe', 'debugFragment', { 0: p }, densityBinds);
			armError = Math.max(armError, Math.abs(actual[0] - density.armFactor(model, ...p)),
				Math.abs(actual[1] - density.distanceToNearestArm(model, ...p)));
		}
		check(`${name}: executed WGSL arm threshold and phase match JS`, armError < 2e-4, { armError });
	}

	// sampleLocalAge parity: the thin-disc arm branch is a Gaussian ridge gate on
	// (distToArm, R, u1, u2) and closed-form, so it has to agree to f32 rounding;
	// everything else is `age − t_f`, where the CPU answers from a 1025-entry
	// inverse table and the shader bisects the same CDF in 14 f32 steps. Those two
	// inverses agree to the table's own interpolation error, so the SFH branch is
	// held to an absolute 0.05 Gyr — a floor far below anything downstream reads,
	// since evolution states flip on main-sequence lifetimes.
	{
		const starTypes = require('../src/math/star-types.js');
		const probes = [
			[density.COMPONENT_THIN, 0.1, 8, 0.3, 0.3, 0],   // young arm branch, midplane
			// Two probes inside the branch's own width, one on each side of the
			// Milky Way's old fixed 0.3 kpc cut: the outer one is young only
			// because sigma scales with the pattern, the inner one is not.
			[density.COMPONENT_THIN, 0.45, 8, 0.45, 0.45, 0],
			[density.COMPONENT_THIN, 0.35, 4, 0.4, 0.4, 0],
			[density.COMPONENT_THIN, 0.3, 5, 0.5, 0.6, 0],   // mid-ridge
			[density.COMPONENT_THIN, 1.2, 8, 0.2, 0.1, 0],   // off-ridge (gate fails)
			[density.COMPONENT_THIN, 0.1, 20, 0.4, 0.2, 0],  // R past youngOuterR
			[density.COMPONENT_THICK, 0.1, 8, 0.7, 0.5, 0],
			[density.COMPONENT_BULGE, 0.1, 1, 0.5, 0.5, 0],
			[density.COMPONENT_HALO, 99, 30, 0.9, 0.1, 0],
			// Two scale heights up the arm gate is closed and the heating floor
			// is the age. zOverH is the sixth component (q.y).
			[density.COMPONENT_THIN, 0.05, 8, 0.2, 0.01, 2],
		];
		// The clock is part of what the shader reads, so the probes cover more than
		// the reference epoch: a 1 Gyr Sc truncates a wide SFH early, and an E4 at
		// 0.5 Gyr is mid-burst with its span cut by quenching (τ = 0.4, span = 0.5)
		// — the two shapes the bisection has to get right that a 13.5 Gyr galaxy
		// never asks about.
		const sc = models[galaxy.GALAXY_TYPES.indexOf('Sc')];
		const e4 = models[galaxy.GALAXY_TYPES.indexOf('E4')];
		for (const model of [sc, e4, galaxy.modelAtAge(sc, 1), galaxy.modelAtAge(e4, 0.5)]) {
			galaxy.packDensityParams(model, modelBuffer);
			const label = `${model.type} at ${model.populations.age} Gyr`;
			let worstArm = 0;
			let worstSfh = 0;
			let armProbes = 0;
			let sfhProbes = 0;
			for (const [component, dArm, R, u1, u2, zOverH] of probes) {
				const actual = runStage(densityCode, 'ageProbe', 'debugFragment',
					{ 0: [component, dArm, R, u1].map(Math.fround), 1: [u2, zOverH, 0, 0].map(Math.fround) }, densityBinds);
				const expected = starTypes.sampleLocalAge(model, component, dArm, R, u1, u2, zOverH);
				// Which branch JS took decides the tolerance, and it is read off the
				// branch's own closed form rather than guessed from the probe list.
				const armAge = Math.min(model.populations.age,
					Math.pow(u1, 3.0) * starTypes.YOUNG_ARM_MAX_GYR);
				if (component === density.COMPONENT_THIN && expected === armAge) {
					armProbes++;
					worstArm = Math.max(worstArm, Math.abs(actual[0] - expected) / Math.max(1e-3, expected));
				} else {
					sfhProbes++;
					worstSfh = Math.max(worstSfh, Math.abs(actual[0] - expected));
				}
			}
			// A model that can reach the arm branch has to have taken it at least
			// once, or the check below would be passing on nothing. Reaching it
			// needs gas *and* a pattern: an E4 mid-burst is gas-rich (0.196 of its
			// reservoir is still cold) but has no arms at all, so its O/B stars come
			// from the field branch — distToArm is 99 where there is no ridge, and
			// the gate never opens.
			const armReachable = model.populations.gasRich && model.arms.amp > 0;
			check(`${label}: executed sampleLocalAge WGSL matches JS on the arm branch`,
				worstArm < 2e-3 && (armProbes > 0) === armReachable,
				{ worstArm: +worstArm.toFixed(6), armProbes, armReachable });
			check(`${label}: executed sampleLocalAge WGSL matches JS on the SFH branch`,
				worstSfh < 0.05 && sfhProbes > 0, { worstSfhGyr: +worstSfh.toFixed(5), sfhProbes });
		}
		// The chain underneath, probed on its own: the same q has to invert to the
		// same formation time on both sides, at both ends of the span where the
		// bisection has least room.
		{
			galaxy.packDensityParams(sc, modelBuffer);
			const sfhCode = shaders.SHADER_PARTS.density + '\n' + ageFunction + `
@group(0) @binding(0) var<uniform> model: DensityParams;
@fragment fn sfhProbe(@location(0) p: vec4f) -> @location(0) vec4f {
	return vec4f(sfhCumulative(p.x), sampleFormationTime(model, u32(p.y), p.z), 0.0, 0.0);
}
`;
			let worstF = 0;
			let worstT = 0;
			for (const x of [0, 0.05, 0.5, 1, 2.7, 10]) {
				const actual = runStage(sfhCode, 'sfhProbe', 'debugFragment',
					{ 0: [x, 0, 0, 0].map(Math.fround) }, densityBinds);
				worstF = Math.max(worstF, Math.abs(actual[0] - galaxy.sfhCumulative(x)));
			}
			for (const component of [0, 1, 2, 3]) {
				for (const u of [0, 0.25, 0.5, 0.75, 1]) {
					const actual = runStage(sfhCode, 'sfhProbe', 'debugFragment',
						{ 0: [0, component, u, 0].map(Math.fround) }, densityBinds);
					worstT = Math.max(worstT,
						Math.abs(actual[1] - starTypes.sampleFormationTime(sc, component, u)));
				}
			}
		check('executed sfhCumulative WGSL matches galaxy.js', worstF < 1e-6, { worst: +worstF.toExponential(2) });
		check('executed sampleFormationTime WGSL matches the CPU inverse table',
			worstT < 0.05, { worstGyr: +worstT.toFixed(5) });
		}
	}

	// --- 6. The evolution branch runs on the shipping WGSL ------------------
	// The branch itself is inline in the procedural-gen compute entry, so it
	// cannot run verbatim — but every number it touches comes from the four
	// extracted primitives and their constants, which do run here, inside a
	// probe that repeats the branch line for line with the two hash rolls as
	// inputs. The JS side is the real deriveStarWithAge (the private evolveStar
	// behind it), fed seeds whose mass and rolls are read off the same hash
	// channels the field stars use — no replication on either side except the
	// probe's branch body. Seeds stay clear of the state boundaries (2%) and
	// of the 8 Msun remnant divide, so an f32/f64 flip cannot fake a failure.
	{
		const starTypes = require('../src/math/star-types.js');
		const hash = require('../src/math/hash.js');
		const evoConsts = ['LOG2_OVER_LOG10', 'MASS_TEFF_MASS', 'MASS_TEFF_TEFF',
			'TGIANT_FRAC', 'TGIANT_MIN', 'TGIANT_MAX',
			'WD_COOL_TAU', 'WD_TEFF_FLOOR', 'WD_LUM_FLOOR']
			.map((name) => extractConst(genSource, name)).join('\n');
		const evoFns = ['luminosityFromMass', 'teffFromMass', 'msLifetimeGyr', 'giantLifetimeGyr']
			.map((name) => extractFunction(genSource, name)).join('\n');
		const evoCode = evoConsts + '\n' + evoFns + `
@fragment fn evoProbe(@location(0) p: vec4f) -> @location(0) vec4f {
	let mass: f32 = p.x;
	let age: f32 = p.w;
	var state: u32 = 0u;
	var teff: f32 = teffFromMass(mass);
	var lum: f32 = luminosityFromMass(mass);
	let tMS: f32 = msLifetimeGyr(mass);
	let tDeath: f32 = tMS * 1.1 + giantLifetimeGyr(mass);
	if (age > tDeath) {
		state = 1u;
		let cool: f32 = exp(-(age - tDeath) / WD_COOL_TAU);
		teff = WD_TEFF_FLOOR + (8000.0 + 30000.0 * p.y - WD_TEFF_FLOOR) * cool;
		lum = WD_LUM_FLOOR + (0.001 + 0.1 * p.z) * cool;
	} else if (age > tMS * 1.1) {
		if (mass >= 8.0) {
			state = 1u;
			teff = 8000.0 + 30000.0 * p.y;
			lum = 0.001 + 0.1 * p.z;
		} else {
			state = 2u;
			teff = 3000.0 + 1000.0 * p.y;
			lum = 100.0 + 10000.0 * p.z;
		}
	}
	let absMag: f32 = 4.83 - 2.5 * log2(max(1e-6, lum)) / LOG2_OVER_LOG10;
	return vec4f(lum, teff, f32(state), absMag);
}
`;
		const evoModel = galaxy.createGalaxy({ type: 'SBb' });
		const evoOut = {};
		const stateId = { ms: 0, wd: 1, giant: 2 };
		const evoProbes = [];
		for (const age of [11.35, 0.5]) {
			const buckets = { ms: [], giant: [], wd: [], massive: [] };
			for (let seed = 1; seed < 30000
				&& buckets.ms.length + buckets.giant.length + buckets.wd.length + buckets.massive.length < 12; seed++) {
				const mass = starTypes.sampleMassIMF(hash.hash01(seed * 31 + 1));
				if (Math.abs(mass - 8) < 0.05) continue;
				const tMS = starTypes.msLifetimeGyr(mass);
				const tDeath = tMS * 1.1 + starTypes.giantLifetimeGyr(mass);
				if (Math.abs(age - tDeath) / tDeath < 0.02) continue;
				if (Math.abs(age - tMS * 1.1) / (tMS * 1.1) < 0.02) continue;
				starTypes.deriveStarWithAge(evoModel, seed, density.COMPONENT_THIN, 8, 99, age, evoOut);
				const key = mass >= 8 ? 'massive' : evoOut.state;
				if (buckets[key].length < 3) {
					buckets[key].push({
						mass, uA: hash.hash01(seed * 31 + 4), uB: hash.hash01(seed * 31 + 5),
						age, lum: evoOut.luminosity, teff: evoOut.teff,
						state: evoOut.state, absMag: evoOut.absMag, seed,
					});
				}
			}
			evoProbes.push({ age, buckets });
		}
		let evoCovered = true;
		let evoWorstLum = 0;
		let evoWorstTeff = 0;
		let evoWorstMag = 0;
		let evoWorst = null;
		let evoStates = true;
		for (const { age, buckets } of evoProbes) {
			for (const key of ['ms', 'giant', 'wd', 'massive']) {
				if (buckets[key].length === 0) { evoCovered = false; continue; }
				for (const probe of buckets[key]) {
					const actual = runStage(evoCode, 'evoProbe', 'debugFragment',
						{ 0: [probe.mass, probe.uA, probe.uB, probe.age].map(Math.fround) }, {});
					if (actual[2] !== stateId[probe.state]) { evoStates = false; continue; }
					const dLum = Math.abs(actual[0] - probe.lum) / probe.lum;
					const dTeff = Math.abs(actual[1] - probe.teff) / probe.teff;
					const dMag = Math.abs(actual[3] - probe.absMag);
					if (dLum > evoWorstLum || dTeff > evoWorstTeff || dMag > evoWorstMag) {
						evoWorstLum = Math.max(evoWorstLum, dLum);
						evoWorstTeff = Math.max(evoWorstTeff, dTeff);
						evoWorstMag = Math.max(evoWorstMag, dMag);
						evoWorst = { age, key, seed: probe.seed, actual, probe };
					}
				}
			}
		}
		check('the seed scan covers ms/giant/wd/massive at both epochs', evoCovered,
			evoProbes.map(({ age, buckets }) => ({ age,
				ms: buckets.ms.length, giant: buckets.giant.length,
				wd: buckets.wd.length, massive: buckets.massive.length })));
		check('executed evolution WGSL picks the same state as deriveStarWithAge', evoStates, evoWorst);
		check('executed evolution WGSL matches lum/teff (< 1e-3) and absMag (< 0.01)',
			evoWorstLum < 1e-3 && evoWorstTeff < 1e-3 && evoWorstMag < 0.01,
			{ worstLum: +evoWorstLum.toExponential(2), worstTeff: +evoWorstTeff.toExponential(2),
				worstMag: +evoWorstMag.toExponential(2), kase: evoWorst });
	}

	report('the shipping WGSL preserves radiance and matches the parameterised density model');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
