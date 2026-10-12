// src/core/star-set.js
// The multi-select set (0.5.0 plan §3.2): a bounded, preallocated list of the
// stars the viewer has picked, kept nearest-first, with the primary at slot 0.
//
// A set stores keys and distances — never buffer slots. The five record blocks
// are rewritten whenever the residency set changes, so a slot would silently
// become a different star as the viewer flies; the u32 identity key (§2.2) is
// stable across rebuilds and is what the set holds. The label layer and the
// fly-to path resolve a key back to a slot when they need one.
//
// Primary and set are both kept, because they drive different operations: the
// primary drives single-star ones (fly-to, the readout), the set drives bulk
// ones (radius select, later the search scope and routes). Slot 0 *is* the
// primary, so one array answers both questions and N-cycling is a rotation.

'use strict';

const STAR_SET_CAPACITY = 256;

// §4.11's designation for a star with no name: "S" + the key in base36,
// uppercase. Stable across camera moves (it is the key) and never shared by
// two stars. Built on demand by the caller — it is a click-time string, not a
// per-frame one.
const BASE36_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function keyDesignation(key) {
	let value = key >>> 0;
	if (value === 0) return '';
	let digits = '';
	while (value > 0) {
		digits = BASE36_DIGITS[value % 36] + digits;
		value = Math.floor(value / 36);
	}
	return 'S' + digits;
}

function createStarSet() {
	// Struct of arrays: 1.5 KB total, allocated once, mutated in place.
	const keys = new Uint32Array(STAR_SET_CAPACITY);
	const distances = new Float64Array(STAR_SET_CAPACITY);
	let count = 0;

	function indexOf(key) {
		for (let i = 0; i < count; i++) {
			if (keys[i] === key) return i;
		}
		return -1;
	}

	function hasStar(key) {
		return indexOf(key) >= 0;
	}

	function keyAt(i) {
		return i >= 0 && i < count ? keys[i] : 0;
	}

	function distanceAt(i) {
		return i >= 0 && i < count ? distances[i] : 0;
	}

	// Write at `i`, shifting the tail up. Never grows past capacity: the
	// caller has already decided which entry (if any) is dropped.
	function insertAt(i, key, distance) {
		const last = Math.min(count, STAR_SET_CAPACITY - 1);
		for (let j = last; j > i; j--) {
			keys[j] = keys[j - 1];
			distances[j] = distances[j - 1];
		}
		keys[i] = key;
		distances[i] = distance;
		if (count < STAR_SET_CAPACITY) count++;
	}

	function removeAt(i) {
		for (let j = i; j < count - 1; j++) {
			keys[j] = keys[j + 1];
			distances[j] = distances[j + 1];
		}
		count--;
	}

	function removeStar(key) {
		const i = indexOf(key);
		if (i < 0) return false;
		removeAt(i);
		return true;
	}

	// Nearest-first insert. An existing key is re-placed at its new distance.
	// Overflow drops the farthest from the camera — the cell manager's
	// nearest-first budget rule — and reports it by returning false.
	function addStar(key, distance) {
		if (key === 0) return false;
		const d = Number.isFinite(distance) ? distance : 0;
		const existing = indexOf(key);
		if (existing >= 0) {
			if (distances[existing] === d) return true;
			removeAt(existing);
		}
		if (count >= STAR_SET_CAPACITY) {
			if (d >= distances[count - 1]) return false;   // the newcomer is the farthest
			count--;                                       // drop the farthest to make room
		}
		let i = 0;
		while (i < count && distances[i] <= d) i++;
		insertAt(i, key, d);
		return true;
	}

	function toggleStar(key, distance) {
		const i = indexOf(key);
		if (i >= 0) {
			removeAt(i);
			return false;
		}
		return addStar(key, distance);
	}

	// The primary moves to slot 0; the rest keep their relative order. A key
	// that is not in the set is a no-op — the primary is always a member.
	function setPrimary(key) {
		const i = indexOf(key);
		if (i <= 0) return i === 0;
		const k = keys[i], d = distances[i];
		for (let j = i; j > 0; j--) {
			keys[j] = keys[j - 1];
			distances[j] = distances[j - 1];
		}
		keys[0] = k;
		distances[0] = d;
		return true;
	}

	function clearSet() {
		count = 0;
	}

	// A plain click: the set becomes this one star, primary included.
	function setStar(key, distance) {
		clearSet();
		return addStar(key, distance);
	}

	// The member with the smallest stored distance, whatever the primary
	// ordering — used for the nearest-first ring draw and the readout.
	function nearestSetStar() {
		if (count === 0) return -1;
		let best = 0;
		for (let i = 1; i < count; i++) {
			if (distances[i] < distances[best]) best = i;
		}
		return best;
	}

	function primary() {
		return count > 0 ? keys[0] : 0;
	}

	return {
		addStar, removeStar, hasStar, toggleStar, clearSet, setStar,
		setPrimary, nearestSetStar, indexOf, keyAt, distanceAt, primary,
		keys, count: () => count, capacity: () => STAR_SET_CAPACITY,
	};
}

const StarSet = { createStarSet, keyDesignation, STAR_SET_CAPACITY };
if (typeof module !== 'undefined') module.exports = StarSet;
if (typeof window !== 'undefined') window.StarSet = StarSet;
