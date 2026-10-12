// src/render/system-layer.js
// The close-system schematic (0.5 plan §6): a 2D canvas over the WebGPU canvas,
// the technique label-layer.js already uses for names and rings. Planets are
// CPU-only by §1.1 — a system is ≤ 12 planets, 2 belts and a star, which is 15
// circles, not a pipeline.
//
// Drawn every frame only while the system view is open; otherwise draw() is one
// boolean test and a return, so a closed view costs the frame loop nothing.
//
// 0.5.3-1 is the skeleton: the open/closed state, the canvas lifetime and the
// SystemRecord intake. The log-polar layout, the habitable-zone annulus, the
// orbit ellipses and the icons are 0.5.3-2; the belt stipples and the system
// clock are 0.5.3-3; schematic picking and the selection ring are 0.5.3-4.

'use strict';

function createSystemLayer(canvas) {
	// A headless caller (the wiring tests) passes a canvas without a context:
	// the layer is inert rather than fatal, because nothing about the wiring
	// depends on the 2D backend.
	const ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
	let open = false;
	// The planets.js SystemRecord the enter path generates, or null when the
	// view is closed: main.js owns the record, the layer only reads it.
	let system = null;

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
	function resize(widthCss, heightCss, dpr) {
		if (!ctx) return;
		const w = Math.max(1, Math.round(widthCss * dpr));
		const h = Math.max(1, Math.round(heightCss * dpr));
		if (canvas.width !== w || canvas.height !== h) {
			canvas.width = w;
			canvas.height = h;
		}
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	}

	function draw(width, height) {
		if (!open) return;
		if (!ctx || !(width > 0) || !(height > 0)) return;
		ctx.clearRect(0, 0, width, height);
		// 0.5.3-2 fills this in: the habitable-zone annulus, the orbit
		// ellipses, the belts, the star and the planet icons, all read from
		// `system` and all written into preallocated typed arrays.
	}

	return { resize, draw, setSystem, setEnabled, enabled };
}

const SystemLayer = { createSystemLayer };
if (typeof module !== 'undefined') module.exports = SystemLayer;
if (typeof window !== 'undefined') window.SystemLayer = SystemLayer;
