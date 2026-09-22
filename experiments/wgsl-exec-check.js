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

const fs = require('fs');
const path = require('path');

globalThis.window = globalThis;
require('../src/math/star-record.js');
require('../src/render/shaders.js');

const records = require('../src/math/star-record.js');
const shaders = require('../src/render/shaders.js');
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
	fs.mkdirSync(path.dirname(logPath), { recursive: true });
	fs.writeFileSync(logPath, JSON.stringify({
		date: new Date().toISOString(),
		interpreter: 'wgsl_reflect',
		totalChecks: checks.length,
		passed,
		failed,
		checks,
	}, null, 2));
	console.log(`Wrote ${logPath}`);
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
	const cameraBytes = new ArrayBuffer(28 * 4);
	const cam = new Float32Array(cameraBytes);
	cam.set(viewProj, 0);
	cam[20] = 1920; cam[21] = 1080; cam[22] = 2 / 1920; cam[23] = 2 / 1080;
	cam[24] = MAG_ZERO; cam[25] = BASE_SIZE_PX; cam[26] = MAX_SIZE_PX; cam[27] = 0;

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
	const toneBytes = new ArrayBuffer(4 * 4);
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
		const out = runStage(compositeCode, 'fs_main', 'debugFragment',
			{ position: [px + 0.5, py + 0.5, 0, 1] }, compositeBinds);
		radiance[i] = 0; radiance[i + 1] = 0; radiance[i + 2] = 0;
		return out;
	}

	const DEF = { exposure: 1.0, whitePoint: 4.0, saturation: 1.0, outputMode: 1.0 };
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

	// Execute the real density functions, not just their struct declarations.
	const galaxy = require('../src/math/galaxy.js');
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
	// sampleLocalAge(model, component, distToArm, R, u1, u2)
	return vec4f(sampleLocalAge(model, u32(p.x), p.y, p.z, p.w, q.x), 0.0, 0.0, 0.0);
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
	for (const model of models) {
		galaxy.packDensityParams(model, modelBuffer);
		const n = galaxy.GALAXY_TYPES.length;
		const name = model.centre.z === 4 ? 'shifted/scaled/phase-shifted Sc'
			: (model === models[n + 1] ? 'flocculent Sc, seed 7'
			: (model === models[n + 2] ? 'flared/cored Sd'
			: (model === models[n + 3] ? 'asymmetric flare/core Sb' : model.type)));
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
			[density.COMPONENT_THIN, 0.1, 8, 0.3, 0.3],   // young arm branch
			// Two probes inside the branch's own width, one on each side of the
			// Milky Way's old fixed 0.3 kpc cut: the outer one is young only
			// because sigma scales with the pattern, the inner one is not.
			[density.COMPONENT_THIN, 0.45, 8, 0.45, 0.45],
			[density.COMPONENT_THIN, 0.35, 4, 0.4, 0.4],
			[density.COMPONENT_THIN, 0.3, 5, 0.5, 0.6],   // mid-ridge
			[density.COMPONENT_THIN, 1.2, 8, 0.2, 0.1],   // off-ridge (gate fails)
			[density.COMPONENT_THIN, 0.1, 20, 0.4, 0.2],  // R past youngOuterR
			[density.COMPONENT_THICK, 0.1, 8, 0.7, 0.5],
			[density.COMPONENT_BULGE, 0.1, 1, 0.5, 0.5],
			[density.COMPONENT_HALO, 99, 30, 0.9, 0.1],
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
			for (const [component, dArm, R, u1, u2] of probes) {
				const actual = runStage(densityCode, 'ageProbe', 'debugFragment',
					{ 0: [component, dArm, R, u1].map(Math.fround), 1: [u2, 0, 0, 0].map(Math.fround) }, densityBinds);
				const expected = starTypes.sampleLocalAge(model, component, dArm, R, u1, u2);
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

	report('the shipping WGSL preserves radiance and matches the parameterised density model');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
