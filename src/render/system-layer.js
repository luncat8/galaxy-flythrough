// src/render/system-layer.js
// The close-system view (0.5.3/0.5.6, plan §6/§7): a 2D canvas above the label
// layer that draws the opened star's generated system — log-polar orbits, the
// habitable annulus, belt stipples, colour-coded planet icons — plus exact
// screen-space picking and the #sysread text. The same canvas carries the two
// delta-v map renders (§7.5): the 0.5.4 star-shaped graph and the rail render,
// which puts every node kind on its own row so the escape rail and the L5 rail
// run straight across the columns and both read as ways out of the system.
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
// One view is open at a time on the one canvas: the schematic or one of the two
// delta-v map renders. The rail render puts every node kind on its own row, so
// the escape and L5 rails run straight across the columns.
const VIEW_SYSTEM = 0;
const VIEW_DV_CLASSIC = 1;
const VIEW_DV_RAILS = 2;
const VIEW_COUNT = 3;
const VIEW_DEFAULT = VIEW_SYSTEM;
const VIEW_NAMES = ['system', 'delta-v classic', 'delta-v rails'];

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
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		selectedKind = BODY_NONE;
		selectedIndex = -1;
		hoverKind = BODY_NONE;
		hoverIndex = -1;
		hoverLabel = '';
	}

	function isOpen() { return open; }

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
		drawBodyMarks();
		drawRoute();
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
	// A node's logical position in the graph. The rail render gives every kind
	// its own row, so the escape and L5 rails stay level across the columns (a
	// body without a GEO leaves a gap instead of shifting its neighbours); the
	// classic render packs the rows per body, which is the shape 0.5.4 drew.
	function dvNodeXYFor(bi, kind, out) {
		let slot = kind;
		if (view !== VIEW_DV_RAILS) {
			slot = 0;
			if (bi >= 0) for (let k = 0; k < kind; k++) if (nodeExists(bi, k)) slot++;
		}
		out[0] = DV_COL_X0 + (bi < 0 ? 0 : dvColumnIndexOf(bi) + 1) * DV_COL_W;
		out[1] = DV_COL_TOP + slot * DV_NODE_DY;
		return out;
	}
	const dvTmpXY = new Float64Array(2);
	const dvTmpXY2 = new Float64Array(2);
	const tableTimes = {};
	function refreshMapText() {
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
		for (let col = 0; col < dvNBodies; col++) {
			const bi = dvOrder[col];
			dvNodeXYFor(bi, 0, dvTmpXY);
			ctx.fillStyle = DV_TEXT_FILL; ctx.fillText(dvNodes[bi].letter, dvTmpXY[0] - 8, DV_COL_TOP - 16);
		}
		drawMapNodes();
		ctx.fillStyle = DV_NODE_STAR_FILL; dvNodeXYFor(-1, 3, dvTmpXY);
		ctx.beginPath(); ctx.arc(dvTmpXY[0], dvTmpXY[1], DV_NODE_R + 2, 0, TAU); ctx.fill();
		ctx.fillStyle = DV_TEXT_FILL; ctx.fillText('star', dvTmpXY[0] - 14, dvTmpXY[1] + 20);
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
		const logicalW = Math.max(740, DV_COL_X0 + (dvNBodies + 0.5) * DV_COL_W);
		const logicalH = DV_TABLE_TOP + 10 + tableLines.length * 16;
		const availW = width - rightInset - leftInset;
		const availH = height * 0.70;
		mapLayout.scale = Math.min(1, (availW - 32) / logicalW, (availH - 32) / logicalH);
		if (!(mapLayout.scale > 0)) { mapLayout.valid = false; return; }
		mapLayout.x = leftInset + (availW - logicalW * mapLayout.scale) * 0.5;
		mapLayout.y = (availH - logicalH * mapLayout.scale) * 0.5 + 12;
		mapLayout.width = logicalW; mapLayout.height = logicalH;
		ctx.save();
		ctx.translate(mapLayout.x, mapLayout.y); ctx.scale(mapLayout.scale, mapLayout.scale);
		ctx.fillStyle = DV_PANEL_FILL; ctx.fillRect(0, 0, logicalW, logicalH);
		if (view === VIEW_DV_RAILS) drawDvRails(); else drawDvClassic();
		drawMapRoute();
		ctx.fillStyle = DV_TEXT_FILL; ctx.font = DV_LABEL_FONT;
		for (let i = 0; i < tableLines.length; i++) ctx.fillText(tableLines[i], 20, DV_TABLE_TOP + i * 16);
		ctx.restore();
		mapLayout.valid = true;
	}
	function pickDvNode(x, y, out) {
		out.body = -1; out.node = -1;
		if (!open || view === VIEW_SYSTEM || !mapLayout.valid || !(mapLayout.scale > 0)) return false;
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
	// only when the hovered body changes (plan §4.11: never per frame).
	function updateHover(x, y) {
		hoverX = x;
		hoverY = y;
		if (!open) return false;
		pick(x, y, hitOut);
		if (hitOut.kind === hoverKind && hitOut.index === hoverIndex) return false;
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
		resize, draw, enter, prepare, exit, isOpen,
		stepTime, setTimeRate, getTimeRate, sysTime,
		pick, setSelected, clearBodySelection, selectedKindOf, selectedIndexOf,
		updateHover, hoverKindOf, hoverIndexOf, designationOf,
		readoutLines, readoutText, rhoOf,
		record, layout,
		planetScreenXY, planetIconR, planetRho,
		beltStippleXY, beltAngles, beltRadii, beltRho, beltRhoC, beltPeriod,
		pickDvNode, chooseRouteNode, clearRoute, setRoundTrip, toggleAutopilot, routeState, autopilotRunning, planExternalRoute, mapLayout, mapShipXY, dvNodeXYFor,
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
	VIEW_SYSTEM, VIEW_DV_CLASSIC, VIEW_DV_RAILS, VIEW_COUNT, VIEW_DEFAULT, VIEW_NAMES,
	BUDGET_MIN, BUDGET_MAX, BUDGET_STEP, BUDGET_DEFAULT,
	DV_COL_X0, DV_COL_W, DV_TABLE_TOP, DV_NODE_DY, DV_COL_TOP,
	BODY_NONE, BODY_STAR, BODY_PLANET, BODY_BELT, TYPE_FILLS,
	viewInnerAU, viewOuterAU, iconRadiusForMass, starRadiusForState,
	formatSysTimeRate, sysTimeRateAt, sysTimeIndexOf,
};
if (typeof module !== 'undefined') module.exports = SystemLayer;
if (typeof window !== 'undefined') window.SystemLayer = SystemLayer;
})();
