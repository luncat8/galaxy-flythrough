// src/math/galaxy.js
// The GalaxyModel: one plain object per galaxy, carrying every structural and
// population parameter the pipeline reads. Created once (at boot, and again on
// every deliberate regenerate), then threaded through density.js, sampling.js,
// star-types.js, nebula.js, the cell manager and the WGSL mirror. Nothing
// downstream is allowed to remember a galaxy constant of its own.
//
// A model is a pure function of (type, seed, overrides) — no PRNG state, so the
// same type and seed rebuild the same galaxy on any machine, exactly like the
// star fields the descriptor drives.
//
// Two ways to get one:
//   * the authored Milky Way preset (type 'SBb'), whose numbers ARE the constants
//     density.js used to hard-code — the test suite pins that bit-for-bit;
//   * the de Vaucouleurs table below, which turns a stage index T into the shape
//     parameters. The table's SBb row is a cross-check on the preset, not its
//     source: the preset carries the measured Milky Way values (a 12 deg pitch,
//     a super-solar bulge), which the sequence anchors only approximate.
//
// Units: kpc, and every length is already multiplied by `scaleKpc` — consumers
// never apply the size factor themselves. `amp`s are density ratios against the
// Milky Way thin-disc peak; the type's overall mass level is `massTotal` in the
// same Milky Way normalisation, so absolute thresholds elsewhere in the engine
// behave on one scale for every type.

'use strict';

(function () {
	const density = (typeof module !== 'undefined' && module.exports)
		? require('./density.js')
		: window.DensityLib;

	const DEFAULT_SEED = 42;
	const MILKY_WAY_TYPE = 'SBb';

	// ---- the type sequence ---------------------------------------------------
	//
	// Flat anchor tables: each structural parameter is a monotone function of the
	// de Vaucouleurs stage T (-5 … 10), interpolated between these points. No
	// if-else chains (AGENTS.md). Trends from Roberts & Haynes 1994 (B/T, gas) and
	// Kennicutt 1981 (pitch). E flattening uses a model interpolation coordinate
	// on the pure-spheroid anchors, separate from the spiral stage sequence.
	const ANCHORS = {
		// Spheroid-to-total stellar mass ratio. 1.0 along the whole E sequence:
		// an elliptical has no disc, so what varies from E0 to E7 is flattening
		// and n, not B/T.
		B_T: [[-5, 1.00], [-1, 1.00], [0, 0.50], [1, 0.30], [2, 0.25], [3, 0.15],
			[4, 0.10], [5, 0.05], [6, 0.02], [9, 0.02]],
		// Sérsic index of the spheroid: giants de Vaucouleurs (4), late types
		// pseudobulges (1).
		SERSIC_N: [[-5, 4.00], [-2, 4.00], [0, 2.50], [2, 2.00], [3, 2.00],
			[5, 1.00], [6, 1.00], [9, 1.00]],
		// Arm pitch angle; 0 through E and S0, where there is no pattern.
		PITCH_DEG: [[-1, 0.00], [0, 0.00], [1, 7.00], [3, 10.00], [5, 15.00], [6, 22.00]],
		// Arm contrast: peak-to-trough amplitude of the density modulation.
		ARM_AMP: [[-1, 0.00], [0, 0.00], [1, 0.15], [3, 0.20], [5, 0.25], [6, 0.30]],
		// Arm number: grand design in early types, more arms as the pattern
		// breaks into flocculent segments.
		ARM_M: [[0, 2.00], [3, 2.00], [4, 2.00], [5, 3.00], [6, 4.00], [9, 4.00]],
		// Cold gas fraction — gates the young population and the gas nebulae.
		GAS_FRACTION: [[-5, 0.00], [-1, 0.00], [0, 0.02], [1, 0.08], [3, 0.15],
			[5, 0.30], [6, 0.45], [9, 0.50]],
		// Disc thickness: early types are puffier.
		H_OVER_L: [[0, 0.15], [1, 0.12], [3, 0.09], [5, 0.07], [6, 0.06], [9, 0.10]],
	};

	// The Milky Way preset: verbatim the constants density.js used to export.
	// `n` is unused by a plummer profile; it is present because the packed uniform
	// struct has one layout for every type.
	const MILKY_WAY_STRUCTURE = {
		scaleKpc: 1.0,
		centre: { x: 8.178, y: 0, z: 0 },        // Sun–centre distance, GRAVITY 2019
		thin: { L: 2.6, H: 0.300, amp: 1.0 },
		thick: { L: 3.5, H: 0.900, amp: 0.12 },
		spheroid: { profile: 'plummer', a: 1.5, b: 0.5, c: 0.4, r0: 1.0, n: 1, amp: 12.0, tiltDeg: 27 },
		halo: { a_h: 1.0, rMax: 100.0, power: 3.5, amp: 0.0008 },
		arms: { m: 2, amp: 0.20, pitchDeg: 12, Rs: 3.0, phase0: 0, minRadius: 0.5, flocculence: 0 },
		truncation: { discRadius: 25.0, discHeight: 3.0, spheroidRadius: 6.0 },
		populations: { gasFraction: 0.15, youngScaleHeight: 0.5, youngOuterR: 12.0, spheroidOld: true, gasRich: true },
		home: {
			position: [0, 0, 0.005], yaw: 0, pitch: 0,
			// H in orbit mode circles the Sun from 10 pc — a Milky Way start,
			// because the Sun is a Milky Way object.
			orbitTarget: [0, 0, 0], orbitDistance: 0.01, orbitName: 'Sun',
		},
	};

	// What T cannot express: absolute size and mass, the spheroid's axis ratios,
	// whether the model has a halo at all, and the numbers 0.4's orbit families
	// need. `axes` are kpc at scaleKpc 1.0; the E flattening follows the Hubble law
	// b/a = 1 - 0.1·E (E4 → 0.6) with a slightly boxier pole. Speeds are kpc/Myr
	// (1 kpc/Myr = 978 km/s), so sigmaThin 0.031 is the thin disc's ~30 km/s.
	const BASE_SPECS = {
		E4: {
			T: -2, barred: false, profile: 'sersic', scaleKpc: 1.5, massTotal: 0.25,
			axes: [1.00, 0.60, 0.51], discRadius: 25.0, discHeight: 3.0, spheroidRadius: 8.0,
			halo: false, thickShare: 0.0, youngScaleHeight: 0.25,
			dynamics: { vFlat: 0.000, rCore: 0.0, omegaPattern: 0.000, sigmaThin: 0.000,
				sigmaThick: 0.000, sigmaSpheroid: 0.250, spinLambda: 0.15 },
		},
		S0: {
			T: 0, barred: false, profile: 'sersic', scaleKpc: 1.0, massTotal: 0.60,
			axes: [0.90, 0.63, 0.50], discRadius: 25.0, discHeight: 3.0, spheroidRadius: 8.0,
			halo: true, thickShare: 0.30, youngScaleHeight: 0.5,
			dynamics: { vFlat: 0.230, rCore: 1.0, omegaPattern: 0.000, sigmaThin: 0.031,
				sigmaThick: 0.051, sigmaSpheroid: 0.100, spinLambda: 0.0 },
		},
		SBb: {
			T: 3, barred: true, preset: true, profile: 'plummer', scaleKpc: 1.0, massTotal: 1.00,
			axes: [1.50, 0.50, 0.40], discRadius: 25.0, discHeight: 3.0, spheroidRadius: 6.0,
			halo: true, thickShare: 0.246, youngScaleHeight: 0.5,
			dynamics: { vFlat: 0.225, rCore: 0.5, omegaPattern: 0.041, sigmaThin: 0.031,
				sigmaThick: 0.051, sigmaSpheroid: 0.150, spinLambda: 0.0 },
		},
		Sc: {
			T: 5, barred: false, profile: 'sersic', scaleKpc: 1.4, massTotal: 1.30,
			axes: [0.60, 0.42, 0.36], discRadius: 25.0, discHeight: 3.0, spheroidRadius: 6.0,
			halo: true, thickShare: 0.20, youngScaleHeight: 0.6,
			dynamics: { vFlat: 0.200, rCore: 0.5, omegaPattern: 0.025, sigmaThin: 0.031,
				sigmaThick: 0.051, sigmaSpheroid: 0.100, spinLambda: 0.0 },
		},
	};

	function buildTypeSpecs() {
		const specs = {};
		for (let e = 0; e <= 7; e++) {
			specs['E' + e] = Object.assign({}, BASE_SPECS.E4, {
				T: e <= 4 ? -5 + 3 * e / 4 : -2 + (e - 4) / 3,
				n: e <= 4 ? 4 : 4 - 2 * (e - 4) / 3,
				axes: [1, 1 - 0.1 * e, Math.min(1 - 0.1 * e, 1 - 0.1225 * e)],
			});
		}
		specs.S0 = BASE_SPECS.S0;
		// stage, size, mass, spheroid axes, thick-disc share, flocculence, flare, coreRadius
		const spirals = [
			['Sa', 1, 1.0, 0.80, [1.00, 0.80, 0.60], 0.28, 0.10, 0.00, 0.0],
			['Sb', 3, 1.0, 1.00, [0.85, 0.68, 0.50], 0.246, 0.10, 0.05, 0.0],
			['Sc', 5, 1.4, 1.30, [0.60, 0.42, 0.36], 0.20, 0.50, 0.15, 0.0],
			['Sd', 6, 1.5, 1.40, [0.40, 0.32, 0.24], 0.15, 0.70, 0.20, 0.5],
		];
		for (const [type, T, scaleKpc, massTotal, axes, thickShare, flocculence, flare, coreRadius] of spirals) {
			specs[type] = Object.assign({}, BASE_SPECS.Sc, { T, scaleKpc, massTotal, axes, thickShare, flocculence, flare, coreRadius });
		}
		for (const type of ['S0', 'Sa', 'Sb', 'Sc', 'Sd']) {
			const base = specs[type];
			const barredType = 'SB' + type.slice(1);
			specs[barredType] = Object.assign({}, base, {
				barred: true,
				profile: 'bar',
				n: 2.5,
				axes: [base.axes[0] * 1.8, base.axes[1] * 0.7, base.axes[2]],
			});
		}
		specs.SBb = BASE_SPECS.SBb;
		specs.Irr = {
			T: 10, barred: false, profile: 'sersic', scaleKpc: 0.8, massTotal: 0.15,
			axes: [0.50, 0.45, 0.40], discRadius: 15.0, discHeight: 4.0, spheroidRadius: 5.0,
			halo: true, thickShare: 0.40, youngScaleHeight: 0.8, flocculence: 0, flare: 0.2, coreRadius: 0.6,
			dynamics: { vFlat: 0.050, rCore: 0.2, omegaPattern: 0.000, sigmaThin: 0.040,
				sigmaThick: 0.060, sigmaSpheroid: 0.080, spinLambda: 0.30 },
		};
		return specs;
	}
	const TYPE_SPECS = buildTypeSpecs();

	// Shared shape constants: one place for what the table path and the preset
	// both mean by "a disc" and "a halo". The ratios are the preset's own numbers,
	// so the table lands next to it at T = 3.
	const DISC_L_KPC = 2.6;          // thin-disc scale length at scaleKpc 1
	const THICK_L_RATIO = 1.346;     // preset 3.5 / 2.6
	const THICK_H_RATIO = 3.0;       // preset 0.9 / 0.3
	const HALO_A_H_KPC = 1.0;
	const HALO_RMAX_KPC = 100.0;
	const HALO_POWER = 3.5;
	const HALO_AMP_UNIT = 0.0008;    // preset A_halo / A_thin
	const ARM_RS_KPC = 3.0;
	const ARM_MIN_RADIUS_KPC = 0.5;
	const YOUNG_OUTER_R_KPC = 12.0;  // outer edge of the star-forming annulus (~4.6 L)
	// Below this gas fraction a population forms no stars at all: an S0's 0.02
	// is a residual, an Sb's 0.15 is a star-forming disc. The threshold lives on
	// the model (as `populations.gasRich`) so star-types and the nebula layer
	// cannot disagree about which side of it a type falls on.
	const GAS_RICH_MIN = 0.05;

	const GALAXY_TYPES = Object.keys(TYPE_SPECS);
	// What the G key walks through, in the order the plan lists them.
	const GALAXY_TYPE_CYCLE = ['E4', 'S0', 'SBb', 'Sc', 'Irr'];

	// Mass of the preset's components, the unit `massTotal` multiplies. Taken from
	// the preset itself so the normalisation cannot drift away from it.
	let unitMass = 0;
	function massUnit() {
		if (unitMass === 0) unitMass = density.componentMasses(MILKY_WAY).total;
		return unitMass;
	}

	// Piecewise-linear through a flat [[x, y], …] table, clamped at both ends.
	function interpAnchors(anchors, x) {
		const first = anchors[0];
		if (x <= first[0]) return first[1];
		for (let i = 0; i < anchors.length - 1; i++) {
			const lo = anchors[i];
			const hi = anchors[i + 1];
			if (x > hi[0]) continue;
			const t = (x - lo[0]) / (hi[0] - lo[0]);
			return lo[1] + t * (hi[1] - lo[1]);
		}
		return anchors[anchors.length - 1][1];
	}

	function cloneGroup(src) {
		const out = {};
		for (const key of Object.keys(src)) {
			const value = src[key];
			out[key] = Array.isArray(value) ? value.slice() : value;
		}
		return out;
	}

	function cloneStructure(src) {
		const out = {};
		for (const key of Object.keys(src)) {
			const value = src[key];
			out[key] = value && typeof value === 'object' ? cloneGroup(value) : value;
		}
		return out;
	}

	// Camera start: the classic three-quarter view of whatever the type is. The
	// preset keeps its authored Sun position (and a yaw/pitch of 0, which the
	// aim-at-centre rule reproduces to 6e-4 rad — the 5 pc offset is meant to
	// read as the Sun's neighbourhood, not as a view of the core).
	function homeFor(model) {
		const isDisc = model.thin.amp > 0;
		const span = isDisc ? model.thin.L : model.spheroid.a;
		const offset = isDisc ? [0, -3.5 * span, 0.5 * span] : [0, -4.0 * span, 1.2 * span];
		const position = [
			model.centre.x + offset[0],
			model.centre.y + offset[1],
			model.centre.z + offset[2],
		];
		const dx = model.centre.x - position[0];
		const dy = model.centre.y - position[1];
		const dz = model.centre.z - position[2];
		const len = Math.max(1e-9, Math.sqrt(dx * dx + dy * dy + dz * dz));
		return {
			position,
			yaw: Math.atan2(dy, dx),
			pitch: Math.asin(dz / len),
			// Any other type has no sun to circle: H orbits the model centre, from
			// the same stand-off the fly home uses so the view does not change
			// character between the two modes.
			orbitTarget: [model.centre.x, model.centre.y, model.centre.z],
			orbitDistance: len,
			orbitName: 'galaxy centre',
		};
	}

	// A model whose amps are still zero: the mass integrals depend on the shapes
	// only, so they can be measured before the amplitudes are solved.
	function tableGeometry(spec) {
		const k = spec.scaleKpc;
		const T = spec.T;
		const thinL = DISC_L_KPC * k;
		const thinH = thinL * interpAnchors(ANCHORS.H_OVER_L, T);
		const profileId = spec.profile === 'bar'
			? density.PROFILE_BAR
			: (spec.profile === 'sersic' ? density.PROFILE_SERSIC : density.PROFILE_PLUMMER);
		const tiltDeg = spec.barred ? 27 : 0;
		const m = Math.round(interpAnchors(ANCHORS.ARM_M, T));
		const pitchDeg = interpAnchors(ANCHORS.PITCH_DEG, T);
		const pitchRad = pitchDeg * Math.PI / 180;
		const barTiltRad = tiltDeg * Math.PI / 180;
		const minRadius = ARM_MIN_RADIUS_KPC * k;
		const Rs = ARM_RS_KPC * k;
		const phase0 = spec.barred && pitchDeg > 0 ? Math.tan(pitchRad) * Math.log(minRadius / Rs) - m * barTiltRad : 0;
		return {
			scaleKpc: k,
			centre: { x: 0, y: 0, z: 0 },
			thin: { L: thinL, H: thinH, amp: 0, flare: spec.flare || 0, coreRadius: (spec.coreRadius || 0) * k },
			thick: { L: thinL * THICK_L_RATIO, H: thinH * THICK_H_RATIO, amp: 0, flare: spec.flare || 0, coreRadius: (spec.coreRadius || 0) * k },
			spheroid: {
				profile: spec.profile,
				profileId,
				a: spec.axes[0] * k, b: spec.axes[1] * k, c: spec.axes[2] * k,
				r0: 1.0, n: spec.n === undefined ? interpAnchors(ANCHORS.SERSIC_N, T) : spec.n, amp: 0, tiltDeg,
			},
			halo: { a_h: HALO_A_H_KPC * k, rMax: HALO_RMAX_KPC * k, power: HALO_POWER, amp: 0 },
			arms: {
				m,
				amp: interpAnchors(ANCHORS.ARM_AMP, T),
				pitchDeg,
				Rs,
				phase0,
				minRadius,
				flocculence: spec.flocculence || 0,
			},
			truncation: { discRadius: spec.discRadius * k, discHeight: spec.discHeight * k, spheroidRadius: spec.spheroidRadius },
			populations: {
				gasFraction: interpAnchors(ANCHORS.GAS_FRACTION, T),
				youngScaleHeight: spec.youngScaleHeight,
				youngOuterR: YOUNG_OUTER_R_KPC * k,
				spheroidOld: true,
				gasRich: interpAnchors(ANCHORS.GAS_FRACTION, T) >= GAS_RICH_MIN,
			},
		};
	}

	// Amplitudes are the solve, not an anchor: thin.amp is *not* 1.0 outside the
	// preset. B/T sets the spheroid-to-disc split, massTotal the level,
	// thickShare how the disc mass divides. Matching B/T on the untruncated
	// integrals is the right convention (B/T is observed on the whole galaxy);
	// truncationFractions() then reports what the field delivers and the sampler
	// weights itself with that.
	function solveAmps(structure, spec) {
		const integrals = density.massIntegrals(structure);
		const total = spec.massTotal * massUnit();
		const bT = interpAnchors(ANCHORS.B_T, spec.T);
		const disc = total * (1 - bT);
		structure.thin.amp = integrals.thin > 0 ? disc * (1 - spec.thickShare) / integrals.thin : 0;
		structure.thick.amp = integrals.thick > 0 ? disc * spec.thickShare / integrals.thick : 0;
		structure.spheroid.amp = integrals.bulge > 0 ? total * bT / integrals.bulge : 0;
		structure.halo.amp = spec.halo && integrals.halo > 0 ? HALO_AMP_UNIT * spec.massTotal : 0;
	}

	function assemble(type, spec, seed, structure) {
		const model = {
			seed,
			type,
			T: spec.T,
			barred: spec.barred,
			// The catalog subset, the landmarks and the Sun-centred frame are real
			// Milky Way data: they are only honest for the unmodified preset.
			milkyWay: type === MILKY_WAY_TYPE,
			scaleKpc: structure.scaleKpc,
			centre: structure.centre,
			thin: structure.thin,
			thick: structure.thick,
			spheroid: structure.spheroid,
			halo: structure.halo,
			arms: structure.arms,
			truncation: structure.truncation,
			populations: structure.populations,
			// Reserved for 0.4 (star movement); defined from day one so the
			// descriptor never has to grow to accommodate it.
			dynamics: {
				vFlat: spec.dynamics.vFlat,
				rCore: spec.dynamics.rCore,
				omegaPattern: spec.dynamics.omegaPattern,
				sigmaThin: spec.dynamics.sigmaThin,
				sigmaThick: spec.dynamics.sigmaThick,
				sigmaSpheroid: spec.dynamics.sigmaSpheroid,
				spinLambda: spec.dynamics.spinLambda,
				patternLock: false,
			},
			// Distance from the world origin to the centre: the Sun–centre radius,
			// and 0 for every galactocentric type.
			R0: Math.hypot(structure.centre.x, structure.centre.y, structure.centre.z),
			home: structure.home ? cloneGroup(structure.home) : null,
		};
		// The profile is authored as a string and compared as a number, on the CPU
		// and in the packed uniform. Deriving the selector here means the preset and
		// the table path cannot disagree about which profile a model has.
		model.spheroid.profileId = model.spheroid.profile === 'bar'
			? density.PROFILE_BAR
			: (model.spheroid.profile === 'sersic' ? density.PROFILE_SERSIC : density.PROFILE_PLUMMER);
		if (spec.T >= 9 || type === 'Irr') {
			model.clumps = [];
			for (let i = 0; i < 12; i++) {
				const hx = ((seed * 10007 + i * 1009) % 1000) / 1000 - 0.5;
				const hy = ((seed * 10009 + i * 1013) % 1000) / 1000 - 0.5;
				const hz = ((seed * 10037 + i * 1019) % 1000) / 1000 - 0.5;
				model.clumps.push({
					x: hx * structure.truncation.discRadius * 0.6,
					y: hy * structure.truncation.discRadius * 0.6,
					z: hz * structure.truncation.discHeight * 0.5,
					r: 0.3 * structure.scaleKpc,
					boost: 2.0,
				});
			}
		}
		// homeFor reads the assembled model (which components exist), so it runs
		// after the literal rather than inside it.
		if (!model.home) model.home = homeFor(model);
		return model;
	}

	function createMilkyWay() {
		return assemble(MILKY_WAY_TYPE, TYPE_SPECS[MILKY_WAY_TYPE], DEFAULT_SEED,
			cloneStructure(MILKY_WAY_STRUCTURE));
	}

	// (type, seed, overrides) → model. Overrides are per-group and shallow, e.g.
	// { thin: { H: 0.5 } }. Passing a structural override on the Milky Way type
	// yields a model that is *not* the preset, which drops it out of Hybrid mode.
	function createGalaxy(options) {
		const opts = options || {};
		const type = opts.type == null ? MILKY_WAY_TYPE : opts.type;
		const spec = Object.hasOwn(TYPE_SPECS, type) ? TYPE_SPECS[type] : null;
		if (!spec) throw new Error('unknown galaxy type: ' + type);
		const seed = opts.seed === undefined ? DEFAULT_SEED : opts.seed | 0;
		const overrides = opts.overrides;

		if (spec.preset && !overrides) {
			const preset = createMilkyWay();
			preset.seed = seed;
			return preset;
		}
		const structure = tableGeometry(spec);
		solveAmps(structure, spec);
		const model = assemble(type, spec, seed, structure);
		if (overrides) {
			applyOverrides(model, overrides);
			model.milkyWay = false;
			model.R0 = Math.hypot(model.centre.x, model.centre.y, model.centre.z);
			model.populations.gasRich = model.populations.gasFraction >= GAS_RICH_MIN;
			model.home = Object.assign(homeFor(model), overrides.home);
		}
		return model;
	}

	const OVERRIDABLE = ['scaleKpc', 'centre', 'thin', 'thick', 'spheroid', 'halo',
		'arms', 'truncation', 'populations', 'dynamics', 'home'];

	function applyOverrides(model, overrides) {
		for (const group of Object.keys(overrides)) {
			if (OVERRIDABLE.indexOf(group) < 0) throw new Error('galaxy override not allowed: ' + group);
			const value = overrides[group];
			if (typeof value === 'number') { model[group] = value; continue; }
			const target = model[group];
			for (const key of Object.keys(value)) target[key] = value[key];
			// An authored profile string and the numeric selector the hot path
			// compares must not disagree.
			if (group === 'spheroid' && value.profile !== undefined) {
				target.profileId = value.profile === 'bar'
					? density.PROFILE_BAR
					: (value.profile === 'sersic' ? density.PROFILE_SERSIC : density.PROFILE_PLUMMER);
			}
		}
	}

	// The Milky Way preset, ready to hand: the engine's default model.
	const MILKY_WAY = createMilkyWay();

	// ---- the WGSL mirror contract -------------------------------------------
	//
	// Density is no longer a list of constants the shader can re-type, so the
	// mirror becomes a struct the CPU packs. One layout list, three consumers:
	// this packer, the `DensityParams` struct in shaders.js, and the validator
	// that pins the two against each other. All f32, vec4-aligned, no scalars
	// between groups — the profile selector is a float so the struct stays one
	// flat array of vec4s.
	const DENSITY_PARAMS_LAYOUT = [
		{ name: 'centre', source: 'centre', fields: ['x', 'y', 'z', 'unused'] },
		{ name: 'thin', source: 'thin', fields: ['L', 'H', 'amp', 'flare'] },
		{ name: 'thick', source: 'thick', fields: ['L', 'H', 'amp', 'coreRadius'] },
		{ name: 'spheroid', source: 'spheroid', fields: ['a', 'b', 'c', 'r0'] },
		{ name: 'spheroidShape', source: 'spheroid', fields: ['amp', 'n', 'tiltDeg', 'profileId'] },
		{ name: 'halo', source: 'halo', fields: ['a_h', 'rMax', 'power', 'amp'] },
		{ name: 'arms', source: 'arms', fields: ['m', 'amp', 'pitchDeg', 'Rs'] },
		{ name: 'armShape', source: 'arms', fields: ['phase0', 'minRadius', 'flocculence', 'unused'] },
		// Only the fields the mirrored *formulas* read. youngScaleHeight and
		// spheroidOld are consumed on the CPU (nebula placement, 0.3.1
		// gradients), so they stay out of the uniform rather than riding along
		// to the GPU unused.
		{ name: 'populations', source: 'populations', fields: ['gasFraction', 'youngOuterR', 'gasRich', 'unused'] },
		{ name: 'truncation', source: 'truncation', fields: ['discRadius', 'discHeight', 'spheroidRadius', 'unused'] },
	];
	const DENSITY_PARAMS_FLOATS = DENSITY_PARAMS_LAYOUT.length * 4;
	const DENSITY_PARAMS_BYTES = DENSITY_PARAMS_FLOATS * 4;

	// Writes the model into `out` (a Float32Array of DENSITY_PARAMS_FLOATS) in
	// place: called at build and on regenerate, never per frame.
	function packDensityParams(model, out) {
		let i = 0;
		for (const group of DENSITY_PARAMS_LAYOUT) {
			const src = model[group.source];
			for (const field of group.fields) {
				const value = field === 'unused' ? undefined : src[field];
				out[i++] = typeof value === 'boolean' ? (value ? 1 : 0) : (value === undefined ? 0 : value);
			}
		}
		return out;
	}

	function galaxyLabel(model) {
		return `galaxy ${model.type} #${model.seed >>> 0}`;
	}

	function cycleGalaxyType(type) {
		const i = GALAXY_TYPE_CYCLE.indexOf(type);
		return GALAXY_TYPE_CYCLE[(i + 1) % GALAXY_TYPE_CYCLE.length];
	}

	const GalaxyLib = {
		DEFAULT_SEED, MILKY_WAY_TYPE, MILKY_WAY,
		ANCHORS, TYPE_SPECS, GALAXY_TYPES, GALAXY_TYPE_CYCLE,
		DISC_L_KPC, THICK_L_RATIO, THICK_H_RATIO, HALO_AMP_UNIT, YOUNG_OUTER_R_KPC, GAS_RICH_MIN,
		interpAnchors, createGalaxy, cycleGalaxyType, galaxyLabel, homeFor,
		DENSITY_PARAMS_LAYOUT, DENSITY_PARAMS_FLOATS, DENSITY_PARAMS_BYTES,
		packDensityParams,
	};
	if (typeof module !== 'undefined') module.exports = GalaxyLib;
	if (typeof window !== 'undefined') window.GalaxyLib = GalaxyLib;
})();
