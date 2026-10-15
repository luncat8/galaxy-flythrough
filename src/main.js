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
// The shortest gap between two field rebuilds, in loop time: a rebuild is ~0.7 s
// at 300k stars, so this keeps a drag interactive instead of queueing one rebuild
// per pixel. The epoch's live clock (E4) shares the star-time dt with the
// stars, and the Age slider's step is the model's own (galaxy.AGE_STEP): the
// slider, the readout and the live clock step by one quantum, so they cannot
// disagree. E4 removed the rebuild interval that used to ration an epoch step —
// the field follows the epoch every frame now.

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
                // Star-cluster visual exaggeration (plan §10): cluster
                // particles = stars × 0.1% × this. ×1 is true scale.
                clusters: number('clusters', window.ClustersLib.CLUSTER_EXAGGERATION_DEFAULT),
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
                // The epoch's live clock (E2): while it runs, the star clock drives
                // the galaxy's own clock. A run that boots within one step of the
                // end of the range replays from the beginning, exactly as the
                // toggle does.
                evolve: number('evolve', 0),
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
		// The system view (0.5.3): its own clock in y/s, and the toggle. An
		// absent key is the frozen, closed default — pre-0.5 presets paste
		// unchanged (plan §14 Q6).
		systime: number('systime', window.SystemLayer.SYSTIME_DEFAULT),
		sysview: number('sysview', 0),
		// Which render the view shows (0 schematic, 1 classic map, 2 rail map):
		// the 0.5.4 `dvmap=1` still means the map it was copied from.
		dvmap: number('dvmap', window.SystemLayer.VIEW_DEFAULT),
		dvbudget: number('dvbudget', window.SystemLayer.BUDGET_DEFAULT),
		ship: text('ship', 'chemical'),
	};
}

async function boot() {
        const canvas = document.getElementById('canvas');
        const overlay = document.getElementById('overlay');
        const errorBox = document.getElementById('error');
        const params = readParams();
        const galaxy = window.GalaxyLib;
        // The epoch's live clock (0.6 E2). `debt` is the star time accrued since the
        // last applied step and `lastAt` the loop time it happened at — the same
        // timeline the Age slider's drag throttle reads, because a live step and a
        // drag are the same rebuild. The clock needs no enabled flag: the tick block
        // is skipped while the toggle is off.
        // The pattern's phase is an accumulator now (orbit.advancePatternPhase):
        // the shell only reads it back for the readout, and never rebases it.

        let evolveOn = params.evolve > 0;
        // One descriptor for the whole galaxy: the density field, the star buffer, the
        // camera frame and the overlay's label all read this object, so switching
        // galaxies builds a new one and hands it round instead of poking four modules.
        let model = galaxy.createGalaxy({
                type: params.type, seed: params.seed,
                age: evolveOn ? galaxy.evolveStartAge(params.age) : params.age,
        });
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

        const selection = window.Selection.createSelection(camera, landmarks);
        let selected = -1;

        // The selection set (0.5.0, plan §3.2): snapshots keyed by the renderer's
        // per-record identity. `pickOut` is the pick record selection.pickAny fills
        // in place and `starInputs` the derived stellar fields — one shape, reused so
        // a click never allocates.
        const starSet = window.StarSet.createStarSet();
        const pickOut = {};
        const starInputs = {};
        const memberRef = { kind: 0, key: 0, index: 0, x: 0, y: 0, z: 0, colorIndex: 0, absMag: 0 };
        const aroundPick = { key: 0, kind: 0, index: 0, x: 0, y: 0, z: 0, colorIndex: 0, absMag: 0 };
        // A pick sweep is spread over frames (plan §3.1). The slice is bounded by
        // time as well as by records, because the per-record dispatch cost depends
        // on the engine mask: ~0.37 µs classic, ~1.5 µs with the apocenter pass
        // (measured in experiments/star-select-test.js), so a record-only budget
        // would be a 2 ms slice under one mask and a 40 ms hitch under another.
        // -1 = no sweep pending, 0/1 = pending, with the click's Shift state for
        // the frame it finishes on.
        const PICK_SLICE_RECORDS = 32768;
        const PICK_SLICE_MS = 8;
        let pendingShift = -1;
        let setLabel = '';            // the readout's "within 50 ly of …" tail

        // The renderer works out its own parity target (the global field plus whatever
        // catalog budget the model allows), because how much catalog a galaxy has is the
        // model's answer, not the URL's.
        const renderer = window.StarRenderer.createStarRenderer(device, context, format, {
                proceduralStars: params.stars,
                clusterExaggeration: params.clusters,
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
        // The picker and the set rings read the buffers, which only exist now
        // (plan §3.1) — a setter is cheaper than reordering boot around them.
        selection.setRenderer(renderer);
        labels.setStarSource(renderer.starBlocks());
        if (params.exposure !== null) renderer.setExposure(params.exposure);
        // The rest of the menu as boot params — the language the preset
        // strings share. Defaults are no-ops, so applying them directly is
        // the same as absent.
        renderer.setLinearExposure(params.brightness);
        renderer.setWhitePoint(params.white);
        renderer.setSaturation(params.sat);
        renderer.setHeadroom(params.headroom);
        renderer.setHighlightDesat(params.highlight);

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
        const menuCollapse = document.getElementById('menu-collapse');
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
        const sliderSelRad = document.getElementById('slider-selrad');
        const valSelRad = document.getElementById('val-selrad');
        const btnSelectAround = document.getElementById('btn-select-around');
        const btnClearSet = document.getElementById('btn-clear-set');

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

        // --- Selection controls (0.5.0, plan §3.3) --------------------------
        // The slider is log10(ly): 0.1 ly … 100 000 ly, default 50 ly. Decimal
        // exponent, so the readout is exact and the value is preset-friendly.
        function syncSelRad() {
                valSelRad.textContent = formatLy(Math.pow(10, Number(sliderSelRad.value)));
        }
        sliderSelRad.addEventListener('input', syncSelRad);
        syncSelRad();
        btnSelectAround.addEventListener('click', () => {
                selectAroundPrimary();
                updateOverlay(renderer.state, camera.getState(statsText));
        });
        btnClearSet.addEventListener('click', () => {
                clearSelection();
                updateOverlay(renderer.state, camera.getState(statsText));
        });

        // --- Star and planet search (0.5.2, plan §5) --------------------------
        // The filter token box is the whole filter (plan §5.5); the quick
        // controls own their dimensions of it and merge per-dimension, so
        // touching the terran box never drops a token-only range. The scope
        // select is separate preset state. Results are transient: any filter
        // change clears them, and the Add button reads a snapshot copy — the
        // results object itself is the search's, reused by the next run.
        const searchLib = window.Search;
        const search = searchLib.createSearch();
        const scopeSelect = document.getElementById('search-scope');
        const classSelect = document.getElementById('search-class');
        const ptypeSelect = document.getElementById('search-ptype');
        const tsurfMinBox = document.getElementById('search-tsurf-min');
        const tsurfMaxBox = document.getElementById('search-tsurf-max');
        const terranCheck = document.getElementById('search-terran');
        const beltCheck = document.getElementById('search-belt');
        const barrenCheck = document.getElementById('search-barren');
        const tokenBox = document.getElementById('search-token');
        const btnSearch = document.getElementById('btn-search');
        const btnSearchAdd = document.getElementById('btn-search-add');
        const btnSearchClear = document.getElementById('btn-search-clear');
        const valSearch = document.getElementById('val-search');
        const sysread = document.getElementById('sysread');
        const searchClassNames = window.StarRecord.SPECTRAL_CLASSES;
        // window.PlanetsLib, not the selectPlanets alias: this block runs
        // before that alias is declared, and the namespace is already live.
        const searchTypeNames = window.PlanetsLib.DISPLAY_TYPES.map((t) => t.name);
        let searchSnapshot = [];
        // The search report's own copy of #sysread: the system view takes the
        // element over while open (0.5.3) and hands it back on exit.
        let sysreadSearchText = '';

        // The class/type selects are filled from the libraries (the
        // galaxy-type select works the same way), so a table rename cannot
        // strand the menu.
        function fillSearchSelect(select, names) {
                select.textContent = '';
                const any = document.createElement('option');
                any.value = '';
                any.textContent = 'any';
                select.appendChild(any);
                for (const name of names) {
                        const opt = document.createElement('option');
                        opt.value = name;
                        opt.textContent = name;
                        select.appendChild(opt);
                }
        }
        fillSearchSelect(classSelect, searchClassNames);
        fillSearchSelect(ptypeSelect, searchTypeNames);

        // A single known bit names its option; anything else the token holds
        // (several classes, none of them the menu's) shows as an honest
        // (mixed) marker instead of a lying 'any'.
        const SEARCH_MIXED = '(mixed)';
        function maskedOptionName(mask, names, bitOf) {
                let found = null;
                for (const name of names) {
                        if ((mask & bitOf(name)) !== 0) {
                                if (found !== null) return undefined;
                                found = name;
                        }
                }
                return found;
        }
        function setSelectToMask(select, names, mask, bitOf) {
                const marked = select.querySelector('option[data-mixed]');
                if (marked) marked.remove();
                const single = maskedOptionName(mask, names, bitOf);
                if (single === undefined) {
                        const opt = document.createElement('option');
                        opt.value = SEARCH_MIXED;
                        opt.textContent = SEARCH_MIXED;
                        opt.dataset.mixed = '1';
                        select.appendChild(opt);
                        select.value = SEARCH_MIXED;
                } else {
                        select.value = single === null ? '' : single;
                }
        }

        function searchNumberOr(text, fallback) {
                const clean = String(text).trim();
                if (clean === '') return fallback;
                const v = Number(clean);
                return Number.isFinite(v) ? Math.max(0, v) : fallback;
        }

        // The quick controls overwrite only their own dimensions of the live
        // token: a token-only range survives a checkbox, and a picked class
        // replaces a pasted multi-class only when the menu means it. A stale
        // (mixed) marker goes away as soon as the select holds a real value.
        function controlsToToken() {
                const f = searchLib.parseFilter(tokenBox.value);
                if (classSelect.value !== SEARCH_MIXED) {
                        f.classes = classSelect.value ? searchLib.classBit(classSelect.value) : 0;
                }
                if (ptypeSelect.value !== SEARCH_MIXED) {
                        f.planetTypes = ptypeSelect.value ? searchLib.planetTypeBit(ptypeSelect.value) : 0;
                }
                f.tsurfMin = searchNumberOr(tsurfMinBox.value, 0);
                f.tsurfMax = searchNumberOr(tsurfMaxBox.value, Infinity);
                f.terranOnly = terranCheck.checked;
                f.needsBelt = beltCheck.checked;
                f.barrenOnly = barrenCheck.checked;
                tokenBox.value = searchLib.formatFilter(f);
                for (const select of [classSelect, ptypeSelect]) {
                        if (select.value !== SEARCH_MIXED) {
                                const marked = select.querySelector('option[data-mixed]');
                                if (marked) marked.remove();
                        }
                }
        }

        function tokenToControls() {
                const f = searchLib.parseFilter(tokenBox.value);
                setSelectToMask(classSelect, searchClassNames, f.classes, searchLib.classBit);
                setSelectToMask(ptypeSelect, searchTypeNames, f.planetTypes, searchLib.planetTypeBit);
                tsurfMinBox.value = f.tsurfMin > 0 ? String(f.tsurfMin) : '';
                tsurfMaxBox.value = f.tsurfMax < Infinity ? String(f.tsurfMax) : '';
                terranCheck.checked = f.terranOnly;
                beltCheck.checked = f.needsBelt;
                barrenCheck.checked = f.barrenOnly;
        }

        // Results belong to the filter that ran them: any change clears the
        // report, the snapshot and the readout until the next Search.
        function markSearchStale() {
                searchSnapshot = [];
                valSearch.textContent = 'no search yet';
                sysreadSearchText = '';
                // While the system view owns #sysread, only the copy clears —
                // the schematic's readout stays until the view exits.
                if (!systemLayer.isOpen()) sysread.textContent = '';
        }

        function onSearchControl() {
                controlsToToken();
                markSearchStale();
        }
        for (const el of [classSelect, ptypeSelect, tsurfMinBox, tsurfMaxBox,
                terranCheck, beltCheck, barrenCheck]) {
                el.addEventListener('change', onSearchControl);
        }
        tokenBox.addEventListener('change', () => {
                tokenBox.value = searchLib.formatFilter(searchLib.parseFilter(tokenBox.value));
                tokenToControls();
                markSearchStale();
        });
        scopeSelect.addEventListener('change', markSearchStale);

        // Plan §5.4's top-12 lines: designation, class, distance, matched
        // planet, Tsurf. The class reads the same colorIndex map as the
        // selected line, so the two readouts never disagree about a star.
        function searchRowLine(res, i) {
                const key = res.keys[i] >>> 0;
                const kind = res.kind[i];
                const index = res.index[i];
                let name = 'S' + key.toString(36).toUpperCase();
                if (kind === selectPlanets.BLOCK_LANDMARK && landmarks.ENTRIES[index]) {
                        name = landmarks.ENTRIES[index].name;
                }
                const cls = window.StarRecord.SPECTRAL_CLASSES[res.colorIndex[i]] || '?';
                const dist = formatLy(Math.sqrt(res.dist2[i]) * LY_PER_KPC);
                let planet = '—';
                if (res.nPlanets[i] === 0) planet = 'no planets';
                else if (res.best[i * 4 + 3] !== searchLib.BEST_NONE) {
                        const typeName = searchTypeNames[res.best[i * 4 + 3]] || '?';
                        const letter = res.bestLetter[i] >= 0
                                ? ' ' + String.fromCharCode(98 + res.bestLetter[i]) : '';
                        const tsurf = Number.isFinite(res.best[i * 4 + 2])
                                ? '  ' + Math.round(res.best[i * 4 + 2]) + ' K' : '';
                        planet = typeName + letter + tsurf;
                }
                return name.padEnd(12) + '  ' + cls.padEnd(3) + '  ' + dist.padEnd(9) + '  ' + planet;
        }

        function runSearch() {
                tokenBox.value = searchLib.formatFilter(searchLib.parseFilter(tokenBox.value));
                tokenToControls();
                const filter = searchLib.parseFilter(tokenBox.value);
                const scope = scopeSelect.value === 'galaxy' ? 'galaxy' : 'selection';
                const cam = camera.cameraPos;
                const t0 = performance.now();
                const res = search.run(filter, {
                        scope, camX: cam[0], camY: cam[1], camZ: cam[2],
                        model, renderer, set: starSet,
                });
                const ms = performance.now() - t0;
                searchSnapshot = [];
                for (let i = 0; i < res.count; i++) {
                        searchSnapshot.push({
                                key: res.keys[i] >>> 0, kind: res.kind[i], index: res.index[i],
                                x: res.x[i], y: res.y[i], z: res.z[i],
                                colorIndex: res.colorIndex[i], absMag: res.absMag[i],
                        });
                }
                valSearch.textContent = res.stats.scope + ' · scanned ' + res.stats.scanned.toLocaleString()
                        + ' · matched ' + res.stats.matched.toLocaleString() + ' · kept ' + res.count
                        + ' · ' + ms.toFixed(ms < 10 ? 1 : 0) + ' ms';
                const lines = ['search ' + (tokenBox.value || '(all)') + ' · ' + valSearch.textContent];
                if (res.count === 0) lines.push('no matches');
                const show = Math.min(res.count, 12);
                for (let i = 0; i < show; i++) lines.push(searchRowLine(res, i));
                if (res.count > show) lines.push('… +' + (res.count - show) + ' more');
                sysreadSearchText = lines.join('\n');
                if (!systemLayer.isOpen()) sysread.textContent = sysreadSearchText;
        }
        btnSearch.addEventListener('click', runSearch);
        btnSearchClear.addEventListener('click', markSearchStale);

        // Plan §5.4: the kept rows join the set through insert's own
        // capacity/nearest-first rules, so a search becomes a working set for
        // a route in two clicks. Unresolved rows stay out: a kind of −1 means
        // the member's slot moved on, and the set already holds its key.
        function addResultsToSelection() {
                if (searchSnapshot.length === 0) return;
                const cam = camera.cameraPos;
                const ctx = {
                        model,
                        field: renderer.fieldBuffers(),
                        member: renderer.starBlocks().member,
                };
                for (const row of searchSnapshot) {
                        if (row.kind === searchLib.KIND_UNRESOLVED) continue;
                        aroundPick.key = row.key;
                        aroundPick.kind = row.kind;
                        aroundPick.index = row.index;
                        aroundPick.x = row.x;
                        aroundPick.y = row.y;
                        aroundPick.z = row.z;
                        aroundPick.colorIndex = row.colorIndex;
                        aroundPick.absMag = row.absMag;
                        aroundPick.approximated = 0;
                        const inputs = selectPlanets.stellarInputs(aroundPick, ctx, starInputs);
                        starSet.insert(aroundPick, inputs, cam[0], cam[1], cam[2], row.index);
                }
                if (starSet.count > 0 && starSet.primary < 0) starSet.setPrimary(0);
                setLabel = '';
                syncSetUi();
                updateOverlay(renderer.state, camera.getState(statsText));
        }
        btnSearchAdd.addEventListener('click', addResultsToSelection);

        // --- System view (0.5.3, plan §6) -------------------------------------
        // The schematic of the primary selection's generated system. The layer
        // owns the record, the log-polar layout, its own years/s clock and the
        // screen-space picking; main.js owns the enter/exit glue (camera, menu
        // rows, #sysread) and routes the canvas clicks to it while open.
        const systemLayer = window.SystemLayer.createSystemLayer(document.getElementById('system'));
        const sysMenu = document.getElementById('sysmenu');
        const sysMenuCollapse = document.getElementById('sysmenu-collapse');
        const btnSystemView = document.getElementById('btn-system-view');
        const sysViewSelect = document.getElementById('sys-view');
        const sliderSysTime = document.getElementById('slider-systime');
        const valSysTime = document.getElementById('val-systime');
        // Rows that mean nothing outside the view are hidden rather than
        // disabled — the data-view mirror of the data-engine mechanism (§6.5).
        const viewRows = Array.from(document.querySelectorAll('#sysmenu [data-view]'));
        const bodyPick = { kind: -1, index: -1 };
        const systemCtx = {};
        let hoverX = -1e9, hoverY = -1e9;
        // 1 pc in kpc: closer than this, entering keeps the camera distance and
        // only switches the orbit target (plan §6.5).
        const SYSTEM_VIEW_FLY_KPC = 0.001;

        // The slider speaks ladder indices: the stops (and their bounds) belong
        // to the layer that owns the clock, never a second copy typed in here
        // (the rule the galaxy-age slider follows). The rate itself is only
        // clamped there, so a preset may carry a rate that is not a stop.
        sliderSysTime.min = window.SystemLayer.SYSTIME_INDEX_MIN;
        sliderSysTime.max = window.SystemLayer.SYSTIME_INDEX_MAX;
        sliderSysTime.step = 1;
        function syncSysTime() {
                const rate = systemLayer.getTimeRate();
                sliderSysTime.value = window.SystemLayer.sysTimeIndexOf(rate);
                valSysTime.textContent = window.SystemLayer.formatSysTimeRate(rate);
                valSysTime.title = window.SystemLayer.formatSysTimeRate(rate);
        }
        sliderSysTime.addEventListener('input', () => {
                systemLayer.setTimeRate(window.SystemLayer.sysTimeRateAt(Number(sliderSysTime.value)));
                syncSysTime();
                if (systemLayer.isOpen()) writeSystemReadout();
        });

        // Delta-v controls (0.5.4, reshaped in 0.5.6): the render select (B
        // cycles it), the budget slider and the ship select. The ship list is
        // filled from the one ship table, so a class rename cannot strand it.
        const sliderDvBudget = document.getElementById('slider-dvbudget');
        const valDvBudget = document.getElementById('val-dvbudget');
        const selDvShip = document.getElementById('dv-ship');
        sliderDvBudget.min = window.SystemLayer.BUDGET_MIN;
        sliderDvBudget.max = window.SystemLayer.BUDGET_MAX;
        sliderDvBudget.step = window.SystemLayer.BUDGET_STEP;
        selDvShip.textContent = '';
        for (const ship of window.DeltaVLib.SHIP_CLASSES) {
                const option = document.createElement('option');
                option.value = ship.id;
                option.textContent = ship.label;
                selDvShip.appendChild(option);
        }
        function syncDvUi() {
                sliderDvBudget.value = systemLayer.getBudget();
                valDvBudget.textContent = Number(systemLayer.getBudget()).toFixed(2);
                selDvShip.value = systemLayer.getShipClass();
                sysViewSelect.value = String(systemLayer.getView());
		document.body.classList.toggle('dv-map', systemLayer.isOpen() && systemLayer.isMapOpen());
        }
        function cycleDvView() {
                systemLayer.cycleView();
                syncDvUi();
                writeSystemReadout();
        }
        // Picking a render is opening the view: the select is the entry point
        // as well as the switch, so a viewer never has to find V first.
        sysViewSelect.addEventListener('change', () => {
                systemLayer.setView(Number(sysViewSelect.value));
                if (!systemLayer.isOpen()) openSystemView(true);
                syncViewRows();
                writeSystemReadout();
        });
        sliderDvBudget.addEventListener('input', () => {
                systemLayer.setBudget(Number(sliderDvBudget.value));
                syncDvUi();
                writeSystemReadout();
        });
        selDvShip.addEventListener('change', () => {
                systemLayer.setShipClass(selDvShip.value);
                syncDvUi();
                writeSystemReadout();
        });

	const btnRouteFly = document.getElementById('route-fly');
	const routeHint = document.getElementById('route-hint');
	const routeRoundtrip = document.getElementById('route-roundtrip');
	const dvPick = { body: -1, node: -1 };
	function syncRouteUi() {
		const r = systemLayer.routeState();
		const state = systemLayer.autopilotState();
		const rate = systemLayer.getTimeRate();
		btnRouteFly.textContent = state === 'running' ? 'Pause autopilot'
			: state === 'paused' ? 'Resume autopilot'
			: state === 'complete' ? 'Restart autopilot' : 'Start autopilot';
		btnRouteFly.disabled = !r.feasible;
		if (!r.start) { routeHint.textContent = 'On a delta-v view: choose a start node, then a destination.'; return; }
		if (!r.end) { routeHint.textContent = 'Start selected — choose a destination node.'; return; }
		if (!r.feasible) { routeHint.textContent = r.reason; return; }
		if (state === 'running') {
			routeHint.textContent = rate === 0 ? 'Autopilot armed, but System time is frozen. Set it above 0 to move the ship.'
				: rate > 1 ? 'Autopilot fast-forwarding. Use 0.1–1 y/s to watch the ship move.'
				: rate > 0 && rate < 0.01 ? 'Autopilot is very slow at this rate. Use 0.1–1 y/s to watch a transfer.'
				: 'Autopilot running — Pause holds the ship at its current leg.';
			return;
		}
		if (state === 'paused') { routeHint.textContent = 'Autopilot paused — Resume continues from the current leg.'; return; }
		if (state === 'complete') { routeHint.textContent = 'Flight complete — Restart to fly the route again.'; return; }
		routeHint.textContent = rate === 0 ? 'Route ready, but System time is frozen. Set it above 0, then start autopilot.'
			: rate > 1 ? 'Route ready. High rates can finish between frames; use 0.1–1 y/s to watch.'
			: rate > 0 && rate < 0.01 ? 'Route ready. This rate is very slow for transfers; try 0.1–1 y/s.'
			: 'Route ready — press Start autopilot to move the ship.';
	}
	routeRoundtrip.addEventListener('change', () => {
		systemLayer.setRoundTrip(routeRoundtrip.checked); writeSystemReadout();
	});
	document.getElementById('route-clear').addEventListener('click', () => {
		systemLayer.clearRoute(); writeSystemReadout();
	});
	btnRouteFly.addEventListener('click', () => {
		systemLayer.toggleAutopilot(); writeSystemReadout();
	});
	function stellarEndpoint(i) {
		const inputs = deriveMemberInputs(i);
		const d = window.DeltaVLib;
		const mu = d.G_SI * inputs.mass * d.M_SUN_KG;
		const radius = Math.max(0.01 * d.AU_M, inputs.rStar * selectPlanets.AU_PER_R_SUN * d.AU_M * 10);
		const body = d.createBodyParam();
		body.mu = mu; body.aM = radius; body.rLoM = radius;
		body.vCircLo = d.vCirc(mu, radius); body.vEscLo = d.vEsc(mu, radius);
		body.periodS = d.TAU * Math.sqrt(radius ** 3 / mu);
		return { body, node: 1, muStar: mu, phase: 0, systemKey: starSet.keys[i], label: memberName(i),
			x: starSet.x[i], y: starSet.y[i], z: starSet.z[i] };
	}
	document.getElementById('route-stars').addEventListener('click', () => {
		if (starSet.count < 2) { routeHint.textContent = 'Shift-click two stars in galaxy view first.'; return; }
		systemLayer.planExternalRoute(stellarEndpoint(0), stellarEndpoint(1));
		writeSystemReadout();
	});

        function syncViewRows() {
                const viewOpen = systemLayer.isOpen();
		document.body.classList.toggle('system-view', viewOpen);
		syncDvUi(); syncRouteUi();
                for (const row of viewRows) {
                        row.style.display = viewOpen && row.dataset.view === 'system' ? '' : 'none';
                }
                btnSystemView.textContent = viewOpen ? 'Close' : 'Open';
        }
        btnSystemView.addEventListener('click', () => toggleSystemView());

        function landmarkNameFor(i) {
                if (starSet.blockKind[i] === selectPlanets.BLOCK_LANDMARK) {
                        const entry = landmarks.ENTRIES[starSet.bufferIdx[i]];
                        if (entry) return entry.name;
                }
                return null;
        }

        // Enter (plan §6.5): requires the primary; the layer generates the
        // record and hashes the belt stipples, then the camera comes onto the
        // star — flyToStar at the luminosity stand-off when farther than 1 pc,
        // otherwise just the orbit-object switch, current distance kept.
        function openSystemView(moveCamera) {
                const p = starSet.primary;
                if (p < 0) return false;
                const ref = memberRefFor(p);
                systemCtx.model = model;
                systemCtx.field = renderer.fieldBuffers();
                systemCtx.member = renderer.starBlocks().member;
                systemCtx.name = landmarkNameFor(p);
                systemLayer.enter(ref, systemCtx);
                if (moveCamera !== false) {
                        const cam = camera.cameraPos;
                        const dx = starSet.x[p] - cam[0];
                        const dy = starSet.y[p] - cam[1];
                        const dz = starSet.z[p] - cam[2];
                        const far = Math.sqrt(dx * dx + dy * dy + dz * dz) > SYSTEM_VIEW_FLY_KPC;
                        camera.flyToStar(starSet.x[p], starSet.y[p], starSet.z[p], memberName(p),
                                far ? camera.orbitStandOff(starSet.lum[p]) : 0);
                }
                syncViewRows();
                writeSystemReadout();
                return true;
        }

        // Exit: the layer erases its canvas and discards its transient route;
        // #sysread returns to the search report (empty → CSS hides it), while
        // the camera keeps its orbit target and fly keys follow its mode (§6.5).
        function closeSystemView() {
                if (!systemLayer.isOpen()) return;
                systemLayer.exit();
                syncViewRows();
                sysread.textContent = sysreadSearchText;
        }

        function toggleSystemView() {
                if (systemLayer.isOpen()) closeSystemView();
                else openSystemView(true);
        }

        // The readout is text at the overlay's 4 Hz cadence (plan §6.6), plus
        // an immediate refresh on enter and on a schematic click, so the
        // ◀ marker never lags the ring.
        function writeSystemReadout() {
                sysread.textContent = systemLayer.readoutText();
		syncRouteUi();
        }

        // The cursor over the schematic. The canvas spans the viewport at
        // (0,0), so client coords are its CSS pixels; hover resolution itself
        // runs per frame in the loop — bodies move under a still cursor.
        canvas.addEventListener('mousemove', (e) => {
                hoverX = e.clientX;
                hoverY = e.clientY;
        });

        systemLayer.setTimeRate(params.systime);
        syncSysTime();
        systemLayer.setView(params.dvmap);
        systemLayer.setBudget(params.dvbudget !== undefined ? params.dvbudget : window.SystemLayer.BUDGET_DEFAULT);
        systemLayer.setShipClass(params.ship);
        syncDvUi();
        syncViewRows();
        if (params.sysview) openSystemView(true);   // no selection at boot: a no-op

        // Tab toggles both control panels without changing the view. A panel's
        // own ▾ collapses it to its header instead of closing it, so there is
        // always a handle to expand it again; collapsing the System panel keeps
        // the view open (V, Esc and its Close button are the exits). Opening
        // either panel releases pointer lock and any held key.
        function releasePanelInput() {
                input.releaseAll();
                if (document.pointerLockElement === canvas) document.exitPointerLock();
        }
        // The overlay and the readout start where the left panel ends; when
        // the panel is hidden they take the column back.
        function syncOverlayInset() {
                const left = sysMenu.style.display === 'none' ? '12px' : '292px';
                overlay.style.left = left;
                sysread.style.left = left;
        }
        function toggleMenu() {
                const visible = menu.style.display !== 'none' || sysMenu.style.display !== 'none';
                menu.style.display = visible ? 'none' : 'block';
                sysMenu.style.display = visible ? 'none' : 'block';
                syncOverlayInset();
                if (visible) {
                        input.releaseAll();
                        canvas.focus({ preventScroll: true });
                } else {
                        releasePanelInput();
                }
        }
        function toggleCollapse(panel, button) {
                const collapsed = panel.classList.toggle('collapsed');
                button.textContent = collapsed ? '\u25b8' : '\u25be';
                button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
                releasePanelInput();
                canvas.focus({ preventScroll: true });
        }
        function wireCollapse(panel, button) {
                button.addEventListener('click', () => toggleCollapse(panel, button));
                panel.querySelector('.menu-header > span').addEventListener('click', () => toggleCollapse(panel, button));
        }
        wireCollapse(menu, menuCollapse);
        wireCollapse(sysMenu, sysMenuCollapse);

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
        const apocenterNote = document.getElementById('apocenter-note');
        function syncEngine() {
                const active = renderer.state.engine;
                engineClassic.checked = active === 'classic' || active.includes('classic');
                engineSimple.checked = active.includes('simple');
                engineApocenter.checked = active.includes('apocenter');
                valEngine.textContent = active === 'classic' ? 'closed form' : active.trim();
                for (const row of engineRows) row.style.display = active.includes(row.dataset.engine) ? '' : 'none';
                // Mask 4 is birth for the unselected share by contract (movement
                // parity plan, decision 1), so at 0% nothing moves. Say so where
                // the share slider is, instead of letting it read as a freeze.
                apocenterNote.hidden = active !== 'apocenter';
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
                // The view's clock is a knob; whether the view is open is
                // working state, like the search results — Defaults keeps it.
                systemLayer.setTimeRate(d.systime);
		systemLayer.setBudget(d.dvbudget);
		systemLayer.setShipClass(d.ship);
		systemLayer.setView(d.dvmap);
		syncDvUi();
		if (systemLayer.isOpen()) writeSystemReadout();
                syncApocenterSliders();
                syncSlidersFromRenderer();
                syncWave();
                syncPattern();
                syncSysTime();
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
                        evolve: evolveOn ? 1 : 0,
                        engine: selectedEngines(),
                        time: starTimeRate,
                        wave: waveDamping,
                        pattern: patternScale,
                        apoShare: window.OrbitLib.getApocenterShare(),
                        apoForce: window.OrbitLib.getApocenterForce(),
                        selrad: Math.log10(Math.max(0.1, selectionRadiusKpc() / window.Camera.LY_TO_KPC)),
                        exposure: renderer.state.magZero,
                        brightness: renderer.state.linearExposure,
                        white: renderer.state.whitePoint,
                        sat: renderer.state.saturation,
                        headroom: renderer.state.headroom,
                        highlight: renderer.state.highlightDesat,
                        search: searchLib.formatFilter(searchLib.parseFilter(tokenBox.value)),
                        scope: scopeSelect.value === 'galaxy' ? 'galaxy' : 'selection',
                        sysview: systemLayer.isOpen() ? 1 : 0,
                        systime: systemLayer.getTimeRate(),
                        dvmap: systemLayer.getView(),
                        dvbudget: systemLayer.getBudget(),
			ship: systemLayer.getShipClass(),
                        stars: params.stars,
                        catalog: params.catalogStars,
                        clusters: renderer.state.clusterExaggeration,
                };
        }

        function applyPreset(query) {
                const s = window.Presets.parse(query);
                if (!Object.keys(s).length) return false;
                // The star budget lands before the galaxy rebuild below, so a preset
                // that changes both costs one re-draw, not two.
                const budgetChanged = s.stars !== undefined && renderer.setProceduralStars(s.stars) !== params.stars;
                if (budgetChanged) {
                        params.stars = renderer.proceduralTarget();
                        syncStars();
                }
                // The cluster coefficient resizes the object block, so it
                // lands with the budgets, before the rebuild below.
                let clusterChanged = false;
                if (s.clusters !== undefined) {
                        clusterChanged = renderer.setClusterExaggeration(s.clusters) !== params.clusters;
                        params.clusters = renderer.state.clusterExaggeration;
                        syncClusters();
                }
                if (s.type !== undefined || s.seed !== undefined || s.age !== undefined) {
                        regenerateGalaxy(
                                s.type !== undefined ? s.type : model.type,
                                s.seed !== undefined ? s.seed : model.seed,
                                s.age !== undefined ? s.age : model.populations.age);
                } else if (budgetChanged || clusterChanged) {
                        redrawField(model);
                }
                // The epoch's live clock (E2), landed after the age above so a preset
                // that carries both reaches its own epoch first and the replay rule
                // (which reads the age the field was built at) sees it.
                if (s.evolve !== undefined) setEvolve(s.evolve > 0);
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
                if (s.selrad !== undefined) {
                        sliderSelRad.value = s.selrad;
                        syncSelRad();
                }
                if (s.exposure !== undefined) renderer.setExposure(s.exposure);
                if (s.brightness !== undefined) renderer.setLinearExposure(s.brightness);
                if (s.white !== undefined) renderer.setWhitePoint(s.white);
                if (s.sat !== undefined) renderer.setSaturation(s.sat);
                if (s.headroom !== undefined) renderer.setHeadroom(s.headroom);
                if (s.highlight !== undefined) renderer.setHighlightDesat(s.highlight);
                // The filter and scope are preset state; the results are not
                // (plan §5.5) — a pasted query lands in the controls and the
                // old results clear, so nothing stale survives the paste.
                if (s.search !== undefined) {
                        tokenBox.value = searchLib.formatFilter(searchLib.parseFilter(s.search));
                        tokenToControls();
                        markSearchStale();
                }
                if (s.scope !== undefined) {
                        scopeSelect.value = s.scope === 'galaxy' ? 'galaxy' : 'selection';
                        markSearchStale();
                }
                // The system view (0.5.3): the clock lands either way; opening
                // needs a primary, and the selection contents are not preset
                // state (plan §5.5), so sysview=1 without one is a no-op.
                if (s.systime !== undefined) {
                        systemLayer.setTimeRate(s.systime);
                        syncSysTime();
                }
                if (s.sysview !== undefined) {
                        if (s.sysview) openSystemView(true);
                        else closeSystemView();
                }
                if (s.dvmap !== undefined) {
                        systemLayer.setView(s.dvmap);
                }
                if (s.dvbudget !== undefined) {
                        systemLayer.setBudget(s.dvbudget);
                }
		if (s.ship !== undefined) systemLayer.setShipClass(s.ship);
                syncDvUi();
		if (systemLayer.isOpen()) writeSystemReadout();
                syncSlidersFromRenderer();
                updateOverlay(renderer.state, camera.getState(statsText));
                return true;
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

        // One status line under the buttons, so a paste that found nothing says
        // so instead of silently doing nothing (or printing the clipboard).
        const presetStatus = document.getElementById('preset-status');
        function presetSay(text) {
                presetStatus.textContent = text;
        }

        // Pasted text becomes the box only if it is a preset: anything else is
        // left out of the box and reported, so a stray clipboard never lands in
        // the settings line.
        function takePastedText(text) {
                const query = window.Presets.presetQueryOf(text);
                if (!query) {
                        presetSay(String(text || '').trim() ? 'clipboard holds no preset — nothing applied' : 'clipboard is empty');
                        return false;
                }
                presetText.value = query;
                applyPreset(query);
                presetSay('preset applied from the clipboard');
                return true;
        }

        // The button goes through the async clipboard API, which some browsers
        // guard with a prompt on every read (Firefox's Paste popup, Chrome on
        // file://). Ctrl/Cmd+V over the scene is the prompt-free path: a paste
        // event carries its own clipboard data.
        function pastePreset() {
                if (!(navigator.clipboard && navigator.clipboard.readText)) {
                        presetText.focus();
                        presetSay('no clipboard access here — press Ctrl+V over the scene, or paste into the box and Apply');
                        return;
                }
                navigator.clipboard.readText().then(takePastedText).catch(() => {
                        presetSay('clipboard read refused — press Ctrl+V over the scene, or paste into the box and Apply');
                });
        }
        // A field that takes typed text keeps its own paste; a slider, a button
        // or the scene does not take text, so there the paste is a preset.
        function typingTarget(t) {
                if (!t || !t.tagName) return false;
                if (t.tagName === 'TEXTAREA' || t.isContentEditable) return true;
                return t.tagName === 'INPUT' && /^(text|number|search|url|email|password)$/.test(t.type);
        }
        document.addEventListener('paste', (event) => {
                if (typingTarget(event.target)) return;
                const text = event.clipboardData ? event.clipboardData.getData('text/plain') : '';
                if (takePastedText(text)) event.preventDefault();
        });

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

        btnPresetCopy.addEventListener('click', () => {
                copyText(window.Presets.serialize(collectSettings()));
                presetSay('settings copied');
        });
        btnPresetPaste.addEventListener('click', pastePreset);
        btnPresetApply.addEventListener('click', () => {
                presetSay(applyPreset(presetText.value) ? 'preset applied' : 'the box holds no preset — nothing applied');
        });
        btnPresetSave.addEventListener('click', savePreset);
        btnPresetLoad.addEventListener('click', () => presetFile.click());
        btnPresetPrompt.addEventListener('click', () => copyText(window.Presets.buildLlmPrompt(collectSettings())));
        presetFile.addEventListener('change', () => {
                const file = presetFile.files && presetFile.files[0];
                if (!file) return;
                presetFile.value = '';
                file.text().then((text) => {
                        const query = window.Presets.presetQueryOf(text);
                        if (!query) {
                                presetSay(`${file.name} holds no preset — nothing applied`);
                                return;
                        }
                        presetText.value = query;
                        applyPreset(query);
                        presetSay(`preset loaded from ${file.name}`);
                });
        });

        const galaxyType = document.getElementById('galaxy-type');
        const galaxySeed = document.getElementById('galaxy-seed');
        const galaxyAge = document.getElementById('galaxy-age');
        const galaxyAgeVal = document.getElementById('val-galaxy-age');
        const galaxyEvolve = document.getElementById('galaxy-evolve');
        const valEpoch = document.getElementById('val-epoch');
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
        // The slider's range and step are the model's, not a copy typed in twice:
        // the epoch's own quantum is what the live clock steps by.
        galaxyAge.min = galaxy.AGE_MIN;
        galaxyAge.max = galaxy.AGE_MAX;
        galaxyAge.step = galaxy.AGE_STEP;

        function formatAge(age) {
                return age.toFixed(1) + ' Gyr';
        }

        // The epoch readout (E2): the epoch the *field* was built at, never the
        // clock's wish, so the readout, the Age slider and what is drawn cannot
        // disagree. The tooltip carries the rest of the epoch — the numbers the
        // viewer is watching move, E3's spheroid size among them.
        function syncEpoch() {
                valEpoch.textContent = formatAge(model.populations.age);
                const e = model.epoch;
                valEpoch.title = `bulge ${(e.spheroidProgress * 100).toFixed(0)}% mass, ×${e.spheroidSize.toFixed(2)} size   arms ×${e.armContrast.toFixed(2)}` +
                        `   heat ${e.heat.toFixed(2)}   gas ×${e.gasRatio.toFixed(2)}`;
        }

        function syncGalaxyControls() {
                galaxyType.value = model.type;
                galaxySeed.value = model.seed;
                galaxyAge.value = model.populations.age;
                galaxyAgeVal.textContent = formatAge(model.populations.age);
                galaxyEvolve.checked = evolveOn;
                galaxyLabelVal.textContent = `${model.type} #${model.seed} ${model.milkyWay ? '(catalog)' : '(procedural)'}`;
                // Another model is another derived Omega_p and another epoch, so
                // both readouts are re-derived with the rest of the galaxy controls.
                syncEpoch();
                syncPattern();
        }

        // The age drag's newest value: applied by the frame loop (never by a
        // timer), so the value the user let go of is the one that lands. Since
        // E4 an epoch change is a model re-solve, not a rebuild, so there is no
        // throttle left here — the loop applies whatever the drag last wrote.
        let pendingAge = null;

        // Rebuilding the field is the expensive path (~0.6 s at 300k stars) and it is
        // deliberately synchronous: the density model is the source of truth, so there
        // is no half-swapped state worth animating around. Another type or seed is
        // another galaxy, so the camera goes home, the labels follow the model and a
        // stale selection is dropped.
        function regenerateGalaxy(type, seed, age) {
                pendingAge = null;
                model = galaxy.createGalaxy({ type, seed, age });
                if (window.OrbitLib.resetPatternPhase) window.OrbitLib.resetPatternPhase();
                renderer.regenerate(model);
                // Another centre means another birth field: the simple-engine
                // CPU mirror re-seeds with the GPU thetas (which prepare did).
                initSimpleLandmarks();
                camera.setFrame(model);
                labels.setEnabled(model.milkyWay);
                if (selected >= 0) {
                        selected = -1;
                        labels.setSelected(-1);
                }
                // Another galaxy is another set of stars: the snapshots are dropped,
                // not re-derived (their keys belong to a different model, §3.2).
                clearSelection();
                syncGalaxyControls();
                updateOverlay(renderer.state, camera.getState(statsText));
        }

        // Another epoch of the *same* field (0.6 E4). Nothing is re-drawn: the
        // records keep their stars and the birth frame they were drawn in, and
        // the renderer's epoch map places them in the new frame every frame
        // (the bulge homology, the disc's height law, the arms' re-anchoring).
        // The look follows in the renderer's background sweep, a slice a frame,
        // so the clock can run continuously with no step to pay for. An open
        // schematic follows on the same clock.
        function setEpoch(age) {
                const next = Number(age);
                if (!Number.isFinite(next) || next === model.populations.age) return;
                model = galaxy.modelAtAge(model, Math.min(galaxy.AGE_MAX, Math.max(galaxy.AGE_MIN, next)));
                renderer.setEpoch(model);
                if (systemLayer.isOpen()) openSystemView(false);
                syncGalaxyControls();
        }

        // A re-draw of the *same* galaxy — another epoch, or another star budget
        // — at the current star time. The star clock and the pattern's phase are
        // not reset: the pattern keeps the orientation it has on screen, because
        // the phase is an accumulator (orbit.advancePatternPhase) and not the
        // current rate times the clock. Since E4 nothing here turns the field to
        // meet the arms either: the field is drawn *into* the current frame
        // (orbit.setEpochBase), so there is nothing to carry and no `carry`
        // argument left to pass.
        function redrawField(next) {
                model = next;
                renderer.regenerate(model);
                if (!window.OrbitLib.simpleLandmarksRebind(model)) initSimpleLandmarks();
                briefModel = null;   // the brief re-reads the star from the new draw
                // The set survives per key (plan §3.2) but not per slot: every
                // member is resolved against the field that was just drawn.
                resolveSet();
                // An open schematic follows the refreshed snapshot: a new epoch
                // re-rolls the star's state and luminosity, so the record
                // regenerates — without a camera move, nothing moved.
                if (systemLayer.isOpen()) openSystemView(false);
                syncGalaxyControls();
                updateOverlay(renderer.state, camera.getState(statsText));
        }

        // Live, and no longer throttled: a drag fires an `input` per pixel and
        // the readout follows it immediately, because the field follows the
        // epoch every frame now (E4) — there is no rebuild to ration. The value
        // is applied from the frame loop rather than from the event, so a drag
        // that outruns the loop still lands on the value the user let go of.
        galaxyAge.addEventListener('input', () => {
                pendingAge = Number(galaxyAge.value);
                galaxyAgeVal.textContent = formatAge(pendingAge);
        });

        // The live clock's toggle (E4). Ticking it on within one step of the end of
        // the range replays the life that got there; anywhere else the run continues
        // from where the galaxy is, and a drag of the Age slider is the seek that
        // retargets the next frame. Nothing is throttled and nothing is owed:
        // the epoch is a continuous parameter of the placement now.
        function setEvolve(on) {
                evolveOn = !!on;
                galaxyEvolve.checked = evolveOn;
                if (evolveOn) {
                        const start = galaxy.evolveStartAge(model.populations.age);
                        if (start !== model.populations.age) pendingAge = start;
                }
                syncEpoch();
        }
        galaxyEvolve.addEventListener('change', () => setEvolve(galaxyEvolve.checked));

        // The star budget (0.6). A ladder of stops rather than a free slider:
        // the value is a buffer size, and round numbers read back in presets.
        // The readout follows the drag; the re-draw happens once, on release.
        // A URL or preset may carry an off-ladder count — it is kept as given
        // and the slider shows the nearest stop.
        const STAR_STOPS = [30000, 50000, 75000, 100000, 150000, 200000, 300000, 400000, 500000];
        const sliderStars = document.getElementById('slider-stars');
        const valStars = document.getElementById('val-stars');
        sliderStars.max = STAR_STOPS.length - 1;
        function formatStars(count) {
                return count >= 1e6 ? (count / 1e6).toFixed(2) + 'M' : Math.round(count / 1000) + 'k';
        }
        function nearestStarStop(count) {
                let best = 0;
                for (let i = 1; i < STAR_STOPS.length; i++) {
                        if (Math.abs(STAR_STOPS[i] - count) < Math.abs(STAR_STOPS[best] - count)) best = i;
                }
                return best;
        }
        function syncStars() {
                sliderStars.value = nearestStarStop(params.stars);
                valStars.textContent = formatStars(params.stars);
        }
        function setStarBudget(count) {
                const next = renderer.setProceduralStars(count);
                if (next === params.stars) return;
                params.stars = next;
                syncStars();
                redrawField(model);
        }
        sliderStars.addEventListener('input', () => {
                valStars.textContent = formatStars(STAR_STOPS[Number(sliderStars.value)]);
        });
        sliderStars.addEventListener('change', () => setStarBudget(STAR_STOPS[Number(sliderStars.value)]));
        syncStars();

        // Star clusters (plan §10): the exaggeration coefficient, applied
        // on release like the star budget it multiplies — the re-draw
        // re-allocates the object block at the new size. The readout
        // follows the drag.
        const sliderClusters = document.getElementById('slider-clusters');
        const valClusters = document.getElementById('val-clusters');
        function syncClusters() {
                sliderClusters.value = params.clusters;
                valClusters.textContent = '×' + params.clusters;
        }
        sliderClusters.addEventListener('input', () => {
                valClusters.textContent = '×' + Number(sliderClusters.value);
        });
        sliderClusters.addEventListener('change', () => {
                const next = renderer.setClusterExaggeration(Number(sliderClusters.value));
                if (next === params.clusters) { syncClusters(); return; }
                params.clusters = next;
                syncClusters();
                redrawField(model);
        });
        syncClusters();

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

        // --- Star selection (0.5.0, plan §3) ---------------------------------
        // One "pick" shape everywhere: { key, kind, index, x, y, z, colorIndex,
        // absMag } — what selection.pickAny fills, what selection.selectAround's
        // SoA holds, and what planets.stellarInputs reads. `kind` is the block
        // index and equals PlanetsLib.BLOCK_*.
        const selectPlanets = window.PlanetsLib;
        const LY_PER_KPC = 1 / window.Camera.LY_TO_KPC;

        // The designation of a set member (plan §4.11): a landmark keeps its name,
        // anything else is S<key in base36>. Built when the primary changes, not
        // per frame — the overlay is text at 4 Hz and still must not concatenate.
        function memberName(i) {
                if (starSet.blockKind[i] === selectPlanets.BLOCK_LANDMARK) {
                        const entry = landmarks.ENTRIES[starSet.bufferIdx[i]];
                        if (entry) return entry.name;
                }
                return 'S' + (starSet.keys[i] >>> 0).toString(36).toUpperCase();
        }

        // A set member as a stellarInputs ref. `index` is block-local, which is
        // what both the field arrays and the object member context are indexed by;
        // a slot that no longer matches its key falls back to the record path, so a
        // stale index degrades to an approximation instead of another star.
        function memberRefFor(i) {
                memberRef.kind = starSet.blockKind[i];
                memberRef.key = starSet.keys[i] >>> 0;
                memberRef.index = starSet.bufferIdx[i];
                memberRef.x = starSet.x[i];
                memberRef.y = starSet.y[i];
                memberRef.z = starSet.z[i];
                memberRef.colorIndex = starSet.colorIndex[i];
                memberRef.absMag = starSet.absMag[i];
                if (memberRef.kind === selectPlanets.BLOCK_FIELD) {
                        const field = renderer.fieldBuffers();
                        const key = window.StarTypesLib.fieldStarSeed(model.seed, memberRef.index) >>> 0;
                        if (memberRef.index >= field.count || key !== (memberRef.key >>> 0)) memberRef.kind = -1;
                } else if (memberRef.kind === selectPlanets.BLOCK_OBJECT) {
                        const info = renderer.starBlocks();
                        if (memberRef.index >= info.blocks[selectPlanets.BLOCK_OBJECT].count) memberRef.kind = -1;
                }
                return memberRef;
        }

        function deriveMemberInputs(i) {
                const ref = memberRefFor(i);
                return selectPlanets.stellarInputs(ref, {
                        model,
                        field: renderer.fieldBuffers(),
                        member: renderer.starBlocks().member,
                }, starInputs);
        }

        function syncSetUi() {
                labels.setSelectedKeys(starSet.keys, starSet.count);
        }

        // --- Re-resolving the set after a re-sample (0.6, plan E1b) -----------
        // An age change re-draws the field: the epoch tier moves the disc the
        // sampler draws from, so the star in a member's slot is a different star
        // and the member's snapshot describes a record that is no longer on
        // screen. The key is the invariant — `fieldStarSeed(seed, slot)` does not
        // read the age — so the set is re-resolved by key: one pass over the live
        // blocks fills a small open-addressed map of the set's keys (the same scan
        // label-layer's map runs for the rings), and every hit rewrites the
        // member's slot, position, colour, magnitude and five stellar inputs from
        // the record it now names. A key that is not resident keeps its readout
        // line and loses its slot — the ring's existing missing-slot behaviour.
        const RESOLVE_SIZE = 1024;              // ≤ 256 members, so ≤ 25% load
        const RESOLVE_MASK = RESOLVE_SIZE - 1;
        const resolveKey = new Uint32Array(RESOLVE_SIZE);
        const resolveMember = new Int32Array(RESOLVE_SIZE);
        const resolveUsed = new Uint8Array(RESOLVE_SIZE);
        const resolvePick = {
                key: 0, kind: 0, index: 0, x: 0, y: 0, z: 0,
                colorIndex: 0, absMag: 0, approximated: 0,
        };

        function resolveProbe(key, forInsert) {
                let slot = (Math.imul(key, 0x9e3779b1) >>> 0) & RESOLVE_MASK;
                let guard = 0;
                while (resolveUsed[slot] && resolveKey[slot] !== key) {
                        if (++guard > RESOLVE_SIZE) return -1;
                        slot = (slot + 1) & RESOLVE_MASK;
                }
                if (resolveUsed[slot]) return slot;
                return forInsert ? slot : -1;
        }

        function resolveSet() {
                const info = renderer.starBlocks();
                const count = starSet.count;
                if (!info || !info.identity || !info.view || count <= 0) return;
                const identity = info.identity;
                const view = info.view;
                const blocks = info.blocks;
                const cam = camera.cameraPos;
                resolveUsed.fill(0);
                for (let i = 0; i < count; i++) {
                        const key = starSet.keys[i] >>> 0;
                        const home = resolveProbe(key, true);
                        if (home < 0) return;                   // table full: leaves the set alone
                        resolveUsed[home] = 1;
                        resolveKey[home] = key;
                        resolveMember[home] = i;
                        starSet.bufferIdx[i] = -1;
                }
                for (let k = 0; k < blocks.length; k++) {
                        const block = blocks[k];
                        const n = block.count | 0;
                        if (n <= 0) continue;
                        const offset = block.offset | 0;
                        for (let slot = 0; slot < n; slot++) {
                                const global = offset + slot;
                                const home = resolveProbe(identity[global] >>> 0, false);
                                if (home < 0 || starSet.bufferIdx[resolveMember[home]] >= 0) continue;
                                const byteOffset = global * window.StarRecord.RECORD_BYTES;
                                const packed = view.getUint32(byteOffset + 12, true);
                                if ((packed & (window.StarRecord.FLAG_VISIBLE << 16)) === 0) continue;
                                // Block-local, which is what stellarInputs indexes
                                // both the field arrays and the member context by.
                                resolvePick.key = resolveKey[home];
                                resolvePick.kind = k;
                                resolvePick.index = slot;
                                resolvePick.x = view.getFloat32(byteOffset, true);
                                resolvePick.y = view.getFloat32(byteOffset + 4, true);
                                resolvePick.z = view.getFloat32(byteOffset + 8, true);
                                resolvePick.colorIndex = packed & 0xFF;
                                resolvePick.absMag = window.StarRecord.decodeAbsMag((packed >>> 8) & 0xFF);
                                resolvePick.approximated = 0;
                                const inputs = selectPlanets.stellarInputs(resolvePick, {
                                        model,
                                        field: renderer.fieldBuffers(),
                                        member: info.member,
                                }, starInputs);
                                starSet.insert(resolvePick, inputs, cam[0], cam[1], cam[2], slot);
                        }
                }
        }

        // Plain click → the set is that one star; Shift+click → membership toggles
        // and the primary stays where it is (plan §3.2).
        function applyPick(hit, additive) {
                const cam = camera.cameraPos;
                const inputs = selectPlanets.stellarInputs(hit, {
                        model,
                        field: renderer.fieldBuffers(),
                        member: renderer.starBlocks().member,
                }, starInputs);
                if (additive) starSet.toggle(hit, inputs, cam[0], cam[1], cam[2], hit.index);
                else starSet.setSingle(hit, inputs, cam[0], cam[1], cam[2], hit.index);
                if (starSet.count > 0 && starSet.primary < 0) starSet.setPrimary(0);
                setLabel = '';
                syncSetUi();
        }

        function clearSelection() {
                // The system view is the primary's view: no primary, no
                // schematic. X, R and a galaxy change all come through here.
                if (systemLayer.isOpen()) closeSystemView();
                starSet.clear();
                setLabel = '';
                selected = -1;
                labels.setSelected(-1);
                syncSetUi();
        }

        function selectionRadiusKpc() {
                return Math.pow(10, Number(sliderSelRad.value)) * window.Camera.LY_TO_KPC;
        }

        // Plan §3.3: the primary first (from its own snapshot — it is never
        // re-derived from a record that may no longer be resident), then the scan's
        // members in ascending distance.
        function selectAroundPrimary() {
                const p = starSet.primary;
                if (p < 0) return 0;
                const cam = camera.cameraPos;
                const px = starSet.x[p], py = starSet.y[p], pz = starSet.z[p];
                const radiusKpc = selectionRadiusKpc();
                const primaryKey = starSet.keys[p];
                const primaryKind = starSet.blockKind[p];
                const primarySlot = starSet.bufferIdx[p];
                const primaryInputs = {
                        mass: starSet.mass[p], lum: starSet.lum[p], teff: starSet.teff[p],
                        age: starSet.age[p], metal: starSet.metal[p],
                };
                const primaryColor = starSet.colorIndex[p];
                const primaryMag = starSet.absMag[p];
                const n = selection.selectAround(px, py, pz, radiusKpc, starSet.capacity);
                starSet.clear();
                aroundPick.key = primaryKey; aroundPick.kind = primaryKind; aroundPick.index = primarySlot;
                aroundPick.x = px; aroundPick.y = py; aroundPick.z = pz;
                aroundPick.colorIndex = primaryColor; aroundPick.absMag = primaryMag;
                aroundPick.approximated = starSet.approximated[p] ? 1 : 0;
                starSet.setPrimary(starSet.insert(aroundPick, primaryInputs,
                        cam[0], cam[1], cam[2], primarySlot));
                const around = selection.around;
                for (let i = 0; i < n; i++) {
                        // The scan's own row is pick-shaped, so it feeds
                        // stellarInputs directly — through one reused record, so a
                        // radius select allocates nothing at all.
                        aroundPick.key = around.keys[i];
                        aroundPick.kind = around.kind[i];
                        aroundPick.index = around.index[i];
                        aroundPick.x = around.x[i];
                        aroundPick.y = around.y[i];
                        aroundPick.z = around.z[i];
                        aroundPick.colorIndex = around.colorIndex[i];
                        aroundPick.absMag = around.absMag[i];
                        aroundPick.approximated = around.approximated[i];
                        const inputs = selectPlanets.stellarInputs(aroundPick, {
                                model,
                                field: renderer.fieldBuffers(),
                                member: renderer.starBlocks().member,
                        }, starInputs);
                        starSet.insert(aroundPick, inputs, cam[0], cam[1], cam[2], around.index[i]);
                }
                const dropped = starSet.dropped > 0 ? ` (+${starSet.dropped} dropped)` : '';
                setLabel = `${Math.max(1, starSet.count - 1)} stars within ` +
                        `${formatLy(radiusKpc * LY_PER_KPC)} of ${memberName(starSet.primary)}${dropped}`;
                syncSetUi();
                return starSet.count;
        }

        // Light-years, for a readout that is about stars rather than galaxy structure.
        function formatLy(ly) {
                if (ly >= 10000) return `${(ly / 1000).toFixed(0)} kly`;
                if (ly >= 1000) return `${(ly / 1000).toFixed(1)} kly`;
                return ly >= 100 ? `${ly.toFixed(0)} ly` : `${ly.toFixed(1)} ly`;
        }

        // F (plan §3.4): orbit the primary at the stand-off its luminosity implies.
        function flyToPrimary() {
                const i = starSet.primary;
                if (i < 0) return false;
                const standOff = camera.orbitStandOff(starSet.lum[i]);
                camera.flyToStar(starSet.x[i], starSet.y[i], starSet.z[i], memberName(i), standOff);
                return true;
        }

        function cyclePrimary(delta) {
                if (starSet.count === 0) return;
                starSet.cyclePrimary(delta);
        }

        function cameraLine(c) {
                if (c.mode === window.Camera.MODE_FLY) {
                        return `camera ${c.modeName}   speed ${formatSpeed(c.speedLyPerSec)}  (x${c.speedMult})${formatFactor(c.speedFactor)}`;
                }
                return `camera ${c.modeName}   ${c.targetName}   distance ${formatDistance(c.orbitDistance)}`;
        }

        function selectedLine(cameraState) {
                if (selected < 0 || cameraState.mode !== window.Camera.MODE_FLY) return '';
                return `\nselected ${landmarks.ENTRIES[selected].name}   (C cycles to orbit object)`;
        }

        // The system brief: the primary's generated system on one line — the
        // star, the counts, and a strip of body icons with the gap between
        // neighbours in AU (☀️-0.39-🌋-0.33-🌍-…) — so a star can be judged
        // before V opens the schematic. Generated when the primary or the field
        // it was resolved against changes, never per overlay tick.
        const BODY_ICONS = {
                LAVA: '\u{1F30B}', BARREN: '\u{1F311}', DESERT: '\u{1F7E0}', TERRAN: '\u{1F30D}',
                ICE: '\u{1F9CA}', SUPER_EARTH: '\u{1F30F}', MINI_NEPTUNE: '\u{1F4A7}',
                GAS_GIANT: '\u{1FA90}', ICE_GIANT: '\u{1F535}', DWARF: '\u26AB',
        };
        const DISPLAY_ICON = selectPlanets.DISPLAY_TYPES.map((t) => BODY_ICONS[t.name] || '\u2022');
        const STAR_ICON = { ms: '\u2600\uFE0F', giant: '\u{1F534}', wd: '\u26AA' };
        const STAR_STATE = { ms: '', giant: ' giant', wd: ' white dwarf' };
        const BELT_ICON = '\u2604\uFE0F';
        const briefRecord = selectPlanets.createSystemRecord();
        const briefCtx = {};
        let briefKey = -1;
        let briefModel = null;
        let briefText = '';

        function formatGapAU(d) {
                if (d < 1) return d.toPrecision(2);
                return d < 10 ? d.toFixed(1) : String(Math.round(d));
        }

        function buildSystemBrief(p) {
                const ref = memberRefFor(p);
                briefCtx.model = model;
                briefCtx.field = renderer.fieldBuffers();
                briefCtx.member = renderer.starBlocks().member;
                briefCtx.name = landmarkNameFor(p);
                const rec = selectPlanets.generateSystem(ref, briefCtx, briefRecord);
                const n = rec.counts.planets;
                const belts = rec.belts;
                let text = `\nsystem    ${rec.star.spectralClass}${STAR_STATE[rec.star.state] || ''} \u00b7 ` +
                        `${n === 0 ? 'no' : n} planet${n === 1 ? '' : 's'}` +
                        (belts.count ? `, ${belts.count} belt${belts.count === 1 ? '' : 's'}` : '') + '   ' +
                        (STAR_ICON[rec.star.state] || STAR_ICON.ms);
                // Planets and belts are each ascending in a; merge the two walks.
                let i = 0, k = 0, last = 0;
                while (i < n || k < belts.count) {
                        const takePlanet = k >= belts.count || (i < n && rec.planets.a[i] <= belts.a[k]);
                        const a = takePlanet ? rec.planets.a[i] : belts.a[k];
                        const icon = takePlanet ? DISPLAY_ICON[rec.planets.displayType[i]] : BELT_ICON;
                        text += `-${formatGapAU(a - last)}-${icon}`;
                        last = a;
                        if (takePlanet) i++;
                        else k++;
                }
                return n || belts.count ? text + ' AU' : text;
        }

        function systemBriefLine(p) {
                if (systemLayer.isOpen()) return '';
                const key = starSet.keys[p] >>> 0;
                if (key !== briefKey || model !== briefModel) {
                        briefKey = key;
                        briefModel = model;
                        briefText = buildSystemBrief(p);
                }
                return briefText;
        }

        // The selection readout (plan §3.6). One line for the primary — class, mass,
        // luminosity, distance — and one for the set. Any member's snapshot fields
        // are shown, so a pick never has to re-derive anything to be described.
        function selectionLines(cameraState) {
                const i = starSet.primary;
                if (i < 0) return '';
                const cam = cameraState.position;
                const dx = starSet.x[i] - cam[0];
                const dy = starSet.y[i] - cam[1];
                const dz = starSet.z[i] - cam[2];
                const distLy = Math.sqrt(dx * dx + dy * dy + dz * dz) * LY_PER_KPC;
                const cls = window.StarRecord.SPECTRAL_CLASSES[starSet.colorIndex[i]] || '?';
                let text = `\nselected  ${memberName(i)}  (${cls}, ${starSet.mass[i].toFixed(2)} M\u2609, ` +
                        `${starSet.lum[i].toFixed(2)} L\u2609, ${formatLy(distLy)})`;
                if (starSet.approximated[i]) text += '  \u00b7 position approximate under this engine mask';
                text += systemBriefLine(i);
                if (starSet.count > 1) {
                        text += `\nset       ${setLabel || `${starSet.count} stars`}` +
                                ' \u00b7 N next \u00b7 X clear \u00b7 F fly to';
                } else {
                        text += '   \u00b7 Shift+click adds \u00b7 F fly to';
                }
                return text;
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
                        ` + objects ${state.objectStars.toLocaleString()} (${state.clusterCount.toLocaleString()} star clusters in this galaxy, ${state.gasObjectCount.toLocaleString()} gas)` +
                        ` + nebulae ${state.nebulaBillboards.toLocaleString()} (gas only — clusters are stars, no billboard)` +
                        ` + local ${state.localProceduralStars.toLocaleString()}` +
                        ` + catalog ${catKept.toLocaleString()}/${state.catalogTotalStars.toLocaleString()}\n` +
                        `cells ${state.cellsResident}/${state.catalogCells}   decoded ${(state.decodedBytes / 1024).toFixed(0)} KB` +
                        `   buffer ${(state.bufferBytes / 1048576).toFixed(1)} MB\n` +
                        `exposure ${shutter} ([ / ])   brightness ${linExp}x (; / ')   white ${wp}   sat ${sat}   engine ${state.engine}   constellations ${labels.constellationsVisible() ? 'on' : 'off'} (P)   star time ${window.OrbitLib.formatTimeRate(starTimeRate, 0)} (T)${evolveOn ? ' +evolve' : ''}   wave ${waveDamping === 0 ? 'off' : waveDamping.toFixed(2)}   pattern ${window.OrbitLib.effectivePatternSpeed(model).toFixed(3)} rad/Myr (x${patternScale.toFixed(2)})   Tab menu\n` +
                        `pos (${cameraState.position[0].toFixed(3)}, ${cameraState.position[1].toFixed(3)}, ${cameraState.position[2].toFixed(3)}) kpc\n` +
                        cameraLine(cameraState) +
                        selectionLines(cameraState) +
                        selectedLine(cameraState);
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
                // The pattern's phase (0.6 E4) is integrated with the frame's own
                // star time *before* anything places a star, so the bar and the
                // arms cannot be a frame behind the clock — and a rate change
                // (the epoch re-derives Ω_p, the slider rescales it) adds no jump
                // because nothing multiplies the current rate by the clock. A
                // star-time seek turns the pattern the way the stars turn with
                // it, because the phase is advanced over the interval, not
                // recomputed from the end of it.
                window.OrbitLib.setPatternClock(starTimeMyr, model);
                labels.setOrbitState(model, starTimeMyr);
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
                        selected = -1;
                        labels.setSelected(-1);
                        clearSelection();
                        renderer.resetSimpleState();
                        initSimpleLandmarks();
                }

                if (actions.galaxyCycle) {
                        actions.galaxyCycle = 0;
                        regenerateGalaxy(galaxy.cycleGalaxyType(model.type), model.seed, model.populations.age);
                }
                // The age slider's trailing edge: applied here, in loop time, so
                // the value the user let go of is the one that lands. Since E4 an
                // epoch change is not a rebuild at all, so the drag is applied
                // every frame it changed rather than on a throttle.
                if (pendingAge !== null && pendingAge !== model.populations.age) setEpoch(pendingAge);
                pendingAge = null;
                // The epoch's live clock (E4): the same dt the stars just integrated,
                // one Age-slider step per AGE_STEP·1000 Myr of star time, applied
                // every frame. E4 places the field from the epoch instead of
                // re-drawing it (orbit.epochMap), so an epoch step costs a model
                // re-solve and a uniform, not a 300k-star rebuild: no throttle, no
                // debt, no visible step to hide.
                if (evolveOn) {
                        const evolved = galaxy.evolveAge(model.populations.age, dtStar);
                        if (evolved !== model.populations.age) setEpoch(evolved);
                }
                labels.setOrbitState(model, starTimeMyr);
                selection.setOrbitState(model, starTimeMyr);
                if (actions.pick) {
                        actions.pick = 0;
                        if (systemLayer.isOpen()) {
                                // Schematic picking (plan §6.3): exact and
                                // immediate — the layer already has every body's
                                // screen position. An empty click clears the body
                                // selection but does not leave the view.
                                if (systemLayer.isMapOpen()) {
						if (systemLayer.pickDvNode(input.state.pickX, input.state.pickY, dvPick)) systemLayer.chooseRouteNode(dvPick.body, dvPick.node);
					} else {
						systemLayer.pick(input.state.pickX, input.state.pickY, bodyPick);
						if (bodyPick.kind === window.SystemLayer.BODY_NONE) systemLayer.clearBodySelection();
						else systemLayer.setSelected(bodyPick.kind, bodyPick.index);
					}
                                writeSystemReadout();
                        } else {
                                const px = input.state.pickX;
                                const py = input.state.pickY;
                                const w = canvas.clientWidth;
                                const h = canvas.clientHeight;
                                // Any drawn star (plan §3.1): the walk covers the five
                                // blocks, so a procedural star, an object member, a catalog
                                // star and a landmark are all selectable. It is chunked
                                // across frames (the walk is dispatch-bound), so the click
                                // only starts it — `pendingShift` carries the click's
                                // modifier to the frame the sweep finishes on.
                                pendingShift = input.state.keys.boost ? 1 : 0;
                                selection.beginPick(px, py, w, h, pickOut);
                        }
                }
                // Walk the pending sweep a slice further; the frame it finishes on
                // is the frame the selection changes. A miss stays a no-op.
                if (pendingShift >= 0 && selection.pickStep(PICK_SLICE_RECORDS, PICK_SLICE_MS)) {
                        const hit = selection.pickResult();
                        const additive = pendingShift === 1;
                        pendingShift = -1;
                        if (hit) {
                                applyPick(hit, additive);
                                // A landmark keeps the old behaviour on top of the
                                // snapshot: the yellow label ring and the orbit
                                // target, which is what makes C -> orbit object land
                                // on a named star.
                                if (hit.kind === selectPlanets.BLOCK_LANDMARK && model.milkyWay) {
                                        selected = hit.index;
                                        labels.setSelected(hit.index);
                                        camera.setOrbitTarget(hit.x, hit.y, hit.z, landmarks.ENTRIES[hit.index].name);
                                } else {
                                        selected = -1;
                                        labels.setSelected(-1);
                                }
                                // The schematic is the primary's view: the rare
                                // pick that lands while it is open (V pressed
                                // mid-sweep) switches it to the new star.
                                if (!additive && systemLayer.isOpen()) openSystemView(true);
                        }
                }
                if (actions.flyTo) {
                        actions.flyTo = 0;
                        flyToPrimary();
                }
                if (actions.nextStar) {
                        actions.nextStar = 0;
                        cyclePrimary(input.state.keys.boost ? -1 : 1);
                        // The view follows the primary (plan §3.2): cycling with
                        // the schematic open walks the systems, camera included.
                        if (systemLayer.isOpen()) openSystemView(true);
                }
                if (actions.clearSet) {
                        actions.clearSet = 0;
                        clearSelection();
                }
                if (actions.systemView) {
                        actions.systemView = 0;
                        toggleSystemView();
                }
                if (actions.systemViewExit) {
                        actions.systemViewExit = 0;
                        closeSystemView();
                }
                if (actions.dvMap) {
                        actions.dvMap = 0;
                        if (systemLayer.isOpen()) cycleDvView();
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
                // The schematic (plan §6): its own clock first, then hover and
                // the draw. Closed, the whole block is one boolean test.
                if (systemLayer.isOpen()) {
                        systemLayer.stepTime(dt, cameraStateForTime.speedLyPerSec);
                        systemLayer.updateHover(hoverX, hoverY);
                        systemLayer.resize(canvas.clientWidth, canvas.clientHeight, currentDpr());
                        // Both panels inset themselves: the map is fitted between
                        // them, so neither covers the graph.
                        systemLayer.draw(canvas.clientWidth, canvas.clientHeight,
                                menu.style.display === 'none' ? 0 : 284,
                                sysMenu.style.display === 'none' ? 0 : 292);
                }

                overlayTimer += dt;
                if (overlayTimer >= OVERLAY_INTERVAL) {
                        overlayTimer = 0;
                        updateOverlay(renderer.state, camera.getState(statsText));
                        if (systemLayer.isOpen()) writeSystemReadout();
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
                };
}
