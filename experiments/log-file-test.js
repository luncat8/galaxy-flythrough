// experiments/log-file-test.js
// The log writer (log-file.js): a rerun whose payload is identical apart from
// its `date` must leave the file untouched — timestamp and all — or every test
// run dirties the tree. Anything else (a changed check, a new field, a timing,
// a nested `date`) writes. Also pins the partial-run switch and the first write.
//
// Run: node experiments/log-file-test.js
// Output: none (the writer's own file lives under a temp dir)

'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const logFile = require('./log-file.js');

// `quick`/`changed` preload no-log-writes.js, which turns log writes off; this
// test is about the writer itself, so it runs with the switch cleared.
delete process.env.GALAXY_LOG_WRITES;

const checks = [];
function check(name, test) {
	try {
		test();
		checks.push({ name, pass: true });
	} catch (error) {
		checks.push({ name, pass: false, detail: error.message });
	}
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'galaxy-log-'));
const target = path.join(ROOT, 'nested', 'dir', 'sample.json');

function write(value, options) {
	return logFile.writeLog(target, value, options);
}

function text() {
	return fs.readFileSync(target, 'utf8');
}

function statMtime() {
	return fs.statSync(target).mtimeMs;
}

check('the first write creates the directory and the JSON payload', () => {
	assert.equal(write({ date: '2026-01-01T00:00:00.000Z', totalChecks: 3, passed: 3 }), true);
	assert.deepEqual(JSON.parse(text()), { date: '2026-01-01T00:00:00.000Z', totalChecks: 3, passed: 3 });
	assert.ok(text().endsWith('\n'), 'trailing newline');
});

check('a rerun that differs only in its date keeps the file byte for byte', () => {
	const before = text();
	const mtime = statMtime();
	assert.equal(write({ date: '2026-10-19T06:00:00.000Z', totalChecks: 3, passed: 3 }), false);
	assert.equal(text(), before, 'the old timestamp stays on disk');
	assert.equal(statMtime(), mtime, 'the file was not touched');
});

check('whitespace and indent differences alone do not rewrite', () => {
	const before = text();
	assert.equal(write({ date: '2026-10-19T07:00:00.000Z', totalChecks: 3, passed: 3 }, { indent: '\t' }), false);
	assert.equal(text(), before);
});

check('a changed check rewrites with the new date', () => {
	assert.equal(write({ date: '2026-10-19T08:00:00.000Z', totalChecks: 3, passed: 2 }), true);
	const onDisk = JSON.parse(text());
	assert.equal(onDisk.passed, 2);
	assert.equal(onDisk.date, '2026-10-19T08:00:00.000Z');
});

check('a new or dropped field rewrites', () => {
	assert.equal(write({ date: '2026-10-19T09:00:00.000Z', totalChecks: 3, passed: 2, extra: true }), true);
	assert.equal(JSON.parse(text()).extra, true);
	assert.equal(write({ date: '2026-10-19T10:00:00.000Z', totalChecks: 3 }), true);
	assert.equal(JSON.parse(text()).passed, undefined);
});

check('a nested date is data, not the log timestamp, and a change to it rewrites', () => {
	assert.equal(write({ date: '2026-10-19T11:00:00.000Z', model: { type: 'SBb', seed: 42 } }), true);
	const before = text();
	assert.equal(write({ date: '2026-10-19T12:00:00.000Z', model: { type: 'SBb', seed: 42 } }), false);
	assert.equal(text(), before);
	assert.equal(write({ date: '2026-10-19T13:00:00.000Z', model: { type: 'SBb', seed: 7 } }), true);
	assert.equal(JSON.parse(text()).model.seed, 7);
});

check('a log with no date at all still skips an identical rerun', () => {
	assert.equal(write({ checks: [{ name: 'a', pass: true }], failed: 0 }), true);
	const before = text();
	assert.equal(write({ checks: [{ name: 'a', pass: true }], failed: 0 }), false);
	assert.equal(text(), before);
});

check('a corrupt file on disk is replaced, not treated as unchanged', () => {
	fs.writeFileSync(target, '{ not json');
	assert.equal(write({ date: '2026-10-19T14:00:00.000Z', ok: true }), true);
	assert.deepEqual(JSON.parse(text()), { date: '2026-10-19T14:00:00.000Z', ok: true });
});

check('GALAXY_LOG_WRITES=off leaves the file alone and reports it', () => {
	const before = text();
	process.env.GALAXY_LOG_WRITES = 'off';
	try {
		assert.equal(write({ date: '2026-10-19T15:00:00.000Z', ok: false }), false);
	} finally {
		delete process.env.GALAXY_LOG_WRITES;
	}
	assert.equal(text(), before);
});

check('indent: 0 writes the compact form the visualisation log used', () => {
	assert.equal(write({ date: '2026-10-19T16:00:00.000Z', stars: [1, 2, 3] }, { indent: 0 }), true);
	assert.equal(text(), '{"date":"2026-10-19T16:00:00.000Z","stars":[1,2,3]}\n');
});

fs.rmSync(ROOT, { recursive: true, force: true });

const failed = checks.filter((c) => !c.pass).length;
for (const c of checks) console.log(`${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.pass ? '' : ': ' + c.detail}`);
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed === 0 ? 0 : 1);
