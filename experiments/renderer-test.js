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

const fs = require('fs');
const path = require('path');

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
const nebulaLib = require('../src/math/nebula.js');
const Camera = require('../src/core/camera.js');

const checks = [];
function check(name, pass, detail) {
        checks.push({ name, pass: !!pass, detail });
        return !!pass;
}

// --- Mock device ---------------------------------------------------------
function createMockGpu() {
        const gpu = {
                buffers: [],
                textures: [],
                shaderModules: [],
                pipelines: [],
                uniformWrites: [],
                tonemapUniformWrites: [],
                simpleUniformWrites: [],
                thetaWrites: [],
                bufferWrites: [],
                draws: [],
                passes: [],
                computePasses: [],
                passedUniformData: null,
        };

        gpu.device = {
                limits: {
                        maxStorageBufferBindingSize: 256 * 1024 * 1024,
                        maxBufferSize: 256 * 1024 * 1024,
                        maxStorageBuffersPerShaderStage: 8,
                },
                createBuffer(desc) {
                        const buffer = { label: desc.label, size: desc.size, usage: desc.usage, destroyed: false, destroy() { this.destroyed = true; } };
                        gpu.buffers.push(buffer);
                        return buffer;
                },
                createShaderModule(desc) {
                        gpu.shaderModules.push(desc);
                        return { label: desc.label, getCompilationInfo: () => Promise.resolve({ messages: [] }) };
                },
                createTexture(desc) {
                        const texture = { label: desc.label, size: desc.size, format: desc.format, usage: desc.usage, destroy() {} };
                        gpu.textures.push(texture);
                        return { ...texture, createView: () => ({ texture }) };
                },
                createBindGroupLayout(desc) { return { desc }; },
                createPipelineLayout(desc) { return { desc }; },
                createRenderPipeline(desc) { gpu.pipelines.push(desc); return { label: desc.label }; },
                createComputePipeline(desc) { gpu.pipelines.push(desc); return { label: desc.label }; },
                createBindGroup(desc) { return { desc }; },
                createCommandEncoder(desc) {
                        return {
                                label: desc && desc.label,
                                beginRenderPass(passDesc) {
                                        gpu.lastPass = passDesc;
                                        const passObj = {
                                                label: passDesc && passDesc.label,
                                                desc: passDesc,
                                                draws: [],
                                                setPipeline(p) { this.pipeline = p; },
                                                setBindGroup() {},
                                                draw(vertices, instances, firstVertex, firstInstance) {
                                                        const d = { vertices, instances, firstVertex, firstInstance, pipeline: this.pipeline, pass: this.label };
                                                        this.draws.push(d);
                                                        gpu.draws.push(d);
                                                },
                                                end() {},
                                        };
                                        gpu.passes.push(passObj);
                                        return passObj;
                                },
                                beginComputePass(passDesc) {
                                        const passObj = {
                                                label: passDesc && passDesc.label,
                                                dispatches: [],
                                                setPipeline(p) { this.pipeline = p; },
                                                setBindGroup() {},
                                                dispatchWorkgroups(x, y, z) {
                                                        this.dispatches.push([x, y || 1, z || 1]);
                                                },
                                                end() {},
                                        };
                                        gpu.computePasses.push(passObj);
                                        return passObj;
                                },
                                finish() { return { label: 'command-buffer' }; },
                        };
                },
                queue: {
                        writeTexture() {},
                        writeBuffer(buffer, offset, data, dataOffset, size) {
                                const length = size === undefined ? data.byteLength - (dataOffset || 0) : size;
                                const copy = new Uint8Array(data, dataOffset || 0, length).slice();
                                if (buffer.label === 'star-camera-uniform') gpu.uniformWrites.push(copy);
                                else if (buffer.label === 'tonemap-uniform') gpu.tonemapUniformWrites.push(copy);
                                else if (buffer.label === 'simple-step-uniform') gpu.simpleUniformWrites.push(copy);
                                else if (buffer.label === 'simple-theta') gpu.thetaWrites.push({ buffer, offset, bytes: copy });
                                else gpu.bufferWrites.push({ buffer, offset, bytes: copy });
                        },
                        submit() {},
                },
        };

        gpu.context = {
                getCurrentTexture: () => ({ width: 1920, height: 1080, createView: () => ({}) }),
        };
        gpu.format = 'bgra8unorm';
        return gpu;
}

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
        check('four shader modules are created (star-sprite + tonemap + nebula-billboard + simple-step)',
                gpu.shaderModules.length === 4
                && gpu.shaderModules[0].code === window.GalaxyShaders.SHADERS['star-sprite']
                && gpu.shaderModules[1].code === window.GalaxyShaders.SHADERS['tonemap']
                && gpu.shaderModules[2].code === window.GalaxyShaders.SHADERS['nebula-billboard']
                && gpu.shaderModules[3].code === window.GalaxyShaders.SHADERS['simple-step'],
                { modules: gpu.shaderModules.map(s => s.label) });
        check('all wired shaders declare their entry points',
                gpu.shaderModules.filter(s => s.label !== 'simple-step')
                        .every(s => /@vertex\s+fn\s+vs_main/.test(s.code) && /@fragment\s+fn\s+fs_main/.test(s.code))
                && /@compute/.test(gpu.shaderModules[3].code)
                && /fn\s+main\(@builtin\(global_invocation_id\)/.test(gpu.shaderModules[3].code));
        const spritePipeline = gpu.pipelines.find(p => p.label === 'star-sprite-pipeline');
        const tonemapPipeline = gpu.pipelines.find(p => p.label === 'tonemap-pipeline');
        const nebulaPipeline = gpu.pipelines.find(p => p.label === 'nebula-billboard-pipeline');
        const stepPipeline = gpu.pipelines.find(p => p.label === 'simple-step-pipeline');
        check('four pipelines are created (star-sprite + tonemap + nebula-billboard + simple-step) — no hdr-direct bypass',
                !!spritePipeline && !!tonemapPipeline && !!nebulaPipeline && !!stepPipeline
                && gpu.pipelines.length === 4,
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
{
        const bytes = gpu.bufferWrites.filter(w => w.buffer.label === 'star-storage')[0].bytes;
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const base = prepareState.proceduralStars + prepareState.landmarkStars;
        check('the renderer reports the placed objects and their apportioned members',
                prepareState.objectCount === OBJECT_COUNT && prepareState.objectStars === OBJECT_MEMBERS,
                { objects: prepareState.objectCount, members: prepareState.objectStars });
        let visible = 0;
        let finite = 0;
        let classOk = 0;
        let magOk = 0;
        for (let i = 0; i < OBJECT_MEMBERS; i++) {
                const rec = records.readRecord(view, (base + i) * records.RECORD_BYTES);
                if (rec.visible) visible++;
                if (Number.isFinite(rec.x) && Number.isFinite(rec.y) && Number.isFinite(rec.z)) finite++;
                if (rec.colorIndex < records.SPECTRAL_CLASSES.length) classOk++;
                if (rec.absMag >= records.ABS_MAG_MIN && rec.absMag <= records.ABS_MAG_MAX) magOk++;
        }
        check('every objects-block record is visible and finite',
                visible === OBJECT_MEMBERS && finite === OBJECT_MEMBERS, { visible, finite });
        check('every objects-block record carries a valid colour and magnitude',
                classOk === OBJECT_MEMBERS && magOk === OBJECT_MEMBERS, { classOk, magOk });
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
        check('the first frame writes the dynamic region (local gap-fill + catalog) starting at localProc offset',
                dynamicWrites.length === 1 && dynamicWrites[0].offset === localOffset,
                { writes: dynamicWrites.length, offset: dynamicWrites[0] && dynamicWrites[0].offset, localOffset });

        // Three passes per frame: star-sprite, nebula billboards, tonemap.
        const spritePass = gpu.passes.find(p => p.label === 'star-sprites');
        const nebulaPass = gpu.passes.find(p => p.label === 'nebula-billboards');
        const tonemapPass = gpu.passes.find(p => p.label === 'tonemap');
        check('three render passes are submitted per frame (stars, nebulae, tonemap)',
                spritePass && nebulaPass && tonemapPass && spritePass !== nebulaPass && nebulaPass !== tonemapPass,
                gpu.passes.map(p => p.label));
        check('the star-sprite pass draws exactly the resident stars (global + landmarks + objects + local + catalog)',
                spritePass.draws.length === 1 && spritePass.draws[0].instances === renderer.state.drawn
                && renderer.state.drawn === prepareState.proceduralStars + renderer.state.landmarkStars + OBJECT_MEMBERS
                        + renderer.state.localProceduralStars + renderer.state.catalogResidentStars,
                spritePass.draws[0]);
        check('the star-sprite draw uses four vertices per star (triangle strip quad)',
                spritePass.draws[0].vertices === 4 && spritePass.draws[0].firstVertex === 0 && spritePass.draws[0].firstInstance === 0);
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
        check('open and globular clusters have no gas billboard',
                objectsLib.objectHasGas('open') === false && objectsLib.objectHasGas('globular') === false
                && objectsLib.objectHasGas('HII') && objectsLib.objectHasGas('planetary') && objectsLib.objectHasGas('SNR'));
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
        check('uniform is exactly 192 bytes (camera block + orbit dynamics + wave + engine)', gpu.uniformWrites[gpu.uniformWrites.length - 1].length === 192);
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
        // The engine lane rides at offset 44: (id, eccMax, 0, 0). Classic is
        // the default, so the id is 0 on every frame so far.
        const engine = [uniform[44], uniform[45], uniform[46], uniform[47]];
        check('uniform engine lane carries (0, eccMax, 0, 0) under the default classic engine',
                engine[0] === 0 && engine[1] === fr(window.OrbitLib.simpleEccMax(model))
                && engine[2] === 0 && engine[3] === 0,
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

        const game = renderer.regenerate(galaxy.createGalaxy({ type: 'E4', seed: 11 }));
        check('a generated type runs Game mode: no named stars, no streamed catalog, but objects',
                game.mode === 'game' && game.galaxyType === 'E4' && game.galaxySeed === 11
                && game.landmarkStars === 0 && game.catalogTotalStars === 0
                && game.catalogCells === 0 && game.localProceduralStars === 0
                && game.objectCount === OBJECT_COUNT && game.objectStars === OBJECT_MEMBERS,
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
        const passes = gpu.passes.slice(-3);
        check('both modes submit the same three passes, so the switch costs no pipeline',
                passes.length === 3 && passes[0].label === 'star-sprites'
                && passes[1].label === 'nebula-billboards' && passes[2].label === 'tonemap',
                passes.map(pass => pass.label));
}


// --- Galaxy age: the property-only regenerate -----------------------------
// 0.3.3 made the age a generation parameter, and the age slider regenerates
// live. Positions are age-independent, so a regenerate that only moves the
// population keeps the sampled field and rewrites the records: the same stars,
// at another epoch. What must still change is the sky, and what must not change
// is anything the viewer is looking at — the landmarks, the catalog, the buffer.
{
        const fixedWrites = () => gpu.bufferWrites.filter(w => w.buffer.label === 'star-storage' && w.offset === 0);
        const asView = (write) => new DataView(write.bytes.buffer, write.bytes.byteOffset, write.bytes.byteLength);
        const meanMag = (view, n) => {
                let sum = 0;
                for (let i = 0; i < n; i++) sum += records.readRecord(view, i * records.RECORD_BYTES).absMag;
                return sum / n;
        };
        const landmarkByte = PROCEDURAL * records.RECORD_BYTES;
        const refView = asView(fixedWrites().pop());
        const refSamples = renderer.state.fieldSamples;
        const refMean = meanMag(refView, 2000);
        const writesBefore = fixedWrites().length;
        check('the preset boots at the reference age, needing no exposure offset',
                renderer.state.galaxyAge === galaxy.AGE_REF && renderer.state.magOffset === 0
                && refSamples > 0,
                { age: renderer.state.galaxyAge, offset: renderer.state.magOffset, fieldSamples: refSamples });

        const aged = renderer.regenerate(galaxy.modelAtAge(model, 0.5));
        const agedView = asView(fixedWrites().pop());
        check('an age-only regenerate rewrites the fixed block without re-drawing the field',
                fixedWrites().length === writesBefore + 1 && aged.fieldSamples === refSamples
                && aged.proceduralStars === PROCEDURAL && aged.galaxyAge === 0.5,
                { newWrites: fixedWrites().length - writesBefore, fieldSamples: aged.fieldSamples, age: aged.galaxyAge });
        let samePosition = true;
        let movedStar = 0;
        for (let i = 0; i < 500; i++) {
                const a = records.readRecord(refView, i * records.RECORD_BYTES);
                const b = records.readRecord(agedView, i * records.RECORD_BYTES);
                if (a.x !== b.x || a.y !== b.y || a.z !== b.z) { samePosition = false; break; }
                if (a.packed !== b.packed) movedStar++;
        }
        check('the same stars stay where they were and change what they are',
                samePosition && movedStar > 400, { samePosition, movedStar });
        let landmarkKept = true;
        for (let i = 0; i < window.Landmarks.count; i++) {
                const a = records.readRecord(refView, landmarkByte + i * records.RECORD_BYTES);
                const b = records.readRecord(agedView, landmarkByte + i * records.RECORD_BYTES);
                if (a.packed !== b.packed || a.x !== b.x) { landmarkKept = false; break; }
        }
        check('the named stars keep their real magnitudes: they are data, not a what-if',
                landmarkKept && aged.landmarkStars === window.Landmarks.count
                && aged.catalogTotalStars === manifest.starCount && aged.bufferBytes === renderer.state.bufferBytes,
                { landmarks: aged.landmarkStars, catalog: aged.catalogTotalStars });
        // -0.84 mag here (was past -1): the young Milky Way is still the
        // dimmer field — its turnoff giants have not arrived yet — but the
        // gap shrank with the permanent-giant tail, from 11× to ~2.2× in
        // luminosity. The offset brightens it back either way.
        check('a young galaxy is a dimmer one, so the offset brightens it back',
                aged.magOffset < -0.5 && meanMag(agedView, 2000) < refMean - 0.5,
                { offset: +aged.magOffset.toFixed(3), meanMagYoung: +meanMag(agedView, 2000).toFixed(3), meanMagRef: +refMean.toFixed(3) });

        // The complementary direction: a new type is a new galaxy, so the field
        // is drawn again — the reuse is a property of the geometry, not a shortcut
        // taken whenever the model object changes.
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


// --- Object-block defaults ------------------------------------------------
// Omitted object options fall back to the ObjectsLib budgets: 400 whole-galaxy
// objects apportioned to exactly 20000 members.
{
        const defGpu = createMockGpu();
        const defRenderer = rendererModule.createStarRenderer(defGpu.device, defGpu.context, defGpu.format, {
                proceduralStars: 100,
                catalogBudgetStars: 0,
                model,
        });
        const defState = defRenderer.prepare(null);
        check('omitted object options default to 400 objects / 20000 members',
                defState.objectCount === objectsLib.OBJECT_COUNT_DEFAULT
                && defState.objectStars === objectsLib.OBJECT_MEMBERS_DEFAULT,
                { objects: defState.objectCount, members: defState.objectStars });
        const defBuffer = defGpu.buffers.find(b => b.label === 'star-storage');
        const defExpected = (100 + defState.landmarkStars + objectsLib.OBJECT_MEMBERS_DEFAULT
                + rendererModule.LOCAL_PROCEDURAL_DEFAULT) * records.RECORD_BYTES;
        check('the default objects block sizes the buffer',
                defBuffer.size === defExpected, { size: defBuffer.size, expected: defExpected });
        defRenderer.dispose();
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
        // The most recent star-sprites pass draw reflects the new residency.
        const lastSpriteDraw = gpu.passes.filter(p => p.label === 'star-sprites').pop().draws[0];
        check('the drawn instance count follows the new residency (global + landmarks + objects + local + catalog)',
                lastSpriteDraw.instances === renderer.state.drawn
                && renderer.state.drawn === renderer.state.proceduralStars + renderer.state.landmarkStars + OBJECT_MEMBERS
                        + renderer.state.localProceduralStars + renderer.state.catalogResidentStars,
                renderer.state.drawn);
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
        // Three more passes were appended (star-sprites + nebulae + tonemap).
        const newPasses = gpu.passes.slice(passesBefore);
        check('the frame still produces three passes (star + nebulae + tonemap)',
                newPasses.length === 3
                && newPasses[0].label === 'star-sprites'
                && newPasses[1].label === 'nebula-billboards'
                && newPasses[2].label === 'tonemap',
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
        check('the HDR path runs three passes (star-sprites + nebulae + tonemap), same as SDR',
                newPasses.length === 3
                && newPasses[0].label === 'star-sprites'
                && newPasses[1].label === 'nebula-billboards'
                && newPasses[2].label === 'tonemap',
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
        check('state.bufferBytes counts the star, nebula and theta buffers',
                engRenderer.state.bufferBytes === starBuf.size + nebBuf.size + thetaBuf.size,
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
        check('classic frames carry engine id 0 and dispatch no compute',
                classicUniform[44] === 0 && engGpu.computePasses.length === 0
                && engGpu.simpleUniformWrites.length === 0);

        check('setEngine(simple) switches the state and re-seeds the epoch',
                engRenderer.setEngine('simple') === 'simple'
                && engGpu.thetaWrites[engGpu.thetaWrites.length - 1].bytes.byteLength === totalSlots * 4,
                { engine: engRenderer.state.engine });
        engRenderer.render(camera, 320, 200, 11, input, 1);
        const simpleUniform = readUniform(engGpu.uniformWrites[engGpu.uniformWrites.length - 1]);
        const stepUniform = readUniform(engGpu.simpleUniformWrites[engGpu.simpleUniformWrites.length - 1]);
        const stepPass = engGpu.computePasses[engGpu.computePasses.length - 1];
        check('simple frames carry engine id 1 with the model eccMax beside it',
                simpleUniform[44] === 1
                && simpleUniform[45] === Math.fround(window.OrbitLib.simpleEccMax(engModel)),
                { id: simpleUniform[44], ecc: simpleUniform[45] });
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
        check('apocenter packs engine id, bounded eccentricity and the model bar angle',
                apoUniform[44] === 2 && apoUniform[45] === Math.fround(window.OrbitLib.APOCENTER_ECC_MAX)
                && Math.abs(apoUniform[46] - Math.fround(engModel.spheroid.tiltDeg * Math.PI / 180)) < 1e-7
                && engGpu.computePasses.length === passesBefore,
                { id: apoUniform[44], ecc: apoUniform[45], barTilt: apoUniform[46] });
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

// --- Report -------------------------------------------------------------
let passed = 0;
let failed = 0;
for (const c of checks) {
        if (c.pass) passed++; else failed++;
        console.log(`  ${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.pass ? '' : `  -> ${JSON.stringify(c.detail)}`}`);
}
console.log(`\n${passed}/${checks.length} passed, ${failed} failed`);

const logPath = path.join(__dirname, 'logs', 'renderer.json');
fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.writeFileSync(logPath, JSON.stringify({
        date: new Date().toISOString(),
        proceduralStars: prepareState.proceduralStars,
        catalogStars: prepareState.catalogTotalStars,
        prepareMs,
        totalChecks: checks.length,
        passed,
        failed,
        checks,
}, null, 2));
console.log(`Wrote ${logPath}`);
console.log('\n=== VERDICT ===');
console.log(failed === 0 ? 'PASS — renderer streams, packs and draws as documented' : `FAIL — ${failed} checks failed`);
process.exit(failed === 0 ? 0 : 1);
