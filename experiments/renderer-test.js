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
                bufferWrites: [],
                draws: [],
                passes: [],
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
const START = Date.now();
const renderer = rendererModule.createStarRenderer(gpu.device, gpu.context, gpu.format, {
        proceduralStars: PROCEDURAL,
        catalogBudgetStars: CATALOG_BUDGET,
        seed: 7,
});
const prepareState = renderer.prepare(manifest);
const prepareMs = Date.now() - START;
console.log(`Prepared in ${prepareMs} ms: ${prepareState.proceduralStars} procedural, `
        + `${prepareState.catalogTotalStars} catalog stars in ${prepareState.catalogCells} cells`);

// --- Shader + pipeline wiring -------------------------------------------
{
        check('three wired shader sources are handed to createShaderModule',
                gpu.shaderModules.length === 3
                && gpu.shaderModules[0].code === window.GalaxyShaders.SHADERS['star-sprite']
                && gpu.shaderModules[1].code === window.GalaxyShaders.SHADERS['star-sprite-hdr']
                && gpu.shaderModules[2].code === window.GalaxyShaders.SHADERS['tonemap'],
                { modules: gpu.shaderModules.map(s => s.label) });
        check('all wired shaders declare their entry points',
                gpu.shaderModules.every(s => /@vertex\s+fn\s+vs_main/.test(s.code) && /@fragment\s+fn\s+fs_main/.test(s.code)));
        const spritePipeline = gpu.pipelines.find(p => p.label === 'star-sprite-pipeline');
        const hdrPipeline = gpu.pipelines.find(p => p.label === 'star-sprite-hdr-pipeline');
        const tonemapPipeline = gpu.pipelines.find(p => p.label === 'tonemap-pipeline');
        check('three pipelines are created (sprite + sprite-hdr + tonemap)',
                !!spritePipeline && !!hdrPipeline && !!tonemapPipeline,
                gpu.pipelines.map(p => p.label));
        check('the star-sprite pipeline is additive with no depth attachment',
                spritePipeline.fragment.targets[0].blend.color.srcFactor === 'one'
                && spritePipeline.fragment.targets[0].blend.color.dstFactor === 'one'
                && spritePipeline.depthStencil === undefined,
                spritePipeline.fragment.targets[0].blend);
        check('the star-sprite-hdr pipeline is additive with the same blend as the SDR variant',
                hdrPipeline.fragment.targets[0].blend.color.srcFactor === 'one'
                && hdrPipeline.fragment.targets[0].blend.color.dstFactor === 'one',
                hdrPipeline.fragment.targets[0].blend);
        check('the tonemap pipeline has no blend state (overwrite)',
                tonemapPipeline.fragment.targets[0].blend === undefined
                && tonemapPipeline.fragment.targets[0].format === 'bgra8unorm',
                tonemapPipeline.fragment.targets[0]);
        check('the star-sprite pipeline uses triangle-strip, tonemap uses triangle-list',
                spritePipeline.primitive.topology === 'triangle-strip'
                && tonemapPipeline.primitive.topology === 'triangle-list',
                { sprite: spritePipeline.primitive.topology, tonemap: tonemapPipeline.primitive.topology });
        check('the pipelines target the swapchain format',
                spritePipeline.fragment.targets[0].format === 'bgra8unorm'
                && tonemapPipeline.fragment.targets[0].format === 'bgra8unorm');
}

// --- Buffer sizing and the procedural upload ----------------------------
const catalogs = gpu.buffers.filter(b => b.label === 'star-storage');
{
        const buffer = catalogs[0];
        const expectedRecords = prepareState.proceduralStars + prepareState.landmarkStars + Math.min(manifest.starCount, CATALOG_BUDGET);
        check('the storage buffer holds procedural + landmarks + catalog capacity',
                buffer.size === Math.max(16, expectedRecords * records.RECORD_BYTES),
                { size: buffer.size, expected: expectedRecords * records.RECORD_BYTES });
        check('the fixed blocks (procedural + landmarks) were uploaded once, at offset 0',
                gpu.bufferWrites.length === 1 && gpu.bufferWrites[0].offset === 0
                && gpu.bufferWrites[0].bytes.length === (prepareState.proceduralStars + prepareState.landmarkStars) * records.RECORD_BYTES,
                { writes: gpu.bufferWrites.length });
}

// --- The landmark block is the named-star table --------------------------
{
        const L = require('../src/data/landmarks.js');
        check('the renderer reports the landmark block from the data module',
                prepareState.landmarkStars === L.count && L.count >= 30 && L.count <= 60,
                { landmarkStars: prepareState.landmarkStars, table: L.count });
        const bytes = gpu.bufferWrites[0].bytes;
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

// --- The procedural records are real stars ------------------------------
{
        const bytes = gpu.bufferWrites[0].bytes;
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
        const catalogWrites = gpu.bufferWrites.filter(w => w.offset > 0);
        check('the first frame streams the catalog once',
                catalogWrites.length === 1 && catalogWrites[0].offset === (prepareState.proceduralStars + prepareState.landmarkStars) * records.RECORD_BYTES,
                { writes: catalogWrites.length, offset: catalogWrites[0] && catalogWrites[0].offset });

        // Two passes per frame: star-sprite (4 vertices × N instances) and
        // tonemap (3 vertices fullscreen triangle).
        const spritePass = gpu.passes.find(p => p.label === 'star-sprites');
        const tonemapPass = gpu.passes.find(p => p.label === 'tonemap');
        check('two render passes are submitted per frame',
                spritePass && tonemapPass && spritePass !== tonemapPass,
                gpu.passes.map(p => p.label));
        check('the star-sprite pass draws exactly the resident stars',
                spritePass.draws.length === 1 && spritePass.draws[0].instances === renderer.state.drawn
                && renderer.state.drawn === prepareState.proceduralStars + renderer.state.landmarkStars + renderer.state.catalogResidentStars,
                spritePass.draws[0]);
        check('the star-sprite draw uses four vertices per star (triangle strip quad)',
                spritePass.draws[0].vertices === 4 && spritePass.draws[0].firstVertex === 0 && spritePass.draws[0].firstInstance === 0);
        check('the tonemap pass draws one fullscreen triangle (3 vertices, 1 instance)',
                tonemapPass.draws.length === 1 && tonemapPass.draws[0].vertices === 3
                && tonemapPass.draws[0].instances === 1,
                tonemapPass.draws[0]);
        check('the resident catalog fits the budget', renderer.state.catalogResidentStars <= CATALOG_BUDGET,
                renderer.state.catalogResidentStars);
        check('all cells of this small catalog are resident', renderer.state.cellsResident === manifest.cellCount,
                { resident: renderer.state.cellsResident, total: manifest.cellCount });

        // The uploaded catalog bytes must be the resident cells, in order.
        const uploaded = catalogWrites[0].bytes;
        const expected = new Uint8Array(renderer.state.catalogResidentStars * records.RECORD_BYTES);
        const manager = cellManagerFrom(manifest, CATALOG_BUDGET);
        manager.update(camera.cameraPos[0], camera.cameraPos[1], camera.cameraPos[2], 1);
        manager.writeInto(expected, 0);
        check('staged catalog bytes equal an independent decode of the same cells',
                uploaded.length === expected.length && uploaded.every((b, i) => b === expected[i]),
                { uploaded: uploaded.length, expected: expected.length });
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
        check('uniform carries the frame time', uniform[27] === Math.fround(1 / 60), uniform[27]);
        check('uniform is exactly 112 bytes', gpu.uniformWrites[gpu.uniformWrites.length - 1].length === 112);

        // The tonemap uniform carries the linear exposure and is uploaded every
        // frame alongside the camera uniform.
        const tmu = readUniform(gpu.tonemapUniformWrites[gpu.tonemapUniformWrites.length - 1]);
        check('tonemap uniform carries the default linear exposure (1.0)',
                tmu[0] === Math.fround(rendererModule.LINEAR_EXPOSURE_DEFAULT), tmu[0]);
        check('tonemap uniform is 16 bytes (vec4 pad)', gpu.tonemapUniformWrites[0].length === 16, gpu.tonemapUniformWrites[0].length);
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
        check('crossing a cell boundary re-uploads the catalog',
                gpu.bufferWrites.length > writesBefore, { before: writesBefore, after: gpu.bufferWrites.length });
        // The most recent star-sprites pass draw reflects the new residency.
        const lastSpriteDraw = gpu.passes.filter(p => p.label === 'star-sprites').pop().draws[0];
        check('the drawn instance count follows the new residency',
                lastSpriteDraw.instances === renderer.state.drawn
                && renderer.state.drawn === renderer.state.proceduralStars + renderer.state.landmarkStars + renderer.state.catalogResidentStars,
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
        // Two more passes were appended (star-sprites + tonemap) for this frame.
        const newPasses = gpu.passes.slice(passesBefore);
        check('the frame still produces two passes (star + tonemap)',
                newPasses.length === 2
                && newPasses[0].label === 'star-sprites' && newPasses[1].label === 'tonemap',
                newPasses.map(p => p.label));
        // The star pass still drew procedural + landmark stars even with no catalog.
        check('the star pass draws the procedural field + landmarks',
                newPasses[0].draws[0].instances === renderer.state.proceduralStars + renderer.state.landmarkStars,
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

// --- HDR direct path (canvas is rgba16float + extended) -----------------
// A second renderer instance with `hdr:true` exercises the path where the
// swapchain itself is HDR: sprites write linear flux * linearExposure straight
// to the canvas, no intermediate texture, no tonemap pass.
{
        const hdrGpu = createMockGpu();
        // Make the swapchain look like an HDR surface by tagging the texture
        // view with a different label so the test can identify it.
        const hdrRenderer = rendererModule.createStarRenderer(hdrGpu.device, hdrGpu.context, hdrGpu.format, {
                proceduralStars: 2000,
                catalogBudgetStars: 0,
                seed: 7,
                hdr: true,
        });
        hdrRenderer.prepare(null);
        check('hdrDirect flag is reflected in renderer state',
                hdrRenderer.state.hdrDirect === true, hdrRenderer.state.hdrDirect);

        const hdrInput = { keys: {}, actions: { reset: 0, exposure: 0, linearExposure: 0 }, lookDx: 0, lookDy: 0, wheelDelta: 0 };
        const passesBefore = hdrGpu.passes.length;
        hdrRenderer.render(camera, WIDTH, HEIGHT, 7 / 60, hdrInput);

        // HDR path produces exactly ONE pass per frame (sprites direct to
        // swapchain). No 'tonemap' pass and no 'hdr-intermediate' texture.
        const newPasses = hdrGpu.passes.slice(passesBefore);
        check('the HDR direct path produces exactly one render pass per frame',
                newPasses.length === 1 && newPasses[0].label === 'star-sprites-hdr',
                newPasses.map(p => p.label));
        check('the HDR direct path does not create a tonemap pass',
                !newPasses.some(p => p.label === 'tonemap'),
                newPasses.map(p => p.label));
        check('the HDR direct path does not create an rgba16float intermediate texture',
                !hdrGpu.textures.some(t => t.label === 'hdr-intermediate'),
                hdrGpu.textures.map(t => t.label));

        // The single draw still draws the resident stars as 4-vertex quads.
        const hdrDraw = newPasses[0].draws[0];
        check('the HDR direct draw covers the procedural + landmark stars',
                hdrDraw.vertices === 4
                && hdrDraw.instances === hdrRenderer.state.proceduralStars + hdrRenderer.state.landmarkStars,
                hdrDraw);

        // The `;` / `'` exposure knob still works on the HDR path: it
        // multiplies fragment output via the bound uniform, no ACES step.
        hdrInput.actions.linearExposure = 1;
        hdrRenderer.render(camera, WIDTH, HEIGHT, 7.1 / 60, hdrInput);
        const tmu = readUniform(hdrGpu.tonemapUniformWrites[hdrGpu.tonemapUniformWrites.length - 1]);
        check('; raises linearExposure by one half-stop on the HDR direct path',
                Math.abs(tmu[0] - rendererModule.LINEAR_EXPOSURE_DEFAULT * Math.SQRT2) < 1e-5, tmu[0]);

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
