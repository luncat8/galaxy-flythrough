// src/core/selection-store.js
// Typed selection state for the search panel. Natural objects have a one-step
// current/previous history and transient search results; ships and settlements
// have an independent history plus a fixed two-slot pair for asset workflows.

'use strict';

const GROUP_SPACE = 'space';
const GROUP_ASSET = 'asset';
const SPACE_TYPES = ['star', 'planet', 'other'];
const ASSET_TYPES = ['ship', 'base', 'colony', 'dock-port', 'cargo-container', 'other'];

function typeAllowed(group, type) {
	const names = group === GROUP_SPACE ? SPACE_TYPES : group === GROUP_ASSET ? ASSET_TYPES : null;
	return !!names && names.includes(String(type || '').toLowerCase());
}

function copySelection(group, source) {
	if (!source || !typeAllowed(group, source.type)) return null;
	const out = {
		group,
		type: String(source.type).toLowerCase(),
		name: source.name == null ? '' : String(source.name),
		id: source.id == null ? null : source.id,
		key: Number.isFinite(source.key) ? source.key >>> 0 : null,
		kind: Number.isFinite(source.kind) ? source.kind | 0 : -1,
		index: Number.isFinite(source.index) ? source.index | 0 : -1,
		x: Number.isFinite(source.x) ? source.x : 0,
		y: Number.isFinite(source.y) ? source.y : 0,
		z: Number.isFinite(source.z) ? source.z : 0,
		colorIndex: Number.isFinite(source.colorIndex) ? source.colorIndex | 0 : 0,
		absMag: Number.isFinite(source.absMag) ? source.absMag : 0,
		mass: Number.isFinite(source.mass) ? source.mass : 0,
		lum: Number.isFinite(source.lum) ? source.lum : 0,
		teff: Number.isFinite(source.teff) ? source.teff : 0,
		rStar: Number.isFinite(source.rStar) ? source.rStar : 0,
		age: Number.isFinite(source.age) ? source.age : 0,
		metal: Number.isFinite(source.metal) ? source.metal : 0,
		entity: source.entity == null ? null : source.entity,
	};
	return out;
}

function sameSelection(a, b) {
	if (!a || !b || a.group !== b.group || a.type !== b.type) return false;
	if (a.key !== null && b.key !== null) return a.key === b.key;
	if (a.id !== null && b.id !== null) return a.id === b.id;
	return a.entity !== null && b.entity !== null && a.entity === b.entity;
}

function createSelectionStore() {
	const natural = { current: null, previous: null, searchResults: [] };
	const assets = { current: null, previous: null };
	const assetPair = [null, null];
	const store = {
		natural, assets, assetPair,
		selectCurrent, swap, setSearchResults, setAssetPair, clearHistory, clearAssetPair, clear,
	};
	return store;

	function groupOf(group) {
		if (group === GROUP_SPACE) return natural;
		if (group === GROUP_ASSET) return assets;
		return null;
	}

	function selectCurrent(group, selection) {
		const target = groupOf(group);
		const next = copySelection(group, selection);
		if (!target || !next) return false;
		if (sameSelection(target.current, next)) {
			target.current = next;
			return target.current;
		}
		target.previous = target.current;
		target.current = next;
		return target.current;
	}

	function swap(group) {
		const target = groupOf(group);
		if (!target || !target.current || !target.previous) return false;
		const current = target.current;
		target.current = target.previous;
		target.previous = current;
		return target.current;
	}

	function setSearchResults(group, rows) {
		if (group !== GROUP_SPACE) return false;
		natural.searchResults = Array.isArray(rows) ? rows : [];
		return natural.searchResults;
	}

	function setAssetPair(first, second) {
		assetPair[0] = copySelection(GROUP_ASSET, first);
		assetPair[1] = copySelection(GROUP_ASSET, second);
		return assetPair;
	}

	function clearHistory(group) {
		const target = groupOf(group);
		if (!target) return false;
		target.current = null;
		target.previous = null;
		return true;
	}

	function clearAssetPair() {
		assetPair[0] = null;
		assetPair[1] = null;
	}

	function clear() {
		clearHistory(GROUP_SPACE);
		clearHistory(GROUP_ASSET);
		setSearchResults(GROUP_SPACE, []);
		clearAssetPair();
	}
}

const SelectionStore = {
	GROUP_SPACE, GROUP_ASSET, SPACE_TYPES, ASSET_TYPES,
	createSelectionStore, copySelection, sameSelection,
};
if (typeof module !== 'undefined') module.exports = SelectionStore;
if (typeof window !== 'undefined') window.SelectionStore = SelectionStore;
