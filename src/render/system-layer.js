// src/render/system-layer.js
// The close-system view (0.5.3/0.5.6, plan §6/§7): a 2D canvas above the label
// layer that draws the opened star's generated system — log-polar orbits, the
// habitable annulus, belt stipples, colour-coded planet icons — plus exact
// screen-space picking and the #sysread text. The same canvas carries the two
// delta-v map renders (§7.5): the classic star-shaped graph, the rail render
// (every node kind on its own row), and a time-scaled flight schematic whose
// average ferry tracks have lengths proportional to their Hohmann durations.
//
// CPU-only by construction (plan §1.1): one system is ≤ 12 planets + 2 belts,
// so this is ~800 canvas ops a frame with zero allocations. Drawn every frame
// ONLY while the view is open; closed, draw() is one boolean test and a return.
//
// Layout (plan §6.1): the radial axis is logarithmic — 0.03 AU to 40 AU is a
// factor of 1300, unusable at true scale. ρ(a) maps an axis into [0,1] between
// the view's inner and outer bounds; r_px = R_STAR_PX + ρ·(R_EDGE_PX − R_STAR_PX).
// Belt stipples map through the same ρ, so a belt and a planet at the same `a`
// sit at the same radius.
//
// The schematic is flat (plan §14 Q4, decided with 0.5.3-2): one plane, each
// orbit ellipse squashed by its own cos i. A planet rides the ellipse that is
// drawn for it — its screen position is the ellipse point at parameter angle
// θ(t) = θ₀ + TAU·(t_sys/P) — so picking can never disagree with the draw, and
// at e = 0, i = 0 that is exactly the plan's polar (r_px(a), θ).
//
// Time (plan §6.4) is the view's own clock in years/s, independent of the
// galaxy's Myr/s star time: at 1 Myr/s an Earth orbit strobes at 10⁶ turns per
// second. −1 couples the rate to the camera fly speed the way the star-time
// slider does, through orbit.js's own FLIGHT_TIME_GAIN. The rate is picked off
// a geometric ladder, because the legs the ship flies span six decades: a
// low-orbit launch is ~1e-4 y, a Hohmann transfer ~0.4 y.

(function () {
'use strict';

const layerPlanets = (typeof module !== 'undefined' && module.exports)
	? require('../math/planets.js')
	: ((typeof window !== 'undefined') ? window.PlanetsLib : null);
const layerRecords = (typeof module !== 'undefined' && module.exports)
	? require('../math/star-record.js')
	: ((typeof window !== 'undefined') ? window.StarRecord : null);
const layerOrbit = (typeof module !== 'undefined' && module.exports)
	? require('../math/orbit.js')
	: ((typeof window !== 'undefined') ? window.OrbitLib : null);
// NOTE: deltav.js is loaded before label-layer.js on the Node side because
// the export-parity test walks windows added between the before-snapshot and
// after-require: whichever module require() pulls in last is the "added"
// window namespace that test counts. In the browser <script> order keeps
// deltav.js before label-layer.js before system-layer.js, and all three
// namespaces register once each.
const layerDv = (typeof module !== 'undefined' && module.exports)
	? require('../math/deltav.js')
	: ((typeof window !== 'undefined') ? window.DeltaVLib : null);
const layerRoute = (typeof module !== 'undefined' && module.exports)
	? require('../core/route.js') : window.RouteLib;
const layerLabels = (typeof module !== 'undefined' && module.exports)
	? require('./label-layer.js')
	: ((typeof window !== 'undefined') ? window.LabelLayer : null);

const TRADE_MARKER_STYLE = layerLabels.TRADE_MARKER_STYLE;
const TRADE_INTRA_DASH = [3, 6];
const TRADE_SOLID_DASH = [];
// The lane a colony's interstellar hulls leave along (trade.35). Faint and
// dashed: it is a direction, not a route the economy owns.
const HULL_LANE = 'rgba(150, 190, 240, 0.16)';
const HULL_LANE_DASH = [2, 6];
const TRADE_INTRA_STROKES = [
	'rgba(180, 150, 110, 0.30)', // bulk
	'rgba(110, 235, 190, 0.30)', // goods
	'rgba(240, 225, 150, 0.30)', // passengers
];
// The intra fleet (trade.34). The ferries are a picture of recent settled
// trade — trade.js records the three largest legs and how many of the twelve
// boats each one gets — and they fly on THIS layer's clock, at each leg's own
// delta-v flight time. Nothing here writes to the model: the mass the couple
// moved is already in the stocks. A short trail behind the dot makes the
// direction of travel readable at 2 px, which is the whole reason the fleet
// exists (a dash that arrives instantly is a picture, not a fleet).
const INTRA_FERRY_PX = 2.2;
const INTRA_FERRY_STROKE = 'rgba(255, 236, 180, 0.92)';
const INTRA_FERRY_FILL = 'rgba(255, 196, 96, 0.95)';
const INTRA_FERRY_TAIL = 'rgba(255, 196, 96, 0.28)';
const INTRA_FERRY_TAIL_PX = 8;
const TRADE_WORLD_SLOTS = 6;
const TRADE_FLOW_FAMILIES = 3;

// The port's freighters (trade.35). The second craft class is the network's
// own hull — the thing that actually carries the trade — and it is the one
// ship class *every* colony has, however few worlds its system was given (the
// generator's planet chain makes most systems one-world, so a fleet drawn only
// from intra-system legs is a fleet almost nobody ever sees). Hulls come from
// trade.js's `portFleet` records, so the drawing and the readout read the same
// voyage the network booked:
//
//   docked   a tick beside the port's world (orrery) or its low-orbit node
//            (the graph) — the hull is on the pad, waiting or loading;
//   out/in   a triangle on the escape row, at the fraction of the voyage it
//            has flown. That fraction is the voyage's own clock, not a
//            distance: the rail is the way out of the system, so the marker
//            says "how far into the voyage", and the readout prints
//            `voyage 34 %` so it cannot be read as a celestial position.
const HULL_FILL = 'rgba(130, 195, 255, 0.95)';
const HULL_STROKE = 'rgba(214, 238, 255, 0.95)';
const HULL_TAIL = 'rgba(130, 195, 255, 0.26)';
const HULL_PX = 3.0;
const HULL_TAIL_PX = 9;
const HULL_SELECT_PAD_PX = 3;
// The craft under the cursor/selection. The layer owns the ids; trade.js writes
// the same three voyage ids (`VOYAGE_*`) into the records it hands over.
const CRAFT_NONE = -1, CRAFT_FERRY = 0, CRAFT_HULL = 1;
const VOYAGE_DOCKED = 0, VOYAGE_OUT = 1, VOYAGE_IN = 2;
// 12 ferry seats + 12 hull slots per port: the fixed arrays below cover both.
const CRAFT_MAX = 24;

const TAU = Math.PI * 2;
const HALF_PI = Math.PI / 2;
const DEG = Math.PI / 180;

// --- Layout (plan §6.1) ------------------------------------------------------
const R_STAR_PX = 34;                 // the star icon's reserved centre
const R_EDGE_FRAC = 0.46;             // R_EDGE_PX = min(w, h)·0.46
const A_IN_VIEW_K = 0.6;              // a_in_view  = max(a_0·0.6, …)
const A_IN_VIEW_MIN_AU = 0.008;       // … and never tighter than this
const A_OUT_VIEW_K = 1.2;             // a_out_view = max(a_out·1.2, …)
const BELT_VIEW_K = 1.1;              // … outermost belt · 1.1)

// --- Colours and fonts (plan §6.2) -------------------------------------------
const HZ_FILL = 'rgba(96, 200, 128, 0.07)';
const HZ_EDGE = 'rgba(96, 200, 128, 0.25)';
const ORBIT_STROKE = 'rgba(150, 175, 215, 0.22)';
const BELT_FILL = 'rgba(190, 180, 160, 0.35)';
const STAR_HALO_ALPHA = 0.18;         // the class colour at 2× the star radius
const GIANT_RING_STROKE = 'rgba(220, 210, 190, 0.45)';
const LOCKED_SHADE = 'rgba(4, 6, 12, 0.55)';
const TERRAN_OUTLINE = 'rgba(96, 200, 128, 0.9)';
const SELECT_RING_PAD_PX = 4;         // the selected body: radius + 4 px
const BELT_DOT_PX = 1.5;              // a ~1 px-radius dot as one fillRect
const GIANT_RING_K = 1.7;             // a giant's ring at 1.7× its icon radius

// --- Icon size ramp (plan §6.2 item 5): five buckets keyed on log mass -------
// Not real radius — a 3000 M⊕ giant and a 300 M⊕ giant would be near-identical
// dots at true scale, and the brief asks for readable icons.
const ICON_MASS_EDGES = [0.1, 2, 20, 100];      // M⊕, upper bounds
const ICON_RADII_PX = [3, 5, 7, 10, 13];

// The star icon's radius by evolutionary state (plan §6.2 item 4).
const STAR_RADIUS_PX = { ms: 12, giant: 20, wd: 6 };

// --- Picking (plan §6.3) ------------------------------------------------------
const PICK_PAD_PX = 4;                // bodies: iconRadius + 4 px, nearest wins
const BELT_PICK_PX = 6;               // belts: |r_click − r_belt| < 6 px

// --- System time (plan §6.4): the view's own clock, on a geometric ladder ----
// The 0.5.5 range (−1 … 99, step 0.5) was a strobe at its slow end: the ship
// spends a whole Hohmann transfer in ~0.4 y and a launch in ~1e-4 y, so the
// slowest stop has to sit five decades below the old minimum to show the ship
// moving at all. The ladder is the control — every stop is a deliberate rate,
// and −1 (follow the camera) and 0 (frozen) ride at the bottom, ahead of the
// slowest timed stop.
const SYSTIME_LADDER = [-1, 0, 1e-4, 2e-4, 5e-4, 1e-3, 2e-3, 5e-3,
	0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100];
const SYSTIME_INDEX_MIN = 0;
const SYSTIME_INDEX_MAX = SYSTIME_LADDER.length - 1;
const SYSTIME_INDEX_DEFAULT = 1;      // frozen
const SYSTIME_MIN = -1;               // −1 couples to the camera fly speed
const SYSTIME_MAX = 100;              // years per second
const SYSTIME_DEFAULT = 0;            // frozen

// --- The open view (plan §6.5, §7.5) -----------------------------------------
// One view is open at a time on the one canvas: the orrery, two delta-v graph
// renders, or a flight-time render. The latter gives average freight legs
// dedicated tracks whose lengths are proportional to their Hohmann durations.
const VIEW_SYSTEM = 0;
const VIEW_DV_CLASSIC = 1;
const VIEW_DV_RAILS = 2;
const VIEW_DV_TIME = 3;
const VIEW_COUNT = 4;
const VIEW_DEFAULT = VIEW_SYSTEM;
const VIEW_NAMES = ['system', 'delta-v classic', 'delta-v rails', 'delta-v flight time'];

// --- Delta-v map (plan §7): budget slider + ship ------------------------------
const BUDGET_MIN = 0, BUDGET_MAX = 1, BUDGET_STEP = 0.01, BUDGET_DEFAULT = 0.35;

// Delta-v graph drawing constants (plan §7.5). Both renders share the column
// width and the row pitch; they differ in how a node's row is chosen and in
// what is drawn between the columns.
const DV_COL_X0 = 90;                // left margin of the graph
const DV_COL_W = 160;                // spacing between body columns
const DV_COL_TOP = 82;               // top of the graph
const DV_NODE_DY = 44;               // vertical gap between rows
const DV_NODE_R = 5;
// The time view gives each average intra-system route its own lane. All lanes
// share one linear scale: a line twice as long represents twice the one-way
// Hohmann time, and the ferries move at constant speed along it.
const DV_TIME_WIDTH = 960;
const DV_TIME_TRACK_X = 245;
const DV_TIME_TRACK_MAX = 650;
const DV_TIME_LANE_Y = 142;
const DV_TIME_LANE_DY = 70;
const DV_TIME_EMPTY_LANES = 1;
const DV_EDGE_STROKE = 'rgba(150, 200, 240, 0.55)';
const DV_NODE_FILL = 'rgba(150, 200, 240, 0.85)';
const DV_NODE_FILL_SURF = 'rgba(150, 180, 150, 0.85)';
const DV_NODE_STAR_FILL = 'rgba(255, 240, 180, 0.9)';
const DV_TEXT_FILL = 'rgba(220, 230, 240, 0.85)';
const DV_LABEL_FONT = '11px Menlo, Consolas, monospace';
const DV_HEADER_FONT = '12px Menlo, Consolas, monospace';
// Rails render (0.5.6): the escape and L5 rails are the two ways out of a
// system, so they get their own colours — the classic Hohmann rail warm, the
// L5 drift rail cool and dashed.
const DV_RAIL_EDGE = 'rgba(240, 200, 140, 0.55)';
const DV_RAIL_L5 = 'rgba(140, 220, 235, 0.5)';
const DV_RAIL_LABEL = 'rgba(240, 210, 160, 0.9)';
const DV_RAIL_L5_LABEL = 'rgba(160, 225, 240, 0.9)';
// The star rail: the last segment of the escape row, from the innermost
// column to the star node. It is the line an interstellar voyage rides.
const DV_RAIL_EXIT = 'rgba(240, 200, 140, 0.35)';
const DV_INNER_STROKE = 'rgba(150, 175, 215, 0.35)';
const DV_ROW_CAPTION = 'rgba(150, 170, 195, 0.75)';
const DV_PANEL_FILL = 'rgba(3, 8, 16, 0.94)';
const DV_SELECT_COL = 'rgba(150, 200, 240, 0.07)';
const DV_TABLE_TOP = 320;            // first table row, below the graph

// Body kinds for picking, selection and hover.
const BODY_NONE = -1, BODY_STAR = 0, BODY_PLANET = 1, BODY_BELT = 2;

// The planet display types' icon fills, built once at load from the one table
// the record, the search and the schematic all read (plan §4.2).
const TYPE_FILLS = (function () {
	const fills = [];
	for (const t of layerPlanets.DISPLAY_TYPES) {
		fills.push('rgb(' + t.color[0] + ', ' + t.color[1] + ', ' + t.color[2] + ')');
	}
	return fills;
})();

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

// The view's inner bound (plan §6.1): the disc's own inner edge pulled in by
// 0.6 so the innermost orbit never sits on the star icon, with a floor that
// keeps a white dwarf's compact system zoomed to something readable.
function viewInnerAU(rStar) {
	const edge = layerPlanets.innerEdgeAU(rStar) * A_IN_VIEW_K;
	return edge > A_IN_VIEW_MIN_AU ? edge : A_IN_VIEW_MIN_AU;
}

// The view's outer bound: the disc edge with headroom, or the outermost belt
// with its own headroom when the belt reaches past the disc's 1.2×.
function viewOuterAU(aOut, outerBeltAU) {
	const disc = aOut * A_OUT_VIEW_K;
	const belt = outerBeltAU * BELT_VIEW_K;
	return belt > disc ? belt : disc;
}

// The five-bucket icon ramp (plan §6.2 item 5).
function iconRadiusForMass(massEarth) {
	for (let i = 0; i < ICON_MASS_EDGES.length; i++) {
		if (massEarth < ICON_MASS_EDGES[i]) return ICON_RADII_PX[i];
	}
	return ICON_RADII_PX[ICON_RADII_PX.length - 1];
}

function starRadiusForState(state) {
	const r = STAR_RADIUS_PX[state];
	return r === undefined ? STAR_RADIUS_PX.ms : r;
}

// The system-time slider's readout. Above a hundredth of a year per second the
// rate reads as y/s; below that it reads in the unit that is legible for it
// (a stop of 1e-4 y/s moves 0.9 h of system time per second).
function formatSysTimeRate(rate) {
	if (rate < 0) return 'follow \u00d7' + (-rate).toFixed(1);
	if (rate === 0) return '0 y/s';
	if (rate >= 1) return rate + ' y/s';
	if (rate >= 0.01) return rate.toFixed(3) + ' y/s';
	const daysPerSec = rate * 365.25;
	if (daysPerSec >= 1) return daysPerSec.toFixed(1) + ' d/s';
	return (daysPerSec * 24).toFixed(1) + ' h/s';
}

// The rate at a ladder stop, and the stop nearest a rate. The slider speaks
// indices — what the stops are is this file's business, not the DOM's.
function sysTimeRateAt(index) {
	if (!Number.isFinite(index)) return SYSTIME_LADDER[SYSTIME_INDEX_DEFAULT];
	const i = Math.round(index);
	return SYSTIME_LADDER[i < SYSTIME_INDEX_MIN ? SYSTIME_INDEX_MIN : i > SYSTIME_INDEX_MAX ? SYSTIME_INDEX_MAX : i];
}

function sysTimeIndexOf(rate) {
	let best = SYSTIME_INDEX_DEFAULT;
	let bestGap = Infinity;
	for (let i = 0; i < SYSTIME_LADDER.length; i++) {
		const gap = Math.abs(SYSTIME_LADDER[i] - rate);
		if (gap < bestGap) { bestGap = gap; best = i; }
	}
	return best;
}

// The §6.6 readout's number formats. Each is the column the worked example
// prints, so the block stays checkable against the plan.
function fmtS(s) {
	if (s >= 10) return s.toFixed(1);
	if (s >= 0.1) return s.toFixed(2);
	return s.toFixed(3);
}
function fmtAxis(a) {
	return a >= 10 ? String(Math.round(a)) : a.toFixed(2);
}
function fmtExp(x) {
	// '3.1e-3' / '9.4e20' — JS writes '9.4e+20', the example does not.
	return x.toExponential(1).replace('e+', 'e');
}
function fmtMoons(moons) {
	return moons === 1 ? '1 moon' : moons + ' moons';
}

function createSystemLayer(canvas) {
	const ctx = canvas.getContext('2d');
	const planets = layerPlanets;
	const records = layerRecords;
	// The view owns exactly one record (plan §4.9: caller-owned, and 0.5.3 is
	// the one caller): regenerated on enter, read per draw, never shared.
	const record = planets.createSystemRecord();

	let open = false;
	let tradePort = null, tradeWorlds = null, tradeFleet = null;
	const tradeWorldLabels = [];
	const tradeFromXY = new Float64Array(2);
	const tradeToXY = new Float64Array(2);

	// The ships drawn last frame, in the space that frame used (`craftSpace`:
	// 0 = screen pixels in the orrery, 1 = the delta-v graph's own units), so a
	// click can hit-test exactly what was drawn — the same rule the bodies
	// follow. Fixed arrays: a frame allocates nothing, and the ferry seats and
	// hull slots are the two fixed ranges `registerCraft` writes.
	const craftXY = new Float32Array(CRAFT_MAX * 2);
	const craftKindOf = new Int8Array(CRAFT_MAX);
	const craftSlotOf = new Int8Array(CRAFT_MAX);
	const craftLegOf = new Int16Array(CRAFT_MAX);
	let craftSpace = 0;
	let craftKind = CRAFT_NONE, craftLeg = -1, craftSlot = -1;
	let hoverCraftKind = CRAFT_NONE, hoverCraftLeg = -1, hoverCraftSlot = -1, hoverCraftLabel = '';
	const hitCraft = { kind: CRAFT_NONE, leg: -1, slot: -1 };

	// --- Layout scalars, written by prepare() -------------------------------
	let lnIn = 0;
	let lnSpan = 1;
	// The per-draw frame, written by draw() and read by pick(): the schematic
	// is screen-space, so picking needs the same centre the draw used.
	const layout = { cx: 0, cy: 0, rEdge: 0, rSpan: 0, aIn: 0, aOut: 0 };

	// --- Per-planet precompute (open-time, never per frame) ------------------
	const planetRho = new Float64Array(planets.MAX_PLANETS);
	const planetCosPeri = new Float64Array(planets.MAX_PLANETS);
	const planetSinPeri = new Float64Array(planets.MAX_PLANETS);
	const planetSquash = new Float64Array(planets.MAX_PLANETS);   // sqrt(1−e²)·cos i
	const planetIconR = new Float32Array(planets.MAX_PLANETS);
	const planetScreenXY = new Float32Array(planets.MAX_PLANETS * 2);

	// --- Belt stipples (plan §6.2 item 3): hashed ONCE per opened system -----
	const beltAngles = new Float32Array(planets.MAX_BELTS * planets.STIPPLE_N);
	const beltRadii = new Float32Array(planets.MAX_BELTS * planets.STIPPLE_N);
	const beltRho = new Float32Array(planets.MAX_BELTS * planets.STIPPLE_N);
	const beltStippleXY = new Float32Array(planets.MAX_BELTS * planets.STIPPLE_N * 2);
	const beltPeriod = new Float64Array(planets.MAX_BELTS);       // Kepler years at the centre
	const beltRhoC = new Float64Array(planets.MAX_BELTS);         // centre ρ: picking + the ring
	// fillStipple writes STIPPLE_N entries from index 0, so each belt owns a
	// fixed subarray view — built once here, so an open allocates nothing.
	const beltAngleViews = [];
	const beltRadiusViews = [];
	for (let k = 0; k < planets.MAX_BELTS; k++) {
		beltAngleViews.push(beltAngles.subarray(k * planets.STIPPLE_N, (k + 1) * planets.STIPPLE_N));
		beltRadiusViews.push(beltRadii.subarray(k * planets.STIPPLE_N, (k + 1) * planets.STIPPLE_N));
	}

	// --- Delta-v map (plan §7): per-body nodes and one-body edges, plus the
	// inter-body Hohmann chain. Allocated once; filled when the system opens.
	const dvN = layerDv.MAX_BODIES;
	const dvBodies = [];
	const dvNodes = [];
	const dvOneEdges = [];
	for (let di = 0; di < dvN; di++) {
		dvBodies.push(layerDv.createBodyParam());
		dvNodes.push(layerDv.createNodeSet());
		dvOneEdges.push(layerDv.createOneBodyEdges());
	}
	// Inter edges: N·(N−1) directional legs.
	const dvInterEdges = [];
	for (let di = 0; di < dvN * (dvN - 1); di++) dvInterEdges.push(layerDv.createInterEdge());
	let dvNBodies = 0;
	// Order permutation: dvOrder[i] = original body index for column (i+1).
	const dvOrder = new Int16Array(dvN);
	let view = VIEW_DEFAULT;
	let dvBudget = BUDGET_DEFAULT;
	let dvShipClass = 'chemical';
	let dvMuStarVal = 0;     // set per open from record.star.mass (buildDv)

	const activeRoute = layerRoute.createRoute();
	const alternativeRoute = layerRoute.createRoute();
	const routeFeasibility = [];
	let routeStart = null, routeEnd = null, routeTwoWay = false;
	let flightRunning = false, flightStarted = false, flightElapsed = 0;
	const routeXY = new Float64Array(2);
	const routeScreen = new Float64Array(2);
	const routeDash = [4, 5];
	const noDash = [];
	function endpointOf(bi, node) {
		const ns = dvNodes[bi];
		// `bodyIndex` is what the map's route trace needs (plan §7.5): the graph
		// column a leg's endpoint sits in. A stellar endpoint (main.js's
		// selected-star route) simply has none, and such a route is readout-only.
		return { body: dvBodies[bi], bodyIndex: bi, node, muStar: dvMuStarVal, phase: ns.kind === 0 ? record.planets.phase[ns.index] + record.planets.peri[ns.index] : 0,
			systemKey: record.star.key, label: ns.letter, x: 0, y: 0, z: 0 };
	}
	function rebuildRoute() {
		flightRunning = false; flightStarted = false; flightElapsed = 0;
		layerRoute.buildRoute(routeStart, routeEnd, dvShipClass, dvBudget, activeRoute, routeTwoWay, timeYears);
		routeFeasibility.length = 0;
		if (!routeStart || !routeEnd) return;
		for (const ship of layerDv.SHIP_CLASSES) {
			layerRoute.buildRoute(routeStart, routeEnd, ship.id, dvBudget, alternativeRoute, routeTwoWay, timeYears);
			routeFeasibility.push('  ' + ship.label + ': ' + (alternativeRoute.feasible ? 'feasible' : alternativeRoute.reason)
				+ ' · ' + layerDv.formatDuration(alternativeRoute.totalYears * layerDv.SECONDS_PER_YEAR));
		}
	}
	function chooseRouteNode(bi, node) {
		if (bi < 0 || bi >= dvNBodies || !nodeExists(bi, node)) return false;
		if (!routeStart || routeEnd) { routeStart = endpointOf(bi, node); routeEnd = null; }
		else routeEnd = endpointOf(bi, node);
		const ns = dvNodes[bi];
		setSelected(ns.kind === 0 ? BODY_PLANET : BODY_BELT, ns.index);
		rebuildRoute();
		return true;
	}
	function planExternalRoute(start, end) { routeStart = start; routeEnd = end; rebuildRoute(); return activeRoute; }
	function clearRoute() { routeStart = null; routeEnd = null; rebuildRoute(); }
	function setRoundTrip(on) { routeTwoWay = !!on; rebuildRoute(); }
	function toggleAutopilot() {
		if (flightRunning) { flightRunning = false; return false; }
		if (!flightStarted || flightElapsed >= activeRoute.totalYears) rebuildRoute();
		if (!activeRoute.feasible) return false;
		flightRunning = true; flightStarted = true;
		return true;
	}
	function routeState() { return activeRoute; }
	function autopilotRunning() { return flightRunning; }
	function autopilotState() {
		if (!routeStart || !routeEnd) return 'empty';
		if (!activeRoute.feasible) return 'infeasible';
		if (flightRunning) return 'running';
		if (!flightStarted) return 'ready';
		return flightElapsed >= activeRoute.totalYears ? 'complete' : 'paused';
	}
	function projectRoutePoint(out, point) {
		const r = Math.hypot(point[0], point[1]);
		const scale = r > 0 ? radiusPx(clamp01(rhoOf(r / layerDv.AU_M))) / r : 0;
		out[0] = layout.cx + point[0] * scale; out[1] = layout.cy + point[1] * scale;
	}
	function drawRoute() {
		if (!activeRoute.count || !Number.isFinite(activeRoute.totalYears) || activeRoute.start.systemKey !== activeRoute.end.systemKey) return;
		ctx.strokeStyle = activeRoute.ship.color; ctx.lineWidth = 1; ctx.setLineDash(routeDash);
		for (let li = 0; li < activeRoute.count; li++) {
			const leg = activeRoute.legs[li];
			if (leg.kind !== 'transfer') continue;
			ctx.beginPath();
			for (let s = 0; s <= 48; s++) {
				layerRoute.routePosition(routeXY, activeRoute, leg.start + (leg.end - leg.start) * s / 48);
				projectRoutePoint(routeScreen, routeXY);
				if (!s) ctx.moveTo(routeScreen[0], routeScreen[1]); else ctx.lineTo(routeScreen[0], routeScreen[1]);
			}
			ctx.stroke();
		}
		ctx.setLineDash(noDash);
		layerRoute.routePosition(routeXY, activeRoute, flightElapsed);
		projectRoutePoint(routeScreen, routeXY);
		ctx.fillStyle = activeRoute.ship.color;
		ctx.beginPath(); ctx.moveTo(routeScreen[0] + 6, routeScreen[1]);
		ctx.lineTo(routeScreen[0] - 4, routeScreen[1] - 4); ctx.lineTo(routeScreen[0] - 4, routeScreen[1] + 4); ctx.closePath(); ctx.fill();
	}

	// --- Star icon + designation caches (open-time) --------------------------
	let starRadiusPx = STAR_RADIUS_PX.ms;
	let starFill = 'rgb(255, 255, 255)';
	let starHalo = 'rgba(255, 255, 255, ' + STAR_HALO_ALPHA + ')';
	let starPrefix = '';        // the landmark name, or S<key36> (plan §4.11)

	// --- The view's own clock (plan §6.4) ------------------------------------
	let timeRate = SYSTIME_DEFAULT;
	let timeYears = 0;

	// --- Interaction state ----------------------------------------------------
	let selectedKind = BODY_NONE, selectedIndex = -1;
	let hoverKind = BODY_NONE, hoverIndex = -1;
	let hoverLabel = '';        // rebuilt on hover CHANGE only (plan §4.11)
	let hoverX = 0, hoverY = 0;
	const hitOut = { kind: BODY_NONE, index: -1 };

	// ρ(a) under the current view bounds (plan §6.1) — unclamped, so a stipple
	// dot may ride slightly past the rim; drawn bodies clamp where the plan
	// asks for containment.
	function rhoOf(a) {
		return (Math.log(a) - lnIn) / lnSpan;
	}
	function radiusPx(rho) {
		return R_STAR_PX + rho * layout.rSpan;
	}

	// Decode the record's name bytes once per open.
	function decodeName(star) {
		if (star.nameLen <= 0) return 'S' + (star.key >>> 0).toString(36).toUpperCase();
		let text = '';
		for (let i = 0; i < star.nameLen; i++) text += String.fromCharCode(star.name[i]);
		return text;
	}

	// Adopt the record's current contents: view bounds, per-planet layout, the
	// one-off stipple hash, icon caches. enter() runs it after generateSystem;
	// a caller that filled `record` itself (the test, a future dv-map refresh)
	// runs it directly.
	function prepare() {
		const star = record.star;
		const belts = record.belts;
		const outerBelt = belts.count > 0 ? belts.a[belts.count - 1] : 0;
		const aIn = viewInnerAU(star.rStar);
		const aOut = viewOuterAU(star.aOut, outerBelt);
		lnIn = Math.log(aIn);
		lnSpan = Math.log(aOut) - lnIn;
		// A crossed-edge remnant (a_0 ≥ a_out, plan §4.5) has no disc and no
		// bodies to map; the span still must not divide by zero.
		if (!(lnSpan > 1e-9)) lnSpan = 1;
		layout.aIn = aIn;
		layout.aOut = aOut;

		const p = record.planets;
		const n = record.counts.planets;
		for (let i = 0; i < n; i++) {
			planetRho[i] = rhoOf(p.a[i]);
			planetCosPeri[i] = Math.cos(p.peri[i]);
			planetSinPeri[i] = Math.sin(p.peri[i]);
			const e = p.e[i];
			const ee = 1 - e * e;
			planetSquash[i] = Math.sqrt(ee > 0 ? ee : 0) * Math.cos(p.inc[i] * DEG);
			planetIconR[i] = iconRadiusForMass(p.mass[i]);
		}

		for (let k = 0; k < belts.count; k++) {
			const a = belts.a[k];
			// The stipple law is the record's own (plan §4.7): hashed here once,
			// mapped per frame — never re-hashed per frame.
			planets.fillStipple(belts.stippleSeed[k], a, belts.dlnA[k],
				beltAngleViews[k], beltRadiusViews[k]);
			beltPeriod[k] = Math.sqrt(a * a * a / star.mass);
			beltRhoC[k] = rhoOf(a);
			const base = k * planets.STIPPLE_N;
			for (let s = 0; s < planets.STIPPLE_N; s++) beltRho[base + s] = rhoOf(beltRadii[base + s]);
		}

		starRadiusPx = starRadiusForState(star.state);
		const c = records.CLASS_COLORS[star.colorIndex < records.CLASS_COLORS.length
			? star.colorIndex : records.DEFAULT_CLASS_INDEX];
		starFill = 'rgb(' + c[0] + ', ' + c[1] + ', ' + c[2] + ')';
		starHalo = 'rgba(' + c[0] + ', ' + c[1] + ', ' + c[2] + ', ' + STAR_HALO_ALPHA + ')';
		starPrefix = decodeName(star);

		timeYears = 0;
		mapLayout.valid = false;
		clearRoute();
		selectedKind = BODY_NONE; selectedIndex = -1;
		hoverKind = BODY_NONE;
		hoverIndex = -1;
		hoverLabel = '';
		open = true;
		tradePort = null; tradeWorlds = null;
		// Delta-v tables are rebuilt on prepare; they depend on the record, so
		// every open refreshes them regardless of the dirty flag.
		buildDv();
		return record;
	}

	// Build the delta-v tables (plan §7). Called on every enter, and again
	// on system changes. Budget / ship changes refresh only display text.
	function buildDv() {
		// muStar = G·M★ with M★ in kg (record.star.mass is in M☉).
		const muStarLoc = layerDv.G_SI * record.star.mass * layerDv.M_SUN_KG;
		// Overwrite the module-level placeholder: one live value, one system.
		dvMuStarVal = muStarLoc;
		dvNBodies = layerDv.buildBodyNodes(record, dvBodies, dvNodes, dvOneEdges);
		// Order columns by semi-major axis (bodies arrive in record order
		// which is already sorted by a; belts follow planets. We build an
		// explicit a-sorted permutation so a future planet sort mismatch
		// cannot silently mis-graph the map).
		for (let i = 0; i < dvNBodies; i++) dvOrder[i] = i;
		// Simple insertion sort — N ≤ MAX_PLANETS+MAX_BELTS = 14.
		for (let i = 1; i < dvNBodies; i++) {
			const k = dvOrder[i];
			let j = i - 1;
			while (j >= 0 && dvBodies[dvOrder[j]].aM > dvBodies[k].aM) {
				dvOrder[j + 1] = dvOrder[j];
				j--;
			}
			dvOrder[j + 1] = k;
		}
		// Compute inter edges for every ordered body pair (i → j). Indexed via
		// interEdgeIndex(nBodies, i, j) so lookups can use body indices
		// directly without going through the column permutation.
		for (let i = 0; i < dvNBodies; i++) {
			for (let j = 0; j < dvNBodies; j++) {
				if (i === j) continue;
				const eIdx = layerDv.interEdgeIndex(dvNBodies, i, j);
				const edge = dvInterEdges[eIdx];
				edge.i = i; edge.j = j;
				layerDv.legLoToLo(muStarLoc, dvBodies[i], dvBodies[j], false, edge);
			}
		}
		cacheMapLabels();
	}

	// Enter (plan §6.5): generate the system (plan §4.9) and adopt it. The
	// camera half of the enter is main.js's — this layer owns no camera.
	function enter(ref, genCtx) {
		planets.generateSystem(ref, genCtx, record);
		return prepare();
	}

	// Exit: the canvas keeps its last frame, so hiding it must erase it — the
	// rule label-layer's setEnabled follows.
	function exit() {
		if (!open) return;
		open = false;
		tradePort = null; tradeWorlds = null; tradeFleet = null;
		clearCraft();
		clearRoute();
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		selectedKind = BODY_NONE;
		selectedIndex = -1;
		hoverKind = BODY_NONE;
		hoverIndex = -1;
		hoverLabel = '';
		hoverCraftKind = CRAFT_NONE; hoverCraftLeg = -1; hoverCraftSlot = -1; hoverCraftLabel = '';
	}

	function isOpen() { return open; }

	function setTradeData(port, worlds, fleet) {
		if (!open || !port || !worlds || !port.intraFlow
			|| (port.key >>> 0) !== (record.star.key >>> 0)) {
			tradePort = null; tradeWorlds = null; tradeFleet = null;
			clearCraft();
			return false;
		}
		tradePort = port;
		tradeWorlds = worlds;
		const prefix = starPrefix + ' ';
		for (let s = 0; s < port.worldCount; s++) {
			const world = worlds[port.worldIdx[s]];
			const name = world && world.name ? world.name : '?';
			tradeWorldLabels[s] = name.startsWith(prefix) ? name.slice(prefix.length) : name;
		}
		// The fleet is only as good as the port it names: a live record from
		// another star is stale the moment the view moves.
		tradeFleet = fleet && (fleet.key >>> 0) === (port.key >>> 0) && fleet.count > 0
			? fleet : null;
		if (!tradeFleet && craftKind === CRAFT_HULL) clearCraft();
		return true;
	}

	// --- The craft layer (trade.35) ------------------------------------------
	// Every boat and hull the frame draws registers its position, so picking is
	// the draw's own arithmetic rather than a second guess at it.
	function registerCraft(idx, kind, leg, slot, x, y) {
		if (!(idx >= 0 && idx < CRAFT_MAX)) return;
		craftKindOf[idx] = kind;
		craftLegOf[idx] = leg;
		craftSlotOf[idx] = slot;
		craftXY[idx * 2] = x;
		craftXY[idx * 2 + 1] = y;
	}
	function beginCraftFrame(space) {
		craftKindOf.fill(CRAFT_NONE);
		craftSpace = space ? 1 : 0;
	}
	function craftSelected(kind, leg, slot) {
		return craftKind !== CRAFT_NONE && craftKind === kind
			&& craftLeg === leg && craftSlot === slot;
	}
	function craftHovered(kind, leg, slot) {
		return hoverCraftKind !== CRAFT_NONE && hoverCraftKind === kind
			&& hoverCraftLeg === leg && hoverCraftSlot === slot;
	}
	// The craft's hover label, drawn in whatever space its own draw used: the
	// orrery is screen pixels and the graph is its own units, so the text is in
	// the same transform as the tick it names.
	function drawCraftLabel(x, y, text) {
		if (!text) return;
		ctx.font = layerLabels.LABEL_FONT;
		ctx.lineWidth = 3;
		ctx.strokeStyle = layerLabels.LABEL_HALO;
		ctx.strokeText(text, x + layerLabels.LABEL_OFFSET_PX, y - layerLabels.LABEL_OFFSET_PX);
		ctx.fillStyle = layerLabels.LABEL_FILL;
		ctx.fillText(text, x + layerLabels.LABEL_OFFSET_PX, y - layerLabels.LABEL_OFFSET_PX);
	}
	function selectCraft(kind, leg, slot) {
		craftKind = kind === CRAFT_FERRY || kind === CRAFT_HULL ? kind : CRAFT_NONE;
		craftLeg = craftKind === CRAFT_NONE ? -1 : (leg | 0);
		craftSlot = craftKind === CRAFT_NONE ? -1 : (slot | 0);
		return craftKind;
	}
	function clearCraft() { craftKind = CRAFT_NONE; craftLeg = -1; craftSlot = -1; }
	function selectedCraft(out) {
		out.kind = craftKind; out.leg = craftLeg; out.slot = craftSlot;
		return out;
	}
	// The craft the click is on, in screen space. The graph draws through a
	// translate+scale, so the click is mapped back into the space the boats were
	// registered in before the distance test — no floating-point mismatch.
	// `outXY` (optional, 2 floats) receives the drawn position of the craft that
	// won, in the frame's own space — the same numbers the draw used, so a
	// caller can tell where a boat is without guessing at it.
	function pickCraft(x, y, out, outXY) {
		out.kind = CRAFT_NONE; out.leg = -1; out.slot = -1;
		if (outXY) { outXY[0] = 0; outXY[1] = 0; }
		if (!open) return out;
		const scale = craftSpace && mapLayout.valid && mapLayout.scale > 0 ? mapLayout.scale : 1;
		const lx = craftSpace ? (x - mapLayout.x) / scale : x;
		const ly = craftSpace ? (y - mapLayout.y) / scale : y;
		const pad = (INTRA_FERRY_PX + PICK_PAD_PX) / (craftSpace ? scale : 1);
		let best = pad * pad;
		for (let i = 0; i < CRAFT_MAX; i++) {
			if (craftKindOf[i] === CRAFT_NONE) continue;
			const dx = lx - craftXY[i * 2];
			const dy = ly - craftXY[i * 2 + 1];
			const d2 = dx * dx + dy * dy;
			if (d2 > best) continue;
			best = d2;
			out.kind = craftKindOf[i];
			out.leg = craftLegOf[i];
			out.slot = craftSlotOf[i];
			if (outXY) { outXY[0] = craftXY[i * 2]; outXY[1] = craftXY[i * 2 + 1]; }
		}
		return out;
	}
	function craftLabelAt(kind, leg, slot) {
		const worldName = (s) => {
			if (!(tradePort && tradePort.worldCount) || !tradeWorlds) return '';
			if (!(s >= 0 && s < tradePort.worldCount)) return '';
			const w = tradeWorlds[tradePort.worldIdx[s]];
			return w && w.name ? w.name : '';
		};
		if (kind === CRAFT_FERRY) {
			const intra = tradePort && tradePort.intra;
			if (!intra || !(leg >= 0 && leg < intra.legCount)) return 'ferry \u00b7 in port';
			const l = intra.legs[leg];
			return 'ferry \u00b7 ' + worldName(l.from) + ' \u2192 ' + worldName(l.to);
		}
		if (kind === CRAFT_HULL && tradeFleet && slot >= 0 && slot < tradeFleet.count) {
			const v = tradeFleet.voyages[slot];
			if (v.dir === VOYAGE_DOCKED) return v.hullName + ' \u00b7 in port';
			return v.hullName + ' \u00b7 ' + (v.dir === VOYAGE_IN ? 'from ' : 'to ') + v.other
				+ ' \u00b7 voyage ' + Math.round(v.progress * 100) + ' %';
		}
		return '';
	}

	// --- The view's clock (plan §6.4) ----------------------------------------
	function setTimeRate(rate) {
		const r = Number(rate);
		if (!Number.isFinite(r)) { timeRate = SYSTIME_DEFAULT; return timeRate; }
		timeRate = r < SYSTIME_MIN ? SYSTIME_MIN : r > SYSTIME_MAX ? SYSTIME_MAX : r;
		return timeRate;
	}
	function getTimeRate() { return timeRate; }
	function sysTime() { return timeYears; }

	// −1 couples to the camera fly speed exactly the way the star-time slider
	// does (orbit.sliderValueToRate's law), in years per second. No epoch wrap:
	// the phases are angles modulo each body's own period, and f64 keeps them
	// precise for centuries of session time.
	function stepTime(dt, speedLyPerSec) {
		if (!open || !(dt > 0)) return;
		const speed = speedLyPerSec > 0 ? speedLyPerSec : 0;
		const rate = timeRate < 0 ? (-timeRate) * layerOrbit.FLIGHT_TIME_GAIN * speed : timeRate;
		const advance = rate * dt;
		timeYears += advance;
		if (flightRunning) {
			flightElapsed = Math.min(activeRoute.totalYears, flightElapsed + advance);
			if (flightElapsed >= activeRoute.totalYears) flightRunning = false;
		}
	}

	function resize(widthCss, heightCss, dpr) {
		const w = Math.max(1, Math.round(widthCss * dpr));
		const h = Math.max(1, Math.round(heightCss * dpr));
		if (canvas.width !== w || canvas.height !== h) {
			canvas.width = w;
			canvas.height = h;
		}
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.textBaseline = 'alphabetic';
		ctx.textAlign = 'left';
	}

	// --- Draw (plan §6.2, back to front; §7.5 for the dv map) ---------------
	// The map is fitted between the two panels: `leftInset` is the control
	// panel's width, `rightInset` the settings menu's, so neither covers it.
	function draw(width, height, rightInset, leftInset) {
		if (!open) return;                      // the only cost while closed
		ctx.clearRect(0, 0, width, height);
		// A frame's craft list is rebuilt from scratch: the positions are what
		// the click will hit-test, so a boat that stopped being drawn must stop
		// being clickable in the same frame.
		beginCraftFrame(0);
		if (!(width > 0) || !(height > 0)) return;
		if (view !== VIEW_SYSTEM) {
			drawDvMap(width, height, rightInset || 0, leftInset || 0);
			return;
		}
		// Centre in the free strip, not on the canvas: with the control panel
		// open, centring on the canvas would tuck the inner system behind it.
		// The disk never grows past the strip, so nothing hides under a panel.
		const x0 = leftInset || 0;
		const x1 = Math.max(x0 + 1, width - (rightInset || 0));
		layout.cx = x0 + (x1 - x0) * 0.5;
		layout.cy = height * 0.5;
		layout.rEdge = Math.min(x1 - x0, height) * R_EDGE_FRAC;
		layout.rSpan = layout.rEdge - R_STAR_PX;
		if (!(layout.rSpan > 0)) return;
		drawHabitableZone();
		drawOrbits();
		drawBelts();
		drawStar();
		drawPlanets();
		drawIntraRoutes();
		drawTradeWorlds();
		drawBodyMarks();
		drawRoute();
	}

	function tradeWorldPosition(slot, out) {
		if (!tradePort || !tradeWorlds || !(slot >= 0 && slot < tradePort.worldCount)) return false;
		const world = tradeWorlds[tradePort.worldIdx[slot]];
		if (!world) return false;
		if (world.kind === 0) {
			if (!(world.index >= 0 && world.index < record.counts.planets)) return false;
			out[0] = planetScreenXY[world.index * 2];
			out[1] = planetScreenXY[world.index * 2 + 1];
			return true;
		}
		if (!(world.index >= 0 && world.index < record.belts.count)) return false;
		const offset = world.index * planets.STIPPLE_N * 2;
		out[0] = beltStippleXY[offset];
		out[1] = beltStippleXY[offset + 1];
		return true;
	}

	// The standing flows (T5) and the fleet that flies them (trade.34). The
	// dashes are the *same three legs* `noteIntraLegs` recorded, drawn dim:
	// the dash is the average, the boats are its picture, and the two can never
	// disagree about which pair or which family is busy.
	//
	// The fleet draws whenever a port is attached — a one-world system has no
	// legs, and that is the *common* case (the generator's chain leaves most
	// systems with a single settleable world), so the old `worldCount < 2` gate
	// hid the fleet from every normal colony. A port with no transfer now shows
	// its boats in port, which is what the readout has been saying all along.
	function drawIntraRoutes() {
		if (!tradePort || !tradeWorlds || tradePort.key !== (record.star.key >>> 0)
			|| (tradePort.colony && tradePort.colony.outpost)) return;
		const intra = tradePort.intra;
		const legs = intra && intra.legCount > 0 ? intra.legCount : 0;
		if (legs > 0) {
			ctx.lineWidth = 1.1;
			ctx.lineCap = 'round';
			ctx.setLineDash(TRADE_INTRA_DASH);
			for (let i = 0; i < legs; i++) {
				const leg = intra.legs[i];
				const from = tradeWorlds[tradePort.worldIdx[leg.from]];
				const to = tradeWorlds[tradePort.worldIdx[leg.to]];
				if (!from || !to || from.outpost || to.outpost) continue;
				if (!tradeWorldPosition(leg.from, tradeFromXY) || !tradeWorldPosition(leg.to, tradeToXY)) continue;
				ctx.strokeStyle = TRADE_INTRA_STROKES[leg.family >= 0 ? leg.family : 0];
				ctx.beginPath();
				ctx.moveTo(tradeFromXY[0], tradeFromXY[1]);
				ctx.lineTo(tradeToXY[0], tradeToXY[1]);
				ctx.stroke();
			}
			ctx.setLineDash(TRADE_SOLID_DASH);
			ctx.lineWidth = 1;
			ctx.lineCap = 'butt';
		}
		drawIntraFleet();
		// The lane out of the system is drawn with the port, not with the
		// traffic: the layer's own promise is that a ship is always on a line,
		// and this is the line an interstellar voyage of this colony rides.
		drawHullLane();
		drawHullFleet();
	}

	// The departure lane: from the berth world out along the colony's own
	// outward direction — the escape asymptote every hull of this port flies.
	// Returns the drawn segment's far end in `hullLaneOut` (x, y).
	const hullLaneOut = new Float64Array(2);
	function drawHullLane() {
		if (!tradePort || !tradeWorlds || !(tradePort.worldCount > 0)) return false;
		if (!tradeWorldPosition(0, tradeFromXY)) return false;
		const cx = tradeFromXY[0], cy = tradeFromXY[1];
		let ux = cx - layout.cx, uy = cy - layout.cy;
		const len = Math.sqrt(ux * ux + uy * uy);
		if (len > 0) { ux /= len; uy /= len; } else { ux = 0; uy = -1; }
		hullLaneOut[0] = layout.cx + ux * layout.rEdge;
		hullLaneOut[1] = layout.cy + uy * layout.rEdge;
		ctx.strokeStyle = HULL_LANE;
		ctx.lineWidth = 1;
		ctx.setLineDash(HULL_LANE_DASH);
		ctx.beginPath();
		ctx.moveTo(cx, cy);
		ctx.lineTo(hullLaneOut[0], hullLaneOut[1]);
		ctx.stroke();
		ctx.setLineDash(TRADE_SOLID_DASH);
		return true;
	}

	// The fleet (trade.34): the settle's largest legs, each carrying its share of
	// the twelve ferries, flying a round trip on the system clock. The phase is
	// `timeYears / (2·legYears)` — a full out-and-back — offset per leg and per
	// boat so a leg reads as traffic rather than a single bead on a wire. A port
	// with no transfer this settle keeps its boats in port: docked ticks around
	// the world they load at, so an idle system does not look like an empty one.
	function drawIntraFleet() {
		if (!tradePort || !tradeWorlds) return;
		const intra = tradePort.intra;
		if (!intra || !(intra.legCount > 0)) { drawDockedFleet(); return; }
		let boat = 0;
		for (let i = 0; i < intra.legCount; i++) {
			const leg = intra.legs[i];
			const n = leg.ferries > 0 ? leg.ferries : 1;
			if (tradeWorldPosition(leg.from, tradeFromXY) && tradeWorldPosition(leg.to, tradeToXY)) {
				drawLegFleet(leg, i, boat, tradeFromXY[0], tradeFromXY[1], tradeToXY[0], tradeToXY[1]);
			}
			boat += n;
		}
	}

	// A boat's phase on its leg: a full out-and-back on the system clock — half
	// the period out, half back — offset per leg and per seat, so the same
	// twelve boats keep cycling while the flow stands and a leg reads as traffic
	// rather than a single bead on a wire. -1 when the leg has no time at all.
	function legPhase(leg, legIndex, seat) {
		const period = leg.legYears * 2;
		if (!(period > 0)) return -1;
		let phase = timeYears / period + legIndex * 0.21 + seat / INTRA_FERRY_SEATS;
		phase -= Math.floor(phase);
		return phase;
	}

	// The leg's boats on the orrery: the two worlds' drawn positions, straight
	// between, which is the dash `drawIntraRoutes` draws for the same pair.
	function drawLegFleet(leg, legIndex, firstBoat, x0, y0, x1, y1) {
		const n = leg.ferries > 0 ? leg.ferries : 1;
		const dx = x1 - x0, dy = y1 - y0;
		const span = Math.sqrt(dx * dx + dy * dy);
		if (!(span > 0)) return;
		const ux = dx / span, uy = dy / span;
		for (let k = 0; k < n; k++) {
			const seat = firstBoat + k;
			const phase = legPhase(leg, legIndex, seat);
			if (phase < 0) return;
			const out = phase < 0.5;
			const u = out ? phase * 2 : 2 - phase * 2;
			const dir = out ? 1 : -1;
			drawFerry(x0 + dx * u, y0 + dy * u, ux * dir, uy * dir, seat, legIndex);
		}
	}

	// --- The port's freighters (trade.35) ------------------------------------
	// The network's own hulls, drawn from the voyage record trade.js booked.
	// In the orrery the port's world is the berth: docked hulls ring it, and a
	// voyage runs along that world's own outward direction, from the world to
	// the edge of the disk (outbound) or the other way (inbound), at the
	// fraction of the voyage that has elapsed.
	function drawHullFleet() {
		if (!tradeFleet || !tradeFleet.count || !tradePort || !tradeWorlds) return;
		if (!drawHullLane()) return;
		const cx = tradeFromXY[0], cy = tradeFromXY[1];
		const edgeX = hullLaneOut[0], edgeY = hullLaneOut[1];
		let ux = edgeX - cx, uy = edgeY - cy;
		const len = Math.sqrt(ux * ux + uy * uy);
		if (len > 0) { ux /= len; uy /= len; } else { ux = 0; uy = -1; }
		let docked = 0;
		for (let i = 0; i < tradeFleet.count; i++) {
			const v = tradeFleet.voyages[i];
			if (!v || v.ship < 0) continue;
			if (v.dir === VOYAGE_DOCKED) {
				const a = (docked / 8) * TAU + 0.45;
				const rr = 18 + (docked % 2) * 4;
				drawHull(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr,
					Math.cos(a), Math.sin(a), i, CRAFT_HULL, -1, i);
				docked += 1;
				continue;
			}
			const u = v.progress < 0 ? 0 : v.progress > 1 ? 1 : v.progress;
			if (v.dir === VOYAGE_OUT) {
				drawHull(cx + (edgeX - cx) * u, cy + (edgeY - cy) * u, ux, uy, i, CRAFT_HULL, -1, i);
			} else {
				drawHull(edgeX + (cx - edgeX) * u, edgeY + (cy - edgeY) * u, -ux, -uy, i, CRAFT_HULL, -1, i);
			}
		}
	}

	// The same hulls on the two delta-v renders. A hull is an *interstellar*
	// voyage, so its line is the way out of the system: the berth's low orbit
	// up its well edge, along the rails to the innermost column, then the star
	// rail — every segment of it drawn by the render. The old code drew a chord
	// from the body straight to the star node, which is a line the map never
	// had; that was the "ships do not respect the schematic" report.
	function drawDvHullFleet() {
		if (!tradeFleet || !tradeFleet.count || !tradePort) return;
		const bi = tradeBodyIndex(0);
		if (bi < 0) return;
		const out = graphPathOut();
		if (!out) return;
		let docked = 0;
		for (let i = 0; i < tradeFleet.count; i++) {
			const v = tradeFleet.voyages[i];
			if (!v || v.ship < 0) continue;
			if (v.dir === VOYAGE_DOCKED) {
				dvNodeXYFor(bi, 1, dvTmpXY);
				const a = (docked / 8) * TAU + 0.45;
				const rr = 12 + (docked % 2) * 4;
				drawHull(dvTmpXY[0] + Math.cos(a) * rr, dvTmpXY[1] + Math.sin(a) * rr,
					Math.cos(a), Math.sin(a), i, CRAFT_HULL, -1, i);
				docked += 1;
				continue;
			}
			const u = v.progress < 0 ? 0 : v.progress > 1 ? 1 : v.progress;
			const outbound = v.dir === VOYAGE_OUT;
			if (!graphPointAt(outbound ? u : 1 - u)) continue;
			const dir = outbound ? 1 : -1;
			drawHull(graphHit[0], graphHit[1], graphHit[2] * dir, graphHit[3] * dir,
				i, CRAFT_HULL, -1, i);
		}
	}

	// The escape path out of the system, out of the port world's low orbit to
	// the star node. Shared by every hull of the berth, built once per draw.
	function graphPathOut() {
		const bi = tradeBodyIndex(0);
		if (bi < 0) return false;
		graphReset();
		graphWell(bi, 1, 3);
		graphRail(bi, dvOrder[0], 3);
		graphPushNode(-1, 3);
		return graphMeasure() > 0;
	}

	// One hull: a triangle pointing along its direction of travel, with a short
	// trail, filled in the ships' blue so a hull never reads as a ferry's amber.
	function drawHull(x, y, ux, uy, voyage, kind, leg, slot) {
		const px = -uy, py = ux;                        // across the heading
		if (ux !== 0 || uy !== 0) {
			ctx.strokeStyle = HULL_TAIL;
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.moveTo(x - ux * HULL_TAIL_PX, y - uy * HULL_TAIL_PX);
			ctx.lineTo(x, y);
			ctx.stroke();
		}
		ctx.beginPath();
		ctx.moveTo(x + ux * (HULL_PX + 2), y + uy * (HULL_PX + 2));
		ctx.lineTo(x - ux * HULL_PX + px * HULL_PX, y - uy * HULL_PX + py * HULL_PX);
		ctx.lineTo(x - ux * HULL_PX - px * HULL_PX, y - uy * HULL_PX - py * HULL_PX);
		ctx.closePath();
		ctx.fillStyle = HULL_FILL;
		ctx.fill();
		ctx.strokeStyle = HULL_STROKE;
		ctx.lineWidth = 1;
		ctx.stroke();
		if (craftSelected(kind, leg, slot)) {
			ctx.beginPath();
			ctx.arc(x, y, HULL_PX + HULL_SELECT_PAD_PX + 2.4, 0, TAU);
			ctx.strokeStyle = HULL_STROKE;
			ctx.lineWidth = 1.4;
			ctx.stroke();
		}
		if (craftHovered(kind, leg, slot)) drawCraftLabel(x, y, hoverCraftLabel);
		registerCraft(INTRA_FERRY_SEATS + (voyage % 12), kind, leg, slot, x, y);
	}

	// The fleet on the delta-v renders (V then B). A leg is <em>the route the
	// map draws</em> between its two worlds: out of the source's low orbit along
	// its well edge, along the rails through every column in between, and down
	// into the destination's low orbit. Building the polyline from the same
	// functions that draw those lines is the fix for the reported defect — the
	// boats used to fly a chord between two dots, over empty paper.
	//
	// A pair whose body is not in the graph is skipped, never guessed (the same
	// refusal the class gate makes). With no legs the fleet is at the port, and
	// the graph says so around the world's low-orbit node.
	function drawDvFleet() {
		if (!tradePort || (tradePort.colony && tradePort.colony.outpost)) return;
		const intra = tradePort.intra;
		if (intra && intra.legCount > 0) {
			let boat = 0;
			for (let i = 0; i < intra.legCount; i++) {
				const leg = intra.legs[i];
				const n = leg.ferries > 0 ? leg.ferries : 1;
				const a = tradeBodyIndex(leg.from), b = tradeBodyIndex(leg.to);
				if (a >= 0 && b >= 0) drawGraphLegFleet(leg, i, boat, a, b);
				boat += n;
			}
		} else {
			drawDvDockedFleet();
		}
		drawDvHullFleet();
	}

	// One leg's boats on the graph, at the same phase the orrery uses.
	function drawGraphLegFleet(leg, legIndex, firstBoat, fromBody, toBody) {
		const n = leg.ferries > 0 ? leg.ferries : 1;
		graphReset();
		graphWell(fromBody, 1, 3);
		graphRail(fromBody, toBody, 3);
		graphWell(toBody, 3, 1);
		if (!(graphMeasure() > 0)) return;
		for (let k = 0; k < n; k++) {
			const seat = firstBoat + k;
			const phase = legPhase(leg, legIndex, seat);
			if (phase < 0) return;
			const out = phase < 0.5;
			if (!graphPointAt(out ? phase * 2 : 2 - phase * 2)) continue;
			const dir = out ? 1 : -1;
			drawFerry(graphHit[0], graphHit[1], graphHit[2] * dir, graphHit[3] * dir, seat, legIndex);
		}
	}

	function tradeBodyIndex(slot) {
		if (!tradePort || !tradeWorlds || !(slot >= 0 && slot < tradePort.worldCount)) return -1;
		const world = tradeWorlds[tradePort.worldIdx[slot]];
		if (!world) return -1;
		const bi = world.kind === 0 ? world.index : record.counts.planets + world.index;
		return bi >= 0 && bi < dvNBodies ? bi : -1;
	}

	// The twelve boat slots the phase offsets are spread over. A constant rather
	// than a running total so a boat's phase does not shift when a leg's share
	// changes.
	const INTRA_FERRY_SEATS = 12;

	// Idle boats: two rings of ticks at the port's first world, so "the fleet is
	// in port" is something the frame says rather than something the readout
	// has to. Every tick is a seat, so a click on one selects that boat and the
	// readout can say what its route would have been.
	function drawDockedFleet() {
		if (!tradePort || !tradeWorlds || !tradePort.worldCount
			|| (tradePort.colony && tradePort.colony.outpost)) return;
		if (!tradeWorldPosition(0, tradeFromXY)) return;
		drawDockedTicks(tradeFromXY[0], tradeFromXY[1]);
	}

	function drawDockedTicks(cx, cy) {
		const r = TRADE_MARKER_STYLE.ringMin + TRADE_MARKER_STYLE.ringSpan * 0.5 + 5;
		ctx.strokeStyle = INTRA_FERRY_STROKE;
		ctx.lineWidth = 1;
		for (let k = 0; k < INTRA_FERRY_SEATS; k++) {
			const a = (k / INTRA_FERRY_SEATS) * TAU;
			const rr = r + (k % 2) * 2.5;
			const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
			ctx.beginPath();
			ctx.arc(x, y, INTRA_FERRY_PX - 0.6, 0, TAU);
			ctx.stroke();
			registerCraft(k, CRAFT_FERRY, -1, k, x, y);
		}
		if (craftKind === CRAFT_FERRY && craftLeg === -1) {
			ctx.beginPath();
			ctx.arc(cx, cy, r + INTRA_FERRY_PX + 2.4, 0, TAU);
			ctx.strokeStyle = INTRA_FERRY_STROKE;
			ctx.lineWidth = 1.2;
			ctx.stroke();
		}
	}

	// The graph's version of the berth: the same twelve ticks around the port
	// world's low-orbit node, so a one-world system still shows its fleet on
	// the schematic — parked on the column of the world it loads at.
	function drawDvDockedFleet() {
		if (!tradePort || !tradePort.worldCount || (tradePort.colony && tradePort.colony.outpost)) return;
		const bi = tradeBodyIndex(0);
		if (bi < 0) return;
		dvNodeXYFor(bi, 1, dvTmpXY);
		drawDockedTicks(dvTmpXY[0], dvTmpXY[1]);
	}

	// One boat at (x, y) heading along the unit vector (ux, uy), with the trail
	// behind it. `seat` is the boat's slot among the twelve (and its identity for
	// picking), `leg` the leg it is flying (-1 in port). The caller owns the
	// position: on the orrery it is the dash between two worlds, on the delta-v
	// renders it is a point of the drawn graph (`graphPointAt`).
	function drawFerry(x, y, ux, uy, seat, leg) {
		if (ux !== 0 || uy !== 0) {
			ctx.strokeStyle = INTRA_FERRY_TAIL;
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.moveTo(x - ux * INTRA_FERRY_TAIL_PX, y - uy * INTRA_FERRY_TAIL_PX);
			ctx.lineTo(x, y);
			ctx.stroke();
		}
		ctx.beginPath();
		ctx.arc(x, y, INTRA_FERRY_PX + 0.9, 0, TAU);
		ctx.strokeStyle = INTRA_FERRY_STROKE;
		ctx.lineWidth = 1;
		ctx.stroke();
		ctx.beginPath();
		ctx.arc(x, y, INTRA_FERRY_PX, 0, TAU);
		ctx.fillStyle = INTRA_FERRY_FILL;
		ctx.fill();
		if (craftSelected(CRAFT_FERRY, leg, seat)) {
			ctx.beginPath();
			ctx.arc(x, y, INTRA_FERRY_PX + HULL_SELECT_PAD_PX + 2.4, 0, TAU);
			ctx.strokeStyle = INTRA_FERRY_STROKE;
			ctx.lineWidth = 1.4;
			ctx.stroke();
		}
		if (craftHovered(CRAFT_FERRY, leg, seat)) drawCraftLabel(x, y, hoverCraftLabel);
		registerCraft(seat, CRAFT_FERRY, leg, seat, x, y);
	}

	function drawTradeWorlds() {
		if (!tradePort || !tradeWorlds || tradePort.key !== (record.star.key >>> 0)) return;
		ctx.lineWidth = 1.2;
		for (let s = 0; s < tradePort.worldCount; s++) {
			const world = tradeWorlds[tradePort.worldIdx[s]];
			if (!world || !tradeWorldPosition(s, tradeFromXY)) continue;
			let frac = world.capacity > 0 ? world.pop / world.capacity : 0;
			if (frac < 0) frac = 0;
			if (frac > 1) frac = 1;
			const radius = TRADE_MARKER_STYLE.ringMin + TRADE_MARKER_STYLE.ringSpan * Math.sqrt(frac);
			ctx.strokeStyle = world.outpost ? TRADE_MARKER_STYLE.outpost
				: Math.abs(world.growth) <= TRADE_MARKER_STYLE.growthEps ? TRADE_MARKER_STYLE.peak
					: world.growth > 0 ? TRADE_MARKER_STYLE.grow : TRADE_MARKER_STYLE.fade;
			ctx.setLineDash(TRADE_SOLID_DASH);
			ctx.beginPath();
			ctx.arc(tradeFromXY[0], tradeFromXY[1], radius, 0, TAU);
			ctx.stroke();
			if (world.starving && !world.outpost) {
				ctx.strokeStyle = TRADE_MARKER_STYLE.alarm;
				ctx.setLineDash(TRADE_INTRA_DASH);
				ctx.beginPath();
				ctx.arc(tradeFromXY[0], tradeFromXY[1], radius + TRADE_MARKER_STYLE.alarmGap, 0, TAU);
				ctx.stroke();
			}
		}
		ctx.setLineDash(TRADE_SOLID_DASH);
		ctx.lineWidth = 1;
	}

	// 1. The habitable annulus, clamped into the view: a giant's HZ can reach
	// past the disc edge, and an annulus outside the diagram says nothing.
	function drawHabitableZone() {
		const star = record.star;
		const rhoIn = clamp01(rhoOf(star.aHzIn));
		const rhoOut = clamp01(rhoOf(star.aHzOut));
		if (rhoOut - rhoIn < 1e-4) return;
		const rIn = radiusPx(rhoIn);
		const rOut = radiusPx(rhoOut);
		ctx.fillStyle = HZ_FILL;
		ctx.beginPath();
		ctx.arc(layout.cx, layout.cy, rOut, 0, TAU);
		ctx.arc(layout.cx, layout.cy, rIn, 0, TAU, true);
		ctx.fill();
		ctx.strokeStyle = HZ_EDGE;
		ctx.lineWidth = 1;
		ctx.stroke();
	}

	// 2. Orbit ellipses: semi-major r_px(a), eccentricity e, rotated by ω,
	// squashed by cos i. Drawn even when the planet is a dot on it, so a frozen
	// system still reads as a system.
	function drawOrbits() {
		const p = record.planets;
		const n = record.counts.planets;
		ctx.strokeStyle = ORBIT_STROKE;
		ctx.lineWidth = 1;
		for (let i = 0; i < n; i++) {
			const A = radiusPx(planetRho[i]);
			ctx.beginPath();
			ctx.ellipse(layout.cx, layout.cy, A, A * planetSquash[i], p.peri[i], 0, TAU);
			ctx.stroke();
		}
	}

	// 3. Belts: STIPPLE_N dots each, at (ρ(radius_s), θ_belt(t) + angle_s) —
	// the whole belt rotating at its own Kepler rate.
	function drawBelts() {
		const belts = record.belts;
		ctx.fillStyle = BELT_FILL;
		const half = BELT_DOT_PX * 0.5;
		for (let k = 0; k < belts.count; k++) {
			const theta = TAU * (timeYears / beltPeriod[k]);
			const base = k * planets.STIPPLE_N;
			const xyBase = k * planets.STIPPLE_N * 2;
			for (let s = 0; s < planets.STIPPLE_N; s++) {
				const ang = beltAngles[base + s] + theta;
				const r = radiusPx(beltRho[base + s]);
				const x = layout.cx + r * Math.cos(ang);
				const y = layout.cy + r * Math.sin(ang);
				beltStippleXY[xyBase + s * 2] = x;
				beltStippleXY[xyBase + s * 2 + 1] = y;
				ctx.fillRect(x - half, y - half, BELT_DOT_PX, BELT_DOT_PX);
			}
		}
	}

	// 4. The star: the class colour, radius by state, halo at 2×.
	function drawStar() {
		ctx.fillStyle = starHalo;
		ctx.beginPath();
		ctx.arc(layout.cx, layout.cy, starRadiusPx * 2, 0, TAU);
		ctx.fill();
		ctx.fillStyle = starFill;
		ctx.beginPath();
		ctx.arc(layout.cx, layout.cy, starRadiusPx, 0, TAU);
		ctx.fill();
	}

	// 5. Planets: the display-type colour, the five-bucket log-mass ramp, a
	// ring for the giants, a shaded night half for locked worlds, a green
	// outline for the terran-flagged. Each rides its own drawn ellipse at the
	// parameter angle θ(t), so the dot and the orbit can never disagree.
	function drawPlanets() {
		const p = record.planets;
		const n = record.counts.planets;
		const gas = planets.BULK_INDEX.gas;
		const icegiant = planets.BULK_INDEX.icegiant;
		for (let i = 0; i < n; i++) {
			const A = radiusPx(planetRho[i]);
			const B = A * planetSquash[i];
			const theta = p.phase[i] + TAU * (timeYears / p.period[i]);
			const ex = A * Math.cos(theta);
			const ey = B * Math.sin(theta);
			const x = layout.cx + ex * planetCosPeri[i] - ey * planetSinPeri[i];
			const y = layout.cy + ex * planetSinPeri[i] + ey * planetCosPeri[i];
			planetScreenXY[i * 2] = x;
			planetScreenXY[i * 2 + 1] = y;
			const r = planetIconR[i];
			ctx.fillStyle = TYPE_FILLS[p.displayType[i]];
			ctx.beginPath();
			ctx.arc(x, y, r, 0, TAU);
			ctx.fill();
			const bulk = p.bulk[i];
			if (bulk === gas || bulk === icegiant) {
				ctx.strokeStyle = GIANT_RING_STROKE;
				ctx.lineWidth = 1;
				ctx.beginPath();
				ctx.arc(x, y, r * GIANT_RING_K, 0, TAU);
				ctx.stroke();
			}
			const flags = p.flags[i];
			if (flags & planets.FLAG_LOCKED) {
				// The star-facing half stays lit: shade the far half through the
				// direction to the centre.
				const toStar = Math.atan2(layout.cy - y, layout.cx - x);
				ctx.fillStyle = LOCKED_SHADE;
				ctx.beginPath();
				ctx.arc(x, y, r, toStar + HALF_PI, toStar - HALF_PI);
				ctx.fill();
			}
			if (flags & planets.FLAG_TERRAN) {
				ctx.strokeStyle = TERRAN_OUTLINE;
				ctx.lineWidth = 1;
				ctx.beginPath();
				ctx.arc(x, y, r + 1, 0, TAU);
				ctx.stroke();
			}
		}
	}

	// One body's screen position, into `out` (Float64Array(2)). Belts have no
	// single position: the label sits at the belt circle on the hover bearing.
	function bodyPosition(kind, index, out) {
		if (kind === BODY_STAR) {
			out[0] = layout.cx; out[1] = layout.cy;
			return out;
		}
		if (kind === BODY_PLANET && index < record.counts.planets) {
			out[0] = planetScreenXY[index * 2];
			out[1] = planetScreenXY[index * 2 + 1];
			return out;
		}
		if (kind === BODY_BELT && index < record.belts.count) {
			out[0] = hoverX; out[1] = hoverY;
			return out;
		}
		out[0] = layout.cx; out[1] = layout.cy;
		return out;
	}
	const markPos = new Float64Array(2);

	// 6. Selection ring and hover designation. A belt's "ring at radius +4" is
	// its own circle in the ring colour: a belt is an annulus, not a point.
	function drawBodyMarks() {
		if (selectedKind !== BODY_NONE) {
			ctx.strokeStyle = layerLabels.SELECT_RING;
			ctx.lineWidth = 1.5;
			ctx.beginPath();
			if (selectedKind === BODY_BELT && selectedIndex < record.belts.count) {
				ctx.arc(layout.cx, layout.cy, radiusPx(beltRhoC[selectedIndex]), 0, TAU);
			} else {
				bodyPosition(selectedKind, selectedIndex, markPos);
				const pad = selectedKind === BODY_STAR ? starRadiusPx
					: selectedKind === BODY_PLANET ? planetIconR[selectedIndex] : 0;
				ctx.arc(markPos[0], markPos[1], pad + SELECT_RING_PAD_PX, 0, TAU);
			}
			ctx.stroke();
		}
		if (hoverKind === BODY_NONE || !hoverLabel) return;
		bodyPosition(hoverKind, hoverIndex, markPos);
		const x = markPos[0] + layerLabels.LABEL_OFFSET_PX;
		const y = markPos[1] - layerLabels.LABEL_OFFSET_PX;
		ctx.font = layerLabels.LABEL_FONT;
		ctx.lineWidth = 3;
		ctx.strokeStyle = layerLabels.LABEL_HALO;
		ctx.strokeText(hoverLabel, x, y);
		ctx.fillStyle = layerLabels.LABEL_FILL;
		ctx.fillText(hoverLabel, x, y);
	}

	// --- The delta-v map, logic size --------------------------------------
	// Centered logical map, uniformly fitted to the clear canvas region.
	const mapLayout = { x: 0, y: 0, scale: 1, width: 0, height: 0, valid: false };
	const nodeLabels = ['surf', 'LO', 'GEO', 'esc', 'L5'];
	const rowCaptions = ['surface', 'low orbit', 'GEO', 'escape C3=0', 'L5 drift'];
	const tableLines = [];
	let mapHeader = '';
	// The two rails of the rail render are the same heliocentric transfer; they
	// differ in what waits at the ends, which is the one thing the caption says.
	const RAIL_LEGEND_ESC = 'escape rail — Hohmann injection, capture into the destination low orbit';
	const RAIL_LEGEND_L5 = 'L5 rail — the 60\u00b0 drift, the same transfer, no capture burn';
	function nodeExists(bi, kind) {
		const n = dvNodes[bi];
		return kind === 1 || kind === 3 || (kind === 0 && n.hasSurface)
			|| (kind === 2 && n.hasGeo) || (kind === 4 && n.hasL5);
	}
	function dvColumnIndexOf(bodyIdx) {
		for (let i = 0; i < dvNBodies; i++) if (dvOrder[i] === bodyIdx) return i;
		return 0;
	}
	// A node's row. The rail render gives every kind its own row, so the escape
	// and L5 rails stay level across the columns (a body without a GEO leaves a
	// gap instead of shifting its neighbours); the classic render packs the rows
	// per body, which is the shape 0.5.4 drew. The star column has no bodies of
	// its own, so it mirrors the innermost one: that is what keeps the row
	// captions beside the rows they name, and the star rail one straight segment.
	function rowSlot(bi, kind) {
		if (view === VIEW_DV_RAILS) return kind;
		const ref = bi >= 0 ? bi : (dvNBodies > 0 ? dvOrder[0] : -1);
		if (ref < 0) return kind;
		let slot = 0;
		for (let k = 0; k < kind; k++) if (nodeExists(ref, k)) slot++;
		return slot;
	}
	function dvNodeXYFor(bi, kind, out) {
		out[0] = DV_COL_X0 + (bi < 0 ? 0 : dvColumnIndexOf(bi) + 1) * DV_COL_W;
		out[1] = DV_COL_TOP + rowSlot(bi, kind) * DV_NODE_DY;
		return out;
	}
	const dvTmpXY = new Float64Array(2);
	const dvTmpXY2 = new Float64Array(2);
	const tableTimes = {};

	// --- Boats on the drawn graph (trade.35) --------------------------------
	// A craft is only ever placed on a segment the render has *drawn*: the well
	// edges of a column (low orbit out to escape or L5, with the elbows
	// `mapWellEdge` draws), the rails that join two adjacent columns, and the
	// star rail that leaves the system. Building the polyline from the same
	// functions that draw the lines is what makes a boat ride the schematic
	// instead of flying over empty paper — the reported defect.
	const GRAPH_PATH_MAX = 2 * (layerDv.MAX_BODIES + 12);
	const graphPath = new Float64Array(GRAPH_PATH_MAX);
	const graphHit = new Float64Array(4);         // x, y, unit direction
	let graphCount = 0;
	let graphLen = 0;

	function graphReset() { graphCount = 0; graphLen = 0; }
	function graphPush(x, y) {
		if (graphCount + 2 > GRAPH_PATH_MAX) return;
		graphPath[graphCount++] = x;
		graphPath[graphCount++] = y;
	}
	function graphPushNode(bi, kind) {
		dvNodeXYFor(bi, kind, dvTmpXY);
		graphPush(dvTmpXY[0], dvTmpXY[1]);
	}
	// The x a column's well edge is drawn at: escape leaves low orbit on the
	// left of the column and L5 on the right, so the three edges never overlap.
	function wellEdgeX(bi, kind) {
		dvNodeXYFor(bi, 1, dvTmpXY);
		return dvTmpXY[0] + (kind === 3 ? -10 : kind === 4 ? 10 : 0);
	}
	// Low orbit out to another node of the same column, along the elbows the
	// render draws for that edge.
	function graphWell(bi, fromKind, toKind) {
		dvNodeXYFor(bi, fromKind, dvTmpXY);
		const x0 = dvTmpXY[0], y0 = dvTmpXY[1];
		dvNodeXYFor(bi, toKind, dvTmpXY2);
		const x1 = dvTmpXY2[0], y1 = dvTmpXY2[1];
		graphPush(x0, y0);
		if (fromKind === 1 || toKind === 1) {
			const edge = fromKind === 1 ? toKind : fromKind;
			const x = wellEdgeX(bi, edge);
			if (x !== x0) {
				graphPush(x, y0);
				graphPush(x, y1);
			}
		}
		graphPush(x1, y1);
	}
	// The rails between two columns. A rail joins two *adjacent* columns, so the
	// walk visits every column in between: a boat crossing three columns rides
	// three drawn segments, never a chord over them.
	function graphRail(fromBody, toBody, row) {
		const ia = dvColumnIndexOf(fromBody), ib = dvColumnIndexOf(toBody);
		if (ia === ib) return;
		const step = ib > ia ? 1 : -1;
		for (let c = ia + step; ; c += step) {
			graphPushNode(c === ib ? toBody : dvOrder[c], row);
			if (c === ib) break;
		}
	}
	function graphMeasure() {
		graphLen = 0;
		for (let i = 0; i + 3 < graphCount; i += 2) {
			const dx = graphPath[i + 2] - graphPath[i], dy = graphPath[i + 3] - graphPath[i + 1];
			graphLen += Math.sqrt(dx * dx + dy * dy);
		}
		return graphLen;
	}
	// The point `f` of the way along the drawn path, with the segment's own unit
	// direction so the trail behind a boat follows the line it is on.
	function graphPointAt(f) {
		if (graphCount < 4 || !(graphLen > 0)) return false;
		if (f < 0) f = 0; else if (f > 1) f = 1;
		let want = graphLen * f;
		for (let i = 0; i + 3 < graphCount; i += 2) {
			const dx = graphPath[i + 2] - graphPath[i], dy = graphPath[i + 3] - graphPath[i + 1];
			const len = Math.sqrt(dx * dx + dy * dy);
			if (!(len > 0)) continue;
			if (want <= len || i + 5 >= graphCount) {
				const t = want > len ? 1 : want / len;
				graphHit[0] = graphPath[i] + dx * t;
				graphHit[1] = graphPath[i + 1] + dy * t;
				graphHit[2] = dx / len;
				graphHit[3] = dy / len;
				return true;
			}
			want -= len;
		}
		return false;
	}
	function refreshMapText() {
		if (view === VIEW_DV_TIME) {
			mapHeader = starPrefix + ' · delta-v flight-time schematic';
			tableLines.length = 0;
			tableLines.push('Track length ∝ one-way Hohmann flight time · ferries move on the system clock');
			tableLines.push('Select a ferry to read its average load, Δv budget and calculation route.');
			return;
		}
		mapHeader = starPrefix + ' · delta-v (km/s) · ' + (view === VIEW_DV_RAILS ? 'rail render' : 'classic render')
			+ ' · click start, then destination';
		tableLines.length = 0;
		let from = selectedKind === BODY_PLANET ? selectedIndex
			: selectedKind === BODY_BELT ? record.counts.planets + selectedIndex : -1;
		if (from < 0 || from >= dvNBodies) from = dvNBodies ? dvOrder[0] : -1;
		if (from < 0) { tableLines.push('No orbiting bodies in this system.'); return; }
		tableLines.push('From ' + dvNodes[from].letter + ' LO · budget ' + dvBudget.toFixed(2) + ' · ' + dvShipClass);
		tableLines.push('to        dv km/s      Hohmann       at budget       feasibility');
		for (let j = 0; j < dvNBodies; j++) {
			const to = dvOrder[j];
			if (to === from) continue;
			const edge = dvInterEdges[layerDv.interEdgeIndex(dvNBodies, from, to)];
			layerDv.legTimes(edge, layerDv.shipById(dvShipClass), dvBudget, tableTimes);
			tableLines.push(dvNodes[to].letter.padEnd(10) + layerDv.formatKms(edge.dvLoToLo).padStart(7)
				+ layerDv.formatDuration(edge.tH).padStart(14) + layerDv.formatDuration(tableTimes.t).padStart(16)
				+ '    ' + (!tableTimes.feasible ? 'exceeds hull' : tableTimes.belowCrossover ? 'below dv_x' : 'feasible'));
		}
	}
	function mapEdge(bi, k1, bj, k2, label) {
		dvNodeXYFor(bi, k1, dvTmpXY);
		dvNodeXYFor(bj, k2, dvTmpXY2);
		ctx.beginPath(); ctx.moveTo(dvTmpXY[0], dvTmpXY[1]);
		if (bi === bj) {
			const offset = k2 === 3 ? -50 : k2 === 4 ? 46 : -24;
			const x = dvTmpXY[0] + offset;
			ctx.lineTo(x, dvTmpXY[1]); ctx.lineTo(x, dvTmpXY2[1]);
			ctx.lineTo(dvTmpXY2[0], dvTmpXY2[1]); ctx.stroke();
			if (label) ctx.fillText(label, x + (offset < 0 ? -34 : 4), (dvTmpXY[1] + dvTmpXY2[1]) * 0.5 - 3);
			return;
		}
		ctx.lineTo(dvTmpXY2[0], dvTmpXY2[1]); ctx.stroke();
		if (label) ctx.fillText(label, (dvTmpXY[0] + dvTmpXY2[0]) * 0.5 - 16, (dvTmpXY[1] + dvTmpXY2[1]) * 0.5 - 5);
	}
	// Every string the two renders draw is built here, once per system: the
	// frame loop only reads these (plan §7.5 — no per-frame formatting).
	const edgeLabels = [];
	const interLabels = [];
	const railEscapeLabels = [];
	const railL5Labels = [];
	const railHeads = [];
	const railAux = [];
	function cacheMapLabels() {
		edgeLabels.length = 0; interLabels.length = 0;
		railEscapeLabels.length = 0; railL5Labels.length = 0;
		railHeads.length = 0; railAux.length = 0;
		for (let bi = 0; bi < dvNBodies; bi++) {
			const au = dvBodies[bi].aM / layerDv.AU_M;
			railHeads.push(dvNodes[bi].letter + '  ' + dvNodes[bi].label);
			railAux.push(au >= 10 ? au.toFixed(0) + ' AU' : au.toFixed(2) + ' AU');
		}
		for (let i = 0; i < dvNBodies; i++) {
			const e = dvOneEdges[i];
			edgeLabels.push([layerDv.formatKms(e.dvSurfaceToLo), '', layerDv.formatKms(e.dvLoToGeo), layerDv.formatKms(e.dvLoToEscape), layerDv.formatKms(e.dvLoToL5)]);
		}
		for (let i = 0; i < dvNBodies - 1; i++) {
			const a = dvOrder[i], b = dvOrder[i + 1];
			const e = dvInterEdges[layerDv.interEdgeIndex(dvNBodies, a, b)];
			interLabels.push(layerDv.formatKms(e.dvDepStar + e.dvArrStar));
			// The rail readings (§7.2's chains): the escape rail is the route
			// builder's own low-orbit-to-low-orbit number (Oberth departure plus
			// credited capture); the L5 rail adds the drift out of the origin's
			// well to the same heliocentric transfer, and nothing at the far end
			// — arriving at L5 is arriving.
			railEscapeLabels.push(layerDv.formatKms(e.dvLoToLo));
			railL5Labels.push(layerDv.formatKms(dvOneEdges[a].dvLoToL5 + e.dvDepStar + e.dvArrStar));
		}
		refreshMapText();
	}
	// One node, drawn the same in both renders. L5 is a diamond: it is the one
	// node that is not a point on the body's own well (plan §7.1).
	function drawMapNode(bi, k) {
		dvNodeXYFor(bi, k, dvTmpXY);
		ctx.fillStyle = k === 0 ? DV_NODE_FILL_SURF : DV_NODE_FILL;
		if (k === 4) {
			const r = DV_NODE_R;
			ctx.beginPath();
			ctx.moveTo(dvTmpXY[0], dvTmpXY[1] - r);
			ctx.lineTo(dvTmpXY[0] + r, dvTmpXY[1]);
			ctx.lineTo(dvTmpXY[0], dvTmpXY[1] + r);
			ctx.lineTo(dvTmpXY[0] - r, dvTmpXY[1]);
			ctx.closePath();
			ctx.fill();
		} else {
			ctx.beginPath(); ctx.arc(dvTmpXY[0], dvTmpXY[1], DV_NODE_R, 0, TAU); ctx.fill();
		}
	}
	// The endpoint rings of the chosen route (plan §8.4): both ends of the
	// itinerary are marked on the graph, whichever node they are.
	function drawMapEndpointRing(bi, k) {
		if (!routeStart && !routeEnd) return;
		const isStart = routeStart && routeStart.bodyIndex === bi && routeStart.node === k;
		const isEnd = routeEnd && routeEnd.bodyIndex === bi && routeEnd.node === k;
		if (!isStart && !isEnd) return;
		dvNodeXYFor(bi, k, dvTmpXY);
		ctx.strokeStyle = activeRoute.ship.color;
		ctx.lineWidth = 1;
		ctx.beginPath(); ctx.arc(dvTmpXY[0], dvTmpXY[1], DV_NODE_R + 4, 0, TAU); ctx.stroke();
	}
	function drawMapNodes() {
		for (let col = 0; col < dvNBodies; col++) {
			const bi = dvOrder[col];
			for (let k = 0; k < 5; k++) {
				if (!nodeExists(bi, k)) continue;
				drawMapNode(bi, k);
			}
		}
		ctx.fillStyle = DV_TEXT_FILL;
		for (let col = 0; col < dvNBodies; col++) {
			const bi = dvOrder[col];
			for (let k = 0; k < 5; k++) {
				if (!nodeExists(bi, k)) continue;
				dvNodeXYFor(bi, k, dvTmpXY);
				ctx.fillText(nodeLabels[k], dvTmpXY[0] + 9, dvTmpXY[1] + 3);
				drawMapEndpointRing(bi, k);
			}
		}
	}
	// The 0.5.4 render, unchanged in shape: rows packed per body, edges fanning
	// out of LOW_ORBIT, adjacent columns joined along the escape row.
	function drawDvClassic() {
		ctx.fillStyle = DV_TEXT_FILL; ctx.font = DV_HEADER_FONT;
		ctx.fillText(mapHeader, 20, 24);
		ctx.font = DV_LABEL_FONT; ctx.strokeStyle = DV_EDGE_STROKE; ctx.lineWidth = 1;
		for (let i = 0; i < dvNBodies; i++) {
			for (let k = 0; k < 5; k++) {
				if (k === 1 || !nodeExists(i, k)) continue;
				mapEdge(i, 1, i, k, edgeLabels[i][k]);
			}
		}
		for (let i = 0; i < dvNBodies - 1; i++) mapEdge(dvOrder[i], 3, dvOrder[i + 1], 3, interLabels[i]);
		// The way out of the system: the star column is the leftmost, and its
		// rail is the segment an interstellar voyage rides — the innermost
		// body's escape row out to the star's node.
		if (dvNBodies > 0) mapEdge(-1, 3, dvOrder[0], 3, '');
		for (let col = 0; col < dvNBodies; col++) {
			const bi = dvOrder[col];
			dvNodeXYFor(bi, 0, dvTmpXY);
			ctx.fillStyle = DV_TEXT_FILL; ctx.fillText(dvNodes[bi].letter, dvTmpXY[0] - 8, DV_COL_TOP - 16);
		}
		drawMapNodes();
		ctx.fillStyle = DV_NODE_STAR_FILL; dvNodeXYFor(-1, 3, dvTmpXY);
		ctx.beginPath(); ctx.arc(dvTmpXY[0], dvTmpXY[1], DV_NODE_R + 2, 0, TAU); ctx.fill();
		ctx.fillStyle = DV_TEXT_FILL; ctx.fillText('star', dvTmpXY[0] - 14, dvTmpXY[1] + 20);
		drawDvFleet();
	}
	// The rail render (0.5.6). Every node kind keeps its own row, so the escape
	// rail and the L5 rail run straight across the columns and both read as ways
	// out of a system: the escape rail injects from low orbit and captures at
	// the destination, the L5 rail drifts out at the 60° point and arrives in
	// the destination's drift without a capture burn. The escape rung is the
	// route builder's low-orbit-to-low-orbit chain of §7.2; the L5 rung is the
	// same journey begun in low orbit and left through the drift (from the L5
	// node itself the builder charges only the two star-frame burns).
	function drawDvRails() {
		ctx.fillStyle = DV_TEXT_FILL; ctx.font = DV_HEADER_FONT;
		ctx.fillText(mapHeader, 20, 24);
		ctx.font = DV_LABEL_FONT;
		// The legends sit in the gap between the L5 row and the table: at the
		// top they would share their lines with the column headers.
		ctx.fillStyle = DV_ROW_CAPTION;
		ctx.fillText(RAIL_LEGEND_ESC, DV_COL_X0, DV_TABLE_TOP - 26);
		ctx.fillText(RAIL_LEGEND_L5, DV_COL_X0, DV_TABLE_TOP - 12);
		// The selected body's column, behind everything (plan §6.3: the map
		// reads the same selection the schematic does).
		const selBody = selectedKind === BODY_PLANET ? selectedIndex
			: selectedKind === BODY_BELT ? record.counts.planets + selectedIndex : -1;
		if (selBody >= 0 && selBody < dvNBodies) {
			dvNodeXYFor(selBody, 0, dvTmpXY);
			ctx.fillStyle = DV_SELECT_COL;
			ctx.fillRect(dvTmpXY[0] - DV_COL_W * 0.5 + 4, DV_COL_TOP - DV_NODE_DY * 1.5, DV_COL_W - 8, DV_NODE_DY * 6);
		}
		// Row captions once, in the clear margin left of the first column.
		for (let k = 0; k < 5; k++) {
			dvNodeXYFor(-1, k, dvTmpXY);
			ctx.fillStyle = DV_ROW_CAPTION;
			ctx.fillText(rowCaptions[k], DV_COL_X0 - 14, dvTmpXY[1] + 3);
		}
		// The rails, drawn before the nodes so the markers sit on top.
		ctx.lineWidth = 1;
		for (let i = 0; i < dvNBodies - 1; i++) {
			const a = dvOrder[i], b = dvOrder[i + 1];
			mapRail(a, b, 3, DV_RAIL_EDGE, DV_RAIL_LABEL, railEscapeLabels[i]);
			if (nodeExists(a, 4) && nodeExists(b, 4)) mapRail(a, b, 4, DV_RAIL_L5, DV_RAIL_L5_LABEL, railL5Labels[i]);
		}
		// The way out: the star node is where an interstellar voyage leaves and
		// returns, so the rail that joins it to the innermost column is drawn
		// like every other one.
		if (dvNBodies > 0) mapRail(-1, dvOrder[0], 3, DV_RAIL_EXIT, DV_RAIL_LABEL, '');
		// The well edges of each column, and the column headers.
		for (let col = 0; col < dvNBodies; col++) {
			const bi = dvOrder[col];
			dvNodeXYFor(bi, 0, dvTmpXY);
			const hx = dvTmpXY[0] - DV_COL_W * 0.5 + 8;
			ctx.fillStyle = DV_TEXT_FILL;
			ctx.fillText(railHeads[bi], hx, DV_COL_TOP - 40);
			ctx.fillStyle = DV_ROW_CAPTION;
			ctx.fillText(railAux[bi], hx, DV_COL_TOP - 26);
			for (let k = 0; k < 5; k++) {
				if (k === 1 || !nodeExists(bi, k)) continue;
				mapWellEdge(bi, k, edgeLabels[bi][k]);
			}
		}
		drawMapNodes();
		drawDvFleet();
	}
	// A dedicated time-scaled Δv render for the network's average freight legs.
	// Unlike the topology map, these tracks are not decorative distances: every
	// lane uses one shared linear duration scale and the ship's x position is
	// elapsed system-clock time on that exact route. Thus the line length and
	// ship speed both encode the Hohmann time that trade.js priced.
	function drawDvTime() {
		ctx.fillStyle = DV_TEXT_FILL; ctx.font = DV_HEADER_FONT;
		ctx.fillText(mapHeader, 20, 24);
		ctx.font = DV_LABEL_FONT;
		ctx.fillStyle = DV_ROW_CAPTION;
		ctx.fillText('track length ∝ one-way Hohmann flight time · select a ferry for recent cargo and passenger rates', 20, 48);
		const intra = tradePort && tradePort.intra;
		const outpost = tradePort && tradePort.colony && tradePort.colony.outpost;
		const count = !outpost && intra && intra.legCount > 0 ? intra.legCount : 0;
		let maxYears = 0;
		for (let i = 0; i < count; i++) {
			const years = intra.legs[i].legYears;
			if (years > maxYears) maxYears = years;
		}
		if (!(maxYears > 0)) maxYears = 1;
		if (!count) {
			let activeWorlds = 0;
			if (tradePort && tradeWorlds) for (let s = 0; s < tradePort.worldCount; s++) {
				const world = tradeWorlds[tradePort.worldIdx[s]];
				if (world && !world.outpost) activeWorlds++;
			}
			ctx.fillStyle = DV_NODE_FILL;
			if (!tradePort) {
				ctx.fillText('No trade colony in this system. Local routes need two settled worlds.', 24, DV_TIME_LANE_Y);
			} else if (tradePort.colony && tradePort.colony.outpost) {
				ctx.fillText('This colony is an outpost; its trade has stopped.', 24, DV_TIME_LANE_Y);
			} else if (activeWorlds < 2) {
				ctx.fillText('Fewer than two active worlds here. Local trade needs at least two.', 24, DV_TIME_LANE_Y);
			} else if (intra && intra.unpricedPairs > 0) {
				ctx.fillText('Recent transfers exist, but their route geometry is unavailable.', 24, DV_TIME_LANE_Y);
			} else if (intra && intra.unservedPairs > 0) {
				ctx.fillText('Recent routes exceed the available in-system hull budgets.', 24, DV_TIME_LANE_Y);
			} else {
				ctx.fillText('No recent transfers between settled worlds.', 24, DV_TIME_LANE_Y);
			}
			ctx.fillStyle = DV_ROW_CAPTION;
			if (!tradePort || (tradePort.colony && tradePort.colony.outpost)) {
				ctx.fillText('The flight-time view shows recorded local trade, not interstellar hull routes.', 24, DV_TIME_LANE_Y + 24);
			} else if (activeWorlds < 2) {
				ctx.fillText('Enable Expansion and run trade time, or found another world while docked.', 24, DV_TIME_LANE_Y + 24);
			} else if (intra && (intra.unpricedPairs > 0 || intra.unservedPairs > 0)) {
				ctx.fillText('These transfers still settle statistically; no ferry can be drawn for them.', 24, DV_TIME_LANE_Y + 24);
			} else {
				ctx.fillText('Trade needs matching surplus and demand; the trade clock must run to record it.', 24, DV_TIME_LANE_Y + 24);
			}
			if (tradePort && tradePort.worldCount > 0 && !(tradePort.colony && tradePort.colony.outpost)) {
				drawDockedTicks(DV_TIME_TRACK_X, DV_TIME_LANE_Y + 56);
			}
			return;
		}
		let firstBoat = 0;
		for (let i = 0; i < count; i++) {
			const leg = intra.legs[i];
			const y = DV_TIME_LANE_Y + i * DV_TIME_LANE_DY;
			const n = leg.ferries > 0 ? leg.ferries : 1;
			const length = DV_TIME_TRACK_MAX * leg.legYears / maxYears;
			const x0 = DV_TIME_TRACK_X, x1 = x0 + length;
			const from = tradeWorldName(leg.from), to = tradeWorldName(leg.to);
			ctx.fillStyle = DV_TEXT_FILL;
			ctx.fillText(from, 20, y + 4);
			ctx.fillStyle = DV_ROW_CAPTION;
			ctx.fillText('to', 145, y + 4);
			ctx.fillStyle = DV_TEXT_FILL;
			ctx.fillText(to, 168, y + 4);
			ctx.strokeStyle = TRADE_INTRA_STROKES[leg.family >= 0 ? leg.family : 0];
			ctx.lineWidth = 2;
			ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
			ctx.fillStyle = DV_NODE_FILL_SURF;
			ctx.beginPath(); ctx.arc(x0, y, 3, 0, TAU); ctx.fill();
			ctx.fillStyle = DV_NODE_FILL;
			ctx.beginPath(); ctx.arc(x1, y, 3, 0, TAU); ctx.fill();
			const dx = x1 - x0;
			const ux = dx > 0 ? 1 : 0, uy = 0;
			for (let k = 0; k < n; k++) {
				const seat = firstBoat + k;
				const phase = legPhase(leg, i, seat);
				if (phase < 0) continue;
				const out = phase < 0.5;
				const u = out ? phase * 2 : 2 - phase * 2;
				const direction = out ? 1 : -1;
				drawFerry(x0 + dx * u, y, ux * direction, uy, seat, i);
			}
			firstBoat += n;
		}
	}

	function tradeWorldName(slot) {
		if (!tradePort || !tradeWorlds || !(slot >= 0 && slot < tradePort.worldCount)) return '?';
		return tradeWorldLabels[slot] || '?';
	}

	// One well edge of a column, drawn as a vertical beside the LO node — the
	// escape and L5 edges are offset to opposite sides so the three edges that
	// leave LO never overlap — with its number beside it.
	function mapWellEdge(bi, k, label) {
		dvNodeXYFor(bi, 1, dvTmpXY);
		dvNodeXYFor(bi, k, dvTmpXY2);
		const offset = k === 3 ? -10 : k === 4 ? 10 : 0;
		const x = dvTmpXY[0] + offset;
		ctx.strokeStyle = k === 3 ? DV_RAIL_EDGE : k === 4 ? DV_RAIL_L5 : DV_INNER_STROKE;
		ctx.beginPath();
		ctx.moveTo(x, dvTmpXY[1]);
		ctx.lineTo(x, dvTmpXY2[1]);
		if (offset) {
			// Short elbows back to the two nodes, so an offset edge still reads
			// as leaving LO rather than floating beside it.
			ctx.moveTo(dvTmpXY[0], dvTmpXY[1]);
			ctx.lineTo(x, dvTmpXY[1]);
			ctx.moveTo(x, dvTmpXY2[1]);
			ctx.lineTo(dvTmpXY2[0], dvTmpXY2[1]);
		}
		ctx.stroke();
		if (!label) return;
		ctx.fillStyle = DV_TEXT_FILL;
		const midY = (dvTmpXY[1] + dvTmpXY2[1]) * 0.5 + 3;
		if (offset < 0) {
			ctx.textAlign = 'right';
			ctx.fillText(label, x - 6, midY);
			ctx.textAlign = 'left';
			return;
		}
		ctx.fillText(label, x + 6, midY);
	}
	// One rail rung between adjacent columns at `row`, drawn flat with its
	// journey number centred above it.
	function mapRail(a, b, row, stroke, labelFill, label) {
		dvNodeXYFor(a, row, dvTmpXY);
		dvNodeXYFor(b, row, dvTmpXY2);
		ctx.strokeStyle = stroke;
		ctx.beginPath();
		ctx.moveTo(dvTmpXY[0], dvTmpXY[1]);
		ctx.lineTo(dvTmpXY2[0], dvTmpXY2[1]);
		ctx.stroke();
		if (!label) return;
		ctx.fillStyle = labelFill;
		ctx.fillText(label, (dvTmpXY[0] + dvTmpXY2[0]) * 0.5 - 14, dvTmpXY[1] - 7);
	}
	// --- The route trace (plan §7.5): the ship rides the graph ---------------
	// The map is a picture of the itinerary once a route exists: its transfer
	// legs are traced along the rail they use, its local legs along the well
	// edge they climb or drop, and the ship marker sits where the flight clock
	// has reached — on every leg, so the marker never teleports between nodes.
	// Purely presentational — every number is the route builder's (§8.5); this
	// only projects them onto the graph.
	//
	// A transfer leaves its origin's node, joins the rail row (the L5 rail when
	// either end is a drift node, the escape rail otherwise), crosses, and drops
	// onto the destination's node. The row join is what makes the marker ride
	// the lines that are drawn rather than a chord between two dots.
	const mapPathXY = new Float64Array(8);      // 4 graph points
	const mapShipXY = new Float64Array(2);
	const RAIL_STEP = 0.15;                     // of the leg, in and out of the rail
	function nodeXYInto(bi, kind, out, at) {
		dvNodeXYFor(bi, kind, dvTmpXY);
		out[at] = dvTmpXY[0];
		out[at + 1] = dvTmpXY[1];
	}
	function buildTransferPath(from, to) {
		// The L5 rail only exists for a body that has an L5 node; the other
		// end of an L5 journey joins the escape rail instead of a phantom row.
		const l5 = from.node === 4 || to.node === 4;
		const railFrom = l5 && nodeExists(from.bodyIndex, 4) ? 4 : 3;
		const railTo = l5 && nodeExists(to.bodyIndex, 4) ? 4 : 3;
		nodeXYInto(from.bodyIndex, from.node, mapPathXY, 0);
		nodeXYInto(from.bodyIndex, railFrom, mapPathXY, 2);
		nodeXYInto(to.bodyIndex, railTo, mapPathXY, 4);
		nodeXYInto(to.bodyIndex, to.node, mapPathXY, 6);
	}
	function mapPathPoint(out, f) {
		const seg = f <= RAIL_STEP ? 0 : f >= 1 - RAIL_STEP ? 2 : 1;
		const t = seg === 0 ? f / RAIL_STEP
			: seg === 2 ? (f - (1 - RAIL_STEP)) / RAIL_STEP
			: (f - RAIL_STEP) / (1 - 2 * RAIL_STEP);
		const a = seg * 2;
		out[0] = mapPathXY[a] + (mapPathXY[a + 2] - mapPathXY[a]) * t;
		out[1] = mapPathXY[a + 1] + (mapPathXY[a + 3] - mapPathXY[a + 1]) * t;
		return out;
	}
	// The leg the flight clock is in; -1 when there is no itinerary.
	function mapLegIndexAt(t) {
		if (!activeRoute.count) return -1;
		for (let i = 0; i < activeRoute.count; i++) {
			if (t < activeRoute.legs[i].end || i === activeRoute.count - 1) return i;
		}
		return activeRoute.count - 1;
	}
	function drawMapRoute() {
		if (!activeRoute.count || !activeRoute.start || !activeRoute.end) return;
		// Interstellar itineraries are readout-only (the map is one system).
		if (activeRoute.start.systemKey !== activeRoute.end.systemKey) return;
		ctx.lineWidth = 1.5;
		ctx.setLineDash(routeDash);
		ctx.strokeStyle = activeRoute.ship.color;
		for (let li = 0; li < activeRoute.count; li++) {
			const leg = activeRoute.legs[li];
			if (!leg.from || !leg.to) continue;
			if (leg.kind === 'transfer') {
				buildTransferPath(leg.from, leg.to);
				ctx.beginPath();
				ctx.moveTo(mapPathXY[0], mapPathXY[1]);
				ctx.lineTo(mapPathXY[2], mapPathXY[3]);
				ctx.lineTo(mapPathXY[4], mapPathXY[5]);
				ctx.lineTo(mapPathXY[6], mapPathXY[7]);
				ctx.stroke();
				continue;
			}
			// A local leg rides its well edge (launch, landing, the same-body
			// escape hop): trace it so the ship has a line to ride, not a jump.
			if (leg.from.bodyIndex === undefined || leg.to.bodyIndex === undefined) continue;
			nodeXYInto(leg.from.bodyIndex, leg.fromNode, mapPathXY, 0);
			nodeXYInto(leg.to.bodyIndex, leg.toNode, mapPathXY, 2);
			if (mapPathXY[0] === mapPathXY[2] && mapPathXY[1] === mapPathXY[3]) continue;
			ctx.beginPath();
			ctx.moveTo(mapPathXY[0], mapPathXY[1]);
			ctx.lineTo(mapPathXY[2], mapPathXY[3]);
			ctx.stroke();
		}
		ctx.setLineDash(noDash);
		const li = mapLegIndexAt(flightElapsed);
		if (li < 0) return;
		const leg = activeRoute.legs[li];
		if (!leg.from || !leg.to) return;
		const f = leg.end > leg.start
			? clamp01((flightElapsed - leg.start) / (leg.end - leg.start)) : 1;
		if (leg.kind === 'transfer') {
			buildTransferPath(leg.from, leg.to);
			mapPathPoint(mapShipXY, f);
		} else {
			if (leg.from.bodyIndex === undefined || leg.to.bodyIndex === undefined) return;
			nodeXYInto(leg.from.bodyIndex, leg.fromNode, mapPathXY, 0);
			nodeXYInto(leg.to.bodyIndex, leg.toNode, mapPathXY, 2);
			mapShipXY[0] = mapPathXY[0] + (mapPathXY[2] - mapPathXY[0]) * f;
			mapShipXY[1] = mapPathXY[1] + (mapPathXY[3] - mapPathXY[1]) * f;
		}
		ctx.fillStyle = activeRoute.ship.color;
		ctx.beginPath();
		ctx.moveTo(mapShipXY[0] + 6, mapShipXY[1]);
		ctx.lineTo(mapShipXY[0] - 4, mapShipXY[1] - 4);
		ctx.lineTo(mapShipXY[0] - 4, mapShipXY[1] + 4);
		ctx.closePath();
		ctx.fill();
	}

	// Fit, draw and mark valid: the map is centred in the clear canvas region —
	// between the control panel and the settings menu when both are open — and
	// the same transform serves picking, so a click can never disagree with the
	// draw.
	function drawDvMap(width, height, rightInset, leftInset) {
		const logicalW = view === VIEW_DV_TIME ? DV_TIME_WIDTH
			: Math.max(740, DV_COL_X0 + (dvNBodies + 0.5) * DV_COL_W);
		const timeRows = tradePort && tradePort.intra && tradePort.intra.legCount > 0
			? tradePort.intra.legCount : DV_TIME_EMPTY_LANES;
		const logicalH = view === VIEW_DV_TIME
			? Math.max(DV_TABLE_TOP + 10 + tableLines.length * 16,
				DV_TIME_LANE_Y + timeRows * DV_TIME_LANE_DY + 90)
			: DV_TABLE_TOP + 10 + tableLines.length * 16;
		const availW = width - rightInset - leftInset;
		const availH = height * 0.70;
		mapLayout.scale = Math.min(1, (availW - 32) / logicalW, (availH - 32) / logicalH);
		if (!(mapLayout.scale > 0)) { mapLayout.valid = false; return; }
		mapLayout.x = leftInset + (availW - logicalW * mapLayout.scale) * 0.5;
		mapLayout.y = (availH - logicalH * mapLayout.scale) * 0.5 + 12;
		mapLayout.width = logicalW; mapLayout.height = logicalH;
		// The boats below are placed in the graph's own units, so the frame's
		// craft list is registered in that space and `pickCraft` maps the click
		// back through the same transform.
		beginCraftFrame(1);
		ctx.save();
		ctx.translate(mapLayout.x, mapLayout.y); ctx.scale(mapLayout.scale, mapLayout.scale);
		ctx.fillStyle = DV_PANEL_FILL; ctx.fillRect(0, 0, logicalW, logicalH);
		if (view === VIEW_DV_TIME) drawDvTime();
		else if (view === VIEW_DV_RAILS) drawDvRails();
		else drawDvClassic();
		if (view !== VIEW_DV_TIME) drawMapRoute();
		ctx.fillStyle = DV_TEXT_FILL; ctx.font = DV_LABEL_FONT;
		for (let i = 0; i < tableLines.length; i++) ctx.fillText(tableLines[i], 20, DV_TABLE_TOP + i * 16);
		ctx.restore();
		mapLayout.valid = true;
	}
	function pickDvNode(x, y, out) {
		out.body = -1; out.node = -1;
		if (!open || view === VIEW_SYSTEM || view === VIEW_DV_TIME || !mapLayout.valid || !(mapLayout.scale > 0)) return false;
		const lx = (x - mapLayout.x) / mapLayout.scale, ly = (y - mapLayout.y) / mapLayout.scale;
		let best = (10 / mapLayout.scale) ** 2;
		for (let bi = 0; bi < dvNBodies; bi++) {
			for (let k = 0; k < 5; k++) {
				if (!nodeExists(bi, k)) continue;
				dvNodeXYFor(bi, k, dvTmpXY);
				const d = (lx - dvTmpXY[0]) ** 2 + (ly - dvTmpXY[1]) ** 2;
				if (d <= best) { best = d; out.body = bi; out.node = k; }
			}
		}
		return out.body >= 0;
	}

	// The open view (plan §6.5/§7.5). setView takes one of the VIEW_* ids;
	// cycleView is what the B key walks. A view change invalidates the map
	// transform (the logical size differs) and re-reads the table header, which
	// names the render.
	function setView(v) {
		const n = Number(v);
		const wanted = Number.isFinite(n) ? (n < 0 ? 0 : n > VIEW_COUNT - 1 ? VIEW_COUNT - 1 : Math.round(n)) : VIEW_DEFAULT;
		if (wanted !== view) {
			view = wanted;
			mapLayout.valid = false;
			if (view === VIEW_SYSTEM) { hoverKind = BODY_NONE; hoverIndex = -1; hoverLabel = ''; }
		}
		refreshMapText();
		return view;
	}
	function getView() { return view; }
	function cycleView() { return setView((view + 1) % VIEW_COUNT); }
	function isMapOpen() { return view !== VIEW_SYSTEM; }
	function setBudget(b) {
		const v = Number(b);
		dvBudget = Number.isFinite(v) ? (v < BUDGET_MIN ? BUDGET_MIN : v > BUDGET_MAX ? BUDGET_MAX : v) : BUDGET_DEFAULT;
		refreshMapText(); rebuildRoute();
		return dvBudget;
	}
	function getBudget() { return dvBudget; }
	function setShipClass(id) {
		dvShipClass = layerDv.shipById(id).id;
		refreshMapText(); rebuildRoute();
		return dvShipClass;
	}
	function getShipClass() { return dvShipClass; }

	// --- Picking (plan §6.3): exact, screen-space, no projection --------------
	// Bodies win over belt bands (a planet in front of a belt is the planet);
	// nearest body wins; empty space is BODY_NONE — main.js clears the view
	// selection on it but does not leave the view.
	function pick(x, y, out) {
		out.kind = BODY_NONE;
		out.index = -1;
		if (!open || view !== VIEW_SYSTEM || !(layout.rSpan > 0)) return out;
		const dxs = x - layout.cx;
		const dys = y - layout.cy;
		let bestD2 = Infinity;
		const rs = starRadiusPx + PICK_PAD_PX;
		const d2s = dxs * dxs + dys * dys;
		if (d2s <= rs * rs) {
			bestD2 = d2s;
			out.kind = BODY_STAR;
			out.index = 0;
		}
		const n = record.counts.planets;
		for (let i = 0; i < n; i++) {
			const dx = x - planetScreenXY[i * 2];
			const dy = y - planetScreenXY[i * 2 + 1];
			const d2 = dx * dx + dy * dy;
			const r = planetIconR[i] + PICK_PAD_PX;
			if (d2 <= r * r && d2 < bestD2) {
				bestD2 = d2;
				out.kind = BODY_PLANET;
				out.index = i;
			}
		}
		if (out.kind !== BODY_NONE) return out;
		const rClick = Math.sqrt(d2s);
		let bestGap = BELT_PICK_PX;
		for (let k = 0; k < record.belts.count; k++) {
			const gap = Math.abs(rClick - radiusPx(beltRhoC[k]));
			if (gap < bestGap) {
				bestGap = gap;
				out.kind = BODY_BELT;
				out.index = k;
			}
		}
		return out;
	}

	function setSelected(kind, index) {
		if (kind === BODY_STAR) { selectedKind = kind; selectedIndex = 0; return; }
		if (kind === BODY_PLANET && index >= 0 && index < record.counts.planets) {
			selectedKind = kind; selectedIndex = index; refreshMapText(); return;
		}
		if (kind === BODY_BELT && index >= 0 && index < record.belts.count) {
			selectedKind = kind; selectedIndex = index; refreshMapText(); return;
		}
		clearBodySelection();
	}
	function clearBodySelection() { selectedKind = BODY_NONE; selectedIndex = -1; refreshMapText(); }
	function selectedKindOf() { return selectedKind; }
	function selectedIndexOf() { return selectedIndex; }

	// Hover: the same hit test as the click, run per frame from the last cursor
	// position (bodies move under a still cursor). The label string is rebuilt
	// only when the hovered body changes (plan §4.11: never per frame). A
	// craft in front of a body wins: a hull is a 3 px target on a busy schema,
	// and the thing under the cursor has to be the thing a click would take.
	function updateHover(x, y) {
		hoverX = x;
		hoverY = y;
		if (!open) return false;
		pickCraft(x, y, hitCraft);
		if (hitCraft.kind !== CRAFT_NONE) {
			const same = hitCraft.kind === hoverCraftKind && hitCraft.leg === hoverCraftLeg
				&& hitCraft.slot === hoverCraftSlot;
			if (same) return false;
			hoverCraftKind = hitCraft.kind; hoverCraftLeg = hitCraft.leg; hoverCraftSlot = hitCraft.slot;
			hoverCraftLabel = craftLabelAt(hitCraft.kind, hitCraft.leg, hitCraft.slot);
			hoverKind = BODY_NONE; hoverIndex = -1; hoverLabel = '';
			return true;
		}
		const hadCraft = hoverCraftKind !== CRAFT_NONE;
		hoverCraftKind = CRAFT_NONE; hoverCraftLeg = -1; hoverCraftSlot = -1; hoverCraftLabel = '';
		pick(x, y, hitOut);
		if (!hadCraft && hitOut.kind === hoverKind && hitOut.index === hoverIndex) return false;
		hoverKind = hitOut.kind;
		hoverIndex = hitOut.index;
		hoverLabel = hoverKind === BODY_NONE ? '' : designationOf(hoverKind, hoverIndex);
		return true;
	}
	function hoverKindOf() { return hoverKind; }
	function hoverIndexOf() { return hoverIndex; }

	// The designation of one body (plan §4.11): the cached prefix for the star,
	// the writers' suffix for planets and belts — built on change, never drawn
	// from fresh bytes per frame.
	function designationOf(kind, index) {
		if (kind === BODY_STAR) return starPrefix;
		if (record.star.nameLen > 0) {
			if (kind === BODY_PLANET) return starPrefix + ' ' + String.fromCharCode(98 + index);
			if (kind === BODY_BELT) return starPrefix + ' belt ' + (index + 1);
			return '';
		}
		const D = planets.DESIGNATION;
		let end = planets.writeStarDesignation(record.star.key, D, 0);
		if (kind === BODY_PLANET) end = planets.writePlanetLetter(index, D, end);
		else if (kind === BODY_BELT) { D[end] = 32; end = planets.writeBeltName(index, D, end + 1); }
		return planets.designationToString(D, end);
	}

	// --- The readout (plan §6.6), text at the overlay's 4 Hz ------------------
	// The worked example in the plan is the format contract: every column below
	// is that example's, so the block is checkable rather than decorative. The
	// delta-v lines join when 0.5.4 lands.
	function readoutLines() {
		const star = record.star;
		const p = record.planets;
		const n = record.counts.planets;
		const belts = record.belts;
		const lines = [];

		let head = starPrefix.padEnd(10) + star.spectralClass.padEnd(2)
			+ star.mass.toFixed(2).padStart(5) + ' M\u2609'
			+ star.lum.toFixed(3).padStart(7) + ' L\u2609'
			+ Math.round(star.teff).toString().padStart(6) + ' K'
			+ star.rStar.toFixed(2).padStart(6) + ' R\u2609'
			+ '  age ' + star.age.toFixed(1) + ' Gyr'
			+ '  Z ' + star.metal.toFixed(3);
		if (selectedKind === BODY_STAR) head += '  \u25c0 selected';
		lines.push(head);
		lines.push('HZ ' + star.aHzIn.toFixed(2) + ' \u2013 ' + star.aHzOut.toFixed(2) + ' AU'
			+ '   snow ' + star.aSnow.toFixed(2) + ' AU'
			+ '   a_out ' + fmtAxis(star.aOut) + ' AU'
			+ '   system time ' + formatSysTimeRate(timeRate)
			+ '   ' + n + (n === 1 ? ' planet' : ' planets')
			+ ', ' + belts.count + (belts.count === 1 ? ' belt' : ' belts'));

		if (n > 0) lines.push('');
		for (let i = 0; i < n; i++) {
			const flags = p.flags[i];
			const mid = [];
			if (flags & planets.FLAG_LOCKED) mid.push('locked');
			if (p.moons[i] > 0) mid.push(fmtMoons(p.moons[i]));
			const tags = [];
			if (flags & planets.FLAG_IN_HZ) tags.push('HZ');
			if (flags & planets.FLAG_TERRAN) tags.push('terran');
			if (flags & planets.FLAG_HOT_JUPITER) tags.push('hot Jupiter');
			let tail = '';
			if (mid.length && tags.length) tail = '  ' + mid.join(' ').padEnd(9) + tags.join(' ');
			else if (mid.length) tail = '  ' + mid.join(' ');
			else if (tags.length) tail = '  ' + tags.join(' ');
			if (selectedKind === BODY_PLANET && selectedIndex === i) tail += '  \u25c0 selected';
			lines.push('  ' + String.fromCharCode(98 + i) + '  '
				+ planets.DISPLAY_TYPES[p.displayType[i]].name.padEnd(11)
				+ p.a[i].toFixed(2).padStart(6) + ' AU'
				+ p.mass[i].toFixed(2).padStart(8) + ' M\u2295'
				+ p.radius[i].toFixed(2).padStart(7) + ' R\u2295'
				+ '   S ' + fmtS(p.insolation[i]).padEnd(6)
				+ ' Teq' + Math.round(p.teq[i]).toString().padStart(5) + ' K'
				+ '  Tsurf' + Math.round(p.tsurf[i]).toString().padStart(5) + ' K'
				+ '  e ' + p.e[i].toFixed(2)
				+ '  P' + p.period[i].toFixed(2).padStart(7) + ' y'
				+ tail);
		}

		for (let k = 0; k < belts.count; k++) {
			if (k === 0) lines.push('');
			let line = 'belt ' + (k + 1)
				+ belts.a[k].toFixed(2).padStart(7) + ' AU'
				+ '   \u0394ln a ' + belts.dlnA[k].toFixed(2)
				+ '   mass ' + fmtExp(belts.mass[k]) + ' M\u2295'
				+ '   typical body ' + Math.round(planets.BELT_BODY_R_M / 1000) + ' km'
				+ ' / ' + fmtExp(planets.BELT_BODY_MASS_KG) + ' kg';
			if (selectedKind === BODY_BELT && selectedIndex === k) line += '  \u25c0 selected';
			lines.push(line);
		}

		// Delta-v summary (plan §6.6/§7.2): from the selected body's low orbit,
		// one line per destination — the single-burn departure + aerocapture
		// chain, the Hohmann time, dv_x, and the surface-to-surface total.
		// Compact: two lines per neighbour, matching the worked example shape.
		if (dvNBodies > 0) {
			let fromBody = -1;
			if (selectedKind === BODY_PLANET && selectedIndex >= 0) fromBody = selectedIndex;
			else if (selectedKind === BODY_BELT) fromBody = record.counts.planets + selectedIndex;
			if (fromBody >= 0 && fromBody < dvNBodies) {
				lines.push('');
				const ns = dvNodes[fromBody];
				const ed = dvOneEdges[fromBody];
				const headParts = [];
				if (ns.hasSurface) headParts.push('surface\u2192LEO ' + layerDv.formatKms(ed.dvSurfaceToLo));
				if (ns.hasGeo) headParts.push('LEO\u2192GEO ' + layerDv.formatKms(ed.dvLoToGeo));
				headParts.push('LEO\u2192escape ' + layerDv.formatKms(ed.dvLoToEscape));
				lines.push('dv  ' + ns.letter + '   ' + headParts.join(' \u00b7 '));
				for (let jj = 0; jj < dvNBodies; jj++) {
					const jBody = jj === fromBody ? -1 : jj;
					if (jBody < 0) continue;
					const leg = {};
					layerDv.legLoToLo(dvMuStarVal, dvBodies[fromBody], dvBodies[jBody], false, leg);
					const ship = layerDv.shipById(dvShipClass);
					const tB = {};
					layerDv.legTimes(leg, ship, dvBudget, tB);
					const aeroNote = leg.aeroFracB > 0
						? ' (' + layerDv.formatKms(leg.dvCapRawB) + ' capture, aerocap ' + layerDv.formatKms(leg.dvCapB) + ')'
						: '';
					lines.push('    ' + dvNodes[jBody].letter + '  LEO\u2192LO '
						+ layerDv.formatKms(leg.dvLoToLo) + ' km/s ('
						+ layerDv.formatKms(leg.dvDepLo) + ' departure burn + '
						+ layerDv.formatKms(leg.dvCapB) + ' capture' + aeroNote + ')'
						+ '   t_H ' + layerDv.formatDuration(leg.tH)
						+ '   dv_x ' + layerDv.formatKms(leg.dvX));
					if (ns.hasSurface && dvNodes[jBody].hasSurface) {
						const surf = ed.dvSurfaceToLo + leg.dvLoToLo + dvOneEdges[jBody].dvLoToSurface;
						lines.push('            surface\u2192surface ' + layerDv.formatKms(surf) + ' km/s');
					}
					lines.push('            ' + layerDv.formatDuration(leg.tH) + ' at budget 0 \u00b7 '
						+ (tB.belowCrossover ? layerDv.formatDuration(leg.tH) : layerDv.formatDuration(tB.t))
						+ ' at budget ' + dvBudget.toFixed(2) + ' in a ' + ship.label + ' hull'
						+ (tB.belowCrossover ? ' (below dv_x, no gain)' : ''));
				}
			}
		}
		if (routeStart) {
			lines.unshift(...layerRoute.reportLines(activeRoute, flightStarted ? flightElapsed : undefined), ...routeFeasibility, '');
		}
		return lines;
	}

	function readoutText() {
		return readoutLines().join('\n');
	}

	return {
		resize, draw, enter, prepare, exit, isOpen, setTradeData,
		stepTime, setTimeRate, getTimeRate, sysTime,
		pick, pickCraft, selectCraft, clearCraft, selectedCraft, craftLabelAt,
		setSelected, clearBodySelection, selectedKindOf, selectedIndexOf,
		updateHover, hoverKindOf, hoverIndexOf, designationOf,
		readoutLines, readoutText, rhoOf,
		record, layout,
		planetScreenXY, planetIconR, planetRho,
		beltStippleXY, beltAngles, beltRadii, beltRho, beltRhoC, beltPeriod,
		pickDvNode, chooseRouteNode, clearRoute, setRoundTrip, toggleAutopilot, routeState, autopilotRunning, autopilotState, planExternalRoute, mapLayout, mapShipXY, dvNodeXYFor,
		setView, getView, cycleView, isMapOpen, setBudget, getBudget, setShipClass, getShipClass, buildDv,
	};
}

const SystemLayer = {
	createSystemLayer,
	R_STAR_PX, R_EDGE_FRAC, A_IN_VIEW_K, A_IN_VIEW_MIN_AU, A_OUT_VIEW_K, BELT_VIEW_K,
	HZ_FILL, HZ_EDGE, ORBIT_STROKE, BELT_FILL, STAR_HALO_ALPHA,
	GIANT_RING_STROKE, LOCKED_SHADE, TERRAN_OUTLINE, SELECT_RING_PAD_PX,
	BELT_DOT_PX, GIANT_RING_K,
	ICON_MASS_EDGES, ICON_RADII_PX, STAR_RADIUS_PX,
	PICK_PAD_PX, BELT_PICK_PX,
	SYSTIME_LADDER, SYSTIME_INDEX_MIN, SYSTIME_INDEX_MAX, SYSTIME_INDEX_DEFAULT,
	SYSTIME_MIN, SYSTIME_MAX, SYSTIME_DEFAULT,
	VIEW_SYSTEM, VIEW_DV_CLASSIC, VIEW_DV_RAILS, VIEW_DV_TIME, VIEW_COUNT, VIEW_DEFAULT, VIEW_NAMES,
	BUDGET_MIN, BUDGET_MAX, BUDGET_STEP, BUDGET_DEFAULT,
	DV_COL_X0, DV_COL_W, DV_TABLE_TOP, DV_NODE_DY, DV_COL_TOP,
	BODY_NONE, BODY_STAR, BODY_PLANET, BODY_BELT, TYPE_FILLS,
	CRAFT_NONE, CRAFT_FERRY, CRAFT_HULL, VOYAGE_DOCKED, VOYAGE_OUT, VOYAGE_IN,
	viewInnerAU, viewOuterAU, iconRadiusForMass, starRadiusForState,
	formatSysTimeRate, sysTimeRateAt, sysTimeIndexOf,
};
if (typeof module !== 'undefined') module.exports = SystemLayer;
if (typeof window !== 'undefined') window.SystemLayer = SystemLayer;
})();
