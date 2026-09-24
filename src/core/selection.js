// src/core/selection.js
// Click picking: projects the landmarks with the camera's viewProj and
// returns the nearest one within PICK_RADIUS_PX of the pointer. The caller
// feeds the hit to camera.setOrbitTarget — selection never mutates the
// camera itself, so a miss is a pure no-op.

'use strict';

const PICK_RADIUS_PX = 20;

const selectionCoords = (typeof module !== 'undefined' && module.exports)
	? require('../math/coords.js')
	: window.Coords;
const selectionOrbit = (typeof module !== 'undefined' && module.exports)
	? { orbitPosition: () => {}, familyFromColorIndex: () => 1, getEngine: () => 0 }
	: window.OrbitLib;

function createSelection(camera, landmarks) {
	const scratch = new Float32Array(3);
	const orbitScratch = new Float64Array(3);
	let orbitModel = null, orbitTime = 0;
	function setOrbitState(model, time) { orbitModel = model; orbitTime = time || 0; }

	function pick(x, y, width, height) {
		if (!landmarks || landmarks.count === 0 || !(width > 0) || !(height > 0)) return -1;
		const viewProj = camera.buildViewProj(width / height);
		const pos = landmarks.positions;
		const cam = camera.cameraPos;
		let best = -1;
		let bestD2 = PICK_RADIUS_PX * PICK_RADIUS_PX;
		for (let i = 0; i < landmarks.count; i++) {
			let px = pos[i * 3], py = pos[i * 3 + 1], pz = pos[i * 3 + 2];
			if (orbitModel) {
				// 0.4.5: picks ride the simple-engine CPU mirror under that
				// engine, so the click target is what the GPU draws.
				if (selectionOrbit.getEngine() === selectionOrbit.ENGINE_SIMPLE
					&& selectionOrbit.simpleLandmarksReady && selectionOrbit.simpleLandmarksReady()) {
					selectionOrbit.simpleLandmarkPosition(orbitScratch, i, pz);
				} else {
					selectionOrbit.orbitPosition(orbitScratch, px, py, pz,
						selectionOrbit.familyFromColorIndex(landmarks.ENTRIES[i].colorIndex), 0, 0, orbitTime, orbitModel);
				}
				px = orbitScratch[0]; py = orbitScratch[1]; pz = orbitScratch[2];
			}
			if (!selectionCoords.projectToScreen(viewProj, px, py, pz,
				cam[0], cam[1], cam[2], width, height, scratch)) continue;
			const dx = scratch[0] - x;
			const dy = scratch[1] - y;
			const d2 = dx * dx + dy * dy;
			if (d2 <= bestD2) {
				bestD2 = d2;
				best = i;
			}
		}
		return best;
	}

	return { pick, setOrbitState };
}

const Selection = { createSelection, PICK_RADIUS_PX };
if (typeof module !== 'undefined') module.exports = Selection;
if (typeof window !== 'undefined') window.Selection = Selection;
