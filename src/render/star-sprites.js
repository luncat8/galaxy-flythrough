// src/render/star-sprites.js
// Path B: additive point sprites for every star the frame needs — the streamed
// catalog cells (thinned for density parity) plus a local procedural gap-fill
// plus the global galaxy-wide procedural field.
//
// The renderer is galaxy-agnostic: it draws whatever the GalaxyModel it was
// given produced, and `regenerate(model)` rebuilds the field for another one.
// Only the Milky Way preset has a catalog and named landmarks, so a non-preset
// model runs the same pipeline with those two blocks empty (Game mode) — the
// buffer layout and the draw call do not change, which is the point of keeping
// one pipeline for both modes.
//
// Buffer layout (one storage buffer, one draw call):
//
//   [0 .. globalProcedural)                 global procedural field, generated once
//   [globalProcedural .. +landmarkCount)    named landmarks, written once
//   [+landmarkCount .. +objectCapacity)     composite-object members, written once
//   [+objectCapacity .. +localCapacity)      local procedural gap-fill, rewritten
//                                           per cell-manager rebuild
//   [+localBase .. +localBase+catalogCap)   thinned catalog cells, rewritten per
//                                           rebuild
//
// Landmarks sit in their own fixed block because Gaia saturates on the
// brightest stars — the catalog subset cannot be assumed to contain them
// (see data/landmarks.js). The five blocks keep the drawn instance range
// contiguous: `draw(4, global + landmarks + objects + local + thinnedCatalog)`.
// No hidden slots, no per-cell GPU allocation, no compaction pass.
//
// Frame cost: one 112-byte uniform write, one catalog buffer write (only when
// the resident set changed), two additive passes into the HDR intermediate
// (stars, then nebula billboards) and one tonemap pass. No depth attachment —
// the sprites are additive, so there is nothing to depth-test against.

'use strict';

const UNIFORM_FLOATS = 28;              // 112 bytes, see star-sprite WGSL
// Tonemap uniform: x=exposure, y=whitePoint, z=saturation, w=outputMode (0=SDR, 1=HDR).
const TONEMAP_UNIFORM_FLOATS = 4;
const PROCEDURAL_STARS_DEFAULT = 300000;
const CATALOG_BUDGET_DEFAULT = 250000;
const LOCAL_PROCEDURAL_DEFAULT = 20000; // gap-fill for density parity near the camera
const BASE_SIZE_PX = 1.3;               // point sources
const MAX_SIZE_PX = 14.0;
const MIN_SIZE_PX = 0.8;                // never render a star smaller than this (prevents blink/pop)
const MIN_ALPHA = 0.25;                 // faintest stars still render as a dim pixel, not zero
const EXPOSURE_MIN = 0.0;
const EXPOSURE_MAX = 40.0;
// Default mag-lim lowered from 17 to 12: at mag=17 the IMF floods the field
// with 87% faint M-dwarfs (red), washing O/B stars out of the visual mix.
// 12 gives a better default sky — bright blue/white/yellow stars are clearly
// visible, M-dwarfs are still there but not dominating. Users can push [ to
// go deeper.
const EXPOSURE_DEFAULT = 12.0;
const EXPOSURE_STEP = 0.75;
// Brightness = linear pre-multiplier before the filmic curve. ; / ' in
// half-stop steps, slider is linear 0.125× → 8×.
const LINEAR_EXPOSURE_DEFAULT = 1.0;
const LINEAR_EXPOSURE_MIN = 0.125;
const LINEAR_EXPOSURE_MAX = 8.0;
const LINEAR_EXPOSURE_STEP = 1.0;      // ±1 half-stop per keypress
// White point (scene luminance → display white). 1.0 = hard clip, 16 = lots
// of headroom, colours stay saturated in clusters. Default 4.0 is an
// aggressive but natural filmic default that shows the slider's effect
// without clipping everything to white.
const WHITE_POINT_DEFAULT = 4.0;
const WHITE_POINT_MIN = 1.0;
const WHITE_POINT_MAX = 16.0;
// Saturation. The palette is authored with relatively muted colours
// (blackbody chromaticities) so 1.0 looks natural; push to 2.0 for
// Stellarium-like vivid blue/yellow/red, 3.0 maximum.
const SATURATION_DEFAULT = 1.4;
const SATURATION_MIN = 0.5;
const SATURATION_MAX = 3.0;
// Exposure renormalisation (0.3.3): the galaxy's age changes the population mix
// and with it the field's mean brightness (11× between 0.5 and 13.5 Gyr), so the
// renderer measures that mix over the first CALIBRATION_STARS sampled positions
// and folds the difference against the same field at galaxy.AGE_REF into the
// packed magnitudes. The sliders then keep meaning what the user set them to, at
// every age. 16k stars is enough to pin a mean dominated by rare giants to well
// under the 0.118 mag the record quantises to, and costs ~10 ms per calibration.
const CALIBRATION_STARS = 16384;
const MAX_FRAME_DT = 0.1;
// HDR intermediate format — always used; on HDR displays the tonemap outputs
// to an rgba16float swapchain too (same format).
const HDR_INTERMEDIATE_FORMAT = 'rgba16float';

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
        // One model for the whole renderer: the seed that hashes the field and
        // the frame the field describes are the same object, so they cannot
        // disagree. `regenerate` swaps it; `seed` follows.
        let model = opts.model || window.GalaxyLib.MILKY_WAY;
        let seed = model.seed | 0;
        const landmarkTable = landmarks.count;
        let lastManifest = null;
        const proceduralTarget = Math.max(0, opts.proceduralStars === undefined ? PROCEDURAL_STARS_DEFAULT : opts.proceduralStars);
        const catalogBudgetRequested = Math.max(0, opts.catalogBudgetStars === undefined ? CATALOG_BUDGET_DEFAULT : opts.catalogBudgetStars);
        // Landmarks and the Gaia subset are Milky Way data: for any other type
        // both blocks are empty, which is what "Game mode" means here — the same
        // pipeline with two blocks switched off, not a second renderer.
        let landmarkCount = 0;
        let catalogBudget = 0;

        function configureMode(nextModel) {
                model = nextModel;
                seed = nextModel.seed | 0;
                landmarkCount = nextModel.milkyWay ? landmarkTable : 0;
                catalogBudget = nextModel.milkyWay ? catalogBudgetRequested : 0;
                state.mode = nextModel.milkyWay ? 'hybrid' : 'game';
                state.galaxyType = nextModel.type;
                state.galaxySeed = nextModel.seed;
                state.galaxyLabel = window.GalaxyLib.galaxyLabel(nextModel);
        }
        const localProceduralBudget = Math.max(0, opts.localProceduralStars === undefined ? LOCAL_PROCEDURAL_DEFAULT : opts.localProceduralStars);
        // Composite objects (0.3.2a): clusters and associations, written once per
        // regenerate like the global field. The members block is fixed capacity;
        // unwritten slots are zero records, which the shader culls.
        const objectsLib = window.ObjectsLib;
        const objectCapacity = Math.max(0, opts.objectMembers === undefined ? objectsLib.OBJECT_MEMBERS_DEFAULT : opts.objectMembers);
        const objectCount = Math.max(0, opts.objectCount === undefined ? objectsLib.OBJECT_COUNT_DEFAULT : opts.objectCount);
        const billboardBytes = objectsLib.BILLBOARD_RECORD_BYTES;

        // Output mode: SDR (bgra8unorm / rgba8unorm) clamps tonemap to [0,1];
        // HDR (rgba16float + toneMapping:'extended') allows >1 so highlights
        // reach the monitor's nit headroom. Both paths use the same additive
        // rgba16float intermediate + tonemap pass — there is no "direct"
        // sprite-to-swapchain path anymore, because skipping tonemap broke
        // the white-point / saturation controls entirely on HDR displays.
        const hdrOutput = opts.hdr === true;
        const outputMode = hdrOutput ? 1.0 : 0.0;

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
                // rgba8unorm-srgb: CLASS_COLORS are authored as sRGB bytes
                // (the palette came from an sRGB reference); with the -srgb
                // suffix the sampler linearises them on the way in so the
                // additive sum in the HDR intermediate happens in linear
                // light. Without this, M-type reds come out pink/salmon and
                // blue stars look washed out because green/blue channels are
                // read at gamma-compressed brightness.
                format: 'rgba8unorm-srgb',
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

        // --- Tonemap pipeline ------------------------------------------------
        // The tonemap ALWAYS runs. It reads the rgba16float additive
        // intermediate, applies a Hable/Unreal filmic curve (luminance-only
        // so hue is preserved), a saturation boost, and a filmic highlight
        // desaturation that makes the brightest stars fade to white softly,
        // then writes the swapchain. params.w selects SDR (clamp to [0,1])
        // or HDR (allow values up to 8.0 for the extended-tone-mapping
        // canvas).
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
        tonemapUniform[1] = WHITE_POINT_DEFAULT;
        tonemapUniform[2] = SATURATION_DEFAULT;
        tonemapUniform[3] = outputMode;

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

        // --- Nebula billboard pipeline (0.3.2b) ------------------------------
        // Additive, after the sprites, into the same rgba16float intermediate.
        // Shares the camera uniform; its own storage holds one NebulaPacked
        // per gas object. Screen-size and distance cull live in the vertex
        // shader so the CPU does not compact per frame.
        const nebulaModule = device.createShaderModule({
                label: 'nebula-billboard',
                code: window.GalaxyShaders.SHADERS['nebula-billboard'],
        });
        nebulaModule.getCompilationInfo().then((info) => {
                for (const message of info.messages) {
                        if (message.type !== 'error') continue;
                        console.error('WGSL error in nebula-billboard:', `${message.lineNum}:${message.linePos} ${message.message}`);
                }
        }).catch(() => {});

        const nebulaBindGroupLayout = device.createBindGroupLayout({
                label: 'nebula-billboard-layout',
                entries: [
                        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
                        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
                ],
        });
        const nebulaPipeline = device.createRenderPipeline({
                label: 'nebula-billboard-pipeline',
                layout: device.createPipelineLayout({ bindGroupLayouts: [nebulaBindGroupLayout] }),
                vertex: { module: nebulaModule, entryPoint: 'vs_main' },
                fragment: {
                        module: nebulaModule,
                        entryPoint: 'fs_main',
                        targets: [{
                                format,
                                blend: {
                                        color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
                                        alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
                                },
                        }],
                },
                primitive: { topology: 'triangle-strip' },
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
                        format: HDR_INTERMEDIATE_FORMAT,
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
        let staging = null;            // ArrayBuffer: [procedural][landmarks][objects][local][catalog]
        let landmarkByteOffset = 0;
        let objectByteOffset = 0;
        let catalogByteOffset = 0;
        let catalogCapacity = 0;
        let proceduralCount = 0;
        let catalogResident = 0;
        let lastTime = 0;
        let nebulaBuffer = null;
        let nebulaBindGroup = null;
        let nebulaStaging = null;
        let nebulaCount = 0;
        // The sampled field, kept between regenerates: an age change re-rolls
        // what the stars are, not where they are, so the positions survive it and
        // only the records are rewritten (see regenerate).
        let fieldStars = null;
        // Mean luminosity (L☉) of the first CALIBRATION_STARS sampled stars at
        // galaxy.AGE_REF — the denominator of the exposure offset. A property of
        // the geometry, so it is recomputed with the field and not with the age.
        let referenceLuminosity = 0;
        let magOffset = 0;
        // The manager always exists; with no catalog it just reports zero stars.
        let manager = window.CellManager.createCellManager(EMPTY_MANIFEST, {
                budgetStars: catalogBudget,
                bandRadius: opts.bandRadius,
                model,
        });

        // Everything the overlay and the tests read, mutated in place.
        const state = {
                proceduralStars: 0,
                landmarkStars: 0,
                objectStars: 0,
                objectCount: 0,
                nebulaBillboards: 0,
                localProceduralStars: 0,
                catalogResidentStars: 0,
                catalogThinnedStars: 0,
                catalogTotalStars: 0,
                catalogCells: 0,
                cellsResident: 0,
                decodedBytes: 0,
                drawn: 0,
                magZero: EXPOSURE_DEFAULT,
                linearExposure: LINEAR_EXPOSURE_DEFAULT,
                whitePoint: WHITE_POINT_DEFAULT,
                saturation: SATURATION_DEFAULT,
                hdrOutput,
                bufferBytes: 0,
                clampedProcedural: false,
                clampedCatalog: false,
                mode: 'hybrid',
                galaxyType: model.type,
                galaxySeed: model.seed,
                galaxyLabel: '',
                // 0.3.3: the epoch the field was generated at, the magnitude
                // offset that keeps the exposure defaults meaningful there, and
                // how many times the positions have been drawn — which is what
                // makes the property-only regenerate observable instead of
                // implied.
                galaxyAge: model.populations.age,
                magOffset: 0,
                fieldSamples: 0,
        };
        configureMode(model);

        // --- Exposure ---------------------------------------------------------
        // magZero is the apparent magnitude that maps to flux 1.0 in the vertex
        // shader (input dynamic range). linearExposure is the ACES pre-multiplier
        // (output brightness). whitePoint is the scene luminance that maps to
        // display white — higher = more highlight headroom, less clipping.
        // Three knobs: [ / ] shifts magZero, ; / ' shifts linearExposure, the
        // settings menu slider shifts all three.
        let magZero = opts.magZero === undefined ? EXPOSURE_DEFAULT : opts.magZero;
        let linearExposure = opts.linearExposure === undefined ? LINEAR_EXPOSURE_DEFAULT : opts.linearExposure;
        let whitePoint = opts.whitePoint === undefined ? WHITE_POINT_DEFAULT : opts.whitePoint;
        let saturation = opts.saturation === undefined ? SATURATION_DEFAULT : opts.saturation;

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

        function setWhitePoint(value) {
                whitePoint = Math.max(WHITE_POINT_MIN, Math.min(WHITE_POINT_MAX, value));
                state.whitePoint = whitePoint;
                return whitePoint;
        }

        function setSaturation(value) {
                saturation = Math.max(SATURATION_MIN, Math.min(SATURATION_MAX, value));
                state.saturation = saturation;
                return saturation;
        }

        // Local procedural gap-fill count (set each rebuild, capped at budget).
        let localProceduralCount = 0;
        let localProceduralCapacity = localProceduralBudget;
        let localProceduralByteOffset = 0;

        // --- Build ------------------------------------------------------------
        function allocate(procedural, catalog) {
                if (starBuffer) starBuffer.destroy();
                proceduralCount = procedural;
                catalogCapacity = catalog;
                localProceduralCapacity = localProceduralBudget;
                const totalRecords = proceduralCount + landmarkCount + objectCapacity + localProceduralCapacity + catalogCapacity;
                const totalBytes = totalRecords * records.RECORD_BYTES;
                if (totalBytes > maxStorageBytes) {
                        throw new Error(`Star buffer of ${(totalBytes / 1048576).toFixed(1)} MB exceeds the device limit of ${(maxStorageBytes / 1048576).toFixed(1)} MB`);
                }
                staging = new ArrayBuffer(Math.max(records.RECORD_BYTES, totalBytes));
                landmarkByteOffset = proceduralCount * records.RECORD_BYTES;
                objectByteOffset = (proceduralCount + landmarkCount) * records.RECORD_BYTES;
                localProceduralByteOffset = (proceduralCount + landmarkCount + objectCapacity) * records.RECORD_BYTES;
                catalogByteOffset = (proceduralCount + landmarkCount + objectCapacity + localProceduralCapacity) * records.RECORD_BYTES;
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
                if (nebulaBuffer) nebulaBuffer.destroy();
                const nebulaBytes = Math.max(16, objectCount * billboardBytes);
                nebulaStaging = new ArrayBuffer(nebulaBytes);
                nebulaBuffer = device.createBuffer({
                        label: 'nebula-storage',
                        size: nebulaBytes,
                        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
                });
                nebulaBindGroup = device.createBindGroup({
                        label: 'nebula-billboard-bind-group',
                        layout: nebulaBindGroupLayout,
                        entries: [
                                { binding: 0, resource: { buffer: uniformBuffer } },
                                { binding: 1, resource: { buffer: nebulaBuffer } },
                        ],
                });
                state.bufferBytes = totalBytes + nebulaBytes;
        }

        // Draw the field's positions and the exposure reference that goes with
        // them. Both are properties of the geometry: the same model at another
        // age lands on the same stars, which is why the age slider can skip this.
        function sampleField() {
                if (proceduralCount === 0) {
                        fieldStars = null;
                        referenceLuminosity = 0;
                        return;
                }
                const sampling = window.SamplingLib;
                const starTypes = window.StarTypesLib;
                const galaxyLib = window.GalaxyLib;
                fieldStars = sampling.sampleGalaxyStars(model, seed, proceduralCount, fieldStars);
                state.fieldSamples++;
                referenceLuminosity = starTypes.meanFieldLuminosity(
                        galaxyLib.modelAtAge(model, galaxyLib.AGE_REF), fieldStars, CALIBRATION_STARS);
        }

        // The offset, in magnitudes, between this field and the same field at the
        // reference epoch: 2.5·log10(mean L now / mean L at AGE_REF). Negative for
        // a young galaxy (fewer giants, so a dimmer field that the offset
        // brightens back), exactly 0 at the reference age.
        function calibrateExposure() {
                const starTypes = window.StarTypesLib;
                const now = fieldStars
                        ? starTypes.meanFieldLuminosity(model, fieldStars, CALIBRATION_STARS)
                        : 0;
                magOffset = (now > 0 && referenceLuminosity > 0)
                        ? 2.5 * Math.log10(now / referenceLuminosity)
                        : 0;
                state.magOffset = magOffset;
                state.galaxyAge = model.populations.age;
        }

        function writeProceduralRecords() {
                if (proceduralCount === 0) return 0;
                const starTypes = window.StarTypesLib;
                const view = new DataView(staging, 0, proceduralCount * records.RECORD_BYTES);
                const derived = {};
                for (let i = 0; i < proceduralCount; i++) {
                        starTypes.deriveStar(model, starTypes.fieldStarSeed(seed, i),
                                fieldStars.component[i], fieldStars.R[i], fieldStars.distToArm[i], derived);
                        records.writeRecord(
                                view, i * records.RECORD_BYTES,
                                fieldStars.x[i], fieldStars.y[i], fieldStars.z[i],
                                derived.colorIndex, derived.absMag + magOffset,
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

        // Composite-object members: placed whole-galaxy, apportioned into the
        // fixed block. The placement seed is domain-separated from the field
        // seed so the objects do not sit on field stars.
        function generateObjects() {
                if (objectCapacity === 0) {
                        state.objectStars = 0;
                        state.objectCount = 0;
                        state.nebulaBillboards = 0;
                        nebulaCount = 0;
                        return 0;
                }
                const placed = objectsLib.placeObjects(model, (seed | 0) ^ 0x0B5E55, objectCount, null);
                const view = new DataView(staging, objectByteOffset, objectCapacity * records.RECORD_BYTES);
                // Members are procedural stars, so they carry the same exposure
                // offset as the field they sit in.
                const written = objectsLib.writeObjectMembers(model, placed, view, 0, objectCapacity, magOffset).written;
                state.objectStars = written;
                state.objectCount = placed.length;
                if (nebulaStaging) {
                        new Uint8Array(nebulaStaging).fill(0);
                        nebulaCount = objectsLib.writeObjectBillboards(
                                placed, new DataView(nebulaStaging), 0, objectCount);
                } else {
                        nebulaCount = 0;
                }
                state.nebulaBillboards = nebulaCount;
                return written;
        }

        // Target total stars (procedural + catalog) for density parity
        // normalization. Passed down to the cell manager so expected per-cell
        // counts match what the global procedural field delivers.
        const targetStars = opts.targetStars || (proceduralTarget + catalogBudget);

        function attachCatalog(manifest) {
                state.catalogTotalStars = manifest.starCount;
                state.catalogCells = manifest.cellCount;
                const capacity = Math.min(manifest.starCount, catalogBudget);
                state.clampedCatalog = capacity < manifest.starCount;
                catalogCapacity = capacity;
                manager = window.CellManager.createCellManager(manifest, {
                        budgetStars: catalogBudget,
                        model,
                        targetStars,
                        bandRadius: opts.bandRadius,
                });
                return capacity;
        }

        // One-shot setup: allocate, generate, upload, expose. Procedural field,
        // landmarks and object members are all fixed until the next regenerate,
        // so they share one upload. Local gap-fill + catalog upload per rebuild.
        function prepare(manifest) {
                // Keep the last manifest that had content: a Game-mode rebuild passes none, and
                // coming back to the preset has to find the catalog still there.
                if (manifest) lastManifest = manifest;
                // Both clamp flags describe *this* buffer, so a regenerate that needs less room
                // must not keep reporting the old overflow.
                state.clampedProcedural = false;
                const catalog = manifest && model.milkyWay ? attachCatalog(manifest) : 0;
                if (!catalog) {
                        // Replace the manager rather than keep the old one: a stale
                        // resident set would upload the previous galaxy's stars.
                        manager = window.CellManager.createCellManager(EMPTY_MANIFEST, {
                                budgetStars: 0,
                                bandRadius: opts.bandRadius,
                                model,
                        });
                        state.catalogTotalStars = 0;
                        state.catalogCells = 0;
                        state.catalogResidentStars = 0;
                        state.catalogThinnedStars = 0;
                        state.clampedCatalog = false;
                }
                let procedural = proceduralTarget;
                const maxRecords = Math.floor(maxStorageBytes / records.RECORD_BYTES);
                const fixedOverhead = landmarkCount + localProceduralBudget;
                if (procedural + fixedOverhead + catalog > maxRecords) {
                        procedural = Math.max(0, maxRecords - fixedOverhead - catalog);
                        state.clampedProcedural = true;
                }
                allocate(procedural, catalog);
                sampleField();
                writeLandmarks();
                rebuildPopulation();
                return state;
        }

        // The population half of the fixed block: calibrate the exposure offset,
        // re-derive the procedural records, re-place the composite objects (their
        // rates and ages read the gas and the clock at this age) and upload.
        // `prepare` reaches it after a full sample; an age-only regenerate reaches
        // it with the positions it already has.
        function rebuildPopulation() {
                calibrateExposure();
                writeProceduralRecords();
                generateObjects();
                uploadFixed();
        }

        function uploadFixed() {
                const fixedBytes = (proceduralCount + landmarkCount + objectCapacity) * records.RECORD_BYTES;
                if (fixedBytes > 0) device.queue.writeBuffer(starBuffer, 0, staging, 0, fixedBytes);
                if (nebulaCount > 0) {
                        device.queue.writeBuffer(nebulaBuffer, 0, nebulaStaging, 0, nebulaCount * billboardBytes);
                }
        }

        // Rebuild the field for another galaxy. Deliberate and synchronous (the
        // same cost as the startup build), so it re-allocates rather than growing
        // a second path that patches buffers in place — with one exception. A
        // model that differs only in its population (the age slider) lands on the
        // same stars: positions are age-independent in 0.3, so re-sampling them
        // would cost 0.32 s at 300k to produce the bytes already in staging and
        // move nothing. That path keeps the field and rewrites the records
        // (~0.27 s, measured), and it is decided by the packed geometry rather
        // than by the type name, so an override cannot sneak past it.
        function regenerate(nextModel) {
                const previous = model;
                // The seed is compared whole: the uniform carries only its low 16
                // bits (the noise hash reads exactly those), while the field
                // hashes all 32. `milkyWay` decides the fixed block's layout, so
                // flipping it has to take the allocating path.
                const populationOnly = fieldStars !== null && proceduralCount > 0
                        && previous.milkyWay === nextModel.milkyWay
                        && (previous.seed | 0) === (nextModel.seed | 0)
                        && window.GalaxyLib.sameGeometry(previous, nextModel);
                configureMode(nextModel);
                if (populationOnly) {
                        rebuildPopulation();
                        uploadDynamic();
                        return state;
                }
                prepare(nextModel.milkyWay ? lastManifest : null);
                uploadDynamic();
                return state;
        }

        // --- Local procedural gap-fill ----------------------------------------
        // Generate N stable stars inside a cell AABB, used to bring each
        // streaming cell up to its expected density when the catalog is too
        // sparse. Keyed on (localSeed, cellId, slot) so the same camera position
        // always produces the same stars (no popping).
        const localHash = window.HashLib;
        const localStarTypes = window.StarTypesLib;
        const localDerived = {};

        function writeLocalProceduralStars(cellList, view, byteOffset) {
                // Derived per rebuild, not captured at construction: regenerate
                // swaps the seed, and a const here would freeze the old one.
                const localSeed = (seed | 0) ^ 0x10ca1cab;
                let slot = 0;
                const bytesPerRecord = records.RECORD_BYTES;
                for (const cell of cellList) {
                        const n = cell.fillNeeded;
                        if (n <= 0) continue;
                        const ox = cell.x0, oy = cell.y0, oz = cell.z0;
                        const cs = cell.size;
                        for (let i = 0; i < n; i++) {
                                const slotSeed = Math.imul(localSeed, 0x9e3779b1)
                                        ^ Math.imul(cell.id, 0x85ebca6b)
                                        ^ Math.imul(i + 1, 0xc2b2ae3d);
                                const u0 = localHash.hash01At(slotSeed, 0);
                                const u1 = localHash.hash01At(slotSeed, 1);
                                const u2 = localHash.hash01At(slotSeed, 2);
                                // Position: uniform jitter inside the cell AABB.
                                const sx = ox + u0 * cs;
                                const sy = oy + u1 * cs;
                                const sz = oz + u2 * cs;
                                // Derive component / colour / magnitude from the
                                // density at the star's position — same pipeline
                                // the global field uses.
                                const decomposed = window.DensityLib.rhoDecomposed(model, sx, sy, sz);
                                const component = window.DensityLib.sampleComponentIndex(decomposed, localHash.hash01At(slotSeed, 3));
                                const R = decomposed.R;
                                const distToArm = decomposed.distToArm;
                                const deriveSeed = Math.imul(slotSeed, 31) + 5;
                                localStarTypes.deriveStar(model, deriveSeed, component, R, distToArm, localDerived);
                                const jitter = localHash.pcgHash(slotSeed ^ 0xFACE) & 0xFF;
                                records.writeRecord(
                                        view, byteOffset + slot * bytesPerRecord,
                                        sx, sy, sz,
                                        // Same procedural population as the global
                                        // field, so the same exposure offset — a
                                        // gap-fill star that ignored it would be a
                                        // different colour of the same sky.
                                        localDerived.colorIndex, localDerived.absMag + magOffset,
                                        records.FLAG_VISIBLE, jitter,
                                );
                                slot++;
                        }
                }
                return slot;
        }

        // --- Catalog + local-procedural upload on rebuild ---------------------
        // Ask the cell manager for the current resident cells, thin the catalog
        // bytes to match expected density per cell, then fill in any per-cell
        // gap with local procedural stars, then upload both regions.
        function uploadDynamic() {
                const info = manager.getResidentInfo
                        ? manager.getResidentInfo()
                        : { cells: [], totalCatalogBytes: 0, totalVisibleCatalog: 0 };

                // 1) Zero the dynamic region in the staging buffer so slots we
                // no longer use don't carry old star data (no FLAG_VISIBLE set
                // means the shader skips them via the MASK_VISIBLE guard, but we
                // zero them anyway for cleanliness / debug).
                const dynamicCapacity = (localProceduralCapacity + catalogCapacity) * records.RECORD_BYTES;
                const dynRegion = new Uint8Array(staging, localProceduralByteOffset, dynamicCapacity);
                dynRegion.fill(0);

                // 2) Write local procedural gap-fill (after landmarks).
                const localView = new DataView(staging, localProceduralByteOffset, localProceduralCapacity * records.RECORD_BYTES);
                const localCount = writeLocalProceduralStars(info.cells, localView, 0);
                localProceduralCount = Math.min(localCount, localProceduralCapacity);

                // 3) Write catalog (decoded + thinned by cell manager; writeInto
                // returns the number of thinned, visible bytes).
                const catBytes = new Uint8Array(staging, catalogByteOffset, catalogCapacity * records.RECORD_BYTES);
                const catalogBytes = manager.writeInto(catBytes, 0);
                catalogResident = catalogBytes / records.RECORD_BYTES;

                // 4) Upload the dynamic range (local + catalog) in one write.
                const dynamicBytes = (localProceduralCount * records.RECORD_BYTES) + catalogBytes;
                if (dynamicBytes > 0) {
                        device.queue.writeBuffer(starBuffer, localProceduralByteOffset,
                                staging, localProceduralByteOffset, dynamicBytes);
                }

                // 4) If the local region is smaller than its capacity, zero out
                // the remaining slots by marking FLAG_VISIBLE off so they don't
                // draw. We only need to clear if we shrank; first frame writes
                // zeros from the fresh ArrayBuffer.
                const stats = manager.stats();
                state.cellsResident = stats.cellsResident;
                state.decodedBytes = stats.decodedBytes;
                state.catalogResidentStars = catalogResident;
                state.catalogThinnedStars = stats.visibleStars || catalogResident;
                state.localProceduralStars = localProceduralCount;
                return { localCount, catalogResident };
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

                let dynamicChanged = false;
                if (state.catalogTotalStars > 0) {
                        const update = manager.update(camera.cameraPos[0], camera.cameraPos[1], camera.cameraPos[2], dt);
                        dynamicChanged = update.changed;
                }
                // uploadDynamic writes both local gap-fill and thinned catalog.
                // With no catalog it is a no-op (no cells, nothing to fill).
                if (dynamicChanged) uploadDynamic();

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
                tonemapUniform[1] = whitePoint;
                tonemapUniform[2] = saturation;
                tonemapUniform[3] = outputMode;
                device.queue.writeBuffer(tonemapUniformBuffer, 0, tonemapUniformData);

                const instances = state.proceduralStars + landmarkCount + objectCapacity + localProceduralCount + catalogResident;
                state.drawn = instances;

                const encoder = device.createCommandEncoder({ label: 'star-frame' });

                ensureHdrTexture(width, height);

                // Pass 1: additive sprites into the rgba16float HDR intermediate.
                // Linear flux sums in linear light — no per-star clamping, no
                // per-star Reinhard. The filmic curve rolls off the sum in pass 2.
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

                // Pass 2: additive nebula billboards on top of the stars.
                // loadOp 'load' keeps the linear star flux; GPU culls by size
                // and distance so the instance count is the packed gas count.
                const nebulaPass = encoder.beginRenderPass({
                        label: 'nebula-billboards',
                        colorAttachments: [{
                                view: hdrView,
                                loadOp: 'load',
                                storeOp: 'store',
                        }],
                });
                nebulaPass.setPipeline(nebulaPipeline);
                nebulaPass.setBindGroup(0, nebulaBindGroup);
                nebulaPass.draw(4, nebulaCount, 0, 0);
                nebulaPass.end();

                // Pass 3: fullscreen tone-map into the swapchain. No blend,
                // alpha = 1.0. On SDR output is clamped [0,1] and the canvas
                // encodes sRGB; on HDR values can exceed 1.0 for the
                // extended-tone-mapping swapchain.
                const bg = hdrOutput
                        ? { r: 0.0001, g: 0.0002, b: 0.0005, a: 1.0 }
                        : { r: 0.008, g: 0.010, b: 0.020, a: 1.0 };
                const tonemapPass = encoder.beginRenderPass({
                        label: 'tonemap',
                        colorAttachments: [{
                                view: context.getCurrentTexture().createView(),
                                clearValue: bg,
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
                if (nebulaBuffer) nebulaBuffer.destroy();
                if (hdrTexture) hdrTexture.destroy();
                uniformBuffer.destroy();
                tonemapUniformBuffer.destroy();
                lutTexture.destroy();
        }

        return {
                prepare,
                regenerate,
                render,
                setExposure,
                setLinearExposure,
                setWhitePoint,
                setSaturation,
                dispose,
                state,
                stats: () => state,
                shaderError: () => shaderError,
        };
}

const StarRenderer = {
        createStarRenderer, EMPTY_MANIFEST, UNIFORM_FLOATS, TONEMAP_UNIFORM_FLOATS,
        PROCEDURAL_STARS_DEFAULT, CATALOG_BUDGET_DEFAULT, LOCAL_PROCEDURAL_DEFAULT,
        BASE_SIZE_PX, MAX_SIZE_PX, MIN_SIZE_PX, MIN_ALPHA, EXPOSURE_DEFAULT, EXPOSURE_STEP,
        LINEAR_EXPOSURE_DEFAULT, LINEAR_EXPOSURE_MIN, LINEAR_EXPOSURE_MAX,
        LINEAR_EXPOSURE_STEP,
        WHITE_POINT_DEFAULT, WHITE_POINT_MIN, WHITE_POINT_MAX,
        SATURATION_DEFAULT, SATURATION_MIN, SATURATION_MAX,
        HDR_INTERMEDIATE_FORMAT,
};
if (typeof module !== 'undefined') module.exports = StarRenderer;
if (typeof window !== 'undefined') window.StarRenderer = StarRenderer;
