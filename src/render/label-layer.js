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

const labelCoords = (typeof module !== 'undefined' && module.exports)
	? require('../math/coords.js')
	: window.Coords;

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
		for (let i = 0; i < count; i++) {
			const visible = labelCoords.projectToScreen(viewProj,
				pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2],
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
	}

	function setSelected(index) {
		selected = index;
	}

	function toggleConstellations() {
		showLines = !showLines;
		return showLines;
	}

	function constellationsVisible() {
		return showLines;
	}

	return { resize, draw, setSelected, toggleConstellations, constellationsVisible, setEnabled };
}

const LabelLayer = {
	createLabelLayer,
	LABEL_FONT, LABEL_FILL, LINE_STROKE, SELECT_FILL, SELECT_RING,
	LABEL_OFFSET_PX, SELECT_RING_PX,
};
if (typeof module !== 'undefined') module.exports = LabelLayer;
if (typeof window !== 'undefined') window.LabelLayer = LabelLayer;
