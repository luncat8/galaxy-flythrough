// src/render/label-layer.js
// A 2D canvas over the WebGPU canvas: landmark name labels, constellation
// lines, and a ring around the selected star.
//
// Drawn EVERY frame, not at the overlay's 4 Hz cadence — a label that lags a
// quarter second behind its star is visibly wrong while the camera moves.
// ~60 projections plus ~60 fillText calls with constant strings cost nothing
// next to the GPU pass and allocate nothing: screen positions go into
// preallocated typed arrays, colours and fonts are constants.
//
// 0.5.0 adds the multi-select rings: up to SET_RINGS_MAX members of the
// selection set, resolved from their identity keys back to buffer slots. The
// key→slot map is rebuilt only when the set changes or the dynamic blocks are
// rewritten (the block counts are a cheap signature of exactly that), never
// per frame.
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
const SET_RING_STROKE = 'rgba(255, 215, 94, 0.45)';
const LABEL_OFFSET_PX = 6;
const SELECT_RING_PX = 7;
const SET_RING_PX = 4;
// 256 rings is noise, so the layer draws the nearest SET_RINGS_MAX set members
// (the set is kept nearest-first) plus the primary at full strength.
const SET_RINGS_MAX = 16;
// Key→slot hash: open addressing over the selection's keys, rebuilt on set
// change / block rebuild. 256 keys in 1024 slots is a 0.25 load factor.
const KEY_MAP_SIZE = 1024;
const KEY_MAP_MASK = KEY_MAP_SIZE - 1;
const VISIBLE_BIT = 0x10000;          // FLAG_VISIBLE, bit 0 of the flags byte

const labelCoords = (typeof module !== 'undefined' && module.exports)
	? require('../math/coords.js')
	: window.Coords;

	function createLabelLayer(canvas, landmarks, constellations) {
	const ctx = canvas.getContext('2d');
	const count = landmarks.count;
	const screenXY = new Float32Array(count * 2);
	const front = new Uint8Array(count);
	const scratch = new Float32Array(3);
	const ringScratch = new Float32Array(3);
	let selected = -1;
	let showLines = true;
	// Off for galaxies that have no named stars: the layer is a fixed table of
	// entries, so "nothing to say about this model" is a flag, not a second layer.
	let enabled = true;
	let orbitModel = null;
	let orbitTime = 0;
	const orbitScratch = new Float64Array(3);
	function setOrbitState(model, time) { orbitModel = model; orbitTime = time || 0; }

	// The selection set, as keys. Copied in: the caller keeps mutating its own
	// array, and the ring draw needs a stable snapshot between rebuilds. The
	// capacity is the set's own (star-set.js loads before this file on the
	// page); the fallback keeps a lone require() of this module working.
	const labelSetFallback = { STAR_SET_CAPACITY: 256 };
	const setCapacity = (typeof window !== 'undefined' && window.StarSet
		? window.StarSet.STAR_SET_CAPACITY : labelSetFallback.STAR_SET_CAPACITY);
	const setKeys = new Uint32Array(setCapacity);
	const setSlots = new Int32Array(KEY_MAP_SIZE);
	const mapKeys = new Uint32Array(KEY_MAP_SIZE);
	const mapSlots = new Int32Array(KEY_MAP_SIZE);
	let setCount = 0;
	// The block-count signature the current map was built against; -1 forces a
	// rebuild. The five counts change exactly when the fixed block is
	// regenerated or the dynamic blocks are rewritten, which is when the keys
	// in the identity array have moved.
	let mapSignature = -1;
	// () => renderer.starBlocks(). Null until the renderer is attached.
	let recordSource = null;
	function setRecordSource(getter) { recordSource = typeof getter === 'function' ? getter : null; }

	function setSelectedKeys(keys, n) {
		const total = Math.max(0, Math.min(n | 0, setKeys.length));
		for (let i = 0; i < total; i++) setKeys[i] = keys[i];
		setCount = total;
		mapSignature = -1;
	}

	function blockSignature(blocks) {
		const t = blocks.blocks;
		return t[0].count + t[1].count * 31 + t[2].count * 1013 + t[3].count * 511 + t[4].count * 8191;
	}

	// One pass over the identity array fills setSlots[i] with the buffer slot
	// whose record carries setKeys[i], or -1 when that star is not resident.
	function buildSlotMap(identity, total) {
		mapKeys.fill(0);
		// -1, not 0: a map slot that was never filled has left mapSlots at its
		// initial value, and a key that is not resident must not fall back to
		// slot 0 — that rings whichever star happens to sit there.
		mapSlots.fill(-1);
		for (let i = 0; i < setCount; i++) {
			const k = setKeys[i];
			setSlots[i] = -1;
			if (k === 0) continue;
			let h = k & KEY_MAP_MASK;
			while (mapKeys[h] !== 0 && mapKeys[h] !== k) h = (h + 1) & KEY_MAP_MASK;
			mapKeys[h] = k;
		}
		for (let s = 0; s < total; s++) {
			const k = identity[s];
			if (k === 0) continue;
			let h = k & KEY_MAP_MASK;
			while (mapKeys[h] !== 0 && mapKeys[h] !== k) h = (h + 1) & KEY_MAP_MASK;
			if (mapKeys[h] === k) mapSlots[h] = s;
		}
		for (let i = 0; i < setCount; i++) {
			const k = setKeys[i];
			let h = k & KEY_MAP_MASK;
			while (mapKeys[h] !== 0 && mapKeys[h] !== k) h = (h + 1) & KEY_MAP_MASK;
			if (k !== 0 && mapKeys[h] === k) setSlots[i] = mapSlots[h];
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

	function projectAll(camera, viewProj, width, height) {
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

	function drawSetRings(camera, viewProj, width, height) {
		if (setCount <= 0 || !recordSource) return;
		const blocks = recordSource();
		const identity = blocks.identity;
		const positions = blocks.float32;
		const words = blocks.uint32;
		if (!identity || !positions || !words) return;
		const signature = blockSignature(blocks);
		if (signature !== mapSignature) {
			buildSlotMap(identity, blocks.total);
			mapSignature = signature;
		}
		const cam = camera.cameraPos;
		const orbit = (typeof window !== 'undefined' ? window.OrbitLib : null);
		const limit = Math.min(setCount, SET_RINGS_MAX);
		for (let i = 0; i < limit; i++) {
			const slot = setSlots[i];
			if (slot < 0) continue;
			const w = slot * 4;
			if ((words[w + 3] & VISIBLE_BIT) === 0) continue;
			let px = positions[w], py = positions[w + 1], pz = positions[w + 2];
			if (orbit && orbitModel) {
				orbit.engineRecordPosition(orbitScratch, px, py, pz,
					words[w + 3], orbitTime, orbitModel);
				px = orbitScratch[0]; py = orbitScratch[1]; pz = orbitScratch[2];
			}
			if (!labelCoords.projectToScreen(viewProj, px, py, pz,
				cam[0], cam[1], cam[2], width, height, ringScratch)) continue;
			// The primary (slot 0) carries the bright ring; the rest are dim.
			const primary = i === 0;
			ctx.strokeStyle = primary ? SELECT_RING : SET_RING_STROKE;
			ctx.lineWidth = primary ? 1.5 : 1;
			ctx.beginPath();
			ctx.arc(ringScratch[0], ringScratch[1], primary ? SELECT_RING_PX : SET_RING_PX, 0, Math.PI * 2);
			ctx.stroke();
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
		const viewProj = camera.buildViewProj(width / height);
		projectAll(camera, viewProj, width, height);
		drawSetRings(camera, viewProj, width, height);
		if (showLines) drawLines();
		drawLabels();
		drawSelectedRing();
	}

	function setSelected(index) {
		selected = index;
	}

	// A set with no members leaves no rings behind: the canvas is cleared each
	// frame, but a stale key list would keep resolving until the next rebuild.
	function clearSelectedKeys() {
		setCount = 0;
		mapSignature = -1;
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

	return { resize, draw, setSelected, setSelectedKeys, clearSelectedKeys, setOrbitState,
		setRecordSource, toggleConstellations, setConstellations, constellationsVisible, setEnabled };
}

const LabelLayer = {
	createLabelLayer,
	LABEL_FONT, LABEL_FILL, LINE_STROKE, SELECT_FILL, SELECT_RING, SET_RING_STROKE,
	LABEL_OFFSET_PX, SELECT_RING_PX, SET_RING_PX, SET_RINGS_MAX,
};
if (typeof module !== 'undefined') module.exports = LabelLayer;
if (typeof window !== 'undefined') window.LabelLayer = LabelLayer;
