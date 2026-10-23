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
// Frame cost: one 224-byte uniform write, one catalog buffer write (only when
// the resident set changed), an optional compute pass that steps the simple
// engine's azimuths (0.4.5), two additive passes into the HDR intermediate
// (stars, then nebula billboards) and one tonemap pass. No depth attachment —
// the sprites are additive, so there is nothing to depth-test against.

'use strict';

const UNIFORM_FLOATS = 56;              // 224 bytes: camera block + orbit/engine/epoch + formation gate
// Tonemap uniform: x=exposure, y=whitePoint, z=saturation, w=outputMode (0=SDR, 1=HDR),
// then headroom, highlightDesat, 0, 0.
const TONEMAP_UNIFORM_FLOATS = 8;
// Per-frame CPU budget for one slice of the epoch look sweep: a full 300k pass
// takes about half a second in slices this size, which is faster than the
// fastest star clock (a whole field per ~0.4 s at the top rate), so the sweep
// never becomes the bottleneck.
const EPOCH_SLICE_MS = 3;
// Stars the sweep's own exposure ratio is measured over: cheap enough to
// recompute once per sweep, and the same stars on both sides of the ratio.
const EPOCH_CALIBRATION_STARS = 4096;
const PROCEDURAL_STARS_DEFAULT = 300000;
// Gas account (F4): a 1024-bin histogram of birth times over [0, spanRef] is
// built once per field draw. Evaluating presence(T) from it is O(1024) per
// frame — one smoothstep per bin — and the view gas it delivers replaces the
// SFH gasNow only for the field's arm contrast. The bin count is a power of two
// so the bin index is a shift.
const GAS_HIST_BINS = 1024;
const TWO_PI = 2 * Math.PI;
const CATALOG_BUDGET_DEFAULT = 250000;
const LOCAL_PROCEDURAL_DEFAULT = 20000; // gap-fill for density parity near the camera
const BASE_SIZE_PX = 1.3;               // point sources
const MAX_SIZE_PX = 14.0;
const MIN_SIZE_PX = 0.8;                // never render a star smaller than this (prevents blink/pop)
const MIN_ALPHA = 0.25;                 // faintest stars still render as a dim pixel, not zero
const EXPOSURE_MIN = 0.0;
const EXPOSURE_MAX = 40.0;
// Deeper startup exposure for the galaxy-centre orbit view.
const EXPOSURE_DEFAULT = 22.0;
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
// Headroom (0.4.5): the HDR output ceiling, 1..8. Default 8.0 is today's
// ceiling — no pixel changes until the user drags it. 4.0 ≈ 400 nits on a
// 100-nit reference, matching the demo present pass this knob is compared
// against. SDR output is untouched (the [0,1] clamp stands).
const HEADROOM_DEFAULT = 8.0;
const HEADROOM_MIN = 1.0;
const HEADROOM_MAX = 8.0;
// Highlight desaturation (0.4.5): the filmic fade of bright cores to white.
// Default 1.0 is today's look; 0.0 keeps pure hues to any peak.
const HIGHLIGHT_DESAT_DEFAULT = 1.0;
const HIGHLIGHT_DESAT_MIN = 0.0;
const HIGHLIGHT_DESAT_MAX = 1.0;
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
        // Renderer unit tests construct the GPU harness without loading every page
        // script; preserve the old static record path in that environment.
        const orbit = window.OrbitLib || {
                flagsWithFamily: (flags) => flags,
                familyForStar: () => 1,
                familyFromColorIndex: () => 1,
                packOrbitDynamics: () => {},
                packEngineVec: () => {},
                packSimpleParams: () => {},
                setEngine: () => 0,
                getEngine: () => 0,
                SIMPLE_UNIFORM_FLOATS: 20,
        };
        const SIMPLE_UNIFORM_FLOATS = orbit.SIMPLE_UNIFORM_FLOATS || 20;
        const SIMPLE_WORKGROUP = 64;
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
        let proceduralTarget = Math.max(0, opts.proceduralStars === undefined ? PROCEDURAL_STARS_DEFAULT : opts.proceduralStars);
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
        // Composite objects (0.3.2a), now two layers in one block: star
        // clusters (clusters.js — stars only, inside this galaxy) written
        // first under their own exaggeration-scaled budget, then the gas
        // objects (objects.js) in what remains. Written once per regenerate
        // like the global field. The block capacity is computed in
        // allocate() from the procedural budget (plan §10), so the extra
        // stars can never outweigh the field they decorate; `objectMembers`
        // remains a test override for the total capacity. Unwritten slots
        // are zero records, which the shader culls.
        const objectsLib = window.ObjectsLib;
        const clustersLib = window.ClustersLib;
        let objectCapacity = 0;
        const objectCount = Math.max(0, opts.objectCount === undefined ? objectsLib.OBJECT_COUNT_DEFAULT : opts.objectCount);
        const clusterCountOpt = opts.clusterCount === undefined ? null : Math.max(0, opts.clusterCount);
        // The exaggeration coefficient is view state in clusters.js (like
        // the orbit sliders): set here from the boot option, changed later
        // through setClusterExaggeration + a re-draw that re-allocates.
        clustersLib.setClusterExaggeration(opts.clusterExaggeration === undefined
                ? clustersLib.getClusterExaggeration() : opts.clusterExaggeration);
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
                        // 0.4.5: the simple engine's per-slot azimuths, read by
                        // the vertex branch. Classic mode binds it and ignores it.
                        { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
                        { binding: 4, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
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
                                format: HDR_INTERMEDIATE_FORMAT,
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
        tonemapUniform[4] = HEADROOM_DEFAULT;
        tonemapUniform[5] = HIGHLIGHT_DESAT_DEFAULT;

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
                                format: HDR_INTERMEDIATE_FORMAT,
                                blend: {
                                        color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
                                        alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
                                },
                        }],
                },
                primitive: { topology: 'triangle-strip' },
        });

        // --- Simple-engine integrator (0.4.5) ------------------------------------
        // The compute pass that steps the friction-field azimuths while the
        // simple engine is selected. Uniform + pipeline are created once; the
        // bind group is recreated in allocate() because it binds the star and
        // theta buffers. The vertex shader reads theta through binding 3, so
        // the CPU never reads the azimuths back (per the indirect-draw rule —
        // labels step their own CPU mirror instead).
        const simpleModule = device.createShaderModule({
                label: 'simple-step',
                code: window.GalaxyShaders.SHADERS['simple-step'],
        });
        simpleModule.getCompilationInfo().then((info) => {
                for (const message of info.messages) {
                        if (message.type !== 'error') continue;
                        console.error('WGSL error in simple-step:', `${message.lineNum}:${message.linePos} ${message.message}`);
                }
        }).catch(() => {});

        const simpleUniformBuffer = device.createBuffer({
                label: 'simple-step-uniform',
                size: SIMPLE_UNIFORM_FLOATS * 4,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        const simpleUniformData = new ArrayBuffer(SIMPLE_UNIFORM_FLOATS * 4);
        const simpleUniform = new Float32Array(simpleUniformData);

        const simpleBindGroupLayout = device.createBindGroupLayout({
                label: 'simple-step-layout',
                entries: [
                        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                ],
        });
        const simplePipeline = device.createComputePipeline({
                label: 'simple-step-pipeline',
                layout: device.createPipelineLayout({ bindGroupLayouts: [simpleBindGroupLayout] }),
                compute: { module: simpleModule, entryPoint: 'main' },
        });
        let simpleBindGroup = null;

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
        let birthBuffer = null;
        let birthStaging = null;
        // Gas account (F4): the histogram of field births and its reference-span
        // extent. Built once per field draw, evaluated per epoch at O(1024).
        const birthHist = new Uint32Array(GAS_HIST_BINS);
        let birthHistSpanRef = 0;
        let birthHistPresenceRef = 0;
        let birthHistValid = false;
        let bindGroup = null;
        let staging = null;            // ArrayBuffer: [procedural][landmarks][objects][local][catalog]
        let landmarkByteOffset = 0;
        let objectByteOffset = 0;
        let catalogByteOffset = 0;
        let catalogCapacity = 0;
        let proceduralCount = 0;
        let catalogResident = 0;
        // Star identity (0.5.0): one stable u32 key per record slot, written by the
        // same code that writes the record. Streaming slots are not identities
        // (uploadDynamic rewrites them), so a selection stores the key and resolves
        // it back to a slot instead of remembering an index — see the plan §2.2.
        // Allocated with the staging buffer; every writer fills its own range.
        let identity = null;
        let identityView = null;       // DataView over `staging`, for the picker
        // Object-block member context (0.5.0): a record carries no age and no
        // component, and an object member's star is derived with the object's
        // coeval age (or as a planetary nebula's central star), so the two
        // numbers ride beside the block and are written by the member writer.
        // Indexed by the block-local slot — see objects.writeObjectMembers.
        let memberAge = null;
        let memberComponent = null;
        const BLOCK_LAYOUT = [
                { kind: 'field', offset: 0, count: 0 },
                { kind: 'landmark', offset: 0, count: 0 },
                { kind: 'object', offset: 0, count: 0 },
                { kind: 'local', offset: 0, count: 0 },
                { kind: 'catalog', offset: 0, count: 0 },
        ];
        // Returned by starBlocks() and mutated in place: the picker, the label layer
        // and the search read live counts and never allocate per frame.
        const blockInfo = {
                identity: null, view: null, blocks: BLOCK_LAYOUT, total: 0, dynamicVersion: 0,
                member: { age: null, component: null },
                formation: { births: null, age: model.populations.age, count: 0, gateAt: orbit.gateAt },
        };
        const fieldInfo = { x: null, y: null, z: null, R: null, distToArm: null, component: null, birth: null, count: 0 };
        const planets = (typeof module !== 'undefined' && module.exports)
                ? require('../math/planets.js')
                : window.PlanetsLib;
        let lastTime = 0;
        let lastStarTime = 0;
        // Simple-engine azimuths (0.4.5): one f32 per record slot, seeded from
        // the birth azimuths in staging. thetaStaging mirrors the record
        // layout slot-for-slot (index = byteOffset / RECORD_BYTES).
        let thetaBuffer = null;
        let thetaData = null;
        let thetaStaging = null;
        let totalRecordCount = 0;
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

        // Everything the HUD and the tests read, mutated in place.
        const state = {
                proceduralStars: 0,
                landmarkStars: 0,
                objectStars: 0,
                objectCount: 0,
                clusterStars: 0,
                clusterCount: 0,
                clusterExaggeration: clustersLib.getClusterExaggeration(),
                gasObjectStars: 0,
                gasObjectCount: 0,
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
                headroom: HEADROOM_DEFAULT,
                highlightDesat: HIGHLIGHT_DESAT_DEFAULT,
                engine: 'classic',
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
                epochSweepAt: 0,
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
        let headroom = opts.headroom === undefined ? HEADROOM_DEFAULT : opts.headroom;
        let highlightDesat = opts.highlightDesat === undefined ? HIGHLIGHT_DESAT_DEFAULT : opts.highlightDesat;

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

        function setHeadroom(value) {
                headroom = Math.max(HEADROOM_MIN, Math.min(HEADROOM_MAX, value));
                state.headroom = headroom;
                return headroom;
        }

        function setHighlightDesat(value) {
                highlightDesat = Math.max(HIGHLIGHT_DESAT_MIN, Math.min(HIGHLIGHT_DESAT_MAX, value));
                state.highlightDesat = highlightDesat;
                return highlightDesat;
        }

        // Engine select: classic (closed form), simple (integrated friction
        // field), or apocenter (analytic Kepler ellipses). Reseed the simple
        // theta block on every switch so stale integration state cannot leak
        // into its next selection.
        function setEngine(id) {
                const next = orbit.setEngine ? orbit.setEngine(id) : 0;
                state.engine = (next & 1 ? 'classic ' : '') + (next & 2 ? 'simple ' : '') + (next & 4 ? 'apocenter' : '');
                state.engine = state.engine.trim() || 'classic';
                seedThetaAll();
                return state.engine;
        }

        // R (reset everything) re-seeds the simple state alongside the time
        // accumulators in main.js, so the epoch restarts from the birth field.
        function resetSimpleState() {
                seedThetaAll();
                return state.engine;
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
                // Plan §10: the object block is cluster particles under the
                // exaggeration coefficient plus the gas layer's scaled
                // allowance — both linear in the field budget just chosen.
                objectCapacity = opts.objectMembers === undefined
                        ? clustersLib.clusterMemberBudget(procedural, clustersLib.getClusterExaggeration())
                                + objectsLib.gasMemberBudget(procedural)
                        : Math.max(0, Math.round(opts.objectMembers));
                localProceduralCapacity = localProceduralBudget;
                const totalRecords = proceduralCount + landmarkCount + objectCapacity + localProceduralCapacity + catalogCapacity;
                const totalBytes = totalRecords * records.RECORD_BYTES;
                if (totalBytes > maxStorageBytes) {
                        throw new Error(`Star buffer of ${(totalBytes / 1048576).toFixed(1)} MB exceeds the device limit of ${(maxStorageBytes / 1048576).toFixed(1)} MB`);
                }
                staging = new ArrayBuffer(Math.max(records.RECORD_BYTES, totalBytes));
                identity = new Uint32Array(totalRecords);
                identityView = new DataView(staging);
                memberAge = new Float64Array(objectCapacity);
                memberComponent = new Int8Array(objectCapacity);
                landmarkByteOffset = proceduralCount * records.RECORD_BYTES;
                objectByteOffset = (proceduralCount + landmarkCount) * records.RECORD_BYTES;
                localProceduralByteOffset = (proceduralCount + landmarkCount + objectCapacity) * records.RECORD_BYTES;
                catalogByteOffset = (proceduralCount + landmarkCount + objectCapacity + localProceduralCapacity) * records.RECORD_BYTES;
                // The block table mirrors the byte offsets above; the keys are the
                // slot index of the block's first record. Unwritten slots (object
                // capacity above the placed member count, catalog above the thinned
                // count) keep key 0 and are skipped by every reader, which tests
                // FLAG_VISIBLE first.
                blockInfo.identity = identity;
                blockInfo.view = identityView;
                blockInfo.total = totalRecords;
                blockInfo.member.age = memberAge;
                blockInfo.member.component = memberComponent;
                BLOCK_LAYOUT[0].offset = 0;
                BLOCK_LAYOUT[1].offset = proceduralCount;
                BLOCK_LAYOUT[2].offset = proceduralCount + landmarkCount;
                BLOCK_LAYOUT[3].offset = proceduralCount + landmarkCount + objectCapacity;
                BLOCK_LAYOUT[4].offset = proceduralCount + landmarkCount + objectCapacity + localProceduralCapacity;
                for (let b = 0; b < BLOCK_LAYOUT.length; b++) BLOCK_LAYOUT[b].count = 0;
                starBuffer = device.createBuffer({
                        label: 'star-storage',
                        size: Math.max(16, totalBytes),
                        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
                });
                if (thetaBuffer) thetaBuffer.destroy();
                if (birthBuffer) birthBuffer.destroy();
                birthStaging = new Float32Array(Math.max(1, proceduralCount));
                birthBuffer = device.createBuffer({
                        label: 'star-birth-times',
                        size: Math.max(4, proceduralCount * 4),
                        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
                });
                blockInfo.formation.births = birthStaging;
                blockInfo.formation.count = proceduralCount;
                totalRecordCount = totalRecords;
                const thetaBytes = Math.max(16, totalRecords * 4);
                thetaData = new ArrayBuffer(thetaBytes);
                thetaStaging = new Float32Array(thetaData);
                thetaBuffer = device.createBuffer({
                        label: 'simple-theta',
                        size: thetaBytes,
                        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
                });
                bindGroup = device.createBindGroup({
                        label: 'star-sprite-bind-group',
                        layout: bindGroupLayout,
                        entries: [
                                { binding: 0, resource: { buffer: uniformBuffer } },
                                { binding: 1, resource: { buffer: starBuffer } },
                                { binding: 2, resource: lutTexture.createView() },
                                { binding: 3, resource: { buffer: thetaBuffer } },
                                { binding: 4, resource: { buffer: birthBuffer } },
                        ],
                });
                simpleBindGroup = device.createBindGroup({
                        label: 'simple-step-bind-group',
                        layout: simpleBindGroupLayout,
                        entries: [
                                { binding: 0, resource: { buffer: simpleUniformBuffer } },
                                { binding: 1, resource: { buffer: starBuffer } },
                                { binding: 2, resource: { buffer: thetaBuffer } },
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
                state.bufferBytes = totalBytes + nebulaBytes + thetaBytes + Math.max(4, proceduralCount * 4);
        }

        // Seed the simple-engine azimuths from the birth positions in staging.
        // Zero (invisible) records get atan2 of the negated centre — harmless,
        // because the compute pass and the vertex shader both skip invisible
        // slots before reading theta.
        function seedThetaRange(recordStart, recordCount) {
                if (!thetaStaging || recordCount <= 0) return 0;
                const view = new DataView(staging);
                const cx = model.centre ? model.centre.x : 0;
                const cy = model.centre ? model.centre.y : 0;
                const map = [0, 0, 0];
                for (let i = 0; i < recordCount; i++) {
                        const index = recordStart + i;
                        const off = index * records.RECORD_BYTES;
                        let x = view.getFloat32(off, true);
                        let y = view.getFloat32(off + 4, true);
                        // Seed from where the record is *placed*, not from the
                        // bytes it was drawn with: the simple lane's integrator
                        // runs on the same epoch-mapped birth the vertex stage
                        // reconstructs from, and the landmarks that keep their
                        // CPU azimuths are the ones whose seeds are untouched.
                        if (index < proceduralCount + landmarkCount + objectCapacity) {
                                const packed = view.getUint32(off + 12, true);
                                const flags = (packed >>> 16) & 255;
                                if ((flags & records.FLAG_CLUSTER) !== 0) {
                                        x = orbit.clusterCentreCoord(x);
                                        y = orbit.clusterCentreCoord(y);
                                }
                                if ((flags & records.FLAG_EPOCH) !== 0) {
                                        orbit.epochMap(map, x, y, view.getFloat32(off + 8, true),
                                                (flags >> 3) & 3, flags, model);
                                        x = map[0]; y = map[1];
                                }
                        }
                        thetaStaging[index] = Math.atan2(y - cy, x - cx);
                }
                return recordCount;
        }

        function uploadThetaRange(recordStart, recordCount) {
                if (recordCount <= 0) return;
                device.queue.writeBuffer(thetaBuffer, recordStart * 4, thetaData, recordStart * 4, recordCount * 4);
        }

        // The named stars' azimuths are *integrated* by the CPU mirror (they are
        // on the simple lane too, and the mirror is what labels and picks use),
        // so the buffer takes the mirror's numbers rather than a fresh atan2 of
        // the drawn position. That is a sync, not a carry: E4 retired the
        // pattern-phase shift the old `carryThetas` also applied, because the
        // field is drawn into the frame it is displayed in.
        function syncLandmarkThetas() {
                if (!thetaStaging || landmarkCount <= 0) return 0;
                if (!orbit.simpleLandmarksReady || !orbit.simpleLandmarksReady()) return 0;
                for (let i = 0; i < landmarkCount; i++) thetaStaging[proceduralCount + i] = orbit.simpleLandmarkTheta(i);
                return landmarkCount;
        }

        function seedThetaAll() {
                if (!thetaStaging || totalRecordCount <= 0) return 0;
                const n = seedThetaRange(0, totalRecordCount);
                uploadThetaRange(0, totalRecordCount);
                return n;
        }

        // Birth times are a second deterministic channel of the same census.
        // They change only when a model's formation law changes, never as its
        // live epoch advances.
        function writeFieldBirths() {
                const starTypes = window.StarTypesLib;
                const galaxyLib = window.GalaxyLib;
                const reference = galaxyLib.modelAtAge(model, galaxyLib.AGE_REF);
                const count = fieldStars ? Math.min(proceduralCount, fieldStars.count) : 0;
                for (let i = 0; i < count; i++) {
                        birthStaging[i] = starTypes.sampleFieldBirth(reference,
                                starTypes.fieldStarSeed(seed, i), fieldStars.component[i],
                                fieldStars.R[i], fieldStars.distToArm[i], fieldStars.z[i]);
                }
                blockInfo.formation.births = birthStaging;
                blockInfo.formation.age = model.populations.age;
                blockInfo.formation.count = count;
                if (count > 0) device.queue.writeBuffer(birthBuffer, 0, birthStaging.buffer, 0, count * 4);
                buildBirthHistogram(count, reference);
                return count;
        }

        // Gas account (F4): a 1024-bin histogram of the field's birth times,
        // built over the reference span. One pass over the census at field draw
        // time; the resulting presence sum at any epoch is O(1024), not O(N).
        function buildBirthHistogram(count, referenceModel) {
                birthHist.fill(0);
                birthHistValid = false;
                if (count <= 0) { birthHistSpanRef = 0; birthHistPresenceRef = 0; return; }
                const p = referenceModel.populations;
                const spanRef = window.GalaxyLib.sfhSpanAt(window.GalaxyLib.AGE_REF, p.quenchTime);
                birthHistSpanRef = spanRef;
                if (!(spanRef > 0)) { birthHistPresenceRef = 0; return; }
                const scale = GAS_HIST_BINS / spanRef;
                for (let i = 0; i < count; i++) {
                        const b = birthStaging[i];
                        let k = (b * scale) | 0;
                        if (k < 0) k = 0;
                        else if (k >= GAS_HIST_BINS) k = GAS_HIST_BINS - 1;
                        birthHist[k]++;
                }
                // Precompute the reference-epoch presence so formed(T) is one
                // ratio, not two evaluations per frame.
                birthHistPresenceRef = evaluatePresence(window.GalaxyLib.AGE_REF);
                birthHistValid = true;
        }

        // The smoothstep presence sum: the census fraction visible at epoch T,
        // using the same gate the vertex stage applies. O(1024) per call.
        function evaluatePresence(T) {
                if (!birthHistValid || birthHistSpanRef <= 0) return 0;
                const fade = orbit.BIRTH_FADE_GYR;
                const binWidth = birthHistSpanRef / GAS_HIST_BINS;
                let sum = 0;
                for (let k = 0; k < GAS_HIST_BINS; k++) {
                        if (birthHist[k] === 0) continue;
                        const centre = (k + 0.5) * binWidth;
                        const lo = centre;
                        const hi = centre + fade;
                        let t = (T - lo) / (hi - lo);
                        if (t < 0) t = 0; else if (t > 1) t = 1;
                        sum += birthHist[k] * (t * t * (3 - 2 * t));
                }
                return sum;
        }

        // The view gas at epoch T: the census-calibrated gas fraction, exact at
        // both endpoints (gas(0) = 1, gas(AGE_REF) = gasFraction). Replaces the
        // SFH gasNow only for the field's arm contrast.
        function censusGasAt(age) {
                if (!birthHistValid || birthHistPresenceRef <= 0) return undefined;
                const p = model.populations;
                const presence = evaluatePresence(age);
                const formed = presence / birthHistPresenceRef;
                return 1 - formed * (1 - p.gasFraction);
        }

        // Draw the field's positions and the exposure reference that goes with
        // them. Both are properties of the geometry: the same model at another
        // age lands on the same stars, which is why the age slider can skip this.
        function sampleField() {
                if (proceduralCount === 0) {
                        fieldStars = null;
                        fieldInfo.count = 0;
                        fieldInfo.birth = null;
                        blockInfo.formation.count = 0;
                        referenceLuminosity = 0;
                        return;
                }
                const sampling = window.SamplingLib;
                const starTypes = window.StarTypesLib;
                const galaxyLib = window.GalaxyLib;
                fieldStars = sampling.sampleGalaxyStars(model, seed, proceduralCount, fieldStars);
                // The sampler's own arrays are the field block's inputs: the planet
                // module re-derives a picked field star from exactly these values
                // (component/R/distToArm/z), which is what makes that path bit-exact.
                fieldInfo.x = fieldStars ? fieldStars.x : null;
                fieldInfo.y = fieldStars ? fieldStars.y : null;
                fieldInfo.z = fieldStars ? fieldStars.z : null;
                fieldInfo.R = fieldStars ? fieldStars.R : null;
                fieldInfo.distToArm = fieldStars ? fieldStars.distToArm : null;
                fieldInfo.component = fieldStars ? fieldStars.component : null;
                fieldInfo.count = fieldStars ? fieldStars.count : 0;
                fieldInfo.birth = birthStaging;
                blockInfo.formation.births = birthStaging;
                blockInfo.formation.age = model.populations.age;
                blockInfo.formation.count = fieldInfo.count;
                writeFieldBirths();
                state.fieldSamples++;
                referenceLuminosity = starTypes.meanFieldLuminosity(
                        galaxyLib.modelAtAge(model, galaxyLib.AGE_REF), fieldStars, CALIBRATION_STARS,
                        birthStaging, galaxyLib.AGE_REF);
        }

        // ---- 0.6 E4: the running epoch ------------------------------------
        //
        // The field is drawn once, in the frame its own epoch defines (the
        // setEpochBase call in writeProceduralRecords), and *placed* by the
        // epoch map from then on: same stars, same identity, no re-sample and no
        // step. What still has to follow the clock is the look — the same star
        // at another age is a different colour and a different brightness (E1's
        // clock is a real clock, not a texture). Re-deriving all 300k looks at
        // once is exactly the ~0.25 s a 0.6 epoch step was paying; here the
        // field is swept in a few-millisecond slice per frame and only that
        // slice is re-uploaded, so the look follows continuously and nothing
        // ever blocks the frame. A sweep always reads the *current* model, so a
        // clock that outruns it cannot make it lag: it just keeps sweeping.
        // The composite objects are the one block the field's map does not place,
        // and they are drawn once for the same reason the field is: a placement
        // reads the age-dependent acceptance rates, so re-running it at every
        // epoch re-rolls the seats and re-seeds every member. Their members are
        // stars in this same buffer, so that re-roll replaced a slice of the
        // visible sky up to five times a second at the top star rate — the
        // reported jump. Their look is epoch-independent by construction (a
        // member's age is the object's own, imposed by deriveStarWithAge, and the
        // metallicity follows the component), so the block needs no refresh at
        // all: it is drawn with the field and carried.
        let epochCalibrationStars = 0;
        let epochCalibrationRef = 0;
        const epochSweep = { at: 0, stale: false };

        // The exposure offset over the sweep's own star sample, so it can be
        // recomputed at every sweep without the 16k-star cost of the startup
        // calibration and without the two halves of the ratio disagreeing.
        function sweepExposure() {
                if (!fieldStars || epochCalibrationStars <= 0 || !(epochCalibrationRef > 0)) return magOffset;
                const now = window.StarTypesLib.meanFieldLuminosity(model, fieldStars, epochCalibrationStars,
                        birthStaging, model.populations.age);
                return now > 0 ? 2.5 * Math.log10(now / epochCalibrationRef) : magOffset;
        }

        function nowMs() {
                return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        }

        // One slice: re-derive the look of the stars at [at, at+n) at the current
        // epoch's age and upload exactly that range. The records keep their
        // *birth* vectors — the vertex stage maps them per frame — so only the
        // look half of a record is ever rewritten here.
        //
        // The look's geometry is the star's own drawn structure (the R and
        // distance-to-arm it was drawn with: the identity a run must not
        // re-roll) with the epoch's two scale laws applied to the numbers those
        // laws actually move — the spheroid homology moves a bulge member's
        // radius, the height law moves a disc star's z. A rotation would not
        // enter: the look reads radius, distance-to-arm and height, and the map's
        // turn is a turn of all three.
        function sweepEpochLook(modelNow, budgetMs) {
                if (!fieldStars || proceduralCount === 0) return 0;
                const starTypes = window.StarTypesLib;
                const view = new DataView(staging, 0, proceduralCount * records.RECORD_BYTES);
                const derived = {};
                const params = orbit.solveEpochParams(modelNow);
                if (epochSweep.at === 0) {
                        // New sweep: one exposure for the whole pass, or a
                        // half-swept field would show a brightness seam.
                        magOffset = sweepExposure();
                        state.magOffset = magOffset;
                }
                const start = epochSweep.at;
                const t0 = nowMs();
                let i = start;
                while (i < proceduralCount) {
                        const off = i * records.RECORD_BYTES;
                        const packed = view.getUint32(off + 12, true);
                        const flags = (packed >>> 16) & 255;
                        // Branch on the record's own bits, the same way the
                        // vertex stage does, so the two sides cannot disagree
                        // about which stars the bulge homology moves.
                        const spheroid = (flags & records.FLAG_EPOCH_SPHEROID) !== 0;
                        const family = (flags >> 3) & 3;
                        const scale = spheroid ? params.spheroidScale
                                : ((family === orbit.FAMILY_DISC || family === orbit.FAMILY_PATTERN) ? params.heatScale : 1);
                        const R = fieldStars.R[i] * scale;
                        const distToArm = fieldStars.distToArm[i] * scale;
                        starTypes.deriveStarWithAge(modelNow, starTypes.fieldStarSeed(seed, i),
                                fieldStars.component[i], R, distToArm,
                                Math.max(0, modelNow.populations.age - birthStaging[i]), derived);
                        records.writeRecord(
                                view, off, fieldStars.x[i], fieldStars.y[i], fieldStars.z[i],
                                derived.colorIndex, derived.absMag,
                                orbit.flagsWithFamily(records.FLAG_VISIBLE
                                        | (flags & (records.FLAG_EPOCH | records.FLAG_EPOCH_SPHEROID)),
                                        orbit.familyForStar(fieldStars.component[i], derived.spectralClass, modelNow.barred)),
                                Math.imul(i, 2654435761) & 0xFF,
                        );
                        i++;
                        if ((i & 511) === 0 && nowMs() - t0 >= budgetMs) break;
                }
                if (i > start) {
                        const byteStart = start * records.RECORD_BYTES;
                        const bytes = (i - start) * records.RECORD_BYTES;
                        device.queue.writeBuffer(starBuffer, byteStart, staging, byteStart, bytes);
                }
                epochSweep.at = i;
                if (i >= proceduralCount) {
                        epochSweep.at = 0;
                        epochSweep.stale = false;
                }
                state.epochSweepAt = epochSweep.at;
                return i - start;
        }

        // The sweep, driven by hand: the tests step it a slice at a time and
        // read the records back, and a caller with no frame loop can finish a
        // whole pass in one call (`budget` large).
        function stepEpoch(modelNow, budgetMs) {
                if (!fieldStars || proceduralCount === 0) return 0;
                if (!modelNow) modelNow = model;
                return sweepEpochLook(modelNow, budgetMs === undefined ? EPOCH_SLICE_MS : budgetMs);
        }
        function epochSweepState() {
                return { at: epochSweep.at, stale: epochSweep.stale, calibrationStars: epochCalibrationStars };
        }

        // The epoch half of the vertex stage's lane, for callers that place a
        // record themselves (labels, picking, tests): the same numbers the
        // uniform carries.
        function epochParams(modelNow, out) {
                return orbit.packEpochParams(modelNow, out, 0, state.magOffset || 0);
        }

        // A new epoch on an unchanged field (0.6 E4). The age slider and the
        // live clock reach this: the records stay, the map places them, and the
        // look follows in the background sweep.
        function setEpoch(nextModel) {
                model = nextModel;
                state.galaxyAge = model.populations.age;
                blockInfo.formation.age = model.populations.age;
                state.galaxyLabel = window.GalaxyLib.galaxyLabel(nextModel);
                epochSweep.stale = true;
                return state;
        }

        // The offset, in magnitudes, between this field and the same field at the
        // reference epoch: 2.5·log10(mean L now / mean L at AGE_REF). Negative for
        // a young galaxy (fewer giants, so a dimmer field that the offset
        // brightens back), exactly 0 at the reference age.
        function calibrateExposure() {
                const starTypes = window.StarTypesLib;
                const now = fieldStars
                        ? starTypes.meanFieldLuminosity(model, fieldStars, CALIBRATION_STARS,
                                birthStaging, model.populations.age)
                        : 0;
                magOffset = (now > 0 && referenceLuminosity > 0)
                        ? 2.5 * Math.log10(now / referenceLuminosity)
                        : 0;
                state.magOffset = magOffset;
                state.galaxyAge = model.populations.age;
        }

        // The epoch bits a field record carries (0.6 E4) live in math/orbit.js,
        // beside the family law they read: the island builds the same record
        // for the same star, and a field star with a different epoch bit than
        // the app's would leave the epoch map.
        function epochFlagsFor(component, spectralClass) {
                return orbit.epochFlagsFor(component, spectralClass, model.barred);
        }

        function writeProceduralRecords() {
                if (proceduralCount === 0) return 0;
                const starTypes = window.StarTypesLib;
                const view = new DataView(staging, 0, proceduralCount * records.RECORD_BYTES);
                const derived = {};
                for (let i = 0; i < proceduralCount; i++) {
                        const key = starTypes.fieldStarSeed(seed, i);
                        starTypes.deriveStarWithAge(model, key,
                                fieldStars.component[i], fieldStars.R[i], fieldStars.distToArm[i],
                                Math.max(0, model.populations.age - birthStaging[i]), derived);
                        records.writeRecord(
                                view, i * records.RECORD_BYTES,
                                fieldStars.x[i], fieldStars.y[i], fieldStars.z[i],
                                // Raw magnitude: the field's exposure offset rides
                                // the uniform (camera.epoch.w), so neither a step
                                // nor a sweep has to rewrite a record to keep the
                                // field at one brightness.
                                derived.colorIndex, derived.absMag,
                                orbit.flagsWithFamily(records.FLAG_VISIBLE | epochFlagsFor(fieldStars.component[i], derived.spectralClass),
                                        orbit.familyForStar(fieldStars.component[i], derived.spectralClass, model.barred)),
                                starTypes.fieldStarJitter(i),
                        );
                        identity[i] = key;
                }
                BLOCK_LAYOUT[0].count = proceduralCount;
                state.proceduralStars = proceduralCount;
                // This draw *is* the epoch frame: every mapped number is measured
                // against it, and the map is the exact identity here.
                orbit.setEpochBase(model);
                epochCalibrationStars = Math.min(proceduralCount, EPOCH_CALIBRATION_STARS);
                epochCalibrationRef = epochCalibrationStars > 0
                        ? window.StarTypesLib.meanFieldLuminosity(
                                window.GalaxyLib.modelAtAge(model, window.GalaxyLib.AGE_REF), fieldStars,
                                epochCalibrationStars, birthStaging, window.GalaxyLib.AGE_REF)
                        : 0;
                // This draw is already at the epoch it was drawn into: nothing
                // for the sweep to catch up on until the epoch moves.
                epochSweep.at = 0;
                epochSweep.stale = false;
                return proceduralCount;
        }

        // The named stars, flagged so later cull passes never thin them away.
        // Positions are the load-time bake in data/landmarks.js. The orbit
        // family follows the colour index (O/B/A pattern, else disc) — the
        // exact rule label-layer.js and selection.js use, so labels and picks
        // ride the same orbit the GPU draws.
        function writeLandmarks() {
                const view = new DataView(staging, landmarkByteOffset, landmarkCount * records.RECORD_BYTES);
                const base = BLOCK_LAYOUT[1].offset;
                for (let i = 0; i < landmarkCount; i++) {
                        const e = landmarks.ENTRIES[i];
                        records.writeRecord(
                                view, i * records.RECORD_BYTES,
                                e.x, e.y, e.z,
                                e.colorIndex, e.absMag,
                                orbit.flagsWithFamily(
                                        records.FLAG_VISIBLE | records.FLAG_LANDMARK,
                                        orbit.familyFromColorIndex(e.colorIndex)),
                                0,
                        );
                        // Positional: a landmark's key is its index in the table
                        // (plan §2.2), so it needs no cell bookkeeping.
                        identity[base + i] = planets.landmarkKey(i);
                }
                BLOCK_LAYOUT[1].count = landmarkCount;
                state.landmarkStars = landmarkCount;
                return landmarkCount;
        }

        // Composite-object members: placed whole-galaxy, apportioned into
        // the shared block. Star clusters come first, capped by their own
        // budget (field stars × true fraction × exaggeration — plan §10);
        // the gas objects fill what remains. The placement seeds are
        // domain-separated from the field seed and from each other, so no
        // layer sits on another layer's stars.
        function generateObjects() {
                if (objectCapacity === 0) {
                        state.objectStars = 0;
                        state.objectCount = 0;
                        state.clusterStars = 0;
                        state.clusterCount = 0;
                        state.gasObjectStars = 0;
                        state.gasObjectCount = 0;
                        state.nebulaBillboards = 0;
                        nebulaCount = 0;
                        return 0;
                }
                const placedClusters = clustersLib.placeStarClusters(model, (seed | 0) ^ 0xC1057E5,
                        clusterCountOpt === null ? clustersLib.clusterCountFor(model) : clusterCountOpt, null);
                const placed = objectsLib.placeObjects(model, (seed | 0) ^ 0x0B5E55, objectCount, null);
                // Members are procedural stars, so they carry the same exposure
                // offset as the field they sit in.
                const clusterBudget = Math.min(objectCapacity,
                        clustersLib.clusterMemberBudget(proceduralCount, clustersLib.getClusterExaggeration()));
                const clusterView = new DataView(staging, objectByteOffset, objectCapacity * records.RECORD_BYTES);
                const clusterWritten = clustersLib.writeClusterMembers(model, placedClusters, clusterView, 0,
                        clusterBudget, magOffset, identity, BLOCK_LAYOUT[2].offset,
                        { age: memberAge, component: memberComponent }).written;
                const gasCapacity = objectCapacity - clusterWritten;
                const gasView = new DataView(staging, objectByteOffset + clusterWritten * records.RECORD_BYTES,
                        gasCapacity * records.RECORD_BYTES);
                const gasWritten = objectsLib.writeObjectMembers(model, placed, gasView, 0, gasCapacity, magOffset,
                        identity, BLOCK_LAYOUT[2].offset + clusterWritten,
                        { age: memberAge.subarray(clusterWritten), component: memberComponent.subarray(clusterWritten) }).written;
                const written = clusterWritten + gasWritten;
                BLOCK_LAYOUT[2].count = written;
                state.objectStars = written;
                state.clusterStars = clusterWritten;
                state.clusterCount = placedClusters.length;
                state.gasObjectStars = gasWritten;
                state.gasObjectCount = placed.length;
                state.objectCount = placedClusters.length + placed.length;
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

        // The cluster exaggeration coefficient (plan §10): view state in
        // clusters.js, clamped there. Changing it changes the block's size,
        // so the caller re-draws (allocate reads it); this only records it.
        function setClusterExaggeration(value) {
                const next = clustersLib.setClusterExaggeration(value);
                state.clusterExaggeration = next;
                return next;
        }

        // Target total stars (procedural + catalog) for density parity
        // normalization. Passed down to the cell manager so expected per-cell
        // counts match what the global procedural field delivers.
        let targetStars = opts.targetStars || (proceduralTarget + catalogBudget);
        let budgetDirty = false;

        // The star budget is a menu control (0.6): it takes effect on the next
        // allocating rebuild, which the caller forces with `regenerate`. The
        // parity target moves with it, so the catalog gap-fill keeps matching
        // the field's density per cell.
        function setProceduralStars(count) {
                const next = Math.max(0, Math.round(Number(count) || 0));
                if (next === proceduralTarget) return proceduralTarget;
                if (!opts.targetStars) targetStars += next - proceduralTarget;
                proceduralTarget = next;
                budgetDirty = true;
                return proceduralTarget;
        }

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
                budgetDirty = false;
                sampleField();
                writeLandmarks();
                rebuildPopulation();
                // Fresh positions mean a fresh simple epoch for the fixed
                // block; uploadDynamic seeds the streaming range below it. Any
                // caller that reaches prepare re-seeds, which is the point: the
                // thetas are a function of the birth positions it just drew.
                const fixedRecords = proceduralCount + landmarkCount + objectCapacity;
                seedThetaRange(0, fixedRecords);
                syncLandmarkThetas();
                uploadThetaRange(0, fixedRecords);
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
        // model that differs only in its population lands on the same stars, so
        // the field is kept and the records are rewritten (~0.27 s, measured)
        // instead of re-sampling bytes that would come back identical. That is
        // decided by the packed geometry rather than by the type name, so an
        // override cannot sneak past it. Nothing 0.6 releases needs the reusable
        // path: the epoch tier is packed geometry, so the age slider re-samples.
        function regenerate(nextModel) {
                const previous = model;
                // The seed is compared whole: the uniform carries only its low 16
                // bits (the noise hash reads exactly those), while the field
                // hashes all 32. `milkyWay` decides the fixed block's layout, so
                // flipping it has to take the allocating path.
                const populationOnly = fieldStars !== null && proceduralCount > 0 && !budgetDirty
                        && previous.milkyWay === nextModel.milkyWay
                        && (previous.seed | 0) === (nextModel.seed | 0)
                        && window.GalaxyLib.sameGeometry(previous, nextModel);
                configureMode(nextModel);
                if (populationOnly) {
                        writeFieldBirths();
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
                                localStarTypes.deriveStar(model, Math.imul(slotSeed, 31) + 5,
                                        component, R, distToArm, localDerived, sz);
                                const jitter = localHash.pcgHash(slotSeed ^ 0xFACE) & 0xFF;
                                records.writeRecord(
                                        view, byteOffset + slot * bytesPerRecord,
                                        sx, sy, sz,
                                        // Same procedural population as the global
                                        // field, so the same exposure offset — a
                                        // gap-fill star that ignored it would be a
                                        // different colour of the same sky.
                                        // Raw, like the field: the exposure offset
                                        // rides the uniform, and the epoch bits make
                                        // this star follow the running epoch too.
                                        localDerived.colorIndex, localDerived.absMag,
                                        orbit.flagsWithFamily(records.FLAG_VISIBLE | epochFlagsFor(component, localDerived.spectralClass),
                                                orbit.familyForStar(component, localDerived.spectralClass, model.barred)), jitter,
                                );
                                // The identity key *is* the seed this record was
                                // derived from (slotSeed), so the planet module can
                                // re-derive the exact star from the key alone.
                                identity[BLOCK_LAYOUT[3].offset + slot] = slotSeed >>> 0;
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
                BLOCK_LAYOUT[3].count = localProceduralCount;

                // 3) Write catalog (decoded + thinned by cell manager; writeInto
                // returns the number of thinned, visible bytes). The manager writes
                // each record's stable key beside it — keyed on the record's index
                // inside its own cell, so thinning cannot re-key a star.
                const catBytes = new Uint8Array(staging, catalogByteOffset, catalogCapacity * records.RECORD_BYTES);
                const catalogBytes = manager.writeInto(catBytes, 0, identity, BLOCK_LAYOUT[4].offset);
                catalogResident = catalogBytes / records.RECORD_BYTES;
                BLOCK_LAYOUT[4].count = catalogResident;

                // 4) Upload the dynamic range (local + catalog) in one write.
                const dynamicBytes = (localProceduralCount * records.RECORD_BYTES) + catalogBytes;
                if (dynamicBytes > 0) {
                        device.queue.writeBuffer(starBuffer, localProceduralByteOffset,
                                staging, localProceduralByteOffset, dynamicBytes);
                }

                // 5) Streaming slots are not stable star identities, so their
                // simple-engine azimuths re-seed from the new birth positions
                // on every rebuild — those stars snap phase when cells change
                // (documented in the plan; the fixed block never does).
                const dynamicStart = localProceduralByteOffset / records.RECORD_BYTES;
                seedThetaRange(dynamicStart, localProceduralCapacity + catalogCapacity);
                uploadThetaRange(dynamicStart, localProceduralCapacity + catalogCapacity);

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
                // The streaming blocks were rewritten: slot indices resolved from
                // keys are stale from here on (the label layer and the picker watch
                // this counter instead of diffing counts, which can coincide).
                blockInfo.dynamicVersion++;
                return { localCount, catalogResident };
        }

        // --- Frame ------------------------------------------------------------
        // dtStarArg is the frame's star-time step in Myr (main.js passes it;
        // without it the renderer diffs the star clock itself). Under the
        // simple engine it drives the compute dispatch; classic ignores it.
        function render(camera, width, height, time, input, dtStarArg) {
                if (!starBuffer || width === 0 || height === 0) return;
                const dt = Math.min(MAX_FRAME_DT, Math.max(0, time - lastTime));
                lastTime = time;
                const dtStar = dtStarArg === undefined ? Math.max(0, time - lastStarTime) : Math.max(0, dtStarArg);
                lastStarTime = time;

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
                uniform[19] = model.centre ? model.centre.x : 0;
                uniform[20] = width;
                uniform[21] = height;
                uniform[22] = 2 / width;
                uniform[23] = 2 / height;
                uniform[24] = magZero;
                uniform[25] = BASE_SIZE_PX;
                uniform[26] = MAX_SIZE_PX;
                uniform[27] = time;
                // Orbit dynamics (vec4 A + vec4 B): re-packed every frame so a
                // regenerate can never leave the shader on the old galaxy's
                // rotation numbers — eight floats, no allocation. The engine
                // lane rides at offset 44 for the vertex branch.
                if (orbit.packOrbitDynamics) orbit.packOrbitDynamics(model, uniform, 28);
                if (orbit.packEngineVec) orbit.packEngineVec(model, uniform, 44);
                // E4: the look of the field follows the running epoch in slices,
                // a few ms a frame — after the uniform is packed, so the frame
                // that draws this update is drawn with it.
                // Only with a queue to upload the slice into: the node harnesses
                // build a renderer without one.
                if (epochSweep.stale && device.queue && device.queue.writeBuffer) {
                        sweepEpochLook(model, EPOCH_SLICE_MS);
                }

                // The epoch map (0.6 E4): how this frame's epoch places a record
                // drawn at the field's base epoch, plus the field's own exposure
                // offset. Solved from the same model the lanes came from, so the
                // shader and the CPU twins (orbit.epochMap) cannot disagree.
                if (orbit.packEpochParams) orbit.packEpochParams(model, uniform, 48, state.magOffset || 0);
                uniform[52] = model.populations.age;
                uniform[53] = orbit.BIRTH_FADE_GYR || 0.05;
                uniform[54] = proceduralCount;
                uniform[55] = 0;
                device.queue.writeBuffer(uniformBuffer, 0, uniformData);

                tonemapUniform[0] = linearExposure;
                tonemapUniform[1] = whitePoint;
                tonemapUniform[2] = saturation;
                tonemapUniform[3] = outputMode;
                tonemapUniform[4] = headroom;
                tonemapUniform[5] = highlightDesat;
                device.queue.writeBuffer(tonemapUniformBuffer, 0, tonemapUniformData);

                // Simple engine: pack the step uniform and count the substeps
                // first — nSub = 0 (frozen time) skips the dispatch entirely.
                let simpleSteps = 0;
                if (orbit.packSimpleParams && (orbit.getEngine ? (orbit.getEngine() & orbit.ENGINE_SIMPLE) : false)) {
                        orbit.packSimpleParams(model, simpleUniform, 0, dtStar, totalRecordCount, time);
                        simpleSteps = simpleUniform[1] | 0;
                        if (simpleSteps > 0) device.queue.writeBuffer(simpleUniformBuffer, 0, simpleUniformData);
                }

                const instances = state.proceduralStars + landmarkCount + objectCapacity + localProceduralCount + catalogResident;
                state.drawn = instances;

                const encoder = device.createCommandEncoder({ label: 'star-frame' });

                ensureHdrTexture(width, height);

                // Pass 0 (simple engine only): step the friction-field
                // azimuths for the frame's dtStar, before the sprite pass
                // reconstructs positions from them.
                if (simpleSteps > 0) {
                        const stepPass = encoder.beginComputePass({ label: 'simple-step' });
                        stepPass.setPipeline(simplePipeline);
                        stepPass.setBindGroup(0, simpleBindGroup);
                        stepPass.dispatchWorkgroups(Math.ceil(totalRecordCount / SIMPLE_WORKGROUP));
                        stepPass.end();
                }

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
                const swapView = context.getCurrentTexture().createView();
                const tonemapPass = encoder.beginRenderPass({
                        label: 'tonemap',
                        colorAttachments: [{
                                view: swapView,
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
                if (birthBuffer) birthBuffer.destroy();
                if (nebulaBuffer) nebulaBuffer.destroy();
                if (thetaBuffer) thetaBuffer.destroy();
                if (hdrTexture) hdrTexture.destroy();
                uniformBuffer.destroy();
                tonemapUniformBuffer.destroy();
                simpleUniformBuffer.destroy();
                lutTexture.destroy();
        }

        return {
                prepare,
                regenerate,
                setEpoch, stepEpoch, epochSweepState, epochParams,
                render,
                // Read-only views of what is resident, for the picker, the label
                // layer and the search (0.5.0). Both objects are allocated once and
                // mutated in place, so a per-pick or per-frame caller allocates
                // nothing; the counts inside `starBlocks().blocks` are live.
                starBlocks: () => blockInfo,
                fieldBuffers: () => fieldInfo,
                setExposure,
                setLinearExposure,
                setWhitePoint,
                setSaturation,
                setHeadroom,
                setHighlightDesat,
                setEngine,
                resetSimpleState,
                setClusterExaggeration,
                setProceduralStars,
                proceduralTarget: () => proceduralTarget,
                dispose,
                state,
                stats: () => state,
                shaderError: () => shaderError,
                censusGasAt,
        };
}

const StarRenderer = {
        createStarRenderer, EMPTY_MANIFEST, UNIFORM_FLOATS, TONEMAP_UNIFORM_FLOATS,
        EPOCH_SLICE_MS, EPOCH_CALIBRATION_STARS,
        PROCEDURAL_STARS_DEFAULT, CATALOG_BUDGET_DEFAULT, LOCAL_PROCEDURAL_DEFAULT,
        BASE_SIZE_PX, MAX_SIZE_PX, MIN_SIZE_PX, MIN_ALPHA, EXPOSURE_DEFAULT, EXPOSURE_STEP,
        LINEAR_EXPOSURE_DEFAULT, LINEAR_EXPOSURE_MIN, LINEAR_EXPOSURE_MAX,
        LINEAR_EXPOSURE_STEP,
        WHITE_POINT_DEFAULT, WHITE_POINT_MIN, WHITE_POINT_MAX,
        SATURATION_DEFAULT, SATURATION_MIN, SATURATION_MAX,
        HEADROOM_DEFAULT, HEADROOM_MIN, HEADROOM_MAX,
        HIGHLIGHT_DESAT_DEFAULT, HIGHLIGHT_DESAT_MIN, HIGHLIGHT_DESAT_MAX,
        HDR_INTERMEDIATE_FORMAT,
};
if (typeof module !== 'undefined') module.exports = StarRenderer;
if (typeof window !== 'undefined') window.StarRenderer = StarRenderer;
