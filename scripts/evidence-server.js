#!/usr/bin/env node
// The C9 evidence server: a zero-dependency static server for src/ that also
// accepts the smoke page's log submissions, so a real-GPU browser session can
// persist its evidence straight into experiments/logs/ (the page's Send log
// button POSTs here; under file:// the button is hidden and Save/Copy remain
// the record path). http://localhost is a secure context for WebGPU, and the
// sandbox preview proxy terminates https in front of it.
//
// Usage: node scripts/evidence-server.js   (PORT=… to override 8080)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const LOGS = path.join(ROOT, 'experiments', 'logs');
const PORT = Number(process.env.PORT || 8080);
const MAX_BODY = 8 * 1024 * 1024;

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.png': 'image/png',
	'.webp': 'image/webp',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.wasm': 'application/wasm',
	'.bin': 'application/octet-stream',
};

function stamp(date) {
	const pad = (n) => String(n).padStart(2, '0');
	return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
		+ '-' + pad(date.getHours()) + '-' + pad(date.getMinutes());
}

function sanitiseFrameLabel(raw, fallback) {
	const cleaned = String(raw || '')
		.replace(/[\\/:*?"<>|\u0000-\u001F]+/g, '-')
		.replace(/^\.+/, '')
		.trim()
		.slice(0, 80);
	return cleaned || fallback;
}

function saveEvidence(req, res) {
	let body = '';
	let size = 0;
	req.on('data', (chunk) => {
		size += chunk.length;
		if (size > MAX_BODY) {
			res.writeHead(413, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ ok: false, error: 'body too large' }));
			req.destroy();
			return;
		}
		body += chunk;
	});
	req.on('end', () => {
		try {
			const parsed = JSON.parse(body);
			const text = String(parsed.text || '');
			if (!text) throw new Error('empty log');
			const raw = String(parsed.name || 'webgpu-smoke');
			const safe = raw.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[-.]+/, '').slice(0, 80) || 'webgpu-smoke';
			const sessionBase = safe + '-' + stamp(new Date());
			fs.mkdirSync(LOGS, { recursive: true });
			const file = path.join(LOGS, sessionBase + '.log');
			fs.writeFileSync(file, text);
			const rel = path.relative(ROOT, file);
			let frameCount = 0;
			let framesDirRel = null;
			if (Array.isArray(parsed.frames) && parsed.frames.length > 0) {
				const framesDir = path.join(LOGS, sessionBase);
				fs.mkdirSync(framesDir, { recursive: true });
				const usedNames = new Set();
				for (let i = 0; i < Math.min(parsed.frames.length, 32); i++) {
					const item = parsed.frames[i];
					if (!item || typeof item.dataUrl !== 'string') continue;
					const m = /^data:image\/(webp|png);base64,([A-Za-z0-9+/=\s]+)$/.exec(item.dataUrl);
					if (!m) continue;
					const ext = '.' + m[1];
					let base = sanitiseFrameLabel(item.label, 'frame-' + i);
					let candidate = base + ext;
					let dup = 2;
					while (usedNames.has(candidate)) {
						candidate = base + '-' + dup + ext;
						dup++;
					}
					usedNames.add(candidate);
					fs.writeFileSync(path.join(framesDir, candidate), Buffer.from(m[2], 'base64'));
					frameCount++;
				}
				if (frameCount > 0) framesDirRel = path.relative(ROOT, framesDir);
			}
			console.log('[evidence] saved ' + rel + ' (' + text.length + ' chars'
				+ (frameCount > 0 ? ', ' + frameCount + ' frames in ' + framesDirRel : '') + ')');
			const reply = { ok: true, file: rel };
			if (frameCount > 0) {
				reply.framesDir = framesDirRel;
				reply.frameCount = frameCount;
			}
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(reply));
		} catch (err) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
		}
	});
}

function serveStatic(req, res, pathname) {
	let rel = decodeURIComponent(pathname);
	if (rel === '/') rel = '/webgpu-smoke.html';
	const file = path.normalize(path.join(SRC, rel));
	if (!file.startsWith(SRC + path.sep) && file !== SRC) {
		res.writeHead(403); res.end('forbidden'); return;
	}
	if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
		res.writeHead(404); res.end('not found'); return;
	}
	res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
	if (req.method === 'HEAD') { res.end(); return; }
	fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
	const url = new URL(req.url, 'http://localhost');
	if (url.pathname === '/__evidence') {
		if (req.method === 'POST') { saveEvidence(req, res); return; }
		res.writeHead(405); res.end(); return;
	}
	if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
	serveStatic(req, res, url.pathname);
});

server.listen(PORT, '0.0.0.0', () => {
	console.log('evidence server on http://0.0.0.0:' + PORT + ' serving src/');
	console.log('smoke page: http://localhost:' + PORT + '/webgpu-smoke.html?run=all | app: http://localhost:' + PORT + '/index.html');
});
