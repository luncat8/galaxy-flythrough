// src/data/landmarks.js
// Named stars: ~60 bright landmarks with on-screen labels, the orbit-target
// pool for click selection, and the vertices of the constellation figures.
//
// Gaia saturates on exactly these stars, so the catalog subset cannot be
// assumed to contain them — the renderer writes them as its own fixed block in
// the star buffer (see render/star-sprites.js).
//
// Each row is J2000: name, RA deg, Dec deg, distance pc, V magnitude, spectral
// class (→ colour LUT index), IAU constellation. Galactic XYZ and the absolute
// magnitude are baked once at load through the same conversion the tile
// encoder uses (src/math/coords.js), so landmarks and catalog stars share one
// frame. Distances/magnitudes are published catalog values; a few percent of
// error is invisible at these scales.

'use strict';

const landmarkDeps = (typeof module !== 'undefined' && module.exports)
	? { coords: require('../math/coords.js'), records: require('../math/star-record.js') }
	: { coords: window.Coords, records: window.StarRecord };

// RA deg, Dec deg, distance pc, V mag, class, constellation.
const RAW = [
	['Sirius',          101.287,  -16.716,    2.64, -1.46, 'A', 'CMa'],
	['Canopus',          95.988,  -52.696,   95.0,  -0.74, 'F', 'Car'],
	['Rigil Kentaurus', 219.902,  -60.834,    1.34, -0.27, 'G', 'Cen'],
	['Arcturus',        213.915,   19.182,   11.26, -0.05, 'K', 'Boo'],
	['Vega',            279.234,   38.784,    7.68,  0.03, 'A', 'Lyr'],
	['Capella',          79.172,   45.998,   13.12,  0.08, 'G', 'Aur'],
	['Rigel',            78.634,   -8.202,  264.0,   0.13, 'B', 'Ori'],
	['Procyon',         114.825,    5.225,    3.51,  0.34, 'F', 'CMi'],
	['Achernar',         24.429,  -57.237,   44.0,   0.46, 'B', 'Eri'],
	['Betelgeuse',       88.793,    7.407,  168.0,   0.50, 'M', 'Ori'],
	['Hadar',           210.956,  -60.373,  120.0,   0.61, 'B', 'Cen'],
	['Altair',          297.696,    8.868,    5.13,  0.76, 'A', 'Aql'],
	['Acrux',           186.650,  -63.099,   99.0,   0.76, 'B', 'Cru'],
	['Aldebaran',        68.980,   16.509,   20.4,   0.86, 'K', 'Tau'],
	['Spica',           201.298,  -11.161,   77.0,   1.04, 'B', 'Vir'],
	['Antares',         247.352,  -26.432,  170.0,   1.06, 'M', 'Sco'],
	['Pollux',          116.329,   28.026,   10.34,  1.14, 'K', 'Gem'],
	['Fomalhaut',       344.413,  -29.622,    7.70,  1.16, 'A', 'PsA'],
	['Deneb',           310.358,   45.280,  802.0,   1.25, 'A', 'Cyg'],
	['Mimosa',          191.930,  -59.689,  108.0,   1.25, 'B', 'Cru'],
	['Regulus',         152.093,   11.967,   24.3,   1.35, 'B', 'Leo'],
	['Castor',          113.650,   31.888,   15.8,   1.58, 'A', 'Gem'],
	['Shaula',          263.402,  -37.104,  175.0,   1.62, 'B', 'Sco'],
	['Gacrux',          187.791,  -57.113,   27.0,   1.63, 'M', 'Cru'],
	['Bellatrix',        81.283,    6.350,   77.0,   1.64, 'B', 'Ori'],
	['Elnath',           81.573,   28.608,   40.0,   1.65, 'B', 'Tau'],
	['Alnilam',          84.053,   -1.202,  606.0,   1.69, 'B', 'Ori'],
	['Alnitak',          85.190,   -1.943,  225.0,   1.77, 'O', 'Ori'],
	['Alioth',          193.507,   55.960,   25.0,   1.77, 'A', 'UMa'],
	['Dubhe',           165.932,   61.751,   37.0,   1.79, 'K', 'UMa'],
	['Wezen',           107.187,  -26.393,  550.0,   1.83, 'F', 'CMa'],
	['Alkaid',          206.885,   49.313,   32.0,   1.85, 'B', 'UMa'],
	['Sargas',          264.330,  -42.998,   84.0,   1.87, 'F', 'Sco'],
	['Alhena',           98.226,   16.399,   33.0,   1.92, 'A', 'Gem'],
	['Mirzam',           95.675,  -17.956,  151.0,   1.98, 'B', 'CMa'],
	['Polaris',          37.955,   89.264,  133.0,   1.98, 'F', 'UMi'],
	['Mizar',           200.981,   54.925,   24.0,   2.04, 'A', 'UMa'],
	['Mirach',           17.433,   35.621,   61.0,   2.05, 'M', 'And'],
	['Alpheratz',         2.097,   29.090,   29.7,   2.06, 'B', 'And'],
	['Saiph',            86.939,   -9.670,  198.0,   2.09, 'B', 'Ori'],
	['Denebola',        177.265,   14.572,   11.0,   2.14, 'A', 'Leo'],
	['Mintaka',          83.002,   -0.299,  380.0,   2.23, 'O', 'Ori'],
	['Sadr',            305.557,   40.257,  540.0,   2.23, 'F', 'Cyg'],
	['Schedar',          10.127,   56.537,   70.0,   2.24, 'K', 'Cas'],
	['Caph',              2.295,   59.150,   16.8,   2.27, 'F', 'Cas'],
	['Dschubba',        240.083,  -22.622,  125.0,   2.29, 'B', 'Sco'],
	['Merak',           165.460,   56.382,   24.0,   2.37, 'A', 'UMa'],
	['Scheat',          345.944,   28.083,   60.0,   2.42, 'M', 'Peg'],
	['Phecda',          178.458,   53.695,   26.0,   2.44, 'A', 'UMa'],
	['Navi',             14.177,   60.717,  168.0,   2.47, 'B', 'Cas'],
	['Markab',          346.190,   15.205,   42.0,   2.49, 'B', 'Peg'],
	['Zosma',           168.527,   20.524,   18.0,   2.56, 'A', 'Leo'],
	['Muphrid',         208.671,   18.398,   11.2,   2.68, 'G', 'Boo'],
	['Ruchbah',          21.454,   60.235,   30.0,   2.68, 'A', 'Cas'],
	['Tarazed',         296.565,   10.613,   14.0,   2.72, 'K', 'Aql'],
	['Imai',            185.341,  -60.400,  110.0,   2.79, 'B', 'Cru'],
	['Algenib',           3.309,   15.184,  106.0,   2.83, 'B', 'Peg'],
	['Albireo',         292.680,   27.960,  133.0,   3.18, 'K', 'Cyg'],
	['Megrez',          183.857,   57.033,   25.0,   3.31, 'A', 'UMa'],
];

// Bake positions and magnitudes once; the frame loop only reads.
const landmarkCount = RAW.length;
const ENTRIES = new Array(landmarkCount);
const landmarkPositions = new Float64Array(landmarkCount * 3);   // kpc, Sun at origin
const landmarkNameIndex = {};
for (let i = 0; i < landmarkCount; i++) {
	const row = RAW[i];
	const name = row[0], ra = row[1], dec = row[2], distPc = row[3], mag = row[4];
	const cls = row[5], constellation = row[6];
	const g = landmarkDeps.coords.raDecParallaxToGalactic(ra, dec, 1000 / distPc);
	ENTRIES[i] = {
		name, ra, dec, distPc, mag, constellation,
		colorIndex: landmarkDeps.records.spectralClassIndex(cls),
		absMag: landmarkDeps.coords.absoluteMagnitude(mag, distPc),
		x: g.x, y: g.y, z: g.z,
	};
	landmarkPositions[i * 3] = g.x;
	landmarkPositions[i * 3 + 1] = g.y;
	landmarkPositions[i * 3 + 2] = g.z;
	landmarkNameIndex[name] = i;
}

function landmarkIndexOf(name) {
	const i = landmarkNameIndex[name];
	return i === undefined ? -1 : i;
}

const Landmarks = { ENTRIES, positions: landmarkPositions, count: landmarkCount, indexOf: landmarkIndexOf };
if (typeof module !== 'undefined') module.exports = Landmarks;
if (typeof window !== 'undefined') window.Landmarks = Landmarks;
