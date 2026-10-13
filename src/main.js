// src/main.js
// Boot: WebGPU device → camera → input → renderer (catalog + procedural) →
// label layer + selection → loop.
//
// Overlay text is rebuilt at 4 Hz, not every frame: the frame loop stays free
// of string building and DOM writes. The label layer is the exception — it
// redraws every frame so labels track their stars while the camera moves.

'use strict';

const OVERLAY_INTERVAL = 0.25;      // s
const MAX_DPR = 2;                  // retinal 3x costs fill rate for no gain
// Age slider: the step the model is worth reading at (0.1 Gyr is far finer than
// any population change here) and the shortest gap between two field rebuilds.
// A rebuild is ~0.27 s at 300k stars, so this keeps a drag interactive instead
// of queueing one rebuild per pixel.
const AGE_STEP = 0.1;               // Gyr
const AGE_REGEN_INTERVAL = 0.35;    // s, in loop time

function currentDpr() {
        return Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, MAX_DPR);
}

// Three significant figures, trailing zeros dropped: 8, 0.125, 2050.
function formatSpeed(lyPerSec) {
	return `${Number(lyPerSec.toPrecision(3))} ly/s`;
}

function formatDistance(kpc) {
	return kpc >= 1 ? `${kpc.toFixed(3)} kpc` : `${(kpc * 1000).toFixed(2)} pc`;
}

// A light-year radius for the readout: 50 ly reads as "50 ly", 0.1 as "0.1 ly",
// 100000 as "100000 ly". No units conversion here — the slider is already ly.
function formatLy(ly) {
	return `${Number(ly.toPrecision(3))} ly`;
}

// The system clock's rate (§6.4), as the menu value and the readout name it: 0
// is the frozen default, a negative rate follows the camera speed.
function formatSystemTime(rate) {
	if (rate === 0) return '0 y/s';
	if (rate < 0) return `follow ×${(-rate).toFixed(1)}`;
	return `+${Number(rate.toPrecision(3))} y/s`;
}

// A radius in AU, compact where the readout's example is compact: 34 AU reads
// "34" and 1.48 AU reads "1.48".
function formatAu(au) {
	return au >= 10 ? String(Math.round(au)) : au.toFixed(2);
}

// padEnd for the readout's fixed columns.
function pad(text, width) {
	return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

const FACTOR_LABELS = { 100: 'Shift', 0.1: 'Ctrl', 10: 'Shift+Ctrl' };
function formatFactor(factor) {
        const label = FACTOR_LABELS[factor];
        return label ? `   [${label} x${factor}]` : '';
}

function readParams(search) {
        const params = new URLSearchParams(search === undefined ? window.location.search : search);
        const number = (name, fallback) => {
                const value = params.get(name);
                // An absent or empty parameter means "use the default"; `0` is a
                // deliberate value (e.g. catalog=0 renders procedurally only).
                if (value === null || value.trim() === '') return fallback;
                const parsed = Number(value);
                return Number.isFinite(parsed) ? parsed : fallback;
        };
        const text = (name, fallback) => {
                const value = params.get(name);
                if (value === null || value.trim() === '') return fallback;
                return value.trim();
        };
        return {
                stars: number('stars', window.StarRenderer.PROCEDURAL_STARS_DEFAULT),
                catalogStars: number('catalog', window.StarRenderer.CATALOG_BUDGET_DEFAULT),
                exposure: params.has('exposure') ? number('exposure', window.StarRenderer.EXPOSURE_DEFAULT) : null,
                seed: number('seed', window.GalaxyLib.DEFAULT_SEED),
                // null is the table's default type; unknown names are resolved (and reported)
                // by createGalaxy, which is where the type list lives.
                type: text('type', null),
                // The cosmic epoch the galaxy is frozen at. createGalaxy clamps it
                // to the model's own range, so ?age=99 is the oldest galaxy there
                // is rather than an error.
                age: number('age', window.GalaxyLib.AGE_DEFAULT),
                // Star-motion engine: classic closed form, simple friction
                // field, or apocenter-guided ellipses. Unknown values fall back
                // to classic in orbit.setEngine.
                engine: text('engine', 'classic'),
                // Multiplier of the model's derived pattern speed: the friction
                // field's rotation rate (0 frozen … 3, 1 = the derived group
                // speed). Clamped by orbit.setPatternScale.
                pattern: number('pattern', window.OrbitLib.PATTERN_SCALE_UI_DEFAULT),
                // The rest of the settings menu, so a preset string and the URL
                // speak one language. Absent = the startup default, applied by
                // boot below.
                time: number('time', 5),
                wave: number('wave', window.OrbitLib.WAVE_DAMPING_UI_DEFAULT),
                apoShare: number('apoShare', window.OrbitLib.APOCENTER_SHARE_UI_DEFAULT),
                apoForce: number('apoForce', window.OrbitLib.APOCENTER_FORCE_UI_DEFAULT),
                brightness: number('brightness', window.StarRenderer.LINEAR_EXPOSURE_DEFAULT),
                white: number('white', window.StarRenderer.WHITE_POINT_DEFAULT),
                sat: number('sat', window.StarRenderer.SATURATION_DEFAULT),
                headroom: number('headroom', window.StarRenderer.HEADROOM_DEFAULT),
                highlight: number('highlight', window.StarRenderer.HIGHLIGHT_DESAT_DEFAULT),
                // Select-around radius, world-space in light-years (0.5.0).
                selrad: number('selrad', window.Selection.SELECT_RADIUS_LY_DEFAULT),
                // The system view's own clock (§6.4): years per second of the
                // open system, −1 camera-coupled, 0 frozen. Its bounds belong
                // to the layer the rate acts on.
                systime: number('systime', window.SystemLayer.SYSTEM_TIME_RATE_DEFAULT),
                // The delta-v map (§7.4, §7.5): the share of the engine a leg
                // may burn and the ship class it is read against. Both are
                // view settings, and their bounds belong to DeltaVLib.
                budget: number('budget', window.DeltaVLib.BUDGET_DEFAULT),
                ship: text('ship', window.DeltaVLib.SHIP_DEFAULT),
        };
}

async function boot() {
        const canvas = document.getElementById('canvas');
        const overlay = document.getElementById('overlay');
        const errorBox = document.getElementById('error');
        const params = readParams();
        const galaxy = window.GalaxyLib;
        // One descriptor for the whole galaxy: the density field, the star buffer, the
        // camera frame and the overlay's label all read this object, so switching
        // galaxies builds a new one and hands it round instead of poking four modules.
        let model = galaxy.createGalaxy({ type: params.type, seed: params.seed, age: params.age });
        // 0.4 global stellar clock. It is f64 on the CPU and exported as one
        // f32 uniform only after the documented epoch wrap.
        let starTimeMyr = 0;
	let starTimeRate = 5;
	let lastNonZeroTimeRate = starTimeRate;
        // ?time= / ?wave= speak the same language as the preset strings
        // (Presets), and their defaults are the startup values above.
        starTimeRate = params.time;
        if (starTimeRate > 0) lastNonZeroTimeRate = starTimeRate;
        // View control, not a model field. 0.6 is the measured hold (Sun ring
        // cosine 0.10 → ~0.6 in 300 Myr). 0 is the 0.4.3 shear.
        let waveDamping = window.OrbitLib.setWaveDamping(params.wave);
        // View control, not a model field: the derived Omega_p of whatever
        // model is loaded, times this. 1 is the model's own group speed.
        let patternScale = window.OrbitLib.setPatternScale(params.pattern, starTimeMyr, model);
        const STAR_TIME_WRAP = 0x800000;

        function showError(message) {
                errorBox.textContent = message;
                errorBox.style.display = 'block';
        }

        function resizeCanvas() {
                const dpr = currentDpr();
                const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
                const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
                if (canvas.width !== width || canvas.height !== height) {
                        canvas.width = width;
                        canvas.height = height;
                }
        }
        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);

        let device, context, format, hdr;
        try {
                ({ device, context, format, hdr } = await window.Device.initDevice(canvas));
        } catch (err) {
                showError('WebGPU init failed: ' + err.message);
                return;
        }
        window.Device.onLost = (info) => showError(`GPU device lost (${info.reason}): ${info.message}`);

        const camera = window.Camera.createCamera();
        camera.setFrame(model);   // the Milky Way preset's Sun view, or the type's own home
	camera.setMode(window.Camera.MODE_ORBIT_GC);
        const input = window.Input.createInput(canvas);
	input.setFlyMode(false);

        const landmarks = window.Landmarks;
        const labels = window.LabelLayer.createLabelLayer(
                document.getElementById('labels'), landmarks, window.Constellations);

        // The close-system schematic (0.5.3): a second 2D overlay over the
        // WebGPU canvas, drawn only while the system view is open. main.js
        // generates the primary's system on enter and hands the record to the
        // layer; the layer owns the canvas, the open state and nothing else.
        const systemCanvas = document.getElementById('system');
        const systemLayer = window.SystemLayer.createSystemLayer(systemCanvas);

        const selection = window.Selection.createSelection(camera, landmarks);

        // The renderer works out its own parity target (the global field plus whatever
        // catalog budget the model allows), because how much catalog a galaxy has is the
        // model's answer, not the URL's.
        const renderer = window.StarRenderer.createStarRenderer(device, context, format, {
                proceduralStars: params.stars,
                catalogBudgetStars: params.catalogStars,
                model,
                hdr,
        });

        // Catalog is optional: without it the procedural field still renders.
        let manifest = null;
        try {
                manifest = await window.TileLoader.loadCatalog('data/tiles/catalog.js');
        } catch (err) {
                console.warn('Catalog tiles unavailable, running procedural-only:', err.message);
        }

        try {
                renderer.prepare(manifest);
        } catch (err) {
                showError('Renderer setup failed: ' + err.message);
                return;
        }
        if (params.exposure !== null) renderer.setExposure(params.exposure);
        // The rest of the menu as boot params — the language the preset
        // strings share. Defaults are no-ops, so applying them directly is
        // the same as absent.
        renderer.setLinearExposure(params.brightness);
        renderer.setWhitePoint(params.white);
        renderer.setSaturation(params.sat);
        renderer.setHeadroom(params.headroom);
        renderer.setHighlightDesat(params.highlight);

        // --- Star selection (0.5.0) -----------------------------------------
        // Pick any drawn star (not just the named table), keep a primary plus a
        // multi-select set, select around a world-space radius, and fly to the
        // primary. The set holds identity keys, never buffer slots: the local
        // gap-fill and catalog blocks are rewritten on every residency change,
        // so a stored slot would silently become another star as the viewer
        // flies. Both accessors are callbacks for the same reason.
        const selectionBox = document.getElementById('selection');
        const starSet = window.StarSet.createStarSet();
        selection.setRecordBlocks(() => renderer.starBlocks());
        labels.setRecordSource(() => renderer.starBlocks());

        // Preallocated: the pick result, the primary's resolved position and
        // the selection readout never allocate per click or per overlay tick.
        const pickHit = { key: 0, blockKind: '', index: -1, x: 0, y: 0, z: 0, packed: 0, dist2: 0 };
        const primaryPos = new Float64Array(3);
        let selPrimary = '';          // designation: the landmark name, or S<key36>
        let selPrimaryDetail = '';    // class and absolute magnitude, as picked
        let selApproximated = false;  // the pick fell back to the classic baseline (simple mask)
        let selectRadiusLy = params.selrad;

        // The named table's own name when a buffer slot is one of its records,
        // null otherwise. The landmark block's slot range is fixed, so the
        // block a slot sits in says which it is — the hash is not inverted.
        function landmarkNameAtSlot(slot) {
                const landmark = renderer.starBlocks().blocks[1];
                if (slot < landmark.offset || slot >= landmark.offset + landmark.count) return null;
                return landmarks.ENTRIES[slot - landmark.offset].name;
        }

        // A picked star's name: the named table when the record came from the
        // landmark block, the §4.11 designation otherwise.
        function starDisplayName(key, slot) {
                return landmarkNameAtSlot(slot) || window.StarSet.keyDesignation(key);
        }

        // Which of the five record blocks a buffer slot sits in, as the
        // BLOCK_* index planets.js dispatches stellar inputs on. The slot
        // ranges are the renderer's own layout.
        function blockIndexOfSlot(slot) {
                const table = renderer.starBlocks().blocks;
                for (let i = 0; i < table.length; i++) {
                        if (slot >= table[i].offset && slot < table[i].offset + table[i].count) return i;
                }
                return -1;
        }

        function classAndMag(packed) {
                const cls = window.StarRecord.SPECTRAL_CLASSES[packed & 0xFF];
                return `${cls}  M ${window.StarRecord.decodeAbsMag((packed >>> 8) & 255).toFixed(1)}`;
        }

        // The key's slot, name and packed word in one pass over the identity
        // array; (0, '', 0) when the star is not resident right now.
        function starSummary(key) {
                const slot = selection.resolveSlot(key);
                if (slot < 0) return { slot: -1, name: window.StarSet.keyDesignation(key), packed: 0 };
                return { slot, name: starDisplayName(key, slot), packed: selection.recordWordAt(slot) };
        }

        function syncSelection() {
                labels.setSelectedKeys(starSet.keys, starSet.count());
                updateSelectionBox();
        }

        function setPrimaryHit(hit) {
                selPrimary = starDisplayName(hit.key, hit.index);
                selPrimaryDetail = classAndMag(hit.packed);
                primaryPos[0] = hit.x;
                primaryPos[1] = hit.y;
                primaryPos[2] = hit.z;
                syncSystemViewToPrimary();
        }

        // Distance from the camera, kpc: the set's nearest-first order is the
        // viewer's, so an added star sits where it looks like it should.
        function cameraDistance(pos) {
                const cam = camera.cameraPos;
                return Math.hypot(pos[0] - cam[0], pos[1] - cam[1], pos[2] - cam[2]);
        }

        function selectPickedStar(hit, toggle) {
                const blocks = renderer.starBlocks();
                selApproximated = window.OrbitLib.recordPositionApproximated();
                if (toggle) {
                        starSet.toggleStar(hit.key, cameraDistance(hit));
                        // Removing the primary promotes the nearest member;
                        // an emptied set drops the primary with it.
                        if (starSet.count() === 0) {
                                selPrimary = '';
                                selPrimaryDetail = '';
                        } else if (!starSet.hasStar(hit.key) || selPrimary === '') {
                                setPrimaryKey(starSet.keyAt(starSet.nearestSetStar()));
                        }
                } else {
                        starSet.setStar(hit.key, cameraDistance(hit));
                        setPrimaryHit(hit);
                }
                labels.setSelected(hit.blockKind === 'landmark' && !toggle
                        ? hit.index - blocks.blocks[1].offset : -1);
                syncSelection();
        }

        function setPrimaryKey(key) {
                const summary = starSummary(key);
                selPrimary = summary.name;
                selPrimaryDetail = summary.packed ? classAndMag(summary.packed) : '';
                if (summary.slot >= 0) selection.recordPositionAt(summary.slot, primaryPos);
                syncSystemViewToPrimary();
        }

        function flyToPrimary() {
                const key = starSet.primary();
                if (key === 0) return;
                const slot = selection.resolveSlot(key);
                if (slot < 0 || !selection.recordPositionAt(slot, primaryPos)) return;
                const packed = selection.recordWordAt(slot);
                const absMag = packed ? window.StarRecord.decodeAbsMag((packed >>> 8) & 255) : 4.83;
                selApproximated = window.OrbitLib.recordPositionApproximated();
                camera.flyToStar(primaryPos[0], primaryPos[1], primaryPos[2], absMag,
                        { name: selPrimary || starDisplayName(key, slot) });
                updateSelectionBox();
        }

        function cyclePrimary(step) {
                if (starSet.count() < 2) return;
                starSet.setPrimary(starSet.keyAt(step >= 0 ? 1 : starSet.count() - 1));
                setPrimaryKey(starSet.primary());
                syncSelection();
        }

        function clearSelection() {
                starSet.clearSet();
                selPrimary = '';
                selPrimaryDetail = '';
                selApproximated = false;
                labels.setSelected(-1);
                // The schematic's star was selected away: the view closes with
                // the selection rather than freezing the last system on screen.
                closeSystemView();
                syncSelection();
        }

        // One pass over the resident records, collecting everything inside
        // `selectRadiusLy` of the primary — world-space, so a neighbourhood
        // means the same thing at every distance (plan §3.3). The primary is
        // re-set at slot 0 afterwards, so a lone star keeps a non-empty set.
        function selectAroundPrimary() {
                const key = starSet.primary();
                if (key === 0) return;
                const slot = selection.resolveSlot(key);
                if (slot < 0 || !selection.recordPositionAt(slot, primaryPos)) return;
                const found = selection.selectAround(primaryPos[0], primaryPos[1], primaryPos[2],
                        selectRadiusLy * window.Camera.LY_TO_KPC);
                starSet.clearSet();
                for (let i = 0; i < found.count; i++) starSet.addStar(found.keys[i], found.dists[i]);
                starSet.setPrimary(key);
                syncSelection();
        }

        function updateSelectionBox() {
                if (!selPrimary || starSet.count() === 0) {
                        selectionBox.style.display = 'none';
                        return;
                }
                const count = starSet.count();
                const approx = selApproximated
                        ? '   (position approximated: simple engine keeps star θ on the GPU)'
                        : '';
                const primary = count === 1
                        ? `selected  ${selPrimary}   ${selPrimaryDetail}${approx}`
                        : `selected  ${selPrimary}   ${selPrimaryDetail}   [primary of ${count}]${approx}`;
                const set = count === 1
                        ? 'set       1 star   Shift+click adds · F fly to · X clear'
                        : `set       ${count} stars within ${formatLy(selectRadiusLy)} of ${selPrimary} · N next · F fly to · X clear`;
                selectionBox.textContent = primary + '\n' + set;
                selectionBox.style.display = 'block';
                // Both readouts share the bottom-left corner: the search
                // results sit below the selection, so the selection lifts
                // above them while they are on screen.
                selectionBox.style.bottom = sysreadBox.style.display === 'none'
                        ? '' : `${24 + sysreadBox.offsetHeight}px`;
        }

        // 0.4.5 simple engine: the CPU landmark mirror's birth table, static
        // for the session (named stars are Milky Way data). Re-initialised
        // from these positions on regenerate, engine switch and R.
        const landmarkPos = new Float32Array(landmarks.count * 3);
        const landmarkColors = new Uint8Array(landmarks.count);
        for (let i = 0; i < landmarks.count; i++) {
                landmarkPos[i * 3] = landmarks.ENTRIES[i].x;
                landmarkPos[i * 3 + 1] = landmarks.ENTRIES[i].y;
                landmarkPos[i * 3 + 2] = landmarks.ENTRIES[i].z;
                landmarkColors[i] = landmarks.ENTRIES[i].colorIndex;
        }
        function initSimpleLandmarks() {
                window.OrbitLib.simpleLandmarksInit(landmarkPos, landmarkColors, landmarks.count, model);
        }
        renderer.setEngine(window.Presets.parseEngineList(params.engine));
        initSimpleLandmarks();

        // --- Settings menu (Tab to toggle) -----------------------------------
        const menu = document.getElementById('menu');
        const menuClose = document.getElementById('menu-close');
        const sliderExp = document.getElementById('slider-exposure');
        const sliderBright = document.getElementById('slider-brightness');
        const sliderWhite = document.getElementById('slider-white');
        const sliderSat = document.getElementById('slider-saturation');
        const sliderHeadroom = document.getElementById('slider-headroom');
        const sliderHighlight = document.getElementById('slider-highlight');
        const sliderStarTime = document.getElementById('slider-star-time');
        const sliderWave = document.getElementById('slider-wave');
        const sliderPattern = document.getElementById('slider-pattern');
        const engineClassic = document.getElementById('engine-classic');
        const engineSimple = document.getElementById('engine-simple');
        const engineApocenter = document.getElementById('engine-apocenter');
        const sliderApoShare = document.getElementById('slider-apocenter-share');
        const sliderApoForce = document.getElementById('slider-apocenter-force');
        const valExp = document.getElementById('val-exposure');
        const valBright = document.getElementById('val-brightness');
        const valWhite = document.getElementById('val-white');
        const valSat = document.getElementById('val-saturation');
        const valHeadroom = document.getElementById('val-headroom');
        const valHighlight = document.getElementById('val-highlight');
        const valStarTime = document.getElementById('val-star-time');
        const valWave = document.getElementById('val-wave');
        const valPattern = document.getElementById('val-pattern');
        const valEngine = document.getElementById('val-engine');
        const btnDefaults = document.getElementById('menu-defaults');
        const sliderSelrad = document.getElementById('slider-selrad');
        const valSelrad = document.getElementById('val-selrad');
        const btnSelectAround = document.getElementById('select-around');
        const btnSelectFly = document.getElementById('select-fly');
        const btnSelectClear = document.getElementById('select-clear');

        // Log10 select radius: 0.1 … 100 000 ly is two decades and a half of
        // slider travel either way, and the physical neighbourhoods that matter
        // (a few hundred stars, a whole arm) sit at both ends. The mapping
        // lives in Selection beside the constants.
        function syncSelrad() {
                sliderSelrad.value = window.Selection.sliderFromRadius(selectRadiusLy);
                valSelrad.textContent = formatLy(selectRadiusLy);
        }
        sliderSelrad.addEventListener('input', () => {
                selectRadiusLy = window.Selection.radiusFromSlider(Number(sliderSelrad.value));
                syncSelrad();
        });
        btnSelectAround.addEventListener('click', selectAroundPrimary);
        btnSelectFly.addEventListener('click', flyToPrimary);
        btnSelectClear.addEventListener('click', clearSelection);
        syncSelrad();

        // --- Star and planet search (0.5.2) ----------------------------------
        // One scan over the resident records: stage 1 filters on the record
        // bytes and the star's own derivation, stage 2 runs the planet
        // generator's summary tier on the survivors. The scope is the
        // selection whenever it holds anything and the whole galaxy otherwise
        // (§5.2), and the readout says which one ran, so the fallback is never
        // invisible. The filter is preset state; the results are not.
        const search = window.Search.createSearch();
        search.setSource({
                blocks: () => renderer.starBlocks(),
                field: () => renderer.fieldBuffers(),
                model: () => model,
                set: starSet,
                cameraPos: () => camera.cameraPos,
        });
        let searchScope = 'auto';
        let searchFilter = window.Search.normalizeFilter({});
        const searchResults = search.results;
        const sysreadBox = document.getElementById('sysread');
        // Whether the readout currently shows the result list. The open system
        // takes the element over while the system view is open (§6.6), and the
        // list has to come back when it closes — so "was a list showing" is a
        // flag, not a re-derivation from the results.
        let searchReadoutShown = false;

        // The two class/type selects are built from the tables they index, so
        // a new class or display type appears in the menu without touching
        // this file. The class option's value is the class name and the type
        // option's value is the token name Search parses.
        const searchScopeSel = document.getElementById('search-scope');
        const searchClass = document.getElementById('search-class');
        const searchPtype = document.getElementById('search-ptype');
        const searchTsurfMin = document.getElementById('search-tsurf-min');
        const searchTsurfMax = document.getElementById('search-tsurf-max');
        const searchTerran = document.getElementById('search-terran');
        const searchBelt = document.getElementById('search-belt');
        const searchBarren = document.getElementById('search-barren');
        // Both selects start with an "any" (no constraint) option.
        const anyOption = document.createElement('option');
        anyOption.value = '';
        anyOption.textContent = 'any';
        searchClass.appendChild(anyOption);
        const anyType = document.createElement('option');
        anyType.value = '';
        anyType.textContent = 'any';
        searchPtype.appendChild(anyType);
        for (const cls of window.StarRecord.SPECTRAL_CLASSES) {
                const option = document.createElement('option');
                option.value = cls;
                option.textContent = cls;
                searchClass.appendChild(option);
        }
        for (let i = 0; i < window.PlanetsLib.DISPLAY_NAMES.length; i++) {
                const option = document.createElement('option');
                option.value = window.Search.TOKEN_TYPES[i];
                option.textContent = window.PlanetsLib.DISPLAY_NAMES[i].replace('_', ' ');
                searchPtype.appendChild(option);
        }

        // An empty number field is an unbounded side, not a zero: "Tsurf up to
        // 300 K" must not also demand at least 0 K of nothing.
        function fieldNumber(input) {
                const value = Number(input.value);
                return input.value.trim() === '' || !Number.isFinite(value) ? undefined : value;
        }

        function readSearchFilter() {
                const classIndex = searchClass.value === '' ? -1
                        : window.StarRecord.spectralClassIndex(searchClass.value);
                const typeIndex = searchPtype.value === '' ? -1
                        : window.Search.TOKEN_TYPES.indexOf(searchPtype.value);
                return window.Search.normalizeFilter({
                        classes: classIndex >= 0 ? window.Search.classBit(classIndex) : 0,
                        planetTypes: typeIndex >= 0 ? window.Search.planetTypeBit(typeIndex) : 0,
                        tsurfMin: fieldNumber(searchTsurfMin),
                        tsurfMax: fieldNumber(searchTsurfMax),
                        terranOnly: searchTerran.checked,
                        needsBelt: searchBelt.checked,
                        barrenOnly: searchBarren.checked,
                });
        }

        // A pasted preset restores the whole filter, including the fields the
        // menu does not expose: the controls show what they can, and the
        // canonical filter keeps the rest for the next serialize.
        function writeSearchControls(filter) {
                const classes = [], types = [];
                for (let i = 0; i < window.StarRecord.SPECTRAL_CLASSES.length; i++) {
                        if ((filter.classMask >>> i) & 1) classes.push(window.StarRecord.SPECTRAL_CLASSES[i]);
                        if ((filter.planetTypeMask >>> i) & 1) types.push(window.Search.TOKEN_TYPES[i]);
                }
                searchClass.value = classes.length === 1 ? classes[0] : '';
                searchPtype.value = types.length === 1 ? types[0] : '';
                searchTsurfMin.value = filter.tsurfMin > 0 ? String(filter.tsurfMin) : '';
                searchTsurfMax.value = filter.tsurfMax < Infinity ? String(filter.tsurfMax) : '';
                searchTerran.checked = filter.terranOnly;
                searchBelt.checked = filter.needsBelt;
                searchBarren.checked = filter.barrenOnly;
        }

        // The result list, top twelve lines (§5.4): designation, class,
        // distance, matched planet, Tsurf. The selection box sits below it, so
        // the readout's height pushes it up while both are visible. While a
        // system is open the system readout owns the element instead (§6.6).
        function updateSysread() {
                if (systemViewOpen) return;
                const s = search.stats;
                const scopeName = s.scope === 'selection' ? 'selected stars' : 'galaxy';
                const ms = (s.msStage1 + s.msStage2).toFixed(1);
                let text = `search   ${scopeName}   scanned ${s.scanned.toLocaleString()}`
                        + `   matched ${s.matched.toLocaleString()}`
                        + (s.truncated ? `   nearest ${searchResults.count} shown` : '')
                        + `   ${ms} ms\n`;
                const shown = Math.min(searchResults.count, 12);
                for (let i = 0; i < shown; i++) {
                        const o = i * 4;
                        const type = searchResults.best[o + 3];
                        const planet = type > 0
                                ? `${window.PlanetsLib.DISPLAY_NAMES[type]}  a ${searchResults.best[o].toFixed(2)} AU  ${searchResults.best[o + 2].toFixed(0)} K`
                                : '—';
                        text += `${starDisplayName(searchResults.keys[i], searchResults.slot[i]).padEnd(10)}`
                                + `${window.StarRecord.SPECTRAL_CLASSES[searchResults.class[i]].padEnd(4)}`
                                + `${formatDistance(searchResults.dist[i]).padStart(12)}   ${planet}\n`;
                }
                sysreadBox.textContent = text;
                sysreadBox.style.display = 'block';
                searchReadoutShown = true;
                updateSelectionBox();
        }

        function clearSearchReadout() {
                if (systemViewOpen) return;
                sysreadBox.style.display = 'none';
                sysreadBox.textContent = '';
                searchReadoutShown = false;
                updateSelectionBox();
        }

        function runSearch() {
                searchFilter = readSearchFilter();
                searchScope = ['auto', 'selection', 'galaxy'].includes(searchScopeSel.value)
                        ? searchScopeSel.value : 'auto';
                search.run(searchFilter, searchScope);
                updateSysread();
        }

        // Every control re-runs the scan on commit: the readout is the answer
        // to what the menu currently says, and a half-edited filter is never
        // what the preset line carries.
        for (const control of [searchScopeSel, searchClass, searchPtype, searchTsurfMin,
                searchTsurfMax, searchTerran, searchBelt, searchBarren]) {
                control.addEventListener('change', runSearch);
        }
        document.getElementById('search-run').addEventListener('click', runSearch);
        document.getElementById('search-add').addEventListener('click', () => {
                // The same capacity and nearest-first rules as §3.2: a search
                // becomes a working set for a route in one click, and the
                // primary stays where it was unless the set was empty.
                const hadPrimary = starSet.count() > 0;
                const primaryKey = starSet.primary();
                for (let i = 0; i < searchResults.count; i++) {
                        starSet.addStar(searchResults.keys[i], searchResults.dist[i]);
                }
                if (!hadPrimary && starSet.count() > 0) setPrimaryKey(starSet.primary());
                else if (hadPrimary) starSet.setPrimary(primaryKey);
                syncSelection();
        });
        document.getElementById('search-clear').addEventListener('click', clearSearchReadout);

        // --- The system view (0.5.3) ------------------------------------------
        // Open the primary star as a schematic: generate its system (§4.9),
        // hand the record to the layer, point the camera at the star, and let
        // #sysread become the open system's readout. A system is a pure
        // function of the primary's identity key, so entering the view costs
        // one generateSystem and no cache — closing and reopening the same
        // star produces byte-identical records, and a star that leaves the
        // residency set simply stops being describable.
        const systemRef = {
                key: 0, block: 0, slot: -1, x: 0, y: 0, z: 0,
                model: null, field: null, colorIndex: 0, absMag: 0, name: undefined,
        };
        // Preallocated once: the stellar snapshot, the record and the derived
        // ref are mutated in place, never rebuilt per entry.
        const systemStar = window.PlanetsLib.createStellarInputs();
        const systemRecord = window.PlanetsLib.createSystemRecord();
        let systemViewOpen = false;
        // §6.4's clock rate for the open system, in years per second: the menu
        // slider's value, clamped to the layer's own range so a hand-edited URL
        // or pasted preset names a rate that exists.
        function clampSystemRate(value) {
                return Math.min(window.SystemLayer.SYSTEM_TIME_RATE_MAX,
                        Math.max(window.SystemLayer.SYSTEM_TIME_RATE_MIN, value));
        }
        let systemTimeRate = clampSystemRate(params.systime);
        // §7.4's budget and §8.1's ship class: view settings, clamped at the
        // edge against DeltaVLib so a pasted preset or a URL names values that
        // exist. The one body pair and leg struct the dv block fills are
        // preallocated with the rest of the system-view state.
        function clampBudget(value) {
                if (!Number.isFinite(value)) return window.DeltaVLib.BUDGET_DEFAULT;
                return Math.min(window.DeltaVLib.BUDGET_MAX, Math.max(window.DeltaVLib.BUDGET_MIN, value));
        }
        function clampShip(name) {
                return window.DeltaVLib.shipIndex(name);
        }
        let dvMapOpen = false;
        let dvBudget = clampBudget(params.budget);
        let dvShip = clampShip(params.ship);
        const dvFrom = window.DeltaVLib.createBody();
        const dvTo = window.DeltaVLib.createBody();
        const dvLegOut = window.DeltaVLib.createLeg();
        // §6.5: closer than a parsec, the camera already frames the star, so
        // entering the view only turns it; farther, it flies in.
        const SYSTEM_LOCK_FAR_KPC = 0.001;

        // The primary's system, regenerated in place. False when there is no
        // primary or it is not resident right now.
        function generatePrimarySystem() {
                const key = starSet.primary();
                const slot = key === 0 ? -1 : selection.resolveSlot(key);
                if (slot < 0 || !selection.recordPositionAt(slot, primaryPos)) return false;
                const packed = selection.recordWordAt(slot);
                systemRef.key = key;
                systemRef.block = blockIndexOfSlot(slot);
                systemRef.slot = slot;
                systemRef.x = primaryPos[0];
                systemRef.y = primaryPos[1];
                systemRef.z = primaryPos[2];
                systemRef.model = model;
                systemRef.field = renderer.fieldBuffers();
                systemRef.colorIndex = packed & 0xFF;
                systemRef.absMag = window.StarRecord.decodeAbsMag((packed >>> 8) & 255);
                // The landmark's own name when it has one; undefined otherwise,
                // so the record's designation stays the S<key36> form (§4.11).
                systemRef.name = landmarkNameAtSlot(slot) || undefined;
                window.PlanetsLib.stellarInputs(systemRef, systemStar);
                window.PlanetsLib.generateSystem(systemRef, systemStar, systemRecord);
                systemLayer.setSystem(systemRecord);
                return true;
        }

        // The view tracks the primary (§6.5): a new primary regenerates the
        // schematic, and one that is no longer resident closes the view.
        function syncSystemViewToPrimary() {
                if (!systemViewOpen) return;
                if (generatePrimarySystem()) updateSystemReadout();
                else closeSystemView();
        }

        function openSystemView() {
                if (systemViewOpen || !generatePrimarySystem()) return;
                systemViewOpen = true;
                systemLayer.setEnabled(true);
                systemCanvas.style.display = 'block';
                // §6.5: the schematic's star is what the camera looks at. In
                // orbit object the fly translation keys are already orbit
                // keys, so the view cannot be flown away from underneath.
                const cam = camera.cameraPos;
                const far = Math.hypot(primaryPos[0] - cam[0], primaryPos[1] - cam[1],
                        primaryPos[2] - cam[2]) > SYSTEM_LOCK_FAR_KPC;
                const name = selPrimary || 'selected star';
                if (far) {
                        camera.flyToStar(primaryPos[0], primaryPos[1], primaryPos[2],
                                systemRef.absMag, { name });
                } else {
                        camera.setOrbitTarget(primaryPos[0], primaryPos[1], primaryPos[2], name);
                        camera.setMode(window.Camera.MODE_ORBIT_OBJECT);
                }
                syncViewRows();
                updateSystemReadout();
        }

        function closeSystemView() {
                const wasOpen = systemViewOpen;
                systemViewOpen = false;
                // A canvas keeps its last frame: the layer erases it and the
                // element is hidden beside it. The camera keeps its target.
                systemLayer.setEnabled(false);
                systemCanvas.style.display = 'none';
                // The map is a view over the schematic: closing the view
                // closes it too, so a reopening starts from the schematic.
                setDvMap(false);
                syncViewRows();
                if (!wasOpen) return;
                // The readout returns to what it held before the view opened:
                // the search result list, or nothing.
                if (searchReadoutShown) updateSysread();
                else clearSearchReadout();
        }

        function toggleSystemView() {
                if (systemViewOpen) closeSystemView();
                else openSystemView();
        }

        // The open system's readout (§6.6): the star block, the geometry line,
        // one line per planet in outward order, then the belts, then §7.5's
        // dv block while the map is open. Text at the overlay's 4 Hz cadence,
        // never per frame; the body selected in the schematic carries the marker.
        function updateSystemReadout() {
                if (!systemViewOpen) return;
                const P = window.PlanetsLib;
                const star = systemRecord.star;
                const planets = systemRecord.planetCount, belts = systemRecord.beltCount;
                const selected = systemLayer.selectedBody();
                sysreadBox.textContent =
                        pad(window.PlanetsLib.starDesignation(systemRecord), 10)
                        + pad(window.StarRecord.SPECTRAL_CLASSES[star.colorIndex], 3)
                        + `${star.mass.toFixed(2)} M☉  ${star.lum.toFixed(3)} L☉  `
                        + `${Math.round(star.teff)} K  ${star.rStar.toFixed(2)} R☉  `
                        + `age ${star.age.toFixed(1)} Gyr  Z ${star.metal.toFixed(3)}\n`
                        + `HZ ${formatAu(star.aHzIn)} – ${formatAu(star.aHzOut)} AU   `
                        + `snow ${formatAu(star.aSnow)} AU   a_out ${formatAu(star.aOut)} AU   `
                        + `system time ${formatSystemTime(systemTimeRate)}   `
                        + `${planets} planet${planets === 1 ? '' : 's'}, `
                        + `${belts} belt${belts === 1 ? '' : 's'}\n`;
                const rows = systemRecord.planets;
                for (let p = 0; p < planets; p++) {
                        sysreadBox.textContent += planetLine(P, rows, p,
                                selected.which === window.SystemLayer.BODY_PLANET && selected.index === p);
                }
                for (let b = 0; b < belts; b++) {
                        sysreadBox.textContent += beltLine(systemRecord, b,
                                selected.which === window.SystemLayer.BODY_BELT && selected.index === b);
                }
                if (dvMapOpen) sysreadBox.textContent += deltaVBlock();
                sysreadBox.style.display = 'block';
                updateSelectionBox();
        }

        // One planet row of §6.6: letter and display type, orbit, mass, radius,
        // insolation, temperatures, eccentricity, period, moons and flags. The
        // example's columns are the contract — the readout is the checkable
        // output of §4, not decoration.
        function planetLine(P, rows, p, selected) {
                const mass = rows.mass[p];
                let text = `  ${P.PLANET_LETTERS[p]}  ${P.DISPLAY_NAMES[rows.display[p]].padEnd(12)}`
                        + `${rows.a[p].toFixed(2).padStart(7)} AU`
                        + `${(mass >= 0.01 ? mass.toFixed(2) : mass.toExponential(1)).padStart(8)} M⊕`
                        + `${rows.radius[p].toFixed(2).padStart(8)} R⊕`
                        + `   S ${Number(rows.insolation[p].toPrecision(3))}`
                        + `   Teq ${Math.round(rows.teq[p]).toString().padStart(4)} K`
                        + `  Tsurf ${Math.round(rows.tsurf[p]).toString().padStart(4)} K`
                        + `  e ${rows.ecc[p].toFixed(2)}`
                        + `  P ${Number(rows.period[p].toPrecision(4)).toString().padStart(6)} y`;
                const moons = rows.moons[p];
                if (moons > 0) text += `  ${moons} moon${moons === 1 ? '' : 's'}`;
                const flags = rows.flags[p];
                if (flags & P.FLAG_LOCKED) text += '  locked';
                if (flags & P.FLAG_RUNAWAY) text += '  runaway';
                if (flags & P.FLAG_TERRAN) text += '  HZ terran';
                return text + (selected ? '  ◀ selected' : '') + '\n';
        }

        // One belt row of §6.6: axis, width in ln a, total mass and the §4.7
        // typical body every belt in the galaxy shares.
        function beltLine(record, b, selected) {
                return `belt ${b + 1}   ${record.belts.a[b].toFixed(2)} AU`
                        + `   Δln a ${record.belts.dlnA[b].toFixed(2)}`
                        + `   mass ${record.belts.mass[b].toExponential(1)} M⊕`
                        + `   typical body ${(window.PlanetsLib.BELT_TYPICAL_R_M / 1000).toFixed(0)} km`
                        + ` / ${window.PlanetsLib.BELT_TYPICAL_MASS_KG.toExponential(1)} kg`
                        + (selected ? '  ◀ selected' : '') + '\n';
        }

        // §7.5's table in §6.6's place: one row per node pair from the
        // selected body's low orbit — its own legs first, then the transfer to
        // each other body — with the dv, the minimum-energy time, the time at
        // the current budget, and what the ship makes of it. The origin is the
        // schematic's selected body, or the innermost planet when none is.
        function deltaVBlock() {
                const V = window.DeltaVLib;
                const planets = systemRecord.planetCount;
                const total = planets + systemRecord.beltCount;
                if (total < 1) return '';
                const sel = systemLayer.selectedBody();
                let origin = sel.which === window.SystemLayer.BODY_PLANET ? sel.index
                        : (sel.which === window.SystemLayer.BODY_BELT ? planets + sel.index : 0);
                if (origin < 0 || origin >= total) origin = 0;
                const ship = V.SHIP_CLASSES[dvShip];
                dvColumnTo(dvFrom, origin);
                let text = `\ndv  ${dvName(origin)}   budget ${Math.round(dvBudget * 100)}% ${ship.name}`
                        + `   tank ${ship.dv} km/s, accel ${ship.accel} m/s²\n`
                        + '  ' + pad('leg', 26) + pad('dv km/s', 10) + pad('t@0', 8)
                        + pad('t@budget', 11) + 'ship\n';
                // The origin's own legs, outward from its low orbit.
                const ownRows = [V.NODE_LOW_ORBIT, V.NODE_GEO, V.NODE_L5, V.NODE_ESCAPE];
                for (const node of ownRows) {
                        const dv = V.nodeLegDv(dvFrom, node);
                        if (dv < 0) continue;
                        const t = V.nodeLegTimeYr(dvFrom, node);
                        text += `  ${pad(node === V.NODE_LOW_ORBIT ? 'ground → LEO' : 'LEO → ' + V.NODE_SHORT[nodeSlotOf(node)], 24)}`
                                + `${pad(dv.toFixed(2), 10)}`
                                + `${pad(t > 0 ? `${(t * 365.25).toFixed(0)} d` : '', 8)}\n`;
                }
                // The transfer to every other body, low orbit to low orbit and
                // surface to surface where both bodies have a ground node.
                for (let q = 0; q < total; q++) {
                        if (q === origin) continue;
                        dvColumnTo(dvTo, q);
                        const grounded = (dvFrom.nodes & (V.NODE_SURFACE | V.NODE_BELT_BODY))
                                && (dvTo.nodes & (V.NODE_SURFACE | V.NODE_BELT_BODY));
                        const rows = grounded ? [V.NODE_LOW_ORBIT, V.groundNode(dvFrom)] : [V.NODE_LOW_ORBIT];
                        for (const fromNode of rows) {
                                const toNode = fromNode === V.NODE_LOW_ORBIT ? V.NODE_LOW_ORBIT : V.groundNode(dvTo);
                                V.legBetween(dvLegOut, dvFrom, fromNode, dvTo, toNode);
                                // A leg the tank cannot buy has no time at the
                                // budget: the row says so instead of repeating
                                // t_H as though the ship were going.
                                const over = dvMinOverTank(dvLegOut.dvMin, ship);
                                text += `  ${pad(`${dvShort(origin)} → ${dvShort(q)}  ${V.NODE_SHORT[nodeSlotOf(fromNode)]}→${V.NODE_SHORT[nodeSlotOf(toNode)]}`, 26)}`
                                        + `${pad(dvLegOut.dv.toFixed(2), 10)}`
                                        + `${pad(`${(dvLegOut.tHYr * 365.25).toFixed(0)} d`, 8)}`
                                        + `${pad(over ? '' : `${flightDays(dvLegOut).toFixed(0)} d`, 11)}`
                                        + `${feasibility(dvLegOut, ship)}\n`;
                        }
                }
                return text;
        }

        // The travel time of one leg at the viewer's own budget and ship.
        function flightDays(leg) {
                const V = window.DeltaVLib;
                const ship = V.SHIP_CLASSES[dvShip];
                const tHS = leg.tHYr * 365.25 * 86400;
                const ceiling = V.dvCeilingKms(ship, leg.arcM);
                const dvLeg = V.dvLegKms(leg.dvMin, ceiling, dvBudget);
                return V.legTimeS(dvLeg, leg.dvMin, leg.arcM, tHS) / 86400;
        }

        // What the current ship makes of one leg, in the model's own words:
        // the crossover dv_x, the tank, and the blend between them.
        function feasibility(leg, ship) {
                const V = window.DeltaVLib;
                const tHS = leg.tHYr * 365.25 * 86400;
                const ceiling = V.dvCeilingKms(ship, leg.arcM);
                const dvLeg = V.dvLegKms(leg.dvMin, ceiling, dvBudget);
                if (dvMinOverTank(leg.dvMin, ship)) return 'over the tank';
                const dvX = ((4 * leg.arcM) / tHS) / 1000;
                const blend = V.blendFactor(dvLeg, leg.dvMin, leg.arcM, tHS);
                if (blend <= 0) return `below dv_x ${dvX.toFixed(0)}`;
                if (blend >= 1) return `brachistochrone over dv_x ${dvX.toFixed(0)}`;
                return `blend ${blend.toFixed(2)} at dv_x ${dvX.toFixed(0)}`;
        }

        function dvMinOverTank(dvMin, ship) {
                return dvMin > ship.dv + 1e-9;
        }

        // §7.1's six nodes as row-label text, without the ground/belt pair that
        // a body carries one of.
        function nodeSlotOf(node) {
                const V = window.DeltaVLib;
                if (node === V.NODE_SURFACE || node === V.NODE_BELT_BODY) return 0;
                if (node === V.NODE_LOW_ORBIT) return 1;
                if (node === V.NODE_GEO) return 2;
                if (node === V.NODE_L5) return 3;
                return 4;
        }

        // The map's column order, shared with the layer's graph: planets in
        // outward order, then the belts.
        function dvColumnTo(out, column) {
                const planets = systemRecord.planetCount;
                if (column < planets) {
                        return window.DeltaVLib.bodyFromSystem(out, systemRecord,
                                window.DeltaVLib.BODY_KIND_PLANET, column);
                }
                return window.DeltaVLib.bodyFromSystem(out, systemRecord,
                        window.DeltaVLib.BODY_KIND_BELT, column - planets);
        }

        function dvName(column) {
                const planets = systemRecord.planetCount;
                return column < planets
                        ? window.PlanetsLib.bodyDesignation(systemRecord, 1, column)
                        : window.PlanetsLib.bodyDesignation(systemRecord, 2, column - planets);
        }

        // The row label's short form: the IAU letter for a planet, "belt n" for
        // a belt. The star is named once, in the table's own header.
        function dvShort(column) {
                const planets = systemRecord.planetCount;
                return column < planets
                        ? window.PlanetsLib.PLANET_LETTERS[column]
                        : 'belt' + (column - planets + 1);
        }

        const btnSystemView = document.getElementById('system-view');
        const sliderSystime = document.getElementById('slider-systime');
        const valSystime = document.getElementById('val-systime');
        const btnDvmap = document.getElementById('dvmap-toggle');
        const sliderBudget = document.getElementById('slider-budget');
        const valBudget = document.getElementById('val-budget');
        const selectShip = document.getElementById('select-ship');
        for (const ship of window.DeltaVLib.SHIP_CLASSES) {
                const option = document.createElement('option');
                option.value = ship.name;
                option.textContent = `${ship.name} — accel ${ship.accel} m/s², dv ${ship.dv} km/s`;
                selectShip.appendChild(option);
        }
        // Rows a view owns (data-view in index.html), hidden while that view is
        // closed — the engine rows' data-engine mechanism, one level up, so a
        // control that means nothing outside its view is hidden, not disabled.
        const viewRows = Array.from(document.querySelectorAll('#menu [data-view]'));
        function syncViewRows() {
                const openView = systemViewOpen ? 'system' : '';
                for (const row of viewRows) row.style.display = row.dataset.view === openView ? '' : 'none';
        }
        btnSystemView.addEventListener('click', toggleSystemView);
        function syncSystime() {
                sliderSystime.value = systemTimeRate;
                valSystime.textContent = formatSystemTime(systemTimeRate);
        }
        sliderSystime.addEventListener('input', () => {
                systemTimeRate = Number(sliderSystime.value);
                syncSystime();
                // The geometry line names the rate, so the readout answers the
                // slider without waiting for the next overlay tick.
                updateSystemReadout();
        });
        syncSystime();

        // §7.5's map toggle and §7.4's budget/ship pair. B is the key; the
        // button is the menu's own. The map is a view over the schematic, so
        // it only opens inside the system view.
        function setDvMap(open) {
                dvMapOpen = !!open;
                systemLayer.setMapOpen(dvMapOpen);
                updateSystemReadout();
        }
        function toggleDvMap() {
                if (!systemViewOpen) return;
                setDvMap(!dvMapOpen);
        }
        btnDvmap.addEventListener('click', toggleDvMap);
        function syncBudget() {
                sliderBudget.value = dvBudget;
                valBudget.textContent = Math.round(dvBudget * 100) + '%';
        }
        sliderBudget.addEventListener('input', () => {
                dvBudget = clampBudget(Number(sliderBudget.value));
                syncBudget();
                updateSystemReadout();
        });
        function syncShip() {
                selectShip.value = window.DeltaVLib.SHIP_CLASSES[dvShip].name;
        }
        selectShip.addEventListener('change', () => {
                dvShip = clampShip(selectShip.value);
                syncShip();
                updateSystemReadout();
        });
        syncBudget();
        syncShip();
        syncViewRows();

        // Brightness slider is linear in multiplier (0.125 – 8.0), not stops,
        // so dragging it feels proportional — stops-based sliders jump at the
        // low end because small absolute changes multiply into big perceptual
        // differences.
        function syncSlidersFromRenderer() {
                sliderExp.value = renderer.state.magZero;
                valExp.textContent = renderer.state.magZero.toFixed(1);
                sliderBright.value = renderer.state.linearExposure;
                valBright.textContent = renderer.state.linearExposure.toFixed(2) + '×';
                sliderWhite.value = renderer.state.whitePoint;
                valWhite.textContent = renderer.state.whitePoint.toFixed(1);
                sliderSat.value = renderer.state.saturation;
                valSat.textContent = renderer.state.saturation.toFixed(1) + '×';
                sliderHeadroom.value = renderer.state.headroom;
                valHeadroom.textContent = renderer.state.headroom.toFixed(1);
                sliderHighlight.value = renderer.state.highlightDesat;
                valHighlight.textContent = renderer.state.highlightDesat.toFixed(2);
        }
        syncSlidersFromRenderer();

        function toggleMenu() {
                const visible = menu.style.display !== 'none';
                menu.style.display = visible ? 'none' : 'block';
		input.releaseAll();
		if (!visible && document.pointerLockElement === canvas) document.exitPointerLock();
		if (visible) canvas.focus({ preventScroll: true });
        }
        menuClose.addEventListener('click', toggleMenu);

        sliderExp.addEventListener('input', () => {
                renderer.setExposure(Number(sliderExp.value));
                valExp.textContent = renderer.state.magZero.toFixed(1);
        });
        sliderBright.addEventListener('input', () => {
                renderer.setLinearExposure(Number(sliderBright.value));
                valBright.textContent = renderer.state.linearExposure.toFixed(2) + '×';
        });
        sliderWhite.addEventListener('input', () => {
                renderer.setWhitePoint(Number(sliderWhite.value));
                valWhite.textContent = renderer.state.whitePoint.toFixed(1);
        });
        sliderSat.addEventListener('input', () => {
                renderer.setSaturation(Number(sliderSat.value));
                valSat.textContent = renderer.state.saturation.toFixed(1) + '×';
        });
        sliderHeadroom.addEventListener('input', () => {
                renderer.setHeadroom(Number(sliderHeadroom.value));
                valHeadroom.textContent = renderer.state.headroom.toFixed(1);
        });
        sliderHighlight.addEventListener('input', () => {
                renderer.setHighlightDesat(Number(sliderHighlight.value));
                valHighlight.textContent = renderer.state.highlightDesat.toFixed(2);
        });
        function syncStarTime() {
                sliderStarTime.value = starTimeRate;
                valStarTime.textContent = window.OrbitLib.formatTimeRate(starTimeRate, 0);
        }
        sliderStarTime.addEventListener('input', () => {
                starTimeRate = Number(sliderStarTime.value);
                if (starTimeRate > 0) lastNonZeroTimeRate = starTimeRate;
                syncStarTime();
        });
        syncStarTime();
        function formatWave(value) { return value === 0 ? 'off' : value.toFixed(2); }
        function syncWave() {
                sliderWave.value = waveDamping;
                valWave.textContent = formatWave(waveDamping);
        }
        sliderWave.addEventListener('input', () => {
                waveDamping = window.OrbitLib.setWaveDamping(Number(sliderWave.value));
                syncWave();
        });
        syncWave();
        // The readout is the effective rate, not the multiplier: the multiplier
        // means nothing until it is the model's own Omega_p — and for a model
        // with no pattern (S0/E/Irr) it stays 0.000 at every setting, which is
        // the honest answer to "what does this slider do here".
        function formatPattern() {
                const rate = window.OrbitLib.effectivePatternSpeed(model);
                return `${rate.toFixed(3)} ×${patternScale.toFixed(2)}`;
        }
        function syncPattern() {
                sliderPattern.value = patternScale;
                valPattern.textContent = formatPattern();
        }
        sliderPattern.addEventListener('input', () => {
                patternScale = window.OrbitLib.setPatternScale(Number(sliderPattern.value), starTimeMyr, model);
                syncPattern();
        });
        syncPattern();
        function selectedEngines() {
                const selected = [];
                if (engineClassic.checked) selected.push('classic');
                if (engineSimple.checked) selected.push('simple');
                if (engineApocenter.checked) selected.push('apocenter');
                return selected.length ? selected : ['classic'];
        }
        // Rows a movement pass owns (data-engine in index.html). They are shown
        // only while that pass is selected, and Presets drops the same fields
        // from the copied line — a knob of a pass that is not running is not
        // part of the settings.
        const engineRows = Array.from(document.querySelectorAll('#menu [data-engine]'));
        function syncEngine() {
                const active = renderer.state.engine;
                engineClassic.checked = active === 'classic' || active.includes('classic');
                engineSimple.checked = active.includes('simple');
                engineApocenter.checked = active.includes('apocenter');
                valEngine.textContent = active === 'classic' ? 'closed form' : active.trim();
                for (const row of engineRows) row.style.display = active.includes(row.dataset.engine) ? '' : 'none';
        }
        function changeEngines() {
                const selected = selectedEngines();
                renderer.setEngine(selected);
                initSimpleLandmarks();
                syncEngine();
                updateOverlay(renderer.state, camera.getState(statsText));
        }
        [engineClassic, engineSimple, engineApocenter].forEach((box) => box.addEventListener('change', changeEngines));
        sliderApoShare.addEventListener('input', () => {
                window.OrbitLib.setApocenterShare(Number(sliderApoShare.value));
                document.getElementById('val-apocenter-share').textContent = `${Math.round(Number(sliderApoShare.value) * 100)}%`;
        });
        sliderApoForce.addEventListener('input', () => {
                window.OrbitLib.setApocenterForce(Number(sliderApoForce.value));
                document.getElementById('val-apocenter-force').textContent = Number(sliderApoForce.value).toFixed(2);
        });
        sliderApoShare.value = window.OrbitLib.setApocenterShare(params.apoShare);
        sliderApoForce.value = window.OrbitLib.setApocenterForce(params.apoForce);
        document.getElementById('val-apocenter-share').textContent = `${Math.round(window.OrbitLib.getApocenterShare() * 100)}%`;
        document.getElementById('val-apocenter-force').textContent = window.OrbitLib.getApocenterForce().toFixed(2);
        syncEngine();
        function syncApocenterSliders() {
                sliderApoShare.value = window.OrbitLib.getApocenterShare();
                sliderApoForce.value = window.OrbitLib.getApocenterForce();
                document.getElementById('val-apocenter-share').textContent = `${Math.round(window.OrbitLib.getApocenterShare() * 100)}%`;
                document.getElementById('val-apocenter-force').textContent = window.OrbitLib.getApocenterForce().toFixed(2);
        }
        btnDefaults.addEventListener('click', () => {
                const d = window.Presets.menuDefaults();
                renderer.setExposure(d.exposure);
                renderer.setLinearExposure(d.brightness);
                renderer.setWhitePoint(d.white);
                renderer.setSaturation(d.sat);
                renderer.setHeadroom(d.headroom);
                renderer.setHighlightDesat(d.highlight);
                window.OrbitLib.setApocenterShare(d.apoShare);
                window.OrbitLib.setApocenterForce(d.apoForce);
                waveDamping = window.OrbitLib.setWaveDamping(d.wave);
                patternScale = window.OrbitLib.setPatternScale(d.pattern, starTimeMyr, model);
                syncApocenterSliders();
                syncSlidersFromRenderer();
                syncWave();
                syncPattern();
                syncSelrad();
                systemTimeRate = clampSystemRate(d.systime);
                syncSystime();
        });

        // --- Presets: copy/paste/save/load, and the LLM prompt ----------------
        // The whole menu as one text line (Presets owns the format). Copy puts
        // the line in the box and the clipboard; Paste reads the clipboard and
        // applies; Apply re-applies an edited box; Save/Load are a plain local
        // file; LLM prompt writes the build-this-system prompt instead.
        const presetText = document.getElementById('preset-text');
        const presetFile = document.getElementById('preset-file');
        const btnPresetCopy = document.getElementById('preset-copy');
        const btnPresetPaste = document.getElementById('preset-paste');
        const btnPresetApply = document.getElementById('preset-apply');
        const btnPresetSave = document.getElementById('preset-save');
        const btnPresetLoad = document.getElementById('preset-load');
        const btnPresetPrompt = document.getElementById('preset-prompt');

        function collectSettings() {
                return {
                        type: model.type,
                        seed: model.seed,
                        age: model.populations.age,
                        engine: selectedEngines(),
                        time: starTimeRate,
                        wave: waveDamping,
                        pattern: patternScale,
                        apoShare: window.OrbitLib.getApocenterShare(),
                        apoForce: window.OrbitLib.getApocenterForce(),
                        exposure: renderer.state.magZero,
                        brightness: renderer.state.linearExposure,
                        white: renderer.state.whitePoint,
                        sat: renderer.state.saturation,
                        headroom: renderer.state.headroom,
                        highlight: renderer.state.highlightDesat,
                        selrad: selectRadiusLy,
                        // The system view's own state (§6.4): whether the
                        // schematic is open and the rate its clock runs at —
                        // view state, like the search query, not model state.
                        sysview: systemViewOpen ? 1 : 0,
                        systime: systemTimeRate,
                        // The delta-v map's own state (§7.5): whether the map
                        // is open over the schematic, the budget it spends and
                        // the ship class that reads the budget.
                        dvmap: dvMapOpen ? 1 : 0,
                        budget: dvBudget,
                        ship: window.DeltaVLib.SHIP_CLASSES[dvShip].name,
                        // The search filter and the scope it ran in: the query
                        // is part of the settings, so a pasted preset
                        // reproduces it. The results are not — they are
                        // transient, like the camera position.
                        search: window.Search.serializeFilter(searchFilter),
                        scope: searchScope,
                        // The selection contents, primary first: the keys are
                        // stable identities, so the working set survives the
                        // copy and another viewer reproduces it.
                        selstars: starSet.count() > 0 ? [...starSet.keys.slice(0, starSet.count())] : null,
                        stars: params.stars,
                        catalog: params.catalogStars,
                };
        }

        function applyPreset(query) {
                const s = window.Presets.parse(query);
                if (!Object.keys(s).length) return;
                if (s.type !== undefined || s.seed !== undefined || s.age !== undefined) {
                        regenerateGalaxy(
                                s.type !== undefined ? s.type : model.type,
                                s.seed !== undefined ? s.seed : model.seed,
                                s.age !== undefined ? s.age : model.populations.age);
                }
                if (s.engine !== undefined) {
                        renderer.setEngine(s.engine);
                        initSimpleLandmarks();
                        syncEngine();
                }
                if (s.time !== undefined) {
                        starTimeRate = s.time;
                        if (starTimeRate > 0) lastNonZeroTimeRate = starTimeRate;
                        syncStarTime();
                }
                if (s.wave !== undefined) {
                        waveDamping = window.OrbitLib.setWaveDamping(s.wave);
                        syncWave();
                }
                if (s.pattern !== undefined) {
                        patternScale = window.OrbitLib.setPatternScale(s.pattern, starTimeMyr, model);
                        syncPattern();
                }
                if (s.apoShare !== undefined) window.OrbitLib.setApocenterShare(s.apoShare);
                if (s.apoForce !== undefined) window.OrbitLib.setApocenterForce(s.apoForce);
                if (s.apoShare !== undefined || s.apoForce !== undefined) syncApocenterSliders();
                if (s.exposure !== undefined) renderer.setExposure(s.exposure);
                if (s.brightness !== undefined) renderer.setLinearExposure(s.brightness);
                if (s.white !== undefined) renderer.setWhitePoint(s.white);
                if (s.sat !== undefined) renderer.setSaturation(s.sat);
                if (s.headroom !== undefined) renderer.setHeadroom(s.headroom);
                if (s.highlight !== undefined) renderer.setHighlightDesat(s.highlight);
                if (s.selrad !== undefined) {
                        selectRadiusLy = s.selrad;
                        syncSelrad();
                }
                // A pasted search: the filter into the controls (and the
                // canonical struct, for the fields the menu does not expose),
                // the scope into its select, then the query runs again — the
                // plan's "a pasted preset should reproduce the same query".
                if (s.search !== undefined || s.scope !== undefined) {
                        if (s.scope !== undefined) {
                                searchScope = ['auto', 'selection', 'galaxy'].includes(s.scope) ? s.scope : 'auto';
                                searchScopeSel.value = searchScope;
                        }
                        searchFilter = window.Search.parseFilter(s.search || '');
                        writeSearchControls(searchFilter);
                        runSearch();
                }
                // The pasted selection is restored in serialized order, which is
                // nearest-first with the primary at slot 0. Distances are the
                // serial order's until the next select-around re-measures them.
                if (s.selstars !== undefined) {
                        starSet.clearSet();
                        for (let i = 0; i < s.selstars.length; i++) starSet.addStar(s.selstars[i], i);
                        if (starSet.count() > 0) setPrimaryKey(starSet.primary());
                        else { selPrimary = ''; selPrimaryDetail = ''; }
                        labels.setSelected(-1);
                        syncSelection();
                }
                if (s.systime !== undefined) {
                        systemTimeRate = clampSystemRate(s.systime);
                        syncSystime();
                }
                // The map's two knobs first, then the view, then the map: the
                // budget and the ship are clamping-valid, the view is what the
                // map opens over, and a pasted dvmap=0 closes a map the same
                // line would have closed with the view.
                if (s.budget !== undefined) {
                        dvBudget = clampBudget(s.budget);
                        syncBudget();
                }
                if (s.ship !== undefined) {
                        dvShip = clampShip(s.ship);
                        syncShip();
                }
                // The view is applied last: opening needs a primary to open
                // on, and a pasted line may have just restored the selection.
                // A closed view closes — the line is what is on screen.
                if (s.sysview !== undefined) {
                        if (s.sysview) openSystemView();
                        else closeSystemView();
                }
                if (s.dvmap !== undefined) setDvMap(!!s.dvmap);
                if (systemViewOpen) updateSystemReadout();
                syncSlidersFromRenderer();
                updateOverlay(renderer.state, camera.getState(statsText));
        }

        // Clipboard with a selection fallback: not every file:// context is
        // granted the async clipboard API, and the box is visible anyway.
        function copyText(text) {
                presetText.value = text;
                if (navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(text).catch(() => {
                                presetText.focus();
                                presetText.select();
                        });
                        return;
                }
                presetText.focus();
                presetText.select();
                try { document.execCommand('copy'); } catch (err) { /* the box is the fallback */ }
        }

        function pastePreset() {
                const focusBox = () => { presetText.focus(); presetText.select(); };
                if (!(navigator.clipboard && navigator.clipboard.readText)) {
                        focusBox();
                        return;
                }
                navigator.clipboard.readText().then((text) => {
                        const clean = String(text || '').trim();
                        if (!clean) {
                                focusBox();
                                return;
                        }
                        presetText.value = clean;
                        applyPreset(clean);
                }).catch(focusBox);
        }

        function savePreset() {
                if (!presetText.value.trim()) presetText.value = window.Presets.serialize(collectSettings());
                const link = document.createElement('a');
                link.href = URL.createObjectURL(new Blob([presetText.value], { type: 'text/plain' }));
                link.download = 'galaxy-preset.txt';
                link.click();
                URL.revokeObjectURL(link.href);
        }

        // A built-in preset is a settings line plus an arrival view. The view
        // is applied after the line, and fly mode before home: goHome in an
        // orbit mode circles the target instead of standing beside it.
        function applyPresetView(view) {
                if (!view) return;
                if (view.epoch !== undefined) {
                        starTimeMyr = view.epoch;
                        renderer.resetSimpleState();
                        initSimpleLandmarks();
                }
                if (view.time !== undefined) {
                        starTimeRate = view.time;
                        if (starTimeRate > 0) lastNonZeroTimeRate = starTimeRate;
                        syncStarTime();
                }
                if (view.constellations !== undefined) labels.setConstellations(view.constellations);
                if (view.fly) {
                        camera.setMode(window.Camera.MODE_FLY);
                        input.setFlyMode(true);
                }
                if (view.home) camera.goHome();
        }

        function applyBuiltin(id) {
                const preset = window.Presets.builtinById(id);
                if (!preset) return;
                const query = window.Presets.builtinQuery(id);
                presetText.value = query;
                applyPreset(query);
                applyPresetView(preset.view);
                updateOverlay(renderer.state, camera.getState(statsText));
        }

        const builtinBox = document.getElementById('preset-builtin');
        for (const preset of window.Presets.BUILTIN) {
                const button = document.createElement('button');
                button.type = 'button';
                button.id = 'preset-' + preset.id;
                button.textContent = preset.label;
                button.title = preset.title || '';
                button.addEventListener('click', () => applyBuiltin(preset.id));
                builtinBox.appendChild(button);
        }

        btnPresetCopy.addEventListener('click', () => copyText(window.Presets.serialize(collectSettings())));
        btnPresetPaste.addEventListener('click', pastePreset);
        btnPresetApply.addEventListener('click', () => applyPreset(presetText.value));
        btnPresetSave.addEventListener('click', savePreset);
        btnPresetLoad.addEventListener('click', () => presetFile.click());
        btnPresetPrompt.addEventListener('click', () => copyText(window.Presets.buildLlmPrompt(collectSettings())));
        presetFile.addEventListener('change', () => {
                const file = presetFile.files && presetFile.files[0];
                if (!file) return;
                presetFile.value = '';
                file.text().then((text) => {
                        presetText.value = String(text).trim();
                        applyPreset(presetText.value);
                });
        });

        const galaxyType = document.getElementById('galaxy-type');
        const galaxySeed = document.getElementById('galaxy-seed');
        const galaxyAge = document.getElementById('galaxy-age');
        const galaxyAgeVal = document.getElementById('val-galaxy-age');
        const galaxyLabelVal = document.getElementById('val-galaxy');
        const btnGalaxyApply = document.getElementById('galaxy-apply');
        // The option list is the type table itself: adding a row to galaxy.js puts the
        // type in the menu without touching this file.
        for (const type of galaxy.GALAXY_TYPES) {
                const option = document.createElement('option');
                option.value = type;
                option.textContent = type;
                galaxyType.appendChild(option);
        }
        // The slider's range is the model's, not a copy of it typed in twice.
        galaxyAge.min = galaxy.AGE_MIN;
        galaxyAge.max = galaxy.AGE_MAX;
        galaxyAge.step = AGE_STEP;

        function formatAge(age) {
                return age.toFixed(1) + ' Gyr';
        }

        function syncGalaxyControls() {
                galaxyType.value = model.type;
                galaxySeed.value = model.seed;
                galaxyAge.value = model.populations.age;
                galaxyAgeVal.textContent = formatAge(model.populations.age);
                galaxyLabelVal.textContent = `${model.type} #${model.seed} ${model.milkyWay ? '(catalog)' : '(procedural)'}`;
                // Another model is another derived Omega_p, so the pattern-speed
                // readout is re-derived with the rest of the galaxy controls.
                syncPattern();
        }

        // The throttled age drag: a value waiting to be rebuilt, and the loop time
        // the last rebuild happened at. Declared before the rebuilds that clear and
        // read them.
        let pendingAge = null;
        let lastAgeRegen = -Infinity;

        // Rebuilding the field is the expensive path (~0.6 s at 300k stars) and it is
        // deliberately synchronous: the density model is the source of truth, so there
        // is no half-swapped state worth animating around. Another type or seed is
        // another galaxy, so the camera goes home, the labels follow the model and a
        // stale selection is dropped.
        function regenerateGalaxy(type, seed, age) {
                pendingAge = null;
                model = galaxy.createGalaxy({ type, seed, age });
                if (window.OrbitLib.resetPatternPhaseOffset) window.OrbitLib.resetPatternPhaseOffset();
                renderer.regenerate(model);
                // Another centre means another birth field: the simple-engine
                // CPU mirror re-seeds with the GPU thetas (which prepare did).
                initSimpleLandmarks();
                camera.setFrame(model);
                labels.setEnabled(model.milkyWay);
                // Another galaxy is another set of stars: the identity keys
                // name stars this model does not have, so the set goes with it.
                clearSelection();
                // …and a result list naming stars of the old galaxy with it.
                clearSearchReadout();
                syncGalaxyControls();
                updateOverlay(renderer.state, camera.getState(statsText));
        }

        // The same galaxy at another epoch. The renderer keeps the sampled positions
        // and rewrites the records (~0.27 s), so nothing the viewer is looking at
        // moves: no camera reset, no dropped selection, no label rebuild. Moving the
        // age is asking a what-if about this galaxy, not travelling to another one.
        function regenerateAge(age) {
                model = galaxy.createGalaxy({ type: model.type, seed: model.seed, age });
                renderer.regenerate(model);
                // No mirror re-seed here: positions don't move under an age
                // change, so both the GPU thetas and this CPU mirror stay
                // valid — re-seeding either side would snap the epoch. The
                // selection stays valid for the same reason (the set holds
                // positions' identities, not derived stellar inputs, so there
                // is nothing to re-derive until 0.5.1 adds them). A search
                // result's planet columns *are* re-derived by the new
                // population, so the readout is dismissed rather than left
                // naming the previous epoch's worlds. The open system follows
                // the same rule: its star's age feeds the belt presence and
                // the terran flag, so it is regenerated for the new epoch.
                syncSystemViewToPrimary();
                clearSearchReadout();
                syncGalaxyControls();
                updateOverlay(renderer.state, camera.getState(statsText));
        }

        // Live, but throttled. A drag fires an `input` per pixel and the rebuild is
        // a third of a second, so the readout follows the drag while the field
        // follows at most every AGE_REGEN_INTERVAL. The pending value is applied
        // from the frame loop rather than from a timer: the loop is what draws, so
        // the last position of the drag always lands, and there is no queue of
        // intermediate rebuilds to work through.
        galaxyAge.addEventListener('input', () => {
                pendingAge = Number(galaxyAge.value);
                galaxyAgeVal.textContent = formatAge(pendingAge);
        });

        galaxyType.addEventListener('change', () => {
                regenerateGalaxy(galaxyType.value, model.seed, model.populations.age);
        });
        btnGalaxyApply.addEventListener('click', () => {
                regenerateGalaxy(galaxyType.value, Math.floor(Number(galaxySeed.value) || 0), model.populations.age);
        });
        syncGalaxyControls();
        if (!model.milkyWay) labels.setEnabled(false);

        // Pressing Tab while the menu is open should still toggle it (we
        // intercept preventDefault in input.js so focus never moves).
        function handleMenuAction() {
                toggleMenu();
                syncSlidersFromRenderer();
                syncPattern();
        }

        const statsText = {
                position: [0, 0, 0],
                velocity: [0, 0, 0],
                orbitTarget: [0, 0, 0],
                orientation: [0, 0, 0, 1],
        };
        let overlayTimer = OVERLAY_INTERVAL;

        function cameraLine(c) {
                if (c.mode === window.Camera.MODE_FLY) {
                        return `camera ${c.modeName}   speed ${formatSpeed(c.speedLyPerSec)}  (x${c.speedMult})${formatFactor(c.speedFactor)}`;
                }
                return `camera ${c.modeName}   ${c.targetName}   distance ${formatDistance(c.orbitDistance)}`;
        }

        function updateOverlay(state, cameraState) {
                const shutter = state.magZero.toFixed(1);
                const linExp = state.linearExposure.toFixed(2);
                const wp = state.whitePoint.toFixed(1);
                const sat = state.saturation.toFixed(1);
                const mode = state.hdrOutput ? 'HDR + filmic tonemap' : 'SDR + filmic tonemap';
                const catKept = state.catalogThinnedStars || state.catalogResidentStars;
                overlay.textContent =
                        `FPS ${loop.stats.fps.toFixed(0)}   frame ${loop.stats.avgFrameMs.toFixed(2)}ms (max ${loop.stats.maxFrameMs.toFixed(1)}ms)   output ${mode}\n` +
                        `galaxy ${state.galaxyLabel}   age ${state.galaxyAge.toFixed(1)} Gyr   ${state.mode} mode\n` +
                        `stars drawn ${state.drawn.toLocaleString()}  =  global ${state.proceduralStars.toLocaleString()}` +
                        ` + landmarks ${state.landmarkStars.toLocaleString()}` +
                        ` + objects ${state.objectStars.toLocaleString()}` +
                        ` + nebulae ${state.nebulaBillboards.toLocaleString()}` +
                        ` + local ${state.localProceduralStars.toLocaleString()}` +
                        ` + catalog ${catKept.toLocaleString()}/${state.catalogTotalStars.toLocaleString()}\n` +
                        `cells ${state.cellsResident}/${state.catalogCells}   decoded ${(state.decodedBytes / 1024).toFixed(0)} KB` +
                        `   buffer ${(state.bufferBytes / 1048576).toFixed(1)} MB\n` +
                        `exposure ${shutter} ([ / ])   brightness ${linExp}x (; / ')   white ${wp}   sat ${sat}   engine ${state.engine}   constellations ${labels.constellationsVisible() ? 'on' : 'off'} (P)   star time ${window.OrbitLib.formatTimeRate(starTimeRate, 0)} (T)   wave ${waveDamping === 0 ? 'off' : waveDamping.toFixed(2)}   pattern ${window.OrbitLib.effectivePatternSpeed(model).toFixed(3)} rad/Myr (x${patternScale.toFixed(2)})   Tab menu\n` +
                        `pos (${cameraState.position[0].toFixed(3)}, ${cameraState.position[1].toFixed(3)}, ${cameraState.position[2].toFixed(3)}) kpc\n` +
                        cameraLine(cameraState);
        }

        const loop = window.Loop.createLoop((dt, time) => {
                const actions = input.state.actions;
                const resetting = actions.reset;
                camera.step(dt, input.state);
                if (actions.freezeTime) {
                        actions.freezeTime = 0;
                        if (starTimeRate === 0) starTimeRate = lastNonZeroTimeRate;
                        else { lastNonZeroTimeRate = starTimeRate; starTimeRate = 0; }
                        syncStarTime();
                }
                const cameraStateForTime = camera.getState(statsText);
		input.setFlyMode(cameraStateForTime.mode === window.Camera.MODE_FLY);
                const effectiveTimeRate = starTimeRate < 0
                        ? (-starTimeRate) * window.OrbitLib.FLIGHT_TIME_GAIN * cameraStateForTime.speedLyPerSec
                        : starTimeRate;
                const dtStar = effectiveTimeRate * dt;
                starTimeMyr += dtStar;
                if (starTimeMyr >= STAR_TIME_WRAP || starTimeMyr < 0) starTimeMyr = ((starTimeMyr % STAR_TIME_WRAP) + STAR_TIME_WRAP) % STAR_TIME_WRAP;
                // §6.4: the system view's own clock. −1 couples it to the
                // camera speed by the same FLIGHT_TIME_GAIN law the star-time
                // slider uses — resolved here, where the camera state already
                // is — and 0 freezes. The layer owns the accumulated years.
                systemLayer.advance(dt, systemTimeRate < 0
                        ? (-systemTimeRate) * window.OrbitLib.FLIGHT_TIME_GAIN * cameraStateForTime.speedLyPerSec
                        : systemTimeRate);
                // The simple engine's CPU mirror steps beside the GPU buffer —
                // same dtStar the renderer dispatches, so labels and picks ride
                // what the sprites draw. Classic ignores both.
                if (renderer.state.engine.includes('simple') && dtStar > 0) {
                        window.OrbitLib.simpleLandmarksStep(dtStar, starTimeMyr);
                }
                // R puts the orbit target back on the Sun, so a stale selection would
                // contradict it the next time the user cycles into orbit-object mode.
                // It also restarts the simple epoch on both sides of the mirror.
                if (resetting) {
                        clearSelection();
                        renderer.resetSimpleState();
                        initSimpleLandmarks();
                }

                if (actions.galaxyCycle) {
                        actions.galaxyCycle = 0;
                        regenerateGalaxy(galaxy.cycleGalaxyType(model.type), model.seed, model.populations.age);
                }
                // The age slider's trailing edge: applied here, in loop time, so a
                // drag rebuilds at most every AGE_REGEN_INTERVAL and the value the
                // user let go of is the one that lands.
                if (pendingAge !== null && time - lastAgeRegen >= AGE_REGEN_INTERVAL) {
                        lastAgeRegen = time;
                        const age = pendingAge;
                        pendingAge = null;
                        regenerateAge(age);
                }
                labels.setOrbitState(model, starTimeMyr);
                selection.setOrbitState(model, starTimeMyr);
                if (actions.pick) {
                        actions.pick = 0;
                        if (systemViewOpen && !dvMapOpen) {
                                // §6.3: the schematic owns the click while it is
                                // open — a distance test against the icons the
                                // draw placed, no projection and no camera. A
                                // miss clears the system-view selection and
                                // stays in the view. The delta-v map is a graph
                                // with nothing to hit yet (0.5.5 picks its
                                // endpoints), so a click over it falls through
                                // to the star picker below.
                                const body = systemLayer.pick(input.state.pickX, input.state.pickY);
                                systemLayer.setSelectedBody(body ? body.which : window.SystemLayer.BODY_NONE,
                                        body ? body.index : -1);
                        } else if (!systemViewOpen) {
                                // Any drawn star, from any of the five record blocks —
                                // not just the named table. Shift toggles set membership
                                // without moving the primary; a plain click replaces the
                                // set with this one star and makes it the primary.
                                const hit = selection.pickAny(input.state.pickX, input.state.pickY,
                                        canvas.clientWidth, canvas.clientHeight, pickHit);
                                if (hit) selectPickedStar(hit, input.state.keys.boost);
                        }
                }
                if (actions.flyToStar) {
                        actions.flyToStar = 0;
                        flyToPrimary();
                }
                if (actions.cycleStar) {
                        cyclePrimary(actions.cycleStar);
                        actions.cycleStar = 0;
                }
                if (actions.clearSet) {
                        actions.clearSet = 0;
                        clearSelection();
                }
                if (actions.systemView) {
                        actions.systemView = 0;
                        toggleSystemView();
                }
                // §7.5: B only means something inside the view — a map without
                // an open system has nothing to map.
                if (actions.dvmap) {
                        actions.dvmap = 0;
                        toggleDvMap();
                }
                // Esc is close-only: a press with no view open is a no-op.
                if (actions.systemViewClose) {
                        actions.systemViewClose = 0;
                        closeSystemView();
                }
                if (actions.constellations) {
                        actions.constellations = 0;
                        labels.toggleConstellations();
                }
                if (actions.menu) {
                        actions.menu = 0;
                        handleMenuAction();
                }

                resizeCanvas();
                renderer.render(camera, canvas.width, canvas.height, starTimeMyr, input.state, dtStar);
                labels.resize(canvas.clientWidth, canvas.clientHeight, currentDpr());
                labels.draw(camera, canvas.clientWidth, canvas.clientHeight);
                // The schematic resizes off the WebGPU canvas, not its own: the
                // element is hidden while the view is closed, and a hidden
                // element has no client size. draw() is one boolean test and
                // return while closed, so the pointer is only ever read by an
                // open view — and -1 (off the canvas, over the menu, locked)
                // draws no hovered designation.
                systemLayer.resize(canvas.clientWidth, canvas.clientHeight, currentDpr());
                systemLayer.draw(canvas.clientWidth, canvas.clientHeight,
                        input.state.pointerX, input.state.pointerY);

                overlayTimer += dt;
                if (overlayTimer >= OVERLAY_INTERVAL) {
                        overlayTimer = 0;
                        updateOverlay(renderer.state, camera.getState(statsText));
                        // The open system's readout at the overlay's 4 Hz
                        // cadence: it is text, and nothing in it moves per
                        // frame while the phases are frozen (0.5.3-3).
                        if (systemViewOpen) updateSystemReadout();
                        // Keep slider readouts in sync with keyboard shortcuts
                        // while the menu is open.
                        if (menu.style.display !== 'none') syncSlidersFromRenderer();
                }
        });

        loop.start();
        console.log(`Galaxy fly-through ready: ${renderer.state.proceduralStars.toLocaleString()} procedural stars, ` +
                `${renderer.state.landmarkStars} landmarks, ` +
                `${renderer.state.catalogTotalStars.toLocaleString()} catalog stars in ${renderer.state.catalogCells} cells.`);
}

// Node has no document, so requiring this file for its helpers must not boot.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
        window.addEventListener('DOMContentLoaded', boot);
}
if (typeof module !== 'undefined') {
        module.exports = { boot, readParams, formatSpeed, formatDistance, formatFactor, OVERLAY_INTERVAL, MAX_DPR,
                AGE_STEP, AGE_REGEN_INTERVAL };
}
