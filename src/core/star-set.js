// src/core/star-set.js
// The selection set (plan §3.2): snapshots, not indices.
//
// One primary plus up to `capacity` members. Each member keeps the identity key
// it was picked by (plan §2.2), the block it came from and the slot it had, its
// position, and the five stellar inputs `planets.stellarInputs` derived when it
// was picked. That is the whole point of the design: nothing here is
// re-derived per frame, the set survives a residency rebuild because it holds
// positions rather than slots, and a search or a route never has to invert a
// record it can no longer see.
//
// Rules (plan §3.2):
//   * a plain click sets the primary *and* the set to that one star; Shift+click
//     toggles membership without moving the primary;
//   * capacity overflow drops the farthest member from the camera — except the
//     primary, which is never evicted (a click cannot silently lose the star the
//     readout is describing) — and counts the drop in `dropped`;
//   * a model change clears the set; an *age* change does not, it re-derives the
//     stellar fields from the keys in place (see `refreshStellar`).
//
// A "pick" is one shape everywhere (selection.pickAny's `out`, a row of
// selection.selectAround's SoA): `{ key, kind, index, x, y, z, colorIndex,
// absMag }`, with `kind` the block index (0 = field … 4 = catalog).
//
// `bufferIdx` is the one slot-dependent field and it is only for drawing the
// sky ring: it is filled on insert when the caller can compute it, and
// refreshed by key whenever the blocks are rebuilt (label-layer's key→slot map,
// plan §3.5).

'use strict';

const CAPACITY = 256;

function createStarSet() {
	// Struct-of-arrays, allocated once and mutated in place. Nothing below
	// allocates: `insert` copies scalars, `refreshSlots` reads a caller map.
	const keys = new Uint32Array(CAPACITY);
	const blockKind = new Uint8Array(CAPACITY);
	const bufferIdx = new Int32Array(CAPACITY);
	const x = new Float64Array(CAPACITY);
	const y = new Float64Array(CAPACITY);
	const z = new Float64Array(CAPACITY);
	const mass = new Float64Array(CAPACITY);
	const lum = new Float64Array(CAPACITY);
	const teff = new Float64Array(CAPACITY);
	const age = new Float64Array(CAPACITY);
	const metal = new Float64Array(CAPACITY);
	const colorIndex = new Uint8Array(CAPACITY);
	const absMag = new Float32Array(CAPACITY);
	// The dispatch's own report for that star (§2.6): the readout says so rather
	// than inferring it from the engine name.
	const approximated = new Uint8Array(CAPACITY);

	const set = {
		capacity: CAPACITY,
		keys, blockKind, bufferIdx, x, y, z,
		mass, lum, teff, age, metal, colorIndex, absMag, approximated,
		count: 0,          // members in use, in insertion order
		primary: -1,       // index into the arrays, or −1
		dropped: 0,        // overflow drops since the last clear(), for the readout
		clear, hasKey, indexOfKey, insert, addFromPick, setSingle, toggle,
		cyclePrimary, removeAt, setPrimary, updateStellar, refreshStellar, refreshSlots,
		distance2, setBufferIdx,
	};
	return set;

	function clear() {
		set.count = 0;
		set.primary = -1;
		set.dropped = 0;
	}

	function indexOfKey(key) {
		const k = key >>> 0;
		for (let i = 0; i < set.count; i++) if (keys[i] === k) return i;
		return -1;
	}

	function hasKey(key) { return indexOfKey(key) >= 0; }

	function distance2(i, camX, camY, camZ) {
		const dx = x[i] - camX;
		const dy = y[i] - camY;
		const dz = z[i] - camZ;
		return dx * dx + dy * dy + dz * dz;
	}

	function writeSlot(i, pick, inputs, slot) {
		keys[i] = pick.key >>> 0;
		blockKind[i] = pick.kind | 0;
		bufferIdx[i] = slot === undefined ? -1 : slot;
		x[i] = pick.x;
		y[i] = pick.y;
		z[i] = pick.z;
		colorIndex[i] = pick.colorIndex & 0xFF;
		absMag[i] = pick.absMag;
		approximated[i] = pick.approximated ? 1 : 0;
		updateStellar(i, inputs);
	}

	// Copy the five derived stellar fields (the ones §2.4 writes) into a slot.
	function updateStellar(i, inputs) {
		mass[i] = inputs.mass;
		lum[i] = inputs.lum;
		teff[i] = inputs.teff;
		age[i] = inputs.age;
		metal[i] = inputs.metal;
	}

	function setBufferIdx(i, slot) { bufferIdx[i] = slot; }

	// Insert a pick + its derived inputs. Returns the member index, or −1 when
	// the set is full and the new star is not nearer than the farthest member.
	function insert(pick, inputs, camX, camY, camZ, slot) {
		const existing = indexOfKey(pick.key);
		if (existing >= 0) {
			writeSlot(existing, pick, inputs, slot);
			return existing;
		}
		if (set.count < CAPACITY) {
			const i = set.count++;
			writeSlot(i, pick, inputs, slot);
			return i;
		}
		// Full: find the farthest member that is not the primary. When the
		// primary is the only candidate the new star is refused — the set is
		// then a set of one, which cannot happen before the primary exists.
		let far = -1;
		let farD2 = -1;
		for (let i = 0; i < CAPACITY; i++) {
			if (i === set.primary) continue;
			const d2 = distance2(i, camX, camY, camZ);
			if (d2 > farD2) { farD2 = d2; far = i; }
		}
		const d2n = (pick.x - camX) * (pick.x - camX)
			+ (pick.y - camY) * (pick.y - camY)
			+ (pick.z - camZ) * (pick.z - camZ);
		if (far < 0 || d2n >= farD2) {
			set.dropped++;
			return -1;
		}
		writeSlot(far, pick, inputs, slot);
		set.dropped++;
		return far;
	}

	function addFromPick(pick, inputs, camX, camY, camZ, slot) {
		return insert(pick, inputs, camX, camY, camZ, slot);
	}

	// A plain click: the set becomes the one star, and it becomes the primary.
	function setSingle(pick, inputs, camX, camY, camZ, slot) {
		clear();
		const i = insert(pick, inputs, camX, camY, camZ, slot);
		set.primary = i;
		return i;
	}

	// Shift+click: membership toggles, the primary does not move. Removing the
	// primary's own star clears the primary rather than promoting a neighbour.
	function toggle(pick, inputs, camX, camY, camZ, slot) {
		const i = indexOfKey(pick.key);
		if (i >= 0) {
			const wasPrimary = i === set.primary;
			removeAt(i);
			if (wasPrimary) set.primary = -1;
			return -1;
		}
		return insert(pick, inputs, camX, camY, camZ, slot);
	}

	function cyclePrimary(delta) {
		if (set.count === 0) { set.primary = -1; return; }
		const d = delta | 0;
		set.primary = ((set.primary + d) % set.count + set.count) % set.count;
	}

	function setPrimary(i) {
		set.primary = i >= 0 && i < set.count ? i : -1;
	}

	// Shift-remove the slot (order is insertion order, not a priority order).
	function removeAt(i) {
		if (i < 0 || i >= set.count) return;
		const last = set.count - 1;
		if (i < last) {
			keys.copyWithin(i, i + 1, set.count);
			blockKind.copyWithin(i, i + 1, set.count);
			bufferIdx.copyWithin(i, i + 1, set.count);
			x.copyWithin(i, i + 1, set.count);
			y.copyWithin(i, i + 1, set.count);
			z.copyWithin(i, i + 1, set.count);
			mass.copyWithin(i, i + 1, set.count);
			lum.copyWithin(i, i + 1, set.count);
			teff.copyWithin(i, i + 1, set.count);
			age.copyWithin(i, i + 1, set.count);
			metal.copyWithin(i, i + 1, set.count);
			colorIndex.copyWithin(i, i + 1, set.count);
			absMag.copyWithin(i, i + 1, set.count);
			approximated.copyWithin(i, i + 1, set.count);
		}
		set.count = last;
		if (set.primary > i) set.primary--;
	}

	// An age change moves nothing but re-rolls every star's evolutionary state:
	// the caller re-derives each member from its key and writes the fields back.
	// The loop itself stays here so the caller cannot walk the set inconsistently.
	function refreshStellar(deriveInto) {
		for (let i = 0; i < set.count; i++) deriveInto(i);
	}

	// After a block rebuild, re-resolve every member's sky slot by key through
	// the label layer's map (or any caller-supplied lookup). `lookup` returns a
	// global slot or −1; no map entry means "not resident", not "not selected".
	function refreshSlots(lookup) {
		for (let i = 0; i < set.count; i++) bufferIdx[i] = lookup(keys[i]) | 0;
	}
}

const StarSet = { createStarSet, CAPACITY };
if (typeof module !== 'undefined') module.exports = StarSet;
if (typeof window !== 'undefined') window.StarSet = StarSet;
