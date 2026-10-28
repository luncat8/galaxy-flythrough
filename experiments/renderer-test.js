// experiments/renderer-test.js
// Exercises src/render/star-sprites.js against a mock WebGPU device. The real
// GPU cannot be reached from Node, but everything the renderer does *around*
// the GPU calls is testable: buffer sizing, staging layout, catalog streaming
// hand-off, uniform packing, exposure handling and the draw-instance count.
//
// The mock records every buffer write, so the test can decode the bytes the
// renderer would have uploaded and check them against the catalog itself.
//
// Output: experiments/logs/renderer.json

'use strict';

const path = require('path');
const logFile = require('./log-file.js');

// --- Browser shims -------------------------------------------------------
// The src modules attach their API to window.* in a browser; aliasing window to
// globalThis lets the same files load here without a bundler.
globalThis.window = globalThis;
globalThis.GPUBufferUsage = { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 };
globalThis.GPUTextureUsage = { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };
globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };

require('../src/math/hash.js');
require('../src/math/density.js');
require('../src/math/sampling.js');
require('../src/math/star-record.js');
require('../src/math/coords.js');
require('../src/math/star-types.js');
require('../src/data/landmarks.js');
require('../src/render/shaders.js');
require('../src/stream/tile-loader.js');
require('../src/stream/cell-manager.js');
require('../src/core/camera.js');

const rendererModule = require('../src/render/star-sprites.js');
const records = require('../src/math/star-record.js');
const loader = require('../src/stream/tile-loader.js');
const objectsLib = require('../src/math/objects.js');
// The renderer reads window.ClustersLib at construction (plan §10), so the
// cluster layer must be registered before any renderer is created.
const clustersLib = require('../src/math/clusters.js');
const nebulaLib = require('../src/math/nebula.js');
require('../src/math/gas-grid.js');
const Camera = require('../src/core/camera.js');

const checks = [];
function check(name, pass, detail) {
        checks.push({ name, pass: !!pass, detail });
        return !!pass;
}

// --- Mock device ---------------------------------------------------------
// The shared recording mock (experiments/mock-gpu.js) — the same device the
// engine-switch audit runs the renderer against, so both decode identical
// thetaWrites/bufferWrites bytes.
const createMockGpu = require('./mock-gpu.js').createMockGpu;

function readUniform(bytes) {
        return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

// --- Setup --------------------------------------------------------------
const gpu = createMockGpu();
const bundle = require('../src/data/tiles/catalog.js');
const manifest = loader.prepareBundle(bundle);
const camera = require('../src/core/camera.js').createCamera();

const PROCEDURAL = 20000;      // small so the test stays fast
const CATALOG_BUDGET = 250000;
const OBJECT_MEMBERS = 2000;   // objects-block capacity under test (default 20000)
const OBJECT_COUNT = 40;       // objects placed (default 400)
const START = Date.now();
const galaxy = require('../src/math/galaxy.js');
const model = galaxy.createGalaxy({ seed: 7 });

const renderer = rendererModule.createStarRenderer(gpu.device, gpu.context, gpu.format, {
        proceduralStars: PROCEDURAL,
        catalogBudgetStars: CATALOG_BUDGET,
        objectMembers: OBJECT_MEMBERS,
        objectCount: OBJECT_COUNT,
        model,
});
const prepareState = renderer.prepare(manifest);
const prepareMs = Date.now() - START;
console.log(`Prepared in ${prepareMs} ms: ${prepareState.proceduralStars} procedural, `
        + `${prepareState.catalogTotalStars} catalog stars in ${prepareState.catalogCells} cells`);

// --- Shader + pipeline wiring -------------------------------------------
{
        // 0.7.4 adds the two gas-grid modules: the burn step (compute) and the
        // cell splats (vertex + fragment). Every module still comes from one
        // SHADERS entry, so a missing one is a drift, not a style choice.
        check('six shader modules are created (sprite, tonemap, nebula, gas step, gas cell, simple-step)',
                gpu.shaderModules.length === 6
                && gpu.shaderModules[0].code === window.GalaxyShaders.SHADERS['star-sprite']
                && gpu.shaderModules[1].code === window.GalaxyShaders.SHADERS['tonemap']
                && gpu.shaderModules[2].code === window.GalaxyShaders.SHADERS['nebula-billboard']
                && gpu.shaderModules[3].code === window.GalaxyShaders.SHADERS['gas-step']
                && gpu.shaderModules[4].code === window.GalaxyShaders.SHADERS['gas-cell']
                && gpu.shaderModules[5].code === window.GalaxyShaders.SHADERS['simple-step'],
                { modules: gpu.shaderModules.map(s => s.label) });
        check('all wired shaders declare their entry points',
                gpu.shaderModules.filter(s => s.label !== 'simple-step' && s.label !== 'gas-step')
                        .every(s => /@vertex\s+fn\s+vs_main/.test(s.code) && /@fragment\s+fn\s+fs_main/.test(s.code))
                && gpu.shaderModules.filter(s => s.label === 'simple-step' || s.label === 'gas-step')
                        .every(s => /fn\s+main\(@builtin\(global_invocation_id\)/.test(s.code)),
                gpu.shaderModules.map(s => s.label));
        const spritePipeline = gpu.pipelines.find(p => p.label === 'star-sprite-pipeline');
        const tonemapPipeline = gpu.pipelines.find(p => p.label === 'tonemap-pipeline');
        const nebulaPipeline = gpu.pipelines.find(p => p.label === 'nebula-billboard-pipeline');
        const stepPipeline = gpu.pipelines.find(p => p.label === 'simple-step-pipeline');
        const gasStepPipeline = gpu.pipelines.find(p => p.label === 'gas-step-pipeline');
        const gasCellPipeline = gpu.pipelines.find(p => p.label === 'gas-cell-pipeline');
        check('six pipelines are created (sprite, tonemap, nebula, gas step, gas cell, simple-step) — no hdr-direct bypass',
                !!spritePipeline && !!tonemapPipeline && !!nebulaPipeline && !!stepPipeline
                && !!gasStepPipeline && !!gasCellPipeline && gpu.pipelines.length === 6,
                gpu.pipelines.map(p => p.label));
        check('the simple-step pipeline is a compute pipeline with a main entry',
                !!stepPipeline && !!stepPipeline.compute && stepPipeline.compute.entryPoint === 'main',
                stepPipeline && stepPipeline.compute);
        check('the star-sprite pipeline is additive with no depth attachment',
                spritePipeline.fragment.targets[0].blend.color.srcFactor === 'one'
                && spritePipeline.fragment.targets[0].blend.color.dstFactor === 'one'
                && spritePipeline.depthStencil === undefined,
                spritePipeline.fragment.targets[0].blend);
        check('the tonemap pipeline has no blend state (overwrite)',
                tonemapPipeline.fragment.targets[0].blend === undefined
                && tonemapPipeline.fragment.targets[0].format === 'bgra8unorm',
                tonemapPipeline.fragment.targets[0]);
        check('the star-sprite pipeline uses triangle-strip, tonemap uses triangle-list',
                spritePipeline.primitive.topology === 'triangle-strip'
                && tonemapPipeline.primitive.topology === 'triangle-list',
                { sprite: spritePipeline.primitive.topology, tonemap: tonemapPipeline.primitive.topology });
        check('the nebula pipeline is additive triangle-strip like the sprites',
                nebulaPipeline.primitive.topology === 'triangle-strip'
                && nebulaPipeline.fragment.targets[0].blend.color.srcFactor === 'one'
                && nebulaPipeline.fragment.targets[0].blend.color.dstFactor === 'one'
                && nebulaPipeline.depthStencil === undefined,
                nebulaPipeline.fragment.targets[0].blend);
        check('star and nebula pipelines target the RGBA16Float intermediate; tonemap targets the swapchain',
                spritePipeline.fragment.targets[0].format === 'rgba16float'
                && nebulaPipeline.fragment.targets[0].format === 'rgba16float'
                && tonemapPipeline.fragment.targets[0].format === 'bgra8unorm');
        check('the color LUT is uploaded as rgba8unorm-srgb (so palette bytes authored as sRGB get linearised)',
                gpu.textures.some(t => t.label === 'star-color-lut' && t.format === 'rgba8unorm-srgb'),
                gpu.textures.map(t => `${t.label}:${t.format}`));
}

// --- Buffer sizing and the procedural upload ----------------------------
const catalogs = gpu.buffers.filter(b => b.label === 'star-storage');
{
        const buffer = catalogs[0];
        const localBudget = rendererModule.LOCAL_PROCEDURAL_DEFAULT;
        const expectedRecords = prepareState.proceduralStars + prepareState.landmarkStars + OBJECT_MEMBERS + localBudget + Math.min(manifest.starCount, CATALOG_BUDGET);
        check('the storage buffer holds procedural + landmarks + objects + local gap-fill + catalog capacity',
                buffer.size === Math.max(16, expectedRecords * records.RECORD_BYTES),
                { size: buffer.size, expected: expectedRecords * records.RECORD_BYTES });
        const starWrites = gpu.bufferWrites.filter(w => w.buffer.label === 'star-storage');
        check('the fixed blocks (procedural + landmarks + objects) were uploaded once, at offset 0',
                starWrites.length === 1 && starWrites[0].offset === 0
                && starWrites[0].bytes.length === (prepareState.proceduralStars + prepareState.landmarkStars + OBJECT_MEMBERS) * records.RECORD_BYTES,
                { writes: starWrites.length });
}

// --- The landmark block is the named-star table --------------------------
{
        const L = require('../src/data/landmarks.js');
        check('the renderer reports the landmark block from the data module',
                prepareState.landmarkStars === L.count && L.count >= 30 && L.count <= 60,
                { landmarkStars: prepareState.landmarkStars, table: L.count });
        const bytes = gpu.bufferWrites.filter(w => w.buffer.label === 'star-storage')[0].bytes;
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let positionOk = true, flagsOk = true, colorOk = true, magOk = true;
        for (let i = 0; i < L.count; i++) {
                const rec = records.readRecord(view, (prepareState.proceduralStars + i) * records.RECORD_BYTES);
                const e = L.ENTRIES[i];
                if (rec.x !== Math.fround(e.x) || rec.y !== Math.fround(e.y) || rec.z !== Math.fround(e.z)) positionOk = false;
                if (!rec.visible || (rec.flags & records.FLAG_LANDMARK) === 0) flagsOk = false;
                if (rec.colorIndex !== e.colorIndex) colorOk = false;
                if (Math.abs(rec.absMag - e.absMag) > records.ABS_MAG_SPAN / 255 + 1e-6) magOk = false;
        }
        check('every landmark record sits at its baked position right after the procedural block', positionOk);
        check('every landmark record is flagged FLAG_VISIBLE | FLAG_LANDMARK', flagsOk);
        check('every landmark record carries the table colour and absolute magnitude', colorOk && magOk);
}

// --- The objects block holds apportioned cluster members -----------------
// Plan §10 layout: star clusters first (their own scaled budget), then the
// gas objects in what remains. The expected member count is recomputed
// from the two libraries, not hard-coded: clusters spend their budget in
// full, gas writes min(remaining capacity, placed richness).
function expectedObjectBlock(m, seedValue, gasCount, capacity, fieldStars) {
        const clusterBudget = Math.min(capacity, clustersLib.clusterMemberBudget(fieldStars));
        const gasPlaced = objectsLib.placeObjects(m, (seedValue | 0) ^ 0x0B5E55, gasCount, null);
        const gasRichness = gasPlaced.reduce((a, o) => a + o.richness, 0);
        return {
                clusterBudget,
                members: clusterBudget + Math.min(capacity - clusterBudget, gasRichness),
        };
}
{
        const bytes = gpu.bufferWrites.filter(w => w.buffer.label === 'star-storage')[0].bytes;
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const base = prepareState.proceduralStars + prepareState.landmarkStars;
        const expected = expectedObjectBlock(model, 7, OBJECT_COUNT, OBJECT_MEMBERS, PROCEDURAL);
        check('the renderer reports the placed objects and their apportioned members',
                prepareState.objectCount === OBJECT_COUNT + prepareState.clusterCount
                && prepareState.gasObjectCount === OBJECT_COUNT
                && prepareState.clusterCount === clustersLib.clusterCountFor(model)
                && prepareState.clusterStars === expected.clusterBudget
                && prepareState.objectStars === expected.members,
                { objects: prepareState.objectCount, members: prepareState.objectStars, expected });
        let visible = 0;
        let finite = 0;
        let classOk = 0;
        let magOk = 0;
        for (let i = 0; i < prepareState.objectStars; i++) {
                const rec = records.readRecord(view, (base + i) * records.RECORD_BYTES);
                if (rec.visible) visible++;
                if (Number.isFinite(rec.x) && Number.isFinite(rec.y) && Number.isFinite(rec.z)) finite++;
                if (rec.colorIndex < records.SPECTRAL_CLASSES.length) classOk++;
                if (rec.absMag >= records.ABS_MAG_MIN && rec.absMag <= records.ABS_MAG_MAX) magOk++;
        }
        check('every written objects-block record is visible and finite',
                visible === prepareState.objectStars && finite === prepareState.objectStars, { visible, finite });
        check('every written objects-block record carries a valid colour and magnitude',
                classOk === prepareState.objectStars && magOk === prepareState.objectStars, { classOk, magOk });
}

// --- The procedural records are real stars ------------------------------
{
        const bytes = gpu.bufferWrites.filter(w => w.buffer.label === 'star-storage')[0].bytes;
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let visible = 0;
        let maxRadius = 0;
        let minRadius = Infinity;
        let classes = new Set();
        for (let i = 0; i < prepareState.proceduralStars; i++) {
                const rec = records.readRecord(view, i * records.RECORD_BYTES);
                if (rec.visible) visible++;
                const r = Math.hypot(rec.x, rec.y, rec.z);
                if (r > maxRadius) maxRadius = r;
                if (r < minRadius) minRadius = r;
                classes.add(rec.colorIndex);
        }
        check('every procedural record is visible and finite', visible === prepareState.proceduralStars, visible);
        check('the procedural field covers the galaxy, not just the solar neighbourhood',
                minRadius < 0.5 && maxRadius > 8, { minRadius: +minRadius.toFixed(3), maxRadius: +maxRadius.toFixed(3) });
        check('the procedural field uses several spectral classes', classes.size >= 4, classes.size);
}

// --- First frame ---------------------------------------------------------
const WIDTH = 1920;
const HEIGHT = 1080;
const input = { keys: {}, actions: { reset: 0, exposure: 0, linearExposure: 0 }, lookDx: 0, lookDy: 0, wheelDelta: 0 };

renderer.render(camera, WIDTH, HEIGHT, 1 / 60, input);
{
        const localOffset = (prepareState.proceduralStars + prepareState.landmarkStars + OBJECT_MEMBERS) * records.RECORD_BYTES;
        const dynamicWrites = gpu.bufferWrites.filter(w => w.buffer.label === 'star-storage' && w.offset >= localOffset);
        const blocksNow = renderer.starBlocks().blocks;
        const catalogOffset = blocksNow[4].offset * records.RECORD_BYTES;
        check('the first frame uploads local and catalog ranges at their distinct packed offsets',
                dynamicWrites.length === 2
                && dynamicWrites[0].offset === localOffset && dynamicWrites[1].offset === catalogOffset
                && dynamicWrites[0].bytes.byteLength === renderer.state.localProceduralStars * records.RECORD_BYTES
                && dynamicWrites[1].bytes.byteLength === renderer.state.catalogResidentStars * records.RECORD_BYTES,
                { writes: dynamicWrites.length, offsets: dynamicWrites.map(w => w.offset), localOffset, catalogOffset });

        // Three passes per frame: star-sprite, nebula billboards, tonemap.
        const spritePass = gpu.passes.find(p => p.label === 'star-sprites');
        const nebulaPass = gpu.passes.find(p => p.label === 'nebula-billboards');
        const tonemapPass = gpu.passes.find(p => p.label === 'tonemap');
        check('three render passes are submitted per frame (stars, nebulae, tonemap)',
                spritePass && nebulaPass && tonemapPass && spritePass !== nebulaPass && nebulaPass !== tonemapPass,
                gpu.passes.map(p => p.label));
        const drawnInstances = spritePass.draws.reduce((sum, draw) => sum + draw.instances, 0);
        check('the star-sprite pass draws exactly the resident stars (global + landmarks + objects + local + catalog)',
                drawnInstances === renderer.state.drawn
                && renderer.state.drawn === prepareState.proceduralStars + renderer.state.landmarkStars + OBJECT_MEMBERS
                        + renderer.state.localProceduralStars + renderer.state.catalogResidentStars,
                spritePass.draws);
        check('the star-sprite draws use four vertices per star and preserve catalog global slots',
                spritePass.draws.every(draw => draw.vertices === 4 && draw.firstVertex === 0)
                && spritePass.draws[0].firstInstance === 0
                && (spritePass.draws.length === 1
                        || (spritePass.draws.length === 2 && spritePass.draws[1].firstInstance === catalogOffset / records.RECORD_BYTES)),
                spritePass.draws);
        check('the nebula pass draws four vertices per billboard over the packed gas objects',
                nebulaPass.draws.length === 1 && nebulaPass.draws[0].vertices === 4
                && nebulaPass.draws[0].instances === renderer.state.nebulaBillboards
                && renderer.state.nebulaBillboards > 0 && renderer.state.nebulaBillboards <= OBJECT_COUNT,
                nebulaPass.draws[0]);
        check('the nebula pass loads the HDR intermediate (does not clear the stars)',
                nebulaPass.desc.colorAttachments[0].loadOp === 'load'
                && nebulaPass.desc.colorAttachments[0].storeOp === 'store');
        check('the tonemap pass draws one fullscreen triangle (3 vertices, 1 instance)',
                tonemapPass.draws.length === 1 && tonemapPass.draws[0].vertices === 3
                && tonemapPass.draws[0].instances === 1,
                tonemapPass.draws[0]);
        check('the resident catalog fits the budget', renderer.state.catalogResidentStars <= CATALOG_BUDGET,
                renderer.state.catalogResidentStars);
        check('all cells of this small catalog are resident', renderer.state.cellsResident === manifest.cellCount,
                { resident: renderer.state.cellsResident, total: manifest.cellCount });
        check('density parity thinned the catalog (fewer visible stars than raw)',
                renderer.state.catalogThinnedStars <= manifest.starCount
                && renderer.state.catalogThinnedStars < manifest.starCount,
                { thinned: renderer.state.catalogThinnedStars, raw: manifest.starCount });
}

// --- Nebula billboard packing and size/distance cull (0.3.2b) ------------
{
        const nebulaWrites = gpu.bufferWrites.filter(w => w.buffer.label === 'nebula-storage');
        check('the nebula storage was uploaded on prepare',
                nebulaWrites.length >= 1 && nebulaWrites[0].offset === 0
                && nebulaWrites[0].bytes.length === renderer.state.nebulaBillboards * objectsLib.BILLBOARD_RECORD_BYTES,
                { writes: nebulaWrites.length, bytes: nebulaWrites[0] && nebulaWrites[0].bytes.length,
                        count: renderer.state.nebulaBillboards });
        const placed = objectsLib.placeObjects(model, 7 ^ 0x0B5E55, OBJECT_COUNT, null);
        const gas = placed.filter(o => objectsLib.objectHasGas(o.type));
        check('packed billboards are exactly the gas objects (HII, planetary, SNR)',
                renderer.state.nebulaBillboards === gas.length
                && gas.every(o => o.type === 'HII' || o.type === 'planetary' || o.type === 'SNR'),
                { packed: renderer.state.nebulaBillboards, gas: gas.length,
                        byType: objectsLib.summariseObjects(placed).byType });
        const bytes = nebulaWrites[0].bytes;
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let colorOk = true, sizeOk = true, opacityOk = true;
        for (let i = 0; i < gas.length; i++) {
                const o = i * objectsLib.BILLBOARD_RECORD_BYTES;
                const size = view.getFloat32(o + 12, true);
                const r = view.getFloat32(o + 16, true);
                const g = view.getFloat32(o + 20, true);
                const b = view.getFloat32(o + 24, true);
                const opacity = view.getFloat32(o + 28, true);
                const want = nebulaLib.NEBULA_COLORS[gas[i].type];
                if (size !== Math.fround(gas[i].size)) sizeOk = false;
                if (r !== Math.fround(want[0]) || g !== Math.fround(want[1]) || b !== Math.fround(want[2])) colorOk = false;
                if (opacity !== Math.fround(objectsLib.BILLBOARD_OPACITY[gas[i].type])) opacityOk = false;
        }
        check('each billboard carries the object size, NEBULA_COLORS tint and type opacity',
                sizeOk && colorOk && opacityOk, { sizeOk, colorOk, opacityOk });
        const fov = Camera.FOV_Y;
        check('a 100 pc HII at 1 kpc is above the 4 px floor at 1080p',
                objectsLib.billboardVisible(0.1, 1.0, HEIGHT, fov) === true
                && objectsLib.billboardScreenPx(0.1, 1.0, HEIGHT, fov) > objectsLib.BILLBOARD_MIN_PX);
        check('a 2 pc planetary at 1 kpc is culled below the 4 px floor',
                objectsLib.billboardVisible(0.002, 1.0, HEIGHT, fov) === false
                && objectsLib.billboardScreenPx(0.002, 1.0, HEIGHT, fov) < objectsLib.BILLBOARD_MIN_PX,
                objectsLib.billboardScreenPx(0.002, 1.0, HEIGHT, fov));
        check('anything past 5 kpc is culled even when it would be large on screen',
                objectsLib.billboardVisible(0.15, 5.1, HEIGHT, fov) === false
                && objectsLib.billboardVisible(0.15, 4.9, HEIGHT, fov) === true);
        check('star clusters have no gas billboard (they are stars in this galaxy, not nebulae)',
                objectsLib.OBJECT_TYPES.every(t => objectsLib.objectHasGas(t))
                && objectsLib.objectHasGas('globular') === false && objectsLib.objectHasGas('open') === false
                && clustersLib.placeStarClusters(model, 7, 5, null)
                        .every(c => objectsLib.writeObjectBillboards([c], new DataView(new ArrayBuffer(32)), 0, 1) === 0));
}


// --- HDR intermediate texture --------------------------------------------
{
        const hdr = gpu.textures.find(t => t.label === 'hdr-intermediate');
        check('the HDR intermediate texture was created',
                !!hdr && hdr.format === 'rgba16float',
                hdr && { label: hdr.label, format: hdr.format, size: hdr.size });
        check('the HDR texture matches the canvas size',
                !!hdr && hdr.size[0] === WIDTH && hdr.size[1] === HEIGHT, hdr && hdr.size);
        check('the HDR texture is both a render target and a texture binding',
                !!hdr && (hdr.usage & GPUTextureUsage.RENDER_ATTACHMENT) !== 0
                && (hdr.usage & GPUTextureUsage.TEXTURE_BINDING) !== 0,
                hdr && hdr.usage);

        const starPass = gpu.passes.find(p => p.label === 'star-sprites');
        const tonemapPass = gpu.passes.find(p => p.label === 'tonemap');
        check('the star pass clears the HDR texture to zero (linear black)',
                starPass.desc.colorAttachments[0].clearValue.r === 0
                && starPass.desc.colorAttachments[0].clearValue.g === 0
                && starPass.desc.colorAttachments[0].clearValue.b === 0,
                starPass.desc.colorAttachments[0].clearValue);
        check('the tonemap pass clears the swapchain to a dark sky, not black',
                tonemapPass.desc.colorAttachments[0].clearValue.r > 0
                || tonemapPass.desc.colorAttachments[0].clearValue.g > 0
                || tonemapPass.desc.colorAttachments[0].clearValue.b > 0,
                tonemapPass.desc.colorAttachments[0].clearValue);
}

// --- Uniform packing ----------------------------------------------------
{
        const uniform = readUniform(gpu.uniformWrites[gpu.uniformWrites.length - 1]);
        const expectedViewProj = camera.buildViewProj(WIDTH / HEIGHT);
        let viewProjMatches = true;
        for (let i = 0; i < 16; i++) if (uniform[i] !== expectedViewProj[i]) viewProjMatches = false;
        check('uniform[0..16] is the camera viewProj', viewProjMatches);
        check('uniform carries the camera position',
                uniform[16] === camera.cameraPos[0] && uniform[17] === camera.cameraPos[1] && uniform[18] === camera.cameraPos[2]);
        check('uniform carries the viewport and its reciprocal',
                uniform[20] === WIDTH && uniform[21] === HEIGHT
                && Math.abs(uniform[22] - 2 / WIDTH) < 1e-9 && Math.abs(uniform[23] - 2 / HEIGHT) < 1e-9,
                { viewport: [uniform[20], uniform[21], uniform[22], uniform[23]] });
        // The uniform is Float32Array, so compare against the rounded constants.
        check('uniform carries the exposure and sprite sizes',
                uniform[24] === Math.fround(rendererModule.EXPOSURE_DEFAULT)
                && uniform[25] === Math.fround(rendererModule.BASE_SIZE_PX)
                && uniform[26] === Math.fround(rendererModule.MAX_SIZE_PX),
                { exposure: uniform[24], base: uniform[25], max: uniform[26] });
        check('uniform carries the star time in params.w', uniform[27] === Math.fround(1 / 60), uniform[27]);
        check('uniform is exactly 240 bytes (camera block + orbit dynamics + epoch + formation gate + named-sky gate)', gpu.uniformWrites[gpu.uniformWrites.length - 1].length === 240);
        check('formation lane carries epoch, fade width and procedural count',
                uniform[52] === Math.fround(model.populations.age)
                && uniform[53] === Math.fround(window.OrbitLib.BIRTH_FADE_GYR)
                && uniform[54] === PROCEDURAL,
                { formation: Array.from(uniform.slice(52, 56)) });
        // Orbit dynamics ride in dynA/dynB — the per-model numbers the shader
        // must never hard-code (packed by orbit.packOrbitDynamics).
        const fr = Math.fround;
        const dynA = [uniform[28], uniform[29], uniform[30], uniform[31]];
        const dynB = [uniform[32], uniform[33], uniform[34], uniform[35]];
        const expectA = [model.dynamics.vFlat, model.dynamics.rCore, model.dynamics.omegaPattern, model.dynamics.spinLambda].map(fr);
        check('uniform dynA = (vFlat, rCore, omegaPattern, spinLambda) of the live model',
                dynA.every((v, i) => v === expectA[i]), { dynA, expectA });
        check('uniform dynB = (sigmaThin, pressureAmpScale, discHeight, patternLock)',
                dynB[0] === fr(model.dynamics.sigmaThin)
                && dynB[1] > 0 && dynB[2] === fr(model.truncation.discHeight) && dynB[3] === 0,
                { dynB });
        // Wave pair is packed even when the slider is at the module default (0):
        // the shader reads m/K from it, and a later setWaveDamping must not
        // require a layout change. The test harness never calls setWaveDamping.
        const waveA = [uniform[36], uniform[37], uniform[38], uniform[39]];
        const waveB = [uniform[40], uniform[41], uniform[42], uniform[43]];
        check('uniform waveA/waveB pack the live arm geometry with damping at the module default 0',
                waveA[0] === 0 && waveA[1] === fr(model.arms.m) && waveA[3] === fr(model.arms.phase0)
                && waveB[0] === fr(model.arms.Rs) && waveB[2] === fr(model.arms.amp) && waveB[3] === 0,
                { waveA, waveB, arms: model.arms });
        // The engine lane rides at offset 44: the 0.4.7 vec4 is
        // (mask, apocenterForce, barTilt, apocenterShare). The mask is a bit
        // field, not an id: classic is bit 1 and is the default.
        const engine = [uniform[44], uniform[45], uniform[46], uniform[47]];
        check('uniform engine lane carries (classic bit, apocenterForce, no tilt, share)',
                engine[0] === window.OrbitLib.ENGINE_CLASSIC
                && engine[1] === fr(window.OrbitLib.getApocenterForce())
                && engine[2] === 0 && engine[3] === fr(window.OrbitLib.getApocenterShare()),
                { engine });

        // The tonemap uniform carries linear exposure (x) and white point (y)
        // and is uploaded every frame alongside the camera uniform.
        const tmu = readUniform(gpu.tonemapUniformWrites[gpu.tonemapUniformWrites.length - 1]);
        check('tonemap uniform carries the default linear exposure (1.0)',
                tmu[0] === Math.fround(rendererModule.LINEAR_EXPOSURE_DEFAULT), tmu[0]);
        check('tonemap uniform carries the default white point (4.0)',
                tmu[1] === Math.fround(rendererModule.WHITE_POINT_DEFAULT), { w: tmu[1], expected: rendererModule.WHITE_POINT_DEFAULT });
        check('tonemap uniform carries the default saturation ('+rendererModule.SATURATION_DEFAULT+')',
                Math.abs(tmu[2] - rendererModule.SATURATION_DEFAULT) < 1e-6, { s: tmu[2], expected: rendererModule.SATURATION_DEFAULT });
        check('tonemap uniform carries output mode w=0 (SDR) because opts.hdr was not set',
                tmu[3] === 0.0, { w: tmu[3] });
        check('tonemap uniform is 32 bytes (params + headroom/desat vec4)', gpu.tonemapUniformWrites[0].length === 32, gpu.tonemapUniformWrites[0].length);
        check('tonemap uniform carries the default headroom (8.0, today\'s ceiling)',
                tmu[4] === Math.fround(rendererModule.HEADROOM_DEFAULT), tmu[4]);
        check('tonemap uniform carries the default highlight desat (1.0, today\'s film look)',
                tmu[5] === Math.fround(rendererModule.HIGHLIGHT_DESAT_DEFAULT), tmu[5]);
        check('tonemap uniform pads floats 6-7 with zero', tmu[6] === 0 && tmu[7] === 0);
}

// --- Second frame: no re-upload while parked ----------------------------
{
        const writesBefore = gpu.bufferWrites.length;
        renderer.render(camera, WIDTH, HEIGHT, 2 / 60, input);
        check('a parked camera does not re-upload the catalog', gpu.bufferWrites.length === writesBefore,
                { before: writesBefore, after: gpu.bufferWrites.length });
        const uniform = readUniform(gpu.uniformWrites[gpu.uniformWrites.length - 1]);
        check('a second frame still updates the uniform', uniform[27] === Math.fround(2 / 60), uniform[27]);
}

// --- Galaxy types: one pipeline, two modes ------------------------------
// The renderer is galaxy-agnostic: the model decides what is generated, and the
// catalog subset and the named stars belong to the Milky Way preset. Both modes
// run the same draw path, so everything a frame needs has to be visible in
// `state` rather than implied by a hard-coded 60 landmarks.
{
        const firstFixedBytes = () => {
                const write = gpu.bufferWrites.filter(w => w.buffer.label === 'star-storage' && w.offset === 0).pop();
                if (!write) return null;
                return new DataView(write.bytes.buffer, write.bytes.byteOffset, write.bytes.byteLength);
        };
        const boot = renderer.state;
        const bootView = firstFixedBytes();
        check('the Milky Way preset boots in hybrid mode with landmarks and the catalog',
                boot.mode === 'hybrid' && boot.galaxyType === 'SBb' && boot.galaxySeed === 7
                && boot.galaxyLabel === 'galaxy SBb #7'
                && boot.landmarkStars === window.Landmarks.count && boot.catalogTotalStars === manifest.starCount,
                { mode: boot.mode, type: boot.galaxyType, landmarks: boot.landmarkStars, catalog: boot.catalogTotalStars });

        const gameModel = galaxy.createGalaxy({ type: 'E4', seed: 11 });
        const game = renderer.regenerate(gameModel);
        const gameExpected = expectedObjectBlock(gameModel, 11, OBJECT_COUNT, OBJECT_MEMBERS, PROCEDURAL);
        check('a generated type runs Game mode: no named stars, no streamed catalog, but objects',
                game.mode === 'game' && game.galaxyType === 'E4' && game.galaxySeed === 11
                && game.landmarkStars === 0 && game.catalogTotalStars === 0
                && game.catalogCells === 0 && game.localProceduralStars === 0
                && game.objectCount === OBJECT_COUNT + clustersLib.clusterCountFor(gameModel)
                && game.objectStars === gameExpected.members,
                { landmarks: game.landmarkStars, catalog: game.catalogTotalStars, cells: game.catalogCells });
        renderer.render(camera, WIDTH, HEIGHT, 3 / 60, input);
        const gamePass = gpu.passes.filter(p => p.label === 'star-sprites').pop();
        check('the generated galaxy fills the frame with the global field + objects',
                game.proceduralStars === PROCEDURAL && game.drawn === game.proceduralStars + OBJECT_MEMBERS
                && gamePass.label === 'star-sprites' && gamePass.draws[0].instances === game.proceduralStars + OBJECT_MEMBERS,
                { drawn: game.drawn, instances: gamePass.draws[0] && gamePass.draws[0].instances, procedural: game.proceduralStars });
        const gameView = firstFixedBytes();
        check('regenerating rewrote the fixed block from the new model',
                !!gameView && !!bootView && (gameView.getFloat32(0, true) !== bootView.getFloat32(0, true)
                        || gameView.getFloat32(8, true) !== bootView.getFloat32(8, true)),
                { boot: bootView && [bootView.getFloat32(0, true), bootView.getFloat32(8, true)],
                        game: gameView && [gameView.getFloat32(0, true), gameView.getFloat32(8, true)] });

        const back = renderer.regenerate(model);
        check('coming back to the preset re-attaches the catalog it was handed at boot',
                back.mode === 'hybrid' && back.catalogTotalStars === manifest.starCount
                && back.landmarkStars === window.Landmarks.count,
                { catalog: back.catalogTotalStars, landmarks: back.landmarkStars });
        renderer.render(camera, WIDTH, HEIGHT, 4 / 60, input);
        check('the re-attached catalog streams back in on the next frame',
                back.cellsResident === manifest.cellCount && back.catalogResidentStars > 0,
                { resident: back.cellsResident, stars: back.catalogResidentStars });
        const passes = gpu.passes.slice(-4);
        check('both modes submit the same four passes, so the switch costs no pipeline',
                passes.length === 4 && passes[0].label === 'star-sprites'
                && passes[1].label === 'nebula-billboards' && passes[2].label === 'gas-grid'
                && passes[3].label === 'tonemap',
                passes.map(pass => pass.label));
}


// --- Galaxy age: the epoch places the field (0.6 E4) -----------------------
// 0.3.3 made the age a generation parameter and 0.6 E3 made the epoch geometry;
// both re-drew the field, which is the 300 ms and the visible rewind E4
// removed. The contract now: an age change keeps every drawn star and its birth
// vector, and the epoch *places* them (orbit.epochMap / the camera.epoch lane) —
// the bulge homology, the disc height law, the arms' re-anchoring. The look
// follows in the background sweep, a slice a frame, so nothing blocks and
// nothing is re-rolled. What must survive is the identity — a key is
// `fieldStarSeed(seed, slot)` — and everything the viewer is looking at that is
// not the field: the landmarks, the catalog, the buffer.
{
        const fixedWrites = () => gpu.bufferWrites.filter(w => w.buffer.label === 'star-storage');
        const asView = (write) => new DataView(write.bytes.buffer, write.bytes.byteOffset, write.bytes.byteLength);
        const meanMag = (view, n) => {
                let sum = 0;
                for (let i = 0; i < n; i++) sum += records.readRecord(view, i * records.RECORD_BYTES).absMag;
                return sum / n;
        };
        const landmarkByte = PROCEDURAL * records.RECORD_BYTES;
        // A *full* write is the whole fixed block (field + landmarks + objects):
        // the epoch look sweep also writes at offset 0, one slice at a time, and
        // it must not be mistaken for a re-draw.
        const fixedBytes = () => (PROCEDURAL + window.Landmarks.count + (renderer.state.objectStars || 0)) * records.RECORD_BYTES;
        const fullWrites = () => fixedWrites().filter(w => w.offset === 0 && w.bytes.byteLength >= PROCEDURAL * records.RECORD_BYTES);
        const refView = asView(fullWrites().pop());
        const refSamples = renderer.state.fieldSamples;
        const refMean = meanMag(refView, 2000);
        const writesBefore = fullWrites().length;
        check('the preset boots at the reference age, needing no exposure offset',
                renderer.state.galaxyAge === galaxy.AGE_REF && renderer.state.magOffset === 0
                && refSamples > 0,
                { age: renderer.state.galaxyAge, offset: renderer.state.magOffset, fieldSamples: refSamples });

        // Everything the age change must not touch, captured while the field is
        // still the reference draw (the staging buffer is the same bytes; the
        // harness copies every write, so these views are stable).
        const baseView = asView(fullWrites().pop());
        const birthWritesBeforeEpoch = gpu.bufferWrites.filter(w => w.buffer.label === 'star-birth-times').length;
        const youngModel = galaxy.modelAtAge(model, 0.5);
        const lane = new Float32Array(4);
        renderer.epochParams(youngModel, lane);
        const aged = renderer.setEpoch(youngModel);
        check('an age change places the field instead of re-drawing it',
                fullWrites().length === writesBefore && aged.fieldSamples === refSamples
                && aged.proceduralStars === PROCEDURAL && aged.galaxyAge === 0.5
                && gpu.bufferWrites.filter(w => w.buffer.label === 'star-birth-times').length === birthWritesBeforeEpoch,
                { fullWrites: fullWrites().length - writesBefore, fieldSamples: aged.fieldSamples, age: aged.galaxyAge });
        check('the epoch lane carries the two scale laws and the arm re-anchoring',
                lane[0] !== 0 && lane[1] < 1 && lane[1] > 0 && lane[2] < 1 && lane[2] > 0
                && renderer.epochSweepState().stale === true,
                { armRotation: lane[0], spheroidScale: lane[1], heatScale: lane[2] });
        // Every drawn star is the same star: same slot, same key, same birth
        // bytes. The map is a view of the epoch, not a rewrite of the field.
        const identity = renderer.starBlocks().identity;
        let keyBreak = -1;
        for (let i = 0; i < 500 && keyBreak < 0; i++) {
                if ((identity[i] >>> 0) !== (window.StarTypesLib.fieldStarSeed(model.seed, i) >>> 0)) keyBreak = i;
        }
        let movedPosition = 0, movedLook = 0, epochFlagged = 0;
        for (let i = 0; i < 500; i++) {
                const a = records.readRecord(refView, i * records.RECORD_BYTES);
                const b = records.readRecord(baseView, i * records.RECORD_BYTES);
                if (a.x !== b.x || a.y !== b.y || a.z !== b.z) movedPosition++;
                if (a.packed !== b.packed) movedLook++;
                if (b.flags & window.StarRecord.FLAG_EPOCH) epochFlagged++;
        }
        check('the identity keys and the birth vectors survive an epoch step: the same stars',
                keyBreak < 0 && movedPosition === 0 && epochFlagged === 500,
                { firstBreak: keyBreak, movedPosition, epochFlagged });
        const formation = renderer.starBlocks().formation;
        let badBirth = 0;
        for (let i = 0; i < PROCEDURAL; i++) {
                if (!Number.isFinite(formation.births[i]) || formation.births[i] < 0
                        || formation.births[i] > galaxy.AGE_REF) badBirth++;
        }
        check('one deterministic reference birth time is stored for every field star',
                formation.births === renderer.fieldBuffers().birth && formation.count === PROCEDURAL && badBirth === 0,
                { count: formation.count, badBirth, first: Array.from(formation.births.slice(0, 4)) });
        check('the CPU gate matches its exact endpoints and increases continuously through the fade',
                window.OrbitLib.gateAt(2, 2) === 0
                && window.OrbitLib.gateAt(2, 2 + window.OrbitLib.BIRTH_FADE_GYR) === 1
                && window.OrbitLib.gateAt(2, 2.025) > 0.4
                && window.OrbitLib.gateAt(2, 2.025) < 0.6,
                [window.OrbitLib.gateAt(2, 2), window.OrbitLib.gateAt(2, 2.025), window.OrbitLib.gateAt(2, 2.05)]);

        // The look is what follows the clock. One full sweep (a slice with a
        // budget no frame would use) re-derives every record at the new age and
        // uploads just those bytes: the positions stay byte-identical, the
        // magnitudes do not.
        const sweepsBefore = fixedWrites().length;
        renderer.stepEpoch(youngModel, 1e9);
        const swept = fixedWrites().slice(sweepsBefore);
        let sweptBytes = 0;
        for (const w of swept) {
                if (w.offset === 0 && w.bytes.byteLength === PROCEDURAL * records.RECORD_BYTES) sweptBytes += w.bytes.byteLength;
        }
        // Streaming looks have their own contiguous uploads; select the field
        // slice explicitly instead of assuming it is the last write.
        const youngView = asView(fixedWrites().filter(w => w.offset === 0
                && w.bytes.byteLength === PROCEDURAL * records.RECORD_BYTES).pop());
        let sweptMoved = 0, sweptLook = 0, sweptEpochBits = 0;
        for (let i = 0; i < 500; i++) {
                const a = records.readRecord(refView, i * records.RECORD_BYTES);
                const b = records.readRecord(youngView, i * records.RECORD_BYTES);
                if (a.x !== b.x || a.y !== b.y || a.z !== b.z) sweptMoved++;
                if (a.packed !== b.packed) sweptLook++;
                if ((b.flags & window.StarRecord.FLAG_EPOCH) === 0) sweptEpochBits++;
        }
        check('the look sweep rewrites the look of a slice and never its birth vector',
                sweptMoved === 0 && sweptLook > 0 && sweptEpochBits === 0
                && sweptBytes === PROCEDURAL * records.RECORD_BYTES
                && renderer.epochSweepState().stale === false,
                { sweptMoved, sweptLook, sweptBytes, records: PROCEDURAL * records.RECORD_BYTES });
        let landmarkKept = true;
        for (let i = 0; i < window.Landmarks.count; i++) {
                const a = records.readRecord(refView, landmarkByte + i * records.RECORD_BYTES);
                const b = records.readRecord(baseView, landmarkByte + i * records.RECORD_BYTES);
                if (a.packed !== b.packed || a.x !== b.x) { landmarkKept = false; break; }
        }
        check('the named stars keep their real magnitudes: they are data, not a what-if',
                landmarkKept && aged.landmarkStars === window.Landmarks.count
                && aged.catalogTotalStars === manifest.starCount && aged.bufferBytes === renderer.state.bufferBytes,
                { landmarks: aged.landmarkStars, catalog: aged.catalogTotalStars });
        // -1.7 mag here (0.3.3 read -0.84, before the epoch tier): the young
        // Milky Way is the dimmer field twice over — its turnoff giants have not
        // arrived, and the same lane height that is mid-disc at the reference
        // epoch is high above a cold young disc, so the heating floor ages those
        // stars. The reference read is the counterfactual (this field at 13.5
        // Gyr, thicker lane), so the gap is large; the uniform's offset brightens
        // the displayed field back either way.
        // The offset is the *exposure*, and since E4 it rides the uniform rather
        // than each record: a record's magnitude can follow the clock through the
        // sweep, but the field's held-back brightness cannot be per-record or a
        // half-swept field would show a seam. So the check is the offset itself,
        // against the mean-luminosity ratio it is defined as.
        const fieldForLook = renderer.fieldBuffers();
        const youngMeanLum = window.StarTypesLib.meanFieldLuminosity(youngModel, fieldForLook, 4096,
                fieldForLook.birth, youngModel.populations.age);
        const refMeanLum = window.StarTypesLib.meanFieldLuminosity(
                galaxy.modelAtAge(youngModel, galaxy.AGE_REF), fieldForLook, 4096,
                fieldForLook.birth, galaxy.AGE_REF);
        const wantOffset = 2.5 * Math.log10(youngMeanLum / refMeanLum);
        check('a young galaxy is a dimmer one, so the uniform\'s offset brightens it back',
                renderer.state.magOffset < -0.5
                && Math.abs(renderer.state.magOffset - wantOffset) < 0.5,
                {
                        offset: +renderer.state.magOffset.toFixed(3),
                        want: +wantOffset.toFixed(3),
                        youngLum: youngMeanLum,
                        refLum: refMeanLum,
                        impliedRefLum: youngMeanLum / Math.pow(10, renderer.state.magOffset / 2.5),
                        meanMagYoung: +meanMag(youngView, 2000).toFixed(3),
                        meanMagRef: +refMean.toFixed(3),
                });
        // Back to the reference age: the map is the exact identity, so the lane
        // is (0, 1, 1) and the drawn field is the field again.
        renderer.setEpoch(model);
        renderer.epochParams(model, lane);
        renderer.stepEpoch(model, 1e9);
        check('the reference epoch is the map\'s exact identity',
                lane[0] === 0 && lane[1] === 1 && lane[2] === 1
                && renderer.epochSweepState().stale === false,
                { lane: Array.from(lane) });

        // The map is a *continuous* function of the age — the property the
        // rejected rebase did not have: it held only at the instants it ran. The
        // check is a refinement: halving the age step must halve the worst step
        // of a pattern-family probe's walk, the walk's total length must converge
        // to the same number, and the net turn must not depend on the step at all
        // (a fixed jump — what "return back in time" was — shows up as a worst
        // step that does not shrink, and a net turn that does). Once the epoch's
        // geometry has settled (the assembly windows close) the map stops moving
        // the probe altogether: from there the running rotation is the lane's,
        // `omegaPattern*T` = the accumulator, never a re-derived rescale of the
        // elapsed clock.
        const orbitLib = window.OrbitLib;
        const probeA = new Float64Array(3), probeB = new Float64Array(3);
        const probeAt = (age, out) => {
                const m = galaxy.modelAtAge(model, age);
                renderer.epochParams(m, lane);
                return orbitLib.epochMap(out, model.centre.x + 2, model.centre.y + 0.5, 0.1,
                        orbitLib.FAMILY_PATTERN, window.StarRecord.FLAG_EPOCH, m);
        };
        const turnTo = (p) => Math.atan2(p[1] - model.centre.y, p[0] - model.centre.x);
        // orbit.wrapAngle lands in [0, 2*pi): a small negative difference must be
        // read signed, or the check would read the 2*pi it wrapped as a jump.
        const signedTurn = (a, b) => {
                const u = (b - a) / (2 * Math.PI);
                return 2 * Math.PI * (u - Math.round(u));
        };
        const mapWalk = (step) => {
                let worst = 0, total = 0, settled = 0;
                probeAt(0.3, probeA);
                const first = turnTo(probeA);
                for (let a = 0.3 + step; a <= 13.0 + 1e-9; a += step) {
                        probeAt(a, probeB);
                        const turn = Math.abs(signedTurn(turnTo(probeA), turnTo(probeB)));
                        total += turn;
                        if (a > 7) settled = Math.max(settled, turn); else worst = Math.max(worst, turn);
                        probeA.set(probeB);
                }
                return { worst, total, settled, net: Math.abs(signedTurn(first, turnTo(probeA))) };
        };
        const coarse = mapWalk(0.05), fine = mapWalk(0.025);
        check('the epoch map turns the field continuously and settles with the geometry',
                fine.worst < 0.75 * coarse.worst
                && Math.abs(fine.total - coarse.total) < 0.05 * coarse.total
                && Math.abs(fine.net - coarse.net) < 0.02
                && coarse.settled < 1e-6 && fine.settled < 1e-6
                && coarse.net > 0.2,
                {
                        worst: [+coarse.worst.toFixed(4), +fine.worst.toFixed(4)],
                        total: [+coarse.total.toFixed(4), +fine.total.toFixed(4)],
                        net: [+coarse.net.toFixed(4), +fine.net.toFixed(4)],
                        settled: [coarse.settled, fine.settled],
                });

        // The object block is drawn with the field and carried (0.7.0). Its
        // members are stars in the same buffer, so an epoch change that re-placed
        // the block re-seeded a slice of the visible sky — five times a second at
        // the top star rate. Nothing about a member's look depends on the running
        // epoch (the age is the object's own, imposed by deriveStarWithAge), so
        // the contract is now: an epoch change leaves the block byte-identical.
        const objectBlockKey = () => {
                const info = renderer.starBlocks();
                const block = info.blocks[2];
                let hash = 0;
                for (let i = 0; i < block.count; i++) {
                        const off = (block.offset + i) * records.RECORD_BYTES;
                        hash = (Math.imul(hash ^ info.view.getUint32(off, true), 16777619)
                                ^ Math.imul(info.view.getUint32(off + 4, true), 31)
                                ^ Math.imul(info.view.getUint32(off + 8, true), 131)
                                ^ Math.imul(info.view.getUint32(off + 12, true), 8191)) | 0;
                }
                return { hash, count: block.count, stars: renderer.state.objectStars };
        };
        const objectBefore = objectBlockKey();
        renderer.setEpoch(galaxy.modelAtAge(model, 0.5));
        const objectAtHalf = objectBlockKey();
        renderer.setEpoch(galaxy.modelAtAge(model, 0.6));
        const objectLater = objectBlockKey();
        const walkedAge = renderer.state.galaxyAge;
        renderer.setEpoch(model);
        const objectBack = objectBlockKey();
        check('an epoch change carries the object block: same seats, same bytes',
                walkedAge === 0.6 && objectBefore.count > 0
                && objectAtHalf.hash === objectBefore.hash && objectAtHalf.count === objectBefore.count
                && objectLater.hash === objectBefore.hash && objectBack.hash === objectBefore.hash
                && objectAtHalf.stars === objectBefore.stars,
                { objects: objectBefore.count, stars: objectBefore.stars,
                  hashes: [objectBefore.hash, objectAtHalf.hash, objectLater.hash, objectBack.hash] });

        // The reuse path is a property of the packed geometry, not a shortcut
        // taken whenever the model object changes: a model that differs only in
        // its population — a gas override at the reference epoch, which the epoch
        // tier leaves at exactly 1 — keeps the sampled field and rewrites records.
        const richer = Object.assign({}, model, {
                populations: Object.assign({}, model.populations, { gasFraction: 0.4 }),
        });
        galaxy.solvePopulationClock(richer);
        const reused = renderer.regenerate(richer);
        check('a model that differs only in its population keeps the sampled field',
                reused.fieldSamples === refSamples && reused.proceduralStars === PROCEDURAL
                && reused.galaxyAge === galaxy.AGE_REF,
                { fieldSamples: reused.fieldSamples, objects: reused.objectCount });

        check('a population-only gas change recalibrates the grid instead of keeping its old reference',
                Math.abs(renderer.gasAccountAt(galaxy.AGE_REF).total - 0.4) < 1e-4,
                { total: renderer.gasAccountAt(galaxy.AGE_REF).total });

        // The complementary direction: a new type is a new galaxy, so the field
        // is drawn again even at the same age.
        const other = renderer.regenerate(galaxy.createGalaxy({ type: 'Sc', seed: 7, age: 0.5 }));
        check('another type re-draws the field even at the same age',
                other.fieldSamples === refSamples + 1 && other.galaxyType === 'Sc' && other.galaxyAge === 0.5,
                { fieldSamples: other.fieldSamples, type: other.galaxyType });
        renderer.regenerate(model);
        renderer.render(camera, WIDTH, HEIGHT, 5 / 60, input);
        check('coming back to the preset at the reference age lands on the boot sky',
                renderer.state.magOffset === 0 && renderer.state.mode === 'hybrid'
                && renderer.state.fieldSamples === refSamples + 2,
                { offset: renderer.state.magOffset, fieldSamples: renderer.state.fieldSamples });
}


// --- Streaming catalog/local evolution (0.7.7) ----------------------------
// This is deliberately a catalog-enabled renderer. A zero-catalog smoke run
// cannot see either the birth gate or the reference-look round trip.
{
        const evoGpu = createMockGpu();
        const evo = rendererModule.createStarRenderer(evoGpu.device, evoGpu.context, evoGpu.format, {
                proceduralStars: 2000, catalogBudgetStars: CATALOG_BUDGET,
                objectMembers: 200, objectCount: 8, gasGrid: false, model,
        });
        evo.prepare(manifest);
        evo.render(camera, WIDTH, HEIGHT, 6 / 60, input);
        const info = evo.starBlocks();
        const reference = new Map();
        let dynamicTotal = 0;
        for (const kind of [3, 4]) {
                const block = info.blocks[kind];
                for (let i = 0; i < block.count; i++) {
                        const slot = block.offset + i;
                        const rec = records.readRecord(info.view, slot * records.RECORD_BYTES);
                        reference.set(info.identity[slot] >>> 0, {
                                kind, slot, x: rec.x, y: rec.y, z: rec.z, packed: rec.packed,
                                birth: info.formation.births[slot],
                        });
                        dynamicTotal++;
                }
        }
        check('catalog-enabled streaming has both local gap-fill and catalog tracks',
                info.blocks[3].count > 0 && info.blocks[4].count > 0 && dynamicTotal > 0,
                { local: info.blocks[3].count, catalog: info.blocks[4].count });
        let finiteBirths = true;
        let referenceGates = true;
        for (const row of reference.values()) {
                if (!Number.isFinite(row.birth) || row.birth < 0 || row.birth > galaxy.AGE_REF) finiteBirths = false;
                if (window.OrbitLib.gateAt(row.birth, galaxy.AGE_REF) !== 1) referenceGates = false;
        }
        const landmarkBlock = info.blocks[1];
        let landmarkGate = true;
        for (let i = 0; i < landmarkBlock.count; i++) {
                if (window.OrbitLib.gateAt(info.formation.births[landmarkBlock.offset + i], 0) !== 1) landmarkGate = false;
        }
        check('streamed births are finite and fully formed at AGE_REF; landmarks survive First light',
                finiteBirths && referenceGates && landmarkGate,
                { finiteBirths, referenceGates, landmarkGate });
        const lastUniform = evoGpu.uniformWrites[evoGpu.uniformWrites.length - 1];
        const formationLane = new Float32Array(lastUniform.buffer, lastUniform.byteOffset, lastUniform.byteLength / 4);
        check('the GPU formation gate covers the full star/birth slot layout',
                formationLane[55] === info.total && info.formation.births.length === info.total,
                { gateLimit: formationLane[55], slots: info.total, births: info.formation.births.length });

        const samplesBefore = evo.state.fieldSamples;
        const zero = galaxy.modelAtAge(model, 0);
        evo.setEpoch(zero);
        evo.stepEpoch(zero, 1e9);
        let zeroLocal = 0, zeroCatalog = 0;
        for (const kind of [3, 4]) {
                const block = info.blocks[kind];
                for (let i = 0; i < block.count; i++) {
                        const active = window.OrbitLib.gateAt(info.formation.births[block.offset + i], 0) > 0;
                        if (kind === 3 && active) zeroLocal++;
                        if (kind === 4 && active) zeroCatalog++;
                }
        }
        check('First light gates every local and catalog star off',
                zeroLocal === 0 && zeroCatalog === 0 && evo.state.fieldSamples === samplesBefore,
                { zeroLocal, zeroCatalog, fieldSamples: evo.state.fieldSamples - samplesBefore });

        const young = galaxy.modelAtAge(model, 2.0);
        evo.setEpoch(young);
        evo.stepEpoch(young, 1e9);
        let changedCatalog = 0, changedLocal = 0, moved = 0, keyed = 0, positionalEpochFlags = 0;
        for (const kind of [3, 4]) {
                const block = info.blocks[kind];
                for (let i = 0; i < block.count; i++) {
                        const slot = block.offset + i;
                        const key = info.identity[slot] >>> 0;
                        const before = reference.get(key);
                        if (!before) continue;
                        keyed++;
                        const rec = records.readRecord(info.view, slot * records.RECORD_BYTES);
                        if (rec.x !== before.x || rec.y !== before.y || rec.z !== before.z) moved++;
                        if (rec.flags & (records.FLAG_EPOCH | records.FLAG_EPOCH_SPHEROID)) positionalEpochFlags++;
                        if (rec.packed !== before.packed) {
                                if (kind === 4) changedCatalog++; else changedLocal++;
                        }
                }
        }
        check('earlier epochs evolve streaming looks without moving observed positions or keys',
                keyed === dynamicTotal && moved === 0 && positionalEpochFlags === 0
                && changedCatalog > 0 && changedLocal > 0,
                { keyed, moved, positionalEpochFlags, changedCatalog, changedLocal });

        evo.setEpoch(model);
        evo.stepEpoch(model, 1e9);
        let restored = 0, restoredGates = 0, restoredPositions = 0;
        for (const kind of [3, 4]) {
                const block = info.blocks[kind];
                for (let i = 0; i < block.count; i++) {
                        const slot = block.offset + i;
                        const before = reference.get(info.identity[slot] >>> 0);
                        if (!before) continue;
                        const rec = records.readRecord(info.view, slot * records.RECORD_BYTES);
                        if (rec.packed === before.packed) restored++;
                        if (rec.x === before.x && rec.y === before.y && rec.z === before.z) restoredPositions++;
                        if (window.OrbitLib.gateAt(info.formation.births[slot], galaxy.AGE_REF) === 1) restoredGates++;
                }
        }
        check('AGE_REF restores every streaming packed look and position exactly, with gate 1',
                restored === dynamicTotal && restoredPositions === dynamicTotal
                && restoredGates === dynamicTotal && evo.epochSweepState().stale === false,
                { restored, restoredPositions, restoredGates, dynamicTotal });

        const savedCamera = Array.from(camera.cameraPos);
        const versionBefore = info.dynamicVersion;
        camera.cameraPos[0] = 0.6;
        camera.cameraPos[1] = 0.2;
        evo.render(camera, WIDTH, HEIGHT, 6.2 / 60, input);
        let shared = 0, stable = 0;
        for (const kind of [3, 4]) {
                const block = info.blocks[kind];
                for (let i = 0; i < block.count; i++) {
                        const slot = block.offset + i;
                        const before = reference.get(info.identity[slot] >>> 0);
                        if (!before) continue;
                        shared++;
                        const rec = records.readRecord(info.view, slot * records.RECORD_BYTES);
                        if (rec.packed === before.packed && rec.x === before.x && rec.y === before.y && rec.z === before.z
                                && info.formation.births[slot] === before.birth) stable++;
                }
        }
        check('camera restreaming preserves shared keys, births, positions and reference looks',
                info.dynamicVersion > versionBefore && shared > 0 && stable === shared
                && evo.epochSweepState().dynamicAt === 0 && !evo.epochSweepState().dynamicStale,
                { shared, stable, version: info.dynamicVersion - versionBefore });
        camera.cameraPos.set(savedCamera);
        evo.dispose();
}


// --- The star budget and the simple lane across a re-draw (0.6) -----------
// The menu's Stars control re-draws the same galaxy with another budget, so a
// budget change must take the allocating path even when the model object is
// unchanged — and only then: the next same-model regenerate is the population
// path again. An age re-draw hands the renderer a carry: the field and object
// thetas turned by the pattern's rotation, the landmarks continued from the
// CPU mirror, so the simple lane does not snap back to the birth layout.
{
        const budGpu = createMockGpu();
        const bud = rendererModule.createStarRenderer(budGpu.device, budGpu.context, budGpu.format, {
                proceduralStars: 2000, catalogBudgetStars: 0, objectMembers: 200, objectCount: 8, model,
        });
        bud.prepare(null);
        const samples0 = bud.state.fieldSamples;
        const same = bud.setProceduralStars(2000);
        const kept = bud.regenerate(model);
        check('an unchanged budget keeps the population-only path',
                same === 2000 && kept.fieldSamples === samples0 && kept.proceduralStars === 2000,
                { fieldSamples: kept.fieldSamples });
        bud.setProceduralStars(3000);
        const grown = bud.regenerate(model);
        check('a new star budget re-draws the same model at the new count',
                grown.proceduralStars === 3000 && grown.fieldSamples === samples0 + 1
                && bud.proceduralTarget() === 3000 && bud.fieldBuffers().count === 3000,
                { procedural: grown.proceduralStars, fieldSamples: grown.fieldSamples });
        const again = bud.regenerate(model);
        check('after the re-draw the budget is clean again',
                again.fieldSamples === samples0 + 1, { fieldSamples: again.fieldSamples });

        const orbitLib = window.OrbitLib;
        const lmCount = window.Landmarks.count;
        const lmPos = new Float32Array(lmCount * 3);
        const lmColor = new Uint8Array(lmCount);
        for (let i = 0; i < lmCount; i++) {
                lmPos[i * 3] = window.Landmarks.ENTRIES[i].x;
                lmPos[i * 3 + 1] = window.Landmarks.ENTRIES[i].y;
                lmPos[i * 3 + 2] = window.Landmarks.ENTRIES[i].z;
                lmColor[i] = window.Landmarks.ENTRIES[i].colorIndex;
        }
        orbitLib.simpleLandmarksInit(lmPos, lmColor, lmCount, model);
        orbitLib.simpleLandmarksStep(400, 400);
        // E4: `regenerate` takes no carry. The simple lane's seeds are the
        // azimuths of the records as *placed* — the field was drawn into the
        // frame the epoch was at, so there is nothing to turn and nothing to
        // shift (the retired `carry.thetaShift` did exactly this by hand).
        bud.setProceduralStars(2500);
        bud.regenerate(model);
        const fixed = budGpu.bufferWrites.filter(w => w.buffer.label === 'star-storage' && w.offset === 0).pop();
        const view = new DataView(fixed.bytes.buffer, fixed.bytes.byteOffset, fixed.bytes.byteLength);
        const thetaWrite = budGpu.thetaWrites.filter(w => w.offset === 0).pop();
        const theta = new Float32Array(thetaWrite.bytes.buffer, thetaWrite.bytes.byteOffset, thetaWrite.bytes.byteLength / 4);
        const wrapPi = (a) => a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
        const cx = model.centre.x, cy = model.centre.y;
        let fieldErr = 0;
        for (let i = 0; i < 2500; i += 7) {
                const r = records.readRecord(view, i * records.RECORD_BYTES);
                const want = wrapPi(Math.atan2(r.y - cy, r.x - cx));
                fieldErr = Math.max(fieldErr, Math.abs(wrapPi(theta[i] - want)));
        }
        let lmErr = 0, lmMoved = 0;
        for (let i = 0; i < lmCount; i++) {
                lmErr = Math.max(lmErr, Math.abs(theta[2500 + i] - Math.fround(orbitLib.simpleLandmarkTheta(i))));
                const birth = Math.atan2(lmPos[i * 3 + 1] - cy, lmPos[i * 3] - cx);
                if (Math.abs(wrapPi(theta[2500 + i] - birth)) > 1e-4) lmMoved++;
        }
        check('the simple lane seeds from the placed azimuths, with no carry to turn',
                fieldErr < 1e-5, { maxErr: fieldErr });
        check('the named stars keep the azimuths the CPU mirror integrated',
                lmErr === 0 && lmMoved > lmCount / 2, { maxErr: lmErr, moved: lmMoved, of: lmCount });
}


// --- Object-block defaults ------------------------------------------------
// Omitted object options fall back to the plan §10 budgets: the block is
// clusterMemberBudget(field) + gasMemberBudget(field) — here the field is
// 100 stars, so 5 cluster particles + 1 gas member. The block scales with
// the selected star count instead of claiming a fixed 20000 members.
{
        const defGpu = createMockGpu();
        const defRenderer = rendererModule.createStarRenderer(defGpu.device, defGpu.context, defGpu.format, {
                proceduralStars: 100,
                catalogBudgetStars: 0,
                model,
        });
        const defState = defRenderer.prepare(null);
        const defCapacity = clustersLib.clusterMemberBudget(100) + objectsLib.gasMemberBudget(100);
        check('omitted object options default to the scaled cluster+gas budgets',
                defState.gasObjectCount === objectsLib.OBJECT_COUNT_DEFAULT
                && defState.clusterCount === clustersLib.clusterCountFor(model)
                && defState.objectStars === defCapacity
                && defState.clusterStars === clustersLib.clusterMemberBudget(100),
                { objects: defState.objectCount, members: defState.objectStars, capacity: defCapacity });
        const defBuffer = defGpu.buffers.find(b => b.label === 'star-storage');
        const defExpected = (100 + defState.landmarkStars + defCapacity
                + rendererModule.LOCAL_PROCEDURAL_DEFAULT) * records.RECORD_BYTES;
        check('the default objects block sizes the buffer',
                defBuffer.size === defExpected, { size: defBuffer.size, expected: defExpected });
        defRenderer.dispose();

        // The coefficient is a budget control, not a relabel: ×0 removes
        // the cluster particles and leaves the gas allowance standing.
        const zeroGpu = createMockGpu();
        const zeroRenderer = rendererModule.createStarRenderer(zeroGpu.device, zeroGpu.context, zeroGpu.format, {
                proceduralStars: 100000,
                catalogBudgetStars: 0,
                clusterExaggeration: 0,
                model,
        });
        const zeroState = zeroRenderer.prepare(null);
        check('cluster exaggeration x0 draws gas members only, and x200 scales the block',
                zeroState.clusterStars === 0 && zeroState.gasObjectStars === objectsLib.gasMemberBudget(100000)
                && zeroRenderer.setClusterExaggeration(200) === 200,
                { clusterStars: zeroState.clusterStars, gasObjectStars: zeroState.gasObjectStars });
        zeroRenderer.setClusterExaggeration(clustersLib.CLUSTER_EXAGGERATION_DEFAULT);
        zeroRenderer.dispose();
}

// --- Exposure -----------------------------------------------------------
{
        input.actions.exposure = 1;
        renderer.render(camera, WIDTH, HEIGHT, 3 / 60, input);
        const uniform = readUniform(gpu.uniformWrites[gpu.uniformWrites.length - 1]);
        check('exposure key raises magZero by one step',
                Math.abs(uniform[24] - (rendererModule.EXPOSURE_DEFAULT + rendererModule.EXPOSURE_STEP)) < 1e-6, uniform[24]);
        check('the exposure action is consumed', input.actions.exposure === 0);

        const clamped = renderer.setExposure(1e6);
        check('exposure clamps to the maximum', clamped === 40, clamped);
        check('exposure clamps to the minimum', renderer.setExposure(-1e6) === 0);
        renderer.setExposure(rendererModule.EXPOSURE_DEFAULT);
}

// --- Linear exposure (ACES pre-multiplier) ------------------------------
{
        input.actions.linearExposure = 1;
        renderer.render(camera, WIDTH, HEIGHT, 3 / 60 + 0.001, input);
        const tmu = readUniform(gpu.tonemapUniformWrites[gpu.tonemapUniformWrites.length - 1]);
        check('; raises the ACES pre-multiplier by one half-stop (×√2)',
                Math.abs(tmu[0] - rendererModule.LINEAR_EXPOSURE_DEFAULT * Math.SQRT2) < 1e-5, tmu[0]);
        check('the linear exposure action is consumed', input.actions.linearExposure === 0);

        input.actions.linearExposure = -1;
        renderer.render(camera, WIDTH, HEIGHT, 3 / 60 + 0.002, input);
        const tmu2 = readUniform(gpu.tonemapUniformWrites[gpu.tonemapUniformWrites.length - 1]);
        check("' lowers the ACES pre-multiplier by one half-stop (×1/√2)",
                Math.abs(tmu2[0] - rendererModule.LINEAR_EXPOSURE_DEFAULT) < 1e-5, tmu2[0]);
        input.actions.linearExposure = 0;

        check('linear exposure clamps to the maximum',
                renderer.setLinearExposure(1e6) === rendererModule.LINEAR_EXPOSURE_MAX);
        check('linear exposure clamps to the minimum',
                renderer.setLinearExposure(-1e6) === rendererModule.LINEAR_EXPOSURE_MIN);
        renderer.setLinearExposure(rendererModule.LINEAR_EXPOSURE_DEFAULT);
}

// --- Moving the camera restreams ----------------------------------------
{
        const writesBefore = gpu.bufferWrites.length;
        camera.step(1 / 60, { keys: { forward: true }, actions: {}, lookDx: 0, lookDy: 0, wheelDelta: 0 });
        camera.cameraPos[0] = 0.6;   // force a cell crossing
        camera.cameraPos[1] = 0.2;
        renderer.render(camera, WIDTH, HEIGHT, 4 / 60, input);
        check('crossing a cell boundary re-uploads the dynamic region',
                gpu.bufferWrites.length > writesBefore, { before: writesBefore, after: gpu.bufferWrites.length });
        // The most recent star-sprites pass reflects the new residency, including
        // a second draw when the catalog follows a partially filled local block.
        const lastSpritePass = gpu.passes.filter(p => p.label === 'star-sprites').pop();
        const lastSpriteInstances = lastSpritePass.draws.reduce((sum, draw) => sum + draw.instances, 0);
        check('the drawn instance count follows the new residency (global + landmarks + objects + local + catalog)',
                lastSpriteInstances === renderer.state.drawn
                && renderer.state.drawn === renderer.state.proceduralStars + renderer.state.landmarkStars + OBJECT_MEMBERS
                        + renderer.state.localProceduralStars + renderer.state.catalogResidentStars,
                { drawn: renderer.state.drawn, draws: lastSpritePass.draws });
}

// --- Leaving the catalog volume -----------------------------------------
{
        const passesBefore = gpu.passes.length;
        camera.cameraPos[0] = 90;
        camera.cameraPos[1] = 90;
        camera.cameraPos[2] = 25;
        const far = { keys: {}, actions: { reset: 0, exposure: 0, linearExposure: 0 }, lookDx: 0, lookDy: 0, wheelDelta: 0 };
        renderer.render(camera, WIDTH, HEIGHT, 5 / 60, far);
        check('a camera outside the catalog volume drops every catalog star',
                renderer.state.catalogResidentStars === 0, renderer.state.catalogResidentStars);
        // Four more passes were appended (star-sprites + nebulae + gas + tonemap).
        const newPasses = gpu.passes.slice(passesBefore);
        check('the frame still produces four passes (star + nebulae + gas + tonemap)',
                newPasses.length === 4
                && newPasses[0].label === 'star-sprites'
                && newPasses[1].label === 'nebula-billboards'
                && newPasses[2].label === 'gas-grid'
                && newPasses[3].label === 'tonemap',
                newPasses.map(p => p.label));
        // The star pass still drew procedural + landmark stars even with no catalog.
        check('the star pass draws the procedural field + landmarks + objects (no local/catalog when outside volume)',
                newPasses[0].draws[0].instances === renderer.state.proceduralStars + renderer.state.landmarkStars + OBJECT_MEMBERS
                        + renderer.state.localProceduralStars,
                newPasses[0].draws[0]);
        check('the render pass still clears and stores the frame',
                gpu.lastPass.colorAttachments[0].loadOp === 'clear'
                && gpu.lastPass.colorAttachments[0].storeOp === 'store');
        // The clear colour on the tonemap pass must not be pure black: an
        // all-black frame is indistinguishable from a stalled renderer.
        const clear = gpu.lastPass.colorAttachments[0].clearValue;
        check('the clear colour is a dark sky, not black',
                clear.r > 0 || clear.g > 0 || clear.b > 0, clear);
}

// --- HDR texture recreated on resize ------------------------------------
{
        const texturesBefore = gpu.textures.length;
        renderer.render(camera, 1280, 720, 6 / 60, input);
        check('a resize creates a new HDR texture', gpu.textures.length === texturesBefore + 1,
                { before: texturesBefore, after: gpu.textures.length });
        const newHdr = gpu.textures[gpu.textures.length - 1];
        check('the recreated HDR texture matches the new canvas size',
                newHdr.label === 'hdr-intermediate' && newHdr.size[0] === 1280 && newHdr.size[1] === 720,
                { label: newHdr.label, size: newHdr.size });
}

// --- HDR output mode (rgba16float + extended swapchain) ----------------
// A second renderer with `hdr:true` uses the same three-pass architecture
// (sprites → nebulae → rgba16float intermediate → tonemap → swapchain) but the tonemap
// uniform's w = 1 so the shader allows output values >1.0 into the HDR canvas.
{
        const hdrGpu = createMockGpu();
        const hdrRenderer = rendererModule.createStarRenderer(hdrGpu.device, hdrGpu.context, 'rgba16float', {
                proceduralStars: 2000,
                catalogBudgetStars: 0,
                model,
                hdr: true,
        });
        hdrRenderer.prepare(null);
        check('hdrOutput flag is reflected in renderer state',
                hdrRenderer.state.hdrOutput === true, hdrRenderer.state.hdrOutput);

        const hdrInput = { keys: {}, actions: { reset: 0, exposure: 0, linearExposure: 0 }, lookDx: 0, lookDy: 0, wheelDelta: 0 };
        const passesBefore = hdrGpu.passes.length;
        hdrRenderer.render(camera, WIDTH, HEIGHT, 7 / 60, hdrInput);

        const newPasses = hdrGpu.passes.slice(passesBefore);
        check('the HDR path runs four passes (star-sprites + nebulae + gas + tonemap), same as SDR',
                newPasses.length === 4
                && newPasses[0].label === 'star-sprites'
                && newPasses[1].label === 'nebula-billboards'
                && newPasses[2].label === 'gas-grid'
                && newPasses[3].label === 'tonemap',
                newPasses.map(p => p.label));
        check('the HDR path creates an rgba16float intermediate texture',
                hdrGpu.textures.some(t => t.label === 'hdr-intermediate' && t.format === 'rgba16float'),
                hdrGpu.textures.map(t => `${t.label}:${t.format}`));

        const tmu = readUniform(hdrGpu.tonemapUniformWrites[hdrGpu.tonemapUniformWrites.length - 1]);
        check('tonemap uniform on the HDR path has output mode w=1.0',
                tmu[3] === 1.0, { tmu });
        check('tonemap uniform on HDR still carries exposure, white point, saturation',
                Math.abs(tmu[0] - rendererModule.LINEAR_EXPOSURE_DEFAULT) < 1e-6
                && Math.abs(tmu[1] - rendererModule.WHITE_POINT_DEFAULT) < 1e-6
                && Math.abs(tmu[2] - rendererModule.SATURATION_DEFAULT) < 1e-6,
                { tmu });

        // `;` still works on the HDR path (linearExposure = pre-multiplier
        // before the filmic curve, same math as SDR).
        hdrInput.actions.linearExposure = 1;
        hdrRenderer.render(camera, WIDTH, HEIGHT, 7.1 / 60, hdrInput);
        const tmu2 = readUniform(hdrGpu.tonemapUniformWrites[hdrGpu.tonemapUniformWrites.length - 1]);
        check('; raises linearExposure by one half-stop on the HDR path',
                Math.abs(tmu2[0] - rendererModule.LINEAR_EXPOSURE_DEFAULT * Math.SQRT2) < 1e-5, tmu2[0]);
        check('output mode stays w=1 after input events', tmu2[3] === 1.0, tmu2[3]);

        hdrRenderer.dispose();
}


// --- Teardown -----------------------------------------------------------
{
        renderer.dispose();
        check('dispose destroys the star buffer', catalogs[0].destroyed === true);
        check('no WGSL compilation errors were reported', renderer.shaderError() === null, renderer.shaderError());
}

function cellManagerFrom(m, budget) {
        return require('../src/stream/cell-manager.js').createCellManager(m, { budgetStars: budget });
}

// --- Engine select + simple-step dispatch (0.4.5) ----------------------------
// A fresh small renderer, so the epoch starts exactly where the checks say.
// The classic engine dispatches no compute; the simple engine seeds one
// azimuth per slot, packs the step uniform and dispatches ceil(slots/64)
// workgroups — and frozen time dispatches nothing under either engine.
{
        const engGpu = createMockGpu();
        const engModel = galaxy.createGalaxy({ seed: 7 });
        const engRenderer = rendererModule.createStarRenderer(engGpu.device, engGpu.context, engGpu.format, {
                proceduralStars: 1000,
                catalogBudgetStars: 0,
                localProceduralStars: 500,
                objectMembers: 100,
                objectCount: 5,
                model: engModel,
        });
        engRenderer.prepare(null);
        const thetaBuf = engGpu.buffers.find(b => b.label === 'simple-theta');
        const starBuf = engGpu.buffers.find(b => b.label === 'star-storage');
        const nebBuf = engGpu.buffers.find(b => b.label === 'nebula-storage');
        const totalSlots = thetaBuf.size / 4;
        check('the classic engine is the default and allocates one theta f32 per slot',
                engRenderer.state.engine === 'classic' && totalSlots === starBuf.size / 16,
                { engine: engRenderer.state.engine, slots: totalSlots });
        const birthBuf = engGpu.buffers.find(b => b.label === 'star-birth-times');
        const gasA = engGpu.buffers.find(b => b.label === 'gas-grid-a');
        const gasB = engGpu.buffers.find(b => b.label === 'gas-grid-b');
        check('state.bufferBytes counts the star, nebula, theta, birth and two gas-grid buffers',
                engRenderer.state.bufferBytes === starBuf.size + nebBuf.size + thetaBuf.size + birthBuf.size
                        + gasA.size + gasB.size,
                { bufferBytes: engRenderer.state.bufferBytes });
        const fixedSlots = 1000 + window.Landmarks.count + 100;
        const fixedTheta = engGpu.thetaWrites.find(w => w.offset === 0);
        const firstTheta = fixedTheta && new Float32Array(
                fixedTheta.bytes.buffer, fixedTheta.bytes.byteOffset, fixedTheta.bytes.byteLength / 4)[0];
        check('prepare seeds the fixed-block azimuths from the birth positions',
                !!fixedTheta && fixedTheta.bytes.byteLength === fixedSlots * 4
                && Number.isFinite(firstTheta) && Math.abs(firstTheta) <= Math.PI + 1e-6,
                { bytes: fixedTheta && fixedTheta.bytes.byteLength, firstTheta });

        engRenderer.render(camera, 320, 200, 10, input, 1);
        const classicUniform = readUniform(engGpu.uniformWrites[engGpu.uniformWrites.length - 1]);
        check('classic frames carry only the classic bit and dispatch no compute',
                classicUniform[44] === window.OrbitLib.ENGINE_CLASSIC && engGpu.computePasses.length === 0
                && engGpu.simpleUniformWrites.length === 0,
                { engine: classicUniform[44] });

        // With no star clock passed the carry runs at T = 0, where the drawn
        // position IS the placed birth — so the upload degenerates to exactly
        // the old birth re-seed, full range, and the boot behaviour is
        // unchanged (R4, engine-switch-test pins the T > 0 law).
        check('setEngine(simple) switches the state and carries the T = 0 sky (the birth seed there)',
                engRenderer.setEngine('simple') === 'simple'
                && engGpu.thetaWrites[engGpu.thetaWrites.length - 1].bytes.byteLength === totalSlots * 4,
                { engine: engRenderer.state.engine });
        engRenderer.render(camera, 320, 200, 11, input, 1);
        const simpleUniform = readUniform(engGpu.uniformWrites[engGpu.uniformWrites.length - 1]);
        const stepUniform = readUniform(engGpu.simpleUniformWrites[engGpu.simpleUniformWrites.length - 1]);
        const stepPass = engGpu.computePasses[engGpu.computePasses.length - 1];
        check('simple frames carry the simple bit with the apocenter force beside it',
                simpleUniform[44] === window.OrbitLib.ENGINE_SIMPLE
                && simpleUniform[45] === Math.fround(window.OrbitLib.getApocenterForce()),
                { mask: simpleUniform[44], force: simpleUniform[45] });
        check('a simple frame packs the step uniform (nSub > 0, count = slots)',
                stepUniform.length === 20 && stepUniform[1] >= 1 && stepUniform[2] === totalSlots
                && stepUniform[0] > 0,
                { h: stepUniform[0], nSub: stepUniform[1], count: stepUniform[2] });
        check('a simple frame dispatches ceil(slots/64) workgroups before the sprites',
                engGpu.computePasses.length === 1 && stepPass.label === 'simple-step'
                && stepPass.dispatches.length === 1
                && stepPass.dispatches[0][0] === Math.ceil(totalSlots / 64),
                { dispatches: stepPass.dispatches, slots: totalSlots });

        const passesBefore = engGpu.computePasses.length;
        engRenderer.render(camera, 320, 200, 12, input, 0);
        check('frozen time dispatches nothing under the simple engine',
                engGpu.computePasses.length === passesBefore);
        check('leaving the engine stops the dispatch again',
                engRenderer.setEngine('classic') === 'classic'
                && (engRenderer.render(camera, 320, 200, 13, input, 1), engGpu.computePasses.length === passesBefore));
        check('apocenter selection uses the analytic vertex path without compute dispatch',
                engRenderer.setEngine('apocenter') === 'apocenter');
        engRenderer.render(camera, 320, 200, 14, input, 1);
        const apoUniform = readUniform(engGpu.uniformWrites[engGpu.uniformWrites.length - 1]);
	check('apocenter packs its mask bit, the bounded force, the model bar angle and the share',
		apoUniform[44] === window.OrbitLib.ENGINE_APOCENTER
		&& apoUniform[45] === Math.fround(window.OrbitLib.APOCENTER_ECC_MAX)
		&& Math.abs(apoUniform[46] - Math.fround(engModel.spheroid.tiltDeg * Math.PI / 180)) < 1e-7
		&& apoUniform[47] === Math.fround(window.OrbitLib.getApocenterShare())
		&& engGpu.computePasses.length === passesBefore,
		{ mask: apoUniform[44], force: apoUniform[45], barTilt: apoUniform[46], share: apoUniform[47] });

	// Combined masks (movement parity): the bar tilt rides every mask that
	// carries the apocenter bit — not only the bare one — and simple+apocenter
	// still dispatches the friction-field step.
	engRenderer.setEngine(['classic', 'apocenter']);
	engRenderer.render(camera, 320, 200, 15, input, 1);
	const comboCA = readUniform(engGpu.uniformWrites[engGpu.uniformWrites.length - 1]);
	check('classic+apocenter packs both bits and keeps the model bar angle',
		comboCA[44] === (window.OrbitLib.ENGINE_CLASSIC | window.OrbitLib.ENGINE_APOCENTER)
		&& Math.abs(comboCA[46] - Math.fround(engModel.spheroid.tiltDeg * Math.PI / 180)) < 1e-7
		&& engGpu.computePasses.length === passesBefore,
		{ mask: comboCA[44], barTilt: comboCA[46] });
	engRenderer.setEngine(['simple', 'apocenter']);
	engRenderer.render(camera, 320, 200, 16, input, 1);
	const comboSA = readUniform(engGpu.uniformWrites[engGpu.uniformWrites.length - 1]);
	check('simple+apocenter packs both bits, the bar angle, and dispatches the simple step',
		comboSA[44] === (window.OrbitLib.ENGINE_SIMPLE | window.OrbitLib.ENGINE_APOCENTER)
		&& Math.abs(comboSA[46] - Math.fround(engModel.spheroid.tiltDeg * Math.PI / 180)) < 1e-7
		&& engGpu.computePasses.length === passesBefore + 1,
		{ mask: comboSA[44], barTilt: comboSA[46] });
	engRenderer.setEngine('classic');

	// R4: a switch into simple at T > 0 uploads the outgoing lane's drawn
	// positions — the sky the user was looking at — not the birth azimuths,
	// while the same switch with the clock omitted stays the T = 0 birth seed.
	const carryMarker = engGpu.thetaWrites.length;
	engRenderer.setEngine('simple', 500);
	const carryWrite = engGpu.thetaWrites[engGpu.thetaWrites.length - 1];
	const carryTheta = new Float32Array(carryWrite.bytes.buffer, carryWrite.bytes.byteOffset, carryWrite.bytes.byteLength / 4);
	engRenderer.setEngine('classic');
	engRenderer.setEngine('simple');
	const seedWrite = engGpu.thetaWrites[engGpu.thetaWrites.length - 1];
	const seedTheta = new Float32Array(seedWrite.bytes.buffer, seedWrite.bytes.byteOffset, seedWrite.bytes.byteLength / 4);
	let sweptSlots = 0;
	const TAU = window.OrbitLib.TAU;
	for (let i = 0; i < carryTheta.length; i++) {
		const d = Math.abs(carryTheta[i] - seedTheta[i]) % TAU;
		if (Math.min(d, TAU - d) > 1e-6) sweptSlots++;
	}
	check('a carried switch at T > 0 leaves the birth seed by the swept arc',
		carryWrite.bytes.byteLength === totalSlots * 4 && seedWrite.bytes.byteLength === totalSlots * 4
		&& sweptSlots > totalSlots / 2,
		{ sweptSlots, totalSlots });
	engRenderer.setEngine('classic');

        // Headroom / highlight desat ride the tonemap uniform's second vec4.
        engRenderer.setHeadroom(4);
        engRenderer.setHighlightDesat(0);
        engRenderer.render(camera, 320, 200, 14, input, 0);
        const tmu = readUniform(engGpu.tonemapUniformWrites[engGpu.tonemapUniformWrites.length - 1]);
        check('headroom and highlight desat reach the tonemap uniform',
                tmu[4] === 4 && tmu[5] === 0
                && engRenderer.state.headroom === 4 && engRenderer.state.highlightDesat === 0,
                { headroom: tmu[4], desat: tmu[5] });
        check('headroom clamps to [1, 8] and desat to [0, 1]',
                engRenderer.setHeadroom(99) === 8 && engRenderer.setHeadroom(-99) === 1
                && engRenderer.setHighlightDesat(99) === 1 && engRenderer.setHighlightDesat(-99) === 0);
}

// --- Deep time: the census is drawn in the reference frame (0.7.3a) -------
// 0.7.2 sent the Evolve preset to T = 0. A field drawn *there* used to be
// sampled from that epoch's own geometry: a 0-size spheroid and a disc at the
// heat floor deliver almost no disc mass, so the draw handed the whole run a
// halo-only census that no later epoch could undo (99.7 % halo, measured). The
// fix draws the census in the reference frame and measures the epoch map from
// that same frame, so a deep-time draw is the present-day census gated by
// birth — and placing it back at AGE_REF is the identity map.
{
        const orbitLib = window.OrbitLib;
        const deepGpu = createMockGpu();
        const deepModel = galaxy.createGalaxy({ seed: 7, age: galaxy.AGE_MIN });
        const deep = rendererModule.createStarRenderer(deepGpu.device, deepGpu.context, deepGpu.format, {
                proceduralStars: PROCEDURAL,
                catalogBudgetStars: 0,
                objectMembers: OBJECT_MEMBERS,
                objectCount: OBJECT_COUNT,
                model: deepModel,
        });
        deep.prepare(null);
        const reference = galaxy.modelAtAge(deepModel, galaxy.AGE_REF);
        const field = deep.fieldBuffers();
        const shares = (components) => {
                const count = [0, 0, 0, 0];
                for (let i = 0; i < field.count; i++) count[components[i]]++;
                return count.map((n) => n / field.count);
        };
        const referenceField = window.SamplingLib.sampleGalaxyStars(reference, 7, PROCEDURAL);
        const drawnShares = shares(field.component);
        const wantedShares = shares(referenceField.component);
        const worstShare = Math.max(...drawnShares.map((v, i) => Math.abs(v - wantedShares[i])));
        check('a deep-time draw is the reference census: every component share matches',
                field.count === PROCEDURAL && worstShare < 1e-3,
                { drawn: drawnShares.map((v) => +v.toFixed(3)), reference: wantedShares.map((v) => +v.toFixed(3)) });
        const base = orbitLib.getEpochBase();
        check('the epoch map is measured from the reference draw, not from the degenerate epoch',
                Math.abs(base.spheroidA - reference.spheroid.a) < 1e-9
                && base.spheroidA > 0 && base.heat === 1,
                { baseA: base.spheroidA, referenceA: reference.spheroid.a, baseHeat: base.heat });
        const identity = new Float32Array(4);
        deep.epochParams(reference, identity);
        check('placing the deep-time draw back at AGE_REF is the identity map',
                Math.abs(identity[0]) < 1e-9 && identity[1] === 1 && identity[2] === 1,
                { armRotation: identity[0], spheroidScale: identity[1], heatScale: identity[2] });
        const formedNow = deep.censusFormedAt(deepModel.populations.age);
        const gasNowCensus = deep.censusGasAt(deepModel.populations.age);
        check('at T = 0 nothing has formed and all of the census is gas',
                formedNow === 0 && gasNowCensus === 1,
                { formed: formedNow, gas: gasNowCensus });
        check('at AGE_REF the same histogram is fully formed and lands on the type gas fraction exactly',
                deep.censusFormedAt(galaxy.AGE_REF) === 1
                && deep.censusGasAt(galaxy.AGE_REF) === deepModel.populations.gasFraction,
                { formed: deep.censusFormedAt(galaxy.AGE_REF), gas: deep.censusGasAt(galaxy.AGE_REF) });
        // The endpoint exactness the E3 size law and the AGE_REF bit-for-bit
        // contract rely on: main.js writes the account onto the model and
        // re-solves, so the sequence is replayed here. The reference epoch must
        // come back with an arm contrast of exactly 1, not 0.9999999999999999.
        const withCensus = galaxy.modelAtAge(reference, galaxy.AGE_REF);
        withCensus.populations.viewGasNow = deep.censusGasAt(galaxy.AGE_REF);
        const solved = galaxy.modelAtAge(withCensus, galaxy.AGE_REF);
        check('the reference epoch comes back through the census account with an arm contrast of exactly 1',
                solved.epoch.armContrast === 1 && solved.epoch.gasRatio === 1,
                { armContrast: solved.epoch.armContrast, gasRatio: solved.epoch.gasRatio });
        // The census is what the gas account reads: in between, the formed
        // fraction rises and the view gas falls, both strictly.
        let monotone = true;
        let previous = -1;
        for (let age = 0; age <= galaxy.AGE_REF + 1e-9; age += 0.25) {
                const formed = deep.censusFormedAt(age);
                if (!(formed >= previous)) monotone = false;
                previous = formed;
        }
        check('the drawn census grows monotonically through the run', monotone);

        // Star clusters and composite objects are drawn in the reference frame
        // even when prepare() starts at T = 0, and every member is gated by its
        // formation time: 0 visible at First light (T = 0), growing monotonically
        // through the epoch walk to 100 % at AGE_REF.
        const deepInfo = deep.starBlocks();
        const objOff = deepInfo.formation.objectOffset;
        const objCnt = deepInfo.formation.objectCount;
        const countActiveObjects = (age) => {
                let active = 0;
                for (let i = 0; i < objCnt; i++) {
                        if (orbitLib.gateAt(deepInfo.formation.births[objOff + i], age) > 0) active++;
                }
                return active;
        };
        const activeAt0 = countActiveObjects(0);
        const activeAt1 = countActiveObjects(1.0);
        const activeAt4 = countActiveObjects(4.0);
        const activeAtRef = countActiveObjects(galaxy.AGE_REF);
        check('deep-time prepare places the reference cluster census and gates all clusters/objects off at T = 0',
                deep.state.clusterCount === clustersLib.clusterCountFor(reference)
                && objCnt === deep.state.objectStars && objCnt > 0
                && activeAt0 === 0 && activeAt1 > 0 && activeAt4 > activeAt1
                && activeAtRef === objCnt,
                { clusters: deep.state.clusterCount, objCnt, activeAt0, activeAt1, activeAt4, activeAtRef });

        // Continuous epoch exposure (magOffset) across 3.3 -> 3.7 Gyr and fine
        // 2 Myr steps: no giant-box shot-noise oscillation at 3.5 Gyr, and
        // setEpoch refreshes state.magOffset immediately.
        const bandAges = [3.3, 3.4, 3.45, 3.5, 3.55, 3.6, 3.7];
        const bandOffsets = bandAges.map((age) => {
                deep.setEpoch(galaxy.modelAtAge(reference, age));
                return deep.state.magOffset;
        });
        let bandMonotone = true;
        let maxBandStep = 0;
        for (let i = 1; i < bandOffsets.length; i++) {
                if (bandOffsets[i] < bandOffsets[i - 1] - 1e-6) bandMonotone = false;
                maxBandStep = Math.max(maxBandStep, Math.abs(bandOffsets[i] - bandOffsets[i - 1]));
        }
        let maxFineStep = 0;
        let prevFine = null;
        for (let age = 3.44; age <= 3.60 + 1e-9; age = Math.round((age + 0.002) * 1000) / 1000) {
                deep.setEpoch(galaxy.modelAtAge(reference, age));
                if (prevFine !== null) maxFineStep = Math.max(maxFineStep, Math.abs(deep.state.magOffset - prevFine));
                prevFine = deep.state.magOffset;
        }
        check('epoch magOffset is smooth and monotonic across 3.3-3.7 Gyr with no 3.5 Gyr dip or 2 Myr jump',
                bandMonotone && maxBandStep < 0.02 && maxFineStep < 0.001,
                { bandOffsets: bandOffsets.map((v) => +v.toFixed(4)), maxBandStep: +maxBandStep.toFixed(5), maxFineStep: +maxFineStep.toFixed(6) });
        deep.dispose();
}

// --- Report -------------------------------------------------------------
let passed = 0;
let failed = 0;
for (const c of checks) {
        if (c.pass) passed++; else failed++;
        console.log(`  ${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.pass ? '' : `  -> ${JSON.stringify(c.detail)}`}`);
}
console.log(`\n${passed}/${checks.length} passed, ${failed} failed`);

const logPath = path.join(__dirname, 'logs', 'renderer.json');
logFile.writeLog(logPath, {
        date: new Date().toISOString(),
        proceduralStars: prepareState.proceduralStars,
        catalogStars: prepareState.catalogTotalStars,
        prepareMs,
        totalChecks: checks.length,
        passed,
        failed,
        checks,
});
console.log('\n=== VERDICT ===');
console.log(failed === 0 ? 'PASS — renderer streams, packs and draws as documented' : `FAIL — ${failed} checks failed`);
process.exit(failed === 0 ? 0 : 1);
