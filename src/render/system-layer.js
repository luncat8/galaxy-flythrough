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
// SystemRecord intake. 0.5.3-2 (this file) draws the log-polar layout — the
// radial axis of §6.1, the habitable-zone annulus, the orbit ellipses, the star
// and the planet icons. The belt stipples and the system clock are 0.5.3-3;
// schematic picking, the selection ring and the hovered designation are
// 0.5.3-4.

'use strict';

// The generator owns the tables the icons read (display-type colours, bulk
// codes, flags); star-record.js owns the class colour LUT. Resolved once, the
// way label-layer.js resolves Coords: the page has every script evaluated long
// before a system opens, and Node's require is the same lookup. Named for this
// file — classic <script> tags share one global scope, and search.js already
// declares planetsLib() for its own use.
const sysPlanets = (typeof module !== 'undefined' && module.exports)
	? require('../math/planets.js')
	: window.PlanetsLib;
const sysRecords = (typeof module !== 'undefined' && module.exports)
	? require('../math/star-record.js')
	: window.StarRecord;

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
const TERRAN_RING = 'rgba(96, 200, 128, 0.85)';
const LOCKED_SHADE = 'rgba(6, 8, 14, 0.55)';   // the unlit half of a locked world
const STAR_HALO_ALPHA = 0.18;

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
	// §6.4's own clock, in years of the open system. Frozen at 0 until 0.5.3-3
	// gives the menu slider a rate to write here; the phase draw already reads
	// it, so the clock lands without touching the layout.
	let systemTimeYr = 0;
	// The radial mapping of the current frame, and where the icons ended up:
	// the picker of 0.5.3-4 reads these instead of projecting anything.
	let lnIn = 0, lnSpan = 1, edge = 1;
	const planetScreenXY = new Float32Array(sysPlanets.MAX_PLANETS * 2);

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

	function enabled() {
		return open;
	}

	function setSystem(record) {
		system = record || null;
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
			clearCanvas();
		}
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
	// time 0 — 0.5.3-3's clock advances it, the draw does not change.
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

	function draw(width, height) {
		if (!open) return;
		if (!ctx || !(width > 0) || !(height > 0) || !system) return;
		// A summary-tier record has no orbit arrays: there is nothing to lay
		// out, and the enter path always hands over the full tier.
		const planets = system.planets;
		if (!planets) return;
		ctx.clearRect(0, 0, width, height);
		const cx = width * 0.5, cy = height * 0.5;
		edge = Math.min(width, height) * EDGE_FRACTION;
		computeRadialSpan();
		drawHabitableZone(cx, cy);
		drawOrbits(cx, cy, planets);
		drawStar(cx, cy);
		drawPlanets(cx, cy, planets);
		// 0.5.3-3 adds the belt stipples here, between the orbits and the
		// star; 0.5.3-4 adds the selection ring and the hovered designation
		// above the planets.
	}

	return { resize, draw, setSystem, setEnabled, enabled };
}

const SystemLayer = { createSystemLayer };
if (typeof module !== 'undefined') module.exports = SystemLayer;
if (typeof window !== 'undefined') window.SystemLayer = SystemLayer;
