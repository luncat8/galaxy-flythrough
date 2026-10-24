// src/render/label-layer.js
// A 2D canvas over the WebGPU canvas: landmark name labels, constellation
// lines, a ring around the selected star, and — as of 0.5.0 — a smaller ring on
// every member of the selection set (plan §3.5), resolved through the renderer's
// identity array by key so a ring survives a residency rebuild.
//
// Drawn EVERY frame, not at the overlay's 4 Hz cadence — a label that lags a
// quarter second behind its star is visibly wrong while the camera moves.
// ~60 projections plus ~60 fillText calls with constant strings cost nothing
// next to the GPU pass and allocate nothing: screen positions go into
// preallocated typed arrays, colours and fonts are constants.
//
// Projection matches the sprite vertex shader: positions are camera-relative,
// transformed by the same viewProj, and anything with clip.w <= 0 is behind
// the camera and culled. Lines are skipped when either end is behind; at
// these angular separations a screen-space segment is the whole figure.
//
// The canvas is sized in device pixels but drawn in CSS pixels under a
// devicePixelRatio transform, so labels and the click picker (which reports
// CSS pixels) agree without scaling.

'use strict';

const LABEL_FONT = '11px Menlo, Consolas, monospace';
const LABEL_FILL = 'rgba(205, 220, 255, 0.85)';
const LABEL_HALO = 'rgba(5, 8, 16, 0.7)';
const LINE_STROKE = 'rgba(110, 150, 255, 0.35)';
const SELECT_FILL = 'rgba(255, 215, 94, 0.95)';
const SELECT_RING = 'rgba(255, 215, 94, 0.8)';
const LABEL_OFFSET_PX = 6;
const SELECT_RING_PX = 7;
// Set members (plan §3.5): smaller and dimmer than the primary's ring, so a
// many-star selection still reads as one primary plus a cloud.
const SET_RING_PX = 4;
const SET_RING = 'rgba(255, 215, 94, 0.45)';
// The trade overlay (trade series): a schematic at drawn star positions — a ring
// at every colony, a faint line for every voyage in flight and a dot for the
// hull. Dimmer than the set rings, because it is the economy's own picture and
// must never compete with the selection. Drawn in the same 2D pass, no WGSL.
// A port's ring is its colony's *size*: the radius grows with the square root
// of population over capacity, and the colour is the growth sign. Without that
// the overlay is N identical rings and an economy that visibly never changes —
// which is exactly how it read before trade.3.
const TRADE_PORT_RING_MIN = 2;
const TRADE_PORT_RING_SPAN = 5.5;
const TRADE_PORT_GROW = 'rgba(130, 235, 200, 0.55)';
const TRADE_PORT_PEAK = 'rgba(245, 215, 140, 0.55)';
const TRADE_PORT_FADE = 'rgba(240, 135, 125, 0.6)';
const TRADE_PORT_FILL = 'rgba(130, 235, 200, 0.30)';
const TRADE_PORT_CORE_PX = 1.6;
const TRADE_PORT_GROWTH_EPS = 0.0005;
const TRADE_CANDIDATE = 'rgba(120, 195, 255, 0.22)';
const TRADE_CANDIDATE_PX = 1.6;
// A colony younger than this still wears a second, wider ring. Growth is the
// point of the overlay: at a hundred years a second a young world is otherwise
// indistinguishable from the oldest one until it has grown.
const TRADE_PORT_YOUNG = 'rgba(255, 255, 255, 0.30)';
// A failed colony: a hollow grey ring that stays on the map. The alarm ring is
// drawn just outside a live colony in the starvation band (economy's
// `starving` byte, written by the settle), amber and dashed by alternating arcs
// — the test canvas has no setLineDash.
const TRADE_OUTPOST = 'rgba(150, 150, 150, 0.55)';
const TRADE_ALARM = 'rgba(245, 175, 90, 0.65)';
const TRADE_ALARM_GAP = 4;
const TRADE_ALARM_SEGMENTS = 12;
const TRADE_YOUNG_YEARS = 150;
const TRADE_PORT_YOUNG_GAP = 2;
// Shared by the system schematic: one growth/outpost/alarm vocabulary across
// both scales, with the ring dimensions also matching the galaxy overlay.
const TRADE_MARKER_STYLE = Object.freeze({
	ringMin: TRADE_PORT_RING_MIN,
	ringSpan: TRADE_PORT_RING_SPAN,
	grow: TRADE_PORT_GROW,
	peak: TRADE_PORT_PEAK,
	fade: TRADE_PORT_FADE,
	growthEps: TRADE_PORT_GROWTH_EPS,
	outpost: TRADE_OUTPOST,
	alarm: TRADE_ALARM,
	alarmGap: TRADE_ALARM_GAP,
});
const TRADE_ROUTE = 'rgba(120, 220, 200, 0.12)';
const TRADE_FOUND_ROUTE = 'rgba(250, 205, 130, 0.30)';
// A commissioned route (W10): the same edge in a dimmer, steadier teal, drawn
// behind the per-hull chords so the standing network and the voyages read as
// two layers rather than one.
const TRADE_STANDING_ROUTE = 'rgba(80, 170, 155, 0.28)';
const TRADE_SHIP = 'rgba(180, 245, 230, 0.85)';
const TRADE_FOUND_SHIP = 'rgba(255, 215, 130, 0.95)';
const TRADE_SHIP_PX = 2.2;
// The kpc→ly bridge the hull's chord rule needs (trade.js's LY_PER_KPC): a hull
// sits at its flown distance along the chord, and the overlay must place the dot
// with the same number the network booked the voyage with.
const TRADE_LY_PER_KPC = 3261.563673;
// Cargo colours, in economy.js's resource order (ore … art): earthy bulk, then
// a colder hue for information and a warm one for art. The last entry is
// "empty" — a hull between loads.
const TRADE_CARGO = [
	'rgba(180, 150, 110, 0.9)', 'rgba(120, 200, 255, 0.9)', 'rgba(255, 120, 160, 0.9)',
	'rgba(160, 230, 140, 0.9)', 'rgba(235, 120, 255, 0.9)', 'rgba(150, 230, 120, 0.9)',
	'rgba(110, 235, 190, 0.9)', 'rgba(240, 225, 150, 0.9)', 'rgba(190, 190, 210, 0.9)',
	'rgba(120, 170, 255, 0.9)', 'rgba(150, 150, 255, 0.9)', 'rgba(200, 160, 255, 0.9)',
	'rgba(255, 200, 120, 0.9)', 'rgba(220, 235, 255, 0.75)',
];
// The two ship states this pass distinguishes, mirrored from trade.js's
// SHIP_STATE_NAMES (which the layer cannot require without dragging the whole
// economy into the label test): docked/waiting draw no hull, founding reads
// its candidate site instead of a destination port.
const TRADE_SHIP_DOCKED = 0, TRADE_SHIP_WAITING = 2, TRADE_SHIP_FOUNDING = 3, TRADE_SHIP_CREWED = 4;
// Key→slot map: MAP_SIZE slots, linear probing. The key is stored next to the
// slot and a separate `used` byte marks occupancy — a 32-bit key can be zero or
// negative, so neither the key nor the slot can double as the empty marker.
const MAP_SIZE = 1024;
const MAP_MASK = MAP_SIZE - 1;
const MAP_LOAD_MAX = 640;        // above this a rebuild falls back to a plain scan

const labelCoords = (typeof module !== 'undefined' && module.exports)
	? require('../math/coords.js')
	: window.Coords;

// --- Ship chrome (game-mode-plan §6, G2) -------------------------------------
// Drawn only while the ship is the rig. The geometry is live every frame from
// the state record's floats; the strings are main.js's 4 Hz formatting. Screen
// placement goes through camera space directly (the projection the sprite
// shader applies, written out), so a marker behind the camera pins to the edge
// in the direction the pilot has to turn.
const CHROME_GAP_PX = 6;
const CHROME_ARM_PX = 16;
const CHROME_CORNER_PX = 24;
const CHROME_CORNER_TICK_PX = 5;
const CHROME_TRACK = 'rgba(205, 220, 255, 0.18)';
const CHROME_CAP = 'rgba(255, 255, 255, 0.9)';
// G4's return-home marker: amber, so it cannot read as the class
// color's target frame.
const CHROME_HOME = 'rgba(255, 190, 90, 0.95)';
const LADDER_X_PX = 160;
const LADDER_H_PX = 220;
const LADDER_RUNG_TICK_PX = 6;
const LADDER_STUB_MAX_PX = 60;
const BURN_MARK_PX = 7;
const TARGET_BOX_PX = 8;
const TAG_OFFSET_PX = 12;
const EDGE_MARGIN_PX = 28;
const EDGE_FAR_PX = 1e5;          // a direction's pin distance from the centre
const STRIP_W_PX = 240;
const STRIP_BOTTOM_PX = 36;
const STRIP_FUEL_DY_PX = 10;
const LADDER_RUNGS = [0.25, 0.5, 0.75];

const chromeOffset = new Float64Array(2);
const chromeAt = new Float64Array(3);       // x, y, pinned (1 when clamped to the edge)
const chromeRel = new Float64Array(3);

function createShipChromeState() {
	return {
		active: false,
		color: '#ffffff',
		throttle: 0,                 // applied burn over the current ceiling, 0..1
		fuel: 0,                     // remaining Δv over dvMax, 0..1
		speed: 0,                    // ship speed over the cruise cap (may exceed 1)
		closing: 0,                  // closing rate over the cruise cap (may exceed 1)
		hasAim: false,
		aim: new Float64Array(3),    // unit commanded nose direction, world frame
	hasTarget: false,
	target: new Float64Array(3), // drawn position of the primary, kpc
	tagText: '',
	// G4: the return-home marker — the port of registry, drawn
	// while life support is expired.
	hasHome: false,
	home: new Float64Array(3),   // drawn position of the home port, kpc
	homeTagText: '',
	stripText: '',
};
}

// Camera-space offset of a point from the view centre, in CSS pixels. In front
// it is the perspective projection; behind, the direction itself, pinned far
// out so the edge clamp puts it on the side the pilot must turn toward.
function chromeOffsetOf(xc, yc, zc, focalPx) {
	if (zc > 0) {
		chromeOffset[0] = focalPx * xc / zc;
		chromeOffset[1] = -focalPx * yc / zc;
		return;
	}
	const len = Math.sqrt(xc * xc + yc * yc);
	// Dead astern there is no side to turn toward: pin upward, a fixed choice
	// rather than a marker that reads as aligned on the crosshair.
	if (!(len > 0)) { chromeOffset[0] = 0; chromeOffset[1] = -EDGE_FAR_PX; return; }
	chromeOffset[0] = xc / len * EDGE_FAR_PX;
	chromeOffset[1] = -yc / len * EDGE_FAR_PX;
}

// Clamps the centre-relative offset into the view minus the margin, writing
// chromeAt. Scaling along the ray keeps the direction the offset points in.
function chromeClampToView(cx, cy, halfW, halfH) {
	const ox = chromeOffset[0], oy = chromeOffset[1];
	const limX = Math.max(1, halfW - EDGE_MARGIN_PX), limY = Math.max(1, halfH - EDGE_MARGIN_PX);
	const ax = Math.abs(ox), ay = Math.abs(oy);
	const inside = ax <= limX && ay <= limY;
	const s = inside ? 1 : Math.min(ax > 0 ? limX / ax : Infinity, ay > 0 ? limY / ay : Infinity);
	chromeAt[0] = cx + ox * s;
	chromeAt[1] = cy + oy * s;
	chromeAt[2] = inside ? 0 : 1;
}

function chromeDot(v, camVec) {
	return v[0] * camVec[0] + v[1] * camVec[1] + v[2] * camVec[2];
}

function chromeCrosshair(ctx, cx, cy) {
	const g = CHROME_GAP_PX, a = CHROME_ARM_PX;
	ctx.beginPath();
	ctx.moveTo(cx - g - a, cy); ctx.lineTo(cx - g, cy);
	ctx.moveTo(cx + g, cy); ctx.lineTo(cx + g + a, cy);
	ctx.moveTo(cx, cy - g - a); ctx.lineTo(cx, cy - g);
	ctx.moveTo(cx, cy + g); ctx.lineTo(cx, cy + g + a);
	const k = CHROME_CORNER_PX, t = CHROME_CORNER_TICK_PX;
	for (let i = 0; i < 4; i++) {
		const sx = (i & 1) ? 1 : -1, sy = (i & 2) ? 1 : -1;
		ctx.moveTo(cx + sx * k, cy + sy * (k - t));
		ctx.lineTo(cx + sx * k, cy + sy * k);
		ctx.lineTo(cx + sx * (k - t), cy + sy * k);
	}
	ctx.stroke();
}

function chromeBurnMarker(ctx, chrome, camera, cx, cy, focalPx, halfW, halfH) {
	const aim = chrome.aim;
	chromeOffsetOf(chromeDot(aim, camera.right), chromeDot(aim, camera.up),
		chromeDot(aim, camera.forward), focalPx);
	chromeClampToView(cx, cy, halfW, halfH);
	const x = chromeAt[0], y = chromeAt[1];
	ctx.beginPath();
	ctx.arc(x, y, BURN_MARK_PX, 0, Math.PI * 2);
	if (chromeAt[2] > 0) {
		// Pinned: a tick points back at the view centre, the turn the pilot needs.
		const dx = cx - x, dy = cy - y;
		const len = Math.sqrt(dx * dx + dy * dy) || 1;
		ctx.moveTo(x + dx / len * BURN_MARK_PX, y + dy / len * BURN_MARK_PX);
		ctx.lineTo(x + dx / len * (BURN_MARK_PX + 8), y + dy / len * (BURN_MARK_PX + 8));
	}
	ctx.stroke();
}

function chromeLadder(ctx, chrome, cx, cy) {
	const x = cx - LADDER_X_PX, top = cy - LADDER_H_PX * 0.5, bottom = top + LADDER_H_PX;
	ctx.lineWidth = 1;
	ctx.strokeStyle = CHROME_TRACK;
	ctx.beginPath();
	ctx.moveTo(x, top); ctx.lineTo(x, bottom);
	for (let r = 0; r < LADDER_RUNGS.length; r++) {
		const y = bottom - LADDER_RUNGS[r] * LADDER_H_PX;
		ctx.moveTo(x - LADDER_RUNG_TICK_PX, y); ctx.lineTo(x + LADDER_RUNG_TICK_PX, y);
	}
	ctx.moveTo(x - 2 * LADDER_RUNG_TICK_PX, top); ctx.lineTo(x + 2 * LADDER_RUNG_TICK_PX, top);
	ctx.stroke();

	// The fill is the speed over the cap; whatever exceeds it (the ship's own
	// speed after a handover, or a closure faster than the class can cruise)
	// bleeds above the tape as one stub, both read the same way.
	const fill = Math.min(chrome.speed, 1);
	ctx.strokeStyle = chrome.color;
	ctx.lineWidth = 4;
	ctx.beginPath();
	ctx.moveTo(x, bottom); ctx.lineTo(x, bottom - fill * LADDER_H_PX);
	ctx.stroke();

	const over = Math.max(chrome.speed, chrome.closing) - 1;
	if (over > 0) {
		const stub = Math.min(over * LADDER_H_PX, LADDER_STUB_MAX_PX);
		ctx.strokeStyle = CHROME_CAP;
		ctx.beginPath();
		ctx.moveTo(x, top); ctx.lineTo(x, top - stub);
		ctx.stroke();
	}
	if (chrome.closing > 0) {
		const y = bottom - Math.min(chrome.closing, 1) * LADDER_H_PX;
		ctx.strokeStyle = CHROME_CAP;
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		ctx.moveTo(x + 6, y); ctx.lineTo(x + 6 + 2 * LADDER_RUNG_TICK_PX, y);
		ctx.stroke();
	}
}

// The frame-and-tag law both markers share: project the world
// point, clamp it to the view, draw the box and the flipped tag.
// `color` is the class color for the target, amber for home.
function chromeFrame(ctx, x, y, cx, tagText, color) {
	const B = TARGET_BOX_PX;
	ctx.lineWidth = 1.5;
	ctx.strokeStyle = color;
	ctx.beginPath();
	ctx.rect(x - B, y - B, 2 * B, 2 * B);
	ctx.stroke();
	if (tagText === '') return;
	// The tag flips to the left of the box on the right half, so it stays on screen.
	const left = x > cx;
	const tx = left ? x - TAG_OFFSET_PX : x + TAG_OFFSET_PX;
	const ty = y - TAG_OFFSET_PX;
	ctx.textAlign = left ? 'right' : 'left';
	ctx.lineWidth = 3;
	ctx.strokeStyle = LABEL_HALO;
	ctx.strokeText(tagText, tx, ty);
	ctx.fillStyle = color;
	ctx.fillText(tagText, tx, ty);
	ctx.textAlign = 'left';
}

function chromeProjectPoint(point, camera, focalPx) {
	const cam = camera.cameraPos;
	chromeRel[0] = point[0] - cam[0];
	chromeRel[1] = point[1] - cam[1];
	chromeRel[2] = point[2] - cam[2];
	chromeOffsetOf(chromeDot(chromeRel, camera.right), chromeDot(chromeRel, camera.up),
		chromeDot(chromeRel, camera.forward), focalPx);
}

function chromeTarget(ctx, chrome, camera, cx, cy, focalPx, halfW, halfH) {
	chromeProjectPoint(chrome.target, camera, focalPx);
	chromeClampToView(cx, cy, halfW, halfH);
	chromeFrame(ctx, chromeAt[0], chromeAt[1], cx, chrome.tagText, chrome.color);
}

// G4's return-home marker: the port of registry, amber, drawn
// while life support is expired (the hard marker — only a dock
// clears it).
function chromeHome(ctx, chrome, camera, cx, cy, focalPx, halfW, halfH) {
	chromeProjectPoint(chrome.home, camera, focalPx);
	chromeClampToView(cx, cy, halfW, halfH);
	chromeFrame(ctx, chromeAt[0], chromeAt[1], cx, chrome.homeTagText, CHROME_HOME);
}

function chromeStrip(ctx, chrome, width, height) {
	const x = width * 0.5 - STRIP_W_PX * 0.5, y = height - STRIP_BOTTOM_PX;
	ctx.lineWidth = 4;
	ctx.strokeStyle = CHROME_TRACK;
	ctx.beginPath();
	ctx.moveTo(x, y); ctx.lineTo(x + STRIP_W_PX, y);
	ctx.moveTo(x, y + STRIP_FUEL_DY_PX); ctx.lineTo(x + STRIP_W_PX, y + STRIP_FUEL_DY_PX);
	ctx.stroke();
	ctx.strokeStyle = chrome.color;
	ctx.beginPath();
	ctx.moveTo(x, y); ctx.lineTo(x + STRIP_W_PX * Math.min(chrome.throttle, 1), y);
	ctx.stroke();
	ctx.beginPath();
	ctx.moveTo(x, y + STRIP_FUEL_DY_PX);
	ctx.lineTo(x + STRIP_W_PX * Math.min(chrome.fuel, 1), y + STRIP_FUEL_DY_PX);
	ctx.stroke();
	if (chrome.stripText === '') return;
	ctx.lineWidth = 3;
	ctx.strokeStyle = LABEL_HALO;
	ctx.strokeText(chrome.stripText, x, y - 8);
	ctx.fillStyle = chrome.color;
	ctx.fillText(chrome.stripText, x, y - 8);
}

// The whole chrome pass: one call from the layer's draw, after the labels, so
// the crosshair sits over everything the observer's layer shows.
function drawShipChrome(ctx, chrome, camera, width, height) {
	const cx = width * 0.5, cy = height * 0.5;
	const focalPx = 0.5 * height / Math.tan(camera.fovY * 0.5);
	const halfW = width * 0.5, halfH = height * 0.5;
	ctx.strokeStyle = chrome.color;
	ctx.fillStyle = chrome.color;
	ctx.lineWidth = 1.5;
	ctx.font = LABEL_FONT;
	chromeCrosshair(ctx, cx, cy);
	if (chrome.hasAim) chromeBurnMarker(ctx, chrome, camera, cx, cy, focalPx, halfW, halfH);
	chromeLadder(ctx, chrome, cx, cy);
	if (chrome.hasTarget) chromeTarget(ctx, chrome, camera, cx, cy, focalPx, halfW, halfH);
	if (chrome.hasHome) chromeHome(ctx, chrome, camera, cx, cy, focalPx, halfW, halfH);
	chromeStrip(ctx, chrome, width, height);
}

function labelRecords() {
	return (typeof window !== 'undefined' && window.StarRecord) || null;
}

function labelTradeLib() {
	const lib = (typeof window !== 'undefined' && window.TradeLib) ? window.TradeLib : null;
	return lib && lib.shipFraction ? lib : null;
}

// A hull's chord fraction, from the network's own rule (§9.4). A harness that
// does not load TradeLib (a canvas stub) gets the time fraction, which is the
// same number while the chord holds — the two only differ when the sky moves.
function tradeShipFraction(net, ship, time, chordLy) {
	const lib = labelTradeLib();
	if (lib) return lib.shipFraction(net, ship, time, chordLy);
	let f = ship.arrive > ship.depart ? (time - ship.depart) / (ship.arrive - ship.depart) : 1;
	return f < 0 ? 0 : (f > 1 ? 1 : f);
}
function labelOrbit() {
	return (typeof window !== 'undefined' && window.OrbitLib) || null;
}

function createLabelLayer(canvas, landmarks, constellations) {
	const ctx = canvas.getContext('2d');
	const count = landmarks.count;
	const screenXY = new Float32Array(count * 2);
	const front = new Uint8Array(count);
	const scratch = new Float32Array(3);
	let selected = -1;
	let showLines = true;
	// Off for galaxies that have no named stars: the layer is a fixed table of
	// entries, so "nothing to say about this model" is a flag, not a second layer.
	let enabled = true;
	let orbitModel = null;
	let orbitTime = 0;
	const orbitScratch = new Float64Array(3);
	let chrome = createShipChromeState();
	let chromeDrawn = false;
	// The trade network's draw state (trade series). Borrowed, never owned:
	// main.js owns the network and its clock. `tradeOn` is false in the system
	// view, where the schematic owns the canvas.
	let tradeNet = null;
	let tradeTime = 0;
	let tradeOn = false;
	// Route lines are the one part the "draw trade routes" checkbox owns: the
	// ports, the hulls and the frontier marks stay, because a network whose
	// colonies are invisible cannot be watched growing.
	let tradeRoutes = true;
	// The fly workspace's thin overlay (workspace-plan.md §8): detail 1 keeps
	// the ports and the hull dots — the landmarks a pilot navigates by — and
	// drops the standing routes, the voyage chords and the frontier crosses.
	// Detail 2 is the full picture observe and command read.
	let tradeDetail = 2;
	let tradeWasDrawn = false;
	function setOrbitState(model, time) { orbitModel = model; orbitTime = time || 0; }
	function setTradeOverlay(net, time, show, routes, detail) {
		tradeNet = net || null;
		tradeTime = time || 0;
		tradeOn = !!show && !!tradeNet;
		tradeRoutes = routes === undefined ? true : !!routes;
		tradeDetail = detail === undefined ? 2 : detail | 0;
	}

	// --- Star-set rings (plan §3.5) ---------------------------------------
	// The renderer's identity array, the set's keys, and the key→slot map that
	// connects them. The map is rebuilt only when the set changes or the block
	// contents change (`dynamicVersion`), never per frame.
	let starSource = null;              // renderer.starBlocks()
	let lastDynamicVersion = -1;
	let setKeys = null;                 // the set's keys (Uint32Array), borrowed
	let setCount = 0;
	let mapDirty = false;
	let mapOk = false;                  // false → the plain-scan fallback
	const mapKey = new Uint32Array(MAP_SIZE);
	const mapSlot = new Int32Array(MAP_SIZE);   // global slot, or −1 if not resident
	const mapKind = new Int8Array(MAP_SIZE);    // block kind, or −1
	const mapUsed = new Uint8Array(MAP_SIZE);

	function mapHash(key) {
		// One multiplicative mix; the low bits of a PCG key are already well
		// distributed, so a mask is enough at this load factor.
		return (Math.imul(key, 0x9e3779b1) >>> 0) & MAP_MASK;
	}

	// Probe for `key`, returning the slot it occupies or −1 when absent.
	function mapProbe(key, forInsert) {
		let slot = mapHash(key);
		let guard = 0;
		while (mapUsed[slot] && mapKey[slot] !== key) {
			if (++guard > MAP_SIZE) return -1;
			slot = (slot + 1) & MAP_MASK;
		}
		if (mapUsed[slot]) return slot;
		return forInsert ? slot : -1;
	}

	function setStarSource(ref) {
		starSource = ref || null;
		mapDirty = true;
	}

	function setSelectedKeys(keys, count) {
		setKeys = keys || null;
		setCount = count > 0 ? count : 0;
		mapDirty = true;
	}

	// Insert the set's keys, then fill the slots with one pass over the live
	// blocks. Probing is unambiguous because the key is stored beside its slot;
	// a key that is not resident keeps slot −1 and its ring is simply not drawn.
	function rebuildMap() {
		mapDirty = false;
		mapOk = false;
		const records = labelRecords();
		const info = starSource;
		if (!records || !info || !info.identity || !info.view || !setKeys
			|| setCount <= 0 || setCount > MAP_LOAD_MAX) return;
		mapUsed.fill(0);
		for (let i = 0; i < setCount; i++) {
			const key = setKeys[i] >>> 0;
			const slot = mapProbe(key, true);
			if (slot < 0) return;                       // table full: plain scan
			mapUsed[slot] = 1;
			mapKey[slot] = key;
			mapSlot[slot] = -1;
			mapKind[slot] = -1;
		}
		const identity = info.identity;
		const view = info.view;
		const blocks = info.blocks;
		const visibleBit = records.FLAG_VISIBLE << 16;
		for (let k = 0; k < blocks.length; k++) {
			const block = blocks[k];
			const count = block.count | 0;
			if (count <= 0) continue;
			const end = (block.offset | 0) + count;
			for (let slot = block.offset | 0; slot < end; slot++) {
				const probe = mapProbe(identity[slot] >>> 0, false);
				if (probe < 0 || mapSlot[probe] >= 0) continue;
				if ((view.getUint32(slot * records.RECORD_BYTES + 12, true) & visibleBit) === 0) continue;
				mapSlot[probe] = slot;
				mapKind[probe] = k;
			}
		}
		mapOk = true;
	}

	// The plain-scan fallback: membership by a linear search of the set. Only
	// reachable if the map ever fills, which 256 keys in 1024 slots cannot do.
	function isSetKey(key) {
		if (!mapOk) {
			for (let i = 0; i < setCount; i++) if ((setKeys[i] >>> 0) === key) return true;
			return false;
		}
		return mapProbe(key, false) >= 0;
	}

	function drawSetRings(camera, width, height) {
		const records = labelRecords();
		const info = starSource;
		if (!records || !info || !info.identity || !info.view || !setKeys || setCount <= 0) return;
		if (mapDirty || lastDynamicVersion !== info.dynamicVersion) {
			lastDynamicVersion = info.dynamicVersion;
			rebuildMap();
		}
		const orbit = labelOrbit();
		const view = info.view;
		const viewProj = camera.buildViewProj(width / height);
		const cam = camera.cameraPos;
		const blocks = info.blocks;
		const visibleBit = records.FLAG_VISIBLE << 16;
		ctx.strokeStyle = SET_RING;
		ctx.lineWidth = 1;
		ctx.beginPath();
		if (mapOk) {
			for (let i = 0; i < setCount; i++) {
				const probe = mapProbe(setKeys[i] >>> 0, false);
				if (probe < 0 || mapSlot[probe] < 0) continue;
				ringAtSlot(view, info, records, mapSlot[probe], mapKind[probe],
					orbit, viewProj, cam, width, height);
			}
		} else {
			for (let k = 0; k < blocks.length; k++) {
				const block = blocks[k];
				const count = block.count | 0;
				if (count <= 0) continue;
				const end = (block.offset | 0) + count;
				for (let slot = block.offset | 0; slot < end; slot++) {
					if ((view.getUint32(slot * records.RECORD_BYTES + 12, true) & visibleBit) === 0) continue;
					if (!isSetKey(info.identity[slot] >>> 0)) continue;
					ringAtSlot(view, info, records, slot, k, orbit, viewProj, cam, width, height);
				}
			}
		}
		ctx.stroke();
	}

	// One ring, at the position the record is *drawn* at (the shared mask
	// dispatch), which is why a ring can sit off the label of the same star.
	function ringAtSlot(view, info, records, slot, kind, orbit, viewProj, cam, width, height) {
		const byteOffset = slot * records.RECORD_BYTES;
		const packed = view.getUint32(byteOffset + 12, true);
		const birthIndex = kind === 0 ? slot - info.blocks[0].offset : (kind === 2 ? slot : -1);
		if (birthIndex >= 0 && info.formation && info.formation.births
			&& birthIndex < info.formation.births.length && orbit
			&& orbit.gateAt(info.formation.births[birthIndex], info.formation.age) <= 0) return;
		let px = view.getFloat32(byteOffset, true);
		let py = view.getFloat32(byteOffset + 4, true);
		let pz = view.getFloat32(byteOffset + 8, true);
		if (orbit && orbitModel) {
			if (kind === 1) {
				orbit.engineLandmarkPosition(orbitScratch, slot - info.blocks[1].offset, px, py, pz,
					packed & 0xFF, orbitTime, orbitModel);
			} else {
				orbit.engineRecordPosition(orbitScratch, px, py, pz, packed, orbitTime, orbitModel);
			}
			px = orbitScratch[0]; py = orbitScratch[1]; pz = orbitScratch[2];
		}
		if (!labelCoords.projectToScreen(viewProj, px, py, pz,
			cam[0], cam[1], cam[2], width, height, scratch)) return;
		ctx.moveTo(scratch[0] + SET_RING_PX, scratch[1]);
		ctx.arc(scratch[0], scratch[1], SET_RING_PX, 0, Math.PI * 2);
	}


	function resize(widthCss, heightCss, dpr) {
		const w = Math.max(1, Math.round(widthCss * dpr));
		const h = Math.max(1, Math.round(heightCss * dpr));
		if (canvas.width !== w || canvas.height !== h) {
			canvas.width = w;
			canvas.height = h;
		}
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.font = LABEL_FONT;
		ctx.textBaseline = 'alphabetic';
	}

	function projectAll(camera, width, height) {
		const viewProj = camera.buildViewProj(width / height);
		const pos = landmarks.positions;
		const cam = camera.cameraPos;
		const orbit = (typeof window !== 'undefined' ? window.OrbitLib : null);
		for (let i = 0; i < count; i++) {
			let px = pos[i * 3], py = pos[i * 3 + 1], pz = pos[i * 3 + 2];
			if (orbit && orbitModel) {
				// The shared mask dispatch (orbit.engineLandmarkPosition):
				// labels land where the GPU draws for every engine mask —
				// simple mirror, classic law or birth baseline, plus the
				// apocenter pass on its birth-selected subset.
				orbit.engineLandmarkPosition(orbitScratch, i, px, py, pz,
					landmarks.ENTRIES[i].colorIndex, orbitTime, orbitModel);
				px = orbitScratch[0]; py = orbitScratch[1]; pz = orbitScratch[2];
			}
			const visible = labelCoords.projectToScreen(viewProj, px, py, pz,
				cam[0], cam[1], cam[2], width, height, scratch);
			front[i] = visible ? 1 : 0;
			if (visible) {
				screenXY[i * 2] = scratch[0];
				screenXY[i * 2 + 1] = scratch[1];
			}
		}
	}

	function drawLines() {
		const figures = constellations.LINES;
		ctx.strokeStyle = LINE_STROKE;
		ctx.lineWidth = 1;
		ctx.beginPath();
		for (let f = 0; f < figures.length; f++) {
			const edges = figures[f].edges;
			for (let i = 0; i < edges.length; i += 2) {
				const a = edges[i], b = edges[i + 1];
				if (!front[a] || !front[b]) continue;
				ctx.moveTo(screenXY[a * 2], screenXY[a * 2 + 1]);
				ctx.lineTo(screenXY[b * 2], screenXY[b * 2 + 1]);
			}
		}
		ctx.stroke();
	}

	function drawLabels() {
		ctx.lineWidth = 3;
		for (let i = 0; i < count; i++) {
			if (!front[i]) continue;
			const x = screenXY[i * 2] + LABEL_OFFSET_PX;
			const y = screenXY[i * 2 + 1] - LABEL_OFFSET_PX;
			const name = landmarks.ENTRIES[i].name;
			ctx.strokeStyle = LABEL_HALO;
			ctx.fillStyle = i === selected ? SELECT_FILL : LABEL_FILL;
			ctx.strokeText(name, x, y);
			ctx.fillText(name, x, y);
		}
	}

	function drawSelectedRing() {
		if (selected < 0 || !front[selected]) return;
		ctx.strokeStyle = SELECT_RING;
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		ctx.arc(screenXY[selected * 2], screenXY[selected * 2 + 1], SELECT_RING_PX, 0, Math.PI * 2);
		ctx.stroke();
	}


	function setEnabled(next) {
		if (next === enabled) return;
		enabled = next;
		// The canvas keeps its last frame, so switching off has to erase it or the
		// previous galaxy's labels stay frozen on screen.
		if (!enabled) ctx.clearRect(0, 0, canvas.width, canvas.height);
	}

	// Ports and ships are record keys, not coordinates: the galaxy is drawn
	// through the orbit mask, so a port must be projected at its star's *drawn*
	// position — the same record read and the same dispatch `ringAtSlot` uses.
	// A port whose star is not resident draws nothing, exactly like its sprite.
	const tradeA = new Float64Array(3);
	const tradeB = new Float64Array(3);

	// The drawn position of one resident record, into `out` (x, y, z in kpc),
	// at the current star time: birth position plus the orbit law. Returns
	// false when the slot is not resident or its identity no longer matches
	// `key`, so a route endpoint that left the field is not drawn at a stale
	// birth position. Used by the trade overlay and by main.js's route
	// re-timing, which resolves ports the same way the shader does.
	function tradeRecordPosition(kind, index, key, out) {
		return tradeRecordPositionAt(kind, index, key, orbitTime, out);
	}

	// The same record at an arbitrary star time — a booking that asks where the
	// destination *will* be (trade-plan §9.3), not only where it is. Under a
	// friction-field mask the azimuth is the tracked mirror's (§9.5): the record
	// is registered on first sight, stepped by main.js with the frame, and
	// integrated forward here when the caller is predicting. A record the mirror
	// refuses (a horizon past its bound, a catch-up too long) falls through to
	// the mask dispatch's own approximation — the birth or classic position the
	// picker and the labels see for that star.
	function tradeRecordPositionAt(kind, index, key, starTimeMyr, out) {
		const info = starSource;
		if (!info || !info.identity || !info.view || !info.blocks) return false;
		const block = info.blocks[kind | 0];
		if (!block) return false;
		const slot = (block.offset | 0) + (index | 0);
		if (slot >= (info.total | 0)) return false;
		if ((info.identity[slot] >>> 0) !== (key >>> 0)) return false;
		const records = labelRecords();
		if (!records) return false;
		const view = info.view;
		const byteOffset = slot * records.RECORD_BYTES;
		const packed = view.getUint32(byteOffset + 12, true);
		let px = view.getFloat32(byteOffset, true);
		let py = view.getFloat32(byteOffset + 4, true);
		let pz = view.getFloat32(byteOffset + 8, true);
		const orbit = labelOrbit();
		if (orbit && orbitModel) {
			// A friction-field mask has no CPU azimuth for a record unless the
			// tracked mirror carries one; with no θ the dispatch runs exactly as
			// it did before the mirror existed (§9.5's "blind" tier).
			let theta = -1;
			if (orbit.engineRecordPositionTheta && orbit.getEngine
				&& (orbit.getEngine() & orbit.ENGINE_SIMPLE) !== 0) {
				theta = (kind | 0) === 1
					? orbit.simpleLandmarkThetaAt(index | 0, starTimeMyr)
					: orbit.simpleTrackThetaAt(tradeTrackSlot(orbit, key, px, py, pz, packed), starTimeMyr);
			}
			if (theta >= 0 && (kind | 0) === 1) {
				orbit.engineLandmarkPositionTheta(out, index | 0, px, py, pz,
					packed & 0xFF, starTimeMyr, orbitModel, theta);
			} else if (theta >= 0) {
				orbit.engineRecordPositionTheta(out, px, py, pz, packed, starTimeMyr, orbitModel, theta);
			} else if ((kind | 0) === 1) {
				orbit.engineLandmarkPosition(out, index | 0, px, py, pz,
					packed & 0xFF, starTimeMyr, orbitModel);
			} else {
				orbit.engineRecordPosition(out, px, py, pz, packed, starTimeMyr, orbitModel);
			}
			px = out[0]; py = out[1]; pz = out[2];
		}
		out[0] = px; out[1] = py; out[2] = pz;
		return true;
	}

	// The tracked-mirror slot for a record, registering it on first sight. The
	// registration is what the mirror's catch-up pays for; an already-tracked
	// record costs a probe.
	function tradeTrackSlot(orbit, key, x, y, z, packed) {
		if (!orbit.simpleTrackReady || !orbit.simpleTrackReady()) return -1;
		const slot = orbit.simpleTrackSlotOf(key >>> 0);
		if (slot >= 0) return slot;
		return orbit.simpleTrackStar(key >>> 0, x, y, z, packed, orbitModel, orbitTime);
	}

	function drawTrade(camera, width, height) {
		if (!tradeOn) return;
		const viewProj = camera.buildViewProj(width / height);
		const cam = camera.cameraPos;
		// A commissioned pair first, one pass, dimmer than any hull's chord: the
		// standing network is the background the voyages run over. `net.routes`
		// is the module's own list, so nothing had to be wired here.
		if (tradeDetail >= 2 && tradeNet.routes && tradeNet.routes.count > 0) {
			ctx.strokeStyle = TRADE_STANDING_ROUTE;
			ctx.lineWidth = 1;
			ctx.beginPath();
			for (let i = 0; i < tradeNet.routes.count; i++) {
				const route = tradeNet.routes.list[i];
				if (!route.active) continue;
				const a = route.origin >= 0 ? tradeNet.ports[route.origin] : null;
				const b = route.dest >= 0 ? tradeNet.ports[route.dest] : null;
				if (!a || !b) continue;
				if (!tradeRecordPosition(a.ref.kind | 0, a.ref.index | 0, a.key, tradeA)) continue;
				if (!tradeRecordPosition(b.ref.kind | 0, b.ref.index | 0, b.key, tradeB)) continue;
				if (!labelCoords.projectToScreen(viewProj, tradeA[0], tradeA[1], tradeA[2],
					cam[0], cam[1], cam[2], width, height, scratch)) continue;
				ctx.moveTo(scratch[0], scratch[1]);
				if (!labelCoords.projectToScreen(viewProj, tradeB[0], tradeB[1], tradeB[2],
					cam[0], cam[1], cam[2], width, height, scratch)) continue;
				ctx.lineTo(scratch[0], scratch[1]);
			}
			ctx.stroke();
		}
		// The routes next, so the rings and hulls stay legible on top of them.
		// Two paths: a freighter's haul is the network's background hum, a
		// founding voyage is the thing to watch, so they do not share a colour.
		for (let pass = 0; tradeDetail >= 2 && tradeRoutes && pass < 2; pass++) {
			ctx.strokeStyle = pass ? TRADE_FOUND_ROUTE : TRADE_ROUTE;
			ctx.lineWidth = 1;
			ctx.beginPath();
			for (let i = 0; i < tradeNet.shipCount; i++) {
				const ship = tradeNet.ships[i];
				const founding = ship.state === TRADE_SHIP_FOUNDING;
				if (founding !== (pass === 1)) continue;
				if (ship.state === TRADE_SHIP_DOCKED || ship.state === TRADE_SHIP_WAITING
					|| ship.state === TRADE_SHIP_CREWED) continue;
				const from = ship.from >= 0 ? tradeNet.ports[ship.from] : null;
				const to = founding
					? (ship.candidate >= 0 ? tradeNet.candidates[ship.candidate].site : null)
					: (ship.to >= 0 ? tradeNet.ports[ship.to] : null);
				if (!from || !to) continue;
				if (!tradeRecordPosition(from.ref.kind | 0, from.ref.index | 0, from.key, tradeA)) continue;
				if (!tradeRecordPosition(to.ref.kind | 0, to.ref.index | 0, to.key, tradeB)) continue;
				if (!labelCoords.projectToScreen(viewProj, tradeA[0], tradeA[1], tradeA[2],
					cam[0], cam[1], cam[2], width, height, scratch)) continue;
				ctx.moveTo(scratch[0], scratch[1]);
				if (!labelCoords.projectToScreen(viewProj, tradeB[0], tradeB[1], tradeB[2],
					cam[0], cam[1], cam[2], width, height, scratch)) continue;
				ctx.lineTo(scratch[0], scratch[1]);
			}
			ctx.stroke();
		}
		// The frontier: every free candidate world, a small cross. This is what
		// makes the expansion visible — the ports grow out of the mark cloud.
		// Fly's thin overlay (detail 1) drops the cloud with the chords.
		ctx.strokeStyle = TRADE_CANDIDATE;
		ctx.beginPath();
		for (let i = 0; tradeDetail >= 2 && i < tradeNet.candidateCount; i++) {
			const candidate = tradeNet.candidates[i];
			if (candidate.used || candidate.reserved >= 0) continue;
			const site = candidate.site;
			if (!tradeRecordPosition(site.ref.kind | 0, site.ref.index | 0, site.key, tradeA)) continue;
			if (!labelCoords.projectToScreen(viewProj, tradeA[0], tradeA[1], tradeA[2],
				cam[0], cam[1], cam[2], width, height, scratch)) continue;
			const x = scratch[0], y = scratch[1], r = TRADE_CANDIDATE_PX;
			ctx.moveTo(x - r, y); ctx.lineTo(x + r, y);
			ctx.moveTo(x, y - r); ctx.lineTo(x, y + r);
		}
		ctx.stroke();
		// The ports, sized by population and coloured by growth sign. Three
		// passes so a pass is one colour and one stroke, not one per colony.
		for (let pass = 0; pass < 3; pass++) {
			ctx.strokeStyle = pass === 0 ? TRADE_PORT_GROW : pass === 1 ? TRADE_PORT_PEAK : TRADE_PORT_FADE;
			ctx.beginPath();
			for (let i = 0; i < tradeNet.portCount; i++) {
				const port = tradeNet.ports[i];
				const colony = port.colony;
				if (colony.outpost) continue;
				const growth = colony.growth || 0;
				const kind = growth > TRADE_PORT_GROWTH_EPS ? 0 : growth < -TRADE_PORT_GROWTH_EPS ? 2 : 1;
				if (kind !== pass) continue;
				if (!tradeRecordPosition(port.ref.kind | 0, port.ref.index | 0, port.key, tradeA)) continue;
				if (!labelCoords.projectToScreen(viewProj, tradeA[0], tradeA[1], tradeA[2],
					cam[0], cam[1], cam[2], width, height, scratch)) continue;
				const frac = colony.capacity > 0 ? colony.pop / colony.capacity : 0;
				const r = TRADE_PORT_RING_MIN + TRADE_PORT_RING_SPAN * Math.sqrt(frac < 0 ? 0 : frac > 1 ? 1 : frac);
				ctx.moveTo(scratch[0] + r, scratch[1]);
				ctx.arc(scratch[0], scratch[1], r, 0, Math.PI * 2);
			}
			ctx.stroke();
		}
		// A young colony: the same ring, wider and paler, for its first century
		// and a half. This is the growing edge made visible — a founding that
		// landed two seconds ago is not one more dot in the field.
		ctx.strokeStyle = TRADE_PORT_YOUNG;
		ctx.beginPath();
		for (let i = 0; i < tradeNet.portCount; i++) {
			const port = tradeNet.ports[i];
			const colony = port.colony;
			if (colony.outpost) continue;
			const age = tradeTime - colony.founded;
			if (!(age >= 0 && age < TRADE_YOUNG_YEARS)) continue;
			if (!tradeRecordPosition(port.ref.kind | 0, port.ref.index | 0, port.key, tradeA)) continue;
			if (!labelCoords.projectToScreen(viewProj, tradeA[0], tradeA[1], tradeA[2],
				cam[0], cam[1], cam[2], width, height, scratch)) continue;
			const frac = colony.capacity > 0 ? colony.pop / colony.capacity : 0;
			const r = TRADE_PORT_RING_MIN + TRADE_PORT_RING_SPAN * Math.sqrt(frac < 0 ? 0 : frac > 1 ? 1 : frac)
				+ TRADE_PORT_YOUNG_GAP;
			ctx.moveTo(scratch[0] + r, scratch[1]);
			ctx.arc(scratch[0], scratch[1], r, 0, Math.PI * 2);
		}
		ctx.stroke();
		// A saturated capital is a disc, not a ring: the biggest colonies have to
		// read at a glance through the star field.
		ctx.fillStyle = TRADE_PORT_FILL;
		ctx.beginPath();
		for (let i = 0; i < tradeNet.portCount; i++) {
			const port = tradeNet.ports[i];
			const colony = port.colony;
			if (colony.outpost || !(colony.capacity > 0) || colony.pop < colony.capacity * 0.6) continue;
			if (!tradeRecordPosition(port.ref.kind | 0, port.ref.index | 0, port.key, tradeA)) continue;
			if (!labelCoords.projectToScreen(viewProj, tradeA[0], tradeA[1], tradeA[2],
				cam[0], cam[1], cam[2], width, height, scratch)) continue;
			ctx.moveTo(scratch[0] + TRADE_PORT_CORE_PX, scratch[1]);
			ctx.arc(scratch[0], scratch[1], TRADE_PORT_CORE_PX, 0, Math.PI * 2);
		}
		ctx.fill();
		// Outposts last: a hollow grey ring on the frozen population, drawn over
		// the live passes so it reads as a remnant, not as a growing world.
		ctx.strokeStyle = TRADE_OUTPOST;
		ctx.beginPath();
		for (let i = 0; i < tradeNet.portCount; i++) {
			const port = tradeNet.ports[i];
			const colony = port.colony;
			if (!colony.outpost) continue;
			if (!tradeRecordPosition(port.ref.kind | 0, port.ref.index | 0, port.key, tradeA)) continue;
			if (!labelCoords.projectToScreen(viewProj, tradeA[0], tradeA[1], tradeA[2],
				cam[0], cam[1], cam[2], width, height, scratch)) continue;
			const frac = colony.capacity > 0 ? colony.pop / colony.capacity : 0;
			const r = TRADE_PORT_RING_MIN + TRADE_PORT_RING_SPAN * Math.sqrt(frac < 0 ? 0 : frac > 1 ? 1 : frac);
			ctx.moveTo(scratch[0] + r, scratch[1]);
			ctx.arc(scratch[0], scratch[1], r, 0, Math.PI * 2);
		}
		ctx.stroke();
		// The alarm: a live colony sliding toward that state gets a dashed amber
		// ring outside its own. Alternating arcs, one path, no per-colony work.
		ctx.strokeStyle = TRADE_ALARM;
		ctx.beginPath();
		const seg = Math.PI * 2 / TRADE_ALARM_SEGMENTS;
		for (let i = 0; i < tradeNet.portCount; i++) {
			const port = tradeNet.ports[i];
			const colony = port.colony;
			if (colony.outpost || !colony.starving) continue;
			if (!tradeRecordPosition(port.ref.kind | 0, port.ref.index | 0, port.key, tradeA)) continue;
			if (!labelCoords.projectToScreen(viewProj, tradeA[0], tradeA[1], tradeA[2],
				cam[0], cam[1], cam[2], width, height, scratch)) continue;
			const frac = colony.capacity > 0 ? colony.pop / colony.capacity : 0;
			const r = TRADE_PORT_RING_MIN + TRADE_PORT_RING_SPAN * Math.sqrt(frac < 0 ? 0 : frac > 1 ? 1 : frac)
				+ TRADE_ALARM_GAP;
			for (let k = 0; k < TRADE_ALARM_SEGMENTS; k += 2) {
				ctx.moveTo(scratch[0] + Math.cos(k * seg) * r, scratch[1] + Math.sin(k * seg) * r);
				ctx.arc(scratch[0], scratch[1], r, k * seg, (k + 1) * seg);
			}
		}
		ctx.stroke();
		// The hulls, placed by the network's own chord rule and coloured by what
		// they carry — except a founder, which is amber and hollow: it is the one
		// voyage that changes the map. The rule is trade.js's, not a second copy
		// here: a hull sits at its flown distance along the *current* chord, so a
		// route the sky is stretching holds the dot back instead of dragging it
		// forward, and a diverted hull runs its chord backwards (§9.4).
		for (let i = 0; i < tradeNet.shipCount; i++) {
			const ship = tradeNet.ships[i];
			const founding = ship.state === TRADE_SHIP_FOUNDING;
			// A crewed hull is the player's physical ship: the pilot's own
			// chrome draws it, so the statistical dot would be a ghost twin.
			if (ship.state === TRADE_SHIP_DOCKED || ship.state === TRADE_SHIP_WAITING
				|| ship.state === TRADE_SHIP_CREWED) continue;
			const from = ship.from >= 0 ? tradeNet.ports[ship.from] : null;
			const to = founding
				? (ship.candidate >= 0 ? tradeNet.candidates[ship.candidate].site : null)
				: (ship.to >= 0 ? tradeNet.ports[ship.to] : null);
			if (!from || !to) continue;
			if (!tradeRecordPosition(from.ref.kind | 0, from.ref.index | 0, from.key, tradeA)) continue;
			if (!tradeRecordPosition(to.ref.kind | 0, to.ref.index | 0, to.key, tradeB)) continue;
			const chordLy = Math.sqrt((tradeA[0] - tradeB[0]) ** 2 + (tradeA[1] - tradeB[1]) ** 2
				+ (tradeA[2] - tradeB[2]) ** 2) * TRADE_LY_PER_KPC;
			const f = tradeShipFraction(tradeNet, ship, tradeTime, chordLy);
			const u = ship.legFrom + (ship.legTo - ship.legFrom) * f;
			if (!labelCoords.projectToScreen(viewProj,
				tradeA[0] + (tradeB[0] - tradeA[0]) * u,
				tradeA[1] + (tradeB[1] - tradeA[1]) * u,
				tradeA[2] + (tradeB[2] - tradeA[2]) * u,
				cam[0], cam[1], cam[2], width, height, scratch)) continue;
			ctx.beginPath();
			ctx.arc(scratch[0], scratch[1], founding ? TRADE_SHIP_PX + 1 : TRADE_SHIP_PX, 0, Math.PI * 2);
			if (founding) {
				ctx.strokeStyle = TRADE_FOUND_SHIP;
				ctx.lineWidth = 1.2;
				ctx.stroke();
			} else {
				ctx.fillStyle = ship.cargo < TRADE_CARGO.length - 1 ? TRADE_CARGO[ship.cargo] : TRADE_CARGO[TRADE_CARGO.length - 1];
				ctx.fill();
			}
		}
	}

	function draw(camera, width, height) {
		const chromeOn = chrome.active;
		const tradeDrawn = tradeOn && tradeNet && tradeNet.portCount > 0;
		if (!enabled && !chromeOn && !chromeDrawn && !tradeDrawn && !tradeWasDrawn) return;
		ctx.clearRect(0, 0, width, height);
		chromeDrawn = chromeOn;
		tradeWasDrawn = !!tradeDrawn;
		if (!(width > 0) || !(height > 0)) return;
		if (enabled) {
			projectAll(camera, width, height);
			if (showLines) drawLines();
			drawLabels();
			drawSelectedRing();
			drawSetRings(camera, width, height);
		}
		// The trade pass runs with labels off too: it is a mode of its own.
		if (tradeDrawn) drawTrade(camera, width, height);
		if (chromeOn) drawShipChrome(ctx, chrome, camera, width, height);
	}

	function setShipChrome(state) {
		chrome = state;
	}

	function setSelected(index) {
		selected = index;
	}

	function setConstellations(next) {
		showLines = !!next;
		return showLines;
	}

	function toggleConstellations() {
		return setConstellations(!showLines);
	}

	function constellationsVisible() {
		return showLines;
	}

		return {
		resize, draw, setSelected, setOrbitState, setStarSource, setSelectedKeys,
		toggleConstellations, setConstellations, constellationsVisible, setEnabled,
		setShipChrome, setTradeOverlay, tradeRecordPosition, tradeRecordPositionAt,
	};
}

const LabelLayer = {
	createLabelLayer, createShipChromeState, drawShipChrome,
	LABEL_FONT, LABEL_FILL, LABEL_HALO, LINE_STROKE, SELECT_FILL, SELECT_RING,
	LABEL_OFFSET_PX, SELECT_RING_PX, SET_RING_PX, SET_RING, MAP_SIZE,
	TRADE_MARKER_STYLE,
};
if (typeof module !== 'undefined') module.exports = LabelLayer;
if (typeof window !== 'undefined') window.LabelLayer = LabelLayer;
