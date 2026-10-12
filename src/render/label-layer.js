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
// Key→slot map: MAP_SIZE slots, linear probing. The key is stored next to the
// slot and a separate `used` byte marks occupancy — a 32-bit key can be zero or
// negative, so neither the key nor the slot can double as the empty marker.
const MAP_SIZE = 1024;
const MAP_MASK = MAP_SIZE - 1;
const MAP_LOAD_MAX = 640;        // above this a rebuild falls back to a plain scan

const labelCoords = (typeof module !== 'undefined' && module.exports)
	? require('../math/coords.js')
	: window.Coords;

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

	function draw(camera, width, height) {
		if (!enabled) return;
		ctx.clearRect(0, 0, width, height);
		if (!(width > 0) || !(height > 0)) return;
		projectAll(camera, width, height);
		if (showLines) drawLines();
		drawLabels();
		drawSelectedRing();
		drawSetRings(camera, width, height);
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
	};
}

const LabelLayer = {
	createLabelLayer,
	LABEL_FONT, LABEL_FILL, LINE_STROKE, SELECT_FILL, SELECT_RING,
	LABEL_OFFSET_PX, SELECT_RING_PX, SET_RING_PX, SET_RING, MAP_SIZE,
};
if (typeof module !== 'undefined') module.exports = LabelLayer;
if (typeof window !== 'undefined') window.LabelLayer = LabelLayer;
