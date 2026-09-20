// src/data/constellations.js
// Constellation figures: pairs of landmark names, resolved to landmark
// indices at load. An unknown name throws — a typo in a figure must fail the
// page load, not silently drop a line mid-sky.
//
// Figures are the classic asterism shapes, drawn as screen-space segments by
// render/label-layer.js. The Great Square uses Alpheratz, which belongs to
// Andromeda — figures may borrow stars across constellation borders.

'use strict';

const landmarksDep = (typeof module !== 'undefined' && module.exports)
	? require('./landmarks.js')
	: window.Landmarks;

const FIGURES = [
	{ name: 'Orion', edges: [
		['Betelgeuse', 'Bellatrix'], ['Bellatrix', 'Mintaka'],
		['Mintaka', 'Alnilam'], ['Alnilam', 'Alnitak'], ['Alnitak', 'Betelgeuse'],
		['Mintaka', 'Rigel'], ['Alnitak', 'Saiph'], ['Saiph', 'Rigel'],
	]},
	{ name: 'Ursa Major', edges: [
		['Dubhe', 'Merak'], ['Merak', 'Phecda'], ['Phecda', 'Megrez'], ['Megrez', 'Dubhe'],
		['Megrez', 'Alioth'], ['Alioth', 'Mizar'], ['Mizar', 'Alkaid'],
	]},
	{ name: 'Cassiopeia', edges: [
		['Caph', 'Schedar'], ['Schedar', 'Navi'], ['Navi', 'Ruchbah'],
	]},
	{ name: 'Cygnus', edges: [
		['Deneb', 'Sadr'], ['Sadr', 'Albireo'],
	]},
	{ name: 'Scorpius', edges: [
		['Dschubba', 'Antares'], ['Antares', 'Sargas'], ['Sargas', 'Shaula'],
	]},
	{ name: 'Crux', edges: [
		['Acrux', 'Gacrux'], ['Mimosa', 'Imai'],
	]},
	{ name: 'Gemini', edges: [
		['Castor', 'Pollux'], ['Pollux', 'Alhena'],
	]},
	{ name: 'Leo', edges: [
		['Regulus', 'Zosma'], ['Zosma', 'Denebola'], ['Denebola', 'Regulus'],
	]},
	{ name: 'Taurus', edges: [
		['Aldebaran', 'Elnath'],
	]},
	{ name: 'Aquila', edges: [
		['Tarazed', 'Altair'],
	]},
	{ name: 'Pegasus', edges: [
		['Markab', 'Scheat'], ['Scheat', 'Alpheratz'],
		['Alpheratz', 'Algenib'], ['Algenib', 'Markab'],
	]},
	{ name: 'Andromeda', edges: [
		['Alpheratz', 'Mirach'],
	]},
	{ name: 'Canis Major', edges: [
		['Sirius', 'Mirzam'], ['Mirzam', 'Wezen'],
	]},
	{ name: 'Centaurus', edges: [
		['Rigil Kentaurus', 'Hadar'],
	]},
	{ name: 'Bootes', edges: [
		['Muphrid', 'Arcturus'],
	]},
];

const LINES = FIGURES.map((figure) => {
	const edges = new Int16Array(figure.edges.length * 2);
	for (let j = 0; j < figure.edges.length; j++) {
		const a = landmarksDep.indexOf(figure.edges[j][0]);
		const b = landmarksDep.indexOf(figure.edges[j][1]);
		if (a < 0 || b < 0) {
			throw new Error(`constellation ${figure.name}: unknown landmark ${a < 0 ? figure.edges[j][0] : figure.edges[j][1]}`);
		}
		edges[j * 2] = a;
		edges[j * 2 + 1] = b;
	}
	return { name: figure.name, edges };
});

let edgeCount = 0;
for (const figure of LINES) edgeCount += figure.edges.length / 2;

const Constellations = { LINES, count: LINES.length, edgeCount };
if (typeof module !== 'undefined') module.exports = Constellations;
if (typeof window !== 'undefined') window.Constellations = Constellations;
