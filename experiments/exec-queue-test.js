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

check('peekNext returns the first events in the order a drain would pop them', () => {
	const q = queueLib.createExecQueue(8);
	const twin = queueLib.createExecQueue(8);
	for (let i = 0; i < 300; i++) {
		const time = ((Math.imul(i + 7, 2654435761) >>> 0) % 100000) / 64;
		queueLib.push(q, time, i % 5, i, i);
		queueLib.push(twin, time, i % 5, i, i);
	}
	const outTime = new Float64Array(8);
	const outKind = new Uint8Array(8);
	const outRef = new Uint32Array(8);
	const outRevision = new Uint32Array(8);
	const n = queueLib.peekNext(q, outTime, outKind, outRef, outRevision, 8);
	assert.equal(n, 8);
	const drained = [];
	queueLib.drainUntil(twin, Infinity, (time, kind, ref, revision) => {
		if (drained.length < 8) drained.push([time, kind, ref, revision]);
	});
	for (let i = 0; i < n; i++) {
		assert.deepEqual([outTime[i], outKind[i], outRef[i], outRevision[i]], drained[i]);
		assert.ok(i === 0 || outTime[i] >= outTime[i - 1]);
	}
});

check('peekNext leaves the heap untouched and never allocates after the first call', () => {
	const q = queueLib.createExecQueue(8);
	for (let i = 0; i < 500; i++) queueLib.push(q, ((i * 37) % 101) / 3, i % 4, i, i);
	const size = q.size;
	const root = [q.time[0], q.kind[0], q.ref[0], q.revision[0]];
	const columns = [q.time, q.kind, q.ref, q.revision];
	const outTime = new Float64Array(8);
	const outKind = new Uint8Array(8);
	const outRef = new Uint32Array(8);
	const outRevision = new Uint32Array(8);
	let first = 0;
	for (let round = 0; round < 10000; round++) {
		const n = queueLib.peekNext(q, outTime, outKind, outRef, outRevision, 1 + (round % 8));
		if (round === 0) first = n;
		assert.ok(n >= 1 && n <= 8);
	}
	assert.equal(q.size, size);
	assert.deepEqual([q.time[0], q.kind[0], q.ref[0], q.revision[0]], root);
	for (let i = 0; i < columns.length; i++) assert.equal([q.time, q.kind, q.ref, q.revision][i], columns[i]);
	assert.ok(first >= 1);
});

check('peekNext clamps its count and stops at an empty queue', () => {
	const q = queueLib.createExecQueue(8);
	const outTime = new Float64Array(8);
	const outKind = new Uint8Array(8);
	const outRef = new Uint32Array(8);
	const outRevision = new Uint32Array(8);
	assert.equal(queueLib.peekNext(q, outTime, outKind, outRef, outRevision, 5), 0);
	queueLib.push(q, 4, 0, 1, 0);
	queueLib.push(q, 9, 0, 2, 0);
	assert.equal(queueLib.peekNext(q, outTime, outKind, outRef, outRevision, 99), 2);
	assert.deepEqual([outTime[0], outTime[1]], [4, 9]);
	assert.equal(queueLib.peekNext(q, outTime, outKind, outRef, outRevision, 0), 1);
});

logFile.writeLog(path.join(__dirname, 'logs', 'exec-queue.json'), {
	total: checks.length, passed: checks.length, failed: 0, checks,
});
console.log(`exec-queue: ${checks.length}/${checks.length} passed\n\n=== VERDICT ===\nPASS`);
