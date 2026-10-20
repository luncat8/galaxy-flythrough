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
// The trade net (ui.18 colony-economy-plan §9): commissioned routes as
// dashed segments between the colonies' live drawn positions, colonies as
// small green rings (the home colony amber and larger), convoys and founder
// expeditions as dots. Game state, not chrome — drawn whenever a colony
// exists, independent of the landmark labels toggle.
const NET_LINE = 'rgba(120, 235, 175, 0.6)';
const NET_LINE_DASH = [4, 4];
const NET_COLONY = 'rgba(130, 240, 180, 0.95)';
const NET_HOME = 'rgba(255, 195, 95, 0.95)';
const NET_SHIP = 'rgba(150, 240, 255, 0.95)';
const NET_FOUNDER = 'rgba(255, 195, 95, 0.95)';
const NET_COLONY_RING_PX = 6;
const NET_HOME_RING_PX = 10;
const NET_SHIP_PX = 2.5;
const NET_MAX_COLONIES = 32;
const NET_MAX_SHIPS = 64;
const netScreen = new Float32Array(NET_MAX_COLONIES * 2);
const netFront = new Uint8Array(NET_MAX_COLONIES);
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
	function setOrbitState(model, time) { orbitModel = model; orbitTime = time || 0; }

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

	// --- The trade net (ui.18 §9) ---------------------------------------
	// main.js owns the record (positions refreshed every frame from the
	// live drawn sky); the layer owns only the projection and the paint.
	let tradeNet = null;
	let netDrawn = false;
	function setTradeNet(net) { tradeNet = net || null; }
	function tradeNetOn() {
		return !!(tradeNet && tradeNet.show
			&& (tradeNet.colonyCount > 0 || tradeNet.shipCount > 0));
	}
	function drawTradeNet(camera, width, height) {
		const net = tradeNet;
		if (!net) return;
		const viewProj = camera.buildViewProj(width / height);
		const cam = camera.cameraPos;
		const n = Math.min(net.colonyCount, NET_MAX_COLONIES);
		for (let i = 0; i < n; i++) {
			netFront[i] = labelCoords.projectToScreen(viewProj,
				net.colonyPos[i * 3], net.colonyPos[i * 3 + 1], net.colonyPos[i * 3 + 2],
				cam[0], cam[1], cam[2], width, height, scratch) ? 1 : 0;
			if (netFront[i]) {
				netScreen[i * 2] = scratch[0];
				netScreen[i * 2 + 1] = scratch[1];
			}
		}
		// Routes first, under the markers: dashed segments, both ends on
		// screen (a segment with one end behind the camera is the same
		// figure the constellations skip).
		ctx.strokeStyle = NET_LINE;
		ctx.lineWidth = 1.5;
		ctx.setLineDash(NET_LINE_DASH);
		ctx.beginPath();
		const e = Math.min(net.edgeCount, (net.edges.length >> 1));
		for (let k = 0; k < e; k++) {
			const a = net.edges[k * 2], b = net.edges[k * 2 + 1];
			if (a >= n || b >= n || !netFront[a] || !netFront[b]) continue;
			ctx.moveTo(netScreen[a * 2], netScreen[a * 2 + 1]);
			ctx.lineTo(netScreen[b * 2], netScreen[b * 2 + 1]);
		}
		ctx.stroke();
		ctx.setLineDash([]);
		// Colonies: small green rings, the home colony amber and larger.
		ctx.lineWidth = 2;
		ctx.strokeStyle = NET_COLONY;
		ctx.beginPath();
		for (let i = 0; i < n; i++) {
			if (!netFront[i] || i === net.homeIdx) continue;
			ctx.moveTo(netScreen[i * 2] + NET_COLONY_RING_PX, netScreen[i * 2 + 1]);
			ctx.arc(netScreen[i * 2], netScreen[i * 2 + 1], NET_COLONY_RING_PX, 0, Math.PI * 2);
		}
		ctx.stroke();
		if (net.homeIdx >= 0 && net.homeIdx < n && netFront[net.homeIdx]) {
			const hx = netScreen[net.homeIdx * 2], hy = netScreen[net.homeIdx * 2 + 1];
			ctx.strokeStyle = NET_HOME;
			ctx.beginPath();
			ctx.moveTo(hx + NET_HOME_RING_PX, hy);
			ctx.arc(hx, hy, NET_HOME_RING_PX, 0, Math.PI * 2);
			ctx.stroke();
		}
		// Ships in flight: freight cyan, founder expeditions amber.
		const m = Math.min(net.shipCount, NET_MAX_SHIPS);
		for (let s = 0; s < m; s++) {
			if (!labelCoords.projectToScreen(viewProj,
				net.shipPos[s * 3], net.shipPos[s * 3 + 1], net.shipPos[s * 3 + 2],
				cam[0], cam[1], cam[2], width, height, scratch)) continue;
			ctx.fillStyle = net.shipFounder[s] ? NET_FOUNDER : NET_SHIP;
			ctx.beginPath();
			ctx.arc(scratch[0], scratch[1], NET_SHIP_PX, 0, Math.PI * 2);
			ctx.fill();
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

	// The ship chrome (G2) is its own pass and outlives the observer's labels:
	// with labels off and the ship flying, the canvas still carries the HUD
	// marks; with both off, a cleared canvas is left alone.
	function draw(camera, width, height) {
		const chromeOn = chrome.active;
		const netOn = tradeNetOn();
		if (!enabled && !chromeOn && !chromeDrawn && !netOn && !netDrawn) return;
		ctx.clearRect(0, 0, width, height);
		chromeDrawn = chromeOn;
		netDrawn = netOn;
		if (!(width > 0) || !(height > 0)) return;
		if (netOn) drawTradeNet(camera, width, height);
		if (enabled) {
			projectAll(camera, width, height);
			if (showLines) drawLines();
			drawLabels();
			drawSelectedRing();
			drawSetRings(camera, width, height);
		}
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
		setShipChrome, setTradeNet,
	};
}

const LabelLayer = {
	createLabelLayer, createShipChromeState, drawShipChrome,
	LABEL_FONT, LABEL_FILL, LABEL_HALO, LINE_STROKE, SELECT_FILL, SELECT_RING,
	LABEL_OFFSET_PX, SELECT_RING_PX, SET_RING_PX, SET_RING, MAP_SIZE,
};
if (typeof module !== 'undefined') module.exports = LabelLayer;
if (typeof window !== 'undefined') window.LabelLayer = LabelLayer;
