// src/math/coords.js
// Coordinate conversions shared by the offline encoder and the runtime:
//
//   * raDecParallaxToGalactic — IAU 1958 equatorial → galactic, Sun-centred
//     XYZ in kpc. tile-encoder.js converts the catalog with it (self-tests:
//     Sirius and the galactic-centre direction), and landmarks.js places the
//     named stars with the same call, so the two datasets can never disagree
//     about the frame.
//   * absoluteMagnitude — M = m − 5·log10(d_pc) + 5.
//   * projectToScreen — the same projection the sprite vertex shader applies
//     (camera-relative position through viewProj, clip.w <= 0 = behind the
//     camera). The label layer and the click picker both use it.

'use strict';

// IAU 1958 galactic pole and l = 0 offset, J2000 equatorial degrees.
const GALACTIC_POLE_RA = 192.85948;
const GALACTIC_POLE_DEC = 27.12825;
const GALACTIC_L0 = 122.93192;

function raDecParallaxToGalactic(raDeg, decDeg, parallaxMas) {
	const ra = raDeg * Math.PI / 180;
	const dec = decDeg * Math.PI / 180;
	const aP = GALACTIC_POLE_RA * Math.PI / 180;
	const dP = GALACTIC_POLE_DEC * Math.PI / 180;
	const l0 = GALACTIC_L0 * Math.PI / 180;
	const sinB = Math.sin(dec) * Math.sin(dP) + Math.cos(dec) * Math.cos(dP) * Math.cos(ra - aP);
	const b = Math.asin(Math.max(-1, Math.min(1, sinB)));
	const cosL = (Math.sin(dec) - Math.sin(b) * Math.sin(dP)) / (Math.cos(b) * Math.cos(dP));
	const sinL = Math.cos(dec) * Math.sin(ra - aP) / Math.cos(b);
	let l = Math.atan2(sinL, cosL) - l0;
	while (l < 0) l += 2 * Math.PI;
	while (l >= 2 * Math.PI) l -= 2 * Math.PI;
	const distKpc = parallaxMas > 0 ? 1.0 / parallaxMas : 0;   // 1/parallax[mas] = kpc
	return {
		x: distKpc * Math.cos(b) * Math.cos(l),
		y: distKpc * Math.cos(b) * Math.sin(l),
		z: distKpc * Math.sin(b),
		l: l * 180 / Math.PI,
		b: b * 180 / Math.PI,
		distKpc,
	};
}

function absoluteMagnitude(appMag, distPc) {
	return appMag - 5 * Math.log10(Math.max(1, distPc)) + 5;
}

// World position → pixels through the camera-relative viewProj, exactly as the
// sprite vertex shader does it: rel = position − camera, then clip = viewProj ·
// rel. Returns false when the point is behind the camera (clip.w <= 0). `out`
// receives [pixelX, pixelY, clipW] and is reused between calls. Screen y grows
// downward, clip y grows upward — hence the 0.5 − ndc/2 flip.
function projectToScreen(viewProj, x, y, z, camX, camY, camZ, width, height, out) {
	const rx = x - camX;
	const ry = y - camY;
	const rz = z - camZ;
	const cx = viewProj[0] * rx + viewProj[4] * ry + viewProj[8] * rz + viewProj[12];
	const cy = viewProj[1] * rx + viewProj[5] * ry + viewProj[9] * rz + viewProj[13];
	const cw = viewProj[3] * rx + viewProj[7] * ry + viewProj[11] * rz + viewProj[15];
	if (cw <= 0) return false;
	out[0] = (cx / cw * 0.5 + 0.5) * width;
	out[1] = (0.5 - cy / cw * 0.5) * height;
	out[2] = cw;
	return true;
}

const Coords = {
	GALACTIC_POLE_RA, GALACTIC_POLE_DEC, GALACTIC_L0,
	raDecParallaxToGalactic, absoluteMagnitude, projectToScreen,
};
if (typeof module !== 'undefined') module.exports = Coords;
if (typeof window !== 'undefined') window.Coords = Coords;
