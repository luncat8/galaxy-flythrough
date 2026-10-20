// experiments/m1-smoke-test.js
// Wiring smoke test for the runtime. There is no browser in CI, and the page
// has no module system to fall back on, so two things can only be checked
// statically: that index.html loads every source file exactly once, and that
// nothing reads a global before the file that defines it has run.
//
// It also loads every module under a fake window and runs a short end-to-end
// (sample -> derive -> encode -> bundle -> loader) so a broken pipeline is a
// red test rather than a black canvas.
//
// Output: experiments/logs/m1-smoke.json

'use strict';

const fs = require('fs');
const path = require('path');
const logFile = require('./log-file.js');

const SRC = path.join(__dirname, '..', 'src');
global.window = global.window || global;

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
	return !!pass;
}

function walk(dir, base) {
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		const rel = path.posix.join(base, entry.name);
		if (entry.isDirectory()) out.push(...walk(full, rel));
		else if (entry.name.endsWith('.js')) out.push(rel);
	}
	return out;
}

// --- 1. The page loads exactly the source tree, in dependency order ------
const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf-8');
const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map(m => m[1]);
// The sandbox page's boot glue is the one file index.html never loads: the
// field math and the painter are shared now ("View Modes Shader.6" — the app's
// View modes panel hosts them), and view-modes.html loads the same two plus its
// own page script. The exclusion is a named list rather than a pattern that
// could swallow a real omission.
const ISLAND = ['view-modes.js'];
const sourceFiles = walk(SRC, '')
	.filter(f => f !== 'data/tiles/catalog.js' && !ISLAND.includes(f)).sort();
{
	check('index.html loads main.js last', scripts[scripts.length - 1] === 'main.js', scripts[scripts.length - 1]);
	check('index.html loads every source file exactly once',
		scripts.length === new Set(scripts).size
		&& JSON.stringify([...scripts].sort()) === JSON.stringify(sourceFiles),
		{ scripts: scripts.length, sources: sourceFiles.length, missing: sourceFiles.filter(f => !scripts.includes(f)) });
	check('every script index.html references exists on disk',
		scripts.every(s => fs.existsSync(path.join(SRC, s))),
		scripts.filter(s => !fs.existsSync(path.join(SRC, s))));
	check('the island is loaded by its own page, in field → painter → boot order', (() => {
		const islandHtml = fs.readFileSync(path.join(SRC, 'view-modes.html'), 'utf-8');
		const list = [...islandHtml.matchAll(/<script\s+src="([^"]+)"/g)].map(m => m[1]);
		return list.includes('math/view-modes-field.js')
			&& list.includes('render/view-modes-renderer.js')
			&& list.indexOf('math/view-modes-field.js') < list.indexOf('render/view-modes-renderer.js')
			&& list[list.length - 1] === 'view-modes.js'
			&& !scripts.includes('view-modes.js')
			&& /view-modes\.css/.test(islandHtml);
	})(), { island: ISLAND.map(f => scripts.includes(f)) });
	check('index.html has no leftover inline WGSL',
		!/text\/x-wgsl/.test(html), 'wgsl blocks');
	check('index.html references the stylesheet and the overlay elements',
		/<link[^>]+href="style\.css"/.test(html)
		&& /id="canvas"/.test(html) && /id="labels"/.test(html) && /id="system"/.test(html)
		&& /id="selection-menu"/.test(html) && /id="search-results"/.test(html)
		&& /id="btn-fly-to"/.test(html)
		&& /id="overlay"/.test(html) && /id="error"/.test(html),
		{ css: /style\.css/.test(html), elements: ['canvas', 'labels', 'system', 'selection-menu', 'search-results', 'overlay', 'error'].map(id => html.includes(`id="${id}"`)) });
}

{
	const main = fs.readFileSync(path.join(SRC, 'main.js'), 'utf-8');
	check('the menu iterates the full type table (galaxy type is menu-only since ui.4)',
		/for \(const type of galaxy\.GALAXY_TYPES\)/.test(main));
	const exposureDefault = require('../src/render/star-sprites.js').EXPOSURE_DEFAULT;
	check('startup exposure is 22 and the slider agrees',
		exposureDefault === 22 && /id="slider-exposure"[^>]+value="22"/.test(html));
	check('startup stellar rate is 1 Myr/s and freeze resumes that rate',
		/let starTimeRate = window\.Presets\.TIME_DEFAULT;/.test(main)
		&& require('../src/core/presets.js').TIME_DEFAULT === 1
		&& /let lastNonZeroTimeRate = starTimeRate;/.test(main)
		&& /id="slider-star-time"[^>]+value="1"/.test(html)
		&& /id="val-star-time"[^>]*>1 Myr\/s</.test(html));
	check('the scenario opens on the home colony and seeds nearest home first',
		/loop\.start\(\);[\s\S]*?goToHomeColony\(\);/.test(main)
		&& /tradeLib\.startSystems\(/.test(main) && /tradeLib\.discoverNearest\(/.test(main)
		&& /GENERATION_STAR_MYR/.test(main));
	check('the page starts in galaxy-centre orbit with unlocked input',
		/camera\.setFrame\(model\);[\s\S]*?camera\.setMode\(window\.Camera\.MODE_ORBIT_GC\);\s*const input = window\.Input\.createInput\(canvas\);\s*input\.setFlyMode\(false\);/.test(main));
	check('input policy follows camera mode after stepping',
		/camera\.step\(dt, input\.state\);[\s\S]*?input\.setFlyMode\(camera\.getState\(statsText\)\.mode === window\.Camera\.MODE_FLY\);/.test(main));
	// ui.4: the c/C/f/F mode keys and the g game-mode toggle, gated by G1's
	// game mode (game-mode-plan §3: the ship is the fly rig — the observer's
	// mode keys answer with a notice, never a silent no-op). A handful of
	// shapes must hold and not come back: the shift-cased pair in input.js, the
	// four gated consumers in the loop, the orbit via drawn position + follow,
	// and the retired G-cycle.
	{
		const inputSrc = fs.readFileSync(path.join(SRC, 'core', 'input.js'), 'utf-8');
		check('the c/C/f/F key map is shift-cased and game-gated in the loop, g toggles game mode',
			/const casedPressMap = \{ KeyC: \['orbitObject', 'orbitCentre'\], KeyF: \['flyMode', 'flyTo'\], KeyL: \['cargoLoad', 'cargoUnload'\] \};/.test(inputSrc)
			&& /KeyG: 'gameMode'/.test(inputSrc)
			&& !/cameraMode|galaxyCycle/.test(inputSrc)
			&& /actions\.orbitCentre = 0;\s*setSpeedRef\('centre'\);\s*if \(!gameMode\) camera\.setMode\(window\.Camera\.MODE_ORBIT_GC\);/.test(main)
			&& /actions\.orbitObject = 0;\s*if \(gameMode\) gameNotice\(\);\s*else if \(!orbitPrimary\(\)\) noSelectionTicks = NOTICE_TICKS;/.test(main)
			&& /actions\.flyTo = 0;\s*if \(gameMode\) gameCommand = GAME_CMD_APPROACH;\s*else if \(!flyToPrimary\(\)\) noSelectionTicks = NOTICE_TICKS;/.test(main)
			&& /actions\.flyMode = 0;\s*if \(gameMode\) gameCommand = GAME_CMD_ABORT;\s*else \{\s*camera\.setMode\(window\.Camera\.MODE_FLY\);\s*followKey = -1;\s*\}/.test(main)
			&& /actions\.gameMode = 0;\s*gameMode = !gameMode;/.test(main)
			&& /function orbitPrimary\(\) \{[\s\S]*?camera\.setOrbitTarget\(drawnPos\[0\][\s\S]*?camera\.setMode\(window\.Camera\.MODE_ORBIT_OBJECT\);\s*followKey = starSet\.keys\[i\] >>> 0;/.test(main)
			&& !/actions\.galaxyCycle/.test(main)
			&& !/toggleMode/.test(main));
	}
	// ui.6: the chase follow (j) and the clickable Controls panel that
	// replaced the help <pre>. Buttons and checkboxes fire the same one-shot
	// action flags the keys set, so the wiring to pin is the key in
	// input.js, the loop consumer with its orbit-object gate, the panel's
	// data-action delegation, and the state repaint — plus the retired
	// read-only <pre> that must not come back.
	{
		const inputSrc = fs.readFileSync(path.join(SRC, 'core', 'input.js'), 'utf-8');
		check('j toggles the chase follow and the Controls panel fires the same actions as the keys',
			/KeyJ: 'chaseFollow'/.test(inputSrc)
			&& /chaseFollow: 0/.test(inputSrc)
			&& /if \(actions\.chaseFollow\) \{/.test(main)
			&& /camera\.setChase\(false\);/.test(main)
			&& /camera\.setChase\(true\);/.test(main)
			&& /input\.state\.actions\[control\.dataset\.action\] = 1;/.test(main)
			&& /function syncHelpControls\(cameraState\) \{/.test(main)
			&& /helpBoxes\.get\('chaseFollow'\)\.checked = gameMode \? ship\.ap\.mode === shipLib\.AP_FOLLOW : cameraState\.chase;/.test(main)
			&& /helpPanel\.style\.display = visible \? 'none' : 'block';/.test(main)
			&& /id="help" class="panel"/.test(html)
			&& /id="help-collapse"/.test(html)
			&& /id="help-prev-star"/.test(html)
			&& /data-action="chaseFollow"/.test(html)
			&& /data-action="flyMode"/.test(html)
			&& !/<pre id="help">/.test(html));
	}
	// G1 of game-mode-plan.md: the ship as the fly rig — the shared clock on
	// the system-ladder convention, the getState/setState write-through (so
	// camera.js keeps no game branch), the velocity handover off the follow
	// feed, the §3 input gating (Space all-stop, home/teleport gated), and the
	// §6 HUD markers.
	{
		const inputSrc = fs.readFileSync(path.join(SRC, 'core', 'input.js'), 'utf-8');
		const shipSrc = fs.readFileSync(path.join(SRC, 'core', 'ship.js'), 'utf-8');
		check('game mode flies the ship through the camera state pair and gates the observer keys',
			/shipLib\.step\(ship, dtShipS, gameDir\[0\], gameDir\[1\], gameDir\[2\], factor, governorCap\)/.test(main)
			&& /camera\.getState\(rigState\)/.test(main)
			&& /camera\.setState\(rigState\)/.test(main)
			&& /const dtShipS = gameMode \? gameRateY \* shipLib\.SECONDS_PER_YEAR \* dt : 0;/.test(main)
			&& /gameDir\[0\] = f \* camera\.forward\[0\] \+ r \* camera\.right\[0\] \+ u \* camera\.up\[0\];/.test(main)
			&& /gameDir\[2\] = f \* camera\.forward\[2\] \+ r \* camera\.right\[2\] \+ u \* camera\.up\[2\];/.test(main)
			&& /if \(actions\.home\) \{\s*actions\.home = 0;\s*if \(!goToHomeColony\(\)\) \{\s*setSpeedRef\('home'\);\s*if \(gameMode\) gameNotice\(\);/.test(main)
			&& /Space: 'allStop'/.test(inputSrc)
			&& /allStop: 0, shipRefuel: 0/.test(inputSrc)
			&& /if \(gameMode\) enterGameMode\(\); else leaveGameMode\(\);/.test(main));
		check('the velocity handover seeds from the drawn-velocity dispatch in physical units',
			/followVelFresh = memberDrawnVelocity\(m, followVelPhys\)/.test(main)
			&& /framePhysSeconds = dtStar > 0 \? dtStar \* 1e6 \* shipLib\.SECONDS_PER_YEAR : 0;/.test(main)
			&& /if \(!activeFleetShip\.entered && followKey >= 0 && followVelFresh\) \{[\s\S]*?ship\.vel\[0\] = followVelPhys\[0\];/.test(main));
		check('the HUD carries the §6 lines and the ladder rides the star-time slider',
			/ship clock \$\{shipLib\.formatClock/.test(main)
			&& /coast eta \$\{dvLib\.formatDuration\(shipS\)\} ship/.test(main)
			&& /ap eta \$\{dvLib\.formatDuration\(profileOut\.timeS\)\}/.test(main)
			&& /tank empty \\u00b7 thrusters silent \\u00b7 coasting/.test(main)
			&& /stop incomplete \\u00b7 residual/.test(main)
			&& /accepted thrust/.test(main)
			&& /sliderStarTime\.min = shipLib\.SHIP_TIME_INDEX_MIN;/.test(main)
			&& /ship\.timeIndex = Number\(sliderStarTime\.value\);/.test(main)
			&& /const SHIP_TIME_LADDER = \[-1, 0,/.test(shipSrc));
		check('the central Flight hangar and the gated controls ride the panel patterns',
			/id="flight-console"/.test(html)
			&& /id="dv-ship"/.test(html)
			&& /id="flight-refuel"/.test(html)
			&& /data-action="shipRefuel"/.test(html)
			&& /data-observer/.test(html)
			&& /function setFlightShipClass\(classId\) \{[\s\S]*?shipLib\.setClass\(ship, classId\);/.test(main)
			&& /for \(const control of helpNeedObserver\) control\.disabled = gameMode;/.test(main)
			&& /btnSystemView\.disabled = gameMode;/.test(main));
	}
	// G2 of game-mode-plan.md: the §5 approach, follow and abort ride the same
	// ship law (the commands are requests consumed in the game block), the nose
	// is the camera's own look accumulator, and the §6 chrome is one pass of the
	// label layer. The wiring is pinned by shape; ship-test.js pins the numbers.
	{
		const labelSrc = fs.readFileSync(path.join(SRC, 'render', 'label-layer.js'), 'utf-8');
		check('the ship commands are consumed before the shared clock cap and refreshed after target motion',
			/gameCommand = GAME_CMD_APPROACH;/.test(main)
			&& /gameCommand = GAME_CMD_ABORT;/.test(main)
			&& /gameCommand = GAME_CMD_FOLLOW;/.test(main)
			&& /Promote game-mode keyboard requests[\s\S]*?if \(actions\.flyMode\).*GAME_CMD_ABORT[\s\S]*?if \(actions\.chaseFollow\).*GAME_CMD_FOLLOW[\s\S]*?if \(actions\.flyTo\).*GAME_CMD_APPROACH/.test(main)
			&& /if \(gameMode && !resetting\s*&& \(gameCommand !== 0 \|\| \(autoRunning && ship\.ap\.mode === shipLib\.AP_OFF\)\)\) \{\s*gameTargetFeed\(0\);\s*gameApplyCommand\(\);/.test(main)
			&& /gameTargetFeed\(dtShipS\);\s*gameHomeFeed\(dtShipS\);\s*gameShipStep\(dtShipS, dt\);/.test(main)
			&& /shipLib\.apCommitApproach\(ship,/.test(main)
			&& /shipLib\.apCommitFollow\(ship,/.test(main)
			&& /shipLib\.apStep\(ship, dtShipS, dtWallS,/.test(main)
			&& /if \(flying && \(gameTargetStale \|\| !gameTargetValid\)\) \{[\s\S]*?setAutoMsg\('target lost \\u00b7 autopilot off'\);\s*\} else if \(flying && thrusting\) \{\s*shipLib\.apAbort\(ship\);/.test(main)
			&& /shipLib\.apAbort\(ship\);\s*autoRunning = false;/.test(main));
		check('the nose eases through the camera look accumulator and the chrome is fed each game frame',
			/input\.state\.lookDx \+= k \* Math\.atan2\(xa, za\) \/ sens;/.test(main)
			&& /input\.state\.lookDy -= k \* Math\.atan2\(ya, za\) \/ sens;/.test(main)
			&& /gameAimEase\(dt\);/.test(main)
			&& /feedShipChrome\(\);/.test(main)
			&& /shipChrome\.active = gameMode;/.test(main)
			&& /labels\.setShipChrome\(shipChrome\);/.test(main));
		check('the HUD carries the auto line and the chrome strings refresh at the overlay cadence',
			/function gameAutoLine\(\)/.test(main)
			&& /text \+= gameAutoLine\(\);/.test(main)
			&& /if \(gameMode\) updateShipChromeText\(\);/.test(main)
			&& /if \(autoRunning && ship\.ap\.mode === shipLib\.AP_OFF\) \{\s*setAutoMsg\(autoReasonText\(ship\.ap\.reason\)\);\s*shipTimeRateCapY = Infinity;/.test(main));
		check('the fleet, camera-axis speeds, target stop, and four-second time cap are wired',
			/id="ship-list"/.test(html) && /id="ship-spawn"/.test(html)
			&& /id="flight-autopilot-dest"/.test(html) && /id="flight-autopilot-target"/.test(html)
			&& /id="velocity-forward"/.test(html) && /id="velocity-right"/.test(html)
			&& /id="velocity-up"/.test(html)
			&& /<small>Sideways<\/small>/.test(html) && /<small>Vertical<\/small>/.test(html)
			&& /· sideways \$\{shipLib\.formatAxisSpeed\(gameVelocityAxes\[1\]\)\} · vertical/.test(main)
			&& /flightAutoDest\.addEventListener\('change'/.test(main)
			&& /flightAutoTarget\.addEventListener\('change'/.test(main)
			&& /shipLib\.velocityComponents\(ship, camera\.forward, camera\.right, camera\.up/.test(main)
			&& /shipLib\.apCommitTarget\(ship,/.test(main)
			&& /shipLib\.timeRateCapYPerS\(ship\.ap\.etaS, AUTOPILOT_MIN_WALL_SECONDS\)/.test(main)
			&& /const AUTOPILOT_MIN_WALL_SECONDS = 4;/.test(main)
			&& /if \(ship\.timeFrozen\) return 0;/.test(main)
			&& /sliderStarTime\.addEventListener\('input'[\s\S]*?refreshShipTimeRateCap\(\);/.test(main)
			&& /shipSpawn\.addEventListener\('click'/.test(main)
			&& /ship: newShip, positioned: true, entered: true, button: null/.test(main)
			&& /function selectFleetShip\(id\)/.test(main)
			&& /if \(gameMode\) \{\s*positionCameraAtActiveShip\(\);[\s\S]*?gameTargetClosingKpcS = 0;\s*\} else \{\s*gameMode = true;\s*enterGameMode\(\);/.test(main)
			&& /else if \(flying && thrusting\) \{\s*shipLib\.apAbort\(ship\);\s*shipTimeRateCapY = Infinity;/.test(main));
		check('the ship chrome is one label-layer pass, drawn with or without the observer labels',
			/function drawShipChrome\(ctx, chrome, camera, width, height\)/.test(labelSrc)
			&& /if \(chromeOn\) drawShipChrome\(ctx, chrome, camera, width, height\);/.test(labelSrc)
			&& /if \(enabled\) \{\s*projectAll\(camera, width, height\);/.test(labelSrc));
		check('the Controls panel: fly is the abort in game mode and the commands are not observer-gated',
			/id="help-fly-label"/.test(html)
			&& /helpFly\.disabled = gameMode && ship\.ap\.mode === shipLib\.AP_OFF;/.test(main)
			&& !/data-action="flyTo" data-observer/.test(html)
			&& !/data-action="flyMode" data-observer/.test(html)
			&& !/data-action="chaseFollow" data-observer/.test(html));
	}
	// G3: the Flight panel is one task workspace, its destination is a
	// key-resolved snapshot, its four forecast modes feed the configured
	// autopilot, and throttle readouts use accepted—not discarded—impulse.
	{
		const shipSrc = fs.readFileSync(path.join(SRC, 'core', 'ship.js'), 'utf-8');
		check('Flight keeps manual thrust, destination, limits and route entry in one panel',
			/id="sysmenu" class="panel"/.test(html)
			&& /<span>Flight<\/span>/.test(html)
			&& /id="flight-thrust"/.test(html) && /id="flight-speed-governor"/.test(html)
			&& /id="flight-destination"/.test(html) && /id="flight-use-selected"/.test(html)
			&& /id="flight-mode"/.test(html) && /id="flight-time-limit"/.test(html)
			&& /id="flight-forecast"/.test(html) && /id="flight-autopilot-dest"/.test(html)
			&& /<span>System map &amp; routes<\/span>/.test(html));
		check('the destination snapshot resolves by key and the configured engage copies its plan',
			/function setFlightDestinationFromPrimary\(\) \{[\s\S]*?flightDestination\.key = ref\.key >>> 0;[\s\S]*?flightDestination\.lum = starSet\.lum\[i\];/.test(main)
			&& /selection\.resolveDrawn\(flightDestination, gameTarget\)/.test(main)
			&& /resolveMember\[home\] = -2; \/\/ destination-only entry/.test(main)
			&& /flightDestination\.index = slot;/.test(main)
			&& /GAME_CMD_PLAN = 4/.test(main)
			&& /else if \(cmd === GAME_CMD_PLAN\) gameEngageFlightPlan\(\);/.test(main)
			&& /shipLib\.apCommitApproach\(ship,[\s\S]*?flightPlan\.standOffM, flightPlan\)/.test(main)
			&& /shipLib\.planJourney\(remainingM, ship, flightMode, flightThrust,/.test(main)
			&& /const from = gameMode \? ship\.pos : camera\.cameraPos;/.test(main)
			&& /if \(!gameMode && \(speedRef !== 'target' \|\| flightDestination\.active \|\| starSet\.primary >= 0\)\) gameTargetFeed\(framePhysSeconds\);/.test(main));
		check('the speed limit cuts only positive forward thrust and applied impulse powers the HUD',
			/if \(speedControl && f > 0 && currentSpeed >= desiredSpeed\) f = 0;/.test(main)
			&& /const governorCap = speedControl && f > 0 && currentSpeed < desiredSpeed/.test(main)
			&& /let f = forwardKey !== 0 \? forwardKey : speedControl \? 0 : flightThrust;/.test(main)
			&& /const thrusting = forwardKey !== 0 \|\| r !== 0 \|\| u !== 0;/.test(main)
			&& /accepted thrust/.test(main)
			&& /function projectedImpulseDv\(vx, vy, vz, ix, iy, iz, cap\)/.test(shipSrc)
			&& /fuelLimited \? ship\.dvMax/.test(shipSrc)
			&& /let acceptedAccel = dtShipS > 0 \? appliedDv \/ dtShipS : 0;/.test(shipSrc)
			&& /NAV_FASTEST = 0, NAV_THRUST_LIMIT = 1, NAV_SPEED_LIMIT = 2, NAV_TIME_LIMIT = 3/.test(shipSrc));
	}
	// ui.11: the fly-on-ship fixes — a hull's own heading (spawned
	// at the camera, re-posed on hull switch), the speed reference
	// (selected target / galactic centre / home, with a button that
	// does not re-pose the camera), C and H as reference selectors,
	// and the mutually exclusive Pilot controls.
	{
		const inputSrc = fs.readFileSync(path.join(SRC, 'core', 'input.js'), 'utf-8');
		check('a hull spawned, entered or selected at the camera carries the camera heading',
			/newShip\.heading\[0\] = state\.orientation\[0\];/.test(main)
			&& /ship\.heading\[0\] = state\.orientation\[0\]; ship\.heading\[1\] = state\.orientation\[1\];/.test(main)
			&& /state\.orientation\[0\] = ship\.heading\[0\]; state\.orientation\[1\] = ship\.heading\[1\];/.test(main)
			&& /ship\.heading\[0\] = s\.orientation\[0\];\s*ship\.heading\[1\] = s\.orientation\[1\];/.test(main)
			&& /ship\.heading\[0\] = resetState\.orientation\[0\];/.test(main));
		check('the speed reference resolves fixed frame points and names them',
			/let speedRef = 'target';/.test(main)
			&& /function setSpeedRef\(kind\) \{/.test(main)
			&& /const p = speedRef === 'centre' \? model\.centre : model\.home\.orbitTarget;/.test(main)
			&& /gameTargetVel\.fill\(0\);/.test(main)
			&& /if \(gameTargetKind === 'centre'\) return 'galactic centre';/.test(main)
			&& /if \(gameTargetKind === 'home'\) return model\.home\.orbitName;/.test(main)
			&& /if \(!gameTargetValid\) return '\\ntarget    none selected/.test(main));
		check('C selects the centre reference and H the home reference, in both rigs',
			/actions\.orbitCentre = 0;\s*setSpeedRef\('centre'\);/.test(main)
			&& /setSpeedRef\('home'\);/.test(main));
		check('the Controls panel carries the three reference buttons as one-shot actions',
			/data-action="speedRefTarget" data-speed-ref="target"/.test(html)
			&& /data-action="speedRefCentre" data-speed-ref="centre"/.test(html)
			&& /data-action="speedRefHome" data-speed-ref="home"/.test(html)
			&& /speedRefTarget: 0, speedRefCentre: 0, speedRefHome: 0/.test(inputSrc)
			&& /if \(actions\.speedRefCentre\) \{ actions\.speedRefCentre = 0; setSpeedRef\('centre'\); \}/.test(main));
		check('the Pilot controls are mutually exclusive: touching one takes the forward axis',
			/let flightControl = 'speed';/.test(main)
			&& /function setFlightControl\(mode\) \{/.test(main)
			&& /flightThrustRow\.classList\.toggle\('is-off', speedControl\);/.test(main)
			&& /flightSpeedRow\.classList\.toggle\('is-off', !speedControl\);/.test(main)
			&& /id="flight-thrust-row"/.test(html) && /id="flight-speed-row"/.test(html)
			&& /id="velocity-ref"/.test(html));
	}
	// G4 of game-mode-plan.md (§10): docking, the port
	// service and life support. The dock command consumes
	// the O action, the ride feeds the station, the port
	// lands in the asset history, the home feed resolves
	// the port of registry, and the HUD and chrome carry
	// the service state.
	{
		const inputSrc = fs.readFileSync(path.join(SRC, 'core', 'input.js'), 'utf-8');
		const labelSrc = fs.readFileSync(path.join(SRC, 'render', 'label-layer.js'), 'utf-8');
		check('the port commands are one-shot actions with their keys',
			/dock: 0, cargoLoad: 0, cargoUnload: 0/.test(inputSrc)
			&& /KeyO: 'dock'/.test(inputSrc)
			&& /KeyL: \['cargoLoad', 'cargoUnload'\]/.test(inputSrc)
			&& /PANEL_BUTTON_SHORTCUTS = \{ KeyF: 1, KeyN: 1, KeyX: 1, KeyO: 1, KeyL: 1 \}/.test(inputSrc));
		check('the dock command commits the service and the asset history',
			/function gameDock\(\) \{[\s\S]*?shipLib\.dock\(ship, key, name,/.test(main)
			&& /selectionStore\.selectCurrent\(window\.SelectionStore\.GROUP_ASSET,[\s\S]*?type: 'dock-port',/.test(main)
			&& /const fixed = ship\.home\.kind === 'fixed';/.test(main));
		check('the docked ride feeds the station, breaks on a lost residency, and yields to thrust',
			/if \(ship\.docked && thrusting\) gameUndock\(\);/.test(main)
			&& /if \(ship\.docked\) \{[\s\S]*?shipLib\.dockStep\(ship,/.test(main)
			&& /setAutoMsg\('station left the residency'\);/.test(main)
			&& /const flying = !ship\.docked && ship\.ap\.mode !== shipLib\.AP_OFF;/.test(main));
		check('the home feed resolves the port of registry by key or the fixed home',
			/function gameHomeFeed\(dtShipS\) \{[\s\S]*?starSet\.indexOfKey\(ship\.home\.key\)/.test(main)
			&& /const p = model\.home\.orbitTarget;/.test(main)
			&& /function homeNameOf\(\) \{/.test(main));
		check('flight commands refuse while docked',
			/function gameUndockRequired\(\) \{/.test(main)
			&& /function gameApproach\(\) \{\s*if \(gameUndockRequired\(\)\) return;/.test(main)
			&& /function gameFollow\(\) \{\s*if \(gameUndockRequired\(\)\) return;/.test(main)
			&& /function gameStopAtTarget\(\) \{\s*if \(gameUndockRequired\(\)\) return;/.test(main)
			&& /function gameEngageFlightPlan\(\) \{\s*if \(gameUndockRequired\(\)\) return;/.test(main));
		check('the HUD carries the docked, cargo, home and expired lines',
			/\+ \(ship\.docked \? ` \\u00b7 docked at \$\{ship\.station\.name\}` : ''\);/.test(main)
			&& /\\ncargo     \$\{shipLib\.formatCargo\(ship\.cargo\)\}/.test(main)
			&& /\\nhome      \$\{homeLine\}/.test(main)
			&& /support expired \\u00b7 return to \$\{homeNameOf\(\)\}/.test(main)
			&& /LIFE_CRITICAL \? ' \\u00b7 critical' : ''\);/.test(main));
		check('the chrome draws the amber return-home marker',
			/shipChrome\.hasHome = shipLib\.lifeState\(ship\) === shipLib\.LIFE_EXPIRED/.test(main)
			&& /flightAutoDest\.disabled = !gameMode[\s\S]*?\|\| ship\.docked;/.test(main)
			&& /flightAutoTarget\.disabled = !gameMode[\s\S]*?\|\| ship\.docked;/.test(main)
			&& /shipChrome\.homeTagText = `\$\{homeNameOf\(\)\}  \$\{formatLy\(homeDistKpc \* LY_PER_KPC\)\}`;/.test(main)
			&& /if \(chrome\.hasHome\) chromeHome\(ctx, chrome, camera, cx, cy, focalPx, halfW, halfH\);/.test(labelSrc)
			&& /hasHome: false,/.test(labelSrc));
		check('the Flight panel carries the Port rows and the life crossings announce',
			/id="flight-dock"/.test(html) && /id="flight-cargo-load"/.test(html)
			&& /id="flight-cargo-unload"/.test(html) && /id="flight-port-state"/.test(html)
			&& /flightDock\.addEventListener\('click', \(\) => \{ actions\.dock = 1; \}\);/.test(main)
			&& /flightDock\.disabled = !gameMode;/.test(main)
			&& /lifeNow !== lastLifeState/.test(main)
			&& /setAutoMsg\('life support expired · return home'\);/.test(main));
		check('Space leaves the port and the port actions are game-gated',
			/if \(ship\.docked\) gameUndock\(\);\s*else \{/.test(main)
			&& /if \(actions\.dock\) \{\s*actions\.dock = 0;\s*if \(gameMode\) gameDock\(\);\s*else gameNotice\(\);/.test(main)
			&& /if \(actions\.cargoLoad\) \{\s*actions\.cargoLoad = 0;\s*if \(gameMode\) gameCargoLoad\(\);\s*else gameNotice\(\);/.test(main)
			&& /if \(actions\.cargoUnload\) \{\s*actions\.cargoUnload = 0;\s*if \(gameMode\) gameCargoUnload\(\);\s*else gameNotice\(\);/.test(main));
	}
	// G5 of game-mode-plan.md (§4/§8): the SIM and ARCADE clock presets are
	// Controls-panel buttons on the ship-time ladder — SIM the real-time stop,
	// ARCADE the class home rung plus the autopilot coast warp — gated to game
	// mode and lit from the live clock. ship-test.js pins the numbers.
	{
		const inputSrc = fs.readFileSync(path.join(SRC, 'core', 'input.js'), 'utf-8');
		const shipSrc = fs.readFileSync(path.join(SRC, 'core', 'ship.js'), 'utf-8');
		check('the Controls panel carries the SIM and ARCADE presets, game-gated',
			/data-action="clockSim" data-game/.test(html)
			&& /data-action="clockArcade" data-game/.test(html)
			&& /helpNeedGame = Array\.from\(helpPanel\.querySelectorAll\('\[data-game\]'\)\)/.test(main)
			&& /for \(const control of helpNeedGame\) control\.disabled = !gameMode;/.test(main)
			&& /clockSim: 0, clockArcade: 0/.test(inputSrc));
		check('the presets land before the shared clock is read and light from the live clock',
			/if \(actions\.clockSim\) \{ actions\.clockSim = 0; setShipClockPreset\('sim'\); \}/.test(main)
			&& /if \(actions\.clockArcade\) \{ actions\.clockArcade = 0; setShipClockPreset\('arcade'\); \}/.test(main)
			&& /function setShipClockPreset\(preset\) \{\s*shipLib\.setClockPreset\(ship, preset\);/.test(main)
			&& /helpClockSim\.classList\.toggle\('is-active', gameMode && !ship\.arcade\s*&& ship\.timeIndex === shipLib\.SHIP_TIME_REAL_INDEX\);/.test(main)
			&& /helpClockArcade\.classList\.toggle\('is-active', gameMode && ship\.arcade\);/.test(main));
		check('the arcade warp is the autopilot wall-time floor as a lower bound and the HUD names it',
			/shipLib\.arcadeWarpYPerS\(ship, AUTOPILOT_MIN_WALL_SECONDS\)/.test(main)
			&& /coast warp \$\{formatShipRate\(actualRate\)\}/.test(main)
			&& /function arcadeWarpYPerS\(ship, minWallSeconds\) \{\s*if \(!ship\.arcade \|\| ship\.timeFrozen\) return 0;/.test(shipSrc)
			&& /if \(ap\.phase !== AP_PHASE_COAST\) return 0;/.test(shipSrc));
		check('the ladder grows the real-time stop and the follow fallback stays the first timed rung',
			/const SHIP_TIME_LADDER = \[-1, 0, SHIP_TIME_REAL,/.test(shipSrc)
			&& /const SHIP_TIME_REAL = 1 \/ SECONDS_PER_YEAR;/.test(shipSrc)
			&& /rate = shipLib\.SHIP_TIME_LADDER\[shipLib\.SHIP_TIME_FIRST_TIMED_INDEX\];/.test(main));
	}
	check('every element main.js looks up exists in index.html',
		(function () {
			const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
			const used = [...main.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
			const missing = used.filter((id) => !ids.has(id));
			return missing.length === 0;
		})(), 'missing ids');
	check('the sysmenu selector main.js queries is an id in the page',
		/#sysmenu \[data-view\]/.test(main) && /id="sysmenu"/.test(html));
	check('selection state, nearby-centred search, result picking and prior-to-current routing are wired',
		/SelectionStore\.createSelectionStore\(\)/.test(main)
		&& /selectionStore\.selectCurrent\(window\.SelectionStore\.GROUP_SPACE/.test(main)
		&& /recordSystemBodySelection\(body\)/.test(main)
		&& /type: 'planet'/.test(main) && /type: 'other'/.test(main)
		&& /selectionStore\.setAssetPair/.test(main)
		&& /centerX, centerY, centerZ/.test(main)
		&& /searchResultsList\.addEventListener\('click'/.test(main)
		&& /selectedStarEndpoints\(\)/.test(main)
		&& /historyEndpoint\(previous\), historyEndpoint\(current\)/.test(main)
		&& /routeRoundtrip/.test(main)
		&& /selection-swap/.test(html)
		&& /asset-pair-first-set/.test(html));
	const searchStart = main.indexOf('function runSearch()');
	const searchEnd = main.indexOf("btnSearch.addEventListener('click', runSearch);");
	const searchRun = main.slice(searchStart, searchEnd);
	check('search pauses once, scans one drawn-position snapshot, and supports selecting then flying to a result',
		searchStart >= 0 && searchEnd > searchStart
		&& /function runSearch\(\) \{\s*pauseStarTimeForSearch\(\);/.test(searchRun)
		&& /selection\.resolveDrawn\(selectedCenter, searchCenterPosition\)/.test(searchRun)
		&& /search\.run\(filter, \{[\s\S]*?time: searchTimeMyr/.test(searchRun)
		&& /snapshot '\s*\+ res\.stats\.timeMyr/.test(searchRun)
		&& /btnFlyTo\.addEventListener\('click', \(\) => \{\s*if \(!flyToPrimary\(\)\) return;/.test(main)
		&& /btnFlyTo\.disabled = starSet\.primary < 0/.test(main)
		&& /id="btn-fly-to"[^>]*>Fly to primary \(Shift\+F\)<\/button>/.test(html));
	// ui.2: the camera and the radius scan judge *drawn* positions, not the birth
	// records the snapshots store. There is no browser to run this in, so the
	// wiring is pinned as text — including the two shapes that must not come back
	// (a fly-to aimed at starSet.x, and the landmarks-only/simple-only follow).
	check('fly-to, the orbit target and the follow resolve drawn positions, not birth snapshots',
		/function memberDrawnPosition\(i, out\) \{\s*return selection\.resolveDrawn\(memberRefFor\(i\), out\);/.test(main)
		&& /memberDrawnPosition\(i, drawnPos\);\s*camera\.flyToStar\(drawnPos\[0\], drawnPos\[1\], drawnPos\[2\]/.test(main)
		&& /selection\.resolveDrawn\(hit, drawnPos\);\s*camera\.setOrbitTarget\(drawnPos\[0\]/.test(main)
		&& /memberDrawnPosition\(p, drawnPos\);[\s\S]{0,400}?camera\.flyToStar\(drawnPos\[0\]/.test(main)
		// The camera steps after the target is fresh (game mode's ship step
		// rides between them; the order rule is what this pins).
		&& /if \(followKey >= 0 && cameraStateForTime\.mode === window\.Camera\.MODE_ORBIT_OBJECT\) \{\s*followTarget\(\);\s*\}[\s\S]{0,1800}?camera\.step\(dt, input\.state\);/.test(main)
		&& (main.match(/camera\.step\(/g) || []).length === 1
		&& /const drawn = memberDrawnPosition\(i, drawnPos\);/.test(main)
		&& !/camera\.flyToStar\(starSet\.x\[/.test(main)
		&& !/simpleLandmarkPosition\(followPos/.test(main)
		&& !/followLandmark/.test(main));
	check('the radius scan is chunked on the picker\'s contract and centred on a drawn position',
		/memberDrawnPosition\(p, aroundCentre\);/.test(main)
		&& /selection\.beginSelectAround\(aroundCentre\[0\], aroundCentre\[1\],/.test(main)
		&& /if \(aroundPending && selection\.selectAroundStep\(SWEEP_SLICE_RECORDS, SWEEP_SLICE_MS\)\) \{\s*applyAroundResult\(\);/.test(main)
		&& /if \(around\.aborted\) \{/.test(main)
		&& !/selection\.selectAround\(/.test(main));
	check('the route endpoints and the readout distance are drawn-space too',
		/x: drawnPos\[0\], y: drawnPos\[1\], z: drawnPos\[2\] \};/.test(main)
		&& /selection\.resolveDrawn\(ref, drawnPos\);\s*return stellarEndpointFrom\(ref, ref\);/.test(main));
	// 0.6 E4: an age change is *not* a re-draw. The epoch places the field the
	// field was drawn into (renderer.setEpoch → orbit.epochMap), the look follows
	// in the renderer's background sweep, and only a new galaxy, seed or star
	// budget goes through redrawField at all. The phase is an accumulator
	// (orbit.advancePatternPhase), so nothing rebases it and nothing carries a
	// theta shift across a draw any more — a run of the clock adds a rate over an
	// interval instead of multiplying the current rate by the whole elapsed
	// clock, which is what the "return back in time every Evolve step" was.
	// Checked as text here because there is no browser to run it in.
	const epochFn = main.match(/function setEpoch\(age\) \{[\s\S]*?\n        \}/);
	const drawFn = main.match(/function redrawField\(next\) \{[\s\S]*?\n        \}/);
	check('an age change places the field through setEpoch: no re-draw, no rebase, no carry',
		!!epochFn && /galaxy\.modelAtAge\(model, /.test(epochFn[0])
		&& /renderer\.setEpoch\(model\);/.test(epochFn[0])
		&& !/regenerateAge|redrawField/.test(epochFn[0])
		&& !!drawFn && /renderer\.regenerate\(model\);/.test(drawFn[0])
		&& /simpleLandmarksRebind\(model\)\) initSimpleLandmarks\(\);/.test(drawFn[0])
		&& /resolveSet\(\);/.test(drawFn[0]),
		drawFn ? drawFn[0].length : null);
	check('nothing rebases the pattern phase: the loop advances it and a draw never turns the field',
		/OrbitLib\.setPatternClock\(starTimeMyr, model\)/.test(main)
		&& /OrbitLib\.resetPatternPhase\(\)/.test(main)
		&& !/rebasePatternPhase|patternPhaseOffset|thetaShift/.test(main));
	// 0.6 E2: the epoch's live clock. The law (quantum, price, drop, hold,
	// replay) is pinned numerically in galaxy-evolution-test.js — what cannot be
	// run here is the wiring: the toggle, the boot gate and the loop's step path,
	// which has to hand the tick the same dtStar the stars just integrated.
	check('the live clock is wired: the toggle, the boot gate and the step path',
		/id="galaxy-evolve"/.test(html) && /id="val-epoch"/.test(html)
		&& /galaxyEvolve\.addEventListener\('change'/.test(main)
		&& /const start = galaxy\.evolveStartAge\(model\.populations\.age\);/.test(main)
		&& /if \(evolveOn\) \{\s*const evolved = galaxy\.evolveAge\(model\.populations\.age, dtStar\);/.test(main)
		&& /if \(evolved !== model\.populations\.age\) setEpoch\(evolved\);/.test(main)
		&& /evolveOn \? galaxy\.evolveStartAge\(params\.age\) : params\.age/.test(main)
		&& /galaxyAge\.step = galaxy\.AGE_STEP;/.test(main));
	check('the epoch readout is the model\'s own age, and the drag applies every frame it changed',
		/valEpoch\.textContent = formatAge\(model\.populations\.age\);/.test(main)
		&& /if \(pendingAge !== null && pendingAge !== model\.populations\.age\) setEpoch\(pendingAge\);/.test(main)
		&& !/AGE_REGEN_INTERVAL/.test(main));
	check('opening a panel releases pointer lock',
		/function releasePanelInput\(\) \{[\s\S]*?document\.exitPointerLock\(\);[\s\S]*?\}/.test(main)
		&& /\} else \{\s*releasePanelInput\(\);/.test(main));
}

// --- 2. No global is read before it is defined --------------------------
{
	const BROWSER_GLOBALS = new Set([
		'devicePixelRatio', 'innerWidth', 'innerHeight', 'addEventListener', 'removeEventListener',
		'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'location', 'navigator',
		'matchMedia', 'Device', 'Presets', 'GalaxyShaders', 'HashLib', 'DensityLib', 'GalaxyLib', 'SamplingLib',
		'StarRecord', 'StarTypesLib', 'PlanetsLib', 'NebulaLib', 'ObjectsLib', 'Coords', 'Camera', 'Input', 'Loop', 'Selection', 'StarSet', 'SelectionStore',
		'Landmarks', 'Constellations', 'StarRenderer', 'LabelLayer', 'SystemLayer',
		'TileLoader', 'CellManager', '__galaxy_catalog', 'self', 'document', 'setTimeout',
	]);
	const defined = new Set();
	const undefinedReads = [];
	const NAMESPACES = ['Device', 'Camera', 'Input', 'Loop', 'Selection', 'StarSet', 'SelectionStore', 'Presets', 'StarRenderer', 'LabelLayer', 'SystemLayer',
		'TileLoader', 'CellManager', 'Ship', 'GalaxyShaders', 'HashLib', 'DensityLib', 'GalaxyLib', 'SamplingLib',
		'StarRecord', 'StarTypesLib', 'PlanetsLib', 'NebulaLib', 'ObjectsLib', 'Coords', 'Landmarks', 'Constellations',
		'ViewModesField', 'ViewModesRenderer', 'ViewModesLayer',
		'ExecQueueLib', 'EconomyLib', 'TradeLib'];
	for (const file of scripts) {
		const text = fs.readFileSync(path.join(SRC, file), 'utf-8');
		// Registers its own namespace before anything else can read it.
		for (const m of text.matchAll(/window\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=[^=]/g)) defined.add(m[1]);
		for (const m of text.matchAll(/window\.([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
			const name = m[1];
			const after = text.slice(m.index + m[0].length).replace(/^\s+/, '');
			if (after.startsWith('=') && !after.startsWith('==')) continue;   // assignment, not a read
			if (!NAMESPACES.includes(name)) continue;
			if (!defined.has(name)) undefinedReads.push(`${file}: window.${name}`);
		}
	}
	check('every src module namespace is defined before it is read',
		undefinedReads.length === 0, undefinedReads);
	check('all module namespaces are registered by the time main.js runs',
		NAMESPACES.every(n => defined.has(n)),
		[...defined].filter(n => n !== '__galaxy_catalog'));
}

// --- 3. Modules load and expose a usable surface ------------------------
{
	const namespaces = [
		['../src/math/hash.js', 'HashLib'], ['../src/math/density.js', 'DensityLib'],
		['../src/math/galaxy.js', 'GalaxyLib'],
		['../src/math/sampling.js', 'SamplingLib'], ['../src/math/star-record.js', 'StarRecord'],
		['../src/math/star-types.js', 'StarTypesLib'], ['../src/math/planets.js', 'PlanetsLib'],
		['../src/math/orbit.js', 'OrbitLib'], ['../src/math/nebula.js', 'NebulaLib'],
		['../src/math/objects.js', 'ObjectsLib'], ['../src/math/clusters.js', 'ClustersLib'],
		['../src/math/coords.js', 'Coords'],
		['../src/core/camera.js', 'Camera'], ['../src/core/input.js', 'Input'], ['../src/core/ship.js', 'Ship'],
		['../src/core/exec-queue.js', 'ExecQueueLib'], ['../src/core/economy.js', 'EconomyLib'],
		['../src/core/trade.js', 'TradeLib'],
		['../src/core/selection.js', 'Selection'], ['../src/core/star-set.js', 'StarSet'],
		['../src/core/selection-store.js', 'SelectionStore'], ['../src/core/loop.js', 'Loop'],
		['../src/core/presets.js', 'Presets'],
		['../src/core/device.js', 'Device'],
		['../src/data/landmarks.js', 'Landmarks'], ['../src/data/constellations.js', 'Constellations'],
		['../src/render/shaders.js', 'GalaxyShaders'], ['../src/render/star-sprites.js', 'StarRenderer'],
		['../src/render/label-layer.js', 'LabelLayer'],
		['../src/render/system-layer.js', 'SystemLayer'],
		['../src/math/view-modes-field.js', 'ViewModesField'],
		['../src/render/view-modes-renderer.js', 'ViewModesRenderer'],
		['../src/render/view-modes-layer.js', 'ViewModesLayer'],
		['../src/stream/tile-loader.js', 'TileLoader'], ['../src/stream/cell-manager.js', 'CellManager'],
	];
	for (const [file, name] of namespaces) {
		let api = null;
		try {
			api = require(file);
		} catch (err) {
			check(`${name} loads under Node`, false, err.message);
			continue;
		}
		check(`${name} loads under Node and is registered on window`,
			typeof api === 'object' && api !== null && global.window[name] === api,
			{ keys: Object.keys(api || {}).length });
	}

	// The entry points main.js actually calls.
	check('the runtime entry points main.js uses all exist',
		typeof global.window.Device.initDevice === 'function'
		&& typeof global.window.Camera.createCamera === 'function'
		&& typeof global.window.Input.createInput === 'function'
		&& typeof global.window.Ship.createShip === 'function'
		&& typeof global.window.TradeLib.createNetwork === 'function'
		&& typeof global.window.EconomyLib.setupColony === 'function'
		&& typeof global.window.ExecQueueLib.createExecQueue === 'function'
		&& typeof global.window.Loop.createLoop === 'function'
		&& typeof global.window.StarRenderer.createStarRenderer === 'function'
		&& typeof global.window.TileLoader.loadCatalog === 'function'
		&& typeof global.window.CellManager.createCellManager === 'function'
		&& typeof global.window.GalaxyLib.createGalaxy === 'function'
		&& typeof global.window.GalaxyLib.packDensityParams === 'function'
		&& typeof global.window.Camera.createCamera().setFrame === 'function'
		// The schematic view main.js opens on V (§6.5).
		&& typeof global.window.SystemLayer.createSystemLayer === 'function'
		// The two calls a galaxy change makes on the draw side: rebuild the field,
		// and silence the label layer for a model that has no named stars.
		&& typeof global.window.LabelLayer.createLabelLayer({ getContext: () => null },
			global.window.Landmarks, global.window.Constellations).setEnabled === 'function');

	const mainSrc = fs.readFileSync(path.join(SRC, 'main.js'), 'utf-8');
	check('main.js reads the wired shader through the same map the validator uses',
		/main\.js/.test('main.js') && typeof global.window.GalaxyShaders.SHADERS['star-sprite'] === 'string');
	check('main.js does not reference removed modules',
		!/star-distant|split-double|precomputeRhoMax|sampleStars\b/.test(mainSrc), 'legacy names');
}

// --- 4. The shipped catalog asset loads --------------------------------
{
	const assetPath = path.join(SRC, 'data', 'tiles', 'catalog.js');
	check('the catalog bundle is present', fs.existsSync(assetPath));
	if (fs.existsSync(assetPath)) {
		const bundle = require(assetPath);
		const manifest = global.window.TileLoader.prepareBundle(bundle);
		check('the shipped catalog prepares into a manifest',
			manifest.cellCount > 0 && manifest.starCount > 0
			&& manifest.bandNames.join(',') === 'near,medium,far',
			{ cells: manifest.cellCount, stars: manifest.starCount, bands: manifest.bandNames });
		check('the shipped catalog carries non-degenerate streaming radii',
			Array.from(manifest.bandRadius).every(r => r > 0), Array.from(manifest.bandRadius));
		const mainSrc = fs.readFileSync(path.join(SRC, 'main.js'), 'utf-8');
		const loaded = (mainSrc.match(/loadCatalog\(\s*'([^']+)'/) || [])[1];
		check('main.js loads the asset at the path the encoder writes',
			loaded === 'data/tiles/catalog.js', loaded);
	}
}

// --- 5. Boot parameters -------------------------------------------------
{
	const main = require('../src/main.js');
	check('main.js exposes its helpers without booting in Node',
		typeof main.boot === 'function' && typeof main.readParams === 'function');
	const parsed = main.readParams('?stars=5000&catalog=10000&seed=7&exposure=22&engine=apocenter&evolve=1');
	check('readParams reads every documented parameter including the apocenter engine',
		parsed.stars === 5000 && parsed.catalogStars === 10000
		&& parsed.seed === 7 && parsed.exposure === 22 && parsed.engine === 'apocenter'
		&& parsed.evolve === 1, parsed);
	const defaults = main.readParams('');
	check('readParams falls back to the renderer defaults',
		defaults.stars === global.window.StarRenderer.PROCEDURAL_STARS_DEFAULT
		&& defaults.catalogStars === global.window.StarRenderer.CATALOG_BUDGET_DEFAULT
		&& defaults.exposure === null && defaults.evolve === 0, defaults);
	const junk = main.readParams('?stars=abc&catalog=&seed=NaN');
	check('readParams ignores non-numeric values',
		junk.stars === global.window.StarRenderer.PROCEDURAL_STARS_DEFAULT
		&& junk.catalogStars === global.window.StarRenderer.CATALOG_BUDGET_DEFAULT
		&& junk.seed === 42, junk);
}

// --- 6. The page's real loading model: one shared global scope ----------
// require() gives every module its own scope, which hides the one failure
// classic <script> tags add: two files declaring the same top-level const is a
// SyntaxError when the second one loads, and a namespace read at load time
// (camera.js reads window.DensityLib for the orbit centre) must find the
// earlier script's export. Evaluate every script in index.html order inside
// one vm context with a fake window, exactly as the browser would.
{
	const vm = require('vm');
	const page = {
		addEventListener() {}, removeEventListener() {},
		devicePixelRatio: 1, location: { search: '' }, navigator: {},
		requestAnimationFrame: () => 1, cancelAnimationFrame() {},
		performance: { now: () => 0 }, console, URLSearchParams,
		document: { addEventListener() {}, getElementById: () => null },
	};
	page.window = page;
	page.self = page;
	const context = vm.createContext(page);
	let failure = null;
	for (const file of scripts) {
		try {
			new vm.Script(fs.readFileSync(path.join(SRC, file), 'utf-8'), { filename: file }).runInContext(context);
		} catch (err) {
			failure = `${file}: ${err.constructor.name}: ${err.message}`;
			break;
		}
	}
	check('every script evaluates in one shared global scope, in page order (no duplicate top-level names)',
		failure === null, failure);
	check('camera.js finds the orbit centre through window.GalaxyLib when loaded as a page script',
		failure === null && Array.from(page.Camera.GALACTIC_CENTRE_TARGET).join(',') === '8.178,0,0'
		&& page.Camera.createCamera().getState().modeName === 'fly');
	check('the page scope builds a model per type, so ?type=Sc boots',
		failure === null && page.GalaxyLib && page.GalaxyLib.GALAXY_TYPES.length === 19
		&& page.GalaxyLib.createGalaxy({ type: 'Sc' }).arms.pitchDeg === 15
		&& page.GalaxyLib.createGalaxy({ type: 'E4' }).thin.amp === 0,
		failure || (page.GalaxyLib && page.GalaxyLib.GALAXY_TYPES));
	check('the page scope bakes the landmark table and resolves every constellation edge',
		failure === null && page.Landmarks && page.Constellations
		&& page.Landmarks.count >= 30 && page.Landmarks.count <= 60
		&& page.Constellations.count === 15 && page.Constellations.edgeCount >= 25,
		failure || { landmarks: page.Landmarks && page.Landmarks.count, figures: page.Constellations && page.Constellations.count });
}

// --- 7. Short end-to-end ------------------------------------------------
{
	const sampling = require('../src/math/sampling.js');
	const starTypes = require('../src/math/star-types.js');
	const records = require('../src/math/star-record.js');
	const galaxy = require('../src/math/galaxy.js');
	const model = galaxy.MILKY_WAY;
	const buf = sampling.sampleGalaxyStars(model, 99, 500);
	check('the end-to-end sample has the requested stars', buf.count === 500, buf.count);
	const record = {};
	starTypes.deriveStar(model, 1234, buf.component[0], buf.R[0], buf.distToArm[0], record);
	check('a sampled star derives a complete record',
		Number.isFinite(record.mass) && Number.isFinite(record.absMag)
		&& typeof record.spectralClass === 'string' && Number.isFinite(record.teff),
		{ mass: record.mass, absMag: record.absMag, spectralClass: record.spectralClass });
	const bytes = new Uint8Array(records.RECORD_BYTES);
	const view = new DataView(bytes.buffer);
	records.writeRecord(view, 0, buf.x[0], buf.y[0], buf.z[0],
		record.colorIndex, record.absMag, records.FLAG_VISIBLE, 0);
	const back = records.readRecord(view, 0);
	check('a packed record round-trips through StarPacked',
		back.visible
		&& Math.abs(back.x - Math.fround(buf.x[0])) === 0
		&& Math.abs(back.absMag - record.absMag) < records.ABS_MAG_SPAN / 255 + 1e-6,
		{ x: back.x, absMag: back.absMag });
	// Ten entries: nine classes plus the dedicated RGe slot the metal-poor
	// spheroid-giant shift lands on (star-types cannot classify an RGe, only
	// shift into it).
	check('the color LUT covers every spectral class',
		records.buildColorLUT().length === 256 * 4 && records.SPECTRAL_CLASSES.length === 10,
		records.SPECTRAL_CLASSES.length);
}

// --- Report --------------------------------------------------------------
let passed = 0;
let failed = 0;
for (const c of checks) {
	if (c.pass) passed++; else failed++;
	console.log(`  ${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.pass ? '' : `  -> ${JSON.stringify(c.detail)}`}`);
}
console.log(`\n${passed}/${checks.length} passed, ${failed} failed`);

const logPath = path.join(__dirname, 'logs', 'm1-smoke.json');
logFile.writeLog(logPath, {
	date: new Date().toISOString(),
	scripts,
	sourceFiles,
	totalChecks: checks.length,
	passed,
	failed,
	checks,
});
console.log('\n=== VERDICT ===');
console.log(failed === 0 ? 'PASS — the runtime is wired consistently' : `FAIL — ${failed} checks failed`);
process.exit(failed === 0 ? 0 : 1);
