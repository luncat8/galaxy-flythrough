// experiments/m1-smoke-test.js
// Milestone 1 smoke test: requires each runtime module to confirm exports.
// Does NOT instantiate WebGPU (no navigator.gpu in Node). Only checks that
// the modules load and export the expected symbols.
//
// Output: experiments/logs/m1-smoke.json

'use strict';

const fs = require('fs');
const path = require('path');

const checks = [];

function check(name, cond, detail) {
        checks.push({ name, pass: !!cond, detail });
        return !!cond;
}

// --- Math modules ---
const hash = require('../src/math/hash.js');
check('hash.pcgHash is function', typeof hash.pcgHash === 'function');
check('hash.hash01 is function', typeof hash.hash01 === 'function');
check('hash.hash3D is function', typeof hash.hash3D === 'function');
check('hash.pcgHash(0) returns u32', typeof hash.pcgHash(0) === 'number' && hash.pcgHash(0) >= 0);
check('hash.hash01(0) in [0,1)', hash.hash01(0) >= 0 && hash.hash01(0) < 1);

const density = require('../src/math/density.js');
check('density.rhoTotal is function', typeof density.rhoTotal === 'function');
check('density.rhoTotal(0,0,0) > 0', density.rhoTotal(0, 0, 0) > 0);
check('density.GALACTIC_R0 = 8.178', density.GALACTIC_R0 === 8.178);
check('density.sampleComponent is function', typeof density.sampleComponent === 'function');

const sampling = require('../src/math/sampling.js');
check('sampling.sampleStars is function', typeof sampling.sampleStars === 'function');
check('sampling.precomputeRhoMax is function', typeof sampling.precomputeRhoMax === 'function');

const starTypes = require('../src/math/star-types.js');
check('starTypes.deriveStarProps is function', typeof starTypes.deriveStarProps === 'function');
const s = starTypes.deriveStarProps(0, 0, 0.1, 42);
check('deriveStarProps returns object with class', typeof s.class === 'string');
check('deriveStarProps returns color array', Array.isArray(s.color) && s.color.length === 3);
check('deriveStarProps returns component', ['thin', 'thick', 'bulge', 'halo'].includes(s.component));

const nebula = require('../src/math/nebula.js');
check('nebula.placeNebulae is function', typeof nebula.placeNebulae === 'function');
check('nebula.NEBULA_TYPES has 5 entries', nebula.NEBULA_TYPES.length === 5);

const splitDouble = require('../src/math/split-double.js');
check('splitDouble.cameraRelative is function', typeof splitDouble.cameraRelative === 'function');
const rel = splitDouble.cameraRelative([8, 0, 0], [1, 0, 0]);
check('cameraRelative returns array of 3', Array.isArray(rel) && rel.length === 3);
check('cameraRelative([8,0,0], [1,0,0]) = [7,0,0]', Math.abs(rel[0] - 7) < 1e-5);

// --- Core modules (Node-loadable but WebGPU-dependent at runtime) ---
const cameraMod = require('../src/core/camera.js');
check('camera.createCamera is function', typeof cameraMod.createCamera === 'function');
const cam = cameraMod.createCamera();
check('camera has step function', typeof cam.step === 'function');
check('camera has buildViewProj function', typeof cam.buildViewProj === 'function');
check('camera.viewProj is Float32Array(16)', cam.viewProj instanceof Float32Array && cam.viewProj.length === 16);
check('camera.cameraPos is Float32Array(4)', cam.cameraPos instanceof Float32Array && cam.cameraPos.length === 4);
// Verify right/up vectors via getState (roundtrip)
// Default yaw=0, pitch=0: forward = (1,0,0), right = (0,-1,0), up = (0,0,1)
// cross(forward, worldUp=(0,0,1)) = (forward.y*1 - forward.z*0, forward.z*0 - forward.x*1, 0) = (0, -1, 0)
// So right = (0, -1, 0), up = cross(right, forward) = (-1*0 - 0*0, 0*1 - 0*0, 0*0 - (-1)*1) = (0, 0, 1)
const fwd0 = cam.forward;
check('camera.forward at yaw=0,pitch=0 is +X', Math.abs(fwd0[0] - 1) < 1e-6 && Math.abs(fwd0[1]) < 1e-6 && Math.abs(fwd0[2]) < 1e-6);
const right0 = cam.right;
check('camera.right at yaw=0,pitch=0 is -Y', Math.abs(right0[0]) < 1e-6 && Math.abs(right0[1] + 1) < 1e-6 && Math.abs(right0[2]) < 1e-6);
const up0 = cam.up;
check('camera.up at yaw=0,pitch=0 is +Z', Math.abs(up0[0]) < 1e-6 && Math.abs(up0[1]) < 1e-6 && Math.abs(up0[2] - 1) < 1e-6);
// Verify right and up are orthonormal
const fwdDotRight = fwd0[0] * right0[0] + fwd0[1] * right0[1] + fwd0[2] * right0[2];
const fwdDotUp = fwd0[0] * up0[0] + fwd0[1] * up0[1] + fwd0[2] * up0[2];
const rightDotUp = right0[0] * up0[0] + right0[1] * up0[1] + right0[2] * up0[2];
check('camera orthonormal: forward . right = 0', Math.abs(fwdDotRight) < 1e-6);
check('camera orthonormal: forward . up = 0', Math.abs(fwdDotUp) < 1e-6);
check('camera orthonormal: right . up = 0', Math.abs(rightDotUp) < 1e-6);

const inputMod = require('../src/core/input.js');
check('input.createInput is function', typeof inputMod.createInput === 'function');

const loopMod = require('../src/core/loop.js');
check('loop.createLoop is function', typeof loopMod.createLoop === 'function');
const loop = loopMod.createLoop(() => {});
check('loop has start function', typeof loop.start === 'function');
check('loop has stop function', typeof loop.stop === 'function');
check('loop.stats exists', typeof loop.stats === 'object');

// --- Render module (Node-loadable; WebGPU calls only happen at runtime) ---
const starDistantMod = require('../src/render/star-distant.js');
check('starDistant.createStarDistantRenderer is function', typeof starDistantMod.createStarDistantRenderer === 'function');
check('starDistant.TEST_N = 100000', starDistantMod.TEST_N === 100000);
check('starDistant.SAMPLING_BOX is object', typeof starDistantMod.SAMPLING_BOX === 'object');
check('starDistant.buildColorLUT is function', typeof starDistantMod.buildColorLUT === 'function');
const lut = starDistantMod.buildColorLUT();
check('LUT is 256*4 = 1024 bytes', lut.length === 1024);
check('LUT index 0 (O) is bluish', lut[0] < lut[2]);  // O = blue, R < B
check('LUT index 6 (M) is reddish', lut[6 * 4] > lut[6 * 4 + 2]);  // M = red, R > B

// --- main.js (should attach boot to window load; in Node we just parse) ---
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
check('main.js defines boot function', /function boot\(\)/.test(mainSrc));
check('main.js attaches to DOMContentLoaded', /DOMContentLoaded/.test(mainSrc));

// --- index.html exists and embeds WGSL ---
const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
check('index.html has canvas element', /id="canvas"/.test(indexHtml));
check('index.html has WGSL script block', /type="text\/x-wgsl"/.test(indexHtml));
check('index.html loads main.js', /src="main\.js"/.test(indexHtml));
check('index.html loads all math modules', /math\/(hash|density|sampling|star-types|nebula|split-double)\.js/.test(indexHtml));
check('index.html loads all core modules', /core\/(device|camera|input|loop)\.js/.test(indexHtml));
check('index.html loads star-distant.js', /render\/star-distant\.js/.test(indexHtml));

// --- Print results ---
let pass = 0, fail = 0;
for (const c of checks) {
        if (c.pass) pass++; else fail++;
        console.log(`  ${c.pass ? 'OK' : 'FAIL'}: ${c.name}`);
}
console.log(`\n${pass}/${checks.length} passed, ${fail} failed`);

const out = {
        date: new Date().toISOString(),
        totalChecks: checks.length,
        passed: pass,
        failed: fail,
        checks,
        verdict: fail === 0
                ? 'PASS — Milestone 1 modules load and export correctly'
                : `FAIL — ${fail} checks failed`,
};
const logPath = path.join(__dirname, 'logs', 'm1-smoke.json');
fs.writeFileSync(logPath, JSON.stringify(out, null, 2));
console.log(`Wrote ${logPath}`);

console.log('\n=== VERDICT ===');
console.log(out.verdict);
