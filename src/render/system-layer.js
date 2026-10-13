// src/render/system-layer.js
// The close-system schematic (0.5.3, plan §6): a 2D canvas above the label
// layer that draws the opened star's generated system — log-polar orbits, the
// habitable annulus, belt stipples, colour-coded planet icons — plus exact
// screen-space picking and the #sysread text.
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
// slider does, through orbit.js's own FLIGHT_TIME_GAIN.

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
// The ring colour, font and halo are the label layer's own (plan §6.2 item 6
// asks for "the label layer's ring colour"): read, not copied, so the two
// overlays cannot drift apart.
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

// --- System time (plan §6.4): the view's own clock ----------------------------
const SYSTIME_MIN = -1;               // −1 couples to the camera fly speed
const SYSTIME_MAX = 99;               // years per second
const SYSTIME_STEP = 0.5;
const SYSTIME_DEFAULT = 0;            // frozen

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

// The system-time slider's readout: the star-time formatter's shape, in y/s.
function formatSysTimeRate(rate) {
	if (rate < 0) return 'follow \u00d7' + (-rate).toFixed(1);
	if (rate === 0) return '0 y/s';
	return rate + ' y/s';
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
		clearBodySelection();
		hoverKind = BODY_NONE;
		hoverIndex = -1;
		hoverLabel = '';
		open = true;
		return record;
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
		timeYears += rate * dt;
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
	}

	// --- Draw (plan §6.2, back to front) --------------------------------------
	function draw(width, height) {
		if (!open) return;                      // the only cost while closed
		ctx.clearRect(0, 0, width, height);
		if (!(width > 0) || !(height > 0)) return;
		layout.cx = width * 0.5;
		layout.cy = height * 0.5;
		layout.rEdge = Math.min(width, height) * R_EDGE_FRAC;
		layout.rSpan = layout.rEdge - R_STAR_PX;
		if (!(layout.rSpan > 0)) return;
		drawHabitableZone();
		drawOrbits();
		drawBelts();
		drawStar();
		drawPlanets();
		drawBodyMarks();
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

	// --- Picking (plan §6.3): exact, screen-space, no projection --------------
	// Bodies win over belt bands (a planet in front of a belt is the planet);
	// nearest body wins; empty space is BODY_NONE — main.js clears the view
	// selection on it but does not leave the view.
	function pick(x, y, out) {
		out.kind = BODY_NONE;
		out.index = -1;
		if (!open || !(layout.rSpan > 0)) return out;
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
			selectedKind = kind; selectedIndex = index; return;
		}
		if (kind === BODY_BELT && index >= 0 && index < record.belts.count) {
			selectedKind = kind; selectedIndex = index; return;
		}
		clearBodySelection();
	}
	function clearBodySelection() { selectedKind = BODY_NONE; selectedIndex = -1; }
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
	SYSTIME_MIN, SYSTIME_MAX, SYSTIME_STEP, SYSTIME_DEFAULT,
	BODY_NONE, BODY_STAR, BODY_PLANET, BODY_BELT, TYPE_FILLS,
	viewInnerAU, viewOuterAU, iconRadiusForMass, starRadiusForState, formatSysTimeRate,
};
if (typeof module !== 'undefined') module.exports = SystemLayer;
if (typeof window !== 'undefined') window.SystemLayer = SystemLayer;
})();
