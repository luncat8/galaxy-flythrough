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
                // The star-motion math: classic (closed form, default) or
                // simple (integrated friction field). Anything else falls back
                // to classic in orbit.setEngine.
                engine: text('engine', 'classic'),
                // Multiplier of the model's derived pattern speed: the friction
                // field's rotation rate (0 frozen … 3, 1 = the derived group
                // speed). Clamped by orbit.setPatternScale.
                pattern: number('pattern', window.OrbitLib.PATTERN_SCALE_UI_DEFAULT),
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
        let starTimeRate = 0;
        let lastNonZeroTimeRate = 1;
        // View control, not a model field. 0.6 is the measured hold (Sun ring
        // cosine 0.10 → ~0.6 in 300 Myr). 0 is the 0.4.3 shear.
        let waveDamping = window.OrbitLib.setWaveDamping(window.OrbitLib.WAVE_DAMPING_UI_DEFAULT);
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
        const input = window.Input.createInput(canvas);

        const landmarks = window.Landmarks;
        const labels = window.LabelLayer.createLabelLayer(
                document.getElementById('labels'), landmarks, window.Constellations);

        const selection = window.Selection.createSelection(camera, landmarks);
        let selected = -1;

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
        renderer.setEngine(params.engine);
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
        const engineSelect = document.getElementById('engine');
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
        function syncEngine() {
                engineSelect.value = renderer.state.engine;
                valEngine.textContent = renderer.state.engine === 'simple' ? 'friction field' : 'closed form';
        }
        engineSelect.addEventListener('change', () => {
                renderer.setEngine(engineSelect.value);
                initSimpleLandmarks();
                syncEngine();
                updateOverlay(renderer.state, camera.getState(statsText));
        });
        syncEngine();
        btnDefaults.addEventListener('click', () => {
                renderer.setExposure(window.StarRenderer.EXPOSURE_DEFAULT);
                renderer.setLinearExposure(window.StarRenderer.LINEAR_EXPOSURE_DEFAULT);
                renderer.setWhitePoint(window.StarRenderer.WHITE_POINT_DEFAULT);
                renderer.setSaturation(window.StarRenderer.SATURATION_DEFAULT);
                renderer.setHeadroom(window.StarRenderer.HEADROOM_DEFAULT);
                renderer.setHighlightDesat(window.StarRenderer.HIGHLIGHT_DESAT_DEFAULT);
                waveDamping = window.OrbitLib.setWaveDamping(window.OrbitLib.WAVE_DAMPING_UI_DEFAULT);
                patternScale = window.OrbitLib.setPatternScale(window.OrbitLib.PATTERN_SCALE_UI_DEFAULT, starTimeMyr, model);
                syncSlidersFromRenderer();
                syncWave();
                syncPattern();
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
                if (selected >= 0) {
                        selected = -1;
                        labels.setSelected(-1);
                }
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
                // valid — re-seeding either side would snap the epoch.
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

        function selectedLine(cameraState) {
                if (selected < 0 || cameraState.mode !== window.Camera.MODE_FLY) return '';
                return `\nselected ${landmarks.ENTRIES[selected].name}   (C C orbits it)`;
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
                        cameraLine(cameraState) +
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
                const effectiveTimeRate = starTimeRate < 0
                        ? (-starTimeRate) * window.OrbitLib.FLIGHT_TIME_GAIN * cameraStateForTime.speedLyPerSec
                        : starTimeRate;
                const dtStar = effectiveTimeRate * dt;
                starTimeMyr += dtStar;
                if (starTimeMyr >= STAR_TIME_WRAP || starTimeMyr < 0) starTimeMyr = ((starTimeMyr % STAR_TIME_WRAP) + STAR_TIME_WRAP) % STAR_TIME_WRAP;
                // The simple engine's CPU mirror steps beside the GPU buffer —
                // same dtStar the renderer dispatches, so labels and picks ride
                // what the sprites draw. Classic ignores both.
                if (renderer.state.engine === 'simple' && dtStar > 0) {
                        window.OrbitLib.simpleLandmarksStep(dtStar, starTimeMyr);
                }
                // R puts the orbit target back on the Sun, so a stale selection would
                // contradict it the next time the user cycles into orbit-object mode.
                // It also restarts the simple epoch on both sides of the mirror.
                if (resetting) {
                        selected = -1;
                        labels.setSelected(-1);
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
                        // Named stars only exist for the Milky Way preset, so a procedural-only
                        // galaxy has nothing to pick and nothing to orbit.
                        const hit = model.milkyWay
                        ? selection.pick(input.state.pickX, input.state.pickY, canvas.clientWidth, canvas.clientHeight)
                        : -1;
                        if (hit >= 0) {
                                selected = hit;
                                const entry = landmarks.ENTRIES[hit];
                                camera.setOrbitTarget(entry.x, entry.y, entry.z, entry.name);
                                labels.setSelected(hit);
                        }
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

                overlayTimer += dt;
                if (overlayTimer >= OVERLAY_INTERVAL) {
                        overlayTimer = 0;
                        updateOverlay(renderer.state, camera.getState(statsText));
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
