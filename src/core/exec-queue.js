// src/core/exec-queue.js
// A time-ordered discrete-event queue: a binary min-heap over parallel typed
// arrays (time / kind / ref / revision), the structure the trade network's
// arrivals ride. The contract follows the reference implementation in
// luncat8/exec_queue:
//
//   * push/pop are O(log n) and allocate nothing once the capacity is reached;
//   * `drainUntil(target, handler)` pops the root *before* calling the
//     handler, so a handler may push follow-up events and have them run in the
//     same drain when they are due;
//   * equal timestamps are unordered — simultaneity has no meaning for the
//     simulation;
//   * a stale entry (an owner that changed its mind) is not the queue's
//     problem: the revision column travels with the event and the consumer
//     decides. Obsolete entries drain harmlessly instead of costing a search.
//
// The heap is the queue for events that happen *at* a time. A sorted array
// would need an O(n) memmove per insertion; at the network's few hundred live
// events the difference is invisible, but the contract is the one the trade
// series is specified on, and `experiments/exec-queue-test.js` measures both.

'use strict';

const DEFAULT_CAPACITY = 64;

function createExecQueue(capacity) {
	const cap = Math.max(8, capacity | 0 || DEFAULT_CAPACITY);
	return {
		time: new Float64Array(cap),
		kind: new Uint8Array(cap),
		ref: new Uint32Array(cap),
		revision: new Uint32Array(cap),
		size: 0,
	};
}

// Doubling preserves the heap order: the first `size` entries are copied
// unchanged and every other column follows.
function grow(queue) {
	const cap = queue.time.length * 2;
	const time = new Float64Array(cap);
	time.set(queue.time);
	const kind = new Uint8Array(cap);
	kind.set(queue.kind);
	const ref = new Uint32Array(cap);
	ref.set(queue.ref);
	const revision = new Uint32Array(cap);
	revision.set(queue.revision);
	queue.time = time;
	queue.kind = kind;
	queue.ref = ref;
	queue.revision = revision;
}

// Sift-up insertion. The new value travels in local variables and the hole is
// filled at the end, so a swap costs no temporary object and no array read
// beyond the parent's time.
function push(queue, time, kind, ref, revision) {
	if (queue.size === queue.time.length) grow(queue);
	const times = queue.time;
	const kinds = queue.kind;
	const refs = queue.ref;
	const revisions = queue.revision;
	let i = queue.size++;
	while (i > 0) {
		const parent = (i - 1) >> 1;
		if (times[parent] <= time) break;
		times[i] = times[parent];
		kinds[i] = kinds[parent];
		refs[i] = refs[parent];
		revisions[i] = revisions[parent];
		i = parent;
	}
	times[i] = time;
	kinds[i] = kind;
	refs[i] = ref;
	revisions[i] = revision;
}

// Sift-down pop. The last entry moves into the root's hole and walks down to
// the first position whose children are not earlier than it.
function pop(queue) {
	if (queue.size === 0) return;
	const n = --queue.size;
	if (n === 0) return;
	const times = queue.time;
	const kinds = queue.kind;
	const refs = queue.ref;
	const revisions = queue.revision;
	const time = times[n];
	const kind = kinds[n];
	const ref = refs[n];
	const revision = revisions[n];
	let i = 0;
	for (;;) {
		let child = i * 2 + 1;
		if (child >= n) break;
		const right = child + 1;
		if (right < n && times[right] < times[child]) child = right;
		if (times[child] >= time) break;
		times[i] = times[child];
		kinds[i] = kinds[child];
		refs[i] = refs[child];
		revisions[i] = revisions[child];
		i = child;
	}
	times[i] = time;
	kinds[i] = kind;
	refs[i] = ref;
	revisions[i] = revision;
}

// Pop every event due at or before `target`, up to `budget` events when a
// budget is given (0 or omitted = no limit). The columns are re-read through
// the queue object on every iteration because a handler's push may grow (and
// therefore reallocate) the arrays. A budget that runs out leaves the rest of
// the due events in the queue, still in order — the caller owns the clock and
// knows that it stopped short.
function drainUntil(queue, target, handler, budget) {
	const limit = budget > 0 ? budget : 0;
	let processed = 0;
	while (queue.size > 0 && queue.time[0] <= target) {
		if (limit > 0 && processed >= limit) break;
		const time = queue.time[0];
		const kind = queue.kind[0];
		const ref = queue.ref[0];
		const revision = queue.revision[0];
		pop(queue);
		handler(time, kind, ref, revision);
		processed += 1;
	}
	return processed;
}

function peekTime(queue) {
	return queue.size > 0 ? queue.time[0] : Infinity;
}

function clear(queue) {
	queue.size = 0;
}

// The `count` earliest entries, in time order, without touching the heap.
//
// A heap's k smallest values cannot sit deeper than level k-1, so the first
// min(size, 2^k - 1) entries are a complete candidate set: at the cap of 8
// that is 255 entries, and a fixed 64 would miss an 8th event at index 64+.
// The candidates are copied to module scratch and partial-selected: O(n·k),
// a few hundred comparisons at the panel's 4 Hz, and no allocation after the
// first call. A tie in time is broken by position, so equal-time entries keep
// the heap's own (unordered but repeatable) order.
const PEEK_TIME = new Float64Array(256);
const PEEK_KIND = new Uint8Array(256);
const PEEK_REF = new Uint32Array(256);
const PEEK_REVISION = new Uint32Array(256);
const PEEK_TAKEN = new Uint8Array(256);

function peekNext(queue, outTime, outKind, outRef, outRevision, count) {
	const k = Math.max(1, Math.min(8, count | 0 || 1));
	const bound = Math.min(queue.size, (1 << k) - 1);
	const times = queue.time;
	const kinds = queue.kind;
	const refs = queue.ref;
	const revisions = queue.revision;
	for (let i = 0; i < bound; i++) {
		PEEK_TIME[i] = times[i];
		PEEK_KIND[i] = kinds[i];
		PEEK_REF[i] = refs[i];
		PEEK_REVISION[i] = revisions[i];
		PEEK_TAKEN[i] = 0;
	}
	let n = 0;
	while (n < k) {
		let best = -1;
		for (let i = 0; i < bound; i++) {
			if (PEEK_TAKEN[i]) continue;
			if (best < 0 || PEEK_TIME[i] < PEEK_TIME[best]) best = i;
		}
		if (best < 0) break;
		PEEK_TAKEN[best] = 1;
		outTime[n] = PEEK_TIME[best];
		outKind[n] = PEEK_KIND[best];
		outRef[n] = PEEK_REF[best];
		outRevision[n] = PEEK_REVISION[best];
		n += 1;
	}
	return n;
}

const ExecQueueLib = {
	createExecQueue, push, pop, drainUntil, peekTime, peekNext, clear,
	DEFAULT_CAPACITY,
};
if (typeof module !== 'undefined') module.exports = ExecQueueLib;
if (typeof window !== 'undefined') window.ExecQueueLib = ExecQueueLib;
