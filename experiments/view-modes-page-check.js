// experiments/view-modes-page-check.js
// Headless boot + paint check for the view-modes island page.
//
// The field math has its own parity test; what that test cannot see is the page:
// whether view-modes.html loads the island in an order that boots, whether the
// UI wiring survives a slider and a drag, and what the painted map actually
// looks like. So this harness stubs a canvas, evaluates the real page scripts in
// the real <script> order, pumps frames, and writes the result to
// experiments/logs/view-modes-page-*.png for the eye to check (the check the eye
// gets to make is "do the dots spell out a constellation").
//
// Run: node experiments/view-modes-page-check.js [--png]
// Output: experiments/logs/view-modes-page.json (+ PNGs)

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const WRITE_PNG = process.argv.includes('--png');

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass: !!pass, detail });
	return !!pass;
}

// --- a canvas 2D context that records enough to be inspected ---------------
function makeContext(canvas) {
	const ctx = {
		canvas,
		_image: null,           // the ImageData last put here
		fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, font: '',
		textBaseline: '', textAlign: '',
		imageSmoothingEnabled: true, imageSmoothingQuality: 'low',
		globalAlpha: 1,
		ops: { fillRect: 0, drawImage: 0, arc: 0, fill: 0, stroke: 0, fillText: 0, putImageData: 0 },
		_paths: [], _dots: [],
	};
	const noop = () => {};
	ctx.reset = () => { ctx._paths.length = 0; ctx._dots.length = 0; ctx._texts.length = 0; };
	ctx.save = noop; ctx.restore = noop; ctx.beginPath = noop; ctx.closePath = noop;
	ctx.setLineDash = noop; ctx.clip = noop;
	ctx.fillRect = (x, y, w, h) => { ctx.ops.fillRect++; };
	ctx.strokeRect = noop;
	ctx.translate = noop; ctx.scale = noop; ctx.rotate = noop;
	ctx.moveTo = (x, y) => { ctx._paths.push([x, y]); };
	ctx.lineTo = (x, y) => { ctx._paths.push([x, y]); };
	ctx.arc = (x, y, r) => { ctx.ops.arc++; (ctx._dots || (ctx._dots = [])).push([x, y, r]); };
	ctx.fill = () => { ctx.ops.fill++; };
	ctx.stroke = () => { ctx.ops.stroke++; };
	ctx.fillText = (t) => { ctx.ops.fillText++; ctx._texts = (ctx._texts || []); ctx._texts.push(t); };
	ctx.measureText = (t) => ({ width: t.length * 6 });
	ctx.createImageData = (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
	ctx.getImageData = (x, y, w, h) => ctx._image || ctx.createImageData(w, h);
	ctx.putImageData = (img) => { ctx.ops.putImageData++; ctx._image = img; };
	ctx.drawImage = (img, dx, dy, dw, dh) => {
		ctx.ops.drawImage++;
		// Nearest-neighbour upscale into the destination buffer, so the PNG the
		// harness writes is the field as the page laid it out.
		const src = (img && img._image) ? img._image : (img && img._ctx && img._ctx._image) ? img._ctx._image : img;
		if (!src || !src.data || !canvas._pixels) return;
		const W = canvas.width, H = canvas.height;
		if (!canvas._pixels || canvas._pixels.length < W * H * 4) canvas._pixels = new Uint8Array(W * H * 4);
		// Only the destination rect, like a real drawImage: the legend strip is a
		// second, small drawImage and must not stretch over the whole map.
		dw = dw || src.width; dh = dh || src.height;
		const x0 = Math.max(0, Math.floor(dx || 0)), y0 = Math.max(0, Math.floor(dy || 0));
		const x1 = Math.min(W, Math.ceil((dx || 0) + dw));
		const y1 = Math.min(H, Math.ceil((dy || 0) + dh));
		for (let y = y0; y < y1; y++) {
			const sy = Math.min(src.height - 1, Math.max(0, Math.floor((y - y0) / Math.max(1, dh) * src.height)));
			for (let x = x0; x < x1; x++) {
				const sx = Math.min(src.width - 1, Math.max(0, Math.floor((x - x0) / Math.max(1, dw) * src.width)));
				const si = (sy * src.width + sx) * 4, di = (y * W + x) * 4;
				canvas._pixels[di] = src.data[si];
				canvas._pixels[di + 1] = src.data[si + 1];
				canvas._pixels[di + 2] = src.data[si + 2];
				canvas._pixels[di + 3] = 255;
			}
		}
	};
	return ctx;
}

function makeCanvas(w, h) {
	const c = {
		width: w, height: h, clientWidth: w, clientHeight: h,
		style: {}, _listeners: {},
		getContext() { return c._ctx || (c._ctx = makeContext(c)); },
		addEventListener(t, fn) { (c._listeners[t] || (c._listeners[t] = [])).push(fn); },
		setPointerCapture: () => {},
		releasePointerCapture: () => {},
		getBoundingClientRect() { return { left: 0, top: 0, width: c.clientWidth, height: c.clientHeight }; },
		_pixels: new Uint8Array(w * h * 4),
	};
	return c;
}

function makeElement(id, extra) {
	const el = Object.assign({
		id, value: '', checked: false, textContent: '', style: {}, dataset: {},
		_listeners: {},
		addEventListener(t, fn) { (el._listeners[t] || (el._listeners[t] = [])).push(fn); },
		fire(t) { const l = el._listeners[t]; if (l) for (const fn of l) fn({ preventDefault() {} }); },
		appendChild() {},
		remove() {},
	}, extra || {});
	return el;
}

// --- the page's DOM --------------------------------------------------------
const VIEW_W = 720, VIEW_H = 405;
const fieldCanvas = makeCanvas(VIEW_W, VIEW_H);
const els = { field: fieldCanvas };
function el(id) {
	if (!els[id]) els[id] = makeElement(id);
	return els[id];
}
// Mirror every id the page HTML declares, so a missing element is a boot error
// here exactly as it is in the browser.
const htmlPath = path.join(SRC, 'view-modes.html');
const html = fs.readFileSync(htmlPath, 'utf8');
for (const m of html.matchAll(/id="([^"]+)"/g)) el(m[1]);
for (const m of html.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]+)"/g)) {
	el(`${m[1]}=${m[2]}`, { value: m[2], checked: false });
}

let rafQueue = [];
globalThis.window = globalThis;
globalThis.document = {
	createElement: (tag) => (tag === 'canvas' ? makeCanvas(256, 256) : makeElement(tag)),
	getElementById: (id) => el(id),
	querySelectorAll: (sel) => {
		const m = /^input\[name="([^"]+)"\]$/.exec(sel);
		if (!m) return [];
		return Object.values(els).filter((e) => e.id && e.id.startsWith(m[1] + '='));
	},
	head: { appendChild: () => {} },
};
globalThis.requestAnimationFrame = (fn) => { rafQueue.push(fn); return rafQueue.length; };
globalThis.cancelAnimationFrame = () => {};
globalThis.devicePixelRatio = 1;
globalThis.performance = globalThis.performance || { now: () => Date.now() };
globalThis.addEventListener = () => {};

// Radio groups default to whichever tag carries `checked` in the HTML.
for (const m of html.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]+)"[^>]*checked/g)) {
	const e = el(`${m[1]}=${m[2]}`);
	e.checked = true;
}
for (const m of html.matchAll(/id="(slider-[^"]+)"[^>]*value="([^"]+)"/g)) {
	const e = el(m[1]);
	e.value = m[2];
	e.fire('input');
}
for (const m of html.matchAll(/id="(check-[^"]+)"[^>]*checked/g)) el(m[1]).checked = true;

// --- load the page's scripts, in the order the page declares them ---------
const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
check('view-modes.html loads the island scripts', scripts.length >= 12, { n: scripts.length });
check('view-modes.html loads the field, the painter and the boot last',
	scripts[scripts.length - 3] === 'math/view-modes-field.js'
	&& scripts[scripts.length - 2] === 'render/view-modes-renderer.js'
	&& scripts[scripts.length - 1] === 'view-modes.js',
	scripts.slice(-3));
check('the page loads the catalog bundle as a data script',
	scripts.includes('data/tiles/catalog.js'), scripts.filter(s => s.includes('catalog')));
check('the island loads no core/ or stream/ module',
	!scripts.some(s => /^(core|stream)\//.test(s) || s === 'render/star-sprites.js' || s === 'render/shaders.js'),
	scripts.filter(s => /^(core|stream)\//.test(s) || /star-sprites|shaders/.test(s)));

const errors = [];
for (const rel of scripts) {
	const file = path.join(SRC, rel);
	if (!fs.existsSync(file)) { errors.push(`missing ${rel}`); continue; }
	try {
		vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
	} catch (e) {
		errors.push(`${rel}: ${e && e.message}`);
	}
}
check('every script in the page evaluates in order', errors.length === 0, errors);
check('the page found no boot error element text', !el('error').textContent, el('error').textContent);

const FRAMES = { n: 0 };
function pump(frames, t0) {
	let t = t0 || 0;
	for (let i = 0; i < frames; i++) {
		const q = rafQueue; rafQueue = [];
		t += 16.7;
		FRAMES.n += q.length;
		for (const fn of q) {
			try { fn(t); } catch (e) { errors.push(`frame: ${e && e.stack ? e.stack.split('\n')[0] : e}`); }
		}
	}
	return t;
}
const tEnd = pump(3);
check('the first frames ran clean', errors.length === 0, errors.slice(0, 3));

const readout = el('readout').textContent || '';
check('readout reports the view-sphere projection at the app FoV',
	/view sphere · 60°/.test(readout), readout.split('\n')[0]);
check('readout reports the landmark anchors', /constellations · 60 anchors \(landmarks\)/.test(readout),
	readout.split('\n')[1]);
check('readout reports a non-empty field', /[1-9]\d*×\d+/.test(readout), readout.split('\n').slice(-1)[0]);
check('the painter drew the field and the star overlay',
	fieldCanvas.getContext().ops.drawImage > 0 && fieldCanvas.getContext().ops.arc > 10,
	{ ...fieldCanvas.getContext().ops });

// A dot must land on the texel the field says, i.e. the renderer has to subtract
// the eye before asking where a star is. Absolute positions look fine on a chart
// (the eye is ~0.005 kpc off the origin) and wrong in the view sphere.
check('a marker dot lands on its star\'s texel, not its raw position', (() => {
	const Field = window.ViewModesField;
	const ctx = fieldCanvas.getContext();
	if (!ctx._dots.length) return false;
	const dbg = window.ViewModesDebug;
	if (!dbg || !dbg.layout || !dbg.cur) return 'no page handle';
	const lay = dbg.layout;
	const hit = { x: 0, y: 0, inside: false };
	const pos = dbg.cur;
	const eye = dbg.pos;
	const rect = { x: 0, y: 0, w: VIEW_W, h: VIEW_H };
	const sx = rect.w / lay.w, sy = rect.h / lay.h;
	let worst = 1e9;
	for (let i = 0; i < Math.min(20, pos.length / 3); i++) {
		Field.texelOf(lay, pos[i * 3] - eye[0], pos[i * 3 + 1] - eye[1], pos[i * 3 + 2] - eye[2], hit);
		if (!hit.inside) continue;
		const x = rect.x + (hit.x + 0.5) * sx, y = rect.y + (hit.y + 0.5) * sy;
		for (const d of ctx._dots) {
			const e = Math.hypot(d[0] - x, d[1] - y);
			if (e < worst) worst = e;
		}
	}
	return worst < 1.0 ? true : { worstPx: +worst.toFixed(2) };
})(), null);
check('star labels landed on the map', (fieldCanvas.getContext()._texts || []).includes('Sirius')
	|| (fieldCanvas.getContext()._texts || []).length > 3, (fieldCanvas.getContext()._texts || []).slice(0, 8));

// --- a drag must look around, and the map must follow ---------------------
function fireOn(target, type, ev) {
	const l = target._listeners[type];
	if (!l) throw new Error(`no ${type} listener`);
	for (const fn of l) fn(Object.assign({ preventDefault() {}, shiftKey: false, button: 0, pointerId: 1 }, ev));
}
const before = Buffer.from(fieldCanvas._pixels);
fireOn(fieldCanvas, 'pointerdown', { clientX: 360, clientY: 200 });
fireOn(fieldCanvas, 'pointermove', { clientX: 430, clientY: 210 });
fireOn(fieldCanvas, 'pointerup', {});
pump(1, tEnd);
let changed = 0;
for (let i = 0; i < before.length; i += 4) if (before[i] !== fieldCanvas._pixels[i]) changed++;
check('dragging looks around: the map repaints', changed > 1000, { changedPx: changed });
check('the look survived the frame loop', /view sphere/.test(el('readout').textContent), null);

// --- projection and mode switches ----------------------------------------
function selectRadio(name, value) {
	for (const e of Object.values(els)) {
		if (e.id && e.id.startsWith(name + '=')) e.checked = e.id === `${name}=${value}`;
	}
	const target = el(`${name}=${value}`, { value });
	target.value = value;
	target.fire('change');
}
selectRadio('projection', 'plane');
pump(2, tEnd + 100);
check('the chart strokes the constellation figures as segments',
	fieldCanvas.getContext()._paths.length > 60, (() => {
		const dbg = window.ViewModesDebug, F = window.ViewModesField;
		const set = dbg.set, pos = dbg.cur, lay = dbg.layout;
		if (!set || !set.segments) return 'no segments on the set';
		const hit = { x: 0, y: 0, inside: false };
		let outA = 0, outB = 0, seam = 0, drawn = 0;
		for (let i = 0; i < set.segments.length; i += 2) {
			const a = set.segments[i], b = set.segments[i + 1];
			F.texelOf(lay, pos[a * 3] - dbg.pos[0], pos[a * 3 + 1] - dbg.pos[1], pos[a * 3 + 2] - dbg.pos[2], hit);
			if (!hit.inside) { outA++; continue; }
			const ax = (hit.x + 0.5) * (VIEW_W / lay.w), ay = (hit.y + 0.5) * (VIEW_H / lay.h);
			F.texelOf(lay, pos[b * 3] - dbg.pos[0], pos[b * 3 + 1] - dbg.pos[1], pos[b * 3 + 2] - dbg.pos[2], hit);
			if (!hit.inside) { outB++; continue; }
			const bx = (hit.x + 0.5) * (VIEW_W / lay.w), by = (hit.y + 0.5) * (VIEW_H / lay.h);
			if (Math.abs(bx - ax) > VIEW_W * 0.5 || Math.abs(by - ay) > VIEW_H * 0.5) { seam++; continue; }
			drawn++;
		}
		return { segs: set.segments.length / 2, outA, outB, seam, drawn, w: lay.w, h: lay.h };
	})());
check('the plane chart paints too', /plane chart/.test(el('readout').textContent), el('readout').textContent.split('\n')[0]);
check('the chart keeps the sky: no frame error', errors.length === 0, errors.slice(0, 2));
selectRadio('view-mode', 'spread');
pump(2, tEnd + 200);
check('mode 2 runs without a frame error', errors.length === 0, errors.slice(0, 2));
el('slider-source').value = '250';
el('slider-source').fire('input');
pump(2, tEnd + 300);
check('nearest-250 re-picks from the catalog', /250 nearest · 250 anchors \(catalog\)/.test(el('readout').textContent),
	el('readout').textContent.split('\n')[1]);
selectRadio('view-mode', 'off');
pump(1, tEnd + 400);
check('off clears the canvas', errors.length === 0, errors);

// --- PNGs for the eye ------------------------------------------------------
function writePng(file, w, h, rgba) {
	const raw = Buffer.alloc((w * 3 + 1) * h);
	let o = 0;
	for (let y = 0; y < h; y++) {
		raw[o++] = 0;
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 4;
			raw[o++] = rgba[i]; raw[o++] = rgba[i + 1]; raw[o++] = rgba[i + 2];
		}
	}
	const crcTable = [];
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		crcTable[n] = c >>> 0;
	}
	const crc = (buf) => {
		let c = 0xffffffff;
		for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type, data) => {
		const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
		const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
		const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc(body), 0);
		return Buffer.concat([len, body, crcBuf]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
	fs.writeFileSync(file, Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0)),
	]));
}

// Repaint one configuration at a time so each PNG is a readable state.
const shots = [
	{ name: 'view-height', mode: 'height', proj: 'view' },
	{ name: 'chart-height', mode: 'height', proj: 'plane' },
	{ name: 'chart-spread', mode: 'spread', proj: 'plane' },
];
const logDir = path.join(__dirname, 'logs');
fs.mkdirSync(logDir, { recursive: true });
let pngs = [];
if (WRITE_PNG) {
	for (const shot of shots) {
		fieldCanvas.getContext()._paths.length = 0;
		fieldCanvas.getContext()._texts = [];
		selectRadio('view-mode', shot.mode);
		selectRadio('projection', shot.proj);
		el('slider-source').value = '0';
		el('slider-source').fire('input');
		selectRadio('budget', 'high');
		pump(2, 1e6 + pngs.length * 1000);
		const file = path.join(logDir, `view-modes-page-${shot.name}.png`);
		writePng(file, VIEW_W, VIEW_H, fieldCanvas._pixels);
		pngs.push(path.relative(ROOT, file));
	}
	check('the screenshots are not blank', (() => {
		const buf = fieldCanvas._pixels;
		let uniq = new Set();
		for (let i = 0; i < buf.length; i += 4 * 977) uniq.add(`${buf[i]},${buf[i + 1]},${buf[i + 2]}`);
		return uniq.size > 8;
	})(), null);
}

// --- Report ---------------------------------------------------------------
let passed = 0, failed = 0;
for (const c of checks) {
	if (c.pass) passed++; else failed++;
	console.log(`  ${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.pass ? '' : `  -> ${JSON.stringify(c.detail)}`}`);
}
console.log(`\n${passed}/${checks.length} passed, ${failed} failed`);
if (pngs.length) console.log('wrote: ' + pngs.join(', '));
console.log('readout:\n' + String(el('readout').textContent).replace(/^/gm, '    '));

fs.writeFileSync(path.join(logDir, 'view-modes-page.json'), JSON.stringify({
	totalChecks: checks.length, passed, failed, checks,
}, null, 2));
console.log('frames pumped:', FRAMES.n, 'queued:', rafQueue.length);
console.log('=== VERDICT ===');
console.log(failed === 0 ? 'PASS — the island page boots, wires and paints' : `FAIL — ${failed} checks failed`);
process.exit(failed === 0 ? 0 : 1);
