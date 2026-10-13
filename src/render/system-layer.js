// src/render/system-layer.js
// The close-system schematic (0.5 plan §6): a 2D canvas over the WebGPU canvas,
// the technique label-layer.js already uses for names and rings. Planets are
// CPU-only by §1.1 — a system is ≤ 12 planets, 2 belts and a star, which is 15
// circles, not a pipeline.
//
// Drawn every frame only while the system view is open; otherwise draw() is one
// boolean test and a return, so a closed view costs the frame loop nothing.
//
// 0.5.3-1 shipped the state machine: open/closed, canvas lifetime and the
// SystemRecord intake. 0.5.3-2 (the radial axis, annulus, ellipses, star and
// planet icons) and 0.5.3-3 (the belt stipples, hashed once per system, and
// the system clock of §6.4) draw the schematic. 0.5.3-4 picks it: §6.3's
// distance test over the icons the draw placed, the selection ring of §6.2
// item 6 and the hovered body's designation.

'use strict';

// The generator owns the tables the icons read (display-type colours, bulk
// codes, flags); star-record.js owns the class colour LUT; label-layer.js owns
// the label and ring styles the schematic borrows, so a hovered designation
// reads exactly like a landmark's. Resolved once, the way label-layer.js
// resolves Coords: the page has every script evaluated long before a system
// opens, and Node's require is the same lookup. Named for this file — classic
// <script> tags share one global scope, and search.js already declares
// planetsLib() for its own use.
const sysPlanets = (typeof module !== 'undefined' && module.exports)
	? require('../math/planets.js')
	: window.PlanetsLib;
const sysRecords = (typeof module !== 'undefined' && module.exports)
	? require('../math/star-record.js')
	: window.StarRecord;
const sysHash = (typeof module !== 'undefined' && module.exports)
	? require('../math/hash.js')
	: window.HashLib;
const sysLabels = (typeof module !== 'undefined' && module.exports)
	? require('../render/label-layer.js')
	: window.LabelLayer;
// The delta-v map (§7.5) is drawn on this same canvas from the closed forms of
// deltav.js, which loads before this file in the page.
const sysDeltaV = (typeof module !== 'undefined' && module.exports)
	? require('../math/deltav.js')
	: window.DeltaVLib;

// ---- the schematic's constants (§6.1, §6.2) --------------------------------
const SYS_TAU = Math.PI * 2;
const SYS_HALF_PI = Math.PI / 2;
const DEG = Math.PI / 180;

const R_STAR_PX = 34;                    // radius the star's icon occupies
const EDGE_FRACTION = 0.46;              // R_EDGE_PX = min(w, h) · this
const A_VIEW_IN = 0.6;                   // a_in_view = max(a_0 · this, 0.008 AU)
const A_IN_MIN_AU = 0.008;               // the radial axis' inner floor
const A_VIEW_OUT = 1.2;                  // a_out_view = max(a_out · this, …)
const BELT_VIEW_OUT = 1.1;               // … outermost belt · this

const HZ_FILL = 'rgba(96, 200, 128, 0.07)';
const HZ_EDGE = 'rgba(96, 200, 128, 0.25)';
const ORBIT_STROKE = 'rgba(150, 175, 215, 0.22)';
const BELT_STIPPLE = 'rgba(190, 180, 160, 0.35)';
const TERRAN_RING = 'rgba(96, 200, 128, 0.85)';
const LOCKED_SHADE = 'rgba(6, 8, 14, 0.55)';   // the unlit half of a locked world
const STAR_HALO_ALPHA = 0.18;
const STIPPLE_RADIUS = 1;                      // px — §6.2 item 3's dots

// §6.3: a click is a distance test against the icon the draw placed —
// iconRadius + 4 px for a planet, |r_click − r_belt| < 6 px for a belt. No
// projection, no camera, nearest wins.
const PICK_PAD_PX = 4;
const BELT_PICK_PX = 6;
// §6.2 item 6: the selected body takes the label layer's ring colour and a
// radius 4 px past its icon, so the ring bounds exactly what the click hit.
// Named for this file, not for the label layer's own constants: classic
// <script> tags share one global scope, and SELECT_RING is already taken.
const SYS_SELECT_RING = sysLabels.SELECT_RING;
const SYS_SELECT_LINE = 1.5;
// §6.2 item 6: the hovered body's designation, in the label layer's own type
// and halo, so a schematic label and a landmark label are one look.
const HOVER_FONT = sysLabels.LABEL_FONT;
const HOVER_FILL = sysLabels.LABEL_FILL;
const HOVER_HALO = sysLabels.LABEL_HALO;
const HOVER_HALO_PX = 3;
const HOVER_OFFSET_PX = 6;

// Body codes, shared with planets.js's bodyDesignation: 1 a planet, 2 a belt.
// The star is not selectable — it is the schematic's centre, and neither the
// delta-v map (§7) nor a route (§8) takes it as an endpoint, so a ring around
// it would select nothing (§11.1).
const BODY_PLANET = 1;
const BODY_BELT = 2;
const BODY_NONE = 0;

// §7.5's map, drawn on the same canvas over the schematic. All colours and
// spacings are module constants; the node positions and the edge labels live
// in preallocated arrays recomputed on a dirty flag, never per frame.
const MAP_EDGE = 'rgba(150, 175, 215, 0.35)';
const MAP_EDGE_LABEL = 'rgba(198, 208, 228, 0.8)';
const MAP_NODE_FILL = 'rgba(18, 24, 38, 0.9)';
const MAP_NODE_EDGE = 'rgba(160, 180, 215, 0.7)';
const MAP_GROUND_FILL = 'rgba(120, 140, 180, 0.9)';
const MAP_COLUMN_LABEL = 'rgba(220, 226, 240, 0.85)';
const MAP_NODE_DY = 46;              // px between a column's stacked nodes
const MAP_STAR_X = 64;               // the star sits at the left
const MAP_COL_X0 = 122;              // the first body column
const MAP_MARGIN_R = 26;
const MAP_NODE_R = 4;
const MAP_STAR_R = 10;
// Column order, bottom (the grounded node) to top (the escape).
const MAP_NODE_ORDER = [
	sysDeltaV.NODE_SURFACE, sysDeltaV.NODE_BELT_BODY, sysDeltaV.NODE_LOW_ORBIT,
	sysDeltaV.NODE_GEO, sysDeltaV.NODE_L5, sysDeltaV.NODE_ESCAPE,
];

// §6.4's clock: years per second of the open system, -1 camera-coupled (the
// menu's follow), 0 the frozen default, the rest a direct rate. Owned here
// because the layer is what the rate acts on — presets.js and main.js read
// the bounds rather than restating them.
const SYSTEM_TIME_RATE_MIN = -1;
const SYSTEM_TIME_RATE_MAX = 99;
const SYSTEM_TIME_RATE_DEFAULT = 0;

// Star icon radius by state (§6.2 item 4).
const STAR_R_MS = 12, STAR_R_GIANT = 20, STAR_R_WD = 6;

// The five-bucket icon ramp on log mass (§6.2 item 5): icons, not real radii.
const ICON_MASS_EDGES = new Float32Array([0.1, 2, 20, 100]);   // M⊕
const ICON_RADII = new Float32Array([3, 5, 7, 10, 13]);        // px
const ICON_EDGES = ICON_MASS_EDGES.length;
const GIANT_RING_SCALE = 1.7;              // gas and ice giants get the ring
const TERRAN_RING_PAD = 2;

function iconRadius(massEarth) {
	let i = 0;
	while (i < ICON_EDGES && massEarth >= ICON_MASS_EDGES[i]) i++;
	return ICON_RADII[i];
}

// Colour strings, built once at load: AGENTS.md bans string concat in the frame
// loop, and an rgb() per icon per frame is 12 small allocations a second.
const DISPLAY_COUNT = sysPlanets.DISPLAY_COUNT;
const CLASS_COUNT = sysRecords.CLASS_COLORS.length;
const ICON_FILL = new Array(DISPLAY_COUNT);
const ICON_RING = new Array(DISPLAY_COUNT);
for (let d = 0; d < DISPLAY_COUNT; d++) {
	const c = sysPlanets.DISPLAY_COLORS[d];
	ICON_FILL[d] = `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
	ICON_RING[d] = `rgba(${c[0]}, ${c[1]}, ${c[2]}, 0.75)`;
}
const STAR_FILL = new Array(CLASS_COUNT);
const STAR_HALO = new Array(CLASS_COUNT);
for (let c = 0; c < CLASS_COUNT; c++) {
	const rgb = sysRecords.CLASS_COLORS[c];
	STAR_FILL[c] = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
	STAR_HALO[c] = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${STAR_HALO_ALPHA})`;
}

function createSystemLayer(canvas) {
	// A headless caller (the wiring tests) passes a canvas without a context:
	// the layer is inert rather than fatal, because nothing about the wiring
	// depends on the 2D backend.
	const ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
	let open = false;
	// The planets.js SystemRecord the enter path generates, or null when the
	// view is closed: main.js owns the record, the layer only reads it.
	let system = null;
	let dpr = 1;
	// §6.4's own clock, in years of the open system. Frozen at the default rate
	// until the menu slider gives main.js a rate to write here; the phase draw
	// and the belt spin both read it.
	let systemTimeYr = 0;
	// The radial mapping of the current frame, and where the icons ended up:
	// the picker of 0.5.3-4 reads these instead of projecting anything.
	let lnIn = 0, lnSpan = 1, edge = 1;
	// True once a full draw has laid this system out. A pick or a hover tests
	// the frame that is on screen, so both are refused until there is one —
	// and a click on the frame the view opened would otherwise be tested
	// against the previous system's icons.
	let layoutValid = false;
	const planetScreenXY = new Float32Array(sysPlanets.MAX_PLANETS * 2);
	// §4.11's designations, built once per system (the star's own plus one
	// suffix per body). Hover changes are pointer events, not frames, but a
	// cached string per body keeps them allocation-free as well: AGENTS.md
	// bans string concat in the frame loop and a sweep across twelve planets
	// would otherwise concatenate twelve times.
	const bodyText = new Array(sysPlanets.MAX_PLANETS + sysPlanets.MAX_BELTS);
	// The selected and hovered bodies (BODY_* / index, BODY_NONE for none).
	// The selection is the viewer's; the hover is recomputed each frame from
	// the pointer main.js feeds draw().
	let selWhich = BODY_NONE, selIndex = -1;
	let hoverWhich = BODY_NONE, hoverIndex = -1;
	// §6.3's result, preallocated: one click walk writes into it and never
	// allocates. `dist` is the pick score — the icon distance for a planet,
	// the radial offset for a belt — which is what "nearest wins" compares.
	const pickOut = { which: BODY_NONE, index: -1, dist: Infinity };
	// The hover walk's own result, so a hover cannot clobber the last click's.
	const hoverOut = { which: BODY_NONE, index: -1, dist: Infinity };
	// The laid-out frame's size, set by draw(): a pick arrives between frames
	// and is tested against the frame that is on screen.
	let frameW = 0, frameH = 0;

	const STATE_GIANT = sysPlanets.STATE_GIANT;
	const STATE_WD = sysPlanets.STATE_WD;
	const FLAG_LOCKED = sysPlanets.FLAG_LOCKED;
	const FLAG_TERRAN = sysPlanets.FLAG_TERRAN;
	const BULK_GAS = sysPlanets.BULK_GAS;
	const BULK_ICEGIANT = sysPlanets.BULK_ICEGIANT;
	const R_SUN_AU = sysPlanets.R_SUN_AU;
	const A0_MIN_AU = sysPlanets.A0_MIN_AU;
	const STAR_CLEARANCE = sysPlanets.STAR_CLEARANCE;
	const GIANT_A0_FACTOR = sysPlanets.GIANT_A0_FACTOR;
	const MAX_BELTS = sysPlanets.MAX_BELTS;
	const STIPPLE_N = sysPlanets.STIPPLE_N;
	const CH_STIPPLE = sysPlanets.CH_STIPPLE;
	const hash01At = sysHash.hash01At;

	// --- the delta-v map's own state (§7.5) ---------------------------------
	// One body array and one leg struct, allocated once and rebuilt in place:
	// the graph is redrawn per frame but its numbers change only when the
	// system does.
	const MAX_MAP_BODIES = sysPlanets.MAX_PLANETS + MAX_BELTS;
	const MAX_MAP_EDGES = MAX_MAP_BODIES * 4 + MAX_MAP_BODIES;
	const mapBodies = new Array(MAX_MAP_BODIES);
	for (let i = 0; i < MAX_MAP_BODIES; i++) mapBodies[i] = sysDeltaV.createBody();
	const mapLeg = sysDeltaV.createLeg();
	const mapNodeXY = new Float32Array(MAX_MAP_BODIES * MAP_NODE_ORDER.length * 2);
	const edgeFrom = new Uint8Array(MAX_MAP_EDGES);
	const edgeFromNode = new Uint8Array(MAX_MAP_EDGES);
	const edgeTo = new Uint8Array(MAX_MAP_EDGES);
	const edgeToNode = new Uint8Array(MAX_MAP_EDGES);
	const edgeDv = new Float64Array(MAX_MAP_EDGES);
	const edgeText = new Array(MAX_MAP_EDGES);
	let mapBodyCount = 0, mapEdgeCount = 0;
	let mapOpen = false;
	let mapDirty = true;
	let mapW = 0, mapH = 0;
	let starText = '';

	// The stipple of §6.2 item 3: STIPPLE_N angle/radius pairs per belt, hashed
	// once per system into these two arrays and never re-derived per frame. One
	// block per belt keeps the dot loop contiguous — belt b owns
	// [b·STIPPLE_N, (b+1)·STIPPLE_N) in both.
	const beltStippleAngle = new Float32Array(MAX_BELTS * STIPPLE_N);
	const beltStippleRadius = new Float32Array(MAX_BELTS * STIPPLE_N);
	// Where each belt's dots sit at system time 0, from one more channel past
	// the 2·STIPPLE_N the pairs use, so a belt's start angle never reuses a
	// stipple draw.
	const beltPhase = new Float32Array(MAX_BELTS);

	function enabled() {
		return open;
	}

	function setSystem(record) {
		system = record || null;
		// A new system has no selected or hovered body: the indices belong to
		// the stars, not the viewer.
		clearBodyState();
		// The dots are hashed once per system (§6.2 item 3), on the belt's own
		// stipple seed, and a summary-tier record carries no belt geometry to
		// hash — the enter path always hands over the full tier.
		if (system && system.planets) {
			hashBelts();
			hashDesignations();
			mapDirty = true;
		}
	}

	// §7.5's toggle: the map replaces the schematic while it is open. The
	// schematic's own bodies stay selected — the map highlights the same body
	// — so toggling back is one boolean test away.
	function setMapOpen(next) {
		if (next === mapOpen) return;
		mapOpen = next;
		mapDirty = true;
	}

	// One §4.11 designation per body, at system entry: the star's own name (or
	// S<key36>) plus the IAU letter / belt number. Reading the same
	// bodyDesignation the readout and search use keeps one source of truth.
	function hashDesignations() {
		starText = sysPlanets.bodyDesignation(system, BODY_NONE, 0);
		for (let p = 0; p < system.planetCount; p++) {
			bodyText[p] = sysPlanets.bodyDesignation(system, BODY_PLANET, p);
		}
		for (let b = 0; b < system.beltCount; b++) {
			bodyText[sysPlanets.MAX_PLANETS + b] = sysPlanets.bodyDesignation(system, BODY_BELT, b);
		}
	}

	// 2·STIPPLE_N draws per belt: the first STIPPLE_N are the dot angles, the
	// rest the radial offsets, both on the belt's own seed (plan §11.1: a
	// channel of the system seed would make the two belts share one range and
	// the record's per-belt seed meaningless).
	function hashBelts() {
		const belts = system.belts;
		for (let b = 0; b < system.beltCount; b++) {
			const seed = belts.stipple[b];
			const base = b * STIPPLE_N;
			for (let s = 0; s < STIPPLE_N; s++) {
				beltStippleAngle[base + s] = SYS_TAU * hash01At(seed, CH_STIPPLE + s);
				beltStippleRadius[base + s] = hash01At(seed, CH_STIPPLE + STIPPLE_N + s);
			}
			beltPhase[b] = SYS_TAU * hash01At(seed, CH_STIPPLE + 2 * STIPPLE_N);
		}
	}

	// §6.4: the clock runs only while the view is open — it is a property of
	// the view, so closing and reopening a system keeps its accumulated years.
	// main.js resolves a negative (camera-coupled) rate into a positive one.
	function advance(dt, rate) {
		if (!open || rate === 0 || !(dt > 0)) return;
		systemTimeYr += rate * dt;
	}

	// The label layer's rule, for the same reason: a canvas keeps its last
	// frame, so switching off has to erase it or the previous system stays
	// frozen on screen under a hidden element.
	function clearCanvas() {
		if (!ctx) return;
		// Device pixels under the identity transform: the drawing transform is
		// whatever the last resize left, and a clear must not depend on it.
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, canvas.width, canvas.height);
	}

	function setEnabled(next) {
		if (next === open) return;
		open = next;
		if (!open) {
			system = null;
			clearBodyState();
			clearCanvas();
		}
	}

	// The selection and hover are per-system: a body index from one system
	// means nothing in the next, and a closed view has no bodies at all.
	function clearBodyState() {
		selWhich = BODY_NONE;
		selIndex = -1;
		hoverWhich = BODY_NONE;
		hoverIndex = -1;
		layoutValid = false;
	}

	// Device-pixel backing store, drawn in CSS pixels under the devicePixelRatio
	// transform — the label layer's contract, so one sizing rule serves both
	// overlays and the click picker (which reports CSS pixels) agrees with them.
	// `widthCss`/`heightCss` are the WebGPU canvas's client size, not this
	// canvas's: a hidden element has none, and the view is closed most of the
	// time.
	function resize(widthCss, heightCss, ratio) {
		if (!ctx) return;
		dpr = ratio > 0 ? ratio : 1;
		const w = Math.max(1, Math.round(widthCss * dpr));
		const h = Math.max(1, Math.round(heightCss * dpr));
		if (canvas.width !== w || canvas.height !== h) {
			canvas.width = w;
			canvas.height = h;
		}
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		// The hovered designation's type, set here and not per frame: the same
		// contract the label layer has.
		ctx.font = HOVER_FONT;
		ctx.textBaseline = 'alphabetic';
	}

	// §6.1: the radial axis is logarithmic — 0.03 AU to 40 AU is a factor of
	// 1300 and no linear scale shows an inner rocky system and an outer giant
	// system at once. The inner edge is the star's own clearance orbit (the
	// walk's a_0, from the record's radius and state), the outer edge the disc
	// or the outermost belt, whichever is wider.
	function computeRadialSpan() {
		const star = system.star;
		const rStarAu = star.rStar * R_SUN_AU;
		let a0 = Math.max(A0_MIN_AU, STAR_CLEARANCE * rStarAu);
		if (star.state === STATE_GIANT) a0 = Math.max(a0, GIANT_A0_FACTOR * rStarAu);
		const aIn = Math.max(a0 * A_VIEW_IN, A_IN_MIN_AU);
		let aOut = star.aOut * A_VIEW_OUT;
		if (system.beltCount > 0) {
			const beltEdge = system.belts.a[system.beltCount - 1] * BELT_VIEW_OUT;
			if (beltEdge > aOut) aOut = beltEdge;
		}
		lnIn = Math.log(aIn);
		const span = Math.log(aOut) - lnIn;
		// ρ ∈ [0,1] is the layout's contract; a degenerate span maps every body
		// to the star's icon radius rather than to NaN.
		lnSpan = span > 1e-9 ? span : 1e-9;
	}

	// Semi-major axis in AU → screen radius in CSS pixels.
	function radiusPx(aAu) {
		let rho = (Math.log(aAu) - lnIn) / lnSpan;
		if (rho < 0) rho = 0;
		else if (rho > 1) rho = 1;
		return R_STAR_PX + rho * (edge - R_STAR_PX);
	}

	// §6.2 item 1: the habitable band, filled and outlined. The band edges are
	// the record's own a_hz_in / a_hz_out — the same constants §4.6 classified
	// the planets by, so the annulus cannot disagree with the flags.
	function drawHabitableZone(cx, cy) {
		const star = system.star;
		const rOut = radiusPx(star.aHzOut);
		const rIn = radiusPx(star.aHzIn);
		if (!(rOut > rIn)) return;
		ctx.beginPath();
		ctx.arc(cx, cy, rOut, 0, SYS_TAU);
		ctx.arc(cx, cy, rIn, 0, SYS_TAU, true);
		ctx.fillStyle = HZ_FILL;
		ctx.fill('evenodd');
		ctx.beginPath();
		ctx.arc(cx, cy, rOut, 0, SYS_TAU);
		ctx.moveTo(cx + rIn, cy);
		ctx.arc(cx, cy, rIn, 0, SYS_TAU);
		ctx.strokeStyle = HZ_EDGE;
		ctx.lineWidth = 1;
		ctx.stroke();
	}

	// §6.2 item 2: one ellipse per planet, centred on the star, semi-major the
	// planet's schematic radius, semi-minor shortened by the eccentricity,
	// rotated by ω and squashed by cos i. Drawn even for a planet that is
	// currently a dot on it, so a frozen system still reads as a system.
	function drawOrbits(cx, cy, planets) {
		const n = system.planetCount;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.translate(cx, cy);
		ctx.strokeStyle = ORBIT_STROKE;
		ctx.lineWidth = 1;
		for (let p = 0; p < n; p++) {
			const rPx = radiusPx(planets.a[p]);
			const e = planets.ecc[p];
			const minor = rPx * Math.sqrt(1 - e * e);
			ctx.save();
			ctx.rotate(planets.peri[p]);
			ctx.scale(1, Math.cos(planets.inc[p] * DEG));
			ctx.beginPath();
			ctx.ellipse(0, 0, rPx, minor, 0, 0, SYS_TAU);
			ctx.stroke();
			ctx.restore();
		}
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	}

	// §6.2 item 3: the belt stipples, between the orbits and the star. Dots sit
	// at a_b·exp(dlnA·(2u−1)) — the belt's own width in ln a, centred on a_b —
	// rotated by the belt's phase plus its Kepler angle: P = sqrt(a³/M) is the
	// period in years with a in AU and M in M☉, the units §6.4's clock counts.
	// One path and one fill for every dot: they share a colour, so batching is
	// the same picture as 768 separate fills for a fraction of the overhead.
	function drawBelts(cx, cy) {
		const count = system.beltCount;
		if (count === 0) return;
		const belts = system.belts;
		const mass = system.star.mass;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.fillStyle = BELT_STIPPLE;
		ctx.beginPath();
		for (let b = 0; b < count; b++) {
			const aB = belts.a[b];
			const width = belts.dlnA[b];
			const theta0 = beltPhase[b] + SYS_TAU * (systemTimeYr / Math.sqrt(aB * aB * aB / mass));
			const base = b * STIPPLE_N;
			for (let s = 0; s < STIPPLE_N; s++) {
				const a = aB * Math.exp(width * (beltStippleRadius[base + s] * 2 - 1));
				const rPx = radiusPx(a);
				const theta = theta0 + beltStippleAngle[base + s];
				const x = cx + rPx * Math.cos(theta);
				const y = cy + rPx * Math.sin(theta);
				// moveTo first: without it the path connects consecutive dots
				// with a chord and the fill paints the belt as one filled ring.
				ctx.moveTo(x + STIPPLE_RADIUS, y);
				ctx.arc(x, y, STIPPLE_RADIUS, 0, SYS_TAU);
			}
		}
		ctx.fill();
	}

	// §6.2 item 4: the star, class-coloured, sized by state, with a halo at
	// twice the radius so a faint class still reads as the system's centre.
	function drawStar(cx, cy) {
		const star = system.star;
		const state = star.state;
		const r = state === STATE_GIANT ? STAR_R_GIANT : state === STATE_WD ? STAR_R_WD : STAR_R_MS;
		ctx.fillStyle = STAR_HALO[star.colorIndex];
		ctx.beginPath();
		ctx.arc(cx, cy, r * 2, 0, SYS_TAU);
		ctx.fill();
		ctx.fillStyle = STAR_FILL[star.colorIndex];
		ctx.beginPath();
		ctx.arc(cx, cy, r, 0, SYS_TAU);
		ctx.fill();
	}

	// §6.2 item 5: the icons. A locked world is drawn as a half disc with the
	// star-facing half lit; gas and ice giants carry a ring; a terran-flagged
	// world carries the green outline. The mean anomaly is the phase at system
	// time 0 — §6.4's clock advances it, the draw does not change.
	function drawPlanets(cx, cy, planets) {
		const n = system.planetCount;
		for (let p = 0; p < n; p++) {
			const a = planets.a[p];
			const theta = planets.phase[p] + SYS_TAU * (systemTimeYr / planets.period[p]);
			const rPx = radiusPx(a);
			const x = cx + rPx * Math.cos(theta);
			const y = cy + rPx * Math.sin(theta);
			planetScreenXY[p * 2] = x;
			planetScreenXY[p * 2 + 1] = y;
			const display = planets.display[p];
			const flags = planets.flags[p];
			const r = iconRadius(planets.mass[p]);
			if (flags & FLAG_LOCKED) {
				const toStar = Math.atan2(cy - y, cx - x);
				ctx.beginPath();
				ctx.arc(x, y, r, toStar - SYS_HALF_PI, toStar + SYS_HALF_PI);
				ctx.closePath();
				ctx.fillStyle = ICON_FILL[display];
				ctx.fill();
				ctx.beginPath();
				ctx.arc(x, y, r, toStar + SYS_HALF_PI, toStar + SYS_TAU - SYS_HALF_PI);
				ctx.closePath();
				ctx.fillStyle = LOCKED_SHADE;
				ctx.fill();
			} else {
				ctx.beginPath();
				ctx.arc(x, y, r, 0, SYS_TAU);
				ctx.fillStyle = ICON_FILL[display];
				ctx.fill();
			}
			const bulk = planets.bulk[p];
			if (bulk === BULK_GAS || bulk === BULK_ICEGIANT) {
				ctx.beginPath();
				ctx.arc(x, y, r * GIANT_RING_SCALE, 0, SYS_TAU);
				ctx.strokeStyle = ICON_RING[display];
				ctx.lineWidth = 1;
				ctx.stroke();
			}
			if (flags & FLAG_TERRAN) {
				ctx.beginPath();
				ctx.arc(x, y, r + TERRAN_RING_PAD, 0, SYS_TAU);
				ctx.strokeStyle = TERRAN_RING;
				ctx.lineWidth = 1;
				ctx.stroke();
			}
		}
	}

	// §6.3's walk: every body the draw placed, as a distance test. A planet's
	// candidate is its icon radius plus PICK_PAD_PX; a belt's is a 6 px band
	// about its own radius. The two scores are different units — an icon
	// distance against a radial offset — but both answer "how far from that
	// body is the click", which is what nearest-wins compares. Writes into
	// `out`, returns it, or null when nothing is hit.
	function findBody(x, y, out) {
		out.which = BODY_NONE;
		out.index = -1;
		out.dist = Infinity;
		// The map is a graph, not a sky: it has no icons to hit, and endpoint
		// picking arrives with 0.5.5.
		if (mapOpen) return null;
		if (!open || !system || !layoutValid) return null;
		const planets = system.planets;
		const belts = system.belts;
		if (!planets || !belts) return null;   // a summary tier has no bodies to pick
		const cx = frameW * 0.5, cy = frameH * 0.5;
		const n = system.planetCount;
		for (let p = 0; p < n; p++) {
			const dx = planetScreenXY[p * 2] - x;
			const dy = planetScreenXY[p * 2 + 1] - y;
			const d2 = dx * dx + dy * dy;
			const pad = iconRadius(planets.mass[p]) + PICK_PAD_PX;
			if (d2 > pad * pad) continue;
			const d = Math.sqrt(d2);
			if (d < out.dist) {
				out.dist = d;
				out.which = BODY_PLANET;
				out.index = p;
			}
		}
		for (let b = 0; b < system.beltCount; b++) {
			const dx = x - cx, dy = y - cy;
			const d = Math.abs(Math.sqrt(dx * dx + dy * dy) - radiusPx(belts.a[b]));
			if (d >= BELT_PICK_PX) continue;
			if (d < out.dist) {
				out.dist = d;
				out.which = BODY_BELT;
				out.index = b;
			}
		}
		return out.index >= 0 ? out : null;
	}

	// The click path: the body under (x, y) in canvas-local CSS pixels, or
	// null for empty space — which clears the selection and stays in the
	// view (§6.3: leaving is V / Esc / the button). The hit is one shared
	// scratch object, valid until the next pick: read it, do not hold it.
	function pick(x, y) {
		return findBody(x, y, pickOut);
	}

	function setSelectedBody(which, index) {
		if ((which === BODY_PLANET || which === BODY_BELT) && index >= 0) {
			selWhich = which;
			selIndex = index;
			return;
		}
		selWhich = BODY_NONE;
		selIndex = -1;
	}

	// The §6.6 readout names the selected body with a marker, so it reads the
	// same two integers the ring draws from. One preallocated result, valid
	// until the next click — the readout is 4 Hz text, but the convention in
	// this file is one scratch per result.
	const selectedOut = { which: BODY_NONE, index: -1 };
	function selectedBody() {
		selectedOut.which = selWhich;
		selectedOut.index = selIndex;
		return selectedOut;
	}

	// Each frame's hover: the body under the pointer, if there is one. The
	// text is already cached per body, so moving across the schematic changes
	// two integers and a string reference and nothing else.
	function updateHover(x, y) {
		const hit = x >= 0 && y >= 0 ? findBody(x, y, hoverOut) : null;
		if (hit) {
			hoverWhich = hit.which;
			hoverIndex = hit.index;
		} else {
			hoverWhich = BODY_NONE;
			hoverIndex = -1;
		}
	}

	// §6.2 item 6: the selected body's ring, in the label layer's ring colour.
	// A planet's ring bounds its pick target — the icon radius plus the same
	// 4 px the click test uses — and a belt's is the circle the click test
	// measures its 6 px band against, since a belt has no single icon.
	function drawSelectionRing(cx, cy) {
		if (selWhich === BODY_NONE) return;
		ctx.strokeStyle = SYS_SELECT_RING;
		ctx.lineWidth = SYS_SELECT_LINE;
		ctx.beginPath();
		if (selWhich === BODY_PLANET) {
			const r = iconRadius(system.planets.mass[selIndex]) + PICK_PAD_PX;
			ctx.arc(planetScreenXY[selIndex * 2], planetScreenXY[selIndex * 2 + 1], r, 0, SYS_TAU);
		} else {
			ctx.arc(cx, cy, radiusPx(system.belts.a[selIndex]), 0, SYS_TAU);
		}
		ctx.stroke();
	}

	// §6.2 item 6: the hovered body's designation, in the label layer's own
	// type and halo, so a schematic label reads like a landmark's. A planet's
	// label sits beside its icon; a belt's sits where the pointer crosses its
	// band, at the belt's own radius.
	function drawHoverLabel(cx, cy, px, py) {
		if (hoverWhich === BODY_NONE) return;
		let x, y;
		if (hoverWhich === BODY_PLANET) {
			x = planetScreenXY[hoverIndex * 2] + HOVER_OFFSET_PX;
			y = planetScreenXY[hoverIndex * 2 + 1] - HOVER_OFFSET_PX;
		} else {
			const r = radiusPx(system.belts.a[hoverIndex]);
			const theta = Math.atan2(py - cy, px - cx);
			x = cx + r * Math.cos(theta) + HOVER_OFFSET_PX;
			y = cy + r * Math.sin(theta) - HOVER_OFFSET_PX;
		}
		const text = bodyText[hoverWhich === BODY_PLANET ? hoverIndex
			: sysPlanets.MAX_PLANETS + hoverIndex];
		ctx.lineWidth = HOVER_HALO_PX;
		ctx.strokeStyle = HOVER_HALO;
		ctx.strokeText(text, x, y);
		ctx.fillStyle = HOVER_FILL;
		ctx.fillText(text, x, y);
	}

	function draw(width, height, pointerX, pointerY) {
		if (!open) return;
		if (!ctx || !(width > 0) || !(height > 0) || !system) return;
		// A summary-tier record has no orbit arrays: there is nothing to lay
		// out, and the enter path always hands over the full tier.
		const planets = system.planets;
		if (!planets) return;
		if (mapOpen) {
			drawMap(width, height);
			return;
		}
		frameW = width;
		frameH = height;
		ctx.clearRect(0, 0, width, height);
		const cx = width * 0.5, cy = height * 0.5;
		edge = Math.min(width, height) * EDGE_FRACTION;
		computeRadialSpan();
		// From here on the radial axis matches this system, so a pick or a
		// hover tests this frame's geometry rather than the previous one's.
		layoutValid = true;
		drawHabitableZone(cx, cy);
		drawOrbits(cx, cy, planets);
		drawBelts(cx, cy);
		drawStar(cx, cy);
		drawPlanets(cx, cy, planets);
		// §6.2 item 6: the hovered body, then the selection ring above it —
		// the hover is recomputed against the icons this frame just placed.
		updateHover(pointerX, pointerY);
		drawHoverLabel(cx, cy, pointerX, pointerY);
		drawSelectionRing(cx, cy);
	}

	// --- the delta-v map (§7.5) ---------------------------------------------
	// The recognisable shape of a published map: the star at the left, the
	// bodies in columns ordered by a, each column stacking the nodes it has,
	// the edges straight and labelled in km/s to 0.1. Belts are one column with
	// a single node. Edges and labels recompute only when the system or the
	// canvas size changes — a dirty flag, not a per-frame recompute — while the
	// graph itself is redrawn per frame, because 0.5.5's ship icon moves over
	// it.
	function layoutMap(width, height) {
		const n = system.planetCount + system.beltCount;
		mapBodyCount = n;
		for (let i = 0; i < n; i++) {
			sysDeltaV.bodyFromSystem(mapBodies[i], system,
				i < system.planetCount ? sysDeltaV.BODY_KIND_PLANET : sysDeltaV.BODY_KIND_BELT,
				i < system.planetCount ? i : i - system.planetCount);
		}
		const span = width - MAP_MARGIN_R - MAP_COL_X0;
		const colW = n > 0 ? span / n : span;
		const cy = height * 0.5;
		for (let i = 0; i < n; i++) {
			const body = mapBodies[i];
			const present0 = countPresent(body);
			const x = MAP_COL_X0 + (i + 0.5) * colW;
			const base = i * MAP_NODE_ORDER.length;
			let present = 0;
			for (let s = 0; s < MAP_NODE_ORDER.length; s++) {
				// Every node code is one bit, so the mask answers presence.
				if (!(body.nodes & MAP_NODE_ORDER[s])) continue;
				mapNodeXY[(base + s) * 2] = x;
				// Bottom-up: the last present slot lands at cy − (k−1)/2 · dy.
				mapNodeXY[(base + s) * 2 + 1] = cy + ((present0 - 1) * 0.5 - present) * MAP_NODE_DY;
				present++;
			}
		}
		mapEdgeCount = 0;
		for (let i = 0; i < n; i++) {
			const body = mapBodies[i];
			const ground = sysDeltaV.groundNode(body);
			// The column's own legs: ground → low orbit, and low orbit out to
			// GEO, L5 and the escape.
			if (body.nodes & (sysDeltaV.NODE_SURFACE | sysDeltaV.NODE_BELT_BODY)) {
				pushMapEdge(i, ground, i, sysDeltaV.NODE_LOW_ORBIT,
					sysDeltaV.nodeLegDv(body, sysDeltaV.NODE_LOW_ORBIT));
			}
			pushMapEdge(i, sysDeltaV.NODE_LOW_ORBIT, i, sysDeltaV.NODE_GEO, sysDeltaV.geoDv(body));
			pushMapEdge(i, sysDeltaV.NODE_LOW_ORBIT, i, sysDeltaV.NODE_L5, sysDeltaV.l5Dv(body));
			pushMapEdge(i, sysDeltaV.NODE_LOW_ORBIT, i, sysDeltaV.NODE_ESCAPE, sysDeltaV.escapeDv(body));
			// The transfer to the next body out, low orbit to low orbit.
			if (i + 1 < n) {
				const to = mapBodies[i + 1];
				sysDeltaV.legBetween(mapLeg, body, sysDeltaV.NODE_LOW_ORBIT, to, sysDeltaV.NODE_LOW_ORBIT);
				pushMapEdge(i, sysDeltaV.NODE_LOW_ORBIT, i + 1, sysDeltaV.NODE_LOW_ORBIT, mapLeg.dv);
			}
		}
		mapDirty = false;
		mapW = width;
		mapH = height;
	}

	function countPresent(body) {
		let present = 0;
		for (let s = 0; s < MAP_NODE_ORDER.length; s++) {
			const code = MAP_NODE_ORDER[s];
			if (body.nodes & code) present++;
		}
		return present;
	}

	// One edge into the parallel arrays. A dv of -1 is a node the body does not
	// have (no GEO node), and it is not drawn.
	function pushMapEdge(fromBody, fromNode, toBody, toNode, dvKms) {
		if (dvKms < 0 || !Number.isFinite(dvKms)) return;
		const e = mapEdgeCount;
		if (e >= MAX_MAP_EDGES) return;
		edgeFrom[e] = fromBody;
		edgeFromNode[e] = fromNode;
		edgeTo[e] = toBody;
		edgeToNode[e] = toNode;
		edgeDv[e] = dvKms;
		edgeText[e] = dvKms.toFixed(1);
		mapEdgeCount = e + 1;
	}

	// The node's column slot, so an edge can look its endpoints up.
	function nodeSlot(code) {
		for (let s = 0; s < MAP_NODE_ORDER.length; s++) {
			if (MAP_NODE_ORDER[s] === code) return s;
		}
		return 2;   // low orbit, the one node every body has
	}

	function nodeXY(bodyIndex, node) {
		const s = nodeSlot(node);
		const i = (bodyIndex * MAP_NODE_ORDER.length + s) * 2;
		return i;
	}

	function drawMap(width, height) {
		if (mapDirty || mapW !== width || mapH !== height) layoutMap(width, height);
		ctx.clearRect(0, 0, width, height);
		ctx.font = HOVER_FONT;
		ctx.textBaseline = 'alphabetic';
		ctx.lineWidth = 1;
		const cy = height * 0.5;
		ctx.strokeStyle = MAP_EDGE;
		for (let e = 0; e < mapEdgeCount; e++) {
			const i = nodeXY(edgeFrom[e], edgeFromNode[e]);
			const j = nodeXY(edgeTo[e], edgeToNode[e]);
			ctx.beginPath();
			ctx.moveTo(mapNodeXY[i], mapNodeXY[i + 1]);
			ctx.lineTo(mapNodeXY[j], mapNodeXY[j + 1]);
			ctx.stroke();
			// The label rides the midpoint, offset above the line.
			const mx = (mapNodeXY[i] + mapNodeXY[j]) * 0.5;
			const my = (mapNodeXY[i + 1] + mapNodeXY[j + 1]) * 0.5 - 4;
			ctx.fillStyle = MAP_EDGE_LABEL;
			ctx.fillText(edgeText[e], mx, my);
		}
		// The star, then one column per body: its label, its nodes, and the
		// selected body's nodes ringed in the schematic's own ring colour.
		const starY = cy;
		ctx.fillStyle = STAR_FILL[system.star.colorIndex];
		ctx.beginPath();
		ctx.arc(MAP_STAR_X, starY, MAP_STAR_R, 0, SYS_TAU);
		ctx.fill();
		ctx.fillStyle = MAP_COLUMN_LABEL;
		ctx.textAlign = 'center';
		ctx.fillText(starText, MAP_STAR_X, starY - MAP_STAR_R - 8);
		for (let b = 0; b < mapBodyCount; b++) {
			const body = mapBodies[b];
			const label = b < system.planetCount ? bodyText[b]
				: bodyText[sysPlanets.MAX_PLANETS + (b - system.planetCount)];
			const selected = selWhich === (b < system.planetCount ? BODY_PLANET : BODY_BELT)
				&& selIndex === (b < system.planetCount ? b : b - system.planetCount);
			ctx.fillStyle = MAP_COLUMN_LABEL;
			ctx.fillText(label, mapNodeXY[(b * MAP_NODE_ORDER.length) * 2], cy
				- (countPresent(body) - 1) * 0.5 * MAP_NODE_DY - 12);
			for (let s = 0; s < MAP_NODE_ORDER.length; s++) {
				const code = MAP_NODE_ORDER[s];
				if (!(body.nodes & code)) continue;
				const i = (b * MAP_NODE_ORDER.length + s) * 2;
				const x = mapNodeXY[i], y = mapNodeXY[i + 1];
				const ground = code === sysDeltaV.NODE_SURFACE || code === sysDeltaV.NODE_BELT_BODY;
				// The ring colour is chosen before the arc, the way the
				// schematic rings its icons: fill after stroke would hide it.
				ctx.strokeStyle = selected ? SYS_SELECT_RING : MAP_NODE_EDGE;
				ctx.beginPath();
				ctx.arc(x, y, MAP_NODE_R, 0, SYS_TAU);
				ctx.fillStyle = ground ? MAP_GROUND_FILL : MAP_NODE_FILL;
				ctx.fill();
				ctx.stroke();
			}
		}
		ctx.textAlign = 'left';
	}

	return { resize, draw, setSystem, setEnabled, enabled, advance, pick, setSelectedBody, selectedBody, setMapOpen };
}

const SystemLayer = {
	createSystemLayer,
	SYSTEM_TIME_RATE_MIN, SYSTEM_TIME_RATE_MAX, SYSTEM_TIME_RATE_DEFAULT,
	BODY_PLANET, BODY_BELT, BODY_NONE, PICK_PAD_PX, BELT_PICK_PX,
	// The layout and icon tables of §6.1 / §6.2 item 5, so the headless test
	// pins the same numbers the draw uses rather than restating them.
	R_STAR_PX, EDGE_FRACTION, STIPPLE_RADIUS, ICON_RADII, ICON_MASS_EDGES,
	MAP_NODE_R, MAP_STAR_R, MAP_NODE_DY, SYS_SELECT_RING,
	STAR_R_MS, STAR_R_GIANT, STAR_R_WD,
};
if (typeof module !== 'undefined') module.exports = SystemLayer;
if (typeof window !== 'undefined') window.SystemLayer = SystemLayer;
