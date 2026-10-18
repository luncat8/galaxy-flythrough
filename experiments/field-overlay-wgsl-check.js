// experiments/field-overlay-wgsl-check.js
// The view field overlay, executed: the splat, the blur and the composite are
// the shipping WGSL, run through wgsl_reflect's interpreter, so the claim the
// overlay makes is checked on the code the GPU runs.
//
// The claim: the colour under a star is that star's own distance. The splat
// writes a weighted log-distance for every star the sprite pass draws, the
// blur smooths the moments, and the composite maps the mean through the
// declared range and the ramp. Three ways that can go wrong, all of them
// invisible in a text review:
//
//   * the splat projects through a different matrix than the sprite pass, so
//     the map describes a sky the app never draws;
//   * the composite samples the field with the wrong grid — a canvas pixel
//     divided by the *field* width reads three times outside the texture, so
//     the screen shows the field's edge column and no star sits on its own
//     colour;
//   * the range or the ramp is off, so the colour stops meaning the value the
//     legend quotes.
//
// Needs one dev-only dependency, which is why it is not part of `all-tests`:
//
//	npm install wgsl_reflect        # at the repo root
//	python3 scripts/run.py field-overlay-wgsl
//
// Output: experiments/logs/field-overlay-wgsl.json

'use strict';

const fs = require('fs');
const path = require('path');

globalThis.window = globalThis;
require('../src/math/star-record.js');
require('../src/render/shaders.js');

const records = require('../src/math/star-record.js');
const shaders = require('../src/render/shaders.js');
const cameraMod = require('../src/core/camera.js');
const fieldOverlay = require('../src/math/field-overlay.js');
const fieldRamp = require('../src/math/field-ramp.js');

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
	const logPath = path.join(__dirname, 'logs', 'field-overlay-wgsl.json');
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

// --- the fixture ----------------------------------------------------------
//
// A canvas that is not square, an eye that is not at the origin, and a look
// direction that is not along an axis: the three things a projection gets
// wrong. Four stars, each alone in its own quarter of the frame, at four
// distances — so the field value under a star is that star's own distance
// and nothing else, and the colour under it can be checked exactly.
const CANVAS_W = 320;
const CANVAS_H = 180;
const FIELD_W = 64;
const FIELD_H = 36;
const EYE = [0.11, -0.07, 0.03];          // kpc, off the origin
const YAW = 0.31;                         // rad
const PITCH = -0.19;                      // rad
const STARS = [
	{ name: 'near', d: 0.25, az: -0.35, el: 0.28 },
	{ name: 'mid', d: 0.6, az: 0.42, el: -0.22 },
	{ name: 'far', d: 1.4, az: -0.12, el: -0.34 },
	{ name: 'farthest', d: 2.6, az: 0.18, el: 0.33 },
];

// The camera: the app's own, so the matrix under test is the one the renderer
// uploads. Nothing here re-derives a projection.
const camera = cameraMod.createCamera();
camera.setState({ position: EYE, yaw: YAW, pitch: PITCH });
const viewProj = camera.buildViewProj(CANVAS_W / CANVAS_H);

// The camera uniform, exactly as the renderer packs it: the matrix, the eye,
// the viewport, the sprite knobs, then the orbit lanes (left at zero — the
// engine mask 0 is the identity baseline, so the stars stay where the
// fixture put them and the expected positions are known).
const CAMERA_FLOATS = 52;
const cameraBytes = new ArrayBuffer(CAMERA_FLOATS * 4);
{
	const cam = new Float32Array(cameraBytes);
	cam.set(viewProj, 0);
	cam[16] = EYE[0]; cam[17] = EYE[1]; cam[18] = EYE[2];
	cam[20] = CANVAS_W; cam[21] = CANVAS_H;
	cam[22] = 2 / CANVAS_W; cam[23] = 2 / CANVAS_H;
	cam[24] = 5.0;          // magZero
	cam[25] = 2.0;          // base size px
	cam[26] = 12.0;         // max size px
	cam[27] = 0;            // star time
	// 28..47: the orbit dynamics and the engine lane stay zero (mask 0).
	// 48..51: the epoch lane stays the identity (0, 1, 1, 0).
}

// The star records: visible, no epoch bit, the colour index of a G star.
const starBytes = new ArrayBuffer(STARS.length * 16);
{
	const f = new Float32Array(starBytes);
	const u = new Uint32Array(starBytes);
	STARS.forEach((star, i) => {
		// The star's world position: the eye, then the direction the camera
		// looks, offset by the star's own azimuth/elevation.
		const v = worldOf(star);
		f[i * 4] = v[0]; f[i * 4 + 1] = v[1]; f[i * 4 + 2] = v[2];
		u[i * 4 + 3] = (records.FLAG_VISIBLE << 16) | (records.encodeAbsMag(6.0) << 8) | 4;
	});
}

// The splat uniform: the footprint radius in field texels, the field's own
// size, the 1 pc distance floor.
const splatBytes = new ArrayBuffer(16);
{
	const u = new Float32Array(splatBytes);
	fieldOverlay.packSplat(u, 6, FIELD_W, FIELD_H);
}

// The theta buffer the simple engine owns (never read under mask 0).
const thetaBytes = new ArrayBuffer(STARS.length * 4);

// Where a star sits in the world, given the camera's own basis.
function worldOf(star) {
	const fwd = camera.forward;
	const right = camera.right;
	const up = camera.up;
	const c = Math.cos(star.az), s = Math.sin(star.az);
	const ce = Math.cos(star.el), se = Math.sin(star.el);
	const dx = ce * c, dy = ce * s, dz = se;
	return [
		EYE[0] + star.d * (fwd[0] * dx + right[0] * dy + up[0] * dz),
		EYE[1] + star.d * (fwd[1] * dx + right[1] * dy + up[1] * dz),
		EYE[2] + star.d * (fwd[2] * dx + right[2] * dy + up[2] * dz),
	];
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
	const { WgslDebug } = lib;

	function runStage(code, entry, stage, inputs, binds) {
		const dbg = new WgslDebug(code);
		if (!dbg[stage](entry, inputs, binds)) throw new Error(`${stage} setup failed for ${entry}`);
		let steps = 0;
		while (dbg.stepNext() && steps < 1e6) steps++;
		return dbg.getReturnValue ? dbg.getReturnValue() : dbg._returnValue;
	}

	// One interpreter per shader, reused: parsing the module is the expensive
	// part, and the blur runs once per field texel.
	function stageFor(code) {
		const dbg = new WgslDebug(code);
		return {
			vertex(entry, inputs, binds) {
				if (!dbg.debugVertex(entry, inputs, binds)) throw new Error(`vertex setup failed for ${entry}`);
				let steps = 0;
				while (dbg.stepNext() && steps < 1e6) steps++;
				return dbg.getReturnValue ? dbg.getReturnValue() : dbg._returnValue;
			},
			fragment(entry, inputs, binds) {
				if (!dbg.debugFragment(entry, inputs, binds)) throw new Error(`fragment setup failed for ${entry}`);
				let steps = 0;
				while (dbg.stepNext() && steps < 1e6) steps++;
				return dbg.getReturnValue ? dbg.getReturnValue() : dbg._returnValue;
			},
		};
	}
	const splatStage = stageFor(shaders.SHADERS['field-splat']);
	const spriteStage = stageFor(shaders.SHADERS['star-sprite']);
	const blurStage = stageFor(shaders.SHADERS['field-blur']);
	const compositeStage = stageFor(shaders.SHADERS['field-composite']);

	// --- 1. The splat and the sprite project the same star the same way ---
	const splatCode = shaders.SHADERS['field-splat'];
	const spriteCode = shaders.SHADERS['star-sprite'];
	const splatBinds = {
		0: {
			0: { uniform: cameraBytes },
			1: starBytes,
			2: thetaBytes,
			3: { uniform: splatBytes },
		},
	};
	const spriteBinds = {
		0: {
			0: { uniform: cameraBytes },
			1: starBytes,
			2: { texture: records.buildColorLUT(), descriptor: { size: [256, 1], format: 'rgba8unorm' } },
			3: thetaBytes,
		},
	};

	// The centre of a quad is the average of its four corners: both passes
	// offset the projected point symmetrically.
	function centreOf(positions) {
		let x = 0, y = 0, w = 0;
		for (const p of positions) { x += p[0]; y += p[1]; w = p[2]; }
		return [x / positions.length, y / positions.length, w];
	}
	function clipOf(out) {
		const c = out.clipPos;
		return [c[0], c[1], c[2]];
	}

	let worstCentre = 0;
	let worstValue = 0;
	const centres = [];
	for (let i = 0; i < STARS.length; i++) {
		const splatCorners = [];
		const spriteCorners = [];
		let value = 0;
		for (let vid = 0; vid < 4; vid++) {
			const s = splatStage.vertex('vs_main',
				{ vertex_index: vid, instance_index: i }, splatBinds);
			splatCorners.push(clipOf(s));
			value = s.value;
			const p = spriteStage.vertex('vs_main',
				{ vertex_index: vid, instance_index: i }, spriteBinds);
			spriteCorners.push(clipOf(p));
		}
		const a = centreOf(splatCorners);
		const b = centreOf(spriteCorners);
		const gap = Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
		if (gap > worstCentre) worstCentre = gap;
		centres.push({ star: STARS[i].name, splat: a, sprite: b, gap });
		// The splat's value is the star's own log10 distance in kpc.
		const d = Math.hypot(
			worldOf(STARS[i])[0] - EYE[0],
			worldOf(STARS[i])[1] - EYE[1],
			worldOf(STARS[i])[2] - EYE[2]);
		const expect = Math.log10(Math.max(d, fieldOverlay.MIN_DIST_KPC));
		if (Math.abs(value - expect) > worstValue) worstValue = Math.abs(value - expect);
	}
	check('the field splat projects a star exactly where the sprite pass draws it',
		worstCentre < 1e-4, { worstCentre, centres });
	check('the splat carries the star\'s own log10 distance',
		worstValue < 1e-5, { worstValue });

	// --- 2. The range the legend quotes, from the CPU law -----------------
	// The same population, sampled by the overlay's own sampler.
	const rangeState = fieldOverlay.createRangeState();
	{
		const bytes = new ArrayBuffer(STARS.length * 16);
		const view = new DataView(bytes);
		const f = new Float32Array(bytes);
		const u = new Uint32Array(bytes);
		STARS.forEach((star, i) => {
			const v = worldOf(star);
			f[i * 4] = v[0]; f[i * 4 + 1] = v[1]; f[i * 4 + 2] = v[2];
			u[i * 4 + 3] = (records.FLAG_VISIBLE << 16) | (records.encodeAbsMag(6.0) << 8) | 4;
		});
		fieldOverlay.refresh(rangeState, {
			blocks: { view, blocks: [{ kind: 'field', offset: 0, count: STARS.length }] },
			recordBytes: 16,
			orbit: null,
			model: null,
			time: 0,
			camX: EYE[0], camY: EYE[1], camZ: EYE[2],
		}, fieldOverlay.MODE_HEIGHT);
	}
	const lo = rangeState.lo;
	const hi = rangeState.hi;
	check('the declared range holds every star of the fixture',
		STARS.every((star) => {
			const v = worldOf(star);
			const d = Math.hypot(v[0] - EYE[0], v[1] - EYE[1], v[2] - EYE[2]);
			const l = Math.log10(Math.max(d, fieldOverlay.MIN_DIST_KPC));
			return l >= lo && l <= hi;
		}), { lo, hi });

	// --- 3. Splat, blur, composite — the shipping passes ------------------
	// The splat target: additive moments, one quad per star.
	const splatTex = new Float32Array(FIELD_W * FIELD_H * 4);
	const splatTexBytes = new Uint8Array(splatTex.buffer);
	for (let i = 0; i < STARS.length; i++) {
		const corners = [];
		let value = 0;
		for (let vid = 0; vid < 4; vid++) {
			const s = splatStage.vertex('vs_main',
				{ vertex_index: vid, instance_index: i }, splatBinds);
			corners.push(clipOf(s));
			value = s.value;
		}
		const c = centreOf(corners);
		const ndcX = c[0] / c[2];
		const ndcY = c[1] / c[2];
		// Where the star lands in the field's own grid, and how big its
		// footprint is there.
		const fx = (ndcX * 0.5 + 0.5) * FIELD_W;
		const fy = (0.5 - ndcY * 0.5) * FIELD_H;
		const radius = new Float32Array(splatBytes)[0];
		// The quad's corners sit one radius from the centre, in the field's
		// own pixels: the offset is scaled by 2/fieldW, so a radius of R is R
		// pixels wide on each side.
		const x0 = Math.max(0, Math.floor(fx - radius));
		const x1 = Math.min(FIELD_W - 1, Math.ceil(fx + radius));
		const y0 = Math.max(0, Math.floor(fy - radius));
		const y1 = Math.min(FIELD_H - 1, Math.ceil(fy + radius));
		for (let py = y0; py <= y1; py++) {
			for (let px = x0; px <= x1; px++) {
				// The fragment's uv: the pixel's offset from the star's
				// centre, in units of the footprint radius.
				const uv = [(px + 0.5 - fx) / radius, -(py + 0.5 - fy) / radius];
				const frag = splatStage.fragment('fs_main',
					{ 0: uv, 1: value }, splatBinds);
				// Outside the disc the fragment discards: nothing is written.
				if (!frag) continue;
				const o = (py * FIELD_W + px) * 4;
				splatTex[o] += frag[0]; splatTex[o + 1] += frag[1];
				splatTex[o + 2] += frag[2]; splatTex[o + 3] += frag[3];
			}
		}
	}
	check('the splat wrote a footprint for every star',
		STARS.every((star, i) => {
			const v = worldOf(star);
			return Number.isFinite(v[0]);
		}) && splatTex.some((v) => v !== 0), { touched: splatTex.length });

	// The blur: the shipping 3×3 binomial at the field's resolution.
	const blurBytes = new ArrayBuffer(16);
	{
		const u = new Float32Array(blurBytes);
		u[0] = FIELD_W; u[1] = FIELD_H;
	}
	const blurTex = new Float32Array(FIELD_W * FIELD_H * 4);
	{
		const blurBinds = {
			0: {
				0: { uniform: blurBytes },
				1: { texture: splatTexBytes, descriptor: { size: [FIELD_W, FIELD_H], format: 'rgba32float' } },
			},
		};
		for (let py = 0; py < FIELD_H; py++) {
			for (let px = 0; px < FIELD_W; px++) {
				const frag = blurStage.fragment('fs_main',
					{ position: [px + 0.5, py + 0.5, 0, 1] }, blurBinds);
				const o = (py * FIELD_W + px) * 4;
				blurTex[o] = frag[0]; blurTex[o + 1] = frag[1];
				blurTex[o + 2] = frag[2]; blurTex[o + 3] = frag[3];
			}
		}
	}

	// The composite: the shipping pass, on the swapchain, over the picture.
	const compositeBytes = new ArrayBuffer(64);
	const compositeUniform = new Float32Array(compositeBytes);
	fieldOverlay.packComposite(compositeUniform, rangeState, {
		opacity: 1.0,
		relief: 0,
		contours: 0,
		fieldW: FIELD_W,
		fieldH: FIELD_H,
		tanHalfY: Math.tan(camera.fovY * 0.5),
		canvasW: CANVAS_W,
		canvasH: CANVAS_H,
	});
	const ramp = fieldRamp.resolveRamp('height', 'viridis');
	const rampBytes = fieldRamp.rampRGBA(ramp);
	const compositeBinds = {
		0: {
			0: { uniform: compositeBytes },
			1: { texture: new Uint8Array(blurTex.buffer), descriptor: { size: [FIELD_W, FIELD_H], format: 'rgba32float' } },
			2: { texture: rampBytes, descriptor: { size: [256, 1], format: 'rgba8unorm' } },
			3: { sampler: { magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' } },
		},
	};

	// The ramp the composite reads, sampled the way the sampler does: linear
	// between the two neighbouring texels.
	function rampAt(t) {
		const u = Math.max(0, Math.min(0.999999, t)) * 256 - 0.5;
		const i0 = Math.floor(u);
		const f = u - i0;
		const i1 = Math.min(255, i0 + 1);
		const out = [0, 0, 0];
		for (let c = 0; c < 3; c++) {
			out[c] = (ramp[i0 * 3 + c] * (1 - f) + ramp[i1 * 3 + c] * f) / 255;
		}
		return out;
	}

	let worstColour = 0;
	const colours = [];
	for (let i = 0; i < STARS.length; i++) {
		// The star's pixel on the canvas, and its texel in the field.
		const c = centres[i];
		const ndcX = c.splat[0] / c.splat[2];
		const ndcY = c.splat[1] / c.splat[2];
		const canvasX = Math.min(CANVAS_W - 1, Math.max(0, Math.floor((ndcX * 0.5 + 0.5) * CANVAS_W)));
		const canvasY = Math.min(CANVAS_H - 1, Math.max(0, Math.floor((0.5 - ndcY * 0.5) * CANVAS_H)));
		const out = compositeStage.fragment('fs_main',
			{ position: [canvasX + 0.5, canvasY + 0.5, 0, 1] }, compositeBinds);
		// What the field says under that pixel: the blurred mean log-distance.
		const uvx = (canvasX + 0.5) / CANVAS_W;
		const uvy = (canvasY + 0.5) / CANVAS_H;
		const tx = Math.min(FIELD_W - 1, Math.max(0, Math.floor(uvx * FIELD_W - 0.5)));
		const ty = Math.min(FIELD_H - 1, Math.max(0, Math.floor(uvy * FIELD_H - 0.5)));
		const o = (ty * FIELD_W + tx) * 4;
		const mean = blurTex[o + 1] / Math.max(blurTex[o], 1e-9);
		// The colour the range and the ramp give for that value.
		const t = Math.max(0, Math.min(1, (hi - mean) / Math.max(hi - lo, 1e-6)));
		const want = rampAt(t);
		const gap = Math.max(Math.abs(out[0] - want[0]), Math.abs(out[1] - want[1]), Math.abs(out[2] - want[2]));
		if (gap > worstColour) worstColour = gap;
		colours.push({
			star: STARS[i].name,
			canvas: [canvasX, canvasY],
			mean: +mean.toFixed(4),
			want: want.map((v) => +v.toFixed(4)),
			got: [out[0], out[1], out[2]].map((v) => +v.toFixed(4)),
			gap: +gap.toFixed(5),
		});
	}
	check('the colour under a star is the ramp colour of that star\'s own distance',
		worstColour < 0.02, { worstColour, colours });

	// The negative control: the bug this file exists for is a composite that
	// divides a *canvas* pixel by the *field* width. That samples far outside
	// the texture, so the screen shows the field's edge column. If the wrong
	// mapping gave the same colour as the right one, the check above would be
	// blind — so compute it and require the two to differ.
	{
		let worstWrong = 0;
		const wrong = [];
		for (const c of colours) {
			const canvasX = c.canvas[0], canvasY = c.canvas[1];
			// The bug: the canvas pixel divided by the field's size.
			const bu = canvasX / FIELD_W, bv = canvasY / FIELD_H;
			const tx = Math.min(FIELD_W - 1, Math.max(0, Math.floor(Math.min(1, bu) * FIELD_W - 0.5)));
			const ty = Math.min(FIELD_H - 1, Math.max(0, Math.floor(Math.min(1, bv) * FIELD_H - 0.5)));
			const o = (ty * FIELD_W + tx) * 4;
			const mean = blurTex[o + 1] / Math.max(blurTex[o], 1e-9);
			const t = Math.max(0, Math.min(1, (hi - mean) / Math.max(hi - lo, 1e-6)));
			const want = rampAt(t);
			const gap = Math.max(Math.abs(c.got[0] - want[0]), Math.abs(c.got[1] - want[1]), Math.abs(c.got[2] - want[2]));
			if (gap > worstWrong) worstWrong = gap;
			wrong.push({ star: c.star, wrong: want.map((v) => +v.toFixed(4)), got: c.got, gap: +gap.toFixed(4) });
		}
		check('the canvas/field mix-up would change the colour (the check is not blind)',
			worstWrong > 0.05, { worstWrong, wrong });
	}

	report('the field overlay puts every star on its own colour');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
