// src/render/star-sprites.js
// Path B: additive point sprites for every star the frame needs — the streamed
// catalog cells plus the procedural field behind them.
//
// Buffer layout (one storage buffer, one draw call):
//
//   [0 .. proceduralCount)                          procedural field, once
//   [proceduralCount .. + landmarkCount)            named landmarks, once
//   [proceduralCount + landmarkCount .. + resident) resident catalog cells,
//                                                   rewritten when the camera
//                                                   crosses a cell
//
// Landmarks sit in their own fixed block because Gaia saturates on the
// brightest stars — the catalog subset cannot be assumed to contain them
// (see data/landmarks.js). The three blocks keep the drawn instance range
// contiguous: `draw(4, proceduralCount + landmarkCount + residentCatalog)`.
// No hidden slots, no per-cell GPU allocation, no compaction pass.
//
// Frame cost: one 112-byte uniform write, one catalog buffer write (only when
// the resident set changed), one render pass with no depth attachment — the
// sprites are additive, so there is nothing to depth-test against, and writing
// depth for them would only cost bandwidth.

'use strict';

const UNIFORM_FLOATS = 28;              // 112 bytes, see star-sprite WGSL
const TONEMAP_UNIFORM_FLOATS = 4;       // 16 bytes, see tonemap WGSL (exposure + pad)
const PROCEDURAL_STARS_DEFAULT = 300000;
const CATALOG_BUDGET_DEFAULT = 250000;
const BASE_SIZE_PX = 1.5;               // tighter than 2.2 — point sources at HD/4K
const MAX_SIZE_PX = 16.0;              // matches the new (0.4, 2.0) size clamp
const EXPOSURE_MIN = 0.0;
const EXPOSURE_MAX = 40.0;
const EXPOSURE_DEFAULT = 17.0;
const EXPOSURE_STEP = 0.75;
// ACES output brightness: linear multiplier on the HDR buffer before the curve.
// ; halves a stop (x0.707), ' doubles a stop (x1.414). Default 1.0 = the curve
// sees the same value the sprites wrote.
const LINEAR_EXPOSURE_DEFAULT = 1.0;
const LINEAR_EXPOSURE_MIN = 0.125;
const LINEAR_EXPOSURE_MAX = 8.0;
const LINEAR_EXPOSURE_STEP = 1.0;      // each keypress is ±1 half-stop (×√2 or ×1/√2)
const MAX_FRAME_DT = 0.1;
const HDR_FORMAT = 'rgba16float';      // blendable per WebGPU core spec on every adapter

// A cell manager must exist before a catalog is attached; this keeps the
// renderer constructible in "procedural only" runs and in Node tests.
const EMPTY_MANIFEST = {
        version: 1,
        source: 'none',
        cellCount: 0,
        starCount: 0,
        bandNames: [],
        bands: {},
        bandRadius: new Float32Array(0),
        bandOf: new Uint8Array(0),
        cellSize: new Float32Array(0),
        origin: new Float32Array(0),
        firstStar: new Uint32Array(1),
        payloads: [],
};

function createStarRenderer(device, context, format, options) {
        const opts = options || {};
        const records = window.StarRecord;
        const landmarks = window.Landmarks;
        if (!landmarks || !landmarks.count) {
                throw new Error('Landmarks data missing: index.html must load data/landmarks.js before render/star-sprites.js');
        }
        const landmarkCount = landmarks.count;
        const seed = opts.seed === undefined ? 42 : opts.seed;
        const proceduralTarget = Math.max(0, opts.proceduralStars === undefined ? PROCEDURAL_STARS_DEFAULT : opts.proceduralStars);
        const catalogBudget = Math.max(0, opts.catalogBudgetStars === undefined ? CATALOG_BUDGET_DEFAULT : opts.catalogBudgetStars);

        const maxStorageBytes = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);

        // --- Shader + pipeline ------------------------------------------------
        const shaderModule = device.createShaderModule({
                label: 'star-sprite',
                code: window.GalaxyShaders.SHADERS['star-sprite'],
        });
        let shaderError = null;
        shaderModule.getCompilationInfo().then((info) => {
                for (const message of info.messages) {
                        if (message.type !== 'error') continue;
                        shaderError = `${message.lineNum}:${message.linePos} ${message.message}`;
                        console.error('WGSL error in star-sprite:', shaderError);
                }
        }).catch(() => {});

        const uniformBuffer = device.createBuffer({
                label: 'star-camera-uniform',
                size: UNIFORM_FLOATS * 4,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        const uniformData = new ArrayBuffer(UNIFORM_FLOATS * 4);
        const uniform = new Float32Array(uniformData);

        const lutTexture = device.createTexture({
                label: 'star-color-lut',
                size: [256, 1],
                format: 'rgba8unorm',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        device.queue.writeTexture(
                { texture: lutTexture },
                records.buildColorLUT(),
                { bytesPerRow: 256 * 4, rowsPerImage: 1 },
                [256, 1],
        );

        const bindGroupLayout = device.createBindGroupLayout({
                label: 'star-sprite-layout',
                entries: [
                        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
                        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
                        { binding: 2, visibility: GPUShaderStage.VERTEX, texture: { sampleType: 'float' } },
                ],
        });
        const pipeline = device.createRenderPipeline({
                label: 'star-sprite-pipeline',
                layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
                vertex: { module: shaderModule, entryPoint: 'vs_main' },
                fragment: {
                        module: shaderModule,
                        entryPoint: 'fs_main',
                        targets: [{
                                format,
                                // Premultiplied additive: the fragment shader already returns
                                // colour * alpha, so the blender must not multiply again.
                                blend: {
                                        color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
                                        alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
                                },
                        }],
                },
                primitive: { topology: 'triangle-strip' },
        });

        // --- HDR pipeline -----------------------------------------------------
        // The star-sprite pass renders into an rgba16float intermediate; the
        // tonemap pass samples it, applies ACES, and writes the swapchain.
        // rgba16float is blendable per the WebGPU core spec, so no feature
        // negotiation is needed and the additive blend state stays (one, one).
        // The HDR texture is recreated on canvas resize.
        const tonemapModule = device.createShaderModule({
                label: 'tonemap',
                code: window.GalaxyShaders.SHADERS['tonemap'],
        });
        tonemapModule.getCompilationInfo().then((info) => {
                for (const message of info.messages) {
                        if (message.type !== 'error') continue;
                        console.error('WGSL error in tonemap:', `${message.lineNum}:${message.linePos} ${message.message}`);
                }
        }).catch(() => {});

        const tonemapUniformBuffer = device.createBuffer({
                label: 'tonemap-uniform',
                size: TONEMAP_UNIFORM_FLOATS * 4,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        const tonemapUniformData = new ArrayBuffer(TONEMAP_UNIFORM_FLOATS * 4);
        const tonemapUniform = new Float32Array(tonemapUniformData);
        tonemapUniform[0] = LINEAR_EXPOSURE_DEFAULT;

        const tonemapBindGroupLayout = device.createBindGroupLayout({
                label: 'tonemap-layout',
                entries: [
                        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
                        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
                ],
        });
        const tonemapPipeline = device.createRenderPipeline({
                label: 'tonemap-pipeline',
                layout: device.createPipelineLayout({ bindGroupLayouts: [tonemapBindGroupLayout] }),
                vertex: { module: tonemapModule, entryPoint: 'vs_main' },
                fragment: {
                        module: tonemapModule,
                        entryPoint: 'fs_main',
                        targets: [{ format, blend: undefined }],   // overwrite, no blend
                },
                primitive: { topology: 'triangle-list' },
        });

        let hdrTexture = null;
        let hdrView = null;
        let hdrWidth = 0;
        let hdrHeight = 0;
        let tonemapBindGroup = null;

        function ensureHdrTexture(width, height) {
                if (hdrTexture && hdrWidth === width && hdrHeight === height) return;
                if (hdrTexture) hdrTexture.destroy();
                hdrTexture = device.createTexture({
                        label: 'hdr-intermediate',
                        size: [width, height],
                        format: HDR_FORMAT,
                        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
                });
                hdrView = hdrTexture.createView();
                hdrWidth = width;
                hdrHeight = height;
                tonemapBindGroup = device.createBindGroup({
                        label: 'tonemap-bind-group',
                        layout: tonemapBindGroupLayout,
                        entries: [
                                { binding: 0, resource: { buffer: tonemapUniformBuffer } },
                                { binding: 1, resource: hdrView },
                        ],
                });
        }

        // --- Storage ----------------------------------------------------------
        let starBuffer = null;
        let bindGroup = null;
        let staging = null;            // ArrayBuffer: [procedural][landmarks][catalog]
        let landmarkByteOffset = 0;
        let catalogByteOffset = 0;
        let catalogCapacity = 0;
        let proceduralCount = 0;
        let catalogResident = 0;
        let lastTime = 0;
        // The manager always exists; with no catalog it just reports zero stars.
        let manager = window.CellManager.createCellManager(EMPTY_MANIFEST, {
                budgetStars: catalogBudget,
                bandRadius: opts.bandRadius,
        });

        // Everything the overlay and the tests read, mutated in place.
        const state = {
                proceduralStars: 0,
                landmarkStars: 0,
                catalogResidentStars: 0,
                catalogTotalStars: 0,
                catalogCells: 0,
                cellsResident: 0,
                decodedBytes: 0,
                drawn: 0,
                magZero: EXPOSURE_DEFAULT,
                linearExposure: LINEAR_EXPOSURE_DEFAULT,
                hdrPass: true,
                bufferBytes: 0,
                clampedProcedural: false,
                clampedCatalog: false,
        };

        // --- Exposure ---------------------------------------------------------
        // magZero is the apparent magnitude that maps to flux 1.0 in the vertex
        // shader (input dynamic range). linearExposure is the ACES pre-multiplier
        // (output brightness). Two knobs: [ / ] shifts magZero to widen the
        // visible magnitude range, ; / ' shifts linearExposure to brighten or
        // dim the tonemapped result without re-rendering the sprites.
        let magZero = opts.magZero === undefined ? EXPOSURE_DEFAULT : opts.magZero;
        let linearExposure = opts.linearExposure === undefined ? LINEAR_EXPOSURE_DEFAULT : opts.linearExposure;

        function setExposure(value) {
                magZero = Math.max(EXPOSURE_MIN, Math.min(EXPOSURE_MAX, value));
                state.magZero = magZero;
                return magZero;
        }

        function setLinearExposure(value) {
                linearExposure = Math.max(LINEAR_EXPOSURE_MIN, Math.min(LINEAR_EXPOSURE_MAX, value));
                state.linearExposure = linearExposure;
                return linearExposure;
        }

        // --- Build ------------------------------------------------------------
        function allocate(procedural, catalog) {
                if (starBuffer) starBuffer.destroy();
                proceduralCount = procedural;
                catalogCapacity = catalog;
                const totalBytes = (proceduralCount + landmarkCount + catalogCapacity) * records.RECORD_BYTES;
                if (totalBytes > maxStorageBytes) {
                        throw new Error(`Star buffer of ${(totalBytes / 1048576).toFixed(1)} MB exceeds the device limit of ${(maxStorageBytes / 1048576).toFixed(1)} MB`);
                }
                staging = new ArrayBuffer(Math.max(records.RECORD_BYTES, totalBytes));
                landmarkByteOffset = proceduralCount * records.RECORD_BYTES;
                catalogByteOffset = (proceduralCount + landmarkCount) * records.RECORD_BYTES;
                starBuffer = device.createBuffer({
                        label: 'star-storage',
                        size: Math.max(16, totalBytes),
                        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
                });
                bindGroup = device.createBindGroup({
                        label: 'star-sprite-bind-group',
                        layout: bindGroupLayout,
                        entries: [
                                { binding: 0, resource: { buffer: uniformBuffer } },
                                { binding: 1, resource: { buffer: starBuffer } },
                                { binding: 2, resource: lutTexture.createView() },
                        ],
                });
                state.bufferBytes = totalBytes;
        }

        function generateProcedural() {
                if (proceduralCount === 0) return 0;
                const sampling = window.SamplingLib;
                const starTypes = window.StarTypesLib;
                const stars = sampling.sampleGalaxyStars(seed, proceduralCount);
                const view = new DataView(staging, 0, proceduralCount * records.RECORD_BYTES);
                const derived = {};
                for (let i = 0; i < proceduralCount; i++) {
                        starTypes.deriveStar(seed * 31 + i + 1, stars.component[i], stars.R[i], stars.distToArm[i], derived);
                        records.writeRecord(
                                view, i * records.RECORD_BYTES,
                                stars.x[i], stars.y[i], stars.z[i],
                                derived.colorIndex, derived.absMag,
                                records.FLAG_VISIBLE, Math.imul(i, 2654435761) & 0xFF,
                        );
                }
                state.proceduralStars = proceduralCount;
                return proceduralCount;
        }

        // The named stars, flagged so later cull passes never thin them away.
        // Positions are the load-time bake in data/landmarks.js.
        function writeLandmarks() {
                const view = new DataView(staging, landmarkByteOffset, landmarkCount * records.RECORD_BYTES);
                for (let i = 0; i < landmarkCount; i++) {
                        const e = landmarks.ENTRIES[i];
                        records.writeRecord(
                                view, i * records.RECORD_BYTES,
                                e.x, e.y, e.z,
                                e.colorIndex, e.absMag,
                                records.FLAG_VISIBLE | records.FLAG_LANDMARK, 0,
                        );
                }
                state.landmarkStars = landmarkCount;
                return landmarkCount;
        }

        function attachCatalog(manifest) {
                state.catalogTotalStars = manifest.starCount;
                state.catalogCells = manifest.cellCount;
                const capacity = Math.min(manifest.starCount, catalogBudget);
                state.clampedCatalog = capacity < manifest.starCount;
                catalogCapacity = capacity;
                manager = window.CellManager.createCellManager(manifest, {
                        budgetStars: catalogBudget,
                        bandRadius: opts.bandRadius,
                });
                return capacity;
        }

        // One-shot setup: allocate, generate, upload, expose. Procedural field and
        // landmarks are both fixed for the life of the renderer, so they share one
        // upload.
        function prepare(manifest) {
                const catalog = manifest ? attachCatalog(manifest) : 0;
                let procedural = proceduralTarget;
                const maxRecords = Math.floor(maxStorageBytes / records.RECORD_BYTES);
                if (procedural + landmarkCount + catalog > maxRecords) {
                        procedural = Math.max(0, maxRecords - landmarkCount - catalog);
                        state.clampedProcedural = true;
                }
                allocate(procedural, catalog);
                generateProcedural();
                writeLandmarks();
                const fixedBytes = (proceduralCount + landmarkCount) * records.RECORD_BYTES;
                if (fixedBytes > 0) device.queue.writeBuffer(starBuffer, 0, staging, 0, fixedBytes);
                return state;
        }

        // Rewrite the catalog region of the staging buffer and upload it. Only
        // called when the resident set changed (a cell boundary crossing).
        function uploadCatalog() {
                const bytes = manager.writeInto(new Uint8Array(staging, catalogByteOffset), 0);
                catalogResident = bytes / records.RECORD_BYTES;
                if (catalogResident > 0) {
                        device.queue.writeBuffer(starBuffer, catalogByteOffset, staging, catalogByteOffset, bytes);
                }
                const stats = manager.stats();
                state.cellsResident = stats.cellsResident;
                state.decodedBytes = stats.decodedBytes;
                state.catalogResidentStars = catalogResident;
                return catalogResident;
        }

        // --- Frame ------------------------------------------------------------
        function render(camera, width, height, time, input) {
                if (!starBuffer || width === 0 || height === 0) return;
                const dt = Math.min(MAX_FRAME_DT, Math.max(0, time - lastTime));
                lastTime = time;

                if (input && input.actions) {
                        if (input.actions.exposure) {
                                setExposure(magZero + input.actions.exposure * EXPOSURE_STEP);
                                input.actions.exposure = 0;
                        }
                        // ; / ' adjust the ACES pre-multiplier in half-stop steps.
                        // 1 step = 0.5 stop, accumulated across key repeats.
                        if (input.actions.linearExposure) {
                                const factor = Math.pow(Math.SQRT2, input.actions.linearExposure * LINEAR_EXPOSURE_STEP);
                                setLinearExposure(linearExposure * factor);
                                input.actions.linearExposure = 0;
                        }
                }

                if (state.catalogTotalStars > 0) {
                        const update = manager.update(camera.cameraPos[0], camera.cameraPos[1], camera.cameraPos[2], dt);
                        if (update.changed) uploadCatalog();
                }

                const viewProj = camera.buildViewProj(width / height);
                uniform.set(viewProj, 0);
                uniform[16] = camera.cameraPos[0];
                uniform[17] = camera.cameraPos[1];
                uniform[18] = camera.cameraPos[2];
                uniform[19] = 0;
                uniform[20] = width;
                uniform[21] = height;
                uniform[22] = 2 / width;
                uniform[23] = 2 / height;
                uniform[24] = magZero;
                uniform[25] = BASE_SIZE_PX;
                uniform[26] = MAX_SIZE_PX;
                uniform[27] = time;
                device.queue.writeBuffer(uniformBuffer, 0, uniformData);

                tonemapUniform[0] = linearExposure;
                device.queue.writeBuffer(tonemapUniformBuffer, 0, tonemapUniformData);

                ensureHdrTexture(width, height);

                // The pass runs even when nothing is drawn: an empty frame still
                // has to clear the canvas, and draw(.., 0) is free.
                const instances = state.proceduralStars + landmarkCount + catalogResident;
                state.drawn = instances;

                const encoder = device.createCommandEncoder({ label: 'star-frame' });
                // Pass 1: additive sprites into the rgba16float HDR intermediate.
                // Linear flux sums without per-star saturation; ACES rolls off
                // the sum once in pass 2.
                const starPass = encoder.beginRenderPass({
                        label: 'star-sprites',
                        colorAttachments: [{
                                view: hdrView,
                                clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 0.0 },
                                loadOp: 'clear',
                                storeOp: 'store',
                        }],
                });
                starPass.setPipeline(pipeline);
                starPass.setBindGroup(0, bindGroup);
                starPass.draw(4, instances, 0, 0);
                starPass.end();
                // Pass 2: fullscreen ACES tone-map into the swapchain. No blend,
                // alpha = 1.0 (swapchain is opaque).
                const tonemapPass = encoder.beginRenderPass({
                        label: 'tonemap',
                        colorAttachments: [{
                                view: context.getCurrentTexture().createView(),
                                clearValue: { r: 0.008, g: 0.010, b: 0.020, a: 1.0 },
                                loadOp: 'clear',
                                storeOp: 'store',
                        }],
                });
                tonemapPass.setPipeline(tonemapPipeline);
                tonemapPass.setBindGroup(0, tonemapBindGroup);
                tonemapPass.draw(3, 1, 0, 0);
                tonemapPass.end();
                device.queue.submit([encoder.finish()]);
        }

        function dispose() {
                if (starBuffer) starBuffer.destroy();
                if (hdrTexture) hdrTexture.destroy();
                uniformBuffer.destroy();
                tonemapUniformBuffer.destroy();
                lutTexture.destroy();
        }

        return {
                prepare,
                render,
                setExposure,
                setLinearExposure,
                dispose,
                state,
                stats: () => state,
                shaderError: () => shaderError,
        };
}

const StarRenderer = {
        createStarRenderer, EMPTY_MANIFEST, UNIFORM_FLOATS, TONEMAP_UNIFORM_FLOATS,
        PROCEDURAL_STARS_DEFAULT, CATALOG_BUDGET_DEFAULT,
        BASE_SIZE_PX, MAX_SIZE_PX, EXPOSURE_DEFAULT, EXPOSURE_STEP,
        LINEAR_EXPOSURE_DEFAULT, LINEAR_EXPOSURE_MIN, LINEAR_EXPOSURE_MAX,
        LINEAR_EXPOSURE_STEP, HDR_FORMAT,
};
if (typeof module !== 'undefined') module.exports = StarRenderer;
if (typeof window !== 'undefined') window.StarRenderer = StarRenderer;
