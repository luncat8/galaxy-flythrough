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
		trade: number('trade', window.TradeLib.TRADE_RATE_DEFAULT),
		traderoutes: number('traderoutes', window.TradeLib.TRADE_ROUTES_DEFAULT),
		ship: text('ship', 'chemical'),
		// View modes (view-modes.6): the heightmap panel's render type,
		// projection, anchor source and look knobs — defaulted by the module
		// that owns the numbers.
		viewmode: text('viewmode', window.ViewModesLayer.DEFAULTS.mode),
		viewproj: text('viewproj', window.ViewModesLayer.DEFAULTS.projection),
		viewsource: text('viewsource', window.ViewModesLayer.DEFAULTS.source),
		viewanchors: number('viewanchors', window.ViewModesLayer.DEFAULTS.anchors),
		viewramp: text('viewramp', window.ViewModesLayer.DEFAULTS.ramp),
		viewrelief: number('viewrelief', window.ViewModesLayer.DEFAULTS.relief),
		viewopacity: number('viewopacity', window.ViewModesLayer.DEFAULTS.opacity),
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
        // Star-time slider range: fine (−1…2 Myr/s, 0.1 steps) by default so
        // small rates such as 0.1 Myr/s are settable; the range toggle widens
        // to −1…99 Myr/s in 0.5 steps.
        let starTimeWide = false;
        // Game mode (game-mode-plan.md G1): the ship record and the toggle.
        // Declared beside the time axis it takes over while flying (§4 — the
        // ship clock and the stars' drift are one rate), and early enough that
        // every boot-time repaint (the slider dress, the data-game row gating)
        // reads the live flag. The physical state — velocity, tank, life —
        // outlives the toggle; the observer's Myr/s rate stays parked in
        // starTimeRate and is simply not consulted while the ship's clock runs.
        const shipLib = window.Ship;
        // The colony economy (trade series): its own clock, its own records,
        // and one network per galaxy. Seeded in tradeSeedNetwork() once the
        // renderer exists; the clock is a geometric ladder in years per wall
        // second, independent of the star and ship clocks.
        const tradeLib = window.TradeLib;
        const economyLib = window.EconomyLib;
        let tradeNet = null;
        // The model the live network was seeded from (type:seed). A regenerate
        // that lands on the same value keeps it: the colonies, their stocks and
        // the clock survive an epoch change.
        let tradeModelKey = '';
        // The preset/query value is years per second, not a slider stop: the
        // ladder is owned by trade.js, so the boot maps it back to the nearest
        // stop (a query may name a rate between stops and still mean it).
		let tradeRateIndex = tradeRateIndexFor(params.trade);
		let tradeRoutesOn = params.traderoutes > 0 ? 1 : 0;
		// The trade clock can be coupled to the star clock (sync time), and the
		// special trade mode flies generation ships at 1 ly per 10 kyr.
		let tradeSyncOn = 0;
		let tradeGenOn = 0;
		let gameMode = false;
        const AUTOPILOT_MIN_WALL_SECONDS = 4;
        let shipTimeRateCapY = Infinity;
        let ship = shipLib.createShip(params.ship);
        const fleet = [{ id: 1, name: 'Ship 1', ship, positioned: false, entered: false, button: null }];
        let activeFleetShip = fleet[0];
        let nextFleetId = 2;
        // G3's Flight workspace owns one destination snapshot and one reusable
        // forecast record. They are UI/state records, not render data: the target
        // is still resolved by key through Selection every frame.
        const flightPlan = shipLib.createFlightPlan();
        const flightDestination = {
                active: false, key: 0, kind: -1, index: -1,
                x: 0, y: 0, z: 0, colorIndex: 0, absMag: 0,
                lum: 1, name: '',
        };
        let flightThrust = 0;
        let flightSpeedFraction = 0.75;
        // The Pilot controls are mutually exclusive (the two answers to
        // "how fast"): the last one touched owns the forward axis. In
        // thrust control the lever commands the burn and no speed is
        // held; in speed control the desired speed cuts forward thrust
        // and the lever is off duty.
        let flightControl = 'speed';
        let flightMode = shipLib.NAV_FASTEST;
        let flightTimeLimitYears = 20;
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
        const shipChrome = window.LabelLayer.createShipChromeState();
        labels.setShipChrome(shipChrome);

        const selection = window.Selection.createSelection(camera, landmarks);
        const selectionStore = window.SelectionStore.createSelectionStore();
        let selected = -1;

        // The selection set (0.5.0, plan §3.2): snapshots keyed by the renderer's
        // per-record identity. `pickOut` is the pick record selection.pickAny fills
        // in place and `starInputs` the derived stellar fields — both reusable; the
        // separate typed history takes its own snapshot on selection.
        const starSet = window.StarSet.createStarSet();
        const pickOut = {};
        const starInputs = {};
        const memberRef = { kind: 0, key: 0, index: 0, x: 0, y: 0, z: 0, colorIndex: 0, absMag: 0 };
        const searchPick = { key: 0, kind: 0, index: 0, x: 0, y: 0, z: 0, colorIndex: 0, absMag: 0, approximated: 0 };
        const historyPick = { key: 0, kind: 0, index: 0, x: 0, y: 0, z: 0, colorIndex: 0, absMag: 0, approximated: 0 };
        const historyInputs = { mass: 0, lum: 0, teff: 0, age: 0, metal: 0 };
        const aroundPick = { key: 0, kind: 0, index: 0, x: 0, y: 0, z: 0, colorIndex: 0, absMag: 0 };
        // One scratch for "where is this star drawn right now" (ui.2). A snapshot's
        // x/y/z is the record's *birth* position — the one `stellarInputs` decomposes
        // the density at, so it never changes meaning — while the camera, the radius
        // scan, the readout and a route's separation are about the star the user is
        // looking at. `selection.resolveDrawn` is the bridge: the same engine-mask
        // dispatch the vertex stage, the labels and the picker run, and it falls back
        // to the snapshot (reporting DRAWN_STALE) when the record is not resident.
        const drawnPos = new Float64Array(3);
        function memberDrawnPosition(i, out) {
                return selection.resolveDrawn(memberRefFor(i), out);
        }
        // The member's drawn *motion*, kpc per ship-second (ui.15) — the same
        // dispatch sampled a fixed model-time baseline, so it stays exact at the
        // fine clock rungs where a frame is below the drawn position's own ULP.
        function memberDrawnVelocity(i, out) {
                return selection.resolveDrawnVelocity(memberRefFor(i), out);
        }
        // Both buffer sweeps — the click pick (plan §3.1) and the radius scan
        // (§3.3) — are spread over frames. A slice is bounded by time as well as
        // by records, because the per-record dispatch cost depends on the engine
        // mask: ~0.37 µs classic, ~1.5 µs with the apocenter pass (measured in
        // experiments/star-select-test.js), so a record-only budget would be a
        // 2 ms slice under one mask and a 40 ms hitch under another.
        // `pendingShift`: -1 = no pick sweep pending, 0/1 = pending, with the
        // click's Shift state for the frame it finishes on.
        const SWEEP_SLICE_RECORDS = 32768;
        const SWEEP_SLICE_MS = 8;
        let pendingShift = -1;
        let aroundPending = false;    // a radius scan is walking its slices
        let aroundRadiusKpc = 0;      // the radius the pending scan was begun with
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

        // --- Settings and selection panels (Tab toggles all) -----------------
        const menu = document.getElementById('menu');
        const menuCollapse = document.getElementById('menu-collapse');
        const selectionMenu = document.getElementById('selection-menu');
        const selectionMenuCollapse = document.getElementById('selection-menu-collapse');
        const tradeMenu = document.getElementById('trade-menu');
        const tradeMenuCollapse = document.getElementById('trade-menu-collapse');
        const currentSelectionLabel = document.getElementById('selection-current-label');
        const previousSelectionLabel = document.getElementById('selection-previous-label');
        const swapSelectionButton = document.getElementById('selection-swap');
        const assetCurrentLabel = document.getElementById('asset-current-label');
        const assetPreviousLabel = document.getElementById('asset-previous-label');
        const assetPairFirst = document.getElementById('asset-pair-first');
        const assetPairSecond = document.getElementById('asset-pair-second');
        const sliderExp = document.getElementById('slider-exposure');
        const sliderBright = document.getElementById('slider-brightness');
        const sliderWhite = document.getElementById('slider-white');
        const sliderSat = document.getElementById('slider-saturation');
        const sliderHeadroom = document.getElementById('slider-headroom');
        const sliderHighlight = document.getElementById('slider-highlight');
        // View modes (view-modes.6): its own panel — render type, projection,
        // anchor source and the island's look knobs.
        const viewMenu = document.getElementById('viewmenu');
        const viewMenuCollapse = document.getElementById('viewmenu-collapse');
        const vmStatus = document.getElementById('vm-status');
        const sliderVmAnchors = document.getElementById('slider-vm-anchors');
        const valVmAnchors = document.getElementById('val-vm-anchors');
        const sliderVmSigma = document.getElementById('slider-vm-sigma');
        const valVmSigma = document.getElementById('val-vm-sigma');
        const sliderVmSpan = document.getElementById('slider-vm-span');
        const valVmSpan = document.getElementById('val-vm-span');
        const sliderVmRes = document.getElementById('slider-vm-res');
        const valVmRes = document.getElementById('val-vm-res');
        const sliderVmRelief = document.getElementById('slider-vm-relief');
        const valVmRelief = document.getElementById('val-vm-relief');
        const sliderVmOpacity = document.getElementById('slider-vm-opacity');
        const valVmOpacity = document.getElementById('val-vm-opacity');
        const sliderVmRangeLo = document.getElementById('slider-vm-range-lo');
        const valVmRangeLo = document.getElementById('val-vm-range-lo');
        const labelVmRangeLo = document.getElementById('label-vm-range-lo');
        const sliderVmRangeHi = document.getElementById('slider-vm-range-hi');
        const valVmRangeHi = document.getElementById('val-vm-range-hi');
        const labelVmRangeHi = document.getElementById('label-vm-range-hi');
        const vmAutoRange = document.getElementById('vm-auto-range');
        const vmChecks = {
                contours: document.getElementById('vm-contours'),
                grid: document.getElementById('vm-grid'),
                drawStars: document.getElementById('vm-stars'),
                names: document.getElementById('vm-names'),
                smooth: document.getElementById('vm-smooth'),
                invert: document.getElementById('vm-invert'),
                followLook: document.getElementById('vm-follow'),
                mirrorChart: document.getElementById('vm-mirror'),
        };
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
        const btnFlyTo = document.getElementById('btn-fly-to');
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

        // View modes (view-modes.6): the layer owns the numbers (the island's
        // field, anchored on the renderer's own stars); the panel mirrors them.
        const viewModesLayer = window.ViewModesLayer.createViewModesLayer(
                document.getElementById('viewmodes'), {
                        camera,
                        model: () => model,
                        starBlocks: () => renderer.starBlocks(),
                        selection: () => starSet,
                        landmarks,
                });

        const vmRadioGroups = {
                mode: document.querySelectorAll('input[name="vm-mode"]'),
                projection: document.querySelectorAll('input[name="vm-proj"]'),
                source: document.querySelectorAll('input[name="vm-source"]'),
                budget: document.querySelectorAll('input[name="vm-budget"]'),
                ramp: document.querySelectorAll('input[name="vm-ramp"]'),
        };

        function syncRadio(name, value) {
                const group = vmRadioGroups[name];
                for (const radio of group) radio.checked = radio.value === value;
        }

        function syncViewModes() {
                const s = viewModesLayer.settings;
                syncRadio('mode', s.mode);
                syncRadio('projection', s.projection);
                syncRadio('source', s.source);
                syncRadio('budget', s.budget);
                syncRadio('ramp', s.ramp);
                sliderVmAnchors.value = s.anchors;
                valVmAnchors.textContent = String(s.anchors);
                sliderVmSigma.value = s.sigmaDeg;
                valVmSigma.textContent = `${s.sigmaDeg}°`;
                sliderVmSpan.value = s.chartSpanDeg;
                valVmSpan.textContent = `${s.chartSpanDeg}°`;
                sliderVmRes.value = s.resH;
                valVmRes.textContent = s.resH ? `${s.resH} px` : 'auto';
                sliderVmRelief.value = s.relief;
                valVmRelief.textContent = s.relief > 0 ? `${s.relief}×` : 'off';
                sliderVmOpacity.value = s.opacity;
                valVmOpacity.textContent = `${Math.round(s.opacity * 100)}%`;
                for (const key of Object.keys(vmChecks)) vmChecks[key].checked = !!s[key];
                vmAutoRange.checked = s.autoRange;
                syncViewModesRange();
        }

        // The two range sliders quote the live window in the mode's own unit;
        // with auto on they only display it and stay disabled (the island's rule).
        function syncViewModesRange() {
                const s = viewModesLayer.settings;
                const l = viewModesLayer.live;
                const near = s.mode === 'height';
                labelVmRangeLo.textContent = near ? 'Near' : 'Range lo';
                labelVmRangeHi.textContent = near ? 'Far' : 'Range hi';
                sliderVmRangeLo.value = l.lo.toFixed(2);
                sliderVmRangeHi.value = l.hi.toFixed(2);
                sliderVmRangeLo.disabled = s.autoRange;
                sliderVmRangeHi.disabled = s.autoRange;
                valVmRangeLo.textContent = viewModesLayer.formatRange(l.lo);
                valVmRangeHi.textContent = viewModesLayer.formatRange(l.hi);
        }

        function applyViewModes(fields) {
                viewModesLayer.set(fields);
                syncViewModes();
        }

        syncSlidersFromRenderer();
        // Boot params, applied once the panel elements above exist; absent keys
        // are the module's own defaults.
        applyViewModes({
                mode: params.viewmode,
                projection: params.viewproj,
                source: params.viewsource,
                anchors: params.viewanchors,
                ramp: params.viewramp,
                relief: params.viewrelief,
                opacity: params.viewopacity,
        });

        // --- Selection controls (0.5.0, plan §3.3) --------------------------
        // The slider is log10(ly): 0.1 ly … 100 000 ly, default 50 ly. Decimal
        // exponent, so the readout is exact and the value is preset-friendly.
        function syncSelRad() {
                valSelRad.textContent = formatLy(Math.pow(10, Number(sliderSelRad.value)));
        }
        sliderSelRad.addEventListener('input', syncSelRad);
        syncSelRad();
        btnSelectAround.addEventListener('click', () => {
                // The scan walks the buffer in slices (plan §3.3): the click starts
                // it, the loop applies it on the frame it lands.
                beginSelectAroundPrimary();
                updateOverlay(renderer.state, camera.getState(statsText));
        });
        btnFlyTo.addEventListener('click', () => {
                if (!flyToPrimary()) return;
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
        const searchCenterSelect = document.getElementById('search-center');
        const searchRadiusBox = document.getElementById('search-radius-pc');
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
        const searchResultsList = document.getElementById('search-results');
        const assetTypeSelect = document.getElementById('asset-type');
        const assetIdBox = document.getElementById('asset-id');
        const assetNameBox = document.getElementById('asset-name');
        const assetSelectButton = document.getElementById('asset-select');
        const assetClearButton = document.getElementById('asset-clear');
        const assetPairFirstButton = document.getElementById('asset-pair-first-set');
        const assetPairSecondButton = document.getElementById('asset-pair-second-set');
        const sysread = document.getElementById('sysread');
        const searchClassNames = window.StarRecord.SPECTRAL_CLASSES;
        // window.PlanetsLib, not the selectPlanets alias: this block runs
        // before that alias is declared, and the namespace is already live.
        const searchTypeNames = window.PlanetsLib.DISPLAY_TYPES.map((t) => t.name);
        let searchSnapshot = [];
        let searchVersion = -1;
        const searchCenterPosition = new Float64Array(3);
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
                const radiusPc = searchNumberOr(searchRadiusBox.value, Infinity);
                f.distMax = radiusPc < Infinity ? radiusPc * LY_PER_PC : Infinity;
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
                searchRadiusBox.value = f.distMax < Infinity
                        ? String(Number((f.distMax / LY_PER_PC).toPrecision(7))) : '';
                terranCheck.checked = f.terranOnly;
                beltCheck.checked = f.needsBelt;
                barrenCheck.checked = f.barrenOnly;
        }

        // Results belong to the filter that ran them: any change clears the
        // report, the snapshot and the readout until the next Search.
        function markSearchStale() {
                searchSnapshot = [];
                searchVersion = -1;
                selectionStore.setSearchResults(window.SelectionStore.GROUP_SPACE, searchSnapshot);
                searchResultsList.textContent = '';
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
                searchRadiusBox, terranCheck, beltCheck, barrenCheck]) {
                el.addEventListener('change', onSearchControl);
        }
        tokenBox.addEventListener('change', () => {
                tokenBox.value = searchLib.formatFilter(searchLib.parseFilter(tokenBox.value));
                tokenToControls();
                markSearchStale();
        });
        scopeSelect.addEventListener('change', markSearchStale);
        searchCenterSelect.addEventListener('change', markSearchStale);

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
                const dist = (res.approximated[i] ? '~' : '')
                        + formatLy(Math.sqrt(res.dist2[i]) * LY_PER_KPC);
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

        function renderSearchResults(res) {
                const fragment = document.createDocumentFragment();
                for (let i = 0; i < res.count; i++) {
                        const button = document.createElement('button');
                        button.type = 'button';
                        button.className = 'search-result';
                        button.dataset.searchIndex = String(i);
                        button.textContent = searchRowLine(res, i);
                        button.setAttribute('role', 'option');
                        if (res.kind[i] === searchLib.KIND_UNRESOLVED) {
                                button.disabled = true;
                                button.title = 'This selected-set member is no longer resident; it cannot be selected from this result.';
                        } else if (res.approximated[i]) {
                                button.title = 'Distance is approximate under the active movement engine; the star identity is selectable.';
                        }
                        fragment.appendChild(button);
                }
                searchResultsList.replaceChildren(fragment);
                syncSelectionPanel();
        }

        function runSearch() {
                pauseStarTimeForSearch();
                controlsToToken();
                tokenBox.value = searchLib.formatFilter(searchLib.parseFilter(tokenBox.value));
                tokenToControls();
                const filter = searchLib.parseFilter(tokenBox.value);
                const scope = scopeSelect.value === 'galaxy' ? 'galaxy' : 'selection';
                const cam = camera.cameraPos;
                const selectedCenter = currentStarCenter();
                const useSelectedCenter = searchCenterSelect.value === 'current' && !!selectedCenter;
                let centerX = cam[0], centerY = cam[1], centerZ = cam[2];
                let centerPositionStatus = window.Selection.DRAWN_EXACT;
                if (useSelectedCenter) {
                        centerPositionStatus = selection.resolveDrawn(selectedCenter, searchCenterPosition);
                        centerX = searchCenterPosition[0];
                        centerY = searchCenterPosition[1];
                        centerZ = searchCenterPosition[2];
                }
                const searchTimeMyr = starTimeMyr;
                const t0 = performance.now();
                const res = search.run(filter, {
                        scope, camX: cam[0], camY: cam[1], camZ: cam[2],
                        centerX, centerY, centerZ,
                        time: searchTimeMyr,
                        model, renderer, set: starSet,
                });
                const ms = performance.now() - t0;
                searchSnapshot = [];
                let approximateCount = 0;
                for (let i = 0; i < res.count; i++) {
                        const approximated = res.approximated[i] ? 1 : 0;
                        if (approximated) approximateCount++;
                        searchSnapshot.push({
                                group: window.SelectionStore.GROUP_SPACE, type: 'star',
                                key: res.keys[i] >>> 0, kind: res.kind[i], index: res.index[i],
                                x: res.x[i], y: res.y[i], z: res.z[i],
                                colorIndex: res.colorIndex[i], absMag: res.absMag[i],
                                approximated,
                        });
                }
                selectionStore.setSearchResults(window.SelectionStore.GROUP_SPACE, searchSnapshot);
                searchVersion = renderer.starBlocks().dynamicVersion;
                const centerName = useSelectedCenter ? selectionLabel(selectedCenter) : 'camera';
                const centerQuality = !useSelectedCenter || centerPositionStatus === window.Selection.DRAWN_EXACT
                        ? '' : centerPositionStatus === window.Selection.DRAWN_APPROX
                                ? ' · approximate centre' : ' · snapshot centre';
                const radiusPc = searchNumberOr(searchRadiusBox.value, Infinity);
                const radiusText = radiusPc < Infinity ? ' · ' + Number(radiusPc.toPrecision(4)) + ' pc' : '';
                const approxText = approximateCount ? ` · ${approximateCount} approximate` : '';
                valSearch.textContent = res.stats.scope + ' · around ' + centerName + centerQuality + radiusText
                        + ' · snapshot ' + res.stats.timeMyr.toFixed(1) + ' Myr'
                        + ' · scanned ' + res.stats.scanned.toLocaleString()
                        + ' · matched ' + res.stats.matched.toLocaleString() + ' · kept ' + res.count
                        + approxText + ' · ' + ms.toFixed(ms < 10 ? 1 : 0) + ' ms';
                const lines = ['search ' + (tokenBox.value || '(all)') + ' · ' + valSearch.textContent];
                if (res.count === 0) lines.push('no matches');
                const show = Math.min(res.count, 12);
                for (let i = 0; i < show; i++) lines.push(searchRowLine(res, i));
                if (res.count > show) lines.push('… +' + (res.count - show) + ' more');
                sysreadSearchText = lines.join('\n');
                renderSearchResults(res);
                if (!systemLayer.isOpen()) sysread.textContent = sysreadSearchText;
                updateOverlay(renderer.state, camera.getState(statsText));
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
                        aroundPick.approximated = row.approximated ? 1 : 0;
                        const inputs = selectPlanets.stellarInputs(aroundPick, ctx, starInputs);
                        starSet.insert(aroundPick, inputs, cam[0], cam[1], cam[2], row.index);
                }
                if (starSet.count > 0 && starSet.primary < 0) starSet.setPrimary(0);
                setLabel = '';
                syncSetUi();
                updateOverlay(renderer.state, camera.getState(statsText));
        }
        btnSearchAdd.addEventListener('click', addResultsToSelection);
        searchResultsList.addEventListener('click', (event) => {
                const button = event.target.closest('button[data-search-index]');
                if (!button || !searchResultsList.contains(button)) return;
                selectSearchResult(Number(button.dataset.searchIndex));
        });

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
        // Rows that mean nothing outside the map are hidden rather than
        // disabled — the data-view mirror of the movement-pass controls. G3's
        // ship and planner stay visible above them in the same Flight workspace.
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
        // G3's compact Flight workspace. These controls are deliberately next
        // to the existing map routes: fly-one-star and plan-a-transport-route
        // are adjacent tasks, not separate UI modes.
        const flightStatus = document.getElementById('flight-status');
        const flightThrustSlider = document.getElementById('flight-thrust');
        const flightThrustValue = document.getElementById('val-flight-thrust');
        const flightThrustRow = document.getElementById('flight-thrust-row');
        const flightSpeedSlider = document.getElementById('flight-speed');
        const flightSpeedGovernorBox = document.getElementById('flight-speed-governor');
        const flightSpeedValue = document.getElementById('val-flight-speed');
        const flightSpeedRow = document.getElementById('flight-speed-row');
        const flightDestinationLabel = document.getElementById('flight-destination');
        const flightUseSelected = document.getElementById('flight-use-selected');
        const flightClearDestination = document.getElementById('flight-clear-destination');
        const flightModeSelect = document.getElementById('flight-mode');
        const flightTimeRow = document.getElementById('flight-time-row');
        const flightTimeLimitBox = document.getElementById('flight-time-limit');
        const flightForecast = document.getElementById('flight-forecast');
        const flightRefuel = document.getElementById('flight-refuel');
        // G4: the Port rows — the dock toggle and the hold.
        const flightDock = document.getElementById('flight-dock');
        const flightCargoLoad = document.getElementById('flight-cargo-load');
        const flightCargoUnload = document.getElementById('flight-cargo-unload');
        const flightPortState = document.getElementById('flight-port-state');
        // The Trade rows: the network clock, the overlay toggle and the port
        // list. The counters and the list are 4 Hz text like the rest. Now
        // in its own panel (trade.2), so piloting and economy are separate.
        const tradeRateSlider = document.getElementById('trade-rate');
        const tradeRateValue = document.getElementById('val-trade-rate');
        const tradeRoutesBox = document.getElementById('trade-routes');
        const tradeSyncBox = document.getElementById('trade-sync-time');
        const tradeGenBox = document.getElementById('trade-generation-ships');
        const starTimeRangeBtn = document.getElementById('star-time-range');
        const tradeState = document.getElementById('trade-state');
        const tradeList = document.getElementById('trade-list');
        const tradeLaunch = document.getElementById('trade-launch');
        const colonisationState = document.getElementById('colonisation-state');
        const colonisationList = document.getElementById('colonisation-list');
        const shipList = document.getElementById('ship-list');
        const fleetCount = document.getElementById('fleet-count');
        const shipSpawn = document.getElementById('ship-spawn');
        const flightAutoDest = document.getElementById('flight-autopilot-dest');
        const flightAutoTarget = document.getElementById('flight-autopilot-target');
        const velocityForward = document.getElementById('velocity-forward');
        const velocityRight = document.getElementById('velocity-right');
        const velocityUp = document.getElementById('velocity-up');
        const velocityRef = document.getElementById('velocity-ref');
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
        function addFleetRow(entry) {
                const button = document.createElement('button');
                button.type = 'button';
                button.dataset.shipId = String(entry.id);
                button.setAttribute('role', 'option');
                entry.button = button;
                shipList.appendChild(button);
        }
        function syncFleetUi() {
                fleetCount.textContent = fleet.length + (fleet.length === 1 ? ' ship' : ' ships');
                for (const entry of fleet) {
                        if (!entry.button) addFleetRow(entry);
                        const active = entry === activeFleetShip;
                        entry.button.textContent = `${entry.name} · ${entry.ship.class.label}${active && gameMode ? ' · piloting' : ''}`;
                        entry.button.title = `${entry.name} · ${entry.ship.class.label}${active ? ' · active ship' : ' · click to pilot'}`;
                        entry.button.classList.toggle('is-active', active);
                        entry.button.setAttribute('aria-selected', active ? 'true' : 'false');
                        entry.button.setAttribute('aria-pressed', active ? 'true' : 'false');
                }
        }
        function selectFleetShip(id) {
                const entry = fleet.find((item) => item.id === id);
                if (!entry) return;
                if (entry !== activeFleetShip && ship.ap.mode !== shipLib.AP_OFF) {
                        shipLib.apAbort(ship);
                        setAutoMsg('autopilot off · switched ships');
                }
                activeFleetShip = entry;
                ship = entry.ship;
                autoRunning = false;
                gameCommand = 0;
                shipTimeRateCapY = Infinity;
                systemLayer.setShipClass(ship.class.id);
                if (gameMode) {
                        positionCameraAtActiveShip();
                        gameTargetFeed(0);
                        gameTargetClosingKpcS = 0;
                } else {
                        gameMode = true;
                        enterGameMode();
                }
                syncDvUi();
                syncFleetUi();
                syncStarTime();
                syncFlightUi();
                writeSystemReadout();
        }
        function spawnFleetShip() {
                const state = camera.getState(rigState);
                const newShip = shipLib.createShip(selDvShip.value || ship.class.id);
                newShip.pos[0] = state.position[0];
                newShip.pos[1] = state.position[1];
                newShip.pos[2] = state.position[2];
                // The spawn heading is the camera's own, so the new
                // hull flies the way the view is aimed, not the
                // galaxy-frame default.
                newShip.heading[0] = state.orientation[0];
                newShip.heading[1] = state.orientation[1];
                newShip.heading[2] = state.orientation[2];
                newShip.heading[3] = state.orientation[3];
                const id = nextFleetId++;
                // A spawned hull is a stationary launch, even if the observer
                // currently follows a moving target; do not hand over its drift.
                const entry = {
                        id, name: 'Ship ' + id,
                        ship: newShip, positioned: true, entered: true, button: null,
                };
                fleet.push(entry);
                addFleetRow(entry);
                syncFleetUi();
                syncFlightUi();
        }
        addFleetRow(fleet[0]);
        syncFleetUi();
        shipList.addEventListener('click', (event) => {
                const button = event.target.closest('button[data-ship-id]');
                if (!button || !shipList.contains(button)) return;
                selectFleetShip(Number(button.dataset.shipId));
                releasePanelInput();
                canvas.focus({ preventScroll: true });
        });
        shipSpawn.addEventListener('click', () => {
                spawnFleetShip();
                releasePanelInput();
                canvas.focus({ preventScroll: true });
        });
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
        function setFlightShipClass(classId) {
                systemLayer.setShipClass(classId);
                shipLib.setClass(ship, classId);
                autoRunning = false;
                shipTimeRateCapY = Infinity;
                syncStarTime();
                syncDvUi();
                syncFleetUi();
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
                // One hangar choice drives pilot, forecast and map route.
                setFlightShipClass(selDvShip.value);
                syncFlightUi();
                writeSystemReadout();
        });
        // The Pilot controls are mutually exclusive: touching one
        // switches the forward axis to it and switches the other
        // off, so a thrust change disables the speed limit and a
        // speed change disables the thrust control.
        function setFlightControl(mode) {
                if (flightControl === mode) return;
                flightControl = mode;
                flightSpeedGovernorBox.checked = mode === 'speed';
        }
        flightThrustSlider.addEventListener('input', () => {
                flightThrust = Number(flightThrustSlider.value) / 100;
                setFlightControl('thrust');
                syncFlightUi();
        });
        flightSpeedSlider.addEventListener('input', () => {
                flightSpeedFraction = Number(flightSpeedSlider.value) / 100;
                setFlightControl('speed');
                syncFlightUi();
        });
        flightSpeedGovernorBox.addEventListener('change', () => {
                setFlightControl(flightSpeedGovernorBox.checked ? 'speed' : 'thrust');
                syncFlightUi();
        });
        flightModeSelect.addEventListener('change', () => {
                flightMode = Number(flightModeSelect.value);
                syncFlightUi();
        });
        flightTimeLimitBox.addEventListener('input', () => {
                const years = Number(flightTimeLimitBox.value);
                // Let a number field be temporarily empty while it is edited;
                // forcing the last value back on every keystroke makes a new
                // deadline impossible to type.
                if (!(Number.isFinite(years) && years > 0)) return;
                flightTimeLimitYears = years;
                syncFlightUi();
        });
        flightTimeLimitBox.addEventListener('change', syncFlightUi);
        flightUseSelected.addEventListener('click', () => {
                setFlightDestinationFromPrimary();
                syncFlightUi();
        });
        flightClearDestination.addEventListener('click', () => {
                clearFlightDestination();
                syncFlightUi();
        });
        flightRefuel.addEventListener('click', () => {
                shipLib.refuel(ship);
                syncFlightUi();
        });
        // G4's Port rows fire the same one-shot action
        // flags their keys set (the ui.6 panel pattern).
        flightDock.addEventListener('click', () => { actions.dock = 1; });
        flightCargoLoad.addEventListener('click', () => { actions.cargoLoad = 1; });
        flightCargoUnload.addEventListener('click', () => { actions.cargoUnload = 1; });
        tradeRateSlider.addEventListener('input', () => {
                tradeRateIndex = Math.min(tradeLib.TRADE_RATES.length - 1,
                        Math.max(0, Number(tradeRateSlider.value) | 0));
                syncTradeUi();
        });
        tradeRoutesBox.addEventListener('change', () => {
                tradeRoutesOn = tradeRoutesBox.checked ? 1 : 0;
        });
        // The manual launch: the tick's own choice, now. A frontier that only
        // moves every 200 years is hard to read at any clock, so the panel can
        // push one expedition itself and name the pair it sent.
        tradeLaunch.addEventListener('click', () => {
                if (!tradeNet) return;
                const result = tradeLib.launchBest(tradeNet, tradeNet.time);
                if (result.ok) {
                        const source = tradeNet.ports[result.source];
                        const site = tradeNet.candidates[result.candidate].site;
                        tradeLaunchMsg = `launched  ${source.name.slice(0, 12)} \u2192 ${site.name.slice(0, 14)}`;
                } else {
                        tradeLaunchMsg = result.reason || 'no expedition ready';
                }
                tradeLaunchTicks = 8;
                syncTradeUi();
        });
        tradeSyncBox.addEventListener('change', () => {
                tradeSyncOn = tradeSyncBox.checked ? 1 : 0;
                // A synced clock with the sky parked is a network that never
                // advances — the panel says "paused", and checking the box
                // resumes the star clock rather than leaving an economy that
                // looks broken. A negative star rate (the observer's fly
                // coupling) is not a running clock for this purpose.
                if (tradeSyncOn && !gameMode && !(starTimeRate > 0)) {
                        starTimeRate = lastNonZeroTimeRate > 0 ? lastNonZeroTimeRate : TRADE_GEN_MYR;
                        if (starTimeRate > Number(sliderStarTime.max)) starTimeRate = Number(sliderStarTime.max);
                        syncStarTime();
                }
                syncTradeUi();
        });
        tradeGenBox.addEventListener('change', () => {
                tradeGenOn = tradeGenBox.checked ? 1 : 0;
                tradeLib.setGenerationMode(tradeGenOn, tradeNet);
                // The crawl is calibrated at the top of the fine star range
                // (trade-plan §6): synced 2 Myr/s is 2 000 trade y/s, so a 5 ly
                // hop is 5 000 y ≈ 2.5 wall seconds. Enabling the mode sets
                // exactly that pair — a generation-ship mode on a parked sky,
                // or on the freighter-sized 5 Myr/s rung, would look broken in
                // opposite directions.
                if (tradeGenOn) {
                        tradeSyncOn = 1;
                        tradeSyncBox.checked = true;
                        if (!gameMode) {
                                starTimeRate = TRADE_GEN_MYR;
                                lastNonZeroTimeRate = starTimeRate;
                                syncStarTime();
                        }
                }
                syncTradeUi();
        });
        // The star-time slider's fine range (−1…2 Myr/s in 0.1 steps) makes
        // small rates settable; the button widens to −1…99 Myr/s in 0.5 steps.
        starTimeRangeBtn.addEventListener('click', () => {
                starTimeWide = !starTimeWide;
                if (starTimeRate > Number(sliderStarTime.max)) starTimeRate = Number(sliderStarTime.max);
                syncStarTime();
        });
        flightAutoDest.addEventListener('change', () => {
                if (flightAutoDest.checked) {
                        if (!gameMode) {
                                flightAutoDest.checked = false;
                                flightStatus.textContent = 'Select a ship to enter game mode';
                                return;
                        }
                        if (flightAutoTarget.checked) flightAutoTarget.checked = false;
                        gameCommand = GAME_CMD_PLAN;
                } else if (ship.ap.mode === shipLib.AP_APPROACH) {
                        gameCommand = GAME_CMD_ABORT;
                }
                syncFlightUi();
        });
        flightAutoTarget.addEventListener('change', () => {
                if (flightAutoTarget.checked) {
                        if (!gameMode) {
                                flightAutoTarget.checked = false;
                                flightStatus.textContent = 'Select a ship to enter game mode';
                                return;
                        }
                        if (flightAutoDest.checked) flightAutoDest.checked = false;
                        gameCommand = GAME_CMD_TARGET;
                } else if (ship.ap.mode === shipLib.AP_TARGET) {
                        gameCommand = GAME_CMD_ABORT;
                }
                syncFlightUi();
        });

	const btnRouteFly = document.getElementById('route-fly');
	const routeStarsButton = document.getElementById('route-stars');
	const routeHint = document.getElementById('route-hint');
	const routeRoundtrip = document.getElementById('route-roundtrip');
	const dvPick = { body: -1, node: -1 };
	function syncRouteUi() {
		const r = systemLayer.routeState();
		const state = systemLayer.autopilotState();
		routeStarsButton.disabled = !hasTwoStarEndpoints();
		const rate = systemLayer.getTimeRate();
		btnRouteFly.textContent = state === 'running' ? 'Pause autopilot'
			: state === 'paused' ? 'Resume autopilot'
			: state === 'complete' ? 'Restart autopilot' : 'Start autopilot';
		btnRouteFly.disabled = !r.feasible;
		if (!r.start) { routeHint.textContent = hasTwoStarEndpoints()
			? 'Choose map nodes, or plan from previous star to current star.'
			: 'Choose map nodes, or select two stars to plan an interstellar route.'; return; }
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
	// The endpoints carry drawn-space positions (ui.2): the cruise leg's distance
	// is the separation of the two stars the user is looking at, not of their birth
	// records — which a moving engine separates by kiloparsecs. `drawnPos` already
	// holds the snapshot when the record is not resident, so the fallback is the
	// old behaviour rather than a hole.
	function stellarEndpointFrom(ref, inputs) {
		const d = window.DeltaVLib;
		const mu = d.G_SI * inputs.mass * d.M_SUN_KG;
		const radius = Math.max(0.01 * d.AU_M, inputs.rStar * selectPlanets.AU_PER_R_SUN * d.AU_M * 10);
		const body = d.createBodyParam();
		body.mu = mu; body.aM = radius; body.rLoM = radius;
		body.vCircLo = d.vCirc(mu, radius); body.vEscLo = d.vEsc(mu, radius);
		body.periodS = d.TAU * Math.sqrt(radius ** 3 / mu);
		return { body, node: 1, muStar: mu, phase: 0, systemKey: ref.key >>> 0, label: selectionLabel(ref),
			x: drawnPos[0], y: drawnPos[1], z: drawnPos[2] };
	}
	function stellarEndpoint(i) {
		const ref = memberRefFor(i);
		const inputs = deriveMemberInputs(i);
		memberDrawnPosition(i, drawnPos);
		return stellarEndpointFrom(ref, inputs);
	}
	function historyEndpoint(ref) {
		selection.resolveDrawn(ref, drawnPos);
		return stellarEndpointFrom(ref, ref);
	}
	function hasTwoStarEndpoints() {
		const natural = selectionStore.natural;
		const previous = natural.previous;
		const current = natural.current;
		return !!(previous && current && previous.type === 'star' && current.type === 'star')
			|| starSet.count >= 2;
	}
	function selectedStarEndpoints() {
		const natural = selectionStore.natural;
		const previous = natural.previous;
		const current = natural.current;
		if (previous && current && previous.type === 'star' && current.type === 'star') {
			return [historyEndpoint(previous), historyEndpoint(current)];
		}
		if (starSet.count >= 2) return [stellarEndpoint(0), stellarEndpoint(1)];
		return null;
	}
	routeStarsButton.addEventListener('click', () => {
		const endpoints = selectedStarEndpoints();
		if (!endpoints) { routeHint.textContent = 'Select two stars or Shift-click to add a second set member.'; return; }
		systemLayer.planExternalRoute(endpoints[0], endpoints[1]);
		writeSystemReadout();
	});

        function syncViewRows() {
                const viewOpen = systemLayer.isOpen();
		document.body.classList.toggle('system-view', viewOpen);
		syncDvUi(); syncRouteUi();
                // Map-specific controls mean nothing while the view is closed.
                // The ship and destination controls remain above them in Flight.
                for (const row of viewRows) {
                        row.style.display = viewOpen && row.dataset.view === 'system' ? '' : 'none';
                }
                btnSystemView.textContent = viewOpen ? 'Close' : 'Open';
                btnSystemView.disabled = gameMode;
                sysViewSelect.disabled = gameMode;
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
                // Inspection is discovery: the opened system's sites join the
                // network on first sight, and an old system is only settled.
                tradeInspectSystem(ref, systemCtx.name);
                if (moveCamera !== false) {
                        const cam = camera.cameraPos;
                        memberDrawnPosition(p, drawnPos);
                        const dx = drawnPos[0] - cam[0];
                        const dy = drawnPos[1] - cam[1];
                        const dz = drawnPos[2] - cam[2];
                        const far = Math.sqrt(dx * dx + dy * dy + dz * dz) > SYSTEM_VIEW_FLY_KPC;
                        camera.flyToStar(drawnPos[0], drawnPos[1], drawnPos[2], memberName(p),
                                far ? camera.orbitStandOff(starSet.lum[p]) : 0);
                        followKey = starSet.keys[p] >>> 0;
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

        function restoreStarSnapshot(ref) {
                if (!ref || ref.group !== window.SelectionStore.GROUP_SPACE || ref.type !== 'star') return false;
                historyPick.key = ref.key >>> 0;
                historyPick.kind = ref.kind;
                historyPick.index = ref.index;
                historyPick.x = ref.x; historyPick.y = ref.y; historyPick.z = ref.z;
                historyPick.colorIndex = ref.colorIndex;
                historyPick.absMag = ref.absMag;
                historyPick.approximated = 0;
                historyInputs.mass = ref.mass; historyInputs.lum = ref.lum;
                historyInputs.teff = ref.teff; historyInputs.age = ref.age;
                historyInputs.metal = ref.metal;
                const cam = camera.cameraPos;
                starSet.setSingle(historyPick, historyInputs, cam[0], cam[1], cam[2], ref.index);
                setLabel = '';
                if (ref.kind === selectPlanets.BLOCK_LANDMARK && model.milkyWay) {
                        selected = ref.index;
                        labels.setSelected(ref.index);
                        const entry = landmarks.ENTRIES[ref.index];
                        selection.resolveDrawn(ref, drawnPos);
                        camera.setOrbitTarget(drawnPos[0], drawnPos[1], drawnPos[2],
                                entry ? entry.name : selectionLabel(ref));
                        followKey = ref.key >>> 0;
                } else {
                        selected = -1;
                        labels.setSelected(-1);
                        followKey = -1;
                }
                syncSetUi();
                if (systemLayer.isOpen()) openSystemView(true);
                updateOverlay(renderer.state, camera.getState(statsText));
                return true;
        }

        function restoreHistorySelection(ref) {
                if (!ref || ref.group !== window.SelectionStore.GROUP_SPACE) return false;
                if (ref.type === 'star') return restoreStarSnapshot(ref);
                const entity = ref.entity;
                if ((ref.type !== 'planet' && ref.type !== 'other') || !entity || !entity.host) return false;
                if (!restoreStarSnapshot(entity.host)) return false;
                if (!systemLayer.isOpen()) openSystemView(true);
                systemLayer.setSelected(entity.bodyKind, entity.index);
                writeSystemReadout();
                updateOverlay(renderer.state, camera.getState(statsText));
                return true;
        }

        swapSelectionButton.addEventListener('click', () => {
                const current = selectionStore.swap(window.SelectionStore.GROUP_SPACE);
                if (current) restoreHistorySelection(current);
                syncSelectionPanel();
        });

        // The readout is text at the overlay's 4 Hz cadence (plan §6.6), plus
        // an immediate refresh on enter and on a schematic click, so the
        // ◀ marker never lags the ring.
        function writeSystemReadout() {
                sysread.textContent = systemLayer.readoutText() + tradeReadoutText();
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

        // Tab toggles all control panels without changing the view. Each panel's
        // own ▾ collapses it to its header instead of closing it, so there is
        // always a handle to expand it again. Opening any panel releases pointer
        // lock and any held key.
        function releasePanelInput() {
                input.releaseAll();
                if (document.pointerLockElement === canvas) document.exitPointerLock();
        }
        // The overlay and the readout start where the left panel ends; when
        // the panel is hidden they take the column back.
        function leftPanelInset() {
                let width = 0;
                if (selectionMenu.style.display !== 'none') width = Math.max(width, 280);
                if (sysMenu.style.display !== 'none') width = Math.max(width, 292);
                return width ? width + 24 : 0;
        }
        // The right column: Display at the edge, View modes in its own column
        // beside it. The schematic fits its map between the columns.
        function rightPanelInset() {
                if (viewMenu.style.display !== 'none') return 556;
                return menu.style.display === 'none' ? 0 : 284;
        }
        function syncOverlayInset() {
                const inset = leftPanelInset();
                const left = window.innerWidth <= 900 || inset === 0 ? '12px' : inset + 'px';
                overlay.style.left = left;
                sysread.style.left = left;
                return inset;
        }
        function toggleMenu() {
                const visible = menu.style.display !== 'none'
                        || selectionMenu.style.display !== 'none'
                        || sysMenu.style.display !== 'none'
                        || viewMenu.style.display !== 'none'
                        || helpPanel.style.display !== 'none'
                        || tradeMenu.style.display !== 'none';
                menu.style.display = visible ? 'none' : 'block';
                selectionMenu.style.display = visible ? 'none' : 'block';
                sysMenu.style.display = visible ? 'none' : 'block';
                viewMenu.style.display = visible ? 'none' : 'block';
                helpPanel.style.display = visible ? 'none' : 'block';
                tradeMenu.style.display = visible ? 'none' : 'block';
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
        wireCollapse(selectionMenu, selectionMenuCollapse);
        wireCollapse(sysMenu, sysMenuCollapse);
        wireCollapse(viewMenu, viewMenuCollapse);
        wireCollapse(tradeMenu, tradeMenuCollapse);

        // --- Controls panel (ui.6) ------------------------------------------
        // The old help <pre> as clickable controls. Buttons and checkboxes
        // carry a data-action and fire the same one-shot action flags the
        // keys set, so a click and a key press run one code path and no
        // handler logic is duplicated here. Checkboxes toggle natively
        // (optimistic) and syncHelpControls repaints them from the live
        // state at the overlay's 4 Hz — a toggle the app refused (j with
        // nothing selected) visibly snaps back.
        const helpPanel = document.getElementById('help');
        const helpCollapse = document.getElementById('help-collapse');
        const helpPrevStar = document.getElementById('help-prev-star');
        const helpBoxes = new Map();
        for (const box of helpPanel.querySelectorAll('input[data-action]')) {
                helpBoxes.set(box.dataset.action, box);
        }
        // The speed-reference buttons (§7.4): target / galactic
        // centre / home, repainted from the live reference.
        const helpRefButtons = new Map();
        for (const button of helpPanel.querySelectorAll('button[data-speed-ref]')) {
                helpRefButtons.set(button.dataset.speedRef, button);
        }
        const helpNeedPrimary = Array.from(helpPanel.querySelectorAll('button[data-action="orbitObject"], button[data-action="flyTo"]'));
        const helpNeedSet = Array.from(helpPanel.querySelectorAll('button[data-action="nextStar"], button[data-action="clearSet"]'));
        // Game mode's gating (game-mode-plan §3): observer mode controls
        // carry data-observer and die while the ship is the rig. The legacy
        // Controls refill remains game-only; the Flight workspace is the
        // always-visible hangar. Repainted at 4 Hz.
        const helpNeedObserver = Array.from(helpPanel.querySelectorAll('[data-observer]'));
        // G5's clock presets are the reverse gate: the ship clock exists only
        // on game mode's shared axis, so they are dead while observing.
        const helpNeedGame = Array.from(helpPanel.querySelectorAll('[data-game]'));
        const helpClockSim = helpPanel.querySelector('[data-action="clockSim"]');
        const helpClockArcade = helpPanel.querySelector('[data-action="clockArcade"]');
        const helpRefuel = helpPanel.querySelector('[data-action="shipRefuel"]');
        const helpFly = helpPanel.querySelector('[data-action="flyMode"]');
        const helpFlyLabel = document.getElementById('help-fly-label');
        wireCollapse(helpPanel, helpCollapse);
        helpPanel.addEventListener('click', (event) => {
                const control = event.target.closest('button[data-action], input[data-action]');
                if (!control || !helpPanel.contains(control)) return;
                input.state.actions[control.dataset.action] = 1;
                releasePanelInput();
                canvas.focus({ preventScroll: true });
        });
        helpPrevStar.addEventListener('click', () => {
                // Shift+N's path: the loop's N reads the held boost key, which
                // a click cannot set, so the previous-star button walks the
                // set directly — same cycling, same system-view follow.
                cyclePrimary(-1);
                if (systemLayer.isOpen()) openSystemView(true);
                releasePanelInput();
                canvas.focus({ preventScroll: true });
        });
        function syncHelpControls(cameraState) {
                helpBoxes.get('chaseFollow').checked = gameMode ? ship.ap.mode === shipLib.AP_FOLLOW : cameraState.chase;
                helpBoxes.get('constellations').checked = labels.constellationsVisible();
                helpBoxes.get('systemView').checked = systemLayer.isOpen();
                helpBoxes.get('gameMode').checked = gameMode;
                helpBoxes.get('freezeTime').checked = gameMode ? ship.timeFrozen : starTimeRate === 0;
                const noPrimary = starSet.primary < 0;
                const noSet = starSet.count === 0;
                for (const button of helpNeedPrimary) button.disabled = noPrimary;
                for (const button of helpNeedSet) button.disabled = noSet;
                for (const control of helpNeedObserver) control.disabled = gameMode;
                for (const control of helpNeedGame) control.disabled = !gameMode;
                if (helpRefuel) helpRefuel.disabled = !gameMode;
                helpPrevStar.disabled = noSet;
                helpFly.disabled = gameMode && ship.ap.mode === shipLib.AP_OFF;
                helpFlyLabel.textContent = gameMode ? 'abort autopilot' : 'fly';
                for (const [kind, button] of helpRefButtons) {
                        button.classList.toggle('is-active', speedRef === kind);
                }
                helpClockSim.classList.toggle('is-active', gameMode && !ship.arcade
                        && ship.timeIndex === shipLib.SHIP_TIME_REAL_INDEX);
                helpClockArcade.classList.toggle('is-active', gameMode && ship.arcade);
        }
        syncOverlayInset();
        window.addEventListener('resize', syncOverlayInset);

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
        // View modes (view-modes.6): every control is one layer.set call; the
        // 4 Hz status sync in the loop picks up the live range and counts.
        function bindVmRadio(name, key) {
                vmRadioGroups[name].forEach((radio) => {
                        radio.addEventListener('change', () => {
                                if (!radio.checked) return;
                                viewModesLayer.set({ [key]: radio.value });
                                syncViewModes();
                        });
                });
        }
        bindVmRadio('mode', 'mode');
        bindVmRadio('projection', 'projection');
        bindVmRadio('source', 'source');
        bindVmRadio('budget', 'budget');
        bindVmRadio('ramp', 'ramp');
        function bindVmSlider(slider, valEl, key, fmt) {
                slider.addEventListener('input', () => {
                        const v = Number(slider.value);
                        viewModesLayer.set({ [key]: v });
                        valEl.textContent = fmt(v);
                });
        }
        bindVmSlider(sliderVmAnchors, valVmAnchors, 'anchors', (v) => String(v | 0));
        bindVmSlider(sliderVmSigma, valVmSigma, 'sigmaDeg', (v) => `${v}°`);
        bindVmSlider(sliderVmSpan, valVmSpan, 'chartSpanDeg', (v) => `${v | 0}°`);
        bindVmSlider(sliderVmRes, valVmRes, 'resH', (v) => (v | 0) ? `${v | 0} px` : 'auto');
        bindVmSlider(sliderVmRelief, valVmRelief, 'relief', (v) => v > 0 ? `${v}×` : 'off');
        bindVmSlider(sliderVmOpacity, valVmOpacity, 'opacity', (v) => `${Math.round(v * 100)}%`);
        for (const key of Object.keys(vmChecks)) {
                vmChecks[key].addEventListener('change', () => {
                        viewModesLayer.set({ [key]: vmChecks[key].checked });
                });
        }
        vmAutoRange.addEventListener('change', () => {
                viewModesLayer.setAutoRange(vmAutoRange.checked);
                syncViewModesRange();
        });
        sliderVmRangeLo.addEventListener('input', () => {
                viewModesLayer.setRange('lo', Number(sliderVmRangeLo.value));
                syncViewModes();
        });
        sliderVmRangeHi.addEventListener('input', () => {
                viewModesLayer.setRange('hi', Number(sliderVmRangeHi.value));
                syncViewModes();
        });
        // The star-time slider is the ship clock's other dress (game-mode-plan
        // §4): while game mode is on, its stops are the ship-time ladder's rung
        // indices — the system clock's pattern (SYSTIME_LADDER) — and the
        // readout speaks y/s. The observer's Myr/s rate stays parked in
        // starTimeRate and is restored by the dress change alone.
        function gameTimeRateY() {
                if (ship.timeFrozen) return 0;
                let rate = shipLib.timeRateYPerS(ship, shipLib.speedC(ship));
                if (ship.arcade) {
                        // The coast warp raises the clock to the wall-time rate
                        // the flight's four-second floor implies; the cap below
                        // keeps the same floor an upper bound.
                        const warp = shipLib.arcadeWarpYPerS(ship, AUTOPILOT_MIN_WALL_SECONDS);
                        if (warp > rate) rate = warp;
                }
                if (rate === 0 && ship.timeIndex === 0
                        && (ship.ap.mode !== shipLib.AP_OFF || flightThrust > 0
                                || input.state.keys.forward || input.state.keys.back
                                || input.state.keys.left || input.state.keys.right
                                || input.state.keys.up || input.state.keys.down)) {
                        rate = shipLib.SHIP_TIME_LADDER[shipLib.SHIP_TIME_FIRST_TIMED_INDEX];
                }
                return rate > 0 ? Math.min(rate, shipTimeRateCapY) : rate;
        }
        function refreshShipTimeRateCap() {
                const mode = ship.ap.mode;
                shipTimeRateCapY = (mode === shipLib.AP_APPROACH || mode === shipLib.AP_TARGET)
                        ? shipLib.timeRateCapYPerS(ship.ap.etaS, AUTOPILOT_MIN_WALL_SECONDS)
                        : Infinity;
        }
        function formatShipRate(rate) {
                return rate > 0 ? '+' + Number(rate.toPrecision(3)) + ' y/s' : '0 y/s';
        }
        // G5's Controls-panel clock presets (§4): SIM is the ladder's real-time
        // stop; ARCADE snaps to the class's default rung and turns on the
        // autopilot coast warp. Both unfreeze the clock — a preset that
        // selected a paused clock would look broken.
        function setShipClockPreset(preset) {
                shipLib.setClockPreset(ship, preset);
                setAutoMsg(preset === 'sim' ? 'sim clock · real time' : 'arcade clock · coast warp on');
                refreshShipTimeRateCap();
                syncStarTime();
        }
        function syncStarTime() {
                if (gameMode) {
                        sliderStarTime.min = shipLib.SHIP_TIME_INDEX_MIN;
                        sliderStarTime.max = shipLib.SHIP_TIME_INDEX_MAX;
                        sliderStarTime.step = 1;
                        sliderStarTime.value = ship.timeIndex;
                        const requestedRate = shipLib.timeRateYPerS(ship, shipLib.speedC(ship));
                        const effectiveRate = gameTimeRateY();
                        const adjusted = Math.abs(effectiveRate - requestedRate) > 1e-15;
                        valStarTime.textContent = 'ship ' + shipLib.formatClock(ship, shipLib.speedC(ship))
                                + (adjusted ? ' · ' + formatShipRate(effectiveRate) : '');
                        valStarTime.title = 'Ship clock: the shared rate of ship physics and star drift.'
                                + (adjusted ? ` Effective rate ${formatShipRate(effectiveRate)}; autopilot flights are kept at least 4 wall-seconds.` : '');
                } else {
                        sliderStarTime.min = -1;
                        sliderStarTime.max = starTimeWide ? 99 : 2;
                        sliderStarTime.step = starTimeWide ? 0.5 : 0.1;
                        if (starTimeRate > sliderStarTime.max) starTimeRate = Number(sliderStarTime.max);
                        else if (starTimeRate < sliderStarTime.min) starTimeRate = Number(sliderStarTime.min);
                        sliderStarTime.value = starTimeRate;
                        valStarTime.textContent = window.OrbitLib.formatTimeRate(starTimeRate, 0);
                        valStarTime.title = '';
                }
                starTimeRangeBtn.textContent = starTimeWide ? 'wide range' : 'fine range';
                starTimeRangeBtn.disabled = gameMode;
        }
        function pauseStarTimeForSearch() {
                if (starTimeRate === 0) return false;
                lastNonZeroTimeRate = starTimeRate;
                starTimeRate = 0;
                syncStarTime();
                return true;
        }
        sliderStarTime.addEventListener('input', () => {
                if (gameMode) {
                        ship.timeIndex = Number(sliderStarTime.value);
                        ship.timeFrozen = false;
                        refreshShipTimeRateCap();
                } else {
                        starTimeRate = Number(sliderStarTime.value);
                        if (starTimeRate > 0) lastNonZeroTimeRate = starTimeRate;
                }
                syncStarTime();
        });
        // A press that leaves the value alone is the one gesture the slider has
        // that is not "set a rate": a click on the track jumps the thumb and
        // fires `input` first, while pressing the handle without dragging fires
        // only `click`. That silent press stops the shared clock — the 0 stop is
        // otherwise a half-step between -1 and 0.5 on a 100-wide track. T
        // restores the parked observer rate; in game mode the press steps onto
        // the ship ladder's own frozen rung, so the ship and the sky stop
        // together.
        let starTimeMoved = false;
        sliderStarTime.addEventListener('pointerdown', () => { starTimeMoved = false; });
        sliderStarTime.addEventListener('input', () => { starTimeMoved = true; });
        sliderStarTime.addEventListener('click', () => {
                if (starTimeMoved) return;
                if (gameMode) {
                        ship.timeIndex = 1;      // SHIP_TIME_LADDER[1] is the frozen stop
                        ship.timeFrozen = false;
                        refreshShipTimeRateCap();
                } else if (starTimeRate !== 0) {
                        lastNonZeroTimeRate = starTimeRate;
                        starTimeRate = 0;
                }
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
                applyViewModes({
                        mode: d.viewmode,
                        projection: d.viewproj,
                        source: d.viewsource,
                        anchors: d.viewanchors,
                        ramp: d.viewramp,
                        relief: d.viewrelief,
                        opacity: d.viewopacity,
                });
                window.OrbitLib.setApocenterShare(d.apoShare);
                window.OrbitLib.setApocenterForce(d.apoForce);
                waveDamping = window.OrbitLib.setWaveDamping(d.wave);
                patternScale = window.OrbitLib.setPatternScale(d.pattern, starTimeMyr, model);
                // The view's clock is a knob; whether the view is open is
                // working state, like the search results — Defaults keeps it.
                systemLayer.setTimeRate(d.systime);
		systemLayer.setBudget(d.dvbudget);
		setFlightShipClass(d.ship);
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
                        viewmode: viewModesLayer.settings.mode,
                        viewproj: viewModesLayer.settings.projection,
                        viewsource: viewModesLayer.settings.source,
                        viewanchors: viewModesLayer.settings.anchors,
                        viewramp: viewModesLayer.settings.ramp,
                        viewrelief: viewModesLayer.settings.relief,
                        viewopacity: viewModesLayer.settings.opacity,
                        search: searchLib.formatFilter(searchLib.parseFilter(tokenBox.value)),
                        scope: scopeSelect.value === 'galaxy' ? 'galaxy' : 'selection',
                        sysview: systemLayer.isOpen() ? 1 : 0,
                        systime: systemLayer.getTimeRate(),
                        dvmap: systemLayer.getView(),
                        dvbudget: systemLayer.getBudget(),
                        trade: tradeRateYears(),
                        traderoutes: tradeRoutesOn,
                        tradesync: tradeSyncOn,
                        tradegen: tradeGenOn,
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
                if (s.viewmode !== undefined || s.viewproj !== undefined || s.viewsource !== undefined
                        || s.viewanchors !== undefined || s.viewramp !== undefined
                        || s.viewrelief !== undefined || s.viewopacity !== undefined) {
                        applyViewModes({
                                mode: s.viewmode,
                                projection: s.viewproj,
                                source: s.viewsource,
                                anchors: s.viewanchors,
                                ramp: s.viewramp,
                                relief: s.viewrelief,
                                opacity: s.viewopacity,
                        });
                }
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
		if (s.ship !== undefined) setFlightShipClass(s.ship);
		if (s.trade !== undefined) {
			tradeRateIndex = tradeRateIndexFor(s.trade);
			syncTradeUi();
		}
		if (s.traderoutes !== undefined) {
			tradeRoutesOn = s.traderoutes > 0 ? 1 : 0;
			syncTradeUi();
		}
		if (s.tradesync !== undefined) {
			tradeSyncOn = s.tradesync > 0 ? 1 : 0;
			tradeSyncBox.checked = tradeSyncOn !== 0;
			syncTradeUi();
		}
		if (s.tradegen !== undefined) {
			tradeGenOn = s.tradegen > 0 ? 1 : 0;
			tradeGenBox.checked = tradeGenOn !== 0;
			tradeLib.setGenerationMode(tradeGenOn, tradeNet);
			if (tradeGenOn) {
				// Generation ships only read against the synced pair; the
				// preset's own star rate wins when it named one.
				tradeSyncOn = 1;
				tradeSyncBox.checked = true;
				if (!(starTimeRate > 0)) {
					starTimeRate = TRADE_GEN_MYR;
					lastNonZeroTimeRate = starTimeRate;
					syncStarTime();
				}
			}
			syncTradeUi();
		}
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
                // Another galaxy is another network: same seed, same ports (the
                // map is a pure function of the model seed and the star keys).
                // A rebuild that lands on the *same* galaxy is not: an epoch
                // preset, or any path that regenerates without changing the
                // model, must not restart the colonies at year zero — that is
                // the "network rebuilt itself" flash.
                const modelKey = (model.type || '') + ':' + (model.seed | 0);
                if (!tradeNet || tradeModelKey !== modelKey) tradeSeedNetwork();
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
        const LY_PER_PC = LY_PER_KPC / 1000;

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

        function selectionLabel(ref) {
                if (!ref) return '—';
                if (ref.group === window.SelectionStore.GROUP_ASSET) {
                        return ref.type + ' · ' + (ref.name || ref.id || 'unnamed');
                }
                if (ref.name) return ref.name;
                if (ref.type === 'star' && ref.key !== null) return 'S' + (ref.key >>> 0).toString(36).toUpperCase();
                return ref.type + (ref.id == null ? '' : ' ' + ref.id);
        }

        function currentStarCenter() {
                const current = selectionStore.natural.current;
                if (current && current.type === 'star') return current;
                const p = starSet.primary;
                if (p < 0) return null;
                return {
                        group: window.SelectionStore.GROUP_SPACE,
                        type: 'star', key: starSet.keys[p] >>> 0, name: memberName(p),
                        kind: starSet.blockKind[p], index: starSet.bufferIdx[p],
                        x: starSet.x[p], y: starSet.y[p], z: starSet.z[p],
                        colorIndex: starSet.colorIndex[p], absMag: starSet.absMag[p],
                };
        }

        function syncSelectionPanel() {
                const natural = selectionStore.natural;
                const assets = selectionStore.assets;
                currentSelectionLabel.textContent = natural.current ? selectionLabel(natural.current) : 'No object selected';
                previousSelectionLabel.textContent = selectionLabel(natural.previous);
                swapSelectionButton.disabled = !natural.current || !natural.previous;
                assetCurrentLabel.textContent = selectionLabel(assets.current);
                assetPreviousLabel.textContent = selectionLabel(assets.previous);
                assetPairFirst.textContent = selectionLabel(selectionStore.assetPair[0]);
                assetPairSecond.textContent = selectionLabel(selectionStore.assetPair[1]);
                assetPairFirstButton.disabled = !assets.current;
                assetPairSecondButton.disabled = !assets.current;
                for (const button of searchResultsList.children) {
                        const row = natural.searchResults[Number(button.dataset.searchIndex)];
                        const isCurrent = !!(natural.current && row
                                && window.SelectionStore.sameSelection(natural.current, row));
                        button.classList.toggle('is-current', isCurrent);
                        button.setAttribute('aria-selected', isCurrent ? 'true' : 'false');
                }
        }

        function selectAssetReference() {
                const id = assetIdBox.value.trim();
                const name = assetNameBox.value.trim();
                if (!id && !name) {
                        assetIdBox.focus();
                        return;
                }
                selectionStore.selectCurrent(window.SelectionStore.GROUP_ASSET, {
                        type: assetTypeSelect.value,
                        id: id || name,
                        name: name || id,
                });
                syncSelectionPanel();
        }
        function setAssetPairSlot(index) {
                const pair = selectionStore.assetPair;
                if (!selectionStore.assets.current || (index !== 0 && index !== 1)) return;
                selectionStore.setAssetPair(
                        index === 0 ? selectionStore.assets.current : pair[0],
                        index === 1 ? selectionStore.assets.current : pair[1]);
                syncSelectionPanel();
        }
        assetSelectButton.addEventListener('click', selectAssetReference);
        assetClearButton.addEventListener('click', () => {
                selectionStore.clearHistory(window.SelectionStore.GROUP_ASSET);
                selectionStore.clearAssetPair();
                syncSelectionPanel();
        });
        assetIdBox.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') selectAssetReference();
        });
        assetNameBox.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') selectAssetReference();
        });
        assetPairFirstButton.addEventListener('click', () => setAssetPairSlot(0));
        assetPairSecondButton.addEventListener('click', () => setAssetPairSlot(1));

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

        function selectionFromPick(hit, inputs) {
                const entry = hit.kind === selectPlanets.BLOCK_LANDMARK ? landmarks.ENTRIES[hit.index] : null;
                return {
                        group: window.SelectionStore.GROUP_SPACE,
                        type: 'star',
                        key: hit.key >>> 0,
                        name: entry ? entry.name : '',
                        kind: hit.kind | 0,
                        index: hit.index | 0,
                        x: hit.x, y: hit.y, z: hit.z,
                        colorIndex: hit.colorIndex, absMag: hit.absMag,
                        mass: inputs.mass, lum: inputs.lum, teff: inputs.teff,
                        rStar: inputs.rStar, age: inputs.age, metal: inputs.metal,
                };
        }

        function primarySnapshot() {
                const p = starSet.primary;
                if (p < 0) return null;
                const key = starSet.keys[p] >>> 0;
                const current = selectionStore.natural.current;
                if (current && current.type === 'star' && current.key === key) return current;
                const ref = memberRefFor(p);
                return window.SelectionStore.copySelection(window.SelectionStore.GROUP_SPACE,
                        selectionFromPick(ref, deriveMemberInputs(p)));
        }

        function recordSystemBodySelection(body) {
                const p = starSet.primary;
                if (p < 0 || !body || body.kind === window.SystemLayer.BODY_NONE) return;
                const host = primarySnapshot();
                if (!host) return;
                let selection;
                if (body.kind === window.SystemLayer.BODY_STAR) {
                        const ref = memberRefFor(p);
                        selection = selectionFromPick(ref, deriveMemberInputs(p));
                } else if (body.kind === window.SystemLayer.BODY_PLANET) {
                        const id = host.key + ':planet:' + body.index;
                        selection = {
                                type: 'planet', id,
                                name: systemLayer.designationOf(body.kind, body.index),
                                x: host.x, y: host.y, z: host.z,
                                entity: { host, bodyKind: body.kind, index: body.index },
                        };
                } else if (body.kind === window.SystemLayer.BODY_BELT) {
                        const id = host.key + ':belt:' + body.index;
                        selection = {
                                type: 'other', id,
                                name: systemLayer.designationOf(body.kind, body.index),
                                x: host.x, y: host.y, z: host.z,
                                entity: { host, bodyKind: body.kind, index: body.index },
                        };
                } else {
                        return;
                }
                selectionStore.selectCurrent(window.SelectionStore.GROUP_SPACE, selection);
                syncSelectionPanel();
        }

        function syncSetUi() {
                labels.setSelectedKeys(starSet.keys, starSet.count);
                btnFlyTo.disabled = starSet.primary < 0;
                syncSelectionPanel();
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
                const hasDestination = flightDestination.active;
                if (!info || !info.identity || !info.view || (count <= 0 && !hasDestination)) return;
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
                // A Flight destination may no longer be in the mutable set.
                // Add it to this already-keyed re-resolution pass rather than
                // trusting the block-local slot it had when it was chosen.
                if (hasDestination) {
                        flightDestination.index = -1;
                        const member = starSet.indexOfKey(flightDestination.key);
                        if (member < 0) {
                                const home = resolveProbe(flightDestination.key >>> 0, true);
                                if (home < 0) return;
                                resolveUsed[home] = 1;
                                resolveKey[home] = flightDestination.key >>> 0;
                                resolveMember[home] = -2; // destination-only entry
                        }
                }
                for (let k = 0; k < blocks.length; k++) {
                        const block = blocks[k];
                        const n = block.count | 0;
                        if (n <= 0) continue;
                        const offset = block.offset | 0;
                        for (let slot = 0; slot < n; slot++) {
                                const global = offset + slot;
                                const home = resolveProbe(identity[global] >>> 0, false);
                                if (home < 0) continue;
                                const member = resolveMember[home];
                                if (member >= 0 && starSet.bufferIdx[member] >= 0) continue;
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
                                // Keep the locked key's live position and block
                                // slot in sync even after the primary selection
                                // has changed or been cleared. Its luminosity and
                                // display name remain the locked snapshot.
                                if (hasDestination && resolvePick.key === (flightDestination.key >>> 0)) {
                                        flightDestination.kind = k;
                                        flightDestination.index = slot;
                                        flightDestination.x = resolvePick.x;
                                        flightDestination.y = resolvePick.y;
                                        flightDestination.z = resolvePick.z;
                                        flightDestination.colorIndex = resolvePick.colorIndex;
                                        flightDestination.absMag = resolvePick.absMag;
                                }
                                if (member < 0) continue;
                                const inputs = selectPlanets.stellarInputs(resolvePick, {
                                        model,
                                        field: renderer.fieldBuffers(),
                                        member: info.member,
                                }, starInputs);
                                starSet.insert(resolvePick, inputs, cam[0], cam[1], cam[2], slot);
                        }
                }
        }

        // Plain click → the set is that one star and history advances; Shift+click
        // toggles membership without moving the primary or its history.
        function applyPick(hit, additive, inputsOverride) {
                const cam = camera.cameraPos;
                // A click while a radius scan is walking describes a different
                // neighbourhood than the one the scan was begun for: drop the scan.
                aroundPending = false;
                const inputs = inputsOverride || selectPlanets.stellarInputs(hit, {
                        model,
                        field: renderer.fieldBuffers(),
                        member: renderer.starBlocks().member,
                }, starInputs);
                if (additive) {
                        starSet.toggle(hit, inputs, cam[0], cam[1], cam[2], hit.index);
                        if (starSet.count > 0 && starSet.primary < 0) starSet.setPrimary(0);
                        const primary = starSet.primary;
                        const current = selectionStore.natural.current;
                        if (primary >= 0 && (!current || current.key !== (starSet.keys[primary] >>> 0))) {
                                const ref = memberRefFor(primary);
                                selectionStore.selectCurrent(window.SelectionStore.GROUP_SPACE,
                                        selectionFromPick(ref, deriveMemberInputs(primary)));
                        }
                } else {
                        starSet.setSingle(hit, inputs, cam[0], cam[1], cam[2], hit.index);
                        selectionStore.selectCurrent(window.SelectionStore.GROUP_SPACE, selectionFromPick(hit, inputs));
                }
                setLabel = '';
                syncSetUi();
        }

        function handleStarPick(hit, additive, inputsOverride) {
                applyPick(hit, additive, inputsOverride);
                if (additive) return;
                if (hit.kind === selectPlanets.BLOCK_LANDMARK && model.milkyWay) {
                        selected = hit.index;
                        labels.setSelected(hit.index);
                        const entry = landmarks.ENTRIES[hit.index];
                        // The orbit target is where the star is drawn, not the birth
                        // position the pick carries: the click landed on the drawn one.
                        selection.resolveDrawn(hit, drawnPos);
                        camera.setOrbitTarget(drawnPos[0], drawnPos[1], drawnPos[2],
                                entry ? entry.name : selectionLabel(selectionStore.natural.current));
                        followKey = hit.key >>> 0;
                } else {
                        selected = -1;
                        labels.setSelected(-1);
                        followKey = -1;
                }
                if (systemLayer.isOpen()) openSystemView(true);
        }

        function selectSearchResult(index) {
                const row = selectionStore.natural.searchResults[index];
                if (!row) return;
                const info = renderer.starBlocks();
                if (!info || info.dynamicVersion !== searchVersion) {
                        markSearchStale();
                        valSearch.textContent = 'star field changed · search again';
                        sysreadSearchText = valSearch.textContent;
                        if (!systemLayer.isOpen()) sysread.textContent = sysreadSearchText;
                        return;
                }
                searchPick.key = row.key;
                searchPick.kind = row.kind;
                searchPick.index = row.index;
                searchPick.x = row.x; searchPick.y = row.y; searchPick.z = row.z;
                searchPick.colorIndex = row.colorIndex;
                searchPick.absMag = row.absMag;
                searchPick.approximated = row.approximated ? 1 : 0;
                handleStarPick(searchPick, false);
                updateOverlay(renderer.state, camera.getState(statsText));
        }

        function clearSelection() {
                // The system view is the primary's view: no primary, no
                // schematic. Group 2 has its own clear action and is independent.
                if (systemLayer.isOpen()) closeSystemView();
                followKey = -1;
                aroundPending = false;
                starSet.clear();
                selectionStore.clearHistory(window.SelectionStore.GROUP_SPACE);
                setLabel = '';
                selected = -1;
                labels.setSelected(-1);
                syncSetUi();
        }

        function selectionRadiusKpc() {
                return Math.pow(10, Number(sliderSelRad.value)) * window.Camera.LY_TO_KPC;
        }

        // Plan §3.3, dispatch-exact (ui.2). The scan compares where the sky
        // *draws* each record with where it draws the primary — both through the
        // engine-mask dispatch the picker and the labels use — because a birth-position
        // scan answers a different question once the star clock has run: measured on a
        // 120k field at 100 Myr, a 50 ly birth scan kept stars drawn up to 3 172 ly
        // from the primary and missed the drawn neighbourhood. That costs a dispatch
        // per record, so the click begins a sweep (the picker's own contract) and the
        // loop applies it on the frame it lands. Nothing is precomputed per frame to
        // make the click cheaper — selection is rare and user-initiated, and a spatial
        // index kept warm in the frame loop would tax every frame to save one click.
        const aroundInputs = { mass: 0, lum: 0, teff: 0, age: 0, metal: 0 };
        const aroundPrimary = {
                key: 0, kind: 0, index: 0, x: 0, y: 0, z: 0,
                colorIndex: 0, absMag: 0, approximated: 0,
        };
        const aroundCentre = new Float64Array(3);
        let aroundPrimaryKey = -1;    // the key the pending scan is centred on

        // The primary's own snapshot, taken at begin time: it is never re-derived
        // from a record that may no longer be resident when the sweep lands.
        function snapshotAroundPrimary(p) {
                aroundPrimary.key = starSet.keys[p] >>> 0;
                aroundPrimary.kind = starSet.blockKind[p];
                aroundPrimary.index = starSet.bufferIdx[p];
                aroundPrimary.x = starSet.x[p];
                aroundPrimary.y = starSet.y[p];
                aroundPrimary.z = starSet.z[p];
                aroundPrimary.colorIndex = starSet.colorIndex[p];
                aroundPrimary.absMag = starSet.absMag[p];
                aroundPrimary.approximated = starSet.approximated[p] ? 1 : 0;
                aroundInputs.mass = starSet.mass[p];
                aroundInputs.lum = starSet.lum[p];
                aroundInputs.teff = starSet.teff[p];
                aroundInputs.age = starSet.age[p];
                aroundInputs.metal = starSet.metal[p];
        }

        function beginSelectAroundPrimary() {
                const p = starSet.primary;
                if (p < 0) return false;
                // The centre is drawn-space too: the primary's snapshot is a birth
                // position, and the two are kpc apart once the clock has run.
                memberDrawnPosition(p, aroundCentre);
                snapshotAroundPrimary(p);
                aroundPrimaryKey = aroundPrimary.key;
                aroundRadiusKpc = selectionRadiusKpc();
                aroundPending = selection.beginSelectAround(aroundCentre[0], aroundCentre[1],
                        aroundCentre[2], aroundRadiusKpc, starSet.capacity);
                return aroundPending;
        }

        // The frame the sweep lands on: the primary first, then the scan's members
        // in ascending drawn distance.
        function applyAroundResult() {
                aroundPending = false;
                const around = selection.around;
                if (around.aborted) {
                        // The streaming blocks were rewritten mid-scan, so the kept
                        // rows would name slots holding other stars. The set is left
                        // exactly as it was.
                        setLabel = 'star field changed mid-scan \u00b7 select around again';
                        syncSetUi();
                        return 0;
                }
                const p = starSet.primary;
                if (p < 0 || (starSet.keys[p] >>> 0) !== aroundPrimaryKey) return 0;
                const n = around.count;
                const cam = camera.cameraPos;
                starSet.clear();
                aroundPick.key = aroundPrimary.key;
                aroundPick.kind = aroundPrimary.kind;
                aroundPick.index = aroundPrimary.index;
                aroundPick.x = aroundPrimary.x;
                aroundPick.y = aroundPrimary.y;
                aroundPick.z = aroundPrimary.z;
                aroundPick.colorIndex = aroundPrimary.colorIndex;
                aroundPick.absMag = aroundPrimary.absMag;
                aroundPick.approximated = aroundPrimary.approximated;
                starSet.setPrimary(starSet.insert(aroundPick, aroundInputs,
                        cam[0], cam[1], cam[2], aroundPrimary.index));
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
                        `${formatLy(aroundRadiusKpc * LY_PER_KPC)} of ${memberName(starSet.primary)}${dropped}`;
                syncSetUi();
                return starSet.count;
        }

        // Light-years, for a readout that is about stars rather than galaxy structure.
        function formatLy(ly) {
                if (ly >= 10000) return `${(ly / 1000).toFixed(0)} kly`;
                if (ly >= 1000) return `${(ly / 1000).toFixed(1)} kly`;
                return ly >= 100 ? `${ly.toFixed(0)} ly` : `${ly.toFixed(1)} ly`;
        }

        // Shift+F (plan §3.4): orbit the primary at the luminosity stand-off.
        // The flight targets the star's *drawn* position, and the camera keeps
        // riding it: followKey names the set member the camera's orbit target is,
        // resolved by key every frame — so a residency rebuild that re-slots the
        // member does not lose it, and a member that leaves the residency simply
        // stops moving the target. One dispatch per frame, every block, every
        // engine mask (the ui.0 feed ran for landmarks under `simple` only).
        let followKey = -1;
        const followPos = new Float64Array(3);
        function followTarget() {
                const m = starSet.indexOfKey(followKey);
                if (m < 0) { followKey = -1; followVelFresh = false; return; }
                if (memberDrawnPosition(m, followPos) === window.Selection.DRAWN_STALE) return;
                // The velocity handover's feed (game-mode-plan §2): the ridden
                // object's drawn motion, kpc per ship-second, from the same
                // dispatch every other drawn feed uses — a fixed model-time
                // baseline, not a frame difference (ui.15: at the fine clock
                // rungs one frame is below the drawn position's own ULP, so a
                // frame difference seeds the handover with a 0/spike velocity).
                followVelFresh = memberDrawnVelocity(m, followVelPhys)
                        !== window.Selection.DRAWN_STALE;
                camera.updateTarget(followPos[0], followPos[1], followPos[2]);
        }
        function flyToPrimary() {
                const i = starSet.primary;
                if (i < 0) return false;
                const standOff = camera.orbitStandOff(starSet.lum[i]);
                memberDrawnPosition(i, drawnPos);
                camera.flyToStar(drawnPos[0], drawnPos[1], drawnPos[2], memberName(i), standOff);
                followKey = starSet.keys[i] >>> 0;
                return true;
        }

        // c (ui.4): orbit the primary where it stands — no flight, the camera
        // only turns and centres on the star. The follow feeds the drawn
        // position exactly like fly-to's does, so a moving star stays centred.
        function orbitPrimary() {
                const i = starSet.primary;
                if (i < 0) return false;
                memberDrawnPosition(i, drawnPos);
                camera.setOrbitTarget(drawnPos[0], drawnPos[1], drawnPos[2], memberName(i));
                camera.setMode(window.Camera.MODE_ORBIT_OBJECT);
                followKey = starSet.keys[i] >>> 0;
                return true;
        }

        // c and Shift+F need a selected star; a silent no-op reads as a dead key,
        // so the overlay says so for a few ticks.
        const NOTICE_TICKS = 12;       // overlay ticks (OVERLAY_INTERVAL each), ~3 s
        let noSelectionTicks = 0;
        function noSelectionLine() {
                return noSelectionTicks > 0 ? '\nno star selected \u00b7 click a star first' : '';
        }

        function cyclePrimary(delta) {
                if (starSet.count === 0) return;
                starSet.cyclePrimary(delta);
                const i = starSet.primary;
                const current = selectionStore.natural.current;
                if (i >= 0 && (!current || current.key !== (starSet.keys[i] >>> 0))) {
                        const ref = memberRefFor(i);
                        selectionStore.selectCurrent(window.SelectionStore.GROUP_SPACE,
                                selectionFromPick(ref, deriveMemberInputs(i)));
                }
                syncSetUi();
        }

        // --- Game mode (game-mode-plan.md G1) --------------------------------
        // The ship is the fly rig while g is on: camera.step keeps aiming (and
        // consuming the gated actions), the ship owns motion. The write-through
        // is camera.getState → ship.step → camera.setState on one scratch, so
        // camera.js has no game branch. The HUD is the §6 text block at the
        // overlay's 4 Hz.
        const rigState = { position: [0, 0, 0], velocity: [0, 0, 0], orientation: [0, 0, 0, 1], speedMult: 1, mode: 0 };
        const gameDir = new Float64Array(3);
        const gameTarget = new Float64Array(3);
        const gameVelocityAxes = new Float64Array(3);
        const profileOut = { speed: 0, dv: 0, timeS: 0, distanceM: 0 };
        let gameNoticeTicks = 0;
        let gameWheelAccum = 0;
        let gameTargetKey = -1;
        let gameTargetKind = 'target';   // 'target' | 'centre' | 'home'
        let gameTargetDistKpc = 0;
        let gameTargetPrevDistKpc = 0;
        let gameTargetClosingKpcS = 0;   // kpc per ship-second; > 0 is closing
        let gameTargetLum = 1;
        let gameTargetValid = false;
        const gameTargetVel = new Float64Array(3);   // drawn motion, kpc per ship-second
        // The ref the feed resolved this frame, so the velocity twin reads the
        // same record (null for a frame-fixed reference, which does not move).
        let gameTargetDrawnRef = null;
        const gameRel = new Float64Array(3);
        let gameTargetStale = false;                 // primary not resident: no drawn position
        // G4: the docked station and the home port. The station is the
        // target the ship docked at — destination or primary — remembered
        // as a pick-shaped snapshot so the ride feeds it by key, exactly
        // like the destination's own resolution. The home port is the
        // port of registry: the fixed galaxy home until the first dock,
        // the station's key after (§10.4).
        const stationDest = { kind: -1, index: -1, key: 0, x: 0, y: 0, z: 0 };
        let stationKey = -1;
        let stationIsDest = false;
        // The home port's feed state. The registry itself
        // lives on the ship record (per hull, like the
        // tank); these are this frame's resolution.
        const homePos = new Float64Array(3);
        let homeFeedKey = 0;
        let homeDistKpc = 0;
        let homePrevDistKpc = 0;
        let homeClosingKpcS = 0;   // kpc per ship-second; > 0 is closing
        let homeValid = false;
        let homePrevValid = false;
        let homeStale = false;
        let lastLifeState = 0;
        // The ship's commands are requested by a key and consumed in the game
        // block, after the target feed, so they read this frame's drawn state.
        const GAME_CMD_APPROACH = 1, GAME_CMD_FOLLOW = 2, GAME_CMD_ABORT = 3, GAME_CMD_PLAN = 4;
        const GAME_CMD_TARGET = 5;
        let gameCommand = 0;
        let autoRunning = false;
        let autoMsg = '';
        let autoMsgTicks = 0;
        // The speed reference (§7.4): the object the axis velocities,
        // the HUD target line and the autopilot answer against. An
        // explicit centre or home choice wins over the locked Flight
        // destination, which wins over the primary selection. The
        // galactic centre and home are frame-fixed points — always
        // resident, never stale, at rest — so the ship can fly to the
        // centre itself, and its speeds read in the galactic frame.
        let speedRef = 'target';

        function setSpeedRef(kind) {
                if (speedRef === kind) return;
                speedRef = kind;
                gameTargetFeed(0);
                syncFlightUi();
        }

        function gameNotice() { gameNoticeTicks = NOTICE_TICKS; }
        function gameNoticeLine() {
                return gameNoticeTicks > 0 ? '\nnot in game mode \u00b7 g returns to observer' : '';
        }

        // The velocity handover's feed (§2): the followed object's drawn motion
        // as `memberDrawnVelocity` resolves it — kpc per ship-second, the same
        // units as the ship's own and independent of the clock rung, so the
        // handover is continuous in the motion the user sees.
        const followVelPhys = new Float64Array(3);
        let followVelFresh = false;
        let framePhysSeconds = 0;

        function positionCameraAtActiveShip() {
                const state = camera.getState(rigState);
                state.position[0] = ship.pos[0]; state.position[1] = ship.pos[1]; state.position[2] = ship.pos[2];
                state.velocity[0] = ship.vel[0]; state.velocity[1] = ship.vel[1]; state.velocity[2] = ship.vel[2];
                state.orientation[0] = ship.heading[0]; state.orientation[1] = ship.heading[1];
                state.orientation[2] = ship.heading[2]; state.orientation[3] = ship.heading[3];
                state.mode = window.Camera.MODE_FLY;
                camera.setState(rigState);
        }

        function enterGameMode() {
                if (systemLayer.isOpen()) closeSystemView();
                camera.setMode(window.Camera.MODE_FLY);
                const state = camera.getState(rigState);
                if (!activeFleetShip.positioned) {
                        // A fresh hull spawns at the camera's pose —
                        // position *and* heading, so it flies the way
                        // the observer was looking.
                        ship.pos[0] = state.position[0]; ship.pos[1] = state.position[1]; ship.pos[2] = state.position[2];
                        ship.heading[0] = state.orientation[0]; ship.heading[1] = state.orientation[1];
                        ship.heading[2] = state.orientation[2]; ship.heading[3] = state.orientation[3];
                        activeFleetShip.positioned = true;
                }
                // On a fresh launch from a live follow, seed the ship with the
                // followed object's physical velocity. An already flown hull
                // keeps its own stored velocity when the pilot returns to it.
                if (!activeFleetShip.entered && followKey >= 0 && followVelFresh) {
                        ship.vel[0] = followVelPhys[0];
                        ship.vel[1] = followVelPhys[1];
                        ship.vel[2] = followVelPhys[2];
                }
                activeFleetShip.entered = true;
                positionCameraAtActiveShip();
                shipTimeRateCapY = Infinity;
                // Rebase range on this hull but retain the keyed target's
                // physical-velocity sample when the observer already warmed it.
                gameTargetFeed(0);
                gameTargetClosingKpcS = 0;
                syncStarTime();
                syncFleetUi();
                syncViewRows();
                syncFlightUi();
        }

        function leaveGameMode() {
                shipLib.apAbort(ship);
                autoRunning = false;
                gameCommand = 0;
                shipTimeRateCapY = Infinity;
                syncStarTime();
                syncFleetUi();
                syncViewRows();
                syncFlightUi();
        }

        function throttleBar(frac) {
                const full = Math.round(Math.max(0, Math.min(1, frac)) * 5);
                return '\u25ae'.repeat(full) + '\u25af'.repeat(5 - full);
        }

        function formatWall(seconds) {
                if (!Number.isFinite(seconds)) return '\u2014';
                if (seconds < 120) return seconds.toFixed(0) + ' s';
                if (seconds < 7200) return Math.round(seconds / 60) + ' min';
                if (seconds < 2 * 86400) return (seconds / 3600).toFixed(1) + ' h';
                return (seconds / 86400).toFixed(1) + ' d';
        }

        // --- Flight workspace (G3) ------------------------------------------
        // A destination is a compact pick-shaped snapshot, deliberately not an
        // index into the mutable primary selection. Selection.resolveDrawn
        // validates its key every frame, so changing selections cannot retarget
        // an engaged flight and a residency loss is visible instead of a trip to
        // a stale birth coordinate.
        function setFlightDestinationFromPrimary() {
                const i = starSet.primary;
                if (i < 0) {
                        noSelectionTicks = NOTICE_TICKS;
                        return false;
                }
                const ref = memberRefFor(i);
                flightDestination.active = true;
                flightDestination.key = ref.key >>> 0;
                flightDestination.kind = ref.kind | 0;
                flightDestination.index = ref.index | 0;
                flightDestination.x = ref.x; flightDestination.y = ref.y; flightDestination.z = ref.z;
                flightDestination.colorIndex = ref.colorIndex;
                flightDestination.absMag = ref.absMag;
                flightDestination.lum = starSet.lum[i];
                flightDestination.name = memberName(i);
                // gameTargetFeed keeps the current physical-velocity sample
                // when this is the same key, and rebases it for a new target.
                gameTargetFeed(0);
                gameTargetClosingKpcS = 0;
                return true;
        }

        function clearFlightDestination() {
                if (ship.ap.mode !== shipLib.AP_OFF) return;
                flightDestination.active = false;
                flightDestination.key = 0;
                flightDestination.kind = -1;
                flightDestination.index = -1;
                flightDestination.name = '';
                gameTargetKey = -1;
                gameTargetKind = 'target';
                gameTargetValid = false;
                gameTargetStale = false;
        }

        function flightStandOffM() {
                return camera.orbitStandOff(gameTargetLum) * shipLib.KPC_M;
        }

        // Mutates the one reusable plan record. It is called at UI cadence or
        // once when Engage is pressed, never as a per-frame allocation path.
        function updateFlightPlan() {
                if (!flightDestination.active) return false;
                // Refresh even with the same key: the forecast is allowed while
                // observing, so it must read the destination where the sky draws
                // it now rather than a previous panel tick.
                gameTargetFeed(0);
                if (!gameTargetValid || gameTargetStale) return false;
                // Entering game mode adopts the current camera pose. Forecast
                // from that pose while configuring outside game mode, not from
                // the parked ship position from an earlier sortie.
                const from = gameMode ? ship.pos : camera.cameraPos;
                const dx = gameTarget[0] - from[0];
                const dy = gameTarget[1] - from[1];
                const dz = gameTarget[2] - from[2];
                const distanceM = Math.sqrt(dx * dx + dy * dy + dz * dz) * shipLib.KPC_M;
                const standOffM = flightStandOffM();
                const remainingM = Math.max(0, distanceM - standOffM);
                shipLib.planJourney(remainingM, ship, flightMode, flightThrust,
                        flightSpeedFraction, flightTimeLimitYears * shipLib.SECONDS_PER_YEAR, flightPlan);
                // This mirrors enterGameMode's velocity handover, so planning
                // while observing a moving object does not forecast a spurious
                // match burn that the toggle will immediately remove.
                const forecastVel = !gameMode && followKey >= 0 && followVelFresh ? followVelPhys : ship.vel;
                const rvx = forecastVel[0] - gameTargetVel[0];
                const rvy = forecastVel[1] - gameTargetVel[1];
                const rvz = forecastVel[2] - gameTargetVel[2];
                flightPlan.standOffM = standOffM;
                flightPlan.matchDv = Math.hypot(rvx, rvy, rvz) * shipLib.KPC_M;
                flightPlan.totalDv = flightPlan.dv + flightPlan.matchDv;
                flightPlan.fuelMargin = shipLib.dvRemaining(ship) - flightPlan.totalDv;
                return true;
        }

        function flightLimitText() {
                if (flightMode === shipLib.NAV_THRUST_LIMIT) return Math.round(flightThrust * 100) + '% thrust';
                if (flightMode === shipLib.NAV_SPEED_LIMIT) return Math.round(flightSpeedFraction * 100) + '% speed';
                if (flightMode === shipLib.NAV_TIME_LIMIT) return Number(flightTimeLimitYears.toPrecision(4)) + ' y limit';
                return 'full thrust · top speed';
        }

        function flightForecastText(ready) {
                const dvLib = window.DeltaVLib;
                const autoActive = ship.ap.mode !== shipLib.AP_OFF;
                // When autopilot is flying, show live progress instead of a
                // constantly shrinking forecast — the old code recomputed the
                // plan every 250 ms from the shrinking distance, so the <pre>
                // was rewritten every tick (“redraw that message every frame”).
                if (autoActive) {
                        const ap = ship.ap;
                        const flownPct = ap.etaTotalS > 0 ? Math.max(0, Math.min(100, 100 * (1 - ap.etaS / ap.etaTotalS))) : 100;
                        const rateY = gameTimeRateY();
                        const wallS = rateY > 0 ? ap.etaS / (rateY * shipLib.SECONDS_PER_YEAR) : Infinity;
                        const distLy = formatLy(gameTargetDistKpc * LY_PER_KPC);
                        if (ap.mode === shipLib.AP_TARGET) {
                                return `${gameTargetName()} · ${distLy} · stop at target\n`
                                        + `Δv spent ${shipLib.formatDv(ap.dvSpent)} / ${shipLib.formatDv(ap.dvRequired)} · relative ${shipLib.formatDv(ap.relativeMs)}\n`
                                        + `0,0,0 when ${distLy} < 1 AU · uncheck to abort`;
                        }
                        return `${gameTargetName()} · ${distLy} · ${shipLib.AP_PHASE_NAMES[ap.phase]} ${Math.round(flownPct)}%\n`
                                + `Δv ${shipLib.formatDv(ap.dvSpent)}/${shipLib.formatDv(ap.dvRequired)} · eta ${dvLib.formatDuration(ap.etaS)} ship · ${formatWall(wallS)} wall\n`
                                + `uncheck autopilot to abort · velocity kept`;
                }
                if (!flightDestination.active) return '1. Select a star\n2. Use selected\n3. Choose a mode and check autopilot';
                if (!ready) return gameTargetStale
                        ? 'Destination is not resident\nChoose a visible star or wait for it to stream in.'
                        : 'Resolving destination…';
                if (!flightPlan.feasible) {
                        let text = `Cannot plan ${flightDestination.name || 'destination'}\n${shipLib.NAV_REASON_NAMES[flightPlan.reason] || 'invalid flight limit'}`;
                        if (flightPlan.reason === shipLib.NAV_REASON_TIME && Number.isFinite(flightPlan.fastestS)) {
                                text += `\nFastest legal arrival: ${dvLib.formatDuration(flightPlan.fastestS)} ship`;
                        }
                        return text;
                }
                const rateY = shipLib.timeRateYPerS(ship, shipLib.speedC(ship));
                const wallS = rateY > 0 ? flightPlan.timeS / (rateY * shipLib.SECONDS_PER_YEAR) : Infinity;
                const distance = formatLy((flightPlan.distanceM + flightPlan.standOffM) / shipLib.KPC_M * LY_PER_KPC);
                const match = flightPlan.matchDv > 0.5 ? ` + ${shipLib.formatDv(flightPlan.matchDv)} match` : '';
                const margin = flightPlan.fuelMargin >= 0
                        ? `${shipLib.formatDv(flightPlan.fuelMargin)} margin`
                        : `${shipLib.formatDv(-flightPlan.fuelMargin)} short`;
                return `${flightDestination.name || 'Destination'} · ${distance}\n`
                        + `Δv predicted ${shipLib.formatDv(flightPlan.totalDv)}${match} · ${margin}\n`
                        + `arrival ${dvLib.formatDuration(flightPlan.timeS)} ship · ${formatWall(wallS)} wall\n`
                        + `${shipLib.NAV_MODE_NAMES[flightMode]} · ${flightLimitText()}`;
        }

        // One small display owner for the Flight panel. Values are allowed to be
        // prepared outside game mode; Engage alone is gated, so a player can
        // choose a ship and compare a route before taking the helm.
        // The forecast/status texts are only written when they actually change,
        // fixing the “redraw that message every frame” flicker.
        let lastFlightStatus = '';
        let lastFlightForecast = '';
        function setTextIfChanged(el, text) {
                if (el.textContent !== text) el.textContent = text;
        }
        function syncFlightUi() {
                const autoActive = ship.ap.mode !== shipLib.AP_OFF;
                // Freeze the forecast plan while autopilot flies: recomputing
                // from the shrinking distance made the <pre> change every 250 ms
                // and also clobbered the velocity baseline via gameTargetFeed(0).
                const ready = autoActive ? (flightDestination.active && gameTargetValid && !gameTargetStale) : updateFlightPlan();
                const capC = shipLib.cruiseCapKpcS(ship) * shipLib.KPC_M / shipLib.C;
                shipLib.velocityComponents(ship, camera.forward, camera.right, camera.up,
                        gameTargetValid && !gameTargetStale ? gameTargetVel : null, gameVelocityAxes);
                velocityForward.textContent = shipLib.formatAxisSpeed(gameVelocityAxes[0]);
                velocityRight.textContent = shipLib.formatAxisSpeed(gameVelocityAxes[1]);
                velocityUp.textContent = shipLib.formatAxisSpeed(gameVelocityAxes[2]);
                velocityRef.textContent = gameTargetValid ? gameTargetName() : 'no reference';
                syncFleetUi();
                const speedControl = flightControl === 'speed';
                flightThrustRow.classList.toggle('is-off', speedControl);
                flightSpeedRow.classList.toggle('is-off', !speedControl);
                flightThrustSlider.value = Math.round(flightThrust * 100);
                flightThrustValue.textContent = Math.round(flightThrust * 100) + (flightThrust > 0 ? '% forward' : '% · coast')
                        + (speedControl ? ' · speed control' : ' · thrust control');
                flightSpeedSlider.value = Math.round(flightSpeedFraction * 100);
                flightSpeedGovernorBox.checked = speedControl;
                flightSpeedValue.textContent = `${shipLib.formatSpeedC(capC * flightSpeedFraction)} · ${Math.round(flightSpeedFraction * 100)}% cap`
                        + (speedControl ? ' · speed control' : ' · thrust control');
                flightModeSelect.value = String(flightMode);
                flightTimeLimitBox.value = Number(flightTimeLimitYears.toPrecision(8));
                flightTimeRow.style.display = flightMode === shipLib.NAV_TIME_LIMIT ? '' : 'none';
                flightDestinationLabel.textContent = flightDestination.active
                        ? (flightDestination.name || 'Locked destination') : 'No destination set';
		flightDock.textContent = ship.docked ? 'Undock' : 'Dock';
		flightDock.disabled = !gameMode;
		const portIndex = gameTradePort();
		flightCargoLoad.disabled = flightCargoUnload.disabled = !gameMode || portIndex < 0;
		const holdTag = ship.cargoResource >= 0 && ship.cargoResource < economyLib.RESOURCE_COUNT
			? ' · ' + economyLib.RESOURCES[ship.cargoResource].name : '';
		let portText = 'not docked · O docks at a settled station';
		if (ship.docked) {
			portText = `docked at ${ship.station.name} · tank and life restored`;
			if (portIndex < 0) portText += ' · no trade colony';
			else {
				const port = tradeNet.ports[portIndex];
				economyLib.settleColony(port.colony, tradeNet.time);
				let best = -1, score = 0;
				for (let r = 0; r < economyLib.RESOURCE_COUNT; r++) {
					const value = economyLib.exportableOf(port.colony, r) * economyLib.RESOURCES[r].worth;
					if (value > score) { score = value; best = r; }
				}
				portText += ` · ${port.name} · ${economyLib.formatPop(port.colony.pop)}`
					+ ' · exports ' + (best < 0 ? 'nothing spare' : economyLib.RESOURCES[best].name);
			}
			portText += ` · cargo ${shipLib.formatCargo(ship.cargo)}/${shipLib.formatCargo(ship.class.cargo)}${holdTag}`;
		}
		setTextIfChanged(flightPortState, portText);
                flightUseSelected.disabled = starSet.primary < 0 || autoActive;
                flightClearDestination.disabled = !flightDestination.active || autoActive;
                // Unified checkbox UI: destination autopilot and target-stop are
                // two mutually exclusive checkboxes, no Engage/Abort buttons.
                const destFeasible = ready && flightPlan.feasible && flightPlan.fuelMargin >= 0;
                flightAutoDest.checked = (ship.ap.mode === shipLib.AP_APPROACH && gameCommand !== GAME_CMD_ABORT)
                        || (gameMode && gameCommand === GAME_CMD_PLAN);
                flightAutoDest.disabled = !gameMode
                        || (autoActive && ship.ap.mode !== shipLib.AP_APPROACH)
                        || !flightDestination.active
                        || (!autoActive && !destFeasible)
                        || ship.docked;
                flightAutoTarget.checked = (ship.ap.mode === shipLib.AP_TARGET && gameCommand !== GAME_CMD_ABORT)
                        || (gameMode && gameCommand === GAME_CMD_TARGET);
                flightAutoTarget.disabled = !gameMode
                        || (autoActive && ship.ap.mode !== shipLib.AP_TARGET)
                        || (starSet.primary < 0 && !flightDestination.active && !autoActive)
                        || ship.docked;
                const statusText = ship.ap.mode === shipLib.AP_TARGET
                        ? 'autopilot · matching target motion'
                        : autoActive ? `autopilot ${shipLib.AP_PHASE_NAMES[ship.ap.phase]} · uncheck to abort, velocity kept`
                                : gameMode ? 'manual thrust + destination planner'
                                        : 'configure now · select a ship to pilot';
                if (statusText !== lastFlightStatus) {
                        flightStatus.textContent = statusText;
                        lastFlightStatus = statusText;
                }
                const forecastText = flightForecastText(ready);
                if (forecastText !== lastFlightForecast) {
                        flightForecast.textContent = forecastText;
                        lastFlightForecast = forecastText;
                }
        }

        // The HUD target is the speed reference (§7.4): an explicit
        // centre/home choice, else the locked Flight destination, else
        // the primary selection — in drawn space (ui.2). It resolves
        // every frame so the closing rate is frame-rate honest; the
        // overlay only reads the numbers at its own 4 Hz.
        // dtShipS == 0 is the UI probe: it resolves the position but must NOT
        // clobber the distance baseline (gameTargetPrevDistKpc) that the ship
        // loop maintains for its closing rate. Without this guard a 4 Hz UI
        // tick overwrites the prev that the game loop just set, making the
        // target appear stationary.
        //
        // The target's *velocity* is not a frame difference (ui.15): it comes
        // from the drawn-velocity dispatch in selection.js, which samples the
        // model a fixed model-time baseline apart. A one-frame difference of the
        // drawn position is below its own f64 ULP at the fine clock rungs, so it
        // reads 0 or a coordinate-axis spike — and the autopilot's nose is built
        // from it, which was the reported per-frame direction glitch.
        function gameTargetFeed(dtShipS) {
                const isProbe = !(dtShipS > 0);
                gameTargetDrawnRef = null;
                if (ship.docked) {
                        // G4: the docked ride feeds the station itself,
                        // whatever the speed reference says — the ship
                        // rides it, so the feed must not wander to a
                        // frame-fixed point or another star.
                        gameTargetKind = 'station';
                        gameTargetStale = false;
                        if (stationIsDest) {
                                gameTargetLum = stationDest.lum;
                                gameTargetStale = selection.resolveDrawn(stationDest, gameTarget)
                                        === window.Selection.DRAWN_STALE;
                                gameTargetDrawnRef = stationDest;
                        } else {
                                const m = starSet.indexOfKey(stationKey);
                                if (m < 0) gameTargetStale = true;
                                else {
                                        gameTargetStale = memberDrawnPosition(m, gameTarget)
                                                === window.Selection.DRAWN_STALE;
                                        if (!gameTargetStale) gameTargetLum = starSet.lum[m];
                                        gameTargetDrawnRef = memberRefFor(m);
                                }
                        }
                } else if (speedRef !== 'target') {
                        const p = speedRef === 'centre' ? model.centre : model.home.orbitTarget;
                        if (gameTargetKind !== speedRef) {
                                gameTargetKind = speedRef;
                                gameTargetKey = -1;
                                gameTargetValid = false;
                        }
                        gameTarget[0] = p.x !== undefined ? p.x : p[0];
                        gameTarget[1] = p.y !== undefined ? p.y : p[1];
                        gameTarget[2] = p.z !== undefined ? p.z : p[2];
                        gameTargetLum = 0;
                        gameTargetStale = false;
                } else {
                        gameTargetKind = 'target';
                        const locked = flightDestination.active;
                        const i = locked ? -1 : starSet.primary;
                        if (!locked && i < 0) {
                                gameTargetValid = false;
                                gameTargetKey = -1;
                                gameTargetStale = false;
                                return;
                        }
                        const key = locked ? flightDestination.key >>> 0 : starSet.keys[i] >>> 0;
                        if (key !== gameTargetKey) {
                                gameTargetKey = key;
                                gameTargetValid = false;
                        }
                        gameTargetLum = locked ? flightDestination.lum : starSet.lum[i];
                        gameTargetStale = locked
                                ? selection.resolveDrawn(flightDestination, gameTarget) === window.Selection.DRAWN_STALE
                                : memberDrawnPosition(i, gameTarget) === window.Selection.DRAWN_STALE;
                        gameTargetDrawnRef = locked ? flightDestination : memberRefFor(i);
                }
                const dx = gameTarget[0] - ship.pos[0];
                const dy = gameTarget[1] - ship.pos[1];
                const dz = gameTarget[2] - ship.pos[2];
                const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
                // The target's own drawn motion, every feed: the dispatch is a
                // function of the model clock, so a probe can refresh it too and
                // a frame-fixed reference is exactly still.
                if (gameTargetDrawnRef && !gameTargetStale) {
                        selection.resolveDrawnVelocity(gameTargetDrawnRef, gameTargetVel);
                } else {
                        gameTargetVel.fill(0);
                }
                if (gameTargetValid && dtShipS > 0) {
                        gameTargetClosingKpcS = (gameTargetPrevDistKpc - dist) / dtShipS;
                } else if (!gameTargetValid) {
                        gameTargetClosingKpcS = 0;
                }
                // Only advance the distance baseline on real steps; a 0-dt probe
                // must leave it alone so the next real step measures one frame of
                // closing, not the UI tick.
                if (!isProbe || !gameTargetValid) {
                        gameTargetPrevDistKpc = dist;
                }
                gameTargetDistKpc = dist;
                gameTargetValid = true;
        }

        // G4's home feed (§10.4): the port of registry — the fixed
        // galaxy home until the first dock, the station's key after —
        // resolved each frame like every other drawn-space target, so
        // the return-home marker and the HUD line read where the sky
        // draws the port. A star home that leaves the residency is
        // reported, never flown to from a stale birth coordinate.
        function gameHomeFeed(dtShipS) {
                // The registry rides the ship record: the
                // fixed galaxy home until the first dock,
                // the station's key after. A changed port
                // rebases the distance baseline, so the
                // closing rate never reads one frame of
                // teleport as motion (the follow feed's
                // own rebase rule).
                const fixed = ship.home.kind === 'fixed';
                const key = fixed ? 0 : ship.home.key;
                let valid = false;
                if (fixed) {
                        const p = model.home.orbitTarget;
                        homePos[0] = p.x !== undefined ? p.x : p[0];
                        homePos[1] = p.y !== undefined ? p.y : p[1];
                        homePos[2] = p.z !== undefined ? p.z : p[2];
                        valid = true;
                } else {
                        const m = starSet.indexOfKey(ship.home.key);
                        if (m >= 0 && memberDrawnPosition(m, homePos) !== window.Selection.DRAWN_STALE) valid = true;
                }
                if (valid) {
                        const dx = homePos[0] - ship.pos[0];
                        const dy = homePos[1] - ship.pos[1];
                        const dz = homePos[2] - ship.pos[2];
                        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
                        // Only a real step between two valid
                        // frames on the same port measures
                        // the closing rate; a probe or a
                        // freshly valid port must leave the
                        // baseline alone, exactly like the
                        // target feed's.
                        if (dtShipS > 0 && homePrevValid && key === homeFeedKey) {
                                homeClosingKpcS = (homePrevDistKpc - dist) / dtShipS;
                        }
                        homeFeedKey = key;
                        homePrevDistKpc = dist;
                        homeDistKpc = dist;
                } else {
                        homeClosingKpcS = 0;
                }
                homePrevValid = valid;
                homeValid = valid;
                homeStale = !fixed && !valid;
        }

        function homeNameOf() {
                return ship.home.kind === 'fixed' ? model.home.orbitName : ship.home.name;
        }

        // The frame's ship law: the thrust blend on the camera's live basis
        // (mouse aims, exactly the fly camera's look), the integrate-and-clamp
        // of ship.js, and the write-through. Runs *after* camera.step so the
        // look just applied is kept and the observer's fly integration — which
        // ran with the same keys — is discarded before the frame draws.
        function gameShipStep(dtShipS, dtWallS) {
                const keys = input.state.keys;
                const factor = keys.boost ? 4 : keys.slow ? 0.25 : 1;
                const forwardKey = (keys.forward ? 1 : 0) - (keys.back ? 1 : 0);
                // The Pilot controls answer "how fast" two mutually
                // exclusive ways: thrust control commands the burn
                // (the lever, persistent), speed control holds a
                // limit (forward thrust cuts at the desired speed
                // — no hidden brake, so a pilot still owns
                // deceleration). The last control touched owns the
                // forward axis; a direct W/S input temporarily takes
                // it over either way, and A/D/E/Q always steer.
                const speedControl = flightControl === 'speed';
                let f = forwardKey !== 0 ? forwardKey : speedControl ? 0 : flightThrust;
                const r = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
                const u = (keys.up ? 1 : 0) - (keys.down ? 1 : 0);
                const desiredSpeed = shipLib.cruiseCapKpcS(ship) * flightSpeedFraction;
                const currentSpeed = Math.hypot(ship.vel[0], ship.vel[1], ship.vel[2]);
                const governorCap = speedControl && f > 0 && currentSpeed < desiredSpeed
                        ? desiredSpeed : 0;
                if (speedControl && f > 0 && currentSpeed >= desiredSpeed) f = 0;
                gameDir[0] = f * camera.forward[0] + r * camera.right[0] + u * camera.up[0];
                gameDir[1] = f * camera.forward[1] + r * camera.right[1] + u * camera.up[1];
                gameDir[2] = f * camera.forward[2] + r * camera.right[2] + u * camera.up[2];
                // The persistent lever does not fight an engaged autopilot. A
                // real key press is the explicit manual override that aborts it.
                const thrusting = forwardKey !== 0 || r !== 0 || u !== 0;
                // G4: any thrust input takes the ship out of the
                // port — the pilot owns the ship the moment they
                // command it (§10.2).
                if (ship.docked && thrusting) gameUndock();
                const flying = !ship.docked && ship.ap.mode !== shipLib.AP_OFF;
                if (flying && (gameTargetStale || !gameTargetValid)) {
                        // The target left the residency: its drawn position is not a
                        // place to fly to, so the flight ends and says why.
                        shipLib.apAbort(ship);
                        autoRunning = false;
                        shipTimeRateCapY = Infinity;
                        syncStarTime();
                        setAutoMsg('target lost \u00b7 autopilot off');
                } else if (flying && thrusting) {
                        shipLib.apAbort(ship);
                        shipTimeRateCapY = Infinity;
                }
                if (ship.docked) {
                        // The docked ride: the station's drawn
                        // position and physical velocity, copied
                        // each frame. A station that left the
                        // residency breaks the dock — its drawn
                        // position is not a place to be.
                        if (gameTargetStale || !gameTargetValid) {
                                gameUndock();
                                setAutoMsg('station left the residency');
                        } else {
                                shipLib.dockStep(ship,
                                        gameTarget[0], gameTarget[1], gameTarget[2],
                                        gameTargetVel[0], gameTargetVel[1], gameTargetVel[2]);
                        }
                } else if (ship.ap.mode !== shipLib.AP_OFF) {
                        ship.accelNow = shipLib.apStep(ship, dtShipS, dtWallS,
                                gameTarget[0], gameTarget[1], gameTarget[2],
                                gameTargetVel[0], gameTargetVel[1], gameTargetVel[2]);
                } else {
                        shipLib.step(ship, dtShipS, gameDir[0], gameDir[1], gameDir[2], factor, governorCap);
                }
                const s = camera.getState(rigState);
                s.position[0] = ship.pos[0];
                s.position[1] = ship.pos[1];
                s.position[2] = ship.pos[2];
                s.velocity[0] = ship.vel[0];
                s.velocity[1] = ship.vel[1];
                s.velocity[2] = ship.vel[2];
                camera.setState(rigState);
                // The ship is the camera while flying: the heading
                // the pilot aimed is the hull's heading, stored so
                // another hull's (and this one's, on a later entry)
                // re-pose is exact.
                ship.heading[0] = s.orientation[0];
                ship.heading[1] = s.orientation[1];
                ship.heading[2] = s.orientation[2];
                ship.heading[3] = s.orientation[3];
        }

        function gameTargetName() {
                if (ship.docked) return ship.station.name;
                if (gameTargetKind === 'centre') return 'galactic centre';
                if (gameTargetKind === 'home') return model.home.orbitName;
                if (flightDestination.active) return flightDestination.name || 'Destination';
                const i = starSet.primary;
                return i >= 0 ? memberName(i) : 'S' + gameTargetKey.toString(36).toUpperCase();
        }
        function gameTargetLine() {
                const dvLib = window.DeltaVLib;
                if (!gameTargetValid) return '\ntarget    none selected \u00b7 click a star';
                let line = `\ntarget    ${gameTargetName()}   ${formatLy(gameTargetDistKpc * LY_PER_KPC)}`;
                const closing = gameTargetClosingKpcS;
                if (closing > 0) {
                        line += ` \u00b7 closing ${shipLib.formatSpeedC(closing * shipLib.KPC_M / shipLib.C)}`;
                        const shipS = gameTargetDistKpc / closing;
                        const rateY = shipLib.timeRateYPerS(ship, shipLib.speedC(ship));
                        const wallS = rateY > 0 ? shipS / (rateY * shipLib.SECONDS_PER_YEAR) : Infinity;
                        line += ` \u00b7 coast eta ${dvLib.formatDuration(shipS)} ship \u00b7 ${formatWall(wallS)} wall`;
                } else {
                        line += closing < 0
                                ? ` \u00b7 receding ${shipLib.formatSpeedC(closing * shipLib.KPC_M / shipLib.C)} \u00b7 coast eta \u2014`
                                : ' \u00b7 closing 0 \u00b7 coast eta \u2014';
                }
                // The §5 profile ETA — the numbers that sell the restrictions —
                // computed from the closed form even before G2 flies it.
                shipLib.apProfile(gameTargetDistKpc * shipLib.KPC_M, ship, profileOut);
                line += Number.isFinite(profileOut.timeS)
                        ? ` \u00b7 ap eta ${dvLib.formatDuration(profileOut.timeS)}`
                        : ' \u00b7 ap eta \u2014';
                return line;
        }

        // --- Autopilot commands (game-mode-plan §5, G2) ----------------------
        // Shift+F (approach), j (follow) and f (abort) are the ship's commands.
        // The key records the request; gameApplyCommand runs it in the game
        // block. Refusals and ends are one short message line, never a silent
        // no-op, and nothing here runs per frame except the ease and the feed.
        function setAutoMsg(text) {
                autoMsg = text;
                autoMsgTicks = NOTICE_TICKS;
        }

        // The reason codes ship.js keeps, as the sentence the HUD says.
        function autoReasonText(reason) {
                const ap = ship.ap;
                switch (reason) {
                        case shipLib.AP_REASON_FUEL:
                                return `insufficient \u0394v: need ${shipLib.formatDv(ap.reasonDv)}, have ${shipLib.formatDv(shipLib.dvRemaining(ship))}`;
                        case shipLib.AP_REASON_HOT:
                                return `hot approach \u00b7 closing ${shipLib.formatSpeedC(ap.closingMs / shipLib.C)} \u00b7 null it first (Space)`;
                        case shipLib.AP_REASON_LOCAL: return 'ship is in-system only';
                        case shipLib.AP_REASON_CLOSE: return 'already at the stand-off';
                        case shipLib.AP_REASON_NO_TARGET: return 'no star selected \u00b7 click a star first';
                        case shipLib.AP_REASON_ARRIVED: return 'arrived \u00b7 target-relative velocity 0, 0, 0';
                        case shipLib.AP_REASON_ABORTED: return 'autopilot off \u00b7 velocity kept';
                        default: return '';
                }
        }

        function gameTargetOffset() {
                gameRel[0] = gameTarget[0] - ship.pos[0];
                gameRel[1] = gameTarget[1] - ship.pos[1];
                gameRel[2] = gameTarget[2] - ship.pos[2];
        }

        function gameTargetUsable() {
                if (!gameTargetValid) {
                        noSelectionTicks = NOTICE_TICKS;
                        return false;
                }
                if (gameTargetStale) {
                        setAutoMsg('target is not resident · no drawn position to fly to');
                        return false;
                }
                return true;
        }

        // G4: a docked ship is the port's until the pilot
        // leaves it — no flight command engages from the dock.
        function gameUndockRequired() {
                if (ship.docked) {
                        setAutoMsg('undock first');
                        return true;
                }
                return false;
        }

        // Shift+F remains the fast, class-limited approach. It uses the locked
        // destination when one exists; otherwise it keeps the primary-selection
        // G2 behaviour.
        function gameApproach() {
                if (gameUndockRequired()) return;
                if (!gameTargetUsable()) return;
                gameTargetOffset();
                const reason = shipLib.apCommitApproach(ship, gameRel[0], gameRel[1], gameRel[2],
                        gameTargetVel[0], gameTargetVel[1], gameTargetVel[2], flightStandOffM());
                if (reason !== shipLib.AP_REASON_NONE) setAutoMsg(autoReasonText(reason));
        }

        function gameStopAtTarget() {
                if (gameUndockRequired()) return;
                if (!flightDestination.active && !setFlightDestinationFromPrimary()) {
                        noSelectionTicks = NOTICE_TICKS;
                        return;
                }
                if (!gameTargetUsable()) return;
                gameTargetOffset();
                const reason = shipLib.apCommitTarget(ship, gameRel[0], gameRel[1], gameRel[2],
                        gameTargetVel[0], gameTargetVel[1], gameTargetVel[2]);
                if (reason !== shipLib.AP_REASON_NONE) setAutoMsg(autoReasonText(reason));
                else setAutoMsg('autopilot to target · zero relative speed at arrival');
        }

        // §5's follow (j): null the relative velocity, trail at the stand-off.
        // Pressed again it aborts, like the observer's chase toggle.
        function gameFollow() {
                if (gameUndockRequired()) return;
                if (ship.ap.mode === shipLib.AP_FOLLOW) {
                        shipLib.apAbort(ship);
                        setAutoMsg('autopilot off · velocity kept');
                        return;
                }
                if (!gameTargetUsable()) return;
                gameTargetOffset();
                shipLib.apCommitFollow(ship, gameRel[0], gameRel[1], gameRel[2],
                        gameTargetVel[0], gameTargetVel[1], gameTargetVel[2], flightStandOffM());
        }

        // G3's explicit engage action. The checked forecast is copied into the
        // autopilot record by ship.js, then the active controls may be adjusted
        // for the next trip without altering this burn.
        function gameEngageFlightPlan() {
                if (gameUndockRequired()) return;
                if (!flightDestination.active) {
                        setAutoMsg('set a destination first · select a star, then Use selected');
                        return;
                }
                if (!gameTargetUsable()) return;
                if (!updateFlightPlan()) return;
                if (!flightPlan.feasible) {
                        setAutoMsg(shipLib.NAV_REASON_NAMES[flightPlan.reason] || 'invalid flight plan');
                        return;
                }
                if (flightPlan.fuelMargin < 0) {
                        setAutoMsg(`insufficient Δv: need ${shipLib.formatDv(flightPlan.totalDv)}, have ${shipLib.formatDv(shipLib.dvRemaining(ship))}`);
                        return;
                }
                gameTargetOffset();
                const reason = shipLib.apCommitApproach(ship, gameRel[0], gameRel[1], gameRel[2],
                        gameTargetVel[0], gameTargetVel[1], gameTargetVel[2], flightPlan.standOffM, flightPlan);
                if (reason !== shipLib.AP_REASON_NONE) setAutoMsg(autoReasonText(reason));
        }

        function gameAbort() {
                if (ship.ap.mode === shipLib.AP_OFF) {
                        setAutoMsg('no autopilot running');
                        return;
                }
                shipLib.apAbort(ship);
                shipTimeRateCapY = Infinity;
                setAutoMsg('autopilot off \u00b7 velocity kept');
        }

        // --- G4: docking, the port service and the cargo hook (§10) ----
        // O is the dock toggle. The station is the current flight
        // target when it is a natural, resident star: the locked
        // destination, else the primary selection — the same target
        // the autopilot answers against. The frame-fixed references
        // are coordinates, not ports.
        function gameDock() {
                if (ship.docked) { gameUndock(); return; }
                if (gameTargetKind !== 'target') {
                        setAutoMsg('no port at a fixed point');
                        return;
                }
                if (!gameTargetValid || gameTargetStale) {
                        setAutoMsg('no station in range');
                        return;
                }
                gameTargetOffset();
                const distM = Math.sqrt(gameRel[0] * gameRel[0]
                        + gameRel[1] * gameRel[1] + gameRel[2] * gameRel[2]) * shipLib.KPC_M;
                const rvx = ship.vel[0] - gameTargetVel[0];
                const rvy = ship.vel[1] - gameTargetVel[1];
                const rvz = ship.vel[2] - gameTargetVel[2];
                const relMs = Math.sqrt(rvx * rvx + rvy * rvy + rvz * rvz) * shipLib.KPC_M;
                const reason = shipLib.dockReason(distM, flightStandOffM(), relMs, true);
                if (reason !== shipLib.DOCK_OK) {
                        let msg = shipLib.DOCK_REASON_NAMES[reason];
                        if (reason === shipLib.DOCK_OUTSIDE) {
                                msg += ' · ' + formatLy(distM / shipLib.KPC_M * LY_PER_KPC);
                        }
                        if (reason === shipLib.DOCK_UNSETTLED) {
                                msg += ' · relative ' + shipLib.formatDv(relMs);
                        }
                        setAutoMsg(msg);
                        return;
                }
                // Commit: the station's identity, the ride offset,
                // the service. The destination snapshot is copied
                // (the ride feeds it by key); a primary selection is
                // remembered by key and re-resolved through the star
                // set, so a changed selection cannot move the port.
                const locked = flightDestination.active;
                const i = locked ? -1 : starSet.primary;
                const key = locked ? flightDestination.key >>> 0 : starSet.keys[i] >>> 0;
                const name = gameTargetName();
                shipLib.dock(ship, key, name,
                        ship.pos[0] - gameTarget[0],
                        ship.pos[1] - gameTarget[1],
                        ship.pos[2] - gameTarget[2]);
                stationIsDest = locked;
                if (locked) {
                        stationDest.kind = flightDestination.kind;
                        stationDest.index = flightDestination.index;
                        stationDest.key = flightDestination.key >>> 0;
                        stationDest.x = flightDestination.x;
                        stationDest.y = flightDestination.y;
                        stationDest.z = flightDestination.z;
                        stationDest.lum = flightDestination.lum;
                        stationDest.name = flightDestination.name;
                } else {
                        stationKey = key;
                }
                // The port of registry is the ship record's
                // own (§10.4, per hull like the tank); the
                // asset history gets the dock-port: a typed
                // ui.1 asset in birth space, like every
                // other record.
                const ref = locked ? flightDestination : memberRefFor(i);
                selectionStore.selectCurrent(window.SelectionStore.GROUP_ASSET,
                        {
                                group: window.SelectionStore.GROUP_ASSET,
                                type: 'dock-port',
                                id: 'port-' + key.toString(36),
                                name: name + ' port',
                                key: key,
                                kind: ref.kind,
                                index: ref.index,
                                x: ref.x, y: ref.y, z: ref.z,
                        });
                syncSelectionPanel();
                setAutoMsg('docked at ' + name + ' port · tank and life support restored');
                syncFlightUi();
        }

        function gameUndock() {
                if (!ship.docked) return;
                shipLib.undock(ship);
                stationIsDest = false;
                stationKey = -1;
                setAutoMsg('undocked · coasting with the station');
                syncFlightUi();
        }

        // --- The trade network (trade series) -----------------------------
        // One network per galaxy: the landmark systems of the Milky Way, or a
        // local sample of a generated field. Discovery is deterministic, so
        // the same seed always settles the same stars (trade-plan.md §3.1).
        // Everything below is birth-frame data; the drawn galaxy rotates under
        // it, which is why the overlay's routes are faint by design.
        const tradeRef = { kind: 0, index: 0, key: 0, x: 0, y: 0, z: 0, colorIndex: 0, absMag: 0 };
        const TRADE_FIELD_RADIUS_KPC = 1.2;
        const tradeRecord = window.PlanetsLib.createSystemRecord();
        const tradeCtx = { model: null, field: null, member: null, name: '' };
        const tradeTop = new Int32Array(6);
        const tradePos = [0, 0, 0];
        // One frame never spends more than this many network events: at the
        // synced top rate a frame owes ~50, so the budget only bites when the
        // clock cannot be followed (a slow machine, a hidden tab, the wide
        // star range) — and then the readout's lag line says so.
        const TRADE_EVENT_BUDGET = 256;
        // The star-clock rung the generation-ship cruise is calibrated at.
        const TRADE_GEN_MYR = 2;
        // The route re-time and the frontier scan are maintenance, not clock
        // work: twice a second is invisible to the user and keeps the frame
        // free of 96 route projections.
        const TRADE_MAINT_SECONDS = 0.5;
        let tradeMaintWall = 0;

        function tradeRateIndexFor(years) {
                let best = 0, bestDist = Infinity;
                for (let i = 0; i < tradeLib.TRADE_RATES.length; i++) {
                        const d = Math.abs(tradeLib.TRADE_RATES[i] - years);
                        if (d < bestDist) { bestDist = d; best = i; }
                }
                return best;
        }

        function tradeRateYears() {
                return tradeLib.TRADE_RATES[tradeRateIndex];
        }

        // The trade clock the network actually steps with (trade-plan §6): the
        // panel's ladder, or the star clock through the sync rate. `clockRate`
        // owns both the exchange rate and the ceiling, so the panel and the
        // frame loop can never disagree about the number on screen.
        function tradeClockRate() {
                return tradeLib.clockRate(tradeRateYears(), starTimeRate, tradeSyncOn !== 0 && !gameMode);
        }

        // Years of star time the synced trade clock is behind: the drain's
        // budget, not the clock's law, decides whether the network keeps up.
        function tradeSyncNote() {
                if (!(tradeSyncOn && !gameMode) || !tradeNet || !(tradeNet.lag > 1)) return '';
                // The backlog is trade years; the sky's own calendar is what the
                // reader compares it to (1 trade year = 1 000 star years).
                const starMyr = tradeNet.lag * tradeLib.SYNC_YEARS_PER_MYR / 1e6;
                return ` \u00b7 ${Number(starMyr.toPrecision(2))} Myr behind`;
        }

        // Resolve a trade port's star to its live drawn position at the current
        // star time, through the label layer's same record dispatch the
        // overlay draws with. A star that is not resident resolves to nothing
        // and the port keeps its birth coordinates.
        function tradeLivePosition(ref, out) {
                return labels.tradeRecordPosition(ref.kind | 0, ref.index | 0, ref.key >>> 0, out);
        }

        function tradeSeedNetwork() {
                const home = model.home.orbitTarget;
                tradeNet = tradeLib.createNetwork({
                        seed: model.seed | 0,
                        modelSeed: model.seed | 0,
                        timeYears: 0,
                        homeX: home.x !== undefined ? home.x : home[0],
                        homeY: home.y !== undefined ? home.y : home[1],
                        homeZ: home.z !== undefined ? home.z : home[2],
                        livePosition: tradeLivePosition,
                });
                tradeCtx.model = model;
                tradeCtx.field = null;
                tradeCtx.member = null;
                tradeCtx.name = '';
                // The named stars first: they are the sky the player reads, so
                // they are the ports the overlay should name. Then the field
                // within 1.2 kpc of the model's home — dense enough that a
                // voyage is a century, not a millennium, and sparse enough that
                // the galaxy still looks like a galaxy. `SEED_PORTS` bounds the
                // settled fraction; everything else discovered becomes a
                // colonisation candidate.
                if (model.milkyWay) {
                        for (let i = 0; i < landmarks.count; i++) {
                                const entry = landmarks.ENTRIES[i];
                                tradeRef.kind = window.PlanetsLib.BLOCK_LANDMARK;
                                tradeRef.index = i;
                                tradeRef.key = window.PlanetsLib.landmarkKey(i) >>> 0;
                                tradeRef.x = entry.x; tradeRef.y = entry.y; tradeRef.z = entry.z;
                                tradeRef.colorIndex = entry.colorIndex; tradeRef.absMag = entry.absMag;
                                tradeCtx.name = entry.name;
                                window.PlanetsLib.generateSystem(tradeRef, tradeCtx, tradeRecord);
                                tradeLib.discoverSystem(tradeNet, tradeRef, entry.name, tradeRecord, 0);
                        }
                }
                // 400 systems × ~30 µs is a boot cost, not a frame cost; the
                // distance test is squared and in kpc, so no square root and no
                // allocation per star.
                const field = renderer.fieldBuffers();
                if (field && field.count > 0) {
                        tradeCtx.field = field;
                        const home = model.home.orbitTarget;
                        const hx = home.x !== undefined ? home.x : home[0];
                        const hy = home.y !== undefined ? home.y : home[1];
                        const hz = home.z !== undefined ? home.z : home[2];
                        for (let i = 0, used = 0; i < field.count && used < 400; i++) {
                                const px = field.x[i], py = field.y[i], pz = field.z[i];
                                const dx = px - hx, dy = py - hy, dz = pz - hz;
                                if (dx * dx + dy * dy + dz * dz > TRADE_FIELD_RADIUS_KPC * TRADE_FIELD_RADIUS_KPC) continue;
                                used += 1;
                                tradeRef.kind = window.PlanetsLib.BLOCK_FIELD;
                                tradeRef.index = i;
                                tradeRef.key = window.StarTypesLib.fieldStarSeed(model.seed, i) >>> 0;
                                tradeRef.x = px; tradeRef.y = py; tradeRef.z = pz;
                                tradeRef.colorIndex = 0; tradeRef.absMag = 0;
                                tradeCtx.name = '';
                                window.PlanetsLib.generateSystem(tradeRef, tradeCtx, tradeRecord);
                                tradeLib.discoverSystem(tradeNet, tradeRef, '', tradeRecord, 0);
                                if (tradeNet.portCount >= tradeNet.seedPorts
                                        && tradeNet.candidateCount >= tradeLib.MAX_CANDIDATES - 32) break;
                        }
                }
                tradeLib.finalize(tradeNet);
                tradeModelKey = (model.type || '') + ':' + (model.seed | 0);
                syncTradeUi();
        }

        // Inspect: the open system's sites join the network on first sight.
        // `discoverSystem` is idempotent, so opening the same system twice only
        // settles it — and the 4 Hz readout settles it again without changing
        // the map.
        function tradeInspectSystem(ref, name) {
                if (!tradeNet || !ref) return;
                tradeCtx.model = model;
                tradeCtx.field = renderer.fieldBuffers();
                tradeCtx.member = renderer.starBlocks().member;
                tradeCtx.name = name || '';
                window.PlanetsLib.generateSystem(ref, tradeCtx, tradeRecord);
                tradeLib.discoverSystem(tradeNet, ref, name || '', tradeRecord, tradeNet.time);
        }

        // The network's capital: the colony nearest the viewer's home, forced
        // by the seed map so the arrival has a colony in sight (trade-plan
        // §3). H goes here; the Trade panel names it.
        function homeColonyPort() {
                if (!tradeNet || tradeNet.portCount === 0) return -1;
                const capital = tradeNet.capital;
                return capital >= 0 && capital < tradeNet.portCount ? capital : 0;
        }

        // H's target as a pick: the same record shape a click produces, so the
        // one selection path runs and the star joins the set, the orbit target
        // and the flight destination exactly as if it had been clicked.
        const colonyPickState = {
                key: 0, kind: 0, index: 0, x: 0, y: 0, z: 0,
                colorIndex: 0, absMag: 0, approximated: 0,
        };
        function colonyPick(port) {
                colonyPickState.key = port.key >>> 0;
                colonyPickState.kind = port.ref.kind | 0;
                colonyPickState.index = port.ref.index | 0;
                colonyPickState.x = port.x; colonyPickState.y = port.y; colonyPickState.z = port.z;
                colonyPickState.colorIndex = port.ref.colorIndex | 0;
                colonyPickState.absMag = port.ref.absMag;
                return colonyPickState;
        }

        // H: home is the home colony, not the empty home star. The observer
        // selects it and flies there, riding it while the sky moves; the ship
        // does not teleport (game-mode-plan §3), so game mode makes the colony
        // the Flight destination and approaches under the autopilot.
        function goToHomeColony() {
                const portIndex = homeColonyPort();
                if (portIndex < 0) return false;
                handleStarPick(colonyPick(tradeNet.ports[portIndex]), false);
                setSpeedRef('target');
                if (gameMode) {
                        if (!setFlightDestinationFromPrimary()) return false;
                        gameCommand = GAME_CMD_APPROACH;
                        return true;
                }
                return flyToPrimary();
        }

        // The port the player's ship is docked at, or -1. The station key is
        // the star key the colony was discovered under.
        function gameTradePort() {
                if (!tradeNet || !ship.docked || !ship.station) return -1;
                return tradeLib.playerPort(tradeNet, ship.station.key);
        }

        function tradeResourceShort(r) {
                return economyLib.RESOURCES[r].id.slice(0, 4);
        }

        function tradeYieldRow(colony, from, to) {
                let row = '';
                for (let r = from; r < to; r++) {
                        row += (r > from ? '  ' : '') + tradeResourceShort(r).padEnd(4) + ' ' + tradeBar(colony.yield[r]);
                }
                return row;
        }

        function tradeBar(value) {
                const dots = economyLib.yieldDots(value);
                let text = '';
                for (let i = 0; i < 5; i++) text += i < dots ? '\u25ae' : '\u25af';
                return text;
        }

        // The readout's trade block: population, coverage, the 13-yield map and
        // the port's exports and needs. This is the brief's inspection path —
        // the colony is settled to the network's clock here, never per frame.
        function tradeReadoutText() {
                if (!tradeNet) return '';
                const p = starSet.primary;
                if (p < 0) return '';
                const portIndex = tradeLib.bestPortOfStar(tradeNet, starSet.keys[p] >>> 0);
                if (portIndex < 0) return '\ntrade     no colony here \u00b7 V discovers its sites';
                const port = tradeNet.ports[portIndex];
                const colony = port.colony;
                economyLib.settleColony(colony, tradeNet.time);
                const age = tradeNet.time - colony.founded;
                let text = `\ntrade     ${port.name} \u00b7 pop ${economyLib.formatPop(colony.pop)} / ${economyLib.formatPop(colony.capacity)}`
                        + ` \u00b7 coverage ${colony.coverage.toFixed(2)} \u00b7 growth ${(colony.growth * 100).toFixed(2)}%/y`
                        + ` \u00b7 ${age < 1 ? 'founded now' : Math.round(age) + ' y old'}`;
                text += '\nyields    ' + tradeYieldRow(colony, 0, 5);
                text += '\n          ' + tradeYieldRow(colony, 5, 10);
                text += '\n          ' + tradeYieldRow(colony, 10, economyLib.RESOURCE_COUNT);
                let sells = '', needs = '';
                for (let r = 0; r < economyLib.RESOURCE_COUNT; r++) {
                        if (economyLib.exportableOf(colony, r) > 0 && sells.length < 24) {
                                sells += (sells ? ', ' : '') + economyLib.RESOURCES[r].name;
                        }
                        if (economyLib.demandOf(colony, r) > 0 && needs.length < 24) {
                                needs += (needs ? ', ' : '') + economyLib.RESOURCES[r].name;
                        }
                }
                text += `\nsells     ${sells || 'nothing spare'} \u00b7 needs ${needs || 'nothing \u2014 self-sufficient'}`;
                return text;
        }

        // The Trade panel: the clock, the biggest colonies with their growth,
        // the hulls in flight and the colonisation frontier (trade.2). Rebuilt
        // at 4 Hz. Colony growth is a *visual* fact here — a bar per colony,
        // an arrow for its sign — because six rows of near-identical numbers
        // are not a picture of a growing economy.
        const COLONY_BAR = '\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588';
        const GROWING = 0.0005;
        function colonyBar(pop, capacity) {
                const f = capacity > 0 ? pop / capacity : 0;
                let i = Math.round((f < 0 ? 0 : f > 1 ? 1 : f) * (COLONY_BAR.length - 1));
                return COLONY_BAR[i] + COLONY_BAR[i] + COLONY_BAR[i];
        }
        function growthMark(g) {
                return g > GROWING ? '\u2191' : g < -GROWING ? '\u2193' : '\u2192';
        }
        function formatTradeRate(y) {
                return Number(y.toPrecision(4)).toLocaleString('en-US');
        }
        let tradeLaunchMsg = '', tradeLaunchTicks = 0;

        function syncTradeUi() {
                tradeRateSlider.value = String(tradeRateIndex);
                const synced = tradeSyncOn !== 0 && !gameMode;
                const rateY = tradeClockRate();
                tradeRateSlider.disabled = synced;
                tradeRateValue.textContent = synced
                        ? (rateY === 0 ? 'paused \u00b7 star clock stopped'
                                : formatTradeRate(rateY) + ' y/s \u00b7 1 y per 1 kyr of star time')
                        : (rateY === 0 ? 'paused' : formatTradeRate(rateY) + ' y/s');
                tradeRateValue.title = synced
                        ? 'Synced: one trade year per 1 000 star years, capped at '
                                + tradeLib.RATE_MAX.toLocaleString('en-US') + ' y/s. 0.1 Myr/s of sky is 100 y/s of trade; 2 Myr/s is 2 000 y/s.'
                        : 'The network\u2019s own clock, in years per wall second.';
                tradeRoutesBox.checked = tradeRoutesOn !== 0;
                tradeSyncBox.checked = tradeSyncOn !== 0;
                tradeGenBox.checked = tradeGenOn !== 0;
                if (!tradeNet) {
                        tradeState.textContent = 'no network';
                        tradeList.textContent = 'No trade network yet.';
                        if (colonisationState) colonisationState.textContent = 'no network';
                        if (colonisationList) colonisationList.textContent = 'No expeditions yet.';
                        if (tradeLaunch) tradeLaunch.disabled = true;
                        return;
                }
                tradeLib.settleAllPorts(tradeNet, tradeNet.time);
                const capital = homeColonyPort();
                tradeState.textContent = `${tradeNet.portCount} ports \u00b7 ${tradeNet.shipCount} ships`
                        + ` \u00b7 ${tradeNet.founded} founded \u00b7 ${Math.round(tradeNet.delivered).toLocaleString()} units hauled`
                        + ` \u00b7 ${Math.round(tradeNet.time).toLocaleString()} y`
                        + tradeSyncNote()
                        + (rateY >= 500 ? ' \u00b7 time-lapse: growth is a blink at this rate' : '');
                let n = 0;
                // The youngest colony is the one growth line the six largest
                // can never show: a new world starts small and would need
                // centuries to reach the list.
                let youngest = -1;
                for (let i = 0; i < tradeNet.portCount; i++) {
                        const colony = tradeNet.ports[i].colony;
                        if (colony.abandoned) continue;
                        if (youngest < 0 || colony.founded > tradeNet.ports[youngest].colony.founded) youngest = i;
                        if (n < tradeTop.length) {
                                tradeTop[n++] = i;
                        } else {
                                // Replace the smallest of the six: the panel is a
                                // fixed six-row selection, no per-frame sort.
                                let smallest = 0;
                                for (let k = 1; k < tradeTop.length; k++) {
                                        if (tradeNet.ports[tradeTop[k]].colony.pop < tradeNet.ports[tradeTop[smallest]].colony.pop) smallest = k;
                                }
                                if (colony.pop > tradeNet.ports[tradeTop[smallest]].colony.pop) tradeTop[smallest] = i;
                        }
                }
                // Six indices sort in place with one insertion pass.
                for (let a = 1; a < n; a++) {
                        const held = tradeTop[a];
                        let b = a - 1;
                        while (b >= 0 && tradeNet.ports[tradeTop[b]].colony.pop < tradeNet.ports[held].colony.pop) {
                                tradeTop[b + 1] = tradeTop[b];
                                b -= 1;
                        }
                        tradeTop[b + 1] = held;
                }
                let lines = '';
                for (let k = 0; k < n; k++) {
                        const port = tradeNet.ports[tradeTop[k]];
                        const colony = port.colony;
                        lines += port.name.slice(0, 15).padEnd(15)
                                + colonyBar(colony.pop, colony.capacity).padEnd(4)
                                + economyLib.formatPop(colony.pop).padStart(8)
                                + '  ' + growthMark(colony.growth) + (colony.growth * 100).toFixed(1) + '%/y'
                                + (tradeTop[k] === capital ? '  capital' : '') + '\n';
                }
                if (youngest >= 0) {
                        const colony = tradeNet.ports[youngest].colony;
                        const age = Math.max(0, tradeNet.time - colony.founded);
                        lines += 'newest'.padEnd(8) + tradeNet.ports[youngest].name.slice(0, 13).padEnd(13)
                                + economyLib.formatPop(colony.pop).padStart(8)
                                + '  ' + Math.round(age).toLocaleString('en-US') + ' y old\n';
                }
                let inFlight = 0;
                for (let i = 0; i < tradeNet.shipCount && inFlight < 3; i++) {
                        const s = tradeNet.ships[i];
                        if (s.state !== tradeLib.SHIP_SAILING || s.to < 0 || s.from < 0) continue;
                        const cargo = s.cargo >= 0 && s.cargo < economyLib.RESOURCE_COUNT
                                ? economyLib.RESOURCES[s.cargo].name : 'empty';
                        lines += tradeLib.HULLS[s.hull].name.slice(0, 15).padEnd(15)
                                + tradeNet.ports[s.from].name.slice(0, 9) + ' \u2192 ' + tradeNet.ports[s.to].name.slice(0, 9)
                                + '  ' + cargo + '\n';
                        inFlight += 1;
                }
                tradeList.textContent = lines || 'No colonies yet.';
                // The colonisation frontier: what could launch, what is in
                // flight, and — when nothing can — which gate is shut.
                if (colonisationState && colonisationList) {
                        const opportunities = tradeLib.colonisationPreview(tradeNet, tradeNet.time);
                        const status = tradeLib.colonisationStatus();
                        const nextIn = Math.max(0, tradeLib.EXPEDITION_INTERVAL - (tradeNet.time - tradeNet.lastExpedition));
                        colonisationState.textContent = `${status.big} big colonies \u00b7 ${status.candidates} candidates (${status.free} free)`
                                + ` \u00b7 ${status.founding} expeditions \u00b7 next in ${Math.round(nextIn)} y`;
                        let preview = '';
                        if (tradeLaunchTicks > 0) {
                                tradeLaunchTicks -= 1;
                                preview += tradeLaunchMsg + '\n';
                        }
                        for (let i = 0; i < tradeNet.shipCount; i++) {
                                const s = tradeNet.ships[i];
                                if (s.state !== tradeLib.SHIP_FOUNDING) continue;
                                const from = s.from >= 0 ? tradeNet.ports[s.from].name.slice(0, 10) : '?';
                                const target = s.candidate >= 0 ? tradeNet.candidates[s.candidate].site.name.slice(0, 14) : '?';
                                const eta = Math.max(0, s.arrive - tradeNet.time);
                                preview += `${from} \u2192 ${target}  ${Math.round(eta)} y \u00b7 ${Math.round(s.amount)} colonists\n`;
                        }
                        for (let k = 0; k < Math.min(3, opportunities.length); k++) {
                                const o = opportunities[k];
                                const src = tradeNet.ports[o.port].name.slice(0, 10);
                                const marks = (o.flags & window.PlanetsLib.FLAG_TERRAN) ? ' \u2295'
                                        : (o.flags & window.PlanetsLib.FLAG_IN_HZ ? ' \u25ce' : '');
                                preview += `${src} \u2192 ${o.name.slice(0, 14)}${marks}  ${Math.round(o.ly)} ly  hab ${o.habitat.toFixed(2)}\n`;
                        }
                        if (!preview) preview = status.reason || 'no expedition ready';
                        colonisationList.textContent = preview;
                        if (tradeLaunch) tradeLaunch.disabled = opportunities.length === 0;
                }
        }

        // The overlay's one line.
        function tradeOverlayLine() {
                if (!tradeNet) return '';
                const rate = tradeClockRate();
                const tag = tradeSyncOn && !gameMode ? ' synced' : '';
                return `\ntrade     ${rate === 0 ? 'paused' : Number(rate.toPrecision(4)).toLocaleString('en-US') + ' y/s'}${tag}`
                        + ` \u00b7 ${tradeNet.portCount} ports \u00b7 ${tradeNet.shipCount} ships`
                        + ` \u00b7 queue ${tradeNet.queue.size}` + tradeSyncNote();
        }

	function gameCargoTransfer(unload) {
		if (!ship.docked) {
			setAutoMsg('cargo moves only at a dock');
			return;
		}
		const portIndex = gameTradePort();
		if (portIndex < 0) {
			setAutoMsg('no trade port here · no colony');
			return;
		}
		const result = unload ? tradeLib.playerUnload(tradeNet, ship, portIndex)
			: tradeLib.playerLoad(tradeNet, ship, portIndex);
		if (!result.ok) setAutoMsg(result.reason);
		else setAutoMsg((unload ? 'unloaded ' : 'loaded ') + economyLib.formatUnits(result.units) + ' '
			+ economyLib.RESOURCES[result.resource].name + ' · ' + shipLib.formatCargo(result.tons));
		syncFlightUi();
	}

	function gameCargoLoad() {
		gameCargoTransfer(false);
	}

	function gameCargoUnload() {
		gameCargoTransfer(true);
	}

        // Runs before the shared-clock rate when a command is pending or a
        // flight just ended; it clears any old cap, then consumes the request.
        function gameApplyCommand() {
                let clockStateChanged = false;
                if (autoRunning && ship.ap.mode === shipLib.AP_OFF) {
                        setAutoMsg(autoReasonText(ship.ap.reason));
                        shipTimeRateCapY = Infinity;
                        clockStateChanged = true;
                }
                const cmd = gameCommand;
                gameCommand = 0;
                if (cmd === GAME_CMD_APPROACH) gameApproach();
                else if (cmd === GAME_CMD_FOLLOW) gameFollow();
                else if (cmd === GAME_CMD_ABORT) gameAbort();
                else if (cmd === GAME_CMD_PLAN) gameEngageFlightPlan();
                else if (cmd === GAME_CMD_TARGET) gameStopAtTarget();
                autoRunning = ship.ap.mode !== shipLib.AP_OFF;
                if (cmd !== 0) {
                        refreshShipTimeRateCap();
                        clockStateChanged = true;
                }
                if (clockStateChanged) syncStarTime();
        }

        // The nose (game-mode-plan §5): the autopilot's aim is fed into the
        // camera's own look accumulator, so the ease is the camera's one look
        // law and a glance still wins frame by frame. Applied next frame.
        function gameAimEase(dtWallS) {
                const ap = ship.ap;
                if (ap.mode === shipLib.AP_OFF || !ap.hasAim) return;
                const k = 1 - Math.exp(-dtWallS / shipLib.AP_AIM_TAU);
                const a = ap.aim;
                const r = camera.right, u = camera.up, f = camera.forward;
                const xa = a[0] * r[0] + a[1] * r[1] + a[2] * r[2];
                const ya = a[0] * u[0] + a[1] * u[1] + a[2] * u[2];
                const za = a[0] * f[0] + a[1] * f[1] + a[2] * f[2];
                const sens = window.Camera.LOOK_SENSITIVITY;
                // Positive lookDx yaws toward the right, positive lookDy pitches down.
                input.state.lookDx += k * Math.atan2(xa, za) / sens;
                input.state.lookDy -= k * Math.atan2(ya, za) / sens;
        }

        // The chrome's live numbers, read every game frame by the label layer.
        function feedShipChrome() {
                const cap = shipLib.cruiseCapKpcS(ship);
                shipChrome.color = ship.class.color;
                shipChrome.throttle = ship.throttleFrac;
                shipChrome.fuel = shipLib.dvRemaining(ship) / ship.dvMax;
                shipChrome.speed = Math.hypot(ship.vel[0], ship.vel[1], ship.vel[2]) / cap;
                shipChrome.closing = Math.max(0, gameTargetClosingKpcS) / cap;
                shipChrome.hasAim = ship.ap.hasAim && ship.ap.mode !== shipLib.AP_OFF;
                shipChrome.aim = ship.ap.aim;
                shipChrome.hasTarget = gameTargetValid && !gameTargetStale;
                shipChrome.target = gameTarget;
                // G4: the return-home marker — hard while
                // life support is expired (§10.3), drawn
                // from the home feed's drawn position.
                shipChrome.hasHome = shipLib.lifeState(ship) === shipLib.LIFE_EXPIRED
                        && homeValid && !homeStale;
                shipChrome.home[0] = homePos[0];
                shipChrome.home[1] = homePos[1];
                shipChrome.home[2] = homePos[2];
        }

        // The chrome's strings, at the overlay's 4 Hz like the HUD's.
        function updateShipChromeText() {
                shipChrome.stripText = `accepted ${Math.round(ship.throttleFrac * 100)}% \u00b7 \u0394v ${Math.round(100 * shipLib.dvRemaining(ship) / ship.dvMax)}%`;
                shipChrome.tagText = !gameTargetValid ? '' : `${gameTargetName()}  ${formatLy(gameTargetDistKpc * LY_PER_KPC)}`;
                shipChrome.homeTagText = `${homeNameOf()}  ${formatLy(homeDistKpc * LY_PER_KPC)}`;
        }

        // The auto line (§6): the approach's phase, flown fraction, ETA in ship
        // and wall time and the Δv it spends; the follow's relative speed and its
        // correction. A refusal or an ended flight shows its message for a while.
        function gameAutoLine() {
                const ap = ship.ap;
                const dvLib = window.DeltaVLib;
                let text = '';
                if (ap.mode === shipLib.AP_APPROACH || ap.mode === shipLib.AP_TARGET) {
                        const flown = ap.etaTotalS > 0 ? Math.max(0, Math.min(1, 1 - ap.etaS / ap.etaTotalS)) : 1;
                        const rateY = gameTimeRateY();
                        const wallS = rateY > 0 ? ap.etaS / (rateY * shipLib.SECONDS_PER_YEAR) : Infinity;
                        const task = ap.mode === shipLib.AP_TARGET ? 'target stop' : shipLib.AP_PHASE_NAMES[ap.phase];
                        text = `\nauto      ${task} \u00b7 ${Math.round(100 * flown)}% \u00b7 eta ${dvLib.formatDuration(ap.etaS)} ship`
                                + ` \u00b7 ${formatWall(wallS)} wall \u00b7 \u0394v ${shipLib.formatDv(ap.dvSpent)}/${shipLib.formatDv(ap.dvRequired)} \u00b7 f aborts`;
                } else if (ap.mode === shipLib.AP_FOLLOW) {
                        text = `\nauto      follow \u00b7 relative ${shipLib.formatDv(ap.relativeMs)} \u00b7 correction \u0394v ${shipLib.formatDv(ap.dvSpent)} \u00b7 j or f aborts`;
                }
                if (autoMsgTicks > 0) text += `\nauto      ${autoMsg}`;
                return text;
        }

        function gameModeLine() {
                if (!gameMode) return '';
                const dvLib = window.DeltaVLib;
                const cls = ship.class;
                const c = shipLib.speedC(ship);
                const remain = shipLib.dvRemaining(ship);
                const lifeState = shipLib.lifeState(ship);
                const life = cls.lifeYears === Infinity ? '\u221e'
                        : dvLib.formatDuration(Math.max(0, cls.lifeYears * dvLib.SECONDS_PER_YEAR - ship.lifeSpent))
                        + (lifeState === shipLib.LIFE_CRITICAL ? ' \u00b7 critical' : '');
                const accelPart = ship.accelNow > 0 ? ` (+${ship.accelNow.toFixed(1)} m/s\u00b2)` : '';
                const requestedRate = shipLib.timeRateYPerS(ship, c);
                const actualRate = gameTimeRateY();
                const coastWarp = shipLib.arcadeWarpYPerS(ship, AUTOPILOT_MIN_WALL_SECONDS);
                const rateNote = coastWarp > 0
                        ? ` · coast warp ${formatShipRate(actualRate)}`
                        : Math.abs(actualRate - requestedRate) > 1e-15 ? ` · actual ${formatShipRate(actualRate)}` : '';
                let text = `\nmode      game \u00b7 ship clock ${shipLib.formatClock(ship, c)}${rateNote} (wheel steps \u00b7 T freezes) \u00b7 g returns to observer`;
                const governor = flightControl === 'speed'
                        ? ` \u00b7 speed limit ${shipLib.formatSpeedC(shipLib.cruiseCapKpcS(ship) * flightSpeedFraction * shipLib.KPC_M / shipLib.C)}`
                        : '';
                text += `\nship      ${cls.label} \u00b7 accepted thrust ${throttleBar(ship.throttleFrac)} ${Math.round(ship.throttleFrac * 100)}%`
                        + ` \u00b7 burn ${dvLib.formatDuration(shipLib.burnReserveSeconds(ship))} reserve${governor}`
                        + (ship.docked ? ` \u00b7 docked at ${ship.station.name}` : '');
                text += `\nspeed     ${shipLib.formatSpeed(ship)}${accelPart}`
                        + ` \u00b7 fuel ${shipLib.formatDv(remain)}/${shipLib.formatDv(ship.dvMax)} \u0394v (${Math.round(100 * remain / ship.dvMax)}%)`
                        + ` \u00b7 life ${life}`;
                shipLib.velocityComponents(ship, camera.forward, camera.right, camera.up,
                        gameTargetValid && !gameTargetStale ? gameTargetVel : null, gameVelocityAxes);
                text += `\nvelocity  relative to ${gameTargetValid ? gameTargetName() : 'the galactic frame'}`
                        + ` · forward ${shipLib.formatAxisSpeed(gameVelocityAxes[0])}`
                        + ` · sideways ${shipLib.formatAxisSpeed(gameVelocityAxes[1])} · vertical ${shipLib.formatAxisSpeed(gameVelocityAxes[2])}`;
                if (ship.docked || ship.cargo > 0) {
                        const tag = ship.cargoResource >= 0 && ship.cargoResource < economyLib.RESOURCE_COUNT
                                ? ' \u00b7 ' + economyLib.RESOURCES[ship.cargoResource].name : '';
                        text += `\ncargo     ${shipLib.formatCargo(ship.cargo)}/${shipLib.formatCargo(ship.class.cargo)}${tag}`;
                }
                if (lifeState >= shipLib.LIFE_CRITICAL) {
                        // The return-home heading shows inside the
                        // warn band too; the chrome marker is the
                        // expired state's alone (§10.3).
                        const homeLine = homeValid
                                ? `${homeNameOf()}   ${formatLy(homeDistKpc * LY_PER_KPC)}`
                                        + (homeClosingKpcS > 0
                                                ? ` \u00b7 closing ${shipLib.formatSpeedC(homeClosingKpcS * shipLib.KPC_M / shipLib.C)}`
                                                : homeClosingKpcS < 0
                                                        ? ` \u00b7 receding ${shipLib.formatSpeedC(-homeClosingKpcS * shipLib.KPC_M / shipLib.C)}`
                                                        : ' \u00b7 closing 0')
                                : `${homeNameOf()} \u00b7 not resident`;
                        text += `\nhome      ${homeLine}`;
                }
                if (lifeState === shipLib.LIFE_EXPIRED) {
                        text += `\nlife      support expired \u00b7 return to ${homeNameOf()}`;
                }
                text += gameTargetLine();
                if (remain <= 0) text += '\nship      tank empty \u00b7 thrusters silent \u00b7 coasting';
                if (ship.stopResidual > 0) text += `\nship      stop incomplete \u00b7 residual ${shipLib.formatSpeed(ship)}`;
                text += gameAutoLine();
                return text + gameNoticeLine();
        }

        function cameraLine(c) {
                // The HUD's mode/speed lines own the display while the ship is
                // the rig — the observer's ladder is off duty (game-mode-plan §6).
                if (gameMode) return '';
                if (c.flying) {
                        return `camera flying to ${c.targetName}   ${Math.round(c.flightProgress * 100)}%`;
                }
                if (c.chase) {
                        return `camera chase ${c.targetName}   distance ${formatDistance(c.orbitDistance)}   motion ${formatSpeed(c.chaseSpeedLyPerSec)}`;
                }
                if (c.mode === window.Camera.MODE_FLY) {
                        return `camera ${c.modeName}   speed ${formatSpeed(c.speedLyPerSec)}  (x${c.speedMult})${formatFactor(c.speedFactor)}`;
                }
                return `camera ${c.modeName}   ${c.targetName}   distance ${formatDistance(c.orbitDistance)}`;
        }

        function selectedLine(cameraState) {
                if (selected < 0 || cameraState.mode !== window.Camera.MODE_FLY) return '';
                return gameMode
                        ? `\nselected ${landmarks.ENTRIES[selected].name}   (game HUD target \u00b7 g returns to observer)`
                        : `\nselected ${landmarks.ENTRIES[selected].name}   (c orbits it \u00b7 j follows it \u00b7 Shift+F flies to it)`;
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
        // are shown, so a pick never has to re-derive anything to be described. The
        // distance is drawn-space (ui.2): after F the camera sits at the stand-off
        // from the star it is looking at, so the readout has to say ~2 ly, not the
        // kiloparsecs between the camera and that star's birth record.
        function selectionLines(cameraState) {
                const i = starSet.primary;
                if (i < 0) return '';
                const cam = cameraState.position;
                const drawn = memberDrawnPosition(i, drawnPos);
                const dx = drawnPos[0] - cam[0];
                const dy = drawnPos[1] - cam[1];
                const dz = drawnPos[2] - cam[2];
                const distLy = Math.sqrt(dx * dx + dy * dy + dz * dz) * LY_PER_KPC;
                const cls = window.StarRecord.SPECTRAL_CLASSES[starSet.colorIndex[i]] || '?';
                let text = `\nselected  ${memberName(i)}  (${cls}, ${starSet.mass[i].toFixed(2)} M\u2609, ` +
                        `${starSet.lum[i].toFixed(2)} L\u2609, ${formatLy(distLy)})`;
                if (starSet.approximated[i] || drawn === window.Selection.DRAWN_APPROX) {
                        text += '  \u00b7 position approximate under this engine mask';
                } else if (drawn === window.Selection.DRAWN_STALE) {
                        text += '  \u00b7 not resident: distance is to its birth record';
                }
                text += systemBriefLine(i);
                if (starSet.count > 1 || setLabel) {
                        text += `\nset       ${setLabel || `${starSet.count} stars`}` +
                                ' \u00b7 N next \u00b7 X clear \u00b7 c orbit \u00b7 j follow \u00b7 Shift+F fly to';
                } else {
                        text += '   \u00b7 Shift+click adds \u00b7 c orbit \u00b7 j follow \u00b7 Shift+F fly to';
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
                        `exposure ${shutter} ([ / ])   brightness ${linExp}x (; / ')   white ${wp}   sat ${sat}   engine ${state.engine}   constellations ${labels.constellationsVisible() ? 'on' : 'off'} (P)   star time ${gameMode ? 'ship ' + shipLib.formatClock(ship, shipLib.speedC(ship)) : window.OrbitLib.formatTimeRate(starTimeRate, 0)} (T)${evolveOn ? ' +evolve' : ''}   wave ${waveDamping === 0 ? 'off' : waveDamping.toFixed(2)}   pattern ${window.OrbitLib.effectivePatternSpeed(model).toFixed(3)} rad/Myr (x${patternScale.toFixed(2)})   Tab menu\n` +
                        `pos (${cameraState.position[0].toFixed(3)}, ${cameraState.position[1].toFixed(3)}, ${cameraState.position[2].toFixed(3)}) kpc\n` +
                        cameraLine(cameraState) +
                        gameModeLine() +
                        noSelectionLine() +
                        selectionLines(cameraState) +
                        selectedLine(cameraState) +
                        tradeOverlayLine();
                if (helpPanel.style.display !== 'none') syncHelpControls(cameraState);
        }

        const loop = window.Loop.createLoop((dt, time) => {
                const actions = input.state.actions;
                const resetting = actions.reset;
                if (actions.freezeTime) {
                        actions.freezeTime = 0;
                        // T freezes the shared clock in game mode — ship and sky
                        // together (game-mode-plan §4) — the observer's axis when
                        // out of it.
                        if (gameMode) ship.timeFrozen = !ship.timeFrozen;
                        else if (starTimeRate === 0) starTimeRate = lastNonZeroTimeRate;
                        else { lastNonZeroTimeRate = starTimeRate; starTimeRate = 0; }
                        syncStarTime();
                }
                // Promote game-mode keyboard requests before the shared-clock
                // calculation so a command and its time cap apply immediately.
                if (gameMode && !resetting) {
                        if (actions.flyMode) { actions.flyMode = 0; gameCommand = GAME_CMD_ABORT; }
                        if (actions.chaseFollow) { actions.chaseFollow = 0; gameCommand = GAME_CMD_FOLLOW; }
                        if (actions.flyTo) { actions.flyTo = 0; gameCommand = GAME_CMD_APPROACH; }
                        // G5's clock presets land before the shared clock is
                        // read, so the press is the frame it changes.
                        if (actions.clockSim) { actions.clockSim = 0; setShipClockPreset('sim'); }
                        if (actions.clockArcade) { actions.clockArcade = 0; setShipClockPreset('arcade'); }
                } else {
                        actions.clockSim = 0;
                        actions.clockArcade = 0;
                }
                if (gameMode && !resetting
                        && (gameCommand !== 0 || (autoRunning && ship.ap.mode === shipLib.AP_OFF))) {
                        gameTargetFeed(0);
                        gameApplyCommand();
                }
                const cameraStateForTime = camera.getState(statsText);
                // Game mode's shared clock (game-mode-plan §4): while the ship
                // flies, the stars' dt and the ship's dt come off one rate — the
                // ship-time ladder in y/s. Under one clock the ship's cruise
                // outruns stellar drift, so a selected star is met where it
                // arrives; the observer's star rate is parked and not consulted.
                const gameRateY = gameMode ? gameTimeRateY() : 0;
                const effectiveTimeRate = gameMode
                        ? gameRateY * 1e-6
                        : (starTimeRate < 0
                                ? (-starTimeRate) * window.OrbitLib.FLIGHT_TIME_GAIN * cameraStateForTime.speedLyPerSec
                                : starTimeRate);
                const dtStar = effectiveTimeRate * dt;
                const dtShipS = gameMode ? gameRateY * shipLib.SECONDS_PER_YEAR * dt : 0;
                // Physical seconds this frame (star-seconds under the shared
                // clock) — the handover feed's unit bridge from drawn motion.
                framePhysSeconds = dtStar > 0 ? dtStar * 1e6 * shipLib.SECONDS_PER_YEAR : 0;
                starTimeMyr += dtStar;
                if (starTimeMyr >= STAR_TIME_WRAP || starTimeMyr < 0) starTimeMyr = ((starTimeMyr % STAR_TIME_WRAP) + STAR_TIME_WRAP) % STAR_TIME_WRAP;
                // The trade clock (trade-plan §1) is wall-time, not star-time:
                // the colonies keep their own years. With sync time on it rides
                // the star clock instead (starTimeRate · 10⁶ trade years per
                // second), which is what makes generation-ship hops visible.
                // A hidden tab must not fast-forward the network by minutes, so
                // the frame's share is capped at a quarter second. While the
                // stars move, in-flight voyages are re-measured against the
                // endpoints' live drawn positions so their arrivals track the
                // moving route. Big colonies also scan the live field for
                // nearby good worlds every ~25 trade years (trade.2): the
                // frontier expands without player inspection.
                if (tradeNet) {
                        // The clock law is trade.js's (the sync rate and its
                        // ceiling), so a synced 2 Myr/s sky asks for 2 000 y/s —
                        // the pace the network is authored for — instead of the
                        // 2·10⁶ y/s identity that froze the page. The drain is
                        // budgeted: whatever the rate, one frame spends a
                        // bounded number of events and the clock stops at the
                        // next due one, so a slow machine falls behind (and says
                        // so) instead of dropping frames.
                        const rateY = tradeClockRate();
                        if (rateY > 0) {
                                const dtTrade = rateY * Math.min(dt, 0.25);
                                tradeLib.step(tradeNet, dtTrade, TRADE_EVENT_BUDGET);
                                tradeMaintWall += dt;
                                if (tradeMaintWall >= TRADE_MAINT_SECONDS) {
                                        tradeMaintWall = 0;
                                        // In-flight voyages re-measured against the
                                        // stars' live drawn positions: only worth
                                        // doing while the sky actually moves.
                                        if (dtStar > 0) tradeLib.retimeRoutes(tradeNet);
                                        // Big colonies scan the live field for nearby
                                        // good worlds: the frontier expands without the
                                        // player inspecting anything.
                                        const field = renderer.fieldBuffers();
                                        if (field && field.count > 0) {
                                                tradeLib.expandFrontierFromField(tradeNet, field, model);
                                        }
                                }
                        }
                }
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
                        // R is reset everything — the ship and any locked
                        // destination included.
                        shipLib.resetShip(ship);
                        activeFleetShip.entered = true;
                        autoRunning = false;
                        gameCommand = 0;
                        shipTimeRateCapY = Infinity;
                        clearFlightDestination();
                        syncStarTime();
                }

                // ui.4: the galaxy type is a menu-only control (the type select
                // calls regenerateGalaxy directly); G is the game-mode toggle now
                // and the orbit/fly modes are explicit keys, not a cycle.
                // Game mode gates the observer's mode keys (game-mode-plan §3):
                // the ship is the fly rig, and each gated key answers with a
                // notice line instead of a silent no-op. Space and the legacy
                // Controls refill are the ship's own commands.
                if (actions.allStop) {
                        actions.allStop = 0;
                        if (gameMode) {
                                // G4: Space at the port leaves
                                // it — the brake is a manual
                                // command, and the ride owns
                                // the velocity while docked.
                                if (ship.docked) gameUndock();
                                else {
                                        shipLib.applyStop(ship);
                                        shipTimeRateCapY = Infinity;
                                }
                        }
                }
                if (actions.shipRefuel) {
                        actions.shipRefuel = 0;
                        shipLib.refuel(ship);
                        syncFlightUi();
                }
                // G4's port commands (§10): the keys and the
                // Flight panel's Port buttons fire the same
                // one-shot flags. Outside game mode they answer
                // with the gated notice, like the other ship
                // commands.
                if (actions.dock) {
                        actions.dock = 0;
                        if (gameMode) gameDock();
                        else gameNotice();
                }
                if (actions.tradeRoutes) {
                        actions.tradeRoutes = 0;
                        tradeRoutesOn = tradeRoutesOn ? 0 : 1;
                        syncTradeUi();
                }
                if (actions.cargoLoad) {
                        actions.cargoLoad = 0;
                        if (gameMode) gameCargoLoad();
                        else gameNotice();
                }
                if (actions.cargoUnload) {
                        actions.cargoUnload = 0;
                        if (gameMode) gameCargoUnload();
                        else gameNotice();
                }
                if (actions.orbitCentre) {
                        // Shift+C: orbit the galactic centre — and
                        // select it as the speed reference, in both
                        // rigs. In game mode only the reference is
                        // taken: the orbit would re-pose the camera,
                        // which a ship never does.
                        actions.orbitCentre = 0;
                        setSpeedRef('centre');
                        if (!gameMode) camera.setMode(window.Camera.MODE_ORBIT_GC);
                }
                if (actions.orbitObject) {
                        // c: orbit the last selected star on the spot — no flight.
                        actions.orbitObject = 0;
                        if (gameMode) gameNotice();
                        else if (!orbitPrimary()) noSelectionTicks = NOTICE_TICKS;
                }
                if (actions.flyMode) {
                        // f: the free fly camera — orbit and follow are both off.
                        actions.flyMode = 0;
                        if (gameMode) gameCommand = GAME_CMD_ABORT;
                        else {
                                camera.setMode(window.Camera.MODE_FLY);
                                followKey = -1;
                        }
                }
                if (actions.gameMode) {
                        actions.gameMode = 0;
                        gameMode = !gameMode;
                        if (gameMode) enterGameMode(); else leaveGameMode();
                }
                if (actions.chaseFollow) {
                        // j (ui.6): ride behind the centred object with the
                        // view aligned to its movement vector. Entering needs
                        // something to orbit (a selection, or the mode already
                        // orbiting an object); leaving keeps the exact pose.
                        actions.chaseFollow = 0;
                        if (gameMode) gameCommand = GAME_CMD_FOLLOW;
                        else {
                                const camBefore = camera.getState(statsText);
                                if (camBefore.chase) {
                                        camera.setChase(false);
                                } else if (camBefore.mode === window.Camera.MODE_ORBIT_OBJECT || orbitPrimary()) {
                                        camera.setChase(true);
                                } else {
                                        noSelectionTicks = NOTICE_TICKS;
                                }
                        }
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
                // The network is always drawn while it exists (the checkbox
                // owns only the route lines): colonies that appear only when a
                // "routes" box is ticked are colonies nobody watches grow.
                labels.setTradeOverlay(tradeNet, tradeNet ? tradeNet.time : 0,
                        !!tradeNet && !systemLayer.isOpen(), tradeRoutesOn !== 0);
                selection.setOrbitState(model, starTimeMyr);
                // The Flight forecast includes its target-frame velocity match.
                // Keep the same keyed feed warm while observing, using the
                // observer clock's physical elapsed seconds; game mode resets
                // the rate source to its shared ship clock before it can fly.
                if (!gameMode && (speedRef !== 'target' || flightDestination.active || starSet.primary >= 0)) gameTargetFeed(framePhysSeconds);
                // Fly-to follow (ui.2): while the camera orbits — or is still flying
                // to — a set member, its target rides the star's drawn position, so
                // the star stays centred instead of drifting off its birth snapshot.
                // One dispatch per frame, for every block and every engine mask.
                // The camera steps *after* the target is fresh: a step against last
                // frame's target would draw the star one frame's motion off-centre,
                // metres-to-parsecs at fast star time.
                // H homes to the network's capital — the colony beside the
                // viewer's home — instead of the empty home star; a ship does
                // not teleport, so game mode makes it the destination and flies
                // there. Before the follow block, so the capital is ridden on
                // the very frame the key lands.
                if (actions.home) {
                        actions.home = 0;
                        if (!goToHomeColony()) {
                                setSpeedRef('home');
                                if (gameMode) gameNotice();
                                else camera.goHome();
                        }
                }
                if (followKey >= 0 && cameraStateForTime.mode === window.Camera.MODE_ORBIT_OBJECT) {
                        followTarget();
                }
                shipChrome.active = gameMode;
                if (gameMode) {
                        // The wheel steps the ship clock's ladder (game-mode-plan
                        // §4) — the observer speed ladder is off duty — and home
                        // is a teleport, which a ship does not do (§3). Whole
                        // notches out of an accumulator, like the camera's wheel.
                        gameWheelAccum += input.state.wheelDelta;
                        input.state.wheelDelta = 0;
                        const notches = Math.trunc(gameWheelAccum / window.Camera.WHEEL_NOTCH_PX);
                        if (notches !== 0) {
                                gameWheelAccum -= notches * window.Camera.WHEEL_NOTCH_PX;
                                ship.timeIndex = Math.max(shipLib.SHIP_TIME_INDEX_MIN,
                                        Math.min(shipLib.SHIP_TIME_INDEX_MAX, ship.timeIndex - notches));
                                ship.timeFrozen = false;
                                syncStarTime();
                        }
                }
                camera.step(dt, input.state);
                if (resetting) {
                        const resetState = camera.getState(rigState);
                        ship.pos[0] = resetState.position[0]; ship.pos[1] = resetState.position[1]; ship.pos[2] = resetState.position[2];
                        ship.vel[0] = resetState.velocity[0]; ship.vel[1] = resetState.velocity[1]; ship.vel[2] = resetState.velocity[2];
                        ship.heading[0] = resetState.orientation[0]; ship.heading[1] = resetState.orientation[1];
                        ship.heading[2] = resetState.orientation[2]; ship.heading[3] = resetState.orientation[3];
                        activeFleetShip.positioned = true;
                }
                if (gameMode) {
                        // The ship owns motion: integrate on the shared clock,
                        // then write position and velocity through the camera's
                        // own state pair (the look camera.step just applied is
                        // kept; the observer's fly integration is discarded).
                        gameTargetFeed(dtShipS);
                        gameHomeFeed(dtShipS);
                        gameShipStep(dtShipS, dt);
                        feedShipChrome();
                        gameAimEase(dt);
                        // G4: the life-support ladder's crossings
                        // announce themselves once, the notice
                        // pattern — the countdown itself is the
                        // HUD line's business.
                        const lifeNow = shipLib.lifeState(ship);
                        if (lifeNow !== lastLifeState) {
                                if (lifeNow === shipLib.LIFE_CRITICAL) {
                                        setAutoMsg('life support critical · '
                                                + window.DeltaVLib.formatDuration(
                                                        shipLib.lifeRemainingY(ship) * shipLib.SECONDS_PER_YEAR)
                                                + ' left');
                                } else if (lifeNow === shipLib.LIFE_EXPIRED) {
                                        setAutoMsg('life support expired · return home');
                                }
                                lastLifeState = lifeNow;
                        }
                }
                input.setFlyMode(camera.getState(statsText).mode === window.Camera.MODE_FLY);
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
						else {
							systemLayer.setSelected(bodyPick.kind, bodyPick.index);
							recordSystemBodySelection(bodyPick);
						}
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
                // Walk the pending sweeps a slice further; the frame a sweep finishes
                // on is the frame its answer lands. A pick miss stays a no-op, and an
                // aborted radius scan leaves the set exactly as it was.
                if (pendingShift >= 0 && selection.pickStep(SWEEP_SLICE_RECORDS, SWEEP_SLICE_MS)) {
                        const hit = selection.pickResult();
                        const additive = pendingShift === 1;
                        pendingShift = -1;
                        if (hit) handleStarPick(hit, additive);
                }
                if (aroundPending && selection.selectAroundStep(SWEEP_SLICE_RECORDS, SWEEP_SLICE_MS)) {
                        applyAroundResult();
                        updateOverlay(renderer.state, camera.getState(statsText));
                }
                if (actions.flyTo) {
                        actions.flyTo = 0;
                        if (gameMode) gameCommand = GAME_CMD_APPROACH;
                        else if (!flyToPrimary()) noSelectionTicks = NOTICE_TICKS;
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
                        // V is gated in game mode: the view re-poses the camera,
                        // which would teleport the ship (game-mode-plan §3).
                        if (gameMode) gameNotice();
                        else toggleSystemView();
                }
                if (actions.systemViewExit) {
                        actions.systemViewExit = 0;
                        closeSystemView();
                }
                if (actions.dvMap) {
                        actions.dvMap = 0;
                        if (gameMode) gameNotice();
                        else if (systemLayer.isOpen()) cycleDvView();
                }
                if (actions.speedRefTarget) { actions.speedRefTarget = 0; setSpeedRef('target'); }
                if (actions.speedRefCentre) { actions.speedRefCentre = 0; setSpeedRef('centre'); }
                if (actions.speedRefHome) { actions.speedRefHome = 0; setSpeedRef('home'); }
                if (actions.viewField) {
                        actions.viewField = 0;
                        // M cycles the render type: off → distance → depth spread → slope → off.
                        viewModesLayer.cycleMode();
                        syncViewModes();
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
                // View modes (view-modes.6): the heightmap over the frame. The
                // system schematic owns the screen while it is open.
                viewModesLayer.step(dt, {
                        camera,
                        starTimeMyr,
                        width: canvas.clientWidth,
                        height: canvas.clientHeight,
                        dpr: currentDpr(),
                        hidden: systemLayer.isOpen(),
                });
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
                                rightPanelInset(),
                                leftPanelInset());
                }

                overlayTimer += dt;
                if (overlayTimer >= OVERLAY_INTERVAL) {
                        overlayTimer = 0;
                        updateOverlay(renderer.state, camera.getState(statsText));
                        if (noSelectionTicks > 0) noSelectionTicks--;
                        if (autoMsgTicks > 0) autoMsgTicks--;
                if (gameMode) updateShipChromeText();
                if (sysMenu.style.display !== 'none') syncFlightUi();
                // The Trade panel stays live even while no menu is open: the
                // colonisation readout ("no big colonies ready") must reflect
                // the running network, not the moment the menu was opened.
                syncTradeUi();
                if (systemLayer.isOpen()) writeSystemReadout();
                        // View modes: the status line and the live range labels
                        // are 4 Hz text, like the rest of the readouts.
                        if (viewMenu.style.display !== 'none') {
                                vmStatus.textContent = viewModesLayer.statusLine();
                                syncViewModesRange();
                        }
                        // Keep slider readouts in sync with keyboard shortcuts
                        // while the menu is open.
                        if (menu.style.display !== 'none') syncSlidersFromRenderer();
                }
        });

        tradeSeedNetwork();
        syncTradeUi();
        syncFlightUi();
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
