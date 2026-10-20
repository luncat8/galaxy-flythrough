// Deterministic heap/reference checks, independent of the economy fixtures.
'use strict';

const assert = require('assert/strict');
const path = require('path');
const queueLib = require('../src/core/exec-queue.js');
const logFile = require('./log-file.js');
const checks = [];
function check(name, test) {
	test();
	checks.push({ name, pass: true });
}

check('empty pop, drain, clear and peek are harmless', () => {
	const q = queueLib.createExecQueue(1);
	queueLib.pop(q);
	assert.equal(q.size, 0);
	assert.equal(queueLib.peekTime(q), Infinity);
	queueLib.drainUntil(q, Infinity, () => assert.fail('empty handler'));
	queueLib.push(q, 5, 3, 4, 7);
	queueLib.clear(q);
	assert.equal(q.size, 0);
	queueLib.pop(q);
	queueLib.push(q, 2, 1, 8, 9);
	queueLib.drainUntil(q, 2, (time, kind, ref, rev) => assert.deepEqual([time, kind, ref, rev], [2, 1, 8, 9]));
});

check('50,000 grown entries preserve every column against a sorted reference', () => {
	const q = queueLib.createExecQueue(8);
	const count = 50000;
	const times = new Float64Array(count);
	const seen = new Uint8Array(count);
	const reference = [];
	for (let i = 0; i < count; i++) {
		// Deliberate equal times: compare their multiset, not their order.
		const time = ((Math.imul(i + 1, 2654435761) >>> 0) % 10000) / 8;
		times[i] = time;
		reference.push(time);
		queueLib.push(q, time, i % 256, i, (i * 13) >>> 0);
	}
	reference.sort((a, b) => a - b);
	let n = 0;
	const columns = [q.time, q.kind, q.ref, q.revision];
	queueLib.drainUntil(q, Infinity, (time, kind, ref, revision) => {
		assert.equal(time, reference[n++]);
		assert.equal(time, times[ref]);
		assert.equal(kind, ref % 256);
		assert.equal(revision, (ref * 13) >>> 0);
		assert.equal(seen[ref]++, 0);
	});
	assert.equal(n, count);
	assert.equal(q.size, 0);
	for (let i = 0; i < columns.length; i++) assert.equal([q.time, q.kind, q.ref, q.revision][i], columns[i]);
});

check('a due handler can grow the heap and enqueue same-drain follow-ups', () => {
	const q = queueLib.createExecQueue(8);
	queueLib.push(q, 1, 1, 0, 0);
	let count = 0, previous = -Infinity;
	queueLib.drainUntil(q, 10, (time, kind) => {
		assert.ok(time >= previous);
		previous = time;
		count++;
		if (kind !== 1) return;
		for (let i = 0; i < 100; i++) queueLib.push(q, 2 + i / 10, 2, i, 0);
	});
	assert.equal(count, 82); // initial event + 2…10 inclusive
	assert.equal(q.size, 19);
	assert.equal(queueLib.peekTime(q), 10.1);
});

check('consumer revisions skip stale entries without losing current events', () => {
	const q = queueLib.createExecQueue(8);
	const revisions = new Uint32Array([2, 1]);
	queueLib.push(q, 1, 0, 0, 1);
	queueLib.push(q, 2, 0, 1, 1);
	queueLib.push(q, 3, 0, 0, 2);
	let stale = 0, live = 0;
	queueLib.drainUntil(q, 3, (time, kind, ref, revision) => {
		if (revisions[ref] !== revision) { stale++; return; }
		live++;
	});
	assert.equal(stale, 1);
	assert.equal(live, 2);
	assert.equal(q.size, 0);
});

check('steady-capacity push/pop cycles reuse all typed-array storage', () => {
	const q = queueLib.createExecQueue(256);
	const time = q.time, kind = q.kind, ref = q.ref, revision = q.revision;
	for (let round = 0; round < 1000; round++) {
		for (let i = 0; i < 128; i++) queueLib.push(q, round + i / 128, 1, i, round);
		while (q.size) queueLib.pop(q);
	}
	assert.equal(q.time, time);
	assert.equal(q.kind, kind);
	assert.equal(q.ref, ref);
	assert.equal(q.revision, revision);
});

logFile.writeLog(path.join(__dirname, 'logs', 'exec-queue.json'), {
	total: checks.length, passed: checks.length, failed: 0, checks,
});
console.log(`exec-queue: ${checks.length}/${checks.length} passed\n\n=== VERDICT ===\nPASS`);
